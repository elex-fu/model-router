import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch 4 §4.2 async image tasks (task #16; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次四 4.2; sub2api
 * reference: backend/internal/service/image_task.go ImageTaskStore on
 * Redis — here the durable PG row is the store of record).
 *
 * `saas_image_tasks` records one accepted async image generation
 * (POST /v1/images/generations/async): an opaque `imgtask_<32-hex>` id,
 * tenant + proxy-key ownership (the sub2api user_id/api_key_id pair — a
 * foreign task is indistinguishable from a missing one), the
 * processing → completed|failed state machine, the upstream HTTP status,
 * and either the post-offload compact result JSON (b64_json payloads are
 * rewritten to object-storage links before landing here — the large blob
 * never persists) or the failure envelope. `expires_at` carries the 24 h
 * TTL; expiry is enforced lazily on read plus the explicit purge sweep
 * (PostgresImageTaskStore.purgeExpired).
 *
 * Grants: the gateway role alone owns the lifecycle (column-scoped
 * INSERT/UPDATE on the mutable columns plus the dynamic read-table grant);
 * the control plane has no access (task rows are request-scoped gateway
 * state, not admin data) — the mirrors are runtime-privileges.ts and
 * deploy/managed-saas-postgres-roles.sql. No validation-worker grant (no
 * provider-account columns), no triggers, no credential material.
 */
const imageTasksSql = `
CREATE TABLE saas_image_tasks (
  id varchar(48) PRIMARY KEY CHECK (id ~ '^imgtask_[0-9a-f]{32}$'),
  tenant_id text NOT NULL,
  proxy_key_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  http_status integer CHECK (http_status IS NULL OR (http_status BETWEEN 100 AND 599)),
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT saas_image_tasks_terminal_shape CHECK (
    (status = 'processing' AND http_status IS NULL AND result IS NULL AND error IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND http_status IS NOT NULL AND result IS NOT NULL AND error IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND http_status IS NOT NULL AND result IS NULL AND error IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT saas_image_tasks_owner_nonempty CHECK (
    char_length(btrim(tenant_id)) > 0 AND char_length(btrim(proxy_key_id)) > 0
  ),
  CONSTRAINT saas_image_tasks_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX saas_image_tasks_owner_idx ON saas_image_tasks (tenant_id, proxy_key_id);
CREATE INDEX saas_image_tasks_expiry_idx ON saas_image_tasks (expires_at);
CREATE INDEX saas_image_tasks_processing_idx ON saas_image_tasks (status, created_at) WHERE status = 'processing';
`;

export const IMAGE_TASKS_SAAS_MIGRATION: SaasMigration = {
  version: 123,
  name: 'image_tasks',
  sql: imageTasksSql,
};
