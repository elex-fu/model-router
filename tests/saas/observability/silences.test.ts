import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  type AlertSilenceRecord,
  isRuleSilenced,
  ObservabilityAlertSilenceService,
  ObservabilitySilenceValidationError,
} from '../../../src/saas/observability/alert-silences.js';
import { type AlertMinuteSample, runAlertEvaluatorCycle } from '../../../src/saas/observability/alerts.js';

// ---------------------------------------------------------------------------
// Fake database: records every query, serves queued results, transaction is
// the same executor (the SKIP LOCKED lease semantics are PG-only; the fake
// exercises the query flow, not locking).
// ---------------------------------------------------------------------------

interface RecordedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeObservabilityDatabase {
  readonly queries: RecordedQuery[] = [];
  private readonly queue: Array<Record<string, unknown>[]> = [];

  enqueueNext(rows: Record<string, unknown>[]): void {
    this.queue.push(rows);
  }

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ sql, values: values ?? [] });
    const rows = (this.queue.shift() ?? []) as Row[];
    return { rows, rowCount: rows.length };
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this as unknown as SqlExecutor);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function asDatabase(fake: FakeObservabilityDatabase): SaasDatabase {
  return fake as unknown as SaasDatabase;
}

function ruleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b7d1c0de-0000-4000-8000-000000000001',
    name: 'kimi error rate',
    enabled: true,
    metric: 'channel_error_rate:provider=kimi',
    operator: 'gt',
    threshold: 0.1,
    window_minutes: 10,
    sustained_minutes: 3,
    cooldown_minutes: 30,
    notify_email: null,
    webhook_url: null,
    last_triggered_at: null,
    created_at: new Date('2026-10-15T00:00:00Z'),
    ...overrides,
  };
}

function silenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c8e2d1ef-0000-4000-8000-00000000000a',
    rule_id: null,
    platform: null,
    group_id: null,
    region: null,
    until: new Date('2026-10-20T00:00:00Z'),
    reason: 'maintenance window',
    created_by: 'operator-1',
    created_at: new Date('2026-10-16T00:00:00Z'),
    ...overrides,
  };
}

