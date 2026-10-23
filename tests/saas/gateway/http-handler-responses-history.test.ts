import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createSaasGatewayHandler } from '../../../src/saas/gateway/http-handler.js';
import type { PreparedEvidenceDispatchResult } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { RequestPreparationInput, RequestPreparationPreparedResult, RequestPreparationResult } from '../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';
import { PersistentResponsesContinuationResolver } from '../../../src/saas/gateway/responses-continuation-resolver.js';
import { AesGcmResponsesHistoryCipher } from '../../../src/saas/gateway/responses-continuation-cipher.js';
import type { ResponsesContinuationHistoryPort, ResponsesHistoryRecord, ResponsesHistoryReference } from '../../../src/saas/gateway/responses-continuation-history.js';
import { codexContinuationMode } from '../../../src/saas/gateway/codex/continuation-metadata.js';
class FakeRequest extends EventEmitter {
  readonly socket = { remoteAddress: '127.0.0.1' };
  readonly complete = true;
  aborted = false;
  chunks: Uint8Array[];
  url: string;
  method: string;
  readonly headers: IncomingHttpHeaders;
  resumed = false;

  constructor(options: {
    readonly url?: string;
    readonly method?: string;
    readonly headers?: IncomingHttpHeaders;
    readonly body?: string | Uint8Array;
  }) {
    super();
    this.url = options.url ?? '/v1/chat/completions';
    this.method = options.method ?? 'POST';
    this.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer test-secret',
      ...(options.headers ?? {}),
    };
    const body = options.body ?? JSON.stringify({ model: 'public-model', input: 'hello' });
    this.chunks = [typeof body === 'string' ? new TextEncoder().encode(body) : body];
  }

  resume(): this {
    this.resumed = true;
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (const chunk of this.chunks) yield chunk;
  }
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeReturns = true;
  readonly writeHeadCalls: Array<{ status: number; headers: Record<string, unknown> }> = [];
  readonly setHeaders = new Map<string, unknown>();
  readonly writes: Uint8Array[] = [];
  endCount = 0;
  endBody: unknown;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.setHeaders.set(name.toLowerCase(), value);
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(new Uint8Array(chunk));
    return this.writeReturns;
  }

  end(body?: unknown): this {
    this.writableEnded = true;
    this.endCount += 1;
    this.endBody = body;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

function asRequest(request: FakeRequest): IncomingMessage {
  return request as unknown as IncomingMessage;
}

function asResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

function authenticatedApiKey(): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalUserId: 'user-1',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-1',
      createdByUserId: 'user-1',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'byok',
      name: 'test-key',
      prefix: 'mr_test',
      modelScopes: ['public-model'],
      status: 'active',
      createdAt: '2026-09-28T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalKind: 'member',
      principalId: 'user-1',
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'byok',
      modelScopes: ['public-model'],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
}

function prepared(payloadBytes = new TextEncoder().encode('server-prepared-payload')): RequestPreparationResult {
  return {
    outcome: 'prepared',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    payloadBytes,
    payloadSha256: 'a'.repeat(64),
    requestFingerprint: 'fingerprint-1',
    requestFingerprintVersion: 'v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    endpoint: '/provider/private',
    requestedModel: 'public-model',
    mappedModel: 'provider-model',
    resolvedModel: 'provider-model',
    modelResolution: {
      requestedModel: 'public-model',
      mappedModel: 'provider-model',
      resolvedModel: 'provider-model',
      mappingSource: 'alias',
      mappingVersion: 1,
    },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    caller: {} as never,
    entitlement: {} as never,
    authority: {} as never,
    admission: {} as never,
    normalSuccessSnapshot: {
      supplyMode: 'byok',
      providerProtocol: 'openai',
      customerPriceVersion: null,
      reservationId: null,
      priceSnapshotRef: null,
      currency: null,
      holdAmountMinorUnits: null,
      publicModelId: 'model-id-1',
      publicModelVersion: '1',
      providerId: 'provider-1',
      productId: 'product-1',
      endpoint: '/provider/private',
      usageEstimatorVersion: 'estimator-v1',
    },
    attempt: {} as never,
    evidenceInput: {} as never,
    canonicalEvidencePayload: '{}',
    canonicalEvidencePayloadSha256: 'b'.repeat(64),
    evidence: {
      evidenceId: 'evidence-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      attemptOrdinal: 1,
      supplyMode: 'byok',
      publicModel: 'public-model',
      protocol: 'openai',
      endpoint: '/provider/private',
      upstreamId: 'upstream-1',
      accountId: 'account-1',
      credentialId: 'credential-1',
      credentialVersion: '1',
      routeTargetMode: 'tenant_account',
      payloadSha256: 'a'.repeat(64),
      statementSha256: 'c'.repeat(64),
      status: 'registered',
      claimedAt: null,
      claimedAttemptId: null,
      expiresAt: '2026-09-28T00:10:00.000Z',
    },
  };
}


