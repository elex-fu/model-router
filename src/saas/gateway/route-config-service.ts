import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import type { GatewayProtocol, SaasRouteTargetMode, SupplyMode } from './contracts.js';

export type RouteConfigStatus = 'draft' | 'active' | 'disabled';
export type RouteConfigVersionInput = bigint | number | string;
export type RouteTargetMode = SaasRouteTargetMode;

export interface RouteConfigDefinition {
  readonly publicModelId: string;
  readonly publicModelVersion: RouteConfigVersionInput;
  readonly protocol: GatewayProtocol;
  readonly supplyMode: SupplyMode;
  readonly targetMode: RouteTargetMode;
  /** Opaque non-secret supply/upstream authority reference. */
  readonly upstreamId: string;
  readonly endpoint: string;
}

export interface RouteConfigAuditContext {
  readonly actorUserId: string;
  readonly entryPoint: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface CreateRouteConfigInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly definition: RouteConfigDefinition;
  readonly audit: RouteConfigAuditContext;
}

export interface PublishRouteConfigInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly expectedVersion: RouteConfigVersionInput;
  /** Omit to publish the current draft; provide to publish a replacement version. */
  readonly definition?: RouteConfigDefinition;
  readonly audit: RouteConfigAuditContext;
}

export interface DisableRouteConfigInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly expectedVersion: RouteConfigVersionInput;
  readonly audit: RouteConfigAuditContext;
}

export interface ResolveRouteConfigInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly supplyMode: SupplyMode;
  readonly executor?: SqlExecutor;
}

export interface RouteConfigRecord extends Omit<RouteConfigDefinition, 'publicModelVersion'> {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly version: string;
  readonly publicModelVersion: string;
  readonly status: RouteConfigStatus;
  readonly changedByUserId: string | null;
  readonly createdAt: string;
}

export type SaasRouteConfigErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CAS_CONFLICT'
  | 'INVALID_LIFECYCLE'
  | 'UNPUBLISHED'
  | 'AMBIGUOUS'
  | 'TARGET_MODE_MISMATCH'
  | 'STORAGE_ERROR';

export class SaasRouteConfigError extends Error {
  constructor(
    readonly code: SaasRouteConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaasRouteConfigError';
  }
}

interface RouteVersionRow extends Record<string, unknown> {
  tenant_id: unknown;
  project_id: unknown;
  route_id: unknown;
  version: unknown;
  status: unknown;
  public_model_id: unknown;
  public_model_version: unknown;
  protocol: unknown;
  supply_mode: unknown;
  target_mode: unknown;
  upstream_id: unknown;
  endpoint: unknown;
  changed_by_user_id: unknown;
  created_at: unknown;
}

interface RouteHeadRow {
  tenant_id: unknown;
  project_id: unknown;
  route_id: unknown;
  current_version: unknown;
  status: unknown;
}

const PROTOCOLS = new Set<GatewayProtocol>(['anthropic', 'openai', 'gemini', 'responses']);
const SUPPLY_MODES = new Set<SupplyMode>(['byok', 'platform']);
const TARGET_MODES = new Set<RouteTargetMode>(['tenant_account', 'platform_pool']);
const STATUSES = new Set<RouteConfigStatus>(['draft', 'active', 'disabled']);
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function fail(code: SaasRouteConfigErrorCode, message: string, cause?: unknown): never {
  throw new SaasRouteConfigError(code, message, cause === undefined ? undefined : { cause });
}

function text(value: unknown, label: string, max = 512): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.trim().length > max ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    fail('INVALID_INPUT', `${label} is invalid`);
  }
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
    if (error instanceof SaasRouteConfigError) throw error;
    fail('INVALID_INPUT', `${label} must be a positive integer`, error);
  }
  if (parsed < 1n || parsed > MAX_BIGINT) fail('INVALID_INPUT', `${label} must be a positive integer`);
  return parsed.toString(10);
}

function protocol(value: unknown): GatewayProtocol {
  if (typeof value !== 'string' || !PROTOCOLS.has(value as GatewayProtocol))
    fail('INVALID_INPUT', 'protocol is invalid');
  return value as GatewayProtocol;
}

