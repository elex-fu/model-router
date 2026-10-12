import type { SaasMigration } from './001_initial_schema.js';

/**
 * R4 OAuth token auto-refresh state (design:
 * docs/remaining-capability-plan-2026-10-11.md). Refresh tokens live inside
 * the existing credential envelopes (never as plaintext columns); these
 * columns are only the scheduling/observability state for the refresh
 * worker. NULL means "not an OAuth credential" and is byte-identical to
 * pre-R4 behavior. The gateway never writes credential relations (the
 * runtime-privileges pin invariant); the force-refresh flag is set by the
 * credential validation worker on 401-class auth failures and consumed and
 * cleared by the refresh worker.
 */
const providerCredentialOauthRefreshSql = `
ALTER TABLE saas_tenant_provider_credentials
  ADD COLUMN oauth_refresh_state text,
  ADD COLUMN oauth_next_refresh_at timestamptz,
  ADD COLUMN oauth_last_refresh_at timestamptz,
  ADD COLUMN oauth_force_refresh_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN oauth_refresh_error_code text;

ALTER TABLE saas_tenant_provider_credentials
  ADD CONSTRAINT saas_tenant_provider_credentials_oauth_state_check
    CHECK (oauth_refresh_state IS NULL OR oauth_refresh_state IN ('idle', 'refreshing', 'failed')),
  ADD CONSTRAINT saas_tenant_provider_credentials_oauth_error_length
    CHECK (oauth_refresh_error_code IS NULL OR char_length(oauth_refresh_error_code) <= 128),
  ADD CONSTRAINT saas_tenant_provider_credentials_oauth_state_shape
    CHECK ((oauth_refresh_state IS NULL) = (oauth_next_refresh_at IS NULL AND oauth_last_refresh_at IS NULL));

ALTER TABLE saas_platform_provider_credentials
  ADD COLUMN oauth_refresh_state text,
  ADD COLUMN oauth_next_refresh_at timestamptz,
  ADD COLUMN oauth_last_refresh_at timestamptz,
  ADD COLUMN oauth_force_refresh_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN oauth_refresh_error_code text;

ALTER TABLE saas_platform_provider_credentials
  ADD CONSTRAINT saas_platform_provider_credentials_oauth_state_check
    CHECK (oauth_refresh_state IS NULL OR oauth_refresh_state IN ('idle', 'refreshing', 'failed')),
  ADD CONSTRAINT saas_platform_provider_credentials_oauth_error_length
    CHECK (oauth_refresh_error_code IS NULL OR char_length(oauth_refresh_error_code) <= 128),
  ADD CONSTRAINT saas_platform_provider_credentials_oauth_state_shape
    CHECK ((oauth_refresh_state IS NULL) = (oauth_next_refresh_at IS NULL AND oauth_last_refresh_at IS NULL));
`;

export const PROVIDER_CREDENTIAL_OAUTH_REFRESH_SAAS_MIGRATION: SaasMigration = {
  version: 94,
  name: 'provider_credential_oauth_refresh_state',
  sql: providerCredentialOauthRefreshSql,
};
