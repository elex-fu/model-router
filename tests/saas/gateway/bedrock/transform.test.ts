import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEDROCK_ANTHROPIC_VERSION } from '../../../../src/saas/gateway/bedrock/constants.js';
import {
  adjustBedrockModelRegionPrefix,
  bedrockCrossRegionPrefix,
  buildBedrockInvokeUrl,
  encodeUriPathSegment,
  filterBedrockBetaTokens,
  isBedrockClaude45OrNewer,
  isBedrockOpus47OrNewer,
  parseAnthropicBetaHeader,
  prepareBedrockRequestBody,
  resolveBedrockModel,
  sanitizeBedrockThinking,
  sanitizeBedrockToolUseIds,
  sanitizeToolUseId,
} from '../../../../src/saas/gateway/bedrock/transform.js';

/**
 * Request-transform snapshot tests (the bedrock_request.go port). Every
 * case pins the exact output body shape; copy-on-write is asserted by
 * deep-cloning inputs and comparing after the call.
 */

const SONNET = 'us.anthropic.claude-sonnet-4-5-v1:0';

function clone<T>(value: T): T {
  return structuredClone(value);
}

test('cross-region prefix mapping (sub2api BedrockCrossRegionPrefix)', () => {
  assert.equal(bedrockCrossRegionPrefix('us-east-1'), 'us');
  assert.equal(bedrockCrossRegionPrefix('us-gov-west-1'), 'us-gov');
  assert.equal(bedrockCrossRegionPrefix('eu-west-1'), 'eu');
  assert.equal(bedrockCrossRegionPrefix('ap-northeast-1'), 'jp');
  assert.equal(bedrockCrossRegionPrefix('ap-southeast-2'), 'au');
  assert.equal(bedrockCrossRegionPrefix('ap-south-1'), 'apac');
  assert.equal(bedrockCrossRegionPrefix('ca-central-1'), 'us');
  assert.equal(bedrockCrossRegionPrefix('sa-east-1'), 'us');
  assert.equal(bedrockCrossRegionPrefix('me-south-1'), 'us');
});

test('region prefix adjust rewrites only known cross-region prefixes', () => {
  assert.equal(
    adjustBedrockModelRegionPrefix('us.anthropic.claude-opus-4-6-v1:0', 'eu-west-1'),
    'eu.anthropic.claude-opus-4-6-v1:0',
  );
  assert.equal(
    adjustBedrockModelRegionPrefix('eu.anthropic.claude-opus-4-6-v1:0', 'eu-west-1'),
    'eu.anthropic.claude-opus-4-6-v1:0',
  );
  assert.equal(
    adjustBedrockModelRegionPrefix('us.anthropic.claude-opus-4-6-v1:0', 'ap-northeast-1'),
    'jp.anthropic.claude-opus-4-6-v1:0',
  );
  assert.equal(
    adjustBedrockModelRegionPrefix('us.anthropic.claude-opus-4-6-v1:0', 'global'),
    'global.anthropic.claude-opus-4-6-v1:0',
  );
  assert.equal(
    adjustBedrockModelRegionPrefix('anthropic.claude-opus-4-6-v1:0', 'eu-west-1'),
    'anthropic.claude-opus-4-6-v1:0',
  );
});

test('resolveBedrockModel rejects non-bedrock ids and adjusts regional ones', () => {
  assert.deepEqual(resolveBedrockModel('claude-sonnet-4-5', { region: 'us-east-1' }), {
    modelId: 'claude-sonnet-4-5',
    ok: false,
  });
  assert.deepEqual(resolveBedrockModel('bedrock/us.anthropic.claude-sonnet-4-5-v1:0', { region: 'eu-west-1' }), {
    modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0',
    ok: true,
  });
  assert.deepEqual(resolveBedrockModel('anthropic.claude-sonnet-4-5-v1:0', { region: 'eu-west-1' }), {
    modelId: 'anthropic.claude-sonnet-4-5-v1:0',
    ok: true,
  });
  assert.deepEqual(
    resolveBedrockModel('us.anthropic.claude-sonnet-4-5-v1:0', { region: 'us-east-1', forceGlobal: true }),
    { modelId: 'global.anthropic.claude-sonnet-4-5-v1:0', ok: true },
  );
});

