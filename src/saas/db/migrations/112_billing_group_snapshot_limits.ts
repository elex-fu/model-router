import type { SaasMigration } from './001_initial_schema.js';

/**
 * R1 billing-group limit enforcement, phase 1 of 4 (roadmap
 * docs/capability-parity-roadmap-2026-10-16.md §1.3): the snapshot
 * cross-cut the original R1 plan missed. The customer price snapshot
 * already freezes the group's pricing terms (migration 105), but the
 * enforcement terms — the group RPM ceiling, the daily/weekly/monthly
 * spend ceilings, the supported model scopes, and the fallback group —
 * were not frozen. The R1 red line requires enforcement to read the
 * frozen snapshot, never the mutable group table, so those terms must
 * ride the same snapshot row.
 *
 * All six columns are nullable evidence copied from the live group at
 * admission (composition time), exactly like the rate multiplier: NULL
 * means "no limit / no scope restriction / no fallback was in force" —
 * the pre-1.3 behavior where nothing is enforced. A zero limit is finite
 * (the KEY-BUD semantics: NULL unlimited, zero blocks everything).
 *
 * No foreign keys on the frozen copies: group_fallback_group_id is
 * validated by the live group row's own constraint at composition time,
 * and the snapshot is evidence, not authority. Existing snapshot rows
 * backfill to NULL, so their settlements and any future enforcement
 * stay byte-identical.
 */
const billingGroupSnapshotLimitsSql = `
ALTER TABLE saas_request_customer_price_snapshots
  ADD COLUMN group_rpm_limit integer
    CHECK (group_rpm_limit IS NULL OR group_rpm_limit >= 0),
  ADD COLUMN group_daily_limit_minor_units bigint
    CHECK (group_daily_limit_minor_units IS NULL OR group_daily_limit_minor_units >= 0),
  ADD COLUMN group_weekly_limit_minor_units bigint
    CHECK (group_weekly_limit_minor_units IS NULL OR group_weekly_limit_minor_units >= 0),
  ADD COLUMN group_monthly_limit_minor_units bigint
    CHECK (group_monthly_limit_minor_units IS NULL OR group_monthly_limit_minor_units >= 0),
  ADD COLUMN group_supported_model_scopes text[],
  ADD COLUMN group_fallback_group_id text
    CHECK (group_fallback_group_id IS NULL OR (
      char_length(group_fallback_group_id) BETWEEN 1 AND 128
      AND group_fallback_group_id = btrim(group_fallback_group_id)
    ));
`;

export const BILLING_GROUP_SNAPSHOT_LIMITS_SAAS_MIGRATION: SaasMigration = {
  version: 112,
  name: 'billing_group_snapshot_limits',
  sql: billingGroupSnapshotLimitsSql,
};
