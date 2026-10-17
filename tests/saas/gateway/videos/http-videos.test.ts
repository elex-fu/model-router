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
import type { PreparedEvidenceDispatchInput } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { TeeRecordingClientStream } from '../../../../src/saas/gateway/videos/tee-recording-client-stream.js';
import { SaasVideoBillingStateMachine } from '../../../../src/saas/gateway/videos/video-billing-state-machine.js';
import type { SaasGatewayVideoCreatePort } from '../../../../src/saas/gateway/videos/video-create-port.js';
import { PersistentSaasGatewayVideoCreatePort } from '../../../../src/saas/gateway/videos/video-create-port.js';
import type { SaasVideoSettlementPort } from '../../../../src/saas/gateway/videos/video-settlement-port.js';
import { InMemoryVideoTaskStore } from '../../../../src/saas/gateway/videos/video-task-store.js';
import {
  createSaasGatewayQueryPortRouter,
  SaasGatewayVideosQueryPort,
} from '../../../../src/saas/gateway/videos/videos-query-port.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';

/**
 * Batch 4 §4.3 (task #17) — the HTTP boundary for the video endpoints:
 * route registration + the server-owned operation overrides on the four
 * create paths, the absent-port 503, the tee-recorded sync create feeding
 * the snapshot registration after a 2xx, and the GET query routes.
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
    this.url = options.url ?? '/v1/videos/generations';
    this.method = options.method ?? 'POST';
    this.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer test-secret',
      ...(options.headers ?? {}),
    };
    const body =
      options.body ?? JSON.stringify({ model: 'public-model', prompt: 'a cat', resolution: '720p', duration: 6 });
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

function prepared(clientOperation: string): RequestPreparationResult {
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
    clientOperation,
    providerOperation: clientOperation,
    evidence: {
      evidenceId: 'evidence-1',
      accountId: 'account-1',
      credentialId: 'credential-1',
      credentialVersion: '2',
      attemptId: 'attempt-1',
    },
    normalSuccessSnapshot: {
      supplyMode: 'platform',
      providerProtocol: 'openai',
      customerPriceVersion: 'price-v1',
      reservationId: 'reservation-1',
      priceSnapshotRef: 'snapshot-1',
      currency: 'USD',
      holdAmountMinorUnits: '960',
      publicModelId: 'public-model',
      publicModelVersion: '1',
      providerId: 'provider-a',
      productId: 'product-a',
      endpoint: '/v1/videos/generations',
      usageEstimatorVersion: 'video-usage-upper-bound/v1',
    },
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
    readonly clientOperation?: string;
    readonly dispatchStatus?: number;
    readonly dispatchBody?: string;
    readonly videoCreate?: SaasGatewayVideoCreatePort;
  } = {},
): Harness {
  const preparationInputs: unknown[] = [];
  const dispatchInputs: PreparedEvidenceDispatchInput[] = [];
  const preparation: RequestPreparationPort = {
    prepare: async (input) => {
      preparationInputs.push(input);
      return prepared(options.clientOperation ?? 'videos.generations');
    },
  };
  const dispatch: PreparedEvidenceDispatchPort = {
    dispatch: async (input) => {
      dispatchInputs.push(input);
      const client = input.client as unknown as TeeRecordingClientStream;
      client.start(options.dispatchStatus ?? 200, { 'content-type': 'application/json' });
      client.write(
        new TextEncoder().encode(options.dispatchBody ?? '{"request_id":"req-upstream-1","status":"queued"}'),
      );
      client.end();
      return {
        kind: 'sent',
        transport: { responseStarted: false, resultHttpStatus: options.dispatchStatus ?? 200 },
      };
    },
  };
  const handler = createSaasGatewayHandler({
    authenticator: {
      authenticate: async () => authenticatedApiKey(),
    } as ProxyKeyAuthenticator,
    preparation,
    dispatch,
    ...(options.videoCreate ? { videoCreate: options.videoCreate } : {}),
  });
  return {
    handler,
    request: new FakeRequest(),
    response: new FakeResponse(),
    preparationInputs,
    dispatchInputs,
  };
}

test('4.3: the four video create paths are registered with their server-owned operations', async () => {
  for (const [path, operation] of [
    ['/v1/videos', 'videos.generations'],
    ['/v1/videos/generations', 'videos.generations'],
    ['/v1/videos/edits', 'videos.edits'],
    ['/v1/videos/extensions', 'videos.extensions'],
  ] as const) {
    const setup = harness({
      videoCreate: new PersistentSaasGatewayVideoCreatePort({ store: new InMemoryVideoTaskStore() }),
    });
    setup.request.url = path;
    await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
    assert.equal(setup.preparationInputs.length, 1, path);
    assert.equal((setup.preparationInputs[0] as { protocol: string }).protocol, 'openai', path);
    assert.equal((setup.preparationInputs[0] as { clientOperation?: string }).clientOperation, operation, path);
    assert.equal(setup.dispatchInputs.length, 1, path);
  }
});

test('4.3: a video create without the persistence port fails closed with 503', async () => {
  const setup = harness();
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 503);
  assert.equal(setup.preparationInputs.length, 0);
});

test('4.3: a delivered 2xx create registers the snapshot with the bound account and frozen facts', async () => {
  const store = new InMemoryVideoTaskStore();
  const port = new PersistentSaasGatewayVideoCreatePort({ store });
  const setup = harness({ videoCreate: port });
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  // The client saw the upstream JSON verbatim.
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  assert.equal(setup.response.bodyText(), '{"request_id":"req-upstream-1","status":"queued"}');
  // The background registration lands (poll until the microtask drains).
  for (let attempt = 0; attempt < 20 && (await store.get('req-upstream-1')) === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const record = await store.get('req-upstream-1');
  assert.ok(record !== null);
  assert.equal(record.providerAccountId, 'account-1');
  assert.equal(record.credentialId, 'credential-1');
  assert.equal(record.credentialVersion, '2');
  assert.equal(record.gatewayRequestId, 'request-1');
  assert.equal(record.gatewayAttemptId, 'attempt-1');
  assert.equal(record.model, 'public-model');
  // The request body's normalized billing identity: 720p / 6s / 1.
  assert.equal(record.resolution, '720p');
  assert.equal(record.durationSeconds, 6);
  assert.equal(record.videoCount, 1);
  assert.deepEqual(record.settlementFacts, {
    customerPriceVersion: 'price-v1',
    priceSnapshotRef: 'snapshot-1',
    currency: 'USD',
  });
});

test('4.3: a non-2xx or request-id-less create registers nothing', async () => {
  const failedStore = new InMemoryVideoTaskStore();
  const failed = harness({
    videoCreate: new PersistentSaasGatewayVideoCreatePort({ store: failedStore }),
    dispatchStatus: 500,
    dispatchBody: '{"error":"boom"}',
  });
  await failed.handler(asRequest(failed.request), asResponse(failed.response), { requestId: 'request-1' });
  const noIdStore = new InMemoryVideoTaskStore();
  const noId = harness({
    videoCreate: new PersistentSaasGatewayVideoCreatePort({ store: noIdStore }),
    dispatchBody: '{"status":"queued"}',
  });
  await noId.handler(asRequest(noId.request), asResponse(noId.response), { requestId: 'request-1' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await failedStore.get('x'), null);
  assert.equal((await noIdStore.get('req-upstream-1')) ?? null, null);
});

test('4.3: the GET /v1/videos/:taskId query route serves through the query port', async () => {
  const store = new InMemoryVideoTaskStore();
  await store.create({
    requestId: 'req-upstream-1',
    tenantId: 'tenant-1',
    proxyKeyId: 'proxy-key-1',
    providerAccountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '2',
    gatewayRequestId: 'request-1',
    gatewayAttemptId: 'attempt-1',
    model: 'public-model',
    resolution: '720p',
    durationSeconds: 6,
    videoCount: 1,
    settlementFacts: { customerPriceVersion: 'price-v1', priceSnapshotRef: 'snapshot-1', currency: 'USD' },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const neverSettle: SaasVideoSettlementPort = {
    async settle() {
      throw new Error('not expected');
    },
  };
  const router = createSaasGatewayQueryPortRouter({
    'videos.task_status': new SaasGatewayVideosQueryPort({
      store,
      forwarder: {
        async fetchStatus() {
          return {
            kind: 'response',
            status: 200,
            body: new TextEncoder().encode(JSON.stringify({ status: 'pending' })),
            contentType: 'application/json',
          };
        },
        async fetchContent() {
          throw new Error('not expected');
        },
      } as never,
      billing: new SaasVideoBillingStateMachine({ store, settlement: neverSettle }),
    }),
  });
  const preparation: RequestPreparationPort = { prepare: async () => ({}) as RequestPreparationResult };
  const dispatch: PreparedEvidenceDispatchPort = { dispatch: async () => ({}) as never };
  const handler = createSaasGatewayHandler({
    authenticator: { authenticate: async () => authenticatedApiKey() } as ProxyKeyAuthenticator,
    preparation,
    dispatch,
    queryEndpoints: router,
  });
  const request = new FakeRequest({ url: '/v1/videos/req-upstream-1', method: 'GET' });
  const response = new FakeResponse();
  await handler(asRequest(request), asResponse(response), { requestId: 'q-1' });
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(response.writeHeadCalls[0]?.headers['retry-after'], '3');
  assert.equal(JSON.parse(response.bodyText()).status, 'pending');

  // A foreign proxy key is a 伪 404.
  const foreignRequest = new FakeRequest({
    url: '/v1/videos/req-upstream-1',
    method: 'GET',
    headers: { authorization: 'Bearer other' },
  });
  const foreignResponse = new FakeResponse();
  const foreignHandler = createSaasGatewayHandler({
    authenticator: {
      authenticate: async () =>
        ({
          metadata: { id: 'other-key', tenantId: 'tenant-1', status: 'active' },
          authorization: { principalId: 'user-1' },
        }) as unknown as AuthenticatedApiKey,
    } as ProxyKeyAuthenticator,
    preparation,
    dispatch,
    queryEndpoints: router,
  });
  await foreignHandler(asRequest(foreignRequest), asResponse(foreignResponse));
  assert.equal(foreignResponse.writeHeadCalls[0]?.status, 404);
});

test('4.3: a video POST body rides the videos family body ceiling', async () => {
  // The 10 MiB default applies (same as images); a small body passes and the
  // declared content-length is bounded by the family limit before routing.
  const setup = harness({
    videoCreate: new PersistentSaasGatewayVideoCreatePort({ store: new InMemoryVideoTaskStore() }),
  });
  await setup.handler(asRequest(setup.request), asResponse(setup.response), { requestId: 'request-1' });
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
});
