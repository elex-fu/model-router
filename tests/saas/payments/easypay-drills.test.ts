import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import {
  createEasyPayPaymentProvider,
  EASY_PAY_PROVIDER_KEY,
  easyPaySign,
} from '../../../src/saas/payments/providers/easypay/index.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import { createFakeFundingLedger, FakePaymentDatabase } from './fake-sql.js';
import { type MockPsp, startMockPsp } from './mock-psp.js';

// C4: EasyPay has no official sandbox, so callback disorder is drilled here
// against the programmable mock PSP with the real adapter and fulfillment
// service: duplicate delivery, conflicting signed replay, and early
// (out-of-order) arrival before the local order lands. The refund-side
// permanent-unknown drill lives in refunds.test.ts (shared refund harness).

const PID = '1001';
const PKEY = 'test-merchant-pkey-0123456789abcdef';

function signedNotify(params: Record<string, string>, pkey = PKEY): Buffer {
  // Real epay notifications always carry notify_time; it anchors the event's
  // occurredAt so byte-identical redeliveries keep one stable identity.
  const body: Record<string, string> = { notify_time: '2026-10-10 00:00:00', ...params };
  body.sign = easyPaySign(body, pkey);
  body.sign_type = 'MD5';
  return Buffer.from(new URLSearchParams(body).toString(), 'utf8');
}

function paidQuery(order: { outTradeNo: string; tradeNo?: string; money?: string }) {
  return {
    code: 1,
    trade_status: 'TRADE_SUCCESS',
    trade_no: order.tradeNo ?? 'TRADE-1',
    out_trade_no: order.outTradeNo,
    money: order.money ?? '12.34',
  };
}

async function createFixture(psp: MockPsp) {
  const clock = { value: Date.parse('2026-10-10T00:00:00.000Z') };
  const provider = createEasyPayPaymentProvider({
    pid: PID,
    pkey: PKEY,
    apiBase: psp.url,
    notifyUrl: 'https://app.example.com/payments/notify',
    returnUrl: 'https://app.example.com/payments/return',
    paymentType: 'alipay',
    now: () => new Date(clock.value),
  });
  const database = new FakePaymentDatabase();
  let nextId = 0;
  const service = new PaymentFulfillmentService(database, provider.adapter, {
    providerKey: EASY_PAY_PROVIDER_KEY,
    merchantId: PID,
    now: () => new Date(clock.value),
    idFactory: () => `local-${++nextId}`,
    walletFundingLedger: createFakeFundingLedger(database),
    checkout: {
      redirectPolicies: [
        { providerKey: EASY_PAY_PROVIDER_KEY, origin: 'https://pay.example.com', pathPrefixes: ['/'] },
      ],
    },
  });
  return { database, service, clock };
}

test('C4: duplicate notifications replay from the durable inbox and credit the wallet exactly once', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({
      json: { code: 1, trade_no: 'TRADE-DUP', payurl: 'https://pay.example.com/cashier/TRADE-DUP' },
    }));
    const { database, service, clock } = await createFixture(psp);
    const order = await service.createWalletTopUp({
      tenantId: 'tenant-1',
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    psp.setHandler('query', (params) => ({
      json: paidQuery({ outTradeNo: params.out_trade_no ?? '', tradeNo: 'TRADE-DUP' }),
    }));
    const body = signedNotify({
      pid: PID,
      trade_no: 'TRADE-DUP',
      out_trade_no: order.id,
      trade_status: 'TRADE_SUCCESS',
      money: '12.34',
      param: 'tenant-1',
    });
    const first = await service.handleWebhook({}, body);
    const second = await service.handleWebhook({}, body);
    assert.equal(first.outcome, 'accepted');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, 'byte-identical redelivery is a durable inbox replay');
    assert.equal(second.inboxId, first.inboxId);
    assert.equal(database.state.inbox.length, 1);
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    clock.value += 1_000;
    const third = await service.handleWebhook({}, body);
    assert.equal(third.replayed, true, 'redelivery after processing still replays, never re-enqueues');
    assert.equal((await service.processPendingWebhooks()).processed, 0);
    assert.equal(database.state.funding.length, 1);
    assert.equal(database.state.funding[0]?.amountMinorUnits, '1234');
    assert.equal(psp.calls.query.length, 1, 'the pre-fulfillment requery ran exactly once');
  } finally {
    await psp.close();
  }
});

