import type { Bridge, BridgeError, BridgeStreamResult, BridgeUsage, Protocol } from './bridge.js';
import { parseSseStream, writeSseEvent } from './sse.js';

export interface OpenAIToAnthBridgeOptions {
  /** The configured upstream identity, never a client-supplied model alias. */
  readonly provider?: string;
  readonly model?: string;
  /** Named selection recovered from a verified native provider payload. */
  readonly expectedToolName?: string;
}

export class BridgeToolChoiceMismatchError extends Error {
  readonly code = 'TOOL_CHOICE_MISMATCH';
  constructor() {
    super('Upstream response did not honor the requested tool choice');
    this.name = 'BridgeToolChoiceMismatchError';
  }
}

export class BridgeToolChoiceSelectionError extends Error {
  readonly code = 'INVALID_TOOL_CHOICE';
  constructor() {
    super('Named tool_choice must select exactly one declared function');
    this.name = 'BridgeToolChoiceSelectionError';
  }
}

function nativeUsageCounter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Anthropic upstream usage contains an invalid counter');
  }
  return value;
}

/** Convert exclusive native input buckets to OpenAI's inclusive prompt total once. */
function openAiUsageFromAnthropic(value: unknown):
  | {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: { cached_tokens: number };
    }
  | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Anthropic upstream usage is invalid');
  const raw = value as Record<string, unknown>;
  const input = nativeUsageCounter(raw.input_tokens);
  const output = nativeUsageCounter(raw.output_tokens);
  const read = Object.hasOwn(raw, 'cache_read_input_tokens')
    ? nativeUsageCounter(raw.cache_read_input_tokens)
    : undefined;
  const write = Object.hasOwn(raw, 'cache_creation_input_tokens')
    ? nativeUsageCounter(raw.cache_creation_input_tokens)
    : undefined;
  if (Object.hasOwn(raw, 'cache_creation')) {
    const detailsValue = raw.cache_creation;
    const details = detailsValue as Record<string, unknown>;
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      throw new Error('Anthropic upstream cache usage is invalid');
    }
    const names = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'];
    if (Object.keys(details).some((name) => !names.includes(name))) {
      throw new Error('Anthropic upstream cache usage is invalid');
    }
    const counts = names
      .filter((name) => Object.hasOwn(details, name))
      .map((name) => nativeUsageCounter(details[name]));
    const detailTotal = counts.reduce((total, count) => total + count, 0);
    if (
      !Number.isSafeInteger(detailTotal) ||
      write === undefined ||
      detailTotal > write ||
      (counts.length === 2 && detailTotal !== write)
    )
      throw new Error('Anthropic upstream cache usage is inconsistent');
  }
  const prompt = input + (read ?? 0) + (write ?? 0);
  const total = prompt + output;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(total)) {
    throw new Error('Anthropic upstream usage exceeds safe integer bounds');
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: total,
    ...(read === undefined ? {} : { prompt_tokens_details: { cached_tokens: read } }),
  };
}

/** Whether this target can receive every thinking representation in a turn. */
export function supportsOpenAIToAnthropicThinkingHistory(body: any, options: OpenAIToAnthBridgeOptions = {}): boolean {
  if (!Array.isArray(body?.messages)) return true;
  return body.messages.every((message: any) => {
    if (message?.role !== 'assistant' || message.reasoning_content === undefined || message.reasoning_content === null)
      return true;
    if (typeof message.reasoning_content !== 'string') return false;
    if (message.reasoning_content === '') return true;
    return (
      isKimiProvider(options.provider) ||
      (Array.isArray(message.anthropic_content) && message.anthropic_content.some(isThinkingBlock)) ||
      (Array.isArray(message.content) && message.content.some(isThinkingBlock))
    );
  });
}

/**
 * OpenAI-in → Anthropic-out bridge.
 *
 * Spec: docs/superpowers/specs/2026-05-01-multi-protocol-bridge-design.md §5.4.
 * Reverse of `AnthToOpenAIBridge`.
 *
 * - URL: `/v1/chat/completions` → `/v1/messages`.
 * - Request: OpenAI body → Anthropic `/v1/messages` body.
 * - Response: Anthropic envelope → OpenAI chat completion.
 * - Stream: Anthropic SSE events → OpenAI SSE chunks (terminated by `[DONE]`).
 */
