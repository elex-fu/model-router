import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import {
  auditSaasMigrationCompatibility,
  getSaasMigrationAuditExpectations,
  isSaasAuditCatalogBaseline,
  isSaasMigrationAuditTarget,
  type SaasAuditCatalogBaseline,
  type SaasMigrationAuditReport,
  type SaasMigrationAuditTarget,
} from '../saas/db/migration-audit.js';
import type { SaasDatabaseClient, SaasDatabasePool } from '../saas/db/types.js';

/** Dedicated variable only; MODEL_ROUTER_SAAS_DATABASE_URL and PG* are never fallbacks. */
export const SAAS_MIGRATION_AUDIT_URL_ENV = 'MODEL_ROUTER_SAAS_AUDIT_DATABASE_URL';
const MAX_BASELINE_BYTES = 16 * 1024 * 1024;

export interface SaasMigrationAuditCommandOptions {
  deploymentId?: string;
  environmentId?: string;
  database?: string;
  schema?: string;
  releaseId?: string;
  catalogBaseline?: string;
  /** Explicit opt-in for a loopback disposable DB or a locally authenticated tunnel. */
  allowLocalPlaintext?: boolean;
}
export interface SaasMigrationAuditCommandDependencies {
  env?: NodeJS.ProcessEnv;
  createPool?: (connectionString: string) => SaasDatabasePool;
  readBaselineFile?: (path: string) => Promise<string>;
  writeLine?: (line: string) => void;
}
export type SaasMigrationAuditCommandCode =
  | 'INVALID_OPTIONS' | 'AUDIT_URL_REQUIRED' | 'AUDIT_URL_INVALID'
  | 'BASELINE_IO_FAILED' | 'BASELINE_INVALID' | 'BASELINE_BINDING_MISMATCH'
  | 'AUDIT_FAILED' | 'POOL_CLOSE_FAILED';
export interface SaasMigrationAuditCommandResult {
  format: 'saas-migration-audit-command-v1';
  status: 'matched' | 'blocked' | 'error';
  exitCode: 0 | 1 | 2;
  report: SaasMigrationAuditReport | null;
  error: { code: SaasMigrationAuditCommandCode } | null;
}
class CommandFailure extends Error {
  constructor(readonly code: SaasMigrationAuditCommandCode) { super('SaaS migration audit command failed'); }
}
export class SaasMigrationAuditCommandError extends Error {
  constructor() {
    super('Unable to report the SaaS migration audit result');
    this.name = 'SaasMigrationAuditCommandError';
  }
}

/** Fully explicit endpoint/identity, with no libpq environment or socket discovery. */
function validatedUrl(raw: unknown, database: string, allowLocalPlaintext: boolean): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new CommandFailure('AUDIT_URL_REQUIRED');
  try {
    const url = new URL(raw);
    const sslmode = url.searchParams.get('sslmode');
    const port = url.port ? Number(url.port) : 5432;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '::1'
      || (isIP(hostname) === 4 && hostname.startsWith('127.'));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
      || url.hash || decodeURIComponent(url.pathname.slice(1)) !== database
      || !Number.isInteger(port) || port < 1 || port > 65535
      || [...url.searchParams.keys()].some((key) => key !== 'sslmode')
      || url.searchParams.getAll('sslmode').length > 1
      || (sslmode !== null && !['disable', 'require', 'verify-full'].includes(sslmode))
      || (sslmode === 'disable' && (!allowLocalPlaintext || !loopback))) {
      throw new Error('invalid');
    }
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url;
  } catch { throw new CommandFailure('AUDIT_URL_INVALID'); }
}

