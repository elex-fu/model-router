import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MAX_MINOR_UNITS, normalizeCurrency, parseMinorUnits } from '../../billing/money.js';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { calculateConservativePriceHold, INPUT_BILLING_BUCKETS } from '../hold-calculator.js';
import {
  type BoundedOwnerActivation,
  ensureBoundedCreditBudget,
  verifyBoundedOwner,
} from './bounded-deployment-budget.js';
import { type FastCreditWaitResult, waitForFastCreditDelay, waitForFastCreditWork } from './credit-wait.js';
import { getPreparedFastReceipt } from './prepared-receipt.js';
import {
  calculateFastReceiptCharge,
  fastJournalCanonicalJson,
  fastJournalDigest,
  validatePriceSnapshot,
} from './receipt-evidence.js';

export {
  calculateFastReceiptCharge,
  type FastPriceSnapshot,
  fastJournalCanonicalJson,
  fastJournalDigest,
} from './receipt-evidence.js';

// At most seven BUSY reselections (eight intent statements), plus the separate
// one-shot NOT_READY recovery. Positive floors prevent repeated completed worker
// hints from turning a 100ms budget into an unbounded number of SQL attempts.
const CREDIT_BUSY_BACKOFF_MS = [0, 1, 2, 4, 8, 16, 25] as const;

export interface FastReserveIntentInput {
  readonly requestId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly idempotencyKey?: string;
  readonly requestFingerprint: string;
  readonly payloadSha256: string;
  readonly accountId: string;
  readonly currency: string | null;
  readonly maxCostMinorUnits: string;
  readonly priceSnapshot: unknown;
  readonly authoritySnapshot: unknown;
  readonly allocationOwner: string;
  /** Trusted minimum of snapshot and local concurrency caps, never a client field. */
  readonly allocationTargetConcurrency?: number;
  readonly sendDeadlineMs: number;
  /** Cancels preparation/recovery only; an in-flight write remains uncertain. */
  readonly signal?: AbortSignal;
}
export interface FastIntent {
  readonly id: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly maxCostMinorUnits: string;
}
export type FastReserveResult =
  | { readonly kind: 'created'; readonly intent: FastIntent }
  | { readonly kind: 'existing'; readonly requestId: string; readonly status: string }
  | { readonly kind: 'denied'; readonly reason: string };
export interface FastReceiptInput {
  readonly intentId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly outcome: 'succeeded' | 'failed' | 'unknown';
  readonly chargeMinorUnits: string | null;
  readonly usage: Readonly<Record<string, string | null>>;
  readonly usageDigest: string;
  readonly httpStatus: number | null;
  /** Internal frozen price proof only; never part of canonical provider evidence. */
  readonly verification?: { readonly priceSnapshot: unknown };
}
/**
 * Trusted transport contract: this exact tuple is legal ONLY when sendFast has
 * never been entered. DNS, socket, timeout and every post-send failure are
 * unknown; completed non-2xx responses retain their actual HTTP status.
 */
export function isFastDefinitelyUnsentReceipt(input: {
  readonly outcome: string;
  readonly chargeMinorUnits: string | null;
  readonly usage: Readonly<Record<string, string | null>>;
  readonly httpStatus: number | null;
}): boolean {
  return (
    input.outcome === 'failed' &&
    input.chargeMinorUnits === '0' &&
    input.httpStatus === null &&
    input.usage !== null &&
    typeof input.usage === 'object' &&
    !Array.isArray(input.usage) &&
    Object.keys(input.usage).length === 0
  );
}

export interface FastGatewayJournal {
  reserveIntent(input: FastReserveIntentInput): Promise<FastReserveResult>;
  appendReceipt(input: FastReceiptInput): Promise<void>;
}
export interface FastJournalOptions {
  readonly allocationOwner: string;
  /** Explicitly activated two-worker slot; omitted preserves legacy single-process behavior. */
  readonly boundedDeployment?: BoundedOwnerActivation;
  /** Present: fixed hard escrow cap. Absent: auto 2*M*trusted concurrency, wallet-backed. */
  readonly allocationTrancheMinorUnits?: string;
  /** Total tranche is shared by these stripes, never multiplied. Default 8. */
  readonly allocationStripes?: number;
  readonly workerPollMs?: number;
  readonly workerBatchSize?: number;
  readonly onBackgroundError?: (code: string) => void;
  readonly onCreditUnavailable?: (reason: 'credit_busy' | 'credit_not_ready') => void;
  readonly onCreditRecovery?: (reason: 'credit_busy' | 'credit_not_ready') => void;
}

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('FAST_JOURNAL_INVALID_DIGEST');
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
function one(rowCount: number | null): void {
  if (rowCount !== 1) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
}

/** Public/deserialized evidence never inherits the module's private ownership proof. */
function prepareUntrustedReceipt(input: FastReceiptInput): {
  values: readonly unknown[];
  receiptDigest: string;
} {
  const proofInput = input;
  input = JSON.parse(
    fastJournalCanonicalJson({
      intentId: input.intentId,
      requestId: input.requestId,
      tenantId: input.tenantId,
      outcome: input.outcome,
      chargeMinorUnits: input.chargeMinorUnits,
      usage: input.usage,
      usageDigest: input.usageDigest,
      httpStatus: input.httpStatus,
    }),
  ) as FastReceiptInput;
  digest(input.usageDigest);
  if (input.chargeMinorUnits !== null) parseMinorUnits(input.chargeMinorUnits, { allowZero: true });
  if (input.outcome === 'unknown' && input.chargeMinorUnits !== null) throw new Error('FAST_JOURNAL_UNKNOWN_CHARGE');
  for (const value of Object.values(input.usage)) if (value !== null) parseMinorUnits(value, { allowZero: true });
  // Keep the v1 digest unchanged even when the caller adds internal proof.
  const evidence = {
    intentId: input.intentId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    outcome: input.outcome,
    chargeMinorUnits: input.chargeMinorUnits,
    usage: input.usage,
    usageDigest: input.usageDigest,
    httpStatus: input.httpStatus,
  };
  const receiptDigest = fastJournalDigest(evidence);
  const usageJson = fastJournalCanonicalJson(input.usage);
  let verifiedPrice: string | null = null;
  if (
    input.outcome === 'succeeded' &&
    input.httpStatus !== null &&
    input.httpStatus >= 200 &&
    input.httpStatus < 300 &&
    input.chargeMinorUnits !== null
  ) {
    try {
      const priceSnapshot = proofInput.verification?.priceSnapshot;
      if (priceSnapshot != null) {
        const priceJson = fastJournalCanonicalJson(priceSnapshot);
        if (calculateFastReceiptCharge(JSON.parse(priceJson), JSON.parse(usageJson)) === BigInt(input.chargeMinorUnits))
          verifiedPrice = priceJson;
      }
    } catch {
      // Invalid proof must not discard the only durable provider evidence.
      // Preserve the old uncompressed path; the worker independently checks it.
    }
  }
  // Snapshot every parameter before the first await. Retrying a receipt is
  // safe; retrying an intent/upstream execution is deliberately forbidden.
  const values = [
    input.intentId,
    input.tenantId,
    input.requestId,
    input.outcome,
    input.chargeMinorUnits,
    usageJson,
    input.usageDigest,
    receiptDigest,
    input.httpStatus,
    verifiedPrice !== null
      ? 'pending_v2'
      : input.outcome === 'succeeded' || isFastDefinitelyUnsentReceipt(input)
        ? 'pending'
        : 'blocked',
    verifiedPrice,
  ];
  return { values, receiptDigest };
}

/** No ON CONFLICT: a duplicate MUST roll back the dependent credit decrement.
 * Candidate discovery is intentionally unlocked. The guarded UPDATE locks only
 * one allocation, avoiding lock cycles from rotated FOR UPDATE scans after EPQ.
 * A concurrently depleted candidate may conservatively deny, never overspend.
 */
