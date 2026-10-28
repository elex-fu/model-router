import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Dispatcher } from 'undici';
import {
  FastGatewayExecutionError,
  FastGatewayExecutor,
  type FastGatewayExecutorOptions,
  type FastIntentInput,
  type FastReceiptInput,
} from '../../../../src/saas/gateway/fast/executor.js';
import { fastJournalCanonicalJson } from '../../../../src/saas/gateway/fast/journal.js';
import { getPreparedFastReceipt } from '../../../../src/saas/gateway/fast/prepared-receipt.js';
import { FastReceiptQueue } from '../../../../src/saas/gateway/fast/receipt-queue.js';
import type { FastAdmissionFeedback } from '../../../../src/saas/gateway/fast/redis-admission.js';
import { CachedFastGatewaySnapshots } from '../../../../src/saas/gateway/fast/snapshots.js';
import type { PreparedEvidenceClientStream } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import {
  RequestDiagnosticTrace,
  withRequestDiagnosticTrace,
} from '../../../../src/saas/gateway/request-diagnostic-trace.js';
import { fastExecutorFixture } from './executor-fixture.js';
import { priceFixture } from './journal-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function setup(overrides: Partial<FastGatewayExecutorOptions> = {}, sse = false, paid = false) {
  const { snapshot, input: auth } = fastExecutorFixture('tenant-a', Date.now(), paid);
  const calls: string[] = [];
  const receipts: FastReceiptInput[] = [];
  const intents: FastIntentInput[] = [];
  const compiledBodies: Record<string, unknown>[] = [];
  const chunks: Buffer[] = [];
  let ended = false;
  const controller = new AbortController();
  const client: PreparedEvidenceClientStream = {
    signal: controller.signal,
    start() {
      calls.push('headers');
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end() {
      ended = true;
      calls.push('end');
    },
    abort() {
      controller.abort();
    },
  };
  const body = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: sse };
  const options: FastGatewayExecutorOptions = {
    snapshots: { resolve: async () => snapshot },
    admission: {
      acquire: async () => {
        calls.push('admit');
        return {
          allowed: true,
          lease: {
            fencingToken: 'lease-a',
            renewIntervalMs: 1000,
            assertValid: async () => true,
            renew: async () => {},
            release: async () => {
              calls.push('release');
            },
          },
        };
      },
    },
    journal: {
      reserveIntent: async (i) => {
        intents.push(i);
        calls.push('intent');
        return { kind: 'created', intent: { id: 'intent-a' } };
      },
      appendReceipt: async (r) => {
        receipts.push(r);
        calls.push('receipt');
      },
    },
    payload: () => ({
      compile: async (input) => {
        compiledBodies.push(input.clientRequest as Record<string, unknown>);
        return {
          decision: 'allow',
          value: {
            payloadBytes: Buffer.from(JSON.stringify(input.clientRequest)),
            requestFingerprint: 'fingerprint',
            requestFingerprintVersion: 'v1',
            compilerVersion: 'test/v1',
            estimatorVersion: 'bound/v1',
            requestedModel: 'model-a',
            mappedModel: 'model-a',
            resolvedModel: 'model-a',
            modelResolution: {
              requestedModel: 'model-a',
              mappedModel: 'model-a',
              resolvedModel: 'model-a',
              mappingSource: 'none',
              mappingVersion: null,
            },
            providerProtocol: 'openai',
            providerOperation: 'chat.completions',
            usage: {
              inputTotalUpperBound: 80,
              inputUncachedUpperBound: 80,
              cacheReadUpperBound: 80,
              cacheWriteUpperBound: 80,
              cacheWrite5mUpperBound: 80,
              cacheWrite1hUpperBound: 80,
              outputTotalUpperBound: 64,
              reasoningOutputUpperBound: 64,
              feasibleInputBuckets: ['input'],
            },
          },
        };
      },
    }),
    transport: {
      fetch: async (_url, init) => {
        calls.push('fetch');
        const outbound = JSON.parse(Buffer.from(init?.body as Uint8Array).toString());
        if (sse) assert.equal(outbound.stream_options.include_usage, true);
        return new Response(
          sse
            ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n'
            : JSON.stringify({
                id: 'reply',
                object: 'chat.completion',
                choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              }),
          { headers: { 'content-type': sse ? 'Text/Event-Stream; charset=utf-8' : 'application/json' } },
        );
      },
      resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/chat/completions' }),
      resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
      createConnector: () => ({ dispatcher: {} as Dispatcher, close: async () => {}, destroy: async () => {} }),
      endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
      timeoutMs: 1000,
    },
    unsealer: { withCredential: async (_i, callback) => callback(Buffer.from(randomBytes(12).toString('hex'))) },
    allocationOwner: 'owner-a',
    timeoutMs: 1000,
    ...overrides,
  };
  assert.ok(auth.clientAddress);
  const executeInput = {
    requestId: 'request-a',
    authenticatedCaller: auth.authenticatedCaller,
    path: '/v1/chat/completions',
    publicModel: 'model-a',
    protocol: 'openai',
    body,
    clientAddress: auth.clientAddress,
    client,
    selected: (mode: string) => calls.push(mode),
  };
  return {
    executor: new FastGatewayExecutor(options),
    options,
    input: executeInput,
    calls,
    receipts,
    intents,
    compiledBodies,
    snapshot,
    text: () => Buffer.concat(chunks).toString(),
    ended: () => ended,
    controller,
  };
}
test('native engine sends after durable intent and completes after durable receipt', async () => {
  const s = setup();
  assert.equal(await s.executor.execute(s.input), true);
  assert.ok(s.calls.indexOf('intent') < s.calls.indexOf('fetch'));
  assert.ok(s.calls.indexOf('receipt') < s.calls.indexOf('end'));
  assert.equal(s.receipts[0].outcome, 'succeeded');
  assert.equal(s.receipts[0].usage.inputTotal, '10');
  assert.equal(s.receipts[0].chargeMinorUnits, '0');
  assert.ok(getPreparedFastReceipt(s.receipts[0]), 'durable BYOK path uses owned preparation');
  assert.equal(s.receipts[0].verification, undefined);
  assert.ok(s.ended());
});
test('paid pricing proof is the identical deeply frozen intent snapshot across async mutation', async () => {
  const s = setup({}, false, true);
  const originalPrice = s.snapshot.candidates[0].customerPrice;
  assert.ok(originalPrice);
  const originalInputRate = originalPrice.rates.input;
  assert.ok(originalInputRate);
  const expectedPrice = JSON.parse(fastJournalCanonicalJson(originalPrice));
  const executor = new FastGatewayExecutor({
    ...s.options,
    payload: (candidate) => ({
      compile: async (input) => {
        // A snapshot provider reusing objects must not reprice an admitted call.
        Object.assign(originalInputRate, { numeratorMinorUnits: '50' });
        return s.options.payload(candidate).compile(input);
      },
    }),
    journal: {
      ...s.options.journal,
      reserveIntent: async (input) => {
        assert.ok(Object.isFrozen(input.priceSnapshot));
        const proof = input.priceSnapshot as { customerPrice: typeof originalPrice };
        assert.ok(Object.isFrozen(proof.customerPrice));
        const frozenInputRate = proof.customerPrice.rates.input;
        assert.ok(frozenInputRate);
        assert.ok(Object.isFrozen(frozenInputRate));
        assert.throws(() => Object.assign(frozenInputRate, { numeratorMinorUnits: '100' }));
        return s.options.journal.reserveIntent(input);
      },
    },
  });
  assert.equal(await executor.execute(s.input), true);
  assert.equal(s.intents[0].maxCostMinorUnits, '144');
  assert.equal(s.receipts[0].chargeMinorUnits, '15');
  assert.equal(s.receipts[0].verification?.priceSnapshot, s.intents[0].priceSnapshot);
  assert.ok(getPreparedFastReceipt(s.receipts[0]), 'durable paid path uses owned preparation');
  assert.deepEqual(s.receipts[0].verification?.priceSnapshot.customerPrice, expectedPrice);
  assert.equal(s.calls.filter((call) => call === 'fetch').length, 1);
});

