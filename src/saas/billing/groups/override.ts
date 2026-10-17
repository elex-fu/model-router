import { createHash } from 'node:crypto';
import { normalizeRates } from '../../pricing/calculator.js';
import { isSaasPricingError } from '../../pricing/errors.js';
import type { RateSet, RateSetInput, RationalRate } from '../../pricing/types.js';
import { PER_UNIT_TIERS } from '../../pricing/types.js';
import { SaasBillingGroupsError } from './errors.js';
import type { AppliedModelPricingOverride } from './types.js';

/**
 * Canonical group-level `model_pricing` codec. The JSON shape stored on
 * saas_billing_groups.model_pricing maps a public model id to a full rational
 * rate set:
 *
 * `{ "claude-sonnet-4": { "input": { "num": "3", "den": "1000000" }, ... } }`
 *
 * `num`/`den` are decimal strings so bigints survive JSON round trips. The
 * canonical serialization is metric-order deterministic, which makes the
 * digest stable across processes.
 *
 * 4.1 (#15): `per_unit` and its tier ladder (`per_unit_tiers`) ride the same
 * codec. Both are digest-OPTIONAL with the #14 anti-drift policy — the six
 * legacy metrics keep their explicit null entries while a null per_unit and an
 * absent tier map are omitted — so every override digest computed before 4.1
 * is byte-identical to its recomputation, and a frozen snapshot override
 * parsed back still matches its recorded digest.
 */

const OVERRIDE_METRIC_ORDER = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
] as const;

const OVERRIDE_PER_UNIT_KEYS = ['per_unit', 'per_unit_tiers'] as const;

type OverrideRateJson = { readonly num?: unknown; readonly den?: unknown };

function parseRateJson(value: unknown): { numeratorMinorUnits: string; denominatorUnits: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  const candidate = value as OverrideRateJson;
  for (const part of [candidate.num, candidate.den]) {
    if (typeof part !== 'string' || !/^(0|[1-9][0-9]*)$/.test(part.trim()) || part.trim().length > 30) {
      throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    }
  }
  return { numeratorMinorUnits: (candidate.num as string).trim(), denominatorUnits: (candidate.den as string).trim() };
}

function parsePerUnitTiersJson(value: unknown): RateSetInput['per_unit_tiers'] {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  const tiers: Partial<Record<string, { numeratorMinorUnits: string; denominatorUnits: string }>> = {};
  for (const [tier, rate] of Object.entries(value as Record<string, unknown>)) {
    if (!(PER_UNIT_TIERS as readonly string[]).includes(tier)) {
      throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    }
    const parsed = parseRateJson(rate);
    if (parsed === null) continue;
    tiers[tier] = parsed;
  }
  if (Object.keys(tiers).length === 0) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  return tiers as NonNullable<RateSetInput['per_unit_tiers']>;
}

function parseRateSetJson(value: unknown): RateSetInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (
      !(OVERRIDE_METRIC_ORDER as readonly string[]).includes(key) &&
      !(OVERRIDE_PER_UNIT_KEYS as readonly string[]).includes(key as (typeof OVERRIDE_PER_UNIT_KEYS)[number])
    ) {
      throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    }
  }
  const rates: RateSetInput = {};
  for (const metric of OVERRIDE_METRIC_ORDER) {
    const rate = parseRateJson(candidate[metric]);
    if (rate === null) {
      rates[metric] = null;
      continue;
    }
    rates[metric] = {
      numeratorMinorUnits: rate.numeratorMinorUnits,
      denominatorUnits: rate.denominatorUnits,
    };
  }
  let perUnit: RateSetInput['per_unit'];
  // 4.1: per_unit (nullable pair) and the tier ladder, both optional keys.
  if ('per_unit' in candidate) {
    const rate = parseRateJson(candidate.per_unit);
    perUnit =
      rate === null ? null : { numeratorMinorUnits: rate.numeratorMinorUnits, denominatorUnits: rate.denominatorUnits };
  }
  const perUnitTiers = 'per_unit_tiers' in candidate ? parsePerUnitTiersJson(candidate.per_unit_tiers) : undefined;
  return {
    ...rates,
    ...(perUnit === undefined ? {} : { per_unit: perUnit }),
    ...(perUnitTiers === undefined ? {} : { per_unit_tiers: perUnitTiers }),
  };
}

