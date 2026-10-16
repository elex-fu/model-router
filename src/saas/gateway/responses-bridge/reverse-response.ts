/**
 * apicompat PhaseA port (roadmap 1.4): Chat Completions → Responses
 * conversion — the response half of the `responses→openai` bridge. Ported
 * from sub2api `backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go`
 * (`ChatCompletionsResponseToResponses`, `ChatCompletionsChunkToResponsesEvents`,
 * `FinalizeChatCompletionsResponsesStream`) and
 * `responses_stream_event_wire.go` (the wire field-presence rules strict
 * Responses clients like Codex require: output_index/content_index at 0,
 * function_call items always carrying call_id/name/arguments, message items
 * always carrying content:[]).
 *
 * Pure functions + a per-request stream state object; no I/O. Random ids come
 * from node:crypto only.
 */

import {
  flattenNamespaceToolName,
  generateItemId,
  generateResponsesId,
  type NamespacedToolName,
} from './reverse-request.js';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isValidJson(value: string): boolean {
  if (value.length === 0) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** Tool-identity mapping captured from the request direction. */
export interface ChatToResponsesToolMapping {
  readonly customTools: ReadonlySet<string>;
  readonly functionTools: ReadonlySet<string>;
  readonly toolSearch: boolean;
  readonly namespaceTools: ReadonlyMap<string, NamespacedToolName>;
}

const TOOL_SEARCH_PROXY_NAME = 'tool_search';

// ---------------------------------------------------------------------------
// custom tool call helpers
// ---------------------------------------------------------------------------

/**
 * Restores the exact downgraded custom-tool name and namespace-prefixed
 * aliases chat models sometimes infer from neighboring flattened namespace
 * tools. Returns null when the name belongs to a declared function/namespace
 * tool or is ambiguous.
 */
export function customToolCallName(
  name: string,
  customTools: ReadonlySet<string>,
  functionTools: ReadonlySet<string>,
  namespaceTools: ReadonlyMap<string, NamespacedToolName>,
): string | null {
  if (functionTools.has(name)) return null;
  if (customTools.has(name)) return name;
  if (namespaceTools.has(name)) return null;
  let match = '';
  for (const customName of customTools) {
    for (const namespaceTool of namespaceTools.values()) {
      if (flattenNamespaceToolName(namespaceTool.namespace, customName) !== name) continue;
      if (match !== '' && match !== customName) return null;
      match = customName;
    }
  }
  return match !== '' ? match : null;
}

/**
 * Restores a custom tool's free-text input from the downgraded function
 * arguments: prefers the `{"input": "…"}` field; when the model did not
 * follow the schema the raw arguments go back verbatim for client-side
 * validation/retry.
 */
export function extractCustomToolCallInput(argumentsText: string): string {
  const trimmed = argumentsText.trim();
  if (trimmed === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!isRecord(parsed)) return trimmed;
  if ('input' in parsed) {
    return typeof parsed.input === 'string' ? parsed.input : trimmed;
  }
  if (Object.keys(parsed).length === 0) return '';
  return trimmed;
}

/** tool_search_call 线上形态的 arguments：JSON 对象；非法 JSON 按字符串值兜底。 */
function toolSearchCallArgumentsValue(argumentsText: string): unknown {
  const trimmed = argumentsText.trim();
  if (trimmed === '') return {};
  if (isValidJson(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to the string fallback
    }
  }
  return argumentsText;
}

// ---------------------------------------------------------------------------
// usage mapping (Chat → Responses)
// ---------------------------------------------------------------------------

interface ChatTokenDetailsFact {
  readonly cachedTokens: number;
  readonly audioTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheWriteTokens: number;
}

function tokenDetailsFact(value: unknown): ChatTokenDetailsFact | null {
  if (!isRecord(value)) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    cachedTokens: num(value.cached_tokens),
    audioTokens: num(value.audio_tokens),
    cacheCreationTokens: num(value.cache_creation_tokens),
    cacheWriteTokens: num(value.cache_write_tokens),
  };
}

