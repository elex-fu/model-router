#!/usr/bin/env node
/** Isolated, local-only console benchmark. No real provider or existing data path is accepted. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/cli/index.js');
const monitor = path.join(root, 'scripts/perf/process-monitor.mjs');
const defaults = { concurrency: 100, requests: 100, historyRows: 1_000,
  querySamples: 20, warmup: 5, mockDelayMs: 5, timeoutMs: 30_000 };

function options(args) {
  const value = { ...defaults, allowMillion: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-million') { value.allowMillion = true; continue; }
    if (args[i] === '--help') {
      console.log(`Usage: node scripts/benchmark-console.mjs [options]\n\n` +
        `--concurrency N     SSE concurrency (default 100)\n` +
        `--requests N        Requests per measured phase (default 100)\n` +
        `--history-rows N    Synthetic request+attempt pairs (default 1000)\n` +
        `--allow-million     Required when history-rows >= 1000000\n` +
        `--query-samples N   Admin query samples (default 20)\n` +
        `--warmup N          Warmup requests per proxy phase (default 5)\n` +
        `--mock-delay-ms N   Delay between deterministic SSE frames (default 5)\n` +
        `--timeout-ms N      Per-request timeout (default 30000)`);
      process.exit(0);
    }
    const key = ({ '--concurrency': 'concurrency', '--requests': 'requests',
      '--history-rows': 'historyRows', '--query-samples': 'querySamples',
      '--warmup': 'warmup', '--mock-delay-ms': 'mockDelayMs',
      '--timeout-ms': 'timeoutMs' })[args[i]];
    if (!key || !args[i + 1] || !/^\d+$/.test(args[i + 1])) throw new Error(`Invalid option ${args[i]}`);
    value[key] = Number(args[++i]);
  }
  for (const key of ['concurrency', 'requests', 'querySamples', 'timeoutMs'])
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error(`${key} must be positive`);
  for (const key of ['historyRows', 'warmup', 'mockDelayMs'])
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${key} must be nonnegative`);
  if (value.requests > 100_000 || value.historyRows > 1_000_000 || value.concurrency > 2_000)
    throw new Error('Request, history or concurrency safety cap exceeded');
  if (value.historyRows >= 1_000_000 && !value.allowMillion)
    throw new Error('One million history rows require --allow-million');
  return value;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => values.length
  ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
const p95 = (values) => percentile(values, 0.95);
const round = (n) => n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
}

async function mockUpstream(delayMs) {
  const stats = { requests: 0, responses: 0, errors: [], paths: {} };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const pathKey = `${req.method} ${req.url}`;
    stats.paths[pathKey] = (stats.paths[pathKey] ?? 0) + 1;
    let completed = false;
    res.once('finish', () => { completed = true; stats.responses++; });
    res.once('close', () => {
      if (!completed) stats.errors.push({ kind: 'response-closed-early', path: pathKey });
    });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      stats.errors.push({ kind: 'unexpected-request', path: pathKey });
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) {
      stats.errors.push({ kind: 'request-body-too-large', path: pathKey }); req.destroy();
    } });
    req.on('end', async () => {
      let input;
      try { input = JSON.parse(body); } catch {
        stats.errors.push({ kind: 'invalid-json', path: pathKey }); res.writeHead(400); res.end(); return;
      }
      if (input.model !== 'bench-model' || input.stream !== true) {
        stats.errors.push({ kind: 'unexpected-payload', path: pathKey,
          model: input.model ?? null, stream: input.stream ?? null });
        res.writeHead(400); res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = [
        { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'fixed' }, finish_reason: null }] },
        { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ];
      for (const frame of frames) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (delayMs) await pause(delayMs);
      }
      if (!res.destroyed) res.end('data: [DONE]\n\n');
    });
  });
  server.on('clientError', (error) => stats.errors.push({ kind: 'client-error', message: error.message }));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, snapshot: () => structuredClone(stats) };
}

function seed(dbPath, rows, startedAtMs) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const request = db.prepare(`INSERT INTO requests
    (id,proxy_key_id,source,client_protocol,request_model,state,final_http_status,
     started_at_ms,ended_at_ms,duration_ms,first_text_ms,final_upstream_id)
    VALUES (?,'bench-key','production','openai','bench-model','completed',200,?,?,20,5,'bench-upstream')`);
  const attempt = db.prepare(`INSERT INTO attempts
    (id,request_id,ordinal,upstream_id,resolved_model,protocol,outcome,status,
     started_at_ms,ended_at_ms,usage_json)
    VALUES (?,?,1,'bench-upstream','bench-model','openai','completed',200,?,?,?)`);
  const usage = JSON.stringify({ inputTotal: 10, inputUncached: 10, cacheRead: 0,
    cacheWrite: null, outputTotal: 2, reasoningOutput: null, status: 'reported',
    source: 'upstream', semanticsVersion: 'v1' });
  const writeBatch = db.transaction((from, to) => {
    for (let i = from; i < to; i++) {
      const id = `seed-${String(i).padStart(8, '0')}`;
      const at = startedAtMs - 3_600_000 + (i % 3_600_000);
      request.run(id, at, at + 20);
      attempt.run(`seed-attempt-${i}`, id, at, at + 20, usage);
    }
  });
  try {
    for (let i = 0; i < rows; i += 5_000) {
      writeBatch(i, Math.min(rows, i + 5_000));
      if (rows >= 100_000 && (i + 5_000) % 100_000 === 0)
        process.stderr.write(`Seeded ${Math.min(rows, i + 5_000)}/${rows} synthetic rows\n`);
    }
  } finally { db.close(); }
}

function childServer(configPath) {
  const child = spawn(process.execPath, ['--import', monitor, entry, 'start', '-c', configPath], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, MODEL_ROUTER_PID_FILE: '', MODEL_ROUTER_PERF: '1' },
  });
  let output = '';
  let lineBuffer = '';
  const perfEvents = [];
  let bootstrapToken = null;
  const collect = (chunk) => {
    const text = chunk.toString();
    output = (output + text).slice(-12_000);
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      try { const item = JSON.parse(line); if (item.kind?.startsWith('telemetry-')) perfEvents.push(item); }
      catch { /* non-JSON server output */ }
    }
    bootstrapToken = /Admin bootstrap token \(local, expires in 15m\): ([^\s]+)/.exec(output)?.[1] ?? bootstrapToken;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, get bootstrapToken() { return bootstrapToken; },
    get perfMetrics() { return structuredClone(perfEvents); },
    get diagnostic() { return output.replace(/(Admin bootstrap token[^:]*: )[^\s]+/g, '$1[redacted]'); } };
}

