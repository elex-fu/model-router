import { parseSseStream, writeSseEvent } from '../../../protocol/sse.js';
import { type GeminiUsageMetadata, parseGeminiUsageMetadata } from './quota-usage.js';
import { unwrapGeminiResponse } from './transform.js';

/**
 * F4 Gemini response bridge (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b). Pure conversions
 * from a Gemini `generateContent`/`streamGenerateContent` response (wrapped
 * or unwrapped) into the two non-Gemini client protocol shapes the gateway
 * serves, mirroring the claude response-bridge in the opposite direction:
 *
 * - Gemini → `chat.completions` (streaming chunks + non-streaming envelope)
 * - Gemini → Anthropic Messages (streaming events + aggregate)
 *
 * Usage mapping (sub2api extractGeminiUsage parity): Gemini's
 * `promptTokenCount` INCLUDES `cachedContentTokenCount`, so the Anthropic
 * `input_tokens` is the difference and the cache read surfaces separately;
 * the output side is `candidatesTokenCount + thoughtsTokenCount`.
 */

/** Normalized Gemini usage facts expressed in the bridge's output vocabulary. */
export interface GeminiResponseUsage {
  /** Uncached prompt tokens (promptTokenCount − cachedContentTokenCount). */
  readonly inputTokens: number | null;
  /** Prompt tokens served from implicit context cache. */
  readonly cacheReadTokens: number | null;
  /** Output tokens: candidatesTokenCount + thoughtsTokenCount. */
  readonly outputTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Converts a normalized usageMetadata into the bridge's usage vocabulary. */
export function geminiUsageFromMetadata(metadata: GeminiUsageMetadata | null): GeminiResponseUsage | null {
  if (metadata === null) return null;
  const prompt = metadata.promptTokens ?? 0;
  const cached = metadata.cachedTokens ?? 0;
  const output =
    metadata.outputTokens === null && metadata.thoughtsTokens === null
      ? null
      : (metadata.outputTokens ?? 0) + (metadata.thoughtsTokens ?? 0);
  return {
    inputTokens: Math.max(0, prompt - cached),
    cacheReadTokens: metadata.cachedTokens,
    outputTokens: output,
  };
}

/** Extracts usageMetadata from one (already unwrapped) Gemini response chunk. */
export function parseGeminiResponseUsage(chunk: Record<string, unknown>): GeminiResponseUsage | null {
  return geminiUsageFromMetadata(parseGeminiUsageMetadata(chunk.usageMetadata));
}

/** Maps a Gemini finishReason onto a chat.completions finish reason. */
export function mapGeminiFinishReasonToChatCompletions(
  finishReason: string | null,
  sawToolCall: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (finishReason === 'MAX_TOKENS') return 'length';
  if (sawToolCall) return 'tool_calls';
  if (
    finishReason !== null &&
    [
      'SAFETY',
      'RECITATION',
      'LANGUAGE',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'IMAGE_SAFETY',
      'IMAGE_PROHIBITED_CONTENT',
      'IMAGE_RECITATION',
    ].includes(finishReason)
  ) {
    return 'content_filter';
  }
  return 'stop';
}

/** Maps a Gemini finishReason onto an Anthropic stop reason. */
export function mapGeminiFinishReasonToAnthropic(
  finishReason: string | null,
  sawToolCall: boolean,
): 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' {
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  if (sawToolCall) return 'tool_use';
  if (
    finishReason !== null &&
    [
      'SAFETY',
      'RECITATION',
      'LANGUAGE',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'IMAGE_SAFETY',
      'IMAGE_PROHIBITED_CONTENT',
      'IMAGE_RECITATION',
    ].includes(finishReason)
  ) {
    return 'refusal';
  }
  return 'end_turn';
}

function createdTimestamp(nowMs: () => number): number {
  return Math.floor(nowMs() / 1000);
}

/** chat.completions usage payload built from normalized Gemini usage. */
export function chatCompletionsUsageFromGemini(usage: GeminiResponseUsage): {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: { readonly cached_tokens: number };
} {
  const inputTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  const outputTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
  };
}

/** Anthropic Messages usage payload built from normalized Gemini usage. */
export function anthropicUsageFromGemini(usage: GeminiResponseUsage): {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number;
} {
  const result: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  } = { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0 };
  if (usage.cacheReadTokens !== null) result.cache_read_input_tokens = usage.cacheReadTokens;
  return result;
}

