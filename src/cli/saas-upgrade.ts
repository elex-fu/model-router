import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { protectSaasUpgrade, SAAS_BACKUP_POLICY_FILE_ENV, SaasBackupFailure } from '../saas/backup/service.js';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../saas/db/credential-validation-worker-privileges.js';
import { runSaasMigrations, verifySaasMigrations } from '../saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../saas/db/migrations/001_initial_schema.js';
import { verifySaasRuntimeDatabasePrivileges } from '../saas/db/runtime-privileges.js';
import type { SaasDatabasePool, SqlExecutor } from '../saas/db/types.js';
import { DEPLOYMENT_ENV_VARS } from '../saas/deployment.js';
import {
  ALL_APPLICATION_PG_ROLES,
  applyTemplateSql,
  createSaasDeployPool,
  defaultTemplateDir,
  MAIN_TEMPLATE_FILE,
  MIGRATOR_PG_ROLE,
  missingRuntimeGrantSummary,
  parseSaasDeployEnvFile,
  ROLE_PLANS,
  type RolePlan,
  SAAS_DEPLOY_ADMIN_URL_ENV,
  type SaasDeployPoolOptions,
  type SaasDeployRole,
  SaasOpsFailure,
  type ValidatedUrl,
  validateDatabaseUrl,
  WORKER_TEMPLATE_FILE,
} from './saas-deploy-shared.js';
import { type SaasDoctorCheckId, type SaasDoctorResult, saasDoctor } from './saas-doctor.js';

const exec = promisify(execFile);

/**
 * `saas:upgrade` — the in-place managed SaaS upgrade orchestration (DOps plan
 * §5). Short-stoppage rolling upgrade, not an online hot upgrade:
 *
 *   [1] pre          — migration-audit semantics (no drift: the applied
 *                      ledger must be a clean prefix of the release registry;
 *                      the strict full-registry verifySaasMigrations runs when
 *                      the ledger is already at the release head) + a doctor
 *                      subset (PG / per-role probes / migration count) called
 *                      as a library
 *   [2] backup-point — require verified PostgreSQL protection and a recent
 *                      passing isolated restore receipt before migrating
 *   [3] migrate      — explicit runSaasMigrations as the migrator login
 *                      (transactional; a failure rolls back and stops everything)
 *   [4] roles        — replay both idempotent role templates (administrator)
 *   [5] verify       — the three runtime privilege probes (fail-closed gate)
 *   [6] restart      — rolling workload restart via a pluggable mechanism
 *                      (compose / systemd / manual; --dry-run prints the plan)
 *   [7] post-check   — the doctor subset again + an optional single smoke
 *                      request (--smoke-url, expects 200, skipped when unset)
 *   [8] report       — pre/post registry versions, measured downtime window,
 *                      per-step wall-clock
 *
 * Backup coverage (honesty note): `backup:create` is the offline V2
 * configuration/secrets/control/telemetry (SQLite) backup for local-mode
 * deployments. It does NOT back up the managed SaaS PostgreSQL database. For
 * a PG-backed deployment MODEL_ROUTER_SAAS_BACKUP_POLICY_FILE selects either
 * a snapshot-consistent pg_dump with verified encrypted offsite retention or
 * freshly verified externally managed PITR. Both require KMS recovery evidence
 * and a recent restore drill. A registry anchor alone never permits migration.
 *
 * Rollback (plan §5.3 — explicit, never automatic, never a down-migration):
 * `--rollback-to <registry version>` refuses the down-migration reading and
 * prints the documented backup-restore path (restore + old-image restart)
 * only. The migration registry is append-only; no schema-reversal SQL exists.
 *
 * Red lines: fail-closed per step; the product process never migrates; no
 * credential or secret value is ever printed — child-process output that may
 * embed connection strings is withheld even on failure.
 */

export const SAAS_UPGRADE_RESTART_MECHANISM_ENV = 'MODEL_ROUTER_SAAS_UPGRADE_RESTART_MECHANISM' as const;
export const SAAS_UPGRADE_BACKUP_DIR_ENV = 'MODEL_ROUTER_SAAS_UPGRADE_BACKUP_DIR' as const;
export const SAAS_UPGRADE_BACKUP_COMMAND_ENV = 'MODEL_ROUTER_SAAS_UPGRADE_BACKUP_COMMAND' as const;
export const SAAS_UPGRADE_COMPOSE_DIR_ENV = 'MODEL_ROUTER_SAAS_UPGRADE_COMPOSE_DIR' as const;
export const SAAS_UPGRADE_BACKUP_FILE_ENV = 'MODEL_ROUTER_SAAS_UPGRADE_BACKUP_FILE' as const;

export type SaasUpgradeStepName =
  | 'pre'
  | 'backup-point'
  | 'migrate'
  | 'roles'
  | 'verify'
  | 'restart'
  | 'post-check'
  | 'report';

export type SaasUpgradeStepStatus = 'ok' | 'skipped' | 'failed';

export interface SaasUpgradeStepRecord {
  readonly step: SaasUpgradeStepName;
  readonly status: SaasUpgradeStepStatus;
  readonly durationMs: number;
  readonly detail: string;
}

export type SaasUpgradeFailureCode =
  | 'INVALID_OPTIONS'
  | 'ENV_FILE_UNREADABLE'
  | 'ENV_FILE_INVALID'
  | 'MISSING_DECLARATION'
  | 'INVALID_DATABASE_URL'
  | 'PRE_FAILED'
  | 'BACKUP_FAILED'
  | 'MIGRATE_FAILED'
  | 'ROLES_FAILED'
  | 'VERIFY_FAILED'
  | 'RESTART_FAILED'
  | 'POST_CHECK_FAILED'
  | 'SMOKE_FAILED'
  | 'REPORT_FAILED';

