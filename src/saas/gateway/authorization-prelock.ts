import { saasAdvisoryKey } from '../db/advisory-lock-keys.js';
import type { SqlExecutor, SqlResult } from '../db/types.js';
import type { ApiKeyAuthorizationSnapshot, ApiKeyPrincipalKind, AuthenticatedApiKey } from '../keys/types.js';
import type { CreateRequestInput } from '../metering/types.js';

/**
 * Only the server-authenticated authorization snapshot crosses into admission.
 * It deliberately excludes both the raw key and its digest.
 */
export type SaasRequestAdmissionAuthenticatedKey = Pick<AuthenticatedApiKey, 'authorization'>;

export interface SaasRequestAdmissionAuthorizationPrelockInput {
  readonly executor: SqlExecutor;
  readonly request: CreateRequestInput;
  readonly authenticatedKey: SaasRequestAdmissionAuthenticatedKey;
}

/**
 * The prelock is the first operation inside the admission transaction. It
 * must not acquire a database handle of its own or perform non-database I/O.
 */
export interface SaasRequestAdmissionAuthorizationPrelock {
  prelock(input: SaasRequestAdmissionAuthorizationPrelockInput): Promise<void>;
}

export type SaasAdmissionAuthorizationErrorCode =
  | 'authorization_denied'
  | 'storage_failure'
  | 'project_policy_unsupported';

/** A safe, fail-closed error for admission authorization failures. */
export class SaasAdmissionAuthorizationError extends Error {
  constructor(
    readonly code: SaasAdmissionAuthorizationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaasAdmissionAuthorizationError';
  }
}

type Row = Record<string, unknown>;

const INFERENCE_PROJECT_ROLES = new Set(['owner', 'admin', 'developer']);
const MEMBERSHIP_ROLES = new Set(['owner', 'admin', 'developer', 'billing', 'viewer']);
const PRINCIPAL_KINDS = new Set<ApiKeyPrincipalKind>(['member', 'project_service']);

function deny(message: string, code: SaasAdmissionAuthorizationErrorCode = 'authorization_denied'): never {
  throw new SaasAdmissionAuthorizationError(code, message);
}

function storageFailure(cause: unknown): never {
  throw new SaasAdmissionAuthorizationError(
    'storage_failure',
    'SaaS admission authorization could not be revalidated',
    { cause },
  );
}

function requireRecord(value: unknown, label: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    deny(`SaaS admission authorization ${label} is invalid`);
  }
  return value as Row;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    deny(`SaaS admission authorization ${label} is invalid`);
  }
  return value;
}

function requireVersion(value: unknown, label: string): string {
  if (typeof value === 'bigint' && value >= 1n) return value.toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return String(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const version = BigInt(value.trim());
    if (version >= 1n) return version.toString(10);
  }
  deny(`SaaS admission authorization ${label} is invalid`);
}

function sameText(expected: unknown, actual: unknown, label: string): void {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected !== actual) {
    deny(`SaaS admission authorization mismatch: ${label}`);
  }
}

function sameVersion(expected: unknown, actual: unknown, label: string): void {
  if (requireVersion(expected, label) !== requireVersion(actual, label)) {
    deny(`SaaS admission authorization mismatch: ${label}`);
  }
}

function normalizedScopes(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    deny(`SaaS admission authorization ${label} is invalid`);
  }
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || scope.trim() === '' || scope !== scope.trim()) {
      deny(`SaaS admission authorization ${label} is invalid`);
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) {
    deny(`SaaS admission authorization ${label} is invalid`);
  }
  return scopes;
}

function sameScopes(expected: readonly string[], actual: unknown, label: string): void {
  const actualScopes = normalizedScopes(actual, label);
  if (expected.length !== actualScopes.length || expected.some((scope, index) => scope !== actualScopes[index])) {
    deny(`SaaS admission authorization mismatch: ${label}`);
  }
}

function timestampMillis(value: unknown, label: string): number {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    deny(`SaaS admission authorization ${label} is invalid`);
  }
  return date.getTime();
}

