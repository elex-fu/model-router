import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeminiCredentialEnvelope } from '../../../../src/saas/platform/gemini-oauth/binding-service.js';
import {
  buildGeminiSealedEnvelope,
  createPostgresGeminiCatalogBindingResolver,
  createProviderSupplyGeminiCredentialSink,
  GeminiCredentialSinkError,
} from '../../../../src/saas/platform/gemini-oauth/supply-sink.js';
import type { ProviderAccountRecord, ProviderCredentialWriteResult } from '../../../../src/saas/supply/types.js';

const ENVELOPE: GeminiCredentialEnvelope = {
  accessToken: 'accs-sink',
  refreshToken: 'rfrsh-sink',
  expiresAt: new Date(1_700_003_600_000).toISOString(),
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  projectId: 'project-sink',
  tierId: 'standard-tier',
  email: 'operator@example.test',
};

interface QueryCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function fakeDatabase(rows: Record<string, unknown[]>): { calls: QueryCall[]; query: unknown } {
  const calls: QueryCall[] = [];
  return {
    calls,
    query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      const key = sql.includes('saas_provider_rights') ? 'rights' : 'capabilities';
      const list = rows[key] ?? [];
      return { rows: list, rowCount: list.length };
    },
  };
}

function fakeSupply() {
  const accounts: unknown[] = [];
  const credentials: unknown[] = [];
  return {
    accounts,
    credentials,
    supply: {
      async createPlatformProviderAccount(input: unknown) {
        accounts.push(input);
        return { id: 'platform-account-9' } as unknown as ProviderAccountRecord;
      },
      async createPlatformProviderCredential(input: unknown) {
        credentials.push(input);
        return { version: 1 } as unknown as ProviderCredentialWriteResult;
      },
    },
  };
}

function envelopeInput() {
  return {
    envelope: ENVELOPE,
    actorUserId: 'operator-1',
    source: 'oauth-binding' as const,
    sourceIp: '203.0.113.9',
    userAgent: 'test-agent',
  };
}

test('the catalog binding resolver reads rights and capabilities, failing closed', async () => {
  const ok = fakeDatabase({
    rights: [{ rights_id: 'rights-1', version: 3 }],
    capabilities: [
      { model: 'gemini-2.5-pro', endpoint: 'gemini-generate-content', version: 2 },
      { model: 'not-a-model', endpoint: 'gemini-generate-content', version: 0 },
      { model: 'gemini-2.5-flash', endpoint: 'gemini-generate-content', version: 5 },
    ],
  });
  const binding = await createPostgresGeminiCatalogBindingResolver(ok as never)();
  assert.equal(binding.rightsId, 'rights-1');
  assert.equal(binding.rightsVersion, 3);
  assert.deepEqual(binding.capabilities, [
    { model: 'gemini-2.5-pro', endpoint: 'gemini-generate-content', version: 2 },
    { model: 'gemini-2.5-flash', endpoint: 'gemini-generate-content', version: 5 },
  ]);
  assert.match(ok.calls[0]?.sql ?? '', /provider_id = \$1/);
  assert.match(ok.calls[1]?.sql ?? '', /saas_provider_capabilities/);

  for (const rows of [
    { rights: [], capabilities: [{ model: 'm', endpoint: 'e', version: 1 }] },
    { rights: [{ rights_id: 'r', version: 'x' }], capabilities: [] },
    { rights: [{ rights_id: 'r', version: 1 }], capabilities: [] },
  ]) {
    const database = fakeDatabase(rows);
    await assert.rejects(createPostgresGeminiCatalogBindingResolver(database as never)(), (error: unknown) => {
      assert.ok(error instanceof GeminiCredentialSinkError);
      assert.equal(error.code, 'CATALOG_BINDING_MISSING');
      return true;
    });
  }
});

