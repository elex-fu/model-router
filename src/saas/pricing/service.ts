import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { MAX_MINOR_UNITS, normalizeCurrency } from '../billing/money.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import {
  calculatePriceVersion,
  calculateUsageSettlement,
  normalizeHoldInput,
  normalizeRates,
  priceHoldInputToUsage,
} from './calculator.js';
import { SaasPricingError } from './errors.js';
import type {
  AppendCustomerPriceVersionInput,
  AppendSupplierCostVersionInput,
  CommercialPriceVersionRecordBase,
  CreateCustomerPriceSnapshotInput,
  CreateSupplierCostSnapshotInput,
  CustomerPriceSnapshotRecord,
  CustomerPriceSnapshotResult,
  CustomerPriceVersionRecord,
  ExactIntegerInput,
  NormalizedPriceHoldInput,
  PlatformPriceAuditContext,
  PlatformPriceVersionHistoryPage,
  PlatformPriceVersionHistoryQuery,
  PlatformPriceVersionKind,
  PlatformPricingReferences,
  PlatformPricingTargetPage,
  PlatformPricingTargetRecord,
  PlatformRequestAdmissionTerms,
  PricingIdentity,
  PricingSettlementInput,
  RateSet,
  RegisterPlatformPriceVersionInput,
  ResolveCustomerPriceVersionInput,
  ResolveSupplierCostVersionInput,
  RoundingBoundary,
  RoundingMode,
  SaasPricingServiceOptions,
  SupplierCostSnapshotRecord,
  SupplierCostVersionRecord,
  SupplierPricingIdentity,
  UsageSettlementCalculation,
} from './types.js';
import { SUPPLIER_ATTEMPT_BINDING_REQUIRED_COLUMNS } from './types.js';

const MAX_TEXT_LENGTH = 512;
const MAX_DIGEST = /^[0-9a-f]{64}$/;

const CUSTOMER_PRICE_COLUMNS = `
  id, version, public_model_id, public_model_version, provider_id, product_id, protocol, endpoint, currency,
  commercial_policy_version, calculator_version, rounding_version, rounding_mode, rounding_boundary,
  input_rate_numerator_minor_units, input_rate_denominator_units,
  cache_read_rate_numerator_minor_units, cache_read_rate_denominator_units,
  cache_write_rate_numerator_minor_units, cache_write_rate_denominator_units,
  cache_write_5m_rate_numerator_minor_units, cache_write_5m_rate_denominator_units,
  cache_write_1h_rate_numerator_minor_units, cache_write_1h_rate_denominator_units,
  output_rate_numerator_minor_units, output_rate_denominator_units,
  effective_at, expires_at, idempotency_key, definition_digest, created_at`;

const SUPPLIER_COST_COLUMNS = `
  id, version, public_model_id, public_model_version, provider_id, product_id, resolved_model, protocol, endpoint,
  currency, commercial_policy_version, calculator_version, rounding_version, rounding_mode, rounding_boundary,
  input_rate_numerator_minor_units, input_rate_denominator_units,
  cache_read_rate_numerator_minor_units, cache_read_rate_denominator_units,
  cache_write_rate_numerator_minor_units, cache_write_rate_denominator_units,
  cache_write_5m_rate_numerator_minor_units, cache_write_5m_rate_denominator_units,
  cache_write_1h_rate_numerator_minor_units, cache_write_1h_rate_denominator_units,
  output_rate_numerator_minor_units, output_rate_denominator_units,
  effective_at, expires_at, idempotency_key, definition_digest, created_at`;

const CUSTOMER_SNAPSHOT_COLUMNS = `
  id, tenant_id, request_id, customer_price_version, public_model_id, public_model_version,
  provider_id, product_id, protocol, endpoint, currency, commercial_policy_version, calculator_version,
  rounding_version, rounding_mode, rounding_boundary, hold_input_total, hold_input_uncached,
  hold_input_cache_read, hold_input_cache_write, hold_input_cache_write_5m, hold_input_cache_write_1h,
  hold_input_output_total, hold_input_reasoning_output, hold_amount_minor_units, wallet_hold_required,
  admission_expires_at, idempotency_key, snapshot_digest, created_at`;

const SUPPLIER_SNAPSHOT_COLUMNS = `
  id, tenant_id, request_id, attempt_id, supplier_cost_version, platform_account_id,
  public_model_id, public_model_version, provider_id, product_id, resolved_model, protocol, endpoint,
  currency, commercial_policy_version, calculator_version, rounding_version, rounding_mode,
  rounding_boundary, idempotency_key, snapshot_digest, created_at`;

type Row = Record<string, unknown>;

interface NormalizedCommonPriceInput {
  readonly idempotencyKey: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly commercialPolicyVersion: string;
  readonly calculatorVersion: string;
  readonly roundingVersion: string;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary: RoundingBoundary;
  readonly rates: RateSet;
}

type CustomerPriceRow = Row;
type SupplierCostRow = Row;
type CustomerSnapshotRow = Row;
type SupplierSnapshotRow = Row;

interface PlatformPricingTargetRow extends Row {
  readonly public_model_id: unknown;
  readonly public_model_version: unknown;
  readonly public_model_alias: unknown;
  readonly display_name: unknown;
  readonly provider_id: unknown;
  readonly product_id: unknown;
  readonly resolved_model: unknown;
  readonly protocol: unknown;
  readonly endpoint: unknown;
  readonly capability_version: unknown;
}

const SUPPLIER_ATTEMPT_CONTRACT_COLUMNS = [
  ...SUPPLIER_ATTEMPT_BINDING_REQUIRED_COLUMNS,
  'resolved_model',
  'protocol',
  'supplier_cost_version',
] as const;

const PLATFORM_PRICE_TARGET_FROM_SQL = `
  WITH latest_capability AS (
    SELECT DISTINCT ON (provider_id, product_id, model, endpoint)
           provider_id, product_id, model, endpoint, protocol, version,
           support_level, validation_state
      FROM saas_provider_capabilities
     ORDER BY provider_id, product_id, model, endpoint, version DESC
  )
  SELECT DISTINCT ON (model_version.public_model_id, model_version.version, capability.endpoint, capability.protocol)
         model_version.public_model_id, model_version.version AS public_model_version,
         public_model.alias AS public_model_alias, public_model.display_name,
         model_version.provider_id, model_version.product_id,
         model_version.model AS resolved_model, capability.protocol, capability.endpoint,
         capability.version AS capability_version
    FROM saas_public_model_versions AS model_version
    JOIN saas_public_models AS public_model ON public_model.id = model_version.public_model_id
    JOIN saas_provider_products AS product
      ON product.provider_id = model_version.provider_id AND product.product_id = model_version.product_id
    JOIN latest_capability AS capability
      ON capability.provider_id = model_version.provider_id
     AND capability.product_id = model_version.product_id
     AND capability.model = model_version.model
     AND model_version.endpoint_scope @> ARRAY[capability.endpoint]::text[]
   WHERE public_model.status = 'active'
     AND model_version.status = 'active'
     AND product.status = 'active'
     AND capability.support_level IN ('supported', 'limited')
     AND capability.validation_state = 'verified'
     AND EXISTS (
       SELECT 1
         FROM saas_provider_rights AS rights
        WHERE rights.provider_id = model_version.provider_id
          AND rights.product_id = model_version.product_id
          AND rights.supply_mode = 'platform'
          AND rights.status = 'active'
          AND rights.effective_at <= $1::timestamptz
          AND (rights.expires_at IS NULL OR rights.expires_at > $1::timestamptz)
          AND rights.model_scope @> ARRAY[model_version.model]::text[]
          AND rights.endpoint_scope @> ARRAY[capability.endpoint]::text[]
     )`;

