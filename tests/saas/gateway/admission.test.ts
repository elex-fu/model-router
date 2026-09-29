import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BillingReservationResult, ReserveBillingInput } from '../../../src/saas/billing/types.js';
import { REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION } from '../../../src/saas/db/migrations/014_request_admission_outbox.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type AdmissionCreateRequestInput,
  createRequestAdmissionReservationBusinessKey,
  type SaasBillingReservationPort,
  type SaasMeteringAdmissionPort,
  type SaasRequestAdmissionGuard,
  type SaasRequestAdmissionGuardInput,
  type SaasRequestAdmissionGuardResult,
  SaasRequestAdmissionService,
} from '../../../src/saas/gateway/admission.js';
import type {
  SaasRequestAdmissionAuthenticatedKey,
  SaasRequestAdmissionAuthorizationPrelock,
  SaasRequestAdmissionAuthorizationPrelockInput,
} from '../../../src/saas/gateway/authorization-prelock.js';
import type {
  AttemptRecord,
  CreateRequestInput,
  IdempotencyRecord,
  InitialAttemptInput,
  RequestAdmission,
  RequestRecord,
} from '../../../src/saas/metering/types.js';

const fixedNow = new Date('2026-09-28T00:00:00.000Z');

interface FakeOutboxRow {
  id: string;
  tenantId: string;
  projectId: string;
  requestId: string;
  attemptId: string;
  supplyMode: string;
  eventKey: string;
  payload: string;
}

interface FakeAuditRow {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  entryPoint: string;
  requestId: string;
}

interface FakeAdmissionState {
  requests: RequestRecord[];
  attempts: AttemptRecord[];
  idempotency: IdempotencyRecord[];
  outbox: FakeOutboxRow[];
  reservations: ReserveBillingInput[];
  audits: FakeAuditRow[];
  events: string[];
  failOutbox: boolean;
  failAudit: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(): FakeAdmissionState {
  return {
    requests: [],
    attempts: [],
    idempotency: [],
    outbox: [],
    reservations: [],
    audits: [],
    events: [],
    failOutbox: false,
    failAudit: false,
  };
}

class FakeAdmissionExecutor implements SqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(readonly state: FakeAdmissionState) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.statements.push({ sql, values });
    const statement = sql.trim().toLowerCase();
    if (statement.startsWith('insert into saas_request_admission_outbox')) {
      if (this.state.failOutbox) throw new Error('injected outbox failure');
      this.state.events.push('outbox');
      this.state.outbox.push({
        id: String(values[0]),
        tenantId: String(values[1]),
        projectId: String(values[2]),
        requestId: String(values[3]),
        attemptId: String(values[4]),
        supplyMode: String(values[5]),
        eventKey: String(values[6]),
        payload: String(values[8]),
      });
    }
    if (statement.startsWith('insert into saas_audit_events')) {
      if (this.state.failAudit) throw new Error('injected audit failure');
      this.state.events.push('audit');
      this.state.audits.push({
        id: String(values[0]),
        tenantId: String(values[1]),
        actorUserId: values[2] === null || values[2] === undefined ? null : String(values[2]),
        action: 'request.admitted',
        targetType: 'saas_request',
        targetId: String(values[3]),
        occurredAt: String(values[4]),
        entryPoint: 'gateway_admission',
        requestId: String(values[3]),
      });
    }
    return { rows: [], rowCount: 0 };
  }
}

class FakeAdmissionDatabase implements SaasDatabase {
  state = emptyState();
  readonly executors: FakeAdmissionExecutor[] = [];
  transactionCalls = 0;
  commits = 0;
  rollbacks = 0;

