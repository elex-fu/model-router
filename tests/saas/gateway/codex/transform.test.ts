import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aliasReservedToolNames,
  applyCodexOAuthTransform,
  normalizeCodexModel,
  restoreReservedToolNames,
} from '../../../../src/saas/gateway/codex/transform.js';

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('normalizeCodexModel maps retired ids and strips reasoning-effort suffixes', () => {
  assert.equal(normalizeCodexModel('gpt-5.1-codex-max'), 'gpt-5.3-codex');
  assert.equal(normalizeCodexModel('gpt-5.1-codex-max-high'), 'gpt-5.3-codex');
  assert.equal(normalizeCodexModel('gpt-5.2-codex-high'), 'gpt-5.2-codex');
  assert.equal(normalizeCodexModel('gpt-5.2-codex-medium'), 'gpt-5.2-codex');
  assert.equal(normalizeCodexModel('gpt-5.2-codex-low'), 'gpt-5.2-codex');
  assert.equal(normalizeCodexModel('gpt-5.3-codex'), 'gpt-5.3-codex');
  assert.equal(normalizeCodexModel('gpt-5-codex-high-low'), 'gpt-5-codex');
  // Unknown names pass through untouched.
  assert.equal(normalizeCodexModel('gpt-9-codex'), 'gpt-9-codex');
});

test('applyCodexOAuthTransform forces store=false and stream=true and strips non-whitelisted fields', () => {
  const result = asRecord(
    applyCodexOAuthTransform({
      model: 'gpt-5.3-codex',
      input: 'hello',
      service_tier: 'priority',
      truncation: 'auto',
      metadata: { trace: 'x' },
      some_private_flag: true,
      user: 'u1',
    }),
  );
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
  assert.equal(result.model, 'gpt-5.3-codex');
  assert.equal(result.service_tier, undefined);
  assert.equal(result.truncation, undefined);
  assert.equal(result.metadata, undefined);
  assert.equal(result.some_private_flag, undefined);
  assert.equal(result.user, undefined);
  // Already-correct store/stream flags are still rewritten, not trusted.
  const forced = asRecord(applyCodexOAuthTransform({ model: 'm', input: [], store: true, stream: false }));
  assert.equal(forced.store, false);
  assert.equal(forced.stream, true);
});

test('applyCodexOAuthTransform preserves whitelisted fields it does not manage', () => {
  const result = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      instructions: 'be brief',
      tools: [{ type: 'function', name: 'get_time', parameters: { type: 'object' } }],
      tool_choice: 'auto',
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'cache-1',
      parallel_tool_calls: false,
      text: { verbosity: 'low' },
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 1024,
    }),
  );
  assert.equal(result.instructions, 'be brief');
  assert.deepEqual(result.tools, [{ type: 'function', name: 'get_time', parameters: { type: 'object' } }]);
  assert.equal(result.tool_choice, 'auto');
  assert.deepEqual(result.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(result.include, ['reasoning.encrypted_content']);
  assert.equal(result.prompt_cache_key, 'cache-1');
  assert.equal(result.parallel_tool_calls, false);
  assert.deepEqual(result.text, { verbosity: 'low' });
  assert.equal(result.temperature, 0.2);
  assert.equal(result.top_p, 0.9);
  assert.equal(result.max_output_tokens, 1024);
});

test('applyCodexOAuthTransform forces reasoning.encrypted_content into include when reasoning is present', () => {
  const withoutInclude = asRecord(applyCodexOAuthTransform({ model: 'm', input: [], reasoning: { effort: 'low' } }));
  assert.deepEqual(withoutInclude.include, ['reasoning.encrypted_content']);

  const withInclude = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      input: [],
      reasoning: { effort: 'low' },
      include: ['output_text'],
    }),
  );
  assert.deepEqual(withInclude.include, ['output_text', 'reasoning.encrypted_content']);

  const noReasoning = asRecord(applyCodexOAuthTransform({ model: 'm', input: [], include: ['output_text'] }));
  assert.deepEqual(noReasoning.include, ['output_text']);
  const noReasoningAtAll = asRecord(applyCodexOAuthTransform({ model: 'm', input: [] }));
  assert.equal(noReasoningAtAll.include, undefined);
});

