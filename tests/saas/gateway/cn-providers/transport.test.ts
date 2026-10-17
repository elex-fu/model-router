import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CN_PROVIDER_MAX_ERROR_BODY_BYTES,
  CnProvidersPreparedEvidenceTransport,
} from '../../../../src/saas/gateway/cn-providers/transport.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';

function transportRequest(endpoint: string): PreparedEvidenceTransportRequest {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes: new Uint8Array(),
    evidence: { endpoint } as PreparedEvidenceTransportRequest['evidence'],
  };
}

function errorBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!(stream instanceof ReadableStream)) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

test('a CN-provider 429 with a balance body classifies insufficient-balance and replays the body', async () => {
  const calls: string[] = [];
  const inner: PreparedEvidenceTransport = {
    async send(input) {
      calls.push(input.evidence.endpoint);
      return {
        responseStarted: false,
        resultHttpStatus: 429,
        headers: {},
        body: errorBody('{"error":{"message":"余额不足，请充值"}}'),
      };
    },
  };
  const adapter = new CnProvidersPreparedEvidenceTransport({ inner });
  const result = await adapter.send(transportRequest('zhipu-glm'));
  assert.deepEqual(calls, ['zhipu-glm']);
  assert.equal(result.upstreamErrorKind, 'insufficient-balance');
  assert.equal(result.resultHttpStatus, 429);
  // The replayed body carries the exact original bytes.
  assert.equal(await readStream(result.body), '{"error":{"message":"余额不足，请充值"}}');
});

test('a CN-provider 429 without a balance body keeps rate-limited; 402 keeps insufficient-balance', async () => {
  const inner: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 429, headers: {}, body: errorBody('rate limited') };
    },
  };
  const adapter = new CnProvidersPreparedEvidenceTransport({ inner });
  const rateLimited = await adapter.send(transportRequest('minimax-m'));
  assert.equal(rateLimited.upstreamErrorKind, 'rate-limited');

  const inner402: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 402, headers: {}, body: errorBody('arrearage') };
    },
  };
  const adapter402 = new CnProvidersPreparedEvidenceTransport({ inner: inner402 });
  const balance = await adapter402.send(transportRequest('zhipu-glm-coding'));
  assert.equal(balance.upstreamErrorKind, 'insufficient-balance');
});

test('non-CN endpoints and success responses pass through untouched', async () => {
  let forwarded = false;
  const success: PreparedEvidenceTransportResponse = {
    responseStarted: false,
    resultHttpStatus: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: errorBody('data: {"type":"message_start"}\n\n'),
    get providerUsage() {
      return null;
    },
  };
  const inner: PreparedEvidenceTransport = {
    async send() {
      forwarded = true;
      return success;
    },
  };
  const adapter = new CnProvidersPreparedEvidenceTransport({ inner });
  // A non-CN endpoint with a non-2xx error body: untouched (no kind, original
  // result object identity).
  const errorResult: PreparedEvidenceTransportResponse = {
    responseStarted: false,
    resultHttpStatus: 500,
    headers: {},
    body: errorBody('boom'),
  };
  const innerMixed: PreparedEvidenceTransport = {
    async send(input) {
      return input.evidence.endpoint === 'opencode-go-zen' ? errorResult : success;
    },
  };
  const mixed = new CnProvidersPreparedEvidenceTransport({ inner: innerMixed });
  const untouched = await mixed.send(transportRequest('opencode-go-zen'));
  assert.equal(untouched, errorResult, 'non-CN endpoint: same object identity');
  assert.equal(untouched.upstreamErrorKind, undefined);
  // A CN endpoint SUCCESS response: untouched.
  forwarded = false;
  const okResult = await adapter.send(transportRequest('zhipu-glm'));
  assert.equal(okResult, success, 'success: same object identity');
  assert.equal(okResult.upstreamErrorKind, undefined);
  assert.equal(forwarded, true);
});

test('an over-cap error body cancels without classification (status-only fallback)', async () => {
  const big = 'x'.repeat(CN_PROVIDER_MAX_ERROR_BODY_BYTES + 1);
  let cancelled = false;
  const inner: PreparedEvidenceTransport = {
    async send() {
      return {
        responseStarted: false,
        resultHttpStatus: 429,
        headers: {},
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    },
  };
  const adapter = new CnProvidersPreparedEvidenceTransport({ inner });
  const result = await adapter.send(transportRequest('zhipu-glm'));
  assert.equal(result.upstreamErrorKind, undefined);
  assert.equal(result.body, null);
  assert.equal(cancelled, true);
});

test('a bodyless error result passes through with no classification', async () => {
  const inner: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 429, headers: {}, body: null };
    },
  };
  const adapter = new CnProvidersPreparedEvidenceTransport({ inner });
  const result = await adapter.send(transportRequest('minimax-m'));
  assert.equal(result.upstreamErrorKind, undefined);
  assert.equal(result.body, null);
});

test('construction requires an inner transport with send', () => {
  assert.throws(() => new CnProvidersPreparedEvidenceTransport({ inner: {} as PreparedEvidenceTransport }), TypeError);
  assert.throws(
    () => new CnProvidersPreparedEvidenceTransport({} as { inner: PreparedEvidenceTransport }),
    TypeError,
  );
});