  async query<Row>(): Promise<SqlResult<Row>> {
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const next = clone(this.state);
    const executor = new FakeAdmissionExecutor(next);
    this.executors.push(executor);
    try {
      const value = await work(executor);
      this.state = next;
      this.commits += 1;
      return value;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }

  async migrate(): Promise<void> {}

  async verifySchema(): Promise<void> {}

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}

function createRequest(supplyMode: 'byok' | 'platform', idempotencyKey = 'retry-key'): AdmissionCreateRequestInput {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'proxy-key-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
    supplyMode,
    principalKind: 'member',
    principalId: 'member-a',
    authzVersion: 1,
    entitlementVersion: 1,
    configVersion: 1,
    projectPolicyVersion: 1,
    routeConfigId: 'route-a',
    routeConfigVersion: 1,
    routePublicModelId: 'route-public-model-a',
    routePublicModelVersion: 1,
    routeProtocol: 'openai',
    routeTargetMode: supplyMode === 'byok' ? 'tenant_account' : 'platform_pool',
    routeUpstreamId: 'upstream-a',
    publicModel: 'model-a',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    requestFingerprint: 'a'.repeat(64),
    requestFingerprintVersion: 'canonical-v1',
    idempotencyKey,
    customerPriceVersion: supplyMode === 'platform' ? 'price-v1' : null,
    initialAttempt: {
      ordinal: 1,
      upstreamId: 'upstream-a',
      accountOwnerKind: supplyMode === 'byok' ? 'tenant' : 'platform',
      accountId: supplyMode === 'byok' ? 'tenant-account-a' : 'platform-account-a',
      providerId: 'provider-a',
      productId: 'product-a',
      resolvedModel: 'model-a',
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      supplierCostVersion: supplyMode === 'platform' ? 'supplier-v1' : null,
      dispatchProfileId: 'profile-a',
      supplyProfileAuthzVersion: 1,
      credentialId: supplyMode === 'platform' ? 'platform-credential-a' : 'tenant-credential-a',
      credentialVersion: 1,
      credentialAuthzVersion: 1,
      accountAuthzVersion: 1,
      projectPolicyVersion: 1,
      routeConfigId: 'route-a',
      routeConfigVersion: 1,
      routePublicModelId: 'route-public-model-a',
      routePublicModelVersion: 1,
      routeProtocol: 'openai',
      routeTargetMode: supplyMode === 'byok' ? 'tenant_account' : 'platform_pool',
      ...(supplyMode === 'byok'
        ? { profileAccountAuthzVersion: 1 }
        : {
            poolId: 'pool-a',
            poolAuthzVersion: 1,
            poolMemberAccountAuthzVersion: 1,
            poolGrantAuthzVersion: 1,
            poolGrantProfileAuthzVersion: 1,
            poolGrantPoolAuthzVersion: 1,
          }),
    } as InitialAttemptInput,
  };
}

function authenticatedKeyForRequest(request: CreateRequestInput): SaasRequestAdmissionAuthenticatedKey {
  return {
    authorization: {
      keyId: request.proxyKeyId,
      tenantId: request.tenantId,
      projectId: request.projectId,
      principalKind: request.principalKind,
      principalId: request.principalId,
      entitlementId: request.entitlementId,
      supplyProfileId: request.supplyProfileId,
      supplyMode: request.supplyMode,
      modelScopes: [request.publicModel],
      authzVersion: Number(request.authzVersion),
      modelScopeVersion: Number(request.modelScopeVersion),
      entitlementAuthzVersion: Number(request.entitlementVersion),
      supplyProfileAuthzVersion: Number(request.supplyProfileVersion),
    },
  };
}

function requestRecord(input: CreateRequestInput, id: string): RequestRecord {
  return {
    id,
    tenantId: input.tenantId,
    projectId: input.projectId,
    projectPolicyVersion:
      input.projectPolicyVersion === undefined || input.projectPolicyVersion === null
        ? null
        : String(input.projectPolicyVersion),
    proxyKeyId: input.proxyKeyId,
    entitlementId: input.entitlementId,
    supplyProfileId: input.supplyProfileId,
    supplyProfileVersion: input.supplyProfileVersion,
    modelScopeVersion: input.modelScopeVersion,
    supplyMode: input.supplyMode,
    principalKind: input.principalKind,
    principalId: input.principalId,
    authzVersion: input.authzVersion,
    entitlementVersion: input.entitlementVersion,
    configVersion: input.configVersion,
    routeConfigId: input.routeConfigId === undefined ? null : String(input.routeConfigId),
    routeConfigVersion:
      input.routeConfigVersion === undefined || input.routeConfigVersion === null
        ? null
        : String(input.routeConfigVersion),
    routePublicModelId: input.routePublicModelId === undefined ? null : String(input.routePublicModelId),
    routePublicModelVersion:
      input.routePublicModelVersion === undefined || input.routePublicModelVersion === null
        ? null
        : String(input.routePublicModelVersion),
    routeProtocol: input.routeProtocol ?? null,
    routeTargetMode: input.routeTargetMode ?? null,
    routeUpstreamId: input.routeUpstreamId ?? null,
    publicModel: input.publicModel,
    protocol: input.protocol,
    endpoint: input.endpoint,
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: input.requestFingerprintVersion,
    idempotencyKeyDigest: input.idempotencyKey ? `digest:${input.idempotencyKey}` : null,
    customerPriceVersion: input.customerPriceVersion ?? null,
    customerMeteringPolicyId: input.customerMeteringPolicyId ?? null,
    customerMeteringPolicyVersion:
      input.customerMeteringPolicyVersion == null ? null : String(input.customerMeteringPolicyVersion),
    providerMeteringPolicyId: input.providerMeteringPolicyId ?? null,
    providerMeteringPolicyVersion:
      input.providerMeteringPolicyVersion == null ? null : String(input.providerMeteringPolicyVersion),
    contractAttestationId: input.contractAttestationId ?? null,
    financialStatus: input.supplyMode === 'platform' ? 'pending' : 'not_applicable',
    resultState: 'pending',
    reconciliationState: 'none',
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    stateVersion: 1,
  };
}

