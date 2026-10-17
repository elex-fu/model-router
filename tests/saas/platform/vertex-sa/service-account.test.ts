import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { VERTEX_TOKEN_URL } from '../../../../src/saas/gateway/vertex/constants.js';
import {
  buildVertexSaEnvelopeMaterial,
  parseVertexServiceAccountJson,
  VertexServiceAccountParseError,
  vertexServiceAccountKeyFromEnvelopeMaterial,
  vertexUpstreamCredentialFromMaterial,
} from '../../../../src/saas/platform/vertex-sa/service-account.js';

// Test key material is generated at runtime — never a source literal (the
// repo secret-scanning rules reject embedded PEM blocks).
function testKey(): { readonly pem: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

function saJson(input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'proj-1',
    private_key_id: 'key-id-1',
    private_key: testKey().pem,
    client_email: 'sa@test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...input,
  });
}

test('a well-formed service account JSON parses into the exchange key', () => {
  const key = parseVertexServiceAccountJson(saJson({}));
  assert.equal(key.clientEmail, 'sa@test.iam.gserviceaccount.com');
  assert.equal(key.projectId, 'proj-1');
  assert.equal(key.privateKeyId, 'key-id-1');
  assert.equal(key.tokenUri, VERTEX_TOKEN_URL);
  assert.ok(key.privateKey.startsWith('-----BEGIN PRIVATE KEY-----'));
});

test('the token_uri is ALWAYS overridden with the pinned Google endpoint (SSRF guard)', () => {
  // sub2api vertex_service_account.go L131: a crafted token_uri must never
  // steer the exchange at an attacker-chosen host.
  for (const crafted of [
    'https://evil.example.com/token',
    'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    '',
  ]) {
    const key = parseVertexServiceAccountJson(saJson({ token_uri: crafted }));
    assert.equal(key.tokenUri, VERTEX_TOKEN_URL);
  }
});

test('missing required fields fail closed with the specific error code', () => {
  assert.throws(
    () => parseVertexServiceAccountJson(saJson({ client_email: '' })),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MISSING_CLIENT_EMAIL',
  );
  assert.throws(
    () => parseVertexServiceAccountJson(saJson({ private_key: '' })),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MISSING_PRIVATE_KEY',
  );
  assert.throws(
    () => parseVertexServiceAccountJson(saJson({ project_id: '  ' })),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MISSING_PROJECT_ID',
  );
  assert.throws(
    () => parseVertexServiceAccountJson('not json'),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MALFORMED_JSON',
  );
  assert.throws(
    () => parseVertexServiceAccountJson('[]'),
    (error: unknown) => error instanceof VertexServiceAccountParseError && error.code === 'MALFORMED_JSON',
  );
  // A private_key_id is optional.
  const noKid = parseVertexServiceAccountJson(saJson({ private_key_id: '' }));
  assert.equal(noKid.privateKeyId, null);
});

test('the nested-object envelope form is accepted (sub2api precedence)', () => {
  const key = vertexServiceAccountKeyFromEnvelopeMaterial({
    service_account_json: {
      type: 'service_account',
      project_id: 'proj-1',
      private_key: testKey().pem,
      client_email: 'sa@test.iam.gserviceaccount.com',
      token_uri: 'https://evil.example.com/token',
    },
  });
  assert.equal(key.projectId, 'proj-1');
  assert.equal(key.tokenUri, VERTEX_TOKEN_URL);
  const legacy = vertexServiceAccountKeyFromEnvelopeMaterial({
    service_account: { project_id: 'p', private_key: 'k', client_email: 'e@t' },
  });
  assert.equal(legacy.projectId, 'p');
  // A nested object form as raw JSON text parses too.
  const asText = vertexServiceAccountKeyFromEnvelopeMaterial({
    service_account_json: JSON.stringify({ project_id: 'p2', private_key: 'k', client_email: 'e2@t' }),
  });
  assert.equal(asText.projectId, 'p2');
});

test('envelope material round-trips through the key parser and the credential view', () => {
  const parsed = parseVertexServiceAccountJson(saJson({}));
  const material = buildVertexSaEnvelopeMaterial(parsed, {
    location: 'europe-west1',
    vertexModelLocations: { 'gemini-2.5-pro': 'asia-east1' },
    accessToken: 'tok-1',
    expiresAtMs: 1_700_000_000_000,
  });
  assert.equal(material.type, 'service_account');
  assert.equal(material.location, 'europe-west1');
  assert.equal(material.access_token, 'tok-1');
  // The flat material form parses back into the same key.
  const roundTrip = vertexServiceAccountKeyFromEnvelopeMaterial(material as Record<string, unknown>);
  assert.equal(roundTrip.clientEmail, parsed.clientEmail);
  assert.equal(roundTrip.projectId, parsed.projectId);
  // The transport-facing credential view reads the token + facts.
  assert.deepEqual(vertexUpstreamCredentialFromMaterial(material as Record<string, unknown>), {
    accessToken: 'tok-1',
    projectId: 'proj-1',
    location: 'europe-west1',
    vertexModelLocations: { 'gemini-2.5-pro': 'asia-east1' },
    expiresAtMs: 1_700_000_000_000,
  });
  // No access token yet → null (the caller routes through the refresher).
  const bare = buildVertexSaEnvelopeMaterial(parsed);
  assert.equal(vertexUpstreamCredentialFromMaterial(bare as Record<string, unknown>), null);
  // A string-form service_account_json inside the material also parses.
  const withNestedJson = {
    service_account_json: saJson({}),
    access_token: 'tok-2',
  } as Record<string, unknown>;
  const nested = vertexServiceAccountKeyFromEnvelopeMaterial(withNestedJson);
  assert.equal(nested.projectId, 'proj-1');
  // No service account anywhere fails closed.
  assert.throws(
    () => vertexServiceAccountKeyFromEnvelopeMaterial({ access_token: 'x' } as Record<string, unknown>),
    VertexServiceAccountParseError,
  );
});

test('an imported material without a location carries none', () => {
  const parsed = parseVertexServiceAccountJson(saJson({}));
  const material = buildVertexSaEnvelopeMaterial(parsed);
  assert.equal('location' in material, false);
  assert.equal('vertex_model_locations' in material, false);
  assert.equal('access_token' in material, false);
});
