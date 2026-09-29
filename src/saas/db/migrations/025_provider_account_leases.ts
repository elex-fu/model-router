import type { SaasMigration } from './001_initial_schema.js';

/*
 * Provider-account leases are short-lived coordination facts, not account
 * authority.  A lease row is never reused: expiry/release changes its state
 * and every new holder receives a fresh sequence value and row identity.
 * The service locks the authoritative account first, then the account's held
 * slot rows, so competing PostgreSQL callers cannot overbook a configured
 * account concurrency limit.
 */
const providerAccountLeaseSchemaSql = `
CREATE SEQUENCE saas_provider_account_lease_fencing_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1;

CREATE TABLE saas_provider_account_leases (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  owner_kind text NOT NULL CHECK (owner_kind IN ('tenant', 'platform')),
  owner_tenant_id uuid REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  account_id text NOT NULL,
  upstream_id text NOT NULL,
  attempt_id text NOT NULL,
  slot integer NOT NULL CHECK (slot >= 0),
  fencing_token bigint NOT NULL DEFAULT nextval('saas_provider_account_lease_fencing_seq')
    CHECK (fencing_token >= 1),
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'released', 'expired')),
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_provider_account_leases_id_nonempty
    CHECK (btrim(id) <> '' AND id = btrim(id)),
  CONSTRAINT saas_provider_account_leases_account_nonempty
    CHECK (btrim(account_id) <> '' AND account_id = btrim(account_id)),
  CONSTRAINT saas_provider_account_leases_upstream_nonempty
    CHECK (btrim(upstream_id) <> '' AND upstream_id = btrim(upstream_id)),
  CONSTRAINT saas_provider_account_leases_attempt_nonempty
    CHECK (btrim(attempt_id) <> '' AND attempt_id = btrim(attempt_id)),
  CONSTRAINT saas_provider_account_leases_owner_scope
    CHECK (
      (owner_kind = 'tenant' AND owner_tenant_id IS NOT NULL)
      OR (owner_kind = 'platform' AND owner_tenant_id IS NULL)
    ),
  CONSTRAINT saas_provider_account_leases_lifecycle_shape
    CHECK (
      (status = 'held' AND released_at IS NULL)
      OR (status IN ('released', 'expired') AND released_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX saas_provider_account_leases_held_slot_unique
  ON saas_provider_account_leases (owner_kind, owner_tenant_id, account_id, slot)
  WHERE status = 'held';

CREATE UNIQUE INDEX saas_provider_account_leases_fencing_token_unique
  ON saas_provider_account_leases (fencing_token);

CREATE INDEX saas_provider_account_leases_account_state_idx
  ON saas_provider_account_leases (owner_kind, owner_tenant_id, account_id, status, lease_expires_at);

CREATE INDEX saas_provider_account_leases_attempt_idx
  ON saas_provider_account_leases (tenant_id, attempt_id, status);

CREATE FUNCTION saas_provider_account_leases_guard_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
    OR NEW.owner_tenant_id IS DISTINCT FROM OLD.owner_tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.upstream_id IS DISTINCT FROM OLD.upstream_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.slot IS DISTINCT FROM OLD.slot
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Provider account lease identity and fencing token are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'held' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
      OR NEW.released_at IS DISTINCT FROM OLD.released_at
    THEN
      RAISE EXCEPTION 'Terminal provider account leases are immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.status NOT IN ('held', 'released', 'expired') THEN
    RAISE EXCEPTION 'Invalid provider account lease state'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_provider_account_leases_guard_identity
  BEFORE UPDATE ON saas_provider_account_leases
  FOR EACH ROW EXECUTE FUNCTION saas_provider_account_leases_guard_identity();

CREATE FUNCTION saas_provider_account_leases_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider account leases are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_provider_account_leases_no_delete
  BEFORE DELETE ON saas_provider_account_leases
  FOR EACH ROW EXECUTE FUNCTION saas_provider_account_leases_no_delete();
`;

export const PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION: SaasMigration = {
  version: 25,
  name: 'provider_account_leases_with_fencing',
  sql: providerAccountLeaseSchemaSql,
};