async function ready(url, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server exited during startup: ${child.exitCode ?? child.signalCode}`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1_000) }); if (response.ok) return; }
    catch { /* listener not ready */ }
    await pause(75);
  }
  throw new Error(`Server readiness timed out at ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 12_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

let monitorId = 0;
async function childMetric(child, action) {
  const id = ++monitorId;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Child metric timed out')); }, 5_000);
    const receive = (message) => {
      if (message?.kind !== 'benchmark-monitor' || message.id !== id) return;
      clearTimeout(timer); child.off('message', receive); resolve(message);
    };
    child.on('message', receive);
    child.send({ kind: 'benchmark-monitor', action, id });
  });
}

const body = JSON.stringify({ model: 'bench-model', stream: true, max_tokens: 16,
  stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'fixed benchmark fixture' }] });
async function sse(baseUrl, apiKey, timeoutMs) {
  const started = performance.now();
  let status = null;
  let contentType = null;
  let received = '';
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body, signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    contentType = response.headers.get('content-type');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received = (received + decoder.decode(value, { stream: true })).slice(-4_000);
      }
      received = (received + decoder.decode()).slice(-4_000);
    }
    const done = received.includes('data: [DONE]');
    return { ms: performance.now() - started, ok: response.status === 200 &&
      done && !received.includes('event: error'), status: response.status,
      contentType, bodySample: received.slice(0, 1_000), interrupted: response.status === 200 && !done };
  } catch (error) { return { ms: performance.now() - started, ok: false, status, contentType,
    bodySample: received.slice(0, 1_000), interrupted: status === 200,
    error: error instanceof Error ? error.message : String(error) }; }
}

