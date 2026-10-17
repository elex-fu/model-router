import type { SqlExecutor } from '../db/index.js';
import type {
  CompositeModelOwnershipResolution,
  CompositeModelRoute,
  CompositeRouteEndpoint,
} from './composite-route-resolver.js';
import {
  compositeRouteEndpointFromProtocol,
  normalizeCompositeRouteEndpoint,
  normalizeCompositeRouteMatchType,
} from './composite-route-resolver.js';
import type { GatewayProtocol } from './contracts.js';

/**
 * Batch 4 §4.4 composite model routing — the gateway-side database reads
 * feeding the pure three-level resolver (composite-route-resolver.ts). Every
 * query here runs inside the caller's transaction (REPEATABLE READ at
 * preparation time), reads only gateway-granted tables (migration 121 grants
 * mirror), and produces plain facts; the decision itself stays pure.
 */

/** The billing group resolved for a request, plus its composite marker. */
export interface CompositeBillingGroupResolution {
  readonly groupId: string;
  readonly composite: boolean;
}

/**
 * Resolves the effective billing group for a proxy key (key binding, then the
 * tenant default, then the seeded 'default' group — the F2 BILLING_GROUP_SQL
 * resolution order) and its composite marker. A missing or ambiguous row is
 * a storage failure (thrown), never a silent non-composite default.
 */
export async function resolveCompositeBillingGroup(
  executor: SqlExecutor,
  caller: { readonly tenantId: string; readonly projectId: string; readonly proxyKeyId: string },
): Promise<CompositeBillingGroupResolution> {
  const result = await executor.query<Record<string, unknown>>(
    `/* composite-route-store:billing-group */
     SELECT g.id, g.composite
       FROM saas_api_keys k
       JOIN saas_tenants t ON t.id = k.tenant_id
       JOIN saas_billing_groups g ON g.id = COALESCE(k.billing_group_id, t.default_billing_group_id, 'default')
      WHERE k.tenant_id = $1 AND k.project_id = $2 AND k.id = $3
      LIMIT 2`,
    [caller.tenantId, caller.projectId, caller.proxyKeyId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === null || typeof row.id !== 'string' || row.id === '') {
    throw new Error('composite billing group authority is unavailable');
  }
  return { groupId: row.id, composite: row.composite === true };
}

/** Loads the enabled composite routes of one group in deterministic id order. */
export async function loadEnabledCompositeRoutes(
  executor: SqlExecutor,
  groupId: string,
): Promise<readonly CompositeModelRoute[]> {
  const result = await executor.query<Record<string, unknown>>(
    `/* composite-route-store:enabled-routes */
     SELECT id, group_id, public_model, match_type, target_platform, upstream_model,
            endpoint, priority, enabled, notes
       FROM saas_composite_model_routes
      WHERE group_id = $1 AND enabled = true
      ORDER BY id ASC`,
    [groupId],
  );
  const routes: CompositeModelRoute[] = [];
  for (const row of result.rows) {
    if (row === null || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id : String(row.id);
    const publicModel = typeof row.public_model === 'string' ? row.public_model : '';
    const targetPlatform = typeof row.target_platform === 'string' ? row.target_platform : '';
    if (id === '' || publicModel === '' || targetPlatform === '') continue;
    routes.push({
      id,
      groupId: typeof row.group_id === 'string' ? row.group_id : groupId,
      publicModel,
      matchType: normalizeCompositeRouteMatchType(typeof row.match_type === 'string' ? row.match_type : 'exact'),
      targetPlatform,
      upstreamModel: typeof row.upstream_model === 'string' ? row.upstream_model : '',
      endpoint: normalizeCompositeRouteEndpoint(typeof row.endpoint === 'string' ? row.endpoint : 'any'),
      priority: typeof row.priority === 'number' && Number.isSafeInteger(row.priority) ? row.priority : 100,
      enabled: true,
      notes: typeof row.notes === 'string' ? row.notes : '',
    });
  }
  return routes;
}

/**
 * Level 2 — the account model-ownership catalog: the concrete platforms whose
 * group-pool accounts expose the requested model in their capability catalog.
 * More than one platform is ambiguous (the resolver fails closed); zero is
 * not-matched (the resolver falls through to the detector).
 */
export async function resolveCompositeModelOwnership(
  executor: SqlExecutor,
  groupId: string,
  model: string,
): Promise<CompositeModelOwnershipResolution> {
  const result = await executor.query<Record<string, unknown>>(
    `/* composite-route-store:model-ownership */
     SELECT DISTINCT account.provider_id
       FROM saas_billing_group_account_pools pool
       JOIN saas_platform_provider_accounts account
         ON account.id = pool.account_id
        AND account.status = 'active' AND account.validation_state = 'verified'
       JOIN saas_platform_provider_account_capabilities capability
         ON capability.account_id = account.id
        AND capability.provider_id = account.provider_id
        AND capability.product_id = account.product_id
        AND capability.model = $2
      WHERE pool.group_id = $1`,
    [groupId, model],
  );
  const platforms: string[] = [];
  for (const row of result.rows) {
    if (row === null || typeof row !== 'object') continue;
    const providerId = row.provider_id;
    if (typeof providerId === 'string' && providerId !== '' && !platforms.includes(providerId)) {
      platforms.push(providerId);
    }
  }
  if (platforms.length > 1) return { outcome: 'ambiguous' };
  if (platforms.length === 1) return { outcome: 'matched', targetPlatform: platforms[0] as string };
  return { outcome: 'not-matched' };
}

/** The serving (product, endpoint) derived for one composite target platform. */
export interface CompositeTargetCapability {
  readonly productId: string;
  readonly endpoint: string;
}

/**
 * Derives the serving product and endpoint for a resolved composite target:
 * the DISTINCT (product, endpoint) pairs of the provider's supported and
 * verified capabilities for the upstream model under the CLIENT protocol (the
 * cn-providers dual-protocol registration pattern — a model is servable under
 * a client protocol only when the provider registered a capability row for
 * it). Exactly one pair resolves; zero or multiple fail closed ('none' /
 * 'ambiguous') — the admin resolves the ambiguity with an explicit route or
 * additional capability registration, never a runtime guess.
 */
export async function resolveCompositeTargetCapability(
  executor: SqlExecutor,
  targetPlatform: string,
  upstreamModel: string,
  protocol: GatewayProtocol,
): Promise<CompositeTargetCapability | 'none' | 'ambiguous'> {
  const result = await executor.query<Record<string, unknown>>(
    `/* composite-route-store:target-capability */
     SELECT DISTINCT product_id, endpoint
       FROM saas_provider_capabilities
      WHERE provider_id = $1 AND model = $2 AND protocol = $3
        AND support_level = 'supported' AND validation_state = 'verified'
      ORDER BY product_id ASC, endpoint ASC`,
    [targetPlatform, upstreamModel, protocol],
  );
  const pairs: CompositeTargetCapability[] = [];
  for (const row of result.rows) {
    if (row === null || typeof row !== 'object') continue;
    const productId = row.product_id;
    const endpoint = row.endpoint;
    if (typeof productId === 'string' && productId !== '' && typeof endpoint === 'string' && endpoint !== '') {
      pairs.push({ productId, endpoint });
    }
  }
  if (pairs.length === 1) return pairs[0] as CompositeTargetCapability;
  if (pairs.length === 0) return 'none';
  return 'ambiguous';
}

/** Re-exported so composite callers bind one endpoint-family mapping. */
export const compositeEndpointForProtocol = compositeRouteEndpointFromProtocol;
export type { CompositeRouteEndpoint };
