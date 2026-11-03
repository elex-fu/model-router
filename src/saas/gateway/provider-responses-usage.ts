import { type NormalizedUsage, normalizeUsage } from '../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from './dispatch-usage-settlement.js';

type UsageRecord = Record<string, unknown>;

function record(value: unknown): UsageRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UsageRecord) : null;
}

function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The generic `/v1/responses` usage counter contract, shared byte-for-byte
 * between the JSON body observer and the SSE event observer: `input_tokens`
 * and `output_tokens` are required; `total_tokens`/`cached_tokens` are
 * optional; the cached read decomposes through
 * `input_tokens_details.cached_tokens` and reasoning output through
 * `output_tokens_details.reasoning_tokens`. Any other counter name, a
 * non-token value, or an inconsistent aggregate invalidates the whole report
 * (never zero-bills). Both observers accept the exact same usage shape, so a
 * streaming and a non-streaming response of identical counters settle
 * identically.
 */
export function trustedResponsesUsage(value: unknown): NormalSuccessObservedUsage | null {
  const raw = record(value);
  if (raw === null) return null;
  const allowedNames = [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cached_tokens',
    'input_tokens_details',
    'output_tokens_details',
  ];
  if (Object.keys(raw).some((name) => !allowedNames.includes(name))) return null;
  if (!token(raw.input_tokens) || !token(raw.output_tokens)) return null;
  if (Object.hasOwn(raw, 'total_tokens') && !token(raw.total_tokens)) return null;
  if (Object.hasOwn(raw, 'cached_tokens') && !token(raw.cached_tokens)) return null;

  const hasInputDetails = Object.hasOwn(raw, 'input_tokens_details');
  const inputDetails = hasInputDetails ? record(raw.input_tokens_details) : null;
  if (hasInputDetails && inputDetails === null) return null;
  const hasOutputDetails = Object.hasOwn(raw, 'output_tokens_details');
  const outputDetails = hasOutputDetails ? record(raw.output_tokens_details) : null;
  if (hasOutputDetails && outputDetails === null) return null;
  const detailAllowed = (details: UsageRecord, allowed: readonly string[]): boolean =>
    Object.entries(details).every(([name, counter]) => allowed.includes(name) && token(counter));
  if (inputDetails !== null && !detailAllowed(inputDetails, ['cached_tokens'])) return null;
  if (outputDetails !== null && !detailAllowed(outputDetails, ['reasoning_tokens'])) return null;

  const inputTotal = raw.input_tokens;
  const outputTotal = raw.output_tokens;
  const total = inputTotal + outputTotal;
  if (!Number.isSafeInteger(total)) return null;
  if (Object.hasOwn(raw, 'total_tokens') && raw.total_tokens !== total) return null;
  if (inputDetails !== null && Object.hasOwn(inputDetails, 'cached_tokens') && Object.hasOwn(raw, 'cached_tokens')) {
    if (inputDetails.cached_tokens !== raw.cached_tokens) return null;
  }

  const usage: NormalizedUsage = normalizeUsage('responses', raw);
  if (usage.status !== 'reported' || usage.inputTotal === null || usage.outputTotal === null) return null;
  for (const name of [
    'inputTotal',
    'inputUncached',
    'cacheRead',
    'cacheWrite',
    'cacheWrite5m',
    'cacheWrite1h',
    'outputTotal',
    'reasoningOutput',
  ] as const) {
    if (usage[name] !== null && !token(usage[name])) return null;
  }
  if ((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.inputTotal) return null;
  if ((usage.reasoningOutput ?? 0) > usage.outputTotal) return null;
  return Object.freeze({ ...usage, source: 'upstream' });
}
