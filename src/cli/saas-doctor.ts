import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Pool } from 'pg';
import {
  SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
  verifyCredentialValidationWorkerRuntimePrivileges,
} from '../saas/db/credential-validation-worker-privileges.js';
import { verifySaasMigrations } from '../saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../saas/db/migrations/001_initial_schema.js';
import {
  GATEWAY_DELETE_TABLES,
  SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS,
  SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS,
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
  verifySaasRuntimeDatabasePrivileges,
} from '../saas/db/runtime-privileges.js';
import type { SaasDatabaseClient, SaasDatabasePool } from '../saas/db/types.js';
import { resolveSaasDatabasePoolSettings } from '../saas/db/database.js';
import {
  MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  MODEL_ROUTER_SAAS_DATABASE_URL,
  MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  MODEL_ROUTER_SAAS_REDIS_URL,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE,
  SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE,
  parseDeploymentConfig,
} from '../saas/deployment.js';
import { loadPaymentDeployment } from '../saas/runtime/payment-deployment.js';
import { loadCommercialAttestationTrust, COMMERCIAL_ATTESTATION_TRUST_FILE } from '../saas/runtime/commercial-attestation-trust.js';
import { loadResponsesContinuationDeployment } from '../saas/runtime/responses-continuation-deployment.js';
import { codexTrustedBoundReadiness } from '../saas/runtime/codex-trusted-bound-profiles.js';
import { CONCURRENCY_INFLIGHT_HORIZON_SECONDS } from '../saas/gateway/postgres-preparation-capacity.js';
import {
  type GatewayCapabilityStatus,
  readGatewayCapabilityStatus,
} from '../saas/runtime/gateway-capability-status.js';
import { loadGatewayProviderCredentialUnsealingKms } from '../saas/runtime/gateway-provider-credential-kms.js';
import { loadProviderCredentialSealingKms } from '../saas/runtime/provider-credential-kms.js';
import { loadProviderCredentialRewrappingKms } from '../saas/runtime/provider-credential-rewrapping-kms.js';
import { RedisRespClient, RedisRespError } from '../saas/runtime/redis-resp-client.js';
import { loadValidationWorkerProviderCredentialKms } from '../saas/runtime/validation-worker-provider-credential-kms.js';

/**
 * `saas:doctor` — the leveled one-command diagnostic (docs/
 * deployment-ops-efficiency-plan-2026-10-17.md §3). Read-only by
 * construction: every probe is an existing verify function, a SELECT, a KMS
 * checkReady load, a Redis PING, or a filesystem posture read. No writes, no
 * schema changes, and no secret value is ever reported — only key names,
 * counts, versions, and safe error codes.
 */

export const SAAS_DOCTOR_FORMAT = 'saas-doctor-command-v1' as const;

export type SaasDoctorRole = 'combined' | 'control-plane' | 'gateway' | 'credential-validation-worker';

export type SaasDoctorCheckId =
  | 'pg-migrations'
  | 'role-privileges'
  | 'kms-readiness'
  | 'payments-readiness'
  | 'commercial-attestation-trust'
  | 'request-diagnostics'
  | 'responses-history'
  | 'redis-contract'
  | 'gateway-capabilities'
  | 'stuck-executions'
  | 'recovery-sweep'
  | 'health-self-heal'
  | 'spending-freezes'
  | 'systemd-posture';

export type SaasDoctorCheckLevel = 'pass' | 'warn' | 'fail';

export interface SaasDoctorCheckResult {
  readonly check: SaasDoctorCheckId;
  readonly level: SaasDoctorCheckLevel;
  readonly detail: string;
  readonly hint: string;
}

export interface SaasDoctorSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
}

export interface SaasDoctorResult {
  readonly format: typeof SAAS_DOCTOR_FORMAT;
  readonly role: SaasDoctorRole;
  readonly summary: SaasDoctorSummary;
  readonly checks: readonly SaasDoctorCheckResult[];
  readonly exitCode: 0 | 1;
  readonly gatewayCapabilities?: GatewayCapabilityStatus;
}

export interface SaasDoctorCommandOptions {
  readonly role?: string;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

/** Closable readiness surface shared by every KMS loader result. */
interface DoctorKmsHandle {
  close(): Promise<void>;
}

export interface SaasDoctorRedisProbe {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface SaasDoctorFilesystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** File permission bits masked to 0o777; only the mode is ever reported. */
  mode(path: string): number;
}

export interface SaasDoctorDependencies {
  env?: NodeJS.ProcessEnv;
  createPool?: (connectionString: string) => SaasDatabasePool;
  loadSealingKms?: (options: { env: NodeJS.ProcessEnv }) => Promise<DoctorKmsHandle | undefined>;
  loadRewrappingKms?: (options: { env: NodeJS.ProcessEnv }) => Promise<DoctorKmsHandle | undefined>;
  loadGatewayUnsealingKms?: (options: { env: NodeJS.ProcessEnv }) => Promise<DoctorKmsHandle | undefined>;
  loadValidationWorkerKms?: (options: { env: NodeJS.ProcessEnv }) => Promise<DoctorKmsHandle | undefined>;
  connectRedis?: (url: string) => Promise<SaasDoctorRedisProbe>;
  fs?: SaasDoctorFilesystem;
  /** Overrides for the ported systemd posture check (tests and non-default hosts). */
  unitsDir?: string;
  envDir?: string;
  writeLine?: (line: string) => void;
  readGatewayCapabilities?: (env: NodeJS.ProcessEnv) => Promise<GatewayCapabilityStatus>;
}

export class SaasDoctorOptionsError extends Error {
  constructor() {
    super('saas:doctor --role must be exactly combined, control-plane, gateway, or credential-validation-worker');
    this.name = 'SaasDoctorOptionsError';
  }
}

const DOCTOR_ROLES: readonly SaasDoctorRole[] = [
  'combined',
  'control-plane',
  'gateway',
  'credential-validation-worker',
];

const ROLE_DATABASE_URL_ENV: Readonly<Record<SaasDoctorRole, string>> = {
  combined: MODEL_ROUTER_SAAS_DATABASE_URL,
  'control-plane': MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  gateway: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  'credential-validation-worker': MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
};

const PG_VERSION_MINIMUM = 150_000;
/** Mirrors STALE_ADMISSION_HORIZON_MS (recovery sweep) and the H2 in-flight horizon. */
const HEALTH_STALE_HORIZON_SECONDS = 600;
const MAX_NAMED_MISSING_GRANTS = 20;
const POSTGRES_URL_PROTOCOLS = ['postgres:', 'postgresql:'];

function isDoctorRole(value: string): value is SaasDoctorRole {
  return (DOCTOR_ROLES as readonly string[]).includes(value);
}

/**
 * Probe provenance for passing checks; printed with --verbose so an operator
 * can reproduce every step by hand (plan §9 discipline).
 */
const PROBE_HINTS: Readonly<Record<SaasDoctorCheckId, string>> = Object.freeze({
  'pg-migrations': 'probe: SELECT server_version_num + verifySaasMigrations against the migration registry constant',
  'role-privileges': 'probe: verifySaasRuntimeDatabasePrivileges / verifyCredentialValidationWorkerRuntimePrivileges',
  'kms-readiness': 'probe: per-role KMS module load + checkReady, then close',
  'payments-readiness': 'probe: read-only descriptor and credential loading; no PSP request or activation',
  'commercial-attestation-trust': 'probe: bounded public verification key and suite digest file loading',
  'request-diagnostics': 'probe: sampling configuration only; no request or log emission',
  'responses-history': 'probe: schema and SELECT/INSERT/DELETE privilege checks plus production KMS canary; no history row write or purge',
  'redis-contract': 'probe: RedisRespClient RESP2 connect + PING within REDIS_RESP_BOUNDS',
  'gateway-capabilities':
    'probe: bounded GET /readyz on the configured running gateway; sanitized provider capability facts',
  'stuck-executions':
    'probe: read-only count over saas_requests/saas_attempts past CONCURRENCY_INFLIGHT_HORIZON_SECONDS',
  'recovery-sweep': 'probe: read-only count over saas_unknown_outcome_reconciliation_cases (open cases)',
  'health-self-heal': 'probe: read-only count over saas_provider_account_runtime_health (migration 040)',
  'spending-freezes': 'probe: read-only count over saas_billing_spending_freezes',
  'systemd-posture': 'probe: ported scripts/check-managed-saas-deployment.mjs unit and environment posture checks',
});

function pass(check: SaasDoctorCheckId, detail: string, hint = PROBE_HINTS[check]): SaasDoctorCheckResult {
  return { check, level: 'pass', detail, hint };
}

function warn(check: SaasDoctorCheckId, detail: string, hint: string): SaasDoctorCheckResult {
  return { check, level: 'warn', detail, hint };
}

function fail(check: SaasDoctorCheckId, detail: string, hint: string): SaasDoctorCheckResult {
  return { check, level: 'fail', detail, hint };
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown failure';
}

function nonNegativeCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return null;
}

