import { randomUUID } from 'node:crypto';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../db/advisory-lock-keys.js';
import type { SqlResult } from '../db/types.js';
import { isSaasBillingError, SaasBillingError } from './errors.js';
import {
  addMinorUnits,
  MAX_MINOR_UNITS,
  normalizeCurrency,
  parseMinorUnits,
  parseStoredMinorUnits,
  subtractMinorUnits,
} from './money.js';
import type {
  BillingReservationRecord,
  BillingReservationResult,
  BillingTransactionExecutor,
  FundingPostingResult,
  LedgerTransactionSource,
  MarkReconciliationPendingInput,
  PlatformWalletLedgerServiceOptions,
  RebuildWalletInput,
  ReleaseBillingInput,
  ReserveBillingInput,
  SettleBillingInput,
  UsageCorrectionPostingInput,
  VerifiedFundingInput,
  WalletRecord,
} from './types.js';

const RESERVATION_NAMESPACE = 'saas.billing.reservation';
const SETTLEMENT_NAMESPACE = 'saas.billing.settlement';
const FUNDING_NAMESPACE = 'saas.wallet.funding';
const USAGE_CORRECTION_NAMESPACE = 'metering.usage-correction';
const MAX_TEXT_LENGTH = 512;

type StoredTimestamp = string | Date;
type StoredMinorUnits = string | number | bigint;

interface WalletRow {
  id: string;
  tenant_id: string;
  currency: string;
  posted_balance_minor_units: StoredMinorUnits;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
}

interface FreezeRow {
  tenant_id: string;
  reason_ref: string;
  frozen_at: StoredTimestamp;
}

interface ReservationRow {
  id: string;
  tenant_id: string;
  wallet_id: string;
  currency: string;
  request_id: string;
  idempotency_namespace: string;
  business_key: string;
  amount_minor_units: StoredMinorUnits;
  state: string;
  price_snapshot_ref: string;
  metadata_ref: string;
  expires_at: StoredTimestamp;
  settlement_id: string | null;
  settlement_amount_minor_units: StoredMinorUnits | null;
  usage_evidence_ref: string | null;
  reconciliation_reference: string | null;
  reconciliation_evidence_ref: string | null;
  release_id: string | null;
  release_evidence_ref: string | null;
  ledger_transaction_id: string | null;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
}

interface LedgerTransactionRow {
  id: string;
  tenant_id: string;
  currency: string;
  idempotency_namespace: string;
  business_key: string;
  source_type: string;
  amount_minor_units: StoredMinorUnits;
  metadata_ref: string;
  source_order_ref: string | null;
  price_snapshot_ref: string | null;
  usage_evidence_ref: string | null;
  created_at: StoredTimestamp;
}

interface ReservationIdentity {
  readonly namespace: string;
  readonly businessKey: string;
}

interface NormalizedReserveInput {
  readonly supplyMode: 'platform';
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string;
  readonly amountMinorUnits: bigint;
  readonly priceSnapshotRef: string;
  readonly metadataRef: string;
  readonly expiresAt: string;
  readonly identity: ReservationIdentity;
}

interface NormalizedSettlementInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string | null;
  readonly amountMinorUnits: bigint;
  readonly priceSnapshotRef: string;
  readonly metadataRef: string | null;
  readonly settlementId: string;
  readonly usageEvidenceRef: string;
  readonly reconciliationEvidenceRef: string | null;
  readonly identity: ReservationIdentity;
}

interface NormalizedReleaseInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string | null;
  readonly releaseId: string;
  readonly releaseEvidenceRef: string;
  readonly reconciliationEvidenceRef: string | null;
  readonly identity: ReservationIdentity;
}

interface NormalizedPendingInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string | null;
  readonly evidenceRef: string;
  readonly identity: ReservationIdentity;
}

interface LockedReservation {
  readonly row: ReservationRow;
  readonly wallet: WalletRow;
}

interface LedgerPosting {
  readonly transaction: LedgerTransactionRow;
  readonly created: boolean;
}

function normalizeText(value: unknown, code: 'INVALID_INPUT' | 'FUNDING_REFERENCE_REQUIRED' = 'INVALID_INPUT'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new SaasBillingError(code);
  }
  if (
    [...value].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new SaasBillingError(code);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new SaasBillingError(code);
  return normalized;
}

function normalizeOptionalText(value: unknown): string | null {
  return value === undefined || value === null ? null : normalizeText(value);
}

function normalizeTenantId(value: unknown): string {
  return normalizeText(value);
}

function normalizeTimestamp(value: unknown): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new SaasBillingError('INVALID_INPUT');
  return date.toISOString();
}

function normalizeStoredTimestamp(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  return timestamp;
}

function normalizeIdentity(
  businessKey: unknown,
  idempotencyKey: unknown,
  namespace: unknown,
  defaultNamespace: string,
): ReservationIdentity {
  const normalizedBusinessKey = businessKey === undefined ? null : normalizeText(businessKey);
  const normalizedIdempotencyKey = idempotencyKey === undefined ? null : normalizeText(idempotencyKey);
  if (
    normalizedBusinessKey !== null &&
    normalizedIdempotencyKey !== null &&
    normalizedBusinessKey !== normalizedIdempotencyKey
  ) {
    throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
  }
  return {
    namespace: namespace === undefined ? defaultNamespace : normalizeText(namespace),
    businessKey:
      normalizedBusinessKey ??
      normalizedIdempotencyKey ??
      (() => {
        throw new SaasBillingError('INVALID_INPUT');
      })(),
  };
}

function normalizeEvidence(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : normalizeText(value);
}

function normalizeStoredOptionalMinorUnits(value: unknown): bigint | null {
  return value === null || value === undefined ? null : parseStoredMinorUnits(value);
}

function assertSupplyMode(value: unknown): asserts value is 'platform' {
  if (value === 'byok') throw new SaasBillingError('BYOK_WALLET_FORBIDDEN');
  if (value !== 'platform') throw new SaasBillingError('INVALID_INPUT');
}

function rowsHaveOne<Row>(result: SqlResult<Row>): boolean {
  return result.rows.length === 1 && (result.rowCount === null || result.rowCount === 1);
}

function mapState(value: unknown): BillingReservationRecord['state'] {
  if (value === 'reserved' || value === 'settled' || value === 'released' || value === 'reconciliation_pending') {
    return value;
  }
  throw new SaasBillingError('BILLING_STORAGE_ERROR');
}

function mapWalletRow(row: WalletRow): WalletRecord {
  const currency = normalizeCurrency(row.currency);
  return {
    id: normalizeText(row.id),
    tenantId: normalizeTenantId(row.tenant_id),
    currency,
    postedBalanceMinorUnits: parseStoredMinorUnits(row.posted_balance_minor_units),
    activeHoldsMinorUnits: 0n,
    availableMinorUnits: 0n,
    spendingFrozen: false,
    spendingFreezeReference: null,
    createdAt: normalizeStoredTimestamp(row.created_at),
    updatedAt: normalizeStoredTimestamp(row.updated_at),
  };
}

function mapReservationRow(row: ReservationRow): BillingReservationRecord {
  const state = mapState(row.state);
  return {
    id: normalizeText(row.id),
    tenantId: normalizeTenantId(row.tenant_id),
    walletId: normalizeText(row.wallet_id),
    currency: normalizeCurrency(row.currency),
    requestId: normalizeText(row.request_id),
    idempotencyNamespace: normalizeText(row.idempotency_namespace),
    businessKey: normalizeText(row.business_key),
    amountMinorUnits: parseStoredMinorUnits(row.amount_minor_units),
    state,
    status: state,
    priceSnapshotRef: normalizeText(row.price_snapshot_ref),
    metadataRef: normalizeText(row.metadata_ref),
    expiresAt: normalizeStoredTimestamp(row.expires_at),
    settlementId: row.settlement_id === null ? null : normalizeText(row.settlement_id),
    settlementAmountMinorUnits: normalizeStoredOptionalMinorUnits(row.settlement_amount_minor_units),
    usageEvidenceRef: row.usage_evidence_ref === null ? null : normalizeText(row.usage_evidence_ref),
    reconciliationReference: row.reconciliation_reference === null ? null : normalizeText(row.reconciliation_reference),
    reconciliationEvidenceRef:
      row.reconciliation_evidence_ref === null ? null : normalizeText(row.reconciliation_evidence_ref),
    releaseId: row.release_id === null ? null : normalizeText(row.release_id),
    releaseEvidenceRef: row.release_evidence_ref === null ? null : normalizeText(row.release_evidence_ref),
    ledgerTransactionId: row.ledger_transaction_id === null ? null : normalizeText(row.ledger_transaction_id),
    createdAt: normalizeStoredTimestamp(row.created_at),
    updatedAt: normalizeStoredTimestamp(row.updated_at),
  };
}

