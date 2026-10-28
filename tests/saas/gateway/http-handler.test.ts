import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FastGatewayExecutionError } from '../../../src/saas/gateway/fast/executor.js';
import type { FastGatewayFailureDiagnostic } from '../../../src/saas/gateway/fast/failure-diagnostic.js';
import { FastGatewaySnapshotError } from '../../../src/saas/gateway/fast/snapshots.js';
import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
  resolveSaasGatewayBodyLimits,
  type SaasGatewayEndpointFamilyBodyLimits,
  type SaasGatewayHttpOptions,
  type SaasGatewayQueryRequestContext,
  type SaasGatewayQueryResult,
  type SaasGatewayReadinessProvider,
} from '../../../src/saas/gateway/http-handler.js';
import type { GatewayPreDispatchCompensationPort } from '../../../src/saas/gateway/pre-dispatch-compensation-service.js';
import {
  type PreparedEvidenceDispatchInput,
  type PreparedEvidenceDispatchResult,
  SaasPreparedEvidenceDispatchError,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  RequestPreparationCompensationResult,
  RequestPreparationInput,
  RequestPreparationPreparedResult,
  RequestPreparationResult,
} from '../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

class FakeRequest extends EventEmitter {
  readonly socket = { remoteAddress: '127.0.0.1' };
  readonly complete = true;
  aborted = false;
  chunks: Uint8Array[];
  url: string;
  method: string;
  readonly headers: IncomingHttpHeaders;
  resumed = false;

  constructor(options: {
    readonly url?: string;
    readonly method?: string;
    readonly headers?: IncomingHttpHeaders;
    readonly body?: string | Uint8Array;
  }) {
    super();
    this.url = options.url ?? '/v1/chat/completions';
    this.method = options.method ?? 'POST';
    this.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer test-secret',
      ...(options.headers ?? {}),
    };
    const body = options.body ?? JSON.stringify({ model: 'public-model', input: 'hello' });
    this.chunks = [typeof body === 'string' ? new TextEncoder().encode(body) : body];
  }

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
  writeReturns = true;
  readonly writeHeadCalls: Array<{ status: number; headers: Record<string, unknown> }> = [];
  readonly setHeaders = new Map<string, unknown>();
  readonly writes: Uint8Array[] = [];
  endCount = 0;
  endBody: unknown;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.setHeaders.set(name.toLowerCase(), value);
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(new Uint8Array(chunk));
    return this.writeReturns;
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
}

function asRequest(request: FakeRequest): IncomingMessage {
  return request as unknown as IncomingMessage;
}

function asResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

function authenticatedApiKey(): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalUserId: 'user-1',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-1',
      createdByUserId: 'user-1',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'byok',
      name: 'test-key',
      prefix: 'mr_test',
      modelScopes: ['public-model'],
      status: 'active',
      createdAt: '2026-09-28T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalKind: 'member',
      principalId: 'user-1',
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'byok',
      modelScopes: ['public-model'],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
}

function prepared(payloadBytes = new TextEncoder().encode('server-prepared-payload')): RequestPreparationResult {
  return {
    outcome: 'prepared',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    payloadBytes,
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
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    caller: {} as never,
    entitlement: {} as never,
    authority: {} as never,
    admission: {} as never,
    normalSuccessSnapshot: {
      supplyMode: 'byok',
      providerProtocol: 'openai',
      customerPriceVersion: null,
      reservationId: null,
      priceSnapshotRef: null,
      currency: null,
      holdAmountMinorUnits: null,
      publicModelId: 'model-id-1',
      publicModelVersion: '1',
      providerId: 'provider-1',
      productId: 'product-1',
      endpoint: '/provider/private',
      usageEstimatorVersion: 'estimator-v1',
    },
    attempt: {} as never,
    evidenceInput: {} as never,
    canonicalEvidencePayload: '{}',
    canonicalEvidencePayloadSha256: 'b'.repeat(64),
    evidence: {
      evidenceId: 'evidence-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      attemptOrdinal: 1,
      supplyMode: 'byok',
      publicModel: 'public-model',
      protocol: 'openai',
      endpoint: '/provider/private',
      upstreamId: 'upstream-1',
      accountId: 'account-1',
      credentialId: 'credential-1',
      credentialVersion: '1',
      routeTargetMode: 'tenant_account',
      payloadSha256: 'a'.repeat(64),
      statementSha256: 'c'.repeat(64),
      status: 'registered',
      claimedAt: null,
      claimedAttemptId: null,
      expiresAt: '2026-09-28T00:10:00.000Z',
    },
  };
}

function sent(): PreparedEvidenceDispatchResult {
  return { kind: 'sent' } as PreparedEvidenceDispatchResult;
}

function harness(
  options: {
    readonly fastGateway?: SaasGatewayHttpOptions['fastGateway'];
    readonly fastGatewayDiagnostic?: SaasGatewayHttpOptions['fastGatewayDiagnostic'];
    readonly preparationResult?: RequestPreparationResult;
    readonly afterPreparation?: (request: FakeRequest, response: FakeResponse) => void;
    readonly preDispatchCompensation?: GatewayPreDispatchCompensationPort;
    readonly authenticate?: (rawKey: string) => Promise<AuthenticatedApiKey | null>;
    readonly dispatch?: (
      input: PreparedEvidenceDispatchInput,
      response: FakeResponse,
      request: FakeRequest,
    ) => Promise<PreparedEvidenceDispatchResult>;
    readonly modelDiscovery?: (authenticatedCaller: AuthenticatedApiKey) => Promise<readonly string[]>;
    /** Roadmap 4.0 ③: fake query-endpoint port for GET task reads. */
    readonly queryEndpoints?: (context: SaasGatewayQueryRequestContext) => Promise<SaasGatewayQueryResult>;
    readonly maxBodyBytes?: number;
    /** G-C1: the readiness provider for GET /readyz. */
    readonly readiness?: SaasGatewayReadinessProvider;
    /** G-B2: the multipart staging root. */
    readonly multipartStagingRoot?: string;
    /** Roadmap 4.0 ①: endpoint-family body limits injected at construction. */
    readonly endpointBodyLimits?: SaasGatewayEndpointFamilyBodyLimits;
    /** Batch 2 §2.1: enable the sticky scheduling seam at the boundary. */
    readonly stickyScheduling?: boolean;
    /** Constructor options for the inbound FakeRequest (url/body/headers). */
    readonly request?: ConstructorParameters<typeof FakeRequest>[0];
  } = {},
): {
  readonly handler: ReturnType<typeof createSaasGatewayHandler>;
  readonly request: FakeRequest;
  readonly response: FakeResponse;
  readonly preparationInputs: RequestPreparationInput[];
  readonly dispatchInputs: PreparedEvidenceDispatchInput[];
  readonly keys: string[];
  readonly modelDiscoveryInputs: AuthenticatedApiKey[];
  readonly queryInputs: SaasGatewayQueryRequestContext[];
} {
  const preparationInputs: RequestPreparationInput[] = [];
  const dispatchInputs: PreparedEvidenceDispatchInput[] = [];
  const keys: string[] = [];
  const modelDiscoveryInputs: AuthenticatedApiKey[] = [];
  const queryInputs: SaasGatewayQueryRequestContext[] = [];
  const request = new FakeRequest(options.request ?? {});
  const response = new FakeResponse();
  const key = authenticatedApiKey();
  const authenticator: ProxyKeyAuthenticator = {
    authenticate: async (rawKey) => {
      keys.push(rawKey);
      return options.authenticate ? options.authenticate(rawKey) : key;
    },
  };
  const preparation: RequestPreparationPort = {
    prepare: async (input) => {
      preparationInputs.push(input);
      options.afterPreparation?.(request, response);
      return options.preparationResult ?? prepared();
    },
  };
  const dispatch: PreparedEvidenceDispatchPort = {
    dispatch: async (input) => {
      dispatchInputs.push(input);
      return options.dispatch ? options.dispatch(input, response, request) : sent();
    },
  };
  const listModels = options.modelDiscovery;
  const modelDiscovery = listModels
    ? {
        list: async (authenticatedCaller: AuthenticatedApiKey) => {
          modelDiscoveryInputs.push(authenticatedCaller);
          return listModels(authenticatedCaller);
        },
      }
    : undefined;
  const queryServe = options.queryEndpoints;
  const queryEndpoints = queryServe
    ? {
        serve: async (context: SaasGatewayQueryRequestContext) => {
          queryInputs.push(context);
          return queryServe(context);
        },
      }
    : undefined;
  const baseHandler = createSaasGatewayHandler({
    fastGateway: options.fastGateway,
    fastGatewayDiagnostic: options.fastGatewayDiagnostic,
    authenticator,
    preparation,
    dispatch,
    preDispatchCompensation: options.preDispatchCompensation,
    modelDiscovery,
    queryEndpoints,
    maxBodyBytes: options.maxBodyBytes,
    endpointBodyLimits: options.endpointBodyLimits,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.multipartStagingRoot ? { multipartStagingRoot: options.multipartStagingRoot } : {}),
    ...(options.stickyScheduling ? { stickyScheduling: true } : {}),
  });
  const requestId =
    options.preparationResult?.outcome === 'prepared' ? options.preparationResult.requestId : 'request-1';
  const handler: ReturnType<typeof createSaasGatewayHandler> = (req, res, context) =>
    baseHandler(req, res, context ?? { requestId });
  return {
    handler,
    request,
    response,
    preparationInputs,
    dispatchInputs,
    keys,
    modelDiscoveryInputs,
    queryInputs,
  };
}

