import type { SaasMigration } from './001_initial_schema.js';

/**
 * sub2api parity Phase 2 (COM-01): social OAuth login identities. One row per
 * (provider_type, provider_subject) pair binding an external identity (OIDC
 * `sub` or WeChat `openid`) to exactly one saas_users tenant account. The
 * login / registration / adoption decisions live in
 * src/saas/identity/oauth-login/oauth-login-service.ts; this table is only
 * the durable binding ledger.
 *
 * Design notes:
 * - UNIQUE (provider_type, provider_subject) is the login lookup key: one
 *   provider identity maps to exactly one tenant user, forever.
 * - provider_subject is the provider's stable account id (OIDC `sub`, WeChat
 *   `openid`), never a display name or an access token.
 * - email is the provider-reported address captured at binding time for
 *   audit and support; the canonical account email stays on saas_users.
 * - tenant_user_id RESTRICTs deletion: account rows outlive bindings and a
 *   binding can never dangle.
 * - Rows are append-only in Phase 2 (no unbinding surface yet), so unlike the
 *   passkey-ceremony family there is no DELETE guard to install.
 *
 * Numbered 101 per docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 2;
 * 099/100 stay reserved for the concurrently landing Phase 1 tracks.
 */
const identityOauthIdentitiesSql = `
CREATE TABLE tenant_oauth_identities (
  id uuid PRIMARY KEY,
  provider_type text NOT NULL
    CHECK (provider_type IN ('oidc', 'wechat')),
  provider_subject text NOT NULL
    CHECK (char_length(btrim(provider_subject)) BETWEEN 1 AND 512),
  tenant_user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  email text
    CHECK (email IS NULL OR email <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_oauth_identities_provider_subject_unique UNIQUE (provider_type, provider_subject)
);

CREATE INDEX tenant_oauth_identities_tenant_user_idx ON tenant_oauth_identities (tenant_user_id);
`;

export const IDENTITY_OAUTH_IDENTITIES_SAAS_MIGRATION: SaasMigration = {
  version: 101,
  name: 'identity_oauth_identities',
  sql: identityOauthIdentitiesSql,
};