function supplyMode(value: unknown): SupplyMode {
  if (typeof value !== 'string' || !SUPPLY_MODES.has(value as SupplyMode)) {
    fail('INVALID_INPUT', 'supplyMode is invalid');
  }
  return value as SupplyMode;
}

function targetMode(value: unknown): RouteTargetMode {
  if (typeof value !== 'string' || !TARGET_MODES.has(value as RouteTargetMode)) {
    fail('INVALID_INPUT', 'targetMode is invalid');
  }
  return value as RouteTargetMode;
}

function status(value: unknown): RouteConfigStatus {
  if (typeof value !== 'string' || !STATUSES.has(value as RouteConfigStatus))
    fail('STORAGE_ERROR', 'route status is invalid');
  return value as RouteConfigStatus;
}

function dateString(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  fail('STORAGE_ERROR', 'route timestamp is invalid');
}

function nowString(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INPUT', 'clock is invalid');
  return value.toISOString();
}

function normalizeDefinition(input: RouteConfigDefinition): RouteConfigDefinition & { publicModelVersion: string } {
  const normalizedSupplyMode = supplyMode(input?.supplyMode);
  const normalizedTargetMode = targetMode(input?.targetMode);
  const expectedTargetMode: RouteTargetMode = normalizedSupplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  if (normalizedTargetMode !== expectedTargetMode) {
    throw new SaasRouteConfigError(
      'TARGET_MODE_MISMATCH',
      `targetMode ${normalizedTargetMode} does not match supplyMode ${normalizedSupplyMode}`,
    );
  }
  return {
    publicModelId: text(input?.publicModelId, 'publicModelId'),
    publicModelVersion: version(input?.publicModelVersion, 'publicModelVersion'),
    protocol: protocol(input?.protocol),
    supplyMode: normalizedSupplyMode,
    targetMode: normalizedTargetMode,
    upstreamId: text(input?.upstreamId, 'upstreamId', 255),
    endpoint: text(input?.endpoint, 'endpoint', 1024),
  };
}

function normalizeAudit(input: RouteConfigAuditContext): Required<RouteConfigAuditContext> {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', 'audit is required');
  const sourceIp = input.sourceIp ?? null;
  const userAgent = input.userAgent ?? null;
  const requestId = input.requestId ?? null;
  if (sourceIp !== null && typeof sourceIp !== 'string') fail('INVALID_INPUT', 'audit.sourceIp is invalid');
  if (userAgent !== null && typeof userAgent !== 'string') fail('INVALID_INPUT', 'audit.userAgent is invalid');
  if (requestId !== null && typeof requestId !== 'string') fail('INVALID_INPUT', 'audit.requestId is invalid');
  return {
    actorUserId: text(input.actorUserId, 'audit.actorUserId'),
    entryPoint: text(input.entryPoint, 'audit.entryPoint'),
    sourceIp,
    userAgent,
    requestId,
  };
}

function record(row: RouteVersionRow): RouteConfigRecord {
  const recordSupplyMode = supplyMode(row.supply_mode);
  const recordTargetMode = targetMode(row.target_mode);
  if (
    (recordSupplyMode === 'byok' && recordTargetMode !== 'tenant_account') ||
    (recordSupplyMode === 'platform' && recordTargetMode !== 'platform_pool')
  ) {
    fail('STORAGE_ERROR', 'route target mode does not match supply mode');
  }
  return {
    tenantId: text(row.tenant_id, 'tenant_id'),
    projectId: text(row.project_id, 'project_id'),
    routeId: text(row.route_id, 'route_id'),
    version: version(row.version, 'version'),
    status: status(row.status),
    publicModelId: text(row.public_model_id, 'public_model_id'),
    publicModelVersion: version(row.public_model_version, 'public_model_version'),
    protocol: protocol(row.protocol),
    supplyMode: recordSupplyMode,
    targetMode: recordTargetMode,
    upstreamId: text(row.upstream_id, 'upstream_id'),
    endpoint: text(row.endpoint, 'endpoint', 1024),
    changedByUserId:
      row.changed_by_user_id === null || row.changed_by_user_id === undefined
        ? null
        : text(row.changed_by_user_id, 'changed_by_user_id'),
    createdAt: dateString(row.created_at),
  };
}

