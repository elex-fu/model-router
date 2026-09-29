import type { SaasMigration } from './001_initial_schema.js';

const providerCatalogAndRightsSchemaSql = `
/*
 * Provider products are the stable referential boundary for the bounded
 * catalog module.  Provider accounts, credentials, pools, and entitlements
 * are intentionally owned by later modules and are not implied here.
 */
CREATE TABLE saas_provider_products (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, product_id),
  CONSTRAINT saas_provider_products_provider_nonempty CHECK (
    btrim(provider_id) <> '' AND provider_id = btrim(provider_id)
  ),
  CONSTRAINT saas_provider_products_product_nonempty CHECK (
    btrim(product_id) <> '' AND product_id = btrim(product_id)
  ),
  CONSTRAINT saas_provider_products_display_name_nonempty CHECK (
    btrim(display_name) <> ''
  )
);

CREATE FUNCTION saas_catalog_valid_scope(scope_values text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  scope_value text;
BEGIN
  IF scope_values IS NULL OR cardinality(scope_values) < 1 THEN
    RETURN FALSE;
  END IF;
  FOREACH scope_value IN ARRAY scope_values LOOP
    IF scope_value IS NULL
      OR btrim(scope_value) = ''
      OR scope_value <> btrim(scope_value)
      OR scope_value = '*' THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE TABLE saas_public_models (
  id text PRIMARY KEY,
  alias text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_public_models_id_nonempty CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_public_models_alias_nonempty CHECK (btrim(alias) <> '' AND alias = btrim(alias)),
  CONSTRAINT saas_public_models_display_name_nonempty CHECK (btrim(display_name) <> '')
);

CREATE TABLE saas_public_model_versions (
  public_model_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  model text NOT NULL,
  endpoint_scope text[] NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (public_model_id, version),
  CONSTRAINT saas_public_model_versions_scope_nonempty CHECK (
    saas_catalog_valid_scope(endpoint_scope)
  ),
  CONSTRAINT saas_public_model_versions_model_nonempty CHECK (
    btrim(model) <> ''
  ),
  CONSTRAINT saas_public_model_versions_public_model_fk
    FOREIGN KEY (public_model_id)
    REFERENCES saas_public_models (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_public_model_versions_provider_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT
);
CREATE INDEX saas_public_model_versions_provider_model_idx
  ON saas_public_model_versions (provider_id, product_id, model, version DESC);

CREATE TABLE saas_provider_capabilities (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  model text NOT NULL,
  endpoint text NOT NULL,
  protocol text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  support_level text NOT NULL
    CHECK (support_level IN ('supported', 'limited', 'unsupported')),
  validation_state text NOT NULL
    CHECK (validation_state IN ('unverified', 'verified', 'failed')),
  evidence_version text NOT NULL,
  discovery_source text NOT NULL
    CHECK (discovery_source IN ('preset', 'manual')),
  evidence_ref text NOT NULL,
  evidence_sha256 text NOT NULL
    CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, product_id, model, endpoint, version),
  CONSTRAINT saas_provider_capabilities_provider_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_capabilities_model_nonempty CHECK (btrim(model) <> ''),
  CONSTRAINT saas_provider_capabilities_endpoint_nonempty CHECK (btrim(endpoint) <> ''),
  CONSTRAINT saas_provider_capabilities_protocol_nonempty CHECK (btrim(protocol) <> ''),
  CONSTRAINT saas_provider_capabilities_evidence_version_nonempty CHECK (
    char_length(evidence_version) BETWEEN 1 AND 128
    AND btrim(evidence_version) <> ''
  ),
  CONSTRAINT saas_provider_capabilities_evidence_ref_nonempty CHECK (
    char_length(evidence_ref) BETWEEN 1 AND 512
    AND btrim(evidence_ref) <> ''
  )
);
CREATE INDEX saas_provider_capabilities_lookup_idx
  ON saas_provider_capabilities
    (provider_id, product_id, model, endpoint, version DESC);

CREATE TABLE saas_provider_rights (
  rights_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  credential_type text NOT NULL,
  supply_mode text NOT NULL
    CHECK (supply_mode IN ('byok', 'platform')),
  region text NOT NULL,
  purpose text NOT NULL,
  model_scope text[] NOT NULL,
  endpoint_scope text[] NOT NULL,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  approval_ref text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('draft', 'active', 'revoked')),
  evidence_ref text NOT NULL,
  evidence_sha256 text NOT NULL
    CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rights_id, version),
  CONSTRAINT saas_provider_rights_provider_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_rights_id_nonempty CHECK (
    btrim(rights_id) <> '' AND rights_id = btrim(rights_id)
  ),
  CONSTRAINT saas_provider_rights_credential_nonempty CHECK (
    btrim(credential_type) <> '' AND credential_type = btrim(credential_type)
  ),
  CONSTRAINT saas_provider_rights_region_nonempty CHECK (
    btrim(region) <> '' AND region = btrim(region)
  ),
  CONSTRAINT saas_provider_rights_purpose_nonempty CHECK (
    btrim(purpose) <> '' AND purpose = btrim(purpose)
  ),
  CONSTRAINT saas_provider_rights_scope_nonempty CHECK (
    saas_catalog_valid_scope(model_scope)
    AND saas_catalog_valid_scope(endpoint_scope)
  ),
  CONSTRAINT saas_provider_rights_validity_window CHECK (
    expires_at IS NULL OR expires_at > effective_at
  ),
  CONSTRAINT saas_provider_rights_approval_ref_nonempty CHECK (
    char_length(approval_ref) BETWEEN 1 AND 512
    AND
    btrim(approval_ref) <> ''
  ),
  CONSTRAINT saas_provider_rights_evidence_ref_nonempty CHECK (
    char_length(evidence_ref) BETWEEN 1 AND 512
    AND
    btrim(evidence_ref) <> ''
  )
);
CREATE INDEX saas_provider_rights_lookup_idx
  ON saas_provider_rights
    (provider_id, product_id, credential_type, supply_mode, region, purpose, rights_id, version DESC);
CREATE INDEX saas_provider_rights_model_scope_idx
  ON saas_provider_rights USING gin (model_scope);
CREATE INDEX saas_provider_rights_endpoint_scope_idx
  ON saas_provider_rights USING gin (endpoint_scope);

CREATE TABLE saas_provider_rights_events (
  id text PRIMARY KEY,
  rights_id text NOT NULL,
  rights_version integer NOT NULL,
  from_status text,
  to_status text NOT NULL
    CHECK (to_status IN ('draft', 'active', 'revoked')),
  event_type text NOT NULL
    CHECK (event_type IN ('created', 'versioned', 'revoked')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_provider_rights_events_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT saas_provider_rights_events_rights_fk
    FOREIGN KEY (rights_id, rights_version)
    REFERENCES saas_provider_rights (rights_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_rights_events_from_status_valid CHECK (
    from_status IS NULL OR from_status IN ('draft', 'active', 'revoked')
  )
);
CREATE INDEX saas_provider_rights_events_rights_idx
  ON saas_provider_rights_events (rights_id, rights_version, occurred_at DESC);

CREATE FUNCTION saas_catalog_require_capability_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_version integer;
BEGIN
  SELECT max(version)
    INTO latest_version
    FROM saas_provider_capabilities
   WHERE provider_id = NEW.provider_id
     AND product_id = NEW.product_id
     AND model = NEW.model
     AND endpoint = NEW.endpoint;
  IF NEW.version IS DISTINCT FROM COALESCE(latest_version + 1, 1) THEN
    RAISE EXCEPTION 'Provider capability versions must be appended sequentially'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_catalog_require_rights_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_version integer;
  latest_status text;
BEGIN
  SELECT version, status
    INTO latest_version, latest_status
    FROM saas_provider_rights
   WHERE rights_id = NEW.rights_id
   ORDER BY version DESC
   LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(latest_version + 1, 1) THEN
    RAISE EXCEPTION 'Provider rights versions must be appended sequentially'
      USING ERRCODE = '23514';
  END IF;
  IF latest_status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'Revoked provider rights cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_provider_capabilities_sequential_version
  BEFORE INSERT ON saas_provider_capabilities
  FOR EACH ROW EXECUTE FUNCTION saas_catalog_require_capability_version();
CREATE TRIGGER saas_provider_capabilities_immutable
  BEFORE UPDATE OR DELETE ON saas_provider_capabilities
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_provider_rights_sequential_version
  BEFORE INSERT ON saas_provider_rights
  FOR EACH ROW EXECUTE FUNCTION saas_catalog_require_rights_version();
CREATE TRIGGER saas_provider_rights_immutable
  BEFORE UPDATE OR DELETE ON saas_provider_rights
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_provider_rights_events_immutable
  BEFORE UPDATE OR DELETE ON saas_provider_rights_events
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_provider_products_immutable
  BEFORE UPDATE OR DELETE ON saas_provider_products
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_public_models_immutable
  BEFORE UPDATE OR DELETE ON saas_public_models
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_public_model_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_public_model_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
`;

export const PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION: SaasMigration = {
  version: 8,
  name: 'provider_catalog_and_rights',
  sql: providerCatalogAndRightsSchemaSql,
};
