import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  createPostgresKeyBudgetAdmission,
  KeyBudgetAdmissionDeniedError,
} from '../../../src/saas/gateway/postgres-preparation-budget.js';
import {
  applyKeyBudgetCorrection,
  KEY_BUDGET_LIFETIME_DAY,
  KEY_BUDGET_TOKEN_SEMANTICS_VERSION,
  KeyBudgetStoreError,
  keyBudgetDayColumn,
  keyBudgetTokenUnitsFromBounds,
  keyBudgetTokenUnitsFromUsage,
  keyBudgetUtcDayFrom,
  parseKeyBudgetAmount,
  releaseKeyBudgetReservation,
  reserveKeyBudgetCounters,
  selectKeyBudgetCounters,
  selectKeyBudgetPolicyHead,
  selectKeyBudgetReservation,
  settleKeyBudgetReservation,
} from '../../../src/saas/keys/budget-store.js';

interface StoredPolicy {
  tenant_id: string;
  project_id: string;
  key_id: string;
  lineage_id: string;
  version: string;
  token_daily: string | null;
  token_lifetime: string | null;
  charge_daily: string | null;
  charge_lifetime: string | null;
}

interface StoredCounter {
  tenant_id: string;
  project_id: string;
  lineage_id: string;
  window_kind: 'daily' | 'lifetime';
  day: string;
  token_settled: string;
  token_outstanding_reserved: string;
  charge_settled: string;
  charge_outstanding_reserved: string;
  charge_currency: string | null;
}

interface StoredReservation {
  tenant_id: string;
  project_id: string;
  lineage_id: string;
  request_id: string;
  day: string;
  token_units: string;
  charge_minor_units: string;
  charge_currency: string | null;
  state: 'outstanding' | 'settled' | 'released';
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function result<Row>(rows: Row[] = [], rowCount = rows.length): SqlResult<Row> {
  return { rows: structuredClone(rows), rowCount };
}

/** Stateful in-memory mirror of the 081 tables with upsert/guard semantics. */
class FakeBudgetDatabase implements SqlExecutor {
  readonly policies: StoredPolicy[] = [];
  readonly counters: StoredCounter[] = [];
  readonly reservations: StoredReservation[] = [];
  readonly statements: string[] = [];

  seedPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
    const row: StoredPolicy = {
      tenant_id: 'tenant-1',
      project_id: 'project-1',
      key_id: 'key-1',
      lineage_id: 'key-1',
      version: '1',
      token_daily: null,
      token_lifetime: null,
      charge_daily: null,
      charge_lifetime: null,
      ...overrides,
    };
    this.policies.push(row);
    return row;
  }

  counter(lineageId: string, windowKind: 'daily' | 'lifetime', day: string): StoredCounter | undefined {
    return this.counters.find(
      (candidate) =>
        candidate.lineage_id === lineageId && candidate.window_kind === windowKind && candidate.day === day,
    );
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push(sql);
    return this.execute<Row>(sql, values);
  }

  private async execute<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalized(sql);
    const [a, b, c, d, e, f, g, h] = values;

    if (statement.startsWith('with reserved_daily as (')) {
      const daily = await this.execute<StoredCounter>('INSERT INTO saas_api_key_budget_counters', [
        a,
        b,
        c,
        'daily',
        e,
        f,
        g,
        h,
      ]);
      const lifetime = await this.execute<StoredCounter>('INSERT INTO saas_api_key_budget_counters', [
        a,
        b,
        c,
        'lifetime',
        values[8],
        f,
        g,
        h,
      ]);
      const storedCurrency = lifetime.rows[0]?.charge_currency;
      const inserted =
        h === null || storedCurrency === null || storedCurrency === h
          ? (await this.execute('INSERT INTO saas_api_key_budget_reservations', values)).rowCount
          : 0;
      return result<Row>(
        [...daily.rows, ...lifetime.rows].map((row) => ({ ...row, reservation_count: inserted }) as Row),
      );
    }

