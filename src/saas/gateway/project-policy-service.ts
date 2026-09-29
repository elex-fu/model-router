import { randomUUID } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
  saasAdvisoryKey,
  sortAndDedupeAdvisoryKeys,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../db/index.js';

export type ProjectInferencePolicyStatus = 'active' | 'suspended' | 'disabled';
export type ProjectPolicyVersionInput = bigint | number | string;

export interface ProjectInferencePolicyRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly version: string;
  readonly status: ProjectInferencePolicyStatus;
  readonly changedByUserId: string | null;
  readonly createdAt: string;
}

export interface ProjectInferencePolicyAuditContext {
  readonly actorUserId: string;
  readonly entryPoint: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface SetProjectInferencePolicyStatusInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly expectedVersion: ProjectPolicyVersionInput;
  readonly status: ProjectInferencePolicyStatus;
  readonly audit: ProjectInferencePolicyAuditContext;
}

export type ProjectInferencePolicyErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CAS_CONFLICT'
  | 'INVALID_LIFECYCLE'
  | 'STORAGE_ERROR';

export class SaasProjectInferencePolicyError extends Error {
  constructor(
    readonly code: ProjectInferencePolicyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaasProjectInferencePolicyError';
  }
}

interface ProjectHeadRow {
  tenant_id: unknown;
  id: unknown;
  inference_policy_version: unknown;
  inference_policy_status: unknown;
}

const STATUSES = new Set<ProjectInferencePolicyStatus>(['active', 'suspended', 'disabled']);
const MAX_BIGINT = 9223372036854775807n;
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

async function lockProjectAuthorization(
  tx: SqlExecutor,
  tenantId: string,
  projectId: string,
  mode: AdvisoryFenceMode,
  actorUserId?: string,
): Promise<void> {
  await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.tenant(tenantId), mode }]);
  await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.project(tenantId, projectId), mode }]);
  if (actorUserId !== undefined) {
    await lockAdvisoryFenceLayer(tx, [{ key: saasAdvisoryKey.user(actorUserId), mode: 'shared' }]);
  }
}

