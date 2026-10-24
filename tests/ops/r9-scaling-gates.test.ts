import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const benchFile = path.join(root, 'scripts/ops/bench-gateway.mjs');
const supervisorFile = path.join(root, 'scripts/ops/run-current-r9.mjs');
const quietConsole = { log() {}, error() {} };

function helpers<T>(file: string, names: string[], globals: Record<string, unknown> = {}): T {
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const selected = ast.statements.filter((node) =>
    ts.isFunctionDeclaration(node)
      ? node.name && names.includes(node.name.text)
      : ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) ? names.includes(declaration.name.text) : false,
        ),
  );
  return runInContext(
    `${selected.map((node) => node.getText(ast)).join('\n')}\n({${names.join(',')}})`,
    createContext({ console: quietConsole, ...globals }),
  ) as T;
}

interface Budget {
  maxTransportErrors: number;
  maxUnexpected5xx: number;
}
interface Counts {
  successfulRequests: number;
  transportErrors: number;
  unexpected5xx: number;
}
interface Violation {
  scenario: string;
  metric: string;
  value: number;
  threshold: number;
}
interface Scaling {
  instanceCount: number;
  inflight: number;
  seconds: number;
  throughputRps: number;
  statuses: Record<string, number>;
  latency: { n: number };
  acceptedLatency?: { n: number; measurement: string };
  successfulRps?: number;
  rejected429?: number;
  rejected429Ratio?: number;
  successfulSampleSufficiency?: { minimum: number; observed: number; sufficient: boolean };
  ratio?: number | null;
  invalidComparisonReason?: string;
}
interface Report {
  tool: string;
  config: Budget;
  scenarios: { scaling?: Scaling; concurrency?: Scaling & { transportErrors: number } };
  violations: Violation[];
  fatalError?: string;
}
interface BenchApi {
  loadStatusCounts(statuses: unknown, explicitTransportErrors?: unknown): Counts | null;
  loadCountsWithinBudget(counts: Counts | null, budget: Budget): boolean;
  applyLoadErrorBudgets(scenario: string, counts: Counts | null): void;
  scalingReportFailure(report: unknown, budget: Budget): string | null;
  scenarioScaling(): Promise<void>;
  scenarioConcurrency(): Promise<void>;
  violationsExit(): void;
}
const benchNames = [
  'loadStatusCounts',
  'loadCountsWithinBudget',
  'applyLoadErrorBudgets',
  'scalingReportFailure',
  'rejectScalingComparison',
  'violation',
  'statusBump',
  'pct',
  'latencySummary',
  'scenarioScaling',
  'scenarioConcurrency',
  'violationsExit',
];
const zeroBudget: Budget = { maxTransportErrors: 0, maxUnexpected5xx: 0 };

test('cap profile requires frozen diagnostic runs and only unset versus eight', () => {
  const api = helpers<{ validateCapProfile(options: Record<string, boolean>, cap: number | null): void }>(
    supervisorFile, ['validateCapProfile'], { assert },
  );
  const options = { capProfile: true, diagnostic: true, noBuild: true, serialProfile: false, requestSamples: false };
  api.validateCapProfile(options, null);
  api.validateCapProfile(options, 8);
  for (const cap of [0, 4, 16]) assert.throws(() => api.validateCapProfile(options, cap));
  for (const changed of [{ diagnostic: false }, { noBuild: false }, { serialProfile: true }, { requestSamples: true }]) {
    assert.throws(() => api.validateCapProfile({ ...options, ...changed }, 8));
  }
  api.validateCapProfile({}, 16);
  const source = readFileSync(supervisorFile, 'utf8');
  assert.match(source, /\['--scenario','concurrency','--inflight','200','--concurrency-seconds','60'\]/);
});

