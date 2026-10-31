import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_FAMILY_INSTRUCTIONS } from '../../../../src/saas/gateway/codex/instructions-families.generated.js';
import {
  applyCodexCompilation,
  codexProviderRequestTransform,
  convertChatCompletionsToResponsesRequest,
} from '../../../../src/saas/gateway/codex/payload.js';

test('chat.completions → responses: system promotion, tool messages, assistant tool calls', () => {
  const converted = convertChatCompletionsToResponsesRequest({
    model: 'gpt-5.3-codex',
    messages: [
      { role: 'system', content: 'You are careful.' },
      { role: 'developer', content: 'Prefer tests.' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result text' },
    ],
    max_tokens: 256,
    temperature: 0.2,
  }) as Record<string, unknown>;

  assert.equal(converted.model, 'gpt-5.3-codex');
  // system + developer messages join into instructions.
  assert.equal(converted.instructions, 'You are careful.\n\nPrefer tests.');
  assert.equal(converted.max_output_tokens, 256);
  assert.equal(converted.temperature, 0.2);

  const input = converted.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], { role: 'user', content: 'hi' });
  assert.deepEqual(input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'let me check' }] });
  assert.deepEqual(input[2], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '{"q":"x"}',
  });
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_1', output: 'result text' });
});

test('chat.completions → responses: tool definitions convert to responses function shape', () => {
  const converted = convertChatCompletionsToResponsesRequest({
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', description: 'd', parameters: { type: 'object' }, strict: true },
      },
    ],
    tool_choice: 'auto',
  }) as Record<string, unknown>;
  assert.deepEqual(converted.tools, [
    { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' }, strict: true },
  ]);
  assert.equal(converted.tool_choice, 'auto');
});

test('compilation injects family instructions when the body has none', () => {
  const withClient = applyCodexCompilation({ model: 'm', input: [], instructions: 'client wins' }) as Record<
    string,
    unknown
  >;
  assert.equal(withClient.instructions, 'client wins');

  // No instructions + unknown model → latest-known family prompt (gpt-5.5).
  const without = applyCodexCompilation({ model: 'm', input: [] }) as Record<string, unknown>;
  assert.equal(without.instructions, CODEX_FAMILY_INSTRUCTIONS['gpt-5.5']);
});

test('compilation forces the codex wire contract (store=false, stream=true)', () => {
  const out = applyCodexCompilation({ model: 'm', input: [], store: true, stream: false }) as Record<string, unknown>;
  assert.equal(out.store, false);
  assert.equal(out.stream, true);
});

test('compilation aliases the reserved python tool name on the way out', () => {
  const out = applyCodexCompilation({
    model: 'm',
    input: [],
    tools: [
      { type: 'function', name: 'python' },
      { type: 'function', name: 'lookup' },
    ],
  }) as Record<string, unknown>;
  const names = (out.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.deepEqual(names, ['python__mr', 'lookup']);
});

test('compiler hook: openai client → responses provider runs the chat conversion', () => {
  const out = codexProviderRequestTransform({
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    clientProtocol: 'openai',
    providerProtocol: 'responses',
    providerOperation: 'responses.create',
    body: {
      model: 'gpt-5.3-codex',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
    },
  }) as Record<string, unknown>;
  // The chat.completions body became a Responses body, then compiled.
  assert.equal(out.instructions, 'sys');
  assert.deepEqual(out.input, [{ role: 'user', content: 'hi' }]);
  assert.equal(out.stream, true);
  assert.equal(out.store, false);
  assert.equal('messages' in out, false);
});

test('compiler hook: anthropic-bridged bodies skip chat conversion but still compile', () => {
  const bridged = {
    model: 'gpt-5.3-codex',
    input: [{ role: 'user', content: 'hi' }],
    instructions: 'bridged instructions',
  };
  const out = codexProviderRequestTransform({
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    clientProtocol: 'anthropic',
    providerProtocol: 'responses',
    providerOperation: 'responses.create',
    body: bridged,
  }) as Record<string, unknown>;
  // Already Responses-shaped: input preserved, instructions kept, contract forced.
  assert.deepEqual(out.input, bridged.input);
  assert.equal(out.instructions, 'bridged instructions');
  assert.equal(out.store, false);
  assert.equal(out.stream, true);
});
