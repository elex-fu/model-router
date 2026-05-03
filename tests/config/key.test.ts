import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ProxyKey } from '../../src/config/types.js';
import { ConfigStore } from '../../src/config/store.js';

function tmpConfigPath(): string {
  return path.join(os.tmpdir(), `mr-key-${randomUUID()}.json`);
}

test('ProxyKey schema accepts new optional fields', () => {
  const key: ProxyKey = {
    name: 'alice',
    key: 'mrk_test',
    enabled: true,
    createdAt: '2026-05-03T00:00:00Z',
    description: 'alice@team.com',
    expiresAt: '2026-12-31T23:59:59Z',
    allowedUpstreams: ['kimi-code'],
    allowedModels: ['claude-sonnet-*'],
    rpm: 30,
    dailyTokens: 2_000_000,
  };
  assert.equal(key.description, 'alice@team.com');
  assert.equal(key.rpm, 30);
});

test('ProxyKey new fields are all optional (back-compat with old schema)', () => {
  const key: ProxyKey = {
    name: 'legacy',
    key: 'mrk_old',
    enabled: true,
    createdAt: '2026-05-01T00:00:00Z',
  };
  assert.equal(key.description, undefined);
  assert.equal(key.expiresAt, undefined);
  assert.equal(key.allowedUpstreams, undefined);
  assert.equal(key.allowedModels, undefined);
  assert.equal(key.rpm, undefined);
  assert.equal(key.dailyTokens, undefined);
});

test('ConfigStore.load preserves new ProxyKey fields round-trip', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'bob',
      key: 'mrk_bob',
      enabled: true,
      createdAt: '2026-05-03T00:00:00Z',
      description: 'bob',
      expiresAt: '2026-12-31T00:00:00Z',
      allowedUpstreams: ['u1', 'u2'],
      allowedModels: ['claude-*'],
      rpm: 60,
      dailyTokens: 5_000_000,
    });
    const reloaded = new ConfigStore(p).listProxyKeys();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]!.description, 'bob');
    assert.deepEqual(reloaded[0]!.allowedUpstreams, ['u1', 'u2']);
    assert.deepEqual(reloaded[0]!.allowedModels, ['claude-*']);
    assert.equal(reloaded[0]!.rpm, 60);
    assert.equal(reloaded[0]!.dailyTokens, 5_000_000);
    assert.equal(reloaded[0]!.expiresAt, '2026-12-31T00:00:00Z');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.load tolerates legacy proxyKeys without new fields', () => {
  const p = tmpConfigPath();
  try {
    fs.writeFileSync(
      p,
      JSON.stringify({
        server: { port: 15005, logFlushIntervalMs: 5000, logBatchSize: 100 },
        proxyKeys: [
          { name: 'legacy', key: 'mrk_old', enabled: true, createdAt: '2026-05-01T00:00:00Z' },
        ],
        upstreams: [],
      })
    );
    const store = new ConfigStore(p);
    const keys = store.listProxyKeys();
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, 'legacy');
    assert.equal(keys[0]!.rpm, undefined);
    assert.equal(keys[0]!.allowedUpstreams, undefined);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.getProxyKeyByName returns key including disabled', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'disabled-one',
      key: 'mrk_disabled',
      enabled: false,
      createdAt: '2026-05-03T00:00:00Z',
    });
    const k = store.getProxyKeyByName('disabled-one');
    assert.ok(k);
    assert.equal(k!.enabled, false);
    assert.equal(store.getProxyKeyByName('does-not-exist'), undefined);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.getProxyKeyByKey returns key regardless of enabled flag', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'disabled-one',
      key: 'mrk_disabled',
      enabled: false,
      createdAt: '2026-05-03T00:00:00Z',
    });
    const k = store.getProxyKeyByKey('mrk_disabled');
    assert.ok(k);
    assert.equal(k!.enabled, false);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.updateProxyKey merges patch fields', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'alice',
      key: 'mrk_alice',
      enabled: true,
      createdAt: '2026-05-03T00:00:00Z',
      rpm: 30,
      allowedUpstreams: ['u1'],
    });
    store.updateProxyKey('alice', {
      rpm: 60,
      description: 'alice@team.com',
      allowedUpstreams: ['u1', 'u2'],
    });
    const k = store.getProxyKeyByName('alice');
    assert.ok(k);
    assert.equal(k!.rpm, 60);
    assert.equal(k!.description, 'alice@team.com');
    assert.deepEqual(k!.allowedUpstreams, ['u1', 'u2']);
    assert.equal(k!.key, 'mrk_alice');
    assert.equal(k!.name, 'alice');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.updateProxyKey can clear optional fields with undefined', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'alice',
      key: 'mrk_alice',
      enabled: true,
      createdAt: '2026-05-03T00:00:00Z',
      expiresAt: '2026-12-31T00:00:00Z',
      allowedUpstreams: ['u1'],
    });
    store.updateProxyKey('alice', {
      expiresAt: undefined,
      allowedUpstreams: undefined,
    });
    const k = store.getProxyKeyByName('alice');
    assert.equal(k!.expiresAt, undefined);
    assert.equal(k!.allowedUpstreams, undefined);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.updateProxyKey throws for unknown name', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    assert.throws(() => store.updateProxyKey('nope', { rpm: 10 }), /nope/);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.rotateProxyKey replaces key, preserves metadata', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'alice',
      key: 'mrk_old',
      enabled: true,
      createdAt: '2026-05-03T00:00:00Z',
      rpm: 30,
      allowedUpstreams: ['u1'],
      description: 'alice',
    });
    store.rotateProxyKey('alice', 'mrk_new');
    const k = store.getProxyKeyByName('alice');
    assert.ok(k);
    assert.equal(k!.key, 'mrk_new');
    assert.equal(k!.rpm, 30);
    assert.deepEqual(k!.allowedUpstreams, ['u1']);
    assert.equal(k!.description, 'alice');
    // Old key string no longer authenticates.
    assert.equal(store.getProxyKeyByKey('mrk_old'), undefined);
    assert.equal(store.getProxyKeyByKey('mrk_new')?.name, 'alice');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('ConfigStore.setProxyKeyEnabled toggles flag and persists', () => {
  const p = tmpConfigPath();
  try {
    const store = new ConfigStore(p);
    store.addProxyKey({
      name: 'alice',
      key: 'mrk_alice',
      enabled: true,
      createdAt: '2026-05-03T00:00:00Z',
    });
    assert.equal(store.setProxyKeyEnabled('alice', false), true);
    assert.equal(store.getProxyKeyByName('alice')!.enabled, false);
    assert.equal(store.setProxyKeyEnabled('alice', true), true);
    assert.equal(store.getProxyKeyByName('alice')!.enabled, true);
    assert.equal(store.setProxyKeyEnabled('nope', true), false);
  } finally {
    fs.rmSync(p, { force: true });
  }
});
