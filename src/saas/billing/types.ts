import type { SqlExecutor } from '../db/types.js';
import type { MinorUnitInput } from './money.js';

export type BillingTransactionExecutor = SqlExecutor;

export type BillingReservationState = 'reserved' | 'settled' | 'released' | 'reconciliation_pending';

export type LedgerTransactionSource = 'wallet_funding' | 'billing_settlement' | 'wallet_refund';

export interface WalletRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly currency: string;
  readonly postedBalanceMinorUnits: bigint;
  readonly activeHoldsMinorUnits: bigint;
  /** PSP refunds in flight reserve wallet value independently from request holds. */
  readonly activeRefundFreezesMinorUnits?: bigint;
  readonly availableMinorUnits: bigint;
  readonly spendingFrozen: boolean;
  readonly spendingFreezeReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BillingReservationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly walletId: string;
  readonly currency: string;
  readonly requestId: string;
  readonly idempotencyNamespace: string;
  readonly businessKey: string;
  readonly amountMinorUnits: bigint;
  readonly state: BillingReservationState;
  readonly status: BillingReservationState;
  readonly priceSnapshotRef: string;
  readonly metadataRef: string;
  readonly expiresAt: string;
  readonly settlementId: string | null;
  readonly settlementAmountMinorUnits: bigint | null;
  readonly usageEvidenceRef: string | null;
  readonly reconciliationReference: string | null;
  readonly reconciliationEvidenceRef: string | null;
  readonly releaseId: string | null;
  readonly releaseEvidenceRef: string | null;
  readonly ledgerTransactionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BillingReservationResult extends BillingReservationRecord {
  readonly outcome: BillingReservationState;
  readonly walletPostedBalanceMinorUnits: bigint;
  readonly activeHoldsMinorUnits: bigint;
  readonly availableMinorUnits: bigint;
  readonly spendingFrozen: boolean;
}

export interface ReserveBillingInput {
  readonly supplyMode: 'platform';
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string | Date;
  readonly businessKey?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyNamespace?: string;
  readonly metadataRef?: string;
}

export interface SettleBillingInput {
  readonly supplyMode: 'platform';
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency?: string;
  readonly priceSnapshotRef: string;
  readonly settlementId: string;
  readonly usageEvidenceRef: string;
  readonly reconciliationEvidenceRef?: string;
  readonly metadataRef?: string;
  readonly businessKey?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyNamespace?: string;
  readonly amountMinorUnits?: MinorUnitInput;
  readonly actualAmountMinorUnits?: MinorUnitInput;
}

export interface ReleaseBillingInput {
  readonly supplyMode: 'platform';
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency?: string;
  readonly releaseId: string;
  /** Caller-supplied evidence for the confirmed non-dispatch/release basis. */
  readonly releaseEvidenceRef: string;
  readonly reconciliationEvidenceRef?: string;
  readonly businessKey?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyNamespace?: string;
}

export interface MarkReconciliationPendingInput {
  readonly supplyMode: 'platform';
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency?: string;
  readonly evidenceRef?: string;
  readonly businessKey?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyNamespace?: string;
}

/** Internal-only input for a verified payment fulfillment worker. */
export interface VerifiedFundingInput {
  readonly tenantId: string;
  readonly currency: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly sourceOrderRef: string;
  readonly idempotencyKey: string;
  readonly idempotencyNamespace?: string;
  readonly metadataRef?: string;
}

export interface FundingPostingResult {
  readonly outcome: 'posted';
  readonly replayed: boolean;
  readonly transactionId: string;
  readonly wallet: WalletRecord;
}

export interface RebuildWalletInput {
  readonly tenantId: string;
  readonly currency: string;
}

export interface PlatformWalletLedgerServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}
