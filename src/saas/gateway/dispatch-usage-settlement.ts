import { createHash } from 'node:crypto';
import type { NormalizedUsage } from '../../telemetry/usage.js';
import { multiplyMinorUnits } from '../billing/groups/multiplier.js';
import { snapshotBillingGroupTerms } from '../billing/groups/snapshot.js';
import type { AttemptRecord, UsageValues } from '../metering/types.js';
import { calculatePriceVersion } from '../pricing/calculator.js';
import {
  resolveServiceTierBillingTerms,
  type ServiceTierTrustResolution,
  serviceTierObservedAuthority,
  serviceTierTrustCategory,
  settlementServiceTierTerms,
} from '../pricing/service-tier-trust.js';
import type {
  CustomerPriceSnapshotRecord,
  CustomerPriceVersionRecord,
  SupplierCostVersionRecord,
} from '../pricing/types.js';
import type { GatewayProtocol, SupplyMode } from './contracts.js';
import type { ResolvedSupplyBillingIdentity } from './resolved-supply-billing-identity.js';
import type { TransportServiceTierEvidence } from './usage-evidence.js';

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
  /**
   * R3 §8.1: the resolved SUPPLY billing identity frozen per attempt. On
   * composite dispatches `providerId`/`productId`/`endpoint` above stay the
   * CUSTOMER (nominal route) identity the customer price version is
   * registered under; this block carries the actual supply identity the
   * supplier cost version was resolved for, so precheck, claim and
   * settlement verify the same identity. Absent on legacy snapshots.
   */
  readonly supplyBilling?: ResolvedSupplyBillingIdentity | null;
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
   * §4.1 and R3 §8.3 service-tier settlement terms: the requested tier
   * frozen from the final outbound payload, the observed tier declared by
   * the response. The per-category trust rules are applied HERE (never at
   * the calculator): an authoritative observed tier can only lower the
   * charge, and non-authoritative categories (Codex OAuth) never apply it.
   */
  readonly serviceTier?: TransportServiceTierEvidence | null;
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
  /**
   * R3 §8.1: settlement verifies the supplier cost version against the
   * SAME resolved supply identity precheck and claim verified. Optional so
   * legacy compositions keep settling without it.
   */
  getSupplierCostVersion?(id: string): Promise<SupplierCostVersionRecord>;
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

function usageDigest(usage: NormalizedUsage, tierResolution: ServiceTierTrustResolution | null = null): string {
  /*
   * §4.1 (task #15) anti-drift, the #14 policy applied to usage evidence:
   * the media fields enter the digest material ONLY when the observation is
   * media (non-token mode, unit count, or tier present). A token-only
   * observation digests to exactly its pre-4.1 value — verified by
   * regression test, because this digest is the normal-success usage
   * evidence reference bound into the settlement proof.
   *
   * R3 §8.3 follows the same policy for the tier resolution: it enters the
   * digest material only when tier evidence exists, so tierless settlements
   * keep byte-identical evidence references while every downgrade,
   * retention and conflict becomes explainable in the settlement proof.
   */
  const material =
    USAGE_FIELDS.map((field) => `${field}=${usage[field] ?? 'null'}`).join('&') +
    (usage.billingMode === 'token' && usage.units === null && usage.sizeTier === null
      ? ''
      : `&billingMode=${usage.billingMode ?? 'token'}&units=${usage.units ?? 'null'}&sizeTier=${usage.sizeTier ?? 'null'}`) +
    (tierResolution === null
      ? ''
      : `&serviceTier=${tierResolution.requested}>${tierResolution.observed}:${tierResolution.billing}:${tierResolution.reason}`);
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
  /*
   * R3 §8.1: the snapshot's providerId/productId/endpoint are the CUSTOMER
   * sale identity — the route's nominal pins on composite dispatches. The
   * customer price version is registered under exactly that identity, so
   * the check is unchanged for composite; the supplier side is verified
   * separately against the resolved supply identity.
   */
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
 * R3 §8.1: settlement re-verifies the supplier cost version against the
 * SAME resolved supply identity the admission precheck verified and the
 * signed prepared-evidence claim carries. The conservative profit fence and
 * any later cost resolution reuse this identity — they never fall back to
 * the route's nominal provider.
 */
async function assertSupplyBillingIdentity(
  pricing: NormalSuccessPricingPort,
  snapshot: NormalSuccessSettlementSnapshot,
): Promise<void> {
  const supplyBilling = snapshot.supplyBilling ?? null;
  if (supplyBilling === null) return;
  if (pricing.getSupplierCostVersion === undefined) return;
  if (snapshot.supplyMode !== 'platform') {
    throw new Error('resolved supply billing identity requires a platform quote');
  }
  if (snapshot.customerPriceVersion === null) {
    throw new Error('platform settlement quote is incomplete');
  }
  const supplierCost = await pricing.getSupplierCostVersion(supplyBilling.supplierCostVersion);
  if (
    supplierCost.kind !== 'supplier' ||
    supplierCost.providerId !== supplyBilling.providerId ||
    supplierCost.productId !== supplyBilling.productId ||
    supplierCost.resolvedModel !== supplyBilling.upstreamModel ||
    supplierCost.publicModelId !== snapshot.publicModelId ||
    String(supplierCost.publicModelVersion) !== snapshot.publicModelVersion
  ) {
    throw new Error('supplier cost version does not match the resolved supply billing identity');
  }
}

/**
 * R3 §8.3: resolves the billing tier under the per-category trust rules.
 * The category comes from the frozen supply identity (the composite target
 * platform), so Codex OAuth dispatches keep their outbound tier while
 * verified public APIs may bill at the trusted lower tier.
 */
function resolveSettlementServiceTier(
  snapshot: NormalSuccessSettlementSnapshot,
  serviceTier: TransportServiceTierEvidence | null | undefined,
): ServiceTierTrustResolution | null {
  if (serviceTier === null || serviceTier === undefined) return null;
  if (serviceTier.requested === null && serviceTier.observed === null && serviceTier.observedConflict !== true) {
    return null;
  }
  const providerId = snapshot.supplyBilling?.providerId ?? snapshot.providerId;
  const category = serviceTierTrustCategory({ providerId });
  return resolveServiceTierBillingTerms({
    requested: serviceTier.requested,
    observed: serviceTier.observed,
    observedAuthority: serviceTierObservedAuthority(category),
    observedConflict: serviceTier.observedConflict === true,
  });
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
    // R3 §8.3: the per-category tier trust resolution happens here, once,
    // against the frozen supply identity — settlement never re-interprets
    // the tier against newer adapter or price-policy configuration.
    const tierResolution = resolveSettlementServiceTier(snapshot, input.serviceTier);
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
      // R3 §8.1: the supplier side is verified against the resolved supply
      // identity before any amount is computed.
      await assertSupplyBillingIdentity(this.pricing, snapshot);
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
        // §8.3: only the trust-resolved terms reach the calculator; a
        // non-authoritative or conflicting observed tier is suppressed
        // before the only-lower rule can see it.
        { requireComplete: false, serviceTier: settlementServiceTierTerms(tierResolution) },
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
    } else if (snapshot.supplyBilling != null) {
      // §8.1: a resolved supply identity exists only for platform quotes.
      throw new Error('resolved supply billing identity requires a platform quote');
    }

    const digest = input.usageEvidenceDigest || usageDigest(input.usage, tierResolution);
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
