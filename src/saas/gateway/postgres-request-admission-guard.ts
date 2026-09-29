import type { ProviderEligibilityResult } from '../catalog/index.js';
import { SaasCatalogError, SaasCatalogService } from '../catalog/index.js';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type {
  AttemptRecord,
  AuthorizationBindingInput,
  InitialAttemptInput,
  RequestRecord,
} from '../metering/types.js';
import { SaasPricingError, SaasPricingService } from '../pricing/index.js';
import type {
  PlatformRequestAdmissionHoldEvidence,
  SaasRequestAdmissionGuard,
  SaasRequestAdmissionGuardInput,
  SaasRequestAdmissionGuardResult,
  SaasRequestAdmissionPlatformPriceHoldFacts,
} from './admission.js';
import type { ConservativePriceHold } from './hold-calculator.js';
import { calculateConservativePriceHold, INPUT_BILLING_BUCKETS } from './hold-calculator.js';

type Row = Record<string, unknown>;

export type PostgresRequestAdmissionGuardErrorCode =
  | 'INVALID_INPUT'
  | 'AUTHORITY_MISMATCH'
  | 'EXPIRED'
  | 'PRICE_UNAVAILABLE'
  | 'STORAGE_ERROR';

const SAFE_MESSAGES: Record<PostgresRequestAdmissionGuardErrorCode, string> = {
  INVALID_INPUT: 'The SaaS request admission guard received invalid authority data.',
  AUTHORITY_MISMATCH: 'The SaaS request admission authority is stale or mismatched.',
  EXPIRED: 'The SaaS request admission authority is expired.',
  PRICE_UNAVAILABLE: 'The SaaS request admission price could not be proven current.',
  STORAGE_ERROR: 'The SaaS request admission authority could not be revalidated.',
};

/** A stable, non-sensitive denial returned by the production admission adapter. */
export class PostgresRequestAdmissionGuardError extends Error {
  readonly code: PostgresRequestAdmissionGuardErrorCode;

  constructor(code: PostgresRequestAdmissionGuardErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'PostgresRequestAdmissionGuardError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PostgresRequestAdmissionGuardOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Injectable only to keep fake-SQL tests on the same service contracts. */
  readonly pricing?: SaasPricingService;
  /** Injectable only to keep fake-SQL tests on the same service contracts. */
  readonly catalog?: SaasCatalogService;
}

function deny(code: Exclude<PostgresRequestAdmissionGuardErrorCode, 'STORAGE_ERROR'>): never {
  throw new PostgresRequestAdmissionGuardError(code);
}

function storage(): never {
  throw new PostgresRequestAdmissionGuardError('STORAGE_ERROR');
}

function isGuardError(error: unknown): error is PostgresRequestAdmissionGuardError {
  return error instanceof PostgresRequestAdmissionGuardError;
}

function same(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  return actual !== null && actual !== undefined && String(actual) === String(expected);
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) deny('INVALID_INPUT');
  return value;
}

function storedText(row: Row, key: string): string {
  if (!(key in row)) storage();
  return requiredText(row[key]);
}

function requiredOne<T extends Row>(rows: readonly T[]): T {
  if (rows.length !== 1) {
    if (rows.length === 0) deny('AUTHORITY_MISMATCH');
    storage();
  }
  const row = rows[0];
  if (!row) storage();
  return row;
}

function rowDate(row: Row, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) storage();
  return date;
}

function assertWindow(row: Row, now: Date): void {
  const effectiveAt = rowDate(row, 'effective_at');
  const expiresAt = rowDate(row, 'expires_at');
  if ((effectiveAt && effectiveAt > now) || (expiresAt && expiresAt <= now)) deny('EXPIRED');
}

function containsScope(row: Row, key: string, value: string): boolean {
  return Array.isArray(row[key]) && row[key].some((entry) => entry === value);
}

function positiveVersion(value: unknown): bigint {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value));
    if (parsed < 1n) deny('AUTHORITY_MISMATCH');
    return parsed;
  } catch {
    storage();
  }
}

function assertMatch(row: Row, pairs: readonly [string, unknown][]): void {
  for (const [key, expected] of pairs) {
    if (!same(row[key], expected)) deny('AUTHORITY_MISMATCH');
  }
}

function assertActiveStatus(row: Row, status = 'active'): void {
  if (row.status !== status) deny('AUTHORITY_MISMATCH');
}

