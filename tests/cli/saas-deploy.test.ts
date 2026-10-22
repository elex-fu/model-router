import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  parseSaasDeployEnvFile,
  parseWorkerExpectedColumnGrants,
  type SaasDeployCommandDependencies,
  type SaasDeployCommandOptions,
  saasDeploy,
} from '../../src/cli/saas-deploy.js';
import type { SaasDatabaseClient, SaasDatabasePool } from '../../src/saas/db/types.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Fake deployment environment (loopback disposable cluster shape; the values
// below are fixtures, not credentials of anything real).
// ---------------------------------------------------------------------------

const DATABASE = 'model_router_test_deploy';
const HOST = '127.0.0.1:55438';
const pgUrl = (user: string, password: string): string =>
  `postgresql://${user}:${password}@${HOST}/${DATABASE}?sslmode=disable`;

const SECRETS = {
  admin: 'admin-secret-fixture',
  migrator: 'migrator-secret-fixture',
  controlPlane: 'cp-secret-fixture',
  gateway: 'gateway-secret-fixture',
  worker: 'worker-secret-fixture',
  redis: 'redis-secret-fixture',
} as const;

const ALL_SECRET_VALUES = Object.values(SECRETS);

function baseEnv(): Record<string, string> {
  return {
    MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL: pgUrl('deploy_admin', SECRETS.admin),
    MODEL_ROUTER_SAAS_DATABASE_URL: pgUrl('model_router_saas_migrator', SECRETS.migrator),
    MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: pgUrl('model_router_saas_control_plane', SECRETS.controlPlane),
    MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: pgUrl('model_router_saas_gateway', SECRETS.gateway),
    MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: pgUrl('model_router_saas_validation_worker', SECRETS.worker),
    MODEL_ROUTER_SAAS_REDIS_URL: `redis://127.0.0.1:55439`,
    MODEL_ROUTER_SAAS_REDIS_PROVIDER: '/trusted/modules/redis-provider.mjs',
    MODEL_ROUTER_SAAS_KMS_PROVIDER: '/trusted/modules/credential-provider.mjs',
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: '/trusted/modules/gateway-decrypt.mjs',
    MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: '/trusted/modules/gateway-runtime.mjs',
    SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: '/trusted/modules/worker-decrypt.mjs',
  };
}

// ---------------------------------------------------------------------------
// Fake pools
// ---------------------------------------------------------------------------

interface RecordedQuery {
  readonly pool: string;
  readonly sql: string;
}

type QueryHandler = (pool: string, sql: string) => { rows: unknown[]; rowCount: number };

function fakePool(name: string, handler: QueryHandler, log: RecordedQuery[]): SaasDatabasePool {
  const run = (sql: string, values?: readonly unknown[]) => {
    log.push({ pool: name, sql });
    if (values !== undefined) log.push({ pool: name, sql: `<${values.length} bound values>` });
    return handler(name, sql);
  };
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      return run(sql, values) as { rows: Row[]; rowCount: number };
    },
    async connect(): Promise<SaasDatabaseClient> {
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          return run(sql, values) as { rows: Row[]; rowCount: number };
        },
        release: () => undefined,
      };
    },
    async end() {},
  };
}

interface ClusterState {
  /** PostgreSQL roles that exist (pg_roles). */
  roles: Set<string>;
  /** server_version_num. */
  version: number;
  /** Schema owner; empty string when the schema is absent. */
  schemaOwner: string;
  /** Administrator privileges for the server-info row. */
  adminPrivileges: 'superuser' | 'createrole' | 'none';
  /** Diagnostic missing-grant rows returned to has_column_privilege probes. */
  missingGrants: Array<{ table_name: string; column_name: string; privilege_type: string }>;
}

