import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { previewRuntimeRoute } from '../../src/admin/runtime.js';
import { compileRuntimeConfig } from '../../src/config/v2-runtime.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import { pickBridge } from '../../src/protocol/bridge.js';
import { CircuitBreaker } from '../../src/server/circuitBreaker.js';
import { KeyPool } from '../../src/server/keyPool.js';

test('read-only route preview helpers preserve failover state and identify bridge/circuit states', () => {
  const keys = new KeyPool();
  keys.register('first', ['first-secret']);
  keys.register('second', ['second-secret']);
  keys.pick('first');
  const beforeCount = keys.getAvailableCount('first');
  const breaker = new CircuitBreaker();
  breaker.reportFailure('first');
  breaker.reportFailure('first');
  breaker.reportFailure('first');
  breaker.reportFailure('first');
  breaker.reportFailure('first');
  const open = breaker.status('first');
  assert.equal(open.state, 'open');
  assert.deepEqual(pickBridge('openai', 'anthropic').clientProto, 'openai');
  assert.equal(keys.getAvailableCount('first'), beforeCount);

  const halfOpen = new CircuitBreaker({ recoveryTimeoutMs: 1 });
  for (let index = 0; index < 5; index++) halfOpen.reportFailure('half');
  const beforePreview = halfOpen.status('half');
  assert.equal(beforePreview.state, 'open');
  let allowCalls = 0;
  halfOpen.allow = (() => {
    allowCalls++;
    return false;
  }) as typeof halfOpen.allow;
  assert.deepEqual(halfOpen.status('half'), beforePreview);
  assert.equal(allowCalls, 0);
  assert.equal(keys.getAvailableCount('second'), 1);
});

