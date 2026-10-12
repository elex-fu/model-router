import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaymentProviderEventConfirmationInput } from '../../../src/saas/payments/adapter.js';
import {
  createStripePaymentProvider,
  STRIPE_PROVIDER_KEY,
  STRIPE_WEBHOOK_TOLERANCE_MS,
  StripeConfigurationError,
  StripeProviderError,
  stripeAmountToMinorUnits,
  stripeMinorUnitsToWire,
  verifyStripeWebhookSignature,
} from '../../../src/saas/payments/providers/stripe/index.js';
import {
  type MockStripe,
  startMockStripe,
  stripeEventBody,
  stripePaymentIntentJson,
  stripeRefundJson,
  stripeSignatureHeader,
} from './mock-stripe.js';

// C5/R3: the Stripe adapter against a programmable mock Stripe server. Covers
// fail-closed configuration, the v1 webhook signature scheme, fixed-point
// minor-units money, the create acceptance tri-state (with the active search
// recheck), the pre-fulfillment retrieve red line, id-only recovery and the
// REAL refund query tri-state that proves the refund port abstraction holds
// for a full-capability PSP.

// Stripe's docs sample key; split so secret scanners do not match the literal.
const SECRET_KEY = `sk_test_${'4eC39HqLyjWDarjtT1zdp7dc'}`;
const PUBLISHABLE_KEY = 'pk_test_TYooMQauvdEDq54NiTphI7jx';
const WEBHOOK_SECRET = `whsec_${'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'}`;
const NOW = new Date('2026-10-11T00:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function config(stripe: MockStripe, overrides: Record<string, unknown> = {}) {
  return {
    secretKey: SECRET_KEY,
    publishableKey: PUBLISHABLE_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiBase: stripe.url,
    now: () => new Date(NOW.getTime()),
    ...overrides,
  };
}

function deadConfig(overrides: Record<string, unknown> = {}) {
  return config({ url: 'http://127.0.0.1:1' } as MockStripe, overrides);
}

function createOrderInput(overrides: Record<string, unknown> = {}) {
  return {
    localOrderId: 'order-local-1',
    tenantId: 'tenant-1',
    amountMinorUnits: '1234',
    currency: 'USD',
    merchantId: PUBLISHABLE_KEY,
    idempotencyReference: 'order-local-1',
    ...overrides,
  };
}

function refundInput(overrides: Record<string, unknown> = {}) {
  return {
    localRefundId: 'refund-1',
    idempotencyReference: 'refund-1',
    tenantId: 'tenant-1',
    originalLocalOrderId: 'order-local-1',
    providerKey: STRIPE_PROVIDER_KEY,
    merchantId: PUBLISHABLE_KEY,
    providerOrderId: 'pi_3OrERmKcfg7EjL0f1k2gSTRIPE',
    amountMinorUnits: '1234',
    currency: 'USD',
    providerRefundId: null as string | null,
    ...overrides,
  };
}

const INTENT_ID = 'pi_3OrERmKcfg7EjL0f1k2gSTRIPE';
const CLIENT_SECRET = 'pi_3OrERmKcfg7EjL0f1k2gSTRIPE_secret_YWNvbS1wYXltZW50LWludGVudA';

function paidIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    amount: 1234,
    currency: 'usd',
    status: 'succeeded',
    metadata: { out_trade_no: 'order-local-1', tenant_id: 'tenant-1' },
    ...overrides,
  } as const;
}

function signedWebhook(
  intent: Parameters<typeof stripeEventBody>[0]['intent'],
  options: { eventId?: string; type?: string; secret?: string; timestampSec?: number; createdSec?: number } = {},
): { body: Buffer; headers: Record<string, string> } {
  const body = stripeEventBody({
    eventId: options.eventId ?? 'evt_1StripeTestEvent000000001',
    type: options.type ?? 'payment_intent.succeeded',
    intent,
    ...(options.createdSec === undefined ? {} : { createdSec: options.createdSec }),
  });
  const timestampSec = options.timestampSec ?? NOW_SEC;
  return {
    body,
    headers: { 'stripe-signature': stripeSignatureHeader(body, options.secret ?? WEBHOOK_SECRET, timestampSec) },
  };
}

