import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiToOpenAIBridge, OpenAIToGeminiBridge, UnsupportedBridgeFeatureError } from '../../src/protocol/openai-gemini.js';
import { normalizeUsage } from '../../src/providers/usage.js';

const encode = new TextEncoder();
function sse(events: any[]): ReadableStream<Uint8Array> {
  const bytes = encode.encode(events.map(x => `data: ${JSON.stringify(x)}\r\n\r\n`).join(''));
  let i = 0;
  return new ReadableStream({ pull(c) { if (i === bytes.length) c.close(); else c.enqueue(bytes.slice(i, ++i)); } });
}
async function read(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let text = '';
  while (true) { const r = await reader.read(); if (r.done) break; text += decoder.decode(r.value, { stream: true }); }
  return text.split('\n\n').filter(Boolean).map(x => x.slice(6)).filter(x => x !== '[DONE]').map(x => JSON.parse(x));
}
test('Chat/Gemini preserve two same-name tool IDs and results without name-only association', () => {
  const b = new OpenAIToGeminiBridge();
  const body = b.transformRequest({ model:'gemini',messages:[{role:'user',content:'天气'}, {role:'assistant',content:null,tool_calls:[{id:'a',type:'function',function:{name:'weather',arguments:'{"city":"A"}'}},{id:'b',type:'function',function:{name:'weather',arguments:'{"city":"B"}'}}]}, {role:'tool',tool_call_id:'b',content:'{"ok":true}'},{role:'tool',tool_call_id:'a',content:'sunny'}] });
  assert.equal(body.contents[1].parts[1].functionCall.id,'b');
  assert.deepEqual(body.contents[2].parts[0].functionResponse,{id:'b',name:'weather',response:{ok:true}});
  const reverse = new GeminiToOpenAIBridge(); reverse.rewriteUrlPath('/v1beta/models/gemini:generateContent');
  const chat = reverse.transformRequest(body);
  assert.equal(chat.messages[2].tool_call_id,'b'); assert.equal(chat.model,'gemini');
});
test('unsupported reasoning reports only safe field path and ambiguous tool output is rejected', () => {
  const b = new GeminiToOpenAIBridge();
  assert.throws(() => b.transformRequest({contents:[{role:'model',parts:[{text:'x',thoughtSignature:'private-value'}]}]}), (e:any) => e instanceof UnsupportedBridgeFeatureError && !e.message.includes('private-value'));
  assert.throws(() => b.transformRequest({contents:[{role:'model',parts:[{functionCall:{id:'a',name:'f'}},{functionCall:{id:'b',name:'f'}}]},{role:'user',parts:[{functionResponse:{name:'f',response:{}}}]}]}), UnsupportedBridgeFeatureError);
});
test('Gemini usageMetadata is normalized without body.usage', () => {
  assert.deepEqual(normalizeUsage('gemini',{usageMetadata:{promptTokenCount:12,candidatesTokenCount:3,cachedContentTokenCount:4}}),{inputTokens:12,outputTokens:3,cacheReadTokens:4});
});
test('fragmented UTF8 SSE converts Gemini tools, final reason, and usage', async () => {
  const b = new OpenAIToGeminiBridge(); b.transformRequest({model:'g',messages:[]});
  const result = b.transformStream(sse([{candidates:[{content:{parts:[{text:'你好'}]}}]}, {candidates:[{content:{parts:[{functionCall:{id:'x',name:'f',args:{a:1}}}]}}]}, {candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:4}}]));
  const chunks = await read(result.clientStream);
  assert.equal(chunks[0].choices[0].delta.content,'你好'); assert.equal(chunks[1].choices[0].delta.tool_calls[0].id,'x');
  assert.equal(chunks[2].choices[0].finish_reason,'tool_calls'); assert.equal((await result.usage).outputTokens,4);
});
test('Chat tool argument fragments are buffered until a genuine terminal and keep ID', async () => {
  const b = new GeminiToOpenAIBridge();
  const result = b.transformStream(sse([{choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'f',arguments:'{"a":'}}]}}]}, {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:'tool_calls'}]}, {choices:[],usage:{prompt_tokens:5,completion_tokens:2}}]));
  const chunks = await read(result.clientStream);
  assert.deepEqual(chunks[1].candidates[0].content.parts[0].functionCall,{id:'x',name:'f',args:{a:1}});
  assert.equal((await result.usage).inputTokens,5);
});
test('cancel reaches upstream and resolves usage without draining upstream', async () => {
  let cancelled = false, reads = 0;
  const upstream = new ReadableStream<Uint8Array>({pull(){reads++;},cancel(){cancelled=true;}});
  const result = new OpenAIToGeminiBridge().transformStream(upstream);
  await result.clientStream.cancel('stop'); assert.equal(cancelled,true); assert.ok(reads <= 1); assert.deepEqual(await result.usage,{});
});
test('truncated tool arguments and missing terminal are transport errors', async () => {
  const b = new GeminiToOpenAIBridge();
  const result = b.transformStream(sse([{choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'f',arguments:'{'}}]}}]}]));
  await assert.rejects(read(result.clientStream),UnsupportedBridgeFeatureError); await result.usage;
});