test('cap evidence separates accepted throughput and rejection without declaring a capacity answer', () => {
  interface CapEvidence {
    performanceAcceptance: boolean; configurationUnchanged: boolean; successfulRequests: number;
    rejected429: number; rejected429Ratio: number; unexpected5xx: number; transportErrors: number;
    successfulSampleSufficiency: { sufficient: boolean }; capacityRecommendation: null;
  }
  const api = helpers<{ capProfileEvidence(report: unknown): CapEvidence }>(supervisorFile, ['capProfileEvidence']);
  const configuration = { inflight: 200, concurrencySeconds: 60, p99OverheadMs: 30, ttfbOverheadMs: 10, noFail: false };
  const result = api.capProfileEvidence({ config: configuration, scenarios: { concurrency: {
    statuses: { '200': 100, '429': 890, '502': 5 }, transportErrors: 5, throughputRps: 1.6,
    latency: { n: 100 }, acceptedLatency: { n: 100 },
  } } });
  assert.equal(result.configurationUnchanged, true);
  assert.equal(result.performanceAcceptance, false);
  assert.equal(result.successfulRequests, 100);
  assert.equal(result.rejected429Ratio, 0.89);
  assert.equal(result.unexpected5xx, 5);
  assert.equal(result.transportErrors, 5);
  assert.equal(result.successfulSampleSufficiency.sufficient, true);
  assert.equal(result.capacityRecommendation, null);
  const rejected = api.capProfileEvidence({ config: configuration, scenarios: { concurrency: {
    statuses: { '429': 1000 }, transportErrors: 0, throughputRps: 0,
  } } });
  assert.equal(rejected.successfulSampleSufficiency.sufficient, false);
  assert.equal(rejected.successfulRequests, 0);
  assert.equal(rejected.rejected429Ratio, 1);
});

test('cap resource sampling is bounded and makes the unobserved process IO boundary explicit', () => {
  let tick: (() => void) | undefined;
  let cleared = false;
  const api = helpers<{ startCapProfileResources(): { stop(): { samples: unknown[]; droppedSamples: number; processCpuAndIoObserved: boolean } } }>(
    supervisorFile, ['startCapProfileResources'], {
      cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 10, irq: 0 } }],
      loadavg: () => [1, 1, 1], freemem: () => 10, totalmem: () => 20,
      setInterval(callback: () => void) { tick = callback; return { unref() {} }; },
      clearInterval() { cleared = true; },
    },
  );
  const sampler = api.startCapProfileResources();
  for (let index = 0; index < 40; index++) tick!();
  const result = sampler.stop();
  assert.equal(cleared, true);
  assert.equal(result.samples.length, 32);
  assert.equal(result.droppedSamples, 10);
  assert.equal(result.processCpuAndIoObserved, false);
});
function cleanReport(): Report {
  return {
    tool: 'bench-gateway',
    config: { ...zeroBudget },
    violations: [],
    scenarios: {
      scaling: {
        instanceCount: 1,
        inflight: 200,
        seconds: 120,
        throughputRps: 10,
        statuses: { '200': 1200 },
        latency: { n: 1200 },
      },
    },
  };
}
type ScriptedRequest = number | 'transport' | 'body';
function bench(
  script: ScriptedRequest[] = [],
  options: { budget?: Budget; baseline?: unknown; baselineText?: string; noFail?: boolean } = {},
) {
  const report: Report = {
    tool: 'bench-gateway',
    config: options.budget ?? { ...zeroBudget },
    scenarios: {},
    violations: [],
  };
  const events: string[] = [];
  const exits: number[] = [];
  let request = 0;
  let ticks = 0;
  const api = helpers<BenchApi>(benchFile, benchNames, {
    report,
    config: {
      ...report.config,
      noFail: options.noFail ?? false,
      scalingInflight: 200,
      scalingSeconds: 120,
      inflight: 200,
      concurrencySeconds: 60,
      scalingMinRatio: 2.7,
      baselineReport:
        options.baseline !== undefined || options.baselineText !== undefined ? '/fixture/baseline.json' : null,
    },
    env: { gatewayUrls: ['http://g1', 'http://g2', 'http://g3'] },
    performance: { now: () => ticks++ * 1000 },
    process: {
      exit(code: number) {
        exits.push(code);
      },
    },
    readFileSync: () => options.baselineText ?? JSON.stringify(options.baseline),
    async closedLoop(_concurrency: number, _duration: number, worker: (index: number) => Promise<void>) {
      for (let index = 0; index < script.length; index++) await worker(index);
    },
    async gatewayRequest() {
      const next = script[request++];
      if (next === 'transport') throw new Error('fixture transport failure');
      return {
        elapsedMs: request + 0.123,
        response: {
          status: next === 'body' ? 200 : next,
          async text() {
            events.push('drain');
            if (next === 'body') throw new Error('fixture body failure');
            return '{}';
          },
        },
      };
    },
  });
  return { api, report, events, exits };
}