function attemptRecord(input: CreateRequestInput, requestId: string, id: string): AttemptRecord {
  if (!input.initialAttempt) throw new Error('test input must contain an initial attempt');
  const initial = input.initialAttempt;
  return {
    id,
    tenantId: input.tenantId,
    requestId,
    projectPolicyVersion: input.projectPolicyVersion === undefined ? null : String(input.projectPolicyVersion),
    routeConfigId: input.routeConfigId === undefined ? null : String(input.routeConfigId),
    routeConfigVersion:
      input.routeConfigVersion === undefined || input.routeConfigVersion === null
        ? null
        : String(input.routeConfigVersion),
    routePublicModelId: input.routePublicModelId === undefined ? null : String(input.routePublicModelId),
    routePublicModelVersion:
      input.routePublicModelVersion === undefined || input.routePublicModelVersion === null
        ? null
        : String(input.routePublicModelVersion),
    routeProtocol: input.routeProtocol ?? null,
    routeTargetMode: input.routeTargetMode ?? null,
    customerPriceVersion: input.customerPriceVersion ?? null,
    customerMeteringPolicyId: input.customerMeteringPolicyId ?? null,
    customerMeteringPolicyVersion:
      input.customerMeteringPolicyVersion == null ? null : String(input.customerMeteringPolicyVersion),
    providerMeteringPolicyId: input.providerMeteringPolicyId ?? null,
    providerMeteringPolicyVersion:
      input.providerMeteringPolicyVersion == null ? null : String(input.providerMeteringPolicyVersion),
    contractAttestationId: input.contractAttestationId ?? null,
    ordinal: initial.ordinal,
    upstreamId: initial.upstreamId,
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: initial.accountOwnerKind,
    accountId: initial.accountId,
    providerId: initial.providerId,
    productId: initial.productId,
    resolvedModel: initial.resolvedModel,
    protocol: initial.protocol,
    endpoint: initial.endpoint,
    supplierCostVersion: initial.supplierCostVersion ?? null,
    dispatchProfileId: initial.dispatchProfileId,
    supplyProfileAuthzVersion: String(initial.supplyProfileAuthzVersion),
    credentialId: initial.credentialId,
    credentialVersion: String(initial.credentialVersion),
    credentialAuthzVersion: String(initial.credentialAuthzVersion),
    accountAuthzVersion: String(initial.accountAuthzVersion),
    poolId: initial.poolId ?? null,
    poolAuthzVersion: initial.poolAuthzVersion === undefined ? null : String(initial.poolAuthzVersion),
    poolMemberAccountAuthzVersion:
      initial.poolMemberAccountAuthzVersion === undefined ? null : String(initial.poolMemberAccountAuthzVersion),
    poolMemberAuthzVersion:
      initial.poolMemberAuthzVersion === undefined ? null : String(initial.poolMemberAuthzVersion),
    poolGrantAuthzVersion: initial.poolGrantAuthzVersion === undefined ? null : String(initial.poolGrantAuthzVersion),
    poolGrantProfileAuthzVersion:
      initial.poolGrantProfileAuthzVersion === undefined ? null : String(initial.poolGrantProfileAuthzVersion),
    poolGrantPoolAuthzVersion:
      initial.poolGrantPoolAuthzVersion === undefined ? null : String(initial.poolGrantPoolAuthzVersion),
    profileAccountAuthzVersion:
      initial.profileAccountAuthzVersion === undefined ? null : String(initial.profileAccountAuthzVersion),
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    stateVersion: 1,
  };
}

class FakeGuard implements SaasRequestAdmissionGuard {
  readonly inputs: SaasRequestAdmissionGuardInput[] = [];
  resultFactory: ((input: SaasRequestAdmissionGuardInput) => SaasRequestAdmissionGuardResult) | undefined;

  async revalidate(input: SaasRequestAdmissionGuardInput): Promise<SaasRequestAdmissionGuardResult> {
    this.inputs.push(input);
    (input.executor as FakeAdmissionExecutor).state.events.push('guard');
    return this.resultFactory ? this.resultFactory(input) : this.defaultResult(input);
  }

