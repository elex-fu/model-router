import type { SaasMigration } from './001_initial_schema.js';

/**
 * Phase 1b Codex subscription scheduling signals (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.1; the sub2api
 * x-codex-primary/secondary rate-limit header semantics). The gateway
 * quota-header parser writes these columns in place from observed
 * `x-codex-*-used-percent/-reset-after-seconds` response headers; the
 * scheduler reads them as a skip signal only. They are a point-in-time
 * scheduling signal and never enter the billing path, mirroring the 093
 * quota-snapshot precedent. NULL means "never observed" and keeps scheduling
 * exactly on its pre-P1b behavior, so the columns are fully backward
 * compatible and require no backfill.
 *
 * - codex_5h_/codex_7d_ pairs carry the two normalized usage windows
 *   (window_minutes <= 360 normalizes to the 5h window; anything larger is
 *   the 7d window). used_percent is upstream-observed, never extrapolated.
 * - auto_pause_*_threshold is the per-account operator override for the
 *   scheduling gate; NULL keeps the pool-level default.
 * - codex_fingerprint_mode/seed are the account-level opt-in identity
 *   fingerprint (default 'off' — the sub2api v0.1.175 quota-shrink incident
 *   is why this is opt-in). The seed is a random UUIDv4 identity-derivation
 *   input, not credential material: it never grants access and stays a
 *   plaintext scheduling column like priority/weight (082 precedent). The
 *   shape check pins seed presence to an enabled mode.
 *
 * Numbered 099 (no migration 100): the plan's optional "account plan
 * metadata" columns all live inside the sealed credential envelope
 * (plan_type, email, chatgpt ids), so 099 is sufficient on its own and 100
 * stays unoccupied for the next consumer (no stranded lower numbers behind
 * the head).
 */
const providerAccountCodexSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN codex_5h_used_percent real,
  ADD COLUMN codex_5h_reset_at timestamptz,
  ADD COLUMN codex_7d_used_percent real,
  ADD COLUMN codex_7d_reset_at timestamptz,
  ADD COLUMN codex_usage_updated_at timestamptz,
  ADD COLUMN auto_pause_5h_threshold real,
  ADD COLUMN auto_pause_7d_threshold real,
  ADD COLUMN codex_fingerprint_mode text DEFAULT 'off',
  ADD COLUMN codex_fingerprint_seed text,
  ADD CONSTRAINT saas_tenant_provider_accounts_codex_5h_percent_range
    CHECK (codex_5h_used_percent IS NULL OR codex_5h_used_percent >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_codex_7d_percent_range
    CHECK (codex_7d_used_percent IS NULL OR codex_7d_used_percent >= 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_auto_pause_5h_range
    CHECK (auto_pause_5h_threshold IS NULL OR (auto_pause_5h_threshold > 0 AND auto_pause_5h_threshold <= 100)),
  ADD CONSTRAINT saas_tenant_provider_accounts_auto_pause_7d_range
    CHECK (auto_pause_7d_threshold IS NULL OR (auto_pause_7d_threshold > 0 AND auto_pause_7d_threshold <= 100)),
  ADD CONSTRAINT saas_tenant_provider_accounts_codex_fingerprint_mode_values
    CHECK (codex_fingerprint_mode IS NULL OR codex_fingerprint_mode IN ('off', 'device', 'session', 'full')),
  ADD CONSTRAINT saas_tenant_provider_accounts_codex_fingerprint_seed_length
    CHECK (codex_fingerprint_seed IS NULL OR (btrim(codex_fingerprint_seed) <> '' AND char_length(codex_fingerprint_seed) <= 128)),
  ADD CONSTRAINT saas_tenant_provider_accounts_codex_fingerprint_shape
    CHECK (
      (codex_fingerprint_mode = 'off' OR codex_fingerprint_mode IS NULL) = (codex_fingerprint_seed IS NULL)
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN codex_5h_used_percent real,
  ADD COLUMN codex_5h_reset_at timestamptz,
  ADD COLUMN codex_7d_used_percent real,
  ADD COLUMN codex_7d_reset_at timestamptz,
  ADD COLUMN codex_usage_updated_at timestamptz,
  ADD COLUMN auto_pause_5h_threshold real,
  ADD COLUMN auto_pause_7d_threshold real,
  ADD COLUMN codex_fingerprint_mode text DEFAULT 'off',
  ADD COLUMN codex_fingerprint_seed text,
  ADD CONSTRAINT saas_platform_provider_accounts_codex_5h_percent_range
    CHECK (codex_5h_used_percent IS NULL OR codex_5h_used_percent >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_codex_7d_percent_range
    CHECK (codex_7d_used_percent IS NULL OR codex_7d_used_percent >= 0),
  ADD CONSTRAINT saas_platform_provider_accounts_auto_pause_5h_range
    CHECK (auto_pause_5h_threshold IS NULL OR (auto_pause_5h_threshold > 0 AND auto_pause_5h_threshold <= 100)),
  ADD CONSTRAINT saas_platform_provider_accounts_auto_pause_7d_range
    CHECK (auto_pause_7d_threshold IS NULL OR (auto_pause_7d_threshold > 0 AND auto_pause_7d_threshold <= 100)),
  ADD CONSTRAINT saas_platform_provider_accounts_codex_fingerprint_mode_values
    CHECK (codex_fingerprint_mode IS NULL OR codex_fingerprint_mode IN ('off', 'device', 'session', 'full')),
  ADD CONSTRAINT saas_platform_provider_accounts_codex_fingerprint_seed_length
    CHECK (codex_fingerprint_seed IS NULL OR (btrim(codex_fingerprint_seed) <> '' AND char_length(codex_fingerprint_seed) <= 128)),
  ADD CONSTRAINT saas_platform_provider_accounts_codex_fingerprint_shape
    CHECK (
      (codex_fingerprint_mode = 'off' OR codex_fingerprint_mode IS NULL) = (codex_fingerprint_seed IS NULL)
    );
`;

export const PROVIDER_ACCOUNT_CODEX_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 99,
  name: 'provider_account_codex_scheduling',
  sql: providerAccountCodexSchedulingSql,
};
