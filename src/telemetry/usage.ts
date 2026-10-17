/**
 * §4.1 (roadmap batch 4, task #15) multimodal billing dimensions.
 *
 * `billingMode` classifies the request's metering kind — token (the default;
 * every pre-4.1 request), per_request, image, video, or audio. `units` is the
 * billable unit count (images, seconds, characters, …) and `sizeTier` is the
 * canonical per-unit size tier (image 1k/2k/4k, video 480p/720p/1080p, audio
 * tts/stt/realtime).
 *
 * Anti-drift: consumers that digest usage (usage-event canonical form,
 * normal-success usage evidence) treat the three fields as digest-optional —
 * a token-only usage object carries no media fields in its digest material,
 * so every digest computed before 4.1 is byte-identical to its recomputation.
 */
export type UsageBillingMode = 'token' | 'per_request' | 'image' | 'video' | 'audio';

export const USAGE_BILLING_MODES: readonly UsageBillingMode[] = [
  'token',
  'per_request',
  'image',
  'video',
  'audio',
] as const;

/** Canonical per-unit size tiers; must stay in lockstep with pricing PER_UNIT_TIERS. */
export const USAGE_SIZE_TIERS = ['1k', '2k', '4k', '480p', '720p', '1080p', 'tts', 'stt', 'realtime'] as const;

export type UsageSizeTier = (typeof USAGE_SIZE_TIERS)[number];

export interface NormalizedUsage {
  inputTotal: number | null;
  inputUncached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  outputTotal: number | null;
  reasoningOutput: number | null;
  /** Metering kind of the request; defaults to 'token' (the pre-4.1 shape). */
  billingMode: UsageBillingMode;
  /** Billable unit count for non-token modes; null on token-only usage. */
  units: number | null;
  /** Canonical per-unit size tier; null on token-only or untiered usage. */
  sizeTier: UsageSizeTier | null;
  status: 'reported' | 'partial' | 'missing' | 'estimated';
  source: 'upstream' | 'local-estimate' | 'legacy';
  semanticsVersion: string;
}

export type UsageProtocol = 'openai' | 'responses' | 'anthropic' | 'gemini';
export interface UsageOptions {
  provider?: 'kimi' | 'deepseek' | 'custom';
  /** Set only when an Anthropic-compatible provider reports input_tokens inclusive of cache tokens. */
  inputIncludesCache?: boolean;
  estimated?: boolean;
}

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => (value && typeof value === 'object' ? (value as Fields) : {});
const token = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Parses a media usage dimension from an upstream usage object. The
 * per-unit counters appear under several provider spellings (`units`,
 * `images`, `seconds`, `duration`, `characters`, `chars`, `audio_seconds`);
 * the first safe-integer match wins. Returns null when no counter is present
 * — the request then settles on its token counters alone.
 */
