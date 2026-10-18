import type { SaasDatabase } from '../../db/types.js';
import type { VideoBillingSnapshot } from './video-billing.js';
import { VIDEO_TASK_ID_PATTERN, type VideoBillingResolution } from './video-billing.js';
import type { VideoSettlementFacts } from './video-settlement-port.js';

/**
 * Roadmap batch 4 §4.3 (task #17) async video task store — the durable PG
 * row that carries the create-time billing snapshot, the bound-account
 * binding, and the one-shot billing claim (the sub2api Redis
 * pending-billing + billed-claim pair ported to the hosted PG discipline;
 * the #16 image task store is the structural precedent).
 *
 * TTL enforcement is lazy-read plus the purge sweep (24 h, the sub2api
 * pending-billing TTL). No Redis anywhere: the durable row is the store of
 * record.
 */

export type SaasVideoBillingState = 'pending' | 'billed' | 'skipped';

export interface SaasVideoTaskRecord {
  /** The upstream (xAI) request id — the public task id clients poll. */
  readonly requestId: string;
  readonly tenantId: string;
  readonly proxyKeyId: string;
  /** The bound account that accepted the create (status polls replay it). */
  readonly providerAccountId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  /** The create request's gateway identity (deferred settlement anchor). */
  readonly gatewayRequestId: string;
  readonly gatewayAttemptId: string;
  readonly model: string;
  readonly resolution: VideoBillingResolution;
  readonly durationSeconds: number;
  readonly videoCount: number;
  readonly billingState: SaasVideoBillingState;
  readonly billedAt: string | null;
  /**
   * Create-time settlement facts (platform supply; null for BYOK rows).
   * The deferred status-poll settlement re-prices against these frozen
   * admission facts — never a mutable group or price table.
   */
  readonly settlementFacts: VideoSettlementFacts | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type SaasVideoTaskCreateInput = Omit<SaasVideoTaskRecord, 'billingState' | 'billedAt'>;

/**
 * Gap-remediation G-A1 (migration 132): one recovery claim — the task record
 * plus the recovery columns the worker needs to classify, back off and renew
 * its lease. Returned by `claimRecoveryBatch` from the atomic claim UPDATE.
 */
export interface SaasVideoTaskRecoveryClaim {
  readonly record: SaasVideoTaskRecord;
  /** The lease epoch this claim bumped to — every outcome write must match it. */
  readonly leaseEpoch: number;
  /** The poll-failure count at claim time (six-class counter, cap-escalated). */
  readonly pollFailures: number;
}

export interface SaasVideoTaskRecoveryClaimInput {
  /** The claiming worker instance id (lease owner fencing). */
  readonly owner: string;
  readonly limit: number;
  /** Lease lifetime in ms; the claim sets lease_until = now + leaseMs. */
  readonly leaseMs: number;
  readonly now: string;
}

export interface SaasVideoTaskRecoveryOutcomeInput {
  readonly requestId: string;
  readonly owner: string;
  readonly epoch: number;
  /**
   * The next due time. A terminal outcome (billed/skipped by the billing
   * state machine) can pass a far-future cursor — the pending-only claim
   * query stops picking the row anyway once billing_state is terminal.
   */
  readonly nextPollAt: string;
  /** Reset the failure counter (a successful poll) instead of a delta bump. */
  readonly resetFailures: boolean;
  readonly failureDelta: number;
}

export interface SaasVideoTaskStore {
  /** Registers one accepted create; a duplicate id is a closed failure. */
  create(record: SaasVideoTaskCreateInput): Promise<void>;
  /** Reads one task for the owner; expired rows read as absent. */
  get(requestId: string): Promise<SaasVideoTaskRecord | null>;
  /**
   * The one-shot billing claim: atomically pending → billed. Returns the
   * claimed record, or null when the task is absent, already billed or
   * skipped (sub2api ClaimGrokVideoBilling — fail-closed on claim errors
   * is the caller treating null as already-billed).
   */
  claimBilling(requestId: string): Promise<SaasVideoTaskRecord | null>;
  /**
   * Releases the claim after a failed durable settlement so a later poll
   * can retry billing (sub2api ReleaseGrokVideoBilling). Returns false
   * when the task is absent or not in the claimed (billed) state.
   */
  releaseBilling(requestId: string): Promise<boolean>;
  /**
   * Fail-closed terminal skip: the pending snapshot is missing or the
   * observation cannot be priced — the task is never billed at a guessed
   * default (task #17: 绝不按默认低价计).
   */
  markSkipped(requestId: string): Promise<boolean>;
  /**
   * G-A1 recovery claim: atomically leases up to `limit` pending rows whose
   * `next_poll_at` is due and whose lease is free or expired. Each claim
   * bumps `lease_epoch` — a zombie worker whose lease expired mid-flight
   * can never overwrite a newer owner's outcome (every outcome write carries
   * owner + epoch in its WHERE).
   */
  claimRecoveryBatch(input: SaasVideoTaskRecoveryClaimInput): Promise<SaasVideoTaskRecoveryClaim[]>;
  /** Extends the caller's lease (owner + epoch fenced); false = lease lost. */
  renewRecoveryLease(requestId: string, owner: string, epoch: number, leaseMs: number): Promise<boolean>;
  /**
   * Releases the lease and records the poll outcome: the next due time plus
   * either a failure-count bump or a reset. Owner + epoch fenced so a stale
   * worker's write is a no-op.
   */
  recordRecoveryOutcome(input: SaasVideoTaskRecoveryOutcomeInput): Promise<boolean>;
  /** Deletes rows past their TTL; returns the number removed. */
  purgeExpired(now: string): Promise<number>;
}

export class SaasVideoTaskStoreError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'SaasVideoTaskStoreError';
  }
}