export class OpenAIToAnthBridge implements Bridge {
  readonly clientProto: Protocol = 'openai';
  readonly upstreamProto: Protocol = 'anthropic';
  private includeStreamUsage = false;
  private expectedToolName: string | undefined;

  constructor(private readonly options: OpenAIToAnthBridgeOptions = {}) {
    this.expectedToolName = options.expectedToolName;
  }

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/chat/completions') return '/v1/messages';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    const out: any = {};
    const body = clientBody ?? {};
    if (!supportsOpenAIToAnthropicThinkingHistory(body, this.options)) {
      throw new Error('The configured Anthropic target cannot replay this OpenAI reasoning history');
    }
    this.includeStreamUsage = body.stream_options?.include_usage === true;
    this.expectedToolName = undefined;

    if (body.model !== undefined) out.model = body.model;

    // Walk OpenAI messages, peeling off system/tool conversions.
    const systemParts: string[] = [];
    const anthMessages: any[] = [];

    if (Array.isArray(body.messages)) {
      // First, collect any leading or interspersed system messages — Anthropic puts
      // them at the top-level `system` field. Also handle role:"tool" messages.
      // We have to merge consecutive role:"tool" messages into the next user message
      // as tool_result blocks; otherwise an orphan tool message becomes a user
      // message with the tool_result block alone.
      const buffered: any[] = [];

      for (const m of body.messages) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'system') {
          systemParts.push(stringifyOpenAiContent(m.content));
          continue;
        }
        buffered.push(m);
      }

      for (let i = 0; i < buffered.length; i++) {
        const m = buffered[i];

        if (m.role === 'tool') {
          // Tool messages become a tool_result block within a user message.
          const toolBlocks: any[] = [];
          while (i < buffered.length && buffered[i].role === 'tool') {
            toolBlocks.push({
              type: 'tool_result',
              tool_use_id: buffered[i].tool_call_id,
              content: stringifyOpenAiContent(buffered[i].content),
            });
            i++;
          }
          // If the next message is a user message, prepend tool_results as blocks.
          if (i < buffered.length && buffered[i].role === 'user') {
            const userBlocks = openAiUserContentToBlocks(buffered[i].content);
            anthMessages.push({
              role: 'user',
              content: [...toolBlocks, ...userBlocks],
            });
          } else {
            // Orphan: emit a user message with just tool_result blocks.
            anthMessages.push({ role: 'user', content: toolBlocks });
            i--; // step back so the for-loop's i++ leaves us at the same message.
          }
          continue;
        }

        if (m.role === 'user') {
          const blocks = openAiUserContentToBlocks(m.content);
          if (blocks.length === 1 && blocks[0].type === 'text') {
            anthMessages.push({ role: 'user', content: blocks[0].text });
          } else {
            anthMessages.push({ role: 'user', content: blocks });
          }
          continue;
        }

        if (m.role === 'assistant') {
          const blocks = assistantMessageToBlocks(m, isKimiProvider(this.options.provider));
          if (blocks.length === 1 && blocks[0].type === 'text') {
            anthMessages.push({ role: 'assistant', content: blocks[0].text });
          } else {
            anthMessages.push({ role: 'assistant', content: blocks });
          }
          continue;
        }

        // unknown role — best-effort
        anthMessages.push({
          role: m.role,
          content: stringifyOpenAiContent(m.content),
        });
      }
    }

    if (systemParts.length > 0) {
      const joined = systemParts.filter((s) => s.length > 0).join('\n\n');
      if (joined.length > 0) out.system = joined;
    }

    out.messages = anthMessages;

    if (body.max_completion_tokens !== undefined) out.max_tokens = body.max_completion_tokens;
    else if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
    else out.max_tokens = 1024; // Anthropic requires max_tokens. Pick a safe default.

    if (body.temperature !== undefined) out.temperature = body.temperature;
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop !== undefined) {
      const stop = Array.isArray(body.stop) ? body.stop : [body.stop];
      out.stop_sequences = stop.filter((s: unknown) => typeof s === 'string');
    }
    if (body.stream !== undefined) out.stream = body.stream;

    // `thinking` is a native extension: keep the client's explicit control,
    // including disabled, rather than restoring the upstream's default.
    if (isRecord(body.thinking)) {
      out.thinking = structuredClone(body.thinking);
    } else if (isKimiProvider(this.options.provider) && typeof body.reasoning_effort === 'string') {
      // Kimi's Anthropic endpoint uses a binary switch. Do not apply this
      // conversion to arbitrary compatible providers or change tool_choice.
      if (body.reasoning_effort === 'none') out.thinking = { type: 'disabled' };
      else if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)) {
        out.thinking = { type: 'enabled' };
      }
    }
    if (isRecord(body.output_config)) out.output_config = structuredClone(body.output_config);

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      out.tools = body.tools.map((t: any) => {
        const fn = t?.function ?? {};
        return {
          name: fn.name,
          description: fn.description,
          input_schema: fn.parameters,
        };
      });
    }

    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      const tc = body.tool_choice;
      if (tc === 'auto') out.tool_choice = { type: 'auto' };
      else if (tc === 'required') out.tool_choice = { type: 'any' };
      else if (tc === 'none') out.tool_choice = { type: 'none' };
      else if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
        const selected = (out.tools ?? []).filter((tool: any) => tool.name === tc.function.name);
        if (selected.length !== 1) throw new BridgeToolChoiceSelectionError();
        if (isKimiCodeTarget(this.options)) {
          // Kimi Code accepts named selection but can answer with text instead
          // of a call. Its advertised `any` vocabulary plus the one selected
          // declaration enforces exactly the client's requested function.
          out.tools = selected;
          out.tool_choice = { type: 'any' };
        } else {
          out.tool_choice = { type: 'tool', name: tc.function.name };
        }
        this.expectedToolName = tc.function.name;
      }
    }

    if (typeof body.user === 'string') {
      out.metadata = { user_id: body.user };
    }

    return out;
  }

  transformResponse(upstreamBody: any): any {
    const body = upstreamBody ?? {};
    const blocks: any[] = Array.isArray(body.content) ? body.content : [];

    // Build OpenAI message
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: any[] = [];

    for (const blk of blocks) {
      if (!blk || typeof blk !== 'object') continue;
      if (blk.type === 'text' && typeof blk.text === 'string') {
        textParts.push(blk.text);
      } else if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
        reasoningParts.push(blk.thinking);
      } else if (blk.type === 'tool_use') {
        let argsStr: string;
        try {
          argsStr = JSON.stringify(blk.input ?? {});
        } catch {
          argsStr = '{}';
        }
        toolCalls.push({
          id: blk.id,
          type: 'function',
          function: { name: blk.name, arguments: argsStr },
        });
      }
    }

    const message: any = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('') : null,
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('');
    if (blocks.some(isThinkingBlock)) {
      // OpenAI has no field for signed/redacted blocks or their ordering.
      // This opaque history extension is authoritative when replayed: clients
      // keep it with the assistant message and remove it if editing that turn.
      message.anthropic_content = structuredClone(blocks);
    }

    const finishReason = mapStopReasonToFinishReason(body.stop_reason);
    assertExpectedToolChoice(
      this.expectedToolName,
      toolCalls.map((call) => call.function.name),
      finishReason,
    );

    const out: any = {
      id: body.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
    };

    const usage = openAiUsageFromAnthropic(body.usage);
    if (usage !== undefined) out.usage = usage;

    return out;
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    let resolveUsage: (u: BridgeUsage) => void;
    let rejectUsage: (e: any) => void;
    const usage: Promise<BridgeUsage> = new Promise((resolve, reject) => {
      resolveUsage = resolve;
      rejectUsage = reject;
    });

    const encoder = new TextEncoder();
    const includeStreamUsage = this.includeStreamUsage;
    const expectedToolName = this.expectedToolName;

    type ToolBuf = {
      anthIndex: number; // anthropic content_block index
      oaIndex: number; // openai tool_calls[] index, assigned in arrival order
      id: string;
      name: string;
      argsAccum: string;
      started: boolean; // emitted the initial tool_calls chunk?
    };

    type StreamState = {
      messageId: string;
      model: string;
      created: number;
      roleEmitted: boolean;
      blocks: Map<number, ToolBuf>; // keyed by anthropic index, only tool_use blocks tracked
      nativeBlocks: Map<number, any>;
      completedBlocks: Set<number>;
      nextOaIndex: number;
      inputTokens?: number;
      outputTokens?: number;
      outputUsageComplete: boolean;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      cacheCreationDetails?: unknown;
      finishReason: string | null;
      finished: boolean;
      toolChoiceMismatch: boolean;
    };

    const state: StreamState = {
      messageId: '',
      model: '',
      created: Math.floor(Date.now() / 1000),
      roleEmitted: false,
      blocks: new Map(),
      nativeBlocks: new Map(),
      completedBlocks: new Set(),
      nextOaIndex: 0,
      inputTokens: undefined,
      outputTokens: undefined,
      outputUsageComplete: false,
      finishReason: null,
      finished: false,
      toolChoiceMismatch: false,
    };

    const upstreamReader = upstreamStream.getReader();
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const next = await upstreamReader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      },
      { highWaterMark: 0 },
    );
    let cancelled = false;
    let resume: (() => void) | undefined;
    const observedUsage = (): BridgeUsage => ({
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheCreationTokens: state.cacheCreationTokens,
    });
    const clientUsage = () => {
      if (state.inputTokens === undefined && state.outputTokens === undefined) return undefined;
      if (!state.outputUsageComplete) return undefined;
      return openAiUsageFromAnthropic({
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        ...(state.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: state.cacheReadTokens }),
        ...(state.cacheCreationTokens === undefined ? {} : { cache_creation_input_tokens: state.cacheCreationTokens }),
        ...(state.cacheCreationDetails === undefined ? {} : { cache_creation: state.cacheCreationDetails }),
      });
    };
    const readUsage = (value: unknown, terminal = false) => {
      if (value === undefined || value === null) return;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Anthropic upstream usage is invalid');
      const raw = value as Record<string, unknown>;
      if (Object.hasOwn(raw, 'input_tokens')) state.inputTokens = nativeUsageCounter(raw.input_tokens);
      if (Object.hasOwn(raw, 'output_tokens')) {
        state.outputTokens = nativeUsageCounter(raw.output_tokens);
        if (terminal) state.outputUsageComplete = true;
      }
      if (Object.hasOwn(raw, 'cache_read_input_tokens'))
        state.cacheReadTokens = nativeUsageCounter(raw.cache_read_input_tokens);
      if (Object.hasOwn(raw, 'cache_creation_input_tokens'))
        state.cacheCreationTokens = nativeUsageCounter(raw.cache_creation_input_tokens);
      if (Object.hasOwn(raw, 'cache_creation')) state.cacheCreationDetails = raw.cache_creation;
    };
    const clientStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emitChunk = (delta: any, finishReason: string | null = null) => {
          const chunk = {
            id: state.messageId || 'chatcmpl-' + randomId(),
            object: 'chat.completion.chunk',
            created: state.created,
            model: state.model || '',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          };
          const wire = writeSseEvent({ data: JSON.stringify(chunk) });
          controller.enqueue(encoder.encode(wire));
        };

        const emitDone = () => {
          const normalizedUsage = clientUsage();
          if (includeStreamUsage && normalizedUsage !== undefined) {
            const usageChunk = {
              id: state.messageId || 'chatcmpl-' + randomId(),
              object: 'chat.completion.chunk',
              created: state.created,
              model: state.model || '',
              choices: [],
              usage: normalizedUsage,
            };
            controller.enqueue(encoder.encode(writeSseEvent({ data: JSON.stringify(usageChunk) })));
          }
          const wire = writeSseEvent({ data: '[DONE]' });
          controller.enqueue(encoder.encode(wire));
        };

        const emitNativeHistory = () => {
          const entries = [...state.nativeBlocks.entries()].sort(([a], [b]) => a - b);
          if (!entries.some(([, block]) => isThinkingBlock(block))) return;
          // Never offer partial tool arguments or unsigned partial thinking
          // from a cut stream as a complete assistant history message.
          if (entries.some(([index]) => !state.completedBlocks.has(index))) return;
          emitChunk({ anthropic_content: entries.map(([, block]) => block) });
        };

        void (async () => {
          try {
            for await (const ev of parseSseStream(source)) {
              while (!cancelled && (controller.desiredSize ?? 0) <= 0) {
                await new Promise<void>((resolve) => {
                  resume = resolve;
                });
              }
              if (cancelled) break;
              if (state.finished) continue;
              const evType = ev.event;
              const dataStr = ev.data;
              if (!dataStr) continue;
              let data: any;
              try {
                data = JSON.parse(dataStr);
              } catch {
                continue;
              }
              if (evType === 'error') throw new Error('Anthropic upstream stream reported an error');

              if (evType === 'message_start') {
                const m = data?.message ?? {};
                if (typeof m.id === 'string') state.messageId = m.id;
                if (typeof m.model === 'string') state.model = m.model;
                readUsage(m.usage);
                if (!state.roleEmitted) {
                  emitChunk({ role: 'assistant', content: '' });
                  state.roleEmitted = true;
                }
                continue;
              }

              if (evType === 'content_block_start') {
                if (!state.roleEmitted) {
                  emitChunk({ role: 'assistant', content: '' });
                  state.roleEmitted = true;
                }
                const idx = data?.index;
                const cb = data?.content_block;
                if (isRecord(cb) && typeof idx === 'number') {
                  state.nativeBlocks.set(idx, structuredClone(cb));
                  if (cb.type === 'thinking' && typeof cb.thinking === 'string' && cb.thinking.length > 0) {
                    emitChunk({ reasoning_content: cb.thinking });
                  } else if (cb.type === 'text' && typeof cb.text === 'string' && cb.text.length > 0) {
                    emitChunk({ content: cb.text });
                  }
                }
                if (cb && cb.type === 'tool_use' && typeof idx === 'number') {
                  const oaIndex = state.nextOaIndex++;
                  const buf: ToolBuf = {
                    anthIndex: idx,
                    oaIndex,
                    id: cb.id ?? '',
                    name: cb.name ?? '',
                    argsAccum: '',
                    started: false,
                  };
                  state.blocks.set(idx, buf);
                  // Emit the initial tool_calls chunk announcing id/name.
                  emitChunk({
                    tool_calls: [
                      {
                        index: oaIndex,
                        id: buf.id,
                        type: 'function',
                        function: { name: buf.name, arguments: '' },
                      },
                    ],
                  });
                  buf.started = true;
                }
                // text blocks: nothing to emit on start (OpenAI doesn't have a start frame).
                continue;
              }

              if (evType === 'content_block_delta') {
                if (!state.roleEmitted) {
                  emitChunk({ role: 'assistant', content: '' });
                  state.roleEmitted = true;
                }
                const idx = data?.index;
                const delta = data?.delta;
                if (!delta) continue;
                const nativeBlock = state.nativeBlocks.get(idx);
                if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                  if (nativeBlock?.type === 'text') nativeBlock.text = (nativeBlock.text ?? '') + delta.text;
                  emitChunk({ content: delta.text });
                } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                  if (nativeBlock?.type === 'thinking') {
                    nativeBlock.thinking = (nativeBlock.thinking ?? '') + delta.thinking;
                    emitChunk({ reasoning_content: delta.thinking });
                  }
                } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
                  if (nativeBlock?.type === 'thinking') {
                    nativeBlock.signature = (nativeBlock.signature ?? '') + delta.signature;
                  }
                } else if (delta.type === 'input_json_delta' && typeof idx === 'number') {
                  const buf = state.blocks.get(idx);
                  if (buf) {
                    const partial = delta.partial_json ?? '';
                    buf.argsAccum += partial;
                    emitChunk({
                      tool_calls: [
                        {
                          index: buf.oaIndex,
                          function: { arguments: partial },
                        },
                      ],
                    });
                  }
                }
                continue;
              }

              if (evType === 'content_block_stop') {
                const idx = data?.index;
                if (typeof idx === 'number') {
                  const tool = state.blocks.get(idx);
                  const block = state.nativeBlocks.get(idx);
                  if (tool && block) {
                    if (tool.argsAccum !== '') {
                      try {
                        block.input = JSON.parse(tool.argsAccum);
                      } catch {
                        // The incomplete block must not become replayable history.
                        continue;
                      }
                    } else {
                      emitChunk({
                        tool_calls: [
                          { index: tool.oaIndex, function: { arguments: JSON.stringify(block.input ?? {}) } },
                        ],
                      });
                    }
                  }
                  state.completedBlocks.add(idx);
                }
                continue;
              }

              if (evType === 'message_delta') {
                const d = data?.delta ?? {};
                readUsage(data?.usage, true);
                if (typeof d.stop_reason === 'string') {
                  state.finishReason = mapStopReasonToFinishReason(d.stop_reason);
                }
                continue;
              }

              if (evType === 'message_stop') {
                if (!state.finished) {
                  clientUsage();
                  if (
                    [...state.nativeBlocks].some(
                      ([index, block]) =>
                        (isThinkingBlock(block) || block.type === 'tool_use') && !state.completedBlocks.has(index),
                    )
                  ) {
                    throw new Error('Anthropic upstream stream ended with incomplete thinking or tool history');
                  }
                  try {
                    assertExpectedToolChoice(
                      expectedToolName,
                      [...state.blocks.values()].map((block) => block.name),
                      state.finishReason,
                    );
                  } catch (error) {
                    if (!(error instanceof BridgeToolChoiceMismatchError)) throw error;
                    // Consume the terminal provider body so its raw observer
                    // can publish actual usage. Do not emit a successful client
                    // finish or invent a replacement call.
                    state.toolChoiceMismatch = true;
                    state.finished = true;
                    continue;
                  }
                  emitNativeHistory();
                  emitChunk({}, state.finishReason ?? 'stop');
                  emitDone();
                  state.finished = true;
                }
              }
            }

            if (state.toolChoiceMismatch) throw new BridgeToolChoiceMismatchError();
            // Preserve the existing text-only fallback. Thinking and tool
            // turns require an explicit terminal event before clients replay them.
            if (!cancelled && !state.finished) {
              assertExpectedToolChoice(expectedToolName, [], null);
              if (
                [...state.nativeBlocks.values()].some((block) => isThinkingBlock(block) || block.type === 'tool_use')
              ) {
                throw new Error('Anthropic upstream stream ended before thinking or tool completion');
              }
              clientUsage();
              emitChunk({}, state.finishReason ?? 'stop');
              emitDone();
            }

            if (!cancelled) controller.close();
            resolveUsage(observedUsage());
          } catch (err) {
            await upstreamReader.cancel(err).catch(() => undefined);
            try {
              controller.error(err);
            } catch {
              /* ignore */
            }
            if (cancelled || (err instanceof BridgeToolChoiceMismatchError && state.toolChoiceMismatch))
              resolveUsage(observedUsage());
            else rejectUsage(err);
          } finally {
            upstreamReader.releaseLock();
          }
        })();
      },
      pull() {
        const pending = resume;
        resume = undefined;
        pending?.();
      },
      async cancel(reason) {
        cancelled = true;
        resume?.();
        await upstreamReader.cancel(reason);
        resolveUsage(observedUsage());
      },
    });

    return { clientStream, usage };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'api_error';
    return {
      body: {
        error: { message, type: errorType, code: null },
      },
      contentType: 'application/json',
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKimiProvider(provider: string | undefined): boolean {
  return provider === 'kimi' || provider === 'kimi-code' || provider === 'kimi-code-global';
}

function isKimiCodeTarget(options: OpenAIToAnthBridgeOptions): boolean {
  return (
    isKimiProvider(options.provider) &&
    options.model !== undefined &&
    ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'].includes(options.model)
  );
}

function isThinkingBlock(block: any): boolean {
  return block?.type === 'thinking' || block?.type === 'redacted_thinking';
}

function assertExpectedToolChoice(expected: string | undefined, names: string[], finishReason: string | null): void {
  if (
    expected !== undefined &&
    (names.length === 0 || names.some((name) => name !== expected) || finishReason !== 'tool_calls')
  ) {
    throw new BridgeToolChoiceMismatchError();
  }
}

function stringifyOpenAiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === 'object') {
        const x: any = p;
        if (x.type === 'text' && typeof x.text === 'string') parts.push(x.text);
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * Convert an OpenAI user message's content into Anthropic content blocks.
 * - string content → single text block
 * - array of mixed text / image_url parts → preserved as text/image blocks
 */
function openAiUserContentToBlocks(content: unknown): any[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    const blocks: any[] = [];
    for (const p of content) {
      if (!p || typeof p !== 'object') continue;
      const x: any = p;
      if (x.type === 'text' && typeof x.text === 'string') {
        blocks.push({ type: 'text', text: x.text });
      } else if (x.type === 'image_url' && x.image_url?.url) {
        const url = x.image_url.url;
        if (typeof url === 'string' && url.startsWith('data:')) {
          // data:image/png;base64,XXXX → split into media_type + data
          const match = /^data:([^;]+);base64,(.*)$/.exec(url);
          if (match) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            });
          } else {
            blocks.push({ type: 'image', source: { type: 'url', url } });
          }
        } else if (typeof url === 'string') {
          blocks.push({ type: 'image', source: { type: 'url', url } });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
  }
  return [{ type: 'text', text: '' }];
}