test('only complete successful paid receipts carry the internal proof and failed ACK never resends upstream', async () => {
  for (const paid of [false, true]) {
    const s = setup({}, false, paid);
    const receipts: FastReceiptInput[] = [];
    const executor = new FastGatewayExecutor({
      ...s.options,
      journal: {
        ...s.options.journal,
        appendReceipt: async (receipt) => {
          receipts.push(receipt);
          throw new Error('uncertain durable receipt ACK');
        },
      },
    });
    await assert.rejects(executor.execute(s.input), /uncertain durable receipt ACK/);
    assert.equal(receipts.length, 1, 'captured final evidence must not be replaced by a conflicting unknown receipt');
    assert.equal(Boolean(receipts[0].verification), paid);
    assert.equal(s.ended(), false);
    assert.equal(s.calls.filter((call) => call === 'fetch').length, 1);
  }
});

test('SSE DONE stays hidden while receipt commit acknowledgement is pending', async () => {
  const receipt = deferred<void>();
  const observed = deferred<void>();
  const s = setup(
    {
      journal: {
        reserveIntent: async () => ({ kind: 'created', intent: { id: 'intent-a' } }),
        appendReceipt: async () => {
          observed.resolve();
          await receipt.promise;
        },
      },
    },
    true,
  );
  const pending = s.executor.execute(s.input);
  await observed.promise;
  assert.match(s.text(), /hello/);
  assert.doesNotMatch(s.text(), /\[DONE\]/);
  assert.equal(s.ended(), false);
  receipt.resolve();
  assert.equal(await pending, true);
  assert.match(s.text(), /\[DONE\]/);
  assert.ok(s.ended());
});
test('duplicate or ambiguous intent cannot send upstream', async () => {
  for (const reserve of [
    async () => ({ kind: 'existing' as const, requestId: 'request-a', status: 'unknown' }),
    async () => {
      throw new Error('lost commit ACK');
    },
  ]) {
    const s = setup({ journal: { reserveIntent: reserve, appendReceipt: async () => {} } });
    await assert.rejects(() => s.executor.execute(s.input));
    assert.equal(s.calls.includes('fetch'), false);
    assert.equal(s.ended(), false);
  }
});
test('authority expiry during intent await is rechecked and records definitely unsent failure', async () => {
  const s = setup();
  const original = s.options.journal;
  const executor = new FastGatewayExecutor({
    ...s.options,
    journal: {
      ...original,
      reserveIntent: async (i) => {
        const r = await original.reserveIntent(i);
        (s.snapshot as { validUntilMs: number }).validUntilMs = Date.now() - 1;
        return r;
      },
    },
  });
  await assert.rejects(() => executor.execute(s.input));
  assert.equal(s.calls.includes('fetch'), false);
  assert.equal(s.receipts[0].outcome, 'failed');
});
test('client idempotency and unbounded features fall back before admission or journal', async () => {
  for (const inputChange of [
    { idempotencyKey: 'same-logical-request' },
    { body: { model: 'model-a', messages: [], max_tokens: 64, tools: [] } },
  ]) {
    const s = setup();
    assert.equal(await s.executor.execute({ ...s.input, ...inputChange }), false);
    assert.equal(s.calls.includes('admit'), false);
    assert.equal(s.intents.length, 0);
  }
});
test('receipt storage failure never completes JSON or falls back to strict', async () => {
  const s = setup({
    journal: {
      reserveIntent: async () => ({ kind: 'created', intent: { id: 'intent-a' } }),
      appendReceipt: async () => {
        throw new Error('storage down');
      },
    },
  });
  await assert.rejects(() => s.executor.execute(s.input));
  assert.equal(s.ended(), false);
  assert.throws(() => JSON.parse(s.text()));
  assert.equal(s.calls.filter((x) => x === 'fetch').length, 1);
});

test('paid JSON and SSE reserve a real maximum and persist exact charge before EOF', async () => {
  for (const stream of [false, true]) {
    const s = setup({}, stream, true);
    assert.equal(await s.executor.execute(s.input), true);
    assert.equal(s.intents[0].maxCostMinorUnits, '144');
    assert.equal(s.intents[0].currency, 'USD');
    assert.equal(s.receipts[0].chargeMinorUnits, '15');
    assert.equal(s.receipts[0].outcome, 'succeeded');
    if (stream) assert.equal((s.compiledBodies[0].stream_options as Record<string, unknown>).include_usage, true);
    assert.ok(s.calls.indexOf('receipt') < s.calls.indexOf('end'));
  }
});

test('executor send-ticket registry and credential context are runtime-private', () => {
  const s = setup();
  for (const key of ['options', 'tickets', 'credentials', 'transport', '#tickets', '#credentials', '#transport'])
    assert.equal(Reflect.get(s.executor, key), undefined);
});

