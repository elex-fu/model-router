import type { SqlExecutor } from '../db/types.js';
import {
  hasPreparationTransactionAuthority,
  type PreparationReservationIdentity,
} from './postgres-request-admission-guard.js';
import { isPreparationTransactionScopeActive, preparationTransactionContext } from './preparation-transaction-facts.js';

/**
 * Stage only immutable/per-request reads protected by the native admission
 * guard's already-held authority fences. No plan survives an executor scope,
 * unknown statement, or authority revision. Mutable counters and time checks
 * belong in apply, never in read. Custom/unscoped callers retain reserve.
 */
export async function prepareFencedReservation<Facts, Result>(
  executor: SqlExecutor,
  identity: PreparationReservationIdentity,
  read: () => Promise<Facts>,
  apply: (facts: Facts) => Promise<Result>,
  reserve: () => Promise<Result>,
): Promise<() => Promise<Result>> {
  const before = preparationTransactionContext(executor);
  if (!before || !hasPreparationTransactionAuthority(executor, identity)) {
    return reserve;
  }
  const facts = await read();
  let used = false;
  return async () => {
    if (used) throw new Error('Fenced reservation plan has already been consumed');
    used = true;
    if (!isPreparationTransactionScopeActive(executor, before.token)) {
      throw new Error('Fenced reservation transaction scope has ended');
    }
    const isCurrent = () => {
      const current = preparationTransactionContext(executor);
      return (
        current?.token === before.token &&
        current.revision === before.revision &&
        hasPreparationTransactionAuthority(executor, identity)
      );
    };
    if (!isCurrent()) return reserve();
    const result = await apply(facts);
    // pg queues promises on one connection. An unknown statement submitted
    // while a counter/fence query waits must not let the captured policy
    // authorize a commit after its revision changed. Writes may have happened,
    // so rollback is mandatory here; a fresh reserve would double-reserve.
    if (!isCurrent()) throw new Error('Fenced reservation authority changed during apply');
    return result;
  };
}
