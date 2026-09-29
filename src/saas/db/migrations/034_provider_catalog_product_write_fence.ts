import type { SaasMigration } from './001_initial_schema.js';

const providerCatalogProductWriteFenceSql = `
CREATE FUNCTION saas_catalog_lock_product_for_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM saas_provider_products
   WHERE provider_id = NEW.provider_id
     AND product_id = NEW.product_id
   FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_provider_capabilities_lock_product
  BEFORE INSERT ON saas_provider_capabilities
  FOR EACH ROW EXECUTE FUNCTION saas_catalog_lock_product_for_version_insert();

CREATE TRIGGER saas_provider_rights_lock_product
  BEFORE INSERT ON saas_provider_rights
  FOR EACH ROW EXECUTE FUNCTION saas_catalog_lock_product_for_version_insert();

CREATE FUNCTION saas_provider_supply_require_byok_rights() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  qualification_time timestamptz;
BEGIN
  IF NEW.supply_mode IS DISTINCT FROM 'byok' THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM saas_provider_products
   WHERE provider_id = NEW.provider_id
     AND product_id = NEW.product_id
   FOR SHARE;
  IF NOT FOUND THEN
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

CREATE TRIGGER saas_tenant_provider_accounts_require_byok_rights
  BEFORE INSERT OR UPDATE ON saas_tenant_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_require_byok_rights();

CREATE FUNCTION saas_provider_supply_require_byok_capability() RETURNS trigger
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
  PERFORM 1
    FROM saas_provider_products
   WHERE provider_id = NEW.provider_id
     AND product_id = NEW.product_id
   FOR SHARE;
  IF NOT FOUND THEN
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

CREATE TRIGGER saas_tenant_provider_account_capabilities_byok_fence
  BEFORE INSERT OR UPDATE ON saas_tenant_provider_account_capabilities
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_require_byok_capability();
`;

export const PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION: SaasMigration = {
  version: 34,
  name: 'provider_catalog_product_write_fence',
  sql: providerCatalogProductWriteFenceSql,
};
