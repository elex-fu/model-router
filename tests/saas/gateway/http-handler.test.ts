import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
  resolveSaasGatewayBodyLimits,
  type SaasGatewayEndpointFamilyBodyLimits,
} from '../../../src/saas/gateway/http-handler.js';
import type { GatewayPreDispatchCompensationPort } from '../../../src/saas/gateway/pre-dispatch-compensation-service.js';
import type {
  PreparedEvidenceDispatchInput,
  PreparedEvidenceDispatchResult,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  RequestPreparationInput,
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
    readonly maxBodyBytes?: number;
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
} {
  const preparationInputs: RequestPreparationInput[] = [];
  const dispatchInputs: PreparedEvidenceDispatchInput[] = [];
  const keys: string[] = [];
  const modelDiscoveryInputs: AuthenticatedApiKey[] = [];
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
  const baseHandler = createSaasGatewayHandler({
    authenticator,
    preparation,
    dispatch,
    preDispatchCompensation: options.preDispatchCompensation,
    modelDiscovery,
    maxBodyBytes: options.maxBodyBytes,
    endpointBodyLimits: options.endpointBodyLimits,
    ...(options.stickyScheduling ? { stickyScheduling: true } : {}),
  });
  const requestId =
    options.preparationResult?.outcome === 'prepared' ? options.preparationResult.requestId : 'request-1';
  const handler: ReturnType<typeof createSaasGatewayHandler> = (req, res, context) =>
    baseHandler(req, res, context ?? { requestId });
  return { handler, request, response, preparationInputs, dispatchInputs, keys, modelDiscoveryInputs };
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
  assert.deepEqual(defaults, { default: 1024, images: 10 * 1024 * 1024, audio: 26 * 1024 * 1024 });

  const injected = resolveSaasGatewayBodyLimits(1024, { images: 2048, audio: 4096 });
  assert.deepEqual(injected, { default: 1024, images: 2048, audio: 4096 });

  // Partial injection keeps family defaults for the omitted family only.
  const partial = resolveSaasGatewayBodyLimits(1024, { images: 2048 });
  assert.deepEqual(partial, { default: 1024, images: 2048, audio: 26 * 1024 * 1024 });

  assert.equal(resolveSaasGatewayBodyLimits(null, undefined), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { images: 0 }), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { audio: -1 }), null);
  assert.equal(resolveSaasGatewayBodyLimits(1024, { audio: 1.5 }), null);
});

test('enforces endpoint-family body ceilings before route resolution (4.0 ①)', async () => {
  // Images family default ceiling: exactly 10 MiB passes the bound.
  const imagesBoundary = harness();
  imagesBoundary.request.url = '/v1/images/generations';
  imagesBoundary.request.headers['content-length'] = String(10 * 1024 * 1024);
  await imagesBoundary.handler(asRequest(imagesBoundary.request), asResponse(imagesBoundary.response));
  assert.equal(imagesBoundary.response.writeHeadCalls[0]?.status, 404);
  assert.equal(imagesBoundary.request.resumed, true);
  assert.equal(imagesBoundary.preparationInputs.length, 0);

  const imagesOver = harness();
  imagesOver.request.url = '/v1/images/generations';
  imagesOver.request.headers['content-length'] = String(10 * 1024 * 1024 + 1);
  await imagesOver.handler(asRequest(imagesOver.request), asResponse(imagesOver.response));
  assert.equal(imagesOver.response.writeHeadCalls[0]?.status, 413);

  // Audio family default ceiling: 26 MiB passes, 26 MiB + 1 byte rejects.
  const audioBoundary = harness();
  audioBoundary.request.url = '/v1/audio/speech';
  audioBoundary.request.headers['content-length'] = String(26 * 1024 * 1024);
  await audioBoundary.handler(asRequest(audioBoundary.request), asResponse(audioBoundary.response));
  assert.equal(audioBoundary.response.writeHeadCalls[0]?.status, 404);

  const audioOver = harness();
  audioOver.request.url = '/v1/audio/speech';
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
  assert.equal(injectedBoundary.response.writeHeadCalls[0]?.status, 404);

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

test('rejects multipart-only media endpoints with an explicit JSON-only policy (4.0 ②)', async () => {
  for (const path of ['/v1/images/edits', '/v1/audio/transcriptions', '/v1/audio/translations']) {
    const multipart = harness();
    multipart.request.url = path;
    await multipart.handler(asRequest(multipart.request), asResponse(multipart.response));
    assert.equal(multipart.response.writeHeadCalls[0]?.status, 501);
    const body = JSON.parse(String(multipart.response.endBody)) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, 'MULTIPART_NOT_SUPPORTED');
    assert.ok(body.error.message.includes('multipart'));
    assert.ok(body.error.message.includes('JSON'));
    assert.equal(multipart.request.resumed, true);
    assert.equal(multipart.preparationInputs.length, 0);
    assert.equal(multipart.dispatchInputs.length, 0);
  }

  // The policy answer precedes size enforcement: an oversized declared upload
  // to a multipart endpoint still gets the precise 501, not a bare 413.
  const oversized = harness();
  oversized.request.url = '/v1/audio/transcriptions';
  oversized.request.headers['content-length'] = String(100 * 1024 * 1024);
  await oversized.handler(asRequest(oversized.request), asResponse(oversized.response));
  assert.equal(oversized.response.writeHeadCalls[0]?.status, 501);
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
