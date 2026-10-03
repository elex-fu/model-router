import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/015_provider_supply_accounts.js';
import { PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION } from '../../../src/saas/db/migrations/033_payment_webhook_durable_inbox.js';
import { PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/034_provider_catalog_product_write_fence.js';

const migration = PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION;
const sql = migration.sql;

function functionSql(name: string): string {
  const match = sql.match(new RegExp(`CREATE FUNCTION ${name}\\(\\) RETURNS trigger[\\s\\S]*?\\$\\$;`, 'i'));
  assert.ok(match, `Expected migration SQL to define ${name}`);
  return match[0];
}

test('migration 034 registers after the immutable 033 history', () => {
  assert.equal(migration.version, 34);
  assert.equal(migration.name, 'provider_catalog_product_write_fence');
  assert.equal(SAAS_MIGRATIONS[32], PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[33], migration);
  assert.equal(SAAS_MIGRATIONS.filter(({ version }) => version === 34).length, 1);
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
});

test('migration 034 locks the exact provider product before each catalog version insert', () => {
  assert.match(sql, /CREATE FUNCTION saas_catalog_lock_product_for_version_insert\(\)/i);
  assert.match(
    sql,
    /FROM saas_provider_products\s+WHERE provider_id = NEW\.provider_id\s+AND product_id = NEW\.product_id\s+FOR UPDATE/i,
  );
  assert.match(
    sql,
    /CREATE TRIGGER saas_provider_capabilities_lock_product\s+BEFORE INSERT ON saas_provider_capabilities[\s\S]+EXECUTE FUNCTION saas_catalog_lock_product_for_version_insert\(\)/i,
  );
  assert.match(
    sql,
    /CREATE TRIGGER saas_provider_rights_lock_product\s+BEFORE INSERT ON saas_provider_rights[\s\S]+EXECUTE FUNCTION saas_catalog_lock_product_for_version_insert\(\)/i,
  );
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|TRIGGER|FUNCTION)/i);
});

