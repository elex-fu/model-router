import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  SaasGatewayQueryRequestContext,
  SaasGatewayQueryResult,
} from '../../../../src/saas/gateway/http-handler.js';
import type {
  GrokVideoUpstreamForwarder,
  GrokVideoUpstreamResponse,
} from '../../../../src/saas/gateway/videos/grok-video-upstream.js';
import { SaasVideoBillingStateMachine } from '../../../../src/saas/gateway/videos/video-billing-state-machine.js';
import type { SaasVideoSettlementPort } from '../../../../src/saas/gateway/videos/video-settlement-port.js';
import {
  InMemoryVideoTaskStore,
  type SaasVideoTaskRecord,
} from '../../../../src/saas/gateway/videos/video-task-store.js';
import {
  createSaasGatewayQueryPortRouter,
  SaasGatewayVideosQueryPort,
} from '../../../../src/saas/gateway/videos/videos-query-port.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';

/**
 * Batch 4 §4.3 (task #17) — the bound-account status/content query port:
 * ownership 伪 404s, the bound-account re-dial, the content proxy URL
 * rewrite, the billing observation riding the status read, and the
 * route-router composition.
 */

function caller(): AuthenticatedApiKey {
  return {
    metadata: { id: 'key-1', tenantId: 'tenant-1', status: 'active', modelScopes: [] },
    authorization: { principalId: 'user-1', modelScopes: [] },
  } as unknown as AuthenticatedApiKey;
}

