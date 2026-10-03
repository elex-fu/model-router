-- UNNUMBERED, INACTIVE forward draft. Execute ONLY normal managed migrator
-- after central allocation/registry/ACL/readiness review. No business seeds.
DO $customer_mfa_owner$
BEGIN
 IF current_user <> 'model_router_saas_migrator' OR NOT EXISTS(
   SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='model_router_saas' AND r.rolname=current_user
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb)
 THEN RAISE EXCEPTION 'Customer MFA requires the isolated trusted schema owner' USING ERRCODE='55000'; END IF;
END;
$customer_mfa_owner$;
SET LOCAL search_path TO pg_catalog, model_router_saas, pg_temp;

-- New composite FK support, not an epoch, auth grant or historical rewrite.
ALTER TABLE model_router_saas.saas_sessions ADD CONSTRAINT saas_sessions_id_user_pair UNIQUE(id,user_id);

CREATE TABLE model_router_saas.saas_customer_mfa_rate_windows (
 user_id uuid PRIMARY KEY REFERENCES model_router_saas.saas_users(id) ON DELETE RESTRICT,
 window_started_at timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 21)
);
CREATE TABLE model_router_saas.saas_customer_mfa_commands (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 session_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('start','confirm','revoke')),
 request_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 completed_at timestamptz,
 outcome text CHECK(outcome IN ('started','confirmed','revoked','denied')),
 FOREIGN KEY(session_id,user_id) REFERENCES model_router_saas.saas_sessions(id,user_id) ON DELETE RESTRICT,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 seconds'),
 CHECK((completed_at IS NULL)=(outcome IS NULL)),
 CHECK(completed_at IS NULL OR completed_at>=created_at),
 CHECK(outcome IS NULL OR outcome='denied' OR completed_at<expires_at)
);
CREATE TABLE model_router_saas.saas_customer_mfa_enrollments (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 session_id uuid NOT NULL,
 credential_id uuid NOT NULL UNIQUE,
 previous_credential_id uuid,
 token_hash text NOT NULL UNIQUE CHECK(token_hash~'^[0-9a-f]{64}$'),
 password_digest text NOT NULL CHECK(password_digest~'^[0-9a-f]{64}$'),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 closed_at timestamptz,
 locked_at timestamptz,
 FOREIGN KEY(session_id,user_id) REFERENCES model_router_saas.saas_sessions(id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(credential_id,user_id) REFERENCES model_router_saas.saas_mfa_credentials(id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(previous_credential_id,user_id) REFERENCES model_router_saas.saas_mfa_credentials(id,user_id) ON DELETE RESTRICT,
 CHECK(previous_credential_id IS NULL OR previous_credential_id<>credential_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK(consumed_at IS NULL OR (closed_at IS NOT NULL AND consumed_at<expires_at)),
 CHECK(locked_at IS NULL OR (attempt_count=5 AND closed_at IS NOT NULL AND consumed_at IS NULL))
);
CREATE UNIQUE INDEX saas_customer_mfa_one_open_enrollment ON model_router_saas.saas_customer_mfa_enrollments(user_id)
 WHERE closed_at IS NULL;
CREATE INDEX saas_customer_mfa_expiry_idx ON model_router_saas.saas_customer_mfa_enrollments(user_id,expires_at)
 WHERE closed_at IS NULL;
CREATE TABLE model_router_saas.saas_customer_mfa_events (
 id uuid PRIMARY KEY,
 audit_id uuid NOT NULL UNIQUE REFERENCES model_router_saas.saas_audit_events(id) ON DELETE RESTRICT,
 command_id uuid REFERENCES model_router_saas.saas_customer_mfa_commands(id) ON DELETE RESTRICT,
 user_id uuid REFERENCES model_router_saas.saas_users(id) ON DELETE RESTRICT,
 session_id uuid,
 operation text NOT NULL CHECK(operation IN ('start','confirm','revoke')),
 outcome text NOT NULL CHECK(outcome IN ('authorized','started','confirmed','revoked','denied')),
 reason_code text CHECK(reason_code IN ('INVALID_INPUT','UNAUTHENTICATED','CSRF_REJECTED','REAUTH_REQUIRED',
   'MFA_CODE_REJECTED','MFA_STATE_CONFLICT','ENROLLMENT_PENDING','ENROLLMENT_INVALID','RATE_LIMITED',
   'AUTHORITY_CHANGED','UNAVAILABLE')),
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(session_id,user_id) REFERENCES model_router_saas.saas_sessions(id,user_id) ON DELETE RESTRICT,
 CHECK((user_id IS NULL)=(session_id IS NULL)),
 CHECK((outcome='denied')=(reason_code IS NOT NULL)),
 CHECK(outcome='denied' OR command_id IS NOT NULL),
 UNIQUE(command_id,outcome)
);
-- Immutable metadata outbox. Delivery cursor/consumer is a separate workload;
-- it may never rewrite an enrollment/event or export a TOTP secret.
CREATE TABLE model_router_saas.saas_customer_mfa_outbox (
 event_id uuid PRIMARY KEY REFERENCES model_router_saas.saas_customer_mfa_events(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION model_router_saas.saas_customer_mfa_enrollment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer MFA history is permanent' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (
   (to_jsonb(NEW)-ARRAY['attempt_count','consumed_at','closed_at','locked_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['attempt_count','consumed_at','closed_at','locked_at'])
   OR OLD.closed_at IS NOT NULL
   OR NEW.attempt_count NOT IN (OLD.attempt_count,OLD.attempt_count+1)
   OR (NEW.consumed_at IS NOT NULL AND (NEW.locked_at IS NOT NULL OR NEW.closed_at IS NULL)))
 THEN RAISE EXCEPTION 'Customer MFA enrollment transition rejected' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.attempt_count<>0 OR NEW.consumed_at IS NOT NULL
   OR NEW.closed_at IS NOT NULL OR NEW.locked_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Customer MFA must begin pending' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM model_router_saas.saas_platform_role_assignments p WHERE p.user_id=NEW.user_id)
   OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_sessions s JOIN model_router_saas.saas_users u ON u.id=s.user_id
     WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND u.disabled_at IS NULL AND u.anonymized_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM model_router_saas.saas_mfa_credentials c WHERE c.id=NEW.credential_id AND c.user_id=NEW.user_id
     AND c.kind='totp' AND c.verified_at IS NULL AND c.revoked_at IS NULL)
   OR (NEW.previous_credential_id IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM model_router_saas.saas_mfa_credentials c JOIN model_router_saas.saas_customer_mfa_enrollments e
       ON e.user_id=c.user_id AND e.credential_id=c.id AND e.consumed_at IS NOT NULL
     WHERE c.id=NEW.previous_credential_id AND c.user_id=NEW.user_id
       AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL)))
 THEN RAISE EXCEPTION 'Customer MFA pending authority binding rejected' USING ERRCODE='23514'; END IF;
 IF NEW.consumed_at IS NOT NULL AND (NOT EXISTS(
   SELECT 1 FROM model_router_saas.saas_mfa_credentials c WHERE c.id=NEW.credential_id AND c.user_id=NEW.user_id
     AND c.kind='totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL AND c.last_used_step IS NOT NULL)
   OR (NEW.previous_credential_id IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM model_router_saas.saas_mfa_credentials c WHERE c.id=NEW.previous_credential_id AND c.user_id=NEW.user_id
       AND c.revoked_at IS NOT NULL)))
 THEN RAISE EXCEPTION 'Customer MFA confirmation facts are incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;
CREATE FUNCTION model_router_saas.saas_customer_mfa_command_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer MFA command history is permanent' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (
   (to_jsonb(NEW)-ARRAY['completed_at','outcome']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['completed_at','outcome'])
   OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL OR NEW.outcome IS NULL)
 THEN RAISE EXCEPTION 'Customer MFA command transition rejected' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.completed_at IS NOT NULL OR NEW.outcome IS NOT NULL)
 THEN RAISE EXCEPTION 'Customer MFA command must begin pending' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;
CREATE FUNCTION model_router_saas.saas_customer_mfa_event_audit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_audit_events a WHERE a.id=NEW.audit_id
   AND a.actor_user_id IS NOT DISTINCT FROM NEW.user_id
   AND a.tenant_id IS NULL AND a.entry_point='customer_mfa'
   AND a.action='customer_mfa.'||NEW.operation||'.'||NEW.outcome
   AND a.target_type='customer_mfa_command' AND a.target_id IS NOT DISTINCT FROM NEW.command_id::text
   AND a.request_id=NEW.request_id::text)
 THEN RAISE EXCEPTION 'Customer MFA event requires the same audit fact' USING ERRCODE='23514'; END IF;
 IF NEW.command_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM model_router_saas.saas_customer_mfa_commands c WHERE c.id=NEW.command_id
     AND c.user_id=NEW.user_id AND c.session_id=NEW.session_id AND c.operation=NEW.operation
     AND c.request_id=NEW.request_id
     AND (NEW.outcome='authorized' AND c.completed_at IS NULL
       OR NEW.outcome<>'authorized' AND c.outcome=NEW.outcome AND c.completed_at IS NOT NULL))
 THEN RAISE EXCEPTION 'Customer MFA event command binding differs' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;
