import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch 5 §5.6 alert/report gaps (task #23; sub2api alert_silence.go and the
 * scheduled report services reference). Migration 103 already carries the
 * rules/events tables and the sustained/cooldown/leader evaluator — this
 * migration only adds what 103 deliberately left out:
 *
 * - saas_obs_alert_silences: operator silence rows. A silence suppresses a
 *   rule (or all rules when rule_id is null) until `until`; platform matches
 *   the rule's :provider= metric scope when set; group_id/region are stored
 *   scope dimensions no current alert metric carries yet (reserved — they
 *   always match today). Deleted with their rule.
 * - saas_obs_report_state: one row per scheduled email report type holding
 *   last_run_at. The report scheduler claims a run by advancing last_run_at
 *   under a FOR UPDATE SKIP LOCKED row lease (the migration-103 leader
 *   pattern) BEFORE generating content, so a bad SMTP config can never cause
 *   a per-minute retry storm.
 *
 * 123/124 stay reserved for the parallel media/websearch workstreams, 125
 * for content risk control and 126 for public brand settings.
 */
const obsAlertSilencesSql = `
CREATE TABLE saas_obs_alert_silences (
  id uuid PRIMARY KEY,
  rule_id uuid REFERENCES saas_obs_alert_rules (id) ON DELETE CASCADE,
  platform text
    CHECK (platform IS NULL OR (btrim(platform) <> '' AND length(platform) <= 100)),
  group_id text
    CHECK (group_id IS NULL OR (btrim(group_id) <> '' AND length(group_id) <= 100)),
  region text
    CHECK (region IS NULL OR (btrim(region) <> '' AND length(region) <= 100)),
  until timestamptz NOT NULL,
  reason text
    CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 1000)),
  created_by text NOT NULL
    CHECK (btrim(created_by) <> '' AND length(created_by) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_obs_alert_silences_scope_not_empty
    CHECK (rule_id IS NOT NULL OR platform IS NOT NULL OR group_id IS NOT NULL OR region IS NOT NULL),
  CONSTRAINT saas_obs_alert_silences_until_after_creation
    CHECK (until > created_at)
);

CREATE INDEX saas_obs_alert_silences_until_idx ON saas_obs_alert_silences (until);
CREATE INDEX saas_obs_alert_silences_rule_idx ON saas_obs_alert_silences (rule_id) WHERE rule_id IS NOT NULL;

CREATE TABLE saas_obs_report_state (
  report_type text PRIMARY KEY
    CHECK (
      report_type IN ('daily_summary', 'weekly_summary', 'error_digest', 'account_health')
    ),
  last_run_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const OBS_ALERT_SILENCES_SAAS_MIGRATION: SaasMigration = {
  version: 127,
  name: 'obs_alert_silences_and_report_state',
  sql: obsAlertSilencesSql,
};
