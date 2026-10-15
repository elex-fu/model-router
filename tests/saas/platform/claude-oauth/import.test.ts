import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaudeCredentialsJson } from '../../../../src/saas/platform/claude-oauth/import.js';
import { ClaudeOAuthError } from '../../../../src/saas/platform/claude-oauth/oauth.js';

function credentialsJson(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

test('a well-formed ~/.claude/.credentials.json parses into the binding envelope shape', () => {
  const envelope = parseClaudeCredentialsJson(
    credentialsJson({
      accessToken: 'accs-cli',
      refreshToken: 'rfrsh-cli',
      expiresAt: 1_760_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      organizationUuid: 'org-99',
    }),
  );
  assert.deepEqual(envelope, {
    accessToken: 'accs-cli',
    refreshToken: 'rfrsh-cli',
    expiresAt: new Date(1_760_000_000_000).toISOString(),
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    organizationUuid: 'org-99',
    accountUuid: null,
    email: null,
  });
});

test('snake_case spellings and the expireAt alias are accepted leniently', () => {
  const envelope = parseClaudeCredentialsJson(
    credentialsJson({
      access_token: 'accs-cli',
      refresh_token: 'rfrsh-cli',
      expireAt: 1_760_000_000_000,
      organization_uuid: 'org-1',
      account_uuid: 'acct-1',
      email_address: 'operator@example.test',
    }),
  );
  assert.equal(envelope.accessToken, 'accs-cli');
  assert.equal(envelope.refreshToken, 'rfrsh-cli');
  assert.equal(envelope.expiresAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(envelope.organizationUuid, 'org-1');
  assert.equal(envelope.accountUuid, 'acct-1');
  assert.equal(envelope.email, 'operator@example.test');
  // No expiry at all is fine: the refresh token is the credential.
  const noExpiry = parseClaudeCredentialsJson(
    credentialsJson({ accessToken: 'a', refreshToken: 'r', organizationUuid: 'org-1' }),
  );
  assert.equal(noExpiry.expiresAt, null);
});

test('imports without a refresh token or organization fail closed', () => {
  for (const bad of [
    '',
    'not json',
    '[]',
    '{}',
    JSON.stringify({ claudeAiOauth: null }),
    JSON.stringify({ claudeAiOauth: 'text' }),
    credentialsJson({ accessToken: 'a' }),
    credentialsJson({ refreshToken: 'r' }),
    credentialsJson({ accessToken: 'a', refreshToken: 'r' }),
    credentialsJson({ accessToken: 'a', refreshToken: 'r', organizationUuid: '' }),
    credentialsJson({ accessToken: 'a', refreshToken: 'r', organizationUuid: 'org-1', expiresAt: 'not-a-number' }),
  ]) {
    assert.throws(
      () => parseClaudeCredentialsJson(bad),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeOAuthError, bad);
        assert.equal(error.code, 'CREDENTIALS_JSON_INVALID');
        return true;
      },
      bad,
    );
  }
});
