import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track E2: customer passkey (WebAuthn) ceremonies. 001 already reserved
 * kind='passkey' on saas_mfa_credentials (credential_id + public_key, no
 * encrypted_secret); this migration adds the clone-detection counter and the
 * single-use challenge ledger that makes registration/assertion ceremonies
 * replay-proof at the database boundary.
 *
 * Design notes:
 * - sign_count mirrors 007's last_used_step (TOTP replay CAS) for the
 *   passkey kind: NULL until the first assertion, kind-bound so a TOTP row
 *   can never carry a passkey counter (and vice versa via the existing
 *   kind_data CHECK).
 * - Ceremonies are session-bound (passkey is a second factor for an already
 *   authenticated customer session, parallel to TOTP), single-challenge
 *   (challenge_hash UNIQUE), short-lived (<= 5 minutes), attempt-capped, and
 *   closed-once. One open ceremony per (user, ceremony) via partial unique.
 * - credential_id is NULL at INSERT for registration (the authenticator's
 *   credential id is only known at finish) and REQUIRED for assertion, where
 *   the guard binds it to an active verified passkey of the same user.
 * - Guards mirror the customer-MFA draft family (deploy/drafts/
 *   customer-mfa-enrollment.forward.sql): transition guard + statement-level
 *   writer fence (distinct advisory class 85) + row-level user fence. All
 *   functions are migrator-owned, invoker-security, pinned search_path; the
 *   runtime readiness check embeds their exact bodies.
 * Numbered 085 per the contracts-m0-freeze ledger (E consumes 085-086).
 */
const customerPasskeyCeremoniesSql = `
ALTER TABLE saas_mfa_credentials
  ADD COLUMN sign_count bigint,
  ADD CONSTRAINT saas_mfa_credentials_sign_count_nonnegative
    CHECK (sign_count IS NULL OR sign_count >= 0),
  ADD CONSTRAINT saas_mfa_credentials_sign_count_passkey_only
    CHECK (kind = 'passkey' OR sign_count IS NULL);

CREATE TABLE saas_customer_passkey_ceremonies (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES saas_sessions(id) ON DELETE RESTRICT,
  ceremony text NOT NULL CHECK (ceremony IN ('registration', 'assertion')),
  challenge_hash text NOT NULL UNIQUE
    CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  credential_id text
    CHECK (credential_id IS NULL OR char_length(credential_id) BETWEEN 16 AND 1364),
  password_digest text NOT NULL
    CHECK (password_digest ~ '^[0-9a-f]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT saas_customer_passkey_ceremonies_expiry_window
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CONSTRAINT saas_customer_passkey_ceremonies_consume_shape
    CHECK (consumed_at IS NULL OR closed_at IS NOT NULL)
);
/* At most one open ceremony per user and kind; a fresh start requires the
 * previous one closed (the service closes predecessors explicitly). */
CREATE UNIQUE INDEX saas_customer_passkey_one_open_ceremony
  ON saas_customer_passkey_ceremonies (user_id, ceremony) WHERE closed_at IS NULL;
CREATE INDEX saas_customer_passkey_ceremonies_user_idx
  ON saas_customer_passkey_ceremonies (user_id, ceremony, expires_at) WHERE closed_at IS NULL;

CREATE FUNCTION model_router_saas.saas_customer_passkey_ceremony_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer passkey ceremony history is permanent' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (
   (to_jsonb(NEW)-ARRAY['credential_id','attempt_count','consumed_at','closed_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['credential_id','attempt_count','consumed_at','closed_at'])
   OR OLD.closed_at IS NOT NULL
   OR NEW.attempt_count NOT IN (OLD.attempt_count,OLD.attempt_count+1)
   OR (NEW.consumed_at IS NOT NULL AND NEW.closed_at IS NULL)
   OR (NEW.credential_id IS DISTINCT FROM OLD.credential_id AND NOT (
     OLD.ceremony='registration' AND OLD.credential_id IS NULL AND NEW.consumed_at IS NOT NULL)))
 THEN RAISE EXCEPTION 'Customer passkey ceremony transition rejected' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.attempt_count<>0 OR NEW.consumed_at IS NOT NULL OR NEW.closed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Customer passkey ceremony must begin pending' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (
   (NEW.ceremony='registration' AND NEW.credential_id IS NOT NULL)
   OR (NEW.ceremony='assertion' AND (NEW.credential_id IS NULL OR NOT EXISTS(
     SELECT 1 FROM model_router_saas.saas_mfa_credentials c
       WHERE c.user_id=NEW.user_id AND c.kind='passkey' AND c.credential_id=NEW.credential_id
         AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL)))
   OR EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments p WHERE p.user_id=NEW.user_id)
   OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id=s.user_id
     WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND u.disabled_at IS NULL AND u.anonymized_at IS NULL))
 THEN RAISE EXCEPTION 'Customer passkey ceremony authority binding rejected' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;

CREATE FUNCTION model_router_saas.saas_customer_passkey_writer() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 PERFORM set_config('lock_timeout','2s',true);
 PERFORM set_config('statement_timeout','10s',true);
 PERFORM pg_advisory_xact_lock(1396788563,85);
 RETURN NULL;
END;
$body$;

CREATE FUNCTION model_router_saas.saas_customer_passkey_user_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF TG_OP='DELETE' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text,0)); RETURN OLD;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0)); RETURN NEW;
END;
$body$;

CREATE TRIGGER saas_customer_passkey_ceremony_guard
  BEFORE INSERT OR UPDATE OR DELETE ON model_router_saas.saas_customer_passkey_ceremonies
  FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_customer_passkey_ceremony_guard();
CREATE TRIGGER saas_customer_passkey_ceremonies_writer
  BEFORE INSERT OR UPDATE OR DELETE ON model_router_saas.saas_customer_passkey_ceremonies
  FOR EACH STATEMENT EXECUTE FUNCTION model_router_saas.saas_customer_passkey_writer();
CREATE TRIGGER saas_customer_passkey_ceremonies_user
  AFTER INSERT OR UPDATE OR DELETE ON model_router_saas.saas_customer_passkey_ceremonies
  FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_customer_passkey_user_fence();
`;

export const CUSTOMER_PASSKEY_CEREMONIES_SAAS_MIGRATION: SaasMigration = {
  version: 85,
  name: 'customer_passkey_ceremonies',
  sql: customerPasskeyCeremoniesSql,
};
