import { createHash, randomUUID } from 'node:crypto';
import {
  createProviderCredentialContext,
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  type ProviderCredentialContext,
  ProviderCredentialCryptoError,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKms,
  type ProviderCredentialSealingKms,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
  withUnsealedProviderCredential,
} from '../credentials/provider-crypto.js';
import type { TenantContext } from '../identity/types.js';
import type { SupplyProfileResolver } from '../keys/types.js';
import { ProviderSupplyError, type ProviderSupplyErrorCode } from './errors.js';
import type {
  PersistedProviderAccountInput,
  PersistedProviderCredentialInput,
  ProviderSupplyRepository,
  UpdateProviderAccountLifecycleInput,
  UpdateProviderAccountValidationInput,
  UpdateProviderCredentialLifecycleInput,
  UpdateProviderCredentialValidationInput,
} from './repository.js';
import type {
  CreatedTenantByokCredential,
  CreateProviderAccountInput,
  CreateProviderCredentialInput,
  CreateTenantByokCredentialInput,
  PlatformProviderSupplyOwner,
  ProviderAccountListFilter,
  ProviderAccountRecord,
  ProviderAccountReference,
  ProviderCredentialAccessGrant,
  ProviderCredentialDispatchBinding,
  ProviderCredentialDispatchProof,
  ProviderCredentialDispatchProofReader,
  ProviderCredentialListFilter,
  ProviderCredentialRecord,
  ProviderCredentialReference,
  ProviderCredentialValidationJobInput,
  ProviderCredentialVersionRecord,
  ProviderCredentialWriteResult,
  ProviderSupplyAuditContext,
  ProviderSupplyOwner,
  ProviderValidationState,
  ReplaceProviderCredentialSecretInput,
  SupplyTimestamp,
  TenantProviderSupplyOwner,
} from './types.js';

export interface ProviderSupplyPersistenceServiceOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly kmsKeyId: string;
  /** Legacy combined capability used by existing combined/gateway callers. */
  readonly kms?: ProviderCredentialKms;
  /** Generate-only capability used by control-plane account/credential management. */
  readonly sealingKms?: ProviderCredentialSealingKms;
  readonly now?: () => Date;
  /** Required by the customer BYOK creation path; absence fails closed. */
  readonly supplyProfileResolver?: SupplyProfileResolver;
}

export interface ProviderCredentialAccessServiceOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly now?: () => Date;
}

type LifecycleStatus = ProviderAccountRecord['status'];
type ProviderCredentialContextAccount = Pick<
  ProviderAccountRecord,
  'ownerKind' | 'tenantId' | 'id' | 'providerId' | 'productId' | 'purpose' | 'credentialType'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function repositoryCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isStaleProviderCatalogFence(error: unknown): boolean {
  if (!isRecord(error) || error.code !== '23514') return false;
  return (
    error.constraint === 'saas_tenant_provider_accounts_byok_rights_fence' ||
    error.constraint === 'saas_tenant_provider_account_capabilities_byok_fence'
  );
}

function mapRepositoryError(
  error: unknown,
  fallback: ProviderSupplyErrorCode,
  duplicateCode: ProviderSupplyErrorCode = fallback,
): ProviderSupplyError {
  if (error instanceof ProviderSupplyError) return error;
  if (isStaleProviderCatalogFence(error)) return new ProviderSupplyError('PROVIDER_CATALOG_CONFLICT');
  switch (repositoryCode(error)) {
    case '23505':
      return new ProviderSupplyError(duplicateCode);
    case 'ACCOUNT_NOT_FOUND':
      return new ProviderSupplyError('ACCOUNT_NOT_FOUND');
    case 'CREDENTIAL_NOT_FOUND':
      return new ProviderSupplyError('CREDENTIAL_NOT_FOUND');
    case 'ACCOUNT_REVOKED':
      return new ProviderSupplyError('ACCOUNT_REVOKED');
    case 'CREDENTIAL_REVOKED':
      return new ProviderSupplyError('CREDENTIAL_REVOKED');
    case 'ACCOUNT_STATE_CONFLICT':
      return new ProviderSupplyError('ACCOUNT_STATE_CONFLICT');
    case 'CREDENTIAL_STATE_CONFLICT':
      return new ProviderSupplyError('CREDENTIAL_STATE_CONFLICT');
    case 'CREDENTIAL_VERSION_CONFLICT':
      return new ProviderSupplyError('CREDENTIAL_VERSION_CONFLICT');
    default:
      return new ProviderSupplyError(fallback);
  }
}

function fail(code: ProviderSupplyErrorCode): never {
  throw new ProviderSupplyError(code);
}

function text(value: unknown, code: ProviderSupplyErrorCode = 'INVALID_INPUT', maxBytes = 256): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\u0000') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    fail(code);
  }
  return value;
}

function identifier(value: unknown): string {
  return text(value, 'INVALID_INPUT', 256);
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT');
  return value;
}

function timestamp(value: SupplyTimestamp | null | undefined, now: Date, allowPast = true): string | null {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('INVALID_INPUT');
  if (!allowPast && parsed.getTime() <= now.getTime()) fail('INVALID_INPUT');
  return parsed.toISOString();
}

function currentDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INPUT');
  return new Date(value.getTime());
}

function ownerFromAccountInput(input: CreateProviderAccountInput): ProviderSupplyOwner {
  if (input.ownerKind === 'tenant') {
    if (input.supplyMode !== undefined && input.supplyMode !== 'byok') fail('INVALID_INPUT');
    return {
      ownerKind: 'tenant',
      tenantId: identifier(input.tenantId),
      supplyMode: 'byok',
    } satisfies TenantProviderSupplyOwner;
  }
  if (input.ownerKind === 'platform') {
    if (input.supplyMode !== undefined && input.supplyMode !== 'platform') fail('INVALID_INPUT');
    if (input.tenantId !== undefined && input.tenantId !== null) fail('INVALID_INPUT');
    return {
      ownerKind: 'platform',
      tenantId: null,
      supplyMode: 'platform',
    } satisfies PlatformProviderSupplyOwner;
  }
  fail('INVALID_INPUT');
}

