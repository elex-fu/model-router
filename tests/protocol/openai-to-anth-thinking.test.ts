import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickBridge } from '../../src/protocol/bridge.js';
import {
  BridgeToolChoiceMismatchError,
  BridgeToolChoiceSelectionError,
  OpenAIToAnthBridge,
} from '../../src/protocol/openai-to-anth.js';
import { finalizeStream, parseSseStream, type SseEvent } from '../../src/protocol/sse.js';

const tool = { type: 'function', function: { name: 'add', parameters: { type: 'object' } } };
const forced = { type: 'function', function: { name: 'add' } };
const kimi = () => pickBridge('openai', 'anthropic', { provider: 'kimi', model: 'kimi-for-coding' });

test('Kimi forced tools retain explicit native thinking disabled and the completion token limit', () => {
  const input = {
    model: 'public-alias',
    max_completion_tokens: 321,
    max_tokens: 123,
    thinking: { type: 'disabled' },
    reasoning_effort: 'high',
    tools: [tool],
    tool_choice: forced,
    messages: [{ role: 'user', content: 'Add 2 and 3' }],
  };
  const output = kimi().transformRequest(input);
  assert.deepEqual(output.thinking, { type: 'disabled' });
  assert.deepEqual(output.tool_choice, { type: 'any' });
  assert.equal(output.max_tokens, 321);
  assert.equal(output.reasoning_effort, undefined);
  assert.deepEqual(input.thinking, { type: 'disabled' });
});

test('reasoning effort uses the configured upstream provider and never downgrades forced tools', () => {
  for (const provider of ['kimi', 'kimi-code', 'kimi-code-global']) {
    const bridge = pickBridge('openai', 'anthropic', { provider, model: 'kimi-for-coding' });
    const output = bridge.transformRequest({ reasoning_effort: 'none', tools: [tool], tool_choice: forced });
    assert.deepEqual(output.thinking, { type: 'disabled' });
    assert.deepEqual(output.tool_choice, { type: 'any' });
    assert.deepEqual(bridge.transformRequest({ reasoning_effort: 'high' }).thinking, { type: 'enabled' });
    assert.deepEqual(
      bridge.transformRequest({ thinking: { type: 'enabled' }, tools: [tool], tool_choice: forced }).tool_choice,
      { type: 'any' },
    );
    assert.equal(bridge.transformRequest({ tools: [tool], tool_choice: forced }).thinking, undefined);
  }
  for (const provider of [undefined, 'anthropic', 'custom-anthropic']) {
    const output = new OpenAIToAnthBridge({ provider }).transformRequest({
      model: 'kimi-for-coding',
      reasoning_effort: 'none',
      tools: [tool],
      tool_choice: forced,
    });
    assert.equal(output.thinking, undefined, 'the client model cannot opt an unrelated provider into Kimi policy');
    assert.deepEqual(output.tool_choice, { type: 'tool', name: 'add' });
  }
});

test('Kimi Code named selection retains only the chosen declaration and validates it before dispatch', () => {
  const subtract = { type: 'function', function: { name: 'subtract', parameters: { type: 'object' } } };
  const input = { tools: [subtract, tool], tool_choice: forced, thinking: { type: 'disabled' } };
  for (const model of ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k']) {
    const output = new OpenAIToAnthBridge({ provider: 'kimi', model }).transformRequest(input);
    assert.deepEqual(output.tool_choice, { type: 'any' });
    assert.deepEqual(
      output.tools.map((item: any) => item.name),
      ['add'],
    );
    assert.deepEqual(output.tools[0].input_schema, tool.function.parameters);
  }
  assert.equal(input.tools.length, 2, 'the client tool list must not be mutated');
  for (const context of [
    { provider: 'anthropic', model: 'kimi-for-coding' },
    { provider: 'kimi', model: 'kimi-k2.6' },
    { provider: 'kimi' },
  ]) {
    const output = new OpenAIToAnthBridge(context).transformRequest(input);
    assert.deepEqual(output.tool_choice, { type: 'tool', name: 'add' });
    assert.equal(output.tools.length, 2);
  }
  for (const tools of [[], [subtract], [tool, tool]]) {
    assert.throws(() => kimi().transformRequest({ tools, tool_choice: forced }), BridgeToolChoiceSelectionError);
  }
});