/** Parses and validates a whole group model_pricing JSON value. */
export function parseModelPricingJson(value: unknown): ReadonlyMap<string, RateSetInput> {
  if (value === null || value === undefined) return new Map();
  if (typeof value === 'string') {
    try {
      return parseModelPricingJson(JSON.parse(value));
    } catch (error) {
      if (error instanceof SaasBillingGroupsError) throw error;
      throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  const entries = new Map<string, RateSetInput>();
  for (const [model, rates] of Object.entries(value as Record<string, unknown>)) {
    if (model.trim().length === 0 || model.length > 255) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    if (entries.has(model)) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    const parsed = parseRateSetJson(rates);
    try {
      // Eager validation: an override that is not a complete rate set is
      // rejected at parse time, not at first use.
      normalizeRates(parsed);
    } catch (error) {
      if (isSaasPricingError(error)) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
      throw error;
    }
    entries.set(model, parsed);
  }
  return entries;
}

function canonicalRatesJson(rates: RateSet): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const metric of OVERRIDE_METRIC_ORDER) {
    const rate = rates[metric];
    canonical[metric] =
      rate === null || rate === undefined
        ? null
        : {
            num: (rate as RationalRate).numeratorMinorUnits.toString(10),
            den: (rate as RationalRate).denominatorUnits.toString(10),
          };
  }
  // 4.1 digest-optional policy: per_unit/tiers appear in the canonical JSON
  // (and therefore the digest) only when they carry a value. An override
  // stored before 4.1 has exactly the six legacy keys and its digest is
  // recomputed byte-identically.
  if (rates.per_unit !== null && rates.per_unit !== undefined) {
    canonical.per_unit = {
      num: rates.per_unit.numeratorMinorUnits.toString(10),
      den: rates.per_unit.denominatorUnits.toString(10),
    };
  }
  if (rates.per_unit_tiers !== null && rates.per_unit_tiers !== undefined) {
    const tiers: Record<string, { num: string; den: string }> = {};
    for (const tier of PER_UNIT_TIERS) {
      const rate = rates.per_unit_tiers[tier];
      if (rate === undefined) continue;
      tiers[tier] = { num: rate.numeratorMinorUnits.toString(10), den: rate.denominatorUnits.toString(10) };
    }
    canonical.per_unit_tiers = tiers;
  }
  return canonical;
}

/** Stable digest of the applied per-model override (model + normalized rates). */
export function modelPricingOverrideDigest(model: string, rates: RateSet): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        model,
        rates: canonicalRatesJson(rates),
      }),
    )
    .digest('hex');
}

/** Resolves the override for one public model, or null when the group has none. */
export function resolveModelPricingOverride(
  modelPricing: ReadonlyMap<string, RateSetInput>,
  publicModelId: string,
): AppliedModelPricingOverride | null {
  const entry = modelPricing.get(publicModelId);
  if (entry === undefined) return null;
  const rates = normalizeRates(entry);
  return { model: publicModelId, rates, digest: modelPricingOverrideDigest(publicModelId, rates) };
}

/** Stored JSON value for the group's `model_pricing` column. */
export function serializeModelPricingJson(value: Readonly<Record<string, RateSetInput>>): string {
  const canonical: Record<string, Record<string, unknown>> = {};
  for (const model of Object.keys(value).sort()) {
    canonical[model] = canonicalRatesJson(normalizeRates(value[model] ?? failOverride()));
  }
  return JSON.stringify(canonical);
}

function failOverride(): never {
  throw new SaasBillingGroupsError('INVALID_OVERRIDE');
}

/** Stored JSON value for the snapshot's `model_pricing_override` column. */
export function serializeAppliedModelPricingOverride(override: AppliedModelPricingOverride): string {
  return JSON.stringify({
    model: override.model,
    rates: canonicalRatesJson(override.rates),
  });
}

/** Parses the snapshot column back into the applied override. */
export function parseAppliedModelPricingOverride(value: unknown): AppliedModelPricingOverride | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return parseAppliedModelPricingOverride(JSON.parse(value));
    } catch (error) {
      if (error instanceof SaasBillingGroupsError) throw error;
      throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  const candidate = value as { model?: unknown; rates?: unknown };
  if (typeof candidate.model !== 'string' || candidate.model.length === 0 || candidate.model.length > 255) {
    throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  }
  const rates = normalizeRates(parseRateSetJson(candidate.rates));
  return { model: candidate.model, rates, digest: modelPricingOverrideDigest(candidate.model, rates) };
}

/** Verifies a stored override still matches its recorded digest (fail closed). */
export function assertAppliedOverrideDigest(override: AppliedModelPricingOverride, digest: string | null): void {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || override.digest !== digest) {
    throw new SaasBillingGroupsError('INVALID_OVERRIDE');
  }
}
