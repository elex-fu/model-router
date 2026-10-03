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
  const pool =
    options.pool ??
    new NodePostgresPool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
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
