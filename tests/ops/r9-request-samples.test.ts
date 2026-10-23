import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const benchFile = path.join(root, 'scripts/ops/bench-gateway.mjs');
const supervisorFile = path.join(root, 'scripts/ops/run-current-r9.mjs');
const quietConsole = { log() {}, error() {} };

// Evaluate the actual bounded helpers without launching either supervisor,
// importing dist, opening a database, or running benchmark warmup timers.
function loadHelpers<T>(file: string, names: string[], globals: Record<string, unknown> = {}): T {
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
  const context = createContext({ assert, console: quietConsole, Date, Set, Map, path, ...globals });
  return runInContext(`${selected.map((node) => node.getText(ast)).join('\n')}\n({${names.join(',')}})`, context) as T;
}

interface Sample {
  scenario: string;
  leg: string;
  index: number;
  gatewayIndex: number | null;
  startedAt: string;
  recordedAt: string;
  status: number | null;
  outcome: string;
  includedInSummary: boolean;
  metricMs: number | null;
  requestId: string | null;
  requestIdState: string;
}
type SampleContext = Pick<Sample, 'scenario' | 'leg' | 'index' | 'gatewayIndex' | 'startedAt'>;
interface Journal {
  schema: number;
  observationOk: boolean;
  failure: { stage: string; sqlState: string | null } | null;
  cap: number;
  samples: Sample[];
}
interface BenchApi {
  requestSampleContext(scenario: string, leg: string, index: number): SampleContext | null;
  recordRequestSample(
    context: SampleContext | null,
    response: unknown,
    metric: number | null,
    included: boolean,
    outcome: string,
  ): void;
  requestSampleCompleteness(samples: Sample[]): Record<string, unknown>;
  requestSampleSelections(samples: Sample[]): Record<
    string,
    {
      n: number;
      selected: Record<string, { sortedIndex: number; sampleIndex: number; metricMs: number; reportedMs: number }>;
    }
  >;
  requestSampleOutcome(error: unknown, response: unknown, metric: number | null): string;
  writeRequestSamples(): void;
  gatewayRequest(
    stream: boolean,
    url?: string,
    sample?: SampleContext | null,
  ): Promise<{ response: Response; elapsedMs: number }>;
  measureTtfb(request: () => Promise<unknown>, sample?: SampleContext | null): Promise<number>;
  scenarioLatency(): Promise<void>;
  scenarioTtfb(): Promise<void>;
  latencySummary(values: number[]): { n: number; p50: number; p90: number; p99: number; max: number };
  writeReport(): void;
}
const observerNames = [
  'REQUEST_SAMPLES_CAP',
  'REQUEST_SAMPLE_UUID',
  'requestSampleFailure',
  'requestSampleContext',
  'requestSampleOutcome',
  'recordRequestSample',
  'requestSampleCompleteness',
  'requestSampleSelections',
  'writeRequestSamples',
];
function journal(): Journal {
  return { schema: 1, observationOk: true, failure: null, cap: 400, samples: [] };
}
function sample(scenario: string, leg: string, index: number): Sample {
  return {
    scenario,
    leg,
    index,
    gatewayIndex: leg === 'gateway' ? index % 3 : null,
    startedAt: '2026-10-22T00:00:00.000Z',
    recordedAt: '2026-10-22T00:00:00.100Z',
    status: 200,
    outcome: 'ok',
    includedInSummary: true,
    metricMs: index + 0.123,
    requestId: leg === 'gateway' ? randomUUID() : null,
    requestIdState: leg === 'gateway' ? 'valid' : 'not_applicable',
  };
}
function completeJournal(): Journal {
  return {
    ...journal(),
    samples: ['latency', 'ttfb'].flatMap((scenario) =>
      ['direct', 'gateway'].flatMap((leg) => Array.from({ length: 100 }, (_, index) => sample(scenario, leg, index))),
    ),
  };
}