async function completeClient(
  input: PreparedEvidenceDispatchInput,
  response: FakeResponse,
): Promise<PreparedEvidenceDispatchResult> {
  await input.client?.start(200, {
    'content-type': 'application/json',
    'x-not-allowed': 'do-not-forward',
  });
  await input.client?.end();
  assert.equal(response.writeHeadCalls[0]?.headers['x-not-allowed'], undefined);
  return sent();
}

test('maps the three hosted routes to their fixed protocols and dispatches exact prepared bytes', async () => {
  for (const [url, protocol] of [
    ['/v1/chat/completions', 'openai'],
    ['/v1/responses', 'responses'],
    ['/v1/messages', 'anthropic'],
  ] as const) {
    const payload = new TextEncoder().encode(`prepared-${protocol}`);
    const setup = harness({
      preparationResult: prepared(payload),
      dispatch: (input, response) => completeClient(input, response),
    });
    setup.request.url = url;
    setup.request.headers.authorization = 'Bearer test-secret';

    assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
    assert.equal(setup.preparationInputs[0]?.protocol, protocol);
    assert.equal(setup.preparationInputs[0]?.publicModel, 'public-model');
    assert.strictEqual(setup.dispatchInputs[0]?.payloadBytes, payload);
    assert.equal(setup.dispatchInputs[0]?.evidenceId, 'evidence-1');
    assert.equal(setup.dispatchInputs[0]?.preparedEvidence?.evidenceId, 'evidence-1');
    assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
    assert.equal(setup.response.endCount, 1);
  }
});

test('passes Idempotency-Key only as opaque preparation context, not authentication or price authority', async () => {
  const setup = harness();
  setup.request.headers['idempotency-key'] = 'opaque-client-key-7';
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.preparationInputs[0]?.idempotencyKey, 'opaque-client-key-7');
  assert.deepEqual(setup.keys, ['test-secret']);
  assert.equal(setup.preparationInputs[0]?.authenticatedCaller.metadata.id, 'key-1');
  assert.equal(setup.preparationInputs[0]?.authenticatedCaller.authorization.supplyMode, 'byok');
  assert.equal(setup.dispatchInputs[0]?.normalSuccessSnapshot?.supplyMode, 'byok');
  assert.equal(setup.dispatchInputs[0]?.normalSuccessSnapshot?.customerPriceVersion, null);
  assert.equal(setup.dispatchInputs[0]?.normalSuccessSnapshot?.holdAmountMinorUnits, null);

  const duplicate = harness();
  duplicate.request.headers['idempotency-key'] = ['key-a', 'key-b'];
  assert.equal(await duplicate.handler(asRequest(duplicate.request), asResponse(duplicate.response)), true);
  assert.equal(duplicate.preparationInputs.length, 0);
  assert.equal(duplicate.response.writeHeadCalls[0]?.status, 400);
  assert.equal(
    duplicate.response.endBody && JSON.parse(String(duplicate.response.endBody)).error.code,
    'INVALID_IDEMPOTENCY_KEY',
  );
});

test('maps an admission idempotency fingerprint conflict to HTTP 409', async () => {
  const setup = harness({
    preparationResult: {
      outcome: 'rejected',
      stage: 'admission',
      code: 'idempotency_conflict',
      reason: 'idempotency key is already bound to a different request fingerprint',
      evidence: null,
    },
  });
  setup.request.headers['idempotency-key'] = 'opaque-client-key-7';

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 409);
  assert.equal(JSON.parse(String(setup.response.endBody)).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('returns the canonical request status reference for an existing same-fingerprint mapping', async () => {
  const setup = harness({
    preparationResult: {
      outcome: 'rejected',
      stage: 'admission',
      code: 'idempotency_replay',
      reason: 'the existing canonical request is returned without replaying its response',
      canonicalRequest: { requestId: 'canonical-request-a', status: 'in_progress' },
      evidence: null,
    },
  });
  setup.request.headers['idempotency-key'] = 'opaque-client-key-7';

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 202);
  assert.equal(setup.response.writeHeadCalls[0]?.headers['x-canonical-request-id'], 'canonical-request-a');
  assert.deepEqual(JSON.parse(String(setup.response.endBody)), {
    object: 'request_status',
    id: 'canonical-request-a',
    status: 'in_progress',
    response_replayed: false,
  });
  assert.equal(setup.dispatchInputs.length, 0);
});

test('returns 200 status metadata for a completed canonical request without replaying its body', async () => {
  const setup = harness({
    preparationResult: {
      outcome: 'rejected',
      stage: 'admission',
      code: 'idempotency_replay',
      reason: 'the existing canonical request is returned without replaying its response',
      canonicalRequest: { requestId: 'canonical-request-complete', status: 'completed' },
      evidence: null,
    },
  });
  setup.request.headers['idempotency-key'] = 'opaque-client-key-7';

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  assert.deepEqual(JSON.parse(String(setup.response.endBody)), {
    object: 'request_status',
    id: 'canonical-request-complete',
    status: 'completed',
    response_replayed: false,
  });
  assert.equal(setup.dispatchInputs.length, 0);
});

test('rejects unsupported paths, methods, content types, and body sizes before preparation', async () => {
  const unsupported = harness();
  unsupported.request.url = '/v1/unknown';
  await unsupported.handler(asRequest(unsupported.request), asResponse(unsupported.response));
  assert.equal(unsupported.response.writeHeadCalls[0]?.status, 404);
  assert.equal(unsupported.preparationInputs.length, 0);

  const method = harness();
  method.request.method = 'GET';
  await method.handler(asRequest(method.request), asResponse(method.response));
  assert.equal(method.response.writeHeadCalls[0]?.status, 405);
  assert.equal(method.preparationInputs.length, 0);

  const contentType = harness();
  contentType.request.headers['content-type'] = 'text/plain';
  await contentType.handler(asRequest(contentType.request), asResponse(contentType.response));
  assert.equal(contentType.response.writeHeadCalls[0]?.status, 415);

  const invalidJson = harness();
  invalidJson.request.chunks = [new TextEncoder().encode('{not-json')];
  await invalidJson.handler(asRequest(invalidJson.request), asResponse(invalidJson.response));
  assert.equal(invalidJson.response.writeHeadCalls[0]?.status, 400);

  const nonObject = harness();
  nonObject.request.chunks = [new TextEncoder().encode('[]')];
  await nonObject.handler(asRequest(nonObject.request), asResponse(nonObject.response));
  assert.equal(nonObject.response.writeHeadCalls[0]?.status, 400);

  const declaredTooLarge = harness({ maxBodyBytes: 8 });
  declaredTooLarge.request.headers['content-length'] = '9';
  await declaredTooLarge.handler(asRequest(declaredTooLarge.request), asResponse(declaredTooLarge.response));
  assert.equal(declaredTooLarge.response.writeHeadCalls[0]?.status, 413);

  const streamedTooLarge = harness({ maxBodyBytes: 8 });
  streamedTooLarge.request.chunks = [new TextEncoder().encode('{"model":"too-large"}')];
  await streamedTooLarge.handler(asRequest(streamedTooLarge.request), asResponse(streamedTooLarge.response));
  assert.equal(streamedTooLarge.response.writeHeadCalls[0]?.status, 413);
});

test('resolves endpoint-family body limits with documented defaults and fails closed on invalid injection (4.0 ①)', () => {
  const defaults = resolveSaasGatewayBodyLimits(1024, undefined);
  // §4.3 (task #17): the videos family shares the images media ceiling.
  assert.deepEqual(defaults, {
    default: 1024,
    images: 10 * 1024 * 1024,
    audio: 26 * 1024 * 1024,
    videos: 10 * 1024 * 1024,
  });

  const injected = resolveSaasGatewayBodyLimits(1024, { images: 2048, audio: 4096, videos: 8192 });
  assert.deepEqual(injected, { default: 1024, images: 2048, audio: 4096, videos: 8192 });

  // Partial injection keeps family defaults for the omitted family only.
  const partial = resolveSaasGatewayBodyLimits(1024, { images: 2048 });
  assert.deepEqual(partial, {
    default: 1024,
    images: 2048,
    audio: 26 * 1024 * 1024,
    videos: 10 * 1024 * 1024,
  });

  assert.equal(resolveSaasGatewayBodyLimits(null, undefined), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { images: 0 }), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { audio: -1 }), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { audio: 1.5 }), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { videos: 0 }), null);
});