/** Explicit fake durable port shared across independent HTTP handler instances. */
class TestHistory implements ResponsesContinuationHistoryPort {
  readonly records = new Map<string,ResponsesHistoryRecord>();
  failWrites = false;
  beforeInsert?: () => void;
  private key(r: ResponsesHistoryReference): string { return JSON.stringify([r.tenantId,r.projectId,r.proxyKeyId,r.conversationId,r.responseId]); }
  async find(r: ResponsesHistoryReference,now: number): Promise<ResponsesHistoryRecord|null> { const saved=this.records.get(this.key(r)); return saved && saved.expiresAtMs>now ? saved : null; }
  async insert(record: ResponsesHistoryRecord): Promise<'inserted'> { this.beforeInsert?.(); if (this.failWrites) throw new Error('storage unavailable'); this.records.set(this.key(record),record); return 'inserted'; }
  async delete(r: ResponsesHistoryReference): Promise<void> { this.records.delete(this.key(r)); }
  async purgeExpired(): Promise<number> { return 0; }
}
function resolver(history: TestHistory): PersistentResponsesContinuationResolver { return new PersistentResponsesContinuationResolver({history,cipher:new AesGcmResponsesHistoryCipher('history-test',new Map([['history-test',new Uint8Array(32).fill(7)]])),maxBytes:1024*1024,ttlMs:60000}); }
function fixturePrepared(caller: AuthenticatedApiKey, accountId = 'account-1'): RequestPreparationPreparedResult {
  const value=prepared(); assert.equal(value.outcome,'prepared'); if (value.outcome!=='prepared') throw new Error('fixture');
  return {...value,clientProtocol:'responses',clientOperation:'responses',evidenceInput:{...value.evidenceInput,tenantId:caller.metadata.tenantId,projectId:caller.metadata.projectId,proxyKeyId:caller.metadata.id,providerId:'openai-codex',productId:'codex',accountId,credentialId:'credential-1',credentialVersion:'1',credentialAuthzVersion:'1',publicModel:'public-model',resolvedModel:'provider-model'}};
}
function harness(history: TestHistory, options: {caller?:AuthenticatedApiKey;accountId?:string;status?:'settled'|'replayed'|'reconciliation_pending';response?:Record<string,unknown>;stream?:boolean;beforeReturn?:(response:FakeResponse)=>void} = {}) {
  const caller=options.caller ?? authenticatedApiKey(), preparationInputs:RequestPreparationInput[]=[]; let dispatchCount=0,compensationCount=0;
  const response=new FakeResponse();
  const handler=createSaasGatewayHandler({
    authenticator:{async authenticate(){return caller;}},
    continuationHistoryResolver:resolver(history), responsesCompactNativeSupply:()=>true,
    preparation:{async prepare(input){preparationInputs.push(input); return fixturePrepared(caller,options.accountId);}},
    preDispatchCompensation:{async compensate(){compensationCount++; return {} as never;}},
    dispatch:{async dispatch(input){
      dispatchCount++;
      const body=options.response ?? {id:'resp-1',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]}]};
      await input.client?.start(200,{'content-type':options.stream ? 'text/event-stream':'application/json'});
      const text=options.stream ? `data: ${JSON.stringify({type:'response.output_text.delta',delta:'hi'})}\r\n\r\ndata: ${JSON.stringify({type:'response.completed',response:body})}\r\n\r\ndata: [DONE]\r\n\r\n` : JSON.stringify(body);
      const bytes=new TextEncoder().encode(text);
      if(options.stream) for(const byte of bytes) await input.client?.write(new Uint8Array([byte])); else await input.client?.write(bytes);
      await input.client?.end();
      options.beforeReturn?.(response);
      return {kind:'sent',settlementOutcome:options.status ?? 'settled',transport:{resultHttpStatus:200}} as PreparedEvidenceDispatchResult;
    }},
  });
  return {response,preparationInputs,get dispatchCount(){return dispatchCount;},get compensationCount(){return compensationCount;},async run(body:Record<string,unknown>,headers:IncomingHttpHeaders={},path='/v1/responses'){
    const req=new FakeRequest({url:path,body:JSON.stringify(body),headers});
    await handler(asRequest(req),asResponse(response),{requestId:'request-1'}); return response;
  }};
}
function output(response:FakeResponse): string { return Buffer.concat(response.writes).toString('utf8'); }
test('HTTP history persists before JSON publication and restores canonical replay across independent requests',async()=>{
  const storage=new TestHistory(); const first=harness(storage,{beforeReturn:res=>{assert.equal(res.writableEnded,false);assert.equal(output(res),'');}});
  storage.beforeInsert=()=>{assert.equal(first.response.writableEnded,false);assert.equal(output(first.response),'');};
  await first.run({model:'public-model',input:'hello'},{conversation_id:'conversation-1'});
  assert.equal(first.response.writableEnded,true); assert.equal(storage.records.size,1); assert.match(output(first.response),/answer/);
  storage.beforeInsert=undefined;
  const second=harness(storage,{response:{id:'resp-2',status:'completed',output:[]}});
  await second.run({previous_response_id:'resp-1',input:[{role:'user',content:'next'}]},{conversation_id:'conversation-1'});
  const body=second.preparationInputs[0].clientRequest as Record<string,unknown>;
  assert.equal(codexContinuationMode(body),'canonical-replay');assert.equal(body.previous_response_id,undefined);assert.equal((body.input as unknown[]).length,3);assert.equal(second.dispatchCount,1);
});
test('HTTP history full scope blocks project/key/tenant/conversation substitution before preparation',async()=>{
  const storage=new TestHistory();await harness(storage).run({model:'public-model',input:'hello',conversation_id:'c'});
  for(const field of ['tenantId','projectId','id'] as const){const caller=authenticatedApiKey();const changed={...caller,metadata:{...caller.metadata,[field]:'different'}};const h=harness(storage,{caller:changed});await h.run({model:'public-model',previous_response_id:'resp-1',input:'next',conversation_id:'c'});assert.equal(h.response.writeHeadCalls[0]?.status,409);assert.equal(h.preparationInputs.length,0);}
  const wrongConversation=harness(storage);await wrongConversation.run({model:'public-model',previous_response_id:'resp-1',input:'next',conversation_id:'different'});assert.equal(wrongConversation.response.writeHeadCalls[0]?.status,409);
});
test('HTTP prepared identity mismatch compensates once before 409 and never dispatches',async()=>{
  const storage=new TestHistory();await harness(storage).run({model:'public-model',input:'hello',conversation_id:'c'});
  const h=harness(storage,{accountId:'changed-account'});await h.run({previous_response_id:'resp-1',input:'next',conversation_id:'c'});assert.equal(h.compensationCount,1);assert.equal(h.dispatchCount,0);assert.equal(h.response.writeHeadCalls[0]?.status,409);assert.equal(storage.records.size,1);
});
test('HTTP SSE forwards nonterminal bytes but publishes terminal only after durable history write',async()=>{
  const storage=new TestHistory();const h=harness(storage,{stream:true,beforeReturn:res=>{assert.match(output(res),/response.output_text.delta/);assert.doesNotMatch(output(res),/response.completed/);assert.equal(res.writableEnded,false);}});
  storage.beforeInsert=()=>{assert.doesNotMatch(output(h.response),/response.completed/);assert.equal(h.response.writableEnded,false);};
  await h.run({model:'public-model',input:'hello',stream:true,conversation_id:'c'});assert.match(output(h.response),/response.completed/);assert.equal(h.response.writableEnded,true);assert.equal(storage.records.size,1);
});
test('HTTP compact saves the entire returned window and replaces old canonical input',async()=>{
  const storage=new TestHistory();const window=[{type:'message',role:'user',content:'kept user'},{type:'compaction',encrypted_content:'opaque summary'},{type:'message',role:'assistant',content:[{type:'output_text',text:'kept assistant'}]}];
  const compact=harness(storage,{response:{id:'compact-1',object:'response.compaction',output:window}});await compact.run({model:'public-model',input:'old long context',conversation_id:'c'},{},'/v1/responses/compact');assert.equal(storage.records.size,1);
  const next=harness(storage);await next.run({previous_response_id:'compact-1',input:'next',conversation_id:'c'});const body=next.preparationInputs[0].clientRequest as Record<string,unknown>;assert.deepEqual((body.input as unknown[]).slice(0,3),window);assert.equal((body.input as unknown[]).length,4);assert.equal(JSON.stringify(body).includes('old long context'),false);
});
test('HTTP reconciliation/replayed never create history and storage failure never retries or compensates inference',async()=>{
  for(const status of ['replayed','reconciliation_pending'] as const){const storage=new TestHistory();const h=harness(storage,{status});await h.run({model:'public-model',input:'hello',conversation_id:'c'});assert.equal(storage.records.size,0);assert.equal(h.response.writableEnded,true);assert.equal(h.dispatchCount,1);assert.equal(h.compensationCount,0);}
  const storage=new TestHistory();storage.failWrites=true;const h=harness(storage);await h.run({model:'public-model',input:'hello',conversation_id:'c'});assert.equal(h.response.writableEnded,true);assert.equal(h.dispatchCount,1);assert.equal(h.compensationCount,0);
  const next=harness(storage);await next.run({previous_response_id:'resp-1',input:'next',conversation_id:'c'});assert.equal(next.response.writeHeadCalls[0]?.status,409);assert.equal(next.dispatchCount,0);
});
test('HTTP missing or conflicting conversation prevents reference resolution; full context without scope remains executable',async()=>{
  const storage=new TestHistory();const noScope=harness(storage);await noScope.run({model:'public-model',input:'full'});assert.equal(noScope.dispatchCount,1);assert.equal(storage.records.size,0);
  const missing=harness(storage);await missing.run({model:'public-model',previous_response_id:'resp-1',input:'next'});assert.equal(missing.response.writeHeadCalls[0]?.status,409);assert.equal(missing.preparationInputs.length,0);
  const conflict=harness(storage);await conflict.run({model:'public-model',input:'full',conversation_id:'a'},{conversation_id:'b'});assert.equal(conflict.response.writeHeadCalls[0]?.status,409);assert.equal(conflict.preparationInputs.length,0);
});

