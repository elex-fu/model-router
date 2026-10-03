import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';

const repositorySource = readFileSync(
  resolve(process.cwd(), 'src/saas/supply/repository.ts'),
  'utf8',
);
const coreMatch = repositorySource.match(/const DISPATCH_CORE_SQL = `([\s\S]*?)`;/);
assert.ok(coreMatch, 'the production dispatch core SQL must be present');
const coreSql = coreMatch[1]!.replace(/\s+/g, ' ').trim();

// This is a source/SQL-contract regression, not a substitute for executing the
// restricted-role query on PG15/18. Derive columns from registered migration SQL,
// never from a fake dispatch row containing a nonexistent attempts.supply_mode.
function tableColumns(table: 'saas_attempts' | 'saas_requests'): ReadonlySet<string> {
  const columns = new Set<string>();
  for (const migration of SAAS_MIGRATIONS) {
    const create = migration.sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (create) {
      for (const column of create[1]!.matchAll(
        /^  ([a-z_][a-z0-9_]*)\s+(?:uuid|text|integer|bigint|boolean|timestamptz)\b/gm,
      )) columns.add(column[1]!);
    }
    for (const alter of migration.sql.matchAll(new RegExp(`ALTER TABLE ${table}\\s+([\\s\\S]*?);`, 'g'))) {
      for (const column of alter[1]!.matchAll(/\bADD COLUMN ([a-z_][a-z0-9_]*)\b/g)) columns.add(column[1]!);
    }
  }
  assert.ok(columns.has('id'), `${table} must have a real migration definition`);
  return columns;
}

test('dispatch core references real attempt/request columns and projects the parent request mode', () => {
  const attemptColumns = tableColumns('saas_attempts');
  const requestColumns = tableColumns('saas_requests');
  assert.equal(attemptColumns.has('supply_mode'), false);
  assert.equal(requestColumns.has('supply_mode'), true);
  assert.equal(attemptColumns.has('route_upstream_id'), false);
  assert.equal(requestColumns.has('route_upstream_id'), true);
  for (const [alias, columns] of [['a', attemptColumns], ['r', requestColumns]] as const) {
    for (const reference of coreSql.matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g'))) {
      assert.ok(columns.has(reference[1]!), `${alias}.${reference[1]} must exist in registered schema SQL`);
    }
  }
  assert.match(coreSql, /JOIN saas_attempts AS a ON a\.tenant_id = e\.tenant_id AND a\.id = e\.attempt_id/);
  assert.match(coreSql, /JOIN saas_requests AS r ON r\.tenant_id = e\.tenant_id AND r\.id = e\.request_id/);
  assert.match(coreSql, /r\.supply_mode AS attempt_supply_mode/);
  assert.match(coreSql, /r\.route_upstream_id AS attempt_route_upstream_id/);
  assert.doesNotMatch(coreSql, /\ba\.supply_mode\b/);
  assert.doesNotMatch(coreSql, /\ba\.route_upstream_id\b/);
});