test('the sealed envelope carries the dispatch-wrap metadata, never token echoes', () => {
  const sealed = buildGeminiSealedEnvelope(ENVELOPE, () => 1_700_000_000_000);
  const material = JSON.parse(new TextDecoder().decode(sealed.secret)) as Record<string, unknown>;
  assert.equal(material.access_token, 'accs-sink');
  assert.equal(material.refresh_token, 'rfrsh-sink');
  assert.equal(material.token_type, 'Bearer');
  assert.equal(material.expires_at, ENVELOPE.expiresAt);
  assert.equal(material.client_id, '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
  assert.equal(material.project_id, 'project-sink');
  assert.equal(material.tier_id, 'standard-tier');
  assert.equal(material.email, 'operator@example.test');
  assert.equal(typeof material.expires_in, 'number');
  assert.equal(sealed.expiresAt, ENVELOPE.expiresAt);
  // Optional fields stay absent when null.
  const minimal = buildGeminiSealedEnvelope(
    { ...ENVELOPE, tierId: null, email: null, expiresAt: null },
    () => 1_700_000_000_000,
  );
  const minimalMaterial = JSON.parse(new TextDecoder().decode(minimal.secret)) as Record<string, unknown>;
  assert.equal('tier_id' in minimalMaterial, false);
  assert.equal('email' in minimalMaterial, false);
  assert.equal('expires_in' in minimalMaterial, false);
  assert.equal(minimalMaterial.expires_at, null);
  assert.equal(minimal.expiresAt, null);
});

test('sink accept: one platform account + one sealed credential through the audited supply paths', async () => {
  const database = fakeDatabase({
    rights: [{ rights_id: 'rights-1', version: 3 }],
    capabilities: [{ model: 'gemini-2.5-pro', endpoint: 'gemini-generate-content', version: 2 }],
  });
  const fake = fakeSupply();
  const sink = createProviderSupplyGeminiCredentialSink({
    supply: fake.supply,
    resolveCatalogBinding: createPostgresGeminiCatalogBindingResolver(database as never),
    nowMs: () => 1_700_000_000_000,
  });
  const outcome = await sink.accept(envelopeInput());
  assert.equal(outcome.accountRef, 'platform-account-9');
  assert.equal(fake.accounts.length, 1);
  const account = fake.accounts[0] as Record<string, unknown>;
  assert.equal(account.providerId, 'google-gemini');
  assert.equal(account.productId, 'gemini-subscription');
  assert.equal(account.credentialType, 'oauth');
  assert.equal(account.displayName, 'Gemini operator@example.test');
  const audit = account.audit as Record<string, unknown>;
  assert.equal(audit.actorUserId, 'operator-1');
  assert.equal(audit.entryPoint, 'platform-gemini-oauth');
  assert.equal(fake.credentials.length, 1);
  const credential = fake.credentials[0] as Record<string, unknown>;
  assert.equal(credential.accountId, 'platform-account-9');
  assert.ok(credential.secret instanceof Uint8Array);
  // Display name falls back to the project when email is absent.
  const noEmail = await sink.accept({
    ...envelopeInput(),
    envelope: { ...ENVELOPE, email: null },
  });
  assert.equal(noEmail.accountRef, 'platform-account-9');
  const fallbackAccount = fake.accounts[1] as Record<string, unknown>;
  assert.equal(fallbackAccount.displayName, 'Gemini project-sink');
});

test('sink accept: a supply failure is normalized, never leaking token material', async () => {
  const database = fakeDatabase({
    rights: [{ rights_id: 'rights-1', version: 3 }],
    capabilities: [{ model: 'gemini-2.5-pro', endpoint: 'gemini-generate-content', version: 2 }],
  });
  const sink = createProviderSupplyGeminiCredentialSink({
    supply: {
      createPlatformProviderAccount: async () => {
        throw new Error('db down');
      },
      createPlatformProviderCredential: async () => {
        throw new Error('unreachable');
      },
    },
    resolveCatalogBinding: createPostgresGeminiCatalogBindingResolver(database as never),
  });
  await assert.rejects(sink.accept(envelopeInput()), (error: unknown) => {
    assert.ok(error instanceof GeminiCredentialSinkError);
    assert.equal(error.code, 'SUPPLY_WRITE_FAILED');
    assert.equal(error.message.includes('accs-sink'), false);
    assert.equal(error.message.includes('rfrsh-sink'), false);
    return true;
  });
  // A resolver that throws is normalized to the same catalog failure.
  const sink2 = createProviderSupplyGeminiCredentialSink({
    supply: fakeSupply().supply,
    resolveCatalogBinding: async () => {
      throw new Error('boom');
    },
  });
  await assert.rejects(sink2.accept(envelopeInput()), (error: unknown) => {
    assert.ok(error instanceof GeminiCredentialSinkError);
    assert.equal(error.code, 'CATALOG_BINDING_MISSING');
    return true;
  });
  // Constructor validation.
  assert.throws(() => createProviderSupplyGeminiCredentialSink({ supply: fakeSupply().supply }), TypeError);
  const workingResolver = createPostgresGeminiCatalogBindingResolver(
    fakeDatabase({
      rights: [{ rights_id: 'r', version: 1 }],
      capabilities: [{ model: 'm', endpoint: 'e', version: 1 }],
    }) as never,
  );
  assert.throws(() => createProviderSupplyGeminiCredentialSink({ resolveCatalogBinding: workingResolver }), TypeError);
  assert.throws(
    () =>
      createProviderSupplyGeminiCredentialSink({
        supply: { createPlatformProviderAccount: async () => ({}) } as never,
        resolveCatalogBinding: workingResolver,
      }),
    TypeError,
  );
});
