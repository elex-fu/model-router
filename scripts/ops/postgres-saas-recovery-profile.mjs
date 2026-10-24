import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readSaasRecoveryAuthority, assertRecoverySettlementDelta } from './redis-saas-recovery-profile.mjs';

export function validatePostgresRecoveryProfile(options, tracingEnabled, cap) {
  if (!options.postgresRecoveryProfile) return;
  assert.ok(options.diagnostic && options.noBuild && !options.serialProfile && !options.capProfile && !options.recoveryProfile && !options.requestSamples && !options.standbyRecoveryProfile,
    '--postgres-recovery-profile requires --diagnostic --no-build and excludes serial/cap/Redis recovery/request samples');
  assert.ok(!tracingEnabled && cap === null, 'PostgreSQL recovery requires request tracing and ingress cap unset');
}

export function assertPostgresRestartIdentity(before, after) {
  for (const key of ['current_user', 'session_user', 'database', 'address', 'port', 'version', 'fsync', 'synchronous_commit']) {
    assert.equal(after[key], before[key], `same owned PostgreSQL identity/configuration: ${key}`);
  }
  assert.equal(after.fsync, 'on'); assert.equal(after.synchronous_commit, 'on');
  assert.notEqual(after.postmaster_start, before.postmaster_start);
}

export function preservedFinancialFacts(snapshot) {
  return { wallets: snapshot.wallets, ledger: snapshot.ledger, entries: snapshot.entries,
    usage: snapshot.usage, usage_facts: snapshot.usage_facts, settlements: snapshot.settlements,
    settlement_facts: snapshot.settlement_facts, budgets: snapshot.budgets, budget_reservations: snapshot.budget_reservations,
    holds: snapshot.holds.map(({ id, requestId, amount, settlement, ledgerTransactionId }) =>
      ({ id, requestId, amount, settlement, ledgerTransactionId })) };
}

export function assertUnknownPostgresAuthority(snapshot, details, original) {
  const requests = snapshot.requests.filter((row) => row.id === original.requestId);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].execution, 'unknown'); assert.equal(requests[0].financial, 'reconciliation_pending');
  assert.equal(requests[0].reconciliation, 'pending');
  const attempts = snapshot.attempts.filter((row) => row.requestId === original.requestId);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].id, original.attemptId);
  assert.equal(snapshot.evidence_facts.filter((row) => row.requestId === original.requestId).length, 1);
  assert.equal(snapshot.usage_facts.filter((row) => row.requestId === original.requestId).length, 0);
  assert.equal(snapshot.settlement_facts.filter((row) => row.requestId === original.requestId).length, 0);
  const hold = snapshot.holds.find((row) => row.requestId === original.requestId);
  assert.equal(hold?.state, 'reconciliation_pending'); assert.equal(hold?.id, original.holdId);
  assert.equal(hold?.amount, original.holdAmount); assert.equal(hold?.settlement, null); assert.equal(hold?.ledgerTransactionId, null);
  const reservation = snapshot.budget_reservations.find((row) => row.requestId === original.requestId);
  assert.equal(reservation?.state, 'outstanding'); assert.ok(BigInt(reservation.tokens) > 0n && BigInt(reservation.charge) > 0n);
  for (const key of ['requestId', 'lineage', 'day', 'state', 'tokens', 'charge']) {
    assert.equal(reservation[key], original.budgetReservation[key], `original outstanding budget fact: ${key}`);
  }
  const windows = snapshot.budgets.filter((row) => row.lineage === reservation.lineage);
  assert.equal(windows.length, 2);
  assert.equal(windows.filter((row) => row.window === 'daily' && row.day === reservation.day).length, 1);
  assert.equal(windows.filter((row) => row.window === 'lifetime' && row.day === '0001-01-01').length, 1);
  for (const row of windows) {
    assert.equal(row.tokensReserved, reservation.tokens); assert.equal(row.chargeReserved, reservation.charge);
  }
  assert.equal(details.cases.length, 1); assert.equal(details.cases[0].state, 'operator_required');
  assert.equal(details.cases[0].lastError, null);
  assert.equal(details.leases.length, 1); assert.equal(details.leases[0].id, original.leaseId);
  assert.equal(details.leases[0].fence, original.fence); assert.equal(details.leases[0].attemptId, original.attemptId);
  assert.equal(details.leases.filter((row) => row.liveHeld).length, 0);
  // Stored held+expired is legal; no synthetic acquisition is used to rewrite it.
  assert.ok(details.databaseNowMs >= original.updatedAtMs + 600000);
}

