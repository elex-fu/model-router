/**
 * apicompat PhaseA port (roadmap 1.4): Responses → Chat Completions response
 * conversion — the dual event mapping of the responses bridge, ported from
 * sub2api `backend/internal/pkg/apicompat/responses_to_chatcompletions.go`
 * (`ResponsesToChatCompletions`, `ResponsesEventToChatChunks`,
 * `FinalizeResponsesChatStream`, `BufferedResponseAccumulator`). It is the
 * mirror of reverse-response.ts: Responses SSE events (or envelopes) become
 * chat.completion(chunk) payloads, with `*.done` events contributing only the
 * argument remainder the deltas have not already delivered, an idempotent
 * finalize for streams cut before a terminal event, and usage mapped into
 * prompt/completion token details.
 *
 * Pure functions + per-stream state objects; node:crypto for id generation.
 */

import { generateChatCmplId } from './reverse-request.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// usage parsing (Responses wire → normalized facts, incl. alias fields)
// ---------------------------------------------------------------------------

export interface ResponsesUsageFacts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly inputTokensDetails: Record<string, number> | null;
  readonly outputTokensDetails: Record<string, number> | null;
}

/**
 * Parses a Responses usage object, accepting the alias spellings some
 * OpenAI-compatible upstreams emit (`prompt_tokens`/`completion_tokens`,
 * `cache_write_input_tokens`, `prompt_tokens_details`, …). Nested
 * cache-token presence overrides the top-level alias.
 */
export function parseResponsesUsage(value: unknown): ResponsesUsageFacts | null {
  if (!isRecord(value)) return null;

  let inputTokens = num(value.input_tokens);
  const promptTokens = num(value.prompt_tokens);
  if (inputTokens === 0 && promptTokens !== 0) inputTokens = promptTokens;
  let outputTokens = num(value.output_tokens);
  const completionTokens = num(value.completion_tokens);
  if (outputTokens === 0 && completionTokens !== 0) outputTokens = completionTokens;

  let cacheCreationInputTokens = num(value.cache_creation_input_tokens);
  if (cacheCreationInputTokens === 0) {
    const cacheWriteInputTokens = num(value.cache_write_input_tokens);
    const cacheCreationTokens = num(value.cache_creation_tokens);
    const cacheWriteTokens = num(value.cache_write_tokens);
    if (cacheWriteInputTokens > 0) cacheCreationInputTokens = cacheWriteInputTokens;
    else if (cacheCreationTokens > 0) cacheCreationInputTokens = cacheCreationTokens;
    else if (cacheWriteTokens > 0) cacheCreationInputTokens = cacheWriteTokens;
  }

  let inputTokensDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : null;
  if (inputTokensDetails === null && isRecord(value.prompt_tokens_details)) {
    inputTokensDetails = value.prompt_tokens_details;
  }
  let outputTokensDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : null;
  if (outputTokensDetails === null && isRecord(value.completion_tokens_details)) {
    outputTokensDetails = value.completion_tokens_details;
  }

  // Nested cache-token presence is canonical for the creation bucket.
  const nestedPresence =
    isRecord(inputTokensDetails) &&
    (inputTokensDetails.cache_write_tokens !== undefined || inputTokensDetails.cache_creation_tokens !== undefined)
      ? inputTokensDetails
      : null;
  if (nestedPresence !== null) {
    const cacheWrite = nestedPresence.cache_write_tokens;
    const cacheCreation = nestedPresence.cache_creation_tokens;
    if (cacheWrite !== undefined) cacheCreationInputTokens = Math.max(num(cacheWrite), 0);
    else if (cacheCreation !== undefined) cacheCreationInputTokens = Math.max(num(cacheCreation), 0);
  }

  let totalTokens = num(value.total_tokens);
  if (totalTokens === 0 && (inputTokens !== 0 || outputTokens !== 0)) totalTokens = inputTokens + outputTokens;

  const detailsRecord = (details: Record<string, unknown> | null): Record<string, number> | null => {
    if (details === null) return null;
    const out: Record<string, number> = {};
    for (const [key, v] of Object.entries(details)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return out;
  };

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheCreationInputTokens,
    inputTokensDetails: detailsRecord(inputTokensDetails),
    outputTokensDetails: detailsRecord(outputTokensDetails),
  };
}

