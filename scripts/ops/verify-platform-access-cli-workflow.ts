import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Socket } from 'node:net';
import type { PlatformFirstRequestCliContext, PlatformFirstRequestCliResult } from './verify-platform-access-first-request.js';

const CLI_VERSION = '2.1.216' as const;
const MAX_MESSAGES = 3;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
type NativeUsage = { [K in typeof USAGE_FIELDS[number]]: number };
export interface CliWorkflowRequestFacts { maxTokens: number; thinking:'omitted'|'disabled'|'adaptive'; stream: true; toolCount: number }
type CliWorkflowContractCode = 'CONTRACT_REJECTED' | 'METHOD_NOT_POST' | 'PATH_NOT_ALLOWED' |
  'BODY_NOT_OBJECT' | 'MODEL_MISMATCH' | 'STREAM_REQUIRED' | 'MAX_TOKENS_INVALID' |
  'THINKING_NOT_DISABLED' | 'MESSAGES_SHAPE' | 'TOOLS_COUNT' | 'READ_TOOL_SCHEMA' |
  'BODY_LIMIT' | 'JSON_INVALID' | 'AUTH_MISMATCH' | 'ROOT_HEAD_LIMIT' | 'ROOT_HEAD_BODY' | 'THINKING_NOT_OMITTED' | 'THINKING_NOT_ENABLED' | 'OUTPUT_BOUND_EXCEEDED';
type WorkflowScene='thinking-disabled'|'omitted-observation'|'enabled-observation';
/**
 * Per-scene CLI contract bounds. The enabled-observation scene implements the
 * documented positive-thinking candidate design (plan §11.2): budget 1024,
 * output/max_tokens bound 1536, and thinking history replay is REQUIRED — the
 * observed counterpart of the omitted scene's replay-omission fact.
 */
interface WorkflowSceneContract {
  readonly maxTokensBound:number; readonly outputTokensBound:number;
  readonly maxThinkingTokens:string; readonly maxOutputTokens:string;
}
function sceneContract(scene:WorkflowScene):WorkflowSceneContract {
  return scene==='enabled-observation'
    ? {maxTokensBound:1536,outputTokensBound:1536,maxThinkingTokens:'1024',maxOutputTokens:'1536'}
    : {maxTokensBound:512,outputTokensBound:512,maxThinkingTokens:'0',maxOutputTokens:'512'};
}
/** Scenes that may observe and relay provider thinking blocks (never the disabled gate). */
function sceneAllowsThinking(scene:WorkflowScene):boolean {return scene!=='thinking-disabled';}
class CliWorkflowContractError extends Error {
  constructor(readonly code:CliWorkflowContractCode){super(`CLI workflow contract rejected: ${code}`);this.name='CliWorkflowContractError';}
}
function fail(code:CliWorkflowContractCode='CONTRACT_REJECTED'):never { throw new CliWorkflowContractError(code); }
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

function requireCliWorkflowEndpoint(method:string,path:string):void {
  if(method!=='POST')fail('METHOD_NOT_POST');
  if(!['/v1/messages','/v1/messages?beta=true'].includes(path))fail('PATH_NOT_ALLOWED');
}

/** Safe projection only. The observer forwards the original bytes, never this object. */
export function validateCliWorkflowRequest(input: {method: string; path: string; body: unknown; publicModel: string; scene?:WorkflowScene}): CliWorkflowRequestFacts {
  requireCliWorkflowEndpoint(input.method,input.path);
  const scene=input.scene ?? 'thinking-disabled';
  const b=input.body;
  if(!record(b))fail('BODY_NOT_OBJECT');
  if(b.model!==input.publicModel)fail('MODEL_MISMATCH');
  if(b.stream!==true)fail('STREAM_REQUIRED');
  if(!count(b.max_tokens)||b.max_tokens<1||b.max_tokens>sceneContract(scene).maxTokensBound)fail('MAX_TOKENS_INVALID');
  if(scene==='enabled-observation'){
    // Observed CLI fact (Claude Code 2.1.216, capture run 2026-10-24): a
    // positive MAX_THINKING_TOKENS budget is represented as adaptive thinking
    // — exactly {type:'adaptive'}, optionally with a bounded max_thinking_tokens.
    if(!record(b.thinking)||b.thinking.type!=='adaptive'||Object.keys(b.thinking).some(k=>!['type','max_thinking_tokens'].includes(k))||
      (b.thinking.max_thinking_tokens!==undefined&&(!count(b.thinking.max_thinking_tokens)||b.thinking.max_thinking_tokens<1||b.thinking.max_thinking_tokens>1024)))fail('THINKING_NOT_ENABLED');
  }else if(b.thinking!==undefined&&(!record(b.thinking)||b.thinking.type!=='disabled'||Object.keys(b.thinking).some(k=>k!=='type')))fail('THINKING_NOT_DISABLED');
  if(!Array.isArray(b.messages)||b.messages.length===0)fail('MESSAGES_SHAPE');
  if(!Array.isArray(b.tools)||b.tools.length!==1)fail('TOOLS_COUNT');
  const tool=b.tools[0];
  if(!record(tool)||tool.name!=='Read'||!record(tool.input_schema)||tool.input_schema.type!=='object'||
    tool.input_schema.properties?.file_path?.type!=='string'||!Array.isArray(tool.input_schema.required)||!tool.input_schema.required.includes('file_path'))fail('READ_TOOL_SCHEMA');
  return {maxTokens:b.max_tokens,thinking:scene==='enabled-observation'?'adaptive':b.thinking===undefined?'omitted':'disabled',stream:true,toolCount:b.tools.length};
}

