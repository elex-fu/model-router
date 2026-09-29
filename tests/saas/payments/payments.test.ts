import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import type { PaymentCheckoutOptions, PaymentServiceOptions } from '../../../src/saas/payments/types.js';
import { createFakeFundingLedger, FakePaymentDatabase, FakePaymentProvider, successWebhook } from './fake-sql.js';

const merchantId = 'merchant-test-1';

function createFixture(
  checkout?: PaymentCheckoutOptions,
  paymentOptions: Pick<PaymentServiceOptions, 'maxProviderAttempts' | 'retryCooldownMs'> = {},
) {
  const database = new FakePaymentDatabase();
  const provider = new FakePaymentProvider();
  const ledger = createFakeFundingLedger(database);
  const clock = { value: new Date('2026-09-28T00:00:00.000Z') };
  let nextId = 0;
  const service = new PaymentFulfillmentService(database, provider, {
    providerKey: provider.providerKey,
    merchantId,
    now: () => new Date(clock.value.getTime()),
    idFactory: () => `order-${++nextId}`,
    walletFundingLedger: ledger,
    checkout,
    ...paymentOptions,
  });
  return { database, provider, ledger, clock, service };
}

async function createOrder(
  fixture: ReturnType<typeof createFixture>,
  tenantId = 'tenant-a',
  clientRequestId = 'request-1',
  amountMinorUnits = '125',
) {
  return fixture.service.createWalletTopUp({
    tenantId,
    clientRequestId,
    amountMinorUnits,
    currency: 'USD',
  });
}