function safeRedisCode(error: unknown): string {
  if (error instanceof RedisRespError) return error.code;
  return 'REDIS_CONNECTION_FAILED';
}

function createDoctorPool(connectionString: string): SaasDatabasePool {
  // Validate just enough to hand a well-formed libpq URL to the driver; the
  // deployment itself owns the full URL contract. Read-only usage only.
  const url = new URL(connectionString);
  if (!POSTGRES_URL_PROTOCOLS.includes(url.protocol) || url.hostname.length === 0) {
    throw new Error('Invalid PostgreSQL connection URL');
  }
  const pool = new Pool({
    connectionString,
    application_name: 'model-router-saas-doctor',
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
      if (idleConnectionFailed) throw new Error('Doctor database connection failed');
    },
  };
}

interface DoctorDatabaseContext {
  readonly url: string | undefined;
  readonly urlEnvName: string;
  pool: SaasDatabasePool | undefined;
  /** Set once the pool could not be created or connectivity is disproven. */
  unreachable: boolean;
}

interface DoctorContext {
  readonly role: SaasDoctorRole;
  readonly env: NodeJS.ProcessEnv;
  readonly dependencies: SaasDoctorDependencies;
  database: DoctorDatabaseContext | undefined;
}

function checkScopes(role: SaasDoctorRole): readonly SaasDoctorCheckId[] {
  const controlPlane: readonly SaasDoctorCheckId[] = [
    'pg-migrations',
    'role-privileges',
    'kms-readiness',
    'redis-contract',
    'stuck-executions',
    'recovery-sweep',
    'health-self-heal',
    'spending-freezes',
    'systemd-posture',
  ];
  switch (role) {
    case 'combined':
    case 'control-plane':
      return controlPlane;
    case 'gateway':
      return ['pg-migrations', 'role-privileges', 'kms-readiness', 'redis-contract'];
    case 'credential-validation-worker':
      return ['pg-migrations', 'role-privileges', 'kms-readiness'];
  }
}

function resolveRole(options: SaasDoctorCommandOptions, env: NodeJS.ProcessEnv): SaasDoctorRole {
  const requested = options.role;
  if (requested !== undefined) {
    if (!isDoctorRole(requested)) throw new SaasDoctorOptionsError();
    return requested;
  }
  const configured = env[MODEL_ROUTER_SAAS_WORKLOAD_ROLE];
  if (configured !== undefined && isDoctorRole(configured)) return configured;
  const present = (name: string) => typeof env[name] === 'string' && env[name]?.trim() !== '';
  if (present(MODEL_ROUTER_SAAS_DATABASE_URL)) return 'combined';
  // An operator shell exporting exactly one role URL (for example after
  // sourcing a systemd per-role env file) diagnoses that role by default.
  const presentRoleUrls = DOCTOR_ROLES.filter((role) => role !== 'combined' && present(ROLE_DATABASE_URL_ENV[role]));
  if (presentRoleUrls.length === 1) return presentRoleUrls[0];
  return 'combined';
}

function openDatabase(context: DoctorContext): DoctorDatabaseContext {
  if (context.database) return context.database;
  const { role, env, dependencies } = context;
  const urlEnvName = ROLE_DATABASE_URL_ENV[role];
  const roleUrl = env[urlEnvName];
  let url: string | undefined;
  if (typeof roleUrl === 'string' && roleUrl.trim() !== '') {
    url = roleUrl;
  } else if (
    role !== 'combined' &&
    typeof env[MODEL_ROUTER_SAAS_DATABASE_URL] === 'string' &&
    env[MODEL_ROUTER_SAAS_DATABASE_URL]?.trim() !== ''
  ) {
    // A shared deployment URL may stand in only when the environment's own
    // workload role (or a combined dev deployment) matches the diagnosed role.
    const declared = env[MODEL_ROUTER_SAAS_WORKLOAD_ROLE];
    if (declared === role || declared === 'combined' || declared === undefined) {
      url = env[MODEL_ROUTER_SAAS_DATABASE_URL];
    }
  }
  const database: DoctorDatabaseContext = { url, urlEnvName, pool: undefined, unreachable: false };
  if (url !== undefined) {
    try {
      database.pool = (dependencies.createPool ?? createDoctorPool)(url);
    } catch {
      // A malformed URL is reported by the first database check, fail-closed.
      database.unreachable = true;
    }
  }
  context.database = database;
  return database;
}

async function closeDatabase(context: DoctorContext): Promise<void> {
  const database = context.database;
  if (database?.pool === undefined) return;
  try {
    await database.pool.end();
  } catch {
    // Closing failures never mask the diagnostic results already collected.
  }
}

