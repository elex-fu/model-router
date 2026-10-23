import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';

const NAMESPACE = 'managed-saas-capacity';
const REDIS_KEY = `mr:quota:{${createHash('sha256').update(NAMESPACE).digest('hex')}}`;

export function validateRecoveryProfile(options, tracingEnabled, cap) {
  if (!options.recoveryProfile) return;
  assert.ok(options.diagnostic && options.noBuild && !options.serialProfile && !options.capProfile && !options.requestSamples,
    '--recovery-profile requires --diagnostic --no-build and excludes serial/cap/request samples');
  assert.ok(!tracingEnabled && cap === null, 'Recovery profile requires request tracing and ingress cap unset');
}

async function boundedRecovery(promise, label, milliseconds = 30000, signal) {
  let timer;
  let onAbort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(new Error('Recovery interrupted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new Error(`Recovery deadline: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
}

async function untilRecovery(label, work, milliseconds = 30000, check = () => {}) {
  const deadline = Date.now() + milliseconds;
  do {
    check();
    const value = await work();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Recovery observation deadline: ${label}`);
}

async function authority(database, tenantId) {
  const row = (await database.query(`SELECT
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'execution',execution_state,'financial',financial_status,'reconciliation',reconciliation_state) ORDER BY id),'[]') FROM saas_requests WHERE tenant_id=$1) AS requests,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'requestId',request_id,'dispatch',dispatch_state,'result',result_state) ORDER BY id),'[]') FROM saas_attempts WHERE tenant_id=$1) AS attempts,
    (SELECT count(*)::int FROM saas_prepared_request_evidence WHERE tenant_id=$1) AS evidence,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'requestId',request_id) ORDER BY id),'[]') FROM saas_prepared_request_evidence WHERE tenant_id=$1) AS evidence_facts,
    (SELECT count(*)::int FROM saas_usage_events WHERE tenant_id=$1) AS usage,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',request_id,'inputTotal',input_total::text,'outputTotal',output_total::text) ORDER BY request_id),'[]') FROM saas_usage_events WHERE tenant_id=$1) AS usage_facts,
    (SELECT count(*)::int FROM saas_usage_settlements WHERE tenant_id=$1) AS settlements,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',request_id) ORDER BY request_id),'[]') FROM saas_usage_settlements WHERE tenant_id=$1) AS settlement_facts,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'balance',posted_balance_minor_units::text) ORDER BY id),'[]') FROM saas_wallets WHERE tenant_id=$1) AS wallets,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'requestId',request_id,'state',state,'amount',amount_minor_units::text,'settlement',settlement_amount_minor_units::text,'ledgerTransactionId',ledger_transaction_id) ORDER BY id),'[]') FROM saas_billing_reservations WHERE tenant_id=$1) AS holds,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'amount',amount_minor_units::text,'source',source_type) ORDER BY id),'[]') FROM saas_ledger_transactions WHERE tenant_id=$1) AS ledger,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'transaction',transaction_id,'direction',direction,'amount',amount_minor_units::text) ORDER BY id),'[]') FROM saas_ledger_entries WHERE tenant_id=$1) AS entries,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'attemptId',attempt_id,'status',status,'fence',fencing_token::text) ORDER BY id),'[]') FROM saas_provider_account_leases WHERE tenant_id=$1) AS leases,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('lineage',lineage_id,'window',window_kind,'day',day::text,'tokensSettled',token_settled::text,'tokensReserved',token_outstanding_reserved::text,'chargeSettled',charge_settled::text,'chargeReserved',charge_outstanding_reserved::text) ORDER BY lineage_id,window_kind,day),'[]') FROM saas_api_key_budget_counters WHERE tenant_id=$1) AS budgets,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',request_id,'lineage',lineage_id,'day',day::text,'state',state,'tokens',token_units::text,'charge',charge_minor_units::text) ORDER BY request_id),'[]') FROM saas_api_key_budget_reservations WHERE tenant_id=$1) AS budget_reservations,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',request_id,'state',state,'tokens',token_units::text) ORDER BY request_id),'[]') FROM saas_gateway_capacity_reservations WHERE tenant_id=$1) AS capacity`, [tenantId])).rows[0];
  assert.ok(row);
  return row;
}

