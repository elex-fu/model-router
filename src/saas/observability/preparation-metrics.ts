import { Histogram, type Registry } from 'prom-client';
import type {
  PostgresPreparationObservation,
  PostgresPreparationObserver,
} from '../gateway/postgres-preparation-observer.js';
import { getSaasMetricsRegistry } from './metrics.js';

export const SAAS_GATEWAY_PREPARATION_STAGE_DURATION_SECONDS = 'saas_gateway_preparation_stage_duration_seconds';
export const SAAS_GATEWAY_PREPARATION_QUERY_DURATION_SECONDS = 'saas_gateway_preparation_query_duration_seconds';

const PHASES = new Set(['authority', 'admission-guard', 'admission', 'attempt', 'preparation']);
const STAGES = new Set([
  'resolve',
  'revalidate',
  'metering-guard-wallet',
  'capacity',
  'scheduler-select',
  'affinity-bind',
  'evidence-register',
  'preparation-total',
]);
const QUERY_OPERATIONS = new Set([
  ...[
    'fence-batch',
    'authority-batch',
    'clock',
    'request',
    'attempt',
    'capability',
    'account-capability',
    'billing-group',
    'tenant',
    'project',
    'project-policy',
    'principal',
    'tenant-membership',
    'project-membership',
    'key',
    'key-ip-policy',
    'entitlement',
    'profile',
    'route',
    'commercial',
    'customer-policy',
    'provider-policy',
    'attestation',
    'account',
    'account-rights',
    'credential',
    'credential-version',
    'mapping',
    'pool',
    'pool-rights',
    'pool-member',
    'pool-grant',
    'customer-price-identity',
    'supplier-cost-identity',
  ].map((operation) => `postgres-request-admission:${operation}`),
  ...['byok', 'platform', 'account-capability'].map((operation) => `preparation-authority:${operation}`),
  ...['billing-group-terms', 'billing-group-rate'].map((operation) => `postgres-preparation-capacity:${operation}`),
  ...['billing-group', 'enabled-routes', 'model-ownership', 'target-capability'].map(
    (operation) => `composite-route-store:${operation}`,
  ),
  'advisory-lock-exclusive-int8',
  'advisory-lock-shared-int8',
  'advisory-lock-exclusive',
  'advisory-lock-shared',
  'database-clock',
  'select',
  'insert',
  'update',
  'delete',
  'set',
  'query',
  ...[
    'tenants',
    'projects',
    'users',
    'memberships',
    'project_memberships',
    'api_keys',
    'api_key_ip_policies',
    'project_entitlements',
    'supply_profiles',
    'project_inference_policy_versions',
    'route_config_heads',
    'route_config_versions',
    'route_config_dispatchable',
    'public_models',
    'public_model_versions',
    'route_config_commercial_authorities',
    'customer_metering_policy_heads',
    'customer_metering_policy_versions',
    'provider_metering_policy_heads',
    'provider_metering_policy_versions',
    'contract_test_attestations',
    'provider_products',
    'provider_capabilities',
    'provider_rights',
    'tenant_provider_accounts',
    'platform_provider_accounts',
    'tenant_provider_credentials',
    'platform_provider_credentials',
    'tenant_provider_credential_versions',
    'platform_provider_credential_versions',
    'tenant_provider_account_capabilities',
    'platform_provider_account_capabilities',
    'platform_provider_pools',
    'platform_provider_pool_members',
    'platform_provider_pool_grants',
    'tenant_provider_supply_profile_accounts',
    'customer_price_versions',
    'supplier_cost_versions',
    'request_customer_price_snapshots',
    'billing_groups',
    'billing_group_spend_counters',
    'billing_group_spend_reservations',
    'billing_group_rate_counters',
    'api_key_budget_limits',
    'api_key_budget_reservations',
    'api_key_budget_lineages',
    'requests',
    'attempts',
    'idempotency_keys',
    'gateway_request_idempotency',
    'provider_account_rate_counters',
    'request_admission_outbox',
    'audit_events',
    'billing_reservations',
    'wallets',
    'billing_spending_freezes',
    'refund_wallet_freezes',
    'gateway_capacity_reservations',
  ].map((table) => `saas_${table}`),
]);

const observers = new WeakMap<Registry, PostgresPreparationObserver>();

/**
 * One stable callback per registry. Use the same callback at every nested
 * preparation hook so SQL observations are attributed once to their innermost
 * phase. Stage timers are inclusive and must not be added together.
 *
 * The closed label sets deliberately collapse unknown operations to `other`;
 * request/account/model identities, SQL, and SQL values can never form labels.
 */
export function createPostgresPreparationMetricsObserver(
  registry: Registry = getSaasMetricsRegistry(),
): PostgresPreparationObserver {
  const existing = observers.get(registry);
  if (existing) return existing;
  const stages = new Histogram<'phase' | 'operation' | 'outcome'>({
    name: SAAS_GATEWAY_PREPARATION_STAGE_DURATION_SECONDS,
    help: 'Inclusive PostgreSQL preparation stage duration by fixed stage and execution outcome; nested stages overlap.',
    labelNames: ['phase', 'operation', 'outcome'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const queries = new Histogram<'phase' | 'operation' | 'outcome'>({
    name: SAAS_GATEWAY_PREPARATION_QUERY_DURATION_SECONDS,
    help: 'PostgreSQL preparation query round-trip duration, including lock waits, attributed once to the innermost phase.',
    labelNames: ['phase', 'operation', 'outcome'],
    buckets: [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const observe: PostgresPreparationObserver = (observation) => {
    if (
      !observation ||
      !PHASES.has(observation.phase) ||
      (observation.outcome !== 'ok' && observation.outcome !== 'error') ||
      !Number.isFinite(observation.durationMs) ||
      observation.durationMs < 0
    )
      return;
    if (observation.kind !== 'phase' && observation.kind !== 'query') return;
    const operations = observation.kind === 'phase' ? STAGES : QUERY_OPERATIONS;
    const operation =
      typeof observation.operation === 'string' &&
      observation.operation.length <= 128 &&
      operations.has(observation.operation)
        ? observation.operation
        : 'other';
    const histogram = observation.kind === 'phase' ? stages : queries;
    histogram.labels(observation.phase, operation, observation.outcome).observe(observation.durationMs / 1000);
  };
  observers.set(registry, observe);
  return observe;
}

/** Default shared-registry recorder for integrations that need a function reference. */
export function recordPostgresPreparationObservation(observation: PostgresPreparationObservation): void {
  createPostgresPreparationMetricsObserver()(observation);
}
