#!/usr/bin/env node
// bench-gateway.mjs — R9 performance benchmark driver for the managed-SaaS
// gateway compose stack (plan §R9, docs/token-resale-implementation-plan-2026-10-15.md).
//
// Targets a RUNNING compose stack (Docker host required for the stack itself;
// this driver only speaks HTTP and never runs docker). Precedent:
// scripts/ops/bench-ollama.mjs. Node built-ins only, no new dependencies.
//
// Scenarios (plan §R9 targets; thresholds are CLI flags with the plan defaults):
//   latency       non-streaming p50/p90/p99 through the gateway vs the
//                 zero-latency mock-upstream baseline measured directly from
//                 the bench host. Target: p99 proxy overhead < 30ms.
//   ttfb          streaming time-to-first-byte through the gateway vs the
//                 direct mock baseline. Target: overhead < 10ms.
//   sse-integrity sustained streaming (default 10 minutes) with chunk-level
//                 validation: every SSE data payload from the mock carries
//                 bench_seq; the driver checks strict 0..N-1 continuity and
//                 terminal markers. Target: zero corrupt streams.
//   concurrency   closed-loop ramp to 200 concurrent in-flight requests,
//                 round-robin across all GATEWAY_URLS. Target: zero transport
//                 errors / unexpected 5xx while 200 stay in flight.
//   precision     429/account-slot precision: drive saturation load, then read
//                 the mock's per-account maxInFlight and compare against the
//                 configured per-account concurrency limit. Target: zero
//                 over-issue (maxInFlight never exceeds the limit).
//   scaling       fixed closed-loop load against the currently running gateway
//                 set; reports throughput + instance count. Run once with
//   instance, once with 3, pass --baseline-report on the second run to get
//                 the 1→3 ratio. Target: >= 2.7x.
//
// Usage:
//   GATEWAY_URLS=http://127.0.0.1:15007,http://127.0.0.1:15008,http://127.0.0.1:15009 \
//   BENCH_PROXY_KEY=<proxy key> MOCK_CONTROL_URL=http://127.0.0.1:18080 \
//   MOCK_UPSTREAM_URL=https://127.0.0.1:18443 \
//   NODE_EXTRA_CA_CERTS=deploy/compose/bench/certs/mock-cert.pem \
//     node scripts/ops/bench-gateway.mjs --scenario all
//
//   node scripts/ops/bench-gateway.mjs --dry-run --scenario all
//     Self-check: validates arguments/config and prints the execution plan
//     without any network traffic. Missing runtime env is reported as a
//     warning, argument errors exit 2.
//
// Exit codes: 0 pass (or dry-run), 1 threshold violation, 2 bad arguments or
// missing required runtime config, 3 target unreachable.
//
// No secrets in this file: the proxy key is read from BENCH_PROXY_KEY env.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SCENARIOS = ['latency', 'ttfb', 'sse-integrity', 'concurrency', 'precision', 'scaling'];
const PROTOCOLS = ['anthropic', 'openai'];

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function argError(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) argError(`--${name} requires a value`);
  return v;
}

function intArg(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = argValue(name, fallback);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    argError(`--${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`);
  }
  return n;
}

const dryRun = hasFlag('dry-run');
const scenarioArg = String(argValue('scenario', 'all'));
const scenarios = scenarioArg === 'all' ? [...SCENARIOS] : scenarioArg.split(',').map((s) => s.trim());
for (const s of scenarios) {
  if (!SCENARIOS.includes(s)) argError(`unknown scenario ${JSON.stringify(s)} (valid: all, ${SCENARIOS.join(', ')})`);
}

