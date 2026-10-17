import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch 4 §4.3 async video tasks (task #17; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次四 4.3; sub2api
 * reference: backend/internal/service/grok_media.go — the Redis
 * pending-billing / bound-account state ported to one durable PG row).
 *
 * `saas_video_tasks` records one accepted asynchronous video create
 * (POST /v1/videos[/generations|/edits|/extensions]). One row carries the
 * three duties the status/content polls need:
 *
 * 1. **create-time billing snapshot** — model / resolution / duration /
 *    count normalized at create (the official status response does not
 *    echo the resolution, so the snapshot is the pricing authority) plus
 *    the gateway request/attempt identity that the deferred settlement
 *    reconciles against;
 * 2. **bound-account binding** — the provider account / credential that
 *    accepted the create; every later status or content poll forwards
 *    through that same account (sub2api BindGrokMediaVideoRequestAccount:
 *    a task is only ever visible to the account that created it, so a
 *    foreign scheduler pick yields the upstream's own 404);
 * 3. **the one-shot billing claim** — `billing_state` transitions
 *    pending → billed atomically (`claimBilling`), is released back to
 *    pending when the deferred settlement fails (retry on a later poll),
 *    and moves to `skipped` fail-closed when the snapshot is missing
 *    (never billed at a guessed default price).
 *
 * `expires_at` carries the 24 h TTL (the sub2api pending-billing TTL);
 * expiry is enforced lazily on read plus the purge sweep.
 *
 * Grants: the gateway role alone owns the lifecycle (column-scoped
 * INSERT/UPDATE on the mutable columns plus the dynamic read-table grant
 * and the TTL purge DELETE), mirroring `saas_image_tasks` (123) in
 * runtime-privileges.ts and deploy/managed-saas-postgres-roles.sql. No
 * control-plane grant (request-scoped gateway state), no triggers, no
 * credential material — only credential *references*.
 */
const videoTasksSql = `
CREATE TABLE saas_video_tasks (
  request_id varchar(255) PRIMARY KEY CHECK (request_id ~ '^[!-~]{1,255}$'),
  tenant_id text NOT NULL,
  proxy_key_id text NOT NULL,
  provider_account_id text NOT NULL,
  credential_id text NOT NULL,
  credential_version text NOT NULL,
  gateway_request_id text NOT NULL,
  gateway_attempt_id text NOT NULL,
  model text NOT NULL CHECK (char_length(btrim(model)) > 0),
  resolution text NOT NULL CHECK (resolution IN ('480p', '720p', '1080p')),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 15),
  video_count integer NOT NULL CHECK (video_count BETWEEN 1 AND 10),
  billing_state text NOT NULL CHECK (billing_state IN ('pending', 'billed', 'skipped')),
  billed_at timestamptz,
  /*
   * Create-time settlement facts (platform supply only; null for BYOK):
   * the customer price version + frozen admission price snapshot ref +
   * currency the deferred status-poll settlement re-prices against. Null
   * for BYOK rows — no wallet settlement exists to reconcile.
   */
  settlement_facts jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT saas_video_tasks_owner_nonempty CHECK (
    char_length(btrim(tenant_id)) > 0 AND char_length(btrim(proxy_key_id)) > 0
  ),
  CONSTRAINT saas_video_tasks_binding_nonempty CHECK (
    char_length(btrim(provider_account_id)) > 0
    AND char_length(btrim(credential_id)) > 0
    AND char_length(btrim(credential_version)) > 0
    AND char_length(btrim(gateway_request_id)) > 0
    AND char_length(btrim(gateway_attempt_id)) > 0
  ),
  CONSTRAINT saas_video_tasks_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT saas_video_tasks_billed_at_shape CHECK (
    (billing_state = 'pending' AND billed_at IS NULL)
    OR (billing_state = 'billed' AND billed_at IS NOT NULL)
    OR (billing_state = 'skipped' AND billed_at IS NULL)
  )
);

CREATE INDEX saas_video_tasks_owner_idx ON saas_video_tasks (tenant_id, proxy_key_id);
CREATE INDEX saas_video_tasks_expiry_idx ON saas_video_tasks (expires_at);
CREATE INDEX saas_video_tasks_pending_idx ON saas_video_tasks (billing_state, created_at) WHERE billing_state = 'pending';
`;

export const VIDEO_TASKS_SAAS_MIGRATION: SaasMigration = {
  version: 124,
  name: 'video_tasks',
  sql: videoTasksSql,
};
