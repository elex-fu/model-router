import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  type AccountProbeHttpOptions,
  createAccountProbeHttpHandler,
  createPostgresProbeMonitorAdminStore,
  generateArithmeticChallenge,
  type ProbeMonitorAdminStore,
  type ProbeMonitorSummary,
} from '../../../src/saas/platform/account-probe-http.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

interface TestResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly handled: boolean;
}

interface StoreCall {
  readonly action: 'trigger' | 'list';
  readonly input: unknown;
}

function summary(overrides: Partial<ProbeMonitorSummary> = {}): ProbeMonitorSummary {
  return {
    id: 'monitor-1',
    ownerKind: 'platform',
    ownerTenantId: null,
    accountId: 'account-1',
    category: 'opencode-go',
    probeIntervalSeconds: 300,
    failureThreshold: 3,
    consecutiveFailures: 1,
    lastResult: 'ok',
    lastRunAt: '2026-10-15T00:00:00.000Z',
    nextDueAt: '2026-10-15T00:05:00.000Z',
    enabled: true,
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function harness(store: ProbeMonitorAdminStore): {
  readonly calls: StoreCall[];
  request(
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ): Promise<TestResponse>;
} {
  const calls: StoreCall[] = [];
  const wrapped: ProbeMonitorAdminStore = {
    async triggerMonitor(input) {
      calls.push({ action: 'trigger', input });
      return store.triggerMonitor(input);
    },
    async listMonitors(input) {
      calls.push({ action: 'list', input });
      return store.listMonitors(input);
    },
  };
  let authenticatedActor: PlatformAdminActor | undefined = ACTOR;
  const options: AccountProbeHttpOptions = {
    access: { authenticate: async () => authenticatedActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    store: wrapped,
    publicOrigin: ORIGIN,
  };
  const handler = createAccountProbeHttpHandler(options);
  return {
    calls,
    async request(path, body, overrides = {}) {
      authenticatedActor = 'actor' in overrides ? overrides.actor : ACTOR;
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        origin: ORIGIN,
        cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...overrides.headers,
      };
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

const TRIGGER_STORE: ProbeMonitorAdminStore = {
  async triggerMonitor() {
    return { monitor: summary(), queued: true };
  },
  async listMonitors() {
    return [summary(), summary({ id: 'monitor-2', ownerKind: 'tenant', ownerTenantId: 'tenant-1', lastResult: null })];
  },
};

test('trigger queues the monitor and returns the non-secret summary', async () => {
  const h = harness(TRIGGER_STORE);
  const response = await h.request('/admin/api/v1/probe-monitors/trigger', {
    ownerKind: 'platform',
    accountId: 'account-1',
  });
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.monitorId, 'monitor-1');
  assert.equal(data.queued, true);
  assert.equal(data.category, 'opencode-go');
  assert.equal(data.lastResult, 'ok');
  assert.equal(h.calls[0]?.action, 'trigger');
  assert.deepEqual(h.calls[0]?.input, {
    ownerKind: 'platform',
    tenantId: null,
    accountId: 'account-1',
    actorUserId: 'platform-user-from-session',
    sourceIp: '203.0.113.10',
    userAgent: null,
  });
});

test('trigger requires a tenant id for tenant accounts and rejects stray fields', async () => {
  const h = harness(TRIGGER_STORE);
  const missing = await h.request('/admin/api/v1/probe-monitors/trigger', { ownerKind: 'tenant', accountId: 'a' });
  assert.equal(missing.status, 400);
  assert.equal((missing.body.error as Record<string, unknown>).code, 'INVALID_BODY');
  const extra = await h.request('/admin/api/v1/probe-monitors/trigger', {
    ownerKind: 'platform',
    accountId: 'a',
    challenge: 'override',
  });
  assert.equal(extra.status, 400);
  assert.equal((extra.body.error as Record<string, unknown>).code, 'INVALID_BODY');
  assert.equal(h.calls.length, 0);
});

test('list returns the bounded monitor summaries with filters', async () => {
  const h = harness(TRIGGER_STORE);
  const response = await h.request('/admin/api/v1/probe-monitors/list', {
    ownerKind: 'tenant',
    tenantId: 'tenant-1',
    limit: 10,
  });
  assert.equal(response.status, 200);
  const data = response.body.data as { monitors: unknown[] };
  assert.equal(data.monitors.length, 2);
  assert.deepEqual(h.calls[0]?.input, { ownerKind: 'tenant', tenantId: 'tenant-1', limit: 10 });
  const invalidLimit = await h.request('/admin/api/v1/probe-monitors/list', { limit: 0 });
  assert.equal(invalidLimit.status, 400);
  const invalidOwner = await h.request('/admin/api/v1/probe-monitors/list', { ownerKind: 'nope' });
  assert.equal(invalidOwner.status, 400);
});

test('the codex-oauth admin contract is enforced: method, origin, auth, role, CSRF, JSON', async () => {
  const h = harness(TRIGGER_STORE);
  const get = await h.request('/admin/api/v1/probe-monitors/list', {}, { method: 'GET' });
  assert.equal(get.status, 405);
  const query = await h.request('/admin/api/v1/probe-monitors/trigger?x=1', {
    ownerKind: 'platform',
    accountId: 'a',
  });
  assert.equal(query.status, 400);
  assert.equal((query.body.error as Record<string, unknown>).code, 'INVALID_QUERY');
  const crossOrigin = await h.request(
    '/admin/api/v1/probe-monitors/trigger',
    { ownerKind: 'platform', accountId: 'a' },
    { headers: { origin: 'https://evil.example' } },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal((crossOrigin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');
  const unauthenticated = await h.request(
    '/admin/api/v1/probe-monitors/trigger',
    { ownerKind: 'platform', accountId: 'a' },
    { actor: undefined },
  );
  assert.equal(unauthenticated.status, 401);
  const forbidden = await h.request(
    '/admin/api/v1/probe-monitors/trigger',
    { ownerKind: 'platform', accountId: 'a' },
    { actor: { ...ACTOR, roles: ['finance'] } },
  );
  assert.equal(forbidden.status, 403);
  const csrf = await h.request(
    '/admin/api/v1/probe-monitors/trigger',
    { ownerKind: 'platform', accountId: 'a' },
    { headers: { 'x-csrf-token': 'wrong' } },
  );
  assert.equal(csrf.status, 403);
  assert.equal((csrf.body.error as Record<string, unknown>).code, 'CSRF_REJECTED');
  const contentType = await h.request(
    '/admin/api/v1/probe-monitors/trigger',
    { ownerKind: 'platform', accountId: 'a' },
    { headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(contentType.status, 415);
  assert.equal(h.calls.length, 0);
  // Unrelated paths fall through to the next handler.
  const fallthrough = await h.request('/admin/api/v1/codex-oauth/start', {});
  assert.equal(fallthrough.handled, false);
});

test('store failures collapse to a generic 503 without internals', async () => {
  const failing: ProbeMonitorAdminStore = {
    async triggerMonitor() {
      throw new Error('database exploded with credentials');
    },
    async listMonitors() {
      throw new Error('nope');
    },
  };
  const h = harness(failing);
  const trigger = await h.request('/admin/api/v1/probe-monitors/trigger', { ownerKind: 'platform', accountId: 'a' });
  assert.equal(trigger.status, 503);
  assert.equal((trigger.body.error as Record<string, unknown>).code, 'ACCOUNT_PROBE_UNAVAILABLE');
  assert.ok(!JSON.stringify(trigger.body).includes('exploded'));
  const list = await h.request('/admin/api/v1/probe-monitors/list', {});
  assert.equal(list.status, 503);
});

interface CapturedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

test('the Postgres store upserts the monitor due-now with a fresh challenge and audits the actor', async () => {
  const queries: CapturedQuery[] = [];
  const executor: SqlExecutor = {
    query: async <RowType>(sql: string, values?: readonly unknown[]): Promise<SqlResult<RowType>> => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: values ?? [] });
      const normalized = sql.replace(/\s+/g, ' ');
      if (normalized.includes('FROM saas_platform_provider_accounts')) {
        return { rows: [{ provider_id: 'opencode-go' }] as RowType[], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO saas_probe_monitors')) {
        return {
          rows: [
            {
              id: 'monitor-9',
              owner_kind: 'platform',
              owner_tenant_id: null,
              account_id: 'account-9',
              provider_category: 'opencode-go',
              probe_interval_seconds: 300,
              failure_threshold: 3,
              consecutive_failures: 0,
              last_result: null,
              last_run_at: null,
              next_due_at: null,
              enabled: true,
              updated_at: new Date('2026-10-15T00:00:00Z'),
            },
          ] as RowType[],
          rowCount: 1,
        };
      }
      return { rows: [] as RowType[], rowCount: 0 };
    },
  };
  const store = createPostgresProbeMonitorAdminStore(executor);
  const result = await store.triggerMonitor({
    ownerKind: 'platform',
    tenantId: null,
    accountId: 'account-9',
    actorUserId: 'operator-1',
    sourceIp: '203.0.113.10',
    userAgent: 'probe-test',
  });
  assert.equal(result.queued, true);
  assert.equal(result.monitor.id, 'monitor-9');
  const upsert = queries.find((query) => query.sql.startsWith('INSERT INTO saas_probe_monitors'));
  assert.ok(upsert);
  assert.match(upsert.sql, /ON CONFLICT \(owner_scope_key, account_id\) DO UPDATE/);
  assert.match(upsert.sql, /probe_requested_at = clock_timestamp\(\)/);
  assert.equal(upsert.values[1], 'platform');
  assert.equal(upsert.values[4], 'account-9');
  assert.equal(upsert.values[5], 'opencode-go');
  // A freshly generated arithmetic challenge: digits-only answer.
  assert.match(String(upsert.values[6]), /What is \d+ \+ \d+\? Reply with only the number\./);
  assert.match(String(upsert.values[7]), /^[0-9]{1,6}$/);
  assert.equal(Number(upsert.values[7]) <= 100, true);
  const audit = queries.find((query) => query.sql.startsWith('INSERT INTO saas_audit_events'));
  assert.ok(audit);
  assert.match(audit.sql, /'saas_probe_monitor\.manual_trigger'/);
  assert.equal(audit.values[2], 'operator-1');
  assert.equal(audit.values[3], 'monitor-9');
});

test('the Postgres store maps a missing account to a 404-shaped error and lists monitors bounded', async () => {
  const queries: CapturedQuery[] = [];
  const executor: SqlExecutor = {
    query: async <RowType>(sql: string, values?: readonly unknown[]): Promise<SqlResult<RowType>> => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: values ?? [] });
      const normalized = sql.replace(/\s+/g, ' ');
      if (normalized.includes('FROM saas_tenant_provider_accounts')) {
        return { rows: [] as RowType[], rowCount: 0 };
      }
      if (normalized.includes('FROM saas_probe_monitors')) {
        return {
          rows: [
            {
              id: 'monitor-1',
              owner_kind: 'tenant',
              owner_tenant_id: 'tenant-1',
              account_id: 'account-1',
              provider_category: 'claude',
              probe_interval_seconds: 300,
              failure_threshold: 3,
              consecutive_failures: 2,
              last_result: 'banned',
              last_run_at: new Date('2026-10-15T00:00:00Z'),
              next_due_at: null,
              enabled: false,
              updated_at: new Date('2026-10-15T00:00:00Z'),
            },
          ] as RowType[],
          rowCount: 1,
        };
      }
      return { rows: [] as RowType[], rowCount: 0 };
    },
  };
  const store = createPostgresProbeMonitorAdminStore(executor);
  await assert.rejects(
    store.triggerMonitor({
      ownerKind: 'tenant',
      tenantId: 'tenant-1',
      accountId: 'missing',
      actorUserId: 'operator-1',
      sourceIp: null,
      userAgent: null,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AccountProbeHttpError' && error.status === 404,
  );
  const monitors = await store.listMonitors({ ownerKind: 'tenant', tenantId: 'tenant-1', limit: 999 });
  assert.equal(monitors.length, 1);
  assert.equal(monitors[0]?.category, 'claude');
  assert.equal(monitors[0]?.lastResult, 'banned');
  assert.equal(monitors[0]?.enabled, false);
  const list = queries.find((query) => query.sql.includes('FROM saas_probe_monitors'));
  assert.ok(list);
  assert.match(list.sql, /ORDER BY updated_at DESC/);
  assert.equal(list.values.at(-1), 200, 'the limit is clamped to the maximum');
});

test('the generated challenge is the sub2api arithmetic contract', () => {
  for (let index = 0; index < 32; index += 1) {
    const challenge = generateArithmeticChallenge();
    assert.match(challenge.prompt, /^What is [0-9]+ \+ [0-9]+\? Reply with only the number\.$/);
    assert.match(challenge.answer, /^[0-9]{1,3}$/);
    const operands = challenge.prompt.match(/^What is ([0-9]+) \+ ([0-9]+)\?/);
    assert.ok(operands);
    assert.equal(Number(operands[1]) + Number(operands[2]), Number(challenge.answer));
  }
});
