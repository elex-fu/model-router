import type { SaasDatabase } from '../db/types.js';
import {
  evaluateWindowCostSchedulability,
  getAccountWindowCostFactsBatch,
} from '../gateway/provider-account-window-cost-gate.js';

export interface SchedulingHealthRow {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly providerId: string;
  readonly accountStatus: string;
  readonly validationState: string;
  readonly validationErrorCode: string | null;
  readonly validationCredentialId: string | null;
  readonly windowState: 'admit' | 'sticky_only' | 'paused' | 'off';
  readonly windowFacts: {
    readonly usageMinorUnits: string;
    readonly limitMinorUnits: string;
    readonly reserveMinorUnits: string;
    readonly windowStart: string;
  } | null;
  readonly thresholdPauseUntil: string | null;
  readonly thresholdPauseReason: string | null;
  readonly healthState: string | null;
  readonly healthLastOutcome: string | null;
  readonly healthCooldownUntil: string | null;
  readonly healthObservedAt: string | null;
  readonly quotaObservedAt: string | null;
  readonly quotaFreshness: 'fresh' | 'stale' | 'unobserved';
  readonly probe: {
    readonly lastResult: string | null;
    readonly lastRunAt: string | null;
    readonly nextDueAt: string | null;
    readonly requestedAt: string | null;
  } | null;
}

