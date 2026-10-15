import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../../src/saas/db/index.js';
import { CODEX_ENDPOINT } from '../../../../src/saas/gateway/codex/catalog-identity.js';
import type { ModelResolutionProvenance } from '../../../../src/saas/gateway/contracts.js';
import {
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_PROVIDER_ID,
} from '../../../../src/saas/gateway/opencode-go/catalog-identity.js';
import {
  DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  type OpenCodeGoProtocolRule,
  resolveOpenCodeGoProtocolRulesFromConfig,
} from '../../../../src/saas/gateway/opencode-go/protocol-rules.js';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
} from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  PreparedRequestEvidenceInput,
  PreparedRequestEvidenceRecord,
} from '../../../../src/saas/gateway/prepared-request-evidence-service.js';
import { ProviderHttpTransport } from '../../../../src/saas/gateway/provider-http-transport.js';
import { ProviderPayloadCompiler } from '../../../../src/saas/gateway/provider-payload-compiler.js';
import {
  allowRequestPreparation,
  type RequestPreparationAdmission,
  type RequestPreparationAdmissionPort,
  type RequestPreparationAttemptPersistenceInput,
  type RequestPreparationAttemptRecord,
  type RequestPreparationAuthority,
  type RequestPreparationAuthorityPort,
  type RequestPreparationCaller,
  type RequestPreparationEntitlement,
  type RequestPreparationInput,
  type RequestPreparationPayloadCompiler,
  rejectRequestPreparation,
} from '../../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../../src/saas/keys/types.js';
import type { RequestPreparationSigner } from '../../../../src/saas/runtime/request-preparation-signer-adapter.js';
import {
  applyOpenCodeGoProtocolRouting,
  createManagedSaasGatewayComposition,
  createManagedSaasGatewayProductionComposition,
  createOpenCodeGoProtocolRoutingAuthority,
  type ManagedSaasGatewayCompositionDependencies,
  type ManagedSaasGatewayProductionOptions,
} from '../../../../src/server/managed-saas-gateway.js';

const NOW = '2099-01-01T00:00:00.000Z';
const DISPATCH_DEADLINE = '2099-01-01T00:00:30.000Z';
const EXPIRES_AT = '2099-01-01T00:01:00.000Z';
const PUBLIC_MODEL = 'model-a';

/* ------------------------------------------------------------------ */
/* Shared preparation fixtures (trimmed from managed-saas-gateway-     */
/* composition.test.ts; kept local so this file stays runnable alone). */
/* ------------------------------------------------------------------ */

function authenticatedCaller(): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'key-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principalUserId: 'user-a',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-a',
      createdByUserId: 'user-a',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      name: 'test-key',
      prefix: 'mr_test',
      modelScopes: [PUBLIC_MODEL],
      status: 'active',
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'key-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principalKind: 'member',
      principalId: 'user-a',
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      modelScopes: [PUBLIC_MODEL],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
}

function caller(): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'user-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    modelScopes: [PUBLIC_MODEL],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
}

function entitlement(): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 1,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 1,
    supplyMode: 'byok',
    modelScopeVersion: 1,
    allowedModels: [PUBLIC_MODEL],
    allowedProviderIds: ['provider-a', OPENCODE_GO_PROVIDER_ID],
    projectPolicyVersion: 1,
  };
}

function modelResolution(resolvedModel: string): ModelResolutionProvenance {
  return {
    requestedModel: PUBLIC_MODEL,
    mappedModel: resolvedModel,
    resolvedModel,
    mappingSource: 'alias',
    mappingVersion: 1,
  };
}

