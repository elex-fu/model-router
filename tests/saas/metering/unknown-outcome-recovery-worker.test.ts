import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import type { SaasMeteringService } from '../../../src/saas/metering/service.js';
import type { UnknownOutcomeProviderEvidenceObservation } from '../../../src/saas/metering/unknown-outcome-reconciliation-service.js';
import type {
  PreparedUnknownOutcomeResolution,
  ResolveUnknownOutcomeNonExecutionInput,
  UnknownOutcomeCaseCaptureResult,
  UnknownOutcomeCaseObservation,
  UnknownOutcomeOperatorAuthorizationPort,
  UnknownOutcomeOperatorAuthorizationRecheck,
  UnknownOutcomeOperatorCase,
  UnknownOutcomeOperatorCaseDetail,
  UnknownOutcomeOperatorCoverage,
  UnknownOutcomeOperatorResolutionResult,
  UnknownOutcomeRecoveryClaim,
  UnknownOutcomeRecoveryRepository,
  UnknownOutcomeRecoveryRunResult,
  UnknownOutcomeSupplyMode,
} from '../../../src/saas/metering/unknown-outcome-recovery-worker.js';
import {
  PostgresUnknownOutcomeRecoveryRepository,
  UnknownOutcomeOperatorResolutionService,
  UnknownOutcomeReconciliationWorker,
  validateOperatorCoverage,
} from '../../../src/saas/metering/unknown-outcome-recovery-worker.js';

interface FakeAttempt {
  readonly id: string;
  readonly dispatchState: 'not_sent' | 'dispatching' | 'sent' | 'unknown';
  resultState: 'pending' | 'succeeded' | 'failed' | 'unknown';
}

interface FakeRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly supplyMode: UnknownOutcomeSupplyMode;
  resultState: 'unknown' | 'failed';
  reconciliationState: 'pending' | 'resolved';
  financialStatus: 'not_applicable' | 'pending' | 'reconciliation_pending' | 'released';
  holdRetained: boolean;
  readonly attempts: FakeAttempt[];
}

interface FakeCase extends UnknownOutcomeOperatorCase {
  state: 'open' | 'operator_required' | 'resolved' | 'superseded';
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number;
  resolutionIdempotencyKey: string | null;
  resolutionDigest: string | null;
}

function possible(attempt: FakeAttempt): boolean {
  return attempt.dispatchState !== 'not_sent';
}

class MemoryRecoveryRepository implements UnknownOutcomeRecoveryRepository {
  readonly requests: FakeRequest[];
  readonly cases = new Map<string, FakeCase>();
  readonly observations: Array<
    | { readonly kind: 'request' | 'attempt' | 'usage'; readonly requestId: string; readonly attemptId?: string }
    | UnknownOutcomeProviderEvidenceObservation
    | { readonly kind: 'operator'; readonly attemptId: string; readonly evidenceReference: string }
  > = [];
  readonly audit: Array<{ readonly actorUserId: string; readonly caseId: string; readonly reason: string }> = [];
  nowMs = 0;
  captureFailures = 0;
  walletReleaseCalls = 0;
  claimCount = 0;
  captureCount = 0;
  resolutionCalls = 0;
  transactionAuthorizationCalls = 0;
  private nextLease = 0;
  private nextCase = 0;
  private readonly transactionExecutor: SqlExecutor = {
    async query<Row>() {
      return { rows: [] as Row[], rowCount: 0 };
    },
  };

  constructor(requests: readonly FakeRequest[]) {
    this.requests = requests.map((request) => ({
      ...request,
      attempts: request.attempts.map((attempt) => ({ ...attempt })),
    }));
  }