test('invoke URL encodes the model id with %3A for colons', () => {
  const built = buildBedrockInvokeUrl({
    region: 'us-west-2',
    modelId: 'us.anthropic.claude-sonnet-4-5-v1:0',
    stream: false,
  });
  assert.equal(
    built.url,
    'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke',
  );
  assert.equal(built.path, '/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke');
  assert.equal(built.host, 'bedrock-runtime.us-west-2.amazonaws.com');
  const streamed = buildBedrockInvokeUrl({
    region: 'eu-central-1',
    modelId: 'eu.anthropic.claude-opus-4-6-v1:0',
    stream: true,
  });
  assert.ok(streamed.url.endsWith('/model/eu.anthropic.claude-opus-4-6-v1%3A0/invoke-with-response-stream'));
  const override = buildBedrockInvokeUrl({
    region: 'us-west-2',
    modelId: 'm:1',
    stream: false,
    baseUrl: 'http://127.0.0.1:8080/',
  });
  assert.equal(override.url, 'http://127.0.0.1:8080/model/m%3A1/invoke');
  assert.equal(encodeUriPathSegment('a/b c'), 'a%2Fb%20c');
});

test('version gates (sub2api isBedrockClaude45OrNewer / isBedrockOpus47OrNewer)', () => {
  assert.equal(isBedrockClaude45OrNewer('anthropic.claude-sonnet-4-5-v1:0'), true);
  // The reference regex captures the date suffix as the minor version
  // (claude-sonnet-4-20250514 → 4.20250514), so dated spellings gate as
  // 4.5+ — mirrored deliberately.
  assert.equal(isBedrockClaude45OrNewer('us.anthropic.claude-sonnet-4-20250514-v1:0'), true);
  assert.equal(isBedrockClaude45OrNewer('anthropic.claude-3-5-sonnet-20240620-v1:0'), false);
  assert.equal(isBedrockClaude45OrNewer('us.anthropic.claude-opus-5-v1:0'), true);
  assert.equal(isBedrockClaude45OrNewer('claude-fable-5-anything'), true);
  assert.equal(isBedrockClaude45OrNewer('anthropic.claude-3-5-sonnet'), false);
  assert.equal(isBedrockOpus47OrNewer('us.anthropic.claude-opus-4-7-v1:0'), true);
  assert.equal(isBedrockOpus47OrNewer('us.anthropic.claude-opus-4-6-v1:0'), false);
  assert.equal(isBedrockOpus47OrNewer('us.anthropic.claude-sonnet-4-7-v1:0'), false);
});

test('beta header parsing (comma-separated and JSON array spellings)', () => {
  assert.deepEqual(parseAnthropicBetaHeader(''), []);
  assert.deepEqual(parseAnthropicBetaHeader('context-1m-2025-08-07, output-128k-2025-08-07'), [
    'context-1m-2025-08-07',
    'output-128k-2025-08-07',
  ]);
  assert.deepEqual(parseAnthropicBetaHeader('["context-1m-2025-08-07"]'), ['context-1m-2025-08-07']);
});

test('beta filter transforms, whitelists, dedupes and auto-links tool-examples', () => {
  assert.deepEqual(filterBedrockBetaTokens(['advanced-tool-use-2025-11-20']), [
    'tool-search-tool-2025-10-19',
    'tool-examples-2025-10-29',
  ]);
  assert.deepEqual(filterBedrockBetaTokens(['output-128k-2025-08-07', 'files-api-2025-05-20']), []);
  assert.deepEqual(
    filterBedrockBetaTokens(['tool-search-tool-2025-10-19', 'tool-search-tool-2025-10-19', 'tool-examples-2025-10-29']),
    ['tool-search-tool-2025-10-19', 'tool-examples-2025-10-29'],
  );
});

