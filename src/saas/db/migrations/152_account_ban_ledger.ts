import type { SaasMigration } from './001_initial_schema.js';

/**
 * Personal-token resale §4.4 operational ban facts. No ledger table is needed:
 * the authoritative account row already owns lifecycle/CAS/audit semantics and
 * outlives the 30-day probe-run retention. The three bounded, body-free ban
 * columns are sufficient for the ledger and section 4.6 sunk-cost cutoff.
 *
 * The runtime-health vocabulary gains distinct evidence for persistent
 * non-quota 403s, verification walls, and in-stream overload. The first two
 * are consumed by the asynchronous ban sweep; overload only reduces scheduling
 * weight through the existing EMA and never bans an account.
 *
 * Intentionally not added to SAAS_MIGRATIONS by this workstream. The integrator
 * must register this forward migration explicitly during deployment assembly.
 */
const accountBanLedgerSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN banned_at timestamptz,
  ADD COLUMN ban_reason text,
  ADD COLUMN ban_last_error text;
ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN banned_at timestamptz,
  ADD COLUMN ban_reason text,
  ADD COLUMN ban_last_error text;

ALTER TABLE saas_tenant_provider_accounts DROP CONSTRAINT saas_tenant_provider_accounts_status_check;
ALTER TABLE saas_tenant_provider_accounts
  ADD CONSTRAINT saas_tenant_provider_accounts_status_check
  CHECK (status IN ('pending', 'active', 'disabled', 'revoked', 'banned'));
ALTER TABLE saas_platform_provider_accounts DROP CONSTRAINT saas_platform_provider_accounts_status_check;
ALTER TABLE saas_platform_provider_accounts
  ADD CONSTRAINT saas_platform_provider_accounts_status_check
  CHECK (status IN ('pending', 'active', 'disabled', 'revoked', 'banned'));

ALTER TABLE saas_tenant_provider_accounts DROP CONSTRAINT saas_tenant_provider_accounts_lifecycle_shape;
ALTER TABLE saas_tenant_provider_accounts
  ADD CONSTRAINT saas_tenant_provider_accounts_lifecycle_shape CHECK (
    (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL
      AND banned_at IS NULL AND ban_reason IS NULL AND ban_last_error IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL
      AND banned_at IS NULL AND ban_reason IS NULL AND ban_last_error IS NULL)
    OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL
      AND banned_at IS NULL AND ban_reason IS NULL AND ban_last_error IS NULL)
    OR (status = 'banned' AND disabled_at IS NULL AND revoked_at IS NULL AND banned_at IS NOT NULL
      AND ban_reason IS NOT NULL AND btrim(ban_reason) <> '' AND char_length(ban_reason) <= 128
      AND ban_last_error IS NOT NULL AND btrim(ban_last_error) <> '' AND char_length(ban_last_error) <= 128)
  );
ALTER TABLE saas_platform_provider_accounts DROP CONSTRAINT saas_platform_provider_accounts_lifecycle_shape;
ALTER TABLE saas_platform_provider_accounts
  ADD CONSTRAINT saas_platform_provider_accounts_lifecycle_shape CHECK (
    (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL
      AND banned_at IS NULL AND ban_reason IS NULL AND ban_last_error IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL
      AND banned_at IS NULL AND ban_reason IS NULL AND ban_last_error IS NULL)
    OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL
      AND banned_at IS NULL AND ban_reason IS NULL AND ban_last_error IS NULL)
    OR (status = 'banned' AND disabled_at IS NULL AND revoked_at IS NULL AND banned_at IS NOT NULL
      AND ban_reason IS NOT NULL AND btrim(ban_reason) <> '' AND char_length(ban_reason) <= 128
      AND ban_last_error IS NOT NULL AND btrim(ban_last_error) <> '' AND char_length(ban_last_error) <= 128)
  );

CREATE INDEX saas_tenant_provider_accounts_ban_ledger_idx
  ON saas_tenant_provider_accounts (tenant_id, banned_at, id) WHERE status = 'banned';
CREATE INDEX saas_platform_provider_accounts_ban_ledger_idx
  ON saas_platform_provider_accounts (banned_at, id) WHERE status = 'banned';

ALTER TABLE saas_provider_account_runtime_health
  ADD COLUMN forbidden_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN verification_wall_failure_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT saas_provider_account_runtime_health_ban_streak_shape CHECK (
    forbidden_failure_count BETWEEN 0 AND 8
    AND verification_wall_failure_count BETWEEN 0 AND 8
    AND ((last_outcome = 'gateway_forbidden_failure'
          AND forbidden_failure_count BETWEEN 1 AND failure_count)
         OR (last_outcome <> 'gateway_forbidden_failure' AND forbidden_failure_count = 0))
    AND ((last_outcome = 'gateway_verification_wall_failure'
          AND verification_wall_failure_count BETWEEN 1 AND failure_count)
         OR (last_outcome <> 'gateway_verification_wall_failure' AND verification_wall_failure_count = 0))
  );
ALTER TABLE saas_provider_account_runtime_health
  DROP CONSTRAINT saas_provider_account_runtime_health_last_outcome_check;
ALTER TABLE saas_provider_account_runtime_health
  ADD CONSTRAINT saas_provider_account_runtime_health_last_outcome_check CHECK (last_outcome IN (
    'gateway_success', 'gateway_network_failure', 'gateway_provider_5xx_failure',
    'gateway_protocol_failure', 'gateway_account_access_failure', 'gateway_rate_limited_failure',
    'gateway_stream_abort_failure', 'gateway_forbidden_failure', 'gateway_verification_wall_failure',
    'gateway_overloaded_failure', 'probe_success', 'probe_network_failure',
    'probe_provider_5xx_failure', 'probe_protocol_failure'
  ));
ALTER TABLE saas_provider_account_runtime_health
  DROP CONSTRAINT saas_provider_account_runtime_health_outcome_shape;
ALTER TABLE saas_provider_account_runtime_health
  ADD CONSTRAINT saas_provider_account_runtime_health_outcome_shape CHECK (
    (state = 'healthy' AND failure_count = 0
      AND last_outcome IN ('gateway_success', 'probe_success'))
    OR (state = 'cooldown' AND failure_count BETWEEN 1 AND 8
      AND last_outcome IN (
        'gateway_network_failure', 'gateway_provider_5xx_failure', 'gateway_protocol_failure',
        'gateway_account_access_failure', 'gateway_rate_limited_failure', 'gateway_stream_abort_failure',
        'gateway_forbidden_failure', 'gateway_verification_wall_failure', 'gateway_overloaded_failure',
        'probe_network_failure', 'probe_provider_5xx_failure', 'probe_protocol_failure'
      ))
    OR state IN ('degraded', 'unhealthy')
  );
`;

export const ACCOUNT_BAN_LEDGER_SAAS_MIGRATION: SaasMigration = {
  version: 152,
  name: 'account_ban_ledger',
  sql: accountBanLedgerSql,
};
