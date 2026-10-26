import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Read repository source only. No child processes, PG connection, YAML package,
// migration execution or fixture mutation belongs in this offline regression.
// Both the workflow and scripts/run-tests.mjs invoke tests from the repo root.
const repository = resolve(process.cwd());
const read = (path: string): string => readFileSync(resolve(repository, path), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const provisioning = read('tests/saas/db/managed-postgres-runtime-privileges.integration.sh');
const CLI = 'tests/cli/managed-saas-validation-worker-postgres.integration.test.ts';
const WORKER = 'tests/saas/supply/managed-postgres-credential-validation.integration.test.ts';
const MIGRATION_058 =
  'tests/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.postgres.integration.test.ts';
const HTTP = 'tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts';
const CANDIDATE_READS = 'tests/saas/gateway/candidate-live-reads.postgres.integration.test.ts';
const RESERVATION_PLANNING = 'tests/saas/gateway/reservation-planning.postgres.integration.test.ts';
const HOTPATH_FIXTURES = [
  'tests/saas/gateway/admission-bench-fixture.ts',
  'tests/saas/gateway/runtime-health-clock-postgres-fixture.ts',
  'tests/saas/gateway/prepared-evidence-authority-postgres-fixture.ts',
] as const;
const PROVISION = 'bash tests/saas/db/managed-postgres-runtime-privileges.integration.sh';
const GATE_TEST = 'tests/ci/managed-saas-required-gates.test.ts';
const ISOLATED_JOB = 'managed-saas-isolated-required-gates';
const ISOLATED_RUNNER = 'tests/ci/managed-saas-isolated-required-gates.ts';
const isolatedRunner = read(ISOLATED_RUNNER);
const isolatedGates = [
  [
    'cancellation-059',
    'tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts',
    true,
  ],
  ['pre-dispatch-compensation', 'tests/saas/gateway/pre-dispatch-compensation-postgres.integration.test.ts', true],
  ['concurrent-claim', 'tests/saas/gateway/prepared-evidence-concurrent-claim.postgres.integration.test.ts', true],
  [
    'normal-success-terminal-replay',
    'tests/saas/metering/normal-success-terminal-replay.postgres.integration.test.ts',
    false,
  ],
  ['usage-correction-063', 'tests/saas/metering/usage-correction.postgres.integration.test.ts', false],
  ['key-ip-policy-080', 'tests/saas/keys/ip-policy.postgres.integration.test.ts', false],
  ['key-budget-policy-081', 'tests/saas/keys/budget-policy.postgres.integration.test.ts', false],
  ['settlement-sigkill-crash', 'tests/drills/settlement-sigkill-crash.postgres.integration.test.ts', false],
  ['member-directory', 'tests/saas/identity/tenant-member-directory.postgres.integration.test.ts', false],
  ['member-directory-http', 'tests/saas/identity/tenant-member-directory-http.postgres.integration.test.ts', false],
  ['dual-instance-failover', 'tests/drills/dual-instance-failover.postgres.integration.test.ts', false],
  ['marketing-redeem-codes-089', 'tests/saas/marketing/redeem-codes.postgres.integration.test.ts', false],
  ['marketing-promo-codes-090', 'tests/saas/marketing/promo-codes.postgres.integration.test.ts', false],
  ['marketing-affiliate-091', 'tests/saas/marketing/affiliate.postgres.integration.test.ts', false],
  ['marketing-announcements-092', 'tests/saas/marketing/announcements.postgres.integration.test.ts', false],
  ['quota-sync-093', 'tests/saas/supply/quota-sync-worker.postgres.integration.test.ts', false],
  ['oauth-token-refresh-094', 'tests/saas/supply/oauth-token-refresh.postgres.integration.test.ts', false],
  ['announcement-fanout-095', 'tests/saas/webhooks/announcement-fanout.postgres.integration.test.ts', false],
  ['account-quarantine-097', 'tests/saas/supply/account-quarantine.postgres.integration.test.ts', false],
  ['rate-limit-scheduling-098', 'tests/saas/gateway/rate-limit-scheduling.postgres.integration.test.ts', false],
  ['health-score-098', 'tests/saas/gateway/health-score.postgres.integration.test.ts', false],
  ['oauth-refresh-onboarding', 'tests/saas/supply/oauth-refresh-onboarding.postgres.integration.test.ts', false],
  ['kimi-commercial-preparation-diagnostic', 'tests/integration/kimi-commercial-preparation-diagnostic.test.ts', false],
  ['scheduler-native-protocol', 'tests/saas/gateway/scheduler-native-protocol.postgres.integration.test.ts', false],
  ['prepared-statements', 'tests/saas/gateway/prepared-statements.postgres.integration.test.ts', false],
  ['runtime-health-clock', 'tests/saas/gateway/runtime-health-clock.postgres.integration.test.ts', false],
  ['dispatch-capacity', 'tests/saas/gateway/dispatch-capacity.postgres.integration.test.ts', true],
  ['affinity-bind-race', 'tests/saas/gateway/affinity-bind-race.postgres.integration.test.ts', false],
  ['dispatch-proof-fence-batch', 'tests/saas/supply/dispatch-proof-fence-batch.postgres.integration.test.ts', false],
  ['payment-merchant-binding', 'tests/saas/payments/payment-merchant-binding.postgres.integration.test.ts', false],
  ['payment-worker-sigkill', 'tests/drills/payment-worker-sigkill.postgres.integration.test.ts', false],
  ['managed-saas-sigterm', 'tests/saas/gateway/managed-saas-sigterm.postgres.integration.test.ts', false],
] as const;
const cancellationFixture = 'tests/saas/gateway/pre-dispatch-postgres-fixture.ts';
const terminalReplayFixture = 'tests/saas/metering/normal-success-postgres-fixture.ts';
const kimiCommercialFixture = 'scripts/ops/verify-commercial-kimi.ts';
const runtimeHealthClockFixture = 'tests/saas/gateway/runtime-health-clock-postgres-fixture.ts';
const isolatedStrictRoots = [
  ...isolatedGates.map(([, root]) => root),
  'tests/drills/helpers/payment-worker-sigkill-child.ts',
  'src/types/busboy.d.ts',
  cancellationFixture,
  terminalReplayFixture,
  kimiCommercialFixture,
  runtimeHealthClockFixture,
  HTTP,
  ISOLATED_RUNNER,
  GATE_TEST,
];
const COMPILER_PREFIX =
  './node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext ' +
  '--lib ES2023 --strict --esModuleInterop --skipLibCheck --types node';
const gatewayRoots = [
  MIGRATION_058,
  'tests/saas/db/migrations/054_trigger_only_trusted_execution.postgres.integration.test.ts',
  'tests/saas/gateway/authorization-prelock-postgres.integration.test.ts',
  HTTP,
  CANDIDATE_READS,
  RESERVATION_PLANNING,
  'tests/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.postgres.integration.test.ts',
  'tests/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.postgres.integration.test.ts',
  'tests/saas/platform/auth/managed-postgres-mfa-enrollment.integration.test.ts',
  'tests/saas/billing/managed-postgres-financial-invariants.integration.test.ts',
  'tests/saas/supply/platform-inference-access.postgres.integration.test.ts',
  'tests/saas/gateway/responses-continuation.postgres.integration.test.ts',
] as const;
const standaloneRoots = [
  'tests/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.test.ts',
  'tests/saas/db/migrations/051_unknown_outcome_support_ticket.test.ts',
] as const;
const strictRoots = [
  'tests/saas/payments/payment-merchant-binding.postgres.integration.test.ts',
  terminalReplayFixture,
  'tests/saas/db/migrations.test.ts',
  ...gatewayRoots,
  ...HOTPATH_FIXTURES,
  'src/types/busboy.d.ts',
  CLI,
  WORKER,
  'tests/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.test.ts',
  'tests/saas/db/migrations/057_normal_success_usage_evidence_reference.test.ts',
  'tests/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.test.ts',
  'src/saas/db/credential-validation-worker-schema-readiness.ts',
  'src/saas/db/credential-validation-worker-privileges.ts',
  'src/saas/runtime/credential-validation-targets-module.ts',
  'tests/saas/db/credential-validation-worker-schema-readiness.test.ts',
  'tests/saas/db/credential-validation-worker-privileges.test.ts',
  GATE_TEST,
] as const;
const gatewayEnv = {
  MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1',
  MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL: ciUrl('model_router_saas_migrator'),
  MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL: ciUrl('model_router_saas_control_plane'),
  MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL: ciUrl('model_router_saas_gateway'),
};
const workerEnv = {
  MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED: '1',
  MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL: ciUrl('model_router_saas_migrator'),
  MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL: ciUrl('model_router_saas_validation_worker'),
};
function ciUrl(role: string): string {
  return `postgresql://${role}@postgres:5432/model_router_saas_ci`;
}
function unquote(value: string): string {
  return value.startsWith('"') ? (JSON.parse(value) as string) : value;
}
function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
interface Step {
  readonly block: string;
  readonly run: string;
  readonly env: Readonly<Record<string, string>>;
}
interface ManagedJob {
  readonly source: string;
  readonly steps: readonly Step[];
}
function managedJob(source: string, id = 'managed-saas-postgres-integration'): ManagedJob {
  const marker = `  ${id}:\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'the real managed PostgreSQL job must remain present');
  const remainder = source.slice(start + marker.length);
  const nextJob = /^ {2}[a-zA-Z0-9_-]+:\s*$/m.exec(remainder);
  const body = nextJob ? remainder.slice(0, nextJob.index) : remainder;
  const stepMarker = '    steps:\n';
  const stepStart = body.indexOf(stepMarker);
  assert.ok(stepStart >= 0, 'the managed job must contain actual workflow steps');
  const stepsSource = body.slice(stepStart + stepMarker.length);
  const headers = [...stepsSource.matchAll(/^ {6}- (?:name|uses): .+$/gm)];
  assert.ok(headers.length > 0, 'parse actual steps rather than comments or prose');
  const steps = headers.map((header, index): Step => {
    const block = stepsSource.slice(header.index!, headers[index + 1]?.index ?? stepsSource.length);
    const lines = block.split('\n');
    const runIndex = lines.findIndex((line) => line.startsWith('        run: '));
    const declaration = runIndex < 0 ? '' : lines[runIndex]!.slice('        run: '.length);
    // Deliberately accept the checked-in explicit scalar/folded run and env
    // layout only. Unsupported YAML indirection fails closed, not silently green.
    const run = ['>-', '|'].includes(declaration)
      ? normalized(
          lines
            .slice(runIndex + 1)
            .filter((line) => /^ {10}\S/.test(line) && !/^ {10}#/.test(line))
            .map((line) => line.slice(10))
            .join(' '),
        )
      : normalized(declaration);
    const env: Record<string, string> = {};
    let inEnv = false;
    for (const line of lines) {
      if (line === '        env:') {
        inEnv = true;
        continue;
      }
      if (inEnv && !line.startsWith('          ')) inEnv = false;
      if (!inEnv) continue;
      const entry = /^ {10}([A-Z][A-Z0-9_]*): (.+)$/.exec(line);
      assert.ok(entry, 'required env must use explicit scalar values');
      env[entry[1]!] = unquote(entry[2]!);
    }
    return { block, run, env };
  });
  return { source: body, steps };
}
function command(job: ManagedJob, run: string): Step {
  const matches = job.steps.filter((step) => step.run === run);
  assert.equal(matches.length, 1, 'a required command must occur exactly once as an executable step');
  const step = matches[0]!;
  assert.doesNotMatch(
    step.block,
    /^ {8}(?:if|continue-on-error):/m,
    'required gates must not be conditional or failure-tolerant',
  );
  return step;
}
function rootStep(job: ManagedJob, root: string): Step {
  return command(job, `node --import tsx --test ${root}`);
}
function before(job: ManagedJob, first: Step, second: Step): void {
  assert.ok(
    job.steps.indexOf(first) < job.steps.indexOf(second),
    'required fixture/provisioning order must be preserved',
  );
}
function exactEnv(step: Step, expected: Readonly<Record<string, string>>): void {
  assert.deepEqual(
    step.env,
    { NODE_ENV: 'test', ...expected },
    'required gate must use literal REQUIRED=1 and exact same-database restricted roles',
  );
}
function strictCompiler(job: ManagedJob, expectedRoots: readonly string[]): Step {
  const strict = job.steps.filter((step) => step.run.startsWith('./node_modules/.bin/tsc --noEmit '));
  assert.equal(strict.length, 1);
  const compiler = strict[0]!;
  assert.doesNotMatch(compiler.block, /^ {8}(?:if|continue-on-error):/m);
  assert.ok(
    compiler.run.startsWith(COMPILER_PREFIX + ' '),
    'retain the exact NodeNext/Node/ES2023 strict options, including existing skipLibCheck',
  );
  const actualRoots = compiler.run.slice(COMPILER_PREFIX.length + 1).split(' ');
  assert.equal(new Set(actualRoots).size, actualRoots.length, 'explicit roots must not be duplicated');
  for (const root of expectedRoots)
    assert.ok(actualRoots.includes(root), 'all explicit required roots and helpers must be typechecked');
  for (const root of actualRoots) {
    assert.ok(
      root.endsWith('.ts') && existsSync(resolve(repository, root)),
      'no missing sources, shell indirection or extra compiler weakening',
    );
  }
  return compiler;
}
function validateWorkflow(source: string): ManagedJob {
  const job = managedJob(source);
  assert.match(
    job.source,
    /^ {8}postgres-version: \["15", "18"\]$/m,
    'neither supported PG version may be removed or replaced by comments',
  );
  assert.match(job.source, /^ {6}fail-fast: false$/m);
  assert.match(job.source, /^ {8}image: postgres:\$\{\{ matrix\.postgres-version \}\}$/m);
  assert.match(job.source, /^ {10}POSTGRES_DB: model_router_saas_ci$/m);
  assert.doesNotMatch(job.source, /^ {4}(?:if|continue-on-error):/m);
  const compiler = strictCompiler(job, strictRoots);
  const provision = command(job, PROVISION);
  before(job, rootStep(job, GATE_TEST), compiler);
  before(job, compiler, provision);
  const cli = rootStep(job, CLI);
  const worker = rootStep(job, WORKER);
  exactEnv(cli, workerEnv);
  exactEnv(worker, workerEnv);
  before(job, provision, cli);
  before(job, cli, worker);
  before(job, worker, rootStep(job, MIGRATION_058));
  for (const root of gatewayRoots) {
    const step = rootStep(job, root);
    exactEnv(step, gatewayEnv);
    before(job, cli, step);
  }
  for (const root of standaloneRoots) {
    const step = rootStep(job, root);
    before(job, cli, step);
    const key = root.includes('/050_')
      ? 'MODEL_ROUTER_SAAS_MIGRATION_050_TEST_URL'
      : 'MODEL_ROUTER_SAAS_MIGRATION_051_TEST_URL';
    assert.deepEqual(step.env, { [key]: ciUrl('postgres') });
  }
  // Preserve the successful HTTP fixture dependency for 055/056. Never reset
  // initialized state or re-use an old database merely to force these green.
  for (let index = 0; index < gatewayRoots.length - 1; index += 1) {
    before(job, rootStep(job, gatewayRoots[index]!), rootStep(job, gatewayRoots[index + 1]!));
  }
  return job;
}
function validateIsolatedWorkflow(source: string): ManagedJob {
  const job = managedJob(source, ISOLATED_JOB);
  assert.match(
    job.source,
    /^ {4}needs: managed-saas-postgres-integration$/m,
    'old complete matrix must succeed before independent new services run',
  );
  assert.match(job.source, /^ {4}runs-on: ubuntu-24\.04$/m);
  assert.match(job.source, /^ {4}timeout-minutes: 20$/m);
  assert.match(job.source, /^ {4}container:\n {6}image: node:22\.16\.0-bookworm\n {6}options: --user root$/m);
  assert.doesNotMatch(job.source, /^ {4}(?:if|continue-on-error|env):/m);
  const strategy = job.source.slice(job.source.indexOf('    strategy:\n'), job.source.indexOf('    services:\n'));
  assert.equal(
    normalized(strategy),
    normalized(`
    strategy:
      fail-fast: false
      matrix:
        postgres-version: ["15", "18"]
        gate: ${JSON.stringify(isolatedGates.map(([selector]) => selector)).replaceAll(',', ', ')}
  `),
    'one fresh service per PG version/root; no include/exclude or collapsed/optional matrix',
  );
  const services = job.source.slice(job.source.indexOf('    services:\n'), job.source.indexOf('    steps:\n'));
  assert.equal(
    normalized(services),
    normalized(`
    services:
      postgres:
        image: postgres:\${{ matrix.postgres-version }}
        env:
          POSTGRES_DB: model_router_saas_ci
          POSTGRES_USER: postgres
          POSTGRES_HOST_AUTH_METHOD: trust
        options: >-
          --health-cmd "pg_isready -U postgres -d model_router_saas_ci"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 10
  `),
    'fixed CI-only trust service, no persistent volumes/shared ports/foreign DB or host fallback',
  );
  const compiler = strictCompiler(job, isolatedStrictRoots);
  const gate = command(job, `node --import tsx ${ISOLATED_RUNNER} "\${{ matrix.gate }}"`);
  assert.deepEqual(gate.env, {}, 'runner sets its own fixed required roles; no caller overrides');
  before(job, rootStep(job, GATE_TEST), compiler);
  before(job, compiler, gate);
  assert.deepEqual(
    job.steps.map((step) => step.run),
    [
      '',
      'apt-get update apt-get install --yes --no-install-recommends postgresql-client openssl rm -rf /var/lib/apt/lists/*',
      'npm ci',
      `node --import tsx --test ${GATE_TEST}`,
      compiler.run,
      gate.run,
    ],
    'only the checked-in fixed steps are supported; no masked or extra bootstrap/preseed commands',
  );
  assert.ok(job.steps[0]!.block.startsWith('      - uses: actions/checkout@v4\n'));
  for (const step of job.steps) assert.doesNotMatch(step.block, /^ {8}(?:if|continue-on-error|env):/m);
  return job;
}
function validateIsolatedRunner(source: string): void {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  // Biome keeps a gate entry on one line when it fits 120 columns and expands
  // it across four lines otherwise, so both shapes must parse.
  const gates = [
    ...code.matchAll(
      /^ {2}'([a-z0-9-]+)': (?:\{ root: '([^']+)', httpFixture: (true|false) \}|\{\n {4}root: '([^']+)',\n {4}httpFixture: (true|false),\n {2}\}),$/gm,
    ),
  ].map((match) => [match[1], match[2] ?? match[4], (match[3] ?? match[5]) === 'true']);
  assert.deepEqual(
    gates,
    isolatedGates,
    'every matrix selector must execute its original full root with its actual HTTP dependency',
  );
  const urls = [...code.matchAll(/^ {2}([a-z_]+): '(postgresql:[^']+)',$/gm)].map(([, family, url]) => [family, url]);
  assert.deepEqual(
    urls,
    ['migrator', 'control_plane', 'gateway', 'validation_worker'].map((family) => [
      family,
      ciUrl(`model_router_saas_${family}`),
    ]),
    'exact queryless roles share only the new fixed CI database',
  );
  const env = /const childEnv = \{\n([\s\S]*?)\n\};/.exec(code);
  assert.ok(env);
  assert.equal(
    normalized(env[1]!),
    normalized(`
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NODE_ENV: 'test',
    MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1',
    MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL: databaseUrls.migrator,
    MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL: databaseUrls.control_plane,
    MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL: databaseUrls.gateway,
    MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL: databaseUrls.validation_worker,
    MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: CI_SOFTWARE_KMS_MASTER_KEY,
    MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID: 'software-local',
  `),
    'no inherited credentials/PG overrides, REQUIRED=0, or administrator business URL; only runner-owned literals (the four CI-service role URLs and the synthetic CI-only envelope key) are ever passed',
  );
  assert.deepEqual(
    [...code.matchAll(/process\.env\.([A-Z_]+)/g)].map(([, name]) => name),
    ['CI', 'GITHUB_ACTIONS'],
  );
  assert.doesNotMatch(
    code,
    /process\.env\[|\.\.\.process\.env|readFile|dotenv|\b(?:GRANT|REVOKE|TRUNCATE|DROP|DELETE|UPDATE|INSERT|ALTER|CREATE)\b/i,
    'runner cannot inspect user config, widen ACL, manufacture fixtures or reset/reseed a consumed database',
  );
  const run = /function run\(command: 'bash' \| 'node', args: readonly string\[\]\): void \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(run);
  assert.equal(
    normalized(run[1]!),
    normalized(`
    const result = spawnSync(command, [...args], { env: childEnv, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      process.exitCode = result.status !== null && result.status > 0 ? result.status : 1;
      throw new Error('required CI subprocess failed');
    }
  `),
    'a failed/signal-terminated child must stop the chain, never continue or pretend success',
  );
  const main = /async function main\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(main);
  assert.equal(
    normalized(main[1]!),
    normalized(`
    if (
      process.env.CI !== 'true' ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.argv.length !== 3 ||
      !Object.hasOwn(gates, process.argv[2]!)
    ) {
      throw new Error('one fixed CI matrix selector in GitHub Actions is required');
    }
    const gate = gates[process.argv[2] as keyof typeof gates];
    phase = 'provision';
    run('bash', ['tests/saas/db/managed-postgres-runtime-privileges.integration.sh']);
    phase = 'runtime_probes';
    await runtimeProbes();
    if (gate.httpFixture) {
      phase = 'http_fixture';
      run('node', [
        '--import',
        'tsx',
        '--test',
        '${HTTP}',
      ]);
    }
    phase = 'required_root';
    run('node', ['--import', 'tsx', '--test', gate.root]);
  `),
    'guard → normal complete CLI/reconcile → probes → actual HTTP if needed → original required root',
  );
  assert.equal([...code.matchAll(/spawnSync\(/g)].length, 1);
  assert.equal([...code.matchAll(/\brun\('/g)].length, 3);
  assert.match(code, /await database\.verifySchema\(\)/);
  assert.match(code, /SELECT NOT initialized AS virgin FROM saas_platform_state WHERE singleton = TRUE/);
  assert.match(code, /virgin\.length !== 1 \|\| virgin\[0\]\?\.virgin !== true/);
  assert.match(code, /identity\.principal !== expectedRole \|\|\s*identity\.session !== expectedRole/);
  assert.match(
    code,
    /identity\.database !== 'model_router_saas_ci' \|\|\s*!identity\.safe_role \|\|\s*!\[15, 18\]\.includes\(identity\.version\)/,
  );
  assert.match(
    code,
    /for \(const family of \['migrator', 'control_plane', 'gateway', 'validation_worker'\] as const\)/,
  );
  assert.match(
    code,
    /if \(family === 'control_plane' \|\| family === 'gateway'\) await verifySaasRuntimeDatabasePrivileges\(tx, family\)/,
  );
  assert.match(
    code,
    /if \(family === 'validation_worker'\) \{\s+await verifyCredentialValidationWorkerSchemaReadiness\(tx\);\s+await verifyCredentialValidationWorkerRuntimePrivileges\(tx\);\s+\}/,
  );
  assert.match(code, /await tx\.query\('SET TRANSACTION READ ONLY'\)/);
  assert.doesNotMatch(
    code,
    /\breturn\b|\bif\s*\((?:false|true)\)/,
    'no early success or constant-condition probe/root bypass',
  );
  assert.match(code, /void main\(\)\.catch\(\(?error\)? =>/);
  assert.match(code, /typeof code === 'string' && sqlStates\.has\(code\) \? code : null/);
  assert.match(code, /process\.exitCode \?\?= 1/);
}
function validateProvisioning(source: string): void {
  const lines = source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map(normalized);
  assert.ok(lines.includes('set -euo pipefail'));
  for (const constant of [
    "readonly postgres_host='postgres'",
    "readonly postgres_port='5432'",
    "readonly postgres_admin='postgres'",
    "readonly database_name='model_router_saas_ci'",
  ])
    assert.ok(lines.includes(constant));
  assert.ok(
    lines.includes(
      'readonly migrator_url="postgresql://model_router_saas_migrator@${postgres_host}:${postgres_port}/${database_name}"',
    ),
  );
  assert.ok(
    lines.includes(
      'readonly runtime_url="postgresql://model_router_saas_control_plane@${postgres_host}:${postgres_port}/${database_name}"',
    ),
  );
  const prefix =
    'psql --no-psqlrc --set=ON_ERROR_STOP=1 --host="$postgres_host" --port="$postgres_port" ' +
    '--username="$postgres_admin" --dbname="$database_name" --file=';
  const migration = 'MODEL_ROUTER_SAAS_DATABASE_URL="$migrator_url" node --import tsx src/cli/index.ts saas:migrate';
  const probe =
    'MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL="$runtime_url" node --import tsx --test tests/saas/db/runtime-privileges.integration.test.ts';
  const executable = lines.filter((line) => line.startsWith('psql ') || line.includes('node --import tsx'));
  assert.deepEqual(
    executable,
    [
      prefix + 'deploy/managed-saas-postgres-roles.sql',
      migration,
      prefix + 'deploy/managed-saas-postgres-roles.sql',
      prefix + 'deploy/managed-saas-validation-worker-role-grants.sql',
      probe,
    ],
    'admin role template → full current CLI registry → reconcile → dedicated worker manifest → restricted runtime probe',
  );
  assert.doesNotMatch(
    lines.join('\n'),
    /\b(?:GRANT|TRUNCATE|DROP|DELETE|UPDATE)\b/i,
    'provisioning delegates manifests, not inline grants, cleanup or bootstrap rewrites',
  );
}
function changeStep(source: string, root: string, change: (block: string) => string): string {
  const step = rootStep(managedJob(source), root);
  const changed = change(step.block);
  assert.notEqual(changed, step.block);
  return source.replace(step.block, changed);
}
function changeIsolatedJob(source: string, change: (body: string) => string): string {
  const job = managedJob(source, ISOLATED_JOB);
  const changed = change(job.source);
  assert.notEqual(changed, job.source);
  return source.replace(job.source, changed);
}

test('CI preserves both PostgreSQL versions and executes all old/new required roots with exact roles', () => {
  validateWorkflow(workflow);
});
test('admin installs dedicated worker grants only after full current migrations and reconciliation', () => {
  validateProvisioning(provisioning);
  assert.throws(() =>
    validateProvisioning(
      provisioning.replace(
        'deploy/managed-saas-validation-worker-role-grants.sql',
        'deploy/managed-saas-postgres-roles.sql',
      ),
    ),
  );
  assert.throws(() =>
    validateProvisioning(
      provisioning.replace("readonly postgres_host='postgres'", "readonly postgres_host='localhost'"),
    ),
  );
});
test('required flags and identities cannot be weakened, masked, or replaced by comments', () => {
  for (const root of [CLI, WORKER, ...gatewayRoots]) {
    assert.throws(() =>
      validateWorkflow(changeStep(workflow, root, (block) => block.replace('_REQUIRED: "1"', '_REQUIRED: "0"'))),
    );
    assert.throws(() =>
      validateWorkflow(
        changeStep(workflow, root, (block) => block.replace('model_router_saas_migrator@', 'postgres@')),
      ),
    );
    assert.throws(() =>
      validateWorkflow(changeStep(workflow, root, (block) => block.replace('@postgres:5432/', '@127.0.0.1:5432/'))),
    );
    assert.throws(() =>
      validateWorkflow(
        changeStep(workflow, root, (block) =>
          block.replace('        run:', '        continue-on-error: true\n        run:'),
        ),
      ),
    );
    assert.throws(() =>
      validateWorkflow(
        changeStep(workflow, root, (block) =>
          block.replace(
            `        run: node --import tsx --test ${root}`,
            `        # run: node --import tsx --test ${root}`,
          ),
        ),
      ),
    );
  }
  assert.throws(() => validateWorkflow(workflow.replace('postgres-version: ["15", "18"]', 'postgres-version: ["15"]')));
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        '        postgres-version: ["15", "18"]',
        '        # postgres-version: ["15", "18"]\n        postgres-version: ["15"]',
      ),
    ),
  );
  assert.throws(() => validateWorkflow(workflow.replace(`          ${MIGRATION_058}\n`, '')));
});
test('the empty-job CLI and worker gates cannot be moved after job-creating fixtures', () => {
  const job = managedJob(workflow);
  const cli = rootStep(job, CLI).block;
  const worker = rootStep(job, WORKER).block;
  const swapped = workflow.replace(cli, '__CLI_BLOCK__').replace(worker, cli).replace('__CLI_BLOCK__', worker);
  assert.throws(() => validateWorkflow(swapped));
  const invalidation = rootStep(job, MIGRATION_058).block;
  const afterJobs = workflow
    .replace(cli, '__CLI_BLOCK__')
    .replace(invalidation, cli)
    .replace('__CLI_BLOCK__', invalidation);
  assert.throws(() => validateWorkflow(afterJobs));
});
test('shared CI fixtures retain separate tenant/product namespaces and do not consume HTTP bootstrap', () => {
  const cli = read(CLI);
  const worker = read(WORKER);
  const invalidation = read(MIGRATION_058);
  const http = read(HTTP);
  assert.match(cli, /await queueAndCatalogUnchanged\(migrator\)/);
  assert.match(cli, /NOT EXISTS \(SELECT 1 FROM \$\{JOBS\}\)/);
  assert.match(worker, /WHERE status IN \('queued', 'leased'\)/);
  assert.match(worker, /const tenantId = randomUUID\(\)/);
  assert.match(worker, /`prov-account-\$\{randomUUID\(\)\}`/);
  assert.match(worker, /model: `organisation\/\$\{randomUUID\(\)\}`/);
  assert.match(worker, /workers\.map\(\(worker\) => worker\.close\(\)\)/);
  assert.match(invalidation, /tenants: \[randomUUID\(\), randomUUID\(\)\]/);
  assert.match(invalidation, /provider: `058-provider-\$\{randomUUID\(\)\}`/);
  assert.match(invalidation, /product: `058-product-\$\{randomUUID\(\)\}`/);
  for (const source of [cli, worker, invalidation]) {
    assert.doesNotMatch(source, /\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
    assert.doesNotMatch(
      source,
      /\b(?:TRUNCATE|DELETE\s+FROM|UPDATE)\s+(?:model_router_saas\.)?saas_platform_(?:initialization|bootstrap)/i,
    );
  }
  assert.match(http, /const providerId = `gateway-e2e-provider-\$\{ids\.label\}`/);
  assert.match(http, /const productId = `gateway-e2e-product-\$\{ids\.label\}`/);
  assert.match(http, /await identity\.issueBootstrapToken\(\)/);
});

test('ten additional complete roots run on both versions only after the old required matrix in independent fresh services', () => {
  validateWorkflow(workflow); // All previous roots/order/role contracts remain required.
  validateIsolatedWorkflow(workflow);
  validateProvisioning(provisioning); // Same normal CLI/manifests, not copied migration SQL.
  validateIsolatedRunner(isolatedRunner);
});

test('each isolated root and helper must remain an explicit strict root and an executable matrix selection', () => {
  for (const [selector, root, httpFixture] of isolatedGates) {
    assert.throws(() =>
      validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) => body.replace(`"${selector}"`, '"missing-gate"'))),
    );
    const inlineGate = `  '${selector}': { root: '${root}', httpFixture: ${httpFixture} },\n`;
    const expandedGate = `  '${selector}': {\n    root: '${root}',\n    httpFixture: ${httpFixture},\n  },\n`;
    const gateEntry = isolatedRunner.includes(inlineGate) ? inlineGate : expandedGate;
    assert.throws(() => validateIsolatedRunner(isolatedRunner.replace(gateEntry, '')));
    assert.throws(() => validateIsolatedRunner(isolatedRunner.replace(root, 'tests/not-an-executable-root.ts')));
    const flipInline = [
      `root: '${root}', httpFixture: ${httpFixture}`,
      `root: '${root}', httpFixture: ${!httpFixture}`,
    ];
    const flipExpanded = [
      `root: '${root}',\n    httpFixture: ${httpFixture}`,
      `root: '${root}',\n    httpFixture: ${!httpFixture}`,
    ];
    const flip = isolatedRunner.includes(flipInline[0]) ? flipInline : flipExpanded;
    assert.throws(() => validateIsolatedRunner(isolatedRunner.replace(flip[0], flip[1])));
  }
  for (const root of isolatedStrictRoots) {
    assert.throws(() =>
      validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) => body.replace(`          ${root}\n`, ''))),
    );
  }
  for (const option of [
    '--strict',
    '--module NodeNext',
    '--moduleResolution NodeNext',
    '--lib ES2023',
    '--types node',
  ]) {
    assert.throws(() => validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) => body.replace(option, ''))));
  }
});

