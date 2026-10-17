import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  buildObsReportEmail,
  CronParseError,
  cronNextRun,
  DEFAULT_OBS_REPORT_CRONS,
  isCronDue,
  type ObsReportType,
  parseCronExpression,
  parseReportRecipients,
  type ReportSchedulerOptions,
  renderReportTemplate,
  resolveErrorDigestMinCount,
  resolveReportCrons,
  runReportSchedulerCycle,
} from '../../../src/saas/observability/reports.js';

// ---------------------------------------------------------------------------
// Cron parsing (robfig/cron 5-field semantics, UTC)
// ---------------------------------------------------------------------------

function nextFrom(expression: string, fromIso: string): number {
  return cronNextRun(parseCronExpression(expression), Date.parse(fromIso));
}

test('cron parsing accepts the supported field syntaxes', () => {
  const every = parseCronExpression('* * * * *');
  assert.deepEqual(every.minute.length, 60);
  assert.equal(every.domRestricted, false);
  assert.equal(every.dowRestricted, false);

  const anchored = parseCronExpression('5/15 * * * *');
  assert.deepEqual(anchored.minute, [5, 20, 35, 50]);

  const range = parseCronExpression('0 8-10 * * *');
  assert.deepEqual(range.hour, [8, 9, 10]);

  const list = parseCronExpression('0,30 6 * * *');
  assert.deepEqual(list.minute, [0, 30]);

  const names = parseCronExpression('0 8 * jan-mar mon');
  assert.deepEqual(names.month, [1, 2, 3]);
  assert.deepEqual(names.dow, [1]);

  // dow 7 is Sunday, normalized onto 0.
  const sunday = parseCronExpression('0 0 * * 7');
  assert.deepEqual(sunday.dow, [0]);
  assert.equal(sunday.dowRestricted, true);

  // `?` behaves like `*` (unrestricted).
  const question = parseCronExpression('0 8 ? * ?');
  assert.equal(question.domRestricted, false);
  assert.equal(question.dowRestricted, false);
});

test('cron parsing rejects malformed expressions', () => {
  for (const bad of [
    '* * * *', // four fields
    '* * * * * *', // six fields
    '60 * * * *', // minute out of range
    '* 24 * * *', // hour out of range
    '* * 0 * *', // dom out of range
    '* * * 13 *', // month out of range
    '* * * * 8', // dow out of range
    '10-5 * * * *', // inverted range
    '*/0 * * * *', // zero step
    'a * * * *', // junk token
  ]) {
    assert.throws(
      () => parseCronExpression(bad),
      (error: unknown) => error instanceof CronParseError,
      `expected ${bad} to be rejected`,
    );
  }
});

test('cronNextRun table: minute/hour/day rollovers in UTC', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    // Every 30 minutes: 10:31 → 11:00.
    ['*/30 * * * *', '2026-10-17T10:31:00Z', '2026-10-17T11:00:00Z'],
    // Daily at 08:00.
    ['0 8 * * *', '2026-10-17T09:00:00Z', '2026-10-18T08:00:00Z'],
    // Same day when the time is still ahead.
    ['0 8 * * *', '2026-10-17T07:00:00Z', '2026-10-17T08:00:00Z'],
    // Weekly Monday 08:00: Saturday → next Monday.
    ['0 8 * * 1', '2026-10-17T09:00:00Z', '2026-10-19T08:00:00Z'],
    // Month rollover: Oct 17 → Feb 1 next year.
    ['0 0 1 2 *', '2026-10-17T00:00:00Z', '2027-02-01T00:00:00Z'],
    // Year rollover: Dec 31 → Jan 1.
    ['0 0 1 1 *', '2026-12-31T12:00:00Z', '2027-01-01T00:00:00Z'],
    // Feb 29 only exists on leap years: 2028.
    ['0 0 29 2 *', '2026-10-17T00:00:00Z', '2028-02-29T00:00:00Z'],
    // End of month: Oct 31 → Nov 30 (Nov has 30 days).
    ['0 0 31 * *', '2026-10-17T00:00:00Z', '2026-10-31T00:00:00Z'],
    // dom/dow OR rule: both restricted, Oct 19 (Monday) matches on dow
    // although dom is 1.
    ['0 0 1 * 1', '2026-10-17T00:00:00Z', '2026-10-19T00:00:00Z'],
    // Only dom restricted: Nov 1 is the next first-of-month.
    ['0 0 1 * *', '2026-10-17T00:00:00Z', '2026-11-01T00:00:00Z'],
    // Only dow restricted: Sunday Oct 18.
    ['0 0 * * 0', '2026-10-17T00:00:00Z', '2026-10-18T00:00:00Z'],
    // Names: next January 1st.
    ['0 0 1 jan *', '2026-10-17T00:00:00Z', '2027-01-01T00:00:00Z'],
    // Exact current timestamp is NOT returned (strictly after).
    ['0 8 * * *', '2026-10-17T08:00:00Z', '2026-10-18T08:00:00Z'],
  ];
  for (const [expression, from, expected] of cases) {
    assert.equal(nextFrom(expression, from), Date.parse(expected), `${expression} from ${from}`);
  }
});