  async claimDue(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly UnknownOutcomeRecoveryClaim[]> {
    for (const request of this.requests) {
      if (
        request.resultState === 'unknown' &&
        request.reconciliationState === 'pending' &&
        !this.cases.has(request.requestId)
      ) {
        this.nextCase += 1;
        this.cases.set(request.requestId, {
          caseId: `case-${this.nextCase}`,
          tenantId: request.tenantId,
          projectId: request.projectId,
          requestId: request.requestId,
          supplyMode: request.supplyMode,
          scanAttempts: 0,
          lastErrorCode: null,
          createdAt: new Date(this.nowMs).toISOString(),
          state: 'open',
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: this.nowMs,
          resolutionIdempotencyKey: null,
          resolutionDigest: null,
        });
      }
    }

    const claims: UnknownOutcomeRecoveryClaim[] = [];
    for (const currentCase of this.cases.values()) {
      if (claims.length >= limit) break;
      if (currentCase.state !== 'open' || currentCase.scanAttempts >= maxAttempts) continue;
      if (currentCase.nextAttemptAt > this.nowMs) continue;
      if (currentCase.leaseExpiresAt !== null && currentCase.leaseExpiresAt > this.nowMs) continue;
      const request = this.request(currentCase.requestId);
      const leaseToken = `lease-${++this.nextLease}`;
      currentCase.scanAttempts += 1;
      currentCase.leaseToken = leaseToken;
      currentCase.leaseExpiresAt = this.nowMs + leaseMs;
      this.claimCount += 1;
      claims.push({
        caseId: currentCase.caseId,
        tenantId: request.tenantId,
        projectId: request.projectId,
        requestId: request.requestId,
        supplyMode: request.supplyMode,
        leaseToken,
        scanAttempt: currentCase.scanAttempts,
      });
    }
    return claims;
  }

  async captureAndEscalate(claim: UnknownOutcomeRecoveryClaim): Promise<UnknownOutcomeCaseCaptureResult> {
    const currentCase = this.caseForClaim(claim);
    if (!currentCase || currentCase.leaseExpiresAt === null || currentCase.leaseExpiresAt <= this.nowMs) {
      return { status: 'lease_lost', caseId: claim.caseId, requestId: claim.requestId };
    }
    if (this.captureFailures > 0) {
      this.captureFailures -= 1;
      throw Object.assign(new Error('simulated transaction failure'), { code: 'MOCK_CAPTURE_FAILED' });
    }

    this.captureCount += 1;
    const request = this.request(claim.requestId);
    if (request.resultState !== 'unknown' || request.reconciliationState !== 'pending') {
      currentCase.state = 'superseded';
      currentCase.leaseToken = null;
      currentCase.leaseExpiresAt = null;
      return { status: 'superseded', caseId: claim.caseId, requestId: claim.requestId };
    }

    this.observations.push({ kind: 'request', requestId: request.requestId });
    for (const attempt of request.attempts)
      this.observations.push({ kind: 'attempt', requestId: request.requestId, attemptId: attempt.id });
    this.observations.push({ kind: 'usage', requestId: request.requestId });
    if (request.supplyMode === 'platform') {
      request.financialStatus = 'reconciliation_pending';
      request.holdRetained = true;
    }
    currentCase.state = 'operator_required';
    currentCase.leaseToken = null;
    currentCase.leaseExpiresAt = null;
    return { status: 'operator_required', caseId: currentCase.caseId, requestId: currentCase.requestId };
  }

  async retryClaim(
    claim: UnknownOutcomeRecoveryClaim,
    errorCode: string,
    backoffMs: number,
    maxAttempts: number,
  ): Promise<boolean> {
    const currentCase = this.caseForClaim(claim);
    if (!currentCase) return false;
    currentCase.lastErrorCode = errorCode;
    currentCase.leaseToken = null;
    currentCase.leaseExpiresAt = null;
    if (currentCase.scanAttempts >= maxAttempts) {
      currentCase.state = 'operator_required';
      return false;
    }
    currentCase.nextAttemptAt = this.nowMs + backoffMs;
    return true;
  }

  async listOperatorRequired(tenantId: string, limit: number): Promise<readonly UnknownOutcomeOperatorCase[]> {
    return [...this.cases.values()]
      .filter((item) => item.tenantId === tenantId && item.state === 'operator_required')
      .slice(0, limit)
      .map(
        ({
          caseId,
          tenantId: caseTenant,
          projectId,
          requestId,
          supplyMode,
          scanAttempts,
          lastErrorCode,
          createdAt,
        }) => ({
          caseId,
          tenantId: caseTenant,
          projectId,
          requestId,
          supplyMode,
          scanAttempts,
          lastErrorCode,
          createdAt,
        }),
      );
  }

  async getOperatorRequired(tenantId: string, caseId: string): Promise<UnknownOutcomeOperatorCaseDetail | null> {
    const summary = (await this.listOperatorRequired(tenantId, 100)).find((item) => item.caseId === caseId);
    if (!summary) return null;
    const possibleAttemptIds = this.request(summary.requestId)
      .attempts.filter(possible)
      .map((attempt) => attempt.id);
    const observations: UnknownOutcomeCaseObservation[] = [];
    return { summary, possibleAttemptIds, observations };
  }

  async resolveNonExecution(
    input: PreparedUnknownOutcomeResolution,
    revalidateAuthorization: UnknownOutcomeOperatorAuthorizationRecheck,
  ): Promise<UnknownOutcomeOperatorResolutionResult> {
    this.resolutionCalls += 1;
    this.transactionAuthorizationCalls += 1;
    if (
      !(await revalidateAuthorization({
        executor: this.transactionExecutor,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorSessionId: input.actorSessionId,
      }))
    ) {
      return { status: 'unauthorized' };
    }
    const currentCase = [...this.cases.values()].find(
      (item) => item.caseId === input.caseId && item.tenantId === input.tenantId,
    );
    if (!currentCase) return { status: 'case_not_found' };
    const request = this.request(currentCase.requestId);
    if (currentCase.state === 'resolved') {
      return currentCase.resolutionIdempotencyKey === input.idempotencyKey &&
        currentCase.resolutionDigest === input.resolutionDigest
        ? { status: 'replayed', caseId: input.caseId, requestId: request.requestId }
        : { status: 'resolution_conflict' };
    }
    if (currentCase.state !== 'operator_required') return { status: 'resolution_conflict' };
    if (request.resultState !== 'unknown' || request.reconciliationState !== 'pending') {
      return { status: 'request_not_unknown' };
    }
    if (
      (request.supplyMode === 'platform' && request.financialStatus !== 'reconciliation_pending') ||
      (request.supplyMode === 'byok' && request.financialStatus !== 'not_applicable')
    ) {
      return { status: 'financial_state_conflict' };
    }

    const possibleIds = request.attempts.filter(possible).map((attempt) => attempt.id);
    const coverageError = validateOperatorCoverage(possibleIds, input.coverage);
    if (coverageError) return coverageError;
    const succeeded = request.attempts.filter((attempt) => possible(attempt) && attempt.resultState === 'succeeded');
    if (succeeded.length > 0)
      return { status: 'contradictory_evidence', attemptIds: succeeded.map((attempt) => attempt.id) };

    for (const attempt of request.attempts) {
      if (possible(attempt)) attempt.resultState = 'failed';
    }
    request.resultState = 'failed';
    request.reconciliationState = 'resolved';
    if (request.supplyMode === 'platform') {
      this.walletReleaseCalls += 1;
      request.financialStatus = 'released';
      request.holdRetained = false;
    }
    this.audit.push({ actorUserId: input.actorUserId, caseId: input.caseId, reason: input.reason });
    for (const item of input.coverage) {
      this.observations.push({
        kind: 'operator',
        attemptId: item.attemptId,
        evidenceReference: item.evidenceReference,
      });
    }
    currentCase.state = 'resolved';
    currentCase.resolutionIdempotencyKey = input.idempotencyKey;
    currentCase.resolutionDigest = input.resolutionDigest;
    return { status: 'resolved', caseId: input.caseId, requestId: request.requestId };
  }

  async recordProviderObservation(input: UnknownOutcomeProviderEvidenceObservation): Promise<void> {
    this.observations.push(input);
  }

  request(requestId: string): FakeRequest {
    const request = this.requests.find((item) => item.requestId === requestId);
    if (!request) throw new Error(`Unknown fake request ${requestId}`);
    return request;
  }

  private caseForClaim(claim: UnknownOutcomeRecoveryClaim): FakeCase | undefined {
    const candidate = this.cases.get(claim.requestId);
    return candidate?.caseId === claim.caseId && candidate.leaseToken === claim.leaseToken ? candidate : undefined;
  }
}

function makeRequest(
  input: {
    readonly supplyMode?: UnknownOutcomeSupplyMode;
    readonly attempts?: readonly FakeAttempt[];
    readonly tenantId?: string;
    readonly requestId?: string;
  } = {},
): FakeRequest {
  const supplyMode = input.supplyMode ?? 'platform';
  return {
    tenantId: input.tenantId ?? 'tenant-a',
    projectId: 'project-a',
    requestId: input.requestId ?? 'request-a',
    supplyMode,
    resultState: 'unknown',
    reconciliationState: 'pending',
    financialStatus: supplyMode === 'platform' ? 'pending' : 'not_applicable',
    holdRetained: supplyMode === 'platform',
    attempts: input.attempts?.map((attempt) => ({ ...attempt })) ?? [
      { id: 'attempt-a', dispatchState: 'unknown', resultState: 'unknown' },
    ],
  };
}

function resolver(
  repository: MemoryRecoveryRepository,
  authorized = true,
  transactionAuthorized = authorized,
): UnknownOutcomeOperatorResolutionService {
  const authorization: UnknownOutcomeOperatorAuthorizationPort = {
    async mayResolveUnknownOutcome() {
      return authorized;
    },
    async revalidateMayResolveUnknownOutcome() {
      return transactionAuthorized;
    },
  };
  return new UnknownOutcomeOperatorResolutionService(authorization, repository);
}

function resolutionInput(
  repository: MemoryRecoveryRepository,
  coverage: readonly UnknownOutcomeOperatorCoverage[],
  overrides: Partial<ResolveUnknownOutcomeNonExecutionInput> = {},
): ResolveUnknownOutcomeNonExecutionInput {
  const currentCase = repository.cases.get('request-a');
  if (!currentCase) throw new Error('Expected a durable case');
  return {
    tenantId: currentCase.tenantId,
    caseId: currentCase.caseId,
    actorUserId: 'operator-a',
    actorSessionId: 'session-a',
    supportTicketRef: 'SUP-1842',
    idempotencyKey: 'resolution-a',
    reason: 'Reviewed provider-side request ledger and confirmed no execution.',
    coverage,
    ...overrides,
  };
}

async function scan(repository: MemoryRecoveryRepository): Promise<UnknownOutcomeRecoveryRunResult> {
  return new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10, maxAttempts: 4 }).runOnce();
}

