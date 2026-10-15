import type { SaasDatabase } from '../db/types.js';

/**
 * Phase 3 observability: passive channel status aggregation (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 3).
 *
 * A single-leader worker folds saas_attempts/saas_requests facts into the
 * migration-102 tables. Leadership reuses the repo's SKIP LOCKED row-lease
 * pattern (the 093 quota-sync-worker precedent): the watermark row is locked
 * FOR UPDATE SKIP LOCKED for the whole aggregation transaction, so at most one
 * replica folds any given bucket and a crashed leader releases the lease via
 * rollback.
 */

export const ERROR_TAXONOMY_VERSION = 'obs-error-taxonomy-1';

/** The fixed 16-category ordered error taxonomy, plus 'ok' for successes. */
export const OBS_ERROR_CATEGORIES = Object.freeze([
  'content_policy',
  'authentication',
  'context_limit',
  'invalid_request',
  'model_unsupported',
  'quota_or_balance',
  'account_pool_unavailable',
  'rate_or_capacity',
  'timeout',
  'transport_or_stream',
  'upstream_forbidden',
  'not_found',
  'client_cancelled',
  'upstream_5xx',
  'internal',
  'other',
] as const);

export type ErrorCategory = (typeof OBS_ERROR_CATEGORIES)[number];
export type ChannelErrorCategory = ErrorCategory | 'ok';

interface TextSignalRule {
  readonly category: ErrorCategory;
  /** Case-insensitive POSIX regex fragment used verbatim in SQL `~*` arms. */
  readonly sqlPattern: string;
  /** Same pattern for the TypeScript classifier. */
  readonly tsPattern: RegExp;
}

/**
 * Ordered text-signal cascade. Both the SQL CASE builder and the TypeScript
 * classifier iterate this table, so text classification can never drift
 * between the worker's aggregation and any in-process use.
 */
const TEXT_SIGNAL_RULES: readonly TextSignalRule[] = [
  {
    category: 'content_policy',
    sqlPattern: 'content_polic|content polic|safety system|policy violation|flagged as sensitive',
    tsPattern: /content_polic|content polic|safety system|policy violation|flagged as sensitive/i,
  },
  {
    category: 'authentication',
    sqlPattern: 'invalid api key|incorrect api key|api key (is )?invalid|authentication failed|unauthorized',
    tsPattern: /invalid api key|incorrect api key|api key (is )?invalid|authentication failed|unauthorized/i,
  },
  {
    category: 'context_limit',
    sqlPattern:
      'context length|context_length|context window|too many (input )?tokens|prompt is too long|input too long|maximum context',
    tsPattern:
      /context length|context_length|context window|too many (input )?tokens|prompt is too long|input too long|maximum context/i,
  },
  {
    category: 'model_unsupported',
    sqlPattern: 'model_not_found|model not found|no such model|unknown model|unsupported model|invalid model',
    tsPattern: /model_not_found|model not found|no such model|unknown model|unsupported model|invalid model/i,
  },
  {
    category: 'quota_or_balance',
    sqlPattern: 'insufficient|quota|balance|billing|payment required|credits? (exhausted|insufficient)|exceeded your',
    tsPattern: /insufficient|quota|balance|billing|payment required|credits? (exhausted|insufficient)|exceeded your/i,
  },
  {
    category: 'account_pool_unavailable',
    sqlPattern: 'no available|pool (exhausted|unavailable|empty)|account_pool|accounts? available',
    tsPattern: /no available|pool (exhausted|unavailable|empty)|account_pool|accounts? available/i,
  },
  {
    category: 'rate_or_capacity',
    sqlPattern: 'rate limit|too many requests|overloaded|capacity|throttl',
    tsPattern: /rate limit|too many requests|overloaded|capacity|throttl/i,
  },
  {
    category: 'timeout',
    sqlPattern: 'timeout|timed out|deadline',
    tsPattern: /timeout|timed out|deadline/i,
  },
  {
    category: 'transport_or_stream',
    sqlPattern:
      'econnreset|econnrefused|enotfound|epipe|socket|stream (error|aborted|terminated)|aborted|network|connection (reset|refused|closed)|fetch failed',
    tsPattern:
      /econnreset|econnrefused|enotfound|epipe|socket|stream (error|aborted|terminated)|aborted|network|connection (reset|refused|closed)|fetch failed/i,
  },
  {
    category: 'client_cancelled',
    sqlPattern: 'cancel|client closed',
    tsPattern: /cancel|client closed/i,
  },
];

