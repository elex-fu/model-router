import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ConfigServiceV2, ConfigValidationError } from '../../src/config/v2-service.js';

const configPath = '/tmp/model-router-http-policy-test.json';
const service = new ConfigServiceV2(configPath);

function candidate(baseUrl: string, allowInsecureHttp?: boolean) {
  const config = defaultConfigV2(configPath, 'router-test');
  config.upstreams.push({
    id: 'local',
    name: 'Local',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl,
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'none' },
    credentials: [],
    models: [],
    priority: 0,
    sortIndex: 0,
    policy: allowInsecureHttp === undefined ? {} : { allowInsecureHttp },
  });
  return config;
}

test('HTTPS works by default', async () => {
  assert.equal((await service.validate(candidate('https://api.example.com/v1'))).valid, true);
});

for (const host of [
  'localhost',
  '127.0.0.1',
  '127.42.0.1',
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.1.2',
  '[::1]',
  '[fd12::1]',
  '[fc00::1]',
]) {
  test(`private HTTP ${host} requires explicit opt-in`, async () => {
    const url = `http://${host}:11434/v1`;
    const denied = await service.validate(candidate(url));
    assert.equal(denied.valid, false);
    assert.ok(denied.errors.some((issue) => issue.code === 'insecure_http_requires_opt_in'));
    assert.equal((await service.validate(candidate(url, true))).valid, true);
  });
}

for (const host of [
  'example.com',
  'ollama.internal',
  'localhost.evil.example',
  '8.8.8.8',
  '172.32.0.1',
  '192.169.0.1',
  '169.254.169.254',
  '0.0.0.0',
  '[fe80::1]',
  '[::ffff:127.0.0.1]',
]) {
  test(`HTTP ${host} rejected even with opt-in`, async () => {
    const result = await service.validate(candidate(`http://${host}/v1`, true));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((issue) => issue.code === 'insecure_http_public_host'));
  });
}

for (const url of ['http://user:password@127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1#fragment']) {
  test(`URL with userinfo or fragment is rejected: ${url}`, async () => {
    const result = await service.validate(candidate(url, true));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((issue) => issue.code === 'url'));
  });
}

test('OAuth token URL receives the same outbound HTTP policy', async () => {
  process.env.MODEL_ROUTER_HTTP_POLICY_TEST_SECRET = 'test-only';
  try {
    const config = candidate('https://api.example.com/v1');
    config.upstreams[0]!.auth = {
      mode: 'oauth',
      tokenUrl: 'http://169.254.169.254/token',
      clientId: 'client',
      clientSecret: { type: 'env', name: 'MODEL_ROUTER_HTTP_POLICY_TEST_SECRET' },
    };
    config.upstreams[0]!.policy.allowInsecureHttp = true;
    const denied = await service.validate(config);
    assert.ok(
      denied.errors.some((issue) => issue.path.endsWith('auth.tokenUrl') && issue.code === 'insecure_http_public_host'),
    );
    config.upstreams[0]!.auth.tokenUrl = 'http://127.0.0.1:8080/token';
    assert.equal((await service.validate(config)).valid, true);
  } finally {
    delete process.env.MODEL_ROUTER_HTTP_POLICY_TEST_SECRET;
  }
});

test('legacy localhost HTTP migration requires and preserves explicit opt-in before secret writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-http-policy-'));
  const file = join(dir, 'config.json');
  const legacy = {
    server: {},
    upstreams: [
      {
        name: 'ollama',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKeys: ['secret-value'],
        models: ['qwen2.5-coder:7b'],
        enabled: true,
      },
    ],
    proxyKeys: [],
  };
  const raw = JSON.stringify(legacy);
  writeFileSync(file, raw);
  let stored = 0;
  let backedUp = 0;
  const migrated = new ConfigServiceV2(file, {
    storeSecret: async () => {
      stored++;
      return 'sec_test';
    },
    hasSecret: () => true,
    backupLegacy: async () => {
      backedUp++;
    },
  });
  try {
    await assert.rejects(
      () => migrated.loadRaw(),
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.issues.some((issue) => issue.code === 'insecure_http_requires_opt_in'),
    );
    assert.equal(stored, 0);
    assert.equal(backedUp, 0);
    assert.equal(readFileSync(file, 'utf8'), raw);
    legacy.upstreams[0] = {
      ...legacy.upstreams[0],
      policy: { allowInsecureHttp: true },
    } as (typeof legacy.upstreams)[0];
    writeFileSync(file, JSON.stringify(legacy));
    const result = await migrated.loadRaw();
    assert.equal(result.upstreams[0]?.policy.allowInsecureHttp, true);
    assert.equal(stored, 1);
    assert.equal(backedUp, 1);
    assert.equal(readFileSync(file, 'utf8').includes('secret-value'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