function requestFact(snapshot, id) { return snapshot.requests.find((row) => row.id === id); }
function holdFact(snapshot, id) { return snapshot.holds.find((row) => row.requestId === id); }
function scopeField(tenantId) { return JSON.stringify(['capacityScope', 'tenant', tenantId]); }

export function projectRecoveryScope(value) {
  assert.ok(value && Number.isSafeInteger(value.active) && value.active >= 0);
  const entries = Object.entries(value.windows ?? {});
  assert.ok(entries.length <= 128);
  const windows = Object.fromEntries(entries.sort(([a], [b]) => Number(a) - Number(b)).map(([second, counts]) => {
    assert.ok(/^\d{1,12}$/.test(second) && Number.isSafeInteger(counts.requests) && counts.requests >= 0 &&
      Number.isSafeInteger(counts.tokens) && counts.tokens >= 0);
    return [second, { requests: counts.requests, tokens: counts.tokens }];
  }));
  return { active: value.active, windows };
}

export function assertRecoveryAuthority(snapshot, unknownId, settledId) {
  const unknown = requestFact(snapshot, unknownId);
  assert.equal(unknown?.execution, 'unknown');
  assert.equal(unknown?.financial, 'reconciliation_pending');
  assert.equal(unknown?.reconciliation, 'pending');
  assert.equal(requestFact(snapshot, settledId)?.execution, 'succeeded');
  assert.equal(requestFact(snapshot, settledId)?.financial, 'settled');
  assert.equal(holdFact(snapshot, unknownId)?.state, 'reconciliation_pending');
  assert.equal(holdFact(snapshot, unknownId)?.ledgerTransactionId, null);
  assert.ok(BigInt(holdFact(snapshot, unknownId)?.amount ?? '0') > 0n);
  assert.ok(BigInt(holdFact(snapshot, settledId)?.settlement ?? '0') > 0n);
  assert.equal(snapshot.leases.filter((row) => row.status === 'held').length, 0);
  const reserved = snapshot.budget_reservations.find((row) => row.requestId === unknownId);
  const settledReservation = snapshot.budget_reservations.find((row) => row.requestId === settledId);
  assert.equal(settledReservation?.lineage, reserved?.lineage);
  assert.equal(reserved?.state, 'outstanding');
  assert.ok(BigInt(reserved.tokens) > 0n && BigInt(reserved.charge) > 0n);
  const windows = snapshot.budgets.filter((row) => row.lineage === reserved.lineage);
  assert.equal(windows.length, 2);
  assert.equal(windows.filter((row) => row.window === 'daily' && row.day === reserved.day).length, 1);
  assert.equal(windows.filter((row) => row.window === 'lifetime' && row.day === '0001-01-01').length, 1);
  for (const row of windows) {
    assert.ok(BigInt(row.tokensSettled) > 0n && BigInt(row.chargeSettled) > 0n);
    assert.equal(BigInt(row.tokensReserved), BigInt(reserved.tokens));
    assert.equal(BigInt(row.chargeReserved), BigInt(reserved.charge));
  }
  assertRecoveryRequest(snapshot, unknownId, 0);
  assertRecoveryRequest(snapshot, settledId, 1);
}

function assertRecoveryRequest(snapshot, id, usageCount) {
  assert.equal(snapshot.requests.filter((row) => row.id === id).length, 1);
  const attempts = snapshot.attempts.filter((row) => row.requestId === id);
  assert.equal(attempts.length, 1);
  const leases = snapshot.leases.filter((row) => row.attemptId === attempts[0].id);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].status, 'released');
  assert.equal(snapshot.evidence_facts.filter((row) => row.requestId === id).length, 1);
  assert.equal(snapshot.usage_facts.filter((row) => row.requestId === id).length, usageCount);
  assert.equal(snapshot.settlement_facts.filter((row) => row.requestId === id).length, usageCount);
}

