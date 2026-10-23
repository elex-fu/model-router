import { parseSseStream, writeSseEvent } from '../../../protocol/sse.js';
import { restoreReservedToolNames } from './transform.js';

/**
 * P1c Codex response bridge (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.5). Pure conversions
 * from a ChatGPT Codex `responses` event stream into the two other client
 * protocol shapes the gateway serves:
 *
 * - Responses → `chat.completions` (streaming chunks + non-streaming envelope)
 * - Responses → Anthropic `messages` (streaming event sequence + envelope)
 *
 * Every inbound frame passes through `restoreReservedToolNames` so the
 * `python__mr` alias injected on the way out (transform.ts) is restored to
 * `python` before any client sees it. The mapping vocabulary follows the
 * existing `src/protocol/` bridges (`responses.ts`, `anth-to-openai.ts`):
 * text deltas, refusal deltas, function-call items/argument deltas, and the
 * terminal `response.completed` event that carries the authoritative usage.
 */

/** Normalized Responses usage facts (all optional: the upstream may omit them). */
export interface CodexResponsesUsage {
  /** Total prompt tokens, including cached ones. */
  readonly inputTokens: number | null;
  /** Prompt tokens served from cache (`input_tokens_details.cached_tokens`). */
  readonly cachedTokens: number | null;
  readonly outputTokens: number | null;
  /** Reasoning tokens (`output_tokens_details.reasoning_tokens`). */
  readonly reasoningTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Extracts the normalized usage facts from a Responses `usage` object. */
export function parseResponsesUsage(value: unknown): CodexResponsesUsage | null {
  if (!isRecord(value)) return null;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : null;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : null;
  return {
    inputTokens: tokenCount(value.input_tokens),
    cachedTokens: inputDetails === null ? null : tokenCount(inputDetails.cached_tokens),
    outputTokens: tokenCount(value.output_tokens),
    reasoningTokens: outputDetails === null ? null : tokenCount(outputDetails.reasoning_tokens),
  };
}

interface ResponsesTerminalFacts {
  readonly responseId: string | null;
  readonly model: string | null;
  readonly status: string | null;
  readonly incompleteReason: string | null;
  readonly usage: CodexResponsesUsage | null;
}

function responsePayload(event: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(event.response) ? event.response : null;
}

function terminalFacts(event: Record<string, unknown>): ResponsesTerminalFacts {
  const response = responsePayload(event);
  const incomplete = response !== null && isRecord(response.incomplete_details) ? response.incomplete_details : null;
  return {
    responseId: response !== null && typeof response.id === 'string' ? response.id : null,
    model: response !== null && typeof response.model === 'string' ? response.model : null,
    status: response !== null && typeof response.status === 'string' ? response.status : null,
    incompleteReason: incomplete !== null && typeof incomplete.reason === 'string' ? incomplete.reason : null,
    usage: response === null ? null : parseResponsesUsage(response.usage),
  };
}

/** Maps the terminal Responses status into a chat.completions finish reason. */
export function mapChatCompletionsFinishReason(
  status: string | null,
  incompleteReason: string | null,
  hadToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (incompleteReason === 'max_output_tokens') return 'length';
  if (status === 'incomplete') return 'length';
  if (hadToolCalls) return 'tool_calls';
  return 'stop';
}

/** Maps the terminal Responses status into an Anthropic stop reason. */
export function mapAnthropicStopReason(
  status: string | null,
  incompleteReason: string | null,
  hadToolCalls: boolean,
): 'end_turn' | 'max_tokens' | 'tool_use' {
  if (incompleteReason === 'max_output_tokens') return 'max_tokens';
  if (status === 'incomplete') return 'max_tokens';
  if (hadToolCalls) return 'tool_use';
  return 'end_turn';
}

function createdTimestamp(nowMs: () => number): number {
  return Math.floor(nowMs() / 1000);
}

export interface ChatCompletionsUsageChunkUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens: number };
}

/** Missing upstream counters remain absent, including in compatibility output. */
export function chatCompletionsUsage(usage: CodexResponsesUsage): ChatCompletionsUsageChunkUsage {
  return {
    ...(usage.inputTokens === null ? {} : { prompt_tokens: usage.inputTokens }),
    ...(usage.outputTokens === null ? {} : { completion_tokens: usage.outputTokens }),
    ...(usage.inputTokens === null || usage.outputTokens === null ? {} : { total_tokens: usage.inputTokens + usage.outputTokens }),
    ...(usage.cachedTokens === null ? {} : { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }),
  };
}