interface VideoTaskRow {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly proxy_key_id: string;
  readonly provider_account_id: string;
  readonly credential_id: string;
  readonly credential_version: string;
  readonly gateway_request_id: string;
  readonly gateway_attempt_id: string;
  readonly model: string;
  readonly resolution: string;
  readonly duration_seconds: number;
  readonly video_count: number;
  readonly billing_state: string;
  readonly billed_at: Date | string | null;
  readonly settlement_facts: unknown;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
}

interface VideoTaskRecoveryRow extends VideoTaskRow {
  readonly lease_epoch: number | string;
  readonly poll_failures: number | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToRecord(row: VideoTaskRow): SaasVideoTaskRecord {
  const state = row.billing_state;
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    proxyKeyId: row.proxy_key_id,
    providerAccountId: row.provider_account_id,
    credentialId: row.credential_id,
    credentialVersion: row.credential_version,
    gatewayRequestId: row.gateway_request_id,
    gatewayAttemptId: row.gateway_attempt_id,
    model: row.model,
    resolution: row.resolution as VideoBillingResolution satisfies VideoBillingResolution,
    durationSeconds: row.duration_seconds,
    videoCount: row.video_count,
    billingState: (state === 'billed' || state === 'skipped' ? state : 'pending') as SaasVideoBillingState,
    billedAt: row.billed_at === null ? null : iso(row.billed_at),
    settlementFacts: parseSettlementFacts(row.settlement_facts),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

function parseSettlementFacts(value: unknown): VideoSettlementFacts | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const customerPriceVersion = record.customerPriceVersion;
  const priceSnapshotRef = record.priceSnapshotRef;
  const currency = record.currency;
  if (typeof customerPriceVersion !== 'string' || customerPriceVersion.trim() === '') return null;
  if (typeof priceSnapshotRef !== 'string' || priceSnapshotRef.trim() === '') return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  return { customerPriceVersion, priceSnapshotRef, currency };
}

function validSnapshotShape(snapshot: VideoBillingSnapshot): boolean {
  return (
    typeof snapshot.model === 'string' &&
    snapshot.model.trim() !== '' &&
    typeof snapshot.resolution === 'string' &&
    ['480p', '720p', '1080p'].includes(snapshot.resolution) &&
    Number.isSafeInteger(snapshot.durationSeconds) &&
    snapshot.durationSeconds >= 1 &&
    snapshot.durationSeconds <= 15 &&
    Number.isSafeInteger(snapshot.videoCount) &&
    snapshot.videoCount >= 1 &&
    snapshot.videoCount <= 10
  );
}

function validCreateInput(record: SaasVideoTaskCreateInput): boolean {
  if (!record || typeof record !== 'object') return false;
  if (!VIDEO_TASK_ID_PATTERN.test(record.requestId)) return false;
  for (const field of [
    'tenantId',
    'proxyKeyId',
    'providerAccountId',
    'credentialId',
    'credentialVersion',
    'gatewayRequestId',
    'gatewayAttemptId',
  ] as const) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim() === '') return false;
  }
  if (!validSnapshotShape(record)) return false;
  if (record.settlementFacts !== null) {
    const facts = record.settlementFacts;
    if (
      typeof facts.customerPriceVersion !== 'string' ||
      facts.customerPriceVersion.trim() === '' ||
      typeof facts.priceSnapshotRef !== 'string' ||
      facts.priceSnapshotRef.trim() === '' ||
      typeof facts.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(facts.currency)
    ) {
      return false;
    }
  }
  return (
    !Number.isNaN(Date.parse(record.createdAt)) &&
    !Number.isNaN(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) > Date.parse(record.createdAt)
  );
}

