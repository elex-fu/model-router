import type { SaasMigration } from './001_initial_schema.js';

/** Append-only operator evidence; never edits an original intent or receipt. */
export const FAST_GATEWAY_RESOLUTION_SAAS_MIGRATION: SaasMigration = {
  version: 144,
  name: 'fast_gateway_audited_outcome_resolution',
  sql: `
CREATE TABLE saas_fast_gateway_resolutions (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('verified_usage','non_execution')),
  actor_user_id uuid NOT NULL REFERENCES saas_users(id),
  actor_session_id uuid NOT NULL REFERENCES saas_platform_sessions(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  charge_minor_units bigint NOT NULL CHECK (charge_minor_units >= 0),
  usage jsonb NOT NULL CHECK (jsonb_typeof(usage)='object'),
  usage_digest text NOT NULL CHECK (usage_digest ~ '^[0-9a-f]{64}$'),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 512),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  support_ticket_ref text NOT NULL CHECK (length(btrim(support_ticket_ref)) BETWEEN 1 AND 255),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (intent_id,tenant_id,request_id) REFERENCES saas_fast_gateway_intents(id,tenant_id,request_id),
  UNIQUE (tenant_id,idempotency_key),
  CHECK (kind <> 'non_execution' OR (charge_minor_units=0 AND usage='{}'::jsonb))
);
CREATE INDEX saas_fast_gateway_resolutions_tenant_time ON saas_fast_gateway_resolutions(tenant_id,created_at DESC);
CREATE TRIGGER saas_fast_resolutions_immutable BEFORE UPDATE OR DELETE ON saas_fast_gateway_resolutions
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_resolutions_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
-- A crash can leave an intent without a receipt. Its audited resolution must
-- enter the same durable worker without fabricating or modifying that receipt.
ALTER TABLE saas_fast_billing_jobs DROP CONSTRAINT saas_fast_billing_jobs_intent_id_fkey;
ALTER TABLE saas_fast_billing_jobs ADD CONSTRAINT saas_fast_billing_jobs_intent_id_fkey
  FOREIGN KEY (intent_id) REFERENCES saas_fast_gateway_intents(id);
`,
};
