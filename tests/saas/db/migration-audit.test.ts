import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertSaasMigrationAuditMatches,
  auditSaasMigrationCompatibility,
  getSaasAuditCatalogChecksum,
  getSaasMigrationAuditExpectations,
  SAAS_AUDIT_CATALOG_KINDS,
  SAAS_AUDIT_CATALOG_PROFILE,
  SAAS_MIGRATION_AUDIT_CATALOG_SQL,
  SaasMigrationAuditError,
  type SaasAuditCatalogBaseline,
  type SaasAuditCatalogObject,
  type SaasMigrationAuditOptions,
  type SaasMigrationAuditReport,
} from '../../../src/saas/db/migration-audit.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

// No connection configuration, environment variables, providers, or real DB.
const sensitiveText = 'postgresql://fixture:fixture-password@fixture.invalid/db?secret=fixture-provider-value';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const migrations: readonly SaasMigration[] = [
  { version: 1, name: 'initial', sql: 'test fixture initial SQL' },
  { version: 22, name: 'route_authority', sql: 'test fixture route SQL' },
  { version: 23, name: 'commercial_authority', sql: 'test fixture commercial SQL' },
];
const expected = getSaasMigrationAuditExpectations(migrations);
const catalogRows = SAAS_AUDIT_CATALOG_KINDS.map((kind) => ({
  kind, identity: JSON.stringify([`fixture_${kind}`]), definition: `${kind} definition`,
}));
const catalogObjects: SaasAuditCatalogObject[] = catalogRows.map(({ kind, identity, definition }) => ({
  kind, identityChecksum: hash(identity), definitionChecksum: hash(definition),
}));
function baseline(overrides: Partial<SaasAuditCatalogBaseline> = {}): SaasAuditCatalogBaseline {
  return { profile: SAAS_AUDIT_CATALOG_PROFILE, coverage: 'complete-profile',
    evidenceId: 'reviewed-fixture', releaseId: 'release-fixture', schema: 'model_router_saas',
    postgresMajor: 15, migrationsChecksum: expected.checksum, objects: catalogObjects, ...overrides };
}
function options(overrides: Partial<SaasMigrationAuditOptions> = {}): SaasMigrationAuditOptions {
  return { target: { deploymentId: 'deployment-fixture', environmentId: 'environment-fixture',
    database: 'audit_fixture', schema: 'model_router_saas' }, releaseId: 'release-fixture',
    migrations, catalogBaseline: baseline(), ...overrides };
}
interface FixtureOptions {
  database?: string;
  schemaPresent?: boolean;
  readOnly?: string;
  isolation?: string;
  serverVersion?: string;
  targetRows?: number;
  ledgerKind?: string | null;
  history?: unknown[];
  catalog?: unknown[];
  fail?: 'connect' | 'begin' | 'path' | 'target' | 'ledger' | 'history' | 'catalog' | 'rollback' | 'release';
}
class AuditPool implements SaasDatabasePool {
  readonly statements: { sql: string; values?: readonly unknown[] }[] = [];
  readonly releases: Array<Error | boolean | undefined> = [];
  connects = 0;
  ends = 0;
  constructor(readonly fixture: FixtureOptions = {}) {}
  query<Row>(): Promise<SqlResult<Row>> { throw new Error('Audit must use one checked-out client'); }
  async end(): Promise<void> { this.ends += 1; }
  async connect(): Promise<SaasDatabaseClient> {
    this.connects += 1;
    if (this.fixture.fail === 'connect') throw new Error(sensitiveText);
    return {
      query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
        this.statements.push({ sql, values });
        let phase: FixtureOptions['fail'];
        let rows: unknown[] = [];
        if (sql.startsWith('BEGIN')) phase = 'begin';
        else if (sql.startsWith('SET LOCAL')) phase = 'path';
        else if (sql === 'ROLLBACK') phase = 'rollback';
        else if (sql.includes('current_database()')) {
          phase = 'target';
          rows = Array.from({ length: this.fixture.targetRows ?? 1 }, () => ({
            database: this.fixture.database ?? 'audit_fixture',
            schema_present: this.fixture.schemaPresent ?? true,
            server_version_num: this.fixture.serverVersion ?? '150012',
            read_only: this.fixture.readOnly ?? 'on', isolation: this.fixture.isolation ?? 'repeatable read',
          }));
        } else if (sql.includes("c.relname = 'saas_schema_migrations'")) {
          phase = 'ledger';
          rows = this.fixture.ledgerKind === null ? [] : [{ relkind: this.fixture.ledgerKind ?? 'r' }];
        } else if (sql.startsWith('SELECT version, name, checksum')) {
          phase = 'history';
          rows = this.fixture.history ?? expected.migrations.map(({ version, name, checksum }) => ({ version, name, checksum }));
        } else if (sql === SAAS_MIGRATION_AUDIT_CATALOG_SQL) {
          phase = 'catalog';
          rows = this.fixture.catalog ?? catalogRows;
        } else throw new Error('Unexpected audit statement');
        if (phase === this.fixture.fail) throw new Error(sensitiveText);
        return { rows: rows as Row[], rowCount: rows.length };
      },
      release: (error) => {
        this.releases.push(error);
        if (this.fixture.fail === 'release') throw new Error(sensitiveText);
      },
    };
  }
}
const codes = (report: SaasMigrationAuditReport): string[] => report.issues.map(({ code }) => code);
const history = (): Record<string, unknown>[] => expected.migrations.map(({ version, name, checksum }) => ({ version, name, checksum }));
function blocked(report: SaasMigrationAuditReport): void {
  assert.notEqual(report.compatibility, 'matches-trusted-baseline');
  assert.throws(() => assertSaasMigrationAuditMatches(report), SaasMigrationAuditError);
  assert.ok(!JSON.stringify(report).includes(sensitiveText));
}

