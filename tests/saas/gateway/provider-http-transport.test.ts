import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { LookupOptions } from 'node:dns';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import { Agent } from 'undici';
import type { PreparedEvidenceTransportRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  createPinnedProviderLookup,
  isGlobalProviderAddress,
  type ProviderHttpAddressResolver,
  type ProviderHttpPinnedConnectorFactory,
} from '../../../src/saas/gateway/provider-http-address.js';
import {
  type ProviderHttpCredentialResolver,
  type ProviderHttpFetch,
  type ProviderHttpFetchInit,
  ProviderHttpTransport,
  ProviderHttpTransportError,
} from '../../../src/saas/gateway/provider-http-transport.js';

const payload = new Uint8Array([0, 1, 2, 255, 10, 13]);
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
const encoder = new TextEncoder();
const TEST_ADDRESS = Object.freeze({ address: '8.8.8.8', family: 4 as const });
const TEST_DISPATCHER = {} as Dispatcher;

const fakeConnectorFactory: ProviderHttpPinnedConnectorFactory = () => ({
  dispatcher: TEST_DISPATCHER,
  close: async () => {},
  destroy: async () => {},
});

function evidence(overrides: Partial<PreparedRequestEvidenceRecord> = {}): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'evidence-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    publicModel: 'model-1',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    upstreamId: 'upstream-1',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '7',
    routeTargetMode: 'tenant_account',
    payloadSha256,
    statementSha256: 'b'.repeat(64),
    status: 'claimed',
    claimedAt: '2026-09-28T00:00:00.000Z',
    claimedAttemptId: 'attempt-1',
    expiresAt: '2026-09-28T00:10:00.000Z',
    ...overrides,
  };
}

function request(overrides: Partial<PreparedEvidenceTransportRequest> = {}): PreparedEvidenceTransportRequest {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes: payload,
    evidence: evidence(),
    ...overrides,
  };
}

function transport(
  fetch: ProviderHttpFetch,
  overrides: Partial<ConstructorParameters<typeof ProviderHttpTransport>[0]> = {},
): ProviderHttpTransport {
  return new ProviderHttpTransport({
    fetch,
    timeoutMs: 500,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [TEST_ADDRESS],
    createConnector: fakeConnectorFactory,
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/dispatch' }),
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'Bearer transient' }),
    ...overrides,
  });
}

function streamFromChunks(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        if (chunk) {
          index += 1;
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}

function splitBytes(bytes: Uint8Array, pattern: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let patternIndex = 0;
  while (offset < bytes.length) {
    const size = pattern[patternIndex % pattern.length] ?? 1;
    const end = Math.min(bytes.length, offset + size);
    chunks.push(bytes.slice(offset, end));
    offset = end;
    patternIndex += 1;
  }
  return chunks;
}

test('resolves the server-owned target, injects credentials transiently, and sends exact payload bytes', async () => {
  let seenUrl = '';
  let seenInit: ProviderHttpFetchInit | undefined;
  let resolverInput: { endpoint: string; signal: AbortSignal } | undefined;
  const fakeFetch: ProviderHttpFetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(null, { status: 202 });
  };
  const result = await transport(fakeFetch, {
    resolveDispatchProfile: async (input) => {
      resolverInput = { endpoint: input.endpoint, signal: input.signal };
      return { url: 'https://provider.example:443/v1/dispatch' };
    },
  }).send(
    request({
      evidence: evidence({ endpoint: 'https://attacker.example/request-controlled-target' }),
    }),
  );

  assert.equal(result.responseStarted, false);
  assert.equal(result.resultHttpStatus, 202);
  assert.deepEqual(result.headers, {});
  assert.equal(result.body, null);
  assert.equal(seenUrl, 'https://provider.example/v1/dispatch');
  assert.equal(resolverInput?.endpoint, 'https://attacker.example/request-controlled-target');
  assert.equal(resolverInput?.signal.aborted, false);
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.redirect, 'manual');
  assert.ok(seenInit?.signal);
  assert.equal(seenInit?.dispatcher, TEST_DISPATCHER);
  assert.deepEqual(
    [...new Headers(seenInit?.headers as HeadersInit)],
    [
      ['accept', 'application/json'],
      ['authorization', 'Bearer transient'],
      ['content-type', 'application/json'],
    ],
  );
  assert.deepEqual(new Uint8Array(seenInit?.body as ArrayBuffer), payload);
  assert.equal('credential' in result, false);
});