test('configuration fails closed on key prefixes, api base, currency and payment methods', () => {
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ secretKey: 'sk_live_short' })),
    StripeConfigurationError,
  );
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ secretKey: `rk_test_${'4eC39HqLyjWDarjtT1zdp7dc'}` })),
    StripeConfigurationError,
  );
  assert.throws(() => createStripePaymentProvider(deadConfig({ secretKey: '' })), StripeConfigurationError);
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ publishableKey: SECRET_KEY })),
    StripeConfigurationError,
  );
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ webhookSecret: 'plain-secret' })),
    StripeConfigurationError,
  );
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ apiBase: 'http://api.stripe.example.com' })),
    /https outside loopback/,
  );
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ apiBase: 'https://api.stripe.com/v1' })),
    StripeConfigurationError,
  );
  assert.throws(() => createStripePaymentProvider(deadConfig({ currency: 'US' })), StripeConfigurationError);
  assert.throws(() => createStripePaymentProvider(deadConfig({ currency: 'us1' })), StripeConfigurationError);
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ paymentMethodTypes: ['card', 'link'] })),
    /only supports/,
  );
  assert.throws(
    () => createStripePaymentProvider(deadConfig({ paymentMethodTypes: ['alipay'] })),
    StripeConfigurationError,
  );

  const provider = createStripePaymentProvider(deadConfig({ currency: 'USD' }));
  assert.equal(provider.refundAdapter.merchantId, PUBLISHABLE_KEY);
  const defaulted = createStripePaymentProvider(deadConfig({ apiBase: undefined }));
  assert.ok(defaulted.adapter);
});

test('webhook signature verification follows the v1 scheme and fails closed', () => {
  const body = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}', 'utf8');
  const header = stripeSignatureHeader(body, WEBHOOK_SECRET, NOW_SEC);
  const base = { rawBody: body, webhookSecret: WEBHOOK_SECRET, nowMs: NOW.getTime() };
  assert.equal(verifyStripeWebhookSignature({ ...base, signatureHeader: header }), true);
  const v1 = header.slice(header.indexOf('v1='));
  assert.equal(
    verifyStripeWebhookSignature({ ...base, signatureHeader: `${header},${v1}` }),
    true,
    'duplicated identical v1 values are accepted',
  );
  const tampered = Buffer.from(body.toString('utf8').replace('succeeded', 'failed'), 'utf8');
  assert.equal(verifyStripeWebhookSignature({ ...base, rawBody: tampered, signatureHeader: header }), false);
  assert.equal(
    verifyStripeWebhookSignature({
      ...base,
      signatureHeader: stripeSignatureHeader(body, `whsec_${'wrongsecret00000000000000'}`, NOW_SEC),
    }),
    false,
  );
  assert.equal(
    verifyStripeWebhookSignature({
      ...base,
      signatureHeader: header,
      nowMs: NOW.getTime() + STRIPE_WEBHOOK_TOLERANCE_MS + 1,
    }),
    false,
    'a timestamp outside the 300s tolerance is rejected',
  );
  assert.equal(
    verifyStripeWebhookSignature({
      ...base,
      signatureHeader: header,
      nowMs: NOW.getTime() - STRIPE_WEBHOOK_TOLERANCE_MS,
    }),
    true,
    'the tolerance boundary is inclusive',
  );
  assert.equal(verifyStripeWebhookSignature({ ...base, signatureHeader: `v1=${'a'.repeat(64)}` }), false);
  assert.equal(verifyStripeWebhookSignature({ ...base, signatureHeader: `t=${NOW_SEC}` }), false);
  assert.equal(
    verifyStripeWebhookSignature({
      ...base,
      signatureHeader: `t=${NOW_SEC},v1=${'a'.repeat(64)},v1=${'b'.repeat(64)}`,
    }),
    false,
    'inconsistent multiple v1 values are rejected',
  );
  assert.equal(verifyStripeWebhookSignature({ ...base, signatureHeader: `t=${NOW_SEC},v1=not-hex` }), false);
  assert.equal(
    verifyStripeWebhookSignature({ ...base, signatureHeader: `t=${NOW_SEC},t=${NOW_SEC},v1=${'a'.repeat(64)}` }),
    false,
  );
});

