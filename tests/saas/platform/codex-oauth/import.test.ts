import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodexAuthJson } from '../../../../src/saas/platform/codex-oauth/import.js';
import { CODEX_OAUTH_CLIENT_ID, CodexOAuthError } from '../../../../src/saas/platform/codex-oauth/oauth.js';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Runtime-assembled fake id_token; the exp is far in the past on purpose. */
function staleIdToken(): string {
  const payload = {
    exp: Math.floor((Date.now() - 86_400_000) / 1000),
    email: 'operator@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-9090',
      chatgpt_user_id: 'user-1122',
      plan_type: 'plus',
    },
  };
  return `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(payload)}.sig`;
}

test('a Codex CLI auth.json converts to the binding envelope', () => {
  const authJson = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: staleIdToken(),
      access_token: 'accs-cli-token',
      refresh_token: 'rfrsh-cli-token',
      account_id: 'acct-9090',
    },
    last_refresh: '2026-10-01T12:00:00.000Z',
  });
  const envelope = parseCodexAuthJson(authJson);
  assert.equal(envelope.accessToken, 'accs-cli-token');
  assert.equal(envelope.refreshToken, 'rfrsh-cli-token');
  assert.equal(envelope.idToken, envelope.idToken); // present (stale but kept)
  assert.ok(envelope.idToken);
  assert.equal(envelope.expiresAt, null);
  assert.equal(envelope.clientId, CODEX_OAUTH_CLIENT_ID);
  // The stale id_token still enriches: freshness is not required for imports.
  assert.equal(envelope.email, 'operator@example.test');
  assert.equal(envelope.chatgptAccountId, 'acct-9090');
  assert.equal(envelope.chatgptUserId, 'user-1122');
  assert.equal(envelope.planType, 'plus');
});

test('auth.json without an id_token still imports with the required fields only', () => {
  const envelope = parseCodexAuthJson(
    JSON.stringify({
      tokens: { access_token: 'accs-cli-token', refresh_token: 'rfrsh-cli-token', account_id: 'acct-9090' },
    }),
  );
  assert.equal(envelope.accessToken, 'accs-cli-token');
  assert.equal(envelope.refreshToken, 'rfrsh-cli-token');
  assert.equal(envelope.idToken, null);
  assert.equal(envelope.chatgptAccountId, 'acct-9090');
  assert.equal(envelope.email, null);
  assert.equal(envelope.chatgptUserId, null);
  assert.equal(envelope.planType, null);
});

test('a contradictory id_token account id is a hard rejection', () => {
  assert.throws(
    () =>
      parseCodexAuthJson(
        JSON.stringify({
          tokens: {
            id_token: staleIdToken(),
            access_token: 'accs-cli-token',
            refresh_token: 'rfrsh-cli-token',
            account_id: 'acct-different',
          },
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof CodexOAuthError);
      assert.equal(error.code, 'AUTH_JSON_INVALID');
      return true;
    },
  );
});

test('missing or malformed required fields fail closed', () => {
  const cases: Array<{ name: string; text: string }> = [
    { name: 'not json', text: 'nope' },
    { name: 'json array', text: '[]' },
    { name: 'no tokens object', text: JSON.stringify({ OPENAI_API_KEY: null }) },
    { name: 'tokens is a string', text: JSON.stringify({ tokens: 'x' }) },
    {
      name: 'missing access token',
      text: JSON.stringify({ tokens: { refresh_token: 'rfrsh-cli-token', account_id: 'a' } }),
    },
    {
      name: 'missing refresh token',
      text: JSON.stringify({ tokens: { access_token: 'accs-cli-token', account_id: 'a' } }),
    },
    {
      name: 'missing account id',
      text: JSON.stringify({ tokens: { access_token: 'accs-cli-token', refresh_token: 'rfrsh-cli-token' } }),
    },
    {
      name: 'blank account id',
      text: JSON.stringify({
        tokens: { access_token: 'accs-cli-token', refresh_token: 'rfrsh-cli-token', account_id: ' ' },
      }),
    },
  ];
  for (const { name, text } of cases) {
    assert.throws(
      () => parseCodexAuthJson(text),
      (error: unknown) => {
        assert.ok(error instanceof CodexOAuthError, `${name}: expected CodexOAuthError`);
        assert.equal(error.code, 'AUTH_JSON_INVALID');
        return true;
      },
      name,
    );
  }
});
