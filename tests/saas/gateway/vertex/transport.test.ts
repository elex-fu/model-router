import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  VertexHttpTransport,
  VertexHttpTransportError,
  VertexPreparedEvidenceTransport,
  type VertexTransportRequest,
  type VertexUpstreamCredential,
} from '../../../../src/saas/gateway/vertex/transport.js';

const CREDENTIAL: VertexUpstreamCredential = {
  accessToken: 'vertex-access-token',
  projectId: 'proj-4242',
  location: 'us-central1',
  vertexModelLocations: null,
};

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function sseResponse(chunks: readonly string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function anthropicBody(): Record<string, unknown> {
  return {
    model: 'claude-opus-4-5',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  };
}

function baseRequest(overrides: Partial<VertexTransportRequest> = {}): VertexTransportRequest {
  return {
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    protocol: 'anthropic',
    model: 'claude-opus-4-5',
    body: anthropicBody(),
    stream: true,
    anthropicBetaHeader: 'context-1m-2025-08-07',
    clientHeaders: { 'user-agent': 'claude-cli/2.0', authorization: 'Bearer client' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Harness {
  readonly seen: SeenRequest[];
  readonly rateLimits: Array<{ accountId: string; resetAtMs: number; source: string }>;
  readonly health: Array<{ accountId: string; kind: string; failover: boolean }>;
  send(request: VertexTransportRequest, response: Response): ReturnType<VertexHttpTransport['send']>;
}

function harness(): Harness {
  const seen: SeenRequest[] = [];
  const rateLimits: Array<{ accountId: string; resetAtMs: number; source: string }> = [];
  const health: Array<{ accountId: string; kind: string; failover: boolean }> = [];
  let nextResponse: Response = sseResponse([]);
  const transport = new VertexHttpTransport({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      seen.push({
        url,
        method: init.method ?? 'POST',
        headers,
        body: JSON.parse(new TextDecoder().decode(init.body as Uint8Array)),
      });
      return nextResponse;
    },
    buildUrl: (input) =>
      `http://127.0.0.1:0/v1/projects/${encodeURIComponent(input.projectId)}/locations/${input.location}/${
        input.protocol
      }/${encodeURIComponent(input.model)}:${input.stream ? 'stream' : 'invoke'}`,
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    writeRateLimit: (record) => {
      rateLimits.push({
        accountId: record.accountId,
        resetAtMs: record.classification.resetAtMs,
        source: record.classification.source,
      });
    },
    recordAccountHealth: (signal) => {
      health.push({ accountId: signal.accountId, kind: signal.classification.kind, failover: signal.failover });
    },
    nowMs: () => 1_700_000_000_000,
  });
  return {
    seen,
    rateLimits,
    health,
    send(request, response) {
      nextResponse = response;
      return transport.send(request);
    },
  };
}

test('the anthropic protocol path posts the vertex body with the filtered beta and Bearer auth', async () => {
  const h = harness();
  const result = await h.send(
    baseRequest({
      anthropicBetaHeader: 'context-1m-2025-08-07,advisor-tool-2026-03-01,context-management-2025-06-27',
      body: { ...anthropicBody(), context_management: { clear_tool_uses: true } },
    }),
    sseResponse(['event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n']),
  );
  assert.equal(result.ok, true);
  const seen = h.seen[0];
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.authorization, 'Bearer vertex-access-token');
  assert.equal(seen.headers['anthropic-beta'], 'context-1m-2025-08-07,context-management-2025-06-27');
  assert.equal(seen.headers['anthropic-version'], undefined);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers['user-agent'], 'claude-cli/2.0');
  // The body drops model, injects anthropic_version and keeps context_management
  // (the context-management beta survived the filter).
  assert.equal('model' in seen.body, false);
  assert.equal((seen.body as Record<string, unknown>).anthropic_version, 'vertex-2023-10-16');
  assert.deepEqual((seen.body as Record<string, unknown>).context_management, { clear_tool_uses: true });
  const text = await new Response(result.ok ? result.body : null).text();
  assert.equal(text, 'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
});

test('an all-unknown beta header omits the header and strips beta-gated body fields', async () => {
  const h = harness();
  await h.send(
    baseRequest({
      anthropicBetaHeader: 'advisor-tool-2026-03-01',
      body: { ...anthropicBody(), context_management: { clear_tool_uses: true } },
    }),
    sseResponse([]),
  );
  const seen = h.seen[0];
  assert.equal('anthropic-beta' in seen.headers, false);
  assert.equal('context_management' in seen.body, false);
});

test('the gemini protocol path posts the compiled body unchanged with Bearer auth', async () => {
  const h = harness();
  const result = await h.send(
    baseRequest({
      protocol: 'gemini',
      model: 'gemini-2.5-pro',
      stream: true,
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 16 } },
    }),
    sseResponse([
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":0}}\n\n',
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7,"cachedContentTokenCount":3}}\n\n',
    ]),
  );
  assert.equal(result.ok, true);
  const seen = h.seen[0];
  assert.equal(seen.headers.authorization, 'Bearer vertex-access-token');
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers.accept, 'text/event-stream');
  assert.deepEqual(seen.body, {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 16 },
  });
  // The terminal usageMetadata chunk is merged out of the stream.
  const usage = await (result.ok ? result.usage : Promise.resolve(null));
  assert.deepEqual(usage, { inputTokens: 8, cacheReadTokens: 3, outputTokens: 7 });
});