CREATE FUNCTION model_router_saas.saas_customer_mfa_event_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_customer_mfa_outbox o WHERE o.event_id=NEW.id)
 THEN RAISE EXCEPTION 'Customer MFA event outbox is required in the same transaction' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;
CREATE FUNCTION model_router_saas.saas_customer_mfa_command_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
DECLARE current_command model_router_saas.saas_customer_mfa_commands%ROWTYPE;
BEGIN
 SELECT * INTO STRICT current_command FROM model_router_saas.saas_customer_mfa_commands WHERE id=NEW.id;
 IF NOT EXISTS(SELECT 1 FROM model_router_saas.saas_customer_mfa_events e
   WHERE e.command_id=NEW.id AND e.outcome='authorized')
   OR (current_command.completed_at IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM model_router_saas.saas_customer_mfa_events e
       WHERE e.command_id=NEW.id AND e.outcome=current_command.outcome))
 THEN RAISE EXCEPTION 'Customer MFA command requires same-transaction events' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$body$;
CREATE FUNCTION model_router_saas.saas_customer_mfa_writer() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 PERFORM set_config('lock_timeout','2s',true);
 PERFORM set_config('statement_timeout','10s',true);
 PERFORM pg_advisory_xact_lock(1396788563,46);
 RETURN NULL;