/** Destructive actions are supplied only by the supervisor's fixed owned-dataDir closures. */
export async function runPostgresSaasRecoveryProfile({ getDatabase, seed, gatewayUrls, controlUrl, outputDir,
  stopOwnedPostgres, restartOwnedPostgres, assertOtherProcessesAlive, signal }) {
  const check = () => signal?.throwIfAborted();
  const httpSignal = (milliseconds) => signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
  const startedAt = Date.now();
  const evidence = { schema: 1, profile: 'postgres-saas-immediate-recovery', performanceAcceptance: false,
    builtinAcceptance: false, haVerified: false, pitrVerified: false, diskPowerLossVerified: false,
    syntheticLoopback: true, realProviderCalls: 0, ok: false, stage: 'initial', staleHorizonMs: 600000, scannerCadenceMs: 5000 };
  let lastProgress = 0;
  let progressTimer;
  const progress = async (stage, details = {}) => {
    check(); evidence.stage = stage;
    const row = { schema: 1, stage, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...details };
    await writeFile(join(outputDir, 'postgres-saas-recovery-progress.json'), `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
    console.log(`PostgreSQL recovery progress: ${JSON.stringify(row)}`);
    lastProgress = Date.now();
  };
  const until = async (label, work, milliseconds = 30000, pollMs = 250) => {
    const deadline = Date.now() + milliseconds;
    do {
      check(); assertOtherProcessesAlive();
      const result = await work();
      check(); if (result) return result;
      if (Date.now() - lastProgress >= 30000) await progress(label, { deadlineRemainingMs: Math.max(0, deadline - Date.now()) });
      await delay(pollMs, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error(`PostgreSQL recovery observation deadline: ${label}`);
  };
  const observer = { query: async (sql, values) => {
    check();
    return getDatabase().transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY'); await tx.query('SET LOCAL statement_timeout = 5000');
      return tx.query(sql, values);
    });
  } };
  const snapshot = () => readSaasRecoveryAuthority(observer, seed.tenantId);
  const identity = async () => (await observer.query(`SELECT current_user,session_user,current_database() AS database,
    inet_server_addr()::text AS address,inet_server_port() AS port,pg_postmaster_start_time()::text AS postmaster_start,
    current_setting('server_version_num') AS version,current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit`)).rows[0];
  const details = async (requestId) => {
    const row = (await observer.query(`SELECT r.id,r.updated_at::text AS updated_at,
      EXTRACT(EPOCH FROM r.updated_at)*1000 AS updated_ms,EXTRACT(EPOCH FROM clock_timestamp())*1000 AS database_ms,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.id,'attemptId',l.attempt_id,'fence',l.fencing_token::text,
        'status',l.status,'expiresAt',l.lease_expires_at::text,'liveHeld',l.status='held' AND l.lease_expires_at>clock_timestamp()) ORDER BY l.id),'[]')
        FROM saas_provider_account_leases l JOIN saas_attempts a ON a.tenant_id=l.tenant_id AND a.id::text=l.attempt_id
        WHERE a.tenant_id=r.tenant_id AND a.request_id=r.id) AS leases,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'state',c.case_state,'lastError',c.last_error_code) ORDER BY c.id),'[]')
        FROM saas_unknown_outcome_reconciliation_cases c WHERE c.tenant_id=r.tenant_id AND c.request_id=r.id) AS cases
      FROM saas_requests r WHERE r.tenant_id=$1 AND r.id=$2`, [seed.tenantId, requestId])).rows[0];
    assert.ok(row);
    return { updatedAt: row.updated_at, updatedAtMs: Number(row.updated_ms), databaseNowMs: Number(row.database_ms), leases: row.leases, cases: row.cases };
  };
  const control = async (path, body) => {
    check(); const response = await fetch(`${controlUrl}/__control/${path}`, { method: 'POST', signal: httpSignal(5000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await response.body?.cancel(); assert.equal(response.status, 200);
  };
  const mockActivity = async () => {
    check(); const response = await fetch(`${controlUrl}/__control/stats`, { signal: httpSignal(5000) });
    assert.equal(response.status, 200); const stats = await response.json();
    return Object.values(stats.accounts).reduce((sum, row) => ({ requests: sum.requests + row.requests,
      inFlight: sum.inFlight + row.currentInFlight }), { requests: 0, inFlight: 0 });
  };
  const mockCalls = async () => (await mockActivity()).requests;
  const send = (index, key, stream, customSignal) => {
    check(); assertOtherProcessesAlive();
    return fetch(`${gatewayUrls[index]}${seed.inventory[0].endpoint}`, { method: 'POST', signal: customSignal ?? httpSignal(90000),
      headers: { authorization: `Bearer ${seed.key}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ model: seed.inventory[0].publicModel, max_tokens: 64, stream,
        messages: [{ role: 'user', content: 'owned PostgreSQL recovery mock' }] }) });
  };
  try {
    check();
    progressTimer = setInterval(() => {
      if (Date.now() - lastProgress >= 30000) void progress(evidence.stage).catch(() => {});
    }, 30000);
    progressTimer.unref();
    await progress('slow-stream-dispatch');
    await control('reset', {}); await control('shape', { chunks: 120, chunkDelayMs: 1000 });
    const originalKey = `pg-recovery-original-${randomUUID()}`;
    const clientTimeout = AbortSignal.timeout(90000);
    const wireSignal = signal ? AbortSignal.any([signal, clientTimeout]) : clientTimeout;
    const response = await send(0, originalKey, true, wireSignal);
    assert.equal(response.status, 200);
    const requestId = response.headers.get('x-request-id'); assert.ok(requestId);
    const reader = response.body.getReader();
    const first = await reader.read(); assert.ok(!first.done && first.value.byteLength > 0);
    const initial = await snapshot(); const initialDetails = await details(requestId);
    const initialRequest = initial.requests.find((row) => row.id === requestId);
    assert.equal(initialRequest?.execution, 'pending'); assert.equal(initialRequest?.financial, 'pending');
    assert.equal(initialRequest?.reconciliation, 'none');
    const attempts = initial.attempts.filter((row) => row.requestId === requestId);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].dispatch, 'dispatching');
    const initialHold = initial.holds.find((row) => row.requestId === requestId);
    assert.equal(initialHold?.state, 'reserved'); assert.ok(BigInt(initialHold.amount) > 0n);
    assert.equal(initialDetails.leases.length, 1); assert.equal(initialDetails.leases[0].liveHeld, true);
    const originalBudgets = initial.budget_reservations.filter((row) => row.requestId === requestId);
    assert.equal(originalBudgets.length, 1); assert.equal(originalBudgets[0].state, 'outstanding');
    assert.ok(BigInt(originalBudgets[0].tokens) > 0n && BigInt(originalBudgets[0].charge) > 0n);
    const original = { requestId, attemptId: attempts[0].id, holdId: initialHold.id, holdAmount: initialHold.amount,
      updatedAtMs: initialDetails.updatedAtMs, leaseId: initialDetails.leases[0].id, fence: initialDetails.leases[0].fence,
      budgetReservation: { ...originalBudgets[0] } };
    assert.equal(initial.evidence_facts.filter((row) => row.requestId === requestId).length, 1);
    assert.equal(initial.usage_facts.filter((row) => row.requestId === requestId).length, 0);
    assert.equal(initial.settlement_facts.filter((row) => row.requestId === requestId).length, 0);
    evidence.original = original; evidence.beforeStop = initial; evidence.identityBefore = await identity();
    const beforeStopCalls = await mockCalls();
    let bytes = first.value.byteLength;
    const bodyEnd = (async () => {
      let broken = false;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; } }
      catch { broken = true; }
      finally { reader.releaseLock(); }
      return broken;
    })();
    await progress('owned-pg-immediate-stop');
    check(); await stopOwnedPostgres(); check(); assertOtherProcessesAlive();
    assert.equal(await bodyEnd, true, 'transport must break after the database-backed heartbeat fails');
    check(); assert.equal(clientTimeout.aborted, false, 'client timeout cannot masquerade as gateway heartbeat/transport termination');
    assertOtherProcessesAlive();
    await until('upstream stream drained during PostgreSQL outage', async () => (await mockActivity()).inFlight === 0, 10000);
    evidence.transport = { firstFrameBytes: first.value.byteLength, receivedBytes: bytes, broken: true, clientTimeout: false };
    await progress('outage-fail-closed');
    const outageStatuses = [];
    for (let index = 0; index < 3; index++) {
      const failed = await send(index, `pg-outage-${index}-${randomUUID()}`, false);
      outageStatuses.push(failed.status); await failed.body?.cancel();
      assert.equal(failed.status, 503, 'new requests must fail closed while PostgreSQL is stopped');
    }
    const outageActivity = await mockActivity();
    assert.equal(outageActivity.requests, beforeStopCalls); assert.equal(outageActivity.inFlight, 0);
    evidence.outage = { statuses: outageStatuses, addedProviderCalls: 0, mockCurrentInFlight: 0 };
    await progress('same-owned-pg-restart'); check(); await restartOwnedPostgres();
    await until('PostgreSQL observation reconnect', async () => { try { await observer.query('SELECT 1'); return true; } catch { return false; } });
    evidence.identityAfter = await identity(); assertPostgresRestartIdentity(evidence.identityBefore, evidence.identityAfter);
    const restarted = await snapshot();
    assert.deepEqual(preservedFinancialFacts(restarted), preservedFinancialFacts(initial));
    assert.equal(restarted.requests.length, initial.requests.length); assert.equal(restarted.attempts.length, initial.attempts.length);
    assert.equal(restarted.evidence, initial.evidence);
    const pending = restarted.requests.find((row) => row.id === requestId);
    assert.equal(pending?.execution, 'pending'); assert.equal(pending?.financial, 'pending');
    evidence.afterRestart = restarted;
    await progress('natural-600-second-stale-recovery', { staleEligibleAtMs: original.updatedAtMs + 600000 });
    let recoveredDetails;
    await until('natural-600-second-stale-recovery', async () => {
      const row = await details(requestId);
      if (row.cases.length !== 1 || row.cases[0].state !== 'operator_required') return false;
      recoveredDetails = row; return true;
    }, Math.max(1, startedAt + 900000 - Date.now()), 5000);
    const recovered = await snapshot(); assertUnknownPostgresAuthority(recovered, recoveredDetails, original);
    assert.deepEqual(preservedFinancialFacts(recovered), preservedFinancialFacts(initial));
    evidence.afterScanner = recovered; evidence.scannerDetails = recoveredDetails;
    await progress('canonical-replay');
    const callsBeforeReplay = await mockCalls();
    const replay = await send(1, originalKey, true);
    const canonicalHeader = replay.headers.get('x-canonical-request-id');
    let replayBody;
    let replayJsonFailed = false;
    try { replayBody = await replay.json(); } catch { replayJsonFailed = true; }
    const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const body = replayBody !== null && typeof replayBody === 'object' && !Array.isArray(replayBody) ? replayBody : null;
    evidence.canonicalReplay = { statusCode: replay.status, canonicalRequestId: uuid(canonicalHeader) ? canonicalHeader : null,
      canonicalRequestIdState: canonicalHeader === null ? 'missing' : uuid(canonicalHeader) ? 'valid' : 'invalid',
      jsonParsed: !replayJsonFailed, body: {
        object: body?.object === 'request_status' ? 'request_status' : 'unrecognized',
        id: uuid(body?.id) ? body.id : null,
        status: ['pending', 'unknown', 'completed', 'failed'].includes(body?.status) ? body.status : 'unrecognized',
        response_replayed: typeof body?.response_replayed === 'boolean' ? body.response_replayed : null,
      } };
    evidence.replayMockTotals = { before: { requests: callsBeforeReplay } };
    const afterReplay = await snapshot(); evidence.afterReplay = afterReplay;
    const replayMockActivity = await mockActivity(); evidence.replayMockTotals.after = replayMockActivity;
    // Record actual safe observations first so the existing finally writer also
    // retains a strict replay mismatch, rather than only the pre-replay state.
    assert.equal(replay.status, 202, 'Canonical replay must return the expected HTTP status');
    assert.equal(canonicalHeader, requestId, 'Canonical replay must retain the original request ID');
    if (replayJsonFailed) throw new Error('Canonical replay JSON decoding failed');
    assert.deepEqual(replayBody, { object: 'request_status', id: requestId, status: 'unknown', response_replayed: false },
      'Canonical replay body must match the original request status contract');
    assert.deepEqual(afterReplay, recovered);
    assert.equal(replayMockActivity.requests, callsBeforeReplay);
    const leaseBeforeProbe = (await details(requestId)).leases;
    await control('shape', { chunks: 4, chunkDelayMs: 0 });
    await progress('fresh-request-settles-once');
    const probe = await send(2, `pg-recovery-probe-${randomUUID()}`, false); assert.equal(probe.status, 200);
    const probeId = probe.headers.get('x-request-id'); assert.ok(probeId); await probe.text();
    await until('fresh settlement authority', async () => {
      const current = await snapshot(); const attempt = current.attempts.find((row) => row.requestId === probeId);
      const leases = current.leases.filter((row) => row.attemptId === attempt?.id);
      return current.requests.find((row) => row.id === probeId)?.financial === 'settled' && leases.length === 1 && leases[0].status === 'released';
    });
    const final = await snapshot(); assertRecoverySettlementDelta(afterReplay, final, probeId);
    assert.equal(final.requests.length, initial.requests.length + 1); assert.equal(final.attempts.length, initial.attempts.length + 1);
    assert.equal(final.evidence, initial.evidence + 1); assert.equal(await mockCalls(), callsBeforeReplay + 1);
    const finalDetails = await details(requestId); assertUnknownPostgresAuthority(final, finalDetails, original);
    assert.equal(leaseBeforeProbe.length, finalDetails.leases.length);
    assert.equal(finalDetails.leases[0].id, original.leaseId); assert.equal(finalDetails.leases[0].fence, original.fence);
    evidence.afterReplay = afterReplay; evidence.afterFreshRequest = final; evidence.finalUnknownDetails = finalDetails;
    evidence.elapsedMs = Date.now() - startedAt; evidence.ok = true;
    await progress('complete'); return evidence;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    await writeFile(join(outputDir, 'postgres-saas-recovery.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
}