test('applyCodexOAuthTransform converts legacy functions and function_call', () => {
  const result = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      input: [],
      functions: [{ name: 'get_time', description: 'time', parameters: { type: 'object' }, strict: true }],
      function_call: { name: 'get_time' },
    }),
  );
  assert.equal(result.functions, undefined);
  assert.equal(result.function_call, undefined);
  assert.deepEqual(result.tools, [
    { type: 'function', name: 'get_time', description: 'time', parameters: { type: 'object' }, strict: true },
  ]);
  assert.deepEqual(result.tool_choice, { type: 'function', name: 'get_time' });

  const stringChoice = asRecord(
    applyCodexOAuthTransform({ model: 'm', input: [], functions: [{ name: 'f' }], function_call: 'auto' }),
  );
  assert.equal(stringChoice.tool_choice, 'auto');

  // An explicit tool_choice wins over the legacy field.
  const explicitChoice = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      input: [],
      function_call: 'auto',
      tool_choice: { type: 'function', name: 'existing' },
    }),
  );
  assert.deepEqual(explicitChoice.tool_choice, { type: 'function', name: 'existing' });

  // Legacy functions append after existing tools.
  const merged = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      input: [],
      tools: [{ type: 'function', name: 'existing' }],
      functions: [{ name: 'legacy' }],
    }),
  );
  assert.deepEqual(resultNames(merged.tools), ['existing', 'legacy']);
});

function resultNames(tools: unknown): string[] {
  assert.ok(Array.isArray(tools));
  return tools.map((tool) => asRecord(tool).name as string);
}

test('applyCodexOAuthTransform converts a string input into a user message array', () => {
  const result = asRecord(applyCodexOAuthTransform({ model: 'm', input: 'just a string' }));
  assert.deepEqual(result.input, [{ role: 'user', content: 'just a string' }]);
});

test('applyCodexOAuthTransform promotes system messages into instructions ahead of existing ones', () => {
  const result = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      instructions: 'existing instructions',
      input: [
        { role: 'system', content: 'system one' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'input_text', text: 'system two' }] },
        { role: 'assistant', content: 'hello' },
      ],
    }),
  );
  assert.equal(result.instructions, 'system one\n\nsystem two\n\nexisting instructions');
  const input = result.input as unknown[];
  assert.equal(input.length, 2);
  assert.deepEqual(input[0], { role: 'user', content: 'hi' });
  assert.deepEqual(input[1], { role: 'assistant', content: 'hello' });

  // No existing instructions → system text becomes the instructions verbatim.
  const onlySystem = asRecord(
    applyCodexOAuthTransform({ model: 'm', input: [{ role: 'system', content: 'solo system' }] }),
  );
  assert.equal(onlySystem.instructions, 'solo system');
  assert.deepEqual(onlySystem.input, []);
});

