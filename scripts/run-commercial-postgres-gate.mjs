#!/usr/bin/env node
// Owns a new initdb cluster OR a new Docker container, and fresh test DBs only.
// Usage: node scripts/run-commercial-postgres-gate.mjs
//        (--pg-bin /path/to/bin | --docker-image postgres:15-alpine)
//        [--suite commercial|composite|all|kimi|platform-access] [--output-dir /new/evidence/dir]
// Or:    ... --test-file tests/path.postgres.integration.test.ts [--worker-role]
// `all` runs the two deterministic gates. `kimi` requires the separate live
// opt-in and credential; this runner never discovers or supplies credentials.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suites = {
  commercial: 'tests/saas/gateway/managed-postgres-commercial-gateway.integration.test.ts',
  composite: 'tests/saas/gateway/composite-resolved-supply-billing.postgres.integration.test.ts',
  kimi: 'tests/integration/kimi-commercial-live.test.ts',
  'platform-access': 'tests/integration/platform-access-first-request-live.test.ts',
};
const options = { pgBin: undefined, dockerImage: undefined, suite: 'commercial', outputDir: undefined,
  testFile: undefined, workerRole: false };
const argumentsList = process.argv.slice(2);
for (let index = 0; index < argumentsList.length; index += 1) {
  const separator = argumentsList[index].indexOf('=');
  const name = separator === -1 ? argumentsList[index] : argumentsList[index].slice(0, separator);
  const inlineValue = separator === -1 ? undefined : argumentsList[index].slice(separator + 1);
  if (name === '--worker-role' && inlineValue === undefined) {
    options.workerRole = true;
    continue;
  }
  const key = { '--pg-bin': 'pgBin', '--docker-image': 'dockerImage', '--suite': 'suite', '--output-dir': 'outputDir',
    '--test-file': 'testFile' }[name];
  if (!key || (!inlineValue && !argumentsList[index + 1])) {
    throw new Error('usage: --pg-bin /path/to/bin OR --docker-image postgres:15-alpine; --suite commercial|composite|all|kimi|platform-access');
  }
  options[key] = inlineValue ?? argumentsList[++index];
}
options.pgBin ??= options.dockerImage ? undefined : process.env.MODEL_ROUTER_TEST_PG_BIN;
if (options.testFile) {
  if (!['commercial', 'custom'].includes(options.suite)) throw new Error('--test-file cannot be combined with a named suite');
  const path = realpathSync(resolve(root, options.testFile));
  const testName = relative(root, path);
  if (!testName.startsWith('tests/') || !/\.test\.(?:ts|mjs)$/.test(testName) || !statSync(path).isFile()) {
    throw new Error('--test-file must name an existing test file inside this repository tests directory');
  }
  options.suite = 'custom';
  suites.custom = testName;
}
if (Boolean(options.pgBin) === Boolean(options.dockerImage) || !Object.hasOwn(suites, options.suite) && options.suite !== 'all') {
  throw new Error('exactly one PostgreSQL backend and a known suite are required');
}
if (options.suite === 'kimi' && (process.env.RUN_KIMI_COMMERCIAL_LIVE !== '1' || !process.env.KIMI_CODE_API_KEY)) {
  throw new Error('the Kimi suite requires explicit RUN_KIMI_COMMERCIAL_LIVE=1 and KIMI_CODE_API_KEY');
}
if (options.suite === 'platform-access' && (process.env.RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE !== '1' || !process.env.KIMI_CODE_API_KEY)) {
  throw new Error('platform-access requires explicit RUN_PLATFORM_ACCESS_FIRST_REQUEST_LIVE=1 and ephemeral KIMI_CODE_API_KEY');
}
const firstRequestLive = options.suite === 'platform-access';
if (firstRequestLive && !existsSync(resolve(root, 'dist/cli/index.js'))) throw new Error('build the current server before platform-access acceptance');
const docker = Boolean(options.dockerImage);
if (docker && !/^postgres:(?:1[5-9]|[2-9][0-9])(?:\.\d+)*(?:-alpine)?$/.test(options.dockerImage)) {
  throw new Error('Docker mode accepts only an explicit PostgreSQL 15+ official image tag');
}
const pgBin = options.pgBin ? resolve(options.pgBin) : undefined;
if (pgBin) for (const binary of ['initdb', 'pg_ctl', 'psql', 'postgres']) {
  if (!existsSync(join(pgBin, binary))) throw new Error(`missing PostgreSQL binary: ${binary}`);
}
const selectedSuites = options.suite === 'all' ? ['commercial', 'composite'] : [options.suite];
const needsWorker = options.workerRole || selectedSuites.includes('kimi') || firstRequestLive;
const outputDir = options.outputDir
  ? resolve(options.outputDir)
  : await mkdtemp(join(tmpdir(), 'model-router-commercial-postgres-'));