test('isCronDue fires exactly once per occurrence window', () => {
  const daily = parseCronExpression('0 8 * * *');
  // Never run → due.
  assert.equal(isCronDue(daily, null, Date.parse('2026-10-17T06:00:00Z')), true);
  // Ran yesterday 08:00, now before the next 08:00 → not due.
  assert.equal(isCronDue(daily, Date.parse('2026-10-16T08:00:00Z'), Date.parse('2026-10-17T07:59:00Z')), false);
  // Now after the next 08:00 → due.
  assert.equal(isCronDue(daily, Date.parse('2026-10-16T08:00:00Z'), Date.parse('2026-10-17T08:00:01Z')), true);
  // Exactly at the boundary → due (the occurrence passed).
  assert.equal(isCronDue(daily, Date.parse('2026-10-16T08:00:00Z'), Date.parse('2026-10-17T08:00:00Z')), true);
});

test('default schedules parse and env overrides apply', () => {
  for (const expression of Object.values(DEFAULT_OBS_REPORT_CRONS)) {
    assert.doesNotThrow(() => parseCronExpression(expression));
  }
  const crons = resolveReportCrons({
    MODEL_ROUTER_SAAS_OBS_REPORT_CRON_ERROR_DIGEST: '0 * * * *',
  } as NodeJS.ProcessEnv);
  // The override '0 * * * *' pins the minute, leaving every hour eligible.
  assert.deepEqual(crons.error_digest.minute, [0]);
  assert.deepEqual(crons.daily_summary.minute, [0]);
  assert.equal(resolveErrorDigestMinCount({} as NodeJS.ProcessEnv), 1);
  assert.equal(
    resolveErrorDigestMinCount({ MODEL_ROUTER_SAAS_OBS_ERROR_DIGEST_MIN_COUNT: '5' } as NodeJS.ProcessEnv),
    5,
  );
  assert.equal(
    resolveErrorDigestMinCount({ MODEL_ROUTER_SAAS_OBS_ERROR_DIGEST_MIN_COUNT: 'junk' } as NodeJS.ProcessEnv),
    1,
  );
});

