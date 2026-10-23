import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../src/saas/db/index.js';
import type { SqlExecutor } from '../../src/saas/db/types.js';
import { PlatformWalletLedgerService } from '../../src/saas/billing/service.js';
import { SaasMeteringService } from '../../src/saas/metering/service.js';
import { DurableNormalSuccessSettlementPort } from '../../src/saas/metering/conditional-settlement-port.js';
import { startPgCommitAckLossProxy } from './helpers/pg-commit-ack-loss-proxy.js';
import {
  anyRoleConfigured,
  FIN057_FIXTURE_HMAC_HEX,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../saas/metering/normal-success-postgres-fixture.js';

// FIN-01 F3 crash cell (A3, base script shared with Track I): a real child
// process settles prepared requests through the conditional settlement port,
// is SIGKILLed mid-flight, and a second child re-attempts every input. The
// proof is exactly-once: each request settles once, replays add nothing, the
// wallet projection equals the ledger and every transaction stays balanced.
const CHILD = 'scripts/drills/settlement-crash-child.mjs';
const REQUESTS = 4;

interface Marker {
  readonly runId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly kind: string;
}

function markers(progressPath: string): Marker[] {
  let text: string;
  try {
    text = readFileSync(progressPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Marker);
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function spawnChild(root: string, gatewayUrl: string, inputsPath: string, progressPath: string, runId: string, pauseBeforeMarker = false) {
  // Fixed minimal env: no inherited credentials, PG overrides or user config.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, '--inputs', inputsPath, '--progress', progressPath, '--run-id', runId, ...(pauseBeforeMarker ? ['--pause-before-marker', '2'] : [])],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'test',
        MODEL_ROUTER_SAAS_DRILL_GATEWAY_URL: gatewayUrl,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  // The child never prints URLs/secrets by contract; drain stderr regardless.
  child.stderr?.resume();
  const exit = new Promise<ChildExit>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const barrier = new Promise<unknown>(resolveBarrier => child.once('message', resolveBarrier));
  return { child, exit, barrier };
}

async function untilMarkers(progressPath: string, count: number, childExit: Promise<ChildExit>): Promise<Marker[]> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = markers(progressPath);
    if (found.length >= count) return found;
    const raced = await Promise.race([
      childExit.then((exit) => ({ exit }) as const),
      new Promise<undefined>((resolvePoll) => setTimeout(() => resolvePoll(undefined), 25)),
    ]);
    if (raced && 'exit' in raced) {
      throw new Error(`drill child exited before ${count} committed markers`);
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for committed settlement markers');
  }
}

async function boundedExit<T>(exit: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('drill child did not exit within the bounded deadline')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertSettledOnce(migrator: SqlExecutor, tenantId: string): Promise<void> {
  await phase('snapshot', async () => {
    const row = (
      await migrator.query<{
        usage: string;
        settlements: string;
        billingTransactions: string;
        entries: string;
        balance: string;
        walletLedger: string;
        unbalanced: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1) AS usage,
          (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1) AS settlements,
          (SELECT count(*)::text FROM saas_ledger_transactions
             WHERE tenant_id = $1 AND source_type = 'billing_settlement') AS "billingTransactions",
          (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS entries,
          (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
          (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
             FROM saas_ledger_entries WHERE tenant_id = $1 AND wallet_id IS NOT NULL) AS "walletLedger",
          (SELECT count(*)::text FROM (
             SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
              WHERE l.tenant_id = $1 GROUP BY l.id, l.amount_minor_units
              HAVING count(e.id) <> 2 OR
                COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
                COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
           ) invalid) AS unbalanced`,
        [tenantId],
      )
    ).rows[0];
    assert.ok(row);
    assert.equal(row.usage, '1', 'each crashed request records exactly one usage event');
    assert.equal(row.settlements, '1', 'each crashed request settles exactly once');
    assert.equal(row.billingTransactions, '1', 'exactly one settlement ledger transaction');
    assert.equal(row.entries, '4', 'reservation + settlement balanced pairs only');
    assert.equal(row.balance, '88', 'funded 100 minus the single 12 charge');
    assert.equal(row.balance, row.walletLedger, 'wallet projection equals the ledger');
    assert.equal(row.unbalanced, '0');
  });
}

test('FIN-01 F3: SIGKILL mid-settlement never double-charges; restart replays to exactly-once', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require the crash drill`
      : false,
  timeout: 300_000,
  concurrency: false,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const root = resolve(process.cwd());
  const migrator = observedDatabase(urls[0]);
  const controlPlane = observedDatabase(urls[1]);
  const gateway = observedDatabase(urls[2]);
  const scratch = mkdtempSync(join(tmpdir(), 'fin01-crash-drill-'));
  t.after(async () => {
    await phase('cleanup', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([gateway.database.close(), controlPlane.database.close(), migrator.database.close()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('crash-drill cleanup deadline')), 30_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      rmSync(scratch, { recursive: true, force: true });
    });
  });
  await phase('readiness', async () => {
    await migrator.database.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane.database, 'control_plane');
  });

  const fixtures = [];
  for (let index = 0; index < REQUESTS; index += 1) {
    fixtures.push(await seedFixture(migrator.database, gateway.database, 'platform'));
  }
  const inputsPath = join(scratch, 'inputs.json');
  const progressPath = join(scratch, 'progress.jsonl');
  writeFileSync(
    inputsPath,
    JSON.stringify({
      idempotencyHmacHex: FIN057_FIXTURE_HMAC_HEX,
      inputs: fixtures.map((fixture) => fixture.input),
    }),
  );

  // Run 1: observe the first marker, then kill at input 2's explicit
  // post-COMMIT/pre-marker IPC barrier.
  const first = spawnChild(root, urls[2], inputsPath, progressPath, 'run-1', true);
  t.after(() => {
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
  });
  const crashedAt = await untilMarkers(progressPath, 1, first.exit);
  // Child pauses only after input 2 really commits, before its financial marker.
  const barrier = await boundedExit(Promise.race([first.barrier, first.exit.then(() => { throw new Error('child exited before commit-to-marker barrier'); })]), 60_000);
  assert.deepEqual(barrier, { kind: 'before-marker', runId: 'run-1', sequence: 2, requestId: fixtures[1]!.input.requestId, resultKind: 'settled' });
  first.child.kill('SIGKILL');
  const crash = await boundedExit(first.exit, 15_000);
  assert.equal(crash.signal, 'SIGKILL', 'the drill child must die by the real signal, not gracefully');

  // Run 2: a fresh process re-attempts every input; the port must replay the
  // committed ones and settle the rest, each exactly once.
  const second = spawnChild(root, urls[2], inputsPath, progressPath, 'run-2');
  t.after(() => {
    if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill('SIGKILL');
  });
  const recovered = await boundedExit(second.exit, 120_000);
  assert.equal(recovered.signal, null);
  assert.equal(recovered.code, 0, 'recovery child must complete every input without an error');

  // PostgreSQL is the authority: SIGKILL may land after COMMIT but before
  // the child appends its marker. Prove exact financial effects before
  // classifying that unobserved-ack window as a legitimate replay.
  for (const fixture of fixtures) await assertSettledOnce(migrator.database, fixture.tenantId);

  const all = markers(progressPath);
  const runOne = all.filter(marker => marker.runId === 'run-1');
  const runTwo = all.filter(marker => marker.runId === 'run-2');
  assert.equal(all.length, runOne.length + runTwo.length, 'only the two owned child runs may append markers');
  assert.deepEqual(all.slice(0, runOne.length), runOne, 'first-run prefix must precede every recovery marker');
  assert.ok(runOne.length >= 1 && runOne.length <= REQUESTS, 'the killed run records a nonempty committed prefix');
  assert.equal(runTwo.length, REQUESTS, 'recovery must report exactly one terminal result per input');
  for (const [index, marker] of runOne.entries()) {
    assert.equal(marker.sequence, index + 1, 'killed-run markers form a contiguous prefix');
    assert.equal(marker.requestId, fixtures[index]!.input.requestId);
    assert.equal(marker.kind, 'settled', 'the first attempt cannot replay a fresh request');
  }
  let committedWithoutMarker = 0;
  for (const [index, fixture] of fixtures.entries()) {
    const requestId = fixture.input.requestId;
    const recovery = runTwo[index]!;
    assert.equal(recovery.sequence, index + 1);
    assert.equal(recovery.requestId, requestId, 'recovery reports the exact original input in order');
    assert.ok(['settled', 'replayed'].includes(recovery.kind));
    const firstMarkers = runOne.filter(marker => marker.requestId === requestId);
    assert.ok(firstMarkers.length <= 1, 'the first run reports each input at most once');
    const settledCount = all.filter(marker => marker.requestId === requestId && marker.kind === 'settled').length;
    assert.ok(settledCount <= 1, `request ${requestId} has at most one observed settlement acknowledgement`);
    if (firstMarkers.length === 1) {
      assert.equal(recovery.kind, 'replayed', 'an acknowledged first-run commit must replay');
      assert.equal(settledCount, 1);
    } else if (recovery.kind === 'settled') {
      assert.equal(settledCount, 1, 'an uncommitted input settles once in recovery');
    } else {
      assert.equal(settledCount, 0, 'a replay without a first marker is the COMMIT-to-marker crash window');
      committedWithoutMarker += 1;
    }
  }
  // The serial child can have only one committed input awaiting its marker.
  assert.equal(committedWithoutMarker, 1, 'the barrier must exercise exactly one committed input without a marker');
  assert.equal(runOne.length, 1);
  assert.equal(runTwo[1]!.kind, 'replayed', 'the commit paused before its marker must replay');
  for (const marker of runTwo.slice(2)) assert.equal(marker.kind, 'settled', 'inputs after the paused commit first settle in recovery');
  t.diagnostic(`kill window: ${crashedAt.length}/${REQUESTS} observed committed; ${committedWithoutMarker} committed before marker`);
});

async function commitAckSnapshot(executor: SqlExecutor, tenantId: string) {
  const rows = async (sql: string) => (await executor.query<Record<string, unknown>>(sql, [tenantId])).rows;
  const [requests, attempts, evidence, holds, usage, settlements, wallets, ledger, entries, leases, idempotency, capacity] = await Promise.all([
    rows('SELECT id,execution_state,reconciliation_state,financial_status,state_version FROM saas_requests WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT id,request_id,dispatch_state,result_state,response_started,state_version FROM saas_attempts WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT id,request_id,attempt_id,status,claimed_attempt_id,statement_sha256 FROM saas_prepared_request_evidence WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT * FROM saas_billing_reservations WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT * FROM saas_usage_events WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT * FROM saas_usage_settlements WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT id,currency,posted_balance_minor_units::text AS balance FROM saas_wallets WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT * FROM saas_ledger_transactions WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT * FROM saas_ledger_entries WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT id,attempt_id,status,fencing_token,lease_expires_at,released_at FROM saas_provider_account_leases WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT id,request_id,kind,key_digest,request_fingerprint FROM saas_idempotency_records WHERE tenant_id=$1 ORDER BY id'),
    rows('SELECT * FROM saas_gateway_capacity_reservations WHERE tenant_id=$1 ORDER BY request_id'),
  ]);
  return { requests, attempts, evidence, holds, usage, settlements, wallets, ledger, entries, leases, idempotency, capacity };
}

test('FIN-01 wire COMMIT ACK loss rejects the original native transaction while independent PG facts commit and exact-input replay writes nothing', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? `set ${REQUIRED_FLAG}=1 and three disposable local/CI role URLs` : false,
  timeout: 120000, concurrency: false,
}, async t => {
  const urls = roleUrls();
  const target = new URL(urls[2]);
  const migrator = observedDatabase(urls[0]);
  const gateway = observedDatabase(urls[2]);
  let proxy: Awaited<ReturnType<typeof startPgCommitAckLossProxy>> | undefined;
  let interrupted: ReturnType<typeof createSaasDatabase> | undefined;
  let restarted: ReturnType<typeof createSaasDatabase> | undefined;
  t.after(async () => {
    try {
      await proxy?.close();
    } finally {
      await boundedExit(Promise.allSettled([interrupted?.close(), restarted?.close(), gateway.database.close(), migrator.database.close()]), 15000);
    }
  });
  await migrator.database.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
  // Independent finance scope: never add this request to the SIGKILL marker
  // fixture above. Its dispatch is SQL-prepared, not a live provider call.
  const fixture = await seedFixture(migrator.database, gateway.database, 'platform');
  const observe = () => migrator.database.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    return commitAckSnapshot(tx, fixture.tenantId);
  });
  const before = await observe();
  assert.equal(before.wallets.length, 1); assert.equal(before.wallets[0]!.balance, '100');
  assert.equal(before.holds.length, 1); assert.equal(before.holds[0]!.state, 'reserved');
  assert.equal(String(before.holds[0]!.amount_minor_units), '50');
  assert.equal(before.usage.length, 0); assert.equal(before.settlements.length, 0);
  assert.equal(before.entries.length, 2); assert.equal(before.leases.length, 0);
  proxy = await startPgCommitAckLossProxy({ host: target.hostname, port: Number(target.port), database: decodeURIComponent(target.pathname.slice(1)) });
  const proxied = new URL(urls[2]);
  proxied.hostname = proxy.host; proxied.port = String(proxy.port); proxied.searchParams.set('sslmode', 'disable');
  interrupted = createSaasDatabase({ connectionString: proxied.toString(), max: 1, connectionTimeoutMillis: 5000 });
  const port = (database: ReturnType<typeof createSaasDatabase>) => new DurableNormalSuccessSettlementPort(database, {
    metering: new SaasMeteringService(database, { idempotencyHmacSecret: Uint8Array.from(Buffer.from(FIN057_FIXTURE_HMAC_HEX, 'hex')) }),
    billing: new PlatformWalletLedgerService(),
  });
  let nativeCommitRejected = false;
  await assert.rejects(boundedExit(port(interrupted).complete(fixture.input), 30000), error => {
    // Accept a real native transport failure, never a timeout/sentinel or a
    // resolved domain result such as reconciliation_pending.
    const socketError = error instanceof Error && (
      error.message === 'Connection terminated unexpectedly' || error.message === 'Connection terminated' ||
      ['ECONNRESET', 'EPIPE'].includes(String((error as NodeJS.ErrnoException).code))
    );
    nativeCommitRejected = socketError;
    return socketError;
  });
  assert.equal(nativeCommitRejected, true);
  assert.deepEqual(proxy.evidence(), { frontendCommitForwarded: true, serverCommitObserved: true, backendCommitForwarded: false, connectionCut: true });
  // This direct read-only connection is not the failed client and never
  // passes the wire proxy. PostgreSQL must prove that COMMIT really won.
  await assertSettledOnce(migrator.database, fixture.tenantId);
  const committed = await observe();
  assert.equal(committed.requests[0]!.execution_state, 'succeeded');
  assert.equal(committed.requests[0]!.financial_status, 'settled');
  assert.equal(committed.attempts[0]!.id, fixture.input.attemptId);
  assert.equal(committed.attempts[0]!.result_state, 'succeeded');
  assert.equal(committed.holds[0]!.id, fixture.input.reservationId);
  assert.equal(committed.holds[0]!.state, 'settled');
  assert.equal(String(committed.holds[0]!.settlement_amount_minor_units), '12');
  assert.ok(committed.holds[0]!.ledger_transaction_id);
  assert.equal(committed.wallets[0]!.balance, '88');
  assert.deepEqual(committed.evidence, before.evidence);
  assert.deepEqual(committed.leases, before.leases);
  restarted = createSaasDatabase({ connectionString: urls[2], max: 1, connectionTimeoutMillis: 5000 });
  const replay = await boundedExit(port(restarted).complete(fixture.input), 30000);
  assert.equal(replay.kind, 'replayed'); assert.equal(replay.attempt.id, fixture.input.attemptId);
  await assertSettledOnce(migrator.database, fixture.tenantId);
  assert.deepEqual(await observe(), committed, 'replay adds or mutates no financial, attempt, evidence, lease, capacity or idempotency fact');
  t.diagnostic(JSON.stringify({ boundary: 'owned-test-PG-wire-ACK-loss; SQL-prepared-dispatch; no live upstream or occupied-lease fault', nativeCommitRejected, ...proxy.evidence(), directObserverCommitted: true, exactInputReplayed: true, snapshotUnchanged: true }));
});
