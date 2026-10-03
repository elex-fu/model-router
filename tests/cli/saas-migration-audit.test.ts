import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  SAAS_MIGRATION_AUDIT_URL_ENV,
  saasMigrationAudit,
  SaasMigrationAuditCommandError,
  type SaasMigrationAuditCommandDependencies,
  type SaasMigrationAuditCommandOptions,
  type SaasMigrationAuditCommandResult,
} from '../../src/cli/saas-migration-audit.js';
import {
  getSaasMigrationAuditExpectations,
  SAAS_AUDIT_CATALOG_PROFILE,
  SAAS_MIGRATION_AUDIT_CATALOG_SQL,
  type SaasAuditCatalogBaseline,
} from '../../src/saas/db/migration-audit.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../src/saas/db/types.js';

const exec = promisify(execFile);
const fakeUrl = 'postgresql://fixture:fixture-password@audit.example.invalid:65432/audit_fixture';
const sensitiveText = `${fakeUrl}?secret=fixture-provider-value`;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const expectations = getSaasMigrationAuditExpectations();
const catalogRows = [
  { kind: 'relation' as const, identity: '["fixture_table"]', definition: '["r"]' },
  { kind: 'routine' as const, identity: '["fixture_guard",""]', definition: 'fixture trigger function' },
];
function baseline(overrides: Partial<SaasAuditCatalogBaseline> = {}): SaasAuditCatalogBaseline {
  return {
    profile: SAAS_AUDIT_CATALOG_PROFILE, coverage: 'complete-profile', evidenceId: 'reviewed-fixture',
    releaseId: 'release-fixture', schema: 'model_router_saas', postgresMajor: 15,
    migrationsChecksum: expectations.checksum,
    objects: catalogRows.map(({ kind, identity, definition }) => ({ kind,
      identityChecksum: hash(identity), definitionChecksum: hash(definition) })),
    ...overrides,
  };
}
function commandOptions(overrides: Partial<SaasMigrationAuditCommandOptions> = {}): SaasMigrationAuditCommandOptions {
  return { deploymentId: 'deployment-fixture', environmentId: 'environment-fixture',
    database: 'audit_fixture', schema: 'model_router_saas', releaseId: 'release-fixture',
    catalogBaseline: '/reviewed-fixture/catalog.json', ...overrides };
}

interface PoolFixture {
  connectError?: boolean;
  closeError?: boolean;
  rollbackError?: boolean;
  driftVersion?: number;
  unknownVersion?: number;
  catalogDrift?: boolean;
}
class CliAuditPool implements SaasDatabasePool {
  readonly statements: string[] = [];
  releases: Array<Error | boolean | undefined> = [];
  connects = 0;
  ends = 0;
  constructor(readonly fixture: PoolFixture = {}) {}
  query<Row>(): Promise<SqlResult<Row>> { throw new Error('Must check out a client'); }
  async end(): Promise<void> {
    this.ends += 1;
    if (this.fixture.closeError) throw new Error(sensitiveText);
  }
  async connect(): Promise<SaasDatabaseClient> {
    this.connects += 1;
    if (this.fixture.connectError) throw new Error(sensitiveText);
    return {
      query: async <Row>(sql: string): Promise<SqlResult<Row>> => {
        this.statements.push(sql);
        let rows: unknown[] = [];
        if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')) rows = [];
        else if (sql === 'ROLLBACK') {
          if (this.fixture.rollbackError) throw new Error(sensitiveText);
        } else if (sql.includes('current_database()')) rows = [{ database: 'audit_fixture',
          server_version_num: '150012', read_only: 'on', isolation: 'repeatable read', schema_present: true }];
        else if (sql.includes("c.relname = 'saas_schema_migrations'")) rows = [{ relkind: 'r' }];
        else if (sql.startsWith('SELECT version')) {
          rows = expectations.migrations.map(({ version, name, checksum }) => ({ version, name,
            checksum: version === this.fixture.driftVersion ? hash('historical-fixture') : checksum }));
          if (this.fixture.unknownVersion !== undefined) rows.push({ version: this.fixture.unknownVersion,
            name: sensitiveText, checksum: hash('unknown-fixture') });
        } else if (sql === SAAS_MIGRATION_AUDIT_CATALOG_SQL) {
          rows = catalogRows.map((row, index) => this.fixture.catalogDrift && index === 0
            ? { ...row, definition: sensitiveText } : row);
        } else throw new Error('Unexpected query');
        return { rows: rows as Row[], rowCount: rows.length };
      },
      release: (error) => { this.releases.push(error); },
    };
  }
}
function harness(pool = new CliAuditPool(), overrides: Partial<SaasMigrationAuditCommandDependencies> = {}) {
  const output: string[] = [];
  const events: string[] = [];
  const deps: SaasMigrationAuditCommandDependencies = {
    env: { [SAAS_MIGRATION_AUDIT_URL_ENV]: fakeUrl },
    createPool: (url) => {
      assert.equal(url, fakeUrl);
      events.push('create-pool');
      return pool;
    },
    readBaselineFile: async (path) => {
      assert.equal(path, '/reviewed-fixture/catalog.json');
      events.push('read-baseline');
      return JSON.stringify(baseline());
    },
    writeLine: (line) => output.push(line),
    ...overrides,
  };
  return { output, events, deps, pool };
}
function safeOutput(lines: string[], result: SaasMigrationAuditCommandResult): void {
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), result);
  assert.ok(!lines[0].includes(fakeUrl));
  assert.ok(!lines[0].includes('fixture-password'));
  assert.ok(!lines[0].includes('fixture-provider-value'));
  assert.ok(!lines[0].includes('fixture trigger function'));
}

