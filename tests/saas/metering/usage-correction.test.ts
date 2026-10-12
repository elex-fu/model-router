import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { usageCorrectionDigest } from '../../../src/saas/metering/digest.js';
import {
  type RecordUsageCorrectionInput,
  type UsageCorrectionLedgerPort,
  UsageCorrectionService,
} from '../../../src/saas/metering/usage-correction.js';

type Row = Record<string, unknown>;

const tenantId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const usageEventId = '33333333-3333-4333-8333-333333333333';
const settlementId = '44444444-4444-4444-8444-444444444444';
const operator = '55555555-5555-4555-8555-555555555555';

function result<RowType>(rows: RowType[] = []): SqlResult<RowType> {
  return { rows, rowCount: rows.length };
}

interface FakeState {
  usageEvents: Row[];
  settlements: Row[];
  requests: Row[];
  corrections: Row[];
  auditEvents: Row[];
}

class MemoryCorrectionDatabase {
  readonly state: FakeState;

  constructor(overrides: Partial<FakeState> = {}) {
    this.state = {
      usageEvents: [
        {
          id: usageEventId,
          tenant_id: tenantId,
          request_id: requestId,
          supply_mode: 'platform',
        },
      ],
      settlements: [],
      requests: [{ id: requestId, tenant_id: tenantId, reconciliation_state: 'none' }],
      corrections: [],
      auditEvents: [],
      ...overrides,
    };
  }

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    return this.execute<RowType>(sql, values);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const before = structuredClone(this.state);
    try {
      return await work({ query: (sql, values = []) => this.execute(sql, values) });
    } catch (error) {
      Object.assign(this.state, before);
      throw error;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private execute<RowType>(sql: string, values: readonly unknown[]): Promise<SqlResult<RowType>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c] = values;

    if (statement.startsWith('select pg_advisory_xact_lock')) return Promise.resolve(result<RowType>());

    if (statement.startsWith('select e.id, e.tenant_id, e.request_id, e.supply_mode from saas_usage_events')) {
      const event = this.state.usageEvents.find((row) => row.tenant_id === a && row.id === b);
      return Promise.resolve(result<RowType>(event ? [event as RowType] : []));
    }

    if (statement.startsWith('select id from saas_usage_settlements')) {
      const rows = this.state.settlements.filter((row) => row.tenant_id === a && row.usage_event_id === b);
      return Promise.resolve(result<RowType>(rows.slice(0, 2).map((row) => ({ id: row.id }) as RowType)));
    }

    if (statement.startsWith('select reconciliation_state from saas_requests')) {
      const request = this.state.requests.find((row) => row.tenant_id === a && row.id === b);
      return Promise.resolve(
        result<RowType>(request ? [{ reconciliation_state: request.reconciliation_state } as RowType] : []),
      );
    }

    if (statement.startsWith('insert into saas_usage_correction_events')) {
      const digest = values[10];
      if (this.state.corrections.some((row) => row.correction_digest === digest)) {
        return Promise.resolve(result<RowType>());
      }
      const [
        id,
        tenant,
        correctedUsageEvent,
        correctedSettlement,
        reasonCode,
        correctionUsage,
        amountDelta,
        currencyValue,
        operatorIdentity,
        evidenceRef,
        correctionDigest,
        createdAt,
      ] = values;
      const row: Row = {
        id,
        tenant_id: tenant,
        corrected_usage_event_id: correctedUsageEvent,
        corrected_settlement_id: correctedSettlement,
        reason_code: reasonCode,
        correction_usage: JSON.parse(String(correctionUsage)),
        amount_delta_minor_units: amountDelta,
        currency: currencyValue,
        operator_identity: operatorIdentity,
        evidence_ref: evidenceRef,
        correction_digest: correctionDigest,
        created_at: createdAt,
      };
      this.state.corrections.push(row);
      return Promise.resolve(result<RowType>([structuredClone(row) as RowType]));
    }

    if (
      statement.startsWith('select id, tenant_id, corrected_usage_event_id') &&
      statement.includes('correction_digest = $1')
    ) {
      const row = this.state.corrections.find((entry) => entry.correction_digest === a);
      return Promise.resolve(result<RowType>(row ? [structuredClone(row) as RowType] : []));
    }

    if (
      statement.startsWith('select id, tenant_id, corrected_usage_event_id') &&
      statement.includes('corrected_usage_event_id = $2')
    ) {
      const rows = this.state.corrections
        .filter((entry) => entry.tenant_id === a && entry.corrected_usage_event_id === b)
        .slice(0, Number(c));
      return Promise.resolve(result<RowType>(rows.map((row) => structuredClone(row) as RowType)));
    }

