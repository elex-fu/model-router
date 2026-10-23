import type { BaseBridge, BridgeError, BridgeStreamResult } from './bridge.js';
import { GeminiShadowStore } from './gemini-shadow.js';
import { assertGeminiSupported, geminiUsage, mapSseStream, unsupported } from './openai-gemini.js';
import { normalizeUsage } from '../providers/usage.js';

export interface GeminiContent { role?: 'user' | 'model'; parts: any[]; }
function objectArgs(value: any, path: string): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported(path);
  return value;
}
function geminiStop(reason: string | undefined, tools: boolean): string | null {
  if (!reason) return null;
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'STOP') return tools ? 'tool_use' : 'end_turn';
  if (['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(reason)) return 'refusal';
  return unsupported('$.candidates[0].finishReason');
}
function anthropicUsage(body: any): any {
  const u = geminiUsage(body);
  if (u.inputTokens !== undefined && u.cacheReadTokens !== undefined && u.cacheReadTokens > u.inputTokens) unsupported('$.usageMetadata.cachedContentTokenCount');
  return {
    ...(u.inputTokens === undefined ? {} : { input_tokens: u.inputTokens - (u.cacheReadTokens ?? 0) }),
    ...(u.outputTokens === undefined ? {} : { output_tokens: u.outputTokens }),
    ...(u.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: u.cacheReadTokens }),
  };
}
function rejectAnthropicOpaque(body: any): void {
  for (const k of ['thinking','context_management','container','mcp_servers']) if (body[k] !== undefined) unsupported(`$.${k}`);
}

/** Direct text/function-history mapping; opaque reasoning/media require a separate proven workflow. */
export function anthropicToGeminiRequest(body: any, model: string): { urlPath: string; payload: any } {
  rejectAnthropicOpaque(body);
  for (const k of Object.keys(body)) if (!['model','messages','system','max_tokens','temperature','top_p','top_k','stop_sequences','tools','tool_choice','stream'].includes(k)) unsupported(`$.${k}`);
  const contents: GeminiContent[] = []; const calls = new Map<string,string>();
  for (const [i,msg] of (body.messages ?? []).entries()) {
    if(Object.keys(msg).some(k=>!['role','content'].includes(k)))unsupported(`$.messages[${i}]`);
    if (!['user','assistant'].includes(msg.role)) unsupported(`$.messages[${i}].role`);
    const parts: any[] = [];
    const blocks = typeof msg.content === 'string' ? [{type:'text',text:msg.content}] : msg.content;
    if (!Array.isArray(blocks)) unsupported(`$.messages[${i}].content`);
    for (const [j,b] of blocks.entries()) {
      const path = `$.messages[${i}].content[${j}]`;
      if (b.type === 'text') { if (Object.keys(b).some(k=>!['type','text'].includes(k))) unsupported(path); parts.push({text:b.text}); }
      else if (b.type === 'tool_use') {
        if (msg.role !== 'assistant' || typeof b.id !== 'string' || calls.has(b.id)) unsupported(`${path}.id`);
        calls.set(b.id,b.name); parts.push({functionCall:{id:b.id,name:b.name,args:objectArgs(b.input,`${path}.input`)}});
      } else if (b.type === 'tool_result') {
        if (msg.role !== 'user' || !calls.has(b.tool_use_id)) unsupported(`${path}.tool_use_id`);
        if (b.is_error !== undefined) unsupported(`${path}.is_error`);
        let output: any = b.content;
        if (Array.isArray(output)) { if (output.some((x:any)=>x.type!=='text')) unsupported(`${path}.content`); output=output.map((x:any)=>x.text).join(''); }
        let response: any = {output};
        if (typeof output === 'string') { try { const p=JSON.parse(output); if(p && typeof p==='object' && !Array.isArray(p)) response=p; } catch { /* Plain text output. */ } }
        parts.push({functionResponse:{id:b.tool_use_id,name:calls.get(b.tool_use_id),response}}); calls.delete(b.tool_use_id);
      } else unsupported(`${path}.type`);
    }
    contents.push({role:msg.role==='assistant'?'model':'user',parts});
  }
  const payload:any={model,contents}; const cfg:any={};
  for(const [a,b] of [['max_tokens','maxOutputTokens'],['temperature','temperature'],['top_p','topP'],['top_k','topK'],['stop_sequences','stopSequences']] as const) if(body[a]!==undefined) cfg[b]=body[a];
  if(Object.keys(cfg).length) payload.generationConfig=cfg;
  if(body.system!==undefined) {
    const blocks=typeof body.system==='string'?[{type:'text',text:body.system}]:body.system;
    if(!Array.isArray(blocks)) unsupported('$.system');
    payload.systemInstruction={parts:blocks.map((b:any)=>{if(b.type!=='text' || Object.keys(b).some(k=>!['type','text'].includes(k))) unsupported('$.system');return {text:b.text};})};
  }
  if(body.tools?.length) payload.tools=[{functionDeclarations:body.tools.map((t:any,i:number)=>{if(Object.keys(t).some(k=>!['name','description','input_schema'].includes(k))) unsupported(`$.tools[${i}]`);return {name:t.name,description:t.description,parameters:t.input_schema};})}];
  if(body.tool_choice) {
    const c=body.tool_choice;
    if(Object.keys(c).some(k=>!['type','name'].includes(k)) || !['auto','any','none','tool'].includes(c.type)) unsupported('$.tool_choice');
    payload.toolConfig={functionCallingConfig:{mode:c.type==='auto'?'AUTO':c.type==='none'?'NONE':'ANY',...(c.type==='tool'?{allowedFunctionNames:[c.name]}:{})}};
  }
  return {urlPath:`/v1beta/models/${encodeURIComponent(model)}:${body.stream?'streamGenerateContent?alt=sse':'generateContent'}`,payload};
}

