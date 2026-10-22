import type { SaasDatabase } from '../db/types.js';
import { groupAccountIdsByWindowStart } from './postgres-provider-account-window-stats.js';

/**
 * Gap-remediation plan G-B1 (§2): the window three-state gate — the pure
 * sub2api `CheckWindowCostSchedulability` judgment plus the PostgreSQL
 * facts reader that feeds it.
 *
 * Three states over the account's EXACT window cost (minor units):
 *
 * ~~~text
 * usage < limit                      -> admit        (new + sticky sessions)
 * limit <= usage < limit + reserve   -> sticky_only  (existing sticky sessions only)
 * usage >= limit + reserve           -> paused       (no scheduling this window)
 * ~~~
 *
 * The judgment is a PURE function (sub2api's separation: no IO, no locks —
 * the caller batches the facts); the policy is per-account from migration
 * 130 (`window_cost_limit_minor_units` / `window_cost_sticky_reserve_minor_units`),
 * where NULL = the gate is OFF for that account (the unused-by-default red
 * line — the control plane freezes policies only on OAuth/subscription-class
 * accounts, the sub2api IsAnthropicOAuthOrSetupToken scope, expressed here
 * as data instead of an account-type predicate).
 *
 * The usage fact is the supplier-cost sum over `saas_attempt_supplier_costs`
 * (migration 130's append-only exact-amount table) since the account's
 * current window start — the same window-start semantics the scheduling
 * threshold read uses (the stored 5 h session window while fresh, hourly
 * floor otherwise). Facts failures fail OPEN (admit): a missing observation
 * must never remove capacity (the P17 posture).
 */

export type WindowCostSchedulability = 'admit' | 'sticky_only' | 'paused';

export interface WindowCostGateInput {
  /** The account's exact supplier cost in the current window (minor units). */
  readonly usageMinorUnits: bigint;
  /** Migration-130 frozen per-account limit; NULL/undefined = the gate is OFF. */
  readonly limitMinorUnits: bigint | null | undefined;
  /** Migration-130 sticky reserve band (minor units). */
  readonly reserveMinorUnits: bigint | null | undefined;
}

/**
 * The pure three-state judgment. An unset limit (or non-positive after
 * validation) is OFF — `admit` for every usage, exactly the pre-gate
 * behavior. A non-positive reserve is an empty middle band: at the limit
 * the account is paused immediately.
 */
export function evaluateWindowCostSchedulability(input: WindowCostGateInput): WindowCostSchedulability {
  const limit = input.limitMinorUnits;
  if (limit === null || limit === undefined || limit <= 0n) return 'admit';
  const reserve = input.reserveMinorUnits ?? 0n;
  const effectiveReserve = reserve > 0n ? reserve : 0n;
  if (input.usageMinorUnits < limit) return 'admit';
  if (input.usageMinorUnits < limit + effectiveReserve) return 'sticky_only';
  return 'paused';
}

/** One account's window-cost gate facts (all optional — absent = OFF). */
export interface AccountWindowCostFacts {
  readonly limitMinorUnits: bigint | null;
  readonly reserveMinorUnits: bigint | null;
  /** The account's current window start (unix ms). */
  readonly windowStartMs: number;
  /**
   * The exact supplier cost observed in the window (minor units); filled by
   * the batch reader — absent means no cost rows matched (reads as zero).
   */
  readonly usageMinorUnits?: bigint;
}

interface PolicyRow {
  readonly account_id: string;
  readonly limit: unknown;
  readonly reserve: unknown;
  readonly window_start: Date | string | null;
}