export interface SchedulingHealthPage {
  readonly snapshotAt: string;
  readonly freshnessThresholdSeconds: number;
  readonly scanned: number;
  readonly limit: number;
  readonly rows: readonly SchedulingHealthRow[];
  /** Counts describe the returned, bounded page. */
  readonly counts: {
    readonly total: number;
    readonly paused: number;
    readonly stickyOnly: number;
    readonly thresholdPaused: number;
    readonly unhealthy: number;
    readonly quotaStale: number;
  };
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Project only the evaluator's safe diagnostic fields. */
function thresholdReason(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = ['code', 'platform', 'window', 'threshold_percent', 'used_percent'] as const;
  const parts = fields.flatMap((key) => {
    const item = record[key];
    return typeof item === 'string' && /^[A-Za-z0-9_.:% -]{1,100}$/.test(item)
      ? [`${key}=${item}`]
      : typeof item === 'number' && Number.isFinite(item)
        ? [`${key}=${item}`]
        : [];
  });
  return parts.length === 0 ? 'account_scheduling_threshold' : parts.join(' · ');
}

/** Shares admission's exact supplier-cost windows, including stored session starts. */
export async function getSchedulingHealthPage(
  database: SaasDatabase,
  query: { readonly limit?: number; readonly onlyConstrained?: boolean } = {},
): Promise<SchedulingHealthPage> {
  const limit = Math.min(Math.max(Number.isSafeInteger(query.limit) ? (query.limit as number) : 50, 1), 200);
  const now = Date.now();
  const freshnessThresholdSeconds = 600;
  const result = await database.query<{
    account_id: string;
    display_name: string;
    provider_id: string;
    status: string;
    validation_state: string;
    validation_error_code: string | null;
    validation_credential_id: string | null;
    threshold_pause_until: Date | string | null;
    threshold_pause_reason: unknown;
    health_state: string | null;
    health_last_outcome: string | null;
    health_cooldown_until: Date | string | null;
    health_observed_at: Date | string | null;
    quota_observed_at: Date | string | null;
    probe_result: string | null;
    probe_run_at: Date | string | null;
    probe_due_at: Date | string | null;
    probe_requested_at: Date | string | null;
    probe_id: string | null;
  }>(
    `SELECT account.id AS account_id, account.display_name, account.provider_id, account.status,
            account.validation_state, account.validation_error_code, validation.credential_id AS validation_credential_id,
            account.scheduling_threshold_pause_until AS threshold_pause_until,
            account.scheduling_threshold_pause_reason AS threshold_pause_reason,
            health.state AS health_state, health.last_outcome AS health_last_outcome,
            health.cooldown_until AS health_cooldown_until, health.observed_at AS health_observed_at,
            greatest(CASE WHEN account.quota_state <> 'unknown' THEN account.quota_checked_at END,
              account.claude_usage_updated_at, account.codex_usage_updated_at,
              account.gemini_usage_updated_at, account.grok_usage_updated_at,
              account.bedrock_usage_updated_at, account.kimi_usage_updated_at,
              account.zhipu_usage_updated_at, account.minimax_usage_updated_at) AS quota_observed_at,
            probe.id AS probe_id, probe.last_result AS probe_result, probe.last_run_at AS probe_run_at,
            probe.next_due_at AS probe_due_at, probe.probe_requested_at
       FROM saas_platform_provider_accounts account
       LEFT JOIN saas_provider_account_runtime_health health
         ON health.owner_scope_key = 'platform' AND health.owner_kind = 'platform' AND health.account_id = account.id
       LEFT JOIN saas_probe_monitors probe
         ON probe.owner_scope_key = 'platform' AND probe.account_id = account.id
       LEFT JOIN LATERAL (SELECT credential_id FROM saas_platform_provider_credential_validation_jobs
         WHERE account_id = account.id ORDER BY created_at DESC LIMIT 1) validation ON true
      WHERE account.revoked_at IS NULL
      ORDER BY (account.scheduling_threshold_pause_until > clock_timestamp()) DESC NULLS LAST,
               (health.state <> 'healthy') DESC NULLS LAST, (account.validation_state = 'failed') DESC,
               (account.window_cost_limit_minor_units IS NOT NULL) DESC, account.id
      LIMIT $1`,
    [limit],
  );
  const facts = await getAccountWindowCostFactsBatch(
    database,
    result.rows.map((row) => row.account_id),
    now,
  );
  const allRows = result.rows.map((row): SchedulingHealthRow => {
    const fact = facts.get(row.account_id);
    const quotaObservedAt = iso(row.quota_observed_at);
    return {
      accountId: row.account_id,
      displayName: row.display_name,
      providerId: row.provider_id,
      accountStatus: row.status,
      validationState: row.validation_state,
      validationErrorCode: row.validation_error_code,
      validationCredentialId: row.validation_credential_id,
      windowState:
        fact === undefined
          ? 'off'
          : evaluateWindowCostSchedulability({ ...fact, usageMinorUnits: fact.usageMinorUnits ?? 0n }),
      windowFacts:
        fact === undefined
          ? null
          : {
              usageMinorUnits: (fact.usageMinorUnits ?? 0n).toString(),
              limitMinorUnits: (fact.limitMinorUnits ?? 0n).toString(),
              reserveMinorUnits: (fact.reserveMinorUnits ?? 0n).toString(),
              windowStart: new Date(fact.windowStartMs).toISOString(),
            },
      thresholdPauseUntil: iso(row.threshold_pause_until),
      thresholdPauseReason: thresholdReason(row.threshold_pause_reason),
      healthState: row.health_state,
      healthLastOutcome: row.health_last_outcome,
      healthCooldownUntil: iso(row.health_cooldown_until),
      healthObservedAt: iso(row.health_observed_at),
      quotaObservedAt,
      quotaFreshness:
        quotaObservedAt === null
          ? 'unobserved'
          : now - Date.parse(quotaObservedAt) > freshnessThresholdSeconds * 1000
            ? 'stale'
            : 'fresh',
      probe:
        row.probe_id === null
          ? null
          : {
              lastResult: row.probe_result,
              lastRunAt: iso(row.probe_run_at),
              nextDueAt: iso(row.probe_due_at),
              requestedAt: iso(row.probe_requested_at),
            },
    };
  });
  const paused = (row: SchedulingHealthRow) =>
    row.thresholdPauseUntil !== null && Date.parse(row.thresholdPauseUntil) > now;
  const unhealthy = (row: SchedulingHealthRow) => row.healthState !== null && row.healthState !== 'healthy';
  const rows = query.onlyConstrained
    ? allRows.filter(
        (row) =>
          row.windowState === 'paused' ||
          row.windowState === 'sticky_only' ||
          paused(row) ||
          unhealthy(row) ||
          row.validationState === 'failed' ||
          row.accountStatus !== 'active',
      )
    : allRows;
  return {
    snapshotAt: new Date(now).toISOString(),
    freshnessThresholdSeconds,
    scanned: allRows.length,
    limit,
    rows,
    counts: {
      total: rows.length,
      paused: rows.filter((row) => row.windowState === 'paused').length,
      stickyOnly: rows.filter((row) => row.windowState === 'sticky_only').length,
      thresholdPaused: rows.filter(paused).length,
      unhealthy: rows.filter(unhealthy).length,
      quotaStale: rows.filter((row) => row.quotaFreshness !== 'fresh').length,
    },
  };
}
