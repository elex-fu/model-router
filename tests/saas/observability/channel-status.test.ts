import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChannelMetrics1mInsertSql,
  buildChannelMetricsHourlyInsertSql,
  OBS_CHANNEL_METRICS_1M_WATERMARK_KEY,
  OBS_CHANNEL_METRICS_HOURLY_WATERMARK_KEY,
} from '../../../src/saas/observability/channel-status.js';

test('the 1m fold aggregates attempts into category rows with group totals', () => {
  const sql = buildChannelMetrics1mInsertSql();
  assert.match(sql, /date_trunc\('minute', a\.created_at\) AS bucket_at/);
  assert.match(sql, /COALESCE\(a\.provider_id, a\.upstream_id, 'unattributed'\) AS provider_id/);
  assert.match(sql, /COALESCE\(a\.route_config_id, 'unrouted'\) AS route_id/);
  // requests repeats the group total; errors and upstream_affected are
  // category-scoped.
  assert.match(sql, /COUNT\(\*\)::int AS group_requests/);
  assert.match(sql, /SUM\(CASE WHEN p\.error_category <> 'ok' THEN 1 ELSE 0 END\)::int/);
  assert.match(sql, /SUM\(CASE WHEN p\.error_category <> 'ok' AND p\.upstream_affected THEN 1 ELSE 0 END\)::int/);
  // Upstream-affected only counts attempts that were actually dispatched.
  assert.match(sql, /\(a\.dispatch_state IN \('sent', 'unknown'\)\) AS upstream_affected/);
  // Idempotent upsert keyed by the full primary key.
  assert.match(sql, /ON CONFLICT \(bucket_at, provider_id, route_id, model, error_category\) DO UPDATE/);
  // The fold is bounded by the (from, to] watermark window.
  assert.match(sql, /WHERE a\.created_at > \$1 AND a\.created_at <= \$2/);
});

test('the hourly rollup recovers per-minute group totals with MAX before summing', () => {
  const sql = buildChannelMetricsHourlyInsertSql();
  assert.match(sql, /date_trunc\('hour', m\.bucket_at\) AS hour_at/);
  assert.match(sql, /MAX\(m\.requests\) AS minute_requests/);
  assert.match(sql, /SUM\(minute_requests\)::int AS hour_requests/);
  assert.match(sql, /ON CONFLICT \(bucket_at, provider_id, route_id, model, error_category\) DO UPDATE/);
  assert.match(sql, /WHERE m\.bucket_at > \$1 AND m\.bucket_at <= \$2/);
});

test('watermark keys are the two documented cursor identities', () => {
  assert.equal(OBS_CHANNEL_METRICS_1M_WATERMARK_KEY, 'channel_metrics_1m');
  assert.equal(OBS_CHANNEL_METRICS_HOURLY_WATERMARK_KEY, 'channel_metrics_hourly');
});
