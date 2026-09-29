import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  createPostgresPreparationPorts,
  type PostgresPreparationPortsOptions,
} from '../../../src/saas/gateway/postgres-preparation-ports.js';
import { GatewayRequestIdempotencyStore } from '../../../src/saas/gateway/request-idempotency.js';
import {
  allowRequestPreparation,
  type RequestPreparationAdmissionPort,
  type RequestPreparationAttemptPersistenceInput,
  type RequestPreparationCaller,
  type RequestPreparationEntitlement,
  type RequestPreparationPayloadBounds,
} from '../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';
import type { AttemptRecord, RequestAdmission, RequestRecord } from '../../../src/saas/metering/types.js';
import {
  createManagedSaasGatewayProductionComposition,
  type ManagedSaasGatewayProductionOptions,
} from '../../../src/server/managed-saas-gateway.js';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const HASH = 'a'.repeat(64);
const FP = 'b'.repeat(64);
const CLIENT_KEY = 'customer-retry-key-01';
const HMAC_KEY = new Uint8Array(32).fill(0x5a);
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const PROXY_KEY_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_A_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_B_ID = '55555555-5555-4555-8555-555555555555';
const BOUNDS: RequestPreparationPayloadBounds = {
  inputTotalUpperBound: 100,
  inputUncachedUpperBound: 80,
  cacheReadUpperBound: 20,
  cacheWriteUpperBound: 0,
  cacheWrite5mUpperBound: 0,
  cacheWrite1hUpperBound: 0,
  outputTotalUpperBound: 40,
  reasoningOutputUpperBound: 0,
  feasibleInputBuckets: ['input', 'cache_read'],
};

type Mode = 'byok' | 'platform';
type AnyRow = Record<string, unknown>;

function caller(
  mode: Mode = 'platform',
  tenantId = TENANT_ID,
  projectId = PROJECT_ID,
  keyId = PROXY_KEY_ID,
): RequestPreparationCaller {
  return {
    tenantId,
    projectId,
    proxyKeyId: keyId,
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: mode,
    modelScopes: ['gpt-6-luna'],
    authzVersion: '1',
    entitlementVersion: '2',
    supplyProfileVersion: '3',
    modelScopeVersion: '3',
  };
}

function entitlement(value = caller()): RequestPreparationEntitlement {
  return {
    tenantId: value.tenantId,
    projectId: value.projectId,
    proxyKeyId: value.proxyKeyId,
    entitlementId: value.entitlementId,
    entitlementVersion: value.entitlementVersion,
    supplyProfileId: value.supplyProfileId,
    supplyProfileVersion: value.supplyProfileVersion,
    supplyMode: value.supplyMode,
    modelScopeVersion: value.modelScopeVersion,
    allowedModels: ['gpt-6-luna'],
    allowedProviderIds: value.supplyMode === 'byok' ? ['provider-a'] : [],
    projectPolicyVersion: '4',
  };
}

