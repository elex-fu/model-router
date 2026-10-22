import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  type ProviderAccountRuntimeHealthCandidate,
  type ProviderAccountRuntimeHealthEvidence,
  ProviderAccountRuntimeHealthStoreError,
} from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';

export const HEALTH_CLOCK_REQUIRED = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roleUrls = {
  migrator: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL?.trim(),
  control_plane: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL?.trim(),
  gateway: process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim(),
};
export const healthClockPgConfigured = Object.values(roleUrls).some(Boolean);
const hash = (input: string) => createHash('sha256').update(input).digest('hex');

// Select the actual private source statement without importing a test root,
// evaluating a template, executing copied SQL, or accepting a loose SQL marker.
const writerSource = readFileSync(
  resolve(__dirname, '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.ts'),
  'utf8',
);
assert.ok(writerSource.includes("const HEALTH_TABLE = 'saas_provider_account_runtime_health';"));
assert.ok(writerSource.includes("const LEASE_TABLE = 'saas_provider_account_leases';"));
const templates = [...writerSource.matchAll(/const WRITE_HEALTH_SQL = `([\s\S]*?)`;/g)];
assert.equal(templates.length, 1, 'the production health writer must expose exactly one literal source statement');
const template = templates[0]?.[1];
assert.ok(template);
const interpolations = [...new Set([...template.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]))].sort();
assert.deepEqual(interpolations, ['HEALTH_TABLE', 'LEASE_TABLE']);
const sourceStatement = template
  .replaceAll(/\$\{HEALTH_TABLE\}/g, 'saas_provider_account_runtime_health')
  .replaceAll(/\$\{LEASE_TABLE\}/g, 'saas_provider_account_leases');
assert.equal(sourceStatement.includes('${'), false);
export const HEALTH_CLOCK_WRITE_SQL_SHA256 = hash(sourceStatement);

function disposableRoleTargets(): Record<keyof typeof roleUrls, string> {
  let target: string | undefined;
  const validated = {} as Record<keyof typeof roleUrls, string>;
  for (const role of Object.keys(roleUrls) as Array<keyof typeof roleUrls>) {
    const value = roleUrls[role];
    assert.ok(value, `the disposable health-clock ${role} URL is required`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('the disposable health-clock target must be a valid PostgreSQL URL; details redacted');
    }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
    assert.equal(decodeURIComponent(parsed.username), `model_router_saas_${role}`);
    assert.equal(parsed.hash, '');
    assert.equal(parsed.search, '', 'no connection overrides');
    const hostname = parsed.hostname.toLowerCase();
    const port = Number(parsed.port);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local =
      ['127.0.0.1', '[::1]'].includes(hostname) &&
      Boolean(parsed.port) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, 'designated disposable PostgreSQL target on an explicit nondefault loopback port required');
    const current = `${hostname}:${port}/${database}`;
    target ??= current;
    assert.equal(current, target, 'all three roles must use the same disposable database');
    validated[role] = value;
  }
  return validated;
}

export async function healthClockDatabases() {
  const urls = disposableRoleTargets();
  const migrator = createSaasDatabase({ connectionString: urls.migrator, max: 2 });
  const control = createSaasDatabase({ connectionString: urls.control_plane, max: 1 });
  const gateway = createSaasDatabase({ connectionString: urls.gateway, max: 4 });
  const databases = [migrator, control, gateway];
  try {
    for (const [index, expected] of ['migrator', 'control_plane', 'gateway'].entries()) {
      const current = databases[index];
      assert.ok(current);
      const identity = await current.query<{ role: string; session: string; superuser: boolean; version: string }>(
        `SELECT current_user AS role, session_user AS session, r.rolsuper AS superuser,
                current_setting('server_version_num') AS version FROM pg_roles r WHERE rolname = current_user`,
      );
      assert.equal(identity.rows[0]?.role, `model_router_saas_${expected}`);
      assert.equal(identity.rows[0]?.session, `model_router_saas_${expected}`);
      assert.equal(identity.rows[0]?.superuser, false);
      assert.ok([15, 18].includes(Math.floor(Number(identity.rows[0]?.version) / 10_000)));
    }
    await migrator.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    return { databases, migrator, gateway };
  } catch (error) {
    await Promise.allSettled(databases.map((database) => database.close()));
    throw error;
  }
}

export function healthClockSqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : undefined;
}

export function safeHealthClockFailure(error: unknown): Error {
  if (error instanceof assert.AssertionError) return error;
  const state = healthClockSqlState(error);
  return new Error(`Runtime health clock PostgreSQL operation failed${state ? ` (${state})` : ''}; details redacted`);
}

