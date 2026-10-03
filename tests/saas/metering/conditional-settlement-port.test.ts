import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BillingReservationResult,
  BillingTransactionExecutor,
  MarkReconciliationPendingInput,
  SettleBillingInput,
} from '../../../src/saas/billing/types.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type ConditionalSettlementBilling,
  type ConditionalSettlementInput,
  type ConditionalSettlementMetering,
  DurableConditionalSettlementPort,
  DurableNormalSuccessSettlementPort,
} from '../../../src/saas/metering/conditional-settlement-port.js';
import type {
  AttemptRecord,
  AttemptTransitionInput,
  FinancialTransitionInput,
  MeteringOperationOptions,
  NormalizedUsageExact,
  RecordUsageEventInput,
  RecordUsageSettlementInput,
  RequestRecord,
  RequestTransitionInput,
  UsageEventRecord,
  UsageSettlementRecord,
} from '../../../src/saas/metering/types.js';

type Row = Record<string, unknown>;

interface FakeState {
  row: Row;
  hold: Row | null;
  usageEventKey: string | null;
  usage: NormalizedUsageExact | null;
  usageEventId: string | null;
  settlementKey: string | null;
  normalSuccessEvidenceRef: string | null;
  usageEventCount: number;
  usageSettlementCount: number;
  ledgerTransactionCount: number;
  ledgerEntryCount: number;
  spendingFrozen: boolean;
}

function result<RowType>(rows: RowType[]): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

function admissionBusinessKey(tenantId = 'tenant-1', requestId = 'request-1'): string {
  return `saas-request-admission:${tenantId}:${requestId}`;
}

function initialRow(overrides: Row = {}): Row {
  return {
    attempt_id: 'attempt-1',
    attempt_tenant_id: 'tenant-1',
    attempt_request_id: 'request-1',
    attempt_project_policy_version: '1',
    attempt_customer_price_version: 'price-v1',
    attempt_customer_metering_policy_id: 'customer-policy-1',
    attempt_customer_metering_policy_version: '1',
    attempt_provider_metering_policy_id: 'provider-policy-1',
    attempt_provider_metering_policy_version: '1',
    attempt_contract_attestation_id: 'attestation-1',
    attempt_route_config_id: 'route-1',
    attempt_route_config_version: '1',
    attempt_route_public_model_id: 'public-model-1',
    attempt_route_public_model_version: '1',
    attempt_route_protocol: 'openai',
    attempt_route_target_mode: 'platform_pool',
    upstream_id: 'upstream-1',
    binding_state: 'bound',
    dispatch_authority_state: 'bound',
    account_owner_kind: 'platform',
    account_id: 'account-1',
    provider_id: 'provider-1',
    product_id: 'product-1',
    resolved_model: 'model-1',
    attempt_protocol: 'openai',
    supplier_cost_version: 'cost-v1',
    dispatch_profile_id: 'profile-1',
    supply_profile_authz_version: '1',
    credential_id: 'credential-1',
    credential_version: '1',
    credential_authz_version: '1',
    account_authz_version: '1',
    pool_id: 'pool-1',
    pool_authz_version: '1',
    pool_member_account_authz_version: '1',
    pool_member_authz_version: '1',
    pool_grant_authz_version: '1',
    pool_grant_profile_authz_version: '1',
    pool_grant_pool_authz_version: '1',
    profile_account_authz_version: null,
    attempt_dispatch_state: 'unknown',
    attempt_result_state: 'unknown',
    response_started: false,
    attempt_state_version: 4,
    request_id: 'request-1',
    request_tenant_id: 'tenant-1',
    request_project_policy_version: '1',
    supply_profile_id: 'profile-1',
    supply_profile_version: '1',
    supply_mode: 'platform',
    request_customer_price_version: 'price-v1',
    request_customer_metering_policy_id: 'customer-policy-1',
    request_customer_metering_policy_version: '1',
    request_provider_metering_policy_id: 'provider-policy-1',
    request_provider_metering_policy_version: '1',
    request_contract_attestation_id: 'attestation-1',
    request_route_config_id: 'route-1',
    request_route_config_version: '1',
    request_route_public_model_id: 'public-model-1',
    request_route_public_model_version: '1',
    request_route_protocol: 'openai',
    request_route_target_mode: 'platform_pool',
    route_upstream_id: 'upstream-1',
    request_protocol: 'openai',
    request_result_state: 'unknown',
    financial_status: 'pending',
    reconciliation_state: 'pending',
    request_state_version: 3,
    ...overrides,
  };
}