function authenticatedKey(value = caller()): AuthenticatedApiKey {
  const auth = {
    keyId: value.proxyKeyId,
    tenantId: value.tenantId,
    projectId: value.projectId,
    principalKind: value.principalKind,
    principalId: value.principalId,
    entitlementId: value.entitlementId,
    supplyProfileId: value.supplyProfileId,
    supplyMode: value.supplyMode,
    modelScopes: [...value.modelScopes],
    authzVersion: 1,
    modelScopeVersion: 3,
    entitlementAuthzVersion: 2,
    supplyProfileAuthzVersion: 3,
  } as const;
  return {
    authorization: auth,
    metadata: {
      id: auth.keyId,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      principalUserId: auth.principalId,
      executionPrincipalType: auth.principalKind,
      executionPrincipalId: auth.principalId,
      createdByUserId: 'member-a',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: auth.entitlementId,
      supplyProfileId: auth.supplyProfileId,
      supplyMode: auth.supplyMode,
      name: 'test key',
      prefix: 'saas_test',
      modelScopes: [...auth.modelScopes],
      status: 'active',
      createdAt: NOW.toISOString(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 3,
      entitlementAuthzVersion: 2,
      supplyProfileAuthzVersion: 3,
    },
  };
}

function authority(
  value = caller(),
): RequestPreparationAdmissionPort extends { authorizeAndReserve(input: infer I): Promise<unknown> }
  ? I extends { authority: infer A }
    ? A
    : never
  : never {
  const candidate = {
    tenantId: value.tenantId,
    projectId: value.projectId,
    proxyKeyId: value.proxyKeyId,
    supplyProfileId: value.supplyProfileId,
    supplyMode: value.supplyMode,
    accountId: 'account-a',
    accountOwnerKind: value.supplyMode === 'byok' ? 'tenant' : 'platform',
    upstreamId: 'upstream-a',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialId: 'credential-a',
    credentialVersion: '5',
    credentialAuthzVersion: '6',
    accountAuthzVersion: '7',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    resolvedModel: 'gpt-6-luna',
    profileAccountAuthzVersion: '8',
    poolId: 'pool-a',
    poolAuthzVersion: '9',
    poolMemberAuthzVersion: '10',
    poolMemberAccountAuthzVersion: '11',
    poolGrantAuthzVersion: '12',
    poolGrantProfileAuthzVersion: '13',
    poolGrantPoolAuthzVersion: '14',
  };
  return {
    route: {
      tenantId: value.tenantId,
      projectId: value.projectId,
      publicModel: 'gpt-6-luna',
      publicModelId: 'public-model-a',
      publicModelVersion: '15',
      routeConfigId: 'route-a',
      routeConfigVersion: '16',
      protocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      targetMode: value.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool',
      upstreamId: 'upstream-a',
      endpoint: '/v1/chat/completions',
    },
    candidate,
    modelResolution: {
      requestedModel: 'gpt-6-luna',
      mappedModel: 'gpt-6-luna',
      resolvedModel: 'gpt-6-luna',
      mappingSource: 'none',
      mappingVersion: null,
    },
    poolMemberAuthzVersion: value.supplyMode === 'platform' ? '10' : null,
    credentialRef: 'credential-ref-a',
    configVersion: '17',
    commercial: {
      customerMeteringPolicyId: 'customer-policy-a',
      customerMeteringPolicyVersion: '18',
      providerMeteringPolicyId: 'provider-policy-a',
      providerMeteringPolicyVersion: '19',
      contractAttestationId: 'contract-a',
      customerPriceVersion: value.supplyMode === 'platform' ? 'customer-price-a' : null,
      supplierCostVersion: value.supplyMode === 'platform' ? 'supplier-cost-a' : null,
    },
  } as never;
}

function setup(mode: Mode = 'platform', fixtureOptions: { insufficientFunds?: boolean } = {}) {
  const value = caller(mode);
  const ent = entitlement(value);
  const auth = authority(value);
  const requests = new Map<string, RequestRecord>();
  const attempts = new Map<string, AttemptRecord>();
  const idempotency = new Map<string, { fingerprint: string; requestId: string; attemptId: string }>();
  const gatewayIdempotency = new Map<
    string,
    {
      project_id: string;
      proxy_key_id: string;
      request_fingerprint: string;
      request_fingerprint_version: string;
      request_id: string;
      state: 'in_progress' | 'unknown' | 'completed';
      execution_state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    }
  >();
  const capacityReservations = new Map<string, true>();
  const capacityIdempotencyKeys: string[] = [];
  const calls = { meter: 0, reserve: 0, capacityReserve: 0, capacityRelease: 0, walletRelease: 0, guard: 0 };
  const executorEvents: { stage: string; executor: SqlExecutor }[] = [];
  const queryEvents: { sql: string; values: readonly unknown[]; executor: SqlExecutor }[] = [];
  let billingRow: AnyRow | null = null;
  let attemptState = 'not_sent';
  const executor: SqlExecutor = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      queryEvents.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: [...values], executor });
      if (sql.startsWith('INSERT INTO saas_gateway_request_idempotency_keys')) {
        executorEvents.push({ stage: 'idempotency_claim', executor });
        const [tenantId, projectId, proxyKeyId, keyDigest, fingerprint, version, requestId] = values;
        const key = [tenantId, projectId, proxyKeyId, keyDigest].join('|');
        if (gatewayIdempotency.has(key)) return { rows: [], rowCount: 0 };
        gatewayIdempotency.set(key, {
          project_id: String(projectId),
          proxy_key_id: String(proxyKeyId),
          request_fingerprint: String(fingerprint),
          request_fingerprint_version: String(version),
          request_id: String(requestId),
          state: 'in_progress',
          execution_state: 'pending',
        });
        return { rows: [{ request_id: String(requestId) } as Row], rowCount: 1 };
      }
      if (sql.startsWith('SELECT request_fingerprint, request_fingerprint_version')) {
        const [tenantId, projectId, proxyKeyId, keyDigest] = values;
        const row = gatewayIdempotency.get([tenantId, projectId, proxyKeyId, keyDigest].join('|'));
        const canonicalRow = row
          ? {
              ...row,
              canonical_project_id: row.project_id,
              canonical_proxy_key_id: row.proxy_key_id,
              canonical_request_fingerprint: row.request_fingerprint,
              canonical_request_fingerprint_version: row.request_fingerprint_version,
            }
          : null;
        return { rows: canonicalRow ? [canonicalRow as Row] : [], rowCount: canonicalRow ? 1 : 0 };
      }
      if (sql.includes('FROM saas_billing_reservations')) {
        return { rows: billingRow ? [billingRow as Row] : [], rowCount: billingRow ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const database = {
    query: (sql: string, values?: readonly unknown[]) => executor.query(sql, values),
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const requestsBefore = new Map(requests);
      const attemptsBefore = new Map(attempts);
      const idempotencyBefore = new Map(idempotency);
      const gatewayIdempotencyBefore = new Map([...gatewayIdempotency].map(([key, row]) => [key, { ...row }]));
      const capacityBefore = new Map(capacityReservations);
      const billingBefore = billingRow;
      try {
        return await work(executor);
      } catch (error) {
        requests.clear();
        for (const [key, request] of requestsBefore) requests.set(key, request);
        attempts.clear();
        for (const [key, attempt] of attemptsBefore) attempts.set(key, attempt);
        idempotency.clear();
        for (const [key, entry] of idempotencyBefore) idempotency.set(key, entry);
        gatewayIdempotency.clear();
        for (const [key, row] of gatewayIdempotencyBefore) gatewayIdempotency.set(key, row);
        capacityReservations.clear();
        for (const [key, entry] of capacityBefore) capacityReservations.set(key, entry);
        billingRow = billingBefore;
        throw error;
      }
    },
  } as SaasDatabase;
  const metering = {
    async admitPreparedRequest(
      input: AnyRow,
      identity: { requestId: string; attemptId: string; executor?: SqlExecutor },
    ) {
      calls.meter += 1;
      if (identity.executor) executorEvents.push({ stage: 'metering', executor: identity.executor });
      const requestInput = input as AnyRow;
      const key =
        typeof requestInput.idempotencyKey === 'string'
          ? `${requestInput.tenantId}:${requestInput.projectId}:${requestInput.proxyKeyId}:${requestInput.idempotencyKey}`
          : null;
      const fingerprint = String(requestInput.requestFingerprint);
      const existing = key === null ? undefined : idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.requestId !== identity.requestId) {
          throw Object.assign(new Error('conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
        }
        const request = requests.get(existing.requestId);
        if (!request) throw new Error('missing replay request');
        return {
          kind: 'replayed',
          request,
          idempotency: {
            id: 'idem-a',
            tenantId: request.tenantId,
            proxyKeyId: request.proxyKeyId,
            keyDigest: 'digest-only',
            requestFingerprint: fingerprint,
            requestFingerprintVersion: String(requestInput.requestFingerprintVersion),
            requestId: request.id,
            kind: 'active',
            createdAt: NOW.toISOString(),
          },
        } satisfies RequestAdmission;
      }
      const request = {
        ...requestInput,
        id: identity.requestId,
        idempotencyKeyDigest: null,
        financialStatus: mode === 'byok' ? 'not_applicable' : 'pending',
        resultState: 'pending',
        reconciliationState: 'none',
      } as unknown as RequestRecord;
      const attempt = {
        ...requestInput.initialAttempt,
        id: identity.attemptId,
        tenantId: request.tenantId,
        requestId: request.id,
        supplyMode: request.supplyMode,
        bindingState: 'bound',
        dispatchAuthorityState: 'bound',
        dispatchState: attemptState,
        resultState: 'pending',
        responseStarted: false,
      } as unknown as AttemptRecord;
      requests.set(request.id, request);
      attempts.set(`${request.id}:${attempt.id}`, attempt);
      if (key !== null)
        idempotency.set(key, { fingerprint, requestId: identity.requestId, attemptId: identity.attemptId });
      return { kind: 'created', request, idempotency: null, initialAttempt: attempt } satisfies RequestAdmission;
    },
    async getRequest(tenantId: string, requestId: string) {
      const request = requests.get(requestId);
      return request?.tenantId === tenantId ? request : null;
    },
    async getAttempt(tenantId: string, requestId: string, attemptId: string) {
      const attempt = attempts.get(`${requestId}:${attemptId}`);
      return attempt?.tenantId === tenantId ? { ...attempt, dispatchState: attemptState } : null;
    },
  };
  const billing = {
    async reserve(tx: SqlExecutor, input: AnyRow) {
      calls.reserve += 1;
      executorEvents.push({ stage: 'billing', executor: tx });
      if (fixtureOptions.insufficientFunds) {
        throw Object.assign(new Error('balance unavailable'), { code: 'INSUFFICIENT_FUNDS' });
      }
      const reservation = {
        id: 'hold-a',
        tenantId: input.tenantId,
        requestId: input.requestId,
        currency: input.currency,
        amountMinorUnits: BigInt(input.amountMinorUnits as string | number | bigint),
        priceSnapshotRef: input.priceSnapshotRef,
        expiresAt: new Date(input.expiresAt as string | Date).toISOString(),
        state: 'reserved',
      };
      billingRow = {
        ...reservation,
        amount_minor_units: String(reservation.amountMinorUnits),
        tenant_id: reservation.tenantId,
        request_id: reservation.requestId,
        price_snapshot_ref: reservation.priceSnapshotRef,
        expires_at: reservation.expiresAt,
      };
      return reservation;
    },
    async release(_tx: SqlExecutor, input: AnyRow) {
      calls.walletRelease += 1;
      return {
        id: 'hold-a',
        tenantId: input.tenantId,
        requestId: input.requestId,
        state: 'released',
      };
    },
  };
  const guard = {
    async revalidate(input: AnyRow) {
      calls.guard += 1;
      const request = input.request as RequestRecord;
      const candidate = input.candidate as AttemptRecord;
      return {
        authorization: {
          tenantId: request.tenantId,
          projectId: request.projectId,
          proxyKeyId: request.proxyKeyId,
          entitlementId: request.entitlementId,
          supplyProfileId: request.supplyProfileId,
          supplyProfileVersion: request.supplyProfileVersion,
          modelScopeVersion: request.modelScopeVersion,
          supplyMode: request.supplyMode,
          principalKind: request.principalKind,
          principalId: request.principalId,
          authzVersion: request.authzVersion,
          entitlementVersion: request.entitlementVersion,
          configVersion: request.configVersion,
          projectPolicyVersion: request.projectPolicyVersion,
        },
        candidate,
        platformPriceHold:
          mode === 'platform'
            ? {
                currency: 'USD',
                amountMinorUnits: 25n,
                priceSnapshotRef: 'price-snapshot-a',
                expiresAt: (input.holdEvidence as AnyRow).admissionExpiresAt as Date,
                customerPriceVersion: request.customerPriceVersion,
                supplierCostVersion: candidate.supplierCostVersion,
              }
            : null,
      };
    },
  };
  const prelock = { async prelock() {} };
  const capacity = {
    async reserve(tx: SqlExecutor, input: AnyRow) {
      calls.capacityReserve += 1;
      executorEvents.push({ stage: 'capacity', executor: tx });
      capacityIdempotencyKeys.push(String(input.idempotencyScopeKey));
      capacityReservations.set(`${input.tenantId}:${input.requestId}`, true);
      return allowRequestPreparation({
        quotaReservation: { reference: 'quota-a', state: 'reserved' as const },
        rateReservation: { reference: 'rate-a', state: 'reserved' as const },
        retryBudget: 0,
        remainingAttempts: 1,
        usageBudget: null,
      });
    },
    async release() {
      calls.capacityRelease += 1;
      return { quotaReservation: 'released' as const, rateReservation: 'released' as const };
    },
  };
  const idempotencyStore = new GatewayRequestIdempotencyStore({ hmacKey: HMAC_KEY });
  const options = {
    database,
    metering,
    billing,
    guard,
    authorizationPrelock: prelock,
    entitlement: {
      async resolve() {
        return allowRequestPreparation(ent);
      },
    },
    capacity,
    idempotencyStore,
    payloadCompilerVersion: 'payload-v1',
    usageEstimatorVersion: 'estimate-v1',
    requestFingerprintVersion: 'fingerprint-v1',
    now: () => new Date(NOW),
    admissionTtlMs: 60_000,
  } as unknown as PostgresPreparationPortsOptions;
  const ports = createPostgresPreparationPorts(options);
  const admissionInput = (
    requestId = REQUEST_A_ID,
    attemptId = 'attempt-a',
    idempotencyKey: string | null = CLIENT_KEY,
    requestFingerprint = FP,
  ) => ({
    requestId,
    attemptId,
    caller: value,
    entitlement: ent,
    authority: auth,
    payloadSha256: HASH,
    payloadBounds: BOUNDS,
    idempotencyKey,
    requestFingerprint,
    requestFingerprintVersion: 'fingerprint-v1',
  });
  return {
    ports,
    caller: value,
    entitlement: ent,
    authority: auth,
    authenticatedKey: authenticatedKey(value),
    executor,
    admissionInput,
    calls,
    requests,
    attempts,
    database,
    capacityReservations,
    capacityIdempotencyKeys,
    gatewayIdempotency,
    executorEvents,
    queryEvents,
    idempotencyStore,
    get billingRow() {
      return billingRow;
    },
    setAttemptState(state: string) {
      attemptState = state;
    },
  };
}

