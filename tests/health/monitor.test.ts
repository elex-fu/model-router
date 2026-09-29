import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { HealthMonitor } from '../../src/health/monitor.js';
import { KeyPool } from '../../src/server/keyPool.js';

function mockStore(initialUpstreams: any[]) {
  const upstreams = initialUpstreams.map((u) => ({ ...u }));
  return {
    listUpstreams: () => upstreams,
    setUpstreamEnabled: (name: string, enabled: boolean) => {
      const u = upstreams.find((x) => x.name === name);
      if (u) u.enabled = enabled;
    },
    load: () => ({ upstreams }) as any,
  };
}

test('without keyPool: 3 consecutive failures disable upstream', async () => {
  const store = mockStore([
    { name: 'u1', baseUrl: 'http://localhost:1', apiKeys: ['k1'], models: ['m1'], enabled: true },
  ]);
  const monitor = new HealthMonitor(store as any);

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
  };

  try {
    // round 1
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    // round 2
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    // round 3
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, false);
    assert.equal(calls, 3);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('without keyPool: success resets failure count', async () => {
  const store = mockStore([
    { name: 'u1', baseUrl: 'http://localhost:1', apiKeys: ['k1'], models: ['m1'], enabled: true },
  ]);
  const monitor = new HealthMonitor(store as any);

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls <= 2) {
      return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    assert.equal(calls, 3);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('with keyPool: first key fails, second succeeds → markSuccess + stays enabled', async () => {
  const store = mockStore([
    { name: 'u1', baseUrl: 'http://localhost:1', apiKeys: ['k1', 'k2'], models: ['m1'], enabled: true },
  ]);
  const keyPool = new KeyPool();
  keyPool.register('u1', ['k1', 'k2']);
  const monitor = new HealthMonitor(store as any, keyPool);

  const originalFetch = global.fetch;
  const seenKeys: string[] = [];
  global.fetch = async (_url: any, init: any) => {
    const auth = init.headers?.authorization as string;
    const key = auth.replace('Bearer ', '');
    seenKeys.push(key);
    if (key === 'k1') {
      return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    assert.deepEqual(seenKeys, ['k1', 'k2']);
    // k2 succeeded, so k1's failure count should be cleared by markSuccess
    assert.equal(keyPool.getAvailableKeys('u1').length, 2);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('with duplicate key text: health success resets only the matching credential state', async () => {
  const store = mockStore([
    {
      name: 'u1',
      baseUrl: 'http://localhost:1',
      apiKeys: ['shared-key', 'shared-key'],
      credentialIds: ['cred-a', 'cred-b'],
      models: ['m1'],
      enabled: true,
    },
  ]);
  const keyPool = new KeyPool({ maxFailures: 3 });
  keyPool.register('u1', [
    { credentialId: 'cred-a', key: 'shared-key' },
    { credentialId: 'cred-b', key: 'shared-key' },
  ]);
  // Seed distinct failure counts without cooling either entry.
  keyPool.markFailure('u1', { credentialId: 'cred-a', key: 'shared-key' });
  keyPool.markFailure('u1', { credentialId: 'cred-a', key: 'shared-key' });
  keyPool.markFailure('u1', { credentialId: 'cred-b', key: 'shared-key' });
  const monitor = new HealthMonitor(store as any, keyPool);

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'down' }), { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    // `cred-a` retains two failures and can be cooled by one subsequent failure.
    keyPool.markFailure('u1', { credentialId: 'cred-a', key: 'shared-key' });
    assert.deepEqual(keyPool.getAvailableEntries('u1'), [
      { credentialId: 'cred-b', key: 'shared-key' },
    ]);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('when all credentials are cooling, recovery probes retain credential IDs', async () => {
  const store = mockStore([
    {
      name: 'u1',
      baseUrl: 'http://localhost:1',
      apiKeys: ['shared-key', 'shared-key'],
      credentialIds: ['cred-a', 'cred-b'],
      models: ['m1'],
      enabled: true,
    },
  ]);
  const keyPool = new KeyPool({ cooldownMs: 60_000, maxFailures: 1 });
  keyPool.register('u1', [
    { credentialId: 'cred-a', key: 'shared-key' },
    { credentialId: 'cred-b', key: 'shared-key' },
  ]);
  keyPool.markFailure('u1', { credentialId: 'cred-a', key: 'shared-key' });
  keyPool.markFailure('u1', { credentialId: 'cred-b', key: 'shared-key' });
  const monitor = new HealthMonitor(store as any, keyPool);

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'down' }), { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(calls, 2);
    // Recovery success belongs to cred-b, so cred-a remains cooled.
    assert.deepEqual(keyPool.getAvailableEntries('u1'), [
      { credentialId: 'cred-b', key: 'shared-key' },
    ]);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('with keyPool: all keys fail 3 rounds → upstream disabled', async () => {
  const store = mockStore([
    { name: 'u1', baseUrl: 'http://localhost:1', apiKeys: ['k1', 'k2'], models: ['m1'], enabled: true },
  ]);
  const keyPool = new KeyPool();
  keyPool.register('u1', ['k1', 'k2']);
  const monitor = new HealthMonitor(store as any, keyPool);

  const originalFetch = global.fetch;
  global.fetch = async () => {
    return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, false);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('with keyPool: recovers after 2 all-key failures on round 3', async () => {
  const store = mockStore([
    { name: 'u1', baseUrl: 'http://localhost:1', apiKeys: ['k1', 'k2'], models: ['m1'], enabled: true },
  ]);
  const keyPool = new KeyPool();
  keyPool.register('u1', ['k1', 'k2']);
  const monitor = new HealthMonitor(store as any, keyPool);

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls <= 4) {
      // first 2 rounds (2 keys each = 4 calls) all fail
      return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    assert.ok(calls >= 5);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('with keyPool: falls back to upstream.apiKeys when pool empty for upstream', async () => {
  const store = mockStore([
    { name: 'u1', baseUrl: 'http://localhost:1', apiKeys: ['k1'], models: ['m1'], enabled: true },
  ]);
  const keyPool = new KeyPool();
  // intentionally do NOT register u1
  const monitor = new HealthMonitor(store as any, keyPool);

  const originalFetch = global.fetch;
  let seenKey = '';
  global.fetch = async (_url: any, init: any) => {
    const authorization = init.headers?.authorization;
    seenKey = typeof authorization === 'string' ? authorization.replace('Bearer ', '') : '';
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(store.listUpstreams()[0].enabled, true);
    assert.equal(seenKey, 'k1');
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('probes anthropic upstream at /v1/messages with Bearer auth', async () => {
  const store = mockStore([
    {
      name: 'u1',
      protocol: 'anthropic',
      baseUrl: 'http://localhost:1',
      apiKeys: ['k1'],
      models: ['m1'],
      enabled: true,
    },
  ]);
  const monitor = new HealthMonitor(store as any);

  const originalFetch = global.fetch;
  let capturedUrl = '';
  let capturedInit: any;
  global.fetch = async (url: any, init: any) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.ok(capturedUrl.endsWith('/v1/messages'));
    assert.equal(capturedInit.headers?.authorization, 'Bearer k1');
    assert.equal(capturedInit.method, 'POST');
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('probes openai upstream at /v1/chat/completions with Bearer auth', async () => {
  const store = mockStore([
    { name: 'u1', protocol: 'openai', baseUrl: 'http://localhost:1', apiKeys: ['k1'], models: ['m1'], enabled: true },
  ]);
  const monitor = new HealthMonitor(store as any);

  const originalFetch = global.fetch;
  let capturedUrl = '';
  let capturedInit: any;
  global.fetch = async (url: any, init: any) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.ok(capturedUrl.endsWith('/v1/chat/completions'));
    assert.equal(capturedInit.headers?.authorization, 'Bearer k1');
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('probes with x-api-key header when authMode is x-api-key', async () => {
  const store = mockStore([
    {
      name: 'u1',
      protocol: 'openai',
      baseUrl: 'http://localhost:1',
      apiKeys: ['k1'],
      models: ['m1'],
      enabled: true,
      authMode: 'x-api-key',
    },
  ]);
  const monitor = new HealthMonitor(store as any);

  const originalFetch = global.fetch;
  let capturedInit: any;
  global.fetch = async (_url: any, init: any) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    await (monitor as any).checkUpstream(store.listUpstreams()[0]);
    assert.equal(capturedInit.headers?.authorization, undefined);
    assert.equal(capturedInit.headers?.['x-api-key'], 'k1');
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});

test('V2 health probes honor base prefix and do not mutate configuration', async () => {
  const upstream = {
    id: 'ollama',
    name: 'ollama',
    provider: 'custom',
    protocol: 'openai' as const,
    baseUrl: 'http://127.0.0.1:11434/v1',
    endpoint: 'chat/completions',
    authMode: 'none' as const,
    apiKeys: [],
    models: ['qwen2.5-coder:7b'],
    enabled: true,
    healthMode: 'active' as const,
  };
  const store = new RuntimeConfigStore('/tmp/model-router-test/config.json', {
    server: { port: 15005, bindAddress: '127.0.0.1', logFlushIntervalMs: 1000, logBatchSize: 1 },
    proxyKeys: [],
    upstreams: [upstream],
  });
  const monitor = new HealthMonitor(store);
  const originalFetch = global.fetch;
  let seenUrl = '';
  let seenHeaders: HeadersInit | undefined;
  global.fetch = async (url, init) => {
    seenUrl = String(url);
    seenHeaders = init?.headers;
    return new Response('down', { status: 503 });
  };
  try {
    await (monitor as any).checkUpstream(upstream);
    await (monitor as any).checkUpstream(upstream);
    await (monitor as any).checkUpstream(upstream);
    assert.equal(seenUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(new Headers(seenHeaders).get('authorization'), null);
    assert.equal(store.load().upstreams[0]?.enabled, true);
    assert.equal(monitor.getStatus('ollama')?.healthy, false);
  } finally {
    global.fetch = originalFetch;
    monitor.stop();
  }
});
