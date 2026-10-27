import type { SaasDatabase, SqlExecutor } from '../db/types.js';

/**
 * §12.2 Phase A2b (D2): authority/entitlement invalidation events, shaped on
 * the saas_request_admission_outbox infrastructure precedent but far simpler:
 * consumption is at-least-once and coarsely scoped (any event flushes every
 * local cache entry of the polling process), so the table needs no lease,
 * claim, or delivery-state machinery — the cursor is per-process and
 * re-initializes to MAX(id) at startup (a fresh process starts with empty
 * caches, so replaying history would be pointless).
 *
 * Control-plane revocation class mutations append one row INSIDE the
 * revocation transaction; gateways that enable the broadcast
 * (MODEL_ROUTER_PREPARATION_INVALIDATION_BROADCAST, default OFF) poll at a
 * ~500ms cadence and drop their local version-keyed preparation caches
 * (key authentication, preparation authority/entitlement, scheduler static
 * eligibility).
 *
 * This is an availability optimization ONLY: it shortens the bounded (<=
 * cache TTL) window in which requests carry stale caller versions into
 * AUTHORITY_MISMATCH fail-closed guard rejections. The admission guard
 * remains the final defense line and never consults this table.
 */

/** Append-only event kinds; widening the set requires a migration (CHECK constraint). */
export const AUTHORITY_INVALIDATION_KINDS = [
  'api_key.revoked',
  'platform_inference_access.disabled',
  'platform_inference_access.activated',
  'membership.revoked',
] as const;

export type AuthorityInvalidationKind = (typeof AUTHORITY_INVALIDATION_KINDS)[number];

const AUTHORITY_INVALIDATION_KIND_SET: ReadonlySet<string> = new Set(AUTHORITY_INVALIDATION_KINDS);
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthorityInvalidationInput {
  readonly tenantId: string;
  readonly kind: AuthorityInvalidationKind;
  readonly reason?: string;
}

/**
 * Append one invalidation event using the caller's revocation transaction
 * executor, so the event commits if and only if the revocation commits.
 * Never call this outside the mutating transaction: an event for a rolled
 * back revocation would flush caches for nothing, while an emitted-after-
 * commit insert could outlive the transaction's snapshot guarantees.
 */
export async function recordAuthorityInvalidation(
  executor: SqlExecutor,
  input: AuthorityInvalidationInput,
): Promise<void> {
  // Format enforcement deliberately stops at "a bounded non-empty string":
  // the column type (uuid) and the tenant foreign key are the enforcement
  // points, and duplicating the uuid shape here would fail-closed inside
  // unrelated service fakes that use synthetic tenant ids. A garbage tenant
  // id in production rolls back the revocation itself — loud, never silent.
  if (typeof input.tenantId !== 'string' || input.tenantId.length < 1 || input.tenantId.length > 64) {
    throw new TypeError('Invalid authority invalidation tenant id');
  }
  if (typeof input.kind !== 'string' || !AUTHORITY_INVALIDATION_KIND_SET.has(input.kind)) {
    throw new TypeError('Invalid authority invalidation kind');
  }
  const reason = input.reason ?? null;
  if (
    reason !== null &&
    (typeof reason !== 'string' || reason.length < 1 || reason.length > 255 || reason.trim() !== reason)
  ) {
    throw new TypeError('Invalid authority invalidation reason');
  }
  await executor.query('INSERT INTO saas_authority_invalidation_events (tenant_id, kind, reason) VALUES ($1, $2, $3)', [
    input.tenantId,
    input.kind,
    reason,
  ]);
}

export interface AuthorityInvalidationEvent {
  readonly id: bigint;
  readonly tenantId: string;
  readonly kind: AuthorityInvalidationKind;
  readonly reason: string | null;
}

interface EventRow {
  id: unknown;
  tenant_id: unknown;
  kind: unknown;
  reason: unknown;
}

function parseEventId(value: unknown): bigint {
  try {
    const id = BigInt(value as string | number | bigint);
    if (id > 0n) return id;
  } catch {
    /* fall through to the typed error */
  }
  throw new TypeError('Invalid authority invalidation event id');
}

/** The startup cursor: the table head, where an empty table legitimately reads 0. */
function parseHeadCursor(value: unknown): bigint {
  if (value === 0 || value === '0' || value === 0n) return 0n;
  return parseEventId(value);
}

function parseEvent(row: EventRow): AuthorityInvalidationEvent {
  const id = parseEventId(row.id);
  if (typeof row.tenant_id !== 'string' || !UUID_TEXT.test(row.tenant_id)) {
    throw new TypeError('Invalid authority invalidation event tenant id');
  }
  if (typeof row.kind !== 'string' || !AUTHORITY_INVALIDATION_KIND_SET.has(row.kind)) {
    throw new TypeError('Invalid authority invalidation event kind');
  }
  if (row.reason !== null && typeof row.reason !== 'string') {
    throw new TypeError('Invalid authority invalidation event reason');
  }
  return { id, tenantId: row.tenant_id, kind: row.kind as AuthorityInvalidationKind, reason: row.reason };
}