/** Anthropic input is uncached input; it requires both reported counters. */
export function anthropicUsageFields(usage: CodexResponsesUsage): {
  readonly input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens: number;
  readonly output_tokens?: number;
} {
  return {
    ...(usage.inputTokens === null || usage.cachedTokens === null ? {} : { input_tokens: Math.max(0, usage.inputTokens - usage.cachedTokens) }),
    ...(usage.cachedTokens === null ? {} : { cache_read_input_tokens: usage.cachedTokens }),
    cache_creation_input_tokens: 0,
    ...(usage.outputTokens === null ? {} : { output_tokens: usage.outputTokens }),
  };
}

interface StreamedToolCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
}

/**
 * Streaming assembler: Responses SSE events in, chat.completion.chunk objects
 * out. The caller serializes each chunk with the chat.completions SSE framing
 * (`data: {...}` lines) and terminates with `data: [DONE]` after the last
 * chunk returned by `finish()`.
 */
export class ResponsesToChatCompletionsStream {
  private responseId = '';
  private model = '';
  private created: number;
  private roleChunkEmitted = false;
  private nextToolCallIndex = 0;
  private activeToolCall: StreamedToolCall | null = null;
  private toolCallsSeen = false;
  private finished = false;
  private usage: CodexResponsesUsage | null = null;

  constructor(
    private readonly options: {
      /** Emit the terminal usage chunk (request had stream_options.include_usage). */
      readonly includeUsage: boolean;
      readonly nowMs?: () => number;
    },
  ) {
    this.created = createdTimestamp(options.nowMs ?? Date.now);
  }

  /** The usage observed so far (authoritative after response.completed). */
  get observedUsage(): CodexResponsesUsage | null {
    return this.usage;
  }