  defaultResult(input: SaasRequestAdmissionGuardInput): SaasRequestAdmissionGuardResult {
    return {
      authorization: {
        tenantId: input.request.tenantId,
        projectId: input.request.projectId,
        proxyKeyId: input.request.proxyKeyId,
        entitlementId: input.request.entitlementId,
        supplyProfileId: input.request.supplyProfileId,
        supplyProfileVersion: input.request.supplyProfileVersion,
        modelScopeVersion: input.request.modelScopeVersion,
        supplyMode: input.request.supplyMode,
        principalKind: input.request.principalKind,
        principalId: input.request.principalId,
        authzVersion: input.request.authzVersion,
        entitlementVersion: input.request.entitlementVersion,
        configVersion: input.request.configVersion,
        projectPolicyVersion: input.request.projectPolicyVersion,
      },
      candidate: input.candidate as unknown as InitialAttemptInput,
      platformPriceHold:
        input.holdEvidence === null
          ? null
          : {
              currency: 'USD',
              amountMinorUnits: 125n,
              priceSnapshotRef: 'snapshot-from-guard',
              expiresAt: '2026-09-28T00:06:00.000Z',
              customerPriceVersion: input.request.customerPriceVersion ?? '',
              supplierCostVersion: input.candidate.supplierCostVersion ?? '',
            },
    };
  }
}

class FakeAuthorizationPrelock implements SaasRequestAdmissionAuthorizationPrelock {
  readonly inputs: SaasRequestAdmissionAuthorizationPrelockInput[] = [];

  async prelock(input: SaasRequestAdmissionAuthorizationPrelockInput): Promise<void> {
    this.inputs.push(input);
    const executor = input.executor as FakeAdmissionExecutor;
    executor.state.events.push('prelock');
  }
}

class FakeMetering implements SaasMeteringAdmissionPort {
  readonly executors: SqlExecutor[] = [];
  calls = 0;
  forcedAdmission: RequestAdmission | undefined;
  private requestSequence = 0;

  async admitRequest(input: CreateRequestInput, options: { executor?: SqlExecutor } = {}): Promise<RequestAdmission> {
    if (!options.executor) throw new Error('missing metering executor');
    this.calls += 1;
    this.executors.push(options.executor);
    const state = (options.executor as FakeAdmissionExecutor).state;
    state.events.push('metering');
    if (this.forcedAdmission) return this.forcedAdmission;
    const existingIdempotency = input.idempotencyKey
      ? state.idempotency.find((record) => record.tenantId === input.tenantId && record.proxyKeyId === input.proxyKeyId)
      : undefined;
    if (existingIdempotency) {
      const request = state.requests.find((candidate) => candidate.id === existingIdempotency.requestId);
      if (!request || existingIdempotency.requestId === null) throw new Error('fake metering state is incomplete');
      return { kind: 'replayed', request, idempotency: existingIdempotency };
    }

    this.requestSequence += 1;
    const requestId = `request-${this.requestSequence}`;
    const request = requestRecord(input, requestId);
    const initialAttempt = attemptRecord(input, requestId, `attempt-${this.requestSequence}`);
    state.requests.push(request);
    state.attempts.push(initialAttempt);
    if (input.idempotencyKey) {
      state.idempotency.push({
        id: `idempotency-${this.requestSequence}`,
        tenantId: input.tenantId,
        proxyKeyId: input.proxyKeyId,
        keyDigest: `digest:${input.idempotencyKey}`,
        requestFingerprint: input.requestFingerprint,
        requestFingerprintVersion: input.requestFingerprintVersion,
        requestId,
        kind: 'active',
        createdAt: fixedNow.toISOString(),
      });
    }
    return {
      kind: 'created',
      request,
      idempotency: state.idempotency.at(-1) ?? null,
      initialAttempt,
    };
  }
}

class FakeBilling implements SaasBillingReservationPort {
  readonly calls: Array<{ executor: SqlExecutor; input: ReserveBillingInput }> = [];
  error: Error | undefined;

  async reserve(executor: SqlExecutor, input: ReserveBillingInput): Promise<BillingReservationResult> {
    this.calls.push({ executor, input });
    if (this.error) throw this.error;
    const state = (executor as FakeAdmissionExecutor).state;
    state.events.push('billing');
    state.reservations.push(input);
    const expiresAt = input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt;
    const amount = typeof input.amountMinorUnits === 'bigint' ? input.amountMinorUnits : BigInt(input.amountMinorUnits);
    return {
      outcome: 'reserved',
      id: 'reservation-1',
      tenantId: input.tenantId,
      walletId: 'wallet-a',
      currency: input.currency,
      requestId: input.requestId,
      idempotencyNamespace: 'saas.billing.reservation',
      businessKey: input.businessKey ?? '',
      amountMinorUnits: amount,
      state: 'reserved',
      status: 'reserved',
      priceSnapshotRef: input.priceSnapshotRef,
      metadataRef: input.metadataRef ?? input.priceSnapshotRef,
      expiresAt,
      settlementId: null,
      settlementAmountMinorUnits: null,
      usageEvidenceRef: null,
      reconciliationReference: null,
      reconciliationEvidenceRef: null,
      releaseId: null,
      releaseEvidenceRef: null,
      ledgerTransactionId: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      walletPostedBalanceMinorUnits: 10_000n,
      activeHoldsMinorUnits: amount,
      availableMinorUnits: 10_000n - amount,
      spendingFrozen: false,
    };
  }
}