    if (statement.startsWith('select id, tenant_id, corrected_usage_event_id')) {
      const rows = this.state.corrections.filter((entry) => entry.tenant_id === a).slice(0, Number(b));
      return Promise.resolve(result<RowType>(rows.map((row) => structuredClone(row) as RowType)));
    }

    if (statement.startsWith('insert into saas_audit_events')) {
      if (
        !statement.includes("'usage_correction_recorded'") ||
        !statement.includes("'saas_usage_correction_event'") ||
        !statement.includes("'platform_metering'")
      ) {
        throw new Error(`Unexpected audit statement: ${statement}`);
      }
      const [id, tenant, actor, targetId, occurredAt] = values;
      this.state.auditEvents.push({
        id,
        tenant_id: tenant,
        actor_user_id: actor,
        action: 'usage_correction_recorded',
        target_type: 'saas_usage_correction_event',
        target_id: targetId,
        occurred_at: occurredAt,
        entry_point: 'platform_metering',
      });
      return Promise.resolve(result<RowType>());
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

function recordingLedger(recorded: Array<{ delta: bigint; digest: string }>): UsageCorrectionLedgerPort {
  return {
    postUsageCorrection: (_executor, input) => {
      recorded.push({ delta: input.amountDeltaMinorUnits, digest: input.correctionDigest });
      return Promise.resolve({ transactionId: `ledger-${recorded.length}`, replayed: false });
    },
  };
}

function createService(database: MemoryCorrectionDatabase, ledger?: UsageCorrectionLedgerPort): UsageCorrectionService {
  let nextId = 0;
  return new UsageCorrectionService(database as never, {
    now: () => new Date('2026-10-10T00:00:00.000Z'),
    idFactory: () => `correction-${++nextId}`,
    ...(ledger === undefined ? {} : { ledger }),
  });
}

function correctionInput(overrides: Partial<RecordUsageCorrectionInput> = {}): RecordUsageCorrectionInput {
  return {
    tenantId,
    usageEventId,
    settlementId,
    reasonCode: 'provider_reported_correction',
    correctionUsage: {
      inputTotal: '900',
      inputUncached: '900',
      cacheRead: '0',
      cacheWrite: '0',
      cacheWrite5m: '0',
      cacheWrite1h: '0',
      outputTotal: '80',
      reasoningOutput: '0',
      status: 'reported',
      source: 'upstream',
      semanticsVersion: 'v1',
      measurementKind: 'snapshot',
      billableBasis: 'exact',
    },
    amountDeltaMinorUnits: '25',
    currency: 'USD',
    operatorIdentity: operator,
    ...overrides,
  };
}

const withSettlement: Partial<FakeState> = {
  settlements: [{ id: settlementId, tenant_id: tenantId, usage_event_id: usageEventId }],
};

test('platform correction records the event and posts the wallet reversal atomically', async () => {
  const database = new MemoryCorrectionDatabase(withSettlement);
  const posted: Array<{ delta: bigint; digest: string }> = [];
  const service = createService(database, recordingLedger(posted));

  const result = await service.recordUsageCorrection(correctionInput());

  assert.equal(result.replayed, false);
  assert.equal(result.ledgerTransactionId, 'ledger-1');
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.delta, 25n);
  assert.equal(result.correction.id, 'correction-1');
  assert.equal(result.correction.correctedUsageEventId, usageEventId);
  assert.equal(result.correction.correctedSettlementId, settlementId);
  assert.equal(result.correction.amountDeltaMinorUnits, '25');
  assert.equal(result.correction.operatorIdentity, operator);
  assert.match(result.correction.correctionDigest, /^[0-9a-f]{64}$/);
  assert.equal(posted[0]?.digest, result.correction.correctionDigest);
  assert.equal(database.state.auditEvents.length, 1);
  assert.equal(database.state.auditEvents[0]?.actor_user_id, operator);
  assert.equal(database.state.auditEvents[0]?.target_id, result.correction.id);
  assert.equal(database.state.auditEvents[0]?.tenant_id, tenantId);
});

test('resubmitting the identical correction replays without a second ledger post', async () => {
  const database = new MemoryCorrectionDatabase(withSettlement);
  const posted: Array<{ delta: bigint; digest: string }> = [];
  const service = createService(database, recordingLedger(posted));

  const first = await service.recordUsageCorrection(correctionInput());
  const second = await service.recordUsageCorrection(correctionInput());

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.ledgerTransactionId, null);
  assert.equal(second.correction.id, first.correction.id);
  assert.equal(second.correction.correctionDigest, first.correction.correctionDigest);
  assert.equal(posted.length, 1);
  assert.equal(database.state.corrections.length, 1);
  assert.equal(database.state.auditEvents.length, 1, 'replay must not append a second audit event');
});

