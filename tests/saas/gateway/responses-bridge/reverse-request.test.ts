import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  effectiveResponsesTools,
  extractResponsesReasoningItem,
  flattenNamespaceToolName,
  responsesToChatCompletionsRequest,
  responsesToChatMessages,
} from '../../../../src/saas/gateway/responses-bridge/reverse-request.js';

const FIXTURES = join(fileURLToPath(import.meta.url), '..', 'testdata', 'issue5302');

function readFixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function messageRoles(body: any): string[] {
  return body.messages.map((m: any) => m.role);
}

// Ported from sub2api chatcompletions_responses_request_invariants_test.go:
// the Chat Completions invariants strict upstreams (DeepSeek / OpenAI)
// enforce; violating them surfaces as upstream 400s.
function assertChatInvariants(body: any): void {
  const messages = body.messages;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const toolCalls = m.tool_calls ?? [];
    for (let j = 0; j < toolCalls.length; j++) {
      const k = i + 1 + j;
      assert.ok(k < messages.length, `tool_call ${toolCalls[j].id} has no following tool message`);
      assert.equal(messages[k].role, 'tool', `tool_call ${toolCalls[j].id} not followed by a tool message`);
      assert.equal(messages[k].tool_call_id, toolCalls[j].id, `tool reply order mismatch for ${toolCalls[j].id}`);
    }
    if (i > 0 && m.role === 'assistant' && messages[i - 1].role === 'assistant') {
      assert.fail(`consecutive assistant messages at ${i}`);
    }
    if (m.role === 'tool') assert.notEqual(m.tool_call_id, undefined, `tool message without tool_call_id at ${i}`);
  }
}

function convertInput(input: unknown, instructions = ''): any[] {
  return responsesToChatMessages(instructions, input) as any[];
}

test('request: instructions become the leading system message; developer items merge into it', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'gpt-4o',
    instructions: 'Use concise answers.',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'Prefer JSON.' }] },
      { role: 'user', content: 'Hello' },
    ],
  });
  assert.deepEqual(messageRoles(result.body), ['system', 'user']);
  assert.equal(result.body.messages[0].content, 'Use concise answers.\n\nPrefer JSON.');
  assert.equal(result.body.messages[1].content, 'Hello');
});

test('request: leading developer roles merge into one system message', () => {
  const messages = convertInput([
    { role: ' Developer ', content: 'one' },
    { role: '\tDEVELOPER\n', content: 'two' },
  ]);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system'],
  );
  assert.equal(messages[0].content, 'one\n\ntwo');
});

test('request: mid-conversation developer/system items are downgraded to user', () => {
  const messages = convertInput([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<model_switch> switched model' }] },
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be terse' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
  ]);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'user', 'user'],
  );
  assert.equal(messages[2].content, '<model_switch> switched model');
  assert.equal(messages[3].content, 'be terse');
});

test('request: scalar params map (reasoning.effort, max_output_tokens, stream_options)', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'deepseek-v4-pro',
    input: 'hi',
    reasoning: { effort: 'high', summary: 'auto' },
    max_output_tokens: 512,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
    service_tier: 'flex',
    parallel_tool_calls: false,
  });
  assert.equal(result.body.reasoning_effort, 'high');
  assert.equal(result.body.max_completion_tokens, 512);
  assert.equal(result.body.temperature, 0.2);
  assert.equal(result.body.top_p, 0.9);
  assert.equal(result.body.stream, true);
  assert.equal(result.body.service_tier, 'flex');
  assert.equal(result.body.parallel_tool_calls, false);
  assert.deepEqual(result.body.stream_options, { include_usage: true });
  // Drop policy: no chat equivalent.
  assert.equal('previous_response_id' in result.body, false);
  assert.equal('store' in result.body, false);
});

test('request: bare string input is a single user turn', () => {
  const messages = convertInput('just ask');
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user'],
  );
  assert.equal(messages[0].content, 'just ask');
});