export interface CliWorkflowRequestShape {
  modelMatches:boolean; stream:'true'|'false'|'missing'|'other';
  maxTokens:number|'missing'|'invalid'|'above-diagnostic-range';
  thinkingType:'missing'|'disabled'|'enabled'|'adaptive'|'other'; thinkingExtraFields:boolean;
  toolsCount:number|'missing'|'invalid'; toolNames:Array<'Read'|'other'>;
  messagesCount:number|'missing'|'invalid'; readSchemaFilePathString:boolean; readSchemaRequiresFilePath:boolean;
}
/** Diagnostic projection: no original string, object, schema key or tool argument is returned. */
export function describeCliWorkflowRequest(body:unknown,publicModel:string):CliWorkflowRequestShape|undefined {
  if(!record(body))return undefined;
  const boundedCount=(value:unknown):number|'missing'|'invalid'=>value===undefined?'missing':Array.isArray(value)&&value.length<=1_000_000?value.length:'invalid';
  const schema=Array.isArray(body.tools)&&record(body.tools[0])?body.tools[0].input_schema:undefined;
  const thinkingType=body.thinking===undefined?'missing':record(body.thinking)&&['disabled','enabled','adaptive'].includes(body.thinking.type)?body.thinking.type:'other';
  return {
    modelMatches:body.model===publicModel,
    stream:body.stream===undefined?'missing':body.stream===true?'true':body.stream===false?'false':'other',
    maxTokens:body.max_tokens===undefined?'missing':count(body.max_tokens)?body.max_tokens<=1_000_000?body.max_tokens:'above-diagnostic-range':'invalid',
    thinkingType,thinkingExtraFields:record(body.thinking)&&Object.keys(body.thinking).some(key=>key!=='type'),
    toolsCount:boundedCount(body.tools),toolNames:Array.isArray(body.tools)?body.tools.slice(0,8).map(tool=>record(tool)&&tool.name==='Read'?'Read':'other'):[],
    messagesCount:boundedCount(body.messages),
    readSchemaFilePathString:record(schema)&&schema.properties?.file_path?.type==='string',
    readSchemaRequiresFilePath:record(schema)&&Array.isArray(schema.required)&&schema.required.includes('file_path'),
  };
}
export interface CliWorkflowTransportMetadata {
  method:'POST'|'GET'|'HEAD'|'OPTIONS'|'PUT'|'PATCH'|'DELETE'|'other';
  pathCategory:'root'|'messages'|'count_tokens'|'other';
  contentType:'json'|'other'|'missing';
  contentEncoding:'identity'|'gzip'|'br'|'deflate'|'zstd'|'other'|'missing';
  bodySize:'unread'|'empty'|'le_1k'|'le_64k'|'le_1m'|'le_4m'|'over_limit';
}
/** Fixed transport categories remain available when no JSON object can be decoded. */
export function describeCliWorkflowTransport(input:{method:string;path:string;contentType?:unknown;contentEncoding?:unknown;bodyBytes?:number}):CliWorkflowTransportMetadata {
  const method=['POST','GET','HEAD','OPTIONS','PUT','PATCH','DELETE'].includes(input.method)?input.method as CliWorkflowTransportMetadata['method']:'other';
  const path=input.path.split('?')[0];
  const contentType=input.contentType===undefined?'missing':typeof input.contentType==='string'&&input.contentType.split(';')[0].trim().toLowerCase()==='application/json'?'json':'other';
  const encoding=typeof input.contentEncoding==='string'?input.contentEncoding.trim().toLowerCase():undefined;
  const contentEncoding=input.contentEncoding===undefined?'missing':encoding!==undefined&&['identity','gzip','br','deflate','zstd'].includes(encoding)?encoding as CliWorkflowTransportMetadata['contentEncoding']:'other';
  const n=input.bodyBytes;
  const bodySize=n===undefined?'unread':!count(n)?'unread':n===0?'empty':n<=1024?'le_1k':n<=65536?'le_64k':n<=1024*1024?'le_1m':n<=MAX_BODY_BYTES?'le_4m':'over_limit';
  return {method,pathCategory:path==='/'?'root':path==='/v1/messages'?'messages':path==='/v1/messages/count_tokens'?'count_tokens':'other',contentType,contentEncoding,bodySize};
}
export interface CliWorkflowAuxFacts {rootHeadCount:number;rootHeadByPhase:{version:number;workflow:number}}
/** Only the actually observed root HEAD route; this does not identify its purpose. */
export class CliWorkflowRootHeadObserver {
  private readonly counts={version:0,workflow:0};
  observe(input:{method:string;path:string;phase:'version'|'workflow';contentLength?:unknown;transferEncoding?:unknown}):boolean {
    if(input.method!=='HEAD'||input.path!=='/')return false;
    if(input.phase!=='version'&&input.phase!=='workflow')fail();
    this.counts[input.phase]++;
    if(this.counts[input.phase]>1||this.counts.version+this.counts.workflow>2)fail('ROOT_HEAD_LIMIT');
    if((input.contentLength!==undefined&&input.contentLength!=='0')||input.transferEncoding!==undefined)fail('ROOT_HEAD_BODY');
    return true;
  }
  observeBodyChunk(chunk:Uint8Array):void {if(chunk.byteLength!==0)fail('ROOT_HEAD_BODY');}
  facts():CliWorkflowAuxFacts {
    if(this.counts.version>1||this.counts.workflow>1)fail('ROOT_HEAD_LIMIT');
    return {rootHeadCount:this.counts.version+this.counts.workflow,rootHeadByPhase:{...this.counts}};
  }
}
type CliWorkflowDiagnosticStage='auxiliary-contract'|'transport-contract'|'body-read'|'json-decode'|'request-contract'|'auth'|'capture-stop'|'forward';
export interface CliWorkflowDiagnosticInput {mode:'capture'|'real';stage:CliWorkflowDiagnosticStage;attemptCount:number;method:string;path:string;body:unknown;publicModel:string;contentType?:unknown;contentEncoding?:unknown;bodyBytes?:number;cliPhase?:'version'|'workflow';historyCompare?:CliWorkflowHistoryCompare}
/** Structure-only assistant-history comparison: block types and bounded lengths, never content bytes. */
export interface CliWorkflowHistoryCompare {expected:unknown[];actual:unknown[]}
type CliWorkflowBlockStructure={type:string;textLength?:number;thinkingLength?:number;hasSignature?:true};
function describeCliWorkflowBlocks(content:unknown):CliWorkflowBlockStructure[]{
  if(!Array.isArray(content))return [{type:'not-array'}];
  const blocks=content.slice(0,8).map((block):CliWorkflowBlockStructure=>{
    if(!record(block))return {type:'non-record'};
    const type=typeof block.type==='string'&&block.type.length<=32?block.type:'other';
    const out:CliWorkflowBlockStructure={type};
    if(typeof block.text==='string')out.textLength=Math.min(block.text.length,1_000_000);
    if(typeof block.thinking==='string')out.thinkingLength=Math.min(block.thinking.length,1_000_000);
    if(typeof block.signature==='string')out.hasSignature=true;
    return out;
  });
  if(content.length>8)blocks.push({type:'truncated',textLength:content.length});
  return blocks;
}
function describeCliWorkflowMessages(body:unknown):Array<{role:string;blocks:CliWorkflowBlockStructure[]}>{
  const messages=record(body)&&Array.isArray((body as Record<string,any>).messages)?(body as Record<string,any>).messages:[];
  return messages.slice(0,8).map((message:unknown)=>({
    role:record(message)&&(message.role==='user'||message.role==='assistant')?message.role:'other',
    blocks:describeCliWorkflowBlocks(record(message)?message.content:undefined),
  }));
}
/** First failure is authoritative; later abort/cleanup failures never replace it. */
export function retainCliWorkflowFailure(previous:Error|undefined,error:unknown,input:CliWorkflowDiagnosticInput):Error {
  if(previous)return previous;
  const projection={kind:'cli-workflow-diagnostic-v1',mode:input.mode==='real'?'real':'capture',
    stage:['auxiliary-contract','transport-contract','body-read','json-decode','request-contract','auth','capture-stop','forward'].includes(input.stage)?input.stage:'request-contract',
    code:error instanceof CliWorkflowContractError?error.code:'UNEXPECTED_FAILURE',
    attemptCount:count(input.attemptCount)?Math.min(MAX_MESSAGES+1,input.attemptCount):0,
    method:describeCliWorkflowTransport(input).method,
    pathCategory:input.path==='/v1/messages'?'messages':input.path==='/v1/messages?beta=true'?'messages-beta':
      ['/v1/messages/count_tokens','/v1/messages/count_tokens?beta=true'].includes(input.path)?'count-tokens':'other',
    metadata:describeCliWorkflowTransport(input),
    ...(input.cliPhase==='version'||input.cliPhase==='workflow'?{cliPhase:input.cliPhase}:{}),
    ...(input.historyCompare===undefined?{}:{historyCompare:input.historyCompare}),
    ...(describeCliWorkflowRequest(input.body,input.publicModel)===undefined?{}:{requestShape:describeCliWorkflowRequest(input.body,input.publicModel)})};
  const safe=new Error(`CLI workflow rejected ${JSON.stringify(projection)}`);safe.stack=safe.message;return safe;
}