test('operator audit validates baseline before pool creation, reuses the snapshot, closes, and emits one JSON report', async () => {
  const { deps, pool, events, output } = harness();
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.deepEqual(events, ['read-baseline', 'create-pool']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'matched');
  assert.equal(result.error, null);
  assert.equal(result.report?.migrations.length, expectations.migrations.length);
  assert.equal(pool.connects, 1);
  assert.equal(pool.ends, 1);
  assert.equal(pool.statements[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(pool.releases, [false]);
  assert.ok(!pool.statements.some((sql) => /^(?:CREATE|ALTER|INSERT|DELETE|UPDATE|GRANT|COMMIT)\b/.test(sql)));
  safeOutput(output, result);
});

test('without a baseline it emits useful inventory and unverified nonzero status, with no file discovery', async () => {
  const { deps, output, events } = harness(undefined, { readBaselineFile: async () => { throw new Error('must not read'); } });
  const result = await saasMigrationAudit(commandOptions({ catalogBaseline: undefined }), deps);
  assert.deepEqual(events, ['create-pool']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.exitCode, 1);
  assert.equal(result.report?.compatibility, 'unverified');
  assert.equal(result.report?.catalog.actual.length, catalogRows.length);
  assert.ok(result.report?.issues.some(({ code }) => code === 'BASELINE_MISSING'));
  safeOutput(output, result);
});

for (const fixture of [{ driftVersion: 22 }, { driftVersion: 23 }, { catalogDrift: true }, { unknownVersion: 99999 }]) {
  test('ledger/checksum/catalog mismatch results in blocked nonzero JSON status', async () => {
    const { deps, output, pool } = harness(new CliAuditPool(fixture));
    const result = await saasMigrationAudit(commandOptions(), deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.exitCode, 1);
    assert.equal(result.report?.compatibility, 'mismatch');
    assert.equal(pool.ends, 1);
    safeOutput(output, result);
  });
}

test('registry changes are reflected dynamically, with no fixed maximum migration version', async () => {
  const { deps } = harness();
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.deepEqual(result.report?.migrations.map(({ version }) => version), expectations.migrations.map(({ version }) => version));
  assert.equal(result.report?.expectedMigrationsChecksum, expectations.checksum);
});

for (const field of ['deploymentId', 'environmentId', 'database', 'schema', 'releaseId'] as const) {
  test(`missing explicit ${field} fails before any baseline read or pool open`, async () => {
    const { deps, output, events, pool } = harness();
    const result = await saasMigrationAudit(commandOptions({ [field]: undefined }), deps);
    assert.equal(result.error?.code, 'INVALID_OPTIONS');
    assert.equal(result.exitCode, 2);
    assert.deepEqual(events, []);
    assert.equal(pool.connects, 0);
    safeOutput(output, result);
  });
}

test('there is no fallback to the application database URL or PG environment variables', async () => {
  const { deps, output, events } = harness(undefined, { env: {
    MODEL_ROUTER_SAAS_DATABASE_URL: fakeUrl, PGHOST: 'ignored-fixture',
    PGDATABASE: 'audit_fixture', PGPASSWORD: 'ignored-fixture-password',
  } });
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.equal(result.error?.code, 'AUDIT_URL_REQUIRED');
  assert.equal(result.exitCode, 2);
  assert.deepEqual(events, []);
  safeOutput(output, result);
});

for (const url of [
  sensitiveText, 'not-a-url', 'https://fixture.invalid/audit_fixture',
  'postgresql:///audit_fixture', 'postgresql://audit.example.invalid/audit_fixture',
  'postgresql://fixture@audit.example.invalid/other_database',
  'postgresql://fixture@audit.example.invalid/audit_fixture?host=localhost',
  'postgresql://fixture@audit.example.invalid/audit_fixture?sslkey=/fixture/key',
  'postgresql://fixture@audit.example.invalid/audit_fixture?sslmode=disable&sslmode=require',
  'postgresql://fixture@localhost:65432/audit_fixture?sslmode=disable',
  'postgresql://fixture@audit.example.invalid:65432/audit_fixture?sslmode=disable',
]) {
  test('invalid/ambiguous/plaintext URL is rejected before any pool is opened without echoing it', async () => {
    const { deps, output, events } = harness(undefined, { env: { [SAAS_MIGRATION_AUDIT_URL_ENV]: url } });
    const result = await saasMigrationAudit(commandOptions(), deps);
    assert.equal(result.error?.code, 'AUDIT_URL_INVALID');
    assert.deepEqual(events, []);
    assert.equal(result.report, null);
    safeOutput(output, result);
    assert.ok(!output[0].includes(url));
  });
}

test('explicit local plaintext policy requires both loopback and sslmode=disable', async () => {
  const localUrl = 'postgresql://fixture@127.0.0.1:65432/audit_fixture?sslmode=disable';
  const pool = new CliAuditPool();
  let factoryCalls = 0;
  const { deps, output } = harness(pool, {
    env: { [SAAS_MIGRATION_AUDIT_URL_ENV]: localUrl },
    createPool: (url) => { assert.equal(url, localUrl); factoryCalls += 1; return pool; },
  });
  const result = await saasMigrationAudit(commandOptions({ allowLocalPlaintext: true }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(factoryCalls, 1);
  safeOutput(output, result);
  assert.ok(!output[0].includes(localUrl));
  for (const hostname of ['audit.example.invalid', '127.remote.example.invalid', '0.0.0.0']) {
    const remote = harness(undefined, { env: {
      [SAAS_MIGRATION_AUDIT_URL_ENV]: `postgresql://fixture@${hostname}:65432/audit_fixture?sslmode=disable`,
    } });
    const rejected = await saasMigrationAudit(commandOptions({ allowLocalPlaintext: true }), remote.deps);
    assert.equal(rejected.error?.code, 'AUDIT_URL_INVALID');
    assert.deepEqual(remote.events, []);
  }
});

test('loopback 5432 is not globally banned by CLI policy; this fixture never opens a real connection', async () => {
  const pool = new CliAuditPool();
  const url = 'postgresql://fixture@localhost:5432/audit_fixture?sslmode=verify-full';
  const { deps, output } = harness(pool, { env: { [SAAS_MIGRATION_AUDIT_URL_ENV]: url },
    createPool: (received) => { assert.equal(received, url); return pool; } });
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.equal(result.exitCode, 0);
  safeOutput(output, result);
});

for (const text of ['{invalid', JSON.stringify({ secret: sensitiveText }), JSON.stringify(baseline({ objects: [] })), 'x'.repeat(16 * 1024 * 1024 + 1)]) {
  test('invalid baseline content produces sanitized JSON before opening the pool', async () => {
    const { deps, output, events } = harness(undefined, { readBaselineFile: async () => text });
    const result = await saasMigrationAudit(commandOptions(), deps);
    assert.equal(result.error?.code, 'BASELINE_INVALID');
    assert.deepEqual(events, []);
    safeOutput(output, result);
  });
}

for (const changed of [{ releaseId: 'other-release' }, { schema: 'other_schema' }, { migrationsChecksum: hash('old-registry') }]) {
  test('baseline binding mismatch fails before opening the pool', async () => {
    const { deps, output, events } = harness(undefined, { readBaselineFile: async () => JSON.stringify(baseline(changed)) });
    const result = await saasMigrationAudit(commandOptions(), deps);
    assert.equal(result.error?.code, 'BASELINE_BINDING_MISMATCH');
    assert.deepEqual(events, []);
    safeOutput(output, result);
  });
}

test('partial baseline remains unverified and never grants a successful CLI exit', async () => {
  const { deps, output } = harness(undefined, { readBaselineFile: async () => JSON.stringify(baseline({ coverage: 'partial' })) });
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report?.compatibility, 'unverified');
  safeOutput(output, result);
});

test('baseline file read errors hide path, driver messages and body', async () => {
  const { deps, output, events } = harness(undefined, { readBaselineFile: async () => { throw new Error(sensitiveText); } });
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.equal(result.error?.code, 'BASELINE_IO_FAILED');
  assert.deepEqual(events, []);
  safeOutput(output, result);
  assert.ok(!output[0].includes('/reviewed-fixture/catalog.json'));
});

test('a factory failure is sanitized and never prints the connection configuration', async () => {
  const { deps, output } = harness(undefined, { createPool: () => { throw new Error(sensitiveText); } });
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.equal(result.error?.code, 'AUDIT_FAILED');
  assert.equal(result.exitCode, 2);
  safeOutput(output, result);
});

test('connect failure and snapshot cleanup failure produce blocked reports and close the pool', async () => {
  for (const fixture of [{ connectError: true }, { rollbackError: true }]) {
    const { deps, output, pool } = harness(new CliAuditPool(fixture));
    const result = await saasMigrationAudit(commandOptions(), deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.exitCode, 1);
    assert.equal(pool.ends, 1);
    safeOutput(output, result);
  }
});

test('pool close failure overrides successful matching before reporting to operators', async () => {
  const { deps, output } = harness(new CliAuditPool({ closeError: true }));
  const result = await saasMigrationAudit(commandOptions(), deps);
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'POOL_CLOSE_FAILED');
  safeOutput(output, result);
});

test('report sink failure throws only a generic error after pool close', async () => {
  const { deps, pool } = harness(undefined, { writeLine: () => { throw new Error(sensitiveText); } });
  await assert.rejects(saasMigrationAudit(commandOptions(), deps), (error: unknown) => {
    assert.ok(error instanceof SaasMigrationAuditCommandError);
    assert.ok(!error.message.includes(fakeUrl));
    assert.equal(pool.ends, 1);
    return true;
  });
});

test('the default reader reads only the supplied file and does not promote or rewrite it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saas-audit-cli-'));
  const path = join(directory, 'reviewed.json');
  try {
    await writeFile(path, JSON.stringify(baseline()), 'utf8');
    const { deps, output } = harness(undefined, { readBaselineFile: undefined });
    const result = await saasMigrationAudit(commandOptions({ catalogBaseline: path }), deps);
    assert.equal(result.exitCode, 0);
    safeOutput(output, result);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI registration documents explicit audit URL and target labels', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migration-audit', '--help'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' },
  });
  for (const text of [SAAS_MIGRATION_AUDIT_URL_ENV, '--deployment-id', '--environment-id', '--database', '--schema', '--release-id', '--catalog-baseline', '--allow-local-plaintext']) {
    assert.ok(result.stdout.includes(text));
  }
});

test('real CLI action emits safe JSON and nonzero exit for missing input, without opening a database', async () => {
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migration-audit'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', [SAAS_MIGRATION_AUDIT_URL_ENV]: fakeUrl },
  }), (error: unknown) => {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 2);
    const output = JSON.parse(result.stdout) as SaasMigrationAuditCommandResult;
    assert.equal(output.error?.code, 'INVALID_OPTIONS');
    assert.equal(output.exitCode, 2);
    assert.ok(!result.stdout.includes(fakeUrl));
    assert.ok(!result.stderr.includes(fakeUrl));
    return true;
  });
});
