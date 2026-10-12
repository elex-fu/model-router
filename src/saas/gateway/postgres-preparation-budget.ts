import type { SqlExecutor } from '../db/types.js';
import { evaluateProxyKeyBudgetAdmission, type ProxyKeyBudgetDimension } from '../keys/budget-policy.js';
import {
  KEY_BUDGET_TOKEN_SEMANTICS_VERSION,
  KeyBudgetStoreError,
  keyBudgetTokenUnitsFromBounds,
  keyBudgetUtcDayFrom,
  reserveKeyBudgetCounters,
  selectKeyBudgetPolicyHead,
} from '../keys/budget-store.js';
import type { SupplyMode } from './contracts.js';

/**
 * KEY-BUD admission coordination (contract C-4, migration 081). Runs inside the
 * caller's admission transaction after the metering row exists, the guard has
 * revalidated, and — for platform supply — the billing hold has been taken.
 * The reserve-first-then-check counter upsert serializes concurrent admissions
 * on one lineage; a denial throws and the surrounding rollback removes every
 * effect, so budgets can never be over-admitted. A missing policy head or
 * unresolvable charge currency fails closed with a storage-shaped error.
 */

export interface KeyBudgetAdmissionCharge {
  readonly currency: string;
  readonly amountMinorUnits: string;
}

export interface KeyBudgetAdmissionFacts {
  readonly tenantId: string;
  readonly projectId: string;
  readonly keyId: string;
  readonly requestId: string;
  readonly supplyMode: SupplyMode;
  /** Admission usage upper-bound envelope (inputTotalUpperBound/outputTotalUpperBound). */
  readonly payloadBounds: unknown;
  /** The platform billing hold just taken for this request; null for BYOK. */
  readonly charge: KeyBudgetAdmissionCharge | null;
}

export interface KeyBudgetAdmissionPort {
  reserve(executor: SqlExecutor, facts: KeyBudgetAdmissionFacts): Promise<void>;
}

export class KeyBudgetAdmissionDeniedError extends Error {
  readonly code = 'KEY_BUDGET_EXCEEDED' as const;
  readonly deniedDimension: ProxyKeyBudgetDimension;

  constructor(deniedDimension: ProxyKeyBudgetDimension) {
    super('The API key budget is exhausted.');
    this.name = 'KeyBudgetAdmissionDeniedError';
    this.deniedDimension = deniedDimension;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PostgresKeyBudgetAdmissionOptions {
  /** Server-owned clock; the admission UTC day is derived from it. */
  readonly now: () => Date;
}

function subtract(amount: string, decrement: string): string {
  return (BigInt(amount) - BigInt(decrement)).toString(10);
}

/** Fail-closed wrapper: every non-denial irregularity surfaces as a storage error. */
function storageFailure(): never {
  throw new KeyBudgetStoreError('STORAGE_ERROR');
}

export function createPostgresKeyBudgetAdmission(options: PostgresKeyBudgetAdmissionOptions): KeyBudgetAdmissionPort {
  if (typeof options?.now !== 'function') storageFailure();
  return {
    async reserve(executor, facts) {
      if (!executor || !facts || typeof facts !== 'object') storageFailure();
      const head = await selectKeyBudgetPolicyHead(executor, facts.tenantId, facts.projectId, facts.keyId);
      // 081 backfills every pre-existing key and create() seeds every new one;
      // a missing head is drift, and missing budget linkage only ever over-denies.
      if (!head || head.tenantId !== facts.tenantId || head.projectId !== facts.projectId) {
        storageFailure();
      }
      const day = keyBudgetUtcDayFrom(options.now());
      const tokenUnits = keyBudgetTokenUnitsFromBounds(facts.payloadBounds);
      const charge =
        facts.supplyMode === 'platform' && facts.charge !== null
          ? { currency: facts.charge.currency, amountMinorUnits: facts.charge.amountMinorUnits }
          : null;
      if (facts.supplyMode === 'byok' && facts.charge !== null) storageFailure();

      const reserved = await reserveKeyBudgetCounters(executor, {
        tenantId: facts.tenantId,
        projectId: facts.projectId,
        lineageId: head.lineageId,
        requestId: facts.requestId,
        day,
        tokenUnits,
        chargeMinorUnits: charge?.amountMinorUnits ?? '0',
        chargeCurrency: charge?.currency ?? null,
      });

      const tokenUsage = {
        daily: {
          settled: reserved.daily.settled,
          outstandingReserved: subtract(reserved.daily.outstandingReserved, tokenUnits),
          newReservation: tokenUnits,
        },
        lifetime: {
          settled: reserved.lifetime.settled,
          outstandingReserved: subtract(reserved.lifetime.outstandingReserved, tokenUnits),
          newReservation: tokenUnits,
        },
      };
      const chargeCapsConfigured = head.chargeDaily !== null || head.chargeLifetime !== null;
      const chargeCurrency = charge?.currency ?? reserved.chargeCurrency;
      if (facts.supplyMode === 'platform' && chargeCapsConfigured && chargeCurrency === null) {
        storageFailure();
      }

      const verdict = evaluateProxyKeyBudgetAdmission(
        facts.supplyMode === 'byok'
          ? {
              supplyMode: 'byok',
              tokenCaps: { daily: head.tokenDaily, lifetime: head.tokenLifetime },
            }
          : {
              supplyMode: 'platform',
              tokenCaps: { daily: head.tokenDaily, lifetime: head.tokenLifetime },
              ...(chargeCapsConfigured
                ? {
                    customerChargeCaps: {
                      currency: chargeCurrency as string,
                      daily: head.chargeDaily,
                      lifetime: head.chargeLifetime,
                    },
                  }
                : {}),
            },
        facts.supplyMode === 'byok'
          ? { supplyMode: 'byok', tokenUsage }
          : {
              supplyMode: 'platform',
              tokenUsage,
              ...(chargeCapsConfigured
                ? {
                    customerChargeUsage: {
                      currency: chargeCurrency as string,
                      daily: {
                        settled: reserved.daily.charge.settled,
                        outstandingReserved: subtract(
                          reserved.daily.charge.outstandingReserved,
                          charge?.amountMinorUnits ?? '0',
                        ),
                        newReservation: charge?.amountMinorUnits ?? '0',
                      },
                      lifetime: {
                        settled: reserved.lifetime.charge.settled,
                        outstandingReserved: subtract(
                          reserved.lifetime.charge.outstandingReserved,
                          charge?.amountMinorUnits ?? '0',
                        ),
                        newReservation: charge?.amountMinorUnits ?? '0',
                      },
                    },
                  }
                : {}),
            },
      );
      if (!verdict.allowed) {
        throw new KeyBudgetAdmissionDeniedError(verdict.deniedDimension);
      }
    },
  };
}

export { KEY_BUDGET_TOKEN_SEMANTICS_VERSION };
