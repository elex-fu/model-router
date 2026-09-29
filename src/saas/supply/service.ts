import { createHash, randomUUID } from 'node:crypto';
import type {
  ProviderCredentialKms,
  ProviderCredentialRewrappingKms,
  ProviderCredentialSealingKms,
  ProviderCredentialUnsealingKms,
} from '../credentials/provider-crypto.js';
import {
  createProviderCredentialContext,
  createProviderCredentialEncryptionContext,
  type ProviderCredentialContext,
  rewrapProviderCredentialEnvelope,
} from '../credentials/provider-crypto.js';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../db/index.js';
import type { TenantContext } from '../identity/types.js';
import type { SupplyProfileResolver } from '../keys/types.js';
import { ProviderSupplyError, type ProviderSupplyErrorCode } from './errors.js';
import { ProviderCredentialAccessService, ProviderSupplyPersistenceService } from './persistence-service.js';
import { PostgresProviderSupplyRepository, type ProviderSupplyRepository } from './repository.js';
import type {
  CreatedTenantByokCredential,
  CreateProviderAccountInput,
  CreateProviderCredentialInput,
  CreateTenantByokCredentialInput,
  CreateTenantProviderSupplyProfileAccountInput,
  PlatformPoolGrantStateChangeInput,
  PlatformPoolMemberRecord,
  PlatformPoolMemberStateChangeInput,
  PlatformProviderSupplyOwner,
  ProviderAccountListFilter,
  ProviderAccountRecord,
  ProviderAccountReference,
  ProviderCapabilityReference,
  ProviderCredentialAccessGrant,
  ProviderCredentialListFilter,
  ProviderCredentialRecord,
  ProviderCredentialReference,
  ProviderCredentialRewrapAuditContext,
  ProviderCredentialVersionRecord,
  ProviderCredentialWrapperRevisionRecord,
  ProviderCredentialWriteResult,
  ProviderSupplyAuditContext,
  ProviderValidationState,
  RebindPlatformPoolGrantInput,
  RebindPlatformPoolMemberInput,
  RebindTenantProviderSupplyProfileAccountInput,
  ReplaceProviderCredentialSecretInput,
  ReplaceTenantProviderCredentialSecretInput,
  SupplyTimestamp,
  TenantProviderCredentialLifecycleInput,
  TenantProviderSupplyProfileAccountRecord,
  TenantProviderSupplyProfileAccountStateChangeInput,
} from './types.js';

type AdvisoryLockMode = 'shared' | 'exclusive';

async function lockAdvisoryLayers(
  executor: SqlExecutor,
  layers: readonly (readonly string[])[],
  mode: AdvisoryLockMode,
): Promise<void> {
  const functionName = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  for (const layer of layers) {
    for (const key of sortAndDedupeAdvisoryKeys(layer)) {
      await executor.query(`SELECT ${functionName}(hashtextextended($1::text, 0))`, [key]);
    }
  }
}

function providerAccountAdvisoryKey(reference: ProviderAccountReference): string {
  return reference.ownerKind === 'tenant'
    ? saasAdvisoryKey.tenantProviderAccount(text(reference.tenantId), reference.accountId)
    : saasAdvisoryKey.platformProviderAccount(reference.accountId);
}

function providerCredentialAdvisoryKey(reference: ProviderCredentialReference): string {
  return reference.ownerKind === 'tenant'
    ? saasAdvisoryKey.tenantProviderCredential(text(reference.tenantId), reference.credentialId)
    : saasAdvisoryKey.platformProviderCredential(reference.credentialId);
}

function providerAccountLockLayers(references: readonly ProviderAccountReference[]): readonly (readonly string[])[] {
  return [
    sortAndDedupeAdvisoryKeys(
      references.flatMap((reference) =>
        reference.ownerKind === 'tenant' ? [saasAdvisoryKey.tenant(text(reference.tenantId))] : [],
      ),
    ),
    sortAndDedupeAdvisoryKeys(references.map(providerAccountAdvisoryKey)),
  ];
}

function providerCredentialLockLayers(reference: ProviderCredentialReference): readonly (readonly string[])[] {
  return [
    ...providerAccountLockLayers([
      { ownerKind: reference.ownerKind, tenantId: reference.tenantId, accountId: reference.accountId },
    ]),
    [providerCredentialAdvisoryKey(reference)],
  ];
}

export type {
  CreatedTenantByokCredential,
  CreateTenantByokCredentialInput,
  CreateTenantProviderSupplyProfileAccountInput,
  PlatformPoolGrantStateChangeInput,
  PlatformPoolMemberRecord,
  PlatformPoolMemberStateChangeInput,
  ProviderSupplyAuditContext,
  RebindPlatformPoolGrantInput,
  RebindPlatformPoolMemberInput,
  RebindTenantProviderSupplyProfileAccountInput,
  ReplaceTenantProviderCredentialSecretInput,
  TenantProviderCredentialLifecycleInput,
  TenantProviderSupplyProfileAccountRecord,
  TenantProviderSupplyProfileAccountStateChangeInput,
} from './types.js';

export interface ProviderSupplyServiceOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly kmsKeyId: string;
  /** Legacy combined capability used by existing combined/gateway callers. */
  readonly kms?: ProviderCredentialKms;
  /** Generate-only capability used by control-plane account/credential management. */
  readonly sealingKms?: ProviderCredentialSealingKms;
  /** Explicit decrypt-only capability used by gateway/validation access. */
  readonly accessKms?: ProviderCredentialUnsealingKms;
  /** Remote ReEncrypt-only capability; no plaintext DEK operation is accepted. */
  readonly rewrappingKms?: ProviderCredentialRewrappingKms;
  readonly now?: () => Date;
  /** Injectable for deterministic tests; production defaults to the PostgreSQL repository. */
  readonly repository?: ProviderSupplyRepository;
  /** Resolver used for project-bound BYOK entitlement checks; required for customer BYOK creation. */
  readonly supplyProfileResolver?: SupplyProfileResolver;
}

export interface ProviderAccountStateChangeInput {
  readonly accountId: string;
  readonly expectedAuthzVersion?: number;
}

export interface ProviderAccountValidationInput extends ProviderAccountStateChangeInput {
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode?: string | null;
}

export interface ProviderCredentialStateChangeInput {
  readonly credentialId: string;
  readonly expectedAuthzVersion?: number;
}

export interface ProviderCredentialValidationInput extends ProviderCredentialStateChangeInput {
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode?: string | null;
}

export interface PlatformProviderAccountCreateInput {
  readonly id?: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
  readonly audit: ProviderSupplyAuditContext;
}

export interface PlatformProviderCredentialCreateInput {
  readonly accountId: string;
  readonly id?: string;
  readonly secret: Uint8Array;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly audit: ProviderSupplyAuditContext;
}

export interface PlatformProviderCredentialSecretRotationInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly secret: Uint8Array;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly audit: ProviderSupplyAuditContext;
}

export interface PlatformProviderAccountLifecycleInput {
  readonly accountId: string;
  readonly expectedAuthzVersion: number;
  readonly audit: ProviderSupplyAuditContext;
}

export interface PlatformProviderCredentialLifecycleInput {
  readonly credentialId: string;
  readonly expectedAuthzVersion: number;
  readonly audit: ProviderSupplyAuditContext;
}

export interface RewrapProviderCredentialInput {
  readonly credential: ProviderCredentialReference;
  readonly version: number;
  readonly expectedWrappingRevision: number;
  readonly destinationKmsKeyId: string;
  readonly operationId: string;
  readonly audit: ProviderCredentialRewrapAuditContext;
  readonly reasonCode: string;
}

export interface CreatePlatformProviderPoolInput {
  readonly id?: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  /** Kept for API compatibility; migration 016 has no pool-capability relation. */
  readonly capabilities?: readonly { readonly model: string; readonly endpoint: string; readonly version: number }[];
  readonly status?: 'pending' | 'active' | 'disabled' | 'revoked';
  readonly validationState?: ProviderValidationState;
}

export interface ProviderPoolRecord extends PlatformProviderSupplyOwner {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly { readonly model: string; readonly endpoint: string; readonly version: number }[];
  readonly status: 'pending' | 'active' | 'disabled' | 'revoked';
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly authzVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
}

export interface AddPlatformPoolMemberInput {
  readonly poolId: string;
  readonly accountId: string;
  readonly expectedAccountAuthzVersion?: number;
}

export interface GrantPlatformPoolInput {
  readonly poolId: string;
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly expiresAt?: SupplyTimestamp | null;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
}

export interface PlatformPoolGrantRecord {
  readonly poolId: string;
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: 'platform';
  readonly profileAuthzVersion: number;
  readonly poolAuthzVersion: number;
  readonly status: 'active' | 'disabled' | 'revoked';
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly authzVersion: number;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
}

type StoredTimestamp = string | Date;
type AccountLifecycle = ProviderAccountRecord['status'];
type CredentialLifecycle = Exclude<ProviderCredentialRecord['status'], 'pending'>;

interface PoolRow {
  id: string;
  owner_kind: string;
  supply_mode: string;
  display_name: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  region: string;
  purpose: string;
  rights_id: string;
  rights_version: number | string;
  status: string;
  validation_state: string;
  validation_error_code: string | null;
  last_validated_at: StoredTimestamp | null;
  authz_version: number | string;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  disabled_at: StoredTimestamp | null;
  revoked_at: StoredTimestamp | null;
}

interface ProfileRow {
  tenant_id: string;
  id: string;
  supply_mode: string;
  status: string;
  authz_version: number | string;
}

interface PoolGrantRow {
  pool_id: string;
  tenant_id: string;
  supply_profile_id: string;
  supply_mode: string;
  profile_authz_version: number | string;
  pool_authz_version: number | string;
  status: string;
  effective_at: StoredTimestamp;
  expires_at: StoredTimestamp | null;
  authz_version: number | string;
  evidence_ref: string;
  evidence_sha256: string;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  disabled_at: StoredTimestamp | null;
  revoked_at: StoredTimestamp | null;
}

interface PoolMemberRow {
  pool_id: string;
  account_id: string;
  provider_id: string;
  product_id: string;
  account_authz_version: number | string;
  authz_version: number | string;
  status: string;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  disabled_at: StoredTimestamp | null;
  revoked_at: StoredTimestamp | null;
}

interface TenantProfileAccountRow {
  tenant_id: string;
  supply_profile_id: string;
  supply_mode: string;
  account_id: string;
  provider_id: string;
  product_id: string;
  account_authz_version: number | string;
  status: string;
  effective_at: StoredTimestamp;
  expires_at: StoredTimestamp | null;
  authz_version: number | string;
  evidence_ref: string;
  evidence_sha256: string;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  disabled_at: StoredTimestamp | null;
  revoked_at: StoredTimestamp | null;
}

interface PlatformSupplyAccountRow {
  id: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  region: string;
  purpose: string;
  status: string;
  validation_state: string;
  authz_version: number | string;
}

interface TenantSupplyAccountRow extends PlatformSupplyAccountRow {
  tenant_id: string;
}

interface TenantAccountIdentityRow {
  tenant_id: string;
  id: string;
}

interface PlatformAccountIdentityRow {
  id: string;
}

interface TenantCredentialIdentityRow {
  tenant_id: string;
  account_id: string;
  id: string;
}

interface PlatformCredentialIdentityRow {
  account_id: string;
  id: string;
}

const POOL_COLUMNS = `
  id, owner_kind, supply_mode, display_name, provider_id, product_id,
  credential_type, region, purpose, rights_id, rights_version, status,
  validation_state, validation_error_code, last_validated_at, authz_version,
  created_at, updated_at, disabled_at, revoked_at`;

const POOL_GRANT_COLUMNS = `
  pool_id, tenant_id, supply_profile_id, supply_mode, profile_authz_version,
  pool_authz_version, status, effective_at, expires_at, authz_version,
  evidence_ref, evidence_sha256, created_at, updated_at, disabled_at, revoked_at`;

const POOL_MEMBER_COLUMNS = `
  pool_id, account_id, provider_id, product_id, account_authz_version,
  authz_version, status, created_at, updated_at, disabled_at, revoked_at`;

const TENANT_PROFILE_ACCOUNT_COLUMNS = `
  tenant_id, supply_profile_id, supply_mode, account_id, provider_id, product_id,
  account_authz_version, status, effective_at, expires_at, authz_version,
  evidence_ref, evidence_sha256, created_at, updated_at, disabled_at, revoked_at`;

function fail(code: ProviderSupplyErrorCode): never {
  throw new ProviderSupplyError(code);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function mapFailure(error: unknown, fallback: ProviderSupplyErrorCode, duplicateCode = fallback): ProviderSupplyError {
  if (error instanceof ProviderSupplyError) return error;
  switch (errorCode(error)) {
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

function text(value: unknown, code: ProviderSupplyErrorCode = 'INVALID_INPUT', maxBytes = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) fail(code);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail(code);
  return value;
}

function identifier(value: unknown): string {
  return text(value, 'INVALID_INPUT', 256).trim();
}

function positiveInteger(value: unknown, code: ProviderSupplyErrorCode = 'INVALID_INPUT'): number {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1) fail(code);
  return numeric;
}

function currentDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INPUT');
  return new Date(value.getTime());
}