test('J7 exact status counts produce the existing zero-5xx violation despite some success', () => {
  const { api, report } = bench();
  const counts = api.loadStatusCounts({ '200': 899, '429': 5200, '502': 365, '503': 4600 });
  assert.ok(counts);
  assert.equal(counts.successfulRequests, 899);
  assert.equal(counts.transportErrors, 0);
  assert.equal(counts.unexpected5xx, 4965);
  api.applyLoadErrorBudgets('scaling', counts);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].scenario, 'scaling');
  assert.equal(report.violations[0].metric, 'unexpected 5xx');
  assert.equal(report.violations[0].value, 4965);
  assert.equal(report.violations[0].threshold, 0);
});

test('scaling preserves drains/status inclusion and counts fetch/body failures as transport errors', async () => {
  const { api, report, events } = bench([200, 429, 401, 502, 503, 'transport', 'body']);
  await api.scenarioScaling();
  const scaling = report.scenarios.scaling;
  assert.ok(scaling);
  assert.equal(events.length, 6);
  assert.equal(scaling.statuses['200'], 1);
  assert.equal(scaling.statuses['429'], 1);
  assert.equal(scaling.statuses['401'], 1);
  assert.equal(scaling.statuses['transport-error'], 2);
  assert.equal(scaling.latency.n, 1);
  assert.equal(scaling.throughputRps, 1);
  assert.deepEqual(
    report.violations.map((entry) => [entry.metric, entry.value]),
    [
      ['transport errors', 2],
      ['unexpected 5xx', 2],
    ],
  );
});

test('429 and other 4xx remain counted without a new rate threshold; chosen budgets remain honored', async () => {
  const healthy = bench([200, 429, 429, 400, 401, 403]);
  await healthy.api.scenarioScaling();
  assert.equal(healthy.report.violations.length, 0);
  assert.equal(healthy.report.scenarios.scaling?.statuses['429'], 2);
  const allowed = bench([200, 502, 'transport'], { budget: { maxTransportErrors: 1, maxUnexpected5xx: 1 } });
  await allowed.api.scenarioScaling();
  assert.equal(allowed.report.violations.length, 0);
  const noSuccess = bench([429]);
  await noSuccess.api.scenarioScaling();
  assert.equal(noSuccess.report.violations[0].metric, 'valid scaling samples');
});

test('concurrency retains the same transport/5xx gates and 429 policy', async () => {
  const { api, report } = bench([200, 429, 502, 'transport', 'body']);
  await api.scenarioConcurrency();
  assert.equal(report.scenarios.concurrency?.transportErrors, 2);
  assert.equal(report.scenarios.concurrency?.statuses['429'], 1);
  assert.equal(report.scenarios.concurrency?.latency.n, 1);
  assert.equal(report.scenarios.concurrency?.acceptedLatency?.n, 1);
  assert.equal(report.scenarios.concurrency?.acceptedLatency?.measurement, 'request-start-through-response-body');
  assert.equal(report.scenarios.concurrency?.rejected429, 1);
  assert.equal(report.scenarios.concurrency?.rejected429Ratio, 1 / 5);
  assert.equal(report.scenarios.concurrency?.successfulSampleSufficiency?.sufficient, false);
  assert.deepEqual(
    report.violations.map((entry) => [entry.scenario, entry.metric, entry.value]),
    [
      ['concurrency', 'transport errors', 2],
      ['concurrency', 'unexpected 5xx', 1],
    ],
  );
});

test('no-fail can keep exit zero but cannot erase scaling violations', async () => {
  const strict = bench([200, 502]);
  await strict.api.scenarioScaling();
  strict.api.violationsExit();
  assert.deepEqual(strict.exits, [1]);
  const permissiveExit = bench([200, 502], { noFail: true });
  await permissiveExit.api.scenarioScaling();
  permissiveExit.api.violationsExit();
  assert.deepEqual(permissiveExit.exits, [0]);
  assert.equal(permissiveExit.report.violations.length, 1);
});