const config = {
  protocol: String(argValue('protocol', process.env.BENCH_PROTOCOL ?? 'anthropic')),
  model: String(argValue('model', process.env.BENCH_MODEL ?? 'bench-model')),
  maxTokens: intArg('max-tokens', 64, { min: 1, max: 100_000 }),
  requests: intArg('requests', 300, { min: 10, max: 1_000_000 }),
  streamSamples: intArg('stream-samples', 100, { min: 10, max: 100_000 }),
  sseMinutes: intArg('sse-minutes', 10, { min: 1, max: 24 * 60 }),
  sseConcurrency: intArg('sse-concurrency', 20, { min: 1, max: 10_000 }),
  sseChunks: intArg('sse-chunks', 64, { min: 2, max: 100_000 }),
  sseChunkDelayMs: intArg('sse-chunk-delay-ms', 0, { min: 0, max: 60_000 }),
  inflight: intArg('inflight', 200, { min: 1, max: 10_000 }),
  concurrencySeconds: intArg('concurrency-seconds', 60, { min: 5, max: 24 * 60 * 60 }),
  accountLimit: intArg('account-limit', Number(process.env.BENCH_ACCOUNT_LIMIT ?? 0), { min: 0, max: 100_000 }),
  precisionAccounts: String(argValue('precision-accounts', process.env.BENCH_ACCOUNTS ?? '')),
  precisionInflight: intArg('precision-inflight', 0, { min: 0, max: 10_000 }),
  scalingSeconds: intArg('scaling-seconds', 60, { min: 5, max: 24 * 60 * 60 }),
  scalingInflight: intArg('scaling-inflight', 200, { min: 1, max: 10_000 }),
  baselineReport: String(argValue('baseline-report', '')) || null,
  p99OverheadMs: intArg('p99-overhead-ms', 30, { min: 1, max: 3_600_000 }),
  ttfbOverheadMs: intArg('ttfb-overhead-ms', 10, { min: 1, max: 3_600_000 }),
  sseMaxCorruptStreams: intArg('sse-max-corrupt-streams', 0, { min: 0, max: 1_000_000 }),
  maxTransportErrors: intArg('max-transport-errors', 0, { min: 0, max: 1_000_000 }),
  maxUnexpected5xx: intArg('max-unexpected-5xx', 0, { min: 0, max: 1_000_000 }),
  scalingMinRatio: Number(argValue('scaling-min-ratio', '2.7')),
  requestTimeoutMs: intArg('timeout-ms', 60_000, { min: 1000, max: 3_600_000 }),
  out: String(argValue('out', '')),
  noFail: hasFlag('no-fail'),
};
if (!PROTOCOLS.includes(config.protocol)) {
  argError(`--protocol must be one of ${PROTOCOLS.join(', ')} (got ${config.protocol})`);
}
if (!Number.isFinite(config.scalingMinRatio) || config.scalingMinRatio <= 0) {
  argError('--scaling-min-ratio must be a positive number');
}
if (scenarios.includes('precision')) {
  if (config.accountLimit === 0) {
    const msg =
      '--account-limit (or BENCH_ACCOUNT_LIMIT) is required for the precision scenario: the per-provider-account concurrency limit configured on the bench accounts.';
    if (dryRun) console.error(`warning: ${msg}`);
    else argError(msg);
  }
}
if (config.baselineReport && !existsSync(config.baselineReport)) {
  argError(`--baseline-report file not found: ${config.baselineReport}`);
}
if (config.precisionInflight === 0) config.precisionInflight = config.inflight;