async function authorize(fixture: ReturnType<typeof setup>, input = fixture.admissionInput()) {
  return fixture.ports.admission.authorizeAndReserve(input as never, { executor: fixture.executor });
}

test('caller port binds the authenticated key snapshot to metadata and requested model', async () => {
  const fixture = setup();
  const decision = await fixture.ports.caller.validate({
    authenticatedCaller: fixture.authenticatedKey,
    publicModel: 'gpt-6-luna',
    protocol: 'openai',
  });
  assert.equal(decision.decision, 'allow');
  if (decision.decision === 'allow') assert.equal(decision.value.tenantId, TENANT_ID);
  const mismatch = {
    ...fixture.authenticatedKey,
    metadata: { ...fixture.authenticatedKey.metadata, tenantId: 'tenant-b' },
  };
  const rejected = await fixture.ports.caller.validate({
    authenticatedCaller: mismatch,
    publicModel: 'gpt-6-luna',
    protocol: 'openai',
  });
  assert.equal(rejected.decision, 'reject');
});

test('platform admission persists one initial attempt and reserves the authoritative wallet hold in the caller transaction', async () => {
  const fixture = setup();
  const decision = await authorize(fixture);
  assert.equal(decision.decision, 'allow');
  if (decision.decision !== 'allow') return;
  assert.equal(decision.value.holdReservation?.reservationId, 'hold-a');
  assert.equal(decision.value.holdReservation?.amountMinorUnits, 25n);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.guard, 1);
  assert.equal(fixture.calls.meter, 1);
  assert.equal(fixture.calls.capacityReserve, 1);
  const idempotencyInsert = fixture.queryEvents.find(({ sql }) =>
    sql.startsWith('INSERT INTO saas_gateway_request_idempotency_keys'),
  );
  assert.ok(idempotencyInsert);
  const keyDigest = String(idempotencyInsert.values[3]);
  assert.match(keyDigest, /^[0-9a-f]{64}$/);
  assert.equal(fixture.requests.get(REQUEST_A_ID)?.idempotencyKeyDigest, null);
  assert.deepEqual(fixture.capacityIdempotencyKeys, [keyDigest]);

  const persist: RequestPreparationAttemptPersistenceInput = {
    requestId: REQUEST_A_ID,
    attemptId: 'attempt-a',
    caller: fixture.caller,
    entitlement: fixture.entitlement,
    authority: fixture.authority as RequestPreparationAttemptPersistenceInput['authority'],
    admission: decision.value,
    publicModel: 'gpt-6-luna',
    protocol: 'openai',
    requestFingerprint: FP,
    requestFingerprintVersion: 'fingerprint-v1',
    payloadSha256: HASH,
    payloadCompilerVersion: 'payload-v1',
    usageEstimatorVersion: 'estimate-v1',
    modelResolution: (fixture.authority as RequestPreparationAttemptPersistenceInput['authority']).modelResolution ?? {
      requestedModel: 'gpt-6-luna',
      mappedModel: 'gpt-6-luna',
      resolvedModel: 'gpt-6-luna',
      mappingSource: 'none',
      mappingVersion: null,
    },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
  };
  const attempt = await fixture.ports.attempt.persist(persist, { executor: fixture.executor });
  assert.equal(attempt.decision, 'allow');
  if (attempt.decision === 'allow') assert.equal(attempt.value.dispatchState, 'not_sent');
});