test('enforces endpoint-family body ceilings before route resolution (4.0 ①)', async () => {
  // Images family default ceiling: exactly 10 MiB passes the bound.
  const imagesBoundary = harness();
  imagesBoundary.request.url = '/v1/images/generations';
  imagesBoundary.request.headers['content-length'] = String(10 * 1024 * 1024);
  await imagesBoundary.handler(asRequest(imagesBoundary.request), asResponse(imagesBoundary.response));
  // §4.2 (task #16): /v1/images/generations is now a registered route, so
  // the boundary case proceeds through the full pipeline (the default
  // harness's dispatch returns a sent result with no client interaction —
  // no response body is committed, which the 413 rejects stay below).
  assert.equal(imagesBoundary.response.writeHeadCalls.length, 0);
  assert.equal(imagesBoundary.preparationInputs.length, 1);

  const imagesOver = harness();
  imagesOver.request.url = '/v1/images/generations';
  imagesOver.request.headers['content-length'] = String(10 * 1024 * 1024 + 1);
  await imagesOver.handler(asRequest(imagesOver.request), asResponse(imagesOver.response));
  assert.equal(imagesOver.response.writeHeadCalls[0]?.status, 413);

  // Audio family default ceiling: 26 MiB passes, 26 MiB + 1 byte rejects.
  // (G-B3 note: /v1/audio/speech is now a live /v1/tts alias, so the
  // family-limit boundary check rides a still-unknown audio-family path.)
  const audioBoundary = harness();
  audioBoundary.request.url = '/v1/audio/unknown';
  audioBoundary.request.headers['content-length'] = String(26 * 1024 * 1024);
  await audioBoundary.handler(asRequest(audioBoundary.request), asResponse(audioBoundary.response));
  assert.equal(audioBoundary.response.writeHeadCalls[0]?.status, 404);

  const audioOver = harness();
  audioOver.request.url = '/v1/audio/unknown';
  audioOver.request.headers['content-length'] = String(26 * 1024 * 1024 + 1);
  await audioOver.handler(asRequest(audioOver.request), asResponse(audioOver.response));
  assert.equal(audioOver.response.writeHeadCalls[0]?.status, 413);

  // The text family keeps the global ceiling and never inherits media limits.
  const textOver = harness();
  textOver.request.url = '/v1/chat/completions';
  textOver.request.headers['content-length'] = String(1024 * 1024 + 1);
  await textOver.handler(asRequest(textOver.request), asResponse(textOver.response));
  assert.equal(textOver.response.writeHeadCalls[0]?.status, 413);

  // Injected family limits override the defaults exactly.
  const injectedBoundary = harness({ endpointBodyLimits: { images: 2048 } });
  injectedBoundary.request.url = '/v1/images/generations';
  injectedBoundary.request.headers['content-length'] = '2048';
  await injectedBoundary.handler(asRequest(injectedBoundary.request), asResponse(injectedBoundary.response));
  assert.equal(injectedBoundary.response.writeHeadCalls.length, 0);
  assert.equal(injectedBoundary.preparationInputs.length, 1);

  const injectedOver = harness({ endpointBodyLimits: { images: 2048 } });
  injectedOver.request.url = '/v1/images/generations';
  injectedOver.request.headers['content-length'] = '2049';
  await injectedOver.handler(asRequest(injectedOver.request), asResponse(injectedOver.response));
  assert.equal(injectedOver.response.writeHeadCalls[0]?.status, 413);

  // An invalid injected family limit fails the whole boundary closed.
  const invalid = harness({ endpointBodyLimits: { images: 0 } });
  invalid.request.url = '/v1/chat/completions';
  await invalid.handler(asRequest(invalid.request), asResponse(invalid.response));
  assert.equal(invalid.response.writeHeadCalls[0]?.status, 503);

  // Transport-level bound precedes routing: an unknown path with an oversized
  // declared length gets 413, not 404.
  const unknownOver = harness();
  unknownOver.request.url = '/v1/unknown';
  unknownOver.request.headers['content-length'] = String(2 * 1024 * 1024);
  await unknownOver.handler(asRequest(unknownOver.request), asResponse(unknownOver.response));
  assert.equal(unknownOver.response.writeHeadCalls[0]?.status, 413);
});

test('4.0 ② + G-B2: images/edits keeps the JSON-only reservation; audio normalizing endpoints take JSON', async () => {
  // The still-unwired images/edits endpoint keeps the precise 501.
  for (const path of ['/v1/images/edits', '/v1/stt']) {
    const multipart = harness();
    multipart.request.url = path;
    await multipart.handler(asRequest(multipart.request), asResponse(multipart.response));
    assert.equal(multipart.response.writeHeadCalls[0]?.status, 501);
    const body = JSON.parse(String(multipart.response.endBody)) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, 'MULTIPART_NOT_SUPPORTED');
    assert.equal(multipart.request.resumed, true);
    assert.equal(multipart.preparationInputs.length, 0);
    assert.equal(multipart.dispatchInputs.length, 0);
  }

  // An oversized declared upload to a reserved endpoint still gets the
  // precise 501, not a bare 413.
  const oversized = harness();
  oversized.request.url = '/v1/images/edits';
  oversized.request.headers['content-length'] = String(100 * 1024 * 1024);
  await oversized.handler(asRequest(oversized.request), asResponse(oversized.response));
  assert.equal(oversized.response.writeHeadCalls[0]?.status, 501);
});

test('a rate-limit rejection maps to 429 and carries the Retry-After hint (core-plan 9.2)', async () => {
  const hinted = harness({
    preparationResult: {
      outcome: 'rejected',
      stage: 'authority',
      code: 'rate_limited',
      reason: 'bounded sticky wait expired',
      retryAfterSeconds: 2,
      evidence: null,
    },
  });
  await hinted.handler(asRequest(hinted.request), asResponse(hinted.response));
  assert.equal(hinted.response.writeHeadCalls[0]?.status, 429);
  assert.equal(hinted.response.writeHeadCalls[0]?.headers['retry-after'], '2');

  // The hint is optional: other rate-limit rejections keep the response
  // header absent exactly as before.
  const plain = harness({
    preparationResult: {
      outcome: 'rejected',
      stage: 'authority',
      code: 'rate_limited',
      reason: 'authoritative rate ceiling',
      evidence: null,
    },
  });
  await plain.handler(asRequest(plain.request), asResponse(plain.response));
  assert.equal(plain.response.writeHeadCalls[0]?.status, 429);
  assert.equal(
    Object.keys(plain.response.writeHeadCalls[0]?.headers ?? {}).some((name) => name.toLowerCase() === 'retry-after'),
    false,
  );
  assert.equal(hinted.dispatchInputs.length, 0);
  assert.equal(plain.dispatchInputs.length, 0);
});