export function geminiToAnthropicResponse(body:any):any {
  assertGeminiSupported(body);
  if(body.error) return {type:'error',error:{type:'api_error',message:body.error.message ?? 'Upstream error'}};
  const c=body.candidates?.[0]; const content:any[]=[];
  for(const [i,p] of (c?.content?.parts ?? []).entries()) {
    if(p.text!==undefined) content.push({type:'text',text:p.text});
    else if(p.functionCall) content.push({type:'tool_use',id:p.functionCall.id ?? `toolu_gemini_${i}`,name:p.functionCall.name,input:objectArgs(p.functionCall.args ?? {},`$.candidates[0].content.parts[${i}].functionCall.args`)});
    else unsupported(`$.candidates[0].content.parts[${i}]`);
  }
  return {id:body.responseId ?? 'msg_gemini',type:'message',role:'assistant',model:body.modelVersion ?? body.model ?? 'gemini-unknown',content,usage:anthropicUsage(body),stop_reason:geminiStop(c?.finishReason,content.some(x=>x.type==='tool_use')),stop_sequence:null};
}

export class AnthToGeminiBridge implements BaseBridge {
  readonly clientProto='anthropic' as const; readonly upstreamProto='gemini' as const;
  private path='/v1beta/models/model:generateContent';
  rewriteUrlPath(_path:string):string{return this.path;}
  transformRequest(body:any):any { const result=anthropicToGeminiRequest(body,body.model ?? 'gemini-2.5-pro');this.path=result.urlPath;return result.payload; }
  transformResponse(body:any):any{return geminiToAnthropicResponse(body);}
  transformStream(stream:ReadableStream<Uint8Array>):BridgeStreamResult {
    let started=false,terminal=false,failed=false,index=0,toolCount=0,stop:string|null=null;
    const usage:any={};const ids=new Set<string>();
    return mapSseStream(stream,body=>{
      assertGeminiSupported(body);
      if(body.error){failed=true;return [{type:'error',error:{type:'api_error',message:body.error.message ?? 'Upstream error'}}];}
      Object.assign(usage,anthropicUsage(body)); const events:any[]=[];
      if(!started){started=true;events.push({type:'message_start',message:{id:body.responseId ?? 'msg_gemini',type:'message',role:'assistant',model:body.modelVersion ?? 'gemini-unknown',content:[],stop_reason:null,stop_sequence:null,usage:{...usage}}});}
      const c=body.candidates?.[0];
      if(terminal && c?.content?.parts?.length)unsupported('$.stream.terminal');
      for(const [j,p] of (c?.content?.parts ?? []).entries()) {
        const n=index++;
        if(p.text!==undefined){events.push({type:'content_block_start',index:n,content_block:{type:'text',text:''}},{type:'content_block_delta',index:n,delta:{type:'text_delta',text:p.text}},{type:'content_block_stop',index:n});}
        else if(p.functionCall){const f=p.functionCall,id=f.id ?? `toolu_gemini_${toolCount}`;if(ids.has(id)) unsupported(`$.candidates[0].content.parts[${j}].functionCall.id`);ids.add(id);toolCount++;events.push({type:'content_block_start',index:n,content_block:{type:'tool_use',id,name:f.name,input:{}}},{type:'content_block_delta',index:n,delta:{type:'input_json_delta',partial_json:JSON.stringify(objectArgs(f.args ?? {},'$.candidates[0].content.parts.functionCall.args'))}},{type:'content_block_stop',index:n});}
        else unsupported(`$.candidates[0].content.parts[${j}]`);
      }
      if(c?.finishReason){terminal=true;stop=geminiStop(c.finishReason,toolCount>0);}
      return events;
    },()=>{if(failed)return [];if(!terminal)unsupported('$.stream.terminal');return [{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{...usage}},{type:'message_stop'}];});
  }
  wrapError(status:number,message:string):BridgeError{return {body:{type:'error',error:{type:status===429?'rate_limit_error':'api_error',message}},contentType:'application/json'};}
}

