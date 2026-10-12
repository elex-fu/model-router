import type { SaasMigration } from './001_initial_schema.js';

/**
 * Contract C-7: persisted scheduling priority/weight for provider accounts.
 * Existing rows keep the frozen defaults (priority 0 / weight 1), which is
 * exactly the neutral tie behavior the scheduler hardcoded before this data
 * source existed. No trigger, ACL, epoch, or lifecycle shape changes.
 * Numbered 082 (ledger reassignment): the M0 registry's 064 slot predates the
 * serial integration order in which 080/081 landed first; a database that
 * applied 080/081 can never accept a lower-numbered migration (fail-closed
 * ordering), so Track D consumes 082+.
 */
const providerAccountSchedulingSql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN priority integer NOT NULL DEFAULT 0,
  ADD COLUMN weight integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT saas_tenant_provider_accounts_priority_range
    CHECK (priority >= 0 AND priority <= 1000),
  ADD CONSTRAINT saas_tenant_provider_accounts_weight_range
    CHECK (weight >= 1 AND weight <= 10000);

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN priority integer NOT NULL DEFAULT 0,
  ADD COLUMN weight integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT saas_platform_provider_accounts_priority_range
    CHECK (priority >= 0 AND priority <= 1000),
  ADD CONSTRAINT saas_platform_provider_accounts_weight_range
    CHECK (weight >= 1 AND weight <= 10000);
`;

export const PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION: SaasMigration = {
  version: 82,
  name: 'provider_account_scheduling_priority_weight',
  sql: providerAccountSchedulingSql,
};