test('baseline errors are rechecked against current budgets, not its own permissive config', async () => {
  const baseline = cleanReport();
  baseline.config.maxUnexpected5xx = 5000;
  assert.ok(baseline.scenarios.scaling);
  baseline.scenarios.scaling.statuses['503'] = 2;
  const strict = bench([200, 200, 200], { baseline });
  await strict.api.scenarioScaling();
  assert.equal(strict.report.scenarios.scaling?.ratio, null);
  assert.equal(strict.report.scenarios.scaling?.invalidComparisonReason, 'baseline_load_error_budget');
  assert.equal(strict.report.violations[0].metric, 'valid scaling comparison');
  const allowed = bench([200, 200, 200], { baseline, budget: { maxTransportErrors: 0, maxUnexpected5xx: 2 } });
  await allowed.api.scenarioScaling();
  assert.equal(allowed.report.scenarios.scaling?.ratio, 0.3);
  assert.equal(
    allowed.report.violations[0].metric,
    'throughput ratio',
    'explicit budget allows comparison but keeps original ratio gate',
  );
});

test('fatal, failed, missing and malformed baseline evidence never produces a valid ratio', async () => {
  const cases: unknown[] = [
    null,
    {},
    { ...cleanReport(), fatalError: 'fixture' },
    { ...cleanReport(), violations: [{ metric: 'fixture' }] },
    { ...cleanReport(), scenarios: {} },
  ];
  for (const patch of [
    { throughputRps: 0 },
    { throughputRps: -1 },
    { throughputRps: Number.POSITIVE_INFINITY },
    { statuses: { '200': 1200, 'transport-error': 1 } },
    { statuses: { '200': -1 } },
    { statuses: { '200': 1200, '503': '1' } },
    { latency: { n: 1199 } },
    { latency: { n: 0 } },
    { seconds: 0 },
    { inflight: 0 },
    { instanceCount: 0 },
    { statuses: null },
    { invalidComparisonReason: 'prior_failure' },
  ]) {
    const report = cleanReport();
    Object.assign(report.scenarios.scaling as Scaling, patch);
    cases.push(report);
  }
  for (const baseline of cases) {
    const { api, report } = bench([200], { baseline });
    await api.scenarioScaling();
    assert.equal(report.scenarios.scaling?.ratio, null);
    assert.match(report.scenarios.scaling?.invalidComparisonReason ?? '', /^baseline_/);
    assert.equal(report.violations.at(-1)?.metric, 'valid scaling comparison');
  }
  const unreadable = bench([200], { baselineText: '{invalid-json' });
  await unreadable.api.scenarioScaling();
  assert.equal(unreadable.report.scenarios.scaling?.ratio, null);
  assert.equal(unreadable.report.scenarios.scaling?.invalidComparisonReason, 'baseline_unreadable_report');
});

test('current report failures also invalidate comparison; healthy 2.7 boundary is unchanged', async () => {
  const badCurrent = bench([200, 502], { baseline: cleanReport() });
  await badCurrent.api.scenarioScaling();
  assert.equal(badCurrent.report.scenarios.scaling?.ratio, null);
  assert.equal(badCurrent.report.scenarios.scaling?.invalidComparisonReason, 'current_report_failed');
  const healthy = bench(
    Array.from({ length: 27 }, () => 200),
    { baseline: cleanReport() },
  );
  await healthy.api.scenarioScaling();
  assert.equal(healthy.report.scenarios.scaling?.ratio, 2.7);
  assert.equal(healthy.report.violations.length, 0);
  const below = cleanReport();
  assert.ok(below.scenarios.scaling);
  below.scenarios.scaling.throughputRps = 11;
  const failedRatio = bench(
    Array.from({ length: 27 }, () => 200),
    { baseline: below },
  );
  await failedRatio.api.scenarioScaling();
  assert.equal(failedRatio.report.violations[0].metric, 'throughput ratio');
  assert.equal(failedRatio.report.violations[0].threshold, 2.7);
});

