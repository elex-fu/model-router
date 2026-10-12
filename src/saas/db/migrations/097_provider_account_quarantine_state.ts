import type { SaasMigration } from './001_initial_schema.js';

/**
 * R5 credential quarantine middle state (design:
 * docs/remaining-capability-plan-2026-10-11.md R5). Quarantine is an
 * observation state between failed and verified: the account stays excluded
 * from scheduling (the eligibility SQL already requires validation_state =
 * 'verified') while the revalidation worker probes it on a longer cadence;
 * a successful probe returns it to verified. The guard trigger confines the
 * transition graph: quarantine may only be entered from failed, may only be
 * left towards verified, and its entry facts are immutable while quarantined.
 * Existing rows satisfy the widened CHECKs by construction (none of them is
 * quarantined), so the transactional DROP+ADD pair (migration 063's pattern)
 * is a metadata-only change.
 */
const providerAccountQuarantineSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN quarantine_entered_at timestamptz,
  ADD COLUMN quarantine_reason_code text;

ALTER TABLE saas_tenant_provider_accounts
  DROP CONSTRAINT saas_tenant_provider_accounts_validation_state_check,
  ADD CONSTRAINT saas_tenant_provider_accounts_validation_state_check
    CHECK (validation_state IN ('unverified', 'verified', 'failed', 'quarantined')),
  ADD CONSTRAINT saas_tenant_provider_accounts_quarantine_shape
    CHECK (
      (validation_state = 'quarantined' AND quarantine_entered_at IS NOT NULL)
      OR (validation_state <> 'quarantined' AND quarantine_entered_at IS NULL AND quarantine_reason_code IS NULL)
    ),
  ADD CONSTRAINT saas_tenant_provider_accounts_quarantine_reason_length
    CHECK (quarantine_reason_code IS NULL OR (btrim(quarantine_reason_code) <> '' AND char_length(quarantine_reason_code) <= 128));

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN quarantine_entered_at timestamptz,
  ADD COLUMN quarantine_reason_code text;

ALTER TABLE saas_platform_provider_accounts
  DROP CONSTRAINT saas_platform_provider_accounts_validation_state_check,
  ADD CONSTRAINT saas_platform_provider_accounts_validation_state_check
    CHECK (validation_state IN ('unverified', 'verified', 'failed', 'quarantined')),
  ADD CONSTRAINT saas_platform_provider_accounts_quarantine_shape
    CHECK (
      (validation_state = 'quarantined' AND quarantine_entered_at IS NOT NULL)
      OR (validation_state <> 'quarantined' AND quarantine_entered_at IS NULL AND quarantine_reason_code IS NULL)
    ),
  ADD CONSTRAINT saas_platform_provider_accounts_quarantine_reason_length
    CHECK (quarantine_reason_code IS NULL OR (btrim(quarantine_reason_code) <> '' AND char_length(quarantine_reason_code) <= 128));

CREATE FUNCTION saas_tenant_provider_account_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.validation_state = 'quarantined' AND OLD.validation_state IS DISTINCT FROM 'quarantined'
    AND OLD.validation_state <> 'failed'
  THEN
    RAISE EXCEPTION 'Provider account quarantine may only be entered from failed'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.validation_state = 'quarantined' AND NEW.validation_state IS DISTINCT FROM OLD.validation_state
    AND NEW.validation_state <> 'verified'
  THEN
    RAISE EXCEPTION 'Provider account quarantine may only be left towards verified'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.validation_state = 'quarantined' AND NEW.validation_state = 'quarantined'
    AND (NEW.quarantine_entered_at IS DISTINCT FROM OLD.quarantine_entered_at
      OR NEW.quarantine_reason_code IS DISTINCT FROM OLD.quarantine_reason_code)
  THEN
    RAISE EXCEPTION 'Provider account quarantine entry facts are immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.validation_state IS DISTINCT FROM OLD.validation_state AND NEW.validation_state <> 'quarantined'
    AND (NEW.quarantine_entered_at IS NOT NULL OR NEW.quarantine_reason_code IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Quarantine facts must be cleared when leaving quarantine'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_tenant_provider_account_quarantine_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_tenant_provider_accounts_quarantine_guard
  BEFORE UPDATE ON saas_tenant_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_tenant_provider_account_quarantine_guard();

CREATE FUNCTION saas_platform_provider_account_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.validation_state = 'quarantined' AND OLD.validation_state IS DISTINCT FROM 'quarantined'
    AND OLD.validation_state <> 'failed'
  THEN
    RAISE EXCEPTION 'Provider account quarantine may only be entered from failed'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.validation_state = 'quarantined' AND NEW.validation_state IS DISTINCT FROM OLD.validation_state
    AND NEW.validation_state <> 'verified'
  THEN
    RAISE EXCEPTION 'Provider account quarantine may only be left towards verified'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.validation_state = 'quarantined' AND NEW.validation_state = 'quarantined'
    AND (NEW.quarantine_entered_at IS DISTINCT FROM OLD.quarantine_entered_at
      OR NEW.quarantine_reason_code IS DISTINCT FROM OLD.quarantine_reason_code)
  THEN
    RAISE EXCEPTION 'Provider account quarantine entry facts are immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.validation_state IS DISTINCT FROM OLD.validation_state AND NEW.validation_state <> 'quarantined'
    AND (NEW.quarantine_entered_at IS NOT NULL OR NEW.quarantine_reason_code IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Quarantine facts must be cleared when leaving quarantine'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_platform_provider_account_quarantine_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_platform_provider_accounts_quarantine_guard
  BEFORE UPDATE ON saas_platform_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_platform_provider_account_quarantine_guard();
`;

export const PROVIDER_ACCOUNT_QUARANTINE_SAAS_MIGRATION: SaasMigration = {
  version: 97,
  name: 'provider_account_quarantine_state',
  sql: providerAccountQuarantineSql,
};
