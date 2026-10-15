import { parseSseStream, writeSseEvent } from '../../../protocol/sse.js';

/**
 * R5 Claude response bridge (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Pure conversions
 * from an Anthropic `/v1/messages` event stream into the two non-Anthropic
 * client protocol shapes the gateway serves, mirroring the codex
 * response-bridge in the opposite direction and reusing the `src/protocol`
 * a↔o vocabulary:
 *
 * - Messages → `chat.completions` (streaming chunks + non-streaming envelope)
 * - Messages → OpenAI `responses` (streaming events + aggregate)
 *
 * Anthropic usage mapping: `input_tokens` counts uncached prompt tokens;
 * cached tokens surface as `cache_read_input_tokens` (chat.completions:
 * prompt_tokens_details.cached_tokens) and cache creation as
 * `cache_creation_input_tokens` (chat.completions folds it into
 * prompt_tokens).
 */

/** Normalized Anthropic Messages usage facts (all optional). */
export interface ClaudeMessagesUsage {
  /** Uncached prompt tokens (the Anthropic `input_tokens` field). */
  readonly inputTokens: number | null;
  /** Prompt tokens served from cache. */
  readonly cacheReadTokens: number | null;
  /** Prompt tokens written to cache this request. */
  readonly cacheCreationTokens: number | null;
  readonly outputTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Extracts the normalized usage facts from a Messages `usage` object. */
export function parseMessagesUsage(value: unknown): ClaudeMessagesUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: tokenCount(value.input_tokens),
    cacheReadTokens: tokenCount(value.cache_read_input_tokens),
    cacheCreationTokens: tokenCount(value.cache_creation_input_tokens),
    outputTokens: tokenCount(value.output_tokens),
  };
}

/** Merges a terminal output-side usage into an input-side observation. */
function mergeMessagesUsage(previous: ClaudeMessagesUsage | null, output: ClaudeMessagesUsage): ClaudeMessagesUsage {
  return {
    inputTokens: previous === null ? output.inputTokens : (previous.inputTokens ?? output.inputTokens),
    cacheReadTokens: previous === null ? output.cacheReadTokens : (previous.cacheReadTokens ?? output.cacheReadTokens),
    cacheCreationTokens:
      previous === null ? output.cacheCreationTokens : (previous.cacheCreationTokens ?? output.cacheCreationTokens),
    outputTokens: output.outputTokens ?? previous?.outputTokens ?? null,
  };
}

/** Maps an Anthropic stop reason into a chat.completions finish reason. */
export function mapClaudeStopReasonToChatCompletions(
  stopReason: string | null,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'refusal') return 'content_filter';
  return 'stop';
}

/** Maps an Anthropic stop reason into a Responses terminal status. */
export function mapClaudeStopReasonToResponsesStatus(stopReason: string | null): 'completed' | 'incomplete' {
  return stopReason === 'max_tokens' ? 'incomplete' : 'completed';
}

function createdTimestamp(nowMs: () => number): number {
  return Math.floor(nowMs() / 1000);
}

export interface ChatCompletionsUsageChunkUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: { readonly cached_tokens: number };
}

/** chat.completions usage payload built from normalized Messages usage. */
export function chatCompletionsUsage(usage: ClaudeMessagesUsage): ChatCompletionsUsageChunkUsage {
  const inputTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const outputTokens = usage.outputTokens ?? 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
  };
}

/** Responses usage payload shape built from normalized Messages usage. */
export function responsesUsage(usage: ClaudeMessagesUsage): {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly input_tokens_details: { readonly cached_tokens: number };
} {
  return {
    input_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
    output_tokens: usage.outputTokens ?? 0,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
  };
}

interface StreamedToolCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
}

/**
 * Streaming assembler: Anthropic Messages SSE events in,
 * chat.completion.chunk objects out. The caller serializes each chunk with
 * the chat.completions SSE framing and terminates with `data: [DONE]` after
 * the last chunk returned by `finish()`.
 */
export class MessagesToChatCompletionsStream {
  private messageId = '';
  private model = '';
  private created: number;
  private roleChunkEmitted = false;
  private nextToolCallIndex = 0;
  private activeToolCall: StreamedToolCall | null = null;
  private usage: ClaudeMessagesUsage | null = null;
  private finished = false;
  private finishReason: string | null = null;

  constructor(
    private readonly options: {
      readonly includeUsage: boolean;
      readonly nowMs?: () => number;
    },
  ) {
    this.created = createdTimestamp(options.nowMs ?? Date.now);
  }

