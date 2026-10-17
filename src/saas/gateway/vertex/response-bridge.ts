/**
 * Batch-3 Vertex response/usage bridge. Vertex answers BOTH endpoint
 * families with their native response shapes — Anthropic on Vertex
 * `rawPredict` returns Anthropic Messages bodies/SSE (no bridging needed;
 * the gateway's generic Anthropic usage observers read it unchanged), and
 * Gemini on Vertex returns bare GenerateContentResponse chunks whose
 * usageMetadata carries the token accounting. The Gemini-side usage
 * vocabulary is the F4 gemini package's (the shapes are identical Google
 * `usageMetadata` objects); this module re-exports it and maps it onto the
 * gateway's observed-usage contract. The Code Assist `{response: {...}}`
 * unwrap is NOT applied: aiplatform never wraps.
 */

import { normalizeUsage } from '../../../telemetry/usage.js';
import type { NormalSuccessObservedUsage } from '../dispatch-usage-settlement.js';
import { type GeminiUsageMetadata, mergeGeminiUsageMetadata, parseGeminiUsageMetadata } from '../gemini/quota-usage.js';
import type { GeminiResponseUsage } from '../gemini/response-bridge.js';
import { geminiUsageFromMetadata } from '../gemini/response-bridge.js';

export type VertexResponseUsage = GeminiResponseUsage;

export type { GeminiUsageMetadata };
export { geminiUsageFromMetadata, mergeGeminiUsageMetadata, parseGeminiUsageMetadata };

/** Parses a bare GenerateContentResponse chunk's usageMetadata (Vertex never wraps). */
export function parseVertexGeminiChunkUsage(chunk: Record<string, unknown>): VertexResponseUsage | null {
  return geminiUsageFromMetadata(parseGeminiUsageMetadata(chunk.usageMetadata));
}

/**
 * Normalized Gemini-on-Vertex usage → the gateway's observed-usage contract.
 * The gemini vocabulary applies the sub2api cache split (promptTokenCount
 * includes cachedContentTokenCount), so the prompt total is reconstructed
 * before the shared gemini normalizer runs — the same math as the F4
 * transport's `geminiUsageToObservedUsage`.
 */
export function vertexUsageToObservedUsage(usage: VertexResponseUsage): NormalSuccessObservedUsage | null {
  const normalized = normalizeUsage('gemini', {
    promptTokenCount: usage.inputTokens === null ? undefined : usage.inputTokens + (usage.cacheReadTokens ?? 0),
    candidatesTokenCount: usage.outputTokens ?? undefined,
    cachedContentTokenCount: usage.cacheReadTokens ?? undefined,
  });
  if (normalized.status !== 'reported' || normalized.inputTotal === null || normalized.outputTotal === null) {
    return null;
  }
  return Object.freeze({ ...normalized, source: 'upstream' });
}