test('matches an explicitly bound trusted baseline using one read-only snapshot and no pool lifecycle writes', async () => {
  const pool = new AuditPool();
  const report = await auditSaasMigrationCompatibility(pool, options());
  assert.equal(report.compatibility, 'matches-trusted-baseline');
  assertSaasMigrationAuditMatches(report);
  assert.deepEqual(report.issues, []);
  assert.equal(report.migrations.length, 3);
  assert.ok(report.migrations.every(({ state, expected: wanted, actual }) => state === 'match' && wanted?.checksum === actual?.checksum));
  assert.equal(report.catalog.actualChecksum, report.catalog.expectedChecksum);
  assert.equal(report.catalog.comparisons.length, catalogRows.length);
  assert.ok(report.catalog.coverage.some((coverage) => coverage.includes('internal-FK')));
  assert.ok(report.catalog.exclusions.includes('upgrade path and restore provenance'));
  assert.equal(pool.connects, 1);
  assert.equal(pool.ends, 0);
  assert.deepEqual(pool.releases, [false]);
  assert.equal(pool.statements[0]?.sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.statements[1]?.sql, 'SET LOCAL search_path TO pg_catalog');
  assert.equal(pool.statements.at(-1)?.sql, 'ROLLBACK');
  assert.equal(pool.statements.filter(({ sql }) => sql.startsWith('SELECT version'))[0]?.sql,
    'SELECT version, name, checksum FROM "model_router_saas"."saas_schema_migrations" ORDER BY version ASC');
  assert.ok(pool.statements.every(({ sql }) => /^(BEGIN TRANSACTION .* READ ONLY|SET LOCAL search_path TO pg_catalog|ROLLBACK|SELECT|\s*WITH)/.test(sql)));
  assert.ok(!pool.statements.some(({ sql }) => /^(?:CREATE|ALTER|INSERT|DELETE|UPDATE|GRANT|TRUNCATE|COMMIT)\b/i.test(sql)));
  assert.ok(!pool.statements.some(({ sql }) => /advisory_lock|saas_provider_supply_credentials|password_hash/.test(sql)));
});

test('the default expectation set exactly matches runner checksums for every registered migration', () => {
  const result = getSaasMigrationAuditExpectations();
  assert.equal(result.migrations.length, SAAS_MIGRATIONS.length);
  for (const migration of SAAS_MIGRATIONS) {
    const checksum = createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
    assert.equal(result.migrations.find(({ version }) => version === migration.version)?.checksum, checksum);
  }
  assert.deepEqual(getSaasMigrationAuditExpectations([...migrations].reverse()), expected);
});

