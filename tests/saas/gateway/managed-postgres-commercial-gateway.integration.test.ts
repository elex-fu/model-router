import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetch as undiciFetch } from 'undici';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import {
  createProviderCredentialContext,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import {
  DEPLOYMENT_ENV_VARS,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_DEPLOYMENT_ID,
  MODEL_ROUTER_SAAS_ENVIRONMENT_ID,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE,
  MODEL_ROUTER_SAAS_KMS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_PROVIDER,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  parseDeploymentConfig,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../../../src/saas/deployment.js';
import {
  type CustomerMeteringPolicyDefinition,
  canonicalContractAttestationPayload,
  type ProviderMeteringPolicyDefinition,
  SaasCommercialMeteringPolicyService,
} from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { PreparedRequestEvidenceRecord } from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { SaasProjectInferencePolicyService } from '../../../src/saas/gateway/project-policy-service.js';
import { PostgresProviderAccountLeaseService } from '../../../src/saas/gateway/provider-account-lease-service.js';
import { createProviderHttpTestAddressCapability } from '../../../src/saas/gateway/provider-http-address.js';
import {
  allowRequestPreparation,
  type RequestPreparationEntitlementPort,
  rejectRequestPreparation,
} from '../../../src/saas/gateway/request-preparation-service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import { PostgresSupplyProfileResolver } from '../../../src/saas/keys/resolver.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import { ByokServicePlanService } from '../../../src/saas/plans/service.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import type {
  ManagedSaasGatewayRuntimeDependencies,
  ManagedSaasGatewayRuntimeModuleOptions,
} from '../../../src/saas/runtime/gateway-runtime-module.js';
import { TrustedPreparedRequestVerifierKeyRegistry } from '../../../src/saas/runtime/prepared-evidence-verifier-keys.js';
import { PreparedRequestEvidenceSigner } from '../../../src/saas/runtime/prepared-request-evidence-signer.js';
import { createProviderTargetResolver } from '../../../src/saas/runtime/provider-target-resolver.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import type { ProviderSupplyOwner } from '../../../src/saas/supply/types.js';
import type { ManagedSaasRuntime } from '../../../src/server/managed-saas.js';
import { SAAS_PLATFORM_AUDIT_CURSOR_SECRET, startManagedSaasServer } from '../../../src/server/managed-saas.js';

const REQUIRED_FLAG = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const MIGRATOR_URL = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL';
const CONTROL_PLANE_URL = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL';
const GATEWAY_URL = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL';
const ENDPOINT = '/v1/chat/completions';
const PROVIDER_SECRET = 'gateway-e2e-provider-secret';
const PLATFORM_PROVIDER_SECRET = 'gateway-e2e-platform-provider-secret';
const DEK = new Uint8Array(32).fill(0x37);
const usageBounds = {
  inputTotalUpperBound: 16,
  inputUncachedUpperBound: 16,
  cacheReadUpperBound: 0,
  cacheWriteUpperBound: 0,
  cacheWrite5mUpperBound: 0,
  cacheWrite1hUpperBound: 0,
  outputTotalUpperBound: 16,
  reasoningOutputUpperBound: 0,
  feasibleInputBuckets: ['input'],
} as const;

const roleUrls = {
  migrator: process.env[MIGRATOR_URL],
  controlPlane: process.env[CONTROL_PLANE_URL],
  gateway: process.env[GATEWAY_URL],
};
const hasAllRoleUrls = Object.values(roleUrls).every((value) => typeof value === 'string' && value.trim() !== '');

async function freeLocalPort(used: Set<number>): Promise<number> {
  for (;;) {
    const reservation = createNetServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('could not reserve a local test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error ? reject(error) : resolve()));
    });
    if (!used.has(port)) {
      used.add(port);
      return port;
    }
  }
}

async function closeHttpServer(server: { close(callback: (error?: Error) => void): unknown; listening: boolean }) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listenerEnvironment(name: 'customer' | 'platform' | 'gateway', port: number) {
  const config = DEPLOYMENT_ENV_VARS.listeners[name];
  return {
    [config.bindAddress]: '127.0.0.1',
    [config.port]: String(port),
    [config.origin]: `http://127.0.0.1:${port}`,
  };
}

