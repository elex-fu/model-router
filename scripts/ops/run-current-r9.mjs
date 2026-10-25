#!/usr/bin/env node
// Self-owned native R9 performance stack. This is an explicit mock TEST
// ASSEMBLY, not the built-in provider or real-supplier acceptance path.
// Builds current dist by default; --no-build reuses a separately frozen build.
// Owns a fresh PG cluster, Redis, HTTPS mock and three dist CLI gateways only.
// It never calls Docker or operates on existing service ports/processes.
//
// Diagnostic: node scripts/ops/run-current-r9.mjs --pg-bin /path/to/pg18/bin --diagnostic
// Serial:     node scripts/ops/run-current-r9.mjs --pg-bin /path/to/pg18/bin --diagnostic --serial-profile --no-build
// Full R9:    node scripts/ops/run-current-r9.mjs --pg-bin /path/to/pg18/bin
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runRedisSaasRecoveryProfile, validateRecoveryProfile } from './redis-saas-recovery-profile.mjs';
import { runPostgresSaasRecoveryProfile, validatePostgresRecoveryProfile } from './postgres-saas-recovery-profile.mjs';
import { runPostgresSaasStandbyRecoveryProfile, validateStandbyRecoveryProfile } from './postgres-saas-standby-recovery-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const options = { pgBin: process.env.MODEL_ROUTER_TEST_PG_BIN, redisBin: 'redis-server', outputDir: undefined, diagnostic: false, serialProfile: false, capProfile: false, recoveryProfile: false, postgresRecoveryProfile: false, standbyRecoveryProfile: false, noBuild: false, requestSamples: false };
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--diagnostic') options.diagnostic = true;
  else if (argument === '--serial-profile') options.serialProfile = true;
  else if (argument === '--cap-profile') options.capProfile = true;
  else if (argument === '--recovery-profile') options.recoveryProfile = true;
  else if (argument === '--postgres-recovery-profile') options.postgresRecoveryProfile = true;
  else if (argument === '--standby-recovery-profile') options.standbyRecoveryProfile = true;
  else if (argument === '--request-samples') options.requestSamples = true;
  else if (argument === '--no-build') options.noBuild = true;
  else if (['--pg-bin', '--redis-bin', '--output-dir'].includes(argument) && args[index + 1]) {
    const key = { '--pg-bin': 'pgBin', '--redis-bin': 'redisBin', '--output-dir': 'outputDir' }[argument];
    options[key] = args[++index];
  } else throw new Error('Usage: --pg-bin /path/to/pg16+/bin [--redis-bin /path/to/redis-server] [--output-dir /new/dir] [--diagnostic [--serial-profile [--request-samples] | --cap-profile --no-build | --recovery-profile --no-build | --postgres-recovery-profile --no-build | --standby-recovery-profile --no-build]] [--no-build]');
}
assert.ok(!options.serialProfile || options.diagnostic, '--serial-profile requires --diagnostic');
assert.ok(!options.requestSamples || (options.diagnostic && options.serialProfile), '--request-samples requires --diagnostic --serial-profile');
function requestDiagnosticsConfiguration(setting, configuration) {
  if (setting === undefined) return { enabled: false, sampleEvery: null };
  assert.ok(/^[1-9]\d{0,8}$/.test(setting), 'MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY must be a positive integer with at most 9 digits');
  assert.ok(configuration.diagnostic && configuration.serialProfile && configuration.requestSamples,
    'Request diagnostics requires --diagnostic --serial-profile --request-samples; acceptance runs must not enable tracing');
  return { enabled: true, sampleEvery: Number(setting) };
}
const requestDiagnostics = requestDiagnosticsConfiguration(process.env.MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY, options);
const configuredPostgresPreparedStatements = process.env.MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS;
const postgresPreparedStatements = configuredPostgresPreparedStatements === undefined ? 'off' : configuredPostgresPreparedStatements;
assert.ok(postgresPreparedStatements === 'off' || postgresPreparedStatements === 'native', 'MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS must be exactly off or native');
const configuredGatewayMaxHttpInFlight = process.env.MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT;
assert.ok(configuredGatewayMaxHttpInFlight === undefined || configuredGatewayMaxHttpInFlight === '' ||
  (/^[1-9][0-9]*$/.test(configuredGatewayMaxHttpInFlight) && Number.isSafeInteger(Number(configuredGatewayMaxHttpInFlight))),
  'MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT must be a positive safe integer');
// null keeps the gateway default: unset/empty means HTTP ingress backpressure stays off.
const gatewayMaxHttpInFlight = configuredGatewayMaxHttpInFlight !== undefined && configuredGatewayMaxHttpInFlight !== '' ? Number(configuredGatewayMaxHttpInFlight) : null;
function validateCapProfile(configuration, cap) {
  if (!configuration.capProfile) return;
  assert.ok(configuration.diagnostic && configuration.noBuild && !configuration.serialProfile && !configuration.requestSamples,
    '--cap-profile requires --diagnostic --no-build and excludes serial/request samples');
  assert.ok(cap === null || cap === 8, '--cap-profile requires cap unset/empty or exactly 8');
}
validateCapProfile(options, gatewayMaxHttpInFlight);
validateRecoveryProfile(options, requestDiagnostics.enabled, gatewayMaxHttpInFlight);
validatePostgresRecoveryProfile(options, requestDiagnostics.enabled, gatewayMaxHttpInFlight);
validateStandbyRecoveryProfile(options);
assert.ok(options.pgBin, 'Set --pg-bin to an installed PostgreSQL 16+ binary directory');
const pgBin = resolve(options.pgBin);
for (const executable of ['initdb', 'pg_ctl', 'psql', 'postgres']) assert.ok(existsSync(join(pgBin, executable)), `Missing PostgreSQL binary ${executable}`);
const outputDir = options.outputDir ? resolve(options.outputDir) : await mkdtemp(join(tmpdir(), 'model-router-current-r9-'));
if (options.outputDir) await mkdir(outputDir, { mode: 0o700 });
const runtimeDir = join(outputDir, 'owned-runtime');
await mkdir(runtimeDir, { mode: 0o700 });
const dataDir = join(runtimeDir, 'pgdata');
const children = [];
const activeRuns = new Set();
let database;
let censusDatabaseUrl;
let requestSamplesTenantId;
let requestSamplesFile;
let pgStarted = false;
let interrupted = false;
const recoveryAbort = new AbortController();
const manifest = { schema: 1, startedAt: new Date().toISOString(), assembly: 'current-dist-cli-mock-test-assembly',
  productionKmsVerified: false, builtinAcceptance: false, realProviderCalls: 0, diagnostic: options.diagnostic,
  ...(options.recoveryProfile ? { recoveryProfile: true, performanceAcceptance: false } : {}),
  ...(options.postgresRecoveryProfile ? { postgresRecoveryProfile: true, performanceAcceptance: false } : {}),
  ...(options.standbyRecoveryProfile ? { standbyRecoveryProfile: true, performanceAcceptance: false } : {}),
  serialProfile: options.serialProfile, warmupInflight: options.serialProfile ? 1 : 4,
  capProfile: options.capProfile ? { diagnosticOnly: true, performanceAcceptance: false, cap: gatewayMaxHttpInFlight,
    inflight: 200, requestedSeconds: 60, minimumSuccessfulSamples: 100, pairedComparisonRequired: true } : null,
  postgresPreparedStatements, gatewayMaxHttpInFlight,
  requestDiagnostics: { ...requestDiagnostics, performanceAcceptance: false },
  mockProtocolPaths: 'native OpenAI and native Anthropic; cross-protocol acceptance is separate',
  buildRequested: !options.noBuild, nodeVersion: process.version, postgresDurability: { fsync: 'on', synchronousCommit: 'on' },
  stages: [], scenes: [], firstFault: null, cleanup: {}, sourceBefore: {}, sourceAfter: {}, distBefore: {}, distAfter: {}, ok: false };
const baseEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  LC_ALL: 'C', LANG: 'C', NODE_ENV: 'test' };
// Version-key cache kill switches pass through so paired cache-off/on
// diagnostic runs (same-load T1 quantification) stay controllable.
for (const cacheSwitch of ['MODEL_ROUTER_PREPARATION_AUTHORITY_CACHE',
  'MODEL_ROUTER_PREPARATION_ENTITLEMENT_CACHE', 'MODEL_ROUTER_SCHEDULER_STATIC_CACHE']) {
  if (process.env[cacheSwitch] !== undefined) baseEnvironment[cacheSwitch] = process.env[cacheSwitch];
}

const REQUEST_SAMPLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function projectRequestDiagnostic(source) {
  const phases = ['pool-checkout', 'query', 'transaction', 'settle', 'upstream-send', 'upstream-body'];
  const number = (value) => Number.isFinite(value) && value >= 0 && value <= 1e12;
  assert.ok(source?.kind === 'request-diagnostic-v1' && typeof source.requestId === 'string' && REQUEST_SAMPLE_UUID.test(source.requestId));
  for (const key of ['elapsedMs', 'observedExclusiveMs', 'pendingSpans', 'droppedSpans']) assert.ok(number(source[key]));
  assert.ok(Number.isSafeInteger(source.pendingSpans) && Number.isSafeInteger(source.droppedSpans));
  assert.ok(source.markers && typeof source.markers === 'object' && !Array.isArray(source.markers));
  const markers = {};
  for (const key of ['upstream-send', 'first-byte', 'eof', 'settled']) {
    if (source.markers[key] !== undefined) { assert.ok(number(source.markers[key])); markers[key] = source.markers[key]; }
  }
  assert.ok(Array.isArray(source.phases) && source.phases.length === phases.length);
  const projectedPhases = phases.map((phase) => {
    const matches = source.phases.filter((entry) => entry?.phase === phase);
    assert.ok(matches.length === 1 && number(matches[0].inclusiveMs) && number(matches[0].exclusiveMs));
    return { phase, inclusiveMs: matches[0].inclusiveMs, exclusiveMs: matches[0].exclusiveMs };
  });
  return { requestId: source.requestId.toLowerCase(), elapsedMs: source.elapsedMs, observedExclusiveMs: source.observedExclusiveMs,
    pendingSpans: source.pendingSpans, droppedSpans: source.droppedSpans, markers, phases: projectedPhases };
}

