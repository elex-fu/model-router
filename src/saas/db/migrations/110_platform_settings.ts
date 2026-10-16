import type { SaasMigration } from './001_initial_schema.js';

/**
 * F1 platform settings store (task #34): the platform-owned mutable runtime
 * configuration surface that R4 registration admission and R1 billing-groups
 * topup discounts previously worked around with env-only values and reserved
 * key constants.
 *
 * Numbered 110: the applied head at landing time is 109 (R6a probe monitors);
 * 111 is being registered concurrently by the Gemini OAuth workstream
 * (fail-closed serial ordering — lower numbers can never be applied on top
 * of an applied head, so both tails are valid next applications).
 *
 * Design notes:
 * - One row per settings key (the saas_platform_state singleton precedent:
 *   platform-owned, PG-authoritative). `version` is the optimistic
 *   concurrency token (the authz_version CAS pattern): every admin mutation
 *   runs UPDATE ... WHERE key = $1 AND version = $expected RETURNING version,
 *   so concurrent admin writes fail closed with VERSION_CONFLICT instead of
 *   silently last-write-winning. Lookups are exact-key (the primary key is
 *   the live index; no secondary index is needed for the admin list scan on
 *   a table bounded by the registered key set).
 * - `value` is always a jsonb object. Plain (non-secret) settings keys carry
 *   the uniform envelope {"value": <jsonb>}; secret-suffixed keys
 *   (*.secret, *.password) must carry the same KMS sealed envelope object
 *   used for provider credentials (sealProviderCredential output — the
 *   saas_egress_proxies.auth_sealed_envelope precedent). There is no
 *   plaintext secret column anywhere, and the CHECKs additionally forbid
 *   secret-shaped property names inside any value so a rogue writer cannot
 *   smuggle credential material into a "plain" row.
 * - Only the control-plane role receives grants (roles.sql + runtime-
 *   privileges.ts mirrors): registration admission and topup fulfillment
 *   resolution both run on the control plane. The gateway and the
 *   credential-validation-worker have no grant — secret settings values must
 *   never be readable outside the control plane, and no runtime consumer
 *   outside it needs the store (fail-closed default posture).
 * - Rows are never DELETEd: settings revert to the empty store (env fallback)
 *   by explicit admin tooling at most; an UPDATE sets the value, and the
 *   table has no append-only history because every mutation is audited with
 *   a before/after diff in saas_audit_events (the settings-change diff audit
 *   convention, secret paths rendered [redacted]).
 */
const platformSettingsSql = `
CREATE TABLE saas_platform_settings (
  key text PRIMARY KEY
    CHECK (key ~ '^saas\\.[a-z0-9_]+(\\.[a-z0-9_]+)+$' AND char_length(key) <= 128),
  value jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1
    CHECK (version >= 1),
  updated_by_user_id uuid REFERENCES saas_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_platform_settings_value_object CHECK (
    jsonb_typeof(value) = 'object'
  ),
  CONSTRAINT saas_platform_settings_plain_envelope CHECK (
    key ~ '\\.(secret|password)$'
    OR (value ? 'value')
  ),
  CONSTRAINT saas_platform_settings_secret_envelope CHECK (
    NOT (key ~ '\\.(secret|password)$')
    OR (
      (value ->> 'algorithm') = 'aes-256-gcm'
      AND (value ->> 'kmsKeyId') IS NOT NULL
      AND (value ->> 'wrappedDek') IS NOT NULL
      AND (value ->> 'nonce') IS NOT NULL
      AND (value ->> 'ciphertext') IS NOT NULL
      AND (value ->> 'authTag') IS NOT NULL
    )
  ),
  CONSTRAINT saas_platform_settings_no_plaintext_secret_names CHECK (
    NOT (value ? 'secret')
    AND NOT (value ? 'password')
    AND NOT (value ? 'plaintext')
    AND NOT (value ? 'credential')
  )
);

/*
 * Settings audit facts are deliberately narrow and immutable (the 042
 * capacity-policy pattern): actor, action and request id stay authoritative
 * in saas_audit_events; this table carries only the settings key, the
 * version step and the bounded key-level change summary. Secret-suffixed
 * settings never diff their envelope contents — the change summary renders
 * [redacted] on both sides at write time, so no sealed or plaintext secret
 * bytes can land in the summary array.
 */
CREATE TABLE saas_platform_settings_audit_details (
  audit_event_id uuid PRIMARY KEY
    REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  settings_key text NOT NULL,
  before_version bigint,
  after_version bigint NOT NULL,
  change_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT saas_platform_settings_audit_key_shape CHECK (
    settings_key ~ '^saas\\.[a-z0-9_]+(\\.[a-z0-9_]+)+$'
    AND char_length(settings_key) <= 128
  ),
  CONSTRAINT saas_platform_settings_audit_version_step CHECK (
    after_version >= 1
    AND (before_version IS NULL OR (before_version >= 1 AND after_version = before_version + 1))
  ),
  CONSTRAINT saas_platform_settings_audit_summary_shape CHECK (
    jsonb_typeof(change_summary) = 'array'
    AND jsonb_array_length(change_summary) BETWEEN 1 AND 64
  )
);

CREATE INDEX saas_platform_settings_audit_key_created_idx
  ON saas_platform_settings_audit_details (settings_key, created_at DESC);

CREATE TRIGGER saas_platform_settings_audit_details_immutable
  BEFORE UPDATE OR DELETE ON saas_platform_settings_audit_details
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_platform_settings_audit_details_no_truncate
  BEFORE TRUNCATE ON saas_platform_settings_audit_details
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();
`;

export const PLATFORM_SETTINGS_SAAS_MIGRATION: SaasMigration = {
  version: 110,
  name: 'platform_settings',
  sql: platformSettingsSql,
};
