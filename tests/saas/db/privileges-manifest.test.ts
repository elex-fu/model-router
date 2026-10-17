import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  MIRROR_REGENERATIONS,
  readMirror,
  regenerateMirrorContents,
} from '../../../src/saas/db/privileges-generation.js';
import {
  MANIFEST_CONTROL_PLANE_COLUMN_GROUPS,
  MANIFEST_CONTROL_PLANE_COLUMN_SQL_ROWS,
  MANIFEST_CONTROL_PLANE_TABLE_GRANTS,
  MANIFEST_CONTROL_PLANE_TABLE_SQL_ROWS,
  MANIFEST_GATEWAY_AUXILIARY,
  MANIFEST_GATEWAY_COLUMN_GROUPS,
  MANIFEST_GATEWAY_COLUMN_SQL_ENTRIES,
  MANIFEST_GATEWAY_READ_SQL_ROWS,
  MANIFEST_GATEWAY_READ_TABLES,
  MANIFEST_WORKER_GRANT_STATEMENTS,
  MANIFEST_WORKER_PROBE_GRANTS,
  type SaasColumnPrivilege,
} from '../../../src/saas/db/privileges-manifest.js';
import { GATEWAY_DELETE_TABLES } from '../../../src/saas/db/runtime-privileges.js';

type Grant = `${string} ${string} ${SaasColumnPrivilege}`;

function toGrant(table: string, column: string, privilege: SaasColumnPrivilege): Grant {
  return `${table} ${column} ${privilege}`;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

test('every privilege mirror file is byte-identical to its regeneration from the manifest', () => {
  // This is the regenerability fence (DOps-2026-10-17 plan §4.2): a mirror file
  // may only change by editing the manifest and re-running
  // `npx tsx scripts/generate-privileges.ts`. Hand-editing a generated section
  // (constant arrays, VALUES manifests, worker GRANT statements) fails here.
  const regenerated = regenerateMirrorContents();
  assert.equal(MIRROR_REGENERATIONS.length, 4);
  for (const mirror of MIRROR_REGENERATIONS) {
    const onDisk = readFileSync(resolve(process.cwd(), mirror.path), 'utf8');
    assert.equal(onDisk, regenerated[mirror.path], `${mirror.path} must be byte-identical to its regeneration`);
  }
});

test('manifest control-plane views encode the same column grants in both mirrors', () => {
  const tsGrants = MANIFEST_CONTROL_PLANE_COLUMN_GROUPS.flatMap((group) =>
    group.columns.map((column) => toGrant(group.table, column, group.privilege)),
  );
  const sqlGrants = MANIFEST_CONTROL_PLANE_COLUMN_SQL_ROWS.flatMap((row) =>
    row.columns.map((column) => toGrant(row.table, column, row.privilege)),
  );
  assert.deepEqual(sorted(tsGrants), sorted(sqlGrants));
  assert.deepEqual(
    sorted(MANIFEST_CONTROL_PLANE_TABLE_GRANTS.map((grant) => grant.table)),
    sorted(MANIFEST_CONTROL_PLANE_TABLE_SQL_ROWS.map((row) => row.table)),
  );
});

test('manifest gateway views encode the same read tables and column grants in both mirrors', () => {
  assert.deepEqual(
    sorted(MANIFEST_GATEWAY_READ_TABLES.map((entry) => entry.table)),
    sorted(MANIFEST_GATEWAY_READ_SQL_ROWS.flatMap((row) => row.tables)),
  );
  const tsGrants = MANIFEST_GATEWAY_COLUMN_GROUPS.flatMap((group) =>
    group.columns.map((column) => toGrant(group.table, column, group.privilege)),
  );
  const sqlGrants = MANIFEST_GATEWAY_COLUMN_SQL_ENTRIES.map((entry) =>
    toGrant(entry.table, entry.column, entry.privilege),
  );
  assert.deepEqual(sorted(tsGrants), sorted(sqlGrants));
});

test('manifest worker views encode the same column grants in probe and grant script', () => {
  const probeGrants = MANIFEST_WORKER_PROBE_GRANTS.map((grant) => toGrant(grant.table, grant.column, grant.privilege));
  const statementGrants = MANIFEST_WORKER_GRANT_STATEMENTS.flatMap((statement) =>
    statement.columnLines.flat().map((column) => toGrant(statement.table, column, statement.privilege)),
  );
  assert.deepEqual(sorted(probeGrants), sorted(statementGrants));
});

test('manifest gateway auxiliary facts match the runtime-privileges constants', () => {
  assert.deepEqual([...GATEWAY_DELETE_TABLES], MANIFEST_GATEWAY_AUXILIARY.deleteTables);
  const source = readMirror('src/saas/db/runtime-privileges.ts');
  const fullInsert = source.match(/const GATEWAY_FULL_INSERT_TABLES = \[([^\]]*)\] as const;/);
  const sequence = source.match(/const GATEWAY_SEQUENCE = '([^']+)' as const;/);
  assert.ok(fullInsert && sequence);
  assert.deepEqual(
    fullInsert[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
    MANIFEST_GATEWAY_AUXILIARY.fullInsertTables,
  );
  assert.equal(sequence[1], MANIFEST_GATEWAY_AUXILIARY.usageSequence);
});
