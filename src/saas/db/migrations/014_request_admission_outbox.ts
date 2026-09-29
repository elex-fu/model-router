import type { SaasMigration } from './001_initial_schema.js';

const requestAdmissionOutboxSchemaSql = `
/*
 * Admission bookkeeping is deliberately not a dispatch queue.  The payload
 * contains only references needed by downstream accounting/audit workers;
 * live request data stays in the request process and is never reconstructed
 * from this table.
 */
CREATE TABLE saas_request_admission_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  supply_mode text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  delivery_state text NOT NULL DEFAULT 'pending',
  delivery_attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_expires_at timestamptz,
  last_error_code text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_request_admission_outbox_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES saas_tenants (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_request_admission_outbox_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_request_admission_outbox_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_request_admission_outbox_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_request_admission_outbox_event_key_nonempty
    CHECK (char_length(event_key) BETWEEN 1 AND 512 AND btrim(event_key) = event_key),
  CONSTRAINT saas_request_admission_outbox_event_key_unique
    UNIQUE (tenant_id, event_key),
  CONSTRAINT saas_request_admission_outbox_event_type_bounded
    CHECK (event_type = 'request.admitted' AND char_length(event_type) <= 64),
  CONSTRAINT saas_request_admission_outbox_schema_version_bounded
    CHECK (schema_version BETWEEN 1 AND 1000),
  CONSTRAINT saas_request_admission_outbox_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT saas_request_admission_outbox_payload_bounded
    CHECK (octet_length(payload::text) <= 4096),
  CONSTRAINT saas_request_admission_outbox_payload_metadata_only
    CHECK (
      payload ?& ARRAY[
        'tenant_id', 'project_id', 'request_id', 'attempt_id',
        'supply_mode', 'schema_version'
      ]
      AND (payload - ARRAY[
        'tenant_id', 'project_id', 'request_id', 'attempt_id',
        'supply_mode', 'schema_version'
      ]) = '{}'::jsonb
      AND jsonb_typeof(payload -> 'tenant_id') = 'string'
      AND jsonb_typeof(payload -> 'project_id') = 'string'
      AND jsonb_typeof(payload -> 'request_id') = 'string'
      AND jsonb_typeof(payload -> 'attempt_id') = 'string'
      AND jsonb_typeof(payload -> 'supply_mode') = 'string'
      AND jsonb_typeof(payload -> 'schema_version') = 'number'
      AND payload ->> 'tenant_id' = tenant_id::text
      AND payload ->> 'project_id' = project_id::text
      AND payload ->> 'request_id' = request_id::text
      AND payload ->> 'attempt_id' = attempt_id::text
      AND payload ->> 'schema_version' = schema_version::text
    ),
  CONSTRAINT saas_request_admission_outbox_supply_mode_check
    CHECK (
      supply_mode IN ('byok', 'platform')
      AND payload ->> 'supply_mode' = supply_mode
    ),
  CONSTRAINT saas_request_admission_outbox_delivery_state_check
    CHECK (delivery_state IN ('pending', 'leased', 'delivered', 'failed')),
  CONSTRAINT saas_request_admission_outbox_delivery_attempts_check
    CHECK (delivery_attempts BETWEEN 0 AND 2147483647),
  CONSTRAINT saas_request_admission_outbox_lease_shape_check
    CHECK (
      (delivery_state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (delivery_state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
  CONSTRAINT saas_request_admission_outbox_delivered_shape_check
    CHECK (
      (delivery_state = 'delivered' AND delivered_at IS NOT NULL)
      OR
      (delivery_state <> 'delivered' AND delivered_at IS NULL)
    ),
  CONSTRAINT saas_request_admission_outbox_lease_token_bounded
    CHECK (lease_token IS NULL OR (char_length(lease_token) BETWEEN 1 AND 255 AND btrim(lease_token) = lease_token)),
  CONSTRAINT saas_request_admission_outbox_last_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE INDEX saas_request_admission_outbox_claim_idx
  ON saas_request_admission_outbox (tenant_id, delivery_state, available_at, created_at, id)
  WHERE delivery_state IN ('pending', 'leased', 'failed');
CREATE INDEX saas_request_admission_outbox_lease_idx
  ON saas_request_admission_outbox (tenant_id, lease_expires_at)
  WHERE delivery_state = 'leased';
`;

export const REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION: SaasMigration = {
  version: 14,
  name: 'request_admission_metadata_outbox',
  sql: requestAdmissionOutboxSchemaSql,
};