function createService(): {
  database: FakeAdmissionDatabase;
  metering: FakeMetering;
  billing: FakeBilling;
  guard: FakeGuard;
  prelock: FakeAuthorizationPrelock;
  service: SaasRequestAdmissionService;
} {
  const database = new FakeAdmissionDatabase();
  const metering = new FakeMetering();
  const billing = new FakeBilling();
  const guard = new FakeGuard();
  const prelock = new FakeAuthorizationPrelock();
  const service = new SaasRequestAdmissionService(database, metering, billing, guard, prelock, {
    idFactory: () => 'outbox-1',
    now: () => new Date(fixedNow.getTime()),
  });
  return { database, metering, billing, guard, prelock, service };
}

function platformCommand() {
  const request = createRequest('platform');
  return {
    supplyMode: 'platform' as const,
    request,
    authenticatedKey: authenticatedKeyForRequest(request),
    holdEvidence: {
      inputTotal: 100,
      inputUncached: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      outputTotal: 50,
      reasoningOutput: 0,
      admissionExpiresAt: '2026-09-28T00:05:00.000Z',
    },
  };
}

test('platform admission prelocks first and uses one executor for all admission writes', async () => {
  const { database, metering, billing, guard, prelock, service } = createService();

  const result = await service.admit(platformCommand());

  assert.equal(result.kind, 'created');
  assert.equal(guard.inputs.length, 1);
  assert.equal(prelock.inputs.length, 1);
  assert.equal(metering.executors.length, 1);
  assert.equal(billing.calls.length, 1);
  assert.equal(prelock.inputs[0]?.executor, metering.executors[0]);
  assert.equal(guard.inputs[0]?.executor, metering.executors[0]);
  assert.equal(metering.executors[0], billing.calls[0]?.executor);
  assert.equal(guard.inputs[0]?.request.id, 'request-1');
  assert.equal(guard.inputs[0]?.candidate.id, 'attempt-1');
  assert.equal(guard.inputs[0]?.holdEvidence?.inputTotal, 100);
  assert.equal(guard.inputs[0]?.holdEvidence?.admissionExpiresAt, '2026-09-28T00:05:00.000Z');
  assert.equal(billing.calls[0]?.input.currency, 'USD');
  assert.equal(billing.calls[0]?.input.amountMinorUnits, 125n);
  assert.equal(billing.calls[0]?.input.priceSnapshotRef, 'snapshot-from-guard');
  assert.equal(billing.calls[0]?.input.expiresAt, '2026-09-28T00:06:00.000Z');
  assert.deepEqual(database.state.events, ['prelock', 'metering', 'guard', 'billing', 'outbox', 'audit']);
  assert.equal(
    billing.calls[0]?.input.businessKey,
    createRequestAdmissionReservationBusinessKey('tenant-a', 'request-1'),
  );
  assert.equal(database.state.requests.length, 1);
  assert.equal(database.state.attempts.length, 1);
  assert.equal(database.state.idempotency.length, 1);
  assert.equal(database.state.reservations.length, 1);
  assert.equal(database.state.outbox.length, 1);
  assert.equal(database.state.audits.length, 1);
  assert.deepEqual(database.state.audits[0], {
    id: database.state.audits[0]?.id,
    tenantId: 'tenant-a',
    actorUserId: 'member-a',
    action: 'request.admitted',
    targetType: 'saas_request',
    targetId: 'request-1',
    occurredAt: fixedNow.toISOString(),
    entryPoint: 'gateway_admission',
    requestId: 'request-1',
  });
  assert.equal(result.outboxEvent.eventType, 'request.admitted');
  assert.deepEqual(JSON.parse(database.state.outbox[0]?.payload ?? '{}'), {
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    request_id: 'request-1',
    attempt_id: 'attempt-1',
    supply_mode: 'platform',
    schema_version: 1,
  });
});

test('joins a caller-owned outer executor without opening a nested transaction', async () => {
  const { database, metering, billing, guard, prelock, service } = createService();
  const outer = new FakeAdmissionExecutor(emptyState());

  const result = await service.admit(platformCommand(), { executor: outer });

  assert.equal(result.kind, 'created');
  assert.equal(database.transactionCalls, 0);
  assert.equal(prelock.inputs[0]?.executor, outer);
  assert.equal(metering.executors[0], outer);
  assert.equal(guard.inputs[0]?.executor, outer);
  assert.equal(billing.calls[0]?.executor, outer);
  assert.deepEqual(outer.state.events, ['prelock', 'metering', 'guard', 'billing', 'outbox', 'audit']);
});

