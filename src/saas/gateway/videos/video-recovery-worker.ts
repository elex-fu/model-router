import { randomUUID } from 'node:crypto';

import type { GrokVideoUpstreamForwarder } from './grok-video-upstream.js';
import type { SaasVideoBillingStateMachine } from './video-billing-state-machine.js';
import type { SaasVideoTaskRecoveryClaim, SaasVideoTaskStore } from './video-task-store.js';

/**
 * Gap-remediation plan G-A1 (§1.3): the async-video recovery worker —
 * settlement that no longer depends on a client poll.
 *
 * Mechanism (new-api `task_polling.go` + sub2api `batch_image_worker.go`
 * fusion, both reference commits pinned in the plan):
 *
 * - a 15 s loop claims a bounded batch of `billing_state = 'pending'` rows
 *   whose `next_poll_at` is due, under a 90 s PG lease (epoch-fenced);
 * - each claimed task re-dials its BOUND account (the create-time binding —
 *   never another account) and fetches the upstream status exactly like a
 *   client poll does;
 * - a 2xx status drives the EXISTING one-shot billing state machine (the
 *   same `observe()` the client-poll path runs — its idempotent
 *   claim/settle/release chain is untouched);
 * - poll failures are classified six ways (new-api `classifyPollHTTP`) and
 *   counted durably with exponential backoff; the cap escalates to the
 *   fail-closed `skipped` terminal — never a guessed bill;
 * - a worker that dies releases nothing; the expired lease is re-claimable
 *   by any instance, and the epoch fences zombie outcome writes.
 *
 * The worker never re-POSTs a create (plan §11.3: 已被上游接受的任务只回查).
 */

/** new-api TASK_POLL_MAX_FAILURES precedent: default 20, <=0 disables the cap. */
export const VIDEO_RECOVERY_DEFAULT_MAX_POLL_FAILURES = 20;
export const VIDEO_RECOVERY_DEFAULT_INTERVAL_MS = 15_000;
export const VIDEO_RECOVERY_DEFAULT_BATCH_SIZE = 32;
export const VIDEO_RECOVERY_DEFAULT_LEASE_MS = 90_000;
export const VIDEO_RECOVERY_DEFAULT_HEARTBEAT_MS = 30_000;
/** Backoff: base 15 s doubling to a 15 min ceiling (improves new-api's fixed 15 s). */
export const VIDEO_RECOVERY_BACKOFF_BASE_MS = 15_000;
export const VIDEO_RECOVERY_BACKOFF_MAX_MS = 15 * 60_000;
/** new-api classifyPollHTTP: not_found aborts immediately (no retry ladder). */
const NOT_FOUND_STATUSES = new Set([404, 410]);
const AUTH_STATUSES = new Set([401, 403]);

/** The six-class poll outcome (new-api's classification, minus MJ/batch). */
export type VideoRecoveryPollClass = 'ok' | 'not_found' | 'auth' | 'transient' | 'other_client' | 'unrecognized';

export interface VideoRecoveryAlertEvent {
  readonly code: 'VIDEO_RECOVERY_POLL_EXHAUSTED' | 'VIDEO_RECOVERY_UPSTREAM_NOT_FOUND' | 'VIDEO_RECOVERY_LEASE_LOST';
  readonly taskId: string;
  readonly message: string;
}

export type VideoRecoveryAlertSink = (event: VideoRecoveryAlertEvent) => void | Promise<void>;

export interface VideoTaskRecoveryWorkerOptions {
  readonly store: SaasVideoTaskStore;
  readonly forwarder: GrokVideoUpstreamForwarder;
  readonly billing: SaasVideoBillingStateMachine;
  readonly owner?: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  /** Renew the lease when the remaining time drops below this (TTL/3). */
  readonly heartbeatMs?: number;
  readonly maxPollFailures?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  /** Inter-task delay within a batch (new-api's per-channel serial pacing). */
  readonly interTaskDelayMs?: number;
  readonly now?: () => number;
  readonly alerts?: VideoRecoveryAlertSink | null;
}

