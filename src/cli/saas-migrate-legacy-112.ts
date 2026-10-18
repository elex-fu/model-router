import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile as fsReadFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../saas/db/credential-validation-worker-privileges.js';
import {
  LEGACY_MAIN_112_COMPAT_PLAN_ID,
  LEGACY_MAIN_112_MIGRATION_CHECKSUM,
  LEGACY_MAIN_112_MIGRATION_NAME,
  LEGACY_MAIN_112_SOURCE_VERSION,
  LEGACY_MAIN_112_TARGET_VERSION,
  type LegacyMain112CompatPlanOutcome,
  runLegacyMain112CompatPlan,
} from '../saas/db/migrate-compat-legacy-112.js';
import { isSaasAuditCatalogBaseline, type SaasAuditCatalogBaseline } from '../saas/db/migration-audit.js';
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
  parseSaasDeployEnvFile,
  ROLE_PLANS,
  SAAS_DEPLOY_ADMIN_URL_ENV,
  type SaasDeployPoolOptions,
  type SaasDeployRole,
  SaasOpsFailure,
  type ValidatedUrl,
  validateDatabaseUrl,
  WORKER_TEMPLATE_FILE,
} from './saas-deploy-shared.js';
import { defaultRunBackup, type SaasUpgradeBackupContext } from './saas-upgrade.js';

const exec = promisify(execFile);

/**
 * `saas:migrate-legacy-112` — the explicit `legacy-main-112-to-129`
 * compatibility plan (core-capability alignment technical plan §5.2).
 *
 * A separate, explicitly-invoked upgrade path for the ONE known history
 * fork: deployments migrated on old main (ledger = shared 001..111 + the
 * fault-classification 112) that the normal migrator correctly refuses
 * because the current registry's 112 is a different migration. The plan:
 *
 *   [1] pre-check     — read-only classification of the FULL ledger (never
 *                       head=112 alone), the release manifest identity, the
 *                       PostgreSQL major, and (when supplied) the reviewed
 *                       source catalog baseline. --dry-run stops here.
 *   [2] prerequisites — operator confirms writes stopped and a restorable
 *                       backup exists (the tool cannot stop workloads); a
 *                       configured backup point is taken when possible.
 *   [3] compat-apply  — the normal migrator's advisory lock; inside ONE
 *                       transaction: re-verify source fingerprints and the
 *                       actual schema, move the old-112 ledger row to 129
 *                       keyed on the exact known name+checksum, apply the
 *                       pending target 112..128 registering their original
 *                       identities, and verify the complete target history,
 *                       key catalog constraints, and data preservation
 *                       (wallet/reservation summaries, sealed-credential
 *                       envelope counts/hashes, key record counts) before
 *                       COMMIT. Any failure rolls back.
 *   [4] receipt       — the audit-only compatibility receipt (JSON +
 *                       checksum). Never a second migration authority.
 *   [5] post          — role template replay + the three runtime privilege
 *                       probes (saas:deploy/saas:upgrade primitives), the
 *                       manual workload restart checklist, optional smoke.
 *
 * Reruns only match the complete source state (re-upgrades) or the complete
 * target state (idempotent no-op). Everything else is refused.
 */

const SMOKE_TIMEOUT_MS = 15_000;

export type SaasMigrateLegacy112StepName =
  | 'pre-check'
  | 'prerequisites'
  | 'compat-apply'
  | 'receipt'
  | 'roles'
  | 'verify'
  | 'restart'
  | 'smoke'
  | 'report';

export type SaasMigrateLegacy112StepStatus = 'ok' | 'skipped' | 'failed';

export interface SaasMigrateLegacy112StepRecord {
  readonly step: SaasMigrateLegacy112StepName;
  readonly status: SaasMigrateLegacy112StepStatus;
  readonly durationMs: number;
  readonly detail: string;
}

export type SaasMigrateLegacy112FailureCode =
  | 'INVALID_OPTIONS'
  | 'ENV_FILE_UNREADABLE'
  | 'ENV_FILE_INVALID'
  | 'MISSING_DECLARATION'
  | 'INVALID_DATABASE_URL'
  | 'PRE_FAILED'
  | 'PREREQUISITES_FAILED'
  | 'BACKUP_FAILED'
  | 'COMPAT_FAILED'
  | 'RECEIPT_FAILED'
  | 'ROLES_FAILED'
  | 'VERIFY_FAILED'
  | 'SMOKE_FAILED'
  | 'REPORT_FAILED';

