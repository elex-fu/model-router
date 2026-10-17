import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderCredentialUnsealingKms } from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import type { AccountProbeOutcome, AccountProbeService } from '../../../src/saas/supply/account-probe-service.js';
import {
  buildProbeRunDetail,
  type ProbeMonitorRecord,
  ProbeMonitorWorker,
  pruneExpiredProbeRuns,
} from '../../../src/saas/supply/probe-monitor-worker.js';

type Row = Record<string, unknown>;

const DUMMY_KMS: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => {
    throw new Error('unexpected unseal in this test');
  },
};

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeDatabase {
  readonly queries: CapturedQuery[] = [];
  claimRow: Row | null = null;
  readonly accountSignalRows: Row[] = [];
  readonly deleteRows: Row[] = [];
  lockedClaims = 0;

  private readonly self: SqlExecutor & {
    transaction: (work: (tx: SqlExecutor) => Promise<unknown>) => Promise<unknown>;
  };

  constructor() {
    const executor: SqlExecutor = {
      query: async <RowType>(sql: string, values?: readonly unknown[]): Promise<SqlResult<RowType>> => {
        this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: values ?? [] });
        const normalized = sql.replace(/\s+/g, ' ');
        if (normalized.includes('FROM saas_probe_monitors') && normalized.includes('FOR UPDATE SKIP LOCKED')) {
          this.lockedClaims += 1;
          return {
            rows: (this.claimRow === null ? [] : [this.claimRow]) as RowType[],
            rowCount: this.claimRow === null ? 0 : 1,
          };
        }
        if (normalized.includes('FROM saas_probe_monitors') && normalized.includes('LIMIT 1')) {
          return {
            rows: (this.claimRow === null ? [] : [{ id: 'monitor-1' }]) as RowType[],
            rowCount: this.claimRow === null ? 0 : 1,
          };
        }
        if (
          normalized.startsWith('UPDATE saas_tenant_provider_accounts') ||
          normalized.startsWith('UPDATE saas_platform_provider_accounts')
        ) {
          return { rows: this.accountSignalRows as RowType[], rowCount: this.accountSignalRows.length };
        }
        if (normalized.startsWith('DELETE FROM saas_probe_runs')) {
          return { rows: this.deleteRows as RowType[], rowCount: this.deleteRows.length };
        }
        return { rows: [] as RowType[], rowCount: 0 };
      },
    };
    this.self = {
      ...executor,
      transaction: async (work) => work(executor),
    };
  }

  get executor(): SaasDatabase {
    return this.self as unknown as SaasDatabase;
  }
}

function monitorRow(overrides: Row = {}): Row {
  return {
    id: 'monitor-1',
    owner_kind: 'platform',
    owner_tenant_id: null,
    account_id: 'account-1',
    provider_category: 'opencode-go',
    probe_interval_seconds: 300,
    challenge_prompt: 'What is 6 + 11? Reply with only the number.',
    challenge_answer: '17',
    failure_threshold: 3,
    consecutive_failures: 0,
    probe_requested_at: null,
    ...overrides,
  };
}

function fakeProbe(outcome: Partial<AccountProbeOutcome>): AccountProbeService {
  const fixed: AccountProbeOutcome = {
    category: 'ok',
    httpStatus: 200,
    latencyMs: 42,
    resetAt: null,
    usage: { inputTokens: 3, outputTokens: 2 },
    reason: null,
    ...outcome,
  };
  const calls: unknown[] = [];
  return {
    async probe(request) {
      calls.push(request);
      return fixed;
    },
  } as AccountProbeService & { readonly calls: unknown[] };
}

function queriesContaining(database: FakeDatabase, fragment: string): CapturedQuery[] {
  return database.queries.filter((query) => query.sql.includes(fragment));
}