function initialHold(overrides: Row = {}): Row {
  return {
    id: 'hold-1',
    tenant_id: 'tenant-1',
    request_id: 'request-1',
    wallet_id: 'wallet-1',
    currency: 'USD',
    idempotency_namespace: 'saas.billing.reservation',
    business_key: admissionBusinessKey(),
    amount_minor_units: '100',
    state: 'reserved',
    price_snapshot_ref: 'price-snapshot-1',
    metadata_ref: 'price-snapshot-1',
    settlement_id: null,
    settlement_amount_minor_units: null,
    usage_evidence_ref: null,
    ...overrides,
  };
}

function initialState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    row: initialRow(),
    hold: initialHold(),
    usageEventKey: null,
    usage: null,
    usageEventId: null,
    settlementKey: null,
    normalSuccessEvidenceRef: null,
    usageEventCount: 0,
    usageSettlementCount: 0,
    ledgerTransactionCount: 0,
    ledgerEntryCount: 0,
    spendingFrozen: false,
    ...overrides,
  };
}

class FakeDatabase implements SaasDatabase {
  state: FakeState;
  transactionCount = 0;
  rollbackCount = 0;
  readonly statements: string[] = [];

  constructor(state: FakeState = initialState()) {
    this.state = state;
  }

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    return this.execute<RowType>(sql, values);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const before = structuredClone(this.state);
    const tx: SqlExecutor = {
      query: <RowType>(sql: string, values: readonly unknown[] = []) => this.query<RowType>(sql, values),
    };
    try {
      return await work(tx);
    } catch (error) {
      this.state = before;
      this.rollbackCount += 1;
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private async execute<RowType>(sql: string, values: readonly unknown[]): Promise<SqlResult<RowType>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.statements.push(statement);
    if (statement.includes('from saas_attempts a') && statement.includes('join saas_requests r')) {
      const [tenantId, requestId, attemptId] = values;
      const row = this.state.row;
      return result(
        row.attempt_tenant_id === tenantId && row.attempt_request_id === requestId && row.attempt_id === attemptId
          ? [
              {
                ...row,
                attempt_response_started: row.response_started,
                attempt_binding_state: row.binding_state,
                attempt_dispatch_authority_state: row.dispatch_authority_state,
                attempt_customer_price_version: row.attempt_customer_price_version,
                attempt_provider_id: row.provider_id,
                attempt_product_id: row.product_id,
                attempt_public_model_id: row.attempt_route_public_model_id,
                attempt_public_model_version: row.attempt_route_public_model_version,
                request_supply_mode: row.supply_mode,
                request_customer_price_version: row.request_customer_price_version,
                request_result_state: row.request_result_state,
                request_reconciliation_state: row.reconciliation_state,
                request_financial_status: row.financial_status,
                request_state_version: row.request_state_version,
              } as RowType,
            ]
          : [],
      );
    }
    if (statement.includes('from saas_billing_reservations')) {
      const [tenantId, requestId, namespace, businessKey] = values;
      const hold = this.state.hold;
      return result(
        hold &&
          hold.tenant_id === tenantId &&
          hold.request_id === requestId &&
          hold.idempotency_namespace === namespace &&
          hold.business_key === businessKey
          ? [hold as RowType]
          : [],
      );
    }
    throw new Error(`Unexpected fake SQL: ${statement}`);
  }
}

