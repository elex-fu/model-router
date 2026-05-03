import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectUpstreams } from '../../src/router/upstream.js';
import type { UpstreamConfig, ProxyKey } from '../../src/config/types.js';

function makeUpstream(overrides: Partial<UpstreamConfig>): UpstreamConfig {
  return {
    name: 'u1',
    provider: 'p',
    protocol: 'anthropic',
    baseUrl: 'https://example.com',
    apiKeys: ['k'],
    models: ['gpt-4o'],
    enabled: true,
    ...overrides,
  };
}

function makeKey(overrides: Partial<ProxyKey> = {}): ProxyKey {
  return {
    name: 'alice',
    key: 'mrk_alice',
    enabled: true,
    createdAt: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

test('selectUpstreams without key argument keeps existing behavior', () => {
  const u = makeUpstream({ name: 'u1' });
  const r = selectUpstreams('gpt-4o', [u]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.upstream.name, 'u1');
});

test('selectUpstreams filters by key.allowedUpstreams whitelist', () => {
  const u1 = makeUpstream({ name: 'kimi-code' });
  const u2 = makeUpstream({ name: 'ds-bridge' });
  const key = makeKey({ allowedUpstreams: ['kimi-code'] });
  const r = selectUpstreams('gpt-4o', [u1, u2], key);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.upstream.name, 'kimi-code');
});

test('selectUpstreams empty allowedUpstreams = unrestricted (=== undefined)', () => {
  const u1 = makeUpstream({ name: 'u1' });
  const u2 = makeUpstream({ name: 'u2' });
  const key = makeKey({ allowedUpstreams: [] });
  const r = selectUpstreams('gpt-4o', [u1, u2], key);
  assert.equal(r.length, 2);
});

test('selectUpstreams filters by key.allowedModels exact match', () => {
  const u = makeUpstream({ name: 'u1', models: ['gpt-4o', 'claude-sonnet-4-5'] });
  const key = makeKey({ allowedModels: ['claude-sonnet-4-5'] });
  const r1 = selectUpstreams('gpt-4o', [u], key);
  assert.equal(r1.length, 0);
  const r2 = selectUpstreams('claude-sonnet-4-5', [u], key);
  assert.equal(r2.length, 1);
});

test('selectUpstreams filters by key.allowedModels glob match', () => {
  const u = makeUpstream({ name: 'u1', models: ['claude-sonnet-4-5', 'claude-haiku-3', 'gpt-4o'] });
  const key = makeKey({ allowedModels: ['claude-*'] });
  assert.equal(selectUpstreams('claude-sonnet-4-5', [u], key).length, 1);
  assert.equal(selectUpstreams('claude-haiku-3', [u], key).length, 1);
  assert.equal(selectUpstreams('gpt-4o', [u], key).length, 0);
});

test('selectUpstreams filters by both whitelists combined', () => {
  const u1 = makeUpstream({ name: 'u1', models: ['claude-sonnet-4-5'] });
  const u2 = makeUpstream({ name: 'u2', models: ['claude-sonnet-4-5'] });
  const key = makeKey({
    allowedUpstreams: ['u1'],
    allowedModels: ['claude-*'],
  });
  const r = selectUpstreams('claude-sonnet-4-5', [u1, u2], key);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.upstream.name, 'u1');
});

test('selectUpstreams empty allowedModels = unrestricted', () => {
  const u = makeUpstream({ models: ['gpt-4o'] });
  const key = makeKey({ allowedModels: [] });
  const r = selectUpstreams('gpt-4o', [u], key);
  assert.equal(r.length, 1);
});

test('selectUpstreams allowedModels checks request model not resolvedModel', () => {
  // modelMap: client says claude-sonnet-4-5, upstream rewrites to deepseek-chat.
  // Whitelist matches against the client model (claude-sonnet-4-5), not the
  // upstream-side deepseek-chat — that is what the user intends to grant.
  const u = makeUpstream({
    name: 'ds',
    models: [],
    modelMap: { 'claude-sonnet-4-5': 'deepseek-chat' },
  });
  const key = makeKey({ allowedModels: ['claude-*'] });
  const r = selectUpstreams('claude-sonnet-4-5', [u], key);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.resolvedModel, 'deepseek-chat');
});

test('selectUpstreams allowedModels glob with ? wildcard', () => {
  const u = makeUpstream({ models: ['claude-3-haiku', 'claude-4-haiku'] });
  const key = makeKey({ allowedModels: ['claude-?-haiku'] });
  assert.equal(selectUpstreams('claude-3-haiku', [u], key).length, 1);
  assert.equal(selectUpstreams('claude-4-haiku', [u], key).length, 1);
});
