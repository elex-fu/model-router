import type { SaasMigration } from './001_initial_schema.js';

/**
 * Gap-remediation plan G-A1 (§1.3, migration 132): the recovery substrate
 * for async media tasks — the columns the PG-lease recovery worker needs on
 * `saas_video_tasks`.
 *
 * Design (new-api task_polling + sub2api batch-image heartbeat fusion):
 *
 * - `next_poll_at` (NOT NULL, DEFAULT now()) — the worker's due-time cursor.
 *   Every existing `billing_state = 'pending'` row becomes immediately
 *   claimable the moment this migration lands (DEFAULT now() is evaluated
 *   per-row at ALTER time for pre-existing rows via the table rewrite), so
 *   tasks stranded by a dead process are adopted without a backfill.
 * - `lease_owner` / `lease_epoch` / `lease_until` — the recovery claim.
 *   Claim bumps `lease_epoch` and sets a 90 s `lease_until`; a live worker
 *   renews (heartbeat, TTL/3); a worker that dies releases nothing and the
 *   expired lease is re-claimable by any instance. The epoch fences a
 *   zombie whose lease expired mid-flight from overwriting a newer owner's
 *   state (every outcome write carries owner+epoch in the WHERE).
 * - `poll_failures` (NOT NULL, DEFAULT 0) — the six-class failure counter
 *   (ok / not_found / auth / transient / other_client / unrecognized). A
 *   successful poll resets it; the cap (default 20, new-api
 *   TASK_POLL_MAX_FAILURES) escalates to the fail-closed `skipped`
 *   terminal, never a guessed bill.
 *
 * `saas_image_tasks` intentionally gets NO new columns: image generation is
 * a single synchronous upstream HTTP dispatch with no upstream task id to
 * re-poll, so process death means the deliverable is unrecoverable — the
 * recovery action is the guarded stuck-fail sweep (status='processing' AND
 * created_at past the execution timeout → failed), which needs only the
 * existing columns; billing for the stranded attempt is already owned by
 * the unknown-outcome reconciliation worker (plan §11.3: 不承诺自动恢复内容).
 *
 * Runtime privileges: UPDATE grants for the five new columns are added in
 * runtime-privileges.ts alongside this migration (SELECT stays table-level
 * full-read via the existing allowlist; INSERT never writes them — column
 * defaults only).
 *
 * Numbered 132: appends after the applied head 131.
 */
const mediaTaskRecoverySql = `
ALTER TABLE saas_video_tasks
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_poll_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN poll_failures integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT saas_video_tasks_lease_epoch_nonnegative CHECK (lease_epoch >= 0),
  ADD CONSTRAINT saas_video_tasks_poll_failures_nonnegative CHECK (poll_failures >= 0),
  ADD CONSTRAINT saas_video_tasks_lease_pair_shape CHECK (
    (lease_owner IS NULL AND lease_until IS NULL)
    OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  ),
  ADD CONSTRAINT saas_video_tasks_lease_owner_nonempty CHECK (
    lease_owner IS NULL OR char_length(btrim(lease_owner)) > 0
  );

CREATE INDEX saas_video_tasks_recovery_due_idx
  ON saas_video_tasks (next_poll_at)
  WHERE billing_state = 'pending';
`;

export const MEDIA_TASK_RECOVERY_SAAS_MIGRATION: SaasMigration = {
  version: 132,
  name: 'media_task_recovery',
  sql: mediaTaskRecoverySql,
};
