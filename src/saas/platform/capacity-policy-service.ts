import { randomUUID } from 'node:crypto';
import { saasAdvisoryKey, sortAndDedupeAdvisoryKeys } from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../db/types.js';
import { hasPlatformRole } from './access/authorization.js';
import { isPlatformAdminRole, type PlatformAdminActor, type PlatformAdminRole } from './access/types.js';

export const CAPACITY_POLICY_REASONS = Object.freeze([
  'initial_provisioning',
  'customer_request',
  'capacity_adjustment',
  'incident_response',
  'risk_control',
  'data_correction',
] as const);

export type CapacityPolicyReason = (typeof CAPACITY_POLICY_REASONS)[number];
export type CapacityPolicyScope = 'tenant' | 'project' | 'api_key';
export type CapacityPolicyRevisionInput = string | number | bigint;

export interface CapacityPolicyLimits {
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly maxConcurrentRequests: number;
}

interface CapacityPolicyRecordBase {
  readonly scope: CapacityPolicyScope;
  readonly tenantId: string;
  /** Decimal string to preserve PostgreSQL bigint revisions without coercion. */
  readonly revision: string;
  readonly revisionKind: 'tenant_capacity_policy' | 'project_inference_policy' | 'api_key_authz';
  /** Null means all three limits remain intentionally unconfigured (deny-by-default). */
  readonly limits: CapacityPolicyLimits | null;
  readonly configured: boolean;
}

export type CapacityPolicyRecord =
  | (CapacityPolicyRecordBase & { readonly scope: 'tenant' })
  | (CapacityPolicyRecordBase & { readonly scope: 'project'; readonly projectId: string })
  | (CapacityPolicyRecordBase & {
      readonly scope: 'api_key';
      readonly projectId: string;
      readonly apiKeyId: string;
    });

export interface GetTenantCapacityPolicyInput {
  readonly tenantId: string;
  readonly actor: PlatformAdminActor;
}

export interface GetProjectCapacityPolicyInput extends GetTenantCapacityPolicyInput {
  readonly projectId: string;
}

export interface GetApiKeyCapacityPolicyInput extends GetProjectCapacityPolicyInput {
  readonly apiKeyId: string;
}

interface SetCapacityPolicyBase {
  readonly expectedRevision: CapacityPolicyRevisionInput;
  readonly limits: CapacityPolicyLimits;
  readonly reason: CapacityPolicyReason;
  /** Server-generated UUID correlation ID; arbitrary header text is not accepted. */
  readonly requestId: string;
  readonly actor: PlatformAdminActor;
}

export interface SetTenantCapacityPolicyInput extends SetCapacityPolicyBase {
  readonly tenantId: string;
}

export interface SetProjectCapacityPolicyInput extends SetCapacityPolicyBase {
  readonly tenantId: string;
  readonly projectId: string;
}

export interface SetApiKeyCapacityPolicyInput extends SetCapacityPolicyBase {
  readonly tenantId: string;
  readonly projectId: string;
  readonly apiKeyId: string;
}

export type CapacityPolicyErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CAS_CONFLICT'
  | 'NO_CHANGE'
  | 'INVALID_POLICY'
  | 'AMBIGUOUS'
  | 'STORAGE_ERROR';

export class CapacityPolicyError extends Error {
  constructor(
    readonly code: CapacityPolicyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CapacityPolicyError';
  }
}

interface TenantCapacityRow {
  readonly id: unknown;
  readonly capacity_policy_revision: unknown;
  readonly requests_per_minute: unknown;
  readonly tokens_per_minute: unknown;
  readonly max_concurrent_requests: unknown;
}

interface ProjectHeadRow {
  readonly tenant_id: unknown;
  readonly id: unknown;
  readonly inference_policy_version: unknown;
  readonly inference_policy_status: unknown;
}

interface ProjectPolicyRow {
  readonly tenant_id: unknown;
  readonly project_id: unknown;
  readonly version: unknown;
  readonly latest_version: unknown;
  readonly status: unknown;
  readonly requests_per_minute: unknown;
  readonly tokens_per_minute: unknown;
  readonly max_concurrent_requests: unknown;
}

interface ApiKeyCapacityRow {
  readonly tenant_id: unknown;
  readonly project_id: unknown;
  readonly id: unknown;
  readonly authz_version: unknown;
  readonly requests_per_minute: unknown;
  readonly tokens_per_minute: unknown;
  readonly max_concurrent_requests: unknown;
}

interface SessionRow {
  readonly id: unknown;
  readonly user_id: unknown;
}