type Lease = { attemptId: string; fencingToken: string; slot: number };
type Fixture = { candidate: ProviderAccountRuntimeHealthCandidate; leases: [Lease, Lease, Lease] };
type WriteInput = Parameters<PostgresProviderAccountRuntimeHealthStore['recordRuntimeOutcome']>[0];
type WriteObservation = { selectedStatements: number; sqlStates: string[] };
const success = { source: 'gateway', result: 'success' } as const;
const networkFailure = { source: 'gateway', result: 'retryable_failure', failureKind: 'network' } as const;

function recordInput(fixture: Fixture, lease: Lease, evidence: ProviderAccountRuntimeHealthEvidence): WriteInput {
  return { candidate: fixture.candidate, attemptId: lease.attemptId, fencingToken: lease.fencingToken, evidence };
}

function scopedDatabase(database: SaasDatabase, transaction: SaasDatabase['transaction']): SaasDatabase {
  return {
    query: database.query.bind(database),
    transaction,
    migrate: database.migrate.bind(database),
    verifySchema: database.verifySchema.bind(database),
    ping: database.ping.bind(database),
    close: database.close.bind(database),
  };
}

function observedExecutor(tx: SqlExecutor, input: WriteInput, observation: WriteObservation): SqlExecutor {
  const expected = [
    input.candidate.tenantId,
    'platform',
    null,
    input.candidate.accountId,
    input.candidate.upstreamId,
    input.attemptId,
    input.fencingToken,
    'platform',
    input.evidence.result === 'success' ? 'healthy' : 'cooldown',
    input.evidence.result === 'success' ? 'gateway_success' : 'gateway_network_failure',
  ];
  return {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      assert.equal(hash(sql), HEALTH_CLOCK_WRITE_SQL_SHA256, 'only the exact current production health statement');
      assert.deepEqual(values, expected, 'all ten original account, lease, scope and outcome bindings must match');
      observation.selectedStatements++;
      try {
        return await tx.query<Row>(sql, values);
      } catch (error) {
        // Capture only the fixed SQLSTATE before the public writer deliberately
        // replaces the database error. Original rows, error text and SQL stay out.
        const state = healthClockSqlState(error);
        if (state) observation.sqlStates.push(state);
        throw error;
      }
    },
  };
}

function observedStore(database: SaasDatabase, input: WriteInput, observation: WriteObservation) {
  return new PostgresProviderAccountRuntimeHealthStore({
    database: scopedDatabase(database, (work) =>
      database.transaction((tx) => work(observedExecutor(tx, input, observation))),
    ),
  });
}

async function seedFixture(migrator: SaasDatabase, gateway: SaasDatabase, future = false): Promise<Fixture> {
  const tenantId = randomUUID();
  assert.equal(
    (
      await migrator.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [
        tenantId,
        `health-clock-${tenantId}`,
      ])
    ).rowCount,
    1,
  );
  const candidate: ProviderAccountRuntimeHealthCandidate = {
    tenantId,
    accountId: `health-clock-account-${randomUUID()}`,
    upstreamId: `health-clock-upstream-${randomUUID()}`,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
  };
  const leases: Lease[] = [];
  for (const slot of [0, 1, 2]) {
    const attemptId = randomUUID();
    const result = await migrator.query<{ fencing_token: string; slot: number; held: boolean }>(
      `INSERT INTO saas_provider_account_leases
         (id, tenant_id, owner_kind, owner_tenant_id, account_id, upstream_id, attempt_id, slot, lease_expires_at)
       VALUES ($1, $2, 'platform', NULL, $3, $4, $5, $6, clock_timestamp() + interval '5 minutes')
       RETURNING fencing_token::text, slot, status = 'held' AND lease_expires_at > clock_timestamp() AS held`,
      [`health-clock-lease-${randomUUID()}`, tenantId, candidate.accountId, candidate.upstreamId, attemptId, slot],
    );
    const row = result.rows[0];
    assert.equal(result.rows.length, 1);
    assert.ok(row);
    assert.equal(row.slot, slot);
    assert.equal(row.held, true);
    assert.match(row.fencing_token, /^[1-9][0-9]*$/);
    leases.push({ attemptId, fencingToken: row.fencing_token, slot });
  }
  const [f0, f1, f2] = leases;
  assert.ok(f0 && f1 && f2);
  assert.ok(BigInt(f0.fencingToken) < BigInt(f1.fencingToken));
  assert.ok(BigInt(f1.fencingToken) < BigInt(f2.fencingToken));
  const fixture: Fixture = { candidate, leases: [f0, f1, f2] };
  if (future) {
    // Independent synthetic future history; no UPDATE guard or trigger is
    // altered. A real newer lease must still fail to move this row backwards.
    assert.equal(
      (
        await migrator.query(
          `INSERT INTO saas_provider_account_runtime_health
           (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
            observed_at, cooldown_until, last_outcome, source_fencing_token, revision, health_score)
         VALUES ('platform', 'platform', NULL, $1, 'healthy', 0,
                 clock_timestamp() + interval '10 minutes', NULL, 'gateway_success', $2::bigint, 1, 1.000)`,
          [candidate.accountId, f0.fencingToken],
        )
      ).rowCount,
      1,
    );
  } else {
    const input = recordInput(fixture, f0, success);
    const observation: WriteObservation = { selectedStatements: 0, sqlStates: [] };
    assert.equal(await observedStore(gateway, input, observation).recordRuntimeOutcome(input), 'applied');
    assert.equal(observation.selectedStatements, 1);
    assert.deepEqual(observation.sqlStates, []);
  }
  return fixture;
}

