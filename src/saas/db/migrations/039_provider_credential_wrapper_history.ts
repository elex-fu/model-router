import type { SaasMigration } from './001_initial_schema.js';

const providerCredentialWrapperHistorySql = `
/* Keep the immutable secret-version envelope as the legacy fallback. */
CREATE UNIQUE INDEX saas_tenant_provider_credential_version_wrapper_fk_idx
  ON saas_tenant_provider_credential_versions (tenant_id, credential_id, account_id, version);
CREATE UNIQUE INDEX saas_platform_provider_credential_version_wrapper_fk_idx
  ON saas_platform_provider_credential_versions (credential_id, account_id, version);

CREATE TABLE saas_tenant_provider_credential_wrappings (
  tenant_id uuid NOT NULL,
  account_id text NOT NULL,
  credential_id text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  owner_kind text NOT NULL DEFAULT 'tenant' CHECK (owner_kind = 'tenant'),
  wrapping_revision integer NOT NULL CHECK (wrapping_revision > 1),
  expected_wrapping_revision integer NOT NULL CHECK (expected_wrapping_revision > 0),
  operation_id text NOT NULL CHECK (btrim(operation_id) <> ''),
  source_kms_key_id text NOT NULL CHECK (btrim(source_kms_key_id) <> ''),
  kms_key_id text NOT NULL CHECK (btrim(kms_key_id) <> ''),
  wrapped_dek text NOT NULL CHECK (btrim(wrapped_dek) <> ''),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'workload')),
  actor_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  actor_workload_id text,
  request_id text NOT NULL CHECK (btrim(request_id) <> ''),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, credential_id, credential_version, wrapping_revision),
  CONSTRAINT saas_tenant_provider_credential_wrappings_cas_shape
    CHECK (wrapping_revision = expected_wrapping_revision + 1),
  CONSTRAINT saas_tenant_provider_credential_wrappings_key_change
    CHECK (source_kms_key_id <> kms_key_id),
  CONSTRAINT saas_tenant_provider_credential_wrappings_actor_shape
    CHECK (
      (actor_kind = 'user' AND actor_user_id IS NOT NULL AND actor_workload_id IS NULL)
      OR (actor_kind = 'workload' AND actor_user_id IS NULL
        AND actor_workload_id IS NOT NULL AND btrim(actor_workload_id) <> '')
    ),
  CONSTRAINT saas_tenant_provider_credential_wrappings_version_fk
    FOREIGN KEY (tenant_id, credential_id, account_id, credential_version)
    REFERENCES saas_tenant_provider_credential_versions (tenant_id, credential_id, account_id, version)
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX saas_tenant_provider_credential_wrappings_operation_idx
  ON saas_tenant_provider_credential_wrappings
    (tenant_id, credential_id, credential_version, operation_id);

CREATE TABLE saas_platform_provider_credential_wrappings (
  account_id text NOT NULL,
  credential_id text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  owner_kind text NOT NULL DEFAULT 'platform' CHECK (owner_kind = 'platform'),
  wrapping_revision integer NOT NULL CHECK (wrapping_revision > 1),
  expected_wrapping_revision integer NOT NULL CHECK (expected_wrapping_revision > 0),
  operation_id text NOT NULL CHECK (btrim(operation_id) <> ''),
  source_kms_key_id text NOT NULL CHECK (btrim(source_kms_key_id) <> ''),
  kms_key_id text NOT NULL CHECK (btrim(kms_key_id) <> ''),
  wrapped_dek text NOT NULL CHECK (btrim(wrapped_dek) <> ''),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'workload')),
  actor_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  actor_workload_id text,
  request_id text NOT NULL CHECK (btrim(request_id) <> ''),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, credential_version, wrapping_revision),
  CONSTRAINT saas_platform_provider_credential_wrappings_cas_shape
    CHECK (wrapping_revision = expected_wrapping_revision + 1),
  CONSTRAINT saas_platform_provider_credential_wrappings_key_change
    CHECK (source_kms_key_id <> kms_key_id),
  CONSTRAINT saas_platform_provider_credential_wrappings_actor_shape
    CHECK (
      (actor_kind = 'user' AND actor_user_id IS NOT NULL AND actor_workload_id IS NULL)
      OR (actor_kind = 'workload' AND actor_user_id IS NULL
        AND actor_workload_id IS NOT NULL AND btrim(actor_workload_id) <> '')
    ),
  CONSTRAINT saas_platform_provider_credential_wrappings_version_fk
    FOREIGN KEY (credential_id, account_id, credential_version)
    REFERENCES saas_platform_provider_credential_versions (credential_id, account_id, version)
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX saas_platform_provider_credential_wrappings_operation_idx
  ON saas_platform_provider_credential_wrappings (credential_id, credential_version, operation_id);

CREATE FUNCTION saas_provider_credential_wrapper_history_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider credential wrapper history is append-only'
    USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER saas_tenant_provider_credential_wrappings_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_provider_credential_wrappings
  FOR EACH ROW EXECUTE FUNCTION saas_provider_credential_wrapper_history_reject_change();
CREATE TRIGGER saas_tenant_provider_credential_wrappings_no_truncate
  BEFORE TRUNCATE ON saas_tenant_provider_credential_wrappings
  FOR EACH STATEMENT EXECUTE FUNCTION saas_provider_credential_wrapper_history_reject_change();
CREATE TRIGGER saas_platform_provider_credential_wrappings_immutable
  BEFORE UPDATE OR DELETE ON saas_platform_provider_credential_wrappings
  FOR EACH ROW EXECUTE FUNCTION saas_provider_credential_wrapper_history_reject_change();
CREATE TRIGGER saas_platform_provider_credential_wrappings_no_truncate
  BEFORE TRUNCATE ON saas_platform_provider_credential_wrappings
  FOR EACH STATEMENT EXECUTE FUNCTION saas_provider_credential_wrapper_history_reject_change();
`;

export const PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION: SaasMigration = {
  version: 39,
  name: 'provider_credential_wrapper_history',
  sql: providerCredentialWrapperHistorySql,
};