function normalizeAccountReference(reference: ProviderAccountReference): ProviderAccountReference {
  if (!reference || (reference.ownerKind !== 'tenant' && reference.ownerKind !== 'platform')) fail('INVALID_INPUT');
  if (reference.ownerKind === 'tenant') {
    return {
      ownerKind: 'tenant',
      tenantId: identifier(reference.tenantId),
      accountId: identifier(reference.accountId),
    };
  }
  if (reference.tenantId !== null) fail('INVALID_INPUT');
  return { ownerKind: 'platform', tenantId: null, accountId: identifier(reference.accountId) };
}

function normalizeCredentialReference(reference: ProviderCredentialReference): ProviderCredentialReference {
  const account = normalizeAccountReference(reference);
  return {
    ...account,
    credentialId: identifier(reference.credentialId),
    ...(reference.version === undefined ? {} : { version: positiveInteger(reference.version) }),
  };
}

function capabilitiesFromInput(
  input: CreateProviderAccountInput,
): readonly { model: string; endpoint: string; version: number }[] {
  const values = [...(input.capabilities ?? []), ...(input.capability === undefined ? [] : [input.capability])].map(
    (capability) => ({
      model: text(capability.model, 'INVALID_INPUT', 256),
      endpoint: text(capability.endpoint, 'INVALID_INPUT', 256),
      version: positiveInteger(capability.version),
    }),
  );
  const unique = new Map(values.map((value) => [`${value.model}\u0000${value.endpoint}\u0000${value.version}`, value]));
  return [...unique.values()];
}

function contextFor(
  account: ProviderCredentialContextAccount,
  credentialId: string,
  version: number,
  deployment: string,
  environment: string,
): ProviderCredentialContext {
  if (account.ownerKind === 'tenant') {
    if (typeof account.tenantId !== 'string') fail('SUPPLY_STORAGE_ERROR');
    return createProviderCredentialContext({
      ...accountContextFields(account),
      deployment,
      environment,
      ownerKind: 'tenant',
      tenantId: account.tenantId,
      supplyMode: 'byok',
      accountId: account.id,
      credentialId,
      credentialVersion: version,
    });
  }
  return createProviderCredentialContext({
    ...accountContextFields(account),
    deployment,
    environment,
    ownerKind: 'platform',
    supplyMode: 'platform',
    accountId: account.id,
    credentialId,
    credentialVersion: version,
  });
}

function accountContextFields(
  account: ProviderCredentialContextAccount,
): Pick<ProviderCredentialContext, 'purpose' | 'providerId' | 'productId' | 'credentialType'> {
  return {
    purpose: account.purpose,
    providerId: account.providerId,
    productId: account.productId,
    credentialType: account.credentialType,
  };
}

const DISPATCH_BINDING_KEYS = [
  'tenantId',
  'requestId',
  'attemptId',
  'attemptOrdinal',
  'supplyMode',
  'accountOwnerKind',
  'accountId',
  'providerId',
  'productId',
  'protocol',
  'endpoint',
  'routeConfigId',
  'routeConfigVersion',
  'routePublicModelId',
  'routePublicModelVersion',
  'routeProtocol',
  'routeTargetMode',
  'routeUpstreamId',
  'upstreamId',
  'resolvedModel',
  'dispatchProfileId',
  'supplyProfileAuthzVersion',
  'credentialId',
  'credentialVersion',
  'credentialAuthzVersion',
  'accountAuthzVersion',
  'profileAccountAuthzVersion',
  'poolId',
  'poolAuthzVersion',
  'poolMemberAccountAuthzVersion',
  'poolMemberAuthzVersion',
  'poolGrantAuthzVersion',
  'poolGrantProfileAuthzVersion',
  'poolGrantPoolAuthzVersion',
] as const satisfies readonly (keyof ProviderCredentialDispatchBinding)[];

function sameDispatchBinding(
  left: ProviderCredentialDispatchProof['evidence'],
  right: ProviderCredentialDispatchProof['attempt'],
): boolean {
  return DISPATCH_BINDING_KEYS.every((key) => left[key] === right[key]);
}

function validAfter(value: string, now: Date): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function validWindow(effectiveAt: string, expiresAt: string | null, now: Date): boolean {
  const effective = new Date(effectiveAt).getTime();
  const expires = expiresAt === null ? null : new Date(expiresAt).getTime();
  return (
    Number.isFinite(effective) &&
    effective <= now.getTime() &&
    (expires === null || (Number.isFinite(expires) && expires > now.getTime()))
  );
}

function ownerMatches(
  owner: { readonly ownerKind: string; readonly tenantId: string | null; readonly supplyMode: string },
  binding: ProviderCredentialDispatchProof['evidence'],
): boolean {
  return (
    owner.ownerKind === binding.accountOwnerKind &&
    owner.supplyMode === binding.supplyMode &&
    owner.tenantId === (binding.accountOwnerKind === 'tenant' ? binding.tenantId : null)
  );
}

