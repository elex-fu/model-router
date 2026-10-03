import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderSupplyRepository, type ProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import type { ProviderCredentialReference } from '../../../src/saas/supply/types.js';

// Query-contract regressions only, not an actual PostgreSQL/worker proof.
// int8 strings model the real driver's default; no global pg parser changes.
const at = '2026-10-02T00:00:00.000Z';
type Operation = 'lifecycle' | 'validation';
const references: readonly ProviderCredentialReference[] = [
  { ownerKind: 'tenant', tenantId: '00000000-0000-4000-8000-000000000001', accountId: 'fixture-account', credentialId: 'fixture-credential' },
  { ownerKind: 'platform', tenantId: null, accountId: 'fixture-account', credentialId: 'fixture-credential' },
];
type Statement = { sql: string; values: readonly unknown[] };

class AuthzVersionDatabase implements SaasDatabase {
  readonly statements: Statement[] = [];
  readonly table: string;
  readonly versions: string;
  constructor(readonly reference: ProviderCredentialReference, readonly stored: unknown,
    readonly options: { missing?: boolean; casLost?: boolean; returned?: number | string } = {}) {
    this.table = `saas_${reference.ownerKind}_provider_credentials`;
    this.versions = `saas_${reference.ownerKind}_provider_credential_versions`;
  }
  private row(authz: unknown, validation: boolean) {
    return {
      owner_kind: this.reference.ownerKind, tenant_id: this.reference.tenantId,
      supply_mode: this.reference.ownerKind === 'tenant' ? 'byok' : 'platform',
      id: this.reference.credentialId, account_id: this.reference.accountId,
      provider_id: 'synthetic-provider', product_id: 'synthetic-product', credential_type: 'api-key',
      status: validation ? 'active' : 'revoked', validation_state: 'verified', validation_error_code: null,
      last_validated_at: at, current_version: 1, expires_at: null, authz_version: authz,
      created_at: at, updated_at: at, disabled_at: null, revoked_at: validation ? null : at,
    };
  }
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push({ sql: normalized, values: [...values] });
    let rows: unknown[];
    if (normalized.startsWith('SELECT pg_advisory_xact_lock(')) rows = [];
    else if (normalized.startsWith('SELECT ') && normalized.includes(`FROM ${this.table} `) && normalized.endsWith('FOR UPDATE')) {
      rows = this.options.missing ? [] : [this.row(this.stored, true)];
    } else if (normalized.startsWith(`SELECT version FROM ${this.versions} `)) rows = [{ version: 1 }];
    else if (normalized.startsWith(`UPDATE ${this.table} SET `)) {
      rows = this.options.casLost ? [] : [this.row(this.options.returned ?? '2', normalized.includes('SET validation_state'))];
    } else if (normalized.startsWith(`UPDATE ${this.versions} SET `)) rows = [];
    else throw new Error('Unexpected authorization-version query contract');
    return { rows: rows as Row[], rowCount: rows.length };
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return work(this); }
  async migrate(): Promise<void> { throw new Error('Unit fixture cannot migrate'); }
  async verifySchema(): Promise<void> { throw new Error('Unit fixture cannot verify a real schema'); }
  async ping(): Promise<void> { throw new Error('Unit fixture cannot ping a real database'); }
  async close(): Promise<void> {}
}