if (options.outputDir) await mkdir(outputDir, { recursive: false, mode: 0o700 });
const clusterDir = join(outputDir, 'cluster');
const dataDir = join(clusterDir, 'data');
await mkdir(clusterDir, { recursive: true, mode: 0o700 });

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : null;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  if (!port || [5432, 6432, 53782].includes(port)) return freePort();
  return port;
}

async function sourceSnapshot() {
  // Literal relative import closure, plus the role manifest and dependency lock.
  // This is recorded as a bounded source scope, never as a frozen whole repo.
  const pending = [
    ...selectedSuites.map((suite) => resolve(root, suites[suite])),
    resolve(root, 'src/cli/index.ts'),
    fileURLToPath(import.meta.url),
    resolve(root, 'deploy/managed-saas-postgres-roles.sql'),
    ...(needsWorker ? [resolve(root, 'deploy/managed-saas-validation-worker-role-grants.sql')] : []),
    resolve(root, 'package-lock.json'),
    ...((selectedSuites.includes('kimi') || firstRequestLive) && existsSync(resolve(root, 'dist/cli/index.js'))
      ? [resolve(root, 'dist/cli/index.js')] : []),
  ];
  const hashes = {};
  while (pending.length > 0) {
    const path = pending.pop();
    const name = relative(root, path);
    if (Object.hasOwn(hashes, name)) continue;
    const bytes = await readFile(path);
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    if (!/\.[cm]?[jt]s$/.test(path)) continue;
    const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;
    for (const match of bytes.toString('utf8').matchAll(imports)) {
      const imported = resolve(dirname(path), match[1]);
      const candidates = /\.js$/.test(imported)
        ? [imported.replace(/\.js$/, '.ts'), imported]
        : [imported, `${imported}.ts`, join(imported, 'index.ts')];
      const target = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target) pending.push(target);
    }
  }
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