// ── Runtime environment (missing values are warnings in dry-run) ──────────────
const env = {
  gatewayUrls: (process.env.GATEWAY_URLS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  proxyKey: process.env.BENCH_PROXY_KEY ?? '',
  mockControlUrl: (process.env.MOCK_CONTROL_URL ?? '').replace(/\/+$/, ''),
  mockUpstreamUrl: (process.env.MOCK_UPSTREAM_URL ?? '').replace(/\/+$/, ''),
};

const configProblems = [];
if (env.gatewayUrls.length === 0) configProblems.push('GATEWAY_URLS (comma-separated gateway base URLs) is not set');
if (!env.proxyKey) configProblems.push('BENCH_PROXY_KEY (bench proxy key) is not set');
if (!env.mockControlUrl) {
  configProblems.push(
    'MOCK_CONTROL_URL (mock-upstream control base URL) is not set — shape/fault control and precision stats unavailable',
  );
}
if (!env.mockUpstreamUrl && scenarios.includes('latency')) {
  configProblems.push('MOCK_UPSTREAM_URL is not set — the latency scenario cannot compute the direct baseline');
}
if (!env.mockUpstreamUrl && scenarios.includes('ttfb')) {
  configProblems.push('MOCK_UPSTREAM_URL is not set — the ttfb scenario cannot compute the direct baseline');
}

// ── Dry run: validated plan, zero network ─────────────────────────────────────
if (dryRun) {
  const scenarioPlan = {
    latency: `serial non-streaming: ${config.requests} direct-to-mock + ${config.requests} through-gateway; overhead = gw_p99 - direct_p99; threshold ${config.p99OverheadMs}ms`,
    ttfb: `serial streaming first-byte: ${config.streamSamples} direct + ${config.streamSamples} gateway; threshold ${config.ttfbOverheadMs}ms`,
    'sse-integrity': `closed-loop streaming, c=${config.sseConcurrency} for ${config.sseMinutes}min, ${config.sseChunks} chunks/stream (chunk delay ${config.sseChunkDelayMs}ms); bench_seq continuity + terminal marker; max corrupt streams ${config.sseMaxCorruptStreams}`,
    concurrency: `closed-loop, c=${config.inflight} in flight for ${config.concurrencySeconds}s, round-robin over gateway URLs; max transport errors ${config.maxTransportErrors}, max unexpected 5xx ${config.maxUnexpected5xx}`,
    precision: `closed-loop saturation, c=${config.precisionInflight} for ${config.concurrencySeconds}s; mock per-account maxInFlight vs account limit ${config.accountLimit || '(MISSING --account-limit)'}; zero over-issue required`,
    scaling: `closed-loop, c=${config.scalingInflight} for ${config.scalingSeconds}s; report rps + instance count${config.baselineReport ? `; ratio vs baseline ${config.baselineReport}, min ${config.scalingMinRatio}x` : ' (pass --baseline-report on the 3-instance run to compute the 1→3 ratio)'}`,
  };
  console.log('bench-gateway dry-run: configuration validated, no network traffic performed.');
  console.log(`protocol: ${config.protocol}  model: ${config.model}  max_tokens: ${config.maxTokens}`);
  console.log(`scenarios: ${scenarios.join(', ')}`);
  for (const s of scenarios) console.log(`  - ${s}: ${scenarioPlan[s]}`);
  console.log(`gateway URLs (${env.gatewayUrls.length}): ${env.gatewayUrls.join(', ') || '(none)'}`);
  console.log(`mock control URL: ${env.mockControlUrl || '(none)'}`);
  console.log(`mock upstream URL: ${env.mockUpstreamUrl || '(none)'}`);
  console.log(`proxy key: ${env.proxyKey ? '(set)' : '(not set)'}`);
  if (configProblems.length > 0) {
    console.log('config problems (must be fixed before a real run):');
    for (const p of configProblems) console.log(`  MISSING: ${p}`);
  }
  console.log('note: executing the scenarios requires the compose stack on a Docker host (deploy/compose/BENCH.md).');
  process.exit(0);
}

// ── Real-run gates ────────────────────────────────────────────────────────────
for (const p of configProblems) {
  if (p.startsWith('MOCK_CONTROL_URL') && !scenarios.includes('precision')) continue; // optional elsewhere
  if (p.startsWith('MOCK_UPSTREAM_URL')) continue; // handled per-scenario below
  console.error(`error: ${p}`);
  process.exit(2);
}
if (env.gatewayUrls.length === 0 || !env.proxyKey) {
  console.error('error: GATEWAY_URLS and BENCH_PROXY_KEY are required (dry-run with --dry-run).');
  process.exit(2);
}

const report = {
  tool: 'bench-gateway',
  startedAt: new Date().toISOString(),
  config: {
    ...config,
    baselineReport: config.baselineReport,
    gatewayUrls: env.gatewayUrls,
    instanceCount: env.gatewayUrls.length,
    protocol: config.protocol,
    model: config.model,
  },
  scenarios: {},
  violations: [],
};

function violation(scenario, metric, value, threshold, unit = '') {
  report.violations.push({ scenario, metric, value, threshold, unit });
  console.error(`VIOLATION [${scenario}] ${metric}: ${value}${unit} (threshold ${threshold}${unit})`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const violationsExit = () => {
  report.finishedAt = new Date().toISOString();
  console.log(`\n${report.violations.length} violation(s).`);
  process.exit(config.noFail || report.violations.length === 0 ? 0 : 1);
};

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function latencySummary(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: Number(pct(s, 0.5).toFixed(2)),
    p90: Number(pct(s, 0.9).toFixed(2)),
    p99: Number(pct(s, 0.99).toFixed(2)),
    max: s.length ? Number(s[s.length - 1].toFixed(2)) : 0,
  };
}

function requestSpec(stream) {
  if (config.protocol === 'anthropic') {
    return {
      path: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        model: config.model,
        max_tokens: config.maxTokens,
        stream,
        messages: [{ role: 'user', content: 'bench' }],
      },
    };
  }
  return {
    path: '/v1/chat/completions',
    headers: {},
    body: {
      model: config.model,
      max_tokens: config.maxTokens,
      stream,
      messages: [{ role: 'user', content: 'bench' }],
    },
  };
}

let rrIndex = 0;
function nextGatewayUrl() {
  const url = env.gatewayUrls[rrIndex % env.gatewayUrls.length];
  rrIndex += 1;
  return url;
}

async function postJson(url, pathName, body, headers = {}, timeoutMs = config.requestTimeoutMs) {
  const t0 = performance.now();
  const response = await fetch(`${url}${pathName}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, elapsedMs: performance.now() - t0 };
}

async function gatewayRequest(stream, url = nextGatewayUrl()) {
  const spec = requestSpec(stream);
  return postJson(
    url,
    spec.path,
    spec.body,
    { authorization: `Bearer ${env.proxyKey}`, ...spec.headers },
  );
}

async function mockRequest(stream) {
  const spec = requestSpec(stream);
  return postJson(env.mockUpstreamUrl, spec.path, spec.body, spec.headers);
}

async function control(endpoint, body) {
  const response = await fetch(`${env.mockControlUrl}${endpoint}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`mock control ${endpoint} -> ${response.status}`);
  return response.json();
}

async function mockStats() {
  const response = await fetch(`${env.mockControlUrl}/__control/stats`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`mock stats -> ${response.status}`);
  return response.json();
}

/** Closed-loop worker pool: `concurrency` workers each keep one unit in flight until the deadline. */
async function closedLoop(concurrency, durationMs, worker) {
  const deadline = performance.now() + durationMs;
  let index = 0;
  const errors = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const i = index++;
      try {
        await worker(i);
      } catch (error) {
        errors.push(error);
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

function statusBump(buckets, status) {
  const key = String(status);
  buckets[key] = (buckets[key] ?? 0) + 1;
}

// ── Preflight: targets reachable ──────────────────────────────────────────────
async function preflight() {
  const failures = [];
  await Promise.all(
    env.gatewayUrls.map(async (url) => {
      try {
        // Managed-SaaS gateways expose no /healthz; an HTTP 404 from the /v1
        // listener still proves the listener is up. Anything else is fatal.
        const r = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5_000) });
        if (r.status >= 500) failures.push(`${url} -> ${r.status}`);
      } catch (error) {
        failures.push(`${url} -> ${String(error.cause?.code ?? error.message).slice(0, 80)}`);
      }
    }),
  );
  if (failures.length > 0) {
    console.error(`error: unreachable gateway URL(s): ${failures.join('; ')}`);
    process.exit(3);
  }
  if (env.mockControlUrl) {
    try {
      await mockStats();
    } catch (error) {
      console.error(`error: mock control plane unreachable at ${env.mockControlUrl}: ${error.message}`);
      process.exit(3);
    }
  }
}

