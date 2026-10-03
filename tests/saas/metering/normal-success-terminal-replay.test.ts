import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { NormalSuccessTransactionInput } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import {
  type ConditionalSettlementBilling, type ConditionalSettlementMetering, DurableNormalSuccessSettlementPort,
} from '../../../src/saas/metering/conditional-settlement-port.js';
import { digestClientKey, normalSuccessSettlementDigest, settlementDigest, sha256Hex, usageEventDigest,
  type HmacSecret } from '../../../src/saas/metering/digest.js';
import { SaasMeteringService } from '../../../src/saas/metering/service.js';
import type { AttemptRecord, NormalizedUsageExact } from '../../../src/saas/metering/types.js';

// Unit-only persisted-row model. The replay verifier is the real metering
// service with its real canonical/HMAC helpers; this is NOT a PG/ledger proof.
type Row = Record<string, unknown>;
const date = '2026-10-01T00:00:00.000Z';
const syntheticHmac: HmacSecret = new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6]);

function usage(): NormalizedUsageExact {
  return {
    inputTotal: '12', inputUncached: '12', cacheRead: null, cacheWrite: null,
    cacheWrite5m: null, cacheWrite1h: null, outputTotal: '8', reasoningOutput: null,
    status: 'reported', source: 'upstream', semanticsVersion: 'provider-usage-v1',
    measurementKind: 'snapshot', billableBasis: 'exact',
  };
}

function input(mode: 'platform' | 'byok' = 'platform'): NormalSuccessTransactionInput {
  return {
    tenantId: 'tenant-1', requestId: 'request-1', attemptId: 'attempt-1', supplyMode: mode,
    responseStarted: true, usageEventKey: 'original-event-key', settlementKey: 'original-settlement-key',
    usageEvidenceRef: 'e'.repeat(64), usage: usage(),
    reservationId: mode === 'platform' ? 'hold-1' : null,
    priceSnapshotRef: mode === 'platform' ? 'quote-1' : null,
    currency: mode === 'platform' ? 'USD' : null,
    customerPriceVersion: mode === 'platform' ? 'price-v1' : null,
    chargeAmountMinorUnits: mode === 'platform' ? '20' : null,
  };
}

interface Facts {
  state: Row | null;
  hold: Row | null;
  usage: Row[];
  settlements: Row[];
  attempt: AttemptRecord | null;
}

function persistedFacts(original: NormalSuccessTransactionInput, pending: boolean, hmac?: HmacSecret, legacy = false): Facts {
  const eventDigest = usageEventDigest(original, usage());
  const settlementKeyDigest = digestClientKey(original.settlementKey, hmac);
  const financialStatus = original.supplyMode === 'byok' ? 'not_applicable' : pending ? 'reconciliation_pending' : 'settled';
  return {
    state: {
      attempt_id: original.attemptId, attempt_tenant_id: original.tenantId, attempt_request_id: original.requestId,
      attempt_dispatch_state: 'sent', attempt_result_state: 'succeeded', attempt_response_started: true,
      attempt_state_version: '7', attempt_binding_state: 'bound', attempt_dispatch_authority_state: 'bound',
      attempt_customer_price_version: original.customerPriceVersion, attempt_provider_id: 'provider-1',
      attempt_product_id: 'product-1', attempt_public_model_id: 'public-model-1', attempt_public_model_version: '1',
      request_id: original.requestId, request_tenant_id: original.tenantId, request_supply_mode: original.supplyMode,
      request_customer_price_version: original.customerPriceVersion, request_result_state: 'succeeded',
      request_reconciliation_state: 'resolved', request_financial_status: financialStatus, request_state_version: '9',
    },
    hold: original.supplyMode === 'byok' ? null : {
      id: original.reservationId, tenant_id: original.tenantId, request_id: original.requestId,
      wallet_id: 'wallet-1', amount_minor_units: pending ? '10' : '100',
      idempotency_namespace: 'saas.billing.reservation',
      business_key: `saas-request-admission:${original.tenantId}:${original.requestId}`,
      currency: original.currency, state: financialStatus, price_snapshot_ref: original.priceSnapshotRef,
      settlement_id: original.settlementKey, settlement_amount_minor_units: original.chargeAmountMinorUnits,
      usage_evidence_ref: original.usageEvidenceRef,
      ledger_transaction_id: pending ? null : 'ledger-1',
    },
    usage: [{
      id: 'usage-1', tenant_id: original.tenantId, request_id: original.requestId, attempt_id: original.attemptId,
      supply_mode: original.supplyMode, dedupe_key_digest: digestClientKey(original.usageEventKey, hmac),
      event_digest: eventDigest, input_total: '12', input_uncached: '12', cache_read: null, cache_write: null,
      cache_write_5m: null, cache_write_1h: null, output_total: '8', reasoning_output: null,
      status: 'reported', source: 'upstream', semantics_version: 'provider-usage-v1',
      measurement_kind: 'snapshot', billable_basis: 'exact', created_at: date,
    }],
    settlements: [{
      id: 'settlement-1', tenant_id: original.tenantId, request_id: original.requestId, attempt_id: original.attemptId,
      usage_event_id: 'usage-1', kind: 'usage_recorded', settlement_key_digest: settlementKeyDigest,
      normal_success_evidence_ref: legacy ? null : original.usageEvidenceRef,
      settlement_digest: (legacy ? settlementDigest : normalSuccessSettlementDigest)({
        tenantId: original.tenantId, usageEventId: 'usage-1', kind: 'usage_recorded', usageEventDigest: eventDigest,
        settlementKeyDigest, usageEvidenceRef: original.usageEvidenceRef,
      }), created_at: date,
    }],
    attempt: {
      id: original.attemptId, tenantId: original.tenantId, requestId: original.requestId,
      dispatchState: 'sent', resultState: 'succeeded', responseStarted: true, stateVersion: 7,
    } as AttemptRecord,
  };
}