export interface SaasMigrateLegacy112CommandOptions {
  dryRun?: boolean;
  envFile?: string;
  releaseId?: string;
  schema?: string;
  sourceCatalogBaseline?: string;
  receiptFile?: string;
  /** Operator attestation: writes and background tasks are stopped. */
  confirmWritesStopped?: boolean;
  /** Operator attestation: a restorable PostgreSQL backup was taken. */
  confirmBackupTaken?: boolean;
  smokeUrl?: string;
  /** Explicit opt-in for a loopback disposable database or trusted local tunnel. */
  allowLocalPlaintext?: boolean;
  verbose?: boolean;
}

export interface SaasMigrateLegacy112CommandDependencies {
  env?: NodeJS.ProcessEnv;
  createPool?: (connectionString: string, options: SaasDeployPoolOptions) => SaasDatabasePool;
  readFile?: (path: string) => Promise<string>;
  writeReceiptFile?: (path: string, text: string) => Promise<void>;
  runCompatPlan?: (pool: SaasDatabasePool, phase: 'pre-check' | 'apply') => Promise<LegacyMain112CompatPlanOutcome>;
  verifyRuntimeRole?: (role: SaasDeployRole, executor: SqlExecutor) => Promise<void>;
  runBackup?: (context: SaasUpgradeBackupContext) => Promise<{ status: 'ok' | 'skipped'; detail: string }>;
  fetchSmoke?: (url: string, timeoutMs: number) => Promise<{ status: number }>;
  now?: () => number;
  writeLine?: (line: string) => void;
}

export interface SaasMigrateLegacy112CommandResult {
  format: 'saas-migrate-legacy-112-command-v1';
  plan: typeof LEGACY_MAIN_112_COMPAT_PLAN_ID;
  status: 'applied' | 'already-current' | 'dry-run' | 'not-applicable' | 'failed';
  exitCode: 0 | 1;
  steps: readonly SaasMigrateLegacy112StepRecord[];
  failure: { code: SaasMigrateLegacy112FailureCode } | null;
  classification: string | null;
  receiptPath: string | null;
  receiptChecksum: string | null;
}

interface SaasCompatReceipt {
  format: 'saas-migration-compat-receipt-v1';
  plan: typeof LEGACY_MAIN_112_COMPAT_PLAN_ID;
  status: 'applied' | 'already-current';
  releaseId: string;
  schema: string;
  postgresMajor: number | null;
  generatedAt: string;
  source: {
    classification: string;
    appliedCount: number;
    head: number;
    migrationsChecksum: string | null;
  };
  target: {
    head: typeof LEGACY_MAIN_112_TARGET_VERSION;
    appliedCount: number | null;
    migrationsChecksum: string | null;
    pendingNormalMigrations: readonly { version: number; name: string }[];
  };
  move: { fromVersion: number; toVersion: number; name: string; checksum: string } | null;
  applied: readonly { version: number; name: string; checksum: string }[];
  catalogBaselineEvidenceId: string | null;
  catalogVerified: boolean;
  verification: LegacyMain112CompatPlanOutcome['verification'];
}

class SaasMigrateLegacy112Failure extends SaasOpsFailure {
  constructor(code: SaasMigrateLegacy112FailureCode, message: string) {
    super(code, message);
  }
}

async function defaultFetchSmoke(url: string, timeoutMs: number): Promise<{ status: number }> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status };
}

/** Same child-process semantics as saas:upgrade's executor (output withheld on failure). */
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
      return { status: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
    throw error;
  }
}

