import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreateOptions, applyUpdateOptions } from '../../src/cli/key-options.js';
import type { ProxyKey } from '../../src/config/types.js';

function existingKey(overrides: Partial<ProxyKey> = {}): ProxyKey {
  return {
    name: 'alice',
    key: 'mrk_alice',
    enabled: true,
    createdAt: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

test('parseCreateOptions: full set of flags maps to patch', () => {
  const patch = parseCreateOptions({
    description: 'alice@team.com',
    upstreams: 'kimi-code,ds-bridge',
    models: 'claude-sonnet-*,claude-haiku-*',
    rpm: '30',
    dailyTokens: '2000000',
    expires: '2026-12-31T23:59:59Z',
  });
  assert.equal(patch.description, 'alice@team.com');
  assert.deepEqual(patch.allowedUpstreams, ['kimi-code', 'ds-bridge']);
  assert.deepEqual(patch.allowedModels, ['claude-sonnet-*', 'claude-haiku-*']);
  assert.equal(patch.rpm, 30);
  assert.equal(patch.dailyTokens, 2000000);
  assert.equal(patch.expiresAt, '2026-12-31T23:59:59.000Z');
});

test('parseCreateOptions: empty list flags resolve to undefined', () => {
  const patch = parseCreateOptions({ upstreams: '', models: '' });
  assert.equal(patch.allowedUpstreams, undefined);
  assert.equal(patch.allowedModels, undefined);
});

test('parseCreateOptions: never literal expires resolves to undefined', () => {
  const patch = parseCreateOptions({ expires: 'never' });
  assert.equal(patch.expiresAt, undefined);
});

test('parseCreateOptions: rpm=0 means disabled — kept as 0', () => {
  const patch = parseCreateOptions({ rpm: '0' });
  assert.equal(patch.rpm, 0);
});

test('parseCreateOptions: rejects non-numeric rpm', () => {
  assert.throws(() => parseCreateOptions({ rpm: 'abc' }), /rpm/);
});

test('parseCreateOptions: rejects malformed expires', () => {
  assert.throws(() => parseCreateOptions({ expires: 'not-a-date' }), /expires/);
});

test('applyUpdateOptions: add-upstream appends to existing whitelist', () => {
  const patch = applyUpdateOptions(
    { addUpstream: 'kimi-code-2' },
    existingKey({ allowedUpstreams: ['kimi-code'] })
  );
  assert.deepEqual(patch.allowedUpstreams, ['kimi-code', 'kimi-code-2']);
});

test('applyUpdateOptions: add-upstream is idempotent (no duplicates)', () => {
  const patch = applyUpdateOptions(
    { addUpstream: 'kimi-code' },
    existingKey({ allowedUpstreams: ['kimi-code'] })
  );
  assert.deepEqual(patch.allowedUpstreams, ['kimi-code']);
});

test('applyUpdateOptions: remove-upstream subtracts from existing', () => {
  const patch = applyUpdateOptions(
    { removeUpstream: 'ds-bridge' },
    existingKey({ allowedUpstreams: ['kimi-code', 'ds-bridge'] })
  );
  assert.deepEqual(patch.allowedUpstreams, ['kimi-code']);
});

test('applyUpdateOptions: remove-upstream that empties whitelist sets undefined', () => {
  const patch = applyUpdateOptions(
    { removeUpstream: 'kimi-code' },
    existingKey({ allowedUpstreams: ['kimi-code'] })
  );
  assert.equal(patch.allowedUpstreams, undefined);
});

test('applyUpdateOptions: --upstreams "" clears whitelist', () => {
  const patch = applyUpdateOptions(
    { upstreams: '' },
    existingKey({ allowedUpstreams: ['kimi-code'] })
  );
  assert.equal(patch.allowedUpstreams, undefined);
});

test('applyUpdateOptions: --expires never clears expiresAt', () => {
  const patch = applyUpdateOptions(
    { expires: 'never' },
    existingKey({ expiresAt: '2026-12-31T00:00:00Z' })
  );
  assert.equal(patch.expiresAt, undefined);
});

test('applyUpdateOptions: only specified flags appear in patch', () => {
  const patch = applyUpdateOptions({ rpm: '60' }, existingKey({ rpm: 30 }));
  assert.equal(patch.rpm, 60);
  assert.equal(patch.dailyTokens, undefined);
  assert.equal(patch.description, undefined);
  assert.equal('description' in patch, false);
});