    if (statement.startsWith('with adjusted_daily as (')) {
      const daily = await this.execute('UPDATE saas_api_key_budget_counters', [a, b, 'daily', c, d, e, f, g]);
      const lifetime =
        daily.rowCount === 1
          ? await this.execute('UPDATE saas_api_key_budget_counters', [a, b, 'lifetime', h, d, e, f, g])
          : result([], 0);
      const hasResolution = statement.includes('resolved_request as (');
      const resolved =
        lifetime.rowCount === 1 && hasResolution
          ? await this.execute(
              `UPDATE saas_api_key_budget_reservations SET state = '${statement.includes("state = 'settled'") ? 'settled' : 'released'}'`,
              [a, values[8]],
            )
          : result([], 0);
      return result<Row>([
        { daily_count: daily.rowCount, lifetime_count: lifetime.rowCount, reservation_count: resolved.rowCount } as Row,
      ]);
    }

    if (statement.startsWith('select tenant_id, project_id, key_id, lineage_id, version,')) {
      const row = this.policies.find(
        (candidate) =>
          candidate.tenant_id === String(a) && candidate.project_id === String(b) && candidate.key_id === String(c),
      );
      return result<Row>(row ? [structuredClone(row) as Row] : []);
    }

    if (statement.startsWith('select window_kind, token_settled,')) {
      return result<Row>(
        this.counters
          .filter(
            (candidate) =>
              candidate.tenant_id === String(a) &&
              candidate.lineage_id === String(b) &&
              ((candidate.window_kind === 'daily' && candidate.day === String(c)) ||
                (candidate.window_kind === 'lifetime' && candidate.day === KEY_BUDGET_LIFETIME_DAY)),
          )
          .map((candidate) => structuredClone(candidate) as Row),
      );
    }

    if (statement.startsWith('insert into saas_api_key_budget_counters')) {
      const existing = this.counter(String(c), String(d) as 'daily' | 'lifetime', String(e));
      if (existing) {
        existing.token_outstanding_reserved = (
          BigInt(existing.token_outstanding_reserved) + BigInt(String(f))
        ).toString(10);
        existing.charge_outstanding_reserved = (
          BigInt(existing.charge_outstanding_reserved) + BigInt(String(g))
        ).toString(10);
        existing.charge_currency = existing.charge_currency ?? (h === null || h === undefined ? null : String(h));
        return result<Row>([structuredClone(existing) as Row]);
      }
      const row: StoredCounter = {
        tenant_id: String(a),
        project_id: String(b),
        lineage_id: String(c),
        window_kind: String(d) as 'daily' | 'lifetime',
        day: String(e),
        token_settled: '0',
        token_outstanding_reserved: String(f),
        charge_settled: '0',
        charge_outstanding_reserved: String(g),
        charge_currency: h === null || h === undefined ? null : String(h),
      };
      this.counters.push(row);
      return result<Row>([structuredClone(row) as Row]);
    }

    if (statement.startsWith('insert into saas_api_key_budget_reservations')) {
      const row: StoredReservation = {
        tenant_id: String(a),
        project_id: String(b),
        lineage_id: String(c),
        request_id: String(d),
        day: String(e),
        token_units: String(f),
        charge_minor_units: String(g),
        charge_currency: h === null || h === undefined ? null : String(h),
        state: 'outstanding',
      };
      if (this.reservations.some((candidate) => candidate.request_id === row.request_id)) {
        throw new Error('duplicate key budget reservation');
      }
      this.reservations.push(row);
      return result<Row>([], 1);
    }

    if (statement.startsWith('select tenant_id, project_id, lineage_id, request_id, day::text as day,')) {
      const row = this.reservations.find(
        (candidate) => candidate.tenant_id === String(a) && candidate.request_id === String(b),
      );
      return result<Row>(row ? [structuredClone(row) as Row] : []);
    }

    if (statement.startsWith('update saas_api_key_budget_counters')) {
      const [tenantId, lineageId, windowKind, day, tokenSettled, chargeSettled, tokenOutstanding, chargeOutstanding] =
        values.map(String);
      const row = this.counter(lineageId, windowKind as 'daily' | 'lifetime', day);
      if (
        !row ||
        row.tenant_id !== tenantId ||
        BigInt(row.token_outstanding_reserved) < BigInt(tokenOutstanding) ||
        BigInt(row.charge_outstanding_reserved) < BigInt(chargeOutstanding)
      ) {
        return result<Row>([], 0);
      }
      row.token_outstanding_reserved = (BigInt(row.token_outstanding_reserved) - BigInt(tokenOutstanding)).toString(10);
      row.charge_outstanding_reserved = (BigInt(row.charge_outstanding_reserved) - BigInt(chargeOutstanding)).toString(
        10,
      );
      row.token_settled = (BigInt(row.token_settled) + BigInt(tokenSettled)).toString(10);
      row.charge_settled = (BigInt(row.charge_settled) + BigInt(chargeSettled)).toString(10);
      return result<Row>([], 1);
    }