test('request: golden single tool-call turn carries reasoning_content on the assistant message', () => {
  const messages = convertInput([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest sha?' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'need to run curl' }] },
    { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: '{"cmd":"curl x"}' },
    { type: 'function_call_output', call_id: 'call_a', output: 'deadbeef' },
  ]);
  const assistant = messages.find((m) => (m.toolCalls ?? []).length > 0);
  assert.ok(assistant);
  assert.equal(assistant.reasoningContent, 'need to run curl');
});

test('request: parallel tool calls share one assistant message', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'features?' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'inspect repo' }] },
      { type: 'function_call', call_id: 'c0', name: 'exec_command', arguments: '{"cmd":"git log"}' },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"git tag"}' },
      { type: 'function_call_output', call_id: 'c0', output: 'log' },
      { type: 'function_call_output', call_id: 'c1', output: 'tags' },
    ],
  });
  const messages = result.body.messages;
  const shared = messages.find((m: any) => (m.tool_calls ?? []).length === 2);
  assert.ok(shared, 'parallel calls must share one assistant message');
  assert.deepEqual(
    shared.tool_calls.map((tc: any) => tc.id),
    ['c0', 'c1'],
  );
  assert.equal(messages.filter((m: any) => m.role === 'tool').length, 2);
});

test('request: unknown item between tool call and output does not break adjacency', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'let me search' }] },
      { type: 'function_call', call_id: 'c0', name: 'exec_command', arguments: '{}' },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'x' } },
      { type: 'function_call_output', call_id: 'c0', output: 'result' },
    ],
  });
  assertChatInvariants(result.body);
});

test('request: truncated function_call (invalid JSON) pair is skipped whole', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'call_bad', name: 'exec_command', arguments: '{"cmd": "ssh root@HOST' },
      { type: 'function_call_output', call_id: 'call_bad', output: 'failed to parse function arguments' },
      { type: 'function_call', call_id: 'call_ok', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_ok', output: 'ok' },
      { role: 'user', content: 'continue' },
    ],
  });
  const messages = result.body.messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].tool_calls[0].id, 'call_ok');
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].tool_call_id, 'call_ok');
  assert.equal(messages[2].role, 'user');
});

test('request: invalid function_call with empty call_id skips its empty-id output', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'function_call', call_id: '', name: 'exec_command', arguments: '{"cmd": "ssh root@HOST' },
      { type: 'function_call_output', call_id: '', output: 'failed' },
      { role: 'user', content: 'continue' },
    ],
  });
  assert.deepEqual(messageRoles(result.body), ['user']);
});

test('request: dangling tool call and orphan tool reply are dropped', () => {
  const dangling = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'r' }] },
      { type: 'function_call', call_id: 'A', name: 'exec', arguments: '{}' },
    ],
  });
  assert.equal(
    dangling.body.messages.some((m: any) => (m.tool_calls ?? []).length > 0),
    false,
    'dangling unanswered tool_call should have been dropped',
  );

  const orphan = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'function_call_output', call_id: 'ghost', output: 'orphan' },
    ],
  });
  assert.equal(
    orphan.body.messages.some((m: any) => m.role === 'tool'),
    false,
    'orphan tool reply should have been dropped',
  );
});

test('request: partial parallel call drops the unanswered sibling', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'r' }] },
      { type: 'function_call', call_id: 'A', name: 'exec', arguments: '{}' },
      { type: 'function_call', call_id: 'B', name: 'exec', arguments: '{}' },
      { type: 'function_call_output', call_id: 'A', output: 'oa' },
    ],
  });
  for (const message of result.body.messages) {
    for (const tc of message.tool_calls ?? []) assert.notEqual(tc.id, 'B');
  }
});

test('request: message between tool call and output is moved after the tool reply', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'run cmd' }] },
      { type: 'function_call', call_id: 'A', name: 'exec', arguments: '{}' },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Approved command prefix saved' }] },
      { type: 'function_call_output', call_id: 'A', output: 'ok' },
    ],
  });
  assertChatInvariants(result.body);
});

