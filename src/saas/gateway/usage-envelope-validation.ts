import type { PreparedRequestUsageEnvelope } from './prepared-request-evidence-service.js';

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const INTEGER_FIELDS = [
  'inputTotalUpperBound',
  'inputUncachedUpperBound',
  'cacheReadUpperBound',
  'cacheWriteUpperBound',
  'cacheWrite5mUpperBound',
  'cacheWrite1hUpperBound',
  'outputTotalUpperBound',
  'reasoningOutputUpperBound',
] as const;
const INPUT_BUCKETS = new Set(['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']);
const PER_UNIT_TIERS = new Set(['1k', '2k', '4k', '480p', '720p', '1080p', 'tts', 'stt', 'realtime']);

export type UsageEnvelopeValidationResult =
  | { readonly ok: true; readonly value: PreparedRequestUsageEnvelope }
  | { readonly ok: false; readonly path: string; readonly reason: string };

function invalid(path: string, reason: string): UsageEnvelopeValidationResult {
  return { ok: false, path, reason };
}

function exactNonNegative(value: unknown): { ok: true; value: bigint } | { ok: false } {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)) parsed = BigInt(value);
    else return { ok: false };
  } catch {
    return { ok: false };
  }
  return parsed >= 0n && parsed <= MAX_POSTGRES_BIGINT ? { ok: true, value: parsed } : { ok: false };
}

/**
 * The single semantic contract for server-owned usage bounds. It never mutates
 * the estimator, compiler, preparation, or ledger input and returns canonical
 * decimal strings. Optional media fields stay absent when not supplied so the
 * pre-media signed-envelope representation remains byte-compatible.
 */
export function validatePreparedRequestUsageEnvelope(value: unknown): UsageEnvelopeValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('usage', 'usage bounds must be an object');
  }
  const usage = value as Record<string, unknown>;
  const normalized = new Map<(typeof INTEGER_FIELDS)[number], bigint>();
  for (const field of INTEGER_FIELDS) {
    const parsed = exactNonNegative(usage[field]);
    if (!parsed.ok) return invalid(field, 'bound must be a canonical non-negative integer');
    normalized.set(field, parsed.value);
  }
  const at = (field: (typeof INTEGER_FIELDS)[number]): bigint => normalized.get(field) as bigint;
  const inputTotal = at('inputTotalUpperBound');
  for (const field of [
    'inputUncachedUpperBound',
    'cacheReadUpperBound',
    'cacheWriteUpperBound',
    'cacheWrite5mUpperBound',
    'cacheWrite1hUpperBound',
  ] as const) {
    if (at(field) > inputTotal) return invalid(field, 'input component exceeds inputTotalUpperBound');
  }
  if (at('reasoningOutputUpperBound') > at('outputTotalUpperBound')) {
    return invalid('reasoningOutputUpperBound', 'reasoning output exceeds outputTotalUpperBound');
  }

  const buckets = usage.feasibleInputBuckets;
  if (
    !Array.isArray(buckets) ||
    buckets.length === 0 ||
    new Set(buckets).size !== buckets.length ||
    buckets.some((bucket) => typeof bucket !== 'string' || !INPUT_BUCKETS.has(bucket))
  ) {
    return invalid('feasibleInputBuckets', 'feasible input buckets must be unique supported values');
  }

  const perUnitRaw = usage.perUnitUnitsUpperBound;
  const hasPerUnit = perUnitRaw !== undefined && perUnitRaw !== null;
  const sizeTier = usage.sizeTier;
  if (!hasPerUnit && sizeTier !== undefined && sizeTier !== null) {
    return invalid('sizeTier', 'a size tier requires a per-unit upper bound');
  }
  let perUnit: bigint | undefined;
  if (hasPerUnit) {
    const parsed = exactNonNegative(perUnitRaw);
    if (!parsed.ok) return invalid('perUnitUnitsUpperBound', 'per-unit bound must be a non-negative integer');
    perUnit = parsed.value;
  }
  if (sizeTier !== undefined && sizeTier !== null && (typeof sizeTier !== 'string' || !PER_UNIT_TIERS.has(sizeTier))) {
    return invalid('sizeTier', 'size tier is not in the supported registry');
  }

  const decimal = (field: (typeof INTEGER_FIELDS)[number]): string => at(field).toString(10);
  return {
    ok: true,
    value: {
      inputTotalUpperBound: decimal('inputTotalUpperBound'),
      inputUncachedUpperBound: decimal('inputUncachedUpperBound'),
      cacheReadUpperBound: decimal('cacheReadUpperBound'),
      cacheWriteUpperBound: decimal('cacheWriteUpperBound'),
      cacheWrite5mUpperBound: decimal('cacheWrite5mUpperBound'),
      cacheWrite1hUpperBound: decimal('cacheWrite1hUpperBound'),
      outputTotalUpperBound: decimal('outputTotalUpperBound'),
      reasoningOutputUpperBound: decimal('reasoningOutputUpperBound'),
      feasibleInputBuckets: [...buckets],
      ...(hasPerUnit
        ? {
            perUnitUnitsUpperBound: (perUnit as bigint).toString(10),
            ...(sizeTier !== undefined && sizeTier !== null ? { sizeTier } : {}),
          }
        : {}),
    },
  };
}
