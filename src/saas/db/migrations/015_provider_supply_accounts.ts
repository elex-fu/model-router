import type { SaasMigration } from './001_initial_schema.js';

const providerSupplyAccountsSchemaSql = `
/*
 * Provider supply keeps tenant BYOK and platform-owned supply in separate
 * owner families.  A platform row has no nullable tenant scope and never
 * uses a synthetic tenant ID.
 */
CREATE TABLE saas_tenant_provider_accounts (
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  id text NOT NULL,
  owner_kind text NOT NULL DEFAULT 'tenant' CHECK (owner_kind = 'tenant'),
  supply_mode text NOT NULL DEFAULT 'byok' CHECK (supply_mode = 'byok'),
  display_name text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  credential_type text NOT NULL,
  region text NOT NULL,
  purpose text NOT NULL,
  rights_id text NOT NULL,
  rights_version integer NOT NULL CHECK (rights_version >= 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled', 'revoked')),
  validation_state text NOT NULL DEFAULT 'unverified'
    CHECK (validation_state IN ('unverified', 'verified', 'failed')),
  validation_error_code text,
  last_validated_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT saas_tenant_provider_accounts_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_tenant_provider_accounts_display_name_nonempty
    CHECK (btrim(display_name) <> ''),
  CONSTRAINT saas_tenant_provider_accounts_provider_nonempty
    CHECK (btrim(provider_id) <> '' AND provider_id = btrim(provider_id)),
  CONSTRAINT saas_tenant_provider_accounts_product_nonempty
    CHECK (btrim(product_id) <> '' AND product_id = btrim(product_id)),
  CONSTRAINT saas_tenant_provider_accounts_credential_type_nonempty
    CHECK (btrim(credential_type) <> '' AND credential_type = btrim(credential_type)),
  CONSTRAINT saas_tenant_provider_accounts_region_nonempty
    CHECK (btrim(region) <> '' AND region = btrim(region)),
  CONSTRAINT saas_tenant_provider_accounts_purpose_nonempty
    CHECK (btrim(purpose) <> '' AND purpose = btrim(purpose)),
  CONSTRAINT saas_tenant_provider_accounts_validation_error_shape
    CHECK (
      (validation_state = 'failed' AND validation_error_code IS NOT NULL AND btrim(validation_error_code) <> '')
      OR
      (validation_state <> 'failed' AND validation_error_code IS NULL)
    ),
  CONSTRAINT saas_tenant_provider_accounts_lifecycle_shape
    CHECK (
      (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL)
    ),
  CONSTRAINT saas_tenant_provider_accounts_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_accounts_rights_fk
    FOREIGN KEY (rights_id, rights_version)
    REFERENCES saas_provider_rights (rights_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_accounts_account_identity_unique
    UNIQUE (tenant_id, id, provider_id, product_id)
);

CREATE TABLE saas_platform_provider_accounts (
  id text PRIMARY KEY,
  owner_kind text NOT NULL DEFAULT 'platform' CHECK (owner_kind = 'platform'),
  supply_mode text NOT NULL DEFAULT 'platform' CHECK (supply_mode = 'platform'),
  display_name text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  credential_type text NOT NULL,
  region text NOT NULL,
  purpose text NOT NULL,
  rights_id text NOT NULL,
  rights_version integer NOT NULL CHECK (rights_version >= 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled', 'revoked')),
  validation_state text NOT NULL DEFAULT 'unverified'
    CHECK (validation_state IN ('unverified', 'verified', 'failed')),
  validation_error_code text,
  last_validated_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT saas_platform_provider_accounts_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_platform_provider_accounts_display_name_nonempty
    CHECK (btrim(display_name) <> ''),
  CONSTRAINT saas_platform_provider_accounts_provider_nonempty
    CHECK (btrim(provider_id) <> '' AND provider_id = btrim(provider_id)),
  CONSTRAINT saas_platform_provider_accounts_product_nonempty
    CHECK (btrim(product_id) <> '' AND product_id = btrim(product_id)),
  CONSTRAINT saas_platform_provider_accounts_credential_type_nonempty
    CHECK (btrim(credential_type) <> '' AND credential_type = btrim(credential_type)),
  CONSTRAINT saas_platform_provider_accounts_region_nonempty
    CHECK (btrim(region) <> '' AND region = btrim(region)),
  CONSTRAINT saas_platform_provider_accounts_purpose_nonempty
    CHECK (btrim(purpose) <> '' AND purpose = btrim(purpose)),
  CONSTRAINT saas_platform_provider_accounts_validation_error_shape
    CHECK (
      (validation_state = 'failed' AND validation_error_code IS NOT NULL AND btrim(validation_error_code) <> '')
      OR
      (validation_state <> 'failed' AND validation_error_code IS NULL)
    ),
  CONSTRAINT saas_platform_provider_accounts_lifecycle_shape
    CHECK (
      (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL)
    ),
  CONSTRAINT saas_platform_provider_accounts_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_accounts_rights_fk
    FOREIGN KEY (rights_id, rights_version)
    REFERENCES saas_provider_rights (rights_id, version),
  CONSTRAINT saas_platform_provider_accounts_account_identity_unique
    UNIQUE (id, provider_id, product_id)
);

CREATE INDEX saas_tenant_provider_accounts_lookup_idx
  ON saas_tenant_provider_accounts (tenant_id, provider_id, product_id, status, created_at);
CREATE INDEX saas_platform_provider_accounts_lookup_idx
  ON saas_platform_provider_accounts (provider_id, product_id, status, created_at);

/* An account may be validated against more than one catalog capability. */
CREATE TABLE saas_tenant_provider_account_capabilities (
  tenant_id uuid NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  model text NOT NULL,
  endpoint text NOT NULL,
  capability_version integer NOT NULL CHECK (capability_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version),
  CONSTRAINT saas_tenant_provider_account_capabilities_account_fk
    FOREIGN KEY (tenant_id, account_id, provider_id, product_id)
    REFERENCES saas_tenant_provider_accounts (tenant_id, id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_account_capabilities_capability_fk
    FOREIGN KEY (provider_id, product_id, model, endpoint, capability_version)
    REFERENCES saas_provider_capabilities (provider_id, product_id, model, endpoint, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_account_capabilities_model_nonempty
    CHECK (btrim(model) <> ''),
  CONSTRAINT saas_tenant_provider_account_capabilities_endpoint_nonempty
    CHECK (btrim(endpoint) <> '')
);

CREATE TABLE saas_platform_provider_account_capabilities (
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  model text NOT NULL,
  endpoint text NOT NULL,
  capability_version integer NOT NULL CHECK (capability_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider_id, product_id, model, endpoint, capability_version),
  CONSTRAINT saas_platform_provider_account_capabilities_account_fk
    FOREIGN KEY (account_id, provider_id, product_id)
    REFERENCES saas_platform_provider_accounts (id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_account_capabilities_capability_fk
    FOREIGN KEY (provider_id, product_id, model, endpoint, capability_version)
    REFERENCES saas_provider_capabilities (provider_id, product_id, model, endpoint, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_account_capabilities_model_nonempty
    CHECK (btrim(model) <> ''),
  CONSTRAINT saas_platform_provider_account_capabilities_endpoint_nonempty
    CHECK (btrim(endpoint) <> '')
);

CREATE FUNCTION saas_provider_supply_validate_rights() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
  ) THEN
    RAISE EXCEPTION 'Provider account rights do not match its immutable supply boundary'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_provider_accounts_validate_rights
  BEFORE INSERT OR UPDATE OF provider_id, product_id, credential_type, supply_mode,
    region, purpose, rights_id, rights_version ON saas_tenant_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_validate_rights();
CREATE TRIGGER saas_platform_provider_accounts_validate_rights
  BEFORE INSERT OR UPDATE OF provider_id, product_id, credential_type, supply_mode,
    region, purpose, rights_id, rights_version ON saas_platform_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_validate_rights();

CREATE TABLE saas_tenant_provider_credentials (
  tenant_id uuid NOT NULL,
  id text NOT NULL,
  owner_kind text NOT NULL DEFAULT 'tenant' CHECK (owner_kind = 'tenant'),
  supply_mode text NOT NULL DEFAULT 'byok' CHECK (supply_mode = 'byok'),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  credential_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled', 'revoked')),
  validation_state text NOT NULL DEFAULT 'unverified'
    CHECK (validation_state IN ('unverified', 'verified', 'failed')),
  validation_error_code text,
  last_validated_at timestamptz,
  current_version integer,
  expires_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT saas_tenant_provider_credentials_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_tenant_provider_credentials_provider_nonempty
    CHECK (btrim(provider_id) <> '' AND provider_id = btrim(provider_id)),
  CONSTRAINT saas_tenant_provider_credentials_product_nonempty
    CHECK (btrim(product_id) <> '' AND product_id = btrim(product_id)),
  CONSTRAINT saas_tenant_provider_credentials_type_nonempty
    CHECK (btrim(credential_type) <> '' AND credential_type = btrim(credential_type)),
  CONSTRAINT saas_tenant_provider_credentials_validation_error_shape
    CHECK (
      (validation_state = 'failed' AND validation_error_code IS NOT NULL AND btrim(validation_error_code) <> '')
      OR
      (validation_state <> 'failed' AND validation_error_code IS NULL)
    ),
  CONSTRAINT saas_tenant_provider_credentials_lifecycle_shape
    CHECK (
      (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL)
    ),
  CONSTRAINT saas_tenant_provider_credentials_account_fk
    FOREIGN KEY (tenant_id, account_id, provider_id, product_id)
    REFERENCES saas_tenant_provider_accounts (tenant_id, id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_credentials_identity_unique
    UNIQUE (tenant_id, id, account_id),
  CONSTRAINT saas_tenant_provider_credentials_account_type_check
    CHECK (credential_type = btrim(credential_type))
);

CREATE TABLE saas_platform_provider_credentials (
  id text PRIMARY KEY,
  owner_kind text NOT NULL DEFAULT 'platform' CHECK (owner_kind = 'platform'),
  supply_mode text NOT NULL DEFAULT 'platform' CHECK (supply_mode = 'platform'),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  credential_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled', 'revoked')),
  validation_state text NOT NULL DEFAULT 'unverified'
    CHECK (validation_state IN ('unverified', 'verified', 'failed')),
  validation_error_code text,
  last_validated_at timestamptz,
  current_version integer,
  expires_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT saas_platform_provider_credentials_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_platform_provider_credentials_provider_nonempty
    CHECK (btrim(provider_id) <> '' AND provider_id = btrim(provider_id)),
  CONSTRAINT saas_platform_provider_credentials_product_nonempty
    CHECK (btrim(product_id) <> '' AND product_id = btrim(product_id)),
  CONSTRAINT saas_platform_provider_credentials_type_nonempty
    CHECK (btrim(credential_type) <> '' AND credential_type = btrim(credential_type)),
  CONSTRAINT saas_platform_provider_credentials_validation_error_shape
    CHECK (
      (validation_state = 'failed' AND validation_error_code IS NOT NULL AND btrim(validation_error_code) <> '')
      OR
      (validation_state <> 'failed' AND validation_error_code IS NULL)
    ),
  CONSTRAINT saas_platform_provider_credentials_lifecycle_shape
    CHECK (
      (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL)
    ),
  CONSTRAINT saas_platform_provider_credentials_account_fk
    FOREIGN KEY (account_id, provider_id, product_id)
    REFERENCES saas_platform_provider_accounts (id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_credentials_identity_unique
    UNIQUE (id, account_id)
);

CREATE TABLE saas_tenant_provider_credential_versions (
  tenant_id uuid NOT NULL,
  account_id text NOT NULL,
  credential_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  owner_kind text NOT NULL DEFAULT 'tenant' CHECK (owner_kind = 'tenant'),
  supply_mode text NOT NULL DEFAULT 'byok' CHECK (supply_mode = 'byok'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  context_version integer NOT NULL CHECK (context_version >= 1),
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  kms_purpose text NOT NULL,
  kms_key_id text NOT NULL,
  wrapping_revision integer NOT NULL DEFAULT 1 CHECK (wrapping_revision >= 1),
  wrapped_dek text NOT NULL,
  nonce text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, credential_id, version),
  CONSTRAINT saas_tenant_provider_credential_versions_parent_fk
    FOREIGN KEY (tenant_id, credential_id, account_id)
    REFERENCES saas_tenant_provider_credentials (tenant_id, id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_credential_versions_text_nonempty
    CHECK (
      btrim(kms_purpose) <> ''
      AND btrim(kms_key_id) <> ''
      AND btrim(wrapped_dek) <> ''
      AND btrim(nonce) <> ''
      AND btrim(ciphertext) <> ''
      AND btrim(auth_tag) <> ''
    ),
  CONSTRAINT saas_tenant_provider_credential_versions_lifecycle_shape
    CHECK (
      (status = 'active' AND retired_at IS NULL AND revoked_at IS NULL)
      OR (status = 'retired' AND retired_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE TABLE saas_platform_provider_credential_versions (
  account_id text NOT NULL,
  credential_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  owner_kind text NOT NULL DEFAULT 'platform' CHECK (owner_kind = 'platform'),
  supply_mode text NOT NULL DEFAULT 'platform' CHECK (supply_mode = 'platform'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  context_version integer NOT NULL CHECK (context_version >= 1),
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  kms_purpose text NOT NULL,
  kms_key_id text NOT NULL,
  wrapping_revision integer NOT NULL DEFAULT 1 CHECK (wrapping_revision >= 1),
  wrapped_dek text NOT NULL,
  nonce text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (credential_id, version),
  CONSTRAINT saas_platform_provider_credential_versions_parent_fk
    FOREIGN KEY (credential_id, account_id)
    REFERENCES saas_platform_provider_credentials (id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_credential_versions_text_nonempty
    CHECK (
      btrim(kms_purpose) <> ''
      AND btrim(kms_key_id) <> ''
      AND btrim(wrapped_dek) <> ''
      AND btrim(nonce) <> ''
      AND btrim(ciphertext) <> ''
      AND btrim(auth_tag) <> ''
    ),
  CONSTRAINT saas_platform_provider_credential_versions_lifecycle_shape
    CHECK (
      (status = 'active' AND retired_at IS NULL AND revoked_at IS NULL)
      OR (status = 'retired' AND retired_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

ALTER TABLE saas_tenant_provider_credentials
  ADD CONSTRAINT saas_tenant_provider_credentials_current_version_fk
  FOREIGN KEY (tenant_id, id, current_version)
  REFERENCES saas_tenant_provider_credential_versions (tenant_id, credential_id, version)
  ON DELETE RESTRICT;
ALTER TABLE saas_platform_provider_credentials
  ADD CONSTRAINT saas_platform_provider_credentials_current_version_fk
  FOREIGN KEY (id, current_version)
  REFERENCES saas_platform_provider_credential_versions (credential_id, version)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX saas_tenant_provider_credential_versions_one_active_idx
  ON saas_tenant_provider_credential_versions (tenant_id, credential_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX saas_platform_provider_credential_versions_one_active_idx
  ON saas_platform_provider_credential_versions (credential_id)
  WHERE status = 'active';
CREATE INDEX saas_tenant_provider_credentials_lookup_idx
  ON saas_tenant_provider_credentials (tenant_id, account_id, status, created_at);
CREATE INDEX saas_platform_provider_credentials_lookup_idx
  ON saas_platform_provider_credentials (account_id, status, created_at);

CREATE FUNCTION saas_provider_supply_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider supply history is immutable and cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

CREATE FUNCTION saas_provider_credential_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider credential versions cannot be deleted'
      USING ERRCODE = '55006';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
    OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.context_version IS DISTINCT FROM OLD.context_version
    OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
    OR NEW.kms_purpose IS DISTINCT FROM OLD.kms_purpose
    OR NEW.kms_key_id IS DISTINCT FROM OLD.kms_key_id
    OR NEW.wrapping_revision IS DISTINCT FROM OLD.wrapping_revision
    OR NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek
    OR NEW.nonce IS DISTINCT FROM OLD.nonce
    OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
    OR NEW.auth_tag IS DISTINCT FROM OLD.auth_tag
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'Provider credential envelope identity and ciphertext are immutable'
      USING ERRCODE = '55006';
  END IF;

  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'Revoked provider credential versions cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'retired' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'Retired provider credential versions cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_provider_accounts_no_delete
  BEFORE DELETE ON saas_tenant_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();
CREATE TRIGGER saas_platform_provider_accounts_no_delete
  BEFORE DELETE ON saas_platform_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();
CREATE TRIGGER saas_tenant_provider_credentials_no_delete
  BEFORE DELETE ON saas_tenant_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();
CREATE TRIGGER saas_platform_provider_credentials_no_delete
  BEFORE DELETE ON saas_platform_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();
CREATE TRIGGER saas_tenant_provider_credential_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_provider_credential_versions
  FOR EACH ROW EXECUTE FUNCTION saas_provider_credential_version_immutable();
CREATE TRIGGER saas_platform_provider_credential_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_platform_provider_credential_versions
  FOR EACH ROW EXECUTE FUNCTION saas_provider_credential_version_immutable();
`;

export const PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION: SaasMigration = {
  version: 15,
  name: 'provider_supply_accounts_and_credentials',
  sql: providerSupplyAccountsSchemaSql,
};