/**
 * Convert an OpenAI assistant message into Anthropic content blocks
 * (text plus tool_use blocks for any tool_calls).
 */
function assistantMessageToBlocks(msg: any, allowUnsignedReasoning: boolean): any[] {
  if (Array.isArray(msg.anthropic_content) && msg.anthropic_content.some(isThinkingBlock)) {
    // A response's opaque native history carries signatures, redactions and
    // interleaved block order. Reconstructing it from reasoning_content would
    // destroy those details. Treat it like the original native content array.
    return structuredClone(msg.anthropic_content);
  }
  const blocks: any[] = [];
  const contentHasThinking = Array.isArray(msg.content) && msg.content.some(isThinkingBlock);
  if (
    !contentHasThinking &&
    allowUnsignedReasoning &&
    typeof msg.reasoning_content === 'string' &&
    msg.reasoning_content.length > 0
  ) {
    // Kimi accepts reasoning-only history from OpenAI clients. Never fabricate
    // an unsigned thinking block for strict Anthropic or an unknown provider.
    blocks.push({ type: 'thinking', thinking: msg.reasoning_content });
  }
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
        blocks.push({ type: 'text', text: p.text });
      } else if (isThinkingBlock(p)) {
        blocks.push(structuredClone(p));
      } else if (p?.type === 'tool_use') {
        blocks.push(structuredClone(p));
      }
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (blocks.some((block) => block.type === 'tool_use' && block.id === tc?.id)) continue;
      const fn = tc?.function ?? {};
      const argsStr = fn.arguments ?? '';
      let input: any;
      try {
        input = argsStr === '' ? {} : JSON.parse(argsStr);
      } catch {
        input = { _raw: argsStr };
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: fn.name,
        input,
      });
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function mapStopReasonToFinishReason(sr: unknown): string {
  if (sr === 'end_turn') return 'stop';
  if (sr === 'max_tokens') return 'length';
  if (sr === 'tool_use') return 'tool_calls';
  if (sr === 'stop_sequence') return 'stop';
  return 'stop';
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    /* fall through */
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