export interface VideoTaskRecoveryRunResult {
  readonly claimed: number;
  readonly polled: number;
  readonly billed: number;
  readonly failedPolls: number;
  readonly skipped: number;
}

/** The mutable accumulator runOnce() fills (readonly projection for callers). */
interface RunAccumulator {
  claimed: number;
  polled: number;
  billed: number;
  failedPolls: number;
  skipped: number;
}

interface RecoveryOutcome {
  readonly pollClass: VideoRecoveryPollClass;
  readonly failureDelta: number;
  readonly resetFailures: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classifies one upstream status fetch into the six-class outcome. Pure.
 * (Mirrors new-api's classifyPollHTTP; network errors are 'transient'.)
 */
export function classifyRecoveryPoll(
  status:
    | { readonly kind: 'response'; readonly status: number; readonly body: Uint8Array }
    | { readonly kind: 'error' },
): VideoRecoveryPollClass {
  if (status.kind === 'error') return 'transient';
  if (status.status >= 200 && status.status < 300) return 'ok';
  if (NOT_FOUND_STATUSES.has(status.status)) return 'not_found';
  if (AUTH_STATUSES.has(status.status)) return 'auth';
  if (status.status === 429 || status.status >= 500) return 'transient';
  // other 4xx: only a parseable terminal status body would count as
  // progress; without one it is unrecognized (new-api's guard against
  // treating a client error as progress).
  return 'other_client';
}

export function backoffDelayMs(failures: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, failures - 1);
  // 2^(n) growth with an overflow-safe ceiling.
  const factor = Math.min(2 ** Math.min(exponent, 30), Math.ceil(maxMs / baseMs));
  return Math.min(baseMs * factor, maxMs);
}

export class VideoTaskRecoveryWorker {
  private readonly store: SaasVideoTaskStore;
  private readonly forwarder: GrokVideoUpstreamForwarder;
  private readonly billing: SaasVideoBillingStateMachine;
  private readonly owner: string;
  readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxPollFailures: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly interTaskDelayMs: number;
  private readonly now: () => number;
  private readonly alerts: VideoRecoveryAlertSink | null;
  /** The clock reading the current batch was claimed at (lease renewal math). */
  private claimedAtMs = 0;

  constructor(options: VideoTaskRecoveryWorkerOptions) {
    if (!options?.store) throw new Error('the video recovery worker requires a task store');
    if (!options?.forwarder) throw new Error('the video recovery worker requires an upstream forwarder');
    if (!options?.billing) throw new Error('the video recovery worker requires a billing state machine');
    this.store = options.store;
    this.forwarder = options.forwarder;
    this.billing = options.billing;
    this.owner = options.owner ?? `video-recovery-${randomUUID()}`;
    this.batchSize = options.batchSize ?? VIDEO_RECOVERY_DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? VIDEO_RECOVERY_DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? VIDEO_RECOVERY_DEFAULT_HEARTBEAT_MS;
    this.maxPollFailures = options.maxPollFailures ?? VIDEO_RECOVERY_DEFAULT_MAX_POLL_FAILURES;
    this.backoffBaseMs = options.backoffBaseMs ?? VIDEO_RECOVERY_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? VIDEO_RECOVERY_BACKOFF_MAX_MS;
    this.interTaskDelayMs = options.interTaskDelayMs ?? 0;
    this.now = options.now ?? (() => Date.now());
    this.alerts = options.alerts ?? null;
    for (const [name, value] of [
      ['batchSize', this.batchSize],
      ['leaseMs', this.leaseMs],
      ['heartbeatMs', this.heartbeatMs],
      ['backoffBaseMs', this.backoffBaseMs],
      ['backoffMaxMs', this.backoffMaxMs],
      ['interTaskDelayMs', this.interTaskDelayMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`video recovery worker ${name} must be a nonnegative integer`);
      }
    }
    if (this.batchSize < 1 || this.leaseMs < 1 || this.heartbeatMs < 1) {
      throw new RangeError('video recovery worker batchSize, leaseMs and heartbeatMs must be positive');
    }
    if (this.backoffMaxMs < this.backoffBaseMs) {
      throw new RangeError('video recovery worker backoffMaxMs must be >= backoffBaseMs');
    }
  }

