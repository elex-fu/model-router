import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
  verifyCredentialValidationWorkerRuntimePrivileges,
} from '../saas/db/credential-validation-worker-privileges.js';
import { runSaasMigrations, verifySaasMigrations } from '../saas/db/migrate.js';
import {
  SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS,
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
  verifySaasRuntimeDatabasePrivileges,
} from '../saas/db/runtime-privileges.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlExecutor } from '../saas/db/types.js';
import { DEPLOYMENT_ENV_VARS } from '../saas/deployment.js';

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

/** Administrator connection used for template replay; never a SaaS application login. */
export const SAAS_DEPLOY_ADMIN_URL_ENV = 'MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL' as const;

export type SaasDeployRole = 'control-plane' | 'gateway' | 'credential-validation-worker';

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

export interface SaasDeployPoolOptions {
  allowLocalPlaintext: boolean;
  applicationName: string;
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

class SaasDeployFailure extends Error {
  constructor(
    readonly code: SaasDeployFailureCode,
    message: string,
  ) {
    super(message);
  }
}

interface RolePlan {
  readonly role: SaasDeployRole;
  readonly pgRole: string;
  readonly urlEnvName: string;
  readonly readinessEnvNames: readonly string[];
  readonly listeners: readonly ('customer' | 'platform' | 'gateway')[];
}

const SAAS_SCHEMA = 'model_router_saas';
const MIGRATOR_PG_ROLE = 'model_router_saas_migrator';
const MAIN_TEMPLATE_FILE = 'managed-saas-postgres-roles.sql';
const WORKER_TEMPLATE_FILE = 'managed-saas-validation-worker-role-grants.sql';
const POSTGRES_VERSION_MINIMUM = 150000;
const READINESS_POLL_TOTAL_MS = 30_000;
const READINESS_QUICK_TIMEOUT_MS = 500;
const READINESS_POLL_INTERVAL_MS = 500;

const ROLE_PLANS: readonly RolePlan[] = [
  {
    role: 'control-plane',
    pgRole: 'model_router_saas_control_plane',
    urlEnvName: DEPLOYMENT_ENV_VARS.saas.controlPlaneDatabaseUrl,
    readinessEnvNames: [
      DEPLOYMENT_ENV_VARS.saas.redisUrl,
      DEPLOYMENT_ENV_VARS.saas.redisProviderModule,
      DEPLOYMENT_ENV_VARS.saas.credentialProviderModule,
    ],
    listeners: ['customer', 'platform'],
  },
  {
    role: 'gateway',
    pgRole: 'model_router_saas_gateway',
    urlEnvName: DEPLOYMENT_ENV_VARS.saas.gatewayDatabaseUrl,
    readinessEnvNames: [
      DEPLOYMENT_ENV_VARS.saas.gatewayProviderCredentialDecryptKmsModule,
      DEPLOYMENT_ENV_VARS.saas.gatewayRuntimeModule,
    ],
    listeners: ['gateway'],
  },
  {
    role: 'credential-validation-worker',
    pgRole: 'model_router_saas_validation_worker',
    urlEnvName: DEPLOYMENT_ENV_VARS.saas.validationWorkerDatabaseUrl,
    readinessEnvNames: [DEPLOYMENT_ENV_VARS.saas.validationWorkerProviderCredentialDecryptKmsModule],
    listeners: [],
  },
];

const WORKER_ROLE_PLAN = ROLE_PLANS[2];
const ALL_APPLICATION_PG_ROLES: readonly string[] = [MIGRATOR_PG_ROLE, ...ROLE_PLANS.map((plan) => plan.pgRole)];

/** Explicit override for deployments whose package layout differs (e.g. compose mounts). */
export const SAAS_DEPLOY_TEMPLATE_DIR_ENV = 'MODEL_ROUTER_SAAS_DEPLOY_TEMPLATE_DIR' as const;

function defaultTemplateDir(): string {
  const override = process.env[SAAS_DEPLOY_TEMPLATE_DIR_ENV];
  if (typeof override === 'string' && override.trim() !== '') return override;
  // Resolves to <package root>/deploy both from src/cli (tsx) and dist/cli.
  return resolve(__dirname, '..', '..', 'deploy');
}

/** Strict KEY=VALUE parsing; malformed lines fail without echoing any value. */
export function parseSaasDeployEnvFile(text: string, source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) {
      throw new SaasDeployFailure('ENV_FILE_INVALID', `${source} line ${index + 1}: "export" prefix is not supported`);
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new SaasDeployFailure('ENV_FILE_INVALID', `${source} line ${index + 1}: expected KEY=VALUE`);
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SaasDeployFailure('ENV_FILE_INVALID', `${source} line ${index + 1}: invalid variable name`);
    }
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

interface ValidatedUrl {
  readonly url: URL;
  readonly username: string;
  readonly password: string;
}

/**
 * Fully explicit endpoint/identity. Only `sslmode` may appear as a query
 * parameter so nothing can override the explicit host, database, or options;
 * credentials are accepted but never echoed.
 */
function validateDatabaseUrl(
  raw: unknown,
  context: { name: string; requireUser?: string; forbidUsers?: readonly string[]; allowLocalPlaintext: boolean },
): ValidatedUrl {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SaasDeployFailure('MISSING_DECLARATION', `${context.name} is required for saas:deploy`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SaasDeployFailure('INVALID_DATABASE_URL', `${context.name} must be a valid PostgreSQL URL`);
  }
  const sslmode = url.searchParams.get('sslmode');
  const port = url.port ? Number(url.port) : 5432;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  // The designated CI PostgreSQL service shares the explicit-plaintext policy
  // with loopback disposable clusters (same rule as the drill/track-F gates).
  const designatedCIService = hostname === 'postgres' && port === 5432;
  let username = '';
  let password = '';
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new SaasDeployFailure('INVALID_DATABASE_URL', `${context.name} must be a valid PostgreSQL URL`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    !username ||
    url.hash !== '' ||
    decodeURIComponent(url.pathname.slice(1)) === '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    url.searchParams.getAll('sslmode').length > 1 ||
    (sslmode !== null && !['disable', 'require', 'verify-full'].includes(sslmode)) ||
    (sslmode === 'disable' && (!context.allowLocalPlaintext || (!loopback && !designatedCIService)))
  ) {
    throw new SaasDeployFailure('INVALID_DATABASE_URL', `${context.name} must identify an explicit PostgreSQL server`);
  }
  if (context.requireUser !== undefined && username !== context.requireUser) {
    throw new SaasDeployFailure(
      'INVALID_DATABASE_URL',
      `${context.name} must authenticate as the ${context.requireUser} login`,
    );
  }
  if (context.forbidUsers?.includes(username)) {
    throw new SaasDeployFailure(
      'INVALID_DATABASE_URL',
      `${context.name} must not authenticate as a SaaS application login`,
    );
  }
  return { url, username, password };
}

/** Default pool factory; mirrors the audit command's explicit TLS policy. */
export function createSaasDeployPool(connectionString: string, options: SaasDeployPoolOptions): SaasDatabasePool {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get('sslmode');
  const password = decodeURIComponent(url.password);
  const pool = new Pool({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    // A function is intentional: an empty explicit password must not fall back to PGPASSWORD.
    password: () => password,
    ssl: sslmode === 'disable' ? false : { rejectUnauthorized: true },
    application_name: options.applicationName,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
  });
  let idleConnectionFailed = false;
  pool.on('error', () => {
    idleConnectionFailed = true;
  });
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await pool.query(sql, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    async connect(): Promise<SaasDatabaseClient> {
      const client = await pool.connect();
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await client.query(sql, values ? [...values] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release: (error) => client.release(error),
      };
    },
    async end() {
      await pool.end();
      if (idleConnectionFailed) throw new Error('saas:deploy database connection failed');
    },
  };
}

async function applyTemplateSql(pool: SaasDatabasePool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    // The templates are single BEGIN..COMMIT scripts; one multi-statement
    // simple query keeps them atomic and preserves ON_ERROR_STOP semantics.
    await client.query(sql);
  } catch (error) {
    client.release(true);
    throw error;
  }
  client.release();
}

