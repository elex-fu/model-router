import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline';
import { Pool, type PoolConfig } from 'pg';
import { createSaasDatabase, type SaasDatabase, type SaasDatabaseOptions } from '../saas/db/index.js';
import type { SaasDatabasePool } from '../saas/db/types.js';
import { verifySaasRuntimeDatabasePrivileges } from '../saas/db/runtime-privileges.js';
import { PlatformAuthError } from '../saas/platform/auth/errors.js';
import {
  PlatformAdminAuthService,
  type PlatformMfaEnrollmentIssuanceAudit,
} from '../saas/platform/auth/service.js';
import {
  loadCredentialKeyProvider,
  type LoadedCredentialKeyProvider,
  type ProviderEnvironment,
  resolveProviderModuleSpecifier,
} from '../saas/runtime/providers.js';

type EnrollmentService = Pick<PlatformAdminAuthService, 'issueMfaEnrollmentToken'>;
export interface SaasPlatformMfaEnrollmentPrompt {
  ask(message: string): Promise<string>;
  close(): void | Promise<void>;
}
export interface SaasPlatformMfaEnrollmentCommandOptions {
  /** Only an explicit loopback disposable database or trusted local tunnel may disable TLS. */
  allowLocalPlaintext?: boolean;
}
export interface SaasPlatformMfaEnrollmentDependencies {
  env?: NodeJS.ProcessEnv;
  /** Test/embedded seams; no corresponding command-line options or stdin bypass. */
  requireInteractiveTerminal?: () => void;
  prompt?: SaasPlatformMfaEnrollmentPrompt;
  createDatabase?: (options: SaasDatabaseOptions, poolOptions: PoolConfig) => SaasDatabase | Promise<SaasDatabase>;
  verifyControlPlanePrivileges?: (database: SaasDatabase) => Promise<void>;
  loadKeyProvider?: (module: string, options: { env: ProviderEnvironment }) => Promise<LoadedCredentialKeyProvider>;
  createAuthService?: (database: SaasDatabase, provider: LoadedCredentialKeyProvider) => EnrollmentService;
  writeToTerminal?: (message: string) => void | Promise<void>;
}

/**
 * Fixed non-secret region/deployment/workload labels only. The trusted provider
 * must authenticate using workload identity and trusted module configuration,
 * not forwarded DB/Redis/upstream/API credentials or embedded AES keys. This
 * environment allowlist is not a sandbox for the trusted module's JavaScript.
 */
export const PLATFORM_MFA_PROVIDER_ENV_KEYS = Object.freeze([
  'NODE_ENV', 'MODEL_ROUTER_DEPLOYMENT_MODE', 'MODEL_ROUTER_SAAS_WORKLOAD_ROLE',
  'MODEL_ROUTER_SAAS_DEPLOYMENT_ID', 'MODEL_ROUTER_SAAS_ENVIRONMENT_ID', 'AWS_REGION', 'AWS_DEFAULT_REGION',
] as const);

export class SaasPlatformMfaEnrollmentError extends Error {
  constructor(message: string) { super(message); this.name = 'SaasPlatformMfaEnrollmentError'; }
}
const error = (message: string): SaasPlatformMfaEnrollmentError => new SaasPlatformMfaEnrollmentError(message);
const INPUT_FAILED = 'Unable to read or validate the secure operator input; enrollment was not issued.';
const ISSUANCE_UNKNOWN = 'MFA enrollment issuance outcome is unknown; a challenge may have been persisted. Do not repeat issuance automatically; review the pending enrollment and expiry through the trusted operator process.';
const DELIVERY_FAILED = 'An MFA enrollment challenge was issued, but terminal delivery did not complete. Do not repeat this command or mint another challenge; retain any received token securely and review delivery and expiry through the trusted operator process.';

function managementPoolOptions(connectionString: string, options: SaasPlatformMfaEnrollmentCommandOptions): PoolConfig {
  if (options.allowLocalPlaintext !== undefined && typeof options.allowLocalPlaintext !== 'boolean') {
    throw error('Invalid MFA enrollment command options; enrollment was not issued.');
  }
  try {
    // Same bounded policy as the existing audit CLI (whose helpers are private):
    // WHATWG PostgreSQL URL, one sslmode only, no libpq query overrides/files.
    const url = new URL(connectionString);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port ? Number(url.port) : 5432;
    const sslmode = url.searchParams.get('sslmode');
    const user = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.slice(1));
    const password = decodeURIComponent(url.password);
    const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !host || !user.trim() || !database.trim()
      || url.hash || /[\u0000-\u001f\u007f]/.test(user + database + password) || database.includes('/')
      || !Number.isInteger(port) || port < 1 || port > 65535
      || [...url.searchParams.keys()].some((key) => key !== 'sslmode')
      || url.searchParams.getAll('sslmode').length > 1
      || (sslmode !== null && !['disable', 'require', 'verify-full'].includes(sslmode))
      || (sslmode === 'disable' && (!loopback || options.allowLocalPlaintext !== true))) throw new Error('invalid');
    return {
      host, port, user, database, password: () => password,
      ssl: sslmode === 'disable' ? false : { rejectUnauthorized: true },
      // pg treats an empty options string as a request for PGOPTIONS. A fixed
      // whitespace-only startup value means no options and prevents that fallback.
      // It does not SET ROLE/search_path or hide a broken managed role contract.
      options: ' ', client_encoding: 'UTF8', sslnegotiation: 'postgres',
      application_name: 'model-router-saas-platform-mfa-enroll', max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
    };
  } catch { throw error('The explicit management PostgreSQL URL is invalid or violates the verified TLS/loopback policy; enrollment was not issued.'); }
}

