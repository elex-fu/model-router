import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';
import { runSaasMigrations, verifySaasMigrations, verifyUnknownOutcomeSaasMigrations } from './migrate.js';
import type {
  SaasDatabase,
  SaasDatabaseClient,
  SaasDatabaseOptions,
  SaasDatabasePool,
  SqlExecutor,
  SqlResult,
} from './types.js';

/** Environment override for the per-process pool maximum (positive integer). */
export const SAAS_DATABASE_POOL_MAX_ENV = 'MODEL_ROUTER_SAAS_DB_POOL_MAX';
/**
 * Environment override for the queue-inclusive client acquisition timeout in
 * milliseconds (0 disables the timeout).
 */
export const SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV = 'MODEL_ROUTER_SAAS_DB_POOL_ACQUISITION_TIMEOUT_MILLIS';

/**
 * Default per-process pool maximum.
 *
 * Budget math against PostgreSQL 16 defaults (max_connections = 100,
 * superuser_reserved_connections = 3, so ~97 connections are usable by
 * application roles): the reference compose deployment runs five long-lived
 * pools — gateway ×3, control-plane, credential-validation-worker — so
 * 5 × 16 = 80 connections, ~83% of the usable budget, leaving ~17 slots for
 * the migrator role, operator sessions, and burst. When scaling the gateway
 * replica count or raising PostgreSQL max_connections, operators tune this
 * per process via MODEL_ROUTER_SAAS_DB_POOL_MAX (target aggregate ≤
 * max_connections − superuser_reserved_connections).
 *
 * A larger pool removes pool-queue acquisition timeouts (R9 finding P3); it
 * does not de-serialize admission itself — per-tenant admission remains
 * serialized by the capacity scope fences and the per-wallet billing fence
 * (R9 finding P4), so requests queued on those fences continue to hold their
 * pooled connection while they wait.
 */
export const DEFAULT_SAAS_DATABASE_POOL_MAX = 16;
export const DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS = 5_000;
export const DEFAULT_SAAS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS = 30_000;

const MAX_POOL_UPPER_BOUND = 10_000;
const ACQUISITION_TIMEOUT_UPPER_BOUND_MILLIS = 3_600_000;

export interface SaasDatabasePoolSettings {
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
}

function envInteger(
  env: Record<string, string | undefined>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * Resolves the effective pool settings with explicit, fail-closed precedence:
 * an explicit option wins over the environment override, which wins over the
 * built-in default. Malformed or out-of-range environment values throw
 * instead of being silently coerced.
 */
export function resolveSaasDatabasePoolSettings(
  options: Pick<SaasDatabaseOptions, 'max' | 'idleTimeoutMillis' | 'connectionTimeoutMillis'>,
  env: Record<string, string | undefined>,
): SaasDatabasePoolSettings {
  return {
    max:
      options.max ??
      envInteger(env, SAAS_DATABASE_POOL_MAX_ENV, 1, MAX_POOL_UPPER_BOUND) ??
      DEFAULT_SAAS_DATABASE_POOL_MAX,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_SAAS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ??
      envInteger(env, SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV, 0, ACQUISITION_TIMEOUT_UPPER_BOUND_MILLIS) ??
      DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS,
  };
}

function validateOptions(options: SaasDatabaseOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    typeof options.connectionString !== 'string' ||
    options.connectionString.trim() === ''
  ) {
    throw new TypeError('A PostgreSQL connectionString is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(options.connectionString);
  } catch {
    throw new TypeError('connectionString must be a valid PostgreSQL URL');
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    (!parsed.hostname && !parsed.searchParams.get('host')) ||
    parsed.hash !== ''
  ) {
    throw new TypeError('connectionString must identify a PostgreSQL server');
  }

  if (options.max !== undefined && (!Number.isSafeInteger(options.max) || options.max < 1)) {
    throw new TypeError('max must be a positive integer');
  }
  if (
    options.idleTimeoutMillis !== undefined &&
    (!Number.isSafeInteger(options.idleTimeoutMillis) || options.idleTimeoutMillis < 0)
  ) {
    throw new TypeError('idleTimeoutMillis must be a non-negative integer');
  }
  if (
    options.connectionTimeoutMillis !== undefined &&
    (!Number.isSafeInteger(options.connectionTimeoutMillis) || options.connectionTimeoutMillis < 0)
  ) {
    throw new TypeError('connectionTimeoutMillis must be a non-negative integer');
  }
  if (
    options.pool !== undefined &&
    (!options.pool ||
      typeof options.pool !== 'object' ||
      typeof options.pool.query !== 'function' ||
      typeof options.pool.connect !== 'function' ||
      typeof options.pool.end !== 'function')
  ) {
    throw new TypeError('pool must implement the SaaS database pool contract');
  }
  if (options.env !== undefined && (typeof options.env !== 'object' || options.env === null)) {
    throw new TypeError('env must be an environment record');
  }
}

function asSqlResult<Row>(result: QueryResult): SqlResult<Row> {
  return {
    rows: result.rows as Row[],
    rowCount: result.rowCount,
  };
}

class NodePostgresClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values ? [...values] : undefined);
    return asSqlResult<Row>(result);
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class NodePostgresPool implements SaasDatabasePool {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.pool.query(sql, values ? [...values] : undefined);
    return asSqlResult<Row>(result);
  }

  async connect(): Promise<SaasDatabaseClient> {
    return new NodePostgresClient(await this.pool.connect());
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export function createSaasDatabase(options: SaasDatabaseOptions): SaasDatabase {
  validateOptions(options);
  // Pool settings (and their environment overrides) are only resolved when
  // this call owns the pool; an injected pool keeps its caller's sizing.
  const pool =
    options.pool ??
    new NodePostgresPool({
      connectionString: options.connectionString,
      ...resolveSaasDatabasePoolSettings(options, options.env ?? process.env),
    });
  let closePromise: Promise<void> | undefined;

  const executor: SqlExecutor = {
    query: <Row>(sql: string, values?: readonly unknown[]) => pool.query<Row>(sql, values),
  };

  return {
    query: executor.query,
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let transactionStarted = false;
      let discardClient = false;

      try {
        // Advisory authorization fences wait before a separate authority read.
        // Each read needs a fresh snapshot even when the session default differs.
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        transactionStarted = true;
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discardClient = true;
          }
        } else {
          discardClient = true;
        }
        throw error;
      } finally {
        client.release(discardClient);
      }
    },
    async migrate(): Promise<void> {
      await runSaasMigrations(pool);
    },
    async verifySchema(): Promise<void> {
      await verifySaasMigrations(pool);
    },
    async verifyUnknownOutcomeSchema(): Promise<void> {
      await verifyUnknownOutcomeSaasMigrations(pool);
    },
    async ping(): Promise<void> {
      await pool.query('SELECT 1');
    },
    close(): Promise<void> {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