    if (statement.startsWith('update saas_api_key_budget_reservations')) {
      const row = this.reservations.find(
        (candidate) =>
          candidate.tenant_id === String(a) && candidate.request_id === String(b) && candidate.state === 'outstanding',
      );
      if (!row) return result<Row>([], 0);
      row.state = statement.includes("state = 'settled'") ? 'settled' : 'released';
      return result<Row>([], 1);
    }

    throw new Error(`Unimplemented fake budget SQL: ${statement}`);
  }
}

const NOW = new Date('2026-10-09T12:00:00.000Z');
const DAY = { timezone: 'UTC', startInclusive: '2026-10-09T00:00:00.000Z', endExclusive: '2026-10-10T00:00:00.000Z' };

async function expectStoreError(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof KeyBudgetStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

test('parseKeyBudgetAmount accepts canonical bigint text and rejects every other shape', () => {
  assert.equal(parseKeyBudgetAmount('0'), '0');
  assert.equal(parseKeyBudgetAmount('123'), '123');
  assert.equal(parseKeyBudgetAmount(7), '7');
  assert.equal(parseKeyBudgetAmount(9n), '9');
  for (const value of ['', '01', '-1', '1.5', 'abc', null, undefined, 1.5, -3, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => parseKeyBudgetAmount(value),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
    );
  }
});

test('keyBudgetUtcDayFrom selects the half-open UTC calendar day from the injected clock', () => {
  assert.deepEqual(keyBudgetUtcDayFrom(NOW), DAY);
  assert.deepEqual(keyBudgetUtcDayFrom(new Date('2026-02-28T23:59:59.999Z')), {
    timezone: 'UTC',
    startInclusive: '2026-02-28T00:00:00.000Z',
    endExclusive: '2026-03-01T00:00:00.000Z',
  });
  assert.equal(keyBudgetDayColumn(DAY), '2026-10-09');
  assert.throws(
    () => keyBudgetUtcDayFrom(new Date(Number.NaN)),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  );
});

test('token units sum input and output for bounds and exact usage', () => {
  assert.equal(keyBudgetTokenUnitsFromBounds({ inputTotalUpperBound: '10', outputTotalUpperBound: '5' }), '15');
  assert.equal(keyBudgetTokenUnitsFromUsage({ inputTotal: 3, outputTotal: '4' }), '7');
  assert.equal(KEY_BUDGET_TOKEN_SEMANTICS_VERSION, 'token-units-v1');
  // §4.1: media envelopes/reports may omit token counters entirely; the
  // missing bounds count zero tokens (media units never enter TPM/KEY-BUD
  // token windows — the charge windows carry the media cost).
  assert.equal(keyBudgetTokenUnitsFromBounds({ perUnitUnitsUpperBound: '4' }), '0');
  assert.equal(keyBudgetTokenUnitsFromUsage({ billingMode: 'image', units: '4' }), '0');
  for (const value of [null, {}, { inputTotalUpperBound: '1' }, 'x', { inputTotal: '-1', outputTotal: '0' }]) {
    assert.throws(
      () =>
        'inputTotalUpperBound' in Object(value) || !('inputTotal' in Object(value))
          ? keyBudgetTokenUnitsFromBounds(value)
          : keyBudgetTokenUnitsFromUsage(value),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
    );
  }
});

test('reserveKeyBudgetCounters upserts both windows, inserts the reservation and fails on currency mismatch', async () => {
  const database = new FakeBudgetDatabase();
  const reserved = await reserveKeyBudgetCounters(database, {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    lineageId: 'lineage-1',
    requestId: 'request-1',
    day: DAY,
    tokenUnits: '15',
    chargeMinorUnits: '25',
    chargeCurrency: 'USD',
  });
  assert.deepEqual(reserved.daily, {
    settled: '0',
    outstandingReserved: '15',
    newReservation: '15',
    charge: { settled: '0', outstandingReserved: '25', newReservation: '25' },
  });
  assert.equal(reserved.chargeCurrency, 'USD');
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_outstanding_reserved, '15');
  assert.equal(database.counter('lineage-1', 'lifetime', KEY_BUDGET_LIFETIME_DAY)?.charge_outstanding_reserved, '25');
  assert.equal(database.reservations.length, 1);

  // A second reservation accumulates outstanding on the same windows.
  const second = await reserveKeyBudgetCounters(database, {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    lineageId: 'lineage-1',
    requestId: 'request-2',
    day: DAY,
    tokenUnits: '5',
    chargeMinorUnits: '0',
    chargeCurrency: null,
  });
  assert.equal(second.daily.outstandingReserved, '20');
  assert.equal(second.lifetime.charge.outstandingReserved, '25');

  await expectStoreError(
    () =>
      reserveKeyBudgetCounters(database, {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        lineageId: 'lineage-1',
        requestId: 'request-3',
        day: DAY,
        tokenUnits: '1',
        chargeMinorUnits: '1',
        chargeCurrency: 'EUR',
      }),
    'CURRENCY_MISMATCH',
  );
});