function textSignalFor(errorText: string | null | undefined): ErrorCategory | null {
  if (typeof errorText !== 'string' || errorText.length === 0) return null;
  for (const rule of TEXT_SIGNAL_RULES) {
    if (rule.tsPattern.test(errorText)) return rule.category;
  }
  return null;
}

function statusSignalFor(status: number | null | undefined): ErrorCategory {
  if (typeof status !== 'number' || !Number.isFinite(status)) return 'internal';
  if (status === 401) return 'authentication';
  if (status === 400) return 'invalid_request';
  if (status === 402) return 'quota_or_balance';
  if (status === 429) return 'rate_or_capacity';
  if (status === 403) return 'upstream_forbidden';
  if (status === 404) return 'not_found';
  if (status === 499) return 'client_cancelled';
  if (status >= 500) return 'upstream_5xx';
  return 'other';
}

/**
 * The ordered 16-category cascade over (http status, error text). Text
 * patterns win over status mapping; a missing status classifies as 'internal'
 * because the proxy itself produced the failure without an upstream answer.
 */
export function classifyError(status: number | null, errorText: string | null): ErrorCategory {
  return textSignalFor(errorText) ?? statusSignalFor(status);
}

export interface AttemptOutcomeClassificationInput {
  readonly resultState: 'succeeded' | 'failed' | 'unknown' | 'pending';
  readonly dispatchState?: 'not_sent' | 'dispatching' | 'sent' | 'unknown';
  readonly status?: number | null;
  readonly errorText?: string | null;
}

/**
 * Full attempt classification used by the aggregation worker. Pending attempts
 * return null (excluded from category rows). An error without any HTTP status
 * that had already been dispatched is a transport/stream failure, not an
 * internal one — the SQL CASE mirrors this distinction.
 */
export function classifyAttemptOutcome(input: AttemptOutcomeClassificationInput): ChannelErrorCategory | null {
  if (input.resultState === 'succeeded') return 'ok';
  if (input.resultState === 'pending') return null;
  const textSignal = textSignalFor(input.errorText);
  if (textSignal !== null) return textSignal;
  if (input.status === null || input.status === undefined) {
    return input.dispatchState === 'sent' || input.dispatchState === 'unknown' ? 'transport_or_stream' : 'internal';
  }
  return statusSignalFor(input.status);
}

/**
 * SQL CASE expression mirroring `classifyAttemptOutcome` for the aggregation
 * query. `attemptAlias` must alias saas_attempts in the surrounding query.
 */
export function attemptCategorySqlCase(attemptAlias = 'a'): string {
  const textArms = TEXT_SIGNAL_RULES.map(
    (rule) => `      WHEN ${attemptAlias}.unknown_reason ~* '${rule.sqlPattern}' THEN '${rule.category}'`,
  ).join('\n');
  return `CASE
    WHEN ${attemptAlias}.result_state = 'succeeded' THEN 'ok'
    WHEN ${attemptAlias}.result_state = 'pending' THEN NULL
    ELSE COALESCE(
      CASE
${textArms}
        ELSE NULL
      END,
      CASE
        WHEN ${attemptAlias}.dispatch_state IN ('sent', 'unknown') AND ${attemptAlias}.result_http_status IS NULL THEN 'transport_or_stream'
        WHEN ${attemptAlias}.result_http_status IS NULL THEN 'internal'
        WHEN ${attemptAlias}.result_http_status = 401 THEN 'authentication'
        WHEN ${attemptAlias}.result_http_status = 400 THEN 'invalid_request'
        WHEN ${attemptAlias}.result_http_status = 402 THEN 'quota_or_balance'
        WHEN ${attemptAlias}.result_http_status = 429 THEN 'rate_or_capacity'
        WHEN ${attemptAlias}.result_http_status = 403 THEN 'upstream_forbidden'
        WHEN ${attemptAlias}.result_http_status = 404 THEN 'not_found'
        WHEN ${attemptAlias}.result_http_status = 499 THEN 'client_cancelled'
        WHEN ${attemptAlias}.result_http_status >= 500 THEN 'upstream_5xx'
        ELSE 'other'
      END
    )
  END`;
}

