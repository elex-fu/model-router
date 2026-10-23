import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import { createFakeFundingLedger, FakePaymentDatabase, FakePaymentProvider, successWebhook } from './fake-sql.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import {
  admitPaymentBinding, assertPaymentBindingsReady, ReadonlyPaymentBindingResolver,
  registerPaymentBindings, setPaymentControl, type LoadedPaymentBinding, type PaymentOperatingMode,
} from '../../../src/saas/payments/merchant-binding.js';

function loaded(id = 'merchant-a', merchantId = 'app-a'): LoadedPaymentBinding {
  return {
    binding: { id, providerKey: 'alipay', merchantId, sellerId: 'seller-a', currency: 'CNY', descriptorDigest: 'a'.repeat(64) },
    adapter: { providerKey: 'alipay', createOrder: async () => { throw new Error('unused'); }, verifyWebhook: async () => { throw new Error('unused'); }, normalizeEvent: () => { throw new Error('unused'); } },
    refundAdapter: { providerKey: 'alipay', merchantId, submitRefund: async () => { throw new Error('unused'); }, queryRefund: async () => { throw new Error('unused'); } },
  };
}
function database(mode: PaymentOperatingMode = 'enabled', active = 'merchant-a', legacy = false) {
  const statements: string[] = [];
  const executor: SqlExecutor = { async query<Row>(sql: string): Promise<SqlResult<Row>> {
    statements.push(sql);
    let rows: unknown[] = [];
    if (sql.includes('FROM saas_payment_control')) rows = [{ mode, active_binding_id: active, revision: '7' }];
    else if (sql.includes('SELECT id FROM saas_payment_merchant_bindings')) rows = [{ id: active }];
    else if (sql.includes('AS present')) rows = [{ present: legacy }];
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  return { executor, statements };
}
function code(expected: string) { return (error: unknown) => error instanceof PaymentError && error.code === expected; }

test('resolver is immutable and contains no active-selection authority', () => {
  const original = loaded();
  const resolver = new ReadonlyPaymentBindingResolver([original, loaded('merchant-b', 'app-b')]);
  assert.equal(resolver.require('merchant-a').adapter, original.adapter);
  assert.equal(Object.isFrozen(resolver.require('merchant-a').binding), true);
  assert.equal(Object.isFrozen(resolver.list()), true);
  assert.throws(() => resolver.require('missing'), code('PAYMENT_BINDING_UNAVAILABLE'));
  assert.throws(() => new ReadonlyPaymentBindingResolver([original, original]), TypeError);
});

test('new-order admission holds a PG shared control lock and uses its active binding', async () => {
  const db = database('enabled', 'merchant-b');
  const resolver = new ReadonlyPaymentBindingResolver([loaded(), loaded('merchant-b', 'app-b')]);
  const selected = await admitPaymentBinding(db.executor, resolver, 'CNY');
  assert.equal(selected.binding.id, 'merchant-b');
  assert.match(db.statements[0]!, /FOR SHARE$/);
  await assert.rejects(admitPaymentBinding(db.executor, resolver, 'USD'), code('PAYMENT_CURRENCY_UNSUPPORTED'));
});

test('draining rejects new admission while historical bindings remain resolvable', async () => {
  const db = database('draining');
  const resolver = new ReadonlyPaymentBindingResolver([loaded()]);
  await assert.rejects(admitPaymentBinding(db.executor, resolver, 'CNY'), code('PAYMENTS_UNAVAILABLE'));
  assert.equal(resolver.require('merchant-a').binding.merchantId, 'app-a');
  assert.equal(db.statements.length, 1);
});

test('registration is insert-only and validates persisted immutable descriptor', async () => {
  const db = database();
  await registerPaymentBindings(db.executor, new ReadonlyPaymentBindingResolver([loaded()]));
  assert.match(db.statements[0]!, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(db.statements[1]!, /descriptor_digest = \$6/);
});

test('readiness refuses enabled admission with unresolved legacy financial facts', async () => {
  const resolver = new ReadonlyPaymentBindingResolver([loaded()]);
  await assert.rejects(assertPaymentBindingsReady(database('enabled', 'merchant-a', true).executor, resolver), code('PAYMENT_BINDING_UNAVAILABLE'));
  assert.equal((await assertPaymentBindingsReady(database('draining', 'merchant-a', true).executor, resolver)).mode, 'draining');
});

async function historicalFixture() {
  const db = new FakePaymentDatabase();
  const oldProvider = new FakePaymentProvider('alipay');
  const ledger = createFakeFundingLedger(db);
  let seq = 0;
  const legacy = new PaymentFulfillmentService(db, oldProvider, { providerKey: 'alipay', merchantId: 'app-a', walletFundingLedger: ledger, idFactory: () => `order-${++seq}` });
  const order = await legacy.createWalletTopUp({ tenantId: 'tenant-a', clientRequestId: 'request-a', amountMinorUnits: '125', currency: 'CNY' });
  db.state.orders[0]!.binding_id = 'merchant-a'; // Explicitly proven migration fixture, never inferred by runtime.
  const newProvider = new FakePaymentProvider('alipay');
  const resolver = new ReadonlyPaymentBindingResolver([
    { ...loaded(), adapter: oldProvider },
    { ...loaded('merchant-b', 'app-b'), adapter: newProvider },
  ]);
  const service = new PaymentFulfillmentService(db, resolver, { walletFundingLedger: ledger, idFactory: () => `work-${++seq}` });
  return { db, order, oldProvider, newProvider, resolver, service };
}

test('POST replay returns the original merchant binding without reading the active control', async () => {
  const { service, order, oldProvider, newProvider } = await historicalFixture();
  // The fake deliberately has no control table: replay must finish before admission.
  const replay = await service.createWalletTopUp({ tenantId: 'tenant-a', clientRequestId: 'request-a', amountMinorUnits: '125', currency: 'CNY' });
  assert.equal(replay.id, order.id);
  assert.equal(replay.bindingId, 'merchant-a');
  assert.equal(replay.merchantId, 'app-a');
  assert.equal(oldProvider.calls.length, 1);
  assert.equal(newProvider.calls.length, 0);
  await assert.rejects(service.createWalletTopUp({ tenantId: 'tenant-a', clientRequestId: 'request-a', amountMinorUnits: '126', currency: 'CNY' }), code('IDEMPOTENCY_CONFLICT'));
});

test('a single inbox worker confirms and fulfills with the original binding adapter', async () => {
  const { db, service, order, oldProvider, newProvider } = await historicalFixture();
  oldProvider.confirmEventResult = { confirmed: true };
  await service.handleWebhook({}, successWebhook(order.providerOrderId!, 'tenant-a', 'old-event', '125', 'CNY'), 'merchant-a');
  assert.equal(db.state.inbox[0]!.binding_id, 'merchant-a');
  assert.equal((await service.processPendingWebhooks()).processed, 1);
  assert.equal(oldProvider.confirmCalls.length, 1);
  assert.equal(newProvider.confirmCalls.length, 0);
  assert.equal(db.state.funding.length, 1);
});

test('a new callback path cannot reattribute or replay a historical merchant event', async () => {
  const { db, service, order, oldProvider, resolver } = await historicalFixture();
  const duplicateIdentity = new ReadonlyPaymentBindingResolver([...resolver.list(), { ...loaded('merchant-a-new'), adapter: oldProvider }]);
  const duplicateService = new PaymentFulfillmentService(db, duplicateIdentity, {});
  const body = successWebhook(order.providerOrderId!, 'tenant-a', 'old-event', '125', 'CNY');
  await assert.rejects(duplicateService.handleWebhook({}, body, 'merchant-a-new'), code('WEBHOOK_REJECTED'));
  assert.equal(db.state.inbox.length, 0);
  await service.handleWebhook({}, body, 'merchant-a');
  await assert.rejects(duplicateService.handleWebhook({}, body, 'merchant-a-new'), code('PAYMENT_EVENT_CONFLICT'));
  assert.equal(db.state.inbox.length, 1);
});

function controlDatabase(roles: string[], conflict = false) {
  const statements: string[] = [];
  const query: SqlExecutor['query'] = async <Row>(sql: string): Promise<SqlResult<Row>> => {
    statements.push(sql);
    let rows: unknown[] = [];
    if (sql.includes('FROM saas_platform_sessions')) rows = [{ session_id: 'session-a', roles }];
    else if (sql.startsWith('UPDATE saas_payment_control') && !conflict) rows = [{ mode: 'draining', active_binding_id: 'merchant-a', revision: '8' }];
    else if (sql.includes('SELECT id FROM saas_payment_merchant_bindings')) rows = [{ id: 'merchant-a' }];
    return { rows: rows as Row[], rowCount: rows.length };
  };
  return { statements, query, transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> => work({ query }) };
}
const controlInput = { expectedRevision: '7', mode: 'draining' as const, activeBindingId: 'merchant-a', actorId: 'actor-a', sessionId: 'session-a', actorRoles: ['operations'] };

test('control changes require the same live operations authority and audit the CAS result', async () => {
  const resolver = new ReadonlyPaymentBindingResolver([loaded()]);
  const revoked = controlDatabase(['support-readonly']);
  await assert.rejects(setPaymentControl(revoked, resolver, controlInput), code('PAYMENT_CONTROL_FORBIDDEN'));
  assert.equal(revoked.statements.some(sql => sql.startsWith('UPDATE saas_payment_control')), false);
  const valid = controlDatabase(['operations']);
  assert.equal((await setPaymentControl(valid, resolver, controlInput)).revision, '8');
  assert.ok(valid.statements.some(sql => sql.includes('revision=$1::bigint')));
  assert.ok(valid.statements.some(sql => sql.includes('INSERT INTO saas_audit_events')));
});

test('stale control revision fails without appending a successful transition audit', async () => {
  const db = controlDatabase(['operations'], true);
  await assert.rejects(setPaymentControl(db, new ReadonlyPaymentBindingResolver([loaded()]), controlInput), code('PAYMENT_CONTROL_CONFLICT'));
  assert.equal(db.statements.some(sql => sql.includes('INSERT INTO saas_audit_events')), false);
});

test('original POST fingerprint rejects changed promo and never infers missing historical payload', async () => {
  const { service, db } = await historicalFixture();
  await assert.rejects(service.createWalletTopUp({ tenantId: 'tenant-a', clientRequestId: 'request-a', amountMinorUnits: '125', currency: 'CNY', promoCode: 'NEW-PROMO' }), code('IDEMPOTENCY_CONFLICT'));
  db.state.orders[0]!.create_request_fingerprint = null;
  await assert.rejects(service.createWalletTopUp({ tenantId: 'tenant-a', clientRequestId: 'request-a', amountMinorUnits: '125', currency: 'CNY' }), code('IDEMPOTENCY_CONFLICT'));
});
