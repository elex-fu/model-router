import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { OBS_CHANNEL_METRICS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/102_obs_channel_metrics.js';
import { OBS_ALERTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/103_obs_alerts.js';
import { OBS_ALERT_SILENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/127_obs_alert_silences_reports.js';

test('migration 102 creates the channel metrics tables with the pinned shape', () => {
  assert.equal(OBS_CHANNEL_METRICS_SAAS_MIGRATION.version, 102);
  assert.equal(OBS_CHANNEL_METRICS_SAAS_MIGRATION.name, 'obs_channel_metrics');
  const sql = OBS_CHANNEL_METRICS_SAAS_MIGRATION.sql;
  for (const table of ['saas_obs_channel_metrics_1m', 'saas_obs_channel_metrics_hourly']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
    assert.match(sql, new RegExp(`CONSTRAINT ${table}_pk`));
    assert.match(sql, /PRIMARY KEY \(bucket_at, provider_id, route_id, model, error_category\)/);
  }
  // The full taxonomy plus 'ok' is enforced in CHECK constraints on both tables.
  const categories = [
    'ok',
    'content_policy',
    'authentication',
    'context_limit',
    'invalid_request',
    'model_unsupported',
    'quota_or_balance',
    'account_pool_unavailable',
    'rate_or_capacity',
    'timeout',
    'transport_or_stream',
    'upstream_forbidden',
    'not_found',
    'client_cancelled',
    'upstream_5xx',
    'internal',
    'other',
  ];
  const occurrences = sql.match(/'content_policy'/g)?.length ?? 0;
  assert.equal(occurrences, 2, 'taxonomy CHECK appears on both tables');
  for (const category of categories) {
    assert.ok(sql.includes(`'${category}'`), `expected migration 102 to mention '${category}'`);
  }
  assert.match(sql, /CREATE TABLE saas_obs_channel_metrics_watermark/);
  assert.match(sql, /CONSTRAINT saas_obs_channel_metrics_watermark_pk PRIMARY KEY \(watermark_key\)/);
  assert.match(sql, /watermark_key text NOT NULL/);
  assert.match(sql, /last_bucket_at timestamptz NOT NULL/);
  assert.match(sql, /CHECK \(watermark_key IN \('channel_metrics_1m', 'channel_metrics_hourly'\)\)/);
  // The ok row carries no errors: availability stays SUM(errors)/requests.
  assert.match(sql, /CHECK \(error_category <> 'ok' OR errors = 0\)/);
});

test('migration 103 creates alert rules and events with the pinned shape', () => {
  assert.equal(OBS_ALERTS_SAAS_MIGRATION.version, 103);
  assert.equal(OBS_ALERTS_SAAS_MIGRATION.name, 'obs_alert_rules_and_events');
  const sql = OBS_ALERTS_SAAS_MIGRATION.sql;
  assert.match(sql, /CREATE TABLE saas_obs_alert_rules \(/);
  assert.match(sql, /operator text NOT NULL\s+CHECK \(operator IN \('gt', 'lt'\)\)/);
  assert.match(sql, /window_minutes integer NOT NULL CHECK \(window_minutes >= 1\)/);
  assert.match(sql, /sustained_minutes integer NOT NULL CHECK \(sustained_minutes >= 1\)/);
  assert.match(sql, /cooldown_minutes integer NOT NULL CHECK \(cooldown_minutes >= 1\)/);
  assert.match(sql, /last_triggered_at timestamptz/);
  assert.match(sql, /created_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /CONSTRAINT saas_obs_alert_rules_sustained_within_window/);
  assert.match(sql, /CHECK \(sustained_minutes <= window_minutes\)/);
  assert.match(sql, /CREATE TABLE saas_obs_alert_events \(/);
  assert.match(sql, /rule_id uuid NOT NULL\s+REFERENCES saas_obs_alert_rules \(id\) ON DELETE CASCADE/);
  assert.match(sql, /triggered_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /resolved_at timestamptz/);
  assert.match(sql, /payload jsonb NOT NULL/);
  assert.match(sql, /CONSTRAINT saas_obs_alert_events_resolved_after_trigger/);
});

test('migrations 102 and 103 are registered in order ahead of the later forwards', () => {
  const versions = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = versions.indexOf(102);
  assert.ok(index > 0, '102 is registered');
  assert.equal(versions[index + 1], 103);
  assert.equal(SAAS_MIGRATIONS[index], OBS_CHANNEL_METRICS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[index + 1], OBS_ALERTS_SAAS_MIGRATION);
  // The documented forward chain behind 103: 104 embeddings, 105 billing
  // groups, 106 registration admission, 107 egress proxies, 108 opencode-go
  // scheduling, 109 probe monitors, 110 platform settings, 111 gemini
  // scheduling, 112-114 billing-group limit enforcement, 115 threshold
  // pause, 116 TLS fingerprints, 117-120 the batch-3 scheduling tails, 121
  // composite routing, 122 multimodal billing, 123 async image tasks, and (post-merge) 124-129 incl. the K2 durable fault classification.
  assert.deepEqual(
    versions.slice(index + 2, index + 22),
    [104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123],
  );
  // 127 (this task) registers directly after 126 (public brand settings).
  // The absolute tail stays unpinned: later parallel workstreams keep
  // appending (128 plugins, 125 risk in flight), so only the relative
  // neighbourhood is a stable contract.
  const index127 = versions.indexOf(127);
  assert.ok(index127 > 0, '127 is registered');
  assert.equal(versions[index127 - 1], 126);
  assert.equal(SAAS_MIGRATIONS[index127], OBS_ALERT_SILENCES_SAAS_MIGRATION);
});
