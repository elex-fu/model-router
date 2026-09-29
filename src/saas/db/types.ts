export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>>;
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
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Pool injection is intended for deterministic tests and custom runtimes. */
  pool?: SaasDatabasePool;
}