interface GeminiChunkView {
  readonly text: string | null;
  readonly functionCall: { readonly name: string; readonly args: Record<string, unknown> } | null;
  readonly finishReason: string | null;
  readonly usage: GeminiResponseUsage | null;
}

/** Unwraps (when needed) and projects one Gemini response chunk. */
export function projectGeminiChunk(raw: unknown): GeminiChunkView | null {
  if (!isRecord(raw)) return null;
  const chunk = unwrapGeminiResponse(raw);
  const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  const content = candidate !== null && isRecord(candidate.content) ? candidate.content : null;
  const parts = content !== null && Array.isArray(content.parts) ? content.parts : [];
  let text: string | null = null;
  let functionCall: GeminiChunkView['functionCall'] = null;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') text = (text ?? '') + part.text;
    if (isRecord(part.functionCall) && typeof part.functionCall.name === 'string') {
      functionCall = {
        name: part.functionCall.name,
        args: isRecord(part.functionCall.args) ? part.functionCall.args : {},
      };
    }
  }
  const finishReason =
    candidate !== null && typeof candidate.finishReason === 'string' && candidate.finishReason.length > 0
      ? candidate.finishReason
      : null;
  const usage = parseGeminiResponseUsage(chunk);
  if (text === null && functionCall === null && finishReason === null && usage === null) return null;
  return { text, functionCall, finishReason, usage };
}

/**
 * Streaming assembler: Gemini response chunks in, chat.completion.chunk
 * objects out. The caller serializes each chunk with the chat.completions
 * SSE framing and terminates with `data: [DONE]` after the last chunk
 * returned by `finish()`.
 */
export class GeminiToChatCompletionsStream {
  private messageId = '';
  private model = '';
  private created: number;
  private roleChunkEmitted = false;
  private nextToolCallIndex = 0;
  private usage: GeminiResponseUsage | null = null;
  private finished = false;
  private finishReason: string | null = null;
  private sawToolCall = false;

  constructor(
    private readonly options: {
      readonly includeUsage: boolean;
      readonly nowMs?: () => number;
    },
  ) {
    this.created = createdTimestamp(options.nowMs ?? Date.now);
  }

  /** The usage observed so far (authoritative after a chunk carrying usageMetadata). */
  get observedUsage(): GeminiResponseUsage | null {
    return this.usage;
  }

  private baseChunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
    return {
      id: this.messageId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          ...(finishReason === null ? {} : { finish_reason: finishReason }),
          logprobs: null,
        },
      ],
    };
  }

  private ensureRoleChunk(chunks: Record<string, unknown>[]): void {
    if (this.roleChunkEmitted) return;
    chunks.push(this.baseChunk({ role: 'assistant', content: '' }));
    this.roleChunkEmitted = true;
  }

  /** Returns the chat.completion.chunk objects for one Gemini response chunk. */
  push(event: unknown): readonly Record<string, unknown>[] {
    if (this.finished) return [];
    const projected = projectGeminiChunk(event);
    if (projected === null) return [];
    const chunks: Record<string, unknown>[] = [];
    if (typeof event === 'object' && event !== null) {
      const raw = event as Record<string, unknown>;
      if (typeof raw.responseId === 'string' && this.messageId === '') this.messageId = raw.responseId;
      if (typeof raw.model === 'string' && this.model === '') this.model = raw.model;
    }
    if (projected.text !== null) this.ensureRoleChunk(chunks);
    if (projected.text !== null && projected.text.length > 0) {
      chunks.push(this.baseChunk({ content: projected.text }));
    }
    if (projected.functionCall !== null) {
      this.ensureRoleChunk(chunks);
      this.sawToolCall = true;
      const index = this.nextToolCallIndex;
      this.nextToolCallIndex += 1;
      chunks.push(
        this.baseChunk({
          tool_calls: [
            {
              index,
              id: `gemini-call-${index}`,
              type: 'function',
              function: {
                name: projected.functionCall.name,
                arguments: JSON.stringify(projected.functionCall.args ?? {}),
              },
            },
          ],
        }),
      );
    }
    if (projected.finishReason !== null) this.finishReason = projected.finishReason;
    if (projected.usage !== null) {
      this.usage = this.usage === null ? projected.usage : mergeGeminiUsage(this.usage, projected.usage);
    }
    return chunks;
  }

  /** Terminal chunks; called on stream end (Gemini has no explicit terminal event). */
  finish(): readonly Record<string, unknown>[] {
    if (this.finished) return [];
    this.finished = true;
    const chunks: Record<string, unknown>[] = [];
    if (!this.roleChunkEmitted) {
      chunks.push(this.baseChunk({ role: 'assistant', content: '' }));
      this.roleChunkEmitted = true;
    }
    chunks.push(this.baseChunk({}, mapGeminiFinishReasonToChatCompletions(this.finishReason, this.sawToolCall)));
    if (this.options.includeUsage && this.usage !== null) {
      chunks.push({
        id: this.messageId,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage: chatCompletionsUsageFromGemini(this.usage),
      });
    }
    return chunks;
  }
}