/** Sets a login password from a deployment URL; the value is never printed. */
async function applyRolePassword(pool: SaasDatabasePool, pgRole: string, password: string): Promise<void> {
  const client = await pool.connect();
  try {
    const built = await client.query<{ statement: string }>(
      "SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS statement",
      [pgRole, password],
    );
    const statement = built.rows[0]?.statement;
    if (typeof statement !== 'string' || statement === '') {
      throw new Error('Unable to build the role password statement');
    }
    await client.query(statement);
  } catch (error) {
    client.release(true);
    throw error;
  }
  client.release();
}

interface MissingGrantRow {
  readonly table_name: unknown;
  readonly column_name: unknown;
  readonly privilege_type: unknown;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-z0-9_]+$/.test(value);
}

function expectedValues(
  grants: ReadonlyArray<readonly [table: string, column: string, privilege: string]>,
): string | null {
  for (const [table, column, privilege] of grants) {
    if (!isSafeIdentifier(table) || !isSafeIdentifier(column) || !/^[A-Z]+$/.test(privilege)) return null;
  }
  return grants.map(([table, column, privilege]) => `('${table}', '${column}', '${privilege}')`).join(',\n    ');
}

/** The worker's expected column manifest lives inside its probe SQL; extract it from the same source. */
export function parseWorkerExpectedColumnGrants(): ReadonlyArray<readonly [string, string, string]> {
  const marker = 'expected_column_privileges(table_name, column_name, privilege_type) AS (';
  const sql = SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL;
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error('Unable to locate the worker expected-column manifest');
  const end = sql.indexOf('\n)', start);
  if (end < 0) throw new Error('Unable to parse the worker expected-column manifest');
  const section = sql.slice(start + marker.length, end);
  const pattern = /\('([a-z0-9_]+)', '([a-z0-9_]+)', '(SELECT|INSERT|UPDATE|DELETE)'\)/g;
  const grants: Array<readonly [string, string, string]> = [];
  for (const match of section.matchAll(pattern)) {
    grants.push([match[1], match[2], match[3]]);
  }
  if (grants.length === 0) throw new Error('The worker expected-column manifest is empty');
  return grants;
}