export const OBS_CHANNEL_METRICS_1M_WATERMARK_KEY = 'channel_metrics_1m';
export const OBS_CHANNEL_METRICS_HOURLY_WATERMARK_KEY = 'channel_metrics_hourly';

const CHANNEL_METRICS_1M_TABLE = 'saas_obs_channel_metrics_1m';
const CHANNEL_METRICS_HOURLY_TABLE = 'saas_obs_channel_metrics_hourly';
const CHANNEL_METRICS_WATERMARK_TABLE = 'saas_obs_channel_metrics_watermark';

/**
 * The 1m fold: one row per (bucket, provider, route, model, error_category).
 * `requests` repeats the group total on every category row; `errors` counts
 * only this category; `upstream_affected` counts category members that were
 * actually dispatched. The whole (from, to] bucket range is recomputed
 * idempotently, so a crashed leader's partial write is healed by the next
 * cycle.
 */
export function buildChannelMetrics1mInsertSql(): string {
  return `
WITH per_attempt AS (
  SELECT
    date_trunc('minute', a.created_at) AS bucket_at,
    COALESCE(a.provider_id, a.upstream_id, 'unattributed') AS provider_id,
    COALESCE(a.route_config_id, 'unrouted') AS route_id,
    a.resolved_model AS model,
    ${attemptCategorySqlCase('a')} AS error_category,
    (a.dispatch_state IN ('sent', 'unknown')) AS upstream_affected
  FROM saas_attempts a
  WHERE a.created_at > $1 AND a.created_at <= $2
),
grouped AS (
  SELECT bucket_at, provider_id, route_id, model, COUNT(*)::int AS group_requests
  FROM per_attempt
  GROUP BY 1, 2, 3, 4
)
INSERT INTO ${CHANNEL_METRICS_1M_TABLE}
  (bucket_at, provider_id, route_id, model, error_category, requests, errors, upstream_affected)
SELECT
  p.bucket_at,
  p.provider_id,
  p.route_id,
  p.model,
  p.error_category,
  g.group_requests,
  SUM(CASE WHEN p.error_category <> 'ok' THEN 1 ELSE 0 END)::int,
  SUM(CASE WHEN p.error_category <> 'ok' AND p.upstream_affected THEN 1 ELSE 0 END)::int
FROM per_attempt p
JOIN grouped g USING (bucket_at, provider_id, route_id, model)
WHERE p.error_category IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, g.group_requests
ON CONFLICT (bucket_at, provider_id, route_id, model, error_category) DO UPDATE
SET requests = EXCLUDED.requests,
    errors = EXCLUDED.errors,
    upstream_affected = EXCLUDED.upstream_affected`;
}

/**
 * The hourly rollup: folds finalized 1m buckets into the hourly table.
 * Per-minute group totals are recovered with MAX(requests) (every category
 * row of a group repeats the same total) and summed across the hour.
 */
