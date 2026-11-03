import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  type CodexBoundAdminHttpOptions,
  createCodexBoundAdminHttpHandler,
} from '../../../src/saas/platform/codex-bound-admin-http.js';
import { PlatformGovernanceError } from '../../../src/saas/platform/governance/errors.js';
import type { CodexBoundAdmissionService } from '../../../src/saas/supply/codex-bound-admission-service.js';

/*
 * 方案1 (M1-B) — the Codex trusted-bound admission operator HTTP surface.
 * Critical capabilities: the route/auth/CSRF gates, strict body shapes, and
 * the governance error envelope mapping (storage errors never leak detail).
 */

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};
const DIGEST = 'a'.repeat(64);

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: Record<string, unknown>; handled: boolean }>;
  readonly service: FakeAdmissionService;
}

class FakeAdmissionService {
  readonly submitted: unknown[] = [];
  readonly listed: unknown[] = [];
  readonly transitions: Array<{ action: string; input: unknown }> = [];

  asService(): Pick<CodexBoundAdmissionService, 'submit' | 'list' | 'approve' | 'reject' | 'retire'> {
    return {
      submit: async (_actor, _input) => {
        this.submitted.push({});
        return { status: 'created', digest: DIGEST, state: 'pending' };
      },
      list: async (_actor, _input) => {
        this.listed.push({});
        return { items: [], total: '0' };
      },
      approve: async (_actor, _input) => {
        this.transitions.push({ action: 'approve', input: {} });
        return {
          digest: DIGEST,
          state: 'approved',
          approvedByUserId: ACTOR.userId,
          approvedAt: 'now',
          updatedAt: 'now',
        };
      },
      reject: async (_actor, _input) => {
        this.transitions.push({ action: 'reject', input: {} });
        return { digest: DIGEST, state: 'rejected', approvedByUserId: null, approvedAt: null, updatedAt: 'now' };
      },
      retire: async (_actor, _input) => {
        this.transitions.push({ action: 'retire', input: {} });
        return {
          digest: DIGEST,
          state: 'retired',
          approvedByUserId: ACTOR.userId,
          approvedAt: 'now',
          updatedAt: 'now',
        };
      },
    } as never;
  }
}

function harness(): Harness {
  const service = new FakeAdmissionService();
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: CodexBoundAdminHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service: service.asService(),
    publicOrigin: ORIGIN,
  };
  const handler = createCodexBoundAdminHttpHandler(options);

  return {
    service,
    async request(path, body, overrides = {}) {
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        origin: ORIGIN,
        cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...overrides.headers,
      };
      currentActor = 'actor' in overrides ? overrides.actor : ACTOR;
      const bodyText = JSON.stringify(body ?? {});
      const req = {
        url: path,
        method: overrides.method ?? 'POST',
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(bodyText);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseText = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number) {
          status = code;
          return res;
        },
        end(value?: unknown) {
          responseText = value === undefined ? '' : String(value);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      return {
        status,
        handled,
        body: responseText === '' ? {} : (JSON.parse(responseText) as Record<string, unknown>),
      };
    },
  };
}

const PROFILE = {
  scope: {
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    productId: 'codex-chatgpt',
    model: 'gpt-5.2-codex',
    operation: 'responses',
    transport: 'http',
    continuationMode: 'canonical-replay',
  },
  backendRevision: 'backend-rev-1',
  evidenceVersion: 'proof-v1',
  evidenceReference: 'ops-live-evidence-checklist-entry',
  validFromMs: 1000,
  expiresAtMs: 2000,
  bounds: {
    inputTotalUpperBound: '100',
    inputUncachedUpperBound: '100',
    cacheReadUpperBound: '100',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '20',
    reasoningOutputUpperBound: '20',
    feasibleInputBuckets: ['input'],
  },
};

