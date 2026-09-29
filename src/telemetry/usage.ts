export interface NormalizedUsage {
  inputTotal: number | null;
  inputUncached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  outputTotal: number | null;
  reasoningOutput: number | null;
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
  empty.status = core.every((n) => n !== null)
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