class ReadonlyReplayDatabase implements SaasDatabase {
  readonly statements: string[] = [];
  currentExecutor: SqlExecutor | undefined;
  outsideQueries = 0;
  transactions = 0;
  constructor(readonly facts: Facts) {}

  async query<RowType>(): Promise<SqlResult<RowType>> {
    this.outsideQueries += 1;
    throw new Error('unit replay escaped its transaction');
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const tx: SqlExecutor = {
      query: async <RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> => {
        const statement = sql.replace(/\s+/g, ' ').trim();
        this.statements.push(statement);
        assert.match(statement, /^SELECT /, 'terminal replay must not write or upsert');
        const rows = this.select(statement, values);
        return { rows: structuredClone(rows) as RowType[], rowCount: rows.length };
      },
    };
    this.currentExecutor = tx;
    try { return await work(tx); }
    finally { this.currentExecutor = undefined; }
  }

  async migrate(): Promise<void> { throw new Error('unit replay must not migrate'); }
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private select(sql: string, values: readonly unknown[]): Row[] {
    if (sql.includes('FROM saas_attempts a')) {
      const state = this.facts.state;
      return state && state.attempt_tenant_id === values[0] && state.attempt_request_id === values[1] &&
        state.attempt_id === values[2] ? [state] : [];
    }
    if (sql.includes('FROM saas_usage_events')) {
      return this.facts.usage.filter((row) => row.tenant_id === values[0] && row.attempt_id === values[1] &&
        row.dedupe_key_digest === values[2]);
    }
    if (sql.includes('FROM saas_usage_settlements')) {
      return this.facts.settlements.filter((row) => row.tenant_id === values[0] && row.usage_event_id === values[1]);
    }
    if (sql.includes('FROM saas_billing_reservations')) {
      const hold = this.facts.hold;
      return hold && hold.tenant_id === values[0] && hold.request_id === values[1] &&
        hold.idempotency_namespace === values[2] && hold.business_key === values[3] ? [hold] : [];
    }
    throw new Error('unexpected unit replay SQL');
  }
}

function harness(options: { mode?: 'platform' | 'byok'; pending?: boolean; hmac?: HmacSecret; legacy?: boolean } = {}) {
  const original = input(options.mode);
  const facts = persistedFacts(original, options.pending ?? false, options.hmac, options.legacy);
  const database = new ReadonlyReplayDatabase(facts);
  const verifier = new SaasMeteringService(database, options.hmac === undefined ? {} : { idempotencyHmacSecret: options.hmac });
  const calls = { effects: 0, attemptReads: 0, verifications: 0 };
  const unexpectedEffect = async (): Promise<never> => {
    calls.effects += 1;
    throw new Error('terminal replay invoked a write capability');
  };
  const metering: ConditionalSettlementMetering & Pick<SaasMeteringService, 'getAttempt'> = {
    recordUsageEvent: unexpectedEffect, createUsageSettlement: unexpectedEffect,
    transitionAttempt: unexpectedEffect, transitionRequest: unexpectedEffect, transitionFinancialStatus: unexpectedEffect,
    assertUsageSettlementReplay: async (replay, operation) => {
      calls.verifications += 1;
      assert.ok(database.currentExecutor);
      assert.strictEqual(operation?.executor, database.currentExecutor);
      await verifier.assertUsageSettlementReplay(replay, operation);
    },
    getAttempt: async (_tenant, _request, _attempt, operation) => {
      calls.attemptReads += 1;
      assert.ok(database.currentExecutor, 'attempt must be read before transaction closes');
      assert.strictEqual(operation?.executor, database.currentExecutor);
      return structuredClone(facts.attempt);
    },
  };
  const billing: ConditionalSettlementBilling = { settle: unexpectedEffect, markReconciliationPending: unexpectedEffect };
  const port = new DurableNormalSuccessSettlementPort(database, { metering, billing });
  return { original, facts, database, calls, metering, port };
}

