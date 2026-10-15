import type { SaasMigration } from './001_initial_schema.js';

/**
 * R5 Claude subscription scheduling signals (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5 第三步). Mirrors the
 * 099 codex scheduling precedent: the gateway quota-header classifier and the
 * usage snapshot fetcher write these columns from observed
 * `anthropic-ratelimit-unified-*` response headers and
 * `GET /api/oauth/usage`; the scheduler reads them as a skip signal only.
 * They are a point-in-time scheduling signal and never enter the billing
 * path (093 quota-snapshot precedent). NULL means "never observed" and keeps
 * scheduling exactly on its pre-R5 behavior, so the columns are fully
 * backward compatible and require no backfill.
 *
 * - claude_5h_/claude_7d_/claude_7d_sonnet_/claude_7d_oi_ pairs carry the
 *   four usage windows (utilization is the upstream-observed 0..1+ fraction,
 *   never extrapolated; 7d_oi is the Fable-only overage-included window the
 *   response headers label 7d_oi).
 * - claude_usage_updated_at stamps the last snapshot refresh.
 * - claude_session_window_start/end record the [reset−5h, reset] session
 *   window a 429 classification derived.
 * - claude_cli_version_override is the per-account operator override for the
 *   advertised CLI version pin (identity.ts validates it: strict three-part
 *   semver, not older than the built-in pin; NULL keeps the pin).
 *
 * Numbered 100: 099's header reserved this slot for the claude
 * scheduling-column family (its account-plan metadata lives inside the
 * sealed credential envelope, so 099 needed no second migration).
 */
const providerAccountClaudeSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN claude_5h_utilization real,
  ADD COLUMN claude_5h_reset_at timestamptz,
  ADD COLUMN claude_7d_utilization real,
  ADD COLUMN claude_7d_reset_at timestamptz,
  ADD COLUMN claude_7d_sonnet_utilization real,
  ADD COLUMN claude_7d_sonnet_reset_at timestamptz,
  ADD COLUMN claude_7d_oi_utilization real,
  ADD COLUMN claude_7d_oi_reset_at timestamptz,
  ADD COLUMN claude_usage_updated_at timestamptz,
  ADD COLUMN claude_session_window_start timestamptz,
  ADD COLUMN claude_session_window_end timestamptz,
  ADD COLUMN claude_cli_version_override text,
  ADD CONSTRAINT saas_tenant_provider_accounts_claude_5h_utilization_range
    CHECK (claude_5h_utilization IS NULL OR claude_5h_utilization >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_claude_7d_utilization_range
    CHECK (claude_7d_utilization IS NULL OR claude_7d_utilization >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_claude_7d_sonnet_utilization_range
    CHECK (claude_7d_sonnet_utilization IS NULL OR claude_7d_sonnet_utilization >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_claude_7d_oi_utilization_range
    CHECK (claude_7d_oi_utilization IS NULL OR claude_7d_oi_utilization >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_claude_session_window_order
    CHECK (
      claude_session_window_start IS NULL
      OR claude_session_window_end IS NULL
      OR claude_session_window_start < claude_session_window_end
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_claude_cli_version_shape
    CHECK (
      claude_cli_version_override IS NULL
      OR claude_cli_version_override ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN claude_5h_utilization real,
  ADD COLUMN claude_5h_reset_at timestamptz,
  ADD COLUMN claude_7d_utilization real,
  ADD COLUMN claude_7d_reset_at timestamptz,
  ADD COLUMN claude_7d_sonnet_utilization real,
  ADD COLUMN claude_7d_sonnet_reset_at timestamptz,
  ADD COLUMN claude_7d_oi_utilization real,
  ADD COLUMN claude_7d_oi_reset_at timestamptz,
  ADD COLUMN claude_usage_updated_at timestamptz,
  ADD COLUMN claude_session_window_start timestamptz,
  ADD COLUMN claude_session_window_end timestamptz,
  ADD COLUMN claude_cli_version_override text,
  ADD CONSTRAINT saas_platform_provider_accounts_claude_5h_utilization_range
    CHECK (claude_5h_utilization IS NULL OR claude_5h_utilization >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_claude_7d_utilization_range
    CHECK (claude_7d_utilization IS NULL OR claude_7d_utilization >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_claude_7d_sonnet_utilization_range
    CHECK (claude_7d_sonnet_utilization IS NULL OR claude_7d_sonnet_utilization >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_claude_7d_oi_utilization_range
    CHECK (claude_7d_oi_utilization IS NULL OR claude_7d_oi_utilization >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_claude_session_window_order
    CHECK (
      claude_session_window_start IS NULL
      OR claude_session_window_end IS NULL
      OR claude_session_window_start < claude_session_window_end
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_claude_cli_version_shape
    CHECK (
      claude_cli_version_override IS NULL
      OR claude_cli_version_override ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'
    );
`;

export const PROVIDER_ACCOUNT_CLAUDE_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 100,
  name: 'provider_account_claude_scheduling',
  sql: providerAccountClaudeSchedulingSql,
};
