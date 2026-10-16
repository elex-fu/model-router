import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGeminiCredentialsJson } from '../../../../src/saas/platform/gemini-oauth/import.js';
import { GeminiOAuthError } from '../../../../src/saas/platform/gemini-oauth/oauth.js';

test('a well-formed ~/.gemini/oauth_creds.json parses into the binding envelope shape', () => {
  const envelope = parseGeminiCredentialsJson(
    JSON.stringify({
      access_token: 'accs-cli',
      refresh_token: 'rfrsh-cli',
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      id_token: 'jwt-shaped-id-token',
      expiry_date: 1_760_000_000_000,
      project_id: 'project-99',
    }),
  );
  assert.deepEqual(envelope, {
    accessToken: 'accs-cli',
    refreshToken: 'rfrsh-cli',
    expiresAt: new Date(1_760_000_000_000).toISOString(),
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    projectId: 'project-99',
    tierId: null,
    email: null,
  });
});

test('camelCase spellings, tier ids and emails are accepted leniently', () => {
  const envelope = parseGeminiCredentialsJson(
    JSON.stringify({
      accessToken: 'accs-cli',
      refreshToken: 'rfrsh-cli',
      expiryDate: 1_760_000_000_000,
      projectId: 'project-1',
      tierId: 'LEGACY',
      email: 'operator@example.test',
    }),
  );
  assert.equal(envelope.accessToken, 'accs-cli');
  assert.equal(envelope.refreshToken, 'rfrsh-cli');
  assert.equal(envelope.expiresAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(envelope.projectId, 'project-1');
  // Legacy tier spellings normalize onto the canonical quota-tier ids.
  assert.equal(envelope.tierId, 'gcp_standard');
  assert.equal(envelope.email, 'operator@example.test');
  // A canonical tier id survives as-is; an unknown one normalizes to null.
  assert.equal(
    parseGeminiCredentialsJson(
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', project_id: 'p', tier_id: 'google_ai_pro' }),
    ).tierId,
    'google_ai_pro',
  );
  assert.equal(
    parseGeminiCredentialsJson(
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', project_id: 'p', tier_id: 'not-a-known-tier' }),
    ).tierId,
    null,
  );
  // No expiry at all is fine: the refresh token is the credential.
  const noExpiry = parseGeminiCredentialsJson(JSON.stringify({ accessToken: 'a', refreshToken: 'r', project_id: 'p' }));
  assert.equal(noExpiry.expiresAt, null);
  assert.equal(noExpiry.tierId, null);
});

test('imports without a refresh token or project fail closed', () => {
  for (const bad of [
    '',
    'not json',
    '[]',
    '{}',
    JSON.stringify({ access_token: 'a' }),
    JSON.stringify({ refresh_token: 'r' }),
    JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    JSON.stringify({ access_token: 'a', refresh_token: 'r', project_id: '' }),
    JSON.stringify({ access_token: 'a', refresh_token: 'r', project_id: 'p', expiry_date: 'not-a-number' }),
    JSON.stringify({ access_token: 'a', refresh_token: 'r', project_id: 'p', expiry_date: 0 }),
    JSON.stringify({ access_token: 'a', refresh_token: 'r', project_id: 'p', expiry_date: 1.5 }),
  ]) {
    assert.throws(
      () => parseGeminiCredentialsJson(bad),
      (error: unknown) => {
        assert.ok(error instanceof GeminiOAuthError, bad);
        assert.equal(error.code, 'CREDENTIALS_JSON_INVALID');
        return true;
      },
      bad,
    );
  }
});

test('oversized payloads fail closed before parsing', () => {
  assert.throws(
    () => parseGeminiCredentialsJson(`x`.repeat(65_537)),
    (error: unknown) => {
      assert.ok(error instanceof GeminiOAuthError);
      assert.equal(error.code, 'CREDENTIALS_JSON_INVALID');
      return true;
    },
  );
});