function timestamp(value: SupplyTimestamp | null | undefined, now: Date, future = false): string | null {
  if (value === undefined || value === null) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime()) || (future && parsed.getTime() <= now.getTime())) fail('INVALID_INPUT');
  return parsed.toISOString();
}

function storedTimestamp(value: StoredTimestamp): string {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('SUPPLY_STORAGE_ERROR');
  return parsed.toISOString();
}

function nullableStoredTimestamp(value: StoredTimestamp | null): string | null {
  return value === null ? null : storedTimestamp(value);
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

function accountReference(record: ProviderAccountRecord): ProviderAccountReference {
  return {
    ownerKind: record.ownerKind,
    tenantId: record.tenantId,
    accountId: record.id,
  };
}

function credentialReference(record: ProviderCredentialRecord): ProviderCredentialReference {
  return {
    ownerKind: record.ownerKind,
    tenantId: record.tenantId,
    accountId: record.accountId,
    credentialId: record.id,
  };
}

function statusTimestamp(
  status: AccountLifecycle | CredentialLifecycle,
  now: string,
): {
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
} {
  return {
    disabledAt: status === 'disabled' ? now : null,
    revokedAt: status === 'revoked' ? now : null,
  };
}

function capabilities(
  values: readonly { readonly model: string; readonly endpoint: string; readonly version: number }[] | undefined,
): readonly { readonly model: string; readonly endpoint: string; readonly version: number }[] {
  const normalized = (values ?? []).map((value) => ({
    model: identifier(value.model),
    endpoint: identifier(value.endpoint),
    version: positiveInteger(value.version),
  }));
  return [
    ...new Map(
      normalized.map((value) => [`${value.model}\u0000${value.endpoint}\u0000${value.version}`, value]),
    ).values(),
  ];
}

function poolStatus(value: unknown): ProviderPoolRecord['status'] {
  if (value === 'pending' || value === 'active' || value === 'disabled' || value === 'revoked') return value;
  fail('SUPPLY_STORAGE_ERROR');
}

function validationState(value: unknown): ProviderValidationState {
  if (value === 'unverified' || value === 'verified' || value === 'failed') return value;
  fail('SUPPLY_STORAGE_ERROR');
}

function relationStatus(value: unknown): 'active' | 'disabled' | 'revoked' {
  if (value === 'active' || value === 'disabled' || value === 'revoked') return value;
  fail('SUPPLY_STORAGE_ERROR');
}

function normalizeAuditContext(input: ProviderSupplyAuditContext | undefined): ProviderSupplyAuditContext {
  if (!input) fail('INVALID_INPUT');
  return {
    actorUserId: identifier(input.actorUserId),
    entryPoint: text(input.entryPoint, 'INVALID_INPUT', 128).trim(),
    sourceIp:
      input.sourceIp === undefined || input.sourceIp === null
        ? null
        : text(input.sourceIp, 'INVALID_INPUT', 128).trim(),
    userAgent:
      input.userAgent === undefined || input.userAgent === null ? null : text(input.userAgent, 'INVALID_INPUT', 512),
    requestId:
      input.requestId === undefined || input.requestId === null
        ? null
        : text(input.requestId, 'INVALID_INPUT', 256).trim(),
  };
}

function mapPool(
  row: PoolRow,
  requestedCapabilities: readonly { readonly model: string; readonly endpoint: string; readonly version: number }[],
): ProviderPoolRecord {
  if (row.owner_kind !== 'platform' || row.supply_mode !== 'platform') fail('SUPPLY_STORAGE_ERROR');
  return {
    ownerKind: 'platform',
    tenantId: null,
    supplyMode: 'platform',
    id: identifier(row.id),
    displayName: text(row.display_name, 'SUPPLY_STORAGE_ERROR', 512),
    providerId: identifier(row.provider_id),
    productId: identifier(row.product_id),
    credentialType: identifier(row.credential_type),
    region: identifier(row.region),
    purpose: identifier(row.purpose),
    rightsId: identifier(row.rights_id),
    rightsVersion: positiveInteger(row.rights_version, 'SUPPLY_STORAGE_ERROR'),
    capabilities: requestedCapabilities,
    status: poolStatus(row.status),
    validationState: validationState(row.validation_state),
    validationErrorCode: row.validation_error_code,
    lastValidatedAt: nullableStoredTimestamp(row.last_validated_at),
    authzVersion: positiveInteger(row.authz_version, 'SUPPLY_STORAGE_ERROR'),
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    disabledAt: nullableStoredTimestamp(row.disabled_at),
    revokedAt: nullableStoredTimestamp(row.revoked_at),
  };
}

function mapPoolMember(row: PoolMemberRow): PlatformPoolMemberRecord {
  return {
    poolId: identifier(row.pool_id),
    accountId: identifier(row.account_id),
    providerId: identifier(row.provider_id),
    productId: identifier(row.product_id),
    accountAuthzVersion: positiveInteger(row.account_authz_version, 'SUPPLY_STORAGE_ERROR'),
    authzVersion: positiveInteger(row.authz_version, 'SUPPLY_STORAGE_ERROR'),
    status: relationStatus(row.status),
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    disabledAt: nullableStoredTimestamp(row.disabled_at),
    revokedAt: nullableStoredTimestamp(row.revoked_at),
  };
}

function mapTenantProfileAccount(row: TenantProfileAccountRow): TenantProviderSupplyProfileAccountRecord {
  if (row.supply_mode !== 'byok') fail('SUPPLY_STORAGE_ERROR');
  const evidenceSha256 = text(row.evidence_sha256, 'SUPPLY_STORAGE_ERROR', 64);
  if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('SUPPLY_STORAGE_ERROR');
  return {
    tenantId: identifier(row.tenant_id),
    supplyProfileId: identifier(row.supply_profile_id),
    supplyMode: 'byok',
    accountId: identifier(row.account_id),
    providerId: identifier(row.provider_id),
    productId: identifier(row.product_id),
    accountAuthzVersion: positiveInteger(row.account_authz_version, 'SUPPLY_STORAGE_ERROR'),
    status: relationStatus(row.status),
    effectiveAt: storedTimestamp(row.effective_at),
    expiresAt: nullableStoredTimestamp(row.expires_at),
    authzVersion: positiveInteger(row.authz_version, 'SUPPLY_STORAGE_ERROR'),
    evidenceReference: text(row.evidence_ref, 'SUPPLY_STORAGE_ERROR', 512),
    evidenceSha256,
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    disabledAt: nullableStoredTimestamp(row.disabled_at),
    revokedAt: nullableStoredTimestamp(row.revoked_at),
  };
}

function mapPoolGrant(row: PoolGrantRow): PlatformPoolGrantRecord {
  if (row.supply_mode !== 'platform') fail('SUPPLY_STORAGE_ERROR');
  const status = row.status === 'active' || row.status === 'disabled' || row.status === 'revoked' ? row.status : null;
  if (status === null) fail('SUPPLY_STORAGE_ERROR');
  const evidenceSha256 = text(row.evidence_sha256, 'SUPPLY_STORAGE_ERROR', 64);
  if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('SUPPLY_STORAGE_ERROR');
  return {
    poolId: identifier(row.pool_id),
    tenantId: identifier(row.tenant_id),
    supplyProfileId: identifier(row.supply_profile_id),
    supplyMode: 'platform',
    profileAuthzVersion: positiveInteger(row.profile_authz_version, 'SUPPLY_STORAGE_ERROR'),
    poolAuthzVersion: positiveInteger(row.pool_authz_version, 'SUPPLY_STORAGE_ERROR'),
    status,
    effectiveAt: storedTimestamp(row.effective_at),
    expiresAt: nullableStoredTimestamp(row.expires_at),
    authzVersion: positiveInteger(row.authz_version, 'SUPPLY_STORAGE_ERROR'),
    evidenceReference: text(row.evidence_ref, 'SUPPLY_STORAGE_ERROR', 512),
    evidenceSha256,
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    disabledAt: nullableStoredTimestamp(row.disabled_at),
    revokedAt: nullableStoredTimestamp(row.revoked_at),
  };
}

/**
 * Compatibility facade for the original exported service.
 *
 * Account/capability and credential persistence is delegated to the normalized
 * repository/service pair. Pool and profile-relationship operations use only
 * columns present in migrations 015/016/020 because the normalized repository
 * intentionally owns the account and credential families, not pool grants.
 */
export class ProviderSupplyService {
  private readonly repository: ProviderSupplyRepository;
  private readonly persistence: ProviderSupplyPersistenceService;
  private readonly access: ProviderCredentialAccessService | undefined;
  private readonly database: SaasDatabase;
  private readonly now: () => Date;
  private readonly hasInjectedRepository: boolean;
  private readonly supplyProfileResolver: SupplyProfileResolver | undefined;
  private readonly deployment: string;
  private readonly environment: string;
  private readonly rewrappingKms: ProviderCredentialRewrappingKms | undefined;

  constructor(database: SaasDatabase, options: ProviderSupplyServiceOptions) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
    this.hasInjectedRepository = options.repository !== undefined;
    this.supplyProfileResolver = options.supplyProfileResolver;
    this.deployment = options.deployment;
    this.environment = options.environment;
    this.rewrappingKms = options.rewrappingKms;
    this.repository = options.repository ?? new PostgresProviderSupplyRepository(database);
    // Keep the legacy combined `kms` path intact, but never infer access from
    // the generate-only sealing capability.
    const accessKms = options.accessKms ?? options.kms;
    const persistenceOptions = {
      deployment: options.deployment,
      environment: options.environment,
      kmsKeyId: options.kmsKeyId,
      kms: options.kms,
      sealingKms: options.sealingKms,
      supplyProfileResolver: options.supplyProfileResolver,
      now: this.now,
    };
    this.persistence = new ProviderSupplyPersistenceService(this.repository, persistenceOptions);
    this.access =
      accessKms === undefined
        ? undefined
        : new ProviderCredentialAccessService(this.repository, accessKms, {
            deployment: options.deployment,
            environment: options.environment,
            now: this.now,
          });
  }

  private async repositoryRun<T>(
    work: () => Promise<T>,
    fallback: ProviderSupplyErrorCode = 'SUPPLY_STORAGE_ERROR',
    duplicateCode: ProviderSupplyErrorCode = fallback,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw mapFailure(error, fallback, duplicateCode);
    }
  }

  private async query<Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    return executor.query<Row>(sql, values);
  }

  private async lockPlatformPool(executor: SqlExecutor, poolId: string, mode: AdvisoryLockMode): Promise<void> {
    await lockAdvisoryLayers(executor, [[saasAdvisoryKey.platformPool(poolId)]], mode);
  }

  private async lockPlatformPoolForWrite(executor: SqlExecutor, poolId: string): Promise<void> {
    await this.lockPlatformPool(executor, poolId, 'exclusive');
  }

  private async lockSupplyProfile(
    executor: SqlExecutor,
    tenantId: string,
    supplyProfileId: string,
    mode: AdvisoryLockMode,
  ): Promise<void> {
    await lockAdvisoryLayers(executor, [[saasAdvisoryKey.supplyProfile(tenantId, supplyProfileId)]], mode);
  }

  private async lockSupplyProfileForWrite(
    executor: SqlExecutor,
    tenantId: string,
    supplyProfileId: string,
  ): Promise<void> {
    await this.lockSupplyProfile(executor, tenantId, supplyProfileId, 'exclusive');
  }

  private async lockProviderAccounts(
    executor: SqlExecutor,
    references: readonly ProviderAccountReference[],
    mode: AdvisoryLockMode,
  ): Promise<void> {
    await lockAdvisoryLayers(executor, providerAccountLockLayers(references), mode);
  }

  private async lockTenantProfileAccount(
    executor: SqlExecutor,
    tenantId: string,
    supplyProfileId: string,
    accountIds: readonly string[],
    mode: AdvisoryLockMode,
  ): Promise<void> {
    await lockAdvisoryLayers(
      executor,
      [
        [saasAdvisoryKey.tenant(tenantId)],
        [saasAdvisoryKey.supplyProfile(tenantId, supplyProfileId)],
        accountIds.map((accountId) => saasAdvisoryKey.tenantProviderAccount(tenantId, accountId)),
        accountIds.map((accountId) => saasAdvisoryKey.supplyProfileAccount(tenantId, supplyProfileId, accountId)),
      ],
      mode,
    );
  }

  private async auditSupplyRelation(
    tx: SqlExecutor,
    tenantId: string | null,
    action: string,
    targetId: string,
    audit: ProviderSupplyAuditContext,
    occurredAt: string,
  ): Promise<void> {
    const context = normalizeAuditContext(audit);
    await this.query(
      tx,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
          source_ip, user_agent, entry_point, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        tenantId,
        context.actorUserId,
        action,
        'saas_provider_supply_relationship',
        targetId,
        occurredAt,
        context.sourceIp,
        context.userAgent,
        context.entryPoint,
        context.requestId,
      ],
    );
  }

  private async auditSupplyMutation(
    repository: ProviderSupplyRepository,
    tenantId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    audit: ProviderSupplyAuditContext,
    occurredAt: string,
  ): Promise<void> {
    if (typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
    await repository.appendAuditEvent({
      tenantId,
      action,
      targetType,
      targetId,
      occurredAt,
      audit: normalizeAuditContext(audit),
    });
  }

  private async sqlRead<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw mapFailure(error, 'SUPPLY_STORAGE_ERROR');
    }
  }

  private async schemaAccountReferences(
    filter: ProviderAccountListFilter = {},
  ): Promise<readonly ProviderAccountReference[]> {
    if (filter.ownerKind === 'platform' && filter.tenantId !== undefined) fail('INVALID_INPUT');
    const owners =
      filter.ownerKind !== undefined
        ? [filter.ownerKind]
        : filter.tenantId !== undefined
          ? (['tenant'] as const)
          : (['tenant', 'platform'] as const);
    const references: ProviderAccountReference[] = [];
    for (const ownerKind of owners) {
      const conditions: string[] = [];
      const values: unknown[] = [];
      const add = (condition: string, value: unknown): void => {
        values.push(value);
        conditions.push(condition.replace('$VALUE', `$${values.length}`));
      };
      if (ownerKind === 'tenant' && filter.tenantId !== undefined)
        add('tenant_id = $VALUE', identifier(filter.tenantId));
      if (filter.providerId !== undefined) add('provider_id = $VALUE', identifier(filter.providerId));
      if (filter.productId !== undefined) add('product_id = $VALUE', identifier(filter.productId));
      if (filter.status !== undefined) add('status = $VALUE', filter.status);
      if (filter.validationState !== undefined) add('validation_state = $VALUE', filter.validationState);
      if (ownerKind === 'tenant') {
        const result = await this.query<TenantAccountIdentityRow>(
          this.database,
          `SELECT tenant_id, id
             FROM saas_tenant_provider_accounts
            ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
            ORDER BY created_at, id`,
          values,
        );
        references.push(
          ...result.rows.map(
            (row): ProviderAccountReference => ({
              ownerKind: 'tenant',
              tenantId: row.tenant_id,
              accountId: row.id,
            }),
          ),
        );
      } else {
        const result = await this.query<PlatformAccountIdentityRow>(
          this.database,
          `SELECT id
             FROM saas_platform_provider_accounts
            ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
            ORDER BY created_at, id`,
          values,
        );
        references.push(
          ...result.rows.map(
            (row): ProviderAccountReference => ({ ownerKind: 'platform', tenantId: null, accountId: row.id }),
          ),
        );
      }
    }
    return references;
  }

  private async schemaCredentialReferences(
    filter: ProviderCredentialListFilter = {},
  ): Promise<readonly ProviderCredentialReference[]> {
    const account = filter.account === undefined ? undefined : normalizeAccountReference(filter.account);
    if (account !== undefined && filter.ownerKind !== undefined && filter.ownerKind !== account.ownerKind) {
      fail('INVALID_INPUT');
    }
    if (filter.ownerKind === 'platform' && filter.tenantId !== undefined) fail('INVALID_INPUT');
    if (account?.ownerKind === 'tenant' && filter.tenantId !== undefined && filter.tenantId !== account.tenantId) {
      fail('INVALID_INPUT');
    }
    const owners = account?.ownerKind
      ? [account.ownerKind]
      : filter.ownerKind
        ? [filter.ownerKind]
        : filter.tenantId !== undefined
          ? (['tenant'] as const)
          : (['tenant', 'platform'] as const);
    const references: ProviderCredentialReference[] = [];
    for (const ownerKind of owners) {
      if (account?.ownerKind !== undefined && account.ownerKind !== ownerKind) continue;
      const conditions: string[] = [];
      const values: unknown[] = [];
      const add = (condition: string, value: unknown): void => {
        values.push(value);
        conditions.push(condition.replace('$VALUE', `$${values.length}`));
      };
      if (ownerKind === 'tenant' && account?.ownerKind === 'tenant') add('tenant_id = $VALUE', account.tenantId);
      else if (ownerKind === 'tenant' && filter.tenantId !== undefined) add('tenant_id = $VALUE', filter.tenantId);
      if (account !== undefined) add('account_id = $VALUE', account.accountId);
      if (filter.status !== undefined) add('status = $VALUE', filter.status);
      if (filter.validationState !== undefined) add('validation_state = $VALUE', filter.validationState);
      if (ownerKind === 'tenant') {
        const result = await this.query<TenantCredentialIdentityRow>(
          this.database,
          `SELECT tenant_id, account_id, id
             FROM saas_tenant_provider_credentials
            ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
            ORDER BY created_at, id`,
          values,
        );
        references.push(
          ...result.rows.map((row) => ({
            ownerKind: 'tenant' as const,
            tenantId: row.tenant_id,
            accountId: row.account_id,
            credentialId: row.id,
          })),
        );
      } else {
        const result = await this.query<PlatformCredentialIdentityRow>(
          this.database,
          `SELECT account_id, id
             FROM saas_platform_provider_credentials
            ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
            ORDER BY created_at, id`,
          values,
        );
        references.push(
          ...result.rows.map((row) => ({
            ownerKind: 'platform' as const,
            tenantId: null,
            accountId: row.account_id,
            credentialId: row.id,
          })),
        );
      }
    }
    return references;
  }

  private async schemaAccountById(id: string): Promise<ProviderAccountReference> {
    const [tenant, platform] = await Promise.all([
      this.query<TenantAccountIdentityRow>(
        this.database,
        'SELECT tenant_id, id FROM saas_tenant_provider_accounts WHERE id = $1',
        [id],
      ),
      this.query<PlatformAccountIdentityRow>(
        this.database,
        'SELECT id FROM saas_platform_provider_accounts WHERE id = $1',
        [id],
      ),
    ]);
    if (tenant.rows.length + platform.rows.length === 0) fail('ACCOUNT_NOT_FOUND');
    if (tenant.rows.length + platform.rows.length !== 1) fail('SUPPLY_STORAGE_ERROR');
    const tenantRow = tenant.rows[0];
    if (tenantRow) return { ownerKind: 'tenant', tenantId: tenantRow.tenant_id, accountId: tenantRow.id };
    const platformRow = platform.rows[0];
    if (!platformRow) fail('SUPPLY_STORAGE_ERROR');
    return { ownerKind: 'platform', tenantId: null, accountId: platformRow.id };
  }

  private async schemaCredentialById(id: string): Promise<ProviderCredentialReference> {
    const [tenant, platform] = await Promise.all([
      this.query<TenantCredentialIdentityRow>(
        this.database,
        'SELECT tenant_id, account_id, id FROM saas_tenant_provider_credentials WHERE id = $1',
        [id],
      ),
      this.query<PlatformCredentialIdentityRow>(
        this.database,
        'SELECT account_id, id FROM saas_platform_provider_credentials WHERE id = $1',
        [id],
      ),
    ]);
    if (tenant.rows.length + platform.rows.length === 0) fail('CREDENTIAL_NOT_FOUND');
    if (tenant.rows.length + platform.rows.length !== 1) fail('SUPPLY_STORAGE_ERROR');
    const tenantRow = tenant.rows[0];
    if (tenantRow) {
      return {
        ownerKind: 'tenant',
        tenantId: tenantRow.tenant_id,
        accountId: tenantRow.account_id,
        credentialId: tenantRow.id,
      };
    }
    const platformRow = platform.rows[0];
    if (!platformRow) fail('SUPPLY_STORAGE_ERROR');
    return {
      ownerKind: 'platform',
      tenantId: null,
      accountId: platformRow.account_id,
      credentialId: platformRow.id,
    };
  }

  private async sqlTransaction<T>(
    work: (executor: SqlExecutor) => Promise<T>,
    duplicateCode: ProviderSupplyErrorCode = 'SUPPLY_STORAGE_ERROR',
  ): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      throw mapFailure(error, 'SUPPLY_STORAGE_ERROR', duplicateCode);
    }
  }

  private async resolveAccountReference(value: string | ProviderAccountReference): Promise<ProviderAccountReference> {
    if (typeof value !== 'string') return normalizeAccountReference(value);
    const id = identifier(value);
    if (!this.hasInjectedRepository) return this.sqlRead(() => this.schemaAccountById(id));
    const records = await this.repositoryRun(() => this.repository.listAccounts(), 'SUPPLY_STORAGE_ERROR');
    const matches = records.filter((record) => record.id === id);
    if (matches.length === 0) fail('ACCOUNT_NOT_FOUND');
    if (matches.length !== 1) fail('SUPPLY_STORAGE_ERROR');
    return accountReference(matches[0]);
  }

  private async resolveCredentialReference(
    value: string | ProviderCredentialReference,
  ): Promise<ProviderCredentialReference> {
    if (typeof value !== 'string') return normalizeCredentialReference(value);
    const id = identifier(value);
    if (!this.hasInjectedRepository) return this.sqlRead(() => this.schemaCredentialById(id));
    const records = await this.repositoryRun(() => this.repository.listCredentials(), 'SUPPLY_STORAGE_ERROR');
    const matches = records.filter((record) => record.id === id);
    if (matches.length === 0) fail('CREDENTIAL_NOT_FOUND');
    if (matches.length !== 1) fail('SUPPLY_STORAGE_ERROR');
    return credentialReference(matches[0]);
  }

  private async account(reference: ProviderAccountReference): Promise<ProviderAccountRecord> {
    return this.repositoryRun(async () => {
      const result = await this.repository.getAccount(reference);
      if (!result) fail('ACCOUNT_NOT_FOUND');
      return result;
    });
  }

  private async credential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord> {
    return this.repositoryRun(async () => {
      const result = await this.repository.getCredential(reference);
      if (!result) fail('CREDENTIAL_NOT_FOUND');
      return result;
    });
  }

  async createTenantByokCredential(input: CreateTenantByokCredentialInput): Promise<CreatedTenantByokCredential> {
    if (!input) fail('INVALID_INPUT');
    return this.persistence.createTenantByokCredentialWithAudit(input);
  }

  async createProviderAccount(input: CreateProviderAccountInput): Promise<ProviderAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    const requestedStatus = input.status ?? 'pending';
    const requestedValidation = input.validationState ?? 'unverified';
    if (requestedStatus === 'active' && requestedValidation !== 'verified') fail('VALIDATION_REQUIRED');

    // The repository intentionally writes only insert-safe defaults. Apply
    // lifecycle/failed-validation state through its CAS update operations so
    // 015's lifecycle checks and authz epochs remain valid.
    const needsFollowUp =
      requestedStatus === 'disabled' || requestedStatus === 'revoked' || requestedValidation === 'failed';
    const initialInput = needsFollowUp
      ? ({ ...input, status: 'pending', validationState: 'unverified' } satisfies CreateProviderAccountInput)
      : input;
    let account = await this.persistence.createProviderAccount(initialInput);
    const reference = accountReference(account);
    if (requestedValidation === 'failed') {
      account = await this.updateAccountValidationReference(
        reference,
        'failed',
        'initial_validation_failed',
        account.authzVersion,
      );
    }
    if (requestedStatus === 'disabled' || requestedStatus === 'revoked') {
      account = await this.transitionAccountReference(reference, requestedStatus, account.authzVersion);
    }
    return account;
  }

  async getProviderAccount(accountId: string): Promise<ProviderAccountRecord>;
  async getProviderAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord>;
  async getProviderAccount(value: string | ProviderAccountReference): Promise<ProviderAccountRecord> {
    return this.persistence.getProviderAccount(await this.resolveAccountReference(value));
  }

  async listProviderAccounts(filter: ProviderAccountListFilter = {}): Promise<readonly ProviderAccountRecord[]> {
    if (!this.hasInjectedRepository) {
      const references = await this.sqlRead(() => this.schemaAccountReferences(filter));
      return Promise.all(references.map((reference) => this.account(reference)));
    }
    return this.persistence.listProviderAccounts(filter);
  }

  async listPlatformProviderAccounts(): Promise<readonly ProviderAccountRecord[]> {
    return this.listProviderAccounts({ ownerKind: 'platform' });
  }

  async createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    return this.persistence.createProviderAccountWithAudit(
      {
        ownerKind: 'platform',
        ...(input.id === undefined ? {} : { id: input.id }),
        displayName: input.displayName,
        providerId: input.providerId,
        productId: input.productId,
        credentialType: input.credentialType,
        region: input.region,
        purpose: input.purpose,
        rightsId: input.rightsId,
        rightsVersion: input.rightsVersion,
        capabilities: input.capabilities,
        status: 'pending',
        validationState: 'unverified',
      },
      normalizeAuditContext(input.audit),
    );
  }

  async disablePlatformProviderAccount(input: PlatformProviderAccountLifecycleInput): Promise<ProviderAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    return this.transitionAccountReference(
      { ownerKind: 'platform', tenantId: null, accountId: identifier(input.accountId) },
      'disabled',
      positiveInteger(input.expectedAuthzVersion),
      normalizeAuditContext(input.audit),
    );
  }

  async revokePlatformProviderAccount(input: PlatformProviderAccountLifecycleInput): Promise<ProviderAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    return this.transitionAccountReference(
      { ownerKind: 'platform', tenantId: null, accountId: identifier(input.accountId) },
      'revoked',
      positiveInteger(input.expectedAuthzVersion),
      normalizeAuditContext(input.audit),
    );
  }

  async enablePlatformProviderAccount(input: PlatformProviderAccountLifecycleInput): Promise<ProviderAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    return this.transitionAccountReference(
      { ownerKind: 'platform', tenantId: null, accountId: identifier(input.accountId) },
      'active',
      positiveInteger(input.expectedAuthzVersion),
      normalizeAuditContext(input.audit),
    );
  }

  private async updateAccountValidationReference(
    reference: ProviderAccountReference,
    state: ProviderValidationState,
    validationErrorCode: string | null,
    expectedAuthzVersion?: number,
  ): Promise<ProviderAccountRecord> {
    if (state === 'failed') text(validationErrorCode ?? 'validation_failed');
    const normalizedReference = normalizeAccountReference(reference);
    const now = currentDate(this.now).toISOString();
    return this.repositoryRun(
      () =>
        this.repository.transaction(async (repository, executor) => {
          if (executor) await lockAdvisoryLayers(executor, providerAccountLockLayers([normalizedReference]), 'exclusive');
          const current = await repository.getAccount(normalizedReference);
          if (!current) fail('ACCOUNT_NOT_FOUND');
          const expected = expectedAuthzVersion ?? current.authzVersion;
          if (expected !== current.authzVersion) fail('ACCOUNT_STATE_CONFLICT');
          if (current.status === 'revoked') fail('ACCOUNT_REVOKED');
          const updated = await repository.updateAccountValidation({
            account: normalizedReference,
            validationState: state,
            validationErrorCode: state === 'failed' ? (validationErrorCode ?? 'validation_failed') : null,
            lastValidatedAt: now,
            expectedAuthzVersion: expected,
            updatedAt: now,
          });
          if (!updated) fail('ACCOUNT_STATE_CONFLICT');
          const nextStatus =
            state === 'failed' && current.status === 'active'
              ? 'disabled'
              : current.status === 'pending' && state === 'verified'
                ? 'active'
                : current.status;
          if (nextStatus === current.status) return updated;
          const lifecycle = await repository.updateAccountLifecycle({
            account: normalizedReference,
            status: nextStatus,
            expectedAuthzVersion: updated.authzVersion,
            updatedAt: now,
            ...statusTimestamp(nextStatus, now),
          });
          if (!lifecycle) fail('ACCOUNT_STATE_CONFLICT');
          return lifecycle;
        }),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async setProviderAccountValidation(input: ProviderAccountValidationInput): Promise<ProviderAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    const reference = await this.resolveAccountReference(input.accountId);
    return this.updateAccountValidationReference(
      reference,
      input.validationState,
      input.validationErrorCode ?? null,
      input.expectedAuthzVersion,
    );
  }

  private async transitionAccountReference(
    reference: ProviderAccountReference,
    next: 'active' | 'disabled' | 'revoked',
    expectedAuthzVersion?: number,
    audit?: ProviderSupplyAuditContext,
  ): Promise<ProviderAccountRecord> {
    const normalizedReference = normalizeAccountReference(reference);
    const now = currentDate(this.now).toISOString();
    return this.repositoryRun(
      () =>
        this.repository.transaction(async (repository, executor) => {
          if (executor) await lockAdvisoryLayers(executor, providerAccountLockLayers([normalizedReference]), 'exclusive');
          if (audit !== undefined && typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
          const current = await repository.getAccount(normalizedReference);
          if (!current) fail('ACCOUNT_NOT_FOUND');
          const expected = expectedAuthzVersion ?? current.authzVersion;
          if (expected !== current.authzVersion) fail('ACCOUNT_STATE_CONFLICT');
          if (current.status === 'revoked') fail('ACCOUNT_REVOKED');
          if (next === 'active' && current.validationState !== 'verified') fail('VALIDATION_REQUIRED');
          if (next === current.status) fail('INVALID_ACCOUNT_LIFECYCLE');
          const updated = await repository.updateAccountLifecycle({
            account: normalizedReference,
            status: next,
            expectedAuthzVersion: expected,
            updatedAt: now,
            ...statusTimestamp(next, now),
          });
          if (!updated) fail('ACCOUNT_STATE_CONFLICT');

          if (next === 'disabled' || next === 'revoked') {
            const credentials = await repository.listCredentials({ account: normalizedReference });
            if (executor) {
              await lockAdvisoryLayers(
                executor,
                [
                  sortAndDedupeAdvisoryKeys(
                    credentials.map((credential) => providerCredentialAdvisoryKey(credentialReference(credential))),
                  ),
                ],
                'exclusive',
              );
            }
            for (const credential of credentials) {
              if (credential.status === 'revoked' || (next === 'disabled' && credential.status === 'disabled'))
                continue;
              const credentialUpdated = await repository.updateCredentialLifecycle({
                credential: credentialReference(credential),
                status: next,
                expectedAuthzVersion: credential.authzVersion,
                updatedAt: now,
                ...statusTimestamp(next, now),
              });
              if (!credentialUpdated) fail('CREDENTIAL_STATE_CONFLICT');
            }
          }
          if (audit !== undefined) {
            await this.auditSupplyMutation(
              repository,
              current.tenantId,
              `provider_supply.account.${next}`,
              'saas_provider_account',
              current.id,
              audit,
              now,
            );
          }
          return updated;
        }),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async disableProviderAccount(input: ProviderAccountStateChangeInput | string): Promise<ProviderAccountRecord> {
    const reference = await this.resolveAccountReference(typeof input === 'string' ? input : input.accountId);
    return this.transitionAccountReference(
      reference,
      'disabled',
      typeof input === 'string' ? undefined : input.expectedAuthzVersion,
    );
  }

  async revokeProviderAccount(input: ProviderAccountStateChangeInput | string): Promise<ProviderAccountRecord> {
    const reference = await this.resolveAccountReference(typeof input === 'string' ? input : input.accountId);
    return this.transitionAccountReference(
      reference,
      'revoked',
      typeof input === 'string' ? undefined : input.expectedAuthzVersion,
    );
  }

  async enableProviderAccount(input: ProviderAccountStateChangeInput | string): Promise<ProviderAccountRecord> {
    const reference = await this.resolveAccountReference(typeof input === 'string' ? input : input.accountId);
    return this.transitionAccountReference(
      reference,
      'active',
      typeof input === 'string' ? undefined : input.expectedAuthzVersion,
    );
  }

  async createProviderCredential(input: CreateProviderCredentialInput): Promise<ProviderCredentialWriteResult> {
    return this.persistence.createProviderCredential(input);
  }

  async getProviderCredential(credentialId: string): Promise<ProviderCredentialRecord>;
  async getProviderCredential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord>;
  async getProviderCredential(value: string | ProviderCredentialReference): Promise<ProviderCredentialRecord> {
    return this.persistence.getProviderCredential(await this.resolveCredentialReference(value));
  }

  async listProviderCredentials(
    filter: ProviderCredentialListFilter = {},
  ): Promise<readonly ProviderCredentialRecord[]> {
    if (!this.hasInjectedRepository) {
      const references = await this.sqlRead(() => this.schemaCredentialReferences(filter));
      return Promise.all(references.map((reference) => this.credential(reference)));
    }
    return this.persistence.listProviderCredentials(filter);
  }

  private async resolvePlatformCredentialReference(credentialId: string): Promise<ProviderCredentialReference> {
    const id = identifier(credentialId);
    const records = await this.listProviderCredentials({ ownerKind: 'platform' });
    const matches = records.filter((record) => record.id === id);
    if (matches.length === 0) fail('CREDENTIAL_NOT_FOUND');
    if (matches.length !== 1) fail('SUPPLY_STORAGE_ERROR');
    const record = matches[0];
    if (record?.ownerKind !== 'platform' || record?.tenantId !== null) fail('SUPPLY_STORAGE_ERROR');
    return credentialReference(record);
  }

  async listPlatformProviderCredentials(accountId: string): Promise<readonly ProviderCredentialRecord[]> {
    const reference: ProviderAccountReference = {
      ownerKind: 'platform',
      tenantId: null,
      accountId: identifier(accountId),
    };
    await this.persistence.getProviderAccount(reference);
    return this.persistence.listProviderCredentials({ account: reference });
  }

  async createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult> {
    if (!input) fail('INVALID_INPUT');
    const account: ProviderAccountReference = {
      ownerKind: 'platform',
      tenantId: null,
      accountId: identifier(input.accountId),
    };
    return this.persistence.createProviderCredentialWithAudit(
      {
        account,
        ...(input.id === undefined ? {} : { id: input.id }),
        secret: input.secret,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
      normalizeAuditContext(input.audit),
    );
  }

  async replacePlatformProviderCredentialSecret(
    input: PlatformProviderCredentialSecretRotationInput,
  ): Promise<ProviderCredentialWriteResult> {
    if (!input) fail('INVALID_INPUT');
    const credential = await this.resolvePlatformCredentialReference(input.credentialId);
    return this.persistence.replaceProviderCredentialSecretWithAudit(
      {
        credential,
        expectedVersion: positiveInteger(input.expectedVersion),
        secret: input.secret,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
      normalizeAuditContext(input.audit),
    );
  }

  async disablePlatformProviderCredential(
    input: PlatformProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord> {
    if (!input) fail('INVALID_INPUT');
    const credential = await this.resolvePlatformCredentialReference(input.credentialId);
    return this.transitionCredentialReference(
      credential,
      'disabled',
      positiveInteger(input.expectedAuthzVersion),
      normalizeAuditContext(input.audit),
    );
  }

  async revokePlatformProviderCredential(
    input: PlatformProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord> {
    if (!input) fail('INVALID_INPUT');
    const credential = await this.resolvePlatformCredentialReference(input.credentialId);
    return this.transitionCredentialReference(
      credential,
      'revoked',
      positiveInteger(input.expectedAuthzVersion),
      normalizeAuditContext(input.audit),
    );
  }

  async enablePlatformProviderCredential(
    input: PlatformProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord> {
    if (!input) fail('INVALID_INPUT');
    const credential = await this.resolvePlatformCredentialReference(input.credentialId);
    return this.transitionCredentialReference(
      credential,
      'active',
      positiveInteger(input.expectedAuthzVersion),
      normalizeAuditContext(input.audit),
    );
  }

  async listProviderCredentialVersions(
    reference: ProviderCredentialReference,
  ): Promise<readonly ProviderCredentialVersionRecord[]> {
    return this.persistence.listProviderCredentialVersions(normalizeCredentialReference(reference));
  }

  async getProviderCredentialVersion(credentialId: string, version?: number): Promise<ProviderCredentialVersionRecord>;
  async getProviderCredentialVersion(
    reference: ProviderCredentialReference & { readonly version?: number },
  ): Promise<ProviderCredentialVersionRecord>;
  async getProviderCredentialVersion(
    value: string | (ProviderCredentialReference & { readonly version?: number }),
    version?: number,
  ): Promise<ProviderCredentialVersionRecord> {
    const reference = await this.resolveCredentialReference(value);
    const credential = await this.credential(reference);
    const selected = version ?? (typeof value === 'string' ? undefined : value.version) ?? credential.currentVersion;
    if (selected === null || selected === undefined) fail('CREDENTIAL_VERSION_CONFLICT');
    return this.persistence.getProviderCredentialVersion({ ...reference, version: positiveInteger(selected) });
  }

  private async updateCredentialValidationReference(
    reference: ProviderCredentialReference,
    state: ProviderValidationState,
    validationErrorCode: string | null,
    expectedAuthzVersion?: number,
  ): Promise<ProviderCredentialRecord> {
    if (state === 'failed') text(validationErrorCode ?? 'validation_failed');
    const normalizedReference = normalizeCredentialReference(reference);
    const now = currentDate(this.now).toISOString();
    return this.repositoryRun(
      () =>
        this.repository.transaction(async (repository, executor) => {
          if (executor)
            await lockAdvisoryLayers(executor, providerCredentialLockLayers(normalizedReference), 'exclusive');
          const current = await repository.getCredential(normalizedReference);
          if (!current) fail('CREDENTIAL_NOT_FOUND');
          const expected = expectedAuthzVersion ?? current.authzVersion;
          if (expected !== current.authzVersion) fail('CREDENTIAL_STATE_CONFLICT');
          if (current.status === 'revoked') fail('CREDENTIAL_REVOKED');
          const updated = await repository.updateCredentialValidation({
            credential: normalizedReference,
            validationState: state,
            validationErrorCode: state === 'failed' ? (validationErrorCode ?? 'validation_failed') : null,
            lastValidatedAt: now,
            expectedAuthzVersion: expected,
            updatedAt: now,
          });
          if (!updated) fail('CREDENTIAL_STATE_CONFLICT');
          const nextStatus = state === 'failed' && current.status === 'active' ? 'disabled' : updated.status;
          if (nextStatus === updated.status) return updated;
          const lifecycle = await repository.updateCredentialLifecycle({
            credential: normalizedReference,
            status: nextStatus as 'active' | 'disabled' | 'revoked',
            expectedAuthzVersion: updated.authzVersion,
            updatedAt: now,
            ...statusTimestamp(nextStatus as CredentialLifecycle, now),
          });
          if (!lifecycle) fail('CREDENTIAL_STATE_CONFLICT');
          return lifecycle;
        }),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async setProviderCredentialValidation(input: ProviderCredentialValidationInput): Promise<ProviderCredentialRecord> {
    if (!input) fail('INVALID_INPUT');
    const reference = await this.resolveCredentialReference(input.credentialId);
    return this.updateCredentialValidationReference(
      reference,
      input.validationState,
      input.validationErrorCode ?? null,
      input.expectedAuthzVersion,
    );
  }

  private async transitionCredentialReference(
    reference: ProviderCredentialReference,
    next: 'active' | 'disabled' | 'revoked',
    expectedAuthzVersion?: number,
    audit?: ProviderSupplyAuditContext,
    context?: TenantContext,
  ): Promise<ProviderCredentialRecord> {
    const normalizedReference = normalizeCredentialReference(reference);
    const now = currentDate(this.now).toISOString();
    return this.repositoryRun(
      () =>
        this.repository.transaction(async (repository, executor) => {
          if (executor)
            await lockAdvisoryLayers(executor, providerCredentialLockLayers(normalizedReference), 'exclusive');
          if (audit !== undefined && typeof repository.appendAuditEvent !== 'function') fail('SUPPLY_STORAGE_ERROR');
          const current = await repository.getCredential(normalizedReference);
          if (!current) fail('CREDENTIAL_NOT_FOUND');
          if (context !== undefined) {
            if (
              (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') ||
              current.ownerKind !== 'tenant' ||
              current.tenantId !== context.tenantId ||
              current.supplyMode !== 'byok'
            ) {
              fail('CREDENTIAL_UNAVAILABLE');
            }
            const account = await repository.getAccount({
              ownerKind: current.ownerKind,
              tenantId: current.tenantId,
              accountId: current.accountId,
            });
            if (
              account?.ownerKind !== 'tenant' ||
              account.tenantId !== context.tenantId ||
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
          }
          const expected = expectedAuthzVersion ?? current.authzVersion;
          if (expected !== current.authzVersion) fail('CREDENTIAL_STATE_CONFLICT');
          if (current.status === 'revoked') fail('CREDENTIAL_REVOKED');
          if (next === 'active' && current.validationState !== 'verified') fail('VALIDATION_REQUIRED');
          if (next === current.status) fail('INVALID_CREDENTIAL_LIFECYCLE');
          const updated = await repository.updateCredentialLifecycle({
            credential: normalizedReference,
            status: next,
            expectedAuthzVersion: expected,
            updatedAt: now,
            ...statusTimestamp(next, now),
          });
          if (!updated) fail('CREDENTIAL_STATE_CONFLICT');
          if (audit !== undefined) {
            await this.auditSupplyMutation(
              repository,
              current.tenantId,
              `provider_supply.credential.${next}`,
              'saas_provider_credential',
              current.id,
              audit,
              now,
            );
          }
          return updated;
        }),
      'SUPPLY_STORAGE_ERROR',
    );
  }

  async disableProviderCredential(
    input: ProviderCredentialStateChangeInput | string,
  ): Promise<ProviderCredentialRecord> {
    const reference = await this.resolveCredentialReference(typeof input === 'string' ? input : input.credentialId);
    return this.transitionCredentialReference(
      reference,
      'disabled',
      typeof input === 'string' ? undefined : input.expectedAuthzVersion,
    );
  }

  async revokeProviderCredential(
    input: ProviderCredentialStateChangeInput | string,
  ): Promise<ProviderCredentialRecord> {
    const reference = await this.resolveCredentialReference(typeof input === 'string' ? input : input.credentialId);
    return this.transitionCredentialReference(
      reference,
      'revoked',
      typeof input === 'string' ? undefined : input.expectedAuthzVersion,
    );
  }

  async enableProviderCredential(
    input: ProviderCredentialStateChangeInput | string,
  ): Promise<ProviderCredentialRecord> {
    const reference = await this.resolveCredentialReference(typeof input === 'string' ? input : input.credentialId);
    return this.transitionCredentialReference(
      reference,
      'active',
      typeof input === 'string' ? undefined : input.expectedAuthzVersion,
    );
  }

  async replaceProviderCredentialSecret(
    input: ReplaceProviderCredentialSecretInput,
  ): Promise<ProviderCredentialWriteResult> {
    if (!input) fail('INVALID_INPUT');
    const reference = await this.resolveCredentialReference(input.credential);
    const current = await this.credential(reference);
    const expectedVersion = input.expectedVersion === null ? current.currentVersion : input.expectedVersion;
    if (expectedVersion === null) fail('CREDENTIAL_VERSION_CONFLICT');
    return this.persistence.replaceProviderCredentialSecret({
      ...input,
      credential: reference,
      expectedVersion,
    });
  }

  async replaceTenantProviderCredentialSecret(
    input: ReplaceTenantProviderCredentialSecretInput,
  ): Promise<ProviderCredentialWriteResult> {
    if (!input?.context) fail('INVALID_INPUT');
    const reference = normalizeCredentialReference(input.credential);
    if (
      reference.ownerKind !== 'tenant' ||
      reference.tenantId !== identifier(input.context.tenantId) ||
      (input.context.tenantRole !== 'owner' && input.context.tenantRole !== 'admin')
    ) {
      fail('CREDENTIAL_UNAVAILABLE');
    }
    const audit = normalizeAuditContext(input.audit);
    if (audit.actorUserId !== identifier(input.context.userId)) fail('INVALID_INPUT');
    return this.persistence.replaceProviderCredentialSecretWithAudit(
      {
        credential: reference,
        expectedVersion: positiveInteger(input.expectedVersion),
        secret: input.secret,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
      audit,
      input.context,
    );
  }

  private transitionTenantProviderCredential(
    input: TenantProviderCredentialLifecycleInput,
    next: 'active' | 'disabled' | 'revoked',
  ): Promise<ProviderCredentialRecord> {
    if (!input?.context) fail('INVALID_INPUT');
    const reference = normalizeCredentialReference(input.credential);
    if (
      reference.ownerKind !== 'tenant' ||
      reference.tenantId !== identifier(input.context.tenantId) ||
      (input.context.tenantRole !== 'owner' && input.context.tenantRole !== 'admin')
    ) {
      fail('CREDENTIAL_UNAVAILABLE');
    }
    const audit = normalizeAuditContext(input.audit);
    if (audit.actorUserId !== identifier(input.context.userId)) fail('INVALID_INPUT');
    return this.transitionCredentialReference(
      reference,
      next,
      positiveInteger(input.expectedAuthzVersion),
      audit,
      input.context,
    );
  }

  async disableTenantProviderCredential(
    input: TenantProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord> {
    return this.transitionTenantProviderCredential(input, 'disabled');
  }

  async enableTenantProviderCredential(
    input: TenantProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord> {
    return this.transitionTenantProviderCredential(input, 'active');
  }

  async revokeTenantProviderCredential(
    input: TenantProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord> {
    return this.transitionTenantProviderCredential(input, 'revoked');
  }

  /** Credential access revalidates a database-owned prepared dispatch proof before KMS unseal. */
  async withProviderCredential<T>(
    grant: ProviderCredentialAccessGrant,
    callback: (secret: Buffer) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.access === undefined) fail('KMS_UNSEAL_FAILED');
    return this.access.withCredential(grant, callback);
  }

  /** Rewrap the wrapped DEK remotely and append a CAS-protected wrapper revision. */
  async rewrapProviderCredential(input: RewrapProviderCredentialInput): Promise<ProviderCredentialVersionRecord> {
    if (!input) fail('INVALID_INPUT');
    if (!this.rewrappingKms) fail('KMS_REWRAP_FAILED');
    const reference = await this.resolveCredentialReference(input.credential);
    const version = positiveInteger(input.version);
    const expectedRevision = positiveInteger(input.expectedWrappingRevision);
    const destinationKmsKeyId = text(input.destinationKmsKeyId, 'INVALID_INPUT', 512).trim();
    const operationId = text(input.operationId, 'INVALID_INPUT', 256).trim();
    const reasonCode = identifier(input.reasonCode);
    const audit = input.audit;
    if (!audit || (audit.actorKind !== 'user' && audit.actorKind !== 'workload')) fail('INVALID_INPUT');
    const requestId = text(audit.requestId, 'INVALID_INPUT', 256).trim();
    let normalizedAudit: ProviderSupplyAuditContext | undefined;
    let normalizedRewrapAudit: ProviderCredentialRewrapAuditContext;
    if (audit.actorKind === 'user') {
      normalizedAudit = normalizeAuditContext({
        actorUserId: audit.actorUserId,
        entryPoint: audit.entryPoint,
        requestId,
        sourceIp: audit.sourceIp,
        userAgent: audit.userAgent,
      });
      normalizedRewrapAudit = {
        actorKind: 'user',
        actorUserId: normalizedAudit.actorUserId,
        entryPoint: normalizedAudit.entryPoint,
        requestId,
        sourceIp: normalizedAudit.sourceIp,
        userAgent: normalizedAudit.userAgent,
      };
    } else {
      normalizedRewrapAudit = {
        actorKind: 'workload',
        actorWorkloadId: text(audit.actorWorkloadId, 'INVALID_INPUT', 256).trim(),
        requestId,
      };
    }
    if (audit.actorKind === 'user' && !this.repository.appendAuditEvent) fail('SUPPLY_STORAGE_ERROR');
    const getWrapperRevisionByOperation = this.repository.getCredentialWrapperRevisionByOperation;
    if (!getWrapperRevisionByOperation || !this.repository.appendCredentialWrapperRevision)
      fail('SUPPLY_STORAGE_ERROR');

    const credentialRef = { ...reference, version };
    const loadCryptoBinding = async () =>
      this.repository.transaction(async (repository) => {
        const account = await repository.getAccount({
          ownerKind: reference.ownerKind,
          tenantId: reference.tenantId,
          accountId: reference.accountId,
        });
        const credential = await repository.getCredential(reference);
        const stored = await repository.getCredentialVersionEnvelope(credentialRef);
        if (!credential || !account || !stored) fail('CREDENTIAL_NOT_FOUND');
        if (
          credential.ownerKind !== reference.ownerKind ||
          credential.tenantId !== reference.tenantId ||
          credential.accountId !== reference.accountId ||
          credential.id !== reference.credentialId ||
          account.ownerKind !== reference.ownerKind ||
          account.tenantId !== reference.tenantId ||
          account.id !== reference.accountId ||
          credential.providerId !== account.providerId ||
          credential.productId !== account.productId ||
          credential.credentialType !== account.credentialType ||
          stored.ownerKind !== reference.ownerKind ||
          stored.tenantId !== reference.tenantId ||
          stored.accountId !== reference.accountId ||
          stored.credentialId !== reference.credentialId ||
          stored.version !== version ||
          stored.kmsPurpose !== account.purpose
        ) {
          fail('CREDENTIAL_UNAVAILABLE');
        }
        let context: ProviderCredentialContext;
        if (reference.ownerKind === 'tenant') {
          if (reference.tenantId === null) fail('CREDENTIAL_UNAVAILABLE');
          context = createProviderCredentialContext({
            ownerKind: 'tenant',
            tenantId: reference.tenantId,
            supplyMode: 'byok',
            deployment: this.deployment,
            environment: this.environment,
            purpose: stored.kmsPurpose,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            accountId: account.id,
            credentialId: credential.id,
            credentialVersion: version,
          });
        } else {
          if (reference.tenantId !== null) fail('CREDENTIAL_UNAVAILABLE');
          context = createProviderCredentialContext({
            ownerKind: 'platform',
            supplyMode: 'platform',
            deployment: this.deployment,
            environment: this.environment,
            purpose: stored.kmsPurpose,
            providerId: account.providerId,
            productId: account.productId,
            credentialType: account.credentialType,
            accountId: account.id,
            credentialId: credential.id,
            credentialVersion: version,
          });
        }
        const canonicalKmsContext = createProviderCredentialEncryptionContext(context);
        const contextSha256 = createHash('sha256').update(JSON.stringify(canonicalKmsContext), 'utf8').digest('hex');
        return { stored, context, contextSha256 };
      });

    const assertSameOperation = (record: ProviderCredentialWrapperRevisionRecord, contextSha256: string) => {
      if (
        !record ||
        record.expectedWrappingRevision !== expectedRevision ||
        record.kmsKeyId !== destinationKmsKeyId ||
        record.contextSha256 !== contextSha256 ||
        record.actorKind !== normalizedRewrapAudit.actorKind ||
        record.actorUserId !==
          (normalizedRewrapAudit.actorKind === 'user' ? normalizedRewrapAudit.actorUserId : null) ||
        record.actorWorkloadId !==
          (normalizedRewrapAudit.actorKind === 'workload' ? normalizedRewrapAudit.actorWorkloadId : null) ||
        record.requestId !== requestId ||
        record.reasonCode !== reasonCode
      ) {
        fail('CREDENTIAL_VERSION_CONFLICT');
      }
      return record;
    };

    const existing = await this.repositoryRun(
      () => getWrapperRevisionByOperation.call(this.repository, credentialRef, operationId),
      'SUPPLY_STORAGE_ERROR',
    );
    if (existing) {
      const binding = await this.repositoryRun(loadCryptoBinding, 'SUPPLY_STORAGE_ERROR');
      assertSameOperation(existing, binding.contextSha256);
      return binding.stored;
    }

    const { stored, context, contextSha256 } = await this.repositoryRun(loadCryptoBinding, 'SUPPLY_STORAGE_ERROR');
    if (stored.wrappingRevision !== expectedRevision) fail('CREDENTIAL_VERSION_CONFLICT');
    if (stored.kmsKeyId === destinationKmsKeyId) fail('INVALID_INPUT');

    let candidate: Awaited<ReturnType<typeof rewrapProviderCredentialEnvelope>>;
    try {
      candidate = await rewrapProviderCredentialEnvelope(
        stored.envelope,
        context,
        destinationKmsKeyId,
        this.rewrappingKms,
      );
    } catch {
      fail('KMS_REWRAP_FAILED');
    }

    const createdAt = currentDate(this.now).toISOString();
    const persisted = await this.repositoryRun(
      () =>
        this.repository.transaction(async (repository) => {
          const append = repository.appendCredentialWrapperRevision;
          if (!append) fail('SUPPLY_STORAGE_ERROR');
          const result = await append.call(repository, {
            credential: credentialRef,
            expectedWrappingRevision: expectedRevision,
            sourceKmsKeyId: stored.kmsKeyId,
            kmsKeyId: candidate.kmsKeyId,
            wrappedDek: candidate.wrappedDek,
            contextSha256,
            operationId,
            audit: normalizedRewrapAudit,
            reasonCode,
            createdAt,
          });
          assertSameOperation(result.revision, contextSha256);
          if (result.inserted && normalizedAudit) {
            const appendAudit = repository.appendAuditEvent;
            if (!appendAudit) fail('SUPPLY_STORAGE_ERROR');
            await appendAudit.call(repository, {
              tenantId: reference.tenantId,
              action: 'saas_provider_credential.rewrapped',
              targetType: 'saas_provider_credential',
              targetId: reference.credentialId,
              occurredAt: createdAt,
              audit: normalizedAudit,
            });
          }
          return result.revision;
        }),
      'SUPPLY_STORAGE_ERROR',
      'CREDENTIAL_VERSION_CONFLICT',
    );
    return { ...stored, wrappingRevision: persisted.wrappingRevision };
  }

  private normalizePoolInput(input: CreatePlatformProviderPoolInput): {
    readonly id: string;
    readonly displayName: string;
    readonly providerId: string;
    readonly productId: string;
    readonly credentialType: string;
    readonly region: string;
    readonly purpose: string;
    readonly rightsId: string;
    readonly rightsVersion: number;
    readonly capabilities: readonly { readonly model: string; readonly endpoint: string; readonly version: number }[];
    readonly status: ProviderPoolRecord['status'];
    readonly validationState: ProviderValidationState;
  } {
    if (!input) fail('INVALID_INPUT');
    const status = input.status ?? 'pending';
    const validation = input.validationState ?? 'unverified';
    if (status === 'active' && validation !== 'verified') fail('VALIDATION_REQUIRED');
    if (!['pending', 'active', 'disabled', 'revoked'].includes(status)) fail('INVALID_INPUT');
    if (!['unverified', 'verified', 'failed'].includes(validation)) fail('INVALID_INPUT');
    return {
      id: input.id === undefined ? randomUUID() : identifier(input.id),
      displayName: text(input.displayName, 'INVALID_INPUT', 512).trim(),
      providerId: identifier(input.providerId),
      productId: identifier(input.productId),
      credentialType: identifier(input.credentialType),
      region: identifier(input.region),
      purpose: identifier(input.purpose),
      rightsId: identifier(input.rightsId),
      rightsVersion: positiveInteger(input.rightsVersion),
      capabilities: capabilities(input.capabilities),
      status,
      validationState: validation,
    };
  }

  async createPlatformProviderPool(input: CreatePlatformProviderPoolInput): Promise<ProviderPoolRecord> {
    const normalized = this.normalizePoolInput(input);
    const now = currentDate(this.now).toISOString();
    const validationErrorCode = normalized.validationState === 'failed' ? 'initial_validation_failed' : null;
    const result = await this.sqlTransaction(async (tx) => {
      await this.lockPlatformPoolForWrite(tx, normalized.id);
      return this.query<PoolRow>(
        tx,
        `INSERT INTO saas_platform_provider_pools
             (id, owner_kind, supply_mode, display_name, provider_id, product_id, credential_type,
              region, purpose, rights_id, rights_version, status, validation_state,
              validation_error_code, last_validated_at, authz_version, created_at, updated_at,
              disabled_at, revoked_at)
           VALUES ($1, 'platform', 'platform', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, 1, $14, $14, $15, $16)
           RETURNING ${POOL_COLUMNS}`,
        [
          normalized.id,
          normalized.displayName,
          normalized.providerId,
          normalized.productId,
          normalized.credentialType,
          normalized.region,
          normalized.purpose,
          normalized.rightsId,
          normalized.rightsVersion,
          normalized.status,
          normalized.validationState,
          validationErrorCode,
          normalized.validationState === 'unverified' ? null : now,
          now,
          normalized.status === 'disabled' ? now : null,
          normalized.status === 'revoked' ? now : null,
        ],
      );
    }, 'ACCOUNT_EXISTS');
    const row = result.rows[0];
    if (!row) fail('SUPPLY_STORAGE_ERROR');
    return mapPool(row, normalized.capabilities);
  }

  async addPlatformPoolMember(input: AddPlatformPoolMemberInput): Promise<void> {
    if (!input) fail('INVALID_INPUT');
    const poolId = identifier(input.poolId);
    const accountReference = await this.resolveAccountReference(input.accountId);
    const now = currentDate(this.now).toISOString();
    await this.sqlTransaction(async (tx) => {
      if (accountReference.ownerKind !== 'platform') fail('INVALID_INPUT');
      await this.lockPlatformPoolForWrite(tx, poolId);
      await this.lockProviderAccounts(tx, [accountReference], 'exclusive');
      const account = await this.selectPlatformSupplyAccount(tx, accountReference.accountId, true);
      if (
        input.expectedAccountAuthzVersion !== undefined &&
        positiveInteger(input.expectedAccountAuthzVersion) !== positiveInteger(account.authz_version)
      ) {
        fail('ACCOUNT_STATE_CONFLICT');
      }
      const result = await this.query<PoolRow>(
        tx,
        `SELECT ${POOL_COLUMNS}
             FROM saas_platform_provider_pools
            WHERE id = $1
            LIMIT 1
            FOR UPDATE`,
        [poolId],
      );
      const pool = result.rows[0];
      if (!pool) fail('ACCOUNT_NOT_FOUND');
      if (
        pool.provider_id !== account.provider_id ||
        pool.product_id !== account.product_id ||
        pool.credential_type !== account.credential_type ||
        pool.region !== account.region ||
        pool.purpose !== account.purpose
      ) {
        fail('INVALID_INPUT');
      }
      await this.query(
        tx,
        `INSERT INTO saas_platform_provider_pool_members
             (pool_id, account_id, provider_id, product_id, account_authz_version,
              authz_version, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, 'active', $6, $6)`,
        [poolId, account.id, account.provider_id, account.product_id, account.authz_version, now],
      );
    }, 'ACCOUNT_EXISTS');
  }

  private async selectPlatformSupplyAccount(
    tx: SqlExecutor,
    accountId: string,
    forUpdate = true,
  ): Promise<PlatformSupplyAccountRow> {
    const result = await this.query<PlatformSupplyAccountRow>(
      tx,
      `SELECT id, provider_id, product_id, credential_type, region, purpose,
              status, validation_state, authz_version
         FROM saas_platform_provider_accounts
        WHERE id = $1
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [accountId],
    );
    const row = result.rows[0];
    if (!row) fail('ACCOUNT_NOT_FOUND');
    if (row.status !== 'active' || row.validation_state !== 'verified') fail('CREDENTIAL_UNAVAILABLE');
    return row;
  }

  private async selectTenantSupplyAccount(
    tx: SqlExecutor,
    tenantId: string,
    accountId: string,
    forUpdate = true,
  ): Promise<TenantSupplyAccountRow> {
    const result = await this.query<TenantSupplyAccountRow>(
      tx,
      `SELECT tenant_id, id, provider_id, product_id, credential_type, region, purpose,
              status, validation_state, authz_version
         FROM saas_tenant_provider_accounts
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, accountId],
    );
    const row = result.rows[0];
    if (!row) fail('ACCOUNT_NOT_FOUND');
    if (row.status !== 'active' || row.validation_state !== 'verified') fail('CREDENTIAL_UNAVAILABLE');
    return row;
  }

  private async selectPoolMember(
    tx: SqlExecutor,
    poolId: string,
    accountId: string,
    forUpdate = true,
  ): Promise<PoolMemberRow> {
    const result = await this.query<PoolMemberRow>(
      tx,
      `SELECT ${POOL_MEMBER_COLUMNS}
         FROM saas_platform_provider_pool_members
        WHERE pool_id = $1 AND account_id = $2
        LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [poolId, accountId],
    );
    const row = result.rows[0];
    if (!row) fail('ACCOUNT_NOT_FOUND');
    return row;
  }

  private async transitionPlatformPoolMember(
    input: PlatformPoolMemberStateChangeInput,
    next: 'active' | 'disabled' | 'revoked',
  ): Promise<PlatformPoolMemberRecord> {
    if (!input) fail('INVALID_INPUT');
    const poolId = identifier(input.poolId);
    const accountId = identifier(input.accountId);
    const expectedAuthzVersion = positiveInteger(input.expectedAuthzVersion);
    const audit = normalizeAuditContext(input.audit);
    const now = currentDate(this.now).toISOString();
    return this.sqlTransaction(async (tx) => {
      await this.lockPlatformPoolForWrite(tx, poolId);
      await this.lockProviderAccounts(tx, [{ ownerKind: 'platform', tenantId: null, accountId }], 'exclusive');
      await this.query(
        tx,
        `SELECT id
           FROM saas_platform_provider_accounts
          WHERE id = $1
          LIMIT 1
          FOR UPDATE`,
        [accountId],
      );
      const current = await this.selectPoolMember(tx, poolId, accountId);
      const currentVersion = positiveInteger(current.authz_version, 'SUPPLY_STORAGE_ERROR');
      if (currentVersion !== expectedAuthzVersion) fail('ACCOUNT_STATE_CONFLICT');
      if (current.status === 'revoked') fail('ACCOUNT_REVOKED');
      if (current.status === next) fail('INVALID_ACCOUNT_LIFECYCLE');
      const result = await this.query<PoolMemberRow>(
        tx,
        `UPDATE saas_platform_provider_pool_members
            SET status = $1,
                disabled_at = $2,
                revoked_at = $3,
                authz_version = authz_version + 1,
                updated_at = $4
          WHERE pool_id = $5 AND account_id = $6
            AND authz_version = $7
          RETURNING ${POOL_MEMBER_COLUMNS}`,
        [
          next,
          next === 'disabled' ? now : null,
          next === 'revoked' ? now : null,
          now,
          poolId,
          accountId,
          expectedAuthzVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) fail('ACCOUNT_STATE_CONFLICT');
      await this.auditSupplyRelation(tx, null, `provider_pool_member.${next}`, `${poolId}:${accountId}`, audit, now);
      return mapPoolMember(row);
    });
  }

  async disablePlatformPoolMember(input: PlatformPoolMemberStateChangeInput): Promise<PlatformPoolMemberRecord> {
    return this.transitionPlatformPoolMember(input, 'disabled');
  }

  async enablePlatformPoolMember(input: PlatformPoolMemberStateChangeInput): Promise<PlatformPoolMemberRecord> {
    return this.transitionPlatformPoolMember(input, 'active');
  }

  async revokePlatformPoolMember(input: PlatformPoolMemberStateChangeInput): Promise<PlatformPoolMemberRecord> {
    return this.transitionPlatformPoolMember(input, 'revoked');
  }

  async rebindPlatformPoolMember(input: RebindPlatformPoolMemberInput): Promise<PlatformPoolMemberRecord> {
    if (!input) fail('INVALID_INPUT');
    const poolId = identifier(input.poolId);
    const accountId = identifier(input.accountId);
    const newAccountId = identifier(input.newAccountId);
    if (accountId === newAccountId) fail('INVALID_INPUT');
    const expectedAuthzVersion = positiveInteger(input.expectedAuthzVersion);
    const audit = normalizeAuditContext(input.audit);
    const now = currentDate(this.now).toISOString();

    return this.sqlTransaction(async (tx) => {
      await this.lockPlatformPoolForWrite(tx, poolId);
      await this.lockProviderAccounts(
        tx,
        [
          { ownerKind: 'platform', tenantId: null, accountId },
          { ownerKind: 'platform', tenantId: null, accountId: newAccountId },
        ],
        'exclusive',
      );
      const poolResult = await this.query<PoolRow>(
        tx,
        `SELECT ${POOL_COLUMNS}
          FROM saas_platform_provider_pools
          WHERE id = $1
          LIMIT 1
          FOR UPDATE`,
        [poolId],
      );
      const pool = poolResult.rows[0];
      if (!pool) fail('ACCOUNT_NOT_FOUND');
      if (pool.status !== 'active' || pool.validation_state !== 'verified') fail('CREDENTIAL_UNAVAILABLE');

      const newAccount = await this.selectPlatformSupplyAccount(tx, newAccountId, true);
      if (
        pool.provider_id !== newAccount.provider_id ||
        pool.product_id !== newAccount.product_id ||
        pool.credential_type !== newAccount.credential_type ||
        pool.region !== newAccount.region ||
        pool.purpose !== newAccount.purpose
      ) {
        fail('INVALID_INPUT');
      }

      const current = await this.selectPoolMember(tx, poolId, accountId);
      const currentVersion = positiveInteger(current.authz_version, 'SUPPLY_STORAGE_ERROR');
      if (currentVersion !== expectedAuthzVersion) fail('ACCOUNT_STATE_CONFLICT');
      if (current.status === 'revoked') fail('ACCOUNT_REVOKED');

      const existing = await this.query<PoolMemberRow>(
        tx,
        `SELECT ${POOL_MEMBER_COLUMNS}
           FROM saas_platform_provider_pool_members
          WHERE pool_id = $1 AND account_id = $2
          LIMIT 1
          FOR UPDATE`,
        [poolId, newAccount.id],
      );
      if (existing.rows[0]) fail('ACCOUNT_STATE_CONFLICT');

      const revoked = await this.query<PoolMemberRow>(
        tx,
        `UPDATE saas_platform_provider_pool_members
            SET status = 'revoked', revoked_at = $1, disabled_at = NULL,
                authz_version = authz_version + 1, updated_at = $1
          WHERE pool_id = $2 AND account_id = $3
            AND authz_version = $4
          RETURNING ${POOL_MEMBER_COLUMNS}`,
        [now, poolId, accountId, expectedAuthzVersion],
      );
      if (!revoked.rows[0]) fail('ACCOUNT_STATE_CONFLICT');

      const inserted = await this.query<PoolMemberRow>(
        tx,
        `INSERT INTO saas_platform_provider_pool_members
             (pool_id, account_id, provider_id, product_id, account_authz_version,
              authz_version, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, 'active', $6, $6)
           RETURNING ${POOL_MEMBER_COLUMNS}`,
        [poolId, newAccount.id, newAccount.provider_id, newAccount.product_id, newAccount.authz_version, now],
      );
      const row = inserted.rows[0];
      if (!row) fail('SUPPLY_STORAGE_ERROR');
      await this.auditSupplyRelation(
        tx,
        null,
        'provider_pool_member.rebound',
        `${poolId}:${accountId}->${newAccount.id}`,
        audit,
        now,
      );
      return mapPoolMember(row);
    });
  }

  async grantPlatformPoolToProfile(input: GrantPlatformPoolInput): Promise<PlatformPoolGrantRecord> {
    if (!input) fail('INVALID_INPUT');
    const poolId = identifier(input.poolId);
    const tenantId = identifier(input.tenantId);
    const supplyProfileId = identifier(input.supplyProfileId);
    const evidenceReference = text(input.evidenceReference, 'INVALID_INPUT', 512).trim();
    const evidenceSha256 = text(input.evidenceSha256, 'INVALID_INPUT', 64).trim();
    if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('INVALID_INPUT');
    const now = currentDate(this.now);
    const nowText = now.toISOString();
    const expiresAt = timestamp(input.expiresAt, now, true);
    return this.sqlTransaction(async (tx) => {
      await this.lockPlatformPoolForWrite(tx, poolId);
      const poolResult = await this.query<PoolRow>(
        tx,
        `SELECT ${POOL_COLUMNS}
             FROM saas_platform_provider_pools
            WHERE id = $1
            LIMIT 1
            FOR UPDATE`,
        [poolId],
      );
      const pool = poolResult.rows[0];
      if (!pool) fail('ACCOUNT_NOT_FOUND');
      if (pool.status !== 'active' || pool.validation_state !== 'verified') fail('CREDENTIAL_UNAVAILABLE');
      await this.lockSupplyProfileForWrite(tx, tenantId, supplyProfileId);
      const profileResult = await this.query<ProfileRow>(
        tx,
        `SELECT tenant_id, id, supply_mode, status, authz_version
             FROM saas_supply_profiles
            WHERE tenant_id = $1 AND id = $2 AND supply_mode = 'platform'
            LIMIT 1
            FOR UPDATE`,
        [tenantId, supplyProfileId],
      );
      const profile = profileResult.rows[0];
      if (profile?.status !== 'active' || profile.supply_mode !== 'platform') fail('INVALID_INPUT');
      const existing = await this.query<PoolGrantRow>(
        tx,
        `SELECT ${POOL_GRANT_COLUMNS}
           FROM saas_platform_provider_pool_grants
          WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3
          LIMIT 1
          FOR UPDATE`,
        [poolId, tenantId, supplyProfileId],
      );
      if (existing.rows[0]) fail('CREDENTIAL_STATE_CONFLICT');
      const result = await this.query<PoolGrantRow>(
        tx,
        `INSERT INTO saas_platform_provider_pool_grants
             (pool_id, tenant_id, supply_profile_id, supply_mode, profile_authz_version,
              pool_authz_version, status, effective_at, expires_at, authz_version,
              evidence_ref, evidence_sha256, created_at, updated_at)
           VALUES ($1, $2, $3, 'platform', $4, $5, 'active', $6, $7, 1, $8, $9, $6, $6)
           RETURNING ${POOL_GRANT_COLUMNS}`,
        [
          poolId,
          tenantId,
          supplyProfileId,
          positiveInteger(profile.authz_version, 'SUPPLY_STORAGE_ERROR'),
          positiveInteger(pool.authz_version, 'SUPPLY_STORAGE_ERROR'),
          nowText,
          expiresAt,
          evidenceReference,
          evidenceSha256,
        ],
      );
      const row = result.rows[0];
      if (!row) fail('SUPPLY_STORAGE_ERROR');
      return mapPoolGrant(row);
    }, 'ACCOUNT_EXISTS');
  }

  private async selectPoolGrant(
    tx: SqlExecutor,
    poolId: string,
    tenantId: string,
    supplyProfileId: string,
  ): Promise<PoolGrantRow> {
    const result = await this.query<PoolGrantRow>(
      tx,
      `SELECT ${POOL_GRANT_COLUMNS}
         FROM saas_platform_provider_pool_grants
        WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3
        LIMIT 1
        FOR UPDATE`,
      [poolId, tenantId, supplyProfileId],
    );
    const row = result.rows[0];
    if (!row) fail('CREDENTIAL_NOT_FOUND');
    return row;
  }

  private async transitionPlatformPoolGrant(
    input: PlatformPoolGrantStateChangeInput,
    next: 'active' | 'disabled' | 'revoked',
  ): Promise<PlatformPoolGrantRecord> {
    if (!input) fail('INVALID_INPUT');
    const poolId = identifier(input.poolId);
    const tenantId = identifier(input.tenantId);
    const supplyProfileId = identifier(input.supplyProfileId);
    const expectedAuthzVersion = positiveInteger(input.expectedAuthzVersion);
    const audit = input.audit === undefined ? undefined : normalizeAuditContext(input.audit);
    const now = currentDate(this.now).toISOString();
    return this.sqlTransaction(async (tx) => {
      await this.lockPlatformPoolForWrite(tx, poolId);
      await this.lockSupplyProfileForWrite(tx, tenantId, supplyProfileId);
      const current = await this.selectPoolGrant(tx, poolId, tenantId, supplyProfileId);
      const currentVersion = positiveInteger(current.authz_version, 'SUPPLY_STORAGE_ERROR');
      if (currentVersion !== expectedAuthzVersion) fail('CREDENTIAL_STATE_CONFLICT');
      if (current.status === 'revoked') fail('CREDENTIAL_STATE_CONFLICT');
      if (current.status === next) fail('INVALID_CREDENTIAL_LIFECYCLE');
      const result = await this.query<PoolGrantRow>(
        tx,
        `UPDATE saas_platform_provider_pool_grants
            SET status = $1,
                disabled_at = $2,
                revoked_at = $3,
                authz_version = authz_version + 1,
                updated_at = $4
          WHERE pool_id = $5 AND tenant_id = $6 AND supply_profile_id = $7
            AND authz_version = $8
          RETURNING ${POOL_GRANT_COLUMNS}`,
        [
          next,
          next === 'disabled' ? now : null,
          next === 'revoked' ? now : null,
          now,
          poolId,
          tenantId,
          supplyProfileId,
          expectedAuthzVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) fail('CREDENTIAL_STATE_CONFLICT');
      if (audit) {
        await this.auditSupplyRelation(
          tx,
          tenantId,
          `provider_pool_grant.${next}`,
          `${poolId}:${tenantId}:${supplyProfileId}`,
          audit,
          now,
        );
      }
      return mapPoolGrant(row);
    });
  }

  async disablePlatformPoolGrant(input: PlatformPoolGrantStateChangeInput): Promise<PlatformPoolGrantRecord> {
    return this.transitionPlatformPoolGrant(input, 'disabled');
  }

  async enablePlatformPoolGrant(input: PlatformPoolGrantStateChangeInput): Promise<PlatformPoolGrantRecord> {
    return this.transitionPlatformPoolGrant(input, 'active');
  }

  async revokePlatformPoolGrant(input: PlatformPoolGrantStateChangeInput): Promise<PlatformPoolGrantRecord> {
    return this.transitionPlatformPoolGrant(input, 'revoked');
  }

  async rebindPlatformPoolGrant(input: RebindPlatformPoolGrantInput): Promise<PlatformPoolGrantRecord> {
    if (!input) fail('INVALID_INPUT');
    const poolId = identifier(input.poolId);
    const tenantId = identifier(input.tenantId);
    const supplyProfileId = identifier(input.supplyProfileId);
    const nextPoolId = input.newPoolId === undefined ? poolId : identifier(input.newPoolId);
    const nextSupplyProfileId =
      input.newSupplyProfileId === undefined ? supplyProfileId : identifier(input.newSupplyProfileId);
    if (nextPoolId === poolId && nextSupplyProfileId === supplyProfileId) fail('INVALID_INPUT');
    const expectedAuthzVersion = positiveInteger(input.expectedAuthzVersion);
    const audit = input.audit === undefined ? undefined : normalizeAuditContext(input.audit);
    const now = currentDate(this.now);
    const nowText = now.toISOString();

    return this.sqlTransaction(async (tx) => {
      await lockAdvisoryLayers(
        tx,
        [
          [saasAdvisoryKey.platformPool(poolId), saasAdvisoryKey.platformPool(nextPoolId)],
          [
            saasAdvisoryKey.supplyProfile(tenantId, supplyProfileId),
            saasAdvisoryKey.supplyProfile(tenantId, nextSupplyProfileId),
          ],
        ],
        'exclusive',
      );
      const current = await this.selectPoolGrant(tx, poolId, tenantId, supplyProfileId);
      const currentVersion = positiveInteger(current.authz_version, 'SUPPLY_STORAGE_ERROR');
      if (currentVersion !== expectedAuthzVersion) fail('CREDENTIAL_STATE_CONFLICT');
      if (current.status === 'revoked') fail('CREDENTIAL_STATE_CONFLICT');

      const poolResult = await this.query<PoolRow>(
        tx,
        `SELECT ${POOL_COLUMNS}
           FROM saas_platform_provider_pools
          WHERE id = $1
          LIMIT 1
          FOR UPDATE`,
        [nextPoolId],
      );
      const pool = poolResult.rows[0];
      if (!pool) fail('ACCOUNT_NOT_FOUND');
      if (pool.status !== 'active' || pool.validation_state !== 'verified') fail('CREDENTIAL_UNAVAILABLE');

      const profileResult = await this.query<ProfileRow>(
        tx,
        `SELECT tenant_id, id, supply_mode, status, authz_version
           FROM saas_supply_profiles
          WHERE tenant_id = $1 AND id = $2 AND supply_mode = 'platform'
          LIMIT 1
          FOR UPDATE`,
        [tenantId, nextSupplyProfileId],
      );
      const profile = profileResult.rows[0];
      if (profile?.status !== 'active' || profile.supply_mode !== 'platform') fail('INVALID_INPUT');

      const target = await this.query<PoolGrantRow>(
        tx,
        `SELECT ${POOL_GRANT_COLUMNS}
           FROM saas_platform_provider_pool_grants
          WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3
          LIMIT 1
          FOR UPDATE`,
        [nextPoolId, tenantId, nextSupplyProfileId],
      );
      if (target.rows[0]) fail('CREDENTIAL_STATE_CONFLICT');

      const evidenceReference =
        input.evidenceReference === undefined
          ? text(current.evidence_ref, 'SUPPLY_STORAGE_ERROR', 512)
          : text(input.evidenceReference, 'INVALID_INPUT', 512).trim();
      const evidenceSha256 =
        input.evidenceSha256 === undefined
          ? text(current.evidence_sha256, 'SUPPLY_STORAGE_ERROR', 64)
          : text(input.evidenceSha256, 'INVALID_INPUT', 64).trim();
      if ((input.evidenceReference === undefined) !== (input.evidenceSha256 === undefined)) fail('INVALID_INPUT');
      if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('INVALID_INPUT');
      const expiresAt =
        input.expiresAt === undefined
          ? timestamp(current.expires_at, now, true)
          : timestamp(input.expiresAt, now, true);

      const revoked = await this.query<PoolGrantRow>(
        tx,
        `UPDATE saas_platform_provider_pool_grants
            SET status = 'revoked', revoked_at = $1, disabled_at = NULL,
                authz_version = authz_version + 1, updated_at = $1
          WHERE pool_id = $2 AND tenant_id = $3 AND supply_profile_id = $4
            AND authz_version = $5
          RETURNING ${POOL_GRANT_COLUMNS}`,
        [nowText, poolId, tenantId, supplyProfileId, expectedAuthzVersion],
      );
      if (!revoked.rows[0]) fail('CREDENTIAL_STATE_CONFLICT');

      const inserted = await this.query<PoolGrantRow>(
        tx,
        `INSERT INTO saas_platform_provider_pool_grants
             (pool_id, tenant_id, supply_profile_id, supply_mode, profile_authz_version,
              pool_authz_version, status, effective_at, expires_at, authz_version,
              evidence_ref, evidence_sha256, created_at, updated_at)
           VALUES ($1, $2, $3, 'platform', $4, $5, 'active', $6, $7, 1, $8, $9, $6, $6)
           RETURNING ${POOL_GRANT_COLUMNS}`,
        [
          nextPoolId,
          tenantId,
          nextSupplyProfileId,
          positiveInteger(profile.authz_version, 'SUPPLY_STORAGE_ERROR'),
          positiveInteger(pool.authz_version, 'SUPPLY_STORAGE_ERROR'),
          nowText,
          expiresAt,
          evidenceReference,
          evidenceSha256,
        ],
      );
      const row = inserted.rows[0];
      if (!row) fail('SUPPLY_STORAGE_ERROR');
      if (audit) {
        await this.auditSupplyRelation(
          tx,
          tenantId,
          'provider_pool_grant.rebound',
          `${poolId}:${tenantId}:${supplyProfileId}->${nextPoolId}:${tenantId}:${nextSupplyProfileId}`,
          audit,
          nowText,
        );
      }
      return mapPoolGrant(row);
    }, 'CREDENTIAL_EXISTS');
  }

  private async selectTenantProfileAccount(
    tx: SqlExecutor,
    tenantId: string,
    supplyProfileId: string,
    accountId: string,
  ): Promise<TenantProfileAccountRow> {
    const result = await this.query<TenantProfileAccountRow>(
      tx,
      `SELECT ${TENANT_PROFILE_ACCOUNT_COLUMNS}
         FROM saas_tenant_provider_supply_profile_accounts
        WHERE tenant_id = $1 AND supply_profile_id = $2 AND account_id = $3
        LIMIT 1
        FOR UPDATE`,
      [tenantId, supplyProfileId, accountId],
    );
    const row = result.rows[0];
    if (!row) fail('CREDENTIAL_NOT_FOUND');
    return row;
  }

  private async selectByokProfile(tx: SqlExecutor, tenantId: string, supplyProfileId: string): Promise<ProfileRow> {
    await this.lockSupplyProfileForWrite(tx, tenantId, supplyProfileId);
    const result = await this.query<ProfileRow>(
      tx,
      `SELECT tenant_id, id, supply_mode, status, authz_version
        FROM saas_supply_profiles
        WHERE tenant_id = $1 AND id = $2 AND supply_mode = 'byok'
        LIMIT 1
        FOR UPDATE`,
      [tenantId, supplyProfileId],
    );
    const row = result.rows[0];
    if (row?.status !== 'active' || row.supply_mode !== 'byok') fail('INVALID_INPUT');
    return row;
  }

  async createTenantProviderSupplyProfileAccount(
    input: CreateTenantProviderSupplyProfileAccountInput,
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    const tenantId = identifier(input.tenantId);
    const supplyProfileId = identifier(input.supplyProfileId);
    const accountId = identifier(input.accountId);
    const evidenceReference = text(input.evidenceReference, 'INVALID_INPUT', 512).trim();
    const evidenceSha256 = text(input.evidenceSha256, 'INVALID_INPUT', 64).trim();
    if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('INVALID_INPUT');
    const now = currentDate(this.now);
    const nowText = now.toISOString();
    const effectiveAt = timestamp(input.effectiveAt, now, false) ?? nowText;
    const expiresAt = timestamp(input.expiresAt, now, true);
    if (expiresAt !== null && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()) fail('INVALID_INPUT');
    const audit = input.audit === undefined ? undefined : normalizeAuditContext(input.audit);

    return this.sqlTransaction(async (tx) => {
      await this.lockTenantProfileAccount(tx, tenantId, supplyProfileId, [accountId], 'exclusive');
      await this.selectByokProfile(tx, tenantId, supplyProfileId);
      const account = await this.selectTenantSupplyAccount(tx, tenantId, accountId);
      const result = await this.query<TenantProfileAccountRow>(
        tx,
        `INSERT INTO saas_tenant_provider_supply_profile_accounts
             (tenant_id, supply_profile_id, supply_mode, account_id, provider_id, product_id,
              account_authz_version, status, effective_at, expires_at, authz_version,
              evidence_ref, evidence_sha256, created_at, updated_at)
           VALUES ($1, $2, 'byok', $3, $4, $5, $6, 'active', $7, $8, 1, $9, $10, $11, $11)
           RETURNING ${TENANT_PROFILE_ACCOUNT_COLUMNS}`,
        [
          tenantId,
          supplyProfileId,
          account.id,
          account.provider_id,
          account.product_id,
          positiveInteger(account.authz_version, 'SUPPLY_STORAGE_ERROR'),
          effectiveAt,
          expiresAt,
          evidenceReference,
          evidenceSha256,
          nowText,
        ],
      );
      const row = result.rows[0];
      if (!row) fail('SUPPLY_STORAGE_ERROR');
      if (audit) {
        await this.auditSupplyRelation(
          tx,
          tenantId,
          'tenant_profile_account.bound',
          `${tenantId}:${supplyProfileId}:${account.id}`,
          audit,
          nowText,
        );
      }
      return mapTenantProfileAccount(row);
    }, 'CREDENTIAL_EXISTS');
  }

  async bindTenantProviderSupplyProfileAccount(
    input: CreateTenantProviderSupplyProfileAccountInput,
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    return this.createTenantProviderSupplyProfileAccount(input);
  }

  private async transitionTenantProviderSupplyProfileAccount(
    input: TenantProviderSupplyProfileAccountStateChangeInput,
    next: 'active' | 'disabled' | 'revoked',
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    const tenantId = identifier(input.tenantId);
    const supplyProfileId = identifier(input.supplyProfileId);
    const accountId = identifier(input.accountId);
    const expectedAuthzVersion = positiveInteger(input.expectedAuthzVersion);
    const audit = input.audit === undefined ? undefined : normalizeAuditContext(input.audit);
    const now = currentDate(this.now).toISOString();
    return this.sqlTransaction(async (tx) => {
      await this.lockTenantProfileAccount(tx, tenantId, supplyProfileId, [accountId], 'exclusive');
      await this.selectByokProfile(tx, tenantId, supplyProfileId);
      await this.selectTenantSupplyAccount(tx, tenantId, accountId);
      const current = await this.selectTenantProfileAccount(tx, tenantId, supplyProfileId, accountId);
      const currentVersion = positiveInteger(current.authz_version, 'SUPPLY_STORAGE_ERROR');
      if (currentVersion !== expectedAuthzVersion) fail('CREDENTIAL_STATE_CONFLICT');
      if (current.status === 'revoked') fail('CREDENTIAL_STATE_CONFLICT');
      if (current.status === next) fail('INVALID_CREDENTIAL_LIFECYCLE');
      const result = await this.query<TenantProfileAccountRow>(
        tx,
        `UPDATE saas_tenant_provider_supply_profile_accounts
            SET status = $1,
                disabled_at = $2,
                revoked_at = $3,
                authz_version = authz_version + 1,
                updated_at = $4
          WHERE tenant_id = $5 AND supply_profile_id = $6 AND account_id = $7
            AND authz_version = $8
          RETURNING ${TENANT_PROFILE_ACCOUNT_COLUMNS}`,
        [
          next,
          next === 'disabled' ? now : null,
          next === 'revoked' ? now : null,
          now,
          tenantId,
          supplyProfileId,
          accountId,
          expectedAuthzVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) fail('CREDENTIAL_STATE_CONFLICT');
      if (audit) {
        await this.auditSupplyRelation(
          tx,
          tenantId,
          `tenant_profile_account.${next}`,
          `${tenantId}:${supplyProfileId}:${accountId}`,
          audit,
          now,
        );
      }
      return mapTenantProfileAccount(row);
    });
  }

  async disableTenantProviderSupplyProfileAccount(
    input: TenantProviderSupplyProfileAccountStateChangeInput,
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    return this.transitionTenantProviderSupplyProfileAccount(input, 'disabled');
  }

  async enableTenantProviderSupplyProfileAccount(
    input: TenantProviderSupplyProfileAccountStateChangeInput,
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    return this.transitionTenantProviderSupplyProfileAccount(input, 'active');
  }

  async revokeTenantProviderSupplyProfileAccount(
    input: TenantProviderSupplyProfileAccountStateChangeInput,
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    return this.transitionTenantProviderSupplyProfileAccount(input, 'revoked');
  }

  async rebindTenantProviderSupplyProfileAccount(
    input: RebindTenantProviderSupplyProfileAccountInput,
  ): Promise<TenantProviderSupplyProfileAccountRecord> {
    if (!input) fail('INVALID_INPUT');
    const tenantId = identifier(input.tenantId);
    const supplyProfileId = identifier(input.supplyProfileId);
    const accountId = identifier(input.accountId);
    const newAccountId = identifier(input.newAccountId);
    if (accountId === newAccountId) fail('INVALID_INPUT');
    const expectedAuthzVersion = positiveInteger(input.expectedAuthzVersion);
    const audit = input.audit === undefined ? undefined : normalizeAuditContext(input.audit);
    const now = currentDate(this.now);
    const nowText = now.toISOString();
    if ((input.evidenceReference === undefined) !== (input.evidenceSha256 === undefined)) fail('INVALID_INPUT');

    return this.sqlTransaction(async (tx) => {
      await this.lockTenantProfileAccount(tx, tenantId, supplyProfileId, [accountId, newAccountId], 'exclusive');
      await this.selectByokProfile(tx, tenantId, supplyProfileId);
      const current = await this.selectTenantProfileAccount(tx, tenantId, supplyProfileId, accountId);
      const currentVersion = positiveInteger(current.authz_version, 'SUPPLY_STORAGE_ERROR');
      if (currentVersion !== expectedAuthzVersion) fail('CREDENTIAL_STATE_CONFLICT');
      if (current.status === 'revoked') fail('CREDENTIAL_STATE_CONFLICT');
      const newAccount = await this.selectTenantSupplyAccount(tx, tenantId, newAccountId);
      const existing = await this.query<TenantProfileAccountRow>(
        tx,
        `SELECT ${TENANT_PROFILE_ACCOUNT_COLUMNS}
           FROM saas_tenant_provider_supply_profile_accounts
          WHERE tenant_id = $1 AND supply_profile_id = $2 AND account_id = $3
          LIMIT 1
          FOR UPDATE`,
        [tenantId, supplyProfileId, newAccountId],
      );
      if (existing.rows[0]) fail('CREDENTIAL_STATE_CONFLICT');

      const evidenceReference =
        input.evidenceReference === undefined
          ? text(current.evidence_ref, 'SUPPLY_STORAGE_ERROR', 512)
          : text(input.evidenceReference, 'INVALID_INPUT', 512).trim();
      const evidenceSha256 =
        input.evidenceSha256 === undefined
          ? text(current.evidence_sha256, 'SUPPLY_STORAGE_ERROR', 64)
          : text(input.evidenceSha256, 'INVALID_INPUT', 64).trim();
      if (!/^[0-9a-f]{64}$/.test(evidenceSha256)) fail('INVALID_INPUT');
      const effectiveAt = timestamp(input.effectiveAt, now, false) ?? nowText;
      const expiresAt =
        input.expiresAt === undefined
          ? timestamp(current.expires_at, now, true)
          : timestamp(input.expiresAt, now, true);
      if (expiresAt !== null && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()) fail('INVALID_INPUT');

      const revoked = await this.query<TenantProfileAccountRow>(
        tx,
        `UPDATE saas_tenant_provider_supply_profile_accounts
            SET status = 'revoked', revoked_at = $1, disabled_at = NULL,
                authz_version = authz_version + 1, updated_at = $1
          WHERE tenant_id = $2 AND supply_profile_id = $3 AND account_id = $4
            AND authz_version = $5
          RETURNING ${TENANT_PROFILE_ACCOUNT_COLUMNS}`,
        [nowText, tenantId, supplyProfileId, accountId, expectedAuthzVersion],
      );
      if (!revoked.rows[0]) fail('CREDENTIAL_STATE_CONFLICT');

      const inserted = await this.query<TenantProfileAccountRow>(
        tx,
        `INSERT INTO saas_tenant_provider_supply_profile_accounts
             (tenant_id, supply_profile_id, supply_mode, account_id, provider_id, product_id,
              account_authz_version, status, effective_at, expires_at, authz_version,
              evidence_ref, evidence_sha256, created_at, updated_at)
           VALUES ($1, $2, 'byok', $3, $4, $5, $6, 'active', $7, $8, 1, $9, $10, $11, $11)
           RETURNING ${TENANT_PROFILE_ACCOUNT_COLUMNS}`,
        [
          tenantId,
          supplyProfileId,
          newAccount.id,
          newAccount.provider_id,
          newAccount.product_id,
          positiveInteger(newAccount.authz_version, 'SUPPLY_STORAGE_ERROR'),
          effectiveAt,
          expiresAt,
          evidenceReference,
          evidenceSha256,
          nowText,
        ],
      );
      const row = inserted.rows[0];
      if (!row) fail('SUPPLY_STORAGE_ERROR');
      if (audit) {
        await this.auditSupplyRelation(
          tx,
          tenantId,
          'tenant_profile_account.rebound',
          `${tenantId}:${supplyProfileId}:${accountId}->${newAccountId}`,
          audit,
          nowText,
        );
      }
      return mapTenantProfileAccount(row);
    }, 'CREDENTIAL_EXISTS');
  }
}
