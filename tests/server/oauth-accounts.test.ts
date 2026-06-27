import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OAuthAccountStore } from '../../src/server/oauth-accounts.js';
import { OAuthTokenResolver } from '../../src/server/oauth.js';

describe('OAuthAccountStore', () => {
  let tmpDir: string;
  let store: OAuthAccountStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
    store = new OAuthAccountStore(path.join(tmpDir, 'config.json'));
  });

  it('adds and retrieves default account', () => {
    store.add({ id: '1', provider: 'codex_oauth', accessToken: 'tok', isDefault: true });
    const acc = store.getDefault('codex_oauth');
    assert.equal(acc?.accessToken, 'tok');
  });

  it('lists accounts by provider', () => {
    store.add({ id: '1', provider: 'codex_oauth', accessToken: 'a', isDefault: true });
    store.add({ id: '2', provider: 'github_copilot', accessToken: 'b', isDefault: true });
    assert.equal(store.list('codex_oauth').length, 1);
  });
});

describe('OAuthTokenResolver with device_code', () => {
  let tmpDir: string;
  let store: OAuthAccountStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
    store = new OAuthAccountStore(path.join(tmpDir, 'config.json'));
  });

  it('resolves default account token', async () => {
    store.add({ id: '1', provider: 'codex_oauth', accessToken: 'dev-tok', isDefault: true });
    const resolver = new OAuthTokenResolver(store);
    const token = await resolver.resolve({ tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' }, 'codex_oauth');
    assert.equal(token, 'dev-tok');
  });

  it('throws when no default account', async () => {
    const resolver = new OAuthTokenResolver(store);
    await assert.rejects(
      () => resolver.resolve({ tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' }, 'codex_oauth'),
      /No authenticated account/
    );
  });
});
