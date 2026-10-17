import type { SaasBillingGroupsService } from '../../billing/groups/service.js';
import type { BillingGroupRecord } from '../../billing/groups/types.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { isSaasPricingError } from '../../pricing/errors.js';
import type { SaasPricingService } from '../../pricing/service.js';
import { resolveCompositeBillingGroup } from '../composite-route-store.js';
import type {
  ModelPlazaFacts,
  ModelPlazaFactsPort,
  ModelPlazaPriceIdentity,
  ModelPlazaSnapshot,
  ModelPlazaTarget,
} from './types.js';

/**
 * PostgreSQL facts port: every plaza read runs inside one database
 * transaction, and the price resolutions ride the SAME executor — the exact
 * `resolveCustomerPriceVersion` chain the admission guard uses, so a render is
 * a coherent point-in-time snapshot of the same rows admission would lock.
 *
 * All tables here are gateway-role granted (the 109/121/122 read manifests):
 * billing groups, group account pools, platform accounts + capabilities,
 * public models/versions, provider capabilities/rights, customer price
 * versions, tenants, memberships, api keys.
 */

const MAX_TARGETS = 1000;
const MAX_PRICE_IDENTITIES = 4000;
const MAX_POOL_CAPABILITY_ROWS = 20000;
const MAX_SESSION_GROUPS = 1000;

const CAPABILITY_SEPARATOR = '\u0000';

