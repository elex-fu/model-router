import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  classifyLegacyMain112Ledger,
  compatMigrationChecksum,
  extractCatalogNames,
  getLegacyMain112Manifests,
  getLegacyMain112SourceManifestChecksum,
  LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  LEGACY_MAIN_112_MIGRATION_NAME,
  LEGACY_MAIN_112_SOURCE_VERSION,
  LEGACY_MAIN_112_TARGET_VERSION,
  type LegacyMain112CompatPlanOutcome,
  runLegacyMain112CompatPlan,
  type SaasCompatLedgerRow,
} from '../../../src/saas/db/migrate-compat-legacy-112.js';
import {
  getSaasMigrationAuditExpectations,
  SAAS_MIGRATION_AUDIT_CATALOG_SQL,
  type SaasAuditCatalogBaseline,
} from '../../../src/saas/db/migration-audit.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

// The working tree may briefly contain another session's in-flight registry
// entry that is not yet a valid SaasMigration; the compat core must refuse
// such a registry, and these unit tests exercise the REAL 001..129 chain.
function validRegistry(): SaasMigration[] {
  const valid = SAAS_MIGRATIONS.filter(
    (migration) =>
      !!migration &&
      Number.isSafeInteger(migration.version) &&
      typeof migration.name === 'string' &&
      typeof migration.sql === 'string',
  );
  assert.ok(valid.length >= 110, `expected the real registry, got ${valid.length} valid entries`);
  return valid;
}

const REGISTRY = validRegistry();
const MANIFESTS = getLegacyMain112Manifests(REGISTRY);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

const sharedRows = (): SaasCompatLedgerRow[] =>
  MANIFESTS.shared.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: compatMigrationChecksum(migration),
  }));
const legacy112Row = (): SaasCompatLedgerRow => ({
  version: LEGACY_MAIN_112_SOURCE_VERSION,
  name: LEGACY_MAIN_112_MIGRATION_NAME,
  checksum: LEGACY_MAIN_112_MIGRATION_CHECKSUM,
});
const legacySourceRows = (): SaasCompatLedgerRow[] => [...sharedRows(), legacy112Row()];
const targetRows = (): SaasCompatLedgerRow[] =>
  MANIFESTS.target.map((entry) => ({ version: entry.version, name: entry.name, checksum: entry.checksum }));

// ---------------------------------------------------------------------------
// Fake cluster
// ---------------------------------------------------------------------------

interface CatalogFixtureRow {
  kind: string;
  identity: string;
  definition: string;
}