function noDatabase(
  check: SaasDoctorCheckId,
  database: DoctorDatabaseContext,
  level: 'fail' | 'warn',
): SaasDoctorCheckResult {
  const detail = `no PostgreSQL URL configured for the diagnosed role (${database.urlEnvName} is unset)`;
  const hint = `set ${database.urlEnvName} to this workload's runtime role connection URL`;
  return level === 'fail' ? fail(check, detail, hint) : warn(check, detail, hint);
}

function unreachable(check: SaasDoctorCheckId, level: 'fail' | 'warn'): SaasDoctorCheckResult {
  const detail = 'unable to connect to PostgreSQL for this role';
  const hint = 'verify the database URL, credentials, network reachability, and TLS settings';
  return level === 'fail' ? fail(check, detail, hint) : warn(check, detail, hint);
}

function poolFailed(check: SaasDoctorCheckId, level: 'fail' | 'warn'): SaasDoctorCheckResult {
  const detail = 'database connection pool could not be created for this role (malformed URL)';
  const hint = 'verify the configured PostgreSQL URL is a well-formed postgres/postgresql connection string';
  return level === 'fail' ? fail(check, detail, hint) : warn(check, detail, hint);
}

/** Fail-closed gate shared by every database-backed check: pool or result. */
function requirePool(
  check: SaasDoctorCheckId,
  database: DoctorDatabaseContext,
  level: 'fail' | 'warn',
): SaasDatabasePool | SaasDoctorCheckResult {
  if (database.url === undefined) return noDatabase(check, database, level);
  if (database.pool === undefined) return poolFailed(check, level);
  if (database.unreachable) return unreachable(check, level);
  return database.pool;
}

function isDoctorCheckResult(value: SaasDatabasePool | SaasDoctorCheckResult): value is SaasDoctorCheckResult {
  return !('query' in value);
}

// ---------------------------------------------------------------------------
// Check 1: PG connectivity, server version, and migration ledger vs registry.
// ---------------------------------------------------------------------------

async function checkPgMigrations(context: DoctorContext): Promise<SaasDoctorCheckResult> {
  const database = openDatabase(context);
  const gated = requirePool('pg-migrations', database, 'fail');
  if (isDoctorCheckResult(gated)) return gated;
  const pool = gated;
  try {
    await pool.query('SELECT 1');
  } catch {
    database.unreachable = true;
    return unreachable('pg-migrations', 'fail');
  }
  let versionNum: number | null = null;
  try {
    const version = await pool.query<{ version_num: unknown }>(
      "SELECT pg_catalog.current_setting('server_version_num')::integer AS version_num",
    );
    versionNum = nonNegativeCount(version.rows[0]?.version_num);
  } catch {
    return fail('pg-migrations', 'unable to read the PostgreSQL server version', 'verify database connectivity');
  }
  if (versionNum === null) {
    return fail('pg-migrations', 'PostgreSQL returned an unreadable server version', 'verify database connectivity');
  }
  if (versionNum < PG_VERSION_MINIMUM) {
    return fail(
      'pg-migrations',
      `PostgreSQL server_version_num ${versionNum} is older than the required 150000`,
      'upgrade the deployment to PostgreSQL 15 or later',
    );
  }
  if (context.role === 'credential-validation-worker') {
    // The worker role deliberately has no SELECT on the migration ledger; its
    // catalog-only proof lives in the privilege check below.
    return warn(
      'pg-migrations',
      `connected; server_version_num ${versionNum}; migration ledger not verifiable under the credential-validation-worker role (no ledger access by design)`,
      'run saas:doctor --role control-plane (or the migrator) to verify the migration ledger',
    );
  }
  let applied = 0;
  let head = 0;
  try {
    const counts = await pool.query<{ applied: unknown; head: unknown }>(
      'SELECT count(version)::text AS applied, coalesce(max(version), 0)::text AS head FROM saas_schema_migrations',
    );
    applied = nonNegativeCount(counts.rows[0]?.applied) ?? -1;
    head = nonNegativeCount(counts.rows[0]?.head) ?? -1;
  } catch {
    return fail(
      'pg-migrations',
      'unable to read the SaaS migration ledger (saas_schema_migrations)',
      'verify the schema is migrated and the role has ledger SELECT access',
    );
  }
  if (applied < 0 || head < 0) {
    return fail('pg-migrations', 'SaaS migration ledger returned unreadable counts', 'inspect saas_schema_migrations');
  }
  try {
    await verifySaasMigrations(pool);
  } catch (error) {
    return fail(
      'pg-migrations',
      `migration history mismatch: ${safeMessage(error)}`,
      'run model-router saas:migrate with the migrator role URL to reconcile the schema',
    );
  }
  return pass(
    'pg-migrations',
    `server_version_num ${versionNum}; migrations ${applied}/${SAAS_MIGRATIONS.length} applied (head ${head})`,
  );
}

// ---------------------------------------------------------------------------
// Check 2: per-role column-level privilege contracts, missing grants named.
// ---------------------------------------------------------------------------

const IDENTIFIER_PATTERN = /^[a-z0-9_]+$/;
const PRIVILEGE_PATTERN = /^(SELECT|INSERT|UPDATE|DELETE|USAGE)$/;

interface ExpectedGrantList {
  readonly columns: readonly (readonly [string, string, string])[];
  readonly tables: readonly (readonly [string, string])[];
  readonly sequences: readonly (readonly [string, string])[];
}

const WORKER_COLUMN_GRANT_PATTERN = /\('([a-z0-9_]+)',\s*'([a-z0-9_]+)',\s*'(SELECT|INSERT|UPDATE)'\)/g;

/**
 * The worker privilege file keeps its expected grants inline in the probe
 * SQL; extracting them from the exported SQL keeps the diagnosis in sync
 * with the single source of truth. A format change degrades to no names
 * (the verify verdict is unaffected); the unit test guards the shape.
 */
function workerColumnGrantsFromProbeSql(): readonly (readonly [string, string, string])[] {
  const grants: [string, string, string][] = [];
  for (const section of SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL.matchAll(
    /expected_column_privileges\([^)]*\) AS \(\s*VALUES\s+([\s\S]*?)\n\s*\)/g,
  )) {
    for (const row of section[1].matchAll(WORKER_COLUMN_GRANT_PATTERN)) {
      grants.push([row[1], row[2], row[3]]);
    }
  }
  return grants;
}

