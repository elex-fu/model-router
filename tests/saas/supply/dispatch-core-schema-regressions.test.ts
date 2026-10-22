import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { PreparedSqlStatement, SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';

const repositorySource = readFileSync(resolve(process.cwd(), 'src/saas/supply/repository.ts'), 'utf8');
const coreMatch = repositorySource.match(/const DISPATCH_CORE_SQL = `([\s\S]*?)`;/);
assert.ok(coreMatch, 'the production dispatch core SQL must be present');
const coreSql = coreMatch[1]!.replace(/\s+/g, ' ').trim();
const pinMatch = repositorySource.match(/const DISPATCH_CORE_JOIN_ORDER_PINNED_SQL = "([^"]+)"/);
const resetMatch = repositorySource.match(/const DISPATCH_CORE_JOIN_ORDER_RESET_SQL = '([^']+)'/);
assert.ok(pinMatch && resetMatch, 'the dispatch core planner pin and reset statements must be present');
const pinSql = (pinMatch?.[1] ?? '').replace(/\s+/g, ' ').trim();
const resetSql = (resetMatch?.[1] ?? '').replace(/\s+/g, ' ').trim();
const fenceBatchMatch = repositorySource.match(/const DISPATCH_READ_FENCE_BATCH_SQL = `([\s\S]*?)`;/);
assert.ok(fenceBatchMatch, 'the private dispatch read fence batch SQL must be present');
const fenceBatchSql = (fenceBatchMatch?.[1] ?? '').replace(/\s+/g, ' ').trim();