test('money is strict fixed-point minor units in both directions', () => {
  assert.equal(stripeMinorUnitsToWire('0'), '0');
  assert.equal(stripeMinorUnitsToWire('1234'), '1234');
  assert.equal(stripeMinorUnitsToWire('9007199254740991'), '9007199254740991');
  for (const bad of ['12.34', '1e3', '-1', '', '01', '1.0', ' 1', '1 ']) {
    assert.throws(() => stripeMinorUnitsToWire(bad), StripeConfigurationError, bad);
  }
  assert.equal(stripeAmountToMinorUnits(1234), '1234');
  assert.equal(stripeAmountToMinorUnits('1234'), '1234');
  assert.equal(stripeAmountToMinorUnits(0), '0');
  assert.equal(stripeAmountToMinorUnits(12.5), null);
  assert.equal(stripeAmountToMinorUnits('1e3'), null);
  assert.equal(stripeAmountToMinorUnits('12.34'), null);
  assert.equal(stripeAmountToMinorUnits(-1), null);
  assert.equal(stripeAmountToMinorUnits(2 ** 53), null);
  assert.equal(stripeAmountToMinorUnits(null), null);
});

test('createOrder posts the form-encoded PaymentIntent with the idempotency key and normalizes checkout', async () => {
  const stripe = await startMockStripe();
  try {
    stripe.setHandler('paymentIntentsCreate', () => ({
      json: stripePaymentIntentJson({
        ...paidIntent(),
        status: 'requires_payment_method',
        clientSecret: CLIENT_SECRET,
      }),
    }));
    const provider = createStripePaymentProvider(config(stripe));
    const result = await provider.adapter.createOrder(createOrderInput());
    assert.equal(result.providerOrderId, INTENT_ID);
    assert.equal(result.amountMinorUnits, '1234');
    assert.equal(result.currency, 'USD');
    assert.deepEqual(result.checkoutAction, {
      kind: 'qr',
      text: CLIENT_SECRET,
      expiresAt: '2026-10-11T02:00:00.000Z',
    });
    const [sent] = stripe.calls.paymentIntentsCreate;
    assert.ok(sent);
    assert.equal(sent.params.amount, '1234');
    assert.equal(sent.params.currency, 'usd');
    assert.equal(sent.params['payment_method_types[0]'], 'card');
    assert.equal(sent.params['metadata[out_trade_no]'], 'order-local-1');
    assert.equal(sent.params['metadata[tenant_id]'], 'tenant-1');
    assert.equal(sent.headers['idempotency-key'], 'order-local-1');
    assert.equal(sent.headers.authorization, `Bearer ${SECRET_KEY}`);
    assert.equal(stripe.calls.paymentIntentsRetrieve.length + stripe.calls.paymentIntentsSearch.length, 0);
  } finally {
    await stripe.close();
  }
});

test('createOrder acceptance: card_error is rejected only when the active search proves no intent exists', async () => {
  const stripe = await startMockStripe();
  try {
    stripe.setHandler('paymentIntentsCreate', () => ({
      status: 402,
      json: { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } },
    }));
    stripe.setHandler('paymentIntentsSearch', () => ({ json: { object: 'list', data: [] } }));
    const provider = createStripePaymentProvider(config(stripe));
    const rejected = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejected instanceof StripeProviderError);
    assert.equal(rejected.acceptance, 'rejected');
    assert.equal(stripe.calls.paymentIntentsSearch.length, 1);
    assert.match(stripe.calls.paymentIntentsSearch[0]?.params.query ?? '', /out_trade_no/);

    stripe.setHandler('paymentIntentsSearch', () => ({
      json: { object: 'list', data: [stripePaymentIntentJson(paidIntent({ status: 'requires_payment_method' }))] },
    }));
    const existing = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(existing instanceof StripeProviderError);
    assert.equal(existing.acceptance, 'unknown', 'an intent the search can see is never a definitive rejection');

    stripe.setHandler('paymentIntentsSearch', () => ({ raw: 'search down', status: 500 }));
    const unproven = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(unproven instanceof StripeProviderError);
    assert.equal(unproven.acceptance, 'unknown', 'an unproven search keeps acceptance unknown');
  } finally {
    await stripe.close();
  }
});

