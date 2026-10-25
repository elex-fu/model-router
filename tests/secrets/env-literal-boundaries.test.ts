import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { redactInlineSecrets } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';

const literal = 'sk-synthetic_credential_abcdefghijklmnop';
const source = { type: 'env' as const, name: literal };

test('legacy env literal status and management redaction never return the credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-env-literal-'));
  const store = new ControlStore(dir);
  try {
    const status = store.secrets.status(source);
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes(literal), false);
    const config = defaultConfigV2(join(dir, 'config.json'), 'test');
    config.upstreams.push({
      id: 'u',
      name: 'U',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'https://example.invalid',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [{ id: 'c', label: 'C', enabled: true, secret: source }],
      models: [],
      priority: 0,
      sortIndex: 0,
      policy: {},
    });
    assert.equal(JSON.stringify(redactInlineSecrets(config)).includes(literal), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new history encrypts legacy env literals while preserving exact decoded config for journal checksums', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-env-literal-history-'));
  const store = new ControlStore(dir);
  try {
    const config = { revision: 1, credential: source };
    store.history(1, 'test', config);
    const row = store.db.prepare('SELECT config_json FROM config_history').get() as { config_json: string };
    assert.equal(row.config_json.includes(literal), false);
    assert.deepEqual(store.configHistoryConfig(1), config);
    assert.doesNotThrow(() => store.history(1, 'test', config));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening legacy history migrates plaintext env literals transactionally and idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-env-literal-migrate-'));
  const config = { revision: 7, credential: source };
  let store = new ControlStore(dir);
  try {
    store.db
      .prepare('INSERT INTO config_history VALUES(?,?,?,?)')
      .run(7, 'legacy', JSON.stringify(config), '2026-01-01');
    store.close();
    store = new ControlStore(dir);
    const row = store.db.prepare('SELECT config_json FROM config_history').get() as { config_json: string };
    assert.equal(row.config_json.includes(literal), false);
    assert.deepEqual(store.configHistoryConfig(7), config);
    const encrypted = row.config_json;
    store.close();
    store = new ControlStore(dir);
    assert.equal(
      (store.db.prepare('SELECT config_json FROM config_history').get() as { config_json: string }).config_json,
      encrypted,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('short legacy key and ordinary env names share schema, runtime and availability semantics', async () => {
  const { configV2Schema } = await import('../../src/config/v2-schema.js');
  const { compileRuntimeConfig } = await import('../../src/config/v2-runtime.js');
  const { ConfigServiceV2 } = await import('../../src/config/v2-service.js');
  const dir = mkdtempSync(join(tmpdir(), 'mr-env-literal-semantics-'));
  const path = join(dir, 'config.json');
  const service = new ConfigServiceV2(path);
  try {
    const config = await service.loadRaw();
    config.upstreams.push({
      id: 'u',
      name: 'U',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'https://example.invalid',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [{ id: 'c', label: 'C', enabled: true, secret: { type: 'env', name: 'sk-x' } }],
      models: [],
      priority: 0,
      sortIndex: 0,
      policy: {},
    });
    assert.equal(configV2Schema.safeParse(config).success, true);
    assert.equal((await service.validate(config)).valid, true);
    assert.deepEqual((await compileRuntimeConfig(config)).upstreams[0]!.apiKeys, ['sk-x']);
    const malformed = structuredClone(config);
    Object.assign(malformed.upstreams[0]!.credentials[0]!.secret, { value: 'must-not-be-discarded' });
    await assert.rejects(() => service.commit(malformed, config.revision), /Invalid configuration/);
    const committed = await service.commit(config, config.revision);
    assert.deepEqual(committed.upstreams[0]!.credentials[0]!.secret, { type: 'inline', value: 'sk-x' });
    const envName = 'MODEL_ROUTER_TEST_LITERAL_BOUNDARY';
    const previous = process.env[envName];
    process.env[envName] = 'ordinary-env-value';
    try {
      config.upstreams[0]!.credentials[0]!.secret = { type: 'env', name: envName };
      assert.deepEqual((await compileRuntimeConfig(config)).upstreams[0]!.apiKeys, ['ordinary-env-value']);
      const next = await service.commit(config, committed.revision);
      assert.deepEqual(next.upstreams[0]!.credentials[0]!.secret, { type: 'env', name: envName });
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
