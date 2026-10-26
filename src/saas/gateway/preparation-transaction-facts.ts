import type { SqlExecutor } from '../db/types.js';
import { unwrapPreparationExecutor } from './postgres-preparation-observer.js';
import {
  preservesPreparationAuthorityOnly,
  preservesPreparationTransactionFacts,
} from './preparation-fact-preserving-statements.js';

export interface PreparationTransactionIdentity {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly payloadSha256: string;
}
export interface PreparationTransactionContext {
  readonly token: object;
  readonly revision: object;
  readonly recordsRevision: object;
  readonly identity: PreparationTransactionIdentity;
  readonly canonicalEvidence: string | undefined;
}
interface Scope {
  readonly identity: PreparationTransactionIdentity;
  readonly token: object;
  pendingUnknown: number;
  active: boolean;
  revision: object;
  recordsRevision: object;
  armed: boolean;
  revoked: boolean;
  canonicalEvidence?: string;
}
// Neither the executor shape nor a caller-supplied symbol is a capability.
// Only a fresh wrapper created by the outer transaction callback can own one.
const scopes = new WeakMap<SqlExecutor, Scope>();

function activeScope(executor: SqlExecutor): Scope | undefined {
  const scope = scopes.get(unwrapPreparationExecutor(executor));
  return scope?.active && !scope.revoked && scope.pendingUnknown === 0 ? scope : undefined;
}

/** Scope ends BEFORE the outer callback returns to COMMIT (also on every rollback/cancel). */
export async function withPreparationTransactionFacts<T>(
  executor: SqlExecutor,
  identity: PreparationTransactionIdentity,
  work: (scoped: SqlExecutor) => Promise<T>,
): Promise<T> {
  const scope: Scope = {
    identity: Object.freeze({ ...identity }),
    token: Object.freeze({}),
    pendingUnknown: 0,
    active: true,
    revision: {},
    recordsRevision: {},
    armed: false,
    revoked: false,
  };
  const invalidate = (sql: string) => {
    if (scope.armed || /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) scope.revoked = true;
    scope.revision = {};
    scope.canonicalEvidence = undefined;
  };
  const run = async <Row>(sql: string, query: () => Promise<import('../db/types.js').SqlResult<Row>>) => {
    if (!scope.active) throw new Error('Preparation transaction scope has ended');
    const authorityOnly = preservesPreparationAuthorityOnly(sql);
    const unknown = !authorityOnly && !preservesPreparationTransactionFacts(sql);
    if (authorityOnly) {
      scope.pendingUnknown += 1;
      scope.recordsRevision = {};
    }
    if (unknown) {
      scope.pendingUnknown += 1;
      invalidate(sql);
    }
    try {
      return await query();
    } finally {
      // Invalidate on completion too: pg queues concurrent promises on one
      // connection, so an unknown write can finish after a fact read resumes.
      if (unknown) {
        scope.pendingUnknown -= 1;
        invalidate(sql);
      }
      if (authorityOnly) {
        scope.pendingUnknown -= 1;
        scope.recordsRevision = {};
      }
    }
  };
  const query = executor.query.bind(executor);
  const scoped: SqlExecutor = {
    query<Row>(sql: string, values?: readonly unknown[]) {
      return run<Row>(sql, () => query<Row>(sql, values));
    },
  };
  if (executor.queryPrepared) {
    const queryPrepared = executor.queryPrepared.bind(executor);
    scoped.queryPrepared = (statement, values) => {
      // Snapshot the actual text once: getters or later caller mutation must
      // not make the checked template differ from the executed statement.
      const selected = Object.freeze({ name: statement.name, text: statement.text });
      return run(selected.text, () => queryPrepared(selected, values));
    };
  }
  Object.freeze(scoped);
  scopes.set(scoped, scope);
  try {
    return await work(scoped);
  } finally {
    scope.active = false;
    scope.revision = {};
    scope.canonicalEvidence = undefined;
  }
}

/** Read-only context; only the concrete guard owns the private fact issuer. */
export function preparationTransactionContext(executor: SqlExecutor): PreparationTransactionContext | undefined {
  const scope = activeScope(executor);
  if (!scope) return;
  scope.armed = true;
  return Object.freeze({
    token: scope.token,
    revision: scope.revision,
    recordsRevision: scope.recordsRevision,
    identity: scope.identity,
    canonicalEvidence: scope.canonicalEvidence,
  });
}

/** Bind the server-built, signed payload exactly, not only its request ID. */
export function bindPreparationTransactionEvidence(executor: SqlExecutor, canonicalEvidence: string): void {
  const scope = activeScope(executor);
  if (scope) scope.canonicalEvidence = canonicalEvidence;
}
