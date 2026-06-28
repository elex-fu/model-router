import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UpstreamConfig } from '../../src/config/types.js';
import { selectUpstreams } from '../../src/router/upstream.js';

function makeUpstream(overrides: Partial<UpstreamConfig>): UpstreamConfig {
  return {
    name: 'test',
    provider: 'test',
    protocol: 'anthropic',
    baseUrl: 'https://example.com',
    apiKeys: ['k'],
    models: ['m'],
    enabled: true,
    ...overrides,
  };
}

test('selects upstreams by priority then sortIndex', () => {
  const ups = [
    makeUpstream({ name: 'p2', priority: 2 }),
    makeUpstream({ name: 'p1-b', priority: 1, sortIndex: 2 }),
    makeUpstream({ name: 'p1-a', priority: 1, sortIndex: 1 }),
  ];
  const result = selectUpstreams('m', ups).map((m) => m.upstream.name);
  assert.deepEqual(result, ['p1-a', 'p1-b', 'p2']);
});

test('default priority is 0 and default sortIndex is last', () => {
  const ups = [
    makeUpstream({ name: 'default' }),
    makeUpstream({ name: 'priority-1', priority: -1 }),
    makeUpstream({ name: 'sort-0', sortIndex: 0 }),
  ];
  const result = selectUpstreams('m', ups).map((m) => m.upstream.name);
  assert.deepEqual(result, ['priority-1', 'sort-0', 'default']);
});

test('failoverQueue overrides priority order', () => {
  const ups = [
    makeUpstream({ name: 'a', priority: 2 }),
    makeUpstream({ name: 'b', priority: 1 }),
    makeUpstream({ name: 'c', priority: 0 }),
  ];
  const result = selectUpstreams('m', ups, undefined, ['b', 'a', 'c']).map((m) => m.upstream.name);
  assert.deepEqual(result, ['b', 'a', 'c']);
});

test('failoverQueue places unnamed upstreams at the end sorted by priority', () => {
  const ups = [
    makeUpstream({ name: 'a', priority: 2 }),
    makeUpstream({ name: 'b', priority: 1 }),
    makeUpstream({ name: 'c', priority: 0 }),
    makeUpstream({ name: 'extra', priority: -1 }),
  ];
  const result = selectUpstreams('m', ups, undefined, ['b', 'a']).map((m) => m.upstream.name);
  assert.deepEqual(result, ['b', 'a', 'extra', 'c']);
});

test('empty failoverQueue falls back to priority sorting', () => {
  const ups = [makeUpstream({ name: 'a', priority: 2 }), makeUpstream({ name: 'b', priority: 1 })];
  const result = selectUpstreams('m', ups, undefined, []).map((m) => m.upstream.name);
  assert.deepEqual(result, ['b', 'a']);
});