export interface SaasUpgradeCommandOptions {
  envFile?: string;
  smokeUrl?: string;
  dryRun?: boolean;
  verbose?: boolean;
  /** Rollback mode: print the documented backup-restore path for this registry version. */
  rollbackTo?: string;
  /** Explicit opt-in for a loopback disposable database or trusted local tunnel. */
  allowLocalPlaintext?: boolean;
}

export interface SaasUpgradeCommandDependencies {
  env?: NodeJS.ProcessEnv;
  createPool?: (connectionString: string, options: SaasDeployPoolOptions) => SaasDatabasePool;
  runMigrations?: (pool: SaasDatabasePool) => Promise<void>;
  verifyMigrations?: (pool: SaasDatabasePool) => Promise<void>;
  verifyRuntimeRole?: (role: SaasDeployRole, executor: SqlExecutor) => Promise<void>;
  /** Doctor subset as a library (never by shelling the CLI). */
  doctor?: (role: SaasDeployRole, env: NodeJS.ProcessEnv) => Promise<SaasDoctorResult>;
  runBackup?: (context: SaasUpgradeBackupContext) => Promise<SaasUpgradeBackupOutcome>;
  execCommand?: (
    command: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  fileSize?: (path: string) => number | null;
  fetchSmoke?: (url: string, timeoutMs: number) => Promise<{ status: number }>;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  /** Test seam; defaults to a real timer sleep. */
  sleep?: (ms: number) => Promise<void>;
  writeLine?: (line: string) => void;
}

export interface SaasUpgradeCommandResult {
  format: 'saas-upgrade-command-v1';
  status: 'upgraded' | 'dry-run' | 'rollback-plan' | 'failed';
  exitCode: 0 | 1;
  steps: readonly SaasUpgradeStepRecord[];
  failure: { code: SaasUpgradeFailureCode } | null;
  registryVersions: { before: number | null; after: number | null };
  downtimeWindowMs: number | null;
}

export interface SaasUpgradeBackupContext {
  readonly version: number;
  readonly admin: ValidatedUrl;
  readonly env: NodeJS.ProcessEnv;
  readonly allowLocalPlaintext?: boolean;
}

export interface SaasUpgradeBackupOutcome {
  readonly status: 'ok' | 'skipped';
  readonly detail: string;
}

class SaasUpgradeFailure extends SaasOpsFailure {
  constructor(code: SaasUpgradeFailureCode, message: string) {
    super(code, message);
  }
}

export type SaasUpgradeRestartMechanism = 'manual' | 'compose' | 'systemd';

export interface SaasUpgradeRestartAction {
  readonly label: string;
  /** Executed command; `null` marks a print-only action (manual mechanism). */
  readonly command: readonly string[] | null;
  readonly cwd?: string;
  readonly health?: { readonly kind: 'compose-service' | 'systemd-unit'; readonly target: string };
}

export interface SaasUpgradeRestartPlan {
  readonly mechanism: SaasUpgradeRestartMechanism;
  readonly actions: readonly SaasUpgradeRestartAction[];
}

const RESTART_SERVICES: readonly { service: string; unit: string; role: SaasDeployRole }[] = [
  { service: 'control-plane', unit: 'model-router-saas-control-plane.service', role: 'control-plane' },
  { service: 'gateway', unit: 'model-router-saas-gateway.service', role: 'gateway' },
  {
    service: 'credential-validation-worker',
    unit: 'model-router-saas-credential-validation-worker.service',
    role: 'credential-validation-worker',
  },
];
const RESTART_HEALTH_TIMEOUT_MS = 180_000;
const RESTART_POLL_INTERVAL_MS = 2_000;
const SMOKE_TIMEOUT_MS = 15_000;

/** Doctor subset per plan §5.2 [1]/[7]: PG, probes, migration count. */
const DOCTOR_SUBSET_CHECKS: Readonly<Record<SaasDeployRole, readonly SaasDoctorCheckId[]>> = {
  'control-plane': ['pg-migrations', 'role-privileges'],
  gateway: ['pg-migrations', 'role-privileges'],
  // The worker role has no migration-ledger access by design; its pg-migrations
  // doctor check is a structural warn, so the subset covers its probe only.
  'credential-validation-worker': ['role-privileges'],
};

function shellJoin(command: readonly string[]): string {
  return command
    .map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(' ');
}

async function defaultExecCommand(
  command: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  try {
    const result = await exec(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { status: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
    if (typeof failure.code === 'number') {
      // execFile rejects with the child's numeric exit code in `code` on a
      // non-zero exit; spawn failures (ENOENT, timeout) carry string codes
      // and must keep rejecting so callers can tell them apart.
      return { status: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
    throw error;
  }
}

async function defaultFetchSmoke(url: string, timeoutMs: number): Promise<{ status: number }> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status };
}

/**
 * The legacy directory/command settings do not prove offsite retention or
 * recovery. Production upgrades now use the explicit SaaS backup policy.
 * The second argument is retained for compatibility with existing callers.
 */
export async function defaultRunBackup(
  context: SaasUpgradeBackupContext,
  _tools: {
    execCommand: SaasUpgradeCommandDependencies['execCommand'];
    fileSize: (path: string) => number | null;
  },
): Promise<SaasUpgradeBackupOutcome> {
  try {
    return await protectSaasUpgrade(context.env, context.admin, context.allowLocalPlaintext);
  } catch (error) {
    throw new SaasUpgradeFailure(
      'BACKUP_FAILED',
      error instanceof SaasBackupFailure
        ? `${error.code}: ${error.message}`
        : 'PostgreSQL backup protection could not be verified; sensitive details withheld',
    );
  }
}

export function buildRestartPlan(
  mechanism: SaasUpgradeRestartMechanism,
  env: NodeJS.ProcessEnv,
): SaasUpgradeRestartPlan {
  if (mechanism === 'compose') {
    const composeDir = env[SAAS_UPGRADE_COMPOSE_DIR_ENV]?.trim() || 'deploy/compose';
    return {
      mechanism,
      actions: RESTART_SERVICES.map((entry) => ({
        label: entry.service,
        command: ['docker', 'compose', 'up', '-d', '--no-deps', entry.service],
        cwd: composeDir,
        health: { kind: 'compose-service' as const, target: entry.service },
      })),
    };
  }
  if (mechanism === 'systemd') {
    return {
      mechanism,
      actions: RESTART_SERVICES.map((entry) => ({
        label: entry.unit,
        command: ['systemctl', 'restart', entry.unit],
        health: { kind: 'systemd-unit' as const, target: entry.unit },
      })),
    };
  }
  return {
    mechanism: 'manual',
    actions: RESTART_SERVICES.map((entry) => ({
      label: entry.service,
      command: null,
    })),
  };
}

function printRestartPlan(plan: SaasUpgradeRestartPlan, writeLine: (line: string) => void): void {
  writeLine(
    `  restart mechanism: ${plan.mechanism}${plan.mechanism === 'manual' ? ' — the sequence below is printed for the operator to execute; per-instance health gating between steps is the responsibility of the operator' : ''}`,
  );
  for (const action of plan.actions) {
    if (plan.mechanism === 'compose') {
      writeLine(`  - ${action.label}: docker compose up -d --no-deps ${action.label} (then wait for container health)`);
      if (action.label === 'gateway') {
        writeLine(
          '      note: compose recreates every gateway replica together; for per-replica rolling on a scaled deployment, recreate containers one at a time',
        );
      }
    } else if (plan.mechanism === 'systemd') {
      writeLine(
        `  - ${action.label}: systemctl restart ${action.label} (then wait for systemctl is-active ${action.label})`,
      );
    } else {
      writeLine(
        `  - ${action.label}: compose: docker compose up -d --no-deps ${action.label} | systemd: systemctl restart model-router-saas-${action.label}.service`,
      );
    }
  }
}

interface RegistryState {
  readonly head: number;
  readonly applied: number;
}

async function readRegistryHead(pool: SaasDatabasePool): Promise<RegistryState> {
  const result = await pool.query<{ head?: unknown; applied?: unknown }>(
    'SELECT coalesce(max(version), 0)::text AS head, count(*)::text AS applied FROM saas_schema_migrations',
  );
  const head = Number(result.rows[0]?.head);
  const applied = Number(result.rows[0]?.applied);
  if (!Number.isSafeInteger(head) || head < 0 || !Number.isSafeInteger(applied) || applied < 0) {
    throw new SaasUpgradeFailure('PRE_FAILED', 'unable to read the SaaS migration registry head');
  }
  return { head, applied };
}

interface AppliedLedgerRow {
  version?: unknown;
  name?: unknown;
  checksum?: unknown;
}

/** Mirrors the checksum in src/saas/db/migrate.ts (which is not modified by this command). */
function migrationChecksum(migration: { name: string; sql: string }): string {
  return createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
}

/**
 * The pre-upgrade no-drift gate (saas:migration-audit semantics adapted to the
 * upgrade start state): the applied ledger must be a CLEAN PREFIX of this
 * release's registry — every applied row matches the registry entry at its
 * position (version, name, checksum), with no unknown versions and no gaps.
 * `verifySaasMigrations` cannot be used here because it (correctly, for the
 * product runtime) requires the FULL release registry, while an upgrade
 * legitimately starts one or more migrations behind.
 */
async function verifyUpgradeBaseline(pool: SaasDatabasePool): Promise<RegistryState> {
  const result = await pool.query<AppliedLedgerRow>(
    'SELECT version, name, checksum FROM saas_schema_migrations ORDER BY version ASC',
  );
  const ordered = [...SAAS_MIGRATIONS].sort((left, right) => left.version - right.version);
  const rows = result.rows;
  if (rows.length > ordered.length) {
    throw new SaasUpgradeFailure(
      'PRE_FAILED',
      'migration drift: the ledger contains more rows than this release registry',
    );
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = ordered[index];
    const version = Number(row?.version);
    if (
      !Number.isSafeInteger(version) ||
      version !== expected.version ||
      row?.name !== expected.name ||
      row?.checksum !== migrationChecksum(expected)
    ) {
      throw new SaasUpgradeFailure(
        'PRE_FAILED',
        `migration drift: applied ledger row ${index + 1} does not match this release registry (expected version ${expected.version}); reconcile the schema before upgrading`,
      );
    }
  }
  const head = rows.length === 0 ? 0 : Number(rows[rows.length - 1].version);
  return { head, applied: rows.length };
}

interface DoctorSubsetOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

async function runDoctorSubset(
  roles: readonly SaasDeployRole[],
  options: {
    /** 'pre': role-privileges enforced, pg-migrations informational unless already at head. 'post': everything enforced. */
    mode: 'pre' | 'post';
    /** Rerun after a partial upgrade: the ledger is already at the release head. */
    allowPrivilegeHeal: boolean;
    doctor: (role: SaasDeployRole, env: NodeJS.ProcessEnv) => Promise<SaasDoctorResult>;
    env: NodeJS.ProcessEnv;
  },
): Promise<DoctorSubsetOutcome> {
  const lines: string[] = [];
  for (const role of roles) {
    const result = await options.doctor(role, options.env);
    lines.push(`doctor ${role}:`);
    let roleOk = true;
    for (const checkId of DOCTOR_SUBSET_CHECKS[role]) {
      const check = result.checks.find((candidate) => candidate.check === checkId);
      if (check === undefined) {
        lines.push(`  ${checkId}: not reported by saas:doctor`);
        roleOk = false;
        continue;
      }
      if (check.level === 'pass') {
        lines.push(`  ${checkId}: pass — ${check.detail}`);
        continue;
      }
      if (options.allowPrivilegeHeal) {
        // Rerun after a partial upgrade: the ledger is already at the release
        // head, so any missing grant is exactly what the roles step replays
        // (including the ledger access the doctor's own pg-migrations check
        // needs); the verify step below stays the fail-closed gate.
        lines.push(
          `  ${checkId}: ${check.level} (pre-heal tolerated — registry already at the release head) — ${check.detail}`,
        );
        continue;
      }
      if (checkId === 'pg-migrations' && options.mode === 'pre') {
        // Before the migration the ledger is deliberately behind the release
        // registry, so the doctor's full-registry check cannot pass by design;
        // the authoritative pre-upgrade no-drift gate is the prefix
        // verification in the pre step.
        lines.push(
          `  ${checkId}: ${check.level} (informational pre-upgrade — the full-registry check applies after the migration; the prefix no-drift verification is authoritative here) — ${check.detail}`,
        );
        continue;
      }
      lines.push(`  ${checkId}: ${check.level} — ${check.detail} (hint: ${check.hint})`);
      roleOk = false;
    }
    if (!roleOk) return { ok: false, lines };
  }
  return { ok: true, lines };
}

function printRollbackPath(
  writeLine: (line: string) => void,
  requested: number,
  head: number | null,
  env: NodeJS.ProcessEnv,
): void {
  writeLine('saas:upgrade rollback — REFUSED: down-migration');
  writeLine(
    '  Down-migrations do not exist and saas:upgrade never emits schema-reversal SQL: the migration registry is append-only by discipline (docs/deployment-ops-efficiency-plan-2026-10-17.md §5.3).',
  );
  writeLine(
    `  Requested registry version: ${requested}${head === null ? '' : `; current registry head: ${head}`}${head !== null && requested >= head ? ' (the registry is already at or beyond the requested version; nothing to roll back)' : ''}.`,
  );
  writeLine('  The documented rollback path is backup-restore ONLY (restore + old-image restart):');
  const backupFile = env[SAAS_UPGRADE_BACKUP_FILE_ENV]?.trim();
  writeLine(
    '    1. Stop the workloads (compose: docker compose stop control-plane gateway credential-validation-worker; systemd: systemctl stop model-router-saas.target).',
  );
  writeLine(
    `    2. Restore the pre-upgrade backup point (pg_dump custom archive taken at upgrade step "backup-point"${backupFile ? `: ${backupFile}` : '; set MODEL_ROUTER_SAAS_UPGRADE_BACKUP_FILE to print it here'}).`,
  );
  writeLine(`       pg_restore --format=custom --exit-on-error --dbname <database> ${backupFile || '<backup-file>'}`);
  writeLine(
    '       Note: backup:create/backup:restore cover only the local V2 configuration/secrets/telemetry and do NOT restore the managed SaaS PostgreSQL database.',
  );
  writeLine(
    '    3. Replay the role templates: psql -X -v ON_ERROR_STOP=1 --file=deploy/managed-saas-postgres-roles.sql (and deploy/managed-saas-validation-worker-role-grants.sql).',
  );
  writeLine(
    '    4. Restart the workloads pinned to the previous release image (compose: the prior image tag; systemd: the previous package).',
  );
  writeLine(
    '  saas:upgrade does not execute this path automatically: rollback is an explicit operator action (plan §5.3).',
  );
}

/**
 * Runs the upgrade orchestration. Operational failures never throw; the
 * result carries the exit code for the CLI registration.
 */
export async function saasUpgrade(
  options: SaasUpgradeCommandOptions = {},
  dependencies: SaasUpgradeCommandDependencies = {},
): Promise<SaasUpgradeCommandResult> {
  const steps: SaasUpgradeStepRecord[] = [];
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const verbose = options.verbose === true;
  const now = dependencies.now ?? Date.now;

  const result: SaasUpgradeCommandResult = {
    format: 'saas-upgrade-command-v1',
    status: 'failed',
    exitCode: 1,
    steps,
    failure: null,
    registryVersions: { before: null, after: null },
    downtimeWindowMs: null,
  };

  const openPools: SaasDatabasePool[] = [];
  let currentStep: SaasUpgradeStepName = 'pre';
  let stepStartedAt = now();
  const beginStep = (step: SaasUpgradeStepName, title: string): void => {
    currentStep = step;
    stepStartedAt = now();
    writeLine(`saas:upgrade ${step} — ${title}`);
  };
  const finishStep = (status: SaasUpgradeStepStatus, detail: string): number => {
    const durationMs = now() - stepStartedAt;
    steps.push({ step: currentStep, status, durationMs, detail });
    writeLine(`saas:upgrade ${currentStep} ${status} in ${durationMs}ms${detail ? ` — ${detail}` : ''}`);
    return durationMs;
  };
  const verboseLine = (line: string): void => {
    if (verbose) writeLine(`  manual equivalent: ${line}`);
  };

  const createPool =
    dependencies.createPool ??
    ((connectionString: string, poolOptions: SaasDeployPoolOptions) =>
      createSaasDeployPool(connectionString, poolOptions));
  const runMigrations = dependencies.runMigrations ?? ((pool: SaasDatabasePool) => runSaasMigrations(pool));
  const verifyMigrations = dependencies.verifyMigrations ?? ((pool: SaasDatabasePool) => verifySaasMigrations(pool));
  const readFileImpl = dependencies.readFile ?? (async (path: string) => readFile(path, 'utf8'));
  const execCommandImpl = dependencies.execCommand ?? defaultExecCommand;
  const fileSizeImpl =
    dependencies.fileSize ??
    ((path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    });

  let environment: Record<string, string | undefined> = dependencies.env ?? process.env;
  const resolvedUrls = new Map<string, ValidatedUrl>();
  const envUrl = (name: string, context: { requireUser?: string; forbidUsers?: readonly string[] }): ValidatedUrl => {
    let validated = resolvedUrls.get(name);
    if (!validated) {
      validated = validateDatabaseUrl(environment[name], {
        name,
        requireUser: context.requireUser,
        forbidUsers: context.forbidUsers,
        allowLocalPlaintext: options.allowLocalPlaintext === true,
      });
      resolvedUrls.set(name, validated);
    }
    return validated;
  };
  const roleUrl = (plan: RolePlan): ValidatedUrl => envUrl(plan.urlEnvName, { requireUser: plan.pgRole });
  const migratorUrl = (): ValidatedUrl =>
    envUrl(DEPLOYMENT_ENV_VARS.saas.databaseUrl, { requireUser: MIGRATOR_PG_ROLE });
  const adminUrl = (): ValidatedUrl => envUrl(SAAS_DEPLOY_ADMIN_URL_ENV, { forbidUsers: ALL_APPLICATION_PG_ROLES });

  try {
    // ---------- option validation ----------
    if (options.rollbackTo !== undefined) {
      if (options.smokeUrl !== undefined) {
        throw new SaasUpgradeFailure(
          'INVALID_OPTIONS',
          '--rollback-to is a standalone rollback-path mode and cannot be combined with --smoke-url',
        );
      }
      if (!/^[0-9]+$/.test(options.rollbackTo)) {
        throw new SaasUpgradeFailure(
          'INVALID_OPTIONS',
          `REFUSED: --rollback-to must be a plain registry version integer; "${options.rollbackTo}" looks like a down-migration request. Down-migrations do not exist (append-only registry discipline); rollback is the documented backup-restore path only — see saas:upgrade --help.`,
        );
      }
    }
    if (options.smokeUrl !== undefined) {
      try {
        const parsed = new URL(options.smokeUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      } catch {
        throw new SaasUpgradeFailure('INVALID_OPTIONS', '--smoke-url must be an explicit http(s) URL');
      }
    }

    // ---------- environment ----------
    if (options.envFile !== undefined) {
      let text: string;
      try {
        text = await readFileImpl(options.envFile);
      } catch {
        throw new SaasUpgradeFailure('ENV_FILE_UNREADABLE', `Unable to read the env file: ${options.envFile}`);
      }
      const parsed = parseSaasDeployEnvFile(text, options.envFile);
      environment = { ...environment, ...parsed };
    }
    const allowLocalPlaintext = options.allowLocalPlaintext === true;
    const mechanismRaw = environment[SAAS_UPGRADE_RESTART_MECHANISM_ENV]?.trim() || 'manual';
    if (!['manual', 'compose', 'systemd'].includes(mechanismRaw)) {
      throw new SaasUpgradeFailure(
        'INVALID_OPTIONS',
        `${SAAS_UPGRADE_RESTART_MECHANISM_ENV} must be one of manual, compose, systemd (got "${mechanismRaw}")`,
      );
    }
    const mechanism = mechanismRaw as SaasUpgradeRestartMechanism;

    const verifyRuntimeRole =
      dependencies.verifyRuntimeRole ??
      (async (role: SaasDeployRole, executor: SqlExecutor) => {
        if (role === 'credential-validation-worker') {
          await verifyCredentialValidationWorkerRuntimePrivileges(executor);
          return;
        }
        await verifySaasRuntimeDatabasePrivileges(executor, role === 'gateway' ? 'gateway' : 'control_plane');
      });

    const doctorRun =
      dependencies.doctor ??
      (async (role: SaasDeployRole, doctorEnv: NodeJS.ProcessEnv): Promise<SaasDoctorResult> => {
        // The doctor output is captured, not printed: the upgrade surfaces the
        // subset verdicts itself so its report stays the single narrative.
        const sink: string[] = [];
        return await saasDoctor(
          { role },
          {
            env: doctorEnv,
            createPool: (connectionString: string) =>
              createPool(connectionString, {
                allowLocalPlaintext,
                applicationName: 'model-router-saas-upgrade-doctor',
              }),
            writeLine: (line) => sink.push(line),
          },
        );
      });

    // ---------- rollback mode ----------
    if (options.rollbackTo !== undefined) {
      const requested = Number(options.rollbackTo);
      writeLine(`saas:upgrade rollback — requested registry version ${requested}`);
      let head: number | null = null;
      if (!options.dryRun) {
        // The rollback runbook must print even when the deployment
        // declarations are incomplete; the head is best-effort context.
        try {
          const migrator = migratorUrl();
          const pool = createPool(migrator.url.toString(), {
            allowLocalPlaintext,
            applicationName: 'model-router-saas-upgrade-rollback',
          });
          openPools.push(pool);
          head = (await readRegistryHead(pool)).head;
        } catch {
          head = null;
        }
      }
      printRollbackPath(writeLine, requested, head, environment);
      result.status = 'rollback-plan';
      result.exitCode = 0;
      return result;
    }

    writeLine(
      `saas:upgrade — pre-checks, backup point, ${options.dryRun ? '(dry-run) ' : ''}explicit migration, role template replay, runtime probes, ${mechanism} restart${options.smokeUrl ? ', smoke request' : ''}`,
    );

    // ---------- [1] pre ----------
    beginStep('pre', 'migration-audit semantics (no drift) + doctor subset (as a library)');
    const admin = adminUrl();
    const migrator = migratorUrl();
    for (const plan of ROLE_PLANS) roleUrl(plan);
    const migratorPool = createPool(migrator.url.toString(), {
      allowLocalPlaintext,
      applicationName: 'model-router-saas-upgrade-pre',
    });
    openPools.push(migratorPool);
    // verifySaasMigrations (the product runtime gate) requires the FULL
    // release registry and cannot pass one migration behind; the pre-upgrade
    // no-drift gate is the clean-prefix verification instead. When the ledger
    // is already at the release head, the strict full-registry verification
    // runs as well.
    let preState: RegistryState;
    try {
      preState = await verifyUpgradeBaseline(migratorPool);
    } catch (error) {
      throw error instanceof SaasOpsFailure
        ? error
        : new SaasUpgradeFailure('PRE_FAILED', 'unable to read the SaaS migration ledger');
    }
    result.registryVersions.before = preState.head;
    const alreadyAtHead = preState.applied === SAAS_MIGRATIONS.length;
    if (alreadyAtHead) {
      try {
        await verifyMigrations(migratorPool);
      } catch (error) {
        throw new SaasUpgradeFailure(
          'PRE_FAILED',
          `the ledger is at the release head but fails the strict registry verification${error instanceof Error && error.message ? `: ${error.message}` : ''}; reconcile the schema before upgrading`,
        );
      }
    }
    const doctorOutcome = await runDoctorSubset(
      ROLE_PLANS.map((plan) => plan.role),
      {
        mode: 'pre',
        allowPrivilegeHeal: alreadyAtHead,
        doctor: doctorRun,
        env: environment,
      },
    );
    for (const line of doctorOutcome.lines) writeLine(`  ${line}`);
    if (!doctorOutcome.ok) {
      throw new SaasUpgradeFailure(
        'PRE_FAILED',
        `the doctor subset is not green (see the per-role lines above); registry head ${preState.head}, applied ${preState.applied}/${SAAS_MIGRATIONS.length} — fix the deployment before upgrading`,
      );
    }
    finishStep(
      'ok',
      `no migration drift (clean registry prefix); registry head ${preState.head} (${preState.applied}/${SAAS_MIGRATIONS.length} applied); doctor subset green`,
    );

    // ---------- dry-run ----------
    if (options.dryRun) {
      writeLine('saas:upgrade dry-run — zero mutations from this point. Planned steps:');
      writeLine(
        `  - backup-point: require ${SAAS_BACKUP_POLICY_FILE_ENV}, fresh PostgreSQL backup/PITR evidence, KMS recovery evidence, and a recent passing restore receipt; record registry head ${preState.head}`,
      );
      writeLine(`  - migrate: runSaasMigrations as ${MIGRATOR_PG_ROLE} (transactional; failure rolls back and stops)`);
      writeLine(`  - roles: replay ${MAIN_TEMPLATE_FILE} and ${WORKER_TEMPLATE_FILE} (administrator)`);
      writeLine('  - verify: the three runtime privilege probes (fail-closed)');
      const plan = buildRestartPlan(mechanism, environment);
      writeLine(`  - restart (${mechanism}):`);
      printRestartPlan(plan, writeLine);
      writeLine(
        `  - post-check: doctor subset${options.smokeUrl ? ` + smoke request ${options.smokeUrl} (expects 200)` : ' (no --smoke-url; smoke skipped)'}`,
      );
      for (const skipped of [
        'backup-point',
        'migrate',
        'roles',
        'verify',
        'restart',
        'post-check',
        'report',
      ] as const) {
        steps.push({ step: skipped, status: 'skipped', durationMs: 0, detail: 'dry-run' });
      }
      result.status = 'dry-run';
      result.exitCode = 0;
      result.registryVersions.after = preState.head;
      printReport(writeLine, steps, {
        before: preState.head,
        after: preState.head,
        downtimeWindowMs: null,
        downtimeNote: 'dry-run: no mutations, no downtime window',
        anchor: preState.head,
        backupDetail: 'dry-run',
      });
      return result;
    }

    // ---------- [2] backup-point ----------
    beginStep('backup-point', 'rollback anchor + PostgreSQL backup point');
    const runBackup = dependencies.runBackup ?? defaultRunBackup;
    const backup = await runBackup(
      { version: preState.head, admin, env: environment, allowLocalPlaintext },
      { execCommand: execCommandImpl, fileSize: fileSizeImpl },
    );
    if (backup.status !== 'ok') {
      throw new SaasUpgradeFailure(
        'BACKUP_FAILED',
        'PostgreSQL backup protection was skipped; a registry anchor does not permit an upgrade',
      );
    }
    finishStep(backup.status, `anchor registry head ${preState.head}; ${backup.detail}`);

    // ---------- [3] migrate ----------
    const windowStart = now();
    beginStep('migrate', 'explicit registered migrations as the migrator login');
    verboseLine('node dist/cli/index.js saas:migrate (MODEL_ROUTER_SAAS_DATABASE_URL = the migrator login)');
    try {
      await runMigrations(migratorPool);
    } catch {
      throw new SaasUpgradeFailure(
        'MIGRATE_FAILED',
        'SaaS database migrations failed; the migration transaction rolled back and nothing else was touched — fix the migration and re-run saas:upgrade',
      );
    }
    const postMigrateState = await readRegistryHead(migratorPool);
    result.registryVersions.after = postMigrateState.head;
    finishStep(
      'ok',
      postMigrateState.head === preState.head
        ? `registry already at head ${postMigrateState.head} (no pending migrations)`
        : `registry head ${preState.head} → ${postMigrateState.head} (${postMigrateState.applied}/${SAAS_MIGRATIONS.length} applied)`,
    );

    // ---------- [4] roles ----------
    beginStep('roles', 'idempotent role template replay (both templates)');
    verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${MAIN_TEMPLATE_FILE} (as the administrator)`);
    verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${WORKER_TEMPLATE_FILE} (as the administrator)`);
    const templateDir = defaultTemplateDir();
    const loadTemplate = async (file: string): Promise<string> => {
      try {
        return await readFileImpl(join(templateDir, file));
      } catch {
        throw new SaasUpgradeFailure('ROLES_FAILED', `Unable to read the role template: ${file}`);
      }
    };
    const adminPool = createPool(admin.url.toString(), {
      allowLocalPlaintext,
      applicationName: 'model-router-saas-upgrade-roles',
    });
    openPools.push(adminPool);
    try {
      await applyTemplateSql(adminPool, await loadTemplate(MAIN_TEMPLATE_FILE));
      await applyTemplateSql(adminPool, await loadTemplate(WORKER_TEMPLATE_FILE));
    } catch {
      throw new SaasUpgradeFailure(
        'ROLES_FAILED',
        'role template replay failed; each template is a single transaction — the database stays migrated and the sequence is safe to re-run saas:upgrade once the template is fixed',
      );
    }
    finishStep('ok', `${MAIN_TEMPLATE_FILE} and ${WORKER_TEMPLATE_FILE} replayed`);

    // ---------- [5] verify ----------
    beginStep('verify', 'runtime privilege probes as each role login');
    const probeResults: string[] = [];
    for (const plan of ROLE_PLANS) {
      const pool = createPool(roleUrl(plan).url.toString(), {
        allowLocalPlaintext,
        applicationName: `model-router-saas-upgrade-verify-${plan.role}`,
      });
      openPools.push(pool);
      const identity = await pool.query<{ current_user: unknown }>('SELECT current_user');
      const currentUser = identity.rows[0]?.current_user;
      if (currentUser !== plan.pgRole) {
        throw new SaasUpgradeFailure(
          'VERIFY_FAILED',
          `${plan.urlEnvName} authenticated as ${String(currentUser)}; expected ${plan.pgRole}`,
        );
      }
      try {
        await verifyRuntimeRole(plan.role, pool);
        probeResults.push(`${plan.pgRole}: probe green`);
        writeLine(`  ${plan.pgRole}: runtime privilege probe green`);
      } catch {
        const missing = await missingRuntimeGrantSummary(plan.role, pool);
        const named = missing.length > 0 ? ` Missing grants: ${missing.join(', ')}.` : '';
        throw new SaasUpgradeFailure(
          'VERIFY_FAILED',
          `the ${plan.pgRole} runtime privilege probe failed.${named} The database is migrated; re-run saas:upgrade to replay the role templates, or review deploy/${MAIN_TEMPLATE_FILE} and deploy/${WORKER_TEMPLATE_FILE} against the probe manifests.`,
        );
      }
    }
    finishStep('ok', probeResults.join('; '));

    // ---------- [6] restart ----------
    beginStep('restart', `rolling workload restart (${mechanism})`);
    const restartPlan = buildRestartPlan(mechanism, environment);
    printRestartPlan(restartPlan, writeLine);
    if (mechanism === 'manual') {
      finishStep(
        'ok',
        'restart sequence printed (manual mechanism); execute it per instance with health gating between steps',
      );
    } else {
      for (const action of restartPlan.actions) {
        if (action.command === null) continue;
        writeLine(`  restarting ${action.label}`);
        verboseLine(`(cwd ${action.cwd ?? '.'}) ${shellJoin(action.command)}`);
        const restartResult = await execCommandImpl(action.command, {
          cwd: action.cwd,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          timeoutMs: RESTART_HEALTH_TIMEOUT_MS,
        });
        if (restartResult.status !== 0) {
          throw new SaasUpgradeFailure(
            'RESTART_FAILED',
            `the restart command for ${action.label} failed (exit ${restartResult.status}); output withheld — inspect the workload, then re-run saas:upgrade (every step before the restart is idempotent)`,
          );
        }
        if (action.health) {
          await waitForRestartHealth(action.health, {
            execCommand: execCommandImpl,
            cwd: action.cwd,
            writeLine,
            now,
            sleep: dependencies.sleep ?? ((ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))),
          });
        }
      }
      finishStep('ok', `${restartPlan.actions.length} workload restart(s) completed with health gates`);
    }
    const windowEnd = now();
    const downtimeWindowMs = windowEnd - windowStart;
    result.downtimeWindowMs = downtimeWindowMs;

    // ---------- [7] post-check ----------
    beginStep('post-check', 'doctor subset + optional smoke request');
    const postDoctor = await runDoctorSubset(
      ROLE_PLANS.map((plan) => plan.role),
      {
        mode: 'post',
        allowPrivilegeHeal: false,
        doctor: doctorRun,
        env: environment,
      },
    );
    for (const line of postDoctor.lines) writeLine(`  ${line}`);
    if (!postDoctor.ok) {
      throw new SaasUpgradeFailure(
        'POST_CHECK_FAILED',
        'the post-upgrade doctor subset is not green (see the per-role lines above); the workloads were restarted — diagnose with saas:doctor, and use saas:upgrade --rollback-to for the documented restore path if needed',
      );
    }
    let smokeDetail = 'smoke skipped (--smoke-url not provided)';
    if (options.smokeUrl !== undefined) {
      const fetchSmoke = dependencies.fetchSmoke ?? defaultFetchSmoke;
      let smoke: { status: number };
      try {
        smoke = await fetchSmoke(options.smokeUrl, SMOKE_TIMEOUT_MS);
      } catch {
        throw new SaasUpgradeFailure('SMOKE_FAILED', `the smoke request to ${options.smokeUrl} could not be completed`);
      }
      if (smoke.status !== 200) {
        throw new SaasUpgradeFailure(
          'SMOKE_FAILED',
          `the smoke request to ${options.smokeUrl} returned HTTP ${smoke.status} (expected 200)`,
        );
      }
      smokeDetail = `smoke request ${options.smokeUrl} returned 200`;
    }
    finishStep('ok', `doctor subset green; ${smokeDetail}`);

    // ---------- [8] report ----------
    beginStep('report', 'summary');
    result.status = 'upgraded';
    result.exitCode = 0;
    printReport(writeLine, steps, {
      before: preState.head,
      after: postMigrateState.head,
      downtimeWindowMs,
      downtimeNote:
        mechanism === 'manual'
          ? 'restart executed manually; window measured to the restart-plan emission'
          : 'window measured from the migrate step start to the last restart health gate',
      anchor: preState.head,
      backupDetail: backup.detail,
    });
    finishStep('ok', 'upgraded');
    return result;
  } catch (error) {
    const failure =
      error instanceof SaasOpsFailure
        ? error
        : new SaasUpgradeFailure(
            stepFailureCode(currentStep),
            process.env.SAAS_UPGRADE_DEBUG === '1'
              ? `${safeFailureMessage(currentStep)} [debug: ${String(error)}]`
              : safeFailureMessage(currentStep),
          );
    steps.push({ step: currentStep, status: 'failed', durationMs: now() - stepStartedAt, detail: failure.message });
    // Shared helpers only throw codes that are members of this command's union.
    result.failure = { code: failure.code as SaasUpgradeFailureCode };
    try {
      writeLine(`saas:upgrade failed at step "${currentStep}": ${failure.message}`);
      printStepLines(writeLine, steps);
    } catch {
      // Reporting must not mask the original failure.
    }
    return result;
  } finally {
    for (const pool of openPools) {
      try {
        await pool.end();
      } catch {
        // Cleanup is best-effort once the primary outcome is decided.
      }
    }
  }
}

async function waitForRestartHealth(
  health: { kind: 'compose-service' | 'systemd-unit'; target: string },
  tools: {
    execCommand: SaasUpgradeCommandDependencies['execCommand'];
    cwd?: string;
    writeLine: (line: string) => void;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<void> {
  if (!tools.execCommand) throw new SaasUpgradeFailure('RESTART_FAILED', 'no restart executor is available');
  const deadline = tools.now() + RESTART_HEALTH_TIMEOUT_MS;
  let lastDetail = 'no health observation yet';
  while (tools.now() < deadline) {
    if (health.kind === 'systemd-unit') {
      const result = await tools.execCommand(['systemctl', 'is-active', health.target], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeoutMs: 10_000,
      });
      if (result.status === 0 && result.stdout.trim() === 'active') return;
      lastDetail = `systemctl is-active ${health.target} → exit ${result.status}`;
    } else {
      const listed = await tools.execCommand(['docker', 'compose', 'ps', '-q', health.target], {
        cwd: tools.cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeoutMs: 10_000,
      });
      if (listed.status !== 0) {
        lastDetail = `docker compose ps -q ${health.target} → exit ${listed.status}`;
      } else {
        const ids = listed.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (ids.length === 0) {
          lastDetail = `no containers reported for ${health.target}`;
        } else {
          const inspected = await tools.execCommand(
            ['docker', 'inspect', '--format', '{{.State.Health.Status}}', ...ids],
            { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 10_000 },
          );
          const states = inspected.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          if (inspected.status === 0 && states.length === ids.length && states.every((state) => state === 'healthy')) {
            return;
          }
          lastDetail = `${health.target} container health: ${states.join(', ') || 'unknown'}`;
        }
      }
    }
    await tools.sleep(RESTART_POLL_INTERVAL_MS);
  }
  throw new SaasUpgradeFailure(
    'RESTART_FAILED',
    `${health.target} did not become healthy within ${RESTART_HEALTH_TIMEOUT_MS}ms (${lastDetail}); the database upgrade itself is complete — inspect the workload, then re-run saas:upgrade (every earlier step is idempotent)`,
  );
}

function stepFailureCode(step: SaasUpgradeStepName): SaasUpgradeFailureCode {
  switch (step) {
    case 'pre':
      return 'PRE_FAILED';
    case 'backup-point':
      return 'BACKUP_FAILED';
    case 'migrate':
      return 'MIGRATE_FAILED';
    case 'roles':
      return 'ROLES_FAILED';
    case 'verify':
      return 'VERIFY_FAILED';
    case 'restart':
      return 'RESTART_FAILED';
    case 'post-check':
      return 'POST_CHECK_FAILED';
    default:
      return 'REPORT_FAILED';
  }
}

function safeFailureMessage(step: SaasUpgradeStepName): string {
  switch (step) {
    case 'pre':
      return 'the pre-upgrade checks failed; details were redacted — verify connectivity and the deployment declarations';
    case 'backup-point':
      return 'the backup point could not be taken; nothing was mutated';
    case 'migrate':
      return 'SaaS database migrations failed (the transaction rolled back)';
    case 'roles':
      return 'role template replay failed';
    case 'verify':
      return 'a runtime privilege probe failed';
    case 'restart':
      return 'a workload restart or health gate failed';
    case 'post-check':
      return 'the post-upgrade doctor subset or smoke request failed';
    default:
      return `saas:upgrade failed at step "${step}"`;
  }
}

function printStepLines(writeLine: (line: string) => void, steps: readonly SaasUpgradeStepRecord[]): void {
  writeLine('saas:upgrade steps');
  for (const step of steps) {
    writeLine(
      `  ${step.step.padEnd(13)} ${step.status.padEnd(7)} ${String(step.durationMs).padStart(7)}ms  ${step.detail}`,
    );
  }
}

interface ReportContext {
  readonly before: number | null;
  readonly after: number | null;
  readonly downtimeWindowMs: number | null;
  readonly downtimeNote: string;
  readonly anchor: number;
  readonly backupDetail: string;
}

function printReport(
  writeLine: (line: string) => void,
  steps: readonly SaasUpgradeStepRecord[],
  context: ReportContext,
): void {
  printStepLines(writeLine, steps);
  writeLine(
    `saas:upgrade report — registry versions: before ${context.before ?? '?'} → after ${context.after ?? '?'}; downtime window: ${context.downtimeWindowMs === null ? 'n/a' : `${context.downtimeWindowMs}ms`} (${context.downtimeNote})`,
  );
  writeLine(
    `  rollback anchor: registry head ${context.anchor} (rollback = the documented backup-restore path only; saas:upgrade --rollback-to ${context.anchor} prints it)`,
  );
  writeLine(`  backup point: ${context.backupDetail}`);
}