test('BYOK account rights qualification applies to INSERT and UPDATE with current rights checks', () => {
  const trigger =
    /CREATE TRIGGER saas_tenant_provider_accounts_require_byok_rights\s+BEFORE INSERT OR UPDATE ON saas_tenant_provider_accounts\s+FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_require_byok_rights\(\)/i;
  const validator = functionSql('saas_provider_supply_require_byok_rights');

  assert.match(sql, trigger);
  assert.match(validator, /IF NEW\.supply_mode IS DISTINCT FROM 'byok' THEN\s+RETURN NEW/i);
  assert.match(
    validator,
    /FROM saas_provider_products\s+WHERE provider_id = NEW\.provider_id\s+AND product_id = NEW\.product_id\s+FOR SHARE/i,
  );
  assert.match(
    validator,
    /rights\.rights_id = NEW\.rights_id[\s\S]+rights\.version = NEW\.rights_version[\s\S]+rights\.provider_id = NEW\.provider_id[\s\S]+rights\.product_id = NEW\.product_id[\s\S]+rights\.credential_type = NEW\.credential_type[\s\S]+rights\.supply_mode = NEW\.supply_mode[\s\S]+rights\.region = NEW\.region[\s\S]+rights\.purpose = NEW\.purpose/i,
  );
  assert.match(validator, /rights\.status = 'active'/i);
  assert.match(validator, /rights\.effective_at <= qualification_time/i);
  assert.match(validator, /rights\.expires_at IS NULL OR rights\.expires_at > qualification_time/i);
  assert.match(
    validator,
    /rights\.version = \([\s\S]+FROM saas_provider_rights AS latest[\s\S]+latest\.rights_id = rights\.rights_id[\s\S]+latest\.effective_at <= qualification_time[\s\S]+ORDER BY latest\.effective_at DESC, latest\.version DESC[\s\S]+LIMIT 1/i,
  );
  assert.match(
    validator,
    /USING ERRCODE = '23514',[\s\S]+CONSTRAINT = 'saas_tenant_provider_accounts_byok_rights_fence'/i,
  );
  assert.match(validator, /RAISE EXCEPTION 'Provider BYOK qualification is not valid'/i);
});

test('BYOK account capabilities qualify INSERT and UPDATE against current rights and capability', () => {
  const trigger =
    /CREATE TRIGGER saas_tenant_provider_account_capabilities_byok_fence\s+BEFORE INSERT OR UPDATE ON saas_tenant_provider_account_capabilities\s+FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_require_byok_capability\(\)/i;
  const validator = functionSql('saas_provider_supply_require_byok_capability');

  assert.match(sql, trigger);
  assert.match(
    validator,
    /FROM saas_provider_products\s+WHERE provider_id = NEW\.provider_id\s+AND product_id = NEW\.product_id\s+FOR SHARE/i,
  );
  assert.match(
    validator,
    /FROM saas_tenant_provider_accounts AS account\s+WHERE account\.tenant_id = NEW\.tenant_id\s+AND account\.id = NEW\.account_id\s+AND account\.provider_id = NEW\.provider_id\s+AND account\.product_id = NEW\.product_id/i,
  );
  assert.match(validator, /IF account_supply_mode IS DISTINCT FROM 'byok' THEN\s+RETURN NEW/i);
  assert.match(validator, /rights\.model_scope @> ARRAY\[NEW\.model\]::text\[\]/i);
  assert.match(validator, /rights\.endpoint_scope @> ARRAY\[NEW\.endpoint\]::text\[\]/i);
  assert.match(validator, /rights\.status = 'active'/i);
  assert.match(validator, /rights\.effective_at <= qualification_time/i);
  assert.match(validator, /rights\.expires_at IS NULL OR rights\.expires_at > qualification_time/i);
  assert.match(
    validator,
    /rights\.version = \([\s\S]+FROM saas_provider_rights AS latest[\s\S]+latest\.rights_id = rights\.rights_id[\s\S]+latest\.effective_at <= qualification_time[\s\S]+ORDER BY latest\.effective_at DESC, latest\.version DESC[\s\S]+LIMIT 1/i,
  );
  assert.match(
    validator,
    /capability\.provider_id = NEW\.provider_id[\s\S]+capability\.product_id = NEW\.product_id[\s\S]+capability\.model = NEW\.model[\s\S]+capability\.endpoint = NEW\.endpoint[\s\S]+capability\.version = NEW\.capability_version/i,
  );
  assert.match(validator, /capability\.version = \([\s\S]+max\(latest\.version\)/i);
  assert.match(validator, /capability\.validation_state = 'verified'/i);
  assert.match(validator, /capability\.support_level IN \('supported', 'limited'\)/i);
  assert.match(
    validator,
    /USING ERRCODE = '23514',[\s\S]+CONSTRAINT = 'saas_tenant_provider_account_capabilities_byok_fence'/i,
  );
  assert.match(validator, /RAISE EXCEPTION 'Provider BYOK capability qualification is not valid'/i);
});

test('migration 015 foreign keys preserve account and capability identity on UPDATE', () => {
  const supplySql = PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION.sql;

  assert.match(
    supplySql,
    /CONSTRAINT saas_tenant_provider_accounts_account_identity_unique\s+UNIQUE \(tenant_id, id, provider_id, product_id\)/i,
  );
  assert.match(
    supplySql,
    /CONSTRAINT saas_tenant_provider_account_capabilities_account_fk\s+FOREIGN KEY \(tenant_id, account_id, provider_id, product_id\)\s+REFERENCES saas_tenant_provider_accounts \(tenant_id, id, provider_id, product_id\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(
    supplySql,
    /CONSTRAINT saas_tenant_provider_account_capabilities_capability_fk\s+FOREIGN KEY \(provider_id, product_id, model, endpoint, capability_version\)\s+REFERENCES saas_provider_capabilities \(provider_id, product_id, model, endpoint, version\)\s+ON DELETE RESTRICT/i,
  );
});
