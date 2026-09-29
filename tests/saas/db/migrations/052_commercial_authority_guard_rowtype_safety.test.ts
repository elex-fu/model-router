import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/023_commercial_metering_policy_authority.js';
import { COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/052_commercial_authority_guard_rowtype_safety.js';

test('migration 052 uses initialized scalar snapshots for optional commercial price checks', () => {
  const source = COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql;
  const start = source.indexOf('CREATE FUNCTION saas_route_config_commercial_authority_guard() RETURNS trigger');
  assert.notEqual(start, -1);
  const end = source.indexOf('\n$$;', start);
  assert.notEqual(end, -1);
  const originalGuard = source.slice(start, end + '\n$$;'.length);
  const expectedGuard = originalGuard
    .replace(
      'CREATE FUNCTION saas_route_config_commercial_authority_guard() RETURNS trigger',
      'CREATE OR REPLACE FUNCTION saas_route_config_commercial_authority_guard() RETURNS trigger',
    )
    .replace('  price_record record;', '  price_effective_at timestamptz;\n  price_expires_at timestamptz;')
    .replace('  cost_record record;', '  cost_effective_at timestamptz;\n  cost_expires_at timestamptz;')
    .replace('      INTO price_record\n', '      INTO price_effective_at, price_expires_at\n')
    .replace('      INTO cost_record\n', '      INTO cost_effective_at, cost_expires_at\n')
    .replaceAll('price_record.effective_at', 'price_effective_at')
    .replaceAll('price_record.expires_at', 'price_expires_at')
    .replaceAll('cost_record.effective_at', 'cost_effective_at')
    .replaceAll('cost_record.expires_at', 'cost_expires_at');
  const expected = `${expectedGuard}\n\nGRANT SELECT (version, name, checksum)\n  ON TABLE model_router_saas.saas_schema_migrations\n  TO model_router_saas_gateway;`;

  assert.equal(COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION.version, 52);
  assert.equal(COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION.name, 'commercial_authority_guard_rowtype_safety');
  assert.equal(SAAS_MIGRATIONS[51], COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS.at(-1)?.version, 52);
  assert.equal(COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION.sql, expected);
  assert.match(COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION.sql, /GRANT SELECT \(version, name, checksum\)/);
});