test('a crashed claim is durably reclaimed after lease expiry by a new worker instance', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  const [crashedClaim] = await repository.claimDue(1, 10, 4);
  assert.ok(crashedClaim);
  assert.equal(repository.cases.get('request-a')?.state, 'open');
  assert.equal(repository.cases.get('request-a')?.scanAttempts, 1);

  repository.nowMs += 11;
  const restartedWorker = new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10, maxAttempts: 4 });
  const result = await restartedWorker.runOnce();

  assert.equal(result.claimed, 1);
  assert.equal(result.operatorRequired.length, 1);
  assert.equal(repository.cases.get('request-a')?.scanAttempts, 2);
  assert.equal(repository.captureCount, 1);
  assert.equal(repository.request('request-a').financialStatus, 'reconciliation_pending');
  assert.equal(repository.request('request-a').holdRetained, true);
  assert.deepEqual(
    repository.observations.filter((item) => 'kind' in item).map((item) => item.kind),
    ['request', 'attempt', 'usage'],
  );
});

test('failed scans persist bounded retry timing and resume after restart', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  repository.captureFailures = 1;
  const firstWorker = new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10, maxAttempts: 4 });
  const failed = await firstWorker.runOnce();
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.deferred, ['case-1']);
  assert.equal(repository.cases.get('request-a')?.lastErrorCode, 'MOCK_CAPTURE_FAILED');
  assert.equal(repository.cases.get('request-a')?.nextAttemptAt, 1_000);

  const restartedWorker = new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10, maxAttempts: 4 });
  assert.equal((await restartedWorker.runOnce()).claimed, 0);
  repository.nowMs = 1_000;
  const retried = await restartedWorker.runOnce();
  assert.equal(retried.claimed, 1);
  assert.equal(retried.operatorRequired.length, 1);
  assert.equal(repository.cases.get('request-a')?.scanAttempts, 2);
});

