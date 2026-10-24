import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { preservedFinancialFacts } from './postgres-saas-recovery-profile.mjs';
import { readSaasRecoveryAuthority } from './redis-saas-recovery-profile.mjs';

/**
 * C2 §9: independent synchronous standby recovery drill.
 *
 * A streaming-replication standby (pg_basebackup -R) runs with
 * synchronous_standby_names so every synchronous_commit is flushed to the
 * independent copy before the primary acknowledges. After a confirmed
 * financial commit (settled request + usage + settlement + ledger), the
 * drill crashes the primary (pg_ctl -m immediate), promotes the standby, and
 * verifies the last confirmed financial commit recovers from the independent
 * copy alone. This is failover evidence for confirmed commits only: it does
 * not claim PITR, async-replica zero loss, HA automation, or production KMS.
 */

export function validateStandbyRecoveryProfile(options) {
  if (!options.standbyRecoveryProfile) return;
  assert.ok(options.diagnostic && options.noBuild && !options.serialProfile && !options.capProfile &&
    !options.recoveryProfile && !options.postgresRecoveryProfile && !options.requestSamples,
    '--standby-recovery-profile requires --diagnostic --no-build and excludes serial/cap/Redis recovery/PG recovery/request samples');
}

export async function runPostgresSaasStandbyRecoveryProfile({
  pgBin, primaryDataDir, primaryPort, databaseName, primaryRoleUrl, createDatabaseAt, requireRun,
  freePort, getDatabase, seed, gatewayUrls, controlUrl, outputDir, signal, beforeStopPrimary,
}) {
  const check = () => signal?.throwIfAborted();
  const httpSignal = (milliseconds) => signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
  const startedAt = Date.now();
  const evidence = { schema: 1, profile: 'postgres-saas-sync-standby-recovery', performanceAcceptance: false,
    builtinAcceptance: false, pitrVerified: false, asyncReplicaLossTested: false, automationFree: true,
    syntheticLoopback: true, realProviderCalls: 0, ok: false, stage: 'initial' };
  const standbyDir = join(outputDir, 'standby-data');
  const standbyLog = join(outputDir, 'standby-postgres.log');
  let standbyPort;
  let standbyDatabase;
  const progress = async (stage, details = {}) => {
    check(); evidence.stage = stage;
    const row = { schema: 1, stage, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...details };
    await writeFile(join(outputDir, 'standby-recovery-progress.json'), `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
    console.log(`PostgreSQL standby recovery progress: ${JSON.stringify(row)}`);
  };
  const until = async (label, work, milliseconds = 60000, pollMs = 500) => {
    const deadline = Date.now() + milliseconds;
    do {
      check();
      const result = await work();
      if (result) return result;
      await delay(pollMs, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error(`PostgreSQL standby recovery observation deadline: ${label}`);
  };
  const standbyRoleUrl = (port) => `postgresql://model_router_saas_migrator@127.0.0.1:${port}/${databaseName}?sslmode=disable`;
  const control = async (path, body) => {
    check(); const response = await fetch(`${controlUrl}/__control/${path}`, { method: 'POST', signal: httpSignal(5000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await response.body?.cancel(); assert.equal(response.status, 200);
  };
  const send = (key) => fetch(`${gatewayUrls[0]}${seed.inventory[0].endpoint}`, { method: 'POST', signal: httpSignal(90000),
    headers: { authorization: `Bearer ${seed.key}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ model: seed.inventory[0].publicModel, max_tokens: 64, stream: false,
      messages: [{ role: 'user', content: 'owned PostgreSQL sync standby drill' }] }) });
  const primaryObserver = { query: async (sql, values) => {
    check();
    return getDatabase().transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY'); await tx.query('SET LOCAL statement_timeout = 5000');
      return tx.query(sql, values);
    });
  } };
  const databaseObserver = (database) => ({ query: async (sql, values) => {
    check();
    return database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY'); await tx.query('SET LOCAL statement_timeout = 5000');
      return tx.query(sql, values);
    });
  } });
  const primaryPortNumber = Number(primaryPort);
  let standbyStopped = false;
  const stopStandby = async (label) => {
    if (standbyStopped) return;
    standbyStopped = true;
    try { await requireRun(label, join(pgBin, 'pg_ctl'), ['-D', standbyDir, '-w', '-m', 'immediate', 'stop'], 30000); }
    catch { /* cleanup must never mask the first failure */ }
  };
  try {
    check();
    await mkdir(standbyDir, { recursive: false, mode: 0o700 }).catch(() => { throw new Error('standby data directory must be absent'); });
    await progress('standby-basebackup');
    await control('reset', {}); await control('shape', { chunks: 2, chunkDelayMs: 0 });
    await requireRun('standby-basebackup', join(pgBin, 'pg_basebackup'),
      ['-D', standbyDir, '-R', '--wal-method=stream', '--host', '127.0.0.1', '--port', String(primaryPortNumber), '-U', 'postgres'],
      // The backup start checkpoint can take minutes under host load; the
      // timeout must not race the checkpoint itself.
      600000);
    // pg_basebackup inherits the caller umask for the target directory; the
    // PostgreSQL server refuses anything looser than 0750.
    await chmod(standbyDir, 0o700);
    await progress('standby-start');
    standbyPort = await freePort();
    await requireRun('standby-start', join(pgBin, 'pg_ctl'),
      ['-D', standbyDir, '-l', standbyLog, '-w', '-o', `-h 127.0.0.1 -p ${standbyPort} -c unix_socket_directories= -c hot_standby=on`, 'start'], 30000);
    standbyDatabase = createDatabaseAt(standbyRoleUrl(standbyPort));
    await progress('standby-sync-registration');
    // '*' accepts any connected standby as the synchronous replica; the
    // drill owns exactly one, so synchronous_commit flushes to it before the
    // primary acknowledges every commit. ALTER SYSTEM is a superuser-only
    // statement and cannot run inside a transaction block, so it goes through
    // a short-lived superuser pool, never the migrator observer.
    const superuserDatabase = createDatabaseAt(`postgresql://postgres@127.0.0.1:${primaryPortNumber}/${databaseName}?sslmode=disable`);
    try {
      await superuserDatabase.query("ALTER SYSTEM SET synchronous_standby_names = '*'");
      await superuserDatabase.query('SELECT pg_reload_conf()');
      await until('standby registered as synchronous', async () => {
        // pg_stat_replication's state/sync_state columns are visible only to
        // superusers (pg_read_all_stats); the migrator observer would see
        // masked NULLs, so the registration check uses the superuser pool.
        const rows = (await superuserDatabase.query(
          'SELECT sync_state,application_name,state FROM pg_stat_replication')).rows;
        // Persist the observed rows on every poll so a deadline failure still
        // carries the actual replication state as evidence.
        evidence.replicationRows = rows;
        // '*' configures the quorum method (PG10+): one standby in quorum means
        // every synchronous_commit waits for its flush. Accept the sync or
        // quorum label — both are synchronous replication.
        return rows.length === 1 && ['sync', 'quorum'].includes(rows[0].sync_state);
      }, 90000);
    } finally {
      await superuserDatabase.close().catch(() => {});
    }
    const standbyInRecovery = (await databaseObserver(standbyDatabase).query('SELECT pg_is_in_recovery() AS in_recovery')).rows[0];
    assert.equal(standbyInRecovery.in_recovery, true, 'the standby must still be in recovery mode');
    await progress('confirmed-financial-commit');
    const commitKey = `standby-drill-commit-${randomUUID()}`;
    const response = await send(commitKey);
    assert.equal(response.status, 200, 'the confirmed-commit request must succeed');
    const requestId = response.headers.get('x-request-id'); assert.ok(requestId);
    await response.text();
    await until('confirmed commit settles', async () => {
      const rows = (await primaryObserver.query(
        'SELECT execution_state,financial_status FROM saas_requests WHERE tenant_id=$1 AND id=$2', [seed.tenantId, requestId])).rows;
      return rows[0]?.execution_state === 'succeeded' && rows[0]?.financial_status === 'settled';
    });
    const before = await readSaasRecoveryAuthority(primaryObserver, seed.tenantId);
    const committed = before.requests.find((row) => row.id === requestId);
    assert.equal(committed?.execution, 'succeeded'); assert.equal(committed?.financial, 'settled');
    assert.ok(before.settlement_facts.filter((row) => row.requestId === requestId).length === 1,
      'the confirmed commit must carry exactly one settlement');
    assert.ok(before.usage_facts.filter((row) => row.requestId === requestId).length === 1,
      'the confirmed commit must carry exactly one usage fact');
    evidence.confirmedCommit = { requestId, key: commitKey };
    evidence.beforeFailover = before;
    await progress('standby-replay-verification');
    const onStandby = await readSaasRecoveryAuthority(databaseObserver(standbyDatabase), seed.tenantId);
    assert.deepEqual(preservedFinancialFacts(onStandby), preservedFinancialFacts(before),
      'the synchronous standby must have replayed the confirmed financial commit before failover');
    const standbyCommitted = onStandby.requests.find((row) => row.id === requestId);
    assert.equal(standbyCommitted?.execution, 'succeeded'); assert.equal(standbyCommitted?.financial, 'settled');
    await progress('primary-immediate-stop');
    check();
    if (beforeStopPrimary) await beforeStopPrimary();
    await requireRun('standby-drill-primary-immediate-stop', join(pgBin, 'pg_ctl'),
      ['-D', primaryDataDir, '-w', '-m', 'immediate', 'stop'], 30000);
    evidence.primaryStopped = true;
    await progress('standby-promote');
    await requireRun('standby-drill-promote', join(pgBin, 'pg_ctl'), ['-D', standbyDir, '-w', 'promote'], 30000);
    await standbyDatabase.close().catch(() => {});
    standbyDatabase = undefined;
    const promotedDatabase = createDatabaseAt(standbyRoleUrl(standbyPort));
    await until('promoted standby accepts writes', async () => {
      try {
        const rows = (await databaseObserver(promotedDatabase).query('SELECT pg_is_in_recovery() AS in_recovery')).rows;
        return rows[0]?.in_recovery === false;
      } catch { return false; }
    });
    await progress('independent-recovery-verification');
    const recovered = await readSaasRecoveryAuthority(databaseObserver(promotedDatabase), seed.tenantId);
    assert.deepEqual(preservedFinancialFacts(recovered), preservedFinancialFacts(before),
      'the last confirmed financial commit must recover from the promoted standby alone');
    const recoveredCommit = recovered.requests.find((row) => row.id === requestId);
    assert.equal(recoveredCommit?.execution, 'succeeded'); assert.equal(recoveredCommit?.financial, 'settled');
    assert.equal(recovered.settlement_facts.filter((row) => row.requestId === requestId).length, 1);
    assert.equal(recovered.usage_facts.filter((row) => row.requestId === requestId).length, 1);
    const identityRows = (await databaseObserver(promotedDatabase).query(`SELECT current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS synchronous_commit, current_setting('server_version_num') AS version`)).rows[0];
    assert.equal(identityRows.fsync, 'on'); assert.equal(identityRows.synchronous_commit, 'on');
    evidence.afterPromotion = recovered;
    evidence.promotedIdentity = identityRows;
    evidence.elapsedMs = Date.now() - startedAt;
    evidence.ok = true;
    await progress('complete');
    await promotedDatabase.close().catch(() => {});
    await stopStandby('standby-drill-stop');
    return evidence;
  } finally {
    if (standbyDatabase) await standbyDatabase.close().catch(() => {});
    await stopStandby('standby-drill-finally-stop');
    await writeFile(join(outputDir, 'standby-recovery.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
}