test('returns a streaming body with backpressure-compatible chunks and only allowlisted response headers', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });
  const fakeFetch: ProviderHttpFetch = async () =>
    new Response(body, {
      status: 200,
      headers: {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream',
        'set-cookie': 'must-not-forward',
        'x-internal-secret': 'must-not-forward',
        'x-request-id': 'provider-request-1',
      },
    });

  const result = await transport(fakeFetch).send(request());
  assert.equal(result.responseStarted, false);
  assert.deepEqual(result.headers, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
    'x-request-id': 'provider-request-1',
  });
  assert.ok(result.body);
  const reader = result.body.getReader();
  const first = await reader.read();
  const second = await reader.read();
  const done = await reader.read();
  assert.deepEqual([...((first.value ?? new Uint8Array()) as Uint8Array)], [1, 2]);
  assert.deepEqual([...((second.value ?? new Uint8Array()) as Uint8Array)], [3, 4]);
  assert.equal(done.done, true);
});

test('ProviderHttpTransport observes OpenAI Chat SSE only at EOF and forwards exact bytes and headers', async () => {
  const chunks = [
    encoder.encode(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
      })}\n\n`,
    ),
    encoder.encode(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      })}\n\n`,
    ),
    encoder.encode('data: [DONE]\n\n'),
  ];
  const fakeFetch: ProviderHttpFetch = async () =>
    new Response(streamFromChunks(chunks), {
      status: 200,
      headers: {
        'content-type': 'Text/Event-Stream; charset=utf-8',
        etag: 'provider-etag',
        'x-internal-secret': 'must-not-forward',
      },
    });
  const result = await transport(fakeFetch).send(
    request({ evidence: evidence({ providerProtocol: 'openai', providerOperation: 'chat.completions' }) }),
  );

  assert.deepEqual(result.headers, {
    'content-type': 'Text/Event-Stream; charset=utf-8',
    etag: 'provider-etag',
  });
  assert.equal(result.providerUsage, null);
  assert.ok(result.body);
  const reader = result.body.getReader();
  for (const chunk of chunks) {
    const next = await reader.read();
    assert.equal(next.done, false);
    assert.deepEqual(next.value, chunk);
    assert.equal(result.providerUsage, null);
  }
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(result.providerUsage, {
    inputTotal: 12,
    inputUncached: 9,
    cacheRead: 3,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: 7,
    reasoningOutput: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'v1',
  });
});

test('ProviderHttpTransport observes Anthropic Messages SSE across byte boundaries while forwarding exact bytes', async () => {
  const raw = [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 },
          output_tokens: 1,
        },
      },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
  const chunks = splitBytes(encoder.encode(raw), [3, 1, 8, 2, 17]);
  const fakeFetch: ProviderHttpFetch = async () =>
    new Response(streamFromChunks(chunks), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  const result = await transport(fakeFetch).send(
    request({ evidence: evidence({ providerProtocol: 'anthropic', providerOperation: 'messages' }) }),
  );

  assert.equal(result.providerUsage, null);
  assert.ok(result.body);
  const forwarded = await drain(result.body);
  assert.deepEqual(
    forwarded.map((chunk) => [...chunk]),
    chunks.map((chunk) => [...chunk]),
  );
  assert.deepEqual(result.providerUsage, {
    inputTotal: 17,
    inputUncached: 10,
    cacheRead: 4,
    cacheWrite: 3,
    cacheWrite5m: 2,
    cacheWrite1h: 1,
    outputTotal: 5,
    reasoningOutput: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'v1',
  });
});

