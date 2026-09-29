import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { ByokServicePlanService, ServicePlanError } from '../../../src/saas/plans/index.js';
import type { ServicePlanDatabase } from '../../../src/saas/plans/types.js';

const NOW = '2026-09-28T00:00:00.000Z';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';
const PROFILE_ID = 'profile-1';
const PLAN_VERSION_ID = 'plan-version-1';
const ORDER_ID = 'order-1';
const SNAPSHOT_ID = 'snapshot-1';
const SUBSCRIPTION_ID = 'subscription-1';
const ENTITLEMENT_ID = 'entitlement-1';

const context: TenantContext = {
  userId: 'user-1',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  tenantRole: 'owner',
  projectRole: 'owner',
};

interface Script {
  readonly contains: string;
  readonly rows: Record<string, unknown>[];
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows, rowCount: rows.length };
}

class ScriptedDatabase implements ServicePlanDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  transactionCalls = 0;
  private readonly scripts: Script[] = [];

  queue(contains: string, rows: Record<string, unknown>[] = []): void {
    this.scripts.push({ contains, rows });
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.calls.push({ sql: statement, values });
    // Fake SQL acceptance only; lock order is asserted by service tests and is not simulated here.
    if (statement.startsWith('select set_config(')) return result<Row>();
    if (statement.startsWith('select pg_advisory_xact_lock(1396788563, 46)')) return result<Row>();
    if (statement.startsWith('select pg_advisory_xact_lock_shared(')) return result<Row>();
    if (statement.startsWith('select plan_id from saas_service_plan_versions')) {
      return result<Row>([{ plan_id: 'plan-1' } as Row]);
    }
    const script = this.scripts.shift();
    assert.ok(script, `unexpected SQL: ${statement}`);
    assert.ok(statement.includes(script.contains), `expected ${script.contains} in ${statement}`);
    return result(structuredClone(script.rows) as Row[]);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return work(this);
  }

  assertConsumed(): void {
    assert.equal(this.scripts.length, 0);
  }
}

function digestSnapshot(): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        PLAN_VERSION_ID,
        'plan-1',
        1,
        ['provider-a', 'provider-b'],
        ['model-a', 'model-b'],
        'byok',
        PROFILE_ID,
        'price-v1',
        '1200',
        'USD',
        30,
        'policy-v1',
      ]),
    )
    .digest('hex');
}

function planVersionRow(): Record<string, unknown> {
  return {
    id: PLAN_VERSION_ID,
    plan_id: 'plan-1',
    version: 1,
    supply_mode: 'byok',
    supply_profile_id: PROFILE_ID,
    allowed_provider_ids: ['provider-a', 'provider-b'],
    allowed_models: ['model-a', 'model-b'],
    price_version: 'price-v1',
    price_minor_units: '1200',
    currency: 'USD',
    term_days: 30,
    policy_version: 'policy-v1',
    status: 'published',
    created_at: NOW,
    published_at: NOW,
    retired_at: null,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SNAPSHOT_ID,
    tenant_id: TENANT_ID,
    order_id: ORDER_ID,
    plan_version_id: PLAN_VERSION_ID,
    plan_id: 'plan-1',
    plan_version: 1,
    allowed_provider_ids: ['provider-a', 'provider-b'],
    allowed_models: ['model-a', 'model-b'],
    supply_mode: 'byok',
    supply_profile_id: PROFILE_ID,
    price_version: 'price-v1',
    price_minor_units: '1200',
    currency: 'USD',
    term_days: 30,
    policy_version: 'policy-v1',
    snapshot_digest: digestSnapshot(),
    created_at: NOW,
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    plan_version_id: PLAN_VERSION_ID,
    operation: 'activation',
    renewal_of_subscription_id: null,
    client_request_id: 'client-request-1',
    state: 'pending',
    subscription_id: null,
    verified_settlement_id: null,
    verified_provider_key: null,
    verified_merchant_id: null,
    verified_amount_minor_units: null,
    verified_currency: null,
    fulfillment_reference: null,
    fulfillment_evidence_sha256: null,
    verified_at: null,
    created_at: NOW,
    updated_at: NOW,
    paid_at: null,
    fulfilled_at: null,
    ...overrides,
  };
}

