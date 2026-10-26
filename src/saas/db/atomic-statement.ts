import type { SaasDatabase, SqlResult } from './types.js';

/** A single SQL statement only; never use this for a multi-statement workflow. */
export function queryReadCommitted<Row>(
  database: SaasDatabase,
  sql: string,
  values?: readonly unknown[],
): Promise<SqlResult<Row>> {
  return database.queryReadCommitted
    ? database.queryReadCommitted<Row>(sql, values)
    : database.transaction((tx) => tx.query<Row>(sql, values));
}
