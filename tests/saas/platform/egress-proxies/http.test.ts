import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  createEgressProxiesHttpHandler,
  createPostgresEgressProxyAdminStore,
  type EgressProxiesHttpOptions,
  type EgressProxyAdminRecord,
  type EgressProxyAdminStore,
} from '../../../../src/saas/platform/egress-proxies-http.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

function proxyRecord(overrides: Partial<EgressProxyAdminRecord> = {}): EgressProxyAdminRecord {
  return {
    id: 'proxy-1',
    name: 'primary-exit',
    protocol: 'socks5h',
    host: 'proxy.example.test',
    port: 1080,
    hasCredentials: true,
    status: 'active',
    expiresAt: null,
    fallbackMode: 'none',
    backupProxyId: null,
    lastProbeAt: '2026-10-15T00:00:00.000Z',
    lastProbeLatencyMs: 240,
    lastProbeIp: '198.51.100.7',
    lastProbeQuality: 'ok',
    ...overrides,
  };
}

function validCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'primary-exit',
    protocol: 'socks5',
    host: 'proxy.example.test',
    port: 1080,
    credentials: { username: 'operator', password: 'proxy-secret' },
    status: 'active',
    expiresAt: null,
    fallbackMode: 'none',
    backupProxyId: null,
    ...overrides,
  };
}

interface StoreCall {
  readonly action: string;
  readonly input: unknown;
}

function fakeStore(): EgressProxyAdminStore & { readonly calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const proxies = new Map<string, EgressProxyAdminRecord>();
  return {
    calls,
    async list() {
      calls.push({ action: 'list', input: null });
      return [...proxies.values()];
    },
    async get(id) {
      calls.push({ action: 'get', input: id });
      return proxies.get(id) ?? null;
    },
    async create(input) {
      calls.push({ action: 'create', input });
      const record = proxyRecord({
        id: 'proxy-1',
        name: input.name,
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        hasCredentials: input.credentials !== undefined && input.credentials !== null,
      });
      proxies.set(record.id, record);
      return record;
    },
    async update(id, input) {
      calls.push({ action: 'update', input: { id, ...input } });
      const existing = proxies.get(id);
      if (!existing) return null;
      const record = proxyRecord({
        ...existing,
        name: input.name,
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        hasCredentials: input.credentials === undefined ? existing.hasCredentials : input.credentials !== null,
      });
      proxies.set(id, record);
      return record;
    },
    async remove(id) {
      calls.push({ action: 'delete', input: id });
      return proxies.delete(id);
    },
  };
}

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: Record<string, unknown>; handled: boolean }>;
  readonly store: EgressProxyAdminStore & { readonly calls: StoreCall[] };
  readonly auditCalls: Array<{ action: string; targetId: string }>;
}

function harness(store: EgressProxyAdminStore = fakeStore()): Harness {
  const auditCalls: Array<{ action: string; targetId: string }> = [];
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: EgressProxiesHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    store,
    async audit(input) {
      auditCalls.push({ action: input.action, targetId: input.targetId });
    },
    publicOrigin: ORIGIN,
  };
  const handler = createEgressProxiesHttpHandler(options);

  return {
    store: store as EgressProxyAdminStore & { readonly calls: StoreCall[] },
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

test('list returns proxy summaries with probe quality and no URL or credentials', async () => {
  const h = harness();
  await h.request('/admin/api/v1/egress-proxies/create', validCreateBody());
  const response = await h.request('/admin/api/v1/egress-proxies/list', {});
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as { proxies: Array<Record<string, unknown>> };
  assert.equal(data.proxies.length, 1);
  const text = JSON.stringify(data);
  assert.equal(text.includes('proxy-secret'), false);
  assert.equal(text.includes('socks5h://'), false);
  assert.equal(text.includes('url'), false);
});

test('unrelated paths fall through to the next handler', async () => {
  const h = harness();
  for (const path of [
    '/admin/api/v1/egress-proxies/unknown',
    '/admin/api/v1/egress-proxies/',
    '/admin/api/v1/billing-groups/list',
    '/healthz',
  ]) {
    const response = await h.request(path, {});
    assert.equal(response.handled, false, path);
  }
});

test('create accepts credentials once and never echoes them', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/egress-proxies/create', validCreateBody());
  assert.equal(response.status, 200);
  const proxy = (response.body.data as { proxy: Record<string, unknown> }).proxy;
  assert.equal(proxy.hasCredentials, true);
  assert.equal('credentials' in proxy, false);
  assert.equal('username' in proxy, false);
  assert.equal('password' in proxy, false);
  const create = h.store.calls.find((call) => call.action === 'create');
  assert.ok(create);
  assert.deepEqual((create.input as { credentials: unknown }).credentials, {
    username: 'operator',
    password: 'proxy-secret',
  });
  assert.equal(h.auditCalls.length, 1);
  assert.equal(h.auditCalls[0].action, 'saas_egress_proxy.created');
});

