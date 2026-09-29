import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  DispatchUsageSettlementCoordinator,
  type NormalSuccessSettlementSnapshot,
  type NormalSuccessTransactionInput,
  type NormalSuccessTransactionPort,
} from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import {
  type ConditionalSettlementBilling,
  type ConditionalSettlementMetering,
  DurableNormalSuccessSettlementPort,
} from '../../../src/saas/metering/conditional-settlement-port.js';
import type { AttemptRecord } from '../../../src/saas/metering/types.js';
import { normalizeRates } from '../../../src/saas/pricing/calculator.js';
import type { CustomerPriceVersionRecord, RateSetInput } from '../../../src/saas/pricing/types.js';
import type { NormalizedUsage } from '../../../src/telemetry/usage.js';

const rateSet = normalizeRates({
  input: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_read: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_write: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_write_5m: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  cache_write_1h: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
  output: { numeratorMinorUnits: 1n, denominatorUnits: 1n },
} satisfies RateSetInput);

const customerPrice: CustomerPriceVersionRecord = {
  kind: 'customer',
  id: 'price-v1',
  version: 1,
  publicModelId: 'model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  commercialPolicyVersion: 'policy-v1',
  calculatorVersion: 'calculator-v1',
  roundingVersion: 'rounding-v1',
  roundingMode: 'half_up',
  roundingBoundary: 'total',
  rates: rateSet,
  effectiveAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  idempotencyKey: 'price-key-v1',
  definitionDigest: 'd'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
};

const snapshot: NormalSuccessSettlementSnapshot = {
  supplyMode: 'platform',
  providerProtocol: 'openai',
  customerPriceVersion: 'price-v1',
  reservationId: 'hold-1',
  priceSnapshotRef: 'snapshot-1',
  currency: 'USD',
  holdAmountMinorUnits: '100',
  publicModelId: 'model-1',
  publicModelVersion: '1',
  providerId: 'provider-1',
  productId: 'product-1',
  endpoint: 'chat-completions',
  usageEstimatorVersion: 'estimator-v1',
};

const observedUsage: NormalizedUsage = {
  inputTotal: 5,
  inputUncached: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  outputTotal: 2,
  reasoningOutput: 0,
  status: 'reported',
  source: 'upstream',
  semanticsVersion: 'v1',
};

function attempt(): AttemptRecord {
  return { id: 'attempt-1' } as AttemptRecord;
}

function transactionSpy(onComplete: (input: NormalSuccessTransactionInput) => void): NormalSuccessTransactionPort {
  return {
    async complete(input) {
      onComplete(input);
      return { kind: 'settled', attempt: attempt() };
    },
    async retainUnknown() {
      throw new Error('unexpected reconciliation');
    },
  };
}

test('platform coordinator calculates from the server-selected price and passes the hold identity through', async () => {
  let committed: NormalSuccessTransactionInput | undefined;
  const coordinator = new DispatchUsageSettlementCoordinator(
    {
      async getCustomerPriceVersion(id) {
        assert.equal(id, 'price-v1');
        return customerPrice;
      },
    },
    transactionSpy((input) => {
      committed = input;
    }),
  );

  await coordinator.complete({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    snapshot,
    usage: { ...observedUsage, source: 'upstream' },
  });

  assert.equal(committed?.chargeAmountMinorUnits, '7');
  assert.equal(committed?.priceSnapshotRef, 'snapshot-1');
  assert.equal(committed?.reservationId, 'hold-1');
  assert.equal(committed?.usage.inputTotal, 5n);
  assert.equal(committed?.usage.source, 'upstream');
  assert.match(committed?.settlementKey ?? '', /^saas-normal-success:[0-9a-f]{64}$/);
});

test('BYOK coordinator records upstream usage without resolving a price or creating a wallet charge', async () => {
  let committed: NormalSuccessTransactionInput | undefined;
  const coordinator = new DispatchUsageSettlementCoordinator(
    {
      async getCustomerPriceVersion() {
        throw new Error('BYOK must not resolve platform prices');
      },
    },
    transactionSpy((input) => {
      committed = input;
    }),
  );

  await coordinator.complete({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    snapshot: {
      ...snapshot,
      supplyMode: 'byok',
      customerPriceVersion: null,
      reservationId: null,
      priceSnapshotRef: null,
      currency: null,
      holdAmountMinorUnits: null,
    },
    usage: { ...observedUsage, source: 'upstream' },
  });

  assert.equal(committed?.supplyMode, 'byok');
  assert.equal(committed?.chargeAmountMinorUnits, null);
  assert.equal(committed?.reservationId, null);
  assert.equal(committed?.usage.status, 'reported');
});

test('incomplete usage and a mismatched server price fail closed before the transaction', async () => {
  let writes = 0;
  const coordinator = new DispatchUsageSettlementCoordinator(
    {
      async getCustomerPriceVersion() {
        return { ...customerPrice, providerId: 'other-provider' };
      },
    },
    transactionSpy(() => {
      writes += 1;
    }),
  );
  const base = {
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    snapshot,
  };

  await assert.rejects(
    coordinator.complete({
      ...base,
      usage: { ...observedUsage, status: 'missing' },
    }),
  );
  await assert.rejects(
    coordinator.complete({
      ...base,
      usage: { ...observedUsage, source: 'upstream' },
    }),
  );
  assert.equal(writes, 0);
});

