import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch 3 CN-provider (zhipu / minimax) quota-window scheduling columns plus
 * the per-account dual-mode configuration columns (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三; sub2api reference:
 * backend/internal/service/domain_constants.go + account.go account_mode /
 * api_protocol + cn_provider_quota_service.go).
 *
 * Two column families land together, both following the 099/108
 * "scheduling-signal only" precedent on the two account owner tables:
 *
 * 1. Coding Plan quota-window snapshot columns
 *    (src/saas/supply/cn-providers-quota-worker.ts + its Postgres store):
 *    the worker periodically probes the provider's rolling-window quota
 *    endpoint (zhipu /api/monitor/usage/quota/limit without a Bearer prefix;
 *    minimax /v1/api/openplatform/coding_plan/remains) for accounts whose
 *    account_mode is 'coding' and overwrites the snapshot in place.
 *    - {zhipu,minimax}_{5h,weekly}_{used_percent,reset_at} carry the two
 *      upstream usage windows; used_percent is upstream-observed (zhipu
 *      percentage passthrough; minimax 100−remaining inversion), never
 *      extrapolated;
 *    - {provider}_usage_updated_at is the attempt stamp the store's SKIP
 *      LOCKED claim writes as its lease;
 *    - {provider}_usage_next_due_at is the worker-computed due horizon;
 *    - {provider}_usage_failure_count feeds the exponential backoff;
 *    - {provider}_rate_limited_until is the scheduling cooldown derived from
 *      a 429 Retry-After hint.
 *    The threshold-pause consumer (provider-account-scheduling-threshold.ts,
 *    migration 115) reads the 5h family under auto_pause_5h_threshold and
 *    the weekly family under auto_pause_7d_threshold.
 *
 * 2. Per-account dual-mode configuration columns (the platform/cn-providers
 *    account-config store, CAS with the 047/082 authz_version fence):
 *    - {provider}_account_mode: 'payg' (API-key metered; reactive-only
 *      balance detection, no quota endpoint) | 'coding' (Coding Plan
 *      subscription; rolling-window probing);
 *    - {provider}_api_protocol: 'chat_completions' | 'anthropic' |
 *      'responses' (minimax only; zhipu falls back) | 'adaptive' (the
 *      default: the native endpoint follows the inbound client protocol).
 *      Both are NULLable with NULL keeping the payg / adaptive defaults.
 *
 * Numbered 120 (batch-3 ledger assignment): 117–119 are reserved for the
 * parallel batch-3 platform workstreams (bedrock / vertex / grok); this
 * migration registers the cn-providers tail.
 */
const cnProviderAccountSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN zhipu_5h_used_percent real,
  ADD COLUMN zhipu_5h_reset_at timestamptz,
  ADD COLUMN zhipu_weekly_used_percent real,
  ADD COLUMN zhipu_weekly_reset_at timestamptz,
  ADD COLUMN zhipu_usage_updated_at timestamptz,
  ADD COLUMN zhipu_usage_next_due_at timestamptz,
  ADD COLUMN zhipu_usage_failure_count integer,
  ADD COLUMN zhipu_rate_limited_until timestamptz,
  ADD COLUMN zhipu_account_mode text,
  ADD COLUMN zhipu_api_protocol text,
  ADD COLUMN minimax_5h_used_percent real,
  ADD COLUMN minimax_5h_reset_at timestamptz,
  ADD COLUMN minimax_weekly_used_percent real,
  ADD COLUMN minimax_weekly_reset_at timestamptz,
  ADD COLUMN minimax_usage_updated_at timestamptz,
  ADD COLUMN minimax_usage_next_due_at timestamptz,
  ADD COLUMN minimax_usage_failure_count integer,
  ADD COLUMN minimax_rate_limited_until timestamptz,
  ADD COLUMN minimax_account_mode text,
  ADD COLUMN minimax_api_protocol text,
  ADD CONSTRAINT saas_tenant_provider_accounts_zhipu_percent_range
    CHECK (
      (zhipu_5h_used_percent IS NULL OR zhipu_5h_used_percent >= 0)
      AND (zhipu_weekly_used_percent IS NULL OR zhipu_weekly_used_percent >= 0)
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_zhipu_failure_count_range
    CHECK (zhipu_usage_failure_count IS NULL OR zhipu_usage_failure_count >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_zhipu_account_mode_shape
    CHECK (zhipu_account_mode IS NULL OR zhipu_account_mode IN ('payg', 'coding')),
  ADD CONSTRAINT saas_tenant_provider_accounts_zhipu_api_protocol_shape
    CHECK (
      zhipu_api_protocol IS NULL
      OR zhipu_api_protocol IN ('chat_completions', 'anthropic', 'responses', 'adaptive')
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_minimax_percent_range
    CHECK (
      (minimax_5h_used_percent IS NULL OR minimax_5h_used_percent >= 0)
      AND (minimax_weekly_used_percent IS NULL OR minimax_weekly_used_percent >= 0)
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_minimax_failure_count_range
    CHECK (minimax_usage_failure_count IS NULL OR minimax_usage_failure_count >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_minimax_account_mode_shape
    CHECK (minimax_account_mode IS NULL OR minimax_account_mode IN ('payg', 'coding')),
  ADD CONSTRAINT saas_tenant_provider_accounts_minimax_api_protocol_shape
    CHECK (
      minimax_api_protocol IS NULL
      OR minimax_api_protocol IN ('chat_completions', 'anthropic', 'responses', 'adaptive')
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN zhipu_5h_used_percent real,
  ADD COLUMN zhipu_5h_reset_at timestamptz,
  ADD COLUMN zhipu_weekly_used_percent real,
  ADD COLUMN zhipu_weekly_reset_at timestamptz,
  ADD COLUMN zhipu_usage_updated_at timestamptz,
  ADD COLUMN zhipu_usage_next_due_at timestamptz,
  ADD COLUMN zhipu_usage_failure_count integer,
  ADD COLUMN zhipu_rate_limited_until timestamptz,
  ADD COLUMN zhipu_account_mode text,
  ADD COLUMN zhipu_api_protocol text,
  ADD COLUMN minimax_5h_used_percent real,
  ADD COLUMN minimax_5h_reset_at timestamptz,
  ADD COLUMN minimax_weekly_used_percent real,
  ADD COLUMN minimax_weekly_reset_at timestamptz,
  ADD COLUMN minimax_usage_updated_at timestamptz,
  ADD COLUMN minimax_usage_next_due_at timestamptz,
  ADD COLUMN minimax_usage_failure_count integer,
  ADD COLUMN minimax_rate_limited_until timestamptz,
  ADD COLUMN minimax_account_mode text,
  ADD COLUMN minimax_api_protocol text,
  ADD CONSTRAINT saas_platform_provider_accounts_zhipu_percent_range
    CHECK (
      (zhipu_5h_used_percent IS NULL OR zhipu_5h_used_percent >= 0)
      AND (zhipu_weekly_used_percent IS NULL OR zhipu_weekly_used_percent >= 0)
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_zhipu_failure_count_range
    CHECK (zhipu_usage_failure_count IS NULL OR zhipu_usage_failure_count >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_zhipu_account_mode_shape
    CHECK (zhipu_account_mode IS NULL OR zhipu_account_mode IN ('payg', 'coding')),
  ADD CONSTRAINT saas_platform_provider_accounts_zhipu_api_protocol_shape
    CHECK (
      zhipu_api_protocol IS NULL
      OR zhipu_api_protocol IN ('chat_completions', 'anthropic', 'responses', 'adaptive')
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_minimax_percent_range
    CHECK (
      (minimax_5h_used_percent IS NULL OR minimax_5h_used_percent >= 0)
      AND (minimax_weekly_used_percent IS NULL OR minimax_weekly_used_percent >= 0)
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_minimax_failure_count_range
    CHECK (minimax_usage_failure_count IS NULL OR minimax_usage_failure_count >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_minimax_account_mode_shape
    CHECK (minimax_account_mode IS NULL OR minimax_account_mode IN ('payg', 'coding')),
  ADD CONSTRAINT saas_platform_provider_accounts_minimax_api_protocol_shape
    CHECK (
      minimax_api_protocol IS NULL
      OR minimax_api_protocol IN ('chat_completions', 'anthropic', 'responses', 'adaptive')
    );

CREATE INDEX saas_tenant_provider_accounts_zhipu_usage_due_idx
  ON saas_tenant_provider_accounts (zhipu_usage_next_due_at, id)
  WHERE status = 'active';

CREATE INDEX saas_tenant_provider_accounts_minimax_usage_due_idx
  ON saas_tenant_provider_accounts (minimax_usage_next_due_at, id)
  WHERE status = 'active';

CREATE INDEX saas_platform_provider_accounts_zhipu_usage_due_idx
  ON saas_platform_provider_accounts (zhipu_usage_next_due_at, id)
  WHERE status = 'active';

CREATE INDEX saas_platform_provider_accounts_minimax_usage_due_idx
  ON saas_platform_provider_accounts (minimax_usage_next_due_at, id)
  WHERE status = 'active';
`;

export const CN_PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 120,
  name: 'cn_provider_account_scheduling',
  sql: cnProviderAccountSchedulingSql,
};