test('caller monetary fields cannot override the guard hold facts', async () => {
  const { billing, service } = createService();
  const command = {
    ...platformCommand(),
    currency: 'EUR',
    amountMinorUnits: 1n,
    priceSnapshotRef: 'caller-controlled-snapshot',
    expiresAt: '2026-09-28T23:59:59.000Z',
  };

  await service.admit(command);

  assert.equal(billing.calls.length, 1);
  assert.equal(billing.calls[0]?.input.currency, 'USD');
  assert.equal(billing.calls[0]?.input.amountMinorUnits, 125n);
  assert.equal(billing.calls[0]?.input.priceSnapshotRef, 'snapshot-from-guard');
  assert.equal(billing.calls[0]?.input.expiresAt, '2026-09-28T00:06:00.000Z');
});

test('platform admission rejects incomplete or malformed hold evidence before opening a transaction', async () => {
  const cases: Array<{
    readonly label: string;
    readonly alter: (command: ReturnType<typeof platformCommand>) => unknown;
  }> = [
    {
      label: 'missing counter',
      alter: (command) => ({
        ...command,
        holdEvidence: (() => {
          const { inputTotal: _inputTotal, ...withoutInputTotal } = command.holdEvidence;
          return withoutInputTotal;
        })(),
      }),
    },
    {
      label: 'negative counter',
      alter: (command) => ({
        ...command,
        holdEvidence: { ...command.holdEvidence, outputTotal: -1 },
      }),
    },
    {
      label: 'fractional counter',
      alter: (command) => ({
        ...command,
        holdEvidence: { ...command.holdEvidence, outputTotal: 1.5 },
      }),
    },
    {
      label: 'invalid expiry',
      alter: (command) => ({
        ...command,
        holdEvidence: { ...command.holdEvidence, admissionExpiresAt: 'not-a-date' },
      }),
    },
  ];

  for (const current of cases) {
    const { database, service } = createService();
    await assert.rejects(
      service.admit(current.alter(platformCommand()) as never),
      /platform (?:holdEvidence|admissionExpiresAt)/,
    );
    assert.equal(database.transactionCalls, 0, `${current.label} opened a transaction`);
  }
});

test('BYOK admission never touches the platform wallet', async () => {
  const { database, billing, service } = createService();
  const request = createRequest('byok');

  const result = await service.admit({
    supplyMode: 'byok',
    request,
    authenticatedKey: authenticatedKeyForRequest(request),
  });

  assert.equal(result.kind, 'created');
  assert.equal(billing.calls.length, 0);
  assert.equal(database.state.reservations.length, 0);
  assert.equal(database.state.outbox.length, 1);
  assert.equal(database.state.outbox[0]?.supplyMode, 'byok');
  assert.equal(database.state.audits[0]?.actorUserId, 'member-a');
  assert.doesNotMatch(JSON.stringify(database.state.audits[0]), /retry-key|prompt|body|secret/i);
});

test('project-service admission follows the same prelock and transactional admission path', async () => {
  const { database, metering, service } = createService();
  const request = createRequest('byok');
  const projectServiceRequest = { ...request, principalKind: 'project_service' as const, principalId: 'project-a' };

  const result = await service.admit({
    supplyMode: 'byok',
    request: projectServiceRequest,
    authenticatedKey: authenticatedKeyForRequest(projectServiceRequest),
  });

  assert.equal(result.kind, 'created');
  assert.equal(metering.calls, 1);
  assert.equal(database.state.audits.length, 1);
  assert.equal(database.state.requests[0]?.principalKind, 'project_service');
  assert.equal(database.state.requests[0]?.principalId, 'project-a');
});

test('replayed admission prelocks current visibility, then skips guard facts and bookkeeping', async () => {
  const { database, billing, guard, metering, prelock, service } = createService();
  const command = platformCommand();

  const first = await service.admit(command);
  const replayCommand = {
    ...command,
    request: {
      ...command.request,
      initialAttempt: { ...command.request.initialAttempt, upstreamId: 'stale-upstream' },
    },
    amountMinorUnits: 999n,
    priceSnapshotRef: 'stale-price',
  };
  const replayGuardError = new Error('replay must not revalidate current routing facts');
  guard.resultFactory = () => {
    throw replayGuardError;
  };
  const replay = await service.admit(replayCommand);

  assert.equal(first.kind, 'created');
  assert.equal(replay.kind, 'replayed');
  assert.equal(prelock.inputs.length, 2);
  assert.equal(metering.calls, 2);
  assert.equal(guard.inputs.length, 1);
  assert.equal(database.state.events.filter((event) => event === 'prelock').length, 2);
  assert.equal(billing.calls.length, 1);
  assert.equal(database.state.events.filter((event) => event === 'guard').length, 1);
  assert.equal(database.state.reservations.length, 1);
  assert.equal(database.state.outbox.length, 1);
  assert.equal(database.state.audits.length, 1);
  assert.equal(replay.outboxEvent, null);
  assert.equal(replay.reservation, null);
});

