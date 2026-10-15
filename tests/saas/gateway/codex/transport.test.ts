import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  accountIdentityNamespace,
  CODEX_BASELINE_VERSION,
  isolateSessionId,
} from '../../../../src/saas/gateway/codex/identity.js';
import {
  CODEX_RESPONSES_ENDPOINT,
  CodexHttpTransport,
  CodexHttpTransportError,
  CodexPreparedEvidenceTransport,
  type CodexQuotaSnapshotSink,
  type CodexTransportRequest,
  type CodexUpstreamCredential,
} from '../../../../src/saas/gateway/codex/transport.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';

const CREDENTIAL: CodexUpstreamCredential = {
  accessToken: 'codex-access-token',
  chatgptAccountId: 'chatgpt-acct-1',
  chatgptUserId: 'chatgpt-user-1',
};

function sseBody(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const COMPLETED_EVENT = {
  type: 'response.completed',
  response: {
    id: 'resp_1',
    model: 'gpt-5.3-codex',
    status: 'completed',
    usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 5 }, output_tokens: 7 },
  },
};

function sseResponse(events: readonly unknown[], headers: Record<string, string> = {}): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function baseRequest(overrides: Partial<CodexTransportRequest> = {}): CodexTransportRequest {
  return {
    accountId: 'acct-1',
    credentialId: 'cred-1',
    credentialVersion: '3',
    proxyKeyId: 'key-1',
    clientSessionId: 'client-session-1',
    clientConversationId: null,
    fingerprintMode: 'off',
    fingerprintSeed: null,
    body: { model: 'gpt-5.3-codex', input: [], instructions: 'inst' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function captureFetch(respond: (call: CapturedCall) => Response | Promise<Response>): {
  readonly calls: CapturedCall[];
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: CapturedCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call: CapturedCall = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}

function resolver(credential: CodexUpstreamCredential = CREDENTIAL) {
  return async <T>(_input: unknown, useCredential: (credential: CodexUpstreamCredential) => Promise<T>): Promise<T> =>
    useCredential(credential);
}

test('request validation rejects malformed input before any fetch', async () => {
  const { calls, fetch } = captureFetch(() => sseResponse([COMPLETED_EVENT]));
  const transport = new CodexHttpTransport({ fetch, resolveCredential: resolver() });

  await assert.rejects(
    () => transport.send(baseRequest({ accountId: '' })),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => transport.send(baseRequest({ fingerprintMode: 'device', fingerprintSeed: null })),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => transport.send(baseRequest({ body: 'not-an-object' as unknown as Record<string, unknown> })),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'INVALID_INPUT',
  );
  assert.equal(calls.length, 0);
});

test('credential validation rejects envelopes without the codex coordinates', async () => {
  const { fetch } = captureFetch(() => sseResponse([COMPLETED_EVENT]));
  const transport = new CodexHttpTransport({
    fetch,
    resolveCredential: resolver({ accessToken: '', chatgptAccountId: 'a', chatgptUserId: 'u' }),
  });
  await assert.rejects(
    () => transport.send(baseRequest()),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'CREDENTIAL_INVALID',
  );
});

test('headers: bearer, account id, canonical identity and whitelist passthrough', async () => {
  const { calls, fetch } = captureFetch(() => sseResponse([COMPLETED_EVENT]));
  const transport = new CodexHttpTransport({ fetch, resolveCredential: resolver() });
  const result = await transport.send(
    baseRequest({
      passthroughHeaders: {
        authorization: 'Bearer client-attempt',
        'user-agent': 'client-agent',
        originator: 'client-originator',
        'x-codex-turn-state': 'client-turn-state',
        'x-custom': 'dropped',
      } as Record<string, string>,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CODEX_RESPONSES_ENDPOINT);
  const headers = calls[0]?.init.headers as Record<string, string>;

  // Credential-derived auth; a client attempt to override it is dropped.
  assert.equal(headers.authorization, `Bearer ${CREDENTIAL.accessToken}`);
  assert.equal(headers['chatgpt-account-id'], CREDENTIAL.chatgptAccountId);

  // The canonical identity trio always wins over client passthrough.
  assert.equal(headers.originator, 'codex_cli_rs');
  assert.equal(headers.version, CODEX_BASELINE_VERSION);
  assert.ok((headers['user-agent'] ?? '').startsWith(`codex_cli_rs/${CODEX_BASELINE_VERSION} (`));
  assert.equal(headers['openai-beta'], 'responses=experimental');

  // Whitelisted x-codex-* passthrough survives; non-whitelisted names do not.
  assert.equal(headers['x-codex-turn-state'], 'client-turn-state');
  assert.equal('x-custom' in headers, false);

  // session_id is namespaced per (proxy key, chatgpt account).
  const namespace = accountIdentityNamespace({
    chatgptAccountId: CREDENTIAL.chatgptAccountId,
    chatgptUserId: CREDENTIAL.chatgptUserId,
  });
  assert.equal(headers.session_id, isolateSessionId('key-1', namespace, 'client-session-1'));

  // Body is serialized verbatim.
  const bodyText = Buffer.from(calls[0]?.init.body as Buffer).toString('utf8');
  assert.deepEqual(JSON.parse(bodyText), { model: 'gpt-5.3-codex', input: [], instructions: 'inst' });
});

test('session namespace differs across accounts (failover isolation)', async () => {
  const seen: string[] = [];
  const spyFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    seen.push((init.headers as Record<string, string>).session_id ?? '');
    return sseResponse([COMPLETED_EVENT]);
  };
  const transport = new CodexHttpTransport({
    fetch: spyFetch,
    resolveCredential: async (_input, useCredential) => {
      const credential: CodexUpstreamCredential = {
        accessToken: 'tok',
        chatgptAccountId: `acct-${seen.length}`,
        chatgptUserId: 'user-1',
      };
      return useCredential(credential);
    },
  });
  await transport.send(baseRequest());
  await transport.send(baseRequest());
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen[0]?.length === 8 && seen[1]?.length === 8);
});

test('quota snapshot sink: written from response headers, throttled per account', async () => {
  const quotaHeaders = {
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-primary-window-minutes': '300',
  };
  const writes: Array<{ accountId: string; used5h: number | null }> = [];
  const writeQuotaSnapshot: CodexQuotaSnapshotSink = (record) => {
    writes.push({ accountId: record.accountId, used5h: record.snapshot.used5hPercent });
  };
  let nowMs = 1_000_000;
  const { fetch } = captureFetch(() => sseResponse([COMPLETED_EVENT], quotaHeaders));
  const transport = new CodexHttpTransport({
    fetch,
    resolveCredential: resolver(),
    writeQuotaSnapshot,
    snapshotMinIntervalMs: 30_000,
    nowMs: () => nowMs,
  });

  const first = await transport.send(baseRequest());
  assert.equal(first.ok && first.quotaSnapshotWritten, true);
  // The sink write is best-effort async; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.accountId, 'acct-1');
  assert.equal(writes[0]?.used5h, 42);

  // Within the throttle window: no second write.
  const second = await transport.send(baseRequest());
  assert.equal(second.ok && second.quotaSnapshotWritten, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);

  // Past the window the snapshot flows again.
  nowMs += 31_000;
  const third = await transport.send(baseRequest());
  assert.equal(third.ok && third.quotaSnapshotWritten, true);
});

test('429: rate-limited classification, failover signal, quota snapshot still written', async () => {
  const health: Array<{ kind: string; failover: boolean }> = [];
  const { fetch } = captureFetch(
    () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300' },
      }),
  );
  const transport = new CodexHttpTransport({
    fetch,
    resolveCredential: resolver(),
    recordAccountHealth: (signal) => {
      health.push({ kind: signal.classification.kind, failover: signal.failover });
    },
    writeQuotaSnapshot: () => undefined,
  });
  const result = await transport.send(baseRequest());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 429);
  assert.equal(result.classification.kind, 'rate-limited');
  assert.equal(result.failover, true);
  assert.equal(result.quotaSnapshotWritten, true);
  assert.equal(result.bodyText, 'rate limited');
  assert.deepEqual(health, [{ kind: 'rate-limited', failover: true }]);
});

