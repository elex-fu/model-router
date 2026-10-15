import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bestClaudeCodeSimilarityScore,
  CLAUDE_CODE_SYSTEM_PROMPT_THRESHOLD,
  CLAUDE_CODE_UA_PATTERN,
  diceCoefficient,
  hasClaudeCodeSystemPrompt,
  normalizePromptText,
  validateClaudeCodeClient,
} from '../../../../src/saas/gateway/claude/claude-code-validator.js';

const MESSAGES_PATH = '/v1/messages';
const BASE_HEADERS = {
  'user-agent': 'claude-cli/2.1.258',
  'x-app': 'cli',
  'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
  'anthropic-version': '2023-06-01',
};

function claudeCodeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    metadata: { user_id: 'user_acct_session' },
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

test('the UA regex accepts only official CLI shapes', () => {
  for (const good of ['claude-cli/2.1.258', 'claude-cli/0.1.0', 'Claude-CLI/2.1.258 (extra)']) {
    assert.ok(CLAUDE_CODE_UA_PATTERN.test(good), good);
  }
  for (const bad of ['opencode/1.0', 'claude-cli/2.1', 'claude-cli/v2.1.258', 'axios/1.13.6', '']) {
    assert.equal(CLAUDE_CODE_UA_PATTERN.test(bad), false, bad);
  }
});

test('Dice similarity and prompt normalization behave like the reference', () => {
  assert.equal(diceCoefficient('night', 'night'), 1.0);
  assert.equal(diceCoefficient('a', 'b'), 0.0);
  assert.ok(diceCoefficient('abcde', 'abcd') > 0.7);
  assert.equal(normalizePromptText('  a \n\t b  c '), 'a b c');
  // The exact official prompt scores 1.0; unrelated prose stays below 0.5.
  assert.equal(bestClaudeCodeSimilarityScore("You are Claude Code, Anthropic's official CLI for Claude."), 1.0);
  // Clearly unrelated prose stays below the threshold. (A short generic
  // assistant sentence can legitimately approach the compact template's
  // score — the reference behaves the way.)
  assert.ok(
    bestClaudeCodeSimilarityScore('Describe the migration patterns of Arctic terns.') <
      CLAUDE_CODE_SYSTEM_PROMPT_THRESHOLD,
  );
  // Near-misses with light edits still pass the threshold.
  assert.ok(
    bestClaudeCodeSimilarityScore(`${"You are Claude Code, Anthropic's official CLI for Claude."} plus more context`) >=
      CLAUDE_CODE_SYSTEM_PROMPT_THRESHOLD,
  );
});

test('genuine Claude Code /v1/messages traffic validates', () => {
  const result = validateClaudeCodeClient({
    userAgent: 'claude-cli/2.1.258',
    path: MESSAGES_PATH,
    headers: BASE_HEADERS,
    body: claudeCodeBody(),
  });
  assert.deepEqual(result, { valid: true, reason: null });
});

test('a third-party UA is rejected before anything else is inspected', () => {
  for (const userAgent of ['opencode/1.0', '', 'claude-cli/2.1']) {
    const result = validateClaudeCodeClient({
      userAgent,
      path: MESSAGES_PATH,
      headers: BASE_HEADERS,
      body: claudeCodeBody(),
    });
    assert.deepEqual(result, { valid: false, reason: 'ua-mismatch' });
  }
});

test('non-messages paths and count_tokens pass on the UA alone', () => {
  for (const path of ['/v1/models', '/api/hello', '/v1/messages/count_tokens']) {
    const result = validateClaudeCodeClient({
      userAgent: 'claude-cli/2.1.258',
      path,
      headers: {},
      body: {},
    });
    assert.deepEqual(result, { valid: true, reason: null }, path);
  }
});

test('max_tokens=1 connectivity probes pass without a system prompt', () => {
  const result = validateClaudeCodeClient({
    userAgent: 'claude-cli/2.1.258',
    path: MESSAGES_PATH,
    headers: BASE_HEADERS,
    body: { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [] },
  });
  assert.deepEqual(result, { valid: true, reason: null });
});

test('messages traffic without a Claude Code system prompt is rejected', () => {
  const result = validateClaudeCodeClient({
    userAgent: 'claude-cli/2.1.258',
    path: MESSAGES_PATH,
    headers: BASE_HEADERS,
    body: claudeCodeBody({ system: [{ type: 'text', text: 'You are a cooking assistant.' }] }),
  });
  assert.deepEqual(result, { valid: false, reason: 'system-prompt-mismatch' });
  // A billing attribution block identifies the CLI even without identity prose.
  const billing = validateClaudeCodeClient({
    userAgent: 'claude-cli/2.1.258',
    path: MESSAGES_PATH,
    headers: BASE_HEADERS,
    body: claudeCodeBody({
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.258.abc; cc_entrypoint=cli;' }],
    }),
  });
  assert.deepEqual(billing, { valid: true, reason: null });
  // The prefix alone (no entrypoint marker) does not.
  const prefixOnly = validateClaudeCodeClient({
    userAgent: 'claude-cli/2.1.258',
    path: MESSAGES_PATH,
    headers: BASE_HEADERS,
    body: claudeCodeBody({
      system: [{ type: 'text', text: 'x-anthropic-billing-header: forged' }],
    }),
  });
  assert.deepEqual(prefixOnly, { valid: false, reason: 'system-prompt-mismatch' });
});

test('missing required headers or metadata.user_id fail with specific reasons', () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ ...BASE_HEADERS, 'x-app': '' }, 'missing-x-app'],
    [{ ...BASE_HEADERS, 'anthropic-beta': '' }, 'missing-anthropic-beta'],
    [{ ...BASE_HEADERS, 'anthropic-version': '' }, 'missing-anthropic-version'],
  ];
  for (const [headers, reason] of cases) {
    const result = validateClaudeCodeClient({
      userAgent: 'claude-cli/2.1.258',
      path: MESSAGES_PATH,
      headers,
      body: claudeCodeBody(),
    });
    assert.deepEqual(result, { valid: false, reason }, reason);
  }
  for (const body of [
    claudeCodeBody({ metadata: {} }),
    claudeCodeBody({ metadata: { user_id: '' } }),
    claudeCodeBody({ metadata: undefined }),
  ]) {
    const result = validateClaudeCodeClient({
      userAgent: 'claude-cli/2.1.258',
      path: MESSAGES_PATH,
      headers: BASE_HEADERS,
      body,
    });
    assert.deepEqual(result, { valid: false, reason: 'missing-metadata-user-id' });
  }
});

test('hasClaudeCodeSystemPrompt requires a string model and a system array', () => {
  assert.equal(hasClaudeCodeSystemPrompt({ model: 'm', system: 'string form' }), false);
  assert.equal(
    hasClaudeCodeSystemPrompt({
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    }),
    false,
  );
  assert.equal(hasClaudeCodeSystemPrompt(null), false);
  assert.equal(hasClaudeCodeSystemPrompt({ model: 'm' }), false);
});