// Ported from chatcompletions_responses_reasoning_cache_test.go: the
// reasoning double-buffer. DeepSeek emits reasoning once per turn; chained
// tool calls (reasoning → call A → output A → call B) must replay the turn's
// reasoning on B's assistant message.
test('request: chained tool calls replay the turn reasoning (double buffer)', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'deepseek-reasoner',
    input: [
      { type: 'reasoning', id: 'item_r1', summary: [{ type: 'summary_text', text: 'turn thinking' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '\n\n' }] },
      { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
      { type: 'function_call', call_id: 'call_b', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_b', output: 'ok' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      { type: 'reasoning', id: 'item_r2', summary: [{ type: 'summary_text', text: 'second turn' }] },
      { type: 'function_call', call_id: 'call_c', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_c', output: 'ok' },
    ],
  });
  const byCallId = new Map<string, any>();
  for (const message of result.body.messages) {
    for (const tc of message.tool_calls ?? []) byCallId.set(tc.id, message);
  }
  assert.equal(byCallId.size, 3);
  assert.equal(byCallId.get('call_a').reasoning_content, 'turn thinking');
  assert.equal(byCallId.get('call_b').reasoning_content, 'turn thinking', '链式第二个工具调用必须回放本轮 reasoning');
  assert.equal(byCallId.get('call_c').reasoning_content, 'second turn', 'user 消息后开启新轮次');
  for (const message of result.body.messages) {
    if (message.role === 'assistant') assert.notEqual(message.reasoning_content, undefined);
  }
});

test('request: encrypted-only reasoning item is restored via reasoningContentById; plaintext wins', () => {
  const input = [
    { type: 'reasoning', id: 'item_enc1', summary: [], encrypted_content: 'opaque' },
    { type: 'function_call', call_id: 'call_1', name: 'get_value', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go on' }] },
  ];
  const restored = responsesToChatCompletionsRequest(
    { model: 'deepseek-reasoner', input },
    { reasoningContentById: (id) => (id === 'item_enc1' ? 'cached thinking' : '') },
  );
  assert.equal(restored.body.messages.length, 3);
  assert.equal(restored.body.messages[0].reasoning_content, 'cached thinking');

  const missed = responsesToChatCompletionsRequest(
    { model: 'deepseek-reasoner', input },
    { reasoningContentById: () => '' },
  );
  assert.equal(missed.body.messages[0].reasoning_content, undefined);

  let lookupCalled = false;
  const plaintext = responsesToChatCompletionsRequest(
    {
      model: 'deepseek-reasoner',
      input: [
        { type: 'reasoning', id: 'item_plain', summary: [{ type: 'summary_text', text: 'plain thinking' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_value', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go on' }] },
      ],
    },
    {
      reasoningContentById: () => {
        lookupCalled = true;
        return 'cached thinking';
      },
    },
  );
  assert.equal(plaintext.body.messages[0].reasoning_content, 'plain thinking');
  assert.equal(lookupCalled, false, 'plaintext summary present → cache lookup must not run');
});

test('request: extractResponsesReasoningItem summary/content/bailout', () => {
  assert.deepEqual(
    extractResponsesReasoningItem({
      type: 'reasoning',
      id: 'item_a',
      summary: [{ type: 'summary_text', text: 'think' }],
    }),
    { id: 'item_a', text: 'think' },
  );
  assert.deepEqual(
    extractResponsesReasoningItem({
      type: 'reasoning',
      id: 'item_b',
      summary: [],
      encrypted_content: 'opaque',
    }),
    { id: 'item_b', text: '' },
  );
  assert.equal(extractResponsesReasoningItem({ type: 'message' }), null);
  assert.equal(extractResponsesReasoningItem('bare string'), null);
});

test('request: custom tools degrade to a function with an input-string schema', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [{ role: 'user', content: 'run it' }],
    tools: [
      { type: 'custom', name: 'exec', description: 'run a command' },
      { type: 'function', name: 'lookup', parameters: { type: 'object' } },
      { type: 'web_search' },
    ],
  });
  const tools = result.body.tools;
  assert.equal(tools.length, 2);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'exec');
  assert.deepEqual(tools[0].function.parameters, {
    type: 'object',
    properties: { input: { type: 'string', description: 'The raw input for this tool, passed through verbatim.' } },
    required: ['input'],
  });
  assert.equal(tools[1].function.name, 'lookup');
  assert.equal(result.mapping.customTools.has('exec'), true);
  assert.equal(result.mapping.functionTools.has('lookup'), true);
});