function rowForInsert(
  tenantId: string,
  projectId: string,
  routeId: string,
  routeVersion: string,
  routeStatus: RouteConfigStatus,
  definition: RouteConfigDefinition & { publicModelVersion: string },
  actorUserId: string,
  now: string,
): readonly unknown[] {
  return [
    tenantId,
    projectId,
    routeId,
    routeVersion,
    routeStatus,
    definition.publicModelId,
    definition.publicModelVersion,
    definition.protocol,
    definition.supplyMode,
    definition.targetMode,
    definition.upstreamId,
    definition.endpoint,
    actorUserId,
    now,
  ];
}

async function audit(
  tx: SqlExecutor,
  tenantId: string,
  auditContext: Required<RouteConfigAuditContext>,
  action: string,
  targetId: string,
  now: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
        source_ip, user_agent, entry_point, request_id)
     VALUES ($1, $2, $3, $4, 'saas_route_config', $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      tenantId,
      auditContext.actorUserId,
      action,
      targetId,
      now,
      auditContext.sourceIp,
      auditContext.userAgent,
      auditContext.entryPoint,
      auditContext.requestId,
    ],
  );
}

async function fenceRouteConfigWriter(tx: SqlExecutor, tenantId: string, projectId: string): Promise<void> {
  // Match migration 047's BEFORE STATEMENT -> entity-fence order before doing
  // any head lookup or DML. The DML triggers reacquire both locks reentrantly.
  await tx.query("SELECT set_config('lock_timeout', '2s', TRUE)", []);
  await tx.query("SELECT set_config('statement_timeout', '10s', TRUE)", []);
  await tx.query('SELECT pg_advisory_xact_lock(1396788563, 46)', []);
  await tx.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(
         'saas-authz:project:' || $1::uuid::text || ':' || $2::uuid::text,
         0
       )
     )`,
    [tenantId, projectId],
  );
}

async function fenceRouteConfigReader(tx: SqlExecutor, tenantId: string, projectId: string): Promise<void> {
  await tx.query(
    `SELECT pg_advisory_xact_lock_shared(
       hashtextextended(
         'saas-authz:project:' || $1::uuid::text || ':' || $2::uuid::text,
         0
       )
     )`,
    [tenantId, projectId],
  );
}

export class SaasRouteConfigService {
  constructor(
    private readonly database: SaasDatabase,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  async create(input: CreateRouteConfigInput): Promise<RouteConfigRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const routeId = text(input?.routeId, 'routeId');
    const definition = normalizeDefinition(input?.definition);
    const auditContext = normalizeAudit(input?.audit);
    const now = nowString(this.options.now ?? (() => new Date()));

    try {
      return await this.database.transaction(async (tx) => {
        await fenceRouteConfigWriter(tx, tenantId, projectId);
        const existing = await tx.query<RouteHeadRow>(
          `SELECT tenant_id, project_id, route_id, current_version, status
           FROM saas_route_config_heads
           WHERE tenant_id = $1 AND project_id = $2 AND route_id = $3
           LIMIT 2`,
          [tenantId, projectId, routeId],
        );
        if (existing.rows.length > 1) fail('STORAGE_ERROR', 'route head is ambiguous');
        if (existing.rows.length === 1) fail('CAS_CONFLICT', 'route already exists');

        await tx.query(
          `INSERT INTO saas_route_config_versions
             (tenant_id, project_id, route_id, version, status, public_model_id, public_model_version,
              protocol, supply_mode, target_mode, upstream_id, endpoint, changed_by_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          rowForInsert(tenantId, projectId, routeId, '1', 'draft', definition, auditContext.actorUserId, now),
        );
        await tx.query(
          `INSERT INTO saas_route_config_heads
             (tenant_id, project_id, route_id, current_version, status, changed_by_user_id, created_at, updated_at)
           VALUES ($1, $2, $3, 1, 'draft', $4, $5, $5)`,
          [tenantId, projectId, routeId, auditContext.actorUserId, now],
        );
        await audit(tx, tenantId, auditContext, 'route_config.created', `${projectId}:${routeId}:1`, now);
        return {
          tenantId,
          projectId,
          routeId,
          version: '1',
          status: 'draft',
          ...definition,
          changedByUserId: auditContext.actorUserId,
          createdAt: now,
        };
      });
    } catch (error) {
      if (error instanceof SaasRouteConfigError) throw error;
      throw new SaasRouteConfigError('STORAGE_ERROR', 'Route config could not be created', { cause: error });
    }
  }

  createDraft(input: CreateRouteConfigInput): Promise<RouteConfigRecord> {
    return this.create(input);
  }

  createVersion(input: CreateRouteConfigInput): Promise<RouteConfigRecord> {
    return this.create(input);
  }

  async publish(input: PublishRouteConfigInput): Promise<RouteConfigRecord> {
    return this.transition(input, 'active');
  }

  async disable(input: DisableRouteConfigInput): Promise<RouteConfigRecord> {
    return this.transition(input, 'disabled');
  }

  publishVersion(input: PublishRouteConfigInput): Promise<RouteConfigRecord> {
    return this.publish(input);
  }

  disableVersion(input: DisableRouteConfigInput): Promise<RouteConfigRecord> {
    return this.disable(input);
  }

  private async transition(
    input: PublishRouteConfigInput | DisableRouteConfigInput,
    nextStatus: 'active' | 'disabled',
  ): Promise<RouteConfigRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const routeId = text(input?.routeId, 'routeId');
    const expectedVersion = version(input?.expectedVersion, 'expectedVersion');
    const auditContext = normalizeAudit(input?.audit);
    const suppliedDefinition = 'definition' in input && input.definition ? normalizeDefinition(input.definition) : null;
    const now = nowString(this.options.now ?? (() => new Date()));

    try {
      return await this.database.transaction(async (tx) => {
        await fenceRouteConfigWriter(tx, tenantId, projectId);
        const headResult = await tx.query<RouteHeadRow>(
          `SELECT tenant_id, project_id, route_id, current_version, status
           FROM saas_route_config_heads
           WHERE tenant_id = $1 AND project_id = $2 AND route_id = $3
           LIMIT 2`,
          [tenantId, projectId, routeId],
        );
        if (headResult.rows.length === 0) fail('NOT_FOUND', 'route head was not found');
        if (headResult.rows.length !== 1) fail('STORAGE_ERROR', 'route head is ambiguous');
        const head = headResult.rows[0];
        if (!head) fail('STORAGE_ERROR', 'route head is missing');
        const currentVersion = version(head.current_version, 'current route version');
        const currentStatus = status(head.status);
        if (currentVersion !== expectedVersion) fail('CAS_CONFLICT', 'route version conflict');
        if (nextStatus === 'disabled' && currentStatus === 'disabled') {
          fail('INVALID_LIFECYCLE', 'route is already disabled');
        }

        let current: RouteConfigRecord | null = null;
        if (!suppliedDefinition) {
          const currentResult = await tx.query<RouteVersionRow>(
            `SELECT tenant_id, project_id, route_id, version, status, public_model_id,
                    public_model_version, protocol, supply_mode, target_mode, upstream_id,
                    endpoint, changed_by_user_id, created_at
             FROM saas_route_config_versions
             WHERE tenant_id = $1 AND project_id = $2 AND route_id = $3 AND version = $4
             LIMIT 2`,
            [tenantId, projectId, routeId, currentVersion],
          );
          if (currentResult.rows.length !== 1 || !currentResult.rows[0]) {
            fail('STORAGE_ERROR', 'route version is missing or ambiguous');
          }
          current = record(currentResult.rows[0]);
        }
        const definition = suppliedDefinition ?? current;
        if (!definition) fail('STORAGE_ERROR', 'route definition is missing');
        const nextVersion = version(BigInt(currentVersion) + 1n, 'next route version');

        await tx.query(
          `INSERT INTO saas_route_config_versions
             (tenant_id, project_id, route_id, version, status, public_model_id, public_model_version,
              protocol, supply_mode, target_mode, upstream_id, endpoint, changed_by_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          rowForInsert(
            tenantId,
            projectId,
            routeId,
            nextVersion,
            nextStatus,
            definition,
            auditContext.actorUserId,
            now,
          ),
        );
        const updated = await tx.query<RouteHeadRow>(
          `UPDATE saas_route_config_heads
           SET current_version = $4, status = $5, changed_by_user_id = $6, updated_at = $7
           WHERE tenant_id = $1 AND project_id = $2 AND route_id = $3
             AND current_version = $8
           RETURNING tenant_id, project_id, route_id, current_version, status`,
          [tenantId, projectId, routeId, nextVersion, nextStatus, auditContext.actorUserId, now, expectedVersion],
        );
        if (updated.rows.length !== 1) fail('CAS_CONFLICT', 'route version conflict');
        await audit(
          tx,
          tenantId,
          auditContext,
          `route_config.${nextStatus}`,
          `${projectId}:${routeId}:${nextVersion}`,
          now,
        );
        return {
          tenantId,
          projectId,
          routeId,
          version: nextVersion,
          status: nextStatus,
          ...definition,
          changedByUserId: auditContext.actorUserId,
          createdAt: now,
        };
      });
    } catch (error) {
      if (error instanceof SaasRouteConfigError) throw error;
      throw new SaasRouteConfigError('STORAGE_ERROR', `Route config could not be ${nextStatus}`, { cause: error });
    }
  }

  async resolve(input: ResolveRouteConfigInput): Promise<RouteConfigRecord> {
    const tenantId = text(input?.tenantId, 'tenantId');
    const projectId = text(input?.projectId, 'projectId');
    const publicModel = text(input?.publicModel, 'publicModel');
    const routeProtocol = protocol(input?.protocol);
    const routeSupplyMode = supplyMode(input?.supplyMode);
    const run = async (tx: SqlExecutor): Promise<RouteConfigRecord> => {
      // The next SELECT is a fresh READ COMMITTED snapshot after any fence wait.
      await fenceRouteConfigReader(tx, tenantId, projectId);
      const result = await tx.query<RouteVersionRow>(
        `SELECT rv.tenant_id, rv.project_id, rv.route_id, rv.version, rv.status,
                rv.public_model_id, rv.public_model_version, rv.protocol, rv.supply_mode,
                rv.target_mode, rv.upstream_id, rv.endpoint, rv.changed_by_user_id, rv.created_at
         FROM saas_route_config_heads h
         JOIN saas_route_config_versions rv
           ON rv.tenant_id = h.tenant_id
          AND rv.project_id = h.project_id
          AND rv.route_id = h.route_id
          AND rv.version = h.current_version
         JOIN saas_public_model_versions pmv
           ON pmv.public_model_id = rv.public_model_id
          AND pmv.version = rv.public_model_version
         JOIN saas_public_models pm ON pm.id = pmv.public_model_id
         WHERE h.tenant_id = $1 AND h.project_id = $2
           AND h.status = 'active' AND rv.status = 'active'
           AND pm.status = 'active' AND pmv.status = 'active'
           AND pm.alias = $3 AND rv.protocol = $4 AND rv.supply_mode = $5
         LIMIT 2`,
        [tenantId, projectId, publicModel, routeProtocol, routeSupplyMode],
      );
      if (result.rows.length === 0) fail('UNPUBLISHED', 'no active published route matches the request');
      if (result.rows.length !== 1 || !result.rows[0]) fail('AMBIGUOUS', 'route authority is ambiguous');
      return record(result.rows[0]);
    };

    try {
      if (input.executor) return await run(input.executor);
      return await this.database.transaction(run);
    } catch (error) {
      if (error instanceof SaasRouteConfigError) throw error;
      throw new SaasRouteConfigError('STORAGE_ERROR', 'Route config could not be resolved', { cause: error });
    }
  }

  resolveForRequest(input: ResolveRouteConfigInput): Promise<RouteConfigRecord> {
    return this.resolve(input);
  }
}
