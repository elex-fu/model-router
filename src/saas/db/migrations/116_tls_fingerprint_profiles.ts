import type { SaasMigration } from './001_initial_schema.js';

/**
 * Batch-2 §2.4 TLS fingerprint profiles (roadmap
 * docs/capability-parity-roadmap-2026-10-16.md §2.4, task #7): the
 * ClientHello profile registry plus the per-account binding column that
 * selects the egress fingerprint mode.
 *
 * Dormant-column adjudication (roadmap 前置决策 2, resolved for this task):
 * 099's codex_fingerprint_mode/seed columns are the APPLICATION-LAYER
 * Codex device/session-id fingerprint (sub2api
 * openai_codex_fingerprint.go's device/session/full convergence strength)
 * and stay dormant and untouched. The new tls_fingerprint_profile_id column
 * is the TRANSPORT-LAYER ClientHello fingerprint selection. The two
 * mechanisms are orthogonal and coexist: no column of one ever gates the
 * other. The account-level on/off switch for TLS fingerprinting is carried
 * by tls_fingerprint_profile_id itself (NULL = off) rather than reusing
 * 099's Codex-shaped mode values, which would have mangled two unrelated
 * semantics into one column.
 *
 * Account column semantics (sub2api account Extra keys
 * enable_tls_fingerprint / tls_fingerprint_profile_id, folded into one
 * tri-state column):
 * - NULL → fingerprint off (default; exact pre-116 behavior);
 * - 0    → the sidecar's built-in Node.js 24.x default profile
 *          (JA3 44f88fca027f27bab4bb08d4af15f23e);
 * - -1   → per-connection randomized ClientHello;
 * - >0   → the specific saas_tls_fingerprint_profiles row.
 *
 * A CHECK (not an FK) pins the tri-state shape because 0/-1 are sentinel
 * bindings that reference no row; referential integrity for >0 bindings is
 * application-level (the resolver fails OPEN to the default profile when a
 * bound row is missing — a fingerprint miss degrades mimicry but never
 * changes the account's exit IP, unlike an egress proxy).
 *
 * The profile JSONB columns mirror sub2api's tls_fingerprint_profiles table
 * one-to-one (cipher_suites/curves/point_formats/signature_algorithms/
 * alpn_protocols/supported_versions/key_share_groups/psk_modes/extensions
 * order tables + enable_grease), each validated as a bounded array of
 * 0..65535 integers (or bounded strings for alpn) so a rogue writer cannot
 * smuggle unbounded payloads onto the dial path (the sidecar re-validates
 * every list at ≤64 entries before dialing).
 *
 * Numbered 116: 115 is reserved for the parallel batch-2 sticky/5h-window
 * workstream registering its tail concurrently (the documented parallel-tail
 * pattern of the fail-closed serial ordering rule); 116 is the next free
 * slot after the applied 114 head.
 */
const tlsFingerprintProfilesSql = `
CREATE TABLE saas_tls_fingerprint_profiles (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,
  description text,
  enable_grease boolean NOT NULL DEFAULT false,
  cipher_suites jsonb NOT NULL DEFAULT '[]'::jsonb,
  curves jsonb NOT NULL DEFAULT '[]'::jsonb,
  point_formats jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature_algorithms jsonb NOT NULL DEFAULT '[]'::jsonb,
  alpn_protocols jsonb NOT NULL DEFAULT '[]'::jsonb,
  supported_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_share_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  psk_modes jsonb NOT NULL DEFAULT '[]'::jsonb,
  extensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_tls_fingerprint_profiles_name_unique UNIQUE (name),
  CONSTRAINT saas_tls_fingerprint_profiles_name_shape
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 128 AND name = btrim(name)),
  CONSTRAINT saas_tls_fingerprint_profiles_description_shape
    CHECK (description IS NULL OR (char_length(btrim(description)) <= 512 AND description = btrim(description))),
  CONSTRAINT saas_tls_fingerprint_profiles_cipher_suites_shape
    CHECK (
      jsonb_typeof(cipher_suites) = 'array'
      AND jsonb_array_length(cipher_suites) <= 64
      AND jsonb_path_query_array(cipher_suites, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_curves_shape
    CHECK (
      jsonb_typeof(curves) = 'array'
      AND jsonb_array_length(curves) <= 64
      AND jsonb_path_query_array(curves, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_point_formats_shape
    CHECK (
      jsonb_typeof(point_formats) = 'array'
      AND jsonb_array_length(point_formats) <= 64
      AND jsonb_path_query_array(point_formats, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_signature_algorithms_shape
    CHECK (
      jsonb_typeof(signature_algorithms) = 'array'
      AND jsonb_array_length(signature_algorithms) <= 64
      AND jsonb_path_query_array(signature_algorithms, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_alpn_protocols_shape
    CHECK (
      jsonb_typeof(alpn_protocols) = 'array'
      AND jsonb_array_length(alpn_protocols) <= 8
      AND jsonb_path_query_array(alpn_protocols, '$[*] ? (@.type() != "string")') = '[]'::jsonb
      -- PG jsonpath has no string-length method (no .length()); the per-entry
      -- 255-byte ALPN wire-format bound is enforced by the bounded serialized
      -- size below plus the reader (tls-fingerprint-profile-lookup.ts) and
      -- re-validated in the sidecar before dialing.
      AND octet_length(alpn_protocols::text) <= 2048
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_supported_versions_shape
    CHECK (
      jsonb_typeof(supported_versions) = 'array'
      AND jsonb_array_length(supported_versions) <= 8
      AND jsonb_path_query_array(supported_versions, '$[*] ? (@ < 769 || @ > 772 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_key_share_groups_shape
    CHECK (
      jsonb_typeof(key_share_groups) = 'array'
      AND jsonb_array_length(key_share_groups) <= 8
      AND jsonb_path_query_array(key_share_groups, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_psk_modes_shape
    CHECK (
      jsonb_typeof(psk_modes) = 'array'
      AND jsonb_array_length(psk_modes) <= 8
      AND jsonb_path_query_array(psk_modes, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    ),
  CONSTRAINT saas_tls_fingerprint_profiles_extensions_shape
    CHECK (
      jsonb_typeof(extensions) = 'array'
      AND jsonb_array_length(extensions) <= 64
      AND jsonb_path_query_array(extensions, '$[*] ? (@ < 0 || @ > 65535 || @.type() != "number")') = '[]'::jsonb
    )
);

ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN tls_fingerprint_profile_id integer,
  ADD CONSTRAINT saas_tenant_provider_accounts_tls_fingerprint_profile_id_shape
    CHECK (tls_fingerprint_profile_id IS NULL OR tls_fingerprint_profile_id >= -1);

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN tls_fingerprint_profile_id integer,
  ADD CONSTRAINT saas_platform_provider_accounts_tls_fingerprint_profile_id_shape
    CHECK (tls_fingerprint_profile_id IS NULL OR tls_fingerprint_profile_id >= -1);
`;

export const TLS_FINGERPRINT_PROFILES_SAAS_MIGRATION: SaasMigration = {
  version: 116,
  name: 'tls_fingerprint_profiles',
  sql: tlsFingerprintProfilesSql,
};