/** Synthesizes a catalog inventory containing every name the pending target migrations (and the identity 129) must create. */
function synthesizedCatalogRows(): CatalogFixtureRow[] {
  const pending = MANIFESTS.registry.filter(
    (migration) =>
      migration.version >= LEGACY_MAIN_112_SOURCE_VERSION && migration.version <= LEGACY_MAIN_112_TARGET_VERSION,
  );
  const seen = new Set<string>();
  const rows: CatalogFixtureRow[] = [];
  for (const migration of pending) {
    const { created } = extractCatalogNames(migration.sql);
    for (const entry of created) {
      const key = `${entry.kind}:${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        kind: entry.kind,
        // PostgreSQL stores identifiers truncated to 63 bytes.
        identity: `["fixture_table","${entry.name.slice(0, 63)}"]`,
        definition: 'fixture-definition',
      });
    }
  }
  return rows;
}

interface ClusterOptions {
  ledger?: SaasCompatLedgerRow[];
  serverVersionNum?: number;
  catalogRows?: CatalogFixtureRow[];
  preservationSummariesAfter?: Record<string, string>;
  /** Overrides the UPDATE ... SET version row count (default: the real match). */
  moveRowCount?: number;
  commitError?: Error;
  /** Replaces the ledger contents seen by reads after the advisory lock is taken. */
  ledgerAfterLock?: SaasCompatLedgerRow[];
  /** Registers this version's ledger row with a tampered checksum (post-apply verification must catch it). */
  poisonRecordVersion?: number;
}

interface ClusterFixture {
  events: string[];
  updateValues: unknown[] | null;
  options: ClusterOptions;
}

class FakeClient implements SaasDatabaseClient {
  private ledger: SaasCompatLedgerRow[];
  private txnBackup: SaasCompatLedgerRow[] | null = null;
  private lockTaken = false;
  private preservationCalls = 0;
  readonly pendingCompatSql = new Set(
    MANIFESTS.registry
      .filter((m) => m.version >= LEGACY_MAIN_112_SOURCE_VERSION && m.version < LEGACY_MAIN_112_TARGET_VERSION)
      .map((m) => m.sql),
  );

  constructor(
    private readonly fixture: ClusterFixture,
    ledger: SaasCompatLedgerRow[],
  ) {
    this.ledger = [...ledger];
  }

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const options = this.fixture.options;
    if (sql.includes("current_setting('server_version_num')")) {
      return { rows: [{ server_version_num: String(options.serverVersionNum ?? 180000) }] as Row[], rowCount: 1 };
    }
    if (sql === 'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC') {
      const source = this.lockTaken && options.ledgerAfterLock ? options.ledgerAfterLock : this.ledger;
      // The real query is ORDER BY version ASC.
      const sorted = [...source].sort((left, right) => left.version - right.version);
      return { rows: sorted as Row[], rowCount: sorted.length };
    }
    if (sql.startsWith('SET search_path') || sql.startsWith('RESET search_path')) {
      // The catalog snapshot pins search_path like the migration audit does.
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.startsWith('SELECT pg_advisory_lock($1, $2)')) {
      this.fixture.events.push('lock');
      this.lockTaken = true;
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql === 'SELECT pg_advisory_unlock($1, $2) AS unlocked') {
      this.fixture.events.push('unlock');
      return { rows: [{ unlocked: true }] as Row[], rowCount: 1 };
    }
    if (sql === 'BEGIN') {
      this.fixture.events.push('begin');
      this.txnBackup = [...this.ledger];
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql === 'COMMIT') {
      if (options.commitError) throw options.commitError;
      this.fixture.events.push('commit');
      this.txnBackup = null;
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') {
      this.fixture.events.push('rollback');
      if (this.txnBackup) this.ledger = this.txnBackup;
      this.txnBackup = null;
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.startsWith('UPDATE saas_schema_migrations SET version = $1')) {
      this.fixture.events.push('move');
      this.fixture.updateValues = values ? [...values] : null;
      if (options.moveRowCount !== undefined) return { rows: [] as Row[], rowCount: options.moveRowCount };
      const [toVersion, fromVersion, name, checksum] = (values ?? []) as [number, number, string, string];
      let matched = 0;
      this.ledger = this.ledger.map((row) => {
        if (row.version === fromVersion && row.name === name && row.checksum === checksum) {
          matched += 1;
          return { ...row, version: toVersion };
        }
        return row;
      });
      return { rows: [] as Row[], rowCount: matched };
    }
    if (sql.startsWith('INSERT INTO saas_schema_migrations')) {
      const [version, name, checksum] = (values ?? []) as [number, string, string];
      this.fixture.events.push(`record:${version}`);
      const recordedChecksum = options.poisonRecordVersion === Number(version) ? 'c'.repeat(64) : String(checksum);
      this.ledger.push({ version: Number(version), name: String(name), checksum: recordedChecksum });
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql === SAAS_MIGRATION_AUDIT_CATALOG_SQL) {
      this.fixture.events.push('catalog-snapshot');
      return { rows: [...(options.catalogRows ?? synthesizedCatalogRows())] as Row[], rowCount: 1 };
    }
    if (sql.includes('compat_data_preservation_counts')) {
      this.fixture.events.push('preservation-counts');
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (sql.includes('wallets_posted_balance_sum')) {
      this.preservationCalls += 1;
      this.fixture.events.push(`preservation-summaries:${this.preservationCalls}`);
      const base: Record<string, string> = {
        wallets_posted_balance_sum: '1000',
        reservations_reserved_count: '2',
        reservations_reserved_sum: '300',
        ledger_entries_amount_sum: '700',
        tenant_credential_versions_count: '1',
        tenant_credential_envelope_hash_sum: '42',
        platform_credential_versions_count: '0',
        platform_credential_envelope_hash_sum: '0',
      };
      const after =
        this.preservationCalls > 1 && options.preservationSummariesAfter ? options.preservationSummariesAfter : base;
      return { rows: [after] as Row[], rowCount: 1 };
    }
    if (this.pendingCompatSql.has(sql)) {
      this.fixture.events.push(`apply-sql`);
      return { rows: [] as Row[], rowCount: 0 };
    }
    this.fixture.events.push(`other:${sql.slice(0, 48)}`);
    return { rows: [] as Row[], rowCount: 0 };
  }

  release(): void {
    this.fixture.events.push('release');
  }
}

function makeCluster(options: ClusterOptions = {}): { pool: SaasDatabasePool; fixture: ClusterFixture } {
  const fixture: ClusterFixture = { events: [], updateValues: null, options };
  const ledger = options.ledger ?? legacySourceRows();
  let client: FakeClient | undefined;
  const pool: SaasDatabasePool = {
    async query(): Promise<SqlResult<never>> {
      throw new Error('the compat plan must use one checked-out client');
    },
    async connect(): Promise<SaasDatabaseClient> {
      client ??= new FakeClient(fixture, ledger);
      return client;
    },
    async end(): Promise<void> {},
  };
  return { pool, fixture };
}

function buildBaseline(
  rows: CatalogFixtureRow[],
  overrides: Partial<SaasAuditCatalogBaseline> = {},
): SaasAuditCatalogBaseline {
  return {
    profile: 'saas-ddl-v1',
    coverage: 'complete-profile',
    evidenceId: 'test-evidence',
    releaseId: 'test-release',
    schema: 'model_router_saas',
    postgresMajor: 18,
    migrationsChecksum: getLegacyMain112SourceManifestChecksum(REGISTRY),
    objects: rows.map(({ kind, identity, definition }) => ({
      kind: kind as SaasAuditCatalogBaseline['objects'][number]['kind'],
      identityChecksum: digest(identity),
      definitionChecksum: digest(definition),
    })),
    ...overrides,
  };
}

const PLAN_OPTIONS = {
  schema: 'model_router_saas',
  releaseId: 'test-release',
  migrations: REGISTRY,
};

// ---------------------------------------------------------------------------
// Registry + manifest derivation
// ---------------------------------------------------------------------------

test('the known identity checksum matches the current registry 129 entry', () => {
  const identity = MANIFESTS.identityTarget;
  assert.equal(identity.version, LEGACY_MAIN_112_TARGET_VERSION);
  assert.equal(identity.name, LEGACY_MAIN_112_MIGRATION_NAME);
  assert.equal(compatMigrationChecksum(identity), LEGACY_MAIN_112_MIGRATION_CHECKSUM);
});

test('manifests derive the shared prefix, legacy source chain, and compat target', () => {
  assert.equal(MANIFESTS.shared[MANIFESTS.shared.length - 1].version, 111);
  assert.equal(MANIFESTS.legacySource.length, MANIFESTS.shared.length + 1);
  assert.deepEqual(MANIFESTS.legacySource[MANIFESTS.legacySource.length - 1], legacy112Row());
  assert.equal(MANIFESTS.target[MANIFESTS.target.length - 1].version, LEGACY_MAIN_112_TARGET_VERSION);
  const pendingCompat = MANIFESTS.registry.filter(
    (migration) =>
      migration.version >= LEGACY_MAIN_112_SOURCE_VERSION && migration.version < LEGACY_MAIN_112_TARGET_VERSION,
  );
  assert.equal(pendingCompat.length, MANIFESTS.target.length - MANIFESTS.legacySource.length);
  assert.equal(pendingCompat.length, 17);
  assert.ok(pendingCompat.every((migration) => migration.version >= 112 && migration.version <= 128));
});

test('the source manifest checksum equals the audit expectations of the derived old-main registry', () => {
  const legacyRegistry: SaasMigration[] = [
    ...MANIFESTS.shared,
    { version: LEGACY_MAIN_112_SOURCE_VERSION, name: MANIFESTS.identityTarget.name, sql: MANIFESTS.identityTarget.sql },
  ];
  assert.equal(
    getLegacyMain112SourceManifestChecksum(REGISTRY),
    getSaasMigrationAuditExpectations(legacyRegistry).checksum,
  );
});

test('a registry without the known identity at 129 is refused before any database work', async () => {
  const renumbered = REGISTRY.filter((migration) => migration.version !== LEGACY_MAIN_112_TARGET_VERSION);
  const { pool } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, { ...PLAN_OPTIONS, migrations: renumbered });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'IDENTITY_TARGET_MISSING');
});

test('a registry whose 129 SQL drifted from the known identity is refused', async () => {
  const drifted = REGISTRY.map((migration) =>
    migration.version === LEGACY_MAIN_112_TARGET_VERSION
      ? { ...migration, sql: `${migration.sql}\n-- drifted` }
      : migration,
  );
  const { pool } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, { ...PLAN_OPTIONS, migrations: drifted });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'IDENTITY_TARGET_MISSING');
});

test('a pending target migration with non-transactional DDL is refused', async () => {
  const poisoned = REGISTRY.map((migration) =>
    migration.version === 115
      ? { ...migration, sql: 'CREATE INDEX CONCURRENTLY broken ON saas_wallets (id)' }
      : migration,
  );
  const { pool } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, { ...PLAN_OPTIONS, migrations: poisoned });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'INVALID_REGISTRY');
});

// ---------------------------------------------------------------------------
// Source-state classification matrix
// ---------------------------------------------------------------------------

test('classification matrix: every source state is classified precisely', () => {
  const cases: Array<{ rows: SaasCompatLedgerRow[]; expected: string; label: string }> = [
    { rows: legacySourceRows(), expected: 'legacy-112-source', label: 'complete old-main chain' },
    { rows: sharedRows(), expected: 'clean-prefix', label: 'complete shared prefix (head 111)' },
    { rows: sharedRows().slice(0, 10), expected: 'clean-prefix', label: 'partial shared prefix' },
    { rows: [], expected: 'clean-prefix', label: 'empty ledger' },
    { rows: targetRows(), expected: 'current-chain-complete', label: 'complete target chain' },
    { rows: targetRows().slice(0, 95), expected: 'current-chain-partial', label: 'partial current chain' },
    {
      rows: [...sharedRows(), { ...legacy112Row(), checksum: 'f'.repeat(64) }],
      expected: 'drifted-checksum',
      label: 'old-112 row with a drifted checksum',
    },
    {
      rows: (() => {
        const rows = [...sharedRows()];
        rows[10] = { ...rows[10], checksum: 'e'.repeat(64) };
        return [...rows, legacy112Row()];
      })(),
      expected: 'drifted-checksum',
      label: 'a shared row with a drifted checksum',
    },
    {
      rows: (() => {
        const rows = [...targetRows()];
        rows[95] = { ...rows[95], checksum: 'd'.repeat(64) };
        return rows;
      })(),
      expected: 'drifted-checksum',
      label: 'a current-chain row with a drifted checksum',
    },
    {
      rows: (() => {
        const rows = [...sharedRows()];
        rows.splice(50, 1);
        return [...rows, legacy112Row()];
      })(),
      expected: 'unknown-history',
      label: 'a gap in the shared prefix',
    },
    {
      rows: [...legacySourceRows(), { version: 999, name: 'mystery', checksum: 'a'.repeat(64) }],
      expected: 'unknown-history',
      label: 'an extra unknown version after the source state',
    },
    {
      rows: [
        ...sharedRows(),
        { version: 112, name: 'some_other_migration', checksum: LEGACY_MAIN_112_MIGRATION_CHECKSUM },
      ],
      expected: 'unknown-history',
      label: 'an unknown migration at 112',
    },
    {
      rows: [...legacySourceRows(), targetRows()[92]],
      expected: 'unknown-history',
      label: 'the legacy 112 plus a current 112 (impossible intermediate)',
    },
  ];
  for (const { rows, expected, label } of cases) {
    const classification = classifyLegacyMain112Ledger(rows, REGISTRY);
    assert.equal(classification.kind, expected, `case "${label}"`);
  }
});

test('classification never relies on the head version alone', () => {
  // A ledger whose HEAD is 112 but whose body is not the old-main chain.
  const rows = [...sharedRows().slice(0, 40), { version: 112, name: 'unrelated', checksum: 'b'.repeat(64) }];
  const classification = classifyLegacyMain112Ledger(rows, REGISTRY);
  assert.equal(classification.head, 112);
  assert.notEqual(classification.kind, 'legacy-112-source');
  assert.equal(classification.kind, 'unknown-history');
});

// ---------------------------------------------------------------------------
// Plan execution
// ---------------------------------------------------------------------------

test('dry-run on the complete source state performs zero mutations', async () => {
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, { ...PLAN_OPTIONS, dryRun: true });
  assert.equal(outcome.status, 'dry-run');
  assert.equal(outcome.classification?.kind, 'legacy-112-source');
  // The dry-run reads the server version and the ledger, then releases the
  // client: no lock, no transaction, no writes.
  assert.deepEqual(fixture.events, ['release']);
});

test('dry-run with a matching reviewed baseline verifies the catalog', async () => {
  const { pool } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    dryRun: true,
    catalogBaseline: buildBaseline(synthesizedCatalogRows()),
  });
  assert.equal(outcome.status, 'dry-run');
  assert.equal(outcome.catalogVerified, true);
});

test('dry-run with a mismatched baseline is refused before any lock', async () => {
  const rows = synthesizedCatalogRows();
  const tampered = [...rows, { kind: 'relation', identity: '["fixture_table","saas_unknown_extra"]', definition: 'x' }];
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    dryRun: true,
    catalogBaseline: buildBaseline(tampered),
  });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'BASELINE_MISMATCH');
  assert.ok(!fixture.events.includes('lock'));
});

test('a baseline bound to another schema, release, or manifest is refused up front', async () => {
  for (const overrides of [
    { schema: 'other_schema' },
    { releaseId: 'other-release' },
    { migrationsChecksum: '0'.repeat(64) },
    { postgresMajor: 16 },
    { coverage: 'partial' as const },
  ]) {
    const { pool } = makeCluster({ serverVersionNum: 180000 });
    const outcome = await runLegacyMain112CompatPlan(pool, {
      ...PLAN_OPTIONS,
      dryRun: true,
      catalogBaseline: buildBaseline(synthesizedCatalogRows(), overrides),
    });
    assert.equal(outcome.status, 'refused', `override ${JSON.stringify(overrides)}`);
    assert.equal(outcome.issues[0]?.code, 'BASELINE_MISMATCH', `override ${JSON.stringify(overrides)}`);
  }
});

test('apply on the complete source state moves 112 → 129 and applies 112..128 in one transaction', async () => {
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(outcome.move, {
    fromVersion: 112,
    toVersion: 129,
    name: LEGACY_MAIN_112_MIGRATION_NAME,
    checksum: LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  });
  assert.equal(outcome.applied.length, MANIFESTS.target.length - MANIFESTS.legacySource.length);
  assert.ok(outcome.applied.every((entry) => entry.version >= 112 && entry.version <= 128));
  // The move is keyed on the exact known identity.
  assert.deepEqual(fixture.updateValues, [
    129,
    112,
    LEGACY_MAIN_112_MIGRATION_NAME,
    LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  ]);
  // Sequence: lock, begin, reverify, move, applies, verify, commit, unlock.
  const lockIndex = fixture.events.indexOf('lock');
  const beginIndex = fixture.events.indexOf('begin');
  const moveIndex = fixture.events.indexOf('move');
  const commitIndex = fixture.events.indexOf('commit');
  const unlockIndex = fixture.events.indexOf('unlock');
  assert.ok(
    lockIndex >= 0 &&
      beginIndex > lockIndex &&
      moveIndex > beginIndex &&
      commitIndex > moveIndex &&
      unlockIndex > commitIndex,
  );
  assert.equal(fixture.events.filter((event) => event === 'commit').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'rollback').length, 0);
  assert.ok(outcome.verification?.targetHistoryVerified);
  assert.ok((outcome.verification?.catalogConstraintsVerified ?? 0) > 0);
  assert.ok((outcome.verification?.dataPreservation.length ?? 0) >= 8);
});

test('apply with a matching baseline verifies the source schema inside the transaction', async () => {
  const { pool } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    catalogBaseline: buildBaseline(synthesizedCatalogRows()),
  });
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.catalogVerified, true);
});

test('rerun on the complete target state is an idempotent no-op without a lock', async () => {
  const { pool, fixture } = makeCluster({ ledger: targetRows() });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'already-current');
  assert.equal(outcome.classification?.kind, 'current-chain-complete');
  assert.ok(!fixture.events.includes('lock'));
  assert.ok(!fixture.events.includes('begin'));
  assert.ok(!fixture.events.includes('move'));
});

test('apply on a clean prefix is refused with normal-migrate guidance and no lock', async () => {
  for (const ledger of [sharedRows(), sharedRows().slice(0, 10)]) {
    const { pool, fixture } = makeCluster({ ledger });
    const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.issues[0]?.code, 'STATE_NOT_APPLICABLE');
    assert.match(outcome.issues[0]?.detail ?? '', /saas:migrate/);
    assert.ok(!fixture.events.includes('lock'));
  }
});

test('apply on a partial current chain is refused (rerun matches only terminal states)', async () => {
  const { pool, fixture } = makeCluster({ ledger: targetRows().slice(0, 95) });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'STATE_NOT_APPLICABLE');
  assert.ok(!fixture.events.includes('lock'));
});

test('apply on a drifted checksum is refused and never reaches the ledger rewrite', async () => {
  const ledger = [...sharedRows(), { ...legacy112Row(), checksum: 'f'.repeat(64) }];
  const { pool, fixture } = makeCluster({ ledger });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'STATE_DRIFTED');
  assert.ok(!fixture.events.includes('lock'));
  assert.ok(!fixture.events.includes('move'));
  assert.equal(fixture.updateValues, null);
});

test('apply on an unknown history is refused', async () => {
  const ledger = [...legacySourceRows(), { version: 999, name: 'mystery', checksum: 'a'.repeat(64) }];
  const { pool, fixture } = makeCluster({ ledger });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'STATE_UNKNOWN');
  assert.ok(!fixture.events.includes('lock'));
});

test('unsupported PostgreSQL majors are refused', async () => {
  const { pool } = makeCluster({ serverVersionNum: 140000 });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.issues[0]?.code, 'UNSUPPORTED_POSTGRES');
});

// ---------------------------------------------------------------------------
// Failure injection (step-7 rollback semantics)
// ---------------------------------------------------------------------------

async function assertRolledBackToSource(
  outcome: LegacyMain112CompatPlanOutcome,
  fixture: ClusterFixture,
): Promise<void> {
  assert.equal(outcome.status, 'failed');
  assert.ok(fixture.events.includes('rollback'), 'the transaction must roll back');
  assert.ok(!fixture.events.includes('commit'), 'a failed plan must never commit');
  assert.ok(
    fixture.events.indexOf('rollback') < fixture.events.indexOf('unlock'),
    'rollback must happen before the advisory lock is released',
  );
}

test('a kill after the lock rolls back cleanly', async () => {
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    onPhase: (phase) => {
      if (phase === 'after-lock') throw new Error('simulated kill after lock');
    },
  });
  // The kill lands before BEGIN: no transaction exists, so no rollback is
  // needed — but nothing may have been written and the lock must be released.
  assert.equal(outcome.status, 'failed');
  assert.ok(!fixture.events.includes('begin'));
  assert.ok(!fixture.events.includes('commit'));
  assert.ok(!fixture.events.includes('move'));
  assert.ok(fixture.events.includes('unlock'));
});

test('a kill after the in-transaction re-verification rolls back cleanly', async () => {
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    onPhase: (phase) => {
      if (phase === 'after-reverify') throw new Error('simulated kill after reverify');
    },
  });
  await assertRolledBackToSource(outcome, fixture);
  assert.ok(!fixture.events.includes('move'));
});

test('a kill after the ledger move rolls back the move and all applies', async () => {
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    onPhase: (phase) => {
      if (phase === 'after-move') throw new Error('simulated kill after move');
    },
  });
  await assertRolledBackToSource(outcome, fixture);
  assert.ok(!fixture.events.some((event) => event.startsWith('record:')));
});

test('a kill in the middle of applying 112..128 rolls back cleanly', async () => {
  const midVersion = 120;
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    onPhase: (phase) => {
      if (phase === `after-apply:${midVersion}`) throw new Error(`simulated kill after applying ${midVersion}`);
    },
  });
  await assertRolledBackToSource(outcome, fixture);
  // Some migrations ran before the kill; none may survive the rollback.
  assert.ok(fixture.events.some((event) => event.startsWith('record:')));
});

test('a kill after verification but before COMMIT rolls back cleanly', async () => {
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, {
    ...PLAN_OPTIONS,
    onPhase: (phase) => {
      if (phase === 'after-verify') throw new Error('simulated kill after verify');
    },
  });
  await assertRolledBackToSource(outcome, fixture);
});

test('a failed COMMIT rolls back cleanly', async () => {
  const { pool, fixture } = makeCluster({ commitError: new Error('simulated commit failure') });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  await assertRolledBackToSource(outcome, fixture);
});

test('a source schema that drifted from the baseline inside the transaction fails closed', async () => {
  const rows = synthesizedCatalogRows();
  const baseline = buildBaseline([
    ...rows,
    { kind: 'relation', identity: '["fixture_table","saas_baseline_only"]', definition: 'x' },
  ]);
  const { pool, fixture } = makeCluster();
  const outcome = await runLegacyMain112CompatPlan(pool, { ...PLAN_OPTIONS, catalogBaseline: baseline });
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.issues.some((issue) => issue.code === 'BASELINE_MISMATCH'));
  assert.ok(fixture.events.includes('rollback'));
  assert.ok(!fixture.events.includes('move'), 'the move must not run when the schema drifted');
});

test('the ledger changing under the lock fails the re-verification', async () => {
  const { pool, fixture } = makeCluster({
    ledgerAfterLock: targetRows(),
  });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.issues.some((issue) => issue.code === 'REVERIFY_FAILED'));
  assert.ok(fixture.events.includes('rollback'));
  assert.ok(!fixture.events.includes('move'));
});

test('a ledger row that does not match the known identity exactly refuses the move', async () => {
  const { pool, fixture } = makeCluster({ moveRowCount: 0 });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.issues.some((issue) => issue.code === 'MOVE_FAILED'));
  assert.ok(fixture.events.includes('rollback'));
  assert.ok(!fixture.events.some((event) => event.startsWith('record:')));
});

test('a data-preservation probe that changes during the apply fails the same-transaction verification', async () => {
  const { pool, fixture } = makeCluster({
    preservationSummariesAfter: {
      wallets_posted_balance_sum: '999',
      reservations_reserved_count: '2',
      reservations_reserved_sum: '300',
      ledger_entries_amount_sum: '700',
      tenant_credential_versions_count: '1',
      tenant_credential_envelope_hash_sum: '42',
      platform_credential_versions_count: '0',
      platform_credential_envelope_hash_sum: '0',
    },
  });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'failed');
  assert.ok(
    outcome.issues.some(
      (issue) => issue.code === 'VERIFY_FAILED' && issue.detail.includes('wallets_posted_balance_sum'),
    ),
  );
  assert.ok(fixture.events.includes('rollback'));
});

test('a tampered post-apply ledger registration fails the same-transaction history verification', async () => {
  const { pool, fixture } = makeCluster({ poisonRecordVersion: 120 });
  const outcome = await runLegacyMain112CompatPlan(pool, PLAN_OPTIONS);
  assert.equal(outcome.status, 'failed');
  assert.ok(
    outcome.issues.some((issue) => issue.code === 'VERIFY_FAILED' && issue.detail.includes('complete target history')),
  );
  await assertRolledBackToSource(outcome, fixture);
});
