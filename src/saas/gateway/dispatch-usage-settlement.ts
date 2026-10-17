import { createHash } from 'node:crypto';
import type { NormalizedUsage } from '../../telemetry/usage.js';
import { multiplyMinorUnits } from '../billing/groups/multiplier.js';
import { snapshotBillingGroupTerms } from '../billing/groups/snapshot.js';
import type { AttemptRecord, UsageValues } from '../metering/types.js';
import { calculatePriceVersion } from '../pricing/calculator.js';
import type { CustomerPriceSnapshotRecord, CustomerPriceVersionRecord } from '../pricing/types.js';
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
  /**
   * §4.1 service-tier settlement terms (requested tier from the request
   * payload, observed tier from the response). Absent keeps the base rate;
   * the only-lower rule means an observed tier can never raise the charge.
   * The category transports (#16/#17) feed this from their observers.
   */
  readonly serviceTier?: { readonly requested: string | null; readonly observed: string | null } | null;
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
  /** Reads the immutable admission snapshot so settlement never re-queries the group table. */
  getCustomerPriceSnapshot(id: string): Promise<CustomerPriceSnapshotRecord>;
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
  /*
   * §4.1 (task #15) anti-drift, the #14 policy applied to usage evidence:
   * the media fields enter the digest material ONLY when the observation is
   * media (non-token mode, unit count, or tier present). A token-only
   * observation digests to exactly its pre-4.1 value — verified by
   * regression test, because this digest is the normal-success usage
   * evidence reference bound into the settlement proof.
   */
  const material =
    USAGE_FIELDS.map((field) => `${field}=${usage[field] ?? 'null'}`).join('&') +
    (usage.billingMode === 'token' && usage.units === null && usage.sizeTier === null
      ? ''
      : `&billingMode=${usage.billingMode ?? 'token'}&units=${usage.units ?? 'null'}&sizeTier=${usage.sizeTier ?? 'null'}`);
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
    billingMode: usage.billingMode ?? 'token',
    units: exact(usage.units ?? null),
    sizeTier: usage.sizeTier ?? null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: usage.semanticsVersion,
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
}

function assertUsage(usage: NormalizedUsage): asserts usage is NormalSuccessObservedUsage {
  // §4.1: a media observation is complete with a unit count even when the
  // transport reports no token counters at all (image generation).
  const media = (usage.billingMode ?? 'token') !== 'token' || usage.units !== null;
  if (usage.status !== 'reported' || usage.source !== 'upstream') {
    throw new Error('provider usage is not a complete upstream report');
  }
  if (media) {
    if (usage.units === null) {
      throw new Error('provider usage is not a complete upstream report');
    }
    return;
  }
  if (usage.inputTotal === null || usage.outputTotal === null) {
    throw new Error('provider usage is not a complete upstream report');
  }
}

function assertPriceIdentity(
  price: CustomerPriceVersionRecord,
  snapshot: NormalSuccessSettlementSnapshot,
  priceSnapshot: CustomerPriceSnapshotRecord,
): void {
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
  // R1: the frozen admission snapshot — not the mutable billing group — is
  // the multiplier authority. Its identity and multiplier terms must match
  // the prepared quote, and the terms must be well-formed.
  const snapshotRateMultiplier = priceSnapshot.rateMultiplier ?? { numerator: 1n, denominator: 1n };
  if (
    priceSnapshot.id !== snapshot.priceSnapshotRef ||
    priceSnapshot.customerPriceVersion !== snapshot.customerPriceVersion ||
    snapshotRateMultiplier.numerator <= 0n ||
    snapshotRateMultiplier.denominator <= 0n
  ) {
    throw new Error('admission price snapshot does not match the prepared quote');
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
      const priceSnapshot = await this.pricing.getCustomerPriceSnapshot(snapshot.priceSnapshotRef);
      assertPriceIdentity(price, snapshot, priceSnapshot);
      // Admission-time billing-group terms, read from the immutable snapshot
      // row (never the group table): a later group edit cannot reprice this
      // settlement.
      const billingGroupTerms = snapshotBillingGroupTerms(priceSnapshot);
      const effectivePrice =
        billingGroupTerms.modelPricingOverride === null
          ? price
          : { ...price, rates: billingGroupTerms.modelPricingOverride.rates };
      const calculation = calculatePriceVersion(
        effectivePrice,
        {
          inputTotal: input.usage.inputTotal,
          inputUncached: input.usage.inputUncached,
          cacheRead: input.usage.cacheRead,
          cacheWrite: input.usage.cacheWrite,
          cacheWrite5m: input.usage.cacheWrite5m,
          cacheWrite1h: input.usage.cacheWrite1h,
          outputTotal: input.usage.outputTotal,
          reasoningOutput: input.usage.reasoningOutput,
          perUnitUnits: input.usage.units ?? null,
          sizeTier: input.usage.sizeTier ?? null,
        },
        { requireComplete: false, serviceTier: input.serviceTier ?? null },
      );
      if (!calculation.complete) throw new Error('provider usage is insufficient for the selected price');
      chargeAmountMinorUnits = multiplyMinorUnits(
        calculation.amountMinorUnits,
        billingGroupTerms.rateMultiplier,
        price.roundingMode,
      ).toString(10);
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
