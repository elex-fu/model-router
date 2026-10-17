import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL } from '../saas/db/credential-validation-worker-privileges.js';
import {
  SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS,
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
} from '../saas/db/runtime-privileges.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlExecutor } from '../saas/db/types.js';
import { DEPLOYMENT_ENV_VARS } from '../saas/deployment.js';

/**
 * Primitives shared by the managed SaaS orchestration commands
 * (`saas:deploy` and `saas:upgrade`). Extracted verbatim from
 * `src/cli/saas-deploy.ts` (DOps plan §5) so the upgrade command reuses the
 * deployment's URL contract, pool policy, template replay, and grant
 * diagnostics instead of re-implementing them.
 *
 * Red lines carried over: credentials are accepted but never echoed; the
 * templates replay inside a single transaction; probes run as the runtime
 * logins themselves.
 */

/** Administrator connection used for template replay; never a SaaS application login. */
export const SAAS_DEPLOY_ADMIN_URL_ENV = 'MODEL_ROUTER_SAAS_DEPLOY_ADMIN_URL' as const;

export type SaasDeployRole = 'control-plane' | 'gateway' | 'credential-validation-worker';

/**
 * Operational failure carrying a machine-readable code. The `code` is a
 * plain string so both command modules can narrow it to their own union at
 * the result boundary.
 */
export class SaasOpsFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RolePlan {
  readonly role: SaasDeployRole;
  readonly pgRole: string;
  readonly urlEnvName: string;
  readonly readinessEnvNames: readonly string[];
  readonly listeners: readonly ('customer' | 'platform' | 'gateway')[];
}

export const SAAS_SCHEMA = 'model_router_saas';
export const MIGRATOR_PG_ROLE = 'model_router_saas_migrator';
export const MAIN_TEMPLATE_FILE = 'managed-saas-postgres-roles.sql';
export const WORKER_TEMPLATE_FILE = 'managed-saas-validation-worker-role-grants.sql';
export const POSTGRES_VERSION_MINIMUM = 150000;

export const ROLE_PLANS: readonly RolePlan[] = [
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

export const WORKER_ROLE_PLAN = ROLE_PLANS[2];
export const ALL_APPLICATION_PG_ROLES: readonly string[] = [MIGRATOR_PG_ROLE, ...ROLE_PLANS.map((plan) => plan.pgRole)];

export function planByPgRole(pgRole: string): RolePlan {
  const plan = ROLE_PLANS.find((candidate) => candidate.pgRole === pgRole);
  if (!plan) throw new SaasOpsFailure('INVALID_OPTIONS', `unknown role ${pgRole}`);
  return plan;
}

/** Explicit override for deployments whose package layout differs (e.g. compose mounts). */
export const SAAS_DEPLOY_TEMPLATE_DIR_ENV = 'MODEL_ROUTER_SAAS_DEPLOY_TEMPLATE_DIR' as const;

export function defaultTemplateDir(): string {
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
      throw new SaasOpsFailure('ENV_FILE_INVALID', `${source} line ${index + 1}: "export" prefix is not supported`);
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new SaasOpsFailure('ENV_FILE_INVALID', `${source} line ${index + 1}: expected KEY=VALUE`);
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SaasOpsFailure('ENV_FILE_INVALID', `${source} line ${index + 1}: invalid variable name`);
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

export interface ValidatedUrl {
  readonly url: URL;
  readonly username: string;
  readonly password: string;
}

/**
 * Fully explicit endpoint/identity. Only `sslmode` may appear as a query
 * parameter so nothing can override the explicit host, database, or options;
 * credentials are accepted but never echoed.
 */
export function validateDatabaseUrl(
  raw: unknown,
  context: { name: string; requireUser?: string; forbidUsers?: readonly string[]; allowLocalPlaintext: boolean },
): ValidatedUrl {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SaasOpsFailure('MISSING_DECLARATION', `${context.name} is required for this command`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SaasOpsFailure('INVALID_DATABASE_URL', `${context.name} must be a valid PostgreSQL URL`);
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
    throw new SaasOpsFailure('INVALID_DATABASE_URL', `${context.name} must be a valid PostgreSQL URL`);
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
    throw new SaasOpsFailure('INVALID_DATABASE_URL', `${context.name} must identify an explicit PostgreSQL server`);
  }
  if (context.requireUser !== undefined && username !== context.requireUser) {
    throw new SaasOpsFailure(
      'INVALID_DATABASE_URL',
      `${context.name} must authenticate as the ${context.requireUser} login`,
    );
  }
  if (context.forbidUsers?.includes(username)) {
    throw new SaasOpsFailure(
      'INVALID_DATABASE_URL',
      `${context.name} must not authenticate as a SaaS application login`,
    );
  }
  return { url, username, password };
}

export interface SaasDeployPoolOptions {
  allowLocalPlaintext: boolean;
  applicationName: string;
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
      if (idleConnectionFailed) throw new Error('database connection failed');
    },
  };
}

