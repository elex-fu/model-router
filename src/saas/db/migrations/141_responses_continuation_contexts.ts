import type { SaasMigration } from './001_initial_schema.js';

export const RESPONSES_CONTINUATION_CONTEXTS_SAAS_MIGRATION: SaasMigration = {
  version: 141,
  name: 'responses_continuation_contexts',
  sql: `
CREATE TABLE saas_responses_continuation_contexts (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  proxy_key_id uuid NOT NULL,
  conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 512),
  response_id text NOT NULL CHECK(length(response_id) BETWEEN 1 AND 512),
  provider_id text NOT NULL CHECK(length(provider_id)>0),
  product_id text NOT NULL CHECK(length(product_id)>0),
  account_id text NOT NULL CHECK(length(account_id)>0),
  credential_id text NOT NULL CHECK(length(credential_id)>0),
  credential_version bigint NOT NULL CHECK(credential_version>0),
  credential_authz_version bigint NOT NULL CHECK(credential_authz_version>0),
  public_model text NOT NULL CHECK(length(public_model)>0),
  resolved_model text NOT NULL CHECK(length(resolved_model)>0),
  canonical_context_digest text NOT NULL CHECK(canonical_context_digest ~ '^[0-9a-f]{64}$'),
  encryption_key_id text NOT NULL CHECK(length(encryption_key_id)>0),
  encrypted_context bytea NOT NULL CHECK(octet_length(encrypted_context)>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
  PRIMARY KEY(tenant_id,proxy_key_id,conversation_id,response_id),
  FOREIGN KEY(tenant_id,project_id,proxy_key_id) REFERENCES saas_api_keys(tenant_id,project_id,id) ON DELETE CASCADE
);
CREATE INDEX saas_responses_continuation_contexts_expiry_idx ON saas_responses_continuation_contexts(expires_at);
CREATE TRIGGER saas_responses_continuation_contexts_immutable BEFORE UPDATE ON saas_responses_continuation_contexts
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
`,
};
