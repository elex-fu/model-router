import type { SaasMigration } from './001_initial_schema.js';

/**
 * R1 billing-group limit enforcement, phase 2 of 4 (roadmap
 * docs/capability-parity-roadmap-2026-10-16.md §1.3): the group-level RPM
 * counter store, mirroring the migration-098 per-account rate counters.
 *
 * The capacity adapter's reserve() — already serialized inside the
 * tenant-scope admission fence — reads the frozen group_rpm_limit from the
 * request's customer price snapshot (migration 112; never the mutable
 * group table), then atomically upserts the per-group per-second request
 * counter and rejects when the frozen ceiling would be exceeded. Because
 * the upsert runs on the admission transaction, a rejection rolls the
 * increment back with the transaction: only committed admissions consume
 * group rate, and replays (which return before the fence) never
 * double-count.
 *
 * window_start is second-truncated from the database clock
 * (clock_timestamp()), the same truncation the 098 account counters apply
 * to the injected admission clock, so every writer in a UTC second shares
 * one row. A group with rpm_limit NULL (the seeded 'default' group) never
 * touches this table; a group shared by several tenants serializes on its
 * counter row for the width of the admission transaction — the fence-width
 * cost the roadmap's 1.2 re-serialization work item tracks.
 */
const billingGroupRateCountersSql = `
CREATE TABLE saas_billing_group_rate_counters (
  group_id text NOT NULL,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 0
    CHECK (requests >= 0),
  CONSTRAINT saas_billing_group_rate_counters_pk
    PRIMARY KEY (group_id, window_start),
  CONSTRAINT saas_billing_group_rate_counters_group_nonempty
    CHECK (btrim(group_id) <> '' AND group_id = btrim(group_id))
);

CREATE INDEX saas_billing_group_rate_counters_window_idx
  ON saas_billing_group_rate_counters (group_id, window_start DESC);
`;

export const BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION: SaasMigration = {
  version: 113,
  name: 'billing_group_rate_counters',
  sql: billingGroupRateCountersSql,
};
