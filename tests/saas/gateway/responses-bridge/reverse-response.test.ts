import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ChatCompletionsToResponsesStream,
  chatCompletionsResponseToResponses,
  chatCompletionsUsageToResponsesUsage,
} from '../../../../src/saas/gateway/responses-bridge/reverse-response.js';

const FIXTURES = join(fileURLToPath(import.meta.url), '..', 'testdata', 'issue5302');

function readFixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const NOW = () => Date.parse('2099-01-01T00:00:00.000Z');

function collectStreamEvents(
  chunks: readonly any[],
  mapping: Partial<Record<'customTools' | 'functionTools', Set<string>>> & { toolSearch?: boolean } = {},
): Record<string, any>[] {
  const state = new ChatCompletionsToResponsesStream({
    model: 'deepseek-v4-pro',
    customTools: mapping.customTools ?? new Set<string>(),
    functionTools: mapping.functionTools ?? new Set<string>(),
    toolSearch: mapping.toolSearch ?? false,
    namespaceTools: new Map(),
    nowMs: NOW,
  });
  const events: Record<string, any>[] = [];
  for (const chunk of chunks) {
    events.push(...state.push(chunk));
  }
  events.push(...state.finalize());
  return events;
}

function eventsOf(events: readonly Record<string, any>[], type: string): Record<string, any>[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// non-streaming envelope
// ---------------------------------------------------------------------------

test('envelope: text + tool calls + reasoning restore, length → incomplete', () => {
  const out = chatCompletionsResponseToResponses(
    {
      id: 'chatcmpl-1',
      created: 1700000000,
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'final answer',
            reasoning_content: 'because',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      model: 'requested-model',
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: false,
      namespaceTools: new Map(),
      nowMs: NOW,
    },
  );
  assert.equal(out.object, 'response');
  assert.equal(out.model, 'requested-model');
  assert.equal(out.status, 'completed');
  assert.deepEqual(
    out.output.map((item: any) => item.type),
    ['reasoning', 'message', 'function_call'],
  );
  assert.equal(out.output[0].summary[0].text, 'because');
  assert.equal(out.output[1].content[0].text, 'final answer');
  assert.equal(out.output[2].call_id, 'call_1');
  assert.equal(out.output[2].arguments, '{"city":"NYC"}');
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });

  const lengthOut = chatCompletionsResponseToResponses(
    {
      id: 'chatcmpl-2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
    },
    {
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: false,
      namespaceTools: new Map(),
      nowMs: NOW,
    },
  );
  assert.equal(lengthOut.status, 'incomplete');
  assert.deepEqual(lengthOut.incomplete_details, { reason: 'max_output_tokens' });
});

test('envelope: reasoning-only response falls back to visible text', () => {
  const out = chatCompletionsResponseToResponses(
    {
      id: 'chatcmpl-3',
      choices: [
        { index: 0, message: { role: 'assistant', reasoning_content: 'only thinking' }, finish_reason: 'stop' },
      ],
    },
    {
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: false,
      namespaceTools: new Map(),
      nowMs: NOW,
    },
  );
  assert.deepEqual(
    out.output.map((item: any) => item.type),
    ['reasoning', 'message'],
  );
  assert.equal(out.output[1].content[0].text, 'only thinking');
});

test('envelope: tool-call message without text keeps no message item', () => {
  const out = chatCompletionsResponseToResponses(
    {
      id: 'chatcmpl-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    {
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: false,
      namespaceTools: new Map(),
      nowMs: NOW,
    },
  );
  assert.deepEqual(
    out.output.map((item: any) => item.type),
    ['function_call'],
  );
});

test('envelope: invalid function arguments are skipped, valid siblings survive (length → incomplete)', () => {
  const out = chatCompletionsResponseToResponses(
    {
      model: 'deepseek-v4-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd": "ssh root@HOST' },
              },
              { id: 'call_ok', type: 'function', function: { name: 'exec_command', arguments: '{}' } },
            ],
          },
          finish_reason: 'length',
        },
      ],
    },
    {
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: false,
      namespaceTools: new Map(),
      nowMs: NOW,
    },
  );
  assert.equal(out.status, 'incomplete');
  assert.equal(out.output.length, 1);
  assert.equal(out.output[0].call_id, 'call_ok');
  assert.equal(out.output[0].arguments, '{}');
});

