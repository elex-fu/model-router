#!/usr/bin/env node
// chaos-gateway.mjs — R9 chaos driver for the managed-SaaS gateway compose
// stack (plan §R9, docs/token-resale-implementation-plan-2026-10-15.md).
//
// Unlike bench-gateway.mjs this driver DOES execute docker/compose commands
// (kill/stop/start/ps/stats/exec) against the running stack. Everything is
// deterministic and re-runnable: every scenario resets the mock's fault/shape
// state before it starts and targets compose services by name.
//
// Scenarios:
//   account-faults  Inject 401/429/403 (immediate) and mid-stream aborts on
//                   selected provider accounts via the mock control plane;
//                   verify failover to healthy accounts, health classification
//                   (faulted accounts stop receiving traffic), and zero leaked
//                   upstream connections (mock currentInFlight drains to 0).
//   kill-instance   docker kill one gateway replica while long streams are in
//                   flight: in-flight breakage is counted and recorded (not a
//                   failure); NEW requests against the surviving instances
//                   must be zero-failure; no leaked upstream connections.
//   kill-postgres   docker stop postgres for N seconds: every gateway response
//                   during the outage must be a bounded-latency fail-closed
//                   HTTP error (no 200s, no hangs, no socket resets); after
//                   restart, requests must recover to 200.
//   token-expiry    Explicitly opt-in (NOT part of --scenario all): rotate the
//                   upstream bearer mid-traffic and verify the refresh path
//                   recovers without an invalid_grant storm. Requires the
//                   operator runtime module to implement OAuth refresh against
//                   the mock's /oauth/token — see BENCH.md prerequisites.
//   soak            24h profile: closed-loop background traffic with periodic
//                   per-container RSS (docker stats), gateway fd counts
//                   (docker exec /proc), and PostgreSQL WAL/connection/size
//                   sampling; reports trends and flags RSS/fd growth.
//   all             account-faults + kill-instance + kill-postgres.
//
// Usage (Docker host required; see deploy/compose/BENCH.md for the full
// operator sequence):
//   GATEWAY_URLS=... BENCH_PROXY_KEY=... MOCK_CONTROL_URL=... \
//   BENCH_FAULT_ACCOUNTS=token-a,token-b \
//     node scripts/ops/chaos-gateway.mjs --scenario all
//
//   node scripts/ops/chaos-gateway.mjs --dry-run --scenario all
//     Self-check: validates arguments/config and prints the execution plan
//     (including the exact docker commands) without running anything.
//
// Exit codes: 0 pass (or dry-run), 1 threshold violation, 2 bad arguments or
// missing required runtime config, 3 docker/target unavailable.
//
// No secrets in this file: the proxy key is read from BENCH_PROXY_KEY env.

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPOSE_DIR = path.resolve(scriptDir, '../../deploy/compose');

const SCENARIOS = ['account-faults', 'kill-instance', 'kill-postgres', 'token-expiry', 'soak'];
// 'all' deliberately excludes token-expiry (module prerequisite) and soak (24h).
const ALL_SCENARIOS = ['account-faults', 'kill-instance', 'kill-postgres'];

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
const scenarios =
  scenarioArg === 'all' ? [...ALL_SCENARIOS] : scenarioArg.split(',').map((s) => s.trim());
for (const s of scenarios) {
  if (!SCENARIOS.includes(s)) argError(`unknown scenario ${JSON.stringify(s)} (valid: all, ${SCENARIOS.join(', ')})`);
}