async function exportRequestDiagnosticTraces(samplesFile, directory, artifactFile) {
  const journal = JSON.parse(await readFile(samplesFile, 'utf8'));
  const facts = validateRequestSampleJournal(journal);
  const samples = journal.samples.filter((sample) => sample.leg === 'gateway');
  const expected = new Map(samples.filter((sample) => sample.requestIdState === 'valid').map((sample) => [sample.requestId.toLowerCase(), sample.gatewayIndex]));
  const traces = new Map();
  const duplicates = new Set();
  const counters = { malformedRecords: 0, unrelatedRecords: 0, wrongGatewayRecords: 0, missingLogs: 0 };
  for (let gatewayIndex = 0; gatewayIndex < 3; gatewayIndex++) {
    const file = join(directory, `gateway-${gatewayIndex + 1}.log`);
    if (!existsSync(file)) { counters.missingLogs++; continue; }
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.startsWith('{"kind":"request-diagnostic-v1"')) continue;
        let trace;
        try { assert.ok(line.length <= 4096); trace = projectRequestDiagnostic(JSON.parse(line)); }
        catch { counters.malformedRecords++; continue; }
        if (!expected.has(trace.requestId)) { counters.unrelatedRecords++; continue; }
        if (expected.get(trace.requestId) !== gatewayIndex) { counters.wrongGatewayRecords++; continue; }
        if (traces.has(trace.requestId)) { duplicates.add(trace.requestId); continue; }
        traces.set(trace.requestId, trace);
      }
    } finally { lines.close(); input.destroy(); }
  }
  const rows = samples.map((sample) => {
    const id = sample.requestId?.toLowerCase();
    const trace = traces.get(id);
    return { scenario: sample.scenario, index: sample.index, gatewayIndex: sample.gatewayIndex, requestId: sample.requestId,
      status: sample.status, outcome: sample.outcome, includedInSummary: sample.includedInSummary,
      traceState: duplicates.has(id) ? 'duplicate' : trace ? 'observed' : 'missing', trace: trace ?? null };
  });
  const missingTraces = rows.filter((row) => row.traceState === 'missing').length;
  const incompleteTraces = rows.filter((row) => row.trace && (row.trace.pendingSpans > 0 || row.trace.droppedSpans > 0)).length;
  const document = { schema: 1, diagnosticOnly: true, performanceAcceptance: false, sinkLossCountersAvailable: false,
    // Sink backpressure drops are not reported by the existing logger; never call missing records zero loss.
    missingReason: 'unsampled_or_sink_drop_or_incomplete_handler', cap: 200, sampleCount: rows.length,
    missingTraces, duplicateTraces: duplicates.size, incompleteTraces, ...counters,
    observationOk: facts.complete && facts.correlationComplete && rows.length === 200 && missingTraces === 0 && duplicates.size === 0 && incompleteTraces === 0 && counters.malformedRecords === 0 && counters.wrongGatewayRecords === 0 && counters.missingLogs === 0, rows };
  await writeFile(artifactFile, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { file: artifactFile, observationOk: document.observationOk, sampleCount: rows.length, missingTraces,
    duplicateTraces: duplicates.size, incompleteTraces, ...counters };
}
const REQUEST_STATES_SQL = `SELECT r.id::text AS request_id,
       r.execution_state, r.financial_status, r.reconciliation_state,
       r.created_at::text AS request_created_at,
       r.updated_at::text AS request_updated_at,
       a.id::text AS attempt_id, a.ordinal,
       a.dispatch_state, a.result_state,
       a.response_started, a.result_http_status,
       a.created_at::text AS attempt_created_at,
       a.updated_at::text AS attempt_updated_at,
       a.response_started_at::text AS response_started_at,
       e.status AS evidence_status,
       e.created_at::text AS evidence_created_at,
       e.claimed_at::text AS evidence_claimed_at
FROM saas_requests r
LEFT JOIN saas_attempts a
  ON a.tenant_id = r.tenant_id AND a.request_id = r.id
LEFT JOIN saas_prepared_request_evidence e
  ON e.tenant_id = a.tenant_id
 AND e.request_id = r.id AND e.attempt_id = a.id
WHERE r.tenant_id = $1::uuid
  AND r.id = ANY($2::uuid[])
ORDER BY r.id, a.ordinal
LIMIT 201`;

function requestObservationSqlState(error) {
  const allowed = ['42501', '42P01', '42703', '42883', '25006', '57014', '55P03', '40001', '40P01',
    '08001', '08006', '57P01', '53300'];
  if (error === null || typeof error !== 'object') return null;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return allowed.includes(code) ? code : null;
}

function validateRequestSampleJournal(journal) {
  assert.ok(journal && journal.schema === 1 && journal.cap === 400 && typeof journal.observationOk === 'boolean');
  assert.ok(Array.isArray(journal.samples) && journal.samples.length <= 400);
  const counts = { 'latency:direct': 0, 'latency:gateway': 0, 'ttfb:direct': 0, 'ttfb:gateway': 0 };
  const indices = new Set();
  const ids = [];
  let missingRequestIds = 0;
  let invalidRequestIds = 0;
  for (const sample of journal.samples) {
    assert.ok(sample && typeof sample === 'object');
    const leg = `${sample.scenario}:${sample.leg}`;
    assert.ok(Object.hasOwn(counts, leg) && Number.isInteger(sample.index) && sample.index >= 0 && sample.index < 100);
    assert.ok(!indices.has(`${leg}:${sample.index}`));
    indices.add(`${leg}:${sample.index}`);
    counts[leg]++;
    assert.ok(sample.metricMs === null || (Number.isFinite(sample.metricMs) && sample.metricMs >= 0));
    assert.ok(sample.status === null || (Number.isInteger(sample.status) && sample.status >= 100 && sample.status <= 599));
    assert.ok(['ok', 'http_error', 'timeout', 'empty_chunk', 'network_error', 'cancel_error', 'body_drain_error'].includes(sample.outcome));
    assert.equal(typeof sample.includedInSummary, 'boolean');
    if (sample.includedInSummary) assert.ok(sample.status === 200 && sample.outcome === 'ok' && sample.metricMs !== null);
    for (const clock of [sample.startedAt, sample.recordedAt]) {
      assert.ok(typeof clock === 'string' && clock.length <= 32 && Number.isFinite(Date.parse(clock)));
    }
    if (sample.leg === 'direct') {
      assert.ok(sample.gatewayIndex === null && sample.requestId === null && sample.requestIdState === 'not_applicable');
    } else {
      assert.ok([0, 1, 2].includes(sample.gatewayIndex));
      assert.ok(['valid', 'missing', 'invalid'].includes(sample.requestIdState));
      if (sample.requestIdState === 'valid') {
        assert.ok(typeof sample.requestId === 'string' && sample.requestId.length === 36 && REQUEST_SAMPLE_UUID.test(sample.requestId));
        ids.push(sample.requestId.toLowerCase());
      } else {
        assert.equal(sample.requestId, null);
        if (sample.requestIdState === 'missing') missingRequestIds++;
        else invalidRequestIds++;
      }
    }
  }
  const requestIds = [...new Set(ids)];
  assert.ok(requestIds.length <= 200);
  const complete = journal.samples.length === 400 && Object.values(counts).every((count) => count === 100);
  const correlationComplete = counts['latency:gateway'] + counts['ttfb:gateway'] === 200 && ids.length === 200 && requestIds.length === 200;
  return { sampleCount: journal.samples.length, counts, complete, correlationComplete, missingRequestIds, invalidRequestIds,
    duplicateRequestIds: ids.length - requestIds.length, childObservationOk: journal.observationOk, requestIds };
}

function projectRequestStateRows(sourceRows, requestIds) {
  assert.ok(Array.isArray(sourceRows) && sourceRows.length <= 201);
  const columns = ['request_id', 'execution_state', 'financial_status', 'reconciliation_state', 'request_created_at',
    'request_updated_at', 'attempt_id', 'ordinal', 'dispatch_state', 'result_state', 'response_started', 'result_http_status',
    'attempt_created_at', 'attempt_updated_at', 'response_started_at', 'evidence_status', 'evidence_created_at', 'evidence_claimed_at'];
  const requested = new Set(requestIds);
  const rows = sourceRows.slice(0, 200).map((row) => {
    assert.ok(row && requested.has(row.request_id));
    assert.ok(row.attempt_id === null || (typeof row.attempt_id === 'string' && REQUEST_SAMPLE_UUID.test(row.attempt_id)));
    return Object.fromEntries(columns.map((column) => {
      const value = row[column];
      assert.ok(value === null || typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && value.length <= 128));
      return [column, value];
    }));
  });
  const returned = new Set(rows.map((row) => row.request_id));
  const attempts = new Map();
  const evidenceCounts = new Map();
  for (const row of rows) {
    if (row.attempt_id === null) continue;
    if (!attempts.has(row.request_id)) attempts.set(row.request_id, new Set());
    attempts.get(row.request_id).add(row.attempt_id);
    const key = `${row.request_id}:${row.attempt_id}`;
    evidenceCounts.set(key, (evidenceCounts.get(key) ?? 0) + 1);
  }
  const truncated = sourceRows.length === 201;
  return { rows, observedRowCount: sourceRows.length, truncated, returnedRequestIds: [...returned],
    missingRequestIds: truncated ? null : requestIds.filter((id) => !returned.has(id)),
    multipleAttemptRequestIds: [...attempts].filter(([, ids]) => ids.size > 1).map(([id]) => id),
    multipleEvidenceRequestIds: [...new Set(rows.filter((row) => (evidenceCounts.get(`${row.request_id}:${row.attempt_id}`) ?? 0) > 1).map((row) => row.request_id))],
    pendingRequestIds: [...new Set(rows.filter((row) => row.execution_state !== 'succeeded' || row.financial_status !== 'settled').map((row) => row.request_id))] };
}