test('retry exhaustion stops scanning and leaves an alertable operator case', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  repository.captureFailures = 3;
  const worker = new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10, maxAttempts: 2 });

  const first = await worker.runOnce();
  assert.deepEqual(first.deferred, ['case-1']);
  repository.nowMs = 1_000;
  const exhausted = await worker.runOnce();

  assert.deepEqual(exhausted.operatorRequired, ['case-1']);
  assert.equal(repository.cases.get('request-a')?.state, 'operator_required');
  assert.equal(repository.cases.get('request-a')?.scanAttempts, 2);
  repository.nowMs += 10_000;
  assert.equal((await worker.runOnce()).claimed, 0);
});

test('concurrent duplicate scans claim a logical request only once', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  const workerA = new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10 });
  const workerB = new UnknownOutcomeReconciliationWorker(repository, { leaseMs: 10 });
  const results = await Promise.all([workerA.runOnce(), workerB.runOnce()]);

  assert.equal(
    results.reduce((sum, result) => sum + result.claimed, 0),
    1,
  );
  assert.equal(repository.claimCount, 1);
  assert.equal(repository.captureCount, 1);
  assert.equal(repository.cases.size, 1);
});

test('multi-attempt unknown requests require exact evidence coverage and reject contradiction', async () => {
  const repository = new MemoryRecoveryRepository([
    makeRequest({
      attempts: [
        { id: 'attempt-a', dispatchState: 'sent', resultState: 'unknown' },
        { id: 'attempt-b', dispatchState: 'unknown', resultState: 'unknown' },
      ],
    }),
  ]);
  await scan(repository);
  const service = resolver(repository);
  const details = await service.get('tenant-a', 'case-1');
  assert.deepEqual(details?.possibleAttemptIds, ['attempt-a', 'attempt-b']);
  assert.equal(await service.get('tenant-b', 'case-1'), null);

  const insufficient = await service.resolveNotExecuted(
    resolutionInput(repository, [{ attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'ledger:a' }]),
  );
  assert.deepEqual(insufficient, { status: 'insufficient_evidence', missingAttemptIds: ['attempt-b'] });
  assert.equal(repository.walletReleaseCalls, 0);

  const contradictory = await service.resolveNotExecuted(
    resolutionInput(repository, [
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'ledger:a' },
      { attemptId: 'attempt-b', outcome: 'executed', evidenceReference: 'ledger:b' },
    ]),
  );
  assert.deepEqual(contradictory, { status: 'contradictory_evidence', attemptIds: ['attempt-b'] });
  assert.equal(repository.resolutionCalls, 1, 'contradictory input is rejected before repository mutation');
  assert.equal(repository.request('request-a').resultState, 'unknown');
});