function platformPricingTargetSql(kind: PlatformPriceVersionKind, mode: 'list' | 'resolve'): string {
  const supplierAccountPredicate =
    kind === 'supplier'
      ? `
     AND EXISTS (
       SELECT 1
         FROM saas_platform_provider_account_capabilities AS binding
         JOIN saas_platform_provider_accounts AS account
           ON account.id = binding.account_id
          AND account.provider_id = binding.provider_id
          AND account.product_id = binding.product_id
         JOIN saas_provider_rights AS account_rights
           ON account_rights.rights_id = account.rights_id
          AND account_rights.version = account.rights_version
        WHERE binding.provider_id = model_version.provider_id
          AND binding.product_id = model_version.product_id
          AND binding.model = model_version.model
          AND binding.endpoint = capability.endpoint
          AND binding.capability_version = capability.version
          AND account.owner_kind = 'platform'
          AND account.supply_mode = 'platform'
          AND account.status IN ('pending', 'active')
          AND account_rights.supply_mode = 'platform'
          AND account_rights.status = 'active'
          AND account_rights.effective_at <= $1::timestamptz
          AND (account_rights.expires_at IS NULL OR account_rights.expires_at > $1::timestamptz)
          AND account_rights.model_scope @> ARRAY[model_version.model]::text[]
          AND account_rights.endpoint_scope @> ARRAY[capability.endpoint]::text[]
     )`
      : '';
  const identityFilter =
    mode === 'resolve'
      ? `
     AND model_version.public_model_id = $2
     AND model_version.version = $3
     AND capability.endpoint = $4
     AND capability.protocol = $5`
      : '';
  const pageLimit = mode === 'list' ? '\n   LIMIT $2 OFFSET $3' : '\n   LIMIT 1';
  return `${PLATFORM_PRICE_TARGET_FROM_SQL}${supplierAccountPredicate}${identityFilter}
   ORDER BY model_version.public_model_id, model_version.version,
            capability.endpoint, capability.protocol, capability.version DESC${pageLimit}`;
}

function fail(code: ConstructorParameters<typeof SaasPricingError>[0]): never {
  throw new SaasPricingError(code);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function normalizeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') fail('INVALID_INPUT');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    fail('INVALID_INPUT');
  }
  return normalized;
}

function normalizeId(value: unknown): string {
  return normalizeText(value, 255);
}

function normalizeCurrencyValue(value: unknown): string {
  try {
    return normalizeCurrency(value);
  } catch {
    fail('INVALID_CURRENCY');
  }
}

function normalizeVersion(value: ExactIntegerInput | unknown): number {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && value.trim().length <= 19 && /^(0|[1-9][0-9]*)$/.test(value.trim()))
    parsed = BigInt(value.trim());
  else fail('INVALID_INPUT');
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT');
  return Number(parsed);
}

function normalizeStoredVersion(value: unknown): number {
  try {
    return normalizeVersion(value);
  } catch {
    fail('PRICING_STORAGE_ERROR');
  }
}

function normalizePricePageLimit(value: unknown, defaultValue = 50): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) fail('INVALID_INPUT');
  return value;
}

function normalizePriceTargetOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(value)) fail('INVALID_INPUT');
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) fail('INVALID_INPUT');
  return offset;
}

function normalizePlatformPriceKind(value: unknown): PlatformPriceVersionKind {
  if (value === 'customer' || value === 'supplier') return value;
  fail('INVALID_INPUT');
}

function normalizePlatformPriceAuditContext(value: PlatformPriceAuditContext): {
  readonly actorUserId: string;
  readonly entryPoint: 'platform_admin';
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const actorUserId = normalizeId(value.actorUserId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(actorUserId)) {
    fail('INVALID_INPUT');
  }
  if (value.entryPoint !== 'platform_admin') fail('INVALID_INPUT');
  const requestId = normalizeText(value.requestId, 128);
  const sourceIp = value.sourceIp === undefined || value.sourceIp === null ? null : normalizeText(value.sourceIp, 64);
  if (sourceIp !== null && isIP(sourceIp) === 0) fail('INVALID_INPUT');
  const userAgent =
    value.userAgent === undefined || value.userAgent === null ? null : normalizeText(value.userAgent, 512);
  return { actorUserId, entryPoint: 'platform_admin', requestId, sourceIp, userAgent };
}

function normalizeTimestamp(value: unknown, code: 'INVALID_INPUT' | 'PRICING_STORAGE_ERROR' = 'INVALID_INPUT'): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail(code);
  return date.toISOString();
}

function normalizeWindow(effectiveAt: unknown, expiresAt: unknown): { effectiveAt: string; expiresAt: string | null } {
  const effective = normalizeTimestamp(effectiveAt);
  const expires = expiresAt === undefined || expiresAt === null ? null : normalizeTimestamp(expiresAt);
  if (expires !== null && new Date(expires).getTime() <= new Date(effective).getTime()) fail('INVALID_WINDOW');
  return { effectiveAt: effective, expiresAt: expires };
}

function normalizeRoundingMode(value: unknown): RoundingMode {
  if (value === 'floor' || value === 'ceil' || value === 'half_up' || value === 'half_even') return value;
  fail('INVALID_INPUT');
}

function normalizeRoundingBoundary(value: unknown): RoundingBoundary {
  if (value === undefined || value === 'total') return 'total';
  fail('INVALID_INPUT');
}

function normalizeCommonPriceInput(input: {
  readonly idempotencyKey: string;
  readonly effectiveAt: string | Date;
  readonly expiresAt?: string | Date | null;
  readonly commercialPolicyVersion: string;
  readonly calculatorVersion: string;
  readonly roundingVersion: string;
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary?: RoundingBoundary;
  readonly rates: Parameters<typeof normalizeRates>[0];
}): NormalizedCommonPriceInput {
  const window = normalizeWindow(input.effectiveAt, input.expiresAt);
  return {
    idempotencyKey: normalizeText(input.idempotencyKey),
    effectiveAt: window.effectiveAt,
    expiresAt: window.expiresAt,
    commercialPolicyVersion: normalizeText(input.commercialPolicyVersion, 128),
    calculatorVersion: normalizeText(input.calculatorVersion, 128),
    roundingVersion: normalizeText(input.roundingVersion, 128),
    roundingMode: normalizeRoundingMode(input.roundingMode),
    roundingBoundary: normalizeRoundingBoundary(input.roundingBoundary),
    rates: normalizeRates(input.rates),
  };
}

function normalizeCustomerIdentity(input: PricingIdentity): PricingIdentity {
  return {
    publicModelId: normalizeId(input.publicModelId),
    publicModelVersion: normalizeVersion(input.publicModelVersion),
    providerId: normalizeId(input.providerId),
    productId: normalizeId(input.productId),
    protocol: normalizeText(input.protocol, 80),
    endpoint: normalizeText(input.endpoint, 255),
    currency: normalizeCurrencyValue(input.currency),
  };
}

function normalizeSupplierIdentity(input: SupplierPricingIdentity): SupplierPricingIdentity {
  return {
    ...normalizeCustomerIdentity(input),
    resolvedModel: normalizeText(input.resolvedModel, 255),
  };
}

function parseStoredInteger(value: unknown): bigint {
  try {
    if (typeof value === 'bigint') {
      if (value < 0n || value > MAX_MINOR_UNITS) fail('PRICING_STORAGE_ERROR');
      return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value)) {
      const parsed = BigInt(value);
      if (parsed <= MAX_MINOR_UNITS) return parsed;
    }
  } catch {
    fail('PRICING_STORAGE_ERROR');
  }
  fail('PRICING_STORAGE_ERROR');
}

function storedText(row: Row, key: string, maxLength = MAX_TEXT_LENGTH): string {
  try {
    return normalizeText(row[key], maxLength);
  } catch (error) {
    if (error instanceof SaasPricingError) fail('PRICING_STORAGE_ERROR');
    throw error;
  }
}

