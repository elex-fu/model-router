import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import {
  COMPOSITE_TARGET_PLATFORMS,
  type CompositeModelOwnershipResolution,
  type CompositeModelRoute,
  type CompositeRouteDecision,
  type CompositeRouteEndpoint,
  isConcreteCompositeTargetPlatform,
  normalizeCompositeRouteEndpoint,
  normalizeCompositeRouteMatchType,
  resolveCompositeRoute,
} from '../../gateway/composite-route-resolver.js';
import { loadEnabledCompositeRoutes, resolveCompositeModelOwnership } from '../../gateway/composite-route-store.js';

type Row = Record<string, unknown>;

/**
 * Batch 4 §4.4 composite model routing — the control-plane registry service
 * (sub2api CompositeModelRouteRepository + the admin preview). The table is
 * migration 121's saas_composite_model_routes; every write is plain CRUD
 * (runtime resolution reads live inside each preparation transaction, so no
 * authz_version fence is needed — unlike pool membership there is no cached
 * authorization snapshot of the registry). The preview runs the exact
 * three-level resolution the gateway performs (registry → group-account
 * model ownership → built-in detector) minus the serving-capability lookup.
 */

export type SaasCompositeModelRoutesErrorCode =
  | 'INVALID_INPUT'
  | 'ROUTE_NOT_FOUND'
  | 'ROUTE_CONFLICT'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_NOT_COMPOSITE'
  | 'STORAGE_ERROR';

const ERROR_STATUS: Readonly<Record<SaasCompositeModelRoutesErrorCode, number>> = Object.freeze({
  INVALID_INPUT: 400,
  ROUTE_NOT_FOUND: 404,
  ROUTE_CONFLICT: 409,
  GROUP_NOT_FOUND: 404,
  GROUP_NOT_COMPOSITE: 409,
  STORAGE_ERROR: 503,
});

export class SaasCompositeModelRoutesError extends Error {
  constructor(readonly code: SaasCompositeModelRoutesErrorCode) {
    super(`composite model routes: ${code}`);
    this.name = 'SaasCompositeModelRoutesError';
  }
}

function fail(code: SaasCompositeModelRoutesErrorCode): never {
  throw new SaasCompositeModelRoutesError(code);
}

export interface CompositeModelRouteUpsertInput {
  readonly groupId: string;
  readonly publicModel: string;
  readonly matchType: 'exact' | 'prefix';
  readonly targetPlatform: string;
  readonly upstreamModel: string;
  readonly endpoint: CompositeRouteEndpoint;
  readonly priority: number;
  readonly enabled: boolean;
  readonly notes: string;
}

export interface CompositeRoutePreviewResult {
  readonly decision: CompositeRouteDecision;
  /** The number of enabled registry routes considered (Level 1 facts). */
  readonly routeCount: number;
}

const ROUTE_COLUMNS = `id, group_id, public_model, match_type, target_platform, upstream_model,
       endpoint, priority, enabled, notes, created_at, updated_at`;

function mapRouteRow(row: Row): CompositeModelRoute {
  const id = row.id;
  const groupId = row.group_id;
  const publicModel = row.public_model;
  const targetPlatform = row.target_platform;
  if (
    (typeof id !== 'string' && typeof id !== 'number') ||
    typeof groupId !== 'string' ||
    typeof publicModel !== 'string' ||
    typeof targetPlatform !== 'string'
  ) {
    fail('STORAGE_ERROR');
  }
  const priority = row.priority;
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) fail('STORAGE_ERROR');
  return {
    id: String(id),
    groupId,
    publicModel,
    matchType: normalizeCompositeRouteMatchType(typeof row.match_type === 'string' ? row.match_type : 'exact'),
    targetPlatform,
    upstreamModel: typeof row.upstream_model === 'string' ? row.upstream_model : '',
    endpoint: normalizeCompositeRouteEndpoint(typeof row.endpoint === 'string' ? row.endpoint : 'any'),
    priority,
    enabled: row.enabled === true,
    notes: typeof row.notes === 'string' ? row.notes : '',
  };
}

