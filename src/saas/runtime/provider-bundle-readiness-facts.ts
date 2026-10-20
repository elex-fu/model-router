/**
 * Provider-bundle capability readiness facts (T01-b, core-plan §6.3).
 *
 * `gateway-capability-readiness.ts` is a pure projection over facts supplied
 * by the composition root. This module is the standard-deployment collector:
 * it reads the four catalog/price/credential observations from PostgreSQL and
 * combines them with the process-local dispatch, storage, sidecar and live
 * verification facts. Wiring `managed-saas.ts` only has to call
 * `collectGatewayCapabilityFacts` and pass the result to
 * `assertGatewayCapabilityAssembly`.
 *
 * The SQL is deliberately conservative:
 * - catalog scopes use the latest capability version per
 *   (provider, product, model, endpoint), so a superseding unsupported row
 *   cannot be masked by an older supported one;
 * - catalog scopes and supplier prices must belong to an active product;
 * - supplier prices must also target an active public model and version, and
 *   be effective now and unexpired;
 * - credentials must be active + verified on both the platform account and
 *   its current credential, which is the same eligibility the runtime
 *   credential resolver enforces.
 *
 * Only ids and endpoint scopes leave this module; credential material,
 * account names and provider responses never do.
 */

import type { SqlExecutor } from '../db/types.js';
import type {
  GatewayCapabilityDispatchFacts,
  GatewayCapabilityFacts,
  GatewayCapabilityVerificationLevel,
  ProviderBundleReadinessFacts,
} from './gateway-capability-readiness.js';

export interface GatewayCapabilityDeploymentFacts {
  /** Transport faces mounted by this composition root. */
  readonly dispatch: GatewayCapabilityDispatchFacts;
  readonly mediaStorages: readonly string[];
  readonly tlsFingerprintProfiles: readonly string[];
  /** Live verification records keyed by capability id. */
  readonly verification: Readonly<Record<string, GatewayCapabilityVerificationLevel>>;
}

interface ProviderRow {
  readonly provider_id?: unknown;
}

interface ProviderScopeRow {
  readonly provider_id?: unknown;
  readonly endpoint?: unknown;
}

const CATALOG_PROVIDER_SQL = `
  SELECT DISTINCT provider_id
    FROM saas_provider_products
   WHERE status = 'active'
   ORDER BY provider_id
`;

const CATALOG_ENDPOINT_SQL = `
  SELECT DISTINCT latest.provider_id, latest.endpoint
    FROM (
      SELECT DISTINCT ON (capability.provider_id, capability.product_id, capability.model, capability.endpoint)
             capability.provider_id,
             capability.endpoint,
             capability.support_level,
             capability.validation_state
        FROM saas_provider_capabilities AS capability
        JOIN saas_provider_products AS product
          ON product.provider_id = capability.provider_id
         AND product.product_id = capability.product_id
         AND product.status = 'active'
       ORDER BY capability.provider_id, capability.product_id, capability.model, capability.endpoint, capability.version DESC
    ) AS latest
   WHERE latest.support_level = 'supported'
     AND latest.validation_state = 'verified'
   ORDER BY latest.provider_id, latest.endpoint
`;

const PRICED_ENDPOINT_SQL = `
  SELECT DISTINCT cost.provider_id, cost.endpoint
    FROM saas_supplier_cost_versions AS cost
    JOIN saas_provider_products AS product
      ON product.provider_id = cost.provider_id
     AND product.product_id = cost.product_id
     AND product.status = 'active'
    JOIN saas_public_models AS public_model
      ON public_model.id = cost.public_model_id
     AND public_model.status = 'active'
    JOIN saas_public_model_versions AS model
      ON model.public_model_id = cost.public_model_id
     AND model.version = cost.public_model_version
     AND model.status = 'active'
   WHERE cost.effective_at <= clock_timestamp()
     AND (cost.expires_at IS NULL OR cost.expires_at > clock_timestamp())
   ORDER BY cost.provider_id, cost.endpoint
`;

