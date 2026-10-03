import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  createSaasDatabase, SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
  verifyCredentialValidationWorkerRuntimePrivileges,
} from '../../src/saas/db/index.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../../src/saas/db/credential-validation-worker-schema-readiness.js';
import type { SaasDatabase, SqlExecutor } from '../../src/saas/db/types.js';
import { DEPLOYMENT_ENV_VARS } from '../../src/saas/deployment.js';
import { credentialValidationTargetEvidenceSha256 } from '../../src/saas/supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from '../../src/saas/supply/types.js';

// Source CLI entry, not an SDK startup seam. Luna must provision a dedicated
// PG15/18 database with current migrations and exact role templates beforehand.
// This root never creates databases/roles, migrates, reads provider credentials,
// changes role/search_path, rewrites history or approves catalog metadata.
const REQUIRED = 'MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED';
const roleConfig = [
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL', 'model_router_saas_validation_worker'],
] as const;
const anyConfigured = roleConfig.some(([name]) => process.env[name] !== undefined);
const JOBS = 'model_router_saas.saas_tenant_provider_credential_validation_jobs';
const CLAIM_QUERY = 'SELECT id, tenant_id, account_id, credential_id, credential_version ' +
  'FROM saas_tenant_provider_credential_validation_jobs ' +
  "WHERE (status = 'queued' AND available_at <= clock_timestamp()) " +
  "OR (status = 'leased' AND lease_until <= clock_timestamp()) " +
  'ORDER BY available_at, created_at, id LIMIT 1';
// pg_stat_activity truncates long queries. This distinctive prefix observes
// the real completed CLI probe; it never substitutes for the complete probe's
// result validation, which the normal production entry performs unchanged.
const PRIVILEGE_PROBE_PREFIX = SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.replace(/\s+/g, ' ').trim().slice(0, 256);
const START_EVENTS = [
  'targets.import', 'targets.factory.purpose-only', 'kms.import', 'kms.factory',
  'kms.ready.1.enter', 'kms.ready.1.exit', 'kms.ready.2.enter', 'kms.ready.2.exit',
] as const;
const EVENT_CODES = new Set<string>([...START_EVENTS, 'kms.decrypt.unexpected', 'kms.close']);

class GateFailure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GateFailure(message);
}
function safeFailure(cause: unknown, phase: string): Error {
  if (cause instanceof GateFailure) return cause;
  let code: unknown;
  try { if (cause && typeof cause === 'object' && 'code' in cause) code = cause.code; } catch { /* discard cause */ }
  return new Error(`CLI validation-worker PostgreSQL proof failed at ${phase}; details redacted` +
    (typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? ` (SQLSTATE ${code}).` : '.'));
}