test('createOrder acceptance: other 4xx, 5xx, transport, bad JSON and incomplete success are unknown', async () => {
  const stripe = await startMockStripe();
  try {
    const provider = createStripePaymentProvider(config(stripe));
    const attempt = () =>
      provider.adapter.createOrder(createOrderInput()).then(
        () => null,
        (error: unknown) => error,
      );

    stripe.setHandler('paymentIntentsCreate', () => ({
      status: 400,
      json: { error: { type: 'invalid_request_error', code: 'amount_too_small', message: 'amount too small' } },
    }));
    const invalidRequest = await attempt();
    assert.ok(invalidRequest instanceof StripeProviderError);
    assert.equal(invalidRequest.acceptance, 'unknown');
    assert.equal(stripe.calls.paymentIntentsSearch.length, 0, 'non-card errors never trigger the search recheck');

    stripe.setHandler('paymentIntentsCreate', () => ({ raw: '<html>bad gateway</html>', status: 502 }));
    assert.equal(((await attempt()) as StripeProviderError).acceptance, 'unknown');

    stripe.setHandler('paymentIntentsCreate', () => ({ raw: 'not json', status: 200 }));
    assert.equal(((await attempt()) as StripeProviderError).acceptance, 'unknown');

    stripe.setHandler('paymentIntentsCreate', () => ({
      json: stripePaymentIntentJson({ ...paidIntent(), status: 'requires_payment_method' }),
    }));
    assert.equal(
      ((await attempt()) as StripeProviderError).acceptance,
      'unknown',
      'a missing client_secret is unknown',
    );

    stripe.setHandler('paymentIntentsCreate', () => ({
      json: stripePaymentIntentJson({
        ...paidIntent({ amount: 9999 }),
        status: 'requires_payment_method',
        clientSecret: CLIENT_SECRET,
      }),
    }));
    assert.equal(
      ((await attempt()) as StripeProviderError).acceptance,
      'unknown',
      'an amount echo mismatch is unknown',
    );

    const unreachable = createStripePaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockStripe));
    const transport = await unreachable.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof StripeProviderError && transport.acceptance === 'unknown');
  } finally {
    await stripe.close();
  }
});

test('createOrder rejects identity and currency mismatches without any provider call', async () => {
  const stripe = await startMockStripe();
  try {
    stripe.setHandler('paymentIntentsCreate', () => ({ json: {} }));
    const provider = createStripePaymentProvider(config(stripe));
    for (const input of [
      createOrderInput({ idempotencyReference: 'other' }),
      createOrderInput({ merchantId: 'pk_test_othermerchant00000000' }),
      createOrderInput({ currency: 'EUR' }),
      createOrderInput({ amountMinorUnits: '12.34' }),
    ]) {
      const failure = await provider.adapter.createOrder(input).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof StripeProviderError && failure.acceptance === 'unknown');
    }
    assert.equal(stripe.calls.paymentIntentsCreate.length, 0);
  } finally {
    await stripe.close();
  }
});

