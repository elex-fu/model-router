import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer, request as httpRequest, type ClientRequest, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { SaasDatabaseClient, SaasDatabasePool, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { observeProviderJsonUsage } from '../../../src/saas/gateway/provider-json-usage-observer.js';
import { observeProviderSseUsage } from '../../../src/saas/gateway/provider-sse-usage-observer.js';
import {
  createDelegatedSqlFault, createFinancialNetworkFaultFixture,
  FinancialFaultFixtureError, INVALID_JSON_USAGE_VARIANTS,
  type DelegatedSqlFaultPlan, type FinancialNetworkScenario,
} from './commercial-gateway-financial-fault-fixture.js';

// These are helper/socket and delegation unit tests, NOT managed gateway,
// restricted-role SQL, billing, or PostgreSQL financial acceptance evidence.
const protocol = { providerProtocol: 'openai', providerOperation: 'chat.completions' } as const;
const endpoint = '/v1/chat/completions';

function bounded<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Helper test wait exceeded its bound')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function fixtureCode(code: FinancialFaultFixtureError['code']) {
  return (error: unknown) => error instanceof FinancialFaultFixtureError && error.code === code;
}

function payload(scenario: FinancialNetworkScenario, stream: boolean) {
  return { model: 'financial-fixture-model', stream, messages: [{ role: 'user', content: scenario.prompt }] };
}