interface RoleRow {
  readonly role: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_LENGTH = 36;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_CONCURRENCY = 2_147_483_647;
const CAPACITY_KEYS = new Set(['requestsPerMinute', 'tokensPerMinute', 'maxConcurrentRequests']);
const WRITE_KEYS = new Set([
  'tenantId',
  'projectId',
  'apiKeyId',
  'expectedRevision',
  'limits',
  'reason',
  'requestId',
  'actor',
]);
const PLATFORM_READ_ROLES = Object.freeze(['operations', 'support-readonly'] as const);
const PLATFORM_WRITE_ROLES = Object.freeze(['operations'] as const);
const SHARED_ADVISORY_FENCE_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))';
const EXCLUSIVE_ADVISORY_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';

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

function fail(code: CapacityPolicyErrorCode, message: string, cause?: unknown): never {
  throw new CapacityPolicyError(code, message, cause === undefined ? undefined : { cause });
}

function objectInput(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', 'Capacity policy input must be an object');
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) fail('INVALID_INPUT', 'Capacity policy input is invalid');
  }
  return candidate;
}

function requireKeys(candidate: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) {
    fail('INVALID_INPUT', 'Capacity policy input is incomplete');
  }
}

function inputUuid(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length !== UUID_LENGTH ||
    !UUID_PATTERN.test(value) ||
    value.trim() !== value
  ) {
    fail('INVALID_INPUT', `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function inputRevision(value: unknown): string {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) parsed = BigInt(value);
  else fail('INVALID_INPUT', 'expectedRevision must be a positive integer');
  if (parsed < 1n || parsed > MAX_POSTGRES_BIGINT) {
    fail('INVALID_INPUT', 'expectedRevision must be a positive integer');
  }
  return parsed.toString(10);
}

function dbRevision(value: unknown, label: string): string {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) parsed = BigInt(value);
  else fail('STORAGE_ERROR', `${label} is malformed`);
  if (parsed < 1n || parsed > MAX_POSTGRES_BIGINT) fail('STORAGE_ERROR', `${label} is malformed`);
  return parsed.toString(10);
}

function nextRevision(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > MAX_POSTGRES_BIGINT) fail('INVALID_POLICY', 'Capacity policy revision is exhausted');
  return next.toString(10);
}

function inputLimits(value: unknown): CapacityPolicyLimits {
  const candidate = objectInput(value, CAPACITY_KEYS);
  requireKeys(candidate, CAPACITY_KEYS);
  const requestsPerMinute = candidate.requestsPerMinute;
  const tokensPerMinute = candidate.tokensPerMinute;
  const maxConcurrentRequests = candidate.maxConcurrentRequests;
  if (
    typeof requestsPerMinute !== 'number' ||
    !Number.isSafeInteger(requestsPerMinute) ||
    requestsPerMinute < 1 ||
    requestsPerMinute > Number.MAX_SAFE_INTEGER ||
    typeof tokensPerMinute !== 'number' ||
    !Number.isSafeInteger(tokensPerMinute) ||
    tokensPerMinute < 1 ||
    tokensPerMinute > Number.MAX_SAFE_INTEGER ||
    typeof maxConcurrentRequests !== 'number' ||
    !Number.isSafeInteger(maxConcurrentRequests) ||
    maxConcurrentRequests < 1 ||
    maxConcurrentRequests > MAX_CONCURRENCY
  ) {
    fail('INVALID_INPUT', 'All capacity limits must be positive safe integers');
  }
  return { requestsPerMinute, tokensPerMinute, maxConcurrentRequests };
}

function dbLimit(value: unknown, label: string, maximum: bigint): number {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) parsed = BigInt(value);
  else fail('STORAGE_ERROR', `${label} is malformed`);
  if (parsed < 1n || parsed > maximum) fail('STORAGE_ERROR', `${label} is malformed`);
  return Number(parsed);
}

function snapshot(row: {
  readonly requests_per_minute: unknown;
  readonly tokens_per_minute: unknown;
  readonly max_concurrent_requests: unknown;
}): CapacityPolicyLimits | null {
  const values = [row.requests_per_minute, row.tokens_per_minute, row.max_concurrent_requests];
  if (values.some((value) => value === undefined)) fail('STORAGE_ERROR', 'Capacity policy snapshot is malformed');
  const nulls = values.filter((value) => value === null).length;
  if (nulls === values.length) return null;
  if (nulls !== 0) fail('INVALID_POLICY', 'Capacity policy contains a partial limit set');
  return {
    requestsPerMinute: dbLimit(row.requests_per_minute, 'requests_per_minute', MAX_SAFE_INTEGER_BIGINT),
    tokensPerMinute: dbLimit(row.tokens_per_minute, 'tokens_per_minute', MAX_SAFE_INTEGER_BIGINT),
    maxConcurrentRequests: dbLimit(row.max_concurrent_requests, 'max_concurrent_requests', BigInt(MAX_CONCURRENCY)),
  };
}

function inputReason(value: unknown): CapacityPolicyReason {
  if (typeof value !== 'string' || !(CAPACITY_POLICY_REASONS as readonly string[]).includes(value)) {
    fail('INVALID_INPUT', 'reason must be a supported non-sensitive reason code');
  }
  return value as CapacityPolicyReason;
}

function validateRequestId(value: unknown): string {
  return inputUuid(value, 'requestId');
}

function sameLimits(left: CapacityPolicyLimits | null, right: CapacityPolicyLimits): boolean {
  return (
    left !== null &&
    left.requestsPerMinute === right.requestsPerMinute &&
    left.tokensPerMinute === right.tokensPerMinute &&
    left.maxConcurrentRequests === right.maxConcurrentRequests
  );
}

function exactActor(value: unknown): PlatformAdminActor {
  const allowed = new Set(['userId', 'sessionId', 'roles']);
  const candidate = objectInput(value, allowed);
  requireKeys(candidate, allowed);
  const userId = inputUuid(candidate.userId, 'actor.userId');
  const sessionId = inputUuid(candidate.sessionId, 'actor.sessionId');
  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    fail('FORBIDDEN', 'A trusted platform administrator actor is required');
  }
  const roles: PlatformAdminRole[] = [];
  const seen = new Set<PlatformAdminRole>();
  for (const role of candidate.roles) {
    if (!isPlatformAdminRole(role) || seen.has(role)) {
      fail('FORBIDDEN', 'A trusted platform administrator actor is required');
    }
    seen.add(role);
    roles.push(role);
  }
  return { userId, sessionId, roles };
}

function resultRows<Row>(result: SqlResult<Row>, label: string): Row[] {
  if (!result || !Array.isArray(result.rows)) fail('STORAGE_ERROR', `${label} query result is malformed`);
  if (result.rowCount !== null && result.rowCount !== result.rows.length) {
    fail('STORAGE_ERROR', `${label} query row count is inconsistent`);
  }
  return result.rows;
}

function oneRow<Row>(
  rows: readonly Row[],
  missingCode: 'NOT_FOUND' | 'CAS_CONFLICT' | 'STORAGE_ERROR',
  label: string,
): Row {
  if (rows.length === 0) fail(missingCode, `${label} was not found`);
  if (rows.length !== 1) fail('AMBIGUOUS', `${label} is ambiguous`);
  const row = rows[0];
  if (row === undefined || row === null || typeof row !== 'object') fail('STORAGE_ERROR', `${label} is malformed`);
  return row;
}

function transactionError(error: unknown): never {
  if (error instanceof CapacityPolicyError) throw error;
  throw new CapacityPolicyError('STORAGE_ERROR', 'Capacity policy operation failed', { cause: error });
}

async function runTransaction<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  try {
    return await database.transaction(work);
  } catch (error) {
    return transactionError(error);
  }
}

async function authorizeActor(
  tx: SqlExecutor,
  actor: PlatformAdminActor,
  write: boolean,
  scope: { readonly tenantId: string; readonly projectId?: string; readonly apiKeyId?: string },
): Promise<void> {
  const acceptedRoles = write ? PLATFORM_WRITE_ROLES : PLATFORM_READ_ROLES;
  if (!hasPlatformRole(actor, acceptedRoles)) fail('FORBIDDEN', 'The platform role cannot manage capacity policies');

  // Lock-order contract: transaction mode/timeouts, tenant -> project ->
  // user/API-key fences, non-locking authority reads, mutable target-head row
  // locks, audit inserts, then commit. The target fence is exclusive for a
  // write and shared for a read, and is always acquired before FOR UPDATE.
  // This path never row-locks authorization facts; the audit FK's KEY SHARE on
  // saas_users is compatible with a normal disabled_at UPDATE's NO KEY UPDATE
  // lock, and auth triggers never acquire capacity-head locks.
  await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await tx.query("SET LOCAL lock_timeout = '2s'");
  await tx.query("SET LOCAL statement_timeout = '10s'");
  const mode: AdvisoryFenceMode = write ? 'exclusive' : 'shared';
  await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.tenant(scope.tenantId), mode }]);
  if (scope.projectId !== undefined) {
    await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.project(scope.tenantId, scope.projectId), mode }]);
  }
  const subjectRequests: AdvisoryFenceRequest[] = [{ key: saasAdvisoryKey.user(actor.userId), mode: 'shared' }];
  if (scope.apiKeyId !== undefined) {
    subjectRequests.push({ key: saasAdvisoryKey.apiKey(scope.tenantId, scope.projectId ?? '', scope.apiKeyId), mode });
  }
  await lockAdvisoryFenceLayer(tx, subjectRequests);

  const sessionResult = await tx.query<SessionRow>(
    `SELECT s.id, s.user_id
       FROM saas_platform_sessions AS s
       JOIN saas_users AS u ON u.id = s.user_id
       JOIN saas_mfa_credentials AS c
         ON c.id = s.credential_id AND c.user_id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2
        AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
        AND u.disabled_at IS NULL
        AND c.kind = 'totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
      LIMIT 2`,
    [actor.sessionId, actor.userId],
  );
  const sessions = resultRows(sessionResult, 'platform session');
  if (sessions.length !== 1) fail('FORBIDDEN', 'The platform administrator session is not active');
  const session = sessions[0];
  if (session === undefined || session.id !== actor.sessionId || session.user_id !== actor.userId) {
    fail('FORBIDDEN', 'The platform administrator session is not active');
  }

  const roleResult = await tx.query<RoleRow>(
    `SELECT role
       FROM saas_platform_role_assignments
      WHERE user_id = $1
      ORDER BY role ASC`,
    [actor.userId],
  );
  const roleRows = resultRows(roleResult, 'platform role');
  const assigned: PlatformAdminRole[] = [];
  const seen = new Set<PlatformAdminRole>();
  for (const row of roleRows) {
    if (row === undefined || row === null || !isPlatformAdminRole(row.role) || seen.has(row.role)) {
      fail('FORBIDDEN', 'The platform administrator role assignment is invalid');
    }
    seen.add(row.role);
    assigned.push(row.role);
  }
  const claimed = [...actor.roles].sort();
  const current = [...assigned].sort();
  if (claimed.length !== current.length || claimed.some((role, index) => role !== current[index])) {
    fail('FORBIDDEN', 'The platform administrator role assignment is stale');
  }
  if (!hasPlatformRole({ ...actor, roles: assigned }, acceptedRoles)) {
    fail('FORBIDDEN', 'The platform role cannot manage capacity policies');
  }
}

function tenantRecord(tenantId: string, row: TenantCapacityRow): CapacityPolicyRecord {
  if (row.id !== tenantId) fail('STORAGE_ERROR', 'Tenant capacity identity is inconsistent');
  const revision = dbRevision(row.capacity_policy_revision, 'tenant capacity revision');
  const limits = snapshot(row);
  return {
    scope: 'tenant',
    tenantId,
    revision,
    revisionKind: 'tenant_capacity_policy',
    limits,
    configured: limits !== null,
  };
}

function projectStatus(value: unknown): 'active' | 'suspended' | 'disabled' {
  if (value !== 'active' && value !== 'suspended' && value !== 'disabled') {
    fail('STORAGE_ERROR', 'Project inference policy status is malformed');
  }
  return value;
}

function projectRecord(
  tenantId: string,
  projectId: string,
  head: ProjectHeadRow,
  policy: ProjectPolicyRow,
): CapacityPolicyRecord {
  if (
    head.tenant_id !== tenantId ||
    head.id !== projectId ||
    policy.tenant_id !== tenantId ||
    policy.project_id !== projectId
  ) {
    fail('STORAGE_ERROR', 'Project capacity identity is inconsistent');
  }
  const revision = dbRevision(head.inference_policy_version, 'project inference policy revision');
  const policyVersion = dbRevision(policy.version, 'project inference policy version');
  const latestVersion = dbRevision(policy.latest_version, 'latest project inference policy version');
  if (policyVersion !== revision || latestVersion !== revision) {
    fail('INVALID_POLICY', 'Project policy head is not the unique current version');
  }
  if (projectStatus(policy.status) !== projectStatus(head.inference_policy_status)) {
    fail('INVALID_POLICY', 'Project policy head status does not match its version');
  }
  const limits = snapshot(policy);
  return {
    scope: 'project',
    tenantId,
    projectId,
    revision,
    revisionKind: 'project_inference_policy',
    limits,
    configured: limits !== null,
  };
}

function apiKeyRecord(
  tenantId: string,
  projectId: string,
  apiKeyId: string,
  row: ApiKeyCapacityRow,
): CapacityPolicyRecord {
  if (row.tenant_id !== tenantId || row.project_id !== projectId || row.id !== apiKeyId) {
    fail('STORAGE_ERROR', 'API key capacity identity is inconsistent');
  }
  const revision = dbRevision(row.authz_version, 'API key authorization revision');
  const limits = snapshot(row);
  return {
    scope: 'api_key',
    tenantId,
    projectId,
    apiKeyId,
    revision,
    revisionKind: 'api_key_authz',
    limits,
    configured: limits !== null,
  };
}

async function selectProjectPolicy(
  tx: SqlExecutor,
  tenantId: string,
  projectId: string,
  version: string,
): Promise<ProjectPolicyRow> {
  const result = await tx.query<ProjectPolicyRow>(
    `SELECT policy.tenant_id, policy.project_id, policy.version,
            policy.status, policy.requests_per_minute, policy.tokens_per_minute,
            policy.max_concurrent_requests,
            (SELECT MAX(history.version)
               FROM saas_project_inference_policy_versions AS history
              WHERE history.tenant_id = policy.tenant_id
                AND history.project_id = policy.project_id) AS latest_version
       FROM saas_project_inference_policy_versions AS policy
      WHERE policy.tenant_id = $1 AND policy.project_id = $2 AND policy.version = $3
      LIMIT 2`,
    [tenantId, projectId, version],
  );
  return oneRow(resultRows(result, 'project policy'), 'STORAGE_ERROR', 'Project capacity policy') as ProjectPolicyRow;
}

interface PreparedWrite {
  readonly tenantId: string;
  readonly scope: CapacityPolicyScope;
  readonly projectId: string | null;
  readonly apiKeyId: string | null;
  readonly targetId: string;
  readonly revisionKind: CapacityPolicyRecordBase['revisionKind'];
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly before: CapacityPolicyLimits | null;
  readonly after: CapacityPolicyLimits;
  readonly reason: CapacityPolicyReason;
  readonly requestId: string;
  readonly actorId: string;
}

async function appendAudit(tx: SqlExecutor, write: PreparedWrite): Promise<void> {
  const auditEventId = randomUUID();
  const actionResult = await tx.query<{ readonly id: unknown }>(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id,
        occurred_at, entry_point, request_id)
     VALUES ($1, $2, $3, 'capacity_policy.updated', $4, $5,
             clock_timestamp(), 'platform_admin', $6)
     RETURNING id`,
    [auditEventId, write.tenantId, write.actorId, `${write.scope}_capacity_policy`, write.targetId, write.requestId],
  );
  const auditRows = resultRows(actionResult, 'capacity audit event');
  if (auditRows.length !== 1 || auditRows[0]?.id !== auditEventId) {
    fail('STORAGE_ERROR', 'Capacity audit event was not persisted exactly once');
  }

  const detailResult = await tx.query<{ readonly audit_event_id: unknown }>(
    `INSERT INTO saas_capacity_policy_audit_details
       (audit_event_id, scope, tenant_id, project_id, api_key_id, reason,
        revision_kind, before_revision, after_revision,
        before_requests_per_minute, before_tokens_per_minute, before_max_concurrent_requests,
        after_requests_per_minute, after_tokens_per_minute, after_max_concurrent_requests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING audit_event_id`,
    [
      auditEventId,
      write.scope,
      write.tenantId,
      write.projectId,
      write.apiKeyId,
      write.reason,
      write.revisionKind,
      write.beforeRevision,
      write.afterRevision,
      write.before?.requestsPerMinute ?? null,
      write.before?.tokensPerMinute ?? null,
      write.before?.maxConcurrentRequests ?? null,
      write.after.requestsPerMinute,
      write.after.tokensPerMinute,
      write.after.maxConcurrentRequests,
    ],
  );
  const detailRows = resultRows(detailResult, 'capacity audit detail');
  if (detailRows.length !== 1 || detailRows[0]?.audit_event_id !== auditEventId) {
    fail('STORAGE_ERROR', 'Capacity audit detail was not persisted exactly once');
  }
}

