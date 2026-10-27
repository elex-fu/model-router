import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { FastGatewayJournalPort, FastReceiptInput } from './executor.js';
import { calculateFastReceiptCharge, fastJournalCanonicalJson } from './journal.js';

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
  readonly bytes: number;
  readonly running: number;
  readonly oldestAgeMs: number;
  readonly undurable: number;
  readonly undurableLiabilityMinorUnits: string;
  readonly accepted: number;
  readonly durable: number;
  readonly completed: number;
  readonly retries: number;
  readonly reconciliationRetries: number;
  readonly fallbacks: number;
  readonly conflicts: number;
  readonly lastDurableLagMs: number;
  readonly maxDurableLagMs: number;
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
  readonly actualTokenUnits?: number;
  /** A scalar-bound capability supplied by admission, NOT a request closure. */
  readonly reconcileDurableUsage?: (actualTokenUnits: number) => Promise<void>;
}
interface Entry {
  readonly receipt: FastReceiptInput;
  readonly canonical: string;
  readonly bytes: number;
  readonly acceptedAt: number;
  readonly liability: bigint;
  readonly actualTokenUnits?: number;
  readonly reconcileDurableUsage?: (actualTokenUnits: number) => Promise<void>;
  durable: boolean;
  running: boolean;
  conflict: boolean;
  failures: number;
  retryAt: number;
}
const USAGE_KEYS = new Set([
  'inputTotal',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'outputTotal',
  'reasoningOutput',
]);
const PRICE_KEYS = new Set([
  'kind',
  'id',
  'version',
  'publicModelId',
  'publicModelVersion',
  'providerId',
  'productId',
  'protocol',
  'endpoint',
  'currency',
  'commercialPolicyVersion',
  'calculatorVersion',
  'roundingVersion',
  'roundingMode',
  'roundingBoundary',
  'rates',
  'tokenMultipliers',
  'effectiveAt',
  'expiresAt',
  'idempotencyKey',
  'definitionDigest',
  'createdAt',
]);
const RATE_KEYS = new Set([
  'input',
  'output',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'per_unit',
  'per_unit_tiers',
]);
function scalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
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
/** Whitelist the retained evidence. Never clone a request, candidate, credential or arbitrary extension. */
function capture(input: FastReceiptInput): { receipt: FastReceiptInput; canonical: string } {
  if (
    ![input.intentId, input.requestId, input.tenantId].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 256,
    ) ||
    !['succeeded', 'failed', 'unknown'].includes(input.outcome) ||
    !/^[a-f0-9]{64}$/.test(input.usageDigest) ||
    (input.chargeMinorUnits !== null && !decimal(input.chargeMinorUnits)) ||
    (input.httpStatus !== null &&
      (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) ||
    (input.outcome === 'unknown' && input.chargeMinorUnits !== null)
  )
    throw new Error('FAST_RECEIPT_INVALID');
  const usage: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input.usage)) {
    if (!USAGE_KEYS.has(key) || (value !== null && !decimal(value))) throw new Error('FAST_RECEIPT_INVALID');
    usage[key] = value;
  }
  const proof = input.verification?.priceSnapshot;
  if (proof) {
    const price = proof.customerPrice;
    if (
      Object.keys(proof).some(
        (key) => !['schemaVersion', 'customerPrice', 'maxInputTokens', 'maxOutputTokens'].includes(key),
      ) ||
      Object.entries(price).some(([key, value]) => !PRICE_KEYS.has(key) || (key !== 'rates' && !scalar(value))) ||
      price.tokenMultipliers !== null ||
      Object.entries(price.rates).some(
        ([key, rate]) =>
          !RATE_KEYS.has(key) ||
          (rate !== null &&
            (key === 'per_unit' ||
              key === 'per_unit_tiers' ||
              Object.entries(rate).some(
                ([k, v]) => !['numeratorMinorUnits', 'denominatorUnits'].includes(k) || !scalar(v),
              ))),
      ) ||
      input.outcome !== 'succeeded' ||
      input.httpStatus === null ||
      input.httpStatus < 200 ||
      input.httpStatus >= 300 ||
      input.chargeMinorUnits === null ||
      calculateFastReceiptCharge(proof, usage) !== BigInt(input.chargeMinorUnits)
    )
      throw new Error('FAST_RECEIPT_INVALID_PROOF');
  }
  const canonical = fastJournalCanonicalJson({
    intentId: input.intentId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    outcome: input.outcome,
    chargeMinorUnits: input.chargeMinorUnits,
    usage,
    usageDigest: input.usageDigest,
    httpStatus: input.httpStatus,
    ...(proof ? { verification: { priceSnapshot: proof } } : {}),
  });
  return { receipt: freeze(JSON.parse(canonical) as FastReceiptInput), canonical };
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
  readonly #entries = new Map<string, Entry>();
  readonly #tenants = new Map<string, number>();
  readonly #context = new AsyncResource('FastReceiptQueue');
  readonly #now: () => number;
  #accepting = true;
  #bytes = 0;
  #running = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
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
    let oldestAgeMs = 0,
      undurable = 0,
      liability = 0n;
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      oldestAgeMs = Math.max(oldestAgeMs, now - entry.acceptedAt);
      if (!entry.durable) {
        undurable++;
        liability += entry.liability;
      }
    }
    return Object.freeze({
      accepting: this.#accepting,
      pending: this.#entries.size,
      bytes: this.#bytes,
      running: this.#running,
      oldestAgeMs,
      undurable,
      undurableLiabilityMinorUnits: liability.toString(),
      accepted: this.#accepted,
      durable: this.#durable,
      completed: this.#completed,
      retries: this.#retries,
      reconciliationRetries: this.#reconciliationRetries,
      fallbacks: this.#fallbacks,
      conflicts: this.#conflicts,
      lastDurableLagMs: this.#lastDurableLagMs,
      maxDurableLagMs: this.#maxDurableLagMs,
    });
  }
  /** Budget pressure affects readiness; already-started requests may still synchronously fall back. */
  isReady(): boolean {
    return this.canAdmit() && this.#entries.size < this.#limits.maxEntries && this.#bytes < this.#limits.maxBytes;
  }
  /** A prolonged outage/conflict stops new upstream attempts, not just the readiness probe. */
  canAdmit(): boolean {
    return this.#accepting && this.#conflicts === 0 && this.snapshot().oldestAgeMs < this.#limits.maxAgeMs;
  }
  noteFallback(): void {
    this.#fallbacks++;
    this.#notify();
  }
  tryEnqueue(input: FastReceiptInput, completion: FastReceiptQueueCompletion): boolean {
    const { receipt, canonical } = capture(input);
    if (
      !decimal(completion.retainedLiabilityMinorUnits) ||
      (completion.actualTokenUnits !== undefined &&
        (!Number.isSafeInteger(completion.actualTokenUnits) ||
          completion.actualTokenUnits < 0 ||
          receipt.outcome !== 'succeeded' ||
          typeof completion.reconcileDurableUsage !== 'function' ||
          receipt.usage.inputTotal == null ||
          receipt.usage.outputTotal == null ||
          BigInt(receipt.usage.inputTotal) + BigInt(receipt.usage.outputTotal) !== BigInt(completion.actualTokenUnits)))
    )
      throw new Error('FAST_RECEIPT_INVALID_COMPLETION');
    const previous = this.#entries.get(receipt.intentId);
    if (previous) {
      if (
        previous.canonical !== canonical ||
        previous.actualTokenUnits !== completion.actualTokenUnits ||
        previous.liability !== BigInt(completion.retainedLiabilityMinorUnits)
      )
        throw new Error('FAST_JOURNAL_RECEIPT_CONFLICT');
      return true;
    }
    // Include canonical comparison material and envelope; count separately bounds object/promise overhead.
    const bytes = Buffer.byteLength(canonical) * 2 + 256;
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
    const entry: Entry = {
      receipt,
      canonical,
      bytes,
      acceptedAt: this.#now(),
      liability: BigInt(completion.retainedLiabilityMinorUnits),
      actualTokenUnits: completion.actualTokenUnits,
      reconcileDurableUsage: completion.reconcileDurableUsage,
      durable: false,
      running: false,
      conflict: false,
      failures: 0,
      retryAt: 0,
    };
    this.#entries.set(receipt.intentId, entry);
    this.#tenants.set(receipt.tenantId, tenantCount + 1);
    this.#bytes += bytes;
    this.#accepted++;
    // Ownership is established synchronously BEFORE any client terminal write.
    this.#context.runInAsyncScope(() => this.#pump());
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
  #pump(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const now = this.#now();
    let next = Infinity;
    for (const entry of this.#entries.values()) {
      if (entry.running || entry.conflict) continue;
      if (this.#running >= this.#limits.workers) break;
      if (entry.retryAt > now) {
        next = Math.min(next, entry.retryAt);
        continue;
      }
      entry.running = true;
      this.#running++;
      void this.#run(entry);
    }
    if (Number.isFinite(next) && this.#running < this.#limits.workers) {
      this.#timer = setTimeout(() => this.#pump(), Math.max(1, next - this.#now()));
      this.#timer.unref();
    }
  }
  async #run(entry: Entry): Promise<void> {
    try {
      if (!entry.durable) {
        await this.#options.journal.appendReceipt(entry.receipt);
        entry.durable = true;
        entry.failures = 0;
        this.#durable++;
        this.#lastDurableLagMs = Math.max(0, this.#now() - entry.acceptedAt);
        this.#maxDurableLagMs = Math.max(this.#maxDurableLagMs, this.#lastDurableLagMs);
      }
      if (entry.actualTokenUnits !== undefined) await entry.reconcileDurableUsage?.(entry.actualTokenUnits);
      this.#entries.delete(entry.receipt.intentId);
      const remaining = (this.#tenants.get(entry.receipt.tenantId) ?? 1) - 1;
      if (remaining === 0) this.#tenants.delete(entry.receipt.tenantId);
      else this.#tenants.set(entry.receipt.tenantId, remaining);
      this.#bytes -= entry.bytes;
      this.#completed++;
    } catch (error) {
      if (!entry.durable && error instanceof Error && error.message === 'FAST_JOURNAL_RECEIPT_CONFLICT') {
        entry.conflict = true;
        this.#conflicts++;
      } else {
        if (entry.durable) this.#reconciliationRetries++;
        else this.#retries++;
        const delay = Math.min(
          this.#options.retryMaxMs ?? 1000,
          (this.#options.retryBaseMs ?? 25) * 2 ** Math.min(entry.failures++, 20),
        );
        entry.retryAt = this.#now() + delay * (0.75 + Math.random() * 0.5);
      }
    } finally {
      entry.running = false;
      this.#running--;
      this.#notify();
      this.#pump();
    }
  }
}
