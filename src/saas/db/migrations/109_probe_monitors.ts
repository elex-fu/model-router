import type { SaasMigration } from './001_initial_schema.js';

/**
 * R6a active probing (docs/token-resale-implementation-plan-2026-10-15.md
 * §R6a, task #32): the scheduled per-account probe monitors plus their run
 * history, and the probe-derived temporary-unschedulable scheduling signal
 * on both account owner tables.
 *
 * Numbered 109: the plan's ledger reserved 107 for this workstream, but R3
 * egress proxies took 107 (documented re-arbitration) and 108 is R5b's
 * OpenCode Go scheduling; 109 is the next free slot after the applied head
 * (fail-closed serial ordering — lower numbers can never be applied on top
 * of an applied head).
 *
 * Design notes (sub2api channel-monitor parity, adapted to this repo's
 * invariants):
 * - Accounts are referenced exactly like migration 040's runtime-health
 *   rows: owner-scoped (owner_kind/owner_tenant_id/owner_scope_key) plus a
 *   text account_id, NOT a uuid FK — the tenant and platform account
 *   families live in two tables and the scope key is the canonical
 *   cross-family identity. One monitor per (owner_scope_key, account_id).
 * - The challenge is the sub2api arithmetic few-shot contract: the response
 *   must be digits only and exactly equal challenge_answer. The prompt and
 *   answer are operator-visible configuration, never credential material.
 * - last_result is the summary category {ok, rate_limited, auth_revoked,
 *   banned, error}; last_result_detail is a bounded jsonb summary (reset
 *   deadline, http status, latency) with a pinned shape — no request or
 *   response bodies, no secrets (the sub2api lesson: probe payloads never
 *   land in columns).
 * - probe_requested_at is the manual-trigger marker: the admin surface sets
 *   it together with next_due_at = now, and the claiming worker consumes and
 *   clears it so the recorded run carries triggered_by = 'manual' (the
 *   control plane has no credential-unsealing KMS, so manual probes execute
 *   in the worker runtime rather than the HTTP handler).
 * - next_due_at is the worker-computed due horizon (108's
 *   opencode_go_usage_next_due_at precedent); the SKIP LOCKED row claim is
 *   the in-flight dedup and lease, so there is deliberately no in-flight
 *   column — a crashed worker rolls back and leaves the monitor due.
 * - consecutive_failures counts probe-only failures; crossing
 *   failure_threshold sets probe_temp_unschedulable_until on the account
 *   row. Recovery is probe-success-only (never user-request success —
 *   burning user requests as probes is the sub2api/new-api lesson).
 * - saas_probe_runs is append-only history (no UPDATE grant anywhere);
 *   retention is a 30-day cleanup DELETE in the probe-monitor worker.
 *   Day aggregates stay out of the schema on purpose: the run table with
 *   bounded retention answers console queries and the 102 observability
 *   hourly rollups remain channel-scoped (adding a probe dimension there
 *   is a later, data-backed decision).
 * - probe_temp_unschedulable_until on both account owner tables follows
 *   the 099/100/108 scheduling-column precedent: nullable (NULL keeps
 *   pre-R6 behavior), never billing, and written only by the probe
 *   control-plane worker. Scheduler eligibility consumption is the R7
 *   workstream's integration (documented in the probe-monitor worker).
 */
const probeMonitorsSql = `
CREATE TABLE saas_probe_monitors (
  id uuid PRIMARY KEY,
  owner_scope_key text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('tenant', 'platform')),
  owner_tenant_id uuid REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (btrim(account_id) <> '' AND account_id = btrim(account_id)),
  provider_category text NOT NULL
    CHECK (provider_category IN ('claude', 'codex', 'opencode-go', 'api-key')),
  probe_interval_seconds integer NOT NULL DEFAULT 300
    CHECK (probe_interval_seconds >= 60 AND probe_interval_seconds <= 86400),
  challenge_prompt text NOT NULL,
  challenge_answer text NOT NULL,
  failure_threshold integer NOT NULL DEFAULT 3
    CHECK (failure_threshold >= 1 AND failure_threshold <= 10),
  consecutive_failures integer NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  last_result text
    CHECK (last_result IS NULL OR last_result IN ('ok', 'rate_limited', 'auth_revoked', 'banned', 'error')),
  last_result_detail jsonb,
  last_run_at timestamptz,
  next_due_at timestamptz,
  probe_requested_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_probe_monitors_scope_unique UNIQUE (owner_scope_key, account_id),
  CONSTRAINT saas_probe_monitors_scope_shape CHECK (
    (owner_kind = 'tenant' AND owner_tenant_id IS NOT NULL AND owner_scope_key = owner_tenant_id::text)
    OR (owner_kind = 'platform' AND owner_tenant_id IS NULL AND owner_scope_key = 'platform')
  ),
  CONSTRAINT saas_probe_monitors_challenge_prompt_shape CHECK (
    char_length(btrim(challenge_prompt)) BETWEEN 8 AND 512
    AND challenge_prompt = btrim(challenge_prompt)
  ),
  CONSTRAINT saas_probe_monitors_challenge_answer_shape CHECK (
    challenge_answer ~ '^[0-9]{1,6}$'
  ),
  CONSTRAINT saas_probe_monitors_result_shape CHECK (
    (last_result IS NULL) = (last_run_at IS NULL)
    AND (last_result_detail IS NULL OR last_result IS NOT NULL)
  ),
  CONSTRAINT saas_probe_monitors_detail_shape CHECK (
    last_result_detail IS NULL
    OR (
      jsonb_typeof(last_result_detail) = 'object'
      AND NOT (last_result_detail ? 'body')
      AND NOT (last_result_detail ? 'request')
      AND NOT (last_result_detail ? 'credential')
    )
  )
);

CREATE INDEX saas_probe_monitors_due_idx
  ON saas_probe_monitors (next_due_at, id)
  WHERE enabled;

CREATE TABLE saas_probe_runs (
  id uuid PRIMARY KEY,
  monitor_id uuid NOT NULL
    REFERENCES saas_probe_monitors (id) ON DELETE CASCADE,
  triggered_by text NOT NULL CHECK (triggered_by IN ('manual', 'scheduled')),
  result text NOT NULL
    CHECK (result IN ('ok', 'rate_limited', 'auth_revoked', 'banned', 'error')),
  detail jsonb,
  http_status integer
    CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
  latency_ms integer
    CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_probe_runs_detail_shape CHECK (
    detail IS NULL
    OR (
      jsonb_typeof(detail) = 'object'
      AND NOT (detail ? 'body')
      AND NOT (detail ? 'request')
      AND NOT (detail ? 'credential')
    )
  )
);

CREATE INDEX saas_probe_runs_monitor_created_idx
  ON saas_probe_runs (monitor_id, created_at DESC);

CREATE INDEX saas_probe_runs_created_idx
  ON saas_probe_runs (created_at);

ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN probe_temp_unschedulable_until timestamptz;

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN probe_temp_unschedulable_until timestamptz;
`;

export const PROBE_MONITORS_SAAS_MIGRATION: SaasMigration = {
  version: 109,
  name: 'probe_monitors',
  sql: probeMonitorsSql,
};
