import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  DEFAULT_OPENCODE_ZEN_PROTOCOL_RULES,
  MAX_OPENCODE_GO_PROTOCOL_PATTERN_LENGTH,
  MAX_OPENCODE_GO_PROTOCOL_RULES,
  OPENCODE_GO_DEFAULT_PROTOCOL,
  openCodeGoPatternMatches,
  openCodeGoProviderOperationForProtocol,
  resolveOpenCodeGoProtocol,
  resolveOpenCodeGoProtocolRulesFromConfig,
  validateOpenCodeGoProtocolRules,
} from '../../../../src/saas/gateway/opencode-go/protocol-rules.js';

test('default protocol rule table matches the sub2api Go reference table', () => {
  assert.deepEqual(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, [
    { pattern: 'grok-*', protocol: 'responses' },
    { pattern: 'gpt-*', protocol: 'responses' },
    { pattern: 'muse-spark-*', protocol: 'responses' },
    { pattern: 'minimax-*', protocol: 'anthropic' },
    { pattern: 'qwen*', protocol: 'anthropic' },
  ]);
});

test('default Zen rule table is the sub2api Zen variant (data-only difference)', () => {
  assert.deepEqual(DEFAULT_OPENCODE_ZEN_PROTOCOL_RULES, [
    { pattern: 'grok-*', protocol: 'responses' },
    { pattern: 'gpt-*', protocol: 'responses' },
    { pattern: 'muse-spark-*', protocol: 'responses' },
    { pattern: 'claude-*', protocol: 'anthropic' },
    { pattern: 'qwen*', protocol: 'anthropic' },
  ]);
  // The Zen table drops the Go table's minimax rule and adds claude-*; the
  // shared rules stay identical so the variant really is just different data.
  assert.deepEqual(
    DEFAULT_OPENCODE_ZEN_PROTOCOL_RULES.filter((rule) => rule.pattern !== 'minimax-*' && rule.pattern !== 'claude-*'),
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES.filter((rule) => rule.pattern !== 'minimax-*'),
  );
});

test('default rule tables are frozen against mutation', () => {
  assert.ok(Object.isFrozen(DEFAULT_OPENCODE_GO_PROTOCOL_RULES));
  assert.ok(Object.isFrozen(DEFAULT_OPENCODE_ZEN_PROTOCOL_RULES));
  for (const rule of DEFAULT_OPENCODE_GO_PROTOCOL_RULES) assert.ok(Object.isFrozen(rule));
});

test('openCodeGoPatternMatches handles exact ids, suffix globs, and the bare wildcard', () => {
  assert.equal(openCodeGoPatternMatches('grok-*', 'grok-4.7'), true);
  // The glob keeps its literal prefix: `grok-*` needs the dash, `qwen*` does not.
  assert.equal(openCodeGoPatternMatches('grok-*', 'grok'), false);
  assert.equal(openCodeGoPatternMatches('grok-*', 'grog-4.7'), false);
  assert.equal(openCodeGoPatternMatches('qwen*', 'qwen3.8-max'), true);
  assert.equal(openCodeGoPatternMatches('qwen*', 'qwen'), true);
  assert.equal(openCodeGoPatternMatches('qwen*', 'aqwen'), false);
  assert.equal(openCodeGoPatternMatches('glm-5.3', 'glm-5.3'), true);
  assert.equal(openCodeGoPatternMatches('glm-5.3', 'glm-5.3-flash'), false);
  assert.equal(openCodeGoPatternMatches('*', 'anything-at-all'), true);
});

test('openCodeGoPatternMatches normalizes both sides (case, whitespace, model prefixes)', () => {
  assert.equal(openCodeGoPatternMatches('  GROK-* ', 'Grok-4.7'), true);
  assert.equal(openCodeGoPatternMatches('grok-*', 'OPENCODE-GO/GROK-4.7'), true);
  assert.equal(openCodeGoPatternMatches('GLM-5.3', ' glm-5.3 '), true);
});

