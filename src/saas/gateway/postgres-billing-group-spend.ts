import { SaasBillingGroupsError } from '../billing/groups/errors.js';
import {
  type BillingGroupSpendReservedWindow,
  type BillingGroupSpendWindow,
  reserveBillingGroupSpend,
  selectFrozenGroupSpendTerms,
} from '../billing/groups/spend-store.js';
import type { SqlExecutor } from '../db/types.js';
import type { SupplyMode } from './contracts.js';

/**
 * R1 billing-group spend admission (roadmap 1.3, phase 3): runs inside the
 * caller's admission transaction after the platform wallet hold has been
 * taken (the KEY-BUD keyBudget.reserve position). Reads the frozen
 * daily/weekly/monthly ceilings from this request's customer price snapshot
 * (migration 112 — never the mutable group table, the R1 red line), then
 * reserve-first-then-check: the hold amount lands in the window counters,
 * the projected settled+outstanding total is evaluated, and a denial throws
 * so the surrounding rollback removes every effect. Only platform
 * admissions carry a wallet hold; BYOK is a no-op.
 */
export interface BillingGroupSpendAdmissionFacts {
  readonly tenantId: string;
  readonly requestId: string;
  readonly supplyMode: SupplyMode;
  /** The platform billing hold just taken for this request; null for BYOK. */
  readonly charge: { readonly currency: string; readonly amountMinorUnits: string } | null;
}

export interface BillingGroupSpendAdmissionPort {
  reserve(executor: SqlExecutor, facts: BillingGroupSpendAdmissionFacts): Promise<void>;
}

export interface PostgresBillingGroupSpendAdmissionOptions {
  /** Server-owned clock; the window buckets are derived from it. */
  readonly now: () => Date;
}

export class BillingGroupSpendAdmissionDeniedError extends Error {
  readonly code = 'GROUP_SPEND_EXCEEDED' as const;
  readonly deniedWindow: 'daily' | 'weekly' | 'monthly';

  constructor(deniedWindow: 'daily' | 'weekly' | 'monthly') {
    super('The billing group spend limit is exhausted.');
    this.name = 'BillingGroupSpendAdmissionDeniedError';
    this.deniedWindow = deniedWindow;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Pure projection: a window denies when settled + outstanding exceeds its frozen ceiling. */
export function evaluateBillingGroupSpendWindow(window: BillingGroupSpendReservedWindow): {
  readonly allowed: boolean;
  readonly projectedTotal: bigint;
  readonly cap: bigint;
} {
  const projectedTotal = BigInt(window.settled) + BigInt(window.outstandingReserved);
  const cap = BigInt(window.limitMinorUnits);
  return { allowed: projectedTotal <= cap, projectedTotal, cap };
}

function windowsFromTerms(
  terms: NonNullable<Awaited<ReturnType<typeof selectFrozenGroupSpendTerms>>>,
): readonly BillingGroupSpendWindow[] {
  const windows: BillingGroupSpendWindow[] = [];
  if (terms.dailyLimitMinorUnits !== null) {
    windows.push({ kind: 'daily', windowStart: '', limitMinorUnits: terms.dailyLimitMinorUnits });
  }
  if (terms.weeklyLimitMinorUnits !== null) {
    windows.push({ kind: 'weekly', windowStart: '', limitMinorUnits: terms.weeklyLimitMinorUnits });
  }
  if (terms.monthlyLimitMinorUnits !== null) {
    windows.push({ kind: 'monthly', windowStart: '', limitMinorUnits: terms.monthlyLimitMinorUnits });
  }
  return windows;
}

export function createPostgresBillingGroupSpendAdmission(
  options: PostgresBillingGroupSpendAdmissionOptions,
): BillingGroupSpendAdmissionPort {
  if (typeof options?.now !== 'function') {
    throw new SaasBillingGroupsError('GROUP_SPEND_STORAGE_ERROR');
  }
  return {
    async reserve(executor, facts) {
      if (facts.supplyMode !== 'platform') {
        if (facts.charge !== null) {
          throw new SaasBillingGroupsError('GROUP_SPEND_STORAGE_ERROR');
        }
        return;
      }
      if (facts.charge === null) {
        throw new SaasBillingGroupsError('GROUP_SPEND_STORAGE_ERROR');
      }
      const terms = await selectFrozenGroupSpendTerms(executor, facts.tenantId, facts.requestId);
      if (terms === null) {
        // A platform admission without its price snapshot is authority drift;
        // fail closed rather than silently waiving the group ceilings.
        throw new SaasBillingGroupsError('GROUP_SPEND_STORAGE_ERROR');
      }
      const windows = windowsFromTerms(terms);
      if (windows.length === 0) return;
      const reserved = await reserveBillingGroupSpend(
        executor,
        {
          tenantId: facts.tenantId,
          requestId: facts.requestId,
          billingGroupId: terms.billingGroupId,
          windows,
          chargeMinorUnits: facts.charge.amountMinorUnits,
          chargeCurrency: facts.charge.currency,
        },
        options.now(),
      );
      for (const window of reserved) {
        const verdict = evaluateBillingGroupSpendWindow(window);
        if (!verdict.allowed) {
          throw new BillingGroupSpendAdmissionDeniedError(window.kind);
        }
      }
    },
  };
}
