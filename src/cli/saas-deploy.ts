import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../saas/db/credential-validation-worker-privileges.js';
import { runSaasMigrations, verifySaasMigrations } from '../saas/db/migrate.js';
import { verifySaasRuntimeDatabasePrivileges } from '../saas/db/runtime-privileges.js';
import type { SaasDatabasePool, SqlExecutor } from '../saas/db/types.js';
import { DEPLOYMENT_ENV_VARS } from '../saas/deployment.js';
import {
  ALL_APPLICATION_PG_ROLES,
  applyRolePassword,
  applyTemplateSql,
  assertNotMaintenanceDatabase,
  assertSchemaOwnership,
  assertServerVersion,
  connectPort,
  createSaasDeployPool,
  defaultTemplateDir,
  MAIN_TEMPLATE_FILE,
  MIGRATOR_PG_ROLE,
  missingRuntimeGrantSummary,
  parseSaasDeployEnvFile,
  planByPgRole,
  ROLE_PLANS,
  type RolePlan,
  rolePresence,
  SAAS_DEPLOY_ADMIN_URL_ENV,
  SAAS_SCHEMA,
  type SaasDeployPoolOptions,
  type SaasDeployRole,
  SaasOpsFailure,
  schemaOwnership,
  serverInfo,
  type ValidatedUrl,
  validateDatabaseUrl,
  WORKER_ROLE_PLAN,
  WORKER_TEMPLATE_FILE,
} from './saas-deploy-shared.js';

export type { SaasDeployPoolOptions, SaasDeployRole, ValidatedUrl } from './saas-deploy-shared.js';
export {
  createSaasDeployPool,
  parseSaasDeployEnvFile,
  parseWorkerExpectedColumnGrants,
  SAAS_DEPLOY_ADMIN_URL_ENV,
  SAAS_DEPLOY_TEMPLATE_DIR_ENV,
} from './saas-deploy-shared.js';

/**
 * One-command managed SaaS deployment orchestration (DOps plan §2).
 *
 * Sequence (idempotent, fail-closed at every step):
 *   [1] preflight  — read-only PostgreSQL catalog checks + declaration checks
 *   [2] bootstrap  — fresh deployments only: apply the role template before
 *                    the first migration (it creates the migrator/control-
 *                    plane/gateway roles and the migrator-owned schema) and
 *                    set passwords for roles this run created
 *   [3] migrate    — explicit `runSaasMigrations` as the migrator login
 *                    (--skip-migrate skips; the product process never migrates)
 *   [4] roles      — replay both idempotent role templates (administrator)
 *   [5] verify     — connect as EACH runtime role and run its privilege
 *                    probe; a missing column is named precisely (the P15b
 *                    interception point)
 *   [6] readiness  — poll declared listener ports when workloads are already
 *                    up; otherwise print the per-role start commands
 *   [7] report     — per-step wall-clock, probe results, next-step hints
 *
 * Red lines: any step failure stops the sequence with a non-zero exit; probes
 * run as the runtime logins themselves (never as an administrator); no
 * credential or secret value is ever printed — only variable names, role
 * names, and non-secret catalog facts.
 */

export type SaasDeployStepName = 'preflight' | 'bootstrap' | 'migrate' | 'roles' | 'verify' | 'readiness' | 'report';

export type SaasDeployStepStatus = 'ok' | 'skipped' | 'failed';

export interface SaasDeployStepRecord {
  readonly step: SaasDeployStepName;
  readonly status: SaasDeployStepStatus;
  readonly durationMs: number;
  readonly detail: string;
}

export type SaasDeployFailureCode =
  | 'INVALID_OPTIONS'
  | 'ENV_FILE_UNREADABLE'
  | 'ENV_FILE_INVALID'
  | 'MISSING_DECLARATION'
  | 'INVALID_DATABASE_URL'
  | 'PREFLIGHT_FAILED'
  | 'BOOTSTRAP_FAILED'
  | 'MIGRATE_FAILED'
  | 'ROLES_FAILED'
  | 'VERIFY_FAILED'
  | 'READINESS_FAILED'
  | 'REPORT_FAILED';

