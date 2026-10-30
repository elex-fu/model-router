import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import { type FastReserveResult, PostgresFastGatewayJournal } from '../../../../src/saas/gateway/fast/journal.js';
import { intentFixture } from './journal-fixture.js';

/*
 * Group-commit reserve (T8) unit coverage with a scripted database. The real
 * money/SQL invariants live in journal.postgres.integration.test.ts; here the
 * fake proves statement aggregation, grouping, window/immediate flush,
 * per-request isolation on batch failure, backpressure, deadline and close
 * semantics without a PostgreSQL server.
 *
 * Mock-timer note: reserveIntent() suspends at `await this.ready`, so the
 * batcher offer (and its window-timer scheduling) only executes in a later
 * microtask round. t.mock.timers.tick() is synchronous and never pumps
 * microtasks, so tests must pump until the entry actually queued BEFORE
 * ticking; otherwise the timer is scheduled at an already-advanced virtual
 * clock time and never fires.
 */

interface CapturedStatement {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface ScriptRule {
  readonly match: RegExp;
  respond(values: readonly unknown[]): SqlResult<never>;
}

/** Rule acknowledging every batch row with its own id (full success). */
const batchAckAllRule: ScriptRule = {
  match: /fast-journal:reserve-batch/,
  respond: (values) => {
    const rows = JSON.parse(String(values[0])) as Array<{ id: string }>;
    return { rows: rows.map((row) => ({ id: row.id })) as never, rowCount: rows.length };
  },
};

/** Rule acknowledging a single-statement reserve with the passed-in id. */
const reserveAckRule: ScriptRule = {
  match: /fast-journal:reserve-intent/,
  respond: (values) => ({
    rows: [{ id: values[0], credit_busy: false, credit_recoverable: false } as never],
    rowCount: 1,
  }),
};

function batchFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const statements: CapturedStatement[] = [];
  let epoch = '';
  let rules: ScriptRule[] = [];
  const runRules = (sql: string, values: readonly unknown[]): SqlResult<never> | undefined => {
    for (const rule of rules) if (rule.match.test(sql)) return rule.respond(values);
    return undefined;
  };
  const query = async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
    const params = values ?? [];
    statements.push({ sql, values: params });
    if (sql.includes('INSERT INTO saas_fast_gateway_owners')) {
      epoch = String(params[1]);
      return { rows: [], rowCount: 1 } as SqlResult<Row>;
    }
    const scripted = runRules(sql, params);
    if (scripted) return scripted as SqlResult<Row>;
    throw new Error(`unexpected SQL: ${sql.slice(0, 96)}`);
  };
  const database: SaasDatabase = {
    query,
    transaction: async (work) => work({ query }),
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
  const byokInput = (tenantId: string, owner: string, overrides: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    attemptId: randomUUID(),
    tenantId,
    projectId: randomUUID(),
    proxyKeyId: randomUUID(),
    requestFingerprint: 'a'.repeat(64),
    payloadSha256: 'b'.repeat(64),
    accountId: 'acct-1',
    currency: null,
    maxCostMinorUnits: '0',
    priceSnapshot: null,
    authoritySnapshot: { issuer: 'unit-test' },
    allocationOwner: owner,
    sendDeadlineMs: 60_000,
    ...overrides,
  });
  const reserveBatchStatements = () => statements.filter((s) => s.sql.includes('fast-journal:reserve-batch'));
  const reserveSingleStatements = () => statements.filter((s) => s.sql.includes('fast-journal:reserve-intent'));
  return {
    database,
    statements,
    byokInput,
    reserveBatchStatements,
    reserveSingleStatements,
    setRules: (next: ScriptRule[]) => {
      rules = next;
    },
    epoch: () => epoch,
  };
}

/** Pump microtasks until exactly `expected` entries sit in the batch queue. */
async function pumpQueued(journal: PostgresFastGatewayJournal, expected: number): Promise<void> {
  const state = journal as unknown as { reserveBatchQueued: number };
  for (let round = 0; round < 100_000; round += 1) {
    if (state.reserveBatchQueued === expected) return;
    await Promise.resolve();
  }
  throw new Error(`reserveBatchQueued never reached ${expected} (stuck at ${state.reserveBatchQueued})`);
}

/** Pump microtasks until a non-queue condition holds (bounded). */
async function pumpUntil(condition: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 100_000; round += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`condition never met: ${what}`);
}

function created(result: FastReserveResult): Extract<FastReserveResult, { kind: 'created' }> {
  assert.equal(result.kind, 'created');
  if (result.kind !== 'created') throw new Error('reserve denied');
  return result;
}

