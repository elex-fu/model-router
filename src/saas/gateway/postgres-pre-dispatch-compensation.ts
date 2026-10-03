import { randomUUID } from 'node:crypto';
import type { PlatformWalletLedgerService } from '../billing/service.js';
import { saasAdvisoryKey } from '../db/advisory-lock-keys.js';
import type { SqlExecutor } from '../db/types.js';
import { createRequestAdmissionReservationBusinessKey } from './admission.js';
import type { PostgresPreparationCapacityPort } from './postgres-preparation-ports.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationCompensationInput,
  type RequestPreparationCompensationPort,
  type RequestPreparationCompensationResult,
  type RequestPreparationSqlOptions,
} from './request-preparation-service.js';

type Row = Record<string, unknown>;
const SAFE_FAILURE = 'SaaS pre-dispatch compensation could not be confirmed.';
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;

async function rows(tx: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row[]> {
  return (await tx.query<Row>(sql, values)).rows;
}
async function exactlyOne(tx: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row> {
  const result = await rows(tx, sql, values);
  if (result.length !== 1) throw new Error(SAFE_FAILURE);
  return result[0]!;
}

/**
 * Uses the caller's executor exclusively. All authority reads and CAS writes
 * occur in that transaction. Any failed write MUST escape to roll it back.
 * The caller must not commit a reject/block decision after partial cleanup.
 */
export class PostgresPreDispatchCompensation implements RequestPreparationCompensationPort {
  constructor(private readonly options: {
    readonly capacity?: PostgresPreparationCapacityPort;
    readonly billing: Pick<PlatformWalletLedgerService, 'release'>;
  }) {}

  async releasePreDispatch(input: RequestPreparationCompensationInput, sqlOptions?: RequestPreparationSqlOptions) {
    const tx = sqlOptions?.executor;
    if (!tx || !this.options.capacity) return blockRequestPreparation('capability_unavailable', SAFE_FAILURE);
    const binding = input.admission?.idempotencyBinding;
    if (
      !binding || binding.state !== 'created' || binding.tenantId !== input.tenantId ||
      binding.requestId !== input.requestId || !text(binding.projectId) || !text(binding.proxyKeyId) ||
      !text(binding.keyDigest) || !/^[0-9a-f]{64}$/.test(binding.keyDigest) ||
      !text(binding.requestFingerprint) || !text(binding.requestFingerprintVersion) ||
      !text(input.attemptId) || !text(input.admission.quotaReservation?.reference) ||
      !text(input.admission.rateReservation?.reference) ||
      input.expectedAttempt?.dispatchState !== 'not_sent' || input.expectedAttempt.resultState !== 'pending' ||
      input.expectedAttempt.responseStarted !== false
    ) return { decision: 'reject' as const, code: 'binding_mismatch' as const, message: SAFE_FAILURE };

    // Same tenant/project fences as admission and evidence claim. Shared fences
    // protect scope while request/attempt row locks serialize dispatch and cleanup.
    for (const key of [saasAdvisoryKey.tenant(input.tenantId), saasAdvisoryKey.project(input.tenantId, binding.projectId)]) {
      await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [key]);
    }
    const idem = await exactlyOne(tx,
      `SELECT tenant_id, project_id, proxy_key_id, key_digest, request_id,
              request_fingerprint, request_fingerprint_version, state
         FROM saas_gateway_request_idempotency_keys
        WHERE tenant_id = $1 AND project_id = $2 AND proxy_key_id = $3 AND key_digest = $4
        FOR UPDATE`, [input.tenantId, binding.projectId, binding.proxyKeyId, binding.keyDigest]);
    if (idem.request_id !== input.requestId || idem.request_fingerprint !== binding.requestFingerprint ||
      idem.request_fingerprint_version !== binding.requestFingerprintVersion) throw new Error(SAFE_FAILURE);
    const request = await exactlyOne(tx,
      `SELECT id, tenant_id, project_id, proxy_key_id, supply_mode, request_fingerprint,
              request_fingerprint_version, execution_state, financial_status, reconciliation_state, state_version
         FROM saas_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [input.tenantId, input.requestId]);
    if (request.project_id !== binding.projectId || request.proxy_key_id !== binding.proxyKeyId ||
      request.request_fingerprint !== binding.requestFingerprint ||
      request.request_fingerprint_version !== binding.requestFingerprintVersion ||
      (request.supply_mode !== 'byok' && request.supply_mode !== 'platform')) throw new Error(SAFE_FAILURE);

    // Lock EVERY attempt in stable order. Another attempt or any ambiguous
    // dispatch is never ignored when deciding whether this logical hold is safe.
    const attempts = await rows(tx,
      `SELECT id, tenant_id, request_id, ordinal, dispatch_state, result_state, response_started,
              response_started_at, result_http_status, unknown_reason, state_version, prepared_evidence_id,
              dispatch_authority_state, binding_state
         FROM saas_attempts WHERE tenant_id = $1 AND request_id = $2 ORDER BY ordinal, id FOR UPDATE`,
      [input.tenantId, input.requestId]);
    const attempt = attempts.find((row) => row.id === input.attemptId);
    if (!attempt || attempt.ordinal !== input.admission.attemptOrdinal) throw new Error(SAFE_FAILURE);
    if (input.evidenceId !== undefined) {
      const evidence = await exactlyOne(tx,
        `SELECT id, tenant_id, project_id, proxy_key_id, request_id, attempt_id, supply_mode,
                request_fingerprint, request_fingerprint_version, status
           FROM saas_prepared_request_evidence WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [input.tenantId, input.evidenceId]);
      if (evidence.project_id !== binding.projectId || evidence.proxy_key_id !== binding.proxyKeyId ||
        evidence.request_id !== input.requestId || evidence.attempt_id !== input.attemptId ||
        evidence.supply_mode !== request.supply_mode || evidence.request_fingerprint !== binding.requestFingerprint ||
        evidence.request_fingerprint_version !== binding.requestFingerprintVersion ||
        !['registered', 'claimed'].includes(String(evidence.status)) ||
        (attempt.prepared_evidence_id !== null && attempt.prepared_evidence_id !== input.evidenceId)) {
        throw new Error(SAFE_FAILURE);
      }
    }
    const capacity = await exactlyOne(tx,
      `SELECT project_id, proxy_key_id, request_id, attempt_id, supply_mode, idempotency_scope_key,
              request_fingerprint, request_fingerprint_version, quota_reservation_id, rate_reservation_id, state
         FROM saas_gateway_capacity_reservations WHERE tenant_id = $1 AND request_id = $2 FOR UPDATE`,
      [input.tenantId, input.requestId]);
    if (capacity.project_id !== binding.projectId || capacity.proxy_key_id !== binding.proxyKeyId ||
      capacity.attempt_id !== input.attemptId || capacity.supply_mode !== request.supply_mode ||
      capacity.idempotency_scope_key !== binding.keyDigest || capacity.request_fingerprint !== binding.requestFingerprint ||
      capacity.request_fingerprint_version !== binding.requestFingerprintVersion ||
      capacity.quota_reservation_id !== input.admission.quotaReservation.reference ||
      capacity.rate_reservation_id !== input.admission.rateReservation.reference) throw new Error(SAFE_FAILURE);

    const result = (released: boolean): RequestPreparationCompensationResult => ({
      requestId: input.requestId, attemptId: input.attemptId,
      disposition: released ? 'released' : 'retained_for_reconciliation',
      quotaReservation: released ? 'released' : 'retained_for_reconciliation',
      rateReservation: released ? 'released' : 'retained_for_reconciliation',
      holdReservation: request.supply_mode === 'byok' ? 'not_applicable' : released ? 'released' : 'retained_for_reconciliation',
      manualReconciliationRequired: !released,
    });
    const cancelled = attempts.length === 1 && attempt.dispatch_state === 'not_sent' &&
      attempt.result_state === 'failed' && attempt.response_started === false &&
      attempt.response_started_at === null && attempt.result_http_status === null && attempt.unknown_reason === null;
    // Only our own complete atomic lifecycle constitutes a released replay.
    if (cancelled && request.execution_state === 'failed' && request.reconciliation_state === 'none' &&
      request.financial_status === (request.supply_mode === 'byok' ? 'not_applicable' : 'released') &&
      idem.state === 'completed' && capacity.state === 'released') {
      if (request.supply_mode === 'platform') await this.assertHold(tx, input, true);
      else if (input.admission.holdReservation !== null) throw new Error(SAFE_FAILURE);
      return allowRequestPreparation(result(true));
    }
    const safe = input.responseMayHaveStarted !== true && attempts.length === 1 &&
      attempt.dispatch_state === 'not_sent' && attempt.result_state === 'pending' && attempt.response_started === false &&
      attempt.response_started_at === null && attempt.result_http_status === null && attempt.unknown_reason === null &&
      attempt.dispatch_authority_state === 'bound' && attempt.binding_state === 'bound' &&
      request.execution_state === 'pending' && request.reconciliation_state === 'none' &&
      request.financial_status === (request.supply_mode === 'byok' ? 'not_applicable' : 'pending') &&
      idem.state === 'in_progress' && capacity.state === 'reserved';
    if (!safe) {
      if (capacity.state === 'reserved') {
        await exactlyOne(tx,
          `UPDATE saas_gateway_capacity_reservations SET state = 'retained_for_reconciliation', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND request_id = $2 AND state = 'reserved' RETURNING request_id`,
          [input.tenantId, input.requestId]);
        await this.audit(tx, input, 'retained');
      }
      return allowRequestPreparation(result(false));
    }

    // The existing capacity port requires not_sent/pending while releasing.
    // Its incomplete outcome is a rollback, never a partially committed release.
    const releasedCapacity = await this.options.capacity.release(tx, {
      tenantId: input.tenantId, projectId: binding.projectId, requestId: input.requestId, attemptId: input.attemptId,
      quotaReservation: input.admission.quotaReservation, rateReservation: input.admission.rateReservation,
    });
    if (releasedCapacity.quotaReservation !== 'released' || releasedCapacity.rateReservation !== 'released') {
      throw new Error(SAFE_FAILURE);
    }
    // CAS invalidates any preflight snapshot. 059 also fences all future DB dispatch transitions.
    await exactlyOne(tx,
      `UPDATE saas_attempts SET result_state = 'failed', updated_at = clock_timestamp(), state_version = state_version + 1
        WHERE tenant_id = $1 AND request_id = $2 AND id = $3 AND state_version = $4
          AND dispatch_state = 'not_sent' AND result_state = 'pending' AND response_started = false RETURNING id`,
      [input.tenantId, input.requestId, input.attemptId, attempt.state_version]);
    if (request.supply_mode === 'platform') {
      await this.assertHold(tx, input, false);
      const hold = input.admission.holdReservation!;
      const released = await this.options.billing.release(tx, {
        supplyMode: 'platform', tenantId: input.tenantId, requestId: input.requestId, currency: hold.currency,
        businessKey: createRequestAdmissionReservationBusinessKey(input.tenantId, input.requestId),
        releaseId: `gateway-pre-dispatch:${input.attemptId}`,
        releaseEvidenceRef: `gateway-pre-dispatch:${input.attemptId}`,
      });
      if (released.id !== hold.reservationId || released.tenantId !== input.tenantId ||
        released.requestId !== input.requestId || released.state !== 'released') throw new Error(SAFE_FAILURE);
    } else if (input.admission.holdReservation !== null) throw new Error(SAFE_FAILURE);
    await exactlyOne(tx,
      `UPDATE saas_requests SET execution_state = 'failed', financial_status = $4,
              updated_at = clock_timestamp(), state_version = state_version + 1
        WHERE tenant_id = $1 AND id = $2 AND state_version = $3 AND execution_state = 'pending'
          AND reconciliation_state = 'none' AND financial_status = $5 RETURNING id`,
      [input.tenantId, input.requestId, request.state_version,
        request.supply_mode === 'byok' ? 'not_applicable' : 'released',
        request.supply_mode === 'byok' ? 'not_applicable' : 'pending']);
    await exactlyOne(tx,
      `UPDATE saas_gateway_request_idempotency_keys SET state = 'completed', completed_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND project_id = $2 AND proxy_key_id = $3 AND key_digest = $4
          AND request_id = $5 AND state = 'in_progress' RETURNING request_id`,
      [input.tenantId, binding.projectId, binding.proxyKeyId, binding.keyDigest, input.requestId]);
    await this.audit(tx, input, 'released');
    return allowRequestPreparation(result(true));
  }

  private async assertHold(tx: SqlExecutor, input: RequestPreparationCompensationInput, replay: boolean) {
    const hold = input.admission.holdReservation;
    if (!hold || hold.tenantId !== input.tenantId || hold.requestId !== input.requestId) throw new Error(SAFE_FAILURE);
    // Lock wallet BEFORE reservation, matching the existing billing service.
    await exactlyOne(tx, 'SELECT id FROM saas_wallets WHERE tenant_id = $1 AND currency = $2 FOR UPDATE',
      [input.tenantId, hold.currency]);
    const row = await exactlyOne(tx,
      `SELECT id, tenant_id, request_id, currency, amount_minor_units, price_snapshot_ref, state,
              release_id, release_evidence_ref
         FROM saas_billing_reservations WHERE tenant_id = $1 AND request_id = $2
          AND idempotency_namespace = 'saas.billing.reservation' AND business_key = $3 FOR UPDATE`,
      [input.tenantId, input.requestId, createRequestAdmissionReservationBusinessKey(input.tenantId, input.requestId)]);
    if (row.id !== hold.reservationId || row.currency !== hold.currency ||
      String(row.amount_minor_units) !== String(hold.amountMinorUnits) || row.price_snapshot_ref !== hold.priceSnapshotRef ||
      row.state !== (replay ? 'released' : 'reserved') ||
      (replay && (row.release_id !== `gateway-pre-dispatch:${input.attemptId}` ||
        row.release_evidence_ref !== `gateway-pre-dispatch:${input.attemptId}`))) throw new Error(SAFE_FAILURE);
  }

  private async audit(tx: SqlExecutor, input: RequestPreparationCompensationInput, disposition: 'released' | 'retained') {
    const inserted = await tx.query(
      `INSERT INTO saas_audit_events (id, tenant_id, actor_user_id, action, target_type, target_id,
              occurred_at, entry_point, request_id)
       VALUES ($1, $2, NULL, $3, 'request', $4, clock_timestamp(), 'gateway-pre-dispatch-compensation', $4)`,
      [randomUUID(), input.tenantId, `saas.request.pre_dispatch_${disposition}`, input.requestId]);
    if (inserted.rowCount !== 1) throw new Error(SAFE_FAILURE);
  }
}