export function assertRecoverySettlementDelta(before, after, id) {
  assertRecoveryRequest(after, id, 1);
  assert.equal(requestFact(after, id)?.execution, 'succeeded');
  assert.equal(requestFact(after, id)?.financial, 'settled');
  const reservation = after.budget_reservations.find((row) => row.requestId === id);
  assert.equal(reservation?.state, 'settled');
  const usage = after.usage_facts.find((row) => row.requestId === id);
  const tokens = BigInt(usage.inputTotal) + BigInt(usage.outputTotal);
  const hold = holdFact(after, id);
  assert.equal(hold?.state, 'settled');
  const charge = BigInt(hold.settlement);
  assert.ok(tokens > 0n && charge > 0n);
  const counters = after.budgets.filter((row) => row.lineage === reservation.lineage);
  assert.equal(counters.length, 2);
  assert.equal(counters.filter((row) => row.window === 'daily' && row.day === reservation.day).length, 1);
  assert.equal(counters.filter((row) => row.window === 'lifetime' && row.day === '0001-01-01').length, 1);
  for (const row of counters) {
    const old = before.budgets.find((item) => item.lineage === row.lineage && item.window === row.window && item.day === row.day);
    assert.equal(BigInt(row.tokensSettled) - BigInt(old?.tokensSettled ?? '0'), tokens);
    assert.equal(BigInt(row.chargeSettled) - BigInt(old?.chargeSettled ?? '0'), charge);
  }
  const newTransactions = after.ledger.filter((row) => !before.ledger.some((old) => old.id === row.id));
  assert.equal(newTransactions.length, 1);
  assert.equal(newTransactions[0].id, hold.ledgerTransactionId);
  assert.equal(newTransactions[0].source, 'billing_settlement');
  assert.equal(BigInt(newTransactions[0].amount), charge);
  const entries = after.entries.filter((row) => !before.entries.some((old) => old.id === row.id));
  assert.equal(entries.length, 2);
  for (const direction of ['credit', 'debit']) {
    const side = entries.filter((row) => row.direction === direction && row.transaction === hold.ledgerTransactionId);
    assert.equal(side.length, 1); assert.equal(BigInt(side[0].amount), charge);
  }
  const balance = (snapshot) => snapshot.wallets.reduce((sum, row) => sum + BigInt(row.balance), 0n);
  assert.equal(balance(before) - balance(after), charge);
  assert.equal(after.usage, before.usage + 1);
  assert.equal(after.settlements, before.settlements + 1);
}