test('load-counter validation rejects malformed or conflicting counts', () => {
  const { api } = bench();
  for (const value of [
    null,
    [],
    { '200': -1 },
    { '200': 0.5 },
    { '200': '1' },
    { '600': 1 },
    { '200': Number.MAX_SAFE_INTEGER, '429': 1 },
  ])
    assert.equal(api.loadStatusCounts(value), null);
  assert.equal(api.loadStatusCounts({ '200': 1 }, null), null);
  assert.equal(api.loadStatusCounts({ '200': 1, 'transport-error': 2 }, 1), null);
});

type Benchmark = (
  name: string,
  urls: string[],
  args: string[],
  route: { protocol: string },
) => Promise<{ reportFile: string; ok: boolean }>;
interface SupervisorApi {
  validObservedLoadCounters(report: unknown, requestedScenario: string): boolean;
  runFullR9Benchmarks(inventory: { protocol: string }[], urls: string[], benchmark: Benchmark): Promise<void>;
}
function supervisor(): SupervisorApi {
  return helpers<SupervisorApi>(supervisorFile, ['validObservedLoadCounters', 'runFullR9Benchmarks']);
}

test('supervisor rejects observed scaling/concurrency failures even with exit-zero/empty-violation reports', () => {
  const api = supervisor();
  const report = cleanReport();
  assert.equal(api.validObservedLoadCounters(report, 'scaling'), true);
  const dirty = cleanReport();
  assert.ok(dirty.scenarios.scaling);
  dirty.scenarios.scaling.statuses = { '200': 899, '429': 5200, '502': 365, '503': 4600 };
  dirty.scenarios.scaling.latency.n = 899;
  assert.equal(api.validObservedLoadCounters(dirty, 'scaling'), false);
  report.scenarios.concurrency = { ...(report.scenarios.scaling as Scaling), transportErrors: 1 };
  assert.equal(api.validObservedLoadCounters(report, 'all'), false);
  report.scenarios.concurrency.transportErrors = 0;
  assert.equal(api.validObservedLoadCounters(report, 'all'), true);
  report.scenarios.concurrency.statuses = { '200': 1200, '429': 1000, '401': 1 };
  assert.equal(api.validObservedLoadCounters(report, 'all'), true, 'no new 429 or other 4xx policy');
  report.config.maxUnexpected5xx = 100;
  assert.equal(api.validObservedLoadCounters(report, 'all'), false, 'managed runner pins its chosen zero budgets');
});

test('supervisor requires expected load scenes and consistent positive observed counts', () => {
  const api = supervisor();
  assert.equal(api.validObservedLoadCounters({ scenarios: {} }, 'scaling'), false);
  assert.equal(api.validObservedLoadCounters({ scenarios: { latency: {}, ttfb: {} } }, 'latency,ttfb'), true);
  for (const patch of [
    { statuses: {} },
    { statuses: { '200': '1200' } },
    { statuses: { '200': 1200, 'transport-error': 1 } },
    { latency: { n: 1199 } },
    { throughputRps: 0 },
  ]) {
    const report = cleanReport();
    Object.assign(report.scenarios.scaling as Scaling, patch);
    assert.equal(api.validObservedLoadCounters(report, 'scaling'), false);
  }
});

test('failed baseline stops all subsequent load and returns normally to statistics/metrics/cleanup', async () => {
  const api = supervisor();
  const events: string[] = [];
  try {
    await api.runFullR9Benchmarks(
      [{ protocol: 'openai' }, { protocol: 'anthropic' }],
      ['g1', 'g2', 'g3'],
      async (name) => {
        events.push(name);
        return { reportFile: '/baseline', ok: false };
      },
    );
    events.push('final-stats', 'metrics-1', 'metrics-2', 'metrics-3');
  } finally {
    events.push('cleanup');
  }
  assert.deepEqual(events, ['openai-scaling-1cli', 'final-stats', 'metrics-1', 'metrics-2', 'metrics-3', 'cleanup']);
});

