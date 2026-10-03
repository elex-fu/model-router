import { randomUUID } from 'node:crypto';
import type { ProviderCredentialEnvelope } from '../credentials/provider-crypto.js';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type {
  ProviderAccountListFilter,
  ProviderAccountRecord,
  ProviderAccountReference,
  ProviderAccountStatus,
  ProviderCapabilityReference,
  ProviderCredentialDispatchAccountSnapshot,
  ProviderCredentialDispatchAttempt,
  ProviderCredentialDispatchClaimAuditSnapshot,
  ProviderCredentialDispatchCredentialSnapshot,
  ProviderCredentialDispatchEvidence,
  ProviderCredentialDispatchPoolGrantSnapshot,
  ProviderCredentialDispatchPoolMemberSnapshot,
  ProviderCredentialDispatchPoolSnapshot,
  ProviderCredentialDispatchProfileAccountSnapshot,
  ProviderCredentialDispatchProfileSnapshot,
  ProviderCredentialDispatchProof,
  ProviderCredentialDispatchProtocol,
  ProviderCredentialDispatchResultState,
  ProviderCredentialDispatchState,
  ProviderCredentialDispatchTargetMode,
  ProviderCredentialListFilter,
  ProviderCredentialRecord,
  ProviderCredentialReference,
  ProviderCredentialRewrapAuditContext,
  ProviderCredentialValidationJobInput,
  ProviderCredentialValidationJobRecord,
  ProviderCredentialValidationJobState,
  ProviderCredentialVersionRecord,
  ProviderCredentialVersionStatus,
  ProviderCredentialWrapperRevisionRecord,
  ProviderSupplyAuditContext,
  ProviderSupplyOwner,
  ProviderSupplyOwnerKind,
  ProviderValidationState,
  StoredProviderCredentialVersion,
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
  assertReference(reference);
  if (reference.ownerKind === 'tenant') {
    return saasAdvisoryKey.tenantProviderAccount(reference.tenantId, reference.accountId);
  }
  return saasAdvisoryKey.platformProviderAccount(reference.accountId);
}

function providerCredentialAdvisoryKey(reference: ProviderCredentialReference): string {
  assertReference(reference);
  if (reference.ownerKind === 'tenant') {
    return saasAdvisoryKey.tenantProviderCredential(reference.tenantId, reference.credentialId);
  }
  return saasAdvisoryKey.platformProviderCredential(reference.credentialId);
}

function credentialVersionAdvisoryKey(reference: ProviderCredentialReference & { readonly version: number }): string {
  return saasAdvisoryKey.credentialVersion(
    reference.ownerKind,
    reference.tenantId ?? reference.accountId,
    reference.credentialId,
    reference.version,
  );
}

function providerAccountReference(reference: ProviderCredentialReference): ValidProviderAccountReference {
  assertReference(reference);
  if (reference.ownerKind === 'tenant') {
    return { ownerKind: 'tenant', tenantId: reference.tenantId, accountId: reference.accountId };
  }
  return { ownerKind: 'platform', tenantId: null, accountId: reference.accountId };
}

function providerAccountLockLayers(reference: ProviderAccountReference): readonly (readonly string[])[] {
  assertReference(reference);
  return [
    reference.ownerKind === 'tenant' ? [saasAdvisoryKey.tenant(reference.tenantId)] : [],
    [providerAccountAdvisoryKey(reference)],
  ];
}

function providerCredentialLockLayers(reference: ProviderCredentialReference): readonly (readonly string[])[] {
  return [
    ...providerAccountLockLayers(providerAccountReference(reference)),
    [providerCredentialAdvisoryKey(reference)],
  ];
}

function providerVersionLockLayers(
  reference: ProviderCredentialReference & { readonly version: number },
): readonly (readonly string[])[] {
  return [...providerCredentialLockLayers(reference), [credentialVersionAdvisoryKey(reference)]];
}

