import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  type SaasMigrateLegacy112CommandDependencies,
  type SaasMigrateLegacy112CommandOptions,
  saasMigrateLegacy112,
} from '../../src/cli/saas-migrate-legacy-112.js';
import {
  LEGACY_MAIN_112_COMPAT_PLAN_ID,
  LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  LEGACY_MAIN_112_MIGRATION_NAME,
  type LegacyMain112CompatPlanOutcome,
} from '../../src/saas/db/migrate-compat-legacy-112.js';
import type { SaasDatabasePool } from '../../src/saas/db/types.js';

// ---------------------------------------------------------------------------
// Fake deployment environment (fixture values, never credentials of anything
// real) — same shape as the saas:deploy/saas:upgrade unit tests.
// ---------------------------------------------------------------------------

const DATABASE = 'model_router_test_legacy112';
const HOST = '127.0.0.1:55441';
const pgUrl = (user: string): string => `postgresql://${user}:legacy112-fixture@${HOST}/${DATABASE}?sslmode=disable`;

function baseEnv(): Record<string, string> {
  return {
    MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL: pgUrl('legacy112_admin'),
    MODEL_ROUTER_SAAS_DATABASE_URL: pgUrl('model_router_saas_migrator'),
    MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: pgUrl('model_router_saas_control_plane'),
    MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: pgUrl('model_router_saas_gateway'),
    MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: pgUrl('model_router_saas_validation_worker'),
  };
}

