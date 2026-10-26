import { performance } from 'node:perf_hooks';
import type { PreparedSqlStatement, SqlExecutor, SqlResult } from '../db/types.js';

export interface PostgresPreparationObservation {
  readonly kind: 'query' | 'phase';
  readonly phase: 'authority' | 'admission-guard' | 'admission' | 'attempt' | 'preparation';
  /** Fixed operation/table labels only; never SQL, identities, or bound values. */
  readonly operation: string;
  readonly durationMs: number;
  readonly outcome: 'ok' | 'error';
}

export type PostgresPreparationObserver = (observation: PostgresPreparationObservation) => void;

const PREPARATION_EXECUTOR = Symbol('postgres-preparation-executor');
const observedExecutors = new WeakMap<SqlExecutor, SqlExecutor>();

/** Only actual forwarding wrappers created below can unwrap to an executor. */
export function unwrapPreparationExecutor(executor: SqlExecutor): SqlExecutor {
  let underlying = observedExecutors.get(executor);
  while (underlying) {
    executor = underlying;
    underlying = observedExecutors.get(executor);
  }
  return executor;
}
interface ObservedPreparationExecutor extends SqlExecutor {
  readonly [PREPARATION_EXECUTOR]: {
    readonly executor: SqlExecutor;
    readonly observer: PostgresPreparationObserver;
  };
}

function emit(observer: PostgresPreparationObserver, observation: PostgresPreparationObservation): void {
  try {
    observer(observation);
  } catch {
    // Diagnostics cannot change an authorization or reservation decision.
  }
}

export function observePreparationExecutor(
  executor: SqlExecutor,
  phase: PostgresPreparationObservation['phase'],
  observer: PostgresPreparationObserver | undefined,
): SqlExecutor {
  if (!observer) return executor;
  const activeObserver = observer;
  const parent = (executor as Partial<ObservedPreparationExecutor>)[PREPARATION_EXECUTOR];
  // The admission port and guard share one transaction. Identical observers
  // see a query once at its innermost phase, rather than counting every nested
  // executor wrapper. Different observers retain their independent views.
  const underlying = parent?.observer === observer ? parent.executor : executor;
  async function observeQuery<Row>(sql: string, work: () => Promise<SqlResult<Row>>): Promise<SqlResult<Row>> {
    const operation =
      /\/\*\s*([a-z][a-z0-9:-]*)\s*\*\//i.exec(sql)?.[1] ??
      (/\bpg_advisory_xact_lock_shared\s*\(\s*\$\d+\s*::\s*bigint\s*\)/i.test(sql)
        ? 'advisory-lock-shared-int8'
        : undefined) ??
      (/\bpg_advisory_xact_lock_shared\s*\(/i.test(sql) ? 'advisory-lock-shared' : undefined) ??
      (/\bpg_advisory_xact_lock\s*\(\s*\$\d+\s*::\s*bigint\s*\)/i.test(sql)
        ? 'advisory-lock-exclusive-int8'
        : undefined) ??
      (/\bpg_advisory_xact_lock\s*\(/i.test(sql) ? 'advisory-lock-exclusive' : undefined) ??
      (/\bclock_timestamp\s*\(\s*\)/i.test(sql) ? 'database-clock' : undefined) ??
      /\b(?:FROM|INTO|UPDATE)\s+(saas_[a-z0-9_]+)/i.exec(sql)?.[1] ??
      /^\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase() ??
      'query';
    const started = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      const result = await work();
      outcome = 'ok';
      return result;
    } finally {
      emit(activeObserver, { kind: 'query', phase, operation, durationMs: performance.now() - started, outcome });
    }
  }
  const query = underlying.query.bind(underlying);
  const observed: ObservedPreparationExecutor = {
    [PREPARATION_EXECUTOR]: Object.freeze({ executor: underlying, observer }),
    query: <Row>(sql: string, values?: readonly unknown[]) => observeQuery(sql, () => query<Row>(sql, values)),
  };
  if (typeof underlying.queryPrepared === 'function') {
    const queryPrepared = underlying.queryPrepared.bind(underlying);
    observed.queryPrepared = <Row>(statement: PreparedSqlStatement, values?: readonly unknown[]) =>
      observeQuery<Row>(statement.text, () => queryPrepared<Row>(statement, values));
  }
  observedExecutors.set(observed, underlying);
  return Object.freeze(observed);
}

export async function observePreparationPhase<T>(
  phase: PostgresPreparationObservation['phase'],
  operation: string,
  observer: PostgresPreparationObserver | undefined,
  work: () => Promise<T>,
  isSuccessful?: (result: T) => boolean,
): Promise<T> {
  if (!observer) return work();
  const started = performance.now();
  let outcome: 'ok' | 'error' = 'error';
  try {
    const result = await work();
    try {
      outcome = isSuccessful === undefined || isSuccessful(result) ? 'ok' : 'error';
    } catch {
      // A diagnostic result classifier cannot change the original result.
    }
    return result;
  } finally {
    emit(observer, { kind: 'phase', phase, operation, durationMs: performance.now() - started, outcome });
  }
}
