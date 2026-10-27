import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastGatewayJournalPort, FastReceiptInput } from './executor.js';
import { captureUntrustedFastReceipt, getPreparedFastReceipt } from './prepared-receipt.js';

export interface FastReceiptQueueLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly workers?: number;
  readonly maxPerTenant?: number;
  readonly maxAgeMs?: number;
  readonly drainTimeoutMs?: number;
}
export interface FastReceiptQueueSnapshot {
  readonly accepting: boolean;
  readonly pending: number;
  /** Original evidence reservation; retained through reconciliation, not a live-heap measurement. */
  readonly bytes: number;
  readonly running: number;
  readonly receiptRunning: number;
  readonly reconciliationRunning: number;
  readonly oldestAgeMs: number;
  readonly undurable: number;
  readonly oldestUndurableAgeMs: number;
  readonly undurableLiabilityByCurrency: Readonly<Record<string, string>>;
  readonly accepted: number;
  readonly durable: number;
  readonly completed: number;
  readonly retries: number;
  readonly reconciliationRetries: number;
  readonly fallbacks: number;
  readonly conflicts: number;
  readonly lastDurableLagMs: number;
  readonly maxDurableLagMs: number;
  /** No TPM capability was needed; these completions never fabricate Redis timing samples. */
  readonly completedWithoutReconciliation: number;
  readonly receiptQueueWaitCount: number;
  readonly receiptQueueWaitSumMs: number;
  readonly receiptQueueWaitLastMs: number;
  readonly receiptQueueWaitMaxMs: number;
  readonly receiptAwaitCount: number;
  readonly receiptAwaitSumMs: number;
  readonly receiptAwaitLastMs: number;
  readonly receiptAwaitMaxMs: number;
  readonly reconciliationQueueWaitCount: number;
  readonly reconciliationQueueWaitSumMs: number;
  readonly reconciliationQueueWaitLastMs: number;
  readonly reconciliationQueueWaitMaxMs: number;
  readonly reconciliationAwaitCount: number;
  readonly reconciliationAwaitSumMs: number;
  readonly reconciliationAwaitLastMs: number;
  readonly reconciliationAwaitMaxMs: number;
  readonly residenceCount: number;
  readonly residenceSumMs: number;
  readonly residenceLastMs: number;
  readonly residenceMaxMs: number;
}
export interface FastReceiptQueueOptions extends FastReceiptQueueLimits {
  readonly journal: Pick<FastGatewayJournalPort, 'appendReceipt'>;
  /** Fixed numeric aggregate only; never receives receipts, identities or errors. */
  readonly observe?: (snapshot: FastReceiptQueueSnapshot) => void;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => number;
}
export interface FastReceiptQueueCompletion {
  readonly retainedLiabilityMinorUnits: string;
  readonly currency: string | null;
  readonly actualTokenUnits?: number;
  /** A scalar-bound capability supplied by admission, NOT a request closure. */
  readonly reconcileDurableUsage?: (actualTokenUnits: number) => Promise<void>;
}
type Evidence =
  | { readonly kind: 'receipt'; readonly receipt: FastReceiptInput; readonly canonical: string }
  | { readonly kind: 'reconciliation'; readonly fingerprint: string };