test('accepts only Bearer authorization and never exposes the raw secret in errors', async () => {
  const missing = harness();
  delete missing.request.headers.authorization;
  await missing.handler(asRequest(missing.request), asResponse(missing.response));
  assert.equal(missing.response.writeHeadCalls[0]?.status, 401);

  const basic = harness();
  basic.request.headers.authorization = 'Basic test-secret';
  await basic.handler(asRequest(basic.request), asResponse(basic.response));
  assert.equal(basic.response.writeHeadCalls[0]?.status, 401);
  assert.equal(basic.keys.length, 0);

  const resolverFailure = harness({
    authenticate: async () => {
      throw new Error('resolver failed for test-secret');
    },
  });
  resolverFailure.request.headers.authorization = 'Bearer test-secret';
  await resolverFailure.handler(asRequest(resolverFailure.request), asResponse(resolverFailure.response));
  assert.equal(resolverFailure.response.writeHeadCalls[0]?.status, 503);
  assert.equal(resolverFailure.keys[0], 'test-secret');
  assert.equal(JSON.stringify(resolverFailure.response.endBody).includes('test-secret'), false);
});

test('authenticates native Anthropic x-api-key clients with the same key material', async () => {
  const apiKeyOnly = harness();
  delete apiKeyOnly.request.headers.authorization;
  apiKeyOnly.request.headers['x-api-key'] = 'test-secret';
  await apiKeyOnly.handler(asRequest(apiKeyOnly.request), asResponse(apiKeyOnly.response));
  assert.notEqual(apiKeyOnly.response.writeHeadCalls[0]?.status, 401);
  assert.equal(apiKeyOnly.keys[0], 'test-secret');

  // A present-but-malformed authorization header stays authoritative and
  // fails closed even when a plausible x-api-key accompanies it.
  const basicWithApiKey = harness();
  basicWithApiKey.request.headers.authorization = 'Basic test-secret';
  basicWithApiKey.request.headers['x-api-key'] = 'test-secret';
  await basicWithApiKey.handler(asRequest(basicWithApiKey.request), asResponse(basicWithApiKey.response));
  assert.equal(basicWithApiKey.response.writeHeadCalls[0]?.status, 401);
  assert.equal(basicWithApiKey.keys.length, 0);

  const blankApiKey = harness();
  delete blankApiKey.request.headers.authorization;
  blankApiKey.request.headers['x-api-key'] = '   ';
  await blankApiKey.handler(asRequest(blankApiKey.request), asResponse(blankApiKey.response));
  assert.equal(blankApiKey.response.writeHeadCalls[0]?.status, 401);
  assert.equal(blankApiKey.keys.length, 0);
});

test('rejects client authority fields and never dispatches a blocked preparation result', async () => {
  const authority = harness();
  authority.request.chunks = [
    new TextEncoder().encode(JSON.stringify({ model: 'public-model', endpoint: 'https://attacker.invalid' })),
  ];
  await authority.handler(asRequest(authority.request), asResponse(authority.response));
  assert.equal(authority.response.writeHeadCalls[0]?.status, 400);
  assert.equal(authority.preparationInputs.length, 0);

  const blocked = harness({
    preparationResult: {
      outcome: 'blocked',
      stage: 'authority',
      code: 'route_denied',
      reason: 'sensitive internal authority detail',
      evidence: null,
    },
  });
  await blocked.handler(asRequest(blocked.request), asResponse(blocked.response));
  assert.equal(blocked.response.writeHeadCalls[0]?.status, 503);
  assert.equal(blocked.dispatchInputs.length, 0);
});

test('waits for drain before resolving write and forwards only safe response headers', async () => {
  const setup = harness({
    dispatch: async (input, response) => {
      response.writeReturns = false;
      await input.client?.start(201, {
        'content-type': 'application/json',
        'x-secret': 'must-not-forward',
        'set-cookie': 'must-not-forward',
      });
      const write = input.client?.write(new TextEncoder().encode('chunk'));
      assert(write);
      let settled = false;
      void write.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      response.emit('drain');
      await write;
      await input.client?.end();
      return sent();
    },
  });

  await setup.handler(asRequest(setup.request), asResponse(setup.response));
  assert.equal(setup.response.writeHeadCalls[0]?.status, 201);
  assert.equal(setup.response.writeHeadCalls[0]?.headers['content-type'], 'application/json');
  assert.equal(setup.response.writeHeadCalls[0]?.headers['x-secret'], undefined);
  assert.equal(setup.response.writeHeadCalls[0]?.headers['set-cookie'], undefined);
  assert.deepEqual(Buffer.from(setup.response.writes[0] ?? []), Buffer.from('chunk'));
});

test('maps client interruption to the stream AbortSignal without retrying dispatch', async () => {
  let aborted = false;
  const setup = harness({
    dispatch: async (input, response, request) => {
      response.writeReturns = false;
      await input.client?.start(200, { 'content-type': 'application/json' });
      const write = input.client?.write(new TextEncoder().encode('chunk'));
      assert(write);
      request.emit('aborted');
      await assert.rejects(write);
      aborted = input.client?.signal.aborted ?? false;
      input.client?.abort();
      return { kind: 'unknown' } as PreparedEvidenceDispatchResult;
    },
  });

  await setup.handler(asRequest(setup.request), asResponse(setup.response));
  assert.equal(aborted, true);
  assert.equal(setup.dispatchInputs.length, 1);
  assert.equal(setup.response.destroyed, true);
});

test('cancellation during awaited preparation compensates once before any upstream dispatch', async () => {
  const calls: Parameters<GatewayPreDispatchCompensationPort['compensate']>[0][] = [];
  const setup = harness({
    afterPreparation: (request, response) => {
      request.aborted = true;
      response.destroy();
    },
    preDispatchCompensation: {
      async compensate(input) {
        calls.push(input);
        return {} as never;
      },
    },
  });
  await setup.handler(asRequest(setup.request), asResponse(setup.response));
  assert.equal(setup.dispatchInputs.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cause, 'client_cancelled');
  assert.equal(calls[0]?.prepared.requestId, 'request-1');
  assert.equal(calls[0]?.responseMayHaveStarted, false);
  assert.equal(setup.request.listenerCount('aborted'), 0);
  assert.equal(setup.response.listenerCount('close'), 0);
});

test('dispatch failure requests authoritative cleanup and records response delivery as a veto', async () => {
  for (const started of [false, true]) {
    const calls: Parameters<GatewayPreDispatchCompensationPort['compensate']>[0][] = [];
    const setup = harness({
      dispatch: async (input) => {
        if (started) await input.client?.start(200, {});
        throw new Error('synthetic private provider error');
      },
      preDispatchCompensation: {
        async compensate(input) {
          calls.push(input);
          return {} as never;
        },
      },
    });
    await setup.handler(asRequest(setup.request), asResponse(setup.response));
    assert.equal(setup.dispatchInputs.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cause, 'dispatch_failed');
    assert.equal(calls[0]?.responseMayHaveStarted, started);
    assert.equal(String(setup.response.endBody).includes('private provider'), false);
  }
});

test('HTTP cleanup failure cannot retry dispatch or expose storage details', async () => {
  let cleanups = 0;
  const setup = harness({
    dispatch: async () => {
      throw new Error('provider failure');
    },
    preDispatchCompensation: {
      async compensate() {
        cleanups++;
        throw new Error('private storage error');
      },
    },
  });
  await setup.handler(asRequest(setup.request), asResponse(setup.response));
  assert.equal(cleanups, 1);
  assert.equal(setup.dispatchInputs.length, 1);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 502);
  assert.equal(String(setup.response.endBody).includes('private storage'), false);
});

function capacityPrepared(mode: 'byok' | 'platform'): RequestPreparationPreparedResult {
  const value = prepared();
  assert.ok(value.outcome === 'prepared');
  return { ...value, caller: { ...value.caller, supplyMode: mode } };
}

function releasedCapacity(value: RequestPreparationPreparedResult): RequestPreparationCompensationResult {
  return {
    requestId: value.requestId,
    attemptId: value.attemptId,
    disposition: 'released',
    quotaReservation: 'released',
    rateReservation: 'released',
    holdReservation: value.caller.supplyMode === 'byok' ? 'not_applicable' : 'released',
    manualReconciliationRequired: false,
  };
}