function usage(): NormalizedUsageExact {
  return {
    inputTotal: '12',
    inputUncached: '12',
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: '8',
    reasoningOutput: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'provider-usage-v1',
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
}

function settlementInput(overrides: Partial<ConditionalSettlementInput> = {}): ConditionalSettlementInput {
  return {
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    idempotencyKey: 'reconciliation-key-1',
    providerOperationId: 'provider-operation-1',
    usage: usage(),
    charge: {
      amountMinorUnits: '25',
      currency: 'USD',
      rateCardId: 'price-snapshot-1',
      rateCardVersion: 'rate-v1',
    },
    expectedState: {
      attempt: {
        dispatchState: 'unknown',
        resultState: 'unknown',
        responseStarted: false,
        stateVersion: 4,
      },
      request: {
        resultState: 'unknown',
        reconciliationState: 'pending',
        financialStatus: 'pending',
        stateVersion: 3,
      },
    },
    ...overrides,
  };
}

function fakeUsageEvent(id: string): UsageEventRecord {
  return {
    id,
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    supplyMode: 'platform',
    dedupeKeyDigest: 'd'.repeat(64),
    eventDigest: 'e'.repeat(64),
    ...usage(),
    createdAt: '2026-09-28T00:00:00.000Z',
  };
}

class FakeMetering implements ConditionalSettlementMetering {
  readonly executors: SqlExecutor[] = [];
  failAtAttemptTransition = false;

  constructor(private readonly database: FakeDatabase) {}

  async recordUsageEvent(
    input: RecordUsageEventInput,
    options: MeteringOperationOptions = {},
  ): Promise<UsageEventRecord> {
    this.requireExecutor(options.executor);
    const eventKey = input.eventKey ?? '';
    if (this.database.state.usageEventKey === null) {
      this.database.state.usageEventKey = eventKey;
      this.database.state.usage = structuredClone(input.usage) as NormalizedUsageExact;
      this.database.state.usageEventId = 'usage-event-1';
      this.database.state.usageEventCount += 1;
    } else if (
      this.database.state.usageEventKey !== eventKey ||
      JSON.stringify(this.database.state.usage) !== JSON.stringify(input.usage)
    ) {
      throw Object.assign(new Error('usage conflict'), { code: 'USAGE_DUPLICATE_CONFLICT' });
    }
    return fakeUsageEvent(this.database.state.usageEventId ?? 'usage-event-1');
  }

  async getAttempt(): Promise<AttemptRecord | null> {
    return {
      id: 'attempt-1',
      tenantId: 'tenant-1',
      requestId: 'request-1',
      dispatchState: this.database.state.row.attempt_dispatch_state,
      resultState: this.database.state.row.attempt_result_state,
      responseStarted: this.database.state.row.response_started,
      stateVersion: this.database.state.row.attempt_state_version,
    } as AttemptRecord;
  }

  async createUsageSettlement(
    input: RecordUsageSettlementInput,
    options: MeteringOperationOptions = {},
  ): Promise<UsageSettlementRecord> {
    this.requireExecutor(options.executor);
    if (this.database.state.settlementKey === null) {
      this.database.state.settlementKey = input.settlementKey;
      this.database.state.normalSuccessEvidenceRef = input.normalSuccessEvidenceRef ?? null;
      this.database.state.usageSettlementCount += 1;
    } else if (this.database.state.settlementKey !== input.settlementKey ||
      this.database.state.normalSuccessEvidenceRef !== (input.normalSuccessEvidenceRef ?? null)) {
      throw Object.assign(new Error('settlement conflict'), { code: 'USAGE_SETTLEMENT_CONFLICT' });
    }
    return {
      id: 'usage-settlement-1',
      tenantId: input.tenantId,
      usageEventId: input.usageEventId,
      requestId: 'request-1',
      attemptId: 'attempt-1',
      settlementKeyDigest: 's'.repeat(64),
      settlementDigest: 't'.repeat(64),
      normalSuccessEvidenceRef: this.database.state.normalSuccessEvidenceRef,
      kind: 'usage_recorded',
      createdAt: '2026-09-28T00:00:00.000Z',
    };
  }

  async transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord> {
    this.requireExecutor(input.executor);
    if (this.failAtAttemptTransition) throw new Error('injected transition failure');
    this.database.state.row.attempt_dispatch_state = input.dispatchState;
    this.database.state.row.attempt_result_state = input.resultState;
    this.database.state.row.response_started = input.responseStarted;
    this.database.state.row.attempt_state_version = Number(input.expectedStateVersion ?? 0) + 1;
    return {} as AttemptRecord;
  }

  async transitionRequest(input: RequestTransitionInput): Promise<RequestRecord> {
    this.requireExecutor(input.executor);
    this.database.state.row.request_result_state = input.resultState;
    this.database.state.row.reconciliation_state = input.reconciliationState;
    this.database.state.row.request_state_version = Number(input.expectedStateVersion ?? 0) + 1;
    return { stateVersion: this.database.state.row.request_state_version } as unknown as RequestRecord;
  }

  async transitionFinancialStatus(input: FinancialTransitionInput): Promise<RequestRecord> {
    this.requireExecutor(input.executor);
    this.database.state.row.financial_status = input.financialStatus;
    this.database.state.row.request_state_version = Number(input.expectedStateVersion ?? 0) + 1;
    return { stateVersion: this.database.state.row.request_state_version } as unknown as RequestRecord;
  }

  private requireExecutor(executor: SqlExecutor | undefined): asserts executor is SqlExecutor {
    assert.ok(executor);
    this.executors.push(executor);
  }
}

class FakeBilling implements ConditionalSettlementBilling {
  executor: BillingTransactionExecutor | null = null;
  callCount = 0;
  readonly settlementInputs: SettleBillingInput[] = [];
  readonly pendingInputs: MarkReconciliationPendingInput[] = [];

  constructor(private readonly database: FakeDatabase) {}

  async settle(executor: BillingTransactionExecutor, input: SettleBillingInput): Promise<BillingReservationResult> {
    this.executor = executor;
    this.callCount += 1;
    this.settlementInputs.push(input);
    const hold = this.database.state.hold;
    if (!hold) throw Object.assign(new Error('hold missing'), { code: 'RESERVATION_NOT_FOUND' });
    assert.equal(input.businessKey, admissionBusinessKey());
    assert.equal(input.idempotencyNamespace, 'saas.billing.reservation');
    const requested = BigInt(String(input.actualAmountMinorUnits));
    if (hold.state === 'settled') {
      if (
        hold.settlement_id !== input.settlementId ||
        hold.settlement_amount_minor_units !== requested.toString() ||
        hold.usage_evidence_ref !== input.usageEvidenceRef
      ) {
        throw Object.assign(new Error('billing replay conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
      }
      return { state: 'settled' } as BillingReservationResult;
    }
    if (requested > BigInt(String(hold.amount_minor_units))) {
      hold.state = 'reconciliation_pending';
      hold.settlement_id = input.settlementId;
      hold.settlement_amount_minor_units = requested.toString();
      hold.usage_evidence_ref = input.usageEvidenceRef;
      this.database.state.spendingFrozen = true;
      return { state: 'reconciliation_pending' } as BillingReservationResult;
    }
    hold.state = 'settled';
    hold.settlement_id = input.settlementId;
    hold.settlement_amount_minor_units = requested.toString();
    hold.usage_evidence_ref = input.usageEvidenceRef;
    if (requested > 0n) {
      this.database.state.ledgerTransactionCount += 1;
      this.database.state.ledgerEntryCount += 2;
    }
    return { state: 'settled' } as BillingReservationResult;
  }

  async markReconciliationPending(
    executor: BillingTransactionExecutor,
    input: MarkReconciliationPendingInput,
  ): Promise<BillingReservationResult> {
    this.executor = executor;
    this.pendingInputs.push(input);
    const hold = this.database.state.hold;
    if (!hold) throw new Error('hold missing');
    hold.state = 'reconciliation_pending';
    return { state: 'reconciliation_pending' } as BillingReservationResult;
  }
}

function createHarness(state: FakeState = initialState()): {
  database: FakeDatabase;
  metering: FakeMetering;
  billing: FakeBilling;
  adapter: DurableConditionalSettlementPort;
} {
  const database = new FakeDatabase(state);
  const metering = new FakeMetering(database);
  const billing = new FakeBilling(database);
  return {
    database,
    metering,
    billing,
    adapter: new DurableConditionalSettlementPort(database, { metering, billing }),
  };
}

test('settles the platform hold and composes every write on one transaction executor', async () => {
  const harness = createHarness();
  const outcome = await harness.adapter.submit(settlementInput());

  assert.equal(outcome.status, 'settled');
  assert.equal(harness.database.transactionCount, 1);
  assert.equal(harness.database.rollbackCount, 0);
  assert.equal(harness.database.state.hold?.state, 'settled');
  assert.equal(harness.database.state.ledgerTransactionCount, 1);
  assert.equal(harness.database.state.ledgerEntryCount, 2);
  assert.equal(harness.database.state.usageEventCount, 1);
  assert.equal(harness.database.state.usageSettlementCount, 1);
  assert.ok(harness.billing.executor);
  assert.equal(harness.billing.settlementInputs[0]?.usageEvidenceRef, 'provider-operation-1');
  assert.equal(harness.billing.settlementInputs[0]?.reconciliationEvidenceRef, 'provider-operation-1');
  const reservationReads = harness.database.statements.filter((sql) => sql.includes('from saas_billing_reservations'));
  assert.ok(reservationReads.length > 0);
  assert.ok(reservationReads.every((sql) => !sql.endsWith('for update')));
  assert.ok(harness.metering.executors.every((executor) => executor === harness.billing.executor));
});

test('replays a stable idempotency key and conflicts when its charge changes', async () => {
  const harness = createHarness();
  const input = settlementInput();
  const first = await harness.adapter.submit(input);
  const replay = await harness.adapter.submit(input);
  const changed = await harness.adapter.submit({
    ...input,
    charge: { ...input.charge, amountMinorUnits: '26' },
  });

  assert.equal(first.status, 'settled');
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.settlementId, input.idempotencyKey);
  assert.equal(changed.status, 'conflict');
  assert.equal(harness.database.state.usageEventCount, 1);
  assert.equal(harness.database.state.usageSettlementCount, 1);
  assert.equal(harness.database.state.ledgerTransactionCount, 1);
  assert.equal(harness.billing.callCount, 3);
});

test('rejects stale expected state and stored identity mismatches before any charge', async () => {
  const stale = createHarness();
  stale.database.state.row.attempt_state_version = 5;
  const staleResult = await stale.adapter.submit(settlementInput());
  assert.equal(staleResult.status, 'conflict');
  assert.equal(stale.database.state.usageEventCount, 0);
  assert.equal(stale.database.state.ledgerTransactionCount, 0);

  const mismatch = createHarness();
  mismatch.database.state.row.account_owner_kind = 'tenant';
  const mismatchResult = await mismatch.adapter.submit(settlementInput());
  assert.equal(mismatchResult.status, 'conflict');
  assert.equal(mismatch.database.state.usageEventCount, 0);
  assert.equal(mismatch.database.state.hold?.state, 'reserved');
});

test('rolls back usage and wallet effects when a later metering transition fails', async () => {
  const harness = createHarness();
  harness.metering.failAtAttemptTransition = true;

  const outcome = await harness.adapter.submit(settlementInput());

  assert.equal(outcome.status, 'conflict');
  assert.equal(harness.database.rollbackCount, 1);
  assert.equal(harness.database.state.usageEventCount, 0);
  assert.equal(harness.database.state.usageSettlementCount, 0);
  assert.equal(harness.database.state.ledgerTransactionCount, 0);
  assert.equal(harness.database.state.ledgerEntryCount, 0);
  assert.equal(harness.database.state.hold?.state, 'reserved');
});

test('keeps an overage frozen and reconciliation-pending without reporting settled', async () => {
  const harness = createHarness(
    initialState({
      hold: initialHold({ amount_minor_units: '10' }),
    }),
  );
  const outcome = await harness.adapter.submit(
    settlementInput({
      charge: { ...settlementInput().charge, amountMinorUnits: '20' },
    }),
  );

  assert.equal(outcome.status, 'conflict');
  assert.equal(harness.database.rollbackCount, 0);
  assert.equal(harness.database.state.hold?.state, 'reconciliation_pending');
  assert.equal(harness.database.state.spendingFrozen, true);
  assert.equal(harness.database.state.row.financial_status, 'reconciliation_pending');
  assert.equal(harness.database.state.row.request_result_state, 'succeeded');
  assert.equal(harness.database.state.row.reconciliation_state, 'resolved');
  assert.equal(harness.database.state.row.attempt_dispatch_state, 'sent');
  assert.equal(harness.database.state.row.attempt_result_state, 'succeeded');
  assert.equal(harness.database.state.ledgerTransactionCount, 0);
  assert.equal(harness.database.state.normalSuccessEvidenceRef, null, 'unknown/outcome writer must stay legacy');
});

test('a verified successful execution stays succeeded when Billing fences an overage', async () => {
  const state = initialState({
    row: initialRow({
      attempt_dispatch_state: 'sent',
      attempt_result_state: 'pending',
      response_started: true,
      attempt_state_version: 6,
      request_result_state: 'pending',
      reconciliation_state: 'none',
      financial_status: 'pending',
      request_state_version: 8,
    }),
    hold: initialHold({ amount_minor_units: '10' }),
  });
  const harness = createHarness(state);
  const port = new DurableNormalSuccessSettlementPort(harness.database, {
    metering: harness.metering,
    billing: harness.billing,
  });

  const outcome = await port.complete({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    supplyMode: 'platform',
    responseStarted: true,
    priceSnapshotRef: 'price-snapshot-1',
    reservationId: 'hold-1',
    currency: 'USD',
    customerPriceVersion: 'price-v1',
    chargeAmountMinorUnits: '20',
    usageEventKey: 'success-usage-event',
    settlementKey: 'success-settlement',
    usageEvidenceRef: 'e'.repeat(64),
    usage: usage(),
  });

  assert.equal(outcome.kind, 'reconciliation_pending');
  assert.equal(harness.database.state.row.attempt_result_state, 'succeeded');
  assert.equal(harness.database.state.row.attempt_dispatch_state, 'sent');
  assert.equal(harness.database.state.row.request_result_state, 'succeeded');
  assert.equal(harness.database.state.row.reconciliation_state, 'resolved');
  assert.equal(harness.database.state.row.financial_status, 'reconciliation_pending');
  assert.equal(harness.database.state.hold?.state, 'reconciliation_pending');
  assert.equal(harness.database.state.spendingFrozen, true);
  assert.equal(harness.database.state.normalSuccessEvidenceRef, 'e'.repeat(64));
});

test('unknown platform results move the request and its reservation to reconciliation pending together', async () => {
  const database = new FakeDatabase(
    initialState({
      row: initialRow({
        attempt_dispatch_state: 'sent',
        attempt_result_state: 'pending',
        response_started: true,
        attempt_state_version: 2,
        request_result_state: 'pending',
        reconciliation_state: 'none',
        financial_status: 'pending',
        request_state_version: 3,
      }),
    }),
  );
  const metering = new FakeMetering(database);
  const billing = new FakeBilling(database);
  const port = new DurableNormalSuccessSettlementPort(database, { metering, billing });

  await port.retainUnknown({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    supplyMode: 'platform',
    responseStarted: true,
    reason: 'dispatch_uncertain',
  });

  assert.equal(database.state.row.attempt_dispatch_state, 'unknown');
  assert.equal(database.state.row.attempt_result_state, 'unknown');
  assert.equal(database.state.row.request_result_state, 'unknown');
  assert.equal(database.state.row.reconciliation_state, 'pending');
  assert.equal(database.state.row.financial_status, 'reconciliation_pending');
  assert.equal(database.state.hold?.state, 'reconciliation_pending');
  assert.equal(billing.pendingInputs.length, 1);
  assert.equal(billing.executor, metering.executors[0]);
});

test('unknown retry repairs a reserved hold without changing its already-pending request state', async () => {
  const database = new FakeDatabase(
    initialState({
      row: initialRow({
        attempt_dispatch_state: 'unknown',
        attempt_result_state: 'unknown',
        response_started: true,
        attempt_state_version: 3,
        request_result_state: 'unknown',
        reconciliation_state: 'pending',
        financial_status: 'reconciliation_pending',
        request_state_version: 5,
      }),
    }),
  );
  const metering = new FakeMetering(database);
  const billing = new FakeBilling(database);
  const port = new DurableNormalSuccessSettlementPort(database, { metering, billing });

  await port.retainUnknown({
    tenantId: 'tenant-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    supplyMode: 'platform',
    responseStarted: true,
    reason: 'dispatch_uncertain',
  });

  assert.equal(database.state.row.request_state_version, 5);
  assert.equal(database.state.hold?.state, 'reconciliation_pending');
  assert.equal(billing.pendingInputs.length, 1);
});

test('rejects BYOK reconciliation without touching a platform wallet or usage settlement', async () => {
  const harness = createHarness(
    initialState({
      row: initialRow({
        supply_mode: 'byok',
        account_owner_kind: 'tenant',
        attempt_route_target_mode: 'tenant_account',
        request_route_target_mode: 'tenant_account',
      }),
      hold: null,
    }),
  );

  const outcome = await harness.adapter.submit(settlementInput());

  assert.equal(outcome.status, 'conflict');
  assert.equal(harness.metering.executors.length, 0);
  assert.equal(harness.billing.callCount, 0);
  assert.equal(harness.database.state.ledgerTransactionCount, 0);
  assert.equal(harness.database.state.usageEventCount, 0);
});
