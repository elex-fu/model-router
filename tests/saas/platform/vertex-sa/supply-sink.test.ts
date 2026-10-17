import assert from 'node:assert/strict';
// Runtime-generated key material — never a source literal.
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_ENDPOINT,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
  VERTEX_PURPOSE,
  VERTEX_REGION,
  VERTEX_SUPPLY_MODE,
} from '../../../../src/saas/gateway/vertex/catalog-identity.js';
import { parseVertexServiceAccountImport } from '../../../../src/saas/platform/vertex-sa/import.js';
import {
  buildVertexSealedEnvelope,
  createPostgresVertexCatalogBindingResolver,
  createProviderSupplyVertexCredentialSink,
  VertexCredentialSinkError,
} from '../../../../src/saas/platform/vertex-sa/supply-sink.js';

function importedInput(): ReturnType<typeof parseVertexServiceAccountImport> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return parseVertexServiceAccountImport(
    JSON.stringify({
      type: 'service_account',
      project_id: 'proj-1',
      private_key_id: 'kid-1',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: 'vertex-sa@test.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
    { location: 'us-east4', vertexModelLocations: { 'gemini-2.5-pro': 'europe-west1' } },
  );
}

function fakeDatabase(rightsRowCount: number, capabilityRows: Array<Record<string, unknown>>) {
  return {
    async query(sql: string, _values?: readonly unknown[]) {
      if (sql.includes('saas_provider_rights')) {
        if (rightsRowCount === 0) return { rows: [], rowCount: 0 };
        return { rows: [{ rights_id: 'vertex-rights-1', version: 3 }], rowCount: 1 };
      }
      return { rows: capabilityRows, rowCount: capabilityRows.length };
    },
  };
}

test('the catalog binding resolver fails closed without an active rights row', async () => {
  const resolver = createPostgresVertexCatalogBindingResolver(fakeDatabase(0, []) as never);
  await assert.rejects(resolver(), (error: unknown) => error instanceof VertexCredentialSinkError);
  const emptyCapabilities = createPostgresVertexCatalogBindingResolver(fakeDatabase(1, []) as never);
  await assert.rejects(emptyCapabilities(), VertexCredentialSinkError);
});

test('the catalog binding resolver reads the latest rights and verified capabilities', async () => {
  const resolver = createPostgresVertexCatalogBindingResolver(
    fakeDatabase(1, [
      { model: 'claude-opus-4-5', endpoint: VERTEX_ENDPOINT, version: 2 },
      { model: 'gemini-2.5-pro', endpoint: VERTEX_ENDPOINT, version: 4 },
    ]) as never,
  );
  const binding = await resolver();
  assert.equal(binding.rightsId, 'vertex-rights-1');
  assert.equal(binding.rightsVersion, 3);
  assert.deepEqual(binding.capabilities, [
    { model: 'claude-opus-4-5', endpoint: VERTEX_ENDPOINT, version: 2 },
    { model: 'gemini-2.5-pro', endpoint: VERTEX_ENDPOINT, version: 4 },
  ]);
});

test('the sealed envelope carries the SA fields and location facts but no token', () => {
  const sealed = buildVertexSealedEnvelope(importedInput());
  const material = JSON.parse(new TextDecoder().decode(sealed.secret)) as Record<string, unknown>;
  assert.equal(material.type, 'service_account');
  assert.equal(material.project_id, 'proj-1');
  assert.equal(material.client_email, 'vertex-sa@test.iam.gserviceaccount.com');
  assert.equal(material.token_uri, 'https://oauth2.googleapis.com/token');
  assert.equal(material.location, 'us-east4');
  assert.deepEqual(material.vertex_model_locations, { 'gemini-2.5-pro': 'europe-west1' });
  assert.equal('access_token' in material, false);
});

test('the sink creates one platform account plus one sealed credential with the vertex triple', async () => {
  const created: unknown[] = [];
  const sink = createProviderSupplyVertexCredentialSink({
    supply: {
      async createPlatformProviderAccount(input) {
        created.push({ kind: 'account', input });
        return { id: 'account-uuid-1' } as never;
      },
      async createPlatformProviderCredential(input) {
        created.push({ kind: 'credential', input });
        return { version: 1 } as never;
      },
    },
    resolveCatalogBinding: async () => ({
      rightsId: 'vertex-rights-1',
      rightsVersion: 3,
      capabilities: [{ model: 'claude-opus-4-5', endpoint: VERTEX_ENDPOINT, version: 2 }],
    }),
  });
  const result = await sink.accept({
    actorUserId: 'operator-1',
    sourceIp: '127.0.0.1',
    userAgent: null,
    imported: importedInput(),
  });
  assert.deepEqual(result, { accountRef: 'account-uuid-1' });
  const account = created[0] as { kind: string; input: Record<string, unknown> };
  const credential = created[1] as { kind: string; input: Record<string, unknown> };
  assert.equal(account.kind, 'account');
  assert.equal(account.input.providerId, VERTEX_PROVIDER_ID);
  assert.equal(account.input.productId, VERTEX_PRODUCT_ID);
  assert.equal(account.input.credentialType, VERTEX_CREDENTIAL_TYPE);
  assert.equal(account.input.region, VERTEX_REGION);
  assert.equal(account.input.purpose, VERTEX_PURPOSE);
  assert.equal(account.input.supplyMode, undefined);
  assert.equal(account.input.rightsId, 'vertex-rights-1');
  assert.equal(account.input.displayName, 'Vertex vertex-sa@test.iam.gserviceaccount.com');
  assert.equal(credential.kind, 'credential');
  assert.equal(credential.input.accountId, 'account-uuid-1');
  assert.ok(credential.input.secret instanceof Uint8Array);
  // The credential_type binding agrees at all three sites.
  assert.equal(VERTEX_SUPPLY_MODE, 'platform');
  assert.equal(VERTEX_CREDENTIAL_TYPE, 'service_account');
});

test('supply write failures surface SUPPLY_WRITE_FAILED, never raw errors', async () => {
  const sink = createProviderSupplyVertexCredentialSink({
    supply: {
      async createPlatformProviderAccount() {
        throw new Error('db exploded');
      },
      async createPlatformProviderCredential() {
        throw new Error('unreachable');
      },
    },
    resolveCatalogBinding: async () => ({
      rightsId: 'r',
      rightsVersion: 1,
      capabilities: [{ model: 'm', endpoint: VERTEX_ENDPOINT, version: 1 }],
    }),
  });
  await assert.rejects(
    sink.accept({ actorUserId: 'operator-1', imported: importedInput() }),
    (error: unknown) => error instanceof VertexCredentialSinkError && error.code === 'SUPPLY_WRITE_FAILED',
  );
});
