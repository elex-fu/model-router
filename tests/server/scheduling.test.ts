import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UpstreamConfig } from '../../src/config/types.js';
import { selectUpstreams } from '../../src/router/upstream.js';
import { SessionAffinityStore } from '../../src/server/sticky-affinity.js';

/*
 * O2 (docs/standalone-relay-capability-plan-2026-10-30.md): scheduling depth
 * unit coverage. Integration coverage for stickiness (pin → drift on failure)
 * lives in tests/integration/session-affinity.test.ts.
 */

function upstream(overrides: Partial<UpstreamConfig>): UpstreamConfig {
  return {
    name: 'up',
    provider: 'custom',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:9',
    apiKeys: [],
    models: ['custom-model'],
    enabled: true,
    ...overrides,
  };
}

const NO_QUEUE = undefined;

test('uniform default weights keep the deterministic sortIndex order', () => {
  const deterministic = () => 0.99; // any draw still cannot reorder a uniform group
  for (let i = 0; i < 5; i++) {
    const ordered = selectUpstreams(
      'custom-model',
      [
        upstream({ name: 'a', priority: 0, sortIndex: 2 }),
        upstream({ name: 'b', priority: 0, sortIndex: 1 }),
        upstream({ name: 'c', priority: 1 }),
      ],
      undefined,
      NO_QUEUE,
      deterministic,
    );
    assert.deepEqual(
      ordered.map((match) => match.upstream.name),
      ['b', 'a', 'c'],
    );
  }
});

test('non-uniform weights within a priority draw proportionally (±5%)', () => {
  const upstreams = [
    upstream({ name: 'heavy', priority: 0, weight: 9 }),
    upstream({ name: 'light', priority: 0, weight: 1 }),
  ];
  const runs = 4000;
  let heavyFirst = 0;
  for (let i = 0; i < runs; i++) {
    const [first] = selectUpstreams('custom-model', upstreams, undefined, NO_QUEUE, Math.random);
    if (first?.upstream.name === 'heavy') heavyFirst += 1;
  }
  const ratio = heavyFirst / runs;
  assert.ok(Math.abs(ratio - 0.9) < 0.05, `expected ~0.9, got ${ratio}`);
});

test('weight 0 upstream never leads; priorities are never reordered by weight', () => {
  const upstreams = [
    upstream({ name: 'muted', priority: 0, weight: 0 }),
    upstream({ name: 'normal', priority: 0, weight: 1 }),
    upstream({ name: 'high-prio', priority: -1, weight: 1 }),
  ];
  for (let i = 0; i < 20; i++) {
    const ordered = selectUpstreams('custom-model', upstreams, undefined, NO_QUEUE, Math.random);
    assert.equal(ordered[0]?.upstream.name, 'high-prio');
    assert.ok(ordered[1]?.upstream.name !== 'muted');
  }
});

test('a strict failover queue suppresses weighting entirely', () => {
  const upstreams = [
    upstream({ name: 'q1', priority: 0, weight: 99 }),
    upstream({ name: 'q2', priority: 0, weight: 1 }),
    upstream({ name: 'q3', priority: 0 }),
  ];
  for (let i = 0; i < 20; i++) {
    const ordered = selectUpstreams('custom-model', upstreams, undefined, ['q3', 'q2', 'q1'], Math.random);
    assert.deepEqual(
      ordered.map((match) => match.upstream.name),
      ['q3', 'q2', 'q1'],
    );
  }
});

test('SessionAffinityStore pins, expires, evicts LRU and removes mappings', () => {
  const store = new SessionAffinityStore({ maxEntries: 3, defaultTtlMs: 1000 });
  const now = 1000;
  store.set('k1', 'up-a', now);
  store.set('k2', 'up-b', now);
  assert.equal(store.get('k1', now), 'up-a');
  // TTL expiry.
  assert.equal(store.get('k1', now + 1000), null);
  // Explicit removal.
  store.set('k2', 'up-b', now);
  store.remove('k2');
  assert.equal(store.get('k2', now), null);
  // LRU eviction at capacity: k1/k2 are already gone, so k3..k5 fill the
  // capacity exactly; reading k3 and k5 refreshes their recency, leaving k4
  // as the eviction victim when k6 arrives.
  store.set('k3', 'up-c', now);
  store.set('k4', 'up-d', now);
  store.set('k5', 'up-e', now);
  assert.equal(store.get('k3', now), 'up-c');
  assert.equal(store.get('k5', now), 'up-e');
  store.set('k6', 'up-f', now);
  assert.equal(store.get('k3', now), 'up-c');
  assert.equal(store.get('k4', now), null);
  assert.equal(store.get('k5', now), 'up-e');
  assert.equal(store.get('k6', now), 'up-f');
  assert.equal(store.size(now), 3);
});
