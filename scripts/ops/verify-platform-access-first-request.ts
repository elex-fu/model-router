import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SaasCatalogService } from '../../src/saas/catalog/service.js';
import { createSaasDatabase } from '../../src/saas/db/index.js';
import {
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  parseDeploymentConfig,
} from '../../src/saas/deployment.js';
import {
  canonicalContractAttestationPayload,
  type CustomerMeteringPolicyDefinition,
  type ProviderMeteringPolicyDefinition,
} from '../../src/saas/gateway/commercial-metering-policy-service.js';
import { SaasIdentityService } from '../../src/saas/identity/service.js';
import { SaasPricingService } from '../../src/saas/pricing/service.js';
import { createProviderCredentialSealingKms } from '../../src/saas/runtime/software-provider-credential-kms.js';
import { ProviderSupplyService } from '../../src/saas/supply/service.js';

import { PlatformAdminAuthService } from '../../src/saas/platform/auth/service.js';
import { totpCode } from '../../src/saas/platform/auth/totp.js';
import type { ProvisionPlatformInferenceAccessInput } from '../../src/saas/supply/platform-inference-access-provisioning.js';
import { assertDisposableRoleUrl, KIMI_COMMERCIAL_URLS, kimiCommercialCliEnvironment, KIMI_NATIVE_USAGE_DIMENSIONS,
  KIMI_COMMERCIAL_WINDOW_CAPACITY, startBuiltCli, waitCredentialVerified, waitGatewayReady, waitUntil,
  waitKimiSettled, kimiFinancialSnapshot, readKimiJsonResponse, postKimi,
  readDurableKimiRequest, classifyKimiSettlementObservation, assertKimiNativeUsageMatchesDurable, projectDurableKimiSettlement,
  type KimiCommercialFixture } from './verify-commercial-kimi.js';

export const PLATFORM_FIRST_REQUEST_REQUIRED = 'RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE';
export interface PlatformFirstRequestCliContext {
  readonly gatewayOrigin:string;
  readonly customerKey:string;
  readonly publicModel:string;
  readonly signal:AbortSignal;
  readonly tempDirectory:string;
  registerChild(child:ChildProcess):void;
}
export interface PlatformFirstRequestCliUsage {
  readonly input_tokens:number;
  readonly output_tokens:number;
  readonly cache_read_input_tokens:number;
  readonly cache_creation_input_tokens:number;
}
export interface PlatformFirstRequestCliRequest {
  readonly requestId:string;
  readonly usage:PlatformFirstRequestCliUsage;
}
export interface PlatformFirstRequestCliResult {
  readonly requests:readonly[PlatformFirstRequestCliRequest,PlatformFirstRequestCliRequest,PlatformFirstRequestCliRequest];
}
export interface PlatformFirstRequestOptions {
  readonly cliWorkflow?:{
    readonly kind:'claude-two-read-thinking-disabled'|'claude-two-read-thinking-omitted-observation';
    readonly run:(context:PlatformFirstRequestCliContext)=>Promise<PlatformFirstRequestCliResult>;
  };
}
const FUNDING = 1_000_000n;
const SUITE = 'platform-first-request-local-suite-v1';

/** Only explicit opt-in and runner-owned loopback role URLs; never discover credentials. */
export function requirePlatformFirstRequestEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  assert.equal(env[PLATFORM_FIRST_REQUEST_REQUIRED], '1', 'Explicit first-request live opt-in is required');
  assert.ok(env.KIMI_CODE_API_KEY, 'Ephemeral KIMI_CODE_API_KEY is required');
  let target:string|undefined;
  for (const [role, name] of Object.entries(KIMI_COMMERCIAL_URLS)) {
    const dbRole = {migrator:'migrator',controlPlane:'control_plane',gateway:'gateway',worker:'validation_worker'}[role];
    try {
      const url=new URL(assertDisposableRoleUrl(env[name], `model_router_saas_${dbRole}`));
      assert.ok(url.port && !['5432','6432','53782'].includes(url.port));
      assert.ok(!url.search&&!url.hash);
      const current=`${url.hostname}:${url.port}${url.pathname}`;
      assert.ok(target===undefined || target===current);target=current;
    } catch { throw new Error('All four role URLs must identify the same runner-owned disposable nondefault loopback PostgreSQL database'); }
  }
}

interface AcceptanceSignalTarget {
  on(signal:'SIGTERM'|'SIGINT', listener:()=>void):unknown;
  removeListener(signal:'SIGTERM'|'SIGINT', listener:()=>void):unknown;
}
/** One owner for signal abort, child shutdown and temporary material removal. */
export function createOwnedAcceptanceLifecycle(cleanup:()=>Promise<void>,
  target:AcceptanceSignalTarget=process,
  finishSignal:(signal:'SIGTERM'|'SIGINT')=>void=signal=>process.exit(signal==='SIGTERM'?143:130)) {
  const controller=new AbortController();
  let closing:Promise<void>|undefined;
  const remove=()=>{target.removeListener('SIGTERM',term);target.removeListener('SIGINT',interrupt);};
  const close=()=>{
    controller.abort();
    if(!closing) closing=Promise.resolve().then(cleanup).finally(remove);
    return closing;
  };
  let signaled=false;
  const signal=(value:'SIGTERM'|'SIGINT')=>{
    if(signaled)return;signaled=true;
    controller.abort();
    void close().then(()=>finishSignal(value),()=>finishSignal(value));
  };
  const term=()=>signal('SIGTERM'),interrupt=()=>signal('SIGINT');
  target.on('SIGTERM',term);target.on('SIGINT',interrupt);
  return {signal:controller.signal,close,assertRunning:()=>controller.signal.throwIfAborted()};
}