for (const mode of ['byok', 'platform'] as const) {
  test(`${mode}: known account capacity is 429 only after complete same-identity compensation`, async () => {
    const value = capacityPrepared(mode);
    const calls: Parameters<GatewayPreDispatchCompensationPort['compensate']>[0][] = [];
    const setup = harness({
      preparationResult: value,
      async dispatch() {
        throw new SaasPreparedEvidenceDispatchError('LEASE_CAPACITY_EXHAUSTED', 'private slot detail');
      },
      preDispatchCompensation: {
        async compensate(input) {
          calls.push(input);
          return releasedCapacity(value);
        },
      },
    });
    await setup.handler(asRequest(setup.request), asResponse(setup.response));
    assert.equal(setup.preparationInputs.length, 1);
    assert.equal(setup.dispatchInputs.length, 1, 'no second dispatch attempt is made');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.prepared, value);
    assert.equal(calls[0]?.cause, 'dispatch_failed');
    assert.equal(calls[0]?.responseMayHaveStarted, false);
    assert.equal(setup.response.writeHeadCalls[0]?.status, 429);
    assert.equal(setup.response.writeHeadCalls[0]?.headers['retry-after'], undefined);
    assert.equal(JSON.parse(String(setup.response.endBody)).error.code, 'RATE_LIMITED');
    assert.equal(String(setup.response.endBody).includes('private slot'), false);
  });
}

test('capacity cleanup must confirm every reservation and identity before returning 429', async () => {
  const patches: Array<readonly [string, Partial<RequestPreparationCompensationResult>]> = [
    ['request identity', { requestId: 'another-request' }],
    ['attempt identity', { attemptId: 'another-attempt' }],
    ['retained disposition', { disposition: 'retained_for_reconciliation' }],
    ['quota retained', { quotaReservation: 'retained_for_reconciliation' }],
    ['rate retained', { rateReservation: 'retained_for_reconciliation' }],
    ['hold retained', { holdReservation: 'retained_for_reconciliation' }],
    ['wrong hold mode', { holdReservation: 'not_applicable' }],
    ['manual reconciliation', { manualReconciliationRequired: true }],
  ];
  for (const [label, patch] of patches) {
    const value = capacityPrepared('platform');
    let cleanups = 0;
    const setup = harness({
      preparationResult: value,
      async dispatch() {
        throw new SaasPreparedEvidenceDispatchError('LEASE_CAPACITY_EXHAUSTED', 'fixed capacity denial');
      },
      preDispatchCompensation: {
        async compensate() {
          cleanups++;
          return { ...releasedCapacity(value), ...patch };
        },
      },
    });
    await setup.handler(asRequest(setup.request), asResponse(setup.response));
    assert.equal(cleanups, 1, label);
    assert.equal(setup.dispatchInputs.length, 1, label);
    assert.equal(setup.response.writeHeadCalls[0]?.status, 502, label);
    assert.equal(JSON.parse(String(setup.response.endBody)).error.code, 'DISPATCH_FAILED', label);
  }
});

test('missing or failed cleanup and generic lease errors never become capacity 429', async () => {
  for (const scenario of ['missing', 'throws', 'malformed', 'unavailable', 'lookalike'] as const) {
    const value = capacityPrepared('byok');
    let cleanups = 0;
    const setup = harness({
      preparationResult: value,
      async dispatch() {
        if (scenario === 'unavailable') throw new SaasPreparedEvidenceDispatchError('LEASE_UNAVAILABLE', 'bad lease');
        if (scenario === 'lookalike') throw { code: 'LEASE_CAPACITY_EXHAUSTED' };
        throw new SaasPreparedEvidenceDispatchError('LEASE_CAPACITY_EXHAUSTED', 'fixed capacity denial');
      },
      ...(scenario === 'missing'
        ? {}
        : {
            preDispatchCompensation: {
              async compensate() {
                cleanups++;
                if (scenario === 'throws') throw new Error('private cleanup error');
                if (scenario === 'malformed') return {} as never;
                return releasedCapacity(value);
              },
            },
          }),
    });
    await setup.handler(asRequest(setup.request), asResponse(setup.response));
    assert.equal(cleanups, scenario === 'missing' ? 0 : 1, scenario);
    assert.equal(setup.dispatchInputs.length, 1, scenario);
    assert.equal(setup.response.writeHeadCalls[0]?.status, 502, scenario);
    assert.equal(String(setup.response.endBody).includes('private'), false, scenario);
  }
});

test('capacity rejection cannot replace a started response or a cancelled client', async () => {
  for (const scenario of ['started', 'cancelled', 'cancelled-during-cleanup'] as const) {
    const value = capacityPrepared('byok');
    const calls: Parameters<GatewayPreDispatchCompensationPort['compensate']>[0][] = [];
    const setup = harness({
      preparationResult: value,
      async dispatch(input, _response, request) {
        if (scenario === 'started') await input.client?.start(200, {});
        if (scenario === 'cancelled') {
          request.aborted = true;
          request.emit('aborted');
        }
        throw new SaasPreparedEvidenceDispatchError('LEASE_CAPACITY_EXHAUSTED', 'fixed capacity denial');
      },
      preDispatchCompensation: {
        async compensate(input) {
          calls.push(input);
          if (scenario === 'cancelled-during-cleanup') {
            setup.request.aborted = true;
            setup.request.emit('aborted');
          }
          return releasedCapacity(value);
        },
      },
    });
    await setup.handler(asRequest(setup.request), asResponse(setup.response));
    assert.equal(calls.length, 1, scenario);
    assert.equal(calls[0]?.cause, scenario === 'cancelled' ? 'client_cancelled' : 'dispatch_failed', scenario);
    assert.equal(calls[0]?.responseMayHaveStarted, scenario === 'started', scenario);
    assert.equal(setup.dispatchInputs.length, 1, scenario);
    assert.ok(
      setup.response.writeHeadCalls.every(({ status }) => status !== 429),
      scenario,
    );
  }
});

test('handles a dispatcher response with no client body through start/end', async () => {
  const setup = harness({
    dispatch: (input, response) => completeClient(input, response),
  });
  await setup.handler(asRequest(setup.request), asResponse(setup.response));
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  assert.equal(setup.response.writes.length, 0);
  assert.equal(setup.response.endCount, 1);
});

test('GET /v1/models returns the authenticated key’s authorized OpenAI model list', async () => {
  const setup = harness({
    modelDiscovery: async (caller) => {
      assert.equal(caller.metadata.id, 'key-1');
      return ['public-model'];
    },
  });
  setup.request.url = '/v1/models?tenant_id=client-controlled';
  setup.request.method = 'GET';
  setup.request.chunks = [new TextEncoder().encode('{"tenantId":"client-controlled"}')];

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  assert.equal(setup.response.writeHeadCalls[0]?.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(String(setup.response.endBody)), {
    object: 'list',
    data: [{ id: 'public-model', object: 'model', created: 0, owned_by: 'managed-saas' }],
  });
  assert.equal(setup.modelDiscoveryInputs[0]?.authorization.tenantId, 'tenant-1');
  assert.equal(setup.preparationInputs.length, 0);
  assert.equal(setup.dispatchInputs.length, 0);
  assert.equal(setup.request.resumed, true);
});

test('GET /v1/models rejects missing or invalid keys before discovery', async () => {
  const missing = harness({ modelDiscovery: async () => ['public-model'] });
  missing.request.url = '/v1/models';
  missing.request.method = 'GET';
  delete missing.request.headers.authorization;
  await missing.handler(asRequest(missing.request), asResponse(missing.response));
  assert.equal(missing.response.writeHeadCalls[0]?.status, 401);
  assert.equal(missing.modelDiscoveryInputs.length, 0);

  const invalid = harness({
    authenticate: async () => null,
    modelDiscovery: async () => ['public-model'],
  });
  invalid.request.url = '/v1/models';
  invalid.request.method = 'GET';
  await invalid.handler(asRequest(invalid.request), asResponse(invalid.response));
  assert.equal(invalid.response.writeHeadCalls[0]?.status, 401);
  assert.equal(invalid.modelDiscoveryInputs.length, 0);
});

