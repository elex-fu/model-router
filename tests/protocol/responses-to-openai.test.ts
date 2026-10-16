import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickBridge } from '../../src/protocol/bridge.js';

function ccSseBytes(chunks: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

function parseSseLines(text: string): any[] {
  return text
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => JSON.parse(block.replace(/^data: /, '')));
}

const RESPONSES_REQUEST = {
  model: 'deepseek-v4-pro',
  instructions: 'Be brief.',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
    { type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'file_a' },
  ],
  tools: [{ type: 'custom', name: 'exec' }],
  reasoning: { effort: 'medium' },
  max_output_tokens: 256,
  stream: true,
};

test('pickBridge routes responses→openai to the real bridge', () => {
  const bridge = pickBridge('responses', 'openai');
  assert.equal(bridge.clientProto, 'responses');
  assert.equal(bridge.upstreamProto, 'openai');
  assert.equal(bridge.rewriteUrlPath('/v1/responses'), '/v1/chat/completions');
  assert.equal(bridge.rewriteUrlPath('/v1/responses?x=1'), '/v1/responses?x=1');
});

test('responses→openai: transformRequest lowers the body and records the tool mapping', () => {
  const bridge = pickBridge('responses', 'openai');
  const body = bridge.transformRequest(structuredClone(RESPONSES_REQUEST)) as any;
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal(body.max_completion_tokens, 256);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(
    body.messages.map((m: any) => m.role),
    ['system', 'user', 'assistant', 'tool'],
  );
  assert.equal(body.messages[2].reasoning_content, 'plan');
  assert.equal(body.messages[2].tool_calls[0].function.name, 'exec');
  assert.equal(body.tools[0].function.name, 'exec');
});

test('responses→openai: transformResponse restores custom tool calls via the recorded mapping', () => {
  const bridge = pickBridge('responses', 'openai');
  bridge.transformRequest(structuredClone(RESPONSES_REQUEST));
  const envelope = bridge.transformResponse({
    id: 'chatcmpl-1',
    model: 'deepseek-v4-pro',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'c2', type: 'function', function: { name: 'exec', arguments: '{"input":"ls -la"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }) as any;
  assert.equal(envelope.object, 'response');
  assert.equal(envelope.status, 'completed');
  assert.equal(envelope.model, 'deepseek-v4-pro');
  // Without transformRequest first, the same call would stay a function_call.
  assert.equal(envelope.output[0].type, 'custom_tool_call');
  assert.equal(envelope.output[0].name, 'exec');
  assert.equal(envelope.output[0].input, 'ls -la');
});

test('responses→openai: transformStream converts CC SSE into Responses SSE with finalize + usage', async () => {
  const bridge = pickBridge('responses', 'openai');
  bridge.transformRequest(structuredClone(RESPONSES_REQUEST));
  const { clientStream, usage } = bridge.transformStream(
    ccSseBytes([
      {
        id: 'chatcmpl-s1',
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }],
      },
      { id: 'chatcmpl-s1', choices: [{ index: 0, delta: { content: 'hello' } }] },
      {
        id: 'chatcmpl-s1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ]),
  );

  const text = await readAll(clientStream);
  const events = parseSseLines(text);
  const types = events.map((e) => e.type);

  // created → reasoning lifecycle → message lifecycle → completed.
  assert.equal(types[0], 'response.created');
  assert.ok(types.includes('response.reasoning_summary_text.delta'));
  assert.ok(types.includes('response.output_text.delta'));
  assert.equal(types[types.length - 1], 'response.completed');

  const completed = events[events.length - 1];
  assert.equal(completed.response.id, 'chatcmpl-s1');
  assert.equal(completed.response.status, 'completed');
  assert.equal(completed.response.usage.input_tokens, 9);
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 6);
  // sequence_number is present and monotonic.
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence_number > events[i - 1].sequence_number);
  }
  // The upstream [DONE] sentinel is not forwarded to the Responses client.
  assert.ok(!text.includes('[DONE]'));

  assert.deepEqual(await usage, { inputTokens: 9, outputTokens: 4, cacheReadTokens: 6 });
});

test('responses→openai: transformStream finalizes a stream cut before the terminal chunk', async () => {
  const bridge = pickBridge('responses', 'openai');
  bridge.transformRequest(structuredClone(RESPONSES_REQUEST));
  const { clientStream, usage } = bridge.transformStream(
    ccSseBytes([{ id: 'chatcmpl-s2', model: 'm', choices: [{ index: 0, delta: { content: 'partial' } }] }]),
  );
  const events = parseSseLines(await readAll(clientStream));
  const types = events.map((e) => e.type);
  assert.equal(types[types.length - 1], 'response.completed', '断流 must still emit response.completed');
  assert.equal(events[events.length - 1].response.output[0].content[0].text, 'partial');
  assert.deepEqual(await usage, {});
});

test('responses→openai: transformStream ends without a terminal event on truncated tool arguments', async () => {
  const bridge = pickBridge('responses', 'openai');
  bridge.transformRequest(structuredClone(RESPONSES_REQUEST));
  const { clientStream, usage } = bridge.transformStream(
    ccSseBytes([
      {
        id: 'chatcmpl-s3',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'exec_command', arguments: '{"cmd": "ssh root@HOST' },
                },
              ],
            },
          },
        ],
      },
      { id: 'chatcmpl-s3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  );
  const events = parseSseLines(await readAll(clientStream));
  const types = events.map((e) => e.type);
  // The tool call was announced but never finalized: emitting a completed
  // item with invalid JSON would poison the next turn.
  assert.ok(types.includes('response.output_item.added'));
  assert.ok(!types.includes('response.output_item.done'));
  assert.ok(!types.includes('response.completed'));
  assert.deepEqual(await usage, {});
});

test('responses→openai: wrapError keeps the OpenAI-family error envelope', () => {
  const bridge = pickBridge('responses', 'openai');
  const err429 = bridge.wrapError(429, 'slow down');
  assert.deepEqual(err429.body, { error: { message: 'slow down', type: 'rate_limit_exceeded', code: null } });
  const err502 = bridge.wrapError(502, 'upstream gone');
  assert.deepEqual(err502.body, { error: { message: 'upstream gone', type: 'server_error', code: null } });
});