test('same protocol bodies are unaffected by bridge provider context', () => {
  const body = { thinking: { type: 'disabled' }, reasoning_effort: 'none', tool_choice: forced };
  for (const protocol of ['openai', 'anthropic'] as const) {
    assert.equal(pickBridge(protocol, protocol, { provider: 'kimi' }).transformRequest(body), body);
  }
});

test('a named tool choice rejects text-only or different-tool provider responses without inventing a call', async () => {
  const bridge = kimi();
  bridge.transformRequest({ tools: [tool], tool_choice: forced, thinking: { type: 'disabled' } });
  for (const content of [
    [{ type: 'text', text: '5' }],
    [{ type: 'tool_use', id: 'different', name: 'subtract', input: { a: 2, b: 3 } }],
  ]) {
    assert.throws(() => bridge.transformResponse({ content, stop_reason: 'end_turn' }), BridgeToolChoiceMismatchError);
  }
  const result = bridge.transformStream(
    stream([
      streamStart,
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '5' } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      event('message_stop', {}),
    ]),
  );
  const observedUsage = result.usage;
  const events: SseEvent[] = [];
  await assert.rejects(async () => {
    for await (const item of parseSseStream(result.clientStream)) events.push(item);
  }, BridgeToolChoiceMismatchError);
  assert.equal((await observedUsage).outputTokens, 1);
  assert.equal(
    events.some((item) => item.data === '[DONE]'),
    false,
  );
});

const nativeContent = [
  { type: 'thinking', thinking: 'Check the operands.', signature: 'fixture-signature-a' },
  { type: 'text', text: 'I will add them.' },
  { type: 'redacted_thinking', data: 'fixture-redaction' },
  { type: 'thinking', thinking: 'Use the add tool.', signature: 'fixture-signature-b' },
  { type: 'tool_use', id: 'call_add', name: 'add', input: { a: 2, b: 3 } },
];

test('non-stream reasoning and signed interleaved history survive automatic and forced tool rounds', () => {
  for (const toolChoice of ['auto', forced]) {
    const bridge = kimi();
    bridge.transformRequest({ thinking: { type: 'disabled' }, tools: [tool], tool_choice: toolChoice });
    const response = bridge.transformResponse({
      id: 'msg_tools',
      model: 'kimi-for-coding',
      content: nativeContent,
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 8 },
    });
    const message = response.choices[0].message;
    assert.equal(message.reasoning_content, 'Check the operands.Use the add tool.');
    assert.equal(message.content, 'I will add them.');
    assert.equal(response.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(message.anthropic_content, nativeContent);
    assert.notEqual(message.anthropic_content, nativeContent);
    const next = bridge.transformRequest({
      tools: [tool],
      tool_choice: 'auto',
      messages: [
        { role: 'user', content: 'Add 2 and 3' },
        message,
        { role: 'tool', tool_call_id: message.tool_calls[0].id, content: '5' },
      ],
    });
    assert.deepEqual(next.messages[1].content, nativeContent);
    assert.deepEqual(next.messages[2].content, [{ type: 'tool_result', tool_use_id: 'call_add', content: '5' }]);
    const final = bridge.transformResponse({ content: [{ type: 'text', text: '5' }], stop_reason: 'end_turn' });
    assert.equal(final.choices[0].message.content, '5');
    assert.equal(final.choices[0].finish_reason, 'stop');
  }
});

test('native signed/redacted input blocks are preserved without duplicating reasoning_content', () => {
  const output = kimi().transformRequest({
    messages: [
      {
        role: 'assistant',
        content: nativeContent,
        reasoning_content: 'duplicate',
        tool_calls: [{ id: 'call_add', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }],
      },
    ],
  });
  assert.deepEqual(output.messages[0].content, nativeContent);
});

test('plain OpenAI reasoning history becomes unsigned native thinking only for configured Kimi', () => {
  const message = {
    role: 'assistant',
    reasoning_content: 'Call add.',
    content: 'Adding.',
    tool_calls: [{ id: 'call_add', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }],
  };
  const output = kimi().transformRequest({ messages: [message] });
  assert.deepEqual(output.messages[0].content[0], { type: 'thinking', thinking: 'Call add.' });
  assert.throws(
    () => new OpenAIToAnthBridge().transformRequest({ messages: [message] }),
    /cannot replay this OpenAI reasoning history/,
  );
});

