/** Exact integer input. Number values are accepted only when safe integers. */
export type ExactIntegerInput = bigint | number | string;

/** Structurally compatible admission terms produced from an immutable price snapshot. */
export interface PlatformRequestAdmissionTerms {
  readonly currency: string;
  readonly amountMinorUnits: bigint | string;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string | Date;
}

export type PriceMetric = 'input' | 'cache_read' | 'cache_write' | 'cache_write_5m' | 'cache_write_1h' | 'output';

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

export type RateSetInput = Partial<Record<PriceMetric, RationalRateInput | null>>;
export type RateSet = Readonly<Record<PriceMetric, RationalRate | null>>;

export interface TokenUsageInput {
  readonly inputTotal: ExactIntegerInput | null;
  readonly inputUncached: ExactIntegerInput | null;
  readonly cacheRead: ExactIntegerInput | null;
  readonly cacheWrite: ExactIntegerInput | null;
  readonly cacheWrite5m: ExactIntegerInput | null;
  readonly cacheWrite1h: ExactIntegerInput | null;
  readonly outputTotal: ExactIntegerInput | null;
  readonly reasoningOutput: ExactIntegerInput | null;
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
}