function makeDependencies(state: ClusterState, log: RecordedQuery[], events: string[]): SaasDeployCommandDependencies {
  const handler: QueryHandler = (pool, sql) => {
    if (sql.includes('server_version_num')) {
      return {
        rows: [
          {
            server_version_num: state.version,
            current_user: pool,
            current_database: DATABASE,
            rolsuper: pool === 'deploy_admin' && state.adminPrivileges === 'superuser',
            rolcreaterole: pool === 'deploy_admin' && state.adminPrivileges !== 'none',
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('pg_namespace')) {
      return {
        rows: state.schemaOwner === '' ? [] : [{ owner: state.schemaOwner }],
        rowCount: state.schemaOwner === '' ? 0 : 1,
      };
    }
    if (sql.includes('pg_roles') && sql.includes('ANY(')) {
      return {
        rows: [...state.roles].map((rolname) => ({ rolname })),
        rowCount: state.roles.size,
      };
    }
    if (sql.includes('has_column_privilege') || sql.includes('has_table_privilege')) {
      return { rows: state.missingGrants, rowCount: state.missingGrants.length };
    }
    if (sql.trim() === 'SELECT current_user') {
      return { rows: [{ current_user: pool }], rowCount: 1 };
    }
    if (sql.includes("format('ALTER ROLE")) {
      return { rows: [{ statement: 'ALTER ROLE (redacted fixture)' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    env: baseEnv(),
    createPool: (connectionString) => {
      const user = new URL(connectionString).username;
      events.push(`pool:${user}`);
      return fakePool(user, handler, log);
    },
    runMigrations: async (pool) => {
      events.push('migrate');
      await pool.query('SELECT 1 FROM saas_schema_migrations');
    },
    verifyMigrations: async () => {
      events.push('verify-migrations');
    },
    verifyRuntimeRole: async (role) => {
      events.push(`probe:${role}`);
    },
    readFile: async (path) => {
      if (path.endsWith('.sql')) {
        events.push(`template:${path.split('/').pop()}`);
        return `-- template fixture ${path}\nBEGIN;\nSELECT 'template-body-${path.split('/').pop()}';\nCOMMIT;\n`;
      }
      events.push(`env-file:${path}`);
      return '';
    },
    connectPort: async () => {
      events.push('connect-port');
      return false;
    },
    writeLine: (line) => {
      events.push(`out:${line}`);
    },
  };
}

function freshState(): ClusterState {
  return { roles: new Set(), version: 180006, schemaOwner: '', adminPrivileges: 'superuser', missingGrants: [] };
}

function deployedState(): ClusterState {
  return {
    roles: new Set([
      'model_router_saas_migrator',
      'model_router_saas_control_plane',
      'model_router_saas_gateway',
      'model_router_saas_validation_worker',
    ]),
    version: 180006,
    schemaOwner: 'model_router_saas_migrator',
    adminPrivileges: 'superuser',
    missingGrants: [],
  };
}

const FULL_OPTIONS: SaasDeployCommandOptions = { allowLocalPlaintext: true };

function output(events: readonly string[]): string {
  return events.filter((event) => event.startsWith('out:')).join('\n');
}

function queries(log: readonly RecordedQuery[], pool?: string): string {
  return log
    .filter((entry) => entry.sql.startsWith('<') === false)
    .filter((entry) => pool === undefined || entry.pool === pool)
    .map((entry) => entry.sql)
    .join('\n');
}

function templateApplications(log: readonly RecordedQuery[]): string[] {
  return log.filter((entry) => entry.sql.includes('template-body-')).map((entry) => entry.sql);
}

// ---------------------------------------------------------------------------
// Env-file parsing
// ---------------------------------------------------------------------------

test('saas:deploy env-file parsing accepts comments, quotes, and inline equals', () => {
  const parsed = parseSaasDeployEnvFile(
    ['# comment', '', 'A=b', "QUOTED='v a l'", 'DQ="x=y"', 'EMPTY=', 'URL=https://h/p?a=b'].join('\n'),
    'fixture.env',
  );
  assert.deepEqual(parsed, { A: 'b', QUOTED: 'v a l', DQ: 'x=y', EMPTY: '', URL: 'https://h/p?a=b' });
});

test('saas:deploy env-file parsing rejects malformed lines without echoing values', () => {
  assert.throws(
    () => parseSaasDeployEnvFile('SECRET_VALUE=super-secret\nbroken', 'fixture.env'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture\.env line 2: expected KEY=VALUE/);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );
  assert.throws(() => parseSaasDeployEnvFile('export A=b', 'fixture.env'), /export.*not supported/);
});

test('saas:deploy worker expected-column manifest parses from its probe SQL', () => {
  const grants = parseWorkerExpectedColumnGrants();
  assert.ok(grants.length > 400, 'the worker manifest is substantial');
  assert.ok(
    grants.some(
      ([table, column, privilege]) =>
        table === 'saas_tenant_provider_credential_validation_jobs' && column === 'id' && privilege === 'SELECT',
    ),
  );
  for (const [table, column, privilege] of grants) {
    assert.match(table, /^[a-z0-9_]+$/);
    assert.match(column, /^[a-z0-9_]+$/);
    assert.match(privilege, /^(SELECT|INSERT|UPDATE|DELETE)$/);
  }
  // Tuple order is not a permission boundary: the Claude CASE reads may be
  // prepended. Pin the entire parsed permission set to the deployment SQL so
  // reordered, missing, or over-broad grants cannot hide behind a count check.
  const workerGrantSql = readFileSync(
    new URL('../../deploy/managed-saas-validation-worker-role-grants.sql', pathToFileURL(__filename)),
    'utf8',
  );
  const deploymentGrants: string[] = [];
  for (const match of workerGrantSql.matchAll(
    /GRANT\s+(SELECT|INSERT|UPDATE|DELETE|REFERENCES)\s*\(([^)]*)\)\s*ON TABLE model_router_saas\.(\w+)\s+TO model_router_saas_validation_worker;/gi,
  )) {
    const [, privilege, columns, table] = match;
    assert.ok(privilege && columns && table, 'column grant statement must identify its complete surface');
    for (const column of columns
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      deploymentGrants.push(`${table}\t${column}\t${privilege.toUpperCase()}`);
    }
  }
  assert.deepEqual(
    [...new Set(grants.map((grant) => grant.join('\t')))].sort(),
    [...new Set(deploymentGrants)].sort(),
    'the deploy diagnostic parser must preserve the exact worker probe/deployment column-permission set',
  );
  assert.doesNotMatch(
    workerGrantSql,
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES)\s+ON\s+(?:TABLE\s+)?model_router_saas\./i,
  );
});

// ---------------------------------------------------------------------------
// Full deployment sequence
// ---------------------------------------------------------------------------

test('saas:deploy bootstraps a fresh database end to end and all probes pass', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const result = await saasDeploy(FULL_OPTIONS, makeDependencies(freshState(), log, events));
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'deployed');
  assert.equal(result.failure, null);

  // Preflight saw a fresh deployment and the bootstrap ran before migration.
  assert.match(output(events), /schema model_router_saas absent \(fresh deployment\)/);
  assert.ok(events.indexOf('template:managed-saas-postgres-roles.sql') < events.indexOf('migrate'));
  assert.ok(events.indexOf('migrate') < events.indexOf('template:managed-saas-validation-worker-role-grants.sql'));

  // The main template is applied twice (bootstrap + post-migration replay),
  // the worker template once; both templates reach the administrator pool.
  const applications = templateApplications(log);
  assert.equal(
    applications.filter((sql) => sql.includes('managed-saas-postgres-roles.sql')).length,
    2,
    'main template: bootstrap + post-migration replay',
  );
  assert.equal(applications.filter((sql) => sql.includes('validation-worker')).length, 1);
  for (const entry of log.filter((record) => record.sql.includes('template-body-'))) {
    assert.equal(entry.pool, 'deploy_admin');
  }

  // Fresh logins receive passwords from their deployment URLs (values never logged).
  // Each password is one format() build plus one executed statement; the executed
  // statement form is the redacted fixture text.
  const passwordStatements = queries(log).match(/ALTER ROLE \(redacted fixture\)/g) ?? [];
  assert.equal(passwordStatements.length, 4, 'migrator+cp+gateway at bootstrap, worker at roles step');

  // Migrations run as the migrator login; the registry is verified; all three
  // probes run as the runtime logins.
  assert.ok(events.includes('migrate'));
  assert.ok(events.includes('verify-migrations'));
  assert.deepEqual(
    events.filter((event) => event.startsWith('probe:')),
    ['probe:control-plane', 'probe:gateway', 'probe:credential-validation-worker'],
  );
  assert.ok(events.includes('pool:model_router_saas_migrator'));
  assert.ok(events.includes('pool:model_router_saas_control_plane'));
  assert.ok(events.includes('pool:model_router_saas_gateway'));
  assert.ok(events.includes('pool:model_router_saas_validation_worker'));

  // Report includes every step with wall-clock timings; the report step's own
  // completion line follows the table (it cannot contain itself).
  const report = output(events);
  for (const step of ['preflight', 'bootstrap', 'migrate', 'roles', 'verify', 'readiness']) {
    assert.match(report, new RegExp(`\\s${step}\\s+(ok|skipped)\\s+\\d+ms`), `report line for ${step}`);
  }
  assert.match(report, /saas:deploy report ok in \d+ms — deployed/);
  assert.match(report, /probe green/);
});

test('saas:deploy is idempotent: rerun on a deployed database is a no-op bootstrap', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const result = await saasDeploy(FULL_OPTIONS, makeDependencies(deployedState(), log, events));
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'deployed');

  // Bootstrap skipped; no password is ever reset on an existing deployment.
  assert.match(output(events), /bootstrap skipped/);
  const allSql = queries(log);
  assert.doesNotMatch(allSql, /ALTER ROLE/);

  // Migration (no-op by runner semantics) and template replay still run.
  assert.ok(events.includes('migrate'));
  const applications = templateApplications(log);
  assert.equal(applications.filter((sql) => sql.includes('managed-saas-postgres-roles.sql')).length, 1);
  assert.equal(applications.filter((sql) => sql.includes('validation-worker')).length, 1);
  assert.deepEqual(
    events.filter((event) => event.startsWith('probe:')),
    ['probe:control-plane', 'probe:gateway', 'probe:credential-validation-worker'],
  );
});

test('saas:deploy bootstraps an absent schema but never resets an existing login password', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  // Roles already exist (e.g. the operator applied the template by hand) but
  // the schema is absent: the bootstrap still runs, yet no existing role's
  // externally managed password may be overwritten.
  const state = deployedState();
  state.schemaOwner = '';
  const result = await saasDeploy(FULL_OPTIONS, makeDependencies(state, log, events));
  assert.equal(result.exitCode, 0);
  assert.match(output(events), /bootstrap ok/);
  assert.doesNotMatch(queries(log), /ALTER ROLE/, 'existing roles keep their externally managed passwords');
  assert.ok(events.includes('migrate'), 'the deploy continues with the explicit migration');
});

