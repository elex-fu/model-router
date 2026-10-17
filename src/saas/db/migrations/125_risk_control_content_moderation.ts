import type { SaasMigration } from './001_initial_schema.js';

/*
 * Roadmap batch 5 §5.4 (task #19) — content risk control.
 *
 * Three tables:
 * - `saas_risk_control_config`: single-row (id = 1) JSONB configuration owned
 *   by the control plane, read by the gateway hot path through a short-TTL
 *   snapshot (the migration 116 TLS-profile resolver doctrine; the platform
 *   settings KV is deliberately control-plane-only by design, so risk control
 *   gets its own gateway-readable relation).
 * - `saas_content_moderation_logs`: one row per audited request decision
 *   (hit or, when record_non_hits is on, non-hit). Written by the gateway
 *   seam (post-auth, pre-preparation), listed by the admin surface, counted
 *   for the auto-ban violation window, and purged by the control-plane
 *   retention worker (hit 180d / non-hit 3d defaults, both configurable).
 * - `saas_content_moderation_flagged_hashes`: pre-hash blocklist. When a
 *   semantic check flags an input, its sha256 is recorded so later requests
 *   with identical text are blocked with zero API latency.
 *
 * No GRANT/TRIGGER/FUNCTION statements here — grants live in the role
 * template (deploy/managed-saas-postgres-roles.sql + runtime-privileges.ts),
 * which must be re-applied after this migration.
 */

const riskControlContentModerationSql = `
CREATE TABLE saas_risk_control_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_content_moderation_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text,
  api_key_id text NOT NULL,
  api_key_name text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  protocol text NOT NULL DEFAULT '',
  mode text NOT NULL,
  action text NOT NULL,
  flagged boolean NOT NULL DEFAULT false,
  highest_category text NOT NULL DEFAULT '',
  highest_score double precision NOT NULL DEFAULT 0,
  matched_keyword text NOT NULL DEFAULT '',
  category_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_excerpt text NOT NULL DEFAULT '',
  input_hash text,
  upstream_latency_ms integer,
  error text NOT NULL DEFAULT '',
  violation_count integer NOT NULL DEFAULT 0,
  auto_banned boolean NOT NULL DEFAULT false,
  email_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_content_moderation_logs_action_check
    CHECK (action IN ('allow', 'block', 'hash_block', 'keyword_block', 'error')),
  CONSTRAINT saas_content_moderation_logs_mode_check
    CHECK (mode IN ('off', 'observe', 'pre_block'))
);

CREATE INDEX saas_content_moderation_logs_created_at_idx
  ON saas_content_moderation_logs (created_at);
CREATE INDEX saas_content_moderation_logs_tenant_created_idx
  ON saas_content_moderation_logs (tenant_id, created_at);
CREATE INDEX saas_content_moderation_logs_action_created_idx
  ON saas_content_moderation_logs (action, created_at);
CREATE INDEX saas_content_moderation_logs_model_created_idx
  ON saas_content_moderation_logs (model, created_at);
-- Partial index for the auto-ban violation window count: only flagged rows
-- with a known user participate (hash_block rows are excluded by the query,
-- not the index — they stay visible for the admin surface).
CREATE INDEX saas_content_moderation_logs_user_flagged_created_idx
  ON saas_content_moderation_logs (user_id, created_at)
  WHERE flagged AND user_id IS NOT NULL;

CREATE TABLE saas_content_moderation_flagged_hashes (
  input_hash text PRIMARY KEY
    CONSTRAINT saas_content_moderation_flagged_hashes_hash_check
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saas_content_moderation_flagged_hashes_created_at_idx
  ON saas_content_moderation_flagged_hashes (created_at);
`;

export const RISK_CONTROL_CONTENT_MODERATION_SAAS_MIGRATION: SaasMigration = {
  version: 125,
  name: 'risk_control_content_moderation',
  sql: riskControlContentModerationSql,
};