test('ProviderHttpTransport leaves unsupported, malformed, and missing SSE usage null and cancels upstream on client cancel', async (t) => {
  await t.test('unsupported provider operation', async () => {
    const chunks = [
      encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'),
    ];
    const fakeFetch: ProviderHttpFetch = async () =>
      new Response(streamFromChunks(chunks), { headers: { 'content-type': 'text/event-stream' } });
    const result = await transport(fakeFetch).send(
      request({ evidence: evidence({ providerProtocol: 'openai', providerOperation: 'responses' }) }),
    );
    assert.ok(result.body);
    await drain(result.body);
    assert.equal(result.providerUsage, null);
  });

  await t.test('malformed event', async () => {
    const chunks = [encoder.encode('data: {not-json}\n\n')];
    const fakeFetch: ProviderHttpFetch = async () =>
      new Response(streamFromChunks(chunks), { headers: { 'content-type': 'text/event-stream' } });
    const result = await transport(fakeFetch).send(
      request({ evidence: evidence({ providerProtocol: 'openai', providerOperation: 'chat.completions' }) }),
    );
    assert.ok(result.body);
    await drain(result.body);
    assert.equal(result.providerUsage, null);
  });

  await t.test('missing usage trailer', async () => {
    const chunks = [encoder.encode('data: {"object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]\n\n')];
    const fakeFetch: ProviderHttpFetch = async () =>
      new Response(streamFromChunks(chunks), { headers: { 'content-type': 'text/event-stream' } });
    const result = await transport(fakeFetch).send(
      request({ evidence: evidence({ providerProtocol: 'openai', providerOperation: 'chat.completions' }) }),
    );
    assert.ok(result.body);
    await drain(result.body);
    assert.equal(result.providerUsage, null);
  });

  await t.test('client cancellation', async () => {
    let upstreamCancelled = false;
    const chunks = [encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')];
    let enqueued = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!enqueued) {
            enqueued = true;
            controller.enqueue(chunks[0] as Uint8Array);
          }
          return new Promise<void>(() => {});
        },
        cancel() {
          upstreamCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fakeFetch: ProviderHttpFetch = async () =>
      new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    const result = await transport(fakeFetch).send(
      request({ evidence: evidence({ providerProtocol: 'openai', providerOperation: 'chat.completions' }) }),
    );
    assert.ok(result.body);
    const reader = result.body.getReader();
    assert.deepEqual(await reader.read(), { value: chunks[0], done: false });
    await reader.cancel();
    assert.equal(upstreamCancelled, true);
    assert.equal(result.providerUsage, null);
  });
});

test('non-SSE JSON responses retain the unobserved streaming path', async () => {
  const chunks = [encoder.encode('{"usage":{"prompt_tokens":12}}'), encoder.encode('\n')];
  const fakeFetch: ProviderHttpFetch = async () =>
    new Response(streamFromChunks(chunks), { headers: { 'content-type': 'application/json' } });
  const result = await transport(fakeFetch).send(
    request({ evidence: evidence({ providerProtocol: 'openai', providerOperation: 'chat.completions' }) }),
  );

  assert.equal(result.providerUsage, undefined);
  assert.ok(result.body);
  assert.deepEqual(
    (await drain(result.body)).map((chunk) => [...chunk]),
    chunks.map((chunk) => [...chunk]),
  );
  assert.equal(result.providerUsage, undefined);
});

test('keeps lease cancellation active through body consumption and cancels the upstream reader', async () => {
  let upstreamCancelled = false;
  let fetchSignal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {
        // The lease abort must cancel this pending read.
      });
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const fakeFetch: ProviderHttpFetch = async (_url, init) => {
    fetchSignal = init.signal;
    return new Response(body, { status: 200 });
  };
  const leaseController = new AbortController();
  const result = await transport(fakeFetch).send(request({ signal: leaseController.signal }));
  assert.ok(result.body);
  const reader = result.body.getReader();
  const read = reader.read();
  leaseController.abort();
  await assert.rejects(
    read,
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ABORTED',
  );
  assert.equal(fetchSignal?.aborted, true);
  assert.equal(upstreamCancelled, true);
});