function validateWriteBase(
  input: unknown,
  requiredKeys: ReadonlySet<string>,
): {
  readonly expectedRevision: string;
  readonly limits: CapacityPolicyLimits;
  readonly reason: CapacityPolicyReason;
  readonly requestId: string;
  readonly actor: PlatformAdminActor;
} {
  const candidate = objectInput(input, WRITE_KEYS);
  requireKeys(candidate, requiredKeys);
  if (
    candidate.tenantId === undefined ||
    candidate.expectedRevision === undefined ||
    candidate.limits === undefined ||
    candidate.reason === undefined ||
    candidate.requestId === undefined ||
    candidate.actor === undefined
  ) {
    fail('INVALID_INPUT', 'Capacity policy write input is incomplete');
  }
  return {
    expectedRevision: inputRevision(candidate.expectedRevision),
    limits: inputLimits(candidate.limits),
    reason: inputReason(candidate.reason),
    requestId: validateRequestId(candidate.requestId),
    actor: exactActor(candidate.actor),
  };
}

function validateReadShape(input: unknown, expectedKeys: ReadonlySet<string>): void {
  const candidate = objectInput(input, expectedKeys);
  requireKeys(candidate, expectedKeys);
}

function ensureChanged(before: CapacityPolicyLimits | null, after: CapacityPolicyLimits): void {
  if (sameLimits(before, after)) fail('NO_CHANGE', 'Capacity policy limits are unchanged');
}