function assertDispatchProof(proof: ProviderCredentialDispatchProof, now: Date, expectedEvidenceId: string): void {
  if (!proof || typeof proof !== 'object') fail('CREDENTIAL_UNAVAILABLE');
  const { evidence, attempt, account, credential, version, profile, profileAccount, pool, poolMember, poolGrant } =
    proof;
  if (
    !evidence ||
    !attempt ||
    !account ||
    !credential ||
    !version ||
    !profile ||
    !proof.claimAudit ||
    evidence.evidenceId !== expectedEvidenceId ||
    evidence.status !== 'claimed' ||
    evidence.claimedAttemptId !== evidence.attemptId ||
    evidence.claimedAttemptId !== attempt.attemptId ||
    attempt.preparedEvidenceId !== evidence.evidenceId ||
    attempt.dispatchAuthorityState !== 'bound' ||
    attempt.dispatchState !== 'dispatching' ||
    attempt.resultState !== 'pending' ||
    attempt.responseStarted ||
    !sameDispatchBinding(evidence, attempt) ||
    proof.claimAudit.action !== 'saas_prepared_request_evidence.claimed' ||
    proof.claimAudit.targetType !== 'saas_prepared_request_evidence' ||
    proof.claimAudit.targetId !== evidence.evidenceId ||
    evidence.supplyProfileId !== profile.id ||
    evidence.supplyProfileVersion !== evidence.supplyProfileAuthzVersion ||
    !validAfter(evidence.dispatchDeadline, now) ||
    !validAfter(evidence.expiresAt, now)
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }

  if (
    profile.tenantId !== evidence.tenantId ||
    profile.supplyMode !== evidence.supplyMode ||
    profile.status !== 'active' ||
    profile.authzVersion !== evidence.supplyProfileAuthzVersion ||
    !ownerMatches(account, evidence) ||
    account.id !== evidence.accountId ||
    account.providerId !== evidence.providerId ||
    account.productId !== evidence.productId ||
    account.status !== 'active' ||
    account.validationState !== 'verified' ||
    account.authzVersion !== evidence.accountAuthzVersion ||
    !ownerMatches(credential, evidence) ||
    credential.id !== evidence.credentialId ||
    credential.accountId !== evidence.accountId ||
    credential.providerId !== evidence.providerId ||
    credential.productId !== evidence.productId ||
    credential.status !== 'active' ||
    credential.validationState !== 'verified' ||
    credential.currentVersion !== evidence.credentialVersion ||
    credential.authzVersion !== evidence.credentialAuthzVersion ||
    (credential.expiresAt !== null && !validAfter(credential.expiresAt, now)) ||
    version.ownerKind !== evidence.accountOwnerKind ||
    version.tenantId !== (evidence.accountOwnerKind === 'tenant' ? evidence.tenantId : null) ||
    (version.ownerKind === 'tenant' ? 'byok' : 'platform') !== evidence.supplyMode ||
    version.accountId !== evidence.accountId ||
    version.credentialId !== evidence.credentialId ||
    version.version !== evidence.credentialVersion ||
    version.status !== 'active' ||
    version.retiredAt !== null ||
    version.revokedAt !== null ||
    (version.expiresAt !== null && !validAfter(version.expiresAt, now)) ||
    version.kmsPurpose !== account.purpose ||
    version.kmsKeyId !== version.envelope.kmsKeyId ||
    version.envelope.schemaVersion !== version.envelopeSchemaVersion ||
    version.envelope.contextVersion !== version.contextVersion ||
    version.envelope.algorithm !== version.algorithm
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }

  if (evidence.supplyMode === 'byok') {
    if (
      evidence.accountOwnerKind !== 'tenant' ||
      evidence.routeTargetMode !== 'tenant_account' ||
      profileAccount === null ||
      pool !== null ||
      poolMember !== null ||
      poolGrant !== null ||
      profileAccount.tenantId !== evidence.tenantId ||
      profileAccount.supplyProfileId !== evidence.dispatchProfileId ||
      profileAccount.supplyMode !== 'byok' ||
      profileAccount.accountId !== evidence.accountId ||
      profileAccount.providerId !== evidence.providerId ||
      profileAccount.productId !== evidence.productId ||
      profileAccount.status !== 'active' ||
      profileAccount.accountAuthzVersion !== evidence.accountAuthzVersion ||
      profileAccount.authzVersion !== evidence.profileAccountAuthzVersion ||
      !validWindow(profileAccount.effectiveAt, profileAccount.expiresAt, now)
    ) {
      fail('CREDENTIAL_UNAVAILABLE');
    }
  } else if (
    evidence.accountOwnerKind !== 'platform' ||
    evidence.routeTargetMode !== 'platform_pool' ||
    profileAccount !== null ||
    pool === null ||
    poolMember === null ||
    poolGrant === null ||
    pool.id !== evidence.poolId ||
    pool.providerId !== evidence.providerId ||
    pool.productId !== evidence.productId ||
    pool.status !== 'active' ||
    pool.validationState !== 'verified' ||
    pool.authzVersion !== evidence.poolAuthzVersion ||
    poolMember.poolId !== evidence.poolId ||
    poolMember.accountId !== evidence.accountId ||
    poolMember.providerId !== evidence.providerId ||
    poolMember.productId !== evidence.productId ||
    poolMember.status !== 'active' ||
    poolMember.accountAuthzVersion !== evidence.accountAuthzVersion ||
    poolMember.authzVersion !== evidence.poolMemberAuthzVersion ||
    poolGrant.poolId !== evidence.poolId ||
    poolGrant.tenantId !== evidence.tenantId ||
    poolGrant.supplyProfileId !== evidence.dispatchProfileId ||
    poolGrant.supplyMode !== 'platform' ||
    poolGrant.status !== 'active' ||
    poolGrant.profileAuthzVersion !== evidence.poolGrantProfileAuthzVersion ||
    poolGrant.poolAuthzVersion !== evidence.poolGrantPoolAuthzVersion ||
    poolGrant.authzVersion !== evidence.poolGrantAuthzVersion ||
    !validWindow(poolGrant.effectiveAt, poolGrant.expiresAt, now)
  ) {
    fail('CREDENTIAL_UNAVAILABLE');
  }
}

function ownerFromAccountRecord(account: ProviderAccountRecord): ProviderSupplyOwner {
  if (account.ownerKind === 'tenant') {
    return { ownerKind: 'tenant', tenantId: account.tenantId, supplyMode: 'byok' };
  }
  return { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' };
}

function statusTimestamp(
  status: LifecycleStatus,
  now: string,
): { disabledAt: string | null; revokedAt: string | null } {
  return {
    disabledAt: status === 'disabled' ? now : null,
    revokedAt: status === 'revoked' ? now : null,
  };
}

function assertValidationState(value: ProviderValidationState): void {
  if (value !== 'unverified' && value !== 'verified' && value !== 'failed') fail('INVALID_INPUT');
}

function assertSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength === 0) fail('INVALID_INPUT');
}