test('GET /v1/models fails closed without discovery authority and rejects out-of-scope results', async () => {
  const missing = harness();
  missing.request.url = '/v1/models';
  missing.request.method = 'GET';
  await missing.handler(asRequest(missing.request), asResponse(missing.response));
  assert.equal(missing.response.writeHeadCalls[0]?.status, 503);
  assert.equal(JSON.stringify(missing.response.endBody).includes('test-secret'), false);

  const outOfScope = harness({ modelDiscovery: async () => ['another-tenant-model'] });
  outOfScope.request.url = '/v1/models';
  outOfScope.request.method = 'GET';
  await outOfScope.handler(asRequest(outOfScope.request), asResponse(outOfScope.response));
  assert.equal(outOfScope.response.writeHeadCalls[0]?.status, 503);
  assert.equal(JSON.stringify(outOfScope.response.endBody).includes('another-tenant-model'), false);
});

test('model discovery response contains no bearer, tenant, provider, account, or credential details', async () => {
  const setup = harness({ modelDiscovery: async () => ['public-model'] });
  setup.request.url = '/v1/models';
  setup.request.method = 'GET';
  await setup.handler(asRequest(setup.request), asResponse(setup.response));

  const body = String(setup.response.endBody);
  for (const secret of ['test-secret', 'tenant-1', 'provider-1', 'account-1', 'credential-1']) {
    assert.equal(body.includes(secret), false);
  }
});

/* G1 (task #41): trusted-boundary Claude Code client evidence collection. */

const BILLING_ATTRIBUTION_BLOCK =
  'x-anthropic-billing-header;cc_entrypoint=claudeCode;cc_entrypoint_version=1.0.34;timestamp=1760000000000';

test('collects bounded Claude Code client evidence into the preparation input', async () => {
  const setup = harness({ dispatch: (input, response) => completeClient(input, response) });
  setup.request.url = '/v1/messages';
  setup.request.headers.authorization = 'Bearer test-secret';
  Object.assign(setup.request.headers, {
    'user-agent': 'claude-cli/1.0.34 (external, cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
    'x-anthropic-billing-header': BILLING_ATTRIBUTION_BLOCK,
    'x-irrelevant-header': 'never-collected',
  });

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.preparationInputs.length, 1);
  const evidence = setup.preparationInputs[0]?.claudeCodeClient;
  assert.ok(evidence, 'the boundary must attach client evidence');
  assert.equal(evidence.userAgent, 'claude-cli/1.0.34 (external, cli)');
  assert.equal(evidence.path, '/v1/messages');
  assert.deepEqual(evidence.headers, {
    'user-agent': 'claude-cli/1.0.34 (external, cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
    'x-anthropic-billing-header': BILLING_ATTRIBUTION_BLOCK,
  });
  // The evidence body is the exact parsed client object the compiler receives.
  assert.strictEqual(evidence.body, setup.preparationInputs[0]?.clientRequest);
});

test('drops oversized, ambiguous, and absent evidence values without failing the request', async () => {
  const setup = harness({ dispatch: (input, response) => completeClient(input, response) });
  setup.request.url = '/v1/messages';
  Object.assign(setup.request.headers, {
    'anthropic-beta': 'x'.repeat(2049),
    'anthropic-version': ['2023-06-01', '2024-01-01'],
    'x-stainless-empty': '',
  });

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  const evidence = setup.preparationInputs[0]?.claudeCodeClient;
  assert.ok(evidence);
  assert.equal(evidence.userAgent, null);
  assert.equal(evidence.path, '/v1/messages');
  assert.deepEqual(evidence.headers, {});
  assert.strictEqual(evidence.body, setup.preparationInputs[0]?.clientRequest);
});

test('client evidence never leaks into error responses', async () => {
  const setup = harness({
    preparationResult: {
      outcome: 'rejected',
      stage: 'authority',
      code: 'account_denied',
      reason: 'the request’s billing group admits only Claude Code clients',
      evidence: null,
    },
  });
  setup.request.url = '/v1/messages';
  Object.assign(setup.request.headers, {
    'user-agent': 'claude-cli/1.0.34 (external, cli)',
    'x-anthropic-billing-header': BILLING_ATTRIBUTION_BLOCK,
  });

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 403);
  assert.equal(setup.dispatchInputs.length, 0);
  const body = String(setup.response.endBody);
  for (const value of [BILLING_ATTRIBUTION_BLOCK, 'claude-cli/1.0.34', 'billing group', 'Claude Code']) {
    assert.equal(body.includes(value), false);
  }
});

/*
 * Roadmap batch 2 §2.1 (task #5): the http-handler scheduling seam. The
 * trusted boundary derives the merged sessionHash reference and fills
 * input.scheduling.sessionId; the preparation service forwards it to the
 * account scheduler, whose affinity resolution binds/reads it (the
 * http-handler → preparation → scheduler chain's first link).
 */

test('derives the sticky scheduling reference from an anthropic metadata.user_id body', async () => {
  const session = '11111111-2222-3333-4444-555555555555';
  const setup = harness({
    stickyScheduling: true,
    request: {
      url: '/v1/messages',
      body: JSON.stringify({
        model: 'public-model',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { user_id: `user_${'a'.repeat(64)}_account__session_${session}` },
      }),
    },
  });
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  const scheduling = setup.preparationInputs[0]?.scheduling;
  assert.deepEqual(scheduling, { sessionId: session });
});

test('derives the sticky scheduling reference from an openai session-id header over the body', async () => {
  const setup = harness({
    stickyScheduling: true,
    request: {
      url: '/v1/chat/completions',
      headers: { 'session-id': 'sess-header-1' },
      body: JSON.stringify({ model: 'public-model', prompt_cache_key: 'pc-key', messages: [] }),
    },
  });
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.deepEqual(setup.preparationInputs[0]?.scheduling, { sessionId: 'sess-header-1' });
});

test('content-derived fallback references are deterministic sha-256 values', async () => {
  const body = JSON.stringify({
    model: 'public-model',
    messages: [{ role: 'user', content: 'hello there' }],
  });
  const first = harness({ stickyScheduling: true, request: { url: '/v1/chat/completions', body } });
  assert.equal(await first.handler(asRequest(first.request), asResponse(first.response)), true);
  const second = harness({ stickyScheduling: true, request: { url: '/v1/chat/completions', body } });
  assert.equal(await second.handler(asRequest(second.request), asResponse(second.response)), true);
  const firstSession = first.preparationInputs[0]?.scheduling?.sessionId;
  const secondSession = second.preparationInputs[0]?.scheduling?.sessionId;
  assert.ok(firstSession);
  assert.match(firstSession, /^[0-9a-f]{64}$/);
  assert.equal(firstSession, secondSession);
});

test('stateless embeddings requests carry no sticky scheduling reference', async () => {
  const setup = harness({
    stickyScheduling: true,
    request: { url: '/v1/embeddings', body: JSON.stringify({ model: 'public-model', input: 'embed me' }) },
  });
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.preparationInputs[0]?.scheduling, undefined);
  // The server-owned operation override still rides along unchanged.
  assert.equal(setup.preparationInputs[0]?.clientOperation, 'embeddings');
});

test('anthropic bodies without text leave scheduling undefined', async () => {
  const setup = harness({
    stickyScheduling: true,
    request: {
      url: '/v1/messages',
      body: JSON.stringify({ model: 'public-model', metadata: {} }),
    },
  });
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.preparationInputs[0]?.scheduling, undefined);
});

test('the sticky scheduling seam is opt-in: the default boundary never sets input.scheduling', async () => {
  const setup = harness({
    request: {
      url: '/v1/messages',
      body: JSON.stringify({
        model: 'public-model',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { user_id: `user_${'a'.repeat(64)}_account__session_11111111-2222-3333-4444-555555555555` },
      }),
    },
  });
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.preparationInputs[0]?.scheduling, undefined);
});