test('near-expiry pre-admission handoff reloads and recompiles before acquiring one Redis lease', async () => {
  const s = setup();
  let snapshots = 0,
    compiles = 0;
  const executor = new FastGatewayExecutor({
    ...s.options,
    snapshots: {
      resolve: async () => {
        snapshots++;
        return { ...s.snapshot, validUntilMs: Date.now() + (snapshots === 1 ? 400 : 5000) };
      },
    },
    payload: (candidate) => ({
      compile: async (input) => {
        compiles++;
        return s.options.payload(candidate).compile(input);
      },
    }),
  });
  assert.equal(await executor.execute(s.input), true);
  assert.equal(snapshots, 2);
  assert.equal(compiles, 2);
  assert.equal(s.calls.filter((x) => x === 'admit').length, 1);
  assert.equal(s.intents.length, 1);
  assert.equal(s.calls.filter((x) => x === 'fetch').length, 1);
});

test('fully expired compile result reloads before Redis but cancellation never retries or admits', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = setup();
  let snapshots = 0;
  let compiles = 0;
  const executor = new FastGatewayExecutor({
    ...s.options,
    snapshots: {
      resolve: async () => {
        snapshots++;
        return { ...s.snapshot, observedAtMs: now, validUntilMs: now + 5000 };
      },
    },
    payload: (candidate) => ({
      compile: async (input) => {
        if (++compiles === 1) now += 5001;
        return s.options.payload(candidate).compile(input);
      },
    }),
  });
  assert.equal(await executor.execute(s.input), true);
  assert.equal(snapshots, 2);
  assert.equal(compiles, 2);
  assert.equal(s.calls.filter((x) => x === 'admit').length, 1);
  assert.equal(s.intents.length, 1);
  const aborted = setup();
  let abortedResolutions = 0;
  const cancelled = new FastGatewayExecutor({
    ...aborted.options,
    snapshots: {
      resolve: async () => {
        abortedResolutions++;
        return aborted.snapshot;
      },
    },
    payload: (candidate) => ({
      compile: async (input) => {
        aborted.controller.abort();
        now += 5001;
        return aborted.options.payload(candidate).compile(input);
      },
    }),
  });
  await assert.rejects(cancelled.execute(aborted.input));
  assert.equal(abortedResolutions, 1);
  assert.equal(aborted.intents.length, 0);
  assert.equal(aborted.calls.includes('admit'), false);
});

test('one cancelled snapshot waiter cannot cancel a surviving executor or shared cold load', async () => {
  const aborted = setup();
  const surviving = setup();
  const barrier = deferred<void>();
  let loads = 0;
  const snapshots = new CachedFastGatewaySnapshots(
    {
      resolve: async () => {
        loads++;
        await barrier.promise;
        return aborted.snapshot;
      },
    },
    { minimumValidityMs: 1000, refreshAheadMs: 1500 },
  );
  const first = new FastGatewayExecutor({ ...aborted.options, snapshots }).execute(aborted.input);
  const firstDenied = assert.rejects(first);
  const second = new FastGatewayExecutor({ ...surviving.options, snapshots }).execute({
    ...surviving.input,
    requestId: 'request-b',
  });
  aborted.controller.abort();
  barrier.resolve();
  await firstDenied;
  assert.equal(await second, true);
  assert.equal(loads, 1);
  assert.equal(aborted.calls.includes('admit'), false);
  assert.equal(aborted.intents.length, 0);
  assert.equal(surviving.calls.filter((x) => x === 'admit').length, 1);
  assert.equal(surviving.intents.length, 1);
});

test('cancellation during crossed-headroom refresh never admits the canceled waiter or retries the shared load', async (t) => {
  let now = Date.now();
  let mono = 0;
  t.mock.method(Date, 'now', () => now);
  const aborted = setup();
  const surviving = setup();
  const barrier = deferred<void>();
  let loads = 0;
  let crossed = false;
  const snapshots = new CachedFastGatewaySnapshots(
    {
      resolve: async () => {
        if (++loads > 1) await barrier.promise;
        return { ...aborted.snapshot, observedAtMs: now, validUntilMs: now + 5000 };
      },
    },
    {
      minimumValidityMs: 1000,
      refreshAheadMs: 1500,
      wallNow: () => now,
      monotonicNow: () => mono,
      observe(metric) {
        if (metric === 'l1_hit' && !crossed) {
          crossed = true;
          now += 2;
          mono += 2;
        }
      },
    },
  );
  await snapshots.resolve({ ...aborted.input, protocol: 'openai', clientOperation: 'chat.completions' });
  now += 3999;
  mono += 3999;
  const first = new FastGatewayExecutor({ ...aborted.options, snapshots }).execute(aborted.input);
  const firstDenied = assert.rejects(
    first,
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FAST_AUTHORITY_EXPIRED',
  );
  const second = new FastGatewayExecutor({ ...surviving.options, snapshots }).execute({
    ...surviving.input,
    requestId: 'request-b',
  });
  assert.equal(loads, 2);
  assert.equal(aborted.calls.includes('admit'), false);
  assert.equal(surviving.calls.includes('admit'), false);
  aborted.controller.abort();
  barrier.resolve();
  await firstDenied;
  assert.equal(await second, true);
  assert.equal(loads, 2);
  assert.equal(aborted.calls.includes('admit'), false);
  assert.equal(aborted.intents.length, 0);
  assert.equal(surviving.calls.filter((value) => value === 'admit').length, 1);
  assert.equal(surviving.intents.length, 1);
});

test('unknown costly client and compiler-injected extensions fall back before Redis or money', async () => {
  for (const extension of [
    { best_of: 10 },
    { extra_body: { max_candidates: 20 } },
    { web_search_options: {} },
    { reasoning_effort: 'high' },
    { response_format: { type: 'vendor-search' } },
  ]) {
    const s = setup();
    assert.equal(await s.executor.execute({ ...s.input, body: { ...s.input.body, ...extension } }), false);
    assert.equal(s.intents.length, 0);
    assert.equal(s.calls.includes('admit'), false);
  }
  const s = setup();
  const executor = new FastGatewayExecutor({
    ...s.options,
    payload: (candidate) => ({
      compile: async (input) => {
        const result = await s.options.payload(candidate).compile(input);
        if (result.decision !== 'allow') return result;
        return {
          ...result,
          value: {
            ...result.value,
            payloadBytes: Buffer.from(
              JSON.stringify({ ...(input.clientRequest as Record<string, unknown>), best_of: 99 }),
            ),
          },
        };
      },
    }),
  });
  assert.equal(await executor.execute(s.input), false);
  assert.equal(s.intents.length, 0);
  assert.equal(s.calls.includes('admit'), false);
});

