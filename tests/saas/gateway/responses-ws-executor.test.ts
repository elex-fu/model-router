import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { CodexNativeWsSessionError, codexNativeWsSession } from '../../../src/saas/gateway/codex/native-ws-session.js';
import type { PreparedEvidenceDispatchResult } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  RequestPreparationInput,
  RequestPreparationPreparedResult,
} from '../../../src/saas/gateway/request-preparation-service.js';
import { createResponsesWsServer } from '../../../src/saas/gateway/responses-ws-connection.js';
import {
  ResponsesWsEngine,
  type ResponsesWsEvent,
  ResponsesWsRoundError,
} from '../../../src/saas/gateway/responses-ws-engine.js';
import { createResponsesWsRoundExecutor } from '../../../src/saas/gateway/responses-ws-executor.js';
import { PersistentResponsesContinuationResolver } from '../../../src/saas/gateway/responses-continuation-resolver.js';
import { AesGcmResponsesHistoryCipher } from '../../../src/saas/gateway/responses-continuation-cipher.js';
import type { ResponsesContinuationHistoryPort, ResponsesHistoryRecord, ResponsesHistoryReference } from '../../../src/saas/gateway/responses-continuation-history.js';
import { codexContinuationMode } from '../../../src/saas/gateway/codex/continuation-metadata.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

const encoder = new TextEncoder();
const clientRequest = {
  headers: { authorization: 'Bearer local-proxy-fixture', conversation_id: 'conversation-a' },
  socket: { remoteAddress: '127.0.0.1' },
} as IncomingMessage;

