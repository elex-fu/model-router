import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexCredentialEnvelope } from '../../../../src/saas/platform/codex-oauth/binding-service.js';
import {
  buildCodexSealedEnvelope,
  CodexCredentialSinkError,
  createPostgresCodexCatalogBindingResolver,
  createProviderSupplyCodexCredentialSink,
} from '../../../../src/saas/platform/codex-oauth/supply-sink.js';

const ENVELOPE: CodexCredentialEnvelope = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  idToken: 'id-token-not-persisted',
  expiresAt: '2026-10-15T12:00:00.000Z',
  clientId: 'app_test',
  email: 'user@example.com',
  chatgptAccountId: 'chatgpt-acct-1',
  chatgptUserId: 'chatgpt-user-1',
  planType: 'plus',
} as CodexCredentialEnvelope;

test('sealed envelope carries the rotation-preserved codex metadata, never the id_token', () => {
  const nowMs = () => Date.parse('2026-10-15T10:00:00.000Z');
  const { secret, expiresAt } = buildCodexSealedEnvelope(ENVELOPE, nowMs);
  const material = JSON.parse(new TextDecoder().decode(secret)) as Record<string, unknown>;

  assert.equal(material.access_token, 'access-token');
  assert.equal(material.refresh_token, 'refresh-token');
  assert.equal(material.token_type, 'Bearer');
  assert.equal(material.client_id, 'app_test');
  assert.equal(material.chatgpt_account_id, 'chatgpt-acct-1');
  assert.equal(material.chatgpt_user_id, 'chatgpt-user-1');
  assert.equal(material.plan_type, 'plus');
  assert.equal(material.email, 'user@example.com');
  // expires_in is derived relative to now (2h here).
  assert.equal(material.expires_in, 7200);
  assert.equal(expiresAt, ENVELOPE.expiresAt);
  // The id_token is binding-time-only material and must not be persisted.
  assert.equal('id_token' in material, false);
});

test('catalog binding resolver fails closed when rights or capabilities are missing', async () => {
  const emptyDb = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const resolver = createPostgresCodexCatalogBindingResolver(emptyDb);
  await assert.rejects(
    () => resolver(),
    (error: unknown) => error instanceof CodexCredentialSinkError && error.code === 'CATALOG_BINDING_MISSING',
  );

  const rightsOnlyDb = {
    query: async (sql: string) =>
      sql.includes('saas_provider_rights')
        ? { rows: [{ rights_id: 'rights-1', version: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
  };
  await assert.rejects(
    () => createPostgresCodexCatalogBindingResolver(rightsOnlyDb)(),
    (error: unknown) => error instanceof CodexCredentialSinkError && error.code === 'CATALOG_BINDING_MISSING',
  );
});

test('sink accept: one platform account + one sealed credential through the audited supply paths', async () => {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const supply = {
    createPlatformProviderAccount: async (input: Record<string, unknown>) => {
      calls.push({ kind: 'account', input });
      return { id: 'acct-new' };
    },
    createPlatformProviderCredential: async (input: Record<string, unknown>) => {
      calls.push({ kind: 'credential', input });
      return { credentialId: 'cred-new' };
    },
  };
  const sink = createProviderSupplyCodexCredentialSink({
    supply: supply as never,
    resolveCatalogBinding: async () => ({
      rightsId: 'rights-1',
      rightsVersion: 1,
      capabilities: [{ model: 'gpt-5.3-codex', endpoint: 'codex-responses', version: 1 }],
    }),
    nowMs: () => Date.parse('2026-10-15T10:00:00.000Z'),
  });

  const result = await sink.accept({
    envelope: ENVELOPE,
    actorUserId: 'admin-1',
    sourceIp: '127.0.0.1',
    userAgent: 'console',
  });
  assert.deepEqual(result, { accountRef: 'acct-new' });
  assert.equal(calls.length, 2);

  const account = calls[0]?.input as Record<string, unknown>;
  assert.equal(account.providerId, 'openai-codex');
  assert.equal(account.productId, 'codex-chatgpt');
  assert.equal(account.credentialType, 'oauth');
  assert.equal(account.rightsId, 'rights-1');
  assert.equal(account.displayName, 'Codex user@example.com');

  const credential = calls[1]?.input as { accountId: string; secret: Uint8Array; expiresAt?: string };
  assert.equal(credential.accountId, 'acct-new');
  assert.equal(credential.expiresAt, ENVELOPE.expiresAt);
  const material = JSON.parse(new TextDecoder().decode(credential.secret)) as Record<string, unknown>;
  assert.equal(material.chatgpt_account_id, 'chatgpt-acct-1');
});

test('sink accept: a supply failure is normalized, never leaking token material', async () => {
  const supply = {
    createPlatformProviderAccount: async () => {
      throw new Error('db down near access-token');
    },
    createPlatformProviderCredential: async () => {
      throw new Error('unreachable');
    },
  };
  const sink = createProviderSupplyCodexCredentialSink({
    supply: supply as never,
    resolveCatalogBinding: async () => ({ rightsId: 'r', rightsVersion: 1, capabilities: [] }),
  });
  await assert.rejects(
    () => sink.accept({ envelope: ENVELOPE, actorUserId: 'admin-1', sourceIp: null, userAgent: null }),
    (error: unknown) => {
      assert.ok(error instanceof CodexCredentialSinkError);
      assert.equal(error.code, 'SUPPLY_WRITE_FAILED');
      // The normalized error carries no upstream detail.
      assert.equal(error.message.includes('access-token'), false);
      return true;
    },
  );
});
