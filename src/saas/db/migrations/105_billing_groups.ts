import type { SaasMigration } from './001_initial_schema.js';

/**
 * R1 billing groups (docs/token-resale-implementation-plan-2026-10-15.md §R1):
 * the new-api/sub2api-style group multiplier commercial skeleton. Numbered
 * 105, not the plan's 104: the R2 embeddings task consumed 104 first in the
 * parallel landing order, and lower numbers can never be applied on top of an
 * applied head (fail-closed ordering, the 093/095 re-arbitration precedent).
 *
 * saas_billing_groups is the control-plane-managed group head: an OUTER
 * rational multiplier on top of the existing price versions (PricingIdentity
 * is intentionally untouched), an independent topup multiplier (the "second
 * lever": expensive usage × cheap top-up), peak-hour surcharge, group-level
 * per-model price overrides (highest pricing priority), scheduling/access
 * controls, and profit-control margins. saas_billing_group_account_pools is
 * the sub2api account_groups M2M: the same platform account can serve
 * different groups with different priorities.
 *
 * Keys and tenants reference a group (key binding wins, then the tenant
 * default, then the seeded 'default' group). Every existing row backfills to
 * 'default', which carries the neutral 1/1 multipliers, so pre-R1 pricing is
 * bit-identical until an operator creates or edits a group.
 *
 * The customer price snapshot table gains the admission-time multiplier
 * freeze (new-api reconciliation lesson: the charge-time multiplier is
 * snapshotted; later group edits never reprice in-flight or settled
 * requests): billing_group_id, the composed rate multiplier, whether the peak
 * surcharge applied, and the applied model-pricing override (digest plus the
 * canonical rate set — the rates are stored so settlement never re-queries
 * the mutable group table). Existing snapshot rows backfill to the neutral
 * 1/1 multiplier with no group, keeping old settlements unchanged.
 *
 * Group membership changes invalidate cached key authorization: the groups
 * service bumps saas_api_keys.authz_version in the same transaction as the
 * billing_group_id or pool-membership change (migration 047/082 pattern).
 */
const billingGroupsSql = `
CREATE TABLE saas_billing_groups (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  rate_multiplier_num bigint NOT NULL DEFAULT 1 CHECK (rate_multiplier_num > 0),
  rate_multiplier_den bigint NOT NULL DEFAULT 1 CHECK (rate_multiplier_den > 0),
  topup_multiplier_num bigint NOT NULL DEFAULT 1 CHECK (topup_multiplier_num > 0),
  topup_multiplier_den bigint NOT NULL DEFAULT 1 CHECK (topup_multiplier_den > 0),
  peak_enabled boolean NOT NULL DEFAULT false,
  peak_start time,
  peak_end time,
  peak_multiplier_num bigint,
  peak_multiplier_den bigint,
  model_pricing jsonb,
  rpm_limit integer CHECK (rpm_limit IS NULL OR rpm_limit >= 0),
  daily_limit_minor_units bigint CHECK (daily_limit_minor_units IS NULL OR daily_limit_minor_units >= 0),
  weekly_limit_minor_units bigint CHECK (weekly_limit_minor_units IS NULL OR weekly_limit_minor_units >= 0),
  monthly_limit_minor_units bigint CHECK (monthly_limit_minor_units IS NULL OR monthly_limit_minor_units >= 0),
  profit_min_margin_num bigint,
  profit_min_margin_den bigint,
  profit_safety_buffer_num bigint,
  profit_safety_buffer_den bigint,
  claude_code_only boolean NOT NULL DEFAULT false,
  fallback_group_id text REFERENCES saas_billing_groups (id) ON DELETE RESTRICT,
  supported_model_scopes text[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_billing_groups_id_nonempty CHECK (
    char_length(id) BETWEEN 1 AND 128 AND id = btrim(id)
  ),
  CONSTRAINT saas_billing_groups_display_name_nonempty CHECK (
    char_length(display_name) BETWEEN 1 AND 255 AND display_name = btrim(display_name)
  ),
  CONSTRAINT saas_billing_groups_peak_shape CHECK (
    (peak_enabled AND peak_start IS NOT NULL AND peak_end IS NOT NULL
       AND peak_multiplier_num IS NOT NULL AND peak_multiplier_den IS NOT NULL)
    OR (NOT peak_enabled AND peak_start IS NULL AND peak_end IS NULL
       AND peak_multiplier_num IS NULL AND peak_multiplier_den IS NULL)
  ),
  CONSTRAINT saas_billing_groups_peak_multiplier_positive CHECK (
    peak_multiplier_num IS NULL OR (peak_multiplier_num > 0 AND peak_multiplier_den > 0)
  ),
  CONSTRAINT saas_billing_groups_profit_shape CHECK (
    (profit_min_margin_num IS NULL AND profit_min_margin_den IS NULL
       AND profit_safety_buffer_num IS NULL AND profit_safety_buffer_den IS NULL)
    OR (profit_min_margin_num IS NOT NULL AND profit_min_margin_den IS NOT NULL
       AND profit_safety_buffer_num IS NOT NULL AND profit_safety_buffer_den IS NOT NULL)
  ),
  CONSTRAINT saas_billing_groups_profit_margins_nonnegative CHECK (
    (profit_min_margin_num IS NULL OR (profit_min_margin_num >= 0 AND profit_min_margin_den > 0))
    AND (profit_safety_buffer_num IS NULL OR (profit_safety_buffer_num >= 0 AND profit_safety_buffer_den > 0))
  ),
  CONSTRAINT saas_billing_groups_no_self_fallback CHECK (fallback_group_id IS DISTINCT FROM id)
);

INSERT INTO saas_billing_groups (id, display_name)
VALUES ('default', 'Default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE saas_billing_group_account_pools (
  group_id text NOT NULL REFERENCES saas_billing_groups (id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES saas_platform_provider_accounts (id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);

CREATE INDEX saas_billing_group_account_pools_account_idx
  ON saas_billing_group_account_pools (account_id);

CREATE INDEX saas_billing_group_account_pools_priority_idx
  ON saas_billing_group_account_pools (group_id, priority, account_id);

ALTER TABLE saas_api_keys
  ADD COLUMN billing_group_id text REFERENCES saas_billing_groups (id) ON DELETE RESTRICT DEFAULT 'default';

ALTER TABLE saas_tenants
  ADD COLUMN default_billing_group_id text REFERENCES saas_billing_groups (id) ON DELETE RESTRICT DEFAULT 'default';

ALTER TABLE saas_request_customer_price_snapshots
  ADD COLUMN billing_group_id text REFERENCES saas_billing_groups (id) ON DELETE RESTRICT,
  ADD COLUMN rate_multiplier_num bigint NOT NULL DEFAULT 1 CHECK (rate_multiplier_num > 0),
  ADD COLUMN rate_multiplier_den bigint NOT NULL DEFAULT 1 CHECK (rate_multiplier_den > 0),
  ADD COLUMN peak_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN model_pricing_override_digest text
    CHECK (model_pricing_override_digest IS NULL OR model_pricing_override_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN model_pricing_override jsonb,
  ADD CONSTRAINT saas_request_customer_price_snapshots_override_shape CHECK (
    (model_pricing_override_digest IS NULL AND model_pricing_override IS NULL)
    OR (model_pricing_override_digest IS NOT NULL AND model_pricing_override IS NOT NULL)
  );
`;

export const BILLING_GROUPS_SAAS_MIGRATION: SaasMigration = {
  version: 105,
  name: 'billing_groups',
  sql: billingGroupsSql,
};
