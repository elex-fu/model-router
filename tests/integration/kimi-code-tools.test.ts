import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { finalizeStream, type SseEvent } from '../../src/protocol/sse.js';
import { ADD_TOOL, readToolResponse, startKimiToolProxy } from './kimi-code-tools-helpers.js';

function nativeStream(content: any[], stopReason: string): Uint8Array {
  const event = (name: string, value: Record<string, unknown>): SseEvent => ({
    event: name,
    data: JSON.stringify(value),
  });
  const events = [
    event('message_start', {
      message: { id: 'fixture-message', model: 'kimi-for-coding', usage: { input_tokens: 12, output_tokens: 0 } },
    }),
  ];
  for (const [index, block] of content.entries()) {
    const value = structuredClone(block);
    if (block.type === 'thinking') {
      value.thinking = '';
      delete value.signature;
    }
    if (block.type === 'text') value.text = '';
    if (block.type === 'tool_use') value.input = {};
    events.push(event('content_block_start', { index, content_block: value }));
    if (block.type === 'thinking') {
      events.push(event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } }));
      events.push(
        event('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } }),
      );
    } else if (block.type === 'text') {
      events.push(event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } }));
    } else if (block.type === 'tool_use') {
      events.push(
        event('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    events.push(event('content_block_stop', { index }));
  }
  events.push(event('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 9 } }));
  events.push(event('message_stop', {}));
  return finalizeStream(events);
}

test('V2 routed Kimi bridge sends explicit thinking controls and replays automatic/forced tool history in JSON/SSE', async (t) => {
  const firstRequestWithoutStream = new Map<string, string>();
  for (const streaming of [false, true]) {
    for (const control of ['auto', 'native-disabled', 'effort-none']) {
      await t.test(`${streaming ? 'SSE' : 'JSON'} ${control}`, async () => {
        const automatic = control === 'auto';
        const thought = { type: 'thinking', thinking: 'Add the two operands.', signature: 'fixture-signed-thought' };
        const toolUse = { type: 'tool_use', id: 'call_add', name: 'add', input: { a: 2, b: 3 } };
        const content = automatic
          ? [thought, { type: 'redacted_thinking', data: 'fixture-redacted' }, toolUse]
          : [toolUse];
        const calls: Array<{ url: string; body: any }> = [];
        const upstream = http.createServer(async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          calls.push({ url: req.url ?? '', body });
          const first = calls.length === 1;
          const resultContent = first ? content : [{ type: 'text', text: '5' }];
          const stopReason = first ? 'tool_use' : 'end_turn';
          res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
          res.end(
            body.stream
              ? nativeStream(resultContent, stopReason)
              : JSON.stringify({
                  id: 'fixture-message',
                  type: 'message',
                  role: 'assistant',
                  model: 'kimi-for-coding',
                  content: resultContent,
                  stop_reason: stopReason,
                  usage: { input_tokens: 12, output_tokens: 9 },
                }),
          );
        });
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const address = upstream.address();
        assert.ok(address && typeof address !== 'string');
        const proxy = await startKimiToolProxy({
          baseUrl: `http://127.0.0.1:${address.port}/coding/v1`,
          observeUpstream: true,
        });
        try {
          const controls =
            control === 'effort-none'
              ? { reasoning_effort: 'none' }
              : { thinking: { type: automatic ? 'enabled' : 'disabled' } };
          const initial = [{ role: 'user', content: 'Add 2 and 3.' }];
          const response = await proxy.request({
            ...controls,
            stream: streaming,
            messages: initial,
            tools: [ADD_TOOL],
            tool_choice: automatic ? 'auto' : { type: 'function', function: { name: 'add' } },
          });
          assert.equal(response.status, 200);
          const first = await readToolResponse(response, streaming);
          assert.equal(first.finishReason, 'tool_calls');
          assert.equal(first.done, true);
          assert.deepEqual(first.message.tool_calls?.[0], {
            id: 'call_add',
            type: 'function',
            function: { name: 'add', arguments: '{"a":2,"b":3}' },
          });
          if (automatic) {
            assert.equal(first.message.reasoning_content, thought.thinking);
            assert.deepEqual(first.message.anthropic_content, content);
          }
          const secondResponse = await proxy.request({
            ...controls,
            stream: streaming,
            tools: [ADD_TOOL],
            tool_choice: 'none',
            messages: [...initial, first.message, { role: 'tool', tool_call_id: 'call_add', content: '5' }],
          });
          assert.equal(secondResponse.status, 200);
          const second = await readToolResponse(secondResponse, streaming);
          assert.equal(second.message.content, '5');
          assert.equal(second.finishReason, 'stop');
          assert.equal(second.done, true);
          assert.equal(calls.length, 2);
          assert.equal(proxy.upstreamSummaries[0].thinkingType, automatic ? 'enabled' : 'disabled');
          assert.equal(proxy.upstreamSummaries[0].toolChoiceType, automatic ? 'auto' : 'any');
          if (!automatic) {
            assert.deepEqual(proxy.upstreamSummaries[0].toolNames, ['add']);
            assert.equal(proxy.upstreamSummaries[0].selectedToolDeclared, true);
          }
          const outbound = structuredClone(calls[0].body);
          delete outbound.stream;
          if (!streaming) firstRequestWithoutStream.set(control, JSON.stringify(outbound));
          else
            assert.equal(
              JSON.stringify(outbound),
              firstRequestWithoutStream.get(control),
              'JSON and SSE requests differ only in stream',
            );
          assert.deepEqual(proxy.upstreamSummaries[0].stopReasons, ['tool_use']);
          assert.equal(proxy.upstreamSummaries[0].blocks.tool_use, 1);
          assert.equal(JSON.stringify(proxy.upstreamSummaries).includes(thought.thinking), false);
          assert.equal(JSON.stringify(proxy.upstreamSummaries).includes(thought.signature), false);
          for (const call of calls) {
            assert.equal(call.url, '/coding/v1/messages');
            assert.equal(call.body.model, 'kimi-for-coding');
            assert.equal(call.body.max_tokens, 1024);
            assert.deepEqual(call.body.thinking, { type: automatic ? 'enabled' : 'disabled' });
          }
          assert.deepEqual(calls[0].body.tool_choice, automatic ? { type: 'auto' } : { type: 'any' });
          assert.deepEqual(calls[1].body.messages[1].content, content);
          assert.deepEqual(calls[1].body.messages[2].content, [
            { type: 'tool_result', tool_use_id: 'call_add', content: '5' },
          ]);
        } finally {
          await proxy.close();
          upstream.closeAllConnections();
          upstream.close();
          await once(upstream, 'close');
        }
      });
    }
  }
});

test('V2 Kimi named function must be declared before any upstream request is sent', async () => {
  let sent = 0;
  const upstream = http.createServer((_req, res) => {
    sent++;
    res.writeHead(500);
    res.end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = await startKimiToolProxy({ baseUrl: `http://127.0.0.1:${address.port}/coding/v1` });
  try {
    const response = await proxy.request({
      thinking: { type: 'disabled' },
      tools: [ADD_TOOL],
      tool_choice: { type: 'function', function: { name: 'undeclared' } },
      messages: [{ role: 'user', content: 'Call the selected tool.' }],
    });
    assert.equal(response.status, 400);
    assert.equal(sent, 0);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    upstream.close();
    await once(upstream, 'close');
  }
});
