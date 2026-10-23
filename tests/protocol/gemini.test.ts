import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anthropicToGeminiRequest,
  geminiStreamToAnthropicStream,
  geminiToAnthropicResponse,
  AnthToGeminiBridge, GeminiToAnthBridge,
} from '../../src/protocol/gemini.js';
import { GeminiShadowStore } from '../../src/protocol/gemini-shadow.js';

test('anthropicToGeminiRequest maps simple text message', () => {
  const { payload } = anthropicToGeminiRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gemini-pro');
  assert.equal(payload.contents[0].role, 'user');
  assert.equal(payload.contents[0].parts[0].text, 'hi');
});

test('anthropicToGeminiRequest maps assistant to model', () => {
  const { payload } = anthropicToGeminiRequest({ messages: [{ role: 'assistant', content: 'hello' }] }, 'gemini-pro');
  assert.equal(payload.contents[0].role, 'model');
  assert.equal(payload.contents[0].parts[0].text, 'hello');
});

test('anthropicToGeminiRequest maps system prompt', () => {
  const { payload } = anthropicToGeminiRequest({ system: 'sys', messages: [] }, 'gemini-pro');
  assert.equal(payload.systemInstruction.parts[0].text, 'sys');
});

test('anthropicToGeminiRequest maps array system blocks', () => {
  const { payload } = anthropicToGeminiRequest(
    {
      system: [
        { type: 'text', text: 'sys1' },
        { type: 'text', text: 'sys2' },
      ],
      messages: [],
    },
    'gemini-pro',
  );
  assert.equal(payload.systemInstruction.parts[0].text, 'sys1');
  assert.equal(payload.systemInstruction.parts[1].text, 'sys2');
});

test('anthropicToGeminiRequest explicitly rejects image blocks without a proven media workflow', () => {
  assert.throws(() => anthropicToGeminiRequest({messages:[{role:'user',content:[{type:'image',source:{media_type:'image/jpeg',data:'synthetic'}}]}]},'gemini-pro'), /Unsupported bridge feature/);
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
    'gemini-pro',
  );
  assert.equal(payload.tools[0].functionDeclarations[0].name, 'get_weather');
  assert.equal(payload.tools[0].functionDeclarations[0].description, 'Get weather');
});

test('anthropicToGeminiRequest sets generationConfig', () => {
  const { payload } = anthropicToGeminiRequest(
    { messages: [], max_tokens: 100, temperature: 0.5, top_p: 0.9 },
    'gemini-pro',
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
  assert.equal(res.stop_reason, 'max_tokens');
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
  const events = geminiStreamToAnthropicStream(
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"NYC"}}}]}}]}',
    store,
  );
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

function fragmentedSse(events:any[]):ReadableStream<Uint8Array>{const bytes=new TextEncoder().encode(events.map(e=>`data: ${JSON.stringify(e)}\r\n\r\n`).join(''));let i=0;return new ReadableStream({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.slice(i,++i));}});}
async function collectEvents(stream:ReadableStream<Uint8Array>):Promise<any[]>{const reader=stream.getReader();let text='';const decoder=new TextDecoder();while(true){const r=await reader.read();if(r.done)break;text+=decoder.decode(r.value,{stream:true});}return text.split('\n\n').filter(Boolean).map(block=>JSON.parse(block.split('\n').find(l=>l.startsWith('data: '))!.slice(6)));}

test('Anthropic/Gemini two same-name tool calls retain IDs across full history',()=>{
  const anthropic={model:'g',max_tokens:128,messages:[{role:'user',content:'hi'},{role:'assistant',content:[{type:'tool_use',id:'a',name:'f',input:{n:1}},{type:'tool_use',id:'b',name:'f',input:{n:2}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'b',content:'{"ok":true}'},{type:'tool_result',tool_use_id:'a',content:'text'}]}]};
  const gemini=new AnthToGeminiBridge().transformRequest(anthropic);
  assert.equal(gemini.contents[2].parts[0].functionResponse.id,'b');
  const back=new GeminiToAnthBridge().transformRequest(gemini);
  assert.equal(back.messages[1].content[1].id,'b');assert.equal(back.messages[2].content[0].tool_use_id,'b');
});
test('Gemini→Anthropic complete SSE lifecycle preserves UTF8, tool IDs and usage',async()=>{
  const result=new AnthToGeminiBridge().transformStream(fragmentedSse([{responseId:'r',candidates:[{content:{parts:[{text:'你好'},{functionCall:{id:'a',name:'f',args:{n:1}}},{functionCall:{id:'b',name:'f',args:{n:2}}}]}}]},{candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:3,cachedContentTokenCount:2}}]));
  const events=await collectEvents(result.clientStream);assert.equal(events[0].type,'message_start');assert.equal(events.at(-1).type,'message_stop');
  const starts=events.filter(e=>e.type==='content_block_start');assert.deepEqual(starts.map(e=>e.index),[0,1,2]);assert.equal(starts[1].content_block.id,'a');assert.equal(starts[2].content_block.id,'b');
  assert.equal(events.at(-2).delta.stop_reason,'tool_use');assert.deepEqual(events.at(-2).usage,{input_tokens:5,output_tokens:3,cache_read_input_tokens:2});assert.equal((await result.usage).inputTokens,7);
});
test('Anthropic→Gemini stream assembles tool JSON fragments and waits for message_stop',async()=>{
  const result=new GeminiToAnthBridge().transformStream(fragmentedSse([{type:'message_start',message:{id:'r',model:'a',usage:{input_tokens:4}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'a',name:'f',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"n":'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'1}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}]));
  const events=await collectEvents(result.clientStream);assert.deepEqual(events[0].candidates[0].content.parts[0].functionCall,{id:'a',name:'f',args:{n:1}});assert.equal(events.at(-1).candidates[0].finishReason,'STOP');assert.equal(events.at(-1).usageMetadata.promptTokenCount,4);assert.equal((await result.usage).outputTokens,2);
});
test('unsupported reasoning fails streams without successful terminal and cancellation reaches upstream',async()=>{
  const bad=new AnthToGeminiBridge().transformStream(fragmentedSse([{candidates:[{content:{parts:[{text:'private',thought:true}]},finishReason:'STOP'}]}]));
  await assert.rejects(collectEvents(bad.clientStream),/Unsupported bridge feature/);await bad.usage;
  let cancelled=false;const upstream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});const result=new GeminiToAnthBridge().transformStream(upstream);await result.clientStream.cancel('stop');assert.equal(cancelled,true);await result.usage;
  const missing=new GeminiToAnthBridge().transformStream(fragmentedSse([{type:'message_start',message:{id:'r',model:'a'}}]));await assert.rejects(collectEvents(missing.clientStream),/Unsupported bridge feature/);await missing.usage;
});