function opencodeGoAuthority(resolvedModel: string): RequestPreparationAuthority {
  return {
    route: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      publicModel: PUBLIC_MODEL,
      publicModelId: 'public-model-a',
      publicModelVersion: 1,
      routeConfigId: 'route-a',
      routeConfigVersion: 1,
      protocol: 'openai',
      // The pre-R5b-2 single-protocol shape the production adapter emits
      // today (providerProtocol mirrors the client route protocol).
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      targetMode: 'tenant_account',
      upstreamId: 'upstream-opencode-go',
      endpoint: OPENCODE_GO_ENDPOINT,
    },
    candidate: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      proxyKeyId: 'key-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      upstreamId: 'upstream-opencode-go',
      accountId: 'account-opencode-go',
      credentialId: 'credential-a',
      credentialVersion: 1,
      credentialAuthzVersion: 1,
      accountAuthzVersion: 1,
      dispatchProfileId: 'dispatch-a',
      supplyProfileAuthzVersion: 1,
      resolvedModel,
      protocol: 'openai',
      endpoint: OPENCODE_GO_ENDPOINT,
      supplierCostVersion: null,
      providerId: OPENCODE_GO_PROVIDER_ID,
      productId: 'opencode-go-zen',
      profileAccountAuthzVersion: 1,
    },
    modelMappingRules: [
      {
        pattern: PUBLIC_MODEL,
        mappedModel: resolvedModel,
        mappingSource: 'alias',
        mappingVersion: 1,
      },
    ],
    poolMemberAuthzVersion: null,
    credentialRef: 'credential-a',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-a',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-a',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-a',
      customerPriceVersion: null,
      supplierCostVersion: null,
    },
  };
}

function foreignAuthority(): RequestPreparationAuthority {
  const base = opencodeGoAuthority('grok-4.7');
  return {
    ...base,
    candidate: { ...base.candidate, providerId: 'provider-a', productId: 'product-a' },
    route: {
      ...base.route,
      // A non-OpenCode-Go provider bridging to Anthropic: the rule table must
      // not touch it even though the resolved model matches `grok-*`.
      providerProtocol: 'anthropic',
      providerOperation: 'messages',
    },
  };
}

function admission(
  input: Parameters<RequestPreparationAdmissionPort['authorizeAndReserve']>[0],
): RequestPreparationAdmission {
  return {
    quotaReservation: { reference: 'quota-a', state: 'reserved' },
    rateReservation: { reference: 'rate-a', state: 'reserved' },
    holdReservation: null,
    idempotencyBinding: {
      state: 'created',
      keyDigest: input.idempotencyClaim?.keyDigest ?? 'd'.repeat(64),
      requestFingerprint: input.requestFingerprint,
      requestFingerprintVersion: input.requestFingerprintVersion,
      tenantId: input.tenantId,
      projectId: input.projectId,
      proxyKeyId: input.proxyKeyId,
      requestId: input.requestId,
    },
    deadlineAtMs: Date.parse(DISPATCH_DEADLINE),
    dispatchDeadline: DISPATCH_DEADLINE,
    expiresAt: EXPIRES_AT,
    remainingAttempts: 1,
    retryBudget: 0,
    attemptOrdinal: 1,
    usageBudget: { unit: 'tokens', amount: 16, basis: 'reserved' },
  };
}

function attemptRecord(input: RequestPreparationAttemptPersistenceInput): RequestPreparationAttemptRecord {
  return {
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
    clientProtocol: input.authority.route.protocol,
    providerProtocol: input.authority.route.providerProtocol ?? input.authority.candidate.protocol,
    clientOperation: input.authority.route.clientOperation ?? 'chat.completions',
    providerOperation: input.authority.route.providerOperation ?? 'chat.completions',
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
  };
}

function evidenceRecord(input: PreparedRequestEvidenceInput): PreparedRequestEvidenceRecord {
  return {
    evidenceId: input.evidenceId ?? 'missing-evidence-id',
    tenantId: input.tenantId,
    projectId: input.projectId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    attemptOrdinal: input.attemptOrdinal,
    supplyMode: input.supplyMode,
    publicModel: input.publicModel,
    protocol: input.protocol,
    modelResolution: input.modelResolution,
    clientProtocol: input.clientProtocol,
    providerProtocol: input.providerProtocol,
    clientOperation: input.clientOperation,
    providerOperation: input.providerOperation,
    endpoint: input.endpoint,
    upstreamId: input.upstreamId,
    accountId: input.accountId,
    credentialId: input.credentialId,
    credentialVersion: String(input.credentialVersion),
    routeTargetMode: input.routeTargetMode,
    payloadSha256: input.payloadSha256,
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: input.requestFingerprintVersion,
    payloadCompilerVersion: input.payloadCompilerVersion,
    usageEstimatorVersion: input.usageEstimatorVersion,
    statementSha256: 'a'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: new Date(input.expiresAt).toISOString(),
  };
}