async function readHealth(executor: SqlExecutor, fixture: Fixture) {
  const result = await executor.query<{
    full_row: string;
    state: string;
    failure_count: number;
    observed_us: string;
    cooldown_us: string | null;
    cooldown_duration_us: string | null;
    source_fencing_token: string;
    revision: string;
    health_score: string | null;
    half_open_is_null: boolean;
  }>(
    `SELECT to_jsonb(health)::text AS full_row, state, failure_count,
            (extract(epoch FROM observed_at) * 1000000)::bigint::text AS observed_us,
            (extract(epoch FROM cooldown_until) * 1000000)::bigint::text AS cooldown_us,
            (extract(epoch FROM cooldown_until - observed_at) * 1000000)::bigint::text AS cooldown_duration_us,
            source_fencing_token::text, revision::text, health_score::text,
            half_open_probe_at IS NULL AS half_open_is_null
       FROM saas_provider_account_runtime_health AS health
      WHERE owner_scope_key = 'platform' AND owner_kind = 'platform' AND account_id = $1`,
    [fixture.candidate.accountId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  return {
    digest: hash(row.full_row),
    state: row.state,
    failureCount: row.failure_count,
    observedUs: BigInt(row.observed_us),
    cooldownUs: row.cooldown_us === null ? null : BigInt(row.cooldown_us),
    cooldownDurationUs: row.cooldown_duration_us === null ? null : BigInt(row.cooldown_duration_us),
    token: row.source_fencing_token,
    revision: BigInt(row.revision),
    score: row.health_score,
    halfOpenIsNull: row.half_open_is_null,
  };
}

async function databaseClock(executor: SqlExecutor): Promise<bigint> {
  const result = await executor.query<{ clock_us: string }>(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS clock_us',
  );
  const row = result.rows[0];
  assert.equal(result.rows.length, 1);
  assert.ok(row);
  return BigInt(row.clock_us);
}

async function backendPid(executor: SqlExecutor): Promise<number> {
  const result = await executor.query<{ pid: number; role: string; isolation: string }>(
    `SELECT pg_backend_pid() AS pid, current_user AS role,
            current_setting('transaction_isolation') AS isolation`,
  );
  const row = result.rows[0];
  assert.equal(result.rows.length, 1);
  assert.ok(row && Number.isSafeInteger(row.pid) && row.pid > 0);
  assert.equal(row.role, 'model_router_saas_gateway');
  assert.equal(row.isolation, 'read committed');
  return row.pid;
}

function signal<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function confirmWaiterBlocked(observer: SaasDatabase, holder: number, waiter: number): Promise<bigint> {
  assert.notEqual(holder, waiter, 'H and the actual W executor must be different backends');
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ observer: number; blocked: boolean }>(
      'SELECT pg_backend_pid() AS observer, $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
      [holder, waiter],
    );
    const row = result.rows[0];
    assert.equal(result.rows.length, 1);
    assert.ok(row);
    assert.notEqual(row.observer, holder, 'the observer must use a third backend');
    assert.notEqual(row.observer, waiter, 'the observer must use a third backend');
    if (row.blocked) return databaseClock(observer);
    // Elapsed time never establishes blocking; poll the real server predicate.
    await delay(10);
  }
  assert.fail('the actual health UPSERT W must observably wait on H');
}