interface Entry {
  readonly intentId: string;
  readonly tenantId: string;
  /** Replacing this union releases the receipt and its WeakMap-backed prepared metadata. */
  evidence: Evidence;
  readonly bytes: number;
  readonly acceptedAt: number;
  readonly liability: bigint;
  readonly currency: string | null;
  readonly actualTokenUnits?: number;
  readonly reconcileDurableUsage?: (actualTokenUnits: number) => Promise<void>;
  running: boolean;
  conflict: boolean;
  failures: number;
  retryAt: number;
  /** Acceptance, durable ACK or prior attempt finish; retry waits include backoff. */
  phaseQueuedAt: number;
}
interface TimingCounter {
  count: number;
  sumMs: number;
  lastMs: number;
  maxMs: number;
}
function timingCounter(): TimingCounter {
  return { count: 0, sumMs: 0, lastMs: 0, maxMs: 0 };
}
function recordTiming(counter: TimingCounter, durationMs: number): void {
  const elapsed = Math.max(0, durationMs);
  counter.count++;
  counter.sumMs += elapsed;
  counter.lastMs = elapsed;
  counter.maxMs = Math.max(counter.maxMs, elapsed);
}
/** A compact cryptographic identity, never a substitute for external evidence validation. */
function fingerprint(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function positive(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('FAST_RECEIPT_INVALID_CONFIGURATION');
  return value;
}

/**
 * Opt-in volatile final evidence. Capacity includes queued, retrying AND running tasks.
 * Accepted entries are never dropped: failures retain M and retry identical evidence.
 * The queue owns no client/request/transport object, and workers run outside request ALS.
 */
export class FastReceiptQueue {
  readonly #options: FastReceiptQueueOptions;
  readonly #limits: Required<FastReceiptQueueLimits>;
  // Identity and undurable indexes preserve acceptance order; each task owns one shared reservation.
  readonly #entries = new Map<string, Entry>();
  readonly #receipts = new Map<string, Entry>();
  readonly #reconciliations = new Map<string, Entry>();
  readonly #liabilities = new Map<string, { count: number; amount: bigint }>();
  readonly #tenants = new Map<string, number>();
  readonly #context = new AsyncResource('FastReceiptQueue');
  readonly #now: () => number;
  #accepting = true;
  #bytes = 0;
  #running = 0;
  #receiptRunning = 0;
  #reconciliationRunning = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pumping = false;
  #pumpScheduled = false;
  #changed: (() => void) | undefined;
  #draining: Promise<void> | undefined;
  #accepted = 0;
  #durable = 0;
  #completed = 0;
  #retries = 0;
  #reconciliationRetries = 0;
  #fallbacks = 0;
  #conflicts = 0;
  #lastDurableLagMs = 0;
  #maxDurableLagMs = 0;
  #lastFailureReportAt = -Infinity;
  #completedWithoutReconciliation = 0;
  readonly #receiptQueueWait = timingCounter();
  readonly #receiptAwait = timingCounter();
  readonly #reconciliationQueueWait = timingCounter();
  readonly #reconciliationAwait = timingCounter();
  readonly #residence = timingCounter();
  constructor(options: FastReceiptQueueOptions) {
    this.#options = options;
    this.#limits = {
      maxEntries: positive(options.maxEntries ?? 256, 65536),
      maxBytes: positive(options.maxBytes ?? 2 * 1024 * 1024, 256 * 1024 * 1024),
      workers: positive(options.workers ?? 2, 32),
      maxPerTenant: positive(options.maxPerTenant ?? 64, 65536),
      maxAgeMs: positive(options.maxAgeMs ?? 5000, 3600000),
      drainTimeoutMs: positive(options.drainTimeoutMs ?? 10000, 3600000),
    };
    positive(options.retryBaseMs ?? 25);
    positive(options.retryMaxMs ?? 1000);
    this.#now = options.now ?? (() => performance.now());
  }
  snapshot(): FastReceiptQueueSnapshot {
    const now = this.#now();
    const oldest = this.#entries.values().next().value;
    const oldestUndurable = this.#receipts.values().next().value;
    return Object.freeze({
      accepting: this.#accepting,
      pending: this.#entries.size,
      bytes: this.#bytes,
      running: this.#running,
      receiptRunning: this.#receiptRunning,
      reconciliationRunning: this.#reconciliationRunning,
      oldestAgeMs: oldest ? Math.max(0, now - oldest.acceptedAt) : 0,
      undurable: this.#receipts.size,
      oldestUndurableAgeMs: oldestUndurable ? Math.max(0, now - oldestUndurable.acceptedAt) : 0,
      undurableLiabilityByCurrency: Object.freeze(
        Object.fromEntries([...this.#liabilities].map(([currency, value]) => [currency, value.amount.toString()])),
      ),
      accepted: this.#accepted,
      durable: this.#durable,
      completed: this.#completed,
      retries: this.#retries,
      reconciliationRetries: this.#reconciliationRetries,
      fallbacks: this.#fallbacks,
      conflicts: this.#conflicts,
      lastDurableLagMs: this.#lastDurableLagMs,
      maxDurableLagMs: this.#maxDurableLagMs,
      completedWithoutReconciliation: this.#completedWithoutReconciliation,
      receiptQueueWaitCount: this.#receiptQueueWait.count,
      receiptQueueWaitSumMs: this.#receiptQueueWait.sumMs,
      receiptQueueWaitLastMs: this.#receiptQueueWait.lastMs,
      receiptQueueWaitMaxMs: this.#receiptQueueWait.maxMs,
      receiptAwaitCount: this.#receiptAwait.count,
      receiptAwaitSumMs: this.#receiptAwait.sumMs,
      receiptAwaitLastMs: this.#receiptAwait.lastMs,
      receiptAwaitMaxMs: this.#receiptAwait.maxMs,
      reconciliationQueueWaitCount: this.#reconciliationQueueWait.count,
      reconciliationQueueWaitSumMs: this.#reconciliationQueueWait.sumMs,
      reconciliationQueueWaitLastMs: this.#reconciliationQueueWait.lastMs,
      reconciliationQueueWaitMaxMs: this.#reconciliationQueueWait.maxMs,
      reconciliationAwaitCount: this.#reconciliationAwait.count,
      reconciliationAwaitSumMs: this.#reconciliationAwait.sumMs,
      reconciliationAwaitLastMs: this.#reconciliationAwait.lastMs,
      reconciliationAwaitMaxMs: this.#reconciliationAwait.maxMs,
      residenceCount: this.#residence.count,
      residenceSumMs: this.#residence.sumMs,
      residenceLastMs: this.#residence.lastMs,
      residenceMaxMs: this.#residence.maxMs,
    });
  }
  /** Budget pressure affects readiness; already-started requests may still synchronously fall back. */
  isReady(): boolean {
    return this.canAdmit() && this.#entries.size < this.#limits.maxEntries && this.#bytes < this.#limits.maxBytes;
  }
  /** A prolonged outage/conflict stops new upstream attempts, not just the readiness probe. */
  canAdmit(): boolean {
    if (!this.#accepting || this.#conflicts !== 0) return false;
    const oldest = this.#receipts.values().next().value;
    return !oldest || this.#now() - oldest.acceptedAt < this.#limits.maxAgeMs;
  }
  noteFallback(): void {
    this.#fallbacks++;
    this.#notify();
  }
  tryEnqueue(input: FastReceiptInput, completion: FastReceiptQueueCompletion): boolean {
    const prepared = getPreparedFastReceipt(input);
    const { receipt, canonical } = prepared
      ? { receipt: input, canonical: prepared.canonical }
      : captureUntrustedFastReceipt(input);
    // Capture completion facts once, after ownership of the receipt facts is established.
    const { retainedLiabilityMinorUnits, currency, actualTokenUnits, reconcileDurableUsage } = completion;
    if (
      !decimal(retainedLiabilityMinorUnits) ||
      (currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) ||
      (currency === null && retainedLiabilityMinorUnits !== '0') ||
      (receipt.verification && receipt.verification.priceSnapshot.customerPrice.currency !== currency) ||
      (actualTokenUnits !== undefined &&
        (!Number.isSafeInteger(actualTokenUnits) ||
          actualTokenUnits < 0 ||
          receipt.outcome !== 'succeeded' ||
          typeof reconcileDurableUsage !== 'function' ||
          receipt.usage.inputTotal == null ||
          receipt.usage.outputTotal == null ||
          BigInt(receipt.usage.inputTotal) + BigInt(receipt.usage.outputTotal) !== BigInt(actualTokenUnits)))
    )
      throw new Error('FAST_RECEIPT_INVALID_COMPLETION');
    const previous = this.#entries.get(receipt.intentId);
    if (previous) {
      if (
        (previous.evidence.kind === 'receipt'
          ? previous.evidence.canonical !== canonical
          : previous.evidence.fingerprint !== fingerprint(canonical)) ||
        previous.actualTokenUnits !== actualTokenUnits ||
        previous.currency !== currency ||
        previous.liability !== BigInt(retainedLiabilityMinorUnits)
      )
        throw new Error('FAST_JOURNAL_RECEIPT_CONFLICT');
      return true;
    }
    // Include canonical comparison material and envelope; count separately bounds object/promise overhead.
    const bytes = prepared?.retainedBytes ?? Buffer.byteLength(canonical) * 2 + 256;
    const tenantCount = this.#tenants.get(receipt.tenantId) ?? 0;
    if (
      !this.canAdmit() ||
      this.#entries.size >= this.#limits.maxEntries ||
      this.#bytes + bytes > this.#limits.maxBytes ||
      tenantCount >= this.#limits.maxPerTenant
    ) {
      this.noteFallback();
      return false;
    }
    // Only accepted evidence is retained; duplicates and fallbacks need no recursive freeze.
    if (!prepared) freeze(receipt);
    const acceptedAt = this.#now();
    const entry: Entry = {
      intentId: receipt.intentId,
      tenantId: receipt.tenantId,
      evidence: { kind: 'receipt', receipt, canonical },
      bytes,
      acceptedAt,
      liability: BigInt(retainedLiabilityMinorUnits),
      currency,
      actualTokenUnits,
      reconcileDurableUsage: actualTokenUnits === undefined ? undefined : reconcileDurableUsage,
      running: false,
      conflict: false,
      failures: 0,
      retryAt: 0,
      phaseQueuedAt: acceptedAt,
    };
    this.#entries.set(receipt.intentId, entry);
    this.#receipts.set(receipt.intentId, entry);
    if (currency !== null) {
      const aggregate = this.#liabilities.get(currency) ?? { count: 0, amount: 0n };
      aggregate.count++;
      aggregate.amount += entry.liability;
      this.#liabilities.set(currency, aggregate);
    }
    this.#tenants.set(receipt.tenantId, tenantCount + 1);
    this.#bytes += bytes;
    this.#accepted++;
    // Ownership is established synchronously BEFORE any client terminal write.
    this.#requestPump(true);
    this.#notify();
    return true;
  }
  stopAccepting(): void {
    this.#accepting = false;
    this.#notify();
  }
  close(): Promise<void> {
    this.stopAccepting();
    return this.drain();
  }
  drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    if (this.#entries.size === 0) return Promise.resolve();
    this.#draining = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('FAST_RECEIPT_DRAIN_TIMEOUT')), this.#limits.drainTimeoutMs);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.#changed = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.#changed = () => {
        if (this.#conflicts > 0) finish(new Error('FAST_RECEIPT_DRAIN_CONFLICT'));
        else if (this.#entries.size === 0) finish();
      };
      this.#changed();
    }).finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }
  #notify(): void {
    this.#changed?.();
    try {
      this.#options.observe?.(this.snapshot());
    } catch {
      /* observers cannot lose billing evidence */
    }
  }
  #requestPump(immediate = false): void {
    if (this.#pumpScheduled) return;
    // Preserve immediate idle-worker dispatch, without scanning again for each
    // completion in the same microtask turn. At most one callback is retained.
    if (immediate && !this.#pumping) {
      this.#context.runInAsyncScope(() => this.#pump());
      return;
    }
    this.#pumpScheduled = true;
    this.#context.runInAsyncScope(() =>
      queueMicrotask(() => {
        this.#pumpScheduled = false;
        this.#pump();
      }),
    );
  }
  #pump(): void {
    this.#pumping = true;
    try {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = undefined;
      const now = this.#now();
      const next = Math.min(
        this.#pumpStage(this.#receipts, false, now),
        this.#pumpStage(this.#reconciliations, true, now),
      );
      if (Number.isFinite(next)) {
        this.#timer = setTimeout(() => this.#requestPump(), Math.max(1, next - this.#now()));
        this.#timer.unref();
      }
    } finally {
      this.#pumping = false;
    }
  }
  #pumpStage(entries: ReadonlyMap<string, Entry>, reconciliation: boolean, now: number): number {
    let next = Infinity;
    // A saturated stage needs no scan/timer: its completion will request a pump.
    // In particular, stalled Redis never consumes a SQL slot or a receipt scan.
    if ((reconciliation ? this.#reconciliationRunning : this.#receiptRunning) >= this.#limits.workers) return next;
    for (const entry of entries.values()) {
      if (entry.running || entry.conflict) continue;
      if (entry.retryAt > now) {
        next = Math.min(next, entry.retryAt);
        continue;
      }
      entry.running = true;
      this.#running++;
      if (reconciliation) this.#reconciliationRunning++;
      else this.#receiptRunning++;
      void this.#run(entry, reconciliation);
      if ((reconciliation ? this.#reconciliationRunning : this.#receiptRunning) >= this.#limits.workers)
        return Infinity;
    }
    return next;
  }
  #acknowledge(entry: Entry): void {
    if (entry.currency !== null) {
      const aggregate = this.#liabilities.get(entry.currency);
      if (!aggregate) throw new Error('FAST_RECEIPT_INVALID_ACCOUNTING');
      aggregate.count--;
      aggregate.amount -= entry.liability;
      if (aggregate.count === 0) this.#liabilities.delete(entry.currency);
    }
    this.#receipts.delete(entry.intentId);
  }
  #complete(entry: Entry, finishedAt: number): void {
    this.#entries.delete(entry.intentId);
    this.#reconciliations.delete(entry.intentId);
    const remaining = (this.#tenants.get(entry.tenantId) ?? 1) - 1;
    if (remaining === 0) this.#tenants.delete(entry.tenantId);
    else this.#tenants.set(entry.tenantId, remaining);
    this.#bytes -= entry.bytes;
    this.#completed++;
    if (entry.actualTokenUnits === undefined) this.#completedWithoutReconciliation++;
    recordTiming(this.#residence, finishedAt - entry.acceptedAt);
  }
  async #run(entry: Entry, reconciliation: boolean): Promise<void> {
    const startedAt = this.#now();
    let finishedAt = startedAt;
    let failed = false;
    try {
      if (!reconciliation) {
        const evidence = entry.evidence;
        if (evidence.kind !== 'receipt') throw new Error('FAST_RECEIPT_INVALID_PHASE');
        await this.#options.journal.appendReceipt(evidence.receipt);
        finishedAt = this.#now();
        // Only a definite ACK permits release of exact evidence. The full
        // canonical includes proof, unlike journal's compatibility v1 digest.
        // No new task reservation is acquired, and the original byte/tenant
        // charge remains until the independently retryable TPM task completes.
        const compact: Evidence | undefined =
          entry.actualTokenUnits === undefined
            ? undefined
            : { kind: 'reconciliation', fingerprint: fingerprint(evidence.canonical) };
        this.#acknowledge(entry);
        if (compact) {
          entry.evidence = compact;
          this.#reconciliations.set(entry.intentId, entry);
        }
        entry.failures = 0;
        entry.retryAt = 0;
        this.#durable++;
        this.#lastDurableLagMs = Math.max(0, finishedAt - entry.acceptedAt);
        this.#maxDurableLagMs = Math.max(this.#maxDurableLagMs, this.#lastDurableLagMs);
        if (entry.actualTokenUnits === undefined) this.#complete(entry, finishedAt);
      } else {
        if (entry.actualTokenUnits !== undefined) await entry.reconcileDurableUsage?.(entry.actualTokenUnits);
        finishedAt = this.#now();
        this.#complete(entry, finishedAt);
      }
    } catch (error) {
      finishedAt = this.#now();
      failed = true;
      if (!reconciliation && error instanceof Error && error.message === 'FAST_JOURNAL_RECEIPT_CONFLICT') {
        entry.conflict = true;
        this.#conflicts++;
      } else {
        if (reconciliation) this.#reconciliationRetries++;
        else this.#retries++;
        const delay = Math.min(
          this.#options.retryMaxMs ?? 1000,
          (this.#options.retryBaseMs ?? 25) * 2 ** Math.min(entry.failures++, 20),
        );
        entry.retryAt = this.#now() + delay * (0.75 + Math.random() * 0.5);
      }
    } finally {
      // Publish each settled attempt's paired samples before the single completion
      // notification. Count deltas of one recover LastMs without per-request retention.
      // Await spans the port call (including PG pool/commit or Redis command wait),
      // never the observer, logging or subsequent pump work.
      recordTiming(
        reconciliation ? this.#reconciliationQueueWait : this.#receiptQueueWait,
        startedAt - entry.phaseQueuedAt,
      );
      recordTiming(reconciliation ? this.#reconciliationAwait : this.#receiptAwait, finishedAt - startedAt);
      entry.phaseQueuedAt = finishedAt;
      entry.running = false;
      this.#running--;
      if (reconciliation) this.#reconciliationRunning--;
      else this.#receiptRunning--;
      // No raw exception or receipt reaches logs. Rate-limit the default
      // operational warning; deployments may install their own aggregate metrics sink.
      if (failed && !this.#options.observe && this.#now() - this.#lastFailureReportAt >= 1000) {
        this.#lastFailureReportAt = this.#now();
        console.error('FAST_RECEIPT_QUEUE_RETAINED_FAILURE', JSON.stringify(this.snapshot()));
      }
      this.#notify();
      this.#requestPump();
    }
  }
}
