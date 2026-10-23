import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/runtime-privileges.js';
import { createBuiltinPlatformInferenceAccessAdmissionReadiness } from '../../../src/saas/supply/platform-inference-access-admission-readiness.js';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import { PlatformCapacityPolicyService } from '../../../src/saas/platform/capacity-policy-service.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import { canonicalContractAttestationPayload, SaasCommercialMeteringPolicyService, type CustomerMeteringPolicyDefinition, type ProviderMeteringPolicyDefinition, type ContractAttestationPayload } from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { PlatformInferenceAccessProvisioningService, PlatformInferenceAccessError, type ProvisionPlatformInferenceAccessInput } from '../../../src/saas/supply/platform-inference-access-provisioning.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls, seedFixture } from '../metering/normal-success-postgres-fixture.js';

function safeErrorChain(error:unknown):string {
  const chain:unknown[]=[];
  let current=error;
  for(let depth=0;depth<5 && current && typeof current==='object';depth++){
    const e=current as {name?:unknown;code?:unknown;message?:unknown;table?:unknown;column?:unknown;constraint?:unknown;cause?:unknown};
    chain.push({name:e.name,code:e.code,message:e.message,table:e.table,column:e.column,constraint:e.constraint});
    current=e.cause;
  }
  return JSON.stringify(chain);
}

