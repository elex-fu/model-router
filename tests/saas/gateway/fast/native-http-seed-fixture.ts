// Independent fresh-database fixture adapted from the official current-R9 seed.
// No historical HTTP fixture, runtime-health seed, legacy request or evidence fabrication.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import type { ProviderEnvironment } from '../../../../src/saas/runtime/providers.js';
import type { NativeFastHttpRoute } from './native-http-runtime-fixture.js';

export async function seedNativeFastHttpInventory(
  database: SaasDatabase,
  kmsEnv: ProviderEnvironment,
  maxConcurrency: 64 | 256 = 64,
) {
  assert.ok(maxConcurrency === 64 || maxConcurrency === 256, 'known native fixture concurrency');
  const { SaasIdentityService } = await import('../../../../src/saas/identity/service.js');
  const { SaasCatalogService } = await import('../../../../src/saas/catalog/service.js');
  const { SaasProjectInferencePolicyService } = await import('../../../../src/saas/gateway/project-policy-service.js');
  const { SaasPricingService } = await import('../../../../src/saas/pricing/service.js');
  const { SaasCommercialMeteringPolicyService, canonicalContractAttestationPayload } = await import(
    '../../../../src/saas/gateway/commercial-metering-policy-service.js'
  );
  const { SaasRouteConfigService } = await import('../../../../src/saas/gateway/route-config-service.js');
  const { ProviderSupplyService } = await import('../../../../src/saas/supply/service.js');
  const { createProviderCredentialSealingKms } = await import(
    '../../../../src/saas/runtime/software-provider-credential-kms.js'
  );
  const { KeyService } = await import('../../../../src/saas/keys/service.js');
  const { PostgresSupplyProfileResolver } = await import('../../../../src/saas/keys/resolver.js');
  const { PlatformWalletLedgerService } = await import('../../../../src/saas/billing/service.js');
  await database.verifySchema();
  assert.equal(
    (await database.query<{ fsync: string }>('SHOW fsync')).rows[0]?.fsync,
    'on',
    'R9 must retain PostgreSQL durable writes',
  );
  assert.equal(
    (await database.query<{ synchronous_commit: string }>('SHOW synchronous_commit')).rows[0]?.synchronous_commit,
    'on',
    'R9 must retain synchronous commits',
  );
  const identity = new SaasIdentityService(database);
  const bootstrap = await identity.issueBootstrapToken();
  const admin = await identity.bootstrapPlatformAdmin({
    token: bootstrap.token,
    email: `r9-${randomUUID()}@example.test`,
    displayName: 'Disposable R9 test fixture',
    password: `${randomUUID()}-Local-Test!`,
  });
  const tenant = await identity.createTenant(admin.id, {
    name: 'Disposable R9 test assembly',
    slug: `r9-${randomUUID()}`,
  });
  const project = await identity.createProject(admin.id, tenant.id, {
    name: 'R9 current build',
    slug: `r9-${randomUUID()}`,
  });
  const context = await identity.resolveTenantContext({ userId: admin.id, tenantId: tenant.id, projectId: project.id });
  const audit = { actorUserId: admin.id, requestId: randomUUID(), entryPoint: 'r9-mock-test-migrator-fixture' };
  const policy = await new SaasProjectInferencePolicyService(database).enable({
    tenantId: tenant.id,
    projectId: project.id,
    expectedVersion: 1,
    audit,
  });
  const profileId = `r9-profile-${randomUUID()}`;
  const models = ['native-fast-ci-model'];
  const now = new Date();
  const effectiveAt = new Date(now.getTime() - 60000).toISOString();
  await database.query(
    `INSERT INTO saas_supply_profiles(tenant_id,id,supply_mode,status,model_scopes,authz_version,created_at,updated_at,last_audited_at)
    VALUES($1,$2,'platform','active',$3,1,$4,$4,$4)`,
    [tenant.id, profileId, models, now.toISOString()],
  );
  await database.query(
    `INSERT INTO saas_project_entitlements(id,tenant_id,project_id,supply_profile_id,supply_mode,status,model_scopes,authz_version,created_at,updated_at,last_audited_at,effective_at,expires_at,source_type)
    VALUES($1,$2,$3,$4,'platform','active',$5,1,$6,$6,$6,$7,$8,'admin_grant')`,
    [
      randomUUID(),
      tenant.id,
      project.id,
      profileId,
      models,
      now.toISOString(),
      effectiveAt,
      new Date(now.getTime() + 86400000).toISOString(),
    ],
  );
  const catalog = new SaasCatalogService(database);
  const pricing = new SaasPricingService(database);
  const sealing = await createProviderCredentialSealingKms({ env: kmsEnv });
  const supply = new ProviderSupplyService(database, {
    deployment: 'r9-current-test',
    environment: 'test',
    kmsKeyId: 'r9-local-test',
    sealingKms: sealing,
  });
  const contractKeys = generateKeyPairSync('ed25519');
  const commercial = new SaasCommercialMeteringPolicyService(database, {
    trustedVerifierPublicKeys: new Map([['r9-contract-local-test', contractKeys.publicKey]]),
    trustedTestVectorDigests: new Map([['r9-local-test-v1', 'c'.repeat(64)]]),
  });
  const routes = new SaasRouteConfigService(database);
  const inventory: NativeFastHttpRoute[] = [];
  for (const protocol of ['openai'] as const) {
    const providerId = `r9-mock-${protocol}`;
    const productId = `r9-product-${protocol}`;
    const providerModel = `r9-provider-model-${protocol}`;
    const publicModelId = `r9-public-model-${protocol}`;
    const publicModel = 'native-fast-ci-model';
    const endpoint = '/v1/chat/completions';
    const poolId = `r9-pool-${protocol}`;
    await catalog.registerProviderProduct({ providerId, productId, displayName: `R9 ${protocol} MOCK TEST` });
    await catalog.registerPublicModelAlias({
      publicModelId,
      alias: publicModel,
      displayName: 'R9 mock model',
      providerId,
      productId,
      model: providerModel,
      endpointScope: [endpoint],
    });
    const capability = await catalog.registerProviderCapability({
      providerId,
      productId,
      model: providerModel,
      endpoint,
      protocol,
      supportLevel: 'supported',
      validationState: 'verified',
      evidenceVersion: 'r9-test-v1',
      discoverySource: 'manual',
      evidenceReference: 'mock-test-only',
      evidenceSha256: 'a'.repeat(64),
    });
    const rights = await catalog.registerProviderRightsVersion({
      rightsId: `r9-rights-${protocol}`,
      providerId,
      productId,
      credentialType: 'api-key',
      supplyMode: 'platform',
      region: 'r9-test',
      purpose: 'inference',
      modelScope: [providerModel],
      endpointScope: [endpoint],
      effectiveAt,
      approvalReference: 'mock-test-only',
      status: 'active',
      evidenceReference: 'mock-test-only',
      evidenceSha256: 'b'.repeat(64),
      audit,
    });
    const common = {
      publicModelId,
      publicModelVersion: 1,
      providerId,
      productId,
      protocol,
      endpoint,
      currency: 'USD',
      commercialPolicyVersion: `r9-commercial-${protocol}`,
      calculatorVersion: 'r9-test-v1',
      roundingVersion: 'r9-test-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      effectiveAt,
    } as const;
    const rates = (input: number, output: number) =>
      Object.fromEntries(
        ['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'output'].map((dimension) => [
          dimension,
          { numeratorMinorUnits: dimension === 'output' ? output : input, denominatorUnits: 1 },
        ]),
      );
    const price = await pricing.appendCustomerPriceVersion({
      ...common,
      rates: rates(2, 3),
      idempotencyKey: `r9-price-${protocol}`,
    });
    const cost = await pricing.appendSupplierCostVersion({
      ...common,
      resolvedModel: providerModel,
      rates: rates(1, 1),
      idempotencyKey: `r9-cost-${protocol}`,
    });
    const customerDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol,
      endpoint,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      customerPriceVersion: price.id,
      usageDimensions: ['input_total', 'output_total'],
      tokenSource: 'upstream',
      roundingVersion: 'r9-test-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      commercialPolicyVersion: common.commercialPolicyVersion,
    } as const;
    const providerDefinition = {
      ...customerDefinition,
      providerId,
      productId,
      resolvedModel: providerModel,
      supplierCostVersion: cost.id,
    };
    const customerPolicyId = `r9-customer-policy-${protocol}`;
    const providerPolicyId = `r9-provider-policy-${protocol}`;
    const scope = { tenantId: tenant.id, projectId: project.id, audit };
    await commercial.createCustomerPolicy({ ...scope, policyId: customerPolicyId, definition: customerDefinition });
    await commercial.createProviderPolicy({ ...scope, policyId: providerPolicyId, definition: providerDefinition });
    const cp = await commercial.publishCustomerPolicy({
      ...scope,
      policyId: customerPolicyId,
      expectedVersion: 1,
      definition: customerDefinition,
    });
    const pp = await commercial.publishProviderPolicy({
      ...scope,
      policyId: providerPolicyId,
      expectedVersion: 1,
      definition: providerDefinition,
    });
    const attestation = {
      contractDigest: 'd'.repeat(64),
      suiteVersion: 'r9-local-test-v1',
      testVectorDigest: 'c'.repeat(64),
      providerPolicyId,
      providerPolicyVersion: pp.version,
      publicModelId,
      publicModelVersion: '1',
      protocol,
      endpoint,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      usageDimensions: customerDefinition.usageDimensions,
      tokenSource: 'upstream',
      roundingVersion: 'r9-test-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
    } as const;
    const attestationId = `r9-attestation-${protocol}`;
    await commercial.attestProviderContract({
      ...scope,
      id: attestationId,
      ...attestation,
      publicModelVersion: 1,
      verifierKeyId: 'r9-contract-local-test',
      signatureBase64: sign(
        null,
        Buffer.from(canonicalContractAttestationPayload(attestation)),
        contractKeys.privateKey,
      ).toString('base64'),
    });
    const definition = {
      publicModelId,
      publicModelVersion: 1,
      protocol,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      upstreamId: poolId,
      endpoint,
    } as const;
    const routeId = `r9-route-${protocol}`;
    await routes.create({ ...scope, routeId, definition });
    const published = await routes.publish({ ...scope, routeId, expectedVersion: 1, definition });
    await commercial.bindRoute({
      ...scope,
      routeId,
      routeVersion: published.version,
      customerPolicyId,
      customerPolicyVersion: cp.version,
      providerPolicyId,
      providerPolicyVersion: pp.version,
      contractAttestationId: attestationId,
    });
    const accountIds = [];
    for (let index = 1; index <= 2; index += 1) {
      const accountId = `r9-${protocol}-account-${index}`;
      const account = await supply.createPlatformProviderAccount({
        id: accountId,
        displayName: 'R9 synthetic mock account',
        providerId,
        productId,
        credentialType: 'api-key',
        region: 'r9-test',
        purpose: 'inference',
        rightsId: rights.rightsId,
        rightsVersion: rights.version,
        capabilities: [{ model: providerModel, endpoint, version: capability.version }],
        audit,
      });
      const active = await supply.setProviderAccountValidation({
        accountId,
        validationState: 'verified',
        expectedAuthzVersion: account.authzVersion,
      });
      const secret = Buffer.from(accountId);
      let credential: Awaited<ReturnType<typeof supply.createPlatformProviderCredential>>;
      try {
        credential = await supply.createPlatformProviderCredential({ accountId, secret, audit });
      } finally {
        secret.fill(0);
      }
      // Deliberate mock fixture validation; no real provider or worker starts.
      await database.query(
        `UPDATE saas_platform_provider_credentials SET status='active',validation_state='verified',validation_error_code=NULL,last_validated_at=clock_timestamp(),updated_at=clock_timestamp(),authz_version=authz_version+1 WHERE account_id=$1 AND id=$2 AND authz_version=$3`,
        [accountId, credential.credential.id, credential.credential.authzVersion],
      );
      accountIds.push({ id: accountId, authzVersion: active.authzVersion });
    }
    await supply.createPlatformProviderPool({
      id: poolId,
      displayName: 'R9 mock pool',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'r9-test',
      purpose: 'inference',
      rightsId: rights.rightsId,
      rightsVersion: rights.version,
      capabilities: [{ model: providerModel, endpoint, version: capability.version }],
      status: 'active',
      validationState: 'verified',
    });
    for (const account of accountIds)
      await supply.addPlatformPoolMember({
        poolId,
        accountId: account.id,
        expectedAccountAuthzVersion: account.authzVersion,
      });
    await supply.grantPlatformPoolToProfile({
      poolId,
      tenantId: tenant.id,
      supplyProfileId: profileId,
      evidenceReference: 'r9-mock-grant',
      evidenceSha256: 'e'.repeat(64),
    });
    inventory.push({
      protocol,
      providerId,
      productId,
      providerModel,
      publicModel,
      endpoint,
      poolId,
      accountIds: accountIds.map((account) => account.id),
    });
  }
  await sealing.close();
  const key = await new KeyService(database, { resolver: new PostgresSupplyProfileResolver(database) }).create(
    context,
    { name: 'Disposable R9 test key', modelScopes: models, supplyMode: 'platform' },
  );
  const nextVersion = (BigInt(policy.version) + 1n).toString();
  await database.transaction(async (executor) => {
    await executor.query(
      `UPDATE saas_tenants SET requests_per_minute=600000,tokens_per_minute=600000000,max_concurrent_requests=$2 WHERE id=$1`,
      [tenant.id, maxConcurrency],
    );
    await executor.query(
      `INSERT INTO saas_project_inference_policy_versions(tenant_id,project_id,version,status,changed_by_user_id,created_at,requests_per_minute,tokens_per_minute,max_concurrent_requests)
      SELECT tenant_id,project_id,$3,status,$4,clock_timestamp(),600000,600000000,$6 FROM saas_project_inference_policy_versions WHERE tenant_id=$1 AND project_id=$2 AND version=$5`,
      [tenant.id, project.id, nextVersion, admin.id, policy.version, maxConcurrency],
    );
    await executor.query(
      'UPDATE saas_projects SET inference_policy_version=$3 WHERE tenant_id=$1 AND id=$2 AND inference_policy_version=$4',
      [tenant.id, project.id, nextVersion, policy.version],
    );
    await executor.query(
      'UPDATE saas_api_keys SET requests_per_minute=600000,tokens_per_minute=600000000,max_concurrent_requests=$3,authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2',
      [tenant.id, key.id, maxConcurrency],
    );
    await new PlatformWalletLedgerService().postVerifiedFunding(executor, {
      tenantId: tenant.id,
      currency: 'USD',
      amountMinorUnits: '100000000000',
      sourceOrderRef: 'r9-mock-funding',
      idempotencyKey: 'r9-mock-funding',
      metadataRef: 'r9-no-real-payment',
    });
  });
  return { tenantId: tenant.id, projectId: project.id, keyId: key.id, key: key.secret, inventory };
}
