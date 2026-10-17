import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
  type RequestPreparationResult,
} from '../../../../src/saas/gateway/http-handler.js';
import type { SaasGatewayAsyncMediaPort } from '../../../../src/saas/gateway/images/async-media-port.js';
import { JsonKeepaliveClientStream } from '../../../../src/saas/gateway/images/json-keepalive-client-stream.js';
import type { PreparedEvidenceDispatchInput } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';

/**
 * Batch 4 §4.2 (task #16): the HTTP boundary for the image endpoints —
 * route registration + operation override, the async 202+Location+
 * Retry-After "替换响应" control flow with RecordingClientStream, the
 * absent-port 503s, and the JSON keepalive stream's sub2api semantics.
 */

class FakeRequest extends EventEmitter {
  readonly socket = { remoteAddress: '127.0.0.1' };
  readonly complete = true;
  aborted = false;
  url: string;
  method: string;
  readonly headers: IncomingHttpHeaders;
  resumed = false;

  constructor(options: { url?: string; method?: string; headers?: IncomingHttpHeaders; body?: string } = {}) {
    super();
    this.url = options.url ?? '/v1/images/generations';
    this.method = options.method ?? 'POST';
    this.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer test-secret',
      ...(options.headers ?? {}),
    };
    const body = options.body ?? JSON.stringify({ model: 'public-model', prompt: 'a cat' });
    this.chunks = [new TextEncoder().encode(body)];
  }

  readonly chunks: Uint8Array[];

  resume(): this {
    this.resumed = true;
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (const chunk of this.chunks) yield chunk;
  }
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly writeHeadCalls: Array<{ status: number; headers: Record<string, unknown> }> = [];
  readonly writes: Uint8Array[] = [];
  endCount = 0;
  endBody: unknown;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    return this;
  }

  setHeader(): this {
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(new Uint8Array(chunk));
    return true;
  }

  end(body?: unknown): this {
    this.writableEnded = true;
    this.endCount += 1;
    this.endBody = body;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  bodyText(): string {
    if (this.endBody !== undefined) return String(this.endBody);
    return Buffer.concat(this.writes.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }
}

function asRequest(request: FakeRequest): IncomingMessage {
  return request as unknown as IncomingMessage;
}

function asResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

function authenticatedApiKey(): AuthenticatedApiKey {
  return {
    metadata: { id: 'proxy-key-1', tenantId: 'tenant-1', status: 'active', modelScopes: ['public-model'] },
    authorization: { principalId: 'user-1', modelScopes: ['public-model'] },
  } as unknown as AuthenticatedApiKey;
}

function prepared(): RequestPreparationResult {
  return {
    outcome: 'prepared',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    payloadBytes: new TextEncoder().encode('prepared-payload'),
    payloadSha256: 'a'.repeat(64),
    requestFingerprint: 'fingerprint-1',
    requestFingerprintVersion: 'v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    endpoint: '/provider/private',
    requestedModel: 'public-model',
    mappedModel: 'provider-model',
    resolvedModel: 'provider-model',
    modelResolution: {
      requestedModel: 'public-model',
      mappedModel: 'provider-model',
      resolvedModel: 'provider-model',
      mappingSource: 'alias',
      mappingVersion: 1,
    },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'images.generations',
    providerOperation: 'images.generations',
    evidence: { evidenceId: 'evidence-1' },
  } as unknown as RequestPreparationResult;
}

interface Harness {
  readonly handler: ReturnType<typeof createSaasGatewayHandler>;
  readonly request: FakeRequest;
  readonly response: FakeResponse;
  readonly preparationInputs: unknown[];
  readonly dispatchInputs: PreparedEvidenceDispatchInput[];
}

function harness(
  options: {
    readonly dispatch?: (
      input: PreparedEvidenceDispatchInput,
      client: {
        start(status: number | null, headers: Record<string, string>): void;
        write(chunk: Uint8Array): void;
        end(): void;
      },
    ) => Promise<unknown>;
    readonly asyncMedia?: SaasGatewayAsyncMediaPort;
  } = {},
): Harness {
  const preparationInputs: unknown[] = [];
  const dispatchInputs: PreparedEvidenceDispatchInput[] = [];
  const preparation: RequestPreparationPort = {
    prepare: async (input) => {
      preparationInputs.push(input);
      return prepared();
    },
  };
  const dispatch: PreparedEvidenceDispatchPort = {
    dispatch: async (input) => {
      dispatchInputs.push(input);
      return (
        options.dispatch?.(input, input.client as never) ?? {
          kind: 'sent',
          transport: { responseStarted: false, resultHttpStatus: 200 },
        }
      );
    },
  };
  const handler = createSaasGatewayHandler({
    authenticator: {
      authenticate: async () => authenticatedApiKey(),
    } as ProxyKeyAuthenticator,
    preparation,
    dispatch,
    ...(options.asyncMedia ? { asyncMedia: options.asyncMedia } : {}),
  });
  return {
    handler,
    request: new FakeRequest(),
    response: new FakeResponse(),
    preparationInputs,
    dispatchInputs,
  };
}

function asyncMediaPort(
  behavior: {
    readonly completeStatus?: number;
    readonly recorded?: { status: number | null; chunks: Uint8Array[] };
    readonly createFails?: boolean;
  } = {},
): {
  port: SaasGatewayAsyncMediaPort;
  readonly created: string[];
  readonly completions: Array<{ taskId: string; resultHttpStatus: number | null; body: string }>;
  readonly failures: Array<{ taskId: string; httpStatus: number }>;
} {
  const created: string[] = [];
  const completions: Array<{ taskId: string; resultHttpStatus: number | null; body: string }> = [];
  const failures: Array<{ taskId: string; httpStatus: number }> = [];
  return {
    created,
    completions,
    failures,
    port: {
      async createTask() {
        if (behavior.createFails) throw new Error('task store down');
        const taskId = `imgtask_${'a'.repeat(31)}${created.length.toString(16)}`;
        created.push(taskId);
        return { taskId, createdAt: 100, expiresAt: 86500 };
      },
      async completeTask(input) {
        completions.push({
          taskId: input.taskId,
          resultHttpStatus: input.resultHttpStatus,
          body: new TextDecoder().decode(input.recordedBody),
        });
      },
      async failTask(input) {
        failures.push({ taskId: input.taskId, httpStatus: input.httpStatus });
      },
    },
  };
}

test('4.2: /v1/images/generations is registered with the images.generations operation override', async () => {
  const setup = harness();
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.preparationInputs.length, 1);
  assert.equal((setup.preparationInputs[0] as { protocol: string }).protocol, 'openai');
  assert.equal((setup.preparationInputs[0] as { clientOperation?: string }).clientOperation, 'images.generations');
  assert.equal(setup.dispatchInputs.length, 1);
  // GET is still rejected with 405 on the registered route.
  const get = harness();
  get.request.method = 'GET';
  await get.handler(asRequest(get.request), asResponse(get.response));
  assert.equal(get.response.writeHeadCalls[0]?.status, 405);
  assert.equal(get.preparationInputs.length, 0);
});

