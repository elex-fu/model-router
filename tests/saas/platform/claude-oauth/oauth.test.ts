import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildAuthorizeUrl,
  CLAUDE_OAUTH_AUTH_SCOPES,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_OAUTH_TOKEN_USER_AGENT,
  CLAUDE_ORGANIZATIONS_ENDPOINT,
  ClaudeOAuthError,
  createPkcePair,
  parseClaudeOrganizations,
  resolveClaudeOrganizationUuid,
  selectClaudeOrganization,
} from '../../../../src/saas/platform/claude-oauth/oauth.js';

test('the OAuth constants match the plan §R5 black-box capture', () => {
  assert.equal(CLAUDE_OAUTH_CLIENT_ID, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(CLAUDE_OAUTH_TOKEN_ENDPOINT, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(CLAUDE_OAUTH_REDIRECT_URI, 'https://platform.claude.com/oauth/code/callback');
  assert.equal(CLAUDE_OAUTH_TOKEN_USER_AGENT, 'axios/1.13.6');
  assert.ok(CLAUDE_OAUTH_AUTH_SCOPES.includes('user:inference'));
});

test('the PKCE pair uses the Claude CLI 43-char base64url verifier shape', () => {
  const pair = createPkcePair();
  assert.match(pair.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  // S256: base64url(SHA-256(verifier)), pinned against node:crypto directly.
  const expected = createHash('sha256').update(pair.codeVerifier, 'utf8').digest('base64url');
  assert.equal(pair.codeChallenge, expected);
});

test('the authorize URL carries PKCE S256 and the browser scope tier', () => {
  const url = buildAuthorizeUrl({ state: 'a'.repeat(64), codeChallenge: 'b'.repeat(43) });
  assert.equal(url.origin + url.pathname, 'https://claude.com/cai/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), CLAUDE_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), CLAUDE_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), CLAUDE_OAUTH_AUTH_SCOPES);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // Invalid state/challenge shapes fail closed.
  assert.throws(() => buildAuthorizeUrl({ state: 'short', codeChallenge: 'b'.repeat(43) }), ClaudeOAuthError);
  assert.throws(() => buildAuthorizeUrl({ state: 'a'.repeat(64), codeChallenge: 'too-short' }), ClaudeOAuthError);
});

test('organization selection prefers a team org, else single/first', () => {
  const personal = parseClaudeOrganizations([{ uuid: 'org-1', name: 'Personal' }]);
  assert.equal(selectClaudeOrganization(personal)?.uuid, 'org-1');
  const multi = parseClaudeOrganizations([
    { uuid: 'org-personal', name: 'Personal' },
    { uuid: 'org-team', name: 'Team', raven_type: 'team' },
  ]);
  assert.equal(selectClaudeOrganization(multi)?.uuid, 'org-team');
  const noTeam = parseClaudeOrganizations([{ uuid: 'a', raven_type: 'personal' }, { uuid: 'b' }]);
  assert.equal(selectClaudeOrganization(noTeam)?.uuid, 'a');
  assert.equal(selectClaudeOrganization([]), null);
  // Malformed entries are dropped, not guessed.
  assert.equal(parseClaudeOrganizations([{ name: 'no uuid' }, 42, null, { uuid: 'ok' }]).length, 1);
});

test('organization resolution sends the sessionKey cookie and fails closed', async () => {
  const seen: Array<{ url: string; cookie: string | null }> = [];
  const uuid = await resolveClaudeOrganizationUuid('session-key-1', async (url, init) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ url: url.href, cookie: headers.cookie ?? null });
    return new Response(JSON.stringify([{ uuid: 'org-resolved', name: 'Team', raven_type: 'team' }]), {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(uuid, 'org-resolved');
  assert.equal(seen[0].url, CLAUDE_ORGANIZATIONS_ENDPOINT);
  assert.equal(seen[0].cookie, 'sessionKey=session-key-1');

  for (const response of [
    new Response('forbidden', { status: 403 }),
    new Response('not json', { status: 200 }),
    new Response(JSON.stringify([]), { status: 200 }),
  ]) {
    await assert.rejects(
      resolveClaudeOrganizationUuid('session-key-1', async () => response),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeOAuthError);
        assert.equal(error.code, 'ORGANIZATION_RESOLUTION_FAILED');
        return true;
      },
    );
  }
  await assert.rejects(
    resolveClaudeOrganizationUuid('', async () => new Response('[]')),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeOAuthError);
      return true;
    },
  );
});