test('saas:deploy dry-run performs zero database mutations', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const result = await saasDeploy({ ...FULL_OPTIONS, dryRun: true }, dependencies);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'dry-run');

  const allSql = queries(log);
  assert.doesNotMatch(allSql, /template-body-/, 'no template application');
  assert.doesNotMatch(allSql, /ALTER ROLE/, 'no password changes');
  assert.ok(!events.includes('migrate'), 'no migrations');
  assert.ok(!events.some((event) => event.startsWith('probe:')), 'no probes');
  assert.ok(!events.includes('verify-migrations'));

  // Only read-only catalog queries reached the database.
  for (const entry of log) {
    if (entry.sql.startsWith('<')) continue;
    assert.match(
      entry.sql,
      /server_version_num|pg_namespace|pg_roles|SELECT current_user/,
      `dry-run query is read-only: ${entry.sql.slice(0, 60)}`,
    );
  }

  const report = output(events);
  assert.match(report, /dry-run — no database mutations/);
  assert.match(report, /migrate: run the registered SaaS migrations/);
  assert.match(report, /roles: replay managed-saas-postgres-roles\.sql/);
  for (const step of ['bootstrap', 'migrate', 'roles', 'verify', 'readiness']) {
    assert.match(report, new RegExp(`\\s${step}\\s+skipped\\s+\\d+ms\\s+dry-run`), `dry-run skip for ${step}`);
  }
});