test('envelope: custom / tool_search / namespace tool calls are restored by the request mapping', () => {
  const out = chatCompletionsResponseToResponses(
    {
      id: 'chatcmpl-5',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"input":"ls -la"}' } },
              { id: 'c2', type: 'function', function: { name: 'tool_search', arguments: '{"query":"mcp"}' } },
              { id: 'c3', type: 'function', function: { name: 'mcp__read', arguments: '{"path":"x"}' } },
              { id: 'c4', type: 'function', function: { name: 'plain', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    {
      customTools: new Set(['exec']),
      functionTools: new Set(['plain']),
      toolSearch: true,
      namespaceTools: new Map([['mcp__read', { namespace: 'mcp', name: 'read' }]]),
      nowMs: NOW,
    },
  );
  assert.deepEqual(
    out.output.map((item: any) => item.type),
    ['custom_tool_call', 'tool_search_call', 'function_call', 'function_call'],
  );
  assert.equal(out.output[0].name, 'exec');
  assert.equal(out.output[0].input, 'ls -la');
  assert.equal(out.output[1].execution, 'client');
  assert.deepEqual(out.output[1].arguments, { query: 'mcp' });
  assert.equal(out.output[2].name, 'read');
  assert.equal(out.output[2].namespace, 'mcp');
  assert.equal(out.output[3].name, 'plain');
});

test('envelope: null upstream body still yields a well-formed empty response', () => {
  const out = chatCompletionsResponseToResponses(null, {
    customTools: new Set<string>(),
    functionTools: new Set<string>(),
    toolSearch: false,
    namespaceTools: new Map(),
    model: 'm',
    nowMs: NOW,
  });
  assert.equal(out.object, 'response');
  assert.equal(out.status, 'completed');
  assert.deepEqual(
    out.output.map((item: any) => item.type),
    ['message'],
  );
});

test('usage: chat → responses mapping with cached / cache-write tokens', () => {
  const usage = chatCompletionsUsageToResponsesUsage({
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  assert.deepEqual(usage, {
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    cache_creation_input_tokens: 0,
    input_tokens_details: { cached_tokens: 40 },
  });

  const writeUsage = chatCompletionsUsageToResponsesUsage({
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cache_write_tokens: 7 },
  });
  assert.equal(writeUsage?.cache_creation_input_tokens, 7);
  assert.deepEqual(writeUsage?.input_tokens_details, { cache_write_tokens: 7 });

  // total falls back to input + output when the upstream omits it.
  const fallback = chatCompletionsUsageToResponsesUsage({ prompt_tokens: 3, completion_tokens: 4 });
  assert.equal(fallback?.total_tokens, 7);
  assert.equal(chatCompletionsUsageToResponsesUsage(undefined), null);
});

// ---------------------------------------------------------------------------
// streaming (ported from chatcompletions_responses_stream_lifecycle_test.go)
// ---------------------------------------------------------------------------

test('stream: reasoning item opens before its first delta', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'think' } }] },
    { choices: [{ index: 0, delta: { content: 'hello' } }] },
    {
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ]);
  const open = new Map<number, string>();
  for (const e of events) {
    if (e.type === 'response.output_item.added') open.set(e.output_index, e.item.type);
    if (e.type === 'response.reasoning_summary_text.delta') {
      assert.equal(open.get(e.output_index), 'reasoning', 'reasoning delta before its item was opened');
    }
    if (e.type === 'response.output_text.delta') {
      assert.equal(open.get(e.output_index), 'message', 'text delta before its item was opened');
    }
  }
  assert.equal(eventsOf(events, 'response.created').length, 1);
});

test('stream: reasoning-only stream synthesizes visible text', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'thinking before final' } }] },
    {
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ]);
  let sawTextDelta = false;
  let sawTextDone = false;
  let sawMessageDone = false;
  for (const e of events) {
    if (e.type === 'response.output_text.delta') {
      sawTextDelta = true;
      assert.equal(e.delta, 'thinking before final');
    }
    if (e.type === 'response.output_text.done') {
      sawTextDone = true;
      assert.equal(e.text, 'thinking before final');
    }
    if (e.type === 'response.output_item.done' && e.item?.type === 'message') {
      sawMessageDone = true;
      assert.equal(e.item.content[0].text, 'thinking before final');
    }
    if (e.type === 'response.completed') {
      assert.equal(e.response.status, 'incomplete');
      assert.deepEqual(e.response.incomplete_details, { reason: 'max_output_tokens' });
      assert.equal(e.response.output.length, 2);
      assert.equal(e.response.output[0].type, 'reasoning');
      assert.equal(e.response.output[1].type, 'message');
      assert.equal(e.response.output[1].content[0].text, 'thinking before final');
    }
  }
  assert.ok(sawTextDelta && sawTextDone && sawMessageDone);
});