// All endpoints are disposable local PG/CI role URLs checked by the existing fixture helper.
// Provider/catalog/price material is synthetic; the NEW tenant/profile/entitlement are created only by business services.
test('real PG restricted control-plane provisions a fresh suspended project, resumes a committed stage and revokes only its entitlement',{
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? `set ${REQUIRED_FLAG}=1 and all three disposable role URLs` : false,
  timeout:300_000,
},async t=>{
  const urls=roleUrls();
  const migrator=createSaasDatabase({connectionString:urls[0],max:4});
  const cp=createSaasDatabase({connectionString:urls[1],max:6});
  const gateway=createSaasDatabase({connectionString:urls[2],max:4});
  t.after(async()=>{await Promise.allSettled([migrator.close(),cp.close(),gateway.close()]);});
  await cp.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(cp,'control_plane');
  const source=await seedFixture(migrator,gateway,'platform');
  const actor={userId:source.userId,sessionId:randomUUID(),roles:['operations' as const]};
  const credentialId=randomUUID();
  // Operator identity is a fixture prerequisite, not an API-granted user privilege.
  await migrator.transaction(async tx=>{
    await tx.query(`INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,'operations') ON CONFLICT DO NOTHING`,[actor.userId]);
    await tx.query(`INSERT INTO saas_mfa_credentials(id,user_id,kind,encrypted_secret,verified_at) VALUES($1,$2,'totp',decode('7b7d','hex'),clock_timestamp())`,[credentialId,actor.userId]);
    await tx.query(`INSERT INTO saas_platform_sessions(id,user_id,credential_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,[actor.sessionId,actor.userId,credentialId,createHash('sha256').update(randomUUID()).digest('hex'),'c'.repeat(64)]);
  });
  const tenant=await new SaasIdentityService(cp).createTenant(actor.userId,{name:`P01 ${randomUUID()}`});
  const tenantId=tenant.id,projectId=tenant.defaultProjectId;
  const before=await cp.query<{inference_policy_status:string}>(`SELECT inference_policy_status FROM saas_projects WHERE tenant_id=$1 AND id=$2`,[tenantId,projectId]);
  assert.equal(before.rows[0].inference_policy_status,'suspended');
  const empty=await cp.query(`SELECT id FROM saas_project_entitlements WHERE tenant_id=$1 AND project_id=$2`,[tenantId,projectId]);
  assert.equal(empty.rows.length,0);
  type Row=Record<string,any>;
  const sourceRoute=(await migrator.query<Row>(`SELECT rv.* FROM saas_route_config_heads h JOIN saas_route_config_versions rv ON rv.tenant_id=h.tenant_id AND rv.project_id=h.project_id AND rv.route_id=h.route_id AND rv.version=h.current_version WHERE h.tenant_id=$1 AND h.project_id=$2`,[source.tenantId,source.projectId])).rows[0];
  const sourceAuthority=(await migrator.query<Row>(`SELECT * FROM saas_route_config_commercial_authorities WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 AND route_version=$4`,[source.tenantId,source.projectId,sourceRoute.route_id,sourceRoute.version])).rows[0];
  const customer=(await migrator.query<Row>(`SELECT * FROM saas_customer_metering_policy_versions WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$3 AND version=$4`,[source.tenantId,source.projectId,sourceAuthority.customer_policy_id,sourceAuthority.customer_policy_version])).rows[0];
  const provider=(await migrator.query<Row>(`SELECT * FROM saas_provider_metering_policy_versions WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$3 AND version=$4`,[source.tenantId,source.projectId,sourceAuthority.provider_policy_id,sourceAuthority.provider_policy_version])).rows[0];
  const base={publicModelId:customer.public_model_id,publicModelVersion:String(customer.public_model_version),protocol:customer.protocol,endpoint:customer.endpoint,supplyMode:'platform' as const,targetMode:'platform_pool' as const,usageDimensions:customer.usage_dimensions,tokenSource:customer.token_source,roundingVersion:customer.rounding_version,roundingMode:customer.rounding_mode,roundingBoundary:'total' as const,commercialPolicyVersion:customer.commercial_policy_version};
  const customerDefinition:CustomerMeteringPolicyDefinition={...base,customerPriceVersion:customer.customer_price_version};
  const providerDefinition:ProviderMeteringPolicyDefinition={...base,providerId:provider.provider_id,productId:provider.product_id,resolvedModel:provider.resolved_model,supplierCostVersion:provider.supplier_cost_version};
  const keyPair=generateKeyPairSync('ed25519');
  const providerPolicyId=`p01-provider-${randomUUID()}`;
  const payload:ContractAttestationPayload={publicModelId:base.publicModelId,publicModelVersion:base.publicModelVersion,protocol:base.protocol,endpoint:base.endpoint,supplyMode:base.supplyMode,targetMode:base.targetMode,usageDimensions:base.usageDimensions,tokenSource:base.tokenSource,roundingVersion:base.roundingVersion,roundingMode:base.roundingMode,roundingBoundary:base.roundingBoundary,providerPolicyId,providerPolicyVersion:'2',contractDigest:'a'.repeat(64),suiteVersion:'p01-synthetic-suite',testVectorDigest:'b'.repeat(64)};
  const attestation={...payload,id:`p01-attestation-${randomUUID()}`,verifierKeyId:'p01-synthetic-key',signatureBase64:sign(null,Buffer.from(canonicalContractAttestationPayload(payload)),keyPair.privateKey).toString('base64')};
  const capacity=new PlatformCapacityPolicyService(cp);
  const tenantPolicy=await capacity.getTenantPolicy({tenantId,actor});
  const projectPolicy=await capacity.getProjectPolicy({tenantId,projectId,actor});
  assert.ok(tenantPolicy && projectPolicy);
  const pool=(await cp.query<Row>(`SELECT id,authz_version FROM saas_platform_provider_pools WHERE id=$1`,[source.sent.poolId])).rows[0];
  const limits={requestsPerMinute:120,tokensPerMinute:120000,maxConcurrentRequests:4};
  const input:ProvisionPlatformInferenceAccessInput={operationKey:`p01-${randomUUID()}`,tenantId,projectId,pool:{id:pool.id,expectedAuthzVersion:String(pool.authz_version),evidenceReference:'fixture:p01',evidenceSha256:'d'.repeat(64)},capacity:{tenantExpectedRevision:tenantPolicy.revision,projectExpectedRevision:projectPolicy.revision,tenantLimits:limits,projectLimits:limits},routes:[{routeId:`p01-route-${randomUUID()}`,definition:{publicModelId:base.publicModelId,publicModelVersion:base.publicModelVersion,protocol:base.protocol,supplyMode:'platform',targetMode:'platform_pool',upstreamId:pool.id,endpoint:base.endpoint},customerPolicy:{policyId:`p01-customer-${randomUUID()}`,definition:customerDefinition},providerPolicy:{policyId:providerPolicyId,definition:providerDefinition},attestation}]};
  const deps={admissionReadiness:createBuiltinPlatformInferenceAccessAdmissionReadiness(),supply:new ProviderSupplyService(cp,{deployment:'p01-fixture',environment:'test',kmsKeyId:'fixture-unused'}),routes:new SaasRouteConfigService(cp),commercial:new SaasCommercialMeteringPolicyService(cp,{trustedVerifierPublicKeys:new Map([['p01-synthetic-key',keyPair.publicKey]]),trustedTestVectorDigests:new Map([['p01-synthetic-suite','b'.repeat(64)]])}),capacity};
  let inject=true;
  const interrupted:SaasDatabase={...cp,query:async(sql,values)=>{
    if(inject && sql.includes('receipts=receipts||')){inject=false;throw new Error('injected journal outage after committed grant');}
    return cp.query(sql,values);
  }};
  const context={actor,audit:{actorUserId:actor.userId,entryPoint:'p01-postgres-fixture',requestId:randomUUID()}};
  await assert.rejects(new PlatformInferenceAccessProvisioningService(interrupted,deps).provision(input,context),e=>{
    const unexpected=e as {name?:unknown;code?:unknown;message?:unknown;table?:unknown;column?:unknown;constraint?:unknown;cause?:{name?:unknown;code?:unknown;message?:unknown;table?:unknown;column?:unknown}};
    const diagnostic={name:unexpected?.name,code:unexpected?.code,message:unexpected?.message,table:unexpected?.table,column:unexpected?.column,constraint:unexpected?.constraint,causeCode:unexpected?.cause?.code,causeName:unexpected?.cause?.name,causeMessage:unexpected?.cause?.message,causeTable:unexpected?.cause?.table,causeColumn:unexpected?.cause?.column,
      permissionMessage:unexpected?.code==='42501'?unexpected.message:unexpected?.cause?.code==='42501'?unexpected.cause.message:undefined};
    assert.ok(e instanceof PlatformInferenceAccessError,`unexpected pre-journal error: ${JSON.stringify(diagnostic)}`);
    assert.equal(e.code,'DEPENDENCY_UNAVAILABLE','expected injected post-grant journal failure, not input/auth precondition');
    assert.equal(inject,false,'journal fault must actually have been reached');
    return true;
  });
  const prepared=(await cp.query<Row>(`SELECT o.id,o.profile_id,o.entitlement_id,o.phase,e.status,e.authz_version FROM saas_platform_inference_access_operations o JOIN saas_project_entitlements e ON e.id=o.entitlement_id WHERE o.tenant_id=$1 AND o.project_id=$2`,[tenantId,projectId])).rows[0];
  assert.ok(prepared,'expected persisted operation after reached journal injection');
  assert.equal(prepared.phase,'failed');assert.equal(prepared.status,'disabled');assert.equal(String(prepared.authz_version),'1');
  const grant=await cp.query(`SELECT pool_id FROM saas_platform_provider_pool_grants WHERE tenant_id=$1 AND supply_profile_id=$2`,[tenantId,prepared.profile_id]);
  assert.equal(grant.rows.length,1,'committed child stage survives journal outage');
  // A server-owned readiness change after assembly must block activation and
  // persist a specific failure, even though all database supply references exist.
  let readinessChecks=0;
  const revokedReadiness={check:()=>++readinessChecks===2
    ? {status:'blocked' as const,code:'TRUSTED_USAGE_BOUNDS_UNAVAILABLE' as const}
    : {status:'ready' as const}};
  await assert.rejects(new PlatformInferenceAccessProvisioningService(cp,{...deps,admissionReadiness:revokedReadiness}).provision(input,context),e=>e instanceof PlatformInferenceAccessError && e.code==='TRUSTED_USAGE_BOUNDS_UNAVAILABLE');
  assert.equal(readinessChecks,2,'existing journal must recheck at final activation');
  const admissionBlocked=(await cp.query<Row>(`SELECT o.phase,o.last_error_code,e.status FROM saas_platform_inference_access_operations o JOIN saas_project_entitlements e ON e.id=o.entitlement_id WHERE o.id=$1`,[prepared.id])).rows[0];
  assert.equal(admissionBlocked.phase,'failed');assert.equal(admissionBlocked.last_error_code,'TRUSTED_USAGE_BOUNDS_UNAVAILABLE');assert.equal(admissionBlocked.status,'disabled');
  let failActivation=true;
  const activationFault:SaasDatabase={...cp,transaction:work=>cp.transaction(tx=>work({...tx,query:async(sql,values)=>{
    if(failActivation && sql.includes('INSERT INTO saas_audit_events') && values?.includes('platform_inference_access.activated')){failActivation=false;throw new Error('injected final audit outage');}
    return tx.query(sql,values);
  }}))};
  await assert.rejects(new PlatformInferenceAccessProvisioningService(activationFault,deps).provision(input,context),e=>{
    assert.ok(e instanceof PlatformInferenceAccessError,safeErrorChain(e));
    assert.equal(e.code,'DEPENDENCY_UNAVAILABLE',safeErrorChain(e));
    assert.equal(failActivation,false,`expected to reach final audit injection; ${safeErrorChain(e)}`);
    return true;
  });
  const rolledBack=(await cp.query<Row>(`SELECT e.status,p.inference_policy_status,o.phase FROM saas_platform_inference_access_operations o JOIN saas_project_entitlements e ON e.id=o.entitlement_id JOIN saas_projects p ON p.tenant_id=o.tenant_id AND p.id=o.project_id WHERE o.id=$1`,[prepared.id])).rows[0];
  assert.equal(rolledBack.status,'disabled');assert.equal(rolledBack.inference_policy_status,'suspended');assert.equal(rolledBack.phase,'failed');
  const service=new PlatformInferenceAccessProvisioningService(cp,deps);
  let completed: Awaited<ReturnType<typeof service.provision>>;
  try { completed=await service.provision(input,context); } catch(error) { assert.fail(`clean retry failed: ${safeErrorChain(error)}`); }
  assert.equal(completed.id,prepared.id);assert.equal(completed.phase,'completed');
  const final=(await cp.query<Row>(`SELECT e.status,e.authz_version,p.inference_policy_status,p.inference_policy_version,v.requests_per_minute,(SELECT MAX(history.version) FROM saas_project_inference_policy_versions history WHERE history.tenant_id=p.tenant_id AND history.project_id=p.id) AS latest_version FROM saas_project_entitlements e JOIN saas_projects p ON p.tenant_id=e.tenant_id AND p.id=e.project_id JOIN saas_project_inference_policy_versions v ON v.tenant_id=p.tenant_id AND v.project_id=p.id AND v.version=p.inference_policy_version WHERE e.id=$1`,[completed.entitlementId])).rows[0];
  assert.equal(final.status,'active');assert.equal(final.inference_policy_status,'active');
  // Real PG regression: suspended v1 -> capacity append v2 -> activation v3.
  // The old INSERT RETURNING MAX(subquery) snapshot returned v1 during the v2 append and failed before activation.
  assert.equal(String(final.inference_policy_version),'3');assert.equal(String(final.latest_version),'3');assert.equal(String(final.authz_version),'2');assert.equal(Number(final.requests_per_minute),limits.requestsPerMinute);
  assert.equal((await service.provision(input,context)).id,completed.id);
  await assert.rejects(service.provision({...input,pool:{...input.pool,evidenceReference:'changed'}},context),e=>e instanceof PlatformInferenceAccessError && e.code==='VERSION_CONFLICT');
  // Missing server port is fail-closed for Codex before any new journal or
  // entitlement is created. This isolates the static denial, not a valid Codex offering.
  const codexInput:ProvisionPlatformInferenceAccessInput={...input,operationKey:`codex-blocked-${randomUUID()}`,routes:input.routes.map(route=>({...route,providerPolicy:{...route.providerPolicy,definition:{...route.providerPolicy.definition,providerId:'openai-codex',productId:'codex-chatgpt'}}}))};
  await assert.rejects(new PlatformInferenceAccessProvisioningService(cp,{...deps,admissionReadiness:undefined}).provision(codexInput,context),e=>e instanceof PlatformInferenceAccessError && e.code==='TRUSTED_USAGE_BOUNDS_UNAVAILABLE');
  const noCodexJournal=await cp.query(`SELECT id FROM saas_platform_inference_access_operations WHERE tenant_id=$1 AND project_id=$2 AND operation_key=$3`,[tenantId,projectId,codexInput.operationKey]);
  assert.equal(noCodexJournal.rows.length,0);
  const disabled=await service.disable({operationId:completed.id,expectedEntitlementVersion:'2',reason:'risk_control'},context);
  assert.equal(disabled.phase,'disabled');
  const retained=(await cp.query<Row>(`SELECT inference_policy_status FROM saas_projects WHERE tenant_id=$1 AND id=$2`,[tenantId,projectId])).rows[0];
  assert.equal(retained.inference_policy_status,'active','disabling this platform entitlement must not suspend shared project policy');
  await migrator.query(`UPDATE saas_platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[actor.sessionId]);
  await assert.rejects(service.getOperation(completed.id,actor),e=>e instanceof PlatformInferenceAccessError && e.code==='FORBIDDEN');
});