test('saas:deploy dry-run on a fresh database plans the bootstrap branch', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const result = await saasDeploy({ ...FULL_OPTIONS, dryRun: true }, makeDependencies(freshState(), log, events));
  assert.equal(result.exitCode, 0);
  assert.match(output(events), /bootstrap: apply managed-saas-postgres-roles\.sql/);
  assert.equal(templateApplications(log).length, 0, 'still zero mutations');
});

test('saas:deploy preflight rejects PostgreSQL below 15 and stops before any mutation', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const state = freshState();
  state.version = 140006;
  const result = await saasDeploy(FULL_OPTIONS, makeDependencies(state, log, events));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PREFLIGHT_FAILED');
  assert.match(output(events), /PostgreSQL 15 or later is required/);
  assert.equal(templateApplications(log).length, 0);
  assert.ok(!events.includes('migrate'));
});

test('saas:deploy preflight rejects a schema owned by another principal', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const state = deployedState();
  state.schemaOwner = 'someone_else';
  const result = await saasDeploy(FULL_OPTIONS, makeDependencies(state, log, events));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PREFLIGHT_FAILED');
  assert.match(output(events), /must be owned by model_router_saas_migrator/);
  assert.equal(templateApplications(log).length, 0);
});

test('saas:deploy preflight rejects missing roles when the administrator cannot create them', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const state = deployedState();
  state.roles.delete('model_router_saas_gateway');
  state.adminPrivileges = 'none';
  const result = await saasDeploy(FULL_OPTIONS, makeDependencies(state, log, events));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PREFLIGHT_FAILED');
  assert.match(
    output(events),
    /model_router_saas_gateway do not exist and the administrator login cannot create roles/,
  );
  assert.equal(templateApplications(log).length, 0);
});