test('parseReportRecipients splits, trims and drops non-emails', () => {
  assert.deepEqual(parseReportRecipients('a@example.com, b@example.com'), ['a@example.com', 'b@example.com']);
  assert.deepEqual(parseReportRecipients('  a@example.com ,,not-an-email  '), ['a@example.com']);
  assert.deepEqual(parseReportRecipients(undefined), []);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('renderReportTemplate substitutes known keys and drops unknown ones', () => {
  assert.equal(
    renderReportTemplate('A {{openAlerts}} B {{ missing }} C {{triggeredAlerts}}', {
      openAlerts: 3,
      triggeredAlerts: 7,
    }),
    'A 3 B  C 7',
  );
});

test('buildObsReportEmail prefers a custom template and falls back to the built-in', async (t) => {
  const fake = new SchedulerFakeDatabase();
  // The default builder queries: channel status, alert counts (x1 per Promise
  // slot ordering is not guaranteed, so feed counts for every query), wallet
  // holds, enabled rules. Queue generous counts for each.
  // Two builder calls (custom + fallback). The alert-count query is answered
  // by the fake's special case; the queued rows serve [channel status,
  // wallet holds, enabled rules] in Promise.all order.
  for (let call = 0; call < 2; call += 1) {
    fake.enqueueNext([]); // channel status: no channel rows
    fake.enqueueNext([{ count: '0' }]); // wallet holds
    fake.enqueueNext([{ count: '1' }]); // enabled rules
  }

  const dir = await mkdtemp(join(tmpdir(), 'mr-report-tpl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'daily_summary.html'), 'CUSTOM {{openAlerts}}');

  const withCustom = await buildObsReportEmail(
    fake.asDatabase(),
    'daily_summary',
    { now: new Date('2026-10-17T08:00:00Z'), windowStart: new Date('2026-10-16T08:00:00Z') },
    { templateDir: dir },
  );
  assert.equal(withCustom.html, 'CUSTOM 0');
  assert.match(withCustom.subject, /daily summary/);
  assert.match(withCustom.text, /model-router daily_summary/);

  // A missing template file falls back to the built-in HTML.
  const fallback = await buildObsReportEmail(
    fake.asDatabase(),
    'daily_summary',
    { now: new Date('2026-10-17T08:00:00Z'), windowStart: new Date('2026-10-16T08:00:00Z') },
    { templateDir: join(dir, 'does-not-exist') },
  );
  assert.match(fallback.html, /<h1>model-router daily_summary<\/h1>/);
});

// ---------------------------------------------------------------------------
// Scheduler cycle
// ---------------------------------------------------------------------------

class SchedulerFakeDatabase {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly events: string[] = [];
  /** Report types whose lease row shows an old (due) last_run. */
  readonly dueTypes = new Set<ObsReportType>();
  /** Report types whose lease row is held by another replica (no rows). */
  readonly lockedTypes = new Set<ObsReportType>();
  /** Rows served to the alert-event count queries. */
  alertCountRow: Record<string, unknown> = { triggered: '0', resolved: '0', open: '0' };
  private readonly queue: Array<Record<string, unknown>[]> = [];

  enqueueNext(rows: Record<string, unknown>[]): void {
    this.queue.push(rows);
  }

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ sql, values: values ?? [] });
    this.events.push(`sql:${sql.slice(0, 48)}`);
    // Bootstrap inserts and claim updates take nothing from the queue.
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
      return { rows: [], rowCount: 0 };
    }
    // The lease select is answered from dueTypes keyed on the report_type
    // parameter, so per-type ordering never depends on queue position.
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const type = String(values?.[0] ?? '');
      if (this.lockedTypes.has(type as ObsReportType)) {
        return { rows: [] as Row[], rowCount: 0 };
      }
      const due = this.dueTypes.has(type as ObsReportType);
      const lastRun = due
        ? new Date('2026-10-16T12:00:00Z') // a day old: due under the ALWAYS cron
        : new Date('2026-10-17T11:59:00Z'); // just ran: not due
      return { rows: [{ last_run_at: lastRun }] as Row[], rowCount: 1 };
    }
    if (sql.includes('saas_obs_alert_events')) {
      return { rows: [this.alertCountRow] as Row[], rowCount: 1 };
    }
    if (sql.includes('saas_users')) {
      const rows = (this.queue.shift() ?? []) as Row[];
      return { rows, rowCount: rows.length };
    }
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

  asDatabase(): SaasDatabase {
    return this as unknown as SaasDatabase;
  }
}

class RecordingEmailSender {
  readonly sent: Array<{ to: string; subject: string }> = [];
  async send(input: { to: string; subject: string; body: string }): Promise<void> {
    this.sent.push({ to: input.to, subject: input.subject });
  }
}

interface SchedulerHarness {
  readonly fake: SchedulerFakeDatabase;
  readonly email: RecordingEmailSender;
  readonly options: ReportSchedulerOptions;
  readonly buildCalls: ObsReportType[];
  readonly sentTypes: ObsReportType[];
  readonly errors: Array<{ error: unknown; type?: ObsReportType }>;
}

const NEVER = '0 0 30 2 *'; // Feb 30 never exists: never due.
const ALWAYS = '* * * * *';

function harness(
  setup: (fake: SchedulerFakeDatabase) => void,
  overrides: Partial<ReportSchedulerOptions> = {},
): SchedulerHarness {
  const fake = new SchedulerFakeDatabase();
  setup(fake);
  const email = new RecordingEmailSender();
  const buildCalls: ObsReportType[] = [];
  const sentTypes: ObsReportType[] = [];
  const errors: Array<{ error: unknown; type?: ObsReportType }> = [];
  const options: ReportSchedulerOptions = {
    emailSender: email,
    crons: {
      daily_summary: NEVER,
      weekly_summary: NEVER,
      error_digest: NEVER,
      account_health: NEVER,
    },
    recipients: async () => ['ops@example.com'],
    now: () => new Date('2026-10-17T12:00:00Z'),
    buildReport: async (_database, type) => {
      fake.events.push(`build:${type}`);
      buildCalls.push(type);
      return { subject: `report ${type}`, html: `<p>${type}</p>`, text: type };
    },
    onError: (error, type) => errors.push({ error, type }),
    onSent: (type) => sentTypes.push(type),
    ...overrides,
  };
  return { fake, email, options, buildCalls, sentTypes, errors };
}

test('runReportSchedulerCycle claims, writes last_run BEFORE building, and sends', async () => {
  const { fake, email, options, buildCalls, sentTypes, errors } = harness((db) => {
    db.dueTypes.add('error_digest');
    db.alertCountRow = { triggered: '5', resolved: '1', open: '2' };
  });
  options.crons = { ...options.crons, error_digest: ALWAYS };

  const claimed = await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.deepEqual(claimed, ['error_digest']);
  assert.deepEqual(buildCalls, ['error_digest']);
  assert.deepEqual(sentTypes, ['error_digest']);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0]?.to, 'ops@example.com');
  assert.equal(errors.length, 0);
  // The claim UPDATE precedes the build and the send.
  const claimIndex = fake.events.findIndex((entry) => entry.startsWith('sql:UPDATE saas_obs_report_state'));
  const buildIndex = fake.events.findIndex((entry) => entry.startsWith('build:'));
  assert.ok(claimIndex >= 0, 'the last_run UPDATE must run');
  assert.ok(claimIndex < buildIndex, 'last_run is written BEFORE content generation');
});