async function distSnapshot() {
  const hashes = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hashes[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(resolve(root, 'dist'));
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

function tapCounts(output) {
  const counts = {};
  for (const name of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    counts[name] = matches.length === 1 ? Number(matches[0][1]) : null;
  }
  return counts;
}

const summary = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  backend: docker ? 'disposable-docker-container' : 'disposable-initdb-cluster',
  dockerImage: options.dockerImage ?? null,
  dockerImageId: null,
  containerId: null,
  postgresVersion: pgBin ? spawnSync(join(pgBin, 'postgres'), ['--version'], { encoding: 'utf8' }).stdout.trim() : null,
  sourceScope: 'literal relative import closure, runner, role manifest, package-lock.json',
  sourceBefore: await sourceSnapshot(),
  sourceAfter: null,
  distScope: firstRequestLive ? 'complete current dist artifact tree; supervisor must build current candidate before run' : null,
  distBefore: firstRequestLive ? await distSnapshot() : null,
  distAfter: null,
  distChanged: false,
  durability: firstRequestLive ? 'fsync=on;synchronous_commit=on' : 'existing deterministic disposable fixture settings',
  sourceChanges: [],
  port: await freePort(),
  roles: ['model_router_saas_migrator', 'model_router_saas_control_plane', 'model_router_saas_gateway'],
  stages: [],
  suites: [],
  cleanup: { clusterStopped: false, clusterRemoved: false },
  ok: false,
};
let clusterStarted = false;
let interrupted = false;
let activeChild;
let activeOwnedTestGroup = false;
let activeGroupKillTimer;
function terminateActiveChild() {
  if (activeOwnedTestGroup && activeChild?.pid) {
    const pid = activeChild.pid;
    try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    activeGroupKillTimer ??= setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 10_000);
  } else activeChild?.kill('SIGTERM');
}
async function drainOwnedTestGroup(pid) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { process.kill(-pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}
if (needsWorker) summary.roles.push('model_router_saas_validation_worker');
const interrupt = () => {
  interrupted = true;
  terminateActiveChild();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

async function run(stage, command, args, env = process.env, timeoutMs = 180_000) {
  if (interrupted && stage !== 'stop-cluster' && !stage.startsWith('cleanup-')) throw new Error('interrupted');
  const logPath = join(outputDir, `${stage}.log`);
  const log = await open(logPath, 'w', 0o600);
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await new Promise((resolveRun, reject) => {
      const ownedTestGroup = firstRequestLive && stage === 'platform-access-test';
      const child = spawn(command, args, { cwd: root, env, detached: ownedTestGroup, stdio: ['ignore', log.fd, log.fd] });
      activeChild = child;
      activeOwnedTestGroup = ownedTestGroup;
      const timeout = setTimeout(() => terminateActiveChild(), timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', async (code, signal) => {
        clearTimeout(timeout);
        try {
          // Only our detached A0 group; never signal arbitrary process names or old suites.
          if (ownedTestGroup && child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            await drainOwnedTestGroup(child.pid);
          }
          clearTimeout(activeGroupKillTimer);
          activeGroupKillTimer = undefined;
          activeChild = undefined;
          activeOwnedTestGroup = false;
          resolveRun({ code, signal });
        } catch (error) { reject(error); }
      });
    });
  } finally {
    await log.close();
  }
  summary.stages.push({ stage, startedAt, finishedAt: new Date().toISOString(), ...result, log: logPath });
  return result;
}

async function requireStage(stage, command, args, env) {
  const result = await run(stage, command, args, env);
  if (result.code !== 0) throw new Error(`${stage} failed; see ${join(outputDir, `${stage}.log`)}`);
}

function roleUrl(role, database) {
  if (!/^model_router_test_[a-z0-9_]+$/.test(database)) throw new Error('unsafe disposable database name');
  return `postgresql://${role}@127.0.0.1:${summary.port}/${database}`;
}

async function waitForDockerPostgres() {
  const { default: pg } = await import('pg');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !interrupted) {
    const client = new pg.Client({
      connectionString: `postgresql://postgres@127.0.0.1:${summary.port}/postgres?sslmode=disable`,
      connectionTimeoutMillis: 1_000,
      query_timeout: 1_000,
    });
    try {
      await client.connect();
      const result = await client.query('SELECT version() AS version');
      summary.postgresVersion = result.rows[0].version;
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error('owned PostgreSQL container did not become ready');
}

function psqlCommand(database, args) {
  const psqlArgs = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(docker ? 5432 : summary.port),
    '-U', 'postgres', '-d', database, ...args];
  return docker ? ['docker', ['exec', summary.containerId, 'psql', ...psqlArgs]] : [join(pgBin, 'psql'), psqlArgs];
}

async function databaseClockSamples(database) {
  // Read-only timing evidence for cross-clock timestamp guard failures.
  // Keep the host and PostgreSQL clocks unchanged.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: roleUrl('postgres', database), ssl: false });
  const samples = [];
  try {
    await client.connect();
    for (let index = 0; index < 3; index += 1) {
      const before = Date.now();
      const result = await client.query('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms');
      const after = Date.now();
      const server = result.rows[0].now_ms;
      samples.push({ roundTripMs: after - before, offsetLowerMs: server - after, offsetUpperMs: server - before });
    }
    return samples;
  } finally {
    await client.end();
  }
}

