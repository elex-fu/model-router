import type { SqlExecutor } from '../../db/types.js';

const MAX_TIME_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_DATE_INPUT_LENGTH = 128;
const ISO_DATE_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

const REQUEST_STATUSES = ['pending', 'succeeded', 'failed', 'unknown'] as const;
const ATTEMPT_STATUSES = ['pending', 'succeeded', 'failed', 'unknown'] as const;

export type PlatformOperationsQueryExecutor = Pick<SqlExecutor, 'query'>;
export type PlatformOperationsQueryDatabase = PlatformOperationsQueryExecutor;
export type PlatformOperationsRequestStatus = (typeof REQUEST_STATUSES)[number];
export type PlatformOperationsAttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export interface PlatformOperationsSummaryQuery {
  readonly from: string;
  readonly to: string;
}

export interface PlatformOperationsStatusCounts {
  readonly pending: string;
  readonly succeeded: string;
  readonly failed: string;
  readonly unknown: string;
}

export interface PlatformOperationsAggregate {
  readonly total: string;
  readonly byStatus: PlatformOperationsStatusCounts;
}

export interface PlatformOperationsSummary {
  readonly from: string;
  readonly to: string;
  readonly requests: PlatformOperationsAggregate;
  readonly attempts: PlatformOperationsAggregate;
  readonly activeProviderAccountLeaseCount: string;
  /** Additive DTO extension; older clients can continue to ignore this projection. */
  readonly metrics: {
    readonly dataSource: 'postgresql_persisted_aggregates';
    readonly snapshotAt: string;
    readonly requests: {
      readonly successPercent: string | null;
      readonly unknownPercent: string | null;
      readonly financialStatus: {
        readonly notApplicable: string;
        readonly pending: string;
        readonly settled: string;
        readonly released: string;
        readonly reconciliationPending: string;
      };
    };
    readonly attempts: {
      readonly successPercent: string | null;
      readonly unknownPercent: string | null;
      readonly responseHttp4xxCount: string;
      readonly responseHttp5xxCount: string;
      readonly responseStartLatencyMs: {
        readonly sampleCount: string;
        readonly p50: string | null;
        readonly p95: string | null;
      };
    };
    readonly billingReservationBacklog: {
      readonly reserved: string;
      readonly reconciliationPending: string;
    };
    readonly platformAccountHealth: {
      readonly observationCount: string;
      readonly byState: {
        readonly healthy: string;
        readonly degraded: string;
        readonly cooldown: string;
        readonly unhealthy: string;
      };
      readonly activeCooldownCount: string;
      readonly latestObservedAt: string | null;
    };
    readonly paymentWebhookBacklog: {
      readonly pending: string;
      readonly processing: string;
      readonly oldestUnprocessedAgeMs: string | null;
    };
    readonly runtimeProbes: {
      readonly postgresql: 'not_configured';
      readonly redis: 'not_configured';
      readonly kms: 'not_configured';
      readonly worker: 'not_configured';
    };
  };
}

export type PlatformOperationsSummaryErrorCode = 'OPERATIONS_INVALID_INPUT' | 'OPERATIONS_STORAGE_ERROR';

const SAFE_ERROR_MESSAGES: Record<PlatformOperationsSummaryErrorCode, string> = {
  OPERATIONS_INVALID_INPUT: 'The operations summary query contains invalid data.',
  OPERATIONS_STORAGE_ERROR: 'The operations summary could not be completed.',
};

export class PlatformOperationsSummaryError extends Error {
  readonly status: number;
  readonly code: PlatformOperationsSummaryErrorCode;

  constructor(code: PlatformOperationsSummaryErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'PlatformOperationsSummaryError';
    this.status = code === 'OPERATIONS_INVALID_INPUT' ? 400 : 500;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface NormalizedRange {
  readonly from: string;
  readonly to: string;
}

type Row = Record<string, unknown>;

/**
 * Every counter stays text at the PostgreSQL boundary. The date-window
 * aggregates use the persisted request/attempt facts; current backlog and
 * health values are separate snapshots captured at one database timestamp.
 */
export const PLATFORM_OPERATIONS_SUMMARY_SQL = `
WITH snapshot AS MATERIALIZED (
  SELECT clock_timestamp() AS captured_at
),
request_stats AS (
  SELECT
    COUNT(*)::text AS request_count,
    (COUNT(*) FILTER (WHERE r.execution_state = 'pending'))::text AS request_pending_count,
    (COUNT(*) FILTER (WHERE r.execution_state = 'succeeded'))::text AS request_succeeded_count,
    (COUNT(*) FILTER (WHERE r.execution_state = 'failed'))::text AS request_failed_count,
    (COUNT(*) FILTER (WHERE r.execution_state = 'unknown'))::text AS request_unknown_count,
    (COUNT(*) FILTER (WHERE r.financial_status = 'not_applicable'))::text AS request_financial_not_applicable_count,
    (COUNT(*) FILTER (WHERE r.financial_status = 'pending'))::text AS request_financial_pending_count,
    (COUNT(*) FILTER (WHERE r.financial_status = 'settled'))::text AS request_financial_settled_count,
    (COUNT(*) FILTER (WHERE r.financial_status = 'released'))::text AS request_financial_released_count,
    (COUNT(*) FILTER (WHERE r.financial_status = 'reconciliation_pending'))::text AS request_financial_reconciliation_pending_count
  FROM saas_requests AS r
  WHERE r.created_at >= $1
    AND r.created_at < $2
),
attempt_stats AS (
  SELECT
    COUNT(*)::text AS attempt_count,
    (COUNT(*) FILTER (WHERE a.result_state = 'pending'))::text AS attempt_pending_count,
    (COUNT(*) FILTER (WHERE a.result_state = 'succeeded'))::text AS attempt_succeeded_count,
    (COUNT(*) FILTER (WHERE a.result_state = 'failed'))::text AS attempt_failed_count,
    (COUNT(*) FILTER (WHERE a.result_state = 'unknown'))::text AS attempt_unknown_count,
    (COUNT(*) FILTER (WHERE a.result_http_status BETWEEN 400 AND 499))::text AS attempt_http_4xx_count,
    (COUNT(*) FILTER (WHERE a.result_http_status BETWEEN 500 AND 599))::text AS attempt_http_5xx_count,
    (COUNT(*) FILTER (
      WHERE a.response_started_at IS NOT NULL
        AND a.response_started_at >= a.created_at
    ))::text AS response_start_latency_sample_count,
    (PERCENTILE_DISC(0.50) WITHIN GROUP (
      ORDER BY FLOOR(EXTRACT(EPOCH FROM (a.response_started_at - a.created_at)) * 1000)::bigint
    ) FILTER (
      WHERE a.response_started_at IS NOT NULL
        AND a.response_started_at >= a.created_at
    ))::text AS response_start_latency_p50_ms,
    (PERCENTILE_DISC(0.95) WITHIN GROUP (
      ORDER BY FLOOR(EXTRACT(EPOCH FROM (a.response_started_at - a.created_at)) * 1000)::bigint
    ) FILTER (
      WHERE a.response_started_at IS NOT NULL
        AND a.response_started_at >= a.created_at
    ))::text AS response_start_latency_p95_ms
  FROM saas_attempts AS a
  WHERE a.created_at >= $1
    AND a.created_at < $2
),
lease_stats AS (
  SELECT COUNT(*)::text AS active_provider_account_lease_count
  FROM saas_provider_account_leases AS lease
  CROSS JOIN snapshot
  WHERE lease.status = 'held'
    AND lease.lease_expires_at > snapshot.captured_at
),
billing_reservation_stats AS (
  SELECT
    (COUNT(*) FILTER (WHERE reservation.state = 'reserved'))::text AS billing_reservation_reserved_count,
    (COUNT(*) FILTER (WHERE reservation.state = 'reconciliation_pending'))::text
      AS billing_reservation_reconciliation_pending_count
  FROM saas_billing_reservations AS reservation
  WHERE reservation.state IN ('reserved', 'reconciliation_pending')
),
platform_account_health_stats AS (
  SELECT
    COUNT(*)::text AS account_health_observation_count,
    (COUNT(*) FILTER (WHERE health.state = 'healthy'))::text AS account_health_healthy_count,
    (COUNT(*) FILTER (WHERE health.state = 'degraded'))::text AS account_health_degraded_count,
    (COUNT(*) FILTER (WHERE health.state = 'cooldown'))::text AS account_health_cooldown_count,
    (COUNT(*) FILTER (WHERE health.state = 'unhealthy'))::text AS account_health_unhealthy_count,
    (COUNT(*) FILTER (
      WHERE health.state = 'cooldown'
        AND health.cooldown_until > snapshot.captured_at
    ))::text AS account_health_active_cooldown_count,
    MAX(health.observed_at)::text AS account_health_latest_observed_at
  FROM saas_provider_account_runtime_health AS health
  CROSS JOIN snapshot
  WHERE health.owner_scope_key = 'platform'
    AND health.owner_kind = 'platform'
),
payment_webhook_stats AS (
  SELECT
    (COUNT(*) FILTER (WHERE inbox.processing_state = 'pending'))::text AS webhook_pending_count,
    (COUNT(*) FILTER (WHERE inbox.processing_state = 'processing'))::text AS webhook_processing_count,
    (GREATEST(
      0::numeric,
      FLOOR(EXTRACT(EPOCH FROM (
        snapshot.captured_at - MIN(inbox.received_at) FILTER (
          WHERE inbox.processing_state IN ('pending', 'processing')
        )
      )) * 1000)
    )::bigint)::text AS webhook_oldest_unprocessed_age_ms
  FROM saas_payment_inbox AS inbox
  CROSS JOIN snapshot
  WHERE inbox.processing_state IN ('pending', 'processing')
)
SELECT
  request_stats.request_count,
  request_stats.request_pending_count,
  request_stats.request_succeeded_count,
  request_stats.request_failed_count,
  request_stats.request_unknown_count,
  request_stats.request_financial_not_applicable_count,
  request_stats.request_financial_pending_count,
  request_stats.request_financial_settled_count,
  request_stats.request_financial_released_count,
  request_stats.request_financial_reconciliation_pending_count,
  attempt_stats.attempt_count,
  attempt_stats.attempt_pending_count,
  attempt_stats.attempt_succeeded_count,
  attempt_stats.attempt_failed_count,
  attempt_stats.attempt_unknown_count,
  attempt_stats.attempt_http_4xx_count,
  attempt_stats.attempt_http_5xx_count,
  attempt_stats.response_start_latency_sample_count,
  attempt_stats.response_start_latency_p50_ms,
  attempt_stats.response_start_latency_p95_ms,
  lease_stats.active_provider_account_lease_count,
  billing_reservation_stats.billing_reservation_reserved_count,
  billing_reservation_stats.billing_reservation_reconciliation_pending_count,
  platform_account_health_stats.account_health_observation_count,
  platform_account_health_stats.account_health_healthy_count,
  platform_account_health_stats.account_health_degraded_count,
  platform_account_health_stats.account_health_cooldown_count,
  platform_account_health_stats.account_health_unhealthy_count,
  platform_account_health_stats.account_health_active_cooldown_count,
  platform_account_health_stats.account_health_latest_observed_at,
  payment_webhook_stats.webhook_pending_count,
  payment_webhook_stats.webhook_processing_count,
  payment_webhook_stats.webhook_oldest_unprocessed_age_ms,
  snapshot.captured_at::text AS snapshot_at
FROM request_stats
CROSS JOIN attempt_stats
CROSS JOIN lease_stats
CROSS JOIN billing_reservation_stats
CROSS JOIN platform_account_health_stats
CROSS JOIN payment_webhook_stats
CROSS JOIN snapshot`;

function invalid(): never {
  throw new PlatformOperationsSummaryError('OPERATIONS_INVALID_INPUT');
}

function storage(): never {
  throw new PlatformOperationsSummaryError('OPERATIONS_STORAGE_ERROR');
}

function normalizeIsoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DATE_INPUT_LENGTH) {
    invalid();
  }