const config = {
  composeDir: String(argValue('compose-dir', process.env.COMPOSE_DIR ?? DEFAULT_COMPOSE_DIR)),
  composeFiles: String(argValue('compose-files', process.env.COMPOSE_FILES ?? 'docker-compose.yml,bench-compose.override.yml')),
  faultAccounts: String(argValue('fault-accounts', process.env.BENCH_FAULT_ACCOUNTS ?? '')),
  faultConcurrency: intArg('fault-concurrency', 16, { min: 1, max: 10_000 }),
  faultSeconds: intArg('fault-seconds', 120, { min: 30, max: 24 * 60 * 60 }),
  faultWarmupSeconds: intArg('fault-warmup-seconds', 15, { min: 1, max: 600 }),
  faultModeSeconds: intArg('fault-mode-seconds', 20, { min: 5, max: 600 }),
  faultCooldownSeconds: intArg('fault-cooldown-seconds', 30, { min: 1, max: 3600 }),
  faultModes: String(argValue('fault-modes', '401,429,403,midstream')),
  faultMinSuccessRate: Number(argValue('fault-min-success-rate', '0.9')),
  classificationMaxRequestsDuringFault: intArg('classification-max-requests-during-fault', 5, { min: 0, max: 100_000 }),
  killInflight: intArg('kill-inflight', 40, { min: 1, max: 10_000 }),
  killChunks: intArg('kill-chunks', 200, { min: 2, max: 100_000 }),
  killChunkDelayMs: intArg('kill-chunk-delay-ms', 100, { min: 0, max: 60_000 }),
  killPostRequests: intArg('kill-post-requests', 200, { min: 1, max: 1_000_000 }),
  drainSeconds: intArg('drain-seconds', 30, { min: 1, max: 3600 }),
  pgDownSeconds: intArg('pg-down-seconds', 30, { min: 5, max: 3600 }),
  pgProbeIntervalMs: intArg('pg-probe-interval-ms', 500, { min: 100, max: 60_000 }),
  pgMaxFailMs: intArg('pg-max-fail-ms', 5000, { min: 100, max: 3_600_000 }),
  pgRecoveryTimeoutSeconds: intArg('pg-recovery-timeout-seconds', 120, { min: 5, max: 3600 }),
  pgRecoveryProbes: intArg('pg-recovery-probes', 60, { min: 1, max: 10_000 }),
  tokenConcurrency: intArg('token-concurrency', 8, { min: 1, max: 10_000 }),
  tokenSeconds: intArg('token-seconds', 120, { min: 30, max: 24 * 60 * 60 }),
  tokenWarmupSeconds: intArg('token-warmup-seconds', 10, { min: 1, max: 600 }),
  tokenRecoverySeconds: intArg('token-recovery-seconds', 30, { min: 1, max: 3600 }),
  tokenMaxRefreshBurst: intArg('token-max-refresh-burst', 3, { min: 1, max: 100_000 }),
  soakHours: intArg('soak-hours', 24, { min: 1, max: 24 * 7 }),
  soakSampleSeconds: intArg('sample-seconds', 60, { min: 10, max: 3600 }),
  soakConcurrency: intArg('soak-concurrency', 8, { min: 1, max: 10_000 }),
  soakRssGrowthPct: intArg('soak-rss-growth-pct', 50, { min: 1, max: 10_000 }),
  soakFdGrowth: intArg('soak-fd-growth', 100, { min: 1, max: 1_000_000 }),
  requestTimeoutMs: intArg('timeout-ms', 60_000, { min: 1000, max: 3_600_000 }),
  out: String(argValue('out', '')),
  noFail: hasFlag('no-fail'),
};
for (const [name, value] of [
  ['fault-min-success-rate', config.faultMinSuccessRate],
]) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) argError(`--${name} must be in (0, 1]`);
}
if (scenarios.includes('account-faults') && config.faultAccounts === '') {
  const msg =
    '--fault-accounts (or BENCH_FAULT_ACCOUNTS, comma-separated provider-account bearer tokens the gateway presents upstream) is required for account-faults.';
  if (dryRun) console.error(`warning: ${msg}`);
  else argError(msg);
}
const faultModeList = config.faultModes
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const mode of faultModeList) {
  if (mode !== 'midstream' && ![401, 403, 429].includes(Number(mode))) {
    argError(`invalid fault mode ${JSON.stringify(mode)} in --fault-modes (valid: 401, 429, 403, midstream)`);
  }
}
for (const f of config.composeFiles.split(',').map((s) => s.trim()).filter(Boolean)) {
  const file = path.resolve(config.composeDir, f);
  if (!existsSync(file)) {
    const msg = `compose file not found: ${file}`;
    if (dryRun) console.error(`warning: ${msg}`);
    else argError(msg);
  }
}

// ── Runtime environment ───────────────────────────────────────────────────────
const env = {
  gatewayUrls: (process.env.GATEWAY_URLS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  proxyKey: process.env.BENCH_PROXY_KEY ?? '',
  mockControlUrl: (process.env.MOCK_CONTROL_URL ?? '').replace(/\/+$/, ''),
};

const configProblems = [];
if (env.gatewayUrls.length === 0) configProblems.push('GATEWAY_URLS is not set');
if (!env.proxyKey) configProblems.push('BENCH_PROXY_KEY is not set');
if (!env.mockControlUrl) configProblems.push('MOCK_CONTROL_URL is not set (fault injection + drain checks need the mock control plane)');

const faultAccountList = config.faultAccounts
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Docker / compose helpers ──────────────────────────────────────────────────
const composeFileArgs = config.composeFiles
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .flatMap((f) => ['-f', f]);

async function docker(args, { check = true } = {}) {
  const { stdout, stderr } = await execFileAsync('docker', args, {
    cwd: config.composeDir,
    timeout: 120_000,
  }).catch((error) => {
    if (!check) throw error;
    console.error(`error: docker ${args.join(' ')} failed: ${String(error.message).slice(0, 300)}`);
    process.exit(3);
  });
  return { stdout, stderr };
}

function compose(serviceArgs) {
  return docker(['compose', ...composeFileArgs, ...serviceArgs]);
}

async function checkDockerHost() {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 10_000 });
  } catch {
    console.error('error: docker CLI not found. The chaos scenarios require a Docker host (deploy/compose/BENCH.md).');
    process.exit(3);
  }
  try {
    await execFileAsync('docker', ['info'], { timeout: 15_000 });
  } catch {
    console.error('error: docker daemon unreachable. Start the compose stack first (deploy/compose/BENCH.md).');
    process.exit(3);
  }
}