function storedTimestamp(row: Row, key: string): string {
  return normalizeTimestamp(row[key], 'PRICING_STORAGE_ERROR');
}

function storedNullableTimestamp(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : storedTimestamp(row, key);
}

function storedRate(row: Row, metric: string): { numeratorMinorUnits: bigint; denominatorUnits: bigint } | null {
  const numerator = row[`${metric}_rate_numerator_minor_units`];
  const denominator = row[`${metric}_rate_denominator_units`];
  if (numerator === null || numerator === undefined) {
    if (denominator !== null && denominator !== undefined) fail('PRICING_STORAGE_ERROR');
    return null;
  }
  if (denominator === null || denominator === undefined) fail('PRICING_STORAGE_ERROR');
  const parsedNumerator = parseStoredInteger(numerator);
  const parsedDenominator = parseStoredInteger(denominator);
  if (parsedDenominator === 0n) fail('PRICING_STORAGE_ERROR');
  return { numeratorMinorUnits: parsedNumerator, denominatorUnits: parsedDenominator };
}

function storedRates(row: Row): RateSet {
  return normalizeRates({
    input: storedRate(row, 'input') ?? fail('PRICING_STORAGE_ERROR'),
    cache_read: storedRate(row, 'cache_read'),
    cache_write: storedRate(row, 'cache_write'),
    cache_write_5m: storedRate(row, 'cache_write_5m'),
    cache_write_1h: storedRate(row, 'cache_write_1h'),
    output: storedRate(row, 'output') ?? fail('PRICING_STORAGE_ERROR'),
  });
}

function storedRoundingMode(row: Row): RoundingMode {
  return normalizeRoundingMode(row.rounding_mode);
}

function storedRoundingBoundary(row: Row): RoundingBoundary {
  return normalizeRoundingBoundary(row.rounding_boundary);
}

function mapPriceBase(row: Row): CommercialPriceVersionRecordBase {
  const definitionDigest = storedText(row, 'definition_digest', 64);
  if (!MAX_DIGEST.test(definitionDigest)) fail('PRICING_STORAGE_ERROR');
  return {
    id: storedText(row, 'id', 255),
    version: normalizeStoredVersion(row.version),
    publicModelId: storedText(row, 'public_model_id', 255),
    publicModelVersion: normalizeStoredVersion(row.public_model_version),
    providerId: storedText(row, 'provider_id', 255),
    productId: storedText(row, 'product_id', 255),
    protocol: storedText(row, 'protocol', 80),
    endpoint: storedText(row, 'endpoint', 255),
    currency: normalizeCurrencyValue(row.currency),
    commercialPolicyVersion: storedText(row, 'commercial_policy_version', 128),
    calculatorVersion: storedText(row, 'calculator_version', 128),
    roundingVersion: storedText(row, 'rounding_version', 128),
    roundingMode: storedRoundingMode(row),
    roundingBoundary: storedRoundingBoundary(row),
    rates: storedRates(row),
    effectiveAt: storedTimestamp(row, 'effective_at'),
    expiresAt: storedNullableTimestamp(row, 'expires_at'),
    idempotencyKey: storedText(row, 'idempotency_key'),
    definitionDigest,
    createdAt: storedTimestamp(row, 'created_at'),
  };
}

function mapCustomerPrice(row: CustomerPriceRow): CustomerPriceVersionRecord {
  return { kind: 'customer', ...mapPriceBase(row) };
}

function mapSupplierPrice(row: SupplierCostRow): SupplierCostVersionRecord {
  return {
    kind: 'supplier',
    ...mapPriceBase(row),
    resolvedModel: storedText(row, 'resolved_model', 255),
  };
}

function mapPlatformPricingTarget(row: PlatformPricingTargetRow): PlatformPricingTargetRecord {
  return {
    publicModelId: storedText(row, 'public_model_id', 255),
    publicModelVersion: normalizeStoredVersion(row.public_model_version),
    publicModelAlias: storedText(row, 'public_model_alias', 255),
    displayName: storedText(row, 'display_name'),
    providerId: storedText(row, 'provider_id', 255),
    productId: storedText(row, 'product_id', 255),
    resolvedModel: storedText(row, 'resolved_model', 255),
    protocol: storedText(row, 'protocol', 80),
    endpoint: storedText(row, 'endpoint', 255),
    capabilityVersion: normalizeStoredVersion(row.capability_version),
  };
}

function mapHoldInput(row: Row): NormalizedPriceHoldInput {
  return {
    inputTotal: parseStoredInteger(row.hold_input_total),
    inputUncached: parseStoredInteger(row.hold_input_uncached),
    cacheRead: parseStoredInteger(row.hold_input_cache_read),
    cacheWrite: parseStoredInteger(row.hold_input_cache_write),
    cacheWrite5m: parseStoredInteger(row.hold_input_cache_write_5m),
    cacheWrite1h: parseStoredInteger(row.hold_input_cache_write_1h),
    outputTotal: parseStoredInteger(row.hold_input_output_total),
    reasoningOutput: parseStoredInteger(row.hold_input_reasoning_output),
  };
}

function storedBoolean(row: Row, key: string): boolean {
  if (typeof row[key] !== 'boolean') fail('PRICING_STORAGE_ERROR');
  return row[key] as boolean;
}

function mapCustomerSnapshot(row: CustomerSnapshotRow): CustomerPriceSnapshotRecord {
  const snapshotDigest = storedText(row, 'snapshot_digest', 64);
  if (!MAX_DIGEST.test(snapshotDigest)) fail('PRICING_STORAGE_ERROR');
  const holdAmountMinorUnits = parseStoredInteger(row.hold_amount_minor_units);
  const walletHoldRequired = storedBoolean(row, 'wallet_hold_required');
  return {
    id: storedText(row, 'id', 255),
    tenantId: storedText(row, 'tenant_id', 255),
    requestId: storedText(row, 'request_id', 255),
    customerPriceVersion: storedText(row, 'customer_price_version', 255),
    publicModelId: storedText(row, 'public_model_id', 255),
    publicModelVersion: normalizeStoredVersion(row.public_model_version),
    providerId: storedText(row, 'provider_id', 255),
    productId: storedText(row, 'product_id', 255),
    protocol: storedText(row, 'protocol', 80),
    endpoint: storedText(row, 'endpoint', 255),
    currency: normalizeCurrencyValue(row.currency),
    commercialPolicyVersion: storedText(row, 'commercial_policy_version', 128),
    calculatorVersion: storedText(row, 'calculator_version', 128),
    roundingVersion: storedText(row, 'rounding_version', 128),
    roundingMode: normalizeRoundingMode(row.rounding_mode),
    roundingBoundary: normalizeRoundingBoundary(row.rounding_boundary),
    holdInput: mapHoldInput(row),
    holdAmountMinorUnits,
    walletHoldRequired,
    admissionExpiresAt: storedTimestamp(row, 'admission_expires_at'),
    idempotencyKey: storedText(row, 'idempotency_key'),
    snapshotDigest,
    createdAt: storedTimestamp(row, 'created_at'),
  };
}