const VERIFIED_CREDENTIAL_PROVIDER_SQL = `
  SELECT DISTINCT account.provider_id
    FROM saas_platform_provider_accounts AS account
    JOIN saas_platform_provider_credentials AS credential
      ON credential.account_id = account.id
     AND credential.provider_id = account.provider_id
     AND credential.product_id = account.product_id
   WHERE account.status = 'active'
     AND account.validation_state = 'verified'
     AND credential.status = 'active'
     AND credential.validation_state = 'verified'
     AND credential.current_version IS NOT NULL
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
   ORDER BY account.provider_id
`;

/**
 * Bounded identifier check. Readiness ids are catalog/provider/endpoint
 * tokens; whitespace, controls and empty values are malformed observations
 * and are skipped fail-closed rather than trusted by the projection.
 */
function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value)
    ? value
    : null;
}

function sortedProviderIds(rows: readonly ProviderRow[]): readonly string[] {
  const providers = new Set<string>();
  for (const row of rows) {
    const providerId = identifier(row.provider_id);
    if (providerId !== null) providers.add(providerId);
  }
  return Object.freeze([...providers].sort());
}

function groupedScopes(rows: readonly ProviderScopeRow[]): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const providerId = identifier(row.provider_id);
    const endpoint = identifier(row.endpoint);
    if (providerId === null || endpoint === null) continue;
    let scopes = grouped.get(providerId);
    if (scopes === undefined) {
      scopes = new Set<string>();
      grouped.set(providerId, scopes);
    }
    scopes.add(endpoint);
  }
  const frozen = new Map<string, readonly string[]>();
  for (const providerId of [...grouped.keys()].sort()) {
    frozen.set(providerId, Object.freeze([...(grouped.get(providerId) ?? [])].sort()));
  }
  return frozen;
}

/**
 * Reads the database-owned readiness observations. The returned maps are
 * read-only seams; callers must not mutate the arrays they contain.
 */
export async function collectProviderBundleReadinessFacts(
  database: SqlExecutor,
): Promise<ProviderBundleReadinessFacts> {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('collectProviderBundleReadinessFacts requires a SQL executor');
  }

  const [providers, catalogScopes, pricedScopes, credentials] = await Promise.all([
    database.query<ProviderRow>(CATALOG_PROVIDER_SQL),
    database.query<ProviderScopeRow>(CATALOG_ENDPOINT_SQL),
    database.query<ProviderScopeRow>(PRICED_ENDPOINT_SQL),
    database.query<ProviderRow>(VERIFIED_CREDENTIAL_PROVIDER_SQL),
  ]);

  return Object.freeze({
    catalogProviderIds: sortedProviderIds(providers.rows),
    catalogEndpointScopesByProvider: groupedScopes(catalogScopes.rows),
    pricedEndpointScopesByProvider: groupedScopes(pricedScopes.rows),
    credentialProviderIds: sortedProviderIds(credentials.rows),
  });
}

/**
 * Standard-deployment fact collection: PostgreSQL-owned observations plus the
 * composition root's process-local facts. The deployment facts are copied and
 * frozen so later caller mutation cannot change an assembly decision that has
 * already been asserted.
 */
export async function collectGatewayCapabilityFacts(
  database: SqlExecutor,
  deployment: GatewayCapabilityDeploymentFacts,
): Promise<GatewayCapabilityFacts> {
  if (!deployment || typeof deployment !== 'object') {
    throw new TypeError('collectGatewayCapabilityFacts requires deployment facts');
  }
  const bundles = await collectProviderBundleReadinessFacts(database);
  return Object.freeze({
    dispatch: Object.freeze({
      generic: deployment.dispatch.generic === true,
      routedEndpointScopes: Object.freeze([...deployment.dispatch.routedEndpointScopes]),
    }),
    bundles,
    mediaStorages: Object.freeze([...deployment.mediaStorages]),
    tlsFingerprintProfiles: Object.freeze([...deployment.tlsFingerprintProfiles]),
    verification: Object.freeze({ ...deployment.verification }),
  });
}

/** Exported for tests that pin the exact SQL policy. */
export const PROVIDER_BUNDLE_READINESS_SQL = Object.freeze({
  catalogProviders: CATALOG_PROVIDER_SQL,
  catalogEndpoints: CATALOG_ENDPOINT_SQL,
  pricedEndpoints: PRICED_ENDPOINT_SQL,
  verifiedCredentialProviders: VERIFIED_CREDENTIAL_PROVIDER_SQL,
});