test('platform hold stays pending through incomplete evidence and releases once on audited resolution', async () => {
  const repository = new MemoryRecoveryRepository([
    makeRequest({
      attempts: [
        { id: 'attempt-a', dispatchState: 'unknown', resultState: 'unknown' },
        { id: 'attempt-b', dispatchState: 'sent', resultState: 'unknown' },
      ],
    }),
  ]);
  await scan(repository);
  const request = repository.request('request-a');
  assert.equal(request.financialStatus, 'reconciliation_pending');
  assert.equal(request.holdRetained, true);

  const service = resolver(repository);
  const partialEvidence = await service.resolveNotExecuted(
    resolutionInput(repository, [
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'provider-audit:request-17' },
    ]),
  );
  assert.deepEqual(partialEvidence, { status: 'insufficient_evidence', missingAttemptIds: ['attempt-b'] });
  assert.equal(repository.walletReleaseCalls, 0);
  assert.equal(request.holdRetained, true);

  const evidence = [
    { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'provider-audit:request-17' },
    { attemptId: 'attempt-b', outcome: 'not_executed', evidenceReference: 'provider-audit:request-18' },
  ] as const;
  const input = resolutionInput(repository, evidence);
  const [first, concurrentReplay] = await Promise.all([
    service.resolveNotExecuted(input),
    service.resolveNotExecuted(input),
  ]);
  assert.deepEqual(new Set([first.status, concurrentReplay.status]), new Set(['resolved', 'replayed']));
  assert.equal(request.financialStatus, 'released');
  assert.equal(request.holdRetained, false);
  assert.equal(repository.walletReleaseCalls, 1);
  assert.equal(repository.audit.length, 1);
  assert.equal(repository.audit[0]?.actorUserId, 'operator-a');
  assert.equal(repository.observations.filter((item) => 'kind' in item && item.kind === 'operator').length, 2);

  const replay = await service.resolveNotExecuted(input);
  assert.equal(replay.status, 'replayed');
  assert.equal(repository.audit.length, 1);
  const conflict = await service.resolveNotExecuted(
    resolutionInput(repository, evidence, { idempotencyKey: 'different-key' }),
  );
  assert.equal(conflict.status, 'resolution_conflict');
  const supportTicketConflict = await service.resolveNotExecuted(
    resolutionInput(repository, evidence, { supportTicketRef: 'SUP-1843' }),
  );
  assert.equal(supportTicketConflict.status, 'resolution_conflict');
});