/**
 * Platform-operator capacity policy management. Every read revalidates the
 * server-resolved actor's live platform session/roles; every write locks its
 * authority row and commits the policy change plus immutable audit facts in
 * the same SaasDatabase transaction.
 */
export class PlatformCapacityPolicyService {
  constructor(private readonly database: SaasDatabase) {
    if (!database || typeof database.transaction !== 'function' || typeof database.query !== 'function') {
      throw new TypeError('SaasDatabase is required');
    }
  }

  async getTenantPolicy(input: GetTenantCapacityPolicyInput): Promise<CapacityPolicyRecord | null> {
    validateReadShape(input, new Set(['tenantId', 'actor']));
    const tenantId = inputUuid(input?.tenantId, 'tenantId');
    const actor = exactActor(input?.actor);
    return runTransaction(this.database, async (tx) => {
      await authorizeActor(tx, actor, false, { tenantId });
      const result = await tx.query<TenantCapacityRow>(
        `SELECT id, capacity_policy_revision, requests_per_minute, tokens_per_minute,
                max_concurrent_requests
           FROM saas_tenants
          WHERE id = $1
          LIMIT 2`,
        [tenantId],
      );
      const rows = resultRows(result, 'tenant capacity policy');
      if (rows.length === 0) return null;
      return tenantRecord(tenantId, oneRow(rows, 'STORAGE_ERROR', 'Tenant capacity policy'));
    });
  }

