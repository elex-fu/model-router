import type { SaasDatabase } from '../db/types.js';

/**
 * R-dormant activation (sub2api GetAccountWindowStats port): batched
 * per-account window-cost aggregation over `saas_usage_events` since one
 * window start. Usage events carry no account or model binding — the
 * attempt table's owner-neutral generated `account_id` (migration 018) is
 * the join key, exactly like the scheduler's rate-window read.
 *
 * N+1 avoidance (the sub2api withWindowCostPrefetch pattern): callers
 * bucket accounts by their per-account window start
 * (`groupAccountIdsByWindowStart`) and issue ONE batched query per
 * DISTINCT start; accounts missing from the result map consumed nothing in
 * the window and read as zero via `accountWindowStatsOrZero`.
 *
 * The aggregate is a scheduling/observability signal only; it never enters
 * the billing path (010 settlement facts remain the billing truth).
 */

export interface AccountWindowStats {
  readonly requests: number;
  readonly tokens: bigint;
}

function parseCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseTokenSum(value: unknown): bigint {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^([0-9]+)$/.test(value)
            ? BigInt(value)
            : 0n;
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Aggregates requests and token totals for `accountIds` over usage events
 * recorded since `windowStartMs`. One grouped query — no per-account reads.
 */
export async function getAccountWindowStatsBatch(
  database: SaasDatabase,
  accountIds: readonly string[],
  windowStartMs: number,
): Promise<Map<string, AccountWindowStats>> {
  const stats = new Map<string, AccountWindowStats>();
  if (accountIds.length === 0) return stats;
  const result = await database.query<{ account_id: string; requests: unknown; tokens: unknown }>(
    `SELECT attempt.account_id AS account_id,
            count(*)::int AS requests,
            coalesce(sum(event.input_total + event.output_total), 0)::bigint AS tokens
       FROM saas_usage_events event
       JOIN saas_attempts attempt
         ON attempt.tenant_id = event.tenant_id AND attempt.id = event.attempt_id
      WHERE attempt.account_id = ANY($1::text[])
        AND event.created_at >= $2::timestamptz
      GROUP BY attempt.account_id`,
    [[...accountIds], new Date(windowStartMs).toISOString()],
  );
  for (const row of result.rows) {
    if (typeof row.account_id !== 'string' || row.account_id.length === 0) continue;
    stats.set(row.account_id, { requests: parseCount(row.requests), tokens: parseTokenSum(row.tokens) });
  }
  return stats;
}

/**
 * Buckets accounts by their window start (unix ms) so the caller issues one
 * batched aggregation per distinct start. Entries whose start cannot be
 * resolved fall into the caller-provided fallback bucket.
 */
export function groupAccountIdsByWindowStart(
  accountWindowStarts: ReadonlyMap<string, number>,
  accountIds: readonly string[],
  fallbackStartMs: number,
): Map<number, string[]> {
  const buckets = new Map<number, string[]>();
  for (const accountId of accountIds) {
    const start = accountWindowStarts.get(accountId) ?? fallbackStartMs;
    const bucket = buckets.get(start);
    if (bucket === undefined) buckets.set(start, [accountId]);
    else bucket.push(accountId);
  }
  return buckets;
}

/** Zero-value read for accounts that consumed nothing in the window. */
export function accountWindowStatsOrZero(
  stats: ReadonlyMap<string, AccountWindowStats>,
  accountId: string,
): AccountWindowStats {
  return stats.get(accountId) ?? { requests: 0, tokens: 0n };
}
