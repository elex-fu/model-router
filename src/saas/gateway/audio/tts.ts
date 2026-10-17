import { normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import type {
  ProviderUsageUpperBoundEstimate,
  ProviderUsageUpperBoundEstimator,
  ProviderUsageUpperBoundEstimatorInput,
} from '../provider-payload-compiler.js';

/**
 * Roadmap batch 4 §4.3 (task #17): standalone TTS audio endpoint
 * (`POST /v1/tts`, the xAI Voice `/tts` HTTP passthrough; sub2api
 * handler/grok_audio.go + service/grok_audio.go estimateGrokVoiceAudioUsage
 * port).
 *
 * The client posts the xAI TTS JSON body (`{model, input, voice, ...}`). The
 * gateway passes it through to the Grok upstream `/tts` path verbatim (model
 * rewritten to the catalog-resolved id) and streams the upstream audio bytes
 * back to the client unchanged. Unlike the search emulation there is no
 * response transformation: TTS returns `audio/*` bytes, so the only
 * gateway-owned fact is the billing observation, which is derived from the
 * request itself — the billable input is exactly the spoken text.
 *
 * Billing (the sub2api "tts" audio mode): million-character pricing on the
 * request's `input` text, counted in runes (Unicode code points —
 * `len([]rune(s))`, never UTF-16 units, so astral characters such as emoji
 * count once). This gateway's per-unit envelope carries the exact rune count
 * as `units` with the canonical `tts` size tier; a per-million price is the
 * tier rate applied per character (a rational rate expresses price/1e6
 * exactly), so admission hold and settlement are both exact — there is no
 * response-side observation to wait for.
 *
 * Boundary (recorded, per the roadmap): STT stays unimplemented this phase
 * (the upstream `/stt` surface only accepts multipart/form-data, and #14
 * keeps every multipart path a precise 501); custom-voices CRUD stays
 * unexposed (it needs GET/PATCH/DELETE method dispatch, and it is unbilled
 * by contract); Realtime WS is a separate roadmap sub-task (§4.3).
 *
 * Everything in this module is pure JSON-in/JSON-out: no I/O, no clock, no
 * randomness.
 */

/** The provider operation id of the TTS passthrough. */
export const TTS_PROVIDER_OPERATION = 'audio.tts';

/** The canonical per-unit size tier of TTS audio billing. */
export const TTS_SIZE_TIER = 'tts';

/**
 * Ceiling on the spoken text (runes). The default body ceiling (1 MiB)
 * already dwarfs it; this bound keeps the billing unit count trivially
 * safe-integer and rejects absurd payloads before dispatch.
 */
export const TTS_MAX_INPUT_RUNES = 65_536;

export const TTS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION = 'tts-usage-upper-bound/v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The primary spoken text of a TTS request body. The xAI Voice API field is
 * `input`; whitespace-only text is not speakable and fails closed (returns
 * null). Unlike the sub2api billing fallback (raw body length when the JSON
 * field is absent), a missing `input` is a structural failure, never a
 * guessed unit count.
 */
export function ttsInputText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const value = body.input;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed;
}

/** Rune count (Unicode code points) — the sub2api `len([]rune(s))` shape. */
export function ttsInputRunes(text: string): number {
  return [...text].length;
}

/**
 * The billable unit count of one TTS request body: the rune count of the
 * trimmed `input`, or null when the body is not a valid TTS request (missing
 * or blank `input`, or input above {@link TTS_MAX_INPUT_RUNES}). Used both
 * at validation (a null fails closed before admission) and at dispatch (the
 * transport re-derives it from the verified payload bytes — the same pure
 * function on the digest-bound body, no out-of-band state crosses dispatch).
 */
export function ttsBillingRunes(body: unknown): number | null {
  const text = ttsInputText(body);
  if (text === null) return null;
  const runes = ttsInputRunes(text);
  if (!Number.isSafeInteger(runes) || runes <= 0 || runes > TTS_MAX_INPUT_RUNES) return null;
  return runes;
}

/**
 * §4.3 TTS billing: the admission hold is exact (the billable input is the
 * request's spoken text, known in full before dispatch) — the per-unit upper
 * bound equals the settlement unit count, with the fixed `tts` tier and no
 * token counters.
 */
export class TtsUsageUpperBoundEstimator implements ProviderUsageUpperBoundEstimator {
  readonly version = TTS_USAGE_UPPER_BOUND_ESTIMATOR_VERSION;

  estimate(input: ProviderUsageUpperBoundEstimatorInput): ProviderUsageUpperBoundEstimate {
    const operation = input.normalizedRequest.providerOperation as string;
    if (operation !== TTS_PROVIDER_OPERATION) {
      // Miscomposition is a closed failure, never a silently wrong bound.
      throw new Error('the tts estimator only serves the audio.tts operation');
    }
    const runes = ttsBillingRunes(input.normalizedRequest.body);
    if (runes === null) {
      throw new Error('the tts estimator requires a non-empty input within the rune ceiling');
    }
    return {
      inputTotalUpperBound: '0',
      inputUncachedUpperBound: '0',
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '0',
      reasoningOutputUpperBound: '0',
      feasibleInputBuckets: ['input'],
      // Characters are the billable unit; the tts tier rate is per character
      // (a per-million price is rate = price/1e6 as a rational rate).
      perUnitUnitsUpperBound: String(runes),
      sizeTier: TTS_SIZE_TIER,
    };
  }
}

export function createTtsUsageUpperBoundEstimator(): TtsUsageUpperBoundEstimator {
  return new TtsUsageUpperBoundEstimator();
}

/**
 * The settlement-side observed usage of one completed TTS call: the audio
 * billing mode with the exact character count on the `tts` tier. The
 * observation derives from the verified request payload (the response is
 * opaque audio bytes), so it settles as soon as the upstream 2xx is
 * confirmed — the same per-request/attempt settlement identity the search
 * operations rely on (the sub2api `tts:<uuid>` durable id analog: unique per
 * HTTP call by construction, never derived from the spoken text).
 */
export function observedTtsUsage(runes: number): NormalSuccessObservedUsage {
  const usage = normalizeUsage('openai', {
    billing_mode: 'audio',
    units: runes,
    size_tier: TTS_SIZE_TIER,
  });
  if (usage.status !== 'reported') {
    throw new Error('tts usage is incomplete');
  }
  return Object.freeze({ ...usage, source: 'upstream' });
}