test('support ticket references are trimmed and bounded before authorization or persistence', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  await scan(repository);
  const service = resolver(repository);
  const base = resolutionInput(repository, [
    { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'provider-audit:request-17' },
  ]);

  const resolved = await service.resolveNotExecuted({ ...base, supportTicketRef: ' SUP-1842 ' });
  assert.equal(resolved.status, 'resolved');
  const trimmedReplay = await service.resolveNotExecuted({ ...base, supportTicketRef: 'SUP-1842' });
  assert.equal(trimmedReplay.status, 'replayed');

  await assert.rejects(service.resolveNotExecuted({ ...base, supportTicketRef: '   ' }), /Invalid supportTicketRef/);
  await assert.rejects(
    service.resolveNotExecuted({ ...base, supportTicketRef: 'x'.repeat(256) }),
    /Invalid supportTicketRef/,
  );
});

test('BYOK unknown recovery and operator resolution never access platform wallet state', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest({ supplyMode: 'byok' })]);
  await scan(repository);
  const request = repository.request('request-a');
  assert.equal(request.financialStatus, 'not_applicable');
  assert.equal(repository.walletReleaseCalls, 0);
  const result = await resolver(repository).resolveNotExecuted(
    resolutionInput(repository, [
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'provider-audit:request-17' },
    ]),
  );
  assert.equal(result.status, 'resolved');
  assert.equal(request.financialStatus, 'not_applicable');
  assert.equal(repository.walletReleaseCalls, 0);
});