END;
$body$;
CREATE FUNCTION model_router_saas.saas_customer_mfa_user_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, model_router_saas, pg_temp AS $body$
BEGIN
 IF TG_OP='DELETE' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text,0)); RETURN OLD;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0)); RETURN NEW;
END;
$body$;
CREATE TRIGGER saas_customer_mfa_enrollments_writer BEFORE INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_enrollments FOR EACH STATEMENT EXECUTE FUNCTION model_router_saas.saas_customer_mfa_writer();
CREATE TRIGGER saas_customer_mfa_enrollments_user AFTER INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_enrollments FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_customer_mfa_user_fence();
CREATE TRIGGER saas_customer_mfa_commands_writer BEFORE INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_commands FOR EACH STATEMENT EXECUTE FUNCTION model_router_saas.saas_customer_mfa_writer();
CREATE TRIGGER saas_customer_mfa_commands_user AFTER INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_commands FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_customer_mfa_user_fence();
CREATE TRIGGER saas_customer_mfa_rate_writer BEFORE INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_rate_windows FOR EACH STATEMENT EXECUTE FUNCTION model_router_saas.saas_customer_mfa_writer();
CREATE TRIGGER saas_customer_mfa_rate_user AFTER INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_rate_windows FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_customer_mfa_user_fence();
CREATE TRIGGER saas_customer_mfa_enrollment_guard BEFORE INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_enrollments FOR EACH ROW
 EXECUTE FUNCTION model_router_saas.saas_customer_mfa_enrollment_guard();
CREATE TRIGGER saas_customer_mfa_command_guard BEFORE INSERT OR UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_commands FOR EACH ROW
 EXECUTE FUNCTION model_router_saas.saas_customer_mfa_command_guard();
CREATE TRIGGER saas_customer_mfa_event_audit_guard BEFORE INSERT
 ON model_router_saas.saas_customer_mfa_events FOR EACH ROW
 EXECUTE FUNCTION model_router_saas.saas_customer_mfa_event_audit_guard();
CREATE CONSTRAINT TRIGGER saas_customer_mfa_event_complete AFTER INSERT
 ON model_router_saas.saas_customer_mfa_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION model_router_saas.saas_customer_mfa_event_complete();
CREATE CONSTRAINT TRIGGER saas_customer_mfa_command_complete AFTER INSERT OR UPDATE
 ON model_router_saas.saas_customer_mfa_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION model_router_saas.saas_customer_mfa_command_complete();
CREATE TRIGGER saas_customer_mfa_event_immutable BEFORE UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_events FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_reject_immutable_change();
CREATE TRIGGER saas_customer_mfa_outbox_immutable BEFORE UPDATE OR DELETE
 ON model_router_saas.saas_customer_mfa_outbox FOR EACH ROW EXECUTE FUNCTION model_router_saas.saas_reject_immutable_change();
REVOKE ALL ON FUNCTION model_router_saas.saas_customer_mfa_enrollment_guard(),
 model_router_saas.saas_customer_mfa_command_guard(),model_router_saas.saas_customer_mfa_event_audit_guard(),
 model_router_saas.saas_customer_mfa_event_complete(),model_router_saas.saas_customer_mfa_command_complete(),
 model_router_saas.saas_customer_mfa_writer(),model_router_saas.saas_customer_mfa_user_fence() FROM PUBLIC;
-- No application function EXECUTE, role membership, GRANT or historical SQL rewrite here.