/** The backup point uses the saas:upgrade mechanisms (pg_dump or an operator command). */
async function defaultCompatRunBackup(
  context: SaasUpgradeBackupContext,
): Promise<{ status: 'ok' | 'skipped'; detail: string }> {
  return defaultRunBackup(context, {
    execCommand: defaultExecCommand,
    fileSize: (path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
  });
}

function receiptChecksum(receipt: SaasCompatReceipt): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

async function writeReceipt(path: string, receipt: SaasCompatReceipt): Promise<string> {
  const checksum = receiptChecksum(receipt);
  const document = { ...receipt, receiptChecksum: checksum };
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  return checksum;
}

/** Runs the compat plan orchestration. Failures never throw; the result carries the exit code. */
export async function saasMigrateLegacy112(
  options: SaasMigrateLegacy112CommandOptions = {},
  dependencies: SaasMigrateLegacy112CommandDependencies = {},
): Promise<SaasMigrateLegacy112CommandResult> {
  const steps: SaasMigrateLegacy112StepRecord[] = [];
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const verbose = options.verbose === true;
  const now = dependencies.now ?? Date.now;
  const result: SaasMigrateLegacy112CommandResult = {
    format: 'saas-migrate-legacy-112-command-v1',
    plan: LEGACY_MAIN_112_COMPAT_PLAN_ID,
    status: 'failed',
    exitCode: 1,
    steps,
    failure: null,
    classification: null,
    receiptPath: null,
    receiptChecksum: null,
  };

  const openPools: SaasDatabasePool[] = [];
  let currentStep: SaasMigrateLegacy112StepName = 'pre-check';
  let stepStartedAt = now();
  const beginStep = (step: SaasMigrateLegacy112StepName, title: string): void => {
    currentStep = step;
    stepStartedAt = now();
    writeLine(`saas:migrate-legacy-112 ${step} — ${title}`);
  };
  const finishStep = (status: SaasMigrateLegacy112StepStatus, detail: string): void => {
    steps.push({ step: currentStep, status, durationMs: now() - stepStartedAt, detail });
    writeLine(`saas:migrate-legacy-112 ${currentStep} ${status} — ${detail}`);
  };
  const verboseLine = (line: string): void => {
    if (verbose) writeLine(`  manual equivalent: ${line}`);
  };

  const createPool =
    dependencies.createPool ??
    ((connectionString: string, poolOptions: SaasDeployPoolOptions) =>
      createSaasDeployPool(connectionString, poolOptions));
  const readFileImpl = dependencies.readFile ?? (async (path: string) => fsReadFile(path, 'utf8'));
  const readFile = async (path: string): Promise<string> => readFileImpl(path);

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
  const migratorUrl = (): ValidatedUrl =>
    envUrl(DEPLOYMENT_ENV_VARS.saas.databaseUrl, { requireUser: MIGRATOR_PG_ROLE });
  const adminUrl = (): ValidatedUrl => envUrl(SAAS_DEPLOY_ADMIN_URL_ENV, { forbidUsers: ALL_APPLICATION_PG_ROLES });
  const roleUrl = (index: number): ValidatedUrl =>
    envUrl(ROLE_PLANS[index].urlEnvName, { requireUser: ROLE_PLANS[index].pgRole });

  try {
    // ---------- option validation ----------
    if (
      (options.releaseId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.releaseId)) ||
      (options.schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(options.schema)) ||
      (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') ||
      (options.confirmWritesStopped !== undefined && typeof options.confirmWritesStopped !== 'boolean') ||
      (options.confirmBackupTaken !== undefined && typeof options.confirmBackupTaken !== 'boolean') ||
      (options.allowLocalPlaintext !== undefined && typeof options.allowLocalPlaintext !== 'boolean') ||
      (options.verbose !== undefined && typeof options.verbose !== 'boolean')
    ) {
      throw new SaasMigrateLegacy112Failure('INVALID_OPTIONS', 'invalid option values');
    }
    if (typeof options.releaseId !== 'string' || typeof options.schema !== 'string') {
      throw new SaasMigrateLegacy112Failure(
        'INVALID_OPTIONS',
        '--release-id and --schema are required (the compat plan binds its reviewed baseline and receipt to them)',
      );
    }
    if (options.smokeUrl !== undefined) {
      try {
        const parsed = new URL(options.smokeUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      } catch {
        throw new SaasMigrateLegacy112Failure('INVALID_OPTIONS', '--smoke-url must be an explicit http(s) URL');
      }
    }
    const applyPath = options.dryRun !== true;
    if (applyPath && (options.confirmWritesStopped !== true || options.confirmBackupTaken !== true)) {
      throw new SaasMigrateLegacy112Failure(
        'PREREQUISITES_FAILED',
        'the compat plan performs ledger writes: pass --confirm-writes-stopped and --confirm-backup-taken after stopping writes/background tasks and taking a restorable PostgreSQL backup (the tool cannot stop workloads itself); use --dry-run to verify first',
      );
    }
    if (applyPath && typeof options.receiptFile !== 'string') {
      throw new SaasMigrateLegacy112Failure(
        'INVALID_OPTIONS',
        '--receipt-file <path> is required on the apply path (the compat audit receipt)',
      );
    }
    if (applyPath && typeof options.sourceCatalogBaseline !== 'string') {
      throw new SaasMigrateLegacy112Failure(
        'INVALID_OPTIONS',
        '--source-catalog-baseline <path> is required on the apply path: the old-main schema must be verified against a reviewed baseline inside the upgrade transaction',
      );
    }

    // ---------- environment ----------
    if (options.envFile !== undefined) {
      let text: string;
      try {
        text = await readFile(options.envFile);
      } catch {
        throw new SaasMigrateLegacy112Failure('ENV_FILE_UNREADABLE', `Unable to read the env file: ${options.envFile}`);
      }
      try {
        environment = { ...environment, ...parseSaasDeployEnvFile(text, options.envFile) };
      } catch (error) {
        throw new SaasMigrateLegacy112Failure(
          error instanceof SaasOpsFailure ? 'ENV_FILE_INVALID' : 'ENV_FILE_INVALID',
          (error as Error).message,
        );
      }
    }
    const allowLocalPlaintext = options.allowLocalPlaintext === true;

    let catalogBaseline: SaasAuditCatalogBaseline | undefined;
    if (options.sourceCatalogBaseline !== undefined) {
      let text: string;
      try {
        text = await readFile(options.sourceCatalogBaseline);
      } catch {
        throw new SaasMigrateLegacy112Failure(
          'ENV_FILE_UNREADABLE',
          `Unable to read the source catalog baseline: ${options.sourceCatalogBaseline}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SaasMigrateLegacy112Failure('INVALID_OPTIONS', 'the source catalog baseline is not valid JSON');
      }
      if (!isSaasAuditCatalogBaseline(parsed)) {
        throw new SaasMigrateLegacy112Failure(
          'INVALID_OPTIONS',
          'the source catalog baseline does not match the saas-ddl-v1 baseline contract',
        );
      }
      catalogBaseline = parsed;
    }

    // ---------- [1] pre-check ----------
    beginStep('pre-check', 'full ledger classification, manifest identity, PostgreSQL major, reviewed baseline');
    const migrator = migratorUrl();
    const migratorPool = createPool(migrator.url.toString(), {
      allowLocalPlaintext,
      applicationName: 'model-router-saas-migrate-legacy-112',
    });
    openPools.push(migratorPool);
    verboseLine(
      'read-only classification over the ledger (the plan never trusts head=112 alone: every applied row must match the derived old-main manifest)',
    );
    // The pre-check invocation is ALWAYS the read-only dry-run form: the
    // apply form runs later, after the operator prerequisites.
    const runCompatPlan =
      dependencies.runCompatPlan ??
      ((pool: SaasDatabasePool, phase: 'pre-check' | 'apply') =>
        runLegacyMain112CompatPlan(pool, {
          schema: options.schema as string,
          releaseId: options.releaseId as string,
          ...(catalogBaseline === undefined ? {} : { catalogBaseline }),
          ...(phase === 'pre-check' ? { dryRun: true } : {}),
        }));
    let plan: LegacyMain112CompatPlanOutcome;
    try {
      plan = await runCompatPlan(migratorPool, 'pre-check');
    } catch {
      throw new SaasMigrateLegacy112Failure(
        'PRE_FAILED',
        'the compat pre-check could not read the deployment; no writes were made',
      );
    }
    result.classification = plan.classification?.kind ?? null;
    if (plan.status === 'refused' || plan.status === 'failed') {
      const issue = plan.issues[0];
      throw new SaasMigrateLegacy112Failure(
        'PRE_FAILED',
        issue
          ? `the compat plan refuses this database (${issue.code}): ${issue.detail}`
          : 'the compat plan refuses this database',
      );
    }
    // The pre-check invocation always returns the read-only 'dry-run' form of
    // the outcome (source verified) or 'already-current'.
    if (plan.status !== 'dry-run' && plan.status !== 'already-current') {
      throw new SaasMigrateLegacy112Failure('PRE_FAILED', 'unexpected compat pre-check outcome');
    }
    finishStep(
      'ok',
      `ledger classified: ${plan.classification?.kind} (head ${plan.classification?.head}, ${plan.classification?.appliedCount} applied); postgres major ${plan.postgresMajor}; baseline ${plan.catalogBaselineEvidenceId ?? 'not supplied'}${plan.catalogVerified ? ' (matched)' : ''}`,
    );

    // ---------- --dry-run stops after the read-only verification ----------
    if (options.dryRun === true) {
      writeLine('saas:migrate-legacy-112 dry-run — zero mutations. Planned apply steps:');
      writeLine(
        '  - prerequisites: operator attestations (writes stopped, restorable backup) + backup point when configured',
      );
      writeLine(
        `  - compat-apply: one transaction — advisory lock, re-verify source fingerprints + schema, move ledger 112 → ${LEGACY_MAIN_112_TARGET_VERSION} (exact ${LEGACY_MAIN_112_MIGRATION_NAME} identity), apply target 112..128 with original identities, verify target history + catalog constraints + data preservation, COMMIT`,
      );
      writeLine(
        `  - receipt: audit-only compat receipt${options.receiptFile ? ` at ${options.receiptFile}` : ' (--receipt-file)'}`,
      );
      writeLine(
        '  - roles + verify + restart + smoke: role template replay, runtime privilege probes, manual restart checklist, optional smoke',
      );
      for (const skipped of [
        'prerequisites',
        'compat-apply',
        'receipt',
        'roles',
        'verify',
        'restart',
        'smoke',
        'report',
      ] as const) {
        steps.push({ step: skipped, status: 'skipped', durationMs: 0, detail: 'dry-run' });
      }
      result.status = 'dry-run';
      result.exitCode = 0;
      return result;
    }

    if (plan.status === 'already-current') {
      // Complete-target rerun: an idempotent no-op. Post steps are skipped —
      // the target deployment already ran them; nothing changed.
      writeLine(
        `saas:migrate-legacy-112 already-current — the ledger matches the complete target state (head ${plan.classification?.head}); nothing to do`,
      );
      for (const [step, detail] of [
        ['prerequisites', 'no-op rerun: the ledger already matches the complete target state'],
        ['compat-apply', 'no ledger writes: the ledger already matches the complete target state'],
        ['receipt', 'no receipt written on an already-current rerun'],
        ['roles', 'skipped (no-op rerun)'],
        ['verify', 'skipped (no-op rerun)'],
        ['restart', 'skipped (no-op rerun)'],
        ['smoke', 'skipped (no-op rerun)'],
        ['report', 'already at the complete target state; nothing to do'],
      ] as const) {
        steps.push({ step: step as SaasMigrateLegacy112StepName, status: 'skipped', durationMs: 0, detail });
        writeLine(`saas:migrate-legacy-112 ${step} skipped — ${detail}`);
      }
      result.status = 'already-current';
      result.exitCode = 0;
      return result;
    }

    // ---------- [2] prerequisites ----------
    beginStep('prerequisites', 'operator attestations + backup point');
    writeLine('  operator prerequisites (attested via --confirm-writes-stopped / --confirm-backup-taken):');
    writeLine('    1. SaaS workloads and background tasks are stopped (this tool cannot stop them).');
    writeLine('    2. A restorable PostgreSQL backup of this database exists.');
    writeLine(
      '    3. Credential KMS keys and the target release package are retained for rollback (backup-restore is the only rollback path).',
    );
    const admin = adminUrl();
    const runBackup = dependencies.runBackup ?? defaultCompatRunBackup;
    let backup: { status: 'ok' | 'skipped'; detail: string };
    try {
      backup = await runBackup({ version: LEGACY_MAIN_112_SOURCE_VERSION, admin, env: environment });
    } catch (error) {
      throw new SaasMigrateLegacy112Failure(
        'BACKUP_FAILED',
        error instanceof Error && error.message
          ? `the configured backup point failed: ${error.message}`
          : 'the configured backup point failed; the compat plan was not started',
      );
    }
    finishStep(backup.status, `operator attestations recorded; ${backup.detail}`);

    // ---------- [3] compat-apply ----------
    beginStep('compat-apply', 'one transaction: lock, re-verify, move 112 → 129, apply 112..128, verify, commit');
    let applyPlan: LegacyMain112CompatPlanOutcome;
    try {
      applyPlan = await runCompatPlan(migratorPool, 'apply');
    } catch {
      throw new SaasMigrateLegacy112Failure(
        'COMPAT_FAILED',
        'the compat transaction failed and rolled back; the ledger keeps its complete source state — it is safe to re-run saas:migrate-legacy-112',
      );
    }
    if (applyPlan.status !== 'applied') {
      const issue = applyPlan.issues[0];
      throw new SaasMigrateLegacy112Failure(
        'COMPAT_FAILED',
        issue
          ? `the compat transaction did not commit (${issue.code}): ${issue.detail}`
          : 'the compat transaction did not commit',
      );
    }
    const verification = applyPlan.verification;
    finishStep(
      'ok',
      `ledger 112 → ${LEGACY_MAIN_112_TARGET_VERSION} moved (exact identity ${LEGACY_MAIN_112_MIGRATION_NAME}/${LEGACY_MAIN_112_MIGRATION_CHECKSUM.slice(0, 12)}…); ${applyPlan.applied.length} target migrations applied and registered; target history verified; ${verification?.catalogConstraintsVerified ?? 0} catalog names verified; ${verification?.dataPreservation.length ?? 0} data-preservation probes unchanged`,
    );

    // ---------- [4] receipt ----------
    beginStep('receipt', 'audit-only compatibility receipt');
    if (typeof options.receiptFile !== 'string') {
      throw new SaasMigrateLegacy112Failure('RECEIPT_FAILED', '--receipt-file is required on the apply path');
    }
    await writePlanReceipt(options.receiptFile, applyPlan, options, dependencies, result, writeReceipt);
    finishStep(
      'ok',
      `receipt written to ${options.receiptFile} (checksum ${result.receiptChecksum?.slice(0, 12)}…; audit-only, never a migration authority)`,
    );

    // ---------- [5] post: roles, verify, restart, smoke ----------
    beginStep('roles', 'idempotent role template replay (both templates)');
    verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${MAIN_TEMPLATE_FILE} (as the administrator)`);
    verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${WORKER_TEMPLATE_FILE} (as the administrator)`);
    const templateDir = defaultTemplateDir();
    const adminPool = createPool(admin.url.toString(), {
      allowLocalPlaintext,
      applicationName: 'model-router-saas-migrate-legacy-112-roles',
    });
    openPools.push(adminPool);
    try {
      await applyTemplateSql(adminPool, await readFile(join(templateDir, MAIN_TEMPLATE_FILE)));
      await applyTemplateSql(adminPool, await readFile(join(templateDir, WORKER_TEMPLATE_FILE)));
    } catch {
      throw new SaasMigrateLegacy112Failure(
        'ROLES_FAILED',
        'role template replay failed; the compat upgrade itself is committed — re-run saas:migrate-legacy-112 (the no-op rerun path) or saas:deploy after fixing the templates',
      );
    }
    finishStep('ok', `${MAIN_TEMPLATE_FILE} and ${WORKER_TEMPLATE_FILE} replayed`);

    beginStep('verify', 'runtime privilege probes as each role login');
    const verifyRuntimeRole =
      dependencies.verifyRuntimeRole ??
      (async (role: SaasDeployRole, executor: SqlExecutor) => {
        if (role === 'credential-validation-worker') {
          await verifyCredentialValidationWorkerRuntimePrivileges(executor);
          return;
        }
        await verifySaasRuntimeDatabasePrivileges(executor, role === 'gateway' ? 'gateway' : 'control_plane');
      });
    const probeResults: string[] = [];
    for (let index = 0; index < ROLE_PLANS.length; index += 1) {
      const plan = ROLE_PLANS[index];
      const pool = createPool(roleUrl(index).url.toString(), {
        allowLocalPlaintext,
        applicationName: `model-router-saas-migrate-legacy-112-verify-${plan.role}`,
      });
      openPools.push(pool);
      const identity = await pool.query<{ current_user: unknown }>('SELECT current_user');
      if (identity.rows[0]?.current_user !== plan.pgRole) {
        throw new SaasMigrateLegacy112Failure(
          'VERIFY_FAILED',
          `${plan.urlEnvName} authenticated as ${String(identity.rows[0]?.current_user)}; expected ${plan.pgRole}`,
        );
      }
      try {
        await verifyRuntimeRole(plan.role, pool);
        probeResults.push(`${plan.pgRole}: probe green`);
        writeLine(`  ${plan.pgRole}: runtime privilege probe green`);
      } catch {
        throw new SaasMigrateLegacy112Failure(
          'VERIFY_FAILED',
          `the ${plan.pgRole} runtime privilege probe failed; the compat upgrade is committed — re-run saas:migrate-legacy-112 (no-op rerun) to replay the role templates and probes`,
        );
      }
    }
    finishStep('ok', probeResults.join('; '));

    beginStep('restart', 'manual workload restart checklist');
    writeLine('  restart the workloads pinned to the target release package (per instance, with health gating):');
    writeLine('    compose: docker compose up -d --no-deps control-plane gateway credential-validation-worker');
    writeLine(
      '    systemd: systemctl restart model-router-saas-control-plane.service model-router-saas-gateway.service model-router-saas-credential-validation-worker.service',
    );
    finishStep('ok', 'restart checklist printed (operator-executed; the compat plan never restarts workloads itself)');

    beginStep(
      'smoke',
      options.smokeUrl === undefined ? 'smoke request (skipped)' : `smoke request ${options.smokeUrl}`,
    );
    if (options.smokeUrl === undefined) {
      finishStep('skipped', 'no --smoke-url provided');
    } else {
      const fetchSmoke = dependencies.fetchSmoke ?? defaultFetchSmoke;
      let smoke: { status: number };
      try {
        smoke = await fetchSmoke(options.smokeUrl, SMOKE_TIMEOUT_MS);
      } catch {
        throw new SaasMigrateLegacy112Failure(
          'SMOKE_FAILED',
          `the smoke request to ${options.smokeUrl} could not be completed`,
        );
      }
      if (smoke.status !== 200) {
        throw new SaasMigrateLegacy112Failure(
          'SMOKE_FAILED',
          `the smoke request to ${options.smokeUrl} returned HTTP ${smoke.status} (expected 200)`,
        );
      }
      finishStep('ok', `smoke request ${options.smokeUrl} returned 200`);
    }

    // ---------- report ----------
    beginStep('report', 'summary');
    result.status = 'applied';
    result.exitCode = 0;
    finishStep(
      'ok',
      `legacy-main-112-to-129 normalization committed: ledger head ${LEGACY_MAIN_112_TARGET_VERSION}, ${applyPlan.applied.length} target migrations registered${applyPlan.pendingNormalMigrations.length > 0 ? `, ${applyPlan.pendingNormalMigrations.length} later migration(s) remain for the normal saas:migrate` : ''}`,
    );
    return result;
  } catch (error) {
    const failure =
      error instanceof SaasOpsFailure
        ? error
        : new SaasMigrateLegacy112Failure(stepFailureCode(currentStep), safeFailureMessage(currentStep));
    result.failure = { code: failure.code as SaasMigrateLegacy112FailureCode };
    steps.push({ step: currentStep, status: 'failed', durationMs: now() - stepStartedAt, detail: failure.message });
    try {
      writeLine(`saas:migrate-legacy-112 failed at step "${currentStep}": ${failure.message}`);
      writeLine('saas:migrate-legacy-112 steps');
      for (const step of steps) {
        writeLine(
          `  ${step.step.padEnd(14)} ${step.status.padEnd(7)} ${String(step.durationMs).padStart(7)}ms  ${step.detail}`,
        );
      }
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

async function writePlanReceipt(
  path: string,
  plan: LegacyMain112CompatPlanOutcome,
  options: SaasMigrateLegacy112CommandOptions,
  dependencies: SaasMigrateLegacy112CommandDependencies,
  result: SaasMigrateLegacy112CommandResult,
  writeReceiptImpl: (path: string, receipt: SaasCompatReceipt) => Promise<string>,
): Promise<void> {
  const receipt: SaasCompatReceipt = {
    format: 'saas-migration-compat-receipt-v1',
    plan: LEGACY_MAIN_112_COMPAT_PLAN_ID,
    status: plan.status === 'already-current' ? 'already-current' : 'applied',
    releaseId: options.releaseId as string,
    schema: options.schema as string,
    postgresMajor: plan.postgresMajor,
    generatedAt: new Date().toISOString(),
    source: {
      classification: plan.classification?.kind ?? 'unknown',
      appliedCount: plan.classification?.appliedCount ?? 0,
      head: plan.classification?.head ?? 0,
      migrationsChecksum: plan.sourceMigrationsChecksum,
    },
    target: {
      head: LEGACY_MAIN_112_TARGET_VERSION,
      appliedCount: plan.classification?.appliedCount ?? null,
      migrationsChecksum: plan.targetMigrationsChecksum,
      pendingNormalMigrations: plan.pendingNormalMigrations.map(({ version, name }) => ({ version, name })),
    },
    move: plan.move,
    applied: [...plan.applied],
    catalogBaselineEvidenceId: plan.catalogBaselineEvidenceId,
    catalogVerified: plan.catalogVerified,
    verification: plan.verification,
  };
  try {
    const writeReceipt = dependencies.writeReceiptFile
      ? async (receiptPath: string, receiptBody: SaasCompatReceipt): Promise<string> => {
          const checksum = receiptChecksum(receiptBody);
          await dependencies.writeReceiptFile?.(
            receiptPath,
            `${JSON.stringify({ ...receiptBody, receiptChecksum: checksum }, null, 2)}\n`,
          );
          return checksum;
        }
      : writeReceiptImpl;
    result.receiptPath = path;
    result.receiptChecksum = await writeReceipt(path, receipt);
  } catch {
    throw new SaasMigrateLegacy112Failure(
      'RECEIPT_FAILED',
      `unable to write the compatibility receipt to ${path} (it must not already exist); the database upgrade itself is committed — write the receipt manually or re-run with a fresh --receipt-file path`,
    );
  }
}

function stepFailureCode(step: SaasMigrateLegacy112StepName): SaasMigrateLegacy112FailureCode {
  switch (step) {
    case 'pre-check':
      return 'PRE_FAILED';
    case 'prerequisites':
      return 'PREREQUISITES_FAILED';
    case 'compat-apply':
      return 'COMPAT_FAILED';
    case 'receipt':
      return 'RECEIPT_FAILED';
    case 'roles':
      return 'ROLES_FAILED';
    case 'verify':
      return 'VERIFY_FAILED';
    case 'restart':
      return 'REPORT_FAILED';
    case 'smoke':
      return 'SMOKE_FAILED';
    default:
      return 'REPORT_FAILED';
  }
}

function safeFailureMessage(step: SaasMigrateLegacy112StepName): string {
  switch (step) {
    case 'pre-check':
      return 'the pre-check failed; no writes were made';
    case 'prerequisites':
      return 'the operator prerequisites were not satisfied; no writes were made';
    case 'compat-apply':
      return 'the compat transaction failed and rolled back; the ledger keeps its previous complete state';
    case 'receipt':
      return 'the compatibility receipt could not be written';
    case 'roles':
      return 'role template replay failed';
    case 'verify':
      return 'a runtime privilege probe failed';
    case 'restart':
      return 'the restart checklist could not be reported';
    case 'smoke':
      return 'the smoke request failed';
    default:
      return `saas:migrate-legacy-112 failed at step "${step}"`;
  }
}