test('401 revoked fails over; 401 expired stays on the account for refresh-retry', async () => {
  const mk = (body: string) =>
    new CodexHttpTransport({
      fetch: async () => new Response(body, { status: 401 }),
      resolveCredential: resolver(),
    });
  const revoked = await mk('{"error":{"code":"token_invalidated"}}').send(baseRequest());
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.classification.kind, 'auth-revoked');
    assert.equal(revoked.failover, true);
  }
  const expired = await mk('{"error":{"code":"token_expired"}}').send(baseRequest());
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.classification.kind, 'auth-expired');
    assert.equal(expired.failover, false);
  }
});

test('redirects are rejected instead of followed', async () => {
  const transport = new CodexHttpTransport({
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    resolveCredential: resolver(),
  });
  await assert.rejects(
    () => transport.send(baseRequest()),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'REDIRECT_REJECTED',
  );
});

test('timeout maps to TIMEOUT', async () => {
  const transport = new CodexHttpTransport({
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    resolveCredential: resolver(),
    timeoutMs: 20,
  });
  await assert.rejects(
    () => transport.send(baseRequest()),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'TIMEOUT',
  );
});

test('SSE drain-after-disconnect: client cancel still collects terminal usage', async () => {
  const encoder = new TextEncoder();
  const chunks = [{ type: 'response.output_text.delta', delta: 'Hello' }, COMPLETED_EVENT];
  const upstream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(next)}\n\n`));
    },
  });
  const transport = new CodexHttpTransport({
    fetch: async () => new Response(upstream, { status: 200 }),
    resolveCredential: resolver(),
  });
  const result = await transport.send(baseRequest());
  assert.equal(result.ok, true);
  if (!result.ok || result.body === null) return;

  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  // The client goes away mid-stream; the pump must keep draining upstream so
  // the terminal response.completed usage is still observed.
  await reader.cancel();

  const usage = await result.usage;
  assert.deepEqual(usage, { inputTokens: 12, cachedTokens: 5, outputTokens: 7, reasoningTokens: null });
});

function evidenceRecord(payloadBytes: Uint8Array): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'ev-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'req-1',
    endpoint: 'codex-responses',
    accountId: 'acct-1',
    credentialId: 'cred-1',
    credentialVersion: '3',
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

test('prepared-evidence adapter rejects payload bytes that do not match the signed digest', async () => {
  const transport = new CodexPreparedEvidenceTransport({
    fetch: async () => sseResponse([COMPLETED_EVENT]),
    resolveCredential: resolver(),
    resolveRequestContext: () => ({
      proxyKeyId: 'key-1',
      clientSessionId: null,
      clientConversationId: null,
      fingerprintMode: 'off',
      fingerprintSeed: null,
    }),
  });
  const payloadBytes = new TextEncoder().encode('{"model":"gpt-5.3-codex","input":[]}');
  const request = evidenceTransportRequest(payloadBytes);
  (request.evidence as { payloadSha256: string }).payloadSha256 = createHash('sha256').update('tampered').digest('hex');
  await assert.rejects(
    () => transport.send(request),
    (error: unknown) => error instanceof CodexHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter dispatches a bound request and exposes lazy usage', async () => {
  const transport = new CodexPreparedEvidenceTransport({
    fetch: async () => sseResponse([COMPLETED_EVENT]),
    resolveCredential: resolver(),
    resolveRequestContext: () => ({
      proxyKeyId: 'key-1',
      clientSessionId: null,
      clientConversationId: null,
      fingerprintMode: 'off',
      fingerprintSeed: null,
    }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.3-codex', input: [] }));
  const response = await transport.send(evidenceTransportRequest(payloadBytes));
  assert.equal(response.resultHttpStatus, 200);
  assert.ok(response.body instanceof ReadableStream);
  // Usage is lazy: it resolves once the stream's terminal event is observed.
  const body = response.body;
  assert.ok(body instanceof ReadableStream);
  const reader = body.getReader();
  while (!(await reader.read()).done) {
    // drain
  }
  await new Promise((resolve) => setImmediate(resolve));
  const usage = response.providerUsage;
  assert.ok(usage !== null);
  assert.equal(usage?.inputTotal, 12);
  assert.equal(usage?.outputTotal, 7);
});
