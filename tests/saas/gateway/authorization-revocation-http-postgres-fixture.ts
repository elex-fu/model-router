import assert from 'node:assert/strict';
import { randomUUID, sign, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import { PostgresSupplyProfileResolver } from '../../../src/saas/keys/resolver.js';
import { PlatformCapacityPolicyService } from '../../../src/saas/platform/capacity-policy-service.js';
import { PlatformTenantLifecycleService } from '../../../src/saas/platform/governance/tenants.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import { SaasCommercialMeteringPolicyService, canonicalContractAttestationPayload,
  type CustomerMeteringPolicyDefinition, type ProviderMeteringPolicyDefinition } from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { PlatformInferenceAccessProvisioningService } from '../../../src/saas/supply/platform-inference-access-provisioning.js';
import { createBuiltinPlatformInferenceAccessAdmissionReadiness } from '../../../src/saas/supply/platform-inference-access-admission-readiness.js';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock, SaasAdmissionAuthorizationError } from '../../../src/saas/gateway/authorization-prelock.js';

interface Gateway { readonly origin: string; failure(): { readonly stage: string; readonly code: string } | null }
export async function proveAuthorizationRevocationHttp(input: {
  control: SaasDatabase; observation: SaasDatabase; administratorId: string;
  poolId: string; deploymentId: string; environmentId: string; publicModel: string; endpoint: string;
  customer: CustomerMeteringPolicyDefinition; provider: ProviderMeteringPolicyDefinition;
  verifierKeyId: string; publicKey: KeyObject; privateKey: KeyObject; testVectorDigest: string;
  registerContext(context: TenantContext): void; gateways: readonly Gateway[];
  upstreamCalls(): number; scenario(name: string, work: () => Promise<void>): Promise<unknown>;
}): Promise<void> {
  const cp = input.control, read = input.observation;
  const sessions = (await cp.query<{ id: string }>(`SELECT s.id FROM saas_platform_sessions s
    JOIN saas_mfa_credentials c ON c.id=s.credential_id AND c.user_id=s.user_id
    WHERE s.user_id=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM saas_platform_role_assignments r WHERE r.user_id=s.user_id AND r.role='superadmin')`, [input.administratorId])).rows;
  assert.equal(sessions.length, 1, 'reuse the real operator MFA session, never manufacture a session');
  const actor = { userId: input.administratorId, sessionId: sessions[0]!.id, roles: ['superadmin' as const] };
  const identity = new SaasIdentityService(cp);
  const tenant = await identity.createTenant(actor.userId, { name: `Authorization ${randomUUID()}` });
  const tenantId = tenant.id, projectId = tenant.defaultProjectId;
  const context = await identity.resolveTenantContext({ userId: actor.userId, tenantId, projectId });
  const capacity = new PlatformCapacityPolicyService(cp);
  const tenantPolicy = await capacity.getTenantPolicy({ tenantId, actor });
  const projectPolicy = await capacity.getProjectPolicy({ tenantId, projectId, actor });
  assert.ok(tenantPolicy && projectPolicy);
  const pool = (await cp.query<{ authz_version: string }>('SELECT authz_version::text FROM saas_platform_provider_pools WHERE id=$1', [input.poolId])).rows[0];
  assert.ok(pool);
  // P01 accepts an exact DTO; the old commercial fixture's spread provider
  // object also carries customerPriceVersion, which is not provider authority.
  const customerDefinition: CustomerMeteringPolicyDefinition = {
    ...input.customer, publicModelVersion: String(input.customer.publicModelVersion),
  };
  const providerDefinition: ProviderMeteringPolicyDefinition = {
    publicModelId: input.provider.publicModelId, publicModelVersion: String(input.provider.publicModelVersion),
    protocol: input.provider.protocol, endpoint: input.provider.endpoint,
    supplyMode: input.provider.supplyMode, targetMode: input.provider.targetMode,
    usageDimensions: input.provider.usageDimensions, tokenSource: input.provider.tokenSource,
    roundingVersion: input.provider.roundingVersion, roundingMode: input.provider.roundingMode,
    roundingBoundary: input.provider.roundingBoundary, commercialPolicyVersion: input.provider.commercialPolicyVersion,
    providerId: input.provider.providerId, productId: input.provider.productId,
    resolvedModel: input.provider.resolvedModel, supplierCostVersion: input.provider.supplierCostVersion,
  };
  const providerPolicyId = `authz-provider-${randomUUID()}`;
  const payload = { publicModelId: input.customer.publicModelId, publicModelVersion: String(input.customer.publicModelVersion),
    protocol: input.customer.protocol, endpoint: input.customer.endpoint, supplyMode: 'platform' as const,
    targetMode: 'platform_pool' as const, usageDimensions: input.customer.usageDimensions,
    tokenSource: input.customer.tokenSource, roundingVersion: input.customer.roundingVersion,
    roundingMode: input.customer.roundingMode, roundingBoundary: 'total' as const,
    providerPolicyId, providerPolicyVersion: '2', contractDigest: 'a'.repeat(64),
    suiteVersion: 'gateway-e2e-suite-v1', testVectorDigest: input.testVectorDigest };
  const service = new PlatformInferenceAccessProvisioningService(cp, {
    admissionReadiness: createBuiltinPlatformInferenceAccessAdmissionReadiness(),
    supply: new ProviderSupplyService(cp, { deployment: input.deploymentId, environment: input.environmentId, kmsKeyId: 'gateway-e2e-kms-key' }),
    routes: new SaasRouteConfigService(cp), capacity,
    commercial: new SaasCommercialMeteringPolicyService(cp, {
      trustedVerifierPublicKeys: new Map([[input.verifierKeyId, input.publicKey]]),
      trustedTestVectorDigests: new Map([['gateway-e2e-suite-v1', input.testVectorDigest]]) }),
  });
  const audit = { actorUserId: actor.userId, entryPoint: 'authorization-revocation-http-fixture', requestId: randomUUID() };
  const limits = { requestsPerMinute: 120, tokensPerMinute: 120000, maxConcurrentRequests: 4 };
  const operation = await service.provision({ operationKey: `authz-${randomUUID()}`, tenantId, projectId,
    pool: { id: input.poolId, expectedAuthzVersion: pool.authz_version, evidenceReference: 'test-only:authorization-scope', evidenceSha256: 'b'.repeat(64) },
    capacity: { tenantExpectedRevision: tenantPolicy.revision, projectExpectedRevision: projectPolicy.revision, tenantLimits: limits, projectLimits: limits },
    routes: [{ routeId: `authz-route-${randomUUID()}`, definition: { publicModelId: input.customer.publicModelId,
      publicModelVersion: String(input.customer.publicModelVersion), protocol: input.customer.protocol, supplyMode: 'platform',
      targetMode: 'platform_pool', upstreamId: input.poolId, endpoint: input.customer.endpoint },
      customerPolicy: { policyId: `authz-customer-${randomUUID()}`, definition: customerDefinition },
      providerPolicy: { policyId: providerPolicyId, definition: providerDefinition },
      attestation: { ...payload, id: `authz-attestation-${randomUUID()}`, verifierKeyId: input.verifierKeyId,
        signatureBase64: sign(null, Buffer.from(canonicalContractAttestationPayload(payload)), input.privateKey).toString('base64') } }] }, { actor, audit });
  assert.equal(operation.phase, 'completed');
  input.registerContext(context);
  await cp.transaction(tx => new PlatformWalletLedgerService().postVerifiedFunding(tx, { tenantId, currency: 'USD',
    amountMinorUnits: '1000', sourceOrderRef: `authz-funding-${tenantId}`, idempotencyKey: `authz-funding-${tenantId}`, metadataRef: 'test-only:authorization' }));
  const keys = new KeyService(cp, { resolver: new PostgresSupplyProfileResolver(cp) });
  const keyA = await keys.create(context, { name: 'Authorization A', modelScopes: [input.publicModel], supplyMode: 'platform' });
  const keyB = await keys.create(context, { name: 'Authorization B', modelScopes: [input.publicModel], supplyMode: 'platform' });
  for (const key of [keyA, keyB]) {
    const policy = await capacity.getApiKeyPolicy({ tenantId, projectId, apiKeyId: key.id, actor });
    assert.ok(policy);
    await capacity.setApiKeyPolicy({ tenantId, projectId, apiKeyId: key.id, actor, expectedRevision: policy.revision,
      limits: { ...limits, maxConcurrentRequests: 1 }, reason: 'initial_provisioning', requestId: randomUUID() });
  }
  const tables = ['saas_requests', 'saas_attempts', 'saas_billing_reservations', 'saas_usage_events', 'saas_usage_settlements',
    'saas_ledger_transactions', 'saas_ledger_entries', 'saas_wallets', 'saas_provider_account_leases',
    'saas_gateway_capacity_reservations', 'saas_gateway_request_idempotency_keys'] as const;
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await read.query<{ rows: unknown }>(`SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) AS rows FROM ${table} x WHERE tenant_id=$1`, [tenantId])).rows[0]!.rows])));
  const source = new Map<KeyService, number>();
  const originalAuthenticate = KeyService.prototype.authenticate;
  const originalPrelock = PostgresSaasRequestAdmissionAuthorizationPrelock.prototype.prelock;
  let denied = 0;
  KeyService.prototype.authenticate = function(rawKey) {
    if (rawKey === keyA.secret || rawKey === keyB.secret) source.set(this, (source.get(this) ?? 0) + 1);
    return originalAuthenticate.call(this, rawKey);
  };
  PostgresSaasRequestAdmissionAuthorizationPrelock.prototype.prelock = async function(value) {
    try { return await originalPrelock.call(this, value); }
    catch (error) {
      if (value.request.tenantId === tenantId && error instanceof SaasAdmissionAuthorizationError && error.code === 'authorization_denied') denied += 1;
      throw error;
    }
  };
  const sourceCount = () => [...source.values()].reduce((sum, count) => sum + count, 0);
  const post = async (gateway: Gateway, secret: string) => {
    const response = await fetch(`${gateway.origin}${input.endpoint}`, { method: 'POST', headers: {
      authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': `authz-${randomUUID()}` },
      body: JSON.stringify({ model: input.publicModel, messages: [{ role: 'user', content: 'Authorization revocation fixture' }], max_tokens: 8, stream: false }),
      signal: AbortSignal.timeout(10_000) });
    return { response, body: await response.json() as { error?: { code?: string } } };
  };
  const success = async (gateway: Gateway, secret: string) => {
    const result = await post(gateway, secret);
    assert.equal(result.response.status, 200, 'normal managed HTTP must settle before each revocation');
    const requestId = result.response.headers.get('x-request-id'); assert.ok(requestId);
    const until = Date.now() + 5000;
    for (;;) {
      const row = (await read.query<{ execution_state: string; financial_status: string; held: string }>(`SELECT execution_state,financial_status,
        (SELECT count(*)::text FROM saas_provider_account_leases WHERE tenant_id=$1 AND status='held') AS held
        FROM saas_requests WHERE tenant_id=$1 AND id=$2`, [tenantId, requestId])).rows[0];
      if (row?.execution_state === 'succeeded' && row.financial_status === 'settled' && row.held === '0') break;
      assert.ok(Date.now() < until, 'successful warm request must persist settlement'); await delay(10);
    }
  };
  const warm = async (secret: string) => {
    for (const gateway of input.gateways) await success(gateway, secret);
    const calls = sourceCount();
    for (const gateway of input.gateways) await success(gateway, secret);
    assert.equal(sourceCount(), calls, 'both default five-second authentication caches must be warm');
    assert.equal(source.size, 2, 'source calls must come from two separate real gateway KeyService instances');
  };
  const rejectBoth = async (secret: string, kind: 'prelock' | 'entitlement') => {
    const before = await snapshot(), calls = input.upstreamCalls(), authCalls = sourceCount(), denials = denied;
    for (const gateway of input.gateways) {
      const result = await post(gateway, secret);
      assert.equal(result.response.status, 403);
      assert.equal(result.body.error?.code, 'REQUEST_REJECTED');
      // An entitlement revocation is enforced either at the pre-admission
      // entitlement resolve (fresh read) or, when the warm entitlement
      // version-key cache served a stale allow, by the admission guard's
      // fresh in-transaction re-read — the final strong-consistency defense
      // line (D4/A2a §12.2: a stale epoch fails closed as a bounded
      // entitlement_denied at admission). Both are typed fail-closed 403s.
      const failure = gateway.failure();
      if (kind === 'entitlement') {
        assert.equal(failure?.code, 'entitlement_denied');
        assert.ok(failure?.stage === 'entitlement' || failure?.stage === 'admission',
          'entitlement revocation must be enforced at the fresh resolve or the admission guard (fail-closed)');
      } else {
        assert.deepEqual({ stage: failure?.stage, code: failure?.code }, { stage: 'admission', code: 'caller_denied' });
      }
    }
    assert.equal(sourceCount(), authCalls, 'revocation rejection must use the already cached authenticated snapshot');
    assert.equal(denied - denials, kind === 'prelock' ? 2 : 0, 'caller rejection must be the real authorization prelock refusal');
    assert.equal(input.upstreamCalls(), calls, 'revoked authority cannot reach the controlled upstream');
    assert.deepEqual(await snapshot(), before, 'rejected requests cannot create any financial, dispatch or retained lease effect');
  };
  const auditCount = async (action: string, target: string) => Number((await read.query<{ count: string }>('SELECT count(*)::text FROM saas_audit_events WHERE tenant_id=$1 AND actor_user_id=$2 AND action=$3 AND target_id=$4', [tenantId, actor.userId, action, target])).rows[0]!.count);
  const runScenario = async (name: string, work: () => Promise<void>) => {
    let failed = false, primary: unknown;
    await input.scenario(name, async () => {
      try { await work(); }
      catch (error) { failed = true; primary = error; throw error; }
    });
    if (failed) throw primary; // node:test records a failed child without necessarily rejecting t.test().
  };
  try {
    await runScenario('tenant suspension rejects warm authorization on both gateways and resume admits', async () => {
      await warm(keyA.secret);
      const lifecycle = new PlatformTenantLifecycleService(cp, { cursorSecret: 'test-only-authorization-cursor-0123456789' });
      const auditBefore = await auditCount('platform_tenant.suspended', tenantId);
      assert.equal((await lifecycle.setTenantStatus(actor, tenantId, 'suspend')).status, 'suspended');
      assert.equal(await auditCount('platform_tenant.suspended', tenantId), auditBefore + 1);
      await rejectBoth(keyA.secret, 'prelock');
      assert.equal((await lifecycle.setTenantStatus(actor, tenantId, 'resume')).status, 'active');
      for (const gateway of input.gateways) await success(gateway, keyA.secret);
    });
    await runScenario('key A revoke is enforced on both warm gateways while B still settles', async () => {
      await warm(keyA.secret);
      const before = (await cp.query<{ authz_version: string }>('SELECT authz_version::text FROM saas_api_keys WHERE id=$1 AND tenant_id=$2', [keyA.id, tenantId])).rows[0]!;
      const auditBefore = await auditCount('api_key.revoked', keyA.id);
      await keys.revoke(context, keyA.id);
      assert.equal(await auditCount('api_key.revoked', keyA.id), auditBefore + 1);
      const revoked = (await cp.query<{ status: string; authz_version: string }>('SELECT status,authz_version::text FROM saas_api_keys WHERE id=$1 AND tenant_id=$2', [keyA.id, tenantId])).rows[0]!;
      assert.equal(revoked.status, 'revoked'); assert.equal(BigInt(revoked.authz_version), BigInt(before.authz_version) + 1n);
      await rejectBoth(keyA.secret, 'prelock');
      for (const gateway of input.gateways) await success(gateway, keyB.secret);
    });
    await runScenario('P01 entitlement disable rejects both warm gateways with project policy active', async () => {
      await warm(keyB.secret);
      const before = (await cp.query<{ authz_version: string }>('SELECT authz_version::text FROM saas_project_entitlements WHERE id=$1 AND tenant_id=$2', [operation.entitlementId, tenantId])).rows[0]!;
      const auditBefore = await auditCount('platform_inference_access.disabled.risk_control', operation.id);
      const disabled = await service.disable({ operationId: operation.id, expectedEntitlementVersion: before.authz_version, reason: 'risk_control' }, { actor, audit: { ...audit, requestId: randomUUID() } });
      assert.equal(disabled.phase, 'disabled');
      assert.ok(disabled.entitlementAuthzVersion);
      assert.equal(BigInt(disabled.entitlementAuthzVersion), BigInt(before.authz_version) + 1n);
      assert.equal(await auditCount('platform_inference_access.disabled.risk_control', operation.id), auditBefore + 1);
      const state = (await cp.query<{ status: string; inference_policy_status: string }>('SELECT e.status,p.inference_policy_status FROM saas_project_entitlements e JOIN saas_projects p ON p.tenant_id=e.tenant_id AND p.id=e.project_id WHERE e.id=$1', [operation.entitlementId])).rows[0]!;
      assert.equal(state.status, 'disabled'); assert.equal(state.inference_policy_status, 'active');
      await rejectBoth(keyB.secret, 'entitlement');
    });
  } finally {
    KeyService.prototype.authenticate = originalAuthenticate;
    PostgresSaasRequestAdmissionAuthorizationPrelock.prototype.prelock = originalPrelock;
  }
}