  const match = ISO_DATE_INPUT.exec(value);
  if (!match) invalid();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) invalid();

  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) invalid();

    if (match[7] !== 'Z') {
      const offsetHour = Number(match[9]);
      const offsetMinute = Number(match[10]);
      if (offsetHour > 23 || offsetMinute > 59) invalid();
    }
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid();
  return new Date(parsed).toISOString();
}

function normalizeRange(input: unknown): NormalizedRange {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const candidate = input as Record<string, unknown>;
  const from = normalizeIsoDate(candidate.from);
  const to = normalizeIsoDate(candidate.to);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);

  if (fromMs >= toMs || toMs - fromMs > MAX_TIME_RANGE_MS) invalid();
  return { from, to };
}

function decimalString(value: unknown): string {
  if (typeof value === 'bigint') {
    if (value < 0n) storage();
    return value.toString(10);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  storage();
}

function nullableDecimalString(value: unknown): string | null {
  return value === null || value === undefined ? null : decimalString(value);
}

function timestampString(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) storage();
  return date.toISOString();
}

function nullableTimestampString(value: unknown): string | null {
  return value === null || value === undefined ? null : timestampString(value);
}

function statusCounts(row: Row, prefix: 'request' | 'attempt'): PlatformOperationsStatusCounts {
  return {
    pending: decimalString(row[`${prefix}_pending_count`]),
    succeeded: decimalString(row[`${prefix}_succeeded_count`]),
    failed: decimalString(row[`${prefix}_failed_count`]),
    unknown: decimalString(row[`${prefix}_unknown_count`]),
  };
}

