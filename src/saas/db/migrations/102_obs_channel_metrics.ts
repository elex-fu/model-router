import type { SaasMigration } from './001_initial_schema.js';

/**
 * Phase 3 observability channel metrics (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 3).
 * Passive sub2api-V2-style aggregation: a single-leader worker folds
 * saas_attempts/saas_requests facts into per-minute channel rows keyed by
 * (bucket, provider, route, model, error_category) with a fixed 16-category
 * error taxonomy (plus 'ok'), advancing a watermark cursor so replicas never
 * double-count. The hourly table is the same shape rolled up from the 1m
 * table for long-range availability queries.
 *
 * Row semantics (documented for every writer):
 * - requests: total attempts in the (bucket, provider, route, model) group —
 *   repeated on every category row of the group so availability is
 *   SUM(errors)/MAX(requests) without a second scan;
 * - errors: attempts classified into this error_category ('ok' rows carry 0);
 * - upstream_affected: attempts in this category that actually reached an
 *   upstream (dispatch_state 'sent' or 'unknown') — a client-side 4xx that
 *   was never dispatched does not count against the channel.
 *
 * Numbered 102 (Phase 3 observability segment); 099-101 are reserved.
 */
const obsChannelMetricsSql = `
CREATE TABLE saas_obs_channel_metrics_1m (
  bucket_at timestamptz NOT NULL,
  provider_id text NOT NULL
    CHECK (btrim(provider_id) <> ''),
  route_id text NOT NULL
    CHECK (btrim(route_id) <> ''),
  model text NOT NULL
    CHECK (btrim(model) <> ''),
  error_category text NOT NULL
    CHECK (error_category IN (
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
      'other'
    )),
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  errors integer NOT NULL DEFAULT 0 CHECK (errors >= 0),
  upstream_affected integer NOT NULL DEFAULT 0 CHECK (upstream_affected >= 0),
  CONSTRAINT saas_obs_channel_metrics_1m_pk
    PRIMARY KEY (bucket_at, provider_id, route_id, model, error_category),
  CONSTRAINT saas_obs_channel_metrics_1m_ok_row_shape
    CHECK (error_category <> 'ok' OR errors = 0)
);

CREATE INDEX saas_obs_channel_metrics_1m_bucket_idx
  ON saas_obs_channel_metrics_1m (bucket_at DESC);

CREATE TABLE saas_obs_channel_metrics_hourly (
  bucket_at timestamptz NOT NULL,
  provider_id text NOT NULL
    CHECK (btrim(provider_id) <> ''),
  route_id text NOT NULL
    CHECK (btrim(route_id) <> ''),
  model text NOT NULL
    CHECK (btrim(model) <> ''),
  error_category text NOT NULL
    CHECK (error_category IN (
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
      'other'
    )),
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  errors integer NOT NULL DEFAULT 0 CHECK (errors >= 0),
  upstream_affected integer NOT NULL DEFAULT 0 CHECK (upstream_affected >= 0),
  CONSTRAINT saas_obs_channel_metrics_hourly_pk
    PRIMARY KEY (bucket_at, provider_id, route_id, model, error_category),
  CONSTRAINT saas_obs_channel_metrics_hourly_ok_row_shape
    CHECK (error_category <> 'ok' OR errors = 0)
);

CREATE INDEX saas_obs_channel_metrics_hourly_bucket_idx
  ON saas_obs_channel_metrics_hourly (bucket_at DESC);

CREATE TABLE saas_obs_channel_metrics_watermark (
  watermark_key text NOT NULL
    CHECK (watermark_key IN ('channel_metrics_1m', 'channel_metrics_hourly')),
  last_bucket_at timestamptz NOT NULL,
  CONSTRAINT saas_obs_channel_metrics_watermark_pk PRIMARY KEY (watermark_key)
);
`;

export const OBS_CHANNEL_METRICS_SAAS_MIGRATION: SaasMigration = {
  version: 102,
  name: 'obs_channel_metrics',
  sql: obsChannelMetricsSql,
};
