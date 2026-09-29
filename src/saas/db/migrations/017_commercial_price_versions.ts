import type { SaasMigration } from './001_initial_schema.js';

const commercialPriceVersionsSchemaSql = `
/*
 * Commercial prices are append-only facts.  A version is identified by its
 * opaque id and by the complete commercial identity below; the two snapshot
 * tables copy the request scope and the policy inputs needed by admission and
 * later settlement.  Rates are rational integers, never PostgreSQL numeric
 * values or application floating point values.
 */
CREATE TABLE saas_customer_price_versions (
  id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 1),
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  protocol text NOT NULL,
  endpoint text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  commercial_policy_version text NOT NULL,
  calculator_version text NOT NULL,
  rounding_version text NOT NULL,
  rounding_mode text NOT NULL
    CHECK (rounding_mode IN ('floor', 'ceil', 'half_up', 'half_even')),
  rounding_boundary text NOT NULL DEFAULT 'total'
    CHECK (rounding_boundary = 'total'),
  input_rate_numerator_minor_units bigint NOT NULL CHECK (input_rate_numerator_minor_units >= 0),
  input_rate_denominator_units bigint NOT NULL CHECK (input_rate_denominator_units > 0),
  cache_read_rate_numerator_minor_units bigint,
  cache_read_rate_denominator_units bigint,
  cache_write_rate_numerator_minor_units bigint,
  cache_write_rate_denominator_units bigint,
  cache_write_5m_rate_numerator_minor_units bigint,
  cache_write_5m_rate_denominator_units bigint,
  cache_write_1h_rate_numerator_minor_units bigint,
  cache_write_1h_rate_denominator_units bigint,
  output_rate_numerator_minor_units bigint NOT NULL CHECK (output_rate_numerator_minor_units >= 0),
  output_rate_denominator_units bigint NOT NULL CHECK (output_rate_denominator_units > 0),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  idempotency_key text NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_customer_price_versions_public_model_fk
    FOREIGN KEY (public_model_id, public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_customer_price_versions_provider_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_customer_price_versions_id_nonempty CHECK (
    char_length(id) BETWEEN 1 AND 255 AND id = btrim(id)
  ),
  CONSTRAINT saas_customer_price_versions_text_nonempty CHECK (
    btrim(public_model_id) <> ''
    AND btrim(provider_id) <> ''
    AND btrim(product_id) <> ''
    AND btrim(protocol) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(commercial_policy_version) <> ''
    AND btrim(calculator_version) <> ''
    AND btrim(rounding_version) <> ''
  ),
  CONSTRAINT saas_customer_price_versions_window CHECK (
    expires_at IS NULL OR expires_at > effective_at
  ),
  CONSTRAINT saas_customer_price_versions_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 512
    AND idempotency_key = btrim(idempotency_key)
  ),
  CONSTRAINT saas_customer_price_versions_cache_read_rate_pair CHECK (
    (cache_read_rate_numerator_minor_units IS NULL) = (cache_read_rate_denominator_units IS NULL)
    AND (
      cache_read_rate_numerator_minor_units IS NULL
      OR (cache_read_rate_numerator_minor_units >= 0 AND cache_read_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_customer_price_versions_cache_write_rate_pair CHECK (
    (cache_write_rate_numerator_minor_units IS NULL) = (cache_write_rate_denominator_units IS NULL)
    AND (
      cache_write_rate_numerator_minor_units IS NULL
      OR (cache_write_rate_numerator_minor_units >= 0 AND cache_write_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_customer_price_versions_cache_write_5m_rate_pair CHECK (
    (cache_write_5m_rate_numerator_minor_units IS NULL) = (cache_write_5m_rate_denominator_units IS NULL)
    AND (
      cache_write_5m_rate_numerator_minor_units IS NULL
      OR (cache_write_5m_rate_numerator_minor_units >= 0 AND cache_write_5m_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_customer_price_versions_cache_write_1h_rate_pair CHECK (
    (cache_write_1h_rate_numerator_minor_units IS NULL) = (cache_write_1h_rate_denominator_units IS NULL)
    AND (
      cache_write_1h_rate_numerator_minor_units IS NULL
      OR (cache_write_1h_rate_numerator_minor_units >= 0 AND cache_write_1h_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_customer_price_versions_identity_unique UNIQUE (
    public_model_id, public_model_version, provider_id, product_id, protocol, endpoint, currency, version
  ),
  CONSTRAINT saas_customer_price_versions_idempotency_unique UNIQUE (
    public_model_id, public_model_version, provider_id, product_id, protocol, endpoint, currency, idempotency_key
  )
);

CREATE INDEX saas_customer_price_versions_lookup_idx
  ON saas_customer_price_versions
    (public_model_id, public_model_version, provider_id, product_id, protocol, endpoint, currency,
     effective_at DESC, version DESC);

CREATE TABLE saas_supplier_cost_versions (
  id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 1),
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  resolved_model text NOT NULL,
  protocol text NOT NULL,
  endpoint text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  commercial_policy_version text NOT NULL,
  calculator_version text NOT NULL,
  rounding_version text NOT NULL,
  rounding_mode text NOT NULL
    CHECK (rounding_mode IN ('floor', 'ceil', 'half_up', 'half_even')),
  rounding_boundary text NOT NULL DEFAULT 'total'
    CHECK (rounding_boundary = 'total'),
  input_rate_numerator_minor_units bigint NOT NULL CHECK (input_rate_numerator_minor_units >= 0),
  input_rate_denominator_units bigint NOT NULL CHECK (input_rate_denominator_units > 0),
  cache_read_rate_numerator_minor_units bigint,
  cache_read_rate_denominator_units bigint,
  cache_write_rate_numerator_minor_units bigint,
  cache_write_rate_denominator_units bigint,
  cache_write_5m_rate_numerator_minor_units bigint,
  cache_write_5m_rate_denominator_units bigint,
  cache_write_1h_rate_numerator_minor_units bigint,
  cache_write_1h_rate_denominator_units bigint,
  output_rate_numerator_minor_units bigint NOT NULL CHECK (output_rate_numerator_minor_units >= 0),
  output_rate_denominator_units bigint NOT NULL CHECK (output_rate_denominator_units > 0),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  idempotency_key text NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_supplier_cost_versions_public_model_fk
    FOREIGN KEY (public_model_id, public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_supplier_cost_versions_provider_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_supplier_cost_versions_id_nonempty CHECK (
    char_length(id) BETWEEN 1 AND 255 AND id = btrim(id)
  ),
  CONSTRAINT saas_supplier_cost_versions_text_nonempty CHECK (
    btrim(public_model_id) <> ''
    AND btrim(provider_id) <> ''
    AND btrim(product_id) <> ''
    AND btrim(resolved_model) <> ''
    AND btrim(protocol) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(commercial_policy_version) <> ''
    AND btrim(calculator_version) <> ''
    AND btrim(rounding_version) <> ''
  ),
  CONSTRAINT saas_supplier_cost_versions_window CHECK (
    expires_at IS NULL OR expires_at > effective_at
  ),
  CONSTRAINT saas_supplier_cost_versions_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 512
    AND idempotency_key = btrim(idempotency_key)
  ),
  CONSTRAINT saas_supplier_cost_versions_cache_read_rate_pair CHECK (
    (cache_read_rate_numerator_minor_units IS NULL) = (cache_read_rate_denominator_units IS NULL)
    AND (
      cache_read_rate_numerator_minor_units IS NULL
      OR (cache_read_rate_numerator_minor_units >= 0 AND cache_read_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_supplier_cost_versions_cache_write_rate_pair CHECK (
    (cache_write_rate_numerator_minor_units IS NULL) = (cache_write_rate_denominator_units IS NULL)
    AND (
      cache_write_rate_numerator_minor_units IS NULL
      OR (cache_write_rate_numerator_minor_units >= 0 AND cache_write_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_supplier_cost_versions_cache_write_5m_rate_pair CHECK (
    (cache_write_5m_rate_numerator_minor_units IS NULL) = (cache_write_5m_rate_denominator_units IS NULL)
    AND (
      cache_write_5m_rate_numerator_minor_units IS NULL
      OR (cache_write_5m_rate_numerator_minor_units >= 0 AND cache_write_5m_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_supplier_cost_versions_cache_write_1h_rate_pair CHECK (
    (cache_write_1h_rate_numerator_minor_units IS NULL) = (cache_write_1h_rate_denominator_units IS NULL)
    AND (
      cache_write_1h_rate_numerator_minor_units IS NULL
      OR (cache_write_1h_rate_numerator_minor_units >= 0 AND cache_write_1h_rate_denominator_units > 0)
    )
  ),
  CONSTRAINT saas_supplier_cost_versions_identity_unique UNIQUE (
    public_model_id, public_model_version, provider_id, product_id, resolved_model,
    protocol, endpoint, currency, version
  ),
  CONSTRAINT saas_supplier_cost_versions_idempotency_unique UNIQUE (
    public_model_id, public_model_version, provider_id, product_id, resolved_model,
    protocol, endpoint, currency, idempotency_key
  )
);

CREATE INDEX saas_supplier_cost_versions_lookup_idx
  ON saas_supplier_cost_versions
    (public_model_id, public_model_version, provider_id, product_id, resolved_model,
     protocol, endpoint, currency, effective_at DESC, version DESC);

CREATE FUNCTION saas_pricing_require_customer_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_version bigint;
BEGIN
  SELECT max(version)
    INTO latest_version
    FROM saas_customer_price_versions
   WHERE public_model_id = NEW.public_model_id
     AND public_model_version = NEW.public_model_version
     AND provider_id = NEW.provider_id
     AND product_id = NEW.product_id
     AND protocol = NEW.protocol
     AND endpoint = NEW.endpoint
     AND currency = NEW.currency;
  IF NEW.version IS DISTINCT FROM COALESCE(latest_version + 1, 1) THEN
    RAISE EXCEPTION 'Customer price versions must be appended sequentially' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_pricing_require_supplier_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_version bigint;
BEGIN
  SELECT max(version)
    INTO latest_version
    FROM saas_supplier_cost_versions
   WHERE public_model_id = NEW.public_model_id
     AND public_model_version = NEW.public_model_version
     AND provider_id = NEW.provider_id
     AND product_id = NEW.product_id
     AND resolved_model = NEW.resolved_model
     AND protocol = NEW.protocol
     AND endpoint = NEW.endpoint
     AND currency = NEW.currency;
  IF NEW.version IS DISTINCT FROM COALESCE(latest_version + 1, 1) THEN
    RAISE EXCEPTION 'Supplier cost versions must be appended sequentially' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_pricing_guard_customer_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  model_provider_id text;
  model_product_id text;
  endpoint_allowed boolean;
BEGIN
  SELECT provider_id, product_id, NEW.endpoint = ANY(endpoint_scope)
    INTO model_provider_id, model_product_id, endpoint_allowed
    FROM saas_public_model_versions
   WHERE public_model_id = NEW.public_model_id
     AND version = NEW.public_model_version;
  IF model_provider_id IS NULL
    OR model_provider_id IS DISTINCT FROM NEW.provider_id
    OR model_product_id IS DISTINCT FROM NEW.product_id
    OR endpoint_allowed IS DISTINCT FROM TRUE
  THEN
    RAISE EXCEPTION 'Customer price identity does not match the public model version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_pricing_guard_supplier_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  model_provider_id text;
  model_product_id text;
  endpoint_allowed boolean;
BEGIN
  SELECT provider_id, product_id, NEW.endpoint = ANY(endpoint_scope)
    INTO model_provider_id, model_product_id, endpoint_allowed
    FROM saas_public_model_versions
   WHERE public_model_id = NEW.public_model_id
     AND version = NEW.public_model_version;
  IF model_provider_id IS NULL
    OR model_provider_id IS DISTINCT FROM NEW.provider_id
    OR model_product_id IS DISTINCT FROM NEW.product_id
    OR endpoint_allowed IS DISTINCT FROM TRUE
  THEN
    RAISE EXCEPTION 'Supplier cost identity does not match the public model version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_customer_price_versions_sequential
  BEFORE INSERT ON saas_customer_price_versions
  FOR EACH ROW EXECUTE FUNCTION saas_pricing_require_customer_version();
CREATE TRIGGER saas_supplier_cost_versions_sequential
  BEFORE INSERT ON saas_supplier_cost_versions
  FOR EACH ROW EXECUTE FUNCTION saas_pricing_require_supplier_version();
CREATE TRIGGER saas_customer_price_versions_identity_guard
  BEFORE INSERT ON saas_customer_price_versions
  FOR EACH ROW EXECUTE FUNCTION saas_pricing_guard_customer_identity();
CREATE TRIGGER saas_supplier_cost_versions_identity_guard
  BEFORE INSERT ON saas_supplier_cost_versions
  FOR EACH ROW EXECUTE FUNCTION saas_pricing_guard_supplier_identity();
CREATE TRIGGER saas_customer_price_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_customer_price_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_supplier_cost_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_supplier_cost_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE TABLE saas_request_customer_price_snapshots (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  customer_price_version text NOT NULL,
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  protocol text NOT NULL,
  endpoint text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  commercial_policy_version text NOT NULL,
  calculator_version text NOT NULL,
  rounding_version text NOT NULL,
  rounding_mode text NOT NULL
    CHECK (rounding_mode IN ('floor', 'ceil', 'half_up', 'half_even')),
  rounding_boundary text NOT NULL
    CHECK (rounding_boundary = 'total'),
  hold_input_total bigint NOT NULL CHECK (hold_input_total >= 0),
  hold_input_uncached bigint NOT NULL CHECK (hold_input_uncached >= 0),
  hold_input_cache_read bigint NOT NULL CHECK (hold_input_cache_read >= 0),
  hold_input_cache_write bigint NOT NULL CHECK (hold_input_cache_write >= 0),
  hold_input_cache_write_5m bigint NOT NULL CHECK (hold_input_cache_write_5m >= 0),
  hold_input_cache_write_1h bigint NOT NULL CHECK (hold_input_cache_write_1h >= 0),
  hold_input_output_total bigint NOT NULL CHECK (hold_input_output_total >= 0),
  hold_input_reasoning_output bigint NOT NULL CHECK (hold_input_reasoning_output >= 0),
  hold_amount_minor_units bigint NOT NULL CHECK (hold_amount_minor_units > 0),
  wallet_hold_required boolean NOT NULL CHECK (wallet_hold_required),
  admission_expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_request_customer_price_snapshots_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_request_customer_price_snapshots_price_fk
    FOREIGN KEY (customer_price_version)
    REFERENCES saas_customer_price_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_request_customer_price_snapshots_id_nonempty CHECK (
    char_length(id) BETWEEN 1 AND 255 AND id = btrim(id)
  ),
  CONSTRAINT saas_request_customer_price_snapshots_text_nonempty CHECK (
    btrim(public_model_id) <> ''
    AND btrim(provider_id) <> ''
    AND btrim(product_id) <> ''
    AND btrim(protocol) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(commercial_policy_version) <> ''
    AND btrim(calculator_version) <> ''
    AND btrim(rounding_version) <> ''
  ),
  CONSTRAINT saas_request_customer_price_snapshots_expiry CHECK (admission_expires_at > created_at),
  CONSTRAINT saas_request_customer_price_snapshots_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 512
    AND idempotency_key = btrim(idempotency_key)
  ),
  CONSTRAINT saas_request_customer_price_snapshots_request_unique UNIQUE (tenant_id, request_id),
  CONSTRAINT saas_request_customer_price_snapshots_idempotency_unique
    UNIQUE (tenant_id, request_id, idempotency_key)
);

CREATE INDEX saas_request_customer_price_snapshots_tenant_created_idx
  ON saas_request_customer_price_snapshots (tenant_id, created_at DESC, id);

CREATE FUNCTION saas_pricing_guard_customer_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  price_record record;
  request_record record;
BEGIN
  SELECT supply_mode, protocol, endpoint INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer price snapshot request was not found'
      USING ERRCODE = '23514';
  END IF;
  IF request_record.supply_mode IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'Customer price snapshots require a platform-supplied request'
      USING ERRCODE = '23514';
  END IF;
  IF request_record.protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
  THEN
    RAISE EXCEPTION 'Customer price snapshot protocol or endpoint does not match its request'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO price_record
    FROM saas_customer_price_versions
   WHERE id = NEW.customer_price_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer price snapshot does not match its immutable price version'
      USING ERRCODE = '23514';
  END IF;
  IF price_record.public_model_id IS DISTINCT FROM NEW.public_model_id
    OR price_record.public_model_version IS DISTINCT FROM NEW.public_model_version
    OR price_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR price_record.product_id IS DISTINCT FROM NEW.product_id
    OR price_record.protocol IS DISTINCT FROM NEW.protocol
    OR price_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR price_record.currency IS DISTINCT FROM NEW.currency
    OR price_record.commercial_policy_version IS DISTINCT FROM NEW.commercial_policy_version
    OR price_record.calculator_version IS DISTINCT FROM NEW.calculator_version
    OR price_record.rounding_version IS DISTINCT FROM NEW.rounding_version
    OR price_record.rounding_mode IS DISTINCT FROM NEW.rounding_mode
    OR price_record.rounding_boundary IS DISTINCT FROM NEW.rounding_boundary
  THEN
    RAISE EXCEPTION 'Customer price snapshot does not match its immutable price version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_request_customer_price_snapshots_identity_guard
  BEFORE INSERT ON saas_request_customer_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION saas_pricing_guard_customer_snapshot();
CREATE TRIGGER saas_request_customer_price_snapshots_immutable
  BEFORE UPDATE OR DELETE ON saas_request_customer_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE TABLE saas_attempt_supplier_cost_snapshots (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  supplier_cost_version text NOT NULL,
  platform_account_id text NOT NULL,
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  resolved_model text NOT NULL,
  protocol text NOT NULL,
  endpoint text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  commercial_policy_version text NOT NULL,
  calculator_version text NOT NULL,
  rounding_version text NOT NULL,
  rounding_mode text NOT NULL
    CHECK (rounding_mode IN ('floor', 'ceil', 'half_up', 'half_even')),
  rounding_boundary text NOT NULL
    CHECK (rounding_boundary = 'total'),
  idempotency_key text NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_attempt_supplier_cost_snapshots_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempt_supplier_cost_snapshots_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempt_supplier_cost_snapshots_price_fk
    FOREIGN KEY (supplier_cost_version)
    REFERENCES saas_supplier_cost_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempt_supplier_cost_snapshots_platform_account_fk
    FOREIGN KEY (platform_account_id, provider_id, product_id)
    REFERENCES saas_platform_provider_accounts (id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempt_supplier_cost_snapshots_id_nonempty CHECK (
    char_length(id) BETWEEN 1 AND 255 AND id = btrim(id)
  ),
  CONSTRAINT saas_attempt_supplier_cost_snapshots_text_nonempty CHECK (
    btrim(platform_account_id) <> ''
    AND btrim(public_model_id) <> ''
    AND btrim(provider_id) <> ''
    AND btrim(product_id) <> ''
    AND btrim(resolved_model) <> ''
    AND btrim(protocol) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(commercial_policy_version) <> ''
    AND btrim(calculator_version) <> ''
    AND btrim(rounding_version) <> ''
  ),
  CONSTRAINT saas_attempt_supplier_cost_snapshots_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 512
    AND idempotency_key = btrim(idempotency_key)
  ),
  CONSTRAINT saas_attempt_supplier_cost_snapshots_attempt_unique
    UNIQUE (tenant_id, request_id, attempt_id),
  CONSTRAINT saas_attempt_supplier_cost_snapshots_idempotency_unique
    UNIQUE (tenant_id, request_id, attempt_id, idempotency_key)
);

CREATE INDEX saas_attempt_supplier_cost_snapshots_tenant_created_idx
  ON saas_attempt_supplier_cost_snapshots (tenant_id, created_at DESC, id);

CREATE FUNCTION saas_pricing_guard_supplier_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  price_record record;
  request_record record;
  attempt_record record;
  attempt_row_count bigint;
BEGIN
  SELECT supply_mode, protocol, endpoint INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier cost snapshot request was not found'
      USING ERRCODE = '23514';
  END IF;
  IF request_record.supply_mode IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'Supplier cost snapshots require a platform-supplied request'
      USING ERRCODE = '23514';
  END IF;
  IF request_record.protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
  THEN
    RAISE EXCEPTION 'Supplier cost snapshot protocol or endpoint does not match its request'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO price_record
    FROM saas_supplier_cost_versions
   WHERE id = NEW.supplier_cost_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier cost snapshot does not match its immutable cost version or attempt'
      USING ERRCODE = '23514';
  END IF;
  IF price_record.public_model_id IS DISTINCT FROM NEW.public_model_id
    OR price_record.public_model_version IS DISTINCT FROM NEW.public_model_version
    OR price_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR price_record.product_id IS DISTINCT FROM NEW.product_id
    OR price_record.resolved_model IS DISTINCT FROM NEW.resolved_model
    OR price_record.protocol IS DISTINCT FROM NEW.protocol
    OR price_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR price_record.currency IS DISTINCT FROM NEW.currency
    OR price_record.commercial_policy_version IS DISTINCT FROM NEW.commercial_policy_version
    OR price_record.calculator_version IS DISTINCT FROM NEW.calculator_version
    OR price_record.rounding_version IS DISTINCT FROM NEW.rounding_version
    OR price_record.rounding_mode IS DISTINCT FROM NEW.rounding_mode
    OR price_record.rounding_boundary IS DISTINCT FROM NEW.rounding_boundary
  THEN
    RAISE EXCEPTION 'Supplier cost snapshot does not match its immutable cost version or attempt'
      USING ERRCODE = '23514';
  END IF;

  /*
   * 010's current attempt contract has no authoritative selected account,
   * provider, product, or endpoint columns.  Do not infer those facts from
   * upstream_id.  Until a metering migration adds the four columns below,
   * supplier snapshot insertion is deliberately fail-closed.
   */
  IF (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'saas_attempts'
       AND column_name IN ('platform_account_id', 'provider_id', 'product_id', 'endpoint',
                           'resolved_model', 'protocol', 'supplier_cost_version')
  ) <> 7 THEN
    RAISE EXCEPTION
      'Supplier cost snapshot cannot bind its selected platform account to the attempt: saas_attempts lacks platform_account_id/provider_id/product_id/endpoint'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE $query$
    SELECT a.tenant_id AS attempt_tenant_id,
           a.request_id AS attempt_request_id,
           a.platform_account_id,
           a.provider_id AS attempt_provider_id,
           a.product_id AS attempt_product_id,
           a.resolved_model AS attempt_resolved_model,
           a.protocol AS attempt_protocol,
           a.endpoint AS attempt_endpoint,
           a.supplier_cost_version AS attempt_supplier_cost_version,
           r.tenant_id AS request_tenant_id,
           r.id AS request_id,
           r.supply_mode AS request_supply_mode,
           r.protocol AS request_protocol,
           r.endpoint AS request_endpoint
      FROM saas_attempts AS a
      JOIN saas_requests AS r
        ON r.tenant_id = a.tenant_id
       AND r.id = a.request_id
     WHERE a.tenant_id = $1
       AND a.id = $2
       AND r.tenant_id = $1
       AND r.id = $3
     LIMIT 1
  $query$
    INTO attempt_record
    USING NEW.tenant_id, NEW.attempt_id, NEW.request_id;
  GET DIAGNOSTICS attempt_row_count = ROW_COUNT;

  IF attempt_row_count = 0 THEN
    RAISE EXCEPTION 'Supplier cost snapshot attempt is not joined to its tenant and request'
      USING ERRCODE = '23514';
  END IF;
  IF attempt_record.attempt_tenant_id IS DISTINCT FROM NEW.tenant_id
    OR attempt_record.request_tenant_id IS DISTINCT FROM NEW.tenant_id
    OR attempt_record.attempt_request_id IS DISTINCT FROM NEW.request_id
    OR attempt_record.request_id IS DISTINCT FROM NEW.request_id
    OR attempt_record.request_supply_mode IS DISTINCT FROM 'platform'
    OR attempt_record.request_protocol IS DISTINCT FROM NEW.protocol
    OR attempt_record.request_endpoint IS DISTINCT FROM NEW.endpoint
    OR attempt_record.platform_account_id IS DISTINCT FROM NEW.platform_account_id
    OR attempt_record.attempt_provider_id IS DISTINCT FROM NEW.provider_id
    OR attempt_record.attempt_product_id IS DISTINCT FROM NEW.product_id
    OR attempt_record.attempt_resolved_model IS DISTINCT FROM NEW.resolved_model
    OR attempt_record.attempt_protocol IS DISTINCT FROM NEW.protocol
    OR attempt_record.attempt_endpoint IS DISTINCT FROM NEW.endpoint
    OR attempt_record.attempt_supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
  THEN
    RAISE EXCEPTION 'Supplier cost snapshot selected account and identity do not match its request attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempt_supplier_cost_snapshots_identity_guard
  BEFORE INSERT ON saas_attempt_supplier_cost_snapshots
  FOR EACH ROW EXECUTE FUNCTION saas_pricing_guard_supplier_snapshot();
CREATE TRIGGER saas_attempt_supplier_cost_snapshots_immutable
  BEFORE UPDATE OR DELETE ON saas_attempt_supplier_cost_snapshots
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
`;

export const COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION: SaasMigration = {
  version: 17,
  name: 'commercial_price_versions_and_request_snapshots',
  sql: commercialPriceVersionsSchemaSql,
};
