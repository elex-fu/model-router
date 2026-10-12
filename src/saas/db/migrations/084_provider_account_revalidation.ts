import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track D3: account-level periodic credential revalidation cadence. NULL
 * (the default for every existing row) disables periodic revalidation,
 * which is exactly the pre-D3 behavior. Bounds: 15 minutes to 7 days —
 * anything tighter would churn the validation queue, anything looser is
 * operationally indistinguishable from disabled. No trigger, ACL, epoch,
 * or lifecycle shape changes. Numbered 084 (ledger reassignment): Track D
 * consumes the next dense slot after 083; E/F/G shift one slot forward
 * (docs/contracts-m0-freeze.md arbitration table).
 */
const providerAccountRevalidationSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN revalidation_interval_seconds integer,
  ADD CONSTRAINT saas_tenant_provider_accounts_revalidation_interval_range
    CHECK (revalidation_interval_seconds IS NULL
      OR (revalidation_interval_seconds >= 900 AND revalidation_interval_seconds <= 604800));

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN revalidation_interval_seconds integer,
  ADD CONSTRAINT saas_platform_provider_accounts_revalidation_interval_range
    CHECK (revalidation_interval_seconds IS NULL
      OR (revalidation_interval_seconds >= 900 AND revalidation_interval_seconds <= 604800));
`;

export const PROVIDER_ACCOUNT_REVALIDATION_SAAS_MIGRATION: SaasMigration = {
  version: 84,
  name: 'provider_account_revalidation_interval',
  sql: providerAccountRevalidationSql,
};