export async function proveRuntimeHealthWaitClock(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  outcome: 'success' | 'network-failure',
) {
  const fixture = await seedFixture(migrator, gateway);
  const before = await readHealth(migrator, fixture);
  assert.equal(before.revision, 1n);
  assert.equal(before.state, 'healthy');
  assert.equal(before.score, '1.000');
  const evidence = outcome === 'success' ? success : networkFailure;
  const holderInput = recordInput(fixture, fixture.leases[1], evidence);
  const waiterInput = recordInput(fixture, fixture.leases[2], evidence);
  const holderObservation: WriteObservation = { selectedStatements: 0, sqlStates: [] };
  const waiterObservation: WriteObservation = { selectedStatements: 0, sqlStates: [] };
  const holderLocked = signal<number>();
  const allowHolderWrite = signal<void>();
  const waiterBackend = signal<number>();
  const holder = gateway.transaction(async (tx) => {
    const pid = await backendPid(tx);
    assert.equal(
      (
        await tx.query(
          `SELECT account_id FROM saas_provider_account_runtime_health
          WHERE owner_scope_key = 'platform' AND owner_kind = 'platform' AND account_id = $1 FOR UPDATE`,
          [fixture.candidate.accountId],
        )
      ).rows.length,
      1,
    );
    holderLocked.resolve(pid);
    await allowHolderWrite.promise;
    const store = new PostgresProviderAccountRuntimeHealthStore({
      // H's public API joins this already-open real RC transaction. No nested
      // BEGIN, copied health SQL, fabricated result, or extra lock framework.
      database: scopedDatabase(gateway, (work) => work(observedExecutor(tx, holderInput, holderObservation))),
    });
    assert.equal(await store.recordRuntimeOutcome(holderInput), 'applied');
    const row = await readHealth(tx, fixture);
    const afterWriteUs = await databaseClock(tx);
    assert.equal(row.revision, before.revision + 1n);
    assert.ok(row.token === fixture.leases[1].fencingToken);
    if (outcome === 'network-failure') {
      assert.equal(row.failureCount, 1);
      assert.equal(row.score, '0.800');
      assert.equal(row.cooldownDurationUs, 1_000_000n);
    }
    return { row, afterWriteUs };
  });
  // Attach a rejection handler immediately so an unexpected fixture error is
  // handled before the main orchestration awaits this actor's completion.
  const held = holder.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, state: healthClockSqlState(error) ?? 'unclassified' }),
  );
  let waiter:
    | Promise<
        | { result: 'applied' | 'stale'; publicCode: null }
        | { result: null; publicCode: 'INVALID_INPUT' | 'STORAGE_ERROR' | 'other' }
      >
    | undefined;
  try {
    const holderPid = await Promise.race([
      holderLocked.promise,
      held.then(() => assert.fail('H must reach the real row-lock barrier')),
    ]);
    const database = scopedDatabase(gateway, (work) =>
      gateway.transaction(async (tx) => {
        const pid = await backendPid(tx);
        waiterBackend.resolve(pid);
        return work(observedExecutor(tx, waiterInput, waiterObservation));
      }),
    );
    waiter = new PostgresProviderAccountRuntimeHealthStore({ database }).recordRuntimeOutcome(waiterInput).then(
      (result) => ({ result, publicCode: null }),
      (error: unknown) => ({
        result: null,
        publicCode: error instanceof ProviderAccountRuntimeHealthStoreError ? error.code : 'other',
      }),
    );
    const waiterPid = await Promise.race([
      waiterBackend.promise,
      waiter.then(() => assert.fail('W must expose its actual transaction backend before writing')),
    ]);
    const blockedClockUs = await confirmWaiterBlocked(migrator, holderPid, waiterPid);
    assert.equal(waiterObservation.selectedStatements, 1, 'the blocked W must have submitted the exact source SQL');
    allowHolderWrite.resolve(undefined);
    const completedHolder = await held;
    assert.equal(completedHolder.ok, true, 'H must commit its real lower-token API write');
    if (!completedHolder.ok) assert.fail('H fixture failed');
    assert.ok(completedHolder.value.row.observedUs >= blockedClockUs);
    const completedWaiter = await waiter;
    // On the unfixed writer this prints only safe result/code/SQLSTATE enums:
    // actual 55000 was captured before the public writer erased the DB error.
    assert.deepEqual(
      { ...completedWaiter, sqlStates: waiterObservation.sqlStates },
      { result: 'applied', publicCode: null, sqlStates: [] },
      'the higher-token waiter must apply after acquiring the row lock, not fail on a pre-lock timestamp',
    );
    const upperClockUs = await databaseClock(migrator);
    const after = await readHealth(migrator, fixture);
    assert.equal(holderObservation.selectedStatements, 1);
    assert.deepEqual(holderObservation.sqlStates, []);
    assert.equal(waiterObservation.selectedStatements, 1);
    assert.ok(after.token === fixture.leases[2].fencingToken);
    assert.equal(after.revision, before.revision + 2n);
    assert.ok(after.observedUs >= completedHolder.value.afterWriteUs, 'W observation must be sampled after H wrote');
    assert.ok(after.observedUs <= upperClockUs, 'W observation must remain inside the exact DB clock bracket');
    assert.equal(after.halfOpenIsNull, true);
    if (outcome === 'success') {
      assert.equal(after.state, 'healthy');
      assert.equal(after.failureCount, 0);
      assert.equal(after.score, '1.000');
      assert.equal(after.cooldownUs, null);
      assert.equal(after.cooldownDurationUs, null);
    } else {
      assert.equal(after.state, 'cooldown');
      assert.equal(after.failureCount, 2);
      assert.equal(after.score, '0.640', 'exactly one EMA vote per accepted API write');
      assert.equal(after.cooldownDurationUs, 2_000_000n);
      assert.equal(after.cooldownUs, after.observedUs + 2_000_000n, 'cooldown must share the exact observation clock');
    }
    const replayObservation: WriteObservation = { selectedStatements: 0, sqlStates: [] };
    assert.equal(
      await observedStore(gateway, holderInput, replayObservation).recordRuntimeOutcome(holderInput),
      'stale',
    );
    assert.equal(replayObservation.selectedStatements, 1);
    assert.deepEqual(replayObservation.sqlStates, []);
    assert.equal(
      (await readHealth(migrator, fixture)).digest,
      after.digest,
      'older F1 must leave the entire row unchanged',
    );
  } finally {
    allowHolderWrite.resolve(undefined);
    await Promise.allSettled([held, ...(waiter ? [waiter] : [])]);
  }
}