test('Postgres preparation consumes the production claim proof without opening or repeating the claim', async () => {
  const fixture = setup();
  await fixture.database.transaction(async (executor) => {
    const claim = await fixture.idempotencyStore.claim(executor, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      proxyKeyId: PROXY_KEY_ID,
      clientKey: CLIENT_KEY,
      requestFingerprint: FP,
      requestFingerprintVersion: 'fingerprint-v1',
      requestId: REQUEST_A_ID,
    });
    if (claim.kind !== 'claimed') throw new Error('expected a fresh production claim');
    const admission = await fixture.ports.admission.authorizeAndReserve(
      { ...fixture.admissionInput(), idempotencyClaim: claim } as never,
      { executor },
    );
    assert.equal(admission.decision, 'allow');
    if (admission.decision === 'allow') assert.equal(admission.value.idempotencyBinding.keyDigest, claim.keyDigest);
    return admission;
  });
  assert.equal(
    fixture.queryEvents.filter(({ sql }) => sql.startsWith('INSERT INTO saas_gateway_request_idempotency_keys')).length,
    1,
  );
  assert.deepEqual(
    fixture.executorEvents.map(({ stage }) => stage),
    ['idempotency_claim', 'capacity', 'metering', 'billing'],
  );
  assert.ok(fixture.executorEvents.every(({ executor }) => executor === fixture.executor));
});