test('socks5 upgrades to socks5h and invalid protocols fail closed', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/egress-proxies/create', validCreateBody());
  assert.equal(response.status, 200);
  const proxy = (response.body.data as { proxy: { protocol: string } }).proxy;
  assert.equal(proxy.protocol, 'socks5h');

  const invalid = await h.request('/admin/api/v1/egress-proxies/create', validCreateBody({ protocol: 'gopher' }));
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body.error as Record<string, unknown>).code, 'EGRESS_PROXY_INVALID_INPUT');
  assert.equal(JSON.stringify(invalid.body).includes('gopher'), false);
});

test('fallback mode shape is enforced', async () => {
  const h = harness();
  const missingBackup = await h.request(
    '/admin/api/v1/egress-proxies/create',
    validCreateBody({ fallbackMode: 'proxy', backupProxyId: null }),
  );
  assert.equal(missingBackup.status, 400);
  const strayBackup = await h.request(
    '/admin/api/v1/egress-proxies/create',
    validCreateBody({ fallbackMode: 'none', backupProxyId: 'backup-id' }),
  );
  assert.equal(strayBackup.status, 400);
  const valid = await h.request(
    '/admin/api/v1/egress-proxies/create',
    validCreateBody({ fallbackMode: 'proxy', backupProxyId: 'backup-id' }),
  );
  assert.equal(valid.status, 200);
});

test('update keeps credentials when absent and clears them on null', async () => {
  const h = harness();
  await h.request('/admin/api/v1/egress-proxies/create', validCreateBody());
  const keep = await h.request('/admin/api/v1/egress-proxies/update', {
    ...validCreateBody({ credentials: undefined }),
    proxyId: 'proxy-1',
  });
  assert.equal(keep.status, 200);
  const updateCall = h.store.calls.find((call) => call.action === 'update');
  assert.equal((updateCall.input as { credentials: unknown }).credentials, undefined);

  const clear = await h.request('/admin/api/v1/egress-proxies/update', {
    ...validCreateBody({ credentials: null }),
    proxyId: 'proxy-1',
  });
  assert.equal(clear.status, 200);
  const clearCall = h.store.calls.filter((call) => call.action === 'update').at(-1);
  assert.equal((clearCall.input as { credentials: unknown }).credentials, null);
  assert.equal((clear.body.data as { proxy: { hasCredentials: boolean } }).proxy.hasCredentials, false);
});

test('delete maps in-use proxies to 409 and absent to 404', async () => {
  const store = fakeStore();
  const originalRemove = store.remove.bind(store);
  store.remove = async (id: string) => (id === 'proxy-1' ? 'in_use' : originalRemove(id));
  const h = harness(store);
  const inUse = await h.request('/admin/api/v1/egress-proxies/delete', { proxyId: 'proxy-1' });
  assert.equal(inUse.status, 409);
  assert.equal((inUse.body.error as Record<string, unknown>).code, 'PROXY_IN_USE');
  const absent = await h.request('/admin/api/v1/egress-proxies/delete', { proxyId: 'nope' });
  assert.equal(absent.status, 404);
});