function mergeGeminiUsage(previous: GeminiResponseUsage, next: GeminiResponseUsage): GeminiResponseUsage {
  return {
    inputTokens: next.inputTokens ?? previous.inputTokens,
    cacheReadTokens: next.cacheReadTokens ?? previous.cacheReadTokens,
    outputTokens: next.outputTokens ?? previous.outputTokens,
  };
}

/** Wraps a Gemini SSE byte stream into a chat.completions SSE byte stream. */
export function geminiSseToChatCompletionsSse(
  upstream: ReadableStream<Uint8Array>,
  options: { readonly includeUsage: boolean; readonly nowMs?: () => number },
): { readonly clientStream: ReadableStream<Uint8Array>; readonly usage: Promise<GeminiResponseUsage | null> } {
  const assembler = new GeminiToChatCompletionsStream(options);
  const encoder = new TextEncoder();
  let resolveUsage!: (usage: GeminiResponseUsage | null) => void;
  const usage = new Promise<GeminiResponseUsage | null>((resolve) => {
    resolveUsage = resolve;
  });
  const clientStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (chunk: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      try {
        for await (const event of parseSseStream(upstream)) {
          if (!event.data || event.data === '[DONE]') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          for (const chunk of assembler.push(parsed)) emit(chunk);
        }
        for (const chunk of assembler.finish()) emit(chunk);
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        resolveUsage(assembler.observedUsage);
      } catch (error) {
        try {
          controller.error(error);
        } catch {
          // The client may already be gone; the usage promise still settles.
        }
        resolveUsage(assembler.observedUsage);
      }
    },
  });
  return { clientStream, usage };
}

/**
 * Streaming assembler: Gemini response chunks in, Anthropic Messages SSE
 * events out (`message_start` → content_block events → `message_delta` +
 * `message_stop` carrying the authoritative usage), following the vocabulary
 * of `src/protocol/anthropic.ts` / the claude transport's event shapes.
 */
export class GeminiToAnthropicMessagesStream {
  private messageId = '';
  private model = '';
  private started = false;
  private textBlockOpen = false;
  private usage: GeminiResponseUsage | null = null;
  private finishReason: string | null = null;
  private sawToolCall = false;
  private nextToolIndex = 0;
  private finished = false;

  /** The usage observed so far (authoritative after a usageMetadata chunk). */
  get observedUsage(): GeminiResponseUsage | null {
    return this.usage;
  }

