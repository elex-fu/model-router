import type { Bridge, BridgeError, BridgeStreamResult, BridgeUsage, Protocol } from './bridge.js';
import { normalizeUsage } from '../providers/usage.js';

/** Safe diagnostic: paths only, never the rejected value. */
export class UnsupportedBridgeFeatureError extends Error {
  readonly code = 'UNSUPPORTED_BRIDGE_FEATURE';
  constructor(readonly fieldPath: string) { super(`Unsupported bridge feature at ${fieldPath}`); this.name = 'UnsupportedBridgeFeatureError'; }
}
export function unsupported(path: string): never { throw new UnsupportedBridgeFeatureError(path); }
export function assertGeminiSupported(body: any): void {
  const visit = (v: any, path: string): void => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (['thoughtSignature', 'thought', 'inlineData', 'fileData', 'executableCode', 'codeExecutionResult', 'googleSearch', 'googleSearchRetrieval', 'urlContext', 'cachedContent', 'groundingMetadata'].includes(k)) unsupported(`${path}.${k}`);
      // User JSON/schema keys are data, not Gemini protocol fields.
      if (!['args', 'response', 'parameters', 'parametersJsonSchema'].includes(k)) visit(x, `${path}.${k}`);
    }
  };
  visit(body, '$');
  if (body?.promptFeedback?.blockReason) unsupported('$.promptFeedback.blockReason');
  if (body?.usageMetadata?.thoughtsTokenCount > 0) unsupported('$.usageMetadata.thoughtsTokenCount');
  if (body?.candidates?.some((c: any) => c.index !== undefined && c.index !== 0)) unsupported('$.candidates.index');
  if (body?.generationConfig?.candidateCount > 1 || body?.candidates?.length > 1) unsupported('$.candidates');
}
export function geminiUsage(body: any): BridgeUsage { return normalizeUsage('gemini', body); }

/** A single upstream reader, demand-driven SSE framing, and explicit cancellation. */
export function mapSseStream(
  upstream: ReadableStream<Uint8Array>,
  map: (body: any) => any[],
  finish: () => any[] = () => [],
  observe: (body: any) => BridgeUsage = geminiUsage,
): BridgeStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '', ended = false, settled = false, released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  let observed: BridgeUsage = {};
  let resolve!: (usage: BridgeUsage) => void;
  const usage = new Promise<BridgeUsage>(r => { resolve = r; });
  const settle = () => { if (!settled) { settled = true; resolve(observed); } };
  const queue: Uint8Array[] = [];
  const emit = (events: any[]) => { for (const e of events) queue.push(encoder.encode(e === '[DONE]' ? 'data: [DONE]\n\n' : `${typeof e?.type === 'string' ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`)); };
  const block = (raw: string) => {
    const data = raw.split(/\r\n|\r|\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    const body = JSON.parse(data);
    const u = observe(body); for (const [k, v] of Object.entries(u)) if (v !== undefined) (observed as any)[k] = v;
    emit(map(body));
  };
  const clientStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length && !ended) {
          const { value, done } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let match: RegExpExecArray | null;
          while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
            const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); block(raw);
          }
          if (done) { if (buffer.trim()) block(buffer); ended = true; emit(finish()); settle(); release(); }
        }
        if (queue.length) controller.enqueue(queue.shift()!);
        else if (ended) controller.close();
      } catch (error) { ended = true; settle(); await reader.cancel(error).catch(() => {}); release(); controller.error(error); }
    },
    async cancel(reason) { ended = true; queue.length = 0; settle(); try { if (!released) await reader.cancel(reason); } finally { release(); } },
  });
  return { clientStream, usage };
}
function parseArguments(value: any, path: string): any {
  if (typeof value !== 'string') unsupported(path);
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) unsupported(path); return parsed; } catch { return unsupported(path); }
}
function finishReason(reason: string | undefined): string | null {
  if (!reason) return null;
  if (reason === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) return 'content_filter';
  if (reason !== 'STOP') unsupported('$.candidates[0].finishReason');
  return 'stop';
}
function chatError(status: number, message: string): BridgeError { return { body: { error: { message, type: status === 429 ? 'rate_limit_exceeded' : 'server_error', code: null } }, contentType: 'application/json' }; }

