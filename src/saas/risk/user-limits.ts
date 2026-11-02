import { normalizeCurrency } from '../billing/money.js';

const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

export interface UserLimitPolicy {
  readonly requestsPerMinute: bigint | null;
  readonly maxConcurrentRequests: bigint | null;
  readonly dailyTokenUnits: bigint | null;
  readonly dailyChargeMinorUnits: bigint | null;
  readonly chargeCurrency: string | null;
}

export const UNLIMITED_USER_LIMITS: UserLimitPolicy = Object.freeze({
  requestsPerMinute: null,
  maxConcurrentRequests: null,
  dailyTokenUnits: null,
  dailyChargeMinorUnits: null,
  chargeCurrency: null,
});

export type UserLimitPatch = Partial<UserLimitPolicy>;

function exactLimit(value: unknown): bigint | null | undefined {
  if (value === null) return null;
  try {
    if (typeof value === 'bigint') return value >= 0n && value <= PG_BIGINT_MAX ? value : undefined;
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 && BigInt(value) <= PG_BIGINT_MAX ? BigInt(value) : undefined;
    }
    if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
      const parsed = BigInt(value);
      return parsed <= PG_BIGINT_MAX ? parsed : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Strictly normalize an operator patch. Absent fields inherit; null stored fields inherit defaults. */
export function normalizeUserLimitPatch(input: unknown): UserLimitPatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('User limits must be an object');
  }
  const source = input as Record<string, unknown>;
  const allowed = new Set([
    'requestsPerMinute',
    'maxConcurrentRequests',
    'dailyTokenUnits',
    'dailyChargeMinorUnits',
    'chargeCurrency',
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new TypeError('Unknown user limit field');
  const result: Record<string, bigint | string | null> = {};
  for (const key of ['requestsPerMinute', 'maxConcurrentRequests', 'dailyTokenUnits', 'dailyChargeMinorUnits']) {
    if (!Object.hasOwn(source, key)) continue;
    const value = exactLimit(source[key]);
    if (value === undefined) throw new TypeError(`Invalid user limit: ${key}`);
    result[key] = value;
  }
  if (Object.hasOwn(source, 'chargeCurrency')) {
    const value = source.chargeCurrency;
    if (value !== null && typeof value !== 'string') throw new TypeError('Invalid user charge currency');
    try {
      result.chargeCurrency = value === null ? null : normalizeCurrency(value);
    } catch {
      throw new TypeError('Invalid user charge currency');
    }
  }
  const charge = Object.hasOwn(source, 'dailyChargeMinorUnits') ? source.dailyChargeMinorUnits : Symbol('inherited');
  const currency = Object.hasOwn(source, 'chargeCurrency') ? source.chargeCurrency : Symbol('inherited');
  if (
    (charge === null && currency !== Symbol('inherited') && currency !== null) ||
    (currency === null && charge !== null)
  ) {
    throw new TypeError('A daily charge ceiling and currency must be configured together');
  }
  return result as UserLimitPatch;
}

/** Per-dimension user override → platform default → unlimited fallback. */
export function resolveUserLimitPolicy(
  defaults: UserLimitPolicy,
  override: UserLimitPolicy | null | undefined,
): UserLimitPolicy {
  if (!override) return defaults;
  const dailyChargeMinorUnits = override.dailyChargeMinorUnits ?? defaults.dailyChargeMinorUnits;
  return {
    requestsPerMinute: override.requestsPerMinute ?? defaults.requestsPerMinute,
    maxConcurrentRequests: override.maxConcurrentRequests ?? defaults.maxConcurrentRequests,
    dailyTokenUnits: override.dailyTokenUnits ?? defaults.dailyTokenUnits,
    dailyChargeMinorUnits,
    chargeCurrency:
      override.dailyChargeMinorUnits !== null && override.chargeCurrency !== null
        ? override.chargeCurrency
        : dailyChargeMinorUnits === null
          ? null
          : defaults.chargeCurrency,
  };
}

export function minimumLimit(left: bigint | null, right: bigint | null): bigint | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

/** Key self-tuning can only tighten a user ceiling, never raise it. */
export function capKeyLimitsByUser(
  key: { readonly requestsPerMinute: bigint; readonly maxConcurrentRequests: bigint },
  user: UserLimitPolicy,
): { readonly requestsPerMinute: bigint; readonly maxConcurrentRequests: bigint } {
  return {
    requestsPerMinute: minimumLimit(key.requestsPerMinute, user.requestsPerMinute) ?? key.requestsPerMinute,
    maxConcurrentRequests:
      minimumLimit(key.maxConcurrentRequests, user.maxConcurrentRequests) ?? key.maxConcurrentRequests,
  };
}

export function userDailyBudgetConfigured(policy: UserLimitPolicy): boolean {
  return policy.dailyTokenUnits !== null || policy.dailyChargeMinorUnits !== null;
}
