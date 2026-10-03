import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresPreDispatchCompensation } from '../../../src/saas/gateway/postgres-pre-dispatch-compensation.js';
import { GatewayPreDispatchCompensationService } from '../../../src/saas/gateway/pre-dispatch-compensation-service.js';
import type { PostgresPreparationCapacityPort } from '../../../src/saas/gateway/postgres-preparation-ports.js';
import type { RequestPreparationCompensationInput, RequestPreparationPreparedResult } from '../../../src/saas/gateway/request-preparation-service.js';

type Row = Record<string, unknown>;
function setup(mode: 'byok' | 'platform' = 'platform') {
  const binding = { state: 'created' as const, tenantId: 'tenant', projectId: 'project', proxyKeyId: 'key', requestId: 'request',
    keyDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), requestFingerprintVersion: 'v1' };
  const hold = mode === 'byok' ? null : { reservationId: 'hold', tenantId: 'tenant', requestId: 'request',
    reference: 'hold', state: 'reserved' as const,
    currency: 'USD', amountMinorUnits: '20', priceSnapshotRef: 'price', expiresAt: new Date() };
  const command: RequestPreparationCompensationInput = {
    tenantId: 'tenant', requestId: 'request', attemptId: 'attempt', evidenceId: 'evidence', failedStage: 'dispatch', failureCode: 'client_cancelled',
    expectedAttempt: { dispatchState: 'not_sent', resultState: 'pending', responseStarted: false },
    admission: { idempotencyBinding: binding, holdReservation: hold, attemptOrdinal: 1, deadlineAtMs: 1,
      dispatchDeadline: new Date(), expiresAt: new Date(), remainingAttempts: 1, retryBudget: 0, usageBudget: null,
      quotaReservation: { reference: 'quota', state: 'reserved' }, rateReservation: { reference: 'rate', state: 'reserved' } },
  };
  const prepared = { outcome: 'prepared', requestId: 'request', attemptId: 'attempt', admission: command.admission,
    caller: { tenantId: 'tenant', projectId: 'project', supplyMode: mode },
    evidence: { evidenceId: 'evidence', tenantId: 'tenant', projectId: 'project', requestId: 'request', attemptId: 'attempt', supplyMode: mode },
  } as unknown as RequestPreparationPreparedResult;
  let state = {
    request: { id: 'request', project_id: 'project', proxy_key_id: 'key', supply_mode: mode, execution_state: 'pending',
      financial_status: mode === 'byok' ? 'not_applicable' : 'pending', reconciliation_state: 'none', state_version: 1,
      request_fingerprint: binding.requestFingerprint, request_fingerprint_version: 'v1' } as Row,
    attempt: { id: 'attempt', ordinal: 1, dispatch_state: 'not_sent', result_state: 'pending', response_started: false,
      response_started_at: null, result_http_status: null, unknown_reason: null, state_version: 1,
      prepared_evidence_id: null, dispatch_authority_state: 'bound', binding_state: 'bound' } as Row,
    idem: { request_id: 'request', state: 'in_progress', request_fingerprint: binding.requestFingerprint, request_fingerprint_version: 'v1' } as Row,
    capacity: { project_id: 'project', proxy_key_id: 'key', attempt_id: 'attempt', supply_mode: mode,
      idempotency_scope_key: binding.keyDigest, request_fingerprint: binding.requestFingerprint, request_fingerprint_version: 'v1',
      quota_reservation_id: 'quota', rate_reservation_id: 'rate', state: 'reserved' } as Row,
    hold: { id: 'hold', currency: 'USD', amount_minor_units: '20', price_snapshot_ref: 'price', state: 'reserved',
      release_id: null, release_evidence_ref: null } as Row,
    audit: 0,
    extraAttempts: [] as Row[],
  };
  const evidence: Row = { id: 'evidence', project_id: 'project', proxy_key_id: 'key', request_id: 'request',
    attempt_id: 'attempt', supply_mode: mode, request_fingerprint: binding.requestFingerprint, request_fingerprint_version: 'v1', status: 'registered' };
  const sqls: string[] = [];
  let capacityCalls = 0; let walletCalls = 0; let failAudit = false; let commitUncertain = false; let zeroCas = false; let partialCapacity = false;
  const executor: SqlExecutor = { async query<T>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<T>> {
    sqls.push(sql);
    let result: Row[] = [];
    if (sql.includes('FROM saas_gateway_request_idempotency_keys')) result = [state.idem];
    else if (sql.includes('FROM saas_requests WHERE')) result = [state.request];
    else if (sql.includes('FROM saas_attempts WHERE')) result = [state.attempt, ...state.extraAttempts];
    else if (sql.includes('FROM saas_prepared_request_evidence')) result = [evidence];
    else if (sql.includes('FROM saas_gateway_capacity_reservations')) result = [state.capacity];
    else if (sql.includes('FROM saas_wallets')) { walletCalls++; result = [{ id: 'wallet' }]; }
    else if (sql.includes('FROM saas_billing_reservations')) { walletCalls++; result = [state.hold]; }
    else if (sql.startsWith('UPDATE saas_attempts')) {
      if (!zeroCas) { Object.assign(state.attempt, { result_state: 'failed', state_version: 2 }); result = [{ id: 'attempt' }]; }
    } else if (sql.startsWith('UPDATE saas_requests')) {
      Object.assign(state.request, { execution_state: 'failed', financial_status: values[3], state_version: 2 }); result = [{ id: 'request' }];
    } else if (sql.startsWith('UPDATE saas_gateway_request_idempotency_keys')) { state.idem.state = 'completed'; result = [{ request_id: 'request' }]; }
    else if (sql.startsWith('UPDATE saas_gateway_capacity_reservations')) { state.capacity.state = 'retained_for_reconciliation'; result = [{ request_id: 'request' }]; }
    else if (sql.includes('INSERT INTO saas_audit_events')) { if (failAudit) throw new Error('audit unavailable'); state.audit++; return { rows: [], rowCount: 1 }; }
    return { rows: result as T[], rowCount: result.length };
  } };
  const capacity: PostgresPreparationCapacityPort = {
    async reserve() { throw new Error('not used'); },
    async release(tx) {
      assert.strictEqual(tx, executor); capacityCalls++; state.capacity.state = 'released';
      return { quotaReservation: 'released', rateReservation: partialCapacity ? 'retained_for_reconciliation' : 'released' };
    },
  };
  const port = new PostgresPreDispatchCompensation({ capacity, billing: {
    async release(tx, input) {
      assert.strictEqual(tx, executor); walletCalls++;
      Object.assign(state.hold, { state: 'released', release_id: input.releaseId, release_evidence_ref: input.releaseEvidenceRef });
      return { id: 'hold', tenantId: 'tenant', requestId: 'request', state: 'released' } as never;
    },
  } });
  const service = new GatewayPreDispatchCompensationService({ async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
    const before = structuredClone(state);
    let outcome: T;
    try { outcome = await work(executor); } catch (error) { state = before; throw error; }
    if (commitUncertain) throw new Error('commit uncertain');
    return outcome;
  } }, port);
  return { command, prepared, port, service, executor, evidence, sqls, state: () => state,
    calls: () => ({ capacityCalls, walletCalls }), failAudit: () => { failAudit = true; },
    uncertain: () => { commitUncertain = true; }, zeroCas: () => { zeroCas = true; }, partial: () => { partialCapacity = true; } };
}
const cleanup = (fixture: ReturnType<typeof setup>) => fixture.service.compensate({ prepared: fixture.prepared, cause: 'client_cancelled', responseMayHaveStarted: false });

