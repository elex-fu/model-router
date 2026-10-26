import { createHash, randomUUID } from 'node:crypto';
import { normalizeCurrency, parseMinorUnits } from '../../billing/money.js';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { calculatePriceVersion } from '../../pricing/calculator.js';
import type { CustomerPriceVersionRecord, TokenUsageInput } from '../../pricing/types.js';
import { calculateConservativePriceHold, INPUT_BILLING_BUCKETS } from '../hold-calculator.js';

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
  readonly sendDeadlineMs: number;
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
  /** An explicit maximum escrow tranche, not an overdraft or a request estimate. */
  readonly allocationTrancheMinorUnits: string;
  /** Total tranche is shared by these stripes, never multiplied. Default 8. */
  readonly allocationStripes?: number;
  readonly workerPollMs?: number;
  readonly workerBatchSize?: number;
  readonly onBackgroundError?: (code: string) => void;
  readonly onCreditUnavailable?: (reason: 'credit_busy' | 'credit_not_ready') => void;
}

/** Canonical JSON preserves bigint exactly and rejects non-JSON authority facts. */
export function fastJournalCanonicalJson(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    throw new Error('FAST_JOURNAL_INVALID_JSON');
  }
  return JSON.stringify(canonical(value));
}
export function fastJournalDigest(value: unknown): string {
  return createHash('sha256').update(fastJournalCanonicalJson(value)).digest('hex');
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
SELECT id,false AS credit_busy FROM inserted
UNION ALL SELECT NULL::uuid,EXISTS(SELECT 1 FROM candidate) AS credit_busy WHERE NOT EXISTS(SELECT 1 FROM inserted)`;

interface AllocationRow {
  id: string;
  tenant_id: string;
  currency: string;
  wallet_id: string;
  epoch: string;
  state: 'active' | 'retired';
  backing_minor_units: string;
  available_minor_units: string;
}

export class PostgresFastGatewayJournal implements FastGatewayJournal {
  private readonly epoch = randomUUID();
  private readonly tranche: bigint;
  private readonly stripes: number;
  private readonly observedMaximum = new Map<string, { maximum: bigint; nextStripe: number }>();
  private readonly ready: Promise<void>;
  private readonly pendingReplenishments = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  private closed = false;
  private workerStarted = false;
  private wakeRequested = false;
  private idleDelay = 25;
  private pollDueAt = 0;

  constructor(
    private readonly database: SaasDatabase,
    private readonly options: FastJournalOptions,
  ) {
    if (!options.allocationOwner.trim()) throw new Error('FAST_JOURNAL_INVALID_OWNER');
    this.tranche = parseMinorUnits(options.allocationTrancheMinorUnits);
    this.stripes = options.allocationStripes ?? 8;
    if (!Number.isSafeInteger(this.stripes) || this.stripes < 1 || this.stripes > 8)
      throw new Error('FAST_JOURNAL_INVALID_STRIPES');
    this.ready = database
      .query(
        `INSERT INTO saas_fast_gateway_owners(owner, epoch) VALUES ($1, $2)
       ON CONFLICT (owner) DO UPDATE SET epoch = EXCLUDED.epoch`,
        [options.allocationOwner, this.epoch],
      )
      .then(() => undefined);
    // A failed startup cannot become an unhandled rejection before the first call.
    void this.ready.catch(() => options.onBackgroundError?.('FAST_JOURNAL_STARTUP_FAILED'));
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
      this.running = this.runOnce(this.options.workerBatchSize ?? 128);
      void this.running
        .then(
          (count) => {
            this.idleDelay = count ? base : Math.min(Math.max(1000, base), this.idleDelay * 2);
            next = count >= (this.options.workerBatchSize ?? 128) ? 0 : this.idleDelay;
          },
          () => {
            this.options.onBackgroundError?.('FAST_JOURNAL_WORKER_FAILED');
            next = Math.max(1000, base);
          },
        )
        .finally(() => {
          this.running = undefined;
          if (this.wakeRequested) next = base;
          this.wakeRequested = false;
          this.scheduleWorker(next);
        });
    }, delay);
    this.timer.unref();
  }

  private wakeWorker(): void {
    if (!this.workerStarted || this.closed) return;
    this.idleDelay = this.options.workerPollMs ?? 25;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
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
    if (input.allocationOwner !== this.options.allocationOwner) throw new Error('FAST_JOURNAL_OWNER_MISMATCH');
    const max = parseMinorUnits(input.maxCostMinorUnits, { allowZero: true });
    digest(input.requestFingerprint);
    digest(input.payloadSha256);
    if (!Number.isSafeInteger(input.sendDeadlineMs) || input.sendDeadlineMs <= Date.now())
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
      if (max > this.tranche) return { kind: 'denied', reason: 'tranche_too_small' };
      this.observeMaximum(input.tenantId, input.currency, max);
    }
    await this.ready;
    const id = randomUUID();
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
    let unavailable: 'credit_busy' | 'credit_not_ready' = 'credit_not_ready';
    try {
      const result = await this.database.query<{ id: string | null; credit_busy: boolean }>(RESERVE_SQL, [
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
        input.priceSnapshot === null ? null : fastJournalCanonicalJson(input.priceSnapshot),
        fastJournalCanonicalJson(input.authoritySnapshot),
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
      if (result.rows.length !== 1 || result.rows[0]?.id !== null) throw new Error('FAST_JOURNAL_UNCERTAIN_RESERVE');
      if (result.rows[0].credit_busy) unavailable = 'credit_busy';
    } catch (error) {
      // All non-unique errors, including lost commit ACK, remain uncertain. Never
      // retry a write or return a sending authority from a subsequent lookup.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findExisting(input, identity);
      return existing ?? { kind: 'denied', reason: 'identity_conflict' };
    }
    const existing = await this.findExisting(input, identity);
    if (existing) return existing;
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
      `SELECT i.request_id, i.intent_digest, COALESCE(j.state, r.outcome, 'unresolved') AS status
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
    digest(input.usageDigest);
    if (input.chargeMinorUnits !== null) parseMinorUnits(input.chargeMinorUnits, { allowZero: true });
    if (input.outcome === 'unknown' && input.chargeMinorUnits !== null) throw new Error('FAST_JOURNAL_UNKNOWN_CHARGE');
    for (const value of Object.values(input.usage)) if (value !== null) parseMinorUnits(value, { allowZero: true });
    const receiptDigest = fastJournalDigest(input);
    // Snapshot every parameter before the first await. Retrying a receipt is
    // safe; retrying an intent/upstream execution is deliberately forbidden.
    const values = [
      input.intentId,
      input.tenantId,
      input.requestId,
      input.outcome,
      input.chargeMinorUnits,
      fastJournalCanonicalJson(input.usage),
      input.usageDigest,
      receiptDigest,
      input.httpStatus,
      input.outcome === 'succeeded' || isFastDefinitelyUnsentReceipt(input) ? 'pending' : 'blocked',
    ];
    const append = async (): Promise<void> => {
      try {
        const result = await this.database.query(
          `/* fast-journal:append-receipt */
           WITH receipt AS (
             INSERT INTO saas_fast_gateway_receipts
               (intent_id, tenant_id, request_id, outcome, charge_minor_units, usage, usage_digest, receipt_digest, http_status)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING intent_id
           ), queued AS (
             INSERT INTO saas_fast_billing_jobs(intent_id, state)
             SELECT intent_id, $10::text FROM receipt
             ON CONFLICT(intent_id) DO NOTHING
           ) SELECT intent_id FROM receipt`,
          values,
        );
        one(result.rowCount);
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

  private scheduleReplenishment(tenantId: string, currency: string): void {
    const key = `${tenantId}:${currency}`;
    if (this.closed || this.pendingReplenishments.has(key)) return;
    const work = this.replenish(tenantId, currency);
    this.pendingReplenishments.set(key, work);
    void work
      .catch(() => this.options.onBackgroundError?.('FAST_JOURNAL_REPLENISH_FAILED'))
      .finally(() => this.pendingReplenishments.delete(key));
  }

  // Bounded process-local scheduling hints, never money authority. Eviction
  // changes contention/fragmentation only; durable allocation CAS still decides.
  private observeMaximum(tenantId: string, currency: string, maximum: bigint): void {
    const key = `${tenantId}:${currency}`;
    let entry = this.observedMaximum.get(key);
    if (!entry) {
      if (this.observedMaximum.size >= 1024) {
        const oldest = this.observedMaximum.keys().next().value;
        if (oldest !== undefined) this.observedMaximum.delete(oldest);
      }
      entry = { maximum, nextStripe: 0 };
      this.observedMaximum.set(key, entry);
    } else if (maximum > entry.maximum) entry.maximum = maximum;
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
    await this.database.transaction(async (tx) => {
      const owner = await tx.query<{ epoch: string }>(
        'SELECT epoch FROM saas_fast_gateway_owners WHERE owner = $1 FOR SHARE',
        [this.options.allocationOwner],
      );
      if (owner.rows[0]?.epoch !== this.epoch) throw new Error('FAST_JOURNAL_FENCED_OWNER');
      await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(tenantId, currency)]);
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
      const needed = this.tranche - BigInt(wallet.own_backing);
      const free = BigInt(wallet.available);
      const additional = needed > 0n && free > 0n ? (free < needed ? free : needed) : 0n;
      const available = allocations.rows.reduce((sum, row) => sum + BigInt(row.available_minor_units), additional);
      if (available === 0n) return;
      const maximum = this.observedMaximum.get(`${tenantId}:${currency}`)?.maximum ?? 0n;
      // Four-M headroom per stripe when affordable; near-tranche requests use
      // one stripe. Unknown prewarm can fragment; first safe denial schedules
      // this cost-aware rebalance without spending or retrying any intent.
      const affordable = maximum > 0n ? available / (maximum * 4n) : BigInt(this.stripes);
      const count = Math.max(1, Math.min(this.stripes, Number(affordable > 8n ? 8n : affordable)));
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
  async runOnce(limit = 128): Promise<number> {
    await this.ready;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('FAST_JOURNAL_INVALID_BATCH');
    return this.database.transaction(async (tx) => {
      const jobs = await tx.query<{ intent_id: string }>(
        `/* fast-journal:worker-claim */ SELECT intent_id FROM saas_fast_billing_jobs
         WHERE state='pending' ORDER BY created_at,intent_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (jobs.rows.length === 0) return 0;
      await this.settleBatch(
        tx,
        jobs.rows.map((job) => job.intent_id),
      );
      return jobs.rows.length;
    });
  }

  private async settleBatch(tx: SqlExecutor, intentIds: readonly string[]): Promise<void> {
    const result = await tx.query<SettlementRow>(
      `SELECT i.*,COALESCE(x.charge_minor_units,r.charge_minor_units) AS charge_minor_units,
         COALESCE(x.usage,r.usage) AS usage,COALESCE(x.usage_digest,r.usage_digest) AS usage_digest,
         CASE WHEN x.kind='non_execution' THEN 'not_executed' WHEN x.kind='verified_usage' THEN 'succeeded' ELSE r.outcome END AS outcome,
         r.http_status,x.id AS resolution_id,x.kind AS resolution_kind
       FROM saas_fast_gateway_intents i LEFT JOIN saas_fast_gateway_receipts r ON r.intent_id=i.id
       LEFT JOIN saas_fast_gateway_resolutions x ON x.intent_id=i.id
       WHERE i.id=ANY($1::uuid[]) ORDER BY i.tenant_id,i.currency,i.id`,
      [intentIds],
    );
    if (result.rows.length !== intentIds.length) throw new Error('FAST_JOURNAL_MISSING_INTENT');
    const invalid: string[] = [];
    const valid: Array<{ row: SettlementRow; charge: bigint; ledgerId: string | null }> = [];
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
        if (
          (!unsent && row.outcome !== 'succeeded') ||
          row.charge_minor_units === null ||
          charge !== BigInt(row.charge_minor_units) ||
          charge > BigInt(row.max_cost_minor_units)
        ) {
          throw new Error('invalid charge');
        }
        valid.push({ row, charge, ledgerId: charge > 0n ? randomUUID() : null });
      } catch {
        invalid.push(row.id);
      }
    }
    if (invalid.length) {
      const blocked = await tx.query(
        `UPDATE saas_fast_billing_jobs SET state='blocked',attempts=attempts+1,
        last_error='receipt_price_mismatch' WHERE intent_id=ANY($1::uuid[]) AND state='pending'`,
        [invalid],
      );
      if (blocked.rowCount !== invalid.length) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
    }
    if (!valid.length) return;
    const paid = valid.filter((item) => item.row.currency !== null);
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
      const allocations = await tx.query<AllocationRow>(
        'SELECT * FROM saas_fast_credit_allocations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [[...new Set(paid.map(({ row }) => row.allocation_id))]],
      );
      const allocationById = new Map(allocations.rows.map((allocation) => [allocation.id, allocation]));
      const credits = new Map<string, { id: string; release: bigint; restore: bigint }>();
      const wallets = new Map<string, { id: string; tenantId: string; charge: bigint; ledgerId: string }>();
      const postings: LedgerBatchRow[] = [];
      for (const { row, charge, ledgerId } of paid) {
        const allocation = row.allocation_id === null ? undefined : allocationById.get(row.allocation_id);
        if (
          !allocation ||
          allocation.tenant_id !== row.tenant_id ||
          allocation.currency !== row.currency ||
          allocation.epoch !== row.allocation_epoch
        )
          throw new Error('FAST_JOURNAL_ALLOCATION_MISMATCH');
        const maximum = BigInt(row.max_cost_minor_units);
        const credit = credits.get(allocation.id) ?? { id: allocation.id, release: 0n, restore: 0n };
        credit.release += allocation.state === 'active' ? charge : maximum;
        credit.restore += allocation.state === 'active' ? maximum - charge : 0n;
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
        // The preceding command inserts every immutable ledger pair. Project
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
      const restored = await tx.query(
        `/* fast-journal:worker-credit */ UPDATE saas_fast_credit_allocations a
        SET backing_minor_units=a.backing_minor_units-c.release,
            available_minor_units=a.available_minor_units+c.restore
        FROM jsonb_to_recordset($1::jsonb) AS c(id uuid,release bigint,restore bigint)
        WHERE a.id=c.id AND a.backing_minor_units >= c.release RETURNING a.id`,
        [fastJournalCanonicalJson([...credits.values()])],
      );
      if (restored.rowCount !== credits.size) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
    }
    const completed = await tx.query(
      `/* fast-journal:worker-complete */ UPDATE saas_fast_billing_jobs j
      SET state='completed',attempts=attempts+1,ledger_transaction_id=c.ledger_id,completed_at=now(),last_error=NULL
      FROM jsonb_to_recordset($1::jsonb) AS c(intent_id uuid,ledger_id uuid)
      WHERE j.intent_id=c.intent_id AND j.state='pending'`,
      [fastJournalCanonicalJson(valid.map(({ row, ledgerId }) => ({ intent_id: row.id, ledger_id: ledgerId })))],
    );
    if (completed.rowCount !== valid.length) throw new Error('FAST_JOURNAL_STATE_CONFLICT');
  }

  /** Waits for all known pending successes; blocked unknowns remain durable and backed. */
  async drain(): Promise<void> {
    await Promise.all([...this.pendingReplenishments.values()]);
    if (this.running) await this.running;
    while (await this.runOnce(this.options.workerBatchSize ?? 128)) {
      /* durable drain */
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
    await this.retireAllocations();
  }
}

interface SettlementRow {
  id: string;
  request_id: string;
  tenant_id: string;
  currency: string | null;
  allocation_id: string | null;
  allocation_epoch: string | null;
  max_cost_minor_units: string;
  price_snapshot: unknown;
  charge_minor_units: string | null;
  usage: Readonly<Record<string, string | null>>;
  usage_digest: string;
  outcome: string;
  http_status: number | null;
  resolution_id: string | null;
  resolution_kind: string | null;
}

/** Frozen customer price; no current-price lookup can change a receipt's bill. */
export function calculateFastReceiptCharge(snapshot: unknown, usage: Readonly<Record<string, string | null>>): bigint {
  if (snapshot === null) return 0n;
  const price = validatePriceSnapshot(snapshot);
  const input = usage.inputTotal;
  const output = usage.outputTotal;
  if (input === null || input === undefined || output === null || output === undefined)
    throw new Error('FAST_JOURNAL_INCOMPLETE_USAGE');
  parseMinorUnits(input, { allowZero: true });
  parseMinorUnits(output, { allowZero: true });
  if (usage.perUnitUnits !== undefined && usage.perUnitUnits !== null && usage.perUnitUnits !== '0') {
    throw new Error('FAST_JOURNAL_UNSUPPORTED_USAGE');
  }
  const count = (key: string): bigint | null =>
    usage[key] == null ? null : parseMinorUnits(usage[key], { allowZero: true });
  const genericWrite = count('cacheWrite');
  const write5m = count('cacheWrite5m');
  const write1h = count('cacheWrite1h');
  const detailedWrite = (write5m ?? 0n) + (write1h ?? 0n);
  if (genericWrite !== null && genericWrite > 0n && detailedWrite > 0n && genericWrite !== detailedWrite) {
    throw new Error('FAST_JOURNAL_INCONSISTENT_USAGE');
  }
  // Provider observations may carry both an aggregate cache-write total and
  // TTL subsets. The existing calculator intentionally accepts only one price
  // family; retain the subsets and do not bill or bound the aggregate twice.
  const normalized: TokenUsageInput = {
    inputTotal: input,
    inputUncached: usage.inputUncached ?? null,
    outputTotal: output,
    cacheRead: usage.cacheRead ?? null,
    cacheWrite: detailedWrite > 0n ? '0' : (usage.cacheWrite ?? null),
    cacheWrite5m: usage.cacheWrite5m ?? null,
    cacheWrite1h: usage.cacheWrite1h ?? null,
    reasoningOutput: usage.reasoningOutput ?? null,
  };
  if (['inputUncached', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'].some((key) => usage[key] != null)) {
    const total =
      (count('inputUncached') ?? 0n) +
      (count('cacheRead') ?? 0n) +
      (detailedWrite > 0n ? detailedWrite : (genericWrite ?? 0n));
    if (total !== BigInt(input)) throw new Error('FAST_JOURNAL_INCONSISTENT_USAGE');
  }
  if (BigInt(input) > BigInt(price.maxInputTokens) || BigInt(output) > BigInt(price.maxOutputTokens))
    throw new Error('FAST_JOURNAL_USAGE_EXCEEDS_BOUND');
  const calculation = calculatePriceVersion(price.customerPrice, normalized, { requireComplete: false });
  if (!calculation.complete) throw new Error('FAST_JOURNAL_INCOMPLETE_USAGE');
  return calculation.amountMinorUnits;
}

interface FastPriceSnapshot {
  readonly schemaVersion: 1;
  readonly customerPrice: CustomerPriceVersionRecord;
  readonly maxInputTokens: string;
  readonly maxOutputTokens: string;
}
function validatePriceSnapshot(snapshot: unknown): FastPriceSnapshot {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('FAST_JOURNAL_INVALID_PRICE');
  const price = snapshot as FastPriceSnapshot;
  if (
    price.schemaVersion !== 1 ||
    !price.customerPrice ||
    price.customerPrice.kind !== 'customer' ||
    price.customerPrice.tokenMultipliers !== null
  )
    throw new Error('FAST_JOURNAL_INVALID_PRICE');
  parseMinorUnits(price.maxInputTokens, { allowZero: true });
  parseMinorUnits(price.maxOutputTokens, { allowZero: true });
  return price;
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