async function port(): Promise<number> {
  const server=createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const value=address.port; await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); return value;
}
async function stop(child:ChildProcess):Promise<void>{
  if(!child.pid || child.exitCode!==null || child.signalCode!==null)return;
  const closed=once(child,'close');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  timer.unref();try{await closed;}finally{clearTimeout(timer);}
}
async function ownedTcpConnected(value:number):Promise<boolean>{
  return new Promise(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port:value});
    let done=false;
    const finish=(connected:boolean)=>{if(done)return;done=true;socket.destroy();resolve(connected);};
    socket.setTimeout(500);
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
    socket.once('timeout',()=>finish(false));
  });
}
const SAFE_SPAWN_ERRORS=new Set(['ENOENT','EACCES','EMFILE','ENFILE','EAGAIN','ENOMEM']);
function ownedChildObservation(child:ChildProcess|undefined,spawnError:string|null){
  const signal=child?.signalCode;
  return {pidAllocated:typeof child?.pid==='number',exitCode:typeof child?.exitCode==='number'?child.exitCode:null,
    signalCode:signal===null||signal===undefined?null:['SIGTERM','SIGKILL','SIGINT'].includes(signal)?signal:'UNKNOWN',spawnErrorCode:spawnError};
}
class BrowserSession {
  private cookies=new Map<string,string>();
  constructor(readonly origin:string,readonly abortSignal:AbortSignal,readonly observeStatus?:(status:number,expectedStatus:number)=>void){}
  async request(path:string, method='GET', body?:unknown, expected=200):Promise<any>{
    const cookie=[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    const csrf=[...this.cookies].find(([k])=>/csrf/i.test(k))?.[1];
    const response=await fetch(this.origin+path,{method,headers:{origin:this.origin,cookie,
      ...(csrf?{'x-csrf-token':decodeURIComponent(csrf)}:{}),...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([this.abortSignal,AbortSignal.timeout(90000)])});
    this.observeStatus?.(response.status,expected);
    for(const value of response.headers.getSetCookie()){
      const pair=value.split(';',1)[0];const at=pair.indexOf('=');this.cookies.set(pair.slice(0,at),pair.slice(at+1));
    }
    // Never put response bodies, cookies, codes, passwords or provider secrets in assertions/logs.
    if(response.status!==expected){await response.body?.cancel();throw new Error(`HTTP stage failed: ${method} ${path.replace(/[0-9a-f-]{36}/g,':id')} status=${response.status}`);}
    const result=await response.json() as {data?:unknown};return result.data;
  }
}

/** Read-only failure evidence for this fixture/key, never an outcome repair. */
async function readCliObservationFailure(fixture:KimiCommercialFixture,keyId:string){
  const id=(value:unknown)=>typeof value==='string'&&/^(?:(?:gateway|managed)_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)?value:null;
  const decimal=(value:unknown)=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,29})$/u.test(value)?value:null;
  const known=(value:unknown,allowed:readonly string[])=>typeof value==='string'&&allowed.includes(value)?value:null;
  if(!id(fixture.tenantId)||!id(fixture.projectId)||!id(keyId))throw new Error('Observation scope is unavailable');
  return fixture.database.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '2000ms'");
    // Existing read-only projections share this observer transaction. No
    // response, fake usage, or financial producer is manufactured here.
    const observer:KimiCommercialFixture={...fixture,database:{...fixture.database,
      query<Row>(sql:string,values?:readonly unknown[]){return tx.query<Row>(sql,values);}}};
    const scoped=await tx.query<Record<string,unknown>>(`SELECT id::text AS request_id,execution_state,reconciliation_state,financial_status
      FROM saas_requests WHERE tenant_id=$1 AND project_id=$2 AND proxy_key_id=$3 ORDER BY created_at,id LIMIT 4`,
      [fixture.tenantId,fixture.projectId,keyId]);
    const requests=[];
    for(const request of scoped.rows){
      const requestId=id(request.request_id);if(!requestId)throw new Error('Observation request identity is invalid');
      const durable=await readDurableKimiRequest(observer,requestId);
      const hold=await tx.query<Record<string,unknown>>(`SELECT state,amount_minor_units::text AS amount
        FROM saas_billing_reservations WHERE tenant_id=$1 AND request_id=$2
        AND idempotency_namespace='saas.billing.reservation' AND business_key=$3`,
        [fixture.tenantId,requestId,`saas-request-admission:${fixture.tenantId}:${requestId}`]);
      if(hold.rows.length>1)throw new Error('Observation hold identity is ambiguous');
      requests.push({requestId,
        executionState:known(request.execution_state,['pending','succeeded','failed','unknown']),
        reconciliationState:known(request.reconciliation_state,['none','pending','resolved']),
        financialStatus:known(request.financial_status,['not_applicable','pending','settled','released','reconciliation_pending']),
        settlement:projectDurableKimiSettlement(durable),
        hold:{found:hold.rows.length===1,state:known(hold.rows[0]?.state,['reserved','settled','released','reconciliation_pending']),amountMinorUnits:decimal(hold.rows[0]?.amount)}});
    }
    const snapshot=await kimiFinancialSnapshot(observer);
    const financial=Object.fromEntries(Object.entries(snapshot).map(([field,value])=>[field,decimal(value)]));
    return {available:true,requestScope:'fixture-tenant-project-explicit-key',financialScope:'fixture-tenant',
      observedCount:requests.length,truncated:scoped.rows.length===4,requests,financial};
  });
}

