import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { createRequestAdmissionReservationBusinessKey } from '../../../src/saas/gateway/admission.js';
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
import type {
  AttemptRecord,
  RecordUsageEventInput,
  RecordUsageSettlementInput,
} from '../../../src/saas/metering/types.js';
import type { SettleBillingInput } from '../../../src/saas/billing/types.js';
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

const observedUsage = {
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
} satisfies NormalizedUsage;

function attempt(supplyMode: 'byok' | 'platform' = 'platform'): AttemptRecord {
  const platform = supplyMode === 'platform';
  return {
    id: 'attempt-1',
    tenantId: 'tenant-1',
    requestId: 'request-1',
    projectPolicyVersion: '1',
    customerPriceVersion: platform ? 'price-v1' : null,
    customerMeteringPolicyId: 'customer-policy-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-1',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'model-1',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: platform ? 'platform_pool' : 'tenant_account',
    ordinal: 1,
    upstreamId: 'upstream-1',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: platform ? 'platform' : 'tenant',
    accountId: 'account-1',
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: 'model-1',
    protocol: 'openai',
    endpoint: 'chat-completions',
    supplierCostVersion: platform ? 'cost-v1' : null,
    dispatchProfileId: 'profile-1',
    supplyProfileAuthzVersion: '1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: platform ? 'pool-1' : null,
    poolAuthzVersion: platform ? '1' : null,
    poolMemberAccountAuthzVersion: platform ? '1' : null,
    poolMemberAuthzVersion: platform ? '1' : null,
    poolGrantAuthzVersion: platform ? '1' : null,
    poolGrantProfileAuthzVersion: platform ? '1' : null,
    poolGrantPoolAuthzVersion: platform ? '1' : null,
    profileAccountAuthzVersion: platform ? null : '1',
    preparedEvidenceId: 'evidence-1',
    dispatchState: 'sent',
    resultState: 'succeeded',
    responseStarted: true,
    responseStartedAt: '2026-09-01T00:00:00.000Z',
    resultHttpStatus: 200,
    unknownReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    stateVersion: 5,
  };
}

function transactionSpy(onComplete: (input: NormalSuccessTransactionInput) => void): NormalSuccessTransactionPort {
  return {
    async complete(input) {
      onComplete(input);
      return { kind: 'settled', attempt: attempt(input.supplyMode) };
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
  const requestTransitions: Array<Parameters<ConditionalSettlementMetering['transitionRequest']>[0]> = [];
  const reservationBusinessKey = createRequestAdmissionReservationBusinessKey('tenant-1', 'request-1');
  let requestStateVersion = 6;
  const sqlExecutor = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
      if (sql.includes('FROM saas_attempts a')) {
        assert.deepEqual(values, ['tenant-1', 'request-1', 'attempt-1']);
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
        assert.deepEqual(values, ['tenant-1', 'request-1', 'saas.billing.reservation', reservationBusinessKey]);
        return {
          rows: [
            {
              id: 'hold-1',
              tenant_id: 'tenant-1',
              request_id: 'request-1',
              wallet_id: 'wallet-1',
              idempotency_namespace: 'saas.billing.reservation',
              business_key: reservationBusinessKey,
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
    async recordUsageEvent(input: RecordUsageEventInput, options?: { executor?: SqlExecutor }) {
      sameExecutor(options);
      assert.equal(input.tenantId, 'tenant-1');
      assert.equal(input.requestId, 'request-1');
      assert.equal(input.attemptId, 'attempt-1');
      assert.equal(input.supplyMode, 'platform');
      assert.equal(input.eventKey, 'event-key');
      assert.equal(input.usage.status, 'reported');
      assert.equal(input.usage.source, 'upstream');
      order.push('usage-event');
      return { id: 'usage-event-1' };
    },
    async createUsageSettlement(input: RecordUsageSettlementInput, options?: { executor?: SqlExecutor }) {
      sameExecutor(options);
      assert.deepEqual(input, {
        tenantId: 'tenant-1',
        usageEventId: 'usage-event-1',
        settlementKey: 'settlement-key',
        settlementKind: 'usage_recorded',
        normalSuccessEvidenceRef: 'e'.repeat(64),
      });
      order.push('usage-settlement');
      return {};
    },
    async transitionAttempt(input: Parameters<ConditionalSettlementMetering['transitionAttempt']>[0]) {
      sameExecutor(input);
      assert.equal(input.expectedStateVersion, 4);
      assert.equal(input.expectedDispatchState, 'sent');
      assert.equal(input.expectedResultState, 'pending');
      assert.equal(input.expectedResponseStarted, true);
      assert.equal(input.resultState, 'succeeded');
      order.push('attempt-terminal');
      return attempt();
    },
    async transitionRequest(input: Parameters<ConditionalSettlementMetering['transitionRequest']>[0]) {
      sameExecutor(input);
      assert.equal(input.expectedStateVersion, requestStateVersion);
      requestStateVersion += 1;
      order.push('request-terminal');
      requestTransitions.push(input);
      return { stateVersion: requestStateVersion };
    },
    async transitionFinancialStatus(input: Parameters<ConditionalSettlementMetering['transitionFinancialStatus']>[0]) {
      sameExecutor(input);
      assert.equal(input.expectedStateVersion, 8);
      assert.equal(input.expectedFinancialStatus, 'pending');
      assert.equal(input.financialStatus, 'settled');
      order.push('financial-terminal');
      return {};
    },
  } as unknown as ConditionalSettlementMetering;
  const billing = {
    async settle(executor: SqlExecutor, input: SettleBillingInput) {
      assert.equal(executor, sqlExecutor);
      assert.deepEqual(input, {
        supplyMode: 'platform',
        tenantId: 'tenant-1',
        requestId: 'request-1',
        currency: 'USD',
        priceSnapshotRef: 'snapshot-1',
        settlementId: 'settlement-key',
        usageEvidenceRef: 'e'.repeat(64),
        businessKey: reservationBusinessKey,
        idempotencyNamespace: 'saas.billing.reservation',
        actualAmountMinorUnits: '7',
      });
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
  assert.equal(result.attempt.resultState, 'succeeded');
  assert.equal(result.attempt.stateVersion, 5);
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
