import type {
  Bridge,
  BridgeError,
  BridgeStreamResult,
  BridgeUsage,
  Protocol,
} from './bridge.js';
import { parseSseStream, writeSseEvent } from './sse.js';

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

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/chat/completions') return '/v1/messages';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    const out: any = {};
    const body = clientBody ?? {};

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
          const blocks = assistantMessageToBlocks(m);
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

    if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
    else out.max_tokens = 1024; // Anthropic requires max_tokens. Pick a safe default.

    if (body.temperature !== undefined) out.temperature = body.temperature;
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop !== undefined) {
      const stop = Array.isArray(body.stop) ? body.stop : [body.stop];
      out.stop_sequences = stop.filter((s: unknown) => typeof s === 'string');
    }
    if (body.stream !== undefined) out.stream = body.stream;

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
        out.tool_choice = { type: 'tool', name: tc.function.name };
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
    const toolCalls: any[] = [];

    for (const blk of blocks) {
      if (!blk || typeof blk !== 'object') continue;
      if (blk.type === 'text' && typeof blk.text === 'string') {
        textParts.push(blk.text);
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

    const finishReason = mapStopReasonToFinishReason(body.stop_reason);

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

    const usage = body.usage;
    if (usage && typeof usage === 'object') {
      out.usage = {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
    } else {
      out.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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
      nextOaIndex: number;
      inputTokens?: number;
      outputTokens?: number;
      finishReason: string | null;
      finished: boolean;
    };

    const state: StreamState = {
      messageId: '',
      model: '',
      created: Math.floor(Date.now() / 1000),
      roleEmitted: false,
      blocks: new Map(),
      nextOaIndex: 0,
      inputTokens: undefined,
      outputTokens: undefined,
      finishReason: null,
      finished: false,
    };

    const clientStream = new ReadableStream<Uint8Array>({
      async start(controller) {
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
          const wire = writeSseEvent({ data: '[DONE]' });
          controller.enqueue(encoder.encode(wire));
        };

        try {
          for await (const ev of parseSseStream(upstreamStream)) {
            const evType = ev.event;
            const dataStr = ev.data;
            if (!dataStr) continue;
            let data: any;
            try {
              data = JSON.parse(dataStr);
            } catch {
              continue;
            }

            if (evType === 'message_start') {
              const m = data?.message ?? {};
              if (typeof m.id === 'string') state.messageId = m.id;
              if (typeof m.model === 'string') state.model = m.model;
              const u = m.usage;
              if (u && typeof u === 'object') {
                if (u.input_tokens !== undefined) state.inputTokens = u.input_tokens;
                if (u.output_tokens !== undefined) state.outputTokens = u.output_tokens;
              }
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
              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                emitChunk({ content: delta.text });
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
              // Nothing to emit; OpenAI doesn't have block boundaries.
              continue;
            }

            if (evType === 'message_delta') {
              const d = data?.delta ?? {};
              const u = data?.usage;
              if (u && typeof u === 'object') {
                if (u.input_tokens !== undefined) state.inputTokens = u.input_tokens;
                if (u.output_tokens !== undefined) state.outputTokens = u.output_tokens;
              }
              if (typeof d.stop_reason === 'string') {
                state.finishReason = mapStopReasonToFinishReason(d.stop_reason);
              }
              continue;
            }

            if (evType === 'message_stop') {
              if (!state.finished) {
                emitChunk({}, state.finishReason ?? 'stop');
                emitDone();
                state.finished = true;
              }
              continue;
            }
          }

          // Stream ended without an explicit message_stop — close gracefully.
          if (!state.finished) {
            emitChunk({}, state.finishReason ?? 'stop');
            emitDone();
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
function assistantMessageToBlocks(msg: any): any[] {
  const blocks: any[] = [];
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
        blocks.push({ type: 'text', text: p.text });
      }
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
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
