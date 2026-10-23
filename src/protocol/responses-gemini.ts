import { randomUUID } from 'node:crypto';
import type { Bridge, BridgeError, BridgeStreamResult, Protocol } from './bridge.js';
import { normalizeUsage } from '../providers/usage.js';
import { assertGeminiSupported, geminiUsage, mapSseStream, unsupported } from './openai-gemini.js';

function args(value: any, path: string): any {
  if (typeof value !== 'string') return unsupported(path);
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unsupported(path); return parsed; }
  catch { return unsupported(path); }
}
function responsesSupported(body: any): void {
  for (const k of ['encrypted_content', 'reasoning_content']) if (body[k] !== undefined) unsupported(`$.${k}`);
  for (const k of ['previous_response_id', 'conversation', 'reasoning', 'include', 'background', 'truncation', 'prompt', 'audio', 'modalities']) if (body[k] !== undefined) unsupported(`$.${k}`);
  if (body.text?.format && body.text.format.type !== 'text') unsupported('$.text.format');
}
function responseUsage(body: any): any {
  const u = geminiUsage(body);
  return { input_tokens: u.inputTokens, output_tokens: u.outputTokens,
    total_tokens: u.inputTokens === undefined || u.outputTokens === undefined ? undefined : u.inputTokens + u.outputTokens,
    ...(u.cacheReadTokens === undefined ? {} : { input_tokens_details: { cached_tokens: u.cacheReadTokens } }) };
}
function geminiUsageFromResponses(body: any): any {
  const u = normalizeUsage('responses', body);
  return { promptTokenCount: u.inputTokens, candidatesTokenCount: u.outputTokens, cachedContentTokenCount: u.cacheReadTokens };
}
function responseStatus(reason: any): {status: string; incomplete_details?: any} {
  if (reason === undefined || reason === 'STOP') return { status: 'completed' };
  if (reason === 'MAX_TOKENS') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } };
  return unsupported('$.candidates[0].finishReason');
}
function finishReason(body: any): string {
  if (body.status === 'completed') return 'STOP';
  if (body.status === 'incomplete') {
    if (body.incomplete_details?.reason === 'max_output_tokens') return 'MAX_TOKENS';
    if (body.incomplete_details?.reason === 'content_filter') return 'SAFETY';
  }
  return unsupported('$.status');
}