export class OpenAIToGeminiBridge implements Bridge {
  readonly clientProto: Protocol = 'openai'; readonly upstreamProto: Protocol = 'gemini';
  private model = ''; private stream = false;
  rewriteUrlPath(_path: string): string { return `/v1beta/models/${encodeURIComponent(this.model)}:${this.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`; }
  transformRequest(body: any): any {
    this.model = body.model; this.stream = body.stream === true;
    for (const k of Object.keys(body)) if (!['model','messages','stream','stream_options','temperature','top_p','max_completion_tokens','max_tokens','stop','tools','tool_choice','n'].includes(k)) unsupported(`$.${k}`);
    if (body.stream_options && Object.keys(body.stream_options).some(k => k !== 'include_usage')) unsupported('$.stream_options');
    for (const k of ['audio', 'modalities', 'prediction', 'response_format', 'reasoning_effort', 'logprobs', 'top_logprobs', 'seed', 'parallel_tool_calls']) if (body[k] !== undefined) unsupported(`$.${k}`);
    if (body.n !== undefined && body.n !== 1) unsupported('$.n');
    const contents: any[] = [], system: any[] = []; const calls = new Map<string, string>();
    for (const [i, m] of (body.messages ?? []).entries()) {
      const path = `$.messages[${i}]`; const parts: any[] = [];
      for (const k of Object.keys(m)) if (!['role','content','tool_calls','tool_call_id'].includes(k)) unsupported(`${path}.${k}`);
      if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) unsupported(`${path}.role`);
      if (m.role === 'tool') {
        const name = calls.get(m.tool_call_id); if (!name) unsupported(`${path}.tool_call_id`);
        let response: any = { output: m.content };
        if (typeof m.content === 'string') { try { const parsed = JSON.parse(m.content); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) response = parsed; } catch { /* Plain text tool output. */ } }
        parts.push({ functionResponse: { id: m.tool_call_id, name, response } });
        calls.delete(m.tool_call_id);
      } else {
        if (typeof m.content === 'string') parts.push({ text: m.content });
        else if (Array.isArray(m.content)) for (const [j, p] of m.content.entries()) { if (p.type !== 'text') unsupported(`${path}.content[${j}].type`); parts.push({ text: p.text }); }
        else if (m.content != null) unsupported(`${path}.content`);
        for (const c of m.tool_calls ?? []) { if (c.type !== 'function' || !c.id) unsupported(`${path}.tool_calls`); if (calls.has(c.id)) unsupported(`${path}.tool_calls.id`); calls.set(c.id, c.function.name); parts.push({ functionCall: { id: c.id, name: c.function.name, args: parseArguments(c.function.arguments, `${path}.tool_calls.arguments`) } }); }
      }
      if (m.role === 'system' || m.role === 'developer') { if (contents.length) unsupported(`${path}.role`); system.push(...parts); }
      else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
    const out: any = { model: this.model, contents };
    if (system.length) out.systemInstruction = { parts: system };
    const cfg: any = {};
    for (const [a,b] of [['temperature','temperature'],['top_p','topP'],['max_completion_tokens','maxOutputTokens'],['max_tokens','maxOutputTokens'],['stop','stopSequences']] as const) if (body[a] !== undefined) cfg[b] = a === 'stop' && typeof body[a] === 'string' ? [body[a]] : body[a];
    if (Object.keys(cfg).length) out.generationConfig = cfg;
    if (body.tools?.length) out.tools = [{ functionDeclarations: body.tools.map((t: any, i: number) => { if (t.type !== 'function' || t.function?.strict === true) unsupported(`$.tools[${i}]`); return { name: t.function.name, description: t.function.description, parameters: t.function.parameters }; }) }];
    if (body.tool_choice !== undefined) { const c = body.tool_choice; if (typeof c === 'string' && !['auto','none','required'].includes(c)) unsupported('$.tool_choice'); const mode = c === 'auto' ? 'AUTO' : c === 'none' ? 'NONE' : 'ANY'; if (typeof c === 'object' && c?.type !== 'function') unsupported('$.tool_choice'); out.toolConfig = { functionCallingConfig: { mode, ...(typeof c === 'object' ? { allowedFunctionNames: [c.function.name] } : {}) } }; }
    return out;
  }
  transformResponse(body: any): any {
    assertGeminiSupported(body); if (body.error) return this.wrapError(body.error.code ?? 500, body.error.message ?? 'Upstream error').body;
    const c = body.candidates?.[0]; const calls: any[] = []; let text = '';
    for (const [i,p] of (c?.content?.parts ?? []).entries()) { if (p.text !== undefined) text += p.text; else if (p.functionCall) calls.push({ id: p.functionCall.id ?? `call_${i}`, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }); else unsupported(`$.candidates[0].content.parts[${i}]`); }
    const u = geminiUsage(body);
    return { id: body.responseId ?? 'chatcmpl_gemini', object: 'chat.completion', created: Math.floor(Date.now()/1000), model: body.modelVersion ?? this.model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length && c?.finishReason ? 'tool_calls' : finishReason(c?.finishReason) }], usage: { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.inputTokens === undefined || u.outputTokens === undefined ? undefined : u.inputTokens + u.outputTokens, prompt_tokens_details: { cached_tokens: u.cacheReadTokens } } };
  }
  transformStream(stream: ReadableStream<Uint8Array>): BridgeStreamResult {
    let toolIndex = 0, terminal = false, hadTools = false; const seen = new Set<string>();
    return mapSseStream(stream, body => {
      const response = this.transformResponse(body); if (response.error) { terminal = true; return [response]; }
      if (body.candidates?.[0]?.finishReason) terminal = true;
      const choice = response.choices[0];
      if (choice.message.tool_calls?.length) hadTools = true;
      if (choice.finish_reason === 'stop' && hadTools) choice.finish_reason = 'tool_calls';
      const delta: any = { role: 'assistant' };
      if (choice.message.content) delta.content = choice.message.content;
      if (choice.message.tool_calls) delta.tool_calls = choice.message.tool_calls.map((c: any) => { if (c.id.startsWith('call_') && !body.candidates?.[0]?.content?.parts?.some((p: any) => p.functionCall?.id === c.id)) c.id = `call_gemini_${toolIndex}`; if (seen.has(c.id)) unsupported('$.candidates[0].content.parts.functionCall.id'); seen.add(c.id); return { ...c, index: toolIndex++ }; });
      return [{ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: choice.finish_reason }] }];
    }, () => { if (!terminal) unsupported('$.stream.terminal'); return ['[DONE]']; });
  }
  wrapError(status: number, message: string): BridgeError { return chatError(status,message); }
}