function createAuditPool(connectionString: string): SaasDatabasePool {
  // validatedUrl has already rejected query parameters that could override the
  // explicit host/database, load local certificate files, or alter options.
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get('sslmode');
  const password = decodeURIComponent(url.password);
  const pool = new Pool({
    host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username),
    // A function is intentional: an empty explicit password must not fall back to PGPASSWORD.
    password: () => password,
    // TLS with certificate/hostname verification is the default, including
    // sslmode=require. Plaintext is a validated, explicit loopback-only policy.
    ssl: sslmode === 'disable' ? false : { rejectUnauthorized: true },
    application_name: 'model-router-saas-migration-audit', max: 1,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
  });
  let idleConnectionFailed = false;
  // An idle pg error must not escape the structured/sanitized error boundary.
  pool.on('error', () => { idleConnectionFailed = true; });
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
      if (idleConnectionFailed) throw new Error('Audit database connection failed');
    },
  };
}

async function readBaselineFile(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BASELINE_BYTES) throw new Error('Invalid baseline file');
    const buffer = Buffer.alloc(MAX_BASELINE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_BASELINE_BYTES) throw new Error('Invalid baseline file');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

/** One safe JSON line; return status so the CLI registration can set process.exitCode. */
export async function saasMigrationAudit(
  options: SaasMigrationAuditCommandOptions = {},
  dependencies: SaasMigrationAuditCommandDependencies = {},
): Promise<SaasMigrationAuditCommandResult> {
  const result: SaasMigrationAuditCommandResult = {
    format: 'saas-migration-audit-command-v1', status: 'error', exitCode: 2, report: null, error: null,
  };
  let pool: SaasDatabasePool | undefined;
  try {
    const target = {
      deploymentId: options.deploymentId, environmentId: options.environmentId,
      database: options.database, schema: options.schema,
    } as SaasMigrationAuditTarget;
    if (!isSaasMigrationAuditTarget(target) || typeof options.releaseId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.releaseId)
      || (options.allowLocalPlaintext !== undefined && typeof options.allowLocalPlaintext !== 'boolean')
      || (options.catalogBaseline !== undefined && (typeof options.catalogBaseline !== 'string'
        || !options.catalogBaseline.trim() || options.catalogBaseline.includes('\0')))) {
      throw new CommandFailure('INVALID_OPTIONS');
    }
    const environment = dependencies.env ?? process.env;
    const connectionString = environment[SAAS_MIGRATION_AUDIT_URL_ENV];
    validatedUrl(connectionString, target.database, options.allowLocalPlaintext === true);
    let catalogBaseline: SaasAuditCatalogBaseline | undefined;
    if (options.catalogBaseline !== undefined) {
      let text: string;
      try { text = await (dependencies.readBaselineFile ?? readBaselineFile)(options.catalogBaseline); }
      catch { throw new CommandFailure('BASELINE_IO_FAILED'); }
      try {
        if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BASELINE_BYTES) throw new Error('invalid');
        const value: unknown = JSON.parse(text);
        if (!isSaasAuditCatalogBaseline(value)) throw new Error('invalid');
        catalogBaseline = value;
      } catch { throw new CommandFailure('BASELINE_INVALID'); }
      if (catalogBaseline.releaseId !== options.releaseId || catalogBaseline.schema !== target.schema
        || catalogBaseline.migrationsChecksum !== getSaasMigrationAuditExpectations().checksum) {
        throw new CommandFailure('BASELINE_BINDING_MISMATCH');
      }
    }
    // Every CLI option, URL, and provided baseline is validated before this point.
    pool = (dependencies.createPool ?? createAuditPool)(connectionString as string);
    result.report = await auditSaasMigrationCompatibility(pool, {
      target, releaseId: options.releaseId, catalogBaseline,
    });
    result.status = result.report.compatibility === 'matches-trusted-baseline' ? 'matched' : 'blocked';
    result.exitCode = result.status === 'matched' ? 0 : 1;
  } catch (error) {
    result.error = { code: error instanceof CommandFailure ? error.code : 'AUDIT_FAILED' };
  } finally {
    if (pool) {
      try { await pool.end(); } catch {
        result.status = 'error';
        result.exitCode = 2;
        result.error ??= { code: 'POOL_CLOSE_FAILED' };
      }
    }
  }
  try { (dependencies.writeLine ?? ((line: string) => console.log(line)))(JSON.stringify(result)); }
  catch { throw new SaasMigrationAuditCommandError(); }
  return result;
}