/** `docker compose ps --format json [service]` -> [{name, id, state, ...}] (v2 emits an array; older emits line-delimited JSON). */
async function listComposeContainers(service) {
  const serviceArgs = service ? ['ps', '--format', 'json', service] : ['ps', '--format', 'json', '-a'];
  const { stdout } = await compose(serviceArgs);
  const text = stdout.trim();
  if (text === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((c) => c?.Name || c?.ID);
}

async function listGatewayContainers() {
  const containers = await listComposeContainers('gateway');
  return containers;
}

// ── Report plumbing ───────────────────────────────────────────────────────────
const report = {
  tool: 'chaos-gateway',
  startedAt: new Date().toISOString(),
  config: { ...config, faultAccounts: faultAccountList.length, gatewayUrls: env.gatewayUrls, scenarioList: scenarios },
  scenarios: {},
  violations: [],
  dockerHostRequired: true,
};

function violation(scenario, metric, value, threshold, unit = '') {
  report.violations.push({ scenario, metric, value, threshold, unit });
  console.error(`VIOLATION [${scenario}] ${metric}: ${value}${unit} (threshold ${threshold}${unit})`);
}

function finish(exitCodeOverride) {
  report.finishedAt = new Date().toISOString();
  const out =
    config.out ||
    path.join(process.cwd(), `chaos-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written: ${out}`);
  console.log(`${report.violations.length} violation(s).`);
  process.exit(config.noFail || exitCodeOverride === 0 ? 0 : 1);
}

// ── HTTP helpers (shared shape with bench-gateway.mjs) ───────────────────────
let rrIndex = 0;
function nextGatewayUrl() {
  const url = env.gatewayUrls[rrIndex % env.gatewayUrls.length];
  rrIndex += 1;
  return url;
}

async function gatewayRequest(stream, url = nextGatewayUrl()) {
  return fetch(`${url}/v1/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${env.proxyKey}`,
    },
    body: JSON.stringify({
      model: 'bench-model',
      max_tokens: 64,
      stream,
      messages: [{ role: 'user', content: 'chaos' }],
    }),
  });
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closedLoop(concurrency, durationMs, worker) {
  const deadline = performance.now() + durationMs;
  let index = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const i = index++;
        try {
          await worker(i);
        } catch {
          // workers record their own outcomes
        }
      }
    }),
  );
}

