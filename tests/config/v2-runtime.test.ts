import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { configV2Schema, defaultConfigV2 } from '../../src/config/v2-schema.js';

test('V2 runtime resolves credentials without putting plaintext in raw config', async () => {
  const raw = defaultConfigV2('/tmp/model-router-test/config.json', 'test-instance');
  raw.upstreams.push({
    id: 'ollama',
    name: 'Ollama',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'none' },
    credentials: [],
    models: [
      { id: 'qwen2.5-coder:7b', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' },
    ],
    priority: 0,
    sortIndex: 0,
    policy: { inputIncludesCache: true },
  });
  raw.routes.push({
    id: 'coder',
    name: 'Coder',
    enabled: true,
    clientProtocols: ['openai'],
    match: { kind: 'exact', value: 'coder' },
    order: 0,
    publishedModels: ['coder'],
    targets: [{ upstreamId: 'ollama', model: 'qwen2.5-coder:7b' }],
  });
  raw.proxyKeys.push({
    id: 'client-key',
    name: 'Client',
    enabled: true,
    createdAt: new Date().toISOString(),
    keyHash: createHash('sha256').update('sk-test-only').digest('hex'),
    keyPrefix: 'sk-test-',
  });

  const runtime = await compileRuntimeConfig(raw);
  assert.equal(runtime.upstreams[0]?.endpoint, 'chat/completions');
  assert.equal(runtime.upstreams[0]?.authMode, 'none');
  assert.equal(runtime.upstreams[0]?.modelMap?.coder, 'qwen2.5-coder:7b');
  assert.equal(runtime.upstreams[0]?.inputIncludesCache, true);
  const store = new RuntimeConfigStore('/tmp/model-router-test/config.json', runtime);
  assert.equal(store.getProxyKeyByKey('sk-test-only')?.name, 'Client');
  assert.equal(store.getProxyKeyByKey('wrong'), undefined);
  assert.throws(() => store.save(runtime), /read-only/);
});

test('V2 custom authentication header is validated and retained in runtime', async () => {
  const raw = defaultConfigV2('/tmp/model-router-test/custom-header.json', 'test-instance');
  raw.upstreams.push({
    id: 'custom',
    name: 'Custom',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'https://example.invalid/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'custom-header', headerName: 'X-Vendor-Key' },
    credentials: [{ id: 'credential', label: 'Key', enabled: true, secret: { type: 'secret', id: 'secret-id' } }],
    models: [{ id: 'model', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  assert.equal(configV2Schema.safeParse(raw).success, true);
  const runtime = await compileRuntimeConfig(raw, () => 'private-key');
  assert.equal(runtime.upstreams[0]?.authMode, 'custom-header');
  assert.equal(runtime.upstreams[0]?.authHeaderName, 'X-Vendor-Key');
  assert.deepEqual(runtime.upstreams[0]?.apiKeys, ['private-key']);

  raw.upstreams[0]!.auth.headerName = 'Host';
  assert.equal(configV2Schema.safeParse(raw).success, false);
  raw.upstreams[0]!.auth.headerName = undefined;
  assert.equal(configV2Schema.safeParse(raw).success, false);
});

test('V2 runtime compiles arbitrary non-empty inline credentials directly', async () => {
  const raw = defaultConfigV2('/tmp/model-router-test/inline.json', 'test-instance');
  const value = 'provider-key-with-hyphens/other+characters=';
  raw.upstreams.push({
    id: 'custom',
    name: 'Custom',
    provider: 'custom',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'https://example.invalid/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'bearer' },
    credentials: [{ id: 'credential', label: 'Key', enabled: true, secret: { type: 'inline', value } }],
    models: [],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });

  assert.equal(configV2Schema.safeParse(raw).success, true);
  const empty = structuredClone(raw);
  const emptySecret = empty.upstreams[0]?.credentials[0]?.secret;
  if (!emptySecret || emptySecret.type !== 'inline') throw new Error('Expected inline credential');
  emptySecret.value = '';
  assert.equal(configV2Schema.safeParse(empty).success, false);
  const runtime = await compileRuntimeConfig(raw, () => {
    throw new Error('inline credentials must not use the secret resolver');
  });
  assert.deepEqual(runtime.upstreams[0]?.apiKeys, [value]);
});

test('V2 upstream request policy is retained by the runtime snapshot', async () => {
  const raw = defaultConfigV2('/tmp/model-router-test/policy.json', 'test-instance');
  raw.upstreams.push({
    id: 'custom-anthropic',
    name: 'Custom Anthropic',
    provider: 'custom',
    presetId: 'custom-anthropic',
    protocol: 'anthropic',
    enabled: true,
    baseUrl: 'https://example.invalid/v1',
    endpoints: { generate: 'messages' },
    auth: { mode: 'none' },
    credentials: [],
    models: [{ id: 'model', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
    priority: 0,
    sortIndex: 0,
    policy: {
      thinking: 'force',
      requestStreamUsage: false,
      autoCacheControl: true,
      anthropicBetas: ['custom-beta'],
      anthropicVersion: '2025-01-01',
    },
  });

  const runtime = await compileRuntimeConfig(raw);
  assert.equal(runtime.upstreams[0]?.thinkingPolicy, 'force');
  assert.equal(runtime.upstreams[0]?.requestStreamUsage, false);
  assert.equal(runtime.upstreams[0]?.autoCacheControl, true);
  assert.deepEqual(runtime.upstreams[0]?.anthropicBetas, ['custom-beta']);
  assert.equal(runtime.upstreams[0]?.anthropicVersion, '2025-01-01');

  raw.upstreams[0]!.policy = {};
  const omitted = await compileRuntimeConfig(raw);
  assert.equal(omitted.upstreams[0]?.thinkingPolicy, undefined);
  assert.equal(omitted.upstreams[0]?.requestStreamUsage, undefined);
  assert.equal(omitted.upstreams[0]?.autoCacheControl, undefined);
  assert.equal(omitted.upstreams[0]?.anthropicBetas, undefined);
  assert.equal(omitted.upstreams[0]?.anthropicVersion, undefined);
});
