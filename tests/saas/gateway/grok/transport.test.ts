import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { GrokUpstreamCredential } from '../../../../src/saas/gateway/grok/identity.js';
import {
  type GrokAccountHealthSink,
  GrokHttpTransport,
  GrokHttpTransportError,
  GrokPreparedEvidenceTransport,
  type GrokQuotaSnapshotSink,
  type GrokTransportRequest,
  resolveGrokUpstreamUrl,
} from '../../../../src/saas/gateway/grok/transport.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';

const OAUTH_CREDENTIAL: GrokUpstreamCredential = {
  kind: 'oauth',
  accessToken: 'accs-grok-token',
  email: 'ops@example.com',
  userId: 'user-77',
  teamId: 'team-42',
  subscriptionTier: 'supergrok',
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

function baseRequest(overrides: Partial<GrokTransportRequest> = {}): GrokTransportRequest {
  return {
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    model: 'grok-4.6',
    body: { model: 'grok-4.6', input: [] },
    stream: true,
    upstreamPath: 'responses',
    conversationId: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Harness {
  readonly seen: SeenRequest[];
  readonly quotaSnapshots: Array<{ accountId: string; fromStatus: number }>;
  readonly health: Array<{ accountId: string; kind: string; failover: boolean }>;
  request(
    overrides: Partial<GrokTransportRequest>,
    response: Response,
    credential?: GrokUpstreamCredential,
  ): ReturnType<GrokHttpTransport['send']>;
}

function harness(
  options: { readonly baseUrl?: string; readonly operatorHostAllowlist?: readonly string[] } = {},
): Harness {
  const seen: SeenRequest[] = [];
  const quotaSnapshots: Array<{ accountId: string; fromStatus: number }> = [];
  const health: Array<{ accountId: string; kind: string; failover: boolean }> = [];
  let nextResponse: Response = sseResponse([]);
  let credential: GrokUpstreamCredential = OAUTH_CREDENTIAL;
  const transport = new GrokHttpTransport({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      seen.push({ url, method: init.method ?? 'POST', headers, body: JSON.parse(String(init.body)) });
      return nextResponse;
    },
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.operatorHostAllowlist === undefined ? {} : { operatorHostAllowlist: options.operatorHostAllowlist }),
    resolveCredential: async (_input, useCredential) => useCredential(credential),
    writeQuotaSnapshot: (async (record) => {
      quotaSnapshots.push({ accountId: record.accountId, fromStatus: record.fromStatus });
    }) as GrokQuotaSnapshotSink,
    recordAccountHealth: (async (signal) => {
      health.push({ accountId: signal.accountId, kind: signal.classification.kind, failover: signal.failover });
    }) as GrokAccountHealthSink,
  });
  return {
    seen,
    quotaSnapshots,
    health,
    request(overrides, response, nextCredential = OAUTH_CREDENTIAL) {
      credential = nextCredential;
      nextResponse = response;
      return transport.send(baseRequest(overrides));
    },
  };
}

test('SSRF hard gate: an OAuth token only ever targets official xAI hosts', () => {
  // Defaults and explicit official hosts pass for both credential kinds.
  for (const kind of ['oauth', 'api-key'] as const) {
    assert.equal(
      resolveGrokUpstreamUrl({ credentialKind: kind, upstreamPath: 'responses' }).href,
      kind === 'oauth' ? 'https://cli-chat-proxy.grok.com/v1/responses' : 'https://api.x.ai/v1/responses',
    );
    for (const base of ['https://api.x.ai/v1', 'https://us-east-1.api.x.ai/v1', 'https://cli-chat-proxy.grok.com/v1']) {
      assert.equal(
        resolveGrokUpstreamUrl({ credentialKind: kind, baseUrl: base, upstreamPath: 'chat/completions' }).href,
        `${base}/chat/completions`,
      );
    }
  }
  // NEGATIVE: OAuth + custom host is rejected even with an operator allowlist.
  assert.throws(
    () =>
      resolveGrokUpstreamUrl({
        credentialKind: 'oauth',
        baseUrl: 'https://custom.example.com/v1',
        upstreamPath: 'responses',
        operatorHostAllowlist: ['custom.example.com'],
      }),
    (error: unknown) => {
      assert.ok(error instanceof GrokHttpTransportError);
      assert.equal((error as { code?: string }).code, 'HOST_NOT_ALLOWED');
      return true;
    },
  );
  // NEGATIVE: api-key + custom host without the allowlist is rejected.
  assert.throws(
    () =>
      resolveGrokUpstreamUrl({
        credentialKind: 'api-key',
        baseUrl: 'https://custom.example.com/v1',
        upstreamPath: 'responses',
      }),
    (error: unknown) => (error as { code?: string }).code === 'HOST_NOT_ALLOWED',
  );
  // The operator allowlist admits a custom host for api-key credentials only.
  assert.equal(
    resolveGrokUpstreamUrl({
      credentialKind: 'api-key',
      baseUrl: 'https://custom.example.com/v1',
      upstreamPath: 'responses',
      operatorHostAllowlist: ['custom.example.com'],
    }).href,
    'https://custom.example.com/v1/responses',
  );
  // NEGATIVE: http, userinfo, query and fragment are all rejected.
  for (const bad of [
    'http://api.x.ai/v1',
    'https://user:pass@api.x.ai/v1',
    'https://api.x.ai/v1?x=1',
    'https://api.x.ai/v1#f',
    'not-a-url',
  ]) {
    assert.throws(
      () => resolveGrokUpstreamUrl({ credentialKind: 'oauth', baseUrl: bad, upstreamPath: 'responses' }),
      (error: unknown) => (error as { code?: string }).code === 'HOST_NOT_ALLOWED',
      bad,
    );
  }
});

test('CLI masquerade matrix: proxy host carries the identity, api.x.ai does not', async () => {
  // OAuth default base → CLI proxy: identity headers stamped.
  const cli = harness();
  const cliResult = await cli.request({}, sseResponse([]));
  assert.equal(cliResult.ok, true);
  assert.equal(cli.seen.length, 1);
  assert.equal(cli.seen[0]?.url, 'https://cli-chat-proxy.grok.com/v1/responses');
  const cliHeaders = cli.seen[0]?.headers ?? {};
  assert.equal(cliHeaders['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(cliHeaders['x-grok-client-version'], '0.2.120');
  assert.equal(cliHeaders['x-grok-client-identifier'], 'grok-shell');
  assert.equal(cliHeaders['user-agent'], 'xai-grok-workspace/0.2.120');
  assert.equal(cliHeaders.authorization, 'Bearer accs-grok-token');
  assert.equal(cliHeaders.accept, 'text/event-stream');

  // Same credential kind on an api.x.ai base: NO CLI headers.
  const api = harness({ baseUrl: 'https://api.x.ai/v1' });
  await api.request({}, sseResponse([]));
  const apiHeaders = api.seen[0]?.headers ?? {};
  assert.equal(api.seen[0]?.url, 'https://api.x.ai/v1/responses');
  assert.equal(apiHeaders['x-xai-token-auth'], undefined);
  assert.equal(apiHeaders['x-grok-client-version'], undefined);
  assert.equal(apiHeaders['x-grok-client-identifier'], undefined);
  assert.equal(apiHeaders['user-agent'], undefined);
});

test('the conversation reference is stamped as x-grok-conv-id; null omits it', async () => {
  const h = harness();
  await h.request({ conversationId: 'conv-42' }, sseResponse([]));
  assert.equal(h.seen[0]?.headers['x-grok-conv-id'], 'conv-42');
  const h2 = harness();
  await h2.request({ conversationId: null }, sseResponse([]));
  assert.equal(h2.seen[0]?.headers['x-grok-conv-id'], undefined);
});

test('chat/completions upstream path rides the same base and stream semantics', async () => {
  const h = harness();
  await h.request(
    { upstreamPath: 'chat/completions', stream: false, body: { model: 'grok-4.6', messages: [] } },
    sseResponse([]),
  );
  assert.equal(h.seen[0]?.url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
  assert.equal(h.seen[0]?.headers.accept, 'application/json');
});

test('quota headers on a success response feed the throttled snapshot sink', async () => {
  const h = harness();
  const result = await h.request(
    {},
    sseResponse([], {
      'x-ratelimit-limit-tokens': '1000000',
      'x-ratelimit-remaining-tokens': '250000',
      'x-ratelimit-reset-tokens': '60',
      'xai-subscription-tier': 'supergrok',
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rateLimitWritten, true);
  assert.equal(h.quotaSnapshots.length, 1);
  assert.equal(h.quotaSnapshots[0]?.fromStatus, 200);
});

test('a 429 classifies rate-limited with failover and still feeds the snapshot sink', async () => {
  const h = harness();
  const result = await h.request(
    {},
    new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.classification.kind, 'rate-limited');
    assert.equal(result.failover, true);
  }
  assert.equal(h.quotaSnapshots.length, 1);
  assert.equal(h.health.length, 1);
  assert.equal(h.health[0]?.kind, 'rate-limited');
});

test('a 401 classifies auth-expired without failover; input validation fails closed', async () => {
  const h = harness();
  const result = await h.request(
    {},
    new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.classification.kind, /^auth-(expired|revoked)$/);
    // auth-expired does not fail over; auth-revoked does (the shared matrix).
    assert.equal(result.failover, result.classification.kind === 'auth-revoked');
  }
  // Malformed transport requests never reach the fetch.
  await assert.rejects(
    () => h.request({ accountId: '' }, sseResponse([])),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => h.request({ body: 'not-an-object' as unknown as Record<string, unknown> }, sseResponse([])),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  );
});

test('the SSE relay settles usage from the terminal Responses event', async () => {
  const h = harness();
  const terminal = `data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7 },
    },
  })}\n\ndata: [DONE]\n\n`;
  const result = await h.request({}, sseResponse([terminal]));
  assert.equal(result.ok, true);
  if (result.ok) {
    const usage = await result.usage;
    assert.equal(usage?.inputTokens, 11);
    assert.equal(usage?.cachedTokens, 3);
    assert.equal(usage?.outputTokens, 7);
  }
});

test('an OAuth credential with a custom base is rejected inside the credential callback (SSRF gate)', async () => {
  let reachedFetch = false;
  const transport = new GrokHttpTransport({
    fetch: async () => {
      reachedFetch = true;
      return sseResponse([]);
    },
    baseUrl: 'https://attacker.example.com/v1',
    resolveCredential: async (_input, useCredential) => useCredential(OAUTH_CREDENTIAL),
  });
  await assert.rejects(
    () => transport.send(baseRequest()),
    (error: unknown) => {
      assert.ok(error instanceof GrokHttpTransportError);
      assert.equal((error as { code?: string }).code, 'HOST_NOT_ALLOWED');
      return true;
    },
  );
  assert.equal(reachedFetch, false);
});

function evidenceRecord(payloadBytes: Uint8Array): PreparedRequestEvidenceRecord {
  return {
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    status: 'claimed',
    claimedAttemptId: 'attempt-1',
  } as unknown as PreparedRequestEvidenceRecord;
}

function evidenceTransportRequest(payloadBytes: Uint8Array): PreparedEvidenceTransportRequest {
  return {
    evidence: evidenceRecord(payloadBytes),
    attemptId: 'attempt-1',
    payloadBytes,
    signal: new AbortController().signal,
  } as unknown as PreparedEvidenceTransportRequest;
}

test('prepared-evidence adapter threads the dispatch context, relays the payload and exposes lazy usage', async () => {
  const payload = Buffer.from(JSON.stringify({ model: 'grok-4.6', input: [] }), 'utf8');
  const terminal = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { usage: { input_tokens: 5, output_tokens: 6 } },
  })}\n\n`;
  const seen: SeenRequest[] = [];
  const adapter = new GrokPreparedEvidenceTransport({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      seen.push({ url, method: init.method ?? 'POST', headers, body: JSON.parse(String(init.body)) });
      return sseResponse([terminal]);
    },
    resolveCredential: async (_input, useCredential) => useCredential(OAUTH_CREDENTIAL),
    resolveRequestContext: () => ({
      model: 'grok-4.6',
      stream: true,
      upstreamPath: 'responses',
      credentialKind: 'oauth',
      conversationId: 'conv-9',
    }),
  });
  const response = await adapter.send(evidenceTransportRequest(new Uint8Array(payload)));
  assert.equal(response.resultHttpStatus, 200);
  assert.ok(response.body);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://cli-chat-proxy.grok.com/v1/responses');
  assert.equal(seen[0]?.headers['x-grok-conv-id'], 'conv-9');
  // Lazy usage accessor settles from the drained terminal event.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const usage = response.providerUsage;
  assert.ok(usage);
  assert.equal(usage.inputTotal, 5);
  assert.equal(usage.outputTotal, 6);
});

test('prepared-evidence adapter rejects tampered payload bytes and unbound evidence', async () => {
  const adapter = new GrokPreparedEvidenceTransport({
    fetch: async () => sseResponse([]),
    resolveCredential: async (_input, useCredential) => useCredential(OAUTH_CREDENTIAL),
    resolveRequestContext: () => ({
      model: 'grok-4.6',
      stream: false,
      upstreamPath: 'responses',
      credentialKind: 'oauth',
      conversationId: null,
    }),
  });
  const payload = Buffer.from('{"model":"grok-4.6"}', 'utf8');
  const tampered = { ...evidenceTransportRequest(new Uint8Array(payload)) } as unknown as {
    payloadBytes: Uint8Array;
    evidence: { payloadSha256: string };
  };
  tampered.payloadBytes = new Uint8Array(Buffer.from('{"model":"evil"}', 'utf8'));
  await assert.rejects(
    () => adapter.send(tampered as unknown as PreparedEvidenceTransportRequest),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  );
  const unbound = evidenceTransportRequest(new Uint8Array(payload));
  (unbound.evidence as { claimedAttemptId?: string }).claimedAttemptId = 'other-attempt';
  await assert.rejects(
    () => adapter.send(unbound),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  );
});