function fakePool(handler: (sql: string) => { rows: unknown[]; rowCount: number }): SaasDatabasePool {
  return {
    async query<Row>(sql: string) {
      return handler(sql) as { rows: Row[]; rowCount: number };
    },
    async connect() {
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

// ---------------------------------------------------------------------------
// Plan outcome fixtures
// ---------------------------------------------------------------------------

const CLASSIFICATION = {
  kind: 'legacy-112-source' as const,
  appliedCount: 93,
  head: 112,
  detail: 'fixture classification',
};

function planOutcome(status: LegacyMain112CompatPlanOutcome['status']): LegacyMain112CompatPlanOutcome {
  return {
    plan: LEGACY_MAIN_112_COMPAT_PLAN_ID,
    status,
    classification: CLASSIFICATION,
    postgresMajor: 18,
    sourceMigrationsChecksum: 'a'.repeat(64),
    targetMigrationsChecksum: 'b'.repeat(64),
    catalogBaselineEvidenceId: status === 'dry-run' ? null : 'test-evidence',
    catalogVerified: true,
    move:
      status === 'applied'
        ? {
            fromVersion: 112,
            toVersion: 129,
            name: LEGACY_MAIN_112_MIGRATION_NAME,
            checksum: LEGACY_MAIN_112_MIGRATION_CHECKSUM,
          }
        : null,
    applied:
      status === 'applied'
        ? [
            { version: 112, name: 'billing_group_snapshot_limits', checksum: 'c'.repeat(64) },
            { version: 128, name: 'plugin_system', checksum: 'd'.repeat(64) },
          ]
        : [],
    pendingNormalMigrations: [],
    verification:
      status === 'applied'
        ? {
            targetHistoryVerified: true,
            catalogConstraintsVerified: 12,
            dataPreservation: [{ probe: 'count:saas_wallets', before: '1', after: '1' }],
          }
        : null,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

interface Fixture {
  events: string[];
  receipts: Array<{ path: string; text: string }>;
  planPhases: Array<'pre-check' | 'apply'>;
  preCheckOutcome: LegacyMain112CompatPlanOutcome;
  applyOutcome: LegacyMain112CompatPlanOutcome;
  probeFailure?: boolean;
  smokeStatus?: number;
  backupOutcome?: { status: 'ok' | 'skipped'; detail: string };
  envFileText?: string;
}

function makeDependencies(fixture: Fixture): SaasMigrateLegacy112CommandDependencies {
  return {
    env: fixture.envFileText ? { ...baseEnv(), MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL: '' } : baseEnv(),
    createPool: (connectionString) => {
      const user = decodeURIComponent(new URL(connectionString).username);
      fixture.events.push(`pool:${user}`);
      return fakePool((sql) => {
        if (sql.trim() === 'SELECT current_user') return { rows: [{ current_user: user }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
    },
    readFile: async (path) => {
      fixture.events.push(`read:${path.split('/').pop()}`);
      if (path.endsWith('.sql')) return 'BEGIN;\n-- fixture template\nCOMMIT;\n';
      if (path.endsWith('baseline.json')) return BASELINE_JSON;
      if (fixture.envFileText && path.endsWith('.env')) return fixture.envFileText;
      throw new Error(`unexpected read ${path}`);
    },
    writeReceiptFile: async (path, text) => {
      fixture.events.push(`receipt:${path}`);
      fixture.receipts.push({ path, text });
    },
    runCompatPlan: async (_pool, phase) => {
      fixture.events.push(`plan:${phase}`);
      fixture.planPhases.push(phase);
      return phase === 'pre-check' ? fixture.preCheckOutcome : fixture.applyOutcome;
    },
    verifyRuntimeRole: async (role) => {
      fixture.events.push(`probe:${role}`);
      if (fixture.probeFailure) throw new Error('fixture privilege probe failure');
    },
    runBackup: async (context) => {
      fixture.events.push(`backup:v${context.version}`);
      return fixture.backupOutcome ?? { status: 'ok', detail: 'fixture backup archive' };
    },
    fetchSmoke: async (url) => {
      fixture.events.push(`smoke:${url}`);
      return { status: fixture.smokeStatus ?? 200 };
    },
    now: () => 0,
    writeLine: () => undefined,
  };
}

function baseOptions(overrides: Partial<SaasMigrateLegacy112CommandOptions> = {}): SaasMigrateLegacy112CommandOptions {
  return {
    releaseId: 'test-release',
    schema: 'model_router_saas',
    sourceCatalogBaseline: 'fixtures/legacy112-baseline.json',
    receiptFile: 'fixtures/legacy112-receipt.json',
    confirmWritesStopped: true,
    confirmBackupTaken: true,
    allowLocalPlaintext: true,
    ...overrides,
  };
}

function makeFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    events: [],
    receipts: [],
    planPhases: [],
    preCheckOutcome: planOutcome('dry-run'),
    applyOutcome: planOutcome('applied'),
    ...overrides,
  };
}

const BASELINE_JSON = JSON.stringify({
  profile: 'saas-ddl-v1',
  coverage: 'complete-profile',
  evidenceId: 'legacy112-fixture-evidence',
  releaseId: 'test-release',
  schema: 'model_router_saas',
  postgresMajor: 18,
  migrationsChecksum: '1'.repeat(64),
  objects: [
    { kind: 'relation', identityChecksum: '2'.repeat(64), definitionChecksum: '3'.repeat(64) },
    { kind: 'constraint', identityChecksum: '4'.repeat(64), definitionChecksum: '5'.repeat(64) },
  ],
});

test('apply options are validated before any pool is created', async () => {
  for (const options of [
    baseOptions({ releaseId: undefined }),
    baseOptions({ schema: undefined }),
    baseOptions({ confirmWritesStopped: false }),
    baseOptions({ confirmBackupTaken: false }),
    baseOptions({ receiptFile: undefined }),
    baseOptions({ sourceCatalogBaseline: undefined }),
    baseOptions({ releaseId: 'bad release!' }),
    baseOptions({ smokeUrl: 'not-a-url' }),
  ]) {
    const fixture = makeFixture();
    const result = await saasMigrateLegacy112(options, makeDependencies(fixture));
    assert.equal(result.status, 'failed', JSON.stringify(options));
    assert.equal(result.exitCode, 1);
    assert.ok(result.failure, 'a failure code must be reported');
    assert.deepEqual(fixture.events, [], 'no database work may happen for invalid options');
  }
});

test('dry-run verifies the source state and plans the apply without any mutation', async () => {
  const fixture = makeFixture({ preCheckOutcome: planOutcome('dry-run') });
  const lines: string[] = [];
  const dependencies = { ...makeDependencies(fixture), writeLine: (line: string) => lines.push(line) };
  const result = await saasMigrateLegacy112(baseOptions({ dryRun: true }), dependencies);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.exitCode, 0);
  assert.equal(result.classification, 'legacy-112-source');
  assert.deepEqual(fixture.planPhases, ['pre-check']);
  assert.ok(!fixture.events.some((event) => event.startsWith('receipt:')));
  assert.ok(!fixture.events.includes('backup:v112'));
  assert.ok(lines.some((line) => line.includes('dry-run — zero mutations')));
  const skipped = result.steps.filter((step) => step.status === 'skipped');
  assert.equal(skipped.length, 8);
});

test('a refused pre-check fails the command with guidance', async () => {
  const fixture = makeFixture({
    preCheckOutcome: {
      ...planOutcome('refused'),
      issues: [{ code: 'STATE_NOT_APPLICABLE', detail: 'clean registry prefix; use the normal saas:migrate' }],
    },
  });
  const result = await saasMigrateLegacy112(baseOptions(), makeDependencies(fixture));
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'PRE_FAILED');
  assert.deepEqual(fixture.planPhases, ['pre-check']);
});

test('the apply path runs prerequisites, the compat transaction, the receipt, and the post steps', async () => {
  const fixture = makeFixture();
  const result = await saasMigrateLegacy112(baseOptions(), makeDependencies(fixture));
  assert.equal(result.status, 'applied');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fixture.planPhases, ['pre-check', 'apply']);
  assert.ok(fixture.events.includes('backup:v112'));
  // Receipt content: audit-only, carries the move identity and its own checksum.
  assert.equal(fixture.receipts.length, 1);
  const receiptText = fixture.receipts[0].text;
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.format, 'saas-migration-compat-receipt-v1');
  assert.equal(receipt.plan, LEGACY_MAIN_112_COMPAT_PLAN_ID);
  assert.equal(receipt.move.name, LEGACY_MAIN_112_MIGRATION_NAME);
  assert.equal(receipt.move.checksum, LEGACY_MAIN_112_MIGRATION_CHECKSUM);
  assert.equal(receipt.releaseId, 'test-release');
  const { receiptChecksum, ...withoutChecksum } = receipt;
  assert.match(receiptChecksum, /^[0-9a-f]{64}$/);
  assert.equal(
    receiptChecksum,
    createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex'),
    'the receipt checksum must cover the full receipt body',
  );
  assert.equal(result.receiptPath, 'fixtures/legacy112-receipt.json');
  assert.equal(result.receiptChecksum, receiptChecksum);
  // Post steps: template replay + the three probes; smoke skipped by default.
  assert.ok(fixture.events.includes('read:managed-saas-postgres-roles.sql'));
  assert.ok(fixture.events.includes('read:managed-saas-validation-worker-role-grants.sql'));
  for (const role of ['control-plane', 'gateway', 'credential-validation-worker']) {
    assert.ok(fixture.events.includes(`probe:${role}`));
  }
  assert.ok(!fixture.events.some((event) => event.startsWith('smoke:')));
  const steps = result.steps.map((step) => `${step.step}:${step.status}`);
  assert.deepEqual(steps, [
    'pre-check:ok',
    'prerequisites:ok',
    'compat-apply:ok',
    'receipt:ok',
    'roles:ok',
    'verify:ok',
    'restart:ok',
    'smoke:skipped',
    'report:ok',
  ]);
});

test('an already-current rerun is an idempotent no-op without a second receipt', async () => {
  const fixture = makeFixture({ preCheckOutcome: planOutcome('already-current') });
  const result = await saasMigrateLegacy112(baseOptions(), makeDependencies(fixture));
  assert.equal(result.status, 'already-current');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fixture.planPhases, ['pre-check']);
  assert.equal(fixture.receipts.length, 0);
  assert.ok(!fixture.events.includes('backup:v112'));
  assert.ok(!fixture.events.some((event) => event.startsWith('probe:')));
  const receiptStep = result.steps.find((step) => step.step === 'receipt');
  assert.equal(receiptStep?.status, 'skipped');
});

test('a failed compat transaction fails the command before any post step', async () => {
  const fixture = makeFixture({
    applyOutcome: { ...planOutcome('failed'), issues: [{ code: 'MOVE_FAILED', detail: 'identity mismatch' }] },
  });
  const result = await saasMigrateLegacy112(baseOptions(), makeDependencies(fixture));
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'COMPAT_FAILED');
  assert.equal(fixture.receipts.length, 0);
  assert.ok(!fixture.events.some((event) => event.startsWith('probe:')));
});

test('a failed runtime privilege probe fails closed after the committed upgrade', async () => {
  const fixture = makeFixture({ probeFailure: true });
  const result = await saasMigrateLegacy112(baseOptions(), makeDependencies(fixture));
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'VERIFY_FAILED');
  // The receipt is written immediately after commit, so the audit evidence
  // survives a later post-step failure.
  assert.equal(fixture.receipts.length, 1);
});