async function createManagementDatabase(options: SaasDatabaseOptions, poolOptions: PoolConfig): Promise<SaasDatabase> {
  // Do not pass connectionString to pg: its URL parser can override explicit
  // TLS options. Endpoint/password/startup options are all explicit above.
  const pool = new Pool(poolOptions);
  let idleConnectionFailed = false;
  pool.on('error', () => { idleConnectionFailed = true; });
  const requireHealthy = () => { if (idleConnectionFailed) throw error('Management database connection failed.'); };
  const adapter: SaasDatabasePool = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      requireHealthy();
      const result = await pool.query(sql, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    async connect() {
      requireHealthy();
      const client = await pool.connect();
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          requireHealthy();
          const result = await client.query(sql, values ? [...values] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release: (failure?: Error | boolean) => client.release(failure),
      };
    },
    async end() { await pool.end(); requireHealthy(); },
  };
  try { return createSaasDatabase({ ...options, pool: adapter }); }
  catch (cause) { try { await pool.end(); } catch {} throw cause; }
}

function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw error('Secure interactive TTY required for saas:platform-mfa-enroll; enrollment was not issued.');
  }
}

function interactivePrompt(): SaasPlatformMfaEnrollmentPrompt {
  const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closed = false;
  reader.on('close', () => { closed = true; });
  return {
    ask: (message) => new Promise<string>((resolve, reject) => {
      if (closed) { reject(error(INPUT_FAILED)); return; }
      const cleanup = () => { reader.off('close', onClose); reader.off('SIGINT', onInterrupt); };
      const onClose = () => { cleanup(); reject(error(INPUT_FAILED)); };
      const onInterrupt = () => { reader.close(); };
      reader.once('close', onClose);
      reader.once('SIGINT', onInterrupt);
      try { reader.question(message, (answer) => { cleanup(); resolve(answer); }); }
      catch { cleanup(); reject(error(INPUT_FAILED)); }
    }),
    close: () => { reader.close(); },
  };
}

function terminalWrite(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => process.stdout.off('error', onError);
    const onError = () => { cleanup(); reject(error(DELIVERY_FAILED)); };
    process.stdout.once('error', onError);
    try {
      process.stdout.write(message, (failure) => {
        cleanup();
        if (failure) reject(error(DELIVERY_FAILED)); else resolve();
      });
    } catch { cleanup(); reject(error(DELIVERY_FAILED)); }
  });
}

function providerEnvironment(environment: NodeJS.ProcessEnv): ProviderEnvironment {
  const copied: Record<string, string | undefined> = {};
  for (const key of PLATFORM_MFA_PROVIDER_ENV_KEYS) {
    if (typeof environment[key] === 'string') copied[key] = environment[key];
  }
  return Object.freeze(copied);
}