function batchRowIds(statement: CapturedStatement): string[] {
  return (JSON.parse(String(statement.values[0])) as Array<{ id: string }>).map((row) => row.id);
}

test('reserve batch constructor bounds window, rows and queue', () => {
  const database: SaasDatabase = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async () => {
      throw new Error('unused');
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
  for (const options of [
    { reserveBatchWindowMs: -1 },
    { reserveBatchWindowMs: 51 },
    { reserveBatchMaxRows: 0 },
    { reserveBatchMaxRows: 33 },
    { reserveBatchMaxRows: 16, reserveBatchMaxQueue: 8 },
    { reserveBatchMaxQueue: 8192 },
  ]) {
    assert.throws(
      () => new PostgresFastGatewayJournal(database, { allocationOwner: 'o', ...options }),
      /FAST_JOURNAL_INVALID_RESERVE_BATCH/,
      JSON.stringify(options),
    );
  }
});

test('same-group BYOK reserves aggregate into one batch statement after the window', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-a';
  fx.setRules([batchAckAllRule]);
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 5,
  });
  await journal.ready;
  const tenantId = randomUUID();
  const first = journal.reserveIntent(fx.byokInput(tenantId, owner));
  const second = journal.reserveIntent(fx.byokInput(tenantId, owner));
  await pumpQueued(journal, 2);
  assert.equal(fx.reserveBatchStatements().length, 0, 'window still open');
  t.mock.timers.tick(5);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fx.reserveBatchStatements().length, 1);
  assert.equal(fx.reserveSingleStatements().length, 0);
  const batch = fx.reserveBatchStatements()[0] as CapturedStatement;
  assert.equal(batchRowIds(batch).length, 2);
  assert.deepEqual(new Set(batchRowIds(batch)), new Set([created(a).intent.id, created(b).intent.id]));
  assert.equal(batch.values[4], null, 'BYOK group passes a null currency');
  await journal.close({ drain: false });
});

test('different tenants never share a batch statement', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-b';
  fx.setRules([batchAckAllRule]);
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 5,
  });
  await journal.ready;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const p1 = journal.reserveIntent(fx.byokInput(tenantA, owner));
  const p2 = journal.reserveIntent(fx.byokInput(tenantB, owner));
  const p3 = journal.reserveIntent(fx.byokInput(tenantA, owner));
  const p4 = journal.reserveIntent(fx.byokInput(tenantB, owner));
  await pumpQueued(journal, 4);
  t.mock.timers.tick(5);
  await Promise.all([p1, p2, p3, p4]);
  assert.equal(fx.reserveBatchStatements().length, 2, 'tenantA group and tenantB group');
  assert.equal(fx.reserveSingleStatements().length, 0);
  const sizes = fx
    .reserveBatchStatements()
    .map((s) => batchRowIds(s).length)
    .sort();
  assert.deepEqual(sizes, [2, 2]);
  await journal.close({ drain: false });
});

test('a full batch flushes immediately without waiting for the window', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-c';
  fx.setRules([batchAckAllRule, reserveAckRule]);
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 50,
    reserveBatchMaxRows: 4,
  });
  await journal.ready;
  const tenantId = randomUUID();
  const pending = Array.from({ length: 4 }, () => journal.reserveIntent(fx.byokInput(tenantId, owner)));
  await pumpUntil(() => fx.reserveBatchStatements().length === 1, 'row-cap immediate flush');
  await Promise.all(pending);
  assert.equal((JSON.parse(String(fx.reserveBatchStatements()[0]?.values[0])) as unknown[]).length, 4);
  // A fifth offer after the flush opens a fresh windowed group; with only one
  // entry it pays the lone-survivor direct path instead of batching.
  const fifth = journal.reserveIntent(fx.byokInput(tenantId, owner));
  await pumpQueued(journal, 1);
  t.mock.timers.tick(50);
  assert.equal((await fifth).kind, 'created');
  assert.equal(fx.reserveBatchStatements().length, 1, 'the lone survivor never batches');
  assert.equal(fx.reserveSingleStatements().length, 1);
  await journal.close({ drain: false });
});