function normalizeUpsert(input: CompositeModelRouteUpsertInput): CompositeModelRouteUpsertInput {
  if (input === null || typeof input !== 'object') fail('INVALID_INPUT');
  for (const [value, max] of [
    [input.groupId, 128],
    [input.publicModel, 200],
    [input.upstreamModel, 200],
  ] as const) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > max ||
      value.trim() !== value ||
      [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
    ) {
      fail('INVALID_INPUT');
    }
  }
  const matchType = normalizeCompositeRouteMatchType(input.matchType);
  const endpoint = normalizeCompositeRouteEndpoint(input.endpoint);
  const targetPlatform = input.targetPlatform.trim();
  if (!isConcreteCompositeTargetPlatform(targetPlatform)) fail('INVALID_INPUT');
  if (
    typeof input.priority !== 'number' ||
    !Number.isSafeInteger(input.priority) ||
    input.priority < 0 ||
    input.priority > 100_000
  ) {
    fail('INVALID_INPUT');
  }
  if (typeof input.enabled !== 'boolean') fail('INVALID_INPUT');
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
  if (notes !== (input.notes ?? '')) fail('INVALID_INPUT');
  return {
    groupId: input.groupId,
    publicModel: input.publicModel,
    matchType,
    targetPlatform,
    upstreamModel: input.upstreamModel,
    endpoint,
    priority: input.priority,
    enabled: input.enabled,
    notes,
  };
}

export class SaasCompositeModelRoutesService {
  constructor(private readonly database: SaasDatabase) {}

  async listRoutes(
    groupId: string,
    options: { readonly includeDisabled?: boolean } = {},
  ): Promise<readonly CompositeModelRoute[]> {
    const executor: SqlExecutor = this.database;
    const result = await executor.query<Row>(
      options.includeDisabled === true
        ? `/* composite-model-routes:list-all */
           SELECT ${ROUTE_COLUMNS} FROM saas_composite_model_routes
            WHERE group_id = $1 ORDER BY id ASC`
        : `/* composite-model-routes:list-enabled */
           SELECT ${ROUTE_COLUMNS} FROM saas_composite_model_routes
            WHERE group_id = $1 AND enabled = true ORDER BY id ASC`,
      [groupId],
    );
    return result.rows.map(mapRouteRow);
  }

  async createRoute(input: CompositeModelRouteUpsertInput): Promise<CompositeModelRoute> {
    const normalized = normalizeUpsert(input);
    return this.database.transaction(async (tx) => {
      await this.requireCompositeGroup(tx, normalized.groupId);
      let created: CompositeModelRoute | null = null;
      try {
        const result = await tx.query<Row>(
          `INSERT INTO saas_composite_model_routes
             (group_id, public_model, match_type, target_platform, upstream_model,
              endpoint, priority, enabled, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (group_id, public_model, match_type, endpoint) DO NOTHING
           RETURNING ${ROUTE_COLUMNS}`,
          [
            normalized.groupId,
            normalized.publicModel,
            normalized.matchType,
            normalized.targetPlatform,
            normalized.upstreamModel,
            normalized.endpoint,
            normalized.priority,
            normalized.enabled,
            normalized.notes,
          ],
        );
        created = result.rows[0] ? mapRouteRow(result.rows[0]) : null;
      } catch (error) {
        if (error instanceof SaasCompositeModelRoutesError) throw error;
        fail('STORAGE_ERROR');
      }
      if (created === null) fail('ROUTE_CONFLICT');
      return created;
    });
  }

