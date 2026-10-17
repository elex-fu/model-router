import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GrokCredentialEnvelope } from '../../../../src/saas/platform/grok-oauth/binding-service.js';
import {
  buildGrokSealedEnvelope,
  createPostgresGrokCatalogBindingResolver,
  createProviderSupplyGrokCredentialSink,
  GrokCredentialSinkError,
} from '../../../../src/saas/platform/grok-oauth/supply-sink.js';

const envelope: GrokCredentialEnvelope = {
  accessToken: 'accs-token',
  refreshToken: 'rfrsh-token',
  idToken: 'idt-token',
  expiresAt: '2026-10-17T12:00:00.000Z',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  email: 'ops@example.com',
  userId: 'user-77',
  teamId: 'team-42',
  subscriptionTier: 'supergrok_heavy',
};

function parseSecret(secret: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder('utf-8').decode(secret)) as Record<string, unknown>;
}

test('the sealed envelope carries the refresh contract plus the gateway metadata', () => {
  const nowMs = () => Date.parse('2026-10-17T06:00:00.000Z');
  const sealed = buildGrokSealedEnvelope(envelope, nowMs);
  const material = parseSecret(sealed.secret);
  assert.equal(material.access_token, 'accs-token');
  assert.equal(material.refresh_token, 'rfrsh-token');
  assert.equal(material.token_type, 'Bearer');
  assert.equal(material.client_id, envelope.clientId);
  assert.equal(material.user_id, 'user-77');
  assert.equal(material.team_id, 'team-42');
  assert.equal(material.email, 'ops@example.com');
  // The tier survives into the envelope — the refresh passthrough keeps it.
  assert.equal(material.subscription_tier, 'supergrok_heavy');
  // expires_in is derived from the wall clock distance to expiresAt.
  assert.equal(material.expires_in, 6 * 60 * 60);
  assert.equal(sealed.expiresAt, envelope.expiresAt);
  // The id_token is never persisted.
  assert.equal(material.id_token, undefined);
});

test('a null expiry omits expires_in but keeps the binding contract', () => {
  const material = parseSecret(
    buildGrokSealedEnvelope({ ...envelope, expiresAt: null, teamId: null, email: null, subscriptionTier: null }).secret,
  );
  assert.equal(material.expires_in, undefined);
  assert.equal(material.team_id, undefined);
  assert.equal(material.email, undefined);
  assert.equal(material.subscription_tier, undefined);
  assert.equal(material.user_id, 'user-77');
});

function fakeDatabase(rightsFound: boolean, capabilityCount: number) {
  return {
    async query(sql: string) {
      if (sql.includes('saas_provider_rights')) {
        return rightsFound
          ? { rows: [{ rights_id: 'grok-subscription-platform-oauth-v1', version: 3 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return {
        rows: Array.from({ length: capabilityCount }, (_, index) => ({
          model: `grok-4.${index}`,
          endpoint: 'grok-responses',
          version: 2,
        })),
        rowCount: capabilityCount,
      };
    },
  };
}

test('the sink creates one platform account and one sealed credential through the supply service', async () => {
  const created: unknown[] = [];
  const sink = createProviderSupplyGrokCredentialSink({
    supply: {
      async createPlatformProviderAccount(input: { providerId: string; productId: string }) {
        created.push(input);
        return { id: 'acct-1' } as { id: string };
      },
      async createPlatformProviderCredential(input: { accountId: string }) {
        created.push(input);
        return { version: 1 } as { version: number };
      },
    },
    resolveCatalogBinding: createPostgresGrokCatalogBindingResolver(fakeDatabase(true, 2)),
  });
  const outcome = await sink.accept({
    envelope,
    actorUserId: 'admin-1',
    source: 'oauth-binding',
    sourceIp: '127.0.0.1',
    userAgent: 'test',
  });
  assert.equal(outcome.accountRef, 'acct-1');
  assert.equal(created.length, 2);
  const account = created[0] as { providerId: string; productId: string; credentialType: string; rightsId: string };
  assert.equal(account.providerId, 'xai-grok');
  assert.equal(account.productId, 'grok-subscription');
  assert.equal(account.credentialType, 'oauth');
  assert.equal(account.rightsId, 'grok-subscription-platform-oauth-v1');
  const credential = created[1] as { accountId: string };
  assert.equal(credential.accountId, 'acct-1');
});

test('the sink fails closed when the catalog binding is not registered', async () => {
  const sink = createProviderSupplyGrokCredentialSink({
    supply: {
      async createPlatformProviderAccount() {
        throw new Error('must not be reached');
      },
      async createPlatformProviderCredential() {
        throw new Error('must not be reached');
      },
    },
    resolveCatalogBinding: createPostgresGrokCatalogBindingResolver(fakeDatabase(false, 0)),
  });
  await assert.rejects(
    () =>
      sink.accept({
        envelope,
        actorUserId: 'admin-1',
        source: 'oauth-binding',
        sourceIp: null,
        userAgent: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof GrokCredentialSinkError);
      assert.equal((error as { code?: string }).code, 'CATALOG_BINDING_MISSING');
      return true;
    },
  );
});
