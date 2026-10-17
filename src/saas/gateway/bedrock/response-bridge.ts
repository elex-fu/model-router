/**
 * Batch-3 Bedrock response bridging (port of sub2api's
 * transformBedrockInvocationMetrics and the chunk-extraction halves of
 * bedrock_stream.go): pure conversions from the Bedrock InvokeModel
 * response vocabulary onto the standard Anthropic shapes the gateway and
 * its usage observers already speak.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the Anthropic SSE event JSON from one Bedrock EventStream chunk
 * payload (sub2api extractBedrockChunkData): the payload is
 * `{"bytes":"<base64>"}` and the decoded bytes are the event JSON.
 * Returns null when the payload carries no parsable `bytes`.
 */
export function extractBedrockChunkData(payload: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(payload));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const encoded = parsed.bytes;
  if (typeof encoded !== 'string' || encoded === '') return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  try {
    const event: unknown = JSON.parse(decoded.toString('utf8'));
    return isRecord(event) ? event : null;
  } catch {
    return null;
  }
}

export interface BedrockObservedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Converts the Bedrock-specific `amazon-bedrock-invocationMetrics` field to
 * the standard Anthropic `usage` shape and removes it so it never passes
 * through to the client (sub2api transformBedrockInvocationMetrics). An
 * existing `usage` field is never overwritten. Copy-on-write.
 */
export function transformBedrockInvocationMetrics<T extends Record<string, unknown>>(body: T): T {
  const metrics = body['amazon-bedrock-invocationMetrics'];
  if (!isRecord(metrics)) return body;
  const next: Record<string, unknown> = { ...body };
  delete next['amazon-bedrock-invocationMetrics'];
  if (isRecord(next.usage)) return next as T;
  const usage: Record<string, unknown> = {};
  const inputTokens = nonNegativeInt(metrics.inputTokenCount);
  const outputTokens = nonNegativeInt(metrics.outputTokenCount);
  const cacheRead = nonNegativeInt(metrics.cacheReadInputTokenCount);
  const cacheWrite = nonNegativeInt(metrics.cacheWriteInputTokenCount);
  if (inputTokens !== null) usage.input_tokens = inputTokens;
  if (outputTokens !== null) usage.output_tokens = outputTokens;
  if (cacheRead !== null) usage.cache_read_input_tokens = cacheRead;
  if (cacheWrite !== null) usage.cache_creation_input_tokens = cacheWrite;
  if (Object.keys(usage).length === 0) return next as T;
  next.usage = usage;
  return next as T;
}

/**
 * Formats one Anthropic SSE event as the wire text (`event:` line when the
 * payload carries a type, sub2api handleBedrockStreamingResponse).
 */
export function formatAnthropicSseEvent(event: Record<string, unknown>): string {
  const data = JSON.stringify(event);
  const type = typeof event.type === 'string' ? event.type : '';
  return type === '' ? `data: ${data}\n\n` : `event: ${type}\ndata: ${data}\n\n`;
}

/**
 * Extracts the usage facts from an Anthropic SSE event payload
 * (message_start's full usage and message_delta's output_tokens patch; the
 * merge semantics of sub2api parseSSEUsagePassthrough).
 */
export function anthropicSseEventUsage(event: Record<string, unknown>): BedrockObservedUsage | null {
  let usage: Record<string, unknown> | null = null;
  if (isRecord(event.usage)) usage = event.usage;
  if (usage === null && isRecord(event.message) && isRecord((event.message as Record<string, unknown>).usage)) {
    usage = (event.message as Record<string, unknown>).usage as Record<string, unknown>;
  }
  if (usage === null) return null;
  const inputTokens = nonNegativeInt(usage.input_tokens);
  const outputTokens = nonNegativeInt(usage.output_tokens);
  const cacheRead = nonNegativeInt(usage.cache_read_input_tokens);
  const cacheWrite = nonNegativeInt(usage.cache_creation_input_tokens);
  if (inputTokens === null && outputTokens === null && cacheRead === null && cacheWrite === null) return null;
  return { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

/** Merges two partial usage observations (the later one wins per field). */
export function mergeBedrockObservedUsage(
  previous: BedrockObservedUsage | null,
  next: BedrockObservedUsage,
): BedrockObservedUsage {
  return {
    inputTokens: next.inputTokens ?? previous?.inputTokens ?? null,
    outputTokens: next.outputTokens ?? previous?.outputTokens ?? null,
    cacheReadTokens: next.cacheReadTokens ?? previous?.cacheReadTokens ?? null,
    cacheWriteTokens: next.cacheWriteTokens ?? previous?.cacheWriteTokens ?? null,
  };
}
