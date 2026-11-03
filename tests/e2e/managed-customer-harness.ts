import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { SaasCustomerWalletQueryService } from '../../dist/saas/billing/customer-query.js';
import { PlatformWalletLedgerService } from '../../dist/saas/billing/service.js';
import { createSaasConsoleHandler } from '../../dist/saas/console/http.js';
import { SaasConsoleUsageQueryService } from '../../dist/saas/console/usage-query.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../dist/saas/db/index.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock } from '../../dist/saas/gateway/authorization-prelock.js';
import { createPostgresBillingGroupSpendAdmission } from '../../dist/saas/gateway/postgres-billing-group-spend.js';
import { createPostgresKeyBudgetAdmission } from '../../dist/saas/gateway/postgres-preparation-budget.js';
import { createPostgresPreparationCapacityPort } from '../../dist/saas/gateway/postgres-preparation-capacity.js';
import { createPostgresPreparationPorts } from '../../dist/saas/gateway/postgres-preparation-ports.js';
import { PostgresProviderAccountAffinity } from '../../dist/saas/gateway/postgres-provider-account-affinity.js';
import { PostgresRequestAdmissionGuard } from '../../dist/saas/gateway/postgres-request-admission-guard.js';
import { PostgresRequestPreparationEntitlementAdapter } from '../../dist/saas/gateway/postgres-request-preparation-entitlement-adapter.js';
import { createProviderHttpTestAddressCapability } from '../../dist/saas/gateway/provider-http-address.js';
import { ConsoleEmailSender } from '../../dist/saas/identity/email-sender.js';
import { EmailVerificationService } from '../../dist/saas/identity/email-verification-service.js';
import { createSaasIdentityHandler } from '../../dist/saas/identity/http.js';
import { RegistrationService } from '../../dist/saas/identity/register-service.js';
import { RegistrationDefaultAccessService } from '../../dist/saas/identity/registration-default-access-service.js';
import { RegistrationDispatchCompletionService } from '../../dist/saas/identity/registration-dispatch-completion-service.js';
import {
  parseRegistrationAdmissionSettings,
  REGISTRATION_ENV_VARS,
} from '../../dist/saas/identity/registration-settings.js';
import { SaasIdentityService } from '../../dist/saas/identity/service.js';
import { PostgresSupplyProfileResolver } from '../../dist/saas/keys/resolver.js';
import { KeyService } from '../../dist/saas/keys/service.js';
import { SaasMeteringService } from '../../dist/saas/metering/service.js';
import { SaasCustomerPaymentOrderQueryService } from '../../dist/saas/payments/customer-order-query.js';
import {
  createSaasCustomerPaymentOrderHistoryHandler,
  createSaasPaymentHandler,
} from '../../dist/saas/payments/http.js';
import { PaymentFulfillmentService } from '../../dist/saas/payments/service.js';
import { type PaymentWebhookWorkerHandle, startPaymentWebhookWorker } from '../../dist/saas/payments/worker.js';
import { ByokServicePlanService } from '../../dist/saas/plans/service.js';
import { createPublicBrandSettingsHttpHandler } from '../../dist/saas/platform/brand/http.js';
import { BRAND_SETTINGS_KEY_PREFIX } from '../../dist/saas/platform/brand/snapshot.js';
import { createCachedBrandSnapshotReader, PublicBrandSnapshotStore } from '../../dist/saas/platform/brand/store.js';
import { PlatformSettingsService } from '../../dist/saas/platform/settings/service.js';
import { createBuiltinGatewayEntitlementResolver } from '../../dist/saas/runtime/builtin-gateway-runtime.js';
import type { GatewayCapabilityReadiness } from '../../dist/saas/runtime/gateway-capability-readiness.js';
import { TrustedPreparedRequestVerifierKeyRegistry } from '../../dist/saas/runtime/prepared-evidence-verifier-keys.js';
import { PreparedRequestEvidenceSigner } from '../../dist/saas/runtime/prepared-request-evidence-signer.js';
import { createProviderTargetResolver } from '../../dist/saas/runtime/provider-target-resolver.js';
import { serveMountedStatic } from '../../dist/server/managed-saas.js';
import {
  createManagedSaasGatewayProductionComposition,
  type ManagedSaasGatewayComposition,
} from '../../dist/server/managed-saas-gateway.js';
import type { SaasDatabase } from '../src/saas/db/types.js';
import { type DisposablePostgres, startDisposablePostgres } from './customer-harness.js';
import { FakePspAdapter } from './fake-psp-adapter.js';
import {
  createM1ContractTestPort,
  M1_E2E_COMMERCIAL_POLICY_VERSION,
  M1_E2E_DEK,
  M1_E2E_ENDPOINT,
  M1_E2E_ROUNDING_VERSION,
  type M1PlatformSupplySeed,
  type MockModelUpstream,
  seedM1PlatformSupply,
  startMockModelUpstream,
} from './m1-platform-seed.js';

