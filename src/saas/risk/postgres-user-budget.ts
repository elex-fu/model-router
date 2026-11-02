import type { SqlExecutor } from '../db/types.js';
import { evaluateProxyKeyBudgetAdmission, type ProxyKeyBudgetDimension } from '../keys/budget-policy.js';
import type { KeyBudgetUtcDay } from '../keys/budget-policy-contract.js';
import { KeyBudgetStoreError, keyBudgetDayColumn } from '../keys/budget-store.js';
import { mapUserLimitPolicy } from './postgres-user-limits.js';
import { type UserLimitPolicy, userDailyBudgetConfigured } from './user-limits.js';

export interface UserDailyBudgetReservation {
  readonly tenantId: string;
  readonly projectId: string;
  readonly keyId: string;
  readonly requestId: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly day: KeyBudgetUtcDay;
  readonly tokenUnits: string;
  readonly chargeMinorUnits: string;
  readonly chargeCurrency: string | null;
}

interface AuthorityRow extends Record<string, unknown> {
  principal_user_id: unknown;
  requests_per_minute: unknown;
  max_concurrent_requests: unknown;
  daily_token_units: unknown;
  daily_charge_minor_units: unknown;
  charge_currency: unknown;
}

function exact(value: unknown): bigint {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value));
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new KeyBudgetStoreError('STORAGE_ERROR');
  }
}

function subtract(total: bigint, current: bigint): string {
  const result = total - current;
  if (result < 0n) throw new KeyBudgetStoreError('STORAGE_ERROR');
  return result.toString(10);
}

/**
 * Add a user-wide daily ceiling on top of the migration-081 key reservation.
 * The just-created reservation is already present in the aggregate, so it is
 * subtracted into outstandingReserved and re-exposed as newReservation to the
 * existing exact evaluator. Denial is returned to the caller, which throws and
 * rolls back the original key reservation, wallet hold and all other effects.
 */
export async function evaluatePostgresUserDailyBudget(
  executor: SqlExecutor,
  facts: UserDailyBudgetReservation,
): Promise<ProxyKeyBudgetDimension | null> {
  const authorityResult = await executor.query<AuthorityRow>(
    `SELECT k.principal_user_id,
            COALESCE(u.requests_per_minute, d.requests_per_minute) AS requests_per_minute,
            COALESCE(u.max_concurrent_requests, d.max_concurrent_requests) AS max_concurrent_requests,
            COALESCE(u.daily_token_units, d.daily_token_units) AS daily_token_units,
            COALESCE(u.daily_charge_minor_units, d.daily_charge_minor_units) AS daily_charge_minor_units,
            COALESCE(u.charge_currency, d.charge_currency) AS charge_currency
       FROM saas_api_keys k
       CROSS JOIN saas_user_limit_defaults d
       LEFT JOIN saas_user_limit_policies u ON u.user_id = k.principal_user_id
      WHERE k.tenant_id = $1 AND k.project_id = $2 AND k.id = $3 AND d.id = 1
      LIMIT 2`,
    [facts.tenantId, facts.projectId, facts.keyId],
  );
  if (authorityResult.rows.length !== 1) throw new KeyBudgetStoreError('STORAGE_ERROR');
  const authority = authorityResult.rows[0];
  if (typeof authority.principal_user_id !== 'string') return null;
  const policy: UserLimitPolicy = mapUserLimitPolicy(authority);
  if (!userDailyBudgetConfigured(policy)) return null;
  const userId = authority.principal_user_id;

  // The aggregate spans all of a user's keys and tenants. Unlike a per-lineage
  // counter upsert, it therefore needs an explicit user-wide exclusive fence.
  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `model-router:user-daily-budget:${userId}`,
  ]);

  const usageResult = await executor.query<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(r.token_units) FILTER (WHERE r.state = 'settled'), 0)::text AS settled_tokens,
       COALESCE(SUM(r.token_units) FILTER (WHERE r.state = 'outstanding'), 0)::text AS outstanding_tokens,
       COALESCE(SUM(r.charge_minor_units) FILTER (
         WHERE r.state = 'settled' AND r.charge_currency = $3), 0)::text AS settled_charge,
       COALESCE(SUM(r.charge_minor_units) FILTER (
         WHERE r.state = 'outstanding' AND r.charge_currency = $3), 0)::text AS outstanding_charge,
       EXISTS(
         SELECT 1 FROM saas_api_key_budget_reservations other
         JOIN saas_api_keys other_key ON other_key.tenant_id = other.tenant_id
          AND other_key.project_id = other.project_id AND other_key.id = other.lineage_id
         WHERE other_key.principal_user_id = $1 AND other.day = $2
           AND other.state <> 'released' AND other.charge_minor_units > 0
           AND other.request_id <> $4
           AND $3::text IS NOT NULL
           AND other.charge_currency IS DISTINCT FROM $3
       ) AS mixed_charge_currencies
       FROM saas_api_key_budget_reservations r
       JOIN saas_api_keys k ON k.tenant_id = r.tenant_id
        AND k.project_id = r.project_id AND k.id = r.lineage_id
      WHERE k.principal_user_id = $1 AND r.day = $2 AND r.state <> 'released'`,
    [userId, keyBudgetDayColumn(facts.day), policy.chargeCurrency, facts.requestId],
  );
  if (usageResult.rows.length !== 1) throw new KeyBudgetStoreError('STORAGE_ERROR');
  const usage = usageResult.rows[0];
  if (usage.mixed_charge_currencies === true) throw new KeyBudgetStoreError('STORAGE_ERROR');
  const tokenUnits = exact(facts.tokenUnits);
  const chargeUnits = exact(facts.chargeMinorUnits);
  const chargeCurrency = facts.chargeCurrency ?? policy.chargeCurrency;
  if (
    facts.supplyMode === 'platform' &&
    policy.dailyChargeMinorUnits !== null &&
    (chargeCurrency === null || chargeCurrency !== policy.chargeCurrency)
  ) {
    throw new KeyBudgetStoreError('STORAGE_ERROR');
  }
  const tokenUsage = {
    daily: {
      settled: exact(usage.settled_tokens).toString(10),
      outstandingReserved: subtract(exact(usage.outstanding_tokens), tokenUnits),
      newReservation: tokenUnits.toString(10),
    },
  };
  const customerChargeUsage = {
    currency: chargeCurrency ?? policy.chargeCurrency ?? 'USD',
    daily: {
      settled: exact(usage.settled_charge).toString(10),
      outstandingReserved: subtract(exact(usage.outstanding_charge), chargeUnits),
      newReservation: chargeUnits.toString(10),
    },
  };
  const verdict = evaluateProxyKeyBudgetAdmission(
    facts.supplyMode === 'byok'
      ? { supplyMode: 'byok', tokenCaps: { daily: policy.dailyTokenUnits, lifetime: null } }
      : {
          supplyMode: 'platform',
          tokenCaps: { daily: policy.dailyTokenUnits, lifetime: null },
          ...(policy.dailyChargeMinorUnits !== null
            ? {
                customerChargeCaps: {
                  currency: policy.chargeCurrency as string,
                  daily: policy.dailyChargeMinorUnits,
                  lifetime: null,
                },
              }
            : {}),
        },
    facts.supplyMode === 'byok'
      ? { supplyMode: 'byok', tokenUsage }
      : {
          supplyMode: 'platform',
          tokenUsage,
          ...(policy.dailyChargeMinorUnits !== null ? { customerChargeUsage } : {}),
        },
  );
  return verdict.allowed ? null : verdict.deniedDimension;
}