// ── Scenario: latency ─────────────────────────────────────────────────────────
async function scenarioLatency() {
  console.log(`\n== latency: ${config.requests} direct + ${config.requests} gateway (serial, zero-latency mock) ==`);
  if (env.mockControlUrl) await control('/__control/delay', { ms: 0 });
  const hasBaseline = env.mockUpstreamUrl !== '';

  // Warm the gateway (JIT, PG pools, KMS keyring) before measuring.
  await closedLoop(4, 3_000, async () => {
    const { response } = await gatewayRequest(false);
    await response.text();
  });

  const direct = [];
  if (hasBaseline) {
    for (let i = 0; i < config.requests; i += 1) {
      const { response, elapsedMs } = await mockRequest(false);
      await response.text();
      if (response.status === 200) direct.push(elapsedMs);
    }
  }
  const through = [];
  for (let i = 0; i < config.requests; i += 1) {
    const { response, elapsedMs } = await gatewayRequest(false);
    await response.text();
    if (response.status === 200) through.push(elapsedMs);
  }
  const directSummary = latencySummary(direct);
  const gatewaySummary = latencySummary(through);
  const overhead = hasBaseline ? Number((gatewaySummary.p99 - directSummary.p99).toFixed(2)) : null;
  console.log(`  direct  : ${JSON.stringify(directSummary)}`);
  console.log(`  gateway : ${JSON.stringify(gatewaySummary)}`);
  console.log(`  p99 overhead: ${overhead === null ? 'n/a (no baseline)' : `${overhead}ms`} (threshold ${config.p99OverheadMs}ms)`);
  report.scenarios.latency = { direct: directSummary, gateway: gatewaySummary, p99OverheadMs: overhead };
  if (overhead !== null && overhead > config.p99OverheadMs) {
    violation('latency', 'p99 overhead', overhead, config.p99OverheadMs, 'ms');
  }
}

