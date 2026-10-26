import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';
import { currentRequestDiagnosticTrace } from '../gateway/request-diagnostic-trace.js';
import { runSaasMigrations, verifySaasMigrations, verifyUnknownOutcomeSaasMigrations } from './migrate.js';
import type {
  PreparedSqlStatement,
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
/** Opt-in native wire prepared statements; unknown poolers keep the off default. */
export const SAAS_DATABASE_PREPARED_STATEMENTS_ENV = 'MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS';

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

export function resolveSaasDatabasePreparedStatements(
  options: Pick<SaasDatabaseOptions, 'preparedStatements' | 'pool'>,
  env: Record<string, string | undefined>,
): 'off' | 'native' {
  const value =
    options.preparedStatements ?? (options.pool === undefined ? env[SAAS_DATABASE_PREPARED_STATEMENTS_ENV] : undefined);
  if (value === undefined) return 'off';
  if (value !== 'off' && value !== 'native') {
    throw new TypeError(`${SAAS_DATABASE_PREPARED_STATEMENTS_ENV} must be off or native`);
  }
  return value;
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
  if (
    options.preparedStatements !== undefined &&
    options.preparedStatements !== 'off' &&
    options.preparedStatements !== 'native'
  ) {
    throw new TypeError('preparedStatements must be off or native');
  }
}

function asSqlResult<Row>(result: QueryResult): SqlResult<Row> {
  return {
    rows: result.rows as Row[],
    rowCount: result.rowCount,
  };
}

class NodePostgresClient implements SaasDatabaseClient {
  private connectionFailure?: Error;
  private readonly onConnectionError = (error: Error): void => {
    this.connectionFailure ??= error;
  };

  constructor(private readonly client: PoolClient) {
    // pg-pool removes its idle listener on checkout. Own errors for the whole
    // checkout, including gaps between statements; pg still rejects active queries.
    this.client.on('error', this.onConnectionError);
  }

  private async diagnosticQuery<T>(work: () => Promise<T>): Promise<T> {
    if (this.connectionFailure) throw this.connectionFailure;
    const trace = currentRequestDiagnosticTrace();
    if (!trace) return work();
    const finish = trace.begin('query');
    let onError: ((error: Error) => void) | undefined;
    const connectionError = new Promise<never>((_resolve, reject) => {
      onError = reject;
      this.client.once('error', onError);
    });
    try {
      return await Promise.race([work(), connectionError]);
    } finally {
      if (onError) this.client.removeListener('error', onError);
      finish();
    }
  }

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    return this.diagnosticQuery(async () => {
      const result = await this.client.query(sql, values ? [...values] : undefined);
      return asSqlResult<Row>(result);
    });
  }

  async queryPrepared<Row>(statement: PreparedSqlStatement, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    return this.diagnosticQuery(async () => {
      const result = await this.client.query({
        name: statement.name,
        text: statement.text,
        values: values ? [...values] : undefined,
      });
      return asSqlResult<Row>(result);
    });
  }

  release(error?: Error | boolean): void {
    try {
      // A disconnected checkout cannot be returned as reusable. pg-pool installs
      // its idle listener synchronously during release before we relinquish ownership.
      this.client.release(this.connectionFailure ? true : error);
    } finally {
      this.client.removeListener('error', this.onConnectionError);
    }
  }
}

class NodePostgresPool implements SaasDatabasePool {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
    this.pool.on('error', () => {
      // pg-pool already removed the failed idle client before emitting this event.
      // Keep the process alive; explicit operations still reject normally. Neither
      // the error nor its attached client/connection details are safe to log here.
    });
  }

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    if (currentRequestDiagnosticTrace()) {
      const client = await this.connect();
      let discard = true;
      try {
        const result = await client.query<Row>(sql, values);
        discard = false;
        return result;
      } finally {
        client.release(discard);
      }
    }
    const result = await this.pool.query(sql, values ? [...values] : undefined);
    return asSqlResult<Row>(result);
  }

  async queryPrepared<Row>(statement: PreparedSqlStatement, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    if (currentRequestDiagnosticTrace()) {
      const client = await this.connect();
      let discard = true;
      try {
        const result = await client.queryPrepared!<Row>(statement, values);
        discard = false;
        return result;
      } finally {
        client.release(discard);
      }
    }
    const result = await this.pool.query({
      name: statement.name,
      text: statement.text,
      values: values ? [...values] : undefined,
    });
    return asSqlResult<Row>(result);
  }

  async connect(): Promise<SaasDatabaseClient> {
    const finish = currentRequestDiagnosticTrace()?.begin('pool-checkout');
    try {
      return new NodePostgresClient(await this.pool.connect());
    } finally {
      finish?.();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function scopedExecutor(underlying: SqlExecutor, preparedStatements: 'off' | 'native'): SqlExecutor {
  const executor: SqlExecutor = {
    query: <Row>(sql: string, values?: readonly unknown[]) => underlying.query<Row>(sql, values),
  };
  if (preparedStatements === 'native' && typeof underlying.queryPrepared === 'function') {
    const queryPrepared = underlying.queryPrepared.bind(underlying);
    executor.queryPrepared = <Row>(statement: PreparedSqlStatement, values?: readonly unknown[]) =>
      queryPrepared<Row>(statement, values);
  }
  return executor;
}

export function createSaasDatabase(options: SaasDatabaseOptions): SaasDatabase {
  validateOptions(options);
  const preparedStatements = resolveSaasDatabasePreparedStatements(options, options.env ?? process.env);
  // Pool settings (and their environment overrides) are only resolved when
  // this call owns the pool; an injected pool keeps its caller's sizing.
  const pool =
    options.pool ??
    new NodePostgresPool({
      connectionString: options.connectionString,
      ...resolveSaasDatabasePoolSettings(options, options.env ?? process.env),
    });
  let closePromise: Promise<void> | undefined;

  const executor = scopedExecutor(pool, preparedStatements);

  return {
    ...executor,
    async queryReadCommitted<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      const client = await pool.connect();
      let finishTransaction: (() => void) | undefined;
      let transactionStarted = false;
      let discardClient = false;
      try {
        // Never cache this fact: a session setting can change while the pooled
        // connection is reused. The observation and write use this same client.
        const isolation = await client.query<{ default_transaction_isolation: string }>(
          'SHOW default_transaction_isolation',
        );
        if (isolation.rows[0]?.default_transaction_isolation === 'read committed') {
          return await client.query<Row>(sql, values);
        }
        // Unknown/custom session settings retain the original explicit-RC
        // semantics rather than exposing serialization failures to callers.
        finishTransaction = currentRequestDiagnosticTrace()?.begin('transaction');
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        transactionStarted = true;
        const result = await client.query<Row>(sql, values);
        await client.query('COMMIT');
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discardClient = true;
          }
        } else {
          // A failed autocommit/connection observation must not return a
          // possibly disconnected or protocol-uncertain client to the pool.
          discardClient = true;
        }
        throw error;
      } finally {
        try {
          client.release(discardClient);
        } finally {
          finishTransaction?.();
        }
      }
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const finishTransaction = currentRequestDiagnosticTrace()?.begin('transaction');
      let transactionStarted = false;
      let discardClient = false;

      try {
        // Advisory authorization fences wait before a separate authority read.
        // Each read needs a fresh snapshot even when the session default differs.
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        transactionStarted = true;
        const value = await work(scopedExecutor(client, preparedStatements));
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
        try {
          client.release(discardClient);
        } finally {
          finishTransaction?.();
        }
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