test('saas:deploy preflight names missing readiness declarations', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const env = baseEnv();
  delete env.MODEL_ROUTER_SAAS_REDIS_PROVIDER;
  delete env.SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE;
  (dependencies.env as Record<string, string>) = env;
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'MISSING_DECLARATION');
  assert.match(
    output(events),
    /control-plane readiness declarations are incomplete; missing: MODEL_ROUTER_SAAS_REDIS_PROVIDER/,
  );
  assert.equal(templateApplications(log).length, 0);
});

test('saas:deploy requires the administrator URL and names every missing role URL', async () => {
  const events: string[] = [];
  const log: RecordedQuery[] = [];
  let dependencies = makeDependencies(deployedState(), log, events);
  let env = baseEnv();
  delete env.MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL;
  (dependencies.env as Record<string, string>) = env;
  let result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'MISSING_DECLARATION');
  assert.match(output(events), /MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL is required/);

  dependencies = makeDependencies(deployedState(), log, events);
  env = baseEnv();
  delete env.MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL;
  (dependencies.env as Record<string, string>) = env;
  result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'MISSING_DECLARATION');
  assert.match(output(events), /MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL is required/);
});

test('saas:deploy rejects a role URL that authenticates as the wrong login', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const env = baseEnv();
  env.MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL = pgUrl('model_router_saas_control_plane', SECRETS.gateway);
  (dependencies.env as Record<string, string>) = env;
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'INVALID_DATABASE_URL');
  assert.match(
    output(events),
    /MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL must authenticate as the model_router_saas_gateway/,
  );
});

test('saas:deploy stops at the migration step and never touches role templates', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const original = dependencies.runMigrations;
  (dependencies as { runMigrations?: (pool: SaasDatabasePool) => Promise<void> }).runMigrations = async () => {
    events.push('migrate');
    throw new Error('migration exploded with password=never-report');
  };
  void original;
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'MIGRATE_FAILED');
  assert.equal(templateApplications(log).length, 0, 'no template replay after a failed migration');
  assert.ok(!events.some((event) => event.startsWith('probe:')));
  assert.match(output(events), /migration transaction rolled back/);
  assert.doesNotMatch(output(events), /never-report/);
});

