import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../db/index.js';
import type { SupplyMode } from '../gateway/contracts.js';
import type { TenantContext } from '../identity/types.js';
import {
  type ApiKeyMetadata,
  type ApiKeyPrincipalKind,
  type ApiKeyStatus,
  type AuthenticatedApiKey,
  type CreateApiKeyInput,
  type CreatedApiKey,
  SaasKeyError,
  type SaasKeyServiceOptions,
  type SupplyProfileResolution,
  type SupplyProfileResolveOptions,
  type SupplyProfileResolver,
} from './types.js';

const MANAGEMENT_ROLES = new Set(['owner', 'admin', 'developer']);
// Keep project-service key creation/rotation owner-admin-only unless policy is explicitly broadened.
const OWNER_ADMIN_ROLES = new Set(['owner', 'admin']);
const SECRET_BYTES = 32;
const MAX_KEY_NAME_LENGTH = 120;
const MAX_MODEL_LENGTH = 200;
const MAX_SCOPE_COUNT = 256;
const CUSTOMER_KEY_PATTERN = /^mr_live_[A-Za-z0-9_-]{43}$/;
const SHARED_ADVISORY_FENCE_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
const EXCLUSIVE_ADVISORY_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';
const PROVIDER_RIGHTS_AUTHORIZATION_FENCE_KEY = 'saas-authz:provider-rights';

type AdvisoryFenceMode = 'shared' | 'exclusive';

interface AdvisoryFenceRequest {
  readonly key: string;
  readonly mode: AdvisoryFenceMode;
}

async function lockAdvisoryFenceLayer(tx: SqlExecutor, requests: readonly AdvisoryFenceRequest[]): Promise<void> {
  const modes = new Map<string, AdvisoryFenceMode>();
  for (const request of requests) {
    const previous = modes.get(request.key);
    if (previous === 'exclusive' || request.mode === previous) continue;
    modes.set(request.key, request.mode === 'exclusive' ? 'exclusive' : (previous ?? request.mode));
  }
  for (const key of sortAndDedupeAdvisoryKeys([...modes.keys()])) {
    const mode = modes.get(key);
    await tx.query(mode === 'exclusive' ? EXCLUSIVE_ADVISORY_FENCE_SQL : SHARED_ADVISORY_FENCE_SQL, [key]);
  }
}

/*
 * Key writes acquire tenant/project fences, then sorted user fences before
 * membership checks. Creation rechecks entitlement/profile and provider
 * rights before inserting a new key; rotation locks the existing key row
 * before rechecking its stored entitlement/profile and provider rights. This
 * follows the plan's tenant -> authorization/key binding -> entitlement,
 * profile and route -> audit row-lock order. Mutable authority relations are
 * plain SELECTs; migration 047 makes each writer wait on the matching fence.
 */

type TimestampValue = string | Date;

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  project_id: string;
  principal_user_id: string | null;
  execution_principal_type: ApiKeyPrincipalKind;
  execution_principal_id: string;
  created_by_user_id: string;
  rotated_by_user_id: string | null;
  revoked_by_user_id: string | null;
  entitlement_id: string | null;
  supply_profile_id: string;
  supply_mode: SupplyMode;
  name: string;
  prefix: string;
  model_scopes: string[];
  status: ApiKeyStatus;
  created_at: TimestampValue;
  expires_at: TimestampValue | null;
  revoked_at: TimestampValue | null;
  last_used_at: TimestampValue | null;
  authz_version: number | string;
  model_scope_version: number | string;
  entitlement_authz_version: number | string | null;
  supply_profile_authz_version: number | string | null;
}

export const unavailableSupplyProfileResolver: SupplyProfileResolver = {
  async resolve(): Promise<SupplyProfileResolution> {
    throw new SaasKeyError(503, 'KEY_SUPPLY_UNAVAILABLE', 'Supply profile entitlement resolution is unavailable');
  },
};

function fail(status: number, code: SaasKeyError['code'], message: string): never {
  throw new SaasKeyError(status, code, message);
}

function isManagementRole(value: unknown): boolean {
  return typeof value === 'string' && MANAGEMENT_ROLES.has(value);
}

function assertContext(context: TenantContext): void {
  if (
    !context ||
    typeof context.userId !== 'string' ||
    context.userId.trim() === '' ||
    typeof context.tenantId !== 'string' ||
    context.tenantId.trim() === '' ||
    typeof context.projectId !== 'string' ||
    context.projectId.trim() === '' ||
    !isManagementRole(context.tenantRole) ||
    !isManagementRole(context.projectRole)
  ) {
    fail(403, 'KEY_ACCESS_DENIED', 'The tenant and project roles cannot manage API keys');
  }
}

function currentDate(now: () => Date): Date {
  const value = now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service clock is invalid');
  }
  return date;
}

function timestamp(value: TimestampValue): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid timestamp');
  }
  return date.toISOString();
}

function nullableTimestamp(value: TimestampValue | null): string | null {
  return value === null ? null : timestamp(value);
}

function authzVersion(value: number | string): number {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid authorization version');
  }
  return version;
}

function databaseVersion(value: unknown, label: string): string {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) parsed = BigInt(value.trim());
    else fail(500, 'KEY_STORAGE_ERROR', `The key service returned an invalid ${label}`);
  } catch (error) {
    if (error instanceof SaasKeyError) throw error;
    fail(500, 'KEY_STORAGE_ERROR', `The key service returned an invalid ${label}`);
  }
  if (parsed < 1n || parsed > 9223372036854775807n) {
    fail(500, 'KEY_STORAGE_ERROR', `The key service returned an invalid ${label}`);
  }
  return parsed.toString(10);
}

function nullableAuthzVersion(value: number | string | null): number | null {
  return value === null ? null : authzVersion(value);
}

function databaseDate(value: unknown, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    fail(500, 'KEY_STORAGE_ERROR', `The key service returned an invalid ${label}`);
  }
  return date;
}

function assertDatabaseWindow(
  effectiveAt: unknown,
  expiresAt: unknown,
  now: Date,
  label: string,
  allowSupersededAt?: unknown,
): void {
  const effective = databaseDate(effectiveAt, `${label} effective_at`);
  const expires = expiresAt === null || expiresAt === undefined ? null : databaseDate(expiresAt, `${label} expires_at`);
  if (effective > now || (expires !== null && expires <= now)) {
    fail(403, 'KEY_NO_ENTITLEMENT', `The ${label} is outside its validity window`);
  }
  if (allowSupersededAt !== undefined) {
    const superseded = allowSupersededAt === null ? null : databaseDate(allowSupersededAt, `${label} superseded_at`);
    if (superseded === null || superseded > now) {
      fail(403, 'KEY_NO_ENTITLEMENT', `The ${label} is not valid for an existing key`);
    }
  }
}