test('openCodeGoPatternMatches never matches an empty pattern or empty normalized model', () => {
  assert.equal(openCodeGoPatternMatches('', 'glm-5.3'), false);
  assert.equal(openCodeGoPatternMatches('   ', 'glm-5.3'), false);
  assert.equal(openCodeGoPatternMatches('*', ''), false);
  assert.equal(openCodeGoPatternMatches('grok-*', 'opencode/'), false);
});

test('resolveOpenCodeGoProtocol resolves each default-table family', () => {
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'grok-4.7'), 'responses');
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'gpt-5.6-luna'), 'responses');
  assert.equal(
    resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'muse-spark-1.3-contributor'),
    'responses',
  );
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'minimax-m3'), 'anthropic');
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'qwen3.7-plus'), 'anthropic');
  // No match falls back to Chat Completions (the sub2api default).
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'glm-5.3'), 'openai');
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'kimi-k3'), 'openai');
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'omen-alpha'), 'openai');
  assert.equal(OPENCODE_GO_DEFAULT_PROTOCOL, 'openai');
});

test('resolveOpenCodeGoProtocol is first-match-wins in table order', () => {
  const rules = [
    { pattern: 'gpt-*', protocol: 'anthropic' },
    { pattern: '*', protocol: 'responses' },
  ];
  assert.equal(resolveOpenCodeGoProtocol(rules, 'gpt-5.6-luna'), 'anthropic');
  assert.equal(resolveOpenCodeGoProtocol(rules, 'glm-5.3'), 'responses');
  // Reversing the order flips the winner for gpt-* but not for the tail rule.
  const reversed = [...rules].reverse();
  assert.equal(resolveOpenCodeGoProtocol(reversed, 'gpt-5.6-luna'), 'responses');
});

test('resolveOpenCodeGoProtocol normalizes the model id before matching', () => {
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, 'OPENCODE-GO/QWEN3.8-MAX'), 'anthropic');
  assert.equal(resolveOpenCodeGoProtocol(DEFAULT_OPENCODE_GO_PROTOCOL_RULES, ' opencode_go/grok-4.7 '), 'responses');
});

test('resolveOpenCodeGoProtocol skips rules with unknown protocols (sub2api semantics)', () => {
  const rules = [
    { pattern: 'grok-*', protocol: 'gemini' },
    { pattern: 'grok-*', protocol: 'responses' },
  ] as unknown as Parameters<typeof resolveOpenCodeGoProtocol>[0];
  assert.equal(resolveOpenCodeGoProtocol(rules, 'grok-4.7'), 'responses');
  const onlyInvalid = [{ pattern: '*', protocol: 'gemini' }] as unknown as Parameters<
    typeof resolveOpenCodeGoProtocol
  >[0];
  assert.equal(resolveOpenCodeGoProtocol(onlyInvalid, 'grok-4.7'), 'openai');
});

test('openCodeGoProviderOperationForProtocol maps each native protocol to its canonical operation', () => {
  assert.equal(openCodeGoProviderOperationForProtocol('responses'), 'responses');
  assert.equal(openCodeGoProviderOperationForProtocol('openai'), 'chat.completions');
  assert.equal(openCodeGoProviderOperationForProtocol('anthropic'), 'messages');
});

test('validateOpenCodeGoProtocolRules accepts and normalizes a valid table', () => {
  const result = validateOpenCodeGoProtocolRules([
    { pattern: '  GROK-* ', protocol: ' responses ' },
    { pattern: 'glm-5.3', protocol: 'anthropic' },
  ]);
  assert.deepEqual(result, {
    valid: true,
    rules: [
      { pattern: 'grok-*', protocol: 'responses' },
      { pattern: 'glm-5.3', protocol: 'anthropic' },
    ],
  });
  if (result.valid) {
    assert.ok(Object.isFrozen(result.rules));
    for (const rule of result.rules) assert.ok(Object.isFrozen(rule));
  }
});