export class GeminiToOpenAIBridge implements Bridge {
  readonly clientProto: Protocol = 'gemini'; readonly upstreamProto: Protocol = 'openai';
  private model = ''; private stream = false;
  rewriteUrlPath(path: string): string { const m = path.match(/\/models\/([^/:]+):(streamGenerateContent|generateContent)/); if (m) { this.model = decodeURIComponent(m[1]); this.stream = m[2] === 'streamGenerateContent'; } return '/v1/chat/completions'; }
  transformRequest(body: any): any {
    assertGeminiSupported(body);
    for (const k of Object.keys(body)) if (!['model','stream','contents','systemInstruction','generationConfig','tools','toolConfig'].includes(k)) unsupported(`$.${k}`);
    this.model = body.model ?? this.model; if (body.stream !== undefined) this.stream = body.stream === true; const messages: any[] = []; const calls = new Map<string,string[]>();
    if (body.systemInstruction) messages.push({ role: 'system', content: (body.systemInstruction.parts ?? []).map((p: any) => { if (typeof p.text !== 'string') unsupported('$.systemInstruction.parts'); return p.text; }).join('') });
    for (const [i,c] of (body.contents ?? []).entries()) {
      let text = ''; const tools: any[] = []; const outputs: any[] = [];
      if (!['user','model'].includes(c.role ?? 'user')) unsupported(`$.contents[${i}].role`);
      for (const [j,p] of (c.parts ?? []).entries()) {
        if (p.text !== undefined) text += p.text;
        else if (p.functionCall) { const f=p.functionCall, id=f.id ?? `call_${i}_${j}`; tools.push({ id, type:'function', function:{ name:f.name, arguments:JSON.stringify(f.args ?? {}) } }); calls.set(f.name,[...(calls.get(f.name) ?? []),id]); }
        else if (p.functionResponse) { const f=p.functionResponse; const ids=calls.get(f.name) ?? []; if (!f.id && ids.length !== 1) unsupported(`$.contents[${i}].parts[${j}].functionResponse.id`); const id=f.id ?? ids[0]; if (!ids.includes(id)) unsupported(`$.contents[${i}].parts[${j}].functionResponse.id`); calls.set(f.name,ids.filter(x=>x!==id)); outputs.push({ role:'tool',tool_call_id:id,content:JSON.stringify(f.response ?? {}) }); }
        else unsupported(`$.contents[${i}].parts[${j}]`);
      }
      if (outputs.length && (text || tools.length)) unsupported(`$.contents[${i}].parts`);
      if (text || tools.length) messages.push({ role:c.role === 'model' ? 'assistant':'user',content:text || null,...(tools.length ? {tool_calls:tools}: {}) });
      messages.push(...outputs);
    }
    const out:any={model:this.model,messages,stream:this.stream}; if(this.stream) out.stream_options={include_usage:true};
    const cfg=body.generationConfig ?? {};
    for(const k of Object.keys(cfg)) if(!['temperature','topP','maxOutputTokens','stopSequences','candidateCount'].includes(k)) unsupported(`$.generationConfig.${k}`);
    for(const [a,b] of [['temperature','temperature'],['topP','top_p'],['maxOutputTokens','max_completion_tokens'],['stopSequences','stop']] as const) if(cfg[a]!==undefined) out[b]=cfg[a];
    if(body.tools?.length) out.tools=body.tools.flatMap((t:any,i:number)=>{if(Object.keys(t).some(k=>k!=='functionDeclarations')) unsupported(`$.tools[${i}]`); if(!t.functionDeclarations) unsupported(`$.tools[${i}]`);return t.functionDeclarations.map((f:any)=>{for(const k of Object.keys(f)) if(!['name','description','parameters'].includes(k)) unsupported(`$.tools[${i}].functionDeclarations.${k}`);return {type:'function',function:f};});});
    if(body.toolConfig && Object.keys(body.toolConfig).some(k=>k!=='functionCallingConfig')) unsupported('$.toolConfig');
    const fc=body.toolConfig?.functionCallingConfig; if(fc) { if(fc.allowedFunctionNames?.length>1) unsupported('$.toolConfig.functionCallingConfig.allowedFunctionNames'); out.tool_choice=fc.allowedFunctionNames?.length ? {type:'function',function:{name:fc.allowedFunctionNames[0]}} : ({AUTO:'auto',ANY:'required',NONE:'none'} as any)[fc.mode]; if(!out.tool_choice) unsupported('$.toolConfig.functionCallingConfig.mode'); }
    return out;
  }
  transformResponse(body:any):any {
    if(body.error) return this.wrapError(500,body.error.message ?? 'Upstream error').body;
    if(body.choices?.length>1) unsupported('$.choices'); const c=body.choices?.[0], m=c?.message ?? {}; const parts:any[]=[];
    if(m.reasoning_content || m.reasoning) unsupported('$.choices[0].message.reasoning');
    if(m.content) { if(typeof m.content!=='string') unsupported('$.choices[0].message.content'); parts.push({text:m.content}); }
    for(const t of m.tool_calls ?? []) { if(t.type!=='function') unsupported('$.choices[0].message.tool_calls.type'); parts.push({functionCall:{id:t.id,name:t.function.name,args:parseArguments(t.function.arguments,'$.choices[0].message.tool_calls.arguments')}}); }
    const u=normalizeUsage('openai',body); const reason=c?.finish_reason;
    if(reason && !['stop','tool_calls','length','content_filter'].includes(reason)) unsupported('$.choices[0].finish_reason');
    return { responseId:body.id,modelVersion:body.model,candidates:c ? [{index:0,content:{role:'model',parts},...(reason ? {finishReason:reason==='length'?'MAX_TOKENS':reason==='content_filter'?'SAFETY':'STOP'}:{})}]:[],usageMetadata:{promptTokenCount:u.inputTokens,candidatesTokenCount:u.outputTokens,cachedContentTokenCount:u.cacheReadTokens} };
  }
  transformStream(stream:ReadableStream<Uint8Array>):BridgeStreamResult {
    const tools=new Map<number,any>(); let terminal=false;
    return mapSseStream(stream,body=>{
      if(body.error) { terminal = true; return [this.wrapError(500,body.error.message ?? 'Upstream error').body]; }
      if(body.choices?.length>1) unsupported('$.choices'); const c=body.choices?.[0]; const d=c?.delta ?? {}; const parts:any[]=[];
      if(d.reasoning_content || d.reasoning) unsupported('$.choices[0].delta.reasoning'); if(d.content) parts.push({text:d.content});
      for(const t of d.tool_calls ?? []) { if(t.type !== undefined && t.type !== 'function') unsupported('$.choices[0].delta.tool_calls.type'); if(typeof t.index!=='number') unsupported('$.choices[0].delta.tool_calls.index'); const old=tools.get(t.index) ?? {id:'',name:'',arguments:''}; if(t.id) old.id=t.id; if(t.function?.name) old.name+=t.function.name; if(t.function?.arguments) old.arguments+=t.function.arguments; tools.set(t.index,old); }
      if(c?.finish_reason) { terminal=true; for(const [index,t] of tools) {if(!t.name) unsupported('$.choices[0].delta.tool_calls.function.name');parts.push({functionCall:{id:t.id || `call_${index}`,name:t.name,args:parseArguments(t.arguments,'$.choices[0].delta.tool_calls.arguments')}});} tools.clear(); }
      const result=this.transformResponse({...body,choices:c ? [{...c,message:{content:''}}]:[]}); if(result.candidates[0]) result.candidates[0].content.parts=parts; return [result];
    },()=>{if(tools.size || !terminal) unsupported('$.stream.terminal');return [];},body=>normalizeUsage('openai',body));
  }
  wrapError(status:number,message:string):BridgeError { return {body:{error:{code:status,message,status:status===429?'RESOURCE_EXHAUSTED':'INTERNAL'}},contentType:'application/json'}; }
}
