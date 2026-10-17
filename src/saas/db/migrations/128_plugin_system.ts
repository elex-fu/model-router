import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch-5 §5.1 plugin system (task #24; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.1; sub2api reference:
 * backend/internal/service/plugin_{manager,package,manifest,runtime,host_services}.go,
 * backend/pkg/pluginapi/v1/plugin.proto, docs/PLUGIN_DEVELOPMENT.md).
 *
 * Three tables, one per runtime concern:
 *
 * 1. `saas_plugin_installations` — the DB-authoritative installation registry
 *    (the sub2api PluginManager row). The standalone plugin-host workload
 *    runs a reconcile loop that converges its live child processes from
 *    these rows on a ~1s cadence: a row in `starting`/`error` state with an
 *    enabled binding is (re)spawned, a removed row's process is torn down,
 *    and every transition back is CAS-written (id + expected state + expected
 *    binary_sha256 — see src/saas/plugins/store.ts). `artifact_data` keeps
 *    the ORIGINAL signed package bytes (BYTEA) next to the metadata so any
 *    plugin-host replica can re-verify the signature chain (manifest_sha256
 *    → binary_sha256 → artifact_sha256) and re-extract the entrypoint
 *    without an object store; the column is deliberately excluded from every
 *    non-privileged read grant (the gateway sees routing columns only).
 *    `installed_by` references the platform admin user (saas_users.id,
 *    migration 001) with ON DELETE SET NULL — an anonymized admin user must
 *    not pin installation rows.
 *
 * 2. `saas_plugin_bindings` — the capability-scope routing table. One row
 *    binds one installation to one (capability, platform, account_type)
 *    scope; the platform/account_type pair is frozen by the centralized
 *    PLUGIN_CAPABILITY_AUTHORIZATIONS table (a manifest cannot widen it).
 *    The partial unique index `saas_plugin_bindings_one_enabled_scope` is
 *    the DB-level one-enabled-plugin-per-capability-scope guarantee: two
 *    enabled bindings for the same scope can never coexist, so the gateway
 *    routing decorator never has to arbitrate. Enabling a second plugin for
 *    a scope requires disabling the first (the store's replace/enabled CAS
 *    flows surface exactly that).
 *
 * 3. `saas_plugin_kv` — the PG-backed host-service KV store (sub2api's
 *    plugin host KV). Namespaced per plugin_key; the namespace/key charset
 *    CHECK ([A-Za-z0-9._-]) is the sub2api rule and keeps every key safely
 *    prefix-listable with LIKE ... ESCAPE. Values are capped app-side at
 *    256 KiB; TTL rows expire by predicate, never by a sweeper with broad
 *    DELETE (the plugin-host role holds the only table-level DELETE grant
 *    in the deployment for exactly this table).
 *
 * Grants live in the role templates (runtime-privileges.ts +
 * deploy/managed-saas-postgres-roles.sql for control-plane CRUD and gateway
 * routing reads; the NEW plugin-host role in plugin-host-privileges.ts +
 * deploy/managed-saas-plugin-host-role-grants.ts). No trigger, function or
 * authz_version bump lives here (the reconcile loop owns invalidation; the
 * 121 plain-data-migration precedent). Version 128: 123-124 are reserved
 * for the parallel media/websearch workstreams, 125/126 landed from batch-5
 * §5.4/§5.2, and 127 is reserved for the parallel observability workstream.
 */
