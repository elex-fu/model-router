import type { SaasDatabase } from '../db/types.js';
import {
  resetSaasProviderPoolGauge,
  type SaasProviderPoolCounts,
  setSaasProviderPoolCounts,
  setSaasWalletActiveHolds,
} from './metrics.js';

/**
 * Phase 3 observability: database-backed gauge refresh (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 1).
 *
 * Runs right before a Prometheus scrape (never inside it) so a slow or dead
 * database cannot wedge /metrics. Pool state mapping:
 * - 'error': account validation failed or quarantined;
 * - 'cooldown': runtime-health cooldown window still open;
 * - 'quota-paused': quota snapshot reports an exhausted balance;
 * - 'available': otherwise (healthy, degraded-but-released, or never probed).
 */

interface PoolGaugeRow {
  readonly provider_id: string;
  readonly available: number | string;
  readonly cooldown: number | string;
  readonly quota_paused: number | string;
  readonly error: number | string;
}

const POOL_GAUGE_SQL = `
WITH active_accounts AS (
  SELECT id, 'platform'::text AS scope, provider_id, validation_state, quota_state
  FROM saas_platform_provider_accounts WHERE status = 'active'
  UNION ALL
  SELECT id, tenant_id::text AS scope, provider_id, validation_state, quota_state
  FROM saas_tenant_provider_accounts WHERE status = 'active'
)
SELECT
  a.provider_id,
  COUNT(*) FILTER (WHERE a.validation_state IN ('failed', 'quarantined')) AS error,
  COUNT(*) FILTER (
    WHERE a.validation_state NOT IN ('failed', 'quarantined')
      AND h.state = 'cooldown'
      AND h.cooldown_until IS NOT NULL AND h.cooldown_until > now()
  ) AS cooldown,
  COUNT(*) FILTER (
    WHERE a.validation_state NOT IN ('failed', 'quarantined')
      AND (h.cooldown_until IS NULL OR h.cooldown_until <= now())
      AND a.quota_state = 'exhausted'
  ) AS quota_paused,
  COUNT(*) FILTER (
    WHERE a.validation_state NOT IN ('failed', 'quarantined')
      AND (h.cooldown_until IS NULL OR h.cooldown_until <= now())
      AND (a.quota_state IS NULL OR a.quota_state <> 'exhausted')
  ) AS available
FROM active_accounts a
LEFT JOIN saas_provider_account_runtime_health h
  ON h.account_id = a.id AND h.owner_scope_key = a.scope
GROUP BY a.provider_id
ORDER BY a.provider_id`;

/** Refreshes the account-pool and wallet-hold gauges from the database. */
export async function refreshSaasRuntimeGauges(database: SaasDatabase): Promise<void> {
  const pool = await database.query<PoolGaugeRow>(POOL_GAUGE_SQL);
  resetSaasProviderPoolGauge();
  for (const row of pool.rows) {
    const counts: SaasProviderPoolCounts = {
      available: Number(row.available ?? 0),
      cooldown: Number(row.cooldown ?? 0),
      'quota-paused': Number(row.quota_paused ?? 0),
      error: Number(row.error ?? 0),
    };
    setSaasProviderPoolCounts(row.provider_id, counts);
  }
  const holds = await database.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM saas_billing_reservations
     WHERE state IN ('reserved', 'reconciliation_pending')`,
  );
  setSaasWalletActiveHolds(Number(holds.rows[0]?.count ?? 0));
}