export interface ResponsesUsageRecord {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  cache_creation_input_tokens?: number;
  input_tokens_details?: Record<string, unknown>;
}

/** Converts a Chat Completions usage object into the Responses usage shape. */
export function chatCompletionsUsageToResponsesUsage(usage: unknown): ResponsesUsageRecord | null {
  if (!isRecord(usage)) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const promptTokens = num(usage.prompt_tokens);
  const completionTokens = num(usage.completion_tokens);
  const totalTokens = num(usage.total_tokens);
  const out: ResponsesUsageRecord = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens === 0 ? promptTokens + completionTokens : totalTokens,
  };
  const details = tokenDetailsFact(usage.prompt_tokens_details);
  if (
    details !== null &&
    (details.cachedTokens > 0 || details.cacheCreationTokens > 0 || details.cacheWriteTokens > 0)
  ) {
    const inputDetails: Record<string, unknown> = {};
    if (details.cachedTokens !== 0) inputDetails.cached_tokens = details.cachedTokens;
    if (details.audioTokens !== 0) inputDetails.audio_tokens = details.audioTokens;
    if (details.cacheCreationTokens !== 0) inputDetails.cache_creation_tokens = details.cacheCreationTokens;
    if (details.cacheWriteTokens !== 0) inputDetails.cache_write_tokens = details.cacheWriteTokens;
    out.input_tokens_details = inputDetails;
    out.cache_creation_input_tokens =
      details.cacheWriteTokens > 0 ? details.cacheWriteTokens : details.cacheCreationTokens;
  }
  return out;
}

// ---------------------------------------------------------------------------
// output item wire shapes
// ---------------------------------------------------------------------------

function outputTextPart(textValue: string): Record<string, unknown> {
  return { type: 'output_text', text: textValue };
}

function defaultContentPart(type: string, textValue: string): Record<string, unknown> {
  // ResponsesContentPart default marshaling: text is omitempty.
  return textValue === '' ? { type } : { type, text: textValue };
}

function defaultMessageItem(id: string, textValue: string, status: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    role: 'assistant',
    content: [defaultContentPart('output_text', textValue)],
    status,
  };
}

// ---------------------------------------------------------------------------
// non-streaming: ChatCompletionsResponse → Responses response
// ---------------------------------------------------------------------------

function messageReasoningText(message: Record<string, unknown>): string {
  const reasoningContent = text(message.reasoning_content);
  if (reasoningContent !== '') return reasoningContent;
  return text(message.reasoning);
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        texts.push(part.text);
      }
    }
    return texts.join('\n\n');
  }
  return '';
}