test('ledger plus catalog inventory without a trusted baseline is explicitly unverified', async () => {
  const report = await auditSaasMigrationCompatibility(new AuditPool(), options({ catalogBaseline: undefined }));
  assert.equal(report.compatibility, 'unverified');
  assert.deepEqual(codes(report), ['BASELINE_MISSING']);
  assert.equal(report.catalog.actual.length, catalogRows.length);
  assert.equal(report.catalog.expectedChecksum, null);
  assert.deepEqual(report.catalog.comparisons, []);
  blocked(report);
});

test('the assertion checks evidence consistency as well as the top-level status label', async () => {
  const report = await auditSaasMigrationCompatibility(new AuditPool(), options());
  for (const changed of [
    { actualTarget: null },
    { migrations: report.migrations.map((row, index) => index === 0 ? { ...row, actual: null } : row) },
    { catalog: { ...report.catalog, comparisons: [] } },
    { catalog: { ...report.catalog, actual: report.catalog.actual.slice(1) } },
  ]) {
    assert.throws(() => assertSaasMigrationAuditMatches({ ...report, ...changed }), SaasMigrationAuditError);
  }
});

for (const version of [22, 23] as const) {
  test(`${version} mismatching historical checksum is fail-closed even when the catalog matches`, async () => {
    const rows = history();
    const row = rows.find((entry) => entry.version === version);
    assert.ok(row);
    row.checksum = hash(`historical-${version}`);
    const report = await auditSaasMigrationCompatibility(new AuditPool({ history: rows }), options({
      legacyChecksums: [{ version, checksum: String(row.checksum), evidenceId: 'reviewed-history-fixture' }],
    }));
    assert.equal(report.compatibility, 'mismatch');
    assert.ok(codes(report).includes('CHECKSUM_MISMATCH_022_023'));
    assert.ok(codes(report).includes('KNOWN_LEGACY_CHECKSUM'));
    assert.equal(report.migrations.find((entry) => entry.version === version)?.state, 'drift');
    assert.equal(report.catalog.expectedChecksum, report.catalog.actualChecksum);
    blocked(report);
  });
}

test('unrecognized 022 checksum is reported without inventing historical evidence', async () => {
  const rows = history();
  rows[1].checksum = hash('unrecognized-history');
  const report = await auditSaasMigrationCompatibility(new AuditPool({ history: rows }), options());
  assert.ok(codes(report).includes('CHECKSUM_MISMATCH_022_023'));
  assert.ok(!codes(report).includes('KNOWN_LEGACY_CHECKSUM'));
  blocked(report);
});

test('reports name drift and redacts an untrusted ledger name', async () => {
  const rows = history();
  rows[0].name = sensitiveText;
  const report = await auditSaasMigrationCompatibility(new AuditPool({ history: rows }), options());
  assert.ok(codes(report).includes('NAME_MISMATCH'));
  assert.equal(report.migrations[0].actual?.name, null);
  assert.equal(report.migrations[0].actual?.nameChecksum, hash(sensitiveText));
  blocked(report);
});

test('reports unknown future versions and out-of-order holes without hiding pending migrations', async () => {
  const rows = history().filter(({ version }) => version !== 22);
  rows.push({ version: 999, name: sensitiveText, checksum: hash('future') });
  const report = await auditSaasMigrationCompatibility(new AuditPool({ history: rows }), options());
  assert.ok(codes(report).includes('MIGRATION_MISSING'));
  assert.ok(codes(report).includes('MIGRATION_OUT_OF_ORDER'));
  assert.ok(codes(report).includes('MIGRATION_UNKNOWN'));
  assert.equal(report.migrations.find(({ version }) => version === 22)?.state, 'missing');
  assert.equal(report.migrations.find(({ version }) => version === 999)?.state, 'unknown');
  blocked(report);
});

test('a missing tail is a missing release requirement, not proof that an upgrade is safe', async () => {
  const report = await auditSaasMigrationCompatibility(new AuditPool({ history: history().slice(0, 2) }), options());
  assert.ok(codes(report).includes('MIGRATION_MISSING'));
  assert.ok(!codes(report).includes('MIGRATION_OUT_OF_ORDER'));
  blocked(report);
});