test('stream: blank reasoning-only stream does not synthesize visible text', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { reasoning_content: '   ' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
  for (const e of events) {
    assert.notEqual(e.type, 'response.output_text.delta');
    if (e.type === 'response.completed') {
      assert.equal(e.response.output.length, 2);
      // Wire shape omits an empty text (omitempty), same as the Go marshal.
      assert.equal(e.response.output[1].content[0].text ?? '', '');
    }
  }
});

test('stream: reasoning then content does not duplicate fallback text', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { reasoning_content: 'private plan' } }] },
    { choices: [{ index: 0, delta: { content: 'final answer' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
  assert.deepEqual(
    eventsOf(events, 'response.output_text.delta').map((e) => e.delta),
    ['final answer'],
  );
  const completed = eventsOf(events, 'response.completed')[0];
  assert.equal(completed.response.output[0].summary[0].text, 'private plan');
  assert.equal(completed.response.output[1].content[0].text, 'final answer');
});

test('stream: reasoning then tool call does not synthesize visible text', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { reasoning_content: 'call a tool' } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'exec', arguments: '{}' } }],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  for (const e of events) assert.notEqual(e.type, 'response.output_text.delta');
  const completed = eventsOf(events, 'response.completed')[0];
  assert.equal(completed.response.output.length, 2);
  assert.equal(completed.response.output[0].type, 'reasoning');
  assert.equal(completed.response.output[1].type, 'function_call');
});

test('stream: tool call lifecycle is complete (added + arguments.done + item.done)', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'plan' } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'exec', arguments: '' } }],
          },
        },
      ],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ]);
  let sawAdded = false;
  let sawArgsDone = false;
  let sawItemDone = false;
  for (const e of events) {
    if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') sawAdded = true;
    if (e.type === 'response.function_call_arguments.done') {
      sawArgsDone = true;
      assert.equal(e.arguments, '{"cmd":"ls"}');
    }
    if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
      sawItemDone = true;
      assert.equal(e.item.arguments, '{"cmd":"ls"}');
      assert.equal(e.item.call_id, 'call_a');
    }
  }
  assert.ok(sawAdded && sawArgsDone && sawItemDone);
});