test('platform cancellation atomically closes request/attempt/idempotency and releases exactly once', async () => {
  const f = setup();
  assert.equal((await cleanup(f)).disposition, 'released');
  assert.equal((await cleanup(f)).disposition, 'released');
  assert.equal(f.calls().capacityCalls, 1);
  assert.equal(f.state().audit, 1);
  assert.equal(f.state().attempt.result_state, 'failed');
  assert.equal(f.state().attempt.dispatch_state, 'not_sent');
  assert.equal(f.state().request.financial_status, 'released');
  assert.equal(f.state().idem.state, 'completed');
  const reads = f.sqls.slice(0, 7).join('\n');
  assert.ok(reads.indexOf('idempotency_keys') < reads.indexOf('FROM saas_requests'));
  assert.ok(reads.indexOf('FROM saas_requests') < reads.indexOf('FROM saas_attempts'));
  assert.ok(reads.indexOf('FROM saas_attempts') < reads.indexOf('FROM saas_prepared_request_evidence'));
});

test('BYOK cancellation and replay never query or modify Token wallets', async () => {
  const f = setup('byok');
  assert.equal((await cleanup(f)).holdReservation, 'not_applicable');
  assert.equal((await cleanup(f)).disposition, 'released');
  assert.equal(f.calls().walletCalls, 0);
  assert.equal(f.state().request.financial_status, 'not_applicable');
  assert.ok(f.sqls.every((sql) => !/saas_(?:wallets|billing|ledger)/.test(sql)));
});