test('request: custom_tool_call history wraps free text into {"input": ...} arguments', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'custom_tool_call', call_id: 'call_p', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_p', output: 'done' },
    ],
  });
  const assistant = result.body.messages[0];
  assert.equal(assistant.tool_calls[0].function.name, 'apply_patch');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { input: '*** Begin Patch' });
  assert.equal(result.body.messages[1].tool_call_id, 'call_p');
});

test('request: namespace children flatten with prefix and restore mapping is recorded', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [{ role: 'user', content: 'go' }],
    tools: [
      {
        type: 'namespace',
        name: 'mcp',
        tools: [
          { type: 'function', name: 'read', description: 'read a file' },
          { type: 'function', name: 'write' },
        ],
      },
    ],
  });
  assert.deepEqual(
    result.body.tools.map((t: any) => t.function.name),
    ['mcp__read', 'mcp__write'],
  );
  assert.deepEqual(result.mapping.namespaceTools.get('mcp__read'), { namespace: 'mcp', name: 'read' });
});

test('request: namespace-flattened history calls with a namespace field are lowered to the flat name', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c1', name: 'read', namespace: 'mcp', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'data' },
    ],
  });
  assert.equal(result.body.messages[0].tool_calls[0].function.name, 'mcp__read');
});

test('request: over-long flattened names carry a sha256 suffix', () => {
  const flat = flattenNamespaceToolName('n'.repeat(40), 'x'.repeat(40));
  assert.ok(flat.length <= 64);
  assert.match(flat, /__[0-9a-f]{8}$/);
  assert.notEqual(flat, flattenNamespaceToolName('n'.repeat(40), 'y'.repeat(40)));
});

test('request: flatten collisions are rejected explicitly', () => {
  assert.throws(
    () =>
      responsesToChatCompletionsRequest({
        model: 'm',
        input: [],
        tools: [
          { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'tool' }] },
          { type: 'function', name: 'a__tool' },
        ],
      }),
    /cannot disambiguate/,
  );
  assert.throws(
    () =>
      responsesToChatCompletionsRequest({
        model: 'm',
        input: [],
        tools: [
          { type: 'function', name: 'dup' },
          { type: 'custom', name: 'dup' },
        ],
      }),
    /duplicate top-level executable tool name/,
  );
});

test('request: tool_search degrades to a same-named function proxy and maps history calls', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'tool_search_call', call_id: 'ts1', arguments: { query: 'mcp' } },
      { type: 'tool_search_output', call_id: 'ts1', output: '[]' },
    ],
    tools: [{ type: 'tool_search' }],
  });
  assert.equal(result.body.tools[0].function.name, 'tool_search');
  assert.equal(result.mapping.toolSearch, true);
  const assistant = result.body.messages[0];
  assert.equal(assistant.tool_calls[0].function.name, 'tool_search');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { query: 'mcp' });
});