test('a due monitor is claimed with SKIP LOCKED, probed, and its run + state written in one transaction', async () => {
  const database = new FakeDatabase();
  database.claimRow = monitorRow();
  database.accountSignalRows.push({ id: 'account-1' });
  const probe = fakeProbe({});
  const store = new (await import('../../../src/saas/supply/probe-monitor-worker.js')).PostgresProbeMonitorStore(
    database.executor,
    DUMMY_KMS,
    { deployment: 'test-deployment', environment: 'test-environment', probe },
  );
  const run = await store.claimAndProbeNext();
  assert.ok(run);
  assert.equal(run.triggeredBy, 'scheduled');
  assert.equal(run.outcome.category, 'ok');

  const insert = queriesContaining(database, 'INSERT INTO saas_probe_runs')[0];
  assert.ok(insert);
  assert.equal(insert.values[1], 'monitor-1');
  assert.equal(insert.values[2], 'scheduled');
  assert.equal(insert.values[3], 'ok');
  assert.equal(insert.values[5], 200);
  assert.equal(insert.values[6], 42);
  const detail = JSON.parse(String(insert.values[4])) as Record<string, unknown>;
  assert.deepEqual(detail.probeUsage, { inputTokens: 3, outputTokens: 2 });
  // No request/response bodies or credentials ride the detail payload.
  assert.ok(!('body' in detail) && !('request' in detail) && !('credential' in detail));

  const update = queriesContaining(database, 'UPDATE saas_probe_monitors')[0];
  assert.ok(update);
  assert.equal(update.values[0], 'monitor-1');
  assert.equal(update.values[1], 0);
  assert.equal(update.values[2], 'ok');
  assert.equal(update.values[4], 300);
  assert.match(update.sql, /probe_requested_at = NULL/);
  assert.match(update.sql, /next_due_at = clock_timestamp\(\) \+/);

  // A healthy probe clears a previously armed unschedulable signal and
  // records the recovery audit event.
  const clear = queriesContaining(database, 'UPDATE saas_platform_provider_accounts')[0];
  assert.ok(clear);
  assert.match(clear.sql, /probe_temp_unschedulable_until = NULL/);
  assert.ok(queriesContaining(database, 'INSERT INTO saas_audit_events').length >= 1);
  const audit = queriesContaining(database, 'INSERT INTO saas_audit_events')[0];
  assert.equal(audit.values[2], 'saas_probe_monitor.account_recovered');
  assert.equal(audit.values[4], 'probe-monitor-worker');
});

test('a manual request marker yields triggered_by manual and is consumed', async () => {
  const database = new FakeDatabase();
  database.claimRow = monitorRow({
    owner_kind: 'tenant',
    owner_tenant_id: 'tenant-1',
    probe_requested_at: '2026-10-15T00:00:00Z',
  });
  const store = new (await import('../../../src/saas/supply/probe-monitor-worker.js')).PostgresProbeMonitorStore(
    database.executor,
    DUMMY_KMS,
    {
      deployment: 'd',
      environment: 'e',
      probe: fakeProbe({ category: 'error', httpStatus: null, reason: 'network', usage: null }),
    },
  );
  const run = await store.claimAndProbeNext();
  assert.equal(run?.triggeredBy, 'manual');
  const insert = queriesContaining(database, 'INSERT INTO saas_probe_runs')[0];
  assert.equal(insert?.values[2], 'manual');
  const detail = JSON.parse(String(insert?.values[4])) as Record<string, unknown>;
  assert.equal(detail.reason, 'network');
  // Below the failure threshold: no account unschedule write happens.
  assert.equal(queriesContaining(database, 'UPDATE saas_tenant_provider_accounts').length, 0);
});

test('crossing the failure threshold arms the unschedulable signal; recovery is probe-only', async () => {
  const database = new FakeDatabase();
  database.claimRow = monitorRow({ consecutive_failures: 2 });
  database.accountSignalRows.push({ id: 'account-1' });
  const store = new (await import('../../../src/saas/supply/probe-monitor-worker.js')).PostgresProbeMonitorStore(
    database.executor,
    DUMMY_KMS,
    {
      deployment: 'd',
      environment: 'e',
      unscheduleHorizonMs: 86_400_000,
      probe: fakeProbe({ category: 'auth_revoked', httpStatus: 401, usage: null }),
    },
  );
  const run = await store.claimAndProbeNext();
  assert.equal(run?.outcome.category, 'auth_revoked');
  const monitorUpdate = queriesContaining(database, 'UPDATE saas_probe_monitors')[0];
  assert.equal(monitorUpdate?.values[1], 3);
  const arm = queriesContaining(database, 'UPDATE saas_platform_provider_accounts')[0];
  assert.ok(arm);
  assert.match(arm.sql, /probe_temp_unschedulable_until = clock_timestamp\(\) \+/);
  assert.equal(arm.values[1], 86_400_000);
  const audit = queriesContaining(database, 'INSERT INTO saas_audit_events')[0];
  assert.equal(audit?.values[2], 'saas_probe_monitor.account_unscheduled');
});

test('nothing due claims nothing and a bounded round stops at the cap', async () => {
  const database = new FakeDatabase();
  database.claimRow = null;
  const store = new (await import('../../../src/saas/supply/probe-monitor-worker.js')).PostgresProbeMonitorStore(
    database.executor,
    DUMMY_KMS,
    { deployment: 'd', environment: 'e', probe: fakeProbe({}) },
  );
  assert.equal(await store.claimAndProbeNext(), null);
  assert.equal(queriesContaining(database, 'FROM saas_probe_monitors').length, 1);
  assert.equal(queriesContaining(database, 'INSERT INTO saas_probe_runs').length, 0);

  // An always-due claim loops at most PROBE_ROUND_CAP times per round.
  const looping = new FakeDatabase();
  looping.claimRow = monitorRow();
  const loopStore = new (await import('../../../src/saas/supply/probe-monitor-worker.js')).PostgresProbeMonitorStore(
    looping.executor,
    DUMMY_KMS,
    { deployment: 'd', environment: 'e', probe: fakeProbe({}) },
  );
  const worker = new ProbeMonitorWorker(loopStore, {});
  const probed = await worker.runOnce();
  assert.equal(probed, 10);
  assert.equal(looping.lockedClaims, 10);
});

