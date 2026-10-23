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
  warmupInflight: intArg('warmup-inflight', 4, { min: 1, max: 200 }),
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
// Observation settings stay outside config so the default report shape is unchanged.
const requestSamplesOut = String(argValue('request-samples-out', ''));
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

function validRequestSamplesOptions(out, selectedScenarios, configuration, environment) {
  return (
    !out ||
    (path.isAbsolute(out) &&
      !existsSync(out) &&
      out !== path.resolve(configuration.out || '.') &&
      [...selectedScenarios].sort().join(',') === 'latency,ttfb' &&
      configuration.requests === 100 &&
      configuration.streamSamples === 100 &&
      configuration.warmupInflight === 1 &&
      configuration.noFail === false &&
      configuration.p99OverheadMs === 30 &&
      configuration.ttfbOverheadMs === 10 &&
      environment.gatewayUrls.length === 3 &&
      new Set(environment.gatewayUrls).size === 3 &&
      environment.mockUpstreamUrl !== '')
  );
}
if (!validRequestSamplesOptions(requestSamplesOut, scenarios, config, env)) {
  argError('--request-samples-out requires an absolute new file and the unchanged diagnostic serial 100/100 latency,ttfb configuration');
}

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
  console.log(`warmup inflight: ${config.warmupInflight} (3000ms per latency/ttfb warmup)`);
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
const REQUEST_SAMPLES_CAP = 400;
const REQUEST_SAMPLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestSampleJournal = requestSamplesOut
  ? { schema: 1, observationOk: true, failure: null, cap: REQUEST_SAMPLES_CAP, samples: [] }
  : null;
let requestSampleWriteAttempted = false;

function requestSampleFailure(stage) {
  if (!requestSampleJournal) return;
  requestSampleJournal.observationOk = false;
  requestSampleJournal.failure ??= { stage, sqlState: null };
}

function requestSampleContext(scenario, leg, index) {
  if (!requestSampleJournal) return null;
  return { scenario, leg, index, gatewayIndex: null, startedAt: new Date().toISOString() };
}

function requestSampleOutcome(error, response, metricMs) {
  try {
    if (response && response.status !== 200) return 'http_error';
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    if (error?.message === 'empty first chunk') return 'empty_chunk';
    return metricMs === null ? 'network_error' : 'cancel_error';
  } catch {
    requestSampleFailure('sample_recording');
    return 'network_error';
  }
}

function recordRequestSample(context, response, metricMs, includedInSummary, outcome) {
  if (!requestSampleJournal || !context) return;
  try {
    if (requestSampleJournal.samples.length >= REQUEST_SAMPLES_CAP) {
      requestSampleFailure('sample_cap');
      return;
    }
    let requestId = null;
    let requestIdState = 'not_applicable';
    if (context.leg === 'gateway') {
      const header = response?.headers.get('x-request-id');
      requestIdState = !header ? 'missing' : header.length === 36 && REQUEST_SAMPLE_UUID.test(header) ? 'valid' : 'invalid';
      if (requestIdState === 'valid') requestId = header.toLowerCase();
    }
    requestSampleJournal.samples.push({
      scenario: context.scenario,
      leg: context.leg,
      index: context.index,
      gatewayIndex: context.gatewayIndex,
      startedAt: context.startedAt,
      recordedAt: new Date().toISOString(),
      status: response?.status ?? null,
      outcome,
      includedInSummary,
      metricMs: Number.isFinite(metricMs) ? metricMs : null,
      requestId,
      requestIdState,
    });
  } catch {
    requestSampleFailure('sample_recording');
  }
}

function requestSampleCompleteness(samples) {
  const legs = ['latency:direct', 'latency:gateway', 'ttfb:direct', 'ttfb:gateway'];
  const counts = Object.fromEntries(legs.map((leg) => [leg, 0]));
  const indices = new Set();
  let shapeValid = true;
  for (const sample of samples) {
    const leg = `${sample.scenario}:${sample.leg}`;
    if (!Object.hasOwn(counts, leg) || !Number.isInteger(sample.index) || sample.index < 0 || sample.index >= 100) {
      shapeValid = false;
      continue;
    }
    counts[leg]++;
    const key = `${leg}:${sample.index}`;
    if (indices.has(key)) shapeValid = false;
    indices.add(key);
    if (sample.leg === 'gateway' && ![0, 1, 2].includes(sample.gatewayIndex)) shapeValid = false;
  }
  const gateway = samples.filter((sample) => sample.leg === 'gateway');
  const validIds = gateway.filter((sample) => sample.requestIdState === 'valid').map((sample) => sample.requestId);
  return {
    complete: shapeValid && samples.length === REQUEST_SAMPLES_CAP && Object.values(counts).every((count) => count === 100),
    counts,
    correlationComplete: gateway.length === 200 && validIds.length === 200 && new Set(validIds).size === 200,
    missingRequestIds: gateway.filter((sample) => sample.requestIdState === 'missing').length,
    invalidRequestIds: gateway.filter((sample) => sample.requestIdState === 'invalid').length,
    duplicateRequestIds: validIds.length - new Set(validIds).size,
  };
}