test('batch unique violation degrades every row to the per-request legacy loop', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-d';
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 5,
  });
  await journal.ready;
  const tenantId = randomUUID();
  fx.setRules([
    {
      match: /fast-journal:reserve-batch/,
      respond: () => {
        throw Object.assign(new Error('injected duplicate key'), { code: '23505' });
      },
    },
    reserveAckRule,
  ]);
  const first = journal.reserveIntent(fx.byokInput(tenantId, owner));
  const second = journal.reserveIntent(fx.byokInput(tenantId, owner));
  await pumpQueued(journal, 2);
  t.mock.timers.tick(5);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fx.reserveSingleStatements().length, 2, 'both rows run their own single-statement reserve');
  assert.equal(created(a).intent.id, fx.reserveSingleStatements()[0]?.values[0]);
  assert.equal(created(b).intent.id, fx.reserveSingleStatements()[1]?.values[0]);
  await journal.close({ drain: false });
});

test('acknowledged shared batch no-write defers each row to the legacy loop with its own outcome', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-e';
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 5,
  });
  await journal.ready;
  const tenantId = randomUUID();
  const outcomes = new Map<string, { id: unknown }>();
  fx.setRules([
    {
      match: /fast-journal:reserve-batch/,
      respond: () => ({
        rows: [{ id: null, credit_busy: false, credit_recoverable: false } as never],
        rowCount: 1,
      }),
    },
    {
      match: /fast-journal:reserve-intent/,
      respond: (values) => {
        const outcome = outcomes.get(String(values[1])) ?? { id: values[0] };
        return { rows: [{ ...outcome, credit_busy: false, credit_recoverable: false } as never], rowCount: 1 };
      },
    },
    {
      match: /^SELECT i\.request_id, i\.intent_digest/,
      respond: () => ({ rows: [], rowCount: 0 }),
    },
  ]);
  const winner = fx.byokInput(tenantId, owner);
  const loser = fx.byokInput(tenantId, owner);
  outcomes.set(loser.requestId, { id: null });
  const first = journal.reserveIntent(winner);
  const second = journal.reserveIntent(loser);
  await pumpQueued(journal, 2);
  t.mock.timers.tick(5);
  assert.equal((await first).kind, 'created');
  assert.deepEqual(await second, { kind: 'denied', reason: 'credit_not_ready' });
  assert.equal(fx.reserveSingleStatements().length, 2);
  await journal.close({ drain: false });
});

test('non-unique batch error stays uncertain for every queued row', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-f';
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 5,
  });
  await journal.ready;
  const tenantId = randomUUID();
  fx.setRules([
    {
      match: /fast-journal:reserve-batch/,
      respond: () => {
        throw new Error('lost batch COMMIT ACK');
      },
    },
    {
      match: /fast-journal:reserve-intent/,
      respond: () => {
        throw new Error('legacy must not run after an uncertain batch error');
      },
    },
  ]);
  const first = journal.reserveIntent(fx.byokInput(tenantId, owner));
  const second = journal.reserveIntent(fx.byokInput(tenantId, owner));
  await pumpQueued(journal, 2);
  t.mock.timers.tick(5);
  await assert.rejects(first, /lost batch COMMIT ACK/);
  await assert.rejects(second, /lost batch COMMIT ACK/);
  assert.equal(fx.reserveSingleStatements().length, 0, 'uncertain batch error never degrades into retries');
  await journal.close({ drain: false });
});

test('queue backpressure falls back to the direct single-statement path', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-g';
  fx.setRules([batchAckAllRule, reserveAckRule]);
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 50,
    reserveBatchMaxRows: 4,
    reserveBatchMaxQueue: 4,
  });
  await journal.ready;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const queued = [
    journal.reserveIntent(fx.byokInput(tenantA, owner)),
    journal.reserveIntent(fx.byokInput(tenantA, owner)),
    journal.reserveIntent(fx.byokInput(tenantA, owner)),
    journal.reserveIntent(fx.byokInput(tenantB, owner)),
  ];
  await pumpQueued(journal, 4);
  // The global queue is full (4 across both groups); this admission bypasses.
  // Pump until its single-statement reserve is observable: the offer's
  // continuation must see the still-full queue BEFORE any flush drains it.
  const direct = journal.reserveIntent(fx.byokInput(tenantA, owner));
  await pumpUntil(() => fx.reserveSingleStatements().length === 1, 'the direct admission bypassed the full queue');
  t.mock.timers.tick(50);
  await Promise.all([...queued, direct]);
  assert.equal(fx.reserveBatchStatements().length, 1, 'the three-row tenantA group batches');
  assert.equal(batchRowIds(fx.reserveBatchStatements()[0] as CapturedStatement).length, 3);
  assert.equal(
    fx.reserveSingleStatements().length,
    2,
    'the overflow admission bypassed the queue and the lone tenantB survivor took the direct path',
  );
  await journal.close({ drain: false });
});

