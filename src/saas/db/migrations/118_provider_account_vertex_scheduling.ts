import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch-3 Vertex AI service-account scheduling signals (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; the 111
 * gemini / 117 bedrock precedents at the minimal defensible size).
 * Scheduling signal only — never billing (the 093 quota-snapshot red line).
 *
 * Scope decision: Vertex service accounts are pay-as-you-go — the upstream
 * exposes NO daily quota windows (no tier RPD pools, no Pacific-midnight
 * reset; the sub2api adjudication in gemini_messages_compat_service.go:
 * "Vertex 按量付费：短窗限速，无每日配额"). The observable scheduling signal is
 * the 429 cooldown alone:
 *
 * - vertex_rate_limited_until: the 429 cooldown deadline (retry-after, else
 *   the google.rpc.RetryInfo retryDelay capped at 15 minutes, else the
 *   60-second pay-as-you-go fallback), written by the quota-snapshot
 *   store's vertex rate-limit sink (the gemini writeGeminiRateLimited
 *   precedent);
 * - vertex_usage_updated_at: the last observation stamp (the 111
 *   gemini_usage_updated_at precedent — the token-refresher due predicate
 *   debounce and self-describing column family).
 *
 * Both columns are nullable with no backfill: NULL means "never observed"
 * and keeps scheduling exactly on its pre-batch-3 behavior.
 *
 * The same migration rewrites saas_probe_monitors' provider_category CHECK
 * (the 109 constraint, last rewritten by 117) to admit the batch-3 'vertex'
 * probe category (src/saas/supply/account-probe-service.ts
 * buildVertexProbe). Same-table constraint rewrite, no data change.
 *
 * Numbered 118: reserved for this workstream by the 117/119 batch-3
 * siblings (117 Bedrock, 119 Grok land around it).
 */
const providerAccountVertexSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN vertex_rate_limited_until timestamptz,
  ADD COLUMN vertex_usage_updated_at timestamptz;

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN vertex_rate_limited_until timestamptz,
  ADD COLUMN vertex_usage_updated_at timestamptz;

ALTER TABLE saas_probe_monitors
  DROP CONSTRAINT saas_probe_monitors_provider_category_check,
  ADD CONSTRAINT saas_probe_monitors_provider_category_check
    CHECK (provider_category IN ('claude', 'codex', 'opencode-go', 'api-key', 'gemini', 'bedrock', 'vertex'));
`;

export const PROVIDER_ACCOUNT_VERTEX_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 118,
  name: 'provider_account_vertex_scheduling',
  sql: providerAccountVertexSchedulingSql,
};
