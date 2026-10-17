import { extractVideoBillingObservation, isVideoStatusBillable, stableVideoBillingRequestId } from './video-billing.js';
import type { SaasVideoSettlementOutcome, SaasVideoSettlementPort } from './video-settlement-port.js';
import type { SaasVideoTaskRecord, SaasVideoTaskStore } from './video-task-store.js';

/**
 * Roadmap batch 4 §4.3 (task #17) — the async video billing state machine
 * (the sub2api pending-billing → claim → RecordUsage → release chain).
 *
 * A status or content poll observes one upstream status body and drives
 * billing exactly once for the task's lifetime:
 *
 * 1. `status != done || no video.url` → nothing to bill (poll continues);
 * 2. billable + the task row is missing (expired / snapshot lost) or the
 *    observation cannot be priced → **fail-closed skip + alert** — never a
 *    default-price charge (task #17: pending 快照丢失绝不按默认低价计);
 * 3. billable + already billed/skipped → idempotent no-op;
 * 4. billable + pending → **one-shot claim** (atomic pending → billed;
 *    concurrent polls cannot both win), then the deferred settlement
 *    through the conditional reconciliation channel;
 * 5. settlement settled/replayed → billed (replayed is a retry after an
 *    already-settled task — the idempotency key makes it safe);
 * 6. settlement failed → **claim released** so a later poll retries
 *    billing (the settlement idempotency key guarantees the retry can
 *    never double-charge) + alert.
 *
 * BYOK rows carry no settlement facts (no wallet exists to charge): the
 * claim still transitions once so polls are idempotent, and no wallet
 * settlement runs.
 */

export type SaasVideoBillingDisposition =
  /** The status is not a completed video — nothing to bill. */
  | 'not_billable'
  /** Claimed and settled (or an idempotent replay of an earlier settle). */
  | 'billed'
  /** The claim was lost to another poll or the terminal state already held. */
  | 'already_billed'
  /** Fail-closed: unpriceable observation or missing snapshot; alerted. */
  | 'skipped'
  /** Settlement failed; the claim was released and a later poll retries. */
  | 'retry';

export interface SaasVideoBillingAlertEvent {
  readonly code:
    | 'VIDEO_BILLING_SNAPSHOT_MISSING'
    | 'VIDEO_BILLING_UNPRICEABLE'
    | 'VIDEO_BILLING_SETTLEMENT_FAILED'
    | 'VIDEO_BILLING_SKIP_FAILED';
  readonly taskId: string;
  readonly message: string;
}

export type SaasVideoBillingAlertSink = (event: SaasVideoBillingAlertEvent) => void | Promise<void>;

export interface SaasVideoBillingStateMachineOptions {
  readonly store: SaasVideoTaskStore;
  readonly settlement: SaasVideoSettlementPort;
  /** Best-effort fail-closed/retry alerts; absent stays silent. */
  readonly alerts?: SaasVideoBillingAlertSink | null;
}

export interface SaasVideoBillingObservationInput {
  readonly taskId: string;
  /** The upstream status body one poll observed (already fetched). */
  readonly statusBody: unknown;
  /** The task row the query port resolved (null when absent/expired). */
  readonly record: SaasVideoTaskRecord | null;
}

export interface SaasVideoBillingObservationResult {
  readonly disposition: SaasVideoBillingDisposition;
  readonly taskId: string;
  readonly reason?: string;
}

export class SaasVideoBillingStateMachine {
  private readonly store: SaasVideoTaskStore;
  private readonly settlement: SaasVideoSettlementPort;
  private readonly alerts: SaasVideoBillingAlertSink | null;

  constructor(options: SaasVideoBillingStateMachineOptions) {
    if (!options?.store) throw new TypeError('the video billing state machine requires a store');
    if (!options.settlement) throw new TypeError('the video billing state machine requires a settlement port');
    this.store = options.store;
    this.settlement = options.settlement;
    this.alerts = options.alerts ?? null;
  }