export async function applyTemplateSql(pool: SaasDatabasePool, sql: string): Promise<void> {
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
export async function applyRolePassword(pool: SaasDatabasePool, pgRole: string, password: string): Promise<void> {
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

export interface MissingGrantRow {
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

export interface MissingGrant {
  readonly table: string;
  readonly column: string;
  readonly privilege: string;
}

async function queryMissingColumnGrants(
  executor: SqlExecutor,
  grants: ReadonlyArray<readonly [table: string, column: string, privilege: string]>,
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
export async function diagnoseMissingRuntimeGrants(
  role: SaasDeployRole,
  executor: SqlExecutor,
): Promise<MissingGrant[]> {
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

/**
 * Human-readable missing-grant summary for a failed runtime probe
 * (`table.column:PRIVILEGE, …`), best-effort by design: the probe failure
 * itself stays authoritative.
 */
export async function missingRuntimeGrantSummary(role: SaasDeployRole, executor: SqlExecutor): Promise<string[]> {
  try {
    const grants = await diagnoseMissingRuntimeGrants(role, executor);
    const named = grants.slice(0, 50).map((grant) => `${grant.table}.${grant.column}:${grant.privilege}`);
    if (grants.length > 50) named.push(`… and ${grants.length - 50} more`);
    return named;
  } catch {
    return [];
  }
}

export async function connectPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
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

export interface ServerInfo {
  readonly versionNum: number;
  readonly currentUser: string;
  readonly currentDatabase: string;
  readonly superuser: boolean;
  readonly createrole: boolean;
}

export async function serverInfo(pool: SaasDatabasePool): Promise<ServerInfo> {
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
    throw new SaasOpsFailure('PREFLIGHT_FAILED', 'Unable to read the PostgreSQL server identity');
  }
  return {
    versionNum,
    currentUser: row.current_user,
    currentDatabase: row.current_database,
    superuser: row.rolsuper,
    createrole: row.rolcreaterole,
  };
}

export function assertServerVersion(versionNum: number): string {
  if (versionNum < POSTGRES_VERSION_MINIMUM) {
    throw new SaasOpsFailure(
      'PREFLIGHT_FAILED',
      `PostgreSQL 15 or later is required (server_version_num=${versionNum})`,
    );
  }
  return `${Math.floor(versionNum / 10000)}.${Math.floor((versionNum % 10000) / 100)}`;
}

export function assertNotMaintenanceDatabase(database: string): void {
  if (database === 'postgres' || database.startsWith('template')) {
    throw new SaasOpsFailure(
      'PREFLIGHT_FAILED',
      `this command targets the dedicated SaaS database; ${database} is a maintenance database`,
    );
  }
}

export async function schemaOwnership(pool: SaasDatabasePool): Promise<{ present: boolean; owner: string }> {
  const result = await pool.query<{ owner: unknown }>(
    'SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname = $1',
    [SAAS_SCHEMA],
  );
  if (result.rows.length === 0) return { present: false, owner: '' };
  const owner = result.rows[0].owner;
  if (typeof owner !== 'string' || owner === '') {
    throw new SaasOpsFailure('PREFLIGHT_FAILED', 'Unable to read the application schema owner');
  }
  return { present: true, owner };
}

export function assertSchemaOwnership(schema: { present: boolean; owner: string }): void {
  if (schema.present && schema.owner !== MIGRATOR_PG_ROLE) {
    throw new SaasOpsFailure(
      'PREFLIGHT_FAILED',
      `schema ${SAAS_SCHEMA} must be owned by ${MIGRATOR_PG_ROLE} (current owner: ${schema.owner}); review ownership explicitly`,
    );
  }
}

export async function rolePresence(pool: SaasDatabasePool): Promise<Set<string>> {
  const result = await pool.query<{ rolname: unknown }>(
    'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1)',
    [[...ALL_APPLICATION_PG_ROLES]],
  );
  return new Set(result.rows.map((row) => row.rolname).filter((name): name is string => typeof name === 'string'));
}