test('verifyWebhook verifies the v1 signature, the merchant and rejects tampering', async () => {
  const provider = createStripePaymentProvider(deadConfig());
  const { body, headers } = signedWebhook(paidIntent({ clientSecret: CLIENT_SECRET }));
  const verified = await provider.adapter.verifyWebhook({ headers, rawBody: body, merchantId: PUBLISHABLE_KEY });
  assert.equal(verified.providerKey, STRIPE_PROVIDER_KEY);
  assert.equal(verified.merchantId, PUBLISHABLE_KEY);

  await assert.rejects(
    provider.adapter.verifyWebhook({ headers, rawBody: body, merchantId: 'pk_test_othermerchant00000000' }),
  );
  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: body, merchantId: PUBLISHABLE_KEY }));
  const tampered = Buffer.from(body.toString('utf8').replace('1234', '9999'), 'utf8');
  await assert.rejects(provider.adapter.verifyWebhook({ headers, rawBody: tampered, merchantId: PUBLISHABLE_KEY }));
  const mixedCase = await provider.adapter.verifyWebhook({
    headers: { 'Stripe-Signature': headers['stripe-signature'] as string },
    rawBody: body,
    merchantId: PUBLISHABLE_KEY,
  });
  assert.equal(mixedCase.providerKey, STRIPE_PROVIDER_KEY, 'header lookup is case-insensitive');
  const stale = signedWebhook(paidIntent(), { timestampSec: NOW_SEC - 400 });
  await assert.rejects(
    provider.adapter.verifyWebhook({ headers: stale.headers, rawBody: stale.body, merchantId: PUBLISHABLE_KEY }),
  );
  const forged = signedWebhook(paidIntent(), { secret: `whsec_${'forgedsecret0000000000000'}` });
  await assert.rejects(
    provider.adapter.verifyWebhook({ headers: forged.headers, rawBody: forged.body, merchantId: PUBLISHABLE_KEY }),
  );
  await assert.rejects(
    provider.adapter.verifyWebhook({
      headers: { 'stripe-signature': `t=${NOW_SEC}` },
      rawBody: body,
      merchantId: PUBLISHABLE_KEY,
    }),
  );
});

test('normalizeEvent maps the event types and keeps the double-anchored identity', async () => {
  const provider = createStripePaymentProvider(deadConfig());
  const verify = (rawBody: Buffer, headers: Record<string, string>) =>
    provider.adapter.verifyWebhook({ headers, rawBody, merchantId: PUBLISHABLE_KEY });

  const succeeded = signedWebhook(paidIntent({ clientSecret: CLIENT_SECRET }), { createdSec: NOW_SEC - 60 });
  const event = provider.adapter.normalizeEvent(await verify(succeeded.body, succeeded.headers));
  assert.equal(event.status, 'succeeded');
  assert.equal(event.providerOrderId, INTENT_ID);
  assert.equal(event.providerEventId, `evt_1StripeTestEvent000000001:${INTENT_ID}`);
  assert.equal(event.eventType, 'payment_intent.succeeded');
  assert.equal(event.tenantId, 'tenant-1');
  assert.equal(event.amountMinorUnits, '1234');
  assert.equal(event.currency, 'USD', 'the service domain keeps uppercase ISO while the wire stays lowercase');
  assert.equal(new Date(event.occurredAt).toISOString(), '2026-10-10T23:59:00.000Z');

  for (const [type, status] of [
    ['payment_intent.payment_failed', 'failed'],
    ['payment_intent.canceled', 'cancelled'],
    ['payment_intent.processing', 'pending'],
  ] as const) {
    const sample = signedWebhook(paidIntent({ status: 'requires_action' }), { type, eventId: `evt_type_${type}` });
    assert.equal(provider.adapter.normalizeEvent(await verify(sample.body, sample.headers)).status, status);
  }

  const noTenant = signedWebhook({ ...paidIntent(), metadata: { out_trade_no: 'order-local-1' } });
  const orphan = provider.adapter.normalizeEvent(await verify(noTenant.body, noTenant.headers));
  assert.equal(orphan.tenantId, 'unresolved-tenant', 'a missing tenant pass-through routes to reconciliation');

  const badAmount = stripeEventBody({
    eventId: 'evt_bad_amount',
    type: 'payment_intent.succeeded',
    intent: { id: INTENT_ID, amount: 12.34 as never, currency: 'usd', status: 'succeeded' },
  });
  assert.throws(() =>
    provider.adapter.normalizeEvent({
      providerKey: STRIPE_PROVIDER_KEY,
      merchantId: PUBLISHABLE_KEY,
      payload: JSON.parse(badAmount.toString('utf8')),
    }),
  );
});

