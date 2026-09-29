import type { SaasMigration } from './001_initial_schema.js';

/*
 * BYOK service plans are fixed-term access products.  They are deliberately
 * separate from wallet top-ups and from the request-metering ledger: a plan
 * snapshot records the commercial terms that were purchased, while the
 * subscription creates (and later disables/supersedes) the existing project
 * entitlement used by the key and request authorization paths.
 *
 * Migration registry integration is owned by the adjacent 029/030 work and
 * appends this forward-only migration after 030.  This file does not perform
 * any payment or wallet integration by itself.
 */
const byokServicePlanSubscriptionFulfillmentSql = `
CREATE TABLE saas_service_plans (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_service_plans_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_service_plans_slug_nonempty
    CHECK (btrim(slug) <> '' AND slug = btrim(slug)),
  CONSTRAINT saas_service_plans_display_name_nonempty
    CHECK (btrim(display_name) <> '')
);

CREATE TABLE saas_service_plan_versions (
  id uuid PRIMARY KEY,
  plan_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  supply_mode text NOT NULL CHECK (supply_mode = 'byok'),
  supply_profile_id text NOT NULL,
  allowed_provider_ids text[] NOT NULL,
  allowed_models text[] NOT NULL,
  price_version text NOT NULL,
  price_minor_units bigint NOT NULL CHECK (price_minor_units > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  term_days integer NOT NULL CHECK (term_days > 0 AND term_days <= 3650),
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT saas_service_plan_versions_plan_fk
    FOREIGN KEY (plan_id)
    REFERENCES saas_service_plans (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_versions_identity_unique
    UNIQUE (plan_id, version),
  CONSTRAINT saas_service_plan_versions_profile_nonempty
    CHECK (btrim(supply_profile_id) <> '' AND supply_profile_id = btrim(supply_profile_id)),
  CONSTRAINT saas_service_plan_versions_provider_scope_nonempty
    CHECK (
      cardinality(allowed_provider_ids) > 0
      AND array_position(allowed_provider_ids, NULL) IS NULL
      AND array_position(allowed_provider_ids, '') IS NULL
    ),
  CONSTRAINT saas_service_plan_versions_model_scope_nonempty
    CHECK (
      cardinality(allowed_models) > 0
      AND array_position(allowed_models, NULL) IS NULL
      AND array_position(allowed_models, '') IS NULL
    ),
  CONSTRAINT saas_service_plan_versions_text_nonempty
    CHECK (
      btrim(price_version) <> ''
      AND btrim(policy_version) <> ''
    ),
  CONSTRAINT saas_service_plan_versions_publication_shape
    CHECK (
      (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
      OR (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
    )
);

CREATE INDEX saas_service_plan_versions_catalog_idx
  ON saas_service_plan_versions (plan_id, status, version DESC);

CREATE TABLE saas_service_plan_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  operation text NOT NULL
    CHECK (operation IN ('activation', 'renewal')),
  renewal_of_subscription_id uuid,
  client_request_id text NOT NULL,
  provider_key text,
  merchant_id text,
  provider_order_id text,
  provider_attempts integer NOT NULL DEFAULT 0
    CHECK (provider_attempts >= 0),
  provider_failure_code text
    CHECK (provider_failure_code IS NULL OR provider_failure_code ~ '^[A-Z0-9_:-]{1,96}$'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN (
      'pending', 'paid', 'fulfilling', 'fulfilled', 'cancelled',
      'reconciliation_pending'
    )),
  subscription_id uuid,
  verified_settlement_id text,
  verified_provider_key text,
  verified_merchant_id text,
  verified_amount_minor_units bigint,
  verified_currency text,
  fulfillment_reference text,
  fulfillment_evidence_sha256 text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  CONSTRAINT saas_service_plan_orders_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES saas_tenants (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_orders_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_orders_plan_version_fk
    FOREIGN KEY (plan_version_id)
    REFERENCES saas_service_plan_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_orders_client_request_unique
    UNIQUE (tenant_id, client_request_id),
  CONSTRAINT saas_service_plan_orders_provider_order_unique
    UNIQUE (provider_key, merchant_id, provider_order_id),
  CONSTRAINT saas_service_plan_orders_verified_settlement_unique
    UNIQUE (verified_provider_key, verified_merchant_id, verified_settlement_id),
  CONSTRAINT saas_service_plan_orders_tenant_id_unique
    UNIQUE (tenant_id, id),
  CONSTRAINT saas_service_plan_orders_client_request_nonempty
    CHECK (btrim(client_request_id) <> '' AND client_request_id = btrim(client_request_id)),
  CONSTRAINT saas_service_plan_orders_provider_snapshot_shape
    CHECK (
      (provider_key IS NULL AND merchant_id IS NULL)
      OR (btrim(provider_key) <> '' AND btrim(provider_key) = provider_key
        AND btrim(merchant_id) <> '' AND btrim(merchant_id) = merchant_id)
    ),
  CONSTRAINT saas_service_plan_orders_provider_order_shape
    CHECK (provider_order_id IS NULL OR (btrim(provider_order_id) <> '' AND btrim(provider_order_id) = provider_order_id)),
  CONSTRAINT saas_service_plan_orders_verified_amount_shape
    CHECK (
      (verified_amount_minor_units IS NULL AND verified_currency IS NULL)
      OR (verified_amount_minor_units > 0 AND verified_currency ~ '^[A-Z]{3}$')
    ),
  CONSTRAINT saas_service_plan_orders_verified_fields_shape
    CHECK (
      (state IN ('pending', 'cancelled', 'reconciliation_pending')
        AND verified_settlement_id IS NULL
        AND verified_provider_key IS NULL
        AND verified_merchant_id IS NULL
        AND fulfillment_reference IS NULL
        AND fulfillment_evidence_sha256 IS NULL
        AND verified_at IS NULL)
      OR
      (state IN ('paid', 'fulfilling', 'fulfilled')
        AND verified_settlement_id IS NOT NULL
        AND verified_provider_key IS NOT NULL
        AND verified_merchant_id IS NOT NULL
        AND verified_amount_minor_units IS NOT NULL
        AND verified_currency IS NOT NULL
        AND fulfillment_reference IS NOT NULL
        AND fulfillment_evidence_sha256 IS NOT NULL
        AND verified_at IS NOT NULL
        AND provider_key IS NOT NULL
        AND merchant_id IS NOT NULL
        AND provider_order_id IS NOT NULL)
    ),
  CONSTRAINT saas_service_plan_orders_evidence_hash_shape
    CHECK (
      fulfillment_evidence_sha256 IS NULL
      OR fulfillment_evidence_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT saas_service_plan_orders_paid_fields_shape
    CHECK (
      (state IN ('paid', 'fulfilling', 'fulfilled') AND paid_at IS NOT NULL)
      OR (state IN ('pending', 'cancelled', 'reconciliation_pending'))
    ),
  CONSTRAINT saas_service_plan_orders_fulfilled_fields_shape
    CHECK (
      (state = 'fulfilled' AND fulfilled_at IS NOT NULL AND subscription_id IS NOT NULL)
      OR (state <> 'fulfilled')
    )
);

CREATE INDEX saas_service_plan_orders_project_time_idx
  ON saas_service_plan_orders (tenant_id, project_id, created_at DESC, id);

CREATE INDEX saas_service_plan_orders_provider_lookup_idx
  ON saas_service_plan_orders (provider_key, merchant_id, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE TABLE saas_service_plan_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  plan_id text NOT NULL,
  plan_version bigint NOT NULL CHECK (plan_version >= 1),
  allowed_provider_ids text[] NOT NULL,
  allowed_models text[] NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode = 'byok'),
  supply_profile_id text NOT NULL,
  price_version text NOT NULL,
  price_minor_units bigint NOT NULL CHECK (price_minor_units > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  term_days integer NOT NULL CHECK (term_days > 0 AND term_days <= 3650),
  policy_version text NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_service_plan_snapshots_tenant_id_unique
    UNIQUE (tenant_id, id),
  CONSTRAINT saas_service_plan_snapshots_order_unique
    UNIQUE (tenant_id, order_id),
  CONSTRAINT saas_service_plan_snapshots_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES saas_service_plan_orders (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_snapshots_plan_version_fk
    FOREIGN KEY (plan_version_id)
    REFERENCES saas_service_plan_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_snapshots_provider_scope_nonempty
    CHECK (
      cardinality(allowed_provider_ids) > 0
      AND array_position(allowed_provider_ids, NULL) IS NULL
      AND array_position(allowed_provider_ids, '') IS NULL
    ),
  CONSTRAINT saas_service_plan_snapshots_model_scope_nonempty
    CHECK (
      cardinality(allowed_models) > 0
      AND array_position(allowed_models, NULL) IS NULL
      AND array_position(allowed_models, '') IS NULL
    ),
  CONSTRAINT saas_service_plan_snapshots_text_nonempty
    CHECK (
      btrim(plan_id) <> ''
      AND btrim(supply_profile_id) <> ''
      AND btrim(price_version) <> ''
      AND btrim(policy_version) <> ''
    )
);

CREATE INDEX saas_service_plan_snapshots_project_time_idx
  ON saas_service_plan_snapshots (tenant_id, created_at DESC, id);

/* Add the composite entitlement key before the subscription FK is created. */
ALTER TABLE saas_project_entitlements
  ADD CONSTRAINT saas_project_entitlements_tenant_id_unique
  UNIQUE (tenant_id, id),
  ADD COLUMN source_type text NOT NULL DEFAULT 'legacy',
  ADD COLUMN source_ref text,
  ADD COLUMN service_plan_snapshot_id uuid;

ALTER TABLE saas_project_entitlements
  ADD CONSTRAINT saas_project_entitlements_source_type_check
    CHECK (source_type IN ('legacy', 'service_plan', 'admin_grant')),
  ADD CONSTRAINT saas_project_entitlements_source_shape_check
    CHECK (
      (source_type = 'service_plan'
        AND service_plan_snapshot_id IS NOT NULL
        AND source_ref IS NOT NULL
        AND btrim(source_ref) <> '')
      OR
      (source_type <> 'service_plan' AND service_plan_snapshot_id IS NULL)
    );

CREATE TABLE saas_service_plan_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  order_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  previous_subscription_id uuid,
  operation text NOT NULL
    CHECK (operation IN ('activation', 'renewal')),
  status text NOT NULL
    CHECK (status IN ('pending', 'active', 'superseded', 'expired', 'cancelled')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  activated_at timestamptz,
  superseded_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_service_plan_subscriptions_tenant_id_unique
    UNIQUE (tenant_id, id),
  CONSTRAINT saas_service_plan_subscriptions_order_unique
    UNIQUE (tenant_id, order_id),
  CONSTRAINT saas_service_plan_subscriptions_entitlement_unique
    UNIQUE (tenant_id, entitlement_id),
  CONSTRAINT saas_service_plan_subscriptions_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_subscriptions_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES saas_service_plan_orders (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_subscriptions_snapshot_fk
    FOREIGN KEY (tenant_id, snapshot_id)
    REFERENCES saas_service_plan_snapshots (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_subscriptions_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id)
    REFERENCES saas_project_entitlements (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_subscriptions_previous_fk
    FOREIGN KEY (tenant_id, previous_subscription_id)
    REFERENCES saas_service_plan_subscriptions (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_service_plan_subscriptions_validity_window
    CHECK (expires_at > effective_at),
  CONSTRAINT saas_service_plan_subscriptions_lifecycle_shape
    CHECK (
      (status = 'pending'
        AND activated_at IS NULL
        AND superseded_at IS NULL
        AND expired_at IS NULL
        AND cancelled_at IS NULL)
      OR
      (status = 'active'
        AND activated_at IS NOT NULL
        AND superseded_at IS NULL
        AND expired_at IS NULL
        AND cancelled_at IS NULL)
      OR
      (status = 'superseded'
        AND activated_at IS NOT NULL
        AND superseded_at IS NOT NULL
        AND expired_at IS NULL
        AND cancelled_at IS NULL)
      OR
      (status = 'expired'
        AND activated_at IS NOT NULL
        AND expired_at IS NOT NULL
        AND superseded_at IS NULL
        AND cancelled_at IS NULL)
      OR
      (status = 'cancelled'
        AND activated_at IS NOT NULL
        AND cancelled_at IS NOT NULL
        AND superseded_at IS NULL
        AND expired_at IS NULL)
    )
);

CREATE INDEX saas_service_plan_subscriptions_project_status_idx
  ON saas_service_plan_subscriptions
    (tenant_id, project_id, status, effective_at DESC, expires_at DESC);

ALTER TABLE saas_service_plan_orders
  ADD CONSTRAINT saas_service_plan_orders_renewal_fk
    FOREIGN KEY (tenant_id, renewal_of_subscription_id)
    REFERENCES saas_service_plan_subscriptions (tenant_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_service_plan_orders_subscription_fk
    FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES saas_service_plan_subscriptions (tenant_id, id)
    ON DELETE RESTRICT;

ALTER TABLE saas_project_entitlements
  ADD CONSTRAINT saas_project_entitlements_service_plan_snapshot_fk
    FOREIGN KEY (tenant_id, service_plan_snapshot_id)
    REFERENCES saas_service_plan_snapshots (tenant_id, id)
    ON DELETE RESTRICT;

CREATE FUNCTION saas_service_plan_guard_version_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Service plan versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
    OR NEW.supply_profile_id IS DISTINCT FROM OLD.supply_profile_id
    OR NEW.allowed_provider_ids IS DISTINCT FROM OLD.allowed_provider_ids
    OR NEW.allowed_models IS DISTINCT FROM OLD.allowed_models
    OR NEW.price_version IS DISTINCT FROM OLD.price_version
    OR NEW.price_minor_units IS DISTINCT FROM OLD.price_minor_units
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.term_days IS DISTINCT FROM OLD.term_days
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Published service plan terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'published', 'retired') THEN
    RAISE EXCEPTION 'Invalid service plan version transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'retired') THEN
    RAISE EXCEPTION 'Published service plan versions cannot be reopened' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'retired' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Retired service plan versions are terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_service_plan_versions_guard_change
  BEFORE UPDATE OR DELETE ON saas_service_plan_versions
  FOR EACH ROW EXECUTE FUNCTION saas_service_plan_guard_version_change();

CREATE FUNCTION saas_service_plan_guard_snapshot_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Service plan snapshots are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_service_plan_snapshots_immutable
  BEFORE UPDATE OR DELETE ON saas_service_plan_snapshots
  FOR EACH ROW EXECUTE FUNCTION saas_service_plan_guard_snapshot_change();

CREATE FUNCTION saas_service_plan_order_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.renewal_of_subscription_id IS DISTINCT FROM OLD.renewal_of_subscription_id
    OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.provider_key IS NOT NULL AND NEW.provider_key IS DISTINCT FROM OLD.provider_key)
    OR (OLD.merchant_id IS NOT NULL AND NEW.merchant_id IS DISTINCT FROM OLD.merchant_id)
    OR (OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id)
    OR (OLD.verified_settlement_id IS NOT NULL
      AND (NEW.verified_settlement_id IS DISTINCT FROM OLD.verified_settlement_id
        OR NEW.verified_provider_key IS DISTINCT FROM OLD.verified_provider_key
        OR NEW.verified_merchant_id IS DISTINCT FROM OLD.verified_merchant_id
        OR NEW.verified_amount_minor_units IS DISTINCT FROM OLD.verified_amount_minor_units
        OR NEW.verified_currency IS DISTINCT FROM OLD.verified_currency
        OR NEW.fulfillment_reference IS DISTINCT FROM OLD.fulfillment_reference
        OR NEW.fulfillment_evidence_sha256 IS DISTINCT FROM OLD.fulfillment_evidence_sha256
        OR NEW.verified_at IS DISTINCT FROM OLD.verified_at))
  THEN
    RAISE EXCEPTION 'Service plan order identity and fulfillment evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.provider_attempts > NEW.provider_attempts THEN
    RAISE EXCEPTION 'Service plan provider attempts cannot decrease' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'paid', 'cancelled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid service plan order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'paid' AND NEW.state NOT IN ('paid', 'fulfilling', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid service plan order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'fulfilling' AND NEW.state NOT IN ('fulfilling', 'fulfilled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid service plan order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'fulfilled' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Fulfilled service plan orders are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'cancelled' AND NEW.state NOT IN ('cancelled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Cancelled service plan orders cannot be fulfilled' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'reconciliation_pending' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Service plan order reconciliation is required before changing it'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('paid', 'fulfilling', 'fulfilled')
    AND (NEW.verified_settlement_id IS NULL OR NEW.fulfillment_reference IS NULL)
  THEN
    RAISE EXCEPTION 'Fulfilled service plan orders require verified settlement evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'fulfilled' AND NEW.subscription_id IS NULL THEN
    RAISE EXCEPTION 'Fulfilled service plan orders require a subscription' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_service_plan_orders_guard_change
  BEFORE UPDATE ON saas_service_plan_orders
  FOR EACH ROW EXECUTE FUNCTION saas_service_plan_order_guard_change();

CREATE FUNCTION saas_service_plan_subscription_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
    OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
    OR NEW.previous_subscription_id IS DISTINCT FROM OLD.previous_subscription_id
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Service plan subscription identity and term are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'active', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid service plan subscription transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'superseded', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid service plan subscription transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('superseded', 'expired', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal service plan subscriptions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_service_plan_subscriptions_guard_change
  BEFORE UPDATE ON saas_service_plan_subscriptions
  FOR EACH ROW EXECUTE FUNCTION saas_service_plan_subscription_guard_change();

CREATE FUNCTION saas_service_plan_entitlement_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_type = 'service_plan' OR OLD.service_plan_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'Service plan entitlements must be disabled or superseded, not deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.source_type = 'service_plan' OR OLD.service_plan_snapshot_id IS NOT NULL
    OR NEW.source_type = 'service_plan' OR NEW.service_plan_snapshot_id IS NOT NULL
  THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.supply_profile_id IS DISTINCT FROM OLD.supply_profile_id
      OR NEW.supply_mode IS DISTINCT FROM OLD.supply_mode
      OR NEW.model_scopes IS DISTINCT FROM OLD.model_scopes
      OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
      OR NEW.service_plan_snapshot_id IS DISTINCT FROM OLD.service_plan_snapshot_id
    THEN
      RAISE EXCEPTION 'Service plan entitlement authority facts are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'superseded', 'disabled') THEN
      RAISE EXCEPTION 'Invalid service plan entitlement transition' USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'superseded' AND NEW.status NOT IN ('superseded', 'disabled') THEN
      RAISE EXCEPTION 'Superseded service plan entitlements are terminal' USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'disabled' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Disabled service plan entitlements are terminal' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_service_plan_entitlements_guard_change
  BEFORE UPDATE OR DELETE ON saas_project_entitlements
  FOR EACH ROW EXECUTE FUNCTION saas_service_plan_entitlement_guard_change();
`;

export const BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION: SaasMigration = {
  version: 31,
  name: 'byok_service_plan_subscription_fulfillment',
  sql: byokServicePlanSubscriptionFulfillmentSql,
};