test('new job cannot remove a PG version, change service lifetime/target, bypass its needs, or mask failures', () => {
  for (const [original, replacement] of [
    ['    needs: managed-saas-postgres-integration', '    needs: build-and-test'],
    ['postgres-version: ["15", "18"]', 'postgres-version: ["18"]'],
    ['      fail-fast: false', '      fail-fast: true'],
    ['POSTGRES_DB: model_router_saas_ci', 'POSTGRES_DB: model_router_test_reused'],
    ['POSTGRES_HOST_AUTH_METHOD: trust', 'POSTGRES_HOST_AUTH_METHOD: password'],
    ['    timeout-minutes: 20', '    if: always()\n    timeout-minutes: 20'],
    ['    timeout-minutes: 20', '    continue-on-error: true\n    timeout-minutes: 20'],
    ['    services:', '        exclude: []\n    services:'],
    ['    steps:', '        volumes: ["persisted:/var/lib/postgresql/data"]\n    steps:'],
    [`        run: node --import tsx ${ISOLATED_RUNNER}`, `        # run: node --import tsx ${ISOLATED_RUNNER}`],
    [
      `        run: node --import tsx ${ISOLATED_RUNNER}`,
      `        if: false\n        run: node --import tsx ${ISOLATED_RUNNER}`,
    ],
    [
      `        run: node --import tsx ${ISOLATED_RUNNER}`,
      `        continue-on-error: true\n        run: node --import tsx ${ISOLATED_RUNNER}`,
    ],
    ['"${{ matrix.gate }}"', '"${{ matrix.gate }}" || true'],
  ] as const) {
    assert.throws(() =>
      validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) => body.replace(original, replacement))),
    );
  }
});

