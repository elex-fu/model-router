import type { SaasMigration } from './001_initial_schema.js';

/**
 * Phase 3 observability alert rules and events (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 4). Rules are
 * evaluated by a single-leader worker: a rule fires only after the metric
 * violates the threshold for sustained_minutes consecutive minutes inside the
 * evaluation window, and stays silent for cooldown_minutes after firing.
 * Events are the durable trigger log (payload carries the observed value and
 * the rule snapshot) and are removed with their rule.
 */
const obsAlertsSql = `
CREATE TABLE saas_obs_alert_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL
    CHECK (btrim(name) <> '' AND name = btrim(name) AND length(name) <= 200),
  enabled boolean NOT NULL DEFAULT true,
  metric text NOT NULL
    CHECK (btrim(metric) <> ''),
  operator text NOT NULL
    CHECK (operator IN ('gt', 'lt')),
  threshold real NOT NULL,
  window_minutes integer NOT NULL CHECK (window_minutes >= 1),
  sustained_minutes integer NOT NULL CHECK (sustained_minutes >= 1),
  cooldown_minutes integer NOT NULL CHECK (cooldown_minutes >= 1),
  notify_email text
    CHECK (notify_email IS NULL OR (btrim(notify_email) <> '' AND length(notify_email) <= 320)),
  webhook_url text
    CHECK (
      webhook_url IS NULL
      OR (webhook_url ~ '^https://[a-zA-Z0-9._~:/?#\\[\\]@!$&''()*+,;=%-]+$' AND length(webhook_url) <= 2048)
    ),
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_obs_alert_rules_sustained_within_window
    CHECK (sustained_minutes <= window_minutes)
);

CREATE INDEX saas_obs_alert_rules_enabled_idx ON saas_obs_alert_rules (enabled) WHERE enabled;

CREATE TABLE saas_obs_alert_events (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL
    REFERENCES saas_obs_alert_rules (id) ON DELETE CASCADE,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  payload jsonb NOT NULL,
  CONSTRAINT saas_obs_alert_events_resolved_after_trigger
    CHECK (resolved_at IS NULL OR resolved_at >= triggered_at)
);

CREATE INDEX saas_obs_alert_events_rule_triggered_idx
  ON saas_obs_alert_events (rule_id, triggered_at DESC);
`;

export const OBS_ALERTS_SAAS_MIGRATION: SaasMigration = {
  version: 103,
  name: 'obs_alert_rules_and_events',
  sql: obsAlertsSql,
};