test('settle moves reserved to settled with actual amounts exactly once; release drops them', async () => {
  const database = new FakeBudgetDatabase();
  const facts = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    lineageId: 'lineage-1',
    day: DAY,
    chargeCurrency: null,
  };
  // Pre-seed settled usage so the windows pre-exist.
  const seeded = database.counters;
  seeded.push(
    {
      tenant_id: 'tenant-1',
      project_id: 'project-1',
      lineage_id: 'lineage-1',
      window_kind: 'daily',
      day: '2026-10-09',
      token_settled: '100',
      token_outstanding_reserved: '0',
      charge_settled: '0',
      charge_outstanding_reserved: '0',
      charge_currency: null,
    },
    {
      tenant_id: 'tenant-1',
      project_id: 'project-1',
      lineage_id: 'lineage-1',
      window_kind: 'lifetime',
      day: KEY_BUDGET_LIFETIME_DAY,
      token_settled: '900',
      token_outstanding_reserved: '0',
      charge_settled: '0',
      charge_outstanding_reserved: '0',
      charge_currency: null,
    },
  );
  await reserveKeyBudgetCounters(database, {
    ...facts,
    requestId: 'request-1',
    tokenUnits: '50',
    chargeMinorUnits: '0',
  });
  await reserveKeyBudgetCounters(database, {
    ...facts,
    requestId: 'request-2',
    tokenUnits: '30',
    chargeMinorUnits: '0',
  });

  // Settle with actuals LOWER than the conservative reservation.
  assert.equal(await settleKeyBudgetReservation(database, 'tenant-1', 'request-1', '40', '0'), true);
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_settled, '140');
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_outstanding_reserved, '30');
  assert.equal(database.counter('lineage-1', 'lifetime', KEY_BUDGET_LIFETIME_DAY)?.token_settled, '940');
  // Replay is a no-op; unknown requests are pre-081 drift.
  assert.equal(await settleKeyBudgetReservation(database, 'tenant-1', 'request-1', '40', '0'), false);
  assert.equal(await settleKeyBudgetReservation(database, 'tenant-1', 'request-9', '1', '0'), false);
  assert.equal(database.reservations.find((row) => row.request_id === 'request-1')?.state, 'settled');

  // Release the second reservation without recording usage.
  assert.equal(await releaseKeyBudgetReservation(database, 'tenant-1', 'request-2'), true);
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_outstanding_reserved, '0');
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_settled, '140');
  assert.equal(await releaseKeyBudgetReservation(database, 'tenant-1', 'request-2'), false);
  assert.equal(database.reservations.find((row) => row.request_id === 'request-2')?.state, 'released');
});

test('corrections adjust settled counters of the original day and require a settled reservation', async () => {
  const database = new FakeBudgetDatabase();
  await reserveKeyBudgetCounters(database, {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    lineageId: 'lineage-1',
    requestId: 'request-1',
    day: DAY,
    tokenUnits: '50',
    chargeMinorUnits: '0',
    chargeCurrency: null,
  });
  // Outstanding reservations cannot be corrected.
  await expectStoreError(
    () => applyKeyBudgetCorrection(database, 'tenant-1', 'request-1', '5', '0'),
    'RESERVATION_STATE_CONFLICT',
  );
  await settleKeyBudgetReservation(database, 'tenant-1', 'request-1', '50', '0');
  assert.equal(await applyKeyBudgetCorrection(database, 'tenant-1', 'request-1', '7', '0'), true);
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_settled, '57');
  assert.equal(database.counter('lineage-1', 'lifetime', KEY_BUDGET_LIFETIME_DAY)?.token_settled, '57');
  // Outstanding is untouched by settled corrections; drift returns false.
  assert.equal(database.counter('lineage-1', 'daily', '2026-10-09')?.token_outstanding_reserved, '0');
  assert.equal(await applyKeyBudgetCorrection(database, 'tenant-1', 'request-9', '1', '0'), false);
});