test('request: tool_search_output discoveries are promoted into effective tools', () => {
  const body = {
    model: 'm',
    input: [
      { type: 'tool_search_call', call_id: 'ts1', arguments: '{"query":"mcp"}' },
      {
        type: 'tool_search_output',
        call_id: 'ts1',
        status: 'completed',
        tools: [{ type: 'function', name: 'discovered', parameters: { type: 'object' } }],
      },
    ],
    tools: [{ type: 'tool_search' }],
  };
  const effective = effectiveResponsesTools(body);
  const names = effective.map((t: any) => t.name);
  assert.ok(names.includes('discovered'), 'discovered tool must be promoted');

  const result = responsesToChatCompletionsRequest(body);
  assert.ok(
    result.body.tools.some((t: any) => t.function?.name === 'discovered'),
    'promoted tool must reach the chat tool list',
  );
});

test('request: tool_choice follows the surviving tools', () => {
  const forced = responsesToChatCompletionsRequest({
    model: 'm',
    input: [{ role: 'user', content: 'go' }],
    tools: [{ type: 'tool_search' }],
    tool_choice: { type: 'tool_search' },
  });
  assert.deepEqual(forced.body.tool_choice, { type: 'function', function: { name: 'tool_search' } });

  const named = responsesToChatCompletionsRequest({
    model: 'm',
    input: [{ role: 'user', content: 'go' }],
    tools: [{ type: 'function', name: 'keep' }, { type: 'web_search' }],
    tool_choice: { type: 'function', name: 'keep' },
  });
  assert.deepEqual(named.body.tool_choice, { type: 'function', function: { name: 'keep' } });

  // All tools dropped (server-side only) → tool_choice must be dropped too.
  const dropped = responsesToChatCompletionsRequest({
    model: 'm',
    input: [{ role: 'user', content: 'go' }],
    tools: [{ type: 'web_search' }],
    tool_choice: { type: 'function', name: 'web_search' },
  });
  assert.equal('tool_choice' in dropped.body, false);
  assert.equal('tools' in dropped.body, false);
});

test('request: text.format json_schema is reshaped into chat response_format', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'gpt-4o',
    input: [{ role: 'user', content: 'Return structured JSON' }],
    text: {
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  });
  assert.deepEqual(result.body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'answer',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      strict: true,
    },
  });

  const simple = responsesToChatCompletionsRequest({
    model: 'gpt-4o',
    input: [{ role: 'user', content: 'Return JSON' }],
    text: { format: { type: 'json_object' } },
  });
  assert.deepEqual(simple.body.response_format, { type: 'json_object' });
});

test('request: image parts become image_url content parts for user messages only', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    ],
  });
  assert.deepEqual(result.body.messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);

  // Assistant messages with mixed parts collapse to text (chat has no
  // assistant multimodal).
  const assistant = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      {
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'part one' },
          { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
          { type: 'output_text', text: 'part two' },
        ],
      },
    ],
  });
  assert.equal(assistant.body.messages[0].content, 'part one\n\npart two');
});

test('request: agent_message items flatten to user messages in order', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      {
        type: 'agent_message',
        content: [
          { type: 'input_text', text: 'envelope: ' },
          { type: 'encrypted_content', encrypted_content: 'payload' },
        ],
      },
    ],
  });
  assert.deepEqual(messageRoles(result.body), ['user']);
  assert.equal(result.body.messages[0].content, 'envelope: payload');
});

test('request: tool output images move to a following user message with attribution', () => {
  const result = responsesToChatCompletionsRequest({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'call_img', name: 'view_image', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_img',
        output:
          '[{"type":"input_text","text":"render complete"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}}]',
      },
    ],
  });
  const messages = result.body.messages;
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[1].role, 'tool');
  const toolText = messages[1].content as string;
  assert.ok(toolText.includes('render complete'), 'surviving text stays in the tool output');
  assert.ok(
    toolText.includes('[Tool output media moved to the following user message]'),
    'image node is replaced by the marker',
  );
  assert.ok(!toolText.includes('AQID'), 'image payload must not stay in the tool output');
  const media = messages[2];
  assert.equal(media.role, 'user');
  assert.deepEqual(media.content, [
    { type: 'text', text: '[Tool output media for call call_img]' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
  ]);
});