test('R9 diagnostic tracing is explicit and forbidden in performance acceptance mode', () => {
  const api = loadHelpers<{ requestDiagnosticsConfiguration(setting: string | undefined, options: Record<string, boolean>): { enabled: boolean; sampleEvery: number | null } }>(
    supervisorFile, ['requestDiagnosticsConfiguration'],
  );
  assert.equal(api.requestDiagnosticsConfiguration(undefined, {}).enabled, false);
  const diagnostic = { diagnostic: true, serialProfile: true, requestSamples: true };
  assert.equal(api.requestDiagnosticsConfiguration('1', diagnostic).sampleEvery, 1);
  for (const setting of ['', '0', 'off', ' 1', '1.2', '1000000000']) assert.throws(() => api.requestDiagnosticsConfiguration(setting, diagnostic));
  for (const options of [{}, { diagnostic: true }, { diagnostic: true, serialProfile: true }] as Record<string, boolean>[]) {
    assert.throws(() => api.requestDiagnosticsConfiguration('1', options), /acceptance runs must not enable tracing/);
  }
  const source = readFileSync(supervisorFile, 'utf8');
  assert.match(source, /requestDiagnostics\.enabled \? \{ MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY: String\(requestDiagnostics\.sampleEvery\) \}/);
  assert.ok(source.lastIndexOf('await closeOwned();') < source.lastIndexOf('manifest.requestDiagnostics.export = await exportRequestDiagnosticTraces('));
});