function requestSampleSelections(samples) {
  const selections = {};
  for (const scenario of ['latency', 'ttfb']) {
    for (const leg of ['direct', 'gateway']) {
      const sorted = samples.filter((sample) => sample.scenario === scenario && sample.leg === leg && sample.includedInSummary)
        .sort((left, right) => left.metricMs - right.metricMs);
      selections[`${scenario}:${leg}`] = {
        n: sorted.length,
        metric: scenario === 'latency' ? 'response_headers_ms' : 'first_stream_chunk_ms',
        selected: Object.fromEntries([['p50', 0.5], ['p90', 0.9], ['p99', 0.99], ['max', 1]].map(([name, percentile]) => {
          const sortedIndex = sorted.length === 0 ? null : Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
          const sample = sortedIndex === null ? null : sorted[sortedIndex];
          return [name, { sortedIndex, sampleIndex: sample?.index ?? null, metricMs: sample?.metricMs ?? null,
            reportedMs: sample ? Number(sample.metricMs.toFixed(2)) : 0 }];
        })),
      };
    }
  }
  return selections;
}

function writeRequestSamples() {
  if (!requestSampleJournal || requestSampleWriteAttempted) return;
  requestSampleWriteAttempted = true;
  try {
    requestSampleJournal.completeness = requestSampleCompleteness(requestSampleJournal.samples);
    requestSampleJournal.selections = requestSampleSelections(requestSampleJournal.samples);
    requestSampleJournal.clockNotes = {
      metric: 'Existing performance.now duration; original timing boundaries and success inclusion rules',
      startedAt: 'Client wall clock before the original metric start',
      recordedAt: 'Client wall clock after existing body drain or stream cancellation; not wire completion',
      observation: 'Enabled diagnostics add work around the original measurements; this is not an unobserved equivalence or production performance proof',
    };
    if (!requestSampleJournal.completeness.complete) requestSampleFailure('sample_completeness');
    if (!requestSampleJournal.completeness.correlationComplete) requestSampleFailure('request_id_validation');
    writeFileSync(requestSamplesOut, `${JSON.stringify(requestSampleJournal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    requestSampleFailure('client_sample_write');
    console.error(JSON.stringify({ observationOk: false, stage: 'client_sample_write', sqlState: null }));
  }
}

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

async function gatewayRequest(stream, url = nextGatewayUrl(), sample = null) {
  if (sample) sample.gatewayIndex = env.gatewayUrls.indexOf(url);
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

function loadStatusCounts(statuses, explicitTransportErrors) {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null;
  let total = 0;
  let unexpected5xx = 0;
  for (const [status, count] of Object.entries(statuses)) {
    if (status !== 'transport-error' && !/^[1-5]\d\d$/.test(status)) return null;
    if (!Number.isSafeInteger(count) || count < 0) return null;
    total += count;
    if (!Number.isSafeInteger(total)) return null;
    if (Number(status) >= 500) unexpected5xx += count;
  }
  const bucketTransportErrors = Object.hasOwn(statuses, 'transport-error') ? statuses['transport-error'] : 0;
  const transportErrors = explicitTransportErrors === undefined ? bucketTransportErrors : explicitTransportErrors;
  if (!Number.isSafeInteger(transportErrors) || transportErrors < 0) return null;
  if (Object.hasOwn(statuses, 'transport-error') && transportErrors !== bucketTransportErrors) return null;
  return { successfulRequests: Object.hasOwn(statuses, '200') ? statuses['200'] : 0, transportErrors, unexpected5xx };
}

function loadCountsWithinBudget(counts, budget) {
  return Boolean(counts) && Number.isSafeInteger(budget.maxTransportErrors) && budget.maxTransportErrors >= 0 &&
    Number.isSafeInteger(budget.maxUnexpected5xx) && budget.maxUnexpected5xx >= 0 &&
    counts.transportErrors <= budget.maxTransportErrors && counts.unexpected5xx <= budget.maxUnexpected5xx;
}

function applyLoadErrorBudgets(scenario, counts) {
  if (!counts) {
    violation(scenario, 'valid load counters', 0, 1);
    return;
  }
  if (counts.transportErrors > config.maxTransportErrors) {
    violation(scenario, 'transport errors', counts.transportErrors, config.maxTransportErrors);
  }
  if (counts.unexpected5xx > config.maxUnexpected5xx) {
    violation(scenario, 'unexpected 5xx', counts.unexpected5xx, config.maxUnexpected5xx);
  }
}

function scalingReportFailure(candidate, budget) {
  if (!candidate || typeof candidate !== 'object' || candidate.tool !== 'bench-gateway' || Object.hasOwn(candidate, 'fatalError') ||
      !Array.isArray(candidate.violations) || candidate.violations.length !== 0) return 'report_failed';
  const scaling = candidate.scenarios?.scaling;
  if (!scaling || typeof scaling !== 'object' || Array.isArray(scaling)) return 'missing_scaling';
  if (Object.hasOwn(scaling, 'invalidComparisonReason')) return 'report_failed';
  const counts = loadStatusCounts(scaling.statuses);
  if (!counts || !Number.isSafeInteger(scaling.latency?.n) || scaling.latency.n <= 0 ||
      scaling.latency.n !== counts.successfulRequests) return 'invalid_scaling_counts';
  if (!Number.isFinite(scaling.throughputRps) || scaling.throughputRps <= 0 ||
      !Number.isFinite(scaling.seconds) || scaling.seconds <= 0 ||
      !Number.isSafeInteger(scaling.instanceCount) || scaling.instanceCount <= 0 ||
      !Number.isSafeInteger(scaling.inflight) || scaling.inflight <= 0) return 'invalid_scaling_measurement';
  if (!loadCountsWithinBudget(counts, budget)) return 'load_error_budget';
  return null;
}

function rejectScalingComparison(result, reason) {
  result.ratio = null;
  result.invalidComparisonReason = reason;
  violation('scaling', 'valid scaling comparison', 0, 1);
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
  await closedLoop(config.warmupInflight, 3_000, async () => {
    const { response } = await gatewayRequest(false);
    await response.text();
  });

  const direct = [];
  if (hasBaseline) {
    for (let i = 0; i < config.requests; i += 1) {
      const sample = requestSampleContext('latency', 'direct', i);
      let response, elapsedMs;
      try {
        ({ response, elapsedMs } = await mockRequest(false));
        await response.text();
        if (response.status === 200) direct.push(elapsedMs);
        if (sample) recordRequestSample(sample, response, elapsedMs, response.status === 200, response.status === 200 ? 'ok' : 'http_error');
      } catch (error) {
        if (sample) recordRequestSample(sample, response, elapsedMs ?? null, false,
          elapsedMs === undefined ? requestSampleOutcome(error, response, null) : 'body_drain_error');
        throw error;
      }
    }
  }
  const through = [];
  for (let i = 0; i < config.requests; i += 1) {
    const sample = requestSampleContext('latency', 'gateway', i);
    let response, elapsedMs;
    try {
      ({ response, elapsedMs } = await gatewayRequest(false, undefined, sample));
      await response.text();
      if (response.status === 200) through.push(elapsedMs);
      if (sample) recordRequestSample(sample, response, elapsedMs, response.status === 200, response.status === 200 ? 'ok' : 'http_error');
    } catch (error) {
      if (sample) recordRequestSample(sample, response, elapsedMs ?? null, false,
        elapsedMs === undefined ? requestSampleOutcome(error, response, null) : 'body_drain_error');
      throw error;
    }
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
async function measureTtfb(requestFn, sample = null) {
  const t0 = performance.now();
  let response, ttfb = null;
  try {
    ({ response } = await requestFn());
    if (response.status !== 200) {
      await response.text();
      throw new Error(`status ${response.status}`);
    }
    const reader = response.body.getReader();
    const { value } = await reader.read();
    ttfb = performance.now() - t0;
    await reader.cancel();
    if (!value || value.length === 0) throw new Error('empty first chunk');
    if (sample) recordRequestSample(sample, response, ttfb, true, 'ok');
    return ttfb;
  } catch (error) {
    if (sample) recordRequestSample(sample, response, ttfb, false, requestSampleOutcome(error, response, ttfb));
    throw error;
  }
}

async function scenarioTtfb() {
  console.log(`\n== ttfb: ${config.streamSamples} direct + ${config.streamSamples} gateway streaming first-byte ==`);
  if (env.mockControlUrl) {
    await control('/__control/shape', { chunks: config.sseChunks, chunkDelayMs: config.sseChunkDelayMs });
    await control('/__control/delay', { ms: 0 });
  }
  const hasBaseline = env.mockUpstreamUrl !== '';

  await closedLoop(config.warmupInflight, 3_000, async () => {
    const { response } = await gatewayRequest(true);
    await response.text();
  });

  const direct = [];
  if (hasBaseline) {
    for (let i = 0; i < config.streamSamples; i += 1) {
      try {
        const sample = requestSampleContext('ttfb', 'direct', i);
        direct.push(await measureTtfb(() => mockRequest(true), sample));
      } catch {
        // counted as failures below via missing samples
      }
    }
  }
  const through = [];
  let gatewayErrors = 0;
  for (let i = 0; i < config.streamSamples; i += 1) {
    try {
      const sample = requestSampleContext('ttfb', 'gateway', i);
      through.push(await measureTtfb(() => gatewayRequest(true, undefined, sample), sample));
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
  const acceptedCompletionLatencies = [];
  let transportErrors = 0;
  const errors = {};
  const t0 = performance.now();
  const rrCounter = { i: 0 };
  await closedLoop(config.inflight, config.concurrencySeconds * 1000, async () => {
    const idx = rrCounter.i++ % env.gatewayUrls.length;
    perUrl[idx].requests += 1;
    const url = env.gatewayUrls[idx];
    const requestStarted = performance.now();
    try {
      const { response, elapsedMs } = await gatewayRequest(false, url);
      await response.text();
      statusBump(statuses, response.status);
      if (response.status === 200) {
        latencies.push(elapsedMs);
        acceptedCompletionLatencies.push(performance.now() - requestStarted);
      }
    } catch (error) {
      transportErrors += 1;
      const key = String(error.cause?.code ?? error.name).slice(0, 40);
      errors[key] = (errors[key] ?? 0) + 1;
    }
  });
  const durationS = (performance.now() - t0) / 1000;
  const loadCounts = loadStatusCounts(statuses, transportErrors);
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
    acceptedLatency: { measurement: 'request-start-through-response-body', ...latencySummary(acceptedCompletionLatencies) },
    successfulRequests: loadCounts.successfulRequests,
    successfulRps: Number(rps.toFixed(2)),
    rejected429: statuses['429'] ?? 0,
    rejected429Ratio: (statuses['429'] ?? 0) / Math.max(1, Object.values(statuses).reduce((sum, count) => sum + count, 0) + transportErrors),
    successfulSampleSufficiency: { minimum: 100, observed: latencies.length, sufficient: latencies.length >= 100 },
    throughputRps: Number(rps.toFixed(2)),
  };
  applyLoadErrorBudgets('concurrency', loadCounts);
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
  report.scenarios.scaling = result;
  const loadCounts = loadStatusCounts(statuses);
  applyLoadErrorBudgets('scaling', loadCounts);
  if (!loadCounts || loadCounts.successfulRequests === 0 || !Number.isFinite(rps) || rps <= 0) {
    violation('scaling', 'valid scaling samples', 0, 1);
  }

  if (config.baselineReport) {
    let baseline;
    let baselineFailure;
    try {
      baseline = JSON.parse(readFileSync(config.baselineReport, 'utf8'));
      baselineFailure = scalingReportFailure(baseline, config);
    } catch {
      baselineFailure = 'unreadable_report';
    }
    const currentFailure = scalingReportFailure(report, config);
    if (baselineFailure || currentFailure) {
      rejectScalingComparison(result, baselineFailure ? `baseline_${baselineFailure}` : `current_${currentFailure}`);
    } else {
      const base = baseline.scenarios.scaling;
      const ratio = Number((rps / base.throughputRps).toFixed(3));
      if (!Number.isFinite(ratio)) {
        rejectScalingComparison(result, 'non_finite_ratio');
      } else {
        result.baseline = { file: config.baselineReport, instanceCount: base.instanceCount, throughputRps: base.throughputRps };
        result.ratio = ratio;
        console.log(`  scaling ratio: ${base.instanceCount} -> ${env.gatewayUrls.length} instances = ${ratio}x (min ${config.scalingMinRatio}x)`);
        if (env.gatewayUrls.length <= base.instanceCount) {
          console.error('warning: current run has no more instances than the baseline; ratio check skipped.');
        } else if (ratio < config.scalingMinRatio) {
          violation('scaling', 'throughput ratio', ratio, config.scalingMinRatio, 'x');
        }
      }
    }
  } else {
    console.log('  (pass --baseline-report on the N-instance run to compute the 1→N ratio)');
  }
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
  writeRequestSamples();
}
writeReport();
violationsExit();
