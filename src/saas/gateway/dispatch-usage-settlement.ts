import { createHash } from 'node:crypto';
import type { NormalizedUsage } from '../../telemetry/usage.js';
import type { AttemptRecord, UsageValues } from '../metering/types.js';
import { calculatePriceVersion } from '../pricing/calculator.js';
import type { CustomerPriceVersionRecord } from '../pricing/types.js';
import type { GatewayProtocol, SupplyMode } from './contracts.js';

/** Server-selected commercial and reservation facts carried from preparation to dispatch. */
export interface NormalSuccessSettlementSnapshot {
  readonly supplyMode: SupplyMode;
  readonly providerProtocol: GatewayProtocol;
  readonly customerPriceVersion: string | null;
  readonly reservationId: string | null;
  readonly priceSnapshotRef: string | null;
  readonly currency: string | null;
  readonly holdAmountMinorUnits: string | null;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
  readonly providerId: string;
  readonly productId: string;
  readonly endpoint: string;
  readonly usageEstimatorVersion: string;
}

export interface NormalSuccessObservedUsage extends NormalizedUsage {
  readonly source: 'upstream';
}

export interface NormalSuccessCompletionInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly snapshot: NormalSuccessSettlementSnapshot;
  readonly usage: NormalSuccessObservedUsage;
  readonly usageEvidenceDigest?: string;
}

export interface NormalSuccessUncertaintyInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplyMode: SupplyMode;
  readonly responseStarted: boolean;
  readonly reason: 'usage_missing' | 'usage_untrusted' | 'settlement_failed' | 'dispatch_uncertain';
}

export type NormalSuccessTransactionResult =
  | { readonly kind: 'settled' | 'replayed'; readonly attempt: AttemptRecord }
  | { readonly kind: 'reconciliation_pending'; readonly attempt: AttemptRecord };

export interface NormalSuccessTransactionInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplyMode: SupplyMode;
  readonly responseStarted: true;
  readonly priceSnapshotRef: string | null;
  readonly reservationId: string | null;
  readonly currency: string | null;
  readonly customerPriceVersion: string | null;
  readonly chargeAmountMinorUnits: string | null;
  readonly usageEventKey: string;
  readonly settlementKey: string;
  readonly usageEvidenceRef: string;
  readonly usage: UsageValues;
}

export interface NormalSuccessTransactionPort {
  complete(input: NormalSuccessTransactionInput): Promise<NormalSuccessTransactionResult>;
  retainUnknown(input: NormalSuccessUncertaintyInput): Promise<AttemptRecord>;
}

export interface NormalSuccessPricingPort {
  getCustomerPriceVersion(id: string): Promise<CustomerPriceVersionRecord>;
}

export interface NormalSuccessSettlementPort {
  complete(input: NormalSuccessCompletionInput): Promise<NormalSuccessTransactionResult>;
  retainUnknown(input: NormalSuccessUncertaintyInput): Promise<AttemptRecord>;
}

const USAGE_FIELDS = [
  'inputTotal',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'outputTotal',
  'reasoningOutput',
] as const;

function usageDigest(usage: NormalizedUsage): string {
  const material = USAGE_FIELDS.map((field) => `${field}=${usage[field] ?? 'null'}`).join('&');
  return createHash('sha256').update(material).digest('hex');
}

