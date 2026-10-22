import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import { BridgeToolChoiceMismatchError } from '../../../src/protocol/openai-to-anth.js';
import { finalizeStream, parseSseStream, type SseEvent } from '../../../src/protocol/sse.js';
import type { PreparedEvidenceTransportRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  ProviderHttpTransport,
  ProviderHttpTransportError,
  type ProviderHttpTransportOptions,
} from '../../../src/saas/gateway/provider-http-transport.js';

const encoder = new TextEncoder();
const payload = encoder.encode(
  JSON.stringify({
    model: 'kimi-for-coding',
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Add 2 and 3.' }],
    tool_choice: { type: 'tool', name: 'add' },
  }),
);
const nativeContent = [
  { type: 'thinking', thinking: 'Call the add tool.', signature: 'fixture-signature' },
  { type: 'redacted_thinking', data: 'fixture-redacted' },
  { type: 'tool_use', id: 'call_add', name: 'add', input: { a: 2, b: 3 } },
];
const nativeUsage = { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 };

function request(overrides: Partial<PreparedRequestEvidenceRecord> = {}): PreparedEvidenceTransportRequest {
  return {
    tenantId: 'tenant',
    projectId: 'project',
    requestId: 'request',
    attemptId: 'attempt',
    fencingToken: 'fence',
    signal: new AbortController().signal,
    payloadBytes: payload,
    evidence: {
      evidenceId: 'evidence',
      tenantId: 'tenant',
      projectId: 'project',
      requestId: 'request',
      attemptId: 'attempt',
      attemptOrdinal: 1,
      supplyMode: 'byok',
      publicModel: 'public-alias',
      protocol: 'openai',
      clientProtocol: 'openai',
      providerProtocol: 'anthropic',
      clientOperation: 'chat.completions',
      providerOperation: 'messages',
      resolvedModel: 'kimi-for-coding',
      endpoint: 'server-owned-kimi-endpoint',
      upstreamId: 'upstream',
      accountId: 'account',
      credentialId: 'credential',
      credentialVersion: '1',
      routeTargetMode: 'tenant_account',
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      statementSha256: 'b'.repeat(64),
      status: 'claimed',
      claimedAt: '2026-10-21T00:00:00.000Z',
      claimedAttemptId: 'attempt',
      expiresAt: '2026-10-21T01:00:00.000Z',
      ...overrides,
    },
  };
}

function transport(response: () => Response, overrides: Partial<ProviderHttpTransportOptions> = {}) {
  return new ProviderHttpTransport({
    fetch: async () => response(),
    timeoutMs: 10_000,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    createConnector: () => ({ dispatcher: {} as Dispatcher, close: async () => {}, destroy: async () => {} }),
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/coding/v1/messages' }),
    resolveCredential: async (_input, use) => use({ headerName: 'x-api-key', value: 'transient-fixture' }),
    ...overrides,
  });
}

function nativeResponse() {
  return {
    id: 'message_fixture',
    type: 'message',
    role: 'assistant',
    model: 'kimi-for-coding',
    content: nativeContent,
    stop_reason: 'tool_use',
    usage: nativeUsage,
  };
}

test('SaaS JSON bridge converts signed OpenAI→Anthropic responses while metering raw cache-inclusive usage', async () => {
  const raw = JSON.stringify(nativeResponse());
  const result = await transport(
    () =>
      new Response(raw, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(raw.length),
          'content-encoding': 'identity',
          etag: 'native-etag',
          'x-request-id': 'provider-request',
        },
      }),
  ).send(request({ clientProtocol: undefined }));
  assert.equal(result.providerUsage, null);
  assert.equal(result.headers?.['content-length'], undefined);
  assert.equal(result.headers?.['content-encoding'], undefined);
  assert.equal(result.headers?.etag, undefined);
  assert.equal(result.headers?.['x-request-id'], 'provider-request');
  const body = await new Response(result.body).json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.reasoning_content, 'Call the add tool.');
  assert.deepEqual(body.choices[0].message.anthropic_content, nativeContent);
  assert.deepEqual(body.choices[0].message.tool_calls[0], {
    id: 'call_add',
    type: 'function',
    function: { name: 'add', arguments: '{"a":2,"b":3}' },
  });
  assert.equal(result.providerUsage?.inputTotal, 10);
  assert.equal(result.providerUsage?.cacheRead, 2);
  assert.equal(result.providerUsage?.outputTotal, 4);
  assert.equal(result.usageEvidence?.meteringSource, 'provider-json-usage-observer');
});

function event(name: string, value: Record<string, unknown>): SseEvent {
  return { event: name, data: JSON.stringify({ type: name, ...value }) };
}