test('runtime route preview applies configured order and Key policy without provider calls or secret disclosure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-route-preview-'));
  const configPath = join(dir, 'config.json');
  const raw = defaultConfigV2(configPath, 'route-preview-test');
  raw.upstreams = [
    {
      id: 'first',
      name: 'First',
      provider: 'custom',
      protocol: 'anthropic',
      enabled: true,
      baseUrl: 'https://first.invalid',
      endpoints: { generate: 'v1/messages' },
      auth: { mode: 'bearer' },
      credentials: [{ id: 'cred1', label: 'first', enabled: true, secret: { type: 'secret', id: 'secret1' } }],
      models: [{ id: 'actual-a', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
      priority: 0,
      sortIndex: 0,
      policy: {},
    },
    {
      id: 'second',
      name: 'Second',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'https://second.invalid',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'none' },
      credentials: [],
      models: [{ id: 'actual-b', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
      priority: 0,
      sortIndex: 1,
      policy: {},
    },
    {
      id: 'disabled',
      name: 'Disabled',
      provider: 'custom',
      protocol: 'openai',
      enabled: false,
      baseUrl: 'https://disabled.invalid',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [],
      models: [{ id: 'actual-c', enabled: false, capabilities: {}, capabilitiesSource: 'manual' }],
      priority: 0,
      sortIndex: 2,
      policy: {},
    },
    {
      id: 'no-credentials',
      name: 'No credentials',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'https://empty.invalid',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'bearer' },
      credentials: [],
      models: [{ id: 'actual-d', enabled: true, capabilities: {}, capabilitiesSource: 'manual' }],
      priority: 0,
      sortIndex: 3,
      policy: {},
    },
  ];
  raw.routes = [
    {
      id: 'route',
      name: 'route',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'exact', value: 'public' },
      order: 0,
      publishedModels: ['public'],
      targets: [
        { upstreamId: 'first', model: 'actual-a' },
        { upstreamId: 'second', model: 'actual-b' },
        { upstreamId: 'disabled', model: 'actual-c' },
        { upstreamId: 'no-credentials', model: 'actual-d' },
      ],
    },
  ];
  raw.proxyKeys = [
    {
      id: 'allowed',
      name: 'Allowed',
      enabled: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      keyHash: createHash('sha256').update('never-return-this').digest('hex'),
      keyPrefix: 'mr_secret',
      allowedUpstreamIds: ['second'],
      allowedModels: ['public'],
    },
  ];
  writeFileSync(configPath, JSON.stringify(raw));
  const controlStore = new ControlStore(dir);
  controlStore.secrets.put('secret1', 'provider-secret-value');
  const runtimeSnapshot = await compileRuntimeConfig(raw, (id) => controlStore.secrets.get(id));
  const pool = new KeyPool();
  pool.register('first', ['credential-secret']);
  pool.register('second', []);
  pool.register('No credentials', []);
  const breaker = new CircuitBreaker();
  const preview = (proxyKeyId?: string) =>
    previewRuntimeRoute({
      model: 'public',
      protocol: 'openai',
      proxyKeyId,
      snapshot: runtimeSnapshot,
      raw,
      keyPool: pool,
      circuitBreaker: breaker,
      healthStatus: () => ({ healthy: true, checkedAt: Date.now() }),
    });
  const result = preview('allowed');
  assert.deepEqual(
    result.candidates.map((item) => [item.upstreamId, item.eligible, item.selected, item.exclusionReason]),
    [
      ['first', false, false, 'key_upstream_denied'],
      ['second', true, true, undefined],
      ['disabled', false, false, 'upstream_disabled'],
      ['no-credentials', false, false, 'key_upstream_denied'],
    ],
  );
  assert.equal(result.candidates[0].bridge, 'bridge');
  assert.equal(JSON.stringify(result).includes('never-return-this'), false);
  assert.equal(JSON.stringify(result).includes('provider-secret-value'), false);
  const withoutKey = preview();
  assert.equal(withoutKey.candidates[3].exclusionReason, 'no_credentials');
  const openBreaker = new CircuitBreaker();
  for (let index = 0; index < 5; index++) openBreaker.reportFailure('first');
  const openResult = previewRuntimeRoute({
    model: 'public',
    protocol: 'openai',
    snapshot: runtimeSnapshot,
    raw,
    keyPool: pool,
    circuitBreaker: openBreaker,
    healthStatus: () => ({ healthy: true, checkedAt: Date.now() }),
  });
  assert.deepEqual(
    openResult.candidates.slice(0, 2).map((item) => [item.eligible, item.selected, item.exclusionReason]),
    [
      [false, false, 'circuit_open'],
      [true, true, undefined],
    ],
  );
  const halfOpenBreaker = new CircuitBreaker({ recoveryTimeoutMs: 1 });
  for (let index = 0; index < 5; index++) halfOpenBreaker.reportFailure('first');
  const fixedFailureTime = 1_790_270_126_636;
  halfOpenBreaker.status = (() => ({
    state: 'half-open',
    failures: 5,
    lastFailureTime: fixedFailureTime,
  })) as typeof halfOpenBreaker.status;
  const before = halfOpenBreaker.status('first');
  const halfOpenResult = previewRuntimeRoute({
    model: 'public',
    protocol: 'openai',
    snapshot: runtimeSnapshot,
    raw,
    keyPool: pool,
    circuitBreaker: halfOpenBreaker,
    healthStatus: () => ({ healthy: true, checkedAt: Date.now() }),
  });
  assert.equal(halfOpenResult.candidates[0].selected, false);
  assert.equal(halfOpenResult.candidates[0].availability, 'uncertain');
  assert.equal(halfOpenResult.candidates[0].exclusionReason, 'circuit_half_open');
  assert.equal(halfOpenResult.candidates[1].selected, false);
  assert.deepEqual(halfOpenBreaker.status('first'), before);
  let allowCalls = 0;
  breaker.allow = (() => {
    allowCalls++;
    return true;
  }) as typeof breaker.allow;
  preview();
  assert.equal(allowCalls, 0);
  controlStore.close();
  rmSync(dir, { recursive: true, force: true });
});