test('creates a provider order outside the database transaction and replays tenant/client idempotency', async () => {
  const fixture = createFixture();
  const originalCreate = fixture.provider.createOrder.bind(fixture.provider);
  fixture.provider.createOrder = async (input) => {
    assert.equal(fixture.database.inTransaction, false);
    return originalCreate(input);
  };

  const first = await createOrder(fixture);
  const replay = await createOrder(fixture);

  assert.equal(first.status, 'pending');
  assert.equal(replay.id, first.id);
  assert.equal(fixture.provider.calls.length, 1);
  assert.equal(fixture.provider.calls[0]?.idempotencyReference, first.id);
  assert.equal(fixture.provider.calls[0]?.localOrderId, first.id);
  assert.equal(fixture.provider.calls[0]?.amountMinorUnits, '125');
  assert.equal(fixture.database.state.orders[0]?.funding_reference, first.id);

  await assert.rejects(
    createOrder(fixture, 'tenant-a', 'request-1', '126'),
    (error: unknown) => error instanceof PaymentError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(fixture.provider.calls.length, 1);
});

test('fences generic provider timeout as unknown acceptance and never retries it', async () => {
  const fixture = createFixture();
  fixture.provider.shouldFailCreate = true;
  const unknown = await createOrder(fixture);
  assert.equal(unknown.status, 'reconciliation_pending');
  assert.equal(unknown.providerFailureCode, 'PROVIDER_ACCEPTANCE_UNKNOWN');
  assert.equal(fixture.database.state.funding.length, 0);

  fixture.provider.shouldFailCreate = false;
  await assert.rejects(
    fixture.service.retryProviderOrder({ tenantId: 'tenant-a', orderId: unknown.id }),
    (error: unknown) => error instanceof PaymentError && error.code === 'ORDER_STATE_CONFLICT',
  );
  assert.equal(fixture.provider.calls.length, 1);
});

test('retries only an explicitly safe rejection with cooldown and a bounded attempt count', async () => {
  const fixture = createFixture(undefined, { maxProviderAttempts: 2, retryCooldownMs: 1_000 });
  fixture.provider.safeRejectCreate = true;
  const first = await createOrder(fixture);
  assert.equal(first.status, 'provider_failed');
  assert.equal(first.providerFailureCode, 'PROVIDER_CREATE_REJECTED');
  assert.equal(first.providerAttempts, 1);

  fixture.provider.safeRejectCreate = false;
  const duringCooldown = await createOrder(fixture);
  assert.equal(duringCooldown.status, 'provider_failed');
  assert.equal(fixture.provider.calls.length, 1);

  fixture.clock.value = new Date(fixture.clock.value.getTime() + 1_000);
  fixture.provider.safeRejectCreate = true;
  const bounded = await createOrder(fixture);
  assert.equal(bounded.status, 'provider_failed');
  assert.equal(bounded.providerFailureCode, 'PROVIDER_RETRY_LIMIT');
  assert.equal(bounded.providerAttempts, 2);
  assert.equal(fixture.provider.calls.length, 2);

  fixture.provider.safeRejectCreate = false;
  fixture.clock.value = new Date(fixture.clock.value.getTime() + 1_000);
  await assert.rejects(
    fixture.service.retryProviderOrder({ tenantId: 'tenant-a', orderId: bounded.id }),
    (error: unknown) => error instanceof PaymentError && error.code === 'ORDER_STATE_CONFLICT',
  );
  assert.equal(fixture.provider.calls.length, 2);
});

test('uses the immutable wallet provider and merchant snapshot as the retry fence', async () => {
  const fixture = createFixture();
  fixture.provider.safeRejectCreate = true;
  const failed = await createOrder(fixture);

  const staleMerchantProvider = new FakePaymentProvider();
  const staleMerchantService = new PaymentFulfillmentService(fixture.database, staleMerchantProvider, {
    providerKey: staleMerchantProvider.providerKey,
    merchantId: 'merchant-stale',
    now: () => new Date(fixture.clock.value.getTime()),
  });
  await assert.rejects(
    staleMerchantService.retryProviderOrder({ tenantId: 'tenant-a', orderId: failed.id }),
    (error: unknown) => error instanceof PaymentError && error.code === 'ORDER_STATE_CONFLICT',
  );
  assert.equal(staleMerchantProvider.calls.length, 0);

  const staleProvider = new FakePaymentProvider('different-psp');
  const staleProviderService = new PaymentFulfillmentService(fixture.database, staleProvider, {
    providerKey: staleProvider.providerKey,
    merchantId,
    now: () => new Date(fixture.clock.value.getTime()),
  });
  await assert.rejects(
    staleProviderService.retryProviderOrder({ tenantId: 'tenant-a', orderId: failed.id }),
    (error: unknown) => error instanceof PaymentError && error.code === 'ORDER_STATE_CONFLICT',
  );
  assert.equal(staleProvider.calls.length, 0);
});

test('verifies a normalized webhook, fulfills exactly once, and keeps the funding reference unique', async () => {
  const fixture = createFixture();
  const order = await createOrder(fixture);
  const providerOrderId = order.providerOrderId;
  assert.ok(providerOrderId);

  const first = await fixture.service.handleWebhook(
    { 'x-test-signature': 'verified-by-fixture' },
    successWebhook(providerOrderId, 'tenant-a', 'event-1', '125'),
  );
  const replay = await fixture.service.handleWebhook(
    { 'x-test-signature': 'verified-by-fixture' },
    successWebhook(providerOrderId, 'tenant-a', 'event-1', '125'),
  );

  assert.equal(first.outcome, 'accepted');
  assert.equal(first.replayed, false);
  assert.equal(replay.outcome, 'accepted');
  assert.equal(replay.replayed, true);
  assert.equal(fixture.database.state.orders[0]?.state, 'pending');
  assert.equal(fixture.database.state.funding.length, 0);
  assert.equal((await fixture.service.processPendingWebhooks()).processed, 1);
  const completedReplay = await fixture.service.handleWebhook(
    { 'x-test-signature': 'verified-by-fixture' },
    successWebhook(providerOrderId, 'tenant-a', 'event-1', '125'),
  );
  assert.equal(completedReplay.outcome, 'fulfilled');
  assert.equal(completedReplay.replayed, true);
  assert.equal(fixture.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.inbox.length, 1);
  assert.equal(fixture.database.state.funding.length, 1);
  assert.deepEqual(fixture.database.state.funding[0], {
    transactionId: 'funding-1',
    tenantId: 'tenant-a',
    currency: 'USD',
    amountMinorUnits: '125',
    sourceOrderRef: order.id,
  });
  assert.equal(fixture.database.state.orders[0]?.funding_transaction_id, 'funding-1');
  assert.equal(fixture.database.state.fundingCalls, 1);
  assert.equal(fixture.ledger.calls[0]?.sourceOrderRef, order.id);
  const fulfilled = await fixture.service.getWalletTopUp({ tenantId: 'tenant-a', orderId: order.id });
  assert.equal(fulfilled?.status, 'fulfilled');
  assert.equal(fulfilled?.fundingTransactionId, 'funding-1');
  assert.equal(fixture.database.state.servicePlanOrders.length, 0);
  assert.doesNotMatch(JSON.stringify(fixture.database.state), /verified-by-fixture/);
});

test('tenant, amount, and currency mismatches persist reconciliation without crediting another tenant', async () => {
  const fixture = createFixture();
  const order = await createOrder(fixture, 'tenant-b', 'request-b', '50');
  assert.ok(order.providerOrderId);

  const wrongTenant = await fixture.service.handleWebhook(
    {},
    successWebhook(order.providerOrderId, 'tenant-a', 'event-wrong-tenant', '50'),
  );
  assert.equal(wrongTenant.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[0]?.processing_outcome, 'reconciliation');
  assert.equal(fixture.database.state.orders[0]?.state, 'pending');
  assert.equal(fixture.database.state.funding.length, 0);

  const wrongAmount = await fixture.service.handleWebhook(
    {},
    successWebhook(order.providerOrderId, 'tenant-b', 'event-wrong-amount', '51'),
  );
  assert.equal(wrongAmount.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[1]?.processing_outcome, 'reconciliation');
  assert.equal(fixture.database.state.inbox.length, 2);
  assert.equal(fixture.database.state.funding.length, 0);

  const wrongCurrency = await fixture.service.handleWebhook(
    {},
    successWebhook(order.providerOrderId, 'tenant-b', 'event-wrong-currency', '50', 'EUR'),
  );
  assert.equal(wrongCurrency.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[2]?.processing_outcome, 'reconciliation');
  assert.equal(fixture.database.state.inbox.length, 3);
  assert.equal(fixture.database.state.orders[0]?.state, 'pending');
});

test('ledger failure rolls back order and inbox changes, then a retry can fulfill safely', async () => {
  const fixture = createFixture();
  const order = await createOrder(fixture);
  assert.ok(order.providerOrderId);
  fixture.ledger.shouldFail = true;

  const accepted = await fixture.service.handleWebhook(
    {},
    successWebhook(order.providerOrderId, 'tenant-a', 'event-retry', '125'),
  );
  assert.equal(accepted.outcome, 'accepted');
  const failedBatch = await fixture.service.processPendingWebhooks();
  assert.equal(failedBatch.retrying, 1);
  assert.equal(fixture.database.state.orders[0]?.state, 'pending');
  assert.equal(fixture.database.state.inbox.length, 1);
  assert.equal(fixture.database.state.funding.length, 0);

  fixture.ledger.shouldFail = false;
  fixture.clock.value = new Date(fixture.clock.value.getTime() + 1_000);
  const retryBatch = await fixture.service.processPendingWebhooks();
  assert.equal(retryBatch.processed, 1);
  assert.equal(fixture.database.state.inbox[0]?.processing_outcome, 'fulfilled');
  assert.equal(fixture.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.inbox.length, 1);
  assert.equal(fixture.database.state.funding.length, 1);
  assert.equal(fixture.database.state.fundingCalls, 1);
  assert.equal(fixture.ledger.calls.length, 2);
});

test('durable inbox retries a webhook briefly when provider-order persistence races the callback', async () => {
  const fixture = createFixture();
  const order = await createOrder(fixture);
  const providerOrderId = order.providerOrderId;
  assert.ok(providerOrderId);
  const storedOrder = fixture.database.state.orders[0];
  assert.ok(storedOrder);
  storedOrder.provider_order_id = null;

  const receipt = await fixture.service.handleWebhook(
    {},
    successWebhook(providerOrderId, 'tenant-a', 'event-order-race', '125'),
  );
  assert.equal(receipt.outcome, 'accepted');
  assert.equal(fixture.database.state.funding.length, 0);
  assert.equal((await fixture.service.processPendingWebhooks()).retrying, 1);
  assert.equal(fixture.database.state.inbox[0]?.processing_state, 'pending');

  const currentOrder = fixture.database.state.orders[0];
  assert.ok(currentOrder);
  currentOrder.provider_order_id = providerOrderId;
  fixture.clock.value = new Date(fixture.clock.value.getTime() + 1_000);
  assert.equal((await fixture.service.processPendingWebhooks()).processed, 1);
  assert.equal(fixture.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.funding.length, 1);
});

test('rejects invalid signatures, conflicting event replays, and late success transitions', async () => {
  const fixture = createFixture();
  const order = await createOrder(fixture);
  assert.ok(order.providerOrderId);
  fixture.provider.shouldRejectWebhook = true;
  await assert.rejects(
    fixture.service.handleWebhook({}, successWebhook(order.providerOrderId, 'tenant-a', 'event-invalid', '125')),
    (error: unknown) => error instanceof PaymentError && error.code === 'WEBHOOK_REJECTED',
  );
  assert.equal(fixture.database.state.inbox.length, 0);

  fixture.provider.shouldRejectWebhook = false;
  await fixture.service.handleWebhook({}, successWebhook(order.providerOrderId, 'tenant-a', 'event-conflict', '125'));
  await fixture.service.processPendingWebhooks();
  await assert.rejects(
    fixture.service.handleWebhook({}, successWebhook(order.providerOrderId, 'tenant-a', 'event-conflict', '126')),
    (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_EVENT_CONFLICT',
  );
  assert.equal(fixture.database.state.funding.length, 1);

  const late = await fixture.service.handleWebhook(
    {},
    successWebhook(order.providerOrderId, 'tenant-a', 'event-late', '125'),
  );
  assert.equal(late.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[1]?.processing_outcome, 'reconciliation');
  assert.equal(fixture.database.state.funding.length, 1);

  const cancelledFixture = createFixture();
  const cancelledOrder = await createOrder(cancelledFixture);
  assert.ok(cancelledOrder.providerOrderId);
  const cancelled = await cancelledFixture.service.handleWebhook(
    {},
    successWebhook(cancelledOrder.providerOrderId, 'tenant-a', 'event-cancelled', '125', 'USD', 'cancelled'),
  );
  assert.equal(cancelled.outcome, 'accepted');
  await cancelledFixture.service.processPendingWebhooks();
  assert.equal(cancelledFixture.database.state.inbox[0]?.processing_outcome, 'rejected');
  const lateCancelled = await cancelledFixture.service.handleWebhook(
    {},
    successWebhook(cancelledOrder.providerOrderId, 'tenant-a', 'event-late-success', '125'),
  );
  assert.equal(lateCancelled.outcome, 'accepted');
  await cancelledFixture.service.processPendingWebhooks();
  assert.equal(cancelledFixture.database.state.inbox[1]?.processing_outcome, 'reconciliation');
  assert.equal(cancelledFixture.database.state.orders[0]?.state, 'reconciliation_pending');
  assert.equal(cancelledFixture.database.state.funding.length, 0);
});

test('does not disclose a raw provider payload through the persisted inbox shape', async () => {
  const fixture = createFixture();
  const order = await createOrder(fixture);
  assert.ok(order.providerOrderId);
  const raw = successWebhook(order.providerOrderId, 'tenant-a', 'event-minimal', '125');
  const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  payload.secret = 'raw-provider-secret-must-not-persist';
  await fixture.service.handleWebhook({}, Buffer.from(JSON.stringify(payload)));
  assert.doesNotMatch(JSON.stringify(fixture.database.state.inbox), /raw-provider-secret/);
  assert.deepEqual(Object.keys(fixture.database.state.inbox[0] ?? {}).sort(), [
    'amount_minor_units',
    'attempt_count',
    'currency',
    'event_status',
    'event_tenant_id',
    'event_type',
    'id',
    'last_error_code',
    'lease_expires_at',
    'lease_token',
    'local_order_id',
    'merchant_id',
    'next_attempt_at',
    'occurred_at',
    'outcome_code',
    'processed_at',
    'processing_outcome',
    'processing_state',
    'provider_event_id',
    'provider_key',
    'provider_order_id',
    'received_at',
    'tenant_id',
    'updated_at',
  ]);
});

test('returns a constrained checkout action, expires only the action, and refreshes the same provider order', async () => {
  const fixture = createFixture({
    redirectPolicies: [{ providerKey: 'fake-psp', origin: 'https://pay.example', pathPrefixes: ['/checkout'] }],
  });
  fixture.provider.checkoutAction = {
    kind: 'redirect',
    url: 'https://pay.example/checkout/provider-order-1',
    expiresAt: '2026-09-28T00:05:00.000Z',
  };
  const order = await createOrder(fixture);
  assert.deepEqual(order.checkout, {
    status: 'ready',
    action: {
      kind: 'redirect',
      url: 'https://pay.example/checkout/provider-order-1',
      expiresAt: '2026-09-28T00:05:00.000Z',
    },
  });

  fixture.clock.value = new Date('2026-09-28T00:06:00.000Z');
  const expired = await fixture.service.getWalletTopUp({ tenantId: 'tenant-a', orderId: order.id });
  assert.equal(expired?.checkout.status, 'expired');
  assert.equal(expired?.status, 'pending');

  fixture.provider.refreshedCheckoutAction = {
    kind: 'qr',
    text: 'weixin://wxpay/bounded-payment-token',
    expiresAt: '2026-09-28T00:10:00.000Z',
  };
  const refreshed = await fixture.service.refreshWalletTopUpCheckout({ tenantId: 'tenant-a', orderId: order.id });
  assert.deepEqual(refreshed.checkout, {
    status: 'ready',
    action: {
      kind: 'qr',
      text: 'weixin://wxpay/bounded-payment-token',
      expiresAt: '2026-09-28T00:10:00.000Z',
    },
  });
  assert.deepEqual(fixture.provider.refreshCalls, ['provider-order-1']);
  assert.equal(fixture.provider.calls.length, 1);

  const settled = await fixture.service.handleWebhook(
    {},
    successWebhook(order.providerOrderId, 'tenant-a', 'checkout-settlement', '125'),
  );
  assert.equal(settled.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[0]?.processing_outcome, 'fulfilled');
  assert.equal(fixture.database.state.orders[0]?.state, 'fulfilled');
  assert.equal(
    (await fixture.service.getWalletTopUp({ tenantId: 'tenant-a', orderId: order.id }))?.checkout.status,
    'closed',
  );
});

test('does not expose redirects without policy or unsafe QR payloads', async () => {
  const noPolicy = createFixture();
  noPolicy.provider.checkoutAction = {
    kind: 'redirect',
    url: 'https://pay.example/checkout/provider-order-1',
    expiresAt: '2026-09-28T00:05:00.000Z',
  };
  assert.equal((await createOrder(noPolicy)).checkout.status, 'unavailable');

  const unsafe = createFixture({
    redirectPolicies: [{ providerKey: 'fake-psp', origin: 'https://pay.example', pathPrefixes: ['/checkout'] }],
  });
  unsafe.provider.checkoutAction = {
    kind: 'qr',
    text: '<img src="https://evil.example/qr.png">',
    expiresAt: '2026-09-28T00:05:00.000Z',
  };
  assert.equal((await createOrder(unsafe)).checkout.status, 'unavailable');
});

test('fences overlapping creation retries and fails closed on unknown provider acceptance', async () => {
  const fixture = createFixture();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  fixture.provider.createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.provider.createStarted = started;

  const first = fixture.service.createWalletTopUp({
    tenantId: 'tenant-a',
    clientRequestId: 'parallel-request',
    amountMinorUnits: '125',
    currency: 'USD',
  });
  await startedPromise;
  const overlapping = await fixture.service.createWalletTopUp({
    tenantId: 'tenant-a',
    clientRequestId: 'parallel-request',
    amountMinorUnits: '125',
    currency: 'USD',
  });
  assert.equal(overlapping.checkout.status, 'pending');
  assert.equal(fixture.provider.calls.length, 1);
  release();
  await first;

  const ambiguous = createFixture();
  ambiguous.provider.unknownCreateAcceptance = true;
  const fenced = await createOrder(ambiguous);
  assert.equal(fenced.status, 'reconciliation_pending');
  assert.equal(fenced.checkout.status, 'closed');
  await assert.rejects(
    ambiguous.service.retryProviderOrder({ tenantId: 'tenant-a', orderId: fenced.id }),
    (error: unknown) => error instanceof PaymentError && error.code === 'ORDER_STATE_CONFLICT',
  );
  assert.equal(ambiguous.provider.calls.length, 1);
});