function assertReadonly(h: ReturnType<typeof harness>, before: Facts): void {
  assert.deepEqual(h.facts, before, 'no persisted unit fact may change on replay/rejection');
  assert.equal(h.calls.effects, 0, 'no usage, settlement, ledger, billing, or terminal-state effect');
  assert.equal(h.database.outsideQueries, 0);
  assert.equal(h.database.currentExecutor, undefined);
  assert.ok(h.database.statements.every((sql) => sql.startsWith('SELECT ')));
}

for (const pending of [false, true]) {
  for (const hmac of [undefined, syntheticHmac]) {
    test(`platform terminal ${pending ? 'reconciliation_pending' : 'settled'} stable replay (${hmac ? 'HMAC' : 'SHA'}) is read-only`, async () => {
      const h = harness({ pending, ...(hmac === undefined ? {} : { hmac }) });
      const before = structuredClone(h.facts);
      for (let count = 0; count < 2; count += 1) {
        const outcome = await h.port.complete({
          ...h.original, usage: { ...usage(), inputTotal: '00012', inputUncached: 12n, outputTotal: 8 },
        });
        assert.equal(outcome.kind, 'replayed');
        assert.deepEqual(outcome.attempt, h.facts.attempt);
      }
      assert.equal(h.calls.verifications, 2);
      assert.equal(h.calls.attemptReads, 2);
      assert.equal(h.database.transactions, 2);
      assertReadonly(h, before);
    });
  }

  test(`platform terminal ${pending ? 'reconciliation_pending' : 'settled'} rejects changed keys, usage, evidence, charge and quote`, async (t) => {
    const changes: Record<string, Partial<NormalSuccessTransactionInput>> = {
      event_key: { usageEventKey: 'new-event-key' }, settlement_key: { settlementKey: 'new-settlement-key' },
      both_keys: { usageEventKey: 'new-event-key', settlementKey: 'new-settlement-key' },
      evidence: { usageEvidenceRef: 'f'.repeat(64) }, amount: { chargeAmountMinorUnits: '21' },
      zero_amount: { chargeAmountMinorUnits: '0' }, reservation: { reservationId: 'hold-2' },
      quote: { priceSnapshotRef: 'quote-2' }, currency: { currency: 'EUR' }, price_version: { customerPriceVersion: 'price-v2' },
      input_total: { usage: { ...usage(), inputTotal: '13' } }, input_uncached: { usage: { ...usage(), inputUncached: '11' } },
      cache_read: { usage: { ...usage(), cacheRead: '0' } }, cache_write: { usage: { ...usage(), cacheWrite: '0' } },
      cache_5m: { usage: { ...usage(), cacheWrite5m: '0' } }, cache_1h: { usage: { ...usage(), cacheWrite1h: '0' } },
      output: { usage: { ...usage(), outputTotal: '9' } }, reasoning: { usage: { ...usage(), reasoningOutput: '0' } },
      semantics: { usage: { ...usage(), semanticsVersion: 'provider-usage-v2' } },
      source: { usage: { ...usage(), source: 'legacy' } }, status: { usage: { ...usage(), status: 'partial' } },
      measurement: { usage: { ...usage(), measurementKind: 'delta' } }, basis: { usage: { ...usage(), billableBasis: 'estimated' } },
      negative: { usage: { ...usage(), inputTotal: -1 } }, fractional: { usage: { ...usage(), outputTotal: 1.5 } },
      unsafe_number: { usage: { ...usage(), inputTotal: Number.MAX_SAFE_INTEGER + 1 } },
      bigint_overflow: { usage: { ...usage(), inputTotal: '9223372036854775808' } },
      missing_semantics: { usage: { ...usage(), semanticsVersion: '' } },
    };
    for (const [name, changed] of Object.entries(changes)) {
      await t.test(name, async () => {
        const h = harness({ pending, hmac: syntheticHmac });
        const before = structuredClone(h.facts);
        await assert.rejects(h.port.complete({ ...h.original, ...changed }));
        assertReadonly(h, before);
      });
    }
  });

  test(`platform terminal ${pending ? 'reconciliation_pending' : 'settled'} rejects missing/corrupt persisted facts`, async (t) => {
    const changes: Record<string, (facts: Facts) => void> = {
      no_state: (f) => { f.state = null; }, no_usage: (f) => { f.usage = []; },
      no_settlement: (f) => { f.settlements = []; }, no_hold: (f) => { f.hold = null; },
      no_attempt: (f) => { f.attempt = null; },
      usage_identity: (f) => { f.usage[0]!.request_id = 'request-2'; },
      usage_missing_identity: (f) => { delete f.usage[0]!.request_id; },
      usage_mode: (f) => { f.usage[0]!.supply_mode = 'byok'; },
      usage_key_digest: (f) => { f.usage[0]!.dedupe_key_digest = '9'.repeat(64); },
      usage_digest: (f) => { f.usage[0]!.event_digest = 'a'.repeat(64); },
      usage_counter: (f) => { f.usage[0]!.output_total = '9'; },
      usage_semantics: (f) => { f.usage[0]!.semantics_version = 'provider-usage-v2'; },
      usage_invalid_status: (f) => { f.usage[0]!.status = 'invented'; },
      usage_missing_counter: (f) => { delete f.usage[0]!.output_total; },
      settlement_identity: (f) => { f.settlements[0]!.attempt_id = 'attempt-2'; },
      settlement_missing_identity: (f) => { delete f.settlements[0]!.request_id; },
      settlement_digest: (f) => { f.settlements[0]!.settlement_digest = 'b'.repeat(64); },
      settlement_key_digest: (f) => { f.settlements[0]!.settlement_key_digest = 'c'.repeat(64); },
      settlement_kind: (f) => { f.settlements[0]!.kind = 'platform_cost_observed'; },
      settlement_ref: (f) => { f.settlements[0]!.normal_success_evidence_ref = 'f'.repeat(64); },
      missing_settlement_ref_column: (f) => { delete f.settlements[0]!.normal_success_evidence_ref; },
      malformed_settlement_ref: (f) => { f.settlements[0]!.normal_success_evidence_ref = 'E'.repeat(64); },
      hold_state: (f) => { f.hold!.state = 'reserved'; },
      hold_settlement_id: (f) => { f.hold!.settlement_id = 'another-original-key'; },
      hold_amount: (f) => { f.hold!.settlement_amount_minor_units = '21'; },
      hold_evidence: (f) => { f.hold!.usage_evidence_ref = 'd'.repeat(64); },
      hold_missing_id: (f) => { f.hold!.settlement_id = null; },
      hold_missing_amount: (f) => { f.hold!.settlement_amount_minor_units = null; },
      hold_missing_evidence: (f) => { f.hold!.usage_evidence_ref = null; },
      hold_missing_wallet: (f) => { delete f.hold!.wallet_id; },
      hold_missing_units: (f) => { delete f.hold!.amount_minor_units; },
      hold_zero_units: (f) => { f.hold!.amount_minor_units = '0'; },
      hold_overflow_units: (f) => { f.hold!.amount_minor_units = '9223372036854775808'; },
      hold_bad_charge_ledger: (f) => { f.hold!.ledger_transaction_id = pending ? 'ledger-1' : null; },
      false_response_started: (f) => { f.state!.attempt_response_started = false; },
      unbound: (f) => { f.state!.attempt_dispatch_authority_state = 'unbound'; },
      missing_request_version: (f) => { delete f.state!.request_state_version; },
      attempt_version: (f) => { f.attempt = { ...f.attempt!, stateVersion: 8 }; },
      attempt_identity: (f) => { f.attempt = { ...f.attempt!, id: 'attempt-2' }; },
    };
    for (const [name, change] of Object.entries(changes)) {
      await t.test(name, async () => {
        const h = harness({ pending });
        change(h.facts);
        const before = structuredClone(h.facts);
        await assert.rejects(h.port.complete(h.original));
        assertReadonly(h, before);
      });
    }
  });
}

