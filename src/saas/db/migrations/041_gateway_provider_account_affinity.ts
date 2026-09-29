import type { SaasMigration } from './001_initial_schema.js';

const gatewayProviderAccountAffinitySql = `
CREATE TABLE saas_gateway_provider_account_affinity (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  supply_profile_id text NOT NULL CHECK (btrim(supply_profile_id) <> ''),
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  account_owner_kind text NOT NULL CHECK (account_owner_kind IN ('tenant', 'platform')),
  route_config_id text NOT NULL CHECK (btrim(route_config_id) <> ''),
  route_config_version bigint NOT NULL CHECK (route_config_version > 0),
  public_model_id text NOT NULL CHECK (btrim(public_model_id) <> ''),
  public_model_version bigint NOT NULL CHECK (public_model_version > 0),
  public_model text NOT NULL CHECK (btrim(public_model) <> ''),
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  target_mode text NOT NULL CHECK (target_mode IN ('tenant_account', 'platform_pool')),
  upstream_id text NOT NULL CHECK (btrim(upstream_id) <> ''),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  product_id text NOT NULL CHECK (btrim(product_id) <> ''),
  reference_kind text NOT NULL CHECK (reference_kind IN ('response', 'session')),
  hmac_key_version text NOT NULL CHECK (hmac_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  account_id text NOT NULL CHECK (btrim(account_id) <> '' AND account_id = btrim(account_id)),
  state text NOT NULL CHECK (state IN ('active', 'expired', 'invalidated')),
  revision bigint NOT NULL CHECK (revision >= 1),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT saas_gateway_provider_account_affinity_owner_scope CHECK (
    (supply_mode = 'byok' AND account_owner_kind = 'tenant' AND target_mode = 'tenant_account')
    OR (supply_mode = 'platform' AND account_owner_kind = 'platform' AND target_mode = 'platform_pool')
  ),
  CONSTRAINT saas_gateway_provider_account_affinity_ttl CHECK (
    state <> 'active' OR (
      expires_at > updated_at AND expires_at <= updated_at + interval '24 hours'
    )
  ),
  PRIMARY KEY (
    tenant_id, project_id, reference_kind, hmac_key_version, key_digest
  )
);

CREATE INDEX saas_gateway_provider_account_affinity_expiry_idx
  ON saas_gateway_provider_account_affinity (expires_at)
  WHERE state = 'active';

CREATE FUNCTION saas_gateway_provider_account_affinity_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.supply_profile_id IS DISTINCT FROM OLD.supply_profile_id
    OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
    OR NEW.account_owner_kind IS DISTINCT FROM OLD.account_owner_kind
    OR NEW.route_config_id IS DISTINCT FROM OLD.route_config_id
    OR NEW.route_config_version IS DISTINCT FROM OLD.route_config_version
    OR NEW.public_model_id IS DISTINCT FROM OLD.public_model_id
    OR NEW.public_model_version IS DISTINCT FROM OLD.public_model_version
    OR NEW.public_model IS DISTINCT FROM OLD.public_model
    OR NEW.protocol IS DISTINCT FROM OLD.protocol
    OR NEW.target_mode IS DISTINCT FROM OLD.target_mode
    OR NEW.upstream_id IS DISTINCT FROM OLD.upstream_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.reference_kind IS DISTINCT FROM OLD.reference_kind
    OR NEW.hmac_key_version IS DISTINCT FROM OLD.hmac_key_version
    OR NEW.key_digest IS DISTINCT FROM OLD.key_digest
  THEN
    RAISE EXCEPTION 'Gateway provider account affinity identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1
    OR NEW.fencing_token <> OLD.fencing_token + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Gateway provider account affinity update is stale' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'active' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'Active gateway provider account affinity cannot be rebound' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('expired', 'invalidated') AND NEW.state <> 'active' THEN
    RAISE EXCEPTION 'Inactive gateway provider account affinity must be rebound explicitly' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_gateway_provider_account_affinity_guard_update
  BEFORE UPDATE ON saas_gateway_provider_account_affinity
  FOR EACH ROW EXECUTE FUNCTION saas_gateway_provider_account_affinity_guard_update();

CREATE FUNCTION saas_gateway_provider_account_affinity_reject_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Gateway provider account affinity rows cannot be removed' USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER saas_gateway_provider_account_affinity_no_delete
  BEFORE DELETE ON saas_gateway_provider_account_affinity
  FOR EACH ROW EXECUTE FUNCTION saas_gateway_provider_account_affinity_reject_removal();
CREATE TRIGGER saas_gateway_provider_account_affinity_no_truncate
  BEFORE TRUNCATE ON saas_gateway_provider_account_affinity
  FOR EACH STATEMENT EXECUTE FUNCTION saas_gateway_provider_account_affinity_reject_removal();
`;

export const GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION: SaasMigration = {
  version: 41,
  name: 'gateway_provider_account_affinity',
  sql: gatewayProviderAccountAffinitySql,
};
