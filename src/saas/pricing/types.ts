/** Exact integer input. Number values are accepted only when safe integers. */
export type ExactIntegerInput = bigint | number | string;

/** Structurally compatible admission terms produced from an immutable price snapshot. */
export interface PlatformRequestAdmissionTerms {
  readonly currency: string;
  readonly amountMinorUnits: bigint | string;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string | Date;
}

/**
 * Priced usage metrics.
 *
 * `per_unit` (roadmap batch 4 §4.0 ⑤ / task #14) is per-request/per-item
 * pricing for media work (e.g. price per generated image). It is type-visible
 * and nullable on every rate set now so #15 (§4.1 billing horizontal) can
 * add the calculator branch, usage envelope, and version-table columns
 * without another RateSet shape change. Until then:
 * - every stored/normalized rate set carries `per_unit: null` (no per-unit
 *   price version can be registered — registration fails closed), and
 * - `per_unit: null` is omitted from the price-version digest material, so
 *   every `definition_digest` computed before this metric existed stays
 *   byte-identical and old price versions re-register idempotently.
 */
export type PriceMetric =
  | 'input'
  | 'cache_read'
  | 'cache_write'
  | 'cache_write_5m'
  | 'cache_write_1h'
  | 'output'
  | 'per_unit';

/**
 * Canonical per-unit size tiers (roadmap batch 4 §4.1, task #15).
 *
 * Tier keys are a closed registry shared by the rate map (`per_unit_tiers`),
 * the usage envelope (`sizeTier`) and the usage-event `size_tier` column, so a
 * tier selected at admission can only settle against a tier priced on the
 * version row. Adding a tier is a schema event (registry + DB CHECK), never a
 * silent string pass-through.
 *
 * Families: image resolution 1k/2k/4k, video resolution 480p/720p/1080p, and
 * audio modes tts/stt/realtime. A version row prices tiers from exactly one
 * family; the registry does not model family membership because the price
 * version's own rate map makes cross-family tiers unbillable (a request with
 * sizeTier 720p against a video version never looks up an image rate).
 */
export const PER_UNIT_TIERS = ['1k', '2k', '4k', '480p', '720p', '1080p', 'tts', 'stt', 'realtime'] as const;

export type PerUnitTier = (typeof PER_UNIT_TIERS)[number];

/**
 * Tier decision (roadmap 4.1): a version row carries its whole tier ladder in
 * `per_unit_tiers` (tier → rate) instead of one version row per tier.
 *
 * Chosen over a `tier` column with same-model sibling rows (option a) because:
 * - the version lineage is the commercial identity; N tiers × M models would
 *   explode the append-only version table and make "the price of this model"
 *   an N-row join for every resolve,
 * - the definition digest already covers the whole normalized rate set, so a
 *   tier map inside the row is covered by the same anti-drift digest policy
 *   (null omitted, canonical key order when present) with no new digest
 *   dimension, and
 * - admission resolves ONE version row and can conservatively price against
 *   the max tier rate without a second lookup.
 *
 * `per_unit` (flat) and `per_unit_tiers` are mutually coherent: a tier-keyed
 * request must find its tier in the map (fail closed PRICE_RATE_MISSING), a
 * tier-less request bills the flat rate. A version may carry either or both.
 */
export type PerUnitTierRates = Readonly<Record<PerUnitTier, RationalRate>>;
export type PerUnitTierRatesInput = Readonly<Partial<Record<PerUnitTier, RationalRateInput | null>>>;

export type RoundingMode = 'floor' | 'ceil' | 'half_up' | 'half_even';
export type RoundingBoundary = 'total';

export interface RationalRateInput {
  readonly numeratorMinorUnits: ExactIntegerInput;
  readonly denominatorUnits: ExactIntegerInput;
}

export interface RationalRate {
  readonly numeratorMinorUnits: bigint;
  readonly denominatorUnits: bigint;
}

/** Rational multiplier for the optional token-path billing dimensions. */
export interface RationalMultiplierInput {
  readonly numerator: ExactIntegerInput;
  readonly denominator: ExactIntegerInput;
}