export function buildChannelMetricsHourlyInsertSql(): string {
  return `
WITH minute_totals AS (
  SELECT
    date_trunc('hour', m.bucket_at) AS hour_at,
    m.provider_id,
    m.route_id,
    m.model,
    m.bucket_at,
    MAX(m.requests) AS minute_requests
  FROM ${CHANNEL_METRICS_1M_TABLE} m
  WHERE m.bucket_at > $1 AND m.bucket_at <= $2
  GROUP BY 1, 2, 3, 4, 5
),
hour_totals AS (
  SELECT hour_at, provider_id, route_id, model, SUM(minute_requests)::int AS hour_requests
  FROM minute_totals
  GROUP BY 1, 2, 3, 4
),
category_rows AS (
  SELECT
    date_trunc('hour', m.bucket_at) AS hour_at,
    m.provider_id,
    m.route_id,
    m.model,
    m.error_category,
    SUM(m.errors)::int AS errors,
    SUM(m.upstream_affected)::int AS upstream_affected
  FROM ${CHANNEL_METRICS_1M_TABLE} m
  WHERE m.bucket_at > $1 AND m.bucket_at <= $2
  GROUP BY 1, 2, 3, 4, 5
)
INSERT INTO ${CHANNEL_METRICS_HOURLY_TABLE}
  (bucket_at, provider_id, route_id, model, error_category, requests, errors, upstream_affected)
SELECT
  c.hour_at,
  c.provider_id,
  c.route_id,
  c.model,
  c.error_category,
  h.hour_requests,
  c.errors,
  c.upstream_affected
FROM category_rows c
JOIN hour_totals h USING (hour_at, provider_id, route_id, model)
ON CONFLICT (bucket_at, provider_id, route_id, model, error_category) DO UPDATE
SET requests = EXCLUDED.requests,
    errors = EXCLUDED.errors,
    upstream_affected = EXCLUDED.upstream_affected`;
}

export type ChannelStatusWorkerCycleResult = 'idle' | 'processed' | 'stale';

export interface ChannelStatusWorkerOptions {
  /** Minutes a bucket must age before it is considered settled. */
  readonly lagMinutes?: number;
  /** How far back the very first cycle backfills. */
  readonly initialBackfillMinutes?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (phase: 'metrics_1m' | 'metrics_hourly', error: unknown) => void;
  /** Test seam for deterministic time. */
  readonly now?: () => Date;
}

interface WatermarkCycleDeps {
  readonly database: SaasDatabase;
  readonly watermarkKey: string;
  readonly bucketTrunc: 'minute' | 'hour';
  readonly insertSql: string;
  readonly sourceLagMinutes: number;
  readonly initialBackfillMinutes: number;
  readonly now: () => Date;
}

function truncateBucket(date: Date, trunc: 'minute' | 'hour'): Date {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  if (trunc === 'hour') copy.setUTCMinutes(0);
  return copy;
}