function assertMembership(rows: readonly Row[]): void {
  if (
    !rows.some(
      (row) =>
        row.status === 'active' &&
        row.revoked_at == null &&
        (row.role === 'owner' || row.role === 'admin' || row.role === 'developer'),
    )
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function compareRequest(row: Row, request: RequestRecord): void {
  assertMatch(row, [
    ['id', request.id],
    ['tenant_id', request.tenantId],
    ['project_id', request.projectId],
    ['proxy_key_id', request.proxyKeyId],
    ['entitlement_id', request.entitlementId],
    ['entitlement_version', request.entitlementVersion],
    ['supply_profile_id', request.supplyProfileId],
    ['supply_profile_version', request.supplyProfileVersion],
    ['model_scope_version', request.modelScopeVersion],
    ['supply_mode', request.supplyMode],
    ['principal_kind', request.principalKind],
    ['principal_id', request.principalId],
    ['authz_version', request.authzVersion],
    ['config_version', request.configVersion],
    ['project_policy_version', request.projectPolicyVersion],
    ['public_model', request.publicModel],
    ['protocol', request.protocol],
    ['endpoint', request.endpoint],
    ['route_config_id', request.routeConfigId],
    ['route_config_version', request.routeConfigVersion],
    ['route_public_model_id', request.routePublicModelId],
    ['route_public_model_version', request.routePublicModelVersion],
    ['route_protocol', request.routeProtocol],
    ['route_target_mode', request.routeTargetMode],
    ['route_upstream_id', request.routeUpstreamId],
    ['customer_metering_policy_id', request.customerMeteringPolicyId],
    ['customer_metering_policy_version', request.customerMeteringPolicyVersion],
    ['provider_metering_policy_id', request.providerMeteringPolicyId],
    ['provider_metering_policy_version', request.providerMeteringPolicyVersion],
    ['contract_attestation_id', request.contractAttestationId],
    ['customer_price_version', request.customerPriceVersion],
  ]);
}

function compareAttempt(row: Row, attempt: AttemptRecord): void {
  assertMatch(row, [
    ['id', attempt.id],
    ['tenant_id', attempt.tenantId],
    ['request_id', attempt.requestId],
    ['project_policy_version', attempt.projectPolicyVersion],
    ['customer_price_version', attempt.customerPriceVersion],
    ['customer_metering_policy_id', attempt.customerMeteringPolicyId],
    ['customer_metering_policy_version', attempt.customerMeteringPolicyVersion],
    ['provider_metering_policy_id', attempt.providerMeteringPolicyId],
    ['provider_metering_policy_version', attempt.providerMeteringPolicyVersion],
    ['contract_attestation_id', attempt.contractAttestationId],
    ['route_config_id', attempt.routeConfigId],
    ['route_config_version', attempt.routeConfigVersion],
    ['route_public_model_id', attempt.routePublicModelId],
    ['route_public_model_version', attempt.routePublicModelVersion],
    ['route_protocol', attempt.routeProtocol],
    ['route_target_mode', attempt.routeTargetMode],
    ['ordinal', attempt.ordinal],
    ['upstream_id', attempt.upstreamId],
    ['account_owner_kind', attempt.accountOwnerKind],
    ['account_id', attempt.accountId],
    ['provider_id', attempt.providerId],
    ['product_id', attempt.productId],
    ['resolved_model', attempt.resolvedModel],
    ['protocol', attempt.protocol],
    ['endpoint', attempt.endpoint],
    ['supplier_cost_version', attempt.supplierCostVersion],
    ['dispatch_profile_id', attempt.dispatchProfileId],
    ['supply_profile_authz_version', attempt.supplyProfileAuthzVersion],
    ['credential_id', attempt.credentialId],
    ['credential_version', attempt.credentialVersion],
    ['credential_authz_version', attempt.credentialAuthzVersion],
    ['account_authz_version', attempt.accountAuthzVersion],
    ['pool_id', attempt.poolId],
    ['pool_authz_version', attempt.poolAuthzVersion],
    ['pool_member_account_authz_version', attempt.poolMemberAccountAuthzVersion],
    ['pool_member_authz_version', attempt.poolMemberAuthzVersion],
    ['pool_grant_authz_version', attempt.poolGrantAuthzVersion],
    ['pool_grant_profile_authz_version', attempt.poolGrantProfileAuthzVersion],
    ['pool_grant_pool_authz_version', attempt.poolGrantPoolAuthzVersion],
    ['profile_account_authz_version', attempt.profileAccountAuthzVersion],
  ]);
  if (row.binding_state !== 'bound' || row.dispatch_authority_state !== 'bound' || row.dispatch_state !== 'not_sent') {
    deny('AUTHORITY_MISMATCH');
  }
}

function requireNewAuthorityShape(request: RequestRecord, candidate: AttemptRecord): void {
  const requiredRequest: readonly unknown[] = [
    request.projectPolicyVersion,
    request.routeConfigId,
    request.routeConfigVersion,
    request.routePublicModelId,
    request.routePublicModelVersion,
    request.routeProtocol,
    request.routeTargetMode,
    request.routeUpstreamId,
    request.customerMeteringPolicyId,
    request.customerMeteringPolicyVersion,
    request.providerMeteringPolicyId,
    request.providerMeteringPolicyVersion,
    request.contractAttestationId,
  ];
  if (requiredRequest.some((value) => value === null || value === undefined)) deny('AUTHORITY_MISMATCH');

  const requiredCandidate: readonly unknown[] = [
    candidate.accountOwnerKind,
    candidate.accountId,
    candidate.providerId,
    candidate.productId,
    candidate.endpoint,
    candidate.dispatchProfileId,
    candidate.supplyProfileAuthzVersion,
    candidate.credentialId,
    candidate.credentialVersion,
    candidate.credentialAuthzVersion,
    candidate.accountAuthzVersion,
    candidate.projectPolicyVersion,
    candidate.routeConfigId,
    candidate.routeConfigVersion,
    candidate.routePublicModelId,
    candidate.routePublicModelVersion,
    candidate.routeProtocol,
    candidate.routeTargetMode,
  ];
  if (requiredCandidate.some((value) => value === null || value === undefined)) deny('AUTHORITY_MISMATCH');

  if (request.supplyMode === 'byok') {
    if (
      candidate.accountOwnerKind !== 'tenant' ||
      candidate.profileAccountAuthzVersion == null ||
      candidate.poolId != null
    ) {
      deny('AUTHORITY_MISMATCH');
    }
  } else if (
    candidate.accountOwnerKind !== 'platform' ||
    candidate.poolId == null ||
    candidate.poolAuthzVersion == null ||
    candidate.poolMemberAuthzVersion == null ||
    candidate.poolMemberAccountAuthzVersion == null ||
    candidate.poolGrantAuthzVersion == null ||
    candidate.poolGrantProfileAuthzVersion == null ||
    candidate.poolGrantPoolAuthzVersion == null ||
    candidate.profileAccountAuthzVersion != null
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function validateHoldEvidence(evidence: PlatformRequestAdmissionHoldEvidence): PlatformRequestAdmissionHoldEvidence {
  const counters = [
    evidence.inputTotal,
    evidence.inputUncached,
    evidence.cacheRead,
    evidence.cacheWrite,
    evidence.cacheWrite5m,
    evidence.cacheWrite1h,
    evidence.outputTotal,
    evidence.reasoningOutput,
  ];
  let normalized: bigint[];
  try {
    normalized = counters.map((value) => {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
      if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) return BigInt(value.trim());
      throw new Error('invalid counter');
    });
  } catch {
    deny('INVALID_INPUT');
  }
  if (normalized.some((value) => value < 0n)) deny('INVALID_INPUT');
  const [inputTotal, inputUncached, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, outputTotal, reasoningOutput] =
    normalized;
  if (
    inputTotal === undefined ||
    inputUncached === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite5m === undefined ||
    cacheWrite1h === undefined ||
    outputTotal === undefined ||
    reasoningOutput === undefined
  ) {
    deny('INVALID_INPUT');
  }
  if (
    inputUncached + cacheRead + cacheWrite + cacheWrite5m + cacheWrite1h > inputTotal ||
    reasoningOutput > outputTotal ||
    (cacheWrite > 0n && (cacheWrite5m > 0n || cacheWrite1h > 0n))
  ) {
    deny('AUTHORITY_MISMATCH');
  }
  const expiresAt = new Date(evidence.admissionExpiresAt);
  if (!Number.isFinite(expiresAt.getTime())) deny('INVALID_INPUT');
  return { ...evidence, admissionExpiresAt: expiresAt.toISOString() };
}

function assertRights(
  row: Row,
  mode: 'byok' | 'platform',
  providerId: string,
  productId: string,
  model: string,
  endpoint: string,
  boundary: { credentialType: string; region: string; purpose: string },
  now?: Date,
): void {
  if (
    row.status !== 'active' ||
    row.provider_id !== providerId ||
    row.product_id !== productId ||
    row.supply_mode !== mode ||
    row.credential_type !== boundary.credentialType ||
    row.region !== boundary.region ||
    row.purpose !== boundary.purpose ||
    !containsScope(row, 'model_scope', model) ||
    !containsScope(row, 'endpoint_scope', endpoint) ||
    typeof row.approval_ref !== 'string' ||
    row.approval_ref.trim() === '' ||
    typeof row.evidence_ref !== 'string' ||
    row.evidence_ref.trim() === '' ||
    typeof row.evidence_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.evidence_sha256)
  ) {
    deny('AUTHORITY_MISMATCH');
  }
  if (now) assertWindow(row, now);
}

function assertBindingEvidence(row: Row): void {
  if (
    typeof row.evidence_ref !== 'string' ||
    row.evidence_ref.trim() === '' ||
    typeof row.evidence_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.evidence_sha256)
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function assertAccount(
  row: Row,
  ownerKind: 'tenant' | 'platform',
  mode: 'byok' | 'platform',
  candidate: AttemptRecord,
): void {
  if (
    row.owner_kind !== ownerKind ||
    row.supply_mode !== mode ||
    row.status !== 'active' ||
    row.validation_state !== 'verified' ||
    !same(row.authz_version, candidate.accountAuthzVersion) ||
    !same(row.provider_id, candidate.providerId) ||
    !same(row.product_id, candidate.productId)
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function assertCredential(
  row: Row,
  ownerKind: 'tenant' | 'platform',
  mode: 'byok' | 'platform',
  candidate: AttemptRecord,
): void {
  if (
    row.owner_kind !== ownerKind ||
    row.supply_mode !== mode ||
    row.account_id !== candidate.accountId ||
    row.provider_id !== candidate.providerId ||
    row.product_id !== candidate.productId ||
    row.status !== 'active' ||
    row.validation_state !== 'verified' ||
    !same(row.authz_version, candidate.credentialAuthzVersion) ||
    !same(row.current_version, candidate.credentialVersion)
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function assertCredentialVersion(
  row: Row,
  ownerKind: 'tenant' | 'platform',
  mode: 'byok' | 'platform',
  candidate: AttemptRecord,
): void {
  if (
    row.owner_kind !== ownerKind ||
    row.supply_mode !== mode ||
    row.account_id !== candidate.accountId ||
    row.credential_id !== candidate.credentialId ||
    !same(row.version, candidate.credentialVersion) ||
    row.status !== 'active'
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function assertCapabilityRow(row: Row, candidate: AttemptRecord): void {
  if (
    row.provider_id !== candidate.providerId ||
    row.product_id !== candidate.productId ||
    row.model !== candidate.resolvedModel ||
    row.endpoint !== candidate.endpoint ||
    row.protocol !== candidate.protocol ||
    (row.support_level !== 'supported' && row.support_level !== 'limited') ||
    row.validation_state !== 'verified' ||
    typeof row.evidence_version !== 'string' ||
    row.evidence_version.trim() === '' ||
    typeof row.evidence_ref !== 'string' ||
    row.evidence_ref.trim() === '' ||
    typeof row.evidence_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.evidence_sha256)
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function assertAccountCapability(row: Row, candidate: AttemptRecord, capabilityVersion: number | string): void {
  if (
    row.provider_id !== candidate.providerId ||
    row.product_id !== candidate.productId ||
    row.model !== candidate.resolvedModel ||
    row.endpoint !== candidate.endpoint ||
    !same(row.capability_version, capabilityVersion)
  ) {
    deny('AUTHORITY_MISMATCH');
  }
}

function assertOutputPriceIdentity(
  row: Row,
  expected: {
    publicModelId: string;
    publicModelVersion: string;
    providerId: string;
    productId: string;
    protocol: string;
    endpoint: string;
  },
  resolvedModel?: string,
): string {
  assertMatch(row, [
    ['public_model_id', expected.publicModelId],
    ['public_model_version', expected.publicModelVersion],
    ['provider_id', expected.providerId],
    ['product_id', expected.productId],
    ['protocol', expected.protocol],
    ['endpoint', expected.endpoint],
  ]);
  if (resolvedModel !== undefined && !same(row.resolved_model, resolvedModel)) deny('AUTHORITY_MISMATCH');
  return storedText(row, 'currency');
}

function toInitialAttempt(candidate: AttemptRecord): InitialAttemptInput {
  const common = {
    ordinal: candidate.ordinal,
    upstreamId: requiredText(candidate.upstreamId),
    accountId: requiredText(candidate.accountId),
    providerId: requiredText(candidate.providerId),
    productId: requiredText(candidate.productId),
    resolvedModel: requiredText(candidate.resolvedModel),
    protocol: candidate.protocol,
    endpoint: requiredText(candidate.endpoint),
    dispatchProfileId: requiredText(candidate.dispatchProfileId),
    supplyProfileAuthzVersion: requiredText(candidate.supplyProfileAuthzVersion),
    credentialId: requiredText(candidate.credentialId),
    credentialVersion: requiredText(candidate.credentialVersion),
    credentialAuthzVersion: requiredText(candidate.credentialAuthzVersion),
    accountAuthzVersion: requiredText(candidate.accountAuthzVersion),
    projectPolicyVersion: requiredText(candidate.projectPolicyVersion),
    supplierCostVersion: candidate.supplierCostVersion,
    customerPriceVersion: candidate.customerPriceVersion,
    routeConfigId: requiredText(candidate.routeConfigId),
    routeConfigVersion: requiredText(candidate.routeConfigVersion),
    routePublicModelId: requiredText(candidate.routePublicModelId),
    routePublicModelVersion: requiredText(candidate.routePublicModelVersion),
    routeProtocol: candidate.routeProtocol,
    routeTargetMode: candidate.routeTargetMode,
    customerMeteringPolicyId: requiredText(candidate.customerMeteringPolicyId),
    customerMeteringPolicyVersion: requiredText(candidate.customerMeteringPolicyVersion),
    providerMeteringPolicyId: requiredText(candidate.providerMeteringPolicyId),
    providerMeteringPolicyVersion: requiredText(candidate.providerMeteringPolicyVersion),
    contractAttestationId: requiredText(candidate.contractAttestationId),
  };
  if (candidate.accountOwnerKind === 'tenant') {
    return {
      ...common,
      accountOwnerKind: 'tenant',
      profileAccountAuthzVersion: requiredText(candidate.profileAccountAuthzVersion),
    };
  }
  if (candidate.accountOwnerKind === 'platform') {
    return {
      ...common,
      accountOwnerKind: 'platform',
      poolId: requiredText(candidate.poolId),
      poolAuthzVersion: requiredText(candidate.poolAuthzVersion),
      poolMemberAccountAuthzVersion: requiredText(candidate.poolMemberAccountAuthzVersion),
      poolMemberAuthzVersion: requiredText(candidate.poolMemberAuthzVersion),
      poolGrantAuthzVersion: requiredText(candidate.poolGrantAuthzVersion),
      poolGrantProfileAuthzVersion: requiredText(candidate.poolGrantProfileAuthzVersion),
      poolGrantPoolAuthzVersion: requiredText(candidate.poolGrantPoolAuthzVersion),
    };
  }
  deny('AUTHORITY_MISMATCH');
}

async function rows(executor: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row[]> {
  try {
    const result = await executor.query<Row>(sql, values);
    return result.rows;
  } catch {
    storage();
  }
}

const PROVIDER_RIGHTS_FENCE_KEY = 'saas-authz:provider-rights';

function credentialVersionFenceKey(candidate: AttemptRecord, tenantId: string): string {
  const version = positiveVersion(candidate.credentialVersion);
  if (version > BigInt(Number.MAX_SAFE_INTEGER)) deny('AUTHORITY_MISMATCH');
  if (candidate.accountOwnerKind !== 'tenant' && candidate.accountOwnerKind !== 'platform') {
    deny('AUTHORITY_MISMATCH');
  }
  return saasAdvisoryKey.credentialVersion(
    candidate.accountOwnerKind,
    candidate.accountOwnerKind === 'tenant' ? tenantId : 'platform',
    requiredText(candidate.credentialId),
    Number(version),
  );
}

function admissionFenceLayers(
  request: RequestRecord,
  candidate: AttemptRecord,
): readonly (readonly [string, readonly string[]])[] {
  const tenantId = requiredText(request.tenantId);
  const projectId = requiredText(request.projectId);
  const providerId = requiredText(candidate.providerId);
  const customerPolicyId = requiredText(request.customerMeteringPolicyId);
  const providerPolicyId = requiredText(request.providerMeteringPolicyId);
  const identityAndCommercial = [
    ...(request.principalKind === 'member' ? [saasAdvisoryKey.user(requiredText(request.principalId))] : []),
    saasAdvisoryKey.apiKey(tenantId, projectId, requiredText(request.proxyKeyId)),
    saasAdvisoryKey.commercialCustomer(tenantId, customerPolicyId),
    saasAdvisoryKey.commercialProvider(providerId, providerPolicyId),
    PROVIDER_RIGHTS_FENCE_KEY,
  ];
  const pools = request.supplyMode === 'platform' ? [saasAdvisoryKey.platformPool(requiredText(candidate.poolId))] : [];
  const accounts = [
    candidate.accountOwnerKind === 'tenant'
      ? saasAdvisoryKey.tenantProviderAccount(tenantId, requiredText(candidate.accountId))
      : saasAdvisoryKey.platformProviderAccount(requiredText(candidate.accountId)),
  ];
  const credentials = [
    candidate.accountOwnerKind === 'tenant'
      ? saasAdvisoryKey.tenantProviderCredential(tenantId, requiredText(candidate.credentialId))
      : saasAdvisoryKey.platformProviderCredential(requiredText(candidate.credentialId)),
  ];
  const profiles = [
    saasAdvisoryKey.supplyProfile(tenantId, requiredText(request.supplyProfileId)),
    saasAdvisoryKey.supplyProfile(tenantId, requiredText(candidate.dispatchProfileId)),
  ];
  const mappings =
    request.supplyMode === 'byok'
      ? [
          saasAdvisoryKey.supplyProfileAccount(
            tenantId,
            requiredText(request.supplyProfileId),
            requiredText(candidate.accountId),
          ),
        ]
      : [];

  return [
    ['tenant', [saasAdvisoryKey.tenant(tenantId)]],
    ['project', [saasAdvisoryKey.project(tenantId, projectId)]],
    ['identity-commercial', identityAndCommercial],
    ['pools', pools],
    ['profiles', profiles],
    ['provider-accounts', accounts],
    ['credentials', credentials],
    ['versions', [credentialVersionFenceKey(candidate, tenantId)]],
    ['mappings', mappings],
    ['members', []],
    ['grants', []],
  ];
}

async function acquireAdmissionFences(
  executor: SqlExecutor,
  request: RequestRecord,
  candidate: AttemptRecord,
): Promise<void> {
  for (const [layer, keys] of admissionFenceLayers(request, candidate)) {
    for (const key of sortAndDedupeAdvisoryKeys(keys)) {
      await rows(
        executor,
        `/* postgres-request-admission:fence-${layer} */ SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`,
        [key],
      );
    }
  }
}

async function lockOne(
  executor: SqlExecutor,
  stage: string,
  table: string,
  where: string,
  values: readonly unknown[],
  lock: 'UPDATE' | null = null,
): Promise<Row> {
  return requiredOne(
    await rows(
      executor,
      `/* postgres-request-admission:${stage} */ SELECT * FROM ${table} WHERE ${where} LIMIT 2${lock === null ? '' : ' FOR UPDATE'}`,
      values,
    ),
  );
}

async function databaseClock(executor: SqlExecutor): Promise<Date> {
  const row = requiredOne(
    await rows(executor, '/* postgres-request-admission:clock */ SELECT clock_timestamp() AS locked_at', []),
  );
  const date = rowDate(row, 'locked_at');
  if (!date) storage();
  return date;
}

export class PostgresRequestAdmissionGuard implements SaasRequestAdmissionGuard {
  private readonly pricing: SaasPricingService;
  private readonly catalog: SaasCatalogService;

  constructor(database: SaasDatabase, options: PostgresRequestAdmissionGuardOptions = {}) {
    const now = options.now ?? (() => new Date());
    this.pricing = options.pricing ?? new SaasPricingService(database, { now, idFactory: options.idFactory });
    this.catalog = options.catalog ?? new SaasCatalogService(database, { now });
  }

  async revalidate(input: SaasRequestAdmissionGuardInput): Promise<SaasRequestAdmissionGuardResult> {
    try {
      return await this.revalidateOnTransaction(input);
    } catch (error) {
      if (isGuardError(error)) throw error;
      if (error instanceof SaasCatalogError) {
        if (error.code === 'CATALOG_STORAGE_ERROR') throw new PostgresRequestAdmissionGuardError('STORAGE_ERROR');
        throw new PostgresRequestAdmissionGuardError('AUTHORITY_MISMATCH');
      }
      if (error instanceof SaasPricingError) {
        if (error.code === 'PRICING_STORAGE_ERROR') throw new PostgresRequestAdmissionGuardError('STORAGE_ERROR');
        if (error.code === 'INVALID_INPUT' || error.code === 'INVALID_WINDOW') {
          throw new PostgresRequestAdmissionGuardError('INVALID_INPUT');
        }
        if (error.code === 'REQUEST_BINDING_MISMATCH' || error.code === 'PLATFORM_REQUEST_REQUIRED') {
          throw new PostgresRequestAdmissionGuardError('AUTHORITY_MISMATCH');
        }
        throw new PostgresRequestAdmissionGuardError('PRICE_UNAVAILABLE');
      }
      throw new PostgresRequestAdmissionGuardError('STORAGE_ERROR');
    }
  }

  private async revalidateOnTransaction(
    input: SaasRequestAdmissionGuardInput,
  ): Promise<SaasRequestAdmissionGuardResult> {
    if (!input?.executor || !input.request || !input.candidate) deny('INVALID_INPUT');
    const executor = input.executor;
    const request = input.request;
    const candidate = input.candidate;
    requireNewAuthorityShape(request, candidate);
    if (request.supplyMode !== 'byok' && request.supplyMode !== 'platform') deny('INVALID_INPUT');
    if (request.principalKind !== 'member' && request.principalKind !== 'project_service') deny('AUTHORITY_MISMATCH');
    if (request.principalKind === 'project_service' && request.principalId !== request.projectId) {
      deny('AUTHORITY_MISMATCH');
    }
    if (request.supplyMode === 'byok' && input.holdEvidence !== null) deny('AUTHORITY_MISMATCH');
    if (request.supplyMode === 'platform' && input.holdEvidence === null) deny('AUTHORITY_MISMATCH');

    // Acquire every shared fence before reading any authority fact. Each layer sorts complete
    // helper-generated key text, so concurrent admission and authorization changes converge on
    // the same lock order and all post-wait SELECTs use a fresh READ COMMITTED snapshot.
    await acquireAdmissionFences(executor, request, candidate);

    const tenant = await lockOne(executor, 'tenant', 'saas_tenants', 'id = $1', [request.tenantId], null);
    assertActiveStatus(tenant);
    const project = await lockOne(
      executor,
      'project',
      'saas_projects',
      'tenant_id = $1 AND id = $2',
      [request.tenantId, request.projectId],
      null,
    );
    assertMatch(project, [
      ['tenant_id', request.tenantId],
      ['id', request.projectId],
      ['inference_policy_version', request.projectPolicyVersion],
    ]);
    if (project.inference_policy_status !== 'active') deny('AUTHORITY_MISMATCH');
    const policy = await lockOne(
      executor,
      'project-policy',
      'saas_project_inference_policy_versions',
      'tenant_id = $1 AND project_id = $2 AND version = $3',
      [request.tenantId, request.projectId, request.projectPolicyVersion],
      null,
    );
    if (policy.status !== 'active') deny('AUTHORITY_MISMATCH');

    if (request.principalKind === 'member') {
      const principal = await lockOne(executor, 'principal', 'saas_users', 'id = $1', [request.principalId], null);
      if (principal.disabled_at != null || principal.anonymized_at != null) deny('AUTHORITY_MISMATCH');
      const tenantMemberships = await rows(
        executor,
        '/* postgres-request-admission:tenant-membership */ SELECT * FROM saas_memberships WHERE tenant_id = $1 AND user_id = $2',
        [request.tenantId, request.principalId],
      );
      assertMembership(tenantMemberships);
      const projectMemberships = await rows(
        executor,
        '/* postgres-request-admission:project-membership */ SELECT * FROM saas_project_memberships WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3',
        [request.tenantId, request.projectId, request.principalId],
      );
      assertMembership(projectMemberships);
    }

    const key = await lockOne(executor, 'key', 'saas_api_keys', 'tenant_id = $1 AND project_id = $2 AND id = $3', [
      request.tenantId,
      request.projectId,
      request.proxyKeyId,
    ]);
    assertMatch(key, [
      ['tenant_id', request.tenantId],
      ['project_id', request.projectId],
      ['execution_principal_type', request.principalKind],
      ['execution_principal_id', request.principalId],
      ['entitlement_id', request.entitlementId],
      ['supply_profile_id', request.supplyProfileId],
      ['supply_mode', request.supplyMode],
      ['authz_version', request.authzVersion],
      ['entitlement_authz_version', request.entitlementVersion],
      ['supply_profile_authz_version', request.supplyProfileVersion],
      ['model_scope_version', request.modelScopeVersion],
    ]);
    if (key.status !== 'active' || key.revoked_at != null || !containsScope(key, 'model_scopes', request.publicModel))
      deny('AUTHORITY_MISMATCH');
    if (
      (request.principalKind === 'member' && key.principal_user_id !== request.principalId) ||
      (request.principalKind === 'project_service' &&
        (key.principal_user_id !== null || request.principalId !== request.projectId))
    ) {
      deny('AUTHORITY_MISMATCH');
    }

    const persistedRequest = await lockOne(
      executor,
      'request',
      'saas_requests',
      'tenant_id = $1 AND id = $2',
      [request.tenantId, request.id],
      'UPDATE',
    );
    compareRequest(persistedRequest, request);
    const persistedAttempt = await lockOne(
      executor,
      'attempt',
      'saas_attempts',
      'tenant_id = $1 AND id = $2',
      [request.tenantId, candidate.id],
      'UPDATE',
    );
    compareAttempt(persistedAttempt, candidate);
    if (persistedAttempt.request_id !== request.id) deny('AUTHORITY_MISMATCH');
    if (
      candidate.protocol !== request.protocol ||
      candidate.endpoint !== request.endpoint ||
      candidate.dispatchProfileId !== request.supplyProfileId ||
      candidate.routeTargetMode !== request.routeTargetMode
    ) {
      deny('AUTHORITY_MISMATCH');
    }

    const entitlement = await lockOne(
      executor,
      'entitlement',
      'saas_project_entitlements',
      'tenant_id = $1 AND project_id = $2 AND id = $3',
      [request.tenantId, request.projectId, request.entitlementId],
      null,
    );
    assertMatch(entitlement, [
      ['tenant_id', request.tenantId],
      ['project_id', request.projectId],
      ['id', request.entitlementId],
      ['supply_profile_id', request.supplyProfileId],
      ['supply_mode', request.supplyMode],
      ['authz_version', request.entitlementVersion],
    ]);
    if (!containsScope(entitlement, 'model_scopes', request.publicModel)) deny('AUTHORITY_MISMATCH');
    const profile = await lockOne(
      executor,
      'profile',
      'saas_supply_profiles',
      'tenant_id = $1 AND id = $2 AND supply_mode = $3',
      [request.tenantId, request.supplyProfileId, request.supplyMode],
      null,
    );
    assertMatch(profile, [
      ['tenant_id', request.tenantId],
      ['id', request.supplyProfileId],
      ['supply_mode', request.supplyMode],
      ['authz_version', request.supplyProfileVersion],
    ]);
    assertActiveStatus(profile);
    if (!containsScope(profile, 'model_scopes', request.publicModel)) deny('AUTHORITY_MISMATCH');
    if (
      positiveVersion(request.modelScopeVersion) !==
      (positiveVersion(entitlement.authz_version) > positiveVersion(profile.authz_version)
        ? positiveVersion(entitlement.authz_version)
        : positiveVersion(profile.authz_version))
    ) {
      deny('AUTHORITY_MISMATCH');
    }

    const routeRows = await rows(
      executor,
      `/* postgres-request-admission:route */
       SELECT rv.*, h.current_version AS head_version, h.status AS head_status,
              pm.alias AS public_model_alias, pm.status AS public_model_status,
              pmv.status AS public_model_version_status, pmv.provider_id AS model_provider_id,
              pmv.product_id AS model_product_id, pmv.model AS public_model_name,
              pmv.endpoint_scope
         FROM saas_route_config_versions rv
         JOIN saas_route_config_heads h
           ON h.tenant_id = rv.tenant_id AND h.project_id = rv.project_id AND h.route_id = rv.route_id
         JOIN saas_public_model_versions pmv
           ON pmv.public_model_id = rv.public_model_id AND pmv.version = rv.public_model_version
         JOIN saas_public_models pm ON pm.id = pmv.public_model_id
        WHERE rv.tenant_id = $1 AND rv.project_id = $2 AND rv.route_id = $3 AND rv.version = $4
        LIMIT 2`,
      [request.tenantId, request.projectId, request.routeConfigId, request.routeConfigVersion],
    );
    const route = requiredOne(routeRows);
    assertMatch(route, [
      ['tenant_id', request.tenantId],
      ['project_id', request.projectId],
      ['route_id', request.routeConfigId],
      ['version', request.routeConfigVersion],
      ['public_model_id', request.routePublicModelId],
      ['public_model_version', request.routePublicModelVersion],
      ['protocol', request.routeProtocol],
      ['supply_mode', request.supplyMode],
      ['target_mode', request.routeTargetMode],
      ['upstream_id', request.routeUpstreamId],
      ['endpoint', request.endpoint],
      ['public_model_alias', request.publicModel],
      ['public_model_name', candidate.resolvedModel],
      ['model_provider_id', candidate.providerId],
      ['model_product_id', candidate.productId],
      ['head_version', request.routeConfigVersion],
    ]);
    if (
      route.status !== 'active' ||
      route.head_status !== 'active' ||
      route.public_model_status !== 'active' ||
      route.public_model_version_status !== 'active'
    )
      deny('AUTHORITY_MISMATCH');
    if (
      (request.supplyMode === 'byok' && request.routeTargetMode !== 'tenant_account') ||
      (request.supplyMode === 'platform' && request.routeTargetMode !== 'platform_pool')
    ) {
      deny('AUTHORITY_MISMATCH');
    }
    if (
      request.configVersion == null ||
      !same(request.configVersion, request.routeConfigVersion) ||
      !same(candidate.routeConfigId, request.routeConfigId) ||
      !same(candidate.routeConfigVersion, request.routeConfigVersion) ||
      candidate.routeProtocol !== request.routeProtocol ||
      candidate.routeTargetMode !== request.routeTargetMode
    )
      deny('AUTHORITY_MISMATCH');
    if (!Array.isArray(route.endpoint_scope) || !route.endpoint_scope.includes(request.endpoint))
      deny('AUTHORITY_MISMATCH');
    if (
      candidate.upstreamId !== request.routeUpstreamId ||
      candidate.resolvedModel !== route.public_model_name ||
      candidate.providerId !== route.model_provider_id ||
      candidate.productId !== route.model_product_id
    )
      deny('AUTHORITY_MISMATCH');

    const commercial = await lockOne(
      executor,
      'commercial',
      'saas_route_config_commercial_authorities',
      'tenant_id = $1 AND project_id = $2 AND route_id = $3 AND route_version = $4',
      [request.tenantId, request.projectId, request.routeConfigId, request.routeConfigVersion],
      null,
    );
    assertMatch(commercial, [
      ['tenant_id', request.tenantId],
      ['project_id', request.projectId],
      ['route_id', request.routeConfigId],
      ['route_version', request.routeConfigVersion],
      ['customer_policy_id', request.customerMeteringPolicyId],
      ['customer_policy_version', request.customerMeteringPolicyVersion],
      ['provider_policy_id', request.providerMeteringPolicyId],
      ['provider_policy_version', request.providerMeteringPolicyVersion],
      ['contract_attestation_id', request.contractAttestationId],
      ['customer_price_version', request.customerPriceVersion],
      ['supplier_cost_version', candidate.supplierCostVersion],
    ]);
    const customerPolicy = requiredOne(
      await rows(
        executor,
        `/* postgres-request-admission:customer-policy */
      SELECT cp.*, ch.current_version AS head_version, ch.status AS head_status
        FROM saas_customer_metering_policy_versions cp
        JOIN saas_customer_metering_policy_heads ch
          ON ch.tenant_id = cp.tenant_id AND ch.project_id = cp.project_id AND ch.policy_id = cp.policy_id
       WHERE cp.tenant_id = $1 AND cp.project_id = $2 AND cp.policy_id = $3 AND cp.version = $4
       LIMIT 2`,
        [request.tenantId, request.projectId, request.customerMeteringPolicyId, request.customerMeteringPolicyVersion],
      ),
    );
    const providerPolicy = requiredOne(
      await rows(
        executor,
        `/* postgres-request-admission:provider-policy */
      SELECT pp.*, ph.current_version AS head_version, ph.status AS head_status
        FROM saas_provider_metering_policy_versions pp
        JOIN saas_provider_metering_policy_heads ph
          ON ph.tenant_id = pp.tenant_id AND ph.project_id = pp.project_id AND ph.policy_id = pp.policy_id
       WHERE pp.tenant_id = $1 AND pp.project_id = $2 AND pp.policy_id = $3 AND pp.version = $4
       LIMIT 2`,
        [request.tenantId, request.projectId, request.providerMeteringPolicyId, request.providerMeteringPolicyVersion],
      ),
    );
    assertMatch(customerPolicy, [
      ['public_model_id', request.routePublicModelId],
      ['public_model_version', request.routePublicModelVersion],
      ['protocol', request.protocol],
      ['endpoint', request.endpoint],
      ['supply_mode', request.supplyMode],
      ['target_mode', request.routeTargetMode],
      ['head_version', request.customerMeteringPolicyVersion],
    ]);
    assertMatch(providerPolicy, [
      ['public_model_id', request.routePublicModelId],
      ['public_model_version', request.routePublicModelVersion],
      ['provider_id', candidate.providerId],
      ['product_id', candidate.productId],
      ['resolved_model', candidate.resolvedModel],
      ['protocol', request.protocol],
      ['endpoint', request.endpoint],
      ['supply_mode', request.supplyMode],
      ['target_mode', request.routeTargetMode],
      ['head_version', request.providerMeteringPolicyVersion],
    ]);
    if (
      customerPolicy.status !== 'active' ||
      customerPolicy.head_status !== 'active' ||
      providerPolicy.status !== 'active' ||
      providerPolicy.head_status !== 'active'
    )
      deny('AUTHORITY_MISMATCH');
    const attestation = await lockOne(
      executor,
      'attestation',
      'saas_contract_test_attestations',
      'tenant_id = $1 AND project_id = $2 AND id = $3',
      [request.tenantId, request.projectId, request.contractAttestationId],
      null,
    );
    assertMatch(attestation, [
      ['provider_policy_id', request.providerMeteringPolicyId],
      ['provider_policy_version', request.providerMeteringPolicyVersion],
      ['public_model_id', request.routePublicModelId],
      ['public_model_version', request.routePublicModelVersion],
      ['protocol', request.protocol],
      ['endpoint', request.endpoint],
      ['supply_mode', request.supplyMode],
      ['target_mode', request.routeTargetMode],
    ]);
    if (attestation.verification_result !== 'verified') deny('AUTHORITY_MISMATCH');

    const accountTable =
      candidate.accountOwnerKind === 'tenant' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
    const accountWhere = candidate.accountOwnerKind === 'tenant' ? 'tenant_id = $1 AND id = $2' : 'id = $1';
    const accountValues =
      candidate.accountOwnerKind === 'tenant' ? [request.tenantId, candidate.accountId] : [candidate.accountId];
    const account = await lockOne(executor, 'account', accountTable, accountWhere, accountValues);
    const ownerKind =
      candidate.accountOwnerKind === 'tenant'
        ? 'tenant'
        : candidate.accountOwnerKind === 'platform'
          ? 'platform'
          : deny('AUTHORITY_MISMATCH');
    assertAccount(account, ownerKind, request.supplyMode, candidate);
    if (account.credential_type == null || account.region == null || account.purpose == null) storage();

    const rights = await lockOne(
      executor,
      'account-rights',
      'saas_provider_rights',
      'rights_id = $1 AND version = $2',
      [account.rights_id, account.rights_version],
      null,
    );
    assertRights(
      rights,
      request.supplyMode,
      requiredText(candidate.providerId),
      requiredText(candidate.productId),
      requiredText(candidate.resolvedModel),
      requiredText(candidate.endpoint),
      {
        credentialType: requiredText(account.credential_type),
        region: requiredText(account.region),
        purpose: requiredText(account.purpose),
      },
    );
    const credentialTable =
      candidate.accountOwnerKind === 'tenant'
        ? 'saas_tenant_provider_credentials'
        : 'saas_platform_provider_credentials';
    const credentialWhere =
      candidate.accountOwnerKind === 'tenant'
        ? 'tenant_id = $1 AND id = $2 AND account_id = $3'
        : 'id = $1 AND account_id = $2';
    const credentialValues =
      candidate.accountOwnerKind === 'tenant'
        ? [request.tenantId, candidate.credentialId, candidate.accountId]
        : [candidate.credentialId, candidate.accountId];
    const credential = await lockOne(executor, 'credential', credentialTable, credentialWhere, credentialValues);
    assertCredential(credential, ownerKind, request.supplyMode, candidate);
    if (credential.credential_type !== account.credential_type) deny('AUTHORITY_MISMATCH');
    const credentialVersionTable =
      candidate.accountOwnerKind === 'tenant'
        ? 'saas_tenant_provider_credential_versions'
        : 'saas_platform_provider_credential_versions';
    const credentialVersionWhere =
      candidate.accountOwnerKind === 'tenant'
        ? 'tenant_id = $1 AND credential_id = $2 AND account_id = $3 AND version = $4'
        : 'credential_id = $1 AND account_id = $2 AND version = $3';
    const credentialVersionValues =
      candidate.accountOwnerKind === 'tenant'
        ? [request.tenantId, candidate.credentialId, candidate.accountId, candidate.credentialVersion]
        : [candidate.credentialId, candidate.accountId, candidate.credentialVersion];
    const credentialVersion = await lockOne(
      executor,
      'credential-version',
      credentialVersionTable,
      credentialVersionWhere,
      credentialVersionValues,
    );
    assertCredentialVersion(credentialVersion, ownerKind, request.supplyMode, candidate);

    let pool: Row | null = null;
    let member: Row | null = null;
    let grant: Row | null = null;
    let mapping: Row | null = null;
    let poolRights: Row | null = null;
    if (request.supplyMode === 'byok') {
      mapping = await lockOne(
        executor,
        'mapping',
        'saas_tenant_provider_supply_profile_accounts',
        'tenant_id = $1 AND supply_profile_id = $2 AND account_id = $3',
        [request.tenantId, request.supplyProfileId, candidate.accountId],
      );
      if (
        mapping.status !== 'active' ||
        !same(mapping.provider_id, candidate.providerId) ||
        !same(mapping.product_id, candidate.productId) ||
        !same(mapping.account_authz_version, candidate.accountAuthzVersion) ||
        !same(mapping.authz_version, candidate.profileAccountAuthzVersion)
      )
        deny('AUTHORITY_MISMATCH');
      assertBindingEvidence(mapping);
    } else {
      pool = await lockOne(executor, 'pool', 'saas_platform_provider_pools', 'id = $1', [candidate.poolId], null);
      if (
        pool.status !== 'active' ||
        pool.validation_state !== 'verified' ||
        !same(pool.authz_version, candidate.poolAuthzVersion) ||
        !same(pool.provider_id, candidate.providerId) ||
        !same(pool.product_id, candidate.productId) ||
        pool.owner_kind !== 'platform' ||
        pool.supply_mode !== 'platform'
      )
        deny('AUTHORITY_MISMATCH');
      if (
        pool.credential_type !== account.credential_type ||
        pool.region !== account.region ||
        pool.purpose !== account.purpose
      )
        deny('AUTHORITY_MISMATCH');
      poolRights = await lockOne(
        executor,
        'pool-rights',
        'saas_provider_rights',
        'rights_id = $1 AND version = $2',
        [pool.rights_id, pool.rights_version],
        null,
      );
      assertRights(
        poolRights,
        'platform',
        requiredText(candidate.providerId),
        requiredText(candidate.productId),
        requiredText(candidate.resolvedModel),
        requiredText(candidate.endpoint),
        {
          credentialType: requiredText(pool.credential_type),
          region: requiredText(pool.region),
          purpose: requiredText(pool.purpose),
        },
      );
      member = await lockOne(
        executor,
        'pool-member',
        'saas_platform_provider_pool_members',
        'pool_id = $1 AND account_id = $2',
        [candidate.poolId, candidate.accountId],
      );
      if (
        member.status !== 'active' ||
        !same(member.provider_id, candidate.providerId) ||
        !same(member.product_id, candidate.productId) ||
        !same(member.authz_version, candidate.poolMemberAuthzVersion) ||
        !same(member.account_authz_version, candidate.poolMemberAccountAuthzVersion) ||
        !same(member.account_authz_version, candidate.accountAuthzVersion)
      )
        deny('AUTHORITY_MISMATCH');
      grant = await lockOne(
        executor,
        'pool-grant',
        'saas_platform_provider_pool_grants',
        'pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3',
        [candidate.poolId, request.tenantId, request.supplyProfileId],
      );
      if (
        grant.status !== 'active' ||
        grant.supply_mode !== 'platform' ||
        !same(grant.profile_authz_version, candidate.supplyProfileAuthzVersion) ||
        !same(grant.profile_authz_version, candidate.poolGrantProfileAuthzVersion) ||
        !same(grant.pool_authz_version, candidate.poolAuthzVersion) ||
        !same(grant.pool_authz_version, candidate.poolGrantPoolAuthzVersion) ||
        !same(grant.authz_version, candidate.poolGrantAuthzVersion)
      )
        deny('AUTHORITY_MISMATCH');
      assertBindingEvidence(grant);
    }

    const authorityAt = await databaseClock(executor);
    assertWindow(entitlement, authorityAt);
    if (
      entitlement.status !== 'active' &&
      !(entitlement.status === 'superseded' && (rowDate(entitlement, 'superseded_at') ?? new Date(0)) <= authorityAt)
    )
      deny('AUTHORITY_MISMATCH');
    assertWindow(mapping ?? {}, authorityAt);
    assertWindow(grant ?? {}, authorityAt);
    assertWindow(credential, authorityAt);
    assertWindow(credentialVersion, authorityAt);
    assertWindow(rights, authorityAt);
    if (pool) assertWindow(pool, authorityAt);
    if (member) assertWindow(member, authorityAt);

    let eligibility: ProviderEligibilityResult;
    try {
      eligibility = await this.catalog.evaluateProviderEligibility(
        {
          providerId: requiredText(candidate.providerId),
          productId: requiredText(candidate.productId),
          model: requiredText(candidate.resolvedModel),
          endpoint: requiredText(candidate.endpoint),
          credentialType: requiredText(account.credential_type),
          supplyMode: request.supplyMode,
          region: requiredText(account.region),
          purpose: requiredText(account.purpose),
        },
        authorityAt,
        executor,
      );
    } catch (error) {
      if (error instanceof SaasCatalogError) throw error;
      storage();
    }
    if (
      eligibility.decision !== 'allow' ||
      eligibility.capability.protocol !== candidate.protocol ||
      String(eligibility.rights.rightsId) !== String(account.rights_id) ||
      String(eligibility.rights.version) !== String(account.rights_version)
    )
      deny('AUTHORITY_MISMATCH');
    const capability = requiredOne(
      await rows(
        executor,
        `/* postgres-request-admission:capability */
      SELECT * FROM saas_provider_capabilities
       WHERE provider_id = $1 AND product_id = $2 AND model = $3 AND endpoint = $4 AND version = $5
       LIMIT 2`,
        [
          candidate.providerId,
          candidate.productId,
          candidate.resolvedModel,
          candidate.endpoint,
          eligibility.capability.version,
        ],
      ),
    );
    assertCapabilityRow(capability, candidate);
    const accountCapabilityTable =
      candidate.accountOwnerKind === 'tenant'
        ? 'saas_tenant_provider_account_capabilities'
        : 'saas_platform_provider_account_capabilities';
    const accountCapabilityWhere =
      candidate.accountOwnerKind === 'tenant'
        ? 'tenant_id = $1 AND account_id = $2 AND provider_id = $3 AND product_id = $4 AND model = $5 AND endpoint = $6 AND capability_version = $7'
        : 'account_id = $1 AND provider_id = $2 AND product_id = $3 AND model = $4 AND endpoint = $5 AND capability_version = $6';
    const accountCapabilityValues =
      candidate.accountOwnerKind === 'tenant'
        ? [
            request.tenantId,
            candidate.accountId,
            candidate.providerId,
            candidate.productId,
            candidate.resolvedModel,
            candidate.endpoint,
            eligibility.capability.version,
          ]
        : [
            candidate.accountId,
            candidate.providerId,
            candidate.productId,
            candidate.resolvedModel,
            candidate.endpoint,
            eligibility.capability.version,
          ];
    const accountCapability = await lockOne(
      executor,
      'account-capability',
      accountCapabilityTable,
      accountCapabilityWhere,
      accountCapabilityValues,
      null,
    );
    assertAccountCapability(accountCapability, candidate, eligibility.capability.version);

    let customerIdentityRow: Row | null = null;
    let supplierIdentityRow: Row | null = null;
    if (request.supplyMode === 'platform') {
      const customerPriceVersion = requiredText(request.customerPriceVersion);
      const supplierCostVersion = requiredText(candidate.supplierCostVersion);
      if (
        customerPolicy.customer_price_version !== customerPriceVersion ||
        providerPolicy.supplier_cost_version !== supplierCostVersion
      )
        deny('AUTHORITY_MISMATCH');
      customerIdentityRow = await lockOne(
        executor,
        'customer-price-identity',
        'saas_customer_price_versions',
        'id = $1',
        [customerPriceVersion],
        null,
      );
      supplierIdentityRow = await lockOne(
        executor,
        'supplier-cost-identity',
        'saas_supplier_cost_versions',
        'id = $1',
        [supplierCostVersion],
        null,
      );
    }

    const finalAt = await databaseClock(executor);
    assertWindow(entitlement, finalAt);
    assertWindow(credential, finalAt);
    assertWindow(credentialVersion, finalAt);
    assertWindow(rights, finalAt);
    assertWindow(account, finalAt);
    assertWindow(key, finalAt);
    if (poolRights) assertWindow(poolRights, finalAt);
    if (mapping) assertWindow(mapping, finalAt);
    if (grant) assertWindow(grant, finalAt);
    if (input.holdEvidence) {
      const evidence = validateHoldEvidence(input.holdEvidence);
      const expiresAt = new Date(String(evidence.admissionExpiresAt));
      if (expiresAt <= finalAt) deny('EXPIRED');
    }

    if (request.supplyMode === 'byok') {
      if (
        request.customerPriceVersion != null ||
        candidate.supplierCostVersion != null ||
        customerPolicy.customer_price_version != null ||
        providerPolicy.supplier_cost_version != null ||
        commercial.customer_price_version != null ||
        commercial.supplier_cost_version != null
      )
        deny('AUTHORITY_MISMATCH');
      return {
        authorization: this.authorizationFrom(request),
        candidate: toInitialAttempt(candidate),
        platformPriceHold: null,
      };
    }

    const evidence = validateHoldEvidence(input.holdEvidence as PlatformRequestAdmissionHoldEvidence);
    const customerPriceVersion = requiredText(request.customerPriceVersion);
    const supplierCostVersion = requiredText(candidate.supplierCostVersion);
    const customerCurrency = assertOutputPriceIdentity(customerIdentityRow ?? storage(), {
      publicModelId: requiredText(request.routePublicModelId),
      publicModelVersion: requiredText(request.routePublicModelVersion),
      providerId: requiredText(candidate.providerId),
      productId: requiredText(candidate.productId),
      protocol: request.protocol,
      endpoint: request.endpoint,
    });
    const customerPrice = await this.pricing.resolveCustomerPriceVersion(
      {
        publicModelId: requiredText(request.routePublicModelId),
        publicModelVersion: requiredText(request.routePublicModelVersion),
        providerId: requiredText(candidate.providerId),
        productId: requiredText(candidate.productId),
        protocol: request.protocol,
        endpoint: request.endpoint,
        currency: customerCurrency,
        at: finalAt,
      },
      { executor },
    );
    if (
      customerPrice.id !== customerPriceVersion ||
      customerPrice.commercialPolicyVersion !== customerPolicy.commercial_policy_version ||
      customerPrice.roundingVersion !== customerPolicy.rounding_version ||
      customerPrice.roundingMode !== customerPolicy.rounding_mode ||
      customerPrice.roundingBoundary !== customerPolicy.rounding_boundary
    )
      deny('PRICE_UNAVAILABLE');
    const supplierCurrency = assertOutputPriceIdentity(
      supplierIdentityRow ?? storage(),
      {
        publicModelId: requiredText(request.routePublicModelId),
        publicModelVersion: requiredText(request.routePublicModelVersion),
        providerId: requiredText(candidate.providerId),
        productId: requiredText(candidate.productId),
        protocol: request.protocol,
        endpoint: request.endpoint,
      },
      requiredText(candidate.resolvedModel),
    );
    const supplierCost = await this.pricing.resolveSupplierCostVersion(
      {
        publicModelId: requiredText(request.routePublicModelId),
        publicModelVersion: requiredText(request.routePublicModelVersion),
        providerId: requiredText(candidate.providerId),
        productId: requiredText(candidate.productId),
        resolvedModel: requiredText(candidate.resolvedModel),
        protocol: request.protocol,
        endpoint: request.endpoint,
        currency: supplierCurrency,
        at: finalAt,
      },
      { executor },
    );
    if (
      supplierCost.id !== supplierCostVersion ||
      supplierCost.commercialPolicyVersion !== providerPolicy.commercial_policy_version ||
      supplierCost.roundingVersion !== providerPolicy.rounding_version ||
      supplierCost.roundingMode !== providerPolicy.rounding_mode ||
      supplierCost.roundingBoundary !== providerPolicy.rounding_boundary
    )
      deny('PRICE_UNAVAILABLE');
    let conservative: ConservativePriceHold;
    try {
      conservative = calculateConservativePriceHold(customerPrice, {
        inputUpperBound: evidence.inputTotal,
        outputUpperBound: evidence.outputTotal,
        feasibleInputBuckets: INPUT_BILLING_BUCKETS,
      });
    } catch (error) {
      if (error instanceof SaasPricingError) throw error;
      deny('PRICE_UNAVAILABLE');
    }
    if (conservative.calculation.amountMinorUnits <= 0n) deny('PRICE_UNAVAILABLE');
    const snapshot = await this.pricing.createCustomerPriceSnapshot(
      {
        tenantId: request.tenantId,
        requestId: request.id,
        customerPriceVersion,
        holdInput: conservative.witness,
        admissionExpiresAt: evidence.admissionExpiresAt,
        idempotencyKey: request.id,
      },
      { executor },
    );
    if (!snapshot.walletHoldRequired || snapshot.admissionTerms.currency !== customerPrice.currency)
      deny('PRICE_UNAVAILABLE');
    const platformPriceHold: SaasRequestAdmissionPlatformPriceHoldFacts = {
      currency: snapshot.admissionTerms.currency,
      amountMinorUnits: snapshot.admissionTerms.amountMinorUnits,
      priceSnapshotRef: snapshot.admissionTerms.priceSnapshotRef,
      expiresAt: snapshot.admissionTerms.expiresAt,
      customerPriceVersion,
      supplierCostVersion,
    };
    return {
      authorization: this.authorizationFrom(request),
      candidate: toInitialAttempt(candidate),
      platformPriceHold,
    };
  }

  private authorizationFrom(request: RequestRecord): AuthorizationBindingInput {
    return {
      tenantId: request.tenantId,
      projectId: request.projectId,
      proxyKeyId: request.proxyKeyId,
      entitlementId: request.entitlementId,
      supplyProfileId: request.supplyProfileId,
      supplyProfileVersion: request.supplyProfileVersion,
      modelScopeVersion: request.modelScopeVersion,
      supplyMode: request.supplyMode,
      principalKind: request.principalKind,
      principalId: request.principalId,
      authzVersion: request.authzVersion,
      entitlementVersion: request.entitlementVersion,
      configVersion: request.configVersion,
      projectPolicyVersion: request.projectPolicyVersion,
    };
  }
}

export { PostgresRequestAdmissionGuard as PostgresSaasRequestAdmissionGuard };