test('reports an upstream body failure without buffering or converting it into a replayable success', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('upstream body failed'));
    },
  });
  const fakeFetch: ProviderHttpFetch = async () => new Response(body, { status: 200 });
  const result = await transport(fakeFetch).send(request());
  assert.ok(result.body);
  await assert.rejects(
    result.body.getReader().read(),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'NETWORK_ERROR',
  );
});

test('requires an exact HTTPS host and port policy before making a fetch call', async () => {
  let fetchCalls = 0;
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  for (const url of [
    'http://provider.example/v1/dispatch',
    'https://user:secret@provider.example/v1/dispatch',
    'https://other.example/v1/dispatch',
    'https://provider.example:8443/v1/dispatch',
    'https://127.1/v1/dispatch',
    'https://2130706433/v1/dispatch',
  ]) {
    await assert.rejects(
      transport(fakeFetch, { resolveDispatchProfile: async () => ({ url }) }).send(request()),
      (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ENDPOINT_POLICY_VIOLATION',
    );
  }
  assert.equal(fetchCalls, 0);
});

test('classifies only globally routable IPv4 and IPv6 addresses as provider destinations', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '168.63.129.16',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isGlobalProviderAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isGlobalProviderAddress(address), true, address);
  }
});

test('rejects private literal IPv4 and IPv6 targets without invoking DNS', async () => {
  let resolverCalls = 0;
  let fetchCalls = 0;
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  for (const [url, allowedHost] of [
    ['https://127.0.0.1/v1/dispatch', '127.0.0.1'],
    ['https://[::1]/v1/dispatch', '[::1]'],
  ]) {
    await assert.rejects(
      transport(fakeFetch, {
        endpointPolicy: { allowedHosts: [allowedHost], allowedPorts: [443] },
        resolveDispatchProfile: async () => ({ url }),
        resolveAddresses: async () => {
          resolverCalls += 1;
          return [TEST_ADDRESS];
        },
      }).send(request()),
      (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ENDPOINT_POLICY_VIOLATION',
    );
  }
  assert.equal(resolverCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('fails closed for private, special-use, and mixed DNS answers before credential injection or connector creation', async () => {
  let credentialCalls = 0;
  let connectorCalls = 0;
  let fetchCalls = 0;
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  const resolverCases = [
    [{ address: '127.0.0.1', family: 4 as const }],
    [{ address: '169.254.169.254', family: 4 as const }],
    [{ address: '198.18.0.1', family: 4 as const }],
    [{ address: '203.0.113.8', family: 4 as const }],
    [{ address: '::ffff:8.8.8.8', family: 6 as const }],
    [
      { address: '2606:4700:4700::1111', family: 6 as const },
      { address: '10.0.0.1', family: 4 as const },
    ],
  ];

  for (const addresses of resolverCases) {
    const instance = transport(fakeFetch, {
      resolveAddresses: async (hostname) => {
        assert.equal(hostname, 'provider.example');
        return addresses;
      },
      createConnector: () => {
        connectorCalls += 1;
        return {
          dispatcher: TEST_DISPATCHER,
          close: async () => {},
          destroy: async () => {},
        };
      },
      resolveCredential: async (_input, useCredential) => {
        credentialCalls += 1;
        return useCredential({ headerName: 'authorization', value: 'Bearer transient' });
      },
    });
    await assert.rejects(
      instance.send(request()),
      (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ENDPOINT_POLICY_VIOLATION',
    );
  }
  assert.equal(credentialCalls, 0);
  assert.equal(connectorCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('fails closed when DNS resolution errors or returns no addresses', async (t) => {
  let fetchCalls = 0;
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  const failingResolvers: readonly (readonly [string, ProviderHttpAddressResolver])[] = [
    [
      'resolver error',
      async () => {
        throw new Error('resolver details stay private');
      },
    ],
    ['empty answer', async () => []],
  ];
  for (const [name, resolveAddresses] of failingResolvers) {
    await t.test(name, async () => {
      await assert.rejects(
        transport(fakeFetch, { resolveAddresses }).send(request()),
        (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ENDPOINT_POLICY_VIOLATION',
      );
    });
  }
  assert.equal(fetchCalls, 0);
});

test('pins the selected DNS answer into the connector while retaining the server-owned hostname', async () => {
  const dispatcher = {} as Dispatcher;
  let seenHost = '';
  let seenUrl = '';
  let seenDispatcher: Dispatcher | undefined;
  let connectorInput: { hostname: string; port: number; address: string; family: 4 | 6 } | undefined;
  let connectorClosed = false;
  let connectorDestroyed = false;
  const fakeFetch: ProviderHttpFetch = async (url, init) => {
    seenUrl = url;
    seenDispatcher = init.dispatcher;
    assert.equal(new Headers(init.headers as HeadersInit).has('host'), false);
    return new Response(null, { status: 202 });
  };
  const result = await transport(fakeFetch, {
    resolveAddresses: async (hostname) => {
      seenHost = hostname;
      return [TEST_ADDRESS, { address: '1.1.1.1', family: 4 }];
    },
    createConnector: (input) => {
      connectorInput = input;
      return {
        dispatcher,
        close: async () => {
          connectorClosed = true;
        },
        destroy: async () => {
          connectorDestroyed = true;
        },
      };
    },
  }).send(request());

  assert.equal(result.resultHttpStatus, 202);
  assert.equal(seenHost, 'provider.example');
  assert.equal(seenUrl, 'https://provider.example/v1/dispatch');
  assert.deepEqual(connectorInput, {
    hostname: 'provider.example',
    port: 443,
    address: '8.8.8.8',
    family: 4,
  });
  assert.equal(seenDispatcher, dispatcher);
  assert.equal(connectorClosed, true);
  assert.equal(connectorDestroyed, false);
});

test('uses the production per-request Undici Agent as the fetch dispatcher', async () => {
  let dispatcher: Dispatcher | undefined;
  const fakeFetch: ProviderHttpFetch = async (_url, init) => {
    dispatcher = init.dispatcher;
    return new Response(null, { status: 204 });
  };
  await transport(fakeFetch, { createConnector: undefined }).send(request());
  assert.ok(dispatcher instanceof Agent);
});

test('the Undici lookup callback can return only the pinned address and rejects hostname changes', async () => {
  const lookup = createPinnedProviderLookup('provider.example', TEST_ADDRESS);
  const single = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup('provider.example', { all: false } satisfies LookupOptions, (error, address, family) => {
      if (error) return reject(error);
      if (typeof address !== 'string' || family === undefined) return reject(new Error('unexpected lookup shape'));
      resolve({ address, family });
    });
  });
  assert.deepEqual(single, TEST_ADDRESS);

  const all = await new Promise<readonly { address: string; family: number }[]>((resolve, reject) => {
    lookup('provider.example', { all: true } satisfies LookupOptions, (error, addresses) => {
      if (error) return reject(error);
      if (!Array.isArray(addresses)) return reject(new Error('expected all-address lookup shape'));
      resolve(addresses);
    });
  });
  assert.deepEqual(all, [TEST_ADDRESS]);

  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      lookup('attacker.example', { all: false }, (error) => (error ? reject(error) : resolve()));
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EHOSTUNREACH',
  );
});

test('destroys a pinned connector when a streaming response is cancelled', async () => {
  let connectorDestroyed = false;
  let enqueued = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!enqueued) {
          enqueued = true;
          controller.enqueue(new Uint8Array([1]));
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel() {},
    },
    { highWaterMark: 0 },
  );
  const fakeFetch: ProviderHttpFetch = async () => new Response(body, { status: 200 });
  const result = await transport(fakeFetch, {
    createConnector: () => ({
      dispatcher: TEST_DISPATCHER,
      close: async () => {},
      destroy: async () => {
        connectorDestroyed = true;
      },
    }),
  }).send(request());
  assert.ok(result.body);
  const reader = result.body.getReader();
  assert.deepEqual(await reader.read(), { value: new Uint8Array([1]), done: false });
  await reader.cancel();
  assert.equal(connectorDestroyed, true);
});

test('rejects payloads whose bytes do not match the prepared-evidence digest', async () => {
  let profileCalls = 0;
  let fetchCalls = 0;
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  await assert.rejects(
    transport(fakeFetch, {
      resolveDispatchProfile: async () => {
        profileCalls += 1;
        return { url: 'https://provider.example/v1/dispatch' };
      },
    }).send(request({ payloadBytes: new Uint8Array([1, 2, 3]) })),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'PAYLOAD_BINDING_MISMATCH',
  );
  assert.equal(profileCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('uses manual redirect handling and rejects every 3xx response', async () => {
  let redirectMode: RequestInit['redirect'];
  const fakeFetch: ProviderHttpFetch = async (_url, init) => {
    redirectMode = init.redirect;
    return new Response(null, { status: 307, headers: { location: 'https://other.example/redirect' } });
  };
  await assert.rejects(
    transport(fakeFetch).send(request()),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'REDIRECT_REJECTED',
  );
  assert.equal(redirectMode, 'manual');
});

test('requires a server-side credential resolver and never exposes raw credential material in the result', async () => {
  let callbackCalls = 0;
  const credentialResolver: ProviderHttpCredentialResolver = async (_input, useCredential) => {
    callbackCalls += 1;
    const raw = Buffer.from('Bearer only-during-callback', 'utf8');
    try {
      return await useCredential({ headerName: 'authorization', value: raw });
    } finally {
      raw.fill(0);
    }
  };
  const seenHeaders: string[] = [];
  const fakeFetch: ProviderHttpFetch = async (_url, init) => {
    seenHeaders.push(new Headers(init.headers as HeadersInit).get('authorization') ?? '');
    return new Response(null, { status: 200 });
  };
  const result = await transport(fakeFetch, { resolveCredential: credentialResolver }).send(request());
  assert.equal(callbackCalls, 1);
  assert.deepEqual(seenHeaders, ['Bearer only-during-callback']);
  assert.equal('secret' in result, false);
  assert.equal('value' in result, false);
});

test('aborts the injected fetch on lease cancellation and on the explicit timeout', async () => {
  let leaseAbortObserved = false;
  let leaseFetchStarted!: () => void;
  const leaseFetchReady = new Promise<void>((resolve) => {
    leaseFetchStarted = resolve;
  });
  const leaseController = new AbortController();
  const leaseFetch: ProviderHttpFetch = async (_url, init) => {
    leaseFetchStarted();
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          leaseAbortObserved = true;
          reject(new Error('fake abort'));
        },
        { once: true },
      );
    });
  };
  const leasePromise = transport(leaseFetch).send(request({ signal: leaseController.signal }));
  await leaseFetchReady;
  leaseController.abort();
  await assert.rejects(
    leasePromise,
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'ABORTED',
  );
  assert.equal(leaseAbortObserved, true);

  let timeoutAbortObserved = false;
  const timeoutFetch: ProviderHttpFetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          timeoutAbortObserved = true;
          reject(new Error('fake timeout abort'));
        },
        { once: true },
      );
    });
  const timeoutPromise = transport(timeoutFetch, { timeoutMs: 10 }).send(request());
  await assert.rejects(
    timeoutPromise,
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'TIMEOUT',
  );
  assert.equal(timeoutAbortObserved, true);
});

test('does not permit a resolver to inject arbitrary request headers', async () => {
  let fetchCalls = 0;
  const fakeFetch: ProviderHttpFetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  await assert.rejects(
    transport(fakeFetch, {
      resolveCredential: async (_input, useCredential) =>
        useCredential({ headerName: 'x-forwarded-for', value: '127.0.0.1' }),
    }).send(request()),
    (error: unknown) => error instanceof ProviderHttpTransportError && error.code === 'CREDENTIAL_INVALID',
  );
  assert.equal(fetchCalls, 0);
});
