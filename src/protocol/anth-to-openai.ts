import type {
  Bridge,
  BridgeError,
  BridgeStreamResult,
  BridgeUsage,
  Protocol,
} from './bridge.js';
import { parseSseStream, writeSseEvent } from './sse.js';

/**
 * Anthropic-in → OpenAI-out bridge.
 *
 * Spec: docs/superpowers/specs/2026-05-01-multi-protocol-bridge-design.md §5.3.
 *
 * - URL: `/v1/messages` → `/v1/chat/completions`.
 * - Request: Anthropic `/v1/messages` body → OpenAI `/v1/chat/completions` body.
 * - Response: OpenAI chat completion → Anthropic message envelope.
 * - Stream: OpenAI SSE chunks → Anthropic SSE event sequence.
 */
export class AnthToOpenAIBridge implements Bridge {
  readonly clientProto: Protocol = 'anthropic';
  readonly upstreamProto: Protocol = 'openai';

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/messages') return '/v1/chat/completions';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    const out: any = {};
    const body = clientBody ?? {};

    if (body.model !== undefined) out.model = body.model;

    const messages: any[] = [];

    // system → top message
    if (body.system !== undefined && body.system !== null && body.system !== '') {
      const sysContent = stringifyAnthropicTextField(body.system);
      if (sysContent.length > 0) {
        messages.push({ role: 'system', content: sysContent });
      }
    }

