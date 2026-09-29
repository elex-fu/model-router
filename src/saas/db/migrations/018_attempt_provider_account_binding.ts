import type { SaasMigration } from './001_initial_schema.js';

/*
 * Migration 010 recorded an upstream id and resolved model, but not the
 * provider account selected for that attempt.  Keep those old rows intact:
 * the legacy binding state is deliberately non-dispatchable and carries no
 * guessed provider identity.  New metering writes use the bound state and the
 * owner-specific foreign keys below.
 *
 * The platform_account_id column is also the identity column consumed by the
 * supplier-cost snapshot trigger created in migration 017.  account_id is a
 * generated, owner-neutral projection for metering readers; the two nullable
 * owner columns are what make the tenant/platform foreign keys unambiguous.
 */
const attemptProviderAccountBindingSchemaSql = `
ALTER TABLE saas_attempts
  ADD COLUMN binding_state text NOT NULL DEFAULT 'legacy',
  ADD COLUMN account_owner_kind text,
  ADD COLUMN tenant_account_id text,
  ADD COLUMN platform_account_id text,
  ADD COLUMN provider_id text,
  ADD COLUMN product_id text,
  ADD COLUMN endpoint text;

ALTER TABLE saas_attempts
  ADD COLUMN account_id text GENERATED ALWAYS AS (
    CASE
      WHEN account_owner_kind IN ('tenant', 'platform')
        THEN COALESCE(tenant_account_id, platform_account_id)
      ELSE NULL
    END
  ) STORED;

ALTER TABLE saas_attempts
  ADD CONSTRAINT saas_attempts_provider_binding_shape CHECK (
    (
      binding_state = 'legacy'
      AND account_owner_kind IS NULL
      AND tenant_account_id IS NULL
      AND platform_account_id IS NULL
      AND provider_id IS NULL
      AND product_id IS NULL
      AND endpoint IS NULL
    )
    OR
    (
      binding_state = 'bound'
      AND account_owner_kind IN ('tenant', 'platform')
      AND provider_id IS NOT NULL
      AND btrim(provider_id) <> ''
      AND product_id IS NOT NULL
      AND btrim(product_id) <> ''
      AND endpoint IS NOT NULL
      AND btrim(endpoint) <> ''
      AND (
        (account_owner_kind = 'tenant'
          AND tenant_account_id IS NOT NULL
          AND btrim(tenant_account_id) <> ''
          AND platform_account_id IS NULL)
        OR
        (account_owner_kind = 'platform'
          AND tenant_account_id IS NULL
          AND platform_account_id IS NOT NULL
          AND btrim(platform_account_id) <> '')
      )
    )
  ),
  ADD CONSTRAINT saas_attempts_tenant_provider_account_fk
    FOREIGN KEY (tenant_id, tenant_account_id, provider_id, product_id)
    REFERENCES saas_tenant_provider_accounts (tenant_id, id, provider_id, product_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_attempts_platform_provider_account_fk
    FOREIGN KEY (platform_account_id, provider_id, product_id)
    REFERENCES saas_platform_provider_accounts (id, provider_id, product_id)
    ON DELETE RESTRICT;

CREATE INDEX saas_attempts_provider_binding_lookup_idx
  ON saas_attempts (tenant_id, account_owner_kind, account_id, provider_id, product_id);

CREATE FUNCTION saas_attempts_guard_provider_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  binding_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    binding_changed := OLD.binding_state IS DISTINCT FROM NEW.binding_state
      OR OLD.account_owner_kind IS DISTINCT FROM NEW.account_owner_kind
      OR OLD.tenant_account_id IS DISTINCT FROM NEW.tenant_account_id
      OR OLD.platform_account_id IS DISTINCT FROM NEW.platform_account_id
      OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
      OR OLD.product_id IS DISTINCT FROM NEW.product_id
      OR OLD.endpoint IS DISTINCT FROM NEW.endpoint;

    IF OLD.binding_state = 'legacy' AND binding_changed THEN
      RAISE EXCEPTION 'Historical SaaS attempts cannot be provider-bound after migration'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.dispatch_state <> 'not_sent' AND (
      binding_changed
      OR OLD.resolved_model IS DISTINCT FROM NEW.resolved_model
      OR OLD.protocol IS DISTINCT FROM NEW.protocol
      OR OLD.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
    ) THEN
      RAISE EXCEPTION 'SaaS attempt provider binding is immutable once dispatch starts'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.binding_state = 'legacy'
      AND NEW.dispatch_state IS DISTINCT FROM OLD.dispatch_state
    THEN
      RAISE EXCEPTION 'Historical SaaS attempts are non-dispatchable'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.binding_state = 'legacy' THEN
    IF TG_OP = 'INSERT' AND NEW.dispatch_state <> 'not_sent' THEN
      RAISE EXCEPTION 'Historical SaaS attempts are non-dispatchable'
        USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE'
      AND OLD.dispatch_state = 'not_sent'
      AND NEW.dispatch_state <> 'not_sent'
    THEN
      RAISE EXCEPTION 'Historical SaaS attempts are non-dispatchable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.dispatch_state <> 'not_sent' THEN
    RAISE EXCEPTION 'A bound SaaS attempt must be persisted before dispatch'
      USING ERRCODE = '55000';
  END IF;

  SELECT supply_mode, protocol, endpoint
    INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt provider binding request was not found'
      USING ERRCODE = '23514';
  END IF;

  IF request_record.protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
  THEN
    RAISE EXCEPTION 'SaaS attempt protocol or endpoint does not match its request'
      USING ERRCODE = '23514';
  END IF;

  IF request_record.supply_mode = 'byok' THEN
    IF NEW.account_owner_kind IS DISTINCT FROM 'tenant'
      OR NEW.tenant_account_id IS NULL
      OR NEW.platform_account_id IS NOT NULL
      OR NEW.supplier_cost_version IS NOT NULL
    THEN
      RAISE EXCEPTION 'A BYOK request must use its tenant provider account'
        USING ERRCODE = '23514';
    END IF;
  ELSIF request_record.supply_mode = 'platform' THEN
    IF NEW.account_owner_kind IS DISTINCT FROM 'platform'
      OR NEW.tenant_account_id IS NOT NULL
      OR NEW.platform_account_id IS NULL
      OR NEW.supplier_cost_version IS NULL
    THEN
      RAISE EXCEPTION 'A platform request must use its platform provider account and supplier cost version'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'SaaS attempt request has an invalid supply mode'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_provider_binding
  BEFORE INSERT OR UPDATE ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_provider_binding();
`;

export const ATTEMPT_PROVIDER_ACCOUNT_BINDING_SAAS_MIGRATION: SaasMigration = {
  version: 18,
  name: 'attempt_provider_account_identity_binding',
  sql: attemptProviderAccountBindingSchemaSql,
};
