import type { SaasMigration } from './001_initial_schema.js';

/*
 * Model resolution is a compiler/transport fact, not an authorization or
 * billing decision.  The request's public_model and the attempt's
 * resolved_model remain the existing authority/billing snapshots.  These
 * nullable columns only preserve the server-owned chain that produced them,
 * together with the client/provider operation pair, payload compiler and
 * estimator versions, and fingerprint association used by the signed
 * prepared-evidence statement.
 *
 * Existing requests/attempts/evidence are deliberately not backfilled.  A
 * newly inserted bound attempt and every newly inserted prepared-evidence row
 * must carry the complete snapshot, while historical rows may retain NULLs.
 * The evidence trigger binds the duplicated snapshot to the request and
 * attempt; the immutability triggers prevent either side from being changed
 * after it has been persisted.
 */
const modelResolutionProvenanceSql = `
ALTER TABLE saas_attempts
  ADD COLUMN model_resolution_requested_model text,
  ADD COLUMN model_resolution_mapped_model text,
  ADD COLUMN model_resolution_mapping_source text
    CHECK (model_resolution_mapping_source IS NULL
      OR model_resolution_mapping_source IN ('none', 'alias', 'wildcard')),
  ADD COLUMN model_resolution_mapping_version bigint
    CHECK (model_resolution_mapping_version IS NULL OR model_resolution_mapping_version >= 1),
  ADD COLUMN provider_protocol text
    CHECK (provider_protocol IS NULL OR provider_protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  ADD COLUMN client_operation text,
  ADD COLUMN provider_operation text,
  ADD COLUMN request_fingerprint text
    CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN request_fingerprint_version text,
  ADD COLUMN payload_compiler_version text,
  ADD COLUMN usage_estimator_version text,
  ADD COLUMN payload_sha256 text
    CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT saas_attempts_model_resolution_provenance_shape CHECK ((
    (
      model_resolution_requested_model IS NULL
      AND model_resolution_mapped_model IS NULL
      AND model_resolution_mapping_source IS NULL
      AND model_resolution_mapping_version IS NULL
    )
    OR
    (
      btrim(model_resolution_requested_model) <> ''
      AND btrim(model_resolution_mapped_model) <> ''
      AND model_resolution_mapping_source IN ('none', 'alias', 'wildcard')
      AND (
        (
          model_resolution_mapping_source = 'none'
          AND model_resolution_mapped_model = model_resolution_requested_model
          AND model_resolution_mapping_version IS NULL
          AND resolved_model = model_resolution_requested_model
        )
        OR
        (
          model_resolution_mapping_source IN ('alias', 'wildcard')
          AND model_resolution_mapping_version IS NOT NULL
          AND model_resolution_mapping_version >= 1
        )
      )
    )
  ) IS TRUE),
  ADD CONSTRAINT saas_attempts_provider_payload_provenance_shape CHECK ((
    (
      provider_protocol IS NULL
      AND client_operation IS NULL
      AND provider_operation IS NULL
      AND request_fingerprint IS NULL
      AND request_fingerprint_version IS NULL
      AND payload_compiler_version IS NULL
      AND usage_estimator_version IS NULL
      AND payload_sha256 IS NULL
    )
    OR
    (
      provider_protocol IN ('anthropic', 'openai', 'gemini', 'responses')
      AND (
        (protocol = 'anthropic' AND client_operation = 'messages')
        OR (protocol = 'openai' AND client_operation = 'chat.completions')
        OR (protocol = 'gemini' AND client_operation = 'generateContent')
        OR (protocol = 'responses' AND client_operation = 'responses')
      )
      AND (
        (provider_protocol = 'anthropic' AND provider_operation = 'messages')
        OR (provider_protocol = 'openai' AND provider_operation = 'chat.completions')
        OR (provider_protocol = 'gemini' AND provider_operation = 'generateContent')
        OR (provider_protocol = 'responses' AND provider_operation = 'responses')
      )
      AND btrim(request_fingerprint) <> ''
      AND btrim(request_fingerprint_version) <> ''
      AND btrim(payload_compiler_version) <> ''
      AND btrim(usage_estimator_version) <> ''
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
    )
  ) IS TRUE);

ALTER TABLE saas_prepared_request_evidence
  ADD COLUMN model_resolution_requested_model text,
  ADD COLUMN model_resolution_mapped_model text,
  ADD COLUMN model_resolution_mapping_source text
    CHECK (model_resolution_mapping_source IS NULL
      OR model_resolution_mapping_source IN ('none', 'alias', 'wildcard')),
  ADD COLUMN model_resolution_mapping_version bigint
    CHECK (model_resolution_mapping_version IS NULL OR model_resolution_mapping_version >= 1),
  ADD COLUMN provider_protocol text
    CHECK (provider_protocol IS NULL OR provider_protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  ADD COLUMN client_operation text,
  ADD COLUMN provider_operation text,
  ADD COLUMN request_fingerprint text
    CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN request_fingerprint_version text,
  ADD COLUMN payload_compiler_version text,
  ADD COLUMN usage_estimator_version text,
  ADD CONSTRAINT saas_prepared_request_evidence_model_resolution_provenance_shape CHECK ((
    (
      model_resolution_requested_model IS NULL
      AND model_resolution_mapped_model IS NULL
      AND model_resolution_mapping_source IS NULL
      AND model_resolution_mapping_version IS NULL
    )
    OR
    (
      btrim(model_resolution_requested_model) <> ''
      AND btrim(model_resolution_mapped_model) <> ''
      AND model_resolution_mapping_source IN ('none', 'alias', 'wildcard')
      AND (
        (
          model_resolution_mapping_source = 'none'
          AND model_resolution_mapped_model = model_resolution_requested_model
          AND model_resolution_mapping_version IS NULL
          AND resolved_model = model_resolution_requested_model
        )
        OR
        (
          model_resolution_mapping_source IN ('alias', 'wildcard')
          AND model_resolution_mapping_version IS NOT NULL
          AND model_resolution_mapping_version >= 1
        )
      )
    )
  ) IS TRUE),
  ADD CONSTRAINT saas_prepared_request_evidence_provider_payload_provenance_shape CHECK ((
    (
      provider_protocol IS NULL
      AND client_operation IS NULL
      AND provider_operation IS NULL
      AND request_fingerprint IS NULL
      AND request_fingerprint_version IS NULL
      AND payload_compiler_version IS NULL
      AND usage_estimator_version IS NULL
    )
    OR
    (
      provider_protocol IN ('anthropic', 'openai', 'gemini', 'responses')
      AND (
        (protocol = 'anthropic' AND client_operation = 'messages')
        OR (protocol = 'openai' AND client_operation = 'chat.completions')
        OR (protocol = 'gemini' AND client_operation = 'generateContent')
        OR (protocol = 'responses' AND client_operation = 'responses')
      )
      AND (
        (provider_protocol = 'anthropic' AND provider_operation = 'messages')
        OR (provider_protocol = 'openai' AND provider_operation = 'chat.completions')
        OR (provider_protocol = 'gemini' AND provider_operation = 'generateContent')
        OR (provider_protocol = 'responses' AND provider_operation = 'responses')
      )
      AND btrim(request_fingerprint) <> ''
      AND btrim(request_fingerprint_version) <> ''
      AND btrim(payload_compiler_version) <> ''
      AND btrim(usage_estimator_version) <> ''
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
    )
  ) IS TRUE);

/* A new bound attempt must carry the complete compiler snapshot. */
CREATE FUNCTION saas_attempts_guard_model_resolution_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.model_resolution_requested_model IS DISTINCT FROM NEW.model_resolution_requested_model
      OR OLD.model_resolution_mapped_model IS DISTINCT FROM NEW.model_resolution_mapped_model
      OR OLD.model_resolution_mapping_source IS DISTINCT FROM NEW.model_resolution_mapping_source
      OR OLD.model_resolution_mapping_version IS DISTINCT FROM NEW.model_resolution_mapping_version
      OR OLD.provider_protocol IS DISTINCT FROM NEW.provider_protocol
      OR OLD.client_operation IS DISTINCT FROM NEW.client_operation
      OR OLD.provider_operation IS DISTINCT FROM NEW.provider_operation
      OR OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
      OR OLD.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
      OR OLD.payload_compiler_version IS DISTINCT FROM NEW.payload_compiler_version
      OR OLD.usage_estimator_version IS DISTINCT FROM NEW.usage_estimator_version
      OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
    THEN
      RAISE EXCEPTION 'SaaS attempt model-resolution provenance is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.dispatch_authority_state = 'unbound' THEN
    IF NEW.model_resolution_requested_model IS NOT NULL
      OR NEW.model_resolution_mapped_model IS NOT NULL
      OR NEW.model_resolution_mapping_source IS NOT NULL
      OR NEW.model_resolution_mapping_version IS NOT NULL
      OR NEW.provider_protocol IS NOT NULL
      OR NEW.client_operation IS NOT NULL
      OR NEW.provider_operation IS NOT NULL
      OR NEW.request_fingerprint IS NOT NULL
      OR NEW.request_fingerprint_version IS NOT NULL
      OR NEW.payload_compiler_version IS NOT NULL
      OR NEW.usage_estimator_version IS NOT NULL
      OR NEW.payload_sha256 IS NOT NULL
    THEN
      RAISE EXCEPTION 'Unbound SaaS attempts cannot carry model-resolution provenance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.dispatch_authority_state IS DISTINCT FROM 'bound'
    OR NEW.model_resolution_requested_model IS NULL
    OR NEW.model_resolution_mapped_model IS NULL
    OR NEW.model_resolution_mapping_source IS NULL
    OR NEW.provider_protocol IS NULL
    OR NEW.client_operation IS NULL
    OR NEW.provider_operation IS NULL
    OR NEW.request_fingerprint IS NULL
    OR NEW.request_fingerprint_version IS NULL
    OR NEW.payload_compiler_version IS NULL
    OR NEW.usage_estimator_version IS NULL
    OR NEW.payload_sha256 IS NULL
  THEN
    RAISE EXCEPTION 'New bound SaaS attempts require complete model-resolution provenance'
      USING ERRCODE = '23514';
  END IF;

  SELECT public_model, request_fingerprint, request_fingerprint_version
    INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.request_id
   FOR SHARE;
  IF NOT FOUND
    OR request_record.public_model IS DISTINCT FROM NEW.model_resolution_requested_model
    OR request_record.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
    OR request_record.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
  THEN
    RAISE EXCEPTION 'SaaS attempt model-resolution provenance does not match its request'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_model_resolution_provenance
  BEFORE INSERT OR UPDATE OF model_resolution_requested_model, model_resolution_mapped_model,
    model_resolution_mapping_source, model_resolution_mapping_version, provider_protocol, client_operation,
    provider_operation, request_fingerprint, request_fingerprint_version, payload_compiler_version,
    usage_estimator_version, payload_sha256
  ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_model_resolution_provenance();

/* New evidence must duplicate and bind the complete signed compiler snapshot. */
CREATE FUNCTION saas_prepared_request_evidence_guard_model_resolution_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  attempt_record record;
BEGIN
  IF NEW.model_resolution_requested_model IS NULL
    OR NEW.model_resolution_mapped_model IS NULL
    OR NEW.model_resolution_mapping_source IS NULL
    OR NEW.provider_protocol IS NULL
    OR NEW.client_operation IS NULL
    OR NEW.provider_operation IS NULL
    OR NEW.request_fingerprint IS NULL
    OR NEW.request_fingerprint_version IS NULL
    OR NEW.payload_compiler_version IS NULL
    OR NEW.usage_estimator_version IS NULL
  THEN
    RAISE EXCEPTION 'New prepared-request evidence requires complete model-resolution provenance'
      USING ERRCODE = '23514';
  END IF;

  SELECT public_model, protocol, request_fingerprint, request_fingerprint_version
    INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.request_id
   FOR SHARE;
  SELECT request_id, ordinal, resolved_model, protocol, provider_protocol, client_operation, provider_operation,
         model_resolution_requested_model, model_resolution_mapped_model,
         model_resolution_mapping_source, model_resolution_mapping_version,
         request_fingerprint, request_fingerprint_version, payload_compiler_version,
         usage_estimator_version, payload_sha256
    INTO attempt_record
    FROM saas_attempts
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.attempt_id
   FOR SHARE;

  IF NOT FOUND
    OR request_record.public_model IS DISTINCT FROM NEW.model_resolution_requested_model
    OR request_record.protocol IS DISTINCT FROM NEW.protocol
    OR request_record.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
    OR request_record.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
    OR attempt_record.request_id IS DISTINCT FROM NEW.request_id
    OR attempt_record.ordinal IS DISTINCT FROM NEW.attempt_ordinal
    OR attempt_record.resolved_model IS DISTINCT FROM NEW.resolved_model
    OR attempt_record.protocol IS DISTINCT FROM NEW.protocol
    OR attempt_record.provider_protocol IS DISTINCT FROM NEW.provider_protocol
    OR attempt_record.client_operation IS DISTINCT FROM NEW.client_operation
    OR attempt_record.provider_operation IS DISTINCT FROM NEW.provider_operation
    OR attempt_record.model_resolution_requested_model IS DISTINCT FROM NEW.model_resolution_requested_model
    OR attempt_record.model_resolution_mapped_model IS DISTINCT FROM NEW.model_resolution_mapped_model
    OR attempt_record.model_resolution_mapping_source IS DISTINCT FROM NEW.model_resolution_mapping_source
    OR attempt_record.model_resolution_mapping_version IS DISTINCT FROM NEW.model_resolution_mapping_version
    OR attempt_record.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
    OR attempt_record.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
    OR attempt_record.payload_compiler_version IS DISTINCT FROM NEW.payload_compiler_version
    OR attempt_record.usage_estimator_version IS DISTINCT FROM NEW.usage_estimator_version
    OR attempt_record.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
  THEN
    RAISE EXCEPTION 'Prepared-request evidence model-resolution provenance does not match request and attempt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_prepared_request_evidence_guard_model_resolution_provenance
  BEFORE INSERT ON saas_prepared_request_evidence
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_request_evidence_guard_model_resolution_provenance();

/* The signed evidence snapshot cannot be edited after registration. */
CREATE FUNCTION saas_prepared_request_evidence_model_resolution_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      OLD.model_resolution_requested_model IS DISTINCT FROM NEW.model_resolution_requested_model
      OR OLD.model_resolution_mapped_model IS DISTINCT FROM NEW.model_resolution_mapped_model
      OR OLD.model_resolution_mapping_source IS DISTINCT FROM NEW.model_resolution_mapping_source
      OR OLD.model_resolution_mapping_version IS DISTINCT FROM NEW.model_resolution_mapping_version
      OR OLD.provider_protocol IS DISTINCT FROM NEW.provider_protocol
      OR OLD.client_operation IS DISTINCT FROM NEW.client_operation
      OR OLD.provider_operation IS DISTINCT FROM NEW.provider_operation
      OR OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
      OR OLD.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
      OR OLD.payload_compiler_version IS DISTINCT FROM NEW.payload_compiler_version
      OR OLD.usage_estimator_version IS DISTINCT FROM NEW.usage_estimator_version
    )
  THEN
    RAISE EXCEPTION 'Prepared-request evidence model-resolution provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_prepared_request_evidence_model_resolution_immutable
  BEFORE UPDATE OF model_resolution_requested_model, model_resolution_mapped_model,
    model_resolution_mapping_source, model_resolution_mapping_version, provider_protocol, client_operation,
    provider_operation, request_fingerprint, request_fingerprint_version, payload_compiler_version,
    usage_estimator_version
  ON saas_prepared_request_evidence
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_request_evidence_model_resolution_immutable();
`;

export const MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION: SaasMigration = {
  version: 29,
  name: 'model_resolution_provenance',
  sql: modelResolutionProvenanceSql,
};