test('R9 trace export joins original 200 gateway samples and projects only fixed diagnostic fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r9-traces-'));
  try {
    const observed = completeJournal();
    const input = path.join(directory, 'samples.json');
    const output = path.join(directory, 'traces.json');
    await writeFile(input, JSON.stringify(observed));
    const phases = ['pool-checkout', 'query', 'transaction', 'settle', 'upstream-send', 'upstream-body'];
    const lines = [[], [], []] as string[][];
    for (const entry of observed.samples.filter((entry) => entry.leg === 'gateway')) {
      lines[entry.gatewayIndex!].push(JSON.stringify({ kind: 'request-diagnostic-v1', requestId: entry.requestId,
        elapsedMs: 20, observedExclusiveMs: 10, pendingSpans: 0, droppedSpans: 0,
        markers: { eof: 10, settled: 19, secret: 'never-export' },
        phases: phases.map((phase) => ({ phase, inclusiveMs: 1, exclusiveMs: 1, payload: 'never-export' })),
        payload: 'never-export' }));
    }
    lines[0].push(JSON.stringify({ ...JSON.parse(lines[0][0]), requestId: randomUUID() }));
    for (let index = 0; index < 3; index++) await writeFile(path.join(directory, `gateway-${index + 1}.log`), `${lines[index].join('\n')}\n`);
    const api = loadHelpers<{ exportRequestDiagnosticTraces(input: string, directory: string, output: string): Promise<{ observationOk: boolean; sampleCount: number; missingTraces: number; duplicateTraces: number }> }>(
      supervisorFile, ['REQUEST_SAMPLE_UUID', 'projectRequestDiagnostic', 'validateRequestSampleJournal', 'exportRequestDiagnosticTraces'],
      { readFile, writeFile, existsSync, createReadStream, createInterface, join: path.join },
    );
    const result = await api.exportRequestDiagnosticTraces(input, directory, output);
    assert.equal(result.observationOk, true);
    assert.equal(result.sampleCount, 200);
    const bytes = await readFile(output, 'utf8');
    assert.ok(!bytes.includes('never-export'));
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const document = JSON.parse(bytes);
    assert.equal(document.performanceAcceptance, false);
    assert.equal(document.sinkLossCountersAvailable, false);
    assert.equal(document.rows[0].requestId, observed.samples.find((sample) => sample.leg === 'gateway')!.requestId);
    // Missing and duplicate logs must stay visible, never be called a complete trace.
    lines[0].shift();
    lines[1].push(lines[1][0]);
    lines[2].push('{"kind":"request-diagnostic-v1","requestId":"secret-invalid"}');
    for (let index = 0; index < 3; index++) await writeFile(path.join(directory, `gateway-${index + 1}.log`), `${lines[index].join('\n')}\n`);
    const incomplete = await api.exportRequestDiagnosticTraces(input, directory, path.join(directory, 'incomplete.json'));
    assert.equal(incomplete.observationOk, false);
    assert.equal(incomplete.missingTraces, 1);
    assert.equal(incomplete.duplicateTraces, 1);
    assert.ok(!(await readFile(path.join(directory, 'incomplete.json'), 'utf8')).includes('secret-invalid'));
    await assert.rejects(api.exportRequestDiagnosticTraces(input, directory, output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
function benchHelpers(globals: Record<string, unknown>, extraNames: string[] = []): BenchApi {
  return loadHelpers<BenchApi>(benchFile, [...observerNames, ...extraNames], {
    requestSampleWriteAttempted: false,
    requestSamplesOut: '/unused',
    ...globals,
  });
}

test('request samples require diagnostic serial mode before supervisor output/resources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r9-samples-arguments-'));
  try {
    for (const flags of [[], ['--diagnostic'], ['--serial-profile']]) {
      const output = path.join(directory, `not-created-${flags.length}-${flags[0] ?? 'none'}`);
      const result = spawnSync(
        process.execPath,
        [supervisorFile, '--request-samples', ...flags, '--output-dir', output],
        {
          env: { ...process.env, MODEL_ROUTER_TEST_PG_BIN: '', MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS: 'off' },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires --diagnostic/);
      assert.equal(existsSync(output), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bench accepts only the bounded unchanged serial sample configuration without network', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r9-samples-dryrun-'));
  try {
    const output = path.join(directory, 'new-samples.json');
    const flags = [
      '--dry-run',
      '--scenario',
      'latency,ttfb',
      '--requests',
      '100',
      '--stream-samples',
      '100',
      '--warmup-inflight',
      '1',
    ];
    const env = {
      ...process.env,
      GATEWAY_URLS: 'http://127.0.0.1:1,http://127.0.0.1:2,http://127.0.0.1:3',
      MOCK_UPSTREAM_URL: 'http://127.0.0.1:4',
      BENCH_PROXY_KEY: 'local-test',
    };
    const invoke = (extra: string[]) =>
      spawnSync(process.execPath, [benchFile, ...flags, ...extra], { env, encoding: 'utf8', timeout: 10_000 });
    const disabled = invoke([]);
    const enabled = invoke(['--request-samples-out', output]);
    assert.equal(enabled.status, 0);
    assert.equal(enabled.stdout, disabled.stdout, 'default plan/output shape stays unchanged');
    assert.equal(existsSync(output), false);
    for (const extra of [['--no-fail'], ['--p99-overhead-ms', '31'], ['--ttfb-overhead-ms', '11']]) {
      assert.equal(invoke(['--request-samples-out', output, ...extra]).status, 2);
    }
    for (const [argument, value] of [
      ['--requests', '99'],
      ['--stream-samples', '99'],
      ['--scenario', 'latency'],
      ['--warmup-inflight', '4'],
    ]) {
      const changed = [...flags];
      changed[changed.indexOf(argument) + 1] = value;
      const result = spawnSync(process.execPath, [benchFile, ...changed, '--request-samples-out', output], {
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(result.status, 2);
    }
    assert.equal(invoke(['--request-samples-out']).status, 2);
    assert.equal(invoke(['--request-samples-out', 'relative.json']).status, 2);
    writeFileSync(output, 'existing');
    assert.equal(invoke(['--request-samples-out', output]).status, 2);
    assert.equal(readFileSync(output, 'utf8'), 'existing');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('disabled observation never reads headers or allocates sample objects; default report stays unchanged', () => {
  const report = { config: { unchanged: true }, scenarios: {}, violations: [] };
  let headerReads = 0;
  let reportWrite = '';
  const api = benchHelpers(
    {
      requestSampleJournal: null,
      report,
      config: { out: '/mock/report.json' },
      mkdirSync() {},
      writeFileSync(_file: string, data: string) {
        reportWrite = data;
      },
    },
    ['writeReport'],
  );
  assert.equal(api.requestSampleContext('latency', 'gateway', 0), null);
  api.recordRequestSample(
    null,
    {
      get headers() {
        headerReads++;
        throw new Error('must not read');
      },
    },
    1,
    true,
    'ok',
  );
  api.writeReport();
  assert.equal(headerReads, 0);
  assert.deepEqual(JSON.parse(reportWrite), report);
  assert.equal(Object.hasOwn(report.config, 'requestSamples'), false);
});

test('sample header states redact invalid raw values, enforce cap, and contain observation exceptions', () => {
  const observed = journal();
  const api = benchHelpers({ requestSampleJournal: observed });
  const context = api.requestSampleContext('latency', 'gateway', 0);
  assert.ok(context);
  context.gatewayIndex = 2;
  for (const header of [randomUUID().toUpperCase(), null, 'not-a-uuid-secret']) {
    api.recordRequestSample(
      context,
      { status: 200, headers: new Headers(header ? { 'x-request-id': header } : {}) },
      1.2345,
      true,
      'ok',
    );
  }
  assert.deepEqual(
    observed.samples.map((entry) => entry.requestIdState),
    ['valid', 'missing', 'invalid'],
  );
  assert.equal(observed.samples[0].requestId, observed.samples[0].requestId?.toLowerCase());
  assert.equal(observed.samples[2].requestId, null);
  assert.ok(!JSON.stringify(observed).includes('not-a-uuid-secret'));
  assert.equal(observed.samples[0].gatewayIndex, 2);
  for (const header of [
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-f111-8111-111111111111',
    '11111111-1111-4111-0111-111111111111',
    `${randomUUID()}\n`,
  ]) {
    api.recordRequestSample(context, { status: 200, headers: { get: () => header } }, 1, true, 'ok');
    assert.equal(observed.samples.at(-1)?.requestIdState, 'invalid');
    assert.equal(observed.samples.at(-1)?.requestId, null);
    assert.ok(!JSON.stringify(observed).includes(header));
  }
  const badError = {
    get name() {
      throw new Error('private error');
    },
  };
  assert.equal(api.requestSampleOutcome(badError, undefined, null), 'network_error');
  while (observed.samples.length < 400)
    api.recordRequestSample(context, { status: 200, headers: new Headers() }, 1, true, 'ok');
  api.recordRequestSample(context, { status: 200, headers: new Headers() }, 1, true, 'ok');
  assert.equal(observed.samples.length, 400);
  assert.equal(observed.observationOk, false);
});

test('chosen quantile indices mirror the unchanged floor algorithm, including n100 p99=max', () => {
  const observed = completeJournal();
  const api = benchHelpers({ requestSampleJournal: observed }, ['pct', 'latencySummary']);
  const selections = api.requestSampleSelections(observed.samples);
  const summary = api.latencySummary(
    observed.samples
      .filter((entry) => entry.scenario === 'latency' && entry.leg === 'gateway')
      .map((entry) => entry.metricMs as number),
  );
  assert.equal(selections['latency:gateway'].selected.p50.sampleIndex, 50);
  assert.equal(selections['latency:gateway'].selected.p99.sampleIndex, 99);
  assert.equal(selections['latency:gateway'].selected.max.sampleIndex, 99);
  assert.equal(selections['latency:gateway'].selected.p99.reportedMs, summary.p99);
  assert.equal(summary.p99, summary.max);
  assert.equal(summary.p99, 99.12);
  assert.equal(api.requestSampleCompleteness(observed.samples).complete, true);
  observed.samples[0].index = 1;
  assert.equal(api.requestSampleCompleteness(observed.samples).complete, false);
});

test('TTFB preserves metric/read/cancel ordering and records only after cancellation', async () => {
  const events: string[] = [];
  const observed = journal();
  let ticks = 0;
  const api = benchHelpers(
    {
      requestSampleJournal: observed,
      performance: {
        now() {
          events.push('clock');
          return ticks++ * 7;
        },
      },
    },
    ['measureTtfb'],
  );
  const context = api.requestSampleContext('ttfb', 'gateway', 0);
  assert.ok(context);
  context.gatewayIndex = 0;
  const response = {
    status: 200,
    headers: {
      get() {
        events.push('header');
        return randomUUID();
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            events.push('read');
            return { value: new Uint8Array([1]) };
          },
          async cancel() {
            events.push('cancel');
          },
        };
      },
    },
  };
  const metric = await api.measureTtfb(async () => {
    events.push('request');
    return { response };
  }, context);
  assert.equal(metric, 7);
  assert.deepEqual(events, ['clock', 'request', 'read', 'clock', 'cancel', 'header']);
  assert.equal(observed.samples[0].metricMs, metric);
  assert.equal(observed.samples[0].includedInSummary, true);
  const empty = {
    ...response,
    body: {
      getReader: () => ({
        read: async () => ({ value: new Uint8Array() }),
        cancel: async () => {
          events.push('empty_cancel');
        },
      }),
    },
  };
  await assert.rejects(
    api.measureTtfb(async () => ({ response: empty }), context),
    /empty first chunk/,
  );
  assert.equal(observed.samples[1].outcome, 'empty_chunk');
  assert.equal(observed.samples[1].includedInSummary, false);
});

test('actual measured HTTP helpers retain chosen gateway and exclude warmup requests', async () => {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream: boolean };
    response.writeHead(200, {
      'content-type': body.stream ? 'text/event-stream' : 'application/json',
      'x-request-id': randomUUID(),
    });
    response.end(body.stream ? 'data: {"ok":true}\n\n' : '{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const observed = journal();
    const report = {
      scenarios: {} as Record<string, { direct: { n: number }; gateway: { n: number } }>,
      violations: [],
    };
    const api = benchHelpers(
      {
        requestSampleJournal: observed,
        fetch,
        AbortSignal,
        performance,
        rrIndex: 0,
        report,
        config: {
          protocol: 'anthropic',
          model: 'local',
          maxTokens: 1,
          requests: 2,
          streamSamples: 2,
          warmupInflight: 1,
          p99OverheadMs: 1e6,
          ttfbOverheadMs: 1e6,
          requestTimeoutMs: 1000,
        },
        env: {
          gatewayUrls: [0, 1, 2].map((index) => `${base}/g${index}`),
          proxyKey: 'local-test',
          mockUpstreamUrl: `${base}/direct`,
          mockControlUrl: '',
        },
        async closedLoop(_concurrency: number, _duration: number, worker: (index: number) => Promise<void>) {
          await worker(0);
        },
        violation() {
          assert.fail('local helper should not violate');
        },
      },
      [
        'requestSpec',
        'nextGatewayUrl',
        'postJson',
        'gatewayRequest',
        'mockRequest',
        'pct',
        'latencySummary',
        'scenarioLatency',
        'measureTtfb',
        'scenarioTtfb',
      ],
    );
    await api.scenarioLatency();
    await api.scenarioTtfb();
    assert.equal(requests.length, 10, 'two unrecorded warmups plus eight measured calls');
    assert.equal(observed.samples.length, 8);
    assert.deepEqual(
      observed.samples.filter((entry) => entry.leg === 'gateway').map((entry) => entry.gatewayIndex),
      [1, 2, 1, 2],
    );
    assert.ok(observed.samples.every((entry) => entry.includedInSummary && entry.metricMs !== null));
    assert.ok(
      observed.samples.filter((entry) => entry.leg === 'gateway').every((entry) => entry.requestIdState === 'valid'),
    );
    assert.equal(report.scenarios.latency.direct.n, 2);
    assert.equal(report.scenarios.ttfb.gateway.n, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});

test('latency observes only after body drain and preserves the original drain failure', async () => {
  const observed = journal();
  const events: string[] = [];
  const bodyFailure = new Error('local test drain failed');
  const api = benchHelpers(
    {
      requestSampleJournal: observed,
      env: { mockControlUrl: '', mockUpstreamUrl: '' },
      config: { requests: 1, warmupInflight: 1 },
      async closedLoop() {},
      async gatewayRequest(_stream: boolean, _url: unknown, context: SampleContext) {
        context.gatewayIndex = 2;
        return {
          elapsedMs: 12.345,
          response: {
            status: 200,
            headers: {
              get() {
                events.push('header');
                return randomUUID();
              },
            },
            async text() {
              events.push('drain');
              throw bodyFailure;
            },
          },
        };
      },
    },
    ['scenarioLatency'],
  );
  await assert.rejects(api.scenarioLatency(), (error: unknown) => error === bodyFailure);
  assert.deepEqual(events, ['drain', 'header']);
  assert.equal(observed.samples[0].includedInSummary, false);
  assert.equal(observed.samples[0].metricMs, 12.345);
  assert.equal(observed.samples[0].outcome, 'body_drain_error');
});

test('client journal is a new mode0600 artifact and never overwrites an existing result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r9-samples-write-'));
  try {
    const output = path.join(directory, 'samples.json');
    const observed = completeJournal();
    const api = benchHelpers({ requestSampleJournal: observed, requestSamplesOut: output, writeFileSync });
    api.writeRequestSamples();
    const bytes = readFileSync(output, 'utf8');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const document = JSON.parse(bytes) as {
      observationOk: boolean;
      completeness: { complete: boolean };
      selections: unknown;
    };
    assert.equal(document.observationOk, true);
    assert.equal(document.completeness.complete, true);
    assert.ok(document.selections);
    const retry = benchHelpers({ requestSampleJournal: completeJournal(), requestSamplesOut: output, writeFileSync });
    retry.writeRequestSamples();
    assert.equal(readFileSync(output, 'utf8'), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface StateFacts {
  rows: Record<string, unknown>[];
  observedRowCount: number;
  truncated: boolean;
  missingRequestIds: string[] | null;
  multipleAttemptRequestIds: string[];
  multipleEvidenceRequestIds: string[];
  pendingRequestIds: string[];
}
interface ExportSummary {
  observationOk: boolean;
  failure: { stage: string; sqlState: string | null } | null;
  statesFile: string | null;
}
interface StateApi {
  REQUEST_STATES_SQL: string;
  validateRequestSampleJournal(value: unknown): {
    requestIds: string[];
    complete: boolean;
    correlationComplete: boolean;
    missingRequestIds: number;
    invalidRequestIds: number;
  };
  projectRequestStateRows(rows: unknown[], ids: string[]): StateFacts;
  requestObservationSqlState(error: unknown): string | null;
  exportRequestSampleStates(
    connection: unknown,
    tenantId: string,
    samplesFile: string,
    statesFile: string,
  ): Promise<ExportSummary>;
}
const stateNames = [
  'REQUEST_SAMPLE_UUID',
  'REQUEST_STATES_SQL',
  'requestObservationSqlState',
  'validateRequestSampleJournal',
  'projectRequestStateRows',
  'exportRequestSampleStates',
];
function stateHelpers(): StateApi {
  return loadHelpers<StateApi>(supervisorFile, stateNames, { open, writeFile });
}
function stateRow(id: string): Record<string, unknown> {
  return {
    request_id: id,
    execution_state: 'succeeded',
    financial_status: 'settled',
    reconciliation_state: 'none',
    request_created_at: '2026-10-22 00:00:00+00',
    request_updated_at: '2026-10-22 00:00:01+00',
    attempt_id: randomUUID(),
    ordinal: 1,
    dispatch_state: 'sent',
    result_state: 'succeeded',
    response_started: true,
    result_http_status: 200,
    attempt_created_at: '2026-10-22 00:00:00+00',
    attempt_updated_at: '2026-10-22 00:00:01+00',
    response_started_at: '2026-10-22 00:00:01+00',
    evidence_status: 'claimed',
    evidence_created_at: '2026-10-22 00:00:00+00',
    evidence_claimed_at: '2026-10-22 00:00:00+00',
  };
}

test('state projection separates missing, pending, multiplicity and the bounded 201 sentinel', () => {
  const api = stateHelpers();
  const ids = Array.from({ length: 200 }, () => randomUUID());
  const rows = ids.map(stateRow);
  rows[0].financial_status = 'reconciliation_pending';
  rows[0].execution_state = 'unknown';
  const pending = api.projectRequestStateRows(rows.slice(0, 199), ids);
  assert.equal(pending.missingRequestIds?.[0], ids[199]);
  assert.equal(pending.pendingRequestIds[0], ids[0]);
  assert.equal(pending.truncated, false);
  const duplicateEvidence = api.projectRequestStateRows([rows[0], rows[0]], ids);
  assert.equal(duplicateEvidence.multipleEvidenceRequestIds[0], ids[0]);
  const duplicateAttempt = api.projectRequestStateRows(
    [rows[0], { ...rows[0], attempt_id: randomUUID(), ordinal: 2 }],
    ids,
  );
  assert.equal(duplicateAttempt.multipleAttemptRequestIds[0], ids[0]);
  const truncated = api.projectRequestStateRows([...rows, rows[0]], ids);
  assert.equal(truncated.rows.length, 200);
  assert.equal(truncated.observedRowCount, 201);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.missingRequestIds, null, 'truncation must not counterfeit missing rows');
  assert.throws(() => api.projectRequestStateRows([...rows, rows[0], rows[0]], ids));
});

test('state export uses static tenant/UUID projection after read-only setup and writes safe new artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r9-states-export-'));
  try {
    const api = stateHelpers();
    const observed = completeJournal();
    const ids = api.validateRequestSampleJournal(observed).requestIds;
    const input = path.join(directory, 'samples.json');
    const output = path.join(directory, 'states.json');
    await writeFile(input, JSON.stringify(observed));
    const calls: { sql: string; values?: unknown[] }[] = [];
    let inTransaction = false;
    const connection = {
      async transaction(work: (tx: unknown) => Promise<unknown>) {
        inTransaction = true;
        try {
          return await work({
            async query(sql: string, values?: unknown[]) {
              calls.push({ sql, values });
              assert.equal(inTransaction, true);
              if (calls.length === 1) return { rows: [] };
              return { rows: ids.map((id) => ({ ...stateRow(id), not_projected_secret: 'never-export' })) };
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    };
    const tenantId = randomUUID();
    const result = await api.exportRequestSampleStates(connection, tenantId, input, output);
    assert.equal(result.observationOk, true);
    assert.equal(calls[0].sql, 'SET TRANSACTION READ ONLY');
    assert.equal(calls[1].sql, api.REQUEST_STATES_SQL);
    assert.match(calls[1].sql, /r\.tenant_id = \$1::uuid[\s\S]*r\.id = ANY\(\$2::uuid\[\]\)[\s\S]*LIMIT 201$/);
    assert.ok(!/SELECT\s+\*|FOR UPDATE|FOR SHARE|INSERT|UPDATE\s+saas|DELETE/i.test(calls[1].sql));
    assert.equal(calls[1].values?.[0], tenantId);
    assert.deepEqual(calls[1].values?.[1], ids);
    const bytes = await readFile(output, 'utf8');
    assert.ok(!bytes.includes('never-export'));
    assert.ok(!bytes.includes('not_projected_secret'));
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const document = JSON.parse(bytes) as {
      database: { queryCompleted: boolean; rows: unknown[]; truncated: boolean };
    };
    assert.equal(document.database.queryCompleted, true);
    assert.equal(document.database.rows.length, 200);
    assert.equal(document.database.truncated, false);
    const retry = await api.exportRequestSampleStates(connection, tenantId, input, output);
    assert.equal(retry.observationOk, false);
    assert.equal(retry.failure?.stage, 'request_states_write');
    assert.equal(await readFile(output, 'utf8'), bytes);
    const truncatedOutput = path.join(directory, 'truncated.json');
    const truncatedConnection = {
      async transaction(work: (tx: unknown) => Promise<unknown>) {
        return work({
          async query(sql: string) {
            return { rows: sql === api.REQUEST_STATES_SQL ? [...ids.map(stateRow), stateRow(ids[0])] : [] };
          },
        });
      },
    };
    const truncated = await api.exportRequestSampleStates(truncatedConnection, tenantId, input, truncatedOutput);
    assert.equal(truncated.observationOk, false);
    assert.equal(truncated.failure?.stage, 'request_states_truncated');
    const truncatedDocument = JSON.parse(await readFile(truncatedOutput, 'utf8')) as {
      database: { rows: unknown[]; truncated: boolean; missingRequestIds: unknown };
    };
    assert.equal(truncatedDocument.database.truncated, true);
    assert.equal(truncatedDocument.database.rows.length, 200);
    assert.equal(truncatedDocument.database.missingRequestIds, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('partial/invalid sample IDs remain explicit, unavailable IDs skip SQL, and SQL failures expose only fixed stage/state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r9-states-errors-'));
  try {
    const api = stateHelpers();
    const observed = completeJournal();
    const missing = observed.samples.find((entry) => entry.leg === 'gateway');
    assert.ok(missing);
    missing.requestId = null;
    missing.requestIdState = 'missing';
    const invalid = observed.samples.find((entry) => entry.leg === 'gateway' && entry.index === 1);
    assert.ok(invalid);
    invalid.requestId = null;
    invalid.requestIdState = 'invalid';
    const facts = api.validateRequestSampleJournal(observed);
    assert.equal(facts.complete, true);
    assert.equal(facts.correlationComplete, false);
    assert.equal(facts.requestIds.length, 198);
    assert.equal(facts.missingRequestIds, 1);
    assert.equal(facts.invalidRequestIds, 1);
    const input = path.join(directory, 'samples.json');
    await writeFile(input, JSON.stringify(observed));
    const output = path.join(directory, 'states-error.json');
    const connection = {
      async transaction() {
        throw Object.assign(new Error('sensitive query/body failure'), { code: '42501' });
      },
    };
    const result = await api.exportRequestSampleStates(connection, randomUUID(), input, output);
    assert.equal(result.observationOk, false);
    assert.equal(result.failure?.stage, 'request_states_query');
    assert.equal(result.failure?.sqlState, '42501');
    assert.ok(!(await readFile(output, 'utf8')).includes('sensitive'));
    assert.equal(api.requestObservationSqlState({ code: 'private-value' }), null);
    assert.equal(
      api.requestObservationSqlState({
        get code() {
          throw new Error('not accessed');
        },
      }),
      null,
    );
    const unavailable = { ...journal(), samples: [sample('latency', 'direct', 0)] };
    await writeFile(input, JSON.stringify(unavailable));
    let queries = 0;
    const noQueries = {
      async transaction() {
        queries++;
        throw new Error('must not query');
      },
    };
    const noIdsOutput = path.join(directory, 'no-ids.json');
    const noIds = await api.exportRequestSampleStates(noQueries, randomUUID(), input, noIdsOutput);
    assert.equal(noIds.observationOk, false);
    assert.equal(queries, 0);
    const noIdsDocument = JSON.parse(await readFile(noIdsOutput, 'utf8')) as {
      database: { queryAttempted: boolean; missingRequestIds: unknown };
    };
    assert.equal(noIdsDocument.database.queryAttempted, false);
    assert.equal(noIdsDocument.database.missingRequestIds, null);
    observed.samples.push(sample('latency', 'direct', 0));
    assert.throws(() => api.validateRequestSampleJournal(observed));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('supervisor export occurs after all measurements and before the unchanged owned cleanup', () => {
  const source = readFileSync(supervisorFile, 'utf8');
  const finalCleanup = source.lastIndexOf('await closeOwned();');
  const exportCall = source.lastIndexOf('manifest.requestSamples = await exportRequestSampleStates(');
  const lastMeasurement = source.lastIndexOf('if (options.serialProfile && (manifest.metrics.length');
  assert.ok(lastMeasurement < exportCall && exportCall < finalCleanup);
  const finalBlock = source.slice(exportCall, finalCleanup);
  assert.match(finalBlock, /catch\s*\{/);
  assert.match(finalBlock, /observation_internal/);
  assert.ok(
    !source.slice(source.lastIndexOf('manifest.ok =')).includes('requestSamples'),
    'sample completeness is reported separately from performance gate',
  );
});