test('fixed runner rejects flags0, admin business actors, local/shared targets, foreign DBs, query overrides and inherited config', () => {
  for (const [original, replacement] of [
    ["_REQUIRED: '1'", "_REQUIRED: '0'"],
    ['model_router_saas_migrator@', 'postgres@'],
    ['model_router_saas_control_plane@', 'postgres@'],
    ['model_router_saas_gateway@', 'postgres@'],
    ['model_router_saas_validation_worker@', 'postgres@'],
    ['@postgres:5432/', '@localhost:5432/'],
    ['@postgres:5432/', '@127.0.0.1:53782/'],
    ["model_router_saas_ci'", "model_router_test_reused'"],
    ["model_router_saas_ci'", "model_router_saas_ci?options=unsafe'"],
    ['  NODE_ENV:', '  ...process.env,\n  NODE_ENV:'],
    ['URL: databaseUrls.migrator', 'URL: databaseUrls.gateway'],
    ["process.env.CI !== 'true'", 'false'],
    ["process.env.GITHUB_ACTIONS !== 'true'", 'false'],
  ] as const) {
    const changed = isolatedRunner.replace(original, replacement);
    assert.notEqual(changed, isolatedRunner);
    assert.throws(() => validateIsolatedRunner(changed));
  }
});

test('real complete HTTP prerequisites and child failures cannot be skipped, filtered, reset or turned into success', () => {
  for (const [original, replacement] of [
    ['if (gate.httpFixture)', 'if (false)'],
    [`'--test',\n      '${HTTP}'`, `'--test',\n      '--test-name-pattern=one-case',\n      '${HTTP}'`],
    ['  await runtimeProbes();', '  // await runtimeProbes();'],
    ["  run('node', ['--import', 'tsx', '--test', gate.root]);", '  // required gate omitted'],
    ['if (result.error || result.status !== 0)', 'if (false)'],
    ['process.exitCode ??= 1', 'process.exitCode = 0'],
    ['virgin.length !== 1 || virgin[0]?.virgin !== true', 'false'],
    ['await verifySaasRuntimeDatabasePrivileges(tx, family)', 'await Promise.resolve()'],
    ['await verifyCredentialValidationWorkerRuntimePrivileges(tx)', 'await Promise.resolve()'],
    [
      "  phase = 'required_root';",
      "  run('node', ['-e', 'UPDATE saas_platform_state SET initialized = FALSE']);\n  phase = 'required_root';",
    ],
  ] as const) {
    const changed = isolatedRunner.replace(original, replacement);
    assert.notEqual(changed, isolatedRunner);
    assert.throws(() => validateIsolatedRunner(changed));
  }
});