function nextAuthzVersion(value: number | string): number {
  const current = authzVersion(value);
  if (current === Number.MAX_SAFE_INTEGER) {
    fail(500, 'KEY_STORAGE_ERROR', 'The API key authorization version cannot advance');
  }
  return current + 1;
}

function supplyMode(value: unknown): SupplyMode {
  if (value !== 'byok' && value !== 'platform') {
    fail(400, 'KEY_INVALID_INPUT', 'supplyMode must be byok or platform');
  }
  return value;
}

function principalKind(value: unknown): ApiKeyPrincipalKind {
  if (value === undefined) return 'member';
  if (value !== 'member' && value !== 'project_service') {
    fail(400, 'KEY_INVALID_INPUT', 'principalKind must be member or project_service');
  }
  return value;
}

function storedPrincipalKind(value: unknown): ApiKeyPrincipalKind {
  if (value !== 'member' && value !== 'project_service') {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid execution principal type');
  }
  return value;
}

function storedId(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(500, 'KEY_STORAGE_ERROR', message);
  }
  return value;
}

function storedNullableId(value: unknown, message: string): string | null {
  return value === null ? null : storedId(value, message);
}

function storedSupplyMode(value: unknown): SupplyMode {
  if (value !== 'byok' && value !== 'platform') {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid supply mode');
  }
  return value;
}

function storedScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_COUNT) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned invalid model scopes');
  }
  const scopes = value.map((candidate: unknown) => {
    if (
      typeof candidate !== 'string' ||
      candidate.trim() === '' ||
      candidate.trim() !== candidate ||
      candidate.length > MAX_MODEL_LENGTH
    ) {
      fail(500, 'KEY_STORAGE_ERROR', 'The key service returned invalid model scopes');
    }
    return candidate;
  });
  if (new Set(scopes).size !== scopes.length) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned invalid model scopes');
  }
  return scopes;
}

function metadata(row: ApiKeyRow): ApiKeyMetadata {
  if (row.status !== 'active' && row.status !== 'revoked') {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid key');
  }
  const id = storedId(row.id, 'The key service returned an invalid key identifier');
  const tenantId = storedId(row.tenant_id, 'The key service returned an invalid tenant identifier');
  const projectId = storedId(row.project_id, 'The key service returned an invalid project identifier');
  const name = storedId(row.name, 'The key service returned an invalid key name');
  if (name.length > MAX_KEY_NAME_LENGTH || !/^mr_live_[A-Za-z0-9_-]{8,}$/.test(row.prefix)) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned invalid key metadata');
  }
  const prefix = row.prefix;
  const executionPrincipalType = storedPrincipalKind(row.execution_principal_type);
  const executionPrincipalId = storedId(
    row.execution_principal_id,
    'The key service returned an invalid execution principal',
  );
  const principalUserId = storedNullableId(
    row.principal_user_id,
    'The key service returned an invalid member principal',
  );
  if (
    (executionPrincipalType === 'member' && (principalUserId === null || executionPrincipalId !== principalUserId)) ||
    (executionPrincipalType === 'project_service' && (principalUserId !== null || executionPrincipalId !== projectId))
  ) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid execution principal binding');
  }
  const createdByUserId = storedId(row.created_by_user_id, 'The key service returned an invalid key creator');
  const entitlementId = storedNullableId(
    row.entitlement_id,
    'The key service returned an invalid entitlement identifier',
  );
  const entitlementAuthzVersion = nullableAuthzVersion(row.entitlement_authz_version);
  const supplyProfileAuthzVersion = nullableAuthzVersion(row.supply_profile_authz_version);
  if (
    (entitlementId === null && (entitlementAuthzVersion !== null || supplyProfileAuthzVersion !== null)) ||
    (entitlementId !== null && (entitlementAuthzVersion === null || supplyProfileAuthzVersion === null))
  ) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an incomplete authorization binding');
  }
  const revokedAt = nullableTimestamp(row.revoked_at);
  if ((row.status === 'active' && revokedAt !== null) || (row.status === 'revoked' && revokedAt === null)) {
    fail(500, 'KEY_STORAGE_ERROR', 'The key service returned an invalid key status');
  }
  return {
    id,
    tenantId,
    projectId,
    principalUserId,
    executionPrincipalType,
    executionPrincipalId,
    createdByUserId,
    rotatedByUserId:
      row.rotated_by_user_id === null
        ? null
        : storedId(row.rotated_by_user_id, 'The key service returned an invalid rotation actor'),
    revokedByUserId:
      row.revoked_by_user_id === null
        ? null
        : storedId(row.revoked_by_user_id, 'The key service returned an invalid revocation actor'),
    entitlementId,
    supplyProfileId: storedId(row.supply_profile_id, 'The key service returned an invalid supply profile'),
    supplyMode: storedSupplyMode(row.supply_mode),
    name,
    prefix,
    modelScopes: storedScopes(row.model_scopes),
    status: row.status,
    createdAt: timestamp(row.created_at),
    expiresAt: nullableTimestamp(row.expires_at),
    revokedAt,
    lastUsedAt: nullableTimestamp(row.last_used_at),
    authzVersion: authzVersion(row.authz_version),
    modelScopeVersion: authzVersion(row.model_scope_version),
    entitlementAuthzVersion,
    supplyProfileAuthzVersion,
  };
}

function isCustomerProxyKey(value: unknown): value is string {
  return typeof value === 'string' && CUSTOMER_KEY_PATTERN.test(value);
}

function secretDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function issueSecret(): { secret: string; prefix: string; hash: string } {
  const randomPart = randomBytes(SECRET_BYTES).toString('base64url');
  const secret = `mr_live_${randomPart}`;
  return {
    secret,
    prefix: `mr_live_${randomPart.slice(0, 12)}`,
    hash: secretDigest(secret),
  };
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'KEY_INVALID_INPUT', 'A key name is required');
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_KEY_NAME_LENGTH) {
    fail(400, 'KEY_INVALID_INPUT', 'The key name is invalid');
  }
  return name;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_COUNT) {
    fail(400, 'KEY_INVALID_INPUT', 'modelScopes must be a non-empty array');
  }
  const scopes = value.map((candidate) => {
    if (typeof candidate !== 'string') fail(400, 'KEY_INVALID_INPUT', 'modelScopes must contain strings');
    const model = candidate.trim();
    if (model.length === 0 || model.length > MAX_MODEL_LENGTH) {
      fail(400, 'KEY_INVALID_INPUT', 'modelScopes contains an invalid model');
    }
    return model;
  });
  if (new Set(scopes).size !== scopes.length) {
    fail(400, 'KEY_INVALID_INPUT', 'modelScopes must not contain duplicates');
  }
  return scopes;
}