function statusTotal(counts: PlatformOperationsStatusCounts): bigint {
  return BigInt(counts.pending) + BigInt(counts.succeeded) + BigInt(counts.failed) + BigInt(counts.unknown);
}

function percent(numerator: string, denominator: string): string | null {
  const value = BigInt(numerator);
  const total = BigInt(denominator);
  if (total === 0n) return null;
  if (value > total) storage();
  const hundredths = (value * 10_000n + total / 2n) / total;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

function checkedCounts(row: Row, fields: readonly string[], expectedTotal: string): Record<string, string> {
  const counts: Record<string, string> = {};
  let sum = 0n;
  for (const field of fields) {
    const count = decimalString(row[field]);
    counts[field] = count;
    sum += BigInt(count);
  }
  if (sum !== BigInt(expectedTotal)) storage();
  return counts;
}

function mapSummary(row: Row, range: NormalizedRange): PlatformOperationsSummary {
  const requests = {
    total: decimalString(row.request_count),
    byStatus: statusCounts(row, 'request'),
  };
  const attempts = {
    total: decimalString(row.attempt_count),
    byStatus: statusCounts(row, 'attempt'),
  };
  if (
    statusTotal(requests.byStatus) !== BigInt(requests.total) ||
    statusTotal(attempts.byStatus) !== BigInt(attempts.total)
  ) {
    storage();
  }

  const requestFinancialCounts = checkedCounts(
    row,
    [
      'request_financial_not_applicable_count',
      'request_financial_pending_count',
      'request_financial_settled_count',
      'request_financial_released_count',
      'request_financial_reconciliation_pending_count',
    ],
    requests.total,
  );
  const healthCounts = checkedCounts(
    row,
    [
      'account_health_healthy_count',
      'account_health_degraded_count',
      'account_health_cooldown_count',
      'account_health_unhealthy_count',
    ],
    decimalString(row.account_health_observation_count),
  );

  const responseStartLatency = {
    sampleCount: decimalString(row.response_start_latency_sample_count),
    p50: nullableDecimalString(row.response_start_latency_p50_ms),
    p95: nullableDecimalString(row.response_start_latency_p95_ms),
  };
  const hasLatencySamples = BigInt(responseStartLatency.sampleCount) > 0n;
  if (
    hasLatencySamples !== (responseStartLatency.p50 !== null && responseStartLatency.p95 !== null) ||
    (!hasLatencySamples && (responseStartLatency.p50 !== null || responseStartLatency.p95 !== null))
  ) {
    storage();
  }

  const webhookPending = decimalString(row.webhook_pending_count);
  const webhookProcessing = decimalString(row.webhook_processing_count);
  const oldestWebhookAgeMs = nullableDecimalString(row.webhook_oldest_unprocessed_age_ms);
  const hasUnprocessedWebhooks = BigInt(webhookPending) + BigInt(webhookProcessing) > 0n;
  if (hasUnprocessedWebhooks !== (oldestWebhookAgeMs !== null)) storage();

  const metrics = {
    dataSource: 'postgresql_persisted_aggregates' as const,
    snapshotAt: timestampString(row.snapshot_at),
    requests: {
      successPercent: percent(requests.byStatus.succeeded, requests.total),
      unknownPercent: percent(requests.byStatus.unknown, requests.total),
      financialStatus: {
        notApplicable: requestFinancialCounts.request_financial_not_applicable_count,
        pending: requestFinancialCounts.request_financial_pending_count,
        settled: requestFinancialCounts.request_financial_settled_count,
        released: requestFinancialCounts.request_financial_released_count,
        reconciliationPending: requestFinancialCounts.request_financial_reconciliation_pending_count,
      },
    },
    attempts: {
      successPercent: percent(attempts.byStatus.succeeded, attempts.total),
      unknownPercent: percent(attempts.byStatus.unknown, attempts.total),
      responseHttp4xxCount: decimalString(row.attempt_http_4xx_count),
      responseHttp5xxCount: decimalString(row.attempt_http_5xx_count),
      responseStartLatencyMs: {
        sampleCount: responseStartLatency.sampleCount,
        p50: responseStartLatency.p50,
        p95: responseStartLatency.p95,
      },
    },
    billingReservationBacklog: {
      reserved: decimalString(row.billing_reservation_reserved_count),
      reconciliationPending: decimalString(row.billing_reservation_reconciliation_pending_count),
    },
    platformAccountHealth: {
      observationCount: decimalString(row.account_health_observation_count),
      byState: {
        healthy: healthCounts.account_health_healthy_count,
        degraded: healthCounts.account_health_degraded_count,
        cooldown: healthCounts.account_health_cooldown_count,
        unhealthy: healthCounts.account_health_unhealthy_count,
      },
      activeCooldownCount: decimalString(row.account_health_active_cooldown_count),
      latestObservedAt: nullableTimestampString(row.account_health_latest_observed_at),
    },
    paymentWebhookBacklog: {
      pending: webhookPending,
      processing: webhookProcessing,
      oldestUnprocessedAgeMs: oldestWebhookAgeMs,
    },
    runtimeProbes: {
      postgresql: 'not_configured' as const,
      redis: 'not_configured' as const,
      kms: 'not_configured' as const,
      worker: 'not_configured' as const,
    },
  };

  return {
    from: range.from,
    to: range.to,
    requests,
    attempts,
    activeProviderAccountLeaseCount: decimalString(row.active_provider_account_lease_count),
    metrics,
  };
}

export class PlatformOperationsSummaryService {
  constructor(private readonly database: PlatformOperationsQueryExecutor) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('database must implement the read-only operations query contract');
    }
  }

  async getSummary(input: PlatformOperationsSummaryQuery): Promise<PlatformOperationsSummary> {
    const range = normalizeRange(input);

    try {
      const result = await this.database.query<Row>(PLATFORM_OPERATIONS_SUMMARY_SQL, [range.from, range.to]);
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) storage();
      return mapSummary(result.rows[0], range);
    } catch (error) {
      if (error instanceof PlatformOperationsSummaryError) throw error;
      throw new PlatformOperationsSummaryError('OPERATIONS_STORAGE_ERROR');
    }
  }
}

export const PLATFORM_OPERATIONS_MAX_TIME_RANGE_MS = MAX_TIME_RANGE_MS;
