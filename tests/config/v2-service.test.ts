import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ConfigConflictError, ConfigServiceV2, ConfigValidationError } from '../../src/config/v2-service.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-v2-test-'));
  configPath = path.join(dir, 'config.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new instances get a valid V2 config with private atomic file', async () => {
  const service = new ConfigServiceV2(configPath);
  const initial = await service.loadRaw();
  assert.equal(initial.schemaVersion, 2);
  assert.equal(initial.revision, 1);
  assert.equal(initial.storage.dataDir, dir);
  assert.equal((await service.validate(initial)).valid, true);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('CAS commits bump revision and reject stale writers', async () => {
  const service = new ConfigServiceV2(configPath);
  const current = await service.loadRaw();
  const changed = await service.commit({ ...current, server: { ...current.server, maxAttempts: 4 } }, 1);
  assert.equal(changed.revision, 2);
  assert.equal((await service.loadRaw()).server.maxAttempts, 4);
  await assert.rejects(() => service.commit(current, 1), ConfigConflictError);
});

test('separate service instances cannot both commit the same revision', async () => {
  const first = new ConfigServiceV2(configPath);
  const second = new ConfigServiceV2(configPath);
  const current = await first.loadRaw();
  const outcomes = await Promise.allSettled([
    first.commit({ ...current, server: { ...current.server, maxAttempts: 4 } }, current.revision),
    second.commit({ ...current, server: { ...current.server, maxAttempts: 5 } }, current.revision),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal((await first.loadRaw()).revision, 2);
  assert.equal(fs.existsSync(`${configPath}.lock`), false);
});

test('validation rejects unknown route target and unsupported Responses conversion', async () => {
  const service = new ConfigServiceV2(configPath);
  const current = await service.loadRaw();
  current.routes.push({
    id: 'route_missing',
    name: 'Missing',
    enabled: true,
    clientProtocols: ['responses'],
    match: { kind: 'exact', value: 'missing' },
    order: 0,
    publishedModels: ['missing'],
    targets: [{ upstreamId: 'unknown', model: 'x' }],
  });
  const result = await service.validate(current);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'unknown_upstream'));
});

test('generate, models and compact endpoints use the outbound URL grammar', async () => {
  const service = new ConfigServiceV2(configPath);
  const config = await service.loadRaw();
  config.upstreams.push({
    id: 'remote',
    name: 'Remote',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'https://example.com/gateway/v1?fixed=1',
    endpoints: { generate: 'chat/completions', models: 'models', compact: 'responses/compact' },
    auth: { mode: 'none' },
    credentials: [],
    models: [],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  assert.equal((await service.validate(config)).valid, true);

  for (const field of ['generate', 'models', 'compact'] as const) {
    const original = config.upstreams[0]!.endpoints[field]!;
    for (const invalid of [
      '',
      'chat/completions?x=1',
      'chat/completions#fragment',
      'chat%2fcompletions',
      'chat%5ccompletions',
      'chat%2ecompletions',
      'chat\\completions',
      '../chat',
      '/chat',
      'https://elsewhere.invalid/chat',
    ]) {
      config.upstreams[0]!.endpoints[field] = invalid;
      const result = await service.validate(config);
      assert.equal(result.valid, false, `${field}: ${invalid}`);
      assert.deepEqual(
        result.errors.filter((issue) => invalid === '' || issue.code === 'endpoint').map((issue) => issue.path),
        [invalid === '' && field === 'generate' ? `upstreams.0.endpoints.${field}` : `upstreams[0].endpoints.${field}`],
        `${field}: ${invalid}`,
      );
    }
    config.upstreams[0]!.endpoints[field] = original;
  }

  config.upstreams[0]!.endpoints.models = 'models?limit=1';
  await assert.rejects(
    () => service.commit(config, config.revision),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      error.issues.some((issue) => issue.path === 'upstreams[0].endpoints.models' && issue.code === 'endpoint'),
  );
  assert.equal((await service.loadRaw()).upstreams.length, 0);
});

test('missing environment secret warns when disabled and rejects when enabled', async () => {
  const service = new ConfigServiceV2(configPath);
  const current = await service.loadRaw();
  current.upstreams.push({
    id: 'remote',
    name: 'Remote',
    provider: 'custom',
    protocol: 'openai',
    enabled: false,
    baseUrl: 'https://example.com/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'bearer' },
    credentials: [
      { id: 'cred', label: 'Key', enabled: true, secret: { type: 'env', name: 'MODEL_ROUTER_TEST_MISSING_SECRET' } },
    ],
    models: [],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  delete process.env.MODEL_ROUTER_TEST_MISSING_SECRET;
  const disabled = await service.validate(current);
  assert.equal(disabled.valid, true);
  assert.ok(disabled.warnings.some((issue) => issue.code === 'secret_unavailable'));
  current.upstreams[0]!.enabled = true;
  const enabled = await service.validate(current);
  assert.equal(enabled.valid, false);
  assert.ok(enabled.errors.some((issue) => issue.code === 'secret_unavailable'));
});

test('non-empty inline secret values are present without an environment or secret lookup', async () => {
  let secretLookups = 0;
  const service = new ConfigServiceV2(configPath, {
    hasSecret: () => {
      secretLookups++;
      throw new Error('inline secrets must not use the encrypted secret store');
    },
  });
  const current = await service.loadRaw();
  current.upstreams.push({
    id: 'remote',
    name: 'Remote',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'https://example.com/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'bearer' },
    credentials: [
      {
        id: 'cred',
        label: 'Key',
        enabled: true,
        secret: { type: 'inline', value: 'provider-key-with-hyphens/other+characters=' },
      },
    ],
    models: [],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });

  const result = await service.validate(current);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(secretLookups, 0);
  assert.equal(
    result.warnings.some((issue) => issue.code.startsWith('secret_')),
    false,
  );
});

test('legacy plaintext credentials are encrypted through sink and proxy keys are digested', async () => {
  const secretValues: string[] = [];
  const backups: string[] = [];
  const legacy = {
    server: {
      port: 15999,
      bindAddress: '127.0.0.1',
      logFlushIntervalMs: 5000,
      logBatchSize: 10,
      maxRetries: 5,
      requestTimeoutMs: 80_000,
      failoverQueue: ['test'],
    },
    upstreams: [
      {
        name: 'test',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKeys: ['plain-upstream-secret'],
        models: ['qwen2.5-coder:7b'],
        enabled: true,
        modelMap: { coder: 'qwen2.5-coder:7b' },
        policy: { allowInsecureHttp: true },
      },
    ],
    proxyKeys: [{ name: 'client', key: 'plain-proxy-secret', enabled: true, createdAt: new Date().toISOString() }],
  };
  fs.writeFileSync(configPath, JSON.stringify(legacy));
  const service = new ConfigServiceV2(configPath, {
    storeSecret: async (value) => {
      secretValues.push(value);
      return 'secret-1';
    },
    hasSecret: (id) => id === 'secret-1',
    backupLegacy: async (raw) => {
      backups.push(raw);
    },
  });
  const result = await service.loadRaw();
  assert.deepEqual(secretValues, ['plain-upstream-secret']);
  assert.equal(result.server.maxAttempts, 5);
  assert.equal(result.server.totalRequestTimeoutMs, 80_000);
  assert.equal(result.upstreams[0]?.credentials[0]?.secret.type, 'secret');
  assert.equal(result.proxyKeys[0]?.keyHash, createHash('sha256').update('plain-proxy-secret').digest('hex'));
  assert.equal(result.routes[0]?.targets[0]?.model, 'qwen2.5-coder:7b');
  assert.deepEqual(backups, [JSON.stringify(legacy)]);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.endsWith('.bak')),
    false,
  );
  assert.ok(!fs.readFileSync(configPath, 'utf8').includes('plain-upstream-secret'));
  assert.ok(!fs.readFileSync(configPath, 'utf8').includes('plain-proxy-secret'));
});

test('legacy plaintext credentials are not written without an encrypted sink', async () => {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      server: {},
      proxyKeys: [],
      upstreams: [
        {
          name: 'unsafe',
          provider: 'custom',
          protocol: 'openai',
          baseUrl: 'https://example.com/v1',
          apiKeys: ['plaintext'],
          models: [],
          enabled: false,
        },
      ],
    }),
  );
  await assert.rejects(
    () => new ConfigServiceV2(configPath, { backupLegacy: async () => {} }).loadRaw(),
    /encrypted secret store/,
  );
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).schemaVersion, undefined);
});