function fail(code: ProjectInferencePolicyErrorCode, message: string, cause?: unknown): never {
  throw new SaasProjectInferencePolicyError(code, message, cause === undefined ? undefined : { cause });
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${label} is required`);
  return value.trim();
}

function version(value: unknown, label: string): string {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) parsed = BigInt(value.trim());
    else fail('INVALID_INPUT', `${label} must be a positive integer`);
  } catch (error) {
    if (error instanceof SaasProjectInferencePolicyError) throw error;
    fail('INVALID_INPUT', `${label} must be a positive integer`, error);
  }
  if (parsed < 1n || parsed > MAX_BIGINT) fail('INVALID_INPUT', `${label} must be a positive integer`);
  return parsed.toString(10);
}

function status(value: unknown): ProjectInferencePolicyStatus {
  if (typeof value !== 'string' || !STATUSES.has(value as ProjectInferencePolicyStatus)) {
    fail('INVALID_INPUT', 'status is invalid');
  }
  return value as ProjectInferencePolicyStatus;
}

function currentDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INPUT', 'clock is invalid');
  return value.toISOString();
}

function recordFromRow(row: Record<string, unknown>): ProjectInferencePolicyRecord {
  const rowStatus = status(row.status);
  return {
    tenantId: text(row.tenant_id, 'tenant_id'),
    projectId: text(row.project_id, 'project_id'),
    version: version(row.version, 'version'),
    status: rowStatus,
    changedByUserId:
      row.changed_by_user_id === null || row.changed_by_user_id === undefined
        ? null
        : text(row.changed_by_user_id, 'changed_by_user_id'),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at))
          ? new Date(row.created_at).toISOString()
          : (() => fail('STORAGE_ERROR', 'policy created_at is invalid'))(),
  };
}

export class SaasProjectInferencePolicyService {
  constructor(
    private readonly database: SaasDatabase,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  async setStatus(input: SetProjectInferencePolicyStatusInput): Promise<ProjectInferencePolicyRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const expectedVersion = version(input?.expectedVersion, 'expectedVersion');
    const nextStatus = status(input?.status);
    const audit = input?.audit;
    if (!audit || typeof audit !== 'object') fail('INVALID_INPUT', 'audit is required');
    const actorUserId = text(audit.actorUserId, 'audit.actorUserId');
    const entryPoint = text(audit.entryPoint, 'audit.entryPoint');
    const sourceIp = audit.sourceIp ?? null;
    const userAgent = audit.userAgent ?? null;
    const requestId = audit.requestId ?? null;
    if (sourceIp !== null && typeof sourceIp !== 'string') fail('INVALID_INPUT', 'audit.sourceIp is invalid');
    if (userAgent !== null && typeof userAgent !== 'string') fail('INVALID_INPUT', 'audit.userAgent is invalid');
    if (requestId !== null && typeof requestId !== 'string') fail('INVALID_INPUT', 'audit.requestId is invalid');
    const now = currentDate(this.options.now ?? (() => new Date()));

    try {
      return await this.database.transaction(async (tx) => {
        // Migration 047's project writer trigger takes the global fence. It
        // must precede the tenant -> project -> actor advisory prelocks.
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
        await lockProjectAuthorization(tx, tenantId, projectId, 'exclusive', actorUserId);
        const head = await tx.query<ProjectHeadRow>(
          `SELECT tenant_id, id, inference_policy_version, inference_policy_status
           FROM saas_projects
           WHERE tenant_id = $1 AND id = $2
           LIMIT 2
           FOR UPDATE`,
          [tenantId, projectId],
        );
        if (head.rows.length === 0) fail('NOT_FOUND', 'project was not found');
        if (head.rows.length !== 1) fail('STORAGE_ERROR', 'project identity is ambiguous');
        const current = head.rows[0];
        if (!current) fail('STORAGE_ERROR', 'project head is missing');
        const currentVersion = version(current.inference_policy_version, 'project policy version');
        const currentStatus = status(current.inference_policy_status);
        if (currentVersion !== expectedVersion) fail('CAS_CONFLICT', 'project policy version conflict');
        if (currentStatus === nextStatus) fail('INVALID_LIFECYCLE', 'project policy status is unchanged');

        const nextVersion = (BigInt(currentVersion) + 1n).toString(10);
        if (BigInt(nextVersion) > MAX_BIGINT) fail('INVALID_LIFECYCLE', 'project policy version exhausted');
        await tx.query(
          `INSERT INTO saas_project_inference_policy_versions
             (tenant_id, project_id, version, status, changed_by_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, projectId, nextVersion, nextStatus, actorUserId, now],
        );

        const updated = await tx.query<ProjectHeadRow>(
          `UPDATE saas_projects
           SET inference_policy_version = $3,
               inference_policy_status = $4,
               updated_at = $5
           WHERE tenant_id = $1 AND id = $2
             AND inference_policy_version = $6
             AND inference_policy_status = $7
           RETURNING tenant_id, id, inference_policy_version, inference_policy_status`,
          [tenantId, projectId, nextVersion, nextStatus, now, expectedVersion, currentStatus],
        );
        if (updated.rows.length !== 1) fail('CAS_CONFLICT', 'project policy version conflict');

        await tx.query(
          `INSERT INTO saas_audit_events
             (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
              source_ip, user_agent, entry_point, request_id)
           VALUES ($1, $2, $3, $4, 'saas_project_inference_policy', $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            tenantId,
            actorUserId,
            `project_inference_policy.${nextStatus}`,
            `${tenantId}:${projectId}`,
            now,
            sourceIp,
            userAgent,
            entryPoint,
            requestId,
          ],
        );

        return {
          tenantId,
          projectId,
          version: nextVersion,
          status: nextStatus,
          changedByUserId: actorUserId,
          createdAt: now,
        };
      });
    } catch (error) {
      if (error instanceof SaasProjectInferencePolicyError) throw error;
      throw new SaasProjectInferencePolicyError('STORAGE_ERROR', 'Project inference policy could not be changed', {
        cause: error,
      });
    }
  }

  enable(input: Omit<SetProjectInferencePolicyStatusInput, 'status'>): Promise<ProjectInferencePolicyRecord> {
    return this.setStatus({ ...input, status: 'active' });
  }

  suspend(input: Omit<SetProjectInferencePolicyStatusInput, 'status'>): Promise<ProjectInferencePolicyRecord> {
    return this.setStatus({ ...input, status: 'suspended' });
  }

  disable(input: Omit<SetProjectInferencePolicyStatusInput, 'status'>): Promise<ProjectInferencePolicyRecord> {
    return this.setStatus({ ...input, status: 'disabled' });
  }

  /** Read one policy version without converting a missing row into authority. */
  async get(
    tenantIdInput: string,
    projectIdInput: string,
    versionInput: ProjectPolicyVersionInput,
    executor?: SqlExecutor,
  ): Promise<ProjectInferencePolicyRecord | null> {
    const tenantId = text(tenantIdInput, 'tenantId');
    const projectId = text(projectIdInput, 'projectId');
    const policyVersion = version(versionInput, 'version');
    const run = async (tx: SqlExecutor): Promise<ProjectInferencePolicyRecord | null> => {
      await lockProjectAuthorization(tx, tenantId, projectId, 'shared');
      const result: SqlResult<Record<string, unknown>> = await tx.query(
        `SELECT tenant_id, project_id, version, status, changed_by_user_id, created_at
         FROM saas_project_inference_policy_versions
         WHERE tenant_id = $1 AND project_id = $2 AND version = $3
         LIMIT 2`,
        [tenantId, projectId, policyVersion],
      );
      if (result.rows.length > 1) fail('STORAGE_ERROR', 'policy version is ambiguous');
      const row = result.rows[0];
      return row ? recordFromRow(row) : null;
    };
    try {
      return executor ? await run(executor) : await this.database.transaction(run);
    } catch (error) {
      if (error instanceof SaasProjectInferencePolicyError) throw error;
      throw new SaasProjectInferencePolicyError('STORAGE_ERROR', 'Project inference policy could not be read', {
        cause: error,
      });
    }
  }
}