test('applyCodexOAuthTransform normalizes call ids to the fc_ prefix and 64-character cap', () => {
  const longId = `call_${'x'.repeat(80)}`;
  const result = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      input: [
        { type: 'function_call', call_id: 'call_short', name: 'fn', arguments: '{}' },
        { type: 'function_call_output', call_id: longId, output: 'ok' },
        { role: 'assistant', content: [{ type: 'function_call', call_id: 'fc_already', name: 'fn', arguments: '{}' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    }),
  );
  const input = result.input as Record<string, unknown>[];
  assert.equal(input[0]?.call_id, 'fc_call_short');
  const truncated = input[1]?.call_id;
  assert.equal(typeof truncated, 'string');
  assert.ok((truncated as string).length <= 64);
  assert.ok((truncated as string).startsWith('fc_'));
  const content = input[2]?.content as Record<string, unknown>[];
  assert.equal(content[0]?.call_id, 'fc_already');
  assert.equal(content[0]?.call_id.length <= 64, true);
});

test('applyCodexOAuthTransform aliases the reserved python tool name in every outbound position', () => {
  const result = asRecord(
    applyCodexOAuthTransform({
      model: 'm',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'python', arguments: '{}' },
        { role: 'user', content: 'run it' },
      ],
      tools: [
        { type: 'function', name: 'python', parameters: { type: 'object' } },
        { type: 'function', name: 'safe_tool' },
        { type: 'function', function: { name: 'python' } },
      ],
      tool_choice: { type: 'function', function: { name: 'python' } },
    }),
  );
  const tools = result.tools as Record<string, unknown>[];
  assert.equal(tools[0]?.name, 'python__mr');
  assert.equal(tools[1]?.name, 'safe_tool');
  assert.deepEqual(tools[2]?.function, { name: 'python__mr' });
  assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'python__mr' } });
  const input = result.input as Record<string, unknown>[];
  assert.equal(input[0]?.name, 'python__mr');
});

test('applyCodexOAuthTransform normalizes the model id and never mutates its input', () => {
  const body = {
    model: 'gpt-5.1-codex-max-high',
    input: [{ role: 'system', content: 'sys' }],
    store: true,
    service_tier: 'priority',
    tools: [{ type: 'function', name: 'python' }],
  };
  const snapshot = structuredClone(body);
  const result = asRecord(applyCodexOAuthTransform(body));
  assert.equal(result.model, 'gpt-5.3-codex');
  assert.deepEqual(body, snapshot);
  assert.notEqual(result, body);
  assert.notEqual(result.tools, body.tools);
});

test('applyCodexOAuthTransform rejects non-object bodies', () => {
  assert.throws(() => applyCodexOAuthTransform('hello'));
  assert.throws(() => applyCodexOAuthTransform(null));
  assert.throws(() => applyCodexOAuthTransform([1, 2]));
});

test('aliasReservedToolNames is exported standalone and pure', () => {
  const body = { tools: [{ type: 'function', name: 'python' }], tool_choice: 'auto' };
  const snapshot = structuredClone(body);
  const aliased = asRecord(aliasReservedToolNames(body));
  assert.deepEqual(aliased.tools, [{ type: 'function', name: 'python__mr' }]);
  assert.deepEqual(body, snapshot);
});

test('restoreReservedToolNames restores the alias anywhere in a response document without mutating it', () => {
  const frame = {
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'python__mr', call_id: 'fc_1' },
    nested: { tools: [{ function: { name: 'python__mr' } }], plain: ['python__mr', 'other'] },
  };
  const snapshot = structuredClone(frame);
  const restored = asRecord(restoreReservedToolNames(frame));
  const item = restored.item as Record<string, unknown>;
  assert.equal(item.name, 'python');
  const nested = restored.nested as Record<string, unknown>;
  const tools = nested.tools as Record<string, unknown>[];
  assert.deepEqual(tools[0]?.function, { name: 'python' });
  assert.deepEqual(nested.plain, ['python', 'other']);
  assert.deepEqual(frame, snapshot);
});

test('restoreReservedToolNames only replaces exact alias matches and preserves untouched subtrees', () => {
  const shared = { name: 'untouched' };
  const frame = { text: 'please run python__mr now', keep: shared, exact: 'python__mr' };
  const restored = asRecord(restoreReservedToolNames(frame));
  assert.equal(restored.text, 'please run python__mr now');
  assert.equal(restored.exact, 'python');
  assert.equal(restored.keep, shared);
  // Values without the alias are returned by reference.
  const untouched = restoreReservedToolNames({ a: { b: [1, 2, 3] } });
  assert.deepEqual(untouched, { a: { b: [1, 2, 3] } });
});