interface MissingGrant {
  readonly table: string;
  readonly column: string;
  readonly privilege: string;
}

async function queryMissingColumnGrants(
  executor: SqlExecutor,
  grants: ReadonlyArray<readonly [string, string, string]>,
): Promise<MissingGrant[]> {
  const values = expectedValues(grants);
  if (values === null) return [];
  const result = await executor.query<MissingGrantRow>(`
    WITH expected(table_name, column_name, privilege_type) AS (
      VALUES
    ${values}
    )
    SELECT table_name, column_name, privilege_type
    FROM expected
    WHERE pg_catalog.has_column_privilege(
      current_user,
      '${SAAS_SCHEMA}.' || table_name,
      column_name,
      privilege_type
    ) IS NOT TRUE
    ORDER BY table_name, column_name, privilege_type
  `);
  return result.rows
    .filter((row) => typeof row.table_name === 'string' && typeof row.column_name === 'string')
    .map((row) => ({
      table: row.table_name as string,
      column: row.column_name as string,
      privilege: String(row.privilege_type ?? ''),
    }));
}

async function queryMissingTableGrants(
  executor: SqlExecutor,
  grants: ReadonlyArray<readonly [table: string, privilege: string]>,
): Promise<MissingGrant[]> {
  if (grants.length === 0) return [];
  for (const [table, privilege] of grants) {
    if (!isSafeIdentifier(table) || !/^[A-Z]+$/.test(privilege)) return [];
  }
  const checks = grants
    .map(
      ([table, privilege]) =>
        `(pg_catalog.has_table_privilege(current_user, '${SAAS_SCHEMA}.${table}', '${privilege}'), '${table}', '${privilege}')`,
    )
    .join(',\n    ');
  const result = await executor.query<MissingGrantRow>(`
    SELECT * FROM (VALUES
    ${checks}
    ) AS checks(granted, table_name, privilege_type)
    WHERE granted IS NOT TRUE
    ORDER BY table_name
  `);
  return result.rows
    .filter((row) => typeof row.table_name === 'string')
    .map((row) => ({
      table: row.table_name as string,
      column: '(table)',
      privilege: String(row.privilege_type ?? ''),
    }));
}