// This is a source/SQL-contract regression, not a substitute for executing the
// restricted-role query on PG15/18. Derive columns from registered migration SQL,
// never from a fake dispatch row containing a nonexistent attempts.supply_mode.
function tableColumns(table: 'saas_attempts' | 'saas_requests'): ReadonlySet<string> {
  const columns = new Set<string>();
  for (const migration of SAAS_MIGRATIONS) {
    const create = migration.sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (create) {
      for (const column of create[1]!.matchAll(
        /^ {2}([a-z_][a-z0-9_]*)\s+(?:uuid|text|integer|bigint|boolean|timestamptz)\b/gm,
      ))
        columns.add(column[1]!);
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
  for (const [alias, columns] of [
    ['a', attemptColumns],
    ['r', requestColumns],
  ] as const) {
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
  for (const [alias, prefix] of [
    ['e', 'evidence'],
    ['a', 'attempt'],
  ] as const) {
    for (const field of ['provider_protocol', 'provider_operation']) {
      assert.ok(coreSql.includes(`${alias}.${field} AS ${prefix}_${field}`));
    }
  }
});

test('native dispatch provenance is conditionally mapped from its own columns without client-protocol inference', () => {
  const binding = repositorySource.slice(
    repositorySource.indexOf('function dispatchBinding('),
    repositorySource.indexOf('function dispatchOwner('),
  );
  assert.match(binding, /row\[`\$\{prefix\}_provider_protocol`\] == null\s*\? \{\}/);
  assert.match(binding, /providerProtocol: dispatchProtocol\(row\[`\$\{prefix\}_provider_protocol`\]\)/);
  assert.match(binding, /row\[`\$\{prefix\}_provider_operation`\] == null\s*\? \{\}/);
  assert.match(binding, /providerOperation: dispatchText\(row, `\$\{prefix\}_provider_operation`\)/);
  assert.doesNotMatch(binding, /providerProtocol:.*\?\?|providerOperation:.*\?\?/);
});

test('request/evidence mismatches and non-dispatchable states remain conjunctive rejection predicates', () => {
  const whereStart = coreSql.indexOf('WHERE e.id = $1');
  const branchesStart = coreSql.indexOf("AND ( ( e.supply_mode = 'byok'");
  assert.ok(whereStart >= 0 && branchesStart > whereStart);
  const commonWhere = coreSql.slice(whereStart, branchesStart);
  assert.doesNotMatch(commonWhere, /\bOR\b/, 'no mode branch may bypass the shared binding/state checks');
  for (const predicate of [
    "e.status = 'claimed'",
    'e.claimed_at IS NOT NULL',
    'e.claimed_attempt_id = e.attempt_id',
    'e.dispatch_deadline > clock_timestamp()',
    'e.expires_at > clock_timestamp()',
    'e.supply_profile_version = e.supply_profile_authz_version',
    'a.prepared_evidence_id = e.id',
    "a.dispatch_authority_state = 'bound'",
    "a.dispatch_state = 'dispatching'",
    "a.result_state = 'pending'",
    'a.response_started = FALSE',
    'a.request_id = e.request_id',
    'a.ordinal = e.attempt_ordinal',
    'a.upstream_id = e.upstream_id',
    'a.account_owner_kind = e.account_owner_kind',
    'a.account_id = e.account_id',
    'a.credential_id = e.credential_id',
    'a.credential_version = e.credential_version',
    'a.credential_authz_version = e.credential_authz_version',
    'a.account_authz_version = e.account_authz_version',
    'r.project_id = e.project_id',
    'r.supply_profile_id = e.supply_profile_id',
    'r.supply_profile_version = e.supply_profile_version',
    'r.model_scope_version = e.model_scope_version',
    'r.supply_mode = e.supply_mode',
    'r.public_model = e.public_model',
    'r.route_upstream_id = e.route_upstream_id',
    "sp.status = 'active'",
    'sp.authz_version = e.supply_profile_authz_version',
    "rv.status = 'active'",
    "rh.status = 'active'",
    'rh.current_version = e.route_config_version',
  ])
    assert.ok(commonWhere.includes(`AND ${predicate}`), `retain dispatch predicate: ${predicate}`);
});

test('BYOK/platform retain distinct owner, target and mapping/pool requirements', () => {
  assert.match(
    coreSql,
    /e\.supply_mode = 'byok' AND e\.account_owner_kind = 'tenant' AND e\.route_target_mode = 'tenant_account' AND e\.profile_account_authz_version IS NOT NULL AND e\.pool_id IS NULL/,
  );
  assert.match(
    coreSql,
    /e\.supply_mode = 'platform' AND e\.account_owner_kind = 'platform' AND e\.route_target_mode = 'platform_pool' AND e\.profile_account_authz_version IS NULL AND e\.pool_id IS NOT NULL/,
  );
  for (const field of [
    'pool_authz_version',
    'pool_member_account_authz_version',
    'pool_member_authz_version',
    'pool_grant_authz_version',
    'pool_grant_profile_authz_version',
    'pool_grant_pool_authz_version',
  ]) {
    assert.ok(coreSql.includes(`AND e.${field} IS NULL`));
    assert.ok(coreSql.includes(`AND e.${field} IS NOT NULL`));
  }
});

function dispatchIdentity(mode: 'byok' | 'platform', principalKind: 'member' | 'project_service') {
  return {
    tenant_id: '11111111-1111-4111-8111-111111111111',
    project_id: '22222222-2222-4222-8222-222222222222',
    principal_kind: principalKind,
    principal_id: '33333333-3333-4333-8333-333333333333',
    proxy_key_id: '44444444-4444-4444-8444-444444444444',
    supply_mode: mode,
    account_owner_kind: mode === 'byok' ? 'tenant' : 'platform',
    account_id: 'synthetic-account',
    credential_id: 'synthetic-credential',
    credential_version: 1,
    dispatch_profile_id: 'synthetic-profile',
    pool_id: mode === 'platform' ? 'synthetic-pool' : null,
  };
}

function expectedDispatchKeys(identity: ReturnType<typeof dispatchIdentity>): string[] {
  const platform = identity.account_owner_kind === 'platform';
  const poolKeys = identity.pool_id === null ? [] : [saasAdvisoryKey.platformPool(identity.pool_id)];
  const profileKey = saasAdvisoryKey.supplyProfile(identity.tenant_id, identity.dispatch_profile_id);
  return [
    saasAdvisoryKey.tenant(identity.tenant_id),
    saasAdvisoryKey.project(identity.tenant_id, identity.project_id),
    ...(identity.principal_kind === 'member' ? [saasAdvisoryKey.user(identity.principal_id)] : []),
    saasAdvisoryKey.apiKey(identity.tenant_id, identity.project_id, identity.proxy_key_id),
    ...poolKeys,
    profileKey,
    platform
      ? saasAdvisoryKey.platformProviderAccount(identity.account_id)
      : saasAdvisoryKey.tenantProviderAccount(identity.tenant_id, identity.account_id),
    platform
      ? saasAdvisoryKey.platformProviderCredential(identity.credential_id)
      : saasAdvisoryKey.tenantProviderCredential(identity.tenant_id, identity.credential_id),
    saasAdvisoryKey.credentialVersion(
      platform ? 'platform' : 'tenant',
      platform ? identity.account_id : identity.tenant_id,
      identity.credential_id,
      identity.credential_version,
    ),
    ...(platform
      ? []
      : [saasAdvisoryKey.supplyProfileAccount(identity.tenant_id, identity.dispatch_profile_id, identity.account_id)]),
    ...(platform ? poolKeys : []),
    ...(platform ? [profileKey] : []),
  ];
}

test('dispatch read batches only scalar shared locks in ordinal input order', () => {
  assert.equal(
    fenceBatchSql,
    '/* provider-supply:dispatch-read-fence-batch */ ' +
      'SELECT pg_advisory_xact_lock_shared(hashtextextended(fence.fence_key, 0)) ' +
      'FROM unnest($1::text[]) WITH ORDINALITY AS fence(fence_key, input_ordinal) ' +
      'ORDER BY fence.input_ordinal',
  );
  assert.doesNotMatch(fenceBatchSql, /\b(?:DISTINCT|LIMIT|GROUP BY)\b|ORDER BY 1|pg_advisory_xact_lock\(/);
  assert.match(
    repositorySource,
    /dispatchReadLockLayers\(identity\)\.flatMap\(\(layer\) => sortAndDedupeAdvisoryKeys\(layer\)\)/,
  );
});

for (const mode of ['byok', 'platform'] as const) {
  for (const principalKind of ['member', 'project_service'] as const) {
    test(`${mode}/${principalKind}: exact ordered fence keys precede the pinned core and missing core skips authority`, async () => {
      const statements: string[] = [];
      const boundFenceKeys: string[] = [];
      let preparedCalls = 0;
      const identity = dispatchIdentity(mode, principalKind);
      const database: SaasDatabase = {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          statements.push(normalized);
          if (normalized.startsWith('SELECT tenant_id, project_id, principal_kind')) {
            assert.deepEqual(values, ['synthetic-evidence']);
            return { rows: [identity] as Row[], rowCount: 1 };
          }
          if (normalized === fenceBatchSql) {
            assert.equal(values?.length, 1);
            const keys = values?.[0];
            assert.ok(Array.isArray(keys) && keys.every((key) => typeof key === 'string'));
            boundFenceKeys.push(...keys);
            return { rows: [], rowCount: keys.length };
          }
          assert.ok(
            normalized === coreSql || normalized === pinSql || normalized === resetSql,
            'only the planner pin, core read and reset may follow every shared fence',
          );
          return { rows: [], rowCount: 0 };
        },
        async queryPrepared<Row>(): Promise<SqlResult<Row>> {
          preparedCalls += 1;
          assert.fail('a query-only transaction must retain the anonymous dispatch query path');
        },
        async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
          const tx: SqlExecutor = { query: (sql, values) => database.query(sql, values) };
          assert.equal(typeof tx.queryPrepared, 'undefined');
          return work(tx);
        },
        async migrate(): Promise<void> {},
        async verifySchema(): Promise<void> {},
        async ping(): Promise<void> {},
        async close(): Promise<void> {},
      };
      assert.equal(await new PostgresProviderSupplyRepository(database).readDispatchProof('synthetic-evidence'), null);
      assert.equal(preparedCalls, 0);
      assert.equal(statements.length, 5, 'identity, one fence batch, pin, missing core and reset only');
      assert.deepEqual(statements.slice(1), [fenceBatchSql, pinSql, coreSql, resetSql]);
      assert.deepEqual(boundFenceKeys, expectedDispatchKeys(identity));
      const expectedCount = (mode === 'platform' ? 11 : 9) - (principalKind === 'member' ? 0 : 1);
      assert.equal(boundFenceKeys.length, expectedCount, 'retain every original shared-lock invocation');
      if (mode === 'platform') {
        assert.equal(boundFenceKeys.filter((key) => key === saasAdvisoryKey.platformPool('synthetic-pool')).length, 2);
        assert.equal(
          boundFenceKeys.filter(
            (key) => key === saasAdvisoryKey.supplyProfile(identity.tenant_id, identity.dispatch_profile_id),
          ).length,
          2,
          'repeated profile keys across layers must not be globally deduplicated',
        );
      }
      assert.equal(statements.filter((sql) => sql === coreSql).length, 1);
      assert.equal(statements.filter((sql) => sql === fenceBatchSql).length, 1);
      const pinIndex = statements.indexOf(pinSql);
      const coreIndex = statements.indexOf(coreSql);
      const resetIndex = statements.indexOf(resetSql);
      assert.ok(pinIndex >= 0 && coreIndex > pinIndex && resetIndex > coreIndex);
    });
  }
}

test('dispatch fence failure is propagated once before pin, core or authority reads', async () => {
  const failure = new Error('synthetic dispatch fence storage failure');
  const identity = dispatchIdentity('platform', 'member');
  const statements: string[] = [];
  const database: SaasDatabase = {
    async query<Row>(sql: string): Promise<SqlResult<Row>> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.startsWith('SELECT tenant_id, project_id, principal_kind')) {
        return { rows: [identity] as Row[], rowCount: 1 };
      }
      assert.equal(normalized, fenceBatchSql);
      throw failure;
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return work(database);
    },
    async migrate(): Promise<void> {},
    async verifySchema(): Promise<void> {},
    async ping(): Promise<void> {},
    async close(): Promise<void> {},
  };
  await assert.rejects(
    new PostgresProviderSupplyRepository(database).readDispatchProof('synthetic-evidence'),
    (error: unknown) => error === failure,
  );
  assert.equal(statements.length, 2);
  assert.equal(statements[1], fenceBatchSql);
});