function expectedGrantsForRole(role: SaasDoctorRole): ExpectedGrantList | undefined {
  if (role === 'combined' || role === 'control-plane') {
    return {
      columns: SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
      tables: SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS,
      sequences: SAAS_CONTROL_PLANE_RUNTIME_SEQUENCE_GRANTS,
    };
  }
  if (role === 'gateway') {
    return {
      columns: SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
      tables: [
        ...SAAS_GATEWAY_RUNTIME_READ_TABLES.map((table) => [table, 'SELECT'] as const),
        ...GATEWAY_DELETE_TABLES.map((table) => [table, 'DELETE'] as const),
      ],
      sequences: [],
    };
  }
  return { columns: workerColumnGrantsFromProbeSql(), tables: [], sequences: [] };
}

/**
 * Body of an `AS (...)` CTE section: a VALUES list, or an empty typed SELECT
 * when the role expects no grants of that kind (the roles template's own
 * empty-section precedent — a bare SELECT, never `VALUES SELECT ...`).
 */
function grantValuesSection(rows: readonly (readonly string[])[], columnCount: number): string {
  if (rows.length === 0) {
    const nulls = Array.from({ length: columnCount }, () => 'NULL::text').join(', ');
    return `SELECT ${nulls} WHERE FALSE`;
  }
  return `VALUES ${rows.map((row) => `(${row.map((value) => `'${value}'`).join(', ')})`).join(', ')}`;
}

function grantsAreWellFormed(grants: ExpectedGrantList): boolean {
  return (
    grants.columns.every(
      ([t, c, p]) => IDENTIFIER_PATTERN.test(t) && IDENTIFIER_PATTERN.test(c) && PRIVILEGE_PATTERN.test(p),
    ) &&
    grants.tables.every(([t, p]) => IDENTIFIER_PATTERN.test(t) && PRIVILEGE_PATTERN.test(p)) &&
    grants.sequences.every(([s, p]) => IDENTIFIER_PATTERN.test(s) && PRIVILEGE_PATTERN.test(p))
  );
}

function missingGrantNamingSql(grants: ExpectedGrantList): string {
  return `
WITH expected_columns(table_name, column_name, privilege_type) AS (
  ${grantValuesSection(
    grants.columns.map(([table, column, privilege]) => [table, column, privilege]),
    3,
  )}
),
expected_tables(table_name, privilege_type) AS (
  ${grantValuesSection(grants.tables, 2)}
),
expected_sequences(sequence_name, privilege_type) AS (
  ${grantValuesSection(grants.sequences, 2)}
)
SELECT kind, object_name, privilege_type FROM (
  SELECT 'column' AS kind, table_name || '.' || column_name AS object_name, privilege_type
    FROM expected_columns
   WHERE NOT pg_catalog.has_column_privilege(table_name, column_name, privilege_type)
  UNION ALL
  SELECT 'table' AS kind, table_name AS object_name, privilege_type
    FROM expected_tables
   WHERE NOT pg_catalog.has_table_privilege(table_name, privilege_type)
  UNION ALL
  SELECT 'sequence' AS kind, sequence_name AS object_name, privilege_type
    FROM expected_sequences
   WHERE NOT pg_catalog.has_sequence_privilege(sequence_name, privilege_type)
) AS missing
ORDER BY kind, object_name
LIMIT ${MAX_NAMED_MISSING_GRANTS}`;
}

async function nameMissingGrants(pool: SaasDatabasePool, role: SaasDoctorRole): Promise<readonly string[]> {
  const grants = expectedGrantsForRole(role);
  if (grants === undefined || !grantsAreWellFormed(grants) || grants.columns.length === 0) return [];
  const result = await pool.query<{ kind: unknown; object_name: unknown; privilege_type: unknown }>(
    missingGrantNamingSql(grants),
  );
  const named: string[] = [];
  for (const row of result.rows) {
    if (typeof row.object_name !== 'string' || typeof row.privilege_type !== 'string') continue;
    named.push(`${row.object_name}:${row.privilege_type}`);
  }
  return named;
}

async function checkRolePrivileges(context: DoctorContext): Promise<SaasDoctorCheckResult> {
  const database = openDatabase(context);
  const gated = requirePool('role-privileges', database, 'fail');
  if (isDoctorCheckResult(gated)) return gated;
  const pool = gated;
  const role = context.role;
  try {
    if (role === 'credential-validation-worker') {
      await verifyCredentialValidationWorkerRuntimePrivileges(pool);
    } else {
      await verifySaasRuntimeDatabasePrivileges(pool, role === 'gateway' ? 'gateway' : 'control_plane');
    }
  } catch {
    let named: readonly string[] = [];
    try {
      named = await nameMissingGrants(pool, role);
    } catch {
      // The naming query is best-effort; the authoritative verdict is the
      // verify failure itself.
    }
    if (named.length > 0) {
      return fail(
        'role-privileges',
        `privilege verification failed for the ${role} role; missing grants: ${named.join(', ')}`,
        'replay deploy/managed-saas-postgres-roles.sql (or the validation-worker grants template) as the database superuser, then re-run saas:doctor',
      );
    }
    return fail(
      'role-privileges',
      `privilege verification failed for the ${role} role; no missing column grants were detected (extra or unsafe privileges, role posture, sequence or function grants)`,
      'run the runtime privilege probe SQL for this role against the database to enumerate the failing category',
    );
  }
  const label = role === 'combined' ? 'control-plane (combined deployment)' : role;
  return pass('role-privileges', `runtime privilege contract satisfied for the ${label} role`);
}

// ---------------------------------------------------------------------------
// Check 3: per-role KMS readiness (seal / unseal / rewrap) via checkReady.
// ---------------------------------------------------------------------------

interface KmsProbeOutcome {
  readonly label: string;
  readonly status: 'ready' | 'not-declared' | 'failed';
  readonly reason: string;
}

async function loadAndClose(
  load: (options: { env: NodeJS.ProcessEnv }) => Promise<DoctorKmsHandle | undefined>,
  env: NodeJS.ProcessEnv,
): Promise<KmsProbeOutcome> {
  try {
    const handle = await load({ env });
    if (handle === undefined) return { label: '', status: 'not-declared', reason: '' };
    try {
      await handle.close();
    } catch {
      // Close failures never mask a successful readiness check.
    }
    return { label: '', status: 'ready', reason: '' };
  } catch (error) {
    return { label: '', status: 'failed', reason: safeMessage(error) };
  }
}

function declared(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '';
}

