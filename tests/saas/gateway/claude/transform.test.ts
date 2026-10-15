import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeClaudeCodeFingerprint } from '../../../../src/saas/gateway/claude/billing-fingerprint.js';
import {
  applyClaudeOAuthTransform,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_CODE_SYSTEM_PROMPT_EXPANSION,
  ClaudeTransformError,
  denormalizeClaudeModelId,
  enforceCacheControlLimit,
  isClaudeFableModel,
  normalizeClaudeModelId,
  rewriteSystemForClaudeCode,
  sanitizeSystemText,
} from '../../../../src/saas/gateway/claude/transform.js';

const CLI_VERSION = '2.1.258';
const FIRST_USER_TEXT = 'Please refactor the parser module today.';

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: FIRST_USER_TEXT }],
    ...overrides,
  };
}

test('model id mapping and restoration round-trip', () => {
  assert.equal(normalizeClaudeModelId('claude-sonnet-4-5'), 'claude-sonnet-4-5-20250929');
  assert.equal(normalizeClaudeModelId('claude-opus-4-5'), 'claude-opus-4-5-20251101');
  assert.equal(normalizeClaudeModelId('claude-haiku-4-5'), 'claude-haiku-4-5-20251001');
  assert.equal(normalizeClaudeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5-20250929');
  assert.equal(normalizeClaudeModelId('claude-opus-4-6'), 'claude-opus-4-6');
  assert.equal(normalizeClaudeModelId(''), '');
  assert.equal(denormalizeClaudeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(denormalizeClaudeModelId('claude-opus-4-6'), 'claude-opus-4-6');
  assert.equal(isClaudeFableModel('claude-fable-5-1'), true);
  assert.equal(isClaudeFableModel('claude-sonnet-4-5'), false);
});

test('the OpenCode identity sentence is disinfected into the Claude Code banner', () => {
  assert.equal(sanitizeSystemText('You are OpenCode, the best coding agent on the planet.'), CLAUDE_CODE_SYSTEM_PROMPT);
  assert.equal(
    sanitizeSystemText('Prefix.\nYou are OpenCode, the best coding agent on the planet.\nSuffix.'),
    `Prefix.\n${CLAUDE_CODE_SYSTEM_PROMPT}\nSuffix.`,
  );
  // Ordinary user instructions are never touched.
  assert.equal(sanitizeSystemText('Always answer in Portuguese.'), 'Always answer in Portuguese.');
  assert.equal(sanitizeSystemText(''), '');
});

test('the system rewrite produces the 3-block shape and migrates the original into messages', () => {
  const body = baseBody({ system: 'Always answer in Portuguese.' });
  const result = rewriteSystemForClaudeCode(body, { cliVersion: CLI_VERSION });
  const system = result.system as Array<Record<string, unknown>>;
  assert.equal(system.length, 3);
  // Block 0: billing attribution with the fingerprint over the ORIGINAL first
  // user text (pre-rewrite messages).
  const expectedFp = computeClaudeCodeFingerprint(FIRST_USER_TEXT, CLI_VERSION);
  assert.equal(
    system[0].text,
    `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${expectedFp}; cc_entrypoint=cli;`,
  );
  assert.equal('cache_control' in system[0], false);
  // Block 1: identity banner without cache_control.
  assert.equal(system[1].text, CLAUDE_CODE_SYSTEM_PROMPT);
  assert.equal('cache_control' in system[1], false);
  // Block 2: expansion with the stable cache breakpoint.
  assert.equal(system[2].text, CLAUDE_CODE_SYSTEM_PROMPT_EXPANSION);
  assert.deepEqual(system[2].cache_control, { type: 'ephemeral', ttl: '5m' });
  // The original system migrated as a [System Instructions] pair.
  const messages = result.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  const instruction = (messages[0].content as Array<Record<string, unknown>>)[0];
  assert.equal(instruction.text, '[System Instructions]\nAlways answer in Portuguese.');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(
    (messages[1].content as Array<Record<string, unknown>>)[0].text,
    'Understood. I will follow these instructions.',
  );
  assert.deepEqual(messages[2], { role: 'user', content: FIRST_USER_TEXT });
  // Pure: the input body is not mutated.
  assert.equal(body.system, 'Always answer in Portuguese.');
  assert.equal((body.messages as unknown[]).length, 1);
});

test('a Claude Code-shaped system is not duplicated into messages', () => {
  const body = baseBody({ system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }] });
  const result = rewriteSystemForClaudeCode(body, { cliVersion: CLI_VERSION });
  assert.equal((result.messages as unknown[]).length, 1);
  const bodyPrefixed = baseBody({ system: `${CLAUDE_CODE_SYSTEM_PROMPT} extra guidance` });
  const resultPrefixed = rewriteSystemForClaudeCode(bodyPrefixed, { cliVersion: CLI_VERSION });
  assert.equal((resultPrefixed.messages as unknown[]).length, 1);
});

