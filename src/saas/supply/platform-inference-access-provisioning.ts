import type { PlatformInferenceAccessAdmissionReadiness } from './platform-inference-access-admission-readiness.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { saasAdvisoryKey, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL } from '../db/advisory-lock-keys.js';
import type { RouteConfigAuditContext, RouteConfigDefinition, SaasRouteConfigService } from '../gateway/route-config-service.js';
import type { ContractTestAttestationInput, CustomerMeteringPolicyDefinition, ProviderMeteringPolicyDefinition, SaasCommercialMeteringPolicyService } from '../gateway/commercial-metering-policy-service.js';
import type { PlatformAdminActor } from '../platform/access/types.js';
import type { CapacityPolicyLimits, PlatformCapacityPolicyService } from '../platform/capacity-policy-service.js';
import type { GrantPlatformPoolInput, ProviderSupplyService } from './service.js';

export interface PlatformInferenceAccessRouteInput {
  readonly routeId: string;
  readonly definition: RouteConfigDefinition;
  readonly customerPolicy: { readonly policyId: string; readonly definition: CustomerMeteringPolicyDefinition };
  readonly providerPolicy: { readonly policyId: string; readonly definition: ProviderMeteringPolicyDefinition };
  readonly attestation: Omit<ContractTestAttestationInput, 'tenantId' | 'projectId' | 'audit'>;
}
export interface ProvisionPlatformInferenceAccessInput {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly pool: Omit<GrantPlatformPoolInput, 'tenantId' | 'supplyProfileId' | 'poolId'> & { readonly id: string; readonly expectedAuthzVersion: string };
  readonly capacity: {
    readonly tenantExpectedRevision: string;
    readonly projectExpectedRevision: string;
    readonly tenantLimits?: CapacityPolicyLimits;
    readonly projectLimits: CapacityPolicyLimits;
  };
  readonly routes: readonly PlatformInferenceAccessRouteInput[];
}
export interface PlatformInferenceAccessContext {
  readonly actor: PlatformAdminActor;
  readonly audit: RouteConfigAuditContext;
}
export interface PlatformInferenceAccessOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly profileId: string;
  readonly entitlementId: string;
  readonly phase: 'assembling' | 'recheck' | 'completed' | 'failed' | 'disabled';
  readonly receipts: Record<string, string>;
  readonly lastErrorCode: string | null;
  readonly entitlementAuthzVersion?: string;
}
export interface DisablePlatformInferenceAccessInput {
  readonly operationId: string;
  readonly expectedEntitlementVersion: string;
  readonly reason: 'customer_request' | 'incident_response' | 'risk_control';
}
export interface PlatformInferenceAccessDependencies {
  readonly admissionReadiness?: PlatformInferenceAccessAdmissionReadiness;
  readonly supply: Pick<ProviderSupplyService, 'grantPlatformPoolToProfile'>;
  readonly routes: Pick<SaasRouteConfigService, 'create' | 'publish' | 'resolve'>;
  readonly commercial: Pick<SaasCommercialMeteringPolicyService, 'createCustomerPolicy' | 'createProviderPolicy' | 'publishCustomerPolicy' | 'publishProviderPolicy' | 'attestProviderContract' | 'bindRoute' | 'resolveDispatchableRoute'>;
  readonly capacity: Pick<PlatformCapacityPolicyService, 'getTenantPolicy' | 'getProjectPolicy' | 'setTenantPolicy' | 'setProjectPolicy'>;
}
export class PlatformInferenceAccessError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'OPERATION_BUSY' | 'DEPENDENCY_UNAVAILABLE' | 'TRUSTED_USAGE_BOUNDS_UNAVAILABLE' | 'WORKFLOW_UNSUPPORTED' | 'STORAGE_ERROR', options?: ErrorOptions) {
    super('Platform inference access operation could not be completed', options);
    this.name = 'PlatformInferenceAccessError';
  }
}
type Row = Record<string, any>;
function fail(code: PlatformInferenceAccessError['code']): never { throw new PlatformInferenceAccessError(code); }
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('INVALID_INPUT');
  return value;
};
const exact = (value: unknown, keys: readonly string[]): void => {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))) fail('INVALID_INPUT');
};
const decimal = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 9223372036854775807n) fail('INVALID_INPUT');
  return value;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  const result = JSON.stringify(value);
  if (result === undefined) fail('INVALID_INPUT');
  return result;
};
function record(row: Row): PlatformInferenceAccessOperation {
  return { id: row.id, tenantId: row.tenant_id, projectId: row.project_id, profileId: row.profile_id, entitlementId: row.entitlement_id, phase: row.phase, receipts: row.receipts, lastErrorCode: row.last_error_code };
}
const OP_COLUMNS = 'id,tenant_id,project_id,operation_key,request_hash,request_payload,profile_id,entitlement_id,actor_user_id,phase,receipts,last_error_code';
const POLICY_DEFINITION_KEYS=['publicModelId','publicModelVersion','protocol','endpoint','supplyMode','targetMode','usageDimensions','tokenSource','roundingVersion','roundingMode','roundingBoundary','commercialPolicyVersion'] as const;