function assertRoleUrl(name: string, value: string | undefined, username: string): asserts value is string {
  assert.equal(typeof value, 'string', `${name} is required when the real gateway E2E gate is enabled`);
  if (typeof value !== 'string') return;
  const parsed = new URL(value);
  assert.ok(parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:', `${name} must be PostgreSQL`);
  assert.equal(decodeURIComponent(parsed.username), username, `${name} must connect as ${username}`);
}

async function walletSnapshot(database: ReturnType<typeof createSaasDatabase>, tenantId: string) {
  const result = await database.query<{
    wallets: string;
    wallet_balance: string;
    billing_reservations: string;
    ledger_transactions: string;
    ledger_entries: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM saas_wallets WHERE tenant_id = $1) AS wallets,
       (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS wallet_balance,
       (SELECT count(*)::text FROM saas_billing_reservations WHERE tenant_id = $1) AS billing_reservations,
       (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id = $1) AS ledger_transactions,
       (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS ledger_entries`,
    [tenantId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

test('real PostgreSQL commercial gateway E2E launches managed control-plane and gateway runtimes and pins local HTTPS upstream', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !hasAllRoleUrls
      ? `set ${REQUIRED_FLAG}=1 and the three role URLs to require the live PostgreSQL gate`
      : false,
}, async () => {
  assertRoleUrl(MIGRATOR_URL, roleUrls.migrator, 'model_router_saas_migrator');
  assertRoleUrl(CONTROL_PLANE_URL, roleUrls.controlPlane, 'model_router_saas_control_plane');
  assertRoleUrl(GATEWAY_URL, roleUrls.gateway, 'model_router_saas_gateway');

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let tempDirectory: string | undefined;
  let upstream: HttpsServer | undefined;
  let controlPlaneRuntime: ManagedSaasRuntime | undefined;
  let gatewayRuntime: ManagedSaasRuntime | undefined;
  let seedDatabase: ReturnType<typeof createSaasDatabase> | undefined;
  let controlPlaneProbe: ReturnType<typeof createSaasDatabase> | undefined;
  let gatewayProbe: ReturnType<typeof createSaasDatabase> | undefined;

  try {
    const migration = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migrate'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MODEL_ROUTER_SAAS_DATABASE_URL: roleUrls.migrator,
      },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(
      migration.status,
      0,
      `registered SaaS migrations through the managed CLI must succeed (exit=${migration.status}, signal=${migration.signal ?? 'none'})`,
    );

    seedDatabase = createSaasDatabase({ connectionString: roleUrls.migrator, max: 2 });
    controlPlaneProbe = createSaasDatabase({ connectionString: roleUrls.controlPlane, max: 1 });
    gatewayProbe = createSaasDatabase({ connectionString: roleUrls.gateway, max: 1 });
    await seedDatabase.verifySchema();
    for (const [database, role] of [
      [controlPlaneProbe, 'control_plane'],
      [gatewayProbe, 'gateway'],
    ] as const) {
      const current = await database.query<{ current_user: string }>('SELECT current_user');
      assert.equal(current.rows[0]?.current_user, `model_router_saas_${role}`);
      await verifySaasRuntimeDatabasePrivileges(database, role);
    }

    tempDirectory = await mkdtemp(join(tmpdir(), 'managed-saas-gateway-e2e-'));
    const certificatePath = join(tempDirectory, 'test-ca-and-server.crt');
    const privateKeyPath = join(tempDirectory, 'test-server.key');
    const certificate = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-sha256',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
        '-keyout',
        privateKeyPath,
        '-out',
        certificatePath,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(certificate.status, 0, 'OpenSSL must generate a local test-only TLS CA/server certificate');
    const [certificatePem, privateKeyPem] = await Promise.all([
      readFile(certificatePath, 'utf8'),
      readFile(privateKeyPath, 'utf8'),
    ]);

    let upstreamCallCount = 0;
    let upstreamAuthorization: string | undefined;
    const upstreamAuthorizations: string[] = [];
    const upstreamResponse = [
      'data: {"id":"chatcmpl-gateway-e2e","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"e2e-ok"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-gateway-e2e","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const acceptedUpstreamAuthorizations = new Set([`Bearer ${PROVIDER_SECRET}`, `Bearer ${PLATFORM_PROVIDER_SECRET}`]);
    upstream = createHttpsServer({ cert: certificatePem, key: privateKeyPem }, (request, response) => {
      upstreamCallCount += 1;
      upstreamAuthorization = request.headers.authorization;
      upstreamAuthorizations.push(upstreamAuthorization ?? '');
      if (
        request.method !== 'POST' ||
        request.url !== ENDPOINT ||
        !acceptedUpstreamAuthorizations.has(upstreamAuthorization ?? '')
      ) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"error":"unexpected local test request"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      response.end(upstreamResponse);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
    const upstreamPort = upstreamAddress.port;

    const ids = { label: randomUUID().replaceAll('-', '') };
    const tenantSlug = `gateway-e2e-${ids.label}`;
    const providerId = `gateway-e2e-provider-${ids.label}`;
    const productId = `gateway-e2e-product-${ids.label}`;
    const providerModel = `gateway-e2e-provider-model-${ids.label}`;
    const publicModel = `gateway-e2e-model-${ids.label}`;
    const publicModelId = randomUUID();
    const profileId = `gateway-e2e-profile-${ids.label}`;
    const platformProfileId = `gateway-e2e-platform-profile-${ids.label}`;
    const platformEntitlementId = randomUUID();
    const upstreamId = `gateway-e2e-upstream-${ids.label}`;
    const accountId = `gateway-e2e-account-${ids.label}`;
    const credentialId = `gateway-e2e-credential-${ids.label}`;
    const platformAccountId = `gateway-e2e-platform-account-${ids.label}`;
    const platformCredentialId = `gateway-e2e-platform-credential-${ids.label}`;
    const platformPoolId = `gateway-e2e-platform-pool-${ids.label}`;
    const rightsId = `gateway-e2e-rights-${ids.label}`;
    const platformRightsId = `gateway-e2e-platform-rights-${ids.label}`;
    const routeId = `gateway-e2e-route-${ids.label}`;
    const platformRouteId = `gateway-e2e-platform-route-${ids.label}`;
    const servicePlanId = `gateway-e2e-plan-${ids.label}`;
    const planVersionId = randomUUID();
    const deploymentId = 'managed-saas-gateway-e2e';
    const environmentId = 'test';
    const now = new Date();
    const nowIso = now.toISOString();
    const audit = {
      actorUserId: '',
      requestId: randomUUID(),
      entryPoint: 'managed-saas-gateway-real-postgres-e2e',
    };

    const identity = new SaasIdentityService(seedDatabase);
    const bootstrap = await identity.issueBootstrapToken();
    const administrator = await identity.bootstrapPlatformAdmin({
      token: bootstrap.token,
      email: `gateway-e2e-${ids.label}@example.test`,
      displayName: 'Gateway E2E Administrator',
      password: `e2e-${randomUUID()}-Strong-Password!`,
    });
    audit.actorUserId = administrator.id;
    const tenant = await identity.createTenant(administrator.id, {
      name: `Gateway E2E ${ids.label}`,
      slug: tenantSlug,
    });
    const project = await identity.createProject(administrator.id, tenant.id, {
      name: `Gateway E2E Project ${ids.label}`,
      slug: `gateway-e2e-project-${ids.label}`,
    });
    const tenantContext = await identity.resolveTenantContext({
      userId: administrator.id,
      tenantId: tenant.id,
      projectId: project.id,
    });

    const projectPolicy = await new SaasProjectInferencePolicyService(seedDatabase).enable({
      tenantId: tenant.id,
      projectId: project.id,
      expectedVersion: 1,
      audit,
    });
    await seedDatabase.query(
      `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
         VALUES ($1, $2, 'byok', 'active', $3, 1, $4, $4, $4)`,
      [tenant.id, profileId, [publicModel], nowIso],
    );
    await seedDatabase.query(
      `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
         VALUES ($1, $2, 'platform', 'active', $3, 1, $4, $4, $4)`,
      [tenant.id, platformProfileId, [publicModel], nowIso],
    );
    const entitlementEffectiveAt = new Date(now.getTime() - 60_000).toISOString();
    const entitlementExpiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    await seedDatabase.query(
      `INSERT INTO saas_project_entitlements
           (id, tenant_id, project_id, supply_profile_id, supply_mode, status, model_scopes,
            authz_version, created_at, updated_at, last_audited_at, effective_at, expires_at, source_type)
         VALUES ($1, $2, $3, $4, 'platform', 'active', $5, 1, $6, $6, $6, $7, $8, 'admin_grant')`,
      [
        platformEntitlementId,
        tenant.id,
        project.id,
        platformProfileId,
        [publicModel],
        nowIso,
        entitlementEffectiveAt,
        entitlementExpiresAt,
      ],
    );
    await seedDatabase.query(
      `INSERT INTO saas_service_plans (id, slug, display_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'published', $4, $4)`,
      [servicePlanId, `gateway-e2e-${ids.label}`, 'Gateway E2E BYOK service plan', nowIso],
    );
    await seedDatabase.query(
      `INSERT INTO saas_service_plan_versions
           (id, plan_id, version, supply_mode, supply_profile_id, allowed_provider_ids, allowed_models,
            price_version, price_minor_units, currency, term_days, policy_version, status, created_at, published_at)
         VALUES ($1, $2, 1, 'byok', $3, $4, $5, $6, 100, 'USD', 30, $7, 'published', $8, $8)`,
      [
        planVersionId,
        servicePlanId,
        profileId,
        [providerId],
        [publicModel],
        `price-${ids.label}`,
        `policy-${ids.label}`,
        nowIso,
      ],
    );
    const plans = new ByokServicePlanService(seedDatabase);
    const order = await plans.createOrder(tenantContext, {
      planVersionId,
      clientRequestId: `gateway-e2e-order-${ids.label}`,
    });
    const checkoutOrder = await seedDatabase.query<{ id: string }>(
      `UPDATE saas_service_plan_orders
          SET provider_key = $3,
              merchant_id = $4,
              provider_order_id = $5
        WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
        RETURNING id`,
      [
        tenant.id,
        order.id,
        'gateway-e2e-settlement-provider',
        'gateway-e2e-merchant',
        `gateway-e2e-provider-order-${ids.label}`,
      ],
    );
    assert.deepEqual(
      checkoutOrder.rows.map(({ id }) => id),
      [order.id],
      'the E2E fixture must bind a provider checkout order before verified settlement fulfillment',
    );
    const fulfilled = await plans.fulfillVerified({
      kind: 'server_verified_service_plan_fulfillment',
      orderId: order.id,
      tenantId: tenant.id,
      projectId: project.id,
      settlementId: `gateway-e2e-settlement-${ids.label}`,
      providerKey: 'gateway-e2e-settlement-provider',
      merchantId: 'gateway-e2e-merchant',
      amountMinorUnits: '100',
      currency: 'USD',
      fulfillmentReference: `gateway-e2e-fulfillment-${ids.label}`,
      fulfillmentEvidenceSha256: 'e'.repeat(64),
      verifiedAt: now,
    });
    const effectiveEntitlement = await plans.resolveBoundForRequest(
      { tenantId: tenant.id, projectId: project.id },
      fulfilled.entitlementId,
    );
    assert.ok(effectiveEntitlement, 'fulfilled BYOK service plan must resolve from PostgreSQL');
    assert.deepEqual(effectiveEntitlement.allowedProviderIds, [providerId]);

    const catalog = new SaasCatalogService(seedDatabase);
    await catalog.registerProviderProduct({ providerId, productId, displayName: 'Gateway E2E Provider Product' });
    await catalog.registerPublicModelAlias({
      publicModelId,
      alias: publicModel,
      displayName: 'Gateway E2E Public Model',
      providerId,
      productId,
      model: providerModel,
      endpointScope: [ENDPOINT],
    });
    const capability = await catalog.registerProviderCapability({
      providerId,
      productId,
      model: providerModel,
      endpoint: ENDPOINT,
      protocol: 'openai',
      supportLevel: 'supported',
      validationState: 'verified',
      evidenceVersion: 'gateway-e2e-capability-v1',
      discoverySource: 'manual',
      evidenceReference: `gateway-e2e-capability-${ids.label}`,
      evidenceSha256: 'a'.repeat(64),
    });
    const rights = await catalog.registerProviderRightsVersion({
      rightsId,
      providerId,
      productId,
      credentialType: 'api-key',
      supplyMode: 'byok',
      region: 'e2e-region',
      purpose: 'inference',
      modelScope: [providerModel],
      endpointScope: [ENDPOINT],
      effectiveAt: new Date(now.getTime() - 60_000).toISOString(),
      approvalReference: `gateway-e2e-approval-${ids.label}`,
      status: 'active',
      evidenceReference: `gateway-e2e-rights-evidence-${ids.label}`,
      evidenceSha256: 'b'.repeat(64),
      audit,
    });
    const platformRights = await catalog.registerProviderRightsVersion({
      rightsId: platformRightsId,
      providerId,
      productId,
      credentialType: 'api-key',
      supplyMode: 'platform',
      region: 'e2e-region',
      purpose: 'inference',
      modelScope: [providerModel],
      endpointScope: [ENDPOINT],
      effectiveAt: entitlementEffectiveAt,
      approvalReference: `gateway-e2e-platform-approval-${ids.label}`,
      status: 'active',
      evidenceReference: `gateway-e2e-platform-rights-evidence-${ids.label}`,
      evidenceSha256: '9'.repeat(64),
      audit,
    });

    const customerDefinition: CustomerMeteringPolicyDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'byok',
      targetMode: 'tenant_account',
      customerPriceVersion: null,
      usageDimensions: ['input_total', 'output_total'],
      tokenSource: 'upstream',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      commercialPolicyVersion: 'gateway-e2e-commercial-v1',
    };
    const providerDefinition: ProviderMeteringPolicyDefinition = {
      ...customerDefinition,
      providerId,
      productId,
      resolvedModel: providerModel,
      supplierCostVersion: null,
    };
    const contractKeyPair = generateKeyPairSync('ed25519');
    const contractKeyId = `gateway-e2e-contract-${ids.label}`;
    const testVectorDigest = 'c'.repeat(64);
    const commercial = new SaasCommercialMeteringPolicyService(seedDatabase, {
      trustedVerifierPublicKeys: new Map([[contractKeyId, contractKeyPair.publicKey]]),
      trustedTestVectorDigests: new Map([['gateway-e2e-suite-v1', testVectorDigest]]),
    });
    const customerPolicyId = `gateway-e2e-customer-policy-${ids.label}`;
    const providerPolicyId = `gateway-e2e-provider-policy-${ids.label}`;
    await commercial.createCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: customerPolicyId,
      definition: customerDefinition,
      audit,
    });
    await commercial.createProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: providerPolicyId,
      definition: providerDefinition,
      audit,
    });
    const customerPolicy = await commercial.publishCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: customerPolicyId,
      expectedVersion: 1,
      definition: customerDefinition,
      audit,
    });
    const providerPolicy = await commercial.publishProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: providerPolicyId,
      expectedVersion: 1,
      definition: providerDefinition,
      audit,
    });
    const contractDigest = 'd'.repeat(64);
    const attestationPayload = canonicalContractAttestationPayload({
      contractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      providerPolicyId,
      providerPolicyVersion: providerPolicy.version,
      publicModelId,
      publicModelVersion: '1',
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'byok',
      targetMode: 'tenant_account',
      usageDimensions: customerDefinition.usageDimensions,
      tokenSource: customerDefinition.tokenSource,
      roundingVersion: customerDefinition.roundingVersion,
      roundingMode: customerDefinition.roundingMode,
      roundingBoundary: 'total',
    });
    const attestationId = `gateway-e2e-attestation-${ids.label}`;
    await commercial.attestProviderContract({
      tenantId: tenant.id,
      projectId: project.id,
      id: attestationId,
      providerPolicyId,
      providerPolicyVersion: providerPolicy.version,
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'byok',
      targetMode: 'tenant_account',
      contractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      verifierKeyId: contractKeyId,
      signatureBase64: sign(null, Buffer.from(attestationPayload), contractKeyPair.privateKey).toString('base64'),
      usageDimensions: customerDefinition.usageDimensions,
      tokenSource: customerDefinition.tokenSource,
      roundingVersion: customerDefinition.roundingVersion,
      roundingMode: customerDefinition.roundingMode,
      roundingBoundary: 'total',
      audit,
    });

    const routes = new SaasRouteConfigService(seedDatabase);
    const routeDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai' as const,
      supplyMode: 'byok' as const,
      targetMode: 'tenant_account' as const,
      upstreamId,
      endpoint: ENDPOINT,
    };
    await routes.create({ tenantId: tenant.id, projectId: project.id, routeId, definition: routeDefinition, audit });
    const activeRoute = await routes.publish({
      tenantId: tenant.id,
      projectId: project.id,
      routeId,
      expectedVersion: 1,
      definition: routeDefinition,
      audit,
    });
    await commercial.bindRoute({
      tenantId: tenant.id,
      projectId: project.id,
      routeId,
      routeVersion: activeRoute.version,
      customerPolicyId,
      customerPolicyVersion: customerPolicy.version,
      providerPolicyId,
      providerPolicyVersion: providerPolicy.version,
      contractAttestationId: attestationId,
      audit,
    });

    const pricing = new SaasPricingService(seedDatabase);
    const platformCustomerPrice = await pricing.appendCustomerPriceVersion({
      publicModelId,
      publicModelVersion: 1,
      providerId,
      productId,
      protocol: 'openai',
      endpoint: ENDPOINT,
      currency: 'USD',
      commercialPolicyVersion: `gateway-e2e-platform-commercial-${ids.label}`,
      calculatorVersion: 'gateway-e2e-calculator-v1',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      rates: {
        input: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_read: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_write: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_write_5m: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        cache_write_1h: { numeratorMinorUnits: 2, denominatorUnits: 1 },
        output: { numeratorMinorUnits: 3, denominatorUnits: 1 },
      },
      effectiveAt: entitlementEffectiveAt,
      idempotencyKey: `gateway-e2e-platform-customer-price-${ids.label}`,
    });
    const platformSupplierCost = await pricing.appendSupplierCostVersion({
      publicModelId,
      publicModelVersion: 1,
      providerId,
      productId,
      resolvedModel: providerModel,
      protocol: 'openai',
      endpoint: ENDPOINT,
      currency: 'USD',
      commercialPolicyVersion: `gateway-e2e-platform-commercial-${ids.label}`,
      calculatorVersion: 'gateway-e2e-calculator-v1',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      rates: {
        input: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_read: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write_5m: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        cache_write_1h: { numeratorMinorUnits: 1, denominatorUnits: 1 },
        output: { numeratorMinorUnits: 1, denominatorUnits: 1 },
      },
      effectiveAt: entitlementEffectiveAt,
      idempotencyKey: `gateway-e2e-platform-supplier-cost-${ids.label}`,
    });
    const platformCustomerDefinition: CustomerMeteringPolicyDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      customerPriceVersion: platformCustomerPrice.id,
      usageDimensions: ['input_total', 'output_total'],
      tokenSource: 'upstream',
      roundingVersion: 'gateway-e2e-rounding-v1',
      roundingMode: 'half_up',
      roundingBoundary: 'total',
      commercialPolicyVersion: `gateway-e2e-platform-commercial-${ids.label}`,
    };
    const platformProviderDefinition: ProviderMeteringPolicyDefinition = {
      ...platformCustomerDefinition,
      providerId,
      productId,
      resolvedModel: providerModel,
      supplierCostVersion: platformSupplierCost.id,
    };
    const platformCustomerPolicyId = `gateway-e2e-platform-customer-policy-${ids.label}`;
    const platformProviderPolicyId = `gateway-e2e-platform-provider-policy-${ids.label}`;
    await commercial.createCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformCustomerPolicyId,
      definition: platformCustomerDefinition,
      audit,
    });
    await commercial.createProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformProviderPolicyId,
      definition: platformProviderDefinition,
      audit,
    });
    const platformCustomerPolicy = await commercial.publishCustomerPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformCustomerPolicyId,
      expectedVersion: 1,
      definition: platformCustomerDefinition,
      audit,
    });
    const platformProviderPolicy = await commercial.publishProviderPolicy({
      tenantId: tenant.id,
      projectId: project.id,
      policyId: platformProviderPolicyId,
      expectedVersion: 1,
      definition: platformProviderDefinition,
      audit,
    });
    const platformContractDigest = '1'.repeat(64);
    const platformAttestationPayload = canonicalContractAttestationPayload({
      contractDigest: platformContractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      providerPolicyId: platformProviderPolicyId,
      providerPolicyVersion: platformProviderPolicy.version,
      publicModelId,
      publicModelVersion: '1',
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      usageDimensions: platformCustomerDefinition.usageDimensions,
      tokenSource: platformCustomerDefinition.tokenSource,
      roundingVersion: platformCustomerDefinition.roundingVersion,
      roundingMode: platformCustomerDefinition.roundingMode,
      roundingBoundary: 'total',
    });
    const platformAttestationId = `gateway-e2e-platform-attestation-${ids.label}`;
    await commercial.attestProviderContract({
      tenantId: tenant.id,
      projectId: project.id,
      id: platformAttestationId,
      providerPolicyId: platformProviderPolicyId,
      providerPolicyVersion: platformProviderPolicy.version,
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai',
      endpoint: ENDPOINT,
      supplyMode: 'platform',
      targetMode: 'platform_pool',
      contractDigest: platformContractDigest,
      suiteVersion: 'gateway-e2e-suite-v1',
      testVectorDigest,
      verifierKeyId: contractKeyId,
      signatureBase64: sign(null, Buffer.from(platformAttestationPayload), contractKeyPair.privateKey).toString(
        'base64',
      ),
      usageDimensions: platformCustomerDefinition.usageDimensions,
      tokenSource: platformCustomerDefinition.tokenSource,
      roundingVersion: platformCustomerDefinition.roundingVersion,
      roundingMode: platformCustomerDefinition.roundingMode,
      roundingBoundary: 'total',
      audit,
    });

    const platformRouteDefinition = {
      publicModelId,
      publicModelVersion: 1,
      protocol: 'openai' as const,
      supplyMode: 'platform' as const,
      targetMode: 'platform_pool' as const,
      upstreamId,
      endpoint: ENDPOINT,
    };
    await routes.create({
      tenantId: tenant.id,
      projectId: project.id,
      routeId: platformRouteId,
      definition: platformRouteDefinition,
      audit,
    });
    const activePlatformRoute = await routes.publish({
      tenantId: tenant.id,
      projectId: project.id,
      routeId: platformRouteId,
      expectedVersion: 1,
      definition: platformRouteDefinition,
      audit,
    });
    await commercial.bindRoute({
      tenantId: tenant.id,
      projectId: project.id,
      routeId: platformRouteId,
      routeVersion: activePlatformRoute.version,
      customerPolicyId: platformCustomerPolicyId,
      customerPolicyVersion: platformCustomerPolicy.version,
      providerPolicyId: platformProviderPolicyId,
      providerPolicyVersion: platformProviderPolicy.version,
      contractAttestationId: platformAttestationId,
      audit,
    });

    const owner: ProviderSupplyOwner = { ownerKind: 'tenant', tenantId: tenant.id, supplyMode: 'byok' };
    const supplyRepository = new PostgresProviderSupplyRepository(seedDatabase);
    const account = await supplyRepository.createAccount({
      owner,
      id: accountId,
      displayName: 'Gateway E2E BYOK Account',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: rights.rightsId,
      rightsVersion: rights.version,
      capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
      status: 'active',
      validationState: 'verified',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await supplyRepository.createTenantByokProfileAccount({
      tenantId: tenant.id,
      supplyProfileId: profileId,
      accountId,
      effectiveAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: null,
      evidenceReference: `gateway-e2e-profile-account-${ids.label}`,
      evidenceSha256: 'f'.repeat(64),
    });

    const credential = await supplyRepository.createCredential({
      owner,
      id: credentialId,
      accountId,
      providerId,
      productId,
      credentialType: 'api-key',
      status: 'pending',
      validationState: 'unverified',
      expiresAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const credentialContext = createProviderCredentialContext({
      deployment: deploymentId,
      environment: environmentId,
      ownerKind: 'tenant',
      tenantId: tenant.id,
      supplyMode: 'byok',
      purpose: 'inference',
      providerId,
      productId,
      accountId,
      credentialId,
      credentialVersion: 1,
      credentialType: 'api-key',
    });
    const envelope = await sealProviderCredential(
      Buffer.from(PROVIDER_SECRET, 'utf8'),
      credentialContext,
      {
        generateDataKey: async () => ({
          plaintextKey: Uint8Array.from(DEK),
          ciphertextBlob: Buffer.from('gateway-e2e-wrapped-dek', 'utf8'),
        }),
      },
      'gateway-e2e-kms-key',
    );
    const appendedCredential = await supplyRepository.appendCredentialVersion({
      credential: { ownerKind: 'tenant', tenantId: tenant.id, accountId, credentialId, version: 1 },
      providerId,
      productId,
      envelope,
      kmsPurpose: 'inference',
      wrappingRevision: 1,
      expectedCurrentVersion: null,
      createdAt: nowIso,
      expiresAt: null,
    });
    const verifiedCredential = await seedDatabase.query<{ status: string; validation_state: string }>(
      `UPDATE saas_tenant_provider_credentials
          SET validation_state = 'verified',
              validation_error_code = NULL,
              last_validated_at = $1,
              status = 'active',
              updated_at = $1,
              authz_version = authz_version + 1
        WHERE tenant_id = $2 AND account_id = $3 AND id = $4 AND authz_version = $5
        RETURNING status, validation_state`,
      [nowIso, tenant.id, accountId, credentialId, appendedCredential.credential.authzVersion],
    );
    assert.deepEqual(verifiedCredential.rows, [{ status: 'active', validation_state: 'verified' }]);
    assert.equal(account.status, 'active');

    const platformSupply = new ProviderSupplyService(seedDatabase, {
      deployment: deploymentId,
      environment: environmentId,
      kmsKeyId: 'gateway-e2e-kms-key',
      sealingKms: {
        generateDataKey: async () => ({
          plaintextKey: Uint8Array.from(DEK),
          ciphertextBlob: Buffer.from('gateway-e2e-platform-wrapped-dek', 'utf8'),
        }),
      },
    });
    const platformAccount = await platformSupply.createPlatformProviderAccount({
      id: platformAccountId,
      displayName: 'Gateway E2E platform account',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: platformRights.rightsId,
      rightsVersion: platformRights.version,
      capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
      audit,
    });
    assert.equal(platformAccount.ownerKind, 'platform');
    assert.equal(platformAccount.supplyMode, 'platform');
    const activePlatformAccount = await platformSupply.setProviderAccountValidation({
      accountId: platformAccount.id,
      validationState: 'verified',
      expectedAuthzVersion: platformAccount.authzVersion,
    });
    assert.equal(activePlatformAccount.status, 'active');
    const platformCredential = await platformSupply.createPlatformProviderCredential({
      accountId: activePlatformAccount.id,
      id: platformCredentialId,
      secret: Buffer.from(PLATFORM_PROVIDER_SECRET, 'utf8'),
      audit,
    });
    assert.equal(platformCredential.credential.ownerKind, 'platform');
    const activePlatformCredential = await seedDatabase.query<{ status: string; validation_state: string }>(
      `UPDATE saas_platform_provider_credentials
          SET validation_state = 'verified',
              validation_error_code = NULL,
              last_validated_at = $1,
              status = 'active',
              updated_at = $1,
              authz_version = authz_version + 1
        WHERE id = $2 AND account_id = $3 AND authz_version = $4
        RETURNING status, validation_state`,
      [nowIso, platformCredential.credential.id, activePlatformAccount.id, platformCredential.credential.authzVersion],
    );
    assert.deepEqual(activePlatformCredential.rows, [{ status: 'active', validation_state: 'verified' }]);
    const platformPool = await platformSupply.createPlatformProviderPool({
      id: platformPoolId,
      displayName: 'Gateway E2E platform pool',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: platformRights.rightsId,
      rightsVersion: platformRights.version,
      capabilities: [{ model: providerModel, endpoint: ENDPOINT, version: capability.version }],
      status: 'active',
      validationState: 'verified',
    });
    await platformSupply.addPlatformPoolMember({
      poolId: platformPool.id,
      accountId: activePlatformAccount.id,
      expectedAccountAuthzVersion: activePlatformAccount.authzVersion,
    });
    const platformGrant = await platformSupply.grantPlatformPoolToProfile({
      poolId: platformPool.id,
      tenantId: tenant.id,
      supplyProfileId: platformProfileId,
      evidenceReference: `gateway-e2e-platform-grant-${ids.label}`,
      evidenceSha256: '8'.repeat(64),
    });
    assert.equal(platformGrant.status, 'active');
    assert.equal(platformGrant.profileAuthzVersion, 1);
    assert.equal(platformGrant.poolAuthzVersion, platformPool.authzVersion);

    const keyService = new KeyService(seedDatabase, {
      resolver: new PostgresSupplyProfileResolver(seedDatabase),
    });
    const createdKey = await keyService.create(tenantContext, {
      name: 'Gateway E2E Proxy Key',
      modelScopes: [publicModel],
      supplyMode: 'byok',
    });
    const platformKey = await keyService.create(tenantContext, {
      name: 'Gateway E2E Platform Proxy Key',
      modelScopes: [publicModel],
      supplyMode: 'platform',
    });
    assert.notEqual(platformKey.id, createdKey.id);
    assert.equal(platformKey.supplyMode, 'platform');
    assert.equal(platformKey.entitlementId, platformEntitlementId);
    assert.equal(platformKey.supplyProfileId, platformProfileId);
    assert.deepEqual(platformKey.modelScopes, [publicModel]);
    assert.equal(platformKey.entitlementAuthzVersion, 1);
    assert.equal(platformKey.supplyProfileAuthzVersion, 1);
    assert.equal(platformKey.modelScopeVersion, 1);
    await seedDatabase.query(
      `UPDATE saas_tenants
            SET requests_per_minute = 120, tokens_per_minute = 20000, max_concurrent_requests = 4
          WHERE id = $1`,
      [tenant.id],
    );
    // Migration 038 deliberately leaves project and key limits unset. Append
    // a configured immutable project-policy version and configure both keys
    // explicitly so this integration fixture can pass capacity admission.
    const projectCapacityVersion = (BigInt(projectPolicy.version) + 1n).toString();
    await seedDatabase.transaction(async (executor) => {
      const appendedProjectPolicy = await executor.query<{ version: string | number }>(
        `INSERT INTO saas_project_inference_policy_versions
           (tenant_id, project_id, version, status, changed_by_user_id, created_at,
            requests_per_minute, tokens_per_minute, max_concurrent_requests)
         SELECT policy.tenant_id, policy.project_id, $3, policy.status, $4, clock_timestamp(), $5, $6, $7
           FROM saas_project_inference_policy_versions AS policy
          WHERE policy.tenant_id = $1 AND policy.project_id = $2 AND policy.version = $8
         RETURNING version`,
        [tenant.id, project.id, projectCapacityVersion, administrator.id, 100, 16000, 4, projectPolicy.version],
      );
      assert.equal(appendedProjectPolicy.rows.length, 1, 'the project capacity policy version must be appended');
      assert.equal(String(appendedProjectPolicy.rows[0]?.version), projectCapacityVersion);

      const updatedProjectHead = await executor.query<{ inference_policy_version: string | number }>(
        `UPDATE saas_projects
            SET inference_policy_version = $3, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND inference_policy_version = $4
          RETURNING inference_policy_version`,
        [tenant.id, project.id, projectCapacityVersion, projectPolicy.version],
      );
      assert.equal(updatedProjectHead.rows.length, 1, 'the configured project policy must become the active head');
      assert.equal(String(updatedProjectHead.rows[0]?.inference_policy_version), projectCapacityVersion);

      const configuredKeys = await executor.query<{ id: string }>(
        `UPDATE saas_api_keys
            SET requests_per_minute = 60,
                tokens_per_minute = 8000,
                max_concurrent_requests = 2,
                authz_version = authz_version + 1
          WHERE tenant_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
          RETURNING id`,
        [tenant.id, project.id, [createdKey.id, platformKey.id]],
      );
      assert.equal(configuredKeys.rows.length, 2, 'both BYOK and platform API keys need explicit capacity limits');
    });
    const probeAttemptId = randomUUID();
    const leaseService = new PostgresProviderAccountLeaseService({
      database: seedDatabase,
      maxConcurrency: 2,
      leaseTtlMs: 30_000,
    });
    const probeEvidence = {
      tenantId: tenant.id,
      projectId: project.id,
      requestId: randomUUID(),
      attemptId: probeAttemptId,
      evidenceId: randomUUID(),
      accountId,
      upstreamId,
      supplyMode: 'byok',
    } as PreparedRequestEvidenceRecord;
    const probeLease = await leaseService.acquire({
      tenantId: tenant.id,
      accountId,
      upstreamId,
      attemptId: probeAttemptId,
      evidence: probeEvidence,
    });
    assert.ok(probeLease, 'the PostgreSQL provider lease must be acquired');
    const health = new PostgresProviderAccountRuntimeHealthStore({ database: seedDatabase });
    assert.equal(
      await health.recordRuntimeOutcome({
        candidate: {
          tenantId: tenant.id,
          accountId,
          upstreamId,
          supplyMode: 'byok',
          accountOwnerKind: 'tenant',
        },
        attemptId: probeAttemptId,
        fencingToken: probeLease.fencingToken,
        evidence: { source: 'probe', result: 'success' },
      }),
      'applied',
    );
    await probeLease.release();

    const usedPorts = new Set<number>([upstreamPort]);
    const customerPort = await freeLocalPort(usedPorts);
    const platformPort = await freeLocalPort(usedPorts);
    const controlPlaneEnvironment = {
      NODE_ENV: 'test',
      [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
      [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'control-plane',
      [MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL]: roleUrls.controlPlane,
      [MODEL_ROUTER_SAAS_REDIS_URL]: 'redis://127.0.0.1:6379',
      [MODEL_ROUTER_SAAS_REDIS_PROVIDER]: '@model-router/e2e-redis-provider',
      [MODEL_ROUTER_SAAS_KMS_PROVIDER]: '@model-router/e2e-credential-provider',
      [MODEL_ROUTER_SAAS_DEPLOYMENT_ID]: deploymentId,
      [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: environmentId,
      [SAAS_PLATFORM_AUDIT_CURSOR_SECRET]: 'gateway-e2e-cursor-secret-0123456789',
      ...listenerEnvironment('customer', customerPort),
      ...listenerEnvironment('platform', platformPort),
    };
    const controlPlaneDeployment = parseDeploymentConfig(controlPlaneEnvironment);
    assert.equal(controlPlaneDeployment.mode, 'managed-saas');
    if (controlPlaneDeployment.mode !== 'managed-saas') throw new Error('control-plane deployment did not parse');
    const providers = {
      credentialKeyProvider: {
        getCurrentKey: async () => ({ keyId: 'gateway-e2e-platform-key', key: new Uint8Array(32).fill(7) }),
        getKey: async () => new Uint8Array(32).fill(7),
        checkReady: async () => {},
        close: async () => {},
      },
      platformAuthRateLimiter: { take: async () => undefined },
      customerAuthRateLimiter: { take: async () => undefined },
      close: async () => {},
    };
    controlPlaneRuntime = await startManagedSaasServer(controlPlaneDeployment, {
      environment: controlPlaneEnvironment,
      loadProviders: async () => providers,
      installSignalHandlers: false,
    });
    const controlPlaneUser = await controlPlaneRuntime.database.query<{ current_user: string }>('SELECT current_user');
    assert.equal(controlPlaneUser.rows[0]?.current_user, 'model_router_saas_control_plane');
    assert.deepEqual(Object.keys(controlPlaneRuntime.listeners).sort(), ['customer', 'platform']);

    const evidenceKeyPair = generateKeyPairSync('ed25519');
    const evidenceKeyId = `gateway-e2e-evidence-${ids.label}`;
    const testAddressCapability = createProviderHttpTestAddressCapability(certificatePem);
    const endpointPolicy = { allowedHosts: ['127.0.0.1'], allowedPorts: [upstreamPort] } as const;
    const providerTargetResolver = createProviderTargetResolver({
      bindings: [
        {
          upstreamId,
          productId,
          protocol: 'openai',
          operation: 'chat.completions',
          baseUrl: `https://127.0.0.1:${upstreamPort}`,
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [upstreamPort],
          path: ENDPOINT,
          method: 'POST',
        },
      ],
      testAddressCapability,
    });
    const gatewayPort = await freeLocalPort(usedPorts);
    const gatewayEnvironment = {
      NODE_ENV: 'test',
      [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
      [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: 'gateway',
      [MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL]: roleUrls.gateway,
      [MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE]: '@model-router/e2e-gateway-runtime',
      [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: '@model-router/e2e-gateway-kms',
      [MODEL_ROUTER_SAAS_DEPLOYMENT_ID]: deploymentId,
      [MODEL_ROUTER_SAAS_ENVIRONMENT_ID]: environmentId,
      ...listenerEnvironment('gateway', gatewayPort),
    };
    const gatewayDeployment = parseDeploymentConfig(gatewayEnvironment);
    assert.equal(gatewayDeployment.mode, 'managed-saas');
    if (gatewayDeployment.mode !== 'managed-saas') throw new Error('gateway deployment did not parse');

    const createRuntimeDependencies = (
      database: ManagedSaasGatewayRuntimeModuleOptions['database'],
    ): ManagedSaasGatewayRuntimeDependencies => {
      const serverSupplyProfileResolver = new PostgresSupplyProfileResolver(database);
      const registry = new TrustedPreparedRequestVerifierKeyRegistry({
        keys: [{ keyId: evidenceKeyId, publicKey: evidenceKeyPair.publicKey, status: 'active' }],
      });
      const evidenceSigner = new PreparedRequestEvidenceSigner({
        registry,
        verifierKeyId: evidenceKeyId,
        privateKey: evidenceKeyPair.privateKey,
      });
      const entitlementResolver: RequestPreparationEntitlementPort = {
        async resolve({ caller, publicModel: requestedModel, protocol }) {
          if (requestedModel !== publicModel || protocol !== 'openai') {
            return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
          }
          const projects = await database.query<{
            readonly inference_policy_status: string;
            readonly inference_policy_version: number | string;
          }>(
            `SELECT inference_policy_status, inference_policy_version
                 FROM saas_projects
                WHERE tenant_id = $1 AND id = $2
                LIMIT 2`,
            [caller.tenantId, caller.projectId],
          );
          const projectRow = projects.rows[0];
          if (projects.rows.length !== 1 || projectRow?.inference_policy_status !== 'active') {
            return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
          }
          if (caller.supplyMode === 'platform') {
            const resolvedPlatformEntitlement = await serverSupplyProfileResolver
              .resolve({ tenantId: caller.tenantId, projectId: caller.projectId }, 'platform', {
                entitlementId: caller.entitlementId,
              })
              .catch(() => null);
            if (
              resolvedPlatformEntitlement?.mode !== 'platform' ||
              resolvedPlatformEntitlement.entitlementId !== caller.entitlementId ||
              resolvedPlatformEntitlement.profileId !== caller.supplyProfileId ||
              resolvedPlatformEntitlement.entitlementAuthzVersion !== Number(caller.entitlementVersion) ||
              resolvedPlatformEntitlement.supplyProfileAuthzVersion !== Number(caller.supplyProfileVersion) ||
              resolvedPlatformEntitlement.modelScopeVersion !== Number(caller.modelScopeVersion) ||
              !resolvedPlatformEntitlement.allowedModels.includes(requestedModel)
            ) {
              return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
            }
            return allowRequestPreparation({
              tenantId: caller.tenantId,
              projectId: caller.projectId,
              proxyKeyId: caller.proxyKeyId,
              entitlementId: resolvedPlatformEntitlement.entitlementId,
              entitlementVersion: resolvedPlatformEntitlement.entitlementAuthzVersion,
              supplyProfileId: resolvedPlatformEntitlement.profileId,
              supplyProfileVersion: resolvedPlatformEntitlement.supplyProfileAuthzVersion,
              supplyMode: resolvedPlatformEntitlement.mode,
              modelScopeVersion: resolvedPlatformEntitlement.modelScopeVersion,
              allowedModels: [...resolvedPlatformEntitlement.allowedModels],
              allowedProviderIds: [],
              projectPolicyVersion: String(projectRow.inference_policy_version),
            });
          }
          if (caller.supplyMode !== 'byok') {
            return rejectRequestPreparation('entitlement_denied', 'Gateway E2E authority is not available.');
          }
          return allowRequestPreparation({
            tenantId: caller.tenantId,
            projectId: caller.projectId,
            proxyKeyId: caller.proxyKeyId,
            entitlementId: caller.entitlementId,
            entitlementVersion: caller.entitlementVersion,
            supplyProfileId: caller.supplyProfileId,
            supplyProfileVersion: caller.supplyProfileVersion,
            supplyMode: caller.supplyMode,
            modelScopeVersion: caller.modelScopeVersion,
            allowedModels: [...caller.modelScopes],
            allowedProviderIds: [providerId],
            projectPolicyVersion: String(projectRow.inference_policy_version),
          });
        },
      };

      return {
        entitlementResolver,
        schedulerAuthorities: {
          affinityKeyring: {
            activeKeyVersion: 'gateway-e2e-affinity-v1',
            keys: [{ version: 'gateway-e2e-affinity-v1', key: new Uint8Array(32).fill(0x42) }],
          },
          leaseConcurrencyLimit: 2,
        },
        idempotencyHmacKey: new Uint8Array(32).fill(0x53),
        providerPreparationRoute: async ({ authority }) => ({
          clientProtocol: 'openai',
          providerProtocol: 'openai',
          clientOperation: 'chat.completions',
          providerOperation: 'chat.completions',
          modelResolution: authority.modelResolution ?? {
            requestedModel: publicModel,
            mappedModel: publicModel,
            resolvedModel: providerModel,
            mappingSource: 'alias',
            mappingVersion: 1,
          },
        }),
        providerPayload: {
          estimator: {
            version: 'gateway-e2e-estimator-v1',
            estimate: async () => usageBounds,
          },
          modelCompatibility: async (input) =>
            input.providerId === providerId &&
            input.productId === productId &&
            input.providerModel === providerModel &&
            input.providerProtocol === 'openai' &&
            input.providerOperation === 'chat.completions',
          maxPayloadBytes: 1024 * 1024,
          compilerVersion: 'gateway-e2e-payload-v1',
        },
        evidenceSigner,
        evidenceVerifierKeyId: evidenceKeyId,
        idFactory: {
          requestId: randomUUID,
          attemptId: randomUUID,
          evidenceId: randomUUID,
        },
        trustedVerifierPublicKeys: new Map([[evidenceKeyId, evidenceKeyPair.publicKey]]),
        providerTargetResolver,
        providerTargetRoute: async (input) =>
          input.upstreamId === upstreamId
            ? { productId, providerProtocol: 'openai', providerOperation: 'chat.completions' }
            : null,
        resolveAuthenticationHeader: async () => 'authorization',
        fetch: undiciFetch as unknown as ManagedSaasGatewayRuntimeDependencies['fetch'],
        endpointPolicy,
        timeoutMs: 10_000,
        maxConcurrency: 2,
        leaseTtlMs: 30_000,
        maxBodyBytes: 1024 * 1024,
        entryPoint: 'managed-saas-gateway-real-postgres-e2e',
        providerHttpTestAddressCapability: testAddressCapability,
      };
    };

    gatewayRuntime = await startManagedSaasServer(gatewayDeployment, {
      environment: gatewayEnvironment,
      installSignalHandlers: false,
      gatewayRuntimeModuleImporter: async () => ({
        createManagedSaasGatewayRuntime: async (options: ManagedSaasGatewayRuntimeModuleOptions) => ({
          dependencies: createRuntimeDependencies(options.database),
          checkReady: async () => {},
          close: async () => {},
        }),
      }),
      gatewayProviderCredentialKmsImporter: async () => ({
        createGatewayProviderCredentialUnsealingKms: () => ({
          decryptDataKey: async () => Uint8Array.from(DEK),
          checkReady: async () => {},
          close: async () => {},
        }),
      }),
    });
    const gatewayUser = await gatewayRuntime.database.query<{ current_user: string }>('SELECT current_user');
    assert.equal(gatewayUser.rows[0]?.current_user, 'model_router_saas_gateway');
    assert.deepEqual(Object.keys(gatewayRuntime.listeners), ['gateway']);

    const walletBefore = await walletSnapshot(seedDatabase, tenant.id);
    const publicResponse = await fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${createdKey.secret}`,
        'content-type': 'application/json',
        'idempotency-key': `gateway-e2e-request-${ids.label}`,
      },
      body: JSON.stringify({
        model: publicModel,
        messages: [{ role: 'user', content: 'real PostgreSQL gateway integration' }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const publicBody = await publicResponse.text();
    assert.equal(publicResponse.status, 200, `gateway response body: ${publicBody.slice(0, 1000)}`);
    assert.match(publicResponse.headers.get('content-type') ?? '', /text\/event-stream/i);
    assert.match(publicBody, /e2e-ok/);
    assert.match(publicBody, /\[DONE\]/);
    assert.equal(upstreamCallCount, 1);
    assert.equal(upstreamAuthorization, `Bearer ${PROVIDER_SECRET}`);

    const durable = await seedDatabase.query<{
      request_id: string;
      execution_state: string;
      financial_status: string;
      supply_mode: string;
      dispatch_state: string;
      result_state: string;
      response_started: boolean;
      result_http_status: number | null;
      usage_status: string | null;
      usage_source: string | null;
      input_total: string | null;
      output_total: string | null;
      usage_settlement_count: string;
    }>(
      `SELECT r.id AS request_id, r.execution_state, r.financial_status, r.supply_mode,
                a.dispatch_state, a.result_state, a.response_started, a.result_http_status,
                u.status AS usage_status, u.source AS usage_source,
                u.input_total::text AS input_total, u.output_total::text AS output_total,
                (SELECT count(*)::text FROM saas_usage_settlements s
                  WHERE s.tenant_id = r.tenant_id AND s.request_id = r.id AND s.attempt_id = a.id
                    AND s.kind = 'usage_recorded') AS usage_settlement_count
           FROM saas_requests r
           JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
           LEFT JOIN saas_usage_events u ON u.tenant_id = r.tenant_id AND u.request_id = r.id AND u.attempt_id = a.id
          WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.proxy_key_id = $3
          ORDER BY r.created_at DESC, a.ordinal DESC
          LIMIT 1`,
      [tenant.id, project.id, createdKey.id],
    );
    assert.equal(durable.rows.length, 1);
    const record = durable.rows[0];
    assert.ok(record);
    assert.equal(record.execution_state, 'succeeded');
    assert.equal(record.financial_status, 'not_applicable');
    assert.equal(record.supply_mode, 'byok');
    assert.equal(record.dispatch_state, 'sent');
    assert.equal(record.result_state, 'succeeded');
    assert.equal(record.response_started, true);
    assert.equal(record.result_http_status, 200);
    assert.equal(record.usage_status, 'reported');
    assert.equal(record.usage_source, 'upstream');
    assert.equal(record.input_total, '3');
    assert.equal(record.output_total, '2');
    assert.equal(record.usage_settlement_count, '1');

    const walletAfter = await walletSnapshot(seedDatabase, tenant.id);
    assert.deepEqual(walletAfter, walletBefore, 'a BYOK gateway request must not mutate the platform wallet ledger');

    await seedDatabase.transaction((executor) =>
      new PlatformWalletLedgerService().postVerifiedFunding(executor, {
        tenantId: tenant.id,
        currency: 'USD',
        amountMinorUnits: '1000',
        sourceOrderRef: `gateway-e2e-platform-funding-${ids.label}`,
        idempotencyKey: `gateway-e2e-platform-funding-${ids.label}`,
        metadataRef: `gateway-e2e-platform-funding-${ids.label}`,
      }),
    );
    const platformWalletBefore = await walletSnapshot(seedDatabase, tenant.id);
    assert.deepEqual(platformWalletBefore, {
      wallets: '1',
      wallet_balance: '1000',
      billing_reservations: '0',
      ledger_transactions: '2',
      ledger_entries: '2',
    });

    const platformResponse = await fetch(`http://127.0.0.1:${gatewayPort}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${platformKey.secret}`,
        'content-type': 'application/json',
        'idempotency-key': `gateway-e2e-platform-request-${ids.label}`,
      },
      body: JSON.stringify({
        model: publicModel,
        messages: [{ role: 'user', content: 'real PostgreSQL platform gateway integration' }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const platformBody = await platformResponse.text();
    assert.equal(platformResponse.status, 200, `platform gateway response body: ${platformBody.slice(0, 1000)}`);
    assert.match(platformResponse.headers.get('content-type') ?? '', /text\/event-stream/i);
    assert.match(platformBody, /e2e-ok/);
    assert.match(platformBody, /\[DONE\]/);
    assert.equal(upstreamCallCount, 2);
    assert.deepEqual(upstreamAuthorizations, [`Bearer ${PROVIDER_SECRET}`, `Bearer ${PLATFORM_PROVIDER_SECRET}`]);
    assert.equal(upstreamAuthorization, `Bearer ${PLATFORM_PROVIDER_SECRET}`);

    const platformDurable = await seedDatabase.query<{
      request_id: string;
      entitlement_id: string;
      supply_profile_id: string;
      execution_state: string;
      financial_status: string;
      supply_mode: string;
      request_customer_price_version: string | null;
      binding_state: string;
      dispatch_authority_state: string;
      account_owner_kind: string | null;
      tenant_account_id: string | null;
      platform_account_id: string | null;
      pool_id: string | null;
      attempt_customer_price_version: string | null;
      supplier_cost_version: string | null;
      dispatch_state: string;
      result_state: string;
      response_started: boolean;
      result_http_status: number | null;
      usage_status: string | null;
      usage_source: string | null;
      usage_supply_mode: string | null;
      input_total: string | null;
      output_total: string | null;
      usage_settlement_count: string;
    }>(
      `SELECT r.id AS request_id, r.entitlement_id, r.supply_profile_id,
                r.execution_state, r.financial_status, r.supply_mode,
                r.customer_price_version AS request_customer_price_version,
                a.binding_state, a.dispatch_authority_state, a.account_owner_kind,
                a.tenant_account_id, a.platform_account_id, a.pool_id,
                a.customer_price_version AS attempt_customer_price_version,
                a.supplier_cost_version, a.dispatch_state, a.result_state,
                a.response_started, a.result_http_status,
                u.status AS usage_status, u.source AS usage_source, u.supply_mode AS usage_supply_mode,
                u.input_total::text AS input_total, u.output_total::text AS output_total,
                (SELECT count(*)::text FROM saas_usage_settlements s
                  WHERE s.tenant_id = r.tenant_id AND s.request_id = r.id AND s.attempt_id = a.id
                    AND s.kind = 'usage_recorded') AS usage_settlement_count
           FROM saas_requests r
           JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
           LEFT JOIN saas_usage_events u ON u.tenant_id = r.tenant_id AND u.request_id = r.id AND u.attempt_id = a.id
          WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.proxy_key_id = $3
          ORDER BY r.created_at DESC, a.ordinal DESC
          LIMIT 1`,
      [tenant.id, project.id, platformKey.id],
    );
    assert.equal(platformDurable.rows.length, 1);
    const platformRecord = platformDurable.rows[0];
    assert.ok(platformRecord);
    assert.equal(platformRecord.request_id.length > 0, true);
    assert.equal(platformRecord.entitlement_id, platformEntitlementId);
    assert.equal(platformRecord.supply_profile_id, platformProfileId);
    assert.equal(platformRecord.execution_state, 'succeeded');
    assert.equal(platformRecord.financial_status, 'settled');
    assert.equal(platformRecord.supply_mode, 'platform');
    assert.equal(platformRecord.request_customer_price_version, platformCustomerPrice.id);
    assert.equal(platformRecord.binding_state, 'bound');
    assert.equal(platformRecord.dispatch_authority_state, 'bound');
    assert.equal(platformRecord.account_owner_kind, 'platform');
    assert.equal(platformRecord.tenant_account_id, null);
    assert.equal(platformRecord.platform_account_id, platformAccountId);
    assert.equal(platformRecord.pool_id, platformPoolId);
    assert.equal(platformRecord.attempt_customer_price_version, platformCustomerPrice.id);
    assert.equal(platformRecord.supplier_cost_version, platformSupplierCost.id);
    assert.equal(platformRecord.dispatch_state, 'sent');
    assert.equal(platformRecord.result_state, 'succeeded');
    assert.equal(platformRecord.response_started, true);
    assert.equal(platformRecord.result_http_status, 200);
    assert.equal(platformRecord.usage_status, 'reported');
    assert.equal(platformRecord.usage_source, 'upstream');
    assert.equal(platformRecord.usage_supply_mode, 'platform');
    assert.equal(platformRecord.input_total, '3');
    assert.equal(platformRecord.output_total, '2');
    assert.equal(platformRecord.usage_settlement_count, '1');

    const billing = await seedDatabase.query<{
      reservation_state: string;
      reservation_amount: string;
      settlement_amount: string | null;
      reservation_price_snapshot: string;
      settlement_id: string | null;
      snapshot_price_version: string;
      snapshot_hold_amount: string;
      ledger_source_type: string | null;
      ledger_amount: string | null;
      ledger_price_snapshot: string | null;
      ledger_usage_evidence: string | null;
      ledger_entry_count: string;
    }>(
      `SELECT b.state AS reservation_state,
              b.amount_minor_units::text AS reservation_amount,
              b.settlement_amount_minor_units::text AS settlement_amount,
              b.price_snapshot_ref AS reservation_price_snapshot,
              b.settlement_id,
              s.customer_price_version AS snapshot_price_version,
              s.hold_amount_minor_units::text AS snapshot_hold_amount,
              l.source_type AS ledger_source_type,
              l.amount_minor_units::text AS ledger_amount,
              l.price_snapshot_ref AS ledger_price_snapshot,
              l.usage_evidence_ref AS ledger_usage_evidence,
              (SELECT count(*)::text FROM saas_ledger_entries e WHERE e.transaction_id = l.id) AS ledger_entry_count
         FROM saas_billing_reservations b
         JOIN saas_request_customer_price_snapshots s
           ON s.tenant_id = b.tenant_id AND s.request_id::text = b.request_id
         LEFT JOIN saas_ledger_transactions l
           ON l.tenant_id = b.tenant_id AND l.id = b.ledger_transaction_id
        WHERE b.tenant_id = $1 AND b.request_id = $2
        LIMIT 1`,
      [tenant.id, platformRecord.request_id],
    );
    assert.equal(billing.rows.length, 1);
    const billingRecord = billing.rows[0];
    assert.ok(billingRecord);
    assert.equal(billingRecord.reservation_state, 'settled');
    assert.equal(billingRecord.reservation_amount, '80');
    assert.equal(billingRecord.settlement_amount, '12');
    assert.equal(billingRecord.settlement_id?.length > 0, true);
    assert.equal(billingRecord.snapshot_price_version, platformCustomerPrice.id);
    assert.equal(billingRecord.snapshot_hold_amount, '80');
    assert.equal(billingRecord.reservation_price_snapshot, billingRecord.ledger_price_snapshot);
    assert.equal(billingRecord.ledger_source_type, 'billing_settlement');
    assert.equal(billingRecord.ledger_amount, '12');
    assert.match(billingRecord.ledger_usage_evidence ?? '', /^[0-9a-f]{64}$/);
    assert.equal(billingRecord.ledger_entry_count, '2');

    const platformWalletAfter = await walletSnapshot(seedDatabase, tenant.id);
    assert.deepEqual(platformWalletAfter, {
      wallets: '1',
      wallet_balance: '988',
      billing_reservations: '1',
      ledger_transactions: '3',
      ledger_entries: '4',
    });
  } finally {
    const closeTasks: Promise<unknown>[] = [];
    if (gatewayRuntime) closeTasks.push(gatewayRuntime.close());
    if (controlPlaneRuntime) closeTasks.push(controlPlaneRuntime.close());
    if (upstream) closeTasks.push(closeHttpServer(upstream));
    if (seedDatabase) closeTasks.push(seedDatabase.close());
    if (controlPlaneProbe) closeTasks.push(controlPlaneProbe.close());
    if (gatewayProbe) closeTasks.push(gatewayProbe.close());
    await Promise.allSettled(closeTasks);
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
