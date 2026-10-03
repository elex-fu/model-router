import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PLATFORM_WALLET_LEDGER_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/011_platform_wallet_ledger.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';
import { COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/053_commercial_authority_read_fences.js';
import { TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/054_trigger_only_trusted_execution.js';

const sql = TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION.sql;
const wrappers = [
  'saas_prepared_evidence_authorization_writer_fence()',
  'saas_billing_check_ledger_transaction()',
  'saas_billing_check_ledger_entry_transaction()',
];

function expectedBody(name: string): string {
  const tag = `$expected_${name}$`;
  const start = sql.indexOf(tag);
  const end = sql.indexOf(tag, start + tag.length);
  assert.ok(start >= 0 && end > start);
  return sql.slice(start + tag.length, end);
}

function historicalBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE FUNCTION ${name}(`);
  const bodyStart = source.indexOf('AS $$', start);
  const end = source.indexOf('\n$$;', bodyStart);
  assert.ok(start >= 0 && bodyStart > start && end > bodyStart);
  return source.slice(bodyStart + 'AS $$'.length, end + 1);
}

test('054 preserves its exact forward append and exactly three trigger-only metadata targets', () => {
  assert.equal(SAAS_MIGRATIONS[52], COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(53, 54), [TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION]);
  assert.equal(TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION.version, 54);
  assert.equal(TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION.name, 'trigger_only_trusted_execution');
  const targetLoop = sql.match(/FOREACH target_signature IN ARRAY ARRAY\[([^\]]+)\] LOOP/);
  assert.ok(targetLoop);
  assert.equal(targetLoop[1], wrappers.map((name) => `'${name}'`).join(', '));
  assert.equal((sql.match(/EXECUTE format\(/g) ?? []).length, 2);
  assert.match(sql, /ALTER FUNCTION model_router_saas\.%s SECURITY DEFINER/);
  assert.match(sql, /SET search_path TO pg_catalog, model_router_saas, pg_temp/);
  assert.doesNotMatch(sql, /^\s*(?:GRANT|REVOKE|CREATE FUNCTION|CREATE OR REPLACE FUNCTION|DROP|ALTER TABLE|ALTER ROLE)\b/im);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM|INSERT INTO) saas_schema_migrations/);
});

test('054 attests all wrapper/helper/immutability bodies byte-for-byte without replacing them', () => {
  for (const name of ['saas_prepared_evidence_authorization_writer_fence', 'saas_prepared_evidence_writer_require_value',
    'saas_prepared_evidence_writer_lock_layer', 'saas_prepared_evidence_writer_composite_key']) {
    assert.equal(expectedBody(name), historicalBody(PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql, name));
  }
  for (const name of ['saas_billing_assert_ledger_transaction_balanced', 'saas_billing_check_ledger_transaction',
    'saas_billing_check_ledger_entry_transaction', 'saas_billing_reject_ledger_mutation']) {
    assert.equal(expectedBody(name), historicalBody(PLATFORM_WALLET_LEDGER_SAAS_MIGRATION.sql, name));
  }
  assert.match(expectedBody('saas_billing_assert_ledger_transaction_balanced'), /entry_count < 2/);
  assert.match(expectedBody('saas_billing_assert_ledger_transaction_balanced'), /debit_total <> credit_total/);
  assert.match(expectedBody('saas_billing_assert_ledger_transaction_balanced'), /debit_total <> transaction_amount/);
  assert.match(expectedBody('saas_billing_reject_ledger_mutation'), /ERRCODE = '55000'/);
  assert.match(sql, /routine\.prosrc IS DISTINCT FROM expected\.source/);
  assert.match(sql, /routine\.proowner IS DISTINCT FROM trusted_owner/);
  assert.match(sql, /routine\.prosecdef OR routine\.proconfig IS NOT NULL/);
});

test('054 validates every actual 050 trigger including binary TG_ARGV and ledger deferral/immutability bindings', () => {
  const canonical = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql;
  const writerBindings = [...canonical.matchAll(
    /CREATE TRIGGER (saas_\w+)\n  BEFORE INSERT OR UPDATE OR DELETE ON (saas_\w+)\n  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence\(([^;]+)\);/g,
  )];
  assert.equal(writerBindings.length, 28);
  for (const [, name, relation, argumentSql] of writerBindings) {
    const args = [...argumentSql!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    const encoded = args.map((arg) => `${Buffer.from(arg).toString('hex')}00`).join('');
    assert.ok(sql.includes(`('${relation}', '${name}', '${wrappers[0]}', 31, false, ${args.length}, '${encoded}')`));
  }
  assert.match(sql, /t\.tgargs = decode\(binding\.arguments_hex, 'hex'\)/);
  assert.match(sql, /t\.tgqual IS NULL AND t\.tgattr::text = ''/);
  assert.match(sql, /t\.tgenabled = 'O'/);
  assert.match(sql, /t\.tgdeferrable = binding\.deferred/);
  assert.match(sql, /t\.tginitdeferred = binding\.deferred/);
  assert.match(sql, /\(t\.tgconstraint <> 0\) = binding\.deferred/);
  assert.match(sql, /count\(\*\) FROM pg_trigger WHERE tgfoid = ANY\(target_oids\)\) <> 30/);
  for (const relation of ['saas_ledger_transactions', 'saas_ledger_entries']) {
    assert.ok(sql.includes(`'${relation}_immutable', 'saas_billing_reject_ledger_mutation()', 27, false, 0, ''`));
    assert.ok(sql.includes(`'${relation}_no_truncate', 'saas_billing_reject_ledger_mutation()', 34, false, 0, ''`));
  }
});

test('054 fails closed on unsafe ownership/callability and proves body/function/table/column ACLs unchanged', () => {
  assert.match(sql, /nspowner = trusted_owner/);
  assert.match(sql, /NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication/);
  assert.match(sql, /pg_has_role\(oid, trusted_owner, 'MEMBER'\)/);
  assert.match(sql, /has_schema_privilege\(oid, managed_schema, 'CREATE'\)/);
  assert.match(sql, /has_table_privilege\(oid,.*'TRIGGER'\)/);
  assert.match(sql, /grantee = 0 AND privilege_type = 'EXECUTE'/);
  assert.match(sql, /has_function_privilege\(r\.oid, p\.oid, 'EXECUTE'\)/);
  assert.match(sql, /has_any_column_privilege\(oid, 'model_router_saas\.saas_api_keys', 'UPDATE'\)/);
  assert.equal((sql.match(/to_jsonb\(p\) - 'prosecdef' - 'proconfig'/g) ?? []).length, 2);
  for (const contract of ['function_catalog', 'table_acl', 'column_acl', 'trigger_catalog']) {
    assert.ok(sql.includes(`${contract}_after IS DISTINCT FROM ${contract}_before`));
  }
  assert.match(sql, /p\.prosecdef IS DISTINCT FROM \(p\.oid = ANY\(target_oids\)\)/);
  assert.match(sql, /p\.proconfig IS DISTINCT FROM ARRAY\['search_path=pg_catalog, model_router_saas, pg_temp'\]/);
});
