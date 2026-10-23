import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsesToGeminiBridge, GeminiToResponsesBridge } from '../../src/protocol/responses-gemini.js';
import { UnsupportedBridgeFeatureError } from '../../src/protocol/openai-gemini.js';

function source(events: any[], bytewise = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  let offset = 0;
  return new ReadableStream({ pull(c) { if (offset === bytes.length) return c.close(); const end = bytewise ? offset + 1 : bytes.length; c.enqueue(bytes.slice(offset, end)); offset = end; } });
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const text = await new Response(stream).text();
  return text.split(/\n\n/).filter(Boolean).map(x => JSON.parse(x.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')));
}
test('Responses Gemini direct requests preserve parallel call ids across two tool rounds', () => {
  const bridge = new ResponsesToGeminiBridge();
  const input: any[] = [{ role: 'user', content: 'go' }];
  for (const round of [1,2]) {
    for (const id of ['a','b']) input.push({ type: 'function_call', id: `fc_${round}_${id}`, call_id: `call_${round}_${id}`, name: 'same', arguments: '{"x":1}' });
    for (const id of ['b','a']) input.push({ type: 'function_call_output', call_id: `call_${round}_${id}`, output: id });
  }
  const result = bridge.transformRequest({ model: 'gemini', input });
  const calls = result.contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionCall);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map((p: any) => p.functionCall.id)).size, 4);
  const reverse = new GeminiToResponsesBridge(); reverse.rewriteUrlPath('/v1beta/models/gemini:generateContent');
  const back = reverse.transformRequest(result);
  assert.deepEqual(back.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => x.call_id), ['call_1_b','call_1_a','call_2_b','call_2_a']);
});
test('Responses Gemini direct stream handles split UTF8, stable independent tools, final usage', async () => {
  const bridge = new ResponsesToGeminiBridge();
  const result = bridge.transformStream(source([
    { responseId: 'r1', candidates: [{ content: { parts: [{ text: '你好' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'same', args: { x: 1 } } }, { functionCall: { name: 'same', args: { x: 2 } } }] }, finishReason: 'STOP' }] },
    { usageMetadata: { promptTokenCount: 7 } },
  ], true));
  const events = await collect(result.clientStream);
  assert.equal(events.find(x => x.type === 'response.output_text.delta').delta, '你好');
  const completed = events.at(-1).response;
  const calls = completed.output.filter((x: any) => x.type === 'function_call');
  assert.notEqual(calls[0].id, calls[0].call_id);
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  assert.equal(completed.id, 'r1'); assert.equal(completed.usage.input_tokens, 7);
  assert.equal(completed.usage.output_tokens, undefined);
  assert.deepEqual(await result.usage, { inputTokens: 7 });
});
test('Responses Gemini rejects opaque reasoning, continuation, media and ambiguous results', () => {
  const b = new ResponsesToGeminiBridge();
  for (const body of [{ model: 'm', input: '', previous_response_id: 'secret' }, { model: 'm', input: [{ type: 'reasoning', encrypted_content: 'secret' }] }]) {
    assert.throws(() => b.transformRequest(body), (e: any) => e instanceof UnsupportedBridgeFeatureError && !e.message.includes('secret'));
  }
  const reverse = new GeminiToResponsesBridge();
  assert.throws(() => reverse.transformRequest({ contents: [{ role: 'model', parts: [{ text: 'x', thoughtSignature: 'secret' }] }] }), UnsupportedBridgeFeatureError);
  assert.throws(() => reverse.transformRequest({ contents: [{ role: 'model', parts: [{ functionCall: { name: 'f' } }, { functionCall: { name: 'f' } }] }, { role: 'user', parts: [{ functionResponse: { name: 'f', response: {} } }] }] }), UnsupportedBridgeFeatureError);
});
test('Responses Gemini stream cancellation propagates and resolves usage', async () => {
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled = true; } });
  const result = new ResponsesToGeminiBridge().transformStream(upstream);
  await result.clientStream.cancel('stop');
  assert.equal(cancelled, true); assert.deepEqual(await result.usage, {});
});
test('Gemini Responses direct fragmented tool events keep argument and call identity', async () => {
  const result = new GeminiToResponsesBridge().transformStream(source([
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'f' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta: '{"x":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta: '1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"x":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'f', arguments: '{"x":1}' } },
    { type: 'response.completed', response: { id: 'r', model: 'm', status: 'completed', usage: { output_tokens: 3 } } },
  ], true));
  const events = await collect(result.clientStream);
  assert.deepEqual(events[0].candidates[0].content.parts[0], { functionCall: { id: 'call', name: 'f', args: { x: 1 } } });
  assert.equal(events.at(-1).candidates[0].finishReason, 'STOP');
  assert.equal(events.at(-1).usageMetadata.promptTokenCount, undefined);
  assert.equal((await result.usage).outputTokens, 3);
});