    // messages
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        const transformed = transformAnthMessage(msg);
        for (const m of transformed) messages.push(m);
      }
    }

    out.messages = messages;

    if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
    if (body.temperature !== undefined) out.temperature = body.temperature;
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;
    if (body.stream !== undefined) out.stream = body.stream;

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      out.tools = body.tools.map((t: any) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      const tc = body.tool_choice;
      if (tc.type === 'auto') out.tool_choice = 'auto';
      else if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'tool' && tc.name) {
        out.tool_choice = { type: 'function', function: { name: tc.name } };
      } else if (tc.type === 'none') {
        out.tool_choice = 'none';
      }
    }

    if (body.metadata && typeof body.metadata === 'object') {
      if (typeof body.metadata.user_id === 'string') {
        out.user = body.metadata.user_id;
      }
    }

    return out;
  }

  transformResponse(upstreamBody: any): any {
    const body = upstreamBody ?? {};
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const msg = choice?.message ?? {};
    const finishReason = choice?.finish_reason;

    const content: any[] = [];

    // text content
    if (typeof msg.content === 'string' && msg.content.length > 0) {
      content.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      // OpenAI sometimes returns multimodal content arrays — flatten text parts.
      const textParts: string[] = [];
      for (const p of msg.content) {
        if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
          textParts.push(p.text);
        }
      }
      if (textParts.length > 0) {
        content.push({ type: 'text', text: textParts.join('') });
      }
    }

    // tool_calls
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const id = tc?.id;
        const name = tc?.function?.name;
        const argsStr = tc?.function?.arguments ?? '';
        let input: any;
        try {
          input = argsStr === '' ? {} : JSON.parse(argsStr);
        } catch {
          console.warn('[anth-to-openai] malformed tool_call arguments JSON, keeping raw');
          input = { _raw: argsStr };
        }
        content.push({ type: 'tool_use', id, name, input });
      }
    }

    const stopReason = mapFinishReasonToStopReason(finishReason);

    const out: any = {
      id: body.id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
    };

    const usage = body.usage;
    if (usage && typeof usage === 'object') {
      out.usage = {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
      };
    } else {
      out.usage = { input_tokens: 0, output_tokens: 0 };
    }

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

    type ToolCallBuf = {
      id: string;
      name: string;
      argsAccum: string;
      anthIndex: number;
    };

    type StreamState = {
      messageStarted: boolean;
      messageId: string;
      model: string;
      textBlockOpen: boolean;
      nextContentBlockIndex: number;
      toolCalls: Map<number, ToolCallBuf>; // keyed by openai tool_call.index
      toolCallOrder: number[]; // insertion order of openai indices
      inputTokens?: number;
      outputTokens?: number;
      finished: boolean;
    };

    const state: StreamState = {
      messageStarted: false,
      messageId: 'msg_' + randomId(),
      model: '',
      textBlockOpen: false,
      nextContentBlockIndex: 0,
      toolCalls: new Map(),
      toolCallOrder: [],
      inputTokens: undefined,
      outputTokens: undefined,
      finished: false,
    };

    const clientStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: string, data: any) => {
          const wire = writeSseEvent({ event, data: JSON.stringify(data) });
          controller.enqueue(encoder.encode(wire));
        };

        try {
          for await (const ev of parseSseStream(upstreamStream)) {
            const dataStr = ev.data;
            if (!dataStr || dataStr === '[DONE]') continue;
            let chunk: any;
            try {
              chunk = JSON.parse(dataStr);
            } catch {
              continue;
            }

            // Capture model from first chunk if available.
            if (!state.model && typeof chunk?.model === 'string') {
              state.model = chunk.model;
            }

            // Capture usage if present.
            if (chunk?.usage && typeof chunk.usage === 'object') {
              if (chunk.usage.prompt_tokens !== undefined) {
                state.inputTokens = chunk.usage.prompt_tokens;
              }
              if (chunk.usage.completion_tokens !== undefined) {
                state.outputTokens = chunk.usage.completion_tokens;
              }
            }

            const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
            const delta = choice?.delta ?? {};
            const finishReason = choice?.finish_reason ?? null;

            // 1. message_start (on first chunk that establishes role/content/tool_calls).
            if (!state.messageStarted) {
              // Per spec: emit message_start when we see the first chunk. Most OpenAI
              // streams have role="assistant" on the first chunk; some have content
              // immediately. Fire on the first chunk we see with delta or role.
              if (delta && (delta.role !== undefined || delta.content !== undefined ||
                  delta.tool_calls !== undefined || finishReason !== null)) {
                emit('message_start', {
                  type: 'message_start',
                  message: {
                    id: state.messageId,
                    type: 'message',
                    role: 'assistant',
                    model: state.model || '',
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: state.inputTokens ?? 0, output_tokens: 0 },
                  },
                });
                state.messageStarted = true;
              }
            }

            // 2. text content delta
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              if (!state.textBlockOpen) {
                emit('content_block_start', {
                  type: 'content_block_start',
                  index: state.nextContentBlockIndex,
                  content_block: { type: 'text', text: '' },
                });
                state.textBlockOpen = true;
                state.nextContentBlockIndex += 1;
              }
              emit('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta.content },
              });
            }

            // 3. tool_calls deltas
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const oaIndex = typeof tc.index === 'number' ? tc.index : 0;
                let buf = state.toolCalls.get(oaIndex);

                const fnName = tc.function?.name;
                const tcId = tc.id;

                // First sighting: create buffer + emit content_block_start
                if (!buf && (tcId !== undefined || fnName !== undefined)) {
                  // Close any open text block first.
                  if (state.textBlockOpen) {
                    emit('content_block_stop', {
                      type: 'content_block_stop',
                      index: 0,
                    });
                    state.textBlockOpen = false;
                  }
                  buf = {
                    id: tcId ?? '',
                    name: fnName ?? '',
                    argsAccum: '',
                    anthIndex: state.nextContentBlockIndex,
                  };
                  state.toolCalls.set(oaIndex, buf);
                  state.toolCallOrder.push(oaIndex);
                  state.nextContentBlockIndex += 1;

                  emit('content_block_start', {
                    type: 'content_block_start',
                    index: buf.anthIndex,
                    content_block: {
                      type: 'tool_use',
                      id: buf.id,
                      name: buf.name,
                      input: {},
                    },
                  });
                } else if (buf) {
                  // Update id/name if they appear later.
                  if (tcId && !buf.id) buf.id = tcId;
                  if (fnName && !buf.name) buf.name = fnName;
                }

                // arguments delta
                const argsDelta = tc.function?.arguments;
                if (typeof argsDelta === 'string' && argsDelta.length > 0 && buf) {
                  buf.argsAccum += argsDelta;
                  emit('content_block_delta', {
                    type: 'content_block_delta',
                    index: buf.anthIndex,
                    delta: { type: 'input_json_delta', partial_json: argsDelta },
                  });
                }
              }
            }

            // 4. finish_reason → terminate
            if (finishReason !== null && finishReason !== undefined && !state.finished) {
              state.finished = true;

              if (state.textBlockOpen) {
                emit('content_block_stop', {
                  type: 'content_block_stop',
                  index: 0,
                });
                state.textBlockOpen = false;
              }

              for (const oaIdx of state.toolCallOrder) {
                const buf = state.toolCalls.get(oaIdx);
                if (!buf) continue;
                emit('content_block_stop', {
                  type: 'content_block_stop',
                  index: buf.anthIndex,
                });
              }

              const stopReason = mapFinishReasonToStopReason(finishReason);
              emit('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: state.outputTokens ?? 0 },
              });
              emit('message_stop', { type: 'message_stop' });
            }
          }

          // Stream ended without a finish_reason — still close gracefully.
          if (state.messageStarted && !state.finished) {
            if (state.textBlockOpen) {
              emit('content_block_stop', {
                type: 'content_block_stop',
                index: 0,
              });
            }
            for (const oaIdx of state.toolCallOrder) {
              const buf = state.toolCalls.get(oaIdx);
              if (!buf) continue;
              emit('content_block_stop', {
                type: 'content_block_stop',
                index: buf.anthIndex,
              });
            }
            emit('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: state.outputTokens ?? 0 },
            });
            emit('message_stop', { type: 'message_stop' });
          }

          controller.close();
          resolveUsage({
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
          });
        } catch (err) {
          try {
            controller.error(err);
          } catch {
            /* ignore */
          }
          rejectUsage(err);
        }
      },
    });

    return { clientStream, usage };
  }

  wrapError(_statusCode: number, message: string): BridgeError {
    return {
      body: {
        type: 'error',
        error: { type: 'api_error', message },
      },
      contentType: 'application/json',
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stringifyAnthropicTextField(field: unknown): string {
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    const parts: string[] = [];
    for (const block of field) {
      if (block && typeof block === 'object') {
        const b: any = block;
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
    }
    return parts.join('\n\n');
  }
  return '';
}

/**
 * Transform a single Anthropic message into one or more OpenAI messages.
 *
 * - User message with mixed text + tool_result blocks is split: the text part
 *   becomes a `user` message, each tool_result becomes its own `tool` message.
 * - Assistant message with tool_use blocks emits an assistant message with
 *   `tool_calls`. Text blocks before/around them are concatenated into content.
 */
function transformAnthMessage(msg: any): any[] {
  const role = msg?.role;
  const content = msg?.content;

  if (typeof content === 'string') {
    return [{ role, content }];
  }

  if (!Array.isArray(content)) {
    return [{ role, content: '' }];
  }

  if (role === 'user') {
    return transformUserMessage(content);
  }
  if (role === 'assistant') {
    return transformAssistantMessage(content);
  }
  // unknown role: best-effort stringification
  return [{ role, content: stringifyAnthropicTextField(content) }];
}

function transformUserMessage(blocks: any[]): any[] {
  const out: any[] = [];
  let textParts: string[] = [];
  const imageParts: any[] = [];

  const flushUserMsg = () => {
    if (imageParts.length > 0) {
      const mixed: any[] = [];
      const joinedText = textParts.join('\n\n');
      if (joinedText.length > 0) {
        mixed.push({ type: 'text', text: joinedText });
      }
      for (const ip of imageParts) mixed.push(ip);
      out.push({ role: 'user', content: mixed });
    } else if (textParts.length > 0) {
      out.push({ role: 'user', content: textParts.join('\n\n') });
    }
    textParts = [];
    imageParts.length = 0;
  };

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b: any = block;
    if (shouldDropBlock(b)) continue;

    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'image') {
      const src = b.source ?? {};
      if (src.type === 'base64') {
        const url = `data:${src.media_type ?? 'image/png'};base64,${src.data ?? ''}`;
        imageParts.push({ type: 'image_url', image_url: { url } });
      } else if (src.type === 'url' && typeof src.url === 'string') {
        imageParts.push({ type: 'image_url', image_url: { url: src.url } });
      }
    } else if (b.type === 'tool_result') {
      // Flush pending text/image before emitting the tool message.
      flushUserMsg();
      const toolContent = stringifyToolResultContent(b.content);
      out.push({
        role: 'tool',
        tool_call_id: b.tool_use_id,
        content: toolContent,
      });
    } else {
      // unknown block type: warn and skip
      console.warn(`[anth-to-openai] dropping unknown user content block: ${b.type}`);
    }
  }
  flushUserMsg();
  return out;
}

