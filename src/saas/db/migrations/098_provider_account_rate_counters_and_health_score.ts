import type { SaasMigration } from './001_initial_schema.js';

/**
 * R6/D5 multi-layer rate limits in scheduling and R7/D6 continuous health
 * (design: docs/remaining-capability-plan-2026-10-11.md R6/R7). PostgreSQL
 * remains the authoritative counter store (Redis may only ever be a derived
 * cache): the admission chain upserts per-account per-second counters
 * atomically and the eligibility chain reads the trailing window, so
 * admission and scheduling never share a stale snapshot. NULL limits keep
 * the pre-R6 "no account-level cap" behavior. The health score is an EMA
 * continuous multiplier on top of the existing binary state; NULL keeps the
 * pre-R7 binary behavior, and the half-open probe column records the single
 * probe admission instead of a TTL-only cooldown exit.
 */
const providerAccountRateAndHealthSql = `
CREATE TABLE saas_provider_account_rate_counters (
  account_scope text NOT NULL
    CHECK (account_scope IN ('tenant', 'platform')),
  account_id text NOT NULL,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 0
    CHECK (requests >= 0),
  tokens bigint NOT NULL DEFAULT 0
    CHECK (tokens >= 0),
  CONSTRAINT saas_provider_account_rate_counters_pk
    PRIMARY KEY (account_scope, account_id, window_start),
  CONSTRAINT saas_provider_account_rate_counters_account_nonempty
    CHECK (btrim(account_id) <> '' AND account_id = btrim(account_id))
);

CREATE INDEX saas_provider_account_rate_counters_window_idx
  ON saas_provider_account_rate_counters (account_scope, account_id, window_start DESC);

ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN rpm_limit integer,
  ADD COLUMN tpm_limit integer;

ALTER TABLE saas_tenant_provider_accounts
  ADD CONSTRAINT saas_tenant_provider_accounts_rpm_limit_positive
    CHECK (rpm_limit IS NULL OR rpm_limit > 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_tpm_limit_positive
    CHECK (tpm_limit IS NULL OR tpm_limit > 0);

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN rpm_limit integer,
  ADD COLUMN tpm_limit integer;

ALTER TABLE saas_platform_provider_accounts
  ADD CONSTRAINT saas_platform_provider_accounts_rpm_limit_positive
    CHECK (rpm_limit IS NULL OR rpm_limit > 0),
  ADD CONSTRAINT saas_platform_provider_accounts_tpm_limit_positive
    CHECK (tpm_limit IS NULL OR tpm_limit > 0);

ALTER TABLE saas_provider_account_runtime_health
  ADD COLUMN health_score numeric(4,3),
  ADD COLUMN half_open_probe_at timestamptz;

ALTER TABLE saas_provider_account_runtime_health
  ADD CONSTRAINT saas_provider_account_runtime_health_score_range
    CHECK (health_score IS NULL OR (health_score >= 0 AND health_score <= 1));
`;

export const PROVIDER_ACCOUNT_RATE_AND_HEALTH_SAAS_MIGRATION: SaasMigration = {
  version: 98,
  name: 'provider_account_rate_counters_and_health_score',
  sql: providerAccountRateAndHealthSql,
};
