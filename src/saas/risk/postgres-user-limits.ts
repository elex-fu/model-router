import type { SqlExecutor } from '../db/types.js';
import { resolveUserLimitPolicy, UNLIMITED_USER_LIMITS, type UserLimitPolicy } from './user-limits.js';

interface LimitRow extends Record<string, unknown> {
  requests_per_minute: unknown;
  max_concurrent_requests: unknown;
  daily_token_units: unknown;
  daily_charge_minor_units: unknown;
  charge_currency: unknown;
}

function exact(value: unknown): bigint | null | undefined {
  if (value === null || value === undefined) return null;
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value));
    return parsed >= 0n && parsed <= 9_223_372_036_854_775_807n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function mapUserLimitPolicy(row: LimitRow | null | undefined): UserLimitPolicy {
  if (!row) return UNLIMITED_USER_LIMITS;
  const values = [
    exact(row.requests_per_minute),
    exact(row.max_concurrent_requests),
    exact(row.daily_token_units),
    exact(row.daily_charge_minor_units),
  ];
  if (values.some((value) => value === undefined)) throw new Error('Malformed user limit policy');
  const [requestsPerMinute, maxConcurrentRequests, dailyTokenUnits, dailyChargeMinorUnits] = values as (
    | bigint
    | null
  )[];
  const currency = row.charge_currency;
  if (currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    throw new Error('Malformed user charge currency');
  }
  if ((dailyChargeMinorUnits === null) !== (currency === null)) {
    throw new Error('Malformed user charge ceiling');
  }
  return { requestsPerMinute, maxConcurrentRequests, dailyTokenUnits, dailyChargeMinorUnits, chargeCurrency: currency };
}

/**
 * Resolve from authoritative user/default rows. A null user_id represents a
 * project-service key: those keys retain tenant/project/key controls only.
 */
export async function selectUserLimitPolicy(executor: SqlExecutor, userId: string): Promise<UserLimitPolicy> {
  const result = await executor.query<LimitRow>(
    `SELECT COALESCE(u.requests_per_minute, d.requests_per_minute) AS requests_per_minute,
            COALESCE(u.max_concurrent_requests, d.max_concurrent_requests) AS max_concurrent_requests,
            COALESCE(u.daily_token_units, d.daily_token_units) AS daily_token_units,
            COALESCE(u.daily_charge_minor_units, d.daily_charge_minor_units) AS daily_charge_minor_units,
            COALESCE(u.charge_currency, d.charge_currency) AS charge_currency
       FROM saas_user_limit_defaults d
       LEFT JOIN saas_user_limit_policies u ON u.user_id = $1
      WHERE d.id = 1 LIMIT 2`,
    [userId],
  );
  if (result.rows.length !== 1) throw new Error('User limit defaults are unavailable');
  return mapUserLimitPolicy(result.rows[0]);
}

/** Testable pure equivalent of the SQL COALESCE projection above. */
export function resolveStoredUserLimits(defaults: LimitRow, override: LimitRow | null): UserLimitPolicy {
  return resolveUserLimitPolicy(mapUserLimitPolicy(defaults), override ? mapUserLimitPolicy(override) : null);
}