test('selectKeyBudgetPolicyHead and selectKeyBudgetCounters normalize rows and tolerate drift', async () => {
  const database = new FakeBudgetDatabase();
  assert.equal(await selectKeyBudgetPolicyHead(database, 'tenant-1', 'project-1', 'key-1'), null);
  database.seedPolicy({ token_daily: '100' });
  const head = await selectKeyBudgetPolicyHead(database, 'tenant-1', 'project-1', 'key-1', 'UPDATE');
  assert.deepEqual(head, {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    lineageId: 'key-1',
    version: '1',
    tokenDaily: '100',
    tokenLifetime: null,
    chargeDaily: null,
    chargeLifetime: null,
    charge5h: null,
    charge7d: null,
  });
  assert.ok(normalized(database.statements.at(-1) ?? '').endsWith('for update'));
  const counters = await selectKeyBudgetCounters(database, 'tenant-1', 'key-1', DAY);
  assert.deepEqual(counters, {
    daily: {
      tokenSettled: '0',
      tokenOutstandingReserved: '0',
      chargeSettled: '0',
      chargeOutstandingReserved: '0',
      chargeCurrency: null,
    },
    lifetime: {
      tokenSettled: '0',
      tokenOutstandingReserved: '0',
      chargeSettled: '0',
      chargeOutstandingReserved: '0',
      chargeCurrency: null,
    },
  });
  assert.equal(await selectKeyBudgetReservation(database, 'tenant-1', 'request-9'), null);
});

test('admission reserves budget for byok and denies once a finite daily token cap is projected', async () => {
  const database = new FakeBudgetDatabase();
  database.seedPolicy({ token_daily: '20', token_lifetime: '100' });
  const admission = createPostgresKeyBudgetAdmission({ now: () => NOW });
  const bounds = { inputTotalUpperBound: '10', outputTotalUpperBound: '5' };
  const facts = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    supplyMode: 'byok' as const,
    payloadBounds: bounds,
    charge: null,
  };
  await admission.reserve(database, { ...facts, requestId: 'request-1' });
  assert.equal(database.counter('key-1', 'daily', '2026-10-09')?.token_outstanding_reserved, '15');
  assert.equal(database.counter('key-1', 'lifetime', KEY_BUDGET_LIFETIME_DAY)?.token_outstanding_reserved, '15');

  // 15 outstanding + 15 new = 30 > daily cap 20 -> denied with the exact dimension.
  await assert.rejects(
    () => admission.reserve(database, { ...facts, requestId: 'request-2' }),
    (error: unknown) => {
      assert.ok(error instanceof KeyBudgetAdmissionDeniedError);
      assert.equal(error.code, 'KEY_BUDGET_EXCEEDED');
      assert.equal(error.deniedDimension, 'daily_tokens');
      return true;
    },
  );
});

test('admission denies platform lifetime charge caps and fails closed on missing linkage', async () => {
  const database = new FakeBudgetDatabase();
  database.seedPolicy({ charge_lifetime: '40' });
  const admission = createPostgresKeyBudgetAdmission({ now: () => NOW });
  const facts = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    keyId: 'key-1',
    supplyMode: 'platform' as const,
    payloadBounds: { inputTotalUpperBound: '1', outputTotalUpperBound: '1' },
    charge: { currency: 'USD', amountMinorUnits: '25' },
  };
  await admission.reserve(database, { ...facts, requestId: 'request-1' });
  await assert.rejects(
    () => admission.reserve(database, { ...facts, requestId: 'request-2' }),
    (error: unknown) =>
      error instanceof KeyBudgetAdmissionDeniedError && error.deniedDimension === 'lifetime_customer_charge',
  );

  // Missing policy head: fail closed with a storage-shaped error, never admit.
  const drift = new FakeBudgetDatabase();
  await expectStoreError(() => admission.reserve(drift, { ...facts, requestId: 'request-3' }), 'STORAGE_ERROR');
  // BYOK must never carry charge facts.
  const byok = new FakeBudgetDatabase();
  byok.seedPolicy();
  await expectStoreError(
    () =>
      admission.reserve(byok, {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        keyId: 'key-1',
        requestId: 'request-4',
        supplyMode: 'byok',
        payloadBounds: { inputTotalUpperBound: '1', outputTotalUpperBound: '1' },
        charge: { currency: 'USD', amountMinorUnits: '1' },
      }),
    'STORAGE_ERROR',
  );
});