  /** One bounded recovery cycle. Safe to run concurrently only via the lease. */
  async runOnce(): Promise<VideoTaskRecoveryRunResult> {
    this.claimedAtMs = this.now();
    const claims = await this.store.claimRecoveryBatch({
      owner: this.owner,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      now: new Date(this.now()).toISOString(),
    });
    const result: RunAccumulator = {
      claimed: claims.length,
      polled: 0,
      billed: 0,
      failedPolls: 0,
      skipped: 0,
    };
    for (const claim of claims) {
      await this.renewLeaseIfNeeded(claim);
      await this.processClaim(claim, result);
      if (this.interTaskDelayMs > 0 && claim !== claims[claims.length - 1]) {
        await new Promise((resolve) => setTimeout(resolve, this.interTaskDelayMs));
      }
    }
    return result;
  }

  private async renewLeaseIfNeeded(claim: SaasVideoTaskRecoveryClaim): Promise<void> {
    // The claim set lease_until = claimTime + leaseMs. Renew when the
    // remaining lifetime drops below heartbeatMs — the TTL/3 sub2api
    // cadence. A long-running earlier task in the batch is what makes the
    // later ones need this.
    const leaseUntilMs = this.claimedAtMs + this.leaseMs;
    if (leaseUntilMs - this.now() < this.heartbeatMs) {
      await this.store
        .renewRecoveryLease(claim.record.requestId, this.owner, claim.leaseEpoch, this.leaseMs)
        .catch(() => false);
    }
  }

  private async processClaim(claim: SaasVideoTaskRecoveryClaim, result: RunAccumulator): Promise<void> {
    const record = claim.record;
    const status = await this.forwarder
      .fetchStatus({
        account: {
          accountId: record.providerAccountId,
          credentialId: record.credentialId,
          credentialVersion: record.credentialVersion,
        },
        requestId: record.requestId,
      })
      .catch(() => null);
    result.polled += 1;

    // Lease lost (expired mid-flight and another worker took over): drop
    // the task silently — the new owner owns the outcome (epoch fencing).
    const outcome = this.outcomeFor(status);
    if (outcome.pollClass === 'ok') {
      let statusBody: Record<string, unknown> | null = null;
      if (status !== null && status.kind === 'response') {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(status.body));
          if (isRecord(parsed)) statusBody = parsed;
        } catch {
          statusBody = null;
        }
      }
      if (statusBody === null) {
        // 2xx with an unparseable body: unrecognized (new-api's
        // hook_error class) — count it, never settle on a guess.
        await this.finishFailure(claim, 'unrecognized', 1, result);
        return;
      }
      // The SAME observe() the client poll runs — one-shot idempotent
      // billing; its failures never throw into the recovery loop.
      const observation = await this.billing
        .observe({ taskId: record.requestId, statusBody, record })
        .catch(() => null);
      if (observation !== null && (observation.disposition === 'billed' || observation.disposition === 'retry')) {
        result.billed += 1;
      }
      // A successful poll resets the failure ladder and re-arms the due
      // cursor; terminal rows stop being claimable (pending-only query).
      await this.recordOutcome(claim, {
        pollClass: 'ok',
        failureDelta: 0,
        resetFailures: true,
      });
      return;
    }

    if (outcome.pollClass === 'not_found') {
      // Upstream says the task is gone (404/410): fail-closed skip — never
      // a guessed bill. The create's stranded attempt stays with the
      // unknown-outcome reconciliation worker (its own timeout policy).
      await this.store.markSkipped(record.requestId).catch(() => false);
      await this.alert({
        code: 'VIDEO_RECOVERY_UPSTREAM_NOT_FOUND',
        taskId: record.requestId,
        message: 'the upstream reports the video task as not found; billing skipped fail-closed',
      });
      result.skipped += 1;
      await this.recordOutcome(claim, {
        pollClass: 'not_found',
        failureDelta: 0,
        resetFailures: true,
      });
      return;
    }

