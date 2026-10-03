import { createHash, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { SaasCatalogService } from '../../dist/saas/catalog/service.js';
import { SaasCommercialMeteringPolicyService } from '../../dist/saas/gateway/commercial-metering-policy-service.js';
import { PostgresRequestPreparationAuthorityAdapter } from '../../dist/saas/gateway/postgres-request-preparation-authority-adapter.js';
import { canonicalPreparedRequestEvidencePayload } from '../../dist/saas/gateway/prepared-request-evidence-service.js';
import type {
  PreparedRequestEvidenceAudit,
  PreparedRequestEvidenceInput,
  PreparedRequestEvidenceRecord,
} from '../../src/saas/gateway/prepared-request-evidence-service.js';
import { ProviderHttpTransport } from '../../dist/saas/gateway/provider-http-transport.js';
import { ProviderPayloadCompiler } from '../../dist/saas/gateway/provider-payload-compiler.js';
import {
  allowRequestPreparation,
  rejectRequestPreparation,
} from '../../dist/saas/gateway/request-preparation-service.js';
import type {
  RequestPreparationAdmissionPort,
  RequestPreparationAttemptPersistenceInput,
} from '../../src/saas/gateway/request-preparation-service.js';
import { SaasRouteConfigService } from '../../dist/saas/gateway/route-config-service.js';
import { KeyService } from '../../dist/saas/keys/service.js';
import type { KnownNonSuccessHttpResponseInput } from '../../src/saas/metering/service.js';
import type { AttemptRecord, AttemptTransitionInput } from '../../src/saas/metering/types.js';
import { createManagedSaasGatewayComposition } from '../../dist/server/managed-saas-gateway.js';
import { normalizeUsage } from '../../dist/telemetry/usage.js';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = '30000000-0000-4000-8000-000000000001';
const KEY = `mr_live_${'A'.repeat(43)}`;
const TENANT_ID = 'tenant-e2e';
const PROJECT_ID = 'project-e2e';
const KEY_ID = 'key-e2e';
const ENTITLEMENT_ID = 'entitlement-e2e';
const PROFILE_ID = 'profile-e2e';
const PUBLIC_MODEL = 'public-e2e-model';
const PROVIDER_MODEL = 'provider-e2e-model';
const ENDPOINT = '/v1/chat/completions';
const HASH = 'a'.repeat(64);
const STREAMING_RESPONSE_FRAMES = [
  'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
  'data: {"choices":[{"delta":{"content":"first"},"index":0}]}\n\n',
  'data: {"choices":[{"delta":{"content":" second"},"index":0}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
  'data: [DONE]\n\n',
] as const;
const STREAMING_RESPONSE_BODY = STREAMING_RESPONSE_FRAMES.join('');

// These are domain-record views, not saas_attempts SQL rows. The three display
// fields come from the bound saas_requests projection; neither supply_mode nor
// route_upstream_id is fabricated as an attempt-table column.
type FixtureAttempt = AttemptRecord & {
  readonly projectId: string;
  readonly publicModel: string;
  readonly supplyMode: 'byok' | 'platform';
};
type FixtureEvidence = PreparedRequestEvidenceRecord &
  Omit<PreparedRequestEvidenceInput, 'evidenceId' | 'credentialVersion' | 'expiresAt'>;
type FixtureAudit = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  entryPoint: string;
  requestId: string | null;
};
type FixtureKnownNonSuccessResponse = {
  readonly input: KnownNonSuccessHttpResponseInput;
  outcome: 'attempted' | 'recorded' | 'replayed' | 'rejected';
  beforeAttemptVersion: number | null;
  afterAttemptVersion: number | null;
};