/**
 * The production PostgreSQL store. The one-shot claim is a single atomic
 * `UPDATE ... WHERE billing_state = 'pending'` — concurrent polls cannot
 * both win. Every statement is parameterized.
 */
export class PostgresVideoTaskStore implements SaasVideoTaskStore {
  constructor(private readonly database: SaasDatabase) {
    if (!database || typeof database.query !== 'function') {
      throw new SaasVideoTaskStoreError('INVALID_INPUT', 'video task store requires a database');
    }
  }

  async create(record: SaasVideoTaskCreateInput): Promise<void> {
    if (!validCreateInput(record)) {
      throw new SaasVideoTaskStoreError('INVALID_INPUT', 'video task record is invalid');
    }
    await this.database.query(
      `INSERT INTO saas_video_tasks
         (request_id, tenant_id, proxy_key_id, provider_account_id, credential_id, credential_version,
          gateway_request_id, gateway_attempt_id, model, resolution, duration_seconds, video_count,
          billing_state, settlement_facts, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $15)`,
      [
        record.requestId,
        record.tenantId,
        record.proxyKeyId,
        record.providerAccountId,
        record.credentialId,
        record.credentialVersion,
        record.gatewayRequestId,
        record.gatewayAttemptId,
        record.model,
        record.resolution,
        record.durationSeconds,
        record.videoCount,
        record.settlementFacts === null
          ? null
          : JSON.stringify({
              customerPriceVersion: record.settlementFacts.customerPriceVersion,
              priceSnapshotRef: record.settlementFacts.priceSnapshotRef,
              currency: record.settlementFacts.currency,
            }),
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  async get(requestId: string): Promise<SaasVideoTaskRecord | null> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return null;
    const result = await this.database.query<VideoTaskRow>(
      `SELECT request_id, tenant_id, proxy_key_id, provider_account_id, credential_id, credential_version,
              gateway_request_id, gateway_attempt_id, model, resolution, duration_seconds, video_count,
              billing_state, billed_at, settlement_facts, created_at, expires_at
         FROM saas_video_tasks
        WHERE request_id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const record = rowToRecord(row);
    // Lazy TTL: an expired task reads as absent (the poll surface 404s).
    if (Date.parse(record.expiresAt) <= Date.now()) return null;
    return record;
  }

  async claimBilling(requestId: string): Promise<SaasVideoTaskRecord | null> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return null;
    const result = await this.database.query<VideoTaskRow>(
      `UPDATE saas_video_tasks
          SET billing_state = 'billed', billed_at = now()
        WHERE request_id = $1 AND billing_state = 'pending'
        RETURNING request_id, tenant_id, proxy_key_id, provider_account_id, credential_id, credential_version,
                  gateway_request_id, gateway_attempt_id, model, resolution, duration_seconds, video_count,
                  billing_state, billed_at, settlement_facts, created_at, expires_at`,
      [requestId],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async releaseBilling(requestId: string): Promise<boolean> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return false;
    const result = await this.database.query(
      `UPDATE saas_video_tasks
          SET billing_state = 'pending', billed_at = NULL
        WHERE request_id = $1 AND billing_state = 'billed'`,
      [requestId],
    );
    return result.rowCount === 1;
  }

  async markSkipped(requestId: string): Promise<boolean> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return false;
    const result = await this.database.query(
      `UPDATE saas_video_tasks
          SET billing_state = 'skipped'
        WHERE request_id = $1 AND billing_state = 'pending'`,
      [requestId],
    );
    return result.rowCount === 1;
  }

  async purgeExpired(now: string): Promise<number> {
    const result = await this.database.query(`DELETE FROM saas_video_tasks WHERE expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }

  async claimRecoveryBatch(input: SaasVideoTaskRecoveryClaimInput): Promise<SaasVideoTaskRecoveryClaim[]> {
    if (
      typeof input.owner !== 'string' ||
      input.owner.trim() === '' ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1 ||
      Number.isNaN(Date.parse(input.now))
    ) {
      throw new SaasVideoTaskStoreError('INVALID_INPUT', 'video recovery claim input is invalid');
    }
    // The atomic lease claim: pending + due + lease-free rows move to this
    // owner with a bumped epoch in ONE statement, so concurrent workers
    // can never double-claim (the new-api CAS-winner discipline).
    const result = await this.database.query<VideoTaskRecoveryRow>(
      `UPDATE saas_video_tasks
          SET lease_owner = $1,
              lease_epoch = lease_epoch + 1,
              lease_until = $2::timestamptz + ($3::bigint * interval '1 millisecond'),
              next_poll_at = $2::timestamptz + ($3::bigint * interval '1 millisecond')
        WHERE request_id IN (
          SELECT request_id
            FROM saas_video_tasks
           WHERE billing_state = 'pending'
             AND next_poll_at <= $2::timestamptz
             AND expires_at > $2::timestamptz
             AND (lease_until IS NULL OR lease_until < $2::timestamptz)
           ORDER BY next_poll_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING request_id, tenant_id, proxy_key_id, provider_account_id, credential_id, credential_version,
                  gateway_request_id, gateway_attempt_id, model, resolution, duration_seconds, video_count,
                  billing_state, billed_at, settlement_facts, created_at, expires_at, lease_epoch, poll_failures`,
      [input.owner, input.now, input.leaseMs, input.limit],
    );
    return result.rows.map((row) => ({
      record: rowToRecord(row),
      leaseEpoch: Number(row.lease_epoch),
      pollFailures: Number(row.poll_failures),
    }));
  }

  async renewRecoveryLease(requestId: string, owner: string, epoch: number, leaseMs: number): Promise<boolean> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return false;
    if (typeof owner !== 'string' || owner.trim() === '' || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) return false;
    const result = await this.database.query(
      `UPDATE saas_video_tasks
          SET lease_until = now() + ($3::bigint * interval '1 millisecond')
        WHERE request_id = $1 AND lease_owner = $2 AND lease_epoch = $4 AND billing_state = 'pending'`,
      [requestId, owner, leaseMs, epoch],
    );
    return result.rowCount === 1;
  }

  async recordRecoveryOutcome(input: SaasVideoTaskRecoveryOutcomeInput): Promise<boolean> {
    if (!VIDEO_TASK_ID_PATTERN.test(input.requestId)) return false;
    if (typeof input.owner !== 'string' || input.owner.trim() === '') return false;
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) return false;
    if (Number.isNaN(Date.parse(input.nextPollAt))) return false;
    if (!Number.isSafeInteger(input.failureDelta) || input.failureDelta < 0) return false;
    const result = await this.database.query(
      `UPDATE saas_video_tasks
          SET lease_owner = NULL,
              lease_until = NULL,
              next_poll_at = $4::timestamptz,
              poll_failures = CASE WHEN $5 THEN 0 ELSE poll_failures + $6::int END
        WHERE request_id = $1 AND lease_owner = $2 AND lease_epoch = $3`,
      [input.requestId, input.owner, input.epoch, input.nextPollAt, input.resetFailures, input.failureDelta],
    );
    return result.rowCount === 1;
  }
}

/**
 * The in-memory store for unit tests and single-process dev wiring. The
 * claim/release transitions are single-threaded here; the production
 * atomicity lives in the Postgres UPDATE ... WHERE above.
 */
export interface InMemoryVideoTaskStoreOptions {
  readonly now?: () => number;
}

export class InMemoryVideoTaskStore implements SaasVideoTaskStore {
  private readonly records = new Map<string, SaasVideoTaskRecord>();
  private readonly now: () => number;
  /** G-A1 recovery columns (migration 132 mirrors; single-threaded here). */
  private readonly recovery = new Map<
    string,
    {
      leaseOwner: string | null;
      leaseEpoch: number;
      leaseUntil: number | null;
      nextPollAt: number;
      pollFailures: number;
    }
  >();