// ── Scenario: ttfb ────────────────────────────────────────────────────────────
async function measureTtfb(requestFn) {
  const t0 = performance.now();
  const { response } = await requestFn();
  if (response.status !== 200) {
    await response.text();
    throw new Error(`status ${response.status}`);
  }
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const ttfb = performance.now() - t0;
  await reader.cancel();
  if (!value || value.length === 0) throw new Error('empty first chunk');
  return ttfb;
}

async function scenarioTtfb() {
  console.log(`\n== ttfb: ${config.streamSamples} direct + ${config.streamSamples} gateway streaming first-byte ==`);
  if (env.mockControlUrl) {
    await control('/__control/shape', { chunks: config.sseChunks, chunkDelayMs: config.sseChunkDelayMs });
    await control('/__control/delay', { ms: 0 });
  }
  const hasBaseline = env.mockUpstreamUrl !== '';

  await closedLoop(4, 3_000, async () => {
    const { response } = await gatewayRequest(true);
    await response.text();
  });

  const direct = [];
  if (hasBaseline) {
    for (let i = 0; i < config.streamSamples; i += 1) {
      try {
        direct.push(await measureTtfb(() => mockRequest(true)));
      } catch {
        // counted as failures below via missing samples
      }
    }
  }
  const through = [];
  let gatewayErrors = 0;
  for (let i = 0; i < config.streamSamples; i += 1) {
    try {
      through.push(await measureTtfb(() => gatewayRequest(true)));
    } catch {
      gatewayErrors += 1;
    }
  }
  const directSummary = latencySummary(direct);
  const gatewaySummary = latencySummary(through);
  const overhead = hasBaseline ? Number((gatewaySummary.p99 - directSummary.p99).toFixed(2)) : null;
  console.log(`  direct  : ${JSON.stringify(directSummary)}`);
  console.log(`  gateway : ${JSON.stringify(gatewaySummary)} (errors: ${gatewayErrors})`);
  console.log(`  ttfb overhead: ${overhead === null ? 'n/a (no baseline)' : `${overhead}ms`} (threshold ${config.ttfbOverheadMs}ms)`);
  report.scenarios.ttfb = {
    direct: directSummary,
    gateway: gatewaySummary,
    gatewayErrors,
    ttfbOverheadMs: overhead,
  };
  if (gatewayErrors > 0) violation('ttfb', 'stream errors', gatewayErrors, 0);
  if (overhead !== null && overhead > config.ttfbOverheadMs) {
    violation('ttfb', 'ttfb overhead', overhead, config.ttfbOverheadMs, 'ms');
  }
}

