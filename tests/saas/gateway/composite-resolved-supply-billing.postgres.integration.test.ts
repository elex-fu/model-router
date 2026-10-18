import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import {
  type AdmissionCreateRequestInput,
  type SaasMeteringAdmissionPort,
  SaasRequestAdmissionService,
} from '../../../src/saas/gateway/admission.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock } from '../../../src/saas/gateway/authorization-prelock.js';
import { PostgresRequestAdmissionGuard } from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import type { CreateRequestInput, RequestAdmission } from '../../../src/saas/metering/types.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import {
  anyRoleConfigured,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';
import { ENDPOINT, raiseCapacityLimits } from './admission-bench-fixture.js';

/**
 * R3 §8.1 live gate: a COMPOSITE dispatch (billing-group route decision
 * swapping the nominal platform pin for a target platform) admits through the
 * production admission guard with:
 *
 * - the attempt's supplier cost version RESOLVED on the target platform's
 *   identity (the route's nominal cost version is never reused across
 *   platforms), and
 * - the customer price snapshot still bound to the route's NOMINAL identity
 *   (the public alias, customer price and request identity never drift).
 *
 * Runs on the disposable role-template E2E database only.
 */

const SUPPLY_SEALING = {
  deployment: 't04-composite-test',
  environment: 'test',
  kmsKeyId: 't04-synthetic-kms',
  sealingKms: {
    generateDataKey: async () => ({
      plaintextKey: Buffer.alloc(32, 0x57),
      ciphertextBlob: Buffer.from('t04-synthetic-dek'),
    }),
  },
} as const;

