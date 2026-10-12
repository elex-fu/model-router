import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track F: tenant-scoped webhook entitlement columns. `allowed_event_types`
 * is the per-tenant event whitelist consumed by the F2 entitlement policy
 * (contract C-5: a tenant without the webhook capability rejects everything;
 * an enabled tenant passes only whitelisted event types). The DEFAULT keeps
 * every existing enabled policy byte-for-byte at its pre-087 behavior (all
 * seven frozen event types). `low_balance_threshold_minor_units` configures
 * the F3 wallet.low_balance scanner; NULL (the default for every existing
 * row) disables low-balance events, which is exactly the pre-087 behavior.
 * No trigger, ACL, epoch, or lifecycle shape changes. Numbered 087: Track F
 * consumes the next dense slot after 085; 086 stays reserved/unused and the
 * retired 064-079 block is never revisited (docs/contracts-m0-freeze.md
 * arbitration table).
 *
 * Uniqueness is expressed as pg_catalog-only per-value occurrence caps
 * (migration 056's pattern): the runtime role template revokes EXECUTE on
 * every model_router_saas function, and CHECK expressions evaluate with the
 * writer's privileges, so calling the 043 helper here would fail closed for
 * the control-plane role. Because the whitelist conjunct already restricts
 * values to the frozen seven-type set, "no duplicates" is exactly "each
 * allowed value occurs at most once".
 */
const customerWebhookTenantPolicyEntitlementSql = `
ALTER TABLE saas_customer_webhook_tenant_policies
  ADD COLUMN allowed_event_types text[] NOT NULL DEFAULT ARRAY[
    'wallet.low_balance', 'api_key.expiring', 'service_plan_order.status_changed',
    'refund.status_changed', 'request.completed', 'usage.completed', 'platform.maintenance'
  ]::text[],
  ADD CONSTRAINT saas_customer_webhook_policies_allowed_event_types_check CHECK (
    cardinality(allowed_event_types) BETWEEN 1 AND 7
    AND array_position(allowed_event_types, NULL) IS NULL
    AND array_position(allowed_event_types, '') IS NULL
    AND allowed_event_types <@ ARRAY[
      'wallet.low_balance', 'api_key.expiring', 'service_plan_order.status_changed',
      'refund.status_changed', 'request.completed', 'usage.completed', 'platform.maintenance'
    ]::text[]
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'wallet.low_balance'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'api_key.expiring'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'service_plan_order.status_changed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'refund.status_changed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'request.completed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'usage.completed'::text)) <= 1
    AND pg_catalog.cardinality(pg_catalog.array_positions(allowed_event_types, 'platform.maintenance'::text)) <= 1
  );

ALTER TABLE saas_customer_webhook_tenant_policies
  ADD COLUMN low_balance_threshold_minor_units bigint,
  ADD CONSTRAINT saas_customer_webhook_policies_low_balance_threshold_range CHECK (
    low_balance_threshold_minor_units IS NULL
      OR (low_balance_threshold_minor_units > 0
        AND low_balance_threshold_minor_units <= 9007199254740991)
  );
`;

export const CUSTOMER_WEBHOOK_TENANT_POLICY_ENTITLEMENT_SAAS_MIGRATION: SaasMigration = {
  version: 87,
  name: 'customer_webhook_tenant_policy_entitlement',
  sql: customerWebhookTenantPolicyEntitlementSql,
};
