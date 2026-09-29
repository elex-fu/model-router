import type { SaasMigration } from './001_initial_schema.js';

const gatewayProviderAccountRuntimeHealthSql = `
CREATE TABLE saas_provider_account_runtime_health (
  owner_scope_key text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('tenant', 'platform')),
  owner_tenant_id uuid REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (btrim(account_id) <> '' AND account_id = btrim(account_id)),
  state text NOT NULL CHECK (state IN ('healthy', 'degraded', 'cooldown', 'unhealthy')),
  failure_count integer NOT NULL CHECK (failure_count BETWEEN 0 AND 8),
  observed_at timestamptz NOT NULL,
  cooldown_until timestamptz,
  last_outcome text NOT NULL CHECK (last_outcome IN (
    'gateway_success', 'gateway_network_failure', 'gateway_provider_5xx_failure',
    'gateway_protocol_failure', 'probe_success', 'probe_network_failure',
    'probe_provider_5xx_failure', 'probe_protocol_failure'
  )),
  source_fencing_token bigint NOT NULL CHECK (source_fencing_token >= 1),
  revision bigint NOT NULL CHECK (revision >= 1),
  CONSTRAINT saas_provider_account_runtime_health_scope_shape CHECK (
    (owner_kind = 'tenant' AND owner_tenant_id IS NOT NULL AND owner_scope_key = owner_tenant_id::text)
    OR (owner_kind = 'platform' AND owner_tenant_id IS NULL AND owner_scope_key = 'platform')
  ),
  CONSTRAINT saas_provider_account_runtime_health_cooldown_shape CHECK (
    (state = 'cooldown') = (cooldown_until IS NOT NULL)
    AND (cooldown_until IS NULL OR
      (cooldown_until >= observed_at AND cooldown_until <= observed_at + interval '5 minutes'))
  ),
  CONSTRAINT saas_provider_account_runtime_health_outcome_shape CHECK (
    (state = 'healthy' AND failure_count = 0
      AND last_outcome IN ('gateway_success', 'probe_success'))
    OR (state = 'cooldown' AND failure_count BETWEEN 1 AND 8
      AND last_outcome IN (
        'gateway_network_failure', 'gateway_provider_5xx_failure', 'gateway_protocol_failure',
        'probe_network_failure', 'probe_provider_5xx_failure', 'probe_protocol_failure'
      ))
    OR state IN ('degraded', 'unhealthy')
  ),
  PRIMARY KEY (owner_scope_key, account_id)
);

CREATE FUNCTION saas_provider_account_runtime_health_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_scope_key IS DISTINCT FROM OLD.owner_scope_key
    OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
    OR NEW.owner_tenant_id IS DISTINCT FROM OLD.owner_tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
  THEN
    RAISE EXCEPTION 'Provider account runtime health identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.source_fencing_token <= OLD.source_fencing_token
    OR NEW.revision <> OLD.revision + 1
    OR NEW.observed_at < OLD.observed_at
  THEN
    RAISE EXCEPTION 'Provider account runtime health update is stale' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_provider_account_runtime_health_guard_update
  BEFORE UPDATE ON saas_provider_account_runtime_health
  FOR EACH ROW EXECUTE FUNCTION saas_provider_account_runtime_health_guard_update();

CREATE FUNCTION saas_provider_account_runtime_health_reject_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider account runtime health rows cannot be removed' USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER saas_provider_account_runtime_health_no_delete
  BEFORE DELETE ON saas_provider_account_runtime_health
  FOR EACH ROW EXECUTE FUNCTION saas_provider_account_runtime_health_reject_removal();
CREATE TRIGGER saas_provider_account_runtime_health_no_truncate
  BEFORE TRUNCATE ON saas_provider_account_runtime_health
  FOR EACH STATEMENT EXECUTE FUNCTION saas_provider_account_runtime_health_reject_removal();
`;

export const GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION: SaasMigration = {
  version: 40,
  name: 'gateway_provider_account_runtime_health',
  sql: gatewayProviderAccountRuntimeHealthSql,
};