/** Gateway read relations require SELECT on every present column. */
async function queryMissingGatewayReadColumns(
  executor: SqlExecutor,
  tables: readonly string[],
): Promise<MissingGrant[]> {
  if (tables.length === 0 || tables.some((table) => !isSafeIdentifier(table))) return [];
  const values = tables.map((table) => `('${table}')`).join(',\n    ');
  const result = await executor.query<MissingGrantRow>(`
    WITH read_tables(table_name) AS (
      VALUES
    ${values}
    ),
    present_columns AS (
      SELECT read_tables.table_name, attribute.attname AS column_name
      FROM read_tables
      JOIN pg_catalog.pg_class AS relation
        ON relation.relname = read_tables.table_name
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace AND namespace.nspname = '${SAAS_SCHEMA}'
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    )
    SELECT table_name, column_name, 'SELECT' AS privilege_type
    FROM present_columns
    WHERE pg_catalog.has_column_privilege(
      current_user,
      '${SAAS_SCHEMA}.' || table_name,
      column_name,
      'SELECT'
    ) IS NOT TRUE
    ORDER BY table_name, column_name
  `);
  return result.rows
    .filter((row) => typeof row.table_name === 'string' && typeof row.column_name === 'string')
    .map((row) => ({
      table: row.table_name as string,
      column: row.column_name as string,
      privilege: 'SELECT',
    }));
}

/** Precise table/column/privilege diagnostics for a failed runtime probe. */
async function diagnoseMissingRuntimeGrants(role: SaasDeployRole, executor: SqlExecutor): Promise<MissingGrant[]> {
  if (role === 'control-plane') {
    return [
      ...(await queryMissingColumnGrants(executor, SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS)),
      ...(await queryMissingTableGrants(executor, SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS)),
    ];
  }
  if (role === 'gateway') {
    return [
      ...(await queryMissingColumnGrants(executor, SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS)),
      ...(await queryMissingGatewayReadColumns(executor, SAAS_GATEWAY_RUNTIME_READ_TABLES)),
      ...(await queryMissingTableGrants(executor, [
        ['saas_billing_spending_freezes', 'DELETE'],
        ['saas_provider_account_lease_fencing_seq', 'USAGE'],
      ])),
    ];
  }
  return queryMissingColumnGrants(executor, parseWorkerExpectedColumnGrants());
}

async function connectPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import('node:net');
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
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

interface ServerInfo {
  readonly versionNum: number;
  readonly currentUser: string;
  readonly currentDatabase: string;
  readonly superuser: boolean;
  readonly createrole: boolean;
}

async function serverInfo(pool: SaasDatabasePool): Promise<ServerInfo> {
  const result = await pool.query<{
    server_version_num?: unknown;
    current_user?: unknown;
    current_database?: unknown;
    rolsuper?: unknown;
    rolcreaterole?: unknown;
  }>(
    "SELECT current_setting('server_version_num')::integer AS server_version_num, current_user, current_database() AS current_database, rol.rolsuper, rol.rolcreaterole FROM pg_catalog.pg_roles AS rol WHERE rol.rolname = current_user",
  );
  const row = result.rows[0];
  const versionNum = Number(row?.server_version_num);
  if (
    !Number.isSafeInteger(versionNum) ||
    versionNum < 1 ||
    typeof row?.current_user !== 'string' ||
    row.current_user === '' ||
    typeof row?.current_database !== 'string' ||
    row.current_database === '' ||
    typeof row?.rolsuper !== 'boolean' ||
    typeof row?.rolcreaterole !== 'boolean'
  ) {
    throw new SaasDeployFailure('PREFLIGHT_FAILED', 'Unable to read the PostgreSQL server identity');
  }
  return {
    versionNum,
    currentUser: row.current_user,
    currentDatabase: row.current_database,
    superuser: row.rolsuper,
    createrole: row.rolcreaterole,
  };
}

