import type { NormalizedUsage } from './usage.js';

/** User-supplied, versioned reference pricing. Never inferred from a provider website. */
export interface PricingProfile {
  /** Stable profile key. A versionId identifies the immutable definition used for an attempt. */
  id: string;
  versionId?: string;
  versionSequence?: number;
  model: string;
  currency: string;
  inputPerMillion: number | string;
  outputPerMillion: number | string;
  cacheReadPerMillion?: number | string;
  /** Legacy rate for providers that report cache writes without TTL classification. */
  cacheWritePerMillion?: number | string;
  cacheWrite5mPerMillion?: number | string;
  cacheWrite1hPerMillion?: number | string;
  /** Cache-write tokens already included in ordinary input pricing. */
  cacheWriteIncludedInInput?: boolean;
  effectiveFrom?: string;
  upstreamId?: string;
  provider?: string;
}

export interface CostEstimate {
  pricingVersion: string | null;
  currency: string | null;
  costMicros: number | null;
  partial: boolean;
  reason?: string;
}

function scaledRate(value: number | string | undefined): bigint | null {
  if (value === undefined) return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export function estimateCost(usage: NormalizedUsage, profile: PricingProfile | null): CostEstimate {
  if (!profile)
    return { pricingVersion: null, currency: null, costMicros: null, partial: true, reason: 'price_unconfigured' };
  const currency = /^[A-Z]{3}$/.test(profile.currency) ? profile.currency : null;
  const inputRate = scaledRate(profile.inputPerMillion);
  const outputRate = scaledRate(profile.outputPerMillion);
  if (!currency || inputRate === null || outputRate === null) {
    return { pricingVersion: profile.id, currency, costMicros: null, partial: true, reason: 'invalid_price' };
  }
  const pricingVersion = profile.versionId ?? profile.id;
  if (usage.inputTotal === null || usage.outputTotal === null) {
    return { pricingVersion, currency, costMicros: null, partial: true, reason: 'usage_missing' };
  }
  const read = usage.cacheRead;
  const write = usage.cacheWrite;
  const hasCacheWritePricing = profile.cacheWritePerMillion !== undefined ||
    profile.cacheWrite5mPerMillion !== undefined || profile.cacheWrite1hPerMillion !== undefined ||
    profile.cacheWriteIncludedInInput === true;
  if (write === null && hasCacheWritePricing)
    return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_write_unknown' };
  if (read === null && profile.cacheReadPerMillion !== undefined)
    return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_read_unknown' };
  const readCount = read ?? 0;
  const readRate = readCount > 0 ? scaledRate(profile.cacheReadPerMillion) : 0n;
  if (readRate === null)
    return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_price_missing' };

  const inclusive = profile.cacheWriteIncludedInInput ?? false;
  const writeCount = write ?? 0;
  const uncached = usage.inputUncached ?? Math.max(0, usage.inputTotal - readCount - writeCount);
  const ordinaryInput = inclusive ? uncached + writeCount : uncached;
  let writeScaled = 0n;
  if (!inclusive && writeCount > 0) {
    const classified = usage.cacheWrite5m !== null || usage.cacheWrite1h !== null;
    if (classified) {
      if (usage.cacheWrite5m === null || usage.cacheWrite1h === null || usage.cacheWrite5m + usage.cacheWrite1h !== write)
        return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_write_classification_missing' };
      const fiveMinuteRate = usage.cacheWrite5m > 0 ? scaledRate(profile.cacheWrite5mPerMillion) : 0n;
      const oneHourRate = usage.cacheWrite1h > 0 ? scaledRate(profile.cacheWrite1hPerMillion) : 0n;
      if (fiveMinuteRate === null || oneHourRate === null)
        return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_price_missing' };
      writeScaled = BigInt(usage.cacheWrite5m) * fiveMinuteRate + BigInt(usage.cacheWrite1h) * oneHourRate;
    } else if (
      profile.cacheWritePerMillion !== undefined &&
      profile.cacheWrite5mPerMillion === undefined &&
      profile.cacheWrite1hPerMillion === undefined
    ) {
      const aggregateRate = scaledRate(profile.cacheWritePerMillion);
      if (aggregateRate === null)
        return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_price_missing' };
      writeScaled = BigInt(writeCount) * aggregateRate;
    } else {
      return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cache_write_classification_missing' };
    }
  }
  const scaled = BigInt(ordinaryInput) * inputRate + BigInt(readCount) * readRate + writeScaled + BigInt(usage.outputTotal) * outputRate;
  const micros = (scaled + 500_000n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { pricingVersion, currency, costMicros: null, partial: true, reason: 'cost_overflow' };
  }
  return {
    pricingVersion,
    currency,
    costMicros: Number(micros),
    partial:
      usage.status !== 'reported' ||
      usage.cacheRead === null ||
      usage.cacheWrite === null ||
      usage.inputUncached === null,
  };
}

export function selectPrice(
  profiles: PricingProfile[],
  model: string,
  upstreamId: string,
  provider: string,
  atMs: number,
): PricingProfile | null {
  return (
    profiles
      .filter(
        (profile) =>
          profile.model === model &&
          (!profile.upstreamId || profile.upstreamId === upstreamId) &&
          (!profile.provider || profile.provider === provider) &&
          (!profile.effectiveFrom || Date.parse(profile.effectiveFrom) <= atMs),
      )
      .sort(
        (a, b) =>
          (Date.parse(b.effectiveFrom ?? '') || 0) - (Date.parse(a.effectiveFrom ?? '') || 0) ||
          Number(Boolean(b.upstreamId)) - Number(Boolean(a.upstreamId)) ||
          Number(Boolean(b.provider)) - Number(Boolean(a.provider)) ||
          (b.versionSequence ?? 0) - (a.versionSequence ?? 0),
      )[0] ?? null
  );
}