function taskRecord(overrides: Partial<SaasVideoTaskRecord> = {}): SaasVideoTaskRecord {
  return {
    requestId: 'req-video-1',
    tenantId: 'tenant-1',
    proxyKeyId: 'key-1',
    providerAccountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    gatewayRequestId: 'gateway-request-1',
    gatewayAttemptId: 'attempt-1',
    model: 'grok-imagine-video-1.5',
    resolution: '720p',
    durationSeconds: 6,
    videoCount: 2,
    billingState: 'pending',
    billedAt: null,
    settlementFacts: {
      customerPriceVersion: 'price-v1',
      priceSnapshotRef: 'snapshot-1',
      currency: 'USD',
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

const NEVER: SaasVideoSettlementPort = {
  async settle() {
    throw new Error('the billing port must not settle in these tests');
  },
};

interface UpstreamCall {
  readonly kind: 'status' | 'content';
  readonly requestId: string;
  readonly accountId: string;
  readonly range: string | null;
}

function fakeForwarder(
  behavior: {
    readonly status?: GrokVideoUpstreamResponse;
    readonly content?: GrokVideoUpstreamResponse;
    readonly calls?: UpstreamCall[];
  } = {},
): GrokVideoUpstreamForwarder {
  const calls = behavior.calls ?? [];
  const forwarder = {
    async fetchStatus(request: { readonly account: { readonly accountId: string }; readonly requestId: string }) {
      calls.push({ kind: 'status', requestId: request.requestId, accountId: request.account.accountId, range: null });
      return behavior.status ?? ({ kind: 'error', status: null, code: 'NETWORK_ERROR', message: 'down' } as const);
    },
    async fetchContent(request: {
      readonly account: { readonly accountId: string };
      readonly requestId: string;
      readonly range: string | null;
    }) {
      calls.push({
        kind: 'content',
        requestId: request.requestId,
        accountId: request.account.accountId,
        range: request.range,
      });
      return behavior.content ?? ({ kind: 'error', status: null, code: 'NETWORK_ERROR', message: 'down' } as const);
    },
  };
  return forwarder as unknown as GrokVideoUpstreamForwarder;
}

function context(routeId: 'videos.task_status' | 'videos.task_content', taskId: string, range: string | null = null) {
  const value: SaasGatewayQueryRequestContext = {
    routeId,
    pathParameters: { taskId: encodeURIComponent(taskId) },
    authenticatedCaller: caller(),
    ...(range === null ? {} : { clientRangeHeader: range }),
  };
  return value;
}

function port(
  store: InMemoryVideoTaskStore,
  forwarder: GrokVideoUpstreamForwarder,
  billing: SaasVideoBillingStateMachine = new SaasVideoBillingStateMachine({ store, settlement: NEVER }),
): SaasGatewayVideosQueryPort {
  return new SaasGatewayVideosQueryPort({ store, forwarder, billing });
}

function seededStore(...records: SaasVideoTaskRecord[]): InMemoryVideoTaskStore {
  const store = new InMemoryVideoTaskStore();
  for (const record of records) void store.create(record);
  return store;
}

function jsonStatus(body: unknown, status = 200): GrokVideoUpstreamResponse {
  return {
    kind: 'response',
    status,
    body: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
  };
}

test('4.3: an unknown task id is a plain 404 (never an existence oracle)', async () => {
  const queryPort = port(new InMemoryVideoTaskStore(), fakeForwarder());
  const result = await queryPort.serve(context('videos.task_status', 'req-missing'));
  assert.equal(result.status, 404);
  assert.match(String(result.body), /VIDEO_TASK_NOT_FOUND/);
});

test('4.3: a foreign tenant or proxy key is indistinguishable from a missing task', async () => {
  const calls: UpstreamCall[] = [];
  const store = seededStore(taskRecord());
  const queryPort = port(store, fakeForwarder({ calls }));
  const foreignTenant = { ...context('videos.task_status', 'req-video-1') };
  foreignTenant.authenticatedCaller = {
    ...caller(),
    metadata: { ...caller().metadata, tenantId: 'tenant-2' },
  } as unknown as AuthenticatedApiKey;
  const foreignKey = { ...context('videos.task_status', 'req-video-1') };
  foreignKey.authenticatedCaller = {
    ...caller(),
    metadata: { ...caller().metadata, id: 'key-2' },
  } as unknown as AuthenticatedApiKey;
  for (const value of [foreignTenant, foreignKey]) {
    const result = await queryPort.serve(value);
    assert.equal(result.status, 404);
  }
  // The upstream was never dialed for foreign lookups.
  assert.equal(calls.length, 0);
});

test('4.3: an expired task row reads as absent (lazy TTL)', async () => {
  // A controllable clock: seed a valid row, then advance past its expiry.
  let nowMs = Date.now();
  const store = new InMemoryVideoTaskStore({ now: () => nowMs });
  await store.create(taskRecord({ expiresAt: new Date(nowMs + 1_000).toISOString() }));
  nowMs += 5_000;
  const queryPort = port(store, fakeForwarder());
  const result = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(result.status, 404);
});

test('4.3: the status poll re-dials the bound account and rewrites the content URL', async () => {
  const calls: UpstreamCall[] = [];
  const store = seededStore(taskRecord());
  const queryPort = port(
    store,
    fakeForwarder({
      calls,
      status: jsonStatus({
        status: 'done',
        model: 'grok-imagine-video-1.5',
        video: { url: 'https://vidgen.x.ai/a.mp4', duration: 6 },
      }),
    }),
  );
  const result = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.accountId, 'account-1');
  const body = JSON.parse(String(result.body)) as { status: string; video: { url: string } };
  assert.equal(body.status, 'done');
  assert.equal(body.video.url, '/v1/videos/req-video-1/content');
});

test('4.3: a pending status carries the Retry-After polling hint', async () => {
  const store = seededStore(taskRecord());
  const queryPort = port(store, fakeForwarder({ status: jsonStatus({ status: 'pending' }) }));
  const result = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(result.status, 200);
  assert.equal(result.retryAfterSeconds, 3);
});

test('4.3: the billing observation rides the status read exactly once', async () => {
  const store = seededStore(taskRecord());
  const settles: string[] = [];
  const billing = new SaasVideoBillingStateMachine({
    store,
    settlement: {
      async settle(input) {
        settles.push(input.billingRequestId);
        return { status: 'settled' };
      },
    },
  });
  const queryPort = port(
    store,
    fakeForwarder({
      status: jsonStatus({
        status: 'done',
        model: 'grok-imagine-video-1.5',
        video: { url: 'https://vidgen.x.ai/a.mp4', duration: 6 },
      }),
    }),
    billing,
  );
  const first = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(first.status, 200);
  const second = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(second.status, 200);
  assert.deepEqual(settles, ['video:req-video-1']);
  // The claim is terminal after the first poll.
  assert.equal((await store.get('req-video-1'))?.billingState, 'billed');
});

test('4.3: the billing observation never fails the status read', async () => {
  const store = seededStore(taskRecord());
  const billing = new SaasVideoBillingStateMachine({
    store,
    settlement: {
      async settle() {
        throw new Error('settlement exploded');
      },
    },
  });
  const queryPort = port(store, fakeForwarder({ status: jsonStatus({ status: 'pending' }) }), billing);
  const result = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(result.status, 200);
});

test('4.3: the upstream 404 passes through verbatim (the wrong-account verdict)', async () => {
  const store = seededStore(taskRecord());
  const queryPort = port(store, fakeForwarder({ status: jsonStatus({ error: { code: 'not_found' } }, 404) }));
  const result = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(result.status, 404);
});

test('4.3: a transport failure is a 502/504, never a task leak', async () => {
  const networkStore = seededStore(taskRecord());
  const networkPort = port(
    networkStore,
    fakeForwarder({ status: { kind: 'error', status: null, code: 'NETWORK_ERROR', message: 'down' } }),
  );
  const network = await networkPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(network.status, 502);

  const timeoutStore = seededStore(taskRecord());
  const timeoutPort = port(
    timeoutStore,
    fakeForwarder({ status: { kind: 'error', status: null, code: 'TIMEOUT', message: 'slow' } }),
  );
  const timeoutResult = await timeoutPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(timeoutResult.status, 504);
});

test('4.3: the content route proxies bytes with the client Range and the signed URL', async () => {
  const calls: UpstreamCall[] = [];
  const store = seededStore(taskRecord());
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const queryPort = port(
    store,
    fakeForwarder({
      calls,
      status: jsonStatus({
        status: 'done',
        video: { url: 'https://vidgen.x.ai/a.mp4', duration: 6 },
      }),
      content: { kind: 'response', status: 206, body: bytes, contentType: 'video/mp4' },
    }),
  );
  const result = await queryPort.serve(context('videos.task_content', 'req-video-1', 'bytes=0-1'));
  assert.equal(result.status, 206);
  assert.equal(result.contentType, 'video/mp4');
  assert.deepEqual(result.body, bytes);
  // Status first (billing + URL), then the content fetch through the same
  // bound account with the client's Range.
  assert.deepEqual(calls, [
    { kind: 'status', requestId: 'req-video-1', accountId: 'account-1', range: null },
    { kind: 'content', requestId: 'req-video-1', accountId: 'account-1', range: 'bytes=0-1' },
  ]);
});

test('4.3: content for a task without a done video is a 404', async () => {
  const store = seededStore(taskRecord());
  const queryPort = port(store, fakeForwarder({ status: jsonStatus({ status: 'pending' }) }));
  const result = await queryPort.serve(context('videos.task_content', 'req-video-1'));
  assert.equal(result.status, 404);
  assert.match(String(result.body), /VIDEO_CONTENT_NOT_FOUND/);
});

test('4.3: an invalid status body from the upstream is a 502', async () => {
  const store = seededStore(taskRecord());
  const queryPort = port(
    store,
    fakeForwarder({
      status: {
        kind: 'response',
        status: 200,
        body: new TextEncoder().encode('not-json{'),
        contentType: 'application/json',
      },
    }),
  );
  const result = await queryPort.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(result.status, 502);
  assert.match(String(result.body), /VIDEO_UPSTREAM_INVALID/);
});

test('4.3: the query port fails closed for non-video routes; the router composes families', async () => {
  const store = seededStore(taskRecord());
  const videosPort = port(store, fakeForwarder({ status: jsonStatus({ status: 'pending' }) }));
  const result = await videosPort.serve({
    routeId: 'images.task_status',
    pathParameters: { taskId: 'imgtask_x' },
    authenticatedCaller: caller(),
  });
  assert.equal(result.status, 503);

  const router = createSaasGatewayQueryPortRouter({
    'videos.task_status': videosPort,
    'videos.task_content': videosPort,
  });
  const routed: SaasGatewayQueryResult = await router.serve(context('videos.task_status', 'req-video-1'));
  assert.equal(routed.status, 200);
  const unrouted = await router.serve({
    routeId: 'images.task_status',
    pathParameters: { taskId: 'x' },
    authenticatedCaller: caller(),
  });
  assert.equal(unrouted.status, 503);
});

test('4.3: a malformed (undecodable) task id parameter is a 404', async () => {
  const queryPort = port(new InMemoryVideoTaskStore(), fakeForwarder());
  const result = await queryPort.serve({
    routeId: 'videos.task_status',
    pathParameters: { taskId: '%zz' },
    authenticatedCaller: caller(),
  });
  assert.equal(result.status, 404);
});
