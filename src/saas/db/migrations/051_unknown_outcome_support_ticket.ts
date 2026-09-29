import type { SaasMigration } from './001_initial_schema.js';

/*
 * Migration 051 is a registered, forward-only compatibility fence for the
 * control-plane operator-resolution path after migrations 001 through 050.
 *
 * Migration 049 owns the service-computed resolution_digest and its existing
 * case guard.  This migration layers new-column checks and triggers instead of
 * changing 049 or attempting to recompute the service's SHA-256 digest in SQL.
 */
const unknownOutcomeSupportTicketSql = `
ALTER TABLE saas_unknown_outcome_reconciliation_cases
  ADD COLUMN IF NOT EXISTS resolution_support_ticket_ref text;

ALTER TABLE saas_unknown_outcome_reconciliation_observations
  ADD COLUMN IF NOT EXISTS support_ticket_ref text;

COMMENT ON COLUMN saas_unknown_outcome_reconciliation_cases.resolution_support_ticket_ref IS
  'External support-system locator only; it is not Provider evidence or proof of execution.';
COMMENT ON COLUMN saas_unknown_outcome_reconciliation_observations.support_ticket_ref IS
  'External support-system locator only; it is not Provider evidence or proof of execution.';

/*
 * These checks are NOT VALID so a large pre-051 table is not scanned during
 * rollout.  PostgreSQL still enforces them for every new row and every row
 * touched by a later UPDATE.  The case column remains nullable for already
 * resolved rows created before this migration.
 * PostgreSQL's POSIX cntrl class covers the C0 and C1 control ranges here;
 * keep these CHECK expressions subquery-free because PostgreSQL rejects
 * subqueries in CHECK constraints.  U+0000 is not representable in text.
 */
ALTER TABLE saas_unknown_outcome_reconciliation_cases
  ADD CONSTRAINT saas_unknown_outcome_cases_resolution_support_ticket_ref_check
  CHECK (
    resolution_support_ticket_ref IS NULL OR (
      char_length(resolution_support_ticket_ref) BETWEEN 1 AND 255
      AND btrim(resolution_support_ticket_ref) = resolution_support_ticket_ref
      AND resolution_support_ticket_ref !~ '^[[:space:]]'
      AND resolution_support_ticket_ref !~ '[[:space:]]$'
      AND resolution_support_ticket_ref !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE saas_unknown_outcome_reconciliation_cases
  ADD CONSTRAINT saas_unknown_outcome_cases_resolution_support_ticket_ref_state_check
  CHECK (
    resolution_support_ticket_ref IS NULL OR case_state = 'resolved'
  ) NOT VALID;

ALTER TABLE saas_unknown_outcome_reconciliation_observations
  ADD CONSTRAINT saas_unknown_outcome_observations_support_ticket_ref_check
  CHECK (
    support_ticket_ref IS NULL OR (
      char_length(support_ticket_ref) BETWEEN 1 AND 255
      AND btrim(support_ticket_ref) = support_ticket_ref
      AND support_ticket_ref !~ '^[[:space:]]'
      AND support_ticket_ref !~ '[[:space:]]$'
      AND support_ticket_ref !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE saas_unknown_outcome_reconciliation_observations
  ADD CONSTRAINT saas_unknown_outcome_observations_support_ticket_ref_kind_check
  CHECK (
    support_ticket_ref IS NULL OR observation_kind = 'operator_resolution'
  ) NOT VALID;

/*
 * New operator-resolution observations are the append-only write boundary.
 * The existing 049 UPDATE/DELETE rejection trigger remains authoritative;
 * this trigger only validates the new INSERT payload and prevents conflicting
 * non-null references from being appended to one case.
 */
CREATE FUNCTION saas_guard_unknown_outcome_support_ticket_observation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_support_ticket_ref text;
BEGIN
  IF NEW.observation_kind <> 'operator_resolution' THEN
    RETURN NEW;
  END IF;

  IF NEW.support_ticket_ref IS NULL OR NOT (
    char_length(NEW.support_ticket_ref) BETWEEN 1 AND 255
    AND btrim(NEW.support_ticket_ref) = NEW.support_ticket_ref
    AND NEW.support_ticket_ref !~ '^[[:space:]]'
    AND NEW.support_ticket_ref !~ '[[:space:]]$'
    AND NEW.support_ticket_ref !~ '[[:cntrl:]]'
    AND NOT EXISTS (
      SELECT 1
        FROM generate_series(1, char_length(NEW.support_ticket_ref)) AS positions(position)
       WHERE ascii(substr(NEW.support_ticket_ref, positions.position, 1)) BETWEEN 0 AND 31
          OR ascii(substr(NEW.support_ticket_ref, positions.position, 1)) BETWEEN 127 AND 159
    )
  ) THEN
    RAISE EXCEPTION
      'New operator-resolution observation requires a valid support ticket reference'
      USING ERRCODE = '23514';
  END IF;

  SELECT c.resolution_support_ticket_ref
    INTO case_support_ticket_ref
    FROM saas_unknown_outcome_reconciliation_cases AS c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.id = NEW.case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown-outcome support-ticket observation references a missing case'
      USING ERRCODE = '23503';
  END IF;

  IF case_support_ticket_ref IS NOT NULL
     AND case_support_ticket_ref IS DISTINCT FROM NEW.support_ticket_ref
  THEN
    RAISE EXCEPTION 'Unknown-outcome case and observation support ticket references differ'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM saas_unknown_outcome_reconciliation_observations AS existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.case_id = NEW.case_id
       AND existing.observation_kind = 'operator_resolution'
       AND existing.support_ticket_ref IS NOT NULL
       AND existing.support_ticket_ref IS DISTINCT FROM NEW.support_ticket_ref
  ) THEN
    RAISE EXCEPTION 'Operator-resolution observations for one case must use one support ticket reference'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_unknown_outcome_support_ticket_observation_insert_guard
  BEFORE INSERT ON saas_unknown_outcome_reconciliation_observations
  FOR EACH ROW EXECUTE FUNCTION saas_guard_unknown_outcome_support_ticket_observation_insert();

/*
 * A resolved case created after 051 must carry the reference in the case row.
 * A resolved row that already existed before 051 is deliberately left NULL;
 * its historical ticket link, if present, is read only from immutable
 * operator_resolution observations.  The existing 049 guard cannot mention a
 * column that did not exist when its function was created, so this is a
 * separate trigger rather than a checksum-changing replacement.
 */
CREATE FUNCTION saas_guard_unknown_outcome_support_ticket_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_resolution boolean := false;
BEGIN
  IF NEW.resolution_support_ticket_ref IS NOT NULL AND NOT (
    char_length(NEW.resolution_support_ticket_ref) BETWEEN 1 AND 255
    AND btrim(NEW.resolution_support_ticket_ref) = NEW.resolution_support_ticket_ref
    AND NEW.resolution_support_ticket_ref !~ '^[[:space:]]'
    AND NEW.resolution_support_ticket_ref !~ '[[:space:]]$'
    AND NEW.resolution_support_ticket_ref !~ '[[:cntrl:]]'
    AND NOT EXISTS (
      SELECT 1
        FROM generate_series(1, char_length(NEW.resolution_support_ticket_ref)) AS positions(position)
       WHERE ascii(substr(NEW.resolution_support_ticket_ref, positions.position, 1)) BETWEEN 0 AND 31
          OR ascii(substr(NEW.resolution_support_ticket_ref, positions.position, 1)) BETWEEN 127 AND 159
    )
  ) THEN
    RAISE EXCEPTION 'Invalid unknown-outcome case support ticket reference'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.case_state <> 'resolved' AND NEW.resolution_support_ticket_ref IS NOT NULL THEN
    RAISE EXCEPTION 'Only a resolved unknown-outcome case may carry a support ticket reference'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.case_state = 'resolved'
       AND NEW.resolution_support_ticket_ref IS DISTINCT FROM OLD.resolution_support_ticket_ref
    THEN
      RAISE EXCEPTION
        'Resolved unknown-outcome case support ticket reference is immutable; use an operator-resolution observation'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.case_state IS DISTINCT FROM 'resolved' AND NEW.case_state = 'resolved' THEN
      new_resolution := true;
    END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.case_state = 'resolved' THEN
    new_resolution := true;
  END IF;

  IF new_resolution THEN
    IF NEW.resolution_support_ticket_ref IS NULL THEN
      RAISE EXCEPTION 'A new resolved unknown-outcome case requires a support ticket reference'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.resolution_digest IS NULL OR NEW.resolution_digest !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'A new resolved unknown-outcome case requires its service-computed resolution digest'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_unknown_outcome_support_ticket_case_guard
  BEFORE INSERT OR UPDATE ON saas_unknown_outcome_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION saas_guard_unknown_outcome_support_ticket_case();

/*
 * The service computes resolution_digest and includes supportTicketRef in the
 * idempotency payload.  These deferred checks make the digest, case column,
 * and append-only observations one commit-time contract without trying to
 * duplicate the service's JSON/SHA-256 implementation in PostgreSQL.
 */
CREATE FUNCTION saas_validate_unknown_outcome_support_ticket_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_case_id uuid;
  current_case_state text;
  current_support_ticket_ref text;
  current_resolution_digest text;
  has_operator_resolution boolean;
BEGIN
  IF TG_TABLE_NAME = 'saas_unknown_outcome_reconciliation_observations' THEN
    IF NEW.observation_kind <> 'operator_resolution' THEN
      RETURN NEW;
    END IF;
    target_case_id := NEW.case_id;
  ELSE
    target_case_id := NEW.id;
  END IF;

  SELECT c.case_state, c.resolution_support_ticket_ref, c.resolution_digest
    INTO current_case_state, current_support_ticket_ref, current_resolution_digest
    FROM saas_unknown_outcome_reconciliation_cases AS c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.id = target_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown-outcome support-ticket contract references a missing case'
      USING ERRCODE = '23503';
  END IF;

  SELECT EXISTS (
    SELECT 1
     FROM saas_unknown_outcome_reconciliation_observations AS o
     WHERE o.tenant_id = NEW.tenant_id
       AND o.case_id = target_case_id
       AND o.observation_kind = 'operator_resolution'
  )
    INTO has_operator_resolution;

  IF current_case_state <> 'resolved' THEN
    IF has_operator_resolution THEN
      RAISE EXCEPTION 'Operator-resolution observation requires a resolved unknown-outcome case'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  /* Legacy resolved rows remain NULL-compatible and are never backfilled. */
  IF current_support_ticket_ref IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_resolution_digest IS NULL OR current_resolution_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Resolved unknown-outcome case has no valid service-computed resolution digest'
      USING ERRCODE = '23514';
  END IF;
  IF NOT has_operator_resolution THEN
    RAISE EXCEPTION 'Resolved unknown-outcome case requires an operator-resolution observation'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM saas_unknown_outcome_reconciliation_observations AS o
     WHERE o.tenant_id = NEW.tenant_id
       AND o.case_id = target_case_id
       AND o.observation_kind = 'operator_resolution'
       AND o.support_ticket_ref IS DISTINCT FROM current_support_ticket_ref
  ) THEN
    RAISE EXCEPTION 'Unknown-outcome case and operator-resolution observations must use the same support ticket reference'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER saas_unknown_outcome_support_ticket_case_contract
  AFTER INSERT OR UPDATE ON saas_unknown_outcome_reconciliation_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION saas_validate_unknown_outcome_support_ticket_contract();

CREATE CONSTRAINT TRIGGER saas_unknown_outcome_support_ticket_observation_contract
  AFTER INSERT ON saas_unknown_outcome_reconciliation_observations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION saas_validate_unknown_outcome_support_ticket_contract();
`;

export const UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION: SaasMigration = {
  version: 51,
  name: 'unknown_outcome_support_ticket',
  sql: unknownOutcomeSupportTicketSql,
};