test('platform cannot bypass the original effect by supplying two other valid persisted keys', async () => {
  const h = harness();
  const other = { ...h.original, usageEventKey: 'other-event-key', settlementKey: 'other-settlement-key' };
  const otherFacts = persistedFacts(other, false);
  otherFacts.usage[0]!.id = 'usage-2';
  otherFacts.settlements[0]!.id = 'settlement-2';
  otherFacts.settlements[0]!.usage_event_id = 'usage-2';
  otherFacts.settlements[0]!.settlement_digest = normalSuccessSettlementDigest({
    tenantId: other.tenantId, usageEventId: 'usage-2', kind: 'usage_recorded',
    usageEventDigest: String(otherFacts.usage[0]!.event_digest),
    settlementKeyDigest: digestClientKey(other.settlementKey), usageEvidenceRef: other.usageEvidenceRef,
  });
  h.facts.usage.push(...otherFacts.usage);
  h.facts.settlements.push(...otherFacts.settlements);
  const before = structuredClone(h.facts);
  await assert.rejects(h.port.complete(other), /does not match its settled hold/);
  assertReadonly(h, before);
});

test('terminal replay rejects an absent verifier instead of falling back to writer upserts', async () => {
  const h = harness();
  delete h.metering.assertUsageSettlementReplay;
  const before = structuredClone(h.facts);
  await assert.rejects(h.port.complete(h.original), /verification capability is unavailable/);
  assertReadonly(h, before);
});