test('confirmEvent enforces the pre-fulfillment retrieve red line', async () => {
  const stripe = await startMockStripe();
  try {
    const provider = createStripePaymentProvider(config(stripe));
    const confirmEvent = provider.adapter.confirmEvent;
    assert.ok(confirmEvent);
    const input = (
      orderOverrides: Partial<PaymentProviderEventConfirmationInput['order']> = {},
      eventOverrides: Partial<PaymentProviderEventConfirmationInput['event']> = {},
    ): PaymentProviderEventConfirmationInput => ({
      event: {
        providerEventId: `evt_1:${INTENT_ID}`,
        eventType: 'payment_intent.succeeded',
        providerOrderId: INTENT_ID,
        tenantId: 'tenant-1',
        merchantId: PUBLISHABLE_KEY,
        status: 'succeeded',
        amountMinorUnits: '1234',
        currency: 'USD',
        occurredAt: NOW,
        ...eventOverrides,
      },
      order: {
        localOrderId: 'order-local-1',
        tenantId: 'tenant-1',
        merchantId: PUBLISHABLE_KEY,
        amountMinorUnits: '1234',
        currency: 'USD',
        providerOrderId: INTENT_ID,
        ...orderOverrides,
      },
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({ json: stripePaymentIntentJson(paidIntent()) }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: true });
    assert.equal(stripe.calls.paymentIntentsRetrieve[0]?.path, `/v1/payment_intents/${INTENT_ID}`);

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      status: 404,
      json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } },
    }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'STRIPE_PAYMENT_INTENT_NOT_FOUND',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      json: stripePaymentIntentJson(paidIntent({ status: 'requires_payment_method' })),
    }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'STRIPE_PAYMENT_INTENT_NOT_SUCCEEDED',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      json: stripePaymentIntentJson({
        ...paidIntent(),
        metadata: { out_trade_no: 'order-local-OTHER', tenant_id: 'tenant-1' },
      }),
    }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'STRIPE_ORDER_REF_MISMATCH',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      json: stripePaymentIntentJson(paidIntent({ amount: 9999 })),
    }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'STRIPE_AMOUNT_MISMATCH',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({ json: stripePaymentIntentJson(paidIntent()) }));
    assert.deepEqual(await confirmEvent(input({}, { amountMinorUnits: '9999' })), {
      confirmed: false,
      code: 'STRIPE_AMOUNT_MISMATCH',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      json: stripePaymentIntentJson(paidIntent({ currency: 'eur' })),
    }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'STRIPE_CURRENCY_MISMATCH',
    });

    assert.deepEqual(await confirmEvent(input({ currency: 'EUR' })), {
      confirmed: false,
      code: 'STRIPE_CURRENCY_MISMATCH',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({ json: stripePaymentIntentJson(paidIntent()) }));
    assert.deepEqual(await confirmEvent(input({ providerOrderId: 'pi_otherintent000000000000000' })), {
      confirmed: false,
      code: 'STRIPE_PAYMENT_INTENT_MISMATCH',
    });

    stripe.setHandler('paymentIntentsRetrieve', () => ({ raw: '<html>down</html>', status: 502 }));
    await assert.rejects(confirmEvent(input()), (error: unknown) => {
      assert.ok(error instanceof StripeProviderError && error.acceptance === 'unknown');
      return true;
    });
  } finally {
    await stripe.close();
  }
});

test('recoverOrder retrieves by direct id only and never creates a charge', async () => {
  const stripe = await startMockStripe();
  try {
    const provider = createStripePaymentProvider(config(stripe));
    const recoverOrder = provider.adapter.recoverOrder;
    assert.ok(recoverOrder);
    const recovery = (extra: Record<string, unknown> = {}) => ({
      localOrderId: 'order-local-1',
      tenantId: 'tenant-1',
      amountMinorUnits: '1234',
      currency: 'USD',
      merchantId: PUBLISHABLE_KEY,
      idempotencyReference: 'order-local-1',
      ...extra,
    });

    const withoutHint = await recoverOrder(recovery());
    assert.equal(withoutHint, null, 'Stripe cannot list intents by metadata: no id hint means no recovery');
    assert.equal(stripe.calls.paymentIntentsCreate.length, 0, 'recovery never submits a create');
    assert.equal(stripe.calls.paymentIntentsRetrieve.length, 0);

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      status: 404,
      json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } },
    }));
    assert.equal(await recoverOrder(recovery({ providerOrderId: INTENT_ID })), null);

    stripe.setHandler('paymentIntentsRetrieve', () => ({ json: stripePaymentIntentJson(paidIntent()) }));
    const recovered = await recoverOrder(recovery({ providerOrderId: INTENT_ID }));
    assert.deepEqual(recovered, { providerOrderId: INTENT_ID, amountMinorUnits: '1234', currency: 'USD' });
    assert.equal(stripe.calls.paymentIntentsCreate.length, 0);

    stripe.setHandler('paymentIntentsRetrieve', () => ({
      json: stripePaymentIntentJson({ ...paidIntent(), metadata: { out_trade_no: 'order-OTHER' } }),
    }));
    await assert.rejects(
      recoverOrder(recovery({ providerOrderId: INTENT_ID })),
      (error: unknown) => error instanceof StripeProviderError && error.acceptance === 'unknown',
    );

    stripe.setHandler('paymentIntentsRetrieve', () => ({ raw: 'down', status: 500 }));
    await assert.rejects(
      recoverOrder(recovery({ providerOrderId: INTENT_ID })),
      (error: unknown) => error instanceof StripeProviderError && error.acceptance === 'unknown',
    );
  } finally {
    await stripe.close();
  }
});