  constructor(options: InMemoryVideoTaskStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private recoveryState(requestId: string): {
    leaseOwner: string | null;
    leaseEpoch: number;
    leaseUntil: number | null;
    nextPollAt: number;
    pollFailures: number;
  } {
    let state = this.recovery.get(requestId);
    if (state === undefined) {
      state = { leaseOwner: null, leaseEpoch: 0, leaseUntil: null, nextPollAt: 0, pollFailures: 0 };
      this.recovery.set(requestId, state);
    }
    return state;
  }

  async create(record: SaasVideoTaskCreateInput): Promise<void> {
    if (!validCreateInput(record)) {
      throw new SaasVideoTaskStoreError('INVALID_INPUT', 'video task record is invalid');
    }
    if (this.records.has(record.requestId)) {
      throw new SaasVideoTaskStoreError('UNAVAILABLE', 'video task id already exists');
    }
    this.records.set(record.requestId, { ...record, billingState: 'pending', billedAt: null });
  }

  async get(requestId: string): Promise<SaasVideoTaskRecord | null> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return null;
    const record = this.records.get(requestId) ?? null;
    if (record === null) return null;
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.records.delete(requestId);
      return null;
    }
    return { ...record };
  }

  async claimBilling(requestId: string): Promise<SaasVideoTaskRecord | null> {
    const record = this.records.get(requestId) ?? null;
    if (record === null) return null;
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.records.delete(requestId);
      return null;
    }
    if (record.billingState !== 'pending') return null;
    const claimed: SaasVideoTaskRecord = {
      ...record,
      billingState: 'billed',
      billedAt: new Date(this.now()).toISOString(),
    };
    this.records.set(requestId, claimed);
    return { ...claimed };
  }

  async releaseBilling(requestId: string): Promise<boolean> {
    const record = this.records.get(requestId) ?? null;
    if (record === null || record.billingState !== 'billed') return false;
    this.records.set(requestId, { ...record, billingState: 'pending', billedAt: null });
    return true;
  }

  async markSkipped(requestId: string): Promise<boolean> {
    const record = this.records.get(requestId) ?? null;
    if (record === null || record.billingState !== 'pending') return false;
    this.records.set(requestId, { ...record, billingState: 'skipped', billedAt: null });
    return true;
  }

  async purgeExpired(now: string): Promise<number> {
    const cutoff = Date.parse(now);
    let removed = 0;
    for (const [id, record] of this.records) {
      if (Date.parse(record.expiresAt) <= cutoff) {
        this.records.delete(id);
        this.recovery.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async claimRecoveryBatch(input: SaasVideoTaskRecoveryClaimInput): Promise<SaasVideoTaskRecoveryClaim[]> {
    if (
      typeof input.owner !== 'string' ||
      input.owner.trim() === '' ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1 ||
      Number.isNaN(Date.parse(input.now))
    ) {
      throw new SaasVideoTaskStoreError('INVALID_INPUT', 'video recovery claim input is invalid');
    }
    const nowMs = Date.parse(input.now);
    const claims: SaasVideoTaskRecoveryClaim[] = [];
    const candidates = [...this.records.entries()]
      .filter(([, record]) => record.billingState === 'pending' && Date.parse(record.expiresAt) > nowMs)
      .map(([id, record]) => ({ id, record, state: this.recoveryState(id) }))
      .filter(({ state }) => state.nextPollAt <= nowMs && (state.leaseUntil === null || state.leaseUntil < nowMs))
      .sort((a, b) => a.state.nextPollAt - b.state.nextPollAt);
    for (const candidate of candidates) {
      if (claims.length >= input.limit) break;
      candidate.state.leaseOwner = input.owner;
      candidate.state.leaseEpoch += 1;
      candidate.state.leaseUntil = nowMs + input.leaseMs;
      candidate.state.nextPollAt = nowMs + input.leaseMs;
      claims.push({
        record: { ...candidate.record },
        leaseEpoch: candidate.state.leaseEpoch,
        pollFailures: candidate.state.pollFailures,
      });
    }
    return claims;
  }

  async renewRecoveryLease(requestId: string, owner: string, epoch: number, leaseMs: number): Promise<boolean> {
    if (!VIDEO_TASK_ID_PATTERN.test(requestId)) return false;
    const record = this.records.get(requestId);
    if (record === undefined || record.billingState !== 'pending') return false;
    const state = this.recoveryState(requestId);
    if (state.leaseOwner !== owner || state.leaseEpoch !== epoch) return false;
    state.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async recordRecoveryOutcome(input: SaasVideoTaskRecoveryOutcomeInput): Promise<boolean> {
    if (!VIDEO_TASK_ID_PATTERN.test(input.requestId)) return false;
    const state = this.recovery.get(input.requestId);
    if (state === undefined || state.leaseOwner !== input.owner || state.leaseEpoch !== input.epoch) return false;
    state.leaseOwner = null;
    state.leaseUntil = null;
    state.nextPollAt = Date.parse(input.nextPollAt);
    state.pollFailures = input.resetFailures ? 0 : state.pollFailures + input.failureDelta;
    return true;
  }
}