  private ensureStarted(events: Array<{ readonly event: string; readonly data: Record<string, unknown> }>): void {
    if (this.started) return;
    this.started = true;
    events.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          usage: this.usage === null ? {} : anthropicUsageFromGemini(this.usage),
        },
      },
    });
  }

  /** Returns the Messages SSE events (event name + data payload) for one Gemini chunk. */
  push(event: unknown): readonly { readonly event: string; readonly data: Record<string, unknown> }[] {
    if (this.finished) return [];
    const events: Array<{ readonly event: string; readonly data: Record<string, unknown> }> = [];
    if (typeof event === 'object' && event !== null) {
      const raw = event as Record<string, unknown>;
      if (typeof raw.responseId === 'string' && this.messageId === '') this.messageId = raw.responseId;
      if (typeof raw.model === 'string' && this.model === '') this.model = raw.model;
    }
    const projected = projectGeminiChunk(event);
    if (projected === null) return events;
    this.ensureStarted(events);

    if (projected.text !== null && projected.text.length > 0) {
      if (!this.textBlockOpen) {
        this.textBlockOpen = true;
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        });
      }
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: projected.text } },
      });
    }
    if (projected.functionCall !== null) {
      this.sawToolCall = true;
      const index = this.nextToolIndex;
      this.nextToolIndex += 1;
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: `gemini-tool-${index}`, name: projected.functionCall.name, input: {} },
        },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(projected.functionCall.args ?? {}) },
        },
      });
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    }
    if (projected.finishReason !== null) this.finishReason = projected.finishReason;
    if (projected.usage !== null) {
      this.usage = this.usage === null ? projected.usage : mergeGeminiUsage(this.usage, projected.usage);
    }
    return events;
  }

  /** Terminal events; called on stream end. */
  finish(): readonly { readonly event: string; readonly data: Record<string, unknown> }[] {
    if (this.finished) return [];
    this.finished = true;
    const events: Array<{ readonly event: string; readonly data: Record<string, unknown> }> = [];
    this.ensureStarted(events);
    if (this.textBlockOpen) {
      this.textBlockOpen = false;
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
    }
    const stopReason = mapGeminiFinishReasonToAnthropic(this.finishReason, this.sawToolCall);
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: this.usage === null ? {} : anthropicUsageFromGemini(this.usage),
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }
}

/** Wraps a Gemini SSE byte stream into an Anthropic Messages SSE byte stream. */
export function geminiSseToAnthropicMessagesSse(upstream: ReadableStream<Uint8Array>): {
  readonly clientStream: ReadableStream<Uint8Array>;
  readonly usage: Promise<GeminiResponseUsage | null>;
} {
  const assembler = new GeminiToAnthropicMessagesStream();
  const encoder = new TextEncoder();
  let resolveUsage!: (usage: GeminiResponseUsage | null) => void;
  const usage = new Promise<GeminiResponseUsage | null>((resolve) => {
    resolveUsage = resolve;
  });
  const clientStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (name: string, data: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(writeSseEvent({ event: name, data: JSON.stringify(data) })));
      };
      try {
        for await (const event of parseSseStream(upstream)) {
          if (!event.data || event.data === '[DONE]') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          for (const next of assembler.push(parsed)) emit(next.event, next.data);
        }
        for (const next of assembler.finish()) emit(next.event, next.data);
        controller.close();
        resolveUsage(assembler.observedUsage);
      } catch (error) {
        try {
          controller.error(error);
        } catch {
          // The client may already be gone; the usage promise still settles.
        }
        resolveUsage(assembler.observedUsage);
      }
    },
  });
  return { clientStream, usage };
}

/**
 * Non-streaming aggregation: the full Gemini response chunk sequence in, one
 * chat.completion envelope out.
 */
export function aggregateGeminiToChatCompletion(
  events: readonly unknown[],
  options: { readonly fallbackModel?: string; readonly nowMs?: () => number } = {},
): Record<string, unknown> {
  const textParts: string[] = [];
  const toolCalls: Array<{
    index: number;
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];
  let model = options.fallbackModel ?? '';
  let usage: GeminiResponseUsage | null = null;
  let finishReason: string | null = null;
  for (const raw of events) {
    if (typeof raw === 'object' && raw !== null) {
      const record = raw as Record<string, unknown>;
      if (typeof record.model === 'string' && model === '') model = record.model;
    }
    const projected = projectGeminiChunk(raw);
    if (projected === null) continue;
    if (projected.text !== null) textParts.push(projected.text);
    if (projected.functionCall !== null) {
      toolCalls.push({
        index: toolCalls.length,
        id: `gemini-call-${toolCalls.length}`,
        type: 'function',
        function: {
          name: projected.functionCall.name,
          arguments: JSON.stringify(projected.functionCall.args ?? {}),
        },
      });
    }
    if (projected.finishReason !== null) finishReason = projected.finishReason;
    if (projected.usage !== null) {
      usage = usage === null ? projected.usage : mergeGeminiUsage(usage, projected.usage);
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const envelope: Record<string, unknown> = {
    id: `gemini-${createdTimestamp(options.nowMs ?? Date.now)}`,
    object: 'chat.completion',
    created: createdTimestamp(options.nowMs ?? Date.now),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapGeminiFinishReasonToChatCompletions(finishReason, toolCalls.length > 0),
        logprobs: null,
      },
    ],
  };
  if (usage !== null) envelope.usage = chatCompletionsUsageFromGemini(usage);
  return envelope;
}