/**
 * The M1 acceptance harness: one origin serving the real console (registration,
 * wallet payments, keys, usage), the real gateway (/v1/*, billing against the
 * real PostgreSQL wallets) and /settings/public — with open-mode registration
 * auto-provisioning the platform default access through the production
 * services. The PSP is the only fake: FakePspAdapter behind the real
 * PaymentFulfillmentService chain.
 */
export interface ManagedCustomerConsole {
  readonly origin: string;
  readonly model: string;
  readonly poolId: string;
  readonly psp: FakePspAdapter;
  /** Direct SQL on the migrator role (full privileges) for acceptance assertions. */
  readonly sql: <Row>(sql: string, values?: readonly unknown[]) => Promise<{ rows: Row[]; rowCount: number }>;
  /** Deterministically drains the webhook inbox until no claimed rows remain. */
  readonly processPayments: () => Promise<void>;
  /** Polls until `expected` settled billing reservations exist for the tenant. */
  readonly waitForSettlement: (tenantId: string, expected: number) => Promise<void>;
  close(): Promise<void>;
}

export async function startManagedCustomerConsole(): Promise<ManagedCustomerConsole> {
  // The local HTTPS upstream needs the test-runner provider address
  // capability, which requires the test context markers (NODE_ENV=test and
  // the Node test-runner flag). Playwright specs run as plain node processes,
  // so the harness owns both markers for its lifetime and restores them on
  // close — production code never sees either marker.
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_ENV = 'test';
  if (previousTestContext === undefined) process.env.NODE_TEST_CONTEXT = 'm1-e2e-harness';
  const postgres: DisposablePostgres = await startDisposablePostgres('model_router_test_m1_e2e');
  const migrator = postgres.migrator;
  const control = postgres.control;
  console.log('m1-harness: starting upstream');
  const upstream: MockModelUpstream = await startMockModelUpstream();
  const seed: M1PlatformSupplySeed = await seedM1PlatformSupply(migrator);
  const psp = new FakePspAdapter();
  const gatewayDb = createSaasDatabase({ connectionString: postgres.url('model_router_saas_gateway'), max: 4 });
  let server: Server | undefined;
  let gateway: ManagedSaasGatewayComposition | undefined;
  let paymentWorker: PaymentWebhookWorkerHandle | undefined;
  let paymentService: PaymentFulfillmentService | undefined;
  let origin = '';

  async function close() {
    try {
      await Promise.allSettled([
        gateway?.close(),
        new Promise<void>((done) => (server ? server.close(() => done()) : done())),
        paymentWorker?.stop(),
      ]);
    } finally {
      await Promise.allSettled([gatewayDb.close(), postgres.close(), upstream.close()]);
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = previousTestContext;
    }
  }

  try {
    await verifySaasRuntimeDatabasePrivileges(gatewayDb, 'gateway');

    // ---- Control-plane services (control-plane role database) ----
    const identityService = new SaasIdentityService(control);
    const keyService = new KeyService(control, { resolver: new PostgresSupplyProfileResolver(control) });
    const registrationSettings = parseRegistrationAdmissionSettings({
      [REGISTRATION_ENV_VARS.mode]: 'open',
      [REGISTRATION_ENV_VARS.emailVerification]: 'false',
    });
    const dispatchConfig = {
      poolId: seed.poolId,
      modelScopes: [seed.publicModel],
      currency: 'USD',
      usageDimensions: ['input_total', 'output_total'] as const,
      tokenSource: 'upstream' as const,
      roundingVersion: M1_E2E_ROUNDING_VERSION,
      roundingMode: 'half_up' as const,
      commercialPolicyVersion: M1_E2E_COMMERCIAL_POLICY_VERSION,
      tenant: { requestsPerMinute: 600, tokensPerMinute: 1_000_000, maxConcurrentRequests: 10 },
      project: { requestsPerMinute: 600, tokensPerMinute: 1_000_000, maxConcurrentRequests: 10 },
    };
    const registrationService = new RegistrationService({
      database: control,
      identity: identityService,
      verification: new EmailVerificationService({
        database: control,
        emailSender: new ConsoleEmailSender(),
      }),
      captcha: { backend: 'disabled', verify: async () => true },
      settings: registrationSettings,
      sessionTtlSeconds: 900,
      defaultAccess: new RegistrationDefaultAccessService({
        database: control,
        config: { poolId: seed.poolId, modelScopes: [seed.publicModel] },
      }),
      dispatchCompletion: new RegistrationDispatchCompletionService({
        database: control,
        config: dispatchConfig,
        contractTests: createM1ContractTestPort(seed),
        trustedVerifierPublicKeys: seed.trustedVerifierPublicKeys,
        trustedTestVectorDigests: seed.trustedTestVectorDigests,
      }),
      onProvisioningError: (error, stage) => {
        console.error(`m1_e2e registration provisioning failed at ${stage}`, error);
      },
    });

    paymentService = new PaymentFulfillmentService(control, psp, {
      providerKey: psp.providerKey,
      merchantId: psp.merchantId,
    });
    paymentWorker = startPaymentWebhookWorker(paymentService, {
      intervalMs: 200,
      onError: (error) => console.error('m1_e2e payment webhook cycle failed', error),
    });
    // ---- Brand / public settings (real store + snapshot) ----
    const brandStore = new PublicBrandSnapshotStore({ database: control });
    const platformSettings = new PlatformSettingsService(control);
    const brandReader = createCachedBrandSnapshotReader(brandStore, {
      onError: (error) => console.error('m1_e2e brand snapshot read failed', error),
    });

    // ---- Gateway composition (gateway role database) ----
    const evidenceKeyPair = generateKeyPairSync('ed25519');
    const evidenceKeyId = `m1-e2e-evidence-${randomUUID().slice(0, 8)}`;
    const evidenceRegistry = new TrustedPreparedRequestVerifierKeyRegistry({
      keys: [{ keyId: evidenceKeyId, publicKey: evidenceKeyPair.publicKey, status: 'active' }],
    });
    const evidenceSigner = new PreparedRequestEvidenceSigner({
      registry: evidenceRegistry,
      verifierKeyId: evidenceKeyId,
      privateKey: evidenceKeyPair.privateKey,
    });
    const testAddressCapability = createProviderHttpTestAddressCapability(upstream.certificatePem);
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
    const gatewayClock = () => new Date();
    const entitlementResolver = createBuiltinGatewayEntitlementResolver(gatewayDb);
    const metering = new SaasMeteringService(gatewayDb);
    const billingLedger = new PlatformWalletLedgerService();
    const capacityPort = createPostgresPreparationCapacityPort(undefined);
    const preparationPorts = createPostgresPreparationPorts({
      database: gatewayDb,
      metering,
      billing: billingLedger,
      guard: new PostgresRequestAdmissionGuard(gatewayDb, {}),
      authorizationPrelock: new PostgresSaasRequestAdmissionAuthorizationPrelock(),
      entitlement: new PostgresRequestPreparationEntitlementAdapter(
        entitlementResolver,
        new ByokServicePlanService(gatewayDb),
      ),
      capacity: capacityPort,
      keyBudget: createPostgresKeyBudgetAdmission({ now: gatewayClock }),
      billingGroupSpend: createPostgresBillingGroupSpendAdmission({ now: gatewayClock }),
      payloadCompilerVersion: 'm1-e2e-payload-v1',
      usageEstimatorVersion: 'm1-e2e-estimator-v1',
      now: gatewayClock,
    });
    // The advertisement policy needs a live sellable bundle report; the M1
    // e2e provider is a plain generic openai transport with a proven usage
    // bound, so the report is a single operational provider-bundle capability.
    const capabilityReadinessReport: GatewayCapabilityReadiness = {
      configurationValid: true,
      fatalReasonCodes: [],
      capabilities: [
        {
          capability: `provider-bundle:${seed.providerId}`,
          kind: 'provider-bundle',
          label: 'M1 E2E provider bundle',
          enabled: true,
          assembled: true,
          verified: true,
          operational: true,
          verificationLevel: 'live',
          reasonCodes: [],
          providerId: seed.providerId,
          productIds: [seed.productId],
          endpointScopes: [M1_E2E_ENDPOINT],
          unavailableEndpointScopes: [],
        },
      ],
    };
    const preparationFailureObserver = (failure: unknown) => {
      console.error('m1_e2e gateway preparation failure', failure);
    };
    gateway = createManagedSaasGatewayProductionComposition(gatewayDb, {
      preparationFailureObserver: (failure) => {
        console.error('m1_e2e gateway preparation failure', failure);
      },
      caller: preparationPorts.caller,
      entitlement: preparationPorts.entitlement,
      admission: preparationPorts.admission,
      attempt: preparationPorts.attempt,
      compensation: preparationPorts.compensation,
      schedulerAffinity: new PostgresProviderAccountAffinity({
        database: gatewayDb,
        keys: [{ version: 'm1-e2e-affinity-v1', key: new Uint8Array(32).fill(0x42) }],
        activeKeyVersion: 'm1-e2e-affinity-v1',
      }),
      idempotencyHmacKey: new Uint8Array(32).fill(0x53),
      providerPreparationRoute: async (input) => {
        try {
          const authority = input.authority as { modelResolution?: unknown } | undefined;
          return {
            clientProtocol: 'openai',
            providerProtocol: 'openai',
            clientOperation: 'chat.completions',
            providerOperation: 'chat.completions',
            modelResolution: (authority && typeof authority === 'object' && 'modelResolution' in authority
              ? (authority as { modelResolution: unknown }).modelResolution
              : undefined) ?? {
              requestedModel: seed.publicModel,
              mappedModel: seed.publicModel,
              resolvedModel: seed.providerModel,
              mappingSource: 'alias',
              mappingVersion: 1,
            },
          };
        } catch (error) {
          console.error('m1_e2e provider preparation route failed', error);
          throw error;
        }
      },
      providerPayload: {
        estimator: {
          version: 'm1-e2e-estimator-v1',
          estimate: async () => usageBounds,
        },
        modelCompatibility: async (input) =>
          input.providerId === seed.providerId &&
          input.productId === seed.productId &&
          input.providerModel === seed.providerModel &&
          input.providerProtocol === 'openai' &&
          input.providerOperation === 'chat.completions',
        maxPayloadBytes: 1024 * 1024,
        compilerVersion: 'm1-e2e-payload-v1',
      },
      evidenceSigner,
      evidenceVerifierKeyId: evidenceKeyId,
      idFactory: { requestId: randomUUID, attemptId: randomUUID, evidenceId: randomUUID },
      trustedVerifierPublicKeys: new Map([[evidenceKeyId, evidenceKeyPair.publicKey]]),
      providerTargetResolver: createProviderTargetResolver({
        bindings: [
          {
            upstreamId: seed.poolId,
            productId: seed.productId,
            protocol: 'openai',
            operation: 'chat.completions',
            baseUrl: `https://127.0.0.1:${upstream.port}`,
            allowedHosts: ['127.0.0.1'],
            allowedPorts: [upstream.port],
            path: M1_E2E_ENDPOINT,
            method: 'POST',
          },
        ],
        testAddressCapability,
      }),
      providerTargetRoute: async (input) =>
        input.upstreamId === seed.poolId
          ? { productId: seed.productId, providerProtocol: 'openai', providerOperation: 'chat.completions' }
          : null,
      resolveAuthenticationHeader: async () => 'authorization',
      fetch: undiciFetch as never,
      endpointPolicy: { allowedHosts: ['127.0.0.1'], allowedPorts: [upstream.port] },
      timeoutMs: 10_000,
      maxConcurrency: 2,
      leaseTtlMs: 30_000,
      maxBodyBytes: 1024 * 1024,
      entryPoint: 'm1-e2e-gateway',
      providerHttpTestAddressCapability: testAddressCapability,
      providerCredentialUnsealingKms: {
        decryptDataKey: async () => Uint8Array.from(M1_E2E_DEK),
        checkReady: async () => {},
        close: async () => {},
      },
      credentialContext: { deployment: 'm1-e2e-deployment', environment: 'm1-e2e-test' },
      capabilityReadiness: async () => capabilityReadinessReport,
    });

    // ---- One origin, one flat handler chain ----
    // The console handlers need the origin as a string, but the origin only
    // exists once the server listens. Bind first with a placeholder dispatch,
    // then swap in the real chain once the concrete origin is known — nothing
    // can arrive between listen and the synchronous assignment.
    let dispatchRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void> = async (
      _request,
      response,
    ) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"starting"}');
    };
    server = createServer((request, response) => {
      void dispatchRequest(request, response).catch((error) => {
        console.error('m1_e2e request dispatch failed', error);
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"internal"}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('M1 e2e console did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    await platformSettings.set({
      key: `${BRAND_SETTINGS_KEY_PREFIX}api_base_url`,
      value: origin,
      expectedVersion: 0,
      actor: { actorUserId: null, requestId: randomUUID() },
    });
    await brandStore.materialize();
    await brandReader.invalidate();

    // The HTTP handlers pin the concrete origin (same-origin CSRF/console contract).
    const paymentHandler = createSaasPaymentHandler({
      service: identityService,
      paymentService,
      walletTopUpPolicy: { currency: 'USD', minAmountMinorUnits: '100', maxAmountMinorUnits: '10000000' },
      publicOrigin: origin,
    });
    const paymentOrderHistoryHandler = createSaasCustomerPaymentOrderHistoryHandler({
      service: {
        getSession: (token: string) => identityService.getSession(token),
        resolveTenantBillingContext: async (input) => {
          const result = await control.query<{ readonly role: unknown }>(
            `SELECT m.role FROM saas_memberships m
              JOIN saas_tenants t ON t.id = m.tenant_id
              JOIN saas_users u ON u.id = m.user_id
             WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'
               AND t.status = 'active' AND u.disabled_at IS NULL
             LIMIT 1`,
            [input.tenantId, input.userId],
          );
          const role = result.rows[0]?.role;
          if (role !== 'owner' && role !== 'admin' && role !== 'billing') {
            throw new Error('m1-e2e payment order access denied');
          }
          return { userId: input.userId, tenantId: input.tenantId, tenantRole: role };
        },
      },
      paymentOrderQueryService: new SaasCustomerPaymentOrderQueryService(control),
      publicOrigin: origin,
    });
    const identityHandler = createSaasIdentityHandler({
      service: identityService,
      keyService,
      publicOrigin: origin,
      sessionTtlSeconds: 900,
      registration: { service: registrationService },
    });
    const consoleHandler = createSaasConsoleHandler({
      service: identityService,
      queryService: new SaasConsoleUsageQueryService(control),
      customerWalletQueryService: new SaasCustomerWalletQueryService(control),
      publicOrigin: origin,
    });
    const publicBrandHandler = createPublicBrandSettingsHttpHandler({
      read: brandReader.read,
      onError: (error) => console.error('m1_e2e brand snapshot read failed', error),
    });

    const webDist = resolve('web/dist');
    dispatchRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://m1-e2e.local');
      if (await paymentHandler(request, response)) return;
      if (await paymentOrderHistoryHandler(request, response)) return;
      if (await identityHandler(request, response)) return;
      if (await consoleHandler(request, response)) return;
      if (await publicBrandHandler(request, response)) return;
      if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
        await gateway?.handler(request, response);
        return;
      }
      if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
        await serveMountedStatic(request, response, url.pathname, '/console', webDist, brandReader);
        return;
      }
      // The console HTML bundle references its assets under the /admin build
      // base path (the production admin server serves both mounts).
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        await serveMountedStatic(request, response, url.pathname, '/admin', webDist, brandReader);
        return;
      }
      if (url.pathname === '/' || url.pathname === '/favicon.svg') {
        await serveMountedStatic(request, response, '/admin/', '/admin', webDist, brandReader);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
    };

    const sql = <Row>(queryText: string, values?: readonly unknown[]) => migrator.query<Row>(queryText, values);
    const processPayments = async () => {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const batch = await paymentService!.processPendingWebhooks(20);
        if (!batch.claimed) break;
      }
    };
    const waitForSettlement = async (tenantId: string, expected: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await sql<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM saas_billing_reservations WHERE tenant_id = $1 AND state = 'settled'`,
          [tenantId],
        );
        if (Number(result.rows[0]?.count ?? 0) >= expected) return;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error(`M1 e2e settlement wait timed out for tenant ${tenantId} (expected ${expected})`);
    };

    return {
      origin,
      model: seed.publicModel,
      poolId: seed.poolId,
      psp,
      sql,
      processPayments,
      waitForSettlement,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