async function preflight() {
  const failures = [];
  await Promise.all(
    env.gatewayUrls.map(async (url) => {
      try {
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
  try {
    await mockStats();
  } catch (error) {
    console.error(`error: mock control plane unreachable at ${env.mockControlUrl}: ${error.message}`);
    process.exit(3);
  }
}

/** Current per-account {requests, currentInFlight} snapshot for the tracked accounts. */
async function accountSnapshot() {
  const stats = await mockStats();
  const snapshot = {};
  for (const account of faultAccountList) {
    const rec = stats.accounts[account];
    snapshot[account] = rec
      ? { requests: rec.requests, currentInFlight: rec.currentInFlight, maxInFlight: rec.maxInFlight }
      : { requests: 0, currentInFlight: 0, maxInFlight: 0, neverSeen: true };
  }
  return snapshot;
}

// ── Scenario: account-faults ──────────────────────────────────────────────────
async function scenarioAccountFaults() {
  console.log(
    `\n== account-faults: faulting ${faultAccountList.length} account(s) with ${config.faultModes} while c=${config.faultConcurrency} traffic runs ==`,
  );
  await control('/__control/reset', {});
  await control('/__control/shape', { chunks: 16, chunkDelayMs: 0 });
  await control('/__control/delay', { ms: 0 });

  const traffic = {
    total: 0,
    ok: 0,
    failed: 0,
    statuses: {},
  };
  const trafficPromise = closedLoop(config.faultConcurrency, config.faultSeconds * 1000, async () => {
    const stream = traffic.total % 2 === 1; // mixed stream / non-stream
    traffic.total += 1;
    try {
      const response = await gatewayRequest(stream);
      await response.text();
      const key = String(response.status);
      traffic.statuses[key] = (traffic.statuses[key] ?? 0) + 1;
      if (response.status === 200) traffic.ok += 1;
      else traffic.failed += 1;
    } catch {
      traffic.failed += 1;
      traffic.statuses.transport = (traffic.statuses.transport ?? 0) + 1;
    }
  });

  await sleep(config.faultWarmupSeconds * 1000);
  const warmupSnapshot = await accountSnapshot();
  const warmupTraffic = { ...traffic };

  const phaseResults = [];
  for (const mode of faultModeList) {
    const fault =
      mode === 'midstream'
        ? { accounts: faultAccountList, mode: 'abort-after', afterChunks: 4, durationMs: config.faultModeSeconds * 1000 }
        : { accounts: faultAccountList, mode: 'status', status: Number(mode), durationMs: config.faultModeSeconds * 1000 };
    console.log(`  injecting ${mode} on ${faultAccountList.length} account(s) for ${config.faultModeSeconds}s ...`);
    await control('/__control/faults', fault);
    const before = await accountSnapshot();
    await sleep(config.faultModeSeconds * 1000);
    await control('/__control/faults', { accounts: faultAccountList, mode: 'none' });
    const after = await accountSnapshot();
    const requestsDuringFault = {};
    for (const account of faultAccountList) {
      requestsDuringFault[account] = after[account].requests - before[account].requests;
    }
    const maxRequests = Math.max(0, ...Object.values(requestsDuringFault));
    console.log(`    requests to faulted accounts during window: ${JSON.stringify(requestsDuringFault)}`);
    phaseResults.push({ mode, requestsDuringFault, maxRequestsDuringFault: maxRequests });
    if (maxRequests > config.classificationMaxRequestsDuringFault) {
      violation(
        'account-faults',
        `requests to faulted account during ${mode} window`,
        maxRequests,
        config.classificationMaxRequestsDuringFault,
      );
    }
  }

  await trafficPromise;
  const successRate = traffic.total > 0 ? traffic.ok / traffic.total : 0;
  console.log(
    `  traffic totals: ok=${traffic.ok} failed=${traffic.failed} statuses=${JSON.stringify(traffic.statuses)}`,
  );
  console.log(
    `  post-warmup success rate: ${(traffic.ok - warmupTraffic.ok) / Math.max(1, traffic.total - warmupTraffic.total)}`,
  );

  // Drain: no leaked upstream connections.
  console.log(`  waiting ${config.faultCooldownSeconds}s for cooldown + drain ...`);
  await sleep(config.faultCooldownSeconds * 1000);
  const drained = await accountSnapshot();
  const leaked = Object.entries(drained).filter(([, rec]) => rec.currentInFlight > 0);
  console.log(`  post-drain in-flight: ${JSON.stringify(Object.fromEntries(Object.entries(drained).map(([a, r]) => [a.slice(0, 12), r.currentInFlight])))}`);
  if (leaked.length > 0) {
    violation('account-faults', 'accounts with leaked in-flight upstream connections', leaked.length, 0);
  }

  const postWarmupSuccess =
    (traffic.ok - warmupTraffic.ok) / Math.max(1, traffic.total - warmupTraffic.total);
  if (postWarmupSuccess < config.faultMinSuccessRate) {
    violation('account-faults', 'post-warmup success rate', Number(postWarmupSuccess.toFixed(4)), config.faultMinSuccessRate);
  }
  report.scenarios['account-faults'] = {
    warmupSnapshot,
    phases: phaseResults,
    traffic: { total: traffic.total, ok: traffic.ok, failed: traffic.failed, statuses: traffic.statuses },
    postWarmupSuccessRate: Number(postWarmupSuccess.toFixed(4)),
    drained: Object.fromEntries(Object.entries(drained).map(([a, r]) => [a, { currentInFlight: r.currentInFlight }])),
  };
  await control('/__control/faults', { mode: 'none' });
}

// ── Scenario: kill-instance ───────────────────────────────────────────────────
async function scenarioKillInstance() {
  console.log(`\n== kill-instance: docker kill one gateway replica with ${config.killInflight} streams in flight ==`);
  const containers = await listGatewayContainers();
  const running = containers.filter((c) => (c.State ?? '').toLowerCase() === 'running' || !c.State);
  if (running.length < 2) {
    console.error(
      `error: kill-instance needs >= 2 running gateway replicas (found ${running.length}). Scale first: docker compose up -d --scale gateway=3`,
    );
    process.exit(3);
  }
  const victim = running[0];
  console.log(`  victim container: ${victim.Name ?? victim.ID}`);

  await control('/__control/reset', {});
  await control('/__control/shape', { chunks: config.killChunks, chunkDelayMs: config.killChunkDelayMs });

  // Long streams in flight across all gateway URLs (one parallel batch).
  const outcomes = { completed: 0, broken: 0 };
  const batch = Array.from({ length: config.killInflight }, async () => {
    try {
      const response = await gatewayRequest(true);
      if (response.status !== 200) {
        outcomes.broken += 1;
        await response.text();
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      outcomes.completed += 1;
    } catch {
      outcomes.broken += 1;
    }
  });
  await sleep(2_000); // let the streams establish
  await docker(['kill', String(victim.Name ?? victim.ID)]);
  console.log(`  killed ${victim.Name ?? victim.ID}; awaiting in-flight outcomes ...`);
  await Promise.all(batch);

  // Surviving URLs: probe and keep the reachable ones.
  const reachable = [];
  for (const url of env.gatewayUrls) {
    try {
      const r = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5_000) });
      if (r.status < 500) reachable.push(url);
    } catch {
      console.log(`  note: ${url} unreachable after kill (expected if it was the victim's published port)`);
    }
  }
  if (reachable.length === 0) {
    violation('kill-instance', 'surviving reachable gateway URLs', 0, 1);
  }

  let postFailures = 0;
  const postStatuses = {};
  for (let i = 0; i < config.killPostRequests; i += 1) {
    const url = reachable[i % reachable.length];
    try {
      const response = await gatewayRequest(false, url);
      await response.text();
      const key = String(response.status);
      postStatuses[key] = (postStatuses[key] ?? 0) + 1;
      if (response.status !== 200) postFailures += 1;
    } catch {
      postFailures += 1;
      postStatuses.transport = (postStatuses.transport ?? 0) + 1;
    }
  }
  console.log(
    `  in-flight: ${outcomes.completed} completed / ${outcomes.broken} broken (breakage recorded, not a failure)`,
  );
  console.log(`  new requests on survivors: ${config.killPostRequests - postFailures}/${config.killPostRequests} ok, statuses=${JSON.stringify(postStatuses)}`);
  if (postFailures > 0) {
    violation('kill-instance', 'new-request failures after kill', postFailures, 0);
  }

  // Drain check: the killed instance's upstream connections must be gone.
  await sleep(config.drainSeconds * 1000);
  const stats = await mockStats();
  const leaked = Object.entries(stats.accounts).filter(([, rec]) => rec.currentInFlight > 0);
  if (leaked.length > 0) {
    violation('kill-instance', 'accounts with leaked in-flight upstream connections', leaked.length, 0);
  }
  console.log(`  post-drain leaked accounts: ${leaked.length}`);

  report.scenarios['kill-instance'] = {
    victim: victim.Name ?? victim.ID,
    inFlight: { ...outcomes },
    postKill: { requests: config.killPostRequests, failures: postFailures, statuses: postStatuses },
    reachableUrlsAfterKill: reachable,
    leakedAccounts: leaked.length,
  };
  // Restore the shape for any following scenario.
  await control('/__control/shape', { chunks: 16, chunkDelayMs: 0 });
}

// ── Scenario: kill-postgres ───────────────────────────────────────────────────
async function scenarioKillPostgres() {
  console.log(`\n== kill-postgres: docker stop postgres for ${config.pgDownSeconds}s (fail-closed verification) ==`);
  // Baseline: the gateway must be serving before the outage.
  const baseline = await gatewayRequest(false);
  await baseline.text();
  if (baseline.status !== 200) {
    console.error(`error: baseline request returned ${baseline.status}; gateway must be healthy before the outage.`);
    process.exit(3);
  }

  await compose(['stop', 'postgres']);
  const outageStarted = performance.now();
  const probes = [];
  let violationsBefore = report.violations.length;
  while (performance.now() - outageStarted < config.pgDownSeconds * 1000) {
    const t0 = performance.now();
    try {
      const response = await gatewayRequest(false);
      const elapsed = performance.now() - t0;
      await response.text();
      probes.push({ status: response.status, ms: Number(elapsed.toFixed(1)) });
      if (response.status === 200) {
        violation('kill-postgres', '200 served during PG outage', 1, 0);
      }
      if (elapsed > config.pgMaxFailMs) {
        violation('kill-postgres', 'fail-closed latency exceeded', Number(elapsed.toFixed(1)), config.pgMaxFailMs, 'ms');
      }
    } catch (error) {
      probes.push({ status: `transport:${String(error.cause?.code ?? error.name).slice(0, 30)}`, ms: 0 });
      violation('kill-postgres', 'transport error during PG outage (expected a clean fail-closed HTTP error)', 1, 0);
    }
    await sleep(config.pgProbeIntervalMs);
  }

  await compose(['start', 'postgres']);
  console.log(`  postgres restarted; waiting for readiness (timeout ${config.pgRecoveryTimeoutSeconds}s) ...`);
  const recoveryDeadline = performance.now() + config.pgRecoveryTimeoutSeconds * 1000;
  for (;;) {
    const ready = await execFileAsync(
      'docker',
      ['compose', ...composeFileArgs, 'exec', '-T', 'postgres', 'pg_isready', '-U', process.env.POSTGRES_USER ?? 'postgres'],
      { cwd: config.composeDir, timeout: 15_000 },
    )
      .then(() => true)
      .catch(() => false);
    if (ready || performance.now() > recoveryDeadline) break;
    await sleep(2_000);
  }

  let recovered = false;
  const recoveryStatuses = {};
  for (let i = 0; i < config.pgRecoveryProbes; i += 1) {
    try {
      const response = await gatewayRequest(false);
      await response.text();
      const key = String(response.status);
      recoveryStatuses[key] = (recoveryStatuses[key] ?? 0) + 1;
      if (response.status === 200) {
        recovered = true;
        break;
      }
    } catch {
      recoveryStatuses.transport = (recoveryStatuses.transport ?? 0) + 1;
    }
    await sleep(1_000);
  }

  const statusCounts = probes.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  outage probes: ${JSON.stringify(statusCounts)}`);
  console.log(`  recovery: ${recovered ? 'ok' : 'NOT RECOVERED'} statuses=${JSON.stringify(recoveryStatuses)}`);
  if (!recovered) {
    violation('kill-postgres', 'gateway did not recover to 200 after PG restart', 0, 1);
  }
  report.scenarios['kill-postgres'] = {
    pgDownSeconds: config.pgDownSeconds,
    outageProbeCount: probes.length,
    outageStatusCounts: statusCounts,
    outageViolations: report.violations.length - violationsBefore,
    recovered,
    recoveryStatuses,
  };
}

// ── Scenario: token-expiry (explicit opt-in) ──────────────────────────────────
async function scenarioTokenExpiry() {
  console.log(`\n== token-expiry: rotate the upstream bearer mid-traffic (prerequisite-gated) ==`);
  console.log('  PREREQUISITE: the operator gateway-runtime module must implement OAuth');
  console.log('  client-credentials refresh against the mock /oauth/token endpoint, and the');
  console.log('  bench account must be an oauth-mode account. See deploy/compose/BENCH.md.');
  await control('/__control/reset', {});

  const traffic = { total: 0, ok: 0, statuses: {} };
  const trafficPromise = closedLoop(config.tokenConcurrency, config.tokenSeconds * 1000, async () => {
    traffic.total += 1;
    try {
      const response = await gatewayRequest(false);
      await response.text();
      const key = String(response.status);
      traffic.statuses[key] = (traffic.statuses[key] ?? 0) + 1;
      if (response.status === 200) traffic.ok += 1;
    } catch {
      traffic.statuses.transport = (traffic.statuses.transport ?? 0) + 1;
    }
  });

  await sleep(config.tokenWarmupSeconds * 1000);
  const warmupOk = traffic.ok;
  const warmupTotal = traffic.total;
  if (warmupTotal === 0 || warmupOk / warmupTotal < 0.5) {
    await control('/__control/faults', { mode: 'none' });
    console.error(
      'error: token-expiry prerequisite not met — traffic is not succeeding against the mock before rotation.',
    );
    process.exit(2);
  }

  const before = await mockStats();
  const refreshesBefore = before.tokenEndpoint.requests;
  console.log('  rotating the mock bearer token ...');
  await control('/__control/rotate-token', {});

  // Watch the recovery window.
  const windowStart = performance.now();
  let notOkDuringRecovery = 0;
  let totalDuringRecovery = 0;
  let refreshBurst = 0;
  const sampler = setInterval(async () => {
    try {
      const stats = await mockStats();
      refreshBurst = Math.max(refreshBurst, stats.tokenEndpoint.requests - refreshesBefore);
    } catch {
      // mock control blip; next sample retries
    }
  }, 1_000);
  const watchPromise = (async () => {
    while (performance.now() - windowStart < config.tokenRecoverySeconds * 1000) {
      try {
        const response = await gatewayRequest(false);
        await response.text();
        totalDuringRecovery += 1;
        if (response.status !== 200) notOkDuringRecovery += 1;
      } catch {
        totalDuringRecovery += 1;
        notOkDuringRecovery += 1;
      }
      await sleep(200);
    }
  })();
  await watchPromise;
  clearInterval(sampler);

  const after = await mockStats();
  const refreshes = after.tokenEndpoint.requests - refreshesBefore;
  await trafficPromise;
  const finalSuccessRate = traffic.total > 0 ? traffic.ok / traffic.total : 0;

  console.log(`  refresh token requests after rotation: ${refreshes} (burst peak ${refreshBurst})`);
  console.log(
    `  recovery window: ${totalDuringRecovery - notOkDuringRecovery}/${totalDuringRecovery} ok`,
  );
  console.log(`  overall success rate: ${finalSuccessRate.toFixed(4)}`);

  const perInstanceBurstLimit = config.tokenMaxRefreshBurst * Math.max(1, env.gatewayUrls.length);
  if (refreshBurst > perInstanceBurstLimit) {
    violation('token-expiry', 'refresh burst (token endpoint requests after rotation)', refreshBurst, perInstanceBurstLimit);
  }
  if (totalDuringRecovery > 0 && notOkDuringRecovery / totalDuringRecovery > 0.5) {
    violation(
      'token-expiry',
      'non-200 fraction during recovery window',
      Number((notOkDuringRecovery / totalDuringRecovery).toFixed(4)),
      0.5,
    );
  }
  if (finalSuccessRate < 0.9) {
    violation('token-expiry', 'overall success rate', Number(finalSuccessRate.toFixed(4)), 0.9);
  }
  report.scenarios['token-expiry'] = {
    refreshesAfterRotation: refreshes,
    refreshBurstPeak: refreshBurst,
    recovery: { ok: totalDuringRecovery - notOkDuringRecovery, total: totalDuringRecovery },
    overall: { ...traffic },
    overallSuccessRate: Number(finalSuccessRate.toFixed(4)),
  };
}

// ── Scenario: soak ────────────────────────────────────────────────────────────
function parseMemUsage(value) {
  // "123.4MiB / 1.5GiB" -> bytes (first operand only)
  const first = String(value).split('/')[0].trim();
  const match = /^([\d.]+)(KiB|MiB|GiB|TiB|B)$/.exec(first);
  if (!match) return null;
  const units = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Math.round(Number(match[1]) * units[match[2]]);
}

async function scenarioSoak() {
  const hours = config.soakHours;
  console.log(
    `\n== soak: ${hours}h, c=${config.soakConcurrency} background traffic, sampling every ${config.soakSampleSeconds}s ==`,
  );
  const outPath =
    config.out ||
    path.join(process.cwd(), `soak-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  console.log(`  samples append to: ${outPath}`);

  const gatewayContainers = (await listGatewayContainers())
    .filter((c) => (c.State ?? 'running').toLowerCase() === 'running' || !c.State)
    .map((c) => String(c.Name ?? c.ID));
  // docker stats takes container names/IDs, not compose service names.
  const postgresContainers = (await listComposeContainers('postgres'))
    .filter((c) => (c.State ?? 'running').toLowerCase() === 'running' || !c.State)
    .map((c) => String(c.Name ?? c.ID));
  const statsTargets = [...gatewayContainers, ...postgresContainers];
  console.log(`  gateway containers: ${gatewayContainers.join(', ')}`);
  if (gatewayContainers.length === 0) {
    console.error('error: no running gateway containers found for the soak scenario.');
    process.exit(3);
  }

  let stopped = false;
  const traffic = { total: 0, ok: 0, statuses: {} };
  const trafficPromise = closedLoop(config.soakConcurrency, hours * 3600 * 1000, async () => {
    if (stopped) return;
    traffic.total += 1;
    try {
      const response = await gatewayRequest(traffic.total % 4 === 0);
      await response.text();
      const key = String(response.status);
      traffic.statuses[key] = (traffic.statuses[key] ?? 0) + 1;
      if (response.status === 200) traffic.ok += 1;
      if (response.status === 429) await sleep(1_000); // back off when slots saturate
    } catch {
      traffic.statuses.transport = (traffic.statuses.transport ?? 0) + 1;
      await sleep(1_000);
    }
  });

  const psql = async (sql) => {
    const { stdout } = await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      process.env.POSTGRES_USER ?? 'postgres',
      '-d',
      process.env.POSTGRES_DB ?? 'model_router_saas',
      '-t',
      '-A',
      '-c',
      sql,
    ]).catch(() => ({ stdout: '' }));
    return stdout.trim();
  };

  const samples = [];
  const finalize = () => {
    stopped = true;
    return samples;
  };
  process.on('SIGINT', () => {
    console.log('\nSIGINT: finalizing soak report with samples collected so far ...');
    finishSoakReport(finalize(), traffic, outPath, true);
    process.exit(0);
  });

  const deadline = performance.now() + hours * 3600 * 1000;
  let sampleIndex = 0;
  while (performance.now() < deadline && !stopped) {
    sampleIndex += 1;
    const sample = { ts: new Date().toISOString(), index: sampleIndex, containers: {}, postgres: {} };
    try {
      const { stdout } = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...statsTargets]);
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          sample.containers[entry.Name] = {
            memBytes: parseMemUsage(entry.MemUsage),
            cpuPerc: entry.CPUPerc,
            pids: Number(entry.Pids),
          };
        } catch {
          // skip unparseable line
        }
      }
    } catch {
      sample.containers.error = 'docker-stats-unavailable';
    }
    for (const container of gatewayContainers) {
      if (typeof sample.containers[container] !== 'object' || sample.containers[container] === null) {
        sample.containers[container] = {};
      }
      try {
        const { stdout } = await docker([
          'exec',
          container,
          'sh',
          '-c',
          "for d in /proc/[0-9]*; do c=$(cat $d/comm 2>/dev/null); if [ \"$c\" = node ]; then ls $d/fd 2>/dev/null | wc -l; fi; done",
        ]);
        const fds = stdout
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((n) => Number.isSafeInteger(n) && n > 0);
        sample.containers[container].nodeFdCount = fds.reduce((a, b) => a + b, 0);
      } catch {
        sample.containers[container].nodeFdCount = null;
      }
    }
    sample.postgres.walBytes = Number(await psql("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint")) || null;
    sample.postgres.connections = Number(await psql('SELECT count(*) FROM pg_stat_activity')) || null;
    sample.postgres.databaseBytes = Number(await psql('SELECT pg_database_size(current_database())')) || null;
    sample.traffic = { ...traffic };

    samples.push(sample);
    appendFileSync(outPath, `${JSON.stringify(sample)}\n`);
    const rssLine = Object.entries(sample.containers)
      .filter(([, v]) => typeof v === 'object' && v?.memBytes)
      .map(([name, v]) => `${name}=${(v.memBytes / 1024 / 1024).toFixed(0)}MB`)
      .join(' ');
    console.log(
      `  [${sample.index}] ${rssLine} wal=${(sample.postgres.walBytes / 1024 ** 2).toFixed(0)}MB conns=${sample.postgres.connections} fds=${Object.values(sample.containers)
        .map((v) => v?.nodeFdCount ?? '-')
        .join('/')} ok=${traffic.ok}`,
    );
    const remaining = deadline - performance.now();
    await sleep(Math.max(0, Math.min(config.soakSampleSeconds * 1000, remaining)));
  }
  finishSoakReport(finalize(), traffic, outPath, false);
}