function fulfilledOrderRow(): Record<string, unknown> {
  return orderRow({
    state: 'fulfilled',
    subscription_id: SUBSCRIPTION_ID,
    verified_settlement_id: 'settlement-1',
    verified_provider_key: 'provider-payments',
    verified_merchant_id: 'merchant-1',
    verified_amount_minor_units: '1200',
    verified_currency: 'USD',
    fulfillment_reference: 'fulfillment-1',
    fulfillment_evidence_sha256: 'b'.repeat(64),
    verified_at: NOW,
    paid_at: NOW,
    fulfilled_at: NOW,
  });
}

function subscriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUBSCRIPTION_ID,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    order_id: ORDER_ID,
    snapshot_id: SNAPSHOT_ID,
    entitlement_id: ENTITLEMENT_ID,
    previous_subscription_id: null,
    operation: 'activation',
    status: 'active',
    effective_at: NOW,
    expires_at: '2026-10-28T00:00:00.000Z',
    activated_at: NOW,
    superseded_at: null,
    expired_at: null,
    cancelled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function entitlementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENTITLEMENT_ID,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    supply_profile_id: PROFILE_ID,
    supply_mode: 'byok',
    status: 'active',
    model_scopes: ['model-a'],
    authz_version: 1,
    effective_at: NOW,
    expires_at: '2026-10-28T00:00:00.000Z',
    superseded_at: null,
    disabled_at: null,
    ...overrides,
  };
}

function service(database: ScriptedDatabase, ids?: string[]): ByokServicePlanService {
  const generatedIds = ids ?? [
    'generated-order',
    'generated-snapshot',
    'generated-entitlement',
    'generated-subscription',
    'audit',
  ];
  return new ByokServicePlanService(database, {
    now: () => new Date(NOW),
    idFactory: () => generatedIds.shift() ?? 'generated-id',
  });
}

async function expectCode(work: () => Promise<unknown>, code: ServicePlanError['code']): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof ServicePlanError && error.code === code);
}

test('creates a tenant/project-scoped pending order with a complete immutable commercial snapshot', async () => {
  const database = new ScriptedDatabase();
  database.queue('from saas_service_plan_orders', []);
  database.queue('from saas_service_plan_versions', [planVersionRow()]);
  database.queue(
    "from saas_service_plan_subscriptions where tenant_id = $1 and project_id = $2 and status = 'active'",
    [],
  );
  database.queue('insert into saas_service_plan_orders', [
    orderRow({ id: 'generated-order', client_request_id: 'client-request-1' }),
  ]);
  database.queue('insert into saas_service_plan_snapshots', [
    snapshotRow({ id: 'generated-snapshot', order_id: 'generated-order' }),
  ]);
  database.queue('insert into saas_audit_events', []);

  const created = await service(database).createOrder(context, {
    planVersionId: PLAN_VERSION_ID,
    clientRequestId: 'client-request-1',
  });

  assert.equal(created.state, 'pending');
  assert.equal(created.tenantId, TENANT_ID);
  assert.equal(created.projectId, PROJECT_ID);
  assert.deepEqual(created.snapshot.allowedProviderIds, ['provider-a', 'provider-b']);
  assert.deepEqual(created.snapshot.allowedModels, ['model-a', 'model-b']);
  assert.equal(created.snapshot.priceVersion, 'price-v1');
  assert.equal(created.snapshot.termDays, 30);
  assert.equal(created.snapshot.policyVersion, 'policy-v1');
  const planIdentityIndex = database.calls.findIndex(({ sql }) =>
    sql.startsWith('select plan_id from saas_service_plan_versions'),
  );
  const planFenceIndex = database.calls.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'));
  const publishedVersionIndex = database.calls.findIndex(
    ({ sql }) => sql.includes('from saas_service_plan_versions') && sql.includes("status = 'published'"),
  );
  assert.ok(planIdentityIndex >= 0 && planIdentityIndex < planFenceIndex);
  assert.ok(planFenceIndex < publishedVersionIndex);
  assert.doesNotMatch(database.calls[publishedVersionIndex]?.sql ?? '', /FOR SHARE/i);
  assert.equal(
    database.calls.some(({ sql }) => /saas_(?:payment|wallet|ledger)/i.test(sql)),
    false,
  );
  database.assertConsumed();
});