test('stream: tool_call arguments packed into the first chunk are not doubled (GLM shape)', () => {
  const events = collectStreamEvents([
    { choices: [{ index: 0, delta: { role: 'assistant' } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', type: 'function', function: { name: 'exec', arguments: '{"cmd":"ls"}' } },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  let argsDelta = '';
  for (const e of events) {
    if (e.type === 'response.function_call_arguments.delta') argsDelta += e.delta;
    if (e.type === 'response.function_call_arguments.done') assert.equal(e.arguments, '{"cmd":"ls"}');
    if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
      assert.equal(e.item.arguments, '{"cmd":"ls"}');
    }
  }
  assert.equal(argsDelta, '{"cmd":"ls"}', 'accumulated deltas must equal the final arguments exactly');
});

test('stream: added function_call event carries arguments:"" on the wire', () => {
  const events = collectStreamEvents([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'exec', arguments: '{}' } }],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const added = eventsOf(events, 'response.output_item.added').find((e) => e.item?.type === 'function_call');
  assert.ok(added);
  const wire = JSON.stringify(added);
  assert.ok(wire.includes('"arguments":""'), `added line missing arguments: ${wire}`);
  assert.ok(wire.includes('"call_id":"call_a"'));
  // sequence_number is always present, even at zero.
  assert.ok(wire.includes('"sequence_number"'));
});

test('stream: invalid tool arguments are rejected before finalize', () => {
  const state = new ChatCompletionsToResponsesStream({
    model: 'deepseek-v4-flash',
    customTools: new Set<string>(),
    functionTools: new Set<string>(),
    toolSearch: false,
    namespaceTools: new Map(),
    nowMs: NOW,
  });
  state.push({
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
  });
  assert.match(state.validateToolCallArguments() ?? '', /invalid JSON/);
});

test('stream: valid tool call at the output limit keeps an incomplete response', () => {
  const state = new ChatCompletionsToResponsesStream({
    model: 'deepseek-v4-flash',
    customTools: new Set<string>(),
    functionTools: new Set<string>(),
    toolSearch: false,
    namespaceTools: new Map(),
    nowMs: NOW,
  });
  state.push({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_at_limit', type: 'function', function: { name: 'exec_command', arguments: '{}' } },
          ],
        },
      },
    ],
  });
  state.push({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
  assert.equal(state.validateToolCallArguments(), null);
  const events = state.finalize();
  const argsDone = eventsOf(events, 'response.function_call_arguments.done')[0];
  assert.equal(argsDone.arguments, '{}');
  const completed = eventsOf(events, 'response.completed')[0];
  assert.equal(completed.response.status, 'incomplete');
});

test('stream: finalize is idempotent (断流 finalize 补 finish)', () => {
  // Stream cut without a terminal chunk: finalize must synthesize the
  // response.completed event exactly once.
  const state = new ChatCompletionsToResponsesStream({
    model: 'm',
    customTools: new Set<string>(),
    functionTools: new Set<string>(),
    toolSearch: false,
    namespaceTools: new Map(),
    nowMs: NOW,
  });
  state.push({ choices: [{ index: 0, delta: { content: 'partial' } }] });
  const first = state.finalize();
  assert.equal(eventsOf(first, 'response.completed').length, 1);
  assert.equal(first.length > 0, true);
  assert.deepEqual(state.finalize(), [], 'second finalize must be a no-op');
});

test('stream: custom tool call restores the custom_tool_call lifecycle', () => {
  const events = collectStreamEvents(
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_p', type: 'function', function: { name: 'apply_patch', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"input":"*** Begin Patch"}' } }] },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
    { customTools: new Set(['apply_patch']) },
  );
  const added = eventsOf(events, 'response.output_item.added').find((e) => e.item?.type === 'custom_tool_call');
  assert.ok(added, 'custom tool must be announced as custom_tool_call');
  assert.equal(added.item.name, 'apply_patch');
  const done = eventsOf(events, 'response.custom_tool_call_input.done')[0];
  assert.equal(done.input, '*** Begin Patch');
  const itemDone = eventsOf(events, 'response.output_item.done').find((e) => e.item?.type === 'custom_tool_call');
  assert.equal(itemDone.item.input, '*** Begin Patch');
  // custom 工具的参数增量不在流中下发，只在收尾一次性交付。
  assert.equal(eventsOf(events, 'response.function_call_arguments.delta').length, 0);
  const completed = eventsOf(events, 'response.completed')[0];
  assert.equal(completed.response.output[0].type, 'custom_tool_call');
  assert.equal(completed.response.output[0].input, '*** Begin Patch');
});