test('production composition wraps the real Postgres admission with one durable claim before capacity and billing', async () => {
  const fixture = setup();
  const endpointPolicy = { allowedHosts: ['provider.example'], allowedPorts: [443] } as const;
  const options = {
    caller: fixture.ports.caller,
    entitlement: fixture.ports.entitlement,
    schedulerAffinity: { resolve: async () => ({ decision: 'allow' as const, accountId: null }) },
    admission: fixture.ports.admission,
    attempt: fixture.ports.attempt,
    compensation: fixture.ports.compensation,
    providerPreparationRoute: async () => ({
      clientProtocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      modelResolution: {
        requestedModel: 'gpt-6-luna',
        mappedModel: 'gpt-6-luna',
        resolvedModel: 'gpt-6-luna',
        mappingSource: 'none',
        mappingVersion: null,
      },
    }),
    providerPayload: {
      estimator: { version: 'estimate-v1', estimate: async () => ({ inputTokens: 1, outputTokens: 1 }) },
      modelCompatibility: async () => true,
      maxPayloadBytes: 1024,
      compilerVersion: 'payload-v1',
    },
    evidenceSigner: { verifierKeyId: 'verifier-a', sign: async () => 'unused' },
    evidenceVerifierKeyId: 'verifier-a',
    idFactory: {
      requestId: () => REQUEST_B_ID,
      attemptId: () => 'attempt-generated',
      evidenceId: () => 'evidence-generated',
    },
    trustedVerifierPublicKeys: new Map([['verifier-a', 'unused-test-key']]),
    providerTargetResolver: { resolve: () => ({}) },
    providerTargetRoute: async () => ({
      productId: 'product-a',
      providerProtocol: 'openai',
      providerOperation: 'chat.completions',
    }),
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
    idempotencyHmacKey: HMAC_KEY,
    maxBodyBytes: 1024,
    entryPoint: 'postgres-preparation-composition-test',
  } as unknown as ManagedSaasGatewayProductionOptions;

  assert.throws(
    () =>
      createManagedSaasGatewayProductionComposition(
        { ...fixture.database, query: undefined } as unknown as SaasDatabase,
        options,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'ManagedSaasGatewayCompositionError' &&
      'code' in error &&
      error.code === 'MISSING_DEPENDENCY',
  );

  const composition = createManagedSaasGatewayProductionComposition(fixture.database, options);
  const productionAdmission = (
    composition.preparation as unknown as {
      dependencies: { admission: RequestPreparationAdmissionPort };
    }
  ).dependencies.admission;
  const command = (requestId: string, attemptId: string) => ({
    ...fixture.admissionInput(requestId, attemptId),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    proxyKeyId: PROXY_KEY_ID,
  });

  const first = await fixture.database.transaction((executor) =>
    productionAdmission.authorizeAndReserve(command(REQUEST_A_ID, 'attempt-a') as never, { executor }),
  );
  assert.equal(first.decision, 'allow');
  if (first.decision !== 'allow') throw new Error('expected first production admission to succeed');
  assert.equal(first.value.idempotencyBinding.requestId, REQUEST_A_ID);
  assert.ok(first.value.holdReservation);
  assert.deepEqual(
    fixture.executorEvents.map(({ stage }) => stage),
    ['idempotency_claim', 'capacity', 'metering', 'billing'],
  );
  assert.ok(fixture.executorEvents.every(({ executor }) => executor === fixture.executor));

  let retry: Awaited<ReturnType<typeof productionAdmission.authorizeAndReserve>> | null = null;
  await assert.rejects(
    fixture.database.transaction(async (executor) => {
      retry = await productionAdmission.authorizeAndReserve(command(REQUEST_B_ID, 'attempt-b') as never, { executor });
      if (retry.decision !== 'reject') throw new Error('matching retry unexpectedly entered admission');
      throw new Error('rollback rejected retry transaction');
    }),
    /rollback rejected retry transaction/,
  );
  assert.equal(retry?.decision, 'reject');
  if (retry?.decision === 'reject') {
    assert.equal(retry.code, 'idempotency_replay');
    assert.deepEqual(retry.canonicalRequest, { requestId: REQUEST_A_ID, status: 'in_progress' });
  }
  assert.equal(fixture.calls.capacityReserve, 1);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.meter, 1);
  assert.equal(fixture.requests.size, 1);
  assert.equal(fixture.attempts.size, 1);
  assert.equal(fixture.capacityReservations.size, 1);
  assert.equal(fixture.gatewayIdempotency.size, 1);
  assert.ok(fixture.queryEvents.every(({ values }) => !values.includes(CLIENT_KEY)));
  await composition.close();
});