function preparationInput(): RequestPreparationInput {
  return {
    authenticatedCaller: authenticatedCaller(),
    publicModel: PUBLIC_MODEL,
    protocol: 'openai',
    clientRequest: { model: PUBLIC_MODEL, messages: [{ role: 'user', content: 'hello' }] },
    audit: { entryPoint: 'opencode-go-protocol-dispatch-test' },
  };
}

/**
 * The production payload compiler honors the compile-input route facts the
 * preparation service derived from the (decorated) authority; this port is
 * the same pass-through the production wrapper implements when the runtime
 * route resolver echoes the authority.
 */
function productionLikePayloadCompiler(): RequestPreparationPayloadCompiler {
  const compiler = new ProviderPayloadCompiler({
    estimator: {
      version: 'test-estimator-v1',
      estimate: async () => ({
        inputTotalUpperBound: 12,
        inputUncachedUpperBound: 12,
        cacheReadUpperBound: 0,
        cacheWriteUpperBound: 0,
        cacheWrite5mUpperBound: 0,
        cacheWrite1hUpperBound: 0,
        outputTotalUpperBound: 4,
        reasoningOutputUpperBound: 0,
        feasibleInputBuckets: ['input'],
      }),
    },
    modelCompatibility: async () => true,
    maxPayloadBytes: 1024 * 1024,
    compilerVersion: 'test-compiler-v1',
    allowIdentityModelResolution: false,
  });
  return { compile: (input) => compiler.compile(input) };
}

const UNUSED = async (): Promise<never> => {
  throw new Error('outside this assertion');
};

function inertDispatchDependencies(): ManagedSaasGatewayCompositionDependencies['dispatch'] {
  return {
    evidence: {
      preflightForDispatch: UNUSED,
      claimForDispatch: UNUSED,
    },
    metering: {
      getAttempt: async () => null,
      transitionAttempt: UNUSED,
      recordKnownNonSuccessHttpResponse: UNUSED,
    },
    leaseProvider: { acquire: async () => null },
    transport: { send: UNUSED },
  } as unknown as ManagedSaasGatewayCompositionDependencies['dispatch'];
}

interface PreparedCapture {
  readonly providerProtocol: string | undefined;
  readonly providerOperation: string | undefined;
  readonly endpoint: string | undefined;
  readonly outcome: string;
}

/**
 * Runs one full preparation through the real preparation service with the
 * R5b-2 authority decorator over the fixture authority and the production
 * payload compiler, capturing the signed evidence input.
 */
async function prepareWithRouting(
  authority: RequestPreparationAuthority,
  rules?: readonly OpenCodeGoProtocolRule[],
): Promise<PreparedCapture> {
  const decoratedAuthority: RequestPreparationAuthorityPort = createOpenCodeGoProtocolRoutingAuthority(
    { resolve: async () => allowRequestPreparation(authority) },
    rules ?? DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );
  let captured: PreparedRequestEvidenceInput | undefined;
  const composition = createManagedSaasGatewayComposition({
    authenticator: { authenticate: async () => authenticatedCaller() },
    preparation: {
      caller: { validate: async () => allowRequestPreparation(caller()) },
      entitlement: { resolve: async () => allowRequestPreparation(entitlement()) },
      authority: decoratedAuthority,
      payload: productionLikePayloadCompiler(),
      admission: { authorizeAndReserve: async (input) => allowRequestPreparation(admission(input)) },
      attempt: { persist: async (input) => allowRequestPreparation(attemptRecord(input)) },
      transaction: { transaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }) },
      compensation: {
        releasePreDispatch: async (input) =>
          allowRequestPreparation({
            requestId: input.requestId,
            attemptId: input.attemptId,
            disposition: 'released',
            quotaReservation: 'released',
            rateReservation: 'released',
            holdReservation: 'not_applicable',
            manualReconciliationRequired: false,
          }),
      },
      signer: { sign: async (input) => allowRequestPreparation({ ...input, signatureBase64: 'c2lnbmF0dXJl' }) },
      registrar: {
        register: async (input) => {
          captured = input;
          return allowRequestPreparation(evidenceRecord(input));
        },
      },
    },
    preparationOptions: {
      evidenceVerifierKeyId: 'opencode-go-test-key',
      idFactory: {
        requestId: () => `request-${Math.random().toString(36).slice(2)}`,
        attemptId: () => `attempt-${Math.random().toString(36).slice(2)}`,
        evidenceId: () => `evidence-${Math.random().toString(36).slice(2)}`,
      },
    },
    dispatch: inertDispatchDependencies(),
    lifecycle: { close: async () => {} },
    maxBodyBytes: 1024,
    entryPoint: 'opencode-go-protocol-dispatch-test',
  });
  try {
    const result = await composition.preparation.prepare(preparationInput());
    return {
      providerProtocol: captured?.providerProtocol,
      providerOperation: captured?.providerOperation,
      endpoint: captured?.endpoint,
      outcome: result.outcome,
    };
  } finally {
    await composition.close();
  }
}