test('auth, origin, CSRF and body-shape failures fail closed', async () => {
  const h = harness();
  const method = await h.request('/admin/api/v1/egress-proxies/list', {}, { method: 'GET' });
  assert.equal(method.status, 405);
  const origin = await h.request('/admin/api/v1/egress-proxies/list', {}, { headers: { origin: 'https://evil.test' } });
  assert.equal(origin.status, 403);
  assert.equal((origin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');
  const csrf = await h.request('/admin/api/v1/egress-proxies/list', {}, { headers: { 'x-csrf-token': 'wrong' } });
  assert.equal(csrf.status, 403);
  const unauthenticated = await h.request('/admin/api/v1/egress-proxies/list', {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);
  const viewer: PlatformAdminActor = { ...ACTOR, roles: ['support-readonly'] };
  const forbidden = await h.request('/admin/api/v1/egress-proxies/list', {}, { actor: viewer });
  assert.equal(forbidden.status, 403);
  const extraField = await h.request('/admin/api/v1/egress-proxies/list', { unexpected: 1 });
  assert.equal(extraField.status, 400);
  const contentType = await h.request(
    '/admin/api/v1/egress-proxies/list',
    {},
    { headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(contentType.status, 415);
});

test('bad credentials shapes are rejected without echo', async () => {
  const h = harness();
  for (const credentials of [{}, { username: '' }, { token: 'x' }, 'plain']) {
    const response = await h.request('/admin/api/v1/egress-proxies/create', validCreateBody({ credentials }));
    assert.equal(response.status, 400, JSON.stringify(credentials));
    assert.equal(JSON.stringify(response.body).includes('proxy-secret'), false);
  }
});

test('the Postgres store seals credentials server-side and stores only the envelope', async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const executor = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      statements.push({ sql, values: [...values] });
      if (sql.startsWith('INSERT INTO saas_egress_proxies')) {
        const envelope = JSON.parse(String(values[5])) as Record<string, unknown>;
        return {
          rows: [
            {
              id: values[0],
              name: values[1],
              protocol: values[2],
              host: values[3],
              port: values[4],
              auth_sealed_envelope: envelope,
              status: values[6],
              expires_at: null,
              fallback_mode: values[8],
              backup_proxy_id: values[9],
              last_probe_at: null,
              last_probe_latency_ms: null,
              last_probe_ip: null,
              last_probe_quality: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
  const kms = {
    async generateDataKey() {
      return { plaintextKey: randomBytes(32), ciphertextBlob: randomBytes(64) };
    },
  };
  const store = createPostgresEgressProxyAdminStore(executor as never, {
    deployment: 'deployment-1',
    environment: 'production',
    kms: kms as never,
    kmsKeyId: 'key-1',
  });
  const record = await store.create({
    name: 'primary-exit',
    protocol: 'socks5h',
    host: 'proxy.example.test',
    port: 1080,
    credentials: { username: 'operator', password: 'proxy-secret' },
    status: 'active',
    expiresAt: null,
    fallbackMode: 'none',
    backupProxyId: null,
  });
  assert.equal(record.hasCredentials, true);
  const insert = statements.find((statement) => statement.sql.startsWith('INSERT INTO saas_egress_proxies'));
  assert.ok(insert);
  const envelopeJson = String(insert.values[5]);
  // The stored envelope is the KMS ciphertext envelope, never credentials.
  assert.equal(envelopeJson.includes('proxy-secret'), false);
  assert.equal(envelopeJson.includes('operator'), false);
  const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.equal('username' in envelope, false);
  assert.equal('password' in envelope, false);
  // The response record carries no credential material either.
  assert.equal(JSON.stringify(record).includes('proxy-secret'), false);
});