function fixture(request = clientRequest) {
  const ids = new AsyncLocalStorage<string>();
  const state = {
    authCount: 0,
    revoked: false,
    account: 'account-a',
    rejected: false,
    cancelDispatch: false,
    cancelDispatchError: false,
    settled: 0,
    nativeMock: false,
    dispatched: 0,
    compensation: 0,
    preparations: [] as RequestPreparationInput[],
    order: [] as string[],
  };
  const caller = {
    metadata: { tenantId: 'tenant-a', projectId: 'project-a', principalUserId: 'user-a', id: 'key-a', name: 'fixture' },
    authorization: { principalId: 'user-a' },
  } as AuthenticatedApiKey;
  const options: Parameters<typeof createResponsesWsRoundExecutor>[0] = {
    request,
    authenticator: {
      async authenticate() {
        state.authCount += 1;
        return state.revoked ? null : caller;
      },
    },
    preparation: {
      async prepare(input) {
        state.preparations.push(input);
        if (state.rejected)
          return {
            outcome: 'rejected',
            code: 'hold_denied',
            stage: 'admission',
            message: 'insufficient funds',
          } as never;
        const requestId = ids.getStore();
        assert.ok(requestId);
        return {
          outcome: 'prepared',
          requestId,
          attemptId: `${requestId}-attempt`,
          payloadBytes: encoder.encode(JSON.stringify(input.clientRequest)),
          evidence: { evidenceId: `${requestId}-evidence` },
          evidenceInput: {
            tenantId: 'tenant-a',
            projectId: 'project-a',
            proxyKeyId: 'key-a',
            providerId: state.nativeMock ? 'openai-codex' : 'provider-a',
            productId: 'product-a',
            publicModel: input.publicModel,
            accountId: state.account,
            credentialId: 'credential-a',
            credentialVersion: '1',
            credentialAuthzVersion: '1',
            resolvedModel: 'upstream-model',
          },
          normalSuccessSnapshot: {},
        } as RequestPreparationPreparedResult;
      },
    },
    dispatch: {
      async dispatch(input) {
        state.dispatched += 1;
        assert.ok(input.client);
        await input.client.start(200, { 'content-type': 'text/event-stream' });
        await input.client.write(
          encoder.encode('data: {"type":"response.created","response":{"id":"response-a"}}\n\n'),
        );
        if (state.cancelDispatch) {
          if (!input.client.signal.aborted) await once(input.client.signal, 'abort');
          state.order.push('retained-unknown');
          if (state.cancelDispatchError) throw new Error('client stream cancelled');
          return { kind: 'unknown' } as PreparedEvidenceDispatchResult;
        }
        await input.client.write(encoder.encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
        await input.client.write(
          encoder.encode(
            'data: {"type":"response.completed","response":{"id":"response-a","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
          ),
        );
        await input.client.end();
        if (state.nativeMock && input.codexNativeWsSession) codexNativeWsSession(input.codexNativeWsSession).finish('response-a');
        state.settled += 1;
        state.order.push('settled');
        return { kind: 'sent', settlementOutcome: 'settled', transport: { resultHttpStatus: 200 } } as PreparedEvidenceDispatchResult;
      },
    },
    compensation: {
      async compensate() {
        state.compensation += 1;
      },
    },
    maxBodyBytes: 1024,
    entryPoint: 'ws-executor-test',
    runWithRequestId: (requestId, work) => ids.run(requestId, work),
  };
  return { state, options, executor: createResponsesWsRoundExecutor(options) };
}

test('WS default executor authenticates and admits every round, streams with backpressure, then publishes settled terminal', async () => {
  const f = fixture();
  const sent: ResponsesWsEvent[] = [];
  const engine = new ResponsesWsEngine({
    executor: f.executor,
    send: async (event) => {
      sent.push(event);
      f.state.order.push(event.type);
    },
    close: () => assert.fail('unexpected close'),
  });
  await engine.handle({ type: 'response.create', model: 'public-model', input: 'first' });
  await engine.handle({ type: 'response.create', input: 'next', previous_response_id: 'response-a' });
  assert.equal(f.state.authCount, 2);
  assert.equal(f.state.preparations.length, 2);
  assert.equal(f.state.dispatched, 2);
  assert.equal(f.state.settled, 2);
  assert.equal(f.state.compensation, 0);
  assert.equal(f.state.preparations[1]?.publicModel, 'public-model');
  const canonical = f.state.preparations[1]?.clientRequest as Record<string, unknown>;
  assert.equal(canonical.previous_response_id, undefined);
  assert.deepEqual(canonical.input, [{ role: 'user', content: 'first' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }, { role: 'user', content: 'next' }]);
  assert.equal(f.state.preparations[1]?.scheduling?.previousResponseId, 'response-a');
  assert.equal(f.state.preparations[0]?.scheduling?.sessionId, f.state.preparations[1]?.scheduling?.sessionId);
  assert.deepEqual(f.state.order.slice(0, 4), [
    'response.created',
    'response.output_text.delta',
    'settled',
    'response.completed',
  ]);
  assert.equal(engine.pinnedIdentity?.accountId, 'account-a');
  assert.equal(engine.pinnedIdentity?.upstreamSessionId, 'response-a');
  assert.equal(sent.filter((event) => event.type === 'response.completed').length, 2);
});

test('WS streamed events await the outbound sink before reading the next provider event', async () => {
  const f = fixture();
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = f.executor.executeRound({
    requestId: 'round-a',
    body: { model: 'public-model', input: 'hello' },
    pinned: null,
    cancelSignal: new AbortController().signal,
    emit: async (event) => {
      if (event.type === 'response.created') {
        reached();
        await gate;
      }
    },
  });
  await entered;
  assert.equal(f.state.settled, 0);
  release();
  const result = await work;
  assert.equal(result.terminal.type, 'response.completed');
  assert.equal(f.state.settled, 1);
});

test('WS rejects account rebinding and compensates only the new still-prepared reservation', async () => {
  const f = fixture();
  const first = await f.executor.executeRound({
    requestId: 'round-a',
    body: { model: 'public-model', input: 'hello' },
    pinned: null,
    cancelSignal: new AbortController().signal,
  });
  f.state.account = 'account-b';
  await assert.rejects(
    f.executor.executeRound({
      requestId: 'round-b',
      body: { model: 'public-model', input: 'next' },
      pinned: first.pinned,
      cancelSignal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ResponsesWsRoundError && error.code === 'SESSION_BINDING_CHANGED',
  );
  assert.equal(f.state.dispatched, 1);
  assert.equal(f.state.compensation, 1);
});

test('WS cancellation reaches dispatch without a speculative refund, and revoked keys cannot enter preparation', async () => {
  const f = fixture();
  f.state.cancelDispatch = true;
  const controller = new AbortController();
  const work = f.executor.executeRound({
    requestId: 'round-a',
    body: { model: 'public-model', input: 'hello' },
    pinned: null,
    cancelSignal: controller.signal,
    emit: async () => {
      controller.abort();
    },
  });
  const cancelled = await work;
  assert.equal(cancelled.terminal.type, 'response.cancelled');
  assert.equal(cancelled.terminal.response_id, 'response-a');
  assert.equal(cancelled.pinned.upstreamSessionId, 'response-a');
  assert.deepEqual(f.state.order, ['retained-unknown']);
  assert.equal(f.state.compensation, 0);
  f.state.revoked = true;
  await assert.rejects(
    f.executor.executeRound({
      requestId: 'round-b',
      body: { model: 'public-model', input: 'next' },
      pinned: null,
      cancelSignal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ResponsesWsRoundError && error.status === 401,
  );
  assert.equal(f.state.preparations.length, 1);
});

test('WS cancellation before upstream creation omits a response id and retains the prior provider session', async () => {
  const f = fixture();
  const first = await f.executor.executeRound({
    requestId: 'gateway-first',
    body: { model: 'public-model', input: 'hello' },
    pinned: null,
    cancelSignal: new AbortController().signal,
  });
  const controller = new AbortController();
  const executor = createResponsesWsRoundExecutor({
    ...f.options,
    preparation: {
      async prepare(input) {
        const prepared = await f.options.preparation.prepare(input);
        controller.abort();
        return prepared;
      },
    },
  });
  const cancelled = await executor.executeRound({
    requestId: 'gateway-second',
    body: { model: 'public-model', input: 'next' },
    pinned: first.pinned,
    cancelSignal: controller.signal,
  });
  assert.deepEqual(cancelled.terminal, { type: 'response.cancelled' });
  assert.equal(cancelled.pinned.upstreamSessionId, 'response-a');
  assert.equal(f.state.dispatched, 1);
  assert.equal(f.state.compensation, 1);
});

test('WS funds admission failure does not dispatch or create a refund', async () => {
  const f = fixture();
  f.state.rejected = true;
  await assert.rejects(
    f.executor.executeRound({
      requestId: 'round-a',
      body: { model: 'public-model', input: 'hello' },
      pinned: null,
      cancelSignal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ResponsesWsRoundError && error.status === 402,
  );
  assert.equal(f.state.dispatched, 0);
  assert.equal(f.state.compensation, 0);
});

test('real WS upgrade binds its proxy key to the built-in executor and releases connection resources', {
  timeout: 5_000,
}, async () => {
  let state: ReturnType<typeof fixture>['state'] | undefined;
  const handle = createResponsesWsServer({
    authenticate: async (req) => ({ ok: req.headers.authorization === 'Bearer local-proxy-fixture' }) as { ok: true },
    createEngine: (req) => {
      const f = fixture(req);
      state = f.state;
      return new ResponsesWsEngine({ executor: f.executor, send: () => {}, close: () => {} });
    },
  });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (!handle.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
    headers: { authorization: 'Bearer local-proxy-fixture', conversation_id: 'conversation-a' },
  });
  try {
    await once(ws, 'open');
    const received = new Promise<ResponsesWsEvent>((resolve) =>
      ws.on('message', (data) => {
        const event = JSON.parse(String(data)) as ResponsesWsEvent;
        if (event.type === 'response.completed') resolve(event);
      }),
    );
    ws.send(JSON.stringify({ type: 'response.create', model: 'public-model', input: 'hello' }));
    assert.equal((await received).type, 'response.completed');
    assert.equal(state?.authCount, 1);
    assert.equal(state?.settled, 1);
    ws.close();
    await once(ws, 'close');
    await handle.close();
    assert.equal(handle.activeConnections, 0);
  } finally {
    ws.terminate();
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('real WS cancellation keeps the provider response id across created, cancelled and the account pin', {
  timeout: 5_000,
}, async () => {
  let engine: ResponsesWsEngine | undefined;
  let state: ReturnType<typeof fixture>['state'] | undefined;
  const handle = createResponsesWsServer({
    authenticate: async () => ({ ok: true }),
    createEngine: (request) => {
      const f = fixture(request);
      state = f.state;
      state.cancelDispatch = true;
      state.cancelDispatchError = true;
      engine = new ResponsesWsEngine({
        executor: f.executor,
        send: () => {},
        close: () => {},
        idFactory: () => 'gateway-internal-round',
      });
      return engine;
    },
  });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (!handle.handleUpgrade(request, socket, head)) socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
    headers: { authorization: 'Bearer local-proxy-fixture', conversation_id: 'conversation-a' },
  });
  try {
    await once(ws, 'open');
    const received: ResponsesWsEvent[] = [];
    const cancelled = new Promise<ResponsesWsEvent>((resolve) =>
      ws.on('message', (data) => {
        const event = JSON.parse(String(data)) as ResponsesWsEvent;
        received.push(event);
        if (event.type === 'response.created') ws.send(JSON.stringify({ type: 'response.cancel' }));
        if (event.type === 'response.cancelled') resolve(event);
      }),
    );
    ws.send(JSON.stringify({ type: 'response.create', model: 'public-model', input: 'hello' }));
    const terminal = await cancelled;
    const created = received[0];
    assert.ok(created);
    assert.equal((created.response as { id: string }).id, 'response-a');
    assert.equal(terminal.response_id, 'response-a');
    assert.equal(JSON.stringify(received).includes('gateway-internal-round'), false);
    assert.equal(engine?.pinnedIdentity?.upstreamSessionId, 'response-a');
    assert.equal(state?.compensation, 0);
    assert.equal(state?.settled, 0);
    assert.deepEqual(state?.order, ['retained-unknown']);
  } finally {
    ws.terminate();
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('native generation mismatch returns explicit full_context_required without refunding unknown dispatch', async () => {
  const f = fixture();
  const executor = createResponsesWsRoundExecutor({ ...f.options, dispatch: { async dispatch() { return { kind: 'unknown', error: new CodexNativeWsSessionError('full_context_required') } as PreparedEvidenceDispatchResult; } } });
  await assert.rejects(executor.executeRound({ requestId: 'native-mismatch', body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal }), (error) => error instanceof ResponsesWsRoundError && error.code === 'full_context_required' && error.status === 409);
});

test('a public-model alias change cannot reuse the original native identity even with the same resolved model', async () => {
  const f = fixture();
  const first = await f.executor.executeRound({ requestId: 'alias-first', body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
  await assert.rejects(f.executor.executeRound({ requestId: 'alias-second', body: { model: 'different-public-alias', input: 'complete replacement context' }, pinned: first.pinned, cancelSignal: new AbortController().signal }), (error) => error instanceof ResponsesWsRoundError && error.code === 'SESSION_BINDING_CHANGED' && error.status === 409);
  assert.equal(f.state.dispatched, 1);
  assert.equal(f.state.compensation, 1, 'changed identity is rejected before the prepared request is dispatched');
});

function persistentHistoryFixture() {
  const records = new Map<string, ResponsesHistoryRecord>();
  let writes = 0, reads = 0, failWrites = false, now = 100;
  const key = (r: ResponsesHistoryReference) => [r.tenantId, r.projectId, r.proxyKeyId, r.conversationId, r.responseId].join('/');
  const history: ResponsesContinuationHistoryPort = {
    async find(reference, now) { reads++; const saved = records.get(key(reference)); return saved && saved.expiresAtMs > now ? saved : null; },
    async insert(saved) { writes++; if (failWrites) return 'conflict'; const prior = records.get(key(saved)); if (prior) return prior.canonicalContextDigest === saved.canonicalContextDigest ? 'identical' : 'conflict'; records.set(key(saved), saved); return 'inserted'; },
    async delete(reference) { records.delete(key(reference)); }, async purgeExpired() { return 0; },
  };
  const cipher = new AesGcmResponsesHistoryCipher('test-history', new Map([['test-history', new Uint8Array(32).fill(13)]]));
  const resolver = new PersistentResponsesContinuationResolver({ history, cipher, maxBytes: 10000, ttlMs: 1000, nowMs: () => now });
  return { resolver, cipher, clear() { records.clear(); }, advance(milliseconds: number) { now += milliseconds; }, get writes() { return writes; }, get reads() { return reads; }, set failWrites(value: boolean) { failWrites = value; } };
}

test('WS executor actually persists settled output and restores canonical context on a new connection', async () => {
  const history = persistentHistoryFixture();
  try {
    const first = fixture();
    const writer = createResponsesWsRoundExecutor({ ...first.options, continuationHistoryResolver: history.resolver });
    await writer.executeRound({ requestId: 'persistent-first', body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
    assert.equal(history.writes, 1);
    const second = fixture();
    const reader = createResponsesWsRoundExecutor({ ...second.options, continuationHistoryResolver: history.resolver });
    await reader.executeRound({ requestId: 'persistent-second', body: { previous_response_id: 'response-a', input: 'next' }, pinned: null, cancelSignal: new AbortController().signal });
    assert.equal(history.reads, 1);
    assert.equal(second.state.dispatched, 1);
    const body = second.state.preparations[0]!.clientRequest as Record<string, unknown>;
    assert.equal(body.previous_response_id, undefined);
    assert.equal(codexContinuationMode(body), 'canonical-replay');
    assert.deepEqual(body.input, [{ role: 'user', content: 'first' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }, { role: 'user', content: 'next' }]);
  } finally { history.cipher.close(); }
});

test('persistent WS lookup rejects another conversation and prepared account changes before dispatch', async () => {
  const history = persistentHistoryFixture();
  try {
    const first = fixture();
    await createResponsesWsRoundExecutor({ ...first.options, continuationHistoryResolver: history.resolver }).executeRound({ requestId: 'scope-first', body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
    const other = fixture();
    const request = { ...other.options.request, headers: { ...other.options.request.headers, conversation_id: 'other-conversation' } } as IncomingMessage;
    await assert.rejects(createResponsesWsRoundExecutor({ ...other.options, request, continuationHistoryResolver: history.resolver }).executeRound({ requestId: 'other-conversation', body: { previous_response_id: 'response-a', input: 'next' }, pinned: null, cancelSignal: new AbortController().signal }), (error) => error instanceof ResponsesWsRoundError && error.code === 'full_context_required' && error.status === 409);
    assert.equal(other.state.preparations.length, 0);
    for (const changedField of ['tenantId', 'id'] as const) {
      const scoped = fixture();
      const authenticator = { async authenticate(raw: string) { const caller = await scoped.options.authenticator.authenticate(raw); return caller ? { ...caller, metadata: { ...caller.metadata, [changedField]: 'other-scope' } } : null; } };
      await assert.rejects(createResponsesWsRoundExecutor({ ...scoped.options, authenticator, continuationHistoryResolver: history.resolver }).executeRound({ requestId: `other-${changedField}`, body: { previous_response_id: 'response-a', input: 'next' }, pinned: null, cancelSignal: new AbortController().signal }), /resend full context/);
      assert.equal(scoped.state.preparations.length, 0);
    }
    const changed = fixture(); changed.state.account = 'changed-account';
    await assert.rejects(createResponsesWsRoundExecutor({ ...changed.options, continuationHistoryResolver: history.resolver }).executeRound({ requestId: 'changed-account', body: { previous_response_id: 'response-a', input: 'next' }, pinned: null, cancelSignal: new AbortController().signal }), (error) => error instanceof ResponsesWsRoundError && error.code === 'full_context_required');
    assert.equal(changed.state.dispatched, 0);
    assert.equal(changed.state.compensation, 1);
  } finally { history.cipher.close(); }
});

for (const outcome of ['replayed', 'reconciliation_pending', undefined] as const) {
  test(`WS ${String(outcome)} settlement never creates persistent or local continuation`, async () => {
    const history = persistentHistoryFixture();
    try {
      const f = fixture();
      const executor = createResponsesWsRoundExecutor({ ...f.options, continuationHistoryResolver: history.resolver, dispatch: { async dispatch(input) { const result = await f.options.dispatch.dispatch(input); return result.kind === 'sent' ? { ...result, settlementOutcome: outcome } : result; } } });
      const first = await executor.executeRound({ requestId: `not-settled-${String(outcome)}`, body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
      assert.equal(history.writes, 0);
      await assert.rejects(executor.executeRound({ requestId: 'not-settled-next', body: { previous_response_id: 'response-a', input: 'next' }, pinned: first.pinned, cancelSignal: new AbortController().signal }), /resend full context/);
      assert.equal(f.state.dispatched, 1);
    } finally { history.cipher.close(); }
  });
}

test('WS history write failure cannot refund settled inference or promise a local continuation', async () => {
  const history = persistentHistoryFixture(); history.failWrites = true;
  try {
    const f = fixture(); const executor = createResponsesWsRoundExecutor({ ...f.options, continuationHistoryResolver: history.resolver });
    const first = await executor.executeRound({ requestId: 'failed-history', body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
    assert.equal(first.terminal.type, 'response.completed'); assert.equal(f.state.settled, 1); assert.equal(f.state.compensation, 0);
    await assert.rejects(executor.executeRound({ requestId: 'failed-history-next', body: { previous_response_id: 'response-a', input: 'next' }, pinned: first.pinned, cancelSignal: new AbortController().signal }), /resend full context/);
    assert.equal(f.state.dispatched, 1);
  } finally { history.cipher.close(); }
});

test('WS without explicit conversation runs full context but cannot persist or continue by response ID', async () => {
  const history = persistentHistoryFixture();
  try {
    const f = fixture();
    const request = { ...f.options.request, headers: { authorization: f.options.request.headers.authorization } } as IncomingMessage;
    const executor = createResponsesWsRoundExecutor({ ...f.options, request, continuationHistoryResolver: history.resolver });
    const first = await executor.executeRound({ requestId: 'no-conversation', body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
    assert.equal(history.writes, 0);
    await assert.rejects(executor.executeRound({ requestId: 'missing-conversation-next', body: { previous_response_id: 'response-a', input: 'next' }, pinned: first.pinned, cancelSignal: new AbortController().signal }), (error) => error instanceof ResponsesWsRoundError && error.code === 'full_context_required' && error.status === 409);
    assert.equal(history.reads, 0); assert.equal(f.state.dispatched, 1);
  } finally { history.cipher.close(); }
});

test('native same-generation continuation keeps canonical tools and instructions while sending only the new input', async () => {
  const f = fixture(); f.state.nativeMock = true;
  const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];
  const first = await f.executor.executeRound({ requestId: 'native-config-first', body: { model: 'public-model', input: 'first', instructions: 'retain these instructions', tools }, pinned: null, cancelSignal: new AbortController().signal });
  await f.executor.executeRound({ requestId: 'native-config-second', body: { previous_response_id: 'response-a', input: 'next' }, pinned: first.pinned, cancelSignal: new AbortController().signal });
  const body = f.state.preparations[1]!.clientRequest as Record<string, unknown>;
  assert.equal(body.previous_response_id, 'response-a'); assert.equal(body.input, 'next');
  assert.equal(body.instructions, 'retain these instructions'); assert.deepEqual(body.tools, tools);
  assert.equal(codexContinuationMode(body), 'remote-history');
});

for (const invalidation of ['expiry', 'deletion'] as const) {
  test(`a long-lived WS cannot bypass persistent history ${invalidation}`, async () => {
    const history = persistentHistoryFixture();
    try {
      const f = fixture(); const executor = createResponsesWsRoundExecutor({ ...f.options, continuationHistoryResolver: history.resolver });
      const first = await executor.executeRound({ requestId: `authoritative-${invalidation}`, body: { model: 'public-model', input: 'first' }, pinned: null, cancelSignal: new AbortController().signal });
      if (invalidation === 'expiry') history.advance(1001); else history.clear();
      await assert.rejects(executor.executeRound({ requestId: 'expired-next', body: { previous_response_id: 'response-a', input: 'next' }, pinned: first.pinned, cancelSignal: new AbortController().signal }), /resend full context/);
      assert.equal(history.reads, 1); assert.equal(f.state.preparations.length, 1); assert.equal(f.state.dispatched, 1);
    } finally { history.cipher.close(); }
  });
}