function assertServerVersion(versionNum: number): string {
  if (versionNum < POSTGRES_VERSION_MINIMUM) {
    throw new SaasDeployFailure(
      'PREFLIGHT_FAILED',
      `PostgreSQL 15 or later is required (server_version_num=${versionNum})`,
    );
  }
  return `${Math.floor(versionNum / 10000)}.${Math.floor((versionNum % 10000) / 100)}`;
}

function assertNotMaintenanceDatabase(database: string): void {
  if (database === 'postgres' || database.startsWith('template')) {
    throw new SaasDeployFailure(
      'PREFLIGHT_FAILED',
      `saas:deploy targets the dedicated SaaS database; ${database} is a maintenance database`,
    );
  }
}

async function schemaOwnership(pool: SaasDatabasePool): Promise<{ present: boolean; owner: string }> {
  const result = await pool.query<{ owner: unknown }>(
    'SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname = $1',
    [SAAS_SCHEMA],
  );
  if (result.rows.length === 0) return { present: false, owner: '' };
  const owner = result.rows[0].owner;
  if (typeof owner !== 'string' || owner === '') {
    throw new SaasDeployFailure('PREFLIGHT_FAILED', 'Unable to read the application schema owner');
  }
  return { present: true, owner };
}

function assertSchemaOwnership(schema: { present: boolean; owner: string }): void {
  if (schema.present && schema.owner !== MIGRATOR_PG_ROLE) {
    throw new SaasDeployFailure(
      'PREFLIGHT_FAILED',
      `schema ${SAAS_SCHEMA} must be owned by ${MIGRATOR_PG_ROLE} (current owner: ${schema.owner}); review ownership explicitly`,
    );
  }
}

async function rolePresence(pool: SaasDatabasePool): Promise<Set<string>> {
  const result = await pool.query<{ rolname: unknown }>(
    'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1)',
    [[...ALL_APPLICATION_PG_ROLES]],
  );
  return new Set(result.rows.map((row) => row.rolname).filter((name): name is string => typeof name === 'string'));
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

  // Resolved (validated) deployment URLs, keyed by PostgreSQL role name.
  const resolvedUrls = new Map<string, ValidatedUrl>();
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
  let environment: Record<string, string | undefined> | undefined;
  const envValue = (name: string): string | undefined => (environment ?? dependencies.env ?? process.env)[name];

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
    const templateDir = defaultTemplateDir();
    const loadTemplate = async (file: string): Promise<string> => {
      try {
        return await readFileImpl(join(templateDir, file));
      } catch {
        throw new SaasDeployFailure('ROLES_FAILED', `Unable to read the role template: ${file}`);
      }
    };

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
        const missing: string[] = [];
        try {
          const grants = await diagnoseMissingRuntimeGrants(plan.role, pool);
          for (const grant of grants.slice(0, 50)) missing.push(`${grant.table}.${grant.column}:${grant.privilege}`);
          if (grants.length > 50) missing.push(`… and ${grants.length - 50} more`);
        } catch {
          // Diagnostics are best-effort; the probe failure itself is authoritative.
        }
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
      error instanceof SaasDeployFailure
        ? error
        : new SaasDeployFailure(
            stepFailureCode(currentStep),
            process.env.SAAS_DEPLOY_DEBUG === '1'
              ? `${safeFailureMessage(currentStep)} [debug: ${String(error)}]`
              : safeFailureMessage(currentStep),
          );
    steps.push({ step: currentStep, status: 'failed', durationMs: now() - stepStartedAt, detail: failure.message });
    result.failure = { code: failure.code };
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

function planByPgRole(pgRole: string): RolePlan {
  const plan = ROLE_PLANS.find((candidate) => candidate.pgRole === pgRole);
  if (!plan) throw new SaasDeployFailure('INVALID_OPTIONS', `unknown role ${pgRole}`);
  return plan;
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