function event(event: string, value: Record<string, unknown>): SseEvent {
  return { event, data: JSON.stringify(value) };
}

function stream(events: SseEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(finalizeStream(events));
      controller.close();
    },
  });
}

async function collect(events: SseEvent[]) {
  const result = kimi().transformStream(stream(events));
  const chunks: any[] = [];
  let done = false;
  for await (const item of parseSseStream(result.clientStream)) {
    if (item.data === '[DONE]') done = true;
    else chunks.push(JSON.parse(item.data));
  }
  return { chunks, done, usage: await result.usage };
}

const streamStart = event('message_start', {
  message: { id: 'msg_stream', model: 'kimi-for-coding', usage: { input_tokens: 11, output_tokens: 0 } },
});

test('SSE reasoning text, signature fragments, redaction and interleaved tools replay losslessly', async () => {
  const events = [
    streamStart,
    event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: 'Check ' } }),
    event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'operands.' } }),
    event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'signature-' } }),
    event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'a' } }),
    event('content_block_stop', { index: 0 }),
    event('content_block_start', { index: 1, content_block: { type: 'text', text: 'Adding.' } }),
    event('content_block_stop', { index: 1 }),
    event('content_block_start', { index: 2, content_block: { type: 'redacted_thinking', data: 'redacted-data' } }),
    event('content_block_stop', { index: 2 }),
    event('content_block_start', {
      index: 3,
      content_block: { type: 'tool_use', id: 'call_add', name: 'add', input: {} },
    }),
    event('content_block_delta', { index: 3, delta: { type: 'input_json_delta', partial_json: '{"a":2,' } }),
    event('content_block_delta', { index: 3, delta: { type: 'input_json_delta', partial_json: '"b":3}' } }),
    event('content_block_stop', { index: 3 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
    event('message_stop', {}),
  ];
  const { chunks, done, usage } = await collect(events);
  assert.equal(done, true);
  const deltas = chunks.map((chunk) => chunk.choices[0].delta);
  assert.equal(deltas.map((delta) => delta.reasoning_content ?? '').join(''), 'Check operands.');
  const native = deltas.find((delta) => delta.anthropic_content)?.anthropic_content;
  assert.deepEqual(native, [
    { type: 'thinking', thinking: 'Check operands.', signature: 'signature-a' },
    { type: 'text', text: 'Adding.' },
    { type: 'redacted_thinking', data: 'redacted-data' },
    { type: 'tool_use', id: 'call_add', name: 'add', input: { a: 2, b: 3 } },
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(usage, {
    inputTokens: 11,
    outputTokens: 9,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
  });
  const next = kimi().transformRequest({
    messages: [
      { role: 'assistant', content: 'Adding.', reasoning_content: 'Check operands.', anthropic_content: native },
      { role: 'tool', tool_call_id: 'call_add', content: '5' },
    ],
  });
  assert.deepEqual(next.messages[0].content, native);
  assert.deepEqual(next.messages[1].content, [{ type: 'tool_result', tool_use_id: 'call_add', content: '5' }]);
});

test('a cut SSE stream does not label incomplete thinking or tool arguments replayable', async () => {
  const result = kimi().transformStream(
    stream([
      streamStart,
      event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Partial.' } }),
    ]),
  );
  const usageFailure = result.usage.catch((error: unknown) => error);
  const chunks: any[] = [];
  await assert.rejects(async () => {
    for await (const item of parseSseStream(result.clientStream)) {
      if (item.data !== '[DONE]') chunks.push(JSON.parse(item.data));
    }
  }, /ended before thinking or tool completion/);
  assert.ok((await usageFailure) instanceof Error);
  assert.equal(
    chunks.some((chunk) => chunk.choices[0].delta.anthropic_content !== undefined),
    false,
  );
  assert.equal(
    chunks.some((chunk) => chunk.choices[0].delta.reasoning_content === 'Partial.'),
    true,
  );
});

test('SSE tool input supplied at block start is included in OpenAI argument deltas', async () => {
  const { chunks } = await collect([
    streamStart,
    event('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'call_add', name: 'add', input: { a: 2, b: 3 } },
    }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' } }),
    event('message_stop', {}),
  ]);
  const argumentsText = chunks
    .flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
    .map((call: any) => call.function?.arguments ?? '')
    .join('');
  assert.deepEqual(JSON.parse(argumentsText), { a: 2, b: 3 });
});