test('opt-in fast diagnostics expose bounded stages without changing billing or send count', async () => {
  const s = setup({}, false, true);
  const trace = new RequestDiagnosticTrace();
  await withRequestDiagnosticTrace(trace, () => s.executor.execute(s.input));
  const result = trace.snapshot();
  for (const phase of [
    'fast-snapshot',
    'fast-compile',
    'fast-redis',
    'fast-intent',
    'fast-lease-check',
    'fast-transport',
    'fast-receipt',
  ]) {
    assert.ok((result.phases.find((p) => p.phase === phase)?.startedCount ?? 0) > 0, phase);
  }
  assert.equal(result.pendingSpans, 0);
  assert.equal(s.intents.length, 1);
  assert.equal(s.receipts[0].chargeMinorUnits, '15');
  assert.equal(s.calls.filter((x) => x === 'fetch').length, 1);
  assert.ok(!JSON.stringify(result).includes('tenant-a'));
  assert.ok(!JSON.stringify(result).includes('credential-a'));
});

test('a compiled output ceiling cannot exceed the estimator maximum reservation', async () => {
  const s = setup();
  assert.equal(await s.executor.execute({ ...s.input, body: { ...s.input.body, max_tokens: 10000 } }), false);
  assert.equal(s.intents.length, 0);
  assert.equal(s.calls.includes('admit'), false);
});

test('zero-priced platform requests fall back before Redis or an empty allocation', async () => {
  const s = setup({}, false, true);
  const zero = priceFixture('80', '64', '0').customerPrice.rates;
  const snapshot = {
    ...s.snapshot,
    candidates: s.snapshot.candidates.map((candidate) => ({
      ...candidate,
      customerPrice: candidate.customerPrice ? { ...candidate.customerPrice, rates: zero } : null,
    })),
  };
  const executor = new FastGatewayExecutor({ ...s.options, snapshots: { resolve: async () => snapshot } });
  assert.equal(await executor.execute(s.input), false);
  assert.equal(s.intents.length, 0);
  assert.equal(s.calls.includes('admit'), false);
});

test('missing client output bound is eligible only when the compiler enforces one', async () => {
  const s = setup({}, false, true);
  const { max_tokens: _ignored, ...body } = s.input.body;
  const executor = new FastGatewayExecutor({
    ...s.options,
    payload: (candidate) => ({
      compile: (input) =>
        s.options.payload(candidate).compile({
          ...input,
          clientRequest: { ...(input.clientRequest as Record<string, unknown>), max_tokens: 64 },
        }),
    }),
  });
  assert.equal(await executor.execute({ ...s.input, body }), true);
  assert.equal(s.intents.length, 1);
  assert.equal(s.compiledBodies[0].max_tokens, 64);
  const unsafe = setup({}, false, true);
  assert.equal(await unsafe.executor.execute({ ...unsafe.input, body }), false);
  assert.equal(unsafe.intents.length, 0);
  assert.equal(unsafe.calls.includes('admit'), false);
});

test('automatic liquidity uses the minimum trusted concurrency, never a client field', async () => {
  const s = setup({ maxLocalConcurrency: 3 }, false, true);
  assert.equal(await s.executor.execute(s.input), true);
  const expected = Math.min(
    3,
    s.snapshot.limits.tenant.concurrency,
    s.snapshot.limits.project.concurrency,
    s.snapshot.limits.key.concurrency,
    s.snapshot.candidates[0].limits.concurrency,
  );
  assert.equal(s.intents[0].allocationTargetConcurrency, expected);
  assert.equal(s.intents[0].signal, s.input.client.signal, 'the original client cancellation reaches credit recovery');
});

test('credit readiness and contention failures stay distinguishable and never send', async () => {
  for (const [reason, status, code] of [
    ['credit_not_ready', 429, 'FAST_CREDIT_NOT_READY'],
    ['credit_busy', 503, 'FAST_CREDIT_BUSY'],
    ['send_deadline', 503, 'FAST_AUTHORITY_EXPIRED'],
    ['closed', 503, 'FAST_JOURNAL_UNAVAILABLE'],
  ] as const) {
    const s = setup({
      journal: { reserveIntent: async () => ({ kind: 'denied', reason }), appendReceipt: async () => {} },
    });
    await assert.rejects(() => s.executor.execute(s.input), { status, code });
    assert.equal(s.calls.includes('fetch'), false);
  }
});

test('a transform cannot strip final streaming usage collection before a fast send', async () => {
  const s = setup({}, true, true);
  const executor = new FastGatewayExecutor({
    ...s.options,
    payload: (candidate) => ({
      compile: async (input) => {
        const result = await s.options.payload(candidate).compile(input);
        if (result.decision !== 'allow') return result;
        return {
          ...result,
          value: {
            ...result.value,
            payloadBytes: Buffer.from(
              JSON.stringify({
                ...(input.clientRequest as Record<string, unknown>),
                stream_options: { include_usage: false },
              }),
            ),
          },
        };
      },
    }),
  });
  assert.equal(await executor.execute(s.input), false);
  assert.equal(s.intents.length, 0);
  assert.equal(s.calls.includes('admit'), false);
});

test('TPM reconciliation is attached only after a durable successful usage receipt', async () => {
  for (const receiptFails of [false, true]) {
    const s = setup({}, false, true);
    const feedback: unknown[] = [];
    const executor = new FastGatewayExecutor({
      ...s.options,
      admission: {
        acquire: async (input) => {
          const admitted = await s.options.admission.acquire(input);
          if (!admitted.allowed) return admitted;
          return {
            ...admitted,
            lease: {
              ...admitted.lease,
              release: async (value) => {
                feedback.push(value);
              },
            },
          };
        },
      },
      journal: {
        ...s.options.journal,
        appendReceipt: async (receipt) => {
          if (receiptFails) throw new Error('no durable ACK');
          await s.options.journal.appendReceipt(receipt);
        },
      },
    });
    if (receiptFails) await assert.rejects(executor.execute(s.input));
    else assert.equal(await executor.execute(s.input), true);
    assert.equal((feedback[0] as { actualTokenUnits?: number }).actualTokenUnits, receiptFails ? undefined : 15);
    assert.equal(s.intents[0].maxCostMinorUnits, '144');
  }
});

test('admission denial maps to a typed fast error with an optional Retry-After ceiling', async () => {
  for (const denial of [
    {
      result: { allowed: false as const, reason: 'rate_limited' as const },
      status: 429,
      code: 'FAST_RATE_LIMITED',
      retry: undefined,
    },
    {
      result: { allowed: false as const, reason: 'quota_exceeded' as const, retryAfterMs: 1500 },
      status: 429,
      code: 'FAST_QUOTA_EXCEEDED',
      retry: 2,
    },
    {
      result: { allowed: false as const, reason: 'unavailable' as const },
      status: 503,
      code: 'FAST_UNAVAILABLE',
      retry: undefined,
    },
  ]) {
    const s = setup({
      admission: {
        acquire: async () => denial.result,
      },
    });
    let caught: unknown;
    try {
      await s.executor.execute(s.input);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof FastGatewayExecutionError, String(caught));
    assert.equal(caught.status, denial.status);
    assert.equal(caught.code, denial.code);
    assert.equal(caught.retryAfterSeconds, denial.retry);
    assert.equal(s.calls.includes('intent'), false, 'denied admission must not reserve a journal intent');
  }
});

