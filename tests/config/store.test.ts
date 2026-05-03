import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../src/config/store.js';
import type { UpstreamConfig } from '../../src/config/types.js';

let tmpFile: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-test-'));
  tmpFile = path.join(dir, 'config.json');
});

afterEach(() => {
  try {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    const dir = path.dirname(tmpFile);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  } catch {
    // ignore
  }
});

function makeUpstream(overrides: Partial<UpstreamConfig> = {}): UpstreamConfig {
  return {
    name: 'kimi',
    provider: 'moonshot',
    protocol: 'anthropic',
    baseUrl: 'https://api.moonshot.cn',
    apiKey: 'sk-x',
    models: ['claude-sonnet-4-20250514'],
    enabled: true,
    ...overrides,
  };
}

test('legacy config without modelMap loads with modelMap undefined', () => {
  // Pre-existing config file written without the modelMap field
  fs.writeFileSync(
    tmpFile,
    JSON.stringify({
      server: { port: 15005, logFlushIntervalMs: 5000, logBatchSize: 100 },
      proxyKeys: [],
      upstreams: [
        {
          name: 'kimi',
          provider: 'moonshot',
          protocol: 'anthropic',
          baseUrl: 'https://api.moonshot.cn',
          apiKey: 'sk-x',
          models: [],
          enabled: true,
        },
      ],
    }),
    'utf-8',
  );

  const store = new ConfigStore(tmpFile);
  const config = store.load();
  assert.equal(config.upstreams.length, 1);
  assert.equal(config.upstreams[0]!.modelMap, undefined);
});

test('addUpstream with modelMap persists and round-trips', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(
    makeUpstream({
      modelMap: { 'claude-sonnet-4*': 'kimi-k2-turbo' },
    }),
  );

  const reloaded = new ConfigStore(tmpFile);
  const upstreams = reloaded.listUpstreams();
  assert.equal(upstreams.length, 1);
  assert.deepEqual(upstreams[0]!.modelMap, { 'claude-sonnet-4*': 'kimi-k2-turbo' });
});

test('getUpstream returns the named upstream or undefined', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(makeUpstream({ name: 'kimi' }));

  const u = store.getUpstream('kimi');
  assert.ok(u);
  assert.equal(u!.name, 'kimi');
  assert.equal(store.getUpstream('does-not-exist'), undefined);
});

test('updateUpstream merges patch fields', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(makeUpstream({ name: 'kimi', enabled: true }));
  store.updateUpstream('kimi', { enabled: false, baseUrl: 'https://new.example.com' });

  const u = store.getUpstream('kimi');
  assert.ok(u);
  assert.equal(u!.enabled, false);
  assert.equal(u!.baseUrl, 'https://new.example.com');
  assert.equal(u!.name, 'kimi');
});

test('updateUpstream throws for unknown upstream', () => {
  const store = new ConfigStore(tmpFile);
  assert.throws(() => store.updateUpstream('nope', { enabled: false }), /nope/);
});

test('setModelMapEntry initializes modelMap and persists', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(makeUpstream({ name: 'kimi' }));

  store.setModelMapEntry('kimi', 'claude-sonnet-4*', 'kimi-k2-turbo');

  const reloaded = new ConfigStore(tmpFile);
  const u = reloaded.getUpstream('kimi');
  assert.deepEqual(u!.modelMap, { 'claude-sonnet-4*': 'kimi-k2-turbo' });
});

test('setModelMapEntry overwrites existing pattern', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(
    makeUpstream({
      name: 'kimi',
      modelMap: { 'claude-*': 'kimi-old' },
    }),
  );

  store.setModelMapEntry('kimi', 'claude-*', 'kimi-new');

  const u = store.getUpstream('kimi');
  assert.deepEqual(u!.modelMap, { 'claude-*': 'kimi-new' });
});

test('setModelMapEntry throws for unknown upstream', () => {
  const store = new ConfigStore(tmpFile);
  assert.throws(
    () => store.setModelMapEntry('nope', 'claude-*', 'kimi-k2'),
    /nope/,
  );
});

test('deleteModelMapEntry removes pattern and persists', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(
    makeUpstream({
      name: 'kimi',
      modelMap: { 'claude-*': 'kimi-k2', 'gpt-*': 'kimi-k2' },
    }),
  );

  store.deleteModelMapEntry('kimi', 'claude-*');

  const reloaded = new ConfigStore(tmpFile);
  const u = reloaded.getUpstream('kimi');
  assert.deepEqual(u!.modelMap, { 'gpt-*': 'kimi-k2' });
});

test('deleteModelMapEntry is idempotent for missing patterns', () => {
  const store = new ConfigStore(tmpFile);
  store.addUpstream(makeUpstream({ name: 'kimi' }));

  // No modelMap at all - should not throw.
  assert.doesNotThrow(() => store.deleteModelMapEntry('kimi', 'never-existed'));

  store.setModelMapEntry('kimi', 'a', 'b');
  // modelMap exists but pattern is missing - should not throw.
  assert.doesNotThrow(() => store.deleteModelMapEntry('kimi', 'never-existed'));
});

test('deleteModelMapEntry throws for unknown upstream', () => {
  const store = new ConfigStore(tmpFile);
  assert.throws(() => store.deleteModelMapEntry('nope', 'foo'), /nope/);
});

test('save() chmods config file to 0600 (owner read/write only)', () => {
  if (process.platform === 'win32') return;
  const store = new ConfigStore(tmpFile);
  store.addUpstream(makeUpstream());
  const stats = fs.statSync(tmpFile);
  const mode = stats.mode & 0o777;
  assert.equal(mode, 0o600);
});

test('default config has bindAddress 127.0.0.1', () => {
  const store = new ConfigStore(tmpFile);
  const config = store.load();
  assert.equal(config.server.bindAddress, '127.0.0.1');
});

test('legacy config without bindAddress merges to 127.0.0.1 default', () => {
  fs.writeFileSync(
    tmpFile,
    JSON.stringify({
      server: { port: 9999, logFlushIntervalMs: 1000, logBatchSize: 50 },
      proxyKeys: [],
      upstreams: [],
    }),
    'utf-8'
  );
  const store = new ConfigStore(tmpFile);
  const config = store.load();
  assert.equal(config.server.bindAddress, '127.0.0.1');
  assert.equal(config.server.port, 9999);
});
