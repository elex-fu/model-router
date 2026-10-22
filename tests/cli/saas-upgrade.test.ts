import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { SaasDoctorCheckLevel, SaasDoctorResult } from '../../src/cli/saas-doctor.js';
import {
  type SaasUpgradeCommandDependencies,
  type SaasUpgradeCommandOptions,
  saasUpgrade,
} from '../../src/cli/saas-upgrade.js';
import { SAAS_MIGRATIONS } from '../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool } from '../../src/saas/db/types.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Fake deployment environment (same fixture shape as the saas:deploy unit
// tests; the values below are fixtures, not credentials of anything real).
// ---------------------------------------------------------------------------

const DATABASE = 'model_router_test_upgrade';
const HOST = '127.0.0.1:55440';
const pgUrl = (user: string, password: string): string =>
  `postgresql://${user}:${password}@${HOST}/${DATABASE}?sslmode=disable`;

const SECRETS = {
  admin: 'upgrade-admin-secret-fixture',
  migrator: 'upgrade-migrator-secret-fixture',
  controlPlane: 'upgrade-cp-secret-fixture',
  gateway: 'upgrade-gateway-secret-fixture',
  worker: 'upgrade-worker-secret-fixture',
} as const;
const ALL_SECRET_VALUES = Object.values(SECRETS);

const REGISTRY_LENGTH = SAAS_MIGRATIONS.length;
// Registry versions carry gaps (115/116 belong to the parallel capability-parity
// workstream), so the head version of the N-1 ledger differs from N-1 itself.
const PREV_VERSION = SAAS_MIGRATIONS[REGISTRY_LENGTH - 2].version;
const RELEASE_VERSION = SAAS_MIGRATIONS[REGISTRY_LENGTH - 1].version;

function baseEnv(): Record<string, string> {
  return {
    MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL: pgUrl('upgrade_admin', SECRETS.admin),
    MODEL_ROUTER_SAAS_DATABASE_URL: pgUrl('model_router_saas_migrator', SECRETS.migrator),
    MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: pgUrl('model_router_saas_control_plane', SECRETS.controlPlane),
    MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: pgUrl('model_router_saas_gateway', SECRETS.gateway),
    MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: pgUrl('model_router_saas_validation_worker', SECRETS.worker),
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ClusterState {
  /** Applied migration count in the ledger (a clean prefix of the registry). */
  applied: number;
  /** Missing-grant rows returned to has_column_privilege diagnostics. */
  missingGrants: Array<{ table_name: string; column_name: string; privilege_type: string }>;
  /** When true, runMigrations advances the ledger to the full release registry. */
  migrateAdvances: boolean;
  /** Tamper the last applied ledger row to simulate drift. */
  ledgerDrift: boolean;
  /** Advanced by the fake sleep to fast-forward health-poll deadlines. */
  healthClock?: number;
}

function fakePool(handler: (sql: string) => { rows: unknown[]; rowCount: number }): SaasDatabasePool {
  return {
    async query<Row>(sql: string) {
      return handler(sql) as { rows: Row[]; rowCount: number };
    },
    async connect(): Promise<SaasDatabaseClient> {
      return {
        async query<Row>(sql: string) {
          return handler(sql) as { rows: Row[]; rowCount: number };
        },
        release: () => undefined,
      };
    },
    async end() {},
  };
}

type DoctorRole = 'control-plane' | 'gateway' | 'credential-validation-worker';
type DoctorCheck = 'pg-migrations' | 'role-privileges';
/** Checks the fake doctor reports as failing, as `${role}:${check}` pairs. */
type DoctorFails = Set<string>;

/** Mirrors the checksum in src/saas/db/migrate.ts for ledger fixtures. */
function migrationChecksum(migration: { name: string; sql: string }): string {
  return createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
}

function doctorResult(role: DoctorRole, fails: DoctorFails, atReleaseHead: boolean): SaasDoctorResult {
  const checks: DoctorCheck[] =
    role === 'credential-validation-worker' ? ['role-privileges'] : ['pg-migrations', 'role-privileges'];
  const results = checks.map((check) => ({
    check,
    level: (fails.has(`${role}:${check}`) || (check === 'pg-migrations' && !atReleaseHead)
      ? 'fail'
      : 'pass') as SaasDoctorCheckLevel,
  }));
  const failCount = results.filter((entry) => entry.level === 'fail').length;
  return {
    format: 'saas-doctor-command-v1',
    role,
    summary: { pass: results.length - failCount, warn: 0, fail: failCount },
    checks: results.map((entry) => ({
      check: entry.check,
      level: entry.level,
      detail: `${entry.check} fixture detail (${role})`,
      hint: 'fixture hint',
    })),
    exitCode: failCount > 0 ? 1 : 0,
  };
}

interface Fixture {
  readonly events: string[];
  readonly state: ClusterState;
  /** Checks the fake doctor fails; tests mutate this to simulate healing. */
  readonly doctorFails: DoctorFails;
  execResults?: (command: readonly string[]) => { status: number; stdout: string; stderr: string } | undefined;
  backupOutcome?: { status: 'ok' | 'skipped'; detail: string };
  smokeStatus?: number;
  envFileText?: string;
  templateFailure?: boolean;
}

function makeDependencies(fixture: Fixture): SaasUpgradeCommandDependencies {
  const ledgerRows = (): unknown[] => {
    const applied = SAAS_MIGRATIONS.slice(0, fixture.state.applied).map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    }));
    if (fixture.state.ledgerDrift && applied.length > 0) {
      applied[applied.length - 1] = { ...applied[applied.length - 1], checksum: 'drift'.padEnd(64, '0') };
    }
    return applied;
  };
  const headVersion = (): number => {
    const rows = SAAS_MIGRATIONS.slice(0, fixture.state.applied);
    return rows.length === 0 ? 0 : rows[rows.length - 1].version;
  };
  const handler = (sql: string): { rows: unknown[]; rowCount: number } => {
    if (sql.includes('FROM saas_schema_migrations ORDER BY version ASC')) {
      const rows = ledgerRows();
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('coalesce(max(version)')) {
      return { rows: [{ head: String(headVersion()), applied: String(fixture.state.applied) }], rowCount: 1 };
    }
    if (sql.includes('has_column_privilege') || sql.includes('has_table_privilege')) {
      return { rows: fixture.state.missingGrants, rowCount: fixture.state.missingGrants.length };
    }
    if (sql.trim() === 'SELECT current_user') {
      return { rows: [{ current_user: 'fixture-role' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    env: baseEnv(),
    createPool: (connectionString) => {
      const user = decodeURIComponent(new URL(connectionString).username);
      fixture.events.push(`pool:${user}`);
      // The registry-state query runs on the migrator pool; current_user on the
      // role pools must reflect each plan's login for the identity gate.
      const roleHandler = (sql: string) => {
        if (sql.trim() === 'SELECT current_user') {
          return { rows: [{ current_user: user }], rowCount: 1 };
        }
        return handler(sql);
      };
      return fakePool(roleHandler);
    },
    runMigrations: async () => {
      fixture.events.push('migrate');
      if (fixture.state.migrateAdvances) {
        fixture.state.applied = REGISTRY_LENGTH;
      }
    },
    verifyMigrations: async () => {
      fixture.events.push('verify-migrations');
    },
    verifyRuntimeRole: async (role) => {
      fixture.events.push(`probe:${role}`);
      if (fixture.state.missingGrants.length > 0 && role === 'control-plane') {
        throw new Error('fixture privilege probe failure');
      }
    },
    doctor: async (role) => {
      fixture.events.push(`doctor:${role}`);
      return doctorResult(role, fixture.doctorFails, fixture.state.applied === REGISTRY_LENGTH);
    },
    runBackup: async (context) => {
      fixture.events.push(`backup:v${context.version}`);
      return fixture.backupOutcome ?? { status: 'ok', detail: 'fixture backup archive' };
    },
    execCommand: async (command) => {
      fixture.events.push(`exec:${command.join(' ')}`);
      const result = fixture.execResults?.(command);
      if (result) return result;
      return { status: 0, stdout: '', stderr: '' };
    },
    fetchSmoke: async (url) => {
      fixture.events.push(`smoke:${url}`);
      return { status: fixture.smokeStatus ?? 200 };
    },
    readFile: async (path) => {
      if (path.endsWith('.sql')) {
        fixture.events.push(`template:${path.split('/').pop()}`);
        if (fixture.templateFailure) throw new Error('fixture template read failure');
        return `-- template fixture\nBEGIN;\nSELECT 'template-body-${path.split('/').pop()}';\nCOMMIT;\n`;
      }
      fixture.events.push(`env-file:${path}`);
      return fixture.envFileText ?? '';
    },
    now: () => 1_000_000 + (fixture.state.healthClock ?? 0),
    sleep: async () => {
      fixture.events.push('health-poll-sleep');
      fixture.state.healthClock = (fixture.state.healthClock ?? 0) + RESTART_HEALTH_TIMEOUT_MS;
    },
    writeLine: (line) => {
      fixture.events.push(`out:${line}`);
    },
  };
}

const RESTART_HEALTH_TIMEOUT_MS = 180_000;

function freshFixture(applied = REGISTRY_LENGTH - 1): Fixture {
  const state: ClusterState = {
    applied,
    missingGrants: [],
    migrateAdvances: true,
    ledgerDrift: false,
  };
  return { events: [], state, doctorFails: new Set() };
}

const FULL_OPTIONS: SaasUpgradeCommandOptions = { allowLocalPlaintext: true };

function output(events: readonly string[]): string {
  return events.filter((event) => event.startsWith('out:')).join('\n');
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('saas:upgrade runs the full sequence and reports versions, anchor, and downtime window', async () => {
  const fixture = freshFixture();
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 0, output(fixture.events));
  assert.equal(result.status, 'upgraded');
  assert.equal(result.failure, null);
  assert.equal(result.registryVersions.before, PREV_VERSION);
  assert.equal(result.registryVersions.after, RELEASE_VERSION);
  assert.ok(result.downtimeWindowMs !== null && result.downtimeWindowMs >= 0);

  // Step order: pre (audit + doctor subset), backup, migrate, roles, verify,
  // restart (manual default), post-check, report.
  const order = fixture.events.filter((event) => event.startsWith('doctor:') || event === 'migrate');
  assert.deepEqual(order, [
    'doctor:control-plane',
    'doctor:gateway',
    'doctor:credential-validation-worker',
    'migrate',
    'doctor:control-plane',
    'doctor:gateway',
    'doctor:credential-validation-worker',
  ]);
  assert.match(output(fixture.events), /saas:upgrade pre ok in \d+ms — no migration drift/);
  assert.match(output(fixture.events), /saas:upgrade backup-point ok .*anchor registry head/);
  assert.match(output(fixture.events), new RegExp(`registry head ${PREV_VERSION} → ${RELEASE_VERSION}`));
  assert.match(
    output(fixture.events),
    /managed-saas-postgres-roles\.sql and managed-saas-validation-worker-role-grants\.sql replayed/,
  );
  assert.match(output(fixture.events), /model_router_saas_gateway: runtime privilege probe green/);
  assert.match(output(fixture.events), /restart mechanism: manual/);
  assert.match(output(fixture.events), /smoke skipped \(--smoke-url not provided\)/);
  assert.match(
    output(fixture.events),
    new RegExp(`registry versions: before ${PREV_VERSION} → after ${RELEASE_VERSION}`),
  );
  assert.match(output(fixture.events), /downtime window: \d+ms/);
  assert.match(output(fixture.events), new RegExp(`rollback anchor: registry head ${PREV_VERSION}`));
  // Template replay happened on the administrator pool.
  assert.ok(fixture.events.includes('template:managed-saas-postgres-roles.sql'));
  assert.ok(fixture.events.includes('template:managed-saas-validation-worker-role-grants.sql'));
  // Secret hygiene.
  for (const secret of ALL_SECRET_VALUES) {
    assert.ok(!output(fixture.events).includes(secret), 'no secret value may appear in the output');
  }
});

test('saas:upgrade smoke request succeeds on 200 and the post-check stays green', async () => {
  const fixture = freshFixture();
  const result = await saasUpgrade(
    { ...FULL_OPTIONS, smokeUrl: 'https://smoke.example.test/healthz' },
    makeDependencies(fixture),
  );
  assert.equal(result.exitCode, 0, output(fixture.events));
  assert.ok(fixture.events.includes('smoke:https://smoke.example.test/healthz'));
  assert.match(output(fixture.events), /smoke request https:\/\/smoke\.example\.test\/healthz returned 200/);
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

test('saas:upgrade --dry-run runs pre-checks only and prints the plan with zero mutations', async () => {
  const fixture = freshFixture();
  const result = await saasUpgrade({ ...FULL_OPTIONS, dryRun: true }, makeDependencies(fixture));
  assert.equal(result.exitCode, 0, output(fixture.events));
  assert.equal(result.status, 'dry-run');
  assert.equal(result.registryVersions.before, PREV_VERSION);
  assert.equal(result.registryVersions.after, PREV_VERSION);
  // Doctor subset ran (pre-checks are read-only); nothing else did.
  assert.ok(fixture.events.includes('doctor:control-plane'));
  assert.ok(!fixture.events.includes('migrate'));
  assert.ok(!fixture.events.some((event) => event.startsWith('template:')));
  assert.ok(!fixture.events.some((event) => event.startsWith('backup:')));
  assert.ok(fixture.events.some((event) => event.startsWith('out:') && event.includes('dry-run — zero mutations')));
  assert.match(output(fixture.events), /- migrate: runSaasMigrations as model_router_saas_migrator/);
  assert.match(output(fixture.events), /- restart \(manual\):/);
});

// ---------------------------------------------------------------------------
// Fail-closed matrix
// ---------------------------------------------------------------------------

test('saas:upgrade stops at pre when the applied ledger has drifted from the registry', async () => {
  const fixture = freshFixture();
  fixture.state.ledgerDrift = true;
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PRE_FAILED');
  assert.match(output(fixture.events), /migration drift: applied ledger row \d+ does not match this release registry/);
  assert.ok(!fixture.events.includes('migrate'));
  assert.ok(!fixture.events.some((event) => event.startsWith('backup:')));
});

test('saas:upgrade stops at pre when a doctor role-privileges probe fails', async () => {
  const fixture = freshFixture();
  fixture.doctorFails.add('gateway:role-privileges');
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PRE_FAILED');
  assert.match(output(fixture.events), /doctor gateway:/);
  assert.match(output(fixture.events), /role-privileges: fail — role-privileges fixture detail/);
  assert.ok(!fixture.events.includes('migrate'));
});

test('saas:upgrade stops at backup-point when the configured backup fails, before any mutation', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const failing: SaasUpgradeCommandDependencies = {
    ...dependencies,
    runBackup: async () => {
      throw new Error('fixture backup failure');
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, failing);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'BACKUP_FAILED');
  assert.ok(!fixture.events.includes('migrate'));
  assert.ok(!fixture.events.some((event) => event.startsWith('template:')));
});

test('saas:upgrade stops at migrate on a migration failure (transaction rolled back upstream)', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const failing: SaasUpgradeCommandDependencies = {
    ...dependencies,
    runMigrations: async () => {
      fixture.events.push('migrate');
      throw new Error('fixture migration failure');
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, failing);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'MIGRATE_FAILED');
  assert.match(output(fixture.events), /migration transaction rolled back/);
  assert.ok(!fixture.events.some((event) => event.startsWith('template:')));
});

test('saas:upgrade stops at roles on a template replay failure and documents the safe rerun', async () => {
  const fixture = freshFixture();
  fixture.templateFailure = true;
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'ROLES_FAILED');
  assert.match(output(fixture.events), /the database stays migrated and the sequence is safe to re-run/);
  // The migration itself completed before the roles step failed.
  assert.ok(fixture.events.includes('migrate'));
  assert.ok(fixture.events.some((event) => event.startsWith('template:')));
  assert.ok(!fixture.events.some((event) => event.startsWith('probe:')));
});

test('saas:upgrade names the exact missing grants when a runtime probe fails at verify', async () => {
  const fixture = freshFixture();
  fixture.state.missingGrants = [{ table_name: 'saas_requests', column_name: 'tenant_id', privilege_type: 'SELECT' }];
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'VERIFY_FAILED');
  assert.match(output(fixture.events), /saas_requests\.tenant_id:SELECT/);
  // Verify runs after the roles replay.
  assert.ok(fixture.events.some((event) => event.startsWith('template:')));
});

test('saas:upgrade fails the smoke request on a non-200 response', async () => {
  const fixture = freshFixture();
  fixture.smokeStatus = 503;
  const result = await saasUpgrade(
    { ...FULL_OPTIONS, smokeUrl: 'https://smoke.example.test/healthz' },
    makeDependencies(fixture),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'SMOKE_FAILED');
  assert.match(output(fixture.events), /returned HTTP 503 \(expected 200\)/);
});

// ---------------------------------------------------------------------------
// Rerun-after-partial-upgrade healing
// ---------------------------------------------------------------------------

test('saas:upgrade rerun after a partial upgrade tolerates pre-heal probe failures but fails them at post-check', async () => {
  // A previous run migrated to the release head but the template replay
  // failed: the ledger is at head, the runtime grants are missing.
  const fixture = freshFixture(REGISTRY_LENGTH);
  fixture.state.migrateAdvances = false;
  fixture.state.missingGrants = [{ table_name: 'saas_requests', column_name: 'tenant_id', privilege_type: 'SELECT' }];
  fixture.doctorFails.add('control-plane:role-privileges');
  // Healing rerun: the pre-check tolerates the missing grants (the roles step
  // replays them) and the verify step is the fail-closed gate.
  const dependencies = makeDependencies(fixture);
  const healingVerify: SaasUpgradeCommandDependencies = {
    ...dependencies,
    verifyRuntimeRole: async (role) => {
      fixture.events.push(`probe:${role}`);
      // After the roles replay the grants are restored.
      fixture.state.missingGrants = [];
      fixture.doctorFails.delete('control-plane:role-privileges');
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, healingVerify);
  assert.equal(result.exitCode, 0, output(fixture.events));
  assert.match(output(fixture.events), /pre-heal tolerated — registry already at the release head/);
  assert.match(
    output(fixture.events),
    new RegExp(`registry already at head ${RELEASE_VERSION} \\(no pending migrations\\)`),
  );

  // The same starting state WITHOUT healing (grants still missing at verify)
  // must fail closed at the verify step.
  const fixture2 = freshFixture(REGISTRY_LENGTH);
  fixture2.state.migrateAdvances = false;
  fixture2.state.missingGrants = [{ table_name: 'saas_requests', column_name: 'tenant_id', privilege_type: 'SELECT' }];
  const result2 = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture2));
  assert.equal(result2.exitCode, 1);
  assert.equal(result2.failure?.code, 'VERIFY_FAILED');
});

test('saas:upgrade refuses the pre-check probe failure when migrations are still pending (no heal without the roles step)', async () => {
  const fixture = freshFixture(REGISTRY_LENGTH - 1);
  fixture.state.missingGrants = [{ table_name: 'saas_requests', column_name: 'tenant_id', privilege_type: 'SELECT' }];
  fixture.doctorFails.add('control-plane:role-privileges');
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PRE_FAILED');
  assert.ok(!fixture.events.includes('migrate'));
});

// ---------------------------------------------------------------------------
// Backup coverage honesty
// ---------------------------------------------------------------------------

test('saas:upgrade refuses migration when no verified PG backup policy is configured', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const withoutBackup: SaasUpgradeCommandDependencies = {
    ...dependencies,
    runBackup: async (context) => {
      // Exercise the real default decision logic through the exported helper.
      const { defaultRunBackup } = await import('../../src/cli/saas-upgrade.js');
      return defaultRunBackup(
        { version: context.version, admin: context.admin, env: {} },
        {
          execCommand: async () => ({ status: 0, stdout: '', stderr: '' }),
          fileSize: () => 1024,
        },
      );
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, withoutBackup);
  assert.equal(result.exitCode, 1, output(fixture.events));
  assert.equal(result.failure?.code, 'BACKUP_FAILED');
  assert.match(output(fixture.events), /BACKUP_POLICY_REQUIRED/);
  assert.ok(!fixture.events.includes('migrate'));
});

test('saas:upgrade refuses a backup executor that skips protection', async () => {
  const fixture = freshFixture();
  fixture.backupOutcome = { status: 'skipped', detail: 'operator registry anchor only' };
  const result = await saasUpgrade(FULL_OPTIONS, makeDependencies(fixture));
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'BACKUP_FAILED');
  assert.ok(!fixture.events.includes('migrate'));
});