for (const [label, rows] of [
  ['duplicate version', [...history(), history()[0]]],
  ['duplicate name', history().map((row, index) => index === 1 ? { ...row, name: 'initial' } : row)],
  ['invalid checksum', history().map((row, index) => index === 1 ? { ...row, checksum: sensitiveText } : row)],
  ['malformed version', [{ version: '1e0', name: sensitiveText, checksum: sensitiveText }]],
  ['null row', [null]],
] as const) {
  test(`malformed ledger ${label} blocks compatibility without leaking input`, async () => {
    const report = await auditSaasMigrationCompatibility(new AuditPool({ history: [...rows] }), options());
    assert.ok(codes(report).includes('LEDGER_INVALID'));
    blocked(report);
  });
}

test('numeric-string ledger versions accepted by PostgreSQL adapters compare normally', async () => {
  const rows = history().map((row) => ({ ...row, version: String(row.version) }));
  assertSaasMigrationAuditMatches(await auditSaasMigrationCompatibility(new AuditPool({ history: rows }), options()));
});

for (const ledgerKind of [null, 'v'] as const) {
  test(`missing/non-table ledger ${ledgerKind} does not execute a view or repair anything`, async () => {
    const pool = new AuditPool({ ledgerKind });
    const report = await auditSaasMigrationCompatibility(pool, options());
    assert.ok(codes(report).includes(ledgerKind === null ? 'LEDGER_MISSING' : 'LEDGER_NOT_TABLE'));
    assert.equal(report.catalog.actual.length, catalogRows.length);
    assert.ok(!pool.statements.some(({ sql }) => sql.startsWith('SELECT version')));
    blocked(report);
  });
}

test('catalog separately reports missing, drifted and unknown objects and never emits raw definitions', async () => {
  const rows = catalogRows.slice(1).map((row, index) => index === 0 ? { ...row, definition: sensitiveText } : row);
  rows.push({ kind: 'routine', identity: sensitiveText, definition: sensitiveText });
  const report = await auditSaasMigrationCompatibility(new AuditPool({ catalog: rows }), options());
  assert.ok(codes(report).includes('CATALOG_MISSING'));
  assert.ok(codes(report).includes('CATALOG_DRIFT'));
  assert.ok(codes(report).includes('CATALOG_UNKNOWN'));
  assert.equal(report.catalog.comparisons.filter(({ state }) => state === 'missing').length, 1);
  assert.equal(report.catalog.comparisons.filter(({ state }) => state === 'drift').length, 1);
  assert.equal(report.catalog.comparisons.filter(({ state }) => state === 'unknown').length, 1);
  blocked(report);
});

for (const rows of [[], [...catalogRows, catalogRows[0]], [...catalogRows, { kind: 'routine', identity: null, definition: sensitiveText }]]) {
  test('empty/duplicate/malformed catalog rows never become a match', async () => {
    const report = await auditSaasMigrationCompatibility(new AuditPool({ catalog: rows }), options());
    assert.ok(codes(report).includes('CATALOG_INVALID'));
    assert.equal(report.catalog.actualChecksum, null);
    blocked(report);
  });
}

test('unsupported catalog features are explicit unknown coverage, even with matching supported objects', async () => {
  const report = await auditSaasMigrationCompatibility(new AuditPool({ catalog: [...catalogRows,
    { kind: 'unsupported', identity: 'policy', definition: 'policy' }] }), options());
  assert.ok(codes(report).includes('CATALOG_UNSUPPORTED_OBJECTS'));
  assert.deepEqual(report.catalog.unsupportedFeatures, ['policy']);
  assert.equal(report.compatibility, 'unverified');
  blocked(report);
});

for (const changed of [
  { coverage: 'partial' as const }, { releaseId: 'other-release' }, { schema: 'other_schema' },
  { postgresMajor: 18 }, { migrationsChecksum: hash('other-migrations') },
]) {
  test('partial or differently bound baseline never establishes compatibility', async () => {
    const report = await auditSaasMigrationCompatibility(new AuditPool(), options({ catalogBaseline: baseline(changed) }));
    assert.ok(codes(report).some((code) => ['BASELINE_PARTIAL', 'BASELINE_BINDING_MISMATCH'].includes(code)));
    blocked(report);
  });
}