test('a 429 writes the classification through the throttled sink', async () => {
  const h = harness();
  const result = await h.send(
    baseRequest(),
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39s' }],
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 429);
    assert.equal(result.rateLimitWritten, true);
    assert.equal(result.bodyText !== null && result.bodyText.includes('RESOURCE_EXHAUSTED'), true);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.rateLimits.length, 1);
  assert.equal(h.rateLimits[0].source, 'retry-info');
  assert.equal(h.rateLimits[0].resetAtMs, 1_700_000_039_000);
});

test('an upstream error records the health signal and failover decision', async () => {
  const h = harness();
  // 503 classifies transient: surfaced as-is, no in-flight failover.
  const transient = await h.send(baseRequest(), new Response('nope', { status: 503 }));
  assert.equal(transient.ok, false);
  if (!transient.ok) {
    assert.equal(transient.status, 503);
    assert.equal(transient.classification.kind, 'transient');
    assert.equal(transient.failover, false);
  }
  // 529 overloaded: failover to another account.
  const overloaded = await h.send(baseRequest(), new Response('overloaded', { status: 529 }));
  assert.equal(overloaded.ok, false);
  if (!overloaded.ok) {
    assert.equal(overloaded.classification.kind, 'overloaded');
    assert.equal(overloaded.failover, true);
  }
  assert.equal(h.health.length, 2);
  assert.equal(h.health[0].accountId, 'account-1');
  assert.equal(h.health[1].failover, true);
});

test('invalid requests and credentials fail closed', async () => {
  const h = harness();
  await assert.rejects(
    h.send(baseRequest({ protocol: 'openai' as unknown as 'anthropic' }), sseResponse([])),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    h.send(baseRequest({ model: '' }), sseResponse([])),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    h.send(baseRequest({ body: 'nope' }), sseResponse([])),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'INVALID_INPUT',
  );
  const badCredential = new VertexHttpTransport({
    fetch: async () => new Response('{}'),
    buildUrl: () => 'http://127.0.0.1:0/x',
    resolveCredential: async (_input, useCredential) => useCredential({ ...CREDENTIAL, accessToken: '' }),
  });
  await assert.rejects(
    badCredential.send(baseRequest()),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'CREDENTIAL_INVALID',
  );
  const noProject = new VertexHttpTransport({
    fetch: async () => new Response('{}'),
    buildUrl: () => 'http://127.0.0.1:0/x',
    resolveCredential: async (_input, useCredential) =>
      useCredential({ accessToken: 't', projectId: '', location: null, vertexModelLocations: null }),
  });
  await assert.rejects(
    noProject.send(baseRequest()),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'CREDENTIAL_INVALID',
  );
});

test('redirects are rejected, not followed', async () => {
  const h = harness();
  await assert.rejects(
    h.send(baseRequest(), new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'REDIRECT_REJECTED',
  );
});

function evidenceRecord(overrides: Partial<PreparedRequestEvidenceRecord> = {}): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'ev-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    requestId: 'req-1',
    attemptId: 'att-1',
    attemptOrdinal: 1,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    publicModel: 'vertex/claude-opus-4-5',
    protocol: 'anthropic',
    resolvedModel: 'claude-opus-4-5',
    clientProtocol: 'anthropic',
    providerProtocol: 'anthropic',
    endpoint: 'vertex-raw-predict',
    upstreamId: 'up-1',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    routeTargetMode: 'platform-pool',
    payloadSha256: '',
    statementSha256: 's',
    status: 'claimed',
    claimedAt: '2026-10-16T00:00:00Z',
    claimedAttemptId: 'att-1',
    expiresAt: '2026-10-16T00:05:00Z',
    ...overrides,
  } as PreparedRequestEvidenceRecord;
}

function adapterInput(body: unknown, evidence: PreparedRequestEvidenceRecord): PreparedEvidenceTransportRequest {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    tenantId: evidence.tenantId,
    projectId: evidence.projectId,
    requestId: evidence.requestId,
    attemptId: evidence.attemptId,
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: { ...evidence, payloadSha256: createHash('sha256').update(payloadBytes).digest('hex') },
  };
}

test('the prepared-evidence adapter dispatches by the signed provider protocol', async () => {
  let seenContextProtocol: string | null = null;
  const adapter = new VertexPreparedEvidenceTransport({
    fetch: async () => sseResponse(['data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n']),
    buildUrl: (input) => `http://127.0.0.1:0/${input.protocol}/${input.model}`,
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: (evidence) => {
      seenContextProtocol = evidence.providerProtocol ?? null;
      return {
        protocol: (evidence.providerProtocol ?? 'anthropic') === 'gemini' ? 'gemini' : 'anthropic',
        model: evidence.resolvedModel ?? 'claude-opus-4-5',
        stream: true,
        anthropicBetaHeader: null,
        clientHeaders: {},
      };
    },
  });
  // Gemini-protocol evidence routes onto the gemini endpoint family and the
  // usage observer is exposed.
  const result = await adapter.send(
    adapterInput(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      evidenceRecord({ providerProtocol: 'gemini', resolvedModel: 'gemini-2.5-pro' }),
    ),
  );
  assert.equal(seenContextProtocol, 'gemini');
  assert.equal(result.resultHttpStatus, 200);
  assert.equal(result.headers['content-type'], 'text/event-stream');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(result.providerUsage?.status, 'reported');
  assert.equal(result.providerUsage?.source, 'upstream');
  assert.equal(result.providerUsage?.inputTotal, 3);
  assert.equal(result.providerUsage?.outputTotal, 4);

  // A payload digest mismatch fails closed.
  const mismatch = adapterInput({ contents: [] }, evidenceRecord());
  await assert.rejects(
    adapter.send({ ...mismatch, payloadBytes: new TextEncoder().encode('{"tampered":true}') }),
    (error: unknown) => error instanceof VertexHttpTransportError && error.code === 'INVALID_INPUT',
  );
});