test('request/evidence mismatches and non-dispatchable states remain conjunctive rejection predicates', () => {
  const whereStart = coreSql.indexOf('WHERE e.id = $1');
  const branchesStart = coreSql.indexOf("AND ( ( e.supply_mode = 'byok'");
  assert.ok(whereStart >= 0 && branchesStart > whereStart);
  const commonWhere = coreSql.slice(whereStart, branchesStart);
  assert.doesNotMatch(commonWhere, /\bOR\b/, 'no mode branch may bypass the shared binding/state checks');
  for (const predicate of [
    "e.status = 'claimed'", 'e.claimed_at IS NOT NULL', 'e.claimed_attempt_id = e.attempt_id',
    'e.dispatch_deadline > clock_timestamp()', 'e.expires_at > clock_timestamp()',
    'e.supply_profile_version = e.supply_profile_authz_version',
    'a.prepared_evidence_id = e.id', "a.dispatch_authority_state = 'bound'",
    "a.dispatch_state = 'dispatching'", "a.result_state = 'pending'", 'a.response_started = FALSE',
    'a.request_id = e.request_id', 'a.ordinal = e.attempt_ordinal',
    'a.upstream_id = e.upstream_id',
    'a.account_owner_kind = e.account_owner_kind', 'a.account_id = e.account_id',
    'a.credential_id = e.credential_id', 'a.credential_version = e.credential_version',
    'a.credential_authz_version = e.credential_authz_version', 'a.account_authz_version = e.account_authz_version',
    'r.project_id = e.project_id', 'r.supply_profile_id = e.supply_profile_id',
    'r.supply_profile_version = e.supply_profile_version', 'r.model_scope_version = e.model_scope_version',
    'r.supply_mode = e.supply_mode', 'r.public_model = e.public_model',
    'r.route_upstream_id = e.route_upstream_id',
    "sp.status = 'active'", 'sp.authz_version = e.supply_profile_authz_version',
    "rv.status = 'active'", "rh.status = 'active'", 'rh.current_version = e.route_config_version',
  ]) assert.ok(commonWhere.includes(`AND ${predicate}`), `retain dispatch predicate: ${predicate}`);
});

test('BYOK/platform retain distinct owner, target and mapping/pool requirements', () => {
  assert.match(coreSql, /e\.supply_mode = 'byok' AND e\.account_owner_kind = 'tenant' AND e\.route_target_mode = 'tenant_account' AND e\.profile_account_authz_version IS NOT NULL AND e\.pool_id IS NULL/);
  assert.match(coreSql, /e\.supply_mode = 'platform' AND e\.account_owner_kind = 'platform' AND e\.route_target_mode = 'platform_pool' AND e\.profile_account_authz_version IS NULL AND e\.pool_id IS NOT NULL/);
  for (const field of [
    'pool_authz_version', 'pool_member_account_authz_version', 'pool_member_authz_version',
    'pool_grant_authz_version', 'pool_grant_profile_authz_version', 'pool_grant_pool_authz_version',
  ]) {
    assert.ok(coreSql.includes(`AND e.${field} IS NULL`));
    assert.ok(coreSql.includes(`AND e.${field} IS NOT NULL`));
  }
});

for (const mode of ['byok', 'platform'] as const) {
  test(`${mode}: a missing freshly fenced dispatch core yields no credential authority read`, async () => {
    const statements: string[] = [];
    const database: SaasDatabase = {
      async query<Row>(sql: string): Promise<SqlResult<Row>> {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        statements.push(normalized);
        if (normalized.startsWith('SELECT tenant_id, project_id, principal_kind')) {
          return { rows: [{
            tenant_id: '11111111-1111-4111-8111-111111111111',
            project_id: '22222222-2222-4222-8222-222222222222',
            principal_kind: 'project_service', principal_id: '33333333-3333-4333-8333-333333333333',
            proxy_key_id: '44444444-4444-4444-8444-444444444444', supply_mode: mode,
            account_owner_kind: mode === 'byok' ? 'tenant' : 'platform',
            account_id: 'synthetic-account', credential_id: 'synthetic-credential', credential_version: 1,
            dispatch_profile_id: 'synthetic-profile', pool_id: mode === 'platform' ? 'synthetic-pool' : null,
          }] as Row[], rowCount: 1 };
        }
        if (normalized.includes('pg_advisory_xact_lock_shared')) return { rows: [], rowCount: 1 };
        assert.equal(normalized, coreSql, 'only the core read may follow the shared fences');
        return { rows: [], rowCount: 0 };
      },
      async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return work(database); },
      async migrate(): Promise<void> {}, async verifySchema(): Promise<void> {},
      async ping(): Promise<void> {}, async close(): Promise<void> {},
    };
    assert.equal(await new PostgresProviderSupplyRepository(database).readDispatchProof('synthetic-evidence'), null);
    assert.equal(statements.filter((sql) => sql === coreSql).length, 1);
    assert.ok(statements.some((sql) => sql.includes('pg_advisory_xact_lock_shared')));
  });
}