test('tombstone admission skips current guard facts and all created-request bookkeeping', async () => {
  const { database, billing, guard, metering, service } = createService();
  metering.forcedAdmission = {
    kind: 'tombstone',
    idempotency: {
      id: 'idempotency-tombstone',
      tenantId: 'tenant-a',
      proxyKeyId: 'proxy-key-a',
      keyDigest: 'digest:retry-key',
      requestFingerprint: 'a'.repeat(64),
      requestFingerprintVersion: 'canonical-v1',
      requestId: null,
      kind: 'tombstone',
      createdAt: fixedNow.toISOString(),
    },
  };
  guard.resultFactory = () => {
    throw new Error('tombstone must not revalidate current routing facts');
  };

  const result = await service.admit(platformCommand());

  assert.equal(result.kind, 'tombstone');
  assert.equal(metering.calls, 1);
  assert.equal(guard.inputs.length, 0);
  assert.equal(billing.calls.length, 0);
  assert.deepEqual(database.state.events, ['prelock', 'metering']);
  assert.equal(database.state.requests.length, 0);
  assert.equal(database.state.attempts.length, 0);
  assert.equal(database.state.reservations.length, 0);
  assert.equal(database.state.outbox.length, 0);
  assert.equal(database.state.audits.length, 0);
  assert.equal(result.reservation, null);
  assert.equal(result.outboxEvent, null);
});

test('stale authorization, candidate, and platform price/cost facts reject after metering and roll back', async () => {
  const cases: Array<{
    readonly label: string;
    readonly alter: (result: SaasRequestAdmissionGuardResult) => SaasRequestAdmissionGuardResult;
  }> = [
    {
      label: 'authorization',
      alter: (result) => ({
        ...result,
        authorization: { ...result.authorization, authzVersion: 2 },
      }),
    },
    {
      label: 'candidate',
      alter: (result) => ({
        ...result,
        candidate: { ...result.candidate, upstreamId: 'upstream-stale' },
      }),
    },
    {
      label: 'dispatch authority',
      alter: (result) => ({
        ...result,
        candidate: { ...result.candidate, credentialVersion: 2 },
      }),
    },
    {
      label: 'customer price',
      alter: (result) => ({
        ...result,
        platformPriceHold: result.platformPriceHold
          ? { ...result.platformPriceHold, customerPriceVersion: 'price-stale' }
          : null,
      }),
    },
    {
      label: 'supplier cost',
      alter: (result) => ({
        ...result,
        platformPriceHold: result.platformPriceHold
          ? { ...result.platformPriceHold, supplierCostVersion: 'supplier-stale' }
          : null,
      }),
    },
  ];

  for (const current of cases) {
    const { database, metering, guard, service } = createService();
    guard.resultFactory = (input) => current.alter(guard.defaultResult(input));

    await assert.rejects(service.admit(platformCommand()), /guard mismatch/);

    assert.equal(metering.calls, 1, `${current.label} mismatch did not reach metering`);
    assert.equal(database.executors[0]?.state.requests.length, 1);
    assert.equal(database.executors[0]?.state.attempts.length, 1);
    assert.equal(database.commits, 0);
    assert.equal(database.rollbacks, 1);
    assert.deepEqual(database.state, emptyState());
  }
});

test('malformed guard hold facts reject and roll back the metered request', async () => {
  const cases: Array<{
    readonly label: string;
    readonly alter: (result: SaasRequestAdmissionGuardResult) => SaasRequestAdmissionGuardResult;
  }> = [
    {
      label: 'zero amount',
      alter: (result) => ({
        ...result,
        platformPriceHold: result.platformPriceHold ? { ...result.platformPriceHold, amountMinorUnits: 0n } : null,
      }),
    },
    {
      label: 'number amount',
      alter: (result) => ({
        ...result,
        platformPriceHold: result.platformPriceHold
          ? { ...result.platformPriceHold, amountMinorUnits: 125 as never }
          : null,
      }),
    },
    {
      label: 'missing snapshot reference',
      alter: (result) => ({
        ...result,
        platformPriceHold: result.platformPriceHold ? { ...result.platformPriceHold, priceSnapshotRef: '' } : null,
      }),
    },
    {
      label: 'invalid expiry',
      alter: (result) => ({
        ...result,
        platformPriceHold: result.platformPriceHold ? { ...result.platformPriceHold, expiresAt: 'not-a-date' } : null,
      }),
    },
  ];

  for (const current of cases) {
    const { database, guard, metering, service } = createService();
    guard.resultFactory = (input) => current.alter(guard.defaultResult(input));

    await assert.rejects(service.admit(platformCommand()), /SaaS request admission/);

    assert.equal(metering.calls, 1, `${current.label} did not reach metering`);
    assert.equal(database.commits, 0);
    assert.equal(database.rollbacks, 1);
    assert.deepEqual(database.state, emptyState());
  }
});