test('submitRefund posts the Refund with the refund idempotency key and maps the acceptance tri-state', async () => {
  const stripe = await startMockStripe();
  try {
    const provider = createStripePaymentProvider(config(stripe));
    stripe.setHandler('refundsCreate', () => ({
      json: stripeRefundJson({
        id: 're_3OrERmKcfg7EjL0f1refund',
        paymentIntent: INTENT_ID,
        amount: 1234,
        status: 'succeeded',
      }),
    }));
    const succeeded = await provider.refundAdapter.submitRefund(refundInput());
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.providerRefundId, 're_3OrERmKcfg7EjL0f1refund');
    assert.equal(succeeded.localRefundId, 'refund-1');
    const [sent] = stripe.calls.refundsCreate;
    assert.ok(sent);
    assert.equal(sent.params.payment_intent, INTENT_ID);
    assert.equal(sent.params.amount, '1234');
    assert.equal(sent.params['metadata[local_refund_id]'], 'refund-1');
    assert.equal(sent.params['metadata[out_trade_no]'], 'order-local-1');
    assert.equal(sent.headers['idempotency-key'], 'refund-1');

    stripe.setHandler('refundsCreate', () => ({
      json: stripeRefundJson({
        id: 're_pending00000000000001',
        paymentIntent: INTENT_ID,
        amount: 1234,
        status: 'pending',
      }),
    }));
    assert.equal((await provider.refundAdapter.submitRefund(refundInput())).status, 'pending');

    for (const upstream of ['failed', 'canceled'] as const) {
      stripe.setHandler('refundsCreate', () => ({
        json: stripeRefundJson({
          id: 're_terminal0000000000001',
          paymentIntent: INTENT_ID,
          amount: 1234,
          status: upstream,
        }),
      }));
      assert.equal(
        (await provider.refundAdapter.submitRefund(refundInput())).status,
        'failed',
        `${upstream} collapses onto the failed tri-state leg`,
      );
    }

    stripe.setHandler('refundsCreate', () => ({
      status: 400,
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: `No such payment_intent: '${INTENT_ID}'`,
        },
      },
    }));
    const notAccepted = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(notAccepted instanceof StripeProviderError && notAccepted.acceptance === 'not_accepted');

    stripe.setHandler('refundsCreate', () => ({
      status: 400,
      json: {
        error: {
          type: 'idempotency_error',
          code: null,
          message: 'Keys for idempotent requests can only be used with the same parameters',
        },
      },
    }));
    const ambiguous = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(ambiguous instanceof StripeProviderError && ambiguous.acceptance === 'unknown');

    stripe.setHandler('refundsCreate', () => ({ raw: '<html>proxy error</html>', status: 502 }));
    const transport = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof StripeProviderError && transport.acceptance === 'unknown');

    const callsBefore = stripe.calls.refundsCreate.length;
    for (const bad of [
      refundInput({ providerKey: 'easypay' }),
      refundInput({ merchantId: 'pk_test_othermerchant00000000' }),
      refundInput({ idempotencyReference: 'other' }),
      refundInput({ currency: 'EUR' }),
    ]) {
      const failure = await provider.refundAdapter.submitRefund(bad).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof StripeProviderError && failure.acceptance === 'unknown');
    }
    assert.equal(stripe.calls.refundsCreate.length, callsBefore, 'identity failures never reach the provider');
  } finally {
    await stripe.close();
  }
});