function nativeEvents(): SseEvent[] {
  return [
    event('message_start', {
      message: {
        id: 'message_fixture',
        type: 'message',
        role: 'assistant',
        model: 'kimi-for-coding',
        content: [],
        usage: { ...nativeUsage, output_tokens: 0 },
      },
    }),
    event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Call the add tool.' } }),
    event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', { index: 1, content_block: nativeContent[1] }),
    event('content_block_stop', { index: 1 }),
    event('content_block_start', {
      index: 2,
      content_block: { type: 'tool_use', id: 'call_add', name: 'add', input: {} },
    }),
    event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":2,"b":3}' } }),
    event('content_block_stop', { index: 2 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
    event('message_stop', {}),
  ];
}

test('SaaS SSE bridge preserves reasoning/signatures/tool finish and observes provider usage before conversion', async () => {
  const result = await transport(
    () => new Response(finalizeStream(nativeEvents()), { headers: { 'content-type': 'text/event-stream' } }),
  ).send(request({ clientProtocol: undefined }));
  assert.ok(result.body);
  const chunks: any[] = [];
  let done = false;
  for await (const item of parseSseStream(result.body)) {
    if (item.data === '[DONE]') done = true;
    else chunks.push(JSON.parse(item.data));
  }
  assert.equal(done, true);
  const deltas = chunks.map((chunk) => chunk.choices[0].delta);
  assert.equal(deltas.map((delta) => delta.reasoning_content ?? '').join(''), 'Call the add tool.');
  assert.deepEqual(deltas.find((delta) => delta.anthropic_content)?.anthropic_content, nativeContent);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(result.providerUsage?.inputTotal, 10);
  assert.equal(result.providerUsage?.cacheRead, 2);
  assert.equal(result.providerUsage?.outputTotal, 4);
  assert.equal(result.usageEvidence?.meteringSource, 'provider-sse-usage-observer');
});

test('SaaS SSE response emits before provider completion, applies backpressure and propagates cancellation', async () => {
  let cancelled = false;
  let destroyed = false;
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(finalizeStream([nativeEvents()[0]]));
        else
          controller.enqueue(
            finalizeStream([event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'more' } })]),
          );
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await transport(() => new Response(source, { headers: { 'content-type': 'text/event-stream' } }), {
    createConnector: () => ({
      dispatcher: {} as Dispatcher,
      close: async () => {},
      destroy: async () => {
        destroyed = true;
      },
    }),
  }).send(request());
  assert.ok(result.body);
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(new TextDecoder().decode(first.value).includes('chat.completion.chunk'));
  assert.ok(pulls < 10, 'the bridge must not drain the full upstream while the client is paused');
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(destroyed, true);
  assert.equal(result.providerUsage, null);
});

test('SaaS bridge rejects malformed JSON and bounds JSON/SSE response bytes', async () => {
  for (const [contentType, response, cap] of [
    ['application/json', '{malformed', 1024],
    ['application/json', JSON.stringify(nativeResponse()), 64],
    ['text/event-stream', new TextDecoder().decode(finalizeStream(nativeEvents())), 64],
  ] as const) {
    const result = await transport(() => new Response(response, { headers: { 'content-type': contentType } }), {
      maxBridgedResponseBytes: cap,
    }).send(request());
    await assert.rejects(
      () => new Response(result.body).text(),
      (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'INVALID_RESPONSE',
    );
  }
});

test('SaaS named-tool mismatch fails the client response and retains actual completed provider usage', async () => {
  const nativePayload = encoder.encode(
    JSON.stringify({
      model: 'kimi-for-coding',
      tool_choice: { type: 'any' },
      tools: [{ name: 'add', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Add 2 and 3.' }],
      thinking: { type: 'disabled' },
    }),
  );
  const boundRequest = request();
  for (const streaming of [false, true]) {
    const raw = streaming
      ? finalizeStream([
          nativeEvents()[0],
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '5' } }),
          event('content_block_stop', { index: 0 }),
          event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
          event('message_stop', {}),
        ])
      : JSON.stringify({ ...nativeResponse(), content: [{ type: 'text', text: '5' }], stop_reason: 'end_turn' });
    const result = await transport(
      () => new Response(raw, { headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } }),
    ).send({
      ...boundRequest,
      payloadBytes: nativePayload,
      evidence: { ...boundRequest.evidence, payloadSha256: createHash('sha256').update(nativePayload).digest('hex') },
    });
    await assert.rejects(() => new Response(result.body).text(), BridgeToolChoiceMismatchError);
    assert.equal(result.providerUsage?.inputTotal, 10);
    assert.equal(result.providerUsage?.outputTotal, 4);
    assert.equal(result.usageEvidence?.completeness, 'complete');
  }
});

test('signed same-protocol and native compact responses retain their exact opaque bytes', async () => {
  for (const compact of [false, true]) {
    const raw = compact
      ? '{ "object": "response.compaction", "id":"compact_fixture", "output":[{"type":"compaction","encrypted_content":"opaque-fixture"}], "usage":{"input_tokens":4,"output_tokens":1} }'
      : JSON.stringify(nativeResponse());
    const evidence = compact
      ? {
          protocol: 'responses' as const,
          clientProtocol: 'responses' as const,
          providerProtocol: 'responses' as const,
          clientOperation: 'responses.compact',
          providerOperation: 'responses.compact',
        }
      : { protocol: 'anthropic' as const, clientProtocol: 'anthropic' as const };
    const result = await transport(
      () =>
        new Response(raw, { headers: { 'content-type': 'application/json', 'content-length': String(raw.length) } }),
    ).send(request(evidence));
    assert.equal(await new Response(result.body).text(), raw);
    assert.equal(result.headers?.['content-length'], String(raw.length));
  }
});

test('unsigned operation overrides and contradictory signed client protocols fail before provider dispatch', async () => {
  let sent = 0;
  const instance = transport(() => {
    sent++;
    return new Response(JSON.stringify(nativeResponse()), { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(
    () => instance.send(request({ protocol: 'anthropic' })),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'PAYLOAD_BINDING_MISMATCH',
  );
  await assert.rejects(
    () => instance.send({ ...request(), clientOperation: 'messages' }),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'PAYLOAD_BINDING_MISMATCH',
  );
  assert.equal(sent, 0);
});
