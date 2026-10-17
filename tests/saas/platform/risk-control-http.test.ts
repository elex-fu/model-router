import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  createRiskControlHttpHandler,
  type RiskControlHttpOptions,
} from '../../../src/saas/platform/risk-control-http.js';
import {
  normalizeRiskControlConfig,
  parseRiskControlConfigInput,
  type RiskControlConfig,
} from '../../../src/saas/risk/moderation.js';
import type {
  ContentModerationLogFilter,
  ContentModerationLogRecord,
  PostgresRiskControlAdminStore,
} from '../../../src/saas/risk/postgres-store.js';

/*
 * Roadmap batch 5 §5.4 (task #19) — the risk-control operator surface:
 * config get/update (masked keys), log listing with filters, unban, the
 * pre-hash blocklist lifecycle and the manual retention sweep. The contract
 * mirrors composite-routes-http exactly (the batch-4 admin precedent).
 */

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

function logRecord(overrides: Partial<ContentModerationLogRecord> = {}): ContentModerationLogRecord {
  return {
    id: '1',
    requestId: 'req-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    apiKeyId: 'key-1',
    apiKeyName: 'key-name',
    model: 'claude-sonnet-4',
    protocol: 'anthropic',
    mode: 'pre_block',
    action: 'block',
    flagged: true,
    highestCategory: 'hate',
    highestScore: 0.99,
    matchedKeyword: '',
    categoryScores: { hate: 0.99 },
    thresholdSnapshot: { hate: 0.65 },
    inputExcerpt: 'flagged text',
    inputHash: null,
    upstreamLatencyMs: 42,
    error: '',
    violationCount: 1,
    autoBanned: false,
    emailSent: false,
    createdAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

class FakeAdminStore {
  config: RiskControlConfig = normalizeRiskControlConfig({ enabled: true, api_keys: ['moderation-secret-key-1'] });
  exists = true;
  savedConfigs: unknown[] = [];
  logs: ContentModerationLogRecord[] = [logRecord()];
  listFilters: ContentModerationLogFilter[] = [];
  hashes = new Set(['a'.repeat(64)]);
  cleanupCalls: { hitBefore: string; nonHitBefore: string }[] = [];
  enabledUsers: string[] = [];
  platformRoleUsers = new Set<string>();

  asStore(): Pick<
    PostgresRiskControlAdminStore,
    | 'loadConfig'
    | 'saveConfig'
    | 'listLogs'
    | 'countFlaggedHashes'
    | 'deleteFlaggedHash'
    | 'clearFlaggedHashes'
    | 'cleanupExpired'
    | 'enableUser'
    | 'userHoldsPlatformRole'
  > {
    return {
      loadConfig: async () => ({ config: this.config, exists: this.exists }),
      saveConfig: async (raw: unknown) => {
        const config = parseRiskControlConfigInput(raw);
        this.savedConfigs.push(raw);
        this.config = config;
        this.exists = true;
        return this.config;
      },
      listLogs: async (filter: ContentModerationLogFilter) => {
        this.listFilters.push(filter);
        return { items: this.logs, total: this.logs.length };
      },
      countFlaggedHashes: async () => this.hashes.size,
      deleteFlaggedHash: async (hash: string) => this.hashes.delete(hash),
      clearFlaggedHashes: async () => {
        const deleted = this.hashes.size;
        this.hashes.clear();
        return deleted;
      },
      cleanupExpired: async (hitBefore: string, nonHitBefore: string) => {
        this.cleanupCalls.push({ hitBefore, nonHitBefore });
        return { deletedHit: 3, deletedNonHit: 7, deletedHashes: 1 };
      },
      enableUser: async (userId: string) => {
        this.enabledUsers.push(userId);
        return { newlyEnabled: true } as never;
      },
      userHoldsPlatformRole: async (userId: string) => this.platformRoleUsers.has(userId),
    } as never;
  }
}

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: Record<string, unknown>; handled: boolean }>;
  readonly store: FakeAdminStore;
  readonly auditCalls: Array<{ action: string; targetId: string; actorUserId: string }>;
}