function splitAdmission(s: ReturnType<typeof setup>, reconciled: number[] = []) {
  return {
    acquire: async (input: Parameters<typeof s.options.admission.acquire>[0]) => {
      const result = await s.options.admission.acquire(input);
      if (!result.allowed) return result;
      return {
        ...result,
        lease: {
          ...result.lease,
          releaseConcurrency: async () => {
            s.calls.push('release-concurrency');
          },
          reconcileDurableUsage: async (actual: number) => {
            reconciled.push(actual);
            s.calls.push('reconcile');
          },
        },
      };
    },
  };
}

test('explicit async JSON and SSE terminal precede receipt ACK but never pre-send intent or queue ownership', async () => {
  for (const stream of [false, true]) {
    const s = setup({}, stream, true);
    const ack = deferred<void>();
    const observed = deferred<void>();
    const reconciled: number[] = [];
    const queue = new FastReceiptQueue({
      journal: {
        appendReceipt: async (receipt) => {
          await s.options.journal.appendReceipt(receipt);
          observed.resolve();
          await ack.promise;
        },
      },
    });
    const executor = new FastGatewayExecutor({
      ...s.options,
      admission: splitAdmission(s, reconciled),
      receiptQueue: queue,
    });
    const pending = executor.execute(s.input);
    await observed.promise;
    assert.equal(await pending, true);
    assert.equal(s.ended(), true);
    if (stream) assert.match(s.text(), /\[DONE\]/);
    else assert.doesNotThrow(() => JSON.parse(s.text()));
    assert.ok(s.calls.indexOf('intent') < s.calls.indexOf('fetch'));
    assert.equal(queue.snapshot().pending, 1);
    assert.equal(queue.snapshot().durable, 0);
    assert.deepEqual(reconciled, []);
    assert.ok(s.calls.includes('release-concurrency'));
    assert.equal(s.calls.includes('release'), false);
    ack.resolve();
    await queue.close();
    assert.deepEqual(reconciled, [15]);
    assert.equal(s.receipts.length, 1);
    assert.equal(s.receipts[0].chargeMinorUnits, '15');
    assert.ok(getPreparedFastReceipt(s.receipts[0]), 'queue preserves exact owned prepared receipt');
  }
});

test('queue byte/count fallback and missing split capability preserve durable ACK terminal barrier', async () => {
  for (const reason of ['bytes', 'count', 'capability'] as const) {
    const s = setup({}, true, true);
    const ack = deferred<void>();
    const observed = deferred<void>();
    const journal = {
      ...s.options.journal,
      appendReceipt: async (receipt: FastReceiptInput) => {
        observed.resolve();
        await ack.promise;
        await s.options.journal.appendReceipt(receipt);
      },
    };
    const queue = new FastReceiptQueue({ journal, maxBytes: reason === 'bytes' ? 1 : undefined, maxEntries: 1 });
    if (reason === 'count') {
      queue.tryEnqueue(
        {
          intentId: 'occupied',
          requestId: 'occupied',
          tenantId: 'another',
          outcome: 'unknown',
          chargeMinorUnits: null,
          usage: {},
          usageDigest: 'a'.repeat(64),
          httpStatus: null,
        },
        { retainedLiabilityMinorUnits: '0', currency: null },
      );
    }
    const executor = new FastGatewayExecutor({
      ...s.options,
      journal,
      receiptQueue: queue,
      admission: reason === 'capability' ? s.options.admission : splitAdmission(s),
    });
    const pending = executor.execute(s.input);
    await observed.promise;
    // Let the second request reach its append when the count fixture occupied the first worker.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.ended(), false);
    assert.doesNotMatch(s.text(), /\[DONE\]/);
    ack.resolve();
    assert.equal(await pending, true);
    assert.equal(s.ended(), true);
    assert.equal(queue.snapshot().fallbacks, 1);
    const fallbackReceipt = s.receipts.find((receipt) => receipt.intentId === 'intent-a');
    assert.ok(fallbackReceipt);
    assert.ok(getPreparedFastReceipt(fallbackReceipt), 'durable fallback preserves owned prepared receipt');
    assert.ok(s.calls.includes('release'));
    await queue.close();
  }
});

test('async uncertain ACK retries frozen success after HTTP completion without unknown receipt or second send', async () => {
  const s = setup({}, false, true);
  const receipts: FastReceiptInput[] = [];
  const ack = deferred<void>();
  const queue = new FastReceiptQueue({
    retryBaseMs: 1,
    retryMaxMs: 1,
    journal: {
      appendReceipt: async (receipt) => {
        receipts.push(receipt);
        await ack.promise;
        if (receipts.length === 1) throw new Error('uncertain ACK');
      },
    },
  });
  const executor = new FastGatewayExecutor({ ...s.options, receiptQueue: queue, admission: splitAdmission(s) });
  assert.equal(await executor.execute(s.input), true);
  assert.equal(s.ended(), true);
  ack.resolve();
  await queue.close();
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0], receipts[1]);
  assert.equal(receipts[0].outcome, 'succeeded');
  assert.equal(s.calls.filter((c) => c === 'fetch').length, 1);
});

test('client terminal failure after queue ownership cannot replace complete evidence', async () => {
  const s = setup({}, true, true);
  const ack = deferred<void>();
  const queue = new FastReceiptQueue({
    journal: {
      appendReceipt: async (receipt) => {
        await s.options.journal.appendReceipt(receipt);
        await ack.promise;
      },
    },
  });
  const executor = new FastGatewayExecutor({ ...s.options, receiptQueue: queue, admission: splitAdmission(s) });
  await assert.rejects(
    executor.execute({
      ...s.input,
      client: {
        ...s.input.client,
        end: () => {
          s.controller.abort();
          throw new Error('client terminal failed');
        },
      },
    }),
    /client terminal failed/,
  );
  assert.equal(s.receipts.length, 1);
  assert.equal(s.receipts[0].outcome, 'succeeded');
  assert.equal(queue.snapshot().pending, 1);
  ack.resolve();
  await queue.close();
});