const RESERVE_SQL = `/* fast-journal:reserve-intent */
WITH current_owner AS MATERIALIZED (
  SELECT owner, epoch FROM saas_fast_gateway_owners WHERE owner = $13 AND epoch = $14 FOR SHARE
), candidate AS MATERIALIZED (
  SELECT a.id FROM saas_fast_credit_allocations a JOIN current_owner o ON o.owner=a.owner AND o.epoch=a.epoch
   WHERE a.tenant_id=$4 AND a.currency=$9 AND a.owner=$13 AND a.epoch=$14
     AND a.state='active' AND a.available_minor_units >= $10::bigint
   ORDER BY ((a.stripe::integer - $18::integer + 8) % 8)
   LIMIT 1
), credit AS (
  UPDATE saas_fast_credit_allocations a
     SET available_minor_units = available_minor_units - $10::bigint
    FROM current_owner o, candidate c
   WHERE a.id=c.id AND a.tenant_id = $4 AND a.currency = $9 AND a.owner = $13 AND a.epoch = $14
     AND a.state = 'active' AND a.available_minor_units >= $10::bigint
     AND o.owner = a.owner AND o.epoch = a.epoch
  RETURNING a.id, a.epoch
), inserted AS (
  INSERT INTO saas_fast_gateway_intents
    (id, request_id, attempt_id, tenant_id, project_id, proxy_key_id, request_fingerprint,
     payload_sha256, account_id, currency, max_cost_minor_units, price_snapshot, authority_snapshot,
     allocation_id, allocation_epoch, send_deadline, intent_digest)
  SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::text, $16::text, $9::text, $10::bigint, $11::jsonb, $12::jsonb,
         credit.id, credit.epoch, $15::timestamptz, $17::text FROM credit
  UNION ALL
  SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::text, $16::text, NULL::text, $10::bigint, NULL::jsonb, $12::jsonb,
         NULL::uuid, NULL::uuid, $15::timestamptz, $17::text FROM current_owner WHERE $9::text IS NULL
  RETURNING id
)
SELECT id,false AS credit_busy,false AS credit_recoverable FROM inserted
UNION ALL SELECT NULL::uuid,EXISTS(SELECT 1 FROM candidate) AS credit_busy,
  (SELECT COALESCE(SUM(a.available_minor_units),0) >= $10::bigint
     FROM saas_fast_credit_allocations a
    WHERE a.tenant_id=$4 AND a.currency=$9 AND a.owner=$13 AND a.epoch=$14 AND a.state='active')
  AS credit_recoverable
WHERE NOT EXISTS(SELECT 1 FROM inserted)`;

interface AllocationRow {
  id: string;
  owner: string;
  tenant_id: string;
  currency: string;
  wallet_id: string;
  epoch: string;
  state: 'active' | 'retired';
  backing_minor_units: string;
  available_minor_units: string;
}

interface FastBatchProgress {
  readonly planned: Set<string>;
  readonly restored: Set<string>;
}

export class PostgresFastGatewayJournal implements FastGatewayJournal {
  private readonly epoch: string;
  private readonly boundedDeployment?: BoundedOwnerActivation;
  private readonly tranche: bigint | null;
  private readonly stripes: number;
  private readonly observedMaximum = new Map<
    string,
    {
      maximum: bigint;
      target: bigint;
      nextStripe: number;
      preparedMaximum: bigint | null;
      preparedTarget: bigint | null;
      backgroundRefillAfter: number;
      restoreGeneration: bigint;
    }
  >();
  private readonly ready: Promise<void>;
  private readonly pendingReplenishments = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  /** Planned scopes become progress hints only after this exact batch commits. */
  private readonly batchRestorations = new WeakMap<Promise<number>, FastBatchProgress>();
  private closed = false;
  private workerStarted = false;
  private wakeRequested = false;
  private workerFailed = false;
  private idleDelay = 25;
  private pollDueAt = 0;

  constructor(
    private readonly database: SaasDatabase,
    private readonly options: FastJournalOptions,
  ) {
    if (!options.allocationOwner.trim()) throw new Error('FAST_JOURNAL_INVALID_OWNER');
    if (options.boundedDeployment && options.boundedDeployment.owner !== options.allocationOwner)
      throw new Error('BOUNDED_DEPLOYMENT_OWNER_CONFLICT');
    this.boundedDeployment = options.boundedDeployment ? Object.freeze({ ...options.boundedDeployment }) : undefined;
    this.epoch = this.boundedDeployment?.epoch ?? randomUUID();
    this.tranche =
      options.allocationTrancheMinorUnits === undefined ? null : parseMinorUnits(options.allocationTrancheMinorUnits);
    this.stripes = options.allocationStripes ?? 8;
    if (!Number.isSafeInteger(this.stripes) || this.stripes < 1 || this.stripes > 8)
      throw new Error('FAST_JOURNAL_INVALID_STRIPES');
    this.ready = this.boundedDeployment
      ? this.prepareBoundedOwner(this.boundedDeployment)
      : database
          .query(
            `INSERT INTO saas_fast_gateway_owners(owner, epoch) VALUES ($1, $2)
       ON CONFLICT (owner) DO UPDATE SET epoch = EXCLUDED.epoch`,
            [options.allocationOwner, this.epoch],
          )
          .then(() => undefined);
    // A failed startup cannot become an unhandled rejection before the first call.
    void this.ready.catch(() => this.reportBackgroundError('FAST_JOURNAL_STARTUP_FAILED'));
  }