const pluginSystemSql = `
CREATE TABLE saas_plugin_installations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_key varchar(160) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  version varchar(64) NOT NULL,
  description text NOT NULL DEFAULT '',
  author varchar(160) NOT NULL DEFAULT '',
  manifest jsonb NOT NULL,
  manifest_sha256 varchar(64) NOT NULL,
  entrypoint_path text NOT NULL,
  binary_sha256 varchar(64) NOT NULL,
  signature_status text NOT NULL CHECK (signature_status IN ('trusted', 'unsigned')),
  state text NOT NULL DEFAULT 'disabled'
    CHECK (state IN ('disabled', 'starting', 'enabled', 'error', 'incompatible')),
  config_json jsonb,
  last_error text NOT NULL DEFAULT '',
  artifact_data bytea NOT NULL,
  artifact_sha256 varchar(64) NOT NULL,
  installed_by uuid REFERENCES saas_users (id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled_at timestamptz,
  CONSTRAINT saas_plugin_installations_plugin_key_shape CHECK (
    char_length(plugin_key) BETWEEN 1 AND 160 AND plugin_key = btrim(plugin_key)
  ),
  CONSTRAINT saas_plugin_installations_name_shape CHECK (
    char_length(name) BETWEEN 1 AND 160 AND name = btrim(name)
  ),
  CONSTRAINT saas_plugin_installations_version_shape CHECK (
    char_length(version) BETWEEN 1 AND 64 AND version = btrim(version)
  ),
  CONSTRAINT saas_plugin_installations_description_bounded CHECK (char_length(description) <= 2000),
  CONSTRAINT saas_plugin_installations_author_bounded CHECK (char_length(author) <= 160),
  CONSTRAINT saas_plugin_installations_manifest_object CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT saas_plugin_installations_manifest_sha256_hex CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT saas_plugin_installations_entrypoint_shape CHECK (
    char_length(entrypoint_path) BETWEEN 1 AND 1024 AND entrypoint_path = btrim(entrypoint_path)
  ),
  CONSTRAINT saas_plugin_installations_binary_sha256_hex CHECK (binary_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT saas_plugin_installations_config_object CHECK (
    config_json IS NULL OR jsonb_typeof(config_json) = 'object'
  ),
  CONSTRAINT saas_plugin_installations_last_error_bounded CHECK (char_length(last_error) <= 4000),
  CONSTRAINT saas_plugin_installations_artifact_sha256_hex CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE saas_plugin_bindings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id bigint NOT NULL REFERENCES saas_plugin_installations (id) ON DELETE CASCADE,
  capability varchar(100) NOT NULL,
  platform varchar(50) NOT NULL,
  account_type varchar(50) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent integer NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_plugin_bindings_scope_unique UNIQUE (installation_id, capability, platform, account_type),
  CONSTRAINT saas_plugin_bindings_capability_shape CHECK (
    char_length(capability) BETWEEN 1 AND 100 AND capability = btrim(capability)
  ),
  CONSTRAINT saas_plugin_bindings_platform_shape CHECK (
    char_length(platform) BETWEEN 1 AND 50 AND platform = btrim(platform)
  ),
  CONSTRAINT saas_plugin_bindings_account_type_shape CHECK (
    char_length(account_type) BETWEEN 1 AND 50 AND account_type = btrim(account_type)
  )
);

-- The one-enabled-plugin-per-capability-scope guarantee (partial unique).
CREATE UNIQUE INDEX saas_plugin_bindings_one_enabled_scope
  ON saas_plugin_bindings (capability, platform, account_type) WHERE enabled;

CREATE INDEX saas_plugin_bindings_installation_idx ON saas_plugin_bindings (installation_id);

CREATE INDEX saas_plugin_bindings_scope_idx
  ON saas_plugin_bindings (platform, account_type, capability) WHERE enabled;

CREATE TABLE saas_plugin_kv (
  plugin_key varchar(160) NOT NULL,
  namespace varchar(128) NOT NULL,
  key varchar(256) NOT NULL,
  value text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_key, namespace, key),
  CONSTRAINT saas_plugin_kv_namespace_charset CHECK (namespace ~ '^[A-Za-z0-9._-]+$'),
  CONSTRAINT saas_plugin_kv_key_charset CHECK (key ~ '^[A-Za-z0-9._-]+$')
);
`;

export const PLUGIN_SYSTEM_SAAS_MIGRATION: SaasMigration = {
  version: 128,
  name: 'plugin_system',
  sql: pluginSystemSql,
};
