import { MAX_MINOR_UNITS, normalizeCurrency } from '../billing/money.js';
import type { SupplyMode } from '../gateway/contracts.js';
import type { ExactIntegerInput } from '../pricing/types.js';

export type KeyBudgetCap = ExactIntegerInput | null;
export type KeyBudgetWindow = 'daily' | 'lifetime';

export interface TokenBudgetCaps {
  readonly daily: KeyBudgetCap;
  readonly lifetime: KeyBudgetCap;
}

export interface CustomerChargeBudgetCaps {
  readonly currency: string;
  readonly daily: KeyBudgetCap;
  readonly lifetime: KeyBudgetCap;
}

export interface ByokProxyKeyBudgetPolicy {
  readonly supplyMode: 'byok';
  readonly tokenCaps: TokenBudgetCaps;
  readonly customerChargeCaps?: never;
}

export interface PlatformProxyKeyBudgetPolicy {
  readonly supplyMode: 'platform';
  readonly tokenCaps: TokenBudgetCaps;
  readonly customerChargeCaps?: CustomerChargeBudgetCaps;
}

/** Only token and customer-charge dimensions are part of this policy. */
export type ProxyKeyBudgetPolicy = ByokProxyKeyBudgetPolicy | PlatformProxyKeyBudgetPolicy;

export interface BudgetWindowUsage {
  readonly settled: ExactIntegerInput;
  readonly outstandingReserved: ExactIntegerInput;
  /** The new conservative reservation being considered for admission. */
  readonly newReservation: ExactIntegerInput;
}

export interface TokenBudgetUsage {
  readonly daily?: BudgetWindowUsage;
  readonly lifetime?: BudgetWindowUsage;
}

export interface CustomerChargeBudgetUsage extends TokenBudgetUsage {
  readonly currency: string;
}

export interface ByokProxyKeyBudgetUsage {
  readonly supplyMode: 'byok';
  readonly tokenUsage?: TokenBudgetUsage;
  readonly customerChargeUsage?: never;
}

export interface PlatformProxyKeyBudgetUsage {
  readonly supplyMode: 'platform';
  readonly tokenUsage?: TokenBudgetUsage;
  readonly customerChargeUsage?: CustomerChargeBudgetUsage;
}

export type ProxyKeyBudgetUsage = ByokProxyKeyBudgetUsage | PlatformProxyKeyBudgetUsage;

export type ProxyKeyBudgetDimension =
  | 'daily_tokens'
  | 'lifetime_tokens'
  | 'daily_customer_charge'
  | 'lifetime_customer_charge';

export type ProxyKeyBudgetErrorCode =
  | 'INVALID_INPUT'
  | 'AMOUNT_OVERFLOW'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'BYOK_CHARGE_BUDGET_FORBIDDEN'
  | 'UNSUPPORTED_DIMENSION'
  | 'SUPPLY_MODE_MISMATCH';

const SAFE_ERROR_MESSAGES: Record<ProxyKeyBudgetErrorCode, string> = {
  INVALID_INPUT: 'The proxy key budget input is invalid.',
  AMOUNT_OVERFLOW: 'A proxy key budget amount exceeds the supported integer range.',
  INVALID_CURRENCY: 'The proxy key budget currency is invalid.',
  CURRENCY_MISMATCH: 'The proxy key budget currencies do not match.',
  BYOK_CHARGE_BUDGET_FORBIDDEN: 'BYOK proxy keys cannot have customer-charge budgets.',
  UNSUPPORTED_DIMENSION: 'The proxy key budget contains an unsupported dimension.',
  SUPPLY_MODE_MISMATCH: 'The proxy key budget and usage supply modes do not match.',
};

export class ProxyKeyBudgetError extends Error {
  readonly code: ProxyKeyBudgetErrorCode;