export class GeminiToAnthBridge implements BaseBridge {
  readonly clientProto='gemini' as const; readonly upstreamProto='anthropic' as const;
  private model=''; private stream=false;
  rewriteUrlPath(path:string):string{const match=path.match(/\/models\/([^/:]+):(streamGenerateContent|generateContent)/);if(match){this.model=decodeURIComponent(match[1]);this.stream=match[2]==='streamGenerateContent';}return '/v1/messages';}
  transformRequest(body:any):any {
    assertGeminiSupported(body);
    for(const k of Object.keys(body))if(!['model','stream','contents','systemInstruction','generationConfig','tools','toolConfig'].includes(k))unsupported(`$.${k}`);
    const messages:any[]=[];const pending=new Map<string,{id:string;name:string}>();
    for(const [i,c] of (body.contents ?? []).entries()){
      if(!['user','model'].includes(c.role ?? 'user'))unsupported(`$.contents[${i}].role`);const content:any[]=[];
      for(const [j,p] of (c.parts ?? []).entries()){
        const path=`$.contents[${i}].parts[${j}]`;
        if(p.text!==undefined)content.push({type:'text',text:p.text});
        else if(p.functionCall){if(c.role!=='model')unsupported(path);const f=p.functionCall,id=f.id ?? `toolu_gemini_${i}_${j}`;if(pending.has(id))unsupported(`${path}.functionCall.id`);pending.set(id,{id,name:f.name});content.push({type:'tool_use',id,name:f.name,input:objectArgs(f.args ?? {},`${path}.functionCall.args`)});}
        else if(p.functionResponse){if(c.role==='model')unsupported(path);const f=p.functionResponse;const matching=[...pending.values()].filter(x=>x.name===f.name);const id=f.id ?? (matching.length===1?matching[0].id:undefined);if(!id || pending.get(id)?.name!==f.name)unsupported(`${path}.functionResponse.id`);pending.delete(id);content.push({type:'tool_result',tool_use_id:id,content:JSON.stringify(f.response ?? {})});}
        else unsupported(path);
      }
      messages.push({role:c.role==='model'?'assistant':'user',content});
    }
    const cfg=body.generationConfig ?? {};for(const k of Object.keys(cfg))if(!['maxOutputTokens','temperature','topP','topK','stopSequences','candidateCount'].includes(k))unsupported(`$.generationConfig.${k}`);
    if(cfg.maxOutputTokens===undefined)unsupported('$.generationConfig.maxOutputTokens');
    const out:any={model:body.model ?? this.model,messages,max_tokens:cfg.maxOutputTokens,stream:body.stream ?? this.stream};
    for(const [a,b] of [['temperature','temperature'],['topP','top_p'],['topK','top_k'],['stopSequences','stop_sequences']] as const)if(cfg[a]!==undefined)out[b]=cfg[a];
    if(body.systemInstruction)out.system=(body.systemInstruction.parts ?? []).map((p:any)=>{if(typeof p.text!=='string')unsupported('$.systemInstruction.parts');return {type:'text',text:p.text};});
    if(body.tools?.length)out.tools=body.tools.flatMap((t:any,i:number)=>{if(Object.keys(t).some(k=>k!=='functionDeclarations')||!Array.isArray(t.functionDeclarations))unsupported(`$.tools[${i}]`);return t.functionDeclarations.map((f:any)=>{if(Object.keys(f).some(k=>!['name','description','parameters'].includes(k)))unsupported(`$.tools[${i}].functionDeclarations`);return {name:f.name,description:f.description,input_schema:f.parameters};});});
    if(body.toolConfig){const config=body.toolConfig.functionCallingConfig;if(Object.keys(body.toolConfig).some(k=>k!=='functionCallingConfig')||!config||Object.keys(config).some(k=>!['mode','allowedFunctionNames'].includes(k))||config.allowedFunctionNames?.length>1)unsupported('$.toolConfig');const type=({AUTO:'auto',ANY:'any',NONE:'none'} as any)[config.mode];if(!type)unsupported('$.toolConfig.functionCallingConfig.mode');out.tool_choice=config.allowedFunctionNames?.length?{type:'tool',name:config.allowedFunctionNames[0]}:{type};}
    return out;
  }
  transformResponse(body:any):any {
    rejectAnthropicOpaque(body);if(body.usage?.cache_creation_input_tokens>0)unsupported('$.usage.cache_creation_input_tokens');if(body.type==='error')return this.wrapError(500,body.error?.message ?? 'Upstream error').body;
    const parts:any[]=[];for(const [i,b]of(body.content ?? []).entries()){if(b.type==='text')parts.push({text:b.text});else if(b.type==='tool_use')parts.push({functionCall:{id:b.id,name:b.name,args:objectArgs(b.input,`$.content[${i}].input`)}});else unsupported(`$.content[${i}].type`);}
    const reason=body.stop_reason;if(reason && !['end_turn','tool_use','max_tokens','stop_sequence','refusal'].includes(reason))unsupported('$.stop_reason');if(reason==='stop_sequence')unsupported('$.stop_reason');
    const u=normalizeUsage('anthropic',body);
    return {responseId:body.id,modelVersion:body.model,candidates:[{index:0,content:{role:'model',parts},...(reason?{finishReason:reason==='max_tokens'?'MAX_TOKENS':reason==='refusal'?'SAFETY':'STOP'}:{})}],usageMetadata:{promptTokenCount:u.inputTokens,candidatesTokenCount:u.outputTokens,cachedContentTokenCount:u.cacheReadTokens}};
  }
  transformStream(stream:ReadableStream<Uint8Array>):BridgeStreamResult {
    let started=false,terminal=false,failed=false,id:any,model:any;let reason:any;const blocks=new Map<number,any>();const counts:any={};
    return mapSseStream(stream,event=>{
      const events:any[]=[];
      const emit=(parts:any[],finish?:string)=>({responseId:id,modelVersion:model,candidates:[{index:0,content:{role:'model',parts},...(finish?{finishReason:finish}:{})}],usageMetadata:{promptTokenCount:counts.inputTokens,candidatesTokenCount:counts.outputTokens,cachedContentTokenCount:counts.cacheReadTokens}});
      if(terminal && event.type!=='ping')unsupported('$.stream.terminal');
      if(event.usage?.cache_creation_input_tokens>0 || event.message?.usage?.cache_creation_input_tokens>0)unsupported('$.usage.cache_creation_input_tokens');
      if(event.type==='error'){failed=true;return [this.wrapError(500,event.error?.message ?? 'Upstream error').body];}
      if(event.type==='message_start'){if(started)unsupported('$.stream.message_start');started=true;rejectAnthropicOpaque(event.message);id=event.message.id;model=event.message.model;Object.assign(counts,normalizeUsage('anthropic',event.message));return [];}
      if(!started)unsupported('$.stream.message_start');
      if(event.type==='content_block_start'){const b=event.content_block;if(blocks.has(event.index))unsupported('$.stream.content_block_start.index');if(!['text','tool_use'].includes(b.type))unsupported('$.stream.content_block.type');blocks.set(event.index,{...b,json:'',text:b.text ?? ''});if(b.type==='text'&&b.text)events.push(emit([{text:b.text}]));}
      else if(event.type==='content_block_delta'){const b=blocks.get(event.index);if(!b)unsupported('$.stream.content_block_delta.index');if(event.delta.type==='text_delta'&&b.type==='text')events.push(emit([{text:event.delta.text}]));else if(event.delta.type==='input_json_delta'&&b.type==='tool_use')b.json+=event.delta.partial_json;else unsupported('$.stream.content_block_delta.type');}
      else if(event.type==='content_block_stop'){const b=blocks.get(event.index);if(!b)unsupported('$.stream.content_block_stop.index');if(b.type==='tool_use'){let args=b.input;try{if(b.json)args=JSON.parse(b.json);}catch{unsupported('$.stream.tool.arguments');}events.push(emit([{functionCall:{id:b.id,name:b.name,args:objectArgs(args,'$.stream.tool.arguments')}}]));}blocks.delete(event.index);}
      else if(event.type==='message_delta'){if(blocks.size)unsupported('$.stream.content_block_stop');const mapped=this.transformResponse({id,model,content:[],stop_reason:event.delta?.stop_reason,usage:event.usage});reason=mapped.candidates[0].finishReason;const u=normalizeUsage('anthropic',{usage:event.usage});for(const[k,v]of Object.entries(u))if(v!==undefined)counts[k]=v;}
      else if(event.type==='message_stop'){if(blocks.size||!reason)unsupported('$.stream.terminal');terminal=true;events.push(emit([],reason));}
      else if(event.type!=='ping')unsupported('$.stream.event.type');
      return events;
    },()=>{if(!failed&&(!terminal||blocks.size))unsupported('$.stream.terminal');return [];},event=>normalizeUsage('anthropic',event.type==='message_start'?event.message:event));
  }
  wrapError(status:number,message:string):BridgeError{return {body:{error:{code:status,message,status:status===429?'RESOURCE_EXHAUSTED':'INTERNAL'}},contentType:'application/json'};}
}

// Legacy line helper retained for consumers; real bridges use the bounded single-reader parser above.
const helperIndexes=new WeakMap<GeminiShadowStore,number>();
export function geminiStreamToAnthropicStream(line:string,store:GeminiShadowStore):any[]{
  if(!line.startsWith('data:'))return [];const data=line.slice(5).trim();if(!data||data==='[DONE]')return [];
  let body:any;try{body=JSON.parse(data);}catch{return [];}
  const response=geminiToAnthropicResponse(body),events:any[]=[];let index=helperIndexes.get(store) ?? 0;
  for(const b of response.content ?? []){const n=index++;if(b.type==='text')events.push({type:'content_block_delta',index:n,delta:{type:'text_delta',text:b.text}});else{const id=b.id.startsWith('toolu_gemini_')?`toolu_gemini_${n}`:b.id;store.remember(id,b.name,b.input);events.push({type:'content_block_start',index:n,content_block:{type:'tool_use',id,name:b.name,input:{}}},{type:'content_block_delta',index:n,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});}}
  helperIndexes.set(store,index);return events;
}