  async setTenantPolicy(input: SetTenantCapacityPolicyInput): Promise<CapacityPolicyRecord> {
    const write = validateWriteBase(
      input,
      new Set(['tenantId', 'expectedRevision', 'limits', 'reason', 'requestId', 'actor']),
    );
    const tenantId = inputUuid(input?.tenantId, 'tenantId');
    const actor = write.actor;
    return runTransaction(this.database, async (tx) => {
      await authorizeActor(tx, actor, true, { tenantId });
      const selected = await tx.query<TenantCapacityRow>(
        `SELECT id, capacity_policy_revision, requests_per_minute, tokens_per_minute,
                max_concurrent_requests
           FROM saas_tenants
          WHERE id = $1
          LIMIT 2
          FOR UPDATE`,
        [tenantId],
      );
      const currentRow = oneRow(resultRows(selected, 'tenant capacity policy'), 'NOT_FOUND', 'Tenant');
      const beforeRecord = tenantRecord(tenantId, currentRow);
      if (beforeRecord.revision !== write.expectedRevision) {
        fail('CAS_CONFLICT', 'Tenant capacity policy revision conflict');
      }
      ensureChanged(beforeRecord.limits, write.limits);
      const afterRevision = nextRevision(beforeRecord.revision);
      const updated = await tx.query<TenantCapacityRow>(
        `UPDATE saas_tenants
            SET requests_per_minute = $2,
                tokens_per_minute = $3,
                max_concurrent_requests = $4,
                capacity_policy_revision = capacity_policy_revision + 1,
                updated_at = clock_timestamp()
          WHERE id = $1 AND capacity_policy_revision = $5
          RETURNING id, capacity_policy_revision, requests_per_minute, tokens_per_minute,
                    max_concurrent_requests`,
        [
          tenantId,
          write.limits.requestsPerMinute,
          write.limits.tokensPerMinute,
          write.limits.maxConcurrentRequests,
          beforeRecord.revision,
        ],
      );
      const afterRow = oneRow(resultRows(updated, 'tenant capacity update'), 'STORAGE_ERROR', 'Tenant update');
      const afterRecord = tenantRecord(tenantId, afterRow);
      if (afterRecord.revision !== afterRevision || !sameLimits(afterRecord.limits, write.limits)) {
        fail('STORAGE_ERROR', 'Tenant capacity update returned inconsistent state');
      }
      await appendAudit(tx, {
        tenantId,
        scope: 'tenant',
        projectId: null,
        apiKeyId: null,
        targetId: tenantId,
        revisionKind: 'tenant_capacity_policy',
        beforeRevision: beforeRecord.revision,
        afterRevision,
        before: beforeRecord.limits,
        after: write.limits,
        reason: write.reason,
        requestId: write.requestId,
        actorId: actor.userId,
      });
      return afterRecord;
    });
  }