function assertWriteResult(result: ProviderCredentialWriteResult | null | undefined): ProviderCredentialWriteResult {
  if (!result) fail('SUPPLY_STORAGE_ERROR');
  return result;
}

function normalizeAuditContext(input: ProviderSupplyAuditContext): ProviderSupplyAuditContext {
  if (!input) fail('INVALID_INPUT');
  return {
    actorUserId: identifier(input.actorUserId),
    entryPoint: text(input.entryPoint, 'INVALID_INPUT', 128).trim(),
    sourceIp: input.sourceIp == null ? null : text(input.sourceIp, 'INVALID_INPUT', 128).trim(),
    userAgent: input.userAgent == null ? null : text(input.userAgent, 'INVALID_INPUT', 512),
    requestId: input.requestId == null ? null : text(input.requestId, 'INVALID_INPUT', 256).trim(),
  };
}

async function seal(
  secret: Uint8Array,
  context: ProviderCredentialContext,
  kms: ProviderCredentialSealingKms | undefined,
  kmsKeyId: string,
): Promise<ProviderCredentialEnvelope> {
  if (kms === undefined) fail('KMS_SEAL_FAILED');
  try {
    return await sealProviderCredential(secret, context, kms, kmsKeyId);
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError && error.code === 'INVALID_INPUT') fail('INVALID_INPUT');
    throw new ProviderSupplyError('KMS_SEAL_FAILED');
  }
}

export class ProviderSupplyPersistenceService {
  private readonly now: () => Date;
  private readonly sealingKms: ProviderCredentialSealingKms | undefined;
  private readonly supplyProfileResolver: SupplyProfileResolver | undefined;

  constructor(
    private readonly repository: ProviderSupplyRepository,
    private readonly options: ProviderSupplyPersistenceServiceOptions,
  ) {
    text(options.deployment);
    text(options.environment);
    text(options.kmsKeyId, 'INVALID_INPUT', 512);
    this.now = options.now ?? (() => new Date());
    this.sealingKms = options.sealingKms ?? options.kms;
    this.supplyProfileResolver = options.supplyProfileResolver;
  }