// ---------------------------------------------------------------------------
// usage mapping (Responses facts → Chat Completions usage)
// ---------------------------------------------------------------------------

interface ChatTokenDetailsOut {
  cached_tokens?: number;
  audio_tokens?: number;
  cache_creation_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  accepted_prediction_tokens?: number;
  rejected_prediction_tokens?: number;
}

/** Maps Responses input token details into prompt_tokens_details (nil when all zero). */
function promptDetailsFromResponses(src: Record<string, number> | null): ChatTokenDetailsOut | null {
  if (src === null) return null;
  const cached = num(src.cached_tokens);
  const audio = num(src.audio_tokens);
  const cacheCreation = num(src.cache_creation_tokens);
  const cacheWrite = num(src.cache_write_tokens);
  if (cached === 0 && audio === 0 && cacheCreation === 0 && cacheWrite === 0) return null;
  const out: ChatTokenDetailsOut = {};
  if (cached !== 0) out.cached_tokens = cached;
  if (audio !== 0) out.audio_tokens = audio;
  if (cacheCreation !== 0) out.cache_creation_tokens = cacheCreation;
  if (cacheWrite !== 0) out.cache_write_tokens = cacheWrite;
  return out;
}

/** Maps Responses output token details into completion_tokens_details (nil when all zero). */
function completionDetailsFromResponses(src: Record<string, number> | null): ChatTokenDetailsOut | null {
  if (src === null) return null;
  const reasoning = num(src.reasoning_tokens);
  const audio = num(src.audio_tokens);
  const accepted = num(src.accepted_prediction_tokens);
  const rejected = num(src.rejected_prediction_tokens);
  if (reasoning === 0 && audio === 0 && accepted === 0 && rejected === 0) return null;
  const out: ChatTokenDetailsOut = {};
  if (reasoning !== 0) out.reasoning_tokens = reasoning;
  if (audio !== 0) out.audio_tokens = audio;
  if (accepted !== 0) out.accepted_prediction_tokens = accepted;
  if (rejected !== 0) out.rejected_prediction_tokens = rejected;
  return out;
}

export interface ChatUsageOut {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  prompt_tokens_details?: ChatTokenDetailsOut;
  completion_tokens_details?: ChatTokenDetailsOut;
}

/** Converts normalized Responses usage into the Chat Completions usage shape. */
export function chatUsageFromResponsesUsage(usage: ResponsesUsageFacts | null): ChatUsageOut | null {
  if (usage === null) return null;
  const out: ChatUsageOut = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
  let promptDetails = promptDetailsFromResponses(usage.inputTokensDetails);
  if (usage.cacheCreationInputTokens > 0) {
    if (promptDetails === null) promptDetails = {};
    if ((promptDetails.cache_write_tokens ?? 0) === 0 && (promptDetails.cache_creation_tokens ?? 0) === 0) {
      promptDetails = { ...promptDetails, cache_creation_tokens: usage.cacheCreationInputTokens };
    }
  }
  if (promptDetails !== null) out.prompt_tokens_details = promptDetails;
  const completionDetails = completionDetailsFromResponses(usage.outputTokensDetails);
  if (completionDetails !== null) out.completion_tokens_details = completionDetails;
  return out;
}

// ---------------------------------------------------------------------------
// non-streaming: Responses response → Chat Completions response
// ---------------------------------------------------------------------------

function responsesStatusToChatFinishReason(
  status: string,
  incompleteReason: string | null,
  hasToolCalls: boolean,
): string {
  switch (status) {
    case 'incomplete':
      if (incompleteReason === 'max_output_tokens') return 'length';
      if (incompleteReason === 'content_filter') return 'content_filter';
      return 'stop';
    case 'completed':
      return hasToolCalls ? 'tool_calls' : 'stop';
    default:
      return 'stop';
  }
}