test('HTTP detects actual Codex SSE when client stream is omitted or false',async()=>{
  for(const requestedStream of [undefined,false]){
    const storage=new TestHistory();const h=harness(storage,{stream:true,beforeReturn:res=>{assert.match(output(res),/response.output_text.delta/);assert.doesNotMatch(output(res),/response.completed/);assert.equal(res.writableEnded,false);}});
    storage.beforeInsert=()=>assert.doesNotMatch(output(h.response),/response.completed/);
    await h.run({model:'public-model',input:'hello',conversation_id:'c',...(requestedStream===undefined ? {} : {stream:requestedStream})});
    assert.equal(storage.records.size,1);assert.match(output(h.response),/response.completed/);assert.equal(h.response.writableEnded,true);
  }
});
test('HTTP delayed finish failure aborts downstream without compensating settled inference',async()=>{
  const storage=new TestHistory();const h=harness(storage);
  h.response.write=()=>{throw new Error('client write failed');};
  await h.run({model:'public-model',input:'hello',conversation_id:'c'});
  assert.equal(storage.records.size,1);assert.equal(h.response.destroyed,true);assert.equal(h.dispatchCount,1);assert.equal(h.compensationCount,0);
});

test('HTTP delayed header failure also closes an unstarted client after settlement',async()=>{
  const storage=new TestHistory();const h=harness(storage);
  h.response.writeHead=()=>{throw new Error('client header failure');};
  await h.run({model:'public-model',input:'hello',conversation_id:'c'});
  assert.equal(storage.records.size,1);assert.equal(h.response.destroyed,true);assert.equal(h.dispatchCount,1);assert.equal(h.compensationCount,0);
});
