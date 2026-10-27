import { createHash } from 'node:crypto';
import { parseMinorUnits } from '../../billing/money.js';
import { calculatePriceVersion } from '../../pricing/calculator.js';
import type { CustomerPriceVersionRecord, TokenUsageInput } from '../../pricing/types.js';

/** Canonical JSON preserves bigint exactly and rejects non-JSON authority facts. */
export function fastJournalCanonicalJson(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    throw new Error('FAST_JOURNAL_INVALID_JSON');
  }
  return JSON.stringify(canonical(value));
}
export function fastJournalDigest(value: unknown): string {
  return createHash('sha256').update(fastJournalCanonicalJson(value)).digest('hex');
}
/** Frozen customer price; no current-price lookup can change a receipt's bill. */
export function calculateFastReceiptCharge(snapshot: unknown, usage: Readonly<Record<string, string | null>>): bigint {
  if (snapshot === null) return 0n;
  const price = validatePriceSnapshot(snapshot);
  const input = usage.inputTotal;
  const output = usage.outputTotal;
  if (input === null || input === undefined || output === null || output === undefined)
    throw new Error('FAST_JOURNAL_INCOMPLETE_USAGE');
  parseMinorUnits(input, { allowZero: true });
  parseMinorUnits(output, { allowZero: true });
  if (usage.perUnitUnits !== undefined && usage.perUnitUnits !== null && usage.perUnitUnits !== '0') {
    throw new Error('FAST_JOURNAL_UNSUPPORTED_USAGE');
  }
  const count = (key: string): bigint | null =>
    usage[key] == null ? null : parseMinorUnits(usage[key], { allowZero: true });
  const genericWrite = count('cacheWrite');
  const write5m = count('cacheWrite5m');
  const write1h = count('cacheWrite1h');
  const detailedWrite = (write5m ?? 0n) + (write1h ?? 0n);
  if (genericWrite !== null && genericWrite > 0n && detailedWrite > 0n && genericWrite !== detailedWrite) {
    throw new Error('FAST_JOURNAL_INCONSISTENT_USAGE');
  }
  // Provider observations may carry both an aggregate cache-write total and
  // TTL subsets. The existing calculator intentionally accepts only one price
  // family; retain the subsets and do not bill or bound the aggregate twice.
  const normalized: TokenUsageInput = {
    inputTotal: input,
    inputUncached: usage.inputUncached ?? null,
    outputTotal: output,
    cacheRead: usage.cacheRead ?? null,
    cacheWrite: detailedWrite > 0n ? '0' : (usage.cacheWrite ?? null),
    cacheWrite5m: usage.cacheWrite5m ?? null,
    cacheWrite1h: usage.cacheWrite1h ?? null,
    reasoningOutput: usage.reasoningOutput ?? null,
  };
  if (['inputUncached', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'].some((key) => usage[key] != null)) {
    const total =
      (count('inputUncached') ?? 0n) +
      (count('cacheRead') ?? 0n) +
      (detailedWrite > 0n ? detailedWrite : (genericWrite ?? 0n));
    if (total !== BigInt(input)) throw new Error('FAST_JOURNAL_INCONSISTENT_USAGE');
  }
  if (BigInt(input) > BigInt(price.maxInputTokens) || BigInt(output) > BigInt(price.maxOutputTokens))
    throw new Error('FAST_JOURNAL_USAGE_EXCEEDS_BOUND');
  const calculation = calculatePriceVersion(price.customerPrice, normalized, { requireComplete: false });
  if (!calculation.complete) throw new Error('FAST_JOURNAL_INCOMPLETE_USAGE');
  return calculation.amountMinorUnits;
}

export interface FastPriceSnapshot {
  readonly schemaVersion: 1;
  readonly customerPrice: CustomerPriceVersionRecord;
  readonly maxInputTokens: string;
  readonly maxOutputTokens: string;
}
export function validatePriceSnapshot(snapshot: unknown): FastPriceSnapshot {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('FAST_JOURNAL_INVALID_PRICE');
  const price = snapshot as FastPriceSnapshot;
  if (
    price.schemaVersion !== 1 ||
    !price.customerPrice ||
    price.customerPrice.kind !== 'customer' ||
    price.customerPrice.tokenMultipliers !== null
  )
    throw new Error('FAST_JOURNAL_INVALID_PRICE');
  parseMinorUnits(price.maxInputTokens, { allowZero: true });
  parseMinorUnits(price.maxOutputTokens, { allowZero: true });
  return price;
}