    const failureDelta = outcome.pollClass === 'auth' ? 0 : 1;
    // auth failures wait for an operator (no ladder burn — new-api waits
    // too), but still back off so a dead credential does not hot-loop.
    await this.finishFailure(claim, outcome.pollClass, failureDelta, result);
  }

  private outcomeFor(
    status:
      | { readonly kind: 'response'; readonly status: number; readonly body: Uint8Array }
      | { readonly kind: 'error' }
      | null,
  ): RecoveryOutcome {
    if (status === null) {
      return { pollClass: 'transient', failureDelta: 1, resetFailures: false };
    }
    const pollClass = classifyRecoveryPoll(status);
    return { pollClass, failureDelta: pollClass === 'ok' ? 0 : 1, resetFailures: pollClass === 'ok' };
  }

  private async finishFailure(
    claim: SaasVideoTaskRecoveryClaim,
    pollClass: VideoRecoveryPollClass,
    failureDelta: number,
    result: RunAccumulator,
  ): Promise<void> {
    result.failedPolls += 1;
    const failures = claim.pollFailures + failureDelta;
    if (this.maxPollFailures > 0 && failures >= this.maxPollFailures) {
      // Cap exhausted: fail-closed skip (never a guessed bill) + alert.
      // The unknown-outcome reconciliation worker owns the create's hold.
      await this.store.markSkipped(claim.record.requestId).catch(() => false);
      await this.alert({
        code: 'VIDEO_RECOVERY_POLL_EXHAUSTED',
        taskId: claim.record.requestId,
        message: `recovery poll failures reached the cap (${failures}); billing skipped fail-closed`,
      });
      result.skipped += 1;
      await this.recordOutcome(claim, { pollClass, failureDelta: 0, resetFailures: true });
      return;
    }
    await this.recordOutcome(claim, { pollClass, failureDelta, resetFailures: false });
  }

  private async recordOutcome(claim: SaasVideoTaskRecoveryClaim, outcome: RecoveryOutcome): Promise<boolean> {
    const delay = outcome.resetFailures
      ? VIDEO_RECOVERY_BACKOFF_BASE_MS
      : backoffDelayMs(claim.pollFailures + outcome.failureDelta, this.backoffBaseMs, this.backoffMaxMs);
    const nextPollAt = new Date(this.now() + delay).toISOString();
    const recorded = await this.store
      .recordRecoveryOutcome({
        requestId: claim.record.requestId,
        owner: this.owner,
        epoch: claim.leaseEpoch,
        nextPollAt,
        resetFailures: outcome.resetFailures,
        failureDelta: outcome.failureDelta,
      })
      .catch(() => false);
    if (!recorded) {
      await this.alert({
        code: 'VIDEO_RECOVERY_LEASE_LOST',
        taskId: claim.record.requestId,
        message: 'the recovery lease was lost before the poll outcome could be recorded (epoch fencing held)',
      });
    }
    return recorded;
  }

  private async alert(event: VideoRecoveryAlertEvent): Promise<void> {
    try {
      await this.alerts?.(event);
    } catch {
      // Best-effort, same as the billing alert sink.
    }
  }
}

export interface VideoTaskRecoveryWorkerHandle {
  readonly stop: () => Promise<void>;
}

/**
 * The unref'd timer loop (the customer-webhook worker's scheduling shape):
 * one runOnce() at a time, re-armed at the fixed interval; a full batch
 * re-arms immediately so a backlog drains without waiting.
 */
export function startVideoTaskRecoveryWorker(
  worker: VideoTaskRecoveryWorker,
  options: { readonly intervalMs?: number } = {},
): VideoTaskRecoveryWorkerHandle {
  const intervalMs = options.intervalMs ?? VIDEO_RECOVERY_DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
    throw new RangeError('video recovery worker interval must be between 1000 and 60000 ms');
  }
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, delayMs);
    timer.unref();
  };
  const tick = (): void => {
    if (stopped || running) return;
    running = worker
      .runOnce()
      .then((result) => schedule(result.claimed >= worker.batchSize ? Math.max(500, intervalMs / 2) : intervalMs))
      .catch(() => {
        console.error('model-router video task recovery cycle failed');
        schedule(intervalMs);
      })
      .finally(() => {
        running = undefined;
      });
  };
  schedule(intervalMs);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
