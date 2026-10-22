import type { SaasMigration } from './001_initial_schema.js';

function provenanceConstraint(table: string, constraint: string, evidence: boolean): string {
  const openaiOperation = evidence ? "= 'chat.completions'" : "IN ('chat.completions', 'embeddings')";
  return `
ALTER TABLE ${table}
  DROP CONSTRAINT ${constraint},
  ADD CONSTRAINT ${constraint} CHECK ((
    (
      provider_protocol IS NULL
      AND client_operation IS NULL
      AND provider_operation IS NULL
      AND request_fingerprint IS NULL
      AND request_fingerprint_version IS NULL
      AND payload_compiler_version IS NULL
      AND usage_estimator_version IS NULL
      ${evidence ? '' : 'AND payload_sha256 IS NULL'}
    ) OR (
      provider_protocol IN ('anthropic', 'openai', 'gemini', 'responses')
      AND (
        (protocol = 'anthropic' AND client_operation = 'messages')
        OR (protocol = 'openai' AND client_operation ${openaiOperation})
        OR (protocol = 'gemini' AND client_operation = 'generateContent')
        OR (protocol = 'responses' AND client_operation IN ('responses', 'responses.compact'))
      )
      AND (
        (provider_protocol = 'anthropic' AND provider_operation = 'messages')
        OR (provider_protocol = 'openai' AND provider_operation ${openaiOperation})
        OR (provider_protocol = 'gemini' AND provider_operation = 'generateContent')
        OR (provider_protocol = 'responses' AND provider_operation IN ('responses', 'responses.compact'))
      )
      AND (
        (client_operation <> 'responses.compact' AND provider_operation <> 'responses.compact')
        OR (protocol = 'responses' AND provider_protocol = 'responses'
          AND client_operation = 'responses.compact' AND provider_operation = 'responses.compact')
      )
      AND btrim(request_fingerprint) <> ''
      AND btrim(request_fingerprint_version) <> ''
      AND btrim(payload_compiler_version) <> ''
      AND btrim(usage_estimator_version) <> ''
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      ${evidence ? '' : "AND payload_sha256 ~ '^[0-9a-f]{64}$'"}
    )
  ) IS TRUE);
`;
}

/** A native compact request is a distinct signed operation, never a bridge. */
export const RESPONSES_COMPACT_OPERATION_SAAS_MIGRATION: SaasMigration = {
  version: 134,
  name: 'responses_compact_operation',
  sql:
    provenanceConstraint('saas_attempts', 'saas_attempts_provider_payload_provenance_shape', false) +
    provenanceConstraint(
      'saas_prepared_request_evidence',
      'saas_prepared_request_evidence_provider_payload_provenance_shape',
      true,
    ),
};
