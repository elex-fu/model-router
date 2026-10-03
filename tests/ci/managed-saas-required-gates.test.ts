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
const MIGRATION_058 = 'tests/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.postgres.integration.test.ts';
const HTTP = 'tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts';
const PROVISION = 'bash tests/saas/db/managed-postgres-runtime-privileges.integration.sh';
const GATE_TEST = 'tests/ci/managed-saas-required-gates.test.ts';
const ISOLATED_JOB = 'managed-saas-isolated-required-gates';
const ISOLATED_RUNNER = 'tests/ci/managed-saas-isolated-required-gates.ts';
const isolatedRunner = read(ISOLATED_RUNNER);
const isolatedGates = [
  ['cancellation-059', 'tests/saas/db/migrations/059_pre_dispatch_terminal_cancellation.postgres.integration.test.ts', true],
  ['pre-dispatch-compensation', 'tests/saas/gateway/pre-dispatch-compensation-postgres.integration.test.ts', true],
  ['concurrent-claim', 'tests/saas/gateway/prepared-evidence-concurrent-claim.postgres.integration.test.ts', true],
  ['normal-success-terminal-replay', 'tests/saas/metering/normal-success-terminal-replay.postgres.integration.test.ts', false],
  ['member-directory', 'tests/saas/identity/tenant-member-directory.postgres.integration.test.ts', false],
  ['member-directory-http', 'tests/saas/identity/tenant-member-directory-http.postgres.integration.test.ts', false],
] as const;
const cancellationFixture = 'tests/saas/gateway/pre-dispatch-postgres-fixture.ts';
const terminalReplayFixture = 'tests/saas/metering/normal-success-postgres-fixture.ts';
const isolatedStrictRoots = [
  ...isolatedGates.map(([, root]) => root), cancellationFixture, terminalReplayFixture, HTTP, ISOLATED_RUNNER, GATE_TEST,
];
const COMPILER_PREFIX = './node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext ' +
  '--lib ES2023 --strict --esModuleInterop --skipLibCheck --types node';