test('BYOK admission never invokes or returns a platform wallet hold', async () => {
  const fixture = setup('byok');
  const decision = await authorize(fixture);
  assert.equal(decision.decision, 'allow');
  if (decision.decision === 'allow') assert.equal(decision.value.holdReservation, null);
  assert.equal(fixture.calls.reserve, 0);
});

test('same key and fingerprint across two HTTP request IDs returns the canonical request before new writes', async () => {
  const fixture = setup();
  const first = await fixture.database.transaction(async (executor) => {
    const result = await fixture.ports.admission.authorizeAndReserve(
      fixture.admissionInput(REQUEST_A_ID, 'attempt-a') as never,
      { executor },
    );
    if (result.decision !== 'allow') throw new Error('initial admission unexpectedly failed');
    return result;
  });
  assert.equal(first.decision, 'allow');
  if (first.decision !== 'allow') return;
  assert.equal(first.value.idempotencyBinding.requestId, REQUEST_A_ID);
  assert.equal(fixture.gatewayIdempotency.size, 1);
  assert.equal(fixture.requests.size, 1);
  assert.equal(fixture.attempts.size, 1);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.capacityReserve, 1);
  assert.equal(fixture.calls.meter, 1);
  assert.deepEqual(
    fixture.executorEvents.map(({ stage, executor }) => [stage, executor]),
    [
      ['idempotency_claim', fixture.executor],
      ['capacity', fixture.executor],
      ['metering', fixture.executor],
      ['billing', fixture.executor],
    ],
  );
  const firstMappingWrite = fixture.queryEvents.find(({ sql }) =>
    sql.startsWith('INSERT INTO saas_gateway_request_idempotency_keys'),
  );
  assert.ok(firstMappingWrite);
  assert.equal(firstMappingWrite.executor, fixture.executor);
  assert.ok(!firstMappingWrite.values.includes(CLIENT_KEY));
  assert.ok(fixture.queryEvents.every(({ values }) => !values.includes(CLIENT_KEY)));

  let replay: Awaited<ReturnType<typeof authorize>> | null = null;
  await assert.rejects(
    fixture.database.transaction(async (executor) => {
      replay = await fixture.ports.admission.authorizeAndReserve(
        fixture.admissionInput(REQUEST_B_ID, 'attempt-b') as never,
        { executor },
      );
      if (replay.decision !== 'allow') throw new Error('preparation transaction rollback');
      return replay;
    }),
    /preparation transaction rollback/,
  );
  assert.equal(replay?.decision, 'reject');
  if (replay?.decision === 'reject') {
    assert.equal(replay.code, 'idempotency_replay');
    assert.deepEqual(replay.canonicalRequest, { requestId: REQUEST_A_ID, status: 'in_progress' });
  }
  assert.equal(fixture.calls.capacityReserve, 1);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.meter, 1);
  assert.equal(fixture.requests.size, 1);
  assert.equal(fixture.attempts.size, 1);
  assert.equal(fixture.capacityReservations.size, 1);
  assert.equal(fixture.gatewayIdempotency.size, 1);
  assert.equal([...fixture.gatewayIdempotency.values()][0].request_id, REQUEST_A_ID);
});