function nullableTimestampMillis(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (value === undefined) deny(`SaaS admission authorization ${label} is invalid`);
  return timestampMillis(value, label);
}

function exactlyOne<RowType>(result: SqlResult<RowType>, label: string): RowType {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 || !result.rows[0]) {
    deny(`SaaS admission authorization ${label} is missing or ambiguous`);
  }
  return result.rows[0];
}

/** The jsonb_agg counterpart of exactlyOne: null is missing, two elements are ambiguous. */
function jsonbOne(value: unknown, label: string): Row {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'object' || value[0] === null) {
    deny(`SaaS admission authorization ${label} is missing or ambiguous`);
  }
  return value[0] as Row;
}

/**
 * The advisory fence keys must equal migration 046/047's trigger derivation
 * ('<prefix>' || id::uuid::text). PostgreSQL's uuid cast renders the
 * canonical lowercase form, so invalid or non-canonical ids are rejected the
 * same way the previous statement-level uuid cast errored (storage failure).
 */
function canonicalUuid(value: string): string {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
    ? value.toLowerCase()
    : value;
}

function assertMembership(row: Row, tenantId: string, projectId: string | null, userId: string, label: string): void {
  sameText(row.tenant_id, tenantId, `${label}.tenant_id`);
  if (projectId !== null) sameText(row.project_id, projectId, `${label}.project_id`);
  sameText(row.user_id, userId, `${label}.user_id`);
  if (row.status !== 'active' || row.revoked_at !== null) {
    deny(`SaaS admission authorization ${label} is not active`);
  }
  if (typeof row.role !== 'string' || !MEMBERSHIP_ROLES.has(row.role)) {
    deny(`SaaS admission authorization ${label}.role is invalid`);
  }
}

interface LockedKey {
  readonly row: Row;
  readonly scopes: string[];
}

/** The merged authority-fact read result: the locked key row and the database clock. */
interface AuthorityFacts {
  readonly key: LockedKey;
  readonly now: unknown;
}

/**
 * PostgreSQL implementation of the admission authorization prelock.
 *
 * Mutable tenant/project/user/membership authority is protected by the
 * transaction-scoped advisory fences installed by migrations 046/047/050. The
 * fence acquisition is one batched statement (an unnest over the ordered key
 * list); locks are taken in row order, so the acquisition order is exactly
 * tenant -> project -> user -> API key, identical to the previous one-statement-
 * per-fence form. Reads never tuple-lock the SELECT-only facts: they run as one
 * merged statement AFTER the fence statement completes, so every fact is read
 * from a READ COMMITTED snapshot taken after the last fence wait (a snapshot
 * taken before a blocked fence could retain pre-revocation facts — that is why
 * the fence statement and the read statement must stay separate). The immutable
 * policy version is plain-read behind the project fence. The API key is also
 * plain-read after the matching shared fence: 050 fences every
 * INSERT/UPDATE/DELETE using both old and new identities, and KeyService takes
 * that exclusive fence before target row locks. This requires READ COMMITTED
 * and holds every fence until transaction end. This order precedes
 * metering/idempotency so replay visibility cannot bypass the current project
 * and key authorization.
 */