test('requires server fulfillment evidence and fulfills exactly one BYOK entitlement without wallet effects', async () => {
  const database = new ScriptedDatabase();
  database.queue('from saas_service_plan_orders', [orderRow()]);
  database.queue('from saas_service_plan_snapshots', [snapshotRow()]);
  database.queue(
    "from saas_service_plan_subscriptions where tenant_id = $1 and project_id = $2 and status = 'active'",
    [],
  );
  database.queue('from saas_supply_profiles', [
    { id: PROFILE_ID, status: 'active', supply_mode: 'byok', model_scopes: ['model-a'], authz_version: 4 },
  ]);
  database.queue("set state = 'paid'", [orderRow({ state: 'paid', verified_settlement_id: 'settlement-1' })]);
  database.queue("set state = 'fulfilling'", [
    orderRow({ state: 'fulfilling', verified_settlement_id: 'settlement-1' }),
  ]);
  database.queue('insert into saas_project_entitlements', [entitlementRow()]);
  database.queue('insert into saas_service_plan_subscriptions', [subscriptionRow()]);
  database.queue("set state = 'fulfilled'", [fulfilledOrderRow()]);
  database.queue('insert into saas_audit_events', []);

  const fulfilled = await service(database, [ENTITLEMENT_ID, SUBSCRIPTION_ID, 'audit']).fulfillVerified({
    kind: 'server_verified_service_plan_fulfillment',
    orderId: ORDER_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    settlementId: 'settlement-1',
    providerKey: 'provider-payments',
    merchantId: 'merchant-1',
    amountMinorUnits: '1200',
    currency: 'USD',
    fulfillmentReference: 'fulfillment-1',
    fulfillmentEvidenceSha256: 'b'.repeat(64),
    verifiedAt: NOW,
  });

  assert.equal(fulfilled.replayed, false);
  assert.equal(fulfilled.order.state, 'fulfilled');
  assert.equal(fulfilled.subscription.status, 'active');
  assert.equal(fulfilled.entitlementId, ENTITLEMENT_ID);
  assert.deepEqual(fulfilled.subscription.snapshot.allowedProviderIds, ['provider-a', 'provider-b']);
  assert.deepEqual(database.calls.find(({ sql }) => sql.includes("set state = 'paid'"))?.values, [
    TENANT_ID,
    ORDER_ID,
    'settlement-1',
    'provider-payments',
    'merchant-1',
    '1200',
    'USD',
    'fulfillment-1',
    'b'.repeat(64),
    NOW,
  ]);
  assert.equal(
    database.calls.some(({ sql }) => /saas_(?:payment|wallet|ledger)/i.test(sql)),
    false,
  );
  const profileFenceIndex = database.calls.findIndex(
    ({ sql }) => sql.includes('pg_advisory_xact_lock_shared') && sql.includes('saas_supply_profile:'),
  );
  const profileReadIndex = database.calls.findIndex(({ sql }) => sql.includes('from saas_supply_profiles'));
  const writerFenceIndex = database.calls.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock(1396788563, 46)'));
  const firstRowLockIndex = database.calls.findIndex(({ sql }) => /\bfor update\b/i.test(sql));
  assert.ok(writerFenceIndex >= 0 && writerFenceIndex < firstRowLockIndex);
  assert.ok(profileFenceIndex >= 0 && profileFenceIndex < profileReadIndex);
  assert.doesNotMatch(database.calls[profileReadIndex]?.sql ?? '', /FOR (?:UPDATE|SHARE)/i);
  database.assertConsumed();
});

test('rejects client payment booleans before any database call', async () => {
  const database = new ScriptedDatabase();
  const input = {
    kind: 'server_verified_service_plan_fulfillment',
    orderId: ORDER_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    settlementId: 'settlement-1',
    providerKey: 'provider-payments',
    merchantId: 'merchant-1',
    amountMinorUnits: '1200',
    currency: 'USD',
    fulfillmentReference: 'fulfillment-1',
    fulfillmentEvidenceSha256: 'b'.repeat(64),
    verifiedAt: NOW,
    paid: true,
  } as never;

  await expectCode(() => new ByokServicePlanService(database).fulfillVerified(input), 'FULFILLMENT_REQUIRED');
  assert.equal(database.calls.length, 0);
});