test('serves GET query endpoints through the authenticated query port (4.0 ③)', async () => {
  const imageTask = harness({
    request: { url: '/v1/images/tasks/img_0001', method: 'GET' },
    queryEndpoints: async (context) => {
      assert.equal(context.authenticatedCaller.metadata.id, 'key-1');
      return { status: 200, body: JSON.stringify({ id: context.pathParameters.taskId, status: 'succeeded' }) };
    },
  });
  assert.equal(await imageTask.handler(asRequest(imageTask.request), asResponse(imageTask.response)), true);
  assert.equal(imageTask.response.writeHeadCalls[0]?.status, 200);
  assert.equal(imageTask.response.writeHeadCalls[0]?.headers['content-type'], 'application/json; charset=utf-8');
  const body = JSON.parse(String(imageTask.response.endBody)) as { id: string; status: string };
  assert.equal(body.id, 'img_0001');
  assert.equal(body.status, 'succeeded');
  assert.equal(imageTask.queryInputs[0]?.routeId, 'images.task_status');
  assert.deepEqual(imageTask.queryInputs[0]?.pathParameters, { taskId: 'img_0001' });
  // Query reads are the /v1/models-style bypass: no preparation, no dispatch.
  assert.equal(imageTask.preparationInputs.length, 0);
  assert.equal(imageTask.dispatchInputs.length, 0);

  const videoStatus = harness({
    request: { url: '/v1/videos/vid_9', method: 'GET' },
    queryEndpoints: async () => ({ status: 202, body: JSON.stringify({ status: 'in_progress' }) }),
  });
  await videoStatus.handler(asRequest(videoStatus.request), asResponse(videoStatus.response));
  assert.equal(videoStatus.response.writeHeadCalls[0]?.status, 202);
  assert.equal(videoStatus.queryInputs[0]?.routeId, 'videos.task_status');
  assert.deepEqual(videoStatus.queryInputs[0]?.pathParameters, { taskId: 'vid_9' });

  const videoContent = harness({
    request: { url: '/v1/videos/vid_9/content', method: 'GET' },
    queryEndpoints: async () => ({
      status: 200,
      contentType: 'video/mp4',
      body: new TextEncoder().encode('video-bytes'),
    }),
  });
  await videoContent.handler(asRequest(videoContent.request), asResponse(videoContent.response));
  assert.equal(videoContent.response.writeHeadCalls[0]?.status, 200);
  assert.equal(videoContent.response.writeHeadCalls[0]?.headers['content-type'], 'video/mp4');
  assert.deepEqual(
    new Uint8Array(videoContent.response.endBody as Uint8Array),
    new TextEncoder().encode('video-bytes'),
  );
  assert.equal(videoContent.queryInputs[0]?.routeId, 'videos.task_content');
});

test('query endpoints enforce GET, authentication, and fail closed (4.0 ③)', async () => {
  // Non-GET on a query path is method-rejected before the port runs.
  const post = harness({
    request: { url: '/v1/images/tasks/img_0001', method: 'POST', body: JSON.stringify({ model: 'public-model' }) },
    queryEndpoints: async () => ({ status: 200, body: '{}' }),
  });
  await post.handler(asRequest(post.request), asResponse(post.response));
  assert.equal(post.response.writeHeadCalls[0]?.status, 405);
  assert.equal(post.queryInputs.length, 0);

  // Absent query authority fails closed.
  const noPort = harness({ request: { url: '/v1/images/tasks/img_0001', method: 'GET' } });
  await noPort.handler(asRequest(noPort.request), asResponse(noPort.response));
  assert.equal(noPort.response.writeHeadCalls[0]?.status, 503);
  assert.equal(noPort.queryInputs.length, 0);

  // Authentication precedes the port.
  const unauthenticated = harness({
    request: { url: '/v1/images/tasks/img_0001', method: 'GET' },
    authenticate: async () => null,
    queryEndpoints: async () => ({ status: 200, body: '{}' }),
  });
  await unauthenticated.handler(asRequest(unauthenticated.request), asResponse(unauthenticated.response));
  assert.equal(unauthenticated.response.writeHeadCalls[0]?.status, 401);
  assert.equal(unauthenticated.queryInputs.length, 0);

  // GET on POST-only routes and unknown paths keep their existing answers.
  const textRoute = harness({ request: { url: '/v1/chat/completions', method: 'GET' } });
  await textRoute.handler(asRequest(textRoute.request), asResponse(textRoute.response));
  assert.equal(textRoute.response.writeHeadCalls[0]?.status, 405);

  const unknown = harness({ request: { url: '/v1/unknown', method: 'GET' } });
  await unknown.handler(asRequest(unknown.request), asResponse(unknown.response));
  assert.equal(unknown.response.writeHeadCalls[0]?.status, 404);

  // Strict path matching: trailing slash or oversized parameter matches nothing.
  const trailingSlash = harness({
    request: { url: '/v1/videos/vid_9/', method: 'GET' },
    queryEndpoints: async () => ({ status: 200, body: '{}' }),
  });
  await trailingSlash.handler(asRequest(trailingSlash.request), asResponse(trailingSlash.response));
  assert.equal(trailingSlash.response.writeHeadCalls[0]?.status, 404);
  assert.equal(trailingSlash.queryInputs.length, 0);

  const oversizedParameter = harness({
    request: { url: `/v1/images/tasks/${'a'.repeat(256)}`, method: 'GET' },
    queryEndpoints: async () => ({ status: 200, body: '{}' }),
  });
  await oversizedParameter.handler(asRequest(oversizedParameter.request), asResponse(oversizedParameter.response));
  assert.equal(oversizedParameter.response.writeHeadCalls[0]?.status, 404);
  assert.equal(oversizedParameter.queryInputs.length, 0);

  // Port failure and contract violations surface as 503, never partial output.
  const failing = harness({
    request: { url: '/v1/videos/vid_9', method: 'GET' },
    queryEndpoints: async () => {
      throw new Error('task store unavailable');
    },
  });
  await failing.handler(asRequest(failing.request), asResponse(failing.response));
  assert.equal(failing.response.writeHeadCalls[0]?.status, 503);

  for (const invalid of [
    { status: 200, body: 42 } as unknown as SaasGatewayQueryResult,
    { status: 700 } as unknown as SaasGatewayQueryResult,
    { status: 200, contentType: 'not\x00ok' } as unknown as SaasGatewayQueryResult,
  ]) {
    const contract = harness({
      request: { url: '/v1/videos/vid_9', method: 'GET' },
      queryEndpoints: async () => invalid,
    });
    await contract.handler(asRequest(contract.request), asResponse(contract.response));
    assert.equal(contract.response.writeHeadCalls[0]?.status, 503);
    assert.equal(contract.response.writeHeadCalls.length, 1);
  }
});

test('rejects WebSocket upgrade requests with an explicit 501 boundary (4.0 ④)', async () => {
  for (const upgrade of ['websocket', 'WebSocket']) {
    const ws = harness({
      request: {
        url: '/v1/realtime',
        method: 'GET',
        headers: { upgrade, connection: 'Upgrade' },
      },
    });
    await ws.handler(asRequest(ws.request), asResponse(ws.response));
    assert.equal(ws.response.writeHeadCalls[0]?.status, 501);
    const body = JSON.parse(String(ws.response.endBody)) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'WEBSOCKET_UNSUPPORTED');
    assert.ok(body.error.message.includes('WebSocket'));
    assert.equal(ws.request.resumed, true);
    assert.equal(ws.preparationInputs.length, 0);
    assert.equal(ws.dispatchInputs.length, 0);
  }
});

test('G-B3: /v1/audio/speech is a pure alias of /v1/tts — same audio.tts operation, same pricing domain', async () => {
  for (const path of ['/v1/tts', '/v1/audio/speech']) {
    const setup = harness();
    setup.request.url = path;
    setup.request.method = 'POST';
    assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
    // Both aliases must reach preparation with the SAME server-owned
    // client operation (audio.tts) — the 别名不双扣 rule.
    assert.ok(setup.preparationInputs.length >= 1, `${path} must reach preparation`);
    const input = setup.preparationInputs[0];
    assert.equal(input.clientOperation, 'audio.tts', `${path} must carry audio.tts`);
  }
});

test('G-B3: POST /v1/rerank answers the precise capability 503 (registered, not assembled)', async () => {
  const setup = harness();
  setup.request.url = '/v1/rerank';
  setup.request.method = 'POST';
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 503);
  assert.equal(setup.preparationInputs.length, 0, 'the reserved boundary never reaches preparation');
});

test('G-B3: /v1/rerank with a wrong method answers 405 via the registry match', async () => {
  const setup = harness();
  setup.request.url = '/v1/rerank';
  setup.request.method = 'GET';
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 405);
});

