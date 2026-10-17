import type { SqlExecutor } from '../../db/types.js';
import { correctBillingGroupSpend, releaseBillingGroupSpend, settleBillingGroupSpend } from './spend-store.js';

/**
 * R1 (roadmap 1.3, phase 3) group-spend resolution port shared by the
 * settlement, compensation, recovery, and correction durable ports — the
 * createKeyBudgetResolution() pattern at group scope. Every method runs on
 * the caller's executor inside the caller's transaction; errors propagate
 * so the surrounding transaction rolls back. Consumers declare their own
 * minimal structural slice of this port, so any subset remains
 * wiring-compatible.
 */
export interface BillingGroupSpendResolutionPort {
  settle(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly actualChargeMinorUnits: string;
      readonly actualChargeCurrency: string;
    },
  ): Promise<boolean>;
  release(executor: SqlExecutor, input: { readonly tenantId: string; readonly requestId: string }): Promise<boolean>;
  correct(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly chargeSettledDelta: string;
    },
  ): Promise<boolean>;
}

/** Stateless adapter over the spend-store primitives; safe to share across ports. */
export function createBillingGroupSpendResolution(): BillingGroupSpendResolutionPort {
  return {
    settle: (executor, input) =>
      settleBillingGroupSpend(
        executor,
        input.tenantId,
        input.requestId,
        input.actualChargeMinorUnits,
        input.actualChargeCurrency,
      ),
    release: (executor, input) => releaseBillingGroupSpend(executor, input.tenantId, input.requestId),
    correct: (executor, input) =>
      correctBillingGroupSpend(executor, input.tenantId, input.requestId, input.chargeSettledDelta),
  };
}