test('tenant authorization gates operator resolution and provider not-found remains an observation, not proof', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  await scan(repository);
  const unauthorized = await resolver(repository, false).resolveNotExecuted(
    resolutionInput(repository, [
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'provider-audit:request-17' },
    ]),
  );
  assert.deepEqual(unauthorized, { status: 'unauthorized' });
  assert.equal(repository.resolutionCalls, 0);

  await repository.recordProviderObservation({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
    status: 'not_found',
    providerOperationId: null,
    evidenceReference: 'lookup:attempt-a',
    providerIdentityDigest: null,
    usage: null,
  });
  const providerObservation = repository.observations.find(
    (item): item is UnknownOutcomeProviderEvidenceObservation => 'status' in item,
  );
  assert.equal(providerObservation?.status, 'not_found');
  assert.equal(repository.cases.get('request-a')?.state, 'operator_required');
  assert.equal(repository.request('request-a').holdRetained, true);
});

test('transactional authorization recheck rejects a revocation after the preflight', async () => {
  const repository = new MemoryRecoveryRepository([makeRequest()]);
  await scan(repository);

  // The preflight observes the role before a concurrent revocation commits;
  // the transaction-bound recheck must observe the revoked authority before
  // request/attempt mutation is allowed to proceed.
  const service = resolver(repository, true, false);
  const result = await service.resolveNotExecuted(
    resolutionInput(repository, [
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'provider-audit:request-17' },
    ]),
  );

  assert.deepEqual(result, { status: 'unauthorized' });
  assert.equal(repository.resolutionCalls, 1);
  assert.equal(repository.transactionAuthorizationCalls, 1);
  assert.equal(repository.request('request-a').resultState, 'unknown');
  assert.equal(repository.request('request-a').reconciliationState, 'pending');
  assert.equal(repository.request('request-a').holdRetained, true);
  assert.equal(repository.audit.length, 0);
});