interface RoleTarget { readonly url: string; readonly database: string; readonly identity: string; readonly role: string; }
function roleTarget([name, role]: typeof roleConfig[number]): RoleTarget {
  const value = process.env[name]?.trim();
  check(value, `${name} is required for the real CLI PostgreSQL gate`);
  let parsed: URL;
  let username: string;
  let database: string;
  try {
    parsed = new URL(value);
    username = decodeURIComponent(parsed.username);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch { throw new GateFailure(`${name} must be a valid PostgreSQL URL; value redacted`); }
  check(['postgres:', 'postgresql:'].includes(parsed.protocol), `${name} must be PostgreSQL`);
  check(username === role, `${name} must use its exact restricted-test managed identity`);
  check(parsed.search === '' && parsed.hash === '', `${name} must not contain connection overrides or a fragment`);
  const hostname = parsed.hostname.toLowerCase();
  const port = Number(parsed.port);
  // Exact existing validation/FIN/054 target boundary; private CIDRs, localhost,
  // sockets, real database names and user loopback 5432/6432 are not accepted.
  const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
  const local = ['127.0.0.1', '[::1]'].includes(hostname) && Boolean(parsed.port) &&
    Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port) &&
    (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
  check(ci || local, `${name} must use designated CI postgres or an explicit nondefault-port disposable loopback target`);
  return { url: value, database, identity: `${hostname}:${port}/${database}`, role };
}
function disposableTargets(): { migrator: RoleTarget; worker: RoleTarget } {
  const migrator = roleTarget(roleConfig[0]);
  const worker = roleTarget(roleConfig[1]);
  check(migrator.identity === worker.identity, 'both CLI gate identities must address the same disposable database');
  // The parent uses real pools too. Do not let libpq-style client defaults add
  // hidden session/transport overrides or substitute a missing URL credential.
  const clientDefaults = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'PGOPTIONS', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGAPPNAME', 'PGSERVICE', 'PGSERVICEFILE'];
  check(!clientDefaults.some((name) => process.env[name] !== undefined),
    'clear ambient PostgreSQL client overrides before the explicit disposable CLI gate; values redacted');
  return { migrator, worker };
}

async function verifyIdentity(database: SaasDatabase, target: RoleTarget): Promise<void> {
  const result = await database.query<{ expected_principal: boolean; expected_database: boolean;
    direct_session: boolean; restricted: boolean; supported_version: boolean; managed_path: boolean }>(
    `SELECT current_user = $1 AS expected_principal, current_database() = $2 AS expected_database,
            current_user = session_user AS direct_session,
            NOT role.rolsuper AND NOT role.rolbypassrls AS restricted,
            (current_setting('server_version_num')::integer / 10000) IN (15, 18) AS supported_version,
            current_schema() = 'model_router_saas' AND current_setting('search_path') = 'model_router_saas' AS managed_path
       FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`, [target.role, target.database]);
  check(result.rows.length === 1 && Object.values(result.rows[0]!).every((value) => value === true),
    'real direct PG15/18 sessions must match the guarded identities/database/managed search path');
}
async function ledgerDenied(worker: SaasDatabase): Promise<void> {
  let denied = false;
  try { await worker.query('SELECT version FROM model_router_saas.saas_schema_migrations LIMIT 1'); }
  catch (cause) { denied = !!cause && typeof cause === 'object' && 'code' in cause && cause.code === '42501'; }
  check(denied, 'the real worker must not read the migration ledger (expected SQLSTATE 42501)');
}
async function queueAndCatalogUnchanged(migrator: SaasDatabase): Promise<void> {
  const result = await migrator.query<{ empty_queue: boolean; no_target_approval: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM ${JOBS}) AS empty_queue,
            NOT EXISTS (SELECT 1 FROM model_router_saas.saas_provider_capabilities
              WHERE provider_id = 'custom' AND product_id = 'custom-openai'
                AND model = 'fixture/cli-metadata-only') AS no_target_approval`);
  check(result.rows[0]?.empty_queue === true,
    'reserve a fresh dedicated empty-job database; never consume or delete another fixture\'s jobs');
  check(result.rows[0]?.no_target_approval === true,
    'test metadata must not create or masquerade as database catalog approval');
}
async function workerSessionCount(observer: SqlExecutor): Promise<number> {
  const result = await observer.query<{ sessions: number }>(
    `SELECT count(*)::integer AS sessions FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND usename = current_user AND backend_type = 'client backend'`);
  check(typeof result.rows[0]?.sessions === 'number', 'real worker session observation must be available');
  return result.rows[0].sessions;
}

interface Fixture { readonly directory: string; readonly events: string; readonly permit: string;
  readonly targetsModule: string; readonly kmsModule: string; readonly config: string; }
function nativeFixture(): Fixture {
  // Created only by test execution, never by source authoring. Owned mkdtemp
  // directory, exclusive mode-0600 files; no URL, credential or env is written.
  let directory: string;
  try { directory = mkdtempSync(join(tmpdir(), 'model-router-cli-worker-pg-')); }
  catch (cause) { throw safeFailure(cause, 'owned-native-fixture-directory'); }
  const events = join(directory, 'safe-events.txt');
  const permit = join(directory, 'permit-ready');
  const targetsModule = join(directory, 'targets.mjs');
  const kmsModule = join(directory, 'worker-kms.mjs');
  const config = join(directory, 'must-not-read-local-config.json');
  const descriptor: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'> = {
    providerId: 'custom', productId: 'custom-openai', credentialType: 'api-key',
    model: 'fixture/cli-metadata-only', endpoint: 'chat-completions', capabilityVersion: 1,
    protocol: 'openai-compatible', authProfile: 'openai-bearer-v1',
    baseUrl: 'https://cli-validation.example.invalid/v1/', approvalReference: 'test-only-cli-metadata-not-catalog-approval',
    expiresAt: null,
  };
  const binding: ApprovedCredentialValidationTarget = {
    ...descriptor, evidenceSha256: credentialValidationTargetEvidenceSha256(descriptor),
  };
  const journal = `import { appendFileSync } from 'node:fs';\n` +
    `const mark = (code) => appendFileSync(${JSON.stringify(events)}, code + '\\n', { encoding: 'utf8', mode: 0o600 });\n`;
  try {
    writeFileSync(events, '', { flag: 'wx', mode: 0o600 });
    writeFileSync(config, '{not-local-json', { flag: 'wx', mode: 0o600 });
    writeFileSync(targetsModule, journal + `
mark('targets.import');
export function createCredentialValidationTargets(options) {
  const property = options && Object.getOwnPropertyDescriptor(options, 'purpose');
  if (arguments.length !== 1 || !options || Object.getPrototypeOf(options) !== Object.prototype || !Object.isFrozen(options) ||
      Reflect.ownKeys(options).length !== 1 || !property || !('value' in property) ||
      property.value !== 'credential-validation-target-metadata-v1') {
    throw new Error('Test metadata factory must receive one frozen purpose-only argument');
  }
  // In-process operator code is trusted, not sandboxed. This proves the actual
  // factory argument has NO env/DB/KMS/job/tenant/header/fetch capabilities;
  // it does not claim Node process.env or the filesystem are inaccessible.
  mark('targets.factory.purpose-only');
  return [${JSON.stringify(binding)}];
}
`, { flag: 'wx', mode: 0o600 });
    writeFileSync(kmsModule, journal + `
import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';
mark('kms.import');
const permit = ${JSON.stringify(permit)};
function waitForPermit() {
  return new Promise((resolve, reject) => {
    let done = false;
    const watcher = watch(dirname(permit), () => { if (existsSync(permit)) finish(); });
    const timer = setTimeout(() => finish(new Error('Test KMS ready permit timed out')), 30000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer); watcher.close();
      if (error) reject(error); else resolve();
    }
    watcher.on('error', () => finish(new Error('Test KMS ready permit observation failed')));
    if (existsSync(permit)) finish();
  });
}
export function createCredentialValidationWorkerUnsealingKms(options) {
  if (arguments.length !== 1 || !options || Object.getPrototypeOf(options) !== Object.prototype || !Object.isFrozen(options) ||
      Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options, 'env') ||
      !Object.isFrozen(options.env)) throw new Error('Test worker KMS factory contract mismatch');
  mark('kms.factory');
  let checks = 0;
  let closed = false;
  // LOCAL TEST ONLY, never cloud KMS/IAM evidence. An empty queue must never
  // decrypt a credential: reject instead of making any provider dispatch possible.
  const testOnlyKey = Buffer.alloc(32, 0x35);
  return {
    decryptDataKey() {
      mark('kms.decrypt.unexpected');
      throw new Error('Empty-queue CLI fixture must not decrypt credentials');
    },
    async checkReady() {
      checks += 1;
      if (checks > 2 || closed) throw new Error('Test worker KMS lifecycle mismatch');
      mark('kms.ready.' + checks + '.enter');
      if (checks === 1) await waitForPermit();
      mark('kms.ready.' + checks + '.exit');
    },
    close() {
      if (closed) throw new Error('Test worker KMS closed more than once');
      closed = true; testOnlyKey.fill(0); mark('kms.close');
    },
  };
}
`, { flag: 'wx', mode: 0o600 });
    return { directory, events, permit, targetsModule, kmsModule, config };
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true });
    throw safeFailure(cause, 'owned-native-fixture');
  }
}
function events(fixture: Fixture): string[] {
  const content = readFileSync(fixture.events, 'utf8');
  check(Buffer.byteLength(content) <= 4096, 'native module event journal must stay bounded');
  const codes = content.trim() === '' ? [] : content.trim().split('\n');
  check(codes.every((code) => EVENT_CODES.has(code)), 'native module journal must contain only known safe phase codes');
  return codes;
}
function permitReady(fixture: Fixture): void {
  if (!existsSync(fixture.permit)) writeFileSync(fixture.permit, 'ready', { flag: 'wx', mode: 0o600 });
}

interface CliExit { readonly code: number | null; readonly signal: NodeJS.Signals | null; }
interface OutputProjection { readonly stdoutEmpty: boolean; readonly stderrEmpty: boolean;
  readonly privilegeDenied: boolean; readonly sensitiveOutput: boolean; readonly overflow: boolean; }
interface CliChild { readonly process: ChildProcess; readonly exit: Promise<CliExit>;
  alive(): boolean; projection(): OutputProjection; }
function startCli(fixture: Fixture, targets: ReturnType<typeof disposableTargets>): CliChild {
  // Do not inherit NODE_OPTIONS, PG defaults, E2E migrator URL, real credentials,
  // provider/Redis/gateway config or arbitrary headers. The real CLI selects the
  // managed worker role and forwards only this intentionally constructed env.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production', TZ: 'UTC', NO_COLOR: '1',
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl]: targets.worker.url,
    [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule]: pathToFileURL(fixture.kmsModule).href,
    [DEPLOYMENT_ENV_VARS.saas.credentialValidationTargetsModule]: pathToFileURL(fixture.targetsModule).href,
    [DEPLOYMENT_ENV_VARS.saas.deploymentId]: 'cli-validation-pg-fixture',
    [DEPLOYMENT_ENV_VARS.saas.environmentId]: 'test',
  };
  const child = spawn(process.execPath,
    ['--import', 'tsx', resolve('src/cli/index.ts'), 'start', '--role', 'credential-validation-worker', '--config', fixture.config],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  let spawnFailed = false;
  let finished = false;
  const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const next = (stream === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
    if (Buffer.byteLength(next) > 64 * 1024) overflow = true;
    if (stream === 'stdout') stdout = next.slice(0, 64 * 1024);
    else stderr = next.slice(0, 64 * 1024);
  };
  child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));
  child.on('error', () => { spawnFailed = true; });
  const exit = new Promise<CliExit>((done) => child.once('close', (code, signal) => {
    finished = true; done({ code, signal });
  }));
  return {
    process: child, exit,
    alive: () => !spawnFailed && !finished && child.pid !== undefined && child.exitCode === null && child.signalCode === null,
    projection: () => {
      const output = `${stdout}\n${stderr}`;
      // Never attach raw stdout/stderr, environment, URLs, module bodies or
      // errors to TAP diagnostics/assertion operands, even on a failed child.
      return {
        stdoutEmpty: stdout.trim() === '', stderrEmpty: stderr.trim() === '',
        privilegeDenied: stderr.includes('Managed SaaS credential-validation worker database privileges are unsafe'),
        sensitiveOutput: /(?:postgres(?:ql)?:\/\/|https?:\/\/)/i.test(output) ||
          output.includes(targets.worker.url) || output.includes(targets.migrator.url) ||
          output.includes(Buffer.alloc(32, 0x35).toString('hex')) || output.includes(Buffer.alloc(32, 0x35).toString('base64')),
        overflow,
      };
    },
  };
}
async function until<T>(description: string, observe: () => Promise<T | undefined>, child?: CliChild,
  timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (child) check(child.alive(), `real CLI exited before ${description}; child output redacted`);
    const value = await observe();
    if (value !== undefined) return value;
    await delay(20); // bounded polling of actual markers/backend facts, not sleep-as-readiness
  } while (Date.now() < deadline);
  throw new GateFailure(`timed out observing ${description}; child/SQL details redacted`);
}
async function boundedExit(child: CliChild, timeoutMs = 10_000): Promise<CliExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([child.exit, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GateFailure('real CLI did not exit within the bounded cleanup deadline')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function disposeChild(child: CliChild | undefined, fixture: Fixture): Promise<void> {
  let permitFailed = false;
  try { permitReady(fixture); } catch { permitFailed = true; }
  try {
    if (child) {
      if (child.alive()) child.process.kill('SIGTERM');
      try { await boundedExit(child, 5_000); }
      catch {
        // Failure-only cleanup of this exact spawned child. Forced termination
        // can never satisfy the successful SIGTERM/KMS-close/pool-drain proof.
        child.process.kill('SIGKILL');
        await boundedExit(child, 5_000);
        throw new GateFailure('owned CLI required forced termination; graceful cleanup proof failed');
      }
    }
    check(!permitFailed, 'owned native readiness permit cleanup failed; I/O details redacted');
  } catch (cause) { throw safeFailure(cause, 'owned-cli-cleanup'); }
}

async function blockActualClaim(migrator: SaasDatabase, observer: SaasDatabase, child: CliChild,
  fixture: Fixture, expectedPid?: number): Promise<number> {
  return migrator.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '3s'");
    await tx.query("SET LOCAL statement_timeout = '20s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '25s'");
    const holder = await tx.query<{ pid: number; relation: number }>(
      `SELECT pg_backend_pid() AS pid, '${JOBS}'::pg_catalog.regclass::oid::integer AS relation`);
    check(holder.rows[0], 'dedicated owner lock backend must be observable');
    const { pid: ownerPid, relation } = holder.rows[0];
    await tx.query(`LOCK TABLE ${JOBS} IN ACCESS EXCLUSIVE MODE`);
    // First KMS readiness is paused only AFTER real CLI structure/ACL probes.
    // Acquiring the barrier now cannot mistake a blocked readiness query for a
    // worker claim. The second barrier proves a distinct actual polling cycle.
    permitReady(fixture);
    return until('real worker claim blocked by the exact owned relation lock', async () => {
      const blocked = await observer.query<{ pid: number }>(
        `SELECT activity.pid FROM pg_catalog.pg_stat_activity AS activity
          WHERE activity.datname = current_database() AND activity.usename = current_user
            AND activity.backend_type = 'client backend' AND activity.pid <> pg_backend_pid()
            AND activity.pid <> $1 AND activity.state = 'active' AND activity.wait_event_type = 'Lock'
            AND $1::integer = ANY(pg_catalog.pg_blocking_pids(activity.pid))
            AND btrim(regexp_replace(activity.query, '[[:space:]]+', ' ', 'g')) = $3
            AND EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS waiting
              JOIN pg_catalog.pg_locks AS holding ON holding.locktype = waiting.locktype
                AND holding.database = waiting.database AND holding.relation = waiting.relation
              WHERE waiting.pid = activity.pid AND waiting.locktype = 'relation'
                AND waiting.relation = $2::oid AND waiting.mode = 'AccessShareLock' AND NOT waiting.granted
                AND holding.pid = $1 AND holding.mode = 'AccessExclusiveLock' AND holding.granted)`,
        [ownerPid, relation, CLAIM_QUERY]);
      check(blocked.rows.length <= 1, 'exclusive empty-queue fixture must have exactly one CLI worker backend');
      const pid = blocked.rows[0]?.pid;
      if (pid !== undefined && expectedPid !== undefined) check(pid === expectedPid,
        'the second claim must belong to the same real CLI worker backend');
      return pid;
    }, child);
  });
}
async function observeCommit(observer: SaasDatabase, child: CliChild, pid: number): Promise<void> {
  await until('successful empty-queue worker transaction COMMIT', async () => {
    const result = await observer.query<{ committed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND usename = current_user
          AND state = 'idle' AND xact_start IS NULL AND btrim(query) = 'COMMIT') AS committed`, [pid]);
    return result.rows[0]?.committed === true ? true : undefined;
  }, child);
}
async function observeReadyBackend(observer: SaasDatabase, child: CliChild): Promise<number> {
  return until('same-role real CLI completed privilege probe before native KMS readiness', async () => {
    const result = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()
          AND backend_type = 'client backend' AND state = 'idle' AND xact_start IS NULL
          AND left(btrim(regexp_replace(query, '[[:space:]]+', ' ', 'g')), length($1::text)) = $1`,
      [PRIVILEGE_PROBE_PREFIX]);
    check(result.rows.length <= 1, 'the real CLI readiness probe must have exactly one distinct worker backend');
    return result.rows[0]?.pid;
  }, child);
}

// Canonical ACL entries preserve grantor/grantee/options, ignoring harmless ACL
// array order. This is scope evidence, not a full schema-compatibility manifest.
async function scopeDigest(migrator: SaasDatabase): Promise<string> {
  const acls = await migrator.query(
    `WITH objects(kind, identity, owner, acl) AS (
       SELECT 'relation', relation.oid::text, relation.relowner, relation.relacl
         FROM pg_catalog.pg_class AS relation JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'model_router_saas'
       UNION ALL SELECT 'column', attribute.attrelid::text || ':' || attribute.attnum::text, relation.relowner, attribute.attacl
         FROM pg_catalog.pg_attribute AS attribute JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'model_router_saas' AND attribute.attnum > 0 AND NOT attribute.attisdropped
       UNION ALL SELECT 'routine', routine.oid::text, routine.proowner, routine.proacl
         FROM pg_catalog.pg_proc AS routine JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname = 'model_router_saas'
       UNION ALL SELECT 'namespace', oid::text, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = 'model_router_saas'
     ) SELECT kind, identity, owner, acl IS NULL AS default_acl,
       coalesce((SELECT jsonb_agg(jsonb_build_array(grantor, grantee, privilege_type, is_grantable)
         ORDER BY grantor, grantee, privilege_type, is_grantable) FROM pg_catalog.aclexplode(objects.acl)), '[]'::jsonb) AS entries
       FROM objects ORDER BY kind, identity`);
  const ledger = await migrator.query('SELECT version, name, checksum FROM model_router_saas.saas_schema_migrations ORDER BY version');
  const roles = await migrator.query(`SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname ~ '^model_router_saas_' ORDER BY oid`);
  const memberships = await migrator.query(`SELECT roleid, member, grantor, admin_option FROM pg_catalog.pg_auth_members
    WHERE roleid IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname ~ '^model_router_saas_')
       OR member IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname ~ '^model_router_saas_') ORDER BY roleid, member, grantor`);
  return createHash('sha256').update(JSON.stringify([acls.rows, ledger.rows, roles.rows, memberships.rows])).digest('hex');
}
async function verifyRestorableColumnGrant(migrator: SaasDatabase): Promise<void> {
  const result = await migrator.query<{ exact_owner_grant: boolean }>(
    `SELECT relation.relowner = owner.oid
       AND NOT pg_catalog.has_table_privilege(worker.oid, relation.oid, 'SELECT')
       AND pg_catalog.has_column_privilege(worker.oid, relation.oid, attribute.attnum, 'SELECT')
       AND (SELECT count(*) = 1 FROM pg_catalog.aclexplode(attribute.attacl) AS entry WHERE entry.grantee = worker.oid)
       AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(attribute.attacl) AS entry
         WHERE entry.grantee = worker.oid AND entry.grantor = owner.oid
           AND entry.privilege_type = 'SELECT' AND NOT entry.is_grantable) AS exact_owner_grant
     FROM pg_catalog.pg_class AS relation JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
     JOIN pg_catalog.pg_roles AS owner ON owner.rolname = current_user
     JOIN pg_catalog.pg_roles AS worker ON worker.rolname = 'model_router_saas_validation_worker'
     WHERE namespace.nspname = 'model_router_saas' AND relation.relname = 'saas_provider_capabilities'
       AND attribute.attname = 'evidence_sha256' AND NOT attribute.attisdropped`);
  check(result.rows.length === 1 && result.rows[0]?.exact_owner_grant === true,
    'privilege negative requires the exact existing owner-issued, non-grantable worker column SELECT; never widen fixture authority');
}
async function negativePreflightScope(migrator: SaasDatabase, observer: SaasDatabase): Promise<string> {
  try {
    check(await workerSessionCount(observer) === 1, 'finish/drain the first CLI before the isolated privilege negative');
    await queueAndCatalogUnchanged(migrator);
    await verifyRestorableColumnGrant(migrator);
    return await scopeDigest(migrator);
  } catch (cause) { throw safeFailure(cause, 'one-column-negative-preflight'); }
}

test('standard production CLI: native metadata/decrypt-only KMS and restricted real PostgreSQL worker lifecycle', {
  timeout: 120_000,
  skip: process.env[REQUIRED] !== '1' && !anyConfigured
    ? `offline: set ${REQUIRED}=1 and both explicit validation E2E role URLs for the required real CLI gate` : false,
}, async (t) => {
  // All input guards run before opening a pool or creating native fixture files.
  const targets = disposableTargets();
  check(existsSync(resolve('src/cli/index.ts')), 'run this gate from the model-router repository root');
  const migrator = createSaasDatabase({ connectionString: targets.migrator.url, max: 1 });
  const observer = createSaasDatabase({ connectionString: targets.worker.url, max: 1 });
  let phase = 'preflight';
  try {
    await verifyIdentity(migrator, targets.migrator);
    await verifyIdentity(observer, targets.worker);
    await migrator.verifySchema(); // dynamic complete current registry; no migrate/repair
    await ledgerDenied(observer);
    await verifyCredentialValidationWorkerSchemaReadiness(observer);
    await verifyCredentialValidationWorkerRuntimePrivileges(observer);
    check(await workerSessionCount(observer) === 1, 'dedicate the target to this gate; no existing worker sessions may be consumed');
    await queueAndCatalogUnchanged(migrator);
    const baseline = await scopeDigest(migrator);

    await t.test('real native CLI completes two empty claim cycles and SIGTERM drains KMS and database', async () => {
      const fixture = nativeFixture();
      let child: CliChild | undefined;
      let localPhase = 'native-cli-spawn';
      try {
        child = startCli(fixture, targets);
        const running = child;
        localPhase = 'native-module-order';
        await until('native KMS first readiness entry after purpose-only metadata factory', async () =>
          events(fixture).includes('kms.ready.1.enter') ? true : undefined, running);
        check(JSON.stringify(events(fixture)) === JSON.stringify(START_EVENTS.slice(0, 5)),
          'actual metadata import/factory must precede KMS import/factory/first readiness');
        const readyPid = await observeReadyBackend(observer, running);
        localPhase = 'first-real-claim';
        const pid = await blockActualClaim(migrator, observer, running, fixture, readyPid);
        await observeCommit(observer, running, pid);
        check(JSON.stringify(events(fixture)) === JSON.stringify(START_EVENTS),
          'both real KMS readiness checks must complete before the real worker claim');
        localPhase = 'second-real-claim';
        await blockActualClaim(migrator, observer, running, fixture, pid);
        await observeCommit(observer, running, pid);
        check(running.alive(), 'normal CLI must remain alive after real empty-queue polling');
        localPhase = 'sigterm-cleanup';
        check(running.process.kill('SIGTERM'), 'send SIGTERM only to the exact owned live CLI process');
        const result = await boundedExit(running);
        check(result.code === 0 && result.signal === null, 'SIGTERM must finish through runtime cleanup, not default signal death');
        check(JSON.stringify(events(fixture)) === JSON.stringify([...START_EVENTS, 'kms.close']),
          'KMS closes exactly once with no decrypt/provider path on the empty queue');
        const output = running.projection();
        check(output.stdoutEmpty && output.stderrEmpty && !output.sensitiveOutput && !output.overflow,
          'successful child stdout/stderr must stay empty and contain no URL/key/env projection');
        await until('real CLI worker PostgreSQL connections drained', async () =>
          await workerSessionCount(observer) === 1 ? true : undefined);
        await queueAndCatalogUnchanged(migrator);
        check(await scopeDigest(migrator) === baseline, 'successful CLI must leave managed ACL/roles/ledger scope unchanged');
        check(!existsSync(join(fixture.directory, 'logs.sqlite')), 'managed CLI must not initialize local SQLite/config');
        t.diagnostic('safe proof: native factory purpose-only; real restricted PG claims committed twice; SIGTERM closed KMS and drained pool; queue/catalog/ACL/ledger unchanged');
      } catch (cause) { throw safeFailure(cause, localPhase); }
      finally {
        try { await disposeChild(child, fixture); }
        finally { rmSync(fixture.directory, { recursive: true, force: true }); }
      }
    });

    await t.test('one missing worker metadata SELECT rejects before either native module imports and exact ACL is restored', async () => {
      const before = await negativePreflightScope(migrator, observer);
      const fixture = nativeFixture();
      let child: CliChild | undefined;
      let restoreRequired = false;
      let localPhase = 'one-column-revoke';
      try {
        // Flag before the statement so an unknown response cannot skip exact
        // restoration. Only the owner-proved original non-grantable SELECT is
        // restored; no app role override, membership or additional grant exists.
        restoreRequired = true;
        await migrator.query('REVOKE SELECT (evidence_sha256) ON model_router_saas.saas_provider_capabilities FROM model_router_saas_validation_worker');
        const absent = await observer.query<{ missing: boolean }>(`SELECT NOT pg_catalog.has_column_privilege(current_user,
          'model_router_saas.saas_provider_capabilities', 'evidence_sha256', 'SELECT') AS missing`);
        check(absent.rows[0]?.missing === true, 'dedicated column revoke must be effective before the child starts');
        localPhase = 'native-cli-privilege-rejection';
        child = startCli(fixture, targets);
        const result = await boundedExit(child);
        const output = child.projection();
        check(result.code !== null && result.code !== 0 && result.signal === null,
          'real CLI must reject the missing required worker privilege and exit without a signal');
        check(output.privilegeDenied && output.stdoutEmpty && !output.sensitiveOutput && !output.overflow,
          'privilege refusal must use the existing safe public error without leaking URL/key/env');
        check(events(fixture).length === 0, 'real structure/privilege preflight must reject before metadata AND KMS native module import');
        await until('failed CLI worker PostgreSQL connections drained', async () =>
          await workerSessionCount(observer) === 1 ? true : undefined);
        await queueAndCatalogUnchanged(migrator);
        t.diagnostic('safe proof: missing one required column SELECT refused before native module imports; no credential/provider dispatch');
      } catch (cause) { throw safeFailure(cause, localPhase); }
      finally {
        try {
          await disposeChild(child, fixture);
        } finally {
          try {
            if (restoreRequired) {
              await migrator.query('GRANT SELECT (evidence_sha256) ON model_router_saas.saas_provider_capabilities TO model_router_saas_validation_worker');
              check(await scopeDigest(migrator) === before,
                'restore the exact original grantor/grantee/options and all captured managed ACL/roles/ledger scope');
              await migrator.verifySchema();
              await verifyCredentialValidationWorkerSchemaReadiness(observer);
              await verifyCredentialValidationWorkerRuntimePrivileges(observer);
              t.diagnostic('safe proof: exact original ACL restored; scope and current registry unchanged; restricted readiness verified');
            }
          } catch (cause) { throw safeFailure(cause, 'exact-column-acl-restoration'); }
          finally { rmSync(fixture.directory, { recursive: true, force: true }); }
        }
      }
    });
    phase = 'final-scope';
    await queueAndCatalogUnchanged(migrator);
    check(await scopeDigest(migrator) === baseline, 'the whole CLI gate must preserve the preflight scope digest');
  } catch (cause) { throw safeFailure(cause, phase); }
  finally {
    const closed = await Promise.allSettled([observer.close(), migrator.close()]);
    check(closed.every((result) => result.status === 'fulfilled'), 'close both owned real PostgreSQL observation/setup pools');
  }
});