export function capabilityKey(providerId: string, productId: string, model: string, endpoint: string): string {
  return `${providerId}${CAPABILITY_SEPARATOR}${productId}${CAPABILITY_SEPARATOR}${model}${CAPABILITY_SEPARATOR}${endpoint}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function optionalText(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function optionalCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface PoolCapabilityRow {
  readonly group_id?: unknown;
  readonly provider_id?: unknown;
  readonly product_id?: unknown;
  readonly model?: unknown;
  readonly endpoint?: unknown;
}

interface TargetRow {
  readonly public_model_id?: unknown;
  readonly public_model_version?: unknown;
  readonly alias?: unknown;
  readonly display_name?: unknown;
  readonly provider_id?: unknown;
  readonly product_id?: unknown;
  readonly resolved_model?: unknown;
  readonly protocol?: unknown;
  readonly endpoint?: unknown;
}

interface PriceIdentityRow {
  readonly public_model_id?: unknown;
  readonly public_model_version?: unknown;
  readonly provider_id?: unknown;
  readonly product_id?: unknown;
  readonly protocol?: unknown;
  readonly endpoint?: unknown;
  readonly currency?: unknown;
}

type BillingGroupsListPort = Pick<SaasBillingGroupsService, 'listBillingGroups'>;

async function readGroups(
  groups: BillingGroupsListPort,
  executor: SqlExecutor,
): Promise<readonly BillingGroupRecord[]> {
  const all = await groups.listBillingGroups({ executor });
  return all.filter((group) => group.status === 'active');
}

async function readPoolCapabilities(executor: SqlExecutor): Promise<{
  readonly groupCapabilities: ReadonlyMap<string, ReadonlySet<string>>;
  readonly groupPlatforms: ReadonlyMap<string, ReadonlySet<string>>;
}> {
  const result = await executor.query<PoolCapabilityRow>(
    `/* model-plaza:pool-capabilities */
     SELECT pool.group_id, account.provider_id, account.product_id, capability.model, capability.endpoint
       FROM saas_billing_group_account_pools pool
       JOIN saas_platform_provider_accounts account
         ON account.id = pool.account_id
        AND account.supply_mode = 'platform'
        AND account.status = 'active'
        AND account.validation_state = 'verified'
       JOIN saas_platform_provider_account_capabilities capability
         ON capability.account_id = account.id
        AND capability.provider_id = account.provider_id
        AND capability.product_id = account.product_id
      LIMIT ${MAX_POOL_CAPABILITY_ROWS}`,
  );
  const capabilities = new Map<string, Set<string>>();
  const platforms = new Map<string, Set<string>>();
  const pooledGroupIds = new Set<string>();
  for (const row of result.rows) {
    const groupId = optionalText(row.group_id);
    const providerId = optionalText(row.provider_id);
    const productId = optionalText(row.product_id);
    const model = optionalText(row.model);
    const endpoint = optionalText(row.endpoint);
    if (groupId === null || providerId === null || productId === null || model === null || endpoint === null) continue;
    pooledGroupIds.add(groupId);
    let groupCaps = capabilities.get(groupId);
    if (groupCaps === undefined) {
      groupCaps = new Set<string>();
      capabilities.set(groupId, groupCaps);
    }
    groupCaps.add(capabilityKey(providerId, productId, model, endpoint));
    let groupPlatforms = platforms.get(groupId);
    if (groupPlatforms === undefined) {
      groupPlatforms = new Set<string>();
      platforms.set(groupId, groupPlatforms);
    }
    groupPlatforms.add(providerId);
  }
  return {
    groupCapabilities: capabilities,
    groupPlatforms: platforms,
  };
}

async function readGlobalCapabilities(executor: SqlExecutor): Promise<{
  readonly globalCapabilities: ReadonlySet<string>;
  readonly globalPlatforms: ReadonlySet<string>;
}> {
  const result = await executor.query<PoolCapabilityRow>(
    `/* model-plaza:global-capabilities */
     SELECT DISTINCT account.provider_id, account.product_id, capability.model, capability.endpoint
       FROM saas_platform_provider_accounts account
       JOIN saas_platform_provider_account_capabilities capability
         ON capability.account_id = account.id
        AND capability.provider_id = account.provider_id
        AND capability.product_id = account.product_id
      WHERE account.supply_mode = 'platform'
        AND account.status = 'active'
        AND account.validation_state = 'verified'
      LIMIT ${MAX_POOL_CAPABILITY_ROWS}`,
  );
  const globalCapabilities = new Set<string>();
  const globalPlatforms = new Set<string>();
  for (const row of result.rows) {
    const providerId = optionalText(row.provider_id);
    const productId = optionalText(row.product_id);
    const model = optionalText(row.model);
    const endpoint = optionalText(row.endpoint);
    if (providerId === null || productId === null || model === null || endpoint === null) continue;
    globalCapabilities.add(capabilityKey(providerId, productId, model, endpoint));
    globalPlatforms.add(providerId);
  }
  return { globalCapabilities, globalPlatforms };
}

/**
 * Nominal catalog pricing targets — the customer-kind platformPricingTargetSql
 * semantics (active public model + version + product, latest capability row
 * supported/limited + verified, active platform rights covering the model and
 * endpoint). Re-implemented here because the pricing service's list method
 * does not accept an executor (pricing internals are call-only for the plaza;
 * the authoritative per-identity price still comes from
 * resolveCustomerPriceVersion on the same executor).
 */
async function readTargets(executor: SqlExecutor, at: string): Promise<readonly ModelPlazaTarget[]> {
  const result = await executor.query<TargetRow>(
    `/* model-plaza:targets */
     WITH latest_capability AS (
       SELECT DISTINCT ON (provider_id, product_id, model, endpoint)
              provider_id, product_id, model, endpoint, protocol, version,
              support_level, validation_state
         FROM saas_provider_capabilities
        ORDER BY provider_id, product_id, model, endpoint, version DESC
     )
     SELECT DISTINCT ON (model_version.public_model_id, model_version.version, capability.endpoint, capability.protocol)
            model_version.public_model_id, model_version.version AS public_model_version,
            public_model.alias, public_model.display_name,
            model_version.provider_id, model_version.product_id,
            model_version.model AS resolved_model, capability.protocol, capability.endpoint
       FROM saas_public_model_versions AS model_version
       JOIN saas_public_models AS public_model ON public_model.id = model_version.public_model_id
       JOIN saas_provider_products AS product
         ON product.provider_id = model_version.provider_id AND product.product_id = model_version.product_id
       JOIN latest_capability AS capability
         ON capability.provider_id = model_version.provider_id
        AND capability.product_id = model_version.product_id
        AND capability.model = model_version.model
        AND model_version.endpoint_scope @> ARRAY[capability.endpoint]::text[]
      WHERE public_model.status = 'active'
        AND model_version.status = 'active'
        AND product.status = 'active'
        AND capability.support_level IN ('supported', 'limited')
        AND capability.validation_state = 'verified'
        AND EXISTS (
          SELECT 1
            FROM saas_provider_rights AS rights
           WHERE rights.provider_id = model_version.provider_id
             AND rights.product_id = model_version.product_id
             AND rights.supply_mode = 'platform'
             AND rights.status = 'active'
             AND rights.effective_at <= $1::timestamptz
             AND (rights.expires_at IS NULL OR rights.expires_at > $1::timestamptz)
             AND rights.model_scope @> ARRAY[model_version.model]::text[]
             AND rights.endpoint_scope @> ARRAY[capability.endpoint]::text[]
        )
      ORDER BY model_version.public_model_id, model_version.version,
               capability.endpoint, capability.protocol, capability.version DESC
      LIMIT ${MAX_TARGETS}`,
    [at],
  );
  return result.rows.map((row) => ({
    publicModelId: text(row.public_model_id),
    publicModelVersion: optionalCount(row.public_model_version) ?? 0,
    alias: text(row.alias),
    displayName: text(row.display_name),
    providerId: text(row.provider_id),
    productId: text(row.product_id),
    model: text(row.resolved_model),
    endpoint: text(row.endpoint),
    protocol: text(row.protocol),
  }));
}

/**
 * Effective customer price identities (currency included). This deliberately
 * enumerates from the price-version table rather than only the nominal
 * catalog targets: a composite group's admission-time pricing identity binds
 * the RESOLVED target platform's provider/product/endpoint (#18 swap), which
 * the nominal version row cannot express.
 */
async function readPriceIdentities(executor: SqlExecutor, at: string): Promise<readonly ModelPlazaPriceIdentity[]> {
  const result = await executor.query<PriceIdentityRow>(
    `/* model-plaza:price-identities */
     SELECT DISTINCT price.public_model_id, price.public_model_version,
            price.provider_id, price.product_id, price.protocol, price.endpoint, price.currency
       FROM saas_customer_price_versions AS price
       JOIN saas_public_models AS public_model ON public_model.id = price.public_model_id
      WHERE public_model.status = 'active'
        AND price.effective_at <= $1::timestamptz
        AND (price.expires_at IS NULL OR price.expires_at > $1::timestamptz)
      ORDER BY price.public_model_id, price.provider_id, price.product_id,
               price.protocol, price.endpoint, price.currency
      LIMIT ${MAX_PRICE_IDENTITIES}`,
    [at],
  );
  return result.rows.map((row) => ({
    publicModelId: text(row.public_model_id),
    publicModelVersion: optionalCount(row.public_model_version) ?? 0,
    providerId: text(row.provider_id),
    productId: text(row.product_id),
    protocol: text(row.protocol),
    endpoint: text(row.endpoint),
    currency: text(row.currency),
  }));
}

async function resolveKeyBillingGroup(
  executor: SqlExecutor,
  caller: { readonly tenantId: string; readonly projectId: string; readonly keyId: string },
): Promise<string | null> {
  try {
    const resolution = await resolveCompositeBillingGroup(executor, {
      tenantId: caller.tenantId,
      projectId: caller.projectId,
      proxyKeyId: caller.keyId,
    });
    return resolution.groupId;
  } catch {
    // An unresolvable group authority degrades the proxy-key tier to the
    // publicly visible groups only — never widens visibility.
    return null;
  }
}

async function resolveSessionUserGroups(executor: SqlExecutor, userId: string): Promise<readonly string[]> {
  const result = await executor.query<{ readonly id?: unknown }>(
    `/* model-plaza:session-user-groups */
     SELECT id FROM (
       SELECT groups.id
         FROM saas_memberships membership
         JOIN saas_tenants tenant ON tenant.id = membership.tenant_id
         JOIN saas_billing_groups groups ON groups.id = tenant.default_billing_group_id
        WHERE membership.user_id = $1 AND membership.status = 'active' AND membership.revoked_at IS NULL
       UNION
       SELECT keys.billing_group_id AS id
         FROM saas_memberships membership
         JOIN saas_api_keys keys ON keys.tenant_id = membership.tenant_id
        WHERE membership.user_id = $1 AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND keys.billing_group_id IS NOT NULL AND keys.status = 'active'
     ) authorized
     WHERE id IS NOT NULL
     LIMIT ${MAX_SESSION_GROUPS}`,
    [userId],
  );
  const groups: string[] = [];
  for (const row of result.rows) {
    const id = optionalText(row.id);
    if (id !== null && !groups.includes(id)) groups.push(id);
  }
  return groups;
}

export interface PostgresModelPlazaFactsOptions {
  readonly database: SaasDatabase;
  readonly pricing: Pick<SaasPricingService, 'resolveCustomerPriceVersion'>;
  readonly groups: Pick<SaasBillingGroupsService, 'listBillingGroups'>;
}

export class PostgresModelPlazaFacts implements ModelPlazaFactsPort {
  private readonly database: SaasDatabase;
  private readonly pricing: PostgresModelPlazaFactsOptions['pricing'];
  private readonly groups: PostgresModelPlazaFactsOptions['groups'];

  constructor(options: PostgresModelPlazaFactsOptions) {
    if (!options.database || typeof options.database.transaction !== 'function') {
      throw new TypeError('PostgresModelPlazaFacts requires a SaasDatabase');
    }
    this.database = options.database;
    this.pricing = options.pricing;
    this.groups = options.groups;
  }

  withSnapshot<T>(at: Date, work: (snapshot: ModelPlazaSnapshot) => Promise<T>): Promise<T> {
    return this.database.transaction(async (executor) => {
      // Sequential reads: one transaction runs on a single pooled client, and
      // concurrent queries on it are undefined behavior (pg deprecation).
      const groups = await readGroups(this.groups, executor);
      const pool = await readPoolCapabilities(executor);
      const global = await readGlobalCapabilities(executor);
      const targets = await readTargets(executor, at.toISOString());
      const priceIdentities = await readPriceIdentities(executor, at.toISOString());
      const pooledGroupIds = new Set(pool.groupCapabilities.keys());
      const unrestrictedGroupIds = new Set<string>(
        groups.filter((group) => !pooledGroupIds.has(group.id)).map((group) => group.id),
      );
      const facts: ModelPlazaFacts = {
        groups,
        groupCapabilities: pool.groupCapabilities,
        groupPlatforms: pool.groupPlatforms,
        unrestrictedGroupIds,
        globalCapabilities: global.globalCapabilities,
        globalPlatforms: global.globalPlatforms,
        targets,
        priceIdentities,
      };
      const snapshot: ModelPlazaSnapshot = {
        facts,
        resolvePrice: async (identity) => {
          try {
            return await this.pricing.resolveCustomerPriceVersion(
              {
                publicModelId: identity.publicModelId,
                publicModelVersion: identity.publicModelVersion,
                providerId: identity.providerId,
                productId: identity.productId,
                protocol: identity.protocol,
                endpoint: identity.endpoint,
                currency: identity.currency,
                at,
              },
              { executor },
            );
          } catch (error) {
            if (isSaasPricingError(error)) return null;
            throw error;
          }
        },
        resolveKeyBillingGroup: (caller) => resolveKeyBillingGroup(executor, caller),
        resolveSessionUserGroups: (userId) => resolveSessionUserGroups(executor, userId),
      };
      return work(snapshot);
    });
  }
}
