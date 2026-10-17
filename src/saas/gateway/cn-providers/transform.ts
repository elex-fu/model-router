/**
 * Batch 3 CN-provider provider-layer compile transform (the
 * ProviderPayloadCompiler `providerRequestTransform` hook's first consumer).
 *
 * The transform runs on the bridge-transformed outbound body, AFTER
 * modelMap resolution (body.model is the provider-resolved model id) and
 * BEFORE payload signing — the only point where the thinking-protocol
 * rewrite can happen without breaking the prepared-evidence payload digest
 * (the transport verifies payloadBytes against evidence.payloadSha256 and
 * can never rewrite the body).
 *
 * Two rules, both scoped to the CN-provider pair and the Anthropic native
 * (an OpenAI-native body carries no `thinking` object — the bridge already
 * dropped it):
 * 1. thinking.type enabled → adaptive for MiniMax M-series (the MiniMax
 *    vocabulary divergence; sub2api NormalizeChineseLLMThinking);
 * 2. thinking blocks are NEVER stripped or reshaped for glm-/minimax-m-
 *    models — those families require verbatim passback (sub2api
 *    thinking_protocol.go); the SaaS compile layer performs no strict
 *    pre-filtering today and this transform must not introduce one.
 */

import { isCnProviderId } from './catalog-identity.js';
import { normalizeChineseLlmThinking, resolveThinkingProtocol } from './thinking.js';

/** The providerRequestTransform input shape (provider-payload-compiler.ts). */
export interface CnProviderRequestTransformInput {
  readonly providerId: string;
  readonly productId: string;
  readonly clientProtocol: string;
  readonly providerProtocol: string;
  readonly providerOperation: string;
  readonly body: Record<string, unknown>;
}

/**
 * Copy-on-write transform: non-CN providers and non-Anthropic natives are
 * returned by reference (byte-identical payload), so the dormant-hook
 * default behavior is preserved for every other provider.
 */
export function cnProvidersProviderRequestTransform(input: CnProviderRequestTransformInput): Record<string, unknown> {
  if (!isCnProviderId(input?.providerId)) return input.body;
  if (input.providerProtocol !== 'anthropic') return input.body;
  const model = typeof input.body?.model === 'string' ? input.body.model : '';
  if (model === '') return input.body;
  // Defense in depth: the rewrite only applies to passback-required models
  // (the minimax-m family); an anthropic-strict model id behind a CN
  // provider alias keeps strict semantics and is left untouched here.
  if (resolveThinkingProtocol(model) !== 'passback-required') return input.body;
  const transformed = normalizeChineseLlmThinking(input.body, model);
  return (isTransformedBody(transformed) ? transformed : input.body);
}

function isTransformedBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