/** Coordinates existing services; only preparation and final activation are atomic. */
export class PlatformInferenceAccessProvisioningService {
  constructor(private readonly database: SaasDatabase, private readonly dependencies: PlatformInferenceAccessDependencies) {}

  private async fence(tx: SqlExecutor, tenantId: string, projectId: string, actor: PlatformAdminActor): Promise<void> {
    await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
    await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
    for (const key of [saasAdvisoryKey.tenant(tenantId), saasAdvisoryKey.project(tenantId, projectId), saasAdvisoryKey.user(uuid(actor.userId))]) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    }
    await this.authorize(tx, actor);
    const scope = await tx.query(`SELECT p.id FROM saas_projects p JOIN saas_tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2 AND t.status='active'`, [tenantId,projectId]);
    if (scope.rows.length !== 1) fail('NOT_FOUND');
  }
  private async authorize(tx: SqlExecutor, actor: PlatformAdminActor): Promise<void> {
    const result = await tx.query(`SELECT s.id FROM saas_platform_sessions s JOIN saas_users u ON u.id=s.user_id JOIN saas_mfa_credentials c ON c.id=s.credential_id AND c.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.disabled_at IS NULL AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL AND EXISTS(SELECT 1 FROM saas_platform_role_assignments r WHERE r.user_id=s.user_id AND r.role IN ('superadmin','operations'))`, [uuid(actor.sessionId),uuid(actor.userId)]);
    if (result.rows.length !== 1) fail('FORBIDDEN');
  }
  private async audit(tx: SqlExecutor, op: PlatformInferenceAccessOperation, context: PlatformInferenceAccessContext, action: string, targetId=op.id, targetType='platform_inference_access'): Promise<void> {
    await tx.query(`INSERT INTO saas_audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,occurred_at,source_ip,user_agent,entry_point,request_id) VALUES($1,$2,$3,$4,$10,$5,clock_timestamp(),$6,$7,$8,$9)`, [randomUUID(),op.tenantId,context.actor.userId,action,targetId,context.audit.sourceIp ?? null,context.audit.userAgent ?? null,context.audit.entryPoint,context.audit.requestId ?? null,targetType]);
  }
  private validate(input: ProvisionPlatformInferenceAccessInput): void {
    uuid(input?.tenantId); uuid(input?.projectId);
    if (Object.keys(input).some(key=>!['operationKey','tenantId','projectId','pool','capacity','routes'].includes(key))) fail('INVALID_INPUT');
    if (typeof input.operationKey !== 'string' || input.operationKey.length<1 || input.operationKey.length>200 || !Array.isArray(input.routes) || input.routes.length<1 || input.routes.length>20 || !input.pool || !input.capacity) fail('INVALID_INPUT');
    exact(input.pool,['id','expectedAuthzVersion','expiresAt','evidenceReference','evidenceSha256']);
    exact(input.capacity,['tenantExpectedRevision','projectExpectedRevision','tenantLimits','projectLimits']);
    decimal(input.pool.expectedAuthzVersion); decimal(input.capacity.tenantExpectedRevision); decimal(input.capacity.projectExpectedRevision);
    const ids = new Set<string>();
    for (const route of input.routes) {
      if (!route || !route.definition || !route.customerPolicy || !route.providerPolicy || !route.attestation) fail('INVALID_INPUT');
      exact(route,['routeId','definition','customerPolicy','providerPolicy','attestation']);
      exact(route.customerPolicy,['policyId','definition']);
      exact(route.providerPolicy,['policyId','definition']);
      exact(route.definition,['publicModelId','publicModelVersion','protocol','supplyMode','targetMode','upstreamId','endpoint']);
      exact(route.customerPolicy.definition,[...POLICY_DEFINITION_KEYS,'customerPriceVersion']);
      exact(route.providerPolicy.definition,[...POLICY_DEFINITION_KEYS,'providerId','productId','resolvedModel','supplierCostVersion']);
      exact(route.attestation,['id','providerPolicyId','providerPolicyVersion','publicModelId','publicModelVersion','protocol','endpoint','supplyMode','targetMode','contractDigest','suiteVersion','testVectorDigest','verifierKeyId','signatureBase64','usageDimensions','tokenSource','roundingVersion','roundingMode','roundingBoundary']);
      for (const id of [route.routeId,route.customerPolicy.policyId,route.providerPolicy.policyId,route.attestation.id]) {
        if (typeof id !== 'string' || id.length<1 || id.length>200 || id.trim()!==id || ids.has(id)) fail('INVALID_INPUT');
        ids.add(id);
      }
      decimal(route.definition.publicModelVersion);
      decimal(route.customerPolicy.definition.publicModelVersion);
      decimal(route.providerPolicy.definition.publicModelVersion);
      decimal(route.attestation.publicModelVersion);
      decimal(route.attestation.providerPolicyVersion);
      if (route.definition.supplyMode !== 'platform' || route.definition.targetMode !== 'platform_pool' || route.definition.upstreamId !== input.pool.id || route.attestation.providerPolicyId !== route.providerPolicy.policyId || String(route.attestation.providerPolicyVersion) !== '2') fail('INVALID_INPUT');
    }
  }
  private requireAdmissionReadiness(input: ProvisionPlatformInferenceAccessInput): void {
    for (const route of input.routes) {
      const policy=route.providerPolicy.definition;
      const port=this.dependencies.admissionReadiness;
      if (!port && policy.providerId==='openai-codex') fail('TRUSTED_USAGE_BOUNDS_UNAVAILABLE');
      if (!port) continue;
      const readiness=port.check({providerId:policy.providerId,productId:policy.productId,publicModelId:route.definition.publicModelId,publicModelVersion:String(route.definition.publicModelVersion),resolvedModel:policy.resolvedModel,providerProtocol:policy.protocol,endpoint:policy.endpoint,workflow:'responses-http-full'});
      if (readiness.status==='blocked') fail(readiness.code);
    }
  }
  async getOperation(operationId: string, actor: PlatformAdminActor): Promise<PlatformInferenceAccessOperation> {
    return this.database.transaction(async tx => {
      await this.authorize(tx,actor);
      const selected = await tx.query<Row>(`SELECT ${OP_COLUMNS} FROM saas_platform_inference_access_operations WHERE id=$1`,[uuid(operationId)]);
      if (selected.rows.length !== 1) fail('NOT_FOUND');
      const version=await tx.query<Row>('SELECT authz_version FROM saas_project_entitlements WHERE id=$1',[selected.rows[0].entitlement_id]);
      return {...record(selected.rows[0]),entitlementAuthzVersion:String(version.rows[0]?.authz_version)};
    });
  }
  async provision(input: ProvisionPlatformInferenceAccessInput, context: PlatformInferenceAccessContext): Promise<PlatformInferenceAccessOperation> {
    this.validate(input);
    if (context.audit.actorUserId !== context.actor.userId) fail('FORBIDDEN');
    const hash = createHash('sha256').update(canonical(input)).digest('hex');
    const op = await this.database.transaction(async tx => {
      await this.fence(tx,input.tenantId,input.projectId,context.actor);
      const previous = await tx.query<Row>(`SELECT ${OP_COLUMNS} FROM saas_platform_inference_access_operations WHERE tenant_id=$1 AND project_id=$2 AND operation_key=$3`,[input.tenantId,input.projectId,input.operationKey]);
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) fail('VERSION_CONFLICT');
        return record(previous.rows[0]);
      }
      this.requireAdmissionReadiness(input);
      for (const route of input.routes) {
        const pool=await tx.query(`SELECT id FROM saas_platform_provider_pools WHERE id=$1 AND authz_version=$2 AND provider_id=$3 AND product_id=$4 AND status='active' AND validation_state='verified'`,[input.pool.id,input.pool.expectedAuthzVersion,route.providerPolicy.definition.providerId,route.providerPolicy.definition.productId]);
        if (pool.rows.length!==1) fail('DEPENDENCY_UNAVAILABLE');
      }
      const active = await tx.query(`SELECT id FROM saas_project_entitlements WHERE tenant_id=$1 AND project_id=$2 AND supply_mode='platform' AND status='active'`,[input.tenantId,input.projectId]);
      if (active.rows.length) fail('VERSION_CONFLICT');
      // Reserve only NEW route/policy identifiers; never adopt another operator's resources.
      for (const route of input.routes) {
        const existing = await tx.query(`SELECT route_id AS id FROM saas_route_config_heads WHERE tenant_id=$1 AND project_id=$2 AND route_id=$3 UNION ALL SELECT policy_id AS id FROM saas_customer_metering_policy_heads WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$4 UNION ALL SELECT policy_id AS id FROM saas_provider_metering_policy_heads WHERE tenant_id=$1 AND project_id=$2 AND policy_id=$5`,[input.tenantId,input.projectId,route.routeId,route.customerPolicy.policyId,route.providerPolicy.policyId]);
        if (existing.rows.length) fail('VERSION_CONFLICT');
      }
      const models: string[]=[];
      for (const route of input.routes) {
        const model = await tx.query<Row>(`SELECT m.alias FROM saas_public_models m JOIN saas_public_model_versions v ON v.public_model_id=m.id WHERE m.id=$1 AND v.version=$2 AND m.status='active' AND v.status='active'`,[route.definition.publicModelId,String(route.definition.publicModelVersion)]);
        if (model.rows.length !== 1) fail('DEPENDENCY_UNAVAILABLE');
        models.push(model.rows[0].alias);
      }
      const id=randomUUID(), profileId=`platform-access:${id}`, entitlementId=randomUUID();
      await tx.query(`INSERT INTO saas_supply_profiles(tenant_id,id,supply_mode,status,model_scopes) VALUES($1,$2,'platform','active',$3)`,[input.tenantId,profileId,[...new Set(models)]]);
      await tx.query(`INSERT INTO saas_project_entitlements(id,tenant_id,project_id,supply_profile_id,supply_mode,status,model_scopes,disabled_at,source_type,source_ref) VALUES($1,$2,$3,$4,'platform','disabled',$5,clock_timestamp(),'admin_grant',$6)`,[entitlementId,input.tenantId,input.projectId,profileId,[...new Set(models)],id]);
      const inserted=await tx.query<Row>(`INSERT INTO saas_platform_inference_access_operations(id,tenant_id,project_id,operation_key,request_hash,request_payload,profile_id,entitlement_id,actor_user_id,phase) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'assembling') RETURNING ${OP_COLUMNS}`,[id,input.tenantId,input.projectId,input.operationKey,hash,canonical(input),profileId,entitlementId,context.actor.userId]);
      const result=record(inserted.rows[0]);
      await this.audit(tx,result,context,'supply_profile.created',profileId,'saas_supply_profile');
      await this.audit(tx,result,context,'project_entitlement.created',entitlementId,'saas_project_entitlement');
      await this.audit(tx,result,context,'platform_inference_access.prepared');
      return result;
    });
    if (op.phase==='completed' || op.phase==='disabled') return op;
    // A stable server-owned requestId proves ownership after commit-ACK loss.
    const audit={...context.audit,requestId:op.id};
    return this.database.transaction(async guard=>{
    // This guard holds ONLY the operation advisory lock, never authority/row locks.
    // Existing services retain their independent commits; a crashed connection releases the mutex.
    // Provisioning needs a second pool connection for those service transactions.
    // Keep at most one guard connection pinned across all provisioning runs, so concurrent
    // administrators cannot consume the whole control-plane pool while waiting for child transactions.
    const runner=await guard.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',['platform-access-provisioning-runner:v1']);
    if (runner.rows[0]?.locked!==true) fail('OPERATION_BUSY');
    const locked=await guard.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`platform-access-operation:${op.id}`]);
    if (locked.rows[0]?.locked!==true) fail('OPERATION_BUSY');
    const runId=randomUUID();
    const claim=await this.database.query(`UPDATE saas_platform_inference_access_operations SET runner_id=$2,runner_until=clock_timestamp()+interval '10 minutes' WHERE id=$1 AND phase IN ('assembling','failed','recheck') RETURNING id`,[op.id,runId]);
    if (claim.rows.length!==1) fail('VERSION_CONFLICT');
    try {
      this.requireAdmissionReadiness(input);
      await this.assemble(op,input,{...context,audit});
      return await this.activate(op,input,{...context,audit},runId);
    } catch(error) {
      await this.database.transaction(async tx => {
        await this.fence(tx,op.tenantId,op.projectId,context.actor);
        await tx.query(`UPDATE saas_platform_inference_access_operations SET phase='failed',last_error_code=$2,updated_at=clock_timestamp() WHERE id=$1 AND runner_id=$3 AND phase NOT IN ('completed','disabled')`,[op.id,error instanceof PlatformInferenceAccessError ? error.code : 'DEPENDENCY_UNAVAILABLE',runId]);
      });
      throw error instanceof PlatformInferenceAccessError ? error : new PlatformInferenceAccessError('DEPENDENCY_UNAVAILABLE', {cause:error});
    } finally {
      await this.database.query(`UPDATE saas_platform_inference_access_operations SET runner_id=NULL,runner_until=NULL WHERE id=$1 AND runner_id=$2`,[op.id,runId]);
    }
    });
  }

  private async receipt(op: PlatformInferenceAccessOperation, key: string, value: string): Promise<void> {
    await this.database.query(`UPDATE saas_platform_inference_access_operations SET receipts=receipts||jsonb_build_object($2::text,$3::text),updated_at=clock_timestamp() WHERE id=$1 AND phase NOT IN ('completed','disabled')`,[op.id,key,value]);
    op.receipts[key]=value;
  }
  private async ownedCreate(op: PlatformInferenceAccessOperation, key: string, targetId: string, action: string, create:()=>Promise<unknown>): Promise<void> {
    if (op.receipts[key]) return;
    const existing=await this.database.query(`SELECT id FROM saas_audit_events WHERE tenant_id=$1 AND request_id=$2 AND action=$3 AND target_id=$4`,[op.tenantId,op.id,action,targetId]);
    if (!existing.rows.length) await create();
    await this.receipt(op,key,'done');
  }
  private async assemble(op: PlatformInferenceAccessOperation,input: ProvisionPlatformInferenceAccessInput,context: PlatformInferenceAccessContext): Promise<void> {
    const scope={tenantId:op.tenantId,projectId:op.projectId,audit:context.audit};
    if (!op.receipts.pool) {
      const grant=await this.database.query<Row>(`SELECT g.authz_version FROM saas_platform_provider_pool_grants g JOIN saas_platform_provider_pools p ON p.id=g.pool_id WHERE g.pool_id=$1 AND g.tenant_id=$2 AND g.supply_profile_id=$3 AND g.status='active' AND g.pool_authz_version=$4 AND p.authz_version=$4 AND p.status='active' AND p.validation_state='verified'`,[input.pool.id,op.tenantId,op.profileId,input.pool.expectedAuthzVersion]);
      if (!grant.rows.length) {
        const pool=await this.database.query(`SELECT id FROM saas_platform_provider_pools WHERE id=$1 AND authz_version=$2 AND status='active' AND validation_state='verified'`,[input.pool.id,input.pool.expectedAuthzVersion]);
        if (pool.rows.length!==1) fail('VERSION_CONFLICT');
        await this.dependencies.supply.grantPlatformPoolToProfile({...input.pool,poolId:input.pool.id,tenantId:op.tenantId,supplyProfileId:op.profileId});
      }
      await this.receipt(op,'pool',input.pool.expectedAuthzVersion);
    }
    for (const r of input.routes) {
      await this.ownedCreate(op,`route:${r.routeId}`,`${op.projectId}:${r.routeId}:1`,'route_config.created',()=>this.dependencies.routes.create({...scope,routeId:r.routeId,definition:r.definition}));
      await this.ownedCreate(op,`customer:${r.routeId}`,`${op.projectId}:${r.customerPolicy.policyId}:1`,'commercial_metering.customer_policy_created',()=>this.dependencies.commercial.createCustomerPolicy({policyId:r.customerPolicy.policyId,definition:r.customerPolicy.definition,...scope}));
      await this.ownedCreate(op,`provider:${r.routeId}`,`${op.projectId}:${r.providerPolicy.policyId}:1`,'commercial_metering.provider_policy_created',()=>this.dependencies.commercial.createProviderPolicy({policyId:r.providerPolicy.policyId,definition:r.providerPolicy.definition,...scope}));
      await this.publishOwned(op,scope,r);
      if (!op.receipts[`attestation:${r.routeId}`]) {
        const exists=await this.database.query(`SELECT id FROM saas_contract_test_attestations WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND provider_policy_id=$4 AND provider_policy_version=2 AND verification_result='verified' AND contract_digest=$5 AND signature_base64=$6`,[op.tenantId,op.projectId,r.attestation.id,r.providerPolicy.policyId,r.attestation.contractDigest,r.attestation.signatureBase64]);
        if (!exists.rows.length) await this.dependencies.commercial.attestProviderContract({...r.attestation,...scope});
        await this.receipt(op,`attestation:${r.routeId}`,r.attestation.id);
      }
      if (!op.receipts[`binding:${r.routeId}`]) {
        const binding=await this.dependencies.commercial.resolveDispatchableRoute(op.tenantId,op.projectId,r.routeId,'2');
        if (!binding) await this.dependencies.commercial.bindRoute({...scope,routeId:r.routeId,routeVersion:'2',customerPolicyId:r.customerPolicy.policyId,customerPolicyVersion:'2',providerPolicyId:r.providerPolicy.policyId,providerPolicyVersion:'2',contractAttestationId:r.attestation.id});
        await this.receipt(op,`binding:${r.routeId}`,'2');
      }
    }
    const common={tenantId:op.tenantId,actor:context.actor,requestId:op.id,reason:'initial_provisioning' as const};
    for (const kind of ['tenant','project'] as const) {
      const desired=kind==='tenant'?input.capacity.tenantLimits:input.capacity.projectLimits;
      const expected=kind==='tenant'?input.capacity.tenantExpectedRevision:input.capacity.projectExpectedRevision;
      const current=kind==='tenant'?await this.dependencies.capacity.getTenantPolicy({tenantId:op.tenantId,actor:context.actor}):await this.dependencies.capacity.getProjectPolicy({tenantId:op.tenantId,projectId:op.projectId,actor:context.actor});
      if (!current) fail('NOT_FOUND');
      if (op.receipts[`capacity:${kind}`]) continue;
      if (!desired) {
        if (current.revision!==expected || !current.configured) fail('VERSION_CONFLICT');
      } else if (canonical(current.limits)!==canonical(desired)) {
        const changed=kind==='tenant'?await this.dependencies.capacity.setTenantPolicy({...common,expectedRevision:expected,limits:desired}):await this.dependencies.capacity.setProjectPolicy({...common,projectId:op.projectId,expectedRevision:expected,limits:desired});
        await this.receipt(op,`capacity:${kind}`,changed.revision);
        continue;
      } else if (current.revision!==expected) {
        if (current.revision!==(BigInt(expected)+1n).toString()) fail('VERSION_CONFLICT');
        const owned=await this.database.query(`SELECT id FROM saas_audit_events WHERE tenant_id=$1 AND request_id=$2 AND action='capacity_policy.updated' AND target_type=$3`,[op.tenantId,op.id,`${kind}_capacity_policy`]);
        if (owned.rows.length!==1) fail('VERSION_CONFLICT');
      }
      await this.receipt(op,`capacity:${kind}`,current.revision);
    }
  }

  private async publishOwned(op: PlatformInferenceAccessOperation,scope:{tenantId:string;projectId:string;audit:RouteConfigAuditContext},r:PlatformInferenceAccessRouteInput):Promise<void> {
    const stages=[
      {key:`route-published:${r.routeId}`,table:'saas_route_config_heads',column:'route_id',id:r.routeId,run:()=>this.dependencies.routes.publish({...scope,routeId:r.routeId,expectedVersion:'1'})},
      {key:`customer-published:${r.routeId}`,table:'saas_customer_metering_policy_heads',column:'policy_id',id:r.customerPolicy.policyId,run:()=>this.dependencies.commercial.publishCustomerPolicy({...scope,policyId:r.customerPolicy.policyId,expectedVersion:'1',definition:r.customerPolicy.definition})},
      {key:`provider-published:${r.routeId}`,table:'saas_provider_metering_policy_heads',column:'policy_id',id:r.providerPolicy.policyId,run:()=>this.dependencies.commercial.publishProviderPolicy({...scope,policyId:r.providerPolicy.policyId,expectedVersion:'1',definition:r.providerPolicy.definition})},
    ];
    for (const stage of stages) {
      if (op.receipts[stage.key]) continue;
      // Identifiers are private constants, never interpolated from client input.
      const head=await this.database.query<Row>(`SELECT current_version,status FROM ${stage.table} WHERE tenant_id=$1 AND project_id=$2 AND ${stage.column}=$3`,[op.tenantId,op.projectId,stage.id]);
      if (head.rows.length!==1) fail('VERSION_CONFLICT');
      if (String(head.rows[0].current_version)==='1' && head.rows[0].status==='draft') await stage.run();
      else if (String(head.rows[0].current_version)!=='2' || head.rows[0].status!=='active') fail('VERSION_CONFLICT');
      await this.receipt(op,stage.key,'2');
    }
  }

  private async activate(op:PlatformInferenceAccessOperation,input:ProvisionPlatformInferenceAccessInput,context:PlatformInferenceAccessContext,runId:string):Promise<PlatformInferenceAccessOperation> {
    return this.database.transaction(async tx=>{
      await this.fence(tx,op.tenantId,op.projectId,context.actor);
      const selected=await tx.query<Row>(`SELECT ${OP_COLUMNS} FROM saas_platform_inference_access_operations WHERE id=$1`,[op.id]);
      if (selected.rows[0]?.phase==='completed') return record(selected.rows[0]);
      if (!selected.rows[0] || selected.rows[0].phase==='disabled') fail('VERSION_CONFLICT');
      const runner=await tx.query(`SELECT id FROM saas_platform_inference_access_operations WHERE id=$1 AND runner_id=$2`,[op.id,runId]);
      if (runner.rows.length!==1) fail('VERSION_CONFLICT');
      let currency: string | null = null;
      this.requireAdmissionReadiness(input);
      for (const r of input.routes) {
        const model=await tx.query<Row>(`SELECT alias FROM saas_public_models WHERE id=$1 AND status='active'`,[r.definition.publicModelId]);
        if (model.rows.length!==1) fail('DEPENDENCY_UNAVAILABLE');
        const resolved=await this.dependencies.routes.resolve({tenantId:op.tenantId,projectId:op.projectId,publicModel:model.rows[0].alias,protocol:r.definition.protocol,supplyMode:'platform',executor:tx});
        if (resolved.routeId!==r.routeId || resolved.version!=='2') fail('VERSION_CONFLICT');
        const authority=await this.dependencies.commercial.resolveDispatchableRoute(op.tenantId,op.projectId,r.routeId,'2',tx);
        if (!authority || authority.customerPolicyId!==r.customerPolicy.policyId || authority.providerPolicyId!==r.providerPolicy.policyId || authority.customerPriceVersion!==r.customerPolicy.definition.customerPriceVersion || authority.contractAttestationId!==r.attestation.id) fail('DEPENDENCY_UNAVAILABLE');
        const prices=await tx.query<Row>(`SELECT c.currency FROM saas_customer_price_versions c JOIN saas_supplier_cost_versions s ON s.id=$2 WHERE c.id=$1 AND c.currency=s.currency AND c.effective_at<=clock_timestamp() AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND s.effective_at<=clock_timestamp() AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())`,[authority.customerPriceVersion,authority.supplierCostVersion]);
        if (prices.rows.length!==1 || (currency!==null && currency!==prices.rows[0].currency)) fail('DEPENDENCY_UNAVAILABLE');
        currency=prices.rows[0].currency;
      }
      for (const key of [saasAdvisoryKey.platformPool(input.pool.id),saasAdvisoryKey.supplyProfile(op.tenantId,op.profileId)]) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const grant=await tx.query(`SELECT g.pool_id FROM saas_platform_provider_pool_grants g JOIN saas_platform_provider_pools p ON p.id=g.pool_id JOIN saas_supply_profiles s ON s.tenant_id=g.tenant_id AND s.id=g.supply_profile_id WHERE g.pool_id=$1 AND g.tenant_id=$2 AND g.supply_profile_id=$3 AND g.status='active' AND p.status='active' AND p.validation_state='verified' AND g.pool_authz_version=p.authz_version AND p.authz_version=$4 AND s.status='active' AND s.authz_version=g.profile_authz_version AND g.effective_at<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())`,[input.pool.id,op.tenantId,op.profileId,input.pool.expectedAuthzVersion]);
      if (grant.rows.length!==1) fail('DEPENDENCY_UNAVAILABLE');
      for (const route of input.routes) {
        const provider=route.providerPolicy.definition;
        const available=await tx.query(`SELECT a.id FROM saas_platform_provider_pools p
          JOIN saas_platform_provider_pool_members m ON m.pool_id=p.id
          JOIN saas_platform_provider_accounts a ON a.id=m.account_id AND a.provider_id=p.provider_id AND a.product_id=p.product_id
          JOIN saas_platform_provider_credentials c ON c.account_id=a.id AND c.provider_id=a.provider_id AND c.product_id=a.product_id
          JOIN saas_platform_provider_credential_versions v ON v.account_id=c.account_id AND v.credential_id=c.id AND v.version=c.current_version
          JOIN saas_platform_provider_account_capabilities ac ON ac.account_id=a.id AND ac.provider_id=a.provider_id AND ac.product_id=a.product_id AND ac.model=$4 AND ac.endpoint=$5
          JOIN saas_provider_capabilities cap ON cap.provider_id=ac.provider_id AND cap.product_id=ac.product_id AND cap.model=ac.model AND cap.endpoint=ac.endpoint AND cap.version=ac.capability_version
          JOIN saas_provider_products product ON product.provider_id=p.provider_id AND product.product_id=p.product_id AND product.status='active'
          JOIN saas_provider_rights rights ON rights.rights_id=a.rights_id AND rights.version=a.rights_version
          JOIN saas_provider_rights pool_rights ON pool_rights.rights_id=p.rights_id AND pool_rights.version=p.rights_version
          WHERE p.id=$1 AND p.provider_id=$2 AND p.product_id=$3
          AND m.provider_id=a.provider_id AND m.product_id=a.product_id AND m.status='active' AND m.account_authz_version=a.authz_version
          AND a.status='active' AND a.validation_state='verified'
          AND c.status='active' AND c.validation_state='verified' AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
          AND v.status='active' AND v.owner_kind='platform' AND v.supply_mode='platform' AND (v.expires_at IS NULL OR v.expires_at>clock_timestamp())
          AND cap.validation_state='verified' AND cap.support_level IN ('supported','limited') AND cap.protocol=$6
          AND cap.version=(SELECT MAX(latest.version) FROM saas_provider_capabilities latest WHERE latest.provider_id=cap.provider_id AND latest.product_id=cap.product_id AND latest.model=cap.model AND latest.endpoint=cap.endpoint)
          AND rights.status='active' AND rights.effective_at<=clock_timestamp() AND (rights.expires_at IS NULL OR rights.expires_at>clock_timestamp())
          AND rights.provider_id=a.provider_id AND rights.product_id=a.product_id AND rights.credential_type=a.credential_type AND rights.supply_mode=a.supply_mode AND rights.region=a.region AND rights.purpose=a.purpose
          AND pool_rights.provider_id=p.provider_id AND pool_rights.product_id=p.product_id AND pool_rights.credential_type=p.credential_type AND pool_rights.supply_mode=p.supply_mode AND pool_rights.region=p.region AND pool_rights.purpose=p.purpose
          AND pool_rights.status='active' AND pool_rights.effective_at<=clock_timestamp() AND (pool_rights.expires_at IS NULL OR pool_rights.expires_at>clock_timestamp())
          AND pool_rights.version=(SELECT latest.version FROM saas_provider_rights latest WHERE latest.rights_id=pool_rights.rights_id AND latest.effective_at<=clock_timestamp() ORDER BY latest.effective_at DESC,latest.version DESC LIMIT 1)
          AND $4=ANY(pool_rights.model_scope) AND $5=ANY(pool_rights.endpoint_scope)
          AND rights.version=(SELECT latest.version FROM saas_provider_rights latest WHERE latest.rights_id=rights.rights_id AND latest.effective_at<=clock_timestamp() ORDER BY latest.effective_at DESC,latest.version DESC LIMIT 1)
          AND $4=ANY(rights.model_scope) AND $5=ANY(rights.endpoint_scope) LIMIT 1`,[input.pool.id,provider.providerId,provider.productId,provider.resolvedModel,provider.endpoint,provider.protocol]);
        if (available.rows.length!==1) fail('DEPENDENCY_UNAVAILABLE');
      }
      const capacity=await tx.query<Row>(`SELECT p.inference_policy_version,v.status,v.requests_per_minute,v.tokens_per_minute,v.max_concurrent_requests,t.capacity_policy_revision,t.requests_per_minute AS tenant_rpm,t.tokens_per_minute AS tenant_tpm,t.max_concurrent_requests AS tenant_concurrency FROM saas_projects p JOIN saas_project_inference_policy_versions v ON v.tenant_id=p.tenant_id AND v.project_id=p.id AND v.version=p.inference_policy_version JOIN saas_tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2`,[op.tenantId,op.projectId]);
      const c=capacity.rows[0];
      if (!c || String(c.inference_policy_version)!==op.receipts['capacity:project'] || String(c.capacity_policy_revision)!==op.receipts['capacity:tenant'] || !c.requests_per_minute || !c.tokens_per_minute || !c.max_concurrent_requests || !c.tenant_rpm || !c.tenant_tpm || !c.tenant_concurrency || c.status==='disabled') fail('VERSION_CONFLICT');
      if (c.status!=='active') {
        const next=(BigInt(c.inference_policy_version)+1n).toString();
        await tx.query(`INSERT INTO saas_project_inference_policy_versions(tenant_id,project_id,version,status,changed_by_user_id,requests_per_minute,tokens_per_minute,max_concurrent_requests) VALUES($1,$2,$3,'active',$4,$5,$6,$7)`,[op.tenantId,op.projectId,next,context.actor.userId,c.requests_per_minute,c.tokens_per_minute,c.max_concurrent_requests]);
        const changed=await tx.query(`UPDATE saas_projects SET inference_policy_version=$3,inference_policy_status='active',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND inference_policy_version=$4 RETURNING id`,[op.tenantId,op.projectId,next,c.inference_policy_version]);
        if (changed.rows.length!==1) fail('VERSION_CONFLICT');
      }
      const activated=await tx.query(`UPDATE saas_project_entitlements SET status='active',disabled_at=NULL,authz_version=authz_version+1,updated_at=clock_timestamp(),last_audited_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND supply_profile_id=$4 AND status='disabled' AND authz_version=1 AND source_ref=$5 RETURNING id`,[op.entitlementId,op.tenantId,op.projectId,op.profileId,op.id]);
      if (activated.rows.length!==1) fail('VERSION_CONFLICT');
      await this.audit(tx,op,context,'platform_inference_access.activated');
      const completed=await tx.query<Row>(`UPDATE saas_platform_inference_access_operations SET phase='completed',last_error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${OP_COLUMNS}`,[op.id]);
      return {...record(completed.rows[0]),entitlementAuthzVersion:'2'};
    });
  }
  async disable(input:DisablePlatformInferenceAccessInput,context:PlatformInferenceAccessContext):Promise<PlatformInferenceAccessOperation> {
    if (!input || typeof input !== 'object') fail('INVALID_INPUT');
    decimal(input.expectedEntitlementVersion);
    if (!['customer_request','incident_response','risk_control'].includes(input.reason)) fail('INVALID_INPUT');
    const op=await this.getOperation(input.operationId,context.actor);
    return this.database.transaction(async tx=>{
      const locked=await tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`platform-access-operation:${op.id}`]);
      if (locked.rows[0]?.locked!==true) fail('OPERATION_BUSY');
      await this.fence(tx,op.tenantId,op.projectId,context.actor);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[saasAdvisoryKey.supplyProfile(op.tenantId,op.profileId)]);
      const changed=await tx.query<Row>(`UPDATE saas_project_entitlements SET status='disabled',disabled_at=clock_timestamp(),authz_version=authz_version+1,updated_at=clock_timestamp(),last_audited_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND supply_profile_id=$4 AND authz_version=$5 AND status IN ('active','disabled') RETURNING id,authz_version`,[op.entitlementId,op.tenantId,op.projectId,op.profileId,input.expectedEntitlementVersion]);
      if (changed.rows.length!==1) fail('VERSION_CONFLICT');
      await this.audit(tx,op,context,`platform_inference_access.disabled.${input.reason}`);
      const result=await tx.query<Row>(`UPDATE saas_platform_inference_access_operations SET phase='disabled',updated_at=clock_timestamp() WHERE id=$1 RETURNING ${OP_COLUMNS}`,[op.id]);
      return {...record(result.rows[0]),entitlementAuthzVersion:String(changed.rows[0].authz_version)};
    });
  }
}