async function localHarness(t: TestContext, options: Parameters<typeof createFinancialNetworkFaultFixture>[0] = {}) {
  const fixture = createFinancialNetworkFaultFixture(options);
  const sockets = new Set<Socket>();
  // The helper is TLS-agnostic Node request/response code, ready for the
  // existing HTTPS fixture. These unit tests use only a real loopback HTTP
  // socket, without changing any production TLS policy or test certificate.
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 16_384) throw new Error('Helper test request exceeds its bound');
        chunks.push(buffer);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.method !== 'POST' || request.url !== endpoint) {
        response.writeHead(404).end();
        return;
      }
      if (fixture.handle(request, response, body)) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'original-happy-fixture', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'original-happy-fixture' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    })().catch(() => response.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    let fixtureError: unknown;
    try { await fixture.dispose(); } catch (error) { fixtureError = error; }
    finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
    if (fixtureError) throw fixtureError;
  });
  await bounded(new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}${endpoint}`;
  const post = (body: unknown, signal: AbortSignal = AbortSignal.timeout(2_000)) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  return { fixture, post, url };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const next = await bounded(reader.read());
      if (next.done) return Buffer.concat(chunks);
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
}

function pendingClient(url: string, body: unknown): {
  readonly request: ClientRequest;
  readonly closed: Promise<void>;
  readonly observed: { responses: number; errors: number };
} {
  const observed = { responses: 0, errors: 0 };
  const request = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const closed = new Promise<void>((resolve) => request.once('close', resolve));
  request.on('error', () => { observed.errors += 1; });
  request.on('response', (response) => {
    observed.responses += 1;
    response.on('error', () => { observed.errors += 1; });
    response.resume();
  });
  request.end(JSON.stringify(body));
  return { request, closed, observed };
}

test('network helper leaves unmatched happy traffic untouched and exposes no payload/header observations', { timeout: 10_000 }, async (t) => {
  const { fixture, post } = await localHarness(t);
  const scenario = fixture.register({ kind: 'json_missing_usage' }, 'scoped-nonce');
  for (const body of [
    { model: 'fixture', stream: false, messages: [{ role: 'user', content: 'ordinary prompt' }] },
    { model: 'fixture', stream: false, messages: [{ role: 'assistant', content: scenario.prompt }] },
    { model: 'fixture', stream: false, messages: [{ role: 'user', content: 'financial-fault:unknown-nonce' }] },
    { model: 'fixture', stream: false, messages: [{ role: 'user', content: `${scenario.prompt} extra` }] },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { id: string }).id, 'original-happy-fixture');
  }
  assert.equal(scenario.snapshot().receipts, 0);
  assert.equal(scenario.snapshot().activeResponses, 0);
  assert.equal(Object.keys(scenario.snapshot()).some((key) => /payload|authorization|headers_value|secret/.test(key)), false);
  assert.equal(Object.isFrozen(scenario.snapshot()), true);
});

test('missing usage script reaches real response EOF and the production observer keeps usage unknown', { timeout: 10_000 }, async (t) => {
  const { fixture, post } = await localHarness(t);
  const scenario = fixture.register({ kind: 'json_missing_usage' });
  const controller = new AbortController();
  const receipt = scenario.waitFor('receipt', { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const response = await post(payload(scenario, false));
  await receipt;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const observed = observeProviderJsonUsage(response.body, protocol);
  const bytes = await readBody(observed.body);
  const parsed = JSON.parse(bytes.toString('utf8')) as { object: string; usage?: unknown; choices: { finish_reason: string }[] };
  assert.equal(parsed.object, 'chat.completion');
  assert.equal(parsed.choices[0]?.finish_reason, 'stop');
  assert.equal(Object.hasOwn(parsed, 'usage'), false);
  assert.deepEqual(await bounded(observed.observation), { state: 'unknown', usage: null, reason: 'no_usage' });
  await scenario.waitFor('eof');
  await scenario.waitFor('close');
  const stats = scenario.snapshot();
  assert.equal(stats.receipts, 1);
  assert.equal(stats.headers, 1);
  assert.equal(stats.eofs, 1);
  assert.equal(stats.closes, 1);
  assert.equal(stats.peerCancellations, 0);
  assert.equal(stats.activeResponses, 0);
  assert.equal(stats.watchdogCloses + stats.cleanupCloses + stats.writeErrors, 0);
  assert.equal(stats.bytesWritten, bytes.length);
});

test('every invalid usage script is complete real JSON but never a reported production observation', { timeout: 20_000 }, async (t) => {
  const { fixture, post } = await localHarness(t);
  for (const variant of INVALID_JSON_USAGE_VARIANTS) {
    await t.test(variant, async () => {
      const scenario = fixture.register({ kind: 'json_invalid_usage', variant });
      const response = await post(payload(scenario, false));
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const observed = observeProviderJsonUsage(response.body, protocol);
      const bytes = await readBody(observed.body);
      assert.equal((JSON.parse(bytes.toString('utf8')) as { object: string }).object, 'chat.completion');
      assert.deepEqual(await bounded(observed.observation), {
        state: 'unknown', usage: null, reason: variant === 'duplicate_usage' ? 'malformed_body' : 'invalid_usage',
      });
      await scenario.waitFor('eof');
      await scenario.waitFor('close');
      const stats = scenario.snapshot();
      assert.equal(stats.eofs, 1);
      assert.equal(stats.peerCancellations, 0);
      assert.equal(stats.watchdogCloses + stats.cleanupCloses + stats.writeErrors, 0);
      assert.equal(stats.activeResponses, 0);
      await scenario.dispose();
    });
  }
});

test('partial SSE publishes one real chunk then peer cancellation, never usage or EOF', { timeout: 10_000 }, async (t) => {
  const { fixture, post } = await localHarness(t);
  const scenario = fixture.register({ kind: 'sse_partial_cancel' });
  const response = await post(payload(scenario, true));
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const observed = observeProviderSseUsage(response.body, protocol);
  const reader = observed.body.getReader();
  try {
    const first = await bounded(reader.read());
    assert.equal(first.done, false);
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /financial-fault-first-chunk/);
    assert.equal(text.includes('[DONE]') || text.includes('"usage"'), false);
    assert.equal(observed.getObservation(), null);
    await scenario.waitFor('first_chunk');
    await bounded(reader.cancel());
  } finally { reader.releaseLock(); }
  assert.deepEqual(await bounded(observed.observation), { state: 'unknown', usage: null, reason: 'cancelled' });
  await scenario.waitFor('close');
  const stats = scenario.snapshot();
  assert.equal(stats.receipts, 1);
  assert.equal(stats.headers, 1);
  assert.equal(stats.firstChunks, 1);
  assert.equal(stats.eofs, 0);
  assert.equal(stats.peerCancellations, 1);
  assert.equal(stats.activeResponses, 0);
  assert.equal(stats.watchdogCloses + stats.cleanupCloses + stats.writeErrors, 0);
});

test('pre-header cancellation has an actual receipt and peer close without headers/body/EOF', { timeout: 10_000 }, async (t) => {
  const { fixture, url } = await localHarness(t);
  for (const stream of [false, true]) {
    const scenario = fixture.register({ kind: 'before_headers_cancel' });
    const client = pendingClient(url, payload(scenario, stream));
    t.after(() => client.request.destroy());
    await scenario.waitFor('receipt');
    client.request.destroy();
    await bounded(client.closed);
    await scenario.waitFor('close');
    assert.equal(client.observed.responses, 0);
    const stats = scenario.snapshot();
    assert.equal(stats.receipts, 1);
    assert.equal(stats.headers + stats.firstChunks + stats.eofs + stats.bytesWritten, 0);
    assert.equal(stats.peerCancellations, 1);
    assert.equal(stats.activeResponses, 0);
    assert.equal(stats.watchdogCloses + stats.cleanupCloses + stats.writeErrors, 0);
    await scenario.dispose();
  }
});

test('watchdog close is bounded and cannot masquerade as client cancellation or EOF', { timeout: 10_000 }, async (t) => {
  const { fixture, url } = await localHarness(t, { responseTimeoutMs: 100 });
  const scenario = fixture.register({ kind: 'before_headers_cancel' });
  const client = pendingClient(url, payload(scenario, true));
  t.after(() => client.request.destroy());
  await scenario.waitFor('receipt');
  await scenario.waitFor('close');
  await bounded(client.closed);
  const stats = scenario.snapshot();
  assert.equal(stats.watchdogCloses, 1);
  assert.equal(stats.cleanupCloses + stats.peerCancellations + stats.eofs + stats.headers, 0);
  assert.equal(stats.activeResponses, 0);
});

test('cleanup rejects unfinished barriers, closes actual sockets, and is idempotent', { timeout: 10_000 }, async (t) => {
  const { fixture, url } = await localHarness(t);
  const scenario = fixture.register({ kind: 'before_headers_cancel' });
  const client = pendingClient(url, payload(scenario, false));
  t.after(() => client.request.destroy());
  await scenario.waitFor('receipt');
  const incomplete = assert.rejects(scenario.waitFor('eof'), fixtureCode('FIXTURE_DISPOSED'));
  const disposal = scenario.dispose();
  assert.strictEqual(scenario.dispose(), disposal);
  await disposal;
  await incomplete;
  await bounded(client.closed);
  await scenario.waitFor('close');
  const stats = scenario.snapshot();
  assert.equal(stats.cleanupCloses, 1);
  assert.equal(stats.closes, 1);
  assert.equal(stats.peerCancellations + stats.watchdogCloses + stats.eofs, 0);
  assert.equal(stats.activeResponses + stats.pendingWaits, 0);
  assert.equal(stats.disposed, true);
  const allDisposal = fixture.dispose();
  assert.strictEqual(fixture.dispose(), allDisposal);
  await allDisposal;
  assert.throws(() => fixture.register({ kind: 'json_missing_usage' }), fixtureCode('FIXTURE_DISPOSED'));
});

test('barrier timeout/abort/configuration paths all remove their timers and listeners', { timeout: 10_000 }, async (t) => {
  const fixture = createFinancialNetworkFaultFixture();
  t.after(() => fixture.dispose());
  const scenario = fixture.register({ kind: 'json_missing_usage' }, 'bounded-wait');
  await assert.rejects(scenario.waitFor('receipt', { timeoutMs: 10 }), fixtureCode('WAIT_TIMEOUT'));
  assert.equal(scenario.snapshot().pendingWaits, 0);
  const controller = new AbortController();
  const aborted = assert.rejects(scenario.waitFor('receipt', { signal: controller.signal }), fixtureCode('WAIT_ABORTED'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await aborted;
  await assert.rejects(scenario.waitFor('receipt', { signal: controller.signal }), fixtureCode('WAIT_ABORTED'));
  assert.equal(scenario.snapshot().pendingWaits, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.throws(() => scenario.waitFor('receipt', { timeoutMs: 0 }), fixtureCode('INVALID_CONFIGURATION'));
  assert.throws(() => scenario.waitFor('receipt', { count: 0 }), fixtureCode('INVALID_CONFIGURATION'));
  assert.throws(() => fixture.register({ kind: 'json_missing_usage' }, 'bounded-wait'), fixtureCode('DUPLICATE_NONCE'));
  assert.throws(() => fixture.register({ kind: 'json_missing_usage' }, 'contains spaces'), fixtureCode('INVALID_CONFIGURATION'));
  assert.throws(() => createFinancialNetworkFaultFixture({ responseTimeoutMs: 60_001 }), fixtureCode('INVALID_CONFIGURATION'));
  const disposalController = new AbortController();
  const disposedWait = assert.rejects(scenario.waitFor('eof', { signal: disposalController.signal }), fixtureCode('FIXTURE_DISPOSED'));
  assert.equal(getEventListeners(disposalController.signal, 'abort').length, 1);
  await scenario.dispose();
  await disposedWait;
  assert.equal(getEventListeners(disposalController.signal, 'abort').length, 0);
  await assert.rejects(scenario.waitFor('receipt'), fixtureCode('FIXTURE_DISPOSED'));
});

test('repeated network receipts remain countable and ambiguous/script-mode routing fails closed', { timeout: 10_000 }, async (t) => {
  const { fixture, post } = await localHarness(t);
  const first = fixture.register({ kind: 'json_missing_usage' }, 'first');
  const second = fixture.register({ kind: 'json_missing_usage' }, 'second');
  for (let index = 0; index < 2; index += 1) {
    await (await post(payload(first, false))).text();
  }
  await first.waitFor('receipt', { count: 2 });
  await first.waitFor('close', { count: 2 });
  assert.equal(first.snapshot().eofs, 2);
  const ambiguous = await post({
    stream: false, messages: [{ role: 'user', content: first.prompt }, { role: 'user', content: second.prompt }],
  });
  assert.equal(ambiguous.status, 400);
  await ambiguous.text();
  assert.equal(first.snapshot().receipts, 2);
  assert.equal(second.snapshot().receipts, 0);
  const mismatch = await post(payload(second, true));
  assert.equal(mismatch.status, 400);
  await mismatch.text();
  await second.waitFor('close');
  assert.equal(second.snapshot().protocolMismatches, 1);
});

// Opaque recording doubles below test helper delegation only. They do not
// emulate a ledger, database transaction, managed role, or financial result.
const nativeResult = Object.freeze({ rows: [{ marker: 'delegate-owned-row' }], rowCount: 1 });
const controlResult = Object.freeze({ rows: [], rowCount: 0 });
const writeSql = 'INSERT INTO helper_unit_table (scope) VALUES ($1)';
const scope = Object.freeze(['test-owned-scope']);

function recordingExecutor(behavior?: (sql: string, values: readonly unknown[] | undefined) => Promise<SqlResult<unknown>>) {
  const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
  const executor: SqlExecutor = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      calls.push({ sql, values });
      const result = behavior ? await behavior(sql, values) : /^(BEGIN|COMMIT|ROLLBACK)/.test(sql) ? controlResult : nativeResult;
      return result as SqlResult<Row>;
    },
  };
  return { executor, calls };
}

function faultPlan(point: DelegatedSqlFaultPlan['point'], sentinel: Error): DelegatedSqlFaultPlan {
  return {
    point, sentinel, expectedRowCount: 1,
    matchesWrite: (sql, values) => sql === writeSql && values?.[0] === scope[0],
  };
}

test('SQL helper preserves SQL/values/native result identity and injects the original sentinel once after a real delegated write', { timeout: 5_000 }, async () => {
  const native = recordingExecutor();
  const sentinel = new Error('after-write-sentinel');
  const fault = createDelegatedSqlFault(faultPlan('after_successful_write', sentinel));
  const wrapped = fault.wrapExecutor(native.executor);
  const foreignScope = Object.freeze(['another-scope']);
  assert.strictEqual(await wrapped.query(writeSql, foreignScope), nativeResult);
  await assert.rejects(wrapped.query(writeSql, scope), (error) => error === sentinel);
  assert.deepEqual(fault.snapshot(), {
    successfulMatchedWrites: 1, successfulMatchedCommits: 0, injections: 1, injectedAt: 'after_successful_write',
  });
  assert.strictEqual(native.calls[1]?.values, scope);
  assert.equal(native.calls[1]?.sql, writeSql);
  assert.strictEqual(await wrapped.query(writeSql, scope), nativeResult);
  assert.strictEqual(await wrapped.query('ROLLBACK'), controlResult);
  assert.equal(fault.snapshot().injections, 1);
  assert.equal(Object.hasOwn(sentinel, 'code'), false, 'helper must not manufacture SQLSTATE');
  fault.assertInjected();
});

test('zero/unexpected/null rowCount and SELECT do not arm SQL faults; delegate errors remain untouched', { timeout: 5_000 }, async () => {
  for (const rowCount of [0, 2, null]) {
    const result = { rows: [], rowCount };
    const native = recordingExecutor(async () => result);
    const fault = createDelegatedSqlFault(faultPlan('before_commit', new Error('unused-sentinel')));
    const wrapped = fault.wrapExecutor(native.executor);
    assert.strictEqual(await wrapped.query(writeSql, scope), result);
    assert.strictEqual(await wrapped.query('COMMIT'), result);
    assert.equal(fault.snapshot().injections, 0);
    assert.throws(() => fault.assertInjected(), fixtureCode('FAULT_NOT_INJECTED'));
  }
  const native = recordingExecutor();
  const readFault = createDelegatedSqlFault({ ...faultPlan('after_successful_write', new Error('unused')), matchesWrite: () => true });
  assert.strictEqual(await readFault.wrapExecutor(native.executor).query('SELECT 1'), nativeResult);
  assert.equal(readFault.snapshot().successfulMatchedWrites, 0);
  const delegateFailure = new Error('delegate-error-without-invented-SQLSTATE');
  const failed = recordingExecutor(async () => { throw delegateFailure; });
  const fault = createDelegatedSqlFault(faultPlan('after_successful_write', new Error('must-not-replace-delegate-error')));
  await assert.rejects(fault.wrapExecutor(failed.executor).query(writeSql, scope), (error) => error === delegateFailure);
  assert.equal(fault.snapshot().successfulMatchedWrites + fault.snapshot().injections, 0);
});

test('before-COMMIT fault requires two successful writes in the same transaction and never sends that COMMIT', { timeout: 5_000 }, async () => {
  const native = recordingExecutor();
  const sentinel = new Error('before-commit-sentinel');
  const fault = createDelegatedSqlFault({ ...faultPlan('before_commit', sentinel), successfulWritesRequired: 2 });
  const wrapped = fault.wrapExecutor(native.executor);
  await wrapped.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await wrapped.query(writeSql, scope);
  await wrapped.query('COMMIT');
  await wrapped.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await wrapped.query(writeSql, scope);
  assert.equal(fault.snapshot().injections, 0, 'writes from separate transactions cannot arm one fault');
  await wrapped.query(writeSql, scope);
  await assert.rejects(wrapped.query('COMMIT'), (error) => error === sentinel);
  assert.equal(native.calls.filter((call) => call.sql === 'COMMIT').length, 1);
  assert.strictEqual(await wrapped.query('ROLLBACK'), controlResult);
  assert.equal(fault.snapshot().successfulMatchedCommits, 0);
  assert.equal(fault.snapshot().injections, 1);
});

test('after-COMMIT fault awaits successful native COMMIT; a native COMMIT failure is not replaced', { timeout: 5_000 }, async () => {
  let finishCommit!: (result: SqlResult<unknown>) => void;
  const commit = new Promise<SqlResult<unknown>>((resolve) => { finishCommit = resolve; });
  const native = recordingExecutor(async (sql) => sql === 'COMMIT' ? commit : nativeResult);
  const sentinel = new Error('lost-commit-ack-sentinel');
  const fault = createDelegatedSqlFault(faultPlan('after_commit', sentinel));
  const wrapped = fault.wrapExecutor(native.executor);
  await wrapped.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await wrapped.query(writeSql, scope);
  const rejection = assert.rejects(wrapped.query('COMMIT'), (error) => error === sentinel);
  assert.equal(native.calls.at(-1)?.sql, 'COMMIT');
  assert.equal(fault.snapshot().successfulMatchedCommits + fault.snapshot().injections, 0);
  finishCommit(controlResult);
  await rejection;
  assert.equal(fault.snapshot().successfulMatchedCommits, 1);
  assert.equal(fault.snapshot().injections, 1);

  const delegateFailure = new Error('native-commit-error-without-invented-SQLSTATE');
  const failed = recordingExecutor(async (sql) => {
    if (sql === 'COMMIT') throw delegateFailure;
    return nativeResult;
  });
  const untouched = createDelegatedSqlFault(faultPlan('after_commit', sentinel));
  const failedWrapped = untouched.wrapExecutor(failed.executor);
  await failedWrapped.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await failedWrapped.query(writeSql, scope);
  await assert.rejects(failedWrapped.query('COMMIT'), (error) => error === delegateFailure);
  assert.equal(untouched.snapshot().successfulMatchedCommits + untouched.snapshot().injections, 0);
});

test('pool wrapper leaves pooled queries alone, shares only one injection, and discards a lost-ACK client', { timeout: 5_000 }, async () => {
  const native = recordingExecutor();
  const releases: (Error | boolean | undefined)[] = [];
  let endings = 0;
  const pool: SaasDatabasePool = {
    query: native.executor.query,
    connect: async (): Promise<SaasDatabaseClient> => ({
      query: native.executor.query, release: (error) => { releases.push(error); },
    }),
    end: async () => { endings += 1; },
  };
  const sentinel = new Error('one-lost-ack');
  const fault = createDelegatedSqlFault(faultPlan('after_commit', sentinel));
  const wrappedPool = fault.wrapPool(pool);
  assert.strictEqual(await wrappedPool.query(writeSql, scope), nativeResult);
  assert.equal(fault.snapshot().successfulMatchedWrites, 0);
  const first = await wrappedPool.connect();
  await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await first.query(writeSql, scope);
  await assert.rejects(first.query('COMMIT'), (error) => error === sentinel);
  first.release(false);
  assert.deepEqual(releases, [true]);
  const second = await wrappedPool.connect();
  await second.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await second.query(writeSql, scope);
  assert.strictEqual(await second.query('COMMIT'), controlResult);
  const releaseError = new Error('original-release-error');
  second.release(releaseError);
  assert.strictEqual(releases[1], releaseError);
  assert.equal(fault.snapshot().injections, 1);
  await wrappedPool.end();
  assert.equal(endings, 1);
});

test('SQL fault thresholds cannot combine writes from two clients or a rolled-back transaction', { timeout: 5_000 }, async () => {
  const native = recordingExecutor();
  const fault = createDelegatedSqlFault({
    ...faultPlan('before_commit', new Error('not-reached')), successfulWritesRequired: 2,
  });
  const first = fault.wrapExecutor(native.executor);
  const second = fault.wrapExecutor(native.executor);
  await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await second.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await first.query(writeSql, scope);
  await second.query(writeSql, scope);
  await first.query('COMMIT');
  await second.query('ROLLBACK');
  await second.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await second.query(writeSql, scope);
  await second.query('COMMIT');
  assert.equal(fault.snapshot().successfulMatchedWrites, 3);
  assert.equal(fault.snapshot().injections, 0);
  assert.throws(() => createDelegatedSqlFault({ ...faultPlan('before_commit', new Error('invalid')), expectedRowCount: 0 }),
    fixtureCode('INVALID_CONFIGURATION'));
  assert.throws(() => createDelegatedSqlFault({ ...faultPlan('before_commit', new Error('invalid')), successfulWritesRequired: 0 }),
    fixtureCode('INVALID_CONFIGURATION'));
});

test('a delegate error disarms the transaction instead of inventing a successful COMMIT acknowledgement loss', { timeout: 5_000 }, async () => {
  const delegateFailure = new Error('original-statement-error');
  const native = recordingExecutor(async (sql) => {
    if (sql === 'SELECT failing_statement') throw delegateFailure;
    return sql === 'COMMIT' ? controlResult : nativeResult;
  });
  const fault = createDelegatedSqlFault(faultPlan('after_commit', new Error('must-not-inject')));
  const wrapped = fault.wrapExecutor(native.executor);
  await wrapped.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await wrapped.query(writeSql, scope);
  await assert.rejects(wrapped.query('SELECT failing_statement'), (error) => error === delegateFailure);
  assert.strictEqual(await wrapped.query('COMMIT'), controlResult);
  assert.equal(fault.snapshot().successfulMatchedWrites, 1);
  assert.equal(fault.snapshot().successfulMatchedCommits + fault.snapshot().injections, 0);
});

test('autocommit writes and a failed BEGIN cannot masquerade as one committed matched-write transaction', { timeout: 5_000 }, async () => {
  for (const point of ['before_commit', 'after_commit', 'after_successful_write'] as const) {
    const native = recordingExecutor();
    const fault = createDelegatedSqlFault({
      ...faultPlan(point, new Error('must-not-inject')), successfulWritesRequired: 2,
    });
    const wrapped = fault.wrapExecutor(native.executor);
    await wrapped.query(writeSql, scope);
    await wrapped.query(writeSql, scope);
    assert.strictEqual(await wrapped.query('COMMIT'), controlResult);
    assert.equal(fault.snapshot().successfulMatchedWrites, 2);
    assert.equal(fault.snapshot().successfulMatchedCommits + fault.snapshot().injections, 0);
    assert.throws(() => fault.assertInjected(), fixtureCode('FAULT_NOT_INJECTED'));
  }
  const beginFailure = new Error('original-begin-error');
  const native = recordingExecutor(async (sql) => {
    if (sql.startsWith('BEGIN')) throw beginFailure;
    return sql === 'COMMIT' ? controlResult : nativeResult;
  });
  const fault = createDelegatedSqlFault(faultPlan('after_commit', new Error('must-not-inject')));
  const wrapped = fault.wrapExecutor(native.executor);
  await assert.rejects(wrapped.query('BEGIN ISOLATION LEVEL READ COMMITTED'), (error) => error === beginFailure);
  await wrapped.query(writeSql, scope);
  assert.strictEqual(await wrapped.query('COMMIT'), controlResult);
  assert.equal(fault.snapshot().successfulMatchedCommits + fault.snapshot().injections, 0);
});
