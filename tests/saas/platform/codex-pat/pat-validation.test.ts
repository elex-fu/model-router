import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCanonicalIdentity } from '../../../../src/saas/gateway/codex/identity.js';
import {
  buildCodexPatWhoamiRequest,
  CODEX_PAT_WHOAMI_MAX_RESPONSE_BYTES,
  CODEX_PAT_WHOAMI_URL,
  isCodexPatShape,
  parseCodexPatWhoamiResponse,
} from '../../../../src/saas/platform/codex-pat/pat-validation.js';

const PAT = 'at-unit-test-token-123';

function whoamiBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'user@example.com',
    chatgpt_user_id: 'user-1',
    chatgpt_account_id: 'acct-123',
    chatgpt_plan_type: 'pro',
    chatgpt_account_is_fedramp: false,
    ...overrides,
  };
}

test('the whoami endpoint is the fixed credential-plane auth.openai.com URL', () => {
  assert.equal(CODEX_PAT_WHOAMI_URL, 'https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami');
  assert.ok(CODEX_PAT_WHOAMI_MAX_RESPONSE_BYTES > 0);
});

test('isCodexPatShape accepts at- tokens with a printable body and rejects everything else', () => {
  for (const token of ['at-123', 'at-abc_DEF.xyz-456', `at-${'a'.repeat(4_092)}`]) {
    assert.equal(isCodexPatShape(token), true, `expected ${token.slice(0, 12)} to be a PAT shape`);
  }
  for (const token of [
    '',
    'at',
    'at-',
    'atx-token',
    'sk-token',
    'at-space token',
    'at-tab\ttoken',
    'at-ünicode',
    'at-"quoted"',
    `at-${'a'.repeat(4_094)}`,
  ]) {
    assert.equal(isCodexPatShape(token), false, `expected ${JSON.stringify(token.slice(0, 12))} to be rejected`);
  }
  assert.equal(isCodexPatShape(null), false);
  assert.equal(isCodexPatShape(undefined), false);
  assert.equal(isCodexPatShape(123), false);
  assert.equal(isCodexPatShape({}), false);
});

test('buildCodexPatWhoamiRequest stamps the sub2api credential-plane header set', () => {
  const request = buildCodexPatWhoamiRequest({ pat: PAT });
  if (request === null) throw new Error('expected a request');
  assert.equal(request.url, CODEX_PAT_WHOAMI_URL);
  assert.equal(request.method, 'GET');
  const identity = buildCanonicalIdentity();
  assert.deepEqual(request.headers, {
    authorization: `Bearer ${PAT}`,
    accept: 'application/json',
    'user-agent': identity.userAgent,
    originator: identity.originator,
  });
  // The credential-plane request deliberately omits the inference-plane
  // headers: no version, no openai-beta, no chatgpt-account-id (the whoami
  // endpoint resolves the account itself), no content-type (GET, no body).
  for (const header of ['version', 'openai-beta', 'chatgpt-account-id', 'content-type']) {
    assert.equal(
      Object.hasOwn(request.headers, header),
      false,
      `the whoami request must not carry the ${header} header`,
    );
  }
});

test('buildCodexPatWhoamiRequest fails closed on a non-PAT token', () => {
  for (const pat of ['', 'oauth-style-token', 'at-with space', 'at\ttab']) {
    assert.equal(buildCodexPatWhoamiRequest({ pat }), null, `expected ${JSON.stringify(pat)} to be rejected`);
  }
  assert.equal(buildCodexPatWhoamiRequest({ pat: 'at-ok' }) === null, false);
});

test('parseCodexPatWhoamiResponse resolves the complete identity', () => {
  const identity = parseCodexPatWhoamiResponse(
    whoamiBody({
      email: ' user@example.com ',
      chatgpt_account_id: ' acct-123 ',
      chatgpt_account_is_fedramp: true,
      expires_at: '2027-01-01T00:00:00.000Z',
    }),
  );
  assert.deepEqual(identity, {
    chatgptAccountId: 'acct-123',
    chatgptUserId: 'user-1',
    email: 'user@example.com',
    planType: 'pro',
    accountIsFedramp: true,
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
});

test('parseCodexPatWhoamiResponse reports no expiry when the endpoint sends none', () => {
  const identity = parseCodexPatWhoamiResponse(whoamiBody());
  if (identity === null) throw new Error('expected an identity');
  assert.equal(identity.expiresAt, null);
  assert.equal(identity.accountIsFedramp, false);
});

test('parseCodexPatWhoamiResponse rejects malformed bodies', () => {
  for (const body of [
    null,
    'string',
    42,
    [],
    {},
    whoamiBody({ email: '' }),
    whoamiBody({ chatgpt_account_id: '' }),
    whoamiBody({ chatgpt_user_id: '  ' }),
    whoamiBody({ chatgpt_plan_type: null }),
    whoamiBody({ chatgpt_account_is_fedramp: 'false' }),
    { ...whoamiBody(), chatgpt_account_is_fedramp: undefined },
    whoamiBody({ expires_at: 'not-a-timestamp' }),
    whoamiBody({ expires_at: 42 }),
  ]) {
    assert.equal(
      parseCodexPatWhoamiResponse(body),
      null,
      `expected ${JSON.stringify(body).slice(0, 80)} to be rejected`,
    );
  }
});
