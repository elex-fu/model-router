import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaasCatalogService } from '../../dist/saas/catalog/service.js';
import {
  canonicalContractAttestationPayload,
  SaasCommercialMeteringPolicyService,
} from '../../dist/saas/gateway/commercial-metering-policy-service.js';
import type { RegistrationContractTestPort } from '../../dist/saas/identity/registration-dispatch-completion-service.js';
import { SaasIdentityService } from '../../dist/saas/identity/service.js';
import { SaasPricingService } from '../../dist/saas/pricing/service.js';
import { ProviderSupplyService } from '../../dist/saas/supply/service.js';
import type { SaasDatabase } from '../../src/saas/db/types.js';

/**
 * M1 e2e platform-supply seeding: the ONE global chain every registered
 * tenant consumes — catalog, pricing, and an active/verified platform pool
 * with a sealed credential. Per-tenant wiring (supply profile, entitlement,
 * route, commercial policies, capacity) is deliberately NOT seeded here: the
 * real RegistrationDefaultAccessService and RegistrationDispatchCompletionService
 * provision it during the e2e registration, which is exactly the §6.1
 * automation under acceptance. Shapes mirror the FIN-01 real-PG fixture.
 */

const ENDPOINT = '/v1/chat/completions';
export const M1_E2E_ENDPOINT = ENDPOINT;
const RESPONSES_ENDPOINT = '/v1/responses';
export const M1_E2E_RESPONSES_ENDPOINT = RESPONSES_ENDPOINT;
export const M1_E2E_PLATFORM_SECRET = 'm1-e2e-platform-secret';
export const M1_E2E_DEK = new Uint8Array(32).fill(0x37);
const DEPLOYMENT_ID = 'm1-e2e-deployment';
const ENVIRONMENT_ID = 'm1-e2e-test';
export const M1_E2E_COMMERCIAL_POLICY_VERSION = 'm1-e2e-commercial-v1';
export const M1_E2E_ROUNDING_VERSION = 'm1-e2e-rounding-v1';
const TEST_VECTOR_DIGEST = 'c'.repeat(64);

export interface MockModelUpstream {
  readonly server: HttpsServer;
  readonly port: number;
  readonly certificatePem: string;
  readonly upstreamCallCount: () => number;
  close(): Promise<void>;
}