test('async mode keeps fragmented DONE until complete usage capture and rejects incomplete success evidence', async () => {
  for (const complete of [false, true]) {
    const s = setup({}, true, true);
    const queue = new FastReceiptQueue({ journal: s.options.journal });
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      ...(complete ? ['data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'] : []),
      'data: [DO',
      'NE]\n',
      '\n',
    ];
    const executor = new FastGatewayExecutor({
      ...s.options,
      receiptQueue: queue,
      admission: splitAdmission(s),
      transport: {
        ...s.options.transport,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
    });
    if (complete) {
      assert.equal(await executor.execute(s.input), true);
      assert.match(s.text(), /\[DONE\]/);
      assert.equal(s.ended(), true);
      assert.equal(queue.snapshot().accepted, 1);
    } else {
      await assert.rejects(executor.execute(s.input));
      assert.doesNotMatch(s.text(), /\[DONE\]/);
      assert.equal(s.ended(), false);
      assert.equal(queue.snapshot().accepted, 0);
      assert.equal(s.receipts[0].outcome, 'unknown');
    }
    await queue.close();
  }
});

test('prolonged undurable receipt age stops new Redis admission and intents', async () => {
  const s = setup({}, false, true);
  const ack = deferred<void>();
  let now = 0;
  const queue = new FastReceiptQueue({
    now: () => now,
    maxAgeMs: 5,
    journal: { appendReceipt: async () => ack.promise },
  });
  queue.tryEnqueue(
    {
      intentId: 'occupied',
      requestId: 'occupied',
      tenantId: 'another',
      outcome: 'unknown',
      chargeMinorUnits: null,
      usage: {},
      usageDigest: 'a'.repeat(64),
      httpStatus: null,
    },
    { retainedLiabilityMinorUnits: '0', currency: null },
  );
  now = 6;
  const executor = new FastGatewayExecutor({ ...s.options, receiptQueue: queue, admission: splitAdmission(s) });
  await assert.rejects(executor.execute(s.input), { code: 'FAST_RECEIPT_BACKPRESSURE' });
  assert.equal(s.intents.length, 0);
  assert.equal(s.calls.includes('admit'), false);
  assert.equal(s.calls.includes('fetch'), false);
  ack.resolve();
  await queue.close();
});

test('default captured receipt failure stays conservative on definite failure and commit-then-lost-ACK alike', async () => {
  for (const committed of [false, true]) {
    const s = setup({}, false, true);
    const attempts: FastReceiptInput[] = [];
    const durable: FastReceiptInput[] = [];
    const executor = new FastGatewayExecutor({
      ...s.options,
      journal: {
        ...s.options.journal,
        appendReceipt: async (receipt) => {
          attempts.push(receipt);
          if (committed) durable.push(receipt);
          throw new Error(committed ? 'lost receipt commit ACK' : 'receipt rejected before commit');
        },
      },
    });
    await assert.rejects(executor.execute(s.input));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'succeeded');
    assert.equal(attempts[0].chargeMinorUnits, '15');
    assert.equal(durable.length, committed ? 1 : 0);
    assert.equal(s.ended(), false);
    assert.equal(s.calls.filter((c) => c === 'fetch').length, 1);
  }
});