function invoke(repository: ProviderSupplyRepository, operation: Operation, credential: ProviderCredentialReference,
  expectedAuthzVersion = 1) {
  return operation === 'lifecycle'
    ? repository.updateCredentialLifecycle({ credential, status: 'revoked', expectedAuthzVersion,
      updatedAt: at, disabledAt: null, revokedAt: at })
    : repository.updateCredentialValidation({ credential, validationState: 'verified', validationErrorCode: null,
      lastValidatedAt: at, expectedAuthzVersion, updatedAt: at });
}
function execute(database: AuthzVersionDatabase, operation: Operation, expected = 1) {
  return new PostgresProviderSupplyRepository(database).transaction((repository) =>
    invoke(repository, operation, database.reference, expected));
}
function mutations(database: AuthzVersionDatabase) {
  return database.statements.filter(({ sql }) => /^(?:UPDATE|INSERT|DELETE)\b/.test(sql));
}
function assertFences(database: AuthzVersionDatabase, operation: Operation, includeVersion: boolean) {
  const ref = database.reference;
  const expectedKeys = ref.ownerKind === 'tenant'
    ? [saasAdvisoryKey.tenant(ref.tenantId!), saasAdvisoryKey.tenantProviderAccount(ref.tenantId!, ref.accountId),
      saasAdvisoryKey.tenantProviderCredential(ref.tenantId!, ref.credentialId)]
    : [saasAdvisoryKey.platformProviderAccount(ref.accountId), saasAdvisoryKey.platformProviderCredential(ref.credentialId)];
  if (operation === 'lifecycle' && includeVersion) {
    expectedKeys.push(saasAdvisoryKey.credentialVersion(ref.ownerKind, ref.tenantId ?? ref.accountId, ref.credentialId, 1));
  }
  const locks = database.statements.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_xact_lock('));
  assert.deepEqual(locks.map(({ values }) => values), expectedKeys.map((key) => [key]));
  assert.ok(locks.every(({ sql }) => sql === 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))'));
  const parentLock = database.statements.findIndex(({ sql }) => sql.includes(`FROM ${database.table} `) && sql.endsWith('FOR UPDATE'));
  assert.ok(parentLock >= expectedKeys.length - (includeVersion && operation === 'lifecycle' ? 1 : 0));
  const writes = mutations(database);
  assert.ok(writes.every((statement) => database.statements.indexOf(statement) > parentLock));
}

for (const reference of references) for (const operation of ['lifecycle', 'validation'] as const) {
  const label = `${reference.ownerKind} ${operation}`;
  for (const stored of ['1', 1]) test(`${label}: driver string/number ${typeof stored} version 1 matches the numeric CAS`, async () => {
    const database = new AuthzVersionDatabase(reference, stored);
    const record = await execute(database, operation);
    assert.ok(record);
    assert.equal(record.authzVersion, 2);
    const update = database.statements.find(({ sql }) => sql.startsWith(`UPDATE ${database.table} SET `));
    assert.ok(update);
    assert.match(update.sql, /AND authz_version = \$5 RETURNING /);
    assert.equal(update.values[4], 1, 'SQL CAS still uses the exact caller version, not a coerced/replaced version');
    assertFences(database, operation, true);
    if (operation === 'lifecycle') {
      const versionLock = database.statements.findIndex(({ sql }) => sql.startsWith(`SELECT version FROM ${database.versions} `));
      assert.ok(versionLock >= 0 && versionLock < database.statements.indexOf(update));
      assert.match(database.statements[versionLock]!.sql, /FOR UPDATE$/);
      assert.equal(mutations(database).filter(({ sql }) => sql.startsWith(`UPDATE ${database.versions} `)).length, 1);
    }
  });
  for (const stored of ['2', 2]) test(`${label}: mismatched ${typeof stored} version is a no-op`, async () => {
    const database = new AuthzVersionDatabase(reference, stored);
    assert.equal(await execute(database, operation), null);
    assert.deepEqual(mutations(database), []);
    assertFences(database, operation, false);
  });
  test(`${label}: missing locked row is a no-op`, async () => {
    const database = new AuthzVersionDatabase(reference, '1', { missing: true });
    assert.equal(await execute(database, operation), null);
    assert.deepEqual(mutations(database), []);
  });
  for (const stored of ['malformed', '', '1.5', 0, -1, 1.5, NaN, Infinity, '9007199254740992', 9007199254740992, null, undefined]) {
    test(`${label}: invalid stored version ${String(stored)} fails closed before any mutation`, async () => {
      const database = new AuthzVersionDatabase(reference, stored);
      await assert.rejects(execute(database, operation), { code: 'INVALID_STORED_VERSION' });
      assert.deepEqual(mutations(database), []);
      assertFences(database, operation, false);
    });
  }
  for (const expected of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`${label}: malformed/unsafe expected ${String(expected)} cannot match a valid stored version`, async () => {
      const database = new AuthzVersionDatabase(reference, '1');
      assert.equal(await execute(database, operation, expected), null);
      assert.deepEqual(mutations(database), []);
    });
  }
  test(`${label}: highest safe stored boundary does not match the next unsafe caller version`, async () => {
    const database = new AuthzVersionDatabase(reference, String(Number.MAX_SAFE_INTEGER));
    assert.equal(await execute(database, operation, Number.MAX_SAFE_INTEGER + 1), null);
    assert.deepEqual(mutations(database), []);
  });
  test(`${label}: SQL CAS loss cannot return success or revoke any version`, async () => {
    const database = new AuthzVersionDatabase(reference, '1', { casLost: true });
    assert.equal(await execute(database, operation), null);
    assert.equal(mutations(database).length, 1, 'only the existing conditional parent UPDATE was attempted');
    assert.ok(mutations(database).every(({ sql }) => sql.startsWith(`UPDATE ${database.table} `)));
    assertFences(database, operation, true);
  });
}
