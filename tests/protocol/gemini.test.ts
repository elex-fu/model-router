import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  anthropicToGeminiRequest,
  geminiToAnthropicResponse,
  geminiStreamToAnthropicStream,
} from '../../src/protocol/gemini.js';
import { GeminiShadowStore } from '../../src/protocol/gemini-shadow.js';

test('anthropicToGeminiRequest maps simple text message', () => {
  const { payload } = anthropicToGeminiRequest(
    { messages: [{ role: 'user', content: 'hi' }] },
    'gemini-pro'
  );
  assert.equal(payload.contents[0].role, 'user');
  assert.equal(payload.contents[0].parts[0].text, 'hi');
});

test('anthropicToGeminiRequest maps assistant to model', () => {
  const { payload } = anthropicToGeminiRequest(
    { messages: [{ role: 'assistant', content: 'hello' }] },
    'gemini-pro'
  );
  assert.equal(payload.contents[0].role, 'model');
  assert.equal(payload.contents[0].parts[0].text, 'hello');
});

test('anthropicToGeminiRequest maps system prompt', () => {
  const { payload } = anthropicToGeminiRequest(
    { system: 'sys', messages: [] },
    'gemini-pro'
  );
  assert.equal(payload.systemInstruction.parts[0].text, 'sys');
});

test('anthropicToGeminiRequest maps array system blocks', () => {
  const { payload } = anthropicToGeminiRequest(
    { system: [{ type: 'text', text: 'sys1' }, { type: 'text', text: 'sys2' }], messages: [] },
    'gemini-pro'
  );
  assert.equal(payload.systemInstruction.parts[0].text, 'sys1');
  assert.equal(payload.systemInstruction.parts[1].text, 'sys2');
});

test('anthropicToGeminiRequest maps image blocks', () => {
  const { payload } = anthropicToGeminiRequest(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { media_type: 'image/jpeg', data: 'base64data' } },
          ],
        },
      ],
    },
    'gemini-pro'
  );
  assert.equal(payload.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(payload.contents[0].parts[0].inlineData.data, 'base64data');
});

test('anthropicToGeminiRequest maps tools', () => {
  const { payload } = anthropicToGeminiRequest(
    {
      messages: [],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object' },
        },
      ],
    },
    'gemini-pro'
  );
  assert.equal(payload.tools[0].functionDeclarations[0].name, 'get_weather');
  assert.equal(payload.tools[0].functionDeclarations[0].description, 'Get weather');
});

test('anthropicToGeminiRequest sets generationConfig', () => {
  const { payload } = anthropicToGeminiRequest(
    { messages: [], max_tokens: 100, temperature: 0.5, top_p: 0.9 },
    'gemini-pro'
  );
  assert.equal(payload.generationConfig.maxOutputTokens, 100);
  assert.equal(payload.generationConfig.temperature, 0.5);
  assert.equal(payload.generationConfig.topP, 0.9);
});

test('anthropicToGeminiRequest builds non-streaming url', () => {
  const { urlPath } = anthropicToGeminiRequest({ messages: [] }, 'gemini-pro');
  assert.ok(urlPath.includes('/v1beta/models/gemini-pro:generateContent'));
  assert.ok(!urlPath.includes('?alt=sse'));
});

test('anthropicToGeminiRequest builds streaming url', () => {
  const { urlPath } = anthropicToGeminiRequest({ messages: [], stream: true }, 'gemini-pro');
  assert.ok(urlPath.includes('?alt=sse'));
});

test('geminiToAnthropicResponse maps text candidate', () => {
  const res = geminiToAnthropicResponse({
    candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  });
  assert.equal(res.content[0].text, 'hello');
  assert.equal(res.usage.input_tokens, 5);
  assert.equal(res.usage.output_tokens, 2);
  assert.equal(res.stop_reason, 'end_turn');
});

test('geminiToAnthropicResponse maps functionCall to tool_use', () => {
  const res = geminiToAnthropicResponse({
    candidates: [
      {
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
  assert.equal(res.content[0].type, 'tool_use');
  assert.equal(res.content[0].name, 'get_weather');
  assert.deepEqual(res.content[0].input, { city: 'NYC' });
});

test('geminiToAnthropicResponse handles non-STOP finishReason', () => {
  const res = geminiToAnthropicResponse({
    candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: {},
  });
  assert.equal(res.stop_reason, 'stop_sequence');
});

test('geminiStreamToAnthropicStream maps text delta', () => {
  const store = new GeminiShadowStore();
  const events = geminiStreamToAnthropicStream('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}', store);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'content_block_delta');
  assert.equal(events[0].delta.type, 'text_delta');
  assert.equal(events[0].delta.text, 'hi');
});

test('geminiStreamToAnthropicStream maps functionCall to tool_use events', () => {
  const store = new GeminiShadowStore();
  const events = geminiStreamToAnthropicStream('data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"NYC"}}}]}}]}', store);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'content_block_start');
  assert.equal(events[0].content_block.type, 'tool_use');
  assert.equal(events[0].content_block.name, 'get_weather');
  assert.equal(events[1].type, 'content_block_delta');
  assert.equal(events[1].delta.type, 'input_json_delta');
  assert.ok(events[1].delta.partial_json.includes('NYC'));
});

test('geminiStreamToAnthropicStream ignores non-data lines', () => {
  const store = new GeminiShadowStore();
  const events = geminiStreamToAnthropicStream(': keep-alive', store);
  assert.equal(events.length, 0);
});

test('geminiStreamToAnthropicStream ignores empty data', () => {
  const store = new GeminiShadowStore();
  const events = geminiStreamToAnthropicStream('data: ', store);
  assert.equal(events.length, 0);
});

test('geminiStreamToAnthropicStream tool IDs are stable via shadow store', () => {
  const store = new GeminiShadowStore();
  const line = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"fn","args":{}}}]}}]}';
  geminiStreamToAnthropicStream(line, store);
  const snapshot = store.snapshot();
  const ids = Object.keys(snapshot);
  assert.equal(ids.length, 1);
  assert.ok(ids[0].startsWith('toolu_'));
  assert.equal(snapshot[ids[0]].name, 'fn');
});