// ── Scenario: sse-integrity ───────────────────────────────────────────────────
/**
 * Streams one request and validates the mock's integrity encoding:
 * bench_seq must be exactly 0,1,2,... per stream and a terminal marker
 * ([DONE] for openai, message_stop for anthropic) must close the stream.
 */
async function validateOneStream(url) {
  const { response } = await gatewayRequest(true, url);
  if (response.status !== 200) {
    await response.text();
    return { status: response.status, corruptChunks: 0, chunks: 0, corrupt: true, reason: `status ${response.status}` };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let expectedSeq = 0;
  let chunks = 0;
  let corruptChunks = 0;
  let terminal = false;
  let reason = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const rawEvent = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          terminal = true;
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          corruptChunks += 1;
          reason ||= 'unparseable data payload';
          continue;
        }
        if (parsed?.type === 'message_stop') {
          terminal = true;
          continue;
        }
        if (typeof parsed?.bench_seq === 'number') {
          chunks += 1;
          if (parsed.bench_seq !== expectedSeq) {
            corruptChunks += 1;
            reason ||= `bench_seq ${parsed.bench_seq} != expected ${expectedSeq}`;
          }
          expectedSeq = parsed.bench_seq + 1;
        }
      }
    }
  }
  const corrupt = corruptChunks > 0 || !terminal;
  if (!terminal) reason ||= 'missing terminal marker';
  return { status: 200, chunks, corruptChunks, corrupt, reason };
}

async function scenarioSseIntegrity() {
  console.log(
    `\n== sse-integrity: c=${config.sseConcurrency} for ${config.sseMinutes}min, ${config.sseChunks} chunks/stream ==`,
  );
  if (env.mockControlUrl) {
    await control('/__control/shape', { chunks: config.sseChunks, chunkDelayMs: config.sseChunkDelayMs });
  }
  const durationMs = config.sseMinutes * 60_000;
  const t0 = performance.now();
  let streams = 0;
  let corruptStreams = 0;
  let chunks = 0;
  let corruptChunks = 0;
  const reasons = {};
  const progress = setInterval(() => {
    const minutes = ((performance.now() - t0) / 60_000).toFixed(1);
    console.log(`  [${minutes}min] streams=${streams} corrupt=${corruptStreams} chunks=${chunks}`);
  }, 60_000);
  try {
    await closedLoop(config.sseConcurrency, durationMs, async () => {
      let result;
      try {
        result = await validateOneStream(nextGatewayUrl());
      } catch (error) {
        result = {
          status: 'transport-error',
          chunks: 0,
          corruptChunks: 0,
          corrupt: true,
          reason: `transport: ${String(error.cause?.code ?? error.name).slice(0, 40)}`,
        };
      }
      streams += 1;
      chunks += result.chunks;
      corruptChunks += result.corruptChunks;
      if (result.corrupt) {
        corruptStreams += 1;
        reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      }
    });
  } finally {
    clearInterval(progress);
  }
  console.log(`  streams=${streams} corruptStreams=${corruptStreams} chunks=${chunks} corruptChunks=${corruptChunks}`);
  if (Object.keys(reasons).length > 0) console.log(`  corruption reasons: ${JSON.stringify(reasons)}`);
  report.scenarios['sse-integrity'] = {
    minutes: config.sseMinutes,
    concurrency: config.sseConcurrency,
    streams,
    corruptStreams,
    chunks,
    corruptChunks,
    reasons,
  };
  if (corruptStreams > config.sseMaxCorruptStreams) {
    violation('sse-integrity', 'corrupt streams', corruptStreams, config.sseMaxCorruptStreams);
  }
}

