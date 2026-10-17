import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch-3 Bedrock scheduling signals (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三; the 111 gemini
 * precedent at the minimal defensible size). Scheduling signal only —
 * never billing (the 093 quota-snapshot red line).
 *
 * Scope decision (the roadmap's "如品类无需特殊调度列可只做凭据/probe 相关
 * 表，说明理由" clause): Bedrock responses expose NO quota windows — there
 * are no x-ratelimit headers, no per-tier request pools and the
 * invocationMetrics block carries token counts, not window limits. The
 * single observable scheduling signal is the ThrottlingException cooldown:
 *
 * - bedrock_rate_limited_until: the 429/ThrottlingException cooldown
 *   deadline (retry-after/modeled hint, else the 60s default), written by
 *   the quota-snapshot store's bedrock rate-limit sink (the gemini
 *   writeGeminiRateLimited precedent) and cleared on the next successful
 *   snapshot write;
 * - bedrock_usage_updated_at: the last observation stamp (the 111
 *   gemini_usage_updated_at precedent, kept for the future usage worker's
 *   claim debounce and to make the column family self-describing).
 *
 * Both columns are nullable with no backfill: NULL means "never observed"
 * and keeps scheduling exactly on its pre-batch-3 behavior.
 *
 * The same migration rewrites saas_probe_monitors' provider_category CHECK
 * (the 109 constraint, last rewritten by 111) to admit the batch-3
 * 'bedrock' probe category (src/saas/supply/account-probe-service.ts
 * buildBedrockProbe). Same-table constraint rewrite, no data change.
 *
 * Numbered 117: 116 is the applied head (batch-2 §2.4 TLS fingerprints);
 * 117 is the next free slot.
 */
const providerAccountBedrockSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN bedrock_rate_limited_until timestamptz,
  ADD COLUMN bedrock_usage_updated_at timestamptz;

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN bedrock_rate_limited_until timestamptz,
  ADD COLUMN bedrock_usage_updated_at timestamptz;

ALTER TABLE saas_probe_monitors
  DROP CONSTRAINT saas_probe_monitors_provider_category_check,
  ADD CONSTRAINT saas_probe_monitors_provider_category_check
    CHECK (provider_category IN ('claude', 'codex', 'opencode-go', 'api-key', 'gemini', 'bedrock'));
`;

export const PROVIDER_ACCOUNT_BEDROCK_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 117,
  name: 'provider_account_bedrock_scheduling',
  sql: providerAccountBedrockSchedulingSql,
};
