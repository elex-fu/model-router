import type { SaasMigration } from './001_initial_schema.js';

/*
 * Migration 016 stores the account epoch on a platform pool member, but not
 * the member's own authorization epoch.  A member lifecycle change must be
 * independently visible to dispatch authority snapshots.  Keep the existing
 * relationship identities immutable: rebinds revoke the old row and insert a
 * new row, so an old binding can never be silently revived.
 *
 * Migration 019 deliberately leaves historical attempts unbound.  The new
 * attempt epoch is nullable for those rows and required only for newly bound
 * platform authority.  There is intentionally no historical backfill.
 */
const supplyRelationshipEpochSchemaSql = `
ALTER TABLE saas_platform_provider_pool_members
  ADD COLUMN authz_version bigint NOT NULL DEFAULT 1
    CHECK (authz_version >= 1);

CREATE INDEX saas_platform_provider_pool_members_authority_idx
  ON saas_platform_provider_pool_members (pool_id, account_id, status, authz_version);

ALTER TABLE saas_attempts
  ADD COLUMN pool_member_authz_version bigint;

ALTER TABLE saas_attempts
  ADD CONSTRAINT saas_attempts_pool_member_authz_version_shape
  CHECK (
    (
      dispatch_authority_state = 'bound'
      AND account_owner_kind = 'platform'
      AND pool_member_authz_version IS NOT NULL
      AND pool_member_authz_version >= 1
    )
    OR (
      (dispatch_authority_state <> 'bound' OR account_owner_kind IS DISTINCT FROM 'platform')
      AND pool_member_authz_version IS NULL
    )
  );

/* Relationship lifecycle epochs are not caller authority; they are CAS facts. */
CREATE FUNCTION saas_provider_supply_relation_epoch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'revoked' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.authz_version IS DISTINCT FROM OLD.authz_version
    THEN
      RAISE EXCEPTION 'Revoked provider supply relationships are terminal'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.authz_version IS DISTINCT FROM OLD.authz_version + 1 THEN
      RAISE EXCEPTION 'Provider supply relationship lifecycle changes require an epoch advance'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.authz_version IS DISTINCT FROM OLD.authz_version THEN
    RAISE EXCEPTION 'Provider supply relationship epochs require an explicit lifecycle change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pool_members_relation_epoch_guard
  BEFORE UPDATE ON saas_platform_provider_pool_members
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_relation_epoch_guard();
CREATE TRIGGER saas_platform_provider_pool_grants_relation_epoch_guard
  BEFORE UPDATE ON saas_platform_provider_pool_grants
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_relation_epoch_guard();
CREATE TRIGGER saas_tenant_provider_supply_profile_accounts_relation_epoch_guard
  BEFORE UPDATE ON saas_tenant_provider_supply_profile_accounts
  FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_relation_epoch_guard();

/*
 * 019 already checks the account epoch on a platform pool member.  Add the
 * independent member epoch without rewriting 019's trigger: both facts must
 * match the current member row before an attempt can dispatch.
 */
CREATE FUNCTION saas_attempts_guard_pool_member_authority_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.dispatch_authority_state = 'bound'
    AND OLD.pool_member_authz_version IS DISTINCT FROM NEW.pool_member_authz_version
  THEN
    RAISE EXCEPTION 'SaaS attempt pool member authority is immutable once bound'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.dispatch_authority_state = 'unbound' THEN
    IF NEW.pool_member_authz_version IS NOT NULL THEN
      RAISE EXCEPTION 'Unbound SaaS attempts cannot carry pool member authority'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.account_owner_kind IS DISTINCT FROM 'platform' THEN
    IF NEW.pool_member_authz_version IS NOT NULL THEN
      RAISE EXCEPTION 'Only platform attempts can carry pool member authority'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.pool_member_authz_version IS NULL THEN
    RAISE EXCEPTION 'Platform attempts require a pool member authority epoch'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM saas_platform_provider_pool_members AS pool_member
     WHERE pool_member.pool_id = NEW.pool_id
       AND pool_member.account_id = NEW.platform_account_id
       AND pool_member.provider_id = NEW.provider_id
       AND pool_member.product_id = NEW.product_id
       AND pool_member.status = 'active'
       AND pool_member.account_authz_version = NEW.pool_member_account_authz_version
       AND pool_member.authz_version = NEW.pool_member_authz_version
  ) THEN
    RAISE EXCEPTION 'SaaS attempt platform pool member authority is stale or mismatched'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_pool_member_authority_epoch
  BEFORE INSERT OR UPDATE ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_pool_member_authority_epoch();
`;

export const SUPPLY_RELATIONSHIP_EPOCHS_SAAS_MIGRATION: SaasMigration = {
  version: 20,
  name: 'supply_relationship_epochs_and_lifecycle',
  sql: supplyRelationshipEpochSchemaSql,
};
