import type { SaasMigration } from './001_initial_schema.js';

const byokRefundEntitlementEffectSql = `
ALTER TABLE saas_service_plan_subscriptions
  ADD CONSTRAINT saas_service_plan_subscriptions_refund_effect_identity_unique
    UNIQUE (tenant_id, project_id, order_id, id, snapshot_id, entitlement_id);

ALTER TABLE saas_project_entitlements
  ADD CONSTRAINT saas_project_entitlements_refund_effect_scope_unique
    UNIQUE (tenant_id, project_id, id);

ALTER TABLE saas_refund_orders
  ADD CONSTRAINT saas_refund_orders_byok_wallet_effect_absent CHECK (
    (refund_type = 'wallet_topup' AND service_plan_effect_ref IS NULL)
    OR (refund_type = 'byok_service_plan'
      AND wallet_id IS NULL
      AND original_funding_transaction_id IS NULL
      AND wallet_refund_transaction_id IS NULL)
  ),
  ADD CONSTRAINT saas_refund_orders_byok_active_effect_present CHECK (
    refund_type <> 'byok_service_plan'
    OR state = 'blocked'
    OR service_plan_effect_ref IS NOT NULL
  );

ALTER TABLE saas_refund_orders
  DROP CONSTRAINT saas_refund_orders_provider_attempt_shape,
  ADD CONSTRAINT saas_refund_orders_provider_attempt_shape CHECK (
    (refund_type = 'wallet_topup' AND provider_attempts >= 1)
    OR (refund_type = 'byok_service_plan' AND (
      (state = 'blocked' AND provider_attempts = 0)
      OR (state <> 'blocked' AND provider_attempts >= 1)
    ))
  );

CREATE UNIQUE INDEX saas_refund_orders_service_plan_effect_ref_unique
  ON saas_refund_orders (service_plan_effect_ref)
  WHERE service_plan_effect_ref IS NOT NULL;

CREATE UNIQUE INDEX saas_refund_orders_one_unresolved_byok_per_order_idx
  ON saas_refund_orders (tenant_id, service_plan_order_id)
  WHERE refund_type = 'byok_service_plan' AND state IN ('submitting', 'pending', 'unknown');

CREATE TABLE saas_refund_service_plan_effects (
  effect_ref text PRIMARY KEY
    CHECK (char_length(effect_ref) BETWEEN 1 AND 255 AND btrim(effect_ref) = effect_ref),
  tenant_id uuid NOT NULL,
  refund_order_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_service_plan_order_id uuid NOT NULL,
  source_subscription_id uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_entitlement_id uuid NOT NULL,
  refund_policy_version text NOT NULL
    CHECK (refund_policy_version ~ '^byok_cancel_only_v[1-9][0-9]*$'),
  service_plan_policy_version text NOT NULL
    CHECK (btrim(service_plan_policy_version) <> '' AND service_plan_policy_version !~ '[[:cntrl:]]'),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cutoff_at timestamptz NOT NULL,
  requested_by_user_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,95}$'),
  state text NOT NULL CHECK (state IN ('provisionally_suspended', 'not_suspended', 'succeeded', 'failed')),
  suspended_authz_version bigint CHECK (suspended_authz_version IS NULL OR suspended_authz_version >= 1),
  suspended_at timestamptz,
  suspension_released_at timestamptz,
  released_authz_version bigint CHECK (released_authz_version IS NULL OR released_authz_version >= 1),
  request_audit_event_id uuid NOT NULL UNIQUE,
  outcome_audit_event_id uuid UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT saas_refund_service_plan_effects_refund_unique UNIQUE (tenant_id, refund_order_id),
  CONSTRAINT saas_refund_service_plan_effects_refund_identity_unique
    UNIQUE (tenant_id, refund_order_id, effect_ref),
  CONSTRAINT saas_refund_service_plan_effects_refund_fk
    FOREIGN KEY (tenant_id, refund_order_id)
    REFERENCES saas_refund_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_source_fk
    FOREIGN KEY (
      tenant_id, project_id, source_service_plan_order_id, source_subscription_id,
      source_snapshot_id, source_entitlement_id
    )
    REFERENCES saas_service_plan_subscriptions (
      tenant_id, project_id, order_id, id, snapshot_id, entitlement_id
    ) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_entitlement_scope_fk
    FOREIGN KEY (tenant_id, project_id, source_entitlement_id)
    REFERENCES saas_project_entitlements (tenant_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_actor_fk
    FOREIGN KEY (requested_by_user_id) REFERENCES saas_users (id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_request_audit_fk
    FOREIGN KEY (request_audit_event_id) REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_outcome_audit_fk
    FOREIGN KEY (outcome_audit_event_id) REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_service_plan_effects_suspension_shape CHECK (
    (suspended_authz_version IS NULL AND suspended_at IS NULL
      AND suspension_released_at IS NULL AND released_authz_version IS NULL)
    OR (suspended_authz_version IS NOT NULL AND suspended_at IS NOT NULL
      AND (suspension_released_at IS NULL) = (released_authz_version IS NULL))
  ),
  CONSTRAINT saas_refund_service_plan_effects_state_shape CHECK (
    (state IN ('provisionally_suspended', 'not_suspended')
      AND completed_at IS NULL AND outcome_audit_event_id IS NULL
      AND suspension_released_at IS NULL AND released_authz_version IS NULL)
    OR (state IN ('succeeded', 'failed')
      AND completed_at IS NOT NULL AND outcome_audit_event_id IS NOT NULL)
  ),
  CONSTRAINT saas_refund_service_plan_effects_release_shape CHECK (
    suspension_released_at IS NULL
    OR (state = 'failed' AND suspended_authz_version IS NOT NULL AND released_authz_version > suspended_authz_version)
  )
  );

ALTER TABLE saas_refund_orders
  ADD CONSTRAINT saas_refund_orders_service_plan_effect_fk
    FOREIGN KEY (tenant_id, id, service_plan_effect_ref)
    REFERENCES saas_refund_service_plan_effects (tenant_id, refund_order_id, effect_ref)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX saas_refund_service_plan_effects_entitlement_history_idx
  ON saas_refund_service_plan_effects (tenant_id, project_id, source_entitlement_id, created_at DESC);

CREATE FUNCTION saas_refund_service_plan_effects_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  refund_type text;
  refund_order_id uuid;
  refund_effect_ref text;
  source_order_id uuid;
BEGIN
  SELECT r.refund_type, r.service_plan_order_id, r.service_plan_effect_ref
    INTO refund_type, refund_order_id, refund_effect_ref
    FROM saas_refund_orders r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.refund_order_id;

  IF refund_type IS DISTINCT FROM 'byok_service_plan'
     OR refund_order_id IS DISTINCT FROM NEW.source_service_plan_order_id
     OR refund_effect_ref IS DISTINCT FROM NEW.effect_ref THEN
    RAISE EXCEPTION 'Service-plan refund effect does not match its approved refund order'
      USING ERRCODE = '23514';
  END IF;

  SELECT o.id INTO source_order_id
    FROM saas_service_plan_orders o
   WHERE o.tenant_id = NEW.tenant_id
     AND o.project_id = NEW.project_id
     AND o.id = NEW.source_service_plan_order_id
     AND o.subscription_id = NEW.source_subscription_id
     AND o.state = 'fulfilled';

  IF source_order_id IS NULL THEN
    RAISE EXCEPTION 'Service-plan refund effect source order is not fulfilled or linked'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_refund_service_plan_effects_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.effect_ref IS DISTINCT FROM OLD.effect_ref
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.refund_order_id IS DISTINCT FROM OLD.refund_order_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.source_service_plan_order_id IS DISTINCT FROM OLD.source_service_plan_order_id
     OR NEW.source_subscription_id IS DISTINCT FROM OLD.source_subscription_id
     OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
     OR NEW.source_entitlement_id IS DISTINCT FROM OLD.source_entitlement_id
     OR NEW.refund_policy_version IS DISTINCT FROM OLD.refund_policy_version
     OR NEW.service_plan_policy_version IS DISTINCT FROM OLD.service_plan_policy_version
     OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.cutoff_at IS DISTINCT FROM OLD.cutoff_at
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.request_audit_event_id IS DISTINCT FROM OLD.request_audit_event_id
     OR NEW.suspended_authz_version IS DISTINCT FROM OLD.suspended_authz_version
     OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Service-plan refund effect identity and policy snapshot are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state IN ('succeeded', 'failed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal service-plan refund effects are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state NOT IN ('provisionally_suspended', 'not_suspended')
     OR NEW.state NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Invalid service-plan refund effect transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_refund_service_plan_effects_source_guard
  BEFORE INSERT ON saas_refund_service_plan_effects
  FOR EACH ROW EXECUTE FUNCTION saas_refund_service_plan_effects_source_guard();
CREATE TRIGGER saas_refund_service_plan_effects_transition_guard
  BEFORE UPDATE OR DELETE ON saas_refund_service_plan_effects
  FOR EACH ROW EXECUTE FUNCTION saas_refund_service_plan_effects_transition_guard();
CREATE TRIGGER saas_refund_service_plan_effects_no_truncate
  BEFORE TRUNCATE ON saas_refund_service_plan_effects
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_refund_orders_service_plan_effect_ref_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service_plan_effect_ref IS DISTINCT FROM OLD.service_plan_effect_ref THEN
    RAISE EXCEPTION 'Service-plan refund effect identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_refund_orders_service_plan_effect_ref_immutable
  BEFORE UPDATE ON saas_refund_orders
  FOR EACH ROW EXECUTE FUNCTION saas_refund_orders_service_plan_effect_ref_immutable();
`;

export const BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION: SaasMigration = {
  version: 45,
  name: 'byok_refund_entitlement_effect',
  sql: byokRefundEntitlementEffectSql,
};
