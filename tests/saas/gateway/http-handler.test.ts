import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
} from '../../../src/saas/gateway/http-handler.js';
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
    endpoint: '/provider/private',
    resolvedModel: 'provider-model',
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
    readonly authenticate?: (rawKey: string) => Promise<AuthenticatedApiKey | null>;
    readonly dispatch?: (
      input: PreparedEvidenceDispatchInput,
      response: FakeResponse,
      request: FakeRequest,
    ) => Promise<PreparedEvidenceDispatchResult>;
    readonly modelDiscovery?: (authenticatedCaller: AuthenticatedApiKey) => Promise<readonly string[]>;
    readonly maxBodyBytes?: number;
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
  const request = new FakeRequest({});
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
    modelDiscovery,
    maxBodyBytes: options.maxBodyBytes,
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