test('stream: tool_search calls restore the tool_search_call item shape', () => {
  const events = (() => {
    const state = new ChatCompletionsToResponsesStream({
      model: 'm',
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: true,
      namespaceTools: new Map(),
      nowMs: NOW,
    });
    const collected: Record<string, any>[] = [];
    collected.push(
      ...state.push({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'ts1',
                  type: 'function',
                  function: { name: 'tool_search', arguments: '{"query":"mcp"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    collected.push(...state.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    collected.push(...state.finalize());
    return collected;
  })();
  const added = eventsOf(events, 'response.output_item.added').find((e) => e.item?.type === 'tool_search_call');
  assert.ok(added);
  assert.equal(added.item.execution, 'client');
  assert.deepEqual(added.item.arguments, {});
  const itemDone = eventsOf(events, 'response.output_item.done').find((e) => e.item?.type === 'tool_search_call');
  assert.equal(itemDone.item.execution, 'client');
  assert.deepEqual(itemDone.item.arguments, { query: 'mcp' });
  // tool_search 调用无参数增量事件。
  assert.equal(eventsOf(events, 'response.function_call_arguments.delta').length, 0);
});

test('stream: namespace tool calls restore name + namespace on added/done', () => {
  const events = (() => {
    const state = new ChatCompletionsToResponsesStream({
      model: 'm',
      customTools: new Set<string>(),
      functionTools: new Set<string>(),
      toolSearch: false,
      namespaceTools: new Map([['mcp__read', { namespace: 'mcp', name: 'read' }]]),
      nowMs: NOW,
    });
    const collected: Record<string, any>[] = [];
    collected.push(
      ...state.push({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', type: 'function', function: { name: 'mcp__read', arguments: '{"path":"x"}' } },
              ],
            },
          },
        ],
      }),
    );
    collected.push(...state.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    collected.push(...state.finalize());
    return collected;
  })();
  const added = eventsOf(events, 'response.output_item.added').find((e) => e.item?.type === 'function_call');
  assert.equal(added.item.name, 'read');
  assert.equal(added.item.namespace, 'mcp');
  const itemDone = eventsOf(events, 'response.output_item.done').find((e) => e.item?.type === 'function_call');
  assert.equal(itemDone.item.name, 'read');
  assert.equal(itemDone.item.namespace, 'mcp');
  const argsDelta = eventsOf(events, 'response.function_call_arguments.delta')[0];
  assert.equal(argsDelta.delta, '{"path":"x"}');
});

test('stream: late-announced tool call replays accumulated argument deltas', () => {
  // Arguments arrive before the name (announce deferred); the announce must
  // replay the accumulated arguments as one delta.
  const events = (() => {
    const state = new ChatCompletionsToResponsesStream({
      model: 'm',
      customTools: new Set(['apply_patch']),
      functionTools: new Set(['lookup']),
      toolSearch: false,
      namespaceTools: new Map(),
      nowMs: NOW,
    });
    const collected: Record<string, any>[] = [];
    collected.push(
      ...state.push({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }],
      }),
    );
    collected.push(
      ...state.push({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
      }),
    );
    collected.push(
      ...state.push({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'lookup' } }] } },
        ],
      }),
    );
    collected.push(...state.finalize());
    return collected;
  })();
  const added = eventsOf(events, 'response.output_item.added').find((e) => e.item?.type === 'function_call');
  assert.ok(added, 'announce must happen once the name arrives');
  assert.equal(added.item.name, 'lookup');
  const deltas = eventsOf(events, 'response.function_call_arguments.delta').map((e) => e.delta);
  assert.deepEqual(deltas, ['{"a":1}'], 'accumulated arguments are replayed at announce time');
  const done = eventsOf(events, 'response.function_call_arguments.done')[0];
  assert.equal(done.arguments, '{"a":1}');
});

test('stream: usage flows into response.completed and observedUsage', () => {
  const state = new ChatCompletionsToResponsesStream({
    model: 'm',
    customTools: new Set<string>(),
    functionTools: new Set<string>(),
    toolSearch: false,
    namespaceTools: new Map(),
    nowMs: NOW,
  });
  const events = [
    ...state.push({ choices: [{ index: 0, delta: { content: 'x' } }] }),
    ...state.push({
      id: 'chatcmpl-u',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 5 } },
    }),
    ...state.finalize(),
  ];
  const completed = eventsOf(events, 'response.completed')[0];
  assert.equal(completed.response.id, 'chatcmpl-u');
  assert.deepEqual(completed.response.usage, {
    input_tokens: 11,
    output_tokens: 7,
    total_tokens: 18,
    cache_creation_input_tokens: 0,
    input_tokens_details: { cached_tokens: 5 },
  });
  assert.equal(state.observedUsage?.input_tokens, 11);
});

// Ported from chatcompletions_reasoning_alias_test.go + testdata/issue5302:
// the `reasoning` alias must behave exactly like `reasoning_content`.
test('stream + envelope: reasoning alias fixtures (issue5302)', () => {
  const streamChunk = readFixture('stream_reasoning.json');
  const events = collectStreamEvents([streamChunk]);
  assert.deepEqual(
    eventsOf(events, 'response.reasoning_summary_text.delta').map((e) => e.delta),
    ['streamed fallback'],
  );

  const precedenceChunk = readFixture('reasoning_content_precedence.json');
  const precedenceEvents = collectStreamEvents([precedenceChunk]);
  assert.deepEqual(
    eventsOf(precedenceEvents, 'response.reasoning_summary_text.delta').map((e) => e.delta),
    ['preferred reasoning'],
  );

  const nonStream = readFixture('nonstream_reasoning.json');
  const out = chatCompletionsResponseToResponses(nonStream, 'reasoning-model', {
    customTools: new Set<string>(),
    functionTools: new Set<string>(),
    toolSearch: false,
    namespaceTools: new Map(),
    nowMs: NOW,
  });
  assert.equal(out.output.length, 2);
  assert.equal(out.output[0].type, 'reasoning');
  assert.equal(out.output[0].summary[0].text, 'fallback reasoning');
  assert.equal(out.output[1].content[0].text, 'final answer');
});