test('BYOK corrections are event-only and reject any wallet delta', async () => {
  const database = new MemoryCorrectionDatabase({
    usageEvents: [{ id: usageEventId, tenant_id: tenantId, request_id: requestId, supply_mode: 'byok' }],
  });
  const posted: Array<{ delta: bigint; digest: string }> = [];
  const service = createService(database, recordingLedger(posted));

  await assert.rejects(service.recordUsageCorrection(correctionInput({ settlementId: null })), {
    code: 'METERING_INVALID_INPUT',
  });

  const result = await service.recordUsageCorrection(correctionInput({ settlementId: null, amountDeltaMinorUnits: 0 }));
  assert.equal(result.replayed, false);
  assert.equal(result.ledgerTransactionId, null);
  assert.equal(posted.length, 0);
  assert.equal(result.correction.amountDeltaMinorUnits, '0');
});

test('a settled usage event requires the explicit settlement binding', async () => {
  const database = new MemoryCorrectionDatabase(withSettlement);
  const service = createService(database, recordingLedger([]));

  await assert.rejects(service.recordUsageCorrection(correctionInput({ settlementId: null })), {
    code: 'METERING_INVALID_INPUT',
  });
  await assert.rejects(service.recordUsageCorrection(correctionInput({ settlementId: 'wrong-settlement' })), {
    code: 'USAGE_SETTLEMENT_CONFLICT',
  });
});

test('a request under reconciliation refuses corrections', async () => {
  const database = new MemoryCorrectionDatabase({
    ...withSettlement,
    requests: [{ id: requestId, tenant_id: tenantId, reconciliation_state: 'pending' }],
  });
  const service = createService(database, recordingLedger([]));

  await assert.rejects(service.recordUsageCorrection(correctionInput()), {
    code: 'USAGE_CORRECTION_STATE_CONFLICT',
  });
  assert.equal(database.state.corrections.length, 0);
});

test('an unknown usage event fails with USAGE_EVENT_NOT_FOUND', async () => {
  const database = new MemoryCorrectionDatabase({ usageEvents: [] });
  const service = createService(database, recordingLedger([]));

  await assert.rejects(service.recordUsageCorrection(correctionInput()), { code: 'USAGE_EVENT_NOT_FOUND' });
});

test('a platform correction without a configured ledger fails closed', async () => {
  const database = new MemoryCorrectionDatabase(withSettlement);
  const service = createService(database);

  await assert.rejects(service.recordUsageCorrection(correctionInput()), { code: 'METERING_STORAGE_ERROR' });
  assert.equal(database.state.corrections.length, 0);
  assert.equal(database.state.auditEvents.length, 0);
});

test('a non-uuid operator identity cannot satisfy the audit actor FK', async () => {
  const database = new MemoryCorrectionDatabase(withSettlement);
  const service = createService(database, recordingLedger([]));

  await assert.rejects(service.recordUsageCorrection(correctionInput({ operatorIdentity: 'operator-1' })), {
    code: 'METERING_INVALID_INPUT',
  });
  assert.equal(database.state.corrections.length, 0);
});

test('listUsageCorrections filters by tenant and optional usage event', async () => {
  const database = new MemoryCorrectionDatabase(withSettlement);
  const service = createService(database, recordingLedger([]));
  await service.recordUsageCorrection(correctionInput());

  const all = await service.listUsageCorrections({ tenantId });
  assert.equal(all.length, 1);
  const byEvent = await service.listUsageCorrections({ tenantId, usageEventId });
  assert.equal(byEvent.length, 1);
  const none = await service.listUsageCorrections({ tenantId, usageEventId: '99999999-9999-4999-8999-999999999999' });
  assert.equal(none.length, 0);
  await assert.rejects(service.listUsageCorrections({ tenantId, limit: 0 }), { code: 'METERING_INVALID_INPUT' });
});

test('usageCorrectionDigest covers every correcting field', () => {
  const base = {
    tenantId,
    correctedUsageEventId: usageEventId,
    correctedSettlementId: settlementId,
    reasonCode: 'metering_fault',
    correctionUsage: correctionInput().correctionUsage as never,
    amountDeltaMinorUnits: '25',
    currency: 'USD',
    operatorIdentity: operator,
    evidenceRef: null,
  };
  const digest = usageCorrectionDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(usageCorrectionDigest(base), digest);
  for (const mutation of [
    { tenantId: 'other' },
    { correctedSettlementId: null },
    { reasonCode: 'operator_adjustment' },
    { amountDeltaMinorUnits: '-25' },
    { currency: 'EUR' },
    { operatorIdentity: 'someone-else' },
    { evidenceRef: 'a'.repeat(64) },
  ]) {
    assert.notEqual(usageCorrectionDigest({ ...base, ...mutation }), digest);
  }
  const usageMutation = usageCorrectionDigest({
    ...base,
    correctionUsage: { ...correctionInput().correctionUsage, outputTotal: '81' } as never,
  });
  assert.notEqual(usageMutation, digest);
});