function exactUsage(usage: NormalizedUsage): UsageValues {
  const exact = (value: number | null): bigint | null => (value === null ? null : BigInt(value));
  return {
    inputTotal: exact(usage.inputTotal),
    inputUncached: exact(usage.inputUncached),
    cacheRead: exact(usage.cacheRead),
    cacheWrite: exact(usage.cacheWrite),
    cacheWrite5m: exact(usage.cacheWrite5m),
    cacheWrite1h: exact(usage.cacheWrite1h),
    outputTotal: exact(usage.outputTotal),
    reasoningOutput: exact(usage.reasoningOutput),
    status: 'reported',
    source: 'upstream',
    semanticsVersion: usage.semanticsVersion,
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
}

function assertUsage(usage: NormalizedUsage): asserts usage is NormalSuccessObservedUsage {
  if (
    usage.status !== 'reported' ||
    usage.source !== 'upstream' ||
    usage.inputTotal === null ||
    usage.outputTotal === null
  ) {
    throw new Error('provider usage is not a complete upstream report');
  }
}

function assertPriceIdentity(price: CustomerPriceVersionRecord, snapshot: NormalSuccessSettlementSnapshot): void {
  if (
    price.id !== snapshot.customerPriceVersion ||
    price.kind !== 'customer' ||
    price.publicModelId !== snapshot.publicModelId ||
    String(price.publicModelVersion) !== snapshot.publicModelVersion ||
    price.providerId !== snapshot.providerId ||
    price.productId !== snapshot.productId ||
    price.protocol !== snapshot.providerProtocol ||
    price.endpoint !== snapshot.endpoint ||
    price.currency !== snapshot.currency
  ) {
    throw new Error('selected customer price does not match the prepared quote');
  }
}

/**
 * Coordinates trusted provider usage, immutable preparation-time pricing, and
 * the normal-success SQL transaction. Incomplete facts are retained for
 * reconciliation; they are never converted into a zero charge.
 */
export class DispatchUsageSettlementCoordinator implements NormalSuccessSettlementPort {
  constructor(
    private readonly pricing: NormalSuccessPricingPort,
    private readonly transaction: NormalSuccessTransactionPort,
  ) {}

  async complete(input: NormalSuccessCompletionInput): Promise<NormalSuccessTransactionResult> {
    assertUsage(input.usage);
    const snapshot = input.snapshot;
    let chargeAmountMinorUnits: string | null = null;

    if (snapshot.supplyMode === 'platform') {
      if (
        !snapshot.customerPriceVersion ||
        !snapshot.reservationId ||
        !snapshot.priceSnapshotRef ||
        !snapshot.currency ||
        !snapshot.holdAmountMinorUnits
      ) {
        throw new Error('platform settlement quote is incomplete');
      }
      const price = await this.pricing.getCustomerPriceVersion(snapshot.customerPriceVersion);
      assertPriceIdentity(price, snapshot);
      const calculation = calculatePriceVersion(
        price,
        {
          inputTotal: input.usage.inputTotal,
          inputUncached: input.usage.inputUncached,
          cacheRead: input.usage.cacheRead,
          cacheWrite: input.usage.cacheWrite,
          cacheWrite5m: input.usage.cacheWrite5m,
          cacheWrite1h: input.usage.cacheWrite1h,
          outputTotal: input.usage.outputTotal,
          reasoningOutput: input.usage.reasoningOutput,
        },
        { requireComplete: false },
      );
      if (!calculation.complete) throw new Error('provider usage is insufficient for the selected price');
      chargeAmountMinorUnits = calculation.amountMinorUnits.toString(10);
    } else if (
      snapshot.customerPriceVersion !== null ||
      snapshot.reservationId !== null ||
      snapshot.priceSnapshotRef !== null ||
      snapshot.currency !== null ||
      snapshot.holdAmountMinorUnits !== null
    ) {
      throw new Error('BYOK completion cannot contain a platform wallet quote');
    }

    const digest = input.usageEvidenceDigest || usageDigest(input.usage);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('provider usage evidence digest is invalid');
    const usageKey = `saas-normal-success-usage:${createHash('sha256')
      .update(`${input.tenantId}\0${input.requestId}\0${input.attemptId}`)
      .digest('hex')}`;
    const settlementKey = `saas-normal-success:${createHash('sha256')
      .update(`${input.tenantId}\0${input.requestId}`)
      .digest('hex')}`;

    return this.transaction.complete({
      tenantId: input.tenantId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      supplyMode: snapshot.supplyMode,
      responseStarted: true,
      priceSnapshotRef: snapshot.priceSnapshotRef,
      reservationId: snapshot.reservationId,
      currency: snapshot.currency,
      customerPriceVersion: snapshot.customerPriceVersion,
      chargeAmountMinorUnits,
      usageEventKey: usageKey,
      settlementKey,
      usageEvidenceRef: digest,
      usage: exactUsage(input.usage),
    });
  }

  retainUnknown(input: NormalSuccessUncertaintyInput): Promise<AttemptRecord> {
    return this.transaction.retainUnknown(input);
  }
}
