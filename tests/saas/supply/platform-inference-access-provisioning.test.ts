import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  PlatformInferenceAccessError,
  PlatformInferenceAccessProvisioningService,
  type PlatformInferenceAccessDependencies,
  type ProvisionPlatformInferenceAccessInput,
} from '../../../src/saas/supply/platform-inference-access-provisioning.js';

const tenantId='00000000-0000-4000-8000-000000000001';
const projectId='00000000-0000-4000-8000-000000000002';
const actor={userId:'00000000-0000-4000-8000-000000000003',sessionId:'00000000-0000-4000-8000-000000000004',roles:['operations' as const]};
const context={actor,audit:{actorUserId:actor.userId,entryPoint:'platform_admin'}};
const input = (): ProvisionPlatformInferenceAccessInput => ({
  operationKey:'first-project',tenantId,projectId,
  pool:{id:'pool',expectedAuthzVersion:'1',evidenceReference:'private-evidence:1',evidenceSha256:'a'.repeat(64)},
  capacity:{tenantExpectedRevision:'1',projectExpectedRevision:'1',projectLimits:{requestsPerMinute:60,tokensPerMinute:6000,maxConcurrentRequests:2}},
  routes:[{
    routeId:'route',definition:{publicModelId:'model',publicModelVersion:'1',protocol:'openai',supplyMode:'platform',targetMode:'platform_pool',upstreamId:'pool',endpoint:'/v1/chat/completions'},
    customerPolicy:{policyId:'customer',definition:{} as never},
    providerPolicy:{policyId:'provider',definition:{} as never},
    attestation:{id:'attestation',providerPolicyId:'provider',providerPolicyVersion:'2',publicModelVersion:'1'} as never,
  }],
});
function validInput(): ProvisionPlatformInferenceAccessInput {
  const value=input();
  return {...value,routes:value.routes.map(route=>({...route,
    customerPolicy:{...route.customerPolicy,definition:{...route.customerPolicy.definition,publicModelVersion:'1'}},
    providerPolicy:{...route.providerPolicy,definition:{...route.providerPolicy.definition,publicModelVersion:'1'}},
  }))};
}

test('invalid tenant and ambiguous client-supplied fields fail before any database write',async()=>{
  let calls=0;
  const database={query:async()=>{calls++;throw new Error('unexpected query');},transaction:async()=>{calls++;throw new Error('unexpected transaction');}} as unknown as SaasDatabase;
  const service=new PlatformInferenceAccessProvisioningService(database,{} as PlatformInferenceAccessDependencies);
  await assert.rejects(service.provision({...validInput(),tenantId:'wrong'},context),e=>e instanceof PlatformInferenceAccessError && e.code==='INVALID_INPUT');
  await assert.rejects(service.provision({...validInput(),unexpected:'secret'} as ProvisionPlatformInferenceAccessInput,context),e=>e instanceof PlatformInferenceAccessError && e.code==='INVALID_INPUT');
  await assert.rejects(service.provision({...validInput(),admissionReadiness:{status:'ready',bounds:{}}} as ProvisionPlatformInferenceAccessInput,context),e=>e instanceof PlatformInferenceAccessError && e.code==='INVALID_INPUT');
  assert.equal(calls,0);
});

test('preparation inserts profile before disabled entitlement; dependency failure cannot activate access',async()=>{
  const statements:string[]=[];
  let operation:Record<string,unknown>|undefined;
  const query=async(sql:string,values:readonly unknown[]=[])=>{
    statements.push(sql);
    if(sql.includes('FROM saas_platform_sessions'))return {rows:[{id:actor.sessionId}],rowCount:1};
    if(sql.includes('SELECT p.id FROM saas_projects'))return {rows:[{id:projectId}],rowCount:1};
    if(sql.includes('SELECT m.alias'))return {rows:[{alias:'public-model'}],rowCount:1};
    if(sql.includes('INSERT INTO saas_platform_inference_access_operations')){
      operation={id:values[0],tenant_id:tenantId,project_id:projectId,operation_key:values[3],request_hash:values[4],request_payload:values[5],profile_id:values[6],entitlement_id:values[7],actor_user_id:actor.userId,phase:'assembling',receipts:{},last_error_code:null};
      return {rows:[operation],rowCount:1};
    }
    if(sql.includes('pg_try_advisory_xact_lock'))return {rows:[{locked:true}],rowCount:1};
    if(sql.includes('SET runner_id=$2'))return {rows:[{id:operation?.id}],rowCount:1};
    if(sql.includes('SELECT id FROM saas_platform_provider_pools'))return {rows:[{id:'pool'}],rowCount:1};
    return {rows:[],rowCount:0};
  };
  const database={query,transaction:async(work:(tx:{query:typeof query})=>Promise<unknown>)=>work({query})} as unknown as SaasDatabase;
  const dependencies={supply:{grantPlatformPoolToProfile:async()=>{throw new Error('injected grant failure');}}} as unknown as PlatformInferenceAccessDependencies;
  const service=new PlatformInferenceAccessProvisioningService(database,dependencies);
  await assert.rejects(service.provision(validInput(),context),e=>e instanceof PlatformInferenceAccessError && e.code==='DEPENDENCY_UNAVAILABLE');
  const profile=statements.findIndex(sql=>sql.includes('INSERT INTO saas_supply_profiles'));
  const entitlement=statements.findIndex(sql=>sql.includes('INSERT INTO saas_project_entitlements'));
  assert.ok(profile>=0 && entitlement>profile);
  assert.match(statements[entitlement],/'disabled'/);
  assert.match(statements[entitlement],/disabled_at/);
  assert.equal(statements.some(sql=>sql.includes("SET status='active'")),false);
  assert.ok(statements.some(sql=>sql.includes("SET phase='failed'")));
  assert.equal(statements.some(sql=>/INSERT INTO saas_api_keys|saas_ledger_transactions/.test(sql)),false);
});


test('nested policy and attestation cannot override trusted scope or audit',async()=>{
  let calls=0;
  const database={transaction:async()=>{calls++;throw new Error('unexpected transaction');}} as unknown as SaasDatabase;
  const service=new PlatformInferenceAccessProvisioningService(database,{} as PlatformInferenceAccessDependencies);
  for(const field of ['customerPolicy','providerPolicy','attestation'] as const){
    const value=validInput();
    const route=value.routes[0];
    const injected={...value,routes:[{...route,[field]:{...route[field],tenantId:'other-tenant',audit:{actorUserId:'forged'}}}]};
    await assert.rejects(service.provision(injected as ProvisionPlatformInferenceAccessInput,context),e=>e instanceof PlatformInferenceAccessError && e.code==='INVALID_INPUT');
  }
  assert.equal(calls,0);
});