test('same scoped idempotency key with a different fingerprint conflicts without a second hold', async () => {
  const fixture = setup();
  const first = await fixture.database.transaction(async (executor) => {
    const result = await fixture.ports.admission.authorizeAndReserve(fixture.admissionInput() as never, { executor });
    if (result.decision !== 'allow') throw new Error('initial admission unexpectedly failed');
    return result;
  });
  assert.equal(first.decision, 'allow');
  let conflict: Awaited<ReturnType<typeof authorize>> | null = null;
  await assert.rejects(
    fixture.database.transaction(async (executor) => {
      conflict = await fixture.ports.admission.authorizeAndReserve(
        fixture.admissionInput(REQUEST_B_ID, 'attempt-b', CLIENT_KEY, 'c'.repeat(64)) as never,
        { executor },
      );
      if (conflict.decision !== 'allow') throw new Error('preparation transaction rollback');
      return conflict;
    }),
    /preparation transaction rollback/,
  );
  assert.equal(conflict?.decision, 'reject');
  if (conflict?.decision === 'reject') assert.equal(conflict.code, 'idempotency_conflict');
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.requests.size, 1);
  assert.equal(fixture.capacityReservations.size, 1);
});

test('cross-tenant caller/entitlement binding is rejected before any reservation', async () => {
  const fixture = setup();
  const rejected = await authorize(fixture, {
    ...fixture.admissionInput(),
    caller: caller('platform', OTHER_TENANT_ID, PROJECT_ID, PROXY_KEY_ID),
  } as never);
  assert.equal(rejected.decision, 'reject');
  assert.equal(fixture.calls.capacityReserve, 0);
  assert.equal(fixture.calls.reserve, 0);
});