function finishSoakReport(samples, traffic, outPath, interrupted) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const trends = {};
  if (first && last) {
    for (const [name, firstRec] of Object.entries(first.containers)) {
      if (typeof firstRec !== 'object' || firstRec?.memBytes == null) continue;
      const lastRec = last.containers[name];
      if (lastRec?.memBytes == null) continue;
      const growthPct = Number((((lastRec.memBytes - firstRec.memBytes) / firstRec.memBytes) * 100).toFixed(1));
      const maxBytes = Math.max(...samples.map((s) => s.containers[name]?.memBytes ?? 0));
      trends[name] = {
        firstMemBytes: firstRec.memBytes,
        lastMemBytes: lastRec.memBytes,
        maxMemBytes: maxBytes,
        rssGrowthPct: growthPct,
        firstFdCount: firstRec.nodeFdCount ?? null,
        lastFdCount: lastRec.nodeFdCount ?? null,
      };
      if (growthPct > config.soakRssGrowthPct) {
        violation('soak', `${name} RSS growth`, `${growthPct}%`, `${config.soakRssGrowthPct}%`);
      }
      const fdGrowth = (lastRec.nodeFdCount ?? 0) - (firstRec.nodeFdCount ?? 0);
      if (fdGrowth > config.soakFdGrowth) {
        violation('soak', `${name} fd growth`, fdGrowth, config.soakFdGrowth);
      }
    }
  }
  console.log(`  soak ${interrupted ? 'interrupted' : 'completed'}: ${samples.length} samples, traffic ok=${traffic.ok}/${traffic.total}`);
  for (const [name, t] of Object.entries(trends)) {
    console.log(
      `  trend ${name}: RSS ${(t.firstMemBytes / 1024 ** 2).toFixed(0)}->${(t.lastMemBytes / 1024 ** 2).toFixed(0)}MB (+${t.rssGrowthPct}%), fds ${t.firstFdCount}->${t.lastFdCount}`,
    );
  }
  if (last?.postgres) {
    console.log(
      `  postgres: WAL=${((last.postgres.walBytes ?? 0) / 1024 ** 2).toFixed(0)}MB conns=${last.postgres.connections} db=${(((last.postgres.databaseBytes ?? 0)) / 1024 ** 2).toFixed(0)}MB`,
    );
  }
  report.scenarios.soak = {
    samples: samples.length,
    sampleFile: outPath,
    interrupted,
    trends,
    postgres: last?.postgres ?? null,
    traffic: { ...traffic },
  };
}