  constructor(code: ProxyKeyBudgetErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'ProxyKeyBudgetError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ProxyKeyBudgetAdmission =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly deniedDimension: ProxyKeyBudgetDimension;
      /** Exact projected settled + reserved + new usage for the denied dimension. */
      readonly projectedTotal: bigint;
      readonly cap: bigint;
      readonly currency?: string;
    };

interface NormalizedTokenWindowUsage {
  readonly settled: bigint;
  readonly outstandingReserved: bigint;
  readonly newReservation: bigint;
}

interface NormalizedTokenUsage {
  readonly daily?: NormalizedTokenWindowUsage;
  readonly lifetime?: NormalizedTokenWindowUsage;
}

interface NormalizedChargeUsage extends NormalizedTokenUsage {
  readonly currency: string;
}

interface NormalizedPolicy {
  readonly supplyMode: SupplyMode;
  readonly tokenCaps: Readonly<Record<KeyBudgetWindow, bigint | null>>;
  readonly customerChargeCaps?: Readonly<Record<KeyBudgetWindow, bigint | null>> & { readonly currency: string };
}

interface NormalizedUsage {
  readonly supplyMode: SupplyMode;
  readonly tokenUsage?: NormalizedTokenUsage;
  readonly customerChargeUsage?: NormalizedChargeUsage;
}

function fail(code: ProxyKeyBudgetErrorCode): never {
  throw new ProxyKeyBudgetError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) fail('UNSUPPORTED_DIMENSION');
  }
}

function parseAmount(value: unknown): bigint {
  let amount: bigint;
  if (typeof value === 'bigint') {
    amount = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT');
    amount = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    if (value.length > MAX_MINOR_UNITS.toString().length) fail('AMOUNT_OVERFLOW');
    try {
      amount = BigInt(value);
    } catch {
      fail('INVALID_INPUT');
    }
  } else {
    fail('INVALID_INPUT');
  }

  if (amount < 0n) fail('INVALID_INPUT');
  if (amount > MAX_MINOR_UNITS) fail('AMOUNT_OVERFLOW');
  return amount;
}

function parseCap(value: unknown): bigint | null {
  return value === null ? null : parseAmount(value);
}

function parseCurrency(value: unknown): string {
  try {
    return normalizeCurrency(value);
  } catch {
    fail('INVALID_CURRENCY');
  }
}

function normalizePolicy(value: unknown): NormalizedPolicy {
  if (!isRecord(value)) fail('INVALID_INPUT');
  assertOnlyKeys(value, ['supplyMode', 'tokenCaps', 'customerChargeCaps']);

  const supplyMode = value.supplyMode;
  if (supplyMode !== 'byok' && supplyMode !== 'platform') fail('INVALID_INPUT');

  if (!isRecord(value.tokenCaps)) fail('INVALID_INPUT');
  assertOnlyKeys(value.tokenCaps, ['daily', 'lifetime']);
  if (!hasOwn(value.tokenCaps, 'daily') || !hasOwn(value.tokenCaps, 'lifetime')) fail('INVALID_INPUT');
  const tokenCaps = {
    daily: parseCap(value.tokenCaps.daily),
    lifetime: parseCap(value.tokenCaps.lifetime),
  };

  if (supplyMode === 'byok' && hasOwn(value, 'customerChargeCaps')) {
    fail('BYOK_CHARGE_BUDGET_FORBIDDEN');
  }

  let customerChargeCaps: NormalizedPolicy['customerChargeCaps'];
  if (supplyMode === 'platform' && hasOwn(value, 'customerChargeCaps')) {
    const caps = value.customerChargeCaps;
    if (!isRecord(caps)) fail('INVALID_INPUT');
    assertOnlyKeys(caps, ['currency', 'daily', 'lifetime']);
    if (!hasOwn(caps, 'daily') || !hasOwn(caps, 'lifetime')) fail('INVALID_INPUT');
    customerChargeCaps = {
      currency: parseCurrency(caps.currency),
      daily: parseCap(caps.daily),
      lifetime: parseCap(caps.lifetime),
    };
  }

  return { supplyMode, tokenCaps, ...(customerChargeCaps === undefined ? {} : { customerChargeCaps }) };
}

function normalizeWindowUsage(value: unknown): NormalizedTokenWindowUsage {
  if (!isRecord(value)) fail('INVALID_INPUT');
  assertOnlyKeys(value, ['settled', 'outstandingReserved', 'newReservation']);
  if (!hasOwn(value, 'settled') || !hasOwn(value, 'outstandingReserved') || !hasOwn(value, 'newReservation')) {
    fail('INVALID_INPUT');
  }
  return {
    settled: parseAmount(value.settled),
    outstandingReserved: parseAmount(value.outstandingReserved),
    newReservation: parseAmount(value.newReservation),
  };
}

function normalizeTokenUsage(value: unknown): NormalizedTokenUsage {
  if (!isRecord(value)) fail('INVALID_INPUT');
  assertOnlyKeys(value, ['daily', 'lifetime']);
  return {
    ...(hasOwn(value, 'daily') ? { daily: normalizeWindowUsage(value.daily) } : {}),
    ...(hasOwn(value, 'lifetime') ? { lifetime: normalizeWindowUsage(value.lifetime) } : {}),
  };
}

