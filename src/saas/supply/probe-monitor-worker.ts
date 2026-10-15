import { randomUUID } from 'node:crypto';
import type { ProviderCredentialUnsealingKms } from '../credentials/provider-crypto.js';
import type { SaasDatabase } from '../db/types.js';
import {
  type AccountProbeCategory,
  type AccountProbeOutcome,
  type AccountProbeService,
  createAccountProbeService,
} from './account-probe-service.js';

/**
 * R6a scheduled probe monitors (docs/token-resale-implementation-plan-2026-10-15.md
 * §R6a, task #32; migration 109): the probe-monitor worker plus the
 * control-plane run-retention loop.
 *
 * Worker placement: the credential-validation-worker workload, exactly like
 * the R3 egress-proxy probe worker — it is the only non-gateway runtime with
 * a credential decrypt KMS and the credential-version read grants the probe
 * service needs. Its grants live in
 * deploy/managed-saas-validation-worker-role-grants.sql; the control-plane
 * role owns the monitor registry CRUD (the admin trigger/list surface).
 *
 * Claim/lease semantics (the repo convention — quota-sync, oauth-refresh,
 * R3 proxy probe): one monitor is claimed, probed and written in ONE
 * transaction. The claim is SELECT ... FOR UPDATE SKIP LOCKED, so replicas
 * never wait on each other, a crash rolls the probe back and leaves the
 * monitor due (natural requeue), and the row lock held across the bounded
 * probe is the lease — there are no lease columns to expire. The in-flight
 * dedup IS the row lock.
 *
 * Auto-unschedule semantics (sub2api/new-api AutoBan parity):
 * - every non-ok result increments consecutive_failures; crossing
 *   failure_threshold sets probe_temp_unschedulable_until on the account row
 *   (re-armed on every further failing probe; the horizon bounds a monitor
 *   that an operator disabled, the streak itself is unbounded while enabled);
 * - recovery is probe-success ONLY — a successful probe clears the signal;
 *   user-request success never does (burning user requests as probes is the
 *   sub2api/new-api lesson; new-api's 3→1 auto-recovery equivalent).
 * - both transitions emit a best-effort saas_audit_events alert row (the R3
 *   sweep-audit precedent; the 103 alert-rule evaluator is rule-metric
 *   driven and has no probe dimension — extending ALERT_METRIC_NAMES is a
 *   separate, data-backed change).
 *
 * Scheduling consumption (R7 integration point, documented): the scheduler
 * (postgres-provider-account-scheduler.ts) does not yet read
 * probe_temp_unschedulable_until — the column follows the 099/100/108
 * scheduling-signal precedent (NULL = pre-R6 behavior) and the eligibility
 * predicate is the R7 workstream's to add.
 *
 * Retention: saas_probe_runs keeps 30 days. The DELETE runs on the
 * control-plane role (startProbeRunRetentionWorker below) because the
 * validation-worker role holds no table-level grants by contract — the
 * worker runtime appends history, the control plane prunes it.
 */

export interface ProbeMonitorRecord {
  readonly id: string;
  readonly ownerKind: 'tenant' | 'platform';
  readonly ownerTenantId: string | null;
  readonly accountId: string;
  readonly category: AccountProbeCategory;
  readonly probeIntervalSeconds: number;
  readonly challengePrompt: string;
  readonly challengeAnswer: string;
  readonly failureThreshold: number;
  readonly consecutiveFailures: number;
}

export interface ProbeMonitorClaimedRun {
  readonly monitor: ProbeMonitorRecord;
  readonly triggeredBy: 'manual' | 'scheduled';
  readonly outcome: AccountProbeOutcome;
}

export class ProbeMonitorWorkerError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'INVALID_INPUT') {
    super(
      code === 'STORE_UNAVAILABLE'
        ? 'the probe monitor store is unavailable'
        : 'invalid probe monitor worker configuration',
    );
    this.name = 'ProbeMonitorWorkerError';
  }
}

const AUDIT_ENTRY_POINT = 'probe-monitor-worker';
const PROBE_ROUND_CAP = 10;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 3_600_000;
const DEFAULT_UNSCHEDULE_HORIZON_MS = 24 * 60 * 60_000;
const RETENTION_DAYS = 30;
const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60_000;

const ACCOUNT_TABLES = Object.freeze({
  tenant: 'saas_tenant_provider_accounts',
  platform: 'saas_platform_provider_accounts',
} as const);