for (const objects of [[], [catalogObjects[0], catalogObjects[0]], [{ ...catalogObjects[0], definitionChecksum: sensitiveText }]]) {
  test('baseline validation rejects empty/duplicate/invalid manifests and retains inventory only', async () => {
    const report = await auditSaasMigrationCompatibility(new AuditPool(), options({ catalogBaseline: baseline({ objects }) }));
    assert.ok(codes(report).includes('INVALID_BASELINE'));
    assert.equal(report.catalog.baselineEvidenceId, null);
    assert.equal(report.catalog.actual.length, catalogRows.length);
    blocked(report);
  });
}

test('PG18 requires its own baseline and inventory ordering does not affect checksums', async () => {
  const report = await auditSaasMigrationCompatibility(new AuditPool({ serverVersion: '180001', catalog: [...catalogRows].reverse() }),
    options({ catalogBaseline: baseline({ postgresMajor: 18, objects: [...catalogObjects].reverse() }) }));
  assertSaasMigrationAuditMatches(report);
  assert.equal(report.actualTarget?.postgresMajor, 18);
  assert.equal(getSaasAuditCatalogChecksum(catalogObjects), getSaasAuditCatalogChecksum([...catalogObjects].reverse()));
});

for (const fixture of [
  { database: sensitiveText }, { schemaPresent: false }, { serverVersion: '140010' },
  { readOnly: 'off' }, { isolation: 'read committed' }, { targetRows: 0 }, { targetRows: 2 },
]) {
  test('target mismatch/unavailable/unsafe snapshot stops before reading the ledger', async () => {
    const pool = new AuditPool(fixture);
    const report = await auditSaasMigrationCompatibility(pool, options());
    assert.ok(!pool.statements.some(({ sql }) => sql.startsWith('SELECT version')));
    assert.ok(codes(report).some((code) => ['TARGET_MISMATCH', 'TARGET_UNAVAILABLE', 'UNSUPPORTED_POSTGRES'].includes(code)));
    blocked(report);
  });
}

for (const fail of ['connect', 'begin', 'path', 'target', 'ledger', 'history', 'catalog', 'rollback', 'release'] as const) {
  test(`failure during ${fail} is sanitized, blocks matching, and cleans up safely`, async () => {
    const pool = new AuditPool({ fail });
    const report = await auditSaasMigrationCompatibility(pool, options());
    blocked(report);
    if (fail === 'connect') {
      assert.deepEqual(pool.statements, []);
      assert.deepEqual(pool.releases, []);
    } else {
      assert.equal(pool.releases.length, 1);
      assert.deepEqual(pool.releases, [fail === 'begin' || fail === 'rollback']);
      if (fail !== 'begin') assert.equal(pool.statements.at(-1)?.sql, 'ROLLBACK');
    }
  });
}

test('invalid/injected target and invalid registry are rejected before acquiring a connection', async () => {
  for (const invalid of [
    { target: { ...options().target, schema: sensitiveText } },
    { target: { ...options().target, schema: 'pg_catalog' } },
    { target: { ...options().target, database: 'a";DROP TABLE b;--' } },
    { releaseId: sensitiveText }, { migrations: [] }, { migrations: [migrations[0], migrations[0]] },
  ]) {
    const pool = new AuditPool();
    blocked(await auditSaasMigrationCompatibility(pool, options(invalid)));
    assert.equal(pool.connects, 0);
  }
});

test('extra fields in target and baseline JSON are never copied into the report', async () => {
  const input = options();
  Object.assign(input.target, { connectionString: sensitiveText });
  Object.assign(input.catalogBaseline as SaasAuditCatalogBaseline, { secret: sensitiveText });
  const report = await auditSaasMigrationCompatibility(new AuditPool(), input);
  assertSaasMigrationAuditMatches(report);
  assert.ok(!JSON.stringify(report).includes(sensitiveText));
});

test('catalog SQL covers definition/state drift rather than SQL regex or few-table presence checks', () => {
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /pg_catalog\.pg_get_functiondef/);
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /pg_catalog\.pg_get_constraintdef/);
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /con\.convalidated/);
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /t\.tgenabled/);
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /i\.indisvalid/);
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /pg_catalog\.pg_get_viewdef/);
  assert.match(SAAS_MIGRATION_AUDIT_CATALOG_SQL, /unsupported AS/);
  assert.ok(!/\blast_value\b|\bpg_advisory_lock\b|\bCREATE\b|\bALTER\b/.test(SAAS_MIGRATION_AUDIT_CATALOG_SQL));
});
