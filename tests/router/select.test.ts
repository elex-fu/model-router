import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectUpstreams, selectUpstream } from '../../src/router/upstream.js';
import type { UpstreamConfig } from '../../src/config/types.js';

function makeUpstream(overrides: Partial<UpstreamConfig>): UpstreamConfig {
  return {
    name: 'test',
    provider: 'test',
    protocol: 'anthropic',
    baseUrl: 'https://example.com',
    apiKeys: ['k'],
    models: [],
    enabled: true,
    ...overrides,
  };
}

test('exact modelMap match wins over glob', () => {
  const u = makeUpstream({
    name: 'u1',
    modelMap: { foo: 'exact-target', 'f*': 'glob-target' },
  });
  const result = selectUpstreams('foo', [u]);
  assert.equal(result.length, 1);
  assert.equal(result[0].upstream.name, 'u1');
  assert.equal(result[0].resolvedModel, 'exact-target');
});

test('glob match across multiple upstreams returns all with their own resolvedModel', () => {
  const u1 = makeUpstream({
    name: 'u1',
    modelMap: { 'claude-*': 'target-a' },
  });
  const u2 = makeUpstream({
    name: 'u2',
    modelMap: { 'claude-*': 'target-b' },
  });
  const result = selectUpstreams('claude-x', [u1, u2]);
  assert.equal(result.length, 2);
  const byName = new Map(result.map((r) => [r.upstream.name, r.resolvedModel]));
  assert.equal(byName.get('u1'), 'target-a');
  assert.equal(byName.get('u2'), 'target-b');
});

test('models[] passthrough hit returns request model as resolvedModel', () => {
  const u = makeUpstream({
    name: 'u1',
    models: ['gpt-4o'],
  });
  const result = selectUpstreams('gpt-4o', [u]);
  assert.equal(result.length, 1);
  assert.equal(result[0].upstream.name, 'u1');
  assert.equal(result[0].resolvedModel, 'gpt-4o');
});

test('enabled=false excluded even if it would match', () => {
  const u = makeUpstream({
    name: 'u1',
    enabled: false,
    models: ['gpt-4o'],
    modelMap: { 'gpt-*': 'something' },
  });
  const result = selectUpstreams('gpt-4o', [u]);
  assert.deepEqual(result, []);
});

test('empty result when no upstream matches', () => {
  const u = makeUpstream({
    name: 'u1',
    models: ['gpt-4o'],
    modelMap: { 'claude-*': 'target' },
  });
  const result = selectUpstreams('mistral-large', [u]);
  assert.deepEqual(result, []);
});

test('resolvedModel equals upstream real name not client request', () => {
  const u = makeUpstream({
    name: 'u1',
    modelMap: { 'claude-3-opus': 'deepseek-chat' },
  });
  const result = selectUpstreams('claude-3-opus', [u]);
  assert.equal(result.length, 1);
  assert.equal(result[0].resolvedModel, 'deepseek-chat');
  assert.notEqual(result[0].resolvedModel, 'claude-3-opus');
});

test('selectUpstream (singular) returns first upstream or null', () => {
  const u = makeUpstream({
    name: 'u1',
    models: ['gpt-4o'],
  });
  const single = selectUpstream('gpt-4o', [u]);
  assert.ok(single);
  assert.equal(single.name, 'u1');

  const none = selectUpstream('nope', [u]);
  assert.equal(none, null);
});

test('modelMap glob match with no exact entry resolves to mapped target', () => {
  const u = makeUpstream({
    name: 'u1',
    modelMap: { 'claude-*': 'mapped-target' },
  });
  const result = selectUpstreams('claude-anything', [u]);
  assert.equal(result.length, 1);
  assert.equal(result[0].resolvedModel, 'mapped-target');
});
