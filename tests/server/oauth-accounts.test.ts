import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { ControlStore } from '../../src/control/store.js';
import { OAuthTokenResolver } from '../../src/server/oauth.js';
import { OAuthAccountStore } from '../../src/server/oauth-accounts.js';

describe('OAuthAccountStore', () => {
  let tmpDir: string;
  let control: ControlStore;
  let store: OAuthAccountStore;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
    configPath = path.join(tmpDir, 'config.json');
    control = new ControlStore(tmpDir);
    store = new OAuthAccountStore(configPath, control.secrets);
  });

  it('adds and retrieves default account without writing credentials to metadata', () => {
    store.add({
      id: '1',
      provider: 'codex_oauth',
      accessToken: 'tok-private',
      refreshToken: 'refresh-private',
      isDefault: true,
    });
    const acc = store.getDefault('codex_oauth');
    assert.equal(acc?.accessToken, 'tok-private');
    const disk = fs.readFileSync(path.join(tmpDir, 'oauth-accounts.json'), 'utf8');
    assert.equal(disk.includes('tok-private'), false);
    assert.equal(disk.includes('refresh-private'), false);
    assert.match(disk, /secretRef/);
  });

  it('reloads credentials from secure storage after reopening', () => {
    store.add({
      id: '1',
      provider: 'codex_oauth',
      accessToken: 'restart-private',
      refreshToken: 'restart-refresh',
      isDefault: true,
    });
    const reopened = new OAuthAccountStore(configPath, control.secrets);
    assert.deepEqual(reopened.get('codex_oauth', '1'), {
      id: '1',
      provider: 'codex_oauth',
      accessToken: 'restart-private',
      refreshToken: 'restart-refresh',
      isDefault: true,
    });
  });

  it('lists accounts by provider and provides decrypted account values', () => {
    store.add({ id: '1', provider: 'codex_oauth', accessToken: 'a', isDefault: true });
    store.add({ id: '2', provider: 'github_copilot', accessToken: 'b', isDefault: true });
    assert.equal(store.list('codex_oauth').length, 1);
    assert.equal(store.list()[1].accessToken, 'b');
  });

  it('deletes the associated secret', () => {
    store.add({ id: '1', provider: 'codex_oauth', accessToken: 'delete-private', isDefault: true });
    const metadata = JSON.parse(fs.readFileSync(path.join(tmpDir, 'oauth-accounts.json'), 'utf8')) as Array<{
      secretRef: string;
    }>;
    const secretRef = metadata[0].secretRef;
    assert.equal(control.secrets.has(secretRef), true);
    store.remove('codex_oauth', '1');
    assert.equal(control.secrets.has(secretRef), false);
  });

  it('securely migrates legacy plaintext metadata', () => {
    const legacy = [
      {
        id: 'legacy',
        provider: 'codex_oauth',
        accessToken: 'legacy-private',
        refreshToken: 'legacy-refresh-private',
        isDefault: true,
      },
    ];
    fs.writeFileSync(path.join(tmpDir, 'oauth-accounts.json'), JSON.stringify(legacy));
    const migrated = new OAuthAccountStore(configPath, control.secrets);
    assert.equal(migrated.getDefault('codex_oauth')?.accessToken, 'legacy-private');
    const disk = fs.readFileSync(path.join(tmpDir, 'oauth-accounts.json'), 'utf8');
    assert.equal(disk.includes('legacy-private'), false);
    assert.equal(disk.includes('legacy-refresh-private'), false);
    assert.match(disk, /secretRef/);
  });

  it('preserves the legacy file and reports actionable error when migration cannot store secrets', () => {
    const legacyText = JSON.stringify([
      { id: 'legacy', provider: 'codex_oauth', accessToken: 'never-print-this', isDefault: true },
    ]);
    fs.writeFileSync(path.join(tmpDir, 'oauth-accounts.json'), legacyText);
    const failingSecrets = {
      put: () => {
        throw new Error('backend failure never-print-this');
      },
      get: () => undefined,
      delete: () => {},
    };
    assert.throws(
      () => new OAuthAccountStore(configPath, failingSecrets),
      (error: unknown) =>
        error instanceof Error &&
        /original file was preserved/.test(error.message) &&
        !error.message.includes('never-print-this'),
    );
    assert.equal(fs.readFileSync(path.join(tmpDir, 'oauth-accounts.json'), 'utf8'), legacyText);
  });

  it('rejects construction without secure storage', () => {
    assert.throws(() => new OAuthAccountStore(configPath, undefined as never), /requires a secure SecretStore/);
  });
});

describe('OAuthTokenResolver with device_code', () => {
  let tmpDir: string;
  let control: ControlStore;
  let store: OAuthAccountStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
    control = new ControlStore(tmpDir);
    store = new OAuthAccountStore(path.join(tmpDir, 'config.json'), control.secrets);
  });

  it('resolves default account token', async () => {
    store.add({ id: '1', provider: 'codex_oauth', accessToken: 'dev-tok', isDefault: true });
    const resolver = new OAuthTokenResolver(store);
    const token = await resolver.resolve(
      { tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' },
      'codex_oauth',
    );
    assert.equal(token, 'dev-tok');
  });

  it('throws when no default account', async () => {
    const resolver = new OAuthTokenResolver(store);
    await assert.rejects(
      () => resolver.resolve({ tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' }, 'codex_oauth'),
      /No authenticated account/,
    );
  });
});