async function exportRequestSampleStates(connection, tenantId, samplesFile, statesFile) {
  const observation = { schema: 1, observationOk: true, failure: null, clientSamplesFile: samplesFile ?? null, client: null,
    database: { queryAttempted: false, queryCompleted: false, role: 'model_router_saas_migrator', readOnly: true,
      rowCap: 200, sentinelLimit: 201, rows: [], truncated: null, missingRequestIds: null },
    boundaries: ['Existing state timestamps are state writes, not socket milestones',
      'Request creation uses the application clock; evidence creation uses transaction time; claimed_at uses the PostgreSQL clock',
      'response_started_at is a persisted dispatch transition; updated_at is the latest state write',
      'Ingress, authentication and preparation before request creation remain unmeasured',
      'Client wall clocks and PostgreSQL timestamps are not a synchronized duration trace; aggregate metrics are not request correlated'] };
  let stage = 'client_sample_read';
  let file;
  try {
    assert.ok(connection && typeof tenantId === 'string' && REQUEST_SAMPLE_UUID.test(tenantId) && samplesFile);
    file = await open(samplesFile, 'r');
    assert.ok((await file.stat()).size <= 512 * 1024);
    const journal = JSON.parse(await file.readFile('utf8'));
    await file.close();
    file = undefined;
    stage = 'client_sample_validation';
    observation.client = validateRequestSampleJournal(journal);
    const { requestIds } = observation.client;
    if (!observation.client.complete || !observation.client.correlationComplete || !observation.client.childObservationOk) {
      observation.observationOk = false;
      observation.failure = { stage: 'client_sample_completeness', sqlState: null };
    }
    if (requestIds.length > 0) {
      stage = 'request_states_query';
      observation.database.queryAttempted = true;
      const result = await connection.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        return tx.query(REQUEST_STATES_SQL, [tenantId, requestIds]);
      });
      observation.database.queryCompleted = true;
      stage = 'request_states_projection';
      Object.assign(observation.database, projectRequestStateRows(result.rows, requestIds));
      const facts = observation.database;
      if (facts.truncated || facts.multipleAttemptRequestIds.length || facts.multipleEvidenceRequestIds.length || facts.missingRequestIds.length) {
        observation.observationOk = false;
        observation.failure ??= { stage: facts.truncated ? 'request_states_truncated' : 'request_states_incomplete', sqlState: null };
      }
    } else {
      observation.observationOk = false;
      observation.failure ??= { stage: 'request_ids_unavailable', sqlState: null };
    }
  } catch (error) {
    observation.observationOk = false;
    observation.failure = { stage, sqlState: requestObservationSqlState(error) };
  } finally {
    if (file) await file.close().catch(() => {});
  }
  try {
    await writeFile(statesFile, `${JSON.stringify(observation, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { observationOk: observation.observationOk, failure: observation.failure, clientSamplesFile: observation.clientSamplesFile, statesFile };
  } catch {
    return { observationOk: false, failure: { stage: 'request_states_write', sqlState: null }, clientSamplesFile: observation.clientSamplesFile, statesFile: null };
  }
}

async function hashTree(directory) {
  const results = {};
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) results[path.slice(root.length + 1)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await walk(directory);
  return results;
}
async function hashHarness() {
  const files = ['scripts/ops/run-current-r9.mjs', 'scripts/ops/bench-gateway.mjs', 'deploy/compose/mock-upstream.mjs',
    'scripts/ops/redis-saas-recovery-profile.mjs',
    'scripts/ops/postgres-saas-recovery-profile.mjs',
    'deploy/managed-saas-postgres-roles.sql', 'package-lock.json'];
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
}

// Recheck observed counters independently of driver exit/violation bookkeeping.
// This managed runner chooses the existing default zero-error budgets.
function validObservedLoadCounters(report, requestedScenario) {
  const scenarios = report?.scenarios;
  if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) return false;
  const requested = requestedScenario === 'all' ? ['concurrency', 'scaling'] : String(requestedScenario).split(',');
  const names = ['concurrency', 'scaling'].filter((name) => requested.includes(name) || Object.hasOwn(scenarios, name));
  if (names.length === 0) return true;
  if (report.config?.maxTransportErrors !== 0 || report.config?.maxUnexpected5xx !== 0) return false;
  for (const name of names) {
    const measured = scenarios[name];
    const statuses = measured?.statuses;
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
    let total = 0;
    let unexpected5xx = 0;
    for (const [status, count] of Object.entries(statuses)) {
      if (status !== 'transport-error' && !/^[1-5]\d\d$/.test(status)) return false;
      if (!Number.isSafeInteger(count) || count < 0) return false;
      total += count;
      if (!Number.isSafeInteger(total)) return false;
      if (Number(status) >= 500) unexpected5xx += count;
    }
    const bucketTransportErrors = Object.hasOwn(statuses, 'transport-error') ? statuses['transport-error'] : 0;
    const transportErrors = name === 'concurrency' ? measured.transportErrors : bucketTransportErrors;
    if (!Number.isSafeInteger(transportErrors) || transportErrors < 0 || transportErrors > 0 || unexpected5xx > 0) return false;
    if (Object.hasOwn(statuses, 'transport-error') && bucketTransportErrors !== transportErrors) return false;
    const successes = Object.hasOwn(statuses, '200') ? statuses['200'] : 0;
    if (!Number.isSafeInteger(successes) || successes <= 0 || measured.latency?.n !== successes ||
        !Number.isFinite(measured.throughputRps) || measured.throughputRps <= 0) return false;
  }
  return true;
}

// Sample evidence is independent of exit status and driver violation bookkeeping.
function observedSampleSufficiency(report, requestedScenario, profile = {}) {
  const applicable = !profile.diagnostic || Boolean(profile.capProfile);
  const legs = [];
  const requested = requestedScenario === 'all' ? ['latency', 'ttfb', 'concurrency', 'scaling'] : String(requestedScenario).split(',');
  const scenarios = report?.scenarios ?? {};
  const add = (scenario, leg, required, observed, complete = true) => {
    legs.push({ scenario, leg, required: Number.isSafeInteger(required) && required >= 0 ? required : null,
      observed: Number.isSafeInteger(observed) && observed >= 0 ? observed : null,
      sufficient: Number.isSafeInteger(required) && required >= 100 && Number.isSafeInteger(observed) &&
        observed >= required && complete });
  };
  if (applicable) {
    for (const name of ['latency', 'ttfb', 'concurrency', 'scaling']) {
      if (!requested.includes(name) && !Object.hasOwn(scenarios, name)) continue;
      const measured = scenarios[name];
      if (name === 'latency' || name === 'ttfb') {
        const required = name === 'latency' ? report?.config?.requests : report?.config?.streamSamples;
        for (const leg of ['direct', 'gateway']) {
          const observed = measured?.[leg]?.n;
          add(name, leg, required, observed, observed === required &&
            (name !== 'ttfb' || (measured?.gatewayErrors === 0 && Number.isFinite(measured?.ttfbOverheadMs))));
        }
      } else {
        const observed = measured?.statuses?.['200'];
        add(name, 'gateway', 100, observed, measured?.latency?.n === observed &&
          (name !== 'concurrency' || (measured?.acceptedLatency?.n === observed &&
            measured?.acceptedLatency?.measurement === 'request-start-through-response-body')));
      }
    }
  }
  return { applicable, legs, sufficient: legs.every((leg) => leg.sufficient) };
}

function capProfileEvidence(report) {
  const measured = report?.scenarios?.concurrency;
  const statuses = measured?.statuses ?? {};
  const successfulRequests = statuses['200'] ?? 0;
  const rejected429 = statuses['429'] ?? 0;
  const httpResponses = Object.values(statuses).reduce((sum, count) => sum + count, 0);
  const transportErrors = measured?.transportErrors ?? null;
  const attempts = httpResponses + (transportErrors ?? 0);
  return { diagnosticOnly: true, performanceAcceptance: false,
    configurationUnchanged: report?.config?.inflight === 200 && report?.config?.concurrencySeconds === 60 &&
      report?.config?.p99OverheadMs === 30 && report?.config?.ttfbOverheadMs === 10 && report?.config?.noFail === false,
    successfulRequests, successfulRps: measured?.throughputRps ?? null,
    acceptedLatency: measured?.acceptedLatency ?? null, acceptedHeaderLatency: measured?.latency ?? null,
    rejected429, rejected429Ratio: attempts > 0 ? rejected429 / attempts : null,
    unexpected5xx: Object.entries(statuses).filter(([status]) => /^5\d\d$/.test(status)).reduce((sum, [, count]) => sum + count, 0),
    transportErrors, statuses,
    successfulSampleSufficiency: { minimum: 100, observed: successfulRequests, sufficient: successfulRequests >= 100 },
    capacityRecommendation: null };
}

function startCapProfileResources() {
  const samples = [];
  let droppedSamples = 0;
  const sample = () => {
    if (samples.length >= 32) { droppedSamples++; return; }
    const processors = cpus();
    const cpuTimeMs = processors.reduce((sum, cpu) => {
      for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) sum[key] += cpu.times[key];
      return sum;
    }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
    samples.push({ at: new Date().toISOString(), cpuCount: processors.length, cpuTimeMs,
      loadAverage: loadavg(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() });
  };
  sample();
  const timer = setInterval(sample, 5000);
  timer.unref();
  return { stop() {
    clearInterval(timer); sample();
    return { scope: 'host-cumulative-cpu-load-memory', intervalMs: 5000, cap: 32, droppedSamples,
      processCpuAndIoObserved: false, resourceContentionConclusion: null, samples };
  } };
}

async function runFullR9Benchmarks(inventory, gatewayUrls, benchmark) {
  for (const route of inventory) {
    const baseline = await benchmark(`${route.protocol}-scaling-1cli`, gatewayUrls.slice(0, 1), ['--scenario','scaling','--scaling-inflight','200','--scaling-seconds','120'], route);
    if (!baseline.ok) break;
    const full = await benchmark(`${route.protocol}-r9-3cli`, gatewayUrls, ['--scenario','all','--inflight','200','--concurrency-seconds','60','--scaling-inflight','200','--scaling-seconds','120','--baseline-report',baseline.reportFile,'--sse-minutes','10'], route);
    if (!full.ok) break;
  }
}

function firstFault(stage, message) { manifest.firstFault ??= { stage, message }; }
async function run(stage, command, commandArgs, env = baseEnvironment, timeoutMs = 180_000) {
  assert.equal(interrupted, false, 'R9 supervisor interrupted');
  const logPath = join(outputDir, `${stage}.log`);
  const log = await open(logPath, 'w', 0o600);
  const startedAt = new Date().toISOString();
  try {
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(command, commandArgs, { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
      activeRuns.add(child);
      const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.once('error', reject);
      child.once('close', (code, signal) => { clearTimeout(timeout); activeRuns.delete(child); resolveRun({ code, signal }); });
    });
    manifest.stages.push({ stage, startedAt, finishedAt: new Date().toISOString(), ...result, log: logPath });
    return result;
  } finally { await log.close(); }
}
async function requireRun(stage, command, commandArgs, env = baseEnvironment, timeoutMs) {
  const result = await run(stage, command, commandArgs, env, timeoutMs);
  if (result.code !== 0) { firstFault(stage, `Command exited ${result.code}; see ${stage}.log`); throw new Error(`${stage} failed`); }
}
async function launch(stage, command, commandArgs, env) {
  const log = await open(join(outputDir, `${stage}.log`), 'w', 0o600);
  const child = spawn(command, commandArgs, { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
  const owned = { stage, child, log };
  children.push(owned);
  return child;
}
// Count observed upstream attempts, not configured benchmark samples. Both
// direct legs are unauthenticated and recorded by the mock as "(anonymous)";
// subtracting a configured count is wrong for streaming and partial failures.
function gatewayCensusRequestCount(mockStats) {
  assert.ok(mockStats?.accounts && typeof mockStats.accounts === 'object' && !Array.isArray(mockStats.accounts),
    'Statement census requires observed mock account counters');
  let requests = 0;
  for (const [account, row] of Object.entries(mockStats.accounts)) {
    assert.ok(row && Number.isSafeInteger(row.requests) && row.requests >= 0,
      'Statement census encountered an invalid request counter');
    if (account === '(anonymous)') continue;
    requests += row.requests;
    assert.ok(Number.isSafeInteger(requests), 'Statement census request count exceeds safe integer bounds');
  }
  assert.ok(requests > 0, 'Statement census requires at least one observed gateway upstream request');
  return requests;
}

// Dependency injection keeps the real exporter executable in offline tests,
// without launching the supervisor, PostgreSQL or any upstream provider.
async function exportPgStatementCensus(createDatabase, connectionString, directory) {
  const censusDb = createDatabase({ connectionString, max: 1 });
  try {
    const total = (await censusDb.query('SELECT COALESCE(sum(calls),0)::bigint AS calls, COALESCE(sum(total_exec_time),0)::double precision AS exec_ms FROM public.pg_stat_statements')).rows[0];
    const top = (await censusDb.query('SELECT queryid, calls, round(total_exec_time::numeric,1) AS exec_ms, left(query, 120) AS query FROM public.pg_stat_statements ORDER BY calls DESC LIMIT 20')).rows;
    assert.ok(total && Number.isSafeInteger(Number(total.calls)) && Number(total.calls) >= 0 &&
      Number.isFinite(Number(total.exec_ms)) && Number(total.exec_ms) >= 0 && Array.isArray(top),
      'Statement census returned invalid SQL counters');
    const mockStats = JSON.parse(await readFile(join(directory, 'final-mock-stats.json'), 'utf8'));
    const requests = gatewayCensusRequestCount(mockStats);
    const callsPerRequest = Number((Number(total.calls) / requests).toFixed(1));
    const evidence = { schema: 2, normalization: 'observed-authenticated-mock-upstream-attempts', total, requests, callsPerRequest, top };
    await writeFile(join(directory, 'pg-stat-statements.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    return { observationOk: true, calls: total.calls, execMs: total.exec_ms, requests, callsPerRequest };
  } finally {
    // A cleanup error also invalidates this requested observation. Do not
    // silently certify an exporter whose database connection was not closed.
    await censusDb.close();
  }
}

function pgStatementCensusSatisfied(required, observation) {
  return !required || (observation?.observationOk === true && Number.isSafeInteger(observation.requests) &&
    observation.requests > 0 && Number.isFinite(observation.callsPerRequest) && observation.callsPerRequest >= 0);
}

async function closeOwned() {
  await Promise.allSettled(children.map(async ({ child, log }) => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      timeout.unref();
      try { await closed; } finally { clearTimeout(timeout); }
    }
    await log.close();
  }));
  manifest.cleanup.processesStopped = children.every(({ child }) => child.exitCode !== null || child.signalCode !== null);
  if (database) await database.close();
  if (process.env.R9_PG_STAT_STATEMENTS === '1') {
    try {
      assert.ok(pgStarted && !interrupted && censusDatabaseUrl,
        'Requested statement census unavailable because PostgreSQL did not start or the run was interrupted');
      const { createSaasDatabase } = await import(pathToFileURL(join(root, 'dist/saas/db/index.js')).href);
      manifest.pgStatementCensus = await exportPgStatementCensus(createSaasDatabase, censusDatabaseUrl(), outputDir);
    } catch (error) {
      manifest.pgStatementCensus = { observationOk: false, error: String(error?.message ?? error) };
      firstFault('pg-statement-census', 'Requested statement census export failed; see pgStatementCensus');
    }
  }
  if (pgStarted) {
    const log = await open(join(outputDir, 'stop-postgres.log'), 'w', 0o600);
    try {
      const stopped = spawn(join(pgBin, 'pg_ctl'), ['-D', dataDir, '-w', '-m', 'fast', 'stop'], { env: baseEnvironment, stdio: ['ignore', log.fd, log.fd] });
      const [code] = await once(stopped, 'close');
      manifest.cleanup.postgresStopped = code === 0;
    } finally { await log.close(); }
  } else manifest.cleanup.postgresStopped = true;
  if (manifest.cleanup.postgresStopped && manifest.cleanup.processesStopped) {
    await rm(runtimeDir, { recursive: true, force: true });
    manifest.cleanup.runtimeRemoved = true;
  }
}
const onInterrupt = () => { interrupted = true; recoveryAbort.abort(new Error('Owned recovery interrupted')); for (const child of activeRuns) child.kill('SIGTERM'); };
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return [5432, 6379, 15005, 15006, 15007, 15008, 15009, 18080, 18443].includes(port) ? freePort() : port;
}
async function waitFor(label, action, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    assert.equal(interrupted, false, 'R9 supervisor interrupted');
    if (await action()) return;
    await delay(100);
  } while (Date.now() < deadline);
  firstFault(label, 'Readiness deadline expired');
  throw new Error(`${label} readiness deadline expired`);
}

// The standard control-plane contract is two bound TCP listeners, not a gateway /readyz route.
async function ownedControlPlaneListenersReady(child, ports) {
  assert.equal(child.exitCode, null, 'Owned standard control-plane CLI exited');
  assert.equal(child.signalCode, null, 'Owned standard control-plane CLI was signalled');
  assert.ok(ports.length === 2 && new Set(ports).size === 2 &&
    ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535));
  const connected = await Promise.all(ports.map((port) => new Promise((resolveConnected) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true; socket.destroy(); resolveConnected(ready);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.once('close', () => finish(false));
  })));
  assert.equal(child.exitCode, null, 'Owned standard control-plane CLI exited during listener readiness');
  assert.equal(child.signalCode, null, 'Owned standard control-plane CLI was signalled during listener readiness');
  return connected.every(Boolean);
}

// Serialized into a temporary reviewed operator module. It imports the CURRENT
// built signer/entitlement/target implementations, never copies canonical bytes.
async function createR9TestRuntime(options) {
  const { readFile } = await import('node:fs/promises');
  const { createPrivateKey, createPublicKey, randomUUID } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const load = (name) => import(pathToFileURL(`${options.env.R9_TEST_DIST}/${name}`).href);
  const { createBuiltinGatewayEntitlementResolver } = await load('saas/runtime/builtin-gateway-runtime.js');
  const { TrustedPreparedRequestVerifierKeyRegistry } = await load('saas/runtime/prepared-evidence-verifier-keys.js');
  const { PreparedRequestEvidenceSigner } = await load('saas/runtime/prepared-request-evidence-signer.js');
  const config = JSON.parse(await readFile(options.env.R9_TEST_CONFIG, 'utf8'));
  const registry = new TrustedPreparedRequestVerifierKeyRegistry({ keys: [{ keyId: 'r9-local-test',
    publicKey: createPublicKey(await readFile(config.publicKeyFile)), status: 'active' }] });
  const signer = new PreparedRequestEvidenceSigner({ registry, verifierKeyId: 'r9-local-test', privateKey: createPrivateKey(await readFile(config.privateKeyFile)) });
  const endpointPolicy = { allowedHosts: ['127.0.0.1'], allowedPorts: [config.mockPort] };
  // The explicit operator egress allowlist permits this one loopback address;
  // the core transport still checks TLS, exact host/port and address pinning.
  // No test-runner capability or environment marker is fabricated.
  const targets = { resolve(input) {
    const route = config.routes.find((entry) => entry.poolId === input.upstreamId && entry.productId === (input.productId ?? input.product) && entry.protocol === input.protocol);
    if (!route || input.operation !== (route.protocol === 'openai' ? 'chat.completions' : 'messages')) throw new Error('R9 fixed mock target is unavailable');
    return { url: `https://127.0.0.1:${config.mockPort}${route.endpoint}`, method: 'POST', endpointPolicy };
  } };
  return { dependencies: {
    entitlementResolver: createBuiltinGatewayEntitlementResolver(options.database),
    schedulerAuthorities: { affinityKeyring: { activeKeyVersion: 'r9-test-v1', keys: [{ version: 'r9-test-v1', key: Buffer.from(config.affinityKey, 'base64') }] }, leaseConcurrencyLimit: 64 },
    idempotencyHmacKey: Buffer.from(config.idempotencyKey, 'base64'),
    providerPreparationRoute: async ({ authority }) => ({ clientProtocol: authority.route.protocol, providerProtocol: authority.route.protocol,
      clientOperation: authority.route.protocol === 'openai' ? 'chat.completions' : 'messages',
      providerOperation: authority.route.protocol === 'openai' ? 'chat.completions' : 'messages', modelResolution: authority.modelResolution }),
    providerPayload: { estimator: { version: 'r9-local-mock-upper-bound/v1', estimate: () => ({ inputTotalUpperBound: 4096,
      inputUncachedUpperBound: 4096, cacheReadUpperBound: 0, cacheWriteUpperBound: 0, cacheWrite5mUpperBound: 0,
      cacheWrite1hUpperBound: 0, outputTotalUpperBound: 4096, reasoningOutputUpperBound: 0, feasibleInputBuckets: ['input'] }) },
      modelCompatibility: (input) => config.routes.some((route) => route.providerId === input.providerId && route.productId === input.productId && route.providerModel === input.providerModel && route.protocol === input.providerProtocol),
      maxPayloadBytes: 1048576, compilerVersion: 'r9-local-mock-test-compiler/v1' },
    evidenceSigner: signer, evidenceVerifierKeyId: 'r9-local-test',
    idFactory: { requestId: randomUUID, attemptId: randomUUID, evidenceId: randomUUID },
    trustedVerifierPublicKeys: new Map([['r9-local-test', createPublicKey(await readFile(config.publicKeyFile))]]),
    providerTargetResolver: targets,
    providerTargetRoute: async (input) => { const route = config.routes.find((route) => route.poolId === input.upstreamId);
      return route ? { productId: route.productId, providerProtocol: route.protocol, providerOperation: route.protocol === 'openai' ? 'chat.completions' : 'messages' } : null; },
    resolveAuthenticationHeader: async () => 'authorization', fetch: globalThis.fetch, endpointPolicy,
    timeoutMs: 60000, maxConcurrency: 64, leaseTtlMs: 90000, maxBodyBytes: 1048576,
    entryPoint: 'r9-current-build-mock-test-assembly',
  }, checkReady: async () => {}, close: async () => {} };
}