const gatewayRoots = [
  MIGRATION_058,
  'tests/saas/db/migrations/054_trigger_only_trusted_execution.postgres.integration.test.ts',
  'tests/saas/gateway/authorization-prelock-postgres.integration.test.ts',
  HTTP,
  'tests/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.postgres.integration.test.ts',
  'tests/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.postgres.integration.test.ts',
  'tests/saas/platform/auth/managed-postgres-mfa-enrollment.integration.test.ts',
  'tests/saas/billing/managed-postgres-financial-invariants.integration.test.ts',
] as const;
const standaloneRoots = [
  'tests/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.test.ts',
  'tests/saas/db/migrations/051_unknown_outcome_support_ticket.test.ts',
] as const;
const strictRoots = [
  ...gatewayRoots, CLI, WORKER,
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
  return value.startsWith('"') ? JSON.parse(value) as string : value;
}
function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
interface Step { readonly block: string; readonly run: string; readonly env: Readonly<Record<string, string>>; }
interface ManagedJob { readonly source: string; readonly steps: readonly Step[]; }
function managedJob(source: string, id = 'managed-saas-postgres-integration'): ManagedJob {
  const marker = `  ${id}:\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'the real managed PostgreSQL job must remain present');
  const remainder = source.slice(start + marker.length);
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(remainder);
  const body = nextJob ? remainder.slice(0, nextJob.index) : remainder;
  const stepMarker = '    steps:\n';
  const stepStart = body.indexOf(stepMarker);
  assert.ok(stepStart >= 0, 'the managed job must contain actual workflow steps');
  const stepsSource = body.slice(stepStart + stepMarker.length);
  const headers = [...stepsSource.matchAll(/^      - (?:name|uses): .+$/gm)];
  assert.ok(headers.length > 0, 'parse actual steps rather than comments or prose');
  const steps = headers.map((header, index): Step => {
    const block = stepsSource.slice(header.index!, headers[index + 1]?.index ?? stepsSource.length);
    const lines = block.split('\n');
    const runIndex = lines.findIndex((line) => line.startsWith('        run: '));
    const declaration = runIndex < 0 ? '' : lines[runIndex]!.slice('        run: '.length);
    // Deliberately accept the checked-in explicit scalar/folded run and env
    // layout only. Unsupported YAML indirection fails closed, not silently green.
    const run = ['>-', '|'].includes(declaration)
      ? normalized(lines.slice(runIndex + 1).filter((line) => /^          \S/.test(line) && !/^          #/.test(line)).map((line) => line.slice(10)).join(' '))
      : normalized(declaration);
    const env: Record<string, string> = {};
    let inEnv = false;
    for (const line of lines) {
      if (line === '        env:') { inEnv = true; continue; }
      if (inEnv && !line.startsWith('          ')) inEnv = false;
      if (!inEnv) continue;
      const entry = /^          ([A-Z][A-Z0-9_]*): (.+)$/.exec(line);
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
  assert.doesNotMatch(step.block, /^        (?:if|continue-on-error):/m, 'required gates must not be conditional or failure-tolerant');
  return step;
}
function rootStep(job: ManagedJob, root: string): Step {
  return command(job, `node --import tsx --test ${root}`);
}
function before(job: ManagedJob, first: Step, second: Step): void {
  assert.ok(job.steps.indexOf(first) < job.steps.indexOf(second), 'required fixture/provisioning order must be preserved');
}
function exactEnv(step: Step, expected: Readonly<Record<string, string>>): void {
  assert.deepEqual(step.env, { NODE_ENV: 'test', ...expected }, 'required gate must use literal REQUIRED=1 and exact same-database restricted roles');
}
function strictCompiler(job: ManagedJob, expectedRoots: readonly string[]): Step {
  const strict = job.steps.filter((step) => step.run.startsWith('./node_modules/.bin/tsc --noEmit '));
  assert.equal(strict.length, 1);
  const compiler = strict[0]!;
  assert.doesNotMatch(compiler.block, /^        (?:if|continue-on-error):/m);
  assert.ok(compiler.run.startsWith(COMPILER_PREFIX + ' '), 'retain the exact NodeNext/Node/ES2023 strict options, including existing skipLibCheck');
  const actualRoots = compiler.run.slice(COMPILER_PREFIX.length + 1).split(' ');
  assert.equal(new Set(actualRoots).size, actualRoots.length, 'explicit roots must not be duplicated');
  for (const root of expectedRoots) assert.ok(actualRoots.includes(root), 'all explicit required roots and helpers must be typechecked');
  for (const root of actualRoots) {
    assert.ok(root.endsWith('.ts') && existsSync(resolve(repository, root)), 'no missing sources, shell indirection or extra compiler weakening');
  }
  return compiler;
}
function validateWorkflow(source: string): ManagedJob {
  const job = managedJob(source);
  assert.match(job.source, /^        postgres-version: \["15", "18"\]$/m, 'neither supported PG version may be removed or replaced by comments');
  assert.match(job.source, /^      fail-fast: false$/m);
  assert.match(job.source, /^        image: postgres:\$\{\{ matrix\.postgres-version \}\}$/m);
  assert.match(job.source, /^          POSTGRES_DB: model_router_saas_ci$/m);
  assert.doesNotMatch(job.source, /^    (?:if|continue-on-error):/m);
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
    const key = root.includes('/050_') ? 'MODEL_ROUTER_SAAS_MIGRATION_050_TEST_URL' : 'MODEL_ROUTER_SAAS_MIGRATION_051_TEST_URL';
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
  assert.match(job.source, /^    needs: managed-saas-postgres-integration$/m, 'old complete matrix must succeed before independent new services run');
  assert.match(job.source, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(job.source, /^    timeout-minutes: 20$/m);
  assert.match(job.source, /^    container:\n      image: node:22\.16\.0-bookworm\n      options: --user root$/m);
  assert.doesNotMatch(job.source, /^    (?:if|continue-on-error|env):/m);
  const strategy = job.source.slice(job.source.indexOf('    strategy:\n'), job.source.indexOf('    services:\n'));
  assert.equal(normalized(strategy), normalized(`
    strategy:
      fail-fast: false
      matrix:
        postgres-version: ["15", "18"]
        gate: ${JSON.stringify(isolatedGates.map(([selector]) => selector)).replaceAll(',', ', ')}
  `), 'one fresh service per PG version/root; no include/exclude or collapsed/optional matrix');
  const services = job.source.slice(job.source.indexOf('    services:\n'), job.source.indexOf('    steps:\n'));
  assert.equal(normalized(services), normalized(`
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
  `), 'fixed CI-only trust service, no persistent volumes/shared ports/foreign DB or host fallback');
  const compiler = strictCompiler(job, isolatedStrictRoots);
  const gate = command(job, `node --import tsx ${ISOLATED_RUNNER} "\${{ matrix.gate }}"`);
  assert.deepEqual(gate.env, {}, 'runner sets its own fixed required roles; no caller overrides');
  before(job, rootStep(job, GATE_TEST), compiler);
  before(job, compiler, gate);
  assert.deepEqual(job.steps.map((step) => step.run), [
    '', 'apt-get update apt-get install --yes --no-install-recommends postgresql-client openssl rm -rf /var/lib/apt/lists/*',
    'npm ci', `node --import tsx --test ${GATE_TEST}`, compiler.run, gate.run,
  ], 'only the checked-in fixed steps are supported; no masked or extra bootstrap/preseed commands');
  assert.ok(job.steps[0]!.block.startsWith('      - uses: actions/checkout@v4\n'));
  for (const step of job.steps) assert.doesNotMatch(step.block, /^        (?:if|continue-on-error|env):/m);
  return job;
}
function validateIsolatedRunner(source: string): void {
  const code = source.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const gates = [...code.matchAll(/^  '([a-z0-9-]+)': \{ root: '([^']+)', httpFixture: (true|false) \},$/gm)]
    .map(([, selector, root, httpFixture]) => [selector, root, httpFixture === 'true']);
  assert.deepEqual(gates, isolatedGates, 'every matrix selector must execute its original full root with its actual HTTP dependency');
  const urls = [...code.matchAll(/^  ([a-z_]+): '(postgresql:[^']+)',$/gm)].map(([, family, url]) => [family, url]);
  assert.deepEqual(urls, ['migrator', 'control_plane', 'gateway', 'validation_worker']
    .map((family) => [family, ciUrl(`model_router_saas_${family}`)]), 'exact queryless roles share only the new fixed CI database');
  const env = /const childEnv = \{\n([\s\S]*?)\n\};/.exec(code);
  assert.ok(env);
  assert.equal(normalized(env[1]!), normalized(`
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NODE_ENV: 'test',
    MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1',
    MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL: databaseUrls.migrator,
    MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL: databaseUrls.control_plane,
    MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL: databaseUrls.gateway,
  `), 'no inherited credentials/PG overrides, REQUIRED=0, or administrator business URL');
  assert.deepEqual([...code.matchAll(/process\.env\.([A-Z_]+)/g)].map(([, name]) => name), ['CI', 'GITHUB_ACTIONS']);
  assert.doesNotMatch(code, /process\.env\[|\.\.\.process\.env|readFile|dotenv|\b(?:GRANT|REVOKE|TRUNCATE|DROP|DELETE|UPDATE|INSERT|ALTER|CREATE)\b/i,
    'runner cannot inspect user config, widen ACL, manufacture fixtures or reset/reseed a consumed database');
  const run = /function run\(command: 'bash' \| 'node', args: readonly string\[\]\): void \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(run);
  assert.equal(normalized(run[1]!), normalized(`
    const result = spawnSync(command, [...args], { env: childEnv, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      process.exitCode = result.status !== null && result.status > 0 ? result.status : 1;
      throw new Error('required CI subprocess failed');
    }
  `), 'a failed/signal-terminated child must stop the chain, never continue or pretend success');
  const main = /async function main\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(code);
  assert.ok(main);
  assert.equal(normalized(main[1]!), normalized(`
    if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
      process.argv.length !== 3 || !Object.hasOwn(gates, process.argv[2]!)) {
      throw new Error('one fixed CI matrix selector in GitHub Actions is required');
    }
    const gate = gates[process.argv[2] as keyof typeof gates];
    phase = 'provision';
    run('bash', ['tests/saas/db/managed-postgres-runtime-privileges.integration.sh']);
    phase = 'runtime_probes';
    await runtimeProbes();
    if (gate.httpFixture) {
      phase = 'http_fixture';
      run('node', ['--import', 'tsx', '--test', '${HTTP}']);
    }
    phase = 'required_root';
    run('node', ['--import', 'tsx', '--test', gate.root]);
  `), 'guard → normal complete CLI/reconcile → probes → actual HTTP if needed → original required root');
  assert.equal([...code.matchAll(/spawnSync\(/g)].length, 1);
  assert.equal([...code.matchAll(/\brun\('/g)].length, 3);
  assert.match(code, /await database\.verifySchema\(\)/);
  assert.match(code, /SELECT NOT initialized AS virgin FROM saas_platform_state WHERE singleton = TRUE/);
  assert.match(code, /virgin\.length !== 1 \|\| virgin\[0\]\?\.virgin !== true/);
  assert.match(code, /identity\.principal !== expectedRole \|\| identity\.session !== expectedRole/);
  assert.match(code, /identity\.database !== 'model_router_saas_ci' \|\| !identity\.safe_role \|\| !\[15, 18\]\.includes\(identity\.version\)/);
  assert.match(code, /for \(const family of \['migrator', 'control_plane', 'gateway', 'validation_worker'\] as const\)/);
  assert.match(code, /if \(family === 'control_plane' \|\| family === 'gateway'\) await verifySaasRuntimeDatabasePrivileges\(tx, family\)/);
  assert.match(code, /if \(family === 'validation_worker'\) \{\s+await verifyCredentialValidationWorkerSchemaReadiness\(tx\);\s+await verifyCredentialValidationWorkerRuntimePrivileges\(tx\);\s+\}/);
  assert.match(code, /await tx\.query\('SET TRANSACTION READ ONLY'\)/);
  assert.doesNotMatch(code, /\breturn\b|\bif\s*\((?:false|true)\)/, 'no early success or constant-condition probe/root bypass');
  assert.match(code, /void main\(\)\.catch\(error =>/);
  assert.match(code, /typeof code === 'string' && sqlStates\.has\(code\) \? code : null/);
  assert.match(code, /process\.exitCode \?\?= 1/);
}
function validateProvisioning(source: string): void {
  const lines = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    .replace(/\\\n\s*/g, ' ').split('\n').map(normalized);
  assert.ok(lines.includes('set -euo pipefail'));
  for (const constant of ["readonly postgres_host='postgres'", "readonly postgres_port='5432'",
    "readonly postgres_admin='postgres'", "readonly database_name='model_router_saas_ci'"]) assert.ok(lines.includes(constant));
  assert.ok(lines.includes('readonly migrator_url="postgresql://model_router_saas_migrator@${postgres_host}:${postgres_port}/${database_name}"'));
  assert.ok(lines.includes('readonly runtime_url="postgresql://model_router_saas_control_plane@${postgres_host}:${postgres_port}/${database_name}"'));
  const prefix = 'psql --no-psqlrc --set=ON_ERROR_STOP=1 --host="$postgres_host" --port="$postgres_port" ' +
    '--username="$postgres_admin" --dbname="$database_name" --file=';
  const migration = 'MODEL_ROUTER_SAAS_DATABASE_URL="$migrator_url" node --import tsx src/cli/index.ts saas:migrate';
  const probe = 'MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL="$runtime_url" node --import tsx --test tests/saas/db/runtime-privileges.integration.test.ts';
  const executable = lines.filter((line) => line.startsWith('psql ') || line.includes('node --import tsx'));
  assert.deepEqual(executable, [
    prefix + 'deploy/managed-saas-postgres-roles.sql', migration,
    prefix + 'deploy/managed-saas-postgres-roles.sql',
    prefix + 'deploy/managed-saas-validation-worker-role-grants.sql', probe,
  ], 'admin role template → full current CLI registry → reconcile → dedicated worker manifest → restricted runtime probe');
  assert.doesNotMatch(lines.join('\n'), /\b(?:GRANT|TRUNCATE|DROP|DELETE|UPDATE)\b/i, 'provisioning delegates manifests, not inline grants, cleanup or bootstrap rewrites');
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
  assert.throws(() => validateProvisioning(provisioning.replace('deploy/managed-saas-validation-worker-role-grants.sql', 'deploy/managed-saas-postgres-roles.sql')));
  assert.throws(() => validateProvisioning(provisioning.replace("readonly postgres_host='postgres'", "readonly postgres_host='localhost'")));
});
test('required flags and identities cannot be weakened, masked, or replaced by comments', () => {
  for (const root of [CLI, WORKER, ...gatewayRoots]) {
    assert.throws(() => validateWorkflow(changeStep(workflow, root, (block) => block.replace('_REQUIRED: "1"', '_REQUIRED: "0"'))));
    assert.throws(() => validateWorkflow(changeStep(workflow, root, (block) => block.replace('model_router_saas_migrator@', 'postgres@'))));
    assert.throws(() => validateWorkflow(changeStep(workflow, root, (block) => block.replace('@postgres:5432/', '@127.0.0.1:5432/'))));
    assert.throws(() => validateWorkflow(changeStep(workflow, root, (block) => block.replace('        run:', '        continue-on-error: true\n        run:'))));
    assert.throws(() => validateWorkflow(changeStep(workflow, root, (block) => block.replace(`        run: node --import tsx --test ${root}`, `        # run: node --import tsx --test ${root}`))));
  }
  assert.throws(() => validateWorkflow(workflow.replace('postgres-version: ["15", "18"]', 'postgres-version: ["15"]')));
  assert.throws(() => validateWorkflow(workflow.replace('        postgres-version: ["15", "18"]', '        # postgres-version: ["15", "18"]\n        postgres-version: ["15"]')));
  assert.throws(() => validateWorkflow(workflow.replace(`          ${MIGRATION_058}\n`, '')));
});
test('the empty-job CLI and worker gates cannot be moved after job-creating fixtures', () => {
  const job = managedJob(workflow);
  const cli = rootStep(job, CLI).block;
  const worker = rootStep(job, WORKER).block;
  const swapped = workflow.replace(cli, '__CLI_BLOCK__').replace(worker, cli).replace('__CLI_BLOCK__', worker);
  assert.throws(() => validateWorkflow(swapped));
  const invalidation = rootStep(job, MIGRATION_058).block;
  const afterJobs = workflow.replace(cli, '__CLI_BLOCK__').replace(invalidation, cli).replace('__CLI_BLOCK__', invalidation);
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
    assert.doesNotMatch(source, /\b(?:TRUNCATE|DELETE\s+FROM|UPDATE)\s+(?:model_router_saas\.)?saas_platform_(?:initialization|bootstrap)/i);
  }
  assert.match(http, /const providerId = `gateway-e2e-provider-\$\{ids\.label\}`/);
  assert.match(http, /const productId = `gateway-e2e-product-\$\{ids\.label\}`/);
  assert.match(http, /await identity\.issueBootstrapToken\(\)/);
});