test('failed full child stops later protocols; a healthy sequence preserves baseline path and load arguments', async () => {
  const api = supervisor();
  const calls: { name: string; urls: string[]; args: string[] }[] = [];
  const run = async (failFull: boolean) =>
    api.runFullR9Benchmarks(
      [{ protocol: 'openai' }, { protocol: 'anthropic' }],
      ['g1', 'g2', 'g3'],
      async (name, urls, args) => {
        calls.push({ name, urls, args });
        return { reportFile: `/${name}.json`, ok: !failFull || !name.endsWith('-r9-3cli') };
      },
    );
  await run(true);
  assert.deepEqual(
    calls.map((entry) => entry.name),
    ['openai-scaling-1cli', 'openai-r9-3cli'],
  );
  assert.deepEqual(Array.from(calls[0].urls), ['g1']);
  assert.equal(calls[1].args[calls[1].args.indexOf('--baseline-report') + 1], '/openai-scaling-1cli.json');
  assert.equal(calls[1].args[calls[1].args.indexOf('--scaling-inflight') + 1], '200');
  assert.equal(calls[1].args[calls[1].args.indexOf('--scaling-seconds') + 1], '120');
  calls.length = 0;
  await run(false);
  assert.deepEqual(
    calls.map((entry) => entry.name),
    ['openai-scaling-1cli', 'openai-r9-3cli', 'anthropic-scaling-1cli', 'anthropic-r9-3cli'],
  );
});

test('actual supervisor keeps final collection after the controlled sequence and cleanup in finally', () => {
  const source = readFileSync(supervisorFile, 'utf8');
  const sequence = source.lastIndexOf('await runFullR9Benchmarks(seed.inventory, gatewayUrls, benchmark);');
  const statistics = source.lastIndexOf('const stats = await fetch(');
  const metrics = source.lastIndexOf('manifest.metrics = [];');
  const cleanup = source.lastIndexOf('await closeOwned();');
  assert.ok(sequence > 0 && sequence < statistics && statistics < metrics && metrics < cleanup);
  const functionStart = source.indexOf('async function runFullR9Benchmarks(');
  const functionEnd = source.indexOf('\nfunction firstFault(', functionStart);
  const controlledSequence = source.slice(functionStart, functionEnd);
  assert.match(controlledSequence, /if \(!baseline\.ok\) break;/);
  assert.match(controlledSequence, /if \(!full\.ok\) break;/);
  assert.doesNotMatch(controlledSequence, /\bthrow\b/);
});

interface SampleEvidence {
  applicable: boolean;
  sufficient: boolean;
  legs: { scenario: string; leg: string; required: number | null; observed: number | null; sufficient: boolean }[];
}
interface SampleApi {
  observedSampleSufficiency(report: unknown, requestedScenario: string,
    profile?: { diagnostic?: boolean; serialProfile?: boolean; capProfile?: boolean }): SampleEvidence;
}
function sampleApi(): SampleApi {
  return helpers<SampleApi>(supervisorFile, ['observedSampleSufficiency']);
}
function completeSampleReport() {
  return {
    config: { requests: 100, streamSamples: 100 },
    scenarios: {
      latency: { direct: { n: 100 }, gateway: { n: 100 } },
      ttfb: { direct: { n: 100 }, gateway: { n: 100 }, gatewayErrors: 0, ttfbOverheadMs: 1 },
      concurrency: { statuses: { '200': 100 }, latency: { n: 100 },
        acceptedLatency: { n: 100, measurement: 'request-start-through-response-body' } },
      scaling: { statuses: { '200': 100 }, latency: { n: 100 } },
    },
  };
}

test('full R9 requires complete configured latency and TTFB legs and at least 100 load successes', () => {
  const api = sampleApi();
  const evidence = api.observedSampleSufficiency(completeSampleReport(), 'all');
  assert.equal(evidence.applicable, true);
  assert.equal(evidence.sufficient, true);
  assert.equal(evidence.legs.length, 6);
  for (const count of [0, 99]) {
    for (const name of ['concurrency', 'scaling'] as const) {
      const report = completeSampleReport();
      report.scenarios[name].statuses['200'] = count;
      report.scenarios[name].latency.n = count;
      if (name === 'concurrency') report.scenarios.concurrency.acceptedLatency.n = count;
      assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false, `${name}: ${count}`);
    }
  }
  for (const name of ['latency', 'ttfb'] as const) {
    for (const leg of ['direct', 'gateway'] as const) {
      const report = completeSampleReport();
      report.scenarios[name][leg].n = 99;
      assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false, `${name}: ${leg}`);
    }
  }
  const configured = completeSampleReport();
  configured.config.requests = 101;
  assert.equal(api.observedSampleSufficiency(configured, 'all').sufficient, false);
  configured.config.requests = 100;
  configured.config.streamSamples = 101;
  assert.equal(api.observedSampleSufficiency(configured, 'all').sufficient, false);
  for (const count of [0, 99]) {
    const report = completeSampleReport();
    report.config.requests = count;
    report.scenarios.latency.direct.n = report.scenarios.latency.gateway.n = count;
    assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false);
    report.config.requests = 100;
    report.scenarios.latency.direct.n = report.scenarios.latency.gateway.n = 100;
    report.config.streamSamples = count;
    report.scenarios.ttfb.direct.n = report.scenarios.ttfb.gateway.n = count;
    assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false);
  }
});