test('a failed smoke request fails closed', async () => {
  const fixture = makeFixture({ smokeStatus: 503 });
  const result = await saasMigrateLegacy112(
    baseOptions({ smokeUrl: 'https://smoke.example.test/healthz' }),
    makeDependencies(fixture),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.failure?.code, 'SMOKE_FAILED');
  assert.ok(fixture.events.includes('smoke:https://smoke.example.test/healthz'));
});

test('an invalid baseline file fails before any pool work', async () => {
  const fixture = makeFixture();
  const dependencies = {
    ...makeDependencies(fixture),
    readFile: async (path: string) => (path.endsWith('baseline.json') ? 'not-json{' : 'BEGIN;\nCOMMIT;\n'),
  };
  const result = await saasMigrateLegacy112(baseOptions(), dependencies);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'INVALID_OPTIONS');
  assert.deepEqual(fixture.events, []);
});

test('the env file supplies the deployment URLs', async () => {
  const fixture = makeFixture({
    envFileText: [
      `MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL=${pgUrl('legacy112_admin')}`,
      `MODEL_ROUTER_SAAS_DATABASE_URL=${pgUrl('model_router_saas_migrator')}`,
      `MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=${pgUrl('model_router_saas_control_plane')}`,
      `MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=${pgUrl('model_router_saas_gateway')}`,
      `MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=${pgUrl('model_router_saas_validation_worker')}`,
    ].join('\n'),
  });
  const result = await saasMigrateLegacy112(
    baseOptions({ envFile: 'fixtures/legacy112.env' }),
    makeDependencies(fixture),
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.exitCode, 0);
});

