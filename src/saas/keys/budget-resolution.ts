import type { SqlExecutor } from '../db/types.js';
import { applyKeyBudgetCorrection, releaseKeyBudgetReservation, settleKeyBudgetReservation } from './budget-store.js';

/**
 * KEY-BUD (contract C-4, migration 081) resolution port shared by the
 * settlement, compensation, and correction durable ports. Every method runs on
 * the caller's executor inside the caller's transaction; errors propagate so
 * the surrounding transaction rolls back. Consumers declare their own minimal
 * structural slice of this port, so any subset remains wiring-compatible.
 */
export interface KeyBudgetResolutionPort {
  settle(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly actualTokenUnits: string;
      readonly actualChargeMinorUnits: string;
    },
  ): Promise<boolean>;
  release(executor: SqlExecutor, input: { readonly tenantId: string; readonly requestId: string }): Promise<boolean>;
  correct(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly tokenSettledDelta: string;
      readonly chargeSettledDelta: string;
    },
  ): Promise<boolean>;
}

/** Stateless adapter over the budget-store primitives; safe to share across ports. */
export function createKeyBudgetResolution(): KeyBudgetResolutionPort {
  return {
    settle: (executor, input) =>
      settleKeyBudgetReservation(
        executor,
        input.tenantId,
        input.requestId,
        input.actualTokenUnits,
        input.actualChargeMinorUnits,
      ),
    release: (executor, input) => releaseKeyBudgetReservation(executor, input.tenantId, input.requestId),
    correct: (executor, input) =>
      applyKeyBudgetCorrection(
        executor,
        input.tenantId,
        input.requestId,
        input.tokenSettledDelta,
        input.chargeSettledDelta,
      ),
  };
}
