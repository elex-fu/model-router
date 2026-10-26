import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Dispatcher } from 'undici';
import {
  FastGatewayExecutor,
  type FastGatewayExecutorOptions,
  type FastIntentInput,
  type FastReceiptInput,
} from '../../../../src/saas/gateway/fast/executor.js';
import type { PreparedEvidenceClientStream } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { fastExecutorFixture } from './executor-fixture.js';

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
  assert.ok(s.ended());
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