function chatMessageToResponsesOutput(
  message: Record<string, unknown>,
  mapping: ChatToResponsesToolMapping,
): Record<string, unknown>[] {
  const outputs: Record<string, unknown>[] = [];
  const reasoning = messageReasoningText(message);
  if (reasoning !== '') {
    outputs.push({ type: 'reasoning', id: generateItemId(), summary: [{ type: 'summary_text', text: reasoning }] });
  }

  let bodyText = messageContentText(message.content);
  if (bodyText === '' && reasoning.trim() !== '' && !Array.isArray(message.tool_calls)) {
    bodyText = reasoning;
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (bodyText !== '' || toolCalls.length === 0) {
    outputs.push(defaultMessageItem(generateItemId(), bodyText, 'completed'));
  }

  for (const rawCall of toolCalls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue;
    const id = text(rawCall.id);
    const name = text(rawCall.function.name);
    let argumentsText = text(rawCall.function.arguments);
    if (argumentsText.trim() === '') argumentsText = '{}';

    const customName = customToolCallName(name, mapping.customTools, mapping.functionTools, mapping.namespaceTools);
    if (customName !== null) {
      const customInput = extractCustomToolCallInput(argumentsText);
      outputs.push({
        type: 'custom_tool_call',
        id: generateItemId(),
        ...(id === '' ? {} : { call_id: id }),
        ...(customName === '' ? {} : { name: customName }),
        ...(customInput === '' ? {} : { input: customInput }),
        status: 'completed',
      });
      continue;
    }
    if (mapping.toolSearch && name === TOOL_SEARCH_PROXY_NAME) {
      outputs.push({
        type: 'tool_search_call',
        id: generateItemId(),
        call_id: id,
        execution: 'client',
        arguments: toolSearchCallArgumentsValue(argumentsText),
        status: 'completed',
      });
      continue;
    }
    // Ordinary Responses function_call arguments must contain valid JSON; do
    // not emit a truncated non-streaming call as completed (it would poison
    // the next request the same way the streaming guard does).
    if (!isValidJson(argumentsText)) continue;
    const namespace = mapping.namespaceTools.get(name);
    if (namespace !== undefined) {
      outputs.push({
        type: 'function_call',
        id: generateItemId(),
        ...(id === '' ? {} : { call_id: id }),
        ...(namespace.name === '' ? {} : { name: namespace.name }),
        namespace: namespace.namespace,
        arguments: argumentsText,
        status: 'completed',
      });
      continue;
    }
    outputs.push({
      type: 'function_call',
      id: generateItemId(),
      ...(id === '' ? {} : { call_id: id }),
      ...(name === '' ? {} : { name }),
      arguments: argumentsText,
      status: 'completed',
    });
  }
  return outputs;
}

export interface ChatToResponsesEnvelopeOptions extends ChatToResponsesToolMapping {
  /** Client-requested model echoed back on the envelope (falls back to the upstream's). */
  readonly model?: string;
  readonly nowMs?: () => number;
}

/**
 * Non-streaming conversion: a Chat Completions response body → one Responses
 * response envelope. `finish_reason: "length"` becomes
 * `status:"incomplete"` + `incomplete_details.reason:"max_output_tokens"`.
 */
export function chatCompletionsResponseToResponses(
  upstreamBody: unknown,
  options: ChatToResponsesEnvelopeOptions,
): Record<string, unknown> {
  const resp = isRecord(upstreamBody) ? upstreamBody : null;
  const id = resp !== null && text(resp.id) !== '' ? text(resp.id) : generateResponsesId();
  const createdMs = options.nowMs ?? Date.now;
  const createdAt =
    resp !== null && typeof resp.created === 'number' && resp.created > 0
      ? resp.created
      : Math.floor(createdMs() / 1000);

  const model = options.model ?? (resp !== null ? text(resp.model) : '');
  const out: Record<string, unknown> = {
    id,
    object: 'response',
    created_at: createdAt,
    model,
    status: 'completed',
    output: [],
    ...(resp !== null && text(resp.service_tier) !== '' ? { service_tier: text(resp.service_tier) } : {}),
  };

  if (resp === null) {
    out.output = [defaultMessageItem(generateItemId(), '', 'completed')];
    return out;
  }
  if (model === '') out.model = text(resp.model);

  const choices = Array.isArray(resp.choices) ? resp.choices : [];
  if (choices.length > 0 && isRecord(choices[0])) {
    const choice = choices[0];
    const message = isRecord(choice.message) ? choice.message : {};
    out.output = chatMessageToResponsesOutput(message, options);
    if (choice.finish_reason === 'length') {
      out.status = 'incomplete';
      out.incomplete_details = { reason: 'max_output_tokens' };
    }
  }
  if (!Array.isArray(out.output) || (out.output as unknown[]).length === 0) {
    out.output = [defaultMessageItem(generateItemId(), '', 'completed')];
  }
  const usage = chatCompletionsUsageToResponsesUsage(resp.usage);
  if (usage !== null) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------------------
// streaming: Chat chunks → Responses events (wire-shaped)
// ---------------------------------------------------------------------------

interface StoredToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatToResponsesStreamOptions extends ChatToResponsesToolMapping {
  readonly model?: string;
  readonly nowMs?: () => number;
}

/**
 * Stateful converter driving one Responses SSE stream from Chat Completions
 * chunks. `push` converts a chunk into zero or more wire-shaped Responses
 * events; `finalize` emits the terminal events (idempotent, also used when
 * the upstream stream is cut); `validateToolCallArguments` guards against
 * emitting truncated tool calls a strict client would persist.
 */
export class ChatCompletionsToResponsesStream {
  private responseId: string;
  private model: string;
  private readonly createdAt: number;
  private serviceTier = '';
  private sequenceNumber = 0;
  private createdSent = false;
  private completedSent = false;

  private nextOutputIndex = 0;

  private reasoningItemId = '';
  private reasoningIndex = 0;
  private reasoningOpen = false;
  private reasoningDone = false;

  private messageItemId = '';
  private messageIndex = 0;
  private textPartOpen = false;

  private text = '';
  private reasoning = '';

  private readonly toolCalls = new Map<number, StoredToolCall>();
  private readonly toolItemIds = new Map<number, string>();
  private readonly toolOutputIndex = new Map<number, number>();

  private readonly customTools: ReadonlySet<string>;
  private readonly functionTools: ReadonlySet<string>;
  private readonly toolSearchDeclared: boolean;
  private readonly namespaceTools: ReadonlyMap<string, NamespacedToolName>;

  private readonly toolIsCustom = new Map<number, boolean>();
  private readonly toolIsToolSearch = new Map<number, boolean>();
  private readonly toolNamespace = new Map<number, NamespacedToolName>();
  private readonly toolAnnounced = new Map<number, boolean>();

  private finishReason = '';
  private usage: ResponsesUsageRecord | null = null;

  constructor(options: ChatToResponsesStreamOptions) {
    this.responseId = generateResponsesId();
    this.model = options.model ?? '';
    this.createdAt = Math.floor((options.nowMs ?? Date.now)() / 1000);
    this.customTools = options.customTools;
    this.functionTools = options.functionTools;
    this.toolSearchDeclared = options.toolSearch;
    this.namespaceTools = options.namespaceTools;
  }

  /** The usage observed so far (authoritative once finalized). */
  get observedUsage(): ResponsesUsageRecord | null {
    return this.usage;
  }

  private allocOutputIndex(): number {
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    return index;
  }

  private event(type: string, fields: Record<string, unknown>): Record<string, unknown> {
    const seq = this.sequenceNumber;
    this.sequenceNumber += 1;
    return { type, sequence_number: seq, ...fields };
  }

  private responseShell(status: string, extra?: Record<string, unknown>): Record<string, unknown> {
    const response: Record<string, unknown> = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      model: this.model,
      status,
      ...(this.serviceTier === '' ? {} : { service_tier: this.serviceTier }),
      ...extra,
    };
    return response;
  }

  /** Converts one Chat Completions chunk into zero or more wire events. */
  push(chunk: unknown): Record<string, unknown>[] {
    if (!isRecord(chunk)) return [];
    if (text(chunk.id) !== '') this.responseId = text(chunk.id);
    if (this.model === '' && text(chunk.model) !== '') this.model = text(chunk.model);
    if (text(chunk.service_tier) !== '') this.serviceTier = text(chunk.service_tier);
    if (chunk.usage !== undefined && chunk.usage !== null) {
      this.usage = chatCompletionsUsageToResponsesUsage(chunk.usage);
    }

    const events: Record<string, unknown>[] = [];
    events.push(...this.ensureCreated());

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      if (!isRecord(rawChoice)) continue;
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};

      // Reasoning is its own output item and must be opened before the first
      // delta, otherwise a strict client discards the delta. The leading
      // empty-string reasoning delta upstreams send is filtered out.
      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : undefined;
      if (reasoning !== undefined && reasoning !== '') {
        events.push(...this.ensureReasoningItem());
        this.reasoning += reasoning;
        events.push(
          this.event('response.reasoning_summary_text.delta', {
            item_id: this.reasoningItemId,
            output_index: this.reasoningIndex,
            summary_index: 0,
            delta: reasoning,
          }),
        );
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        // First real content closes the reasoning item, then opens the
        // message item and its output_text content part.
        events.push(...this.closeReasoningItem());
        events.push(...this.ensureMessageItem());
        events.push(...this.ensureTextPart());
        this.text += delta.content;
        events.push(
          this.event('response.output_text.delta', {
            item_id: this.messageItemId,
            output_index: this.messageIndex,
            content_index: 0,
            delta: delta.content,
          }),
        );
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of toolCalls) {
        if (!isRecord(rawCall)) continue;
        const idx = typeof rawCall.index === 'number' ? rawCall.index : 0;
        const fn = isRecord(rawCall.function) ? rawCall.function : {};
        let stored = this.toolCalls.get(idx);
        if (stored === undefined) {
          // A tool call closes any open reasoning item first.
          events.push(...this.closeReasoningItem());
          // Some upstreams (GLM/Zhipu) pack id+name+arguments into the first
          // tool_call chunk; reset the arguments so the shared accumulation
          // below cannot double-count them.
          stored = {
            id: text(rawCall.id) !== '' ? text(rawCall.id) : generateItemId(),
            name: text(fn.name),
            arguments: '',
          };
          this.toolCalls.set(idx, stored);
          this.toolItemIds.set(idx, generateItemId());
          this.toolOutputIndex.set(idx, this.allocOutputIndex());
        } else {
          if (text(rawCall.id) !== '') stored.id = text(rawCall.id);
          if (text(fn.name) !== '') stored.name = text(fn.name);
        }
        events.push(...this.announceToolItem(idx, stored, false));
        const deltaArguments = text(fn.arguments);
        if (deltaArguments !== '') {
          stored.arguments += deltaArguments;
          // 未宣告（名字未到）时仅累积，宣告时统一补发；custom 调用的
          // arguments 是包裹 input 的 JSON 片段，无法增量还原为自由文本，
          // 收尾时一次性下发；tool_search 调用同样收尾时全量下发。
          if (this.toolAnnounced.get(idx) === true && !this.toolIsCustom.get(idx) && !this.toolIsToolSearch.get(idx)) {
            events.push(
              this.event('response.function_call_arguments.delta', {
                item_id: this.toolItemIds.get(idx) ?? '',
                output_index: this.toolOutputIndex.get(idx) ?? 0,
                ...(stored.id === '' ? {} : { call_id: stored.id }),
                ...(stored.name === '' ? {} : { name: stored.name }),
                delta: deltaArguments,
              }),
            );
          }
        }
      }
      if (typeof rawChoice.finish_reason === 'string' && rawChoice.finish_reason !== '') {
        this.finishReason = rawChoice.finish_reason;
      }
    }
    return events;
  }

  /** Terminal events; idempotent — a second call returns none. */
  finalize(): Record<string, unknown>[] {
    if (this.completedSent) return [];
    const events: Record<string, unknown>[] = [];
    events.push(...this.ensureCreated());

    // Close a reasoning item that never transitioned to content (reasoning-only
    // or empty completion); synthesize visible text when nothing else was said.
    events.push(...this.closeReasoningItem());
    events.push(...this.synthesizeReasoningFallbackMessage());

    if (this.messageItemId !== '') {
      if (this.textPartOpen) {
        events.push(
          this.event('response.output_text.done', {
            item_id: this.messageItemId,
            output_index: this.messageIndex,
            content_index: 0,
            text: this.text,
          }),
        );
        events.push(
          this.event('response.content_part.done', {
            item_id: this.messageItemId,
            output_index: this.messageIndex,
            content_index: 0,
            part: { type: 'output_text', text: this.text, annotations: [], logprobs: [] },
          }),
        );
      }
      events.push(
        this.event('response.output_item.done', {
          output_index: this.messageIndex,
          item: defaultMessageItem(this.messageItemId, this.text, 'completed'),
        }),
      );
    }

    // Close every tool item opened during the stream: a strict client only
    // finalizes a tool call after arguments.done + output_item.done.
    events.push(...this.closeToolItems());

    let status = 'completed';
    let incompleteDetails: Record<string, unknown> | undefined;
    if (this.finishReason === 'length') {
      status = 'incomplete';
      incompleteDetails = { reason: 'max_output_tokens' };
    }

    this.completedSent = true;
    events.push(
      this.event('response.completed', {
        response: this.responseShell(status, {
          output: this.chatOutput(),
          ...(this.usage === null ? {} : { usage: this.usage }),
          ...(incompleteDetails === undefined ? {} : { incomplete_details: incompleteDetails }),
        }),
      }),
    );
    return events;
  }

  /**
   * Checks accumulated function-call arguments before finalization. A tool
   * call whose argument stream was truncated must not be emitted as a
   * completed item: strict clients persist it and replay it on the next turn,
   * where the chat upstream rejects the whole request. Returns the error
   * message or null.
   */
  validateToolCallArguments(): string | null {
    for (const [idx, toolCall] of this.toolCalls) {
      if (this.toolIsCustom.get(idx) === true || this.toolIsToolSearch.get(idx) === true) continue;
      const argumentsText = toolCall.arguments.trim();
      if (argumentsText === '') continue;
      if (!isValidJson(argumentsText)) {
        return `tool call ${JSON.stringify(toolCall.id)} (${toolCall.name}) arguments are invalid JSON`;
      }
    }
    return null;
  }

  private ensureCreated(): Record<string, unknown>[] {
    if (this.createdSent) return [];
    this.createdSent = true;
    return [
      this.event('response.created', {
        response: this.responseShell('in_progress', { output: [] }),
      }),
    ];
  }

  private ensureReasoningItem(): Record<string, unknown>[] {
    if (this.reasoningOpen || this.reasoningDone) return [];
    this.reasoningOpen = true;
    this.reasoningItemId = generateItemId();
    this.reasoningIndex = this.allocOutputIndex();
    return [
      this.event('response.output_item.added', {
        output_index: this.reasoningIndex,
        item: { type: 'reasoning', id: this.reasoningItemId, status: 'in_progress', summary: [] },
      }),
      this.event('response.reasoning_summary_part.added', {
        item_id: this.reasoningItemId,
        output_index: this.reasoningIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    ];
  }

  private closeReasoningItem(): Record<string, unknown>[] {
    if (!this.reasoningOpen) return [];
    this.reasoningOpen = false;
    this.reasoningDone = true;
    return [
      this.event('response.reasoning_summary_text.done', {
        item_id: this.reasoningItemId,
        output_index: this.reasoningIndex,
        summary_index: 0,
        text: this.reasoning,
      }),
      this.event('response.reasoning_summary_part.done', {
        item_id: this.reasoningItemId,
        output_index: this.reasoningIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: this.reasoning },
      }),
      this.event('response.output_item.done', {
        output_index: this.reasoningIndex,
        item: {
          type: 'reasoning',
          id: this.reasoningItemId,
          status: 'completed',
          summary: [{ type: 'summary_text', text: this.reasoning }],
        },
      }),
    ];
  }

  private synthesizeReasoningFallbackMessage(): Record<string, unknown>[] {
    if (this.messageItemId !== '' || this.text.length > 0 || this.reasoning.length === 0 || this.toolCalls.size > 0) {
      return [];
    }
    const fallbackText = this.reasoning;
    if (fallbackText.trim() === '') return [];
    const events = [
      ...this.ensureMessageItem(),
      ...this.ensureTextPart(),
      this.event('response.output_text.delta', {
        item_id: this.messageItemId,
        output_index: this.messageIndex,
        content_index: 0,
        delta: fallbackText,
      }),
    ];
    this.text += fallbackText;
    return events;
  }

  private ensureMessageItem(): Record<string, unknown>[] {
    if (this.messageItemId !== '') return [];
    this.messageItemId = generateItemId();
    this.messageIndex = this.allocOutputIndex();
    return [
      this.event('response.output_item.added', {
        output_index: this.messageIndex,
        item: {
          type: 'message',
          id: this.messageItemId,
          role: 'assistant',
          status: 'in_progress',
          content: [outputTextPart('')],
        },
      }),
    ];
  }

  private ensureTextPart(): Record<string, unknown>[] {
    if (this.textPartOpen) return [];
    this.textPartOpen = true;
    return [
      this.event('response.content_part.added', {
        item_id: this.messageItemId,
        output_index: this.messageIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      }),
    ];
  }

  private announceToolItem(idx: number, stored: StoredToolCall, force: boolean): Record<string, unknown>[] {
    if (this.toolAnnounced.get(idx) === true) return [];
    if (
      !force &&
      stored.name === '' &&
      (this.customTools.size > 0 ||
        this.functionTools.size > 0 ||
        this.toolSearchDeclared ||
        this.namespaceTools.size > 0)
    ) {
      return [];
    }
    this.toolAnnounced.set(idx, true);
    const customName = customToolCallName(stored.name, this.customTools, this.functionTools, this.namespaceTools);
    const isCustom = customName !== null;
    const isToolSearch = !isCustom && this.toolSearchDeclared && stored.name === TOOL_SEARCH_PROXY_NAME;
    this.toolIsCustom.set(idx, isCustom);
    this.toolIsToolSearch.set(idx, isToolSearch);
    let itemType = 'function_call';
    if (isCustom) itemType = 'custom_tool_call';
    if (isToolSearch) itemType = 'tool_search_call';
    // namespace 子工具的调用按 function_call 生命周期下发，但 added/done 项
    // 要还原为裸子工具名 + namespace 字段（按 namespace+name 路由）。
    let itemName = stored.name;
    let itemNamespace = '';
    if (isCustom) itemName = customName;
    const namespace = this.namespaceTools.get(stored.name);
    if (namespace !== undefined && !isCustom && !isToolSearch) {
      this.toolNamespace.set(idx, namespace);
      itemName = namespace.name;
      itemNamespace = namespace.namespace;
    }

    const item: Record<string, unknown> = { type: itemType, id: this.toolItemIds.get(idx) ?? '' };
    if (itemType === 'tool_search_call') {
      item.call_id = stored.id;
      item.execution = 'client';
      item.arguments = toolSearchCallArgumentsValue('');
      item.status = 'in_progress';
    } else if (itemType === 'custom_tool_call') {
      item.call_id = stored.id;
      item.name = itemName;
      item.input = '';
      item.status = 'in_progress';
    } else {
      item.call_id = stored.id;
      item.name = itemName;
      item.arguments = '';
      if (itemNamespace !== '') item.namespace = itemNamespace;
      item.status = 'in_progress';
    }
    const events = [
      this.event('response.output_item.added', {
        output_index: this.toolOutputIndex.get(idx) ?? 0,
        item,
      }),
    ];
    // 迟到宣告时补发已累积的参数增量（custom/tool_search 的输入收尾统一下发）。
    if (!isCustom && !isToolSearch && stored.arguments !== '') {
      events.push(
        this.event('response.function_call_arguments.delta', {
          item_id: this.toolItemIds.get(idx) ?? '',
          output_index: this.toolOutputIndex.get(idx) ?? 0,
          ...(stored.id === '' ? {} : { call_id: stored.id }),
          ...(stored.name === '' ? {} : { name: stored.name }),
          delta: stored.arguments,
        }),
      );
    }
    return events;
  }

  private closeToolItems(): Record<string, unknown>[] {
    if (this.toolCalls.size === 0) return [];
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < this.toolCalls.size; i++) {
      const toolCall = this.toolCalls.get(i);
      if (toolCall === undefined) continue;
      const itemID = this.toolItemIds.get(i);
      if (itemID === undefined) continue;
      const outputIndex = this.toolOutputIndex.get(i) ?? 0;
      // 名字始终未到导致尚未宣告的调用，收尾前按最终名字兜底宣告。
      events.push(...this.announceToolItem(i, toolCall, true));
      let argumentsText = toolCall.arguments;
      if (argumentsText.trim() === '') argumentsText = '{}';

      if (this.toolIsCustom.get(i) === true) {
        // custom 调用按 custom_tool_call 生命周期收尾：input 一次性下发。
        const input = extractCustomToolCallInput(argumentsText);
        if (input !== '') {
          events.push(
            this.event('response.custom_tool_call_input.delta', {
              item_id: itemID,
              output_index: outputIndex,
              delta: input,
            }),
          );
        }
        const name = this.streamToolName(toolCall.name);
        events.push(
          this.event('response.custom_tool_call_input.done', {
            item_id: itemID,
            output_index: outputIndex,
            ...(toolCall.id === '' ? {} : { call_id: toolCall.id }),
            ...(name === '' ? {} : { name }),
            input,
          }),
          this.event('response.output_item.done', {
            output_index: outputIndex,
            item: {
              type: 'custom_tool_call',
              id: itemID,
              call_id: toolCall.id,
              name,
              input,
              status: 'completed',
            },
          }),
        );
        continue;
      }
      if (this.toolIsToolSearch.get(i) === true) {
        // tool_search 调用按 tool_search_call 项收尾：arguments 全量随项下发。
        events.push(
          this.event('response.output_item.done', {
            output_index: outputIndex,
            item: {
              type: 'tool_search_call',
              id: itemID,
              call_id: toolCall.id,
              execution: 'client',
              arguments: toolSearchCallArgumentsValue(argumentsText),
              status: 'completed',
            },
          }),
        );
        continue;
      }
      // namespace 子工具调用在宣告时已记录归属，收尾项同样带还原名与 namespace。
      let name = toolCall.name;
      let namespace = '';
      const ns = this.toolNamespace.get(i);
      if (ns !== undefined) {
        name = ns.name;
        namespace = ns.namespace;
      }
      events.push(
        this.event('response.function_call_arguments.done', {
          item_id: itemID,
          output_index: outputIndex,
          ...(toolCall.id === '' ? {} : { call_id: toolCall.id }),
          ...(name === '' ? {} : { name }),
          arguments: argumentsText,
        }),
        this.event('response.output_item.done', {
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: itemID,
            call_id: toolCall.id,
            name,
            ...(namespace === '' ? {} : { namespace }),
            arguments: argumentsText,
            status: 'completed',
          },
        }),
      );
    }
    return events;
  }

  private streamToolName(name: string): string {
    const customName = customToolCallName(name, this.customTools, this.functionTools, this.namespaceTools);
    return customName !== null ? customName : name;
  }

  private chatOutput(): Record<string, unknown>[] {
    const outputs: Record<string, unknown>[] = [];
    if (this.reasoning.length > 0) {
      outputs.push({
        type: 'reasoning',
        id: generateItemId(),
        summary: [{ type: 'summary_text', text: this.reasoning }],
      });
    }
    if (this.messageItemId !== '' || this.toolCalls.size === 0) {
      outputs.push(
        defaultMessageItem(this.messageItemId !== '' ? this.messageItemId : generateItemId(), this.text, 'completed'),
      );
    }
    for (let i = 0; i < this.toolCalls.size; i++) {
      const toolCall = this.toolCalls.get(i);
      if (toolCall === undefined) continue;
      let argumentsText = toolCall.arguments;
      if (argumentsText.trim() === '') argumentsText = '{}';
      if (this.toolIsCustom.get(i) === true) {
        const customName = this.streamToolName(toolCall.name);
        const customInput = extractCustomToolCallInput(argumentsText);
        outputs.push({
          type: 'custom_tool_call',
          id: generateItemId(),
          ...(toolCall.id === '' ? {} : { call_id: toolCall.id }),
          ...(customName === '' ? {} : { name: customName }),
          ...(customInput === '' ? {} : { input: customInput }),
          status: 'completed',
        });
        continue;
      }
      if (this.toolIsToolSearch.get(i) === true) {
        outputs.push({
          type: 'tool_search_call',
          id: generateItemId(),
          call_id: toolCall.id,
          execution: 'client',
          arguments: toolSearchCallArgumentsValue(argumentsText),
          status: 'completed',
        });
        continue;
      }
      let name = toolCall.name;
      let namespace = '';
      const ns = this.toolNamespace.get(i);
      if (ns !== undefined) {
        name = ns.name;
        namespace = ns.namespace;
      }
      outputs.push({
        type: 'function_call',
        id: generateItemId(),
        call_id: toolCall.id,
        ...(name === '' ? {} : { name }),
        ...(namespace === '' ? {} : { namespace }),
        arguments: argumentsText,
        status: 'completed',
      });
    }
    return outputs;
  }
}
