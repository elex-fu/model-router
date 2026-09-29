import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';

test('config import previews replace and stable-ID merge, protects secrets, and commits with CAS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-config-import-'));
  let origin = 'http://127.0.0.1:15006';
  const app = createAdminServer({
    configPath: join(dir, 'config.json'),
    bootstrapToken: 'local-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/admin/api/v1`;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, json: (await response.json()) as any };
  };
  try {
    assert.equal(
      (await request('/bootstrap', 'POST', { token: 'local-token', name: 'admin', password: 'secure-password-123' }))
        .status,
      201,
    );
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const auth = {
      cookie: login.headers.get('set-cookie')!.split(';')[0],
      origin,
      'x-csrf-token': login.json.data.csrfToken as string,
    };
    const initial = (await request('/config', 'GET', undefined, auth)).json.data;
    app.store.secrets.put('import-secret', 'encrypted test secret');
    const upstream = {
      id: 'u1',
      name: 'First',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'https://example.com/v1',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [{ id: 'c1', label: 'Primary', enabled: true, secret: { type: 'secret', id: 'import-secret' } }],
      models: [{ id: 'model-one', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
      priority: 0,
      sortIndex: 0,
      policy: {},
    };
    const hash = createHash('sha256').update('mr_example').digest('hex');
    const key = {
      id: 'k1',
      name: 'Client',
      enabled: true,
      createdAt: new Date().toISOString(),
      keyHash: hash,
      keyPrefix: 'mr_example',
    };
    const first = { ...initial, upstreams: [upstream], proxyKeys: [key] };
    const replacePreview = await request('/config/import-preview', 'POST', { mode: 'replace', config: first }, auth);
    assert.equal(replacePreview.json.data.valid, true, JSON.stringify(replacePreview.json));
    assert.ok(replacePreview.json.data.diff.some((item: any) => item.path === 'upstreams.u1'));
    assert.equal(JSON.stringify(replacePreview.json).includes(hash), false);
    assert.equal((await request('/config/import-preview', 'POST', { config: first }, auth)).json.data.mode, 'replace');
    assert.equal(
      (await request('/config/import', 'POST', { mode: 'replace', config: first }, { ...auth, 'if-match': '"cfg-1"' }))
        .status,
      200,
    );

    const route = {
      id: 'r1',
      name: 'Route',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'exact', value: 'model-one' },
      order: 0,
      publishedModels: ['model-one'],
      targets: [{ upstreamId: 'u1', model: 'model-one' }],
    };
    const mergeInput = { ...first, upstreams: [{ ...upstream, name: 'Renamed' }], routes: [route], proxyKeys: [] };
    const mergePreview = await request('/config/import-preview', 'POST', { mode: 'merge', config: mergeInput }, auth);
    assert.equal(mergePreview.json.data.valid, true, JSON.stringify(mergePreview.json));
    assert.ok(
      mergePreview.json.data.diff.some((item: any) => item.path === 'upstreams.u1.name' && item.after === 'Renamed'),
    );
    assert.ok(mergePreview.json.data.diff.some((item: any) => item.path === 'routes.r1'));
    const merged = await request(
      '/config/import',
      'POST',
      { mode: 'merge', config: mergeInput },
      { ...auth, 'if-match': '"cfg-2"' },
    );
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    assert.equal(merged.json.data.persistedRevision, 3);
    assert.equal(merged.json.data.config.proxyKeys.length, 1);
    assert.equal(merged.json.data.config.upstreams[0].name, 'Renamed');
    assert.equal(
      (
        await request(
          '/config/import',
          'POST',
          { mode: 'merge', config: mergeInput },
          { ...auth, 'if-match': '"cfg-2"' },
        )
      ).status,
      412,
    );

    const changedSecret = {
      ...mergeInput,
      upstreams: [
        {
          ...upstream,
          credentials: [{ ...upstream.credentials[0], secret: { type: 'env', name: 'MISSING_IMPORT_SECRET' } }],
        },
      ],
    };
    const secretPreview = await request(
      '/config/import-preview',
      'POST',
      { mode: 'merge', config: changedSecret },
      auth,
    );
    assert.equal(secretPreview.json.data.valid, false);
    assert.ok(secretPreview.json.data.conflicts.some((item: any) => item.code === 'secret_reference_change'));
    assert.equal(
      (
        await request(
          '/config/import',
          'POST',
          { mode: 'merge', config: changedSecret },
          { ...auth, 'if-match': '"cfg-3"' },
        )
      ).status,
      409,
    );
    const changedKey = {
      ...mergeInput,
      proxyKeys: [{ ...key, keyHash: createHash('sha256').update('other').digest('hex') }],
    };
    const keyPreview = await request('/config/import-preview', 'POST', { mode: 'merge', config: changedKey }, auth);
    assert.ok(keyPreview.json.data.conflicts.some((item: any) => item.code === 'proxy_key_change'));
    assert.equal(JSON.stringify(keyPreview.json).includes(changedKey.proxyKeys[0].keyHash), false);
    assert.equal(
      (await request('/config/import-preview', 'POST', { mode: 'append', config: first }, auth)).status,
      400,
    );
    assert.equal(
      (await request('/config/import', 'POST', { mode: 'append', config: first }, { ...auth, 'if-match': '"cfg-3"' }))
        .status,
      400,
    );
    assert.equal((await request('/config')).status, 401);
    assert.equal((await request('/config', 'GET', undefined, auth)).json.data.revision, 3);
    const missingSecret = {
      ...mergeInput,
      upstreams: [
        {
          ...upstream,
          id: 'u2',
          credentials: [{ ...upstream.credentials[0], secret: { type: 'secret', id: 'unbound-secret' } }],
        },
      ],
    };
    const missingPreview = await request(
      '/config/import-preview',
      'POST',
      { mode: 'merge', config: missingSecret },
      auth,
    );
    assert.ok(missingPreview.json.data.conflicts.some((item: any) => item.code === 'secret_unavailable'));
    const brokenReference = {
      ...mergeInput,
      routes: [{ ...route, targets: [{ upstreamId: 'missing', model: 'model-one' }] }],
    };
    const referencePreview = await request(
      '/config/import-preview',
      'POST',
      { mode: 'merge', config: brokenReference },
      auth,
    );
    assert.ok(referencePreview.json.data.conflicts.some((item: any) => item.code === 'reference_conflict'));
    assert.equal(
      (
        await request(
          '/config/import',
          'POST',
          { mode: 'merge', config: brokenReference },
          { ...auth, 'if-match': '"cfg-3"' },
        )
      ).status,
      409,
    );
    const replace = { ...first, routes: [], proxyKeys: [], upstreams: [upstream] };
    const removal = await request('/config/import-preview', 'POST', { mode: 'replace', config: replace }, auth);
    assert.ok(removal.json.data.diff.some((item: any) => item.path === 'routes.r1' && item.after === undefined));
    assert.ok(removal.json.data.diff.some((item: any) => item.path === 'proxyKeys.k1' && item.after === undefined));
    assert.equal(JSON.stringify(removal.json).includes(hash), false);
    assert.equal(
      (
        await request(
          '/config/import',
          'POST',
          { mode: 'replace', config: replace },
          { ...auth, 'if-match': '"cfg-3"' },
        )
      ).status,
      200,
    );
    const finalConfig = (await request('/config', 'GET', undefined, auth)).json.data;
    assert.equal(finalConfig.revision, 4);
    assert.deepEqual(finalConfig.routes, []);
    assert.deepEqual(finalConfig.proxyKeys, []);
    const audit = app.store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='config.import'").get() as {
      n: number;
    };
    assert.equal(audit.n, 3);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider preset API advertises the native custom Responses preset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-responses-preset-'));
  let origin = 'http://127.0.0.1:15006';
  const app = createAdminServer({
    configPath: join(dir, 'config.json'),
    bootstrapToken: 'local-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/admin/api/v1`;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, json: (await response.json()) as any };
  };
  try {
    assert.equal(
      (await request('/bootstrap', 'POST', { token: 'local-token', name: 'admin', password: 'secure-password-123' }))
        .status,
      201,
    );
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const auth = { cookie: login.headers.get('set-cookie')!.split(';')[0] };
    const response = await request('/provider-presets', 'GET', undefined, auth);
    assert.equal(response.status, 200);
    const preset = response.json.data.find((item: any) => item.id === 'custom-responses');
    assert.deepEqual(preset, {
      id: 'custom-responses',
      provider: 'custom',
      protocol: 'responses',
      name: 'custom responses',
      baseUrl: '',
      endpoints: { generate: 'responses' },
      auth: { mode: 'bearer' },
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