/** A local cache that can be flushed wholesale by an invalidation event. */
export interface AuthorityInvalidationTarget {
  invalidateAll(): void;
}

export interface AuthorityInvalidationPollerOptions {
  /** Poll cadence in milliseconds; defaults to 500ms. */
  readonly intervalMs?: number;
  /** Maximum events read per poll; defaults to 500. */
  readonly batchLimit?: number;
  /** Error sink for failed polls; a failed tick never throws and is retried on the next tick. */
  readonly onError?: (error: unknown) => void;
  /** Injectable clock-backed scheduler for deterministic tests. */
  readonly schedule?: (callback: () => void, milliseconds: number) => { clear(): void };
}

/**
 * Gateway-side consumer of the invalidation event table. The cursor advances
 * monotonically per process; any newly observed event flushes every
 * registered target (coarse by design — the caches are version-keyed hashes,
 * and over-invalidation only costs a bounded set of re-resolves while a
 * revocation-class event is rare).
 */
export class AuthorityInvalidationPoller {
  private readonly database: SaasDatabase;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly onError?: (error: unknown) => void;
  private readonly scheduleTick: (callback: () => void, milliseconds: number) => { clear(): void };
  private readonly targets = new Set<AuthorityInvalidationTarget>();
  private cursor = 0n;
  private stopped = true;
  private timer: { clear(): void } | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(database: SaasDatabase, options: AuthorityInvalidationPollerOptions = {}) {
    this.database = database;
    this.intervalMs = options.intervalMs ?? 500;
    this.batchLimit = options.batchLimit ?? 500;
    // The video-task recovery worker precedent: a failed background cycle
    // logs a fixed, secret-free line and retries on the next tick.
    this.onError = options.onError ?? (() => console.error('model-router authority invalidation poll failed'));
    this.scheduleTick =
      options.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        // The poller never keeps a process alive on its own; the gateway
        // lifecycle owns explicit start/stop.
        (timer as { unref?: () => void }).unref?.();
        return { clear: () => clearTimeout(timer) };
      });
    for (const bound of [this.intervalMs, this.batchLimit]) {
      if (!Number.isSafeInteger(bound) || bound < 1) {
        throw new RangeError('Invalid authority invalidation poller bounds');
      }
    }
  }

  register(target: AuthorityInvalidationTarget): void {
    this.targets.add(target);
  }

  /** Registered target count; composition tests assert the off-switch registers none. */
  get targetCount(): number {
    return this.targets.size;
  }

  /**
   * Initialize the cursor at the current table head and start polling. A
   * fresh process starts with empty caches, so historical events are
   * deliberately skipped; the defensive flush covers entries registered
   * between construction and start.
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    const head = await this.database.query<{ max_id: unknown }>(
      'SELECT COALESCE(MAX(id), 0) AS max_id FROM saas_authority_invalidation_events',
    );
    this.cursor = parseHeadCursor(head.rows[0]?.max_id ?? 0);
    this.invalidateTargets();
    this.stopped = false;
    this.scheduleNext();
  }

  /** Stop polling and wait for any in-flight tick. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.clear();
    this.timer = undefined;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  /**
   * One poll cycle: read every event after the cursor in id order and flush
   * all registered targets once when anything new arrived. Returns the
   * number of events consumed; exported via the class for CI verification
   * of the invalidation contract.
   */
  async pollOnce(): Promise<number> {
    const result = await this.database.query<EventRow>(
      'SELECT id, tenant_id, kind, reason FROM saas_authority_invalidation_events WHERE id > $1 ORDER BY id ASC LIMIT $2',
      [this.cursor.toString(10), this.batchLimit],
    );
    if (result.rows.length === 0) return 0;
    let highest = this.cursor;
    for (const row of result.rows) {
      const event = parseEvent(row);
      if (event.id > highest) highest = event.id;
    }
    // Advance only after every row parsed cleanly: a malformed batch leaves
    // the cursor untouched so the next poll retries (never skips).
    this.cursor = highest;
    this.invalidateTargets();
    return result.rows.length;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = this.scheduleTick(() => {
      this.inFlight = (async () => {
        try {
          await this.pollOnce();
        } catch (error) {
          // A failed poll never propagates: the next tick retries from the
          // unchanged cursor, so downtime only widens the (bounded) stale
          // window the guard already fails closed on.
          this.onError?.(error);
        }
      })().finally(() => {
        this.inFlight = undefined;
        this.scheduleNext();
      });
    }, this.intervalMs);
  }

  private invalidateTargets(): void {
    for (const target of this.targets) target.invalidateAll();
  }
}