interface MonitorRow {
  readonly id: unknown;
  readonly owner_kind: unknown;
  readonly owner_tenant_id: unknown;
  readonly account_id: unknown;
  readonly provider_category: unknown;
  readonly probe_interval_seconds: unknown;
  readonly challenge_prompt: unknown;
  readonly challenge_answer: unknown;
  readonly failure_threshold: unknown;
  readonly consecutive_failures: unknown;
  readonly probe_requested_at: unknown;
}

function safeText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function safeInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function mapMonitorRow(row: MonitorRow): ProbeMonitorRecord | null {
  const id = safeText(row.id);
  const accountId = safeText(row.account_id);
  const prompt = safeText(row.challenge_prompt);
  const answer = safeText(row.challenge_answer);
  const category = safeText(row.provider_category);
  const interval = safeInteger(row.probe_interval_seconds, 60, 86_400);
  const threshold = safeInteger(row.failure_threshold, 1, 10);
  const failures = safeInteger(row.consecutive_failures, 0, 1_000_000);
  if (
    id === null ||
    accountId === null ||
    prompt === null ||
    answer === null ||
    interval === null ||
    threshold === null ||
    failures === null ||
    (category !== 'claude' && category !== 'codex' && category !== 'opencode-go' && category !== 'api-key')
  ) {
    return null;
  }
  if (row.owner_kind === 'tenant') {
    const tenantId = safeText(row.owner_tenant_id);
    if (tenantId === null) return null;
    return {
      id,
      ownerKind: 'tenant',
      ownerTenantId: tenantId,
      accountId,
      category,
      probeIntervalSeconds: interval,
      challengePrompt: prompt,
      challengeAnswer: answer,
      failureThreshold: threshold,
      consecutiveFailures: failures,
    };
  }
  if (row.owner_kind !== 'platform') return null;
  return {
    id,
    ownerKind: 'platform',
    ownerTenantId: null,
    accountId,
    category,
    probeIntervalSeconds: interval,
    challengePrompt: prompt,
    challengeAnswer: answer,
    failureThreshold: threshold,
    consecutiveFailures: failures,
  };
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return safeInteger(value, min, max) ?? fallback;
}

/** Bounded, body-free run detail (the 109 CHECK pins the no-body shape). */
export function buildProbeRunDetail(outcome: AccountProbeOutcome): string {
  const detail: Record<string, unknown> = {};
  if (outcome.resetAt !== null) detail.resetAt = outcome.resetAt;
  if (outcome.reason !== null) detail.reason = outcome.reason;
  if (outcome.usage !== null) {
    detail.probeUsage = { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens };
  }
  return JSON.stringify(detail);
}

export interface PostgresProbeMonitorStoreOptions {
  readonly deployment: string;
  readonly environment: string;
  readonly probe?: AccountProbeService;
  readonly unscheduleHorizonMs?: number;
  readonly signal?: AbortSignal;
}

export class PostgresProbeMonitorStore {
  private readonly probe: AccountProbeService;
  private readonly unscheduleHorizonMs: number;