describe('codex-bounds admin http surface', () => {
  it('submits a candidate profile and returns the pending state', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/codex-bounds/submit', { profile: PROFILE });
    assert.equal(result.status, 200);
    assert.equal((result.body.data as Record<string, unknown>).status, 'created');
    assert.equal((result.body.data as Record<string, unknown>).state, 'pending');
    assert.equal((result.body.data as Record<string, unknown>).digest, DIGEST);
    assert.equal(h.service.submitted.length, 1);
  });

  it('approve, reject and retire pass the exact digest through', async () => {
    const h = harness();
    for (const action of ['approve', 'reject', 'retire']) {
      const result = await h.request(`/admin/api/v1/codex-bounds/${action}`, { digest: DIGEST });
      assert.equal(result.status, 200);
      assert.equal((result.body.data as Record<string, unknown>).digest, DIGEST);
    }
    assert.deepEqual(
      h.service.transitions.map((entry) => entry.action),
      ['approve', 'reject', 'retire'],
    );
  });

  it('rejects malformed digests and unknown body fields before reaching the service', async () => {
    const h = harness();
    const badDigest = await h.request('/admin/api/v1/codex-bounds/approve', { digest: 'not-hex' });
    assert.equal(badDigest.status, 400);
    assert.equal((badDigest.body.error as Record<string, unknown>).code, 'INVALID_BODY');
    const extraField = await h.request('/admin/api/v1/codex-bounds/approve', { digest: DIGEST, extra: 1 });
    assert.equal(extraField.status, 400);
    assert.equal((extraField.body.error as Record<string, unknown>).code, 'INVALID_BODY');
    const missingProfile = await h.request('/admin/api/v1/codex-bounds/submit', { profile: null });
    assert.equal(missingProfile.status, 400);
    assert.equal(h.service.transitions.length, 0);
    assert.equal(h.service.submitted.length, 0);
  });

  it('enforces origin, method, CSRF and authentication gates', async () => {
    const h = harness();
    assert.equal(
      (
        await h.request(
          '/admin/api/v1/codex-bounds/approve',
          { digest: DIGEST },
          { headers: { origin: 'https://evil.test' } },
        )
      ).status,
      403,
    );
    assert.equal(
      (await h.request('/admin/api/v1/codex-bounds/approve', { digest: DIGEST }, { method: 'GET' })).status,
      405,
    );
    assert.equal(
      (
        await h.request(
          '/admin/api/v1/codex-bounds/approve',
          { digest: DIGEST },
          { headers: { 'x-csrf-token': 'wrong' } },
        )
      ).status,
      403,
    );
    assert.equal(
      (await h.request('/admin/api/v1/codex-bounds/approve', { digest: DIGEST }, { actor: undefined })).status,
      401,
    );
    assert.equal(h.service.transitions.length, 0);
  });

  it('maps governance errors to their envelopes without leaking detail', async () => {
    const handler = createCodexBoundAdminHttpHandler({
      access: { authenticate: async () => ACTOR },
      authService: { verifyCsrfToken: async () => true },
      service: {
        approve: async () => {
          throw new PlatformGovernanceError('GOVERNANCE_NOT_FOUND');
        },
        submit: async () => {
          throw new Error('secret storage detail');
        },
      } as never,
      publicOrigin: ORIGIN,
    });
    const base = {
      host: 'platform-admin.test',
      origin: ORIGIN,
      'x-csrf-token': 'token',
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=token`,
      'content-type': 'application/json',
    };
    const call = async (path: string, body: unknown) => {
      let status = 200;
      let responseText = '';
      const res = {
        writeHead(code: number) {
          status = code;
          return res;
        },
        end(value?: unknown) {
          responseText = String(value);
          return res;
        },
      } as unknown as ServerResponse;
      const req = {
        url: path,
        method: 'POST',
        headers: base,
        resume: () => req,
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(body));
        },
      } as unknown as IncomingMessage;
      await handler(req, res);
      return { status, body: JSON.parse(responseText) as Record<string, unknown> };
    };
    const notFound = await call('/admin/api/v1/codex-bounds/approve', { digest: DIGEST });
    assert.equal(notFound.status, 404);
    assert.equal((notFound.body.error as Record<string, unknown>).code, 'GOVERNANCE_NOT_FOUND');
    const storage = await call('/admin/api/v1/codex-bounds/submit', { profile: PROFILE });
    assert.equal(storage.status, 503);
    assert.equal((storage.body.error as Record<string, unknown>).code, 'CODEX_BOUNDS_UNAVAILABLE');
    assert.equal(JSON.stringify(storage.body).includes('secret storage detail'), false);
  });

  it('only owns its own route namespace', async () => {
    const h = harness();
    assert.equal((await h.request('/admin/api/v1/risk-control/get-config', {})).handled, false);
    assert.equal((await h.request('/admin/api/v1/codex-bounds/unknown', {})).handled, false);
  });

  it('lists with pagination validation', async () => {
    const h = harness();
    const ok = await h.request('/admin/api/v1/codex-bounds/list', { state: 'pending', limit: 10, offset: 0 });
    assert.equal(ok.status, 200);
    assert.equal((ok.body.data as Record<string, unknown>).total, '0');
    const bad = await h.request('/admin/api/v1/codex-bounds/list', { limit: 0 });
    assert.equal(bad.status, 400);
  });
});