async function checkKmsReadiness(context: DoctorContext): Promise<SaasDoctorCheckResult> {
  const { env, dependencies, role } = context;
  const outcomes: KmsProbeOutcome[] = [];
  const probe = async (
    label: string,
    load: (options: { env: NodeJS.ProcessEnv }) => Promise<DoctorKmsHandle | undefined>,
  ) => {
    const outcome = await loadAndClose(load, env);
    outcomes.push({ ...outcome, label });
  };
  if (role === 'combined' || role === 'control-plane') {
    if (declared(env, SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE)) {
      await probe('seal', dependencies.loadSealingKms ?? loadProviderCredentialSealingKms);
    } else {
      outcomes.push({ label: 'seal', status: 'not-declared', reason: '' });
    }
    if (declared(env, SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE)) {
      await probe('rewrap', dependencies.loadRewrappingKms ?? loadProviderCredentialRewrappingKms);
    } else {
      outcomes.push({ label: 'rewrap', status: 'not-declared', reason: '' });
    }
  }
  if (role === 'gateway') {
    if (declared(env, SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE)) {
      await probe('gateway unseal', dependencies.loadGatewayUnsealingKms ?? loadGatewayProviderCredentialUnsealingKms);
    } else {
      outcomes.push({ label: 'gateway unseal', status: 'not-declared', reason: '' });
    }
  }
  if (role === 'credential-validation-worker') {
    if (declared(env, MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE)) {
      await probe('worker unseal', dependencies.loadValidationWorkerKms ?? loadValidationWorkerProviderCredentialKms);
    } else {
      outcomes.push({ label: 'worker unseal', status: 'not-declared', reason: '' });
    }
  }
  const detail = outcomes
    .map((outcome) =>
      outcome.status === 'ready'
        ? `${outcome.label}: ready`
        : outcome.status === 'not-declared'
          ? `${outcome.label}: not declared`
          : `${outcome.label}: not ready (${outcome.reason})`,
    )
    .join('; ');

  const required = role === 'gateway' || role === 'credential-validation-worker';
  if (outcomes.some((outcome) => outcome.status === 'failed')) {
    return fail(
      'kms-readiness',
      detail,
      'verify the declared KMS module path, its configuration variables, and key access (readiness ran checkReady)',
    );
  }
  if (required && outcomes.some((outcome) => outcome.status === 'not-declared')) {
    return fail('kms-readiness', detail, 'declare the role decrypt KMS module; the workload fails closed without it');
  }
  if (outcomes.every((outcome) => outcome.status === 'ready')) {
    return pass('kms-readiness', detail);
  }
  return warn(
    'kms-readiness',
    detail,
    'KMS sealing is optional when platform credential sealing is disabled; declare the module to enable provider credential sealing',
  );
}

// ---------------------------------------------------------------------------
// Check 4: Redis RESP contract probe (gateway hot-state / shared limiter).
// ---------------------------------------------------------------------------

async function defaultConnectRedis(url: string): Promise<SaasDoctorRedisProbe> {
  const client = await RedisRespClient.connect(url);
  return {
    async ping() {
      const reply = await client.command(['PING']);
      if (reply !== 'PONG') throw new RedisRespError('REDIS_PROTOCOL_ERROR');
    },
    close: () => client.close(),
  };
}

async function checkRedisContract(context: DoctorContext): Promise<SaasDoctorCheckResult> {
  const { env, dependencies, role } = context;
  const url = env[MODEL_ROUTER_SAAS_REDIS_URL];
  if (typeof url !== 'string' || url.trim() === '') {
    if (role === 'gateway') {
      // The gateway deployment contract deliberately does not carry a Redis
      // URL (the hot-state pre-check is optional and fails open to PG).
      return warn(
        'redis-contract',
        'MODEL_ROUTER_SAAS_REDIS_URL is not set; the gateway Redis hot-state pre-check is unconfigured (optional, fail-open to PostgreSQL)',
        'export MODEL_ROUTER_SAAS_REDIS_URL in the diagnostic environment to probe the RESP contract',
      );
    }
    return fail(
      'redis-contract',
      'MODEL_ROUTER_SAAS_REDIS_URL is not configured',
      'control-plane/combined deployments REQUIRE Redis (cache/coordination; the deployment contract assigns it to the control plane — the gateway role has no Redis URL by design and its absent URL is a warn, not a fail). Set MODEL_ROUTER_SAAS_REDIS_URL and MODEL_ROUTER_SAAS_REDIS_PROVIDER for the control-plane deployment, or re-run with --role gateway/--role credential-validation-worker to scope the diagnostic',
    );
  }
  const connect = dependencies.connectRedis ?? defaultConnectRedis;
  try {
    const probe = await connect(url);
    try {
      await probe.ping();
    } finally {
      try {
        await probe.close();
      } catch {
        // A close failure never masks a successful PING.
      }
    }
  } catch (error) {
    return fail(
      'redis-contract',
      `Redis RESP contract probe failed (${safeRedisCode(error)})`,
      'verify the Redis URL, network reachability, credentials, and that the server answers PING within the RESP2 frame limits',
    );
  }
  return pass(
    'redis-contract',
    'Redis RESP contract satisfied (RESP2 connect, AUTH/SELECT, PING within the bounded frame limits)',
  );
}

// ---------------------------------------------------------------------------
// Checks 5-8: read-only control-plane SQL diagnostics.
// ---------------------------------------------------------------------------

type SqlCheck = 'stuck-executions' | 'recovery-sweep' | 'health-self-heal' | 'spending-freezes';

async function runSqlCheck(
  context: DoctorContext,
  check: SqlCheck,
  query: (pool: SaasDatabasePool) => Promise<SaasDoctorCheckResult>,
): Promise<SaasDoctorCheckResult> {
  const database = openDatabase(context);
  const gated = requirePool(check, database, 'warn');
  if (isDoctorCheckResult(gated)) return gated;
  try {
    return await query(gated);
  } catch {
    return warn(
      check,
      'read-only diagnostic query failed (missing grant or unreadable table)',
      'verify the control-plane role grants for this table and re-run; the doctor never writes to diagnose',
    );
  }
}

function checkStuckExecutions(pool: SaasDatabasePool): Promise<SaasDoctorCheckResult> {
  return (async () => {
    const result = await pool.query<{ stuck_count: unknown }>(
      `SELECT count(r.id)::text AS stuck_count
         FROM saas_requests AS r
        WHERE r.execution_state IN ('pending', 'unknown')
          AND r.updated_at <= clock_timestamp() - ($1::integer * interval '1 second')
          AND (
            r.execution_state = 'unknown'
            OR EXISTS (
              SELECT 1
                FROM saas_attempts AS a
               WHERE a.tenant_id = r.tenant_id
                 AND a.request_id = r.id
                 AND (
                   a.dispatch_state IN ('not_sent', 'dispatching', 'unknown')
                   OR a.result_state IN ('pending', 'unknown')
                 )
            )
          )`,
      [CONCURRENCY_INFLIGHT_HORIZON_SECONDS],
    );
    const stuck = nonNegativeCount(result.rows[0]?.stuck_count);
    if (stuck === null) {
      return warn(
        'stuck-executions',
        'stuck-row count query returned an unreadable value',
        'inspect saas_requests execution_state manually',
      );
    }
    if (stuck === 0) {
      return pass(
        'stuck-executions',
        `no execution rows are pending/unknown past the ${CONCURRENCY_INFLIGHT_HORIZON_SECONDS}s in-flight horizon`,
      );
    }
    return warn(
      'stuck-executions',
      `${stuck} execution row(s) are pending/unknown past the ${CONCURRENCY_INFLIGHT_HORIZON_SECONDS}s in-flight horizon`,
      'check the unknown-outcome recovery sweep (recovery-sweep below) and the gateway dispatch logs; stuck rows stop blocking admission but must be reconciled',
    );
  })();
}