function mediaUnits(u: Fields): number | null {
  for (const key of ['units', 'images', 'seconds', 'duration', 'characters', 'chars', 'audio_seconds']) {
    const value = token(u[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Parses the canonical size tier from an upstream usage/response object.
 * Accepts `size_tier`/`sizeTier` directly (a canonical tier from a category
 * transport) or maps common provider `size`/`resolution` spellings onto the
 * registry (longest edge buckets: ≤1024 → 1k, ≤1792 → 2k, else 4k; explicit
 * resolution strings like 720p pass through when canonical).
 */
export function normalizeMediaSizeTier(raw: unknown): UsageSizeTier | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = raw.trim().toLowerCase();
  if ((USAGE_SIZE_TIERS as readonly string[]).includes(value)) return value as UsageSizeTier;
  const resolution = /^(\d{3,4})p$/.exec(value);
  if (resolution) {
    const tier = `${resolution[1]}p`;
    if ((USAGE_SIZE_TIERS as readonly string[]).includes(tier)) return tier as UsageSizeTier;
    return null;
  }
  const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (dimensions) {
    const longest = Math.max(Number(dimensions[1]), Number(dimensions[2]));
    if (longest <= 1024) return '1k';
    if (longest <= 1792) return '2k';
    return '4k';
  }
  return null;
}

/** Classifies the billing mode from the observed usage counters and media hints. */
export function usageBillingMode(raw: unknown, units: number | null): UsageBillingMode {
  const u = object(raw);
  const declared = u.billing_mode ?? u.billingMode;
  if (typeof declared === 'string') {
    const value = declared.trim().toLowerCase();
    if ((USAGE_BILLING_MODES as readonly string[]).includes(value)) return value as UsageBillingMode;
  }
  if (u.images !== undefined || u.image_count !== undefined) return 'image';
  if (units !== null && (u.seconds !== undefined || u.duration !== undefined || u.audio_seconds !== undefined)) {
    return 'audio';
  }
  if (units !== null && (u.resolution !== undefined || u.video_seconds !== undefined)) return 'video';
  return 'token';
}

/** Accepts the upstream usage object, never a converted client response. */
export function normalizeUsage(protocol: UsageProtocol, raw: unknown, options: UsageOptions = {}): NormalizedUsage {
  const u = object(raw);
  const empty: NormalizedUsage = {
    inputTotal: null,
    inputUncached: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: null,
    reasoningOutput: null,
    // §4.1 media dimensions: absent counters keep the token-only shape.
    billingMode: 'token',
    units: null,
    sizeTier: null,
    status: 'missing',
    source: options.estimated ? 'local-estimate' : 'upstream',
    semanticsVersion: 'v1',
  };
  let inconsistentDetails = false;
  if (protocol === 'anthropic') {
    const input = token(u.input_tokens);
    const read = token(u.cache_read_input_tokens);
    const write = token(u.cache_creation_input_tokens);
    const details = object(u.cache_creation);
    empty.cacheRead = read;
    empty.cacheWrite = write;
    empty.cacheWrite5m = token(details.ephemeral_5m_input_tokens);
    empty.cacheWrite1h = token(details.ephemeral_1h_input_tokens);
    empty.outputTotal = token(u.output_tokens);
    empty.inputTotal = input === null ? null : options.inputIncludesCache ? input : input + (read ?? 0) + (write ?? 0);
    empty.inputUncached =
      input === null
        ? null
        : options.inputIncludesCache
          ? read === null && write === null
            ? null
            : Math.max(0, input - (read ?? 0) - (write ?? 0))
          : input;
  } else if (protocol === 'gemini') {
    empty.inputTotal = token(u.promptTokenCount);
    empty.outputTotal = token(u.candidatesTokenCount);
    empty.cacheRead = token(u.cachedContentTokenCount);
  } else {
    const responses = protocol === 'responses';
    empty.inputTotal = token(responses ? u.input_tokens : u.prompt_tokens);
    empty.outputTotal = token(responses ? u.output_tokens : u.completion_tokens);
    const inputDetails = object(responses ? u.input_tokens_details : u.prompt_tokens_details);
    const outputDetails = object(responses ? u.output_tokens_details : u.completion_tokens_details);
    empty.cacheRead =
      options.provider === 'deepseek' && !responses
        ? token(u.prompt_cache_hit_tokens)
        : (token(inputDetails.cached_tokens) ?? token(u.cached_tokens));
    empty.inputUncached =
      options.provider === 'deepseek' && !responses
        ? token(u.prompt_cache_miss_tokens)
        : empty.inputTotal === null || empty.cacheRead === null
          ? null
          : Math.max(0, empty.inputTotal - empty.cacheRead);
    empty.reasoningOutput = token(outputDetails.reasoning_tokens);
    if (
      options.provider === 'deepseek' &&
      empty.inputTotal !== null &&
      empty.cacheRead !== null &&
      empty.inputUncached !== null &&
      empty.cacheRead + empty.inputUncached !== empty.inputTotal
    ) {
      empty.inputUncached = null;
      inconsistentDetails = true;
    }
  }
  const core = [empty.inputTotal, empty.outputTotal];
  // §4.1: media counters participate in completeness — a media report with
  // no token counters is 'reported' when its unit count is present.
  const observedUnits = mediaUnits(u);
  empty.units = observedUnits;
  empty.sizeTier = normalizeMediaSizeTier(u.size_tier ?? u.sizeTier ?? u.size ?? u.resolution);
  empty.billingMode = usageBillingMode(u, observedUnits);
  const mediaComplete = empty.billingMode !== 'token' && observedUnits !== null;
  empty.status = mediaComplete
    ? 'reported'
    : core.every((n) => n !== null)
      ? 'reported'
      : core.some((n) => n !== null) || empty.cacheRead !== null || empty.cacheWrite !== null
        ? 'partial'
        : 'missing';
  if (inconsistentDetails) empty.status = 'partial';
  if (options.estimated && empty.status !== 'missing') empty.status = 'estimated';
  return empty;
}

export function confirmedTokens(usage: NormalizedUsage): number | null {
  return usage.inputTotal === null || usage.outputTotal === null ? null : usage.inputTotal + usage.outputTotal;
}