/** Direct Responses client / Gemini upstream conversion. Instances are request scoped. */
export class ResponsesToGeminiBridge implements Bridge {
  readonly clientProto: Protocol = 'responses'; readonly upstreamProto: Protocol = 'gemini';
  private model = ''; private streaming = false; private readonly responseId = `resp_${randomUUID()}`;
  rewriteUrlPath(_path: string): string { return `/v1beta/models/${encodeURIComponent(this.model)}:${this.streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`; }
  transformRequest(body: any): any {
    responsesSupported(body); this.model = body.model; this.streaming = body.stream === true;
    const contents: any[] = [], system: any[] = []; const calls = new Map<string, string>(); const pending = new Set<string>();
    if (body.instructions !== undefined) { if (typeof body.instructions !== 'string') unsupported('$.instructions'); system.push({ text: body.instructions }); }
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    if (!Array.isArray(input)) unsupported('$.input');
    for (const [i, item] of input.entries()) {
      const path = `$.input[${i}]`;
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || calls.has(item.call_id)) unsupported(`${path}.call_id`);
        calls.set(item.call_id, item.name); pending.add(item.call_id);
        contents.push({ role: 'model', parts: [{ functionCall: { id: item.call_id, name: item.name, args: args(item.arguments, `${path}.arguments`) } }] });
      } else if (item.type === 'function_call_output') {
        const name = calls.get(item.call_id); if (!name || !pending.delete(item.call_id)) unsupported(`${path}.call_id`);
        if (typeof item.output !== 'string') unsupported(`${path}.output`);
        contents.push({ role: 'user', parts: [{ functionResponse: { id: item.call_id, name, response: { output: item.output } } }] });
      } else if (item.type === undefined || item.type === 'message') {
        if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) unsupported(`${path}.role`);
        const parts = typeof item.content === 'string' ? [{ text: item.content }] : (item.content ?? []).map((p: any, j: number) => {
          if (!['input_text', 'output_text'].includes(p.type) || typeof p.text !== 'string') unsupported(`${path}.content[${j}]`); return { text: p.text };
        });
        if (item.role === 'system' || item.role === 'developer') { if (contents.length) unsupported(`${path}.role`); system.push(...parts); }
        else contents.push({ role: item.role === 'assistant' ? 'model' : 'user', parts });
      } else unsupported(`${path}.type`);
    }
    const out: any = { contents }; if (system.length) out.systemInstruction = { parts: system };
    const cfg: any = {};
    for (const [a,b] of [['temperature','temperature'], ['top_p','topP'], ['max_output_tokens','maxOutputTokens']] as const) if (body[a] !== undefined) cfg[b] = body[a];
    if (Object.keys(cfg).length) out.generationConfig = cfg;
    if (body.tools?.length) out.tools = [{ functionDeclarations: body.tools.map((t: any, i: number) => { if (t.type !== 'function' || t.strict === true) unsupported(`$.tools[${i}]`); return { name: t.name, description: t.description, parameters: t.parameters }; }) }];
    if (body.tool_choice !== undefined) {
      const c = body.tool_choice; if (!['auto','none','required'].includes(c) && !(c?.type === 'function' && typeof c.name === 'string')) unsupported('$.tool_choice');
      out.toolConfig = { functionCallingConfig: { mode: c === 'auto' ? 'AUTO' : c === 'none' ? 'NONE' : 'ANY', ...(typeof c === 'object' ? { allowedFunctionNames: [c.name] } : {}) } };
    }
    for (let i = 1; i < contents.length;) { if (contents[i-1].role === contents[i].role) { contents[i-1].parts.push(...contents[i].parts); contents.splice(i,1); } else i++; }
    if (body.parallel_tool_calls === false) unsupported('$.parallel_tool_calls');
    return out;
  }
  transformResponse(body: any): any {
    assertGeminiSupported(body); if (body.error) return this.wrapError(body.error.code ?? 500, body.error.message ?? 'Upstream error').body;
    if (body.promptFeedback?.blockReason) unsupported('$.promptFeedback.blockReason');
    const output: any[] = []; const c = body.candidates?.[0]; const id = body.responseId ?? this.responseId;
    for (const [i,p] of (c?.content?.parts ?? []).entries()) {
      if (typeof p.text === 'string') output.push({ id: `msg_${id}_${i}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: p.text, annotations: [] }] });
      else if (p.functionCall) output.push({ id: `fc_${id}_${i}`, type: 'function_call', status: 'completed', call_id: p.functionCall.id ?? `call_${id}_${i}`, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) });
      else unsupported(`$.candidates[0].content.parts[${i}]`);
    }
    return { id, object: 'response', created_at: Math.floor(Date.now()/1000), model: body.modelVersion ?? this.model, ...responseStatus(c?.finishReason), output, usage: responseUsage(body) };
  }
  transformStream(stream: ReadableStream<Uint8Array>): BridgeStreamResult {
    let response: any; let sequence = 0, terminal = false, index = 0; const output: any[] = []; const callIds = new Set<string>(); let textItem: any;
    const event = (type: string, extra: any = {}) => ({ type, sequence_number: sequence++, ...extra });
    return mapSseStream(stream, body => {
      assertGeminiSupported(body); if (terminal) { if (body.candidates?.some((c: any) => c.content?.parts?.length)) unsupported('$.stream.after_terminal'); if (body.usageMetadata && response) response.usage = responseUsage(body); return []; }
      if (body.error) unsupported('$.error');
      if (body.promptFeedback?.blockReason) unsupported('$.promptFeedback.blockReason');
      const events: any[] = [];
      if (!response) { response = { id: body.responseId ?? this.responseId, object: 'response', created_at: Math.floor(Date.now()/1000), model: body.modelVersion ?? this.model, status: 'in_progress', output: [], usage: undefined }; events.push(event('response.created', { response: { ...response } }), event('response.in_progress', { response: { ...response } })); }
      const closeText = () => { if (!textItem) return; const n = output.indexOf(textItem); events.push(event('response.output_text.done', { item_id: textItem.id, output_index: n, content_index: 0, text: textItem.content[0].text }), event('response.content_part.done', { item_id: textItem.id, output_index: n, content_index: 0, part: textItem.content[0] }), event('response.output_item.done', { output_index: n, item: { ...textItem, status: 'completed' } })); textItem.status = 'completed'; textItem = undefined; };
      for (const [j,p] of (body.candidates?.[0]?.content?.parts ?? []).entries()) {
        if (typeof p.text === 'string') {
          if (!textItem) { textItem = { id: `msg_${response.id}_${index++}`, type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [] }] }; output.push(textItem); const n = output.length-1; events.push(event('response.output_item.added', { output_index: n, item: { ...textItem, content: [] } }), event('response.content_part.added', { item_id: textItem.id, output_index: n, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })); }
          textItem.content[0].text += p.text; events.push(event('response.output_text.delta', { item_id: textItem.id, output_index: output.indexOf(textItem), content_index: 0, delta: p.text }));
        } else if (p.functionCall) {
          closeText(); const f = p.functionCall, n = output.length; const callId = f.id ?? `call_${response.id}_${index}`; if (callIds.has(callId)) unsupported(`$.candidates[0].content.parts[${j}].functionCall.id`); callIds.add(callId);
          const item = { id: `fc_${response.id}_${index++}`, type: 'function_call', status: 'completed', call_id: callId, name: f.name, arguments: JSON.stringify(f.args ?? {}) }; output.push(item);
          events.push(event('response.output_item.added', { output_index: n, item: { ...item, status: 'in_progress', arguments: '' } }), event('response.function_call_arguments.delta', { item_id: item.id, output_index: n, delta: item.arguments }), event('response.function_call_arguments.done', { item_id: item.id, output_index: n, arguments: item.arguments }), event('response.output_item.done', { output_index: n, item }));
        } else unsupported(`$.candidates[0].content.parts[${j}]`);
      }
      if (body.usageMetadata) response.usage = responseUsage(body);
      if (body.candidates?.[0]?.finishReason) { closeText(); terminal = true; Object.assign(response, responseStatus(body.candidates[0].finishReason), { output }); }
      return events;
    }, () => { if (!terminal) return unsupported('$.stream.terminal'); return [event(response.status === 'completed' ? 'response.completed' : 'response.incomplete', { response })]; });
  }
  wrapError(status: number, message: string): BridgeError { return { body: { error: { message, type: status === 429 ? 'rate_limit_exceeded' : 'server_error', code: null } }, contentType: 'application/json' }; }
}

/** Direct Gemini client / Responses upstream conversion. */
export class GeminiToResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'gemini'; readonly upstreamProto: Protocol = 'responses';
  private model = ''; private streaming = false;
  rewriteUrlPath(path: string): string { const m = path.match(/\/models\/([^/:]+):(streamGenerateContent|generateContent)/); if (m) { this.model = decodeURIComponent(m[1]); this.streaming = m[2] === 'streamGenerateContent'; } return '/v1/responses'; }
  transformRequest(body: any): any {
    assertGeminiSupported(body); const input: any[] = []; const pending = new Map<string, { name: string; id: string }>();
    for (const [i,c] of (body.contents ?? []).entries()) {
      if (!['user','model'].includes(c.role ?? 'user')) unsupported(`$.contents[${i}].role`);
      for (const [j,p] of (c.parts ?? []).entries()) {
        const path = `$.contents[${i}].parts[${j}]`;
        if (typeof p.text === 'string') input.push({ role: c.role === 'model' ? 'assistant' : 'user', content: [{ type: c.role === 'model' ? 'output_text' : 'input_text', text: p.text }] });
        else if (p.functionCall) { if (c.role !== 'model') unsupported(`${path}.functionCall`); const f = p.functionCall, id = f.id ?? `call_${i}_${j}`; if (pending.has(id)) unsupported(`${path}.functionCall.id`); pending.set(id,{ name: f.name, id }); input.push({ type: 'function_call', id: `fc_${i}_${j}`, call_id: id, name: f.name, arguments: JSON.stringify(f.args ?? {}) }); }
        else if (p.functionResponse) { if (c.role === 'model') unsupported(`${path}.functionResponse`); const f = p.functionResponse; const matches = [...pending.values()].filter(x => x.name === f.name && (!f.id || x.id === f.id)); if (matches.length !== 1) unsupported(`${path}.functionResponse.id`); const call = matches[0]; pending.delete(call.id); input.push({ type: 'function_call_output', call_id: call.id, output: JSON.stringify(f.response ?? {}) }); }
        else unsupported(path);
      }
    }
    const out: any = { model: this.model, stream: this.streaming, input };
    if (body.systemInstruction) out.instructions = (body.systemInstruction.parts ?? []).map((p: any) => { if (typeof p.text !== 'string') unsupported('$.systemInstruction.parts'); return p.text; }).join('');
    const cfg = body.generationConfig ?? {}; for (const k of Object.keys(cfg)) if (!['temperature','topP','maxOutputTokens','candidateCount'].includes(k)) unsupported(`$.generationConfig.${k}`);
    for (const [a,b] of [['temperature','temperature'],['topP','top_p'],['maxOutputTokens','max_output_tokens']] as const) if (cfg[a] !== undefined) out[b] = cfg[a];
    if (body.tools?.length) out.tools = body.tools.flatMap((t: any,i: number) => { if (!t.functionDeclarations) unsupported(`$.tools[${i}]`); return t.functionDeclarations.map((f: any) => ({ type: 'function', name: f.name, description: f.description, parameters: f.parameters })); });
    const fc = body.toolConfig?.functionCallingConfig; if (fc) { if (fc.allowedFunctionNames?.length > 1) unsupported('$.toolConfig.functionCallingConfig.allowedFunctionNames'); out.tool_choice = fc.allowedFunctionNames?.length ? { type: 'function', name: fc.allowedFunctionNames[0] } : ({ AUTO: 'auto', ANY: 'required', NONE: 'none' } as any)[fc.mode]; if (!out.tool_choice) unsupported('$.toolConfig.functionCallingConfig.mode'); }
    return out;
  }
  transformResponse(body: any): any {
    if (body.error || body.status === 'failed') return this.wrapError(500, body.error?.message ?? 'Upstream error').body;
    const parts: any[] = [];
    for (const [i,item] of (body.output ?? []).entries()) {
      const path = `$.output[${i}]`;
      if (item.type === 'message') for (const [j,p] of (item.content ?? []).entries()) { if (p.type !== 'output_text') unsupported(`${path}.content[${j}].type`); if (p.annotations?.length) unsupported(`${path}.content[${j}].annotations`); parts.push({ text: p.text }); }
      else if (item.type === 'function_call') parts.push({ functionCall: { id: item.call_id, name: item.name, args: args(item.arguments, `${path}.arguments`) } });
      else unsupported(`${path}.type`);
    }
    return { responseId: body.id, modelVersion: body.model, candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: finishReason(body) }], usageMetadata: geminiUsageFromResponses(body) };
  }
  transformStream(stream: ReadableStream<Uint8Array>): BridgeStreamResult {
    let terminal = false, id: string | undefined, model: string | undefined; const items = new Map<number, any>();
    const chunk = (parts: any[], extra: any = {}) => ({ responseId: id, modelVersion: model, candidates: [{ index: 0, content: { role: 'model', parts }, ...extra }] });
    return mapSseStream(stream, body => {
      if (terminal) unsupported('$.stream.after_terminal');
      if (body.response) { id = body.response.id ?? id; model = body.response.model ?? model; }
      switch (body.type) {
        case 'response.created': case 'response.in_progress': return [];
        case 'response.output_item.added': { const item = body.item; if (!['message','function_call'].includes(item?.type)) unsupported('$.item.type'); if (items.has(body.output_index)) unsupported('$.output_index'); items.set(body.output_index, { ...item, arguments: '', text: '' }); return []; }
        case 'response.content_part.added': case 'response.content_part.done': if (body.part?.type !== 'output_text') unsupported('$.part.type'); if (body.part.annotations?.length) unsupported('$.part.annotations'); return [];
        case 'response.output_text.delta': { const item = items.get(body.output_index); if (item?.type !== 'message' || (body.item_id && body.item_id !== item.id)) unsupported('$.item_id'); if (typeof body.delta !== 'string') unsupported('$.delta'); item.text += body.delta; return [chunk([{ text: body.delta }])]; }
        case 'response.output_text.done': return [];
        case 'response.function_call_arguments.delta': { const item = items.get(body.output_index); if (item?.type !== 'function_call' || (body.item_id && body.item_id !== item.id)) unsupported('$.item_id'); item.arguments += body.delta; return []; }
        case 'response.function_call_arguments.done': { const item = items.get(body.output_index); if (item?.type !== 'function_call') unsupported('$.output_index'); if (body.arguments !== undefined && body.arguments !== item.arguments) unsupported('$.arguments'); return []; }
        case 'response.output_item.done': { const item = items.get(body.output_index); if (!item || item.id !== body.item?.id || item.type !== body.item?.type) unsupported('$.item'); if (item.done) unsupported('$.output_index'); item.done = true; if (item.type !== 'function_call') { for (const p of body.item.content ?? []) if (p.type !== 'output_text' || p.annotations?.length) unsupported('$.item.content'); return []; } if (body.item.call_id !== item.call_id || body.item.name !== item.name) unsupported('$.item'); if (body.item.arguments !== item.arguments) unsupported('$.item.arguments'); return [chunk([{ functionCall: { id: item.call_id, name: item.name, args: args(item.arguments, '$.item.arguments') } }])]; }
        case 'response.completed': case 'response.incomplete': { if ([...items.values()].some(x => !x.done)) unsupported('$.stream.items'); const r = body.response; for (const [i,item] of (r.output ?? []).entries()) { if (!['message','function_call'].includes(item.type)) unsupported(`$.response.output[${i}].type`); const known = items.get(i); if (!known || known.id !== item.id || known.type !== item.type) unsupported(`$.response.output[${i}]`); if (item.type === 'function_call' && (known.arguments !== item.arguments || known.call_id !== item.call_id || known.name !== item.name)) unsupported(`$.response.output[${i}]`); if (item.type === 'message') { let text = ''; for (const p of item.content ?? []) { if (p.type !== 'output_text' || p.annotations?.length) unsupported(`$.response.output[${i}].content`); text += p.text; } if (text !== known.text) unsupported(`$.response.output[${i}].content`); } } terminal = true; return [{ ...chunk([], { finishReason: finishReason(r) }), usageMetadata: geminiUsageFromResponses(r) }]; }
        case 'response.failed': case 'error': unsupported('$.error');
        default: unsupported('$.type');
      }
    }, () => { if (!terminal) unsupported('$.stream.terminal'); return []; }, body => normalizeUsage('responses', body.response));
  }
  wrapError(status: number, message: string): BridgeError { return { body: { error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL' } }, contentType: 'application/json' }; }
}