// ---------------------------------------------------------------------------
// Restart mechanisms
// ---------------------------------------------------------------------------

test('saas:upgrade compose mechanism restarts each service with health gates between steps', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const compose: SaasUpgradeCommandDependencies = {
    ...dependencies,
    env: {
      ...baseEnv(),
      MODEL_ROUTER_SAAS_UPGRADE_RESTART_MECHANISM: 'compose',
      MODEL_ROUTER_SAAS_UPGRADE_COMPOSE_DIR: 'deploy/compose',
    },
    execCommand: async (command) => {
      fixture.events.push(`exec:${command.join(' ')}`);
      if (command[0] === 'docker' && command[1] === 'compose' && command[2] === 'ps') {
        return { status: 0, stdout: 'fixture-container-id\n', stderr: '' };
      }
      if (command[0] === 'docker' && command[1] === 'inspect') {
        return { status: 0, stdout: 'healthy\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, compose);
  assert.equal(result.exitCode, 0, output(fixture.events));
  const restarts = fixture.events.filter((event) => event.startsWith('exec:docker compose up -d --no-deps'));
  assert.deepEqual(restarts, [
    'exec:docker compose up -d --no-deps control-plane',
    'exec:docker compose up -d --no-deps gateway',
    'exec:docker compose up -d --no-deps credential-validation-worker',
  ]);
  // A health gate ran for every service before the next restart.
  const inspectCount = fixture.events.filter((event) => event.startsWith('exec:docker inspect')).length;
  assert.equal(inspectCount, 3);
  assert.match(output(fixture.events), /3 workload restart\(s\) completed with health gates/);
});

test('saas:upgrade systemd mechanism restarts each unit and gates on is-active', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const systemd: SaasUpgradeCommandDependencies = {
    ...dependencies,
    env: { ...baseEnv(), MODEL_ROUTER_SAAS_UPGRADE_RESTART_MECHANISM: 'systemd' },
    execCommand: async (command) => {
      fixture.events.push(`exec:${command.join(' ')}`);
      if (command[0] === 'systemctl' && command[1] === 'is-active') {
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, systemd);
  assert.equal(result.exitCode, 0, output(fixture.events));
  const restarts = fixture.events.filter((event) => event.startsWith('exec:systemctl restart'));
  assert.equal(restarts.length, 3);
  assert.ok(fixture.events.includes('exec:systemctl is-active model-router-saas-gateway.service'));
});

test('saas:upgrade fails the restart step when a workload never becomes healthy', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  let clock = 0;
  const unhealthy: SaasUpgradeCommandDependencies = {
    ...dependencies,
    env: { ...baseEnv(), MODEL_ROUTER_SAAS_UPGRADE_RESTART_MECHANISM: 'systemd' },
    now: () => clock,
    sleep: async () => {
      clock += 200_000;
    },
    execCommand: async (command) => {
      fixture.events.push(`exec:${command.join(' ')}`);
      if (command[0] === 'systemctl' && command[1] === 'is-active') {
        return { status: 3, stdout: 'activating\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const result = await saasUpgrade(FULL_OPTIONS, unhealthy);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'RESTART_FAILED');
  assert.match(output(fixture.events), /did not become healthy/);
});

test('saas:upgrade rejects an unknown restart mechanism', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const invalid: SaasUpgradeCommandDependencies = {
    ...dependencies,
    env: { ...baseEnv(), MODEL_ROUTER_SAAS_UPGRADE_RESTART_MECHANISM: 'kube' },
  };
  const result = await saasUpgrade(FULL_OPTIONS, invalid);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'INVALID_OPTIONS');
  assert.match(output(fixture.events), /must be one of manual, compose, systemd/);
});

// ---------------------------------------------------------------------------
// Rollback mode (never a down-migration)
// ---------------------------------------------------------------------------

test('saas:upgrade --rollback-to refuses the down-migration and prints the documented restore path', async () => {
  const fixture = freshFixture();
  const result = await saasUpgrade({ ...FULL_OPTIONS, rollbackTo: String(PREV_VERSION) }, makeDependencies(fixture));
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'rollback-plan');
  assert.match(output(fixture.events), /REFUSED: down-migration/);
  assert.match(output(fixture.events), /append-only/);
  assert.match(output(fixture.events), /backup-restore ONLY \(restore \+ old-image restart\)/);
  assert.match(output(fixture.events), /pg_restore --format=custom --exit-on-error/);
  assert.match(output(fixture.events), /do NOT restore the managed SaaS PostgreSQL database/);
  // The rollback mode never mutates anything.
  assert.ok(!fixture.events.includes('migrate'));
  assert.ok(!fixture.events.some((event) => event.startsWith('template:')));
  assert.ok(fixture.events.some((event) => event.startsWith('pool:model_router_saas_migrator')));
});

test('saas:upgrade --rollback-to refuses anything that looks like a down-migration request', async () => {
  for (const value of ['down', '112-111', 'revert 111', '-1']) {
    const fixture = freshFixture();
    const result = await saasUpgrade({ ...FULL_OPTIONS, rollbackTo: value }, makeDependencies(fixture));
    assert.equal(result.exitCode, 1, `--rollback-to ${value} must be refused`);
    assert.equal(result.failure?.code, 'INVALID_OPTIONS');
    assert.match(output(fixture.events), /REFUSED: --rollback-to must be a plain registry version integer/);
    assert.match(output(fixture.events), /Down-migrations do not exist/);
    assert.ok(!fixture.events.some((event) => event.startsWith('pool:')), 'no database contact for a refused request');
  }
});

test('saas:upgrade --rollback-to cannot be combined with --smoke-url', async () => {
  const fixture = freshFixture();
  const result = await saasUpgrade(
    { ...FULL_OPTIONS, rollbackTo: '111', smokeUrl: 'https://smoke.example.test/' },
    makeDependencies(fixture),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'INVALID_OPTIONS');
  assert.match(output(fixture.events), /standalone rollback-path mode/);
});

// ---------------------------------------------------------------------------
// Options and environment
// ---------------------------------------------------------------------------

test('saas:upgrade rejects an unreadable env file and a malformed smoke URL', async () => {
  const fixture = freshFixture();
  const dependencies = makeDependencies(fixture);
  const unreadable: SaasUpgradeCommandDependencies = {
    ...dependencies,
    readFile: async () => {
      throw new Error('fixture missing');
    },
  };
  const missing = await saasUpgrade({ ...FULL_OPTIONS, envFile: '/fixture/absent.env' }, unreadable);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.failure?.code, 'ENV_FILE_UNREADABLE');

  const fixture2 = freshFixture();
  const badSmoke = await saasUpgrade({ ...FULL_OPTIONS, smokeUrl: 'not a url' }, makeDependencies(fixture2));
  assert.equal(badSmoke.exitCode, 1);
  assert.equal(badSmoke.failure?.code, 'INVALID_OPTIONS');
});

test('saas:upgrade --env-file overlays the deployment environment', async () => {
  const fixture = freshFixture();
  fixture.envFileText = [
    '# fixture overlay',
    `MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL=${pgUrl('upgrade_admin', SECRETS.admin)}`,
    `MODEL_ROUTER_SAAS_DATABASE_URL=${pgUrl('model_router_saas_migrator', SECRETS.migrator)}`,
    `MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=${pgUrl('model_router_saas_control_plane', SECRETS.controlPlane)}`,
    `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=${pgUrl('model_router_saas_gateway', SECRETS.gateway)}`,
    `MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=${pgUrl('model_router_saas_validation_worker', SECRETS.worker)}`,
    '',
  ].join('\n');
  const dependencies = makeDependencies(fixture);
  const withFile: SaasUpgradeCommandDependencies = { ...dependencies, env: {} };
  const result = await saasUpgrade({ ...FULL_OPTIONS, envFile: '/fixture/deploy.env' }, withFile);
  assert.equal(result.exitCode, 0, output(fixture.events));
  assert.ok(fixture.events.includes('env-file:/fixture/deploy.env'));
});

test('saas:upgrade never prints secret values in output', async () => {
  const fixture = freshFixture();
  const failing = freshFixture();
  failing.templateFailure = true;
  for (const candidate of [fixture, failing]) {
    await saasUpgrade(FULL_OPTIONS, makeDependencies(candidate));
    const text = output(candidate.events);
    for (const secret of ALL_SECRET_VALUES) {
      assert.ok(!text.includes(secret), 'no secret value may appear in the output');
    }
  }
});

test('saas:upgrade is registered with its red-line documentation', async () => {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:upgrade', '--help'], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(stdout, /--env-file <path>/);
  assert.match(stdout, /--smoke-url <url>/);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /--rollback-to <version>/);
  assert.match(stdout, /down-migrations do not exist\s+and are refused/);
  assert.match(stdout, /does NOT back up PostgreSQL/);
});