function normalizeUsage(value: unknown, policy: NormalizedPolicy): NormalizedUsage {
  if (!isRecord(value)) fail('INVALID_INPUT');
  assertOnlyKeys(value, ['supplyMode', 'tokenUsage', 'customerChargeUsage']);
  const supplyMode = value.supplyMode;
  if (supplyMode !== 'byok' && supplyMode !== 'platform') fail('INVALID_INPUT');
  if (supplyMode !== policy.supplyMode) fail('SUPPLY_MODE_MISMATCH');

  if (supplyMode === 'byok' && hasOwn(value, 'customerChargeUsage')) {
    fail('BYOK_CHARGE_BUDGET_FORBIDDEN');
  }

  const tokenUsage = hasOwn(value, 'tokenUsage') ? normalizeTokenUsage(value.tokenUsage) : undefined;
  let customerChargeUsage: NormalizedChargeUsage | undefined;

  if (supplyMode === 'platform' && hasOwn(value, 'customerChargeUsage')) {
    if (policy.customerChargeCaps === undefined) fail('UNSUPPORTED_DIMENSION');
    const chargeUsage = value.customerChargeUsage;
    if (!isRecord(chargeUsage)) fail('INVALID_INPUT');
    assertOnlyKeys(chargeUsage, ['currency', 'daily', 'lifetime']);

    const currency = parseCurrency(chargeUsage.currency);
    if (currency !== policy.customerChargeCaps.currency) fail('CURRENCY_MISMATCH');
    customerChargeUsage = {
      currency,
      ...(hasOwn(chargeUsage, 'daily') ? { daily: normalizeWindowUsage(chargeUsage.daily) } : {}),
      ...(hasOwn(chargeUsage, 'lifetime') ? { lifetime: normalizeWindowUsage(chargeUsage.lifetime) } : {}),
    };
  }

  return {
    supplyMode,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(customerChargeUsage === undefined ? {} : { customerChargeUsage }),
  };
}

function projectedTotal(window: NormalizedTokenWindowUsage): bigint {
  // BigInt addition remains exact even when the aggregate is larger than one persisted bigint.
  return window.settled + window.outstandingReserved + window.newReservation;
}

function evaluateDimension(
  dimension: ProxyKeyBudgetDimension,
  cap: bigint | null,
  usage: NormalizedTokenWindowUsage | undefined,
  currency?: string,
): ProxyKeyBudgetAdmission | null {
  if (cap === null) return null;
  if (usage === undefined) fail('INVALID_INPUT');

  const total = projectedTotal(usage);
  if (total <= cap) return null;
  return {
    allowed: false,
    deniedDimension: dimension,
    projectedTotal: total,
    cap,
    ...(currency === undefined ? {} : { currency }),
  };
}

/**
 * Evaluates the key's token and, for platform supply, customer-charge caps.
 * Each configured finite cap is checked against settled + outstanding
 * reservations + the new conservative reservation. Unlimited caps always pass.
 */
export function evaluateProxyKeyBudgetAdmission(
  policy: ProxyKeyBudgetPolicy,
  usage: ProxyKeyBudgetUsage,
): ProxyKeyBudgetAdmission {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedUsage = normalizeUsage(usage, normalizedPolicy);

  const checks: readonly (ProxyKeyBudgetAdmission | null)[] = [
    evaluateDimension('daily_tokens', normalizedPolicy.tokenCaps.daily, normalizedUsage.tokenUsage?.daily),
    evaluateDimension('lifetime_tokens', normalizedPolicy.tokenCaps.lifetime, normalizedUsage.tokenUsage?.lifetime),
  ];
  for (const result of checks) {
    if (result !== null) return result;
  }

  const chargeCaps = normalizedPolicy.customerChargeCaps;
  if (chargeCaps !== undefined) {
    const chargeUsage = normalizedUsage.customerChargeUsage;
    const dailyResult = evaluateDimension(
      'daily_customer_charge',
      chargeCaps.daily,
      chargeUsage?.daily,
      chargeCaps.currency,
    );
    if (dailyResult !== null) return dailyResult;

    const lifetimeResult = evaluateDimension(
      'lifetime_customer_charge',
      chargeCaps.lifetime,
      chargeUsage?.lifetime,
      chargeCaps.currency,
    );
    if (lifetimeResult !== null) return lifetimeResult;
  }

  return { allowed: true };
}