interface ObservedBlock {
  type:string;id?:string;name?:string;input?:unknown;json:string;text:string;
  thinking:string;signature?:string;signatureStarted:boolean;
}
interface Round {
  requestId?:string;usage:Partial<NativeUsage>;started:boolean;stopped:boolean;
  blocks:Map<number,ObservedBlock>;history:Array<Record<string,any>>;nextBlockIndex:number;
  calls:Array<{id:string;path:string}>;stopReason?:string;
}
function round():Round{return {usage:{},started:false,stopped:false,blocks:new Map(),history:[],nextBlockIndex:0,calls:[]};}
function resultText(value:unknown):string {
  if(typeof value==='string')return value;
  if(Array.isArray(value)&&value.every(p=>record(p)&&p.type==='text'&&typeof p.text==='string'))return value.map(p=>p.text).join('');
  return fail();
}

/** Per-run bounded in-memory checks; thinking/signatures are never evidence or diagnostics. */
export class CliWorkflowObserverState {
  private attempts=0;
  private retainedBytes=0;
  private readonly rounds=[round(),round(),round()];
  constructor(private readonly options:{publicModel:string;readFiles:readonly[string,string];answer:string;scene?:WorkflowScene}) {
    for(const value of [options.publicModel,...options.readFiles,options.answer])this.retain(value);
  }
  private charge(bytes:number):void {this.retainedBytes+=bytes;if(this.retainedBytes>MAX_BODY_BYTES)fail();}
  private retain(value:string):void {this.charge(Buffer.byteLength(value,'utf8'));}
  get attemptCount():number{return this.attempts;}
  observeRequest(input:{method:string;path:string;body:unknown}):CliWorkflowRequestFacts {
    this.attempts++;
    if(this.attempts>MAX_MESSAGES)fail();
    const facts=validateCliWorkflowRequest({...input,publicModel:this.options.publicModel,scene:this.options.scene});
    if(this.options.scene==='omitted-observation'&&facts.thinking!=='omitted')fail('THINKING_NOT_OMITTED');
    const index=this.attempts-1;
    const messages=(input.body as Record<string,any>).messages;
    if(this.options.scene==='omitted-observation'||this.options.scene==='enabled-observation'){
      const assistant=messages.filter((message:any)=>message.role==='assistant');
      if(assistant.length!==index)fail();
      for(let previous=0;previous<index;previous++)this.verifyHistory(assistant[previous].content,this.rounds[previous].history);
    }
    if(index>0){
      for(let previous=0;previous<index;previous++){
        const r=this.rounds[previous];if(!r.stopped||r.calls.length!==1)fail();
        const expected=r.calls[0];let seenUse=false,seenResult=false;
        for(const message of messages){
          const blocks=Array.isArray(message.content)?message.content:[];
          for(const block of blocks){
            if(block.type==='tool_use'&&block.id===expected.id){
              if(seenUse||seenResult||message.role!=='assistant'||block.name!=='Read'||block.input?.file_path!==expected.path)fail();
              seenUse=true;
            }
            if(block.type==='tool_result'&&block.tool_use_id===expected.id){
              if(seenResult||message.role!=='user'||!seenUse||block.is_error===true)fail();
              if(!resultText(block.content).includes(previous===0?basename(this.options.readFiles[1]):this.options.answer))fail();
              seenResult=true;
            }
          }
        }
        if(!seenUse||!seenResult)fail();
      }
    }
    const expectedHistory=this.rounds.slice(0,index).flatMap(r=>[r.calls[0]?.id,r.calls[0]?.id]);
    const actualHistory:string[]=[];
    for(const message of messages){
      for(const block of Array.isArray(message.content)?message.content:[]){
        if(block.type==='tool_use')actualHistory.push(block.id);
        else if(block.type==='tool_result')actualHistory.push(block.tool_use_id);
        else if(block.type==='thinking'){
          if(!sceneAllowsThinking(this.options.scene ?? 'thinking-disabled')||message.role!=='assistant')fail();
          if(typeof block.thinking!=='string'||(block.signature!==undefined&&typeof block.signature!=='string')||Object.keys(block).some(k=>!['type','thinking','signature'].includes(k)))fail();
        }else if(block.type!=='text')fail();
      }
    }
    if(actualHistory.length!==expectedHistory.length||actualHistory.some((id,i)=>id!==expectedHistory[i]))fail();
    return facts;
  }
  private verifyHistory(actual:unknown,expected:Array<Record<string,any>>):void {
    if(!Array.isArray(actual))fail();
    /*
     * Observed CLI contract (Claude Code 2.1.216, A1o live run04 and the
     * enabled-scene live run02 2026-10-24): the client does not replay
     * provider thinking blocks in subsequent assistant history — in the
     * omitted scene AND with a positive adaptive-thinking budget alike.
     * Omission is accepted as that observed fact in both observation
     * scenes; any replayed thinking must still byte-match the observed
     * upstream values in order, and thinking blocks may only precede the
     * replayable text/tool_use sequence. Thinking bytes are never retained
     * as evidence.
     */
    const expectedThinking=expected.filter(block=>block.type==='thinking');
    const replayable=expected.filter(block=>block.type!=='thinking');
    const actualThinking:unknown[]=[];const actualReplayable:unknown[]=[];let replayableStarted=false;
    for(const block of actual){
      if(record(block)&&block.type==='thinking'){
        if(replayableStarted)fail();
        actualThinking.push(block);
      }else{replayableStarted=true;actualReplayable.push(block);}
    }
    if(actualThinking.length>0){
      if(actualThinking.length!==expectedThinking.length)fail();
      for(let i=0;i<actualThinking.length;i++){
        const a=actualThinking[i],e=expectedThinking[i];
        if(!record(a)||a.thinking!==e.thinking||a.signature!==e.signature||Object.keys(a).some(k=>!['type','thinking','signature'].includes(k)))fail();
      }
    }
    if(actualReplayable.length!==replayable.length)fail();
    for(let i=0;i<replayable.length;i++){
      const a=actualReplayable[i],e=replayable[i];if(!record(a)||a.type!==e.type)fail();
      if(e.type==='text'){if(a.text!==e.text)fail();}
      else if(e.type==='tool_use'){if(a.id!==e.id||a.name!==e.name||JSON.stringify(a.input)!==JSON.stringify(e.input))fail();}
      else fail();
    }
  }
  noteRequestId(index:number,id:string):void {
    const r=this.rounds[index];
    if(!r||r.requestId||!/^(?:(?:gateway|managed)_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||this.rounds.some(x=>x.requestId===id))fail();r.requestId=id;
  }
  observeUpstreamEvent(index:number,event:unknown):void {
    const r=this.rounds[index];if(!r||!record(event)||r.stopped)fail();
    const merge=(usage:unknown)=>{if(!record(usage))return;for(const field of USAGE_FIELDS){if(usage[field]!==undefined){if(!count(usage[field]))fail();r.usage[field]=usage[field];}}};
    if(event.type==='message_start'){
      if(r.started||!record(event.message)||event.message.role!=='assistant'||(event.message.content!==undefined&&(!Array.isArray(event.message.content)||event.message.content.length!==0)))fail();r.started=true;merge(event.message.usage);return;
    }
    if(!r.started)fail();
    if(event.type==='content_block_start'){
      const b=event.content_block;
      if(!count(event.index)||!record(b)||r.blocks.has(event.index))fail();
      if(!['text','tool_use'].includes(b.type)&&!(sceneAllowsThinking(this.options.scene ?? 'thinking-disabled')&&b.type==='thinking'))fail();
      if(sceneAllowsThinking(this.options.scene ?? 'thinking-disabled')&&(r.blocks.size||event.index!==r.nextBlockIndex))fail();
      if(b.type==='tool_use'&&(b.name!=='Read'||typeof b.id!=='string'||!b.id))fail();
      if(b.type==='thinking'&&(typeof b.thinking!=='string'||(b.signature!==undefined&&typeof b.signature!=='string')||Object.keys(b).some(k=>!['type','thinking','signature'].includes(k))))fail();
      if(b.type==='text'&&(typeof b.text!=='string'||Object.keys(b).some(k=>!['type','text'].includes(k))))fail();
      if(b.type==='tool_use'&&Object.keys(b).some(k=>!['type','id','name','input'].includes(k)))fail();
      // Bound retained state across all rounds, not the sum of independent SSE events.
      this.charge(128);
      const block:ObservedBlock={type:b.type,id:b.type==='tool_use'?b.id:undefined,name:b.type==='tool_use'?b.name:undefined,input:b.type==='tool_use'?b.input:undefined,json:'',text:b.type==='text'?b.text:'',thinking:b.type==='thinking'?b.thinking:'',signature:b.type==='thinking'?b.signature:undefined,signatureStarted:b.type==='thinking'&&typeof b.signature==='string'&&b.signature.length>0};
      if(b.type==='text')this.retain(block.text);
      else if(b.type==='thinking'){this.retain(block.thinking);if(block.signature!==undefined)this.retain(block.signature);}
      else {this.retain(b.id);this.retain(b.name);this.retain(JSON.stringify(b.input ?? {}));}
      r.blocks.set(event.index,block);r.nextBlockIndex++;
    }else if(event.type==='content_block_delta'){
      const b=r.blocks.get(event.index);if(!b||!record(event.delta))fail();
      const fields:Record<string,readonly string[]>={text_delta:['type','text'],input_json_delta:['type','partial_json'],thinking_delta:['type','thinking'],signature_delta:['type','signature']};
      const allowed=fields[event.delta.type];if(!allowed||Object.keys(event.delta).some(key=>!allowed.includes(key)))fail();
      if(event.delta.type==='text_delta'&&b.type==='text'&&typeof event.delta.text==='string'){this.retain(event.delta.text);b.text+=event.delta.text;}
      else if(event.delta.type==='input_json_delta'&&b.type==='tool_use'&&typeof event.delta.partial_json==='string'){this.retain(event.delta.partial_json);b.json+=event.delta.partial_json;}
      else if(sceneAllowsThinking(this.options.scene ?? 'thinking-disabled')&&b.type==='thinking'&&event.delta.type==='thinking_delta'&&typeof event.delta.thinking==='string'&&!b.signatureStarted){this.retain(event.delta.thinking);b.thinking+=event.delta.thinking;}
      else if(sceneAllowsThinking(this.options.scene ?? 'thinking-disabled')&&b.type==='thinking'&&event.delta.type==='signature_delta'&&typeof event.delta.signature==='string'){this.retain(event.delta.signature);b.signature=(b.signature ?? '')+event.delta.signature;b.signatureStarted=true;}
      else fail();
    }else if(event.type==='content_block_stop'){
      const b=r.blocks.get(event.index);if(!b)fail();
      if(b.type==='tool_use'){
        let args=b.input;try{if(b.json)args=JSON.parse(b.json);}catch{fail();}
        if(index>1||!record(args)||args.file_path!==this.options.readFiles[index]||r.calls.length||this.rounds.some(other=>other.calls.some(c=>c.id===b.id)))fail();
        r.calls.push({id:b.id!,path:args.file_path});r.history.push({type:'tool_use',id:b.id,name:b.name,input:args});
      }else if(b.type==='text')r.history.push({type:'text',text:b.text});
      else if(b.type==='thinking')r.history.push({type:'thinking',thinking:b.thinking,...(b.signature===undefined?{}:{signature:b.signature})});
      else fail();
      r.blocks.delete(event.index);
    }else if(event.type==='message_delta'){
      if(!record(event.delta)||r.blocks.size||!record(event.usage)||!count(event.usage.output_tokens))fail();
      if(event.usage.output_tokens>sceneContract(this.options.scene ?? 'thinking-disabled').outputTokensBound)fail('OUTPUT_BOUND_EXCEEDED');
      merge(event.usage);if(USAGE_FIELDS.some(field=>!count(r.usage[field])))fail();r.stopReason=event.delta.stop_reason;
    }else if(event.type==='message_stop'){
      const text=r.history.filter(b=>b.type==='text').map(b=>b.text).join('');
      if(r.blocks.size||r.stopReason!==(index<2?'tool_use':'end_turn')||(index<2?r.calls.length!==1:r.calls.length!==0||!text.includes(this.options.answer)))fail();r.stopped=true;
    }else if(event.type!=='ping')fail();
  }
  finish():PlatformFirstRequestCliResult {
    if(this.attempts!==3)fail();
    const requests=this.rounds.map(r=>{if(!r.stopped||!r.requestId||USAGE_FIELDS.some(field=>!count(r.usage[field]))||r.usage.output_tokens! >sceneContract(this.options.scene ?? 'thinking-disabled').outputTokensBound)fail();return {requestId:r.requestId,usage:{...r.usage} as NativeUsage};});
    return {requests:requests as unknown as PlatformFirstRequestCliResult['requests']};
  }
  /** Structure-only projection of the retained upstream history; no content bytes. */
  historyStructure():CliWorkflowBlockStructure[][]{
    return this.rounds.map(r=>describeCliWorkflowBlocks(r.history));
  }
}

export interface CliCaptureEvidence {
  cliVersion:typeof CLI_VERSION; messageObserved:true; upstreamContacted:false; request:CliWorkflowRequestFacts;
  flags:{isolatedConfig:true;readOnlyTools:true;maxOutputCandidate:true;thinkingDisabledCandidate?:true;thinkingEnabledCandidate?:true};
  aux:CliWorkflowAuxFacts;
}
interface CaptureOptions {signal?:AbortSignal;tempDirectory?:string;registerChild?:(child:ChildProcess)=>void}
function cliEnv(directory:string,origin:string,key:string,scene:WorkflowScene='thinking-disabled'):NodeJS.ProcessEnv {
  const contract=sceneContract(scene);
  return {PATH:process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',...(process.env.HOME===undefined?{}:{HOME:process.env.HOME}),TMPDIR:directory,
    CLAUDE_CONFIG_DIR:join(directory,'config'),ANTHROPIC_BASE_URL:origin,ANTHROPIC_API_KEY:key,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS:contract.maxOutputTokens,MAX_THINKING_TOKENS:contract.maxThinkingTokens};
}
async function stopChild(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;
  const exit=new Promise<void>(resolveExit=>child.once('exit',()=>resolveExit()));
  if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
  const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}},2000);timer.unref();
  try{await exit;}finally{clearTimeout(timer);}
}
async function versionCheck(env:NodeJS.ProcessEnv,register:(child:ChildProcess)=>void):Promise<void>{
  const child=spawn('claude',['--version'],{env,stdio:['ignore','pipe','ignore'],detached:true});register(child);
  let version='';child.stdout?.on('data',chunk=>{if(version.length<256)version+=String(chunk);});
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',()=>no(new Error('Required local CLI is unavailable')));child.once('exit',yes);});
  if(code!==0||!/^2\.1\.216(?:\s|$)/.test(version.trim()))throw new Error('Required local Claude version is 2.1.216');
}
async function readBody(req:IncomingMessage,observeSize:(size:number)=>void):Promise<Buffer>{const chunks:Buffer[]=[];let size=0;observeSize(size);for await(const raw of req){const b=Buffer.from(raw);size+=b.length;observeSize(size);if(size>MAX_BODY_BYTES)fail('BODY_LIMIT');chunks.push(b);}return Buffer.concat(chunks);}
// The UTF-8 byte cap applies to each SSE block, excluding its blank-line separator.
export function createCliWorkflowSseObserver(onEvent:(event:unknown)=>void){
  const pendingBytes=(value:string)=>{
    // A fragmented blank-line separator is not part of the event block. Keep
    // at most its longest possible prefix pending until the next bytes arrive.
    const prefix=['\r\n\r','\r\n','\n','\r'].find(part=>value.endsWith(part));
    return Buffer.byteLength(value,'utf8')-(prefix?.length ?? 0);
  };
  const decoder=new TextDecoder();let buffer='';
  const parse=(block:string)=>{if(Buffer.byteLength(block,'utf8')>MAX_BODY_BYTES)fail();const data=block.split(/\r\n|\r|\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(!data)return;if(data==='[DONE]')fail();let value:unknown;try{value=JSON.parse(data);}catch{fail();}onEvent(value);};
  return {push(chunk:Buffer){buffer+=decoder.decode(chunk,{stream:true});let match:RegExpExecArray|null;while((match=/\r\n\r\n|\n\n|\r\r/.exec(buffer))){parse(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);}if(pendingBytes(buffer)>MAX_BODY_BYTES)fail();},end(){buffer+=decoder.decode();if(Buffer.byteLength(buffer,'utf8')>MAX_BODY_BYTES)fail();if(buffer.trim())parse(buffer);}};
}

/** Capture mode owns no gateway/provider and never forwards a captured request. */
export async function capturePlatformAccessCliWorkflow(options:CaptureOptions={}):Promise<CliCaptureEvidence>{
  return executeCli({kind:'capture',options}) as Promise<CliCaptureEvidence>;
}
/** Provider-free capture preflight for the thinking-enabled observation contract. */
export async function capturePlatformAccessCliThinkingWorkflow(options:CaptureOptions={}):Promise<CliCaptureEvidence>{
  return executeCli({kind:'capture',options,scene:'enabled-observation'}) as Promise<CliCaptureEvidence>;
}
export async function runPlatformAccessCliWorkflow(context:PlatformFirstRequestCliContext):Promise<PlatformFirstRequestCliResult>{
  return executeCli({kind:'real',context,scene:'thinking-disabled'}) as Promise<PlatformFirstRequestCliResult>;
}

/** Separate controlled observation; never weakens the disabled-scene gate. */
export async function runPlatformAccessCliObservationWorkflow(context:PlatformFirstRequestCliContext):Promise<PlatformFirstRequestCliResult>{
  return executeCli({kind:'real',context,scene:'omitted-observation'}) as Promise<PlatformFirstRequestCliResult>;
}

/** Thinking-enabled observation: the positive-budget counterpart scene. */
export async function runPlatformAccessCliThinkingObservationWorkflow(context:PlatformFirstRequestCliContext):Promise<PlatformFirstRequestCliResult>{
  return executeCli({kind:'real',context,scene:'enabled-observation'}) as Promise<PlatformFirstRequestCliResult>;
}

async function executeCli(mode:{kind:'capture';options:CaptureOptions;scene?:WorkflowScene}|{kind:'real';context:PlatformFirstRequestCliContext;scene:WorkflowScene}):Promise<CliCaptureEvidence|PlatformFirstRequestCliResult> {
  const options=mode.kind==='real'?mode.context:mode.options;
  const scene=mode.kind==='real'?mode.scene:(mode.scene ?? 'thinking-disabled');
  const gateway=mode.kind==='real'?new URL(mode.context.gatewayOrigin):undefined;
  if(gateway&&(gateway.protocol!=='http:'||gateway.hostname!=='127.0.0.1'||!gateway.port||gateway.pathname!=='/'||gateway.search||gateway.hash||gateway.username||gateway.password))fail();
  const directory=await mkdtemp(join(options.tempDirectory ?? tmpdir(),'platform-cli-'));
  const controller=new AbortController();const children=new Set<ChildProcess>();const sockets=new Set<Socket>();
  const signal=()=>controller.abort();options.signal?.addEventListener('abort',signal,{once:true});
  const register=(child:ChildProcess)=>{children.add(child);options.registerChild?.(child);if(controller.signal.aborted)void stopChild(child);};
  let failure:Error|undefined,capture:CliCaptureEvidence|undefined;let cli:ChildProcess|undefined;
  const abort=()=>{controller.abort();for(const child of children)void stopChild(child);for(const socket of sockets)socket.destroy();};
  controller.signal.addEventListener('abort',abort,{once:true});
  const deadline=setTimeout(()=>{failure ??= new Error('CLI workflow deadline exceeded; details redacted');controller.abort();},mode.kind==='capture'?30_000:120_000);deadline.unref();
  const files=[join(directory,`first-${randomUUID()}.txt`),join(directory,`second-${randomUUID()}.txt`)] as const;
  const answer=randomBytes(24).toString('hex');
  const publicModel=mode.kind==='real'?mode.context.publicModel:'capture-only-public-model';
  const state=new CliWorkflowObserverState({publicModel,readFiles:files,answer,scene});
  const aux=new CliWorkflowRootHeadObserver();let cliPhase:'version'|'workflow'='version';
  const pending=new Set<Promise<void>>();
  const server=createServer((req,res)=>{const requestCliPhase=cliPhase;let stage:CliWorkflowDiagnosticStage='transport-contract';let body:unknown;let bodyBytes:number|undefined;const operation=(async()=>{
    stage='auxiliary-contract';
    if(aux.observe({method:req.method ?? '',path:req.url ?? '',phase:requestCliPhase,contentLength:req.headers['content-length'],transferEncoding:req.headers['transfer-encoding']})){
      bodyBytes=0;
      for await(const chunk of req){bodyBytes+=Buffer.byteLength(chunk);aux.observeBodyChunk(chunk);}
      // The loopback observer has no root route. Return its real absence, not
      // a successful model/count_tokens response, and never contact the GW.
      res.writeHead(404,{'content-length':'0','cache-control':'no-store'});res.end();return;
    }
    stage='transport-contract';requireCliWorkflowEndpoint(req.method ?? '',req.url ?? '');stage='body-read';
    const bytes=await readBody(req,size=>{bodyBytes=size;});stage='json-decode';try{body=JSON.parse(bytes.toString('utf8'));}catch{fail('JSON_INVALID');}
    stage='request-contract';const facts=state.observeRequest({method:req.method ?? '',path:req.url ?? '',body});
    // Omission is an observed fact, not proof of a disabled provider default.
    // Capture may report it, but no paid/live request can cross this boundary.
    if(mode.kind==='real'&&facts.thinking!==(scene==='omitted-observation'?'omitted':scene==='enabled-observation'?'adaptive':'disabled'))fail(scene==='omitted-observation'?'THINKING_NOT_OMITTED':scene==='enabled-observation'?'THINKING_NOT_ENABLED':'THINKING_NOT_DISABLED');
    stage='auth';const expectedKey=mode.kind==='real'?mode.context.customerKey:'capture-only-dummy-key';
    if((req.headers['x-api-key']!==undefined&&req.headers['x-api-key']!==expectedKey)||
       (req.headers.authorization!==undefined&&req.headers.authorization!==`Bearer ${expectedKey}`)||
       (req.headers['x-api-key']!==expectedKey&&req.headers.authorization!==`Bearer ${expectedKey}`))fail('AUTH_MISMATCH');
    if(mode.kind==='capture'){
      capture={cliVersion:CLI_VERSION,messageObserved:true,upstreamContacted:false,request:facts,
        flags:{isolatedConfig:true,readOnlyTools:true,maxOutputCandidate:true,...(scene==='enabled-observation'?{thinkingEnabledCandidate:true}:{thinkingDisabledCandidate:true})},aux:aux.facts()};
      res.writeHead(403,{'content-type':'application/json'});res.end('{"error":{"type":"permission_error","message":"capture complete"}}');
      stage='capture-stop';if(cli)await stopChild(cli);return;
    }
    const index=state.attemptCount-1;
    // Fixed fixture destination and original request bytes. No fallback provider,
    // endpoint rewrite, generation retry, payload normalization or fake count_tokens.
    stage='forward';await forward(req,res,bytes,gateway!,controller.signal,index,state);
  })().catch(error=>{failure=retainCliWorkflowFailure(failure,error,{mode:mode.kind,stage,attemptCount:state.attemptCount,method:req.method ?? '',path:req.url ?? '',body,publicModel,contentType:req.headers['content-type'],contentEncoding:req.headers['content-encoding'],bodyBytes,cliPhase:requestCliPhase,...(mode.kind==='real'&&body!==undefined?{historyCompare:{expected:state.historyStructure(),actual:describeCliWorkflowMessages(body)}}:{})});if(!res.destroyed&&!res.headersSent){res.writeHead(403,{'content-type':'application/json'});res.end('{"error":{"type":"permission_error","message":"workflow rejected"}}');}abort();});pending.add(operation);void operation.then(()=>pending.delete(operation),()=>pending.delete(operation));});
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  try{
    if(options.signal?.aborted||controller.signal.aborted)fail();
    await mkdir(join(directory,'config'),{recursive:true});
    await writeFile(files[0],basename(files[1]),{mode:0o600});await writeFile(files[1],answer,{mode:0o600});
    const mcpPath=join(directory,'empty-mcp.json');await writeFile(mcpPath,JSON.stringify({mcpServers:{}}),{mode:0o600});
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')fail();
    const env=cliEnv(directory,`http://127.0.0.1:${address.port}`,mode.kind==='real'?mode.context.customerKey:'capture-only-dummy-key',scene);
    await versionCheck(env,register);
    if(options.signal?.aborted||controller.signal.aborted)fail();
    const prompt=`Use Read to read ${files[0]}. That file names a second file in the same directory. Read the second file using Read, then return exactly its contents. Do not use any other tool or guess the second filename.`;
    cliPhase='workflow';
    cli=spawn('claude',['-p','--output-format','stream-json','--verbose','--model',publicModel,'--tools','Read','--allowedTools','Read','--disable-slash-commands','--no-session-persistence','--strict-mcp-config','--mcp-config',mcpPath,'--setting-sources','',prompt],{cwd:directory,env,detached:true,stdio:['ignore','pipe','pipe']});
    register(cli);cli.stdout?.resume();cli.stderr?.resume();
    const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((yes,no)=>{cli!.once('error',()=>no(new Error('Required local CLI could not start')));cli!.once('exit',(code,signal)=>yes({code,signal}));});
    if(failure)throw failure;
    if(mode.kind==='capture'){if(!capture)fail();return {...capture,aux:aux.facts()};}
    if(exit.code!==0||exit.signal!==null)fail();
    return state.finish();
  }finally{
    clearTimeout(deadline);controller.abort();options.signal?.removeEventListener('abort',signal);
    await Promise.allSettled([...children].map(stopChild));for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));await Promise.allSettled([...pending]);await rm(directory,{recursive:true,force:true});
  }
}

