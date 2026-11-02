import type { SaasMigration } from './001_initial_schema.js';

/**
 * Operator bulk account-import jobs and their per-item outcomes. Credential
 * material is never persisted here: the provider-scoped HMAC-SHA256 fingerprint
 * is the only credential-derived value. A pending or newly imported credential
 * is unique per provider/fingerprint; deduplicated history rows may share the
 * canonical account reference. Failed rows do not block a later retry.
 *
 * The store must serialize claims for one provider/fingerprint and update each
 * item together with its job counters in one transaction. Validation enqueue
 * failure does not turn an already-created account into a failed import.
 */
const bulkAccountImportSql = `
CREATE TABLE saas_bulk_import_job (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  total_count integer NOT NULL CHECK (total_count >= 0),
  success_count integer NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_by uuid NOT NULL,
  error_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(error_summary) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT saas_bulk_import_job_counter_bounds
    CHECK (success_count + failure_count <= total_count),
  CONSTRAINT saas_bulk_import_job_terminal_shape CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND success_count + failure_count = total_count)
  )
);

CREATE TABLE saas_bulk_import_item (
  job_id uuid NOT NULL,
  item_index integer NOT NULL CHECK (item_index >= 0),
  provider text NOT NULL CHECK (provider IN ('codex', 'claude', 'gemini', 'grok')),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'deduplicated', 'failed')),
  account_ref text,
  error_reason text,
  display_name text,
  egress_proxy_id uuid,
  validation_state text NOT NULL DEFAULT 'pending_validation'
    CHECK (validation_state IN ('pending_validation', 'queued', 'queue_failed', 'not_requested')),
  option_warnings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(option_warnings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT saas_bulk_import_item_pk PRIMARY KEY (job_id, item_index),
  CONSTRAINT saas_bulk_import_item_job_fk
    FOREIGN KEY (job_id) REFERENCES saas_bulk_import_job (id) ON DELETE RESTRICT,
  CONSTRAINT saas_bulk_import_item_account_fk
    FOREIGN KEY (account_ref) REFERENCES saas_platform_provider_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT saas_bulk_import_item_egress_proxy_fk
    FOREIGN KEY (egress_proxy_id) REFERENCES saas_egress_proxies (id) ON DELETE RESTRICT,
  CONSTRAINT saas_bulk_import_item_error_reason_shape
    CHECK (error_reason IS NULL OR (btrim(error_reason) <> '' AND char_length(error_reason) <= 128)),
  CONSTRAINT saas_bulk_import_item_display_name_shape
    CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  CONSTRAINT saas_bulk_import_item_terminal_shape CHECK (
    (status = 'pending' AND account_ref IS NULL AND error_reason IS NULL AND completed_at IS NULL
      AND validation_state = 'pending_validation')
    OR (status = 'succeeded' AND account_ref IS NOT NULL AND btrim(account_ref) <> ''
      AND completed_at IS NOT NULL AND validation_state IN ('pending_validation', 'queued', 'queue_failed'))
    OR (status = 'deduplicated' AND account_ref IS NOT NULL AND btrim(account_ref) <> ''
      AND error_reason IS NULL AND completed_at IS NOT NULL AND validation_state = 'not_requested')
    OR (status = 'failed' AND account_ref IS NULL AND error_reason IS NOT NULL
      AND completed_at IS NOT NULL AND validation_state = 'not_requested')
  )
);

CREATE UNIQUE INDEX saas_bulk_import_item_active_credential_uidx
  ON saas_bulk_import_item (provider, credential_fingerprint)
  WHERE status IN ('pending', 'succeeded');
CREATE INDEX saas_bulk_import_item_job_status_idx
  ON saas_bulk_import_item (job_id, status, item_index);
CREATE INDEX saas_bulk_import_item_account_idx
  ON saas_bulk_import_item (account_ref)
  WHERE account_ref IS NOT NULL;
CREATE INDEX saas_bulk_import_job_creator_time_idx
  ON saas_bulk_import_job (created_by, created_at DESC);
CREATE INDEX saas_bulk_import_job_running_idx
  ON saas_bulk_import_job (created_at)
  WHERE status = 'running';
`;

export const BULK_ACCOUNT_IMPORT_SAAS_MIGRATION: SaasMigration = {
  version: 150,
  name: 'bulk_account_import',
  sql: bulkAccountImportSql,
};