  /** Startup only, after externally proven old-process closure and explicit activation.
   * Retire unused old-epoch funds even if this slot receives no subsequent traffic.
   * Outstanding intents/receipts retain their original backing and identity. */
  private async prepareBoundedOwner(activation: BoundedOwnerActivation): Promise<void> {
    await verifyBoundedOwner(this.database, activation);
    const wallets = await this.database.query<{ tenant_id: string; currency: string }>(
      "SELECT DISTINCT tenant_id,currency FROM saas_fast_credit_allocations WHERE owner=$1 AND epoch<>$2 AND state='active' ORDER BY tenant_id,currency",
      [activation.owner, activation.epoch],
    );
    for (const wallet of wallets.rows) {
      await this.database.transaction(async (tx) => {
        const owner = await tx.query<{ epoch: string }>(
          'SELECT epoch FROM saas_fast_gateway_owners WHERE owner=$1 FOR SHARE',
          [activation.owner],
        );
        if (owner.rows[0]?.epoch !== activation.epoch) throw new Error('FAST_JOURNAL_FENCED_OWNER');
        await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(wallet.tenant_id, wallet.currency)]);
        await ensureBoundedCreditBudget(tx, activation, wallet.tenant_id, wallet.currency);
        await tx.query(
          `UPDATE saas_fast_credit_allocations SET backing_minor_units=backing_minor_units-available_minor_units,
           available_minor_units=0,state='retired'
           WHERE tenant_id=$1 AND currency=$2 AND owner=$3 AND epoch<>$4 AND state='active'`,
          [wallet.tenant_id, wallet.currency, activation.owner, activation.epoch],
        );
      });
    }
  }

  async checkReady(): Promise<void> {
    await this.ready;
    if (this.closed) throw new Error('FAST_JOURNAL_CLOSED');
  }

  /** RAM notifications are latency hints only: persisted jobs are always polled. */
  start(): void {
    if (this.closed || this.workerStarted) return;
    const interval = this.options.workerPollMs ?? 25;
    if (!Number.isSafeInteger(interval) || interval < 10) throw new Error('FAST_JOURNAL_INVALID_POLL_INTERVAL');
    this.workerStarted = true;
    this.idleDelay = interval;
    this.scheduleWorker(interval);
  }

  private scheduleWorker(delay: number): void {
    if (!this.workerStarted || this.closed || this.timer || this.running) return;
    this.pollDueAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const base = this.options.workerPollMs ?? 25;
      let next = base;
      let madeProgress = false;
      this.running = this.runOnce(this.options.workerBatchSize ?? 128);
      void this.running
        .then(
          (count) => {
            this.workerFailed = false;
            madeProgress = count > 0;
            this.idleDelay = count ? base : Math.min(Math.max(1000, base), this.idleDelay * 2);
            next = count >= (this.options.workerBatchSize ?? 128) ? 0 : this.idleDelay;
          },
          () => {
            this.workerFailed = true;
            this.reportBackgroundError('FAST_JOURNAL_WORKER_FAILED');
            next = Math.max(1000, base);
          },
        )
        .finally(() => {
          this.running = undefined;
          // A durable receipt arriving during a successful batch may be newer
          // than its claim. Catch up without delaying a full batch; an empty
          // poll still waits at least base, and failures retain their backoff.
          if (this.wakeRequested && !this.workerFailed) next = madeProgress ? 0 : Math.min(next, base);
          this.wakeRequested = false;
          this.scheduleWorker(next);
        });
    }, delay);
    this.timer.unref();
  }

  private wakeWorker(): void {
    if (!this.workerStarted || this.closed) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    if (this.workerFailed) return;
    this.idleDelay = this.options.workerPollMs ?? 25;
    if (this.timer && this.pollDueAt <= Date.now() + this.idleDelay) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduleWorker(this.idleDelay);
  }

  async reserveIntent(input: FastReserveIntentInput): Promise<FastReserveResult> {
    if (this.closed) return { kind: 'denied', reason: 'closed' };
    // Mixed fast/strict business identity is not implemented. Never route a client
    // idempotency key into this namespace, even on a cache miss or empty allocation.
    if (input.idempotencyKey !== undefined) return { kind: 'denied', reason: 'strict_idempotency_required' };
    // Own the exact money/authority bytes before any cold await. Caller mutation
    // must not change what was validated, hashed, persisted or returned.
    const priceSnapshotJson = input.priceSnapshot === null ? null : fastJournalCanonicalJson(input.priceSnapshot);
    const authoritySnapshotJson = fastJournalCanonicalJson(input.authoritySnapshot);
    input = {
      ...input,
      priceSnapshot: priceSnapshotJson === null ? null : JSON.parse(priceSnapshotJson),
      authoritySnapshot: JSON.parse(authoritySnapshotJson),
    };
    if (input.allocationOwner !== this.options.allocationOwner) throw new Error('FAST_JOURNAL_OWNER_MISMATCH');
    const max = parseMinorUnits(input.maxCostMinorUnits, { allowZero: true });
    let requestedTarget = this.tranche ?? 0n;
    digest(input.requestFingerprint);
    digest(input.payloadSha256);
    if (!Number.isSafeInteger(input.sendDeadlineMs) || input.sendDeadlineMs <= Date.now() || input.signal?.aborted)
      return { kind: 'denied', reason: 'send_deadline' };
    if (input.currency === null) {
      if (max !== 0n || input.priceSnapshot !== null) throw new Error('FAST_JOURNAL_INVALID_BYOK');
    } else {
      normalizeCurrency(input.currency);
      if (input.priceSnapshot === null) throw new Error('FAST_JOURNAL_MISSING_PRICE');
      const price = validatePriceSnapshot(input.priceSnapshot);
      if (
        price.customerPrice.currency !== input.currency ||
        max !==
          calculateConservativePriceHold(price.customerPrice, {
            inputUpperBound: price.maxInputTokens,
            outputUpperBound: price.maxOutputTokens,
            feasibleInputBuckets: INPUT_BILLING_BUCKETS,
          }).calculation.amountMinorUnits
      )
        throw new Error('FAST_JOURNAL_INVALID_MAXIMUM');
      // Free/rounded-zero platform pricing remains strict; BYOK's null-currency
      // zero-cost path above is distinct and needs no allocation.
      if (max === 0n) return { kind: 'denied', reason: 'strict_zero_maximum_required' };
      if (this.tranche !== null) {
        if (max > this.tranche) return { kind: 'denied', reason: 'tranche_too_small' };
      } else {
        const concurrency = input.allocationTargetConcurrency;
        if (concurrency === undefined || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 1024)
          throw new Error('FAST_JOURNAL_TRUSTED_CONCURRENCY_REQUIRED');
        // Exact policy, not an estimated overdraft. PostgreSQL wallets themselves
        // cannot exceed signed bigint; saturating the target cannot create funds.
        const desired = max * BigInt(concurrency) * 2n;
        requestedTarget = desired < MAX_MINOR_UNITS ? desired : MAX_MINOR_UNITS;
      }
      this.observeMaximum(input.tenantId, input.currency, max, requestedTarget);
    }
    // Do not include the send deadline or process epoch: a replay cannot acquire
    // sending authority even if those differ. Every execution/money identity does.
    const identity = fastJournalDigest({
      requestId: input.requestId,
      attemptId: input.attemptId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      proxyKeyId: input.proxyKeyId,
      requestFingerprint: input.requestFingerprint,
      payloadSha256: input.payloadSha256,
      accountId: input.accountId,
      currency: input.currency,
      maxCostMinorUnits: input.maxCostMinorUnits,
      priceSnapshot: input.priceSnapshot,
      authoritySnapshot: input.authoritySnapshot,
    });
    await this.ready;
    if (input.currency !== null) {
      // One retry is only for joining an older cold refill whose target predates
      // this request. This loop is BEFORE the first intent SQL, never an intent retry.
      for (let preparation = 0; preparation < 2; preparation++) {
        const hint = this.observedMaximum.get(`${input.tenantId}:${input.currency}`);
        if (
          hint?.preparedMaximum !== null &&
          hint?.preparedMaximum !== undefined &&
          max <= hint.preparedMaximum &&
          (this.tranche !== null || (hint.preparedTarget !== null && requestedTarget <= hint.preparedTarget))
        )
          break;
        // A timeout/cancel never cancels or frees a possibly committed grant.
        // The tracked singleflight remains available to later callers/drain.
        if (
          (await waitForFastCreditWork(this.scheduleReplenishment(input.tenantId, input.currency, true), input)) !==
          'completed'
        )
          return { kind: 'denied', reason: 'send_deadline' };
      }
    }
    const id = randomUUID();
    let unavailable: 'credit_busy' | 'credit_not_ready' = 'credit_not_ready';
    let busyReselections = 0;
    let retriedNotReady = false;
    let recoveryDeadline = 0;
    // Success still uses exactly one intent SQL. Only an acknowledged id:null
    // means this statement created no intent/debit and permits a fresh snapshot.
    // BUSY has a fixed, backed-off attempt limit; NOT_READY has one recovery.
    for (;;) {
      if (this.closed) return { kind: 'denied', reason: 'closed' };
      if (input.sendDeadlineMs <= Date.now() || input.signal?.aborted)
        return { kind: 'denied', reason: 'send_deadline' };
      if (recoveryDeadline > 0 && performance.now() >= recoveryDeadline) break;
      let recoverable = false;
      const creditHint = this.observedMaximum.get(`${input.tenantId}:${input.currency}`);
      const beforeRestore = creditHint?.restoreGeneration;
      const beforeWorker = this.running;
      let creditWorker: Promise<number> | undefined;
      let creditProgress: FastBatchProgress | undefined;
      try {
        const result = await this.database.query<{
          id: string | null;
          credit_busy: boolean;
          credit_recoverable: boolean;
        }>(RESERVE_SQL, [
          id,
          input.requestId,
          input.attemptId,
          input.tenantId,
          input.projectId,
          input.proxyKeyId,
          input.requestFingerprint,
          input.payloadSha256,
          input.currency,
          input.maxCostMinorUnits,
          priceSnapshotJson,
          authoritySnapshotJson,
          input.allocationOwner,
          this.epoch,
          new Date(input.sendDeadlineMs).toISOString(),
          input.accountId,
          identity,
          this.nextStripe(input.tenantId, input.currency),
        ]);
        if (result.rows.length === 1 && result.rows[0]?.id === id) {
          return {
            kind: 'created',
            intent: {
              id,
              requestId: input.requestId,
              attemptId: input.attemptId,
              tenantId: input.tenantId,
              maxCostMinorUnits: input.maxCostMinorUnits,
            },
          };
        }
        if (
          result.rows.length !== 1 ||
          result.rows[0]?.id !== null ||
          typeof result.rows[0].credit_busy !== 'boolean' ||
          typeof result.rows[0].credit_recoverable !== 'boolean'
        )
          throw new Error('FAST_JOURNAL_UNCERTAIN_RESERVE');
        unavailable = result.rows[0].credit_busy ? 'credit_busy' : 'credit_not_ready';
        recoverable = result.rows[0].credit_recoverable;
        // Capture relevant progress at this acknowledged no-write, before the
        // replay lookup can finish/replace the worker. A batch observed when
        // this SQL began may already have committed by the time its ACK arrives.
        for (const candidate of [beforeWorker, this.running]) {
          const progress = candidate ? this.batchRestorations.get(candidate) : undefined;
          if (progress?.planned.has(`${input.tenantId}:${input.currency}`)) {
            creditWorker = candidate;
            creditProgress = progress;
            break;
          }
        }
        // Four normal polling periods bound waiting/starting another CAS. An
        // already in-flight SQL is never cancelled/retried as though not written.
        if (recoveryDeadline === 0) recoveryDeadline = performance.now() + 100;
      } catch (error) {
        // All non-unique errors, including lost commit ACK, remain uncertain.
        // Never recover/retry a write or grant sending authority after an error.
        if (!isUniqueViolation(error)) throw error;
        const existing = await this.findExisting(input, identity);
        return existing ?? { kind: 'denied', reason: 'identity_conflict' };
      }
      const existing = await this.findExisting(input, identity);
      if (existing) return existing;
      if (input.sendDeadlineMs <= Date.now() || input.signal?.aborted)
        return { kind: 'denied', reason: 'send_deadline' };
      if (input.currency === null) break;
      if (performance.now() >= recoveryDeadline) break;
      // Preserve the original captured batch, but do not miss a matching batch
      // that first became identifiable while the replay lookup was in flight.
      if (!creditWorker && this.running) {
        const progress = this.batchRestorations.get(this.running);
        if (progress?.planned.has(`${input.tenantId}:${input.currency}`)) {
          creditWorker = this.running;
          creditProgress = progress;
        }
      }
      if (unavailable === 'credit_busy') {
        const backoff = CREDIT_BUSY_BACKOFF_MS[busyReselections++];
        if (backoff === undefined) break;
        // Spending a reselection before a known credit return simply
        // races the same depleted window twice. Wait only for captured, matching
        // work; no matching batch retains the original immediate reselection.
        if (creditWorker && !(creditHint && creditHint.restoreGeneration !== beforeRestore)) {
          let prepared: FastCreditWaitResult | undefined;
          try {
            prepared = await waitForFastCreditWork(
              creditWorker.then(() => undefined),
              input,
              recoveryDeadline,
            );
          } catch {
            // Failed/unknown worker COMMIT is not observed credit progress.
          }
          if (prepared === 'cancelled' || prepared === 'authority_expired')
            return { kind: 'denied', reason: 'send_deadline' };
          if (prepared === 'budget_exhausted') break;
          // Waiting is only scheduling: a failed/zero-restore batch does not
          // revoke the original safe reselection after this acknowledged no-write.
          // Do not claim progress or rerun that worker; the fresh CAS must pay
          // from whichever independently available allocation it can guard.
        }
        if (backoff > 0) {
          // Keep a positive lower bound, add up to 2ms jitter, cap at one poll.
          // Even a previously completed matching worker cannot bypass this wait.
          const prepared = await waitForFastCreditDelay(
            Math.min(25, backoff + Math.random() * 2),
            input,
            recoveryDeadline,
          );
          if (prepared === 'cancelled' || prepared === 'authority_expired')
            return { kind: 'denied', reason: 'send_deadline' };
          if (prepared !== 'completed') break;
        }
      } else {
        const worker = creditWorker;
        const restorations = creditProgress?.restored;
        let progressed = creditHint !== undefined && creditHint.restoreGeneration !== beforeRestore;
        if (retriedNotReady || (!recoverable && !worker && !progressed)) break;
        retriedNotReady = true;
        // A refill can win the fence before an existing worker reaches it and
        // only concentrate scarce fragments. Prefer that captured batch first,
        // but an empty/unrelated/failed batch must not consume the refill stage.
        let prepared: FastCreditWaitResult | undefined;
        if (!progressed && worker) {
          try {
            prepared = await waitForFastCreditWork(
              worker.then(() => undefined),
              input,
              recoveryDeadline,
            );
          } catch {
            // Failed or ambiguous worker COMMIT is not observed money progress.
            // An independent refill may still redistribute proven unused funds.
          }
          if (prepared === 'cancelled' || prepared === 'authority_expired')
            return { kind: 'denied', reason: 'send_deadline' };
          if (prepared === 'budget_exhausted') break;
        }
        progressed ||= prepared === 'completed' && restorations?.has(`${input.tenantId}:${input.currency}`) === true;
        if (!progressed) {
          if (!recoverable) break;
          if (input.sendDeadlineMs <= Date.now() || input.signal?.aborted)
            return { kind: 'denied', reason: 'send_deadline' };
          if (performance.now() >= recoveryDeadline) break;
          try {
            prepared = await waitForFastCreditWork(
              this.scheduleReplenishment(input.tenantId, input.currency, true),
              input,
              recoveryDeadline,
            );
          } catch {
            // Replenishment reports its own failure; no uncertain intent retry.
            prepared = undefined;
          }
          if (prepared === 'cancelled' || prepared === 'authority_expired')
            return { kind: 'denied', reason: 'send_deadline' };
          if (prepared !== 'completed') break;
        }
      }
      if (performance.now() >= recoveryDeadline) break;
      try {
        this.options.onCreditRecovery?.(unavailable);
      } catch {
        /* telemetry cannot affect money authority */
      }
    }
    // Every exhausted-budget/error exit still gives cancellation/authority
    // expiry precedence over the last observed credit state.
    if (input.sendDeadlineMs <= Date.now() || input.signal?.aborted) return { kind: 'denied', reason: 'send_deadline' };
    if (input.currency !== null) this.scheduleReplenishment(input.tenantId, input.currency);
    try {
      this.options.onCreditUnavailable?.(unavailable);
    } catch {
      /* telemetry cannot affect money authority */
    }
    return { kind: 'denied', reason: unavailable };
  }

  private async findExisting(input: FastReserveIntentInput, identity: string): Promise<FastReserveResult | null> {
    const result = await this.database.query<{ request_id: string; intent_digest: string; status: string }>(
      `SELECT i.request_id, i.intent_digest, COALESCE(CASE j.state WHEN 'pending_v2' THEN 'pending' WHEN 'blocked_v2' THEN 'blocked' ELSE j.state END, r.outcome, 'unresolved') AS status
         FROM saas_fast_gateway_intents i LEFT JOIN saas_fast_gateway_receipts r ON r.intent_id = i.id
         LEFT JOIN saas_fast_billing_jobs j ON j.intent_id = i.id
        WHERE i.request_id = $1 AND i.tenant_id = $2`,
      [input.requestId, input.tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return row.intent_digest === identity
      ? { kind: 'existing', requestId: row.request_id, status: row.status }
      : { kind: 'denied', reason: 'identity_conflict' };
  }

  async appendReceipt(input: FastReceiptInput): Promise<void> {
    const { values, receiptDigest } = getPreparedFastReceipt(input) ?? prepareUntrustedReceipt(input);
    const append = async (): Promise<void> => {
      try {
        const result = await this.database.query<{
          intent_id: string;
          tenant_id: string | null;
          currency: string | null;
          owner: string | null;
          epoch: string | null;
        }>(
          `/* fast-journal:append-receipt */
           WITH receipt AS (
             INSERT INTO saas_fast_gateway_receipts
               (intent_id, tenant_id, request_id, outcome, charge_minor_units, usage, usage_digest, receipt_digest, http_status)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING intent_id
           ), queued AS (
             INSERT INTO saas_fast_billing_jobs(intent_id, state)
             SELECT intent_id, $10::text FROM receipt
             ON CONFLICT(intent_id) DO NOTHING RETURNING intent_id
           ), eligible AS MATERIALIZED (
             SELECT i.id AS intent_id,i.tenant_id,i.request_id,i.allocation_id,i.allocation_epoch,i.currency,
               i.max_cost_minor_units-$5::bigint AS released_minor_units,$5::bigint AS retained_minor_units
             FROM saas_fast_gateway_intents i JOIN queued q ON q.intent_id=i.id
             WHERE i.id=$1 AND i.tenant_id=$2 AND i.request_id=$3 AND i.currency IS NOT NULL
               AND i.price_snapshot=$11::jsonb AND $11::jsonb IS NOT NULL
               AND $4::text='succeeded' AND $9::integer BETWEEN 200 AND 299
               AND $5::bigint >= 0 AND $5::bigint < i.max_cost_minor_units
           ), credit AS (
             UPDATE saas_fast_credit_allocations a
                SET available_minor_units=a.available_minor_units+e.released_minor_units
               FROM eligible e
              WHERE a.id=e.allocation_id AND a.tenant_id=e.tenant_id AND a.currency=e.currency
                AND a.epoch=e.allocation_epoch AND a.state='active'
             RETURNING e.*,a.owner,a.epoch
           ), released AS (
             INSERT INTO saas_fast_receipt_liability_releases
               (intent_id,tenant_id,request_id,allocation_id,allocation_epoch,currency,
                released_minor_units,retained_minor_units,receipt_digest,protocol_version)
             SELECT intent_id,tenant_id,request_id,allocation_id,allocation_epoch,currency,
               released_minor_units,retained_minor_units,$8::text,2 FROM credit
             RETURNING intent_id,tenant_id,currency
           ) SELECT r.intent_id,l.tenant_id,l.currency,c.owner,c.epoch
             FROM receipt r LEFT JOIN released l ON l.intent_id=r.intent_id
             LEFT JOIN credit c ON c.intent_id=l.intent_id`,
          values,
        );
        one(result.rowCount);
        // This result exists only for a new actual release and an acknowledged
        // autocommit. Duplicate/lost-ACK lookup never fabricates progress.
        const released = result.rows[0];
        if (
          released?.tenant_id &&
          released.currency &&
          released.owner === this.options.allocationOwner &&
          released.epoch === this.epoch
        ) {
          const hint = this.observedMaximum.get(`${released.tenant_id}:${released.currency}`);
          if (hint) hint.restoreGeneration++;
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const result = await this.database.query<{ receipt_digest: string }>(
          'SELECT receipt_digest FROM saas_fast_gateway_receipts WHERE intent_id = $1 AND tenant_id = $2 AND request_id = $3',
          values.slice(0, 3),
        );
        if (result.rows[0]?.receipt_digest !== receiptDigest) throw new Error('FAST_JOURNAL_RECEIPT_CONFLICT');
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await append();
        this.wakeWorker();
        return;
      } catch (error) {
        if (attempt === 1 || (error instanceof Error && error.message === 'FAST_JOURNAL_RECEIPT_CONFLICT')) throw error;
      }
    }
  }

  private scheduleReplenishment(tenantId: string, currency: string, force = false): Promise<void> {
    const key = `${tenantId}:${currency}`;
    const existing = this.pendingReplenishments.get(key);
    if (existing) return existing;
    if (this.closed) return Promise.resolve();
    const hint = this.observedMaximum.get(key);
    const now = performance.now();
    if (!force && hint && now < hint.backgroundRefillAfter) return Promise.resolve();
    if (hint) hint.backgroundRefillAfter = now + 250;
    const work = this.replenish(tenantId, currency).finally(() => this.pendingReplenishments.delete(key));
    this.pendingReplenishments.set(key, work);
    void work.catch(() => this.reportBackgroundError('FAST_JOURNAL_REPLENISH_FAILED'));
    return work;
  }

  private reportBackgroundError(code: string): void {
    try {
      this.options.onBackgroundError?.(code);
    } catch {
      /* diagnostics never become detached rejections */
    }
  }

  // Bounded process-local scheduling hints, never money authority. Eviction
  // changes contention/fragmentation only; durable allocation CAS still decides.
  private observeMaximum(tenantId: string, currency: string, maximum: bigint, target = this.tranche ?? 0n): void {
    const key = `${tenantId}:${currency}`;
    let entry = this.observedMaximum.get(key);
    if (!entry) {
      if (this.observedMaximum.size >= 1024) {
        const oldest = this.observedMaximum.keys().next().value;
        if (oldest !== undefined) this.observedMaximum.delete(oldest);
      }
      entry = {
        maximum,
        target,
        nextStripe: 0,
        preparedMaximum: null,
        preparedTarget: null,
        backgroundRefillAfter: 0,
        restoreGeneration: 0n,
      };
      this.observedMaximum.set(key, entry);
    } else {
      if (maximum > entry.maximum) entry.maximum = maximum;
      if (target > entry.target) entry.target = target;
    }
  }
  private nextStripe(tenantId: string, currency: string | null): number {
    if (currency === null) return 0;
    const entry = this.observedMaximum.get(`${tenantId}:${currency}`);
    if (!entry) return 0;
    const stripe = entry.nextStripe;
    entry.nextStripe = (stripe + 1) % this.stripes;
    return stripe;
  }

  /** Slow control path. The same fence used by strict billing and refunds is mandatory. */
  async replenish(tenantId: string, currency: string, minimumReserveMinorUnits = '0'): Promise<void> {
    this.observeMaximum(tenantId, currency, parseMinorUnits(minimumReserveMinorUnits, { allowZero: true }));
    await this.ready;
    normalizeCurrency(currency);
    let preparedMaximum = this.observedMaximum.get(`${tenantId}:${currency}`)?.maximum ?? 0n;
    let preparedTarget = this.tranche ?? this.observedMaximum.get(`${tenantId}:${currency}`)?.target ?? 0n;
    await this.database.transaction(async (tx) => {
      const owner = await tx.query<{ epoch: string }>(
        'SELECT epoch FROM saas_fast_gateway_owners WHERE owner = $1 FOR SHARE',
        [this.options.allocationOwner],
      );
      if (owner.rows[0]?.epoch !== this.epoch) throw new Error('FAST_JOURNAL_FENCED_OWNER');
      await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(tenantId, currency)]);
      if (this.boundedDeployment) await ensureBoundedCreditBudget(tx, this.boundedDeployment, tenantId, currency);
      // Explicit generation takeover, NOT time expiry. Unresolved money stays
      // backed; stale-generation CAS fails once these rows are retired.
      await tx.query(
        `UPDATE saas_fast_credit_allocations
          SET backing_minor_units = backing_minor_units - available_minor_units,
              available_minor_units = 0, state = 'retired'
          WHERE tenant_id = $1 AND currency = $2 AND owner = $3 AND epoch <> $4 AND state = 'active'`,
        [tenantId, currency, this.options.allocationOwner, this.epoch],
      );
      const facts = await tx.query<{ id: string; available: string; own_backing: string; frozen: boolean }>(
        `SELECT w.id, (w.posted_balance_minor_units
          - (SELECT COALESCE(SUM(amount_minor_units),0) FROM saas_billing_reservations WHERE tenant_id=$1 AND currency=$2 AND state IN ('reserved','reconciliation_pending'))
          - (SELECT COALESCE(SUM(amount_minor_units),0) FROM saas_refund_wallet_freezes WHERE tenant_id=$1 AND currency=$2)
          - (SELECT COALESCE(SUM(backing_minor_units),0) FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND currency=$2))::text AS available,
          (SELECT COALESCE(SUM(backing_minor_units),0)::text FROM saas_fast_credit_allocations
            WHERE tenant_id=$1 AND currency=$2 AND owner=$3 AND epoch=$4 AND state='active') AS own_backing,
          EXISTS (SELECT 1 FROM saas_billing_spending_freezes WHERE tenant_id=$1) AS frozen
         FROM saas_wallets w WHERE tenant_id=$1 AND currency=$2`,
        [tenantId, currency, this.options.allocationOwner, this.epoch],
      );
      const wallet = facts.rows[0];
      if (!wallet || wallet.frozen) return;
      // Wallet fence excludes other refills/settlers. Sorted row locks also
      // exclude concurrent intent CAS before moving ONLY unused credit.
      const allocations = await tx.query<AllocationRow & { stripe: number }>(
        "SELECT * FROM saas_fast_credit_allocations WHERE tenant_id=$1 AND currency=$2 AND owner=$3 AND epoch=$4 AND state='active' ORDER BY id FOR UPDATE",
        [tenantId, currency, this.options.allocationOwner, this.epoch],
      );
      preparedTarget = this.tranche ?? this.observedMaximum.get(`${tenantId}:${currency}`)?.target ?? 0n;
      const needed = preparedTarget - BigInt(wallet.own_backing);
      const free = BigInt(wallet.available);
      let additional = needed > 0n && free > 0n ? (free < needed ? free : needed) : 0n;
      if (this.boundedDeployment) {
        const globalRemaining = await ensureBoundedCreditBudget(tx, this.boundedDeployment, tenantId, currency);
        if (additional > globalRemaining) additional = globalRemaining;
      }
      const available = allocations.rows.reduce((sum, row) => sum + BigInt(row.available_minor_units), additional);
      if (available === 0n) return;
      const maximum = this.observedMaximum.get(`${tenantId}:${currency}`)?.maximum ?? 0n;
      // Four-M headroom per stripe when affordable; near-tranche requests use
      // one stripe. A local coverage hint lets first admission await a shared
      // cold rebalance before writing any intent; it is never money authority.
      const affordable = maximum > 0n ? available / (maximum * 4n) : BigInt(this.stripes);
      const count = Math.max(1, Math.min(this.stripes, Number(affordable > 8n ? 8n : affordable)));
      const coverage = count === 1 ? available : available / (BigInt(count) * 4n);
      preparedMaximum = maximum > coverage ? maximum : coverage;
      const byStripe = new Map(allocations.rows.map((row) => [row.stripe, row]));
      const rows = Array.from(
        { length: Math.max(count, ...allocations.rows.map((row) => row.stripe + 1)) },
        (_, stripe) => {
          const previous = byStripe.get(stripe);
          const unresolved = previous
            ? BigInt(previous.backing_minor_units) - BigInt(previous.available_minor_units)
            : 0n;
          const share =
            stripe < count ? available / BigInt(count) + (BigInt(stripe) < available % BigInt(count) ? 1n : 0n) : 0n;
          return {
            id: previous?.id ?? randomUUID(),
            stripe,
            backing: (unresolved + share).toString(),
            available: share.toString(),
          };
        },
      );
      if (
        rows.length === allocations.rows.length &&
        rows.every((row) => {
          const previous = byStripe.get(row.stripe);
          return previous?.backing_minor_units === row.backing && previous.available_minor_units === row.available;
        })
      )
        return;
      await tx.query(
        `INSERT INTO saas_fast_credit_allocations
        (id,tenant_id,wallet_id,currency,owner,epoch,stripe,state,backing_minor_units,available_minor_units)
        SELECT x.id,$1,$2,$3,$4,$5,x.stripe,'active',x.backing,x.available
        FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,stripe smallint,backing bigint,available bigint)
        ON CONFLICT (tenant_id,currency,owner,epoch,stripe) WHERE state='active'
        DO UPDATE SET backing_minor_units=EXCLUDED.backing_minor_units,available_minor_units=EXCLUDED.available_minor_units`,
        [tenantId, wallet.id, currency, this.options.allocationOwner, this.epoch, fastJournalCanonicalJson(rows)],
      );
    });
    const hint = this.observedMaximum.get(`${tenantId}:${currency}`);
    if (hint) {
      hint.preparedMaximum = preparedMaximum;
      hint.preparedTarget = preparedTarget;
    }
  }

  /** Release only demonstrably unused credit; unresolved intents survive retirement. */
  async retireAllocations(): Promise<void> {
    await this.ready;
    const rows = await this.database.query<{ tenant_id: string; currency: string }>(
      "SELECT DISTINCT tenant_id, currency FROM saas_fast_credit_allocations WHERE owner=$1 AND epoch=$2 AND state='active' ORDER BY tenant_id,currency",
      [this.options.allocationOwner, this.epoch],
    );
    for (const row of rows.rows)
      await this.database.transaction(async (tx) => {
        await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(row.tenant_id, row.currency)]);
        await tx.query(
          `UPDATE saas_fast_credit_allocations SET backing_minor_units=backing_minor_units-available_minor_units,
        available_minor_units=0,state='retired' WHERE tenant_id=$1 AND currency=$2 AND owner=$3 AND epoch=$4 AND state='active'`,
          [row.tenant_id, row.currency, this.options.allocationOwner, this.epoch],
        );
      });
  }

  /** One durable, atomic batch claim. SIGKILL rolls back every claimed job and posting. */
  runOnce(limit = 128): Promise<number> {
    const progress: FastBatchProgress = { planned: new Set(), restored: new Set() };
    // Keep the exact returned promise: an async wrapper would create another
    // identity and disconnect the scheduler's running batch from its scopes.
    const batch = this.runBatch(limit, progress);
    this.batchRestorations.set(batch, progress);
    return batch;
  }

  private async runBatch(limit: number, progress: FastBatchProgress): Promise<number> {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('FAST_JOURNAL_INVALID_BATCH');
    const count = await this.database.transaction(async (tx) => {
      const jobs = await tx.query<{ intent_id: string }>(
        `/* fast-journal:worker-claim */ SELECT intent_id FROM saas_fast_billing_jobs
         WHERE state IN ('pending','pending_v2') ORDER BY created_at,intent_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (jobs.rows.length === 0) return 0;
      await this.settleBatch(
        tx,
        jobs.rows.map((job) => job.intent_id),
        progress,
      );
      return jobs.rows.length;
    });
    // Only the actual guarded restore plus successful COMMIT ACK advances the
    // bounded existing wallet hint. Holding the entry reference across a CAS
    // makes eviction conservative, never a synthetic progress event.
    for (const key of progress.restored) {
      const hint = this.observedMaximum.get(key);
      if (hint) hint.restoreGeneration++;
    }
    return count;
  }

  private async settleBatch(tx: SqlExecutor, intentIds: readonly string[], progress: FastBatchProgress): Promise<void> {
    const result = await tx.query<SettlementRow>(
      `SELECT i.*,COALESCE(x.charge_minor_units,r.charge_minor_units) AS charge_minor_units,
         COALESCE(x.usage,r.usage) AS usage,COALESCE(x.usage_digest,r.usage_digest) AS usage_digest,
         CASE WHEN x.kind='non_execution' THEN 'not_executed' WHEN x.kind='verified_usage' THEN 'succeeded' ELSE r.outcome END AS outcome,
         r.http_status,r.receipt_digest,r.charge_minor_units AS original_charge_minor_units,
         CASE WHEN l.intent_id IS NULL THEN NULL ELSE to_jsonb(l) || jsonb_build_object(
           'released_minor_units',l.released_minor_units::text,'retained_minor_units',l.retained_minor_units::text) END AS liability_release,x.id AS resolution_id,x.kind AS resolution_kind,a.owner AS active_allocation_owner
       FROM saas_fast_gateway_intents i LEFT JOIN saas_fast_gateway_receipts r ON r.intent_id=i.id
       LEFT JOIN saas_fast_gateway_resolutions x ON x.intent_id=i.id
       LEFT JOIN saas_fast_receipt_liability_releases l ON l.intent_id=i.id
       LEFT JOIN saas_fast_credit_allocations a ON a.id=i.allocation_id AND a.tenant_id=i.tenant_id
         AND a.currency=i.currency AND a.epoch=i.allocation_epoch AND a.state='active'
       WHERE i.id=ANY($1::uuid[]) ORDER BY i.tenant_id,i.currency,i.id`,
      [intentIds],
    );
    if (result.rows.length !== intentIds.length) throw new Error('FAST_JOURNAL_MISSING_INTENT');
    const invalid: string[] = [];
    const valid: Array<{ row: SettlementRow; charge: bigint; held: bigint; ledgerId: string | null }> = [];
    for (const row of result.rows) {
      try {
        const unsent =
          row.resolution_kind === 'non_execution' ||
          isFastDefinitelyUnsentReceipt({
            outcome: row.outcome,
            chargeMinorUnits: row.charge_minor_units,
            usage: row.usage,
            httpStatus: row.http_status,
          });
        const charge = unsent ? 0n : calculateFastReceiptCharge(row.price_snapshot, row.usage);
        const held = remainingFastLiability(row);
        if (
          (!unsent && row.outcome !== 'succeeded') ||
          row.charge_minor_units === null ||
          charge !== BigInt(row.charge_minor_units) ||
          charge > held
        ) {
          throw new Error('invalid charge');
        }
        valid.push({ row, charge, held, ledgerId: charge > 0n ? randomUUID() : null });
        // This existing read's immutable identity + active allocation snapshot
        // is scheduling evidence only. Mark before the wallet fence so unrelated
        // or empty polls never consume this wallet's fragment recovery budget.
        if (
          row.currency !== null &&
          row.allocation_epoch === this.epoch &&
          row.active_allocation_owner === this.options.allocationOwner &&
          charge < held
        )
          progress.planned.add(`${row.tenant_id}:${row.currency}`);
      } catch {
        invalid.push(row.id);
      }
    }
    if (invalid.length) {
      const blocked = await tx.query(
        `UPDATE saas_fast_billing_jobs SET state=CASE state WHEN 'pending_v2' THEN 'blocked_v2' ELSE 'blocked' END,attempts=attempts+1,
        last_error='receipt_price_mismatch' WHERE intent_id=ANY($1::uuid[]) AND state IN ('pending','pending_v2')`,
        [invalid],
      );
      if (blocked.rowCount !== invalid.length) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
    }
    if (!valid.length) return;
    const paid = valid.filter((item) => item.row.currency !== null);
    const credits = new Map<string, CreditBatchRow>();
    const ownCreditAllocations = new Set<string>();
    if (paid.length) {
      // Global deterministic wallet order avoids opposite-batch deadlocks. Claims
      // are disjoint and never reacquired after a wallet fence is held.
      const walletKeys = [
        ...new Set(
          paid.map(({ row }) => {
            if (row.currency === null) throw new Error('FAST_JOURNAL_MISSING_CURRENCY');
            return saasAdvisoryKey.walletFence(row.tenant_id, row.currency);
          }),
        ),
      ].sort();
      for (const key of walletKeys) await tx.query(WALLET_FENCE_SQL, [key]);
      // The wallet fences exclude every backing/state writer (refill, retirement
      // and settlement). Intent CAS may still subtract available credit while
      // ledger construction/checks run; do not pin all admission stripes here.
      const allocations = await tx.query<AllocationRow>(
        'SELECT * FROM saas_fast_credit_allocations WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[...new Set(paid.map(({ row }) => row.allocation_id))]],
      );
      const allocationById = new Map(allocations.rows.map((allocation) => [allocation.id, allocation]));
      const wallets = new Map<string, { id: string; tenantId: string; charge: bigint; ledgerId: string }>();
      const postings: LedgerBatchRow[] = [];
      for (const { row, charge, held, ledgerId } of paid) {
        const allocation = row.allocation_id === null ? undefined : allocationById.get(row.allocation_id);
        if (
          !allocation ||
          allocation.tenant_id !== row.tenant_id ||
          allocation.currency !== row.currency ||
          allocation.epoch !== row.allocation_epoch
        )
          throw new Error('FAST_JOURNAL_ALLOCATION_MISMATCH');
        if (allocation.owner === this.options.allocationOwner) ownCreditAllocations.add(allocation.id);
        const credit = credits.get(allocation.id) ?? {
          id: allocation.id,
          tenant_id: allocation.tenant_id,
          wallet_id: allocation.wallet_id,
          currency: allocation.currency,
          epoch: allocation.epoch,
          state: allocation.state,
          release: 0n,
          restore: 0n,
        };
        credit.release += allocation.state === 'active' ? charge : held;
        credit.restore += allocation.state === 'active' ? held - charge : 0n;
        credits.set(allocation.id, credit);
        if (charge > 0n && ledgerId !== null) {
          postings.push({
            ledger_id: ledgerId,
            intent_id: row.id,
            tenant_id: row.tenant_id,
            currency: allocation.currency,
            charge: charge.toString(),
            usage_ref:
              row.resolution_id === null
                ? `fast-receipt:${row.id}:${row.usage_digest}`
                : `fast-resolution:${row.resolution_id}:${row.usage_digest}`,
            wallet_id: allocation.wallet_id,
            debit_id: randomUUID(),
            credit_id: randomUUID(),
          });
          const wallet = wallets.get(allocation.wallet_id) ?? {
            id: allocation.wallet_id,
            tenantId: row.tenant_id,
            charge: 0n,
            ledgerId,
          };
          wallet.charge += charge;
          wallets.set(wallet.id, wallet);
        }
      }
      if (postings.length) {
        await postLedgerBatch(tx, postings);
        // Run the same mandatory deferred balance checks before scarce credit
        // row locks, not at COMMIT while all admission stripes are pinned. No
        // guard is disabled; subsequent ledger writes would also be immediate.
        await tx.query(
          '/* fast-journal:worker-balance-check */ SET CONSTRAINTS saas_ledger_transactions_balanced, saas_ledger_entries_balanced IMMEDIATE',
        );
        // The ledger command inserted every immutable ledger pair. Project
        // their exact aggregate once per wallet; a valid same-wallet posting id
        // establishes the existing projection context for the guard trigger.
        for (const wallet of wallets.values()) {
          const projected = await tx.query(
            `/* fast-journal:worker-wallet */ WITH context AS MATERIALIZED (
            SELECT set_config('saas.billing_ledger_projection_write','on',true),
                   set_config('saas.billing_ledger_transaction_id',$4,true)
          ) UPDATE saas_wallets SET posted_balance_minor_units=posted_balance_minor_units-$3::bigint,updated_at=now()
            FROM context WHERE id=$1 AND tenant_id=$2 AND posted_balance_minor_units >= $3::bigint RETURNING id`,
            [wallet.id, wallet.tenantId, wallet.charge.toString(), wallet.ledgerId],
          );
          one(projected.rowCount);
        }
      }
    }
    const completed = await tx.query(
      `/* fast-journal:worker-complete */ UPDATE saas_fast_billing_jobs j
      SET state='completed',attempts=attempts+1,ledger_transaction_id=c.ledger_id,completed_at=now(),last_error=NULL
      FROM jsonb_to_recordset($1::jsonb) AS c(intent_id uuid,ledger_id uuid)
      WHERE j.intent_id=c.intent_id AND j.state IN ('pending','pending_v2')`,
      [fastJournalCanonicalJson(valid.map(({ row, ledgerId }) => ({ intent_id: row.id, ledger_id: ledgerId })))],
    );
    if (completed.rowCount !== valid.length) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
    // Jobs were locked by the claim; completion is still uncommitted and must
    // roll back with every ledger/wallet write if the final credit guards fail.
    // Leave only credit restoration and COMMIT after admission row locks.
    if (credits.size) {
      const creditJson = fastJournalCanonicalJson([...credits.values()]);
      // Keep lock acquisition separate from UPDATE: a concurrent intent may
      // commit while this SELECT waits, and the next command must see that row
      // version. A combined lock/update CTE failed this real concurrent-wait
      // regression; keep the snapshot boundary explicit instead of weakening CAS.
      const locked = await tx.query<AllocationRow>(
        '/* fast-journal:worker-credit-lock */ SELECT * FROM saas_fast_credit_allocations WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
        [[...credits.keys()]],
      );
      if (locked.rows.length !== credits.size) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
      for (const allocation of locked.rows) {
        const expected = credits.get(allocation.id);
        if (
          !expected ||
          allocation.tenant_id !== expected.tenant_id ||
          allocation.wallet_id !== expected.wallet_id ||
          allocation.currency !== expected.currency ||
          allocation.epoch !== expected.epoch ||
          allocation.state !== expected.state
        )
          throw new Error('FAST_JOURNAL_STATE_CONFLICT');
      }
      const restored = await tx.query(
        `/* fast-journal:worker-credit */ UPDATE saas_fast_credit_allocations a
        SET backing_minor_units=a.backing_minor_units-c.release,
            available_minor_units=a.available_minor_units+c.restore
        FROM jsonb_to_recordset($1::jsonb)
          AS c(id uuid,tenant_id uuid,wallet_id uuid,currency text,epoch uuid,state text,release bigint,restore bigint)
        WHERE a.id=c.id AND a.tenant_id=c.tenant_id AND a.wallet_id=c.wallet_id AND a.currency=c.currency
          AND a.epoch=c.epoch AND a.state=c.state AND a.backing_minor_units >= c.release RETURNING a.id`,
        [creditJson],
      );
      if (restored.rowCount !== credits.size) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
      for (const credit of credits.values()) {
        // Another owner/epoch or retirement cannot restore this gateway's
        // admissible credit. Even this positive restore is only a hint until
        // the enclosing transaction promise acknowledges COMMIT successfully.
        if (
          ownCreditAllocations.has(credit.id) &&
          credit.epoch === this.epoch &&
          credit.state === 'active' &&
          credit.restore > 0n
        )
          progress.restored.add(`${credit.tenant_id}:${credit.currency}`);
      }
    }
  }

  /** Waits for all known pending successes; blocked unknowns remain durable and backed. */
  async drain(): Promise<void> {
    await Promise.all([...this.pendingReplenishments.values()]);
    if (this.running) await this.running;
    while (await this.runOnce(this.options.workerBatchSize ?? 128)) {
      /* durable drain */
    }
  }
  async close(options: { readonly drain?: boolean } = {}): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (options.drain === false) {
      // Fatal standalone shutdown: finish only work already started. Never
      // claim another job or retire credit while reporting a processor failure.
      const pending = [this.ready, ...this.pendingReplenishments.values()];
      if (this.running) pending.push(this.running.then(() => undefined));
      const outcomes = await Promise.allSettled(pending);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      return;
    }
    await this.drain();
    await this.retireAllocations();
  }
}

interface ReceiptLiabilityRelease {
  intent_id: string;
  tenant_id: string;
  request_id: string;
  allocation_id: string;
  allocation_epoch: string;
  currency: string;
  released_minor_units: string;
  retained_minor_units: string;
  receipt_digest: string;
  protocol_version: number;
}
interface SettlementRow {
  id: string;
  request_id: string;
  tenant_id: string;
  currency: string | null;
  allocation_id: string | null;
  allocation_epoch: string | null;
  active_allocation_owner: string | null;
  max_cost_minor_units: string;
  price_snapshot: unknown;
  charge_minor_units: string | null;
  usage: Readonly<Record<string, string | null>>;
  usage_digest: string;
  outcome: string;
  http_status: number | null;
  resolution_id: string | null;
  resolution_kind: string | null;
  receipt_digest: string | null;
  original_charge_minor_units: string | null;
  liability_release: ReceiptLiabilityRelease | null;
}

function remainingFastLiability(row: SettlementRow): bigint {
  const maximum = BigInt(row.max_cost_minor_units);
  const release = row.liability_release;
  if (release == null) return maximum;
  const returned = parseMinorUnits(release.released_minor_units);
  const retained = parseMinorUnits(release.retained_minor_units, { allowZero: true });
  if (
    release.protocol_version !== 2 ||
    release.intent_id !== row.id ||
    release.tenant_id !== row.tenant_id ||
    release.request_id !== row.request_id ||
    release.allocation_id !== row.allocation_id ||
    release.allocation_epoch !== row.allocation_epoch ||
    release.currency !== row.currency ||
    release.receipt_digest !== row.receipt_digest ||
    row.original_charge_minor_units === null ||
    retained !== BigInt(row.original_charge_minor_units) ||
    returned + retained !== maximum
  )
    throw new Error('FAST_JOURNAL_LIABILITY_MISMATCH');
  return retained;
}

interface LedgerBatchRow {
  readonly ledger_id: string;
  readonly intent_id: string;
  readonly tenant_id: string;
  readonly currency: string;
  readonly charge: string;
  readonly usage_ref: string;
  readonly wallet_id: string;
  readonly debit_id: string;
  readonly credit_id: string;
}
interface CreditBatchRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly currency: string;
  readonly epoch: string;
  readonly state: 'active' | 'retired';
  release: bigint;
  restore: bigint;
}
async function postLedgerBatch(tx: SqlExecutor, rows: readonly LedgerBatchRow[]): Promise<void> {
  // No ON CONFLICT: an unexpected duplicate aborts the whole batch. A genuinely
  // committed job is excluded by the durable completed state on replay.
  const posted = await tx.query(
    `/* fast-journal:worker-ledger */
    WITH data AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(ledger_id uuid,intent_id uuid,tenant_id uuid,currency text,
        charge bigint,usage_ref text,wallet_id uuid,debit_id uuid,credit_id uuid)
    ), posting AS (
      INSERT INTO saas_ledger_transactions(id,tenant_id,currency,idempotency_namespace,business_key,source_type,
        amount_minor_units,metadata_ref,price_snapshot_ref,usage_evidence_ref)
      SELECT ledger_id,tenant_id,currency,'fast-journal-v1',intent_id::text,'billing_settlement',charge,
        'fast-intent:' || intent_id::text,'fast-price:' || intent_id::text,
        usage_ref FROM data RETURNING id
    ) INSERT INTO saas_ledger_entries(id,transaction_id,tenant_id,currency,direction,amount_minor_units,account_type,account_ref,wallet_id)
      SELECT e.id,p.id,d.tenant_id,d.currency,e.direction,d.charge,e.account_type,e.account_ref,e.wallet_id
      FROM data d JOIN posting p ON p.id=d.ledger_id CROSS JOIN LATERAL (VALUES
        (d.debit_id,'debit','wallet',d.wallet_id::text,d.wallet_id),
        (d.credit_id,'credit','billing_revenue','fast-journal-v1',NULL::uuid)
      ) e(id,direction,account_type,account_ref,wallet_id)`,
    [fastJournalCanonicalJson(rows)],
  );
  if (posted.rowCount !== rows.length * 2) throw new Error('FAST_JOURNAL_LEDGER_PAIR_MISMATCH');
}

export function createFastGatewayJournal(
  database: SaasDatabase,
  options: FastJournalOptions,
): PostgresFastGatewayJournal {
  const journal = new PostgresFastGatewayJournal(database, options);
  journal.start();
  return journal;
}