test('prepareBedrockRequestBody produces the canonical invoke body (snapshot)', () => {
  const input = {
    model: 'claude-sonnet-4-5',
    max_tokens: 128,
    stream: true,
    system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral', scope: 'global' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
    tools: [
      { name: 'get_weather', description: 'x', input_schema: { type: 'object' }, custom: { defer_loading: true } },
    ],
    anthropic_beta: ['prompt-caching-2024-07-31'],
    service_tier: 'auto',
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    fallbacks: [{ model: 'other' }],
    fallback_credit_token: 'tok',
    metadata: { user_id: 'u' },
    provider: 'anthropic',
  };
  const before = clone(input);
  const { body, betaTokens } = prepareBedrockRequestBody(input, {
    modelId: SONNET,
    betaHeader: 'output-128k-2025-08-07',
  });
  // Copy-on-write: the input is untouched.
  assert.deepEqual(input, before);

  assert.deepEqual(betaTokens, []);
  assert.equal(body.anthropic_version, BEDROCK_ANTHROPIC_VERSION);
  assert.equal('anthropic_beta' in body, false);
  assert.equal('model' in body, false);
  assert.equal('stream' in body, false);
  assert.equal('provider' in body, false);
  assert.equal('metadata' in body, false);
  assert.equal('service_tier' in body, false);
  assert.equal('context_management' in body, false);
  assert.equal('fallbacks' in body, false);
  assert.equal('fallback_credit_token' in body, false);
  assert.equal(body.max_tokens, 128);
  // Sonnet 4.5 keeps ttl "5m" but scope is always stripped.
  assert.deepEqual((body.system as Record<string, unknown>[])[0].cache_control, { type: 'ephemeral' });
  const firstMessage = (body.messages as Record<string, unknown>[])[0];
  const firstBlock = (firstMessage.content as Record<string, unknown>[])[0];
  assert.deepEqual(firstBlock.cache_control, { type: 'ephemeral', ttl: '5m' });
  // Tool custom field removed.
  assert.deepEqual(body.tools, [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }]);
});