export async function proveRuntimeHealthFutureRejected(migrator: SaasDatabase, gateway: SaasDatabase) {
  const fixture = await seedFixture(migrator, gateway, true);
  const before = await readHealth(migrator, fixture);
  assert.ok(before.observedUs > (await databaseClock(migrator)) + 300_000_000n);
  const input = recordInput(fixture, fixture.leases[1], success);
  const observation: WriteObservation = { selectedStatements: 0, sqlStates: [] };
  const store = observedStore(gateway, input, observation);
  await assert.rejects(store.recordRuntimeOutcome(input), (error: unknown) => {
    assert.ok(error instanceof ProviderAccountRuntimeHealthStoreError);
    assert.equal(error.code, 'STORAGE_ERROR');
    assert.deepEqual(observation.sqlStates, ['55000']);
    return true;
  });
  assert.equal(observation.selectedStatements, 1);
  assert.equal(
    (await readHealth(migrator, fixture)).digest,
    before.digest,
    'future history must not be clamped or changed',
  );
}

export async function proveRuntimeHealthGuard(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  invalid: 'backward-time' | 'non-increasing-token' | 'revision-jump',
) {
  const fixture = await seedFixture(migrator, gateway);
  if (invalid === 'non-increasing-token') {
    const input = recordInput(fixture, fixture.leases[1], success);
    const observation: WriteObservation = { selectedStatements: 0, sqlStates: [] };
    assert.equal(await observedStore(gateway, input, observation).recordRuntimeOutcome(input), 'applied');
  }
  const before = await readHealth(migrator, fixture);
  const variants = invalid === 'non-increasing-token' ? ['equal', 'older'] : [invalid];
  for (const variant of variants) {
    const assignments =
      invalid === 'backward-time'
        ? "observed_at = observed_at - interval '1 microsecond', source_fencing_token = $2::bigint, revision = revision + 1"
        : invalid === 'revision-jump'
          ? 'source_fencing_token = $2::bigint, revision = revision + 2'
          : 'source_fencing_token = $2::bigint, revision = revision + 1';
    const token =
      invalid === 'non-increasing-token'
        ? variant === 'equal'
          ? before.token
          : fixture.leases[0].fencingToken
        : fixture.leases[2].fencingToken;
    await assert.rejects(
      gateway.transaction((tx) =>
        tx.query(
          `UPDATE saas_provider_account_runtime_health SET ${assignments}
            WHERE owner_scope_key = 'platform' AND owner_kind = 'platform' AND account_id = $1`,
          [fixture.candidate.accountId, token],
        ),
      ),
      (error: unknown) => {
        assert.equal(healthClockSqlState(error), '55000');
        return true;
      },
    );
    assert.equal(
      (await readHealth(migrator, fixture)).digest,
      before.digest,
      'guard failure must roll back the entire row',
    );
  }
}
