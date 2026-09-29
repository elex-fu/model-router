import type { SaasMigration } from './001_initial_schema.js';

/**
 * Contract: migration 015 owns provider accounts, both credential families,
 * immutable credential semantic versions, and the inline envelope metadata
 * (including wrapping_revision).  This migration adds only platform-owned
 * pools and their explicit tenant-profile grants.  A grant contains tenant
 * scope and a platform supply-profile reference, but never changes ownership
 * of the platform account or credential selected by a pool member.
 *
 * The existing v15 inline wrapping_revision remains the repository contract.
 * An append-only wrapping table plus CAS active-wrapping pointer is deliberately
 * deferred until the repository/service can read and write that split shape in
 * one transaction; no incompatible shadow schema is introduced here.
 */
const providerSupplyPoolSchemaSql = `
/*
 * v15's credential-version trigger was written against the tenant version
 * shape and is also attached to the platform version table.  Replace its
 * body here without changing the v15 migration checksum: common fields are
 * read through row JSON, while tenant_id is compared only for the tenant
 * version table because platform versions have no tenant_id column.
 */
CREATE OR REPLACE FUNCTION saas_provider_credential_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  field_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider credential versions cannot be deleted'
      USING ERRCODE = '55006';
  END IF;

  IF TG_TABLE_NAME = 'saas_tenant_provider_credential_versions'
    AND (new_row ->> 'tenant_id') IS DISTINCT FROM (old_row ->> 'tenant_id')
  THEN
    RAISE EXCEPTION 'Provider credential version owner is immutable'
      USING ERRCODE = '55006';
  END IF;

  FOREACH field_name IN ARRAY ARRAY[
    'account_id', 'credential_id', 'version', 'owner_kind', 'supply_mode',
    'schema_version', 'context_version', 'algorithm', 'kms_purpose',
    'kms_key_id', 'wrapping_revision', 'wrapped_dek', 'nonce', 'ciphertext',
    'auth_tag', 'created_at', 'expires_at'
  ] LOOP
    IF (new_row -> field_name) IS DISTINCT FROM (old_row -> field_name) THEN
      RAISE EXCEPTION 'Provider credential envelope identity and ciphertext are immutable'
        USING ERRCODE = '55006';
    END IF;
  END LOOP;

  IF old_row ->> 'status' = 'revoked' AND new_row ->> 'status' <> 'revoked' THEN
    RAISE EXCEPTION 'Revoked provider credential versions cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  IF old_row ->> 'status' = 'retired' AND new_row ->> 'status' = 'active' THEN
    RAISE EXCEPTION 'Retired provider credential versions cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

/*
 * The authz_version fields below are invalidation epochs, not caller
 * authority.  Writers must advance the owning account/profile/pool epoch
 * with their lifecycle change; a resolver must reject a member or grant
 * whose recorded snapshot no longer matches the current row.  The v15
 * repository already advances account/credential epochs and revokes the
 * active credential version.  Pool/profile resolver wiring remains a later
 * service integration, so this migration records the evidence needed for
 * that check without inventing a second storage contract.
 */
CREATE TABLE saas_platform_provider_pools (
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
  CONSTRAINT saas_platform_provider_pools_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_platform_provider_pools_display_name_nonempty
    CHECK (btrim(display_name) <> ''),
  CONSTRAINT saas_platform_provider_pools_provider_nonempty
    CHECK (btrim(provider_id) <> '' AND provider_id = btrim(provider_id)),
  CONSTRAINT saas_platform_provider_pools_product_nonempty
    CHECK (btrim(product_id) <> '' AND product_id = btrim(product_id)),
  CONSTRAINT saas_platform_provider_pools_credential_type_nonempty
    CHECK (btrim(credential_type) <> '' AND credential_type = btrim(credential_type)),
  CONSTRAINT saas_platform_provider_pools_region_nonempty
    CHECK (btrim(region) <> '' AND region = btrim(region)),
  CONSTRAINT saas_platform_provider_pools_purpose_nonempty
    CHECK (btrim(purpose) <> '' AND purpose = btrim(purpose)),
  CONSTRAINT saas_platform_provider_pools_validation_error_shape
    CHECK (
      (validation_state = 'failed' AND validation_error_code IS NOT NULL AND btrim(validation_error_code) <> '')
      OR
      (validation_state <> 'failed' AND validation_error_code IS NULL)
    ),
  CONSTRAINT saas_platform_provider_pools_lifecycle_shape
    CHECK (
      (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status IN ('pending', 'active') AND disabled_at IS NULL AND revoked_at IS NULL)
    ),
  CONSTRAINT saas_platform_provider_pools_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_pools_rights_fk
    FOREIGN KEY (rights_id, rights_version)
    REFERENCES saas_provider_rights (rights_id, version)
    ON DELETE RESTRICT
);

CREATE INDEX saas_platform_provider_pools_lookup_idx
  ON saas_platform_provider_pools (provider_id, product_id, status, created_at);

CREATE FUNCTION saas_provider_pool_validate_rights() RETURNS trigger
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
    RAISE EXCEPTION 'Provider pool rights do not match its immutable supply boundary'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pools_validate_rights
  BEFORE INSERT OR UPDATE OF provider_id, product_id, credential_type, supply_mode,
    region, purpose, rights_id, rights_version ON saas_platform_provider_pools
  FOR EACH ROW EXECUTE FUNCTION saas_provider_pool_validate_rights();

CREATE FUNCTION saas_provider_pool_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
    OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.credential_type IS DISTINCT FROM OLD.credential_type
    OR NEW.region IS DISTINCT FROM OLD.region
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.rights_id IS DISTINCT FROM OLD.rights_id
    OR NEW.rights_version IS DISTINCT FROM OLD.rights_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider pool supply boundary is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pools_identity_immutable
  BEFORE UPDATE ON saas_platform_provider_pools
  FOR EACH ROW EXECUTE FUNCTION saas_provider_pool_identity_immutable();
CREATE TRIGGER saas_platform_provider_pools_no_delete
  BEFORE DELETE ON saas_platform_provider_pools
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();

CREATE TABLE saas_platform_provider_pool_members (
  pool_id text NOT NULL
    REFERENCES saas_platform_provider_pools (id) ON DELETE RESTRICT,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  account_authz_version bigint NOT NULL CHECK (account_authz_version >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (pool_id, account_id),
  CONSTRAINT saas_platform_provider_pool_members_account_fk
    FOREIGN KEY (account_id, provider_id, product_id)
    REFERENCES saas_platform_provider_accounts (id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_pool_members_lifecycle_shape
    CHECK (
      (status = 'active' AND disabled_at IS NULL AND revoked_at IS NULL)
      OR (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX saas_platform_provider_pool_members_account_idx
  ON saas_platform_provider_pool_members (account_id, provider_id, product_id, status);

CREATE FUNCTION saas_provider_pool_member_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pool_id IS DISTINCT FROM OLD.pool_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.account_authz_version IS DISTINCT FROM OLD.account_authz_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider pool membership identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pool_members_identity_immutable
  BEFORE UPDATE ON saas_platform_provider_pool_members
  FOR EACH ROW EXECUTE FUNCTION saas_provider_pool_member_identity_immutable();
CREATE TRIGGER saas_platform_provider_pool_members_no_delete
  BEFORE DELETE ON saas_platform_provider_pool_members
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();

CREATE TABLE saas_platform_provider_pool_grants (
  pool_id text NOT NULL
    REFERENCES saas_platform_provider_pools (id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  supply_profile_id text NOT NULL,
  supply_mode text NOT NULL DEFAULT 'platform' CHECK (supply_mode = 'platform'),
  profile_authz_version bigint NOT NULL CHECK (profile_authz_version >= 1),
  pool_authz_version bigint NOT NULL CHECK (pool_authz_version >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'revoked')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  evidence_ref text NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (pool_id, tenant_id, supply_profile_id),
  CONSTRAINT saas_platform_provider_pool_grants_profile_fk
    FOREIGN KEY (tenant_id, supply_profile_id, supply_mode)
    REFERENCES saas_supply_profiles (tenant_id, id, supply_mode)
    ON DELETE RESTRICT,
  CONSTRAINT saas_platform_provider_pool_grants_expiry_check
    CHECK (expires_at IS NULL OR expires_at > effective_at),
  CONSTRAINT saas_platform_provider_pool_grants_evidence_nonempty
    CHECK (btrim(evidence_ref) <> ''),
  CONSTRAINT saas_platform_provider_pool_grants_lifecycle_shape
    CHECK (
      (status = 'active' AND disabled_at IS NULL AND revoked_at IS NULL)
      OR (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX saas_platform_provider_pool_grants_profile_idx
  ON saas_platform_provider_pool_grants (tenant_id, supply_profile_id, status, effective_at DESC);
CREATE INDEX saas_platform_provider_pool_grants_pool_idx
  ON saas_platform_provider_pool_grants (pool_id, status, effective_at DESC);

CREATE FUNCTION saas_provider_pool_grant_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pool_id IS DISTINCT FROM OLD.pool_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.supply_profile_id IS DISTINCT FROM OLD.supply_profile_id
    OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
    OR NEW.profile_authz_version IS DISTINCT FROM OLD.profile_authz_version
    OR NEW.pool_authz_version IS DISTINCT FROM OLD.pool_authz_version
    OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
    OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider pool grant identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pool_grants_identity_immutable
  BEFORE UPDATE ON saas_platform_provider_pool_grants
  FOR EACH ROW EXECUTE FUNCTION saas_provider_pool_grant_identity_immutable();
CREATE TRIGGER saas_platform_provider_pool_grants_no_delete
  BEFORE DELETE ON saas_platform_provider_pool_grants
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();

CREATE TABLE saas_tenant_provider_supply_profile_accounts (
  tenant_id uuid NOT NULL,
  supply_profile_id text NOT NULL,
  supply_mode text NOT NULL DEFAULT 'byok' CHECK (supply_mode = 'byok'),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  account_authz_version bigint NOT NULL CHECK (account_authz_version >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'revoked')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  evidence_ref text NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, supply_profile_id, account_id),
  CONSTRAINT saas_tenant_provider_supply_profile_accounts_profile_fk
    FOREIGN KEY (tenant_id, supply_profile_id, supply_mode)
    REFERENCES saas_supply_profiles (tenant_id, id, supply_mode)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_supply_profile_accounts_account_fk
    FOREIGN KEY (tenant_id, account_id, provider_id, product_id)
    REFERENCES saas_tenant_provider_accounts (tenant_id, id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_supply_profile_accounts_expiry_check
    CHECK (expires_at IS NULL OR expires_at > effective_at),
  CONSTRAINT saas_tenant_provider_supply_profile_accounts_evidence_nonempty
    CHECK (btrim(evidence_ref) <> ''),
  CONSTRAINT saas_tenant_provider_supply_profile_accounts_lifecycle_shape
    CHECK (
      (status = 'active' AND disabled_at IS NULL AND revoked_at IS NULL)
      OR (status = 'disabled' AND disabled_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX saas_tenant_provider_supply_profile_accounts_profile_idx
  ON saas_tenant_provider_supply_profile_accounts
    (tenant_id, supply_profile_id, status, effective_at DESC);
CREATE INDEX saas_tenant_provider_supply_profile_accounts_account_idx
  ON saas_tenant_provider_supply_profile_accounts
    (tenant_id, account_id, status, effective_at DESC);

CREATE FUNCTION saas_tenant_provider_supply_profile_account_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.supply_profile_id IS DISTINCT FROM OLD.supply_profile_id
    OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.account_authz_version IS DISTINCT FROM OLD.account_authz_version
    OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
    OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Tenant supply-profile account mapping identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_provider_supply_profile_accounts_identity_immutable
  BEFORE UPDATE ON saas_tenant_provider_supply_profile_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_tenant_provider_supply_profile_account_identity_immutable();
CREATE TRIGGER saas_tenant_provider_supply_profile_accounts_no_delete
  BEFORE DELETE ON saas_tenant_provider_supply_profile_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_reject_delete();
`;

export const PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION: SaasMigration = {
  version: 16,
  name: 'provider_supply_pools_and_profile_grants',
  sql: providerSupplyPoolSchemaSql,
};