test('admission fails closed when configured charge caps have no resolvable currency', async () => {
  const database = new FakeBudgetDatabase();
  // Charge caps configured but the request carries no hold and no counter-stamped currency.
  database.seedPolicy({ charge_daily: '10' });
  const admission = createPostgresKeyBudgetAdmission({ now: () => NOW });
  await expectStoreError(
    () =>
      admission.reserve(database, {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        keyId: 'key-1',
        requestId: 'request-1',
        supplyMode: 'platform',
        payloadBounds: { inputTotalUpperBound: '1', outputTotalUpperBound: '1' },
        charge: null,
      }),
    'STORAGE_ERROR',
  );
});

test('budget mutations batch dependent windows without weakening exact counts or error priority', async () => {
  const database = new FakeBudgetDatabase();
  const facts = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    lineageId: 'lineage-1',
    requestId: 'request-1',
    day: DAY,
    tokenUnits: '9007199254740993',
    chargeMinorUnits: '1',
    chargeCurrency: 'USD',
  };
  await reserveKeyBudgetCounters(database, facts);
  assert.equal(database.statements.length, 1, 'one reserve statement, not a latency assertion');
  const sql = database.statements[0] ?? '';
  assert.match(sql, /FROM reserved_daily\s+ON CONFLICT/);
  assert.match(sql, /FROM reserved_lifetime\s+WHERE \$8::text IS NULL/);
  assert.equal(database.counters[0]?.token_outstanding_reserved, facts.tokenUnits);
  const { preservesPreparationTransactionFacts } = await import(
    '../../../src/saas/gateway/preparation-fact-preserving-statements.js'
  );
  assert.equal(preservesPreparationTransactionFacts(sql), true);
  assert.equal(preservesPreparationTransactionFacts(`${sql} `), false, 'allowlist remains exact');
  await expectStoreError(
    () => reserveKeyBudgetCounters(database, { ...facts, chargeCurrency: 'EUR' }),
    'CURRENCY_MISMATCH',
  );
  assert.equal(database.reservations.length, 1, 'currency mismatch does not reach duplicate reservation insert');
  database.statements.length = 0;
  await settleKeyBudgetReservation(database, facts.tenantId, facts.requestId, '9007199254740992', '1');
  assert.equal(database.statements.length, 2, 'fresh reservation lock then one dependent mutation');
  assert.match(database.statements[0] ?? '', /FOR UPDATE$/);
  assert.match(
    database.statements[1] ?? '',
    /FROM adjusted_daily\s+WHERE counter.tenant_id = adjusted_daily.tenant_id/,
  );
  assert.match(
    database.statements[1] ?? '',
    /FROM adjusted_lifetime\s+WHERE reservation.tenant_id = adjusted_lifetime.tenant_id/,
  );
});

test('batched counter and terminal count anomalies retain fail-closed error codes', async () => {
  for (const counts of [
    { daily_count: 0, lifetime_count: 0, reservation_count: 0 },
    { daily_count: 1, lifetime_count: 0, reservation_count: 0 },
    { daily_count: 2, lifetime_count: 1, reservation_count: 1 },
    { daily_count: 1, lifetime_count: 1, reservation_count: 0 },
    { daily_count: 1, lifetime_count: 1, reservation_count: 2 },
  ]) {
    const executor: SqlExecutor = {
      async query<Row>(sql: string) {
        if (sql.startsWith('SELECT tenant_id'))
          return result<Row>([
            {
              tenant_id: 'tenant-1',
              project_id: 'project-1',
              lineage_id: 'lineage-1',
              request_id: 'request-1',
              day: '2026-10-09',
              token_units: '1',
              charge_minor_units: '0',
              charge_currency: null,
              state: 'outstanding',
            } as Row,
          ]);
        return result<Row>([counts as Row]);
      },
    };
    await expectStoreError(
      () => settleKeyBudgetReservation(executor, 'tenant-1', 'request-1', '1', '0'),
      counts.daily_count !== 1 || counts.lifetime_count !== 1 ? 'STORAGE_ERROR' : 'RESERVATION_STATE_CONFLICT',
    );
  }
});