/**
 * Non-streaming conversion: a Responses response envelope → one Chat
 * Completions response. Text output items concatenate into
 * choices[0].message.content; function_call items become tool_calls;
 * reasoning summaries become reasoning_content.
 */
export function responsesToChatCompletions(
  envelope: unknown,
  model: string,
  options: { readonly nowMs?: () => number } = {},
): Record<string, unknown> {
  const resp = isRecord(envelope) ? envelope : {};
  const id = text(resp.id) !== '' ? text(resp.id) : generateChatCmplId();

  const out: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created: Math.floor((options.nowMs ?? Date.now)() / 1000),
    model,
    ...(text(resp.service_tier) !== '' ? { service_tier: text(resp.service_tier) } : {}),
  };

  let contentText = '';
  let reasoningText = '';
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const rawItem of Array.isArray(resp.output) ? resp.output : []) {
    if (!isRecord(rawItem)) continue;
    switch (text(rawItem.type)) {
      case 'message': {
        for (const rawPart of Array.isArray(rawItem.content) ? rawItem.content : []) {
          if (isRecord(rawPart) && rawPart.type === 'output_text' && text(rawPart.text) !== '') {
            contentText += text(rawPart.text);
          }
        }
        break;
      }
      case 'function_call': {
        toolCalls.push({
          id: text(rawItem.call_id),
          type: 'function',
          function: { name: text(rawItem.name), arguments: text(rawItem.arguments) },
        });
        break;
      }
      case 'reasoning': {
        for (const rawSummary of Array.isArray(rawItem.summary) ? rawItem.summary : []) {
          if (isRecord(rawSummary) && rawSummary.type === 'summary_text' && text(rawSummary.text) !== '') {
            reasoningText += text(rawSummary.text);
          }
        }
        break;
      }
      default:
        // web_search_call 等：结果已并入文本输出，静默跳过。
        break;
    }
  }

  const message: Record<string, unknown> = { role: 'assistant' };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (contentText !== '') message.content = contentText;
  if (reasoningText !== '') message.reasoning_content = reasoningText;

  const incomplete = isRecord(resp.incomplete_details) ? resp.incomplete_details : null;
  const finishReason = responsesStatusToChatFinishReason(
    text(resp.status),
    incomplete !== null ? text(incomplete.reason) : null,
    toolCalls.length > 0,
  );

  out.choices = [{ index: 0, message, finish_reason: finishReason }];

  const usage = chatUsageFromResponsesUsage(parseResponsesUsage(resp.usage));
  if (usage !== null) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------------------
// streaming: Responses events → Chat chunks (stateful converter)
// ---------------------------------------------------------------------------

interface ChatChunkToolCall {
  readonly index: number;
  readonly id: string;
  readonly type: string;
  readonly function: { name: string; arguments: string };
}

interface ChatDelta {
  readonly role?: string;
  readonly content?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: Record<string, unknown>[];
}

function chunkToolCall(call: ChatChunkToolCall): Record<string, unknown> {
  const fn: Record<string, unknown> = { arguments: call.function.arguments };
  if (call.function.name !== '') fn.name = call.function.name;
  const out: Record<string, unknown> = { index: call.index, function: fn };
  if (call.id !== '') out.id = call.id;
  if (call.type !== '') out.type = call.type;
  return out;
}

/**
 * Converts a sequence of Responses SSE events into chat.completion.chunk
 * payloads. `push` handles one event; `finalize` emits the terminal finish
 * chunk when the stream ended without a terminal event (upstream disconnect)
 * and is idempotent after a real one.
 */
