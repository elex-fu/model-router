import type { Protocol } from '../config/types.js';

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

const token = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function normalizeUsage(protocol: Protocol, body: any): NormalizedUsage {
  const u = body?.usage;
  if (!u || typeof u !== 'object') return {};
  if (protocol === 'anthropic') {
    const plain = token(u.input_tokens);
    const read = token(u.cache_read_input_tokens);
    const creation = token(u.cache_creation_input_tokens);
    return {
      inputTokens:
        plain === undefined && read === undefined && creation === undefined
          ? undefined
          : (plain ?? 0) + (read ?? 0) + (creation ?? 0),
      outputTokens: token(u.output_tokens),
      cacheReadTokens: read,
      cacheCreationTokens: creation,
    };
  }
  if (protocol === 'responses')
    return {
      inputTokens: token(u.input_tokens),
      outputTokens: token(u.output_tokens),
      cacheReadTokens: token(u.input_tokens_details?.cached_tokens),
    };
  if (protocol === 'gemini')
    return {
      inputTokens: token(body.usageMetadata?.promptTokenCount),
      outputTokens: token(body.usageMetadata?.candidatesTokenCount),
    };
  return {
    inputTokens: token(u.prompt_tokens),
    outputTokens: token(u.completion_tokens),
    cacheReadTokens: token(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens),
  };
}
