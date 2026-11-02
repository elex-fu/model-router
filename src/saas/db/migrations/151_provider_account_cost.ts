import type { SaasMigration } from './001_initial_schema.js';

/**
 * Operational subscription-account cost ledger (personal token resale plan
 * section 4.6). Amounts are integer minor units. The account reference is
 * deliberately owner-neutral, matching saas_attempts.account_id: platform and
 * tenant provider accounts share the same text identity and cannot both be
 * covered by one foreign key.
 *
 * Replacing a cost closes the preceding effective interval and appends a new
 * row. The partial unique index permits only one open-ended row per account;
 * the serialized trigger also rejects finite/overlapping intervals. This is
 * control-plane data only and is never read or written by request dispatch.
 */
const providerAccountCostSql = `
CREATE TABLE provider_account_cost (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  price_minor_units bigint NOT NULL CHECK (price_minor_units > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period text NOT NULL CHECK (period IN ('month', 'quarter', 'year')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  source_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_account_cost_id_nonempty CHECK (
    char_length(id) BETWEEN 1 AND 255 AND id = btrim(id)
  ),
  CONSTRAINT provider_account_cost_account_nonempty CHECK (
    btrim(account_id) <> '' AND account_id = btrim(account_id)
  ),
  CONSTRAINT provider_account_cost_window CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT provider_account_cost_source_note CHECK (
    source_note IS NULL OR (btrim(source_note) <> '' AND char_length(source_note) <= 1024)
  )
);

CREATE UNIQUE INDEX provider_account_cost_one_current_idx
  ON provider_account_cost (account_id)
  WHERE effective_to IS NULL;

CREATE INDEX provider_account_cost_account_effective_idx
  ON provider_account_cost (account_id, effective_from DESC, effective_to);

CREATE INDEX provider_account_cost_report_idx
  ON provider_account_cost (currency, effective_from)
  INCLUDE (account_id, effective_to);

CREATE FUNCTION provider_account_cost_reject_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The advisory lock closes the race between concurrent replacements for
  -- the same account; the unique index alone cannot detect finite overlaps.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.account_id));
  IF EXISTS (
    SELECT 1
      FROM provider_account_cost existing
     WHERE existing.account_id = NEW.account_id
       AND existing.id <> NEW.id
       AND existing.effective_from < COALESCE(NEW.effective_to, 'infinity'::timestamptz)
       AND COALESCE(existing.effective_to, 'infinity'::timestamptz) > NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'Provider account cost effective intervals may not overlap'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION provider_account_cost_reject_overlap()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER provider_account_cost_no_overlap
  BEFORE INSERT OR UPDATE OF account_id, effective_from, effective_to ON provider_account_cost
  FOR EACH ROW EXECUTE FUNCTION provider_account_cost_reject_overlap();
`;

export const PROVIDER_ACCOUNT_COST_SAAS_MIGRATION: SaasMigration = {
  version: 151,
  name: 'provider_account_cost',
  sql: providerAccountCostSql,
};