  async getProjectPolicy(input: GetProjectCapacityPolicyInput): Promise<CapacityPolicyRecord | null> {
    validateReadShape(input, new Set(['tenantId', 'projectId', 'actor']));
    const tenantId = inputUuid(input?.tenantId, 'tenantId');
    const projectId = inputUuid(input?.projectId, 'projectId');
    const actor = exactActor(input?.actor);
    return runTransaction(this.database, async (tx) => {
      await authorizeActor(tx, actor, false, { tenantId, projectId });
      const selected = await tx.query<ProjectHeadRow>(
        `SELECT tenant_id, id, inference_policy_version, inference_policy_status
           FROM saas_projects
          WHERE tenant_id = $1 AND id = $2
          LIMIT 2`,
        [tenantId, projectId],
      );
      const headRows = resultRows(selected, 'project capacity policy head');
      if (headRows.length === 0) return null;
      const head = oneRow(headRows, 'STORAGE_ERROR', 'Project capacity policy head');
      const currentVersion = dbRevision(head.inference_policy_version, 'project inference policy revision');
      const policy = await selectProjectPolicy(tx, tenantId, projectId, currentVersion);
      return projectRecord(tenantId, projectId, head, policy);
    });
  }

  async setProjectPolicy(input: SetProjectCapacityPolicyInput): Promise<CapacityPolicyRecord> {
    const write = validateWriteBase(
      input,
      new Set(['tenantId', 'projectId', 'expectedRevision', 'limits', 'reason', 'requestId', 'actor']),
    );
    const tenantId = inputUuid(input?.tenantId, 'tenantId');
    const projectId = inputUuid(input?.projectId, 'projectId');
    const actor = write.actor;
    return runTransaction(this.database, async (tx) => {
      await authorizeActor(tx, actor, true, { tenantId, projectId });
      const selected = await tx.query<ProjectHeadRow>(
        `SELECT tenant_id, id, inference_policy_version, inference_policy_status
           FROM saas_projects
          WHERE tenant_id = $1 AND id = $2
          LIMIT 2
          FOR UPDATE`,
        [tenantId, projectId],
      );
      const head = oneRow(resultRows(selected, 'project capacity policy head'), 'NOT_FOUND', 'Project');
      const currentVersion = dbRevision(head.inference_policy_version, 'project inference policy revision');
      if (currentVersion !== write.expectedRevision) {
        fail('CAS_CONFLICT', 'Project capacity policy revision conflict');
      }
      const beforePolicy = await selectProjectPolicy(tx, tenantId, projectId, currentVersion);
      const beforeRecord = projectRecord(tenantId, projectId, head, beforePolicy);
      ensureChanged(beforeRecord.limits, write.limits);
      const afterRevision = nextRevision(currentVersion);

      const inserted = await tx.query<ProjectPolicyRow>(
        `INSERT INTO saas_project_inference_policy_versions
           (tenant_id, project_id, version, status, changed_by_user_id, created_at,
            requests_per_minute, tokens_per_minute, max_concurrent_requests)
         SELECT source.tenant_id, source.project_id, $4, source.status, $5, clock_timestamp(),
                $6, $7, $8
           FROM saas_project_inference_policy_versions AS source
          WHERE source.tenant_id = $1 AND source.project_id = $2 AND source.version = $3
         RETURNING tenant_id, project_id, version, status, requests_per_minute,
                   tokens_per_minute, max_concurrent_requests,
                   (SELECT MAX(history.version)
                      FROM saas_project_inference_policy_versions AS history
                     WHERE history.tenant_id = saas_project_inference_policy_versions.tenant_id
                       AND history.project_id = saas_project_inference_policy_versions.project_id) AS latest_version`,
        [
          tenantId,
          projectId,
          currentVersion,
          afterRevision,
          actor.userId,
          write.limits.requestsPerMinute,
          write.limits.tokensPerMinute,
          write.limits.maxConcurrentRequests,
        ],
      );
      const afterPolicy = oneRow(
        resultRows(inserted, 'project policy version insert'),
        'STORAGE_ERROR',
        'Project policy append',
      );
      const insertedRecord = projectRecord(
        tenantId,
        projectId,
        {
          ...head,
          inference_policy_version: afterRevision,
        },
        afterPolicy,
      );
      if (!sameLimits(insertedRecord.limits, write.limits)) {
        fail('STORAGE_ERROR', 'Appended project capacity policy does not match requested limits');
      }

      const updated = await tx.query<ProjectHeadRow>(
        `UPDATE saas_projects
            SET inference_policy_version = $3,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND inference_policy_version = $4
          RETURNING tenant_id, id, inference_policy_version, inference_policy_status`,
        [tenantId, projectId, afterRevision, currentVersion],
      );
      const afterHead = oneRow(
        resultRows(updated, 'project policy head update'),
        'CAS_CONFLICT',
        'Project policy head',
      );
      const afterRecord = projectRecord(tenantId, projectId, afterHead, afterPolicy);
      await appendAudit(tx, {
        tenantId,
        scope: 'project',
        projectId,
        apiKeyId: null,
        targetId: projectId,
        revisionKind: 'project_inference_policy',
        beforeRevision: currentVersion,
        afterRevision,
        before: beforeRecord.limits,
        after: write.limits,
        reason: write.reason,
        requestId: write.requestId,
        actorId: actor.userId,
      });
      return afterRecord;
    });
  }

