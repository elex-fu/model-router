import type { SaasMigration } from './001_initial_schema.js';

/**
 * Versioned IP policy head per API key (contract C-4 / Track A KEY-IP). One row
 * per key holds the current policy revision; replacement is a CAS on the head
 * version performed by the key service under the existing authorization fences
 * (expectedVersion -> version + 1, atomically bumping saas_api_keys.authz_version
 * so cached key authorization is invalidated). Historical rows are not kept:
 * the audit trail carries every replacement.
 *
 * Every existing key is backfilled with a disabled v1 policy so the CAS
 * expectedVersion always starts at '1' (the frozen version parser rejects '0').
 */
const apiKeyIpPoliciesSql = `
ALTER TABLE saas_api_keys
  ADD CONSTRAINT saas_api_keys_scoped_id_unique UNIQUE (tenant_id, project_id, id);

CREATE TABLE saas_api_key_ip_policies (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  key_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  mode text NOT NULL
    CHECK (mode IN ('disabled', 'allowlist', 'denyall')),
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_api_key_ip_policies_pk PRIMARY KEY (tenant_id, project_id, key_id),
  CONSTRAINT saas_api_key_ip_policies_key_fk
    FOREIGN KEY (tenant_id, project_id, key_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_key_ip_policies_rules_array CHECK (
    jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 256
  ),
  CONSTRAINT saas_api_key_ip_policies_mode_rules CHECK (
    (mode IN ('disabled', 'denyall') AND rules = '[]'::jsonb)
    OR (mode = 'allowlist' AND jsonb_array_length(rules) >= 1)
  )
);

INSERT INTO saas_api_key_ip_policies (tenant_id, project_id, key_id, version, mode, rules)
SELECT tenant_id, project_id, id, 1, 'disabled', '[]'::jsonb
FROM saas_api_keys;
`;

export const API_KEY_IP_POLICIES_SAAS_MIGRATION: SaasMigration = {
  version: 80,
  name: 'api_key_ip_policies',
  sql: apiKeyIpPoliciesSql,
};