function mapSupplierSnapshot(row: SupplierSnapshotRow): SupplierCostSnapshotRecord {
  const snapshotDigest = storedText(row, 'snapshot_digest', 64);
  if (!MAX_DIGEST.test(snapshotDigest)) fail('PRICING_STORAGE_ERROR');
  return {
    id: storedText(row, 'id', 255),
    tenantId: storedText(row, 'tenant_id', 255),
    requestId: storedText(row, 'request_id', 255),
    attemptId: storedText(row, 'attempt_id', 255),
    supplierCostVersion: storedText(row, 'supplier_cost_version', 255),
    platformAccountId: storedText(row, 'platform_account_id', 255),
    publicModelId: storedText(row, 'public_model_id', 255),
    publicModelVersion: normalizeStoredVersion(row.public_model_version),
    providerId: storedText(row, 'provider_id', 255),
    productId: storedText(row, 'product_id', 255),
    resolvedModel: storedText(row, 'resolved_model', 255),
    protocol: storedText(row, 'protocol', 80),
    endpoint: storedText(row, 'endpoint', 255),
    currency: normalizeCurrencyValue(row.currency),
    commercialPolicyVersion: storedText(row, 'commercial_policy_version', 128),
    calculatorVersion: storedText(row, 'calculator_version', 128),
    roundingVersion: storedText(row, 'rounding_version', 128),
    roundingMode: normalizeRoundingMode(row.rounding_mode),
    roundingBoundary: normalizeRoundingBoundary(row.rounding_boundary),
    idempotencyKey: storedText(row, 'idempotency_key'),
    snapshotDigest,
    createdAt: storedTimestamp(row, 'created_at'),
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rateDigest(rates: RateSet): Record<string, { numeratorMinorUnits: string; denominatorUnits: string } | null> {
  return Object.fromEntries(
    Object.entries(rates).map(([metric, rate]) => [
      metric,
      rate === null
        ? null
        : {
            numeratorMinorUnits: rate.numeratorMinorUnits.toString(10),
            denominatorUnits: rate.denominatorUnits.toString(10),
          },
    ]),
  );
}

function priceDigest(identity: PricingIdentity | SupplierPricingIdentity, common: NormalizedCommonPriceInput): string {
  return digest({
    ...identity,
    publicModelVersion: String(identity.publicModelVersion),
    effectiveAt: common.effectiveAt,
    expiresAt: common.expiresAt,
    commercialPolicyVersion: common.commercialPolicyVersion,
    calculatorVersion: common.calculatorVersion,
    roundingVersion: common.roundingVersion,
    roundingMode: common.roundingMode,
    roundingBoundary: common.roundingBoundary,
    rates: rateDigest(common.rates),
  });
}

function snapshotTerms(snapshot: CustomerPriceSnapshotRecord): {
  readonly currency: string;
  readonly amountMinorUnits: bigint;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string;
} {
  if (snapshot.holdAmountMinorUnits <= 0n || snapshot.walletHoldRequired !== true) {
    fail('ZERO_PRICE_NOT_RESERVABLE');
  }
  return {
    currency: snapshot.currency,
    amountMinorUnits: snapshot.holdAmountMinorUnits,
    priceSnapshotRef: snapshot.id,
    expiresAt: snapshot.admissionExpiresAt,
  };
}

function rateColumns(rates: RateSet): unknown[] {
  return [
    rates.input?.numeratorMinorUnits ?? null,
    rates.input?.denominatorUnits ?? null,
    rates.cache_read?.numeratorMinorUnits ?? null,
    rates.cache_read?.denominatorUnits ?? null,
    rates.cache_write?.numeratorMinorUnits ?? null,
    rates.cache_write?.denominatorUnits ?? null,
    rates.cache_write_5m?.numeratorMinorUnits ?? null,
    rates.cache_write_5m?.denominatorUnits ?? null,
    rates.cache_write_1h?.numeratorMinorUnits ?? null,
    rates.cache_write_1h?.denominatorUnits ?? null,
    rates.output?.numeratorMinorUnits ?? null,
    rates.output?.denominatorUnits ?? null,
  ];
}

function customerIdentityValues(identity: PricingIdentity): unknown[] {
  return [
    identity.publicModelId,
    identity.publicModelVersion,
    identity.providerId,
    identity.productId,
    identity.protocol,
    identity.endpoint,
    identity.currency,
  ];
}

function supplierIdentityValues(identity: SupplierPricingIdentity): unknown[] {
  return [
    identity.publicModelId,
    identity.publicModelVersion,
    identity.providerId,
    identity.productId,
    identity.resolvedModel,
    identity.protocol,
    identity.endpoint,
    identity.currency,
  ];
}

type PriceLineage =
  | { readonly kind: 'customer'; readonly identity: PricingIdentity }
  | { readonly kind: 'supplier'; readonly identity: SupplierPricingIdentity };

function priceLineageValues(lineage: PriceLineage): readonly unknown[] {
  return lineage.kind === 'customer'
    ? customerIdentityValues(lineage.identity)
    : supplierIdentityValues(lineage.identity);
}

function canonicalPriceLineageKey(lineage: PriceLineage): string {
  return JSON.stringify([
    'saas-pricing-lineage-v1',
    lineage.kind,
    ...priceLineageValues(lineage).map((value) => String(value)),
  ]);
}

function priceLineageLockKey(lineage: PriceLineage): string {
  return createHash('sha256').update(canonicalPriceLineageKey(lineage)).digest().readBigInt64BE(0).toString(10);
}

function mapStorageError(
  error: unknown,
  conflict: 'PRICE_VERSION_CONFLICT' | 'SNAPSHOT_CONFLICT' | 'PRICING_STORAGE_ERROR' = 'PRICING_STORAGE_ERROR',
): SaasPricingError {
  if (error instanceof SaasPricingError) return error;
  return new SaasPricingError(isUniqueViolation(error) ? conflict : 'PRICING_STORAGE_ERROR');
}

export class SaasPricingService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: SaasDatabase,
    options: SaasPricingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private currentDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('PRICING_STORAGE_ERROR');
    return new Date(value.getTime());
  }

  private async query<RowType>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<RowType[]> {
    try {
      const result = await executor.query<RowType>(sql, values);
      return result.rows;
    } catch (error) {
      if (isUniqueViolation(error)) throw error;
      throw mapStorageError(error);
    }
  }

  private async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) throw error;
      throw mapStorageError(error);
    }
  }

  private async write<T>(executor: SqlExecutor | undefined, work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return executor ? work(executor) : this.transaction(work);
  }

  /**
   * A row lock cannot protect a missing lineage: a SELECT ... FOR SHARE that
   * returns no rows leaves a concurrent insert phantom. Both pricing append
   * writers and effective-version resolvers take this transaction lock first,
   * using the same canonical identity, so those service paths serialize even
   * when the lineage has no existing row. This does not coordinate arbitrary
   * SQL writers that do not take the same advisory lock.
   */
  private async lockPriceLineage(executor: SqlExecutor, lineage: PriceLineage): Promise<void> {
    await this.query(executor, 'SELECT pg_advisory_xact_lock($1::bigint)', [priceLineageLockKey(lineage)]);
  }

  private async resolvePlatformPricingTarget(
    executor: SqlExecutor,
    kind: PlatformPriceVersionKind,
    input: Pick<RegisterPlatformPriceVersionInput, 'publicModelId' | 'publicModelVersion' | 'protocol' | 'endpoint'>,
    at: string,
  ): Promise<PlatformPricingTargetRecord> {
    const rows = await this.query<PlatformPricingTargetRow>(executor, platformPricingTargetSql(kind, 'resolve'), [
      at,
      input.publicModelId,
      input.publicModelVersion,
      input.endpoint,
      input.protocol,
    ]);
    if (!rows[0]) fail('PRICE_VERSION_NOT_FOUND');
    return mapPlatformPricingTarget(rows[0]);
  }

  private async appendPlatformPriceAudit(
    executor: SqlExecutor,
    context: ReturnType<typeof normalizePlatformPriceAuditContext>,
    kind: PlatformPriceVersionKind,
    priceVersionId: string,
    occurredAt: string,
  ): Promise<void> {
    const customer = kind === 'customer';
    await this.query(
      executor,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
          source_ip, user_agent, entry_point, request_id)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        context.actorUserId,
        customer ? 'pricing.customer_price_version.registered' : 'pricing.supplier_cost_version.registered',
        customer ? 'saas_customer_price_versions' : 'saas_supplier_cost_versions',
        priceVersionId,
        occurredAt,
        context.sourceIp,
        context.userAgent,
        context.entryPoint,
        context.requestId,
      ],
    );
  }

  async listPlatformPricingTargets(input: {
    readonly kind: PlatformPriceVersionKind;
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<PlatformPricingTargetPage> {
    const kind = normalizePlatformPriceKind(input?.kind);
    const limit = normalizePricePageLimit(input.limit, 100);
    const offset = normalizePriceTargetOffset(input.cursor);
    const rows = await this.query<PlatformPricingTargetRow>(this.database, platformPricingTargetSql(kind, 'list'), [
      this.currentDate().toISOString(),
      limit + 1,
      offset,
    ]);
    const visible = rows.slice(0, limit).map(mapPlatformPricingTarget);
    const hasMore = rows.length > limit;
    return {
      items: visible,
      hasMore,
      nextCursor: hasMore ? String(offset + visible.length) : null,
    };
  }

  async listPlatformPriceVersionHistory(
    input: PlatformPriceVersionHistoryQuery,
  ): Promise<PlatformPriceVersionHistoryPage> {
    const kind = normalizePlatformPriceKind(input?.kind);
    const publicModelId = normalizeId(input.publicModelId);
    const publicModelVersion = normalizeVersion(input.publicModelVersion);
    const protocol = normalizeText(input.protocol, 80);
    const endpoint = normalizeText(input.endpoint, 255);
    const currency = normalizeCurrencyValue(input.currency);
    const limit = normalizePricePageLimit(input.limit);
    const cursor = input.cursor === undefined || input.cursor === null ? null : normalizeVersion(input.cursor);
    const params: unknown[] = [publicModelId, publicModelVersion, protocol, endpoint, currency, cursor, limit + 1];
    const rows =
      kind === 'customer'
        ? await this.query<CustomerPriceRow>(
            this.database,
            `SELECT ${CUSTOMER_PRICE_COLUMNS}
               FROM saas_customer_price_versions
              WHERE public_model_id = $1 AND public_model_version = $2
                AND protocol = $3 AND endpoint = $4 AND currency = $5
                AND ($6::bigint IS NULL OR version < $6::bigint)
              ORDER BY version DESC
              LIMIT $7`,
            params,
          )
        : await this.query<SupplierCostRow>(
            this.database,
            `SELECT ${SUPPLIER_COST_COLUMNS.replace(/\n/g, ' ')
              .split(',')
              .map((column) => `price.${column.trim()}`)
              .join(', ')}
               FROM saas_supplier_cost_versions AS price
               JOIN saas_public_model_versions AS model_version
                 ON model_version.public_model_id = price.public_model_id
                AND model_version.version = price.public_model_version
                AND model_version.provider_id = price.provider_id
                AND model_version.product_id = price.product_id
                AND model_version.model = price.resolved_model
              WHERE price.public_model_id = $1 AND price.public_model_version = $2
                AND price.protocol = $3 AND price.endpoint = $4 AND price.currency = $5
                AND ($6::bigint IS NULL OR price.version < $6::bigint)
              ORDER BY price.version DESC
              LIMIT $7`,
            params,
          );
    const mapped = kind === 'customer' ? rows.map(mapCustomerPrice) : rows.map(mapSupplierPrice);
    const visible = mapped.slice(0, limit);
    const hasMore = mapped.length > limit;
    return {
      items: visible,
      hasMore,
      nextCursor: hasMore ? String(visible.at(-1)?.version ?? '') || null : null,
    };
  }

  private async registerPlatformPriceVersion(
    kind: PlatformPriceVersionKind,
    input: RegisterPlatformPriceVersionInput,
  ): Promise<CustomerPriceVersionRecord | SupplierCostVersionRecord> {
    const publicModelId = normalizeId(input.publicModelId);
    const publicModelVersion = normalizeVersion(input.publicModelVersion);
    const protocol = normalizeText(input.protocol, 80);
    const endpoint = normalizeText(input.endpoint, 255);
    const currency = normalizeCurrencyValue(input.currency);
    const common = normalizeCommonPriceInput(input);
    const audit = normalizePlatformPriceAuditContext(input.audit);
    const occurredAt = this.currentDate().toISOString();

    return this.transaction(async (tx) => {
      const target = await this.resolvePlatformPricingTarget(
        tx,
        kind,
        { publicModelId, publicModelVersion, protocol, endpoint },
        occurredAt,
      );
      const identity: PricingIdentity = {
        publicModelId,
        publicModelVersion,
        providerId: target.providerId,
        productId: target.productId,
        protocol,
        endpoint,
        currency,
      };
      const record =
        kind === 'customer'
          ? await this.appendCustomer(identity, common, occurredAt, tx)
          : await this.appendSupplier({ ...identity, resolvedModel: target.resolvedModel }, common, occurredAt, tx);
      await this.appendPlatformPriceAudit(tx, audit, kind, record.id, occurredAt);
      return record;
    }).catch((error) => {
      if (error instanceof SaasPricingError) throw error;
      throw mapStorageError(error, 'PRICE_VERSION_CONFLICT');
    });
  }

  async registerPlatformCustomerPriceVersion(
    input: RegisterPlatformPriceVersionInput,
  ): Promise<CustomerPriceVersionRecord> {
    return (await this.registerPlatformPriceVersion('customer', input)) as CustomerPriceVersionRecord;
  }

  async registerPlatformSupplierCostVersion(
    input: RegisterPlatformPriceVersionInput,
  ): Promise<SupplierCostVersionRecord> {
    return (await this.registerPlatformPriceVersion('supplier', input)) as SupplierCostVersionRecord;
  }

  private async requirePlatformRequest(
    executor: SqlExecutor,
    tenantId: string,
    requestId: string,
  ): Promise<{ readonly supplyMode: string; readonly protocol: string; readonly endpoint: string }> {
    const rows = await this.query<Row>(
      executor,
      `SELECT supply_mode, protocol, endpoint
         FROM saas_requests
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
        FOR SHARE`,
      [tenantId, requestId],
    );
    const row = rows[0];
    if (!row) fail('SNAPSHOT_CONFLICT');
    const supplyMode = storedText(row, 'supply_mode', 32);
    const protocol = storedText(row, 'protocol', 80);
    const endpoint = storedText(row, 'endpoint', 255);
    if (supplyMode !== 'platform') fail('PLATFORM_REQUEST_REQUIRED');
    return { supplyMode, protocol, endpoint };
  }

  private assertRequestProtocolAndEndpoint(
    request: { readonly protocol: string; readonly endpoint: string },
    expectedProtocol: string,
    expectedEndpoint: string,
  ): void {
    if (request.protocol !== expectedProtocol || request.endpoint !== expectedEndpoint) {
      fail('REQUEST_BINDING_MISMATCH');
    }
  }

  private async requirePlatformAccount(
    executor: SqlExecutor,
    platformAccountId: string,
    providerId: string,
    productId: string,
  ): Promise<void> {
    const rows = await this.query<Row>(
      executor,
      `SELECT id
         FROM saas_platform_provider_accounts
        WHERE id = $1
          AND provider_id = $2
          AND product_id = $3
          AND owner_kind = 'platform'
          AND supply_mode = 'platform'
        LIMIT 1
        FOR SHARE`,
      [platformAccountId, providerId, productId],
    );
    if (!rows[0]) fail('SUPPLIER_ACCOUNT_NOT_FOUND');
  }

  private async requireSupplierAttemptBinding(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly attemptId: string;
      readonly platformAccountId: string;
    },
    price: SupplierCostVersionRecord,
  ): Promise<void> {
    const columnRows = await this.query<{ column_name?: unknown }>(
      executor,
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'saas_attempts'
          AND column_name IN (${SUPPLIER_ATTEMPT_CONTRACT_COLUMNS.map((column) => `'${column}'`).join(', ')})`,
    );
    const availableColumns = new Set(columnRows.map((row) => row.column_name));
    const missingColumns = SUPPLIER_ATTEMPT_CONTRACT_COLUMNS.filter((column) => !availableColumns.has(column));
    if (missingColumns.length > 0) fail('SUPPLIER_ATTEMPT_BINDING_UNAVAILABLE');

    const rows = await this.query<Row>(
      executor,
      `SELECT a.tenant_id AS attempt_tenant_id,
              a.request_id AS attempt_request_id,
              a.platform_account_id,
              a.provider_id AS attempt_provider_id,
              a.product_id AS attempt_product_id,
              a.resolved_model AS attempt_resolved_model,
              a.protocol AS attempt_protocol,
              a.endpoint AS attempt_endpoint,
              a.supplier_cost_version AS attempt_supplier_cost_version,
              r.tenant_id AS request_tenant_id,
              r.id AS request_id,
              r.supply_mode AS request_supply_mode,
              r.protocol AS request_protocol,
              r.endpoint AS request_endpoint
         FROM saas_attempts AS a
         JOIN saas_requests AS r
           ON r.tenant_id = a.tenant_id
          AND r.id = a.request_id
        WHERE a.tenant_id = $1
          AND a.id = $2
          AND r.tenant_id = $1
          AND r.id = $3
        LIMIT 1
        FOR SHARE`,
      [input.tenantId, input.attemptId, input.requestId],
    );
    const row = rows[0];
    if (!row) fail('SUPPLIER_ATTEMPT_BINDING_MISMATCH');
    const same = (key: string, expected: unknown): boolean =>
      row[key] === expected || String(row[key]) === String(expected);
    if (
      !same('attempt_tenant_id', input.tenantId) ||
      !same('request_tenant_id', input.tenantId) ||
      !same('attempt_request_id', input.requestId) ||
      !same('request_id', input.requestId) ||
      !same('request_supply_mode', 'platform') ||
      !same('request_protocol', price.protocol) ||
      !same('request_endpoint', price.endpoint) ||
      !same('platform_account_id', input.platformAccountId) ||
      !same('attempt_provider_id', price.providerId) ||
      !same('attempt_product_id', price.productId) ||
      !same('attempt_resolved_model', price.resolvedModel) ||
      !same('attempt_protocol', price.protocol) ||
      !same('attempt_endpoint', price.endpoint) ||
      !same('attempt_supplier_cost_version', price.id)
    ) {
      fail('SUPPLIER_ATTEMPT_BINDING_MISMATCH');
    }
  }

  private async appendCustomer(
    identity: PricingIdentity,
    common: NormalizedCommonPriceInput,
    createdAt: string,
    executor?: SqlExecutor,
  ): Promise<CustomerPriceVersionRecord> {
    const definitionDigest = priceDigest(identity, common);
    return this.write(executor, async (tx) => {
      await this.lockPriceLineage(tx, { kind: 'customer', identity });
      const existingRows = await this.query<CustomerPriceRow>(
        tx,
        `SELECT ${CUSTOMER_PRICE_COLUMNS}
           FROM saas_customer_price_versions
          WHERE public_model_id = $1 AND public_model_version = $2 AND provider_id = $3
            AND product_id = $4 AND protocol = $5 AND endpoint = $6 AND currency = $7
            AND idempotency_key = $8
          LIMIT 1`,
        [...customerIdentityValues(identity), common.idempotencyKey],
      );
      if (existingRows[0]) {
        const existing = mapCustomerPrice(existingRows[0]);
        if (existing.definitionDigest !== definitionDigest) fail('IDEMPOTENCY_CONFLICT');
        return existing;
      }

      const latestRows = await this.query<{ version: unknown }>(
        tx,
        `SELECT version
           FROM saas_customer_price_versions
          WHERE public_model_id = $1 AND public_model_version = $2 AND provider_id = $3
            AND product_id = $4 AND protocol = $5 AND endpoint = $6 AND currency = $7
          ORDER BY version DESC
          LIMIT 1`,
        customerIdentityValues(identity),
      );
      const version = latestRows[0] ? normalizeStoredVersion(latestRows[0].version) + 1 : 1;
      const id = normalizeId(this.idFactory());
      const values = [
        id,
        version,
        ...customerIdentityValues(identity),
        common.commercialPolicyVersion,
        common.calculatorVersion,
        common.roundingVersion,
        common.roundingMode,
        common.roundingBoundary,
        ...rateColumns(common.rates),
        common.effectiveAt,
        common.expiresAt,
        common.idempotencyKey,
        definitionDigest,
        createdAt,
      ];
      const rows = await this.query<CustomerPriceRow>(
        tx,
        `INSERT INTO saas_customer_price_versions
          (${CUSTOMER_PRICE_COLUMNS.replace(/\n/g, ' ')})
         VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
         RETURNING ${CUSTOMER_PRICE_COLUMNS}`,
        values,
      );
      if (!rows[0]) fail('PRICING_STORAGE_ERROR');
      return mapCustomerPrice(rows[0]);
    }).catch((error) => {
      throw mapStorageError(error, 'PRICE_VERSION_CONFLICT');
    });
  }

  private async appendSupplier(
    identity: SupplierPricingIdentity,
    common: NormalizedCommonPriceInput,
    createdAt: string,
    executor?: SqlExecutor,
  ): Promise<SupplierCostVersionRecord> {
    const definitionDigest = priceDigest(identity, common);
    return this.write(executor, async (tx) => {
      await this.lockPriceLineage(tx, { kind: 'supplier', identity });
      const existingRows = await this.query<SupplierCostRow>(
        tx,
        `SELECT ${SUPPLIER_COST_COLUMNS}
           FROM saas_supplier_cost_versions
          WHERE public_model_id = $1 AND public_model_version = $2 AND provider_id = $3
            AND product_id = $4 AND resolved_model = $5 AND protocol = $6 AND endpoint = $7 AND currency = $8
            AND idempotency_key = $9
          LIMIT 1`,
        [...supplierIdentityValues(identity), common.idempotencyKey],
      );
      if (existingRows[0]) {
        const existing = mapSupplierPrice(existingRows[0]);
        if (existing.definitionDigest !== definitionDigest) fail('IDEMPOTENCY_CONFLICT');
        return existing;
      }

      const latestRows = await this.query<{ version: unknown }>(
        tx,
        `SELECT version
           FROM saas_supplier_cost_versions
          WHERE public_model_id = $1 AND public_model_version = $2 AND provider_id = $3
            AND product_id = $4 AND resolved_model = $5 AND protocol = $6 AND endpoint = $7 AND currency = $8
          ORDER BY version DESC
          LIMIT 1`,
        supplierIdentityValues(identity),
      );
      const version = latestRows[0] ? normalizeStoredVersion(latestRows[0].version) + 1 : 1;
      const id = normalizeId(this.idFactory());
      const values = [
        id,
        version,
        ...supplierIdentityValues(identity),
        common.commercialPolicyVersion,
        common.calculatorVersion,
        common.roundingVersion,
        common.roundingMode,
        common.roundingBoundary,
        ...rateColumns(common.rates),
        common.effectiveAt,
        common.expiresAt,
        common.idempotencyKey,
        definitionDigest,
        createdAt,
      ];
      const rows = await this.query<SupplierCostRow>(
        tx,
        `INSERT INTO saas_supplier_cost_versions
          (${SUPPLIER_COST_COLUMNS.replace(/\n/g, ' ')})
         VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
         RETURNING ${SUPPLIER_COST_COLUMNS}`,
        values,
      );
      if (!rows[0]) fail('PRICING_STORAGE_ERROR');
      return mapSupplierPrice(rows[0]);
    }).catch((error) => {
      throw mapStorageError(error, 'PRICE_VERSION_CONFLICT');
    });
  }

  async appendCustomerPriceVersion(input: AppendCustomerPriceVersionInput): Promise<CustomerPriceVersionRecord> {
    const identity = normalizeCustomerIdentity(input);
    const common = normalizeCommonPriceInput(input);
    return this.appendCustomer(identity, common, this.currentDate().toISOString());
  }

  async appendSupplierCostVersion(input: AppendSupplierCostVersionInput): Promise<SupplierCostVersionRecord> {
    const identity = normalizeSupplierIdentity(input);
    const common = normalizeCommonPriceInput(input);
    return this.appendSupplier(identity, common, this.currentDate().toISOString());
  }

  async getCustomerPriceVersion(id: string): Promise<CustomerPriceVersionRecord> {
    const reference = normalizeId(id);
    const rows = await this.query<CustomerPriceRow>(
      this.database,
      `SELECT ${CUSTOMER_PRICE_COLUMNS} FROM saas_customer_price_versions WHERE id = $1 LIMIT 1`,
      [reference],
    );
    if (!rows[0]) fail('PRICE_VERSION_NOT_FOUND');
    return mapCustomerPrice(rows[0]);
  }

  async getSupplierCostVersion(id: string): Promise<SupplierCostVersionRecord> {
    const reference = normalizeId(id);
    const rows = await this.query<SupplierCostRow>(
      this.database,
      `SELECT ${SUPPLIER_COST_COLUMNS} FROM saas_supplier_cost_versions WHERE id = $1 LIMIT 1`,
      [reference],
    );
    if (!rows[0]) fail('PRICE_VERSION_NOT_FOUND');
    return mapSupplierPrice(rows[0]);
  }

  async resolveCustomerPriceVersion(
    input: ResolveCustomerPriceVersionInput,
    options: { readonly executor?: SqlExecutor } = {},
  ): Promise<CustomerPriceVersionRecord> {
    const identity = normalizeCustomerIdentity(input);
    const at = normalizeTimestamp(input.at ?? this.currentDate());
    return this.write(options.executor, async (tx) => {
      await this.lockPriceLineage(tx, { kind: 'customer', identity });
      const rows = await this.query<CustomerPriceRow>(
        tx,
        `SELECT ${CUSTOMER_PRICE_COLUMNS}
           FROM saas_customer_price_versions
          WHERE public_model_id = $1 AND public_model_version = $2 AND provider_id = $3
            AND product_id = $4 AND protocol = $5 AND endpoint = $6 AND currency = $7
            AND effective_at <= $8
            AND (expires_at IS NULL OR expires_at > $8)
          ORDER BY effective_at DESC, version DESC
          LIMIT 1
          FOR SHARE`,
        [...customerIdentityValues(identity), at],
      );
      if (!rows[0]) fail('PRICE_VERSION_NOT_EFFECTIVE');
      return mapCustomerPrice(rows[0]);
    });
  }

  async resolveSupplierCostVersion(
    input: ResolveSupplierCostVersionInput,
    options: { readonly executor?: SqlExecutor } = {},
  ): Promise<SupplierCostVersionRecord> {
    const identity = normalizeSupplierIdentity(input);
    const at = normalizeTimestamp(input.at ?? this.currentDate());
    return this.write(options.executor, async (tx) => {
      await this.lockPriceLineage(tx, { kind: 'supplier', identity });
      const rows = await this.query<SupplierCostRow>(
        tx,
        `SELECT ${SUPPLIER_COST_COLUMNS}
           FROM saas_supplier_cost_versions
          WHERE public_model_id = $1 AND public_model_version = $2 AND provider_id = $3
            AND product_id = $4 AND resolved_model = $5 AND protocol = $6 AND endpoint = $7 AND currency = $8
            AND effective_at <= $9
            AND (expires_at IS NULL OR expires_at > $9)
          ORDER BY effective_at DESC, version DESC
          LIMIT 1
          FOR SHARE`,
        [...supplierIdentityValues(identity), at],
      );
      if (!rows[0]) fail('PRICE_VERSION_NOT_EFFECTIVE');
      return mapSupplierPrice(rows[0]);
    });
  }

  async createCustomerPriceSnapshot(
    input: CreateCustomerPriceSnapshotInput,
    options: { readonly executor?: SqlExecutor } = {},
  ): Promise<CustomerPriceSnapshotResult> {
    const tenantId = normalizeId(input.tenantId);
    const requestId = normalizeId(input.requestId);
    const priceReference = normalizeId(input.customerPriceVersion);
    const idempotencyKey = normalizeText(input.idempotencyKey);
    const holdInput = normalizeHoldInput(input.holdInput);
    const admissionExpiresAt = normalizeTimestamp(input.admissionExpiresAt);
    const createdAt = this.currentDate().toISOString();
    if (new Date(admissionExpiresAt).getTime() <= new Date(createdAt).getTime()) fail('INVALID_WINDOW');
    const snapshotDigest = digest({
      tenantId,
      requestId,
      customerPriceVersion: priceReference,
      holdInput: Object.fromEntries(Object.entries(holdInput).map(([key, value]) => [key, value.toString(10)])),
      admissionExpiresAt,
      idempotencyKey,
    });

    return this.write(options.executor, async (tx) => {
      const request = await this.requirePlatformRequest(tx, tenantId, requestId);
      const existingRows = await this.query<CustomerSnapshotRow>(
        tx,
        `SELECT ${CUSTOMER_SNAPSHOT_COLUMNS}
           FROM saas_request_customer_price_snapshots
          WHERE tenant_id = $1 AND request_id = $2
          LIMIT 1
          FOR UPDATE`,
        [tenantId, requestId],
      );
      if (existingRows[0]) {
        const existing = mapCustomerSnapshot(existingRows[0]);
        if (existing.snapshotDigest !== snapshotDigest) fail('SNAPSHOT_CONFLICT');
        return this.customerSnapshotResult(existing);
      }

      const priceRows = await this.query<CustomerPriceRow>(
        tx,
        `SELECT ${CUSTOMER_PRICE_COLUMNS}
           FROM saas_customer_price_versions
          WHERE id = $1
          LIMIT 1
          FOR SHARE`,
        [priceReference],
      );
      if (!priceRows[0]) fail('PRICE_VERSION_NOT_FOUND');
      const price = mapCustomerPrice(priceRows[0]);
      this.assertRequestProtocolAndEndpoint(request, price.protocol, price.endpoint);
      const nowMs = new Date(createdAt).getTime();
      if (
        new Date(price.effectiveAt).getTime() > nowMs ||
        (price.expiresAt !== null && new Date(price.expiresAt).getTime() <= nowMs)
      ) {
        fail('PRICE_VERSION_NOT_EFFECTIVE');
      }
      const calculation = calculatePriceVersion(price, priceHoldInputToUsage(holdInput), { requireComplete: true });
      if (calculation.amountMinorUnits <= 0n) fail('ZERO_PRICE_NOT_RESERVABLE');
      const walletHoldRequired = true;
      const id = normalizeId(this.idFactory());
      const values = [
        id,
        tenantId,
        requestId,
        price.id,
        price.publicModelId,
        price.publicModelVersion,
        price.providerId,
        price.productId,
        price.protocol,
        price.endpoint,
        price.currency,
        price.commercialPolicyVersion,
        price.calculatorVersion,
        price.roundingVersion,
        price.roundingMode,
        price.roundingBoundary,
        holdInput.inputTotal,
        holdInput.inputUncached,
        holdInput.cacheRead,
        holdInput.cacheWrite,
        holdInput.cacheWrite5m,
        holdInput.cacheWrite1h,
        holdInput.outputTotal,
        holdInput.reasoningOutput,
        calculation.amountMinorUnits,
        walletHoldRequired,
        admissionExpiresAt,
        idempotencyKey,
        snapshotDigest,
        createdAt,
      ];
      const rows = await this.query<CustomerSnapshotRow>(
        tx,
        `INSERT INTO saas_request_customer_price_snapshots
          (${CUSTOMER_SNAPSHOT_COLUMNS.replace(/\n/g, ' ')})
         VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
         RETURNING ${CUSTOMER_SNAPSHOT_COLUMNS}`,
        values,
      );
      if (!rows[0]) fail('PRICING_STORAGE_ERROR');
      return this.customerSnapshotResult(mapCustomerSnapshot(rows[0]));
    }).catch((error) => {
      throw mapStorageError(error, 'SNAPSHOT_CONFLICT');
    });
  }

  private customerSnapshotResult(snapshot: CustomerPriceSnapshotRecord): CustomerPriceSnapshotResult {
    const admissionTerms = snapshotTerms(snapshot);
    return {
      snapshot,
      admissionTerms,
      walletHoldRequired: true,
      zeroPrice: false,
    };
  }

  async getCustomerPriceSnapshot(id: string): Promise<CustomerPriceSnapshotRecord> {
    const reference = normalizeId(id);
    const rows = await this.query<CustomerSnapshotRow>(
      this.database,
      `SELECT ${CUSTOMER_SNAPSHOT_COLUMNS}
         FROM saas_request_customer_price_snapshots
        WHERE id = $1
        LIMIT 1`,
      [reference],
    );
    if (!rows[0]) fail('PRICE_VERSION_NOT_FOUND');
    return mapCustomerSnapshot(rows[0]);
  }

  async createSupplierCostSnapshot(
    input: CreateSupplierCostSnapshotInput,
    options: { readonly executor?: SqlExecutor } = {},
  ): Promise<SupplierCostSnapshotRecord> {
    const tenantId = normalizeId(input.tenantId);
    const requestId = normalizeId(input.requestId);
    const attemptId = normalizeId(input.attemptId);
    const priceReference = normalizeId(input.supplierCostVersion);
    const platformAccountId = normalizeId(input.platformAccountId);
    const idempotencyKey = normalizeText(input.idempotencyKey);
    const snapshotDigest = digest({
      tenantId,
      requestId,
      attemptId,
      supplierCostVersion: priceReference,
      platformAccountId,
      idempotencyKey,
    });
    const createdAt = this.currentDate().toISOString();

    return this.write(options.executor, async (tx) => {
      const request = await this.requirePlatformRequest(tx, tenantId, requestId);
      const existingRows = await this.query<SupplierSnapshotRow>(
        tx,
        `SELECT ${SUPPLIER_SNAPSHOT_COLUMNS}
           FROM saas_attempt_supplier_cost_snapshots
          WHERE tenant_id = $1 AND request_id = $2 AND attempt_id = $3
          LIMIT 1
          FOR UPDATE`,
        [tenantId, requestId, attemptId],
      );
      if (existingRows[0]) {
        const existing = mapSupplierSnapshot(existingRows[0]);
        if (existing.snapshotDigest !== snapshotDigest) fail('SNAPSHOT_CONFLICT');
        return existing;
      }

      const priceRows = await this.query<SupplierCostRow>(
        tx,
        `SELECT ${SUPPLIER_COST_COLUMNS}
           FROM saas_supplier_cost_versions
          WHERE id = $1
          LIMIT 1
          FOR SHARE`,
        [priceReference],
      );
      if (!priceRows[0]) fail('PRICE_VERSION_NOT_FOUND');
      const price = mapSupplierPrice(priceRows[0]);
      this.assertRequestProtocolAndEndpoint(request, price.protocol, price.endpoint);
      const nowMs = new Date(createdAt).getTime();
      if (
        new Date(price.effectiveAt).getTime() > nowMs ||
        (price.expiresAt !== null && new Date(price.expiresAt).getTime() <= nowMs)
      ) {
        fail('PRICE_VERSION_NOT_EFFECTIVE');
      }
      await this.requirePlatformAccount(tx, platformAccountId, price.providerId, price.productId);
      await this.requireSupplierAttemptBinding(tx, { tenantId, requestId, attemptId, platformAccountId }, price);
      const id = normalizeId(this.idFactory());
      const values = [
        id,
        tenantId,
        requestId,
        attemptId,
        price.id,
        platformAccountId,
        price.publicModelId,
        price.publicModelVersion,
        price.providerId,
        price.productId,
        price.resolvedModel,
        price.protocol,
        price.endpoint,
        price.currency,
        price.commercialPolicyVersion,
        price.calculatorVersion,
        price.roundingVersion,
        price.roundingMode,
        price.roundingBoundary,
        idempotencyKey,
        snapshotDigest,
        createdAt,
      ];
      const rows = await this.query<SupplierSnapshotRow>(
        tx,
        `INSERT INTO saas_attempt_supplier_cost_snapshots
          (${SUPPLIER_SNAPSHOT_COLUMNS.replace(/\n/g, ' ')})
         VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})
         RETURNING ${SUPPLIER_SNAPSHOT_COLUMNS}`,
        values,
      );
      if (!rows[0]) fail('PRICING_STORAGE_ERROR');
      return mapSupplierSnapshot(rows[0]);
    }).catch((error) => {
      throw mapStorageError(error, 'SNAPSHOT_CONFLICT');
    });
  }

  async getSupplierCostSnapshot(id: string): Promise<SupplierCostSnapshotRecord> {
    const reference = normalizeId(id);
    const rows = await this.query<SupplierSnapshotRow>(
      this.database,
      `SELECT ${SUPPLIER_SNAPSHOT_COLUMNS}
         FROM saas_attempt_supplier_cost_snapshots
        WHERE id = $1
        LIMIT 1`,
      [reference],
    );
    if (!rows[0]) fail('PRICE_VERSION_NOT_FOUND');
    return mapSupplierSnapshot(rows[0]);
  }

  async calculateSettlement(input: PricingSettlementInput): Promise<UsageSettlementCalculation> {
    const customerPrice = await this.getCustomerPriceVersion(input.customerPriceVersion);
    const supplierCost = await this.getSupplierCostVersion(input.supplierCostVersion);
    return calculateUsageSettlement({
      customerPrice,
      supplierCost,
      usage: input.usage,
      requireComplete: input.requireComplete,
    });
  }
}

export function toPlatformRequestAdmissionTerms(snapshot: CustomerPriceSnapshotRecord): PlatformRequestAdmissionTerms {
  return snapshotTerms(snapshot);
}

export function toPlatformPricingReferences(
  customerSnapshot: CustomerPriceSnapshotRecord,
  supplierSnapshot: SupplierCostSnapshotRecord,
): PlatformPricingReferences {
  if (
    customerSnapshot.tenantId !== supplierSnapshot.tenantId ||
    customerSnapshot.requestId !== supplierSnapshot.requestId
  ) {
    throw new SaasPricingError('SNAPSHOT_CONFLICT');
  }
  const terms = snapshotTerms(customerSnapshot);
  return {
    ...terms,
    customerPriceVersion: customerSnapshot.customerPriceVersion,
    supplierCostVersion: supplierSnapshot.supplierCostVersion,
    customerPriceSnapshotRef: customerSnapshot.id,
    supplierCostSnapshotRef: supplierSnapshot.id,
    walletHoldRequired: customerSnapshot.walletHoldRequired,
    zeroPrice: !customerSnapshot.walletHoldRequired,
  };
}
