import type { SaasMigration } from './001_initial_schema.js';

/**
 * Kimi Coding joins the existing account quota snapshots and scheduling
 * threshold gate. These are upstream observations, never wallet balances.
 * Poll attempts have their own stamp: a claim or failure cannot refresh a
 * previously successful window. Pre-135 CN timestamps mixed these facts,
 * so their old successful freshness is conservatively unknown until polled.
 */
const sql = ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']
  .map(
    (table) => `
ALTER TABLE ${table}
  ADD COLUMN kimi_5h_used_percent real,
  ADD COLUMN kimi_5h_reset_at timestamptz,
  ADD COLUMN kimi_weekly_used_percent real,
  ADD COLUMN kimi_weekly_reset_at timestamptz,
  ADD COLUMN kimi_usage_updated_at timestamptz,
  ADD COLUMN kimi_usage_attempted_at timestamptz,
  ADD COLUMN kimi_usage_next_due_at timestamptz,
  ADD COLUMN kimi_usage_failure_count integer,
  ADD COLUMN kimi_rate_limited_until timestamptz,
  ADD COLUMN zhipu_usage_attempted_at timestamptz,
  ADD COLUMN minimax_usage_attempted_at timestamptz,
  ADD CONSTRAINT ${table}_kimi_percent_range CHECK (
    (kimi_5h_used_percent IS NULL OR (kimi_5h_used_percent >= 0 AND kimi_5h_used_percent <= 100))
    AND (kimi_weekly_used_percent IS NULL OR (kimi_weekly_used_percent >= 0 AND kimi_weekly_used_percent <= 100))
  ),
  ADD CONSTRAINT ${table}_kimi_failure_count_range
    CHECK (kimi_usage_failure_count IS NULL OR kimi_usage_failure_count >= 0);

UPDATE ${table}
   SET zhipu_usage_attempted_at = zhipu_usage_updated_at,
       minimax_usage_attempted_at = minimax_usage_updated_at,
       zhipu_usage_updated_at = NULL,
       minimax_usage_updated_at = NULL
 WHERE zhipu_usage_updated_at IS NOT NULL OR minimax_usage_updated_at IS NOT NULL;

CREATE INDEX ${table}_kimi_usage_due_idx
  ON ${table} (kimi_usage_next_due_at, id)
  WHERE status = 'active' AND provider_id = 'kimi' AND product_id IN ('kimi-code', 'kimi-code-global');
`,
  )
  .join('\n');

export const KIMI_CODING_QUOTA_SNAPSHOTS_SAAS_MIGRATION: SaasMigration = {
  version: 135,
  name: 'kimi_coding_quota_snapshots',
  sql,
};