test('validateOpenCodeGoProtocolRules rejects malformed tables', () => {
  assert.equal(validateOpenCodeGoProtocolRules('nope').valid, false);
  assert.equal(validateOpenCodeGoProtocolRules({}).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules(['not-an-object']).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: 'grok-*' }]).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: 'grok-*', protocol: 'gemini' }]).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: 'grok-*', protocol: 'chat_completions' }]).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: '', protocol: 'responses' }]).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: 'a b', protocol: 'responses' }]).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: 'a*b*', protocol: 'responses' }]).valid, false);
  assert.equal(validateOpenCodeGoProtocolRules([{ pattern: '*grok', protocol: 'responses' }]).valid, false);
  assert.equal(
    validateOpenCodeGoProtocolRules([
      { pattern: 'a'.repeat(MAX_OPENCODE_GO_PROTOCOL_PATTERN_LENGTH + 1), protocol: 'responses' },
    ]).valid,
    false,
  );
  assert.equal(
    validateOpenCodeGoProtocolRules([
      { pattern: 'grok-*', protocol: 'responses' },
      { pattern: 'GROK-*', protocol: 'anthropic' },
    ]).valid,
    false,
  );
  const tooMany = Array.from({ length: MAX_OPENCODE_GO_PROTOCOL_RULES + 1 }, (_, index) => ({
    pattern: `model-${index}`,
    protocol: 'responses',
  }));
  assert.equal(validateOpenCodeGoProtocolRules(tooMany).valid, false);
  // The built-in default table is itself valid and within every limit.
  assert.equal(validateOpenCodeGoProtocolRules(DEFAULT_OPENCODE_GO_PROTOCOL_RULES).valid, true);
});

test('validateOpenCodeGoProtocolRules reports the offending index in its reason', () => {
  const result = validateOpenCodeGoProtocolRules([
    { pattern: 'grok-*', protocol: 'responses' },
    { pattern: '', protocol: 'anthropic' },
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /protocol_rules\[1\]/);
});

test('resolveOpenCodeGoProtocolRulesFromConfig reads the raw JSONB array shape', () => {
  assert.deepEqual(resolveOpenCodeGoProtocolRulesFromConfig([{ pattern: 'grok-*', protocol: 'responses' }]), [
    { pattern: 'grok-*', protocol: 'responses' },
  ]);
});

test('resolveOpenCodeGoProtocolRulesFromConfig reads the credentials-map wrapper shape', () => {
  assert.deepEqual(
    resolveOpenCodeGoProtocolRulesFromConfig({ protocol_rules: [{ pattern: 'qwen*', protocol: 'anthropic' }] }),
    [{ pattern: 'qwen*', protocol: 'anthropic' }],
  );
});

test('resolveOpenCodeGoProtocolRulesFromConfig returns null for absent or invalid config (default fallback)', () => {
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig(null), null);
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig(undefined), null);
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig({}), null);
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig('nope'), null);
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig([{ pattern: '', protocol: 'responses' }]), null);
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig({ protocol_rules: 'nope' }), null);
});

test('config loading composes with resolution: configured rules, then the built-in default table', () => {
  // The migration-108 wiring composition:
  // resolveOpenCodeGoProtocol(resolveOpenCodeGoProtocolRulesFromConfig(column) ?? DEFAULT, model).
  const resolve = (config: unknown): string =>
    resolveOpenCodeGoProtocol(
      resolveOpenCodeGoProtocolRulesFromConfig(config) ?? DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
      'glm-5.3',
    );
  assert.equal(resolve(null), 'openai');
  assert.equal(resolve([{ pattern: 'glm-*', protocol: 'responses' }]), 'responses');
  assert.equal(resolve({ protocol_rules: [{ pattern: 'glm-*', protocol: 'anthropic' }] }), 'anthropic');
  // Invalid configured rules fall back to the built-in table (sub2api semantics).
  assert.equal(
    resolveOpenCodeGoProtocol(
      resolveOpenCodeGoProtocolRulesFromConfig([{ pattern: '', protocol: 'responses' }]) ??
        DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
      'grok-4.7',
    ),
    'responses',
  );
  // A configured table with no match falls back to Chat Completions.
  assert.equal(
    resolveOpenCodeGoProtocol(
      resolveOpenCodeGoProtocolRulesFromConfig([{ pattern: 'glm-*', protocol: 'anthropic' }]) ??
        DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
      'grok-4.7',
    ),
    'openai',
  );
});
