import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BILLING_GROUPS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/105_billing_groups.js';

test('migration 105 defines billing groups, account pools, key/tenant binding, and the snapshot multiplier freeze', () => {
  const migration = BILLING_GROUPS_SAAS_MIGRATION;
  assert.equal(migration.version, 105);
  assert.equal(migration.name, 'billing_groups');
  assert.match(migration.sql, /CREATE TABLE saas_billing_groups \(/);
  assert.match(migration.sql, /rate_multiplier_num bigint NOT NULL DEFAULT 1 CHECK \(rate_multiplier_num > 0\)/);
  assert.match(migration.sql, /topup_multiplier_num bigint NOT NULL DEFAULT 1 CHECK \(topup_multiplier_num > 0\)/);
  assert.match(migration.sql, /peak_enabled boolean NOT NULL DEFAULT false/);
  assert.match(migration.sql, /peak_start time/);
  assert.match(migration.sql, /model_pricing jsonb/);
  assert.match(migration.sql, /profit_min_margin_num bigint/);
  assert.match(migration.sql, /claude_code_only boolean NOT NULL DEFAULT false/);
  assert.match(migration.sql, /fallback_group_id text REFERENCES saas_billing_groups \(id\) ON DELETE RESTRICT/);
  assert.match(migration.sql, /saas_billing_groups_no_self_fallback/);
  assert.match(migration.sql, /status text NOT NULL DEFAULT 'active' CHECK \(status IN \('active', 'disabled'\)\)/);
  // The seeded neutral default group keeps pre-R1 pricing bit-identical.
  assert.match(migration.sql, /INSERT INTO saas_billing_groups \(id, display_name\)\s+VALUES \('default', 'Default'\)/);
  assert.match(migration.sql, /CREATE TABLE saas_billing_group_account_pools \(/);
  assert.match(
    migration.sql,
    /account_id text NOT NULL REFERENCES saas_platform_provider_accounts \(id\) ON DELETE CASCADE/,
  );
  assert.match(migration.sql, /priority integer NOT NULL DEFAULT 50 CHECK \(priority >= 0 AND priority <= 1000\)/);
  assert.match(migration.sql, /PRIMARY KEY \(group_id, account_id\)/);
  // Key/tenant binding with the seeded default backfill.
  assert.match(
    migration.sql,
    /ALTER TABLE saas_api_keys\s+ADD COLUMN billing_group_id text REFERENCES saas_billing_groups \(id\) ON DELETE RESTRICT DEFAULT 'default'/,
  );
  assert.match(
    migration.sql,
    /ALTER TABLE saas_tenants\s+ADD COLUMN default_billing_group_id text REFERENCES saas_billing_groups \(id\) ON DELETE RESTRICT DEFAULT 'default'/,
  );
  // Admission-time multiplier freeze on the immutable customer price snapshot.
  assert.match(
    migration.sql,
    /ADD COLUMN billing_group_id text REFERENCES saas_billing_groups \(id\) ON DELETE RESTRICT/,
  );
  assert.match(
    migration.sql,
    /ADD COLUMN rate_multiplier_num bigint NOT NULL DEFAULT 1 CHECK \(rate_multiplier_num > 0\)/,
  );
  assert.match(migration.sql, /ADD COLUMN peak_applied boolean NOT NULL DEFAULT false/);
  assert.match(migration.sql, /ADD COLUMN model_pricing_override_digest text/);
  assert.match(migration.sql, /ADD COLUMN model_pricing_override jsonb/);
  assert.match(migration.sql, /saas_request_customer_price_snapshots_override_shape/);
});
