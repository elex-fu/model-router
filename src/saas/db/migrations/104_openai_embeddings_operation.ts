import type { SaasMigration } from './001_initial_schema.js';

/**
 * R2 embeddings endpoint (design: docs/token-resale-implementation-plan-2026-10-15.md
 * R2). The embeddings operation rides the OpenAI protocol family
 * (client protocol 'openai', provider protocol 'openai', operation
 * 'embeddings'), so migration 029's provenance-shape CHECK must accept the
 * additional (openai, embeddings) protocol/operation pairs on both the
 * client and the provider side. Every other pair stays exactly as narrow as
 * before; no protocol values or columns are added. Existing rows satisfy the
 * widened CHECK by construction, so the transactional DROP+ADD pair
 * (migration 063/097's pattern) is a metadata-only change.
 */
const openaiEmbeddingsOperationSql = `
ALTER TABLE saas_attempts
  DROP CONSTRAINT saas_attempts_provider_payload_provenance_shape,
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
        OR (protocol = 'openai' AND client_operation IN ('chat.completions', 'embeddings'))
        OR (protocol = 'gemini' AND client_operation = 'generateContent')
        OR (protocol = 'responses' AND client_operation = 'responses')
      )
      AND (
        (provider_protocol = 'anthropic' AND provider_operation = 'messages')
        OR (provider_protocol = 'openai' AND provider_operation IN ('chat.completions', 'embeddings'))
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
`;

export const OPENAI_EMBEDDINGS_OPERATION_SAAS_MIGRATION: SaasMigration = {
  version: 104,
  name: 'openai_embeddings_operation',
  sql: openaiEmbeddingsOperationSql,
};
