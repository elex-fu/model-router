import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Source contracts only. Never import the PG root, fixtures or runtime modules.
const rootPath = 'tests/saas/db/migrations/060_prepared_evidence_claim_generated_account.postgres.integration.test.ts';
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
function section(text: string, start: string, end: string): string {
  const offset = text.indexOf(start);
  assert.ok(offset >= 0, `missing source boundary: ${start}`);
  assert.equal(text.lastIndexOf(start), offset, 'source boundary must be unique');
  const finish = text.indexOf(end, offset + start.length);
  assert.ok(finish > offset, `missing following source boundary: ${end}`);
  return text.slice(offset, finish);
}
function inOrder(text: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, previous + 1);
    assert.ok(next > previous, `missing ordered source operation: ${marker}`);
    previous = next;
  }
}
const firstChild = "await t.test('exact one-field forward repair preserves owner/security/ACL/binding and historical ledger'";
const signedChild = "await t.test('real signed service claim commits one binding/version/audit and repeat claim is denied'";

test('normal 060 requires default full schema verification and the exact complete registered ledger before any child', () => {
  const root = source(rootPath);
  assert.match(root, /import \{ SAAS_MIGRATIONS \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/saas\/db\/migrations\/001_initial_schema\.js'/);
  const ledger = section(root, 'async function registeredLedger(', 'async function catalog(');
  for (const required of [
    'assert.equal(migration.version, 60)',
    "assert.equal(migration.name, 'prepared_evidence_claim_generated_account')",
    'assert.equal(SAAS_MIGRATIONS[59], migration,',
    'SAAS_MIGRATIONS.map(({ version }) => version)',
    'Array.from({ length: 60 }, (_, index) => index + 1)',
    'SAAS_MIGRATIONS.map(({ version, name, sql }) =>',
    "createHash('sha256').update(name).update('\\0').update(sql).digest('hex')",
    'SELECT version, name, checksum FROM model_router_saas.saas_schema_migrations ORDER BY version ASC',
    'assert.deepEqual(applied.rows, expected,',
  ]) assert.ok(ledger.includes(required), required);
  inOrder(root, [
    "test('normal registered 060 real restricted PostgreSQL generated-account claim regression'",
    "await phase('readiness', () => cancellationDatabases())",
    'databases = connected.databases',
    "await phase('readiness', () => registeredLedger(migrator))",
    firstChild,
  ]);
  const connection = section(source('tests/saas/gateway/pre-dispatch-postgres-fixture.ts'),
    'export async function cancellationDatabases()', 'export async function cancellationTransaction');
  assert.ok(connection.includes('await databases[0]!.verifySchema()'));
  assert.doesNotMatch(root, /SAAS_MIGRATIONS\.(?:filter|slice)|runSaasMigrations|verifySaasMigrations|\.migrate\s*\(|createSaasDatabase/);
  assert.doesNotMatch(root, /verifySchema\s*:\s*(?:async|\([^)]*\)\s*=>)|verifySchema\s*=/);
  assert.doesNotMatch(root, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:model_router_saas\.)?saas_schema_migrations\b/i);
});

test('the first child runs the frozen forward SQL only after a trusted local historical reconstruction and always rolls it back', () => {
  const root = source(rootPath);
  const child = section(root, firstChild, signedChild);
  inOrder(child, [
    'const deployed = await catalog(migrator)',
    'assert.equal(deployed.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE,',
    "const rollbackSentinel = new Error('060 transactional forward rehearsal rollback')",
    'let forwardRepairAck = false',
    'await assert.rejects(cancellationTransaction(migrator, async (tx) => {',
    "await tx.query('LOCK TABLE model_router_saas.saas_attempts, model_router_saas.saas_prepared_request_evidence IN ACCESS EXCLUSIVE MODE')",
    'assert.deepEqual(await catalog(tx), deployed,',
    'await tx.query(`CREATE OR REPLACE FUNCTION model_router_saas.saas_attempts_guard_prepared_evidence_claim_pool()',
    'RETURNS trigger LANGUAGE plpgsql AS $rehearsal_claim_guard$${PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE}$rehearsal_claim_guard$;',
    'const before = await catalog(tx)',
    'assert.equal(before.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE)',
    'assert.deepEqual({ ...before, source: deployed.source }, deployed,',
    'await tx.query(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.sql)',
    'const after = await catalog(tx)',
    'assert.equal(after.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE)',
    'assert.deepEqual({ ...after, source: before.source }, before,',
    'assert.deepEqual(after, deployed,',
    'forwardRepairAck = true',
    'throw rollbackSentinel',
    '}), (error: unknown) => error === rollbackSentinel)',
    'assert.equal(forwardRepairAck, true,',
    'assert.deepEqual(await catalog(migrator), deployed,',
    'await migrator.verifySchema()',
    'await registeredLedger(migrator)',
    'const privileges = (await gateway.query<',
    'assert.deepEqual(privileges, { direct_guard: false, account_update: false, key_update: false,',
  ]);
  assert.equal(root.split('CREATE OR REPLACE FUNCTION').length, 2, 'one test-local historical reconstruction only');
  assert.equal(child.split('throw rollbackSentinel').length, 2);
  assert.equal(child.split('await tx.query(').length, 4, 'only lock, historical body and frozen migration may be written');
  assert.doesNotMatch(child, /(?:migrator|gateway)\.query\((?:`|')[^`']*(?:CREATE|ALTER|UPDATE|INSERT|DELETE)/i);
  assert.doesNotMatch(child, /\b(?:GRANT|REVOKE|SECURITY DEFINER|ALTER ROLE|ALTER TABLE|DISABLE TRIGGER|COMMIT|SAVEPOINT)\b/);
  assert.doesNotMatch(child, /\.sql\.(?:replace|slice)|Object\.assign|sqlState\(error\)|error\.(?:message|stack|detail|cause)/);
  assert.ok(root.includes('it is not a 059-to-060 CLI upgrade proof. All real claims use deployed 060.'));
});

test('catalog comparisons retain every function field except source plus trigger bindings, relation authority and the entire historical ledger', () => {
  const root = source(rootPath);
  const catalog = section(root, 'async function catalog(', "test('normal registered 060");
  for (const required of [
    "to_jsonb(p) - 'prosrc' AS metadata",
    'jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgfoid = p.oid',
    "'acl'", 'c.relowner, c.relacl', "'columns'", 'to_jsonb(a)',
    "'constraints'", 'to_jsonb(c)', "'triggers'", 'to_jsonb(t)',
    'jsonb_agg(to_jsonb(m) ORDER BY m.version) FROM model_router_saas.saas_schema_migrations m',
    "'model_router_saas.saas_attempts_guard_prepared_evidence_claim_pool()'::regprocedure",
  ]) assert.ok(catalog.includes(required), required);
  assert.doesNotMatch(catalog, /WHERE m\.version|LIMIT|jsonb_strip_nulls/);
  const child = section(root, firstChild, signedChild);
  assert.ok(child.includes('assert.deepEqual({ ...after, source: before.source }, before,'));
  assert.ok(child.includes('assert.deepEqual(after, deployed,'));
  assert.ok(child.includes('assert.deepEqual(await catalog(migrator), deployed,'));
});

test('all six native proofs and original finite fixture diagnostics remain mandatory under the unchanged disposable role gate', () => {
  const root = source(rootPath);
  const children = [...root.matchAll(/await t\.test\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(children, [
    'exact one-field forward repair preserves owner/security/ACL/binding and historical ledger',
    'real signed service claim commits one binding/version/audit and repeat claim is denied',
    'GW cannot UPDATE INSERT-only account or credential authority: exact ACL denial leaves facts unchanged',
    'acknowledged valid GW sibling INSERT then evidence-attempt claim mismatch rejects 23514 and rolls back',
    'acknowledged real binding and claim audit roll back atomically on original transaction failure',
    'nonhistorical function lineage is refused without a second body/ACL/ledger change',
  ]);
  for (const required of [
    "skip: process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured",
    'timeout: 120_000',
    "diagnosedCase(child, 'signed_claim', 'evidence_claim'",
    "diagnosedCase(child, 'acl_denial', 'acl'",
    "diagnosedCase(child, 'sibling_claim', 'conflict'",
    "diagnosedCase(child, 'rollback', 'evidence_claim'",
    "preparedFixture(migrator, gateway, 'before_dispatch', diagnostic)",
    "assert.equal(fixture.boundVersion, '2')",
    "error.code === 'ALREADY_CLAIMED'",
    "sqlState(error) === '42501'",
    "siblingInsertAck && claimStarted && sqlState(error) === '23514'",
    'assert.equal(inserted.rowCount, 1); siblingInsertAck = true; diagnostic.siblingInsertAck = true;',
    "preparedFixture(migrator, gateway, 'after_claim_audit', diagnostic)",
    "assert.equal(fixture.bindingAcks, 1); assert.equal(fixture.auditAcks, 1); assert.equal(fixture.boundVersion, '2')",
    "sqlState(error) === '55000'",
    "finally { await phase('cleanup', () => Promise.all(databases.map((database) => database.close())))",
  ]) assert.ok(root.includes(required), required);
  assert.equal([...root.matchAll(/\bskip:/g)].length, 1);
  assert.doesNotMatch(root, /testNamePattern|\.skip\(|\.only\(/);
  const diagnostic = section(root, '// Exact finite vocabulary', '// Normal complete CLI 060');
  assert.match(diagnostic, /const nativeStates = \['42501', '55000', '55006', '23502', '23503', '23505', '23514',\s*'42P01', '42703', '42P08', '42883', '42601', '40P01', '40001', '55P03', '57014'\] as const/);
  assert.doesNotMatch(diagnostic, /error\.(?:message|stack|detail|cause)|Object\.getOwnPropertyDescriptor\(error, '(?:stack|detail|cause)'\)/);
  const refusal = section(root, "await t.test('nonhistorical function lineage", '  } catch (error) {\n    // No driver');
  inOrder(refusal, [
    'const before = await catalog(migrator)',
    'assert.equal(before.source, PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE)',
    'await assert.rejects(cancellationTransaction(migrator, (tx) => tx.query(PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION.sql))',
    "sqlState(error) === '55000'",
    'assert.deepEqual(await catalog(migrator), before)',
    'await migrator.verifySchema()',
    'await registeredLedger(migrator)',
  ]);
});

test('normal 060 adaptation retains the accepted signed fixture and its existing source contract without a shared helper override', () => {
  for (const [path, expected] of [
    ['tests/saas/metering/normal-success-postgres-fixture.ts', '8f2ec8929b1c29613ec354847c29db6af8beec7f0446fafe816727180bbc93e7'],
    ['tests/saas/metering/normal-success-postgres-fixture.test.ts', '964d3d1ba9168ea50b142de920790f2d96685acaaba08522b168d155c7f1db50'],
  ] as const) assert.equal(createHash('sha256').update(source(path)).digest('hex'), expected, path);
});