  private async run<T>(
    work: () => Promise<T>,
    fallback: ProviderSupplyErrorCode,
    duplicateCode: ProviderSupplyErrorCode = fallback,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProviderSupplyError) throw error;
      throw mapRepositoryError(error, fallback, duplicateCode);
    }
  }

  private async account(reference: ProviderAccountReference): Promise<ProviderAccountRecord> {
    const normalized = normalizeAccountReference(reference);
    const result = await this.run(() => this.repository.getAccount(normalized), 'SUPPLY_STORAGE_ERROR');
    if (!result) fail('ACCOUNT_NOT_FOUND');
    return result;
  }

  private async credential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord> {
    const normalized = normalizeCredentialReference(reference);
    const result = await this.run(() => this.repository.getCredential(normalized), 'SUPPLY_STORAGE_ERROR');
    if (!result) fail('CREDENTIAL_NOT_FOUND');
    return result;
  }

  private async appendAuditEvent(
    repository: ProviderSupplyRepository,
    audit: ProviderSupplyAuditContext,
    tenantId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    occurredAt: string,
  ): Promise<void> {
    if (typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
    await repository.appendAuditEvent({
      tenantId,
      action,
      targetType,
      targetId,
      occurredAt,
      audit,
    });
  }

  private normalizedAccountInput(input: CreateProviderAccountInput): PersistedProviderAccountInput {
    if (!input) fail('INVALID_INPUT');
    const owner = ownerFromAccountInput(input);
    const capabilities = capabilitiesFromInput(input);
    const status = input.status ?? 'pending';
    const validationState = input.validationState ?? 'unverified';
    if (!['pending', 'active', 'disabled', 'revoked'].includes(status)) fail('INVALID_INPUT');
    assertValidationState(validationState);
    if (status === 'active' && validationState !== 'verified') fail('VALIDATION_REQUIRED');
    const now = currentDate(this.now).toISOString();
    return {
      owner,
      id: input.id === undefined ? randomUUID() : identifier(input.id),
      displayName: text(input.displayName, 'INVALID_INPUT', 200),
      providerId: identifier(input.providerId),
      productId: identifier(input.productId),
      credentialType: identifier(input.credentialType),
      region: identifier(input.region),
      purpose: identifier(input.purpose),
      rightsId: identifier(input.rightsId),
      rightsVersion: positiveInteger(input.rightsVersion),
      capabilities,
      status,
      validationState,
      createdAt: now,
      updatedAt: now,
    };
  }

  async createProviderAccount(input: CreateProviderAccountInput): Promise<ProviderAccountRecord> {
    const persisted = this.normalizedAccountInput(input);
    return this.run(
      () => this.repository.transaction((repository) => repository.createAccount(persisted)),
      'SUPPLY_STORAGE_ERROR',
      'ACCOUNT_EXISTS',
    );
  }

  async createProviderAccountWithAudit(
    input: CreateProviderAccountInput,
    audit: ProviderSupplyAuditContext,
  ): Promise<ProviderAccountRecord> {
    const persisted = this.normalizedAccountInput(input);
    return this.run(
      () =>
        this.repository.transaction(async (repository) => {
          if (typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
          const account = await repository.createAccount(persisted);
          await this.appendAuditEvent(
            repository,
            audit,
            null,
            'provider_supply.account.created',
            'saas_provider_account',
            account.id,
            persisted.createdAt,
          );
          return account;
        }),
      'SUPPLY_STORAGE_ERROR',
      'ACCOUNT_EXISTS',
    );
  }

  async getProviderAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord> {
    return this.account(reference);
  }

  async listProviderAccounts(filter: ProviderAccountListFilter = {}): Promise<readonly ProviderAccountRecord[]> {
    const tenantId = filter.tenantId === undefined ? undefined : identifier(filter.tenantId);
    if (filter.ownerKind === 'platform' && tenantId !== undefined) fail('INVALID_INPUT');
    return this.run(
      () =>
        this.repository.listAccounts({
          ...filter,
          tenantId,
          ownerKind: filter.ownerKind ?? (tenantId === undefined ? undefined : 'tenant'),
        }),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async setProviderAccountValidation(
    reference: ProviderAccountReference,
    validationState: ProviderValidationState,
    validationErrorCode: string | null = null,
  ): Promise<ProviderAccountRecord> {
    assertValidationState(validationState);
    if (validationState === 'failed') text(validationErrorCode ?? 'validation_failed', 'INVALID_INPUT', 128);
    const current = await this.account(reference);
    if (current.status === 'revoked') fail('ACCOUNT_REVOKED');
    const now = currentDate(this.now).toISOString();
    const input: UpdateProviderAccountValidationInput = {
      account: normalizeAccountReference(reference),
      validationState,
      validationErrorCode:
        validationState === 'failed' ? text(validationErrorCode ?? 'validation_failed', 'INVALID_INPUT', 128) : null,
      lastValidatedAt: now,
      expectedAuthzVersion: current.authzVersion,
      updatedAt: now,
    };
    const updated = await this.run(() => this.repository.updateAccountValidation(input), 'SUPPLY_STORAGE_ERROR');
    if (!updated) fail('ACCOUNT_STATE_CONFLICT');
    return updated;
  }

  async activateProviderAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord> {
    return this.changeAccountLifecycle(reference, 'active');
  }

  async disableProviderAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord> {
    return this.changeAccountLifecycle(reference, 'disabled');
  }

  async revokeProviderAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord> {
    return this.changeAccountLifecycle(reference, 'revoked');
  }

  private async changeAccountLifecycle(
    reference: ProviderAccountReference,
    status: LifecycleStatus,
  ): Promise<ProviderAccountRecord> {
    const current = await this.account(reference);
    if (current.status === 'revoked') fail('ACCOUNT_REVOKED');
    if (status === 'active' && current.validationState !== 'verified') fail('VALIDATION_REQUIRED');
    if (status === current.status) fail('INVALID_ACCOUNT_LIFECYCLE');
    const now = currentDate(this.now).toISOString();
    const times = statusTimestamp(status, now);
    const input: UpdateProviderAccountLifecycleInput = {
      account: normalizeAccountReference(reference),
      status,
      expectedAuthzVersion: current.authzVersion,
      updatedAt: now,
      ...times,
    };
    const updated = await this.run(() => this.repository.updateAccountLifecycle(input), 'SUPPLY_STORAGE_ERROR');
    if (!updated) fail('ACCOUNT_STATE_CONFLICT');
    return updated;
  }

  private async createProviderCredentialInternal(
    input: CreateProviderCredentialInput,
    audit?: ProviderSupplyAuditContext,
  ): Promise<ProviderCredentialWriteResult> {
    if (!input) fail('INVALID_INPUT');
    assertSecret(input.secret);
    const accountReference = normalizeAccountReference(input.account);
    const credentialId = input.id === undefined ? randomUUID() : identifier(input.id);
    const nowDate = currentDate(this.now);
    const expiresAt = timestamp(input.expiresAt, nowDate, false);
    return this.run(
      () =>
        this.repository.transaction(async (repository) => {
          if (audit !== undefined && typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
          const account = await repository.getAccount(accountReference);
          if (!account) fail('ACCOUNT_NOT_FOUND');
          if (account.status === 'revoked') fail('ACCOUNT_REVOKED');
          if (account.status === 'disabled') fail('CREDENTIAL_UNAVAILABLE');
          if (input.credentialType !== undefined && identifier(input.credentialType) !== account.credentialType)
            fail('INVALID_INPUT');
          const parent: PersistedProviderCredentialInput = {
            owner: ownerFromAccountRecord(account),
            id: credentialId,
            accountId: account.id,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            status: 'pending',
            validationState: 'unverified',
            expiresAt,
            createdAt: nowDate.toISOString(),
            updatedAt: nowDate.toISOString(),
          };
          await repository.createCredential(parent);
          const envelope = await seal(
            input.secret,
            contextFor(account, credentialId, 1, this.options.deployment, this.options.environment),
            this.sealingKms,
            this.options.kmsKeyId,
          );
          const appended = await repository.appendCredentialVersion({
            credential: { ...account, accountId: account.id, credentialId, version: 1 },
            providerId: account.providerId,
            productId: account.productId,
            envelope,
            kmsPurpose: account.purpose,
            wrappingRevision: 1,
            expectedCurrentVersion: null,
            createdAt: nowDate.toISOString(),
            expiresAt,
          });
          if (audit !== undefined) {
            await this.appendAuditEvent(
              repository,
              audit,
              account.tenantId,
              'provider_supply.credential.created',
              'saas_provider_credential',
              credentialId,
              nowDate.toISOString(),
            );
          }
          return assertWriteResult(appended);
        }),
      'SUPPLY_STORAGE_ERROR',
      'CREDENTIAL_EXISTS',
    );
  }

  async createProviderCredential(input: CreateProviderCredentialInput): Promise<ProviderCredentialWriteResult> {
    return this.createProviderCredentialInternal(input);
  }

  async createProviderCredentialWithAudit(
    input: CreateProviderCredentialInput,
    audit: ProviderSupplyAuditContext,
  ): Promise<ProviderCredentialWriteResult> {
    return this.createProviderCredentialInternal(input, audit);
  }

  async createTenantByokCredentialWithAudit(
    input: CreateTenantByokCredentialInput,
  ): Promise<CreatedTenantByokCredential> {
    if (!input?.context || !input.account) fail('INVALID_INPUT');
    const tenantId = identifier(input.context.tenantId);
    const userId = identifier(input.context.userId);
    identifier(input.context.projectId);
    if (input.context.tenantRole !== 'owner' && input.context.tenantRole !== 'admin') {
      fail('CREDENTIAL_UNAVAILABLE');
    }
    const audit = normalizeAuditContext(input.audit);
    if (audit.actorUserId !== userId) fail('INVALID_INPUT');
    assertSecret(input.secret);
    const capability = {
      model: text(input.account.capability.model, 'INVALID_INPUT', 256),
      endpoint: text(input.account.capability.endpoint, 'INVALID_INPUT', 256),
      version: positiveInteger(input.account.capability.version),
    };
    const persistedAccount = this.normalizedAccountInput({
      ownerKind: 'tenant',
      tenantId,
      supplyMode: 'byok',
      displayName: input.account.displayName,
      providerId: input.account.providerId,
      productId: input.account.productId,
      credentialType: input.account.credentialType,
      region: input.account.region,
      purpose: input.account.purpose,
      rightsId: input.account.rightsId,
      rightsVersion: input.account.rightsVersion,
      capabilities: [capability],
      status: 'pending',
      validationState: 'unverified',
    });
    const evidenceReference = text(input.evidenceReference, 'INVALID_INPUT', 512).trim();
    const evidenceSha256 = text(input.evidenceSha256, 'INVALID_INPUT', 64).trim();
    if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('INVALID_INPUT');
    const nowDate = currentDate(this.now);
    const nowText = nowDate.toISOString();
    const expiresAt = timestamp(input.expiresAt, nowDate, false);
    const credentialId = randomUUID();
    const resolver = this.supplyProfileResolver;
    if (!resolver) fail('SUPPLY_STORAGE_ERROR');

    return this.run(
      () =>
        this.repository.transaction(async (repository, executor) => {
          const bindProfileAccount = repository.createTenantByokProfileAccount;
          if (typeof repository.appendAuditEvent !== 'function' || typeof bindProfileAccount !== 'function') {
            fail('SUPPLY_STORAGE_ERROR');
          }
          const resolution = await resolver.resolve(input.context, 'byok', {
            ...(executor === undefined ? {} : { executor }),
          });
          if (resolution?.mode !== 'byok' || resolution.profileId.trim() === '') {
            fail('CREDENTIAL_UNAVAILABLE');
          }
          if (!resolution.allowedModels.includes(capability.model)) fail('CREDENTIAL_UNAVAILABLE');

          const account = await repository.createAccount(persistedAccount);
          const parent: PersistedProviderCredentialInput = {
            owner: ownerFromAccountRecord(account),
            id: credentialId,
            accountId: account.id,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            status: 'pending',
            validationState: 'unverified',
            expiresAt,
            createdAt: nowText,
            updatedAt: nowText,
          };
          await repository.createCredential(parent);
          const envelope = await seal(
            input.secret,
            contextFor(account, credentialId, 1, this.options.deployment, this.options.environment),
            this.sealingKms,
            this.options.kmsKeyId,
          );
          const writeResult = assertWriteResult(
            await repository.appendCredentialVersion({
              credential: {
                ...ownerFromAccountRecord(account),
                accountId: account.id,
                credentialId,
                version: 1,
              },
              providerId: account.providerId,
              productId: account.productId,
              envelope,
              kmsPurpose: account.purpose,
              wrappingRevision: 1,
              expectedCurrentVersion: null,
              createdAt: nowText,
              expiresAt,
            }),
          );
          const allowedModels = [
            ...new Set(resolution.allowedModels.map((model) => text(model, 'INVALID_INPUT', 256))),
          ].sort();
          if (!allowedModels.includes(capability.model)) fail('CREDENTIAL_UNAVAILABLE');
          const idempotencyKey = createHash('sha256')
            .update(
              [
                'provider-credential-validation-v1',
                tenantId,
                account.id,
                credentialId,
                String(writeResult.version.version),
                account.providerId,
                account.productId,
              ].join('\u0000'),
            )
            .digest('hex');
          const validationJob: ProviderCredentialValidationJobInput = {
            tenantId,
            accountId: account.id,
            credentialId,
            credentialVersion: writeResult.version.version,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            allowedModels,
            target: capability,
            idempotencyKey,
          };
          await repository.enqueueProviderCredentialValidationJob(validationJob);
          await bindProfileAccount.call(repository, {
            tenantId,
            supplyProfileId: resolution.profileId,
            accountId: account.id,
            effectiveAt: nowText,
            expiresAt,
            evidenceReference,
            evidenceSha256,
          });
          await this.appendAuditEvent(
            repository,
            audit,
            tenantId,
            'provider_supply.account.created',
            'saas_provider_account',
            account.id,
            nowText,
          );
          await this.appendAuditEvent(
            repository,
            audit,
            tenantId,
            'provider_supply.credential.created',
            'saas_provider_credential',
            credentialId,
            nowText,
          );
          await this.appendAuditEvent(
            repository,
            audit,
            tenantId,
            'tenant_profile_account.bound',
            'saas_provider_supply_relationship',
            `${tenantId}:${resolution.profileId}:${account.id}`,
            nowText,
          );
          if (
            account.ownerKind !== 'tenant' ||
            account.tenantId !== tenantId ||
            writeResult.credential.ownerKind !== 'tenant' ||
            writeResult.credential.tenantId !== tenantId ||
            writeResult.credential.accountId !== account.id
          ) {
            fail('SUPPLY_STORAGE_ERROR');
          }
          return { account, ...writeResult };
        }),
      'SUPPLY_STORAGE_ERROR',
      'CREDENTIAL_EXISTS',
    );
  }

  async getProviderCredential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord> {
    return this.credential(reference);
  }

  async listProviderCredentials(
    filter: ProviderCredentialListFilter = {},
  ): Promise<readonly ProviderCredentialRecord[]> {
    const account = filter.account === undefined ? undefined : normalizeAccountReference(filter.account);
    if (account !== undefined && filter.ownerKind !== undefined && filter.ownerKind !== account.ownerKind)
      fail('INVALID_INPUT');
    if (filter.ownerKind === 'platform' && filter.tenantId !== undefined) fail('INVALID_INPUT');
    if (account?.ownerKind === 'tenant' && filter.tenantId !== undefined && filter.tenantId !== account.tenantId)
      fail('INVALID_INPUT');
    const accountTenantId =
      account === undefined || account.ownerKind === 'platform' ? undefined : identifier(account.tenantId);
    return this.run(
      () =>
        this.repository.listCredentials({
          ...filter,
          account,
          ownerKind: filter.ownerKind ?? account?.ownerKind,
          tenantId: filter.tenantId ?? accountTenantId,
        }),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async listProviderCredentialVersions(
    reference: ProviderCredentialReference,
  ): Promise<readonly ProviderCredentialVersionRecord[]> {
    return this.run(
      () => this.repository.listCredentialVersions(normalizeCredentialReference(reference)),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async getProviderCredentialVersion(
    reference: ProviderCredentialReference & { readonly version: number },
  ): Promise<ProviderCredentialVersionRecord> {
    const normalized = normalizeCredentialReference(reference);
    if (normalized.version === undefined) fail('INVALID_INPUT');
    const result = await this.run(
      () => this.repository.getCredentialVersion(normalized as ProviderCredentialReference & { version: number }),
      'SUPPLY_STORAGE_ERROR',
    );
    if (!result) fail('CREDENTIAL_NOT_FOUND');
    return result;
  }

  private async replaceProviderCredentialSecretInternal(
    input: ReplaceProviderCredentialSecretInput,
    audit?: ProviderSupplyAuditContext,
    context?: TenantContext,
  ): Promise<ProviderCredentialWriteResult> {
    if (!input) fail('INVALID_INPUT');
    assertSecret(input.secret);
    const reference = normalizeCredentialReference(input.credential);
    if (input.expectedVersion !== null) positiveInteger(input.expectedVersion);
    const nowDate = currentDate(this.now);
    const expiresAt = timestamp(input.expiresAt, nowDate, false);
    return this.run(
      () =>
        this.repository.transaction(async (repository, executor) => {
          if (audit !== undefined && typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
          const credential = await repository.getCredential(reference);
          if (!credential) fail('CREDENTIAL_NOT_FOUND');
          if (credential.status === 'revoked') fail('CREDENTIAL_REVOKED');
          if (credential.status === 'disabled') fail('CREDENTIAL_STATE_CONFLICT');
          if (credential.currentVersion !== input.expectedVersion) fail('CREDENTIAL_VERSION_CONFLICT');
          const account = await repository.getAccount({
            ownerKind: credential.ownerKind,
            tenantId: credential.tenantId,
            accountId: credential.accountId,
          });
          if (!account) fail('ACCOUNT_NOT_FOUND');
          if (account.status === 'revoked') fail('ACCOUNT_REVOKED');
          if (account.status === 'disabled') fail('CREDENTIAL_UNAVAILABLE');
          let validationAllowedModels: string[] | null = null;
          if (context !== undefined) {
            if (
              (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') ||
              credential.ownerKind !== 'tenant' ||
              credential.tenantId !== context.tenantId ||
              account.ownerKind !== 'tenant' ||
              account.tenantId !== context.tenantId ||
              credential.supplyMode !== 'byok' ||
              account.supplyMode !== 'byok'
            ) {
              fail('CREDENTIAL_UNAVAILABLE');
            }
            const resolver = this.supplyProfileResolver;
            if (!resolver) fail('CREDENTIAL_UNAVAILABLE');
            let resolution: Awaited<ReturnType<SupplyProfileResolver['resolve']>>;
            try {
              resolution = await resolver.resolve(context, 'byok', executor === undefined ? {} : { executor });
            } catch {
              fail('CREDENTIAL_UNAVAILABLE');
            }
            if (
              resolution?.mode !== 'byok' ||
              typeof resolution.entitlementId !== 'string' ||
              resolution.entitlementId.trim() === '' ||
              typeof resolution.profileId !== 'string' ||
              resolution.profileId.trim() === '' ||
              !Array.isArray(resolution.allowedModels) ||
              resolution.allowedModels.length === 0 ||
              !Number.isSafeInteger(resolution.entitlementAuthzVersion) ||
              resolution.entitlementAuthzVersion < 1 ||
              !Number.isSafeInteger(resolution.supplyProfileAuthzVersion) ||
              resolution.supplyProfileAuthzVersion < 1 ||
              !Array.isArray(account.capabilities) ||
              account.capabilities.length === 0 ||
              account.capabilities.some(
                (capability) =>
                  !resolution.allowedModels.includes(capability.model) ||
                  typeof capability.endpoint !== 'string' ||
                  capability.endpoint.trim() === '' ||
                  !Number.isSafeInteger(capability.version) ||
                  capability.version < 1,
              )
            ) {
              fail('CREDENTIAL_UNAVAILABLE');
            }
            validationAllowedModels = [
              ...new Set(resolution.allowedModels.map((model) => text(model, 'INVALID_INPUT', 256))),
            ].sort();
            if (account.capabilities.some((capability) => !validationAllowedModels?.includes(capability.model))) {
              fail('CREDENTIAL_UNAVAILABLE');
            }
          }
          const version = (credential.currentVersion ?? 0) + 1;
          const envelope = await seal(
            input.secret,
            contextFor(account, credential.id, version, this.options.deployment, this.options.environment),
            this.sealingKms,
            this.options.kmsKeyId,
          );
          const appended = await repository.appendCredentialVersion({
            credential: { ...reference, version },
            providerId: account.providerId,
            productId: account.productId,
            envelope,
            kmsPurpose: account.purpose,
            wrappingRevision: 1,
            expectedCurrentVersion: input.expectedVersion,
            createdAt: nowDate.toISOString(),
            expiresAt,
          });
          if (credential.ownerKind === 'tenant' && credential.supplyMode === 'byok') {
            const capability = account.capabilities[0];
            if (account.capabilities.length !== 1 || !capability) fail('CREDENTIAL_UNAVAILABLE');
            const allowedModels = validationAllowedModels ?? [capability.model];
            if (!allowedModels.includes(capability.model)) fail('CREDENTIAL_UNAVAILABLE');
            const idempotencyKey = createHash('sha256')
              .update(
                [
                  'provider-credential-validation-v1',
                  credential.tenantId,
                  account.id,
                  credential.id,
                  String(appended.version.version),
                  account.providerId,
                  account.productId,
                ].join('\u0000'),
              )
              .digest('hex');
            await repository.enqueueProviderCredentialValidationJob({
              tenantId: credential.tenantId,
              accountId: account.id,
              credentialId: credential.id,
              credentialVersion: appended.version.version,
              providerId: account.providerId,
              productId: account.productId,
              credentialType: account.credentialType,
              allowedModels,
              target: capability,
              idempotencyKey,
            });
          }
          if (audit !== undefined) {
            await this.appendAuditEvent(
              repository,
              audit,
              credential.tenantId,
              'provider_supply.credential.secret_rotated',
              'saas_provider_credential',
              credential.id,
              nowDate.toISOString(),
            );
          }
          return assertWriteResult(appended);
        }),
      'SUPPLY_STORAGE_ERROR',
      'CREDENTIAL_VERSION_CONFLICT',
    );
  }

  async replaceProviderCredentialSecret(
    input: ReplaceProviderCredentialSecretInput,
  ): Promise<ProviderCredentialWriteResult> {
    return this.replaceProviderCredentialSecretInternal(input);
  }

  async replaceProviderCredentialSecretWithAudit(
    input: ReplaceProviderCredentialSecretInput,
    audit: ProviderSupplyAuditContext,
    context?: TenantContext,
  ): Promise<ProviderCredentialWriteResult> {
    return this.replaceProviderCredentialSecretInternal(input, audit, context);
  }

  async setProviderCredentialValidation(
    reference: ProviderCredentialReference,
    validationState: ProviderValidationState,
    validationErrorCode: string | null = null,
  ): Promise<ProviderCredentialRecord> {
    assertValidationState(validationState);
    const current = await this.credential(reference);
    if (current.status === 'revoked') fail('CREDENTIAL_REVOKED');
    const now = currentDate(this.now).toISOString();
    const input: UpdateProviderCredentialValidationInput = {
      credential: normalizeCredentialReference(reference),
      validationState,
      validationErrorCode:
        validationState === 'failed' ? text(validationErrorCode ?? 'validation_failed', 'INVALID_INPUT', 128) : null,
      lastValidatedAt: now,
      expectedAuthzVersion: current.authzVersion,
      updatedAt: now,
    };
    const updated = await this.run(() => this.repository.updateCredentialValidation(input), 'SUPPLY_STORAGE_ERROR');
    if (!updated) fail('CREDENTIAL_STATE_CONFLICT');
    return updated;
  }

  async revokeProviderCredential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord> {
    return this.changeCredentialLifecycle(reference, 'revoked');
  }

  async disableProviderCredential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord> {
    return this.changeCredentialLifecycle(reference, 'disabled');
  }

  private async changeCredentialLifecycle(
    reference: ProviderCredentialReference,
    status: 'disabled' | 'revoked',
  ): Promise<ProviderCredentialRecord> {
    const current = await this.credential(reference);
    if (current.status === 'revoked') fail('CREDENTIAL_REVOKED');
    if (current.status === status) fail('INVALID_CREDENTIAL_LIFECYCLE');
    const now = currentDate(this.now).toISOString();
    const input: UpdateProviderCredentialLifecycleInput = {
      credential: normalizeCredentialReference(reference),
      status,
      expectedAuthzVersion: current.authzVersion,
      updatedAt: now,
      ...statusTimestamp(status, now),
    };
    const updated = await this.run(() => this.repository.updateCredentialLifecycle(input), 'SUPPLY_STORAGE_ERROR');
    if (!updated) fail('CREDENTIAL_STATE_CONFLICT');
    return updated;
  }
}

export class ProviderCredentialAccessService {
  private readonly now: () => Date;

  constructor(
    private readonly proofReader: ProviderCredentialDispatchProofReader,
    private readonly kms: ProviderCredentialUnsealingKms,
    private readonly options: ProviderCredentialAccessServiceOptions,
  ) {
    text(options.deployment);
    text(options.environment);
    this.now = options.now ?? (() => new Date());
  }

  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProviderSupplyError) throw error;
      throw mapRepositoryError(error, 'SUPPLY_STORAGE_ERROR');
    }
  }

  async withCredential<T>(
    grant: ProviderCredentialAccessGrant,
    callback: (secret: Buffer) => T | PromiseLike<T>,
  ): Promise<T> {
    if (
      !grant ||
      typeof grant !== 'object' ||
      typeof grant.evidenceId !== 'string' ||
      grant.evidenceId.trim() === '' ||
      grant.evidenceId !== grant.evidenceId.trim() ||
      typeof callback !== 'function'
    ) {
      fail('INVALID_INPUT');
    }
    const now = currentDate(this.now);
    const proof = await this.read(() => this.proofReader.readDispatchProof(grant.evidenceId));
    if (!proof) fail('CREDENTIAL_UNAVAILABLE');
    assertDispatchProof(proof, now, grant.evidenceId);
    try {
      return await withUnsealedProviderCredential(
        proof.version.envelope,
        contextFor(
          proof.account,
          proof.credential.id,
          proof.version.version,
          this.options.deployment,
          this.options.environment,
        ),
        this.kms,
        callback,
      );
    } catch (error) {
      if (error instanceof ProviderSupplyError) throw error;
      throw new ProviderSupplyError('KMS_UNSEAL_FAILED');
    }
  }
}

export const PROVIDER_SUPPLY_PERSISTENCE_FORMAT = Object.freeze({
  envelopeSchemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
});
