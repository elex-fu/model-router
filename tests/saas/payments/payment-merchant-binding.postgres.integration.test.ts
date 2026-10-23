import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import { PaymentRefundService } from '../../../src/saas/payments/refunds.js';
import { createPlatformPaymentRefundOperations } from '../../../src/saas/payments/platform-refund-operations.js';
import { admitPaymentBinding, getPaymentControl, ReadonlyPaymentBindingResolver, registerPaymentBindings, setPaymentControl, type LoadedPaymentBinding } from '../../../src/saas/payments/merchant-binding.js';
import type { NormalizedPaymentProviderEvent, PaymentProviderRefundInput } from '../../../src/saas/payments/types.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';

function code(expected: string) { return (error: unknown) => error instanceof PaymentError && error.code === expected; }
function sqlState(expected: string) { return (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected; }
function provider(id: string, merchantId: string) {
  const calls = { create: 0, verify: 0, confirm: 0, refund: 0, queryRefund: 0 };
  const entry: LoadedPaymentBinding = {
    binding: { id, providerKey: 'alipay', merchantId, sellerId: `seller-${id}`, currency: 'CNY', descriptorDigest: createHash('sha256').update(id).digest('hex') },
    adapter: {
      providerKey: 'alipay',
      async createOrder(input) { calls.create++; return { providerOrderId: input.localOrderId, amountMinorUnits: input.amountMinorUnits, currency: input.currency }; },
      async verifyWebhook(input) { calls.verify++; return { providerKey: 'alipay', merchantId, payload: JSON.parse(input.rawBody.toString('utf8')) as unknown }; },
      normalizeEvent(input) { return input.payload as NormalizedPaymentProviderEvent; },
      async confirmEvent() { calls.confirm++; return { confirmed: true }; },
    },
    refundAdapter: {
      providerKey: 'alipay', merchantId,
      async submitRefund(input: PaymentProviderRefundInput) { calls.refund++; return { ...input, providerRefundId: `refund-${input.localRefundId}`, status: 'pending' }; },
      async queryRefund(input: PaymentProviderRefundInput) { calls.queryRefund++; return { ...input, providerRefundId: `refund-${input.localRefundId}`, status: 'succeeded' }; },
    },
  };
  return { entry, calls };
}

// This suite runs only on the designated disposable PG15/18 database after all migrations and role grants.
// PSP adapters are local fakes; all admission, inbox, ledger, refund, authority, and CAS transactions are real PG.
test('P07 real PG restricted merchant admission, concurrent replay, draining callbacks/refunds, and live control authority', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? `set ${REQUIRED_FLAG}=1 and all three disposable role URLs` : false,
  timeout: 300_000,
}, async t => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const cpA = createSaasDatabase({ connectionString: urls[1], max: 5 });
  const cpB = createSaasDatabase({ connectionString: urls[1], max: 5 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 2 });
  let restoreControl: () => Promise<void> = async () => {};
  t.after(async () => {
    try { await restoreControl(); }
    finally { await Promise.allSettled([migrator.close(), cpA.close(), cpB.close(), gateway.close()]); }
  });
  await cpA.verifySchema();
  assert.equal((await cpA.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_control_plane');
  assert.equal((await gateway.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_gateway');
  const namespace = randomUUID();
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const sessionId = randomUUID();
  const credentialId = randomUUID();
  const roles = ['finance', 'operations'];
  await migrator.transaction(async tx => {
    await tx.query('INSERT INTO saas_users(id,email) VALUES($1,$2)', [actorId, `p07-${namespace}@example.test`]);
    await tx.query('INSERT INTO saas_tenants(id,name,slug) VALUES($1,$2,$2)', [tenantId, `p07-${namespace}`]);
    await tx.query("INSERT INTO saas_memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [tenantId, actorId]);
    await tx.query("INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,'finance'),($1,'operations')", [actorId]);
    await tx.query("INSERT INTO saas_mfa_credentials(id,user_id,kind,encrypted_secret,verified_at) VALUES($1,$2,'totp',decode('7b7d','hex'),clock_timestamp())", [credentialId, actorId]);
    await tx.query("INSERT INTO saas_platform_sessions(id,user_id,credential_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')", [sessionId, actorId, credentialId, createHash('sha256').update(namespace).digest('hex'), 'c'.repeat(64)]);
  });
  const old = provider(`p07-old-${namespace}`, `app-old-${namespace}`);
  const next = provider(`p07-new-${namespace}`, `app-new-${namespace}`);
  const resolver = new ReadonlyPaymentBindingResolver([old.entry, next.entry]);
  await registerPaymentBindings(cpA, resolver);
  const initial = await getPaymentControl(cpA);
  const actor = { actorId, sessionId, actorRoles: roles, requestId: `p07-${namespace}` };
  restoreControl = async () => {
    // Restore only the singleton control; never delete or mutate historical financial facts.
    await migrator.query("INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,'operations') ON CONFLICT DO NOTHING", [actorId]);
    const current = await getPaymentControl(cpA);
    await setPaymentControl(cpA, resolver, { ...actor, expectedRevision: current.revision, mode: initial.mode, activeBindingId: initial.activeBindingId });
  };
  const activated = await setPaymentControl(cpA, resolver, { ...actor, expectedRevision: initial.revision, mode: 'enabled', activeBindingId: old.entry.binding.id });

  await t.test('restricted CP can hold admission FOR SHARE and concurrent control writers use revision CAS', async () => {
    await cpA.transaction(async tx => {
      assert.equal((await admitPaymentBinding(tx, resolver, 'CNY')).binding.id, old.entry.binding.id);
      await assert.rejects(cpB.transaction(lock => lock.query('SELECT singleton FROM saas_payment_control WHERE singleton=TRUE FOR UPDATE NOWAIT')), sqlState('55P03'));
    });
    const input = { ...actor, expectedRevision: activated.revision, mode: 'enabled' as const, activeBindingId: old.entry.binding.id };
    const results = await Promise.allSettled([setPaymentControl(cpA, resolver, input), setPaymentControl(cpB, resolver, input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && code('PAYMENT_CONTROL_CONFLICT')(rejected.reason));
    await assert.rejects(gateway.query('SELECT mode FROM saas_payment_control'), sqlState('42501'));
  });

  const options = { walletTopUpPromo: { async priceWalletTopUp(_executor: unknown, input: { amountMinorUnits: string }) { return { amountMinorUnits: input.amountMinorUnits, originalAmountMinorUnits: input.amountMinorUnits }; } } };
  const serviceA = new PaymentFulfillmentService(cpA, resolver, options);
  const serviceB = new PaymentFulfillmentService(cpB, resolver, options);
  const request = { tenantId, clientRequestId: `p07-request-${namespace}`, amountMinorUnits: '125', currency: 'CNY', promoCode: 'PROMO-A' };
  const [created, replay] = await Promise.all([serviceA.createWalletTopUp(request), serviceB.createWalletTopUp(request)]);
  assert.equal(created.id, replay.id);
  const first = await serviceA.getWalletTopUp({ tenantId, orderId: created.id });
  assert.ok(first);
  assert.ok(first.providerOrderId);
  assert.equal(first.bindingId, old.entry.binding.id);
  assert.equal(old.calls.create, 1, 'one PSP create across two CP instances');
  const orders = await cpA.query<{ count: string }>('SELECT count(*)::text AS count FROM saas_payment_orders WHERE tenant_id=$1 AND client_request_id=$2', [tenantId, request.clientRequestId]);
  assert.equal(orders.rows[0]?.count, '1');
  await assert.rejects(cpA.query('UPDATE saas_payment_orders SET binding_id=$1 WHERE id=$2', [next.entry.binding.id, first.id]), sqlState('55000'));
  await assert.rejects(migrator.query('UPDATE saas_payment_orders SET binding_id=$1 WHERE id=$2', [next.entry.binding.id, first.id]), sqlState('55000'));
  await assert.rejects(migrator.query('UPDATE saas_payment_orders SET create_request_fingerprint=$1 WHERE id=$2', ['0'.repeat(64), first.id]), sqlState('55000'));

  await t.test('merchant switch preserves original POST and rejects altered promo fingerprints', async () => {
    const control = await getPaymentControl(cpA);
    await setPaymentControl(cpB, resolver, { ...actor, expectedRevision: control.revision, mode: 'enabled', activeBindingId: next.entry.binding.id });
    assert.equal((await serviceB.createWalletTopUp(request)).bindingId, old.entry.binding.id);
    await assert.rejects(serviceA.createWalletTopUp({ ...request, promoCode: 'PROMO-B' }), code('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(serviceA.createWalletTopUp({ tenantId, clientRequestId: request.clientRequestId, amountMinorUnits: request.amountMinorUnits, currency: request.currency }), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(old.calls.create, 1);
    assert.equal(next.calls.create, 0);
  });

  await t.test('draining keeps original callback and refund queues alive with exactly one ledger effect', async () => {
    const control = await getPaymentControl(cpA);
    await setPaymentControl(cpA, resolver, { ...actor, expectedRevision: control.revision, mode: 'draining', activeBindingId: next.entry.binding.id });
    assert.equal((await serviceB.createWalletTopUp(request)).id, first.id);
    await assert.rejects(serviceA.createWalletTopUp({ ...request, clientRequestId: randomUUID() }), code('PAYMENTS_UNAVAILABLE'));
    const event: NormalizedPaymentProviderEvent = { providerEventId: `event-${namespace}`, eventType: 'trade.success', providerOrderId: first.providerOrderId!, tenantId, merchantId: old.entry.binding.merchantId, status: 'succeeded', amountMinorUnits: '125', currency: 'CNY', occurredAt: new Date().toISOString() };
    const body = Buffer.from(JSON.stringify(event));
    await Promise.all([serviceA.handleWebhook({}, body, old.entry.binding.id), serviceB.handleWebhook({}, body, old.entry.binding.id)]);
    await Promise.all([serviceA.processPendingWebhooks(), serviceB.processPendingWebhooks()]);
    assert.equal((await serviceA.getWalletTopUp({ tenantId, orderId: first.id }))?.status, 'fulfilled');
    const funded = await cpA.query<{ count: string }>("SELECT count(*)::text AS count FROM saas_ledger_transactions WHERE tenant_id=$1 AND source_order_ref=$2 AND source_type='wallet_funding'", [tenantId, first.id]);
    assert.equal(funded.rows[0]?.count, '1');
    assert.equal(next.calls.verify, 0);
    assert.equal(next.calls.confirm, 0);
    const refundOptions = { operations: createPlatformPaymentRefundOperations(), reconcileDelayMs: 0 };
    const refundsA = new PaymentRefundService(cpA, resolver, refundOptions);
    const refundsB = new PaymentRefundService(cpB, resolver, refundOptions);
    const refund = await refundsA.requestPlatformWalletTopUpRefund({ ...actor, tenantId, orderId: first.id, clientRequestId: `refund-${namespace}`, reasonCode: 'CUSTOMER_REQUEST' });
    assert.equal(refund.status, 'pending');
    await Promise.all([refundsA.processPendingRefunds(), refundsB.processPendingRefunds()]);
    assert.equal((await refundsA.getRefund(tenantId, refund.id))?.status, 'succeeded');
    assert.equal(old.calls.refund, 1);
    assert.equal(next.calls.refund, 0);
    assert.equal(next.calls.queryRefund, 0);
    const refundFacts = await cpA.query<{ binding_id: string; wallet_refund_transaction_id: string }>('SELECT binding_id,wallet_refund_transaction_id FROM saas_refund_orders WHERE id=$1', [refund.id]);
    assert.equal(refundFacts.rows[0]?.binding_id, old.entry.binding.id);
    assert.ok(refundFacts.rows[0]?.wallet_refund_transaction_id);
    const balance = await cpA.query<{ balance: string }>('SELECT posted_balance_minor_units::text AS balance FROM saas_wallets WHERE tenant_id=$1 AND currency=$2', [tenantId, 'CNY']);
    assert.equal(balance.rows[0]?.balance, '0');
  });

  await t.test('live role revocation serializes ahead of a queued control CAS', async () => {
    const current = await getPaymentControl(cpA);
    let pending: Promise<unknown> | undefined;
    await migrator.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [actorId]);
      pending = setPaymentControl(cpB, resolver, { ...actor, expectedRevision: current.revision, mode: 'disabled', activeBindingId: next.entry.binding.id });
      // Attach a rejection handler before the revocation transaction commits.
      void pending.catch(() => undefined);
      await tx.query("DELETE FROM saas_platform_role_assignments WHERE user_id=$1 AND role='operations'", [actorId]);
    });
    await assert.rejects(pending!, code('PAYMENT_CONTROL_FORBIDDEN'));
    assert.equal((await getPaymentControl(cpA)).revision, current.revision);
  });
});
