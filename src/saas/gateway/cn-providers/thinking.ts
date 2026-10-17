/**
 * Batch 3 CN-provider thinking-protocol compatibility (sub2api reference:
 * backend/internal/service/thinking_protocol.go ResolveThinkingProtocol +
 * gateway_request.go NormalizeChineseLLMThinking). Pure functions only.
 *
 * The thinking-block contract is INVERTED between protocol families:
 * - Anthropic official semantics (anthropic-strict): a historical thinking
 *   block must carry a valid signature; a missing/invalid signature must be
 *   stripped before forwarding and a signature 400 triggers the rectifier
 *   retry;
 * - third-party Anthropic-compatible upstreams (passback-required): the
 *   glm- / minimax-m- families REQUIRE historical thinking blocks to be
 *   passed back verbatim — pre-filtering them breaks the contract with a
 *   400 ("The content[].thinking in the thinking mode must be passed back
 *   to the API").
 *
 * The SaaS compile layer performs NO thinking-block pre-filtering today, so
 * passback-required models are safe by default; the classification table
 * below exists so any future strict pre-filter/rectifier (the claude-prefix
 * path) is gated on `shouldPreFilterThinkingBlocks` and can never fire on a
 * CN-provider model.
 *
 * Additionally MiniMax M-series accepts only `thinking.type` of "adaptive"
 * or "disabled" on its Anthropic-compatible endpoint: Anthropic SDK clients
 * default to "enabled" (the Anthropic-original spelling), which MiniMax
 * rejects or ignores. `normalizeChineseLlmThinking` rewrites enabled→
 * adaptive for minimax-m models — the only rewrite; Kimi/GLM/DeepSeek accept
 * "enabled" as-is and are intentional no-ops.
 */

/** The thinking-block protocol family one model belongs to. */
export type CnThinkingProtocol = 'anthropic-strict' | 'passback-required' | 'unknown';

/** Passback-required vendor prefixes (sub2api ResolveThinkingProtocol, priority order). */
const PASSBACK_REQUIRED_PREFIXES: readonly string[] = Object.freeze([
  'deepseek-',
  'kimi-',
  'moonshot-',
  'glm-',
  'minimax-m',
]);

/** Passback-required bare Kimi Code aliases (exact match, no vendor prefix). */
const PASSBACK_REQUIRED_EXACT: ReadonlySet<string> = new Set(['k3', 'k3-256k']);

/** Anthropic-strict vendor prefixes. */
const ANTHROPIC_STRICT_PREFIXES: readonly string[] = Object.freeze(['claude-', 'opus-', 'sonnet-', 'haiku-']);

/**
 * Resolves the thinking protocol family for one model id (the prefix
 * classification table). Matching is case-insensitive on the trimmed id;
 * passback-required prefixes match before strict prefixes so a misnamed
 * `claude-` alias of a CN model cannot win.
 */
export function resolveThinkingProtocol(modelId: string): CnThinkingProtocol {
  if (typeof modelId !== 'string' || modelId.trim() === '') return 'unknown';
  const id = modelId.trim().toLowerCase();
  if (PASSBACK_REQUIRED_EXACT.has(id)) return 'passback-required';
  for (const prefix of PASSBACK_REQUIRED_PREFIXES) {
    if (id.startsWith(prefix)) return 'passback-required';
  }
  // Qwen thinking variants: qwen* prefix + "-thinking" anywhere.
  if ((id.startsWith('qwen-') || id.startsWith('qwen2-') || id.startsWith('qwen3-') || id.startsWith('qwen4-')) && id.includes('-thinking')) {
    return 'passback-required';
  }
  for (const prefix of ANTHROPIC_STRICT_PREFIXES) {
    if (id.startsWith(prefix)) return 'anthropic-strict';
  }
  return 'unknown';
}

/**
 * Whether a strict thinking-block pre-filter (strip invalid-signature
 * blocks) / signature rectifier may run for this model. Only
 * anthropic-strict models; passback-required and unknown stay untouched
 * (keeping the block is always the safer side for non-Anthropic upstreams).
 */
export function shouldPreFilterThinkingBlocks(modelId: string): boolean {
  return resolveThinkingProtocol(modelId) === 'anthropic-strict';
}

/** Whether a thinking-signature 400 should trigger the rectifier retry. */
export function shouldRectifyThinkingSignatureError(modelId: string): boolean {
  return resolveThinkingProtocol(modelId) === 'anthropic-strict';
}

/** True for MiniMax M-series models (the thinking.type rewrite audience). */
export function isMiniMaxMSeriesModel(modelId: string): boolean {
  return typeof modelId === 'string' && modelId.trim().toLowerCase().startsWith('minimax-m');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrites the top-level `thinking` object for Chinese-LLM providers with a
 * divergent `thinking.type` vocabulary (the sub2api
 * NormalizeChineseLLMThinking port). Currently scoped to MiniMax M-series
 * (thinking.type accepts only "adaptive" | "disabled"; SDK clients default
 * to "enabled"): enabled → adaptive. Copy-on-write: an unchanged body is
 * returned by reference.
 *
 * Caller contract: the Anthropic-native compile path, AFTER any (future)
 * strict block filter and BEFORE payload signing — only for
 * passback-required models (glm-/minimax-m- families).
 */
export function normalizeChineseLlmThinking(body: unknown, mappedModel: string): unknown {
  if (!isMiniMaxMSeriesModel(mappedModel)) return body;
  if (!isPlainRecord(body)) return body;
  const thinking = body.thinking;
  if (!isPlainRecord(thinking)) return body;
  if (thinking.type !== 'enabled') return body;
  return { ...body, thinking: { ...thinking, type: 'adaptive' } };
}