function transformAssistantMessage(blocks: any[]): any[] {
  const textParts: string[] = [];
  const toolCalls: any[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b: any = block;
    if (shouldDropBlock(b)) continue;

    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'tool_use') {
      let argsStr: string;
      try {
        argsStr = JSON.stringify(b.input ?? {});
      } catch {
        argsStr = '{}';
      }
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: argsStr },
      });
    } else {
      console.warn(`[anth-to-openai] dropping unknown assistant content block: ${b.type}`);
    }
  }

  const msg: any = { role: 'assistant' };
  const textJoined = textParts.join('\n\n');
  if (textJoined.length > 0) msg.content = textJoined;
  else msg.content = null;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return [msg];
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === 'object') {
        const x: any = p;
        if (x.type === 'text' && typeof x.text === 'string') parts.push(x.text);
        else parts.push(JSON.stringify(x));
      } else {
        parts.push(String(p));
      }
    }
    return parts.join('\n\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

function shouldDropBlock(b: any): boolean {
  // thinking, server_tool_use, citations, blocks with cache_control are dropped.
  if (b.type === 'thinking') {
    console.warn('[anth-to-openai] dropping thinking block');
    return true;
  }
  if (b.type === 'server_tool_use') {
    console.warn('[anth-to-openai] dropping server_tool_use block');
    return true;
  }
  if (b.type === 'citations') {
    console.warn('[anth-to-openai] dropping citations block');
    return true;
  }
  if (b.cache_control !== undefined) {
    console.warn('[anth-to-openai] dropping cache_control on block');
    // do NOT drop the whole block — just strip the field.
    delete b.cache_control;
    return false;
  }
  return false;
}

function mapFinishReasonToStopReason(fr: unknown): string {
  if (fr === 'stop') return 'end_turn';
  if (fr === 'length') return 'max_tokens';
  if (fr === 'tool_calls') return 'tool_use';
  if (fr === 'content_filter') return 'end_turn';
  return 'end_turn';
}

function randomId(): string {
  // crypto.randomUUID is available on Node 20+.
  try {
    // @ts-ignore - global crypto is present at runtime in Node 20+.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      // @ts-ignore
      return crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    /* fall through */
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