  private async alert(event: SaasVideoBillingAlertEvent): Promise<void> {
    try {
      await this.alerts?.(event);
    } catch {
      // Alerting is best-effort; the disposition stands.
    }
  }

  async observe(input: SaasVideoBillingObservationInput): Promise<SaasVideoBillingObservationResult> {
    const taskId = input.taskId.trim();
    if (taskId === '') return { disposition: 'not_billable', taskId };
    if (!isVideoStatusBillable(input.statusBody)) {
      return { disposition: 'not_billable', taskId };
    }

    const record = input.record;
    if (record === null) {
      // The task row is gone (TTL) or was never persisted: nothing anchors
      // the pricing identity — fail closed, never a default-price charge.
      await this.alert({
        code: 'VIDEO_BILLING_SNAPSHOT_MISSING',
        taskId,
        message: 'a completed video has no create-time snapshot; billing skipped fail-closed',
      });
      return { disposition: 'skipped', taskId, reason: 'snapshot_missing' };
    }
    if (record.requestId !== taskId) {
      return { disposition: 'not_billable', taskId, reason: 'record_mismatch' };
    }
    if (record.billingState === 'billed') return { disposition: 'already_billed', taskId };
    if (record.billingState === 'skipped') return { disposition: 'skipped', taskId };

    const observation = extractVideoBillingObservation(input.statusBody, {
      model: record.model,
      resolution: record.resolution,
      durationSeconds: record.durationSeconds,
      videoCount: record.videoCount,
    });
    if (observation === null) {
      // Billable but unpriceable (no model identity resolvable): skip
      // fail-closed rather than guessing a rate card.
      const marked = await this.store.markSkipped(taskId).catch(() => false);
      await this.alert({
        code: 'VIDEO_BILLING_UNPRICEABLE',
        taskId,
        message: 'a completed video status cannot be priced; billing skipped fail-closed',
      });
      if (!marked) {
        await this.alert({
          code: 'VIDEO_BILLING_SKIP_FAILED',
          taskId,
          message: 'the video billing skip transition did not apply',
        });
      }
      return { disposition: 'skipped', taskId, reason: 'unpriceable' };
    }

    // The one-shot claim: a concurrent poll that loses the UPDATE reads
    // null and stops — exactly one poll settles this task.
    const claimed = await this.store.claimBilling(taskId);
    if (claimed === null) return { disposition: 'already_billed', taskId };

    if (record.settlementFacts === null) {
      // BYOK supply: no wallet settlement exists. The claim still gates
      // idempotency so repeated polls are one-transition no-ops.
      return { disposition: 'billed', taskId, reason: 'byok_no_wallet_settlement' };
    }

    let outcome: SaasVideoSettlementOutcome;
    try {
      outcome = await this.settlement.settle({
        tenantId: record.tenantId,
        gatewayRequestId: record.gatewayRequestId,
        gatewayAttemptId: record.gatewayAttemptId,
        billingRequestId: stableVideoBillingRequestId(taskId),
        observation,
        facts: record.settlementFacts,
      });
    } catch (error) {
      // A thrown settlement is a transient failure: release the claim so a
      // later poll retries (the idempotency key makes the retry safe).
      await this.store.releaseBilling(taskId).catch(() => false);
      await this.alert({
        code: 'VIDEO_BILLING_SETTLEMENT_FAILED',
        taskId,
        message: `video settlement threw: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
      return { disposition: 'retry', taskId, reason: 'settlement_threw' };
    }

    if (outcome.status === 'settled' || outcome.status === 'replayed') {
      return { disposition: 'billed', taskId, ...(outcome.status === 'replayed' ? { reason: 'replayed' } : {}) };
    }

    // Failed settlement: release the claim for a later poll's retry.
    await this.store.releaseBilling(taskId).catch(() => false);
    await this.alert({
      code: 'VIDEO_BILLING_SETTLEMENT_FAILED',
      taskId,
      message: `video settlement failed (${outcome.reason}); claim released for retry`,
    });
    return { disposition: 'retry', taskId, reason: outcome.reason };
  }
}