async function seedMockInventory(url, kmsEnv) {
  const load = (name) => import(pathToFileURL(join(root, 'dist', name)).href);
  const { createSaasDatabase } = await load('saas/db/index.js');
  const { SaasIdentityService } = await load('saas/identity/service.js');
  const { SaasCatalogService } = await load('saas/catalog/service.js');
  const { SaasProjectInferencePolicyService } = await load('saas/gateway/project-policy-service.js');
  const { SaasPricingService } = await load('saas/pricing/service.js');
  const { SaasCommercialMeteringPolicyService, canonicalContractAttestationPayload } = await load('saas/gateway/commercial-metering-policy-service.js');
  const { SaasRouteConfigService } = await load('saas/gateway/route-config-service.js');
  const { ProviderSupplyService } = await load('saas/supply/service.js');
  const { createProviderCredentialSealingKms } = await load('saas/runtime/software-provider-credential-kms.js');
  const { KeyService } = await load('saas/keys/service.js');
  const { PostgresSupplyProfileResolver } = await load('saas/keys/resolver.js');
  const { PlatformWalletLedgerService } = await load('saas/billing/service.js');
  database = createSaasDatabase({ connectionString: url, max: 2 });
  await database.verifySchema();
  assert.equal((await database.query('SHOW fsync')).rows[0]?.fsync, 'on', 'R9 must retain PostgreSQL durable writes');
  assert.equal((await database.query('SHOW synchronous_commit')).rows[0]?.synchronous_commit, 'on', 'R9 must retain synchronous commits');
  const identity = new SaasIdentityService(database);
  const bootstrap = await identity.issueBootstrapToken();
  const admin = await identity.bootstrapPlatformAdmin({ token: bootstrap.token, email: `r9-${randomUUID()}@example.test`, displayName: 'Disposable R9 test fixture', password: `${randomUUID()}-Local-Test!` });
  const tenant = await identity.createTenant(admin.id, { name: 'Disposable R9 test assembly', slug: `r9-${randomUUID()}` });
  const project = await identity.createProject(admin.id, tenant.id, { name: 'R9 current build', slug: `r9-${randomUUID()}` });
  const context = await identity.resolveTenantContext({ userId: admin.id, tenantId: tenant.id, projectId: project.id });
  const audit = { actorUserId: admin.id, requestId: randomUUID(), entryPoint: 'r9-mock-test-migrator-fixture' };
  const policy = await new SaasProjectInferencePolicyService(database).enable({ tenantId: tenant.id, projectId: project.id, expectedVersion: 1, audit });
  const profileId = `r9-profile-${randomUUID()}`;
  const models = ['r9-openai-model', 'r9-anthropic-model'];
  const now = new Date();
  const effectiveAt = new Date(now.getTime() - 60000).toISOString();
  await database.query(`INSERT INTO saas_supply_profiles(tenant_id,id,supply_mode,status,model_scopes,authz_version,created_at,updated_at,last_audited_at)
    VALUES($1,$2,'platform','active',$3,1,$4,$4,$4)`, [tenant.id, profileId, models, now.toISOString()]);
  await database.query(`INSERT INTO saas_project_entitlements(id,tenant_id,project_id,supply_profile_id,supply_mode,status,model_scopes,authz_version,created_at,updated_at,last_audited_at,effective_at,expires_at,source_type)
    VALUES($1,$2,$3,$4,'platform','active',$5,1,$6,$6,$6,$7,$8,'admin_grant')`, [randomUUID(), tenant.id, project.id, profileId, models, now.toISOString(), effectiveAt, new Date(now.getTime() + 86400000).toISOString()]);
  const catalog = new SaasCatalogService(database);
  const pricing = new SaasPricingService(database);
  const sealing = await createProviderCredentialSealingKms({ env: kmsEnv });
  const supply = new ProviderSupplyService(database, { deployment: 'r9-current-test', environment: 'test', kmsKeyId: 'r9-local-test', sealingKms: sealing });
  const contractKeys = generateKeyPairSync('ed25519');
  const commercial = new SaasCommercialMeteringPolicyService(database, { trustedVerifierPublicKeys: new Map([['r9-contract-local-test', contractKeys.publicKey]]), trustedTestVectorDigests: new Map([['r9-local-test-v1', 'c'.repeat(64)]]) });
  const routes = new SaasRouteConfigService(database);
  const inventory = [];
  for (const protocol of ['openai', 'anthropic']) {
    const providerId = `r9-mock-${protocol}`;
    const productId = `r9-product-${protocol}`;
    const providerModel = `r9-provider-model-${protocol}`;
    const publicModelId = `r9-public-model-${protocol}`;
    const publicModel = `r9-${protocol}-model`;
    const endpoint = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages';
    const poolId = `r9-pool-${protocol}`;
    await catalog.registerProviderProduct({ providerId, productId, displayName: `R9 ${protocol} MOCK TEST` });
    await catalog.registerPublicModelAlias({ publicModelId, alias: publicModel, displayName: 'R9 mock model', providerId, productId, model: providerModel, endpointScope: [endpoint] });
    const capability = await catalog.registerProviderCapability({ providerId, productId, model: providerModel, endpoint, protocol, supportLevel: 'supported', validationState: 'verified', evidenceVersion: 'r9-test-v1', discoverySource: 'manual', evidenceReference: 'mock-test-only', evidenceSha256: 'a'.repeat(64) });
    const rights = await catalog.registerProviderRightsVersion({ rightsId: `r9-rights-${protocol}`, providerId, productId, credentialType: 'api-key', supplyMode: 'platform', region: 'r9-test', purpose: 'inference', modelScope: [providerModel], endpointScope: [endpoint], effectiveAt, approvalReference: 'mock-test-only', status: 'active', evidenceReference: 'mock-test-only', evidenceSha256: 'b'.repeat(64), audit });
    const common = { publicModelId, publicModelVersion: 1, providerId, productId, protocol, endpoint, currency: 'USD', commercialPolicyVersion: `r9-commercial-${protocol}`, calculatorVersion: 'r9-test-v1', roundingVersion: 'r9-test-v1', roundingMode: 'half_up', roundingBoundary: 'total', effectiveAt };
    const rates = (input, output) => Object.fromEntries(['input','cache_read','cache_write','cache_write_5m','cache_write_1h','output'].map((dimension) => [dimension, { numeratorMinorUnits: dimension === 'output' ? output : input, denominatorUnits: 1 }]));
    const price = await pricing.appendCustomerPriceVersion({ ...common, rates: rates(2, 3), idempotencyKey: `r9-price-${protocol}` });
    const cost = await pricing.appendSupplierCostVersion({ ...common, resolvedModel: providerModel, rates: rates(1, 1), idempotencyKey: `r9-cost-${protocol}` });
    const customerDefinition = { publicModelId, publicModelVersion: 1, protocol, endpoint, supplyMode: 'platform', targetMode: 'platform_pool', customerPriceVersion: price.id, usageDimensions: ['input_total', 'output_total'], tokenSource: 'upstream', roundingVersion: 'r9-test-v1', roundingMode: 'half_up', roundingBoundary: 'total', commercialPolicyVersion: common.commercialPolicyVersion };
    const providerDefinition = { ...customerDefinition, providerId, productId, resolvedModel: providerModel, supplierCostVersion: cost.id };
    const customerPolicyId = `r9-customer-policy-${protocol}`;
    const providerPolicyId = `r9-provider-policy-${protocol}`;
    const scope = { tenantId: tenant.id, projectId: project.id, audit };
    await commercial.createCustomerPolicy({ ...scope, policyId: customerPolicyId, definition: customerDefinition });
    await commercial.createProviderPolicy({ ...scope, policyId: providerPolicyId, definition: providerDefinition });
    const cp = await commercial.publishCustomerPolicy({ ...scope, policyId: customerPolicyId, expectedVersion: 1, definition: customerDefinition });
    const pp = await commercial.publishProviderPolicy({ ...scope, policyId: providerPolicyId, expectedVersion: 1, definition: providerDefinition });
    const attestation = { contractDigest: 'd'.repeat(64), suiteVersion: 'r9-local-test-v1', testVectorDigest: 'c'.repeat(64), providerPolicyId, providerPolicyVersion: pp.version, publicModelId, publicModelVersion: '1', protocol, endpoint, supplyMode: 'platform', targetMode: 'platform_pool', usageDimensions: customerDefinition.usageDimensions, tokenSource: 'upstream', roundingVersion: 'r9-test-v1', roundingMode: 'half_up', roundingBoundary: 'total' };
    const attestationId = `r9-attestation-${protocol}`;
    await commercial.attestProviderContract({ ...scope, id: attestationId, ...attestation, publicModelVersion: 1, verifierKeyId: 'r9-contract-local-test', signatureBase64: sign(null, Buffer.from(canonicalContractAttestationPayload(attestation)), contractKeys.privateKey).toString('base64') });
    const definition = { publicModelId, publicModelVersion: 1, protocol, supplyMode: 'platform', targetMode: 'platform_pool', upstreamId: poolId, endpoint };
    const routeId = `r9-route-${protocol}`;
    await routes.create({ ...scope, routeId, definition });
    const published = await routes.publish({ ...scope, routeId, expectedVersion: 1, definition });
    await commercial.bindRoute({ ...scope, routeId, routeVersion: published.version, customerPolicyId, customerPolicyVersion: cp.version, providerPolicyId, providerPolicyVersion: pp.version, contractAttestationId: attestationId });
    const accountIds = [];
    for (let index = 1; index <= 4; index += 1) {
      const accountId = `r9-${protocol}-account-${index}`;
      const account = await supply.createPlatformProviderAccount({ id: accountId, displayName: 'R9 synthetic mock account', providerId, productId, credentialType: 'api-key', region: 'r9-test', purpose: 'inference', rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model: providerModel, endpoint, version: capability.version }], audit });
      const active = await supply.setProviderAccountValidation({ accountId, validationState: 'verified', expectedAuthzVersion: account.authzVersion });
      const secret = Buffer.from(accountId);
      let credential;
      try { credential = await supply.createPlatformProviderCredential({ accountId, secret, audit }); } finally { secret.fill(0); }
      // Deliberate mock fixture validation; no real provider or worker starts.
      await database.query(`UPDATE saas_platform_provider_credentials SET status='active',validation_state='verified',validation_error_code=NULL,last_validated_at=clock_timestamp(),updated_at=clock_timestamp(),authz_version=authz_version+1 WHERE account_id=$1 AND id=$2 AND authz_version=$3`, [accountId, credential.credential.id, credential.credential.authzVersion]);
      accountIds.push({ id: accountId, authzVersion: active.authzVersion });
    }
    const pool = await supply.createPlatformProviderPool({ id: poolId, displayName: 'R9 mock pool', providerId, productId, credentialType: 'api-key', region: 'r9-test', purpose: 'inference', rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model: providerModel, endpoint, version: capability.version }], status: 'active', validationState: 'verified' });
    for (const account of accountIds) await supply.addPlatformPoolMember({ poolId, accountId: account.id, expectedAccountAuthzVersion: account.authzVersion });
    await supply.grantPlatformPoolToProfile({ poolId, tenantId: tenant.id, supplyProfileId: profileId, evidenceReference: 'r9-mock-grant', evidenceSha256: 'e'.repeat(64) });
    inventory.push({ protocol, providerId, productId, providerModel, publicModel, endpoint, poolId, accountIds: accountIds.map((account) => account.id) });
  }
  await sealing.close();
  const key = await new KeyService(database, { resolver: new PostgresSupplyProfileResolver(database) }).create(context, { name: 'Disposable R9 test key', modelScopes: models, supplyMode: 'platform' });
  const nextVersion = (BigInt(policy.version) + 1n).toString();
  await database.transaction(async (executor) => {
    await executor.query(`UPDATE saas_tenants SET requests_per_minute=600000,tokens_per_minute=600000000,max_concurrent_requests=512 WHERE id=$1`, [tenant.id]);
    await executor.query(`INSERT INTO saas_project_inference_policy_versions(tenant_id,project_id,version,status,changed_by_user_id,created_at,requests_per_minute,tokens_per_minute,max_concurrent_requests)
      SELECT tenant_id,project_id,$3,status,$4,clock_timestamp(),600000,600000000,512 FROM saas_project_inference_policy_versions WHERE tenant_id=$1 AND project_id=$2 AND version=$5`, [tenant.id, project.id, nextVersion, admin.id, policy.version]);
    await executor.query('UPDATE saas_projects SET inference_policy_version=$3 WHERE tenant_id=$1 AND id=$2 AND inference_policy_version=$4', [tenant.id, project.id, nextVersion, policy.version]);
    await executor.query('UPDATE saas_api_keys SET requests_per_minute=600000,tokens_per_minute=600000000,max_concurrent_requests=256,authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2', [tenant.id, key.id]);
    await new PlatformWalletLedgerService().postVerifiedFunding(executor, { tenantId: tenant.id, currency: 'USD', amountMinorUnits: '100000000000', sourceOrderRef: 'r9-mock-funding', idempotencyKey: 'r9-mock-funding', metadataRef: 'r9-no-real-payment' });
  });
  return { tenantId: tenant.id, projectId: project.id, key: key.secret, inventory };
}

