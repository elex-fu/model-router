import type { SaasMigration } from './001_initial_schema.js';

/*
 * Migration 018 binds the account identity used by an attempt, but an
 * account is not itself dispatch authority: a credential version and the
 * mode-specific authorization mapping still have to be fixed.  Keep those
 * facts separate from 018 so applied 015-018 checksums remain immutable.
 *
 * Existing rows receive an explicit unbound authority state.  There is no
 * backfill and no synthetic credential, pool, grant, or profile mapping:
 * those attempts remain historical and cannot transition into dispatch.
 */
const attemptDispatchAuthoritySchemaSql = `
ALTER TABLE saas_attempts
  ADD COLUMN dispatch_authority_state text NOT NULL DEFAULT 'unbound',
  ADD COLUMN dispatch_profile_id text,
  ADD COLUMN supply_profile_authz_version bigint,
  ADD COLUMN credential_id text,
  ADD COLUMN credential_version integer,
  ADD COLUMN credential_authz_version bigint,
  ADD COLUMN account_authz_version bigint,
  ADD COLUMN pool_id text,
  ADD COLUMN pool_authz_version bigint,
  ADD COLUMN pool_member_account_authz_version bigint,
  ADD COLUMN pool_grant_authz_version bigint,
  ADD COLUMN pool_grant_profile_authz_version bigint,
  ADD COLUMN pool_grant_pool_authz_version bigint,
  ADD COLUMN profile_account_authz_version bigint;

/* Owner-specific projections make the two credential-version FKs unambiguous. */
ALTER TABLE saas_attempts
  ADD COLUMN tenant_credential_id text GENERATED ALWAYS AS (
    CASE WHEN account_owner_kind = 'tenant' THEN credential_id ELSE NULL END
  ) STORED,
  ADD COLUMN platform_credential_id text GENERATED ALWAYS AS (
    CASE WHEN account_owner_kind = 'platform' THEN credential_id ELSE NULL END
  ) STORED;

ALTER TABLE saas_attempts
  ADD CONSTRAINT saas_attempts_dispatch_authority_state_check
    CHECK (dispatch_authority_state IN ('unbound', 'bound')),
  ADD CONSTRAINT saas_attempts_dispatch_authority_text_shape
    CHECK (
      (dispatch_profile_id IS NULL OR (btrim(dispatch_profile_id) <> '' AND dispatch_profile_id = btrim(dispatch_profile_id)))
      AND (credential_id IS NULL OR (btrim(credential_id) <> '' AND credential_id = btrim(credential_id)))
      AND (pool_id IS NULL OR (btrim(pool_id) <> '' AND pool_id = btrim(pool_id)))
    ),
  ADD CONSTRAINT saas_attempts_dispatch_authority_epoch_shape
    CHECK (
      (credential_version IS NULL OR credential_version >= 1)
      AND (supply_profile_authz_version IS NULL OR supply_profile_authz_version >= 1)
      AND (credential_authz_version IS NULL OR credential_authz_version >= 1)
      AND (account_authz_version IS NULL OR account_authz_version >= 1)
      AND (pool_authz_version IS NULL OR pool_authz_version >= 1)
      AND (pool_member_account_authz_version IS NULL OR pool_member_account_authz_version >= 1)
      AND (pool_grant_authz_version IS NULL OR pool_grant_authz_version >= 1)
      AND (pool_grant_profile_authz_version IS NULL OR pool_grant_profile_authz_version >= 1)
      AND (pool_grant_pool_authz_version IS NULL OR pool_grant_pool_authz_version >= 1)
      AND (profile_account_authz_version IS NULL OR profile_account_authz_version >= 1)
    ),
  ADD CONSTRAINT saas_attempts_dispatch_authority_shape
    CHECK (
      (
        dispatch_authority_state = 'unbound'
        AND dispatch_profile_id IS NULL
        AND supply_profile_authz_version IS NULL
        AND credential_id IS NULL
        AND credential_version IS NULL
        AND credential_authz_version IS NULL
        AND account_authz_version IS NULL
        AND pool_id IS NULL
        AND pool_authz_version IS NULL
        AND pool_member_account_authz_version IS NULL
        AND pool_grant_authz_version IS NULL
        AND pool_grant_profile_authz_version IS NULL
        AND pool_grant_pool_authz_version IS NULL
        AND profile_account_authz_version IS NULL
      )
      OR
      (
        dispatch_authority_state = 'bound'
        AND binding_state = 'bound'
        AND account_owner_kind IN ('tenant', 'platform')
        AND dispatch_profile_id IS NOT NULL
        AND supply_profile_authz_version IS NOT NULL
        AND credential_id IS NOT NULL
        AND credential_version IS NOT NULL
        AND credential_authz_version IS NOT NULL
        AND account_authz_version IS NOT NULL
        AND (
          (
            account_owner_kind = 'tenant'
            AND profile_account_authz_version IS NOT NULL
            AND pool_id IS NULL
            AND pool_authz_version IS NULL
            AND pool_member_account_authz_version IS NULL
            AND pool_grant_authz_version IS NULL
            AND pool_grant_profile_authz_version IS NULL
            AND pool_grant_pool_authz_version IS NULL
          )
          OR
          (
            account_owner_kind = 'platform'
            AND profile_account_authz_version IS NULL
            AND pool_id IS NOT NULL
            AND pool_authz_version IS NOT NULL
            AND pool_member_account_authz_version IS NOT NULL
            AND pool_grant_authz_version IS NOT NULL
            AND pool_grant_profile_authz_version IS NOT NULL
            AND pool_grant_pool_authz_version IS NOT NULL
          )
        )
      )
    ),
  ADD CONSTRAINT saas_attempts_dispatch_tenant_credential_fk
    FOREIGN KEY (tenant_id, tenant_credential_id, credential_version)
    REFERENCES saas_tenant_provider_credential_versions (tenant_id, credential_id, version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_attempts_dispatch_platform_credential_fk
    FOREIGN KEY (platform_credential_id, credential_version)
    REFERENCES saas_platform_provider_credential_versions (credential_id, version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_attempts_dispatch_byok_profile_account_fk
    FOREIGN KEY (tenant_id, dispatch_profile_id, tenant_account_id)
    REFERENCES saas_tenant_provider_supply_profile_accounts (tenant_id, supply_profile_id, account_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_attempts_dispatch_platform_pool_grant_fk
    FOREIGN KEY (pool_id, tenant_id, dispatch_profile_id)
    REFERENCES saas_platform_provider_pool_grants (pool_id, tenant_id, supply_profile_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_attempts_dispatch_platform_pool_member_fk
    FOREIGN KEY (pool_id, platform_account_id)
    REFERENCES saas_platform_provider_pool_members (pool_id, account_id)
    ON DELETE RESTRICT;

CREATE INDEX saas_attempts_dispatch_authority_lookup_idx
  ON saas_attempts (tenant_id, dispatch_authority_state, credential_id, credential_version);
CREATE INDEX saas_attempts_dispatch_pool_lookup_idx
  ON saas_attempts (tenant_id, pool_id, platform_account_id)
  WHERE dispatch_authority_state = 'bound' AND account_owner_kind = 'platform';

CREATE FUNCTION saas_attempts_guard_dispatch_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.dispatch_state <> 'not_sent' THEN
      IF OLD.dispatch_authority_state IS DISTINCT FROM NEW.dispatch_authority_state
        OR OLD.dispatch_profile_id IS DISTINCT FROM NEW.dispatch_profile_id
        OR OLD.supply_profile_authz_version IS DISTINCT FROM NEW.supply_profile_authz_version
        OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
        OR OLD.credential_version IS DISTINCT FROM NEW.credential_version
        OR OLD.credential_authz_version IS DISTINCT FROM NEW.credential_authz_version
        OR OLD.account_authz_version IS DISTINCT FROM NEW.account_authz_version
        OR OLD.pool_id IS DISTINCT FROM NEW.pool_id
        OR OLD.pool_authz_version IS DISTINCT FROM NEW.pool_authz_version
        OR OLD.pool_member_account_authz_version IS DISTINCT FROM NEW.pool_member_account_authz_version
        OR OLD.pool_grant_authz_version IS DISTINCT FROM NEW.pool_grant_authz_version
        OR OLD.pool_grant_profile_authz_version IS DISTINCT FROM NEW.pool_grant_profile_authz_version
        OR OLD.pool_grant_pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version
        OR OLD.profile_account_authz_version IS DISTINCT FROM NEW.profile_account_authz_version
      THEN
        RAISE EXCEPTION 'SaaS attempt dispatch authority is immutable once dispatch starts'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.dispatch_authority_state = 'unbound'
      AND NEW.dispatch_authority_state = 'bound'
    THEN
      RAISE EXCEPTION 'Unbound SaaS attempts cannot be rebound after admission'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.dispatch_authority_state = 'unbound' THEN
    IF NEW.dispatch_state <> 'not_sent' THEN
      RAISE EXCEPTION 'Unbound SaaS attempts are non-dispatchable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.dispatch_authority_state IS DISTINCT FROM 'bound' THEN
    RAISE EXCEPTION 'SaaS attempt dispatch authority state is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.dispatch_state NOT IN ('not_sent', 'dispatching') THEN
    RAISE EXCEPTION 'A SaaS attempt must persist dispatch authority before dispatch'
      USING ERRCODE = '55000';
  END IF;

  SELECT supply_mode, supply_profile_id, protocol, endpoint
    INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id
     AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt dispatch authority request was not found'
      USING ERRCODE = '23514';
  END IF;

  IF request_record.protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR request_record.supply_profile_id IS DISTINCT FROM NEW.dispatch_profile_id
  THEN
    RAISE EXCEPTION 'SaaS attempt dispatch authority does not match its request'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM saas_supply_profiles AS profile
     WHERE profile.tenant_id = NEW.tenant_id
       AND profile.id = NEW.dispatch_profile_id
       AND profile.supply_mode = request_record.supply_mode
       AND profile.status = 'active'
       AND profile.authz_version = NEW.supply_profile_authz_version
  ) THEN
    RAISE EXCEPTION 'SaaS attempt dispatch authority profile epoch is stale or mismatched'
      USING ERRCODE = '23514';
  END IF;

  IF request_record.supply_mode = 'byok' THEN
    IF NEW.account_owner_kind IS DISTINCT FROM 'tenant'
      OR NEW.tenant_account_id IS NULL
      OR NEW.platform_account_id IS NOT NULL
      OR NEW.supplier_cost_version IS NOT NULL
      OR NEW.pool_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'A BYOK dispatch authority must use a tenant account mapping'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_tenant_provider_accounts AS account
       WHERE account.tenant_id = NEW.tenant_id
         AND account.id = NEW.tenant_account_id
         AND account.provider_id = NEW.provider_id
         AND account.product_id = NEW.product_id
         AND account.status = 'active'
         AND account.validation_state = 'verified'
         AND account.authz_version = NEW.account_authz_version
    ) THEN
      RAISE EXCEPTION 'SaaS attempt tenant account authority is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_tenant_provider_credentials AS credential
        JOIN saas_tenant_provider_credential_versions AS version
          ON version.tenant_id = credential.tenant_id
         AND version.credential_id = credential.id
         AND version.version = NEW.credential_version
       WHERE credential.tenant_id = NEW.tenant_id
         AND credential.id = NEW.credential_id
         AND credential.account_id = NEW.tenant_account_id
         AND credential.provider_id = NEW.provider_id
         AND credential.product_id = NEW.product_id
         AND credential.status = 'active'
         AND credential.validation_state = 'verified'
         AND credential.current_version = NEW.credential_version
         AND credential.authz_version = NEW.credential_authz_version
         AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
         AND version.account_id = NEW.tenant_account_id
         AND version.status = 'active'
         AND (version.expires_at IS NULL OR version.expires_at > clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'SaaS attempt tenant credential version is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_tenant_provider_supply_profile_accounts AS mapping
       WHERE mapping.tenant_id = NEW.tenant_id
         AND mapping.supply_profile_id = NEW.dispatch_profile_id
         AND mapping.supply_mode = 'byok'
         AND mapping.account_id = NEW.tenant_account_id
         AND mapping.provider_id = NEW.provider_id
         AND mapping.product_id = NEW.product_id
         AND mapping.account_authz_version = NEW.account_authz_version
         AND mapping.authz_version = NEW.profile_account_authz_version
         AND mapping.status = 'active'
         AND mapping.effective_at <= clock_timestamp()
         AND (mapping.expires_at IS NULL OR mapping.expires_at > clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'SaaS attempt BYOK profile-account mapping is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;
  ELSIF request_record.supply_mode = 'platform' THEN
    IF NEW.account_owner_kind IS DISTINCT FROM 'platform'
      OR NEW.tenant_account_id IS NOT NULL
      OR NEW.platform_account_id IS NULL
      OR NEW.supplier_cost_version IS NULL
      OR NEW.pool_id IS NULL
    THEN
      RAISE EXCEPTION 'A platform dispatch authority must use a platform pool grant'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_platform_provider_accounts AS account
       WHERE account.id = NEW.platform_account_id
         AND account.provider_id = NEW.provider_id
         AND account.product_id = NEW.product_id
         AND account.status = 'active'
         AND account.validation_state = 'verified'
         AND account.authz_version = NEW.account_authz_version
    ) THEN
      RAISE EXCEPTION 'SaaS attempt platform account authority is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_platform_provider_credentials AS credential
        JOIN saas_platform_provider_credential_versions AS version
          ON version.credential_id = credential.id
         AND version.version = NEW.credential_version
       WHERE credential.id = NEW.credential_id
         AND credential.account_id = NEW.platform_account_id
         AND credential.provider_id = NEW.provider_id
         AND credential.product_id = NEW.product_id
         AND credential.status = 'active'
         AND credential.validation_state = 'verified'
         AND credential.current_version = NEW.credential_version
         AND credential.authz_version = NEW.credential_authz_version
         AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
         AND version.account_id = NEW.platform_account_id
         AND version.status = 'active'
         AND (version.expires_at IS NULL OR version.expires_at > clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'SaaS attempt platform credential version is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_platform_provider_pools AS pool
       WHERE pool.id = NEW.pool_id
         AND pool.provider_id = NEW.provider_id
         AND pool.product_id = NEW.product_id
         AND pool.status = 'active'
         AND pool.validation_state = 'verified'
         AND pool.authz_version = NEW.pool_authz_version
    ) THEN
      RAISE EXCEPTION 'SaaS attempt platform pool authority is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_platform_provider_pool_members AS member
       WHERE member.pool_id = NEW.pool_id
         AND member.account_id = NEW.platform_account_id
         AND member.provider_id = NEW.provider_id
         AND member.product_id = NEW.product_id
         AND member.status = 'active'
         AND member.account_authz_version = NEW.pool_member_account_authz_version
         AND member.account_authz_version = NEW.account_authz_version
    ) THEN
      RAISE EXCEPTION 'SaaS attempt platform pool membership is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM saas_platform_provider_pool_grants AS grant_record
       WHERE grant_record.pool_id = NEW.pool_id
         AND grant_record.tenant_id = NEW.tenant_id
         AND grant_record.supply_profile_id = NEW.dispatch_profile_id
         AND grant_record.supply_mode = 'platform'
         AND grant_record.status = 'active'
         AND grant_record.profile_authz_version = NEW.pool_grant_profile_authz_version
         AND grant_record.pool_authz_version = NEW.pool_grant_pool_authz_version
         AND grant_record.authz_version = NEW.pool_grant_authz_version
         AND grant_record.profile_authz_version = NEW.supply_profile_authz_version
         AND grant_record.pool_authz_version = NEW.pool_authz_version
         AND grant_record.effective_at <= clock_timestamp()
         AND (grant_record.expires_at IS NULL OR grant_record.expires_at > clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'SaaS attempt platform pool grant is stale or mismatched'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'SaaS attempt request has an invalid supply mode'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_dispatch_authority
  BEFORE INSERT OR UPDATE ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_dispatch_authority();
`;

export const ATTEMPT_DISPATCH_AUTHORITY_SAAS_MIGRATION: SaasMigration = {
  version: 19,
  name: 'attempt_dispatch_authority_refs_and_epochs',
  sql: attemptDispatchAuthoritySchemaSql,
};