export class PostgresSaasRequestAdmissionAuthorizationPrelock implements SaasRequestAdmissionAuthorizationPrelock {
  async prelock(input: SaasRequestAdmissionAuthorizationPrelockInput): Promise<void> {
    try {
      const request = requireRecord(input?.request, 'request') as unknown as CreateRequestInput;
      const authenticatedKey = requireRecord(input?.authenticatedKey, 'authenticatedKey');
      const authorization = requireRecord(
        authenticatedKey.authorization,
        'authenticatedKey.authorization',
      ) as unknown as ApiKeyAuthorizationSnapshot;

      this.assertSnapshotMatchesRequest(request, authorization);

      const executor = input?.executor;
      if (!executor || typeof executor.query !== 'function') {
        deny('SaaS admission authorization transaction executor is required');
      }

      // Explicit order: tenant -> project -> (user) -> API key. The batched
      // fence statement acquires the shared locks in array order. Tenant,
      // project, and user keys must match migration 046/047's trigger key
      // derivation ('<prefix>' || id::uuid::text), so they are canonicalized
      // to the lowercase UUID form PostgreSQL's uuid cast produces; an invalid
      // UUID fails exactly like the previous statement's uuid cast did.
      const fenceKeys = [
        `saas-authz:tenant:${canonicalUuid(request.tenantId)}`,
        `saas-authz:project:${canonicalUuid(request.tenantId)}:${canonicalUuid(request.projectId)}`,
        ...(authorization.principalKind === 'member' ? [canonicalUuid(authorization.principalId)] : []),
        saasAdvisoryKey.apiKey(request.tenantId, request.projectId, authorization.keyId),
      ];
      await this.query<Row>(
        executor,
        'SELECT pg_advisory_xact_lock_shared(hashtextextended(fence_key, 0)) FROM unnest($1::text[]) AS fence_key',
        [fenceKeys],
      );

      const facts = await this.readAuthorityFacts(executor, request, authorization);

      // This is deliberately after the key advisory-fence wait and fresh read. Do not use
      // statement_timestamp(), whose value may predate that wait.
      const now = timestampMillis(facts.now, 'database clock');
      this.assertCurrentKey(facts.key, request, now);

      // Entitlement/profile validity, including effective/expiry windows and
      // an already-bound superseded entitlement, remains the later guard's
      // responsibility after metering; this prelock never resolves a
      // replacement or acquires those post-request-domain locks.
    } catch (error) {
      if (error instanceof SaasAdmissionAuthorizationError) throw error;
      storageFailure(error);
    }
  }

  private assertSnapshotMatchesRequest(request: CreateRequestInput, authorization: ApiKeyAuthorizationSnapshot): void {
    sameText(request.tenantId, authorization.tenantId, 'tenantId');
    sameText(request.projectId, authorization.projectId, 'projectId');
    requireVersion(request.projectPolicyVersion, 'projectPolicyVersion');
    sameText(request.proxyKeyId, authorization.keyId, 'proxyKeyId/keyId');
    sameText(request.entitlementId, authorization.entitlementId, 'entitlementId');
    sameText(request.supplyProfileId, authorization.supplyProfileId, 'supplyProfileId');
    sameText(request.supplyMode, authorization.supplyMode, 'supplyMode');
    sameText(request.principalKind, authorization.principalKind, 'principalKind');
    sameText(request.principalId, authorization.principalId, 'principalId');
    sameVersion(request.authzVersion, authorization.authzVersion, 'authzVersion');
    sameVersion(request.entitlementVersion, authorization.entitlementAuthzVersion, 'entitlementVersion');
    sameVersion(request.supplyProfileVersion, authorization.supplyProfileAuthzVersion, 'supplyProfileVersion');
    sameVersion(request.modelScopeVersion, authorization.modelScopeVersion, 'modelScopeVersion');
    if (!PRINCIPAL_KINDS.has(authorization.principalKind)) {
      deny('SaaS admission authorization principal kind is invalid');
    }
    if (authorization.principalKind === 'project_service' && authorization.principalId !== request.projectId) {
      deny('SaaS project-service principal is not bound to its project');
    }
    const scopes = normalizedScopes(authorization.modelScopes, 'modelScopes');
    const publicModel = requireText(request.publicModel, 'publicModel');
    if (!scopes.includes(publicModel)) {
      deny('SaaS admission authorization does not include the requested model scope');
    }
  }

