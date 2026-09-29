import type { SaasMigration } from './001_initial_schema.js';

/*
 * Replace service-role row locks on SELECT-only relations with advisory fences. Each reader takes
 * the shared form before it reads mutable facts; matching write triggers take the exclusive form.
 * Catalog rights/capability history is immutable and uses the provider-product identity as its
 * serialization key; public-model alias history uses the public-model identity in the same way.
 * Readers never tuple-lock history, and writers acquire the matching identity fence before reading
 * a latest version. Supply service paths that need both mutable heads acquire pool before profile.
 * Readers then use ordinary MVCC SELECTs, so a trigger waiting on an advisory fence while holding
 * its updated tuple cannot create a reverse tuple-lock wait. Update triggers never acquire service
 * relationship rows. Privileged batch updates spanning multiple identities should pre-acquire all
 * namespaced advisory keys in sorted order before updating rows to avoid key-order deadlocks.
 */
const runtimeRoleLockFencesSql = `
CREATE OR REPLACE FUNCTION saas_catalog_lock_product_for_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'saas_catalog_product:' || encode(convert_to(NEW.provider_id, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(NEW.product_id, 'UTF8'), 'hex'),
      0
    )
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_public_model_lock_for_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'saas_public_model:' || encode(convert_to(NEW.public_model_id, 'UTF8'), 'hex'),
      0
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_public_model_versions_runtime_advisory_fence
  BEFORE INSERT ON saas_public_model_versions
  FOR EACH ROW EXECUTE FUNCTION saas_public_model_lock_for_version_insert();

CREATE OR REPLACE FUNCTION saas_provider_supply_require_byok_rights() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  qualification_time timestamptz;
BEGIN
  IF NEW.supply_mode IS DISTINCT FROM 'byok' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(
      'saas_catalog_product:' || encode(convert_to(NEW.provider_id, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(NEW.product_id, 'UTF8'), 'hex'),
      0
    )
  );
  IF NOT EXISTS (
    SELECT 1
      FROM saas_provider_products
     WHERE provider_id = NEW.provider_id
       AND product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'Provider BYOK qualification is not valid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saas_tenant_provider_accounts_byok_rights_fence';
  END IF;

  qualification_time := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1
      FROM saas_provider_rights AS rights
     WHERE rights.rights_id = NEW.rights_id
       AND rights.version = NEW.rights_version
       AND rights.provider_id = NEW.provider_id
       AND rights.product_id = NEW.product_id
       AND rights.credential_type = NEW.credential_type
       AND rights.supply_mode = NEW.supply_mode
       AND rights.region = NEW.region
       AND rights.purpose = NEW.purpose
       AND rights.status = 'active'
       AND rights.effective_at <= qualification_time
       AND (rights.expires_at IS NULL OR rights.expires_at > qualification_time)
       AND rights.version = (
         SELECT latest.version
           FROM saas_provider_rights AS latest
          WHERE latest.rights_id = rights.rights_id
            AND latest.effective_at <= qualification_time
          ORDER BY latest.effective_at DESC, latest.version DESC
          LIMIT 1
       )
  ) THEN
    RAISE EXCEPTION 'Provider BYOK qualification is not valid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saas_tenant_provider_accounts_byok_rights_fence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION saas_provider_supply_require_byok_capability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_supply_mode text;
  account_rights_id text;
  account_rights_version integer;
  account_credential_type text;
  account_region text;
  account_purpose text;
  qualification_time timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended(
      'saas_catalog_product:' || encode(convert_to(NEW.provider_id, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(NEW.product_id, 'UTF8'), 'hex'),
      0
    )
  );
  IF NOT EXISTS (
    SELECT 1
      FROM saas_provider_products
     WHERE provider_id = NEW.provider_id
       AND product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'Provider BYOK capability qualification is not valid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saas_tenant_provider_account_capabilities_byok_fence';
  END IF;

  SELECT account.supply_mode, account.rights_id, account.rights_version,
         account.credential_type, account.region, account.purpose
    INTO account_supply_mode, account_rights_id, account_rights_version,
         account_credential_type, account_region, account_purpose
    FROM saas_tenant_provider_accounts AS account
   WHERE account.tenant_id = NEW.tenant_id
     AND account.id = NEW.account_id
     AND account.provider_id = NEW.provider_id
     AND account.product_id = NEW.product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provider BYOK capability qualification is not valid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saas_tenant_provider_account_capabilities_byok_fence';
  END IF;
  IF account_supply_mode IS DISTINCT FROM 'byok' THEN
    RETURN NEW;
  END IF;

  qualification_time := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1
      FROM saas_provider_rights AS rights
     WHERE rights.rights_id = account_rights_id
       AND rights.version = account_rights_version
       AND rights.provider_id = NEW.provider_id
       AND rights.product_id = NEW.product_id
       AND rights.credential_type = account_credential_type
       AND rights.supply_mode = account_supply_mode
       AND rights.region = account_region
       AND rights.purpose = account_purpose
       AND rights.model_scope @> ARRAY[NEW.model]::text[]
       AND rights.endpoint_scope @> ARRAY[NEW.endpoint]::text[]
       AND rights.status = 'active'
       AND rights.effective_at <= qualification_time
       AND (rights.expires_at IS NULL OR rights.expires_at > qualification_time)
       AND rights.version = (
         SELECT latest.version
           FROM saas_provider_rights AS latest
          WHERE latest.rights_id = rights.rights_id
            AND latest.effective_at <= qualification_time
          ORDER BY latest.effective_at DESC, latest.version DESC
          LIMIT 1
       )
  ) THEN
    RAISE EXCEPTION 'Provider BYOK capability qualification is not valid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saas_tenant_provider_account_capabilities_byok_fence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM saas_provider_capabilities AS capability
     WHERE capability.provider_id = NEW.provider_id
       AND capability.product_id = NEW.product_id
       AND capability.model = NEW.model
       AND capability.endpoint = NEW.endpoint
       AND capability.version = NEW.capability_version
       AND capability.version = (
         SELECT max(latest.version)
           FROM saas_provider_capabilities AS latest
          WHERE latest.provider_id = capability.provider_id
            AND latest.product_id = capability.product_id
            AND latest.model = capability.model
            AND latest.endpoint = capability.endpoint
       )
       AND capability.validation_state = 'verified'
       AND capability.support_level IN ('supported', 'limited')
  ) THEN
    RAISE EXCEPTION 'Provider BYOK capability qualification is not valid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'saas_tenant_provider_account_capabilities_byok_fence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_runtime_supply_profile_update_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'saas_supply_profile:' || encode(convert_to(NEW.tenant_id::text, 'UTF8'), 'hex') || ':' ||
        encode(convert_to(NEW.id, 'UTF8'), 'hex'),
      0
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_supply_profiles_runtime_advisory_fence
  BEFORE UPDATE ON saas_supply_profiles
  FOR EACH ROW EXECUTE FUNCTION saas_runtime_supply_profile_update_fence();

CREATE FUNCTION saas_runtime_platform_pool_update_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'saas_platform_pool:' || encode(convert_to(NEW.id, 'UTF8'), 'hex'),
      0
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pools_runtime_advisory_fence
  BEFORE UPDATE ON saas_platform_provider_pools
  FOR EACH ROW EXECUTE FUNCTION saas_runtime_platform_pool_update_fence();

CREATE FUNCTION saas_runtime_service_plan_update_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'saas_service_plan:' || encode(convert_to(NEW.id, 'UTF8'), 'hex'),
      0
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_service_plans_runtime_advisory_fence
  BEFORE UPDATE ON saas_service_plans
  FOR EACH ROW EXECUTE FUNCTION saas_runtime_service_plan_update_fence();

CREATE FUNCTION saas_runtime_service_plan_version_update_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'saas_service_plan:' || encode(convert_to(NEW.plan_id, 'UTF8'), 'hex'),
      0
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_service_plan_versions_runtime_advisory_fence
  BEFORE UPDATE ON saas_service_plan_versions
  FOR EACH ROW EXECUTE FUNCTION saas_runtime_service_plan_version_update_fence();
`;

export const RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION: SaasMigration = {
  version: 48,
  name: 'runtime_role_lock_fences',
  sql: runtimeRoleLockFencesSql,
};