test('saas:deploy stops when the roles template replay fails', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const state = deployedState();
  state.schemaOwner = '';
  const dependencies = makeDependencies(state, log, events);
  // Existing roles + absent schema => fresh bootstrap path; make the worker
  // template application fail on the pool to simulate a template guard error.
  const handlerWrapper = dependencies.createPool;
  (dependencies as { createPool?: typeof handlerWrapper }).createPool = (connectionString, options) => {
    const pool = handlerWrapper(connectionString, options);
    if (new URL(connectionString).username === 'deploy_admin') {
      let applications = 0;
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          applications += sql.includes('template-body-') ? 1 : 0;
          return pool.query<Row>(sql, values);
        },
        async connect() {
          const client = await pool.connect();
          return {
            async query<Row>(sql: string, values?: readonly unknown[]) {
              if (sql.includes('template-body-')) {
                applications += 1;
                if (applications > 1) throw new Error('template guard refused (fixture)');
              }
              return client.query<Row>(sql, values);
            },
            release: (error?: Error | boolean) => client.release(error),
          };
        },
        async end() {
          return pool.end();
        },
      };
    }
    return pool;
  };
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'ROLES_FAILED');
  assert.ok(!events.some((event) => event.startsWith('probe:')));
});

// ---------------------------------------------------------------------------
// Verify step: precise missing-column interception
// ---------------------------------------------------------------------------

test('saas:deploy verify failure names the precise missing table/column/privilege', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const state = deployedState();
  state.missingGrants = [{ table_name: 'saas_tenants', column_name: 'id', privilege_type: 'SELECT' }];
  const dependencies = makeDependencies(state, log, events);
  (dependencies as { verifyRuntimeRole?: unknown }).verifyRuntimeRole = async (role: string) => {
    events.push(`probe:${role}`);
    if (role === 'gateway') throw new Error('probe failed (fixture)');
  };
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'VERIFY_FAILED');
  const report = output(events);
  assert.match(report, /model_router_saas_gateway runtime privilege probe failed/);
  assert.match(report, /Missing grants: saas_tenants\.id:SELECT/);
  // The failure stops the sequence before readiness.
  assert.doesNotMatch(report, /readiness ok/);
});

test('saas:deploy verify rejects a role connection that authenticated as another principal', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const handler: QueryHandler = (pool, sql) => {
    if (sql === 'SELECT current_user') return { rows: [{ current_user: 'someone_else' }], rowCount: 1 };
    throw new Error(`unexpected query on ${pool}`);
  };
  void handler;
  const base = dependencies.createPool;
  (dependencies as { createPool?: typeof base }).createPool = (connectionString, options) => {
    const user = new URL(connectionString).username;
    if (user === 'model_router_saas_gateway') return fakePool(user, handler, log);
    return base(connectionString, options);
  };
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'VERIFY_FAILED');
  assert.match(output(events), /authenticated as someone_else; expected model_router_saas_gateway/);
});

// ---------------------------------------------------------------------------
// Single-role mode
// ---------------------------------------------------------------------------

test('saas:deploy --role gateway verifies only that role without migrations or templates', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const result = await saasDeploy({ ...FULL_OPTIONS, role: 'gateway' }, makeDependencies(deployedState(), log, events));
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'verified');
  assert.deepEqual(
    events.filter((event) => event.startsWith('probe:')),
    ['probe:gateway'],
  );
  assert.ok(!events.includes('migrate'));
  assert.ok(!events.includes('verify-migrations'));
  assert.equal(templateApplications(log).length, 0);
  // No administrator pool is opened in single-role mode.
  assert.ok(!events.includes('pool:deploy_admin'));
  assert.ok(events.includes('pool:model_router_saas_gateway'));
});