  constructor(
    private readonly database: SaasDatabase,
    kms: ProviderCredentialUnsealingKms,
    options: PostgresProbeMonitorStoreOptions,
  ) {
    if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
      throw new ProbeMonitorWorkerError('STORE_UNAVAILABLE');
    }
    if (!kms || typeof kms.decryptDataKey !== 'function') throw new ProbeMonitorWorkerError('STORE_UNAVAILABLE');
    if (!options || typeof options !== 'object') throw new ProbeMonitorWorkerError('INVALID_INPUT');
    this.probe =
      options.probe ??
      createAccountProbeService(database, kms, {
        deployment: options.deployment,
        environment: options.environment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    this.unscheduleHorizonMs = boundedInteger(
      options.unscheduleHorizonMs,
      60_000,
      30 * 24 * 60 * 60_000,
      DEFAULT_UNSCHEDULE_HORIZON_MS,
    );
  }

  /**
   * Claims one due monitor and runs its probe inside the claim transaction
   * (the SKIP LOCKED row lock is the lease). Returns null when nothing is
   * due. Never throws for a probe-level failure — the failure IS the result.
   */
  async claimAndProbeNext(): Promise<ProbeMonitorClaimedRun | null> {
    const duePredicate = `
       AND enabled
       AND (next_due_at IS NULL OR next_due_at <= clock_timestamp())`;
    return this.database.transaction(async (tx) => {
      const candidates = await tx.query<{ readonly id: unknown }>(
        `SELECT id FROM saas_probe_monitors WHERE TRUE${duePredicate}
          ORDER BY next_due_at ASC NULLS FIRST, id LIMIT 1`,
      );
      const candidate = candidates.rows[0];
      if (candidate === undefined) return null;
      const locked = await tx.query<MonitorRow>(
        `SELECT id, owner_kind, owner_tenant_id, account_id, provider_category,
                probe_interval_seconds, challenge_prompt, challenge_answer,
                failure_threshold, consecutive_failures, probe_requested_at
           FROM saas_probe_monitors
          WHERE id = $1${duePredicate}
          FOR UPDATE SKIP LOCKED`,
        [candidate.id],
      );
      const row = locked.rows[0];
      if (row === undefined) return null;
      const monitor = mapMonitorRow(row);
      if (monitor === null) return null;
      const triggeredBy: 'manual' | 'scheduled' = row.probe_requested_at === null ? 'scheduled' : 'manual';

      const outcome = await this.probe.probe({
        ownerKind: monitor.ownerKind,
        tenantId: monitor.ownerTenantId,
        accountId: monitor.accountId,
        category: monitor.category,
        challengePrompt: monitor.challengePrompt,
        challengeAnswer: monitor.challengeAnswer,
      });

      const runId = randomUUID();
      await tx.query(
        `INSERT INTO saas_probe_runs
           (id, monitor_id, triggered_by, result, detail, http_status, latency_ms, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, clock_timestamp())`,
        [
          runId,
          monitor.id,
          triggeredBy,
          outcome.category,
          buildProbeRunDetail(outcome),
          outcome.httpStatus,
          outcome.latencyMs,
        ],
      );

      const consecutive = outcome.category === 'ok' ? 0 : monitor.consecutiveFailures + 1;
      await tx.query(
        `UPDATE saas_probe_monitors
            SET consecutive_failures = $2,
                last_result = $3,
                last_result_detail = $4::jsonb,
                last_run_at = clock_timestamp(),
                next_due_at = clock_timestamp() + ($5 * interval '1 second'),
                probe_requested_at = NULL,
                updated_at = clock_timestamp()
          WHERE id = $1 AND enabled`,
        [monitor.id, consecutive, outcome.category, buildProbeRunDetail(outcome), monitor.probeIntervalSeconds],
      );

      await this.applyAccountSignal(tx, monitor, outcome, consecutive);
      return { monitor, triggeredBy, outcome };
    });
  }

  /**
   * The probe-derived unschedulable signal on the account row. Recovery is
   * probe-success-only; the horizon is re-armed by every further failing
   * probe while the monitor stays enabled.
   */
  private async applyAccountSignal(
    tx: { query: SaasDatabase['query'] },
    monitor: ProbeMonitorRecord,
    outcome: AccountProbeOutcome,
    consecutive: number,
  ): Promise<void> {
    const table = ACCOUNT_TABLES[monitor.ownerKind];
    const identity = monitor.ownerKind === 'tenant' ? 'tenant_id = $1 AND id = $2' : 'id = $1';
    const values = monitor.ownerKind === 'tenant' ? [monitor.ownerTenantId, monitor.accountId] : [monitor.accountId];
    const valueOffset = values.length;
    if (outcome.category === 'ok') {
      const cleared = await tx.query<{ readonly id: unknown }>(
        `UPDATE ${table}
            SET probe_temp_unschedulable_until = NULL
          WHERE ${identity}
            AND probe_temp_unschedulable_until IS NOT NULL
          RETURNING id`,
        values,
      );
      if (cleared.rows.length > 0) {
        await this.appendAuditEvent(tx, monitor, 'saas_probe_monitor.account_recovered');
      }
      return;
    }
    if (consecutive < monitor.failureThreshold) return;
    const armed = await tx.query<{ readonly id: unknown }>(
      `UPDATE ${table}
          SET probe_temp_unschedulable_until = clock_timestamp() + ($${valueOffset + 1} * interval '1 millisecond')
        WHERE ${identity}
          AND (probe_temp_unschedulable_until IS NULL
               OR probe_temp_unschedulable_until <= clock_timestamp())
        RETURNING id`,
      [...values, this.unscheduleHorizonMs],
    );
    if (armed.rows.length > 0) {
      await this.appendAuditEvent(tx, monitor, 'saas_probe_monitor.account_unscheduled');
    }
  }

  /** Best-effort alert record (R3 sweep-audit precedent); never throws. */
  private async appendAuditEvent(
    tx: { query: SaasDatabase['query'] },
    monitor: ProbeMonitorRecord,
    action: string,
  ): Promise<void> {
    await tx
      .query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
         VALUES ($1, $2, NULL, $3, 'saas_probe_monitors', $4, clock_timestamp(), $5)`,
        [randomUUID(), monitor.ownerTenantId, action, monitor.id, AUDIT_ENTRY_POINT],
      )
      .catch(() => undefined);
  }
}

export interface ProbeMonitorWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly onError?: (code: 'cycle_failed') => void;
}

export interface ProbeMonitorWorkerHandle {
  close(): Promise<void>;
}

export class ProbeMonitorWorker {
  private readonly pollIntervalMs: number;
  private readonly onError: ((code: 'cycle_failed') => void) | undefined;

  constructor(
    private readonly store: PostgresProbeMonitorStore,
    options: ProbeMonitorWorkerOptions = {},
  ) {
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.onError = options.onError;
  }

  /** One bounded probe round; returns the number of monitors probed. */
  async runOnce(): Promise<number> {
    let probed = 0;
    for (let index = 0; index < PROBE_ROUND_CAP; index += 1) {
      const run = await this.store.claimAndProbeNext();
      if (run === null) break;
      probed += 1;
    }
    return probed;
  }

  async run(closed: () => boolean, delay: (durationMs: number) => Promise<void>): Promise<void> {
    // The first round waits one poll interval (the channel-status worker
    // convention): due monitors are watermark-driven, so a short startup
    // delay costs nothing while keeping eager SQL off process bootstrap.
    await delay(this.pollIntervalMs);
    while (!closed()) {
      try {
        await this.runOnce();
      } catch {
        // Per-monitor probe failures never reach here (they are results);
        // only storage-level cycle failures do.
        this.onError?.('cycle_failed');
      }
      if (closed()) break;
      await delay(this.pollIntervalMs);
    }
  }
}

export function startProbeMonitorWorker(
  store: PostgresProbeMonitorStore,
  options: ProbeMonitorWorkerOptions = {},
): ProbeMonitorWorkerHandle {
  const worker = new ProbeMonitorWorker(store, options);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const closed = (): boolean => stopped;
  // A delay entered after close() resolves immediately: close() can fire
  // while a cycle body is in flight, and the loop must not park on a fresh
  // interval nobody can cancel (close already ran clearTimeout).
  const delay = (durationMs: number): Promise<void> => {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  };
  const loop = worker.run(closed, delay);
  return {
    async close() {
      if (stopped) return loop;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await loop;
    },
  };
}

/**
 * The control-plane run-retention loop: prunes saas_probe_runs older than
 * the 30-day window. Runs on the control-plane role (which holds the DELETE
 * grant) next to the observability workers; the validation-worker role
 * holds no table-level grants by contract.
 */
export async function pruneExpiredProbeRuns(database: SaasDatabase): Promise<number> {
  const result = await database.query<{ readonly id: unknown }>(
    `DELETE FROM saas_probe_runs
      WHERE created_at < clock_timestamp() - ($1 * interval '1 day')
      RETURNING id`,
    [RETENTION_DAYS],
  );
  return result.rows.length;
}

export function startProbeRunRetentionWorker(
  database: SaasDatabase,
  options: ProbeMonitorWorkerOptions = {},
): ProbeMonitorWorkerHandle {
  const intervalMs = boundedInteger(
    options.pollIntervalMs,
    MIN_POLL_INTERVAL_MS,
    7 * 24 * 60 * 60_000,
    DEFAULT_RETENTION_INTERVAL_MS,
  );
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  // Same close-race hardening as startProbeMonitorWorker above.
  const delay = (durationMs: number): Promise<void> => {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  };
  const loop = (async () => {
    // The first prune waits one interval: retention is not urgent and eager
    // DELETEs must stay off process bootstrap (the channel-status worker
    // convention).
    await delay(intervalMs);
    while (!stopped) {
      try {
        await pruneExpiredProbeRuns(database);
      } catch {
        options.onError?.('cycle_failed');
      }
      if (stopped) break;
      await delay(intervalMs);
    }
  })();
  return {
    async close() {
      if (stopped) return loop;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await loop;
    },
  };
}
