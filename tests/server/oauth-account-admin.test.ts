import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ControlError } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { createOAuthAccountAdminAdapters } from '../../src/server/oauth-account-admin.js';
import { OAuthAccountStore } from '../../src/server/oauth-accounts.js';

describe('OAuth account admin adapters', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-admin-'));
    dirs.push(dir);
    const control = new ControlStore(dir);
    const store = new OAuthAccountStore(path.join(dir, 'config.json'), control.secrets);
    return { dir, control, store, adapters: createOAuthAccountAdminAdapters(store, control) };
  }

  it('returns a safe account DTO without credentials or secret references', async () => {
    const { store, adapters } = setup();
    store.add({
      id: 'safe-id',
      provider: 'codex_oauth',
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      expiresAt: Date.now() + 60_000,
      isDefault: true,
    });
    const result = await adapters.accounts();
    const storedAccount = store.list()[0];
    assert.ok(storedAccount?.expiresAt);
    assert.deepEqual(result, [
      {
        id: 'safe-id',
        provider: 'codex_oauth',
        type: 'oauth',
        status: 'active',
        expiresAt: new Date(storedAccount.expiresAt).toISOString(),
        isDefault: true,
        refreshAvailable: false,
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'accessToken',
      'refreshToken',
      'secretRef',
      'clientSecret',
      'private-access',
      'private-refresh',
    ])
      assert.equal(serialized.includes(forbidden), false);
  });

  it('sets a unique account as default and audits without credentials', async () => {
    const { store, control, adapters } = setup();
    store.add({ id: 'old', provider: 'codex_oauth', accessToken: 'old-secret', isDefault: true });
    store.add({ id: 'new', provider: 'codex_oauth', accessToken: 'new-secret' });
    const result = await adapters.accountPatch({ accountId: 'new', actor: 'admin', isDefault: true });
    assert.equal(store.getDefault('codex_oauth')?.id, 'new');
    assert.equal((result as { isDefault: boolean }).isDefault, true);
    const events = control.db.prepare('SELECT action,detail FROM audit_events').all() as Array<{
      action: string;
      detail: string;
    }>;
    assert.equal(events[0].action, 'oauth.account.set_default');
    assert.doesNotMatch(events[0].detail, /old-secret|new-secret|accessToken|refreshToken|secretRef/);
  });

  it('rejects unsupported account mutations', async () => {
    const { store, adapters } = setup();
    store.add({ id: 'keep', provider: 'codex_oauth', accessToken: 'keep-secret', isDefault: false });
    for (const payload of [
      { accountId: 'keep', isDefault: false },
      { accountId: 'keep', isDefault: true, login: 'changed' },
      { accountId: 'keep' },
    ]) {
      await assert.rejects(
        () => adapters.accountPatch(payload),
        (error: unknown) =>
          error instanceof ControlError && error.status === 422 && error.code === 'UNSUPPORTED_ACCOUNT_MUTATION',
      );
    }
    assert.equal(store.list()[0].isDefault, false);
  });

  it('deletes the account and reclaims its secure secret', async () => {
    const { dir, control, store, adapters } = setup();
    store.add({ id: 'remove-me', provider: 'github_copilot', accessToken: 'delete-secret' });
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'oauth-accounts.json'), 'utf8')) as Array<{
      secretRef: string;
    }>;
    const secretRef = metadata[0].secretRef;
    assert.equal(control.secrets.has(secretRef), true);
    await adapters.accountDelete({ accountId: 'remove-me', actor: 'admin' });
    assert.equal(control.secrets.has(secretRef), false);
    assert.equal(store.list().length, 0);
  });

  it('reports a conflict when an id occurs under multiple providers', async () => {
    const { store, adapters } = setup();
    store.add({ id: 'collision', provider: 'codex_oauth', accessToken: 'codex-secret' });
    store.add({ id: 'collision', provider: 'github_copilot', accessToken: 'github-secret' });
    await assert.rejects(
      () => adapters.accountDelete({ accountId: 'collision', actor: 'admin' }),
      (error: unknown) => error instanceof ControlError && error.status === 409 && error.code === 'ACCOUNT_ID_CONFLICT',
    );
    assert.equal(store.list().length, 2);
  });

  it('keeps credentials out of account audit events', async () => {
    const { control, store, adapters } = setup();
    store.add({
      id: 'audit-id',
      provider: 'codex_oauth',
      accessToken: 'audit-access',
      refreshToken: 'audit-refresh',
      isDefault: false,
    });
    await adapters.accountDelete({ accountId: 'audit-id', actor: 'admin' });
    const events = control.db.prepare('SELECT action,detail FROM audit_events').all() as Array<{
      action: string;
      detail: string;
    }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'oauth.account.delete');
    assert.doesNotMatch(events[0].detail, /audit-access|audit-refresh|accessToken|refreshToken|secretRef/);
  });
});