function validateRuntimeHealthClockSource(source: string, fixture: string): void {
  assert.match(source, /from '\.\/runtime-health-clock-postgres-fixture\.js'/);
  assert.match(source, /await healthClockDatabases\(\)/);
  assert.match(source, /proveRuntimeHealthWaitClock\(migrator, gateway, 'success'\)/);
  assert.match(source, /proveRuntimeHealthWaitClock\(migrator, gateway, 'network-failure'\)/);
  assert.match(source, /proveRuntimeHealthFutureRejected\(migrator, gateway\)/);
  assert.match(source, /proveRuntimeHealthGuard\(migrator, gateway, 'backward-time'\)/);
  assert.match(source, /proveRuntimeHealthGuard\(migrator, gateway, 'non-increasing-token'\)/);
  assert.match(source, /proveRuntimeHealthGuard\(migrator, gateway, 'revision-jump'\)/);
  assert.match(
    fixture,
    /from '\.\.\/\.\.\/\.\.\/src\/saas\/gateway\/postgres-provider-account-runtime-health-store\.js'/,
  );
  assert.match(fixture, /async function seedFixture\(migrator: SaasDatabase, gateway: SaasDatabase, future = false\)/);
  assert.match(fixture, /await seedFixture\(migrator, gateway\)/);
  assert.match(fixture, /await seedFixture\(migrator, gateway, true\)/);
  assert.match(fixture, /INSERT INTO saas_tenants/);
  assert.match(fixture, /INSERT INTO saas_provider_account_leases/);
  assert.match(
    fixture,
    /new PostgresProviderAccountRuntimeHealthStore\(\{ database \}\)\.recordRuntimeOutcome\(waiterInput\)/,
  );
  assert.match(fixture, /assert\.equal\(hash\(sql\), HEALTH_CLOCK_WRITE_SQL_SHA256,/);
  assert.match(
    fixture,
    /assert\.deepEqual\(values, expected, 'all ten original account, lease, scope and outcome bindings must match'\)/,
  );
  assert.match(fixture, /pg_blocking_pids\(\$2::integer\)/);
  for (const input of [source, fixture]) {
    assert.doesNotMatch(input, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
  }
}

function validatePaymentWorkerSigkillSource(source: string): void {
  for (const required of [
    'const urls = roleUrls();',
    "const CHILD = 'tests/drills/helpers/payment-worker-sigkill-child.ts';",
    'const tenantId = randomUUID(), actorId = randomUUID()',
    'INSERT INTO saas_users(id,email)',
    'INSERT INTO saas_tenants(id,name,slug)',
    'await registerPaymentBindings(cp, resolver);',
    'await cp.verifySchema();',
    "await verifySaasRuntimeDatabasePrivileges(cp, 'control_plane');",
    "assert.equal(initial.mode, 'disabled'",
    'await restoreControl?.();',
    '[15, 18].includes(postgresMajor)',
    'postgresMajor: evidence.postgresMajor',
    "signalOwned(submitChild, 'SIGKILL');",
    "signalOwned(firstWorker, 'SIGKILL');",
    "assert.equal(submitExit.signal, 'SIGKILL');",
    "assert.equal(workerExit.signal, 'SIGKILL');",
  ])
    assert.ok(source.includes(required), `payment SIGKILL prerequisite missing: ${required}`);
  assert.doesNotMatch(source, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
}

function validateManagedSaasSigtermSource(source: string): void {
  for (const required of [
    "fork(resolve('tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts')",
    "MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1'",
    "MODEL_ROUTER_MANAGED_SIGTERM_DRILL: '1'",
    "message.event === 'first_frame'",
    "child.kill('SIGTERM')",
    "message.event === 'draining'",
    "child.send({ event: 'release_terminal' })",
    "message.event === 'financial_converged'",
    'assert.equal(firstFrame, true',
    'assert.equal(draining, true',
    'assert.equal(converged, true',
    'assert.equal(result.signal, null)',
    'assert.equal(result.code, 0)',
  ])
    assert.ok(source.includes(required), `managed SIGTERM prerequisite missing: ${required}`);
  assert.doesNotMatch(source, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
}

test('actual source prerequisites preserve successful-HTTP dependencies and each isolated root own fixture', () => {
  const cancellation = read(cancellationFixture);
  assert.match(cancellation, /ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci'/);
  assert.match(cancellation, /cancellation PG requires prior successful real HTTP fixture for each mode/);
  assert.doesNotMatch(cancellation, /\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
  for (const [selector, root, needsHttp] of isolatedGates) {
    const source = read(root);
    assert.ok(existsSync(resolve(repository, root)));
    if (needsHttp) {
      assert.match(source, /pre-dispatch-postgres-fixture\.js/);
      assert.match(source, /await cancellationFixture\(/);
    } else if (selector === 'kimi-commercial-preparation-diagnostic') {
      // This one root owns full provisioning in its virgin isolated service.
      // It must use its fixed fixture, never consume the shared HTTP bootstrap.
      assert.match(source, /from '\.\.\/\.\.\/scripts\/ops\/verify-commercial-kimi\.js'/);
      assert.match(source, /await provisionKimiCommercialFixture\([^;]*\{\s*mode: 'source-diagnostic',?\s*\}\)/);
      assert.doesNotMatch(source, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
      const fixture = read(kimiCommercialFixture);
      assert.match(fixture, /await identity\.issueBootstrapToken\(/);
      assert.match(fixture, /await identity\.bootstrapPlatformAdmin\(/);
    } else if (selector === 'payment-merchant-binding') {
      assert.ok(source.includes('const tenantId = randomUUID();'));
      assert.ok(source.includes('const actorId = randomUUID();'));
      assert.ok(source.includes('INSERT INTO saas_users(id,email)'));
      assert.ok(source.includes('INSERT INTO saas_tenants(id,name,slug)'));
      assert.ok(source.includes('await registerPaymentBindings(cpA, resolver);'));
      assert.ok(source.includes('await restoreControl();'));
      assert.match(source, /const urls = roleUrls\(\)/);
      assert.doesNotMatch(source, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
    } else if (selector === 'payment-worker-sigkill') {
      validatePaymentWorkerSigkillSource(source);
    } else if (selector === 'managed-saas-sigterm') {
      validateManagedSaasSigtermSource(source);
    } else if (selector === 'runtime-health-clock') {
      validateRuntimeHealthClockSource(source, read(runtimeHealthClockFixture));
    } else if (selector === 'dispatch-proof-fence-batch') {
      assert.match(source, /from '\.\.\/gateway\/prepared-evidence-authority-postgres-fixture\.js'/);
      assert.match(source, /mode: 'byok' \| 'platform' = 'platform'/);
      assert.match(source, /await evidenceAuthorityFixture\(migrator, gateway, mode\)/);
      assert.match(source, /for \(const mode of \['byok', 'platform'\] as const\)/);
      const fixture = read('tests/saas/gateway/prepared-evidence-authority-postgres-fixture.ts');
      assert.match(fixture, /from '\.\.\/metering\/normal-success-postgres-fixture\.js'/);
      assert.match(fixture, /await seedFixture\(migrator, gateway, mode\)/);
      for (const input of [source, fixture]) {
        assert.doesNotMatch(input, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
      }
    } else {
      // Seed helpers are named per domain (seedIdentities/seedAccount/seedCredential/seedFixture/...);
      // the invariant is own-row seeding, never a shared HTTP bootstrap.
      assert.match(source, /\bseed[A-Z][A-Za-z]*\(/);
      // Connection helpers (cancellationDatabases/cancellationTransaction) are
      // allowed; the one-shot commercial HTTP fixture and bootstrap tokens are not.
      assert.doesNotMatch(source, /await cancellationFixture\(|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
    }
  }
  const terminal = read(terminalReplayFixture);
  assert.match(terminal, /export async function seedFixture\(/);
  assert.doesNotMatch(terminal, /\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
});

test('runtime health clock gate retains its fixed own-row helper and real restricted health writer proof', () => {
  const entry = isolatedGates.find(([selector]) => selector === 'runtime-health-clock');
  assert.ok(entry);
  assert.equal(entry[2], false);
  const source = read(entry[1]);
  const fixture = read(runtimeHealthClockFixture);
  validateRuntimeHealthClockSource(source, fixture);
  for (const marker of [
    "from './runtime-health-clock-postgres-fixture.js'",
    'await healthClockDatabases()',
    "proveRuntimeHealthWaitClock(migrator, gateway, 'success')",
    "proveRuntimeHealthWaitClock(migrator, gateway, 'network-failure')",
    'proveRuntimeHealthFutureRejected(migrator, gateway)',
    "proveRuntimeHealthGuard(migrator, gateway, 'backward-time')",
    "proveRuntimeHealthGuard(migrator, gateway, 'non-increasing-token')",
    "proveRuntimeHealthGuard(migrator, gateway, 'revision-jump')",
  ]) {
    assert.ok(source.includes(marker));
    assert.throws(() => validateRuntimeHealthClockSource(source.replace(marker, 'removed-contract'), fixture));
  }
  for (const marker of [
    'async function seedFixture(migrator: SaasDatabase, gateway: SaasDatabase, future = false)',
    'await seedFixture(migrator, gateway)',
    'await seedFixture(migrator, gateway, true)',
    'INSERT INTO saas_tenants',
    'INSERT INTO saas_provider_account_leases',
    'new PostgresProviderAccountRuntimeHealthStore({ database }).recordRuntimeOutcome(waiterInput)',
    'assert.equal(hash(sql), HEALTH_CLOCK_WRITE_SQL_SHA256,',
    "assert.deepEqual(values, expected, 'all ten original account, lease, scope and outcome bindings must match')",
    'pg_blocking_pids($2::integer)',
  ]) {
    assert.ok(fixture.includes(marker));
    assert.throws(() => validateRuntimeHealthClockSource(source, fixture.replaceAll(marker, 'removed-contract')));
  }
  for (const forbidden of ['await cancellationFixture(', 'issueBootstrapToken(', 'bootstrapPlatformAdmin(']) {
    assert.throws(() => validateRuntimeHealthClockSource(`${source}\n${forbidden}`, fixture));
    assert.throws(() => validateRuntimeHealthClockSource(source, `${fixture}\n${forbidden}`));
  }
});

test('dispatch capacity gate retains the HTTP prerequisite and real account lease exhaustion compensation', () => {
  const entry = isolatedGates.find(([selector]) => selector === 'dispatch-capacity');
  assert.ok(entry);
  assert.equal(entry[2], true, 'this root must follow the complete successful same-database HTTP fixture');
  const source = read(entry[1]);
  assert.match(source, /from '\.\/pre-dispatch-postgres-fixture\.js'/);
  assert.equal([...source.matchAll(/await cancellationFixture\(migrator, gateway, mode\)/g)].length, 2);
  assert.match(source, /for \(const mode of \['byok', 'platform'\] as const\)/);
  assert.match(source, /new PostgresProviderAccountLeaseService\(\{\s*database: gateway,\s*maxConcurrency: 1,/);
  assert.match(source, /await raw\.acquire\(/);
  assert.match(source, /createPostgresDispatchLeaseProvider\(raw\)/);
  assert.match(source, /await dispatcher\.dispatch\(input\)/);
  assert.match(source, /assert\.equal\(error\.code, 'LEASE_CAPACITY_EXHAUSTED'\)/);
  assert.match(source, /new GatewayPreDispatchCompensationService\(/);
  assert.match(source, /new PostgresPreDispatchCompensation\(/);
  assert.match(source, /assert\.equal\(response\.status, 429\)/);
  assert.match(source, /\{ preflights: 1, claims: 0, acquires: 1, sends: 0, cleanups: 1, capacityErrors: 1 \}/);
  assert.match(source, /assert\.deepEqual\(await financialSnapshot\(migrator, b\), beforeFinancial\)/);
  assert.match(source, /assert\.deepEqual\(await heldLeaseSnapshot\(migrator, a\), beforeA/);
  assert.match(source, /await compensation\.compensate\(/);
  assert.match(source, /error\.code === 'ATTEMPT_TRANSITION_INVALID'/);
  assert.doesNotMatch(source, /\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
});

test('prepared statement gate uses the real source APIs and the disposable commercial runner custom test entry', () => {
  const entry = isolatedGates.find(([selector]) => selector === 'prepared-statements');
  assert.ok(entry);
  assert.equal(entry[2], false, 'this root owns its fixture and needs no shared HTTP bootstrap');
  const source = read(entry[1]);
  assert.match(source, /await seedFixture\(migrator, seedGateway, mode\)/);
  assert.match(source, /new PostgresProviderAccountScheduler\(/);
  assert.match(source, /new SaasCommercialMeteringPolicyService\(database\)\.resolveDispatchableRoute\(/);
  assert.match(source, /observePreparationExecutor\(observeExecutor\(executor, calls\)/);
  assert.match(source, /preparedStatements: 'native'/);
  assert.match(source, /observedDatabase\(off, 'auto'/);
  assert.match(source, /observedDatabase\(native, 'auto'/);
  assert.match(source, /observedDatabase\(native, 'force_generic_plan'/);
  assert.match(source, /SET LOCAL plan_cache_mode = force_generic_plan/);
  assert.doesNotMatch(source, /(?:SET|set_config\()\s+plan_cache_mode\s*=/);
  assert.match(source, /FROM pg_prepared_statements ORDER BY name/);
  const runner = read('scripts/run-commercial-postgres-gate.mjs');
  assert.match(runner, /if \(options\.testFile\) \{/);
  assert.match(runner, /options\.suite = 'custom';\s+suites\.custom = testName;/);
  assert.ok(
    /\[\s*'--import', 'tsx', '--test', '--test-reporter=tap', suites\[suite\],?\s*\]/.test(runner),
    'the custom suite must execute the complete chosen root with the native TAP reporter',
  );
  assert.match(runner, /counts\.tests > 0 && counts\.pass === counts\.tests/);
});

test('P0 platform provisioning remains a complete required restricted-role PG gate after financial fixtures', () => {
  validateWorkflow(workflow);
  const root = 'tests/saas/supply/platform-inference-access.postgres.integration.test.ts';
  const source = read(root);
  assert.match(source, /REQUIRED_FLAG.*roleUrls.*seedFixture/);
  assert.match(source, /process\.env\[REQUIRED_FLAG\] !== '1' && !anyRoleConfigured/);
  assert.match(source, /seedFixture\(migrator,\s*gateway,\s*'platform'\)/);
  const job = managedJob(workflow);
  before(job, rootStep(job, WORKER), rootStep(job, root));
  before(
    job,
    rootStep(job, 'tests/saas/billing/managed-postgres-financial-invariants.integration.test.ts'),
    rootStep(job, root),
  );
});

test('historical full migration chains use only a test administrator and isolated temporary databases', () => {
  const root = 'tests/saas/db/migrations.test.ts';
  const job = managedJob(workflow);
  const step = rootStep(job, root);
  assert.deepEqual(step.env, {
    SAAS_TEST_DATABASE_URL: ciUrl('model_router_saas_migrator'),
    SAAS_TEST_DATABASE_ADMIN_URL: ciUrl('postgres'),
  });
  before(job, rootStep(job, WORKER), step);
  const source = read(root);
  assert.ok(
    source.includes(
      "if (!process.env.SAAS_TEST_DATABASE_ADMIN_URL) throw new Error('SAAS_TEST_DATABASE_ADMIN_URL is required for isolated migration fixture provisioning');",
    ),
  );
  assert.ok(source.includes('const administratorUrl = new URL(process.env.SAAS_TEST_DATABASE_ADMIN_URL);'));
  assert.ok(source.includes('const migratorUrl = new URL(realPostgresUrl);'));
  assert.ok(
    source.includes(
      "if (decodeURIComponent(migratorUrl.username) !== 'model_router_saas_migrator') throw new Error('SAAS_TEST_DATABASE_URL must authenticate as the non-superuser model_router_saas_migrator test login');",
    ),
  );
  assert.ok(
    source.includes(
      "if (administratorUrl.hostname !== migratorUrl.hostname || (administratorUrl.port || '5432') !== (migratorUrl.port || '5432')) throw new Error('Migration fixture administrator and migrator URLs must target the same test PostgreSQL instance');",
    ),
  );
  assert.ok(source.includes('const fixtureUrl = new URL(migratorUrl);'));
  assert.ok(source.includes('fixtureUrl.pathname = `/${databaseName}`;'));
  assert.ok(source.includes('await administrator.query(`CREATE DATABASE "${databaseName}"`);'));
  assert.ok(source.includes('if (created) await administrator.query(`DROP DATABASE "${databaseName}"`);'));
  assert.ok(
    source.includes("const databaseName = `model_router_test_migrations_${randomUUID().replaceAll('-', '')}`;"),
  );
  assert.ok(
    source.includes("const rolesSql = await readFile(resolve('deploy/managed-saas-postgres-roles.sql'), 'utf8');"),
  );
  assert.ok(source.includes('await setup.query(rolesSql);'));
  assert.match(source, /model_router_test_migrations_/);
  assert.match(source, /CREATE DATABASE/);
  assert.match(source, /DROP DATABASE/);
  assert.doesNotMatch(source, /ALTER ROLE[^;]*CREATEDB/);
  for (const key of ['SAAS_TEST_DATABASE_URL', 'SAAS_TEST_DATABASE_ADMIN_URL']) {
    assert.throws(() => {
      const expectedRole = key === 'SAAS_TEST_DATABASE_URL' ? 'model_router_saas_migrator' : 'postgres';
      const invalid = workflow.replace(`          ${key}: ${ciUrl(expectedRole)}\n`, '');
      const configured = rootStep(managedJob(invalid), root);
      assert.deepEqual(configured.env, step.env);
    });
  }
});

test('encrypted Responses history permits only unconfigured offline skip and keeps required PG fail-closed', () => {
  const root = 'tests/saas/gateway/responses-continuation.postgres.integration.test.ts';
  const job = validateWorkflow(workflow);
  const source = read(root);
  before(job, rootStep(job, WORKER), rootStep(job, root));
  before(
    job,
    rootStep(job, 'tests/saas/supply/platform-inference-access.postgres.integration.test.ts'),
    rootStep(job, root),
  );
  assert.match(source, /const urls = roleUrls\(\)/);
  assert.match(source, /seedFixture\(migrator,\s*gateway,\s*'platform'\)/);
  assert.match(source, /new PostgresResponsesContinuationHistory\(gateway\)/);
  assert.match(source, /await gateway\.verifySchema\(\)/);
  assert.match(source, /history\.insert\(saved\)/);
  assert.match(source, /history\.purgeExpired\(/);
  const offlineSkip =
    "skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? `set ${REQUIRED_FLAG}=1 and disposable role URLs` : false";
  const validateSkip = (candidate: string): void => {
    assert.equal(candidate.split(offlineSkip).length - 1, 1, 'only the exact unconfigured offline skip is permitted');
    assert.doesNotMatch(candidate.replace(offlineSkip, ''), /\bskip\s*:|\bt\.skip\(|\btest\.skip\(/);
    assert.match(candidate, /const urls = roleUrls\(\)/);
  };
  validateSkip(source);
  exactEnv(rootStep(job, root), gatewayEnv);
  for (const replacement of [
    'skip: true',
    "skip: process.env[REQUIRED_FLAG] !== '1'",
    'skip: !anyRoleConfigured',
    "skip: process.env[REQUIRED_FLAG] !== '1' || !anyRoleConfigured",
  ])
    assert.throws(() => validateSkip(source.replace(offlineSkip, replacement)));
  assert.throws(() => validateSkip(`${source}\ntest.skip('disabled gate', () => {});`));
});

test('P0 roots share the fail-closed disposable restricted-role URL contract', () => {
  const source = read(terminalReplayFixture);
  assert.match(source, /export function roleUrls\(\)/);
  assert.match(source, /assert\.ok\(value, `\$\{name\} is required/);
  assert.match(source, /assert\.ok\(username === role/);
  assert.match(source, /assert\.ok\(url\.search === ''/);
  assert.match(source, /assert\.ok\(ci \|\| local/);
  assert.match(source, /assert\.ok\(identity === target/);
});

test('merchant binding PG gate runs only in a fresh isolated service without financial HTTP fixtures', () => {
  validateWorkflow(workflow);
  validateIsolatedWorkflow(workflow);
  validateIsolatedRunner(isolatedRunner);
  const root = 'tests/saas/payments/payment-merchant-binding.postgres.integration.test.ts';
  const entry = isolatedGates.find(([selector]) => selector === 'payment-merchant-binding');
  assert.ok(entry);
  assert.equal(entry[1], root);
  assert.equal(entry[2], false, 'legacy financial orders intentionally block merchant admission');
  assert.equal(
    managedJob(workflow).steps.filter((step) => step.run.includes(root)).length,
    1,
    'shared job only compiles merchant source',
  );
  assert.equal(managedJob(workflow).steps.filter((step) => step.run === `node --import tsx --test ${root}`).length, 0);
  strictCompiler(managedJob(workflow), [root]);
  strictCompiler(managedJob(workflow, ISOLATED_JOB), [root]);
});

test('isolated signal drills retain independent fixtures and real signal/convergence prerequisites', () => {
  const payment = isolatedGates.find(([selector]) => selector === 'payment-worker-sigkill');
  const managed = isolatedGates.find(([selector]) => selector === 'managed-saas-sigterm');
  assert.ok(payment && managed);
  assert.equal(payment[2], false);
  assert.equal(managed[2], false, 'SIGTERM child owns its one fresh HTTP bootstrap');
  const paymentSource = read(payment[1]);
  const managedSource = read(managed[1]);
  validatePaymentWorkerSigkillSource(paymentSource);
  validateManagedSaasSigtermSource(managedSource);
  for (const required of [
    'await registerPaymentBindings(cp, resolver);',
    "assert.equal(initial.mode, 'disabled'",
    "signalOwned(submitChild, 'SIGKILL');",
    '[15, 18].includes(postgresMajor)',
  ]) {
    assert.throws(() => validatePaymentWorkerSigkillSource(paymentSource.replace(required, 'removed prerequisite')));
  }
  for (const required of [
    "MODEL_ROUTER_MANAGED_SIGTERM_DRILL: '1'",
    "child.kill('SIGTERM')",
    "child.send({ event: 'release_terminal' })",
    'assert.equal(converged, true',
    'assert.equal(result.code, 0)',
  ]) {
    assert.throws(() => validateManagedSaasSigtermSource(managedSource.replace(required, 'removed prerequisite')));
  }
});

// Candidate probes own their authority, but must also preserve the existing
// HTTP fixture lease history. Keep that regression in the seeded PG15/18 main
// matrix rather than an empty isolated service, with required ordering gates.
test('v3 hot-path roots and shared fixtures are strict required seeded PostgreSQL gates', () => {
  const job = validateWorkflow(workflow);
  const http = rootStep(job, HTTP);
  for (const root of [CANDIDATE_READS, RESERVATION_PLANNING]) {
    const step = rootStep(job, root);
    before(job, http, step);
    exactEnv(step, gatewayEnv);
    assert.equal(isolatedRunner.includes(root), false, 'the hot-path roots must not run on an empty isolated service');
    assert.throws(() => validateWorkflow(workflow.replace(`          ${root}\n`, '')));
    const tooEarly = workflow
      .replace(http.block, '__HTTP_FIXTURE__')
      .replace(step.block, http.block)
      .replace('__HTTP_FIXTURE__', step.block);
    assert.throws(() => validateWorkflow(tooEarly), 'moving a v3 gate ahead of the actual HTTP fixture must fail');
  }
  for (const fixture of HOTPATH_FIXTURES) {
    assert.throws(() => validateWorkflow(workflow.replace(`          ${fixture}\n`, '')));
  }
});