async function runWatermarkCycle(deps: WatermarkCycleDeps): Promise<ChannelStatusWorkerCycleResult> {
  const now = deps.now();
  const initialFrom = truncateBucket(new Date(now.getTime() - deps.initialBackfillMinutes * 60_000), deps.bucketTrunc);
  return deps.database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO ${CHANNEL_METRICS_WATERMARK_TABLE} (watermark_key, last_bucket_at)
       VALUES ($1, $2)
       ON CONFLICT (watermark_key) DO NOTHING`,
      [deps.watermarkKey, initialFrom.toISOString()],
    );
    const locked = await tx.query<{ readonly last_bucket_at: Date | string }>(
      `SELECT last_bucket_at FROM ${CHANNEL_METRICS_WATERMARK_TABLE}
       WHERE watermark_key = $1
       FOR UPDATE SKIP LOCKED`,
      [deps.watermarkKey],
    );
    const row = locked.rows[0];
    if (!row) return 'stale';
    const lastBucketAt = row.last_bucket_at instanceof Date ? row.last_bucket_at : new Date(row.last_bucket_at);
    // The hourly rollup reads finalized 1m buckets, so it trails the 1m lag.
    const target = truncateBucket(new Date(now.getTime() - deps.sourceLagMinutes * 60_000), deps.bucketTrunc);
    if (target.getTime() <= lastBucketAt.getTime()) return 'idle';
    await tx.query(
      `DELETE FROM ${deps.bucketTrunc === 'minute' ? CHANNEL_METRICS_1M_TABLE : CHANNEL_METRICS_HOURLY_TABLE}
       WHERE bucket_at > $1 AND bucket_at <= $2`,
      [lastBucketAt.toISOString(), target.toISOString()],
    );
    await tx.query(deps.insertSql, [lastBucketAt.toISOString(), target.toISOString()]);
    await tx.query(
      `UPDATE ${CHANNEL_METRICS_WATERMARK_TABLE}
       SET last_bucket_at = $2
       WHERE watermark_key = $1`,
      [deps.watermarkKey, target.toISOString()],
    );
    return 'processed';
  });
}

/** Runs one 1m fold plus one hourly rollup cycle; exposed for tests. */
export async function runChannelStatusCycle(
  database: SaasDatabase,
  options: ChannelStatusWorkerOptions = {},
): Promise<ChannelStatusWorkerCycleResult> {
  const now = options.now ?? (() => new Date());
  const lagMinutes = options.lagMinutes ?? 2;
  const initialBackfillMinutes = options.initialBackfillMinutes ?? 60;
  const minuteResult = await runWatermarkCycle({
    database,
    watermarkKey: OBS_CHANNEL_METRICS_1M_WATERMARK_KEY,
    bucketTrunc: 'minute',
    insertSql: buildChannelMetrics1mInsertSql(),
    sourceLagMinutes: lagMinutes,
    initialBackfillMinutes,
    now,
  });
  if (minuteResult === 'stale') return 'stale';
  // The hourly fold re-reads the 1m table, so it must trail it by the same
  // lag plus one settled minute.
  const hourlyResult = await runWatermarkCycle({
    database,
    watermarkKey: OBS_CHANNEL_METRICS_HOURLY_WATERMARK_KEY,
    bucketTrunc: 'hour',
    insertSql: buildChannelMetricsHourlyInsertSql(),
    sourceLagMinutes: lagMinutes + 1,
    initialBackfillMinutes,
    now,
  });
  return minuteResult === 'processed' || hourlyResult === 'processed' ? 'processed' : 'idle';
}

export interface ChannelStatusWorkerHandle {
  close(): Promise<void>;
}

/**
 * Starts the single-leader channel status worker. The watermark row lease
 * (SKIP LOCKED) is the leadership fence; replicas that lose the race simply
 * skip the cycle.
 */
export function startChannelStatusWorker(
  database: SaasDatabase,
  options: ChannelStatusWorkerOptions = {},
): ChannelStatusWorkerHandle {
  const pollIntervalMs = Math.min(Math.max(options.pollIntervalMs ?? 30_000, 1_000), 300_000);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = async (): Promise<void> => {
    // The first cycle waits one poll interval: aggregation is watermark-driven
    // and catch-up oriented, so a short startup delay costs nothing while
    // keeping eager SQL off process bootstrap.
    await delayWithClose(pollIntervalMs);
    while (!closed) {
      try {
        const result = await runChannelStatusCycle(database, options);
        if (closed) break;
        if (result !== 'processed') await delayWithClose(pollIntervalMs);
      } catch (error) {
        if (closed) break;
        try {
          options.onError?.('metrics_1m', error);
        } catch {
          // An observer cannot terminate aggregation.
        }
        await delayWithClose(pollIntervalMs);
      }
    }
  };
  const done = loop();
  return {
    async close() {
      if (closed) return done;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await done;
    },
  };
}

export interface ChannelStatusErrorCategoryBreakdown {
  readonly category: ErrorCategory;
  readonly errors: number;
}

export interface ChannelStatusRow {
  readonly providerId: string;
  readonly routeId: string;
  readonly model: string;
  readonly requests: number;
  readonly errors: number;
  readonly upstreamAffected: number;
  /** 0..1 availability over the requested range. */
  readonly availability: number;
  readonly lastErrorAt: string | null;
  readonly topErrorCategories: readonly ChannelStatusErrorCategoryBreakdown[];
}

export interface ChannelStatusPage {
  readonly taxonomyVersion: string;
  readonly rangeDays: number;
  readonly generatedAt: string;
  readonly channels: readonly ChannelStatusRow[];
}

const CHANNEL_STATUS_PAGE_SQL = `
WITH combined AS (
  SELECT bucket_at, provider_id, route_id, model, error_category, requests, errors, upstream_affected
  FROM ${CHANNEL_METRICS_HOURLY_TABLE}
  WHERE bucket_at >= date_trunc('hour', now() - ($1::int * interval '1 day'))
    AND bucket_at < date_trunc('hour', now())
  UNION ALL
  SELECT bucket_at, provider_id, route_id, model, error_category, requests, errors, upstream_affected
  FROM ${CHANNEL_METRICS_1M_TABLE}
  WHERE bucket_at >= date_trunc('hour', now())
),
per_bucket AS (
  SELECT provider_id, route_id, model, bucket_at, MAX(requests)::int AS bucket_requests
  FROM combined
  GROUP BY 1, 2, 3, 4
),
agg AS (
  SELECT
    c.provider_id,
    c.route_id,
    c.model,
    SUM(pb.bucket_requests)::int AS requests,
    SUM(c.errors)::int AS errors,
    SUM(c.upstream_affected)::int AS upstream_affected,
    MAX(CASE WHEN c.errors > 0 THEN c.bucket_at END) AS last_error_at
  FROM combined c
  JOIN per_bucket pb USING (provider_id, route_id, model, bucket_at)
  GROUP BY 1, 2, 3
)
SELECT
  agg.provider_id,
  agg.route_id,
  agg.model,
  agg.requests,
  agg.errors,
  agg.upstream_affected,
  1.0 - (agg.errors::float8 / GREATEST(agg.requests, 1)) AS availability,
  agg.last_error_at,
  COALESCE(top.categories, '[]'::jsonb) AS top_error_categories
FROM agg
LEFT JOIN LATERAL (
  SELECT jsonb_agg(entry ORDER BY (entry->>'errors')::int DESC) AS categories
  FROM (
    SELECT jsonb_build_object('category', c2.error_category, 'errors', SUM(c2.errors)::int) AS entry
    FROM combined c2
    WHERE c2.provider_id = agg.provider_id
      AND c2.route_id = agg.route_id
      AND c2.model = agg.model
      AND c2.error_category <> 'ok'
    GROUP BY c2.error_category
    HAVING SUM(c2.errors) > 0
  ) ranked
) top ON true
ORDER BY agg.requests DESC, agg.provider_id, agg.route_id, agg.model`;

interface ChannelStatusQueryRow {
  readonly provider_id: string;
  readonly route_id: string;
  readonly model: string;
  readonly requests: number;
  readonly errors: number;
  readonly upstream_affected: number;
  readonly availability: string | number;
  readonly last_error_at: Date | string | null;
  readonly top_error_categories:
    | Array<{ readonly category: string; readonly errors: number }>
    | { readonly categories?: undefined }
    | string;
}

export interface ChannelStatusPageQuery {
  /** Availability rollup window in days; 1-90, default 7. */
  readonly days?: number;
}

/** Reads the channel status page (7-day availability rollup by default). */
export async function getChannelStatusPage(
  database: SaasDatabase,
  query: ChannelStatusPageQuery = {},
): Promise<ChannelStatusPage> {
  const days = Math.min(Math.max(Math.trunc(query.days ?? 7), 1), 90);
  const result = await database.query<ChannelStatusQueryRow>(CHANNEL_STATUS_PAGE_SQL, [days]);
  const channels: ChannelStatusRow[] = result.rows.map((row) => {
    const availability = typeof row.availability === 'number' ? row.availability : Number(row.availability);
    let breakdown: ChannelStatusErrorCategoryBreakdown[] = [];
    if (Array.isArray(row.top_error_categories)) {
      breakdown = row.top_error_categories
        .filter(
          (entry): entry is { category: string; errors: number } =>
            typeof entry?.category === 'string' &&
            (OBS_ERROR_CATEGORIES as readonly string[]).includes(entry.category) &&
            typeof entry?.errors === 'number',
        )
        .map((entry) => ({ category: entry.category as ErrorCategory, errors: entry.errors }))
        .sort((left, right) => right.errors - left.errors)
        .slice(0, 5);
    }
    const lastErrorAt =
      row.last_error_at instanceof Date
        ? row.last_error_at.toISOString()
        : typeof row.last_error_at === 'string'
          ? new Date(row.last_error_at).toISOString()
          : null;
    return {
      providerId: row.provider_id,
      routeId: row.route_id,
      model: row.model,
      requests: row.requests,
      errors: row.errors,
      upstreamAffected: row.upstream_affected,
      availability: Number.isFinite(availability) ? availability : 1,
      lastErrorAt,
      topErrorCategories: breakdown,
    };
  });
  return {
    taxonomyVersion: ERROR_TAXONOMY_VERSION,
    rangeDays: days,
    generatedAt: new Date().toISOString(),
    channels,
  };
}