function harness(): Harness {
  const store = new FakeAdminStore();
  const auditCalls: Array<{ action: string; targetId: string; actorUserId: string }> = [];
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: RiskControlHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    store: store.asStore(),
    async audit(input) {
      auditCalls.push({ action: input.action, targetId: input.targetId, actorUserId: input.actorUserId });
    },
    publicOrigin: ORIGIN,
  };
  const handler = createRiskControlHttpHandler(options);

  return {
    store,
    auditCalls,
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

describe('risk-control admin http surface', () => {
  it('returns the effective config with masked api keys and never the raw keys', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/get-config', {});
    assert.equal(result.status, 200);
    const config = (result.body.data as Record<string, unknown>).config as Record<string, unknown>;
    assert.equal(config.enabled, true);
    assert.deepEqual(config.api_keys, ['****ey-1']);
    assert.equal(config.api_key_count, 1);
    assert.equal(JSON.stringify(result.body).includes('moderation-secret-key-1'), false);
    assert.equal(config.config_exists, true);
  });

  it('updates the config through strict validation and audits it', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/update-config', {
      config: { enabled: true, mode: 'observe', blocked_keywords: ['alpha'] },
    });
    assert.equal(result.status, 200);
    assert.equal(h.store.savedConfigs.length, 1);
    assert.equal(((result.body.data as Record<string, unknown>).config as Record<string, unknown>).mode, 'observe');
    assert.deepEqual(h.auditCalls, [
      { action: 'risk_control.config.updated', targetId: 'config', actorUserId: 'platform-user-from-session' },
    ]);
  });

  it('rejects invalid configs with the domain error code', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/update-config', {
      config: { mode: 'nonsense' },
    });
    assert.equal(result.status, 400);
    assert.equal((result.body.error as Record<string, unknown>).code, 'INVALID_RISK_CONTROL_MODE');
    assert.equal(h.store.savedConfigs.length, 0);
  });

  it('rejects unknown body fields', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/update-config', {
      config: { enabled: true },
      extra: 1,
    });
    assert.equal(result.status, 400);
    assert.equal((result.body.error as Record<string, unknown>).code, 'INVALID_BODY');
  });

  it('lists logs with every filter dimension and pagination', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/logs', {
      action: 'block',
      tenantId: 'tenant-1',
      model: 'claude-sonnet-4',
      flaggedOnly: true,
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-17T00:00:00Z',
      search: 'flagged',
      limit: 50,
      offset: 10,
    });
    assert.equal(result.status, 200);
    assert.equal(h.store.listFilters.length, 1);
    const filter = h.store.listFilters[0];
    assert.equal(filter.action, 'block');
    assert.equal(filter.tenantId, 'tenant-1');
    assert.equal(filter.model, 'claude-sonnet-4');
    assert.equal(filter.flaggedOnly, true);
    assert.equal(filter.fromIso, '2026-10-01T00:00:00Z');
    assert.equal(filter.toIso, '2026-10-17T00:00:00Z');
    assert.equal(filter.search, 'flagged');
    assert.equal(filter.limit, 50);
    assert.equal(filter.offset, 10);
    const data = result.body.data as Record<string, unknown>;
    assert.equal(data.total, 1);
    assert.equal((data.items as unknown[]).length, 1);
  });

  it('unbans users and refuses platform-role accounts', async () => {
    const h = harness();
    const ok = await h.request('/admin/api/v1/risk-control/unban', { userId: 'user-9' });
    assert.equal(ok.status, 200);
    assert.deepEqual(h.store.enabledUsers, ['user-9']);
    assert.deepEqual(
      h.auditCalls.map((call) => call.action),
      ['risk_control.user.unbanned'],
    );

    h.store.platformRoleUsers.add('platform-admin-1');
    const refused = await h.request('/admin/api/v1/risk-control/unban', { userId: 'platform-admin-1' });
    assert.equal(refused.status, 409);
    assert.equal((refused.body.error as Record<string, unknown>).code, 'PLATFORM_ACCOUNT');
  });

  it('deletes and clears flagged hashes', async () => {
    const h = harness();
    const hash = 'a'.repeat(64);
    const deleted = await h.request('/admin/api/v1/risk-control/delete-hash', { inputHash: hash });
    assert.equal(deleted.status, 200);
    assert.equal((deleted.body.data as Record<string, unknown>).deleted, true);
    assert.equal(h.store.hashes.size, 0);

    h.store.hashes.add('b'.repeat(64));
    h.store.hashes.add('c'.repeat(64));
    const cleared = await h.request('/admin/api/v1/risk-control/clear-hashes', {});
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body.data as Record<string, unknown>).deleted, 2);
  });

  it('rejects malformed hash values', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/delete-hash', { inputHash: 'not-a-hash' });
    assert.equal(result.status, 400);
    assert.equal((result.body.error as Record<string, unknown>).code, 'INVALID_BODY');
  });

  it('runs the retention cleanup with the configured windows', async () => {
    const h = harness();
    const result = await h.request('/admin/api/v1/risk-control/run-cleanup', {});
    assert.equal(result.status, 200);
    const data = result.body.data as Record<string, unknown>;
    assert.equal(data.deletedHit, 3);
    assert.equal(data.deletedNonHit, 7);
    assert.equal(data.deletedHashes, 1);
    assert.equal(h.store.cleanupCalls.length, 1);
    const hitBefore = new Date(h.store.cleanupCalls[0].hitBefore).getTime();
    const nonHitBefore = new Date(h.store.cleanupCalls[0].nonHitBefore).getTime();
    const now = Date.now();
    assert.ok(Math.abs(now - hitBefore - 180 * 86_400_000) < 120_000, 'hit window = 180d');
    assert.ok(Math.abs(now - nonHitBefore - 3 * 86_400_000) < 120_000, 'non-hit window = 3d');
  });

  it('enforces same-origin, auth, role and CSRF on every action', async () => {
    const h = harness();
    const crossOrigin = await h.request(
      '/admin/api/v1/risk-control/get-config',
      {},
      { headers: { origin: 'https://evil.test' } },
    );
    assert.equal(crossOrigin.status, 403);
    assert.equal((crossOrigin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');

    const anonymous = await h.request('/admin/api/v1/risk-control/get-config', {}, { actor: undefined });
    assert.equal(anonymous.status, 401);
    assert.equal((anonymous.body.error as Record<string, unknown>).code, 'UNAUTHENTICATED');

    const outsider: PlatformAdminActor = { ...ACTOR, roles: ['billing'] };
    const forbidden = await h.request('/admin/api/v1/risk-control/get-config', {}, { actor: outsider });
    assert.equal(forbidden.status, 403);
    assert.equal((forbidden.body.error as Record<string, unknown>).code, 'FORBIDDEN');

    const noCsrf = await h.request(
      '/admin/api/v1/risk-control/get-config',
      {},
      { headers: { 'x-csrf-token': 'wrong' } },
    );
    assert.equal(noCsrf.status, 403);
    assert.equal((noCsrf.body.error as Record<string, unknown>).code, 'CSRF_REJECTED');
  });

  it('rejects non-POST methods and unknown actions without touching the store', async () => {
    const h = harness();
    const get = await h.request('/admin/api/v1/risk-control/get-config', {}, { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.handled, true);
    const unknown = await h.request('/admin/api/v1/risk-control/nope', {});
    assert.equal(unknown.handled, false);
    assert.equal(h.store.savedConfigs.length, 0);
  });
});
