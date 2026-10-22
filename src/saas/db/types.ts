export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

/** One immutable SQL statement selected by a trusted module at module load. */
export interface PreparedSqlStatement {
  readonly name: string;
  readonly text: string;
}

export interface SqlExecutor {
  query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>>;
  /** Optional native wire capability; absence keeps the ordinary query path. */
  queryPrepared?<Row>(statement: PreparedSqlStatement, values?: readonly unknown[]): Promise<SqlResult<Row>>;
}

export interface SaasDatabaseClient extends SqlExecutor {
  release(error?: Error | boolean): void;
}

export interface SaasDatabasePool extends SqlExecutor {
  connect(): Promise<SaasDatabaseClient>;
  end(): Promise<void>;
}

export interface SaasDatabase extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  verifySchema(): Promise<void>;
  /** Optional because test/custom database seams may expose only base schema readiness. */
  verifyUnknownOutcomeSchema?(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface SaasDatabaseOptions {
  connectionString: string;
  /**
   * Maximum pooled server connections for this process. Wins over the
   * MODEL_ROUTER_SAAS_DB_POOL_MAX environment override and the built-in
   * default (see database.ts for the default's PostgreSQL budget math).
   */
  max?: number;
  idleTimeoutMillis?: number;
  /**
   * Queue-inclusive client acquisition timeout: the time a caller may wait
   * for an idle client plus, when a new server connection is opened, the time
   * to establish it. Exceeding it fails acquisition (observed by clients as a
   * connection timeout, e.g. 503 REQUEST_BLOCKED under pool exhaustion).
   * 0 disables the timeout. Wins over the
   * MODEL_ROUTER_SAAS_DB_POOL_ACQUISITION_TIMEOUT_MILLIS environment override.
   */
  connectionTimeoutMillis?: number;
  /**
   * Native wire prepared statements require a direct/session-compatible PostgreSQL
   * connection or a verified pooler. Defaults to off. Explicit options win over
   * MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS for an owned pool. Injected pools
   * ignore the environment and only forward capabilities under an explicit native option.
   */
  preparedStatements?: 'off' | 'native';
  /**
   * Environment source for the pool settings above. Defaults to
   * process.env. Only consulted when no pool is injected.
   */
  env?: Record<string, string | undefined>;
  /** Pool injection is intended for deterministic tests and custom runtimes. */
  pool?: SaasDatabasePool;
}
