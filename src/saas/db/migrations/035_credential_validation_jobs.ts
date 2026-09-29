import type { SaasMigration } from './001_initial_schema.js';

const credentialValidationJobsSchemaSql = `
CREATE TABLE saas_tenant_provider_credential_validation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  account_id text NOT NULL,
  credential_id text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  credential_type text NOT NULL,
  allowed_models text[] NOT NULL,
  target_model text NOT NULL,
  target_endpoint text NOT NULL,
  capability_version integer NOT NULL CHECK (capability_version >= 1),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'verified', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_byok_only
    CHECK (tenant_id IS NOT NULL),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_models_shape
    CHECK (
      cardinality(allowed_models) BETWEEN 1 AND 256
      AND array_position(allowed_models, NULL) IS NULL
      AND target_model = ANY (allowed_models)
      AND target_model <> ''
      AND target_model = btrim(target_model)
    ),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_endpoint_shape
    CHECK (
      target_endpoint <> ''
      AND target_endpoint = btrim(target_endpoint)
      AND position('://' in target_endpoint) = 0
      AND left(target_endpoint, 1) <> '/'
      AND position('?' in target_endpoint) = 0
      AND position('#' in target_endpoint) = 0
    ),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_idempotency_shape
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_lease_shape
    CHECK ((status = 'leased') = (lease_until IS NOT NULL)),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_error_shape
    CHECK (
      last_error_code IS NULL
      OR (char_length(last_error_code) <= 128 AND last_error_code <> '' AND last_error_code = btrim(last_error_code))
    ),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_completion_shape
    CHECK ((status IN ('verified', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_account_fk
    FOREIGN KEY (tenant_id, account_id, provider_id, product_id)
    REFERENCES saas_tenant_provider_accounts (tenant_id, id, provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_credential_fk
    FOREIGN KEY (tenant_id, credential_id, account_id)
    REFERENCES saas_tenant_provider_credentials (tenant_id, id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_version_fk
    FOREIGN KEY (tenant_id, credential_id, credential_version)
    REFERENCES saas_tenant_provider_credential_versions (tenant_id, credential_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_identity_unique
    UNIQUE (tenant_id, credential_id, credential_version),
  CONSTRAINT saas_tenant_provider_credential_validation_jobs_idempotency_unique
    UNIQUE (idempotency_key)
);

CREATE INDEX saas_tenant_provider_credential_validation_jobs_claim_idx
  ON saas_tenant_provider_credential_validation_jobs (available_at, created_at, id)
  WHERE status IN ('queued', 'leased');

CREATE FUNCTION saas_credential_validation_job_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.credential_version IS DISTINCT FROM OLD.credential_version
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.credential_type IS DISTINCT FROM OLD.credential_type
    OR NEW.allowed_models IS DISTINCT FROM OLD.allowed_models
    OR NEW.target_model IS DISTINCT FROM OLD.target_model
    OR NEW.target_endpoint IS DISTINCT FROM OLD.target_endpoint
    OR NEW.capability_version IS DISTINCT FROM OLD.capability_version
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider credential validation job authority snapshot is immutable'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_provider_credential_validation_jobs_identity_immutable
  BEFORE UPDATE ON saas_tenant_provider_credential_validation_jobs
  FOR EACH ROW EXECUTE FUNCTION saas_credential_validation_job_identity_immutable();

CREATE FUNCTION saas_invalidate_credential_validation_jobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE saas_tenant_provider_credential_validation_jobs
     SET status = 'cancelled',
         lease_until = NULL,
         lease_generation = lease_generation + 1,
         last_error_code = 'credential_changed',
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE tenant_id = NEW.tenant_id
     AND credential_id = NEW.id
     AND status IN ('queued', 'leased')
     AND (
       NEW.current_version IS DISTINCT FROM OLD.current_version
       OR (NEW.status IN ('disabled', 'revoked') AND NEW.status IS DISTINCT FROM OLD.status)
     );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_provider_credentials_invalidate_validation_jobs
  AFTER UPDATE OF current_version, status ON saas_tenant_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION saas_invalidate_credential_validation_jobs();

CREATE FUNCTION saas_invalidate_account_credential_validation_jobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('disabled', 'revoked') AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE saas_tenant_provider_credential_validation_jobs
       SET status = 'cancelled',
           lease_until = NULL,
           lease_generation = lease_generation + 1,
           last_error_code = 'account_changed',
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE tenant_id = NEW.tenant_id
       AND account_id = NEW.id
       AND status IN ('queued', 'leased');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_tenant_provider_accounts_invalidate_validation_jobs
  AFTER UPDATE OF status ON saas_tenant_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_invalidate_account_credential_validation_jobs();

CREATE FUNCTION saas_provider_credential_validation_job_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider credential validation jobs cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER saas_tenant_provider_credential_validation_jobs_no_delete
  BEFORE DELETE ON saas_tenant_provider_credential_validation_jobs
  FOR EACH ROW EXECUTE FUNCTION saas_provider_credential_validation_job_reject_delete();
`;

export const CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION: SaasMigration = {
  version: 35,
  name: 'credential_validation_jobs',
  sql: credentialValidationJobsSchemaSql,
};