try {
  console.log(`Disposable PostgreSQL gate evidence: ${outputDir}`);
  if (docker) {
    const name = `model-router-commercial-pg-${randomUUID()}`;
    await requireStage('create-container', 'docker', ['create', '--pull=never', '--name', name,
      '--label', 'model-router.disposable-commercial-gate=true', '--publish', `127.0.0.1:${summary.port}:5432`,
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', options.dockerImage, '-c', firstRequestLive ? 'fsync=on' : 'fsync=off', '-c', firstRequestLive ? 'synchronous_commit=on' : 'synchronous_commit=off']);
    const id = (await readFile(join(outputDir, 'create-container.log'), 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return an owned container ID');
    summary.containerId = id;
    await requireStage('container-image', 'docker', ['inspect', '--format', '{{.Image}}', id]);
    summary.dockerImageId = (await readFile(join(outputDir, 'container-image.log'), 'utf8')).trim();
    await requireStage('start-cluster', 'docker', ['start', id]);
    await waitForDockerPostgres();
    await requireStage('copy-roles', 'docker', ['cp', resolve(root, 'deploy/managed-saas-postgres-roles.sql'), `${id}:/tmp/commercial-roles.sql`]);
    if (needsWorker) await requireStage('copy-worker-roles', 'docker', ['cp',
      resolve(root, 'deploy/managed-saas-validation-worker-role-grants.sql'), `${id}:/tmp/commercial-worker-roles.sql`]);
  } else {
    await requireStage('initdb', join(pgBin, 'initdb'), [
      '-D', dataDir, '--username=postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--no-locale',
    ]);
    await requireStage('start-cluster', join(pgBin, 'pg_ctl'), [
      '-D', dataDir, '-l', join(outputDir, 'postgres.log'), '-w', '-o',
      `-h 127.0.0.1 -p ${summary.port} -c unix_socket_directories= -c fsync=${firstRequestLive ? 'on' : 'off'} -c synchronous_commit=${firstRequestLive ? 'on' : 'off'} -c log_error_verbosity=verbose`, 'start',
    ]);
  }
  clusterStarted = true;
  for (const suite of selectedSuites) {
    const database = `model_router_test_${suite.replaceAll('-', '_')}_${randomUUID().replaceAll('-', '')}`;
    roleUrl('postgres', database); // Validate before embedding the identifier in CREATE DATABASE.
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PGSSLMODE: 'disable',
      MODEL_ROUTER_SAAS_DATABASE_URL: roleUrl('model_router_saas_migrator', database),
      MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED: '1',
      MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL: roleUrl('model_router_saas_migrator', database),
      MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL: roleUrl('model_router_saas_control_plane', database),
      MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL: roleUrl('model_router_saas_gateway', database),
      ...(needsWorker ? {
        MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL: roleUrl('model_router_saas_validation_worker', database),
        MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL: roleUrl('model_router_saas_migrator', database),
        MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL: roleUrl('model_router_saas_validation_worker', database),
      } : {}),
      ...(suite === 'platform-access' ? { PLATFORM_FIRST_REQUEST_RUNTIME_PARENT: join(outputDir, 'platform-access-runtime') } : {}),
      ...(suite === 'kimi' ? {
        KIMI_COMMERCIAL_EVIDENCE_DIR: join(outputDir, 'kimi-evidence'),
      } : {}),
    };
    if (suite === 'kimi') {
      // Only the new native cluster has a host-readable log while the test runs.
      // Never pass through an unrelated caller-provided PostgreSQL log path.
      if (docker) delete env.KIMI_COMMERCIAL_POSTGRES_LOG;
      else env.KIMI_COMMERCIAL_POSTGRES_LOG = join(outputDir, 'postgres.log');
    }
    await requireStage(`${suite}-create-db`, ...psqlCommand('postgres', ['-c', `CREATE DATABASE ${database}`]));
    const roles = psqlCommand(database, ['-f', docker ? '/tmp/commercial-roles.sql' : resolve(root, 'deploy/managed-saas-postgres-roles.sql')]);
    await requireStage(`${suite}-roles-before`, ...roles);
    await requireStage(`${suite}-migrate`, process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:migrate'], env);
    await requireStage(`${suite}-roles-after`, ...roles);
    if (needsWorker) await requireStage(`${suite}-worker-roles`, ...psqlCommand(database, ['-f',
      docker ? '/tmp/commercial-worker-roles.sql' : resolve(root, 'deploy/managed-saas-validation-worker-role-grants.sql')]));
    const clockSamples = await databaseClockSamples(database);
    const result = await run(`${suite}-test`, process.execPath, [
      '--import', 'tsx', '--test', '--test-reporter=tap', suites[suite],
    ], env, 300_000);
    const counts = tapCounts(await readFile(join(outputDir, `${suite}-test.log`), 'utf8'));
    const ok = result.code === 0 && counts.tests > 0 && counts.pass === counts.tests &&
      counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
    summary.suites.push({ suite, test: suites[suite], database, clockSamples, ...result, counts, ok });
    console.log(`${suite}: ${JSON.stringify({ ...result, counts, ok })}`);
    if (!ok) break;
  }
} catch (error) {
  summary.error = error instanceof Error ? error.message : 'unrecognized runner error';
  console.error(summary.error);
} finally {
  if (docker && summary.containerId) {
    await run('cleanup-postgres-log', 'docker', ['logs', summary.containerId]);
    const stop = await run('stop-cluster', 'docker', ['stop', '--time', '10', summary.containerId]);
    summary.cleanup.clusterStopped = stop.code === 0;
    if (summary.cleanup.clusterStopped) {
      const remove = await run('cleanup-container', 'docker', ['rm', '--volumes', summary.containerId]);
      summary.cleanup.clusterRemoved = remove.code === 0;
    }
  } else if (!docker && (clusterStarted || existsSync(join(dataDir, 'postmaster.pid')))) {
    const stop = await run('stop-cluster', join(pgBin, 'pg_ctl'), ['-D', dataDir, '-w', '-m', 'fast', 'stop']);
    summary.cleanup.clusterStopped = stop.code === 0;
  } else {
    summary.cleanup.clusterStopped = true;
  }
  if (summary.cleanup.clusterStopped && (!docker || !summary.containerId)) {
    await rm(clusterDir, { recursive: true, force: true });
    summary.cleanup.clusterRemoved = true;
  }
  if (docker && summary.cleanup.clusterRemoved) await rm(clusterDir, { recursive: true, force: true });
  if (firstRequestLive) await rm(join(outputDir, 'platform-access-runtime'), { recursive: true, force: true });
  summary.sourceAfter = await sourceSnapshot();
  if (firstRequestLive) {
    summary.distAfter = await distSnapshot();
    summary.distChanged = JSON.stringify(summary.distBefore) !== JSON.stringify(summary.distAfter);
  }
  summary.sourceChanges = [...new Set([
    ...Object.keys(summary.sourceBefore), ...Object.keys(summary.sourceAfter),
  ])].filter((path) => summary.sourceBefore[path] !== summary.sourceAfter[path]);
  summary.finishedAt = new Date().toISOString();
  summary.ok = !summary.error && !interrupted && summary.suites.length === selectedSuites.length &&
    summary.suites.every((suite) => suite.ok) && summary.sourceChanges.length === 0 && !summary.distChanged &&
    summary.cleanup.clusterStopped && summary.cleanup.clusterRemoved;
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`Summary: ${join(outputDir, 'summary.json')} (ok=${summary.ok}, source changes=${summary.sourceChanges.length})`);
  process.exitCode = summary.ok ? 0 : 1;
}