  /** The usage observed so far (authoritative after message_delta/message_stop). */
  get observedUsage(): ClaudeMessagesUsage | null {
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

  /** Returns the chat.completion.chunk objects for one Messages event. */
  push(event: unknown): readonly Record<string, unknown>[] {
    if (this.finished) return [];
    if (!isRecord(event)) return [];
    const chunks: Record<string, unknown>[] = [];

    switch (event.type) {
      case 'message_start': {
        const message = isRecord(event.message) ? event.message : null;
        if (message !== null) {
          if (typeof message.id === 'string') this.messageId = message.id;
          if (typeof message.model === 'string') this.model = message.model;
          const usage = parseMessagesUsage(message.usage);
          if (usage !== null) this.usage = usage;
        }
        return chunks;
      }
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : null;
        if (block === null || block.type !== 'tool_use') return chunks;
        this.ensureRoleChunk(chunks);
        const callId = typeof block.id === 'string' ? block.id : '';
        const name = typeof block.name === 'string' ? block.name : '';
        const index = this.nextToolCallIndex;
        this.nextToolCallIndex += 1;
        this.activeToolCall = { index, id: callId, name, arguments: '' };
        chunks.push(
          this.baseChunk({
            tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }],
          }),
        );
        return chunks;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        if (delta === null) return chunks;
        if (typeof delta.text === 'string') {
          this.ensureRoleChunk(chunks);
          chunks.push(this.baseChunk({ content: delta.text }));
          return chunks;
        }
        if (typeof delta.partial_json === 'string' && this.activeToolCall !== null) {
          this.activeToolCall.arguments += delta.partial_json;
          chunks.push(
            this.baseChunk({
              tool_calls: [{ index: this.activeToolCall.index, function: { arguments: delta.partial_json } }],
            }),
          );
        }
        return chunks;
      }
      case 'message_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        const stopReason = delta !== null && typeof delta.stop_reason === 'string' ? delta.stop_reason : null;
        const outputUsage = parseMessagesUsage(event.usage);
        if (outputUsage !== null) {
          this.usage = mergeMessagesUsage(this.usage, outputUsage);
        }
        this.finishReason = stopReason;
        return chunks;
      }
      case 'message_stop': {
        if (!this.roleChunkEmitted) {
          chunks.push(this.baseChunk({ role: 'assistant', content: '' }));
          this.roleChunkEmitted = true;
        }
        chunks.push(this.baseChunk({}, mapClaudeStopReasonToChatCompletions(this.finishReason)));
        if (this.options.includeUsage && this.usage !== null) {
          chunks.push({
            id: this.messageId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [],
            usage: chatCompletionsUsage(this.usage),
          });
        }
        this.finished = true;
        return chunks;
      }
      default:
        return chunks;
    }
  }

  /** Terminal chunks for a stream that ended without message_stop. */
  finish(): readonly Record<string, unknown>[] {
    if (this.finished) return [];
    this.finished = true;
    if (!this.roleChunkEmitted) {
      this.roleChunkEmitted = true;
      return [this.baseChunk({ role: 'assistant', content: '' }, 'stop')];
    }
    return [this.baseChunk({}, 'stop')];
  }
}