test('zero-charge terminal replay compares the persisted zero rather than treating it as missing', async () => {
  const h = harness();
  h.facts.hold!.settlement_amount_minor_units = '0';
  h.facts.hold!.ledger_transaction_id = null;
  const before = structuredClone(h.facts);
  const outcome = await h.port.complete({ ...h.original, chargeAmountMinorUnits: '0' });
  assert.equal(outcome.kind, 'replayed');
  assertReadonly(h, before);
});

test('legacy BYOK NULL ref is rejected and never reads a wallet', async () => {
  const h = harness({ mode: 'byok', hmac: syntheticHmac, legacy: true });
  const before = structuredClone(h.facts);
  await assert.rejects(h.port.complete(h.original), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, 'USAGE_SETTLEMENT_CONFLICT');
    return true;
  });
  assert.equal(h.calls.verifications, 1, 'persisted canonical usage and keys were still verified');
  assert.equal(h.calls.attemptReads, 0);
  assert.equal(h.database.statements.some((sql) => /saas_(?:billing|wallet|ledger)/.test(sql)), false);
  assertReadonly(h, before);
});

test('BYOK changed keys/counters/ref and any wallet authority are rejected without financial reads', async (t) => {
  const changes: Record<string, Partial<NormalSuccessTransactionInput>> = {
    event_key: { usageEventKey: 'new-event' }, settlement_key: { settlementKey: 'new-settlement' },
    both_keys: { usageEventKey: 'new-event', settlementKey: 'new-settlement' },
    usage: { usage: { ...usage(), inputTotal: '13' } }, semantics: { usage: { ...usage(), semanticsVersion: 'v2' } },
    opaque_ref: { usageEvidenceRef: 'f'.repeat(64) },
    reservation: { reservationId: 'hold-1' }, quote: { priceSnapshotRef: 'quote-1' }, currency: { currency: 'USD' },
    amount: { chargeAmountMinorUnits: '0' }, price_version: { customerPriceVersion: 'price-v1' },
  };
  for (const [name, changed] of Object.entries(changes)) {
    await t.test(name, async () => {
      const h = harness({ mode: 'byok' });
      const before = structuredClone(h.facts);
      await assert.rejects(h.port.complete({ ...h.original, ...changed }));
      assert.equal(h.database.statements.some((sql) => /saas_(?:billing|wallet|ledger)/.test(sql)), false);
      assertReadonly(h, before);
    });
  }
});

test('BYOK reconciliation_pending is not a valid terminal financial state', async () => {
  const h = harness({ mode: 'byok' });
  h.facts.state!.request_financial_status = 'reconciliation_pending';
  const before = structuredClone(h.facts);
  await assert.rejects(h.port.complete(h.original));
  assert.equal(h.database.statements.some((sql) => /saas_(?:billing|wallet|ledger)/.test(sql)), false);
  assertReadonly(h, before);
});