function normalizeExpiry(value: CreateApiKeyInput['expiresAt'], now: Date): Date | null {
  if (value === undefined || value === null) return null;
  const expiry = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    fail(400, 'KEY_INVALID_INPUT', 'expiresAt must be a future timestamp');
  }
  return expiry;
}

function normalizeResolution(resolution: SupplyProfileResolution | null): {
  entitlementId: string;
  profileId: string;
  mode: SupplyMode;
  allowedModels: Set<string>;
  entitlementAuthzVersion: number;
  supplyProfileAuthzVersion: number;
  modelScopeVersion: number;
} {
  if (!resolution) fail(403, 'KEY_NO_ENTITLEMENT', 'No API key supply entitlement is available');
  if (
    typeof resolution.entitlementId !== 'string' ||
    resolution.entitlementId.trim() === '' ||
    typeof resolution.profileId !== 'string' ||
    resolution.profileId.trim() === '' ||
    (resolution.mode !== 'byok' && resolution.mode !== 'platform') ||
    !Array.isArray(resolution.allowedModels) ||
    resolution.allowedModels.length === 0
  ) {
    fail(503, 'KEY_PROFILE_INVALID', 'The supply profile entitlement is invalid');
  }
  const allowedModels = new Set<string>();
  for (const candidate of resolution.allowedModels) {
    if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.length > MAX_MODEL_LENGTH) {
      fail(503, 'KEY_PROFILE_INVALID', 'The supply profile entitlement is invalid');
    }
    allowedModels.add(candidate.trim());
  }
  if (allowedModels.size === 0) fail(403, 'KEY_NO_ENTITLEMENT', 'No API key model entitlement is available');
  const entitlementAuthzVersion = authzSnapshotVersion(resolution.entitlementAuthzVersion);
  const supplyProfileAuthzVersion = authzSnapshotVersion(resolution.supplyProfileAuthzVersion);
  const modelScopeVersion =
    resolution.modelScopeVersion === undefined
      ? Math.max(entitlementAuthzVersion, supplyProfileAuthzVersion)
      : authzSnapshotVersion(resolution.modelScopeVersion);
  return {
    entitlementId: resolution.entitlementId.trim(),
    profileId: resolution.profileId.trim(),
    mode: resolution.mode,
    allowedModels,
    entitlementAuthzVersion,
    supplyProfileAuthzVersion,
    modelScopeVersion,
  };
}

function authzSnapshotVersion(value: unknown): number {
  const version =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    fail(503, 'KEY_PROFILE_INVALID', 'The supply profile entitlement has an invalid authorization version');
  }
  return version;
}

function assertScopesAllowed(scopes: readonly string[], allowedModels: ReadonlySet<string>): void {
  if (scopes.length === 0) fail(400, 'KEY_INVALID_INPUT', 'modelScopes must be non-empty');
  if (scopes.some((model) => !allowedModels.has(model))) {
    fail(403, 'KEY_SCOPE_NOT_ALLOWED', 'A requested model is not covered by the supply entitlement');
  }
}

function errorOrStorage(error: unknown): never {
  if (error instanceof SaasKeyError) throw error;
  fail(500, 'KEY_STORAGE_ERROR', 'The API key service could not complete the request');
}