test('dispatch core pins its join order with a transaction-scoped planner override only', () => {
  // R9 bench §4 P2: default planner settings spend seconds planning the
  // eight-relation dispatch core; join_collapse_limit=1 plans the written
  // left-deep order in milliseconds. The override must be SET LOCAL
  // (transaction-scoped, privilege-free, invisible to pooled re-borrowers).
  assert.equal(pinSql, "SET LOCAL join_collapse_limit = '1'");
  assert.equal(resetSql, 'SET LOCAL join_collapse_limit = DEFAULT');
  const pinUses = (repositorySource.match(/\bDISPATCH_CORE_JOIN_ORDER_PINNED_SQL\b/g) ?? []).length;
  const resetUses = (repositorySource.match(/\bDISPATCH_CORE_JOIN_ORDER_RESET_SQL\b/g) ?? []).length;
  assert.ok(pinUses >= 2 && resetUses >= 2, 'pin and reset constants must be declared and used');
  for (const bare of repositorySource.matchAll(/["'`][ \t]*SET[ \t]+(?!LOCAL\b)[a-z_]+[ \t]*=/g)) {
    assert.fail(`no session-wide settings may be issued by the repository: ${bare[0].trim()}`);
  }
});

const proofSql = Object.fromEntries(
  [
    ['proof-core', 'DISPATCH_CORE_SQL'],
    ['proof-tenant', 'TENANT_DISPATCH_AUTHORITY_SQL'],
    ['proof-platform', 'PLATFORM_DISPATCH_AUTHORITY_SQL'],
  ].map(([label, constant]) => {
    const match = repositorySource.match(new RegExp(`const ${constant} = \x60([\\s\\S]*?)\x60;`));
    assert.ok(match, 'every proof descriptor retains its original fixed SQL constant');
    assert.ok(match[1]);
    return [label, match[1]];
  }),
) as Record<'proof-core' | 'proof-tenant' | 'proof-platform', string>;

function proofCoreRow(mode: 'byok' | 'platform', evidenceId: string): Record<string, unknown> {
  const identity = dispatchIdentity(mode, 'member');
  const binding = {
    tenant_id: identity.tenant_id,
    request_id: 'synthetic-request',
    attempt_id: 'synthetic-attempt',
    attempt_ordinal: 1,
    supply_mode: mode,
    account_owner_kind: identity.account_owner_kind,
    account_id: identity.account_id,
    provider_id: 'synthetic-provider',
    product_id: 'synthetic-product',
    protocol: 'openai',
    endpoint: 'chat-completions',
    route_config_id: 'synthetic-route',
    route_config_version: 1,
    route_public_model_id: 'synthetic-model',
    route_public_model_version: 1,
    route_protocol: 'openai',
    route_target_mode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    route_upstream_id: 'synthetic-upstream',
    upstream_id: 'synthetic-upstream',
    resolved_model: 'synthetic-model',
    dispatch_profile_id: identity.dispatch_profile_id,
    supply_profile_authz_version: 1,
    credential_id: identity.credential_id,
    credential_version: 1,
    credential_authz_version: 1,
    account_authz_version: 1,
    profile_account_authz_version: mode === 'byok' ? 1 : null,
    pool_id: identity.pool_id,
    pool_authz_version: mode === 'platform' ? 1 : null,
    pool_member_account_authz_version: mode === 'platform' ? 1 : null,
    pool_member_authz_version: mode === 'platform' ? 1 : null,
    pool_grant_authz_version: mode === 'platform' ? 1 : null,
    pool_grant_profile_authz_version: mode === 'platform' ? 1 : null,
    pool_grant_pool_authz_version: mode === 'platform' ? 1 : null,
  };
  return {
    ...Object.fromEntries(
      ['evidence', 'attempt'].flatMap((prefix) =>
        Object.entries(binding).map(([key, value]) => [`${prefix}_${key}`, value]),
      ),
    ),
    evidence_id: evidenceId,
    evidence_supply_profile_id: 'synthetic-profile',
    evidence_supply_profile_version: 1,
    evidence_public_model: 'synthetic-model',
    evidence_status: 'claimed',
    evidence_claimed_at: '2026-10-22T00:00:00.000Z',
    evidence_claimed_attempt_id: 'synthetic-attempt',
    evidence_dispatch_deadline: '2026-10-23T00:00:00.000Z',
    evidence_expires_at: '2026-10-23T00:00:00.000Z',
    attempt_prepared_evidence_id: evidenceId,
    attempt_dispatch_authority_state: 'bound',
    attempt_dispatch_state: 'dispatching',
    attempt_result_state: 'pending',
    attempt_response_started: false,
    profile_tenant_id: identity.tenant_id,
    profile_id: identity.dispatch_profile_id,
    profile_supply_mode: mode,
    profile_status: 'active',
    profile_authz_version: 1,
    claim_action: 'saas_prepared_request_evidence.claimed',
    claim_target_type: 'saas_prepared_request_evidence',
    claim_target_id: evidenceId,
  };
}

for (const mode of ['byok', 'platform'] as const) {
  for (const transport of ['anonymous', 'prepared'] as const) {
    test(`${mode}: fixed proof SQL uses ${transport} with current values and unchanged pin/reset order`, async () => {
      const identity = dispatchIdentity(mode, 'member');
      const calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
      const descriptors: PreparedSqlStatement[] = [];
      let evidenceId = '';
      const authorityLabel = mode === 'byok' ? 'proof-tenant' : 'proof-platform';
      const database: SaasDatabase = {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
          calls.push({ sql, values });
          if (sql.includes('SELECT tenant_id, project_id, principal_kind')) {
            assert.deepEqual(values, [evidenceId]);
            return { rows: [identity] as Row[], rowCount: 1 };
          }
          if (sql === proofSql['proof-core']) {
            assert.deepEqual(values, [evidenceId]);
            return { rows: [proofCoreRow(mode, evidenceId)] as Row[], rowCount: 1 };
          }
          if (sql === proofSql[authorityLabel]) {
            assert.deepEqual(
              values,
              mode === 'byok'
                ? [
                    identity.tenant_id,
                    identity.account_id,
                    'synthetic-provider',
                    'synthetic-product',
                    1,
                    identity.credential_id,
                    1,
                    1,
                    identity.dispatch_profile_id,
                    1,
                  ]
                : [
                    identity.account_id,
                    'synthetic-provider',
                    'synthetic-product',
                    1,
                    identity.credential_id,
                    1,
                    1,
                    identity.pool_id,
                    1,
                    1,
                    1,
                    identity.dispatch_profile_id,
                    identity.tenant_id,
                    1,
                    1,
                    1,
                  ],
            );
            return { rows: [], rowCount: 0 };
          }
          assert.ok([fenceBatchSql, pinSql, resetSql].includes(sql.replace(/\s+/g, ' ').trim()));
          return { rows: [], rowCount: 0 };
        },
        async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
          return work(database);
        },
        async migrate(): Promise<void> {},
        async verifySchema(): Promise<void> {},
        async ping(): Promise<void> {},
        async close(): Promise<void> {},
      };
      if (transport === 'prepared')
        database.queryPrepared = async (statement, values) => {
          assert.ok(Object.isFrozen(statement));
          const label = statement.text === proofSql['proof-core'] ? 'proof-core' : authorityLabel;
          assert.equal(statement.text, proofSql[label]);
          assert.equal(
            statement.name,
            `mr_${label}_${createHash('sha256').update(statement.text).digest('base64url')}`,
          );
          assert.ok(Buffer.byteLength(statement.name, 'utf8') <= 63);
          descriptors.push(statement);
          return database.query(statement.text, values);
        };
      const repository = new PostgresProviderSupplyRepository(database);
      for (const current of ['synthetic-first-evidence', 'synthetic-second-evidence']) {
        evidenceId = current;
        const start = calls.length;
        assert.equal(await repository.readDispatchProof(evidenceId), null, 'missing fresh authority still refuses');
        const identityCall = calls[start];
        assert.ok(identityCall);
        assert.deepEqual(
          calls.slice(start).map(({ sql }) => sql.replace(/\s+/g, ' ').trim()),
          [
            identityCall.sql.replace(/\s+/g, ' ').trim(),
            fenceBatchSql,
            pinSql,
            coreSql,
            resetSql,
            proofSql[authorityLabel].replace(/\s+/g, ' ').trim(),
          ],
        );
      }
      assert.equal(calls.length, 12, 'every invocation executes all six original business statements');
      if (transport === 'prepared') {
        assert.equal(descriptors.length, 4);
        assert.equal(descriptors[0], descriptors[2], 'core descriptor identity is stable');
        assert.equal(descriptors[1], descriptors[3], 'authority descriptor identity is stable');
      } else assert.equal(descriptors.length, 0);
    });
  }

  for (const failedLabel of ['proof-core', mode === 'byok' ? 'proof-tenant' : 'proof-platform'] as const) {
    test(`${mode}: ${failedLabel} native failure is rethrown once without anonymous replay`, async () => {
      const failure = new Error('synthetic proof native execution failure');
      const identity = dispatchIdentity(mode, 'member');
      const descriptors: PreparedSqlStatement[] = [];
      const anonymous: string[] = [];
      const database: SaasDatabase = {
        async query<Row>(sql: string): Promise<SqlResult<Row>> {
          anonymous.push(sql);
          assert.ok(!Object.values(proofSql).includes(sql), 'fixed proof statements never replay anonymously');
          if (sql.includes('SELECT tenant_id, project_id, principal_kind'))
            return { rows: [identity] as Row[], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        async queryPrepared<Row>(statement: PreparedSqlStatement): Promise<SqlResult<Row>> {
          descriptors.push(statement);
          if (statement.text === proofSql[failedLabel]) throw failure;
          assert.equal(statement.text, proofSql['proof-core']);
          return { rows: [proofCoreRow(mode, 'synthetic-evidence')] as Row[], rowCount: 1 };
        },
        async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
          return work(database);
        },
        async migrate(): Promise<void> {},
        async verifySchema(): Promise<void> {},
        async ping(): Promise<void> {},
        async close(): Promise<void> {},
      };
      await assert.rejects(
        new PostgresProviderSupplyRepository(database).readDispatchProof('synthetic-evidence'),
        (error: unknown) => error === failure,
      );
      assert.equal(descriptors.filter((statement) => statement.text === proofSql[failedLabel]).length, 1);
      assert.equal(descriptors.length, failedLabel === 'proof-core' ? 1 : 2);
      assert.equal(
        anonymous.filter((sql) => sql.replace(/\s+/g, ' ').trim() === resetSql).length,
        failedLabel === 'proof-core' ? 0 : 1,
        'reset/error transaction sequencing remains unchanged',
      );
    });
  }
}