function parseMinorUnits(value: unknown): bigint | null {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^([0-9]+)$/.test(value)
            ? BigInt(value)
            : null;
    return parsed !== null && parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function timestampMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The 5 h session-window semantics the scheduling threshold read uses: a
 * stored window start is trustworthy while its implied end is in the
 * future; otherwise the hourly floor.
 */
export function windowCostWindowStartMs(
  storedStartMs: number | null,
  nowMs: number,
  windowSpanMs = 5 * 60 * 60 * 1000,
): number {
  if (storedStartMs !== null && storedStartMs + windowSpanMs > nowMs) return storedStartMs;
  return Math.floor(nowMs / 3_600_000) * 3_600_000;
}

/**
 * Reads the gate facts for `accountIds` from BOTH account tables (tenant +
 * platform; the migration-130 columns are scope-neutral). Accounts without
 * a configured limit are absent from the map — the gate is OFF for them.
 * The exact-cost aggregation is ONE grouped query per DISTINCT window
 * start (the withWindowCostPrefetch pattern).
 */
export async function getAccountWindowCostFactsBatch(
  database: SaasDatabase,
  accountIds: readonly string[],
  nowMs: number,
): Promise<Map<string, AccountWindowCostFacts>> {
  const facts = new Map<string, AccountWindowCostFacts>();
  if (accountIds.length === 0) return facts;
  const idList = [...accountIds];
  const result = await database.query<PolicyRow>(
    `SELECT candidate.account_id,
            candidate.window_cost_limit_minor_units AS "limit",
            candidate.window_cost_sticky_reserve_minor_units AS reserve,
            candidate.claude_session_window_start AS window_start
       FROM (
         SELECT id AS account_id, window_cost_limit_minor_units, window_cost_sticky_reserve_minor_units,
                claude_session_window_start
           FROM saas_tenant_provider_accounts
          WHERE id = ANY($1::text[])
          UNION ALL
         SELECT id AS account_id, window_cost_limit_minor_units, window_cost_sticky_reserve_minor_units,
                claude_session_window_start
           FROM saas_platform_provider_accounts
          WHERE id = ANY($1::text[])
       ) candidate`,
    [idList],
  );
  for (const row of result.rows) {
    if (typeof row.account_id !== 'string' || row.account_id === '') continue;
    const limit = parseMinorUnits(row.limit);
    if (limit === null) continue; // gate OFF (or a non-positive policy — read as OFF)
    const stored = timestampMs(row.window_start);
    facts.set(row.account_id, {
      limitMinorUnits: limit,
      reserveMinorUnits: parseMinorUnits(row.reserve),
      windowStartMs: windowCostWindowStartMs(stored, nowMs),
    });
  }
  if (facts.size === 0) return facts;

  // One supplier-cost aggregation per distinct window start.
  const buckets = groupAccountIdsByWindowStart(
    new Map([...facts.entries()].map(([accountId, fact]) => [accountId, fact.windowStartMs])),
    [...facts.keys()],
    Math.floor(nowMs / 3_600_000) * 3_600_000,
  );
  for (const [startMs, bucketIds] of buckets) {
    const costs = await database.query<{ account_id: string; total: unknown }>(
      `SELECT attempt.account_id AS account_id,
              coalesce(sum(cost.amount_minor_units), 0)::bigint AS total
         FROM saas_attempt_supplier_costs cost
         JOIN saas_attempts attempt
           ON attempt.tenant_id = cost.tenant_id AND attempt.id = cost.attempt_id
        WHERE attempt.account_id = ANY($1::text[])
          AND cost.created_at >= $2::timestamptz
        GROUP BY attempt.account_id`,
      [bucketIds, new Date(startMs).toISOString()],
    );
    const usageByAccount = new Map<string, bigint>();
    for (const row of costs.rows) {
      if (typeof row.account_id !== 'string' || row.account_id === '') continue;
      const parsed =
        typeof row.total === 'bigint'
          ? row.total
          : typeof row.total === 'string' && /^([0-9]+)$/.test(row.total)
            ? BigInt(row.total)
            : 0n;
      usageByAccount.set(row.account_id, parsed >= 0n ? parsed : 0n);
    }
    for (const accountId of bucketIds) {
      const fact = facts.get(accountId);
      if (fact === undefined) continue;
      // An account missing from the aggregation consumed nothing in the
      // window — usage reads as zero, exactly the window-stats precedent.
      facts.set(accountId, { ...fact, usageMinorUnits: usageByAccount.get(accountId) ?? 0n });
    }
  }
  return facts;
}
