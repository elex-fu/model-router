import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track D4 provider account quota snapshots (design:
 * docs/parallel-iteration-plan-2026-10-10.md Track D). The quota sync worker
 * overwrites these columns in place; they are a point-in-time scheduling
 * signal only and never enter the billing path. NULL means "never checked"
 * and 'unknown' means "the last check produced no trustworthy answer"; both
 * leave scheduling exactly on its pre-D4 behavior, so the columns are fully
 * backward compatible with existing rows and require no backfill.
 *
 * The snapshot lives on the two account tables (not a side table) because it
 * is strictly 1:1 with the account, has no independent identity or history,
 * and is consumed by the same eligibility query that already reads the
 * account row — mirroring the 082 priority/weight precedent for scheduling
 * signals.
 *
 * Shape invariants, enforced for every writer:
 * - quota_state and quota_checked_at are always set together (a check exists
 *   iff it was attempted);
 * - quota_remaining_minor_units and quota_currency are always set together;
 * - an 'unknown' (or never-checked) snapshot carries no remaining amount:
 *   the worker never guesses a number it did not parse exactly.
 * Amounts are fixed-point minor units as decimal text; '0' is a legitimate
 * exhausted balance, unlike funding amounts.
 *
 * Numbered 093 (ledger reassignment): 090/091 remain reserved for Track G2
 * promo codes / G3 affiliate rewards; the marketing-reserved segment's 093
 * slot is reassigned to Track D4 and the marketing evolution segment defers
 * to 094-098, per the contracts-m0-freeze ledger arbitration.
 */
const providerAccountQuotaSnapshotsSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN quota_state text,
  ADD COLUMN quota_remaining_minor_units text,
  ADD COLUMN quota_currency text,
  ADD COLUMN quota_checked_at timestamptz,
  ADD CONSTRAINT saas_tenant_provider_accounts_quota_state_values
    CHECK (quota_state IS NULL OR quota_state IN ('unknown', 'ok', 'low', 'exhausted')),
  ADD CONSTRAINT saas_tenant_provider_accounts_quota_remaining_format
    CHECK (quota_remaining_minor_units IS NULL OR quota_remaining_minor_units ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT saas_tenant_provider_accounts_quota_currency_format
    CHECK (quota_currency IS NULL OR quota_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT saas_tenant_provider_accounts_quota_shape
    CHECK (
      (quota_state IS NULL) = (quota_checked_at IS NULL)
      AND (quota_remaining_minor_units IS NULL) = (quota_currency IS NULL)
      AND (quota_state IS NULL OR quota_state = 'unknown') = (quota_remaining_minor_units IS NULL)
    );

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN quota_state text,
  ADD COLUMN quota_remaining_minor_units text,
  ADD COLUMN quota_currency text,
  ADD COLUMN quota_checked_at timestamptz,
  ADD CONSTRAINT saas_platform_provider_accounts_quota_state_values
    CHECK (quota_state IS NULL OR quota_state IN ('unknown', 'ok', 'low', 'exhausted')),
  ADD CONSTRAINT saas_platform_provider_accounts_quota_remaining_format
    CHECK (quota_remaining_minor_units IS NULL OR quota_remaining_minor_units ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT saas_platform_provider_accounts_quota_currency_format
    CHECK (quota_currency IS NULL OR quota_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT saas_platform_provider_accounts_quota_shape
    CHECK (
      (quota_state IS NULL) = (quota_checked_at IS NULL)
      AND (quota_remaining_minor_units IS NULL) = (quota_currency IS NULL)
      AND (quota_state IS NULL OR quota_state = 'unknown') = (quota_remaining_minor_units IS NULL)
    );

CREATE INDEX saas_tenant_provider_accounts_quota_due_idx
  ON saas_tenant_provider_accounts (quota_checked_at, tenant_id, id)
  WHERE status = 'active';

CREATE INDEX saas_platform_provider_accounts_quota_due_idx
  ON saas_platform_provider_accounts (quota_checked_at, id)
  WHERE status = 'active';
`;

export const PROVIDER_ACCOUNT_QUOTA_SNAPSHOTS_SAAS_MIGRATION: SaasMigration = {
  version: 93,
  name: 'provider_account_quota_snapshots',
  sql: providerAccountQuotaSnapshotsSql,
};
