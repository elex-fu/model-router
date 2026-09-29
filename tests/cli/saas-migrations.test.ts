import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { type SaasMigrationDependencies, saasMigrate } from '../../src/cli/saas-migrations.js';
import type { SaasDatabase, SaasDatabaseOptions, SqlExecutor } from '../../src/saas/db/types.js';

const exec = promisify(execFile);
const connectionString = 'postgresql://cli-user:cli-secret@localhost/saas';

function fakeDatabase(
  events: string[],
  options: { pingError?: Error; migrateError?: Error; closeError?: Error } = {},
): SaasDatabase {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return work({
        async query() {
          return { rows: [], rowCount: 0 };
        },
      });
    },
    async ping() {
      events.push('ping');
      if (options.pingError) throw options.pingError;
    },
    async migrate() {
      events.push('migrate');
      if (options.migrateError) throw options.migrateError;
    },
    async close() {
      events.push('close');
      if (options.closeError) throw options.closeError;
    },
  };
}

function dependencies(
  events: string[],
  database: SaasDatabase,
  overrides: Partial<SaasMigrationDependencies> = {},
): SaasMigrationDependencies {
  return {
    env: { MODEL_ROUTER_SAAS_DATABASE_URL: connectionString },
    createDatabase: (options: SaasDatabaseOptions) => {
      events.push(`create:${options.connectionString}`);
      return database;
    },
    writeLine: (line: string) => events.push(`write:${line}`),
    ...overrides,
  };
}

test('saas:migrate requires MODEL_ROUTER_SAAS_DATABASE_URL before opening a database', async () => {
  let created = false;
  await assert.rejects(
    saasMigrate({
      env: {},
      createDatabase: () => {
        created = true;
        throw new Error('must not create a database');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MODEL_ROUTER_SAAS_DATABASE_URL is required for saas:migrate/);
      return true;
    },
  );
  assert.equal(created, false);
});

test('saas:migrate pings before explicitly migrating and closes after success', async () => {
  const events: string[] = [];
  await saasMigrate(dependencies(events, fakeDatabase(events)));
  assert.deepEqual(events, [
    `create:${connectionString}`,
    'ping',
    'migrate',
    'close',
    'write:SaaS database migrations applied successfully. Server startup never runs migrations; run model-router saas:migrate explicitly.',
  ]);
});

test('saas:migrate closes the database when migration fails and sanitizes the failure', async () => {
  const events: string[] = [];
  const secret = 'migration-password-never-report';
  await assert.rejects(
    saasMigrate(dependencies(events, fakeDatabase(events, { migrateError: new Error(`password=${secret}`) }))),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unable to apply SaaS database migrations/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /password=/);
      return true;
    },
  );
  assert.deepEqual(events, [`create:${connectionString}`, 'ping', 'migrate', 'close']);
});

test('saas:migrate sanitizes connection failures and closes the database', async () => {
  const events: string[] = [];
  const secret = 'connection-secret-never-report';
  await assert.rejects(
    saasMigrate(dependencies(events, fakeDatabase(events, { pingError: new Error(`postgresql://${secret}@db/saas`) }))),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unable to connect to the SaaS PostgreSQL database/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /postgresql:/);
      return true;
    },
  );
  assert.deepEqual(events, [`create:${connectionString}`, 'ping', 'close']);
});

test('saas:migrate reports cleanup failures without leaking connection details', async () => {
  const events: string[] = [];
  await assert.rejects(
    saasMigrate(dependencies(events, fakeDatabase(events, { closeError: new Error('pool secret=never-report') }))),
    /Unable to close the SaaS PostgreSQL database connection/,
  );
  assert.deepEqual(events, [`create:${connectionString}`, 'ping', 'migrate', 'close']);
});

test('saas:migrate is registered and documents explicit migrations', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--help'], {
    cwd: process.cwd(),
  });
  assert.match(result.stdout, /saas:migrate/);
  assert.match(result.stdout, /Server startup never runs migrations/);
});
