import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffSettings } from '../../../src/saas/observability/settings-diff.js';

test('diffSettings produces key-level change descriptions', () => {
  const before = {
    server: { port: 15005, bindAddress: '127.0.0.1' },
    upstreams: [{ id: 'kimi', baseUrl: 'https://old.example', credentials: [] }],
    routes: [{ id: 'r1', upstreamId: 'kimi' }],
  };
  const after = {
    server: { port: 15010, bindAddress: '127.0.0.1' },
    upstreams: [
      { id: 'kimi', baseUrl: 'https://new.example', credentials: [] },
      { id: 'deepseek', baseUrl: 'https://deepseek.example', credentials: [] },
    ],
    routes: [{ id: 'r1', upstreamId: 'kimi' }],
  };
  assert.deepEqual(diffSettings(before, after), [
    'server.port: 15005 → 15010',
    'upstreams[0].baseUrl: https://old.example → https://new.example',
    'upstreams[1].baseUrl: <missing> → https://deepseek.example',
    'upstreams[1].credentials: <missing> → []',
    'upstreams[1].id: <missing> → deepseek',
  ]);
});

test('diffSettings reports changes in sorted key order', () => {
  const changes = diffSettings({ zeta: 1, alpha: 2 }, { zeta: 2, alpha: 3 });
  assert.deepEqual(changes, ['alpha: 2 → 3', 'zeta: 1 → 2']);
});

test('diffSettings marks removed keys and array shrinkage', () => {
  const before = { a: { b: 1, c: 2 }, list: [1, 2, 3] };
  const after = { a: { b: 1 }, list: [1, 2] };
  assert.deepEqual(diffSettings(before, after), ['a.c: 2 → <removed>', 'list[2]: 3 → <removed>']);
});

test('diffSettings redacts secret-shaped paths on both sides', () => {
  const before = {
    upstreams: [{ id: 'kimi', credentials: [{ secret: { type: 'inline', value: 'old-secret-value' } }] }],
    admin: { password: 'hunter2' },
  };
  const after = {
    upstreams: [{ id: 'kimi', credentials: [{ secret: { type: 'inline', value: 'new-secret-value' } }] }],
    admin: { password: 'changed' },
  };
  const changes = diffSettings(before, after);
  assert.deepEqual(changes, [
    'admin.password: [redacted] → [redacted]',
    'upstreams[0].credentials[0].secret.value: [redacted] → [redacted]',
  ]);
  assert.equal(
    changes.some((line) => line.includes('secret-value')),
    false,
  );
});

test('diffSettings truncates large values and handles type changes', () => {
  const before = { flag: true, blob: 'x'.repeat(300) };
  const after = { flag: 'yes', blob: 'y'.repeat(300) };
  const changes = diffSettings(before, after);
  // Keys are visited in sorted order: blob before flag.
  assert.match(changes[0] ?? '', /^blob: x{120}… → y{120}…$/);
  assert.equal(changes[1], 'flag: true → yes');
});

test('diffSettings is empty for identical configs and handles empty inputs', () => {
  assert.deepEqual(diffSettings({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffSettings({}, {}), []);
  assert.deepEqual(diffSettings(null, null), []);
  assert.deepEqual(diffSettings({ a: undefined }, { a: undefined }), []);
});