// ── Dry run ───────────────────────────────────────────────────────────────────
if (dryRun) {
  const composeCmd = (serviceArgs) => `docker compose ${composeFileArgs.join(' ')} ${serviceArgs.join(' ')}`;
  const plan = {
    'account-faults': [
      `reset mock + shape, then closed-loop traffic c=${config.faultConcurrency} for ${config.faultSeconds}s (mixed stream/non-stream)`,
      `after ${config.faultWarmupSeconds}s warmup, for each mode in ${config.faultModes}: inject on ${faultAccountList.length || '(MISSING --fault-accounts)'} account(s) for ${config.faultModeSeconds}s via POST ${env.mockControlUrl || '(MOCK_CONTROL_URL)'}/__control/faults, then clear`,
      `verify: requests to faulted accounts during each window <= ${config.classificationMaxRequestsDuringFault} (health classification)`,
      `verify: post-warmup success rate >= ${config.faultMinSuccessRate} (failover to healthy accounts)`,
      `verify: currentInFlight drains to 0 after ${config.faultCooldownSeconds}s (no leaked connections)`,
    ],
    'kill-instance': [
      `list gateway containers: ${composeCmd(['ps', '--format', 'json', 'gateway'])} (needs >= 2 running replicas)`,
      `launch ${config.killInflight} concurrent long streams (${config.killChunks} chunks x ${config.killChunkDelayMs}ms)`,
      `docker kill <first gateway container>`,
      `await in-flight outcomes (breakage counted, not a failure); then ${config.killPostRequests} NEW requests on surviving URLs — zero failures allowed`,
      `verify: mock currentInFlight drains to 0 after ${config.drainSeconds}s (no leaked upstream connections)`,
    ],
    'kill-postgres': [
      `baseline gateway request must be 200`,
      `${composeCmd(['stop', 'postgres'])}; probe every ${config.pgProbeIntervalMs}ms for ${config.pgDownSeconds}s`,
      `verify: no 200s during outage, fail-closed latency <= ${config.pgMaxFailMs}ms, no transport errors`,
      `${composeCmd(['start', 'postgres'])}; wait pg_isready (timeout ${config.pgRecoveryTimeoutSeconds}s)`,
      `verify: gateway recovers to 200 within ${config.pgRecoveryProbes} probes`,
    ],
    'token-expiry': [
      `PREREQUISITE: operator runtime module implements OAuth refresh against the mock /oauth/token; opt-in scenario (not in --scenario all)`,
      `closed-loop traffic c=${config.tokenConcurrency} for ${config.tokenSeconds}s; after ${config.tokenWarmupSeconds}s warmup POST /__control/rotate-token`,
      `verify: refresh burst <= ${config.tokenMaxRefreshBurst} per gateway instance, recovery window mostly-200, overall success >= 0.9`,
    ],
    soak: [
      `closed-loop traffic c=${config.soakConcurrency} for ${config.soakHours}h`,
      `every ${config.soakSampleSeconds}s: docker stats --no-stream (RSS), docker exec fd counts on gateway containers, psql WAL/connections/db size`,
      `verify: per-container RSS growth <= ${config.soakRssGrowthPct}%, fd growth <= ${config.soakFdGrowth}; WAL trend recorded (no hard threshold)`,
    ],
  };
  console.log('chaos-gateway dry-run: configuration validated, nothing executed, no network traffic.');
  console.log(`compose dir: ${config.composeDir}`);
  console.log(`compose files: ${config.composeFiles}`);
  console.log(`scenarios: ${scenarios.join(', ')}`);
  for (const s of scenarios) {
    console.log(`  - ${s}:`);
    for (const step of plan[s]) console.log(`      ${step}`);
  }
  console.log(`gateway URLs (${env.gatewayUrls.length}): ${env.gatewayUrls.join(', ') || '(none)'}`);
  console.log(`mock control URL: ${env.mockControlUrl || '(none)'}`);
  console.log(`proxy key: ${env.proxyKey ? '(set)' : '(not set)'}`);
  console.log(`fault accounts: ${faultAccountList.length ? `(${faultAccountList.length} configured)` : '(not set)'}`);
  if (configProblems.length > 0) {
    console.log('config problems (must be fixed before a real run):');
    for (const p of configProblems) console.log(`  MISSING: ${p}`);
  }
  console.log('note: executing the scenarios requires docker + the running compose stack (deploy/compose/BENCH.md).');
  process.exit(0);
}

// ── Real-run gates ────────────────────────────────────────────────────────────
for (const p of configProblems) {
  console.error(`error: ${p}`);
  process.exit(2);
}
await checkDockerHost();
await preflight();

const order = ['account-faults', 'kill-instance', 'kill-postgres', 'token-expiry', 'soak'];
for (const s of order) {
  if (!scenarios.includes(s)) continue;
  if (s === 'account-faults') await scenarioAccountFaults();
  if (s === 'kill-instance') await scenarioKillInstance();
  if (s === 'kill-postgres') await scenarioKillPostgres();
  if (s === 'token-expiry') await scenarioTokenExpiry();
  if (s === 'soak') await scenarioSoak();
}

finish(report.violations.length === 0 ? 0 : 1);