test('failed encrypted legacy backup leaves V1 config untouched and creates no plaintext backup', async () => {
  const raw =
    JSON.stringify(
      {
        server: {},
        proxyKeys: [],
        upstreams: [
          {
            name: 'remote',
            provider: 'custom',
            protocol: 'openai',
            baseUrl: 'https://example.com/v1',
            apiKeys: ['plaintext'],
            models: ['model'],
            enabled: true,
          },
        ],
      },
      null,
      2,
    ) + '\n';
  fs.writeFileSync(configPath, raw);
  const service = new ConfigServiceV2(configPath, {
    storeSecret: async () => 'secret-1',
    hasSecret: () => true,
    backupLegacy: async () => {
      throw new Error('encrypted backup unavailable');
    },
  });
  await assert.rejects(() => service.loadRaw(), /encrypted backup unavailable/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), raw);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('missing secure legacy backup sink leaves V1 config byte-for-byte unchanged', async () => {
  const raw =
    '{\n  "server": {},\n  "proxyKeys": [],\n  "upstreams": [{\n    "name": "remote",\n    "provider": "custom",\n    "protocol": "openai",\n    "baseUrl": "https://example.com/v1",\n    "apiKeys": ["plaintext"],\n    "models": ["model"],\n    "enabled": true\n  }]\n}\n';
  fs.writeFileSync(configPath, raw);
  let secretWrites = 0;
  const service = new ConfigServiceV2(configPath, {
    storeSecret: async () => {
      secretWrites++;
      return 'secret-1';
    },
    hasSecret: () => true,
  });
  await assert.rejects(() => service.loadRaw(), /secure versioned legacy backup sink/);
  assert.equal(secretWrites, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), raw);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('future schema versions are rejected without migration or overwrite', async () => {
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 3, revision: 1 }));
  await assert.rejects(() => new ConfigServiceV2(configPath).loadRaw(), /newer than this binary/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).schemaVersion, 3);
});
