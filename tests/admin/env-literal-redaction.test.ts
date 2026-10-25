import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';

const literal = 'sk-synthetic_credential_abcdefghijklmnop';

test('legacy env secrets are redacted on API/export/UI input and roundtrip safely through import and CAS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-env-literal-admin-'));
  const configPath = join(dir, 'config.json');
  const config = defaultConfigV2(configPath, 'test');
  config.upstreams.push({
    id: 'u',
    name: 'U',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'https://example.invalid',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'bearer' },
    credentials: [{ id: 'c', label: 'C', enabled: true, secret: { type: 'env', name: literal } }],
    models: [],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  let origin = 'http://127.0.0.1';
  const app = createAdminServer({
    configPath,
    bootstrapToken: 'bootstrap',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/admin/api/v1${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(text.includes(literal), false, `credential leaked in ${path}`);
    return { status: response.status, headers: response.headers, json: JSON.parse(text) };
  };
  try {
    await request('/bootstrap', 'POST', { token: 'bootstrap', name: 'admin', password: 'secure-password-123' });
    const login = await request('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const auth = {
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      origin,
      'x-csrf-token': login.json.data.csrfToken,
    };
    const raw = await request('/config', 'GET', undefined, auth);
    assert.deepEqual(raw.json.data.upstreams[0].credentials[0].secret, { type: 'inline', value: '' });
    const upstreams = await request('/upstreams', 'GET', undefined, auth);
    assert.equal(upstreams.json.data[0].credentials[0].status, 'configured');
    const exported = await request('/config/export', 'GET', undefined, auth);
    const preview = await request('/config/import-preview', 'POST', { config: exported.json.data.config }, auth);
    assert.equal(preview.json.data.valid, true, JSON.stringify(preview.json));
    const validation = await request('/config/validate', 'POST', { config: exported.json.data.config }, auth);
    assert.equal(validation.status, 200, JSON.stringify(validation.json));
    assert.equal(validation.json.data.valid, true);
    const imported = await request(
      '/config/import',
      'POST',
      { config: exported.json.data.config },
      { ...auth, 'if-match': '"cfg-1"' },
    );
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    const stored = await app.control.raw();
    assert.deepEqual(stored.upstreams[0]!.credentials[0]!.secret, { type: 'inline', value: literal });
    assert.equal(
      JSON.stringify(app.store.db.prepare('SELECT config_json FROM config_history').all()).includes(literal),
      false,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