test('4.2: the async submit path answers 202 + Location + Retry-After before dispatch settles', async () => {
  let releaseDispatch: (() => void) | undefined;
  const media = asyncMediaPort();
  const setup = harness({
    asyncMedia: media.port,
    dispatch: (_input, client) =>
      new Promise((resolve) => {
        releaseDispatch = () => {
          client.start(200, { 'content-type': 'application/json' });
          client.write(new TextEncoder().encode('{"data":[{"url":"https://cdn/x.png"}]}'));
          client.end();
          resolve({ kind: 'sent', transport: { responseStarted: false, resultHttpStatus: 200 } });
        };
      }),
  });
  setup.request.url = '/v1/images/generations/async';
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  // The 202 response is committed before the upstream dispatch resolves.
  assert.equal(setup.response.writeHeadCalls[0]?.status, 202);
  assert.equal(setup.response.writeHeadCalls[0]?.headers.location, `/v1/images/tasks/${media.created[0]}`);
  assert.equal(setup.response.writeHeadCalls[0]?.headers['retry-after'], '3');
  const accepted = JSON.parse(setup.response.bodyText());
  assert.equal(accepted.status, 'processing');
  assert.equal(accepted.object, 'image.generation.task');
  assert.equal(accepted.poll_url, `/v1/images/tasks/${media.created[0]}`);
  assert.equal(setup.preparationInputs.length, 1);
  assert.equal((setup.preparationInputs[0] as { clientOperation?: string }).clientOperation, 'images.generations');
  // The upstream ran in the background against the recording stream.
  assert.ok(releaseDispatch);
  releaseDispatch?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(media.completions.length, 1);
  assert.equal(media.completions[0]?.resultHttpStatus, 200);
  assert.equal(media.completions[0]?.body, '{"data":[{"url":"https://cdn/x.png"}]}');
});