// ── Scenario: concurrency ─────────────────────────────────────────────────────
async function scenarioConcurrency() {
  console.log(`\n== concurrency: ${config.inflight} in flight for ${config.concurrencySeconds}s across ${env.gatewayUrls.length} instance(s) ==`);
  const perUrl = env.gatewayUrls.map((u) => ({ url: u, requests: 0 }));
  const statuses = {};
  const latencies = [];
  let transportErrors = 0;
  const errors = {};
  const t0 = performance.now();
  const rrCounter = { i: 0 };
  await closedLoop(config.inflight, config.concurrencySeconds * 1000, async () => {
    const idx = rrCounter.i++ % env.gatewayUrls.length;
    perUrl[idx].requests += 1;
    const url = env.gatewayUrls[idx];
    try {
      const { response, elapsedMs } = await gatewayRequest(false, url);
      await response.text();
      statusBump(statuses, response.status);
      if (response.status === 200) latencies.push(elapsedMs);
    } catch (error) {
      transportErrors += 1;
      const key = String(error.cause?.code ?? error.name).slice(0, 40);
      errors[key] = (errors[key] ?? 0) + 1;
    }
  });
  const durationS = (performance.now() - t0) / 1000;
  const unexpected5xx = Object.entries(statuses)
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);
  const summary = latencySummary(latencies);
  const rps = latencies.length / durationS;
  console.log(`  duration=${durationS.toFixed(1)}s ok=${latencies.length} rps=${rps.toFixed(2)}`);
  console.log(`  statuses: ${JSON.stringify(statuses)} transportErrors=${transportErrors} ${JSON.stringify(errors)}`);
  console.log(`  per-instance requests: ${JSON.stringify(perUrl)}`);
  console.log(`  latency: ${JSON.stringify(summary)}`);
  report.scenarios.concurrency = {
    inflight: config.inflight,
    seconds: Number(durationS.toFixed(1)),
    statuses,
    transportErrors,
    errors,
    perUrl,
    latency: summary,
    throughputRps: Number(rps.toFixed(2)),
  };
  if (transportErrors > config.maxTransportErrors) {
    violation('concurrency', 'transport errors', transportErrors, config.maxTransportErrors);
  }
  if (unexpected5xx > config.maxUnexpected5xx) {
    violation('concurrency', 'unexpected 5xx', unexpected5xx, config.maxUnexpected5xx);
  }
}

// ── Scenario: precision (429 / account-slot over-issue) ───────────────────────
async function scenarioPrecision() {
  console.log(
    `\n== precision: saturation c=${config.precisionInflight} for ${config.concurrencySeconds}s, account limit ${config.accountLimit} ==`,
  );
  if (!env.mockControlUrl) {
    console.error('error: precision requires MOCK_CONTROL_URL (mock per-account stats).');
    process.exit(2);
  }
  if (config.accountLimit === 0) {
    console.error('error: precision requires --account-limit (or BENCH_ACCOUNT_LIMIT).');
    process.exit(2);
  }
  // Fresh stats window: reset, then re-apply the shape (reset clears it).
  await control('/__control/reset', {});
  await control('/__control/shape', { chunks: 8, chunkDelayMs: 0 });
  await control('/__control/delay', { ms: 0 });

  const statuses = {};
  await closedLoop(config.precisionInflight, config.concurrencySeconds * 1000, async () => {
    try {
      const { response } = await gatewayRequest(false);
      await response.text();
      statusBump(statuses, response.status);
    } catch {
      statusBump(statuses, 'transport-error');
    }
  });

  const stats = await mockStats();
  const tracked = config.precisionAccounts
    ? config.precisionAccounts.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(stats.accounts);
  const perAccount = {};
  let overIssueAccounts = 0;
  for (const account of tracked) {
    const rec = stats.accounts[account];
    if (!rec) continue;
    perAccount[account] = { maxInFlight: rec.maxInFlight, requests: rec.requests, byStatus: rec.byStatus };
    if (rec.maxInFlight > config.accountLimit) overIssueAccounts += 1;
  }
  console.log(`  client statuses: ${JSON.stringify(statuses)}`);
  for (const [account, rec] of Object.entries(perAccount)) {
    const flag = rec.maxInFlight > config.accountLimit ? '  <-- OVER-ISSUE' : '';
    console.log(`  account ${account.slice(0, 12)}… maxInFlight=${rec.maxInFlight} requests=${rec.requests}${flag}`);
  }
  report.scenarios.precision = {
    accountLimit: config.accountLimit,
    saturationInflight: config.precisionInflight,
    clientStatuses: statuses,
    perAccount,
    overIssueAccounts,
  };
  if (overIssueAccounts > 0) {
    violation('precision', 'accounts with maxInFlight > limit', overIssueAccounts, 0);
  }
}