/** Actual standard-CLI/PG/Redis/loopback-provider recovery, never a performance run. */
export async function runRedisSaasRecoveryProfile({ database, seed, gatewayUrls, controlUrl, redisUrl, redisProcess,
  runtimeDir, outputDir, launchRedis, signal }) {
  const check = () => signal?.throwIfAborted();
  const bounded = (promise, label, ms) => boundedRecovery(promise, label, ms, signal);
  const until = (label, work, ms) => untilRecovery(label, work, ms, check);
  const requestSignal = (ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const pg = database;
  database = { query: (sql, values) => bounded(pg.transaction(async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query('SET LOCAL statement_timeout = 5000');
    return tx.query(sql, values);
  }), 'read-only PG observation', 10000) };
  const evidence = { schema: 1, profile: 'redis-saas-authority-recovery', performanceAcceptance: false,
    builtinAcceptance: false, realProviderCalls: 0, syntheticLoopback: true, ok: false,
    softQuota: { unflushedMutationLossTested: false, generalZeroLossClaim: false, persistenceBoundaryRequired: true } };
  const startedAt = Date.now();
  let inspect;
  let settledPending;
  const connectInspector = async () => {
    check();
    const client = createClient({ url: redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false } });
    client.on('error', () => {});
    try { await bounded(client.connect(), 'Redis inspector connect', 6000); }
    catch (error) { client.destroy(); throw error; }
    inspect = client;
  };
  const control = async (path, body) => {
    check();
    const response = await fetch(`${controlUrl}/__control/${path}`, { method: 'POST', signal: requestSignal(5000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await response.body?.cancel(); assert.equal(response.status, 200);
  };
  const mockCalls = async () => {
    check();
    const response = await fetch(`${controlUrl}/__control/stats`, { signal: requestSignal(5000) });
    assert.equal(response.status, 200);
    const stats = await response.json();
    return Object.values(stats.accounts).reduce((sum, account) => sum + account.requests, 0);
  };
  const send = (index, idempotency, streaming) => { check(); return fetch(`${gatewayUrls[index]}${seed.inventory[0].endpoint}`, {
    method: 'POST', signal: requestSignal(90000), headers: { authorization: `Bearer ${seed.key}`,
      'content-type': 'application/json', 'idempotency-key': idempotency },
    body: JSON.stringify({ model: seed.inventory[0].publicModel, max_tokens: 64, stream: streaming,
      messages: [{ role: 'user', content: 'recovery mock only' }] }),
  }); };
  const state = async (requestId) => (await database.query(
    `SELECT value FROM saas_redis_quota_state WHERE namespace=$1 AND key=$2`, [NAMESPACE, JSON.stringify(['capacityRequest', requestId])])).rows[0]?.value;
  const pgScope = async () => projectRecoveryScope((await database.query(
    'SELECT value FROM saas_redis_quota_state WHERE namespace=$1 AND key=$2', [NAMESPACE, scopeField(seed.tenantId)])).rows[0]?.value);
  const flushed = async () => {
    const [revision, persisted, healthyUntil] = await inspect.hmGet(REDIS_KEY, ['revision', 'persisted', 'healthyUntil']);
    const clock = await inspect.sendCommand(['TIME']);
    const redisNow = Number(clock[0]) * 1000 + Number(clock[1]) / 1000;
    const pending = (await database.query('SELECT count(*)::int AS n FROM saas_redis_quota_state WHERE namespace=$1 AND projection_pending', [NAMESPACE])).rows[0].n;
    return revision !== null && revision === persisted && Number(healthyUntil) > redisNow && pending === 0;
  };
  try {
    evidence.stage = 'unknown-request';
    check();
    await connectInspector();
    await control('reset', {});
    await control('shape', { chunks: 4, chunkDelayMs: 0 });
    evidence.baseline = await authority(database, seed.tenantId);
    const unknownKey = `recovery-unknown-${randomUUID()}`;
    const settledKey = `recovery-settled-${randomUUID()}`;
    await control('faults', { mode: 'abort-after', afterChunks: 1 });
    const partial = await send(0, unknownKey, true);
    assert.equal(partial.status, 200);
    const unknownId = partial.headers.get('x-request-id');
    assert.ok(unknownId);
    let receivedBytes = 0;
    let failedBody = false;
    const reader = partial.body.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; receivedBytes += next.value.byteLength; } }
    catch { failedBody = true; }
    finally { reader.releaseLock(); }
    assert.ok(receivedBytes > 0 && failedBody, 'unknown request must receive real partial bytes and a broken stream');
    await until('unknown financial authority', async () => {
      const snapshot = await authority(database, seed.tenantId);
      return requestFact(snapshot, unknownId)?.execution === 'unknown' && holdFact(snapshot, unknownId)?.state === 'reconciliation_pending' &&
        snapshot.leases.every((row) => row.status !== 'held');
    });
    await control('faults', { mode: 'none' });
    evidence.stage = 'old-active-snapshot';
    await control('delay', { ms: 20000 });
    settledPending = send(1, settledKey, false).then(async (response) => {
      assert.equal(response.status, 200); const requestId = response.headers.get('x-request-id');
      await response.text(); assert.ok(requestId); return requestId;
    });
    // Attach a rejection observer immediately while PG/SAVE is being inspected.
    void settledPending.catch(() => {});
    const inFlight = await until('actual dispatching request with a held provider lease', async () => {
      const rows = (await database.query(`SELECT r.id FROM saas_requests r JOIN saas_attempts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id
        JOIN saas_provider_account_leases l ON l.tenant_id=r.tenant_id AND l.attempt_id=a.id::text
        WHERE r.tenant_id=$1 AND r.execution_state='pending' AND a.dispatch_state='dispatching' AND l.status='held'`, [seed.tenantId])).rows;
      return rows.length === 1 ? rows[0].id : null;
    }, 10000);
    await until('active request PG quota projection before old snapshot', async () =>
      (await state(inFlight))?.state === 'active' && await flushed(), 10000);
    const oldRunId = /^run_id:(\w+)\r?$/m.exec(await inspect.info('server'))?.[1];
    const oldGeneration = Number(await inspect.hGet(REDIS_KEY, 'generation'));
    assert.ok(oldRunId && Number.isSafeInteger(oldGeneration));
    evidence.softQuota.oldSnapshotScope = await pgScope();
    assert.equal(evidence.softQuota.oldSnapshotScope.active, 2);
    check(); await bounded(inspect.sendCommand(['SAVE']), 'Redis SAVE', 10000);
    const oldSnapshot = join(runtimeDir, 'recovery-old.rdb');
    await copyFile(join(runtimeDir, 'dump.rdb'), oldSnapshot);
    assert.equal(requestFact(await authority(database, seed.tenantId), inFlight)?.execution, 'pending',
      'the saved old snapshot must precede the genuine successful completion');
    evidence.oldSnapshot = { runId: oldRunId, generation: oldGeneration, activeRequest: inFlight, pendingPersistence: 0 };
    evidence.stage = 'newer-settlement';
    const settledId = await bounded(settledPending, 'settled response completion', 60000);
    assert.equal(settledId, inFlight);
    await control('delay', { ms: 0 });
    await until('settlement and quota newer than snapshot', async () => {
      const snapshot = await authority(database, seed.tenantId);
      return requestFact(snapshot, settledId)?.financial === 'settled' && snapshot.leases.every((row) => row.status !== 'held') &&
        (await state(settledId))?.state === 'completed' && (await state(unknownId))?.state === 'active' && await flushed();
    });
    const beforeRestart = await authority(database, seed.tenantId);
    assertRecoveryAuthority(beforeRestart, unknownId, settledId);
    assertRecoverySettlementDelta(evidence.baseline, beforeRestart, settledId);
    assert.equal(beforeRestart.requests.length, evidence.baseline.requests.length + 2);
    assert.equal(beforeRestart.attempts.length, evidence.baseline.attempts.length + 2);
    assert.equal(beforeRestart.evidence, evidence.baseline.evidence + 2);
    const settledReservation = beforeRestart.budget_reservations.find((row) => row.requestId === settledId);
    assert.equal(settledReservation?.state, 'settled');
    const baselineLifetime = evidence.baseline.budgets.find((row) => row.window === 'lifetime');
    const newerLifetime = beforeRestart.budgets.find((row) => row.window === 'lifetime');
    const usage = beforeRestart.usage_facts.filter((row) => row.requestId === settledId);
    assert.equal(usage.length, 1);
    const settledTokens = BigInt(usage[0].inputTotal) + BigInt(usage[0].outputTotal);
    const settledCharge = BigInt(holdFact(beforeRestart, settledId).settlement);
    assert.ok(settledTokens > 0n && settledCharge > 0n);
    for (const counter of beforeRestart.budgets) {
      const baseline = evidence.baseline.budgets.find((row) => row.lineage === counter.lineage && row.window === counter.window && row.day === counter.day);
      assert.equal(BigInt(counter.tokensSettled) - BigInt(baseline?.tokensSettled ?? '0'), settledTokens);
      assert.equal(BigInt(counter.chargeSettled) - BigInt(baseline?.chargeSettled ?? '0'), settledCharge);
    }
    assert.ok(BigInt(newerLifetime.tokensSettled) > BigInt(baselineLifetime?.tokensSettled ?? '0'));
    const balance = (snapshot) => snapshot.wallets.reduce((sum, row) => sum + BigInt(row.balance), 0n);
    assert.equal(balance(evidence.baseline) - balance(beforeRestart), settledCharge);
    assert.equal(beforeRestart.usage, evidence.baseline.usage + 1);
    assert.equal(beforeRestart.settlements, evidence.baseline.settlements + 1);
    evidence.beforeRestart = beforeRestart;
    evidence.softQuota.newerDurableScope = await pgScope();
    assert.equal(evidence.softQuota.newerDurableScope.active, 1);
    evidence.stage = 'restore-old-redis';
    check();
    inspect.destroy(); inspect = undefined;
    const exited = once(redisProcess, 'exit');
    assert.equal(redisProcess.kill('SIGKILL'), true);
    const [, signal] = await bounded(exited, 'owned Redis SIGKILL exit', 10000);
    assert.equal(signal, 'SIGKILL');
    check(); await copyFile(oldSnapshot, join(runtimeDir, 'dump.rdb'));
    check(); await launchRedis();
    await until('restored owned Redis readiness', async () => {
      try { await connectInspector(); return true; } catch { inspect?.destroy(); inspect = undefined; return false; }
    }, 10000);
    const newRunId = /^run_id:(\w+)\r?$/m.exec(await inspect.info('server'))?.[1];
    assert.ok(newRunId && newRunId !== oldRunId);
    await until('new Redis generation fences old snapshot', async () => {
      const [runId, generation] = await inspect.hmGet(REDIS_KEY, ['runId', 'generation']);
      const pg = Number((await database.query('SELECT generation FROM saas_redis_quota_metadata WHERE namespace=$1', [NAMESPACE])).rows[0]?.generation);
      return runId === newRunId && Number(generation) > oldGeneration && Number(generation) === pg ? pg : null;
    });
    const afterRestart = await authority(database, seed.tenantId);
    assert.deepEqual(afterRestart, beforeRestart, 'Redis restoration cannot mutate PG financial, dispatch, lease or cumulative budget facts');
    evidence.afterRestart = afterRestart;
    evidence.stage = 'fresh-scope-hydration';
    // A fresh genuine request forces scope hydration; no synthetic Redis mutations.
    const probe = await send(2, `recovery-probe-${randomUUID()}`, false);
    assert.equal(probe.status, 200); const probeId = probe.headers.get('x-request-id'); await probe.text();
    await until('probe settled and only original unknown active', async () => {
      const raw = await inspect.hGet(REDIS_KEY, `s:${scopeField(seed.tenantId)}`);
      const scope = raw ? JSON.parse(raw).value : null;
      const snapshot = await authority(database, seed.tenantId);
      return requestFact(snapshot, probeId)?.financial === 'settled' && scope?.active === 1 && await flushed();
    });
    const beforeReplay = await authority(database, seed.tenantId);
    assertRecoverySettlementDelta(afterRestart, beforeReplay, probeId);
    assert.equal(beforeReplay.requests.length, afterRestart.requests.length + 1);
    assert.equal(beforeReplay.attempts.length, afterRestart.attempts.length + 1);
    assert.equal(beforeReplay.evidence, afterRestart.evidence + 1);
    evidence.softQuota.recoveredScope = await pgScope();
    assert.equal(evidence.softQuota.recoveredScope.active, 1);
    evidence.softQuota.observedAtMs = Date.now();
    evidence.softQuota.windowComparison = 'original-second-buckets; normal 60s aging may remove expired buckets';
    assertRecoveryAuthority(beforeReplay, unknownId, settledId);
    const callsBeforeReplay = await mockCalls();
    evidence.stage = 'canonical-replay';
    for (const [id, key, streaming, status, canonicalStatus] of [[unknownId, unknownKey, true, 202, 'unknown'], [settledId, settledKey, false, 200, 'completed']]) {
      const response = await send(2, key, streaming);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('x-canonical-request-id'), id);
      assert.deepEqual(await response.json(), { object: 'request_status', id, status: canonicalStatus, response_replayed: false });
    }
    await until('post replay persistence boundary', flushed);
    const afterReplay = await authority(database, seed.tenantId);
    assert.deepEqual(afterReplay, beforeReplay, 'canonical replay cannot dispatch, release unknown holds, or add financial and budget effects');
    assert.equal(await mockCalls(), callsBeforeReplay);
    assert.equal((await state(settledId))?.state, 'completed');
    assert.equal((await state(unknownId))?.state, 'active');
    evidence.afterProbe = beforeReplay; evidence.afterReplay = afterReplay;
    evidence.recovery = { oldRunId, newRunId, generation: Number(await inspect.hGet(REDIS_KEY, 'generation')),
      signal: 'SIGKILL', originalCliProcessesContinued: true, replayAddedProviderCalls: 0, activeUnknownRequests: 1 };
    assert.ok(Date.now() - startedAt < 540000, 'unknown observation must remain below its 600-second capacity deadline');
    evidence.elapsedMs = Date.now() - startedAt;
    evidence.stage = 'complete';
    evidence.ok = true;
    return evidence;
  } finally {
    inspect?.destroy();
    // The supervisor still owns all processes and performs bounded cleanup on failure.
    await writeFile(join(outputDir, 'redis-saas-recovery.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
}