  private baseChunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
    return {
      id: this.responseId,
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

  private ensureRoleChunk(): void {
    this.roleChunkEmitted = true;
  }

  /** Returns the chat.completion.chunk objects for one Responses event. */
  push(event: unknown): readonly Record<string, unknown>[] {
    if (this.finished) return [];
    const restored = restoreReservedToolNames(event) as unknown;
    if (!isRecord(restored)) return [];
    const chunks: Record<string, unknown>[] = [];

    switch (restored.type) {
      case 'response.created': {
        const facts = terminalFacts(restored);
        if (facts.responseId !== null) this.responseId = facts.responseId;
        if (facts.model !== null) this.model = facts.model;
        return chunks;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (typeof restored.delta !== 'string') return chunks;
        if (!this.roleChunkEmitted) {
          chunks.push(this.baseChunk({ role: 'assistant', content: '' }));
          this.ensureRoleChunk();
        }
        chunks.push(this.baseChunk({ content: restored.delta }));
        return chunks;
      }
      case 'response.output_item.added': {
        const item = isRecord(restored.item) ? restored.item : null;
        if (item === null || item.type !== 'function_call') return chunks;
        const callId = typeof item.call_id === 'string' ? item.call_id : '';
        const name = typeof item.name === 'string' ? item.name : '';
        if (!this.roleChunkEmitted) {
          chunks.push(this.baseChunk({ role: 'assistant', content: '' }));
          this.ensureRoleChunk();
        }
        const index = this.nextToolCallIndex;
        this.nextToolCallIndex += 1;
        this.toolCallsSeen = true;
        this.activeToolCall = { index, id: callId, name, arguments: '' };
        chunks.push(
          this.baseChunk({
            tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }],
          }),
        );
        return chunks;
      }
      case 'response.function_call_arguments.delta': {
        if (typeof restored.delta !== 'string' || this.activeToolCall === null) return chunks;
        this.activeToolCall.arguments += restored.delta;
        chunks.push(
          this.baseChunk({
            tool_calls: [
              {
                index: this.activeToolCall.index,
                function: { arguments: restored.delta },
              },
            ],
          }),
        );
        return chunks;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'response.completed': {
        const facts = terminalFacts(restored);
        if (facts.responseId !== null) this.responseId = facts.responseId;
        if (facts.model !== null) this.model = facts.model;
        this.usage = facts.usage;
        const finishReason = mapChatCompletionsFinishReason(facts.status, facts.incompleteReason, this.toolCallsSeen);
        if (!this.roleChunkEmitted) {
          chunks.push(this.baseChunk({ role: 'assistant', content: '' }));
          this.ensureRoleChunk();
        }
        chunks.push(this.baseChunk({}, finishReason));
        if (this.options.includeUsage && this.usage !== null) {
          chunks.push({
            id: this.responseId,
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

  /**
   * Terminal chunks for a stream that ended without `response.completed`:
   * a stop-terminated chunk keeps the client protocol well-formed.
   */
  finish(): readonly Record<string, unknown>[] {
    if (this.finished) return [];
    this.finished = true;
    if (!this.roleChunkEmitted) {
      this.ensureRoleChunk();
      return [this.baseChunk({ role: 'assistant', content: '' }, 'stop')];
    }
    return [this.baseChunk({}, 'stop')];
  }
}

/**
 * Wraps a Responses SSE byte stream into a chat.completions SSE byte stream
 * (including the terminal `data: [DONE]` frame).
 */
export function responsesSseToChatCompletionsSse(
  upstream: ReadableStream<Uint8Array>,
  options: { readonly includeUsage: boolean; readonly nowMs?: () => number },
): { readonly clientStream: ReadableStream<Uint8Array>; readonly usage: Promise<CodexResponsesUsage | null> } {
  const assembler = new ResponsesToChatCompletionsStream(options);
  const encoder = new TextEncoder();
  let resolveUsage!: (usage: CodexResponsesUsage | null) => void;
  const usage = new Promise<CodexResponsesUsage | null>((resolve) => {
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
 * Non-streaming aggregation: the full Responses event sequence in, one
 * chat.completion envelope out.
 */
export function aggregateResponsesToChatCompletion(
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
  let responseId = '';
  let model = options.fallbackModel ?? '';
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop';
  let usage: CodexResponsesUsage | null = null;
  for (const raw of events) {
    const restored = restoreReservedToolNames(raw) as unknown;
    if (!isRecord(restored)) continue;
    switch (restored.type) {
      case 'response.created': {
        const facts = terminalFacts(restored);
        if (facts.responseId !== null) responseId = facts.responseId;
        if (facts.model !== null) model = facts.model;
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (typeof restored.delta === 'string') textParts.push(restored.delta);
        break;
      }
      case 'response.output_item.added': {
        const item = isRecord(restored.item) ? restored.item : null;
        if (item !== null && item.type === 'function_call') {
          toolCalls.push({
            index: toolCalls.length,
            id: typeof item.call_id === 'string' ? item.call_id : '',
            type: 'function',
            function: { name: typeof item.name === 'string' ? item.name : '', arguments: '' },
          });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const last = toolCalls[toolCalls.length - 1];
        if (last !== undefined && typeof restored.delta === 'string') last.function.arguments += restored.delta;
        break;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'response.completed': {
        const facts = terminalFacts(restored);
        if (facts.responseId !== null) responseId = facts.responseId;
        if (facts.model !== null) model = facts.model;
        usage = facts.usage;
        finishReason = mapChatCompletionsFinishReason(facts.status, facts.incompleteReason, toolCalls.length > 0);
        break;
      }
      default:
        break;
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const envelope: Record<string, unknown> = {
    id: responseId,
    object: 'chat.completion',
    created: createdTimestamp(options.nowMs ?? Date.now),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  };
  if (usage !== null) envelope.usage = chatCompletionsUsage(usage);
  return envelope;
}

interface AnthropicToolBlock {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
}

/**
 * Streaming assembler: Responses SSE events in, Anthropic message events out
 * (`message_start` → content blocks → `message_delta` → `message_stop`),
 * following the event vocabulary of `src/protocol/responses.ts` with the
 * codex usage mapping (cached tokens → cache_read_input_tokens).
 */
export class ResponsesToAnthropicMessagesStream {
  private responseId = '';
  private model = '';
  private messageStarted = false;
  private textBlockIndex: number | null = null;
  private nextContentBlockIndex = 0;
  private activeToolBlock: AnthropicToolBlock | null = null;
  private toolBlocksSeen = false;
  private inputUsage: CodexResponsesUsage | null = null;
  private outputTokens: number | null = null;
  private finished = false;

  /** The usage observed so far (authoritative after response.completed). */
  get observedUsage(): CodexResponsesUsage | null {
    return this.inputUsage === null ? null : { ...this.inputUsage, outputTokens: this.outputTokens };
  }

  private emitMessageStart(): Record<string, unknown> {
    this.messageStarted = true;
    const usage = this.inputUsage;
    const fields =
      usage === null
        ? { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
        : anthropicUsageFields(usage);
    return {
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: fields,
      },
    };
  }

  /** Returns the Anthropic SSE events (event name + data payload) for one Responses event. */
  push(event: unknown): readonly { readonly event: string; readonly data: Record<string, unknown> }[] {
    if (this.finished) return [];
    const restored = restoreReservedToolNames(event) as unknown;
    if (!isRecord(restored)) return [];
    const events: Array<{ readonly event: string; readonly data: Record<string, unknown> }> = [];
    const emit = (name: string, data: Record<string, unknown>): void => {
      events.push({ event: name, data });
    };

    switch (restored.type) {
      case 'response.created': {
        const facts = terminalFacts(restored);
        if (facts.responseId !== null) this.responseId = facts.responseId;
        if (facts.model !== null) this.model = facts.model;
        if (facts.usage !== null) this.inputUsage = facts.usage;
        if (!this.messageStarted) emit('message_start', this.emitMessageStart());
        return events;
      }
      case 'response.content_part.added': {
        const part = isRecord(restored.part) ? restored.part : null;
        if (part !== null && (part.type === 'output_text' || part.type === 'refusal')) {
          if (this.textBlockIndex === null && !this.messageStarted) {
            emit('message_start', this.emitMessageStart());
          }
          if (this.textBlockIndex === null) {
            this.textBlockIndex = this.nextContentBlockIndex;
            this.nextContentBlockIndex += 1;
            emit('content_block_start', {
              type: 'content_block_start',
              index: this.textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
        }
        return events;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (typeof restored.delta !== 'string') return events;
        if (!this.messageStarted) emit('message_start', this.emitMessageStart());
        if (this.textBlockIndex === null) {
          this.textBlockIndex = this.nextContentBlockIndex;
          this.nextContentBlockIndex += 1;
          emit('content_block_start', {
            type: 'content_block_start',
            index: this.textBlockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: this.textBlockIndex,
          delta: { type: 'text_delta', text: restored.delta },
        });
        return events;
      }
      case 'response.output_item.added': {
        const item = isRecord(restored.item) ? restored.item : null;
        if (item === null || item.type !== 'function_call') return events;
        if (!this.messageStarted) emit('message_start', this.emitMessageStart());
        if (this.textBlockIndex !== null) {
          emit('content_block_stop', { type: 'content_block_stop', index: this.textBlockIndex });
          this.textBlockIndex = null;
        }
        const callId = typeof item.call_id === 'string' ? item.call_id : '';
        const name = typeof item.name === 'string' ? item.name : '';
        const index = this.nextContentBlockIndex;
        this.nextContentBlockIndex += 1;
        this.toolBlocksSeen = true;
        this.activeToolBlock = { index, id: callId, name, arguments: '' };
        emit('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: callId, name, input: {} },
        });
        return events;
      }
      case 'response.function_call_arguments.delta': {
        if (typeof restored.delta !== 'string' || this.activeToolBlock === null) return events;
        this.activeToolBlock.arguments += restored.delta;
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: this.activeToolBlock.index,
          delta: { type: 'input_json_delta', partial_json: restored.delta },
        });
        return events;
      }
      case 'response.function_call_arguments.done': {
        if (this.activeToolBlock === null) return events;
        emit('content_block_stop', { type: 'content_block_stop', index: this.activeToolBlock.index });
        this.activeToolBlock = null;
        return events;
      }
      case 'response.output_text.done':
      case 'response.refusal.done': {
        if (this.textBlockIndex !== null) {
          emit('content_block_stop', { type: 'content_block_stop', index: this.textBlockIndex });
          this.textBlockIndex = null;
        }
        return events;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'response.completed': {
        const facts = terminalFacts(restored);
        if (facts.responseId !== null) this.responseId = facts.responseId;
        if (facts.model !== null) this.model = facts.model;
        if (facts.usage !== null) {
          this.inputUsage = facts.usage;
          this.outputTokens = facts.usage.outputTokens;
        }
        if (!this.messageStarted) emit('message_start', this.emitMessageStart());
        if (this.textBlockIndex !== null) {
          emit('content_block_stop', { type: 'content_block_stop', index: this.textBlockIndex });
          this.textBlockIndex = null;
        }
        if (this.activeToolBlock !== null) {
          emit('content_block_stop', { type: 'content_block_stop', index: this.activeToolBlock.index });
          this.activeToolBlock = null;
        }
        const stopReason = mapAnthropicStopReason(facts.status, facts.incompleteReason, this.toolBlocksSeen);
        emit('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: this.outputTokens === null ? {} : { output_tokens: this.outputTokens },
        });
        emit('message_stop', { type: 'message_stop' });
        this.finished = true;
        return events;
      }
      default:
        return events;
    }
  }

  /** Terminal events for a stream that ended without response.completed. */
  finish(): readonly { readonly event: string; readonly data: Record<string, unknown> }[] {
    if (this.finished) return [];
    this.finished = true;
    const events: Array<{ readonly event: string; readonly data: Record<string, unknown> }> = [];
    if (!this.messageStarted) events.push({ event: 'message_start', data: this.emitMessageStart() });
    if (this.textBlockIndex !== null) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.textBlockIndex } });
      this.textBlockIndex = null;
    }
    if (this.activeToolBlock !== null) {
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: this.activeToolBlock.index },
      });
      this.activeToolBlock = null;
    }
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: this.outputTokens === null ? {} : { output_tokens: this.outputTokens },
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }
}

/** Wraps a Responses SSE byte stream into an Anthropic messages SSE byte stream. */
export function responsesSseToAnthropicMessagesSse(upstream: ReadableStream<Uint8Array>): {
  readonly clientStream: ReadableStream<Uint8Array>;
  readonly usage: Promise<CodexResponsesUsage | null>;
} {
  const assembler = new ResponsesToAnthropicMessagesStream();
  const encoder = new TextEncoder();
  let resolveUsage!: (usage: CodexResponsesUsage | null) => void;
  const usage = new Promise<CodexResponsesUsage | null>((resolve) => {
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
 * Non-streaming aggregation: the full Responses event sequence in, one
 * Anthropic message envelope out (content array + stop_reason + usage with
 * the cached-token mapping).
 */
export function aggregateResponsesToAnthropicMessage(
  events: readonly unknown[],
  options: { readonly fallbackModel?: string } = {},
): Record<string, unknown> {
  const assembler = new ResponsesToAnthropicMessagesStream();
  const textParts: string[] = [];
  const toolBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> = [];
  let activeTool: { id: string; name: string; arguments: string } | null = null;
  for (const raw of events) {
    const restored = restoreReservedToolNames(raw) as unknown;
    if (!isRecord(restored)) continue;
    switch (restored.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (typeof restored.delta === 'string') textParts.push(restored.delta);
        assembler.push(restored);
        break;
      }
      case 'response.output_item.added': {
        const item = isRecord(restored.item) ? restored.item : null;
        if (item !== null && item.type === 'function_call') {
          activeTool = {
            id: typeof item.call_id === 'string' ? item.call_id : '',
            name: typeof item.name === 'string' ? item.name : '',
            arguments: '',
          };
        }
        assembler.push(restored);
        break;
      }
      case 'response.function_call_arguments.delta': {
        if (activeTool !== null && typeof restored.delta === 'string') activeTool.arguments += restored.delta;
        assembler.push(restored);
        break;
      }
      case 'response.function_call_arguments.done': {
        if (activeTool !== null) {
          let input: unknown = {};
          try {
            input = activeTool.arguments.length === 0 ? {} : JSON.parse(activeTool.arguments);
          } catch {
            input = {};
          }
          toolBlocks.push({ type: 'tool_use', id: activeTool.id, name: activeTool.name, input });
          activeTool = null;
        }
        assembler.push(restored);
        break;
      }
      default:
        assembler.push(restored);
        break;
    }
  }
  const terminal = events.find((event) => isRecord(event) && ['response.completed', 'response.incomplete', 'response.failed'].includes(String(event.type)));
  const facts = terminal !== undefined && isRecord(terminal) ? terminalFacts(terminal) : null;
  const stopReason = mapAnthropicStopReason(
    facts?.status ?? null,
    facts?.incompleteReason ?? null,
    toolBlocks.length > 0,
  );
  const content: Array<Record<string, unknown>> = [];
  if (textParts.length > 0) content.push({ type: 'text', text: textParts.join('') });
  for (const block of toolBlocks) content.push(block);
  const usage = assembler.observedUsage;
  return {
    id: facts?.responseId ?? '',
    type: 'message',
    role: 'assistant',
    model: facts?.model ?? options.fallbackModel ?? '',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(usage === null ? {} : { usage: anthropicUsageFields(usage) }),
  };
}