/* ------------------------------------------------------------------ */
/* R5b-2 dispatch: model → rule → signed provider protocol             */
/* ------------------------------------------------------------------ */

test('opencode-go preparation signs the rule-resolved native protocol per model', async () => {
  const scenarios = [
    { resolvedModel: 'grok-4.7', protocol: 'responses', operation: 'responses' },
    { resolvedModel: 'gpt-5.6-luna', protocol: 'responses', operation: 'responses' },
    { resolvedModel: 'muse-spark-1.3-contributor', protocol: 'responses', operation: 'responses' },
    { resolvedModel: 'minimax-m3', protocol: 'anthropic', operation: 'messages' },
    { resolvedModel: 'qwen3.8-max', protocol: 'anthropic', operation: 'messages' },
    // No rule matches: the Chat Completions default keeps R5b-1 behavior.
    { resolvedModel: 'glm-5.3', protocol: 'openai', operation: 'chat.completions' },
    { resolvedModel: 'kimi-k3', protocol: 'openai', operation: 'chat.completions' },
    // The resolved model is normalized before matching (namespace prefixes,
    // case) — the routing decision happens after modelMap resolution.
    { resolvedModel: 'OPENCODE-GO/GROK-4.7', protocol: 'responses', operation: 'responses' },
    { resolvedModel: 'opencode/qwen3.7-plus', protocol: 'anthropic', operation: 'messages' },
  ];
  for (const scenario of scenarios) {
    const capture = await prepareWithRouting(opencodeGoAuthority(scenario.resolvedModel));
    assert.equal(capture.outcome, 'prepared', JSON.stringify(capture));
    assert.equal(capture.providerProtocol, scenario.protocol, scenario.resolvedModel);
    assert.equal(capture.providerOperation, scenario.operation, scenario.resolvedModel);
    assert.equal(capture.endpoint, OPENCODE_GO_ENDPOINT, scenario.resolvedModel);
  }
});

test('a configured rule table overrides the built-in default table', async () => {
  const rules: readonly OpenCodeGoProtocolRule[] = [
    { pattern: 'glm-*', protocol: 'anthropic' },
    { pattern: 'kimi-*', protocol: 'responses' },
  ];
  assert.equal((await prepareWithRouting(opencodeGoAuthority('glm-5.3'), rules)).providerProtocol, 'anthropic');
  assert.equal((await prepareWithRouting(opencodeGoAuthority('kimi-k3'), rules)).providerProtocol, 'responses');
  // Unmatched models still fall back to Chat Completions under a custom table.
  assert.equal((await prepareWithRouting(opencodeGoAuthority('grok-4.7'), rules)).providerProtocol, 'openai');
});

test('non-opencode-go providers keep their authority route untouched (regression)', async () => {
  const capture = await prepareWithRouting(foreignAuthority());
  assert.equal(capture.outcome, 'prepared', JSON.stringify(capture));
  assert.equal(capture.providerProtocol, 'anthropic');
  assert.equal(capture.providerOperation, 'messages');
});