test('composite admission freezes the resolved supply identity and the nominal customer identity', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to run the composite supply identity gate`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = observedDatabase(urls[0]);
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.database.close(), gateway.close()]);
  });
  await gateway.verifySchema();

  const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
  const projectPolicyVersion = await phase('capacity', () => raiseCapacityLimits(migrator.database, fixture));

  /*
   * Composite-side seeding: the target platform the composite decision
   * routes to. Everything runs as the migrator role through the production
   * services (catalog, supply, pricing) — no hand-written authority rows.
   */
  const label = randomUUID();
  const target = {
    providerId: `t04-target-provider-${label}`,
    productId: `t04-target-product-${label}`,
    model: `t04-target-model-${label}`,
    endpoint: `t04-target-endpoint-${label}`,
    accountId: `t04-target-account-${label}`,
    credentialId: `t04-target-credential-${label}`,
  };
  const effectiveAt = new Date(Date.now() - 60_000).toISOString();
  const now = new Date().toISOString();
  const audit = { actorUserId: fixture.userId, entryPoint: 't04-composite-gate', requestId: randomUUID() };

  const { SaasCatalogService } = await import('../../../src/saas/catalog/service.js');
  const catalog = new SaasCatalogService(migrator.database);
  await phase('target-catalog', async () => {
    await catalog.registerProviderProduct({
      providerId: target.providerId,
      productId: target.productId,
      displayName: 'T04 composite target product',
    });
    await catalog.registerProviderCapability({
      providerId: target.providerId,
      productId: target.productId,
      model: target.model,
      endpoint: target.endpoint,
      protocol: 'openai',
      supportLevel: 'supported',
      validationState: 'verified',
      evidenceVersion: 't04-target-v1',
      discoverySource: 'manual',
      evidenceReference: `t04-target-capability-${label}`,
      evidenceSha256: 'a'.repeat(64),
    });
  });
  const rights = await phase('target-rights', () =>
    catalog.registerProviderRightsVersion({
      rightsId: `t04-target-rights-${label}`,
      providerId: target.providerId,
      productId: target.productId,
      credentialType: 'api-key',
      supplyMode: 'platform',
      region: 'test',
      purpose: 'inference',
      modelScope: [target.model],
      endpointScope: [target.endpoint],
      effectiveAt,
      approvalReference: `t04-target-approval-${label}`,
      status: 'active',
      evidenceReference: `t04-target-rights-${label}`,
      evidenceSha256: 'b'.repeat(64),
      audit,
    }),
  );
  const capability = (
    await migrator.database.query<{ capability_version: string }>(
      'SELECT version::text AS capability_version FROM saas_provider_capabilities WHERE provider_id = $1 AND product_id = $2 AND model = $3 AND endpoint = $4 LIMIT 1',
      [target.providerId, target.productId, target.model, target.endpoint],
    )
  ).rows[0];
  if (!capability) throw new Error('target capability must be registered');

  const repository = new PostgresProviderSupplyRepository(migrator.database);
  const platformOwner = { ownerKind: 'platform' as const, tenantId: null, supplyMode: 'platform' as const };
  const account = await phase('target-account', () =>
    repository.createAccount({
      owner: platformOwner,
      id: target.accountId,
      displayName: 'T04 composite target account',
      providerId: target.providerId,
      productId: target.productId,
      credentialType: 'api-key',
      region: 'test',
      purpose: 'inference',
      rightsId: rights.rightsId,
      rightsVersion: rights.version,
      capabilities: [
        { model: target.model, endpoint: target.endpoint, version: Number(capability.capability_version) },
      ],
      status: 'active',
      validationState: 'verified',
      priority: 0,
      weight: 1,
      revalidationIntervalSeconds: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await phase('target-credential', async () => {
    await repository.createCredential({
      owner: platformOwner,
      id: target.credentialId,
      accountId: target.accountId,
      providerId: target.providerId,
      productId: target.productId,
      credentialType: 'api-key',
      status: 'pending',
      validationState: 'unverified',
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const envelope = await sealProviderCredential(
      Buffer.from('t04-synthetic-provider-key'),
      createProviderCredentialContext({
        ...platformOwner,
        deployment: 't04-composite-test',
        environment: 'test',
        purpose: 'inference',
        providerId: target.providerId,
        productId: target.productId,
        accountId: target.accountId,
        credentialId: target.credentialId,
        credentialVersion: 1,
        credentialType: 'api-key',
      }),
      SUPPLY_SEALING.sealingKms,
      't04-synthetic-kms',
    );
    await repository.appendCredentialVersion({
      credential: {
        ownerKind: 'platform',
        tenantId: null,
        accountId: target.accountId,
        credentialId: target.credentialId,
        version: 1,
      },
      providerId: target.providerId,
      productId: target.productId,
      envelope,
      kmsPurpose: 'inference',
      wrappingRevision: 1,
      expectedCurrentVersion: null,
      createdAt: now,
      expiresAt: null,
    });
    // The fixture's setup-only validation CAS (never run as the gateway role).
    const result = await migrator.database.query(
      `UPDATE saas_platform_provider_credentials
          SET validation_state = 'verified', validation_error_code = NULL,
              last_validated_at = $1, status = 'active', updated_at = $1, authz_version = authz_version + 1
        WHERE account_id = $2 AND id = $3`,
      [now, target.accountId, target.credentialId],
    );
    assert.equal(result.rowCount, 1, 'target credential validation must win its SQL CAS');
  });
  const credentialRow = (
    await migrator.database.query<{ authz_version: string; current_version: string }>(
      'SELECT authz_version::text AS authz_version, current_version::text AS current_version FROM saas_platform_provider_credentials WHERE account_id = $1 AND id = $2',
      [target.accountId, target.credentialId],
    )
  ).rows[0];
  if (!credentialRow) throw new Error('target credential row must exist');

  /*
   * The composite candidate serves on the ROUTE's upstream pool — for a
   * composite dispatch that pool belongs to the target platform, so it is
   * created with the route upstream id and the target identity.
   */
  const routeUpstreamId = fixture.sent.upstreamId;
  if (routeUpstreamId === null) throw new Error('seeded route upstream must exist');
  const supply = new ProviderSupplyService(migrator.database, SUPPLY_SEALING);
  const pool = await phase('target-pool', () =>
    supply.createPlatformProviderPool({
      id: routeUpstreamId,
      displayName: 'T04 composite target pool',
      providerId: target.providerId,
      productId: target.productId,
      credentialType: 'api-key',
      region: 'test',
      purpose: 'inference',
      rightsId: rights.rightsId,
      rightsVersion: rights.version,
      capabilities: [
        { model: target.model, endpoint: target.endpoint, version: Number(capability.capability_version) },
      ],
      status: 'active',
      validationState: 'verified',
    }),
  );
  await phase('target-pool-member', () =>
    supply.addPlatformPoolMember({
      poolId: pool.id,
      accountId: target.accountId,
      expectedAccountAuthzVersion: account.authzVersion,
    }),
  );
  const grant = await phase('target-grant', () =>
    supply.grantPlatformPoolToProfile({
      poolId: pool.id,
      tenantId: fixture.tenantId,
      supplyProfileId: fixture.profileId,
      evidenceReference: `t04-target-grant-${label}`,
      evidenceSha256: 'd'.repeat(64),
    }),
  );

  /*
   * The supplier cost version for the TARGET identity, registered under the
   * route's public model with the target platform's provider/product/model
   * and the composite target endpoint (§8.1's resolved supply chain).
   */
  const pricing = new SaasPricingService(migrator.database);
  const targetCost = await phase('target-cost', () =>
    pricing.appendSupplierCostVersion({
      publicModelId: fixture.sent.routePublicModelId as string,
      publicModelVersion: Number(fixture.sent.routePublicModelVersion as string),
      providerId: target.providerId,
      productId: target.productId,
      resolvedModel: target.model,
      protocol: 'openai',
      endpoint: target.endpoint,
      currency: 'USD',
      commercialPolicyVersion: 't04-commercial-v1',
      calculatorVersion: 't04-calculator-v1',
      roundingVersion: 't04-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      effectiveAt,
      idempotencyKey: `t04-target-cost-${label}`,
      rates: {
        input: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        output: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_read: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write_5m: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write_1h: { numeratorMinorUnits: 1, denominatorUnits: 1 },
      },
    }),
  );

  /*
   * The composite admission command: the request carries the resolved
   * composite decision (target platform, target endpoint), the attempt
   * serves on the target identity with the RESOLVED cost version, and the
   * customer price version stays the route's nominal registration.
   */
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const labelCommand = `t04-${requestId}`;
  const sent = fixture.sent;
  const alias = `fin057-alias-${(sent.routePublicModelId as string).split('-').pop()}`;
  const persistedModel = (
    await gateway.query<{ alias: string }>('SELECT alias FROM saas_public_models WHERE id = $1', [
      sent.routePublicModelId,
    ])
  ).rows[0];
  if (!persistedModel?.alias) throw new Error('seeded public model alias must exist');
  const requestModel = persistedModel.alias;
  const fingerprint = sha256Hex(`t04-composite:${labelCommand}`);
  const payloadSha256 = sha256Hex(`t04-composite-payload:${labelCommand}`);
  const compositeRoute = {
    billingGroupId: 'default',
    source: 'route' as const,
    routeId: sent.routeConfigId as string,
    targetPlatform: target.providerId,
    productId: target.productId,
    upstreamModel: target.model,
    endpoint: target.endpoint,
  };
  const command = {
    supplyMode: 'platform' as const,
    request: {
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      proxyKeyId: fixture.keyId,
      entitlementId: fixture.entitlementId,
      supplyProfileId: fixture.profileId,
      supplyProfileVersion: 1,
      modelScopeVersion: 1,
      supplyMode: 'platform' as const,
      principalKind: 'member' as const,
      principalId: fixture.userId,
      authzVersion: 1,
      entitlementVersion: 1,
      configVersion: Number(sent.routeConfigVersion as string),
      projectPolicyVersion: Number(projectPolicyVersion),
      routeConfigId: sent.routeConfigId,
      routeConfigVersion: Number(sent.routeConfigVersion as string),
      routePublicModelId: sent.routePublicModelId,
      routePublicModelVersion: Number(sent.routePublicModelVersion as string),
      routeProtocol: sent.routeProtocol,
      routeTargetMode: sent.routeTargetMode,
      routeUpstreamId,
      customerMeteringPolicyId: sent.customerMeteringPolicyId,
      customerMeteringPolicyVersion: Number(sent.customerMeteringPolicyVersion as string),
      providerMeteringPolicyId: sent.providerMeteringPolicyId,
      providerMeteringPolicyVersion: Number(sent.providerMeteringPolicyVersion as string),
      contractAttestationId: sent.contractAttestationId,
      publicModel: requestModel,
      protocol: 'openai' as const,
      endpoint: target.endpoint,
      compositeRoute,
      requestFingerprint: fingerprint,
      requestFingerprintVersion: 'canonical-v1',
      customerPriceVersion: sent.customerPriceVersion,
      initialAttempt: {
        ordinal: 1,
        upstreamId: routeUpstreamId,
        accountId: target.accountId,
        providerId: target.providerId,
        productId: target.productId,
        resolvedModel: target.model,
        protocol: 'openai' as const,
        endpoint: target.endpoint,
        supplierCostVersion: targetCost.id,
        dispatchProfileId: sent.dispatchProfileId,
        supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
        credentialId: target.credentialId,
        credentialVersion: Number(credentialRow.current_version),
        credentialAuthzVersion: Number(credentialRow.authz_version),
        accountAuthzVersion: account.authzVersion,
        projectPolicyVersion: Number(projectPolicyVersion),
        routeConfigId: sent.routeConfigId,
        routeConfigVersion: Number(sent.routeConfigVersion as string),
        routePublicModelId: sent.routePublicModelId,
        routePublicModelVersion: Number(sent.routePublicModelVersion as string),
        routeProtocol: sent.routeProtocol,
        routeTargetMode: sent.routeTargetMode,
        customerMeteringPolicyId: sent.customerMeteringPolicyId,
        customerMeteringPolicyVersion: Number(sent.customerMeteringPolicyVersion as string),
        providerMeteringPolicyId: sent.providerMeteringPolicyId,
        providerMeteringPolicyVersion: Number(sent.providerMeteringPolicyVersion as string),
        contractAttestationId: sent.contractAttestationId,
        customerPriceVersion: sent.customerPriceVersion,
        accountOwnerKind: 'platform' as const,
        poolId: pool.id,
        poolAuthzVersion: pool.authzVersion,
        poolMemberAccountAuthzVersion: account.authzVersion,
        poolMemberAuthzVersion: 1,
        poolGrantAuthzVersion: grant.authzVersion,
        poolGrantProfileAuthzVersion: grant.profileAuthzVersion,
        poolGrantPoolAuthzVersion: grant.poolAuthzVersion,
        modelResolution: {
          requestedModel: requestModel,
          mappedModel: target.model,
          resolvedModel: target.model,
          mappingSource: 'alias' as const,
          mappingVersion: 1,
        },
        clientProtocol: 'openai' as const,
        providerProtocol: 'openai' as const,
        clientOperation: 'chat.completions',
        providerOperation: 'chat.completions',
        requestFingerprint: fingerprint,
        requestFingerprintVersion: 'canonical-v1',
        payloadSha256,
        payloadCompilerVersion: 't04-compiler-v1',
        usageEstimatorVersion: 't04-estimator-v1',
      },
    },
    authenticatedKey: {
      authorization: {
        keyId: fixture.keyId,
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        principalKind: 'member' as const,
        principalId: fixture.userId,
        entitlementId: fixture.entitlementId,
        supplyProfileId: fixture.profileId,
        supplyMode: 'platform' as const,
        modelScopes: [requestModel],
        authzVersion: 1,
        modelScopeVersion: 1,
        entitlementAuthzVersion: 1,
        supplyProfileAuthzVersion: 1,
      },
    },
    holdEvidence: {
      inputTotal: 1,
      inputUncached: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      outputTotal: 1,
      reasoningOutput: 0,
      admissionExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  };

  const guard = new PostgresRequestAdmissionGuard(gateway);
  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();
  const meteringPort: SaasMeteringAdmissionPort = {
    async admitRequest(input: CreateRequestInput, options = {}) {
      if (!options.executor) throw new Error('caller transaction is required');
      return (await fixture.metering.admitPreparedRequest(input, {
        requestId,
        attemptId,
        executor: options.executor,
      })) as RequestAdmission;
    },
  };
  const service = new SaasRequestAdmissionService(gateway, meteringPort, fixture.billing, guard, prelock, {
    idFactory: randomUUID,
  });

  const admitted = await phase('composite-admission', () =>
    gateway.transaction(async (executor) =>
      service.admit(command as unknown as AdmissionCreateRequestInput, { executor }),
    ),
  );

  assert.equal(admitted.kind, 'created', 'the composite admission must create fresh request/attempt rows');
  if (admitted.kind !== 'created') return;

  // §8.1: the admission reserved a wallet hold against the customer price
  // snapshot; validateGuardResult already enforced that the guard's
  // supplierCostVersion fact equals the attempt's RESOLVED version.
  assert.ok(admitted.reservation, 'the composite admission must reserve a platform hold');

  // §8.1: the durable attempt serves on the resolved target identity.
  const attemptRow = (
    await gateway.query<{
      provider_id: string | null;
      product_id: string | null;
      resolved_model: string;
      supplier_cost_version: string | null;
      endpoint: string | null;
    }>(
      'SELECT provider_id, product_id, resolved_model, supplier_cost_version, endpoint FROM saas_attempts WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, attemptId],
    )
  ).rows[0];
  assert.ok(attemptRow, 'the composite attempt row must exist');
  assert.equal(attemptRow.provider_id, target.providerId);
  assert.equal(attemptRow.product_id, target.productId);
  assert.equal(attemptRow.resolved_model, target.model);
  assert.equal(attemptRow.endpoint, target.endpoint);
  assert.equal(attemptRow.supplier_cost_version, targetCost.id);

  // §8.1: the customer price snapshot stays on the route's NOMINAL identity —
  // the customer price never follows the internal platform switch.
  const snapshotRow = (
    await gateway.query<{ provider_id: string; product_id: string; endpoint: string; customer_price_version: string }>(
      'SELECT provider_id, product_id, endpoint, customer_price_version FROM saas_request_customer_price_snapshots WHERE tenant_id = $1 AND request_id = $2',
      [fixture.tenantId, requestId],
    )
  ).rows[0];
  assert.ok(snapshotRow, 'the composite customer price snapshot must exist');
  assert.equal(snapshotRow.customer_price_version, sent.customerPriceVersion);
  assert.equal(snapshotRow.provider_id, sent.providerId);
  assert.equal(snapshotRow.product_id, sent.productId);
  assert.equal(snapshotRow.endpoint, ENDPOINT);
  assert.notEqual(snapshotRow.provider_id, target.providerId);
  void alias;
});