test('4.2: async submit without the media port fails closed with 503', async () => {
  const setup = harness();
  setup.request.url = '/v1/images/generations/async';
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 503);
  assert.equal(setup.dispatchInputs.length, 0);
});

test('4.2: a background dispatch failure settles the task failed without breaking the 202', async () => {
  const media = asyncMediaPort();
  const setup = harness({
    asyncMedia: media.port,
    dispatch: async () => {
      throw new Error('upstream exploded');
    },
  });
  setup.request.url = '/v1/images/generations/async';
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(media.failures.length, 1);
  assert.equal(media.failures[0]?.httpStatus, 502);
});

test('4.2: a task-store failure before dispatch compensates and returns 503', async () => {
  const media = asyncMediaPort({ createFails: true });
  const setup = harness({ asyncMedia: media.port });
  setup.request.url = '/v1/images/generations/async';
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 503);
  assert.equal(setup.dispatchInputs.length, 0);
});

test('4.2: the recording ceiling fails the task when the upstream exceeds the family bound', async () => {
  const media = asyncMediaPort();
  const setup = harness({
    asyncMedia: media.port,
    async dispatch(_input, client) {
      client.start(200, { 'content-type': 'application/json' });
      client.write(new Uint8Array(11 * 1024 * 1024)); // over the 10 MiB images ceiling
      return { kind: 'sent', transport: { responseStarted: false, resultHttpStatus: 200 } };
    },
  });
  setup.request.url = '/v1/images/generations/async';
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(media.completions.length, 0);
  assert.equal(media.failures.length, 1);
});

test('4.2: the JSON keepalive stream writes whitespace heartbeats and passes late errors through', async () => {
  const request = new FakeRequest();
  const response = new FakeResponse();
  const stream = new JsonKeepaliveClientStream(request, asResponse(response), 'request-1', { intervalMs: 5 });
  try {
    // Wait past two heartbeat intervals.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(response.headersSent, true);
    assert.equal(response.writeHeadCalls[0]?.status, 200);
    assert.equal(response.writeHeadCalls[0]?.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(response.writes.length >= 2);
    // Every heartbeat is JSON-leading whitespace.
    assert.ok(response.writes.every((chunk) => Buffer.from(chunk).toString('utf8').trim() === ''));

    // A late upstream response: the committed 200 stands, the body is appended.
    stream.start(500, { 'content-type': 'application/json' });
    assert.equal(response.writeHeadCalls.length, 1);
    stream.write(new TextEncoder().encode('{"data":[]}'));
    stream.end();
    const full = response.bodyText();
    assert.equal(JSON.parse(full).data.length, 0);

    // A late upstream error before any body bytes: passed through as an
    // error JSON body appended to the heartbeat whitespace.
    const late = new JsonKeepaliveClientStream(new FakeRequest(), asResponse(new FakeResponse()), 'request-2', {
      intervalMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    late.start(502, {});
    late.abort(new Error('upstream failed'));
    const lateResponse = (late as unknown as { response: FakeResponse }).response;
    const lateText = lateResponse.bodyText();
    assert.ok(lateText.trim().startsWith('{'));
    assert.equal(JSON.parse(lateText).error.code, 'UPSTREAM_ERROR');
  } finally {
    stream.dispose();
  }
});

test('4.2: without a heartbeat the keepalive stream forwards the real status untouched', async () => {
  const stream = new JsonKeepaliveClientStream(new FakeRequest(), asResponse(new FakeResponse()), 'request-1', {
    intervalMs: 60_000,
  });
  const response = (stream as unknown as { response: FakeResponse }).response;
  try {
    // Start immediately: the heartbeat never fired, so the real status wins.
    stream.start(201, { 'content-type': 'application/json' });
    assert.equal(response.writeHeadCalls[0]?.status, 201);
    stream.write(new TextEncoder().encode('{"ok":true}'));
    stream.end();
    assert.equal(response.bodyText(), '{"ok":true}');
  } finally {
    stream.dispose();
  }
});

test('4.2: the sync images path stays byte-identical when keepalive is disabled', async () => {
  const setup = harness({
    dispatch: (_input, client) => {
      client.start(200, { 'content-type': 'application/json' });
      client.write(new TextEncoder().encode('{"data":[]}'));
      client.end();
      return Promise.resolve({ kind: 'sent', transport: { responseStarted: false, resultHttpStatus: 200 } });
    },
  });
  // No imageKeepaliveIntervalMs option → the plain node stream: headers
  // commit only when the upstream body starts.
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  assert.equal(setup.response.bodyText(), '{"data":[]}');
});