export interface SaasDeployCommandOptions {
  envFile?: string;
  skipMigrate?: boolean;
  dryRun?: boolean;
  /** Single-role mode for per-container compose usage: preflight + verify only. */
  role?: string;
  verbose?: boolean;
  /** Explicit opt-in for a loopback disposable database or trusted local tunnel. */
  allowLocalPlaintext?: boolean;
}

export interface SaasDeployCommandDependencies {
  env?: NodeJS.ProcessEnv;
  createPool?: (connectionString: string, options: SaasDeployPoolOptions) => SaasDatabasePool;
  /** Defaults to the explicit registered migration runner; startup never migrates. */
  runMigrations?: (pool: SaasDatabasePool) => Promise<void>;
  verifyMigrations?: (pool: SaasDatabasePool) => Promise<void>;
  verifyRuntimeRole?: (role: SaasDeployRole, executor: SqlExecutor) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  writeLine?: (line: string) => void;
  connectPort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface SaasDeployCommandResult {
  format: 'saas-deploy-command-v1';
  status: 'deployed' | 'verified' | 'dry-run' | 'failed';
  exitCode: 0 | 1;
  steps: readonly SaasDeployStepRecord[];
  failure: { code: SaasDeployFailureCode } | null;
}

class SaasDeployFailure extends SaasOpsFailure {
  constructor(code: SaasDeployFailureCode, message: string) {
    super(code, message);
  }
}

interface PreflightRoleState {
  readonly present: boolean;
}

interface FullPreflightState {
  readonly kind: 'full';
  readonly roles: Readonly<Record<SaasDeployRole, PreflightRoleState>>;
  readonly migratorPresent: boolean;
  readonly schemaPresent: boolean;
  /** True when the pre-migration bootstrap template is required (P15b fresh branch). */
  readonly fresh: boolean;
  readonly missingRoles: readonly string[];
  /** Administrator pool, created during preflight and reused for every DDL step. */
  readonly adminPool: SaasDatabasePool;
}

interface RolePreflightState {
  readonly kind: 'role';
  readonly plan: RolePlan;
}

type PreflightState = FullPreflightState | RolePreflightState;

const READINESS_POLL_TOTAL_MS = 30_000;
const READINESS_QUICK_TIMEOUT_MS = 500;
const READINESS_POLL_INTERVAL_MS = 500;

function loadTemplateWith(readFileImpl: (path: string) => Promise<string>) {
  const templateDir = defaultTemplateDir();
  return async (file: string): Promise<string> => {
    try {
      return await readFileImpl(join(templateDir, file));
    } catch {
      throw new SaasDeployFailure('ROLES_FAILED', `Unable to read the role template: ${file}`);
    }
  };
}

/**
 * Runs the deployment orchestration. Operational failures never throw; the
 * result carries the exit code for the CLI registration.
 */
export async function saasDeploy(
  options: SaasDeployCommandOptions = {},
  dependencies: SaasDeployCommandDependencies = {},
): Promise<SaasDeployCommandResult> {
  const steps: SaasDeployStepRecord[] = [];
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const verbose = options.verbose === true;
  const now = dependencies.now ?? Date.now;

  const result: SaasDeployCommandResult = {
    format: 'saas-deploy-command-v1',
    status: 'failed',
    exitCode: 1,
    steps,
    failure: null,
  };

  const openPools: SaasDatabasePool[] = [];
  let currentStep: SaasDeployStepName = 'preflight';
  let stepStartedAt = now();
  const beginStep = (step: SaasDeployStepName, title: string): void => {
    currentStep = step;
    stepStartedAt = now();
    writeLine(`saas:deploy ${step} — ${title}`);
  };
  const finishStep = (status: SaasDeployStepStatus, detail: string): number => {
    const durationMs = now() - stepStartedAt;
    steps.push({ step: currentStep, status, durationMs, detail });
    writeLine(`saas:deploy ${currentStep} ${status} in ${durationMs}ms${detail ? ` — ${detail}` : ''}`);
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
  const connectPortImpl = dependencies.connectPort ?? connectPort;
  const loadTemplate = loadTemplateWith(readFileImpl);

  // Resolved (validated) deployment URLs, keyed by PostgreSQL role name.
  const resolvedUrls = new Map<string, ValidatedUrl>();
  let environment: Record<string, string | undefined> | undefined;
  const envValue = (name: string): string | undefined => (environment ?? dependencies.env ?? process.env)[name];
  const roleUrl = (plan: RolePlan): ValidatedUrl => {
    let validated = resolvedUrls.get(plan.pgRole);
    if (!validated) {
      validated = validateDatabaseUrl(envValue(plan.urlEnvName), {
        name: plan.urlEnvName,
        requireUser: plan.pgRole,
        allowLocalPlaintext: options.allowLocalPlaintext === true,
      });
      resolvedUrls.set(plan.pgRole, validated);
    }
    return validated;
  };
  const migratorUrl = (): ValidatedUrl => {
    let validated = resolvedUrls.get(MIGRATOR_PG_ROLE);
    if (!validated) {
      validated = validateDatabaseUrl(envValue(DEPLOYMENT_ENV_VARS.saas.databaseUrl), {
        name: DEPLOYMENT_ENV_VARS.saas.databaseUrl,
        requireUser: MIGRATOR_PG_ROLE,
        allowLocalPlaintext: options.allowLocalPlaintext === true,
      });
      resolvedUrls.set(MIGRATOR_PG_ROLE, validated);
    }
    return validated;
  };

  try {
    // ---------- option validation ----------
    if (options.role !== undefined && !ROLE_PLANS.some((plan) => plan.role === options.role)) {
      throw new SaasDeployFailure(
        'INVALID_OPTIONS',
        '--role must be exactly control-plane, gateway, or credential-validation-worker',
      );
    }
    const singleRolePlan =
      options.role === undefined ? undefined : ROLE_PLANS.find((plan) => plan.role === options.role);

    // ---------- environment ----------
    const baseEnv = dependencies.env ?? process.env;
    environment = baseEnv;
    if (options.envFile !== undefined) {
      let text: string;
      try {
        text = await readFileImpl(options.envFile);
      } catch {
        throw new SaasDeployFailure('ENV_FILE_UNREADABLE', `Unable to read the env file: ${options.envFile}`);
      }
      const parsed = parseSaasDeployEnvFile(text, options.envFile);
      environment = { ...baseEnv, ...parsed };
    }
    const allowLocalPlaintext = options.allowLocalPlaintext === true;

    writeLine(
      singleRolePlan
        ? `saas:deploy single-role mode — ${singleRolePlan.role} (preflight + verify only; migration and template replay belong to the full deployment run)`
        : `saas:deploy full deployment — preflight, ${options.skipMigrate ? 'migrate (skipped by request)' : 'migrate'}, role templates, runtime probes`,
    );

    // ---------- [1] preflight ----------
    beginStep('preflight', 'read-only checks');
    let preflight: PreflightState;
    if (singleRolePlan) {
      const plan = singleRolePlan;
      requireDeclarations(environment, plan.readinessEnvNames, plan.role);
      const pool = createPool(roleUrl(plan).url.toString(), {
        allowLocalPlaintext,
        applicationName: 'model-router-saas-deploy-preflight',
      });
      openPools.push(pool);
      const info = await serverInfo(pool);
      const version = assertServerVersion(info.versionNum);
      assertNotMaintenanceDatabase(info.currentDatabase);
      if (info.currentUser !== plan.pgRole) {
        throw new SaasDeployFailure(
          'PREFLIGHT_FAILED',
          `${plan.urlEnvName} authenticated as ${info.currentUser}; expected ${plan.pgRole}`,
        );
      }
      const schema = await schemaOwnership(pool);
      assertSchemaOwnership(schema);
      if (!schema.present) {
        throw new SaasDeployFailure(
          'PREFLIGHT_FAILED',
          `schema ${SAAS_SCHEMA} is absent; run the full saas:deploy (or saas:migrate) before single-role verification`,
        );
      }
      preflight = { kind: 'role', plan };
      finishStep(
        'ok',
        `PostgreSQL ${version}, database ${info.currentDatabase}, login ${plan.pgRole}, schema ${SAAS_SCHEMA} owned by ${MIGRATOR_PG_ROLE}`,
      );
    } else {
      const admin = validateDatabaseUrl(environment[SAAS_DEPLOY_ADMIN_URL_ENV], {
        name: SAAS_DEPLOY_ADMIN_URL_ENV,
        forbidUsers: ALL_APPLICATION_PG_ROLES,
        allowLocalPlaintext,
      });
      const adminPool = createPool(admin.url.toString(), {
        allowLocalPlaintext,
        applicationName: 'model-router-saas-deploy-admin',
      });
      openPools.push(adminPool);
      const info = await serverInfo(adminPool);
      const version = assertServerVersion(info.versionNum);
      assertNotMaintenanceDatabase(info.currentDatabase);
      const present = await rolePresence(adminPool);
      const schema = await schemaOwnership(adminPool);
      assertSchemaOwnership(schema);

      const migrator = migratorUrl();
      const roleStates: Record<SaasDeployRole, PreflightRoleState> = {
        'control-plane': { present: present.has('model_router_saas_control_plane') },
        gateway: { present: present.has('model_router_saas_gateway') },
        'credential-validation-worker': { present: present.has('model_router_saas_validation_worker') },
      };
      for (const plan of ROLE_PLANS) {
        requireDeclarations(environment, plan.readinessEnvNames, plan.role);
        const url = roleUrl(plan);
        if (!roleStates[plan.role].present && url.password === '') {
          throw new SaasDeployFailure(
            'MISSING_DECLARATION',
            `${plan.urlEnvName} must carry a password so saas:deploy can initialize the ${plan.pgRole} login it creates`,
          );
        }
      }
      if (!present.has(MIGRATOR_PG_ROLE) && migrator.password === '') {
        throw new SaasDeployFailure(
          'MISSING_DECLARATION',
          `${DEPLOYMENT_ENV_VARS.saas.databaseUrl} must carry a password so saas:deploy can initialize the ${MIGRATOR_PG_ROLE} login it creates`,
        );
      }
      const missingRoles = ALL_APPLICATION_PG_ROLES.filter((pgRole) => !present.has(pgRole));
      if (missingRoles.length > 0 && !(info.superuser || info.createrole)) {
        throw new SaasDeployFailure(
          'PREFLIGHT_FAILED',
          `roles ${missingRoles.join(', ')} do not exist and the administrator login cannot create roles (CREATEROLE required)`,
        );
      }
      // The main template creates migrator/control-plane/gateway and the schema;
      // the worker role is only created by the worker template after migration.
      const migratorPresent = present.has(MIGRATOR_PG_ROLE);
      const fresh =
        !schema.present || !migratorPresent || !roleStates['control-plane'].present || !roleStates.gateway.present;
      preflight = {
        kind: 'full',
        roles: roleStates,
        migratorPresent,
        schemaPresent: schema.present,
        fresh,
        missingRoles,
        adminPool,
      };
      const roleSummary = ALL_APPLICATION_PG_ROLES.map(
        (pgRole) => `${pgRole} ${present.has(pgRole) ? 'present' : 'absent (will be created)'}`,
      ).join(', ');
      finishStep(
        'ok',
        `PostgreSQL ${version}, database ${info.currentDatabase}, schema ${SAAS_SCHEMA} ${schema.present ? `owned by ${MIGRATOR_PG_ROLE}` : 'absent (fresh deployment)'}, ${roleSummary}`,
      );
    }

    if (options.dryRun) {
      writeLine('saas:deploy dry-run — no database mutations will be performed. Planned steps:');
      for (const line of plannedSteps(preflight, options.skipMigrate === true)) writeLine(`  - ${line}`);
      for (const skipped of ['bootstrap', 'migrate', 'roles', 'verify', 'readiness'] as const) {
        steps.push({ step: skipped, status: 'skipped', durationMs: 0, detail: 'dry-run' });
      }
      result.status = 'dry-run';
      result.exitCode = 0;
      printReport(writeLine, steps, 'dry-run: preflight passed; run without --dry-run to deploy');
      return result;
    }

    // ---------- [2] bootstrap (full mode, fresh deployments only) ----------
    if (preflight.kind === 'full' && preflight.fresh) {
      beginStep('bootstrap', 'fresh deployment: roles and schema before the first migration');
      verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${MAIN_TEMPLATE_FILE} (as the administrator)`);
      try {
        await applyTemplateSql(preflight.adminPool, await loadTemplate(MAIN_TEMPLATE_FILE));
        // Only roles THIS RUN created receive a password from their deployment
        // URL; existing roles keep their externally managed credentials.
        const bootstrapLogins = [
          ...(preflight.migratorPresent ? [] : [MIGRATOR_PG_ROLE]),
          ...ROLE_PLANS.filter((plan) => !preflight.roles[plan.role].present && plan !== WORKER_ROLE_PLAN).map(
            (plan) => plan.pgRole,
          ),
        ];
        for (const pgRole of bootstrapLogins) {
          const url = pgRole === MIGRATOR_PG_ROLE ? migratorUrl() : roleUrl(planByPgRole(pgRole));
          await applyRolePassword(preflight.adminPool, pgRole, url.password);
        }
        finishStep('ok', `role template applied; logins initialized: ${bootstrapLogins.join(', ')}`);
      } catch (error) {
        if (error instanceof SaasDeployFailure) throw error;
        throw new SaasDeployFailure(
          'BOOTSTRAP_FAILED',
          'fresh-deployment bootstrap failed; the role template is a single transaction and rolled back',
        );
      }
    } else if (preflight.kind === 'full') {
      beginStep('bootstrap', 'existing deployment');
      finishStep('skipped', 'roles and schema already present');
    }

    // ---------- [3] migrate ----------
    let migratorPool: SaasDatabasePool | undefined;
    if (preflight.kind === 'full') {
      if (options.skipMigrate) {
        beginStep('migrate', 'skipped by request');
        finishStep('skipped', '--skip-migrate');
      } else {
        beginStep('migrate', 'explicit registered migrations as the migrator login');
        verboseLine('node dist/cli/index.js saas:migrate (MODEL_ROUTER_SAAS_DATABASE_URL = the migrator login)');
        migratorPool = createPool(migratorUrl().url.toString(), {
          allowLocalPlaintext,
          applicationName: 'model-router-saas-deploy-migrate',
        });
        openPools.push(migratorPool);
        try {
          await runMigrations(migratorPool);
        } catch {
          throw new SaasDeployFailure(
            'MIGRATE_FAILED',
            'SaaS database migrations failed; the migration transaction rolled back — fix and re-run saas:deploy',
          );
        }
        finishStep('ok', 'registered migrations applied (or already up to date)');
      }
    }

    // ---------- [4] roles ----------
    if (preflight.kind === 'full') {
      beginStep('roles', 'idempotent role template replay (re-apply after every migration)');
      verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${MAIN_TEMPLATE_FILE} (as the administrator)`);
      verboseLine(`psql -X -v ON_ERROR_STOP=1 --file=deploy/${WORKER_TEMPLATE_FILE} (as the administrator)`);
      try {
        await applyTemplateSql(preflight.adminPool, await loadTemplate(MAIN_TEMPLATE_FILE));
        await applyTemplateSql(preflight.adminPool, await loadTemplate(WORKER_TEMPLATE_FILE));
        if (!preflight.roles['credential-validation-worker'].present) {
          await applyRolePassword(preflight.adminPool, WORKER_ROLE_PLAN.pgRole, roleUrl(WORKER_ROLE_PLAN).password);
        }
      } catch (error) {
        if (error instanceof SaasDeployFailure) throw error;
        throw new SaasDeployFailure(
          'ROLES_FAILED',
          'role template replay failed; each template is a single transaction — fix the reported guard and re-run saas:deploy',
        );
      }
      finishStep('ok', `${MAIN_TEMPLATE_FILE} and ${WORKER_TEMPLATE_FILE} replayed`);
    }

    // ---------- [5] verify ----------
    const verifyRuntimeRole =
      dependencies.verifyRuntimeRole ??
      (async (role: SaasDeployRole, executor: SqlExecutor) => {
        if (role === 'credential-validation-worker') {
          await verifyCredentialValidationWorkerRuntimePrivileges(executor);
          return;
        }
        await verifySaasRuntimeDatabasePrivileges(executor, role === 'gateway' ? 'gateway' : 'control_plane');
      });

    beginStep('verify', 'runtime privilege probes as each role login');
    const scopes: readonly RolePlan[] = preflight.kind === 'role' ? [preflight.plan] : ROLE_PLANS;
    if (preflight.kind === 'full') {
      const registryPool =
        migratorPool ??
        createPool(migratorUrl().url.toString(), {
          allowLocalPlaintext,
          applicationName: 'model-router-saas-deploy-verify',
        });
      if (!migratorPool) openPools.push(registryPool);
      try {
        await verifyMigrations(registryPool);
      } catch {
        throw new SaasDeployFailure(
          'VERIFY_FAILED',
          'the SaaS migration registry does not match this release; run without --skip-migrate (or saas:migrate) first',
        );
      }
      writeLine(`  migration registry matches this release (${MIGRATOR_PG_ROLE})`);
    }
    const probeResults: string[] = [];
    for (const plan of scopes) {
      const pool = createPool(roleUrl(plan).url.toString(), {
        allowLocalPlaintext,
        applicationName: `model-router-saas-deploy-verify-${plan.role}`,
      });
      openPools.push(pool);
      const identity = await pool.query<{ current_user: unknown }>('SELECT current_user');
      const currentUser = identity.rows[0]?.current_user;
      if (currentUser !== plan.pgRole) {
        throw new SaasDeployFailure(
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
        throw new SaasDeployFailure(
          'VERIFY_FAILED',
          `the ${plan.pgRole} runtime privilege probe failed.${named} Re-run saas:deploy to replay the role templates; if this persists, review deploy/${MAIN_TEMPLATE_FILE} and deploy/${WORKER_TEMPLATE_FILE} against the probe manifests.`,
        );
      }
    }
    finishStep('ok', probeResults.join('; '));

    // ---------- [6] readiness ----------
    beginStep('readiness', 'listener ports or start commands');
    const listeners: ReadonlyArray<'customer' | 'platform' | 'gateway'> =
      preflight.kind === 'role' ? preflight.plan.listeners : ROLE_PLANS.flatMap((plan) => [...plan.listeners]);
    const portTargets: Array<{ listener: string; port: number }> = [];
    for (const listener of listeners) {
      const raw = environment[DEPLOYMENT_ENV_VARS.listeners[listener].port];
      if (raw !== undefined && /^[1-9][0-9]{0,4}$/.test(raw.trim())) {
        const port = Number(raw.trim());
        if (port >= 1 && port <= 65535) portTargets.push({ listener, port });
      }
    }
    if (portTargets.length === 0) {
      writeLine('  no listener ports declared; workloads start outside saas:deploy');
      writeLine('  start the workloads:');
      writeLine('    compose: docker compose up -d  (deploy/compose; this run already replayed the templates)');
      writeLine('    systemd: see deploy/systemd/managed-saas/README.md');
      writeLine('    per-container readiness: model-router saas:deploy --role <role> --env-file <path>');
      finishStep('ok', 'probes green; start commands printed');
    } else {
      const checkPort = (target: { listener: string; port: number }): Promise<boolean> =>
        connectPortImpl('127.0.0.1', target.port, READINESS_QUICK_TIMEOUT_MS);
      const reachable = new Map<string, boolean>();
      for (const target of portTargets) reachable.set(target.listener, await checkPort(target));
      let closed = portTargets.filter((target) => !reachable.get(target.listener));
      if (closed.length === portTargets.length) {
        writeLine('  no declared listener ports are reachable yet (expected on cold start)');
        writeLine('  start the workloads:');
        writeLine('    compose: docker compose up -d  (deploy/compose; this run already replayed the templates)');
        writeLine('    systemd: see deploy/systemd/managed-saas/README.md');
        writeLine('    per-container readiness: model-router saas:deploy --role <role> --env-file <path>');
        finishStep('ok', `probes green; ${portTargets.length} declared port(s) not up yet`);
      } else {
        const deadline = now() + READINESS_POLL_TOTAL_MS;
        while (closed.length > 0 && now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, READINESS_POLL_INTERVAL_MS));
          for (const target of closed) {
            if (await checkPort(target)) reachable.set(target.listener, true);
          }
          closed = portTargets.filter((target) => !reachable.get(target.listener));
        }
        const openCount = [...reachable.values()].filter(Boolean).length;
        const detail = `${openCount}/${reachable.size} declared listener ports reachable`;
        if (closed.length > 0) {
          writeLine(`  unreachable after polling: ${closed.map((target) => target.listener).join(', ')}`);
          finishStep('ok', `${detail}; probes green — inspect the unreachable workload`);
        } else {
          finishStep('ok', detail);
        }
      }
    }

    // ---------- [7] report ----------
    beginStep('report', 'summary');
    result.status = preflight.kind === 'role' ? 'verified' : 'deployed';
    result.exitCode = 0;
    printReport(writeLine, steps, closingHint(preflight));
    finishStep('ok', `${result.status}`);
    return result;
  } catch (error) {
    const failure =
      error instanceof SaasOpsFailure
        ? error
        : new SaasDeployFailure(
            stepFailureCode(currentStep),
            process.env.SAAS_DEPLOY_DEBUG === '1'
              ? `${safeFailureMessage(currentStep)} [debug: ${String(error)}]`
              : safeFailureMessage(currentStep),
          );
    steps.push({ step: currentStep, status: 'failed', durationMs: now() - stepStartedAt, detail: failure.message });
    // Shared helpers only throw codes that are members of this command's union.
    result.failure = { code: failure.code as SaasDeployFailureCode };
    try {
      printReport(writeLine, steps, `saas:deploy failed at step "${currentStep}": ${failure.message}`);
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

function requireDeclarations(env: Record<string, string | undefined>, names: readonly string[], context: string): void {
  const missing = names.filter((name) => {
    const value = env[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new SaasDeployFailure(
      'MISSING_DECLARATION',
      `${context} readiness declarations are incomplete; missing: ${missing.join(', ')}`,
    );
  }
}

function plannedSteps(preflight: PreflightState, skipMigrate: boolean): string[] {
  if (preflight.kind === 'role') {
    return [
      `verify: run the ${preflight.plan.pgRole} runtime privilege probe`,
      'readiness: check declared listener ports',
    ];
  }
  const planLines: string[] = [];
  if (preflight.fresh) {
    planLines.push(
      `bootstrap: apply ${MAIN_TEMPLATE_FILE} (creates the migrator/control-plane/gateway logins and the ${SAAS_SCHEMA} schema) and initialize passwords for roles this run creates`,
    );
  }
  planLines.push(
    skipMigrate
      ? 'migrate: skipped (--skip-migrate)'
      : `migrate: run the registered SaaS migrations as ${MIGRATOR_PG_ROLE} (explicit; the product process never migrates)`,
    `roles: replay ${MAIN_TEMPLATE_FILE} and ${WORKER_TEMPLATE_FILE} (idempotent)`,
    'verify: migration registry check as the migrator, then each runtime role probe (control-plane, gateway, credential-validation-worker)',
    'readiness: poll declared listener ports, or print per-role start commands',
  );
  return planLines;
}

function stepFailureCode(step: SaasDeployStepName): SaasDeployFailureCode {
  switch (step) {
    case 'preflight':
      return 'PREFLIGHT_FAILED';
    case 'bootstrap':
      return 'BOOTSTRAP_FAILED';
    case 'migrate':
      return 'MIGRATE_FAILED';
    case 'roles':
      return 'ROLES_FAILED';
    case 'verify':
      return 'VERIFY_FAILED';
    case 'readiness':
      return 'READINESS_FAILED';
    default:
      return 'REPORT_FAILED';
  }
}

function safeFailureMessage(step: SaasDeployStepName): string {
  switch (step) {
    case 'preflight':
      return 'preflight failed; details were redacted — verify connectivity and the deployment declarations';
    case 'bootstrap':
      return 'the fresh-deployment bootstrap failed; the role template is a single transaction and rolled back';
    case 'migrate':
      return 'SaaS database migrations failed';
    case 'roles':
      return 'role template replay failed';
    case 'verify':
      return 'a runtime privilege probe failed';
    default:
      return `saas:deploy failed at step "${step}"`;
  }
}

function closingHint(preflight: PreflightState): string {
  if (preflight.kind === 'role') {
    return 'next steps: single-role verification passed; the workload startup gates can now bind';
  }
  return 'next steps: start the workloads (deploy/compose or deploy/systemd/managed-saas), then optionally re-run saas:deploy --role <role> per container';
}

function printReport(writeLine: (line: string) => void, steps: readonly SaasDeployStepRecord[], closing: string): void {
  writeLine('saas:deploy report');
  for (const step of steps) {
    writeLine(
      `  ${step.step.padEnd(10)} ${step.status.padEnd(7)} ${String(step.durationMs).padStart(7)}ms  ${step.detail}`,
    );
  }
  writeLine(closing);
}