test('async mode never enqueues incomplete upstream cancellation/error as a successful receipt', async () => {
  const s = setup({}, true, true);
  const queue = new FastReceiptQueue({ journal: s.options.journal });
  const executor = new FastGatewayExecutor({
    ...s.options,
    receiptQueue: queue,
    admission: splitAdmission(s),
    transport: {
      ...s.options.transport,
      fetch: async () => {
        s.calls.push('fetch');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
              queueMicrotask(() => controller.error(new Error('upstream interrupted')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
  });
  await assert.rejects(executor.execute(s.input));
  assert.equal(queue.snapshot().accepted, 0);
  assert.equal(s.ended(), false);
  assert.equal(s.receipts.length, 1);
  assert.equal(s.receipts[0].outcome, 'unknown');
  assert.equal(s.calls.filter((c) => c === 'fetch').length, 1);
  assert.equal(s.calls.includes('release-concurrency'), false);
  await queue.close();
});

// A reusable keep-alive client may send its next request as soon as EOF arrives.
// The prior handler must not retain operational Redis/heartbeat work after EOF.
test('queued JSON and SSE wait for operational release before EOF, not for receipt SQL', async () => {
  for (const stream of [false, true]) {
    const s = setup({}, stream, true);
    const receiptAck = deferred<void>();
    const receiptEntered = deferred<void>();
    const releaseAck = deferred<void>();
    const releaseEntered = deferred<void>();
    const reconciled: number[] = [];
    const feedback: (FastAdmissionFeedback | undefined)[] = [];
    const admission = splitAdmission(s, reconciled);
    const queue = new FastReceiptQueue({
      journal: {
        appendReceipt: async (receipt) => {
          await s.options.journal.appendReceipt(receipt);
          receiptEntered.resolve();
          await receiptAck.promise;
        },
      },
    });
    const executor = new FastGatewayExecutor({
      ...s.options,
      receiptQueue: queue,
      admission: {
        acquire: async (input) => {
          const result = await admission.acquire(input);
          if (!result.allowed) return result;
          return {
            ...result,
            lease: {
              ...result.lease,
              releaseConcurrency: async (value) => {
                feedback.push(value);
                releaseEntered.resolve();
                await releaseAck.promise;
                s.calls.push('release-concurrency');
              },
            },
          };
        },
      },
    });
    const pending = executor.execute(s.input);
    try {
      await Promise.all([receiptEntered.promise, releaseEntered.promise]);
      assert.match(s.text(), /hello/, 'first body bytes must flow before operational release');
      assert.equal(s.ended(), false, 'EOF must wait until operational release settles');
      if (stream) assert.doesNotMatch(s.text(), /\[DONE\]/);
      else assert.throws(() => JSON.parse(s.text()), 'the final JSON byte remains held');
      assert.deepEqual(feedback, [{ outcome: 'success' }], 'undurable usage cannot refund TPM');
      assert.deepEqual(reconciled, []);
      assert.equal(queue.snapshot().undurableLiabilityByCurrency.USD, '144');
      releaseAck.resolve();
      assert.equal(await pending, true, 'receipt SQL must not join the queue-accepted critical path');
      assert.equal(s.ended(), true);
      assert.ok(s.calls.indexOf('release-concurrency') < s.calls.indexOf('end'));
      assert.equal(queue.snapshot().durable, 0);
      assert.equal(queue.snapshot().pending, 1);
      assert.equal(feedback.length, 1, 'finally must reuse the completed cleanup');
      assert.equal(s.calls.includes('release'), false);
      receiptAck.resolve();
      await queue.close();
      assert.deepEqual(reconciled, [15]);
      assert.equal(s.receipts.length, 1);
    } finally {
      releaseAck.resolve();
      receiptAck.resolve();
      await pending.catch(() => undefined);
      await queue.close();
    }
  }
});

test('durable mode and queue fallback release actual usage only after SQL ACK and before EOF', async () => {
  for (const mode of ['durable', 'bytes', 'capability'] as const) {
    const s = setup({}, true, true);
    const receiptAck = deferred<void>();
    const receiptEntered = deferred<void>();
    const releaseAck = deferred<void>();
    const releaseEntered = deferred<void>();
    const feedback: (FastAdmissionFeedback | undefined)[] = [];
    const journal = {
      ...s.options.journal,
      appendReceipt: async (receipt: FastReceiptInput) => {
        receiptEntered.resolve();
        await receiptAck.promise;
        await s.options.journal.appendReceipt(receipt);
      },
    };
    const queue = mode === 'durable' ? undefined : new FastReceiptQueue({ journal, maxBytes: 1 });
    const admission = mode === 'capability' ? s.options.admission : splitAdmission(s);
    const executor = new FastGatewayExecutor({
      ...s.options,
      journal,
      receiptQueue: queue,
      admission: {
        acquire: async (input) => {
          const result = await admission.acquire(input);
          if (!result.allowed) return result;
          return {
            ...result,
            lease: {
              ...result.lease,
              release: async (value) => {
                feedback.push(value);
                releaseEntered.resolve();
                await releaseAck.promise;
                s.calls.push('release');
              },
            },
          };
        },
      },
    });
    const pending = executor.execute(s.input);
    try {
      await receiptEntered.promise;
      assert.match(s.text(), /hello/);
      assert.equal(s.ended(), false);
      assert.deepEqual(feedback, [], 'actual usage stays reserved until durable receipt ACK');
      receiptAck.resolve();
      await releaseEntered.promise;
      assert.deepEqual(feedback, [{ outcome: 'success', actualTokenUnits: 15 }]);
      assert.equal(s.ended(), false, 'durable receipt alone cannot finish before operational release');
      assert.doesNotMatch(s.text(), /\[DONE\]/);
      releaseAck.resolve();
      assert.equal(await pending, true);
      assert.equal(feedback.length, 1);
      assert.ok(s.calls.indexOf('receipt') < s.calls.indexOf('release'));
      assert.ok(s.calls.indexOf('release') < s.calls.indexOf('end'));
      assert.equal(s.calls.includes('release-concurrency'), false);
      if (queue) assert.equal(queue.snapshot().fallbacks, 1);
    } finally {
      releaseAck.resolve();
      receiptAck.resolve();
      await pending.catch(() => undefined);
      await queue?.close();
    }
  }
});

test('pending heartbeat drains and renewal stops before operational release and terminal EOF', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = setup({}, true, true);
  const fetchEntered = deferred<void>();
  const fetchAllowed = deferred<void>();
  const renewAck = deferred<void>();
  const receiptEntered = deferred<void>();
  const receiptAck = deferred<void>();
  const queue = new FastReceiptQueue({
    journal: {
      appendReceipt: async (receipt) => {
        await s.options.journal.appendReceipt(receipt);
        receiptEntered.resolve();
        await receiptAck.promise;
      },
    },
  });
  let renewals = 0;
  let releases = 0;
  const admission = splitAdmission(s);
  const executor = new FastGatewayExecutor({
    ...s.options,
    receiptQueue: queue,
    transport: {
      ...s.options.transport,
      fetch: async (...args) => {
        fetchEntered.resolve();
        await fetchAllowed.promise;
        assert.ok(s.options.transport.fetch);
        return s.options.transport.fetch(...args);
      },
    },
    admission: {
      acquire: async (input) => {
        const result = await admission.acquire(input);
        if (!result.allowed) return result;
        return {
          ...result,
          lease: {
            ...result.lease,
            renewIntervalMs: 1,
            renew: async () => {
              renewals++;
              await renewAck.promise;
              s.calls.push('renew-ack');
            },
            releaseConcurrency: async () => {
              releases++;
              s.calls.push('release-concurrency');
            },
          },
        };
      },
    },
  });
  const pending = executor.execute(s.input);
  try {
    await fetchEntered.promise;
    t.mock.timers.tick(1);
    assert.equal(renewals, 1);
    fetchAllowed.resolve();
    await receiptEntered.promise;
    assert.match(s.text(), /hello/);
    assert.equal(s.ended(), false, 'a held renewal must not survive HTTP EOF');
    assert.equal(releases, 0, 'release cannot race the last renewal');
    renewAck.resolve();
    assert.equal(await pending, true);
    t.mock.timers.tick(100);
    assert.equal(renewals, 1, 'cleanup must stop future renewals');
    assert.equal(releases, 1);
    assert.ok(s.calls.indexOf('renew-ack') < s.calls.indexOf('release-concurrency'));
    assert.ok(s.calls.indexOf('release-concurrency') < s.calls.indexOf('end'));
    assert.equal(queue.snapshot().durable, 0);
  } finally {
    fetchAllowed.resolve();
    renewAck.resolve();
    receiptAck.resolve();
    await pending.catch(() => undefined);
    await queue.close();
  }
});

test('operational release failure or lost ACK is swallowed once without resend or conflicting receipt', async () => {
  for (const queued of [false, true]) {
    for (const committed of [false, true]) {
      const s = setup({}, false, true);
      const admission = queued ? splitAdmission(s) : s.options.admission;
      const queue = queued ? new FastReceiptQueue({ journal: s.options.journal }) : undefined;
      let releases = 0;
      let applied = 0;
      const release = async () => {
        releases++;
        if (committed) applied++;
        s.calls.push('release-error');
        throw new Error(committed ? 'release committed but ACK lost' : 'release failed before commit');
      };
      const executor = new FastGatewayExecutor({
        ...s.options,
        receiptQueue: queue,
        admission: {
          acquire: async (input) => {
            const result = await admission.acquire(input);
            if (!result.allowed) return result;
            return {
              ...result,
              lease: { ...result.lease, ...(queued ? { releaseConcurrency: release } : { release }) },
            };
          },
        },
      });
      try {
        assert.equal(await executor.execute(s.input), true);
        assert.equal(releases, 1, 'finally must not retry ambiguous operational release');
        assert.equal(applied, committed ? 1 : 0);
        assert.ok(s.calls.indexOf('release-error') < s.calls.indexOf('end'));
        assert.equal(s.calls.filter((call) => call === 'fetch').length, 1);
        await queue?.close();
        assert.equal(s.receipts.length, 1);
        assert.equal(s.receipts[0].outcome, 'succeeded');
        assert.equal(s.ended(), true);
      } finally {
        await queue?.close();
      }
    }
  }
});

test('terminal write or end failure reuses operational cleanup without changing owned evidence', async () => {
  for (const queued of [false, true]) {
    for (const failedOperation of ['write', 'end'] as const) {
      const s = setup({}, true, true);
      const queue = queued ? new FastReceiptQueue({ journal: s.options.journal }) : undefined;
      const executor = new FastGatewayExecutor({
        ...s.options,
        receiptQueue: queue,
        admission: queued ? splitAdmission(s) : s.options.admission,
      });
      const releaseCall = queued ? 'release-concurrency' : 'release';
      try {
        await assert.rejects(
          executor.execute({
            ...s.input,
            client: {
              ...s.input.client,
              write: (chunk) => {
                if (failedOperation === 'write' && Buffer.from(chunk).includes('[DONE]')) {
                  assert.equal(s.calls.filter((call) => call === releaseCall).length, 1);
                  throw new Error('terminal write failed');
                }
                return s.input.client.write(chunk);
              },
              end: () => {
                assert.equal(s.calls.filter((call) => call === releaseCall).length, 1);
                throw new Error('terminal end failed');
              },
            },
          }),
          new RegExp(`terminal ${failedOperation} failed`),
        );
        await queue?.close();
        assert.equal(s.calls.filter((call) => call === releaseCall).length, 1);
        assert.equal(s.calls.filter((call) => call === 'fetch').length, 1);
        assert.equal(s.receipts.length, 1);
        assert.equal(s.receipts[0].outcome, 'succeeded');
      } finally {
        await queue?.close();
      }
    }
  }
});

test('cancellation while operational release waits still fails the terminal client write without changing receipt', async () => {
  const s = setup({}, true, true);
  const releaseEntered = deferred<void>();
  const releaseAck = deferred<void>();
  const queue = new FastReceiptQueue({ journal: s.options.journal });
  const admission = splitAdmission(s);
  let releases = 0;
  const executor = new FastGatewayExecutor({
    ...s.options,
    receiptQueue: queue,
    admission: {
      acquire: async (input) => {
        const result = await admission.acquire(input);
        if (!result.allowed) return result;
        return {
          ...result,
          lease: {
            ...result.lease,
            releaseConcurrency: async () => {
              releases++;
              releaseEntered.resolve();
              await releaseAck.promise;
            },
          },
        };
      },
    },
  });
  const pending = executor.execute({
    ...s.input,
    client: {
      ...s.input.client,
      write: (chunk) => {
        if (s.input.client.signal.aborted) throw new Error('client aborted');
        return s.input.client.write(chunk);
      },
    },
  });
  const rejected = assert.rejects(pending, /client aborted/);
  try {
    await releaseEntered.promise;
    assert.equal(s.ended(), false);
    s.controller.abort();
    releaseAck.resolve();
    await rejected;
    await queue.close();
    assert.equal(releases, 1);
    assert.equal(s.ended(), false);
    assert.doesNotMatch(s.text(), /\[DONE\]/);
    assert.equal(s.receipts.length, 1);
    assert.equal(s.receipts[0].outcome, 'succeeded');
    assert.equal(s.calls.filter((call) => call === 'fetch').length, 1);
  } finally {
    releaseAck.resolve();
    await pending.catch(() => undefined);
    await queue.close();
  }
});

test('executor still awaits the final client drain after one operational cleanup', async () => {
  const s = setup({}, false, true);
  const endEntered = deferred<void>();
  const endAck = deferred<void>();
  let completed = false;
  const pending = s.executor
    .execute({
      ...s.input,
      client: {
        ...s.input.client,
        end: async () => {
          endEntered.resolve();
          await endAck.promise;
          await s.input.client.end();
        },
      },
    })
    .then((result) => {
      completed = true;
      return result;
    });
  try {
    await endEntered.promise;
    assert.equal(s.calls.filter((call) => call === 'release').length, 1);
    assert.equal(completed, false, 'cleanup cannot bypass the final client drain');
    assert.equal(s.ended(), false);
    endAck.resolve();
    assert.equal(await pending, true);
    assert.equal(completed, true);
    assert.equal(s.calls.filter((call) => call === 'release').length, 1);
  } finally {
    endAck.resolve();
    await pending.catch(() => undefined);
  }
});

test('failed responses preserve rate-limit and failure feedback without actual usage before terminal', async () => {
  for (const queued of [false, true]) {
    for (const status of [429, 503]) {
      const s = setup({}, false, true);
      const feedback: (FastAdmissionFeedback | undefined)[] = [];
      const admission = queued ? splitAdmission(s) : s.options.admission;
      const queue = queued ? new FastReceiptQueue({ journal: s.options.journal }) : undefined;
      const release = async (value?: FastAdmissionFeedback) => {
        feedback.push(value);
        s.calls.push('feedback');
      };
      const executor = new FastGatewayExecutor({
        ...s.options,
        receiptQueue: queue,
        admission: {
          acquire: async (input) => {
            const result = await admission.acquire(input);
            if (!result.allowed) return result;
            return {
              ...result,
              lease: { ...result.lease, ...(queued ? { releaseConcurrency: release } : { release }) },
            };
          },
        },
        transport: {
          ...s.options.transport,
          fetch: async () =>
            new Response('{"error":"provider unavailable"}', {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        },
      });
      try {
        assert.equal(await executor.execute(s.input), true);
        await queue?.close();
        assert.deepEqual(feedback, [
          status === 429
            ? { outcome: 'rate_limited', cooldownMs: 1000, modelOnly: true }
            : { outcome: 'failure', cooldownMs: 1000 },
        ]);
        assert.ok(s.calls.indexOf('feedback') < s.calls.indexOf('end'));
        assert.equal(s.receipts.length, 1);
        assert.equal(s.receipts[0].outcome, 'failed');
        assert.equal(s.receipts[0].chargeMinorUnits, '0');
      } finally {
        await queue?.close();
      }
    }
  }
});

test('one-time customer capture preserves strict fallback for unsupported commercial pricing', async () => {
  for (const unsupported of ['multipliers', 'perUnit', 'tiers'] as const) {
    const s = setup({}, false, true);
    const price = s.snapshot.candidates[0].customerPrice;
    assert.ok(price);
    if (unsupported === 'multipliers') Object.assign(price, { tokenMultipliers: {} });
    else if (unsupported === 'perUnit')
      Object.assign(price.rates, { per_unit: { numeratorMinorUnits: 1n, denominatorUnits: 1n } });
    else Object.assign(price.rates, { per_unit_tiers: { '1k': { numeratorMinorUnits: 1n, denominatorUnits: 1n } } });
    assert.equal(await s.executor.execute(s.input), false);
    assert.equal(s.calls.includes('admit'), false);
    assert.equal(s.calls.includes('intent'), false);
    assert.equal(s.calls.includes('fetch'), false);
  }
});