test('durable normal success writes usage, wallet settlement, and terminal states on one executor', async () => {
  const order: string[] = [];
  const requestTransitions: Array<Record<string, unknown>> = [];
  const sqlExecutor = {
    async query<Row>(sql: string): Promise<{ rows: Row[] }> {
      if (sql.includes('FROM saas_attempts a')) {
        return {
          rows: [
            {
              attempt_id: 'attempt-1',
              attempt_tenant_id: 'tenant-1',
              attempt_request_id: 'request-1',
              attempt_dispatch_state: 'sent',
              attempt_result_state: 'pending',
              attempt_response_started: true,
              attempt_state_version: 4,
              attempt_binding_state: 'bound',
              attempt_dispatch_authority_state: 'bound',
              attempt_customer_price_version: 'price-v1',
              attempt_provider_id: 'provider-1',
              attempt_product_id: 'product-1',
              attempt_public_model_id: 'model-1',
              attempt_public_model_version: 1,
              request_id: 'request-1',
              request_tenant_id: 'tenant-1',
              request_supply_mode: 'platform',
              request_customer_price_version: 'price-v1',
              request_result_state: 'pending',
              request_reconciliation_state: 'none',
              request_financial_status: 'pending',
              request_state_version: 6,
            } as Row,
          ],
        };
      }
      if (sql.includes('FROM saas_billing_reservations')) {
        return {
          rows: [
            {
              id: 'hold-1',
              currency: 'USD',
              amount_minor_units: '100',
              state: 'reserved',
              price_snapshot_ref: 'snapshot-1',
            } as Row,
          ],
        };
      }
      throw new Error('unexpected SQL');
    },
  } as SqlExecutor;
  const db = {
    async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      order.push('transaction');
      return work(sqlExecutor);
    },
  } as SaasDatabase;
  const sameExecutor = (options?: { executor?: SqlExecutor }) => {
    assert.equal(options?.executor, sqlExecutor);
  };
  const metering = {
    async recordUsageEvent(_input: unknown, options?: { executor?: SqlExecutor }) {
      sameExecutor(options);
      order.push('usage-event');
      return { id: 'usage-event-1' };
    },
    async createUsageSettlement(_input: unknown, options?: { executor?: SqlExecutor }) {
      sameExecutor(options);
      order.push('usage-settlement');
      return {};
    },
    async transitionAttempt(input: { executor?: SqlExecutor }) {
      sameExecutor(input);
      order.push('attempt-terminal');
      return attempt();
    },
    async transitionRequest(input: { executor?: SqlExecutor }) {
      sameExecutor(input);
      order.push('request-terminal');
      requestTransitions.push(input as Record<string, unknown>);
      return { stateVersion: 8 };
    },
    async transitionFinancialStatus(input: { executor?: SqlExecutor }) {
      sameExecutor(input);
      order.push('financial-terminal');
      return {};
    },
  } as unknown as ConditionalSettlementMetering;
  const billing = {
    async settle(executor: SqlExecutor) {
      assert.equal(executor, sqlExecutor);
      order.push('wallet-settlement');
      return { state: 'settled' };
    },
  } as unknown as ConditionalSettlementBilling;
  const port = new DurableNormalSuccessSettlementPort(db, { metering, billing });

  const result = await port.complete({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    supplyMode: 'platform',
    responseStarted: true,
    priceSnapshotRef: 'snapshot-1',
    reservationId: 'hold-1',
    currency: 'USD',
    customerPriceVersion: 'price-v1',
    chargeAmountMinorUnits: '7',
    usageEventKey: 'event-key',
    settlementKey: 'settlement-key',
    usageEvidenceRef: 'e'.repeat(64),
    usage: {
      inputTotal: 5n,
      inputUncached: 5n,
      cacheRead: 0n,
      cacheWrite: 0n,
      cacheWrite5m: 0n,
      cacheWrite1h: 0n,
      outputTotal: 2n,
      reasoningOutput: 0n,
      status: 'reported',
      source: 'upstream',
      semanticsVersion: 'v1',
      measurementKind: 'snapshot',
      billableBasis: 'exact',
    },
  });

  assert.equal(result.kind, 'settled');
  assert.deepEqual(order, [
    'transaction',
    'usage-event',
    'usage-settlement',
    'wallet-settlement',
    'attempt-terminal',
    'request-terminal',
    'request-terminal',
    'financial-terminal',
  ]);
  assert.deepEqual(
    requestTransitions.map(
      ({ expectedResultState, expectedReconciliationState, resultState, reconciliationState }) => ({
        expectedResultState,
        expectedReconciliationState,
        resultState,
        reconciliationState,
      }),
    ),
    [
      {
        expectedResultState: 'pending',
        expectedReconciliationState: 'none',
        resultState: 'pending',
        reconciliationState: 'pending',
      },
      {
        expectedResultState: 'pending',
        expectedReconciliationState: 'pending',
        resultState: 'succeeded',
        reconciliationState: 'resolved',
      },
    ],
  );
});