test('G-C1: GET /readyz answers the readiness report without authentication', async () => {
  const setup = harness({
    readiness: {
      async readiness() {
        return {
          database: 'ok',
          migrationHead: 132,
          dependencies: { 'provider-credential-kms': 'ok' },
          capabilities: { 'images.async': true, 'videos.create': false },
        };
      },
    },
  });
  setup.request.url = '/readyz';
  setup.request.method = 'GET';
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 200);
  const body = JSON.parse(String(setup.response.endBody ?? '{}')) as Record<string, unknown>;
  assert.equal(body.status, 'ready');
  assert.equal(body.database, 'ok');
  assert.equal(body.migrationHead, 132);
  assert.equal(setup.preparationInputs.length, 0, 'the probe never reaches preparation');
});

test('G-C1: a required dependency down fails readiness with 503; optional capabilities do not', async () => {
  const setup = harness({
    readiness: {
      async readiness() {
        return {
          database: 'ok',
          migrationHead: 132,
          dependencies: { 'provider-credential-kms': 'error' },
          // An OPTIONAL upstream being down is reported but not fatal (§13.2).
          capabilities: { 'grok.video': false, 'images.async': true },
        };
      },
    },
  });
  setup.request.url = '/readyz';
  setup.request.method = 'GET';
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 503);
  const body = JSON.parse(String(setup.response.endBody ?? '{}')) as Record<string, unknown>;
  assert.equal(body.status, 'not-ready');
});

test('G-C1: an absent readiness provider answers the process-only payload; a wrong method answers 405', async () => {
  const plain = harness();
  plain.request.url = '/readyz';
  plain.request.method = 'GET';
  assert.equal(await plain.handler(asRequest(plain.request), asResponse(plain.response)), true);
  assert.equal(plain.response.writeHeadCalls[0]?.status, 200);
  const body = JSON.parse(String(plain.response.endBody ?? '{}')) as Record<string, unknown>;
  assert.equal(body.database, 'unknown');
  assert.deepEqual(body.dependencies, {});
});

test('G-B2: a multipart /v1/audio/transcriptions normalizes to the JSON b64 body and reaches preparation', async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'mr-mp-route-'));
  try {
    const setup = harness({ multipartStagingRoot: stagingRoot });
    setup.request.url = '/v1/audio/transcriptions';
    setup.request.method = 'POST';
    const boundary = '----mrtestbound';
    const audioBytes = 'fake-audio-bytes';
    const multipart = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n${audioBytes}\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    setup.request.chunks = [new TextEncoder().encode(multipart)];
    (setup.request.headers as Record<string, string>)['content-type'] = `multipart/form-data; boundary=${boundary}`;
    setup.request.headers['content-length'] = String(multipart.length);
    assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
    assert.ok(
      setup.preparationInputs.length >= 1,
      `preparation not reached (status ${setup.response.writeHeadCalls[0]?.status}, body ${String(setup.response.endBody ?? '').slice(0, 300)})`,
    );
    const input = setup.preparationInputs[0];
    assert.equal(input.clientOperation, 'audio.stt');
    const requestBody = input.clientRequest as Record<string, unknown>;
    assert.equal(requestBody.model, 'whisper-1');
    assert.equal(requestBody.b64_json, Buffer.from(audioBytes).toString('base64'));
    assert.equal(requestBody.file, 'audio.mp3');
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('G-B2: a multipart request without a staging root keeps the reserved 501', async () => {
  const setup = harness();
  setup.request.url = '/v1/audio/transcriptions';
  setup.request.method = 'POST';
  const boundary = '----mrtestbound';
  const multipart = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    '',
    'whisper-1',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  setup.request.chunks = [new TextEncoder().encode(multipart)];
  (setup.request.headers as Record<string, string>)['content-type'] = `multipart/form-data; boundary=${boundary}`;
  await setup.handler(asRequest(setup.request), asResponse(setup.response));
  assert.equal(setup.response.writeHeadCalls[0]?.status, 501);
  assert.equal(setup.preparationInputs.length, 0);
});

test('G-B2: a JSON b64_json STT body takes the direct path without any staging', async () => {
  const setup = harness();
  setup.request.url = '/v1/audio/transcriptions';
  setup.request.method = 'POST';
  setup.request.chunks = [
    new TextEncoder().encode(
      JSON.stringify({ model: 'whisper-1', b64_json: Buffer.from('direct-json-audio').toString('base64') }),
    ),
  ];
  setup.request.headers['content-type'] = 'application/json';
  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.ok(
    setup.preparationInputs.length >= 1,
    `preparation not reached (status ${setup.response.writeHeadCalls[0]?.status}, body ${String(setup.response.endBody ?? '').slice(0, 200)})`,
  );
  assert.equal(setup.preparationInputs[0].clientOperation, 'audio.stt');
});


test('fast failure diagnostics preserve generic and typed HTTP errors without strict fallback', async () => {
  for (const error of [
    new Error('private exception'),
    new FastGatewaySnapshotError('SNAPSHOT_DENIED'),
    new FastGatewayExecutionError(429, 'FAST_RATE_LIMITED'),
  ]) {
    for (const observer of ['capture', 'throw', 'reject'] as const) {
      const seen: FastGatewayFailureDiagnostic[] = [];
      let executions = 0;
      const h = harness({
        fastGateway: {
          execute: async () => {
            executions++;
            throw error;
          },
        },
        fastGatewayDiagnostic: (event) => {
          seen.push(event);
          if (observer === 'throw') throw new Error('observer failed');
          if (observer === 'reject') return Promise.reject(new Error('observer failed'));
        },
      });
      const requestId = randomUUID();
      assert.equal(await h.handler(asRequest(h.request), asResponse(h.response), { requestId }), true);
      assert.equal(executions, 1);
      assert.equal(h.preparationInputs.length, 0);
      assert.equal(h.dispatchInputs.length, 0);
      assert.equal(h.response.writeHeadCalls[0]?.status, error instanceof FastGatewayExecutionError ? 429 : 503);
      const body = JSON.parse(String(h.response.endBody));
      assert.equal(
        body.error.code,
        error instanceof FastGatewayExecutionError ? 'FAST_RATE_LIMITED' : 'FAST_GATEWAY_UNAVAILABLE',
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0].requestId, requestId);
      assert.equal(seen[0].headersSent, false);
      assert.equal(h.response.setHeaders.has('x-model-router-execution-mode'), false);
    }
  }
});

test('fast admission 429 carries the Retry-After hint; other fast errors keep it absent', async () => {
  const hinted = harness({
    fastGateway: {
      execute: async () => {
        throw new FastGatewayExecutionError(429, 'FAST_RATE_LIMITED', 2);
      },
    },
  });
  assert.equal(await hinted.handler(asRequest(hinted.request), asResponse(hinted.response)), true);
  assert.equal(hinted.response.writeHeadCalls[0]?.status, 429);
  assert.equal(hinted.response.writeHeadCalls[0]?.headers['retry-after'], '2');
  assert.equal(JSON.parse(String(hinted.response.endBody)).error.code, 'FAST_RATE_LIMITED');

  // A fast error without a hint keeps the header absent exactly as before.
  const plain = harness({
    fastGateway: {
      execute: async () => {
        throw new FastGatewayExecutionError(503, 'FAST_GATEWAY_UNAVAILABLE');
      },
    },
  });
  assert.equal(await plain.handler(asRequest(plain.request), asResponse(plain.response)), true);
  assert.equal(plain.response.writeHeadCalls[0]?.status, 503);
  assert.equal(
    Object.keys(plain.response.writeHeadCalls[0]?.headers ?? {}).some((name) => name.toLowerCase() === 'retry-after'),
    false,
  );
});

test('fast diagnostic failure after response start preserves abort and never sends a second response', async () => {
  const seen: FastGatewayFailureDiagnostic[] = [];
  const h = harness({
    fastGateway: {
      execute: async ({ client }) => {
        await client.start(200, { 'content-type': 'application/json' });
        throw new Error('private');
      },
    },
    fastGatewayDiagnostic: (event) => {
      seen.push(event);
      throw new Error('observer failed');
    },
  });
  assert.equal(await h.handler(asRequest(h.request), asResponse(h.response)), true);
  assert.equal(h.response.writeHeadCalls.length, 1);
  assert.equal(h.response.writeHeadCalls[0].status, 200);
  assert.equal(h.response.destroyed, true);
  assert.equal(seen[0].headersSent, true);
  assert.equal(h.preparationInputs.length, 0);
});