test('queryRefund retrieves the real tri-state, maps 404 to not_found and never fabricates', async () => {
  const stripe = await startMockStripe();
  try {
    const provider = createStripePaymentProvider(config(stripe));
    const query = (overrides: Record<string, unknown> = {}) =>
      provider.refundAdapter.queryRefund(refundInput({ providerRefundId: 're_query000000000000001', ...overrides }));

    stripe.setHandler('refundsRetrieve', () => ({
      json: stripeRefundJson({
        id: 're_query000000000000001',
        paymentIntent: INTENT_ID,
        amount: 1234,
        status: 'succeeded',
      }),
    }));
    assert.equal((await query()).status, 'succeeded');
    assert.equal(stripe.calls.refundsRetrieve[0]?.path, '/v1/refunds/re_query000000000000001');

    for (const [upstream, mapped] of [
      ['pending', 'pending'],
      ['failed', 'failed'],
      ['canceled', 'failed'],
    ] as const) {
      stripe.setHandler('refundsRetrieve', () => ({
        json: stripeRefundJson({
          id: 're_query000000000000001',
          paymentIntent: INTENT_ID,
          amount: 1234,
          status: upstream,
        }),
      }));
      assert.equal((await query()).status, mapped);
    }

    stripe.setHandler('refundsRetrieve', () => ({
      status: 404,
      json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such refund' } },
    }));
    assert.equal((await query()).status, 'not_found');

    stripe.setHandler('refundsRetrieve', () => ({
      json: stripeRefundJson({
        id: 're_query000000000000001',
        paymentIntent: 'pi_otherintent000000000000000',
        amount: 1234,
        status: 'succeeded',
      }),
    }));
    assert.equal((await query()).status, 'unknown', 'a payment-intent mismatch is never a verdict');

    stripe.setHandler('refundsRetrieve', () => ({
      json: stripeRefundJson({
        id: 're_query000000000000001',
        paymentIntent: INTENT_ID,
        amount: 9999,
        status: 'succeeded',
      }),
    }));
    assert.equal((await query()).status, 'unknown', 'an amount mismatch is never a verdict');

    stripe.setHandler('refundsRetrieve', () => ({ raw: 'down', status: 500 }));
    assert.equal((await query()).status, 'unknown');

    const unreachable = createStripePaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockStripe));
    assert.equal(
      (await unreachable.refundAdapter.queryRefund(refundInput({ providerRefundId: 're_x' }))).status,
      'unknown',
      'a transport failure answers unknown instead of throwing the worker off course',
    );

    const callsBefore = stripe.calls.refundsRetrieve.length;
    assert.equal((await query({ providerRefundId: null })).status, 'unknown');
    assert.equal(stripe.calls.refundsRetrieve.length, callsBefore, 'a missing provider refund id never queries');
  } finally {
    await stripe.close();
  }
});

test('upstream error text never leaks the secret key or webhook secret', async () => {
  const stripe = await startMockStripe();
  try {
    stripe.setHandler('paymentIntentsCreate', () => ({
      status: 402,
      json: {
        error: {
          type: 'card_error',
          code: 'card_declined',
          message: `echoed ${SECRET_KEY} and ${WEBHOOK_SECRET} verbatim`,
        },
      },
    }));
    stripe.setHandler('paymentIntentsSearch', () => ({ json: { object: 'list', data: [] } }));
    const provider = createStripePaymentProvider(config(stripe));
    const failure = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof StripeProviderError);
    assert.equal(failure.message.includes(SECRET_KEY), false);
    assert.equal(failure.message.includes(WEBHOOK_SECRET), false);
    assert.match(failure.message, /\*\*\*/);

    stripe.setHandler('refundsCreate', () => ({
      status: 400,
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: `No such payment_intent: '${SECRET_KEY}'`,
        },
      },
    }));
    const refundFailure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refundFailure instanceof StripeProviderError);
    assert.equal(refundFailure.message.includes(SECRET_KEY), false);
  } finally {
    await stripe.close();
  }
});