test('saas:deploy --role rejects an unknown role and a missing schema', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  let result = await saasDeploy({ ...FULL_OPTIONS, role: 'combined' }, makeDependencies(deployedState(), log, events));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'INVALID_OPTIONS');
  assert.match(output(events), /--role must be exactly control-plane, gateway, or credential-validation-worker/);

  const state = deployedState();
  state.schemaOwner = '';
  result = await saasDeploy({ ...FULL_OPTIONS, role: 'control-plane' }, makeDependencies(state, log, events));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PREFLIGHT_FAILED');
  assert.match(output(events), /schema model_router_saas is absent; run the full saas:deploy/);
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test('saas:deploy readiness polls declared ports when some are reachable', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const env = baseEnv();
  env.MODEL_ROUTER_SAAS_CUSTOMER_PORT = '15100';
  env.MODEL_ROUTER_SAAS_PLATFORM_PORT = '15101';
  env.MODEL_ROUTER_SAAS_GATEWAY_PORT = '15102';
  (dependencies.env as Record<string, string>) = env;
  const ports = new Map<string, boolean>();
  (dependencies as { connectPort?: unknown }).connectPort = async (_host: string, port: number) => {
    events.push(`connect-port:${port}`);
    return ports.get(String(port)) ?? true;
  };
  // Gateway port never opens: first check for it returns false, later true.
  let gatewayChecks = 0;
  (dependencies as { connectPort?: unknown }).connectPort = async (_host: string, port: number) => {
    if (port === 15102) {
      gatewayChecks += 1;
      return gatewayChecks > 2;
    }
    return true;
  };
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 0);
  assert.match(output(events), /3\/3 declared listener ports reachable/);
});

test('saas:deploy readiness prints start commands when nothing is reachable', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const env = baseEnv();
  env.MODEL_ROUTER_SAAS_GATEWAY_PORT = '15102';
  (dependencies.env as Record<string, string>) = env;
  const result = await saasDeploy(FULL_OPTIONS, dependencies);
  assert.equal(result.exitCode, 0);
  const report = output(events);
  assert.match(report, /no declared listener ports are reachable yet/);
  assert.match(report, /docker compose up -d/);
});

// ---------------------------------------------------------------------------
// Env-file option and secret hygiene
// ---------------------------------------------------------------------------

test('saas:deploy --env-file overlays the process environment', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const dependencies = makeDependencies(deployedState(), log, events);
  const env = baseEnv();
  delete env.MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL;
  (dependencies.env as Record<string, string>) = env;
  const gatewayUrl = pgUrl('model_router_saas_gateway', 'env-file-secret-fixture');
  (dependencies as { readFile?: unknown }).readFile = async (path: string) => {
    events.push(`read:${path}`);
    if (path.endsWith('.env')) {
      return `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=${gatewayUrl}\n`;
    }
    return '-- template fixture\n';
  };
  const result = await saasDeploy({ ...FULL_OPTIONS, envFile: '/fixtures/deploy.env' }, dependencies);
  assert.equal(result.exitCode, 0);
  assert.ok(events.includes('read:/fixtures/deploy.env'));
  assert.ok(events.includes('pool:model_router_saas_gateway'));
});

test('saas:deploy never prints secret values in output or SQL', async () => {
  const log: RecordedQuery[] = [];
  const events: string[] = [];
  const state = deployedState();
  state.missingGrants = [{ table_name: 'saas_tenants', column_name: 'id', privilege_type: 'SELECT' }];
  const dependencies = makeDependencies(state, log, events);
  (dependencies as { verifyRuntimeRole?: unknown }).verifyRuntimeRole = async (role: string) => {
    events.push(`probe:${role}`);
    if (role === 'control-plane') throw new Error(`probe failed with ${SECRETS.controlPlane}`);
  };
  const result = await saasDeploy({ ...FULL_OPTIONS, verbose: true, envFile: '/fixtures/deploy.env' }, dependencies);
  assert.equal(result.exitCode, 1);
  const printed = output(events);
  for (const secret of [...ALL_SECRET_VALUES, 'env-file-secret-fixture']) {
    assert.ok(!printed.includes(secret), `output must not contain the secret value`);
  }
  // Verbose mode still prints the manual command per step.
  assert.match(
    printed,
    /manual equivalent: psql -X -v ON_ERROR_STOP=1 --file=deploy\/managed-saas-postgres-roles\.sql/,
  );
  assert.match(printed, /manual equivalent: node dist\/cli\/index\.js saas:migrate/);
});

test('saas:deploy is registered with its red-line documentation', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:deploy', '--help'], {
    cwd: process.cwd(),
  });
  assert.match(result.stdout, /--env-file/);
  assert.match(result.stdout, /--skip-migrate/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--role <role>/);
  assert.match(result.stdout, /--verbose/);
  assert.match(result.stdout, /MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL/);
  assert.match(result.stdout, /no credential value is ever printed/);
});