/** Trusted terminal-only handoff. Returns no enrollment/session/credential secret to callers. */
export async function saasPlatformMfaEnroll(
  dependencies: SaasPlatformMfaEnrollmentDependencies = {},
  options: SaasPlatformMfaEnrollmentCommandOptions = {},
): Promise<void> {
  let database: SaasDatabase | undefined;
  let provider: LoadedCredentialKeyProvider | undefined;
  let prompt = dependencies.prompt;
  let failure: SaasPlatformMfaEnrollmentError | undefined;
  let issued = false;
  let issuanceAttempted = false;
  let delivered = false;
  const checkTerminal = dependencies.requireInteractiveTerminal ?? requireInteractiveTerminal;
  try {
    // Must precede provider loading, database access, prompts or mutation even
    // when NODE_ENV is absent. A supplied test prompt does not bypass it.
    try { checkTerminal(); } catch { throw error('Secure interactive TTY required for saas:platform-mfa-enroll; enrollment was not issued.'); }
    const environment = dependencies.env ?? process.env;
    const connectionString = environment.MODEL_ROUTER_SAAS_DATABASE_URL;
    if (typeof connectionString !== 'string' || !connectionString.trim()) {
      throw error('MODEL_ROUTER_SAAS_DATABASE_URL is required for saas:platform-mfa-enroll.');
    }
    const poolOptions = managementPoolOptions(connectionString, options);
    const module = environment.MODEL_ROUTER_SAAS_KMS_PROVIDER;
    if (typeof module !== 'string' || !module || module.length > 4096) {
      throw error('MODEL_ROUTER_SAAS_KMS_PROVIDER must explicitly name a trusted platform TOTP provider module.');
    }
    try { resolveProviderModuleSpecifier(module); }
    catch { throw error('The explicit platform TOTP provider module is invalid; enrollment was not issued.'); }

    prompt ??= interactivePrompt();
    let email: string;
    let audit: PlatformMfaEnrollmentIssuanceAudit;
    try {
      email = (await prompt.ask('Platform administrator email: ')).trim().toLowerCase();
      const operatorId = await prompt.ask('Trusted operator identity (non-secret opaque reference): ');
      const reasonCode = await prompt.ask('Operation reason code (initial-enrollment or approved-enrollment): ');
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || /[\u0000-\u001f\u007f]/.test(email)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(operatorId)
        || !['initial-enrollment', 'approved-enrollment'].includes(reasonCode)) throw new Error('invalid');
      audit = { operatorId, reasonCode: reasonCode as PlatformMfaEnrollmentIssuanceAudit['reasonCode'], requestId: randomUUID() };
    } catch { throw error(INPUT_FAILED); }

    try {
      database = await (dependencies.createDatabase ?? createManagementDatabase)({ connectionString }, poolOptions);
      await database.ping();
    } catch { throw error('Unable to connect to the explicit management PostgreSQL database; enrollment was not issued.'); }
    try { await database.verifySchema(); }
    catch { throw error('Current managed SaaS schema is required; apply explicit migrations separately. Enrollment was not issued.'); }
    try {
      await (dependencies.verifyControlPlanePrivileges ?? ((db) => verifySaasRuntimeDatabasePrivileges(db, 'control_plane')))(database);
    } catch { throw error('Restricted control-plane database privileges are required; enrollment was not issued.'); }
    try {
      const state = await database.query<{ initialized: unknown }>(
        'SELECT initialized FROM saas_platform_state WHERE singleton = TRUE',
      );
      if (state.rows.length !== 1 || state.rows[0]?.initialized !== true) throw new Error('invalid');
    } catch { throw error('The managed SaaS platform must already be initialized; enrollment was not issued.'); }

    try {
      provider = await (dependencies.loadKeyProvider ?? loadCredentialKeyProvider)(module, { env: providerEnvironment(environment) });
    } catch { throw error('Trusted platform TOTP KMS readiness failed; enrollment was not issued.'); }
    let service: EnrollmentService;
    try {
      service = (dependencies.createAuthService ?? ((db, keyProvider) => new PlatformAdminAuthService(db, keyProvider)))(database, provider);
    } catch { throw error('Unable to initialize platform MFA enrollment; enrollment was not issued.'); }
    try { checkTerminal(); } catch { throw error('Secure interactive terminal is no longer available; enrollment was not issued.'); }
    let enrollment: Awaited<ReturnType<EnrollmentService['issueMfaEnrollmentToken']>>;
    issuanceAttempted = true;
    try { enrollment = await service.issueMfaEnrollmentToken(email, audit); }
    catch (cause) {
      if (cause instanceof PlatformAuthError && cause.code === 'MFA_ENROLLMENT_UNAVAILABLE') {
        throw error('MFA enrollment was denied by existing account, role, verified or pending-enrollment checks. No challenge was returned; review the current enrollment before retrying.');
      }
      if (cause instanceof PlatformAuthError && ['INVALID_INPUT', 'MFA_UNAVAILABLE'].includes(cause.code)) {
        throw error('Platform MFA enrollment is unavailable or operator input is invalid; enrollment was not issued.');
      }
      throw error(ISSUANCE_UNKNOWN);
    }
    issued = true;
    if (!enrollment || typeof enrollment.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(enrollment.token)
      || typeof enrollment.expiresAt !== 'string' || !Number.isFinite(Date.parse(enrollment.expiresAt))
      || new Date(enrollment.expiresAt).toISOString() !== enrollment.expiresAt) throw error(DELIVERY_FAILED);
    try {
      checkTerminal();
      await (dependencies.writeToTerminal ?? terminalWrite)(
        `One-time platform MFA enrollment challenge:\nToken: ${enrollment.token}\nExpires at: ${enrollment.expiresAt}\n`
        + 'Hand this challenge securely to the intended administrator for /admin/api/v1/auth/mfa/enrollment/start, then /admin/api/v1/auth/mfa/enrollment/confirm.\n',
      );
      delivered = true;
    } catch { throw error(DELIVERY_FAILED); }
  } catch (cause) {
    failure = cause instanceof SaasPlatformMfaEnrollmentError ? cause
      : error(issuanceAttempted ? ISSUANCE_UNKNOWN : 'Unable to complete platform MFA enrollment; enrollment was not issued.');
  } finally {
    let cleanupFailed = false;
    if (provider) { try { await provider.close(); } catch { cleanupFailed = true; } }
    if (database) { try { await database.close(); } catch { cleanupFailed = true; } }
    if (prompt) { try { await prompt.close(); } catch { cleanupFailed = true; } }
    if (cleanupFailed && !failure) {
      failure = error(issued && delivered
        ? 'The enrollment challenge was issued and displayed, but cleanup failed. Do not repeat issuance.'
        : issued ? DELIVERY_FAILED : 'Unable to close operator resources; enrollment was not issued.');
    }
  }
  if (failure) throw failure;
}
