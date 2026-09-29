import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';
import { ControlStore } from '../../src/control/store.js';
import { createOAuthAccountAdminAdapters } from '../../src/server/oauth-account-admin.js';
import { OAuthAccountStore } from '../../src/server/oauth-accounts.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

const dir = mkdtempSync(join(tmpdir(), 'mr-admin-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('bootstrap, session, CSRF, CAS, Ollama upstream and proxy key', async () => {
  const configPath = join(dir, 'config.json');
  let publicOrigin = 'http://127.0.0.1:15006';
  let previewKeyId: string | undefined;
  const app = createAdminServer({
    configPath,
    bootstrapToken: 'local-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => publicOrigin,
    runtime: {
      previewRoute: ({ model, protocol, proxyKeyId }) => {
        previewKeyId = proxyKeyId;
        return {
          matched: true,
          runtime: true,
          candidates: [{ upstreamId: 'ollama', model, protocol, proxyKeyId: proxyKeyId ?? null }],
        };
      },
      resetCircuit: () => {},
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const addr = app.server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/admin/api/v1`;
  publicOrigin = `http://127.0.0.1:${addr.port}`;
  const request = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, json: (await response.json()) as any };
  };
  try {
    const openapi = await fetch(`${base}/openapi.json`);
    assert.equal(openapi.status, 200);
    assert.equal(openapi.headers.get('content-type'), 'application/vnd.oai.openapi+json;version=3.1');
    assert.equal((await openapi.json()).openapi, '3.1.0');
    const state = await request('/bootstrap');
    assert.equal(state.json.data.initialized, false);
    assert.equal((await request('/config')).response.status, 401);
    const boot = await request('/bootstrap', 'POST', {
      token: 'local-token',
      name: 'admin',
      password: 'secure-password-123',
    });
    assert.equal(boot.response.status, 201);
    assert.equal(
      (await request('/bootstrap', 'POST', { token: 'local-token', name: 'another', password: 'another-password' }))
        .response.status,
      409,
    );
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
    const auth = { cookie, origin: base.replace('/admin/api/v1', ''), 'x-csrf-token': login.json.data.csrfToken };
    const initial = await request('/config', 'GET', undefined, auth);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.response.headers.get('etag'), '"cfg-1"');
    const upstream = {
      id: 'ollama',
      name: 'Local Ollama',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      endpoints: { generate: 'chat/completions', models: 'models' },
      auth: { mode: 'none' },
      credentials: [],
      models: [
        { id: 'qwen2.5-coder:7b', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' },
      ],
      priority: 0,
      sortIndex: 0,
      policy: { allowInsecureHttp: true },
    };
    const noCsrf = await request('/upstreams', 'POST', upstream, {
      cookie,
      origin: auth.origin,
      'if-match': '"cfg-1"',
    });
    assert.equal(noCsrf.response.status, 403);
    const created = await request('/upstreams', 'POST', upstream, { ...auth, 'if-match': '"cfg-1"' });
    assert.equal(created.response.status, 201);
    assert.equal(created.json.data.persistedRevision, 2);
    const stale = await request('/upstreams', 'POST', upstream, { ...auth, 'if-match': '"cfg-1"' });
    assert.equal(stale.response.status, 412);
    const route = {
      id: 'qwen-route',
      name: 'Qwen',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'exact', value: 'qwen' },
      order: 0,
      publishedModels: ['qwen'],
      targets: [{ upstreamId: 'ollama', model: 'qwen2.5-coder:7b' }],
    };
    assert.equal((await request('/routes', 'POST', route, { ...auth, 'if-match': '"cfg-2"' })).response.status, 201);
    const invalidPreview = await request('/routes/preview', 'POST', { model: '', protocol: 'other' }, auth);
    assert.equal(invalidPreview.response.status, 422);
    assert.equal(invalidPreview.json.error.code, 'INVALID_REQUEST');
    const preview = await request(
      '/routes/preview',
      'POST',
      { model: 'qwen', protocol: 'openai', proxyKeyId: 'key-for-preview' },
      auth,
    );
    assert.equal(preview.json.data.candidates[0].upstreamId, 'ollama');
    assert.equal(previewKeyId, 'key-for-preview');
    const connect = await request('/connect/templates?model=qwen&protocol=openai', 'GET', undefined, auth);
    assert.equal(connect.response.status, 200);
    assert.match(connect.json.data.curl, /\/v1\/chat\/completions/);
    assert.equal(connect.json.data.body.model, 'qwen');
    const events = await fetch(base + '/events', { headers: { cookie } });
    assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = events.body?.getReader();
    assert.ok(reader);
    const firstEvent = await reader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /event: resync/);
    await reader.cancel();
    const key = await request('/keys', 'POST', { name: 'client' }, { ...auth, 'if-match': '"cfg-3"' });
    assert.equal(key.response.status, 201);
    assert.match(key.json.data.secret, /^mr_/);
    const listed = await request('/keys', 'GET', undefined, auth);
    assert.equal(listed.response.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.data.length, 1);
    assert.equal('keyHash' in listed.json.data[0], false);
    assert.match(listed.json.data[0].keyPrefix, /^mr_/);
    assert.equal(JSON.stringify(listed.json).includes(key.json.data.secret), false);
    const credential = await request(
      '/upstreams/ollama/credentials',
      'POST',
      { label: 'Local test', value: 'local-secret-value' },
      { ...auth, 'if-match': '"cfg-4"' },
    );
    assert.equal(credential.response.status, 201);
    const configured = await request('/config', 'GET', undefined, auth);
    assert.equal(JSON.stringify(configured.json).includes('local-secret-value'), false);
    assert.equal(configured.json.data.upstreams[0].credentials[0].secret.type, 'secret');
    const invalid = await request(
      '/config/validate',
      'POST',
      {
        config: {
          ...configured.json.data,
          routes: [{ ...route, targets: [{ upstreamId: 'missing', model: 'qwen2.5-coder:7b' }] }],
        },
      },
      auth,
    );
    assert.equal(invalid.json.data.valid, false);
    const wrongOrigin = await request(
      '/routes/preview',
      'POST',
      { model: 'qwen', protocol: 'openai' },
      { ...auth, origin: 'https://attacker.example' },
    );
    assert.equal(wrongOrigin.response.status, 403);
    const unavailable = await request('/usage/summary', 'GET', undefined, auth);
    assert.equal(unavailable.response.status, 503);
    const refreshed = await request('/session', 'GET', undefined, auth);
    assert.ok(refreshed.json.data.csrfToken);
    const logout = await request('/session', 'DELETE', undefined, {
      ...auth,
      'x-csrf-token': refreshed.json.data.csrfToken,
    });
    assert.equal(logout.response.status, 200);
    assert.equal((await request('/config', 'GET', undefined, auth)).response.status, 401);
  } finally {
    await app.close();
  }
});