export class KeyService {
  private readonly resolver: SupplyProfileResolver | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly database: SaasDatabase,
    options: SaasKeyServiceOptions = {},
  ) {
    this.resolver = options.resolver;
    this.now = options.now ?? (() => new Date());
  }

  private async query<Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    try {
      return await executor.query<Row>(sql, values);
    } catch (error) {
      errorOrStorage(error);
    }
  }

  private async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      errorOrStorage(error);
    }
  }

  private async resolve(
    context: TenantContext,
    mode: SupplyMode,
    options: SupplyProfileResolveOptions = {},
  ): Promise<ReturnType<typeof normalizeResolution>> {
    const resolver = this.resolver;
    if (!resolver || typeof resolver.resolve !== 'function') {
      fail(503, 'KEY_SUPPLY_UNAVAILABLE', 'Supply profile entitlement resolution is unavailable');
    }
    let result: SupplyProfileResolution | null;
    try {
      result = await resolver.resolve(context, mode, options);
    } catch (error) {
      if (error instanceof SaasKeyError) throw error;
      fail(503, 'KEY_SUPPLY_UNAVAILABLE', 'Supply profile entitlement resolution is unavailable');
    }
    return normalizeResolution(result);
  }

  private assertResolverAvailable(): void {
    if (!this.resolver || typeof this.resolver.resolve !== 'function') {
      fail(503, 'KEY_SUPPLY_UNAVAILABLE', 'Supply profile entitlement resolution is unavailable');
    }
  }

  private async audit(
    tx: SqlExecutor,
    context: TenantContext,
    action: string,
    targetId: string,
    occurredAt: Date,
  ): Promise<void> {
    await this.query(
      tx,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, $2, $3, $4, 'saas_api_key', $5, $6, 'console_api_keys')`,
      [randomUUID(), context.tenantId, context.userId, action, targetId, occurredAt],
    );
  }

  private async fenceTenantProjectAuthorization(
    tx: SqlExecutor,
    context: TenantContext,
    mode: AdvisoryFenceMode,
  ): Promise<void> {
    await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.tenant(context.tenantId), mode }]);
    await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.project(context.tenantId, context.projectId), mode }]);
  }

  private async fenceUserAndApiKeys(
    tx: SqlExecutor,
    userIds: readonly string[],
    apiKeyIds: readonly string[],
    apiKeyMode: AdvisoryFenceMode,
    context: TenantContext,
    additionalKeys: readonly string[] = [],
  ): Promise<void> {
    const requests: AdvisoryFenceRequest[] = userIds.map((userId) => ({
      key: saasAdvisoryKey.user(userId),
      mode: 'shared',
    }));
    requests.push(
      ...apiKeyIds.map((apiKeyId) => ({
        key: saasAdvisoryKey.apiKey(context.tenantId, context.projectId, apiKeyId),
        mode: apiKeyMode,
      })),
      ...additionalKeys.map((key) => ({ key, mode: apiKeyMode })),
    );
    await lockAdvisoryFenceLayer(tx, requests);
  }

  private async lockAuthorizationScope(
    tx: SqlExecutor,
    context: TenantContext,
    mode: AdvisoryFenceMode,
    userIds: readonly string[],
    apiKeyIds: readonly string[],
    additionalKeys: readonly string[] = [],
  ): Promise<void> {
    await this.lockAuthorizationIdentity(
      tx,
      context.tenantId,
      context.projectId,
      mode,
      userIds,
      apiKeyIds,
      additionalKeys,
    );
  }

  private async lockAuthorizationIdentity(
    tx: SqlExecutor,
    tenantId: string,
    projectId: string,
    mode: AdvisoryFenceMode,
    userIds: readonly string[],
    apiKeyIds: readonly string[],
    additionalKeys: readonly string[] = [],
  ): Promise<void> {
    const context = { tenantId, projectId } as TenantContext;
    await this.fenceTenantProjectAuthorization(tx, context, mode);
    await this.fenceUserAndApiKeys(tx, userIds, apiKeyIds, mode, context, additionalKeys);
  }

  private async lockApiKeyHint(
    tx: SqlExecutor,
    context: TenantContext,
    keySelect: string,
    keyId: string,
  ): Promise<ApiKeyRow> {
    const result = await this.query<ApiKeyRow>(tx, keySelect, [keyId, context.tenantId, context.projectId]);
    const row = result.rows[0];
    if (!row) fail(404, 'KEY_NOT_FOUND', 'The API key was not found');
    return row;
  }

  private principalUserIds(context: TenantContext, row: ApiKeyRow): string[] {
    const principalKind = storedPrincipalKind(row.execution_principal_type);
    const principalId = storedId(row.execution_principal_id, 'The API key execution principal is invalid');
    if (principalKind === 'project_service' && principalId !== context.projectId) {
      fail(403, 'KEY_ACCESS_DENIED', 'The project-service key is not bound to this project');
    }
    return principalKind === 'member' ? [context.userId, principalId] : [context.userId];
  }

  private async lockActiveProjectPolicy(tx: SqlExecutor, context: TenantContext): Promise<void> {
    const tenantResult = await this.query<Record<string, unknown>>(
      tx,
      `SELECT id, status FROM saas_tenants WHERE id = $1 LIMIT 2`,
      [context.tenantId],
    );
    const tenant = tenantResult.rows[0];
    if (tenantResult.rows.length !== 1 || !tenant || tenant.id !== context.tenantId) {
      fail(403, 'KEY_ACCESS_DENIED', 'The tenant is not available for API key issuance');
    }
    if (tenant.status !== 'active') {
      fail(403, 'KEY_ACCESS_DENIED', 'The tenant is not active');
    }

    const projectResult = await this.query<Record<string, unknown>>(
      tx,
      `SELECT tenant_id, id, inference_policy_version, inference_policy_status
       FROM saas_projects WHERE tenant_id = $1 AND id = $2 LIMIT 2`,
      [context.tenantId, context.projectId],
    );
    const project = projectResult.rows[0];
    if (
      projectResult.rows.length !== 1 ||
      !project ||
      project.tenant_id !== context.tenantId ||
      project.id !== context.projectId
    ) {
      fail(403, 'KEY_ACCESS_DENIED', 'The project is not available for API key issuance');
    }
    const policyVersion = databaseVersion(project.inference_policy_version, 'project policy version');
    if (project.inference_policy_status !== 'active') {
      fail(403, 'KEY_ACCESS_DENIED', 'The project inference policy is not active');
    }

    const policyResult = await this.query<Record<string, unknown>>(
      tx,
      `SELECT tenant_id, project_id, version, status
       FROM saas_project_inference_policy_versions
       WHERE tenant_id = $1 AND project_id = $2 AND version = $3
       LIMIT 2`,
      [context.tenantId, context.projectId, policyVersion],
    );
    const policy = policyResult.rows[0];
    if (
      policyResult.rows.length !== 1 ||
      !policy ||
      policy.tenant_id !== context.tenantId ||
      policy.project_id !== context.projectId ||
      databaseVersion(policy.version, 'policy version') !== policyVersion ||
      policy.status !== 'active'
    ) {
      fail(403, 'KEY_ACCESS_DENIED', 'The project inference policy head is not active');
    }
  }

  private async lockCurrentMembers(
    tx: SqlExecutor,
    context: TenantContext,
    principalIds: readonly string[],
    requireOwnerAdmin: boolean,
  ): Promise<Map<string, { tenantRole: string; projectRole: string }>> {
    const ids = [...new Set(principalIds)].sort();
    if (ids.length === 0 || ids.some((id) => id.trim() === '')) {
      fail(403, 'KEY_ACCESS_DENIED', 'The API key operator is not authorized');
    }
    const users = await this.query<Record<string, unknown>>(
      tx,
      `SELECT id, disabled_at, anonymized_at FROM saas_users
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    if (users.rows.length !== ids.length) {
      fail(403, 'KEY_ACCESS_DENIED', 'The API key operator or member is not active');
    }
    for (const user of users.rows) {
      if (
        typeof user.id !== 'string' ||
        !ids.includes(user.id) ||
        user.disabled_at != null ||
        user.anonymized_at != null
      ) {
        fail(403, 'KEY_ACCESS_DENIED', 'The API key operator or member is not active');
      }
    }

    const tenantMemberships = await this.query<Record<string, unknown>>(
      tx,
      `SELECT tenant_id, user_id, role, status, revoked_at FROM saas_memberships
       WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) ORDER BY user_id`,
      [context.tenantId, ids],
    );
    const projectMemberships = await this.query<Record<string, unknown>>(
      tx,
      `SELECT tenant_id, project_id, user_id, role, status, revoked_at FROM saas_project_memberships
       WHERE tenant_id = $1 AND project_id = $2 AND user_id = ANY($3::uuid[])
       ORDER BY user_id`,
      [context.tenantId, context.projectId, ids],
    );
    const tenantByUser = new Map(tenantMemberships.rows.map((row) => [String(row.user_id), row]));
    const projectByUser = new Map(projectMemberships.rows.map((row) => [String(row.user_id), row]));
    const result = new Map<string, { tenantRole: string; projectRole: string }>();
    for (const id of ids) {
      const tenantMembership = tenantByUser.get(id);
      const projectMembership = projectByUser.get(id);
      if (
        !tenantMembership ||
        !projectMembership ||
        tenantMembership.tenant_id !== context.tenantId ||
        projectMembership.tenant_id !== context.tenantId ||
        projectMembership.project_id !== context.projectId ||
        tenantMembership.status !== 'active' ||
        tenantMembership.revoked_at != null ||
        projectMembership.status !== 'active' ||
        projectMembership.revoked_at != null ||
        !isManagementRole(tenantMembership.role) ||
        !isManagementRole(projectMembership.role)
      ) {
        fail(403, 'KEY_ACCESS_DENIED', 'The current tenant and project membership cannot manage API keys');
      }
      result.set(id, {
        tenantRole: tenantMembership.role as string,
        projectRole: projectMembership.role as string,
      });
    }

    const operator = result.get(context.userId);
    if (
      !operator ||
      (requireOwnerAdmin &&
        (!OWNER_ADMIN_ROLES.has(operator.tenantRole) || !OWNER_ADMIN_ROLES.has(operator.projectRole)))
    ) {
      fail(
        403,
        'KEY_ACCESS_DENIED',
        requireOwnerAdmin
          ? 'Only tenant and project owners or admins may issue project-service keys'
          : 'The current tenant and project roles cannot manage API keys',
      );
    }
    return result;
  }

  private async lockEntitlementAndProfile(
    tx: SqlExecutor,
    context: TenantContext,
    resolution: ReturnType<typeof normalizeResolution>,
    allowSuperseded: boolean,
  ): Promise<Record<string, unknown>> {
    await lockAdvisoryFenceLayer(tx, [
      { key: saasAdvisoryKey.supplyProfile(context.tenantId, resolution.profileId), mode: 'shared' },
    ]);
    const result = await this.query<Record<string, unknown>>(
      tx,
      `SELECT e.id AS entitlement_id, e.tenant_id AS entitlement_tenant_id,
              e.project_id AS entitlement_project_id, e.status AS entitlement_status,
              e.supply_profile_id AS entitlement_profile_id, e.supply_mode AS entitlement_supply_mode,
              e.model_scopes AS entitlement_model_scopes, e.authz_version AS entitlement_authz_version,
              e.effective_at AS entitlement_effective_at, e.expires_at AS entitlement_expires_at,
              e.superseded_at AS entitlement_superseded_at,
              p.id AS profile_id, p.tenant_id AS profile_tenant_id, p.status AS profile_status,
              p.supply_mode AS profile_supply_mode, p.model_scopes AS profile_model_scopes,
              p.authz_version AS profile_authz_version
       FROM saas_project_entitlements e
       JOIN saas_supply_profiles p
         ON p.tenant_id = e.tenant_id AND p.id = e.supply_profile_id AND p.supply_mode = e.supply_mode
       WHERE e.tenant_id = $1 AND e.project_id = $2 AND e.id = $3 AND p.id = $4
       LIMIT 2`,
      [context.tenantId, context.projectId, resolution.entitlementId, resolution.profileId],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      row.entitlement_id !== resolution.entitlementId ||
      row.entitlement_tenant_id !== context.tenantId ||
      row.entitlement_project_id !== context.projectId ||
      row.entitlement_profile_id !== resolution.profileId ||
      row.profile_id !== resolution.profileId ||
      row.profile_tenant_id !== context.tenantId ||
      row.entitlement_supply_mode !== resolution.mode ||
      row.profile_supply_mode !== resolution.mode ||
      row.profile_status !== 'active' ||
      (row.entitlement_status !== 'active' && !(allowSuperseded && row.entitlement_status === 'superseded')) ||
      authzVersion(row.entitlement_authz_version as number | string) !== resolution.entitlementAuthzVersion ||
      authzVersion(row.profile_authz_version as number | string) !== resolution.supplyProfileAuthzVersion ||
      Math.max(
        authzVersion(row.entitlement_authz_version as number | string),
        authzVersion(row.profile_authz_version as number | string),
      ) !== resolution.modelScopeVersion
    ) {
      fail(403, 'KEY_NO_ENTITLEMENT', 'The API key supply entitlement or profile is no longer current');
    }
    const entitlementScopes = storedScopes(row.entitlement_model_scopes);
    const profileScopes = storedScopes(row.profile_model_scopes);
    const profileSet = new Set(profileScopes);
    const allowedModels = entitlementScopes.filter((model) => profileSet.has(model));
    if (
      allowedModels.length !== resolution.allowedModels.size ||
      allowedModels.some((model) => !resolution.allowedModels.has(model))
    ) {
      fail(403, 'KEY_NO_ENTITLEMENT', 'The API key model-scope authority is no longer current');
    }
    return row;
  }

  private async lockCurrentProviderRights(
    tx: SqlExecutor,
    context: TenantContext,
    resolution: ReturnType<typeof normalizeResolution>,
    scopes: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    if (resolution.mode === 'platform') {
      const poolHints = await this.query<Record<string, unknown>>(
        tx,
        `SELECT DISTINCT pool.id AS pool_id
           FROM saas_platform_provider_pool_grants AS grant_row
           JOIN saas_platform_provider_pools AS pool ON pool.id = grant_row.pool_id
          WHERE grant_row.tenant_id = $1
            AND grant_row.supply_profile_id = $2
            AND grant_row.supply_mode = 'platform'
            AND grant_row.status = 'active'
            AND grant_row.profile_authz_version = $3
            AND grant_row.effective_at <= clock_timestamp()
            AND (grant_row.expires_at IS NULL OR grant_row.expires_at > clock_timestamp())
            AND pool.status = 'active'
            AND pool.validation_state = 'verified'`,
        [context.tenantId, resolution.profileId, resolution.supplyProfileAuthzVersion],
      );
      await lockAdvisoryFenceLayer(
        tx,
        poolHints.rows.map((row) => ({
          key: saasAdvisoryKey.platformPool(storedId(row.pool_id, 'The provider pool identifier is invalid')),
          mode: 'shared' as const,
        })),
      );
    }
    const rights: Record<string, unknown>[] = [];
    for (const modelScope of scopes) {
      const result = await this.query<Record<string, unknown>>(
        tx,
        `SELECT rights.rights_id, rights.version, rights.effective_at, rights.expires_at
         FROM saas_route_config_heads h
         JOIN saas_route_config_versions rv
           ON rv.tenant_id = h.tenant_id AND rv.project_id = h.project_id
          AND rv.route_id = h.route_id AND rv.version = h.current_version
         JOIN saas_public_models pm ON pm.alias = $4
         JOIN saas_public_model_versions pmv
           ON pmv.public_model_id = rv.public_model_id AND pmv.version = rv.public_model_version
         JOIN saas_provider_rights rights
           ON rights.provider_id = pmv.provider_id AND rights.product_id = pmv.product_id
         WHERE h.tenant_id = $1 AND h.project_id = $2
           AND h.status = 'active' AND rv.status = 'active' AND rv.supply_mode = $3
           AND rv.public_model_id = pm.id AND pm.status = 'active' AND pmv.status = 'active'
           AND rv.endpoint = ANY(pmv.endpoint_scope)
           AND rights.supply_mode = $3 AND rights.status = 'active'
           AND rights.effective_at <= clock_timestamp()
           AND (rights.expires_at IS NULL OR rights.expires_at > clock_timestamp())
           AND rights.model_scope @> ARRAY[pmv.model]::text[]
           AND rights.endpoint_scope @> ARRAY[rv.endpoint]::text[]
           AND NOT EXISTS (
             SELECT 1 FROM saas_provider_rights newer
             WHERE newer.rights_id = rights.rights_id AND newer.version > rights.version
           )
           AND ($3 <> 'platform' OR EXISTS (
             SELECT 1
             FROM saas_platform_provider_pool_grants g
             JOIN saas_platform_provider_pools pool ON pool.id = g.pool_id
             WHERE g.tenant_id = $1 AND g.supply_profile_id = $5 AND g.supply_mode = 'platform'
               AND g.status = 'active' AND g.profile_authz_version = $6
               AND g.effective_at <= clock_timestamp()
               AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
               AND pool.status = 'active' AND pool.validation_state = 'verified'
               AND pool.authz_version = g.pool_authz_version
               AND pool.rights_id = rights.rights_id AND pool.rights_version = rights.version
           ))
         ORDER BY rights.rights_id, rights.version DESC
         LIMIT 1`,
        [
          context.tenantId,
          context.projectId,
          resolution.mode,
          modelScope,
          resolution.profileId,
          resolution.supplyProfileAuthzVersion,
        ],
      );
      const right = result.rows[0];
      if (!right || result.rows.length !== 1) {
        fail(403, 'KEY_SCOPE_NOT_ALLOWED', `Model scope ${modelScope} has no current provider right and route`);
      }
      rights.push(right);
    }
    return rights;
  }

  private async databaseNow(tx: SqlExecutor): Promise<Date> {
    const result = await this.query<{ now: TimestampValue }>(tx, 'SELECT clock_timestamp() AS now');
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) {
      fail(500, 'KEY_STORAGE_ERROR', 'The key service database clock is unavailable');
    }
    return databaseDate(row.now, 'database clock');
  }

  private assertIssuanceWindows(
    now: Date,
    entitlementAndProfile: Record<string, unknown>,
    rights: readonly Record<string, unknown>[],
    keyExpiry: Date | null,
    allowSuperseded: boolean,
  ): void {
    assertDatabaseWindow(
      entitlementAndProfile.entitlement_effective_at,
      entitlementAndProfile.entitlement_expires_at,
      now,
      'project entitlement',
      allowSuperseded && entitlementAndProfile.entitlement_status === 'superseded'
        ? entitlementAndProfile.entitlement_superseded_at
        : undefined,
    );
    for (const right of rights) {
      assertDatabaseWindow(right.effective_at, right.expires_at, now, 'provider right');
    }
    if (keyExpiry !== null && keyExpiry <= now) {
      fail(403, 'KEY_INVALID_INPUT', 'The API key expiry is no longer in the future');
    }
  }

  async create(context: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    assertContext(context);
    const inputNow = currentDate(this.now);
    const name = normalizeName(input?.name);
    const scopes = normalizeScopes(input?.modelScopes);
    const mode = supplyMode(input?.supplyMode);
    const executionPrincipalType = principalKind(input?.principalKind);
    const expiresAt = normalizeExpiry(input?.expiresAt, inputNow);
    const keyId = randomUUID();
    this.assertResolverAvailable();

    return this.transaction(async (tx) => {
      await this.lockAuthorizationScope(
        tx,
        context,
        'exclusive',
        [context.userId],
        [keyId],
        [PROVIDER_RIGHTS_AUTHORIZATION_FENCE_KEY],
      );
      await this.lockActiveProjectPolicy(tx, context);
      await this.lockCurrentMembers(tx, context, [context.userId], executionPrincipalType === 'project_service');
      const resolution = await this.resolve(context, mode, { executor: tx });
      if (resolution.mode !== mode) {
        fail(503, 'KEY_PROFILE_INVALID', 'The supply profile entitlement does not match the requested mode');
      }
      assertScopesAllowed(scopes, resolution.allowedModels);
      const providerRights = await this.lockCurrentProviderRights(tx, context, resolution, scopes);
      const binding = await this.lockEntitlementAndProfile(tx, context, resolution, false);
      const createdAt = await this.databaseNow(tx);
      this.assertIssuanceWindows(createdAt, binding, providerRights, expiresAt, false);
      const issued = issueSecret();
      const executionPrincipalId = executionPrincipalType === 'member' ? context.userId : context.projectId;
      const principalUserId = executionPrincipalType === 'member' ? context.userId : null;
      const result = await this.query<ApiKeyRow>(
        tx,
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, execution_principal_type,
            execution_principal_id, created_by_user_id, entitlement_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes, status, created_at, expires_at,
            revoked_at, last_used_at, authz_version, model_scope_version,
            entitlement_authz_version, supply_profile_authz_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 'active', $15, $16, NULL, NULL, 1, $17, $18, $19)
         RETURNING id, tenant_id, project_id, principal_user_id, execution_principal_type,
                   execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                   entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                   created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                   entitlement_authz_version, supply_profile_authz_version`,
        [
          keyId,
          context.tenantId,
          context.projectId,
          principalUserId,
          executionPrincipalType,
          executionPrincipalId,
          context.userId,
          resolution.entitlementId,
          resolution.profileId,
          mode,
          name,
          issued.prefix,
          issued.hash,
          scopes,
          createdAt,
          expiresAt,
          resolution.modelScopeVersion,
          resolution.entitlementAuthzVersion,
          resolution.supplyProfileAuthzVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) fail(500, 'KEY_STORAGE_ERROR', 'The API key was not created');
      await this.audit(tx, context, 'api_key.created', keyId, createdAt);
      return { ...metadata(row), secret: issued.secret };
    });
  }

  async list(context: TenantContext): Promise<ApiKeyMetadata[]> {
    /** Project key history is safe metadata only; raw secrets are never queryable. */
    assertContext(context);
    return this.transaction(async (tx) => {
      await this.lockAuthorizationScope(tx, context, 'shared', [context.userId], []);
      const result = await this.query<ApiKeyRow>(
        tx,
        `SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type,
                execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                entitlement_authz_version, supply_profile_authz_version
         FROM saas_api_keys
         WHERE tenant_id = $1 AND project_id = $2
         ORDER BY created_at DESC, id DESC`,
        [context.tenantId, context.projectId],
      );
      return result.rows.map(metadata);
    });
  }

  /** Resolve a raw customer key to its safe metadata and stored authorization snapshot. */
  async authenticate(rawKey: unknown): Promise<AuthenticatedApiKey | null> {
    if (!isCustomerProxyKey(rawKey)) return null;

    try {
      return await this.transaction(async (tx) => {
        const digestValue = secretDigest(rawKey);
        const hintResult = await this.query<ApiKeyRow>(
          tx,
          `SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type,
                  execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                  entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                  created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                  entitlement_authz_version, supply_profile_authz_version
           FROM saas_api_keys
           WHERE key_hash = $1 AND status = 'active'
             AND (expires_at IS NULL OR expires_at > statement_timestamp())
           LIMIT 1`,
          [digestValue],
        );
        const hint = hintResult.rows[0];
        if (!hint) return null;
        const tenantId = storedId(hint.tenant_id, 'The key service returned an invalid tenant identifier');
        const projectId = storedId(hint.project_id, 'The key service returned an invalid project identifier');
        const keyId = storedId(hint.id, 'The key service returned an invalid key identifier');
        const principalKind = storedPrincipalKind(hint.execution_principal_type);
        const principalId = storedId(hint.execution_principal_id, 'The API key execution principal is invalid');
        const userIds = principalKind === 'member' ? [principalId] : [];
        await this.lockAuthorizationIdentity(tx, tenantId, projectId, 'shared', userIds, [keyId]);
        const result = await this.query<ApiKeyRow>(
          tx,
          `SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type,
                  execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                  entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                  created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                  entitlement_authz_version, supply_profile_authz_version
           FROM saas_api_keys
           WHERE id = $1 AND tenant_id = $2 AND project_id = $3 AND key_hash = $4
             AND status = 'active'
             AND (expires_at IS NULL OR expires_at > statement_timestamp())
           LIMIT 1`,
          [keyId, tenantId, projectId, digestValue],
        );
        const row = result.rows[0];
        if (!row) return null;
        const safeMetadata = metadata(row);
        const entitlementId = safeMetadata.entitlementId;
        const entitlementAuthzVersion = safeMetadata.entitlementAuthzVersion;
        const supplyProfileAuthzVersion = safeMetadata.supplyProfileAuthzVersion;
        if (
          safeMetadata.status !== 'active' ||
          entitlementId === null ||
          entitlementAuthzVersion === null ||
          supplyProfileAuthzVersion === null
        ) {
          return null;
        }

        return {
          metadata: safeMetadata,
          authorization: {
            keyId: safeMetadata.id,
            tenantId: safeMetadata.tenantId,
            projectId: safeMetadata.projectId,
            principalKind: safeMetadata.executionPrincipalType,
            principalId: safeMetadata.executionPrincipalId,
            entitlementId,
            supplyProfileId: safeMetadata.supplyProfileId,
            supplyMode: safeMetadata.supplyMode,
            modelScopes: [...safeMetadata.modelScopes],
            authzVersion: safeMetadata.authzVersion,
            modelScopeVersion: safeMetadata.modelScopeVersion,
            entitlementAuthzVersion,
            supplyProfileAuthzVersion,
          },
        };
      });
    } catch {
      fail(500, 'KEY_STORAGE_ERROR', 'The API key service could not complete the request');
    }
  }

  async revoke(context: TenantContext, keyId: string): Promise<ApiKeyMetadata> {
    assertContext(context);
    if (typeof keyId !== 'string' || keyId.trim() === '') {
      fail(400, 'KEY_INVALID_INPUT', 'The API key identifier is invalid');
    }
    const now = currentDate(this.now);
    return this.transaction(async (tx) => {
      await this.fenceTenantProjectAuthorization(tx, context, 'exclusive');
      const keySelect = `SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type,
                                execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                                entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                                created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                                entitlement_authz_version, supply_profile_authz_version
                         FROM saas_api_keys
                         WHERE id = $1 AND tenant_id = $2 AND project_id = $3`;
      const hint = await this.lockApiKeyHint(tx, context, keySelect, keyId);
      const memberIds = this.principalUserIds(context, hint);
      await this.fenceUserAndApiKeys(tx, memberIds, [keyId], 'exclusive', context);
      await this.lockCurrentMembers(tx, context, memberIds, false);
      const selected = await this.query<ApiKeyRow>(tx, `${keySelect} FOR UPDATE`, [
        keyId,
        context.tenantId,
        context.projectId,
      ]);
      const row = selected.rows[0];
      if (!row) fail(404, 'KEY_NOT_FOUND', 'The API key was not found');
      if (row.status === 'revoked') return metadata(row);
      const nextVersion = nextAuthzVersion(row.authz_version);
      const updated = await this.query<ApiKeyRow>(
        tx,
        `UPDATE saas_api_keys
         SET status = 'revoked', revoked_at = $4, authz_version = $5, revoked_by_user_id = $6
         WHERE id = $1 AND tenant_id = $2 AND project_id = $3 AND status = 'active'
         RETURNING id, tenant_id, project_id, principal_user_id, execution_principal_type,
                   execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                   entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                   created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                   entitlement_authz_version, supply_profile_authz_version`,
        [keyId, context.tenantId, context.projectId, now, nextVersion, context.userId],
      );
      const revoked = updated.rows[0];
      if (!revoked) fail(404, 'KEY_NOT_FOUND', 'The API key was not found');
      await this.audit(tx, context, 'api_key.revoked', keyId, now);
      return metadata(revoked);
    });
  }

  async rotate(context: TenantContext, keyId: string): Promise<CreatedApiKey> {
    assertContext(context);
    if (typeof keyId !== 'string' || keyId.trim() === '') {
      fail(400, 'KEY_INVALID_INPUT', 'The API key identifier is invalid');
    }
    currentDate(this.now);
    const replacementId = randomUUID();

    return this.transaction(async (tx) => {
      await this.fenceTenantProjectAuthorization(tx, context, 'exclusive');
      const keySelect = `SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type,
                                execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                                entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                                created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                                entitlement_authz_version, supply_profile_authz_version
                         FROM saas_api_keys
                         WHERE id = $1 AND tenant_id = $2 AND project_id = $3`;
      const hint = await this.lockApiKeyHint(tx, context, keySelect, keyId);
      const memberIds = this.principalUserIds(context, hint);
      await this.fenceUserAndApiKeys(tx, memberIds, [keyId, replacementId], 'exclusive', context, [
        PROVIDER_RIGHTS_AUTHORIZATION_FENCE_KEY,
      ]);
      await this.lockActiveProjectPolicy(tx, context);
      const principalKind = storedPrincipalKind(hint.execution_principal_type);
      const principalId = storedId(hint.execution_principal_id, 'The API key execution principal is invalid');
      const members = await this.lockCurrentMembers(tx, context, memberIds, principalKind === 'project_service');
      if (principalKind === 'member' && !members.has(principalId)) {
        fail(403, 'KEY_ACCESS_DENIED', 'The member-bound key execution member is no longer active');
      }

      const selected = await this.query<ApiKeyRow>(tx, `${keySelect} FOR UPDATE`, [
        keyId,
        context.tenantId,
        context.projectId,
      ]);
      const row = selected.rows[0];
      if (!row) fail(404, 'KEY_NOT_FOUND', 'The API key was not found');
      if (
        row.execution_principal_type !== hint.execution_principal_type ||
        row.execution_principal_id !== hint.execution_principal_id ||
        row.principal_user_id !== hint.principal_user_id ||
        row.entitlement_id !== hint.entitlement_id ||
        row.supply_profile_id !== hint.supply_profile_id ||
        row.supply_mode !== hint.supply_mode ||
        row.model_scope_version !== hint.model_scope_version ||
        row.entitlement_authz_version !== hint.entitlement_authz_version ||
        row.supply_profile_authz_version !== hint.supply_profile_authz_version
      ) {
        fail(409, 'KEY_NO_ENTITLEMENT', 'The API key binding changed during rotation');
      }
      if (row.status === 'revoked') fail(409, 'KEY_ALREADY_REVOKED', 'The API key is already revoked');
      if (!row.entitlement_id) {
        fail(403, 'KEY_NO_ENTITLEMENT', 'The API key supply entitlement is no longer available');
      }
      const resolution = await this.resolve(context, row.supply_mode, {
        executor: tx,
        entitlementId: row.entitlement_id,
      });
      if (
        resolution.entitlementId !== row.entitlement_id ||
        resolution.profileId !== row.supply_profile_id ||
        resolution.mode !== row.supply_mode
      ) {
        fail(403, 'KEY_NO_ENTITLEMENT', 'The API key supply entitlement is no longer available');
      }
      if (
        row.entitlement_authz_version === null ||
        row.supply_profile_authz_version === null ||
        authzSnapshotVersion(row.entitlement_authz_version) !== resolution.entitlementAuthzVersion ||
        authzSnapshotVersion(row.supply_profile_authz_version) !== resolution.supplyProfileAuthzVersion ||
        authzVersion(row.model_scope_version) !== resolution.modelScopeVersion
      ) {
        fail(403, 'KEY_NO_ENTITLEMENT', 'The API key authorization binding is no longer available');
      }
      const storedKeyMetadata = metadata(row);
      const scopes = [...storedKeyMetadata.modelScopes];
      assertScopesAllowed(scopes, resolution.allowedModels);
      const providerRights = await this.lockCurrentProviderRights(tx, context, resolution, scopes);
      const binding = await this.lockEntitlementAndProfile(tx, context, resolution, true);
      const keyExpiresAt = row.expires_at === null ? null : databaseDate(row.expires_at, 'API key expires_at');
      const now = await this.databaseNow(tx);
      this.assertIssuanceWindows(now, binding, providerRights, keyExpiresAt, true);

      const issued = issueSecret();
      const nextVersion = nextAuthzVersion(row.authz_version);
      const revoked = await this.query<ApiKeyRow>(
        tx,
        `UPDATE saas_api_keys
         SET status = 'revoked', revoked_at = $4, authz_version = $5,
             rotated_by_user_id = $6, revoked_by_user_id = $6
         WHERE id = $1 AND tenant_id = $2 AND project_id = $3 AND status = 'active'
         RETURNING id, tenant_id, project_id, principal_user_id, execution_principal_type,
                   execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                   entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                   created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                   entitlement_authz_version, supply_profile_authz_version`,
        [keyId, context.tenantId, context.projectId, now, nextVersion, context.userId],
      );
      if (!revoked.rows[0]) fail(409, 'KEY_ALREADY_REVOKED', 'The API key is already revoked');

      const created = await this.query<ApiKeyRow>(
        tx,
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, execution_principal_type,
            execution_principal_id, created_by_user_id, entitlement_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes, status, created_at, expires_at,
            revoked_at, last_used_at, authz_version, model_scope_version,
            entitlement_authz_version, supply_profile_authz_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 'active', $15, $16, NULL, NULL, $17, $18, $19, $20)
         RETURNING id, tenant_id, project_id, principal_user_id, execution_principal_type,
                   execution_principal_id, created_by_user_id, rotated_by_user_id, revoked_by_user_id,
                   entitlement_id, supply_profile_id, supply_mode, name, prefix, model_scopes, status,
                   created_at, expires_at, revoked_at, last_used_at, authz_version, model_scope_version,
                   entitlement_authz_version, supply_profile_authz_version`,
        [
          replacementId,
          context.tenantId,
          context.projectId,
          row.principal_user_id,
          row.execution_principal_type,
          row.execution_principal_id,
          context.userId,
          row.entitlement_id,
          row.supply_profile_id,
          row.supply_mode,
          row.name,
          issued.prefix,
          issued.hash,
          scopes,
          now,
          row.expires_at,
          nextVersion,
          resolution.modelScopeVersion,
          resolution.entitlementAuthzVersion,
          resolution.supplyProfileAuthzVersion,
        ],
      );
      const replacement = created.rows[0];
      if (!replacement) fail(500, 'KEY_STORAGE_ERROR', 'The API key was not rotated');
      await this.audit(tx, context, 'api_key.rotated', keyId, now);
      await this.audit(tx, context, 'api_key.created', replacementId, now);
      return { ...metadata(replacement), secret: issued.secret };
    });
  }

  createApiKey(context: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    return this.create(context, input);
  }

  listApiKeys(context: TenantContext): Promise<ApiKeyMetadata[]> {
    return this.list(context);
  }

  rotateApiKey(context: TenantContext, keyId: string): Promise<CreatedApiKey> {
    return this.rotate(context, keyId);
  }

  revokeApiKey(context: TenantContext, keyId: string): Promise<ApiKeyMetadata> {
    return this.revoke(context, keyId);
  }
}

export { KeyService as SaasKeyService };