async function forward(req:IncomingMessage,res:ServerResponse,bytes:Buffer,gateway:URL,signal:AbortSignal,index:number,state:CliWorkflowObserverState):Promise<void>{
  await new Promise<void>((resolveForward,reject)=>{
    const upstream=httpRequest({hostname:gateway.hostname,port:gateway.port,method:req.method,path:req.url,headers:{...req.headers,host:gateway.host},signal},response=>{
      void (async()=>{
        if(response.statusCode!==200||!String(response.headers['content-type']).startsWith('text/event-stream'))fail();
        const id=response.headers['x-request-id'];if(typeof id!=='string')fail();state.noteRequestId(index,id);
        const parser=createCliWorkflowSseObserver(event=>state.observeUpstreamEvent(index,event));
        res.writeHead(response.statusCode,response.headers);
        for await(const raw of response){const chunk=Buffer.from(raw);parser.push(chunk);if(!res.write(chunk))await waitDrain(res,signal);}
        parser.end();res.end();resolveForward();
      })().catch(reject);
    });
    upstream.once('error',reject);upstream.end(bytes);
  });
}

function waitDrain(response:ServerResponse,signal:AbortSignal):Promise<void>{
  return new Promise<void>((yes,no)=>{
    const cleanup=()=>{response.removeListener('drain',drain);response.removeListener('close',closed);signal.removeEventListener('abort',closed);};
    const drain=()=>{cleanup();yes();};const closed=()=>{cleanup();no(new Error('CLI observer stream interrupted; details redacted'));};
    response.once('drain',drain);response.once('close',closed);signal.addEventListener('abort',closed,{once:true});
    if(signal.aborted||response.destroyed)closed();
  });
}