test('C4: a signed but conflicting replay of the same event is refused and never re-credits', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({
      json: { code: 1, trade_no: 'TRADE-CON', payurl: 'https://pay.example.com/cashier/TRADE-CON' },
    }));
    const { database, service } = await createFixture(psp);
    const order = await service.createWalletTopUp({
      tenantId: 'tenant-1',
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    psp.setHandler('query', (params) => ({
      json: paidQuery({ outTradeNo: params.out_trade_no ?? '', tradeNo: 'TRADE-CON' }),
    }));
    await service.handleWebhook(
      {},
      signedNotify({
        pid: PID,
        trade_no: 'TRADE-CON',
        out_trade_no: order.id,
        trade_status: 'TRADE_SUCCESS',
        money: '12.34',
        param: 'tenant-1',
      }),
    );
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    // Same event identity (trade_no + status), different signed amount:
    // valid MD5 is not proof of consistency — the inbox must refuse the drift.
    await assert.rejects(
      service.handleWebhook(
        {},
        signedNotify({
          pid: PID,
          trade_no: 'TRADE-CON',
          out_trade_no: order.id,
          trade_status: 'TRADE_SUCCESS',
          money: '99.99',
          param: 'tenant-1',
        }),
      ),
      (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_EVENT_CONFLICT',
    );
    assert.equal(database.state.inbox.length, 1);
    assert.equal(database.state.funding.length, 1);
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
  } finally {
    await psp.close();
  }
});

test('C4: an early notification for a not-yet-persisted order is held and fulfills once the order lands', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({
      json: { code: 1, trade_no: 'TRADE-EARLY', payurl: 'https://pay.example.com/cashier/TRADE-EARLY' },
    }));
    const { database, service, clock } = await createFixture(psp);
    const order = await service.createWalletTopUp({
      tenantId: 'tenant-1',
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    // The PSP callback races ahead of our own provider-order persistence:
    // the notify names the order, but the provider link is not visible yet.
    const storedOrder = database.state.orders[0];
    assert.ok(storedOrder);
    const providerOrderId = storedOrder.provider_order_id;
    assert.equal(providerOrderId, 'TRADE-EARLY');
    storedOrder.provider_order_id = null;

    psp.setHandler('query', (params) => ({
      json: paidQuery({ outTradeNo: params.out_trade_no ?? '', tradeNo: 'TRADE-EARLY' }),
    }));
    const receipt = await service.handleWebhook(
      {},
      signedNotify({
        pid: PID,
        trade_no: 'TRADE-EARLY',
        out_trade_no: order.id,
        trade_status: 'TRADE_SUCCESS',
        money: '12.34',
        param: 'tenant-1',
      }),
    );
    assert.equal(receipt.outcome, 'accepted', 'unknown orders are held for retry, not dropped');
    assert.equal(receipt.orderId, null);
    assert.equal((await service.processPendingWebhooks()).retrying, 1);
    assert.equal(database.state.funding.length, 0);

    // The provider link lands; the PSP's retry (same signed bytes) now fulfills.
    // Re-fetch the row: a failed processing transaction restores cloned state,
    // so the pre-batch reference is stale.
    const currentOrder = database.state.orders[0];
    assert.ok(currentOrder);
    currentOrder.provider_order_id = providerOrderId;
    clock.value += 1_000;
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);
    assert.equal(database.state.funding[0]?.amountMinorUnits, '1234');
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
    assert.equal(psp.calls.query.length, 1, 'fulfillment still required the pre-fulfillment requery');
  } finally {
    await psp.close();
  }
});
