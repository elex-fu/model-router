import type { SaasMigration } from './001_initial_schema.js';

const platformAdminAuthSchemaSql = `
/*
 * TOTP replay state belongs to the credential, not to a login request.  The
 * composite key also lets platform sessions prove that their credential and
 * user are the same pair at the database boundary.
 */
ALTER TABLE saas_mfa_credentials
  ADD COLUMN last_used_step bigint,
  ADD CONSTRAINT saas_mfa_credentials_last_used_step_nonnegative
    CHECK (last_used_step IS NULL OR last_used_step >= 0),
  ADD CONSTRAINT saas_mfa_credentials_id_user_unique
    UNIQUE (id, user_id);

CREATE UNIQUE INDEX saas_mfa_credentials_one_active_totp_per_user_idx
  ON saas_mfa_credentials (user_id)
  WHERE kind = 'totp' AND verified_at IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE saas_platform_mfa_enrollment_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT saas_platform_mfa_enrollment_tokens_expiry_after_creation
    CHECK (expires_at > created_at)
);
CREATE INDEX saas_platform_mfa_enrollment_tokens_user_expiry_idx
  ON saas_platform_mfa_enrollment_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;

/* A setup token is the short-lived, one-use confirmation token returned by beginMfaEnrollment. */
CREATE TABLE saas_platform_mfa_setup_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0,
  attempt_limit integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  locked_at timestamptz,
  CONSTRAINT saas_platform_mfa_setup_tokens_credential_user_fk
    FOREIGN KEY (credential_id, user_id)
    REFERENCES saas_mfa_credentials (id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_mfa_setup_tokens_credential_unique
    UNIQUE (credential_id),
  CONSTRAINT saas_platform_mfa_setup_tokens_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT saas_platform_mfa_setup_tokens_attempt_limit
    CHECK (attempt_limit BETWEEN 1 AND 10),
  CONSTRAINT saas_platform_mfa_setup_tokens_attempt_count
    CHECK (attempt_count BETWEEN 0 AND attempt_limit),
  CONSTRAINT saas_platform_mfa_setup_tokens_lock_state
    CHECK (locked_at IS NULL OR attempt_count >= attempt_limit)
);
CREATE INDEX saas_platform_mfa_setup_tokens_user_expiry_idx
  ON saas_platform_mfa_setup_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL AND locked_at IS NULL;

CREATE TABLE saas_platform_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash text NOT NULL
    CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT saas_platform_sessions_credential_user_fk
    FOREIGN KEY (credential_id, user_id)
    REFERENCES saas_mfa_credentials (id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_sessions_expiry_after_creation
    CHECK (expires_at > created_at)
);
CREATE INDEX saas_platform_sessions_user_expiry_idx
  ON saas_platform_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX saas_platform_sessions_credential_idx
  ON saas_platform_sessions (credential_id, expires_at)
  WHERE revoked_at IS NULL;
`;

export const PLATFORM_ADMIN_AUTH_SAAS_MIGRATION: SaasMigration = {
  version: 7,
  name: 'platform_admin_mfa_and_sessions',
  sql: platformAdminAuthSchemaSql,
};
