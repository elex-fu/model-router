import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    load: () => ({ upstreams } as any),
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
    seenKey = (init.headers?.authorization as string).replace('Bearer ', '');
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