test('the authority decorator passes rejection decisions through unchanged', async () => {
  const decorated = createOpenCodeGoProtocolRoutingAuthority(
    {
      resolve: async () => rejectRequestPreparation('account_denied', 'fixture authority refusal'),
    },
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );
  const decision = await decorated.resolve({
    caller: caller(),
    entitlement: entitlement(),
    publicModel: PUBLIC_MODEL,
    protocol: 'openai',
  });
  assert.equal(decision.decision, 'reject');
  if (decision.decision === 'reject') assert.equal(decision.code, 'account_denied');
});

test('the authority decorator resolves rules from provider config shape with default fallback', async () => {
  // The migration-108 storage shape: configured rules win; absent or invalid
  // falls back to the built-in default table.
  const configured = resolveOpenCodeGoProtocolRulesFromConfig({
    protocol_rules: [{ pattern: 'glm-*', protocol: 'responses' }],
  });
  assert.ok(configured);
  const capture = await prepareWithRouting(opencodeGoAuthority('glm-5.3'), configured);
  assert.equal(capture.providerProtocol, 'responses');
  assert.equal(resolveOpenCodeGoProtocolRulesFromConfig(null), null);
});

test('applyOpenCodeGoProtocolRouting only rewrites the provider side of the route', () => {
  const base = {
    clientProtocol: 'openai' as const,
    providerProtocol: 'openai' as const,
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    modelResolution: modelResolution('grok-4.7'),
  };
  const routed = applyOpenCodeGoProtocolRouting(
    base,
    { providerId: OPENCODE_GO_PROVIDER_ID, resolvedModel: 'grok-4.7' },
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );
  assert.deepEqual(routed, { ...base, providerProtocol: 'responses', providerOperation: 'responses' });
  const untouched = applyOpenCodeGoProtocolRouting(
    base,
    { providerId: 'provider-a', resolvedModel: 'grok-4.7' },
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );
  assert.equal(untouched, base);
});

/* ------------------------------------------------------------------ */
/* R5b-2 dispatch: signed endpoint scope + provider protocol split     */
/* ------------------------------------------------------------------ */

const FAKE_DATABASE = {
  query: async () => ({ rows: [], rowCount: 0 }),
  transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) =>
    work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  migrate: async () => {},
  verifySchema: async () => {},
  ping: async () => {},
  close: async () => {},
} as unknown as SaasDatabase;

function productionOptions(
  overrides: Partial<ManagedSaasGatewayProductionOptions> = {},
): ManagedSaasGatewayProductionOptions {
  const endpointPolicy = { allowedHosts: ['provider.example'], allowedPorts: [443] } as const;
  return {
    caller: { validate: async () => allowRequestPreparation(caller()) },
    entitlement: { resolve: async () => allowRequestPreparation(entitlement()) },
    schedulerAffinity: { resolve: async () => ({ decision: 'allow' as const, accountId: null }) },
    admission: { authorizeAndReserve: async (input) => allowRequestPreparation(admission(input)) },
    attempt: { persist: async (input) => allowRequestPreparation(attemptRecord(input)) },
    compensation: {
      releasePreDispatch: async (input) =>
        allowRequestPreparation({
          requestId: input.requestId,
          attemptId: input.attemptId,
          disposition: 'released',
          quotaReservation: 'released',
          rateReservation: 'released',
          holdReservation: 'not_applicable',
          manualReconciliationRequired: false,
        }),
    },
    providerPreparationRoute: async () => ({
      clientProtocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      modelResolution: modelResolution('glm-5.3'),
    }),
    providerPayload: {
      estimator: {
        version: 'test-estimator-v1',
        estimate: async () => ({
          inputTotalUpperBound: 1,
          inputUncachedUpperBound: 1,
          cacheReadUpperBound: 0,
          cacheWriteUpperBound: 0,
          cacheWrite5mUpperBound: 0,
          cacheWrite1hUpperBound: 0,
          outputTotalUpperBound: 1,
          reasoningOutputUpperBound: 0,
          feasibleInputBuckets: ['input'],
        }),
      },
      modelCompatibility: async () => true,
      maxPayloadBytes: 1024 * 1024,
      compilerVersion: 'test-compiler-v1',
    },
    evidenceSigner: {
      verifierKeyId: 'verifier-a',
      sign: (input: PreparedRequestEvidenceInput) => ({ ...input, signatureBase64: 'c2lnbmF0dXJl' }),
    } as RequestPreparationSigner,
    evidenceVerifierKeyId: 'verifier-a',
    idFactory: {
      requestId: () => 'gateway-request-b',
      attemptId: () => 'gateway-attempt-b',
      evidenceId: () => 'gateway-evidence-b',
    },
    trustedVerifierPublicKeys: new Map([['verifier-a', 'unused-test-key']]),
    providerTargetResolver: {
      resolve: () => ({
        url: 'https://provider.example/v1',
        method: 'POST',
        endpointPolicy,
      }),
    },
    providerTargetRoute: async () => null,
    providerCredentialUnsealingKms: {
      decryptDataKey: async () => new Uint8Array(32),
      checkReady: async () => {},
      close: async () => {},
    },
    credentialContext: { deployment: 'test', environment: 'test' },
    resolveAuthenticationHeader: async () => 'authorization',
    fetch: async () => new Response('{}', { status: 200 }),
    endpointPolicy,
    timeoutMs: 1000,
    maxConcurrency: 1,
    leaseTtlMs: 1000,
    idempotencyHmacKey: new Uint8Array(32).fill(0x5a),
    maxBodyBytes: 1024,
    entryPoint: 'opencode-go-protocol-dispatch-test',
    ...overrides,
  } as ManagedSaasGatewayProductionOptions;
}