export interface PersistedProviderAccountInput {
  readonly owner: ProviderSupplyOwner;
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly region: string;
  readonly purpose: string;
  readonly rightsId: string;
  readonly rightsVersion: number;
  readonly capabilities: readonly ProviderCapabilityReference[];
  readonly status: ProviderAccountStatus;
  readonly validationState: ProviderValidationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedProviderCredentialInput {
  readonly owner: ProviderSupplyOwner;
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialType: string;
  readonly status: 'pending';
  readonly validationState: 'unverified';
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedTenantByokProfileAccountInput {
  readonly tenantId: string;
  readonly supplyProfileId: string;
  readonly accountId: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
}

export interface AppendProviderCredentialVersionInput {
  readonly credential: ProviderCredentialReference & { readonly version: number };
  readonly providerId: string;
  readonly productId: string;
  readonly envelope: ProviderCredentialEnvelope;
  readonly kmsPurpose: string;
  readonly wrappingRevision: number;
  readonly expectedCurrentVersion: number | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface AppendProviderSupplyAuditEventInput {
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly occurredAt: string;
  readonly audit: ProviderSupplyAuditContext;
}

export interface AppendProviderCredentialWrapperRevisionInput {
  readonly credential: ProviderCredentialReference & { readonly version: number };
  readonly expectedWrappingRevision: number;
  readonly sourceKmsKeyId: string;
  readonly kmsKeyId: string;
  readonly wrappedDek: string;
  readonly contextSha256: string;
  readonly operationId: string;
  readonly audit: ProviderCredentialRewrapAuditContext;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface UpdateProviderAccountLifecycleInput {
  readonly account: ProviderAccountReference;
  readonly status: ProviderAccountStatus;
  readonly expectedAuthzVersion: number;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
}

export interface UpdateProviderAccountValidationInput {
  readonly account: ProviderAccountReference;
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly expectedAuthzVersion: number;
  readonly updatedAt: string;
}

export interface UpdateProviderCredentialLifecycleInput {
  readonly credential: ProviderCredentialReference;
  readonly status: 'active' | 'disabled' | 'revoked';
  readonly expectedAuthzVersion: number;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly revokedAt: string | null;
}

export interface UpdateProviderCredentialValidationInput {
  readonly credential: ProviderCredentialReference;
  readonly validationState: ProviderValidationState;
  readonly validationErrorCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly expectedAuthzVersion: number;
  readonly updatedAt: string;
}

export interface ProviderSupplyRepository {
  transaction<T>(work: (repository: ProviderSupplyRepository, executor?: SqlExecutor) => Promise<T>): Promise<T>;

  /** Optional so existing internal/test repositories remain compatible. Audited paths fail closed when absent. */
  appendAuditEvent?(input: AppendProviderSupplyAuditEventInput): Promise<void>;

  /** Reads a complete, database-owned dispatch proof in one short transaction. */
  readDispatchProof(evidenceId: string): Promise<ProviderCredentialDispatchProof | null>;

  createAccount(input: PersistedProviderAccountInput): Promise<ProviderAccountRecord>;
  /** Legacy/test adapters may omit this; atomic BYOK creation fails closed without it. */
  createTenantByokProfileAccount?(input: PersistedTenantByokProfileAccountInput): Promise<void>;
  getAccount(account: ProviderAccountReference): Promise<ProviderAccountRecord | null>;
  listAccounts(filter?: ProviderAccountListFilter): Promise<readonly ProviderAccountRecord[]>;
  updateAccountLifecycle(input: UpdateProviderAccountLifecycleInput): Promise<ProviderAccountRecord | null>;
  updateAccountValidation(input: UpdateProviderAccountValidationInput): Promise<ProviderAccountRecord | null>;

  createCredential(input: PersistedProviderCredentialInput): Promise<ProviderCredentialRecord>;
  /** Enqueues a non-secret validation snapshot; callers must share the credential-write transaction. */
  enqueueProviderCredentialValidationJob(
    input: ProviderCredentialValidationJobInput,
  ): Promise<ProviderCredentialValidationJobRecord>;
  getCredential(credential: ProviderCredentialReference): Promise<ProviderCredentialRecord | null>;
  listCredentials(filter?: ProviderCredentialListFilter): Promise<readonly ProviderCredentialRecord[]>;
  appendCredentialVersion(
    input: AppendProviderCredentialVersionInput,
  ): Promise<{ readonly credential: ProviderCredentialRecord; readonly version: ProviderCredentialVersionRecord }>;
  updateCredentialLifecycle(input: UpdateProviderCredentialLifecycleInput): Promise<ProviderCredentialRecord | null>;
  updateCredentialValidation(input: UpdateProviderCredentialValidationInput): Promise<ProviderCredentialRecord | null>;

  getCredentialVersion(
    credential: ProviderCredentialReference & { readonly version: number },
  ): Promise<ProviderCredentialVersionRecord | null>;
  listCredentialVersions(credential: ProviderCredentialReference): Promise<readonly ProviderCredentialVersionRecord[]>;

  /** Internal runtime-only lookup. The envelope is never returned by list/read service methods. */
  getCredentialVersionEnvelope(
    credential: ProviderCredentialReference & { readonly version: number },
  ): Promise<StoredProviderCredentialVersion | null>;

  /** Optional for compatibility repositories; production rewrap fails closed without both methods. */
  getCredentialWrapperRevisionByOperation?(
    credential: ProviderCredentialReference & { readonly version: number },
    operationId: string,
  ): Promise<ProviderCredentialWrapperRevisionRecord | null>;
  appendCredentialWrapperRevision?(
    input: AppendProviderCredentialWrapperRevisionInput,
  ): Promise<{ readonly revision: ProviderCredentialWrapperRevisionRecord; readonly inserted: boolean }>;
}

interface AccountRowFields {
  id: string;
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
  last_validated_at: string | Date | null;
  authz_version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  disabled_at: string | Date | null;
  revoked_at: string | Date | null;
}

type AccountRow = AccountRowFields &
  (
    | { owner_kind: 'tenant'; tenant_id: string; supply_mode: 'byok' }
    | { owner_kind: 'platform'; tenant_id: null; supply_mode: 'platform' }
  );

interface CredentialRow {
  owner_kind: string;
  tenant_id: string | null;
  supply_mode: string;
  id: string;
  account_id: string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  status: string;
  validation_state: string;
  validation_error_code: string | null;
  last_validated_at: string | Date | null;
  current_version: number | string | null;
  expires_at: string | Date | null;
  authz_version: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  disabled_at: string | Date | null;
  revoked_at: string | Date | null;
}

interface CredentialValidationJobRow {
  id: string;
  tenant_id: string;
  account_id: string;
  credential_id: string;
  credential_version: number | string;
  provider_id: string;
  product_id: string;
  credential_type: string;
  allowed_models: string[];
  target_model: string;
  target_endpoint: string;
  capability_version: number | string;
  idempotency_key: string;
  status: string;
  attempt_count: number | string;
  available_at: string | Date;
  lease_until: string | Date | null;
  lease_generation: number | string;
  last_error_code: string | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface CredentialVersionRow {
  owner_kind: string;
  tenant_id: string | null;
  supply_mode: string;
  account_id: string;
  credential_id: string;
  version: number | string;
  status: string;
  schema_version: number | string;
  context_version: number | string;
  algorithm: string;
  kms_purpose: string;
  kms_key_id: string;
  wrapping_revision: number | string;
  wrapped_dek: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  created_at: string | Date;
  expires_at: string | Date | null;
  retired_at: string | Date | null;
  revoked_at: string | Date | null;
}

interface CredentialWrapperRevisionRow {
  owner_kind: string;
  tenant_id: string | null;
  account_id: string;
  credential_id: string;
  credential_version: number | string;
  expected_wrapping_revision: number | string;
  wrapping_revision: number | string;
  operation_id: string;
  source_kms_key_id: string;
  kms_key_id: string;
  context_sha256: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_workload_id: string | null;
  request_id: string;
  reason_code: string;
  created_at: string | Date;
}

interface CapabilityRow {
  model: string;
  endpoint: string;
  capability_version: number | string;
}

type DispatchRow = Record<string, unknown>;

interface DispatchIdentityRow {
  tenant_id: string;
  project_id: string;
  principal_kind: string;
  principal_id: string;
  proxy_key_id: string;
  supply_mode: string;
  account_owner_kind: string;
  account_id: string;
  credential_id: string;
  credential_version: number | string;
  dispatch_profile_id: string;
  pool_id: string | null;
}

function dispatchText(row: DispatchRow, key: string): string {
  return asText(row[key]);
}

function dispatchNullableText(row: DispatchRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : asText(row[key]);
}

function dispatchInteger(row: DispatchRow, key: string): number {
  return asPositiveInteger(row[key]);
}

function dispatchNullableInteger(row: DispatchRow, key: string): number | null {
  return asNullablePositiveInteger(row[key]);
}

function dispatchTimestamp(row: DispatchRow, key: string): string {
  return asTimestamp(row[key]);
}

function dispatchNullableTimestamp(row: DispatchRow, key: string): string | null {
  return nullableTimestamp(row[key]);
}

function dispatchOwnerKind(value: unknown): ProviderSupplyOwnerKind {
  if (value === 'tenant' || value === 'platform') return value;
  throw repositoryError('INVALID_DISPATCH_PROOF_OWNER');
}

function dispatchSupplyMode(value: unknown): 'byok' | 'platform' {
  if (value === 'byok' || value === 'platform') return value;
  throw repositoryError('INVALID_DISPATCH_PROOF_MODE');
}

function dispatchProtocol(value: unknown): ProviderCredentialDispatchProtocol {
  if (value === 'anthropic' || value === 'openai' || value === 'gemini' || value === 'responses') return value;
  throw repositoryError('INVALID_DISPATCH_PROOF_PROTOCOL');
}

function dispatchTargetMode(value: unknown): ProviderCredentialDispatchTargetMode {
  if (value === 'tenant_account' || value === 'platform_pool') return value;
  throw repositoryError('INVALID_DISPATCH_PROOF_TARGET');
}

function dispatchState(value: unknown): ProviderCredentialDispatchState {
  if (value === 'not_sent' || value === 'dispatching' || value === 'sent' || value === 'unknown') return value;
  throw repositoryError('INVALID_DISPATCH_PROOF_STATE');
}

function dispatchResultState(value: unknown): ProviderCredentialDispatchResultState {
  if (
    value === 'pending' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'unknown'
  ) {
    return value;
  }
  throw repositoryError('INVALID_DISPATCH_PROOF_RESULT');
}

function dispatchRelationStatus(value: unknown): 'active' | 'disabled' | 'revoked' {
  if (value === 'active' || value === 'disabled' || value === 'revoked') return value;
  throw repositoryError('INVALID_DISPATCH_PROOF_RELATION_STATUS');
}

function dispatchBinding(row: DispatchRow, prefix: string) {
  return {
    tenantId: dispatchText(row, `${prefix}_tenant_id`),
    requestId: dispatchText(row, `${prefix}_request_id`),
    attemptId: dispatchText(row, `${prefix}_attempt_id`),
    attemptOrdinal: dispatchInteger(row, `${prefix}_attempt_ordinal`),
    supplyMode: dispatchSupplyMode(row[`${prefix}_supply_mode`]),
    accountOwnerKind: dispatchOwnerKind(row[`${prefix}_account_owner_kind`]),
    accountId: dispatchText(row, `${prefix}_account_id`),
    providerId: dispatchText(row, `${prefix}_provider_id`),
    productId: dispatchText(row, `${prefix}_product_id`),
    protocol: dispatchProtocol(row[`${prefix}_protocol`]),
    endpoint: dispatchText(row, `${prefix}_endpoint`),
    routeConfigId: dispatchText(row, `${prefix}_route_config_id`),
    routeConfigVersion: dispatchInteger(row, `${prefix}_route_config_version`),
    routePublicModelId: dispatchText(row, `${prefix}_route_public_model_id`),
    routePublicModelVersion: dispatchInteger(row, `${prefix}_route_public_model_version`),
    routeProtocol: dispatchProtocol(row[`${prefix}_route_protocol`]),
    routeTargetMode: dispatchTargetMode(row[`${prefix}_route_target_mode`]),
    routeUpstreamId: dispatchText(row, `${prefix}_route_upstream_id`),
    upstreamId: dispatchText(row, `${prefix}_upstream_id`),
    resolvedModel: dispatchText(row, `${prefix}_resolved_model`),
    dispatchProfileId: dispatchText(row, `${prefix}_dispatch_profile_id`),
    supplyProfileAuthzVersion: dispatchInteger(row, `${prefix}_supply_profile_authz_version`),
    credentialId: dispatchText(row, `${prefix}_credential_id`),
    credentialVersion: dispatchInteger(row, `${prefix}_credential_version`),
    credentialAuthzVersion: dispatchInteger(row, `${prefix}_credential_authz_version`),
    accountAuthzVersion: dispatchInteger(row, `${prefix}_account_authz_version`),
    profileAccountAuthzVersion: dispatchNullableInteger(row, `${prefix}_profile_account_authz_version`),
    poolId: dispatchNullableText(row, `${prefix}_pool_id`),
    poolAuthzVersion: dispatchNullableInteger(row, `${prefix}_pool_authz_version`),
    poolMemberAccountAuthzVersion: dispatchNullableInteger(row, `${prefix}_pool_member_account_authz_version`),
    poolMemberAuthzVersion: dispatchNullableInteger(row, `${prefix}_pool_member_authz_version`),
    poolGrantAuthzVersion: dispatchNullableInteger(row, `${prefix}_pool_grant_authz_version`),
    poolGrantProfileAuthzVersion: dispatchNullableInteger(row, `${prefix}_pool_grant_profile_authz_version`),
    poolGrantPoolAuthzVersion: dispatchNullableInteger(row, `${prefix}_pool_grant_pool_authz_version`),
  };
}

function dispatchOwner(row: DispatchRow, prefix: string): ProviderSupplyOwner {
  return ownerFromRow({
    owner_kind: dispatchOwnerKind(row[`${prefix}_owner_kind`]),
    tenant_id: dispatchNullableText(row, `${prefix}_tenant_id`),
    supply_mode: dispatchSupplyMode(row[`${prefix}_supply_mode`]),
  });
}

function mapDispatchAccount(row: DispatchRow): ProviderCredentialDispatchAccountSnapshot {
  return {
    ...dispatchOwner(row, 'account'),
    id: dispatchText(row, 'account_id'),
    providerId: dispatchText(row, 'account_provider_id'),
    productId: dispatchText(row, 'account_product_id'),
    credentialType: dispatchText(row, 'account_credential_type'),
    purpose: dispatchText(row, 'account_purpose'),
    status: accountStatus(row.account_status),
    validationState: validationState(row.account_validation_state),
    authzVersion: dispatchInteger(row, 'account_authz_version'),
  };
}

function mapDispatchCredential(row: DispatchRow): ProviderCredentialDispatchCredentialSnapshot {
  return {
    ...dispatchOwner(row, 'credential'),
    id: dispatchText(row, 'credential_id'),
    accountId: dispatchText(row, 'credential_account_id'),
    providerId: dispatchText(row, 'credential_provider_id'),
    productId: dispatchText(row, 'credential_product_id'),
    status: credentialStatus(row.credential_status),
    validationState: validationState(row.credential_validation_state),
    currentVersion: dispatchNullableInteger(row, 'credential_current_version'),
    expiresAt: dispatchNullableTimestamp(row, 'credential_expires_at'),
    authzVersion: dispatchInteger(row, 'credential_authz_version'),
  };
}

function mapDispatchVersion(row: DispatchRow): StoredProviderCredentialVersion {
  return mapVersion({
    owner_kind: dispatchOwnerKind(row.version_owner_kind),
    tenant_id: dispatchNullableText(row, 'version_tenant_id'),
    supply_mode: dispatchSupplyMode(row.version_supply_mode),
    account_id: dispatchText(row, 'version_account_id'),
    credential_id: dispatchText(row, 'version_credential_id'),
    version: dispatchInteger(row, 'version_number'),
    status: dispatchText(row, 'version_status'),
    schema_version: dispatchInteger(row, 'version_schema_version'),
    context_version: dispatchInteger(row, 'version_context_version'),
    algorithm: dispatchText(row, 'version_algorithm'),
    kms_purpose: dispatchText(row, 'version_kms_purpose'),
    kms_key_id: dispatchText(row, 'version_kms_key_id'),
    wrapping_revision: dispatchInteger(row, 'version_wrapping_revision'),
    wrapped_dek: dispatchText(row, 'version_wrapped_dek'),
    nonce: dispatchText(row, 'version_nonce'),
    ciphertext: dispatchText(row, 'version_ciphertext'),
    auth_tag: dispatchText(row, 'version_auth_tag'),
    created_at: dispatchTimestamp(row, 'version_created_at'),
    expires_at: dispatchNullableTimestamp(row, 'version_expires_at'),
    retired_at: dispatchNullableTimestamp(row, 'version_retired_at'),
    revoked_at: dispatchNullableTimestamp(row, 'version_revoked_at'),
  });
}

function mapDispatchProfile(row: DispatchRow): ProviderCredentialDispatchProfileSnapshot {
  return {
    tenantId: dispatchText(row, 'profile_tenant_id'),
    id: dispatchText(row, 'profile_id'),
    supplyMode: dispatchSupplyMode(row.profile_supply_mode),
    status: dispatchRelationStatus(row.profile_status),
    authzVersion: dispatchInteger(row, 'profile_authz_version'),
  };
}

function mapDispatchProfileAccount(row: DispatchRow): ProviderCredentialDispatchProfileAccountSnapshot {
  if (dispatchSupplyMode(row.profile_account_supply_mode) !== 'byok') {
    throw repositoryError('INVALID_DISPATCH_PROOF_PROFILE_ACCOUNT');
  }
  return {
    tenantId: dispatchText(row, 'profile_account_tenant_id'),
    supplyProfileId: dispatchText(row, 'profile_account_supply_profile_id'),
    supplyMode: 'byok',
    accountId: dispatchText(row, 'profile_account_id'),
    providerId: dispatchText(row, 'profile_account_provider_id'),
    productId: dispatchText(row, 'profile_account_product_id'),
    accountAuthzVersion: dispatchInteger(row, 'profile_account_account_authz_version'),
    status: dispatchRelationStatus(row.profile_account_status),
    authzVersion: dispatchInteger(row, 'profile_account_authz_version'),
    effectiveAt: dispatchTimestamp(row, 'profile_account_effective_at'),
    expiresAt: dispatchNullableTimestamp(row, 'profile_account_expires_at'),
  };
}

function mapDispatchPool(row: DispatchRow): ProviderCredentialDispatchPoolSnapshot {
  return {
    id: dispatchText(row, 'pool_id'),
    providerId: dispatchText(row, 'pool_provider_id'),
    productId: dispatchText(row, 'pool_product_id'),
    status: accountStatus(row.pool_status),
    validationState: validationState(row.pool_validation_state),
    authzVersion: dispatchInteger(row, 'pool_authz_version'),
  };
}

function mapDispatchPoolMember(row: DispatchRow): ProviderCredentialDispatchPoolMemberSnapshot {
  return {
    poolId: dispatchText(row, 'member_pool_id'),
    accountId: dispatchText(row, 'member_account_id'),
    providerId: dispatchText(row, 'member_provider_id'),
    productId: dispatchText(row, 'member_product_id'),
    accountAuthzVersion: dispatchInteger(row, 'member_account_authz_version'),
    authzVersion: dispatchInteger(row, 'member_authz_version'),
    status: dispatchRelationStatus(row.member_status),
  };
}

function mapDispatchPoolGrant(row: DispatchRow): ProviderCredentialDispatchPoolGrantSnapshot {
  if (dispatchSupplyMode(row.grant_supply_mode) !== 'platform') {
    throw repositoryError('INVALID_DISPATCH_PROOF_POOL_GRANT');
  }
  return {
    poolId: dispatchText(row, 'grant_pool_id'),
    tenantId: dispatchText(row, 'grant_tenant_id'),
    supplyProfileId: dispatchText(row, 'grant_supply_profile_id'),
    supplyMode: 'platform',
    profileAuthzVersion: dispatchInteger(row, 'grant_profile_authz_version'),
    poolAuthzVersion: dispatchInteger(row, 'grant_pool_authz_version'),
    authzVersion: dispatchInteger(row, 'grant_authz_version'),
    status: dispatchRelationStatus(row.grant_status),
    effectiveAt: dispatchTimestamp(row, 'grant_effective_at'),
    expiresAt: dispatchNullableTimestamp(row, 'grant_expires_at'),
  };
}

function mapDispatchClaimAudit(row: DispatchRow): ProviderCredentialDispatchClaimAuditSnapshot {
  const action = dispatchText(row, 'claim_action');
  const targetType = dispatchText(row, 'claim_target_type');
  if (action !== 'saas_prepared_request_evidence.claimed' || targetType !== 'saas_prepared_request_evidence') {
    throw repositoryError('INVALID_DISPATCH_PROOF_AUDIT');
  }
  return { action, targetType, targetId: dispatchText(row, 'claim_target_id') };
}

function mapDispatchEvidence(row: DispatchRow): ProviderCredentialDispatchEvidence {
  return {
    ...dispatchBinding(row, 'evidence'),
    evidenceId: dispatchText(row, 'evidence_id'),
    supplyProfileId: dispatchText(row, 'evidence_supply_profile_id'),
    supplyProfileVersion: dispatchInteger(row, 'evidence_supply_profile_version'),
    publicModel: dispatchText(row, 'evidence_public_model'),
    status:
      row.evidence_status === 'registered' || row.evidence_status === 'claimed'
        ? row.evidence_status
        : (() => {
            throw repositoryError('INVALID_DISPATCH_PROOF_EVIDENCE_STATUS');
          })(),
    claimedAt: dispatchNullableTimestamp(row, 'evidence_claimed_at'),
    claimedAttemptId: dispatchNullableText(row, 'evidence_claimed_attempt_id'),
    dispatchDeadline: dispatchTimestamp(row, 'evidence_dispatch_deadline'),
    expiresAt: dispatchTimestamp(row, 'evidence_expires_at'),
  };
}

function mapDispatchAttempt(row: DispatchRow): ProviderCredentialDispatchAttempt {
  return {
    ...dispatchBinding(row, 'attempt'),
    preparedEvidenceId: dispatchNullableText(row, 'attempt_prepared_evidence_id'),
    dispatchAuthorityState:
      row.attempt_dispatch_authority_state === 'unbound' || row.attempt_dispatch_authority_state === 'bound'
        ? row.attempt_dispatch_authority_state
        : (() => {
            throw repositoryError('INVALID_DISPATCH_PROOF_AUTHORITY');
          })(),
    dispatchState: dispatchState(row.attempt_dispatch_state),
    resultState: dispatchResultState(row.attempt_result_state),
    responseStarted: row.attempt_response_started === true,
  };
}

const TENANT_ACCOUNT_TABLE = 'saas_tenant_provider_accounts' as const;
const PLATFORM_ACCOUNT_TABLE = 'saas_platform_provider_accounts' as const;
const TENANT_ACCOUNT_CAPABILITY_TABLE = 'saas_tenant_provider_account_capabilities' as const;
const PLATFORM_ACCOUNT_CAPABILITY_TABLE = 'saas_platform_provider_account_capabilities' as const;
const TENANT_CREDENTIAL_TABLE = 'saas_tenant_provider_credentials' as const;
const PLATFORM_CREDENTIAL_TABLE = 'saas_platform_provider_credentials' as const;
const TENANT_VERSION_TABLE = 'saas_tenant_provider_credential_versions' as const;
const PLATFORM_VERSION_TABLE = 'saas_platform_provider_credential_versions' as const;
const TENANT_WRAPPER_TABLE = 'saas_tenant_provider_credential_wrappings' as const;
const PLATFORM_WRAPPER_TABLE = 'saas_platform_provider_credential_wrappings' as const;

const ACCOUNT_COLUMNS = `
  owner_kind, tenant_id, supply_mode, id, display_name, provider_id, product_id,
  credential_type, region, purpose, rights_id, rights_version, status,
  validation_state, validation_error_code, last_validated_at, authz_version,
  created_at, updated_at, disabled_at, revoked_at`;

const CREDENTIAL_COLUMNS = `
  owner_kind, tenant_id, supply_mode, id, account_id, provider_id, product_id,
  credential_type, status, validation_state, validation_error_code,
  last_validated_at, current_version, expires_at, authz_version, created_at,
  updated_at, disabled_at, revoked_at`;

const VERSION_COLUMNS = `
  owner_kind, tenant_id, supply_mode, account_id, credential_id, version, status,
  schema_version, context_version, algorithm, kms_purpose, kms_key_id,
  wrapping_revision, wrapped_dek, nonce, ciphertext, auth_tag, created_at,
  expires_at, retired_at, revoked_at`;

function accountColumns(ownerKind: ProviderSupplyOwnerKind): string {
  return ownerKind === 'tenant' ? ACCOUNT_COLUMNS : ACCOUNT_COLUMNS.replace('tenant_id', 'NULL::uuid AS tenant_id');
}

function credentialColumns(ownerKind: ProviderSupplyOwnerKind): string {
  return ownerKind === 'tenant'
    ? CREDENTIAL_COLUMNS
    : CREDENTIAL_COLUMNS.replace('tenant_id', 'NULL::uuid AS tenant_id');
}

function versionColumns(ownerKind: ProviderSupplyOwnerKind): string {
  return ownerKind === 'tenant' ? VERSION_COLUMNS : VERSION_COLUMNS.replace('tenant_id', 'NULL::uuid AS tenant_id');
}

function wrapperTable(ownerKind: ProviderSupplyOwnerKind): typeof TENANT_WRAPPER_TABLE | typeof PLATFORM_WRAPPER_TABLE {
  return ownerKind === 'tenant' ? TENANT_WRAPPER_TABLE : PLATFORM_WRAPPER_TABLE;
}

const WRAPPER_REVISION_COLUMNS = `
  owner_kind, tenant_id, account_id, credential_id, credential_version,
  expected_wrapping_revision, wrapping_revision, operation_id, source_kms_key_id,
  kms_key_id, context_sha256, actor_kind, actor_user_id, actor_workload_id,
  request_id, reason_code, created_at`;

function wrapperRevisionColumns(ownerKind: ProviderSupplyOwnerKind): string {
  return ownerKind === 'tenant'
    ? WRAPPER_REVISION_COLUMNS
    : WRAPPER_REVISION_COLUMNS.replace('owner_kind, tenant_id', 'owner_kind, NULL::uuid AS tenant_id');
}

function mapWrapperRevision(row: CredentialWrapperRevisionRow): ProviderCredentialWrapperRevisionRecord {
  if (row.owner_kind !== 'tenant' && row.owner_kind !== 'platform') {
    throw repositoryError('INVALID_CREDENTIAL_WRAPPER_HISTORY');
  }
  if (row.actor_kind !== 'user' && row.actor_kind !== 'workload') {
    throw repositoryError('INVALID_CREDENTIAL_WRAPPER_HISTORY');
  }
  const tenantId = row.tenant_id === null ? null : asText(row.tenant_id);
  if ((row.owner_kind === 'tenant' && tenantId === null) || (row.owner_kind === 'platform' && tenantId !== null)) {
    throw repositoryError('INVALID_CREDENTIAL_WRAPPER_HISTORY');
  }
  return {
    ownerKind: row.owner_kind,
    tenantId,
    accountId: asText(row.account_id),
    credentialId: asText(row.credential_id),
    credentialVersion: asPositiveInteger(row.credential_version),
    expectedWrappingRevision: asPositiveInteger(row.expected_wrapping_revision),
    wrappingRevision: asPositiveInteger(row.wrapping_revision),
    operationId: asText(row.operation_id),
    sourceKmsKeyId: asText(row.source_kms_key_id),
    kmsKeyId: asText(row.kms_key_id),
    contextSha256: asText(row.context_sha256),
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id === null ? null : asText(row.actor_user_id),
    actorWorkloadId: row.actor_workload_id === null ? null : asText(row.actor_workload_id),
    requestId: asText(row.request_id),
    reasonCode: asText(row.reason_code),
    createdAt: asTimestamp(row.created_at),
  };
}

function wrapperRevisionMatchesRequest(
  record: ProviderCredentialWrapperRevisionRecord,
  input: AppendProviderCredentialWrapperRevisionInput,
): boolean {
  const audit = input.audit;
  return (
    record.ownerKind === input.credential.ownerKind &&
    record.tenantId === input.credential.tenantId &&
    record.accountId === input.credential.accountId &&
    record.credentialId === input.credential.credentialId &&
    record.credentialVersion === input.credential.version &&
    record.expectedWrappingRevision === input.expectedWrappingRevision &&
    record.operationId === input.operationId &&
    record.sourceKmsKeyId === input.sourceKmsKeyId &&
    record.kmsKeyId === input.kmsKeyId &&
    record.contextSha256 === input.contextSha256 &&
    record.actorKind === audit.actorKind &&
    record.actorUserId === (audit.actorKind === 'user' ? audit.actorUserId : null) &&
    record.actorWorkloadId === (audit.actorKind === 'workload' ? audit.actorWorkloadId : null) &&
    record.requestId === audit.requestId &&
    record.reasonCode === input.reasonCode
  );
}

const DISPATCH_IDENTITY_SQL = `
  SELECT tenant_id, project_id, principal_kind, principal_id, proxy_key_id,
         supply_mode, account_owner_kind, account_id, credential_id,
         credential_version, dispatch_profile_id, pool_id
    FROM saas_prepared_request_evidence
   WHERE id = $1`;

const DISPATCH_CORE_SQL = `
  SELECT
    e.id AS evidence_id,
    e.tenant_id AS evidence_tenant_id,
    e.request_id AS evidence_request_id,
    e.attempt_id AS evidence_attempt_id,
    e.attempt_ordinal AS evidence_attempt_ordinal,
    e.supply_profile_id AS evidence_supply_profile_id,
    e.supply_profile_version AS evidence_supply_profile_version,
    e.supply_mode AS evidence_supply_mode,
    e.account_owner_kind AS evidence_account_owner_kind,
    e.account_id AS evidence_account_id,
    e.provider_id AS evidence_provider_id,
    e.product_id AS evidence_product_id,
    e.public_model AS evidence_public_model,
    e.protocol AS evidence_protocol,
    e.endpoint AS evidence_endpoint,
    e.route_config_id AS evidence_route_config_id,
    e.route_config_version AS evidence_route_config_version,
    e.route_public_model_id AS evidence_route_public_model_id,
    e.route_public_model_version AS evidence_route_public_model_version,
    e.route_protocol AS evidence_route_protocol,
    e.route_target_mode AS evidence_route_target_mode,
    e.route_upstream_id AS evidence_route_upstream_id,
    e.upstream_id AS evidence_upstream_id,
    e.resolved_model AS evidence_resolved_model,
    e.dispatch_profile_id AS evidence_dispatch_profile_id,
    e.supply_profile_authz_version AS evidence_supply_profile_authz_version,
    e.credential_id AS evidence_credential_id,
    e.credential_version AS evidence_credential_version,
    e.credential_authz_version AS evidence_credential_authz_version,
    e.account_authz_version AS evidence_account_authz_version,
    e.profile_account_authz_version AS evidence_profile_account_authz_version,
    e.pool_id AS evidence_pool_id,
    e.pool_authz_version AS evidence_pool_authz_version,
    e.pool_member_account_authz_version AS evidence_pool_member_account_authz_version,
    e.pool_member_authz_version AS evidence_pool_member_authz_version,
    e.pool_grant_authz_version AS evidence_pool_grant_authz_version,
    e.pool_grant_profile_authz_version AS evidence_pool_grant_profile_authz_version,
    e.pool_grant_pool_authz_version AS evidence_pool_grant_pool_authz_version,
    e.status AS evidence_status,
    e.claimed_at AS evidence_claimed_at,
    e.claimed_attempt_id AS evidence_claimed_attempt_id,
    e.dispatch_deadline AS evidence_dispatch_deadline,
    e.expires_at AS evidence_expires_at,

    a.tenant_id AS attempt_tenant_id,
    a.request_id AS attempt_request_id,
    a.id AS attempt_attempt_id,
    a.ordinal AS attempt_attempt_ordinal,
    r.supply_mode AS attempt_supply_mode,
    a.account_owner_kind AS attempt_account_owner_kind,
    a.account_id AS attempt_account_id,
    a.provider_id AS attempt_provider_id,
    a.product_id AS attempt_product_id,
    a.protocol AS attempt_protocol,
    a.endpoint AS attempt_endpoint,
    a.route_config_id AS attempt_route_config_id,
    a.route_config_version AS attempt_route_config_version,
    a.route_public_model_id AS attempt_route_public_model_id,
    a.route_public_model_version AS attempt_route_public_model_version,
    a.route_protocol AS attempt_route_protocol,
    a.route_target_mode AS attempt_route_target_mode,
    r.route_upstream_id AS attempt_route_upstream_id,
    a.upstream_id AS attempt_upstream_id,
    a.resolved_model AS attempt_resolved_model,
    a.dispatch_profile_id AS attempt_dispatch_profile_id,
    a.supply_profile_authz_version AS attempt_supply_profile_authz_version,
    a.credential_id AS attempt_credential_id,
    a.credential_version AS attempt_credential_version,
    a.credential_authz_version AS attempt_credential_authz_version,
    a.account_authz_version AS attempt_account_authz_version,
    a.profile_account_authz_version AS attempt_profile_account_authz_version,
    a.pool_id AS attempt_pool_id,
    a.pool_authz_version AS attempt_pool_authz_version,
    a.pool_member_account_authz_version AS attempt_pool_member_account_authz_version,
    a.pool_member_authz_version AS attempt_pool_member_authz_version,
    a.pool_grant_authz_version AS attempt_pool_grant_authz_version,
    a.pool_grant_profile_authz_version AS attempt_pool_grant_profile_authz_version,
    a.pool_grant_pool_authz_version AS attempt_pool_grant_pool_authz_version,
    a.prepared_evidence_id AS attempt_prepared_evidence_id,
    a.dispatch_authority_state AS attempt_dispatch_authority_state,
    a.dispatch_state AS attempt_dispatch_state,
    a.result_state AS attempt_result_state,
    a.response_started AS attempt_response_started,

    sp.tenant_id AS profile_tenant_id,
    sp.id AS profile_id,
    sp.supply_mode AS profile_supply_mode,
    sp.status AS profile_status,
    sp.authz_version AS profile_authz_version,

    claim_audit.action AS claim_action,
    claim_audit.target_type AS claim_target_type,
    claim_audit.target_id AS claim_target_id
  FROM saas_prepared_request_evidence AS e
  JOIN saas_attempts AS a
    ON a.tenant_id = e.tenant_id
   AND a.id = e.attempt_id
  JOIN saas_requests AS r
    ON r.tenant_id = e.tenant_id
   AND r.id = e.request_id
  JOIN saas_supply_profiles AS sp
    ON sp.tenant_id = e.tenant_id
   AND sp.id = e.dispatch_profile_id
   AND sp.supply_mode = e.supply_mode
  JOIN saas_route_config_versions AS rv
    ON rv.tenant_id = e.tenant_id
   AND rv.project_id = e.project_id
   AND rv.route_id = e.route_config_id
   AND rv.version = e.route_config_version
  JOIN saas_route_config_heads AS rh
    ON rh.tenant_id = rv.tenant_id
   AND rh.project_id = rv.project_id
   AND rh.route_id = rv.route_id
  JOIN saas_public_model_versions AS pmv
    ON pmv.public_model_id = rv.public_model_id
   AND pmv.version = rv.public_model_version
  JOIN saas_public_models AS pm
    ON pm.id = pmv.public_model_id
  JOIN LATERAL (
    SELECT ae.action, ae.target_type, ae.target_id
      FROM saas_audit_events AS ae
     WHERE ae.tenant_id = e.tenant_id
       AND ae.action = 'saas_prepared_request_evidence.claimed'
       AND ae.target_type = 'saas_prepared_request_evidence'
       AND ae.target_id = e.id::text
     ORDER BY ae.occurred_at DESC, ae.id DESC
     LIMIT 1
  ) AS claim_audit ON TRUE
  WHERE e.id = $1
    AND e.status = 'claimed'
    AND e.claimed_at IS NOT NULL
    AND e.claimed_attempt_id = e.attempt_id
    AND e.dispatch_deadline > clock_timestamp()
    AND e.expires_at > clock_timestamp()
    AND e.supply_profile_version = e.supply_profile_authz_version
    AND a.prepared_evidence_id = e.id
    AND a.dispatch_authority_state = 'bound'
    AND a.dispatch_state = 'dispatching'
    AND a.result_state = 'pending'
    AND a.response_started = FALSE
    AND a.request_id = e.request_id
    AND a.ordinal = e.attempt_ordinal
    AND a.account_owner_kind = e.account_owner_kind
    AND a.account_id = e.account_id
    AND a.provider_id = e.provider_id
    AND a.product_id = e.product_id
    AND a.protocol = e.protocol
    AND a.endpoint = e.endpoint
    AND a.route_config_id = e.route_config_id
    AND a.route_config_version = e.route_config_version
    AND a.route_public_model_id = e.route_public_model_id
    AND a.route_public_model_version = e.route_public_model_version
    AND a.route_protocol = e.route_protocol
    AND a.route_target_mode = e.route_target_mode
    AND a.upstream_id = e.upstream_id
    AND a.resolved_model = e.resolved_model
    AND a.dispatch_profile_id = e.dispatch_profile_id
    AND a.supply_profile_authz_version = e.supply_profile_authz_version
    AND a.credential_id = e.credential_id
    AND a.credential_version = e.credential_version
    AND a.credential_authz_version = e.credential_authz_version
    AND a.account_authz_version = e.account_authz_version
    AND a.profile_account_authz_version IS NOT DISTINCT FROM e.profile_account_authz_version
    AND a.pool_id IS NOT DISTINCT FROM e.pool_id
    AND a.pool_authz_version IS NOT DISTINCT FROM e.pool_authz_version
    AND a.pool_member_account_authz_version IS NOT DISTINCT FROM e.pool_member_account_authz_version
    AND a.pool_member_authz_version IS NOT DISTINCT FROM e.pool_member_authz_version
    AND a.pool_grant_authz_version IS NOT DISTINCT FROM e.pool_grant_authz_version
    AND a.pool_grant_profile_authz_version IS NOT DISTINCT FROM e.pool_grant_profile_authz_version
    AND a.pool_grant_pool_authz_version IS NOT DISTINCT FROM e.pool_grant_pool_authz_version
    AND r.project_id = e.project_id
    AND r.supply_profile_id = e.supply_profile_id
    AND r.supply_profile_version = e.supply_profile_version
    AND r.model_scope_version = e.model_scope_version
    AND r.supply_mode = e.supply_mode
    AND r.public_model = e.public_model
    AND r.protocol = e.protocol
    AND r.endpoint = e.endpoint
    AND r.config_version = e.route_config_version
    AND r.route_config_id = e.route_config_id
    AND r.route_config_version = e.route_config_version
    AND r.route_public_model_id = e.route_public_model_id
    AND r.route_public_model_version = e.route_public_model_version
    AND r.route_protocol = e.route_protocol
    AND r.route_target_mode = e.route_target_mode
    AND r.route_upstream_id = e.route_upstream_id
    AND sp.status = 'active'
    AND sp.authz_version = e.supply_profile_authz_version
    AND rv.status = 'active'
    AND rh.status = 'active'
    AND rh.current_version = e.route_config_version
    AND rv.public_model_id = e.route_public_model_id
    AND rv.public_model_version = e.route_public_model_version
    AND rv.protocol = e.route_protocol
    AND rv.supply_mode = e.supply_mode
    AND rv.target_mode = e.route_target_mode
    AND rv.upstream_id = e.route_upstream_id
    AND rv.endpoint = e.endpoint
    AND pm.alias = e.public_model
    AND pm.status = 'active'
    AND pmv.status = 'active'
    AND pmv.public_model_id = e.route_public_model_id
    AND pmv.version = e.route_public_model_version
    AND (
      (
        e.supply_mode = 'byok'
        AND e.account_owner_kind = 'tenant'
        AND e.route_target_mode = 'tenant_account'
        AND e.profile_account_authz_version IS NOT NULL
        AND e.pool_id IS NULL
        AND e.pool_authz_version IS NULL
        AND e.pool_member_account_authz_version IS NULL
        AND e.pool_member_authz_version IS NULL
        AND e.pool_grant_authz_version IS NULL
        AND e.pool_grant_profile_authz_version IS NULL
        AND e.pool_grant_pool_authz_version IS NULL
      )
      OR (
        e.supply_mode = 'platform'
        AND e.account_owner_kind = 'platform'
        AND e.route_target_mode = 'platform_pool'
        AND e.profile_account_authz_version IS NULL
        AND e.pool_id IS NOT NULL
        AND e.pool_authz_version IS NOT NULL
        AND e.pool_member_account_authz_version IS NOT NULL
        AND e.pool_member_authz_version IS NOT NULL
        AND e.pool_grant_authz_version IS NOT NULL
        AND e.pool_grant_profile_authz_version IS NOT NULL
        AND e.pool_grant_pool_authz_version IS NOT NULL
      )
    )
`;

const TENANT_DISPATCH_AUTHORITY_SQL = `
  SELECT
    a.owner_kind AS account_owner_kind,
    a.tenant_id AS account_tenant_id,
    a.supply_mode AS account_supply_mode,
    a.id AS account_id,
    a.provider_id AS account_provider_id,
    a.product_id AS account_product_id,
    a.credential_type AS account_credential_type,
    a.purpose AS account_purpose,
    a.status AS account_status,
    a.validation_state AS account_validation_state,
    a.authz_version AS account_authz_version,
    c.owner_kind AS credential_owner_kind,
    c.tenant_id AS credential_tenant_id,
    c.supply_mode AS credential_supply_mode,
    c.id AS credential_id,
    c.account_id AS credential_account_id,
    c.provider_id AS credential_provider_id,
    c.product_id AS credential_product_id,
    c.status AS credential_status,
    c.validation_state AS credential_validation_state,
    c.current_version AS credential_current_version,
    c.expires_at AS credential_expires_at,
    c.authz_version AS credential_authz_version,
    v.owner_kind AS version_owner_kind,
    v.tenant_id AS version_tenant_id,
    v.supply_mode AS version_supply_mode,
    v.account_id AS version_account_id,
    v.credential_id AS version_credential_id,
    v.version AS version_number,
    v.status AS version_status,
    v.schema_version AS version_schema_version,
    v.context_version AS version_context_version,
    v.algorithm AS version_algorithm,
    v.kms_purpose AS version_kms_purpose,
    COALESCE(wrapping.kms_key_id, v.kms_key_id) AS version_kms_key_id,
    COALESCE(wrapping.wrapping_revision, v.wrapping_revision) AS version_wrapping_revision,
    COALESCE(wrapping.wrapped_dek, v.wrapped_dek) AS version_wrapped_dek,
    v.nonce AS version_nonce,
    v.ciphertext AS version_ciphertext,
    v.auth_tag AS version_auth_tag,
    v.created_at AS version_created_at,
    v.expires_at AS version_expires_at,
    v.retired_at AS version_retired_at,
    v.revoked_at AS version_revoked_at,
    m.tenant_id AS profile_account_tenant_id,
    m.supply_profile_id AS profile_account_supply_profile_id,
    m.supply_mode AS profile_account_supply_mode,
    m.account_id AS profile_account_id,
    m.provider_id AS profile_account_provider_id,
    m.product_id AS profile_account_product_id,
    m.account_authz_version AS profile_account_account_authz_version,
    m.status AS profile_account_status,
    m.authz_version AS profile_account_authz_version,
    m.effective_at AS profile_account_effective_at,
    m.expires_at AS profile_account_expires_at
  FROM saas_tenant_provider_accounts AS a
  JOIN saas_tenant_provider_credentials AS c
    ON c.tenant_id = a.tenant_id
   AND c.account_id = a.id
   AND c.provider_id = a.provider_id
   AND c.product_id = a.product_id
  JOIN saas_tenant_provider_credential_versions AS v
    ON v.tenant_id = c.tenant_id
   AND v.account_id = c.account_id
   AND v.credential_id = c.id
   AND v.version = $7
  LEFT JOIN LATERAL (
    SELECT kms_key_id, wrapping_revision, wrapped_dek
      FROM saas_tenant_provider_credential_wrappings
     WHERE tenant_id = v.tenant_id AND account_id = v.account_id
       AND credential_id = v.credential_id AND credential_version = v.version
     ORDER BY wrapping_revision DESC
     LIMIT 1
  ) AS wrapping ON TRUE
  JOIN saas_tenant_provider_supply_profile_accounts AS m
    ON m.tenant_id = $1
   AND m.supply_profile_id = $9
   AND m.account_id = $2
  WHERE a.tenant_id = $1
    AND a.id = $2
    AND a.provider_id = $3
    AND a.product_id = $4
    AND a.status = 'active'
    AND a.validation_state = 'verified'
    AND a.authz_version = $5
    AND c.tenant_id = $1
    AND c.id = $6
    AND c.account_id = $2
    AND c.provider_id = $3
    AND c.product_id = $4
    AND c.status = 'active'
    AND c.validation_state = 'verified'
    AND c.current_version = $7
    AND c.authz_version = $8
    AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
    AND v.owner_kind = 'tenant'
    AND v.supply_mode = 'byok'
    AND v.status = 'active'
    AND v.account_id = $2
    AND v.credential_id = $6
    AND (v.expires_at IS NULL OR v.expires_at > clock_timestamp())
    AND m.provider_id = $3
    AND m.product_id = $4
    AND m.supply_mode = 'byok'
    AND m.status = 'active'
    AND m.authz_version = $10
    AND m.account_authz_version = $5
    AND m.effective_at <= clock_timestamp()
    AND (m.expires_at IS NULL OR m.expires_at > clock_timestamp())
`;

const PLATFORM_DISPATCH_AUTHORITY_SQL = `
  SELECT
    a.owner_kind AS account_owner_kind,
    NULL::uuid AS account_tenant_id,
    a.supply_mode AS account_supply_mode,
    a.id AS account_id,
    a.provider_id AS account_provider_id,
    a.product_id AS account_product_id,
    a.credential_type AS account_credential_type,
    a.purpose AS account_purpose,
    a.status AS account_status,
    a.validation_state AS account_validation_state,
    a.authz_version AS account_authz_version,
    c.owner_kind AS credential_owner_kind,
    NULL::uuid AS credential_tenant_id,
    c.supply_mode AS credential_supply_mode,
    c.id AS credential_id,
    c.account_id AS credential_account_id,
    c.provider_id AS credential_provider_id,
    c.product_id AS credential_product_id,
    c.status AS credential_status,
    c.validation_state AS credential_validation_state,
    c.current_version AS credential_current_version,
    c.expires_at AS credential_expires_at,
    c.authz_version AS credential_authz_version,
    v.owner_kind AS version_owner_kind,
    NULL::uuid AS version_tenant_id,
    v.supply_mode AS version_supply_mode,
    v.account_id AS version_account_id,
    v.credential_id AS version_credential_id,
    v.version AS version_number,
    v.status AS version_status,
    v.schema_version AS version_schema_version,
    v.context_version AS version_context_version,
    v.algorithm AS version_algorithm,
    v.kms_purpose AS version_kms_purpose,
    COALESCE(wrapping.kms_key_id, v.kms_key_id) AS version_kms_key_id,
    COALESCE(wrapping.wrapping_revision, v.wrapping_revision) AS version_wrapping_revision,
    COALESCE(wrapping.wrapped_dek, v.wrapped_dek) AS version_wrapped_dek,
    v.nonce AS version_nonce,
    v.ciphertext AS version_ciphertext,
    v.auth_tag AS version_auth_tag,
    v.created_at AS version_created_at,
    v.expires_at AS version_expires_at,
    v.retired_at AS version_retired_at,
    v.revoked_at AS version_revoked_at,
    pool.id AS pool_id,
    pool.provider_id AS pool_provider_id,
    pool.product_id AS pool_product_id,
    pool.status AS pool_status,
    pool.validation_state AS pool_validation_state,
    pool.authz_version AS pool_authz_version,
    member.pool_id AS member_pool_id,
    member.account_id AS member_account_id,
    member.provider_id AS member_provider_id,
    member.product_id AS member_product_id,
    member.account_authz_version AS member_account_authz_version,
    member.authz_version AS member_authz_version,
    member.status AS member_status,
    grant_record.pool_id AS grant_pool_id,
    grant_record.tenant_id AS grant_tenant_id,
    grant_record.supply_profile_id AS grant_supply_profile_id,
    grant_record.supply_mode AS grant_supply_mode,
    grant_record.profile_authz_version AS grant_profile_authz_version,
    grant_record.pool_authz_version AS grant_pool_authz_version,
    grant_record.authz_version AS grant_authz_version,
    grant_record.status AS grant_status,
    grant_record.effective_at AS grant_effective_at,
    grant_record.expires_at AS grant_expires_at
  FROM saas_platform_provider_accounts AS a
  JOIN saas_platform_provider_credentials AS c
    ON c.account_id = a.id
   AND c.provider_id = a.provider_id
   AND c.product_id = a.product_id
  JOIN saas_platform_provider_credential_versions AS v
    ON v.account_id = c.account_id
   AND v.credential_id = c.id
   AND v.version = $6
  LEFT JOIN LATERAL (
    SELECT kms_key_id, wrapping_revision, wrapped_dek
      FROM saas_platform_provider_credential_wrappings
     WHERE account_id = v.account_id
       AND credential_id = v.credential_id AND credential_version = v.version
     ORDER BY wrapping_revision DESC
     LIMIT 1
  ) AS wrapping ON TRUE
  JOIN saas_platform_provider_pools AS pool
    ON pool.id = $8
  JOIN saas_platform_provider_pool_members AS member
    ON member.pool_id = pool.id
   AND member.account_id = a.id
  JOIN saas_platform_provider_pool_grants AS grant_record
    ON grant_record.pool_id = pool.id
   AND grant_record.tenant_id = $13
   AND grant_record.supply_profile_id = $12
  WHERE a.id = $1
    AND a.provider_id = $2
    AND a.product_id = $3
    AND a.status = 'active'
    AND a.validation_state = 'verified'
    AND a.authz_version = $4
    AND c.id = $5
    AND c.account_id = $1
    AND c.provider_id = $2
    AND c.product_id = $3
    AND c.status = 'active'
    AND c.validation_state = 'verified'
    AND c.current_version = $6
    AND c.authz_version = $7
    AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
    AND v.owner_kind = 'platform'
    AND v.supply_mode = 'platform'
    AND v.status = 'active'
    AND v.account_id = $1
    AND v.credential_id = $5
    AND (v.expires_at IS NULL OR v.expires_at > clock_timestamp())
    AND pool.provider_id = $2
    AND pool.product_id = $3
    AND pool.status = 'active'
    AND pool.validation_state = 'verified'
    AND pool.authz_version = $9
    AND member.account_id = $1
    AND member.provider_id = $2
    AND member.product_id = $3
    AND member.status = 'active'
    AND member.account_authz_version = $10
    AND member.authz_version = $11
    AND grant_record.supply_mode = 'platform'
    AND grant_record.status = 'active'
    AND grant_record.profile_authz_version = $14
    AND grant_record.pool_authz_version = $16
    AND grant_record.authz_version = $15
    AND grant_record.effective_at <= clock_timestamp()
    AND (grant_record.expires_at IS NULL OR grant_record.expires_at > clock_timestamp())
`;

function repositoryError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

function asPositiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw repositoryError('INVALID_STORED_VERSION');
  return result;
}

function asNullablePositiveInteger(value: unknown): number | null {
  return value === null ? null : asPositiveInteger(value);
}

function asText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw repositoryError('INVALID_STORED_TEXT');
  return value;
}

function asTimestamp(value: unknown): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw repositoryError('INVALID_STORED_TIMESTAMP');
  return date.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : asTimestamp(value);
}

function accountStatus(value: unknown): ProviderAccountStatus {
  if (value === 'pending' || value === 'active' || value === 'disabled' || value === 'revoked') return value;
  throw repositoryError('INVALID_STORED_ACCOUNT_STATUS');
}

function credentialStatus(value: unknown): ProviderCredentialRecord['status'] {
  if (value === 'pending' || value === 'active' || value === 'disabled' || value === 'revoked') return value;
  throw repositoryError('INVALID_STORED_CREDENTIAL_STATUS');
}

function validationState(value: unknown): ProviderValidationState {
  if (value === 'unverified' || value === 'verified' || value === 'failed') return value;
  throw repositoryError('INVALID_STORED_VALIDATION_STATE');
}

function credentialValidationJobState(value: unknown): ProviderCredentialValidationJobState {
  if (value === 'queued' || value === 'leased' || value === 'verified' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw repositoryError('INVALID_CREDENTIAL_VALIDATION_JOB');
}

function nonnegativeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw repositoryError('INVALID_CREDENTIAL_VALIDATION_JOB');
  return parsed;
}

function mapCredentialValidationJob(row: CredentialValidationJobRow): ProviderCredentialValidationJobRecord {
  if (!Array.isArray(row.allowed_models) || row.allowed_models.length === 0) {
    throw repositoryError('INVALID_CREDENTIAL_VALIDATION_JOB');
  }
  return {
    id: asText(row.id),
    tenantId: asText(row.tenant_id),
    accountId: asText(row.account_id),
    credentialId: asText(row.credential_id),
    credentialVersion: asPositiveInteger(row.credential_version),
    providerId: asText(row.provider_id),
    productId: asText(row.product_id),
    credentialType: asText(row.credential_type),
    allowedModels: row.allowed_models.map(asText),
    target: {
      model: asText(row.target_model),
      endpoint: asText(row.target_endpoint),
      version: asPositiveInteger(row.capability_version),
    },
    idempotencyKey: asText(row.idempotency_key),
    state: credentialValidationJobState(row.status),
    attemptCount: nonnegativeInteger(row.attempt_count),
    availableAt: asTimestamp(row.available_at),
    leaseUntil: nullableTimestamp(row.lease_until),
    leaseGeneration: nonnegativeInteger(row.lease_generation),
    lastErrorCode: row.last_error_code === null ? null : asText(row.last_error_code),
    completedAt: nullableTimestamp(row.completed_at),
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
  };
}

function sameValidationJobSnapshot(
  job: ProviderCredentialValidationJobRecord,
  input: ProviderCredentialValidationJobInput,
): boolean {
  const allowedModels = [...input.allowedModels].sort();
  return (
    job.tenantId === input.tenantId &&
    job.accountId === input.accountId &&
    job.credentialId === input.credentialId &&
    job.credentialVersion === input.credentialVersion &&
    job.providerId === input.providerId &&
    job.productId === input.productId &&
    job.credentialType === input.credentialType &&
    job.idempotencyKey === input.idempotencyKey &&
    job.target.model === input.target.model &&
    job.target.endpoint === input.target.endpoint &&
    job.target.version === input.target.version &&
    job.allowedModels.length === allowedModels.length &&
    job.allowedModels.every((model, index) => model === allowedModels[index])
  );
}

function versionStatus(value: unknown): ProviderCredentialVersionStatus {
  if (value === 'active' || value === 'retired' || value === 'revoked') return value;
  throw repositoryError('INVALID_STORED_VERSION_STATUS');
}

function ownerFromRow(row: { owner_kind: string; tenant_id: string | null; supply_mode: string }): ProviderSupplyOwner {
  if (row.owner_kind === 'tenant' && row.supply_mode === 'byok' && typeof row.tenant_id === 'string') {
    return { ownerKind: 'tenant', tenantId: row.tenant_id, supplyMode: 'byok' };
  }
  if (row.owner_kind === 'platform' && row.supply_mode === 'platform' && row.tenant_id === null) {
    return { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' };
  }
  throw repositoryError('INVALID_STORED_OWNER');
}

function accountReferenceFromRow(row: AccountRow): ValidProviderAccountReference {
  return row.owner_kind === 'tenant'
    ? { ownerKind: 'tenant', tenantId: row.tenant_id, accountId: row.id }
    : { ownerKind: 'platform', tenantId: null, accountId: row.id };
}

function mapAccount(row: AccountRow, capabilities: readonly CapabilityRow[]): ProviderAccountRecord {
  const owner = ownerFromRow(row);
  return {
    ...owner,
    id: asText(row.id),
    displayName: asText(row.display_name),
    providerId: asText(row.provider_id),
    productId: asText(row.product_id),
    credentialType: asText(row.credential_type),
    region: asText(row.region),
    purpose: asText(row.purpose),
    rightsId: asText(row.rights_id),
    rightsVersion: asPositiveInteger(row.rights_version),
    capabilities: capabilities.map((capability) => ({
      model: asText(capability.model),
      endpoint: asText(capability.endpoint),
      version: asPositiveInteger(capability.capability_version),
    })),
    status: accountStatus(row.status),
    validationState: validationState(row.validation_state),
    validationErrorCode: row.validation_error_code,
    lastValidatedAt: nullableTimestamp(row.last_validated_at),
    authzVersion: asPositiveInteger(row.authz_version),
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
    disabledAt: nullableTimestamp(row.disabled_at),
    revokedAt: nullableTimestamp(row.revoked_at),
  };
}

function mapCredential(row: CredentialRow): ProviderCredentialRecord {
  const owner = ownerFromRow(row);
  return {
    ...owner,
    id: asText(row.id),
    accountId: asText(row.account_id),
    providerId: asText(row.provider_id),
    productId: asText(row.product_id),
    credentialType: asText(row.credential_type),
    status: credentialStatus(row.status),
    validationState: validationState(row.validation_state),
    validationErrorCode: row.validation_error_code,
    lastValidatedAt: nullableTimestamp(row.last_validated_at),
    currentVersion: asNullablePositiveInteger(row.current_version),
    expiresAt: nullableTimestamp(row.expires_at),
    authzVersion: asPositiveInteger(row.authz_version),
    createdAt: asTimestamp(row.created_at),
    updatedAt: asTimestamp(row.updated_at),
    disabledAt: nullableTimestamp(row.disabled_at),
    revokedAt: nullableTimestamp(row.revoked_at),
  };
}

function mapVersion(row: CredentialVersionRow): StoredProviderCredentialVersion {
  const owner = ownerFromRow(row);
  const schemaVersion = asPositiveInteger(row.schema_version);
  const contextVersion = asPositiveInteger(row.context_version);
  const version = asPositiveInteger(row.version);
  const status = versionStatus(row.status);
  const algorithm = asText(row.algorithm);
  const kmsPurpose = asText(row.kms_purpose);
  const kmsKeyId = asText(row.kms_key_id);
  const wrappedDek = asText(row.wrapped_dek);
  const nonce = asText(row.nonce);
  const ciphertext = asText(row.ciphertext);
  const authTag = asText(row.auth_tag);
  return {
    ...owner,
    accountId: asText(row.account_id),
    credentialId: asText(row.credential_id),
    version,
    status,
    envelopeSchemaVersion: schemaVersion,
    contextVersion,
    algorithm,
    kmsPurpose,
    wrappingRevision: asPositiveInteger(row.wrapping_revision),
    createdAt: asTimestamp(row.created_at),
    expiresAt: nullableTimestamp(row.expires_at),
    retiredAt: nullableTimestamp(row.retired_at),
    revokedAt: nullableTimestamp(row.revoked_at),
    kmsKeyId,
    envelope: {
      schemaVersion: schemaVersion as ProviderCredentialEnvelope['schemaVersion'],
      contextVersion: contextVersion as ProviderCredentialEnvelope['contextVersion'],
      algorithm: algorithm as ProviderCredentialEnvelope['algorithm'],
      kmsKeyId,
      wrappedDek,
      nonce,
      ciphertext,
      authTag,
    },
  };
}

function publicVersion(record: StoredProviderCredentialVersion): ProviderCredentialVersionRecord {
  return {
    ownerKind: record.ownerKind,
    tenantId: record.tenantId,
    accountId: record.accountId,
    credentialId: record.credentialId,
    version: record.version,
    status: record.status,
    envelopeSchemaVersion: record.envelopeSchemaVersion,
    contextVersion: record.contextVersion,
    algorithm: record.algorithm,
    kmsPurpose: record.kmsPurpose,
    wrappingRevision: record.wrappingRevision,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    retiredAt: record.retiredAt,
    revokedAt: record.revokedAt,
  };
}

function accountTable(ownerKind: ProviderSupplyOwnerKind): typeof TENANT_ACCOUNT_TABLE | typeof PLATFORM_ACCOUNT_TABLE {
  return ownerKind === 'tenant' ? TENANT_ACCOUNT_TABLE : PLATFORM_ACCOUNT_TABLE;
}

function accountCapabilityTable(
  ownerKind: ProviderSupplyOwnerKind,
): typeof TENANT_ACCOUNT_CAPABILITY_TABLE | typeof PLATFORM_ACCOUNT_CAPABILITY_TABLE {
  return ownerKind === 'tenant' ? TENANT_ACCOUNT_CAPABILITY_TABLE : PLATFORM_ACCOUNT_CAPABILITY_TABLE;
}

function credentialTable(
  ownerKind: ProviderSupplyOwnerKind,
): typeof TENANT_CREDENTIAL_TABLE | typeof PLATFORM_CREDENTIAL_TABLE {
  return ownerKind === 'tenant' ? TENANT_CREDENTIAL_TABLE : PLATFORM_CREDENTIAL_TABLE;
}

function versionTable(ownerKind: ProviderSupplyOwnerKind): typeof TENANT_VERSION_TABLE | typeof PLATFORM_VERSION_TABLE {
  return ownerKind === 'tenant' ? TENANT_VERSION_TABLE : PLATFORM_VERSION_TABLE;
}

type ValidProviderAccountReference =
  | (ProviderAccountReference & { readonly ownerKind: 'tenant'; readonly tenantId: string })
  | (ProviderAccountReference & { readonly ownerKind: 'platform'; readonly tenantId: null });

function assertReference(reference: ProviderAccountReference): asserts reference is ValidProviderAccountReference {
  if (
    !reference ||
    (reference.ownerKind !== 'tenant' && reference.ownerKind !== 'platform') ||
    typeof reference.accountId !== 'string' ||
    reference.accountId.trim() === '' ||
    (reference.ownerKind === 'tenant' && typeof reference.tenantId !== 'string') ||
    (reference.ownerKind === 'platform' && reference.tenantId !== null)
  ) {
    throw repositoryError('INVALID_REFERENCE');
  }
}

function accountPredicate(
  reference: ProviderAccountReference,
  startIndex: number,
): {
  readonly sql: string;
  readonly values: readonly unknown[];
} {
  assertReference(reference);
  if (reference.ownerKind === 'tenant') {
    return {
      sql: `tenant_id = $${startIndex} AND id = $${startIndex + 1}`,
      values: [reference.tenantId, reference.accountId],
    };
  }
  return { sql: `id = $${startIndex}`, values: [reference.accountId] };
}

function credentialPredicate(
  reference: ProviderCredentialReference,
  startIndex: number,
): {
  readonly sql: string;
  readonly values: readonly unknown[];
} {
  assertReference(reference);
  if (typeof reference.credentialId !== 'string' || reference.credentialId.trim() === '') {
    throw repositoryError('INVALID_REFERENCE');
  }
  if (reference.ownerKind === 'tenant') {
    return {
      sql: `tenant_id = $${startIndex} AND account_id = $${startIndex + 1} AND id = $${startIndex + 2}`,
      values: [reference.tenantId, reference.accountId, reference.credentialId],
    };
  }
  return {
    sql: `account_id = $${startIndex} AND id = $${startIndex + 1}`,
    values: [reference.accountId, reference.credentialId],
  };
}

function versionPredicate(
  reference: ProviderCredentialReference & { readonly version: number },
  startIndex: number,
): {
  readonly sql: string;
  readonly values: readonly unknown[];
} {
  if (!Number.isSafeInteger(reference.version) || reference.version < 1) throw repositoryError('INVALID_REFERENCE');
  const predicate = versionCredentialPredicate(reference, startIndex);
  return {
    sql: `${predicate.sql} AND version = $${startIndex + predicate.values.length}`,
    values: [...predicate.values, reference.version],
  };
}

function versionCredentialPredicate(
  reference: ProviderCredentialReference,
  startIndex: number,
): {
  readonly sql: string;
  readonly values: readonly unknown[];
} {
  assertReference(reference);
  if (typeof reference.credentialId !== 'string' || reference.credentialId.trim() === '') {
    throw repositoryError('INVALID_REFERENCE');
  }
  if (reference.ownerKind === 'tenant') {
    return {
      sql: `tenant_id = $${startIndex} AND account_id = $${startIndex + 1} AND credential_id = $${startIndex + 2}`,
      values: [reference.tenantId, reference.accountId, reference.credentialId],
    };
  }
  return {
    sql: `account_id = $${startIndex} AND credential_id = $${startIndex + 1}`,
    values: [reference.accountId, reference.credentialId],
  };
}

function dispatchReadLockLayers(identity: DispatchIdentityRow): readonly (readonly string[])[] {
  const ownerKind = dispatchOwnerKind(identity.account_owner_kind);
  const credentialReference: ProviderCredentialReference = {
    ownerKind,
    tenantId: ownerKind === 'tenant' ? identity.tenant_id : null,
    accountId: identity.account_id,
    credentialId: identity.credential_id,
  };
  const versionReference = {
    ...credentialReference,
    version: asPositiveInteger(identity.credential_version),
  } as ProviderCredentialReference & { readonly version: number };
  const poolKeys = identity.pool_id === null ? [] : [saasAdvisoryKey.platformPool(identity.pool_id)];
  const profileKeys = [saasAdvisoryKey.supplyProfile(identity.tenant_id, identity.dispatch_profile_id)];
  const mappingKeys =
    ownerKind === 'tenant'
      ? [saasAdvisoryKey.supplyProfileAccount(identity.tenant_id, identity.dispatch_profile_id, identity.account_id)]
      : [];
  return [
    [saasAdvisoryKey.tenant(identity.tenant_id)],
    [saasAdvisoryKey.project(identity.tenant_id, identity.project_id)],
    identity.principal_kind === 'member' ? [saasAdvisoryKey.user(identity.principal_id)] : [],
    [saasAdvisoryKey.apiKey(identity.tenant_id, identity.project_id, identity.proxy_key_id)],
    poolKeys,
    profileKeys,
    [providerAccountAdvisoryKey(providerAccountReference(credentialReference))],
    [providerCredentialAdvisoryKey(credentialReference)],
    [credentialVersionAdvisoryKey(versionReference)],
    mappingKeys,
    ownerKind === 'platform' ? poolKeys : [],
    ownerKind === 'platform' ? profileKeys : [],
  ];
}

export class PostgresProviderSupplyRepository implements ProviderSupplyRepository {
  private readonly executor: SqlExecutor;
  private readonly inTransaction: boolean;

  constructor(
    private readonly database: SaasDatabase,
    executor?: SqlExecutor,
    inTransaction = false,
  ) {
    this.executor = executor ?? database;
    this.inTransaction = inTransaction;
  }

  async transaction<T>(work: (repository: ProviderSupplyRepository, executor?: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.executor !== this.database || this.inTransaction) return work(this, this.executor);
    return this.database.transaction(async (executor) =>
      work(new PostgresProviderSupplyRepository(this.database, executor, true), executor),
    );
  }

  async readDispatchProof(evidenceId: string): Promise<ProviderCredentialDispatchProof | null> {
    if (
      typeof evidenceId !== 'string' ||
      evidenceId.length === 0 ||
      evidenceId.trim() !== evidenceId ||
      evidenceId.includes('\u0000') ||
      Buffer.byteLength(evidenceId, 'utf8') > 256
    ) {
      throw repositoryError('INVALID_REFERENCE');
    }

    return this.database.transaction(async (tx) => {
      const identityResult = await tx.query<DispatchIdentityRow>(DISPATCH_IDENTITY_SQL, [evidenceId]);
      const identity = identityResult.rows[0];
      if (!identity) return null;
      await lockAdvisoryLayers(tx, dispatchReadLockLayers(identity), 'shared');

      const coreResult = await tx.query<DispatchRow>(DISPATCH_CORE_SQL, [evidenceId]);
      if (coreResult.rows.length !== 1) return null;
      const core = coreResult.rows[0];
      if (!core) return null;

      const evidence = mapDispatchEvidence(core);
      const attempt = mapDispatchAttempt(core);
      const profile = mapDispatchProfile(core);
      const claimAudit = mapDispatchClaimAudit(core);
      const authorityValues =
        evidence.accountOwnerKind === 'tenant'
          ? (() => {
              if (evidence.profileAccountAuthzVersion === null) return null;
              return [
                evidence.tenantId,
                evidence.accountId,
                evidence.providerId,
                evidence.productId,
                evidence.accountAuthzVersion,
                evidence.credentialId,
                evidence.credentialVersion,
                evidence.credentialAuthzVersion,
                evidence.dispatchProfileId,
                evidence.profileAccountAuthzVersion,
              ] as const;
            })()
          : (() => {
              if (
                evidence.poolId === null ||
                evidence.poolAuthzVersion === null ||
                evidence.poolMemberAccountAuthzVersion === null ||
                evidence.poolMemberAuthzVersion === null ||
                evidence.poolGrantAuthzVersion === null ||
                evidence.poolGrantProfileAuthzVersion === null ||
                evidence.poolGrantPoolAuthzVersion === null
              ) {
                return null;
              }
              return [
                evidence.accountId,
                evidence.providerId,
                evidence.productId,
                evidence.accountAuthzVersion,
                evidence.credentialId,
                evidence.credentialVersion,
                evidence.credentialAuthzVersion,
                evidence.poolId,
                evidence.poolAuthzVersion,
                evidence.poolMemberAccountAuthzVersion,
                evidence.poolMemberAuthzVersion,
                evidence.dispatchProfileId,
                evidence.tenantId,
                evidence.poolGrantProfileAuthzVersion,
                evidence.poolGrantAuthzVersion,
                evidence.poolGrantPoolAuthzVersion,
              ] as const;
            })();
      if (authorityValues === null) return null;

      const authorityResult = await tx.query<DispatchRow>(
        evidence.accountOwnerKind === 'tenant' ? TENANT_DISPATCH_AUTHORITY_SQL : PLATFORM_DISPATCH_AUTHORITY_SQL,
        authorityValues,
      );
      if (authorityResult.rows.length !== 1) return null;
      const authority = authorityResult.rows[0];
      if (!authority) return null;

      return {
        evidence,
        attempt,
        account: mapDispatchAccount(authority),
        credential: mapDispatchCredential(authority),
        version: mapDispatchVersion(authority),
        profile,
        profileAccount: evidence.accountOwnerKind === 'tenant' ? mapDispatchProfileAccount(authority) : null,
        pool: evidence.accountOwnerKind === 'platform' ? mapDispatchPool(authority) : null,
        poolMember: evidence.accountOwnerKind === 'platform' ? mapDispatchPoolMember(authority) : null,
        poolGrant: evidence.accountOwnerKind === 'platform' ? mapDispatchPoolGrant(authority) : null,
        claimAudit,
      };
    });
  }

  private async query<Row>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    return (await this.executor.query<Row>(sql, values)).rows;
  }

  async appendAuditEvent(input: AppendProviderSupplyAuditEventInput): Promise<void> {
    await this.query(
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
          source_ip, user_agent, entry_point, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        input.tenantId,
        input.audit.actorUserId,
        input.action,
        input.targetType,
        input.targetId,
        input.occurredAt,
        input.audit.sourceIp ?? null,
        input.audit.userAgent ?? null,
        input.audit.entryPoint,
        input.audit.requestId ?? null,
      ],
    );
  }

  private async accountCapabilities(
    account: ProviderAccountReference,
    providerId: string,
    productId: string,
  ): Promise<CapabilityRow[]> {
    const table = accountCapabilityTable(account.ownerKind);
    if (account.ownerKind === 'tenant') {
      return this.query<CapabilityRow>(
        `SELECT model, endpoint, capability_version
         FROM ${table}
         WHERE tenant_id = $1 AND account_id = $2 AND provider_id = $3 AND product_id = $4
         ORDER BY model, endpoint, capability_version`,
        [account.tenantId, account.accountId, providerId, productId],
      );
    }
    return this.query<CapabilityRow>(
      `SELECT model, endpoint, capability_version
       FROM ${table}
       WHERE account_id = $1 AND provider_id = $2 AND product_id = $3
       ORDER BY model, endpoint, capability_version`,
      [account.accountId, providerId, productId],
    );
  }

  async createAccount(input: PersistedProviderAccountInput): Promise<ProviderAccountRecord> {
    const account = {
      ownerKind: input.owner.ownerKind,
      tenantId: input.owner.tenantId,
      accountId: input.id,
    } satisfies ProviderAccountReference;
    await lockAdvisoryLayers(
      this.executor,
      [
        input.owner.ownerKind === 'tenant' ? [saasAdvisoryKey.tenant(input.owner.tenantId)] : [],
        [providerAccountAdvisoryKey(account)],
      ],
      'exclusive',
    );
    const table = accountTable(input.owner.ownerKind);
    const values =
      input.owner.ownerKind === 'tenant'
        ? [
            input.owner.tenantId,
            input.id,
            input.displayName,
            input.providerId,
            input.productId,
            input.credentialType,
            input.region,
            input.purpose,
            input.rightsId,
            input.rightsVersion,
            input.status,
            input.validationState,
            input.createdAt,
            input.updatedAt,
          ]
        : [
            input.id,
            input.displayName,
            input.providerId,
            input.productId,
            input.credentialType,
            input.region,
            input.purpose,
            input.rightsId,
            input.rightsVersion,
            input.status,
            input.validationState,
            input.createdAt,
            input.updatedAt,
          ];
    const columns =
      input.owner.ownerKind === 'tenant'
        ? '(tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version, status, validation_state, created_at, updated_at)'
        : '(id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version, status, validation_state, created_at, updated_at)';
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    await this.query<AccountRow>(
      `INSERT INTO ${table} ${columns}
       VALUES (${placeholders})`,
      values,
    );

    for (const capability of input.capabilities) {
      const capabilityTable = accountCapabilityTable(input.owner.ownerKind);
      const capabilityValues =
        input.owner.ownerKind === 'tenant'
          ? [
              input.owner.tenantId,
              input.id,
              input.providerId,
              input.productId,
              capability.model,
              capability.endpoint,
              capability.version,
              input.createdAt,
            ]
          : [
              input.id,
              input.providerId,
              input.productId,
              capability.model,
              capability.endpoint,
              capability.version,
              input.createdAt,
            ];
      const capabilityColumns =
        input.owner.ownerKind === 'tenant'
          ? '(tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version, created_at)'
          : '(account_id, provider_id, product_id, model, endpoint, capability_version, created_at)';
      const capabilityPlaceholders = capabilityValues.map((_, index) => `$${index + 1}`).join(', ');
      await this.query(
        `INSERT INTO ${capabilityTable} ${capabilityColumns}
         VALUES (${capabilityPlaceholders})`,
        capabilityValues,
      );
    }
    const result = await this.getAccount(account);
    if (!result) throw repositoryError('ACCOUNT_INSERT_FAILED');
    return result;
  }

  async createTenantByokProfileAccount(input: PersistedTenantByokProfileAccountInput): Promise<void> {
    await lockAdvisoryLayers(
      this.executor,
      [
        [saasAdvisoryKey.tenant(input.tenantId)],
        [saasAdvisoryKey.supplyProfile(input.tenantId, input.supplyProfileId)],
        [saasAdvisoryKey.tenantProviderAccount(input.tenantId, input.accountId)],
        [saasAdvisoryKey.supplyProfileAccount(input.tenantId, input.supplyProfileId, input.accountId)],
      ],
      'exclusive',
    );
    const profiles = await this.query<{ readonly status: string; readonly supply_mode: string }>(
      `SELECT status, supply_mode
         FROM saas_supply_profiles
        WHERE tenant_id = $1 AND id = $2 AND supply_mode = 'byok'
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.supplyProfileId],
    );
    if (profiles.length !== 1 || profiles[0]?.status !== 'active' || profiles[0]?.supply_mode !== 'byok') {
      throw repositoryError('PROFILE_NOT_AVAILABLE');
    }

    const account = await this.getAccount({
      ownerKind: 'tenant',
      tenantId: input.tenantId,
      accountId: input.accountId,
    });
    if (!account || account.status === 'disabled' || account.status === 'revoked') {
      throw repositoryError('ACCOUNT_NOT_FOUND');
    }

    const inserted = await this.query<{ readonly account_id: string }>(
      `INSERT INTO saas_tenant_provider_supply_profile_accounts
         (tenant_id, supply_profile_id, supply_mode, account_id, provider_id, product_id,
          account_authz_version, status, effective_at, expires_at, authz_version,
          evidence_ref, evidence_sha256, created_at, updated_at)
       VALUES ($1, $2, 'byok', $3, $4, $5, $6, 'active', $7, $8, 1, $9, $10, $7, $7)
       RETURNING account_id`,
      [
        input.tenantId,
        input.supplyProfileId,
        account.id,
        account.providerId,
        account.productId,
        account.authzVersion,
        input.effectiveAt,
        input.expiresAt,
        input.evidenceReference,
        input.evidenceSha256,
      ],
    );
    if (inserted.length !== 1 || inserted[0]?.account_id !== account.id) {
      throw repositoryError('PROFILE_ACCOUNT_BIND_FAILED');
    }
  }

  async getAccount(reference: ProviderAccountReference): Promise<ProviderAccountRecord | null> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).getAccount(reference),
      );
    }
    await lockAdvisoryLayers(this.executor, providerAccountLockLayers(reference), 'shared');
    const predicate = accountPredicate(reference, 1);
    const rows = await this.query<AccountRow>(
      `SELECT ${accountColumns(reference.ownerKind)}
       FROM ${accountTable(reference.ownerKind)}
       WHERE ${predicate.sql}
       LIMIT 1`,
      predicate.values,
    );
    const row = rows[0];
    if (!row) return null;
    const capabilities = await this.accountCapabilities(reference, row.provider_id, row.product_id);
    return mapAccount(row, capabilities);
  }

  async listAccounts(filter: ProviderAccountListFilter = {}): Promise<readonly ProviderAccountRecord[]> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).listAccounts(filter),
      );
    }
    const owners: ProviderSupplyOwnerKind[] = filter.ownerKind ? [filter.ownerKind] : ['tenant', 'platform'];
    const records: ProviderAccountRecord[] = [];
    for (const ownerKind of owners) {
      const conditions: string[] = [];
      const values: unknown[] = [];
      const add = (sql: string, value: unknown): void => {
        values.push(value);
        conditions.push(sql.replace('$VALUE', `$${values.length}`));
      };
      if (ownerKind === 'tenant') add('tenant_id = $VALUE', filter.tenantId);
      if (filter.providerId !== undefined) add('provider_id = $VALUE', filter.providerId);
      if (filter.productId !== undefined) add('product_id = $VALUE', filter.productId);
      if (filter.status !== undefined) add('status = $VALUE', filter.status);
      if (filter.validationState !== undefined) add('validation_state = $VALUE', filter.validationState);
      const rows = await this.query<AccountRow>(
        `SELECT ${accountColumns(ownerKind)}
         FROM ${accountTable(ownerKind)}
         ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
         ORDER BY created_at, id`,
        values,
      );
      const references = rows.map(accountReferenceFromRow);
      await lockAdvisoryLayers(
        this.executor,
        [
          ownerKind === 'tenant'
            ? sortAndDedupeAdvisoryKeys(
                references.flatMap((reference) => {
                  return reference.ownerKind === 'tenant' ? [saasAdvisoryKey.tenant(reference.tenantId)] : [];
                }),
              )
            : [],
          sortAndDedupeAdvisoryKeys(references.map(providerAccountAdvisoryKey)),
        ],
        'shared',
      );
      const fencedRows = await this.query<AccountRow>(
        `SELECT ${accountColumns(ownerKind)}
         FROM ${accountTable(ownerKind)}
         ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
         ORDER BY created_at, id`,
        values,
      );
      for (const row of fencedRows) {
        const reference = accountReferenceFromRow(row);
        records.push(mapAccount(row, await this.accountCapabilities(reference, row.provider_id, row.product_id)));
      }
    }
    return records;
  }

  async updateAccountLifecycle(input: UpdateProviderAccountLifecycleInput): Promise<ProviderAccountRecord | null> {
    await lockAdvisoryLayers(this.executor, providerAccountLockLayers(input.account), 'exclusive');
    const table = accountTable(input.account.ownerKind);
    const lockPredicate = accountPredicate(input.account, 1);
    const lockedRows = await this.query<AccountRow>(
      `SELECT ${accountColumns(input.account.ownerKind)}
         FROM ${table}
        WHERE ${lockPredicate.sql}
        LIMIT 1
        FOR UPDATE`,
      lockPredicate.values,
    );
    if (!lockedRows[0]) return null;
    const predicate = accountPredicate(input.account, 6);
    const rows = await this.query<AccountRow>(
      `UPDATE ${table}
       SET status = $1,
           disabled_at = $2,
           revoked_at = $3,
           updated_at = $4,
           authz_version = authz_version + 1
       WHERE ${predicate.sql} AND authz_version = $5
       RETURNING ${accountColumns(input.account.ownerKind)}`,
      [
        input.status,
        input.disabledAt,
        input.revokedAt,
        input.updatedAt,
        input.expectedAuthzVersion,
        ...predicate.values,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    const reference = accountReferenceFromRow(row);
    return mapAccount(row, await this.accountCapabilities(reference, row.provider_id, row.product_id));
  }

  async updateAccountValidation(input: UpdateProviderAccountValidationInput): Promise<ProviderAccountRecord | null> {
    await lockAdvisoryLayers(this.executor, providerAccountLockLayers(input.account), 'exclusive');
    const table = accountTable(input.account.ownerKind);
    const lockPredicate = accountPredicate(input.account, 1);
    const lockedRows = await this.query<AccountRow>(
      `SELECT ${accountColumns(input.account.ownerKind)}
         FROM ${table}
        WHERE ${lockPredicate.sql}
        LIMIT 1
        FOR UPDATE`,
      lockPredicate.values,
    );
    if (!lockedRows[0]) return null;
    const predicate = accountPredicate(input.account, 6);
    const rows = await this.query<AccountRow>(
      `UPDATE ${table}
       SET validation_state = $1,
           validation_error_code = $2,
           last_validated_at = $3,
           updated_at = $4,
           authz_version = authz_version + 1
       WHERE ${predicate.sql} AND authz_version = $5
       RETURNING ${accountColumns(input.account.ownerKind)}`,
      [
        input.validationState,
        input.validationErrorCode,
        input.lastValidatedAt,
        input.updatedAt,
        input.expectedAuthzVersion,
        ...predicate.values,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    const reference = accountReferenceFromRow(row);
    return mapAccount(row, await this.accountCapabilities(reference, row.provider_id, row.product_id));
  }

  async createCredential(input: PersistedProviderCredentialInput): Promise<ProviderCredentialRecord> {
    const credentialReference: ProviderCredentialReference = {
      ownerKind: input.owner.ownerKind,
      tenantId: input.owner.tenantId,
      accountId: input.accountId,
      credentialId: input.id,
    };
    await lockAdvisoryLayers(this.executor, providerCredentialLockLayers(credentialReference), 'exclusive');
    const table = credentialTable(input.owner.ownerKind);
    const values =
      input.owner.ownerKind === 'tenant'
        ? [
            input.owner.tenantId,
            input.id,
            input.accountId,
            input.providerId,
            input.productId,
            input.credentialType,
            input.status,
            input.validationState,
            input.expiresAt,
            input.createdAt,
            input.updatedAt,
          ]
        : [
            input.id,
            input.accountId,
            input.providerId,
            input.productId,
            input.credentialType,
            input.status,
            input.validationState,
            input.expiresAt,
            input.createdAt,
            input.updatedAt,
          ];
    const columns =
      input.owner.ownerKind === 'tenant'
        ? '(tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state, expires_at, created_at, updated_at)'
        : '(id, account_id, provider_id, product_id, credential_type, status, validation_state, expires_at, created_at, updated_at)';
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    await this.query(
      `INSERT INTO ${table} ${columns}
       VALUES (${placeholders})`,
      values,
    );
    const result = await this.getCredential({
      ...credentialReference,
    });
    if (!result) throw repositoryError('CREDENTIAL_INSERT_FAILED');
    return result;
  }

  async enqueueProviderCredentialValidationJob(
    input: ProviderCredentialValidationJobInput,
  ): Promise<ProviderCredentialValidationJobRecord> {
    const credentialReference: ProviderCredentialReference & { readonly version: number } = {
      ownerKind: 'tenant',
      tenantId: input.tenantId,
      accountId: input.accountId,
      credentialId: input.credentialId,
      version: input.credentialVersion,
    };
    await lockAdvisoryLayers(this.executor, providerVersionLockLayers(credentialReference), 'exclusive');
    const values = [
      input.tenantId,
      input.accountId,
      input.credentialId,
      input.credentialVersion,
      input.providerId,
      input.productId,
      input.credentialType,
      [...input.allowedModels],
      input.target.model,
      input.target.endpoint,
      input.target.version,
      input.idempotencyKey,
    ];
    const inserted = await this.query<CredentialValidationJobRow>(
      `INSERT INTO saas_tenant_provider_credential_validation_jobs
         (tenant_id, account_id, credential_id, credential_version, provider_id, product_id, credential_type,
          allowed_models, target_model, target_endpoint, capability_version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, credential_id, credential_version) DO NOTHING
       RETURNING id, tenant_id, account_id, credential_id, credential_version, provider_id, product_id, credential_type,
         allowed_models, target_model, target_endpoint, capability_version, idempotency_key, status,
         attempt_count, available_at, lease_until, lease_generation, last_error_code, completed_at, created_at, updated_at`,
      values,
    );
    const rows =
      inserted.length > 0
        ? inserted
        : await this.query<CredentialValidationJobRow>(
            `SELECT id, tenant_id, account_id, credential_id, credential_version, provider_id, product_id, credential_type,
                    allowed_models, target_model, target_endpoint, capability_version, idempotency_key, status,
                    attempt_count, available_at, lease_until, lease_generation, last_error_code, completed_at, created_at, updated_at
               FROM saas_tenant_provider_credential_validation_jobs
              WHERE tenant_id = $1 AND credential_id = $2 AND credential_version = $3
              LIMIT 1
              FOR UPDATE`,
            [input.tenantId, input.credentialId, input.credentialVersion],
          );
    const row = rows[0];
    if (!row) throw repositoryError('CREDENTIAL_VALIDATION_JOB_WRITE_FAILED');
    const job = mapCredentialValidationJob(row);
    if (!sameValidationJobSnapshot(job, input)) {
      throw repositoryError('VALIDATION_JOB_IDEMPOTENCY_CONFLICT');
    }
    return job;
  }

  async getCredential(reference: ProviderCredentialReference): Promise<ProviderCredentialRecord | null> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).getCredential(reference),
      );
    }
    await lockAdvisoryLayers(this.executor, providerCredentialLockLayers(reference), 'shared');
    const predicate = credentialPredicate(reference, 1);
    const rows = await this.query<CredentialRow>(
      `SELECT ${credentialColumns(reference.ownerKind)}
       FROM ${credentialTable(reference.ownerKind)}
       WHERE ${predicate.sql}
       LIMIT 1`,
      predicate.values,
    );
    return rows[0] ? mapCredential(rows[0]) : null;
  }

  async listCredentials(filter: ProviderCredentialListFilter = {}): Promise<readonly ProviderCredentialRecord[]> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).listCredentials(filter),
      );
    }
    const owners: ProviderSupplyOwnerKind[] = filter.ownerKind ? [filter.ownerKind] : ['tenant', 'platform'];
    const records: ProviderCredentialRecord[] = [];
    for (const ownerKind of owners) {
      const conditions: string[] = [];
      const values: unknown[] = [];
      const add = (sql: string, value: unknown): void => {
        values.push(value);
        conditions.push(sql.replace('$VALUE', `$${values.length}`));
      };
      if (ownerKind === 'tenant') add('tenant_id = $VALUE', filter.tenantId ?? filter.account?.tenantId);
      if (filter.account?.accountId !== undefined) add('account_id = $VALUE', filter.account.accountId);
      if (filter.status !== undefined) add('status = $VALUE', filter.status);
      if (filter.validationState !== undefined) add('validation_state = $VALUE', filter.validationState);
      const rows = await this.query<CredentialRow>(
        `SELECT ${credentialColumns(ownerKind)}
         FROM ${credentialTable(ownerKind)}
         ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
         ORDER BY created_at, id`,
        values,
      );
      await lockAdvisoryLayers(
        this.executor,
        [
          ownerKind === 'tenant'
            ? sortAndDedupeAdvisoryKeys(
                rows.flatMap((row) => (row.tenant_id === null ? [] : [saasAdvisoryKey.tenant(row.tenant_id)])),
              )
            : [],
          sortAndDedupeAdvisoryKeys(
            rows.map((row) =>
              providerCredentialAdvisoryKey({
                ownerKind,
                tenantId: row.tenant_id,
                accountId: row.account_id,
                credentialId: row.id,
              }),
            ),
          ),
        ],
        'shared',
      );
      const fencedRows = await this.query<CredentialRow>(
        `SELECT ${credentialColumns(ownerKind)}
         FROM ${credentialTable(ownerKind)}
         ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
         ORDER BY created_at, id`,
        values,
      );
      records.push(...fencedRows.map(mapCredential));
    }
    return records;
  }

  async appendCredentialVersion(
    input: AppendProviderCredentialVersionInput,
  ): Promise<{ readonly credential: ProviderCredentialRecord; readonly version: ProviderCredentialVersionRecord }> {
    await lockAdvisoryLayers(this.executor, providerCredentialLockLayers(input.credential), 'exclusive');
    const credentialTableName = credentialTable(input.credential.ownerKind);
    const versionTableName = versionTable(input.credential.ownerKind);
    const credentialPredicateValue = credentialPredicate(input.credential, 1);
    const currentRows = await this.query<Pick<CredentialRow, 'status' | 'current_version'>>(
      `SELECT status, current_version
       FROM ${credentialTableName}
       WHERE ${credentialPredicateValue.sql}
       FOR UPDATE`,
      credentialPredicateValue.values,
    );
    const current = currentRows[0];
    if (!current) throw repositoryError('CREDENTIAL_NOT_FOUND');
    if (current.status === 'revoked') throw repositoryError('CREDENTIAL_REVOKED');
    const currentVersion = asNullablePositiveInteger(current.current_version);
    if (currentVersion !== input.expectedCurrentVersion) throw repositoryError('CREDENTIAL_VERSION_CONFLICT');

    await lockAdvisoryLayers(
      this.executor,
      [
        [
          ...(currentVersion === null
            ? []
            : [credentialVersionAdvisoryKey({ ...input.credential, version: currentVersion })]),
          credentialVersionAdvisoryKey(input.credential),
        ],
      ],
      'exclusive',
    );

    const versionValues =
      input.credential.ownerKind === 'tenant'
        ? [
            input.credential.tenantId,
            input.credential.accountId,
            input.credential.credentialId,
            input.credential.version,
            input.envelope.schemaVersion,
            input.envelope.contextVersion,
            input.envelope.algorithm,
            input.kmsPurpose,
            input.envelope.kmsKeyId,
            input.wrappingRevision,
            input.envelope.wrappedDek,
            input.envelope.nonce,
            input.envelope.ciphertext,
            input.envelope.authTag,
            input.createdAt,
            input.expiresAt,
          ]
        : [
            input.credential.accountId,
            input.credential.credentialId,
            input.credential.version,
            input.envelope.schemaVersion,
            input.envelope.contextVersion,
            input.envelope.algorithm,
            input.kmsPurpose,
            input.envelope.kmsKeyId,
            input.wrappingRevision,
            input.envelope.wrappedDek,
            input.envelope.nonce,
            input.envelope.ciphertext,
            input.envelope.authTag,
            input.createdAt,
            input.expiresAt,
          ];
    const versionColumnList =
      input.credential.ownerKind === 'tenant'
        ? '(tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm, kms_purpose, kms_key_id, wrapping_revision, wrapped_dek, nonce, ciphertext, auth_tag, created_at, expires_at)'
        : '(account_id, credential_id, version, schema_version, context_version, algorithm, kms_purpose, kms_key_id, wrapping_revision, wrapped_dek, nonce, ciphertext, auth_tag, created_at, expires_at)';
    if (currentVersion !== null) {
      const oldPredicate = versionPredicate({ ...input.credential, version: currentVersion }, 2);
      const oldSelectPredicate = versionPredicate({ ...input.credential, version: currentVersion }, 1);
      await this.query(
        `SELECT version
           FROM ${versionTableName}
          WHERE ${oldSelectPredicate.sql}
          LIMIT 1
          FOR UPDATE`,
        oldSelectPredicate.values,
      );
      await this.query(
        `UPDATE ${versionTableName}
         SET status = 'retired', retired_at = $1
         WHERE ${oldPredicate.sql} AND status = 'active'`,
        [input.createdAt, ...oldPredicate.values],
      );
    }

    const versionPlaceholders = versionValues.map((_, index) => `$${index + 1}`).join(', ');
    await this.query(
      `INSERT INTO ${versionTableName} ${versionColumnList}
       VALUES (${versionPlaceholders})`,
      versionValues,
    );

    const parentPredicate = credentialPredicate(input.credential, 5);
    const updatedRows = await this.query<CredentialRow>(
      `UPDATE ${credentialTableName}
       SET current_version = $1,
           status = CASE WHEN status = 'active' THEN 'pending' ELSE status END,
           validation_state = 'unverified',
           validation_error_code = NULL,
           last_validated_at = NULL,
           expires_at = $2,
           updated_at = $3,
           authz_version = authz_version + 1
       WHERE ${parentPredicate.sql} AND current_version IS NOT DISTINCT FROM $4
       RETURNING ${credentialColumns(input.credential.ownerKind)}`,
      [
        input.credential.version,
        input.expiresAt,
        input.createdAt,
        input.expectedCurrentVersion,
        ...parentPredicate.values,
      ],
    );
    const updated = updatedRows[0];
    if (!updated) throw repositoryError('CREDENTIAL_VERSION_CONFLICT');
    const versionRows = await this.query<CredentialVersionRow>(
      `SELECT ${versionColumns(input.credential.ownerKind)}
       FROM ${versionTableName}
       WHERE ${versionPredicate(input.credential, 1).sql}`,
      versionPredicate(input.credential, 1).values,
    );
    const version = versionRows[0];
    if (!version) throw repositoryError('CREDENTIAL_VERSION_INSERT_FAILED');
    return { credential: mapCredential(updated), version: mapVersion(version) };
  }

  async updateCredentialLifecycle(
    input: UpdateProviderCredentialLifecycleInput,
  ): Promise<ProviderCredentialRecord | null> {
    await lockAdvisoryLayers(this.executor, providerCredentialLockLayers(input.credential), 'exclusive');
    const table = credentialTable(input.credential.ownerKind);
    const lockPredicate = credentialPredicate(input.credential, 1);
    const lockedRows = await this.query<CredentialRow>(
      `SELECT ${credentialColumns(input.credential.ownerKind)}
         FROM ${table}
        WHERE ${lockPredicate.sql}
        LIMIT 1
        FOR UPDATE`,
      lockPredicate.values,
    );
    const locked = lockedRows[0];
    if (!locked || locked.authz_version !== input.expectedAuthzVersion) return null;
    if (input.status === 'revoked' && locked.current_version !== null) {
      const version = asPositiveInteger(locked.current_version);
      await lockAdvisoryLayers(
        this.executor,
        [[credentialVersionAdvisoryKey({ ...input.credential, version })]],
        'exclusive',
      );
      const versionPredicateValue = versionPredicate({ ...input.credential, version }, 1);
      await this.query(
        `SELECT version
           FROM ${versionTable(input.credential.ownerKind)}
          WHERE ${versionPredicateValue.sql}
          LIMIT 1
          FOR UPDATE`,
        versionPredicateValue.values,
      );
    }
    const predicate = credentialPredicate(input.credential, 6);
    const rows = await this.query<CredentialRow>(
      `UPDATE ${table}
       SET status = $1,
           disabled_at = $2,
           revoked_at = $3,
           updated_at = $4,
           authz_version = authz_version + 1
       WHERE ${predicate.sql} AND authz_version = $5
       RETURNING ${credentialColumns(input.credential.ownerKind)}`,
      [
        input.status,
        input.disabledAt,
        input.revokedAt,
        input.updatedAt,
        input.expectedAuthzVersion,
        ...predicate.values,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    if (input.status === 'revoked') {
      const versionTableName = versionTable(input.credential.ownerKind);
      const versionPredicateValue = versionCredentialPredicate(input.credential, 2);
      await this.query(
        `UPDATE ${versionTableName}
         SET status = 'revoked', revoked_at = $1
         WHERE ${versionPredicateValue.sql} AND status = 'active'`,
        [input.revokedAt ?? input.updatedAt, ...versionPredicateValue.values],
      );
    }
    return mapCredential(row);
  }

  async updateCredentialValidation(
    input: UpdateProviderCredentialValidationInput,
  ): Promise<ProviderCredentialRecord | null> {
    await lockAdvisoryLayers(this.executor, providerCredentialLockLayers(input.credential), 'exclusive');
    const table = credentialTable(input.credential.ownerKind);
    const lockPredicate = credentialPredicate(input.credential, 1);
    const lockedRows = await this.query<CredentialRow>(
      `SELECT ${credentialColumns(input.credential.ownerKind)}
         FROM ${table}
        WHERE ${lockPredicate.sql}
        LIMIT 1
        FOR UPDATE`,
      lockPredicate.values,
    );
    const locked = lockedRows[0];
    if (!locked || locked.authz_version !== input.expectedAuthzVersion) return null;
    const predicate = credentialPredicate(input.credential, 6);
    const rows = await this.query<CredentialRow>(
      `UPDATE ${table}
       SET validation_state = $1,
           validation_error_code = $2,
           last_validated_at = $3,
           status = CASE
             WHEN status = 'revoked' OR status = 'disabled' THEN status
             WHEN $1 = 'verified' THEN 'active'
             ELSE 'pending'
           END,
           updated_at = $4,
           authz_version = authz_version + 1
       WHERE ${predicate.sql} AND authz_version = $5
       RETURNING ${credentialColumns(input.credential.ownerKind)}`,
      [
        input.validationState,
        input.validationErrorCode,
        input.lastValidatedAt,
        input.updatedAt,
        input.expectedAuthzVersion,
        ...predicate.values,
      ],
    );
    return rows[0] ? mapCredential(rows[0]) : null;
  }

  async getCredentialVersionEnvelope(
    reference: ProviderCredentialReference & { readonly version: number },
  ): Promise<StoredProviderCredentialVersion | null> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).getCredentialVersionEnvelope(reference),
      );
    }
    await lockAdvisoryLayers(this.executor, providerVersionLockLayers(reference), 'shared');
    const predicate = versionPredicate(reference, 1);
    const versionTableName = versionTable(reference.ownerKind);
    const wrapperTableName = wrapperTable(reference.ownerKind);
    const rows = await this.query<CredentialVersionRow>(
      `WITH base_version AS (
         SELECT ${versionColumns(reference.ownerKind)}
           FROM ${versionTableName}
          WHERE ${predicate.sql}
       )
       SELECT base_version.owner_kind, base_version.tenant_id, base_version.supply_mode,
              base_version.account_id, base_version.credential_id, base_version.version,
              base_version.status, base_version.schema_version, base_version.context_version,
              base_version.algorithm, base_version.kms_purpose,
              COALESCE(wrapper.kms_key_id, base_version.kms_key_id) AS kms_key_id,
              COALESCE(wrapper.wrapping_revision, base_version.wrapping_revision) AS wrapping_revision,
              COALESCE(wrapper.wrapped_dek, base_version.wrapped_dek) AS wrapped_dek,
              base_version.nonce, base_version.ciphertext, base_version.auth_tag,
              base_version.created_at, base_version.expires_at, base_version.retired_at,
              base_version.revoked_at
         FROM base_version
         LEFT JOIN LATERAL (
           SELECT kms_key_id, wrapping_revision, wrapped_dek
             FROM ${wrapperTableName}
            WHERE account_id = base_version.account_id
              AND credential_id = base_version.credential_id
              AND credential_version = base_version.version
              ${reference.ownerKind === 'tenant' ? 'AND tenant_id = base_version.tenant_id' : ''}
            ORDER BY wrapping_revision DESC
            LIMIT 1
         ) AS wrapper ON TRUE
       LIMIT 1`,
      predicate.values,
    );
    return rows[0] ? mapVersion(rows[0]) : null;
  }

  async getCredentialWrapperRevisionByOperation(
    reference: ProviderCredentialReference & { readonly version: number },
    operationId: string,
  ): Promise<ProviderCredentialWrapperRevisionRecord | null> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).getCredentialWrapperRevisionByOperation(
          reference,
          operationId,
        ),
      );
    }
    await lockAdvisoryLayers(this.executor, providerVersionLockLayers(reference), 'shared');
    const table = wrapperTable(reference.ownerKind);
    const predicate =
      reference.ownerKind === 'tenant'
        ? 'tenant_id = $1 AND account_id = $2 AND credential_id = $3 AND credential_version = $4 AND operation_id = $5'
        : 'account_id = $1 AND credential_id = $2 AND credential_version = $3 AND operation_id = $4';
    const values =
      reference.ownerKind === 'tenant'
        ? [reference.tenantId, reference.accountId, reference.credentialId, reference.version, operationId]
        : [reference.accountId, reference.credentialId, reference.version, operationId];
    const rows = await this.query<CredentialWrapperRevisionRow>(
      `SELECT ${wrapperRevisionColumns(reference.ownerKind)}
         FROM ${table}
        WHERE ${predicate}
        LIMIT 1`,
      values,
    );
    return rows[0] ? mapWrapperRevision(rows[0]) : null;
  }

  async appendCredentialWrapperRevision(
    input: AppendProviderCredentialWrapperRevisionInput,
  ): Promise<{ readonly revision: ProviderCredentialWrapperRevisionRecord; readonly inserted: boolean }> {
    const credential = input.credential;
    await lockAdvisoryLayers(this.executor, providerVersionLockLayers(credential), 'exclusive');
    const basePredicate = versionPredicate(credential, 1);
    const versionRows = await this.query<{ kms_key_id: string; wrapping_revision: number | string }>(
      `SELECT kms_key_id, wrapping_revision
         FROM ${versionTable(credential.ownerKind)}
        WHERE ${basePredicate.sql}
        FOR UPDATE`,
      basePredicate.values,
    );
    const baseVersion = versionRows[0];
    if (!baseVersion) throw repositoryError('CREDENTIAL_NOT_FOUND');

    const operationPredicate =
      credential.ownerKind === 'tenant'
        ? 'tenant_id = $1 AND account_id = $2 AND credential_id = $3 AND credential_version = $4 AND operation_id = $5'
        : 'account_id = $1 AND credential_id = $2 AND credential_version = $3 AND operation_id = $4';
    const operationValues =
      credential.ownerKind === 'tenant'
        ? [credential.tenantId, credential.accountId, credential.credentialId, credential.version, input.operationId]
        : [credential.accountId, credential.credentialId, credential.version, input.operationId];
    const existingRows = await this.query<CredentialWrapperRevisionRow>(
      `SELECT ${wrapperRevisionColumns(credential.ownerKind)}
         FROM ${wrapperTable(credential.ownerKind)}
        WHERE ${operationPredicate}
        LIMIT 1
        FOR UPDATE`,
      operationValues,
    );
    const existing = existingRows[0] ? mapWrapperRevision(existingRows[0]) : null;
    if (existing) {
      if (!wrapperRevisionMatchesRequest(existing, input)) {
        throw repositoryError('CREDENTIAL_VERSION_CONFLICT');
      }
      return { revision: existing, inserted: false };
    }

    const historyPredicate =
      credential.ownerKind === 'tenant'
        ? 'tenant_id = $1 AND account_id = $2 AND credential_id = $3 AND credential_version = $4'
        : 'account_id = $1 AND credential_id = $2 AND credential_version = $3';
    const historyValues =
      credential.ownerKind === 'tenant'
        ? [credential.tenantId, credential.accountId, credential.credentialId, credential.version]
        : [credential.accountId, credential.credentialId, credential.version];
    const historyRows = await this.query<{ kms_key_id: string; wrapping_revision: number | string }>(
      `SELECT kms_key_id, wrapping_revision
         FROM ${wrapperTable(credential.ownerKind)}
        WHERE ${historyPredicate}
        ORDER BY wrapping_revision DESC
        LIMIT 1`,
      historyValues,
    );
    const latest = historyRows[0];
    const currentRevision = latest
      ? asPositiveInteger(latest.wrapping_revision)
      : asPositiveInteger(baseVersion.wrapping_revision);
    const currentKmsKeyId = latest ? asText(latest.kms_key_id) : asText(baseVersion.kms_key_id);
    if (
      currentRevision !== input.expectedWrappingRevision ||
      currentKmsKeyId !== input.sourceKmsKeyId ||
      input.expectedWrappingRevision >= 2_147_483_647
    ) {
      throw repositoryError('CREDENTIAL_VERSION_CONFLICT');
    }

    const revision = input.expectedWrappingRevision + 1;
    const actorUserId = input.audit.actorKind === 'user' ? input.audit.actorUserId : null;
    const actorWorkloadId = input.audit.actorKind === 'workload' ? input.audit.actorWorkloadId : null;
    const values =
      credential.ownerKind === 'tenant'
        ? [
            credential.tenantId,
            credential.accountId,
            credential.credentialId,
            credential.version,
            revision,
            input.expectedWrappingRevision,
            input.operationId,
            input.sourceKmsKeyId,
            input.kmsKeyId,
            input.wrappedDek,
            input.contextSha256,
            input.audit.actorKind,
            actorUserId,
            actorWorkloadId,
            input.audit.requestId,
            input.reasonCode,
            input.createdAt,
          ]
        : [
            credential.accountId,
            credential.credentialId,
            credential.version,
            revision,
            input.expectedWrappingRevision,
            input.operationId,
            input.sourceKmsKeyId,
            input.kmsKeyId,
            input.wrappedDek,
            input.contextSha256,
            input.audit.actorKind,
            actorUserId,
            actorWorkloadId,
            input.audit.requestId,
            input.reasonCode,
            input.createdAt,
          ];
    const columns =
      credential.ownerKind === 'tenant'
        ? '(tenant_id, account_id, credential_id, credential_version, wrapping_revision, expected_wrapping_revision, operation_id, source_kms_key_id, kms_key_id, wrapped_dek, context_sha256, actor_kind, actor_user_id, actor_workload_id, request_id, reason_code, created_at)'
        : '(account_id, credential_id, credential_version, wrapping_revision, expected_wrapping_revision, operation_id, source_kms_key_id, kms_key_id, wrapped_dek, context_sha256, actor_kind, actor_user_id, actor_workload_id, request_id, reason_code, created_at)';
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const insertedRows = await this.query<CredentialWrapperRevisionRow>(
      `INSERT INTO ${wrapperTable(credential.ownerKind)} ${columns}
       VALUES (${placeholders})
       RETURNING ${wrapperRevisionColumns(credential.ownerKind)}`,
      values,
    );
    const row = insertedRows[0];
    if (!row) throw repositoryError('CREDENTIAL_WRAPPER_REVISION_INSERT_FAILED');
    return { revision: mapWrapperRevision(row), inserted: true };
  }

  async getCredentialVersion(
    reference: ProviderCredentialReference & { readonly version: number },
  ): Promise<ProviderCredentialVersionRecord | null> {
    const stored = await this.getCredentialVersionEnvelope(reference);
    return stored ? publicVersion(stored) : null;
  }

  async listCredentialVersions(
    credential: ProviderCredentialReference,
  ): Promise<readonly ProviderCredentialVersionRecord[]> {
    if (this.executor === this.database && !this.inTransaction && typeof this.database.transaction === 'function') {
      return this.database.transaction((executor) =>
        new PostgresProviderSupplyRepository(this.database, executor, true).listCredentialVersions(credential),
      );
    }
    await lockAdvisoryLayers(this.executor, providerCredentialLockLayers(credential), 'shared');
    const predicate = versionCredentialPredicate(credential, 1);
    const rows = await this.query<CredentialVersionRow>(
      `SELECT ${versionColumns(credential.ownerKind)}
       FROM ${versionTable(credential.ownerKind)}
       WHERE ${predicate.sql}
       ORDER BY version`,
      predicate.values,
    );
    return rows.map((row) => publicVersion(mapVersion(row)));
  }
}
