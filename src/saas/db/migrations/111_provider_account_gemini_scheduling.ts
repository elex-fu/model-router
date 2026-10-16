import type { SaasMigration } from './001_initial_schema.js';

/**
 * F4 Gemini subscription scheduling signals (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). Mirrors the
 * 099/100/108 scheduling-column precedents: the gateway quota classifier and
 * the locally-aggregated usage accounting write these columns; the scheduler
 * reads them as a skip signal only. They are a point-in-time scheduling
 * signal and never enter the billing path (093 quota-snapshot precedent).
 * NULL means "never observed" and keeps scheduling exactly on its pre-F4
 * behavior, so the columns are fully backward compatible and require no
 * backfill.
 *
 * Two column families land together because both are per-account provider
 * state introduced by the same F4 Gemini subscription workstream (the 108
 * precedent of one migration for one workstream's storage contract):
 *
 * 1. Usage/quota columns (src/saas/gateway/gemini/quota-usage.ts): Gemini
 *    daily quotas reset at Pacific midnight and are tier-shaped — a shared
 *    requests-per-day pool for Code Assist/Google One tiers, per-model-class
 *    (pro/flash) pools for AI Studio tiers, plus a rolling minute pool
 *    (sub2api service/gemini_quota.go semantics):
 *    - gemini_{shared,pro,flash}_daily_{used,limit} carry the daily windows
 *      (used is the locally-observed request count; limit is the tier RPD,
 *      -1 meaning unlimited/pay-as-you-go);
 *    - gemini_minute_{used,limit} carries the rolling-minute snapshot;
 *    - gemini_daily_reset_at stamps the next Pacific-midnight reset;
 *    - gemini_usage_updated_at stamps the last snapshot refresh;
 *    - gemini_rate_limited_until is the 429 cooldown deadline (tier-derived,
 *      retry-after/retry-info when the upstream carries one);
 *    - gemini_tier_id is the canonical quota tier (normalized from the
 *      loadCodeAssist allowed tiers; worker-written, never operator-set).
 *
 * 2. The probe-category CHECK rewrite on saas_probe_monitors (migration
 *    109's provider_category constraint): the F4 gemini probe category
 *    (src/saas/supply/account-probe-service.ts buildGeminiProbe) extends the
 *    same closed vocabulary — 'claude' | 'codex' | 'opencode-go' |
 *    'api-key' | 'gemini'. Same-table constraint rewrite, no data change.
 *
 * Numbered 111: 110 is taken by the parallel F1 platform-settings
 * workstream (documented in its registration comment); 111 is the next free
 * slot after the applied 110 head.
 */
const providerAccountGeminiSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN gemini_shared_daily_used integer,
  ADD COLUMN gemini_shared_daily_limit integer,
  ADD COLUMN gemini_pro_daily_used integer,
  ADD COLUMN gemini_pro_daily_limit integer,
  ADD COLUMN gemini_flash_daily_used integer,
  ADD COLUMN gemini_flash_daily_limit integer,
  ADD COLUMN gemini_minute_used integer,
  ADD COLUMN gemini_minute_limit integer,
  ADD COLUMN gemini_daily_reset_at timestamptz,
  ADD COLUMN gemini_usage_updated_at timestamptz,
  ADD COLUMN gemini_rate_limited_until timestamptz,
  ADD COLUMN gemini_tier_id text,
  ADD CONSTRAINT saas_tenant_provider_accounts_gemini_daily_used_range
    CHECK (
      (gemini_shared_daily_used IS NULL OR gemini_shared_daily_used >= 0)
      AND (gemini_pro_daily_used IS NULL OR gemini_pro_daily_used >= 0)
      AND (gemini_flash_daily_used IS NULL OR gemini_flash_daily_used >= 0)
      AND (gemini_minute_used IS NULL OR gemini_minute_used >= 0)
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_gemini_daily_limit_range
    CHECK (
      (gemini_shared_daily_limit IS NULL OR gemini_shared_daily_limit >= -1)
      AND (gemini_pro_daily_limit IS NULL OR gemini_pro_daily_limit >= -1)
      AND (gemini_flash_daily_limit IS NULL OR gemini_flash_daily_limit >= -1)
      AND (gemini_minute_limit IS NULL OR gemini_minute_limit >= -1)
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_gemini_tier_id_shape
    CHECK (
      gemini_tier_id IS NULL
      OR (btrim(gemini_tier_id) = gemini_tier_id AND gemini_tier_id <> '' AND length(gemini_tier_id) <= 64)
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN gemini_shared_daily_used integer,
  ADD COLUMN gemini_shared_daily_limit integer,
  ADD COLUMN gemini_pro_daily_used integer,
  ADD COLUMN gemini_pro_daily_limit integer,
  ADD COLUMN gemini_flash_daily_used integer,
  ADD COLUMN gemini_flash_daily_limit integer,
  ADD COLUMN gemini_minute_used integer,
  ADD COLUMN gemini_minute_limit integer,
  ADD COLUMN gemini_daily_reset_at timestamptz,
  ADD COLUMN gemini_usage_updated_at timestamptz,
  ADD COLUMN gemini_rate_limited_until timestamptz,
  ADD COLUMN gemini_tier_id text,
  ADD CONSTRAINT saas_platform_provider_accounts_gemini_daily_used_range
    CHECK (
      (gemini_shared_daily_used IS NULL OR gemini_shared_daily_used >= 0)
      AND (gemini_pro_daily_used IS NULL OR gemini_pro_daily_used >= 0)
      AND (gemini_flash_daily_used IS NULL OR gemini_flash_daily_used >= 0)
      AND (gemini_minute_used IS NULL OR gemini_minute_used >= 0)
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_gemini_daily_limit_range
    CHECK (
      (gemini_shared_daily_limit IS NULL OR gemini_shared_daily_limit >= -1)
      AND (gemini_pro_daily_limit IS NULL OR gemini_pro_daily_limit >= -1)
      AND (gemini_flash_daily_limit IS NULL OR gemini_flash_daily_limit >= -1)
      AND (gemini_minute_limit IS NULL OR gemini_minute_limit >= -1)
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_gemini_tier_id_shape
    CHECK (
      gemini_tier_id IS NULL
      OR (btrim(gemini_tier_id) = gemini_tier_id AND gemini_tier_id <> '' AND length(gemini_tier_id) <= 64)
    );

ALTER TABLE saas_probe_monitors
  DROP CONSTRAINT saas_probe_monitors_provider_category_check,
  ADD CONSTRAINT saas_probe_monitors_provider_category_check
    CHECK (provider_category IN ('claude', 'codex', 'opencode-go', 'api-key', 'gemini'));
`;

export const PROVIDER_ACCOUNT_GEMINI_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 111,
  name: 'provider_account_gemini_scheduling',
  sql: providerAccountGeminiSchedulingSql,
};