  async updateRoute(routeId: string, input: CompositeModelRouteUpsertInput): Promise<CompositeModelRoute> {
    if (typeof routeId !== 'string' || routeId === '' || !/^(0|[1-9][0-9]*)$/.test(routeId)) fail('INVALID_INPUT');
    const normalized = normalizeUpsert(input);
    return this.database.transaction(async (tx) => {
      await this.requireCompositeGroup(tx, normalized.groupId);
      let updated: CompositeModelRoute | null = null;
      try {
        const result = await tx.query<Row>(
          `UPDATE saas_composite_model_routes SET
             public_model = $2, match_type = $3, target_platform = $4, upstream_model = $5,
             endpoint = $6, priority = $7, enabled = $8, notes = $9, updated_at = now()
           WHERE id = $1::bigint AND group_id = $10
           RETURNING ${ROUTE_COLUMNS}`,
          [
            routeId,
            normalized.publicModel,
            normalized.matchType,
            normalized.targetPlatform,
            normalized.upstreamModel,
            normalized.endpoint,
            normalized.priority,
            normalized.enabled,
            normalized.notes,
            normalized.groupId,
          ],
        );
        updated = result.rows[0] ? mapRouteRow(result.rows[0]) : null;
      } catch (error) {
        if (error instanceof SaasCompositeModelRoutesError) throw error;
        fail('STORAGE_ERROR');
      }
      if (updated === null) fail('ROUTE_NOT_FOUND');
      return updated;
    });
  }

  async deleteRoute(routeId: string): Promise<void> {
    if (typeof routeId !== 'string' || routeId === '' || !/^(0|[1-9][0-9]*)$/.test(routeId)) fail('INVALID_INPUT');
    const result = await this.database.query<Row>(`DELETE FROM saas_composite_model_routes WHERE id = $1::bigint`, [
      routeId,
    ]);
    if ((result.rowCount ?? 0) === 0) fail('ROUTE_NOT_FOUND');
  }

  /**
   * The admin dry-run: how the gateway would route one model/endpoint pair in
   * one composite group. Runs the exact three-level resolution — the enabled
   * registry, then the group accounts' model-catalog ownership, then the
   * built-in prefix detector — and returns the decision with its matched
   * level. A fail-closed decision (matched false) is a 200 with the reason:
   * the preview reports what the gateway would do, and the gateway would
   * reject the request client-visibly.
   */
  async previewRoute(input: {
    readonly groupId: string;
    readonly model: string;
    readonly endpoint: string;
  }): Promise<CompositeRoutePreviewResult> {
    if (typeof input.groupId !== 'string' || input.groupId === '') fail('INVALID_INPUT');
    if (typeof input.model !== 'string' || input.model.trim() === '' || input.model.length > 200) {
      fail('INVALID_INPUT');
    }
    if (typeof input.endpoint !== 'string') fail('INVALID_INPUT');
    const executor: SqlExecutor = this.database;
    await this.requireCompositeGroup(executor, input.groupId);
    const routes = await loadEnabledCompositeRoutes(executor, input.groupId);
    let ownership: CompositeModelOwnershipResolution;
    try {
      ownership = await resolveCompositeModelOwnership(executor, input.groupId, input.model.trim());
    } catch {
      ownership = { outcome: 'unavailable' } as const;
    }
    const decision = resolveCompositeRoute({
      groupId: input.groupId,
      model: input.model.trim(),
      endpoint: input.endpoint,
      routes,
      ownership,
    });
    return { decision, routeCount: routes.length };
  }

  private async requireCompositeGroup(executor: SqlExecutor, groupId: string): Promise<void> {
    const result = await executor.query<Row>(`SELECT composite FROM saas_billing_groups WHERE id = $1 LIMIT 2`, [
      groupId,
    ]);
    const row = result.rows[0];
    if (!row) fail('GROUP_NOT_FOUND');
    if (row.composite !== true) fail('GROUP_NOT_COMPOSITE');
  }
}

export function compositeModelRoutesErrorStatus(error: SaasCompositeModelRoutesError): {
  readonly status: number;
  readonly code: string;
} {
  return {
    status: ERROR_STATUS[error.code],
    code: `COMPOSITE_ROUTE_${error.code}`,
  };
}

export const COMPOSITE_ROUTE_TARGET_PLATFORMS = COMPOSITE_TARGET_PLATFORMS;