for (const hmac of [undefined, syntheticHmac]) {
  test(`new BYOK bound ref replays identical facts without wallet reads (${hmac ? 'HMAC' : 'SHA'})`, async () => {
    const h = harness({ mode: 'byok', ...(hmac === undefined ? {} : { hmac }) });
    const before = structuredClone(h.facts);
    for (let count = 0; count < 2; count += 1) {
      const outcome = await h.port.complete(h.original);
      assert.equal(outcome.kind, 'replayed');
      assert.deepEqual(outcome.attempt, h.facts.attempt);
    }
    assert.equal(h.calls.verifications, 2);
    assert.equal(h.calls.attemptReads, 2);
    assert.equal(h.database.statements.some((sql) => /saas_(?:billing|wallet|ledger)/.test(sql)), false);
    assertReadonly(h, before);
  });
}

for (const pending of [false, true]) {
  test(`legacy platform ${pending ? 'pending' : 'settled'} ref=NULL needs complete original hold facts`, async (t) => {
    const good = harness({ legacy: true, pending, hmac: syntheticHmac });
    const before = structuredClone(good.facts);
    assert.equal((await good.port.complete(good.original)).kind, 'replayed');
    assertReadonly(good, before);
    for (const changed of [
      { usageEvidenceRef: 'f'.repeat(64) }, { chargeAmountMinorUnits: '21' }, { currency: 'EUR' },
      { reservationId: 'hold-2' }, { settlementKey: 'new-key' }, { priceSnapshotRef: 'quote-2' },
    ]) {
      await t.test(Object.keys(changed)[0]!, async () => {
        const h = harness({ legacy: true, pending });
        const snapshot = structuredClone(h.facts);
        await assert.rejects(h.port.complete({ ...h.original, ...changed }));
        assertReadonly(h, snapshot);
      });
    }
  });
}

test('stored ref selects the algorithm and missing/invalid input cannot downgrade it', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    for (const legacy of [false, true]) {
      for (const value of [undefined, null, '', 'e'.repeat(63), 'E'.repeat(64), ` ${'e'.repeat(64)}`]) {
        await t.test(`${mode}/${legacy ? 'legacy' : 'bound'}/${typeof value}/${String(value).length}`, async () => {
          const h = harness({ mode, legacy });
          const before = structuredClone(h.facts);
          await assert.rejects(Reflect.apply(h.port.complete, h.port, [{ ...h.original, usageEvidenceRef: value }]));
          assertReadonly(h, before);
        });
      }
    }
  }
  for (const legacy of [false, true]) {
    const h = harness({ legacy });
    const digestIdentity = { tenantId: h.original.tenantId, usageEventId: 'usage-1', kind: 'usage_recorded' as const,
      usageEventDigest: String(h.facts.usage[0]!.event_digest),
      settlementKeyDigest: digestClientKey(h.original.settlementKey), usageEvidenceRef: h.original.usageEvidenceRef };
    h.facts.settlements[0]!.settlement_digest = legacy
      ? normalSuccessSettlementDigest(digestIdentity) : settlementDigest(digestIdentity);
    const before = structuredClone(h.facts);
    await assert.rejects(h.port.complete(h.original));
    assertReadonly(h, before);
  }
});

test('normal-success digest has an explicit domain/version and binds every required tuple component', () => {
  const base = { tenantId: 'tenant-1', usageEventId: 'usage-1', kind: 'usage_recorded' as const,
    usageEventDigest: 'a'.repeat(64), settlementKeyDigest: digestClientKey('effect-key', syntheticHmac),
    usageEvidenceRef: 'e'.repeat(64) };
  const digest = normalSuccessSettlementDigest(base);
  assert.equal(digest, sha256Hex(JSON.stringify(['model-router.normal-success-settlement.v1', base.tenantId,
    base.usageEventId, base.kind, base.usageEventDigest, base.settlementKeyDigest, base.usageEvidenceRef])));
  assert.notEqual(digest, settlementDigest(base));
  for (const changed of [
    { tenantId: 'tenant-2' }, { usageEventId: 'usage-2' }, { usageEventDigest: 'b'.repeat(64) },
    { settlementKeyDigest: digestClientKey('effect-key') }, { usageEvidenceRef: 'f'.repeat(64) },
  ]) assert.notEqual(normalSuccessSettlementDigest({ ...base, ...changed }), digest);
  for (const value of [undefined, null, '', 'E'.repeat(64)]) {
    assert.throws(() => Reflect.apply(normalSuccessSettlementDigest, undefined, [{ ...base, usageEvidenceRef: value }]));
  }
});