  private async query<RowType>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[],
  ): Promise<SqlResult<RowType>> {
    try {
      const result = await executor.query<RowType>(sql, values);
      if (!result || !Array.isArray(result.rows)) {
        deny('SaaS admission authorization returned an invalid database result');
      }
      return result;
    } catch (error) {
      if (error instanceof SaasAdmissionAuthorizationError) throw error;
      storageFailure(error);
    }
  }

  /**
   * One merged READ COMMITTED statement reads every authority fact after the
   * fence statement has completed. Each fact is aggregated with jsonb_agg over
   * the same `LIMIT 2` shape the per-table statements used, so the missing (0
   * rows) / exactly-one / ambiguous (>1 row) distinction is preserved verbatim.
   * For a project-service principal the user/membership facts are fetched but
   * never validated (the previous form did not read them at all); the
   * validation below runs in the original order tenant -> project -> policy ->
   * user -> memberships -> API key, so every denial is identical.
   */
  private async readAuthorityFacts(
    executor: SqlExecutor,
    request: CreateRequestInput,
    authorization: ApiKeyAuthorizationSnapshot,
  ): Promise<AuthorityFacts> {
    const requestedVersion = requireVersion(request.projectPolicyVersion, 'projectPolicyVersion');
    // For a project-service principal the user/membership facts are read but
    // never validated (the previous form did not read them at all); the
    // principal id equals the project id in that case.
    const principalId = authorization.principalId;
    const member = authorization.principalKind === 'member';
    const result = await this.query<Row>(
      executor,
      `SELECT
         (SELECT jsonb_agg(t) FROM (
            SELECT id, status FROM saas_tenants WHERE id = $1 LIMIT 2
          ) t) AS tenant,
         (SELECT jsonb_agg(p) FROM (
            SELECT tenant_id, id, inference_policy_version, inference_policy_status
              FROM saas_projects WHERE tenant_id = $1 AND id = $2 LIMIT 2
          ) p) AS project,
         (SELECT jsonb_agg(v) FROM (
            SELECT tenant_id, project_id, version, status
              FROM saas_project_inference_policy_versions
             WHERE tenant_id = $1 AND project_id = $2 AND version = $3 LIMIT 2
          ) v) AS policy,
         (SELECT jsonb_agg(u) FROM (
            SELECT id, disabled_at, anonymized_at FROM saas_users WHERE id = $4 LIMIT 2
          ) u) AS principal_user,
         (SELECT jsonb_agg(m) FROM (
            SELECT tenant_id, user_id, role, status, revoked_at
              FROM saas_memberships WHERE tenant_id = $1 AND user_id = $4 LIMIT 2
          ) m) AS tenant_membership,
         (SELECT jsonb_agg(m) FROM (
            SELECT tenant_id, project_id, user_id, role, status, revoked_at
              FROM saas_project_memberships
             WHERE tenant_id = $1 AND project_id = $2 AND user_id = $4 LIMIT 2
          ) m) AS project_membership,
         (SELECT jsonb_agg(k) FROM (
            SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type,
                   execution_principal_id, entitlement_id, supply_profile_id, supply_mode,
                   model_scopes, status, revoked_at, expires_at, authz_version, model_scope_version,
                   entitlement_authz_version, supply_profile_authz_version
              FROM saas_api_keys
             WHERE tenant_id = $1 AND project_id = $2 AND id = $5 LIMIT 2
          ) k) AS api_key,
         clock_timestamp() AS now`,
      [request.tenantId, request.projectId, requestedVersion, principalId, authorization.keyId],
    );
    const facts = exactlyOne(result, 'authority bundle');
    const tenant = jsonbOne(facts.tenant, 'tenant');
    sameText(tenant.id, request.tenantId, 'tenant.id');
    if (tenant.status !== 'active') deny('SaaS tenant is not active');

    const project = jsonbOne(facts.project, 'project');
    sameText(project.tenant_id, request.tenantId, 'project.tenant_id');
    sameText(project.id, request.projectId, 'project.id');
    sameVersion(project.inference_policy_version, requestedVersion, 'project.inference_policy_version');
    if (project.inference_policy_status !== 'active') deny('SaaS project inference policy is not active');

    const policy = jsonbOne(facts.policy, 'project inference policy');
    sameText(policy.tenant_id, request.tenantId, 'project inference policy.tenant_id');
    sameText(policy.project_id, request.projectId, 'project inference policy.project_id');
    sameVersion(policy.version, requestedVersion, 'project inference policy.version');
    if (policy.status !== 'active') deny('SaaS project inference policy is not active');

    if (member) {
      const user = jsonbOne(facts.principal_user, 'principal');
      sameText(user.id, principalId, 'principal.id');
      if (user.disabled_at !== null) deny('SaaS principal user is disabled');
      if (user.anonymized_at !== null) deny('SaaS principal user is anonymized');

      const tenantMembership = jsonbOne(facts.tenant_membership, 'tenant membership');
      assertMembership(tenantMembership, request.tenantId, null, principalId, 'tenant membership');
      if (typeof tenantMembership.role !== 'string' || !INFERENCE_PROJECT_ROLES.has(tenantMembership.role)) {
        deny('SaaS tenant membership role cannot perform inference');
      }

      const projectMembership = jsonbOne(facts.project_membership, 'project membership');
      assertMembership(projectMembership, request.tenantId, request.projectId, principalId, 'project membership');
      if (typeof projectMembership.role !== 'string' || !INFERENCE_PROJECT_ROLES.has(projectMembership.role)) {
        deny('SaaS project membership role cannot perform inference');
      }
    }

    const key = this.validateApiKeyRow(jsonbOne(facts.api_key, 'API key'), request, authorization);
    return { key: { row: key, scopes: key.model_scopes as string[] }, now: facts.now };
  }

  private validateApiKeyRow(row: Row, request: CreateRequestInput, authorization: ApiKeyAuthorizationSnapshot): Row {
    sameText(row.id, authorization.keyId, 'key.id');
    sameText(row.tenant_id, authorization.tenantId, 'key.tenant_id');
    sameText(row.project_id, authorization.projectId, 'key.project_id');
    sameText(row.execution_principal_type, authorization.principalKind, 'key.principal_kind');
    sameText(row.execution_principal_id, authorization.principalId, 'key.principal_id');
    if (authorization.principalKind === 'member') {
      sameText(row.principal_user_id, authorization.principalId, 'key.principal_user_id');
    } else if (row.principal_user_id !== null || authorization.principalId !== request.projectId) {
      deny('SaaS project-service API key principal shape is invalid');
    }
    sameText(row.entitlement_id, authorization.entitlementId, 'key.entitlement_id');
    sameText(row.supply_profile_id, authorization.supplyProfileId, 'key.supply_profile_id');
    sameText(row.supply_mode, authorization.supplyMode, 'key.supply_mode');
    if (row.status !== 'active' || row.revoked_at !== null) deny('SaaS API key is not active');
    const scopes = normalizedScopes(row.model_scopes, 'persisted key model_scopes');
    sameScopes(authorization.modelScopes, scopes, 'model_scopes');
    sameVersion(row.authz_version, authorization.authzVersion, 'key.authz_version');
    sameVersion(row.model_scope_version, authorization.modelScopeVersion, 'key.model_scope_version');
    sameVersion(row.entitlement_authz_version, authorization.entitlementAuthzVersion, 'key.entitlement_authz_version');
    sameVersion(
      row.supply_profile_authz_version,
      authorization.supplyProfileAuthzVersion,
      'key.supply_profile_authz_version',
    );
    return { ...row, model_scopes: scopes };
  }

  private assertCurrentKey(key: LockedKey, request: CreateRequestInput, now: number): void {
    const keyExpiresAt = nullableTimestampMillis(key.row.expires_at, 'key.expires_at');
    if (keyExpiresAt !== null && keyExpiresAt <= now) deny('SaaS API key is expired');
    if (!key.scopes.includes(request.publicModel)) {
      deny('SaaS API key does not authorize the requested model');
    }
  }
}

export { PostgresSaasRequestAdmissionAuthorizationPrelock as SaasRequestAdmissionAuthorizationPrelockService };