test('insufficient wallet balance rolls back the HMAC claim, request, attempt, capacity, and hold writes', async () => {
  const fixture = setup('platform', { insufficientFunds: true });
  let decision: Awaited<ReturnType<typeof authorize>> | null = null;
  await assert.rejects(
    fixture.database.transaction(async (executor) => {
      decision = await fixture.ports.admission.authorizeAndReserve(fixture.admissionInput() as never, { executor });
      if (decision.decision !== 'allow') throw new Error('preparation transaction rollback');
      return decision;
    }),
    /preparation transaction rollback/,
  );
  assert.equal(decision?.decision, 'reject');
  if (decision?.decision === 'reject') assert.equal(decision.code, 'hold_denied');
  assert.equal(fixture.requests.size, 0);
  assert.equal(fixture.attempts.size, 0);
  assert.equal(fixture.capacityReservations.size, 0);
  assert.equal(fixture.gatewayIdempotency.size, 0);
  assert.equal(fixture.billingRow, null);
  assert.equal(fixture.calls.reserve, 1);
});

test('a later preparation failure rolls the committed candidate claim and every admission write back', async () => {
  const fixture = setup();
  await assert.rejects(
    fixture.database.transaction(async (executor) => {
      const admission = await fixture.ports.admission.authorizeAndReserve(
        fixture.admissionInput(REQUEST_A_ID, 'attempt-a') as never,
        { executor },
      );
      if (admission.decision !== 'allow') throw new Error('initial admission unexpectedly failed');
      const failedAttempt = await fixture.ports.attempt.persist({ requestId: REQUEST_B_ID } as never, { executor });
      assert.equal(failedAttempt.decision, 'reject');
      throw new Error('preparation transaction rollback');
    }),
    /preparation transaction rollback/,
  );
  assert.equal(fixture.gatewayIdempotency.size, 0);
  assert.equal(fixture.requests.size, 0);
  assert.equal(fixture.attempts.size, 0);
  assert.equal(fixture.capacityReservations.size, 0);
  assert.equal(fixture.billingRow, null);
  assert.equal(fixture.calls.capacityReserve, 1);
  assert.equal(fixture.calls.meter, 1);
  assert.equal(fixture.calls.reserve, 1);
});

test('server request-ID fallback claims once per HTTP request when the client key is absent', async () => {
  const fixture = setup();
  for (const [requestId, attemptId] of [
    [REQUEST_A_ID, 'attempt-a'],
    [REQUEST_B_ID, 'attempt-b'],
  ] as const) {
    const decision = await fixture.database.transaction(async (executor) => {
      const result = await fixture.ports.admission.authorizeAndReserve(
        fixture.admissionInput(requestId, attemptId, requestId) as never,
        { executor },
      );
      if (result.decision !== 'allow') throw new Error('one-shot request-ID claim unexpectedly failed');
      return result;
    });
    assert.equal(decision.decision, 'allow');
  }
  assert.equal(fixture.gatewayIdempotency.size, 2);
  assert.equal(fixture.requests.size, 2);
  assert.equal(fixture.attempts.size, 2);
  assert.equal(fixture.calls.capacityReserve, 2);
  assert.equal(fixture.calls.reserve, 2);
});

test('compensation refuses dispatched and unknown attempts without releasing any reservation', async () => {
  for (const state of ['dispatching', 'unknown']) {
    const fixture = setup();
    const admitted = await authorize(fixture);
    assert.equal(admitted.decision, 'allow');
    if (admitted.decision !== 'allow') continue;
    fixture.setAttemptState(state);
    const decision = await fixture.ports.compensation.releasePreDispatch(
      {
        requestId: REQUEST_A_ID,
        attemptId: 'attempt-a',
        tenantId: TENANT_ID,
        admission: admitted.value,
        expectedAttempt: { dispatchState: 'not_sent', resultState: 'pending', responseStarted: false },
        failedStage: 'attempt',
        failureCode: 'attempt_persistence_failed',
      },
      { executor: fixture.executor },
    );
    assert.notEqual(decision.decision, 'allow', state);
    assert.equal(fixture.calls.capacityRelease, 0, state);
    assert.equal(fixture.calls.walletRelease, 0, state);
  }
});