export interface RationalMultiplier {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Long-context pricing policy (roadmap 4.1, sub2api LongContext* semantics):
 * once the request's billed input tokens cross the threshold, the ENTIRE
 * session's input and output are repriced (not just the excess tokens).
 * `thresholdInclusive` selects `>=` (xAI semantics) over the default `>`
 * (Claude semantics); input and output multipliers are independent rationals
 * (Claude 200k: 2/1 · 2/1; GPT-5.4-style 272k: 2/1 · 3/2).
 */
export interface LongContextPolicyInput {
  readonly inputThreshold: ExactIntegerInput;
  readonly thresholdInclusive: boolean;
  readonly inputMultiplier: RationalMultiplierInput;
  readonly outputMultiplier: RationalMultiplierInput;
}

export interface NormalizedLongContextPolicy {
  readonly inputThreshold: bigint;
  readonly thresholdInclusive: boolean;
  readonly inputMultiplier: RationalMultiplier;
  readonly outputMultiplier: RationalMultiplier;
}

/**
 * Service-tier multipliers: tier → exact multiplier relative to the base rate
 * (default 1/1). Known tiers mirror sub2api's cost ladder
 * (flex < default/standard/auto/scale < priority/fast).
 */
export interface TokenMultiplierPolicyInput {
  readonly serviceTiers?: Readonly<Record<string, RationalMultiplierInput>> | null;
  readonly longContext?: LongContextPolicyInput | null;
}

export interface NormalizedTokenMultiplierPolicy {
  readonly serviceTiers: Readonly<Record<string, RationalMultiplier>>;
  readonly longContext: NormalizedLongContextPolicy | null;
}

export type RateSetInput = Partial<Record<PriceMetric, RationalRateInput | null>> & {
  readonly per_unit_tiers?: PerUnitTierRatesInput | null;
};
export type RateSet = Readonly<Record<PriceMetric, RationalRate | null>> & {
  readonly per_unit_tiers: PerUnitTierRates | null;
};

export interface TokenUsageInput {
  readonly inputTotal: ExactIntegerInput | null;
  readonly inputUncached: ExactIntegerInput | null;
  readonly cacheRead: ExactIntegerInput | null;
  readonly cacheWrite: ExactIntegerInput | null;
  readonly cacheWrite5m: ExactIntegerInput | null;
  readonly cacheWrite1h: ExactIntegerInput | null;
  readonly outputTotal: ExactIntegerInput | null;
  readonly reasoningOutput: ExactIntegerInput | null;
  /**
   * §4.1 per-unit (media) usage: the billable unit count (images, seconds,
   * characters, …). Absent/null on token-only requests; non-null puts the
   * calculation in per-unit mode (a fully absent token-counter family is then
   * "not applicable", not "unknown").
   */
  readonly perUnitUnits?: ExactIntegerInput | null;
  /** Canonical size tier selected at request time; null bills the flat rate. */
  readonly sizeTier?: string | null;
}

export interface NormalizedTokenUsage {
  readonly inputTotal: bigint | null;
  readonly inputUncached: bigint | null;
  readonly cacheRead: bigint | null;
  readonly cacheWrite: bigint | null;
  readonly cacheWrite5m: bigint | null;
  readonly cacheWrite1h: bigint | null;
  readonly outputTotal: bigint | null;
  readonly reasoningOutput: bigint | null;
  readonly perUnitUnits: bigint | null;
  readonly sizeTier: PerUnitTier | null;
}

/** Hold inputs are all explicit so an unknown counter is never silently priced as zero. */
export interface PriceHoldInput {
  readonly inputTotal: ExactIntegerInput;
  readonly inputUncached: ExactIntegerInput;
  readonly cacheRead: ExactIntegerInput;
  readonly cacheWrite: ExactIntegerInput;
  readonly cacheWrite5m: ExactIntegerInput;
  readonly cacheWrite1h: ExactIntegerInput;
  readonly outputTotal: ExactIntegerInput;
  readonly reasoningOutput: ExactIntegerInput;
  /**
   * §4.1 per-unit hold witness (media): the unit-count upper bound the hold
   * reserves. Absent/0 on token-only requests; a media hold always carries an
   * explicit bound so an unknown unit count is never priced as zero.
   */
  readonly perUnitUnits?: ExactIntegerInput | null;
  /** Canonical tier of the per-unit witness; null = flat per-unit rate. */
  readonly sizeTier?: string | null;
}

export interface NormalizedPriceHoldInput {
  readonly inputTotal: bigint;
  readonly inputUncached: bigint;
  readonly cacheRead: bigint;
  readonly cacheWrite: bigint;
  readonly cacheWrite5m: bigint;
  readonly cacheWrite1h: bigint;
  readonly outputTotal: bigint;
  readonly reasoningOutput: bigint;
  readonly perUnitUnits: bigint;
  readonly sizeTier: PerUnitTier | null;
}

export interface PricingIdentity {
  readonly publicModelId: string;
  readonly publicModelVersion: ExactIntegerInput;
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
}

export interface SupplierPricingIdentity extends PricingIdentity {
  readonly resolvedModel: string;
}

export interface CommercialPriceVersionInputBase {
  readonly idempotencyKey: string;
  readonly effectiveAt: string | Date;
  readonly expiresAt?: string | Date | null;
  readonly commercialPolicyVersion: string;
  readonly calculatorVersion: string;
  readonly roundingVersion: string;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary?: RoundingBoundary;
  readonly rates: RateSetInput;
  /**
   * §4.1 optional token-path multipliers (service tier + long context),
   * frozen on the version row like every other pricing input. Absent/null
   * keeps multipliers off (the pre-4.1 behavior) and is omitted from the
   * definition digest, so legacy versions keep byte-identical digests.
   */
  readonly tokenMultipliers?: TokenMultiplierPolicyInput | null;
}

export interface AppendCustomerPriceVersionInput extends PricingIdentity, CommercialPriceVersionInputBase {}

export interface AppendSupplierCostVersionInput extends SupplierPricingIdentity, CommercialPriceVersionInputBase {}

export type PlatformPriceVersionKind = 'customer' | 'supplier';

/**
 * Price targets are resolved from the public-model and Provider catalog on the
 * server. Callers select these keys but never provide a provider/product or
 * account/model binding themselves.
 */
export interface PlatformPricingTargetRecord {
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly publicModelAlias: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly capabilityVersion: number;
}

export interface PlatformPricingTargetPage {
  readonly items: readonly PlatformPricingTargetRecord[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface PlatformPriceAuditContext {
  readonly actorUserId: string;
  readonly entryPoint: 'platform_admin';
  readonly requestId: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
}

/** Platform writes intentionally omit provider, product, account, and resolved model fields. */
export interface RegisterPlatformPriceVersionInput extends CommercialPriceVersionInputBase {
  readonly publicModelId: string;
  readonly publicModelVersion: ExactIntegerInput;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
  readonly audit: PlatformPriceAuditContext;
}

export interface PlatformPriceVersionHistoryQuery {
  readonly kind: PlatformPriceVersionKind;
  readonly publicModelId: string;
  readonly publicModelVersion: ExactIntegerInput;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
  readonly limit?: number;
  /** Previous page's last version as a decimal string. */
  readonly cursor?: string | null;
}

export interface PlatformPriceVersionHistoryPage {
  readonly items: readonly CommercialPriceVersionRecord[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface CommercialPriceVersionRecordBase {
  readonly id: string;
  readonly version: number;
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
  readonly commercialPolicyVersion: string;
  readonly calculatorVersion: string;
  readonly roundingVersion: string;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary: RoundingBoundary;
  readonly rates: RateSet;
  readonly tokenMultipliers: NormalizedTokenMultiplierPolicy | null;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly idempotencyKey: string;
  readonly definitionDigest: string;
  readonly createdAt: string;
}

export interface CustomerPriceVersionRecord extends CommercialPriceVersionRecordBase {
  readonly kind: 'customer';
}

export interface SupplierCostVersionRecord extends CommercialPriceVersionRecordBase {
  readonly kind: 'supplier';
  readonly resolvedModel: string;
}

export type CommercialPriceVersionRecord = CustomerPriceVersionRecord | SupplierCostVersionRecord;

export interface PriceCalculation {
  readonly amountMinorUnits: bigint;
  readonly unroundedNumerator: bigint;
  readonly unroundedDenominator: bigint;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary: RoundingBoundary;
  readonly chargedMetrics: readonly PriceMetric[];
  readonly ignoredMetrics: readonly ('inputTotal' | 'reasoningOutput')[];
  readonly unknownMetrics: readonly string[];
  readonly complete: boolean;
}

export interface UsageSettlementCalculation {
  readonly customerPriceVersion: string;
  readonly supplierCostVersion: string;
  readonly customerCurrency: string;
  readonly supplierCurrency: string;
  readonly customer: PriceCalculation;
  readonly supplier: PriceCalculation;
}

export interface CreateCustomerPriceSnapshotInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly customerPriceVersion: string;
  readonly holdInput: PriceHoldInput;
  readonly admissionExpiresAt: string | Date;
  readonly idempotencyKey: string;
  /**
   * R3 §8.1: the protocol/endpoint the customer price version is registered
   * under. Composite dispatches serve on the resolved target's endpoint while
   * the customer price stays bound to the route's nominal endpoint, so the
   * binding check must not read the serving endpoint off the request row.
   * Absent keeps the pre-8.1 behavior (the request row's own protocol and
   * endpoint).
   */
  readonly priceBinding?: { readonly protocol: string; readonly endpoint: string } | null;
  /**
   * R1 billing-group terms composed at admission. When present the hold
   * amount is the effective price (group model-pricing override applied)
   * multiplied by the composed group rate multiplier, and all terms are
   * frozen onto the snapshot row.
   */
  readonly billingGroup?: SnapshotBillingGroupInput;
}

/** Admission-time billing-group multiplier terms (rational, never floats). */
export interface SnapshotRateMultiplier {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface SnapshotBillingGroupInput {
  readonly billingGroupId: string;
  readonly rateMultiplier: SnapshotRateMultiplier;
  readonly peakApplied: boolean;
  /** The applied group-level per-model price override, if any. */
  readonly modelPricingOverride?: {
    readonly model: string;
    readonly rates: RateSetInput;
    readonly digest: string;
  } | null;
  /**
   * R1 enforcement terms (roadmap 1.3), frozen beside the pricing terms.
   * Absent/null means no limit was in force. Zero is finite (KEY-BUD
   * semantics: NULL unlimited, zero blocks everything).
   */
  readonly rpmLimit?: number | null;
  readonly dailyLimitMinorUnits?: bigint | null;
  readonly weeklyLimitMinorUnits?: bigint | null;
  readonly monthlyLimitMinorUnits?: bigint | null;
  /** Supported model scopes; null/absent means unrestricted. */
  readonly supportedModelScopes?: readonly string[] | null;
  /** The group's fallback group id at admission; null/absent means none. */
  readonly fallbackGroupId?: string | null;
}

export interface CreateSupplierCostSnapshotInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplierCostVersion: string;
  readonly platformAccountId: string;
  readonly idempotencyKey: string;
}

/**
 * The current metering attempt contract does not expose these selected
 * platform-dispatch fields.  Supplier snapshots remain fail-closed until a
 * metering migration adds them and the attempt row can be joined exactly.
 */
export const SUPPLIER_ATTEMPT_BINDING_REQUIRED_COLUMNS = [
  'platform_account_id',
  'provider_id',
  'product_id',
  'endpoint',
] as const;

export interface CustomerPriceSnapshotRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly customerPriceVersion: string;
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
  readonly commercialPolicyVersion: string;
  readonly calculatorVersion: string;
  readonly roundingVersion: string;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary: RoundingBoundary;
  readonly holdInput: NormalizedPriceHoldInput;
  readonly holdAmountMinorUnits: bigint;
  readonly walletHoldRequired: boolean;
  readonly admissionExpiresAt: string;
  readonly idempotencyKey: string;
  readonly snapshotDigest: string;
  readonly createdAt: string;
  /**
   * R1 billing-group terms frozen at admission. Absent on snapshots created
   * before billing groups existed; a null billingGroupId with the neutral
   * multiplier keeps those settlements unchanged.
   */
  readonly billingGroupId?: string | null;
  readonly rateMultiplier?: SnapshotRateMultiplier;
  readonly peakApplied?: boolean;
  readonly modelPricingOverrideDigest?: string | null;
  /** Canonical stored override value (parsed by the billing-groups codec). */
  readonly modelPricingOverride?: unknown;
  /**
   * R1 enforcement terms frozen at admission (migration 112). Absent on
   * snapshots created before the column family existed; null means no
   * limit was in force. Zero limits are finite (block everything).
   */
  readonly groupRpmLimit?: number | null;
  readonly groupDailyLimitMinorUnits?: bigint | null;
  readonly groupWeeklyLimitMinorUnits?: bigint | null;
  readonly groupMonthlyLimitMinorUnits?: bigint | null;
  readonly groupSupportedModelScopes?: readonly string[] | null;
  readonly groupFallbackGroupId?: string | null;
}

export interface SupplierCostSnapshotRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplierCostVersion: string;
  readonly platformAccountId: string;
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
  readonly commercialPolicyVersion: string;
  readonly calculatorVersion: string;
  readonly roundingVersion: string;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary: RoundingBoundary;
  readonly idempotencyKey: string;
  readonly snapshotDigest: string;
  readonly createdAt: string;
}

export interface CustomerPriceSnapshotResult {
  readonly snapshot: CustomerPriceSnapshotRecord;
  readonly admissionTerms: PlatformRequestAdmissionTerms;
  readonly walletHoldRequired: boolean;
  readonly zeroPrice: boolean;
}

export interface PlatformPricingReferences extends PlatformRequestAdmissionTerms {
  readonly customerPriceVersion: string;
  readonly supplierCostVersion: string;
  readonly customerPriceSnapshotRef: string;
  readonly supplierCostSnapshotRef: string;
  readonly walletHoldRequired: boolean;
  readonly zeroPrice: boolean;
}

export interface ResolveCustomerPriceVersionInput extends PricingIdentity {
  readonly at?: string | Date;
}

export interface ResolveSupplierCostVersionInput extends SupplierPricingIdentity {
  readonly at?: string | Date;
}

export interface SaasPricingServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface PricingSettlementInput {
  readonly customerPriceVersion: string;
  readonly supplierCostVersion: string;
  readonly usage: TokenUsageInput;
  readonly requireComplete?: boolean;
  /**
   * §4.1 service-tier settlement terms: the tier the request asked for and
   * the tier the upstream response observed. The only-lower rule applies —
   * an observed tier can never raise the bill above the requested tier.
   * Absent/null keeps multipliers off.
   */
  readonly serviceTier?: { readonly requested: string | null; readonly observed: string | null } | null;
}
