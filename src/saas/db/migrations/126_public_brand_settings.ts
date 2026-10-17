import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch 5 §5.2 OEM white-label (task #20): the public brand snapshot table.
 *
 * Migration 110's platform settings store is control-plane-only by design —
 * the gateway holds no grant on it, so the workloads that serve the console
 * HTML (`window.__APP_CONFIG__` SSR injection) and the public
 * `GET /settings/public` endpoint cannot read brand configuration from
 * there. This migration adds the deliberately separate, gateway-readable
 * public read plane:
 *
 * - `saas_public_brand_settings` is a single-row snapshot table. The control
 *   plane materializes the non-secret brand subset (site name/subtitle/logo,
 *   API base URL, contact/doc URLs, custom menu items, custom endpoints,
 *   custom pages, frame-ancestors) from the `saas.brand.*` settings keys;
 *   the version column increments on every materialization so readers can
 *   observe freshness without comparing payloads.
 * - No secret can enter the snapshot by construction: every materialized
 *   field passes the strict public parsers in
 *   src/saas/platform/brand/snapshot.ts (the same grammar the settings
 *   registry enforces at write time), and the row is written only by the
 *   control-plane materializer.
 * - Grants mirror the 105/107/121 precedent: control-plane column grants
 *   (SELECT/INSERT/UPDATE, no DELETE — the snapshot row is never removed)
 *   in runtime-privileges.ts and deploy/managed-saas-postgres-roles.sql;
 *   the gateway receives the table in its dynamic read-table allowlist only.
 *   The credential-validation-worker gets nothing.
 * - The row is seeded with the empty snapshot so readers have a deterministic
 *   single row from the first boot; an absent row is handled identically by
 *   the reader (the empty snapshot) for databases migrated before the seed.
 *
 * Plain data migration: no grants, no drops, no triggers, no credential
 * material (the 121 convention).
 */
const publicBrandSettingsSql = `
CREATE TABLE saas_public_brand_settings (
  singleton boolean PRIMARY KEY,
  snapshot jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1
    CHECK (version >= 1),
  materialized_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_public_brand_settings_singleton_only CHECK (singleton = true),
  CONSTRAINT saas_public_brand_settings_snapshot_object CHECK (
    jsonb_typeof(snapshot) = 'object'
  ),
  CONSTRAINT saas_public_brand_settings_snapshot_bounded CHECK (
    pg_column_size(snapshot) <= 1048576
  )
);

INSERT INTO saas_public_brand_settings (singleton, snapshot)
VALUES (true, '{}'::jsonb);
`;

export const PUBLIC_BRAND_SETTINGS_SAAS_MIGRATION: SaasMigration = {
  version: 126,
  name: 'public_brand_settings',
  sql: publicBrandSettingsSql,
};