try {
  console.log(`Self-owned current-build R9 test assembly evidence: ${outputDir}`);
  await requireRun('postgres-version', join(pgBin, 'postgres'), ['--version']);
  await requireRun('redis-version', options.redisBin, ['--version']);
  manifest.postgresVersion = (await readFile(join(outputDir, 'postgres-version.log'), 'utf8')).trim();
  manifest.redisVersion = (await readFile(join(outputDir, 'redis-version.log'), 'utf8')).trim();
  if (!options.noBuild) await requireRun('build-current-server', 'npm', ['run', 'build:server']);
  assert.ok(existsSync(join(root, 'dist/cli/index.js')), 'Build the current server artifact first');
  manifest.sourceBefore = await hashTree(join(root, 'src'));
  manifest.distBefore = await hashTree(join(root, 'dist'));
  manifest.harnessBefore = await hashHarness();
  const pgPort = await freePort();
  const redisPort = await freePort();
  const mockPort = await freePort();
  const controlPort = await freePort();
  const gatewayPorts = [await freePort(), await freePort(), await freePort()];
  const databaseName = `model_router_test_r9_${randomUUID().replaceAll('-', '')}`;
  censusDatabaseUrl = () => `postgresql://model_router_saas_migrator@127.0.0.1:${pgPort}/${databaseName}?sslmode=disable`;
  const roleUrl = (role) => `postgresql://${role}@127.0.0.1:${pgPort}/${databaseName}?sslmode=disable`;
  manifest.ports = { postgres: pgPort, redis: redisPort, mock: mockPort, mockControl: controlPort, gateways: gatewayPorts };
  manifest.database = databaseName;
  await requireRun('initdb', join(pgBin, 'initdb'), ['-D', dataDir, '--username=postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--no-locale']);
  await requireRun('start-postgres', join(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', join(outputDir, 'postgres.log'), '-w',
    '-o', `-h 127.0.0.1 -p ${pgPort} -c unix_socket_directories=${process.env.R9_PG_STAT_STATEMENTS === '1' ? ' -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all' : ''}`, 'start']);
  pgStarted = true;
  const psql = (name) => ['-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(pgPort),'-U','postgres','-d',name];
  await requireRun('create-database', join(pgBin, 'psql'), [...psql('postgres'), '-c', `CREATE DATABASE ${databaseName}`]);

  await requireRun('roles-before', join(pgBin, 'psql'), [...psql(databaseName), '-f', join(root, 'deploy/managed-saas-postgres-roles.sql')]);
  await requireRun('migrate-current-dist', process.execPath, [join(root, 'dist/cli/index.js'), 'saas:migrate'], { ...baseEnvironment, MODEL_ROUTER_SAAS_DATABASE_URL: roleUrl('model_router_saas_migrator') });
  await requireRun('roles-after', join(pgBin, 'psql'), [...psql(databaseName), '-f', join(root, 'deploy/managed-saas-postgres-roles.sql')]);
  if (process.env.R9_PG_STAT_STATEMENTS === '1') {
    // pg_stat_statements counts every protocol shape (including the
    // parameterized extended protocol log_statement misses), giving a
    // load-immune per-run statement census for paired cache diagnostics.
    // Created only after every roles security self-audit has passed: the
    // extension objects must not trip the runtime-privilege validation.
    await requireRun('enable-pg-stat-statements', join(pgBin, 'psql'), [...psql(databaseName), '-c', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements']);
  }
  const redisArguments = ['--bind','127.0.0.1','--port',String(redisPort),'--dir',runtimeDir,'--save','','--appendonly','no','--daemonize','no',
    ...(options.recoveryProfile ? ['--dbfilename','dump.rdb'] : [])];
  const redis = await launch('redis', options.redisBin, redisArguments, baseEnvironment);
  await waitFor('redis', async () => {
    assert.equal(redis.exitCode, null, 'Owned Redis exited before readiness');
    return new Promise((resolvePing) => { const socket = createConnection({ host: '127.0.0.1', port: redisPort });
      socket.setTimeout(1000); socket.on('error', () => resolvePing(false)); socket.on('timeout', () => { socket.destroy(); resolvePing(false); });
      socket.on('connect', () => socket.write('*1\r\n$4\r\nPING\r\n')); socket.on('data', (data) => { socket.destroy(); resolvePing(data.toString().includes('+PONG')); }); });
  });
  const certificateFile = join(runtimeDir, 'mock-cert.pem');
  const mockKeyFile = join(runtimeDir, 'mock-key.pem');
  await requireRun('create-mock-tls', 'openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',mockKeyFile,'-out',certificateFile,'-days','1','-subj','/CN=r9-local-mock','-addext','subjectAltName=IP:127.0.0.1']);
  const mockSource = (await readFile(join(root, 'deploy/compose/mock-upstream.mjs'), 'utf8')).replaceAll("'0.0.0.0'", "'127.0.0.1'");
  const mockFile = join(runtimeDir, 'loopback-mock.mjs');
  await writeFile(mockFile, mockSource, { mode: 0o600 });
  await launch('mock', process.execPath, [mockFile], { ...baseEnvironment, MOCK_TLS_CERT: certificateFile, MOCK_TLS_KEY: mockKeyFile, MOCK_PORT: String(mockPort), MOCK_CONTROL_PORT: String(controlPort) });
  await waitFor('mock-control', async () => { try { return (await fetch(`http://127.0.0.1:${controlPort}/__control/stats`, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; } });
  const kmsEnv = { ...baseEnvironment, MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: randomBytes(32).toString('hex'), MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'r9-local-test' };
  const seed = await seedMockInventory(roleUrl('model_router_saas_migrator'), kmsEnv);
  if (options.requestSamples) requestSamplesTenantId = seed.tenantId;
  manifest.inventory = seed.inventory;
  const signing = generateKeyPairSync('ed25519');
  const privateKeyFile = join(runtimeDir, 'signing.pem');
  const publicKeyFile = join(runtimeDir, 'public.pem');
  await writeFile(privateKeyFile, signing.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(publicKeyFile, signing.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
  const configFile = join(runtimeDir, 'runtime-config.json');
  await writeFile(configFile, JSON.stringify({ privateKeyFile, publicKeyFile, certificateFile, mockPort, routes: seed.inventory,
    affinityKey: randomBytes(32).toString('base64'), idempotencyKey: randomBytes(32).toString('base64') }), { mode: 0o600 });
  const moduleFile = join(runtimeDir, 'r9-mock-runtime.mjs');
  await writeFile(moduleFile, `const factory = ${createR9TestRuntime.toString()};\nexport async function createManagedSaasGatewayRuntime(options) { try { return await factory(options); } catch (error) { console.error('r9_mock_factory', { name: error?.name, code: error?.code, message: error?.message }); throw error; } }\n`, { mode: 0o600 });
  const gatewayUrls = [];
  for (const [index, port] of gatewayPorts.entries()) {
    const gateway = await launch(`gateway-${index + 1}`, process.execPath, [join(root, 'dist/cli/index.js'), 'start', '--role', 'gateway'], {
      ...kmsEnv, MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas', MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
      MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS: postgresPreparedStatements,
      ...(requestDiagnostics.enabled ? { MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY: String(requestDiagnostics.sampleEvery) } : {}),
      ...(gatewayMaxHttpInFlight === null ? {} : { MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: configuredGatewayMaxHttpInFlight }),
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: roleUrl('model_router_saas_gateway'), MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: moduleFile,
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: join(root, 'dist/saas/runtime/software-provider-credential-kms.js'),
      MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'r9-current-test', MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
      MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1', MODEL_ROUTER_SAAS_GATEWAY_PORT: String(port), MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: `http://127.0.0.1:${port}`,
      MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: `redis://127.0.0.1:${redisPort}`, NODE_EXTRA_CA_CERTS: certificateFile,
      MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST: '127.0.0.1/32',
      R9_TEST_DIST: join(root, 'dist'), R9_TEST_CONFIG: configFile,
    });
    await waitFor(`gateway-${index + 1}`, async () => { assert.equal(gateway.exitCode, null, `Owned gateway ${index + 1} exited`);
      try { const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); return response.status === 200; } catch { return false; } });
    gatewayUrls.push(`http://127.0.0.1:${port}`);
  }
  if (options.postgresRecoveryProfile) {
    const customerPort = await freePort(); const platformPort = await freePort();
    const totpModule = join(runtimeDir, 'pg-recovery-totp-provider.mjs');
    await writeFile(totpModule, `export async function createCredentialKeyProvider({env,purpose}) {
      if(purpose!=='platform-totp') throw new Error('Invalid local recovery provider purpose');
      const key=Buffer.from(env.R9_RECOVERY_TOTP_KEY??'','hex');
      if(key.length!==32) throw new Error('Missing local recovery TOTP key');
      return {getCurrentKey(){return {keyId:'pg-recovery-local-totp',key:new Uint8Array(key)}},
        getKey(id){return id==='pg-recovery-local-totp'?new Uint8Array(key):undefined},
        async checkReady(){},async close(){key.fill(0)}};
    }`, { mode: 0o600 });
    const cp = await launch('postgres-recovery-control-plane', process.execPath, [join(root, 'dist/cli/index.js'), 'start', '--role', 'control-plane'], {
      ...kmsEnv, MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas', MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'control-plane',
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: roleUrl('model_router_saas_control_plane'),
      MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'r9-current-test', MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
      MODEL_ROUTER_SAAS_KMS_PROVIDER: totpModule, R9_RECOVERY_TOTP_KEY: randomBytes(32).toString('hex'),
      MODEL_ROUTER_SAAS_REDIS_PROVIDER: join(root, 'dist/saas/runtime/redis-rate-limit-provider.js'),
      MODEL_ROUTER_SAAS_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS: '127.0.0.1', MODEL_ROUTER_SAAS_CUSTOMER_PORT: String(customerPort),
      MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN: `http://127.0.0.1:${customerPort}`,
      MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS: '127.0.0.1', MODEL_ROUTER_SAAS_PLATFORM_PORT: String(platformPort),
      MODEL_ROUTER_SAAS_PLATFORM_ORIGIN: `http://127.0.0.1:${platformPort}`,
    });
    manifest.ports.controlPlane = { customer: customerPort, platform: platformPort };
    await waitFor('postgres-recovery-control-plane', () => ownedControlPlaneListenersReady(cp, [customerPort, platformPort]));
  }
  for (const route of seed.inventory) {
    const response = await fetch(`${gatewayUrls[0]}${route.endpoint}`, { method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${seed.key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: route.publicModel, max_tokens: 64, messages: [{ role: 'user', content: 'bench' }] }) });
    const text = await response.text();
    assert.equal(response.status, 200, `Current-build mock ${route.protocol} first smoke status ${response.status}`);
    assert.ok(text.length > 0, 'Mock completion must contain bytes');
    const requestId = response.headers.get('x-request-id');
    await waitFor(`${route.protocol}-smoke-settlement`, async () => {
      const result = await database.query('SELECT execution_state,financial_status FROM saas_requests WHERE tenant_id=$1 AND id=$2', [seed.tenantId, requestId]);
      return result.rows[0]?.execution_state === 'succeeded' && result.rows[0]?.financial_status === 'settled';
    });
    manifest.scenes.push({ scene: 'current-cli-smoke', protocol: route.protocol, httpStatus: response.status, requestId, settled: true });
  }
  const benchEnv = { ...baseEnvironment, NODE_EXTRA_CA_CERTS: certificateFile, BENCH_PROXY_KEY: seed.key,
    MOCK_CONTROL_URL: `http://127.0.0.1:${controlPort}`, MOCK_UPSTREAM_URL: `https://127.0.0.1:${mockPort}` };
  async function benchmark(name, urls, commandArgs, route) {
    const reportFile = join(outputDir, `${name}.json`);
    const observationArgs = options.requestSamples
      ? ['--request-samples-out', requestSamplesFile = join(outputDir, 'serial-profile-request-samples.json')]
      : [];
    const result = await run(name, process.execPath, [join(root, 'scripts/ops/bench-gateway.mjs'), '--protocol', route.protocol, '--model', route.publicModel,
      '--account-limit','64','--precision-accounts',route.accountIds.join(','),'--out',reportFile,...commandArgs,...observationArgs], { ...benchEnv, GATEWAY_URLS: urls.join(',') }, 45 * 60000);
    const report = existsSync(reportFile) ? JSON.parse(await readFile(reportFile, 'utf8')) : undefined;
    if (options.capProfile) manifest.capProfile.result = capProfileEvidence(report);
    const validLatencySamples = !report?.scenarios.latency || (report.scenarios.latency.direct.n === report.config.requests && report.scenarios.latency.gateway.n === report.config.requests);
    const observedTraffic = (!report?.scenarios.precision || Object.values(report.scenarios.precision.perAccount).some((account) => account.requests > 0)) &&
      (!report?.scenarios.concurrency || Number(report.scenarios.concurrency.statuses['200'] ?? 0) > 0) &&
      (!report?.scenarios.scaling || report.scenarios.scaling.throughputRps > 0);
    const validScalingComparison = !report?.config.baselineReport || (Number.isFinite(report.scenarios.scaling?.ratio) &&
      !Object.hasOwn(report.scenarios.scaling, 'invalidComparisonReason'));
    const validLoadCounters = validObservedLoadCounters(report, commandArgs[commandArgs.indexOf('--scenario') + 1]);
    const sampleSufficiency = observedSampleSufficiency(report, commandArgs[commandArgs.indexOf('--scenario') + 1], options);
    const serialProfileChecks = options.serialProfile ? {
      onlySerialScenarios: Object.keys(report?.scenarios ?? {}).sort().join(',') === 'latency,ttfb',
      expectedConfiguration: report?.config.requests === 100 && report?.config.streamSamples === 100 && report?.config.warmupInflight === 1 && report?.config.instanceCount === 3,
      completeLatency: report?.scenarios.latency?.direct.n === 100 && report?.scenarios.latency?.gateway.n === 100,
      completeTtfb: report?.scenarios.ttfb?.direct.n === 100 && report?.scenarios.ttfb?.gateway.n === 100 && report?.scenarios.ttfb?.gatewayErrors === 0,
      unchangedThresholds: report?.config.p99OverheadMs === 30 && report?.config.ttfbOverheadMs === 10 && report?.config.noFail === false,
      finiteOverheads: Number.isFinite(report?.scenarios.latency?.p99OverheadMs) && Number.isFinite(report?.scenarios.ttfb?.ttfbOverheadMs),
    } : undefined;
    const validSerialProfile = serialProfileChecks === undefined || Object.values(serialProfileChecks).every(Boolean);
    const validCapProfile = !options.capProfile || (manifest.capProfile.result.configurationUnchanged &&
      manifest.capProfile.result.successfulSampleSufficiency.sufficient &&
      manifest.capProfile.result.acceptedLatency?.n === manifest.capProfile.result.successfulRequests);
    const ok = result.code === 0 && Boolean(report) && report.violations.length === 0 && validLatencySamples && observedTraffic && validScalingComparison && validSerialProfile && validLoadCounters && validCapProfile && sampleSufficiency.sufficient;
    manifest.scenes.push({ scene: name, ...result, report: reportFile, ok, validLatencySamples, observedTraffic, validScalingComparison, sampleSufficiency,
      ...(options.capProfile ? { validCapProfile } : {}),
      ...(report?.scenarios.scaling || report?.scenarios.concurrency ? { validObservedLoadCounters: validLoadCounters } : {}),
      ...(serialProfileChecks === undefined ? {} : { serialProfileChecks }), violations: report?.violations });
    if (!ok) firstFault(name, !validLatencySamples ? 'Legacy driver discarded unsuccessful latency samples; required sample count missing' :
      !sampleSufficiency.sufficient ? 'Required HTTP 200 sample counts or complete TTFB evidence are insufficient' :
      !validCapProfile ? 'Cap diagnostic requires unchanged c200/60s, body-complete accepted latency and at least 100 successful samples' :
      !validSerialProfile ? 'Serial profile requires only latency/TTFB, 100 complete samples per leg, zero stream errors and unchanged thresholds' :
      !validLoadCounters ? 'Scaling/concurrency observed counters are invalid or exceed the chosen zero transport/5xx budgets' :
      !observedTraffic ? 'Benchmark did not observe successful dispatched traffic' :
      !validScalingComparison ? 'Scaling baseline did not produce a valid throughput comparison' : `R9 driver exit=${result.code}, violations=${report?.violations.length ?? 'missing-report'}`);
    return { reportFile, ok };
  }
  if (options.diagnostic) {
    if (options.standbyRecoveryProfile) {
      const { createSaasDatabase } = await import(pathToFileURL(join(root, 'dist/saas/db/index.js')).href);
      manifest.standbyRecovery = await runPostgresSaasStandbyRecoveryProfile({
        pgBin, primaryDataDir: dataDir, primaryPort: pgPort, databaseName,
        createDatabaseAt: (connectionString) => createSaasDatabase({ connectionString, max: 2 }),
        requireRun: (stage, command, commandArgs, timeoutMs) => requireRun(stage, command, commandArgs, baseEnvironment, timeoutMs),
        freePort, getDatabase: () => database, seed, gatewayUrls,
        controlUrl: `http://127.0.0.1:${controlPort}`, outputDir, signal: recoveryAbort.signal,
        beforeStopPrimary: async () => {
          recoveryAbort.signal.throwIfAborted();
          await database.close();
          pgStarted = false;
        },
      });
    } else if (options.postgresRecoveryProfile) {
      manifest.postgresRecovery = await runPostgresSaasRecoveryProfile({ getDatabase: () => database, seed, gatewayUrls,
        controlUrl: `http://127.0.0.1:${controlPort}`, outputDir, signal: recoveryAbort.signal,
        assertOtherProcessesAlive: () => {
          for (const { stage, child } of children) {
            assert.equal(child.exitCode, null, `Owned ${stage} exited during PostgreSQL recovery`);
            assert.equal(child.signalCode, null, `Owned ${stage} was signalled during PostgreSQL recovery`);
          }
        },
        stopOwnedPostgres: async () => {
          recoveryAbort.signal.throwIfAborted();
          // The observation pool is disposable; original gateway/control-plane pools must survive the outage.
          await database.close(); recoveryAbort.signal.throwIfAborted();
          await requireRun('postgres-recovery-immediate-stop', join(pgBin, 'pg_ctl'), ['-D', dataDir, '-w', '-m', 'immediate', 'stop'], baseEnvironment, 30000);
          pgStarted = false;
        },
        restartOwnedPostgres: async () => {
          recoveryAbort.signal.throwIfAborted();
          // Startup can succeed just as the command is interrupted; cleanup must still own a possible server.
          pgStarted = true;
          await requireRun('postgres-recovery-same-directory-start', join(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', join(outputDir, 'postgres.log'), '-w', '-o', `-h 127.0.0.1 -p ${pgPort} -c unix_socket_directories=`, 'start'], baseEnvironment, 30000);
          const { createSaasDatabase } = await import(pathToFileURL(join(root, 'dist/saas/db/index.js')).href);
          database = createSaasDatabase({ connectionString: roleUrl('model_router_saas_migrator'), max: 2 });
        },
      });
    } else if (options.recoveryProfile) {
      manifest.recovery = await runRedisSaasRecoveryProfile({ database, seed, gatewayUrls,
        controlUrl: `http://127.0.0.1:${controlPort}`, redisUrl: `redis://127.0.0.1:${redisPort}`, redisProcess: redis,
        runtimeDir, outputDir, signal: recoveryAbort.signal,
        launchRedis: () => launch('redis-restored', options.redisBin, redisArguments, baseEnvironment) });
    } else if (options.capProfile) {
      const resources = startCapProfileResources();
      try {
        await benchmark(`cap-${gatewayMaxHttpInFlight ?? 'unset'}-current-3cli`, gatewayUrls,
          ['--scenario','concurrency','--inflight','200','--concurrency-seconds','60'], seed.inventory[0]);
      } finally {
        manifest.capProfile.resources = resources.stop();
        await writeFile(join(outputDir, 'cap-profile-resources.json'), `${JSON.stringify(manifest.capProfile.resources, null, 2)}\n`, { mode: 0o600 });
      }
    } else if (options.serialProfile) {
      await benchmark('serial-profile-current-3cli', gatewayUrls, ['--scenario','latency,ttfb','--requests','100','--stream-samples','100','--warmup-inflight','1'], seed.inventory[0]);
    } else {
      await benchmark('diagnostic-current-3cli', gatewayUrls, ['--scenario','latency,ttfb,concurrency','--requests','10','--stream-samples','10','--inflight','4','--concurrency-seconds','5'], seed.inventory[0]);
    }
  } else {
    await runFullR9Benchmarks(seed.inventory, gatewayUrls, benchmark);
  }
  const stats = await fetch(`http://127.0.0.1:${controlPort}/__control/stats`).then((response) => response.json());
  await writeFile(join(outputDir, 'final-mock-stats.json'), `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 });
  manifest.metrics = [];
  for (const [index, url] of gatewayUrls.entries()) {
    const response = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5000) });
    const file = join(outputDir, `gateway-${index + 1}-metrics.prom`);
    if (response.status === 200) {
      await writeFile(file, await response.text(), { mode: 0o600 });
      manifest.metrics.push({ instance: index + 1, status: response.status, file });
    } else { await response.body?.cancel(); manifest.metrics.push({ instance: index + 1, status: response.status }); }
  }
  if (options.serialProfile && (manifest.metrics.length !== 3 || manifest.metrics.some((entry) => entry.status !== 200))) {
    firstFault('serial-profile-metrics', 'Serial profile requires successful metrics snapshots from the same three CLI gateways');
  }
} catch (error) {
  firstFault('supervisor', error instanceof Error ? error.message : 'Unrecognized supervisor failure');
  console.error(manifest.firstFault);
} finally {
  if (options.requestSamples) {
    try {
      manifest.requestSamples = await exportRequestSampleStates(database, requestSamplesTenantId, requestSamplesFile,
        join(outputDir, 'serial-profile-request-states.json'));
    } catch {
      manifest.requestSamples = { observationOk: false, failure: { stage: 'observation_internal', sqlState: null } };
    }
  }
  await closeOwned();
  if (requestDiagnostics.enabled) {
    try {
      manifest.requestDiagnostics.export = await exportRequestDiagnosticTraces(requestSamplesFile, outputDir,
        join(outputDir, 'serial-profile-request-traces.json'));
    } catch {
      manifest.requestDiagnostics.export = { observationOk: false, failure: 'request_traces_export' };
    }
  }
  manifest.sourceAfter = await hashTree(join(root, 'src'));
  manifest.distAfter = await hashTree(join(root, 'dist'));
  manifest.harnessAfter = await hashHarness();
  manifest.sourceChanged = JSON.stringify(manifest.sourceBefore) !== JSON.stringify(manifest.sourceAfter);
  manifest.distChanged = JSON.stringify(manifest.distBefore) !== JSON.stringify(manifest.distAfter);
  manifest.harnessChanged = JSON.stringify(manifest.harnessBefore) !== JSON.stringify(manifest.harnessAfter);
  manifest.finishedAt = new Date().toISOString();
  manifest.interrupted = interrupted;
  manifest.ok = !manifest.firstFault && !manifest.sourceChanged && !manifest.distChanged && !manifest.harnessChanged && !interrupted &&
    manifest.cleanup.processesStopped && manifest.cleanup.postgresStopped && manifest.cleanup.runtimeRemoved &&
    pgStatementCensusSatisfied(process.env.R9_PG_STAT_STATEMENTS === '1', manifest.pgStatementCensus);
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`R9 ${options.serialProfile ? 'serial profile' : options.diagnostic ? 'diagnostic' : 'full'} summary: ${join(outputDir, 'summary.json')} (ok=${manifest.ok})`);
  process.exitCode = manifest.ok ? 0 : 1;
}