function mapLedgerTransactionRow(row: LedgerTransactionRow): LedgerTransactionRow {
  if (
    row.source_type !== 'wallet_funding' &&
    row.source_type !== 'billing_settlement' &&
    row.source_type !== 'wallet_refund' &&
    row.source_type !== 'usage_correction'
  ) {
    throw new SaasBillingError('BILLING_STORAGE_ERROR');
  }
  parseStoredMinorUnits(row.amount_minor_units);
  normalizeCurrency(row.currency);
  normalizeText(row.id);
  normalizeTenantId(row.tenant_id);
  normalizeText(row.idempotency_namespace);
  normalizeText(row.business_key);
  normalizeText(row.metadata_ref);
  normalizeStoredTimestamp(row.created_at);
  return row;
}

function toLedgerSource(value: LedgerTransactionSource): LedgerTransactionSource {
  if (
    value === 'wallet_funding' ||
    value === 'billing_settlement' ||
    value === 'wallet_refund' ||
    value === 'usage_correction'
  ) {
    return value;
  }
  throw new SaasBillingError('INVALID_INPUT');
}

export class PlatformWalletLedgerService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: PlatformWalletLedgerServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Reserve a platform-supply upper bound. The executor must be the caller's
   * already-open transaction; this service deliberately has no database pool
   * fallback, so admission can be composed with request/outbox writes.
   */
  async reserve(executor: BillingTransactionExecutor, input: ReserveBillingInput): Promise<BillingReservationResult> {
    return (await this.prepareReserve(executor, input))();
  }

  /**
   * Stage only input validation and the non-locking idempotency probe before
   * admission's contended counters. The one-shot closure captures this exact
   * executor; the caller must invoke it while that transaction remains active.
   * This low-level helper cannot prove the lifetime of an arbitrary executor.
   * Native staged callers must check their opaque live transaction scope before
   * invocation; reserve() consumes the plan immediately instead of exporting it.
   * It never caches a replay result, wallet, freeze, hold total or authorization
   * decision. Only copied immutable input and a wallet-identity hint survive.
   */
  async prepareReserve(
    executor: BillingTransactionExecutor,
    input: ReserveBillingInput,
  ): Promise<() => Promise<BillingReservationResult>> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const validated = this.normalizeReserveInput(input);
      const normalized = Object.freeze({ ...validated, identity: Object.freeze({ ...validated.identity }) });
      const existing = await this.findReservation(executor, normalized.identity, false, normalized.tenantId);
      const existingWallet =
        existing === null ? null : Object.freeze({ tenantId: existing.tenant_id, currency: existing.currency });
      let consumed = false;
      return () =>
        this.withSafeStorage(async () => {
          if (consumed) throw new SaasBillingError('BILLING_STORAGE_ERROR');
          consumed = true;
          if (new Date(normalized.expiresAt).getTime() <= this.now().getTime()) {
            throw new SaasBillingError('INVALID_INPUT');
          }
          if (existingWallet) {
            const wallet = await this.lockWallet(executor, existingWallet.tenantId, existingWallet.currency);
            const current = await this.findReservation(executor, normalized.identity, true, normalized.tenantId);
            if (!current) throw new SaasBillingError('BILLING_STORAGE_ERROR');
            this.assertReservationReplay(current, normalized);
            return this.result(executor, current, wallet);
          }

          const snapshot = await this.lockReservationWalletSnapshot(
            executor,
            normalized.tenantId,
            normalized.currency,
            normalized.identity,
          );
          const { wallet, freeze } = snapshot;
          if (freeze) throw new SaasBillingError('SPENDING_FROZEN');

          // The exact idempotency predicate shares the fresh wallet snapshot.
          // Same-wallet writers hold this fence; a cross-currency key collision
          // is still resolved by INSERT's unique conflict and a fresh winner read.
          if (snapshot.reservationExists) {
            const raced = await this.findReservation(executor, normalized.identity, true, normalized.tenantId);
            if (!raced) throw new SaasBillingError('BILLING_STORAGE_ERROR');
            this.assertReservationReplay(raced, normalized);
            return this.result(executor, raced, wallet, freeze);
          }

          const before = this.walletSummaryFromFacts(
            wallet,
            snapshot.activeHoldMinorUnits,
            snapshot.activeRefundFreezeMinorUnits,
            freeze,
          );
          if (before.availableMinorUnits < normalized.amountMinorUnits) {
            throw new SaasBillingError('INSUFFICIENT_FUNDS');
          }

          const createdAt = this.now().toISOString();
          const inserted = await this.insertReservation(executor, {
            id: this.idFactory(),
            tenantId: normalized.tenantId,
            walletId: wallet.id,
            currency: normalized.currency,
            requestId: normalized.requestId,
            identity: normalized.identity,
            amountMinorUnits: normalized.amountMinorUnits,
            priceSnapshotRef: normalized.priceSnapshotRef,
            metadataRef: normalized.metadataRef,
            expiresAt: normalized.expiresAt,
            createdAt,
          });
          if (inserted) {
            // All reservation writers and refund-freeze inserts use this wallet
            // fence. A failed refund may delete its existing freeze without the
            // fence, so only the zero-refund case can reuse the complete snapshot.
            // Nonzero refund freezes retain the original post-insert observation.
            if (before.activeRefundFreezesMinorUnits === 0n) {
              const after = this.walletSummaryFromFacts(
                wallet,
                before.activeHoldsMinorUnits + this.amount(inserted),
                0n,
                freeze,
              );
              return this.resultFromSummary(inserted, after);
            }
            return this.result(executor, inserted, wallet, freeze);
          }

          const winner = await this.findReservation(executor, normalized.identity, true, normalized.tenantId);
          if (!winner) throw new SaasBillingError('BILLING_STORAGE_ERROR');
          this.assertReservationReplay(winner, normalized);
          return this.result(executor, winner, wallet, freeze);
        });
    });
  }

  /**
   * Settle an existing hold using a price snapshot and immutable usage
   * evidence. A charge larger than the hold is recorded as pending and freezes
   * new platform spending; provider reconciliation evidence cannot authorize
   * charging beyond the hold or release its freeze.
   */
  async settle(executor: BillingTransactionExecutor, input: SettleBillingInput): Promise<BillingReservationResult> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const normalized = this.normalizeSettlementInput(input);
      const locked = await this.lockReservationForOperation(executor, normalized.identity, normalized.tenantId);
      const row = locked.row;
      this.assertOptionalCurrency(row, normalized.currency);
      this.assertPriceSnapshot(row, normalized.priceSnapshotRef);
      if (normalized.metadataRef !== null && normalized.metadataRef !== row.metadata_ref) {
        throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
      }

      if (row.state === 'settled') {
        this.assertSettlementReplay(row, normalized);
        return this.result(executor, row, locked.wallet);
      }
      if (row.state === 'released') throw new SaasBillingError('RESERVATION_STATE_CONFLICT');

      let currentRow = row;
      const overSettlement = normalized.amountMinorUnits > this.amount(row);
      if (overSettlement) {
        const pending = await this.assertOrRecordPendingSettlement(executor, row, normalized, true);
        await this.freezeTenant(executor, row.tenant_id, `reservation:${row.id}:over-settlement`);
        return this.result(executor, pending, locked.wallet);
      } else if (row.state === 'reconciliation_pending') {
        const pending = await this.assertOrRecordPendingSettlement(executor, row, normalized, true);
        if (!normalized.reconciliationEvidenceRef) return this.result(executor, pending, locked.wallet);
        currentRow = pending;
      }

      if (currentRow.state === 'reconciliation_pending' && !normalized.reconciliationEvidenceRef) {
        return this.result(executor, currentRow, locked.wallet);
      }
      if (currentRow.state === 'reconciliation_pending') {
        const refreshed = await this.findReservation(executor, normalized.identity, true, normalized.tenantId);
        if (!refreshed) throw new SaasBillingError('BILLING_STORAGE_ERROR');
        currentRow = refreshed;
      }
      if (!currentRow) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const summary = await this.walletSummary(executor, locked.wallet);
      const otherHolds = subtractMinorUnits(summary.activeHoldsMinorUnits, this.amount(currentRow));
      const otherRefundFreezes = summary.activeRefundFreezesMinorUnits ?? 0n;
      const fundsNeeded = addMinorUnits(addMinorUnits(normalized.amountMinorUnits, otherHolds), otherRefundFreezes);
      if (summary.postedBalanceMinorUnits < fundsNeeded) {
        throw new SaasBillingError('INSUFFICIENT_FUNDS');
      }

      let ledgerTransactionId: string | null = null;
      let resultWallet = locked.wallet;
      if (normalized.amountMinorUnits > 0n) {
        const posting = await this.postLedgerTransaction(executor, {
          id: this.idFactory(),
          tenantId: currentRow.tenant_id,
          currency: currentRow.currency,
          identity: {
            namespace: SETTLEMENT_NAMESPACE,
            businessKey: normalized.settlementId,
          },
          sourceType: toLedgerSource('billing_settlement'),
          amountMinorUnits: normalized.amountMinorUnits,
          metadataRef: normalized.metadataRef ?? currentRow.metadata_ref,
          sourceOrderRef: null,
          priceSnapshotRef: normalized.priceSnapshotRef,
          usageEvidenceRef: normalized.usageEvidenceRef,
          walletId: locked.wallet.id,
          walletDirection: 'debit',
          counterpartyAccountType: 'billing_revenue',
          counterpartyAccountRef: `platform-revenue:${currentRow.currency}`,
        });
        if (!posting.created && currentRow.ledger_transaction_id !== posting.transaction.id) {
          throw new SaasBillingError('BILLING_STORAGE_ERROR');
        }
        ledgerTransactionId = posting.transaction.id;
        if (posting.created) {
          resultWallet = await this.adjustWalletProjection(
            executor,
            locked.wallet,
            posting.transaction.id,
            -normalized.amountMinorUnits,
          );
        }
      }

      const settled = await executor.query<ReservationRow>(
        `UPDATE saas_billing_reservations
         SET state = 'settled',
             settlement_id = $2,
             settlement_amount_minor_units = $3,
             usage_evidence_ref = $4,
             reconciliation_evidence_ref = COALESCE($5, reconciliation_evidence_ref),
             ledger_transaction_id = $6,
             updated_at = $7
         WHERE id = $1 AND tenant_id = $8 AND state IN ('reserved', 'reconciliation_pending')
         RETURNING id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
                   amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, settlement_id,
                   settlement_amount_minor_units, usage_evidence_ref, reconciliation_reference,
                   reconciliation_evidence_ref, release_id, release_evidence_ref, ledger_transaction_id,
                   created_at, updated_at`,
        [
          currentRow.id,
          normalized.settlementId,
          normalized.amountMinorUnits.toString(),
          normalized.usageEvidenceRef,
          normalized.reconciliationEvidenceRef,
          ledgerTransactionId,
          this.now().toISOString(),
          currentRow.tenant_id,
        ],
      );
      if (!rowsHaveOne(settled)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const finalRow = settled.rows[0];
      if (!finalRow) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      await this.clearFreezeIfResolved(executor, currentRow.tenant_id);
      return this.result(executor, finalRow, resultWallet);
    });
  }

  /** Release a hold only with an explicit release/evidence reference. */
  async release(executor: BillingTransactionExecutor, input: ReleaseBillingInput): Promise<BillingReservationResult> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const normalized = this.normalizeReleaseInput(input);
      const locked = await this.lockReservationForOperation(executor, normalized.identity, normalized.tenantId);
      const row = locked.row;
      this.assertOptionalCurrency(row, normalized.currency);

      if (row.state === 'released') {
        if (row.release_id !== normalized.releaseId || row.release_evidence_ref !== normalized.releaseEvidenceRef) {
          throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
        }
        return this.result(executor, row, locked.wallet);
      }
      if (row.state === 'settled') throw new SaasBillingError('RESERVATION_STATE_CONFLICT');
      const pendingSettlementAmount =
        row.state === 'reconciliation_pending' ? this.optionalAmount(row.settlement_amount_minor_units) : null;
      if (pendingSettlementAmount !== null && pendingSettlementAmount > this.amount(row)) {
        throw new SaasBillingError('RECONCILIATION_REQUIRED');
      }
      if (row.state === 'reconciliation_pending' && !normalized.reconciliationEvidenceRef) {
        throw new SaasBillingError('RECONCILIATION_REQUIRED');
      }
      if (
        row.reconciliation_evidence_ref !== null &&
        row.reconciliation_evidence_ref !== normalized.reconciliationEvidenceRef
      ) {
        throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
      }

      const released = await executor.query<ReservationRow>(
        `UPDATE saas_billing_reservations
         SET state = 'released',
             release_id = $2,
             release_evidence_ref = $3,
             reconciliation_evidence_ref = COALESCE($4, reconciliation_evidence_ref),
             updated_at = $5
         WHERE id = $1 AND tenant_id = $6 AND state IN ('reserved', 'reconciliation_pending')
         RETURNING id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
                   amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, settlement_id,
                   settlement_amount_minor_units, usage_evidence_ref, reconciliation_reference,
                   reconciliation_evidence_ref, release_id, release_evidence_ref, ledger_transaction_id,
                   created_at, updated_at`,
        [
          row.id,
          normalized.releaseId,
          normalized.releaseEvidenceRef,
          normalized.reconciliationEvidenceRef,
          this.now().toISOString(),
          row.tenant_id,
        ],
      );
      if (!rowsHaveOne(released)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const finalRow = released.rows[0];
      if (!finalRow) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      await this.clearFreezeIfResolved(executor, row.tenant_id);
      return this.result(executor, finalRow, locked.wallet);
    });
  }

  /** Mark an upstream result unknown without releasing its funds. */
  async markReconciliationPending(
    executor: BillingTransactionExecutor,
    input: MarkReconciliationPendingInput,
  ): Promise<BillingReservationResult> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const normalized = this.normalizePendingInput(input);
      const locked = await this.lockReservationForOperation(executor, normalized.identity, normalized.tenantId);
      const row = locked.row;
      this.assertOptionalCurrency(row, normalized.currency);
      if (row.state === 'settled' || row.state === 'released') return this.result(executor, row, locked.wallet);
      if (row.reconciliation_reference !== null && row.reconciliation_reference !== normalized.evidenceRef) {
        throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
      }
      if (row.state === 'reconciliation_pending') return this.result(executor, row, locked.wallet);

      const pending = await executor.query<ReservationRow>(
        `UPDATE saas_billing_reservations
         SET state = 'reconciliation_pending',
             reconciliation_reference = $2,
             updated_at = $3
         WHERE id = $1 AND tenant_id = $4 AND state = 'reserved'
         RETURNING id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
                   amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, settlement_id,
                   settlement_amount_minor_units, usage_evidence_ref, reconciliation_reference,
                   reconciliation_evidence_ref, release_id, release_evidence_ref, ledger_transaction_id,
                   created_at, updated_at`,
        [row.id, normalized.evidenceRef, this.now().toISOString(), row.tenant_id],
      );
      if (!rowsHaveOne(pending)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const pendingRow = pending.rows[0];
      if (!pendingRow) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      return this.result(executor, pendingRow, locked.wallet);
    });
  }

  /**
   * Internal funding primitive for a later verified payment-fulfillment
   * worker. It is intentionally not a webhook or an unauthenticated route.
   */
  async postVerifiedFunding(
    executor: BillingTransactionExecutor,
    input: VerifiedFundingInput,
  ): Promise<FundingPostingResult> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const tenantId = normalizeTenantId(input.tenantId);
      const currency = normalizeCurrency(input.currency);
      const amountMinorUnits = parseMinorUnits(input.amountMinorUnits);
      const sourceOrderRef = normalizeText(input.sourceOrderRef, 'FUNDING_REFERENCE_REQUIRED');
      const metadataRef = normalizeText(input.metadataRef ?? sourceOrderRef);
      const identity: ReservationIdentity = {
        namespace:
          input.idempotencyNamespace === undefined ? FUNDING_NAMESPACE : normalizeText(input.idempotencyNamespace),
        businessKey: normalizeText(input.idempotencyKey),
      };

      await executor.query(
        `INSERT INTO saas_wallets (id, tenant_id, currency, posted_balance_minor_units, created_at, updated_at)
         VALUES ($1, $2, $3, 0, $4, $4)
         ON CONFLICT (tenant_id, currency) DO NOTHING`,
        [this.idFactory(), tenantId, currency, this.now().toISOString()],
      );
      const wallet = await this.lockWallet(executor, tenantId, currency);
      const posting = await this.postLedgerTransaction(executor, {
        id: this.idFactory(),
        tenantId,
        currency,
        identity,
        sourceType: toLedgerSource('wallet_funding'),
        amountMinorUnits,
        metadataRef,
        sourceOrderRef,
        priceSnapshotRef: null,
        usageEvidenceRef: null,
        walletId: wallet.id,
        walletDirection: 'credit',
        counterpartyAccountType: 'funding_source',
        counterpartyAccountRef: sourceOrderRef,
      });
      const projectedWallet = posting.created
        ? await this.adjustWalletProjection(executor, wallet, posting.transaction.id, amountMinorUnits)
        : wallet;
      const currentWallet = await this.walletSummary(executor, projectedWallet);
      return {
        outcome: 'posted',
        replayed: !posting.created,
        transactionId: posting.transaction.id,
        wallet: currentWallet,
      };
    });
  }

  /**
   * Post the wallet half of a PSP-confirmed top-up refund. The refund service
   * must call this with its shared transaction executor after confirming the
   * provider result while holding the refund-order row lock. The matching
   * immutable wallet freeze is read only after the wallet fence is acquired.
   */
  async postVerifiedWalletRefund(
    executor: BillingTransactionExecutor,
    input: {
      readonly tenantId: string;
      readonly currency: string;
      readonly amountMinorUnits: bigint | string;
      readonly refundOrderId: string;
    },
  ): Promise<{ readonly transactionId: string; readonly replayed: boolean; readonly wallet: WalletRecord }> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const tenantId = normalizeTenantId(input.tenantId);
      const currency = normalizeCurrency(input.currency);
      const amountMinorUnits = parseMinorUnits(input.amountMinorUnits);
      const refundOrderId = normalizeText(input.refundOrderId);
      const sourceOrderRef = `wallet-refund:${refundOrderId}`;
      const wallet = await this.lockWallet(executor, tenantId, currency);
      const freeze = await executor.query<{
        refund_order_id: string;
        tenant_id: string;
        wallet_id: string;
        currency: string;
        amount_minor_units: StoredMinorUnits;
      }>(
        `SELECT refund_order_id, tenant_id, wallet_id, currency, amount_minor_units
         FROM saas_refund_wallet_freezes
         WHERE refund_order_id = $1`,
        [refundOrderId],
      );
      const freezeRow = freeze.rows[0];
      if (
        !freezeRow ||
        freezeRow.tenant_id !== tenantId ||
        freezeRow.currency !== currency ||
        parseStoredMinorUnits(freezeRow.amount_minor_units) !== amountMinorUnits
      ) {
        throw new SaasBillingError('BILLING_STORAGE_ERROR');
      }

      if (wallet.id !== freezeRow.wallet_id) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const summary = await this.walletSummary(executor, wallet);
      if (summary.availableMinorUnits < 0n) throw new SaasBillingError('BILLING_STORAGE_ERROR');

      const posting = await this.postLedgerTransaction(executor, {
        id: this.idFactory(),
        tenantId,
        currency,
        identity: { namespace: 'saas.payment.wallet_refund', businessKey: refundOrderId },
        sourceType: toLedgerSource('wallet_refund'),
        amountMinorUnits,
        metadataRef: sourceOrderRef,
        sourceOrderRef,
        priceSnapshotRef: null,
        usageEvidenceRef: null,
        walletId: wallet.id,
        walletDirection: 'debit',
        counterpartyAccountType: 'funding_source',
        counterpartyAccountRef: sourceOrderRef,
      });
      const projected = posting.created
        ? await this.adjustWalletProjection(executor, wallet, posting.transaction.id, -amountMinorUnits)
        : wallet;
      // The caller releases this freeze after the ledger post, in the same
      // transaction. Exclude it from this intermediate projection so active
      // billing holds are not double-counted against the just-debited amount.
      const currentWallet = await this.walletSummary(executor, projected, refundOrderId);
      return {
        transactionId: posting.transaction.id,
        replayed: !posting.created,
        wallet: currentWallet,
      };
    });
  }

  /**
   * Post the signed wallet effect of an append-only usage correction. The
   * metering correction service calls this in the same transaction that
   * inserts the correction event, so the event and its ledger posting commit
   * or roll back together. The correction digest is the idempotency key; a
   * replay returns the original posting unchanged. A negative delta that
   * would take the wallet below zero fails closed (INSUFFICIENT_FUNDS) —
   * balances never go negative.
   */
  async postUsageCorrection(
    executor: BillingTransactionExecutor,
    input: UsageCorrectionPostingInput,
  ): Promise<{ readonly transactionId: string; readonly replayed: boolean; readonly wallet: WalletRecord }> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const tenantId = normalizeTenantId(input.tenantId);
      const currency = normalizeCurrency(input.currency);
      const delta = input.amountDeltaMinorUnits;
      if (typeof delta !== 'bigint' || delta === 0n) throw new SaasBillingError('INVALID_INPUT');
      const correctionEventId = normalizeText(input.correctionEventId);
      const correctionDigest = normalizeText(input.correctionDigest);
      const wallet = await this.lockWallet(executor, tenantId, currency);
      const posting = await this.postLedgerTransaction(executor, {
        id: this.idFactory(),
        tenantId,
        currency,
        identity: { namespace: USAGE_CORRECTION_NAMESPACE, businessKey: correctionDigest },
        sourceType: toLedgerSource('usage_correction'),
        amountMinorUnits: delta > 0n ? delta : -delta,
        metadataRef: correctionDigest,
        sourceOrderRef: `usage-correction:${correctionEventId}`,
        priceSnapshotRef: null,
        usageEvidenceRef: null,
        walletId: wallet.id,
        walletDirection: delta > 0n ? 'credit' : 'debit',
        counterpartyAccountType: 'billing_revenue',
        counterpartyAccountRef: correctionEventId,
      });
      const projected = posting.created
        ? await this.adjustWalletProjection(executor, wallet, posting.transaction.id, delta)
        : wallet;
      const currentWallet = await this.walletSummary(executor, projected);
      return {
        transactionId: posting.transaction.id,
        replayed: !posting.created,
        wallet: currentWallet,
      };
    });
  }

  async getWallet(
    executor: BillingTransactionExecutor,
    tenantIdInput: string,
    currencyInput: string,
  ): Promise<WalletRecord> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const tenantId = normalizeTenantId(tenantIdInput);
      const currency = normalizeCurrency(currencyInput);
      const wallet = await this.lockWallet(executor, tenantId, currency, false);
      return this.walletSummary(executor, wallet);
    });
  }

  async rebuildWalletProjection(
    executor: BillingTransactionExecutor,
    input: RebuildWalletInput,
  ): Promise<WalletRecord> {
    this.requireExecutor(executor);
    return this.withSafeStorage(async () => {
      const tenantId = normalizeTenantId(input.tenantId);
      const currency = normalizeCurrency(input.currency);
      const wallet = await this.lockWallet(executor, tenantId, currency);
      const result = await executor.query<{ posted_balance_minor_units: StoredMinorUnits }>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
           AS posted_balance_minor_units
         FROM saas_ledger_entries
         WHERE wallet_id = $1 AND tenant_id = $2 AND currency = $3`,
        [wallet.id, tenantId, currency],
      );
      const projected = parseStoredMinorUnits(result.rows[0]?.posted_balance_minor_units);
      if (projected > MAX_MINOR_UNITS) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      await executor.query(`SELECT set_config('saas.billing_ledger_projection_write', 'rebuild', true)`);
      const updated = await executor.query<WalletRow>(
        `UPDATE saas_wallets
         SET posted_balance_minor_units = $2, updated_at = $3
         WHERE id = $1 AND tenant_id = $4 AND currency = $5
         RETURNING id, tenant_id, currency, posted_balance_minor_units, created_at, updated_at`,
        [wallet.id, projected.toString(), this.now().toISOString(), tenantId, currency],
      );
      if (!rowsHaveOne(updated)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const updatedWallet = updated.rows[0];
      if (!updatedWallet) throw new SaasBillingError('BILLING_STORAGE_ERROR');
      return this.walletSummary(executor, updatedWallet);
    });
  }

  private requireExecutor(
    executor: BillingTransactionExecutor | undefined,
  ): asserts executor is BillingTransactionExecutor {
    if (!executor || typeof executor.query !== 'function') {
      throw new SaasBillingError('EXECUTOR_REQUIRED');
    }
  }

  private async withSafeStorage<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isSaasBillingError(error)) throw error;
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
  }

  private normalizeReserveInput(input: ReserveBillingInput): NormalizedReserveInput {
    assertSupplyMode(input?.supplyMode);
    const tenantId = normalizeTenantId(input.tenantId);
    const requestId = normalizeText(input.requestId);
    const currency = normalizeCurrency(input.currency);
    const amountMinorUnits = parseMinorUnits(input.amountMinorUnits);
    const priceSnapshotRef = normalizeText(input.priceSnapshotRef);
    const metadataRef = normalizeText(input.metadataRef ?? priceSnapshotRef);
    const expiresAt = normalizeTimestamp(input.expiresAt);
    if (new Date(expiresAt).getTime() <= this.now().getTime()) throw new SaasBillingError('INVALID_INPUT');
    return {
      supplyMode: 'platform',
      tenantId,
      requestId,
      currency,
      amountMinorUnits,
      priceSnapshotRef,
      metadataRef,
      expiresAt,
      identity: normalizeIdentity(
        input.businessKey,
        input.idempotencyKey,
        input.idempotencyNamespace,
        RESERVATION_NAMESPACE,
      ),
    };
  }

  private normalizeSettlementInput(input: SettleBillingInput): NormalizedSettlementInput {
    assertSupplyMode(input?.supplyMode);
    const amountInput = input.actualAmountMinorUnits ?? input.amountMinorUnits;
    if (amountInput === undefined) throw new SaasBillingError('INVALID_AMOUNT');
    if (input.actualAmountMinorUnits !== undefined && input.amountMinorUnits !== undefined) {
      const first = parseMinorUnits(input.actualAmountMinorUnits, { allowZero: true });
      const second = parseMinorUnits(input.amountMinorUnits, { allowZero: true });
      if (first !== second) throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
    return {
      tenantId: normalizeTenantId(input.tenantId),
      requestId: normalizeText(input.requestId),
      currency: input.currency === undefined ? null : normalizeCurrency(input.currency),
      amountMinorUnits: parseMinorUnits(amountInput, { allowZero: true }),
      priceSnapshotRef: normalizeText(input.priceSnapshotRef),
      metadataRef: normalizeOptionalText(input.metadataRef),
      settlementId: normalizeText(input.settlementId),
      usageEvidenceRef: normalizeText(input.usageEvidenceRef),
      reconciliationEvidenceRef: normalizeOptionalText(input.reconciliationEvidenceRef),
      identity: normalizeIdentity(
        input.businessKey,
        input.idempotencyKey,
        input.idempotencyNamespace,
        RESERVATION_NAMESPACE,
      ),
    };
  }

  private normalizeReleaseInput(input: ReleaseBillingInput): NormalizedReleaseInput {
    assertSupplyMode(input?.supplyMode);
    const releaseId = normalizeText(input.releaseId);
    return {
      tenantId: normalizeTenantId(input.tenantId),
      requestId: normalizeText(input.requestId),
      currency: input.currency === undefined ? null : normalizeCurrency(input.currency),
      releaseId,
      releaseEvidenceRef: normalizeText(input.releaseEvidenceRef),
      reconciliationEvidenceRef: normalizeOptionalText(input.reconciliationEvidenceRef),
      identity: normalizeIdentity(
        input.businessKey,
        input.idempotencyKey,
        input.idempotencyNamespace,
        RESERVATION_NAMESPACE,
      ),
    };
  }

  private normalizePendingInput(input: MarkReconciliationPendingInput): NormalizedPendingInput {
    assertSupplyMode(input?.supplyMode);
    const tenantId = normalizeTenantId(input.tenantId);
    const requestId = normalizeText(input.requestId);
    const identity = normalizeIdentity(
      input.businessKey,
      input.idempotencyKey,
      input.idempotencyNamespace,
      RESERVATION_NAMESPACE,
    );
    return {
      tenantId,
      requestId,
      currency: input.currency === undefined ? null : normalizeCurrency(input.currency),
      evidenceRef: normalizeEvidence(input.evidenceRef, `upstream-result-unknown:${requestId}:${identity.businessKey}`),
      identity,
    };
  }

  private async findReservation(
    executor: BillingTransactionExecutor,
    identity: ReservationIdentity,
    forUpdate: boolean,
    tenantId: string,
  ): Promise<ReservationRow | null> {
    const result = await executor.query<ReservationRow>(
      `SELECT id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
              amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, settlement_id,
              settlement_amount_minor_units, usage_evidence_ref, reconciliation_reference,
              reconciliation_evidence_ref, release_id, release_evidence_ref, ledger_transaction_id,
              created_at, updated_at
       FROM saas_billing_reservations
       WHERE tenant_id = $1 AND idempotency_namespace = $2 AND business_key = $3
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, identity.namespace, identity.businessKey],
    );
    return result.rows[0] ?? null;
  }

  private async lockReservationForOperation(
    executor: BillingTransactionExecutor,
    identity: ReservationIdentity,
    tenantId: string,
  ): Promise<LockedReservation> {
    const found = await this.findReservation(executor, identity, false, tenantId);
    if (!found) throw new SaasBillingError('RESERVATION_NOT_FOUND');
    await executor.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(found.tenant_id, found.currency)]);
    // This is a separate command after the advisory wait. Both records share
    // its fresh snapshot, and only the reservation receives a tuple lock.
    const selected = await executor.query<
      ReservationRow & {
        wallet_posted_balance_minor_units: StoredMinorUnits;
        wallet_created_at: StoredTimestamp;
        wallet_updated_at: StoredTimestamp;
      }
    >(
      `/* billing:locked-reservation-wallet */
       SELECT reservation.id, reservation.tenant_id, reservation.wallet_id, reservation.currency,
              reservation.request_id, reservation.idempotency_namespace, reservation.business_key,
              reservation.amount_minor_units, reservation.state, reservation.price_snapshot_ref,
              reservation.metadata_ref, reservation.expires_at, reservation.settlement_id,
              reservation.settlement_amount_minor_units, reservation.usage_evidence_ref,
              reservation.reconciliation_reference, reservation.reconciliation_evidence_ref,
              reservation.release_id, reservation.release_evidence_ref, reservation.ledger_transaction_id,
              reservation.created_at, reservation.updated_at,
              wallet.posted_balance_minor_units AS wallet_posted_balance_minor_units,
              wallet.created_at AS wallet_created_at, wallet.updated_at AS wallet_updated_at
         FROM saas_billing_reservations reservation
         JOIN saas_wallets wallet ON wallet.id = reservation.wallet_id
           AND wallet.tenant_id = reservation.tenant_id AND wallet.currency = reservation.currency
        WHERE reservation.tenant_id = $1 AND reservation.idempotency_namespace = $2
          AND reservation.business_key = $3 AND wallet.currency = $4
        FOR UPDATE OF reservation`,
      [tenantId, identity.namespace, identity.businessKey, found.currency],
    );
    if (!rowsHaveOne(selected)) {
      // Preserve the prior missing-wallet distinction on the rare corrupt or
      // custom-executor path; the normal FK-protected path is one joined read.
      if (selected.rows.length === 0) await this.lockWallet(executor, found.tenant_id, found.currency, false);
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    const row = selected.rows[0];
    if (!row || row.tenant_id !== tenantId || row.currency !== found.currency || row.wallet_id !== found.wallet_id) {
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    const wallet: WalletRow = {
      id: row.wallet_id,
      tenant_id: row.tenant_id,
      currency: row.currency,
      posted_balance_minor_units: row.wallet_posted_balance_minor_units,
      created_at: row.wallet_created_at,
      updated_at: row.wallet_updated_at,
    };
    mapWalletRow(wallet);
    return { row, wallet };
  }

  /**
   * The per-wallet billing fence (R9 P4/P16, roadmap batch 1.2 step 3).
   *
   * Every writer of wallet-derived billing state takes ONE EXCLUSIVE
   * transaction-scoped advisory lock keyed by the wallet's business identity
   * (tenant + currency) — see saasAdvisoryKey.walletFence — instead of a
   * `saas_wallets` row FOR UPDATE. Audit of the fence domain (all writers):
   * this service's reserve/settle/release/markReconciliationPending/
   * postVerifiedFunding/postVerifiedWalletRefund/postUsageCorrection/
   * rebuildWalletProjection paths, and the payment refund service's
   * refund-request path (which inserts `saas_refund_wallet_freezes` under the
   * same derived key through the shared helper). The spending-freeze gate is
   * preserved verbatim: freezeTenant/clearFreezeIfResolved run inside this
   * critical section, and reserve's freeze read happens after the fence, so a
   * freeze insert can never interleave with an admission freeze check for the
   * same wallet. The refund fulfillment path deletes its freeze row inside the
   * same transaction as postVerifiedWalletRefund, which re-enters this fence
   * (pg_advisory_xact_lock is re-entrant per session).
   *
   * The fence is taken BEFORE the wallet row read so the read sees a fresh
   * READ COMMITTED snapshot after the fence wait (same discipline as the
   * admission authorization prelock). Tuple locks are gone: an admission no
   * longer holds a wallet row lock across the capacity fence, and lock waits
   * no longer queue on the row's tuple lock. `forUpdate=false` callers
   * (read-only wallet queries) take no fence, exactly as before.
   *
   * Spending-freeze rows are tenant-wide while this fence is per currency.
   * Cross-currency freeze coordination is an existing gap, not fixed by this
   * batching or by combining the post-fence reads into one snapshot.
   */
  private async lockWallet(
    executor: BillingTransactionExecutor,
    tenantId: string,
    currency: string,
    forUpdate = true,
  ): Promise<WalletRow> {
    if (forUpdate) {
      await executor.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(tenantId, currency)]);
    }
    const result = await executor.query<WalletRow>(
      `SELECT id, tenant_id, currency, posted_balance_minor_units, created_at, updated_at
       FROM saas_wallets
       WHERE tenant_id = $1 AND currency = $2`,
      [tenantId, currency],
    );
    const row = result.rows[0];
    if (!row) throw new SaasBillingError('WALLET_NOT_FOUND');
    if (row.tenant_id !== tenantId || row.currency !== currency) throw new SaasBillingError('BILLING_STORAGE_ERROR');
    mapWalletRow(row);
    return row;
  }

  /** One fresh snapshot after (never in the statement acquiring) the fence. */
  private async lockReservationWalletSnapshot(
    executor: BillingTransactionExecutor,
    tenantId: string,
    currency: string,
    identity: ReservationIdentity,
  ): Promise<{
    wallet: WalletRow;
    freeze: FreezeRow | null;
    activeHoldMinorUnits: StoredMinorUnits;
    activeRefundFreezeMinorUnits: StoredMinorUnits;
    reservationExists: boolean;
  }> {
    await executor.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(tenantId, currency)]);
    const selected = await executor.query<
      WalletRow & {
        freeze_tenant_id: string | null;
        freeze_reason_ref: string | null;
        freeze_frozen_at: StoredTimestamp | null;
        active_hold_minor_units: StoredMinorUnits;
        active_refund_freeze_minor_units: StoredMinorUnits;
        reservation_exists: boolean;
      }
    >(
      `/* billing:reserve-wallet-snapshot */
       SELECT wallet.id, wallet.tenant_id, wallet.currency, wallet.posted_balance_minor_units,
              wallet.created_at, wallet.updated_at,
              frozen.tenant_id AS freeze_tenant_id, frozen.reason_ref AS freeze_reason_ref,
              frozen.frozen_at AS freeze_frozen_at,
              (SELECT COALESCE(SUM(amount_minor_units), 0)::text
                 FROM saas_billing_reservations
                WHERE tenant_id = $1 AND currency = $2 AND state IN ('reserved', 'reconciliation_pending'))
                AS active_hold_minor_units,
              (SELECT COALESCE(SUM(amount_minor_units), 0)::text
                 FROM saas_refund_wallet_freezes WHERE tenant_id = $1 AND currency = $2)
                AS active_refund_freeze_minor_units,
              EXISTS (SELECT 1 FROM saas_billing_reservations
                       WHERE tenant_id = $1 AND idempotency_namespace = $3 AND business_key = $4)
                AS reservation_exists
         FROM saas_wallets wallet
         LEFT JOIN LATERAL (
           SELECT tenant_id, reason_ref, frozen_at FROM saas_billing_spending_freezes WHERE tenant_id = $1
         ) frozen ON true
        WHERE wallet.tenant_id = $1 AND wallet.currency = $2`,
      [tenantId, currency, identity.namespace, identity.businessKey],
    );
    const wallet = selected.rows[0];
    if (!wallet) throw new SaasBillingError('WALLET_NOT_FOUND');
    if (wallet.tenant_id !== tenantId || wallet.currency !== currency)
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    mapWalletRow(wallet);
    if (typeof wallet.reservation_exists !== 'boolean') throw new SaasBillingError('BILLING_STORAGE_ERROR');
    let freeze: FreezeRow | null = null;
    if (wallet.freeze_tenant_id !== null) {
      if (
        wallet.freeze_tenant_id !== tenantId ||
        wallet.freeze_reason_ref === null ||
        wallet.freeze_frozen_at === null
      ) {
        throw new SaasBillingError('BILLING_STORAGE_ERROR');
      }
      freeze = { tenant_id: tenantId, reason_ref: wallet.freeze_reason_ref, frozen_at: wallet.freeze_frozen_at };
    }
    return {
      wallet,
      freeze,
      activeHoldMinorUnits: wallet.active_hold_minor_units,
      activeRefundFreezeMinorUnits: wallet.active_refund_freeze_minor_units,
      reservationExists: wallet.reservation_exists,
    };
  }

  private walletSummaryFromFacts(
    wallet: WalletRow,
    activeHolds: StoredMinorUnits,
    activeRefundFreezes: StoredMinorUnits,
    freeze: FreezeRow | null,
  ): WalletRecord {
    const base = mapWalletRow(wallet);
    const activeHoldsMinorUnits = parseStoredMinorUnits(activeHolds);
    const activeRefundFreezesMinorUnits = parseStoredMinorUnits(activeRefundFreezes);
    if (activeHoldsMinorUnits + activeRefundFreezesMinorUnits > base.postedBalanceMinorUnits) {
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    return {
      ...base,
      activeHoldsMinorUnits,
      activeRefundFreezesMinorUnits,
      availableMinorUnits: base.postedBalanceMinorUnits - activeHoldsMinorUnits - activeRefundFreezesMinorUnits,
      spendingFrozen: freeze !== null,
      spendingFreezeReference: freeze?.reason_ref ?? null,
    };
  }

  private async walletSummary(
    executor: BillingTransactionExecutor,
    wallet: WalletRow,
    excludeRefundOrderId?: string,
    freezeRow?: FreezeRow | null,
  ): Promise<WalletRecord> {
    const base = mapWalletRow(wallet);
    const totals = await executor.query<{
      active_hold_minor_units: StoredMinorUnits;
      active_refund_freeze_minor_units: StoredMinorUnits;
      freeze_tenant_id: string | null;
      freeze_reason_ref: string | null;
      freeze_frozen_at: StoredTimestamp | null;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(amount_minor_units), 0)::text
          FROM saas_billing_reservations
          WHERE tenant_id = $1 AND currency = $2 AND state IN ('reserved', 'reconciliation_pending'))
           AS active_hold_minor_units,
         (SELECT COALESCE(SUM(amount_minor_units), 0)::text
          FROM saas_refund_wallet_freezes
          WHERE tenant_id = $1 AND currency = $2
          ${excludeRefundOrderId === undefined ? '' : 'AND refund_order_id <> $3'})
           AS active_refund_freeze_minor_units${
             freezeRow === undefined
               ? `,
         frozen.tenant_id AS freeze_tenant_id, frozen.reason_ref AS freeze_reason_ref,
         frozen.frozen_at AS freeze_frozen_at
       FROM (SELECT 1) anchor
       LEFT JOIN saas_billing_spending_freezes frozen ON frozen.tenant_id = $1`
               : ''
           }`,
      excludeRefundOrderId === undefined
        ? [wallet.tenant_id, wallet.currency]
        : [wallet.tenant_id, wallet.currency, excludeRefundOrderId],
    );
    if (!rowsHaveOne(totals)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
    const activeHoldsMinorUnits = parseStoredMinorUnits(totals.rows[0]?.active_hold_minor_units);
    const activeRefundFreezesMinorUnits = parseStoredMinorUnits(totals.rows[0]?.active_refund_freeze_minor_units);
    if (activeHoldsMinorUnits + activeRefundFreezesMinorUnits > base.postedBalanceMinorUnits) {
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    // Spending-freeze mutations are serialized by the wallet advisory fence
    // (lockWallet) in reserve and settlement paths. The row is immutable, so
    // observation needs no row lock (and must not require UPDATE privilege).
    // A caller that already read the freeze inside this fenced transaction
    // passes it here to avoid a redundant read in the critical section.
    const facts = totals.rows[0];
    const freeze =
      freezeRow === undefined
        ? facts?.freeze_tenant_id == null
          ? null
          : {
              tenant_id: facts.freeze_tenant_id,
              reason_ref: facts.freeze_reason_ref,
              frozen_at: facts.freeze_frozen_at,
            }
        : freezeRow;
    if (freeze && (freeze.tenant_id !== wallet.tenant_id || freeze.reason_ref === null || freeze.frozen_at === null)) {
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    return {
      ...base,
      activeHoldsMinorUnits,
      activeRefundFreezesMinorUnits,
      availableMinorUnits: base.postedBalanceMinorUnits - activeHoldsMinorUnits - activeRefundFreezesMinorUnits,
      spendingFrozen: freeze !== null,
      spendingFreezeReference: freeze?.reason_ref ?? null,
    };
  }

  private async result(
    executor: BillingTransactionExecutor,
    row: ReservationRow,
    wallet: WalletRow,
    freezeRow?: FreezeRow | null,
  ): Promise<BillingReservationResult> {
    return this.resultFromSummary(row, await this.walletSummary(executor, wallet, undefined, freezeRow));
  }

  private resultFromSummary(row: ReservationRow, walletSummary: WalletRecord): BillingReservationResult {
    const record = mapReservationRow(row);
    return {
      ...record,
      outcome: record.state,
      walletPostedBalanceMinorUnits: walletSummary.postedBalanceMinorUnits,
      activeHoldsMinorUnits: walletSummary.activeHoldsMinorUnits,
      availableMinorUnits: walletSummary.availableMinorUnits,
      spendingFrozen: walletSummary.spendingFrozen,
    };
  }

  private amount(row: ReservationRow): bigint {
    return parseStoredMinorUnits(row.amount_minor_units);
  }

  private async insertReservation(
    executor: BillingTransactionExecutor,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly walletId: string;
      readonly currency: string;
      readonly requestId: string;
      readonly identity: ReservationIdentity;
      readonly amountMinorUnits: bigint;
      readonly priceSnapshotRef: string;
      readonly metadataRef: string;
      readonly expiresAt: string;
      readonly createdAt: string;
    },
  ): Promise<ReservationRow | null> {
    const result = await executor.query<ReservationRow>(
      `INSERT INTO saas_billing_reservations
          (id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
           amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10, $11, $12, $12)
         ON CONFLICT DO NOTHING
         RETURNING id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
                   amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, settlement_id,
                   settlement_amount_minor_units, usage_evidence_ref, reconciliation_reference,
                   reconciliation_evidence_ref, release_id, release_evidence_ref, ledger_transaction_id,
                   created_at, updated_at`,
      [
        input.id,
        input.tenantId,
        input.walletId,
        input.currency,
        input.requestId,
        input.identity.namespace,
        input.identity.businessKey,
        input.amountMinorUnits.toString(),
        input.priceSnapshotRef,
        input.metadataRef,
        input.expiresAt,
        input.createdAt,
      ],
    );
    // DO NOTHING keeps the transaction usable for a fresh winner snapshot.
    // A caught unique violation would instead leave PostgreSQL aborted.
    if (result.rows.length === 0 && (result.rowCount === null || result.rowCount === 0)) return null;
    if (!rowsHaveOne(result)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
    return result.rows[0] ?? null;
  }

  private assertReservationReplay(row: ReservationRow, input: NormalizedReserveInput): void {
    if (
      row.tenant_id !== input.tenantId ||
      row.request_id !== input.requestId ||
      row.currency !== input.currency ||
      row.idempotency_namespace !== input.identity.namespace ||
      row.business_key !== input.identity.businessKey ||
      this.amount(row) !== input.amountMinorUnits ||
      row.price_snapshot_ref !== input.priceSnapshotRef ||
      row.metadata_ref !== input.metadataRef ||
      normalizeStoredTimestamp(row.expires_at) !== input.expiresAt
    ) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
  }

  private assertOptionalCurrency(row: ReservationRow, currency: string | null): void {
    if (currency !== null && row.currency !== currency) throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
  }

  private assertPriceSnapshot(row: ReservationRow, priceSnapshotRef: string): void {
    if (row.price_snapshot_ref !== priceSnapshotRef) throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
  }

  private assertSettlementReplay(row: ReservationRow, input: NormalizedSettlementInput): void {
    if (
      row.settlement_id !== input.settlementId ||
      this.optionalAmount(row.settlement_amount_minor_units) !== input.amountMinorUnits ||
      row.usage_evidence_ref !== input.usageEvidenceRef ||
      (input.metadataRef !== null && row.metadata_ref !== input.metadataRef) ||
      (input.reconciliationEvidenceRef !== null && row.reconciliation_evidence_ref !== input.reconciliationEvidenceRef)
    ) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
  }

  private assertPendingSettlementReplay(row: ReservationRow, input: NormalizedSettlementInput): void {
    if (row.settlement_id !== null && row.settlement_id !== input.settlementId) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
    if (
      row.settlement_amount_minor_units !== null &&
      this.optionalAmount(row.settlement_amount_minor_units) !== input.amountMinorUnits
    ) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
    if (row.usage_evidence_ref !== null && row.usage_evidence_ref !== input.usageEvidenceRef) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
    if (
      row.reconciliation_evidence_ref !== null &&
      row.reconciliation_evidence_ref !== input.reconciliationEvidenceRef
    ) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
  }

  private optionalAmount(value: StoredMinorUnits | null): bigint | null {
    return value === null ? null : parseStoredMinorUnits(value);
  }

  private async assertOrRecordPendingSettlement(
    executor: BillingTransactionExecutor,
    row: ReservationRow,
    input: NormalizedSettlementInput,
    forcePending: boolean,
  ): Promise<ReservationRow> {
    if (!forcePending && row.state !== 'reconciliation_pending') return row;
    this.assertPendingSettlementReplay(row, input);
    if (row.settlement_id !== null && row.settlement_amount_minor_units !== null) return row;
    const result = await executor.query<ReservationRow>(
      `UPDATE saas_billing_reservations
       SET state = 'reconciliation_pending',
           settlement_id = COALESCE(settlement_id, $2),
           settlement_amount_minor_units = COALESCE(settlement_amount_minor_units, $3),
           usage_evidence_ref = COALESCE(usage_evidence_ref, $4),
           reconciliation_evidence_ref = COALESCE(reconciliation_evidence_ref, $5),
           updated_at = $6
       WHERE id = $1 AND tenant_id = $7 AND state IN ('reserved', 'reconciliation_pending')
       RETURNING id, tenant_id, wallet_id, currency, request_id, idempotency_namespace, business_key,
                 amount_minor_units, state, price_snapshot_ref, metadata_ref, expires_at, settlement_id,
                 settlement_amount_minor_units, usage_evidence_ref, reconciliation_reference,
                 reconciliation_evidence_ref, release_id, release_evidence_ref, ledger_transaction_id,
                 created_at, updated_at`,
      [
        row.id,
        input.settlementId,
        input.amountMinorUnits.toString(),
        input.usageEvidenceRef,
        input.reconciliationEvidenceRef,
        this.now().toISOString(),
        row.tenant_id,
      ],
    );
    if (!rowsHaveOne(result)) throw new SaasBillingError('BILLING_STORAGE_ERROR');
    const pending = result.rows[0];
    if (!pending) throw new SaasBillingError('BILLING_STORAGE_ERROR');
    return pending;
  }

  private async freezeTenant(executor: BillingTransactionExecutor, tenantId: string, reasonRef: string): Promise<void> {
    await executor.query(
      `INSERT INTO saas_billing_spending_freezes (tenant_id, reason_ref, frozen_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, reasonRef, this.now().toISOString()],
    );
  }

  private async clearFreezeIfResolved(executor: BillingTransactionExecutor, tenantId: string): Promise<void> {
    await executor.query(
      `DELETE FROM saas_billing_spending_freezes f
       WHERE f.tenant_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM saas_billing_reservations r
           WHERE r.tenant_id = f.tenant_id
             AND r.state = 'reconciliation_pending'
             AND r.settlement_amount_minor_units > r.amount_minor_units
         )`,
      [tenantId],
    );
  }

  private async postLedgerTransaction(
    executor: BillingTransactionExecutor,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly currency: string;
      readonly identity: ReservationIdentity;
      readonly sourceType: LedgerTransactionSource;
      readonly amountMinorUnits: bigint;
      readonly metadataRef: string;
      readonly sourceOrderRef: string | null;
      readonly priceSnapshotRef: string | null;
      readonly usageEvidenceRef: string | null;
      readonly walletId: string;
      readonly walletDirection: 'debit' | 'credit';
      readonly counterpartyAccountType: 'funding_source' | 'billing_revenue';
      readonly counterpartyAccountRef: string;
    },
  ): Promise<LedgerPosting> {
    const inserted = await executor.query<LedgerTransactionRow & { inserted_entry_count: string }>(
      `/* billing:post-ledger-pair */
       WITH posting AS (
         INSERT INTO saas_ledger_transactions
           (id, tenant_id, currency, idempotency_namespace, business_key, source_type,
            amount_minor_units, metadata_ref, source_order_ref, price_snapshot_ref, usage_evidence_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING id, tenant_id, currency, idempotency_namespace, business_key, source_type,
                   amount_minor_units, metadata_ref, source_order_ref, price_snapshot_ref,
                   usage_evidence_ref, created_at
       ), entries AS (
         INSERT INTO saas_ledger_entries
           (id, transaction_id, tenant_id, currency, direction, amount_minor_units,
            account_type, account_ref, wallet_id, created_at)
         SELECT entry.id, posting.id, posting.tenant_id, posting.currency, entry.direction,
                posting.amount_minor_units, entry.account_type, entry.account_ref, entry.wallet_id, posting.created_at
           FROM posting
           CROSS JOIN (VALUES
             ($13::uuid, $15::text, 'wallet'::text, $16::text, $16::uuid),
             ($14::uuid, $17::text, $18::text, $19::text, NULL::uuid)
           ) entry(id, direction, account_type, account_ref, wallet_id)
         RETURNING 1 AS inserted
       )
       SELECT posting.*, (SELECT count(*)::text FROM entries) AS inserted_entry_count FROM posting`,
      [
        input.id,
        input.tenantId,
        input.currency,
        input.identity.namespace,
        input.identity.businessKey,
        input.sourceType,
        input.amountMinorUnits.toString(),
        input.metadataRef,
        input.sourceOrderRef,
        input.priceSnapshotRef,
        input.usageEvidenceRef,
        this.now().toISOString(),
        this.idFactory(),
        this.idFactory(),
        input.walletDirection,
        input.walletId,
        input.walletDirection === 'debit' ? 'credit' : 'debit',
        input.counterpartyAccountType,
        input.counterpartyAccountRef,
      ],
    );
    if (rowsHaveOne(inserted)) {
      if (inserted.rows[0]?.inserted_entry_count !== '2') throw new SaasBillingError('BILLING_STORAGE_ERROR');
      const transaction = mapLedgerTransactionRow(inserted.rows[0]);
      return { transaction, created: true };
    }

    // Ledger rows are immutable. Unique idempotency/source-order constraints
    // fence races, and the wallet advisory fence serializes postings for this
    // wallet;
    // SELECT FOR UPDATE would unnecessarily require UPDATE privilege.
    const existing = await executor.query<LedgerTransactionRow>(
      `SELECT id, tenant_id, currency, idempotency_namespace, business_key, source_type,
              amount_minor_units, metadata_ref, source_order_ref, price_snapshot_ref,
              usage_evidence_ref, created_at
       FROM saas_ledger_transactions
       WHERE tenant_id = $1 AND idempotency_namespace = $2 AND business_key = $3`,
      [input.tenantId, input.identity.namespace, input.identity.businessKey],
    );
    if (!rowsHaveOne(existing)) {
      if (input.sourceOrderRef !== null) {
        const sourceOrder = await executor.query<LedgerTransactionRow>(
          `SELECT id, tenant_id, currency, idempotency_namespace, business_key, source_type,
                  amount_minor_units, metadata_ref, source_order_ref, price_snapshot_ref,
                  usage_evidence_ref, created_at
           FROM saas_ledger_transactions
           WHERE tenant_id = $1 AND source_order_ref = $2`,
          [input.tenantId, input.sourceOrderRef],
        );
        if (rowsHaveOne(sourceOrder)) throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
      }
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    const transaction = mapLedgerTransactionRow(existing.rows[0]);
    if (
      transaction.tenant_id !== input.tenantId ||
      transaction.currency !== input.currency ||
      transaction.source_type !== input.sourceType ||
      parseStoredMinorUnits(transaction.amount_minor_units) !== input.amountMinorUnits ||
      transaction.metadata_ref !== input.metadataRef ||
      transaction.source_order_ref !== input.sourceOrderRef ||
      transaction.price_snapshot_ref !== input.priceSnapshotRef ||
      transaction.usage_evidence_ref !== input.usageEvidenceRef
    ) {
      throw new SaasBillingError('IDEMPOTENCY_CONFLICT');
    }
    return { transaction, created: false };
  }

  private async adjustWalletProjection(
    executor: BillingTransactionExecutor,
    wallet: WalletRow,
    transactionId: string,
    delta: bigint,
  ): Promise<WalletRow> {
    const current = parseStoredMinorUnits(wallet.posted_balance_minor_units);
    const next = delta >= 0n ? addMinorUnits(current, delta) : subtractMinorUnits(current, -delta);
    // Materialization plus the FROM dependency evaluates both volatile settings
    // before the wallet trigger. The ledger pair was posted in the preceding
    // command, so the trigger observes it under a fresh command snapshot.
    const updated = await executor.query<WalletRow>(
      `/* billing:project-ledger */
       WITH projection_context AS MATERIALIZED (
         SELECT set_config('saas.billing_ledger_projection_write', 'on', true),
                set_config('saas.billing_ledger_transaction_id', $6, true)
       )
       UPDATE saas_wallets
       SET posted_balance_minor_units = posted_balance_minor_units + $4, updated_at = $5
       FROM projection_context
       WHERE id = $1 AND tenant_id = $2 AND currency = $3
         AND posted_balance_minor_units + $4 >= 0
       RETURNING id, tenant_id, currency, posted_balance_minor_units, created_at, updated_at`,
      [wallet.id, wallet.tenant_id, wallet.currency, delta.toString(), this.now().toISOString(), transactionId],
    );
    if (!rowsHaveOne(updated)) throw new SaasBillingError('INSUFFICIENT_FUNDS');
    const updatedWallet = updated.rows[0];
    if (!updatedWallet || parseStoredMinorUnits(updatedWallet.posted_balance_minor_units) !== next) {
      throw new SaasBillingError('BILLING_STORAGE_ERROR');
    }
    return updatedWallet;
  }
}

export {
  PlatformWalletLedgerService as PlatformBillingLedgerService,
  PlatformWalletLedgerService as SaasBillingService,
};