test('sample evidence rejects missing, malformed, inconsistent and incomplete streaming observations', () => {
  const api = sampleApi();
  for (const report of [null, {}, { config: { requests: 100, streamSamples: 100 }, scenarios: {} }]) {
    assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false);
  }
  for (const count of [undefined, null, '100', -1, 1.5, NaN, Infinity]) {
    const report = completeSampleReport();
    const malformed = { ...report, scenarios: { ...report.scenarios,
      scaling: { statuses: { '200': count }, latency: { n: count } } } };
    const evidence = api.observedSampleSufficiency(malformed, 'scaling');
    assert.equal(evidence.sufficient, false);
    assert.equal(evidence.legs.find((leg) => leg.scenario === 'scaling')?.observed, null);
  }
  for (const patch of [
    { gatewayErrors: 1 }, { ttfbOverheadMs: NaN }, { ttfbOverheadMs: Infinity },
  ]) {
    const report = completeSampleReport();
    Object.assign(report.scenarios.ttfb, patch);
    assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false);
  }
  const report = completeSampleReport();
  report.scenarios.concurrency.acceptedLatency.n = 99;
  assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false);
  report.scenarios.concurrency.acceptedLatency.n = 100;
  report.scenarios.scaling.latency.n = 99;
  assert.equal(api.observedSampleSufficiency(report, 'all').sufficient, false);
});

test('cap samples remain enforced while short diagnostic and serial retain their existing gates', () => {
  const api = sampleApi();
  for (const profile of [{ diagnostic: true }, { diagnostic: true, serialProfile: true }]) {
    const evidence = api.observedSampleSufficiency({}, 'latency,ttfb,concurrency', profile);
    assert.equal(evidence.applicable, false);
    assert.equal(evidence.sufficient, true);
    assert.equal(evidence.legs.length, 0);
  }
  const cap = { diagnostic: true, capProfile: true };
  for (const count of [0, 99, 100]) {
    const report = completeSampleReport().scenarios.concurrency;
    report.statuses['200'] = report.latency.n = report.acceptedLatency.n = count;
    assert.equal(api.observedSampleSufficiency({ scenarios: { concurrency: report } }, 'concurrency', cap).sufficient, count === 100);
  }
  const source = readFileSync(supervisorFile, 'utf8');
  assert.match(source, /validCapProfile && sampleSufficiency\.sufficient/);
  assert.match(source, /validScalingComparison, sampleSufficiency/);
  assert.match(source, /'--requests','10','--stream-samples','10'/);
  assert.match(source, /completeTtfb:.*direct\.n === 100.*gateway\.n === 100.*gatewayErrors === 0/);
});

test('insufficient baseline samples stop before the current leg and preserve the cleanup path', async () => {
  const api = supervisor();
  const samples = sampleApi();
  const events: string[] = [];
  try {
    await api.runFullR9Benchmarks([{ protocol: 'openai' }], ['g1', 'g2', 'g3'], async (name) => {
      events.push(name);
      const scaling = { statuses: { '200': 99 }, latency: { n: 99 } };
      return { reportFile: '/baseline', ok: samples.observedSampleSufficiency({ scenarios: { scaling } }, 'scaling').sufficient };
    });
    events.push('final-stats', 'metrics');
  } finally {
    events.push('cleanup');
  }
  assert.deepEqual(events, ['openai-scaling-1cli', 'final-stats', 'metrics', 'cleanup']);
});