function checkRecoverySweep(pool: SaasDatabasePool): Promise<SaasDoctorCheckResult> {
  return (async () => {
    const result = await pool.query<{ open_count: unknown; due_count: unknown }>(
      `SELECT count(c.id)::text AS open_count,
              count(c.id) FILTER (WHERE c.next_attempt_at <= clock_timestamp())::text AS due_count
         FROM saas_unknown_outcome_reconciliation_cases AS c
        WHERE c.case_state = 'open'`,
    );
    const open = nonNegativeCount(result.rows[0]?.open_count);
    const due = nonNegativeCount(result.rows[0]?.due_count);
    if (open === null || due === null) {
      return warn(
        'recovery-sweep',
        'recovery queue depth query returned an unreadable value',
        'inspect saas_unknown_outcome_reconciliation_cases manually',
      );
    }
    if (open === 0) {
      return pass('recovery-sweep', 'unknown-outcome recovery queue is empty');
    }
    return warn(
      'recovery-sweep',
      `${open} open unknown-outcome reconciliation case(s), ${due} due now`,
      'check the recovery sweep worker is running; a non-varying staleAdmissionCancelFailures counter in the control-plane logs indicates systematic sweep failures (I1)',
    );
  })();
}

function checkHealthSelfHeal(pool: SaasDatabasePool): Promise<SaasDoctorCheckResult> {
  return (async () => {
    const result = await pool.query<{ alerting_count: unknown; stale_count: unknown }>(
      `SELECT count(h.owner_scope_key)::text AS alerting_count,
              count(h.owner_scope_key) FILTER (
                WHERE h.observed_at <= clock_timestamp() - ($1::integer * interval '1 second')
              )::text AS stale_count
         FROM saas_provider_account_runtime_health AS h
        WHERE h.state IN ('degraded', 'unhealthy')
           OR (h.state = 'cooldown' AND h.cooldown_until <= clock_timestamp())`,
      [HEALTH_STALE_HORIZON_SECONDS],
    );
    const alerting = nonNegativeCount(result.rows[0]?.alerting_count);
    const stale = nonNegativeCount(result.rows[0]?.stale_count);
    if (alerting === null || stale === null) {
      return warn(
        'health-self-heal',
        'health table stale-row query returned an unreadable value',
        'inspect saas_provider_account_runtime_health manually',
      );
    }
    if (alerting > 0) {
      return warn(
        'health-self-heal',
        `${alerting} provider account health row(s) are degraded/unhealthy or past cooldown (${stale} observation(s) older than ${HEALTH_STALE_HORIZON_SECONDS}s)`,
        'the H5a/P18 half-open probe should self-heal these under scheduling; run a health probe or check the gateway scheduler and probe monitors',
      );
    }
    if (stale > 0) {
      return pass(
        'health-self-heal',
        `no alerting health rows; ${stale} observation(s) older than ${HEALTH_STALE_HORIZON_SECONDS}s (informational on quiet deployments)`,
      );
    }
    return pass('health-self-heal', 'no alerting or stale provider account health rows');
  })();
}

function checkSpendingFreezes(pool: SaasDatabasePool): Promise<SaasDoctorCheckResult> {
  return (async () => {
    const result = await pool.query<{ freeze_count: unknown; latest_frozen_at: unknown }>(
      "SELECT count(f.tenant_id)::text AS freeze_count, coalesce(max(f.frozen_at)::text, '') AS latest_frozen_at FROM saas_billing_spending_freezes AS f",
    );
    const freezes = nonNegativeCount(result.rows[0]?.freeze_count);
    const latest = typeof result.rows[0]?.latest_frozen_at === 'string' ? result.rows[0]?.latest_frozen_at : '';
    if (freezes === null) {
      return warn(
        'spending-freezes',
        'spending freeze count query returned an unreadable value',
        'inspect saas_billing_spending_freezes manually',
      );
    }
    if (freezes === 0) return pass('spending-freezes', 'no spending freezes present');
    const suffix = latest === '' ? '' : `, latest ${latest}`;
    return warn(
      'spending-freezes',
      `${freezes} spending freeze(s) present${suffix}`,
      'P12-class billing freeze; resolve the underlying wallet condition via platform operations before re-enabling spend',
    );
  })();
}

// ---------------------------------------------------------------------------
// Check 9: systemd posture (inline port of check-managed-saas-deployment.mjs).
// ---------------------------------------------------------------------------

const SYSTEMD_UNITS = {
  'model-router-saas-control-plane.service': 'control-plane',
  'model-router-saas-gateway.service': 'gateway',
  'model-router-saas-credential-validation-worker.service': 'credential-validation-worker',
} as const;
const SYSTEMD_TARGET = 'model-router-saas.target';
const SYSTEMD_ROLE_DB_ENV = {
  'control-plane': MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL,
  gateway: MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL,
  'credential-validation-worker': MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL,
} as const;
const SYSTEMD_ALL_DB_ENVS = new Set([...Object.values(SYSTEMD_ROLE_DB_ENV), MODEL_ROUTER_SAAS_DATABASE_URL]);
const SYSTEMD_SECRET_KEY = /(DATABASE_URL|MASTER_KEY|PASSWORD|SECRET|TOKEN)$/;
const SYSTEMD_REQUIRED_UNIT_DIRECTIVES = [
  'NoNewPrivileges=true',
  'PrivateTmp=true',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'Restart=on-failure',
  'Environment=NODE_ENV=production',
  'Environment=MODEL_ROUTER_DEPLOYMENT_MODE=managed-saas',
];

const defaultFilesystem: SaasDoctorFilesystem = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  mode: (path) => statSync(path).mode & 0o777,
};

function reviewedUnitsDirectory(): string {
  // Works from both a checkout (src/cli) and a built tree (dist/cli); the
  // reviewed copies only exist in a checkout, where the drift check applies.
  return resolvePath(__dirname, '../../..', 'deploy/systemd/managed-saas');
}

function parseSystemdEnvFile(text: string): { entries: Map<string, string>; duplicates: string[] } | { error: string } {
  const entries = new Map<string, string>();
  const duplicates: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `unparseable line: ${line.slice(0, eq < 0 ? 24 : eq)}` };
    const key = line.slice(0, eq);
    if (entries.has(key)) duplicates.push(key);
    entries.set(key, line.slice(eq + 1));
  }
  return { entries, duplicates };
}