/** Wraps a Messages SSE byte stream into a chat.completions SSE byte stream. */
export function messagesSseToChatCompletionsSse(
  upstream: ReadableStream<Uint8Array>,
  options: { readonly includeUsage: boolean; readonly nowMs?: () => number },
): { readonly clientStream: ReadableStream<Uint8Array>; readonly usage: Promise<ClaudeMessagesUsage | null> } {
  const assembler = new MessagesToChatCompletionsStream(options);
  const encoder = new TextEncoder();
  let resolveUsage!: (usage: ClaudeMessagesUsage | null) => void;
  const usage = new Promise<ClaudeMessagesUsage | null>((resolve) => {
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
 * Non-streaming aggregation: the full Messages event sequence in, one
 * chat.completion envelope out.
 */
export function aggregateMessagesToChatCompletion(
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
  let messageId = '';
  let model = options.fallbackModel ?? '';
  let usage: ClaudeMessagesUsage | null = null;
  let stopReason: string | null = null;
  for (const raw of events) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case 'message_start': {
        const message = isRecord(raw.message) ? raw.message : null;
        if (message !== null) {
          if (typeof message.id === 'string') messageId = message.id;
          if (typeof message.model === 'string') model = message.model;
          const parsed = parseMessagesUsage(message.usage);
          if (parsed !== null) usage = parsed;
        }
        break;
      }
      case 'content_block_start': {
        const block = isRecord(raw.content_block) ? raw.content_block : null;
        if (block !== null && block.type === 'tool_use') {
          toolCalls.push({
            index: toolCalls.length,
            id: typeof block.id === 'string' ? block.id : '',
            type: 'function',
            function: { name: typeof block.name === 'string' ? block.name : '', arguments: '' },
          });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = isRecord(raw.delta) ? raw.delta : null;
        if (delta === null) break;
        if (typeof delta.text === 'string') textParts.push(delta.text);
        if (typeof delta.partial_json === 'string') {
          const last = toolCalls[toolCalls.length - 1];
          if (last !== undefined) last.function.arguments += delta.partial_json;
        }
        break;
      }
      case 'message_delta': {
        const delta = isRecord(raw.delta) ? raw.delta : null;
        if (delta !== null && typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        const outputUsage = parseMessagesUsage(raw.usage);
        if (outputUsage !== null) {
          usage = mergeMessagesUsage(usage, outputUsage);
        }
        break;
      }
      default:
        break;
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const envelope: Record<string, unknown> = {
    id: messageId,
    object: 'chat.completion',
    created: createdTimestamp(options.nowMs ?? Date.now),
    model,
    choices: [{ index: 0, message, finish_reason: mapClaudeStopReasonToChatCompletions(stopReason), logprobs: null }],
  };
  if (usage !== null) envelope.usage = chatCompletionsUsage(usage);
  return envelope;
}

/**
 * Streaming assembler: Anthropic Messages SSE events in, OpenAI Responses
 * SSE events out (`response.created` → output events → `response.completed`
 * carrying the authoritative usage), following the vocabulary of
 * `src/protocol/responses.ts`.
 */
export class MessagesToResponsesStream {
  private responseId = '';
  private model = '';
  private responseCreated = false;
  private outputIndex = 0;
  private activeTool: { readonly item: Record<string, unknown>; readonly index: number } | null = null;
  private toolItems: Record<string, unknown>[] = [];
  private usage: ClaudeMessagesUsage | null = null;
  private stopReason: string | null = null;
  private finished = false;

  /** The usage observed so far (authoritative after message_delta). */
  get observedUsage(): ClaudeMessagesUsage | null {
    return this.usage;
  }

  /** Returns the Responses SSE events (event name + data payload) for one Messages event. */
  push(event: unknown): readonly { readonly event: string; readonly data: Record<string, unknown> }[] {
    if (this.finished) return [];
    if (!isRecord(event)) return [];
    const events: Array<{ readonly event: string; readonly data: Record<string, unknown> }> = [];
    const emit = (name: string, data: Record<string, unknown>): void => {
      events.push({ event: name, data });
    };

    switch (event.type) {
      case 'message_start': {
        const message = isRecord(event.message) ? event.message : null;
        if (message !== null) {
          if (typeof message.id === 'string') this.responseId = message.id;
          if (typeof message.model === 'string') this.model = message.model;
          const usage = parseMessagesUsage(message.usage);
          if (usage !== null) this.usage = usage;
        }
        if (!this.responseCreated) {
          this.responseCreated = true;
          emit('response.created', {
            type: 'response.created',
            response: { id: this.responseId, model: this.model, status: 'in_progress' },
          });
        }
        return events;
      }
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : null;
        if (block === null) return events;
        if (!this.responseCreated) {
          this.responseCreated = true;
          emit('response.created', {
            type: 'response.created',
            response: { id: this.responseId, model: this.model, status: 'in_progress' },
          });
        }
        if (block.type === 'tool_use') {
          const item = {
            type: 'function_call',
            call_id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            arguments: '',
          };
          const index = this.outputIndex;
          this.outputIndex += 1;
          this.activeTool = { item, index };
          this.toolItems.push(item);
          emit('response.output_item.added', { type: 'response.output_item.added', output_index: index, item });
          return events;
        }
        const index = this.outputIndex;
        this.outputIndex += 1;
        emit('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: index,
          item: { type: 'message', role: 'assistant', content: [] },
        });
        return events;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        if (delta === null) return events;
        if (typeof delta.text === 'string') {
          emit('response.output_text.delta', { type: 'response.output_text.delta', delta: delta.text });
          return events;
        }
        if (typeof delta.partial_json === 'string' && this.activeTool !== null) {
          (this.activeTool.item as { arguments: string }).arguments += delta.partial_json;
          emit('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            delta: delta.partial_json,
          });
        }
        return events;
      }
      case 'message_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        if (delta !== null && typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason;
        const outputUsage = parseMessagesUsage(event.usage);
        if (outputUsage !== null) {
          this.usage = mergeMessagesUsage(this.usage, outputUsage);
        }
        return events;
      }
      case 'message_stop': {
        const status = mapClaudeStopReasonToResponsesStatus(this.stopReason);
        const usageFields = this.usage === null ? {} : { usage: responsesUsage(this.usage) };
        emit('response.completed', {
          type: 'response.completed',
          response: {
            id: this.responseId,
            model: this.model,
            status,
            ...(this.stopReason === 'max_tokens' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
            ...usageFields,
          },
        });
        this.finished = true;
        return events;
      }
      default:
        return events;
    }
  }

  /** Terminal events for a stream that ended without message_stop. */
  finish(): readonly { readonly event: string; readonly data: Record<string, unknown> }[] {
    if (this.finished) return [];
    this.finished = true;
    const usageFields = this.usage === null ? {} : { usage: responsesUsage(this.usage) };
    return [
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: { id: this.responseId, model: this.model, status: 'completed', ...usageFields },
        },
      },
    ];
  }
}

/** Wraps a Messages SSE byte stream into a Responses SSE byte stream. */
export function messagesSseToResponsesSse(upstream: ReadableStream<Uint8Array>): {
  readonly clientStream: ReadableStream<Uint8Array>;
  readonly usage: Promise<ClaudeMessagesUsage | null>;
} {
  const assembler = new MessagesToResponsesStream();
  const encoder = new TextEncoder();
  let resolveUsage!: (usage: ClaudeMessagesUsage | null) => void;
  const usage = new Promise<ClaudeMessagesUsage | null>((resolve) => {
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