export class ResponsesEventToChatStream {
  private id: string;
  private model = '';
  private readonly createdAt: number;
  private serviceTier = '';
  private sentRole = false;
  private sawToolCall = false;
  private sawText = false;
  private finalized = false;
  private nextToolCallIndex = 0;
  private readonly outputIndexToToolIndex = new Map<number, number>();
  private readonly outputIndexToArguments = new Map<number, string>();

  private readonly includeUsage: boolean;
  private usage: ChatUsageOut | null = null;

  constructor(options: { readonly includeUsage?: boolean; readonly nowMs?: () => number } = {}) {
    this.id = generateChatCmplId();
    this.createdAt = Math.floor((options.nowMs ?? Date.now)() / 1000);
    this.includeUsage = options.includeUsage ?? false;
  }

  /** The chatcmpl id accumulated for this stream. */
  get chatId(): string {
    return this.id;
  }

  /** The usage observed so far (authoritative after the terminal event). */
  get observedUsage(): ChatUsageOut | null {
    return this.usage;
  }

  private deltaChunk(delta: ChatDelta): Record<string, unknown> {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      ...(this.serviceTier === '' ? {} : { service_tier: this.serviceTier }),
      choices: [{ index: 0, delta, finish_reason: null }],
    };
  }

  private finishChunk(finishReason: string): Record<string, unknown> {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      ...(this.serviceTier === '' ? {} : { service_tier: this.serviceTier }),
      choices: [{ index: 0, delta: { content: '' }, finish_reason: finishReason }],
    };
  }

  private usageChunk(): Record<string, unknown> {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      ...(this.serviceTier === '' ? {} : { service_tier: this.serviceTier }),
      choices: [],
      usage: this.usage,
    };
  }

  /** Converts one Responses SSE event into zero or more chunks. */
  push(event: unknown): Record<string, unknown>[] {
    if (!isRecord(event)) return [];
    const type = text(event.type);

    switch (type) {
      case 'response.created':
        return this.handleCreated(event);
      case 'response.output_text.delta':
        return this.handleTextDelta(event);
      case 'response.output_item.added':
        return this.handleOutputItemAdded(event);
      case 'response.function_call_arguments.delta':
      // custom/freeform 工具（如新版 apply_patch）的输入增量与 function_call
      // 参数增量同形，均按 output_index 累加到对应工具调用。
      case 'response.custom_tool_call_input.delta':
        return this.handleArgumentsDelta(event);
      case 'response.function_call_arguments.done':
      case 'response.custom_tool_call_input.done':
        return this.handleArgumentsDone(event, type);
      case 'response.reasoning_summary_text.delta':
      // 原始推理文本增量（真实 Codex 客户端消费的 reasoning_text.delta），
      // 与 reasoning summary 一样映射为 reasoning_content。
      case 'response.reasoning_text.delta':
        return this.handleReasoningDelta(event);
      case 'response.reasoning_summary_text.done':
        return [];
      // response.done 是 Realtime/WS 与项目透传路径使用的终止别名；普通
      // Responses HTTP SSE 的公开终止事件仍以 response.completed 为主。
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete':
      case 'response.failed':
        return this.handleCompleted(event);
      default:
        return [];
    }
  }

  /**
   * Terminal chunks for a stream that ended without a completion event;
   * idempotent after a real terminal event already emitted the finish chunk.
   */
  finalize(): Record<string, unknown>[] {
    if (this.finalized) return [];
    this.finalized = true;
    const chunks: Record<string, unknown>[] = [this.finishChunk(this.sawToolCall ? 'tool_calls' : 'stop')];
    if (this.includeUsage && this.usage !== null) chunks.push(this.usageChunk());
    return chunks;
  }

  private handleCreated(event: Record<string, unknown>): Record<string, unknown>[] {
    const response = isRecord(event.response) ? event.response : null;
    if (response !== null) {
      if (text(response.id) !== '') this.id = text(response.id);
      if (this.model === '' && text(response.model) !== '') this.model = text(response.model);
      if (text(response.service_tier) !== '') this.serviceTier = text(response.service_tier);
    }
    if (this.sentRole) return [];
    this.sentRole = true;
    return [this.deltaChunk({ role: 'assistant' })];
  }

  private handleTextDelta(event: Record<string, unknown>): Record<string, unknown>[] {
    const delta = text(event.delta);
    if (delta === '') return [];
    this.sawText = true;
    return [this.deltaChunk({ content: delta })];
  }

  private handleOutputItemAdded(event: Record<string, unknown>): Record<string, unknown>[] {
    // function_call 与 custom_tool_call 均按工具调用注册，以便后续
    // *_input.delta / *_arguments.delta 能映射到正确的工具索引。
    const item = isRecord(event.item) ? event.item : null;
    if (item === null || (text(item.type) !== 'function_call' && text(item.type) !== 'custom_tool_call')) {
      return [];
    }
    this.sawToolCall = true;
    const idx = this.nextToolCallIndex;
    const outputIndex = num(event.output_index);
    this.outputIndexToToolIndex.set(outputIndex, idx);
    this.nextToolCallIndex += 1;
    return [
      this.deltaChunk({
        tool_calls: [
          chunkToolCall({
            index: idx,
            id: text(item.call_id),
            type: 'function',
            function: { name: text(item.name), arguments: '' },
          }),
        ],
      }),
    ];
  }

  private handleArgumentsDelta(event: Record<string, unknown>): Record<string, unknown>[] {
    const delta = text(event.delta);
    if (delta === '') return [];
    const outputIndex = num(event.output_index);
    const idx = this.outputIndexToToolIndex.get(outputIndex);
    if (idx === undefined) return [];
    this.outputIndexToArguments.set(outputIndex, (this.outputIndexToArguments.get(outputIndex) ?? '') + delta);
    return [
      this.deltaChunk({
        tool_calls: [chunkToolCall({ index: idx, id: '', type: '', function: { name: '', arguments: delta } })],
      }),
    ];
  }

  private handleArgumentsDone(event: Record<string, unknown>, type: string): Record<string, unknown>[] {
    const outputIndex = num(event.output_index);
    const idx = this.outputIndexToToolIndex.get(outputIndex);
    if (idx === undefined) return [];

    // *.done 只补差量：deltas 已经交付的部分不再重复下发。
    const completed = type === 'response.custom_tool_call_input.done' ? text(event.input) : text(event.arguments);
    const current = this.outputIndexToArguments.get(outputIndex) ?? '';
    if (completed === '' || !completed.startsWith(current) || completed === current) return [];

    const remainder = completed.slice(current.length);
    this.outputIndexToArguments.set(outputIndex, completed);
    return [
      this.deltaChunk({
        tool_calls: [chunkToolCall({ index: idx, id: '', type: '', function: { name: '', arguments: remainder } })],
      }),
    ];
  }

  private handleReasoningDelta(event: Record<string, unknown>): Record<string, unknown>[] {
    const delta = text(event.delta);
    if (delta === '') return [];
    return [this.deltaChunk({ reasoning_content: delta })];
  }

  private handleCompleted(event: Record<string, unknown>): Record<string, unknown>[] {
    this.finalized = true;
    let finishReason = 'stop';

    const usage = parseResponsesUsage(event.usage);
    if (usage !== null) this.usage = chatUsageFromResponsesUsage(usage);

    const response = isRecord(event.response) ? event.response : null;
    if (response !== null) {
      const responseUsage = parseResponsesUsage(response.usage);
      if (responseUsage !== null) this.usage = chatUsageFromResponsesUsage(responseUsage);
      if (text(response.service_tier) !== '') this.serviceTier = text(response.service_tier);

      switch (text(response.status)) {
        case 'incomplete': {
          const incomplete = isRecord(response.incomplete_details) ? response.incomplete_details : null;
          const reason = incomplete !== null ? text(incomplete.reason) : '';
          if (reason === 'max_output_tokens') finishReason = 'length';
          else if (reason === 'content_filter') finishReason = 'content_filter';
          break;
        }
        case 'completed':
          if (this.sawToolCall) finishReason = 'tool_calls';
          break;
        default:
          break;
      }
    } else if (this.sawToolCall) {
      finishReason = 'tool_calls';
    }

    const chunks: Record<string, unknown>[] = [this.finishChunk(finishReason)];
    if (this.includeUsage && this.usage !== null) chunks.push(this.usageChunk());
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// BufferedResponseAccumulator: rebuild output from deltas when the terminal
// event carries an empty output array (non-streaming aggregation paths).
// ---------------------------------------------------------------------------

interface BufferedFuncCall {
  readonly outputIndex: number;
  readonly callId: string;
  readonly name: string;
  args: string;
}

export class BufferedResponseAccumulator {
  private textValue = '';
  private reasoningValue = '';
  private readonly funcCalls: BufferedFuncCall[] = [];
  private readonly outputIndexToFuncIdx = new Map<number, number>();

  /** Accumulates content from one Responses SSE event; other types are ignored. */
  processEvent(event: unknown): void {
    if (!isRecord(event)) return;
    const type = text(event.type);
    const outputIndex = num(event.output_index);
    switch (type) {
      case 'response.output_text.delta':
        if (text(event.delta) !== '') this.textValue += text(event.delta);
        break;
      case 'response.output_item.added': {
        const item = isRecord(event.item) ? event.item : null;
        if (item !== null && (text(item.type) === 'function_call' || text(item.type) === 'custom_tool_call')) {
          this.outputIndexToFuncIdx.set(outputIndex, this.funcCalls.length);
          this.funcCalls.push({
            outputIndex,
            callId: text(item.call_id),
            name: text(item.name),
            args: '',
          });
        }
        break;
      }
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta': {
        const delta = text(event.delta);
        if (delta !== '') {
          const idx = this.outputIndexToFuncIdx.get(outputIndex);
          if (idx !== undefined) this.funcCalls[idx].args += delta;
        }
        break;
      }
      case 'response.function_call_arguments.done':
      case 'response.custom_tool_call_input.done': {
        const completed = type === 'response.custom_tool_call_input.done' ? text(event.input) : text(event.arguments);
        if (completed !== '') {
          const idx = this.outputIndexToFuncIdx.get(outputIndex);
          if (idx !== undefined) this.funcCalls[idx].args = completed;
        }
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (text(event.delta) !== '') this.reasoningValue += text(event.delta);
        break;
      default:
        break;
    }
  }

  /** Whether any content has been accumulated. */
  hasContent(): boolean {
    return this.textValue.length > 0 || this.funcCalls.length > 0 || this.reasoningValue.length > 0;
  }

  /** Builds output items in the order responsesToChatCompletions expects: reasoning → message → function_calls. */
  buildOutput(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (this.reasoningValue.length > 0) {
      out.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: this.reasoningValue }] });
    }
    if (this.textValue.length > 0) {
      out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.textValue }] });
    }
    for (const call of this.funcCalls) {
      out.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.args });
    }
    return out;
  }

  /**
   * Fills `response.output` from the accumulated stream when the terminal
   * event delivered an empty array; also backfills empty function-call
   * arguments from authoritative argument-done events.
   */
  supplementResponseOutput(response: Record<string, unknown>): void {
    const output = Array.isArray(response.output) ? response.output : [];
    if (output.length === 0) {
      if (this.hasContent()) response.output = this.buildOutput();
      return;
    }
    for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
      const item = output[outputIndex];
      if (!isRecord(item) || text(item.type) !== 'function_call' || text(item.arguments) !== '') continue;
      for (const call of this.funcCalls) {
        const matchesCallId = text(item.call_id) !== '' && text(item.call_id) === call.callId;
        if (!matchesCallId && call.outputIndex !== outputIndex) continue;
        if (call.args.length > 0) item.arguments = call.args;
        break;
      }
    }
  }
}