function checkSystemdPosture(context: DoctorContext): SaasDoctorCheckResult {
  const fs = context.dependencies.fs ?? defaultFilesystem;
  const unitsDir = context.dependencies.unitsDir ?? '/etc/systemd/system';
  const envDir = context.dependencies.envDir ?? '/etc/model-router-saas';
  const unitPaths = [...Object.keys(SYSTEMD_UNITS), SYSTEMD_TARGET].map((name) => resolvePath(unitsDir, name));
  if (!unitPaths.some((path) => fs.exists(path))) {
    return pass('systemd-posture', 'not applicable: no managed SaaS systemd units installed on this host');
  }
  const failures: string[] = [];
  const record = (ok: boolean, label: string, detail?: string) => {
    if (!ok) failures.push(detail === undefined ? label : `${label} (${detail})`);
  };

  for (const [name, role] of Object.entries(SYSTEMD_UNITS)) {
    const label = `unit ${name}`;
    const path = resolvePath(unitsDir, name);
    if (!fs.exists(path)) {
      record(false, label, 'not installed');
      continue;
    }
    const text = fs.readFile(path);
    for (const directive of SYSTEMD_REQUIRED_UNIT_DIRECTIVES) {
      record(text.includes(directive), `${label} ${directive.split('=')[0]}`);
    }
    record(text.includes(`start --role ${role}`), `${label} exec role`);
    const directives = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    record(!directives.some((line) => /^Restart=always\s*$/.test(line.trim())), `${label} restart not always`);
    const inlineSecrets = directives.filter(
      (line) =>
        line.startsWith('Environment=') &&
        SYSTEMD_SECRET_KEY.test(line.split('=')[1] ?? '') &&
        line.split('=').slice(2).join('=').trim() !== '',
    );
    record(inlineSecrets.length === 0, `${label} no inline secrets`);
  }
  record(fs.exists(resolvePath(unitsDir, SYSTEMD_TARGET)), `unit ${SYSTEMD_TARGET}`, 'not installed');

  const checkEnvFile = (
    name: string,
    options: { requiredKeys?: readonly string[]; forbiddenValueKeys?: readonly string[]; secret?: boolean },
  ) => {
    const label = `env ${name}`;
    const path = resolvePath(envDir, name);
    if (!fs.exists(path)) {
      record(false, label, 'missing');
      return;
    }
    const mode = fs.mode(path);
    const forbiddenBits = options.secret ? 0o077 : 0o007;
    record(
      (mode & forbiddenBits) === 0 && (mode & 0o700) !== 0,
      `${label} mode`,
      `mode ${mode.toString(8)} too permissive`,
    );
    const parsed = parseSystemdEnvFile(fs.readFile(path));
    if ('error' in parsed) {
      record(false, label, parsed.error);
      return;
    }
    record(parsed.duplicates.length === 0, `${label} duplicates`, parsed.duplicates.join(','));
    for (const key of options.requiredKeys ?? []) {
      record(
        parsed.entries.has(key) && (parsed.entries.get(key) ?? '').trim() !== '',
        `${label} ${key}`,
        'missing or empty',
      );
    }
    for (const key of parsed.entries.keys()) {
      if ((options.forbiddenValueKeys ?? []).includes(key) && (parsed.entries.get(key) ?? '').trim() !== '') {
        record(false, `${label} ${key}`, 'must not be set here');
      }
    }
  };

  checkEnvFile('common.env', {
    requiredKeys: ['MODEL_ROUTER_SAAS_DEPLOYMENT_ID', 'MODEL_ROUTER_SAAS_ENVIRONMENT_ID'],
    forbiddenValueKeys: [
      ...SYSTEMD_ALL_DB_ENVS,
      'MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY',
      'MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS',
    ],
  });
  for (const [role, dbEnv] of Object.entries(SYSTEMD_ROLE_DB_ENV)) {
    const others = [...SYSTEMD_ALL_DB_ENVS].filter((key) => key !== dbEnv);
    checkEnvFile(`${role}.env`, { secret: true, requiredKeys: [dbEnv], forbiddenValueKeys: others });
  }

  const reviewedDir = reviewedUnitsDirectory();
  for (const name of [...Object.keys(SYSTEMD_UNITS), SYSTEMD_TARGET]) {
    const installed = resolvePath(unitsDir, name);
    const reviewed = resolvePath(reviewedDir, name);
    if (!fs.exists(installed) || !fs.exists(reviewed)) continue;
    record(fs.readFile(installed) === fs.readFile(reviewed), `unit ${name} matches reviewed copy`);
  }

  if (failures.length === 0) {
    return pass(
      'systemd-posture',
      'systemd unit directives, environment file modes and key sets satisfy the reviewed deployment contract',
    );
  }
  return warn(
    'systemd-posture',
    `posture failures: ${failures.slice(0, 8).join('; ')}${failures.length > 8 ? ` (+${failures.length - 8} more)` : ''}`,
    'see scripts/check-managed-saas-deployment.mjs and deploy/systemd/managed-saas/README.md; only key names, modes, and directive presence are reported',
  );
}

// ---------------------------------------------------------------------------
// Orchestration, output, and CLI contract.
// ---------------------------------------------------------------------------

const LEVEL_MARKS: Readonly<Record<SaasDoctorCheckLevel, string>> = Object.freeze({
  pass: '✓ pass ',
  warn: '⚠ warn ',
  fail: '✗ fail ',
});

function printResult(
  result: SaasDoctorResult,
  options: SaasDoctorCommandOptions,
  writeLine: (line: string) => void,
): void {
  if (options.json) {
    writeLine(JSON.stringify(result));
    return;
  }
  for (const check of result.checks) {
    writeLine(`${LEVEL_MARKS[check.level]} ${check.check} — ${check.detail}`);
    if (check.hint !== '' && (check.level !== 'pass' || options.verbose)) {
      writeLine(`    hint: ${check.hint}`);
    }
  }
  writeLine(
    `summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail (role: ${result.role})`,
  );
}

