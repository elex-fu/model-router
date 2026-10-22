import { createHash } from 'node:crypto';
import type { PreparedSqlStatement, SqlExecutor, SqlResult } from './types.js';

type PreparedStatementLabel =
  | 'cm-final'
  | 'sched-byok'
  | 'sched-platform'
  | 'prep-byok'
  | 'prep-platform'
  | 'proof-core'
  | 'proof-tenant'
  | 'proof-platform';

/** Called only for fixed gateway SQL constants, never for request values. */
export function createPreparedSqlStatement(label: PreparedStatementLabel, text: string): PreparedSqlStatement {
  return Object.freeze({
    name: `mr_${label}_${createHash('sha256').update(text).digest('base64url')}`,
    text,
  });
}

/** Capability absence is compatible; an execution error is never replayed. */
export function queryPreparedOrAnonymous<Row>(
  executor: SqlExecutor,
  statement: PreparedSqlStatement,
  values?: readonly unknown[],
): Promise<SqlResult<Row>> {
  return typeof executor.queryPrepared === 'function'
    ? executor.queryPrepared<Row>(statement, values)
    : executor.query<Row>(statement.text, values);
}
