import {
  convertAnthropicMessagesToResponsesRequest,
  convertChatCompletionsToResponsesRequest,
} from '../saas/gateway/responses-bridge/request.js';
import {
  type ResponsesUsage,
  responsesEnvelopeToAnthropicMessage,
  responsesEnvelopeToChatCompletion,
  responsesSseToAnthropicMessagesSse,
  responsesSseToChatCompletionsSse,
} from '../saas/gateway/responses-bridge/response.js';
import type { Bridge, BridgeError, BridgeStreamResult, BridgeUsage, Protocol } from './bridge.js';
import { parseSseStream } from './sse.js';

export function responsesStreamToAnthropicStream(line: string): any[] {
  const events: any[] = [];
  if (!line.startsWith('data:')) return events;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return events;
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return events;
  }

  if (parsed.type === 'response.output_text.delta') {
    events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parsed.delta } });
  }
  if (parsed.type === 'response.function_call_arguments.delta') {
    events.push({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: parsed.delta },
    });
  }
  return events;
}

/**
 * Maps a normalized Responses usage record onto the proxy-internal
 * `BridgeUsage` contract: `inputTokens` is the total prompt tokens (cached
 * included) and `cacheReadTokens` the cached share, matching
 * `normalizeUsage('responses', …)`. The Responses API has no cache-write
 * concept, so `cacheCreationTokens` stays unset.
 */
function responsesUsageToBridgeUsage(usage: ResponsesUsage | null): BridgeUsage {
  if (usage === null) return {};
  return {
    ...(usage.inputTokens === null ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === null ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cachedTokens === null ? {} : { cacheReadTokens: usage.cachedTokens }),
  };
}

/**
 * OpenAI-in → Responses-out bridge (F3: real conversion, replacing the
 * passthrough stub R5b-2 documented).
 *
 * - URL: `/v1/chat/completions` → `/v1/responses`.
 * - Request: chat.completions body → Responses body (system/developer →
 *   `instructions`, `tool` messages → `function_call_output`, assistant
 *   `tool_calls` → `function_call`, `max_tokens` → `max_output_tokens`).
 * - Response: Responses envelope → chat.completion envelope.
 * - Stream: Responses SSE → chat.completion.chunk SSE (terminal `data: [DONE]`)
 *   with the usage chunk emitted only when the caller opted in.
 */
export class OpenAIToResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'openai';
  readonly upstreamProto: Protocol = 'responses';

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/chat/completions') return '/v1/responses';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    return convertChatCompletionsToResponsesRequest(clientBody);
  }

  transformResponse(upstreamBody: any): any {
    return responsesEnvelopeToChatCompletion(upstreamBody);
  }

  transformStream(
    upstreamStream: ReadableStream<Uint8Array>,
    options?: { readonly includeUsage?: boolean },
  ): BridgeStreamResult {
    const { clientStream, usage } = responsesSseToChatCompletionsSse(upstreamStream, {
      includeUsage: options?.includeUsage ?? false,
    });
    return { clientStream, usage: usage.then(responsesUsageToBridgeUsage) };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return { body: { error: { message, type: errorType, code: null } }, contentType: 'application/json' };
  }
}

/**
 * Anthropic-in → Responses-out bridge.
 *
 * - URL: `/v1/messages` → `/v1/responses`.
 * - Request: Anthropic body → Responses body (`system` → `instructions`,
 *   content blocks → input items, `tool_use`/`tool_result` →
 *   `function_call`/`function_call_output`, `max_tokens` →
 *   `max_output_tokens`).
 * - Response: Responses envelope → Anthropic message envelope.
 * - Stream: Responses SSE → Anthropic SSE event sequence (message_start →
 *   content blocks → message_delta → message_stop) with the codex-borrowed
 *   usage mapping (cached tokens → `cache_read_input_tokens`).
 */
export class AnthToResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'anthropic';
  readonly upstreamProto: Protocol = 'responses';

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/messages') return '/v1/responses';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    return convertAnthropicMessagesToResponsesRequest(clientBody);
  }

  transformResponse(upstreamBody: any): any {
    return responsesEnvelopeToAnthropicMessage(upstreamBody);
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const { clientStream, usage } = responsesSseToAnthropicMessagesSse(upstreamStream);
    return { clientStream, usage: usage.then(responsesUsageToBridgeUsage) };
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
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
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
