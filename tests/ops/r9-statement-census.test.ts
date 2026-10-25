import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const file = resolve(__dirname, '../../scripts/ops/run-current-r9.mjs');
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['gatewayCensusRequestCount', 'exportPgStatementCensus', 'pgStatementCensusSatisfied'];
const declarations = ast.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
);
assert.equal(declarations.length, names.length);
interface Observation {
  observationOk: boolean;
  requests: number;
  callsPerRequest: number;
}
interface Database {
  query(sql: string): Promise<{ rows: unknown[] }>;
  close(): Promise<void>;
}
interface Helpers {
  gatewayCensusRequestCount(stats: unknown): number;
  exportPgStatementCensus(
    factory: (options: unknown) => Database,
    url: string,
    directory: string,
  ): Promise<Observation>;
  pgStatementCensusSatisfied(required: boolean, observation: unknown): boolean;
}
const helpers = runInContext(
  `${declarations.map((node) => node.getText(ast)).join('\n')}\n({${names.join(',')}})`,
  createContext({ assert, readFile, writeFile, join }),
) as Helpers;

function database(failAt?: 'total' | 'top' | 'close') {
  const queries: string[] = [];
  let closed = 0;
  return {
    queries,
    get closed() {
      return closed;
    },
    factory(options: unknown): Database {
      assert.equal(JSON.stringify(options), JSON.stringify({ connectionString: 'offline-stub', max: 1 }));
      return {
        async query(sql) {
          queries.push(sql);
          if ((queries.length === 1 && failAt === 'total') || (queries.length === 2 && failAt === 'top')) {
            throw new Error(`stub ${failAt} failure`);
          }
          return {
            rows: queries.length === 1 ? [{ calls: '900', exec_ms: 12 }] : [{ calls: 900, query: 'select fixture' }],
          };
        },
        async close() {
          closed++;
          if (failAt === 'close') throw new Error('stub close failure');
        },
      };
    },
  };
}

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'r9-statement-census-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const directRequests of [0, 100, 200, 37]) {
  test(`census counts observed gateway attempts with ${directRequests} anonymous direct attempts`, async () => {
    await fixture(async (directory) => {
      // Includes non-streaming + streaming direct legs, or a partial-failure
      // run. No configured report count is read or guessed by the exporter.
      await writeFile(
        join(directory, 'final-mock-stats.json'),
        JSON.stringify({
          accounts: {
            '(anonymous)': { requests: directRequests },
            'gateway-a': { requests: 40 },
            'gateway-b': { requests: 50 },
          },
        }),
      );
      const db = database();
      const observation = await helpers.exportPgStatementCensus(db.factory, 'offline-stub', directory);
      assert.equal(db.queries.length, 2);
      assert.match(db.queries[0], /sum\(calls\)/);
      assert.match(db.queries[1], /ORDER BY calls DESC LIMIT 20/);
      assert.equal(db.closed, 1);
      assert.equal(observation.observationOk, true);
      assert.equal(observation.requests, 90);
      assert.equal(observation.callsPerRequest, 10);
      const output = join(directory, 'pg-stat-statements.json');
      const evidence = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(evidence.schema, 2);
      assert.equal(evidence.normalization, 'observed-authenticated-mock-upstream-attempts');
      assert.equal(evidence.requests, 90);
      assert.equal(evidence.callsPerRequest, 10);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.equal(helpers.pgStatementCensusSatisfied(true, observation), true);
    });
  });
}

for (const failAt of ['total', 'top', 'close'] as const) {
  test(`export propagates ${failAt} failure and closes its database`, async () => {
    await fixture(async (directory) => {
      await writeFile(join(directory, 'final-mock-stats.json'), '{"accounts":{"gateway":{"requests":1}}}');
      const db = database(failAt);
      await assert.rejects(helpers.exportPgStatementCensus(db.factory, 'offline-stub', directory), /stub .* failure/);
      assert.equal(db.closed, 1);
    });
  });
}

test('missing or malformed observed counters never fall back to configured samples', async () => {
  for (const stats of [
    undefined,
    '{',
    '{}',
    '{"accounts":{"(anonymous)":{"requests":200}}}',
    '{"accounts":{"gateway":{"requests":"100"}}}',
    '{"accounts":{"gateway":{"requests":-1}}}',
  ]) {
    await fixture(async (directory) => {
      if (stats !== undefined) await writeFile(join(directory, 'final-mock-stats.json'), stats);
      await writeFile(
        join(directory, 'serial-profile-current-3cli.json'),
        '{"config":{"requests":100,"streamSamples":100}}',
      );
      const db = database();
      await assert.rejects(helpers.exportPgStatementCensus(db.factory, 'offline-stub', directory));
      assert.equal(db.closed, 1);
      await assert.rejects(stat(join(directory, 'pg-stat-statements.json')), { code: 'ENOENT' });
    });
  }
});

test('export write failure is propagated and closes its database', async () => {
  await fixture(async (directory) => {
    await writeFile(join(directory, 'final-mock-stats.json'), '{"accounts":{"gateway":{"requests":1}}}');
    // A directory with the target filename forces writeFile to fail without
    // relying on permissions (the test is also valid when running as root).
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'pg-stat-statements.json'));
    const db = database();
    await assert.rejects(helpers.exportPgStatementCensus(db.factory, 'offline-stub', directory));
    assert.equal(db.closed, 1);
  });
});

test('actual final manifest gate rejects requested missing/failed census, even with otherwise successful cleanup', () => {
  let expression: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.getText(ast) === 'manifest.ok'
    )
      expression = node.right.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, 'actual manifest.ok assignment must be present');
  for (const required of [false, true]) {
    for (const observation of [
      undefined,
      { error: 'query failed' },
      { observationOk: false },
      { observationOk: true, requests: 0, callsPerRequest: null },
      { observationOk: true, requests: 90, callsPerRequest: 10 },
    ]) {
      const manifest = {
        cleanup: { processesStopped: true, postgresStopped: true, runtimeRemoved: true },
        pgStatementCensus: observation,
      };
      const ok = runInContext(
        expression,
        createContext({
          manifest,
          interrupted: false,
          process: { env: { R9_PG_STAT_STATEMENTS: required ? '1' : '0' } },
          pgStatementCensusSatisfied: helpers.pgStatementCensusSatisfied,
        }),
      );
      assert.equal(ok, !required || (observation?.observationOk === true && observation.requests === 90));
    }
  }
});