test('cancellation and expiry disable the bound entitlement and are tenant/project scoped', async () => {
  const database = new ScriptedDatabase();
  database.queue('from saas_service_plan_subscriptions', [subscriptionRow()]);
  database.queue('from saas_service_plan_snapshots', [snapshotRow()]);
  database.queue('update saas_project_entitlements', [
    entitlementRow({ status: 'disabled', disabled_at: NOW, authz_version: 2 }),
  ]);
  database.queue("set status = 'cancelled'", [subscriptionRow({ status: 'cancelled', cancelled_at: NOW })]);
  database.queue('insert into saas_audit_events', []);

  const cancelled = await service(database).cancelSubscription(context, SUBSCRIPTION_ID);
  assert.equal(cancelled.status, 'cancelled');
  const cancelWriterFenceIndex = database.calls.findIndex(({ sql }) =>
    sql.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  const cancelFirstRowLockIndex = database.calls.findIndex(({ sql }) => /\bfor update\b/i.test(sql));
  assert.ok(cancelWriterFenceIndex >= 0 && cancelWriterFenceIndex < cancelFirstRowLockIndex);
  assert.equal(
    database.calls
      .find(({ sql }) => sql.includes('update saas_project_entitlements'))
      ?.values?.slice(0, 3)
      .join(':'),
    `${TENANT_ID}:${PROJECT_ID}:${ENTITLEMENT_ID}`,
  );
  database.assertConsumed();

  const expiredDatabase = new ScriptedDatabase();
  expiredDatabase.queue('from saas_service_plan_subscriptions', [
    subscriptionRow({ expires_at: '2026-09-27T00:00:00.000Z' }),
  ]);
  expiredDatabase.queue('from saas_service_plan_snapshots', [snapshotRow()]);
  expiredDatabase.queue('update saas_project_entitlements', [
    entitlementRow({ status: 'disabled', disabled_at: NOW, authz_version: 2 }),
  ]);
  expiredDatabase.queue("set status = 'expired'", [subscriptionRow({ status: 'expired', expired_at: NOW })]);
  expiredDatabase.queue('insert into saas_audit_events', []);

  const expired = await service(expiredDatabase).expireSubscription(TENANT_ID, PROJECT_ID, SUBSCRIPTION_ID);
  assert.equal(expired.status, 'expired');
  const expireWriterFenceIndex = expiredDatabase.calls.findIndex(({ sql }) =>
    sql.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  const expireFirstRowLockIndex = expiredDatabase.calls.findIndex(({ sql }) => /\bfor update\b/i.test(sql));
  assert.ok(expireWriterFenceIndex >= 0 && expireWriterFenceIndex < expireFirstRowLockIndex);
  assert.equal(
    expiredDatabase.calls
      .find(({ sql }) => sql.includes("set status = 'expired'"))
      ?.values?.slice(0, 3)
      .join(':'),
    `${TENANT_ID}:${PROJECT_ID}:${SUBSCRIPTION_ID}`,
  );
  expiredDatabase.assertConsumed();
});

test('returns a plan-backed effective resolver result with provider scope while remaining fail-closed on storage errors', async () => {
  const database = new ScriptedDatabase();
  database.queue('from saas_project_entitlements', [
    {
      id: ENTITLEMENT_ID,
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      supply_profile_id: PROFILE_ID,
      supply_mode: 'byok',
      status: 'active',
      model_scopes: ['model-a'],
      authz_version: 2,
      effective_at: NOW,
      expires_at: '2026-10-28T00:00:00.000Z',
      superseded_at: null,
      disabled_at: null,
      source_type: 'service_plan',
      source_ref: ORDER_ID,
      service_plan_snapshot_id: SNAPSHOT_ID,
      subscription_id: SUBSCRIPTION_ID,
      subscription_project_id: PROJECT_ID,
      subscription_order_id: ORDER_ID,
      subscription_snapshot_id: SNAPSHOT_ID,
      profile_authz_version: 4,
      snapshot_id: SNAPSHOT_ID,
      snapshot_tenant_id: TENANT_ID,
      snapshot_order_id: ORDER_ID,
      snapshot_plan_version_id: PLAN_VERSION_ID,
      snapshot_plan_id: 'plan-1',
      snapshot_plan_version: 1,
      snapshot_allowed_provider_ids: ['provider-a', 'provider-b'],
      snapshot_allowed_models: ['model-a', 'model-b'],
      snapshot_supply_mode: 'byok',
      snapshot_supply_profile_id: PROFILE_ID,
      snapshot_price_version: 'price-v1',
      snapshot_price_minor_units: '1200',
      snapshot_currency: 'USD',
      snapshot_term_days: 30,
      snapshot_policy_version: 'policy-v1',
      snapshot_digest: digestSnapshot(),
      snapshot_created_at: NOW,
    },
  ]);

  const resolved = await service(database).resolveCurrent(context);
  assert.equal(resolved?.subscriptionId, SUBSCRIPTION_ID);
  assert.deepEqual(resolved?.allowedProviderIds, ['provider-a', 'provider-b']);
  assert.deepEqual(resolved?.modelScopes, ['model-a']);
  assert.ok(
    database.calls.some(({ sql }) => sql.includes('e.source_ref = snap.order_id::text')),
    'the generic text source reference must compare against the UUID order id without a PostgreSQL type error',
  );
  database.assertConsumed();
});

test('refund effect seam uses the caller transaction and locks the original entitlement in plan order', async () => {
  const database = new ScriptedDatabase();
  database.queue('from saas_service_plan_orders o', [
    {
      id: ORDER_ID,
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      state: 'fulfilled',
      subscription_id: SUBSCRIPTION_ID,
      snapshot_id: SNAPSHOT_ID,
      snapshot_order_id: ORDER_ID,
      snapshot_supply_mode: 'byok',
      snapshot_policy_version: 'policy-v1',
      snapshot_price_minor_units: '1200',
      snapshot_currency: 'USD',
    },
  ]);
  database.queue('from saas_projects where tenant_id = $1 and id = $2 for share', [{ id: PROJECT_ID }]);
  database.queue('from saas_service_plan_subscriptions', [
    {
      id: SUBSCRIPTION_ID,
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      order_id: ORDER_ID,
      snapshot_id: SNAPSHOT_ID,
      entitlement_id: ENTITLEMENT_ID,
      status: 'active',
      effective_at: NOW,
      expires_at: '2026-10-28T00:00:00.000Z',
    },
  ]);
  database.queue('from saas_service_plan_snapshots', [
    {
      id: SNAPSHOT_ID,
      tenant_id: TENANT_ID,
      order_id: ORDER_ID,
      supply_mode: 'byok',
      policy_version: 'policy-v1',
      price_minor_units: '1200',
      currency: 'USD',
    },
  ]);
  database.queue('from saas_project_entitlements', [
    {
      id: ENTITLEMENT_ID,
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      supply_mode: 'byok',
      status: 'active',
      authz_version: 4,
      effective_at: NOW,
      expires_at: '2026-10-28T00:00:00.000Z',
      superseded_at: null,
      disabled_at: null,
      source_type: 'service_plan',
      source_ref: ORDER_ID,
      service_plan_snapshot_id: SNAPSHOT_ID,
    },
  ]);
  database.queue('update saas_project_entitlements', [{ authz_version: 5 }]);
  database.queue('insert into saas_audit_events');
  database.queue('insert into saas_refund_service_plan_effects');

  const planService = service(database, ['refund-effect-audit']);
  let effectSource: Awaited<ReturnType<ByokServicePlanService['applyApprovedRefundEntitlementEffect']>> | undefined;
  await database.transaction(async (executor) => {
    effectSource = await planService.applyApprovedRefundEntitlementEffect(executor, {
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      projectId: PROJECT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      refundId: 'refund-1',
      effectRef: 'effect-1',
      refundPolicyVersion: 'byok_cancel_only_v1',
      amountMinorUnits: '500',
      currency: 'USD',
      cutoffAt: NOW,
      actorId: context.userId,
      reasonCode: 'CUSTOMER_REQUEST',
    });
  });

  assert.equal(database.transactionCalls, 1, 'only the caller opens a transaction');
  assert.equal(effectSource?.entitlementId, ENTITLEMENT_ID);
  assert.equal(effectSource?.servicePlanPolicyVersion, 'policy-v1');
  const writerFenceIndex = database.calls.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock(1396788563, 46)'));
  const firstRowLockIndex = database.calls.findIndex(({ sql }) => /\bfor update\b/i.test(sql));
  assert.ok(writerFenceIndex >= 0 && writerFenceIndex < firstRowLockIndex);
  const lockCalls = database.calls.filter(
    ({ sql }) => !sql.startsWith('select set_config(') && !sql.includes('pg_advisory_xact_lock(1396788563, 46)'),
  );
  assert.deepEqual(
    lockCalls.slice(0, 5).map(({ sql }) => {
      if (sql.includes('from saas_service_plan_orders')) return 'order';
      if (sql.includes('from saas_projects')) return 'project';
      if (sql.includes('from saas_service_plan_subscriptions')) return 'subscription';
      if (sql.includes('from saas_service_plan_snapshots')) return 'snapshot';
      return 'entitlement';
    }),
    ['order', 'project', 'subscription', 'snapshot', 'entitlement'],
  );
  assert.match(lockCalls[0]?.sql ?? '', /for update of o/);
  assert.match(lockCalls[2]?.sql ?? '', /for update/);
  assert.doesNotMatch(lockCalls[3]?.sql ?? '', /for (?:update|share)/);
  assert.match(lockCalls[4]?.sql ?? '', /for update/);
  database.assertConsumed();
});