test('retention prunes run history older than 30 days on the control-plane role', async () => {
  const database = new FakeDatabase();
  database.deleteRows.push({ id: 'run-1' }, { id: 'run-2' });
  const pruned = await pruneExpiredProbeRuns(database.executor);
  assert.equal(pruned, 2);
  const del = database.queries.find((query) => query.sql.startsWith('DELETE FROM saas_probe_runs'));
  assert.ok(del);
  assert.match(del.sql, /created_at < clock_timestamp\(\) - \(\$1 \* interval '1 day'\)/);
  assert.equal(del.values[0], 30);
});

test('run details are bounded, body-free and include the rate-limit reset deadline', () => {
  assert.deepEqual(
    JSON.parse(
      buildProbeRunDetail({
        category: 'rate_limited',
        httpStatus: 429,
        latencyMs: 5,
        resetAt: '2026-10-16T00:00:00.000Z',
        usage: null,
        reason: null,
      }),
    ) as Record<string, unknown>,
    { resetAt: '2026-10-16T00:00:00.000Z' },
  );
  assert.equal(
    buildProbeRunDetail({ category: 'ok', httpStatus: 200, latencyMs: 1, resetAt: null, usage: null, reason: null }),
    '{}',
  );
});

test('a malformed monitor row is skipped without a probe', async () => {
  const database = new FakeDatabase();
  database.claimRow = monitorRow({ provider_category: 'unknown-vendor' });
  const probe = fakeProbe({});
  const store = new (await import('../../../src/saas/supply/probe-monitor-worker.js')).PostgresProbeMonitorStore(
    database.executor,
    DUMMY_KMS,
    { deployment: 'd', environment: 'e', probe },
  );
  const run = await store.claimAndProbeNext();
  assert.equal(run, null);
  assert.equal(queriesContaining(database, 'INSERT INTO saas_probe_runs').length, 0);
});

test('the store constructor fails closed on an unusable database or KMS', async () => {
  const { PostgresProbeMonitorStore } = await import('../../../src/saas/supply/probe-monitor-worker.js');
  assert.throws(() => new PostgresProbeMonitorStore(null as never, DUMMY_KMS, { deployment: 'd', environment: 'e' }));
  assert.throws(
    () =>
      new PostgresProbeMonitorStore(new FakeDatabase().executor, null as never, {
        deployment: 'd',
        environment: 'e',
      }),
  );
  assert.throws(() => new PostgresProbeMonitorStore(new FakeDatabase().executor, DUMMY_KMS, null as never));
});

test('the store forwards the operator egress allowlist to the account probe service (R9 §4 P1)', async () => {
  const { PostgresProbeMonitorStore } = await import('../../../src/saas/supply/probe-monitor-worker.js');
  const { createProviderHttpEgressAllowlist } = await import('../../../src/saas/gateway/provider-http-address.js');
  // A valid allowlist constructs the default account probe service cleanly.
  const allowed = new PostgresProbeMonitorStore(new FakeDatabase().executor, DUMMY_KMS, {
    deployment: 'd',
    environment: 'e',
    egressAllowlist: createProviderHttpEgressAllowlist(['172.20.0.0/16']),
  });
  assert.ok(allowed);
  // A malformed allowlist fails store construction closed (the probe service
  // rejects it with INVALID_INPUT before any probe can run).
  assert.throws(
    () =>
      new PostgresProbeMonitorStore(new FakeDatabase().executor, DUMMY_KMS, {
        deployment: 'd',
        environment: 'e',
        egressAllowlist: {} as never,
      }),
  );
  // Unset keeps the exact pre-R9 strict posture.
  assert.ok(
    new PostgresProbeMonitorStore(new FakeDatabase().executor, DUMMY_KMS, { deployment: 'd', environment: 'e' }),
  );
});

test('the monitor mapping covers both owner scopes', async () => {
  const { PostgresProbeMonitorStore } = await import('../../../src/saas/supply/probe-monitor-worker.js');
  const database = new FakeDatabase();
  database.claimRow = monitorRow({ owner_kind: 'tenant', owner_tenant_id: 'tenant-9' });
  const probe = fakeProbe({});
  const store = new PostgresProbeMonitorStore(database.executor, DUMMY_KMS, {
    deployment: 'd',
    environment: 'e',
    probe,
  });
  const run = await store.claimAndProbeNext();
  assert.equal((run?.monitor as ProbeMonitorRecord | undefined)?.ownerKind, 'tenant');
  const clear = queriesContaining(database, 'UPDATE saas_tenant_provider_accounts')[0];
  assert.ok(clear);
  assert.deepEqual(clear.values, ['tenant-9', 'account-1']);
});
