import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CLI_BASELINE_VERSION,
  CLAUDE_CODE_MIMICRY_BETA_HEADER,
  CLAUDE_CODE_MIMICRY_BETAS,
  CLAUDE_MODEL_ID_OVERRIDES,
  CLAUDE_SERVER_SIDE_FALLBACK_BETAS,
  CLAUDE_STAINLESS_HEADERS,
} from '../../../../src/saas/gateway/claude/constants.js';
import {
  buildClaudeUserAgent,
  ClaudeIdentityError,
  claudeAccountIdentityNamespace,
  isSupportedClaudeCliVersion,
  resolveClaudeCliVersion,
  resolveClaudeCliVersionFromEnv,
} from '../../../../src/saas/gateway/claude/identity.js';

test('the ordered mimicry beta set matches the plan §R5 black-box capture', () => {
  assert.deepEqual(CLAUDE_CODE_MIMICRY_BETAS, [
    'oauth-2025-04-20',
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'fine-grained-tool-streaming-2025-05-14',
    'token-counting-2024-11-01',
    'context-1m-2025-08-07',
    'prompt-caching-scope-2026-01-05',
    'effort-2025-11-24',
    'context-management-2025-06-27',
    'extended-cache-ttl-2025-04-11',
  ]);
  // The joined header preserves the captured order exactly.
  assert.equal(CLAUDE_CODE_MIMICRY_BETA_HEADER, CLAUDE_CODE_MIMICRY_BETAS.join(','));
  // The server-side fallback family is never part of the auto-added set.
  for (const beta of CLAUDE_SERVER_SIDE_FALLBACK_BETAS) {
    assert.equal(CLAUDE_CODE_MIMICRY_BETAS.includes(beta), false);
  }
});

test('the stainless header family matches the captured client', () => {
  assert.deepEqual(CLAUDE_STAINLESS_HEADERS, {
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.94.0',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'arm64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v24.3.0',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
  });
});

test('model id date-suffix mapping covers the three alias families', () => {
  assert.deepEqual(CLAUDE_MODEL_ID_OVERRIDES, {
    'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
    'claude-opus-4-5': 'claude-opus-4-5-20251101',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  });
});

test('CLI version resolution: empty falls back, valid upward overrides win, invalid falls back', () => {
  assert.equal(resolveClaudeCliVersion(undefined), CLAUDE_CLI_BASELINE_VERSION);
  assert.equal(resolveClaudeCliVersion(''), CLAUDE_CLI_BASELINE_VERSION);
  assert.equal(resolveClaudeCliVersion('   '), CLAUDE_CLI_BASELINE_VERSION);
  assert.equal(resolveClaudeCliVersion('2.9.0'), '2.9.0');
  // Prerelease/build suffixes, two-part versions and downward overrides are
  // all rejected (a bad pin would poison the persistent fingerprint).
  for (const invalid of ['2.1.258-local', '2.1', 'v2.1.258', '2.1.257', 'abc', '2.1.258+build']) {
    assert.equal(isSupportedClaudeCliVersion(invalid), false, invalid);
    assert.equal(resolveClaudeCliVersion(invalid), CLAUDE_CLI_BASELINE_VERSION, invalid);
  }
  assert.equal(isSupportedClaudeCliVersion('2.1.258'), true);
  assert.equal(resolveClaudeCliVersionFromEnv({}), CLAUDE_CLI_BASELINE_VERSION);
  assert.equal(resolveClaudeCliVersionFromEnv({ MODEL_ROUTER_CLAUDE_CLI_VERSION: '3.0.1' }), '3.0.1');
  assert.equal(
    resolveClaudeCliVersionFromEnv({ MODEL_ROUTER_CLAUDE_CLI_VERSION: '1.0.0' }),
    CLAUDE_CLI_BASELINE_VERSION,
  );
});

test('the UA is claude-cli/{version} and the namespace pins account coordinates', () => {
  assert.equal(buildClaudeUserAgent('2.1.258'), 'claude-cli/2.1.258');
  assert.throws(() => buildClaudeUserAgent('not-a-version'), ClaudeIdentityError);
  assert.equal(
    claudeAccountIdentityNamespace({ organizationUuid: 'org-1', accountUuid: 'acct-1' }),
    'claude:org-1:account:acct-1',
  );
  assert.throws(() => claudeAccountIdentityNamespace({ organizationUuid: '', accountUuid: 'acct-1' }));
  assert.throws(() => claudeAccountIdentityNamespace({ organizationUuid: 'org-1', accountUuid: '' }));
});
