import type { SqlExecutor, SqlResult } from '../db/types.js';
import type { SupplyMode } from '../gateway/contracts.js';
import type { TenantContext } from '../identity/types.js';
import {
  SaasKeyError,
  type SupplyProfileResolution,
  type SupplyProfileResolveOptions,
  type SupplyProfileResolver,
} from './types.js';

const TENANT_AUTHORIZATION_FENCE_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('saas-authz:tenant:' || $1::uuid::text, 0))";
const PROJECT_AUTHORIZATION_FENCE_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('saas-authz:project:' || $1::uuid::text || ':' || $2::uuid::text, 0))";
const MAX_MODEL_LENGTH = 200;

interface SupplyProfileEntitlementRow {
  entitlement_id: string;
  tenant_id: string;
  project_id: string;
  entitlement_status: string;
  entitlement_authz_version: unknown;
  profile_id: string;
  profile_status: string;
  supply_profile_authz_version: unknown;
  supply_mode: unknown;
  entitlement_model_scopes: unknown;
  profile_model_scopes: unknown;
  superseded_at: unknown;
}

function unavailable(): never {
  throw new SaasKeyError(503, 'KEY_SUPPLY_UNAVAILABLE', 'Supply profile entitlement resolution is unavailable');
}

function invalid(): never {
  throw new SaasKeyError(503, 'KEY_PROFILE_INVALID', 'The supply profile entitlement is invalid');
}

function positiveSafeVersion(value: unknown): number {
  const version =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) invalid();
  return version;
}

function assertMode(mode: SupplyMode): void {
  if (mode !== 'byok' && mode !== 'platform') invalid();
}

function assertContext(context: TenantContext): void {
  if (
    !context ||
    typeof context.tenantId !== 'string' ||
    context.tenantId.trim() === '' ||
    typeof context.projectId !== 'string' ||
    context.projectId.trim() === ''
  ) {
    unavailable();
  }
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) invalid();

  const models: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') invalid();
    const model = candidate.trim();
    if (model.length === 0 || model.length > MAX_MODEL_LENGTH || seen.has(model)) invalid();
    seen.add(model);
    models.push(model);
  }
  return models;
}

function intersectModels(entitlementModels: readonly string[], profileModels: readonly string[]): string[] {
  const profileSet = new Set(profileModels);
  const models = entitlementModels.filter((model) => profileSet.has(model));
  if (models.length === 0) invalid();
  return models;
}

function rowResult<Row>(result: SqlResult<Row>): Row[] {
  if (!result || !Array.isArray(result.rows)) unavailable();
  return result.rows;
}

/**
 * Reads the server-owned project entitlement and its supply profile from
 * PostgreSQL. The context is expected to have already been authorized by the
 * identity service; tenant/project values are still bound in every predicate.
 * Resolution is mode-specific. The optional executor is used by key creation
 * and rotation so tenant/project authorization fences stay held until the key
 * transaction commits.
 */
export class PostgresSupplyProfileResolver implements SupplyProfileResolver {
  constructor(private readonly database: SqlExecutor) {}

  async resolve(
    context: TenantContext,
    mode: SupplyMode,
    options: SupplyProfileResolveOptions = {},
  ): Promise<SupplyProfileResolution | null> {
    assertContext(context);
    assertMode(mode);
    if (
      options.entitlementId !== undefined &&
      (typeof options.entitlementId !== 'string' || options.entitlementId.trim() === '')
    ) {
      invalid();
    }

    const executor = options.executor ?? this.database;
    const values: unknown[] = [context.tenantId, context.projectId, mode];
    const entitlementPredicate =
      options.entitlementId === undefined
        ? ` AND e.status = 'active'`
        : ` AND e.id = $4
           AND e.status IN ('active', 'superseded')
           AND (e.status = 'active'
             OR (e.superseded_at IS NOT NULL AND e.superseded_at <= statement_timestamp()))`;
    if (options.entitlementId !== undefined) values.push(options.entitlementId);

    let result: SqlResult<SupplyProfileEntitlementRow>;
    try {
      // Only a caller-supplied transaction executor can retain xact fences
      // through its authorization decision. Separate statements ensure
      // READ COMMITTED refreshes the snapshot after any lock wait.
      if (options.executor !== undefined) {
        await executor.query(TENANT_AUTHORIZATION_FENCE_SQL, [context.tenantId]);
        await executor.query(PROJECT_AUTHORIZATION_FENCE_SQL, [context.tenantId, context.projectId]);
      }
      result = await executor.query<SupplyProfileEntitlementRow>(
        `SELECT e.id AS entitlement_id,
                e.tenant_id,
                e.project_id,
                e.status AS entitlement_status,
                e.authz_version AS entitlement_authz_version,
                p.id AS profile_id,
                p.status AS profile_status,
                p.authz_version AS supply_profile_authz_version,
                p.supply_mode,
                e.model_scopes AS entitlement_model_scopes,
                p.model_scopes AS profile_model_scopes,
                e.superseded_at
         FROM saas_project_entitlements AS e
         JOIN saas_supply_profiles AS p
           ON p.tenant_id = e.tenant_id
          AND p.id = e.supply_profile_id
          AND p.supply_mode = e.supply_mode
         WHERE e.tenant_id = $1
           AND e.project_id = $2
           AND e.supply_mode = $3
           AND e.effective_at <= statement_timestamp()
           AND (e.expires_at IS NULL OR e.expires_at > statement_timestamp())
           AND p.status = 'active'${entitlementPredicate}
         LIMIT 2`,
        values,
      );
    } catch {
      // Missing tables, unavailable PostgreSQL, and other schema/storage
      // failures must never turn into an entitlement or an allow decision.
      unavailable();
    }

    const rows = rowResult(result);
    if (rows.length === 0) return null;
    if (rows.length !== 1) invalid();

    const row = rows[0];
    if (
      !row ||
      typeof row.entitlement_id !== 'string' ||
      row.entitlement_id.trim() === '' ||
      row.tenant_id !== context.tenantId ||
      row.project_id !== context.projectId ||
      (row.entitlement_status !== 'active' &&
        (options.entitlementId === undefined || row.entitlement_status !== 'superseded')) ||
      row.profile_status !== 'active' ||
      typeof row.profile_id !== 'string' ||
      row.profile_id.trim() === '' ||
      row.supply_mode !== mode
    ) {
      invalid();
    }

    const entitlementAuthzVersion = positiveSafeVersion(row.entitlement_authz_version);
    const supplyProfileAuthzVersion = positiveSafeVersion(row.supply_profile_authz_version);
    if (row.entitlement_status === 'superseded' && row.superseded_at === null) invalid();

    const allowedModels = intersectModels(
      normalizeModels(row.entitlement_model_scopes),
      normalizeModels(row.profile_model_scopes),
    );
    return {
      entitlementId: row.entitlement_id.trim(),
      profileId: row.profile_id.trim(),
      mode,
      allowedModels,
      entitlementAuthzVersion,
      supplyProfileAuthzVersion,
      modelScopeVersion: Math.max(entitlementAuthzVersion, supplyProfileAuthzVersion),
    };
  }
}

export { PostgresSupplyProfileResolver as PostgresSupplyProfileEntitlementResolver };

export function createPostgresSupplyProfileResolver(database: SqlExecutor): SupplyProfileResolver {
  return new PostgresSupplyProfileResolver(database);
}