test('prepareBedrockRequestBody strips ttl on pre-4.5 models and injects beta tokens', () => {
  const pre45 = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
  const input = {
    model: pre45,
    max_tokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
  };
  const { body, betaTokens } = prepareBedrockRequestBody(input, {
    modelId: pre45,
    betaHeader: 'context-1m-2025-08-07',
  });
  assert.deepEqual(betaTokens, ['context-1m-2025-08-07']);
  assert.deepEqual(body.anthropic_beta, ['context-1m-2025-08-07']);
  const block = ((body.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[0];
  assert.deepEqual(block.cache_control, { type: 'ephemeral' });
  // max_tokens default injection for CC-class bodies that omit it.
  const omitted = prepareBedrockRequestBody(
    { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    { modelId: SONNET },
  );
  assert.equal(omitted.body.max_tokens, 81_920);
});

test('prepareBedrockRequestBody inlines output_format.schema onto the last user message', () => {
  const input = {
    model: 'x',
    max_tokens: 32,
    output_format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [{ type: 'text', text: 'extract' }] },
    ],
    output_config: { something: true },
  };
  const { body } = prepareBedrockRequestBody(input, { modelId: SONNET });
  assert.equal('output_format' in body, false);
  assert.equal('output_config' in body, false);
  const messages = body.messages as Record<string, unknown>[];
  const last = messages[2].content as Record<string, unknown>[];
  assert.equal(last.length, 2);
  assert.equal(last[1].type, 'text');
  assert.deepEqual(JSON.parse(last[1].text as string), input.output_format.schema);
  // String content converts to the array form.
  const stringContent = prepareBedrockRequestBody(
    {
      model: 'x',
      max_tokens: 32,
      output_format: { schema: { type: 'object' } },
      messages: [{ role: 'user', content: 'plain' }],
    },
    { modelId: SONNET },
  );
  const blocks = (stringContent.body.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[];
  assert.deepEqual(
    blocks.map((block) => block.text),
    ['plain', '{"type":"object"}'],
  );
});

test('prepareBedrockRequestBody sanitizes tool_use ids and thinking per model gate', () => {
  const input = {
    model: 'x',
    max_tokens: 32,
    thinking: { type: 'enabled' },
    messages: [
      { role: 'user', content: [{ type: 'tool_use', id: 'toolu_01X!@#%', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad/id 1', content: 'ok' }] },
    ],
  };
  // Sonnet 4.5 (not Opus 4.7+): enabled keeps its type and gains the default budget.
  const sonnet = prepareBedrockRequestBody(clone(input), { modelId: SONNET });
  assert.deepEqual(sonnet.body.thinking, { type: 'enabled', budget_tokens: 10_000 });
  const messages = sonnet.body.messages as Record<string, unknown>[];
  assert.equal((messages[0].content as Record<string, unknown>[])[0].id, 'toolu_01X____');
  assert.equal((messages[1].content as Record<string, unknown>[])[0].tool_use_id, 'bad_id_1');

  // Opus 4.7+: enabled → adaptive, budget dropped.
  const opus = prepareBedrockRequestBody(clone(input), { modelId: 'us.anthropic.claude-opus-4-7-v1:0' });
  assert.deepEqual(opus.body.thinking, { type: 'adaptive' });

  // Fable 5: adaptive also drops budget_tokens.
  const fable = prepareBedrockRequestBody(
    { model: 'x', max_tokens: 32, thinking: { type: 'adaptive', budget_tokens: 2048 }, messages: [] },
    { modelId: 'us.anthropic.claude-fable-5-v1:0' },
  );
  assert.deepEqual(fable.body.thinking, { type: 'adaptive' });
});

test('sanitizeBedrockThinking standalone and sanitizeToolUseId alphabet', () => {
  assert.deepEqual(sanitizeBedrockThinking({ thinking: { type: 'enabled' } }, 'us.anthropic.claude-opus-4-7-v1:0'), {
    thinking: { type: 'adaptive' },
  });
  assert.deepEqual(
    sanitizeBedrockThinking({ thinking: { type: 'enabled', budget_tokens: 512 } }, 'anthropic.claude-sonnet-4-5-v1:0'),
    { thinking: { type: 'enabled', budget_tokens: 512 } },
  );
  assert.equal(sanitizeToolUseId('toolu_01ABC-xyz_é'), 'toolu_01ABC-xyz__');
  assert.deepEqual(
    sanitizeBedrockToolUseIds({
      messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'a b', name: 'n', input: {} }] }],
    }),
    { messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'a_b', name: 'n', input: {} }] }] },
  );
});

test('tool-search beta auto-injection is model-gated (haiku never gets it)', () => {
  const toolsBody = {
    model: 'x',
    max_tokens: 32,
    tools: [{ type: 'tool_search_tool_regex_20251119', name: 'search' }],
    messages: [],
  };
  const sonnet = prepareBedrockRequestBody(clone(toolsBody), { modelId: SONNET });
  assert.deepEqual(sonnet.betaTokens, ['tool-search-tool-2025-10-19', 'tool-examples-2025-10-29']);
  const haiku = prepareBedrockRequestBody(clone(toolsBody), { modelId: 'us.anthropic.claude-haiku-4-5-v1:0' });
  assert.deepEqual(haiku.betaTokens, []);

  // computer_20* tools inject the computer-use beta.
  const computer = prepareBedrockRequestBody(
    { model: 'x', max_tokens: 32, tools: [{ type: 'computer_20250124', name: 'c' }], messages: [] },
    { modelId: SONNET },
  );
  assert.deepEqual(computer.betaTokens, ['computer-use-2025-11-24']);

  // input_examples injects advanced-tool-use, which filters into
  // tool-search-tool + tool-examples.
  const examples = prepareBedrockRequestBody(
    {
      model: 'x',
      max_tokens: 32,
      tools: [{ name: 't', input_schema: {}, input_examples: [{ input: {}, output: {} }] }],
      messages: [],
    },
    { modelId: SONNET },
  );
  assert.deepEqual(examples.betaTokens, ['tool-search-tool-2025-10-19', 'tool-examples-2025-10-29']);
});

test('non-object input fails closed', () => {
  assert.throws(() => prepareBedrockRequestBody('nope', { modelId: SONNET }), /malformed/);
});