test('runReportSchedulerCycle skips report types that are not due', async () => {
  const { fake, options, buildCalls } = harness(() => {
    // No dueTypes: every lease row shows a run from a minute ago.
  });
  const claimed = await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.deepEqual(claimed, []);
  assert.deepEqual(buildCalls, []);
  assert.equal(
    fake.queries.some((query) => query.sql.includes('UPDATE saas_obs_report_state SET last_run_at')),
    false,
  );
});

test('error_digest below min_count claims the run but sends nothing', async () => {
  const { fake, email, options, buildCalls, errors } = harness((db) => {
    db.dueTypes.add('error_digest');
    db.alertCountRow = { triggered: '2', resolved: '0', open: '0' };
  });
  options.crons = { ...options.crons, error_digest: ALWAYS };
  options.errorDigestMinCount = 5;

  const claimed = await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.deepEqual(claimed, ['error_digest']); // the run is claimed…
  assert.deepEqual(buildCalls, []); // …but nothing is generated…
  assert.equal(email.sent.length, 0); // …or sent.
  assert.equal(errors.length, 0);
  assert.ok(fake.queries.some((query) => query.sql.includes('UPDATE saas_obs_report_state SET last_run_at')));
});

test('a failing send never retries within the same period (last_run already advanced)', async () => {
  const failingEmail = {
    send: async () => {
      throw new Error('SMTP misconfigured');
    },
  };
  const { fake, options, errors } = harness((db) => {
    db.dueTypes.add('error_digest');
    db.alertCountRow = { triggered: '9', resolved: '0', open: '0' };
  });
  options.crons = { ...options.crons, error_digest: ALWAYS };
  options.emailSender = failingEmail;

  const claimed = await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.deepEqual(claimed, ['error_digest']);
  assert.equal(errors.length, 1);
  // The claim UPDATE still happened before the failed send.
  const claimIndex = fake.events.findIndex((entry) => entry.startsWith('sql:UPDATE saas_obs_report_state'));
  assert.ok(claimIndex >= 0);
});

test('empty recipient list falls back to the first platform superadmin', async () => {
  const { fake, email, options } = harness((db) => {
    db.dueTypes.add('error_digest');
    db.alertCountRow = { triggered: '4', resolved: '0', open: '0' };
    db.enqueueNext([{ email: 'root-admin@example.com' }]); // first admin fallback
  });
  options.crons = { ...options.crons, error_digest: ALWAYS };
  options.recipients = async () => [];

  await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0]?.to, 'root-admin@example.com');
});

test('a locked state row (another replica) is skipped without a claim', async () => {
  const { fake, options, buildCalls } = harness((db) => {
    // Every type is due, but every lease row is held by another replica.
    for (const type of ['daily_summary', 'weekly_summary', 'error_digest', 'account_health'] as const) {
      db.dueTypes.add(type);
      db.lockedTypes.add(type);
    }
  });
  options.crons = {
    daily_summary: ALWAYS,
    weekly_summary: ALWAYS,
    error_digest: ALWAYS,
    account_health: ALWAYS,
  };
  const claimed = await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.deepEqual(claimed, []);
  assert.deepEqual(buildCalls, []);
});

test('a database failure on one report type does not stop the others', async () => {
  const { fake, email, options, buildCalls, errors } = harness((db) => {
    db.dueTypes.add('error_digest');
    db.alertCountRow = { triggered: '7', resolved: '0', open: '0' };
  });
  const originalQuery = fake.query.bind(fake);
  fake.query = async (sql: string, values?: readonly unknown[]) => {
    // The daily_summary lease fails: the cycle must continue to error_digest.
    if (sql.includes('FOR UPDATE SKIP LOCKED') && values?.[0] === 'daily_summary') {
      throw new Error('connection reset');
    }
    return originalQuery(sql, values);
  };
  options.crons = { ...options.crons, error_digest: ALWAYS, daily_summary: ALWAYS };

  const claimed = await runReportSchedulerCycle(fake.asDatabase(), options);
  assert.deepEqual(claimed, ['error_digest']);
  assert.deepEqual(buildCalls, ['error_digest']);
  assert.equal(email.sent.length, 1);
  assert.equal(errors.length, 1);
});
