import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import {
  type ContentModerationCheckRequest,
  type ContentModerationCheckResponse,
  type ContentModerationPort,
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
  aborted = false;
  readonly chunks: Uint8Array[];
  readonly url: string;
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  resumed = false;

  constructor(options: { readonly url?: string; readonly method?: string; readonly body?: string } = {}) {
    super();
    this.url = options.url ?? '/v1/chat/completions';
    this.method = options.method ?? 'POST';
    this.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer test-secret',
    };
    const body = options.body ?? JSON.stringify({ model: 'public-model', input: 'hello' });
    this.chunks = [new TextEncoder().encode(body)];
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

function prepared(): RequestPreparationResult {
  return {
    outcome: 'prepared',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    payloadBytes: new TextEncoder().encode('{}'),
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
  } as RequestPreparationResult;
}

const ALLOWED: ContentModerationCheckResponse = { allowed: true, statusCode: 0, message: '' };

function harness(
  options: { readonly moderation?: ContentModerationPort; readonly requestBody?: string; readonly url?: string } = {},
) {
  const preparationInputs: RequestPreparationInput[] = [];
  const dispatchInputs: PreparedEvidenceDispatchInput[] = [];
  const request = new FakeRequest({ body: options.requestBody, url: options.url });
  const response = new FakeResponse();
  const authenticator: ProxyKeyAuthenticator = {
    authenticate: async () => authenticatedApiKey(),
  };
  const preparation: RequestPreparationPort = {
    prepare: async (input) => {
      preparationInputs.push(input);
      return prepared();
    },
  };
  const dispatch: PreparedEvidenceDispatchPort = {
    dispatch: async (input) => {
      dispatchInputs.push(input);
      return { kind: 'sent' } as PreparedEvidenceDispatchResult;
    },
  };
  const handler = createSaasGatewayHandler({
    authenticator,
    preparation,
    dispatch,
    ...(options.moderation ? { contentModeration: options.moderation } : {}),
  });
  return { handler, request, response, preparationInputs, dispatchInputs };
}

describe('gateway content moderation seam (batch 5 §5.4)', () => {
  it('is skipped entirely when no moderation port is wired', async () => {
    const h = harness();
    const handled = await h.handler(h.request as unknown as IncomingMessage, h.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    assert.equal(handled, true);
    assert.equal(h.preparationInputs.length, 1);
  });

  it('passes the authenticated caller, protocol and parsed body to the port before preparation', async () => {
    const seen: ContentModerationCheckRequest[] = [];
    const port: ContentModerationPort = {
      check: async (input) => {
        seen.push(input);
        return ALLOWED;
      },
    };
    const h = harness({
      moderation: port,
      url: '/v1/messages',
      requestBody: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await h.handler(h.request as unknown as IncomingMessage, h.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    assert.equal(seen.length, 1, 'exactly one moderation check per request');
    assert.equal(seen[0].requestId, 'request-1');
    assert.equal(seen[0].tenantId, 'tenant-1');
    assert.equal(seen[0].userId, 'user-1');
    assert.equal(seen[0].apiKeyId, 'key-1');
    assert.equal(seen[0].apiKeyName, 'test-key');
    assert.equal(seen[0].protocol, 'anthropic');
    assert.equal(seen[0].model, 'claude-sonnet-4');
    assert.deepEqual(seen[0].body, { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(h.preparationInputs.length, 1);
  });

  it('blocks with the configured status, the content_policy_violation code and message', async () => {
    const port: ContentModerationPort = {
      check: async () => ({ allowed: false, statusCode: 403, message: '内容审计命中风险规则' }),
    };
    const h = harness({ moderation: port });
    await h.handler(h.request as unknown as IncomingMessage, h.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    assert.equal(h.response.writeHeadCalls[0]?.status, 403);
    assert.equal(h.response.writeHeadCalls[0]?.headers['x-request-id'], 'request-1');
    const body = JSON.parse(String(h.response.endBody));
    assert.equal(body.error.code, 'CONTENT_POLICY_VIOLATION');
    assert.equal(body.error.message, '内容审计命中风险规则');
    assert.equal(body.error.requestId, 'request-1');
    assert.equal(h.preparationInputs.length, 0, 'blocked requests never reach preparation');
    assert.equal(h.dispatchInputs.length, 0);
    assert.equal(h.request.resumed, true, 'request drained on block');
  });

  it('clamps an out-of-range port status to 403', async () => {
    const port: ContentModerationPort = {
      check: async () => ({ allowed: false, statusCode: 599, message: 'x' }),
    };
    const h = harness({ moderation: port });
    await h.handler(h.request as unknown as IncomingMessage, h.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    assert.equal(h.response.writeHeadCalls[0]?.status, 599);
    const invalid: ContentModerationPort = {
      check: async () => ({ allowed: false, statusCode: 200, message: 'x' }),
    };
    const h2 = harness({ moderation: invalid });
    await h2.handler(h2.request as unknown as IncomingMessage, h2.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    assert.equal(h2.response.writeHeadCalls[0]?.status, 403);
  });

  it('fails open when the port throws and proceeds to preparation', async () => {
    const port: ContentModerationPort = {
      check: async () => {
        throw new Error('moderation exploded');
      },
    };
    const h = harness({ moderation: port });
    const handled = await h.handler(h.request as unknown as IncomingMessage, h.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    assert.equal(handled, true);
    assert.equal(h.preparationInputs.length, 1);
    // Whatever the dispatch path answered, it is not a moderation rejection.
    const body = JSON.parse(String(h.response.endBody ?? '{}'));
    assert.notEqual(body.error?.code, 'CONTENT_POLICY_VIOLATION');
  });

  it('never moderates unauthenticated or malformed requests', async () => {
    const seen: ContentModerationCheckRequest[] = [];
    const port: ContentModerationPort = {
      check: async (input) => {
        seen.push(input);
        return ALLOWED;
      },
    };
    const h = harness({ moderation: port });
    await h.handler(h.request as unknown as IncomingMessage, h.response as unknown as ServerResponse, {
      requestId: 'request-1',
    });
    const badBody = harness({ moderation: port, requestBody: '{not json' });
    await badBody.handler(
      badBody.request as unknown as IncomingMessage,
      badBody.response as unknown as ServerResponse,
      { requestId: 'request-1' },
    );
    const noModel = harness({ moderation: port, requestBody: JSON.stringify({}) });
    await noModel.handler(
      noModel.request as unknown as IncomingMessage,
      noModel.response as unknown as ServerResponse,
      { requestId: 'request-1' },
    );
    const unknownRoute = harness({ moderation: port, url: '/v1/unknown' });
    await unknownRoute.handler(
      unknownRoute.request as unknown as IncomingMessage,
      unknownRoute.response as unknown as ServerResponse,
      { requestId: 'request-1' },
    );
    assert.equal(seen.length, 1, 'only the well-formed request is moderated');
  });
});
