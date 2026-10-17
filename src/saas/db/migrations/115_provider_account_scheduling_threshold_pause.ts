import type { SaasMigration } from './001_initial_schema.js';

/**
 * R-dormant activation (roadmap batch 2.2, sub2api
 * account_scheduling_threshold_eval.go port): the scheduling-threshold
 * temporary-pause columns on both account owner tables. The lazy evaluator
 * in the provider-account scheduler (candidate-collection time) writes them
 * when a persisted quota-snapshot window (099/100/108/111 column families)
 * reports usage at or above the account's dormant auto_pause_*_threshold
 * (migration 099); the pause runs to the latest breaching window reset and
 * recovers naturally when the deadline passes (the 109
 * probe_temp_unschedulable_until eligibility precedent).
 *
 * Numbered 115: the next free slot after the applied head 114 (fail-closed
 * serial ordering — lower numbers can never be applied on top of an applied
 * head).
 *
 * Design notes:
 * - scheduling_threshold_pause_until is the deadline; the reason is the
 *   sub2api temp-unsched JSON payload (source:
 *   "account_scheduling_threshold", platform, window, threshold_percent,
 *   used_percent, until_unix, triggered_at_unix, optional window-cost
 *   observation). Idempotent writes compare reasons with triggered_at_unix
 *   zeroed and the deadline at second granularity; the UPDATE never
 *   shortens a live pause.
 * - The column pair is threshold-owned exclusively (the probe worker keeps
 *   its own 109 column) so a NULL pair means "never threshold-paused" and
 *   keeps scheduling exactly on its pre-115 behavior — no backfill.
 * - The pause is a scheduling signal only; it never enters the billing
 *   path (093/099/100/108/111 quota-snapshot precedent).
 */
const providerAccountSchedulingThresholdPauseSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN scheduling_threshold_pause_until timestamptz,
  ADD COLUMN scheduling_threshold_pause_reason jsonb;

ALTER TABLE saas_tenant_provider_accounts
  ADD CONSTRAINT saas_tenant_provider_accounts_scheduling_threshold_pause_shape CHECK (
    (scheduling_threshold_pause_until IS NULL) = (scheduling_threshold_pause_reason IS NULL)
  ),
  ADD CONSTRAINT saas_tenant_provider_accounts_scheduling_threshold_pause_reason_object CHECK (
    scheduling_threshold_pause_reason IS NULL
    OR jsonb_typeof(scheduling_threshold_pause_reason) = 'object'
  );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN scheduling_threshold_pause_until timestamptz,
  ADD COLUMN scheduling_threshold_pause_reason jsonb;

ALTER TABLE saas_platform_provider_accounts
  ADD CONSTRAINT saas_platform_provider_accounts_scheduling_threshold_pause_shape CHECK (
    (scheduling_threshold_pause_until IS NULL) = (scheduling_threshold_pause_reason IS NULL)
  ),
  ADD CONSTRAINT saas_platform_provider_accounts_scheduling_threshold_pause_reason_object CHECK (
    scheduling_threshold_pause_reason IS NULL
    OR jsonb_typeof(scheduling_threshold_pause_reason) = 'object'
  );
`;

export const PROVIDER_ACCOUNT_SCHEDULING_THRESHOLD_PAUSE_SAAS_MIGRATION: SaasMigration = {
  version: 115,
  name: 'provider_account_scheduling_threshold_pause',
  sql: providerAccountSchedulingThresholdPauseSql,
};
