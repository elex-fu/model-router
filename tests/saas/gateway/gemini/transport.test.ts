import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GEMINI_CLI_BASE_URL, GEMINI_CLI_HOST } from '../../../../src/saas/gateway/gemini/catalog-identity.js';
import { GEMINI_CLI_USER_AGENT } from '../../../../src/saas/gateway/gemini/constants.js';
import {
  type GeminiAccountHealthSink,
  GeminiHttpTransport,
  GeminiHttpTransportError,
  GeminiPreparedEvidenceTransport,
  type GeminiRateLimitSink,
  type GeminiTransportRequest,
  type GeminiUpstreamCredential,
} from '../../../../src/saas/gateway/gemini/transport.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';

const CREDENTIAL: GeminiUpstreamCredential = {
  accessToken: 'accs-gemini-token',
  projectId: 'proj-4242',
  tierId: 'gcp_standard',
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

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function wrappedBody(): Record<string, unknown> {
  return {
    model: 'gemini-2.5-pro',
    project: 'proj-4242',
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  };
}

function baseRequest(overrides: Partial<GeminiTransportRequest> = {}): GeminiTransportRequest {
  return {
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    model: 'gemini-2.5-pro',
    body: wrappedBody(),
    stream: true,
    tierId: 'gcp_standard',
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Harness {
  readonly seen: SeenRequest[];
  readonly rateLimits: Array<{ accountId: string; resetAtMs: number; fromStatus: number }>;
  readonly health: Array<{ accountId: string; kind: string; failover: boolean }>;
  request(overrides: Partial<GeminiTransportRequest>, response: Response): ReturnType<GeminiHttpTransport['send']>;
}

function harness(options: { baseUrl?: string } = {}): Harness {
  const seen: SeenRequest[] = [];
  const rateLimits: Array<{ accountId: string; resetAtMs: number; fromStatus: number }> = [];
  const health: Array<{ accountId: string; kind: string; failover: boolean }> = [];
  let nextResponse: Response = sseResponse([]);
  const transport = new GeminiHttpTransport({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      seen.push({ url, method: init.method ?? 'POST', headers, body: JSON.parse(String(init.body)) });
      return nextResponse;
    },
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    writeRateLimit: (async (record) => {
      rateLimits.push({
        accountId: record.accountId,
        resetAtMs: record.classification.resetAtMs,
        fromStatus: record.fromStatus,
      });
    }) as GeminiRateLimitSink,
    recordAccountHealth: (async (signal) => {
      health.push({ accountId: signal.accountId, kind: signal.classification.kind, failover: signal.failover });
    }) as GeminiAccountHealthSink,
  });
  return {
    seen,
    rateLimits,
    health,
    request(overrides, response) {
      nextResponse = response;
      return transport.send(baseRequest(overrides));
    },
  };
}

test('the streaming request pins the v1internal action, headers and wrapped body', async () => {
  const h = harness();
  const result = await h.request({}, sseResponse([]));
  assert.equal(result.ok, true);
  assert.equal(h.seen.length, 1);
  const request = h.seen[0];
  assert.equal(request.url, `${GEMINI_CLI_BASE_URL}/v1internal:streamGenerateContent?alt=sse`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.host, GEMINI_CLI_HOST);
  assert.equal(request.headers.authorization, 'Bearer accs-gemini-token');
  assert.equal(request.headers['user-agent'], GEMINI_CLI_USER_AGENT);
  assert.equal(GEMINI_CLI_USER_AGENT, 'GeminiCLI/0.1.5 (Windows; AMD64)');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.accept, 'text/event-stream');
  assert.deepEqual(request.body, wrappedBody());
});

test('the SSE relay settles usage from the terminal usageMetadata chunk', async () => {
  const h = harness();
  const result = await h.request(
    {},
    sseResponse([
      `data: ${JSON.stringify({
        responseId: 'resp-1',
        model: 'gemini-2.5-pro',
        candidates: [{ content: { parts: [{ text: '4' }] } }],
      })}\n\n`,
      // A wrapped Code Assist chunk unwraps before the usage is read.
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: '2' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
        },
      })}\n\n`,
    ]),
  );
  assert.equal(result.ok, true);
  const usage = await result.usage;
  assert.deepEqual(usage, { inputTokens: 10, cacheReadTokens: null, outputTokens: 2 });
  // The client stream relays the upstream bytes unchanged.
  assert.ok(result.body);
  const text = await new Response(result.body).text();
  assert.ok(text.includes('"text":"4"'));
  assert.ok(text.includes('finishReason":"STOP"'));
});

test('the non-streaming action drops alt=sse and relays the JSON body', async () => {
  const h = harness();
  const payload = {
    candidates: [{ content: { parts: [{ text: '42' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  };
  const result = await h.request({ stream: false }, jsonResponse(payload));
  assert.equal(result.ok, true);
  const request = h.seen[0];
  assert.equal(request.url, `${GEMINI_CLI_BASE_URL}/v1internal:generateContent`);
  assert.equal(request.url.includes('alt=sse'), false);
  assert.equal(request.headers.accept, 'application/json');
  assert.ok(result.body);
  const text = await new Response(result.body).text();
  assert.deepEqual(JSON.parse(text), payload);
});

test('a 429 with a Google error body writes through the throttled sink and classifies rate-limited', async () => {
  const h = harness();
  const before = Date.now();
  const result = await h.request(
    {},
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Rate limit exceeded. Quota: GenerateRequestsPerMinutePerProjectPerModel.',
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.rateLimitWritten, true);
  assert.equal(h.rateLimits.length, 1);
  assert.equal(h.rateLimits[0].accountId, 'account-1');
  assert.equal(h.rateLimits[0].fromStatus, 429);
  // gcp_standard tier cooldown: 5 minutes from now.
  const after = Date.now();
  assert.ok(h.rateLimits[0].resetAtMs >= before + 5 * 60_000 - 1_000);
  assert.ok(h.rateLimits[0].resetAtMs <= after + 5 * 60_000 + 1_000);
  // The shared classifier split the failure into health + failover signals.
  assert.equal(h.health[0].kind, 'rate-limited');
  assert.equal(h.health[0].failover, true);

  // Throttled: an immediate second 429 does not write again.
  const second = await h.request(
    {},
    new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'again' } }), {
      status: 429,
    }),
  );
  assert.equal(second.ok, false);
  assert.equal(second.rateLimitWritten, false);
  assert.equal(h.rateLimits.length, 1);
  assert.equal(h.health.length, 2);
});

test('a 401 classifies auth-expired (no failover) or auth-revoked (failover) per the body', async () => {
  const expired = harness();
  const expiredResult = await expired.request(
    {},
    new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'credentials expired' } }), {
      status: 401,
    }),
  );
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.classification.kind, 'auth-expired');
  assert.equal(expiredResult.failover, false);
  assert.equal(expired.rateLimits.length, 0);

  const revoked = harness();
  const revokedResult = await revoked.request(
    {},
    new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'token_revoked' } }), {
      status: 401,
    }),
  );
  assert.equal(revokedResult.ok, false);
  assert.equal(revokedResult.classification.kind, 'auth-revoked');
  assert.equal(revokedResult.failover, true);
});

test('non-429 failures never trigger the rate-limit sink; 5xx is transient', async () => {
  const h = harness();
  const result = await h.request({}, new Response('upstream unavailable', { status: 503 }));
  assert.equal(result.ok, false);
  assert.equal(h.rateLimits.length, 0);
  assert.equal(h.health[0].kind, 'transient');
  assert.equal(h.health[0].failover, false);
});

test('invalid credentials and inputs fail closed', async () => {
  const noProject = new GeminiHttpTransport({
    fetch: async () => sseResponse([]),
    resolveCredential: async (_input, useCredential) => useCredential({ ...CREDENTIAL, projectId: '   ' }),
  });
  await assert.rejects(noProject.send(baseRequest()), (error: unknown) => {
    assert.ok(error instanceof GeminiHttpTransportError);
    assert.equal(error.code, 'CREDENTIAL_INVALID');
    return true;
  });
  const noToken = new GeminiHttpTransport({
    fetch: async () => sseResponse([]),
    resolveCredential: async (_input, useCredential) => useCredential({ ...CREDENTIAL, accessToken: '' }),
  });
  await assert.rejects(noToken.send(baseRequest()), (error: unknown) => {
    assert.ok(error instanceof GeminiHttpTransportError);
    assert.equal(error.code, 'CREDENTIAL_INVALID');
    return true;
  });
  const transport = new GeminiHttpTransport({
    fetch: async () => sseResponse([]),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
  });
  await assert.rejects(transport.send(baseRequest({ body: 'not an object' })), (error: unknown) => {
    assert.ok(error instanceof GeminiHttpTransportError);
    assert.equal(error.code, 'INVALID_INPUT');
    return true;
  });
  await assert.rejects(transport.send(baseRequest({ accountId: '' })), (error: unknown) => {
    assert.ok(error instanceof GeminiHttpTransportError);
    assert.equal(error.code, 'INVALID_INPUT');
    return true;
  });
  await assert.rejects(transport.send(baseRequest({ model: '' })), (error: unknown) => {
    assert.ok(error instanceof GeminiHttpTransportError);
    assert.equal(error.code, 'INVALID_INPUT');
    return true;
  });
});

test('redirects are rejected and local test upstreams are allowed', async () => {
  const h = harness();
  await assert.rejects(
    h.request({}, new Response(null, { status: 302, headers: { location: 'https://evil.test' } })),
    (error: unknown) => {
      assert.ok(error instanceof GeminiHttpTransportError);
      assert.equal(error.code, 'REDIRECT_REJECTED');
      return true;
    },
  );
  const local = harness({ baseUrl: 'http://127.0.0.1:9999' });
  const result = await local.request({}, sseResponse([]));
  assert.equal(result.ok, true);
  assert.equal(local.seen[0].url, 'http://127.0.0.1:9999/v1internal:streamGenerateContent?alt=sse');
  assert.throws(
    () =>
      new GeminiHttpTransport({
        fetch: async () => sseResponse([]),
        baseUrl: 'http://evil.test',
        resolveCredential: async (_i, u) => u(CREDENTIAL),
      }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiHttpTransportError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* Prepared-evidence dispatch adapter (GeminiPreparedEvidenceTransport) */
/* ------------------------------------------------------------------ */

function evidenceRecord(payloadBytes: Uint8Array): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'ev-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'req-1',
    endpoint: 'gemini-generate-content',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    status: 'claimed',
    claimedAttemptId: 'attempt-1',
  } as unknown as PreparedRequestEvidenceRecord;
}

function evidenceTransportRequest(payloadBytes: Uint8Array): PreparedEvidenceTransportRequest {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'req-1',
    attemptId: 'attempt-1',
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: evidenceRecord(payloadBytes),
  };
}

const TERMINAL_USAGE_CHUNK = `data: ${JSON.stringify({
  response: {
    candidates: [{ content: { parts: [{ text: '2' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  },
})}\n\n`;

test('prepared-evidence adapter rejects payload bytes that do not match the signed digest', async () => {
  const transport = new GeminiPreparedEvidenceTransport({
    fetch: async () => sseResponse([TERMINAL_USAGE_CHUNK]),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: 'gemini-2.5-pro', stream: true }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(wrappedBody()));
  const request = evidenceTransportRequest(payloadBytes);
  (request.evidence as { payloadSha256: string }).payloadSha256 = createHash('sha256').update('tampered').digest('hex');
  await assert.rejects(
    () => transport.send(request),
    (error: unknown) => error instanceof GeminiHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter rejects evidence that is not bound to the request attempt', async () => {
  const transport = new GeminiPreparedEvidenceTransport({
    fetch: async () => sseResponse([TERMINAL_USAGE_CHUNK]),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: 'gemini-2.5-pro', stream: true }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(wrappedBody()));
  const request = evidenceTransportRequest(payloadBytes);
  (request.evidence as { status: string }).status = 'registered';
  await assert.rejects(
    () => transport.send(request),
    (error: unknown) => error instanceof GeminiHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter requires a request context resolver', () => {
  assert.throws(
    () =>
      new GeminiPreparedEvidenceTransport({
        fetch: async () => sseResponse([]),
        resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
        resolveRequestContext: undefined as unknown as () => { readonly model: string; readonly stream: boolean },
      }),
    (error: unknown) => error instanceof GeminiHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter threads the dispatch context, relays the signed payload and exposes lazy usage', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const transport = new GeminiPreparedEvidenceTransport({
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return sseResponse([TERMINAL_USAGE_CHUNK]);
    },
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: 'gemini-2.5-pro', stream: true, tierId: 'gcp_standard' }),
  });
  const payload = wrappedBody();
  const response = await transport.send(evidenceTransportRequest(new TextEncoder().encode(JSON.stringify(payload))));
  assert.equal(response.resultHttpStatus, 200);
  assert.equal(response.responseStarted, false);
  assert.ok(response.body instanceof ReadableStream);
  // The stream context selects the SSE action; the signed payload bytes are
  // relayed to the pinned Code Assist endpoint unchanged.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GEMINI_CLI_BASE_URL}/v1internal:streamGenerateContent?alt=sse`);
  assert.deepEqual(calls[0].body, payload);
  // Usage is lazy: it resolves once the terminal usageMetadata chunk is drained.
  const body = response.body;
  assert.ok(body instanceof ReadableStream);
  const reader = body.getReader();
  while (!(await reader.read()).done) {
    // drain
  }
  await new Promise((resolve) => setImmediate(resolve));
  const usage = response.providerUsage;
  assert.ok(usage !== null);
  assert.equal(usage.inputTotal, 10);
  assert.equal(usage.outputTotal, 2);
});

test('prepared-evidence adapter honors the non-stream dispatch context', async () => {
  const calls: Array<{ url: string }> = [];
  const transport = new GeminiPreparedEvidenceTransport({
    fetch: async (url) => {
      calls.push({ url });
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: '42' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      });
    },
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: 'gemini-2.5-pro', stream: false, tierId: null }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(wrappedBody()));
  const response = await transport.send(evidenceTransportRequest(payloadBytes));
  assert.equal(response.resultHttpStatus, 200);
  assert.equal(calls[0].url, `${GEMINI_CLI_BASE_URL}/v1internal:generateContent`);
  assert.ok(response.body instanceof ReadableStream);
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {
    // drain
  }
  await new Promise((resolve) => setImmediate(resolve));
  // The usage watcher is SSE-frame based (same contract as the codex adapter):
  // a non-streaming JSON body carries no usage events, so the lazy accessor
  // stays null and settlement falls back to the gateway's estimation path.
  assert.equal(response.providerUsage, null);
});

test('prepared-evidence adapter surfaces non-2xx results without a body stream', async () => {
  const transport = new GeminiPreparedEvidenceTransport({
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: 'gemini-2.5-pro', stream: true }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(wrappedBody()));
  const response = await transport.send(evidenceTransportRequest(payloadBytes));
  assert.equal(response.resultHttpStatus, 429);
  assert.equal(response.responseStarted, false);
  assert.equal(response.body, null);
});
