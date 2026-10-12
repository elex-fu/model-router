import type { SaasMigration } from './001_initial_schema.js';

/**
 * R2/G3 affiliate rebates (design: docs/remaining-capability-plan-2026-10-11.md,
 * G0 freeze docs/marketing-domain-design-2026-10-11.md §6). Attribution is
 * lifetime-immutable: one invitee tenant maps to at most one inviter tenant,
 * and the row never changes after insert (self-invite and cycles are refused
 * by the service inside its transaction). Rewards accrue at the invitee's
 * wallet top-up fulfillment terminal in the same transaction as the funding
 * posting (contract C-6, namespace marketing.affiliate), with the policy
 * basis points snapshotted onto each reward row so later policy changes
 * never rewrite history.
 */
const marketingAffiliateSql = `
CREATE TABLE saas_marketing_affiliate_attributions (
  invitee_tenant_id uuid PRIMARY KEY REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  inviter_tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  invite_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_marketing_affiliate_attributions_no_self
    CHECK (inviter_tenant_id <> invitee_tenant_id),
  CONSTRAINT saas_marketing_affiliate_attributions_code_format
    CHECK (invite_code ~ '^[A-Z2-9]{8,24}$')
);

CREATE TABLE saas_marketing_affiliate_policies (
  id text PRIMARY KEY
    CHECK (id = 'platform'),
  reward_bp integer NOT NULL
    CHECK (reward_bp >= 0 AND reward_bp <= 5000),
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL CHECK (version >= 1),
  updated_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_marketing_affiliate_rewards (
  id uuid PRIMARY KEY,
  inviter_tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  invitee_tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  source_funding_ref text NOT NULL,
  source_amount_minor_units text NOT NULL
    CHECK (source_amount_minor_units ~ '^[0-9]{1,20}$'),
  reward_amount_minor_units text NOT NULL
    CHECK (reward_amount_minor_units ~ '^[0-9]{1,20}$'),
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  reward_bp_snapshot integer NOT NULL
    CHECK (reward_bp_snapshot >= 0 AND reward_bp_snapshot <= 5000),
  ledger_transaction_id uuid REFERENCES saas_ledger_transactions (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_marketing_affiliate_rewards_source_unique UNIQUE (source_funding_ref)
);

CREATE FUNCTION saas_marketing_affiliate_attribution_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing affiliate attributions are lifetime-immutable'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_affiliate_attribution_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_affiliate_attributions_no_update
  BEFORE UPDATE ON saas_marketing_affiliate_attributions
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_affiliate_attribution_guard();

CREATE FUNCTION saas_marketing_affiliate_policy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Marketing affiliate policy identity is immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'Marketing affiliate policy updates must advance the version by exactly one'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_marketing_affiliate_policy_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_affiliate_policies_guard
  BEFORE UPDATE ON saas_marketing_affiliate_policies
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_affiliate_policy_guard();

CREATE FUNCTION saas_marketing_affiliate_reward_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing affiliate rewards are append-only'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_affiliate_reward_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_affiliate_rewards_no_update
  BEFORE UPDATE ON saas_marketing_affiliate_rewards
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_affiliate_reward_guard();

CREATE FUNCTION saas_marketing_affiliate_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing affiliate records cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_affiliate_reject_delete()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_affiliate_attributions_no_delete
  BEFORE DELETE ON saas_marketing_affiliate_attributions
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_affiliate_reject_delete();

CREATE TRIGGER saas_marketing_affiliate_policies_no_delete
  BEFORE DELETE ON saas_marketing_affiliate_policies
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_affiliate_reject_delete();

CREATE TRIGGER saas_marketing_affiliate_rewards_no_delete
  BEFORE DELETE ON saas_marketing_affiliate_rewards
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_affiliate_reject_delete();
`;

export const MARKETING_AFFILIATE_SAAS_MIGRATION: SaasMigration = {
  version: 91,
  name: 'marketing_affiliate',
  sql: marketingAffiliateSql,
};