test('the original system cache breakpoint survives on the migrated instruction block', () => {
  const body = baseBody({
    system: [
      { type: 'text', text: 'first', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'second', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  });
  const result = rewriteSystemForClaudeCode(body, { cliVersion: CLI_VERSION });
  const instruction = (
    (result.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>
  )[0];
  // The last original breakpoint (including its TTL) is preserved.
  assert.deepEqual(instruction.cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('Fable models get the 2-block system (no expansion)', () => {
  const body = baseBody({ model: 'claude-fable-5-1', system: 'instructions' });
  const result = rewriteSystemForClaudeCode(body, { cliVersion: CLI_VERSION });
  assert.equal((result.system as unknown[]).length, 2);
});

test('the full transform applies every rule in order', () => {
  const result = applyClaudeOAuthTransform(
    baseBody({
      system: 'Answer in Portuguese.',
      temperature: 0.2,
      metadata: { user_id: 'client-id' },
    }),
    { cliVersion: CLI_VERSION },
  );
  // model mapped, temperature/metadata passed through untouched.
  assert.equal(result.model, 'claude-sonnet-4-5-20250929');
  assert.equal(result.temperature, 0.2);
  assert.deepEqual(result.metadata, { user_id: 'client-id' });
  // tools guaranteed present.
  assert.deepEqual(result.tools, []);
  // system rewritten and disinfected; the [System Instructions] block carries
  // the banner (not the OpenCode sentence).
  const messages = result.messages as Array<Record<string, unknown>>;
  const instruction = (messages[0].content as Array<Record<string, unknown>>)[0];
  assert.ok(String(instruction.text).includes('[System Instructions]'));
});

test('defaults: temperature 1, max_tokens 128000, context_management with thinking', () => {
  const withoutMaxTokens = baseBody();
  delete withoutMaxTokens.max_tokens;
  const result = applyClaudeOAuthTransform(withoutMaxTokens, { cliVersion: CLI_VERSION });
  assert.equal(result.temperature, 1);
  assert.equal(result.max_tokens, 128_000);
  assert.equal('context_management' in result, false);

  const thinking = applyClaudeOAuthTransform(baseBody({ thinking: { type: 'enabled', budget_tokens: 2048 } }), {
    cliVersion: CLI_VERSION,
  });
  assert.deepEqual(thinking.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] });

  const adaptive = applyClaudeOAuthTransform(baseBody({ thinking: { type: 'adaptive' } }), {
    cliVersion: CLI_VERSION,
  });
  assert.deepEqual(adaptive.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] });

  // A client-provided context_management passes through.
  const own = applyClaudeOAuthTransform(
    baseBody({ thinking: { type: 'enabled' }, context_management: { edits: [] } }),
    { cliVersion: CLI_VERSION },
  );
  assert.deepEqual(own.context_management, { edits: [] });

  // thinking disabled attaches nothing.
  const off = applyClaudeOAuthTransform(baseBody({ thinking: { type: 'off' } }), { cliVersion: CLI_VERSION });
  assert.equal('context_management' in off, false);
});

test('tool_choice is dropped only when the request carries no tools', () => {
  const noTools = applyClaudeOAuthTransform(baseBody({ tool_choice: { type: 'auto' } }), {
    cliVersion: CLI_VERSION,
  });
  assert.equal('tool_choice' in noTools, false);

  const withTools = applyClaudeOAuthTransform(
    baseBody({ tools: [{ name: 'bash', description: 'run', input_schema: {} }], tool_choice: { type: 'auto' } }),
    { cliVersion: CLI_VERSION },
  );
  assert.deepEqual(withTools.tool_choice, { type: 'auto' });
});

test('metadata.user_id is injected only when the client sent none', () => {
  const injected = applyClaudeOAuthTransform(baseBody(), { cliVersion: CLI_VERSION, metadataUserId: 'acct-session-1' });
  assert.deepEqual(injected.metadata, { user_id: 'acct-session-1' });

  const preserved = applyClaudeOAuthTransform(baseBody({ metadata: { user_id: 'client' } }), {
    cliVersion: CLI_VERSION,
    metadataUserId: 'acct-session-1',
  });
  assert.deepEqual(preserved.metadata, { user_id: 'client' });

  const disabled = applyClaudeOAuthTransform(baseBody(), { cliVersion: CLI_VERSION });
  assert.equal('metadata' in disabled, false);
});

test('non-object input fails closed', () => {
  for (const bad of [null, undefined, 'text', 42, []]) {
    assert.throws(() => applyClaudeOAuthTransform(bad, { cliVersion: CLI_VERSION }), ClaudeTransformError);
  }
});

test('cache_control is always stripped from thinking blocks', () => {
  const body = baseBody({
    system: 's',
    messages: [
      { role: 'user', content: [{ type: 'thinking', thinking: 'sig', cache_control: { type: 'ephemeral' } }] },
    ],
  });
  const result = enforceCacheControlLimit(body);
  const block = ((result.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[0];
  assert.equal('cache_control' in block, false);
});

test('the cache_control cap fills the strip quota from tools before messages before system', () => {
  // 5 blocks, 1 over the cap: the single tool breakpoint goes first.
  const oneOver = baseBody({
    system: [
      { type: 'text', text: 'sys0', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'sys1', cache_control: { type: 'ephemeral' } },
    ],
    tools: [{ name: 'a', cache_control: { type: 'ephemeral' } }, { name: 'b' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'm0', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'm1', cache_control: { type: 'ephemeral' } }] },
    ],
  });
  const oneOverResult = enforceCacheControlLimit(oneOver) as Record<string, any>;
  const oneOverTools = oneOverResult.tools as Array<Record<string, unknown>>;
  const oneOverMessages = oneOverResult.messages as Array<Record<string, unknown>>;
  assert.equal('cache_control' in oneOverTools[0], false);
  const m0 = (oneOverMessages[0].content as Array<Record<string, unknown>>)[0];
  const m1 = (oneOverMessages[1].content as Array<Record<string, unknown>>)[0];
  assert.equal('cache_control' in m0, true);
  assert.equal('cache_control' in m1, true);

  // No tool breakpoints: the FIRST message breakpoint goes next; system last.
  const noTools = baseBody({
    system: [
      { type: 'text', text: 'sys0', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'sys1', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'm0', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'm1', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'm2', cache_control: { type: 'ephemeral' } }] },
    ],
  });
  const noToolsResult = enforceCacheControlLimit(noTools) as Record<string, any>;
  const noToolsMessages = noToolsResult.messages as Array<Record<string, unknown>>;
  const noToolsSystem = noToolsResult.system as Array<Record<string, unknown>>;
  // 5 blocks → 1 over: m0 (first) is stripped, m1/m2 and both system blocks keep theirs.
  assert.equal('cache_control' in (noToolsMessages[0].content as Array<Record<string, unknown>>)[0], false);
  assert.equal('cache_control' in (noToolsMessages[1].content as Array<Record<string, unknown>>)[0], true);
  assert.equal('cache_control' in (noToolsMessages[2].content as Array<Record<string, unknown>>)[0], true);
  assert.equal('cache_control' in noToolsSystem[0], true);
  assert.equal('cache_control' in noToolsSystem[1], true);

  // When tools alone overflow the quota, later zones are untouched.
  const toolsOnly = baseBody({
    system: [{ type: 'text', text: 'sys0', cache_control: { type: 'ephemeral' } }],
    tools: [
      { name: 'a', cache_control: { type: 'ephemeral' } },
      { name: 'b', cache_control: { type: 'ephemeral' } },
      { name: 'c', cache_control: { type: 'ephemeral' } },
      { name: 'd', cache_control: { type: 'ephemeral' } },
      { name: 'e', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'm0', cache_control: { type: 'ephemeral' } }] }],
  });
  const toolsOnlyResult = enforceCacheControlLimit(toolsOnly) as Record<string, any>;
  const toolsOnlyTools = toolsOnlyResult.tools as Array<Record<string, unknown>>;
  // 6 blocks → 2 over: both from tools, stripped LAST-first.
  assert.equal('cache_control' in toolsOnlyTools[4], false);
  assert.equal('cache_control' in toolsOnlyTools[3], false);
  assert.equal('cache_control' in toolsOnlyTools[0], true);
  assert.equal(
    'cache_control' in
      ((toolsOnlyResult.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[0],
    true,
  );

  // Under the cap: returned by reference (copy-on-write).
  const small = baseBody({ system: 's' });
  assert.equal(enforceCacheControlLimit(small), small);
});