test('system reports safe database diagnostics and listener configured versus actual ports', async () => {
  const configPath = join(dir, 'system-config.json');
  const store = new ControlStore(join(dir, 'system-data'));
  const telemetryStore = new SQLiteTelemetryStore(join(dir, 'system-data', 'telemetry.sqlite'));
  await telemetryStore.init();
  const observedPragmas: string[] = [];
  for (const db of [store.db, telemetryStore.connection]) {
    const originalPragma = db.pragma.bind(db);
    db.pragma = ((source: string, options?: import('better-sqlite3').Database.PragmaOptions) => {
      observedPragmas.push(source.toLowerCase());
      return originalPragma(source, options);
    }) as typeof db.pragma;
  }
  const app = createAdminServer({
    configPath,
    bootstrapToken: 'system-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    controlStore: store,
    telemetryStore,
    listenerStatus: () => ({
      proxy: {
        enabled: true,
        configured: { bindAddress: '0.0.0.0', port: 15005 },
        actual: { bindAddress: '0.0.0.0', port: 43127 },
      },
      admin: {
        enabled: true,
        configured: { bindAddress: '127.0.0.1', port: 15006 },
        actual: { bindAddress: '127.0.0.1', port: 15006 },
      },
    }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/admin/api/v1`;
  try {
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'system-token', name: 'admin', password: 'secure-password-123' }),
    });
    assert.equal(bootstrap.status, 201);
    const login = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', password: 'secure-password-123' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(`${base}/system`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data: any };
    assert.deepEqual(payload.data.listeners.proxy.configured, { bindAddress: '0.0.0.0', port: 15005 });
    assert.deepEqual(payload.data.listeners.proxy.actual, { bindAddress: '0.0.0.0', port: 43127 });
    assert.notEqual(payload.data.listeners.proxy.configured.port, payload.data.listeners.proxy.actual.port);
    for (const database of [payload.data.databases.control, payload.data.databases.telemetry]) {
      assert.deepEqual(database.health, { status: 'available', scope: 'connection', reason: null });
      assert.ok(database.capacity.allocatedBytes > 0);
      assert.ok(database.capacity.pageSizeBytes > 0);
      assert.equal(database.capacity.reason, null);
    }
    assert.deepEqual(Object.keys(payload.data.databases).sort(), ['control', 'telemetry']);
    assert.equal(observedPragmas.includes('quick_check(1)'), false);
    assert.equal(observedPragmas.includes('integrity_check'), false);
    for (const pragma of ['page_count', 'page_size', 'freelist_count'])
      assert.equal(observedPragmas.filter((value) => value === pragma).length, 2);
    assert.equal(JSON.stringify(payload).includes(store.dataDir), false);
    assert.equal(JSON.stringify(payload).includes(store.keyPath), false);
    assert.equal(JSON.stringify(payload).includes('secure-password-123'), false);
  } finally {
    await app.close();
    await telemetryStore.close();
    store.close();
  }
});

test('OAuth account routes return safe DTOs and pass supported PATCH fields', async () => {
  const oauthDir = mkdtempSync(join(tmpdir(), 'mr-admin-oauth-'));
  const configPath = join(oauthDir, 'config.json');
  const store = new ControlStore(oauthDir);
  const accountStore = new OAuthAccountStore(configPath, store.secrets);
  accountStore.add({
    id: 'route-account',
    provider: 'codex_oauth',
    accessToken: 'route-access-secret',
    refreshToken: 'route-refresh-secret',
    expiresAt: Date.now() + 120_000,
    isDefault: false,
  });
  let origin = '';
  const app = createAdminServer({
    configPath,
    controlStore: store,
    bootstrapToken: 'oauth-local-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
    adapters: createOAuthAccountAdminAdapters(accountStore, store),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/admin/api/v1`;
  origin = `http://127.0.0.1:${address.port}`;
  const request = async (route: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, json: (await response.json()) as { data: unknown; error?: { code?: string } } };
  };
  try {
    await request('/bootstrap', 'POST', { token: 'oauth-local-token', name: 'admin', password: 'secure-password-123' });
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const loginData = login.json.data as Record<string, unknown>;
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const auth = {
      cookie,
      'x-csrf-token': String(loginData.csrfToken ?? ''),
    };
    const listed = await request('/accounts', 'GET', undefined, auth);
    assert.equal(listed.response.status, 200);
    const rows = listed.json.data as Array<Record<string, unknown>>;
    const storedAccount = accountStore.list()[0];
    assert.ok(storedAccount?.expiresAt);
    assert.equal(typeof rows[0].expiresAt, 'string');
    assert.equal(rows[0].expiresAt, new Date(storedAccount.expiresAt).toISOString());
    assert.equal(rows[0].refreshAvailable, false);
    for (const forbidden of ['accessToken', 'refreshToken', 'secretRef', 'route-access-secret', 'route-refresh-secret'])
      assert.equal(JSON.stringify(listed.json).includes(forbidden), false);

    const patched = await request('/accounts/route-account', 'PATCH', { isDefault: true }, auth);
    assert.equal(patched.response.status, 200, JSON.stringify(patched.json));
    assert.equal(accountStore.getDefault('codex_oauth')?.id, 'route-account');
    const rejected = await request('/accounts/route-account', 'PATCH', { isDefault: false }, auth);
    assert.equal(rejected.response.status, 422);
    assert.equal(rejected.json.error?.code, 'UNSUPPORTED_ACCOUNT_MUTATION');
    const events = store.db.prepare('SELECT action,detail FROM audit_events').all() as Array<{
      action: string;
      detail: string;
    }>;
    const accountEvents = events.filter((event) => event.action.startsWith('oauth.account.'));
    assert.equal(accountEvents.length, 1);
    assert.equal(accountEvents[0].action, 'oauth.account.set_default');
    assert.doesNotMatch(
      accountEvents[0].detail,
      /route-access-secret|route-refresh-secret|accessToken|refreshToken|secretRef/,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(oauthDir, { recursive: true, force: true });
  }
});

test('account credential and device flow routes forward allowlisted bodies with server actor', async () => {
  const routeDir = mkdtempSync(join(tmpdir(), 'mr-admin-account-routes-'));
  const configPath = join(routeDir, 'config.json');
  const store = new ControlStore(routeDir);
  const received: Array<{ route: string; input: Record<string, unknown> }> = [];
  const app = createAdminServer({
    configPath,
    controlStore: store,
    bootstrapToken: 'account-routes-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
    adapters: {
      accountClientCredentials: async (input) => {
        received.push({ route: 'client-credentials', input });
        if (input.provider === 'error-provider') throw new Error(`adapter failed: ${String(input.clientSecret)}`);
        return { accepted: true };
      },
      deviceFlowCreate: async (input) => {
        received.push({ route: 'device-flows', input });
        return { accepted: true };
      },
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/admin/api/v1`;
  const request = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, json: (await response.json()) as { data?: unknown; error?: { code?: string } } };
  };
  try {
    await request('/bootstrap', 'POST', {
      token: 'account-routes-token',
      name: 'admin',
      password: 'secure-password-123',
    });
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const auth = { cookie, 'x-csrf-token': String((login.json.data as Record<string, unknown>).csrfToken) };

    const clientSecret = 'must-not-leak-client-secret';
    const clientCredentials = await request(
      '/accounts/client-credentials',
      'POST',
      {
        provider: 'example-provider',
        name: 'Work account',
        clientId: 'client-123',
        clientSecret,
        tokenUrl: 'https://identity.example/token',
        scopes: ['read', 'write'],
        actor: 'forged-client-actor',
        unexpected: 'drop-me',
      },
      auth,
    );
    assert.equal(clientCredentials.response.status, 201);
    assert.equal(JSON.stringify(clientCredentials.json).includes(clientSecret), false);

    const deviceFlow = await request(
      '/accounts/device-flows',
      'POST',
      {
        provider: 'device-provider',
        clientId: 'device-client-456',
        scopes: ['profile'],
        actor: 'forged-client-actor',
        clientSecret: 'must-also-be-dropped',
        unexpected: 'drop-me-too',
      },
      auth,
    );
    assert.equal(deviceFlow.response.status, 202);

    assert.deepEqual(received, [
      {
        route: 'client-credentials',
        input: {
          provider: 'example-provider',
          name: 'Work account',
          clientId: 'client-123',
          clientSecret,
          tokenUrl: 'https://identity.example/token',
          scopes: ['read', 'write'],
          actor: 'admin',
        },
      },
      {
        route: 'device-flows',
        input: { provider: 'device-provider', clientId: 'device-client-456', scopes: ['profile'], actor: 'admin' },
      },
    ]);
    const audit = store.db.prepare('SELECT detail FROM audit_events').all() as Array<{ detail: string }>;
    assert.equal(JSON.stringify(audit).includes(clientSecret), false);
    const adapterFailure = await request(
      '/accounts/client-credentials',
      'POST',
      { provider: 'error-provider', clientId: 'client-error', clientSecret },
      auth,
    );
    assert.equal(adapterFailure.response.status, 503);
    assert.equal(adapterFailure.json.error?.code, 'ADMIN_DEPENDENCY_ERROR');
    assert.equal(JSON.stringify(adapterFailure.json).includes(clientSecret), false);
    assert.deepEqual(received[2], {
      route: 'client-credentials',
      input: { provider: 'error-provider', clientId: 'client-error', clientSecret, actor: 'admin' },
    });
  } finally {
    await app.close();
    store.close();
    rmSync(routeDir, { recursive: true, force: true });
  }
});

test('account credential and device flow routes report unavailable without adapters', async () => {
  const routeDir = mkdtempSync(join(tmpdir(), 'mr-admin-account-unavailable-'));
  const app = createAdminServer({
    configPath: join(routeDir, 'config.json'),
    bootstrapToken: 'account-unavailable-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/admin/api/v1`;
  const request = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, json: (await response.json()) as { data?: unknown; error?: { code?: string } } };
  };
  try {
    await request('/bootstrap', 'POST', {
      token: 'account-unavailable-token',
      name: 'admin',
      password: 'secure-password-123',
    });
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const auth = { cookie, 'x-csrf-token': String((login.json.data as Record<string, unknown>).csrfToken) };
    for (const path of ['/accounts/client-credentials', '/accounts/device-flows']) {
      const unavailable = await request(path, 'POST', { provider: 'example-provider' }, auth);
      assert.equal(unavailable.response.status, 503);
      assert.equal(unavailable.json.error?.code, 'FEATURE_UNAVAILABLE');
    }
  } finally {
    await app.close();
    rmSync(routeDir, { recursive: true, force: true });
  }
});
