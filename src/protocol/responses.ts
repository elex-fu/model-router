import type {
  Bridge,
  BridgeError,
  BridgeStreamResult,
  BridgeUsage,
  Protocol,
} from './bridge.js';
import { parseSseStream, writeSseEvent } from './sse.js';

export function responsesStreamToAnthropicStream(line: string): any[] {
  const events: any[] = [];
  if (!line.startsWith('data:')) return events;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return events;
  let parsed: any;
  try { parsed = JSON.parse(data); } catch { return events; }

  if (parsed.type === 'response.output_text.delta') {
    events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parsed.delta } });
  }
  if (parsed.type === 'response.function_call_arguments.delta') {
    events.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: parsed.delta } });
  }
  return events;
}

/**
 * Anthropic-in → Responses-out bridge.
 *
 * - URL: `/v1/messages` → `/v1/responses`.
 * - Request: Anthropic body → Responses API body.
 * - Response: Responses envelope → Anthropic message envelope.
 * - Stream: Responses SSE → Anthropic SSE event sequence.
 */
export class AnthToResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'anthropic';
  readonly upstreamProto: Protocol = 'responses';

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/messages') return '/v1/responses';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    const input: any[] = [];
    for (const msg of clientBody.messages ?? []) {
      if (msg.role === 'system') continue;
      if (typeof msg.content === 'string') {
        input.push({ role: msg.role, content: [{ type: 'input_text', text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const content = msg.content.map((block: any) => {
          if (block.type === 'text') return { type: 'input_text', text: block.text };
          if (block.type === 'tool_result') return { type: 'input_text', text: JSON.stringify(block.content) };
          return { type: 'input_text', text: '' };
        });
        input.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
      }
    }

    const instructions = typeof clientBody.system === 'string'
      ? clientBody.system
      : clientBody.system?.map((b: any) => b.text).join('\n') ?? '';

    const payload: any = {
      model: clientBody.model,
      input,
      tools: clientBody.tools?.map((t: any) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      })),
      max_output_tokens: clientBody.max_tokens,
      temperature: clientBody.temperature,
      top_p: clientBody.top_p,
      stream: clientBody.stream,
    };
    if (instructions) payload.instructions = instructions;
    if (clientBody.thinking) {
      payload.reasoning = { effort: clientBody.thinking.type === 'adaptive' ? 'high' : 'medium' };
    }
    return payload;
  }

  transformResponse(upstreamBody: any): any {
    const items = upstreamBody.output ?? [];
    const content: any[] = [];
    for (const item of items) {
      if (item.type === 'message') {
        content.push({ type: 'text', text: item.content?.[0]?.text ?? '' });
      } else if (item.type === 'function_call') {
        content.push({ type: 'tool_use', id: item.call_id ?? `toolu_${Date.now()}`, name: item.name, input: item.arguments ?? {} });
      }
    }
    return {
      id: upstreamBody.id,
      type: 'message',
      role: 'assistant',
      model: upstreamBody.model,
      content,
      usage: {
        input_tokens: upstreamBody.usage?.input_tokens ?? 0,
        output_tokens: upstreamBody.usage?.output_tokens ?? 0,
      },
      stop_reason: upstreamBody.incomplete_details ? 'max_tokens' : 'end_turn',
    };
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    let resolveUsage: (u: BridgeUsage) => void;
    let rejectUsage: (e: any) => void;
    const usage: Promise<BridgeUsage> = new Promise((resolve, reject) => {
      resolveUsage = resolve;
      rejectUsage = reject;
    });

    const encoder = new TextEncoder();

    type StreamState = {
      messageId: string;
      model: string;
      messageStarted: boolean;
      textBlockOpen: boolean;
      nextContentBlockIndex: number;
      inputTokens?: number;
      outputTokens?: number;
      finished: boolean;
    };

    const state: StreamState = {
      messageId: '',
      model: '',
      messageStarted: false,
      textBlockOpen: false,
      nextContentBlockIndex: 0,
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

            const eventType = chunk.type;

            // response.created → message_start
            if (eventType === 'response.created') {
              const resp = chunk.response ?? chunk;
              if (typeof resp.id === 'string') state.messageId = resp.id;
              if (typeof resp.model === 'string') state.model = resp.model;
              const u = resp.usage;
              if (u && typeof u === 'object') {
                if (u.input_tokens !== undefined) state.inputTokens = u.input_tokens;
                if (u.output_tokens !== undefined) state.outputTokens = u.output_tokens;
              }
              emit('message_start', {
                type: 'message_start',
                message: {
                  id: state.messageId,
                  type: 'message',
                  role: 'assistant',
                  model: state.model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: state.inputTokens ?? 0, output_tokens: 0 },
                },
              });
              state.messageStarted = true;
              continue;
            }

            // response.content_part.added (output_text/refusal) → content_block_start (text)
            if (eventType === 'response.content_part.added') {
              const part = chunk.part;
              const partType = part?.type;
              if (partType === 'output_text' || partType === 'refusal') {
                if (!state.textBlockOpen) {
                  emit('content_block_start', {
                    type: 'content_block_start',
                    index: state.nextContentBlockIndex,
                    content_block: { type: 'text', text: '' },
                  });
                  state.textBlockOpen = true;
                  state.nextContentBlockIndex += 1;
                }
              }
              continue;
            }

            // response.output_text.delta → content_block_delta (text_delta)
            if (eventType === 'response.output_text.delta') {
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
                index: state.nextContentBlockIndex - 1,
                delta: { type: 'text_delta', text: chunk.delta },
              });
              continue;
            }

            // response.refusal.delta → content_block_delta (text_delta)
            if (eventType === 'response.refusal.delta') {
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
                index: state.nextContentBlockIndex - 1,
                delta: { type: 'text_delta', text: chunk.delta },
              });
              continue;
            }

            // response.output_item.added (function_call) → content_block_start (tool_use)
            if (eventType === 'response.output_item.added') {
              const item = chunk.item;
              if (item?.type === 'function_call') {
                if (state.textBlockOpen) {
                  emit('content_block_stop', {
                    type: 'content_block_stop',
                    index: state.nextContentBlockIndex - 1,
                  });
                  state.textBlockOpen = false;
                }
                const callId = item.call_id ?? '';
                const name = item.name ?? '';
                const index = state.nextContentBlockIndex;
                state.nextContentBlockIndex += 1;
                emit('content_block_start', {
                  type: 'content_block_start',
                  index,
                  content_block: { type: 'tool_use', id: callId, name, input: {} },
                });
              }
              continue;
            }

            // response.function_call_arguments.delta → content_block_delta (input_json_delta)
            if (eventType === 'response.function_call_arguments.delta') {
              emit('content_block_delta', {
                type: 'content_block_delta',
                index: state.nextContentBlockIndex - 1,
                delta: { type: 'input_json_delta', partial_json: chunk.delta },
              });
              continue;
            }

            // response.function_call_arguments.done → content_block_stop
            if (eventType === 'response.function_call_arguments.done') {
              emit('content_block_stop', {
                type: 'content_block_stop',
                index: state.nextContentBlockIndex - 1,
              });
              continue;
            }

            // response.refusal.done / response.output_text.done → content_block_stop
            if (eventType === 'response.refusal.done' || eventType === 'response.output_text.done') {
              if (state.textBlockOpen) {
                emit('content_block_stop', {
                  type: 'content_block_stop',
                  index: state.nextContentBlockIndex - 1,
                });
                state.textBlockOpen = false;
              }
              continue;
            }

            // response.completed → message_delta + message_stop
            if (eventType === 'response.completed') {
              const resp = chunk.response ?? chunk;
              const u = resp.usage;
              if (u && typeof u === 'object') {
                if (u.input_tokens !== undefined) state.inputTokens = u.input_tokens;
                if (u.output_tokens !== undefined) state.outputTokens = u.output_tokens;
              }
              const status = resp.status;
              const incompleteReason = resp.incomplete_details?.reason;
              let stopReason: string;
              if (incompleteReason === 'max_output_tokens') {
                stopReason = 'max_tokens';
              } else if (status === 'completed') {
                stopReason = 'end_turn';
              } else {
                stopReason = 'end_turn';
              }

              if (state.textBlockOpen) {
                emit('content_block_stop', {
                  type: 'content_block_stop',
                  index: state.nextContentBlockIndex - 1,
                });
                state.textBlockOpen = false;
              }

              emit('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: state.outputTokens ?? 0 },
              });
              emit('message_stop', { type: 'message_stop' });
              state.finished = true;
              continue;
            }
          }

          // Stream ended without explicit response.completed
          if (state.messageStarted && !state.finished) {
            if (state.textBlockOpen) {
              emit('content_block_stop', {
                type: 'content_block_stop',
                index: state.nextContentBlockIndex - 1,
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

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return {
      body: {
        type: 'error',
        error: { type: errorType, message },
      },
      contentType: 'application/json',
    };
  }
}

/**
 * Responses-in → Anthropic-out bridge.
 *
 * - URL: passthrough (client already on `/v1/responses`).
 * - Request: passthrough.
 * - Response: passthrough.
 * - Stream: passthrough with usage extraction from response.completed events.
 */
export class ResponsesToAnthBridge implements Bridge {
  readonly clientProto: Protocol = 'responses';
  readonly upstreamProto: Protocol = 'anthropic';

  rewriteUrlPath(clientPath: string): string {
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    return clientBody;
  }

  transformResponse(upstreamBody: any): any {
    return upstreamBody;
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient, toParser] = upstreamStream.tee();
    const usage: Promise<BridgeUsage> = (async () => {
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      for await (const ev of parseSseStream(toParser)) {
        const data = ev.data;
        if (!data || data === '[DONE]') continue;
        let json: any;
        try { json = JSON.parse(data); } catch { continue; }
        if (json?.type === 'response.completed') {
          const resp = json.response ?? json;
          const u = resp.usage;
          if (u && typeof u === 'object') {
            if (u.input_tokens !== undefined) inputTokens = u.input_tokens;
            if (u.output_tokens !== undefined) outputTokens = u.output_tokens;
          }
        }
      }
      return { inputTokens, outputTokens };
    })();
    return { clientStream: toClient, usage };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return {
      body: {
        type: 'error',
        error: { type: errorType, message },
      },
      contentType: 'application/json',
    };
  }
}
