import type { SaasMigration } from './001_initial_schema.js';

/**
 * R4 registration admission (docs/token-resale-implementation-plan-2026-10-15.md
 * §R4): the durable half of the public email-verification pipeline. The
 * control plane issues a 6-digit crypto-random code per (purpose, canonical
 * email); only the SHA-256 hash is ever stored, so a database disclosure never
 * yields usable codes.
 *
 * Design notes (sub2api/new-api parity):
 * - purpose CHECK isolates register and password_reset codes: a code issued
 *   for one purpose can never verify for the other (the hash input binds the
 *   purpose and the canonical email as well).
 * - PG is the authoritative store (multi-instance safe). Redis/process memory
 *   are only send-cooldown fast paths; correctness never depends on them.
 * - attempts bounds guessing per issued code (≤ 5); a mismatched attempt
 *   increments the counter, the sixth attempt fails closed even with the
 *   correct value.
 * - consumed_at is the one-time-consume marker: verification marks it inside
 *   the same transaction that consumes the code's effect (registration or
 *   password change), so a replayed code can never pass twice.
 * - created_ip is the abuse-forensics dimension (inet, not text); it never
 *   feeds an authorization decision.
 * - The lookup index is partial over live codes: verification always targets
 *   the newest unconsumed row for (purpose, email); the sweep index serves
 *   expiry pruning which rides the next issue transaction for the same key.
 *
 * Runtime admission settings (registration_mode, email_verification_required,
 * turnstile_*, smtp_*, email domain allow/deny lists) deliberately live in
 * the platform settings surface, not in this migration.
 *
 * Numbered 106 per the plan's migration table; 108 is concurrently taken by
 * R5b (opencode-go scheduling) and 107 stays free for R6a.
 */
const registrationAdmissionSql = `
CREATE TABLE saas_email_verification_codes (
  id uuid PRIMARY KEY,
  email_canonical text NOT NULL
    CHECK (char_length(btrim(email_canonical)) BETWEEN 3 AND 254
           AND position('@' in btrim(email_canonical)) > 1),
  purpose text NOT NULL
    CHECK (purpose IN ('register', 'password_reset')),
  code_hash text NOT NULL
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_email_verification_codes_expiry_shape CHECK (
    expires_at > created_at
  ),
  CONSTRAINT saas_email_verification_codes_consumed_shape CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX saas_email_verification_codes_active_idx
  ON saas_email_verification_codes (purpose, email_canonical, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE INDEX saas_email_verification_codes_sweep_idx
  ON saas_email_verification_codes (expires_at);
`;

export const REGISTRATION_ADMISSION_SAAS_MIGRATION: SaasMigration = {
  version: 106,
  name: 'registration_admission',
  sql: registrationAdmissionSql,
};