test('platform admission fails closed when customer-price or supplier-cost versions are missing', async () => {
  const missingCustomerPrice = createService();
  const command = platformCommand();
  await assert.rejects(
    missingCustomerPrice.service.admit({
      ...command,
      request: { ...command.request, customerPriceVersion: null },
    }),
    /customerPriceVersion is required/,
  );
  assert.equal(missingCustomerPrice.metering.calls, 1);
  assert.equal(missingCustomerPrice.database.rollbacks, 1);
  assert.deepEqual(missingCustomerPrice.database.state, emptyState());

  const missingSupplierCost = createService();
  await assert.rejects(
    missingSupplierCost.service.admit({
      ...command,
      request: {
        ...command.request,
        initialAttempt: { ...command.request.initialAttempt, supplierCostVersion: null },
      },
    }),
    /supplierCostVersion is required/,
  );
  assert.equal(missingSupplierCost.metering.calls, 1);
  assert.equal(missingSupplierCost.database.rollbacks, 1);
  assert.deepEqual(missingSupplierCost.database.state, emptyState());
});

test('a reservation failure propagates and rolls back request, idempotency, and outbox state', async () => {
  const { database, metering, billing, service } = createService();
  const reservationError = new Error('wallet unavailable');
  billing.error = reservationError;

  await assert.rejects(service.admit(platformCommand()), (error: unknown) => error === reservationError);

  assert.equal(metering.executors[0], billing.calls[0]?.executor);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
  assert.deepEqual(database.state, emptyState());

  billing.error = undefined;
  const retry = await service.admit(platformCommand());
  assert.equal(retry.kind, 'created');
  assert.equal(database.state.requests.length, 1);
  assert.equal(database.state.idempotency.length, 1);
  assert.equal(database.state.outbox.length, 1);
  assert.equal(database.state.audits.length, 1);
});

test('audit failure rolls back the request, hold, and outbox atomically', async () => {
  const { database, billing, service } = createService();
  database.state.failAudit = true;

  await assert.rejects(service.admit(platformCommand()), /injected audit failure/);

  assert.equal(billing.calls.length, 1);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
  assert.deepEqual(database.state, { ...emptyState(), failAudit: true });
});

test('outbox failure rolls back the request, hold, and audit fact atomically', async () => {
  const { database, billing, service } = createService();
  database.state.failOutbox = true;

  await assert.rejects(service.admit(platformCommand()), /injected outbox failure/);

  assert.equal(billing.calls.length, 1);
  assert.equal(database.commits, 0);
  assert.equal(database.rollbacks, 1);
  assert.deepEqual(database.state, { ...emptyState(), failOutbox: true });
});

test('admission requires an initial attempt before opening a transaction', async () => {
  const { database, service } = createService();
  const request = createRequest('byok');
  const { initialAttempt: _initialAttempt, ...withoutAttempt } = request;

  await assert.rejects(
    service.admit({
      supplyMode: 'byok',
      request: withoutAttempt as typeof request,
      authenticatedKey: authenticatedKeyForRequest(withoutAttempt as typeof request),
    }),
    /initialAttempt is required/,
  );
  assert.equal(database.transactionCalls, 0);
});

test('the migration constrains the outbox to bounded metadata and future delivery leases', () => {
  const sql = REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION.sql;

  assert.equal(REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION.version, 14);
  assert.match(sql, /FOREIGN KEY \(tenant_id, project_id\)\s+REFERENCES saas_projects \(tenant_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, request_id\)\s+REFERENCES saas_requests \(tenant_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, attempt_id\)\s+REFERENCES saas_attempts \(tenant_id, id\)/i);
  assert.match(sql, /UNIQUE \(tenant_id, event_key\)/i);
  assert.match(sql, /octet_length\(payload::text\) <= 4096/i);
  assert.match(sql, /delivery_state IN \('pending', 'leased', 'delivered', 'failed'\)/i);
  assert.match(sql, /lease_token text/i);
  assert.match(sql, /lease_expires_at timestamptz/i);
  assert.match(sql, /last_error_code text/i);
  assert.match(sql, /last_error_code IS NULL OR last_error_code ~ '\^\[A-Z\]\[A-Z0-9_\]\{0,63\}\$'/i);
  assert.doesNotMatch(sql, /\blast_error\b/i);
  assert.match(sql, /payload_metadata_only/i);
  assert.doesNotMatch(sql, /request_body|response_body|provider_secret|customer_key/i);
});