  async getApiKeyPolicy(input: GetApiKeyCapacityPolicyInput): Promise<CapacityPolicyRecord | null> {
    validateReadShape(input, new Set(['tenantId', 'projectId', 'apiKeyId', 'actor']));
    const tenantId = inputUuid(input?.tenantId, 'tenantId');
    const projectId = inputUuid(input?.projectId, 'projectId');
    const apiKeyId = inputUuid(input?.apiKeyId, 'apiKeyId');
    const actor = exactActor(input?.actor);
    return runTransaction(this.database, async (tx) => {
      await authorizeActor(tx, actor, false, { tenantId, projectId, apiKeyId });
      const selected = await tx.query<ApiKeyCapacityRow>(
        `SELECT tenant_id, project_id, id, authz_version, requests_per_minute,
                tokens_per_minute, max_concurrent_requests
           FROM saas_api_keys
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          LIMIT 2`,
        [tenantId, projectId, apiKeyId],
      );
      const rows = resultRows(selected, 'API key capacity policy');
      if (rows.length === 0) return null;
      return apiKeyRecord(tenantId, projectId, apiKeyId, oneRow(rows, 'STORAGE_ERROR', 'API key capacity policy'));
    });
  }

  async setApiKeyPolicy(input: SetApiKeyCapacityPolicyInput): Promise<CapacityPolicyRecord> {
    const write = validateWriteBase(
      input,
      new Set(['tenantId', 'projectId', 'apiKeyId', 'expectedRevision', 'limits', 'reason', 'requestId', 'actor']),
    );
    const tenantId = inputUuid(input?.tenantId, 'tenantId');
    const projectId = inputUuid(input?.projectId, 'projectId');
    const apiKeyId = inputUuid(input?.apiKeyId, 'apiKeyId');
    const actor = write.actor;
    return runTransaction(this.database, async (tx) => {
      await authorizeActor(tx, actor, true, { tenantId, projectId, apiKeyId });
      const selected = await tx.query<ApiKeyCapacityRow>(
        `SELECT tenant_id, project_id, id, authz_version, requests_per_minute,
                tokens_per_minute, max_concurrent_requests
           FROM saas_api_keys
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          LIMIT 2
          FOR UPDATE`,
        [tenantId, projectId, apiKeyId],
      );
      const currentRow = oneRow(resultRows(selected, 'API key capacity policy'), 'NOT_FOUND', 'API key');
      const beforeRecord = apiKeyRecord(tenantId, projectId, apiKeyId, currentRow);
      if (beforeRecord.revision !== write.expectedRevision) {
        fail('CAS_CONFLICT', 'API key authorization revision conflict');
      }
      ensureChanged(beforeRecord.limits, write.limits);
      const afterRevision = nextRevision(beforeRecord.revision);
      const updated = await tx.query<ApiKeyCapacityRow>(
        `UPDATE saas_api_keys
            SET requests_per_minute = $4,
                tokens_per_minute = $5,
                max_concurrent_requests = $6,
                authz_version = authz_version + 1
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND authz_version = $7
          RETURNING tenant_id, project_id, id, authz_version, requests_per_minute,
                    tokens_per_minute, max_concurrent_requests`,
        [
          tenantId,
          projectId,
          apiKeyId,
          write.limits.requestsPerMinute,
          write.limits.tokensPerMinute,
          write.limits.maxConcurrentRequests,
          beforeRecord.revision,
        ],
      );
      const afterRow = oneRow(resultRows(updated, 'API key capacity update'), 'CAS_CONFLICT', 'API key update');
      const afterRecord = apiKeyRecord(tenantId, projectId, apiKeyId, afterRow);
      if (afterRecord.revision !== afterRevision || !sameLimits(afterRecord.limits, write.limits)) {
        fail('STORAGE_ERROR', 'API key capacity update returned inconsistent state');
      }
      await appendAudit(tx, {
        tenantId,
        scope: 'api_key',
        projectId,
        apiKeyId,
        targetId: apiKeyId,
        revisionKind: 'api_key_authz',
        beforeRevision: beforeRecord.revision,
        afterRevision,
        before: beforeRecord.limits,
        after: write.limits,
        reason: write.reason,
        requestId: write.requestId,
        actorId: actor.userId,
      });
      return afterRecord;
    });
  }
}