function recordFrom(row: Record<string, unknown>): AlertSilenceRecord {
  return {
    id: String(row.id),
    ruleId: (row.rule_id as string | null) ?? null,
    platform: (row.platform as string | null) ?? null,
    groupId: (row.group_id as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    until: (row.until as Date).toISOString(),
    reason: (row.reason as string | null) ?? null,
    createdBy: String(row.created_by),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

const NOW = new Date('2026-10-17T12:00:00Z');

// ---------------------------------------------------------------------------
// Pure silence matching
// ---------------------------------------------------------------------------

const RULE_ID = 'rule-1';
const RULE_PROVIDER = 'kimi';
const FUTURE = new Date('2026-10-20T00:00:00Z').toISOString();
const PAST = new Date('2026-10-16T00:00:00Z').toISOString();

test('isRuleSilenced matches by rule id, null rule, and platform scope', () => {
  const now = NOW.getTime();
  // Null rule_id silences every rule.
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: null, platform: null, groupId: null, region: null, until: FUTURE }],
      now,
    ),
    true,
  );
  assert.equal(
    isRuleSilenced(
      'rule-2',
      undefined,
      [{ ruleId: null, platform: null, groupId: null, region: null, until: FUTURE }],
      now,
    ),
    true,
  );
  // A different rule id does not match.
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: 'rule-9', platform: null, groupId: null, region: null, until: FUTURE }],
      now,
    ),
    false,
  );
  // The exact rule id matches.
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: 'rule-1', platform: null, groupId: null, region: null, until: FUTURE }],
      now,
    ),
    true,
  );
  // A platform-scoped silence only quiets that platform's scoped rules.
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: null, platform: 'kimi', groupId: null, region: null, until: FUTURE }],
      now,
    ),
    true,
  );
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: null, platform: 'other', groupId: null, region: null, until: FUTURE }],
      now,
    ),
    false,
  );
  assert.equal(
    isRuleSilenced(
      'rule-2',
      undefined,
      [{ ruleId: null, platform: 'kimi', groupId: null, region: null, until: FUTURE }],
      now,
    ),
    false,
  );
  // Expired silences never match.
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: null, platform: null, groupId: null, region: null, until: PAST }],
      now,
    ),
    false,
  );
  // group/region are reserved dimensions: they always match alongside a rule scope.
  assert.equal(
    isRuleSilenced(
      RULE_ID,
      RULE_PROVIDER,
      [{ ruleId: 'rule-1', platform: null, groupId: 'group-7', region: 'cn', until: FUTURE }],
      now,
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Service CRUD and validation
// ---------------------------------------------------------------------------

test('createSilence validates shape, rule existence and persists the row', async () => {
  const fake = new FakeObservabilityDatabase();
  const service = new ObservabilityAlertSilenceService(fake as unknown as SqlExecutor);
  const until = new Date('2026-10-20T00:00:00Z').toISOString();

  // Empty scope fails.
  await assert.rejects(
    service.createSilence({ until, createdBy: 'operator-1' }),
    (error: unknown) => error instanceof ObservabilitySilenceValidationError && error.code === 'SILENCE_EMPTY_SCOPE',
  );
  // Past until fails.
  await assert.rejects(
    service.createSilence({ platform: 'kimi', until: PAST, createdBy: 'operator-1' }),
    (error: unknown) => error instanceof ObservabilitySilenceValidationError && error.code === 'SILENCE_UNTIL_IN_PAST',
  );
  // Malformed rule id fails.
  await assert.rejects(
    service.createSilence({ ruleId: 'not-a-uuid', until, createdBy: 'operator-1' }),
    (error: unknown) => error instanceof ObservabilitySilenceValidationError && error.code === 'SILENCE_INVALID_RULE',
  );
  // Unknown rule id fails on the existence check.
  fake.enqueueNext([]); // rule lookup: no rows
  await assert.rejects(
    service.createSilence({ ruleId: 'b7d1c0de-0000-4000-8000-000000000001', until, createdBy: 'operator-1' }),
    (error: unknown) => error instanceof ObservabilitySilenceValidationError && error.code === 'SILENCE_INVALID_RULE',
  );

  // A valid platform silence inserts and returns the record.
  fake.enqueueNext([silenceRow({ platform: 'kimi' })]);
  const created = await service.createSilence({ platform: 'kimi', until, reason: 'maint', createdBy: 'operator-1' });
  assert.equal(created.platform, 'kimi');
  assert.equal(created.until, until);
  const insert = fake.queries.at(-1);
  assert.ok(insert?.sql.includes('INSERT INTO saas_obs_alert_silences'));
});

test('listSilences hides expired rows by default and deleteSilence reports existence', async () => {
  const fake = new FakeObservabilityDatabase();
  const service = new ObservabilityAlertSilenceService(fake as unknown as SqlExecutor);

  fake.enqueueNext([silenceRow()]);
  const active = await service.listSilences();
  assert.equal(active.length, 1);
  assert.ok(fake.queries[0]?.sql.includes('WHERE until > now()'));

  fake.enqueueNext([silenceRow()]);
  const all = await service.listSilences({ includeExpired: true });
  assert.equal(all.length, 1);
  assert.ok(!fake.queries[1]?.sql.includes('WHERE until > now()'));

  fake.enqueueNext([]); // zero deleted rows
  assert.equal(await service.deleteSilence('missing'), false);
  fake.enqueueNext([{}]); // one deleted row
  assert.equal(await service.deleteSilence('c8e2d1ef-0000-4000-8000-00000000000a'), true);
});

// ---------------------------------------------------------------------------
// Evaluator integration: silence skip + auto-resolve
// ---------------------------------------------------------------------------

function samples(count: number, value: number): AlertMinuteSample[] {
  const start = NOW.getTime() - count * 60_000;
  return Array.from({ length: count }, (_unused, index) => ({
    minuteStartMs: start + index * 60_000,
    value,
  }));
}

test('runAlertEvaluatorCycle skips a silenced rule entirely', async () => {
  const fake = new FakeObservabilityDatabase();
  fake.enqueueNext([ruleRow()]); // rules
  fake.enqueueNext([silenceRow({ rule_id: 'b7d1c0de-0000-4000-8000-000000000001' })]); // active silences
  const triggered = await runAlertEvaluatorCycle(asDatabase(fake), { now: () => NOW });
  assert.equal(triggered, 0);
  // Only the rules and silences queries ran: no samples, no transaction work.
  assert.equal(fake.queries.length, 2);
  assert.ok(fake.queries[1]?.sql.includes('saas_obs_alert_silences'));
});

test('runAlertEvaluatorCycle auto-resolves open events when the window stops violating', async () => {
  const fake = new FakeObservabilityDatabase();
  fake.enqueueNext([ruleRow()]); // rules
  fake.enqueueNext([]); // silences
  fake.enqueueNext([ruleRow()]); // locked rule row (the lease)
  fake.enqueueNext([]); // channel samples: no data → window value 0, no violation
  fake.enqueueNext([]); // UPDATE resolved_at: no rows matched is fine (rowCount 0)

  const triggered = await runAlertEvaluatorCycle(asDatabase(fake), { now: () => NOW });
  assert.equal(triggered, 0);
  const resolve = fake.queries.find((query) => query.sql.includes('SET resolved_at'));
  assert.ok(resolve, 'the auto-resolve UPDATE must run');
  assert.equal(resolve?.values[0], 'b7d1c0de-0000-4000-8000-000000000001');
  assert.equal(resolve?.values[1], NOW.toISOString());
  // No trigger insert happened.
  assert.equal(
    fake.queries.some((query) => query.sql.includes('INSERT INTO saas_obs_alert_events')),
    false,
  );
});

test('runAlertEvaluatorCycle keeps events firing while the window still violates', async () => {
  const fake = new FakeObservabilityDatabase();
  const violating = samples(5, 0.9).map((sample) => ({
    bucket_at: new Date(sample.minuteStartMs),
    requests: 100,
    errors: 90,
  }));
  fake.enqueueNext([ruleRow({ last_triggered_at: null })]); // rules
  fake.enqueueNext([]); // silences
  fake.enqueueNext([ruleRow()]); // locked rule row (the lease)
  fake.enqueueNext(violating); // all minute buckets in one query
  fake.enqueueNext([]); // INSERT event
  fake.enqueueNext([]); // UPDATE last_triggered_at

  const triggered = await runAlertEvaluatorCycle(asDatabase(fake), { now: () => NOW });
  assert.equal(triggered, 1);
  // No auto-resolve while violating.
  assert.equal(
    fake.queries.some((query) => query.sql.includes('SET resolved_at')),
    false,
  );
  assert.ok(fake.queries.some((query) => query.sql.includes('INSERT INTO saas_obs_alert_events')));
});

test('runAlertEvaluatorCycle degrades gracefully when the silence table cannot be read', async () => {
  const failing = new FakeObservabilityDatabase();
  const wrapped = {
    query: async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('saas_obs_alert_silences')) throw new Error('relation does not exist');
      return failing.query(sql, values);
    },
    transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => failing.transaction(work),
    migrate: () => Promise.resolve(),
    verifySchema: () => Promise.resolve(),
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  failing.enqueueNext([ruleRow()]); // rules
  failing.enqueueNext([ruleRow()]); // locked rule row (the lease)
  failing.enqueueNext([]); // channel samples
  failing.enqueueNext([]); // resolve update
  const triggered = await runAlertEvaluatorCycle(wrapped as unknown as SaasDatabase, { now: () => NOW });
  assert.equal(triggered, 0);
  // Evaluation continued despite the silence read failing.
  assert.ok(failing.queries.some((query) => query.sql.includes('FOR UPDATE SKIP LOCKED')));
});
