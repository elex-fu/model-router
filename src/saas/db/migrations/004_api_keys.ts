import type { SaasMigration } from './001_initial_schema.js';

const apiKeysSchemaSql = `
CREATE TABLE saas_api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  principal_user_id uuid NOT NULL,
  supply_profile_id text NOT NULL,
  supply_mode text NOT NULL
    CHECK (supply_mode IN ('byok', 'platform')),
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  model_scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1
    CHECK (authz_version >= 1),
  CONSTRAINT saas_api_keys_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT saas_api_keys_prefix_format CHECK (prefix ~ '^mr_live_[A-Za-z0-9_-]{8,}$'),
  CONSTRAINT saas_api_keys_model_scopes_nonempty CHECK (
    cardinality(model_scopes) > 0 AND array_position(model_scopes, '') IS NULL
  ),
  CONSTRAINT saas_api_keys_expiry_after_creation CHECK (
    expires_at IS NULL OR expires_at > created_at
  ),
  CONSTRAINT saas_api_keys_revocation_status CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status = 'active' AND revoked_at IS NULL)
  ),
  CONSTRAINT saas_api_keys_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES saas_tenants (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_keys_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_keys_principal_fk
    FOREIGN KEY (principal_user_id)
    REFERENCES saas_users (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_keys_project_member_fk
    FOREIGN KEY (tenant_id, project_id, principal_user_id)
    REFERENCES saas_project_memberships (tenant_id, project_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX saas_api_keys_project_status_created_idx
  ON saas_api_keys (tenant_id, project_id, status, created_at DESC);
CREATE INDEX saas_api_keys_project_member_idx
  ON saas_api_keys (tenant_id, project_id, principal_user_id);

CREATE FUNCTION saas_reject_api_key_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS API keys must be revoked instead of deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_api_keys_no_delete
  BEFORE DELETE ON saas_api_keys
  FOR EACH ROW EXECUTE FUNCTION saas_reject_api_key_delete();
`;

export const API_KEYS_SAAS_MIGRATION: SaasMigration = {
  version: 4,
  name: 'api_key_digest_lifecycle',
  sql: apiKeysSchemaSql,
};