test('postgres resolution rechecks authorization on its transaction executor before request locks', async () => {
  const queries: string[] = [];
  let transactionExecutor: SqlExecutor | undefined;
  const executor: SqlExecutor = {
    async query<Row>(sql: string) {
      queries.push(sql);
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
  transactionExecutor = executor;
  const database = {
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return work(executor);
    },
  } as unknown as SaasDatabase;
  const repository = new PostgresUnknownOutcomeRecoveryRepository(database, {} as SaasMeteringService);
  const input: PreparedUnknownOutcomeResolution = {
    tenantId: 'tenant-a',
    caseId: 'case-a',
    actorUserId: 'operator-a',
    actorSessionId: 'session-a',
    supportTicketRef: 'SUP-1842',
    idempotencyKey: 'resolution-a',
    reason: 'The provider-side request ledger confirms no execution.',
    coverage: [{ attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'ledger:a' }],
    resolutionDigest: '0'.repeat(64),
    evidenceDigest: '1'.repeat(64),
  };

  const result = await repository.resolveNonExecution(input, async ({ executor: recheckExecutor, actorSessionId }) => {
    assert.equal(recheckExecutor, transactionExecutor);
    assert.equal(actorSessionId, 'session-a');
    return false;
  });

  assert.deepEqual(result, { status: 'unauthorized' });
  assert.equal(queries.length, 0, 'authorization recheck runs before request/attempt queries');
});

test('postgres resolution persists the support ticket on the case and every operator observation', async () => {
  const calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  const caseRow = {
    id: 'case-a',
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    request_id: 'request-a',
    supply_mode: 'byok',
    case_state: 'operator_required',
    scan_attempt_count: 1,
    lease_token: null,
    last_error_code: null,
    created_at: '2026-09-28T00:00:00.000Z',
    resolution_idempotency_key: null,
    resolution_digest: null,
  };
  const executor: SqlExecutor = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM saas_unknown_outcome_reconciliation_cases')) {
        return { rows: [caseRow] as Row[], rowCount: 1 };
      }
      if (sql.includes('FROM saas_requests')) {
        return {
          rows: [
            {
              id: 'request-a',
              tenant_id: 'tenant-a',
              project_id: 'project-a',
              supply_mode: 'byok',
              execution_state: 'unknown',
              reconciliation_state: 'pending',
              financial_status: 'not_applicable',
              state_version: 1,
            },
          ] as Row[],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM saas_attempts')) {
        return {
          rows: [
            {
              id: 'attempt-a',
              dispatch_state: 'unknown',
              result_state: 'failed',
              response_started: false,
              state_version: 1,
              unknown_reason: 'provider timeout',
              upstream_id: 'upstream-a',
              account_owner_kind: null,
              account_id: null,
              provider_id: null,
              product_id: null,
              resolved_model: 'model-a',
            },
          ] as Row[],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE saas_unknown_outcome_reconciliation_cases')) {
        return { rows: [{ id: 'case-a' }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 1 };
    },
  };
  const database = {
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return work(executor);
    },
  } as unknown as SaasDatabase;
  const metering = {
    async transitionRequest() {
      return { stateVersion: 2 };
    },
  } as unknown as SaasMeteringService;
  const repository = new PostgresUnknownOutcomeRecoveryRepository(database, metering);
  const input: PreparedUnknownOutcomeResolution = {
    tenantId: 'tenant-a',
    caseId: 'case-a',
    actorUserId: 'operator-a',
    actorSessionId: 'session-a',
    supportTicketRef: 'SUP-1842',
    idempotencyKey: 'resolution-a',
    reason: 'The provider-side request ledger confirms no execution.',
    coverage: [{ attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'ledger:a' }],
    resolutionDigest: '0'.repeat(64),
    evidenceDigest: '1'.repeat(64),
  };

  const result = await repository.resolveNonExecution(input, async () => true);

  assert.deepEqual(result, { status: 'resolved', caseId: 'case-a', requestId: 'request-a' });
  const observationInsert = calls.find(
    (call) =>
      call.sql.includes('INSERT INTO saas_unknown_outcome_reconciliation_observations') &&
      call.sql.includes('operator_resolution'),
  );
  assert.match(observationInsert?.sql ?? '', /support_ticket_ref/);
  assert.equal(observationInsert?.values[21], 'SUP-1842');
  const caseUpdate = calls.find((call) => call.sql.startsWith('UPDATE saas_unknown_outcome_reconciliation_cases'));
  assert.match(caseUpdate?.sql ?? '', /resolution_support_ticket_ref = \$9/);
  assert.equal(caseUpdate?.values[8], 'SUP-1842');
  assert.equal(
    calls.some((call) => call.values.some((value) => value === 'session-a')),
    false,
    'actorSessionId is authorization-only and is not persisted',
  );
  assert.ok(
    calls.some((call) => call.values.some((value) => value === 'operator-a')),
    'actorUserId remains present in the audit/observation writes',
  );
});

test('coverage validator rejects missing, duplicate, and unexpected attempt evidence', () => {
  const expected = ['attempt-a', 'attempt-b'];
  assert.equal(
    validateOperatorCoverage(expected, [{ attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'e:a' }])
      ?.status,
    'insufficient_evidence',
  );
  assert.deepEqual(
    validateOperatorCoverage(expected, [
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'e:a' },
      { attemptId: 'attempt-a', outcome: 'not_executed', evidenceReference: 'e:a2' },
      { attemptId: 'attempt-b', outcome: 'not_executed', evidenceReference: 'e:b' },
      { attemptId: 'attempt-c', outcome: 'not_executed', evidenceReference: 'e:c' },
    ]),
    { status: 'unexpected_attempt_coverage', attemptIds: ['attempt-a', 'attempt-c'] },
  );
});
