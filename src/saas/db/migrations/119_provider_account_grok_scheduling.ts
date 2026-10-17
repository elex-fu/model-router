import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch-3 Grok scheduling signals (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Grok; the 099/100/108/111
 * scheduling-column precedent applied to the xAI surface). The gateway
 * quota-header parser writes these columns in place from observed
 * `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` response headers
 * (both the double-dash and single-dash spellings; the reset value is
 * disambiguated by magnitude — ms epoch / s epoch / relative seconds); the
 * billing probe writes the merged weekly/monthly snapshot into grok_billing.
 * The scheduler reads them as a skip signal only. They are a point-in-time
 * scheduling signal and never enter the billing path (093 quota-snapshot
 * precedent). NULL means "never observed" and keeps scheduling exactly on its
 * pre-grok behavior, so the columns are fully backward compatible and require
 * no backfill.
 *
 * - grok_5h_/grok_requests_ pairs carry the token (primary) and request
 *   quota windows: used_percent is upstream-observed ((limit − remaining) /
 *   limit × 100), never extrapolated; reset_at is the disambiguated epoch.
 * - grok_rate_limited_until is the 429 cooldown deadline (retry-after
 *   derived; the claude/gemini precedent).
 * - grok_subscription_tier is the access-token-derived tier (snake_case; the
 *   ONLY trusted tier source — response headers are advisory cross-checks
 *   and never overwrite it).
 * - grok_billing is the merged weekly (`/billing?format=credits`) + monthly
 *   (`/billing`) probe snapshot (jsonb: usage percent, monthly limit cents,
 *   plan via $150 SuperGrok / $1,500 Heavy, period bounds, partial flags);
 *   grok_billing_updated_at stamps the last probe.
 * - grok_usage_updated_at stamps the last quota-header observation.
 *
 * The probe-category CHECK rewrite on saas_probe_monitors (migration 109's
 * provider_category constraint, last extended by 111) admits the batch-3
 * grok probe category (src/saas/supply/account-probe-service.ts
 * buildGrokProbe). Same-table constraint rewrite, no data change. Batch-3
 * chain coordination: 119 applies AFTER the parallel Bedrock 117, whose
 * CHECK rewrite admits 'bedrock' — this rewrite must therefore stay
 * cumulative and carry 'bedrock' forward (the 109→111 chain precedent);
 * the parallel Vertex 118 workstream must do the same here when it lands.
 *
 * Numbered 119: 117/118 stay reserved for the parallel batch-3 Bedrock /
 * Vertex workstreams; 119 is the next slot the grok task was assigned.
 */
const providerAccountGrokSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN grok_5h_used_percent real,
  ADD COLUMN grok_5h_reset_at timestamptz,
  ADD COLUMN grok_requests_used_percent real,
  ADD COLUMN grok_requests_reset_at timestamptz,
  ADD COLUMN grok_rate_limited_until timestamptz,
  ADD COLUMN grok_usage_updated_at timestamptz,
  ADD COLUMN grok_subscription_tier text,
  ADD COLUMN grok_billing jsonb,
  ADD COLUMN grok_billing_updated_at timestamptz,
  ADD CONSTRAINT saas_tenant_provider_accounts_grok_5h_percent_range
    CHECK (grok_5h_used_percent IS NULL OR grok_5h_used_percent >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_grok_requests_percent_range
    CHECK (grok_requests_used_percent IS NULL OR grok_requests_used_percent >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_grok_subscription_tier_shape
    CHECK (
      grok_subscription_tier IS NULL
      OR (btrim(grok_subscription_tier) = grok_subscription_tier AND grok_subscription_tier <> '' AND length(grok_subscription_tier) <= 64)
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN grok_5h_used_percent real,
  ADD COLUMN grok_5h_reset_at timestamptz,
  ADD COLUMN grok_requests_used_percent real,
  ADD COLUMN grok_requests_reset_at timestamptz,
  ADD COLUMN grok_rate_limited_until timestamptz,
  ADD COLUMN grok_usage_updated_at timestamptz,
  ADD COLUMN grok_subscription_tier text,
  ADD COLUMN grok_billing jsonb,
  ADD COLUMN grok_billing_updated_at timestamptz,
  ADD CONSTRAINT saas_platform_provider_accounts_grok_5h_percent_range
    CHECK (grok_5h_used_percent IS NULL OR grok_5h_used_percent >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_grok_requests_percent_range
    CHECK (grok_requests_used_percent IS NULL OR grok_requests_used_percent >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_grok_subscription_tier_shape
    CHECK (
      grok_subscription_tier IS NULL
      OR (btrim(grok_subscription_tier) = grok_subscription_tier AND grok_subscription_tier <> '' AND length(grok_subscription_tier) <= 64)
    );

ALTER TABLE saas_probe_monitors
  DROP CONSTRAINT saas_probe_monitors_provider_category_check,
  ADD CONSTRAINT saas_probe_monitors_provider_category_check
    CHECK (provider_category IN ('claude', 'codex', 'opencode-go', 'api-key', 'gemini', 'grok', 'bedrock', 'vertex'));
`;

export const PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 119,
  name: 'provider_account_grok_scheduling',
  sql: providerAccountGrokSchedulingSql,
};