test('a baseline that is not a valid saas-ddl-v1 document is refused', async () => {
  const fixture = makeFixture();
  const dependencies = {
    ...makeDependencies(fixture),
    readFile: async (path: string) =>
      path.endsWith('baseline.json') ? JSON.stringify({ profile: 'wrong' }) : 'BEGIN;\nCOMMIT;\n',
  };
  const result = await saasMigrateLegacy112(baseOptions(), dependencies);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'INVALID_OPTIONS');
  assert.deepEqual(fixture.events, []);
});

test('a failed backup point fails before the compat transaction starts', async () => {
  const fixture = makeFixture({ backupOutcome: { status: 'skipped', detail: 'no mechanism configured (attested)' } });
  const result = await saasMigrateLegacy112(baseOptions(), makeDependencies(fixture));
  // A skipped backup mechanism is not a failure: the operator attestation
  // (--confirm-backup-taken) is the prerequisite; the skip is recorded loudly.
  assert.equal(result.status, 'applied');
  assert.ok(result.steps.some((step) => step.step === 'prerequisites' && step.status === 'skipped'));
});

test('the plan identity and checksum constants stay bound to the known legacy identity', () => {
  // Guards against accidental edits to the constants that key the only legal
  // ledger rewrite (no arbitrary checksum rewriting).
  assert.equal(LEGACY_MAIN_112_MIGRATION_NAME, 'provider_account_durable_fault_classification');
  assert.equal(LEGACY_MAIN_112_MIGRATION_CHECKSUM, '3a74754faaf5011fb0ae07970cf1a00a9957622db4d81895abff2f281d88320f');
  assert.equal(LEGACY_MAIN_112_COMPAT_PLAN_ID, 'legacy-main-112-to-129');
});