test('a send deadline expiring while queued denies without any reserve statement for that row', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-h';
  fx.setRules([batchAckAllRule]);
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 10,
  });
  await journal.ready;
  const tenantId = randomUUID();
  const live = journal.reserveIntent(fx.byokInput(tenantId, owner, { sendDeadlineMs: 60_000 }));
  const alsoLive = journal.reserveIntent(fx.byokInput(tenantId, owner, { sendDeadlineMs: 60_000 }));
  const expiring = journal.reserveIntent(fx.byokInput(tenantId, owner, { sendDeadlineMs: 5 }));
  await pumpQueued(journal, 3);
  t.mock.timers.tick(10);
  assert.equal((await live).kind, 'created');
  assert.equal((await alsoLive).kind, 'created');
  assert.deepEqual(await expiring, { kind: 'denied', reason: 'send_deadline' });
  assert.equal(fx.reserveBatchStatements().length, 1);
  assert.equal(
    (JSON.parse(String(fx.reserveBatchStatements()[0]?.values[0])) as unknown[]).length,
    2,
    'the expired row never entered the batch statement',
  );
  await journal.close({ drain: false });
});

test('close denies queued group-commit admissions as closed', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-i';
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    reserveBatchWindowMs: 50,
  });
  await journal.ready;
  const tenantId = randomUUID();
  const pending = journal.reserveIntent(fx.byokInput(tenantId, owner));
  await pumpQueued(journal, 1);
  await journal.close({ drain: false });
  assert.deepEqual(await pending, { kind: 'denied', reason: 'closed' });
  assert.equal(fx.reserveBatchStatements().length, 0);
});

test('paying group batch scripts one credit CAS against the summed max cost', async (t) => {
  const fx = batchFixture(t);
  const owner = 'owner-j';
  const journal = new PostgresFastGatewayJournal(fx.database, {
    allocationOwner: owner,
    allocationTrancheMinorUnits: '100000',
    reserveBatchWindowMs: 5,
  });
  await journal.ready;
  const tenantId = randomUUID();
  fx.setRules([
    {
      match: /SELECT epoch FROM saas_fast_gateway_owners/,
      respond: () => ({ rows: [{ epoch: fx.epoch() } as never], rowCount: 1 }),
    },
    {
      match: /pg_advisory_xact_lock/,
      respond: () => ({ rows: [], rowCount: 0 }),
    },
    {
      match:
        /UPDATE saas_fast_credit_allocations\s+SET backing_minor_units = backing_minor_units - available_minor_units/,
      respond: () => ({ rows: [], rowCount: 0 }),
    },
    {
      match: /FROM saas_wallets w WHERE/,
      respond: () => ({
        rows: [{ id: 'wallet-1', available: '100000', own_backing: '0', frozen: false } as never],
        rowCount: 1,
      }),
    },
    {
      match: /SELECT \* FROM saas_fast_credit_allocations WHERE/,
      respond: () => ({ rows: [], rowCount: 0 }),
    },
    {
      match: /saas_fast_gateway_credit_budgets/,
      respond: () => ({ rows: [], rowCount: 0 }),
    },
    {
      match: /INSERT INTO saas_fast_credit_allocations/,
      respond: () => ({ rows: [], rowCount: 1 }),
    },
    {
      match: /fast-journal:reserve-batch/,
      respond: (values) => {
        const rows = JSON.parse(String(values[0])) as Array<{ id: string; max_cost: string }>;
        assert.equal(
          rows.reduce((sum, row) => sum + BigInt(row.max_cost), 0n),
          160n,
          'the single CAS must cover the summed batch cost',
        );
        return { rows: rows.map((row) => ({ id: row.id })) as never, rowCount: rows.length };
      },
    },
  ]);
  const payingInput = () => intentFixture(tenantId, owner);
  const first = journal.reserveIntent(payingInput());
  const second = journal.reserveIntent(payingInput());
  await pumpQueued(journal, 2);
  t.mock.timers.tick(5);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fx.reserveBatchStatements().length, 1);
  assert.equal(fx.reserveSingleStatements().length, 0, 'replenishment pre-check satisfied without legacy reserves');
  const batch = fx.reserveBatchStatements()[0] as CapturedStatement;
  assert.equal(batch.values[3], tenantId);
  assert.equal(batch.values[4], 'USD');
  assert.deepEqual(new Set(batchRowIds(batch)), new Set([created(a).intent.id, created(b).intent.id]));
  await journal.close({ drain: false });
});