test('six additional complete roots run on both versions only after the old required matrix in independent fresh services', () => {
  validateWorkflow(workflow); // All previous roots/order/role contracts remain required.
  validateIsolatedWorkflow(workflow);
  validateProvisioning(provisioning); // Same normal CLI/manifests, not copied migration SQL.
  validateIsolatedRunner(isolatedRunner);
});

test('each isolated root and helper must remain an explicit strict root and an executable matrix selection', () => {
  for (const [selector, root, httpFixture] of isolatedGates) {
    assert.throws(() => validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) =>
      body.replace(`"${selector}"`, '"missing-gate"'))));
    assert.throws(() => validateIsolatedRunner(isolatedRunner.replace(
      `  '${selector}': { root: '${root}', httpFixture: ${httpFixture} },\n`, '')));
    assert.throws(() => validateIsolatedRunner(isolatedRunner.replace(root, 'tests/not-an-executable-root.ts')));
    assert.throws(() => validateIsolatedRunner(isolatedRunner.replace(
      `root: '${root}', httpFixture: ${httpFixture}`, `root: '${root}', httpFixture: ${!httpFixture}`)));
  }
  for (const root of isolatedStrictRoots) {
    assert.throws(() => validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) => body.replace(`          ${root}\n`, ''))));
  }
  for (const option of ['--strict', '--module NodeNext', '--moduleResolution NodeNext', '--lib ES2023', '--types node']) {
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
    [`        run: node --import tsx ${ISOLATED_RUNNER}`, `        if: false\n        run: node --import tsx ${ISOLATED_RUNNER}`],
    [`        run: node --import tsx ${ISOLATED_RUNNER}`, `        continue-on-error: true\n        run: node --import tsx ${ISOLATED_RUNNER}`],
    ['"${{ matrix.gate }}"', '"${{ matrix.gate }}" || true'],
  ] as const) {
    assert.throws(() => validateIsolatedWorkflow(changeIsolatedJob(workflow, (body) => body.replace(original, replacement))));
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
    ['model_router_saas_ci\'', 'model_router_test_reused\''],
    ['model_router_saas_ci\'', 'model_router_saas_ci?options=unsafe\''],
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
    [`'--test', '${HTTP}'`, `'--test', '--test-name-pattern=one-case', '${HTTP}'`],
    ["  await runtimeProbes();", "  // await runtimeProbes();"],
    ["  run('node', ['--import', 'tsx', '--test', gate.root]);", "  // required gate omitted"],
    ['if (result.error || result.status !== 0)', 'if (false)'],
    ['process.exitCode ??= 1', 'process.exitCode = 0'],
    ['virgin.length !== 1 || virgin[0]?.virgin !== true', 'false'],
    ['await verifySaasRuntimeDatabasePrivileges(tx, family)', 'await Promise.resolve()'],
    ['await verifyCredentialValidationWorkerRuntimePrivileges(tx)', 'await Promise.resolve()'],
    ["  phase = 'required_root';", "  run('node', ['-e', 'UPDATE saas_platform_state SET initialized = FALSE']);\n  phase = 'required_root';"],
  ] as const) {
    const changed = isolatedRunner.replace(original, replacement);
    assert.notEqual(changed, isolatedRunner);
    assert.throws(() => validateIsolatedRunner(changed));
  }
});

test('actual source prerequisites distinguish three successful-HTTP dependencies from three independent fixtures', () => {
  const cancellation = read(cancellationFixture);
  assert.match(cancellation, /ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci'/);
  assert.match(cancellation, /cancellation PG requires prior successful real HTTP fixture for each mode/);
  assert.doesNotMatch(cancellation, /\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
  for (const [, root, needsHttp] of isolatedGates) {
    const source = read(root);
    assert.ok(existsSync(resolve(repository, root)));
    if (needsHttp) {
      assert.match(source, /pre-dispatch-postgres-fixture\.js/);
      assert.match(source, /await cancellationFixture\(/);
    } else {
      assert.match(source, /await seedFixture\(/);
      assert.doesNotMatch(source, /pre-dispatch-postgres-fixture\.js|\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
    }
  }
  const terminal = read(terminalReplayFixture);
  assert.match(terminal, /export async function seedFixture\(/);
  assert.doesNotMatch(terminal, /\b(?:issueBootstrapToken|bootstrapPlatformAdmin)\s*\(/);
});