/** A local HTTPS /v1/chat/completions upstream answering usage 3-in/2-out. */
export async function startMockModelUpstream(): Promise<MockModelUpstream> {
  const directory = await mkdtemp(join(tmpdir(), 'm1-e2e-upstream-'));
  const certificatePath = join(directory, 'test-ca-and-server.crt');
  const privateKeyPath = join(directory, 'test-server.key');
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
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (certificate.status !== 0) throw new Error('OpenSSL must generate the local M1 e2e upstream certificate');
  const [certificatePem, privateKeyPem] = await Promise.all([
    readFile(certificatePath, 'utf8'),
    readFile(privateKeyPath, 'utf8'),
  ]);

  let upstreamCallCount = 0;
  const sseResponse = [
    'data: {"id":"chatcmpl-m1-e2e","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"m1-e2e-ok"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-m1-e2e","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  // The responses-protocol SSE shape: usage rides the terminal
  // response.completed event (never a bare usage frame), mirroring the
  // upstream Responses API the Codex CLI talks to.
  const responsesSse = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp-m1-e2e","object":"response","status":"in_progress"}}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp-m1-e2e","object":"response","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
  ].join('');
  const server = createHttpsServer({ cert: certificatePem, key: privateKeyPem }, (request, response) => {
    upstreamCallCount += 1;
    if (request.method !== 'POST' || (request.url !== ENDPOINT && request.url !== RESPONSES_ENDPOINT)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"unexpected local test request"}');
      return;
    }
    const isResponses = request.url === RESPONSES_ENDPOINT;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      let payload: { stream?: unknown };
      try {
        payload = JSON.parse(body);
        if (!payload) throw new Error('json object required');
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"invalid local test JSON request"}');
        return;
      }
      if (payload.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        response.end(isResponses ? responsesSse : sseResponse);
      } else {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
        response.end(
          isResponses
            ? JSON.stringify({
                id: 'resp-m1-e2e-json',
                object: 'response',
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'm1-e2e-ok' }] }],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              })
            : JSON.stringify({
                id: 'chatcmpl-m1-e2e-json',
                object: 'chat.completion',
                created: 1,
                model: 'm1-e2e-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'm1-e2e-ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
              }),
        );
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('M1 e2e upstream did not bind');
  return {
    server,
    port: address.port,
    certificatePem,
    upstreamCallCount: () => upstreamCallCount,
    async close() {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface M1PlatformSupplySeed {
  readonly poolId: string;
  readonly publicModel: string;
  readonly publicModelId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly providerModel: string;
  /** The second, responses-protocol model on the same pool (R8 proof path). */
  readonly responsesPublicModel: string;
  readonly responsesPublicModelId: string;
  readonly responsesProviderModel: string;
  /** Key id + private key of the e2e contract-attestation verifier. */
  readonly contractKeyId: string;
  readonly contractPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  readonly trustedVerifierPublicKeys: Map<string, ReturnType<typeof generateKeyPairSync>['publicKey']>;
  readonly trustedTestVectorDigests: Map<string, string>;
}

/**
 * Seed the global platform supply chain. Rates: input 2 / output 3
 * minor-units per token — the fixed usage (3 in + 2 out) settles at exactly
 * 12 minor units per call, so wallet assertions have one obvious number.
 */
export async function seedM1PlatformSupply(migrator: SaasDatabase): Promise<M1PlatformSupplySeed> {
  const label = randomUUID().replaceAll('-', '');
  // A real platform administrator anchors the seeding audit rows
  // (saas_audit_events.actor_user_id has an FK to saas_users).
  const bootstrap = await new SaasIdentityService(migrator).issueBootstrapToken();
  const administrator = await new SaasIdentityService(migrator).bootstrapPlatformAdmin({
    token: bootstrap.token,
    email: `m1-e2e-admin-${label}@example.test`,
    password: `m1-e2e-${randomUUID()}-Strong-Password!`,
    displayName: 'M1 E2E Administrator',
  });
  const actorUserId = administrator.id;
  const providerId = `m1-e2e-provider-${label}`;
  const productId = `m1-e2e-product-${label}`;
  const publicModelId = `m1-e2e-public-model-${label}`;
  const publicModel = 'm1-e2e-model';
  const providerModel = `m1-e2e-provider-model-${label}`;
  const responsesPublicModelId = `m1-e2e-public-responses-${label}`;
  const responsesPublicModel = 'm1-e2e-responses-model';
  const responsesProviderModel = `m1-e2e-provider-responses-${label}`;
  const poolId = `m1-e2e-pool-${label}`;
  const audit = { actorUserId, entryPoint: 'm1-e2e-seed', requestId: randomUUID() };
  const nowIso = new Date().toISOString();
  const effectiveAt = new Date(Date.now() - 60_000).toISOString();

  const catalog = new SaasCatalogService(migrator);
  await catalog.registerProviderProduct({ providerId, productId, displayName: 'M1 E2E Provider Product' });
  await catalog.registerPublicModelAlias({
    publicModelId,
    alias: publicModel,
    displayName: 'M1 E2E Public Model',
    providerId,
    productId,
    model: providerModel,
    endpointScope: [ENDPOINT],
  });
  await catalog.registerPublicModelAlias({
    publicModelId: responsesPublicModelId,
    alias: responsesPublicModel,
    displayName: 'M1 E2E Public Responses Model',
    providerId,
    productId,
    model: responsesProviderModel,
    endpointScope: [RESPONSES_ENDPOINT],
  });
  const capability = await catalog.registerProviderCapability({
    providerId,
    productId,
    model: providerModel,
    endpoint: ENDPOINT,
    protocol: 'openai',
    supportLevel: 'supported',
    validationState: 'verified',
    evidenceVersion: 'm1-e2e-capability-v1',
    discoverySource: 'manual',
    evidenceReference: `m1-e2e-capability-${label}`,
    evidenceSha256: 'a'.repeat(64),
  });
  const responsesCapability = await catalog.registerProviderCapability({
    providerId,
    productId,
    model: responsesProviderModel,
    endpoint: RESPONSES_ENDPOINT,
    protocol: 'responses',
    supportLevel: 'supported',
    validationState: 'verified',
    evidenceVersion: 'm1-e2e-capability-v1',
    discoverySource: 'manual',
    evidenceReference: `m1-e2e-responses-capability-${label}`,
    evidenceSha256: 'b'.repeat(64),
  });
  const platformRights = await catalog.registerProviderRightsVersion({
    rightsId: `m1-e2e-platform-rights-${label}`,
    providerId,
    productId,
    credentialType: 'api-key',
    supplyMode: 'platform',
    region: 'e2e-region',
    purpose: 'inference',
    modelScope: [providerModel, responsesProviderModel],
    endpointScope: [ENDPOINT, RESPONSES_ENDPOINT],
    effectiveAt,
    approvalReference: `m1-e2e-approval-${label}`,
    status: 'active',
    evidenceReference: `m1-e2e-rights-evidence-${label}`,
    evidenceSha256: '9'.repeat(64),
    audit,
  });

  const pricing = new SaasPricingService(migrator);
  await pricing.appendCustomerPriceVersion({
    publicModelId,
    publicModelVersion: 1,
    providerId,
    productId,
    protocol: 'openai',
    endpoint: ENDPOINT,
    currency: 'USD',
    commercialPolicyVersion: M1_E2E_COMMERCIAL_POLICY_VERSION,
    calculatorVersion: 'm1-e2e-calculator-v1',
    roundingVersion: M1_E2E_ROUNDING_VERSION,
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
    effectiveAt,
    idempotencyKey: `m1-e2e-customer-price-${label}`,
  });
  await pricing.appendCustomerPriceVersion({
    publicModelId: responsesPublicModelId,
    publicModelVersion: 1,
    providerId,
    productId,
    protocol: 'responses',
    endpoint: RESPONSES_ENDPOINT,
    currency: 'USD',
    commercialPolicyVersion: M1_E2E_COMMERCIAL_POLICY_VERSION,
    calculatorVersion: 'm1-e2e-calculator-v1',
    roundingVersion: M1_E2E_ROUNDING_VERSION,
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
    effectiveAt,
    idempotencyKey: `m1-e2e-customer-price-responses-${label}`,
  });
  await pricing.appendSupplierCostVersion({
    publicModelId,
    publicModelVersion: 1,
    providerId,
    productId,
    resolvedModel: providerModel,
    protocol: 'openai',
    endpoint: ENDPOINT,
    currency: 'USD',
    commercialPolicyVersion: M1_E2E_COMMERCIAL_POLICY_VERSION,
    calculatorVersion: 'm1-e2e-calculator-v1',
    roundingVersion: M1_E2E_ROUNDING_VERSION,
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
    effectiveAt,
    idempotencyKey: `m1-e2e-supplier-cost-${label}`,
  });
  await pricing.appendSupplierCostVersion({
    publicModelId: responsesPublicModelId,
    publicModelVersion: 1,
    providerId,
    productId,
    resolvedModel: responsesProviderModel,
    protocol: 'responses',
    endpoint: RESPONSES_ENDPOINT,
    currency: 'USD',
    commercialPolicyVersion: M1_E2E_COMMERCIAL_POLICY_VERSION,
    calculatorVersion: 'm1-e2e-calculator-v1',
    roundingVersion: M1_E2E_ROUNDING_VERSION,
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
    effectiveAt,
    idempotencyKey: `m1-e2e-supplier-cost-responses-${label}`,
  });

  const platformSupply = new ProviderSupplyService(migrator, {
    deployment: DEPLOYMENT_ID,
    environment: ENVIRONMENT_ID,
    kmsKeyId: 'm1-e2e-kms-key',
    sealingKms: {
      generateDataKey: async () => ({
        plaintextKey: Uint8Array.from(M1_E2E_DEK),
        ciphertextBlob: Buffer.from('m1-e2e-wrapped-dek', 'utf8'),
      }),
    },
  });
  // Platform credential creation requires exactly one capability per account
  // (the auto-validation job is queued per capability), so the chat and
  // responses capabilities each get their own account in the same pool.
  const account = await platformSupply.createPlatformProviderAccount({
    id: `m1-e2e-account-${label}`,
    displayName: 'M1 E2E platform account',
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
  const activatePlatformCredential = async (accountId: string, authzVersion: number, credentialId: string) => {
    const activated = await migrator.query<{ status: string; validation_state: string }>(
      `UPDATE saas_platform_provider_credentials
          SET validation_state = 'verified', validation_error_code = NULL,
              last_validated_at = $1, status = 'active', updated_at = $1,
              authz_version = authz_version + 1
        WHERE id = $2 AND account_id = $3 AND authz_version = $4
        RETURNING status, validation_state`,
      [nowIso, credentialId, accountId, authzVersion],
    );
    if (activated.rows.length !== 1) throw new Error('M1 e2e platform credential activation failed');
  };
  const provisionPlatformAccount = async (
    accountInput: Awaited<ReturnType<typeof platformSupply.createPlatformProviderAccount>>,
  ) => {
    const verified = await platformSupply.setProviderAccountValidation({
      accountId: accountInput.id,
      validationState: 'verified',
      expectedAuthzVersion: accountInput.authzVersion,
    });
    const credential = await platformSupply.createPlatformProviderCredential({
      accountId: verified.id,
      secret: Buffer.from(M1_E2E_PLATFORM_SECRET, 'utf8'),
      audit,
    });
    await activatePlatformCredential(verified.id, credential.credential.authzVersion, credential.credential.id);
    // The scheduler's durable health authority fail-closes on accounts with no
    // runtime health row ("runtime health is unknown"); production gets the
    // initial row from the credential-validation probe. Seed the equivalent
    // healthy probe outcome directly (owner scope 'platform', per migration 040).
    await migrator.query(
      `INSERT INTO saas_provider_account_runtime_health
         (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
          observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
       VALUES ('platform', 'platform', NULL, $1, 'healthy', 0, $2, NULL,
               'probe_success', 1, 1)`,
      [verified.id, nowIso],
    );
    return verified;
  };
  const chatAccount = await provisionPlatformAccount(account);
  const responsesAccount = await provisionPlatformAccount(
    await platformSupply.createPlatformProviderAccount({
      id: `m1-e2e-account-responses-${label}`,
      displayName: 'M1 E2E responses platform account',
      providerId,
      productId,
      credentialType: 'api-key',
      region: 'e2e-region',
      purpose: 'inference',
      rightsId: platformRights.rightsId,
      rightsVersion: platformRights.version,
      capabilities: [
        { model: responsesProviderModel, endpoint: RESPONSES_ENDPOINT, version: responsesCapability.version },
      ],
      audit,
    }),
  );
  const pool = await platformSupply.createPlatformProviderPool({
    id: poolId,
    displayName: 'M1 E2E platform pool',
    providerId,
    productId,
    credentialType: 'api-key',
    region: 'e2e-region',
    purpose: 'inference',
    rightsId: platformRights.rightsId,
    rightsVersion: platformRights.version,
    capabilities: [
      { model: providerModel, endpoint: ENDPOINT, version: capability.version },
      { model: responsesProviderModel, endpoint: RESPONSES_ENDPOINT, version: responsesCapability.version },
    ],
    status: 'active',
    validationState: 'verified',
  });
  for (const member of [chatAccount, responsesAccount]) {
    await platformSupply.addPlatformPoolMember({
      poolId: pool.id,
      accountId: member.id,
      expectedAccountAuthzVersion: member.authzVersion,
    });
  }

  const contractKeyPair = generateKeyPairSync('ed25519');
  const contractKeyId = `m1-e2e-contract-${label}`;
  return {
    poolId,
    publicModel,
    publicModelId,
    providerId,
    productId,
    providerModel,
    responsesPublicModel,
    responsesPublicModelId,
    responsesProviderModel,
    contractKeyId,
    contractPrivateKey: contractKeyPair.privateKey,
    trustedVerifierPublicKeys: new Map([[contractKeyId, contractKeyPair.publicKey]]),
    trustedTestVectorDigests: new Map([['m1-e2e-suite-v1', TEST_VECTOR_DIGEST]]),
  };
}

/**
 * The registration contract-test runner: signs the canonical attestation
 * payload over the provider policy the dispatch service is about to bind.
 * This is the FIN-01 attestation shape routed through the real
 * RegistrationContractTestPort the dispatch completion service consumes.
 */
export function createM1ContractTestPort(seed: M1PlatformSupplySeed): RegistrationContractTestPort {
  return {
    async execute(input) {
      const contractDigest = 'd'.repeat(64);
      const payload = canonicalContractAttestationPayload({
        contractDigest,
        suiteVersion: 'm1-e2e-suite-v1',
        testVectorDigest: TEST_VECTOR_DIGEST,
        providerPolicyId: input.providerPolicyId,
        providerPolicyVersion: '2',
        // Sign over the definition the plan actually asks about, so every
        // model scope (chat and responses) attests its own identity.
        publicModelId: input.definition.publicModelId,
        publicModelVersion: input.definition.publicModelVersion,
        protocol: input.definition.protocol,
        endpoint: input.definition.endpoint,
        supplyMode: 'platform',
        targetMode: 'platform_pool',
        usageDimensions: input.definition.usageDimensions,
        tokenSource: input.definition.tokenSource,
        roundingVersion: input.definition.roundingVersion,
        roundingMode: input.definition.roundingMode,
        roundingBoundary: 'total',
      });
      return {
        contractDigest,
        suiteVersion: 'm1-e2e-suite-v1',
        testVectorDigest: TEST_VECTOR_DIGEST,
        verifierKeyId: seed.contractKeyId,
        signatureBase64: sign(null, Buffer.from(payload), seed.contractPrivateKey).toString('base64'),
      };
    },
  };
}