// ── Scenario: scaling ─────────────────────────────────────────────────────────
async function scenarioScaling() {
  console.log(
    `\n== scaling: c=${config.scalingInflight} for ${config.scalingSeconds}s on ${env.gatewayUrls.length} instance(s) ==`,
  );
  const latencies = [];
  const statuses = {};
  const t0 = performance.now();
  await closedLoop(config.scalingInflight, config.scalingSeconds * 1000, async () => {
    try {
      const { response, elapsedMs } = await gatewayRequest(false);
      await response.text();
      statusBump(statuses, response.status);
      if (response.status === 200) latencies.push(elapsedMs);
    } catch {
      statusBump(statuses, 'transport-error');
    }
  });
  const durationS = (performance.now() - t0) / 1000;
  const rps = Number((latencies.length / durationS).toFixed(2));
  const summary = latencySummary(latencies);
  console.log(`  throughput: ${rps} rps (${latencies.length} ok in ${durationS.toFixed(1)}s)`);
  console.log(`  statuses: ${JSON.stringify(statuses)} latency: ${JSON.stringify(summary)}`);

  const result = {
    instanceCount: env.gatewayUrls.length,
    inflight: config.scalingInflight,
    seconds: Number(durationS.toFixed(1)),
    throughputRps: rps,
    statuses,
    latency: summary,
  };

  if (config.baselineReport) {
    const baseline = JSON.parse(readFileSync(config.baselineReport, 'utf8'));
    const base = baseline?.scenarios?.scaling;
    if (!base?.throughputRps) {
      console.error(`warning: baseline report has no scenarios.scaling.throughputRps; ratio not computed.`);
      result.ratio = null;
    } else {
      const ratio = Number((rps / base.throughputRps).toFixed(3));
      result.baseline = { file: config.baselineReport, instanceCount: base.instanceCount, throughputRps: base.throughputRps };
      result.ratio = ratio;
      console.log(`  scaling ratio: ${base.instanceCount} -> ${env.gatewayUrls.length} instances = ${ratio}x (min ${config.scalingMinRatio}x)`);
      if (env.gatewayUrls.length <= base.instanceCount) {
        console.error('warning: current run has no more instances than the baseline; ratio check skipped.');
      } else if (ratio < config.scalingMinRatio) {
        violation('scaling', 'throughput ratio', ratio, config.scalingMinRatio, 'x');
      }
    }
  } else {
    console.log('  (pass --baseline-report on the N-instance run to compute the 1→N ratio)');
  }
  report.scenarios.scaling = result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const order = ['latency', 'ttfb', 'sse-integrity', 'concurrency', 'precision', 'scaling'];
try {
  await preflight();
  for (const s of order) {
    if (!scenarios.includes(s)) continue;
    if (s === 'latency') await scenarioLatency();
    if (s === 'ttfb') await scenarioTtfb();
    if (s === 'sse-integrity') await scenarioSseIntegrity();
    if (s === 'concurrency') await scenarioConcurrency();
    if (s === 'precision') await scenarioPrecision();
    if (s === 'scaling') await scenarioScaling();
  }
} catch (error) {
  console.error(`error: scenario failed: ${error.message}`);
  report.fatalError = String(error.message);
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.exit(3);
}

function writeReport() {
  const out =
    config.out ||
    path.join(process.cwd(), `bench-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written: ${out}`);
}
writeReport();
violationsExit();