export async function verifyPlatformAccessFirstRequest(diagnostic:(value:unknown)=>void=()=>{},options:PlatformFirstRequestOptions={}):Promise<void>{
  if(options.cliWorkflow!==undefined){
    assert.ok(options.cliWorkflow.kind==='claude-two-read-thinking-disabled'||options.cliWorkflow.kind==='claude-two-read-thinking-omitted-observation','Unsupported first-request CLI workflow');
    assert.equal(typeof options.cliWorkflow.run,'function','CLI workflow callback is required');
  }
  requirePlatformFirstRequestEnvironment();
  const credential=process.env.KIMI_CODE_API_KEY!;
  const {postgresPreparedStatements,environment:baseEnvironment}=kimiCommercialCliEnvironment();
  const workerUrl=process.env[KIMI_COMMERCIAL_URLS.worker]!,gatewayUrl=process.env[KIMI_COMMERCIAL_URLS.gateway]!;
  const database=createSaasDatabase({connectionString:process.env[KIMI_COMMERCIAL_URLS.migrator]!,max:2,preparedStatements:postgresPreparedStatements});
  const controlPlaneDatabase=createSaasDatabase({connectionString:process.env[KIMI_COMMERCIAL_URLS.controlPlane]!,max:6,preparedStatements:postgresPreparedStatements});
  const started:ChildProcess[]=[];
  const runtimeParent=process.env.PLATFORM_FIRST_REQUEST_RUNTIME_PARENT??tmpdir();
  await mkdir(runtimeParent,{recursive:true,mode:0o700});
  const tempDirectory=await mkdtemp(join(runtimeParent,'model-router-platform-first-'));
  let stage='platform-foundation';
  const spawnErrors=new WeakMap<ChildProcess,string>();
  let ownedRedis:ChildProcess|undefined,ownedControlPlane:ChildProcess|undefined;
  const readiness={redisConnected:false,platformConnected:false,customerConnected:false};
  let observationFixture:KimiCommercialFixture|undefined,observationKeyId:string|undefined;
  let observationCallbackStarted=false;
  const childObservations=()=>({redis:ownedChildObservation(ownedRedis,ownedRedis?spawnErrors.get(ownedRedis)??null:null),
    controlPlane:ownedChildObservation(ownedControlPlane,ownedControlPlane?spawnErrors.get(ownedControlPlane)??null:null)});
  const assertOwnedRunning=(child:ChildProcess,role:'redis'|'controlPlane')=>{
    const error=spawnErrors.get(child);
    if(error)throw Object.assign(new Error('Owned acceptance child spawn failed'),{code:error});
    assert.ok(typeof child.pid==='number'&&child.exitCode===null&&child.signalCode===null,`${role} child must remain alive`);
  };
  const lifecycle=createOwnedAcceptanceLifecycle(async()=>{
    await Promise.allSettled(started.map(stop));
    await Promise.allSettled([database.close(),controlPlaneDatabase.close()]);
    await rm(tempDirectory,{recursive:true,force:true});
  });
  const close=lifecycle.close;
  const setStage=(value:string)=>{lifecycle.assertRunning();stage=value;diagnostic({stage,event:'entered',productionGo:false});};
  try{
    await database.verifySchema();
    const version=await database.query<{server_version_num:string}>('SHOW server_version_num');
    assert.ok(Number(version.rows[0]?.server_version_num)>=180000,'PG18+ required');
    const label=randomUUID().replaceAll('-','').slice(0,12);
    const publicModel=`platform-first-${label}`,publicModelId=`platform-first-model-${label}`;
    const poolId=`platform-first-pool-${label}`,accountId=`platform-first-account-${label}`,credentialId=`platform-first-credential-${label}`;
    const model='kimi-for-coding',endpoint='messages';
    const effectiveAt=new Date(Date.now()-60000).toISOString();
    // Bootstrap is the trusted management business operation, not a manufactured session.
    const identity=new SaasIdentityService(controlPlaneDatabase);
    const email=`platform-first-operator-${label}@example.test`,password=`${randomUUID()}-Operator!`;
    const bootstrap=await identity.issueBootstrapToken();
    const administrator=await identity.bootstrapPlatformAdmin({token:bootstrap.token,email,displayName:'Disposable first-request operator',password});
    const audit={actorUserId:administrator.id,requestId:randomUUID(),entryPoint:'disposable-platform-first-platform-foundation'};
    const catalog = new SaasCatalogService(database);
    await catalog.registerProviderProduct({ providerId: 'kimi', productId: 'kimi-code', displayName: 'Kimi for Coding local acceptance' });
    await catalog.registerPublicModelAlias({ publicModelId, alias: publicModel, displayName: 'Kimi live acceptance model', providerId: 'kimi', productId: 'kimi-code', model, endpointScope: [endpoint] });
    const capability = await catalog.registerProviderCapability({
      providerId: 'kimi', productId: 'kimi-code', model, endpoint, protocol: 'anthropic', supportLevel: 'supported',
      validationState: 'verified', evidenceVersion: 'kimi-commercial-live-contract-v1', discoverySource: 'manual',
      evidenceReference: `local-test-provider-contract-${label}`, evidenceSha256: 'a'.repeat(64),
    });
    const rights = await catalog.registerProviderRightsVersion({
      rightsId: `kimi-commercial-rights-${label}`, providerId: 'kimi', productId: 'kimi-code', credentialType: 'api-key',
      supplyMode: 'platform', region: 'local-test', purpose: 'inference', modelScope: [model], endpointScope: [endpoint],
      effectiveAt, approvalReference: `local-test-only-no-production-resale-claim-${label}`, status: 'active',
      evidenceReference: `local-test-rights-${label}`, evidenceSha256: 'b'.repeat(64), audit,
    });
    const kmsEnvironment = {
      ...baseEnvironment, MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: randomBytes(32).toString('hex'),
      MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'local-test-kms',
    };
    const sealingKms = await createProviderCredentialSealingKms({ env: kmsEnvironment });
    // Real onboarding/pool lifecycle uses the control-plane role. Migrator is
    // limited to disposable foundation/pricing/capacity/funding and observers.
    const supply = new ProviderSupplyService(controlPlaneDatabase, { deployment: 'kimi-commercial-local-test', environment: 'test', kmsKeyId: 'local-test-kms', sealingKms });
    const account = await supply.createPlatformProviderAccount({ id: accountId, displayName: 'Kimi local acceptance',
      providerId: 'kimi', productId: 'kimi-code', credentialType: 'api-key', region: 'local-test', purpose: 'inference',
      rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model, endpoint, version: capability.version }], audit });
    assert.equal(account.status, 'pending');
    const credentialBuffer = Buffer.from(credential, 'utf8');
    try {
      const imported = await supply.createPlatformProviderCredential({ accountId, id: credentialId, secret:credentialBuffer, audit });
      assert.equal(imported.credential.status, 'pending');
      assert.equal(imported.credential.validationState, 'unverified');
    } finally { credentialBuffer.fill(0); await sealingKms.close(); }
    const pool = await supply.createPlatformProviderPool({ id: poolId, displayName: 'Kimi local acceptance pool',
      providerId: 'kimi', productId: 'kimi-code', credentialType: 'api-key', region: 'local-test', purpose: 'inference',
      rightsId: rights.rightsId, rightsVersion: rights.version, capabilities: [{ model, endpoint, version: capability.version }],
      status: 'active', validationState: 'verified' });
    // Membership/grants are appended after the worker activates the account.
    const pricing=new SaasPricingService(database);
    const signing=generateKeyPairSync('ed25519'),verifierKeyId=`platform-first-key-${label}`;
    const protocol='anthropic' as const,commercialPolicyVersion=`platform-first-commercial-${label}`;
    const rate=(n:number)=>({numeratorMinorUnits:n,denominatorUnits:1});
    const rateFields=(input:number,output:number)=>({input:rate(input),cache_read:rate(input),cache_write:rate(input),cache_write_5m:rate(input),cache_write_1h:rate(input),output:rate(output)});
    const common={publicModelId,publicModelVersion:1,providerId:'kimi',productId:'kimi-code',protocol,endpoint,currency:'USD',commercialPolicyVersion,calculatorVersion:'local-test-calculator-v1',roundingVersion:'local-test-rounding-v1',roundingMode:'half_up' as const,roundingBoundary:'total' as const,effectiveAt};
    const price=await pricing.appendCustomerPriceVersion({...common,rates:rateFields(2,3),idempotencyKey:`price-${label}`});
    const cost=await pricing.appendSupplierCostVersion({...common,resolvedModel:model,rates:rateFields(1,1),idempotencyKey:`cost-${label}`});
    const customerDefinition:CustomerMeteringPolicyDefinition={publicModelId,publicModelVersion:'1',protocol,endpoint,supplyMode:'platform',targetMode:'platform_pool',customerPriceVersion:price.id,usageDimensions:KIMI_NATIVE_USAGE_DIMENSIONS,tokenSource:'upstream',roundingVersion:common.roundingVersion,roundingMode:'half_up',roundingBoundary:'total',commercialPolicyVersion};
    const providerDefinition:ProviderMeteringPolicyDefinition={
      publicModelId,publicModelVersion:'1',protocol,endpoint,supplyMode:'platform',targetMode:'platform_pool',
      usageDimensions:KIMI_NATIVE_USAGE_DIMENSIONS,tokenSource:'upstream',roundingVersion:common.roundingVersion,
      roundingMode:'half_up',roundingBoundary:'total',commercialPolicyVersion,
      providerId:'kimi',productId:'kimi-code',resolvedModel:model,supplierCostVersion:cost.id,
    };
    const privateKeyFile = join(tempDirectory, 'signing.pem');
    const publicKeyFile = join(tempDirectory, 'public.pem');
    const affinityKeyFile = join(tempDirectory, 'affinity.key');
    const idempotencyKeyFile = join(tempDirectory, 'idempotency.key');
    const configFile = join(tempDirectory, 'gateway.json');
    await writeFile(privateKeyFile, signing.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(publicKeyFile, signing.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
    await writeFile(affinityKeyFile, randomBytes(32), { mode: 0o600 });
    await writeFile(idempotencyKeyFile, randomBytes(32), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ apiVersion: 2, extensions: { providerBundles: [{ bundle: 'kimi', enabled: true }] },
      signing: { verifierKeyId, privateKeyFile, trustedPublicKeys: [{ keyId: verifierKeyId, publicKeyFile, status: 'active' }] },
      affinity: { activeKeyVersion: 'local-test-v1', keys: [{ version: 'local-test-v1', keyFile: affinityKeyFile }] },
      // A signed thinking-history envelope can exceed 13 KiB on turn two;
      // this is a real bounded history ceiling, not a reduced estimator.
      idempotencyKeyFile, limits: { timeoutMs: 60_000, maxConcurrency: 2, leaseTtlMs: 90_000, maxBodyBytes: 1024 * 1024,
        maxInputTokens: KIMI_COMMERCIAL_WINDOW_CAPACITY.maxInputTokens, maxOutputTokens: KIMI_COMMERCIAL_WINDOW_CAPACITY.maxOutputTokens } }), { mode: 0o600 });
    const kmsModule = resolve('dist/saas/runtime/software-provider-credential-kms.js');
    const gatewayPort = await port();
    const workerEnvironment = { ...kmsEnvironment, MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'credential-validation-worker',
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_MAX_ATTEMPTS:'1',
      MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: workerUrl,
      [MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: kmsModule };
    assert.equal(parseDeploymentConfig(workerEnvironment).mode, 'managed-saas', 'Worker CLI environment must satisfy the production deployment parser');
    const gatewayEnvironment = { ...kmsEnvironment, MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
      MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: gatewayUrl, MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: 'builtin',
      MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG: configFile, SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: kmsModule,
      MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1', MODEL_ROUTER_SAAS_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: `http://127.0.0.1:${gatewayPort}` };
    let tenantId='',projectId='',customerKey='';
    const fixture:KimiCommercialFixture={fixtureMode:'live-built-cli',postgresPreparedStatements,database,controlPlaneDatabase,
      get tenantId(){return tenantId},get projectId(){return projectId},get customerKey(){return customerKey},
      accountId,credentialId,publicModel,gatewayOrigin:`http://127.0.0.1:${gatewayPort}`,tempDirectory,
      prices:{anthropic:price.id,openai:price.id},supplierCosts:{anthropic:cost.id,openai:cost.id},
      workerEnvironment,gatewayEnvironment,started,close};
    observationFixture=fixture;
    // Isolated local pilot TOTP provider uses a key passed only in child environment.
    // No prebuilt MFA credential/session is inserted; enrollment and login are real.
    const totpKey=randomBytes(32),totpKeyId='first-request-local-totp';
    const totpModule=join(tempDirectory,'totp-provider.mjs');
    await writeFile(totpModule,`export async function createCredentialKeyProvider({env,purpose}){
      if(purpose!=='platform-totp')throw new Error('Invalid fixture purpose');
      const key=Buffer.from(env.PLATFORM_FIRST_TOTP_KEY,'hex');if(key.length!==32)throw new Error('Missing fixture key');
      return {getCurrentKey(){return {keyId:'first-request-local-totp',key:new Uint8Array(key)}},
        getKey(id){return id==='first-request-local-totp'?new Uint8Array(key):undefined},async checkReady(){},async close(){key.fill(0)}};
    }`,{mode:0o600});
    const enrollmentAuth=new PlatformAdminAuthService(controlPlaneDatabase,{
      getCurrentKey:()=>({keyId:totpKeyId,key:new Uint8Array(totpKey)}),
      getKey:id=>id===totpKeyId?new Uint8Array(totpKey):undefined,
    });
    const enrollment=await enrollmentAuth.issueMfaEnrollmentToken(email,{operatorId:'disposable-first-request-supervisor',reasonCode:'initial-enrollment',requestId:randomUUID()});
    const trustFile=join(tempDirectory,'commercial-public-trust.json');
    await writeFile(trustFile,JSON.stringify({version:1,keys:[{keyId:verifierKeyId,publicKeyPem:signing.publicKey.export({format:'pem',type:'spki'})}],testVectorDigests:[{suiteVersion:SUITE,sha256:'c'.repeat(64)}]}),{mode:0o600});
    const platformPort=await port(),customerPort=await port(),redisPort=await port();
    const platformOrigin=`http://127.0.0.1:${platformPort}`,customerOrigin=`http://127.0.0.1:${customerPort}`;
    const start=async(command:string,args:string[],env:NodeJS.ProcessEnv,role:'redis'|'controlPlane')=>{
      lifecycle.assertRunning();
      const child=spawn(command,args,{cwd:resolve('.'),env,stdio:'ignore'});started.push(child);
      if(role==='redis')ownedRedis=child;else ownedControlPlane=child;
      child.on('error',error=>{const code=(error as NodeJS.ErrnoException).code;spawnErrors.set(child,typeof code==='string'&&SAFE_SPAWN_ERRORS.has(code)?code:'UNKNOWN');});
      await new Promise<void>((resolveSpawn,reject)=>{
        const failed=()=>reject(Object.assign(new Error('Owned acceptance child spawn failed'),{code:spawnErrors.get(child)??'UNKNOWN'}));
        child.once('error',failed);
        child.once('spawn',()=>{child.removeListener('error',failed);resolveSpawn();});
      });
      return child;
    };
    setStage('owned-redis-spawn');
    const redis=await start(process.env.MODEL_ROUTER_TEST_REDIS_BIN??'redis-server',[
      '--bind','127.0.0.1','--port',String(redisPort),'--save','','--appendonly','yes','--appendfsync','everysec','--maxmemory-policy','noeviction','--dir',tempDirectory],{PATH:process.env.PATH},'redis');
    setStage('owned-redis-tcp');
    await waitUntil('owned Redis TCP listener',async()=>{
      lifecycle.assertRunning();assertOwnedRunning(redis,'redis');
      readiness.redisConnected=await ownedTcpConnected(redisPort);
      return readiness.redisConnected?true:undefined;
    });
    diagnostic({stage,event:'ready',readiness:{...readiness},children:childObservations(),productionGo:false});
    // The production Redis adapter's readiness below proves this listener is usable.
    const cpEnv:NodeJS.ProcessEnv={...kmsEnvironment,MODEL_ROUTER_SAAS_WORKLOAD_ROLE:'control-plane',
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL:process.env[KIMI_COMMERCIAL_URLS.controlPlane],
      MODEL_ROUTER_SAAS_KMS_PROVIDER:totpModule,PLATFORM_FIRST_TOTP_KEY:totpKey.toString('hex'),
      MODEL_ROUTER_SAAS_REDIS_PROVIDER:resolve('dist/saas/runtime/redis-rate-limit-provider.js'),MODEL_ROUTER_SAAS_REDIS_URL:`redis://127.0.0.1:${redisPort}`,
      MODEL_ROUTER_SAAS_PROVIDER_CREDENTIAL_KMS_KEY_ID:'local-test-kms',SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE:kmsModule,
      MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE:trustFile,
      MODEL_ROUTER_SAAS_PLATFORM_BIND_ADDRESS:'127.0.0.1',MODEL_ROUTER_SAAS_PLATFORM_PORT:String(platformPort),MODEL_ROUTER_SAAS_PLATFORM_ORIGIN:platformOrigin,
      MODEL_ROUTER_SAAS_CUSTOMER_BIND_ADDRESS:'127.0.0.1',MODEL_ROUTER_SAAS_CUSTOMER_PORT:String(customerPort),MODEL_ROUTER_SAAS_CUSTOMER_ORIGIN:customerOrigin,
      MODEL_ROUTER_SAAS_REGISTRATION_MODE:'open',MODEL_ROUTER_SAAS_REGISTRATION_EMAIL_VERIFICATION:'false',MODEL_ROUTER_SAAS_REGISTRATION_TURNSTILE_ENABLED:'false'};
    // Both platform secret envs are deliberately absent from gateway; no CP upstream decrypt permission.
    setStage('standard-control-plane-spawn');
    const cp=await start(process.execPath,[resolve('dist/cli/index.js'),'start','--role','control-plane'],cpEnv,'controlPlane');
    setStage('standard-control-plane-owned-listeners');
    await waitUntil('standard control-plane owned listeners',async()=>{
      lifecycle.assertRunning();assertOwnedRunning(cp,'controlPlane');assertOwnedRunning(redis,'redis');
      [readiness.platformConnected,readiness.customerConnected]=await Promise.all([ownedTcpConnected(platformPort),ownedTcpConnected(customerPort)]);
      assertOwnedRunning(cp,'controlPlane');assertOwnedRunning(redis,'redis');
      return readiness.platformConnected&&readiness.customerConnected?true:undefined;
    });
    // CP-only has no gateway /readyz route. Its standard assembly must bind
    // both owned listeners; the unchanged formal MFA/HTTP chain proves the
    // business surface next. TCP success alone is not product acceptance.
    diagnostic({stage,event:'ready',readiness:{...readiness},children:childObservations(),productionGo:false});
    setStage('formal-platform-mfa-and-login');
    const ops=new BrowserSession(platformOrigin,lifecycle.signal,(status,expectedStatus)=>diagnostic({stage,event:'http-response',surface:'platform',status,expectedStatus,productionGo:false})),customer=new BrowserSession(customerOrigin,lifecycle.signal,(status,expectedStatus)=>diagnostic({stage,event:'http-response',surface:'customer',status,expectedStatus,productionGo:false}));
    const setup=await ops.request('/admin/api/v1/auth/mfa/enrollment/start','POST',{token:enrollment.token,issuer:'Disposable first request'});
    const secret=new URL(setup.otpauthUri).searchParams.get('secret');assert.ok(secret,'MFA setup must provide an enrollment URI');
    await ops.request('/admin/api/v1/auth/mfa/enrollment/confirm','POST',{confirmationToken:setup.confirmationToken,code:totpCode(secret)});
    // Replay protection means login must use a fresh TOTP time step, not the confirmation code.
    const confirmationCode=totpCode(secret);
    await waitUntil('next TOTP step',async()=>totpCode(secret)!==confirmationCode?true:undefined,40000);
    await ops.request('/admin/api/v1/auth/session','POST',{email,password,code:totpCode(secret)});
    setStage('formal-register-and-personal-project');
    await customer.request('/console/api/v1/auth/register','POST',{email:`platform-first-customer-${label}@example.test`,password:`${randomUUID()}-Customer!`,displayName:'First request customer'},201);
    const tenants=await customer.request('/console/api/v1/tenants');assert.ok(Array.isArray(tenants)&&tenants.length===1,'Fresh registration must create exactly one personal tenant');
    tenantId=tenants[0].id;
    const projects=await customer.request(`/console/api/v1/tenants/${tenantId}/projects`);assert.ok(Array.isArray(projects)&&projects.length===1,'Fresh tenant must have a default project');projectId=projects[0].id;
    const empty=await database.query(`SELECT id FROM saas_project_entitlements WHERE tenant_id=$1`,[tenantId]);assert.equal(empty.rows.length,0,'No customer entitlement may be seeded');
    setStage('formal-marketing-funding');
    const codes=await ops.request('/admin/api/v1/marketing/redeem-codes','POST',{kind:'balance',count:1,amountMinorUnits:FUNDING.toString(),currency:'USD'},201);
    assert.ok(Array.isArray(codes.codes)&&codes.codes.length===1,'Expected one balance code');
    const redeemed=await customer.request(`/console/api/v1/tenants/${tenantId}/redeem`,'POST',{code:codes.codes[0]});assert.equal(redeemed.kind,'balance');
    assert.equal((await kimiFinancialSnapshot(fixture)).wallet,FUNDING.toString());
    setStage('automatic-worker-onboarding');
    const worker=startBuiltCli(fixture,'credential-validation-worker');
    await waitCredentialVerified(fixture,worker);
    const activated=await supply.getProviderAccount(accountId);
    await supply.addPlatformPoolMember({poolId,accountId,expectedAccountAuthzVersion:activated.authzVersion});
    setStage('formal-platform-access-provisioning');
    const tenantCapacity=await ops.request(`/admin/api/v1/capacity/tenants/${tenantId}`);
    const projectCapacity=await ops.request(`/admin/api/v1/capacity/tenants/${tenantId}/projects/${projectId}`);
    const providerPolicyId=`platform-first-provider-${label}`;
    const contract={contractDigest:'d'.repeat(64),suiteVersion:SUITE,testVectorDigest:'c'.repeat(64),providerPolicyId,providerPolicyVersion:'2',publicModelId,publicModelVersion:'1',protocol,endpoint,supplyMode:'platform' as const,targetMode:'platform_pool' as const,usageDimensions:customerDefinition.usageDimensions,tokenSource:customerDefinition.tokenSource,roundingVersion:customerDefinition.roundingVersion,roundingMode:customerDefinition.roundingMode,roundingBoundary:'total' as const};
    const limits={requestsPerMinute:120,tokensPerMinute:KIMI_COMMERCIAL_WINDOW_CAPACITY.tokensPerMinute,maxConcurrentRequests:2};
    const input:ProvisionPlatformInferenceAccessInput={operationKey:`platform-first-${label}`,tenantId,projectId,
      pool:{id:poolId,expectedAuthzVersion:String(pool.authzVersion),evidenceReference:`disposable-first-request-${label}`,evidenceSha256:'e'.repeat(64)},
      capacity:{tenantExpectedRevision:tenantCapacity.revision,projectExpectedRevision:projectCapacity.revision,tenantLimits:limits,projectLimits:limits},
      routes:[{routeId:`platform-first-route-${label}`,definition:{publicModelId,publicModelVersion:'1',protocol,supplyMode:'platform',targetMode:'platform_pool',upstreamId:poolId,endpoint},
        customerPolicy:{policyId:`platform-first-customer-${label}`,definition:customerDefinition},providerPolicy:{policyId:providerPolicyId,definition:providerDefinition},
        attestation:{...contract,id:`platform-first-attestation-${label}`,verifierKeyId,signatureBase64:sign(null,Buffer.from(canonicalContractAttestationPayload(contract)),signing.privateKey).toString('base64')}}]};
    const operation=await ops.request('/admin/api/v1/supply/platform-access/operations','POST',input,201);assert.equal(operation.phase,'completed');
    const persisted=await ops.request(`/admin/api/v1/supply/platform-access/operations/${operation.id}`);assert.equal(persisted.phase,'completed');
    setStage('explicit-customer-key-create');
    const key=await customer.request(`/console/api/v1/tenants/${tenantId}/projects/${projectId}/keys`,'POST',{name:'Explicit first request key',modelScopes:[publicModel],supplyMode:'platform'},201);
    assert.ok(typeof key.secret==='string'&&key.secret.length>0,'Explicit customer action must issue a key');customerKey=key.secret;
    observationKeyId=key.id;
    const keyCapacityPath=`/admin/api/v1/capacity/tenants/${tenantId}/projects/${projectId}/api-keys/${key.id}`;
    const keyCapacity=await ops.request(keyCapacityPath);
    await ops.request(keyCapacityPath,'PUT',{expectedRevision:keyCapacity.revision,limits,reason:'initial_provisioning'});
    const gateway=startBuiltCli(fixture,'gateway');await waitGatewayReady(fixture,gateway);
    setStage(options.cliWorkflow?.kind==='claude-two-read-thinking-omitted-observation'?'real-claude-cli-two-read-thinking-omitted-observation':options.cliWorkflow?'real-claude-cli-two-read-thinking-disabled':'real-builtin-first-short-generation');
    const before=await kimiFinancialSnapshot(fixture);
    assert.equal(before.requests,'0');assert.equal(before.attempts,'0');assert.equal(before.hold,'0');
    if(options.cliWorkflow){
      assert.equal(before.usage,'0');assert.equal(before.settlements,'0');assert.equal(before.wallet,FUNDING.toString());
      observationCallbackStarted=options.cliWorkflow.kind==='claude-two-read-thinking-omitted-observation';
      const result=await options.cliWorkflow.run(Object.freeze({
        gatewayOrigin:fixture.gatewayOrigin,customerKey,publicModel,signal:lifecycle.signal,tempDirectory,
        registerChild:(child:ChildProcess)=>{started.push(child);},
      }));
      lifecycle.assertRunning();
      assert.ok(Array.isArray(result.requests)&&result.requests.length===3,'CLI workflow must complete exactly three requests');
      const requestIds=result.requests.map(request=>request.requestId);
      assert.ok(requestIds.every(requestId=>typeof requestId==='string'&&/^(?:(?:gateway|managed)_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId)),'CLI requests require valid durable gateway IDs');
      assert.equal(new Set(requestIds).size,3,'CLI workflow must identify three distinct requests');
      const settledRequests=[];
      let totalCharge=0n;
      for(const request of result.requests){
        lifecycle.assertRunning();
        // This external CLI observed the actual native SSE counters. Supply
        // them directly to the same classifier instead of manufacturing a
        // Response to populate the default fetch path's private diagnostics.
        const settled=await waitUntil('CLI request durable usage settlement',async()=>{
          lifecycle.assertRunning();
          const row=await readDurableKimiRequest(fixture,request.requestId);
          return classifyKimiSettlementObservation(fixture,request.requestId,'anthropic',row,[{...request.usage}]);
        });
        assertKimiNativeUsageMatchesDurable(settled,[{...request.usage}]);
        assert.equal(settled.request_id,request.requestId);assert.equal(settled.held_leases,'0');
        totalCharge+=BigInt(settled.settlement_amount!);
        settledRequests.push({requestId:request.requestId,executionState:settled.execution_state,
          amountMinorUnits:settled.settlement_amount,inputTokens:settled.input_total,outputTokens:settled.output_total,heldLeases:settled.held_leases});
      }
      const after=await kimiFinancialSnapshot(fixture);
      assert.equal(after.wallet,(BigInt(before.wallet)-totalCharge).toString());
      assert.equal(after.hold,'0');assert.equal(after.requests,'3');assert.equal(after.attempts,'3');assert.equal(after.usage,'3');assert.equal(after.settlements,'3');
      assert.equal(BigInt(after.ledger_transactions),BigInt(before.ledger_transactions)+3n);
      assert.equal(BigInt(after.ledger_entries),BigInt(before.ledger_entries)+6n);
      diagnostic({scope:options.cliWorkflow.kind==='claude-two-read-thinking-omitted-observation'?'formal-http-new-customer-claude-cli-two-read-thinking-omitted-observation':'formal-http-new-customer-claude-cli-two-read-thinking-disabled',runtime:'current-dist-cli-builtin',
        kms:'pilot-only-software-kms',providerInferenceCallsExpected:4,operationId:operation.id,requests:settledRequests,
        totalAmountMinorUnits:totalCharge.toString(),walletMinorUnits:after.wallet,holdMinorUnits:after.hold,financialSnapshot:after,productionGo:false});
      return;
    }
    const response=await postKimi(fixture,'anthropic',{model:publicModel,max_tokens:32,thinking:{type:'disabled'},messages:[{role:'user',content:'Reply with the single word OK.'}]},`platform-first-${randomUUID()}`,AbortSignal.any([lifecycle.signal,AbortSignal.timeout(65000)]));
    const body=await readKimiJsonResponse(fixture,response);assert.ok(Array.isArray(body.content)&&body.content.length>0,'Real native response must contain content');
    const requestId=response.headers.get('x-request-id');assert.ok(requestId,'Expected durable request ID');
    const settled=await waitKimiSettled(fixture,requestId,'anthropic');
    const after=await kimiFinancialSnapshot(fixture);
    assert.equal(after.wallet,(FUNDING-BigInt(settled.settlement_amount!)).toString());
    assert.equal(after.hold,'0');assert.equal(after.requests,'1');assert.equal(after.attempts,'1');assert.equal(after.usage,'1');assert.equal(after.settlements,'1');assert.equal(settled.held_leases,'0');
    diagnostic({scope:'formal-http-new-customer-first-builtin-request',runtime:'current-dist-cli-builtin',kms:'pilot-only-software-kms',providerInferenceCallsExpected:2,
      operationId:operation.id,requestId,executionState:settled.execution_state,amountMinorUnits:settled.settlement_amount,inputTokens:settled.input_total,outputTokens:settled.output_total,
      walletMinorUnits:after.wallet,holdMinorUnits:after.hold,heldLeases:settled.held_leases,financialSnapshot:after,productionGo:false});
  }catch(error){
    const code=error && typeof error==='object' && 'code' in error && typeof error.code==='string' && /^(?:[0-9A-Z]{5}|ERR_ASSERTION|[A-Z_]{1,80})$/.test(error.code)?error.code:null;
    // The CLI workflow's retainCliWorkflowFailure replaces the original error
    // with a safe fixed-category projection message. Surface that projection
    // verbatim; it is the designed-safe diagnostic and carries no body bytes.
    const cliProjection=error instanceof Error && error.message.startsWith('CLI workflow rejected ')
      ?(()=>{try{return JSON.parse(error.message.slice('CLI workflow rejected '.length));}catch{return undefined;}})()
      :undefined;
    const failureDiagnostic={failedStage:stage,errorCode:code,...(cliProjection===undefined?{}:{cliWorkflow:cliProjection}),readiness:{...readiness},children:childObservations(),productionGo:false};
    if(observationCallbackStarted){
      try{diagnostic(failureDiagnostic);}catch{/* Preserve the failure and its scoped readback even if reporting fails. */}
    }else diagnostic(failureDiagnostic);
    if(observationCallbackStarted&&observationFixture&&observationKeyId){
      let durable:unknown;
      try{durable=await readCliObservationFailure(observationFixture,observationKeyId);}
      catch{durable={available:false,reason:'SCOPED_DURABLE_READBACK_UNAVAILABLE'};}
      // Observation does not release, refund, redispatch or relabel a committed
      // result as unknown. Missing amounts stay null rather than invented zero.
      try{diagnostic({scope:'claude-two-read-thinking-omitted-failure-observation',failedStage:stage,durable,productionGo:false});}
      catch{/* A diagnostic consumer cannot replace the original workflow failure. */}
    }
    // Safe fixed stage only: arbitrary HTTP responses, provider text and crypto material never escape.
    throw new Error(`Platform first-request acceptance failed at ${stage}`);
  }finally{await close();}
}