type FixtureState = {
  requests: Map<string, Record<string, unknown>>;
  attempts: Map<string, FixtureAttempt>;
  evidence: Map<string, FixtureEvidence>;
  holds: Array<Record<string, unknown>>;
  auditEvents: FixtureAudit[];
  attemptReads: AttemptRecord[];
  attemptTransitions: AttemptTransitionInput[];
  knownNonSuccessResponses: FixtureKnownNonSuccessResponse[];
  authorityQueries: string[];
  dispatches: Array<Record<string, unknown>>;
  upstreamCalls: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function platformPoolCandidate(): Record<string, unknown> {
  return {
    grant_tenant_id: TENANT_ID,
    grant_profile_id: PROFILE_ID,
    grant_supply_mode: 'platform',
    grant_status: 'active',
    grant_effective_at: '2026-01-01T00:00:00.000Z',
    grant_expires_at: null,
    grant_authz_version: '15',
    grant_profile_authz_version: '1',
    grant_pool_authz_version: '16',
    grant_evidence_ref: 'fixture-grant-evidence',
    grant_evidence_sha256: HASH,
    pool_id: 'pool-e2e',
    pool_provider_id: 'provider-e2e',
    pool_product_id: 'product-e2e',
    pool_status: 'active',
    pool_validation_state: 'verified',
    pool_authz_version: '16',
    pool_credential_type: 'api-key',
    pool_region: 'local-test',
    pool_purpose: 'inference',
    pool_rights_id: 'pool-rights-e2e',
    pool_rights_version: '17',
    account_id: 'account-e2e',
    member_provider_id: 'provider-e2e',
    member_product_id: 'product-e2e',
    member_status: 'active',
    member_authz_version: '18',
    member_account_authz_version: '19',
    account_owner_kind: 'platform',
    account_supply_mode: 'platform',
    account_provider_id: 'provider-e2e',
    account_product_id: 'product-e2e',
    credential_type: 'api-key',
    region: 'local-test',
    purpose: 'inference',
    account_rights_id: 'account-rights-e2e',
    account_rights_version: '12',
    account_status: 'active',
    account_validation_state: 'verified',
    account_authz_version: '19',
    credential_owner_kind: 'platform',
    credential_supply_mode: 'platform',
    credential_id: 'credential-e2e',
    credential_account_id: 'account-e2e',
    credential_provider_id: 'provider-e2e',
    credential_product_id: 'product-e2e',
    credential_status: 'active',
    credential_validation_state: 'verified',
    credential_current_version: '20',
    credential_expires_at: null,
    credential_authz_version: '21',
    version_owner_kind: 'platform',
    version_supply_mode: 'platform',
    version_credential_id: 'credential-e2e',
    credential_version: '20',
    version_status: 'active',
    version_expires_at: null,
  };
}

function rights(rightsId: string): Record<string, unknown> {
  return {
    rights_id: rightsId,
    version: rightsId === 'pool-rights-e2e' ? '17' : '12',
    provider_id: 'provider-e2e',
    product_id: 'product-e2e',
    credential_type: 'api-key',
    supply_mode: 'platform',
    region: 'local-test',
    purpose: 'inference',
    model_scope: [PROVIDER_MODEL],
    endpoint_scope: [ENDPOINT],
    effective_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    approval_ref: 'approved-for-test-only',
    evidence_ref: `fixture-${rightsId}`,
    evidence_sha256: HASH,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeDatabase(state: FixtureState) {
  const keyRow = {
    id: KEY_ID,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    principal_user_id: 'member-e2e',
    execution_principal_type: 'member',
    execution_principal_id: 'member-e2e',
    created_by_user_id: 'member-e2e',
    rotated_by_user_id: null,
    revoked_by_user_id: null,
    entitlement_id: ENTITLEMENT_ID,
    supply_profile_id: PROFILE_ID,
    supply_mode: 'platform',
    name: 'HTTP e2e key',
    prefix: KEY.slice(0, 20),
    model_scopes: [PUBLIC_MODEL],
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    authz_version: 1,
    model_scope_version: 1,
    entitlement_authz_version: 1,
    supply_profile_authz_version: 1,
  };

  const routeRow = {
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    route_id: 'route-e2e',
    version: '8',
    status: 'active',
    public_model_id: 'public-model-e2e',
    public_model_version: '9',
    protocol: 'openai',
    supply_mode: 'platform',
    target_mode: 'platform_pool',
    upstream_id: 'upstream-e2e',
    endpoint: ENDPOINT,
    changed_by_user_id: 'operator-e2e',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const providerMeteringPolicyRow = {
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    policy_id: 'provider-policy-e2e',
    version: '3',
    status: 'active',
    public_model_id: 'public-model-e2e',
    public_model_version: '9',
    provider_id: 'provider-e2e',
    product_id: 'product-e2e',
    resolved_model: PROVIDER_MODEL,
    protocol: 'openai',
    endpoint: ENDPOINT,
    supply_mode: 'platform',
    target_mode: 'platform_pool',
    usage_dimensions: ['input_total', 'output_total'],
    token_source: 'upstream',
    rounding_version: 'e2e-rounding-v1',
    rounding_mode: 'half_up',
    rounding_boundary: 'total',
    commercial_policy_version: 'e2e-commercial-v1',
    supplier_cost_version: 'cost-e2e-v1',
    changed_by_user_id: 'operator-e2e',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const accountRight = rights('account-rights-e2e');
  const poolRight = rights('pool-rights-e2e');

  const query = async (sql: string, values: readonly unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    state.authorityQueries.push(normalized);
    let rows: Record<string, unknown>[];
    let affectedRows: number | undefined;
    if (normalized.startsWith('SET TRANSACTION')) {
      rows = [];
    } else if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
      rows = [];
    } else if (normalized.includes('FROM saas_api_keys')) {
      rows = values.includes(sha256(KEY)) ? [keyRow] : [];
    } else if (normalized.includes('SELECT clock_timestamp() AS authority_now')) {
      rows = [{ authority_now: new Date().toISOString() }];
    } else if (normalized.includes('FROM saas_route_config_heads h')) {
      rows = [routeRow];
    } else if (normalized.includes('FROM saas_public_model_versions v')) {
      rows = [
        {
          public_model_id: 'public-model-e2e',
          version: '9',
          alias: PUBLIC_MODEL,
          model_status: 'active',
          provider_id: 'provider-e2e',
          product_id: 'product-e2e',
          model: PROVIDER_MODEL,
          endpoint_scope: [ENDPOINT],
          version_status: 'active',
        },
      ];
    } else if (normalized.includes('FROM saas_route_config_dispatchable')) {
      rows = [
        {
          tenant_id: TENANT_ID,
          project_id: PROJECT_ID,
          route_id: 'route-e2e',
          version: '8',
          customer_policy_id: 'customer-policy-e2e',
          customer_policy_version: '2',
          provider_policy_id: 'provider-policy-e2e',
          provider_policy_version: '3',
          contract_attestation_id: 'attestation-e2e',
          customer_price_version: 'price-e2e-v1',
          supplier_cost_version: 'cost-e2e-v1',
        },
      ];
    } else if (normalized.startsWith('SELECT * FROM saas_provider_metering_policy_versions')) {
      rows = values[2] === 'provider-policy-e2e' && String(values[3]) === '3' ? [providerMeteringPolicyRow] : [];
    } else if (normalized.includes('FROM saas_supply_profiles')) {
      rows = [
        {
          tenant_id: TENANT_ID,
          id: PROFILE_ID,
          supply_mode: 'platform',
          status: 'active',
          authz_version: '1',
          model_scopes: [PUBLIC_MODEL],
        },
      ];
    } else if (normalized.includes('preparation-authority:platform')) {
      rows = [platformPoolCandidate()];
    } else if (normalized.includes('preparation-authority:account-capability')) {
      rows = [{ capability_version: '11' }];
    } else if (normalized.includes('FROM saas_provider_products')) {
      rows = [
        {
          provider_id: 'provider-e2e',
          product_id: 'product-e2e',
          display_name: 'Local fixture',
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ];
    } else if (normalized.includes('FROM saas_provider_capabilities')) {
      rows = [{ protocol: 'openai', version: '11', support_level: 'supported', validation_state: 'verified' }];
    } else if (normalized.includes('FROM saas_provider_rights')) {
      rows = normalized.includes('WHERE rights_id = $1 AND version = $2') ? [poolRight] : [accountRight];
    } else if (normalized.startsWith('INSERT INTO saas_audit_events')) {
      // Mirror PreparedRequestEvidenceService.audit's eleven positional fields.
      // In particular action/target are $4/$6, not claim-version parameters.
      if (
        values.length !== 11 ||
        typeof values[0] !== 'string' || typeof values[1] !== 'string' ||
        (values[2] !== null && typeof values[2] !== 'string') ||
        typeof values[3] !== 'string' || typeof values[4] !== 'string' ||
        typeof values[5] !== 'string' || typeof values[6] !== 'string' ||
        (values[7] !== null && typeof values[7] !== 'string') ||
        (values[8] !== null && typeof values[8] !== 'string') ||
        typeof values[9] !== 'string' ||
        (values[10] !== null && typeof values[10] !== 'string')
      ) throw new Error('invalid fixture evidence audit');
      state.auditEvents.push({
        id: values[0], tenantId: values[1], actorUserId: values[2],
        action: values[3], targetType: values[4], targetId: values[5],
        occurredAt: values[6], entryPoint: values[9], requestId: values[10],
      });
      rows = [];
      affectedRows = 1;
    } else {
      throw new Error(`Unexpected SQL in deterministic gateway fixture: ${normalized}`);
    }
    return { rows: structuredClone(rows), rowCount: affectedRows ?? rows.length };
  };
  const executor = { query };
  return {
    query,
    transaction: async <T>(work: (tx: typeof executor) => Promise<T>) => {
      const snapshot = structuredClone({
        requests: state.requests, attempts: state.attempts, evidence: state.evidence,
        holds: state.holds, auditEvents: state.auditEvents,
      });
      try {
        return await work(executor);
      } catch (error) {
        // Keep map identities: the fixture ports hold references to them.
        state.requests.clear();
        for (const [id, row] of snapshot.requests) state.requests.set(id, row);
        state.attempts.clear();
        for (const [id, row] of snapshot.attempts) state.attempts.set(id, row);
        state.evidence.clear();
        for (const [id, row] of snapshot.evidence) state.evidence.set(id, row);
        state.holds.splice(0, state.holds.length, ...snapshot.holds);
        state.auditEvents.splice(0, state.auditEvents.length, ...snapshot.auditEvents);
        throw error;
      }
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
}

function makeAttempt(input: RequestPreparationAttemptPersistenceInput, state: FixtureState): FixtureAttempt {
  const request = state.requests.get(input.requestId);
  if (
    !request || request.id !== input.requestId || request.tenantId !== input.caller.tenantId ||
    request.projectId !== input.caller.projectId || request.publicModel !== input.publicModel ||
    (request.supplyMode !== 'byok' && request.supplyMode !== 'platform') ||
    request.supplyMode !== input.authority.candidate.supplyMode
  ) throw new Error('fixture attempt is not bound to its request');
  const candidate = input.authority.candidate;
  const pool = candidate.supplyMode === 'platform' ? candidate : null;
  const createdAt = new Date().toISOString();
  return {
    id: input.attemptId,
    tenantId: input.caller.tenantId,
    projectId: request.projectId,
    requestId: input.requestId,
    ordinal: input.admission.attemptOrdinal,
    supplyMode: request.supplyMode,
    projectPolicyVersion: String(input.entitlement.projectPolicyVersion),
    customerPriceVersion: input.authority.commercial.customerPriceVersion,
    customerMeteringPolicyId: input.authority.commercial.customerMeteringPolicyId,
    customerMeteringPolicyVersion: String(input.authority.commercial.customerMeteringPolicyVersion),
    providerMeteringPolicyId: input.authority.commercial.providerMeteringPolicyId,
    providerMeteringPolicyVersion: String(input.authority.commercial.providerMeteringPolicyVersion),
    contractAttestationId: input.authority.commercial.contractAttestationId,
    routeConfigId: input.authority.route.routeConfigId,
    routeConfigVersion: String(input.authority.route.routeConfigVersion),
    routePublicModelId: input.authority.route.publicModelId,
    routePublicModelVersion: String(input.authority.route.publicModelVersion),
    routeProtocol: input.authority.route.protocol,
    routeTargetMode: input.authority.route.targetMode,
    publicModel: request.publicModel,
    protocol: input.protocol,
    endpoint: input.authority.route.endpoint,
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: candidate.accountOwnerKind,
    upstreamId: input.authority.candidate.upstreamId,
    accountId: input.authority.candidate.accountId,
    credentialId: input.authority.candidate.credentialId,
    providerId: input.authority.candidate.providerId,
    productId: input.authority.candidate.productId,
    resolvedModel: input.authority.candidate.resolvedModel,
    modelResolution: structuredClone(input.modelResolution),
    clientProtocol: input.clientProtocol,
    providerProtocol: input.providerProtocol,
    clientOperation: input.clientOperation,
    providerOperation: input.providerOperation,
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: input.requestFingerprintVersion,
    payloadSha256: input.payloadSha256,
    payloadCompilerVersion: input.payloadCompilerVersion,
    usageEstimatorVersion: input.usageEstimatorVersion,
    dispatchProfileId: candidate.dispatchProfileId,
    supplyProfileAuthzVersion: String(candidate.supplyProfileAuthzVersion),
    credentialVersion: String(candidate.credentialVersion),
    credentialAuthzVersion: String(candidate.credentialAuthzVersion),
    accountAuthzVersion: String(candidate.accountAuthzVersion),
    profileAccountAuthzVersion: candidate.supplyMode === 'byok' ? String(candidate.profileAccountAuthzVersion) : null,
    poolId: pool?.poolId ?? null,
    poolAuthzVersion: pool === null ? null : String(pool.poolAuthzVersion),
    poolMemberAccountAuthzVersion: pool === null ? null : String(pool.poolMemberAccountAuthzVersion),
    poolMemberAuthzVersion: pool === null ? null : String(pool.poolMemberAuthzVersion ?? input.authority.poolMemberAuthzVersion),
    poolGrantAuthzVersion: pool === null ? null : String(pool.poolGrantAuthzVersion),
    poolGrantProfileAuthzVersion: pool === null ? null : String(pool.poolGrantProfileAuthzVersion),
    poolGrantPoolAuthzVersion: pool === null ? null : String(pool.poolGrantPoolAuthzVersion),
    supplierCostVersion: input.authority.commercial.supplierCostVersion,
    preparedEvidenceId: null,
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: null,
    createdAt,
    updatedAt: createdAt,
    stateVersion: 1,
  };
}

async function startFixture(options: { streaming?: boolean } = {}) {
  const state: FixtureState = {
    requests: new Map(),
    attempts: new Map(),
    evidence: new Map(),
    holds: [],
    auditEvents: [],
    attemptReads: [],
    attemptTransitions: [],
    knownNonSuccessResponses: [],
    authorityQueries: [],
    dispatches: [],
    upstreamCalls: [],
  };
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    state.upstreamCalls.push({ authorization: req.headers.authorization, body });
    if (options.streaming) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-request-id': 'provider-controlled-request-id',
      });
      for (const frame of STREAMING_RESPONSE_FRAMES) res.write(frame);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'provider-controlled-request-id',
    });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-local-e2e',
        model: PROVIDER_MODEL,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'deterministic local reply' }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('local upstream did not bind');

  const database = makeDatabase(state);
  const authenticator = new KeyService(database as never, { resolver: { resolve: async () => null } } as never);
  const routes = new SaasRouteConfigService(database as never);
  const commercial = new SaasCommercialMeteringPolicyService(database as never);
  const catalog = new SaasCatalogService(database as never);
  const authority = new PostgresRequestPreparationAuthorityAdapter({
    database: database as never,
    routes,
    commercial,
    catalog,
    byokEntitlements: { resolveBoundForRequest: async () => null },
  } as never);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const resolver = {
    async validate({ authenticatedCaller, publicModel }: { authenticatedCaller: any; publicModel: string }) {
      const key = authenticatedCaller?.authorization;
      if (!key || key.supplyMode !== 'platform' || !key.modelScopes.includes(publicModel)) {
        return rejectRequestPreparation('caller_denied', 'fixture key binding rejected');
      }
      return allowRequestPreparation({
        tenantId: key.tenantId,
        projectId: key.projectId,
        proxyKeyId: key.keyId,
        principalKind: key.principalKind,
        principalId: key.principalId,
        entitlementId: key.entitlementId,
        supplyProfileId: key.supplyProfileId,
        supplyMode: key.supplyMode,
        modelScopes: [...key.modelScopes],
        authzVersion: key.authzVersion,
        entitlementVersion: key.entitlementAuthzVersion,
        supplyProfileVersion: key.supplyProfileAuthzVersion,
        modelScopeVersion: key.modelScopeVersion,
      });
    },
  };
  const entitlement = {
    async resolve({ caller, publicModel }: { caller: any; publicModel: string }) {
      if (
        caller.entitlementId !== ENTITLEMENT_ID ||
        caller.projectId !== PROJECT_ID ||
        ![PUBLIC_MODEL].includes(publicModel)
      ) {
        return rejectRequestPreparation('entitlement_denied', 'fixture project entitlement rejected');
      }
      return allowRequestPreparation({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        proxyKeyId: KEY_ID,
        entitlementId: ENTITLEMENT_ID,
        entitlementVersion: 1,
        supplyProfileId: PROFILE_ID,
        supplyProfileVersion: 1,
        supplyMode: 'platform',
        modelScopeVersion: 1,
        allowedModels: [PUBLIC_MODEL],
        allowedProviderIds: [],
        projectPolicyVersion: 1,
      });
    },
  };
  const payload = new ProviderPayloadCompiler({
    estimator: {
      version: 'e2e-estimator-v1',
      estimate: async () => ({
        inputTotalUpperBound: 20,
        inputUncachedUpperBound: 20,
        cacheReadUpperBound: 0,
        cacheWriteUpperBound: 0,
        cacheWrite5mUpperBound: 0,
        cacheWrite1hUpperBound: 0,
        outputTotalUpperBound: 8,
        reasoningOutputUpperBound: 0,
        feasibleInputBuckets: ['input'],
      }),
    },
    modelCompatibility: async () => true,
    maxPayloadBytes: 16_384,
    compilerVersion: 'e2e-compiler-v1',
    allowIdentityModelResolution: false,
  } as never);
  const { privateKey: signerPrivateKey, publicKey: signerPublicKey } = { privateKey, publicKey };
  const attemptMap = state.attempts;
  const gateway = createManagedSaasGatewayComposition({
    authenticator,
    preparation: {
      caller: resolver,
      entitlement,
      authority,
      scheduler: { select: async ({ candidates }: { candidates: any[] }) => allowRequestPreparation(candidates[0]) },
      payload,
      admission: {
        async authorizeAndReserve(input: Parameters<RequestPreparationAdmissionPort['authorizeAndReserve']>[0]) {
          const observedNow = Date.now();
          const expiresAt = new Date(observedNow + 60_000).toISOString();
          const admission = {
            idempotencyBinding: {
              state: 'created',
              keyDigest: sha256(String(input.idempotencyKey)),
              requestFingerprint: input.requestFingerprint,
              requestFingerprintVersion: input.requestFingerprintVersion,
              tenantId: input.tenantId,
              projectId: input.projectId,
              proxyKeyId: input.proxyKeyId,
              requestId: input.requestId,
            },
            quotaReservation: { reference: 'quota:e2e', state: 'reserved' },
            rateReservation: { reference: 'rate:e2e', state: 'reserved' },
            holdReservation: {
              reference: 'hold:e2e',
              state: 'reserved',
              reservationId: 'reservation-e2e',
              tenantId: input.caller.tenantId,
              requestId: input.requestId,
              currency: 'USD',
              amountMinorUnits: '5',
              priceSnapshotRef: 'price-e2e-v1',
              expiresAt,
            },
            deadlineAtMs: observedNow + 30_000,
            dispatchDeadline: new Date(observedNow + 30_000).toISOString(),
            expiresAt,
            remainingAttempts: 1,
            retryBudget: 0,
            attemptOrdinal: 1,
            usageBudget: { unit: 'tokens', amount: 28, basis: 'reserved' },
          };
          state.requests.set(input.requestId, {
            id: input.requestId,
            tenantId: input.caller.tenantId,
            projectId: input.caller.projectId,
            proxyKeyId: input.caller.proxyKeyId,
            entitlementId: input.caller.entitlementId,
            supplyProfileId: input.caller.supplyProfileId,
            supplyMode: input.caller.supplyMode,
            protocol: input.authority.route.protocol,
            requestFingerprint: input.requestFingerprint,
            requestFingerprintVersion: input.requestFingerprintVersion,
            routeConfigId: input.authority.route.routeConfigId,
            routeConfigVersion: input.authority.route.routeConfigVersion,
            publicModel: input.authority.route.publicModel,
            providerId: input.authority.candidate.providerId,
            productId: input.authority.candidate.productId,
            resolvedModel: input.authority.candidate.resolvedModel,
            customerPriceVersion: input.authority.commercial.customerPriceVersion,
            executionState: 'pending',
            reconciliationState: 'none',
            financialStatus: 'pending',
            stateVersion: 1,
            updatedAt: new Date(observedNow).toISOString(),
            usage: null,
          });
          state.holds.push({ requestId: input.requestId, state: 'reserved', amountMinorUnits: '5' });
          return allowRequestPreparation(admission);
        },
      },
      attempt: {
        async persist(input: RequestPreparationAttemptPersistenceInput) {
          const row = makeAttempt(input, state);
          attemptMap.set(input.attemptId, row);
          return allowRequestPreparation({
            tenantId: input.caller.tenantId,
            projectId: input.caller.projectId,
            proxyKeyId: input.caller.proxyKeyId,
            requestId: input.requestId,
            attemptId: input.attemptId,
            attemptOrdinal: input.admission.attemptOrdinal,
            publicModel: input.publicModel,
            protocol: input.protocol,
            endpoint: input.authority.route.endpoint,
            routeConfigId: input.authority.route.routeConfigId,
            routeConfigVersion: input.authority.route.routeConfigVersion,
            supplyMode: input.authority.candidate.supplyMode,
            upstreamId: input.authority.candidate.upstreamId,
            accountId: input.authority.candidate.accountId,
            credentialId: input.authority.candidate.credentialId,
            resolvedModel: input.authority.candidate.resolvedModel,
            modelResolution: input.modelResolution,
            clientProtocol: input.clientProtocol,
            providerProtocol: input.providerProtocol,
            clientOperation: input.clientOperation,
            providerOperation: input.providerOperation,
            requestFingerprint: input.requestFingerprint,
            requestFingerprintVersion: input.requestFingerprintVersion,
            payloadSha256: input.payloadSha256,
            payloadCompilerVersion: input.payloadCompilerVersion,
            usageEstimatorVersion: input.usageEstimatorVersion,
            dispatchAuthorityState: 'bound',
            dispatchState: 'not_sent',
            resultState: 'pending',
            responseStarted: false,
            preparedEvidenceId: null,
          });
        },
      },
      transaction: database,
      compensation: {
        releasePreDispatch: async () =>
          allowRequestPreparation({
            requestId: REQUEST_ID,
            attemptId: ATTEMPT_ID,
            disposition: 'released',
            quotaReservation: 'released',
            rateReservation: 'released',
            holdReservation: 'released',
            manualReconciliationRequired: false,
          }),
      },
      signer: {
        async sign(input: { canonicalPayload: string }) {
          return allowRequestPreparation({
            signatureBase64: signBytes(null, Buffer.from(input.canonicalPayload), signerPrivateKey).toString('base64'),
          });
        },
      },
      registrar: {
        async register(input: PreparedRequestEvidenceInput) {
          const canonical = canonicalPreparedRequestEvidencePayload(input);
          if (
            !verifyBytes(null, Buffer.from(canonical), signerPublicKey, Buffer.from(input.signatureBase64, 'base64'))
          ) {
            throw new Error('prepared evidence signature did not verify');
          }
          const record: FixtureEvidence = {
            ...input,
            evidenceId: input.evidenceId ?? EVIDENCE_ID,
            ...(input.modelResolution === undefined ? {} : {
              requestedModel: input.modelResolution.requestedModel,
              mappedModel: input.modelResolution.mappedModel,
            }),
            credentialVersion: String(input.credentialVersion),
            expiresAt: new Date(input.expiresAt instanceof Date ? input.expiresAt.getTime() : input.expiresAt).toISOString(),
            statementSha256: sha256(canonical),
            status: 'registered',
            claimedAt: null,
            claimedAttemptId: null,
          };
          state.evidence.set(record.evidenceId, structuredClone(record));
          return structuredClone(record);
        },
      },
    } as never,
    preparationOptions: {
      evidenceVerifierKeyId: 'e2e-verifier',
      idFactory: {
        requestId: () => REQUEST_ID,
        attemptId: () => ATTEMPT_ID,
        evidenceId: () => EVIDENCE_ID,
      },
    },
    dispatch: {
      evidence: {
        async preflightForDispatch(evidenceId: string, _audit: unknown, options: { payloadSha256?: string }) {
          const record = state.evidence.get(evidenceId);
          if (!record || record.status !== 'registered' || record.payloadSha256 !== options.payloadSha256)
            throw new Error('evidence preflight failed');
          return structuredClone(record);
        },
        async claimForDispatch(evidenceId: string, audit: PreparedRequestEvidenceAudit, options: { payloadSha256?: string }) {
          return database.transaction(async (tx) => {
            const record = state.evidence.get(evidenceId);
            const attempt = record === undefined ? undefined : attemptMap.get(record.attemptId);
            const request = record === undefined ? undefined : state.requests.get(record.requestId);
            const claimedAt = new Date().toISOString();
            const expiresAtMs = record === undefined ? NaN : Date.parse(record.expiresAt);
            const deadlineAtMs = record === undefined ? NaN : record.dispatchDeadline instanceof Date
              ? record.dispatchDeadline.getTime() : Date.parse(record.dispatchDeadline);
            if (
              !record || record.status !== 'registered' || record.payloadSha256 !== options.payloadSha256 ||
              !Number.isFinite(expiresAtMs) || !Number.isFinite(deadlineAtMs) ||
              expiresAtMs <= Date.parse(claimedAt) || deadlineAtMs <= Date.parse(claimedAt) ||
              !request || request.id !== record.requestId || request.tenantId !== record.tenantId ||
              request.projectId !== record.projectId || request.proxyKeyId !== record.proxyKeyId ||
              request.entitlementId !== record.entitlementId || request.supplyProfileId !== record.supplyProfileId ||
              request.supplyMode !== record.supplyMode || request.publicModel !== record.publicModel ||
              request.protocol !== record.protocol || request.requestFingerprint !== record.requestFingerprint ||
              request.requestFingerprintVersion !== record.requestFingerprintVersion ||
              request.providerId !== record.providerId || request.productId !== record.productId ||
              request.resolvedModel !== record.resolvedModel ||
              !attempt || attempt.tenantId !== record.tenantId || attempt.requestId !== record.requestId ||
              attempt.ordinal !== record.attemptOrdinal || attempt.bindingState !== 'bound' ||
              attempt.dispatchAuthorityState !== 'bound' || attempt.preparedEvidenceId !== null ||
              attempt.dispatchState !== 'not_sent' || attempt.resultState !== 'pending' ||
              attempt.responseStarted !== false || attempt.responseStartedAt !== null ||
              attempt.resultHttpStatus !== null || attempt.unknownReason !== null ||
              !Number.isSafeInteger(attempt.stateVersion) || attempt.stateVersion < 1
            ) throw new Error('evidence claim failed');
            // The real claim is one transaction: evidence binding, version +1,
            // GREATEST(updated_at, DB clock), evidence status, and its audit.
            attemptMap.set(attempt.id, {
              ...attempt,
              preparedEvidenceId: record.evidenceId,
              stateVersion: attempt.stateVersion + 1,
              updatedAt: new Date(Math.max(Date.parse(attempt.updatedAt), Date.parse(claimedAt))).toISOString(),
            });
            const claimed: FixtureEvidence = {
              ...record, status: 'claimed', claimedAttemptId: attempt.id, claimedAt,
            };
            state.evidence.set(record.evidenceId, claimed);
            await tx.query(
              'INSERT INTO saas_audit_events ' +
                '(id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, ' +
                'source_ip, user_agent, entry_point, request_id) ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
              ['40000000-0000-4000-8000-000000000001', record.tenantId, audit.actorUserId,
                'saas_prepared_request_evidence.claimed', 'saas_prepared_request_evidence', record.evidenceId,
                claimedAt, audit.sourceIp ?? null, audit.userAgent ?? null, audit.entryPoint, audit.requestId ?? null],
            );
            return structuredClone(claimed);
          });
        },
      },
      metering: {
        async getAttempt(tenantId: string, requestId: string, attemptId: string) {
          const row = attemptMap.get(attemptId);
          if (!row || row.tenantId !== tenantId || row.requestId !== requestId) return null;
          // No object alias can make a pre-claim read appear to be post-claim.
          state.attemptReads.push(structuredClone(row));
          return structuredClone(row);
        },
        async transitionAttempt(input: AttemptTransitionInput) {
          const row = attemptMap.get(input.attemptId);
          if (
            !row || row.tenantId !== input.tenantId || row.requestId !== input.requestId ||
            row.dispatchState !== input.expectedDispatchState ||
            row.resultState !== input.expectedResultState ||
            row.responseStarted !== input.expectedResponseStarted ||
            input.expectedStateVersion !== row.stateVersion
          )
            throw new Error('attempt transition conflict');
          const dispatchState = input.dispatchState ?? row.dispatchState;
          const resultState = input.resultState ?? row.resultState;
          const responseStarted = input.responseStarted ?? row.responseStarted;
          if (row.responseStarted && !responseStarted) throw new Error('attempt response transition conflict');
          // This bounded fixture models the real dispatcher's send/uncertainty
          // transitions, not an unrestricted "accept any requested state" port.
          const claimedEvidence = state.evidence.get(row.preparedEvidenceId ?? '');
          const dispatching = row.dispatchState === 'not_sent' && dispatchState === 'dispatching' &&
            row.resultState === 'pending' && resultState === 'pending' && !responseStarted &&
            row.bindingState === 'bound' && row.dispatchAuthorityState === 'bound' &&
            row.responseStartedAt === null && row.resultHttpStatus === null && row.unknownReason === null &&
            claimedEvidence?.status === 'claimed' && claimedEvidence.claimedAttemptId === row.id &&
            claimedEvidence.tenantId === row.tenantId && claimedEvidence.requestId === row.requestId;
          const sent = row.dispatchState === 'dispatching' && dispatchState === 'sent' &&
            row.resultState === 'pending' && resultState === 'pending';
          const unknown = (row.dispatchState === 'dispatching' || row.dispatchState === 'sent') &&
            dispatchState === 'unknown' && resultState === 'unknown' &&
            typeof input.unknownReason === 'string' && input.unknownReason.trim() !== '' &&
            input.unknownReason.length <= 1024;
          if (!dispatching && !sent && !unknown) throw new Error('invalid fixture attempt transition');
          if (
            input.resultHttpStatus !== undefined && input.resultHttpStatus !== null &&
            (!Number.isInteger(input.resultHttpStatus) || input.resultHttpStatus < 200 || input.resultHttpStatus > 599)
          ) throw new Error('invalid fixture attempt HTTP status');
          const updatedAt = new Date(Math.max(Date.now(), Date.parse(row.updatedAt))).toISOString();
          const updated: FixtureAttempt = {
            ...row,
            dispatchState,
            resultState,
            responseStarted,
            responseStartedAt: row.responseStarted ? row.responseStartedAt : responseStarted ? updatedAt : null,
            resultHttpStatus: input.resultHttpStatus === undefined ? row.resultHttpStatus : input.resultHttpStatus,
            unknownReason: unknown ? input.unknownReason ?? null : null,
            updatedAt,
            stateVersion: row.stateVersion + 1,
          };
          state.attemptTransitions.push(structuredClone(input));
          attemptMap.set(updated.id, updated);
          return structuredClone(updated);
        },
        async recordKnownNonSuccessHttpResponse(input: KnownNonSuccessHttpResponseInput): Promise<AttemptRecord> {
          // Call evidence is not durable DB state: retain rejected/rolled-back
          // calls too, so the successful cases' zero count cannot hide a call.
          const call: FixtureKnownNonSuccessResponse = {
            input: structuredClone(input), outcome: 'attempted',
            beforeAttemptVersion: null, afterAttemptVersion: null,
          };
          state.knownNonSuccessResponses.push(call);
          try {
            if (
              [input.tenantId, input.requestId, input.attemptId].some(
                (value) => typeof value !== 'string' || value.trim() === '' || value.trim().length > 255,
              ) ||
              !Number.isSafeInteger(input.resultHttpStatus) || input.resultHttpStatus < 300 || input.resultHttpStatus > 599 ||
              typeof input.responseStarted !== 'boolean'
            ) throw new Error('invalid fixture known non-success response');
            const tenantId = input.tenantId.trim();
            const requestId = input.requestId.trim();
            const attemptId = input.attemptId.trim();
            let replayed = false;
            const result = await database.transaction(async () => {
              const attempt = attemptMap.get(attemptId);
              const request = state.requests.get(requestId);
              if (
                !attempt || !request || attempt.id !== attemptId || attempt.tenantId !== tenantId ||
                attempt.requestId !== requestId || request.id !== requestId || request.tenantId !== tenantId
              ) throw new Error('fixture known non-success attempt not found');
              call.beforeAttemptVersion = attempt.stateVersion;
              const supplyMode = request.supplyMode;
              if (supplyMode !== 'platform' && supplyMode !== 'byok')
                throw new Error('invalid fixture known non-success supply mode');
              const financialStatus = supplyMode === 'platform' ? 'reconciliation_pending' : 'not_applicable';
              const retainHold = () => {
                if (supplyMode === 'byok') return;
                const holds = state.holds.filter((hold) => hold.requestId === requestId);
                const hold = holds[0];
                if (holds.length !== 1 || !hold || (hold.state !== 'reserved' && hold.state !== 'reconciliation_pending'))
                  throw new Error('fixture known non-success hold conflict');
                // Keep the same reservation/amount; no charge, release or wallet.
                hold.state = 'reconciliation_pending';
              };
              if (
                attempt.dispatchState === 'sent' && attempt.resultState === 'failed' &&
                request.executionState === 'failed' && request.reconciliationState === 'none' &&
                request.financialStatus === financialStatus
              ) {
                if (attempt.resultHttpStatus !== input.resultHttpStatus)
                  throw new Error('fixture known non-success replay conflict');
                retainHold();
                replayed = true;
                return structuredClone(attempt);
              }
              if (
                (attempt.dispatchState !== 'dispatching' && attempt.dispatchState !== 'sent') ||
                attempt.resultState !== 'pending' || request.executionState !== 'pending' ||
                request.reconciliationState !== 'none' ||
                (supplyMode === 'platform' && request.financialStatus !== 'pending' && request.financialStatus !== 'reconciliation_pending') ||
                (supplyMode === 'byok' && request.financialStatus !== 'not_applicable') ||
                !Number.isSafeInteger(attempt.stateVersion) || attempt.stateVersion < 1 ||
                !Number.isSafeInteger(attempt.stateVersion + 1) ||
                typeof request.stateVersion !== 'number' || !Number.isSafeInteger(request.stateVersion) || request.stateVersion < 1
              ) throw new Error('fixture known non-success transition conflict');
              const requestVersion = request.stateVersion;
              // Match the service's execution CAS, then its optional financial CAS.
              const requestVersionIncrement = 1 + (supplyMode === 'platform' && request.financialStatus === 'pending' ? 1 : 0);
              if (!Number.isSafeInteger(requestVersion + requestVersionIncrement))
                throw new Error('fixture known non-success version conflict');
              const updatedAt = new Date().toISOString();
              const updated: FixtureAttempt = {
                ...attempt, dispatchState: 'sent', resultState: 'failed',
                // A complete HTTP status proves a response even if the body flag is false.
                responseStarted: true,
                responseStartedAt: attempt.responseStarted ? attempt.responseStartedAt : updatedAt,
                resultHttpStatus: input.resultHttpStatus, unknownReason: null,
                stateVersion: attempt.stateVersion + 1, updatedAt,
              };
              if (
                attemptMap.get(attemptId)?.stateVersion !== attempt.stateVersion ||
                state.requests.get(requestId)?.stateVersion !== requestVersion
              ) throw new Error('fixture known non-success version conflict');
              attemptMap.set(attemptId, updated);
              state.requests.set(requestId, {
                ...request, executionState: 'failed', reconciliationState: 'none', financialStatus,
                stateVersion: requestVersion + requestVersionIncrement, updatedAt,
              });
              retainHold();
              return structuredClone(updated);
            });
            call.afterAttemptVersion = result.stateVersion;
            call.outcome = replayed ? 'replayed' : 'recorded';
            return result;
          } catch (error) {
            call.outcome = 'rejected';
            throw error;
          }
        },
      },
      leaseProvider: {
        async acquire() {
          return { fencingToken: 'fence-e2e', renewIntervalMs: 60_000, renew: async () => {}, release: async () => {} };
        },
      },
      transport: {
        async send(input: any) {
          state.dispatches.push({
            requestId: input.requestId,
            attemptId: input.attemptId,
            supplyMode: input.evidence.supplyMode,
          });
          return providerTransport.send(input);
        },
      },
    },
    lifecycle: { close: async () => {} },
    maxBodyBytes: 32_768,
    entryPoint: 'managed-saas-gateway-e2e',
  });

  const providerTransport = new ProviderHttpTransport({
    fetch: (url: string, init: RequestInit) => {
      const target = new URL(url);
      if (target.origin !== 'https://provider.e2e.invalid') throw new Error('unexpected provider target');
      return fetch(`http://127.0.0.1:${providerAddress.port}${target.pathname}`, init);
    },
    resolveDispatchProfile: async () => ({ url: `https://provider.e2e.invalid${ENDPOINT}` }),
    resolveCredential: async (_input: unknown, withCredential: (credential: unknown) => Promise<unknown>) =>
      withCredential({ headerName: 'authorization', value: 'Bearer local-only-provider-credential' }),
    endpointPolicy: { allowedHosts: ['provider.e2e.invalid'], allowedPorts: [443] },
    // The injected fetch below is the only network adapter and always targets the local fixture.
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 as const }],
    timeoutMs: 5_000,
    maxPayloadBytes: 32_768,
  } as never);

  const gatewayServer = createServer((req, res) => {
    void gateway
      .handler(req, res)
      .then((handled: boolean) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end();
      })
      .catch(() => {
        if (!res.writableEnded) res.writeHead(500).end();
      });
  });
  gatewayServer.listen(0, '127.0.0.1');
  await once(gatewayServer, 'listening');
  const gatewayAddress = gatewayServer.address();
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('gateway listener did not bind');

  return {
    state,
    gateway,
    origin: `http://127.0.0.1:${gatewayAddress.port}`,
    async close() {
      await gateway.close();
      await closeServer(gatewayServer);
      await closeServer(provider);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function expectClaimAndDispatchContract(state: FixtureState): Promise<void> {
  // EOF can be visible to the HTTP client just before the final sent CAS.
  // Wait only for the real dispatcher to finish; never manufacture its result.
  await expect.poll(() => state.attempts.get(ATTEMPT_ID)?.stateVersion, { timeout: 5_000 }).toBe(4);
  expect(state.attemptReads).toHaveLength(2);
  const [preClaim, postClaim] = state.attemptReads;
  const finalAttempt = state.attempts.get(ATTEMPT_ID);
  const evidence = state.evidence.get(EVIDENCE_ID);
  if (!preClaim || !postClaim || !finalAttempt || !evidence) throw new Error('missing fixture dispatch records');
  expect(preClaim).toMatchObject({
    tenantId: TENANT_ID, requestId: REQUEST_ID, id: ATTEMPT_ID, ordinal: 1,
    bindingState: 'bound', dispatchAuthorityState: 'bound', accountOwnerKind: 'platform',
    accountId: 'account-e2e', credentialId: 'credential-e2e', credentialVersion: '20',
    endpoint: ENDPOINT, routeTargetMode: 'platform_pool',
    preparedEvidenceId: null, stateVersion: 1, dispatchState: 'not_sent', resultState: 'pending',
    responseStarted: false, responseStartedAt: null, resultHttpStatus: null, unknownReason: null,
  });
  expect(postClaim).toMatchObject({
    preparedEvidenceId: EVIDENCE_ID, stateVersion: 2, dispatchState: 'not_sent', resultState: 'pending',
    responseStarted: false, responseStartedAt: null, resultHttpStatus: null, unknownReason: null,
  });
  expect(evidence).toMatchObject({
    requestedModel: PUBLIC_MODEL, mappedModel: PROVIDER_MODEL, resolvedModel: PROVIDER_MODEL,
    modelResolution: { requestedModel: PUBLIC_MODEL, mappedModel: PROVIDER_MODEL, resolvedModel: PROVIDER_MODEL },
    status: 'claimed', claimedAttemptId: ATTEMPT_ID,
  });
  expect(evidence.modelResolution).toBeDefined();
  expect(preClaim.modelResolution).toEqual(evidence.modelResolution);
  expect(postClaim.modelResolution).toEqual(evidence.modelResolution);
  expect(finalAttempt.modelResolution).toEqual(evidence.modelResolution);
  const provenanceFields = [
    'clientProtocol', 'providerProtocol', 'clientOperation', 'providerOperation',
    'requestFingerprint', 'requestFingerprintVersion', 'payloadCompilerVersion', 'usageEstimatorVersion',
    'payloadSha256',
  ] as const;
  for (const field of provenanceFields) {
    expect(typeof evidence[field]).toBe('string');
    expect(evidence[field]?.length).toBeGreaterThan(0);
    expect(preClaim[field]).toBe(evidence[field]);
    expect(postClaim[field]).toBe(evidence[field]);
    expect(finalAttempt[field]).toBe(evidence[field]);
  }
  expect(state.attemptTransitions).toHaveLength(2);
  expect(state.attemptTransitions[0]).toMatchObject({
    tenantId: TENANT_ID, requestId: REQUEST_ID, attemptId: ATTEMPT_ID,
    expectedDispatchState: 'not_sent', expectedResultState: 'pending', expectedResponseStarted: false,
    expectedStateVersion: 2, dispatchState: 'dispatching', resultState: 'pending', responseStarted: false,
  });
  expect(state.attemptTransitions[1]).toMatchObject({
    tenantId: TENANT_ID, requestId: REQUEST_ID, attemptId: ATTEMPT_ID,
    expectedDispatchState: 'dispatching', expectedResultState: 'pending', expectedResponseStarted: false,
    expectedStateVersion: 3, dispatchState: 'sent', resultState: 'pending', responseStarted: true,
    resultHttpStatus: 200,
  });
  expect(finalAttempt).toMatchObject({
    stateVersion: 4, preparedEvidenceId: EVIDENCE_ID, dispatchState: 'sent', resultState: 'pending',
    resultHttpStatus: 200, responseStarted: true, unknownReason: null,
  });
  expect(finalAttempt.responseStartedAt).not.toBeNull();
  expect(evidence.claimedAt).not.toBeNull();
  expect(Date.parse(postClaim.updatedAt)).toBeGreaterThanOrEqual(Date.parse(preClaim.updatedAt));
  expect(Date.parse(postClaim.updatedAt)).toBeGreaterThanOrEqual(Date.parse(evidence.claimedAt ?? ''));
  expect(Date.parse(finalAttempt.updatedAt)).toBeGreaterThanOrEqual(Date.parse(postClaim.updatedAt));
  expect(state.auditEvents).toHaveLength(1);
  expect(state.auditEvents[0]).toMatchObject({
    tenantId: TENANT_ID, actorUserId: 'member-e2e', action: 'saas_prepared_request_evidence.claimed',
    targetType: 'saas_prepared_request_evidence', targetId: EVIDENCE_ID,
    entryPoint: 'managed-saas-gateway-e2e', requestId: REQUEST_ID,
  });
  expect(state.auditEvents[0]?.occurredAt).toBe(evidence.claimedAt);
}

test('managed SaaS gateway authenticates a Proxy Key, resolves eligible platform supply, and reaches only a local HTTP upstream', async () => {
  const app = await startFixture();
  try {
    const payload = {
      model: PUBLIC_MODEL,
      messages: [{ role: 'user', content: 'hello from HTTP e2e' }],
      max_tokens: 8,
    };
    const response = await fetch(`${app.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'x-request-id': 'client-controlled-request-id',
      },
      body: JSON.stringify(payload),
    });
    expect(response.status, `${await response.clone().text()}\n${app.state.authorityQueries.join('\n')}`).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe('deterministic local reply');

    expect(app.state.upstreamCalls).toHaveLength(1);
    expect(app.state.upstreamCalls[0]?.authorization).toBe('Bearer local-only-provider-credential');
    expect(app.state.upstreamCalls[0]?.body.model).toBe(PROVIDER_MODEL);
    expect(app.state.dispatches).toEqual([{ requestId: REQUEST_ID, attemptId: ATTEMPT_ID, supplyMode: 'platform' }]);

    expect(app.state.requests.get(REQUEST_ID)).toMatchObject({
      id: REQUEST_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      proxyKeyId: KEY_ID,
      entitlementId: ENTITLEMENT_ID,
      supplyProfileId: PROFILE_ID,
      supplyMode: 'platform',
      routeConfigId: 'route-e2e',
      routeConfigVersion: '8',
      publicModel: PUBLIC_MODEL,
      providerId: 'provider-e2e',
      productId: 'product-e2e',
      resolvedModel: PROVIDER_MODEL,
      customerPriceVersion: 'price-e2e-v1',
      executionState: 'pending',
      financialStatus: 'pending',
      usage: null,
    });
    expect(app.state.attempts.get(ATTEMPT_ID)).toMatchObject({
      requestId: REQUEST_ID,
      dispatchState: 'sent',
      resultState: 'pending',
      resultHttpStatus: 200,
      responseStarted: true,
      preparedEvidenceId: EVIDENCE_ID,
      routeConfigId: 'route-e2e',
      routeConfigVersion: '8',
      supplyMode: 'platform',
      accountId: 'account-e2e',
      providerId: 'provider-e2e',
      resolvedModel: PROVIDER_MODEL,
      supplierCostVersion: 'cost-e2e-v1',
    });
    expect(app.state.evidence.get(EVIDENCE_ID)).toMatchObject({
      requestId: REQUEST_ID,
      attemptId: ATTEMPT_ID,
      supplyMode: 'platform',
      status: 'claimed',
      claimedAttemptId: ATTEMPT_ID,
    });
    expect(app.state.holds).toEqual([{ requestId: REQUEST_ID, state: 'reserved', amountMinorUnits: '5' }]);

    const usage = normalizeUsage('openai', body.usage);
    expect(usage).toMatchObject({
      inputTotal: 9,
      inputUncached: 7,
      cacheRead: 2,
      outputTotal: 4,
      status: 'reported',
      source: 'upstream',
      semanticsVersion: 'v1',
    });
    expect(app.state.requests.get(REQUEST_ID)?.usage).toBeNull();
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);

    const unauthorized = await fetch(`${app.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mr_live_invalid',
        'content-type': 'application/json',
        'x-request-id': 'client-controlled-unauthorized-id',
      },
      body: JSON.stringify(payload),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('x-request-id')).toBe(REQUEST_ID);
    const unauthorizedBody = (await unauthorized.json()) as { error: { requestId: string } };
    expect(unauthorizedBody.error.requestId).toBe(REQUEST_ID);
    expect(app.state.upstreamCalls).toHaveLength(1);

    expect(app.state.authorityQueries.some((sql) => sql.includes('preparation-authority:platform'))).toBe(true);
    expect(app.state.authorityQueries.some((sql) => sql.includes('FROM saas_provider_capabilities'))).toBe(true);
    expect(app.state.authorityQueries.some((sql) => sql.includes('FROM saas_provider_rights'))).toBe(true);
    await expectClaimAndDispatchContract(app.state);
    expect(app.state.knownNonSuccessResponses).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('managed SaaS gateway streams SSE over ProviderHttpTransport with the server-owned request ID', async () => {
  const app = await startFixture({ streaming: true });
  try {
    const payload = {
      model: PUBLIC_MODEL,
      messages: [{ role: 'user', content: 'hello from streaming HTTP e2e' }],
      max_tokens: 8,
      stream: true,
    };
    const response = await fetch(`${app.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-request-id': 'client-controlled-request-id',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status, `${await response.clone().text()}\n${app.state.authorityQueries.join('\n')}`).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(await response.text()).toBe(STREAMING_RESPONSE_BODY);

    expect(app.state.upstreamCalls).toHaveLength(1);
    expect(app.state.upstreamCalls[0]?.authorization).toBe('Bearer local-only-provider-credential');
    expect(app.state.upstreamCalls[0]?.body).toMatchObject({ model: PROVIDER_MODEL, stream: true });
    expect(app.state.dispatches).toEqual([{ requestId: REQUEST_ID, attemptId: ATTEMPT_ID, supplyMode: 'platform' }]);

    expect(app.state.requests.get(REQUEST_ID)?.id).toBe(REQUEST_ID);
    expect(app.state.attempts.get(ATTEMPT_ID)?.requestId).toBe(REQUEST_ID);
    expect(app.state.evidence.get(EVIDENCE_ID)?.requestId).toBe(REQUEST_ID);
    await expectClaimAndDispatchContract(app.state);
    expect(app.state.knownNonSuccessResponses).toHaveLength(0);
  } finally {
    await app.close();
  }
});