test('dispatching, sent, unknown, response delivery and unproven attempt facts retain funds with audit', async () => {
  for (const patch of [{ dispatch_state: 'dispatching' }, { dispatch_state: 'sent' }, { dispatch_state: 'unknown', result_state: 'unknown' },
    { response_started: true }, { unknown_reason: 'possibly executed' }]) {
    const f = setup(); Object.assign(f.state().attempt, patch);
    const result = await cleanup(f);
    assert.equal(result.disposition, 'retained_for_reconciliation');
    assert.equal(f.calls().capacityCalls, 0); assert.equal(f.calls().walletCalls, 0);
    assert.equal(f.state().hold.state, 'reserved'); assert.equal(f.state().audit, 1);
    assert.equal(f.state().capacity.state, 'retained_for_reconciliation');
    assert.equal(f.state().idem.state, 'in_progress');
  }
  const f = setup();
  assert.equal((await f.service.compensate({ prepared: f.prepared, cause: 'dispatch_failed', responseMayHaveStarted: true })).disposition, 'retained_for_reconciliation');
  assert.equal(f.calls().walletCalls, 0);
});

test('cross tenant, attempt, fingerprint and reservation bindings cannot release', async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) => { f.evidence.attempt_id = 'other-attempt'; },
    (f: ReturnType<typeof setup>) => { f.evidence.project_id = 'other-project'; },
    (f: ReturnType<typeof setup>) => { f.state().idem.request_fingerprint = 'other-fingerprint'; },
    (f: ReturnType<typeof setup>) => { f.state().capacity.attempt_id = 'other-attempt'; },
    (f: ReturnType<typeof setup>) => { f.state().capacity.quota_reservation_id = 'other-quota'; },
    (f: ReturnType<typeof setup>) => { Object.assign(f.prepared, { caller: { ...f.prepared.caller, tenantId: 'other-tenant' } }); },
  ]) {
    const f = setup(); mutate(f);
    assert.equal((await cleanup(f)).disposition, 'retained_for_reconciliation');
    assert.equal(f.calls().capacityCalls, 0); assert.equal(f.calls().walletCalls, 0);
    assert.equal(f.state().hold.state, 'reserved');
  }
});

test('a second attempt vetoes request-level release even when the selected attempt is not_sent', async () => {
  const f = setup();
  f.state().extraAttempts.push({ ...f.state().attempt, id: 'another-attempt', ordinal: 2, dispatch_state: 'unknown' });
  assert.equal((await cleanup(f)).disposition, 'retained_for_reconciliation');
  assert.equal(f.calls().capacityCalls, 0); assert.equal(f.calls().walletCalls, 0);
});

test('audit failure, lost CAS and incomplete capacity cleanup roll back every write', async () => {
  for (const fault of ['audit', 'cas', 'partial'] as const) {
    const f = setup(); const before = structuredClone(f.state());
    if (fault === 'audit') f.failAudit(); else if (fault === 'cas') f.zeroCas(); else f.partial();
    assert.equal((await cleanup(f)).disposition, 'retained_for_reconciliation');
    assert.deepEqual(f.state(), before);
  }
});

test('uncertain commit returns unconfirmed retention and never retries or automatically dispatches', async () => {
  const f = setup(); f.uncertain();
  const result = await cleanup(f);
  assert.equal(result.disposition, 'retained_for_reconciliation'); assert.equal(result.manualReconciliationRequired, true);
  assert.equal(f.calls().capacityCalls, 1);
  // The fake COMMIT may have succeeded: the caller cannot invent a rollback or replay it as failure.
  assert.equal(f.state().request.execution_state, 'failed');
});