export async function saasDoctor(
  options: SaasDoctorCommandOptions = {},
  dependencies: SaasDoctorDependencies = {},
): Promise<SaasDoctorResult> {
  const env = dependencies.env ?? process.env;
  const role = resolveRole(options, env);
  const context: DoctorContext = { role, env, dependencies, database: undefined };
  const checks: SaasDoctorCheckResult[] = [];
  let gatewayCapabilities: GatewayCapabilityStatus | undefined;
  try {
    const historyMode = env.MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE;
    if (historyMode !== undefined && historyMode !== 'disabled') {
      try {
        if (role !== 'gateway' && role !== 'combined') throw new Error();
        const pool = openDatabase(context).pool;
        if (!pool) throw new Error();
        const history = await loadResponsesContinuationDeployment({ database: pool, env });
        if (!history) throw new Error();
        try {
          const metadata = history.diagnostics?.();
          const expiry = metadata?.credentialExpiresAt && Number.isFinite(Date.parse(metadata.credentialExpiresAt)) ? new Date(metadata.credentialExpiresAt).toISOString() : 'unavailable';
          const retainedKeyCount = metadata?.retainedDecryptKeyIds?.length ?? 0;
          checks.push(history.readiness === 'production-kms' ? pass('responses-history', `Dedicated history KMS roundtrip and schema checks passed; retained decrypt key count=${retainedKeyCount}; credential expiry=${expiry}; productionEvidence=external_evidence_required; live continuation acceptance remains separate`) : warn('responses-history', 'Pilot file keyring is available; not production ready', 'Use the dedicated production KMS provider and complete real cross-instance continuation acceptance'));
        }
        finally { await history.close(); }
      } catch { checks.push(fail('responses-history', 'RESPONSES_HISTORY_READINESS_FAILED', 'Inspect the gateway-only history schema, grants and dedicated history KMS/keyring configuration')); }
    }
    const diagnostics = env.MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY;
    if (diagnostics !== undefined) checks.push(/^[1-9]\d{0,8}$/u.test(diagnostics) ? pass('request-diagnostics', 'Numeric phase diagnostics sampling is configured; this does not establish performance acceptance') : fail('request-diagnostics', 'REQUEST_DIAGNOSTICS_CONFIG_INVALID', 'Use a positive integer up to 999999999, or unset to disable'));
    if (role === 'combined' || role === 'control-plane' || env[COMMERCIAL_ATTESTATION_TRUST_FILE] !== undefined) {
      if (env[COMMERCIAL_ATTESTATION_TRUST_FILE] === undefined) checks.push(warn('commercial-attestation-trust', 'Platform inference access provisioning is unavailable: commercial attestation trust is missing', 'Configure the dedicated public key and suite digest trust file; no Codex billing bound is established'));
      else {
        try {
          const trust = await loadCommercialAttestationTrust({ workloadRole: role } as import('../saas/deployment.js').ManagedSaasDeploymentConfig, env);
          if (!trust) throw new Error();
          const codexBounds = codexTrustedBoundReadiness();
          checks.push(resolveSaasDatabasePoolSettings({}, env).max < 2 ? warn('commercial-attestation-trust', 'Platform inference access provisioning is unavailable: CP database pool requires at least two connections', 'Increase MODEL_ROUTER_SAAS_DB_POOL_MAX to at least 2') : pass('commercial-attestation-trust', `Dedicated commercial public verification keys and suite digests are valid; reviewed Codex bound profiles=${codexBounds.admittedProfileCount} (display only); each Codex provisioning operation requires an exact scope match or returns TRUSTED_USAGE_BOUNDS_UNAVAILABLE`));
        } catch { checks.push(fail('commercial-attestation-trust', 'COMMERCIAL_ATTESTATION_TRUST_INVALID', 'Inspect the dedicated public verification file and CP-only role declaration')); }
      }
    }
    if (env.MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE !== undefined) {
      try {
        const deployment = parseDeploymentConfig({ ...env, MODEL_ROUTER_SAAS_WORKLOAD_ROLE: role });
        if (deployment.mode !== 'managed-saas') throw new Error();
        const paymentDeployment = await loadPaymentDeployment(deployment, { environment: env });
        if (!paymentDeployment) throw new Error();
        await paymentDeployment.close();
        checks.push(pass('payments-readiness', 'Payment descriptor and credential references are valid'));
      } catch {
        checks.push(fail('payments-readiness', 'Payment configuration or credentials are unavailable for this role', 'Inspect CP-only descriptor and credential mount; no secret contents are reported'));
      }
    }
    for (const check of checkScopes(role)) {
      switch (check) {
        case 'pg-migrations':
          checks.push(await checkPgMigrations(context));
          break;
        case 'role-privileges':
          checks.push(await checkRolePrivileges(context));
          break;
        case 'kms-readiness':
          checks.push(await checkKmsReadiness(context));
          break;
        case 'redis-contract':
          checks.push(await checkRedisContract(context));
          break;
        case 'stuck-executions':
          checks.push(await runSqlCheck(context, check, checkStuckExecutions));
          break;
        case 'recovery-sweep':
          checks.push(await runSqlCheck(context, check, checkRecoverySweep));
          break;
        case 'health-self-heal':
          checks.push(await runSqlCheck(context, check, checkHealthSelfHeal));
          break;
        case 'spending-freezes':
          checks.push(await runSqlCheck(context, check, checkSpendingFreezes));
          break;
        case 'systemd-posture':
          checks.push(checkSystemdPosture(context));
          break;
      }
    }
    if (env.MODEL_ROUTER_SAAS_GATEWAY_ORIGIN) {
      gatewayCapabilities = await (dependencies.readGatewayCapabilities ?? readGatewayCapabilityStatus)(env);
      if (gatewayCapabilities.state !== 'available') {
        checks.push(
          warn(
            'gateway-capabilities',
            'Running gateway capability facts are unavailable',
            'Start the configured gateway and inspect its /readyz projection',
          ),
        );
      } else if (!gatewayCapabilities.readiness.configurationValid) {
        checks.push(
          fail(
            'gateway-capabilities',
            'Gateway capability assembly is invalid',
            'Inspect provider capability reason codes in the JSON report',
          ),
        );
      } else {
        const enabled = gatewayCapabilities.readiness.capabilities.filter((capability) => capability.enabled);
        const sellable = enabled.filter(
          (capability) => capability.assembled && capability.verified && capability.operational,
        );
        const detail = `${sellable.length}/${enabled.length} enabled provider capabilities have assembly, live verification and operational facts`;
        checks.push(
          sellable.length === enabled.length
            ? pass('gateway-capabilities', detail)
            : warn(
                'gateway-capabilities',
                detail,
                'Review each capability reason code before offering it to customers',
              ),
        );
      }
    }
  } finally {
    await closeDatabase(context);
  }
  const summary: SaasDoctorSummary = {
    pass: checks.filter((check) => check.level === 'pass').length,
    warn: checks.filter((check) => check.level === 'warn').length,
    fail: checks.filter((check) => check.level === 'fail').length,
  };
  const result: SaasDoctorResult = {
    format: SAAS_DOCTOR_FORMAT,
    role,
    summary,
    checks,
    exitCode: summary.fail > 0 ? 1 : 0,
    ...(gatewayCapabilities === undefined ? {} : { gatewayCapabilities }),
  };
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  try {
    printResult(result, options, writeLine);
  } catch {
    // Report-failure discipline matches the other SaaS commands: surface a
    // command error rather than a fabricated result.
    throw new Error('Unable to report the saas:doctor result');
  }
  return result;
}