async function load(baseUrl, apiKey, requestCount, concurrency, timeoutMs) {
  const results = new Array(requestCount);
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
    while (next < requestCount) {
      const index = next++;
      results[index] = await sse(baseUrl, apiKey, timeoutMs);
    }
  }));
  const good = results.filter((r) => r.ok);
  const interruptions = results.filter((r) => r.interrupted).length;
  return { p95Ms: round(p95(good.map((r) => r.ms))),
    success: good.length, total: requestCount, failed: requestCount - good.length,
    interrupted: interruptions, interruptionRate: round(interruptions / requestCount),
    elapsedMs: round(performance.now() - started),
    sampleError: results.find((r) => !r.ok)?.error ?? null,
    failedSamples: results.filter((r) => !r.ok).slice(0, 3) };
}

function adminClient(baseUrl, cookie, csrf) {
  const api = `${baseUrl}/admin/api/v1`;
  return async (endpoint, { method = 'GET', payload, timeoutMs = 30_000 } = {}) => {
    const response = await fetch(`${api}${endpoint}`, { method,
      headers: { cookie, ...(payload ? { 'content-type': 'application/json',
        origin: baseUrl, 'x-csrf-token': csrf } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Admin ${endpoint} HTTP ${response.status}: ${JSON.stringify(value).slice(0, 300)}`);
    return value;
  };
}

async function adminSession(baseUrl, bootstrapToken) {
  if (!bootstrapToken) throw new Error('Admin bootstrap token not observed');
  const api = `${baseUrl}/admin/api/v1`;
  const name = 'benchmark-admin';
  const password = randomBytes(24).toString('base64url');
  const bootstrap = await fetch(`${api}/bootstrap`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: bootstrapToken, name, password }) });
  if (bootstrap.status !== 201) throw new Error(`Admin bootstrap failed: ${bootstrap.status}`);
  const login = await fetch(`${api}/session`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
  if (!login.ok) throw new Error(`Admin login failed: ${login.status}`);
  const csrf = (await login.json()).data.csrfToken;
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || !csrf) throw new Error('Admin session cookie or CSRF token missing');
  return adminClient(baseUrl, cookie, csrf);
}

async function timedQueries(api, endpoint, count) {
  const latencies = [];
  let cursor = null;
  let rowsSeen = 0;
  for (let i = 0; i < count; i++) {
    const query = cursor ? `${endpoint}&cursor=${encodeURIComponent(cursor)}` : endpoint;
    const started = performance.now();
    const response = await api(query);
    latencies.push(performance.now() - started);
    rowsSeen += response.data?.length ?? 0;
    cursor = response.meta?.nextCursor ?? null;
  }
  return { p95Ms: round(p95(latencies)), samples: count, rowsSeen };
}

async function aggregate(api, timeoutMs) {
  const started = performance.now();
  const start = await api('/maintenance/jobs', { method: 'POST', payload: { type: 'aggregate' }, timeoutMs });
  const id = start.data?.jobId;
  if (!id) throw new Error('Aggregate job returned no ID');
  const deadline = Date.now() + Math.max(timeoutMs, 120_000);
  while (Date.now() < deadline) {
    const job = (await api(`/jobs/${encodeURIComponent(id)}`, { timeoutMs })).data;
    if (job.status === 'completed') return { status: 'completed', elapsedMs: round(performance.now() - started), result: job.result };
    if (job.status === 'failed' || job.status === 'cancelled') return { status: job.status,
      elapsedMs: round(performance.now() - started), error: job.error };
    await pause(100);
  }
  return { status: 'timeout', elapsedMs: round(performance.now() - started) };
}

function rollupRead(dbPath, samples) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const query = db.prepare('SELECT * FROM admin_usage_daily_v2 WHERE verified=0 ORDER BY day_start_ms DESC LIMIT 400');
    const latencies = [];
    let rows = 0;
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      rows = query.all().length;
      latencies.push(performance.now() - started);
    }
    return { p95Ms: round(p95(latencies)), samples, rows,
      scope: 'direct SQLite materialized rollup read; not the overview HTTP API' };
  } finally { db.close(); }
}

async function visibility(api, endpoint, expected, timeoutMs) {
  const started = performance.now();
  const startedAtMs = Date.now();
  const deadline = Date.now() + Math.max(timeoutMs, 10_000);
  const polls = [];
  let previousPollStartMs = null;
  let previousPollEndMs = null;
  let delayMs = 1_000;
  while (Date.now() < deadline) {
    const pollStartedAtMs = Date.now();
    const pollStarted = performance.now();
    const response = await api(endpoint, { timeoutMs });
    const pollEnded = performance.now();
    const pollEndedAtMs = Date.now();
    polls.push({ startedAtMs: pollStartedAtMs, endedAtMs: pollEndedAtMs,
      cadenceSincePreviousStartMs: previousPollStartMs === null ? null : pollStartedAtMs - previousPollStartMs,
      idleSincePreviousEndMs: previousPollEndMs === null ? null : pollStartedAtMs - previousPollEndMs,
      endpointRttMs: round(pollEnded - pollStarted),
      readWatermark: response.data?.freshness?.snapshotSequence ?? null,
      currentWatermark: response.data?.freshness?.currentSequence ?? null,
      observedRequests: response.data?.logicalRequests ?? null });
    previousPollStartMs = pollStartedAtMs;
    previousPollEndMs = pollEndedAtMs;
    if (response.data?.logicalRequests >= expected) {
      const firstSeenAtMs = pollEndedAtMs;
      return { endpointRttMs: polls.at(-1).endpointRttMs, pollCount: polls.length,
        polls, firstSeenAtMs, visibleMs: round(firstSeenAtMs - startedAtMs),
        firstSeenDelayMs: round(firstSeenAtMs - startedAtMs),
        firstSeenIntervalMs: { lowerBound: polls.length > 1 ? polls.at(-2).endedAtMs - startedAtMs : 0,
          upperBound: firstSeenAtMs - startedAtMs },
        observedRequests: response.data.logicalRequests, visible: true };
    }
    // Keep polling below the admin API's per-IP request budget, including the
    // other summary, pagination and overview calls made by this benchmark.
    await pause(delayMs);
    delayMs = Math.min(2_000, delayMs + 250);
  }
  return { endpointRttMs: polls.at(-1)?.endpointRttMs ?? null, pollCount: polls.length,
    polls, firstSeenAtMs: null, visibleMs: null, firstSeenDelayMs: null, firstSeenIntervalMs: null,
    observedRequests: polls.at(-1)?.observedRequests ?? null, visible: false };
}

export function summarizeTelemetryPerf(events) {
  const groups = new Map();
  const watermarks = [];
  const add = (endpoint, stage, value) => {
    if (!Number.isFinite(value)) return;
    const key = `${endpoint}.${stage}`;
    const values = groups.get(key) ?? [];
    values.push(value);
    groups.set(key, values);
  };
  for (const event of events) {
    if (event.kind === 'telemetry-read-perf') {
      add(event.endpoint, 'workerLifecycleMs', event.workerLifecycleMs);
      add(event.endpoint, 'workerTotalMs', event.workerTotalMs);
      for (const [stage, value] of Object.entries(event.stages ?? {})) add(event.endpoint, stage, value);
      if (Number.isSafeInteger(event.sequence)) watermarks.push({ endpoint: event.endpoint, sequence: event.sequence });
    } else if (event.kind === 'telemetry-response-perf') {
      add(event.endpoint, 'responseAssemblyMs', event.responseAssemblyMs);
      if (Number.isSafeInteger(event.sequence)) watermarks.push({ endpoint: event.endpoint, sequence: event.sequence });
    } else if (event.kind === 'telemetry-write-perf') {
      add('writer', 'batchSize', event.batchSize);
      for (const stage of ['queueMs', 'workerAckMs', 'enqueueToCommitMs'])
        for (const value of event[stage] ?? []) add('writer', stage, value);
    }
  }
  return { stages: Object.fromEntries([...groups].map(([stage, values]) => [stage, {
    samples: values.length,
    p50: round(percentile(values, 0.50)),
    p95: round(percentile(values, 0.95)),
  }])), watermarks };
}

function databaseBytes(directory) {
  return fs.readdirSync(directory).filter((name) => /\.sqlite(?:-wal|-shm)?$/.test(name))
    .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
}

function target(observed, threshold, eligible, { unsupported = false, strict = false } = {}) {
  if (unsupported) return { observed, threshold, status: 'not_evaluated', reason: 'Overview was not served from live-minute preaggregates' };
  if (observed === null) return { observed, threshold, status: 'not_evaluated', reason: 'Measurement unavailable' };
  if (!eligible) return { observed, threshold, status: 'not_evaluated', reason: 'Run does not match fixed 4-core/8-GB, 100-concurrent, 1M-row target profile' };
  return { observed, threshold, status: (strict ? observed < threshold : observed <= threshold) ? 'pass' : 'fail' };
}

function overviewIsPreaggregated(response) {
  const data = response?.data;
  return data?.usage?.coverage === 'native-live-minute+detail-tails' &&
    data?.productionSuccessRate?.measurement === 'covered_live_minute_plus_detail_tails';
}

async function main() {
  const opt = options(process.argv.slice(2));
  if (!fs.existsSync(entry)) throw new Error('Build the server first: npm run build:server');
  if (opt.historyRows >= 1_000_000 && fs.statfsSync(os.tmpdir()).bavail * fs.statfsSync(os.tmpdir()).bsize < 2_000_000_000)
    throw new Error('Less than 2 GB free in temporary filesystem; refusing million-row run');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-console-bench-'));
  let mock;
  let running;
  try {
    mock = await mockUpstream(opt.mockDelayMs);
    const mockPort = Number(new URL(mock.url).port);
    let proxyPort = await port();
    while (proxyPort === mockPort) proxyPort = await port();
    let adminPort = await port();
    while (adminPort === proxyPort || adminPort === mockPort) adminPort = await port();
    const configPath = path.join(temp, 'config.json');
    const dbPath = path.join(temp, 'logs.sqlite');
    const { SQLiteTelemetryStore } = await import('../dist/storage/telemetry-store.js');
    const { defaultConfigV2 } = await import('../dist/config/v2-schema.js');
    const config = defaultConfigV2(configPath, `bench-${randomUUID()}`);
    const apiKey = randomBytes(24).toString('base64url');
    config.server.port = proxyPort;
    config.server.bindAddress = '127.0.0.1';
    config.server.publicProxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
    config.server.maxAttempts = 1;
    config.admin.port = adminPort;
    config.admin.bindAddress = '127.0.0.1';
    config.admin.publicAdminBaseUrl = `http://127.0.0.1:${adminPort}`;
    config.admin.enabled = false;
    config.storage.dataDir = temp;
    config.quota.defaultMaxConcurrentRequests = Math.max(opt.concurrency * 2, 200);
    config.upstreams.push({ id: 'bench-upstream', name: 'Local fixed mock', provider: 'custom',
      protocol: 'openai', enabled: true, baseUrl: `${mock.url}/v1`,
      endpoints: { generate: 'chat/completions' }, auth: { mode: 'none' },
      credentials: [], models: [{ id: 'bench-model', enabled: true,
        capabilities: { text: 'supported', streamUsage: 'supported' }, capabilitiesSource: 'manual' }],
      policy: { allowInsecureHttp: true },
      priority: 0, sortIndex: 0 });
    config.routes.push({ id: 'bench-route', name: 'Local benchmark', enabled: true,
      clientProtocols: ['openai'], match: { kind: 'exact', value: 'bench-model' },
      order: 0, publishedModels: ['bench-model'],
      targets: [{ upstreamId: 'bench-upstream', model: 'bench-model' }] });
    config.proxyKeys.push({ id: 'bench-key', name: 'Local benchmark', enabled: true,
      createdAt: new Date().toISOString(), keyHash: createHash('sha256').update(apiKey).digest('hex'),
      keyPrefix: apiKey.slice(0, 8), maxConcurrentRequests: Math.max(opt.concurrency * 2, 200) });
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    const telemetry = new SQLiteTelemetryStore(dbPath);
    await telemetry.init();
    // Record the empty legacy-log cutoff before synthetic native V2 rows exist.
    // Otherwise server startup correctly refuses an ambiguous V1/V2 import and
    // degrades telemetry writes, making all proxied benchmark requests stall.
    const { importLegacyRequestLogs } = await import('../dist/storage/legacy-import.js');
    await importLegacyRequestLogs(telemetry);
    await telemetry.close();
    seed(dbPath, opt.historyRows, Date.now());
    const offlineStore = new SQLiteTelemetryStore(dbPath);
    await offlineStore.init();
    const liveAggregateRebuild = await offlineStore.rebuildLiveAggregates({ offline: true });
    await offlineStore.close();
    if (opt.warmup) await load(mock.url, null, opt.warmup, opt.concurrency, opt.timeoutMs);
    const direct = await load(mock.url, null, opt.requests, opt.concurrency, opt.timeoutMs);
    running = childServer(configPath);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    await ready(`${proxyUrl}/healthz`, running.child);
    if (opt.warmup) await load(proxyUrl, apiKey, opt.warmup, opt.concurrency, opt.timeoutMs);
    await childMetric(running.child, 'reset');
    const withoutConsole = await load(proxyUrl, apiKey, opt.requests, opt.concurrency, opt.timeoutMs);
    const baselineMetrics = await childMetric(running.child, 'snapshot');
    if (withoutConsole.failed) {
      withoutConsole.diagnostics = { mock: mock.snapshot(), proxyChild: running.diagnostic };
    }
    await stopChild(running.child); running = null;
    config.admin.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    running = childServer(configPath);
    await ready(`${proxyUrl}/healthz`, running.child);
    const adminUrl = `http://127.0.0.1:${adminPort}`;
    await ready(`${adminUrl}/admin/api/v1/bootstrap`, running.child);
    for (let i = 0; i < 20 && !running.bootstrapToken; i++) await pause(50);
    const api = await adminSession(adminUrl, running.bootstrapToken);
    if (opt.warmup) await load(proxyUrl, apiKey, opt.warmup, opt.concurrency, opt.timeoutMs);
    const range = `from=${encodeURIComponent(new Date(Date.now() - 7_200_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 600_000).toISOString())}`;
    const summaryEndpoint = `/usage/summary?${range}`;
    const before = (await api(summaryEndpoint)).data.logicalRequests;
    await childMetric(running.child, 'reset');
    const withConsole = await load(proxyUrl, apiKey, opt.requests, opt.concurrency, opt.timeoutMs);
    const consoleMetrics = await childMetric(running.child, 'snapshot');
    if (withConsole.failed) {
      withConsole.diagnostics = { mock: mock.snapshot(), proxyChild: running.diagnostic };
    }
    const visible = await visibility(api, summaryEndpoint, before + opt.requests, opt.timeoutMs);
    const pagination = await timedQueries(api, `/requests?${range}&limit=50`, opt.querySamples);
    const aggregation = await aggregate(api, opt.timeoutMs);
    const materializedRollupRead = aggregation.status === 'completed'
      ? rollupRead(dbPath, opt.querySamples) : null;
    const overviewEndpoint = `/overview?${range}`;
    const overviewCoverageResponse = await api(overviewEndpoint);
    const overviewCoverage = {
      coverage: overviewCoverageResponse.meta?.coverage ?? null,
      usageCoverage: overviewCoverageResponse.data?.usage?.coverage ?? null,
      productionSuccessRateMeasurement: overviewCoverageResponse.data?.productionSuccessRate?.measurement ?? null,
      preaggregated: overviewIsPreaggregated(overviewCoverageResponse),
    };
    if (!overviewCoverage.preaggregated)
      throw new Error(`Setup failure: /overview did not report live-minute preaggregate coverage: ${JSON.stringify(overviewCoverage)}`);
    const overview = await timedQueries(api, overviewEndpoint, opt.querySamples);
    const telemetryPerf = running.perfMetrics;
    const delta = withoutConsole.p95Ms === null || withConsole.p95Ms === null
      ? null : round(withConsole.p95Ms - withoutConsole.p95Ms);
    const cpus = os.cpus();
    const memoryGiB = os.totalmem() / 2 ** 30;
    const eligible = cpus.length === 4 && memoryGiB >= 7.5 && memoryGiB <= 8.5 &&
      opt.concurrency === 100 && opt.requests >= 1_000 && opt.historyRows === 1_000_000 &&
      opt.querySamples >= 20 &&
      direct.success === opt.requests && withoutConsole.success === opt.requests &&
      withConsole.success === opt.requests && overviewCoverage.preaggregated;
    let revision = null;
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* source archive */ }
    let sourceDirty = null;
    try { sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()); } catch { /* source archive */ }
    const result = {
      generatedAt: new Date().toISOString(), revision, sourceDirty,
      machine: { platform: os.platform(), architecture: os.arch(), release: os.release(),
        logicalCores: cpus.length, cpuModel: cpus[0]?.model ?? null,
        memoryGiB: round(memoryGiB), node: process.version },
      parameters: { ...opt, temporaryData: true, upstream: '127.0.0.1 fixed OpenAI SSE mock',
        seededRequests: opt.historyRows, seededAttempts: opt.historyRows },
      measurements: { directMock: direct, proxyWithoutConsole: { ...withoutConsole,
        eventLoopDelayP95Ms: round(baselineMetrics.eventLoopDelayP95Ms),
        eventLoopDelayMaxMs: round(baselineMetrics.eventLoopDelayMaxMs),
        eventLoopDelaySamples: baselineMetrics.eventLoopDelaySamples,
        rssSampledPeakBytes: baselineMetrics.rssPeakBytes },
        proxyWithConsole: { ...withConsole,
          eventLoopDelayP95Ms: round(consoleMetrics.eventLoopDelayP95Ms),
          eventLoopDelayMaxMs: round(consoleMetrics.eventLoopDelayMaxMs),
          eventLoopDelaySamples: consoleMetrics.eventLoopDelaySamples,
          rssSampledPeakBytes: consoleMetrics.rssPeakBytes },
        consoleAdditionalProxyP95Ms: delta,
        proxyOverDirectMockP95Ms: direct.p95Ms === null || withConsole.p95Ms === null
          ? null : round(withConsole.p95Ms - direct.p95Ms),
        pagination, aggregateJob: aggregation, materializedRollupRead,
        liveAggregateRebuild,
        overviewCoverage,
        preaggregatedOverviewP95: overview,
        overviewAfterAggregate: overview,
        usageVisibleAfterBurst: visible, databaseBytes: databaseBytes(temp),
        telemetryPerf: { samples: telemetryPerf.length, ...summarizeTelemetryPerf(telemetryPerf) },
        streamInterruptionRate: withConsole.interruptionRate },
      baseline: { directMock: direct.success === opt.requests,
        proxyWithoutConsole: withoutConsole.success === opt.requests,
        preaggregatedOverview: overviewCoverage.preaggregated,
        note: 'Console-off proxy baseline uses the same temporary database before console-on traffic; overview is measured only after verifying live-minute preaggregate coverage.' },
      thresholds: {
        consoleAdditionalProxyP95Ms: target(delta, 10, eligible),
        paginationP95Ms: target(pagination.p95Ms, 300, eligible, { strict: true }),
        preaggregatedOverviewP95Ms: target(overview.p95Ms, 500, eligible && overviewCoverage.preaggregated, { strict: true }),
        usageVisibilityMs: target(visible.visibleMs, 5_000, eligible, { strict: true }),
      },
    };
    console.log(JSON.stringify(result, null, 2));
    if (direct.failed || withoutConsole.failed || withConsole.failed || !visible.visible) {
      throw new Error('Benchmark traffic failed or usage visibility was not achieved; see emitted phase diagnostics');
    }
  } catch (error) {
    if (running) process.stderr.write(`${running.diagnostic}\n`);
    throw error;
  } finally {
    await stopChild(running?.child);
    if (mock) {
      mock.server.closeAllConnections();
      await new Promise((resolve) => mock.server.close(resolve));
    }
    // Exact directory returned by mkdtemp; no user-provided cleanup target exists.
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('model-router-console-bench-'))
      fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
}