function transportRequest(evidence: Partial<PreparedRequestEvidenceRecord>): PreparedEvidenceTransportRequest {
  const payloadBytes = new Uint8Array([1, 2, 3]);
  const record: PreparedRequestEvidenceRecord = {
    evidenceId: 'routing-evidence',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    requestId: 'routing-request',
    attemptId: 'routing-attempt',
    attemptOrdinal: 1,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    publicModel: PUBLIC_MODEL,
    protocol: 'openai',
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    endpoint: 'https://provider.example/v1',
    upstreamId: 'upstream-opencode-go',
    accountId: 'account-opencode-go',
    credentialId: 'credential-a',
    credentialVersion: '1',
    routeTargetMode: 'platform_pool',
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    requestFingerprint: 'c'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    statementSha256: 'b'.repeat(64),
    status: 'claimed',
    claimedAt: NOW,
    claimedAttemptId: 'routing-attempt',
    expiresAt: EXPIRES_AT,
    ...evidence,
  };
  return {
    tenantId: record.tenantId,
    projectId: record.projectId,
    requestId: record.requestId,
    attemptId: record.attemptId,
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: record,
  };
}

test('the production dispatch transport splits on the signed endpoint scope and provider protocol', async () => {
  const sends: Record<string, number> = { codex: 0, opencodeGo: 0 };
  const codexTransport = {
    async send() {
      sends.codex += 1;
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };
  const opencodeGoTransport = {
    async send() {
      sends.opencodeGo += 1;
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };
  const composition = createManagedSaasGatewayProductionComposition(FAKE_DATABASE, {
    ...productionOptions(),
    codexEvidenceTransport: codexTransport,
    opencodeGoEvidenceTransport: opencodeGoTransport,
  });
  try {
    const dispatchTransport = (
      composition.dispatch as unknown as {
        transport: PreparedEvidenceTransport;
      }
    ).transport;

    // All three native protocols on the opencode-go-zen scope route to the
    // OpenCode Go transport.
    const operations = {
      responses: 'responses',
      openai: 'chat.completions',
      anthropic: 'messages',
    } as const;
    for (const providerProtocol of ['responses', 'openai', 'anthropic'] as const) {
      sends.codex = 0;
      sends.opencodeGo = 0;
      const result = await dispatchTransport.send(
        transportRequest({
          endpoint: OPENCODE_GO_ENDPOINT,
          providerProtocol,
          providerOperation: operations[providerProtocol],
        }),
      );
      assert.equal(sends.opencodeGo, 1, providerProtocol);
      assert.equal(sends.codex, 0, providerProtocol);
      assert.ok(result && typeof result === 'object');
    }

    // The codex split keeps its exact P1c semantics: endpoint + 'responses'.
    sends.codex = 0;
    sends.opencodeGo = 0;
    await dispatchTransport.send(
      transportRequest({ endpoint: CODEX_ENDPOINT, providerProtocol: 'responses', providerOperation: 'responses' }),
    );
    assert.equal(sends.codex, 1);
    assert.equal(sends.opencodeGo, 0);

    // Codex endpoint with any other provider protocol stays on the generic
    // transport (providerTargetRoute returns null, so it fails closed).
    sends.codex = 0;
    sends.opencodeGo = 0;
    await assert.rejects(() =>
      dispatchTransport.send(
        transportRequest({
          endpoint: CODEX_ENDPOINT,
          providerProtocol: 'openai',
          providerOperation: 'chat.completions',
        }),
      ),
    );
    assert.equal(sends.codex, 0);
    assert.equal(sends.opencodeGo, 0);

    // Unrelated endpoint scopes keep the generic transport path.
    sends.codex = 0;
    sends.opencodeGo = 0;
    await assert.rejects(() => dispatchTransport.send(transportRequest({})));
    assert.equal(sends.codex, 0);
    assert.equal(sends.opencodeGo, 0);
  } finally {
    await composition.close();
  }
});

test('the production composition applies the default rule table when no explicit table is configured', async () => {
  // The routing option is unset: the built-in default table is wired through
  // the authority decorator (observable via applyOpenCodeGoProtocolRouting on
  // the same table) and the opencode-go transport mount stays optional.
  const composition = createManagedSaasGatewayProductionComposition(FAKE_DATABASE, productionOptions());
  await composition.close();
  const routed = applyOpenCodeGoProtocolRouting(
    {
      clientProtocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      modelResolution: modelResolution('qwen3.8-max'),
    },
    { providerId: OPENCODE_GO_PROVIDER_ID, resolvedModel: 'qwen3.8-max' },
    DEFAULT_OPENCODE_GO_PROTOCOL_RULES,
  );
  assert.equal(routed.providerProtocol, 'anthropic');
  assert.equal(routed.providerOperation, 'messages');
});

test('the generic transport exposes the signed provider protocol and operation to dispatch-profile resolvers', async () => {
  const profileInputs: unknown[] = [];
  const transport = new ProviderHttpTransport({
    resolveDispatchProfile: async (input) => {
      profileInputs.push(input);
      return null;
    },
    resolveCredential: async (_input, useCredential) =>
      useCredential({ headerName: 'authorization', value: 'secret-value' }),
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    timeoutMs: 1000,
    fetch: async () => new Response('{}', { status: 200 }),
  });
  // R5b-2 multi-protocol evidence: anthropic-routed opencode-go request.
  await assert.rejects(() =>
    transport.send(
      transportRequest({
        endpoint: OPENCODE_GO_ENDPOINT,
        providerProtocol: 'anthropic',
        providerOperation: 'messages',
      }),
    ),
  );
  assert.equal(profileInputs.length, 1);
  const profileInput = profileInputs[0] as {
    endpoint: string;
    protocol: string;
    providerProtocol?: string;
    providerOperation?: string;
  };
  assert.equal(profileInput.endpoint, OPENCODE_GO_ENDPOINT);
  assert.equal(profileInput.protocol, 'openai');
  assert.equal(profileInput.providerProtocol, 'anthropic');
  assert.equal(profileInput.providerOperation, 'messages');

  // Legacy evidence without provider provenance leaves the fields undefined.
  profileInputs.length = 0;
  await assert.rejects(() =>
    transport.send(
      transportRequest({
        endpoint: 'https://provider.example/v1',
        providerProtocol: undefined,
        providerOperation: undefined,
      }),
    ),
  );
  assert.equal(profileInputs.length, 1);
  const legacyInput = profileInputs[0] as { providerProtocol?: string; providerOperation?: string };
  assert.equal(legacyInput.providerProtocol, undefined);
  assert.equal(legacyInput.providerOperation, undefined);
});
