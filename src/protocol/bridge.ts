export type Protocol = 'anthropic' | 'openai' | 'gemini' | 'responses';

export interface BridgeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface BridgeStreamResult {
  /** Bytes to forward to the client. */
  clientStream: ReadableStream<Uint8Array>;
  /** Resolves with usage once the upstream stream has been fully consumed. */
  usage: Promise<BridgeUsage>;
}

export interface BridgeError {
  body: any;
  contentType: string;
}

export interface Bridge {
  readonly clientProto: Protocol;
  readonly upstreamProto: Protocol;

  /** Rewrite the path the client requested into the path the upstream expects. */
  rewriteUrlPath(clientPath: string): string;

  /** Transform the request body. Passthrough bridges return as-is. */
  transformRequest(clientBody: any): any;

  /** Non-streaming response transform. Passthrough bridges return as-is. */
  transformResponse(upstreamBody: any): any;

  /** Streaming response transform. Returns a client stream + a usage promise. */
  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult;

  /** Wrap an error message into the *client* protocol's error envelope. */
  wrapError(statusCode: number, message: string): BridgeError;
}

export abstract class BaseBridge implements Bridge {
  abstract readonly clientProto: Protocol;
  abstract readonly upstreamProto: Protocol;

  abstract rewriteUrlPath(clientPath: string): string;
  abstract transformRequest(clientBody: any): any;
  abstract transformResponse(upstreamBody: any): any;
  abstract transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult;
  abstract wrapError(statusCode: number, message: string): BridgeError;
}

import { normalizeUsage } from '../providers/usage.js';
import {
  type NamespacedToolName,
  type ResponsesToChatToolMapping,
  responsesToChatCompletionsRequest,
} from '../saas/gateway/responses-bridge/reverse-request.js';
import {
  ChatCompletionsToResponsesStream,
  chatCompletionsResponseToResponses,
} from '../saas/gateway/responses-bridge/reverse-response.js';
import { AnthToOpenAIBridge } from './anth-to-openai.js';
import { AnthToGeminiBridge, GeminiToAnthBridge } from './gemini.js';
import { OpenAIToAnthBridge } from './openai-to-anth.js';
import { PassthroughAnthropicBridge } from './passthrough-anthropic.js';
import { PassthroughOpenAiBridge } from './passthrough-openai.js';
import { AnthToResponsesBridge, OpenAIToResponsesBridge, ResponsesToAnthBridge } from './responses.js';
import { parseSseStream } from './sse.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stub bridge: passthrough for gemini client <-> gemini upstream. */
class PassthroughGeminiBridge implements Bridge {
  readonly clientProto: Protocol = 'gemini';
  readonly upstreamProto: Protocol = 'gemini';

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
        if (json?.usageMetadata?.promptTokenCount !== undefined) inputTokens = json.usageMetadata.promptTokenCount;
        if (json?.usageMetadata?.candidatesTokenCount !== undefined)
          outputTokens = json.usageMetadata.candidatesTokenCount;
      }
      return { inputTokens, outputTokens };
    })();
    return { clientStream: toClient, usage };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return { body: { error: { message, code: errorType } }, contentType: 'application/json' };
  }
}

/** Stub bridge: passthrough for responses client <-> responses upstream. */
class PassthroughResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'responses';
  readonly upstreamProto: Protocol = 'responses';

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
      let cacheReadTokens: number | undefined;
      for await (const ev of parseSseStream(toParser)) {
        const data = ev.data;
        if (!data || data === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const u = normalizeUsage('responses', json?.response);
        if (u.inputTokens !== undefined) inputTokens = u.inputTokens;
        if (u.outputTokens !== undefined) outputTokens = u.outputTokens;
        if (u.cacheReadTokens !== undefined) cacheReadTokens = u.cacheReadTokens;
      }
      return { inputTokens, outputTokens, cacheReadTokens };
    })();
    return { clientStream: toClient, usage };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return { body: { error: { message, type: errorType, code: null } }, contentType: 'application/json' };
  }
}

/**
 * Bridge: responses -> openai (apicompat PhaseA: real conversion, replacing
 * the former passthrough stub).
 *
 * - URL: `/v1/responses` → `/v1/chat/completions`.
 * - Request: Responses body → chat.completions body
 *   (`responsesToChatCompletionsRequest`): instructions + leading developer
 *   items merge into one leading system message; `reasoning.effort` →
 *   `reasoning_effort`; `max_output_tokens` → `max_completion_tokens`; input
 *   items map one-by-one (message / function_call / custom_tool_call /
 *   tool_search_call / *_output / agent_message / reasoning), reasoning text
 *   is double-buffered onto the owning assistant's `reasoning_content`,
 *   truncated tool_call+output pairs are skipped whole, and item types with
 *   no chat equivalent are dropped.
 * - Response: chat.completion → Responses envelope; custom/freeform tools,
 *   tool_search and flattened namespace tools are restored on the way back
 *   using the identity mapping recorded by transformRequest.
 * - Stream: chat.completion.chunk SSE → Responses SSE events, finalized
 *   idempotently when the upstream stream is cut.
 *
 * Instances are per-request (the proxy creates a fresh bridge for every
 * upstream attempt): transformRequest records the tool mapping that
 * transformResponse/transformStream need; reusing an instance across
 * requests would leak the mapping.
 */
class ResponsesToOpenAIBridge implements Bridge {
  readonly clientProto: Protocol = 'responses';
  readonly upstreamProto: Protocol = 'openai';

  private mapping: ResponsesToChatToolMapping | null = null;

  rewriteUrlPath(clientPath: string): string {
    if (clientPath === '/v1/responses') return '/v1/chat/completions';
    return clientPath;
  }

  transformRequest(clientBody: any): any {
    const result = responsesToChatCompletionsRequest(clientBody);
    this.mapping = result.mapping;
    return result.body;
  }

  transformResponse(upstreamBody: any): any {
    const mapping = this.mapping;
    return chatCompletionsResponseToResponses(upstreamBody, {
      ...(mapping ?? {
        customTools: new Set<string>(),
        functionTools: new Set<string>(),
        toolSearch: false,
        namespaceTools: new Map<string, NamespacedToolName>(),
      }),
      model: mapping?.model,
    });
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const mapping = this.mapping;
    const state = new ChatCompletionsToResponsesStream({
      customTools: mapping?.customTools ?? new Set<string>(),
      functionTools: mapping?.functionTools ?? new Set<string>(),
      toolSearch: mapping?.toolSearch ?? false,
      namespaceTools: mapping?.namespaceTools ?? new Map<string, NamespacedToolName>(),
      model: mapping?.model,
    });
    const encoder = new TextEncoder();
    let resolveUsage!: (usage: BridgeUsage) => void;
    const usage = new Promise<BridgeUsage>((resolve) => {
      resolveUsage = resolve;
    });
    const observedToBridgeUsage = (): BridgeUsage => {
      const observed = state.observedUsage;
      if (observed === null) return {};
      const details = observed.input_tokens_details;
      const cached = isRecord(details) && typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined;
      return {
        inputTokens: observed.input_tokens,
        outputTokens: observed.output_tokens,
        ...(cached === undefined ? {} : { cacheReadTokens: cached }),
      };
    };

    const clientStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const emit = (events: readonly Record<string, unknown>[]): void => {
          if (closed) return;
          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        };
        const finalize = (): void => {
          // Truncated tool-call arguments must not be emitted as completed
          // items (a strict client persists and replays them); the stream
          // then ends without a terminal event, mirroring the Go gateway.
          if (state.validateToolCallArguments() !== null) return;
          emit(state.finalize());
        };
        try {
          for await (const ev of parseSseStream(upstreamStream)) {
            const data = ev.data;
            if (!data || data === '[DONE]') continue;
            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            emit(state.push(chunk));
          }
          finalize();
        } catch {
          // 断流 finalize：the upstream stream was cut mid-flight; keep the
          // client protocol well-formed when nothing terminal was emitted.
          try {
            finalize();
          } catch {
            // never expected; nothing more we can do for the client
          }
        } finally {
          resolveUsage(observedToBridgeUsage());
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed via cancellation
            }
          }
        }
      },
      cancel() {
        resolveUsage(observedToBridgeUsage());
      },
    });
    return { clientStream, usage };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return { body: { error: { message, type: errorType, code: null } }, contentType: 'application/json' };
  }
}

/** Bridge: anthropic -> gemini. */
class AnthToGeminiBridgeImpl extends AnthToGeminiBridge {}

/** Bridge: gemini -> anthropic. */
class GeminiToAnthBridgeImpl extends GeminiToAnthBridge {}

/** Bridge: anthropic -> responses (F3: real conversion). */
class AnthToResponsesBridgeImpl extends AnthToResponsesBridge {}

/** Stub bridge: responses -> anthropic (placeholder for Phase 2). */
class ResponsesToAnthBridgeImpl extends ResponsesToAnthBridge {}

/** Pick the bridge for a given (clientProto, upstreamProto) pair. */
export function pickBridge(clientProto: Protocol, upstreamProto: Protocol): Bridge {
  if (clientProto === 'anthropic' && upstreamProto === 'anthropic') {
    return new PassthroughAnthropicBridge();
  }
  if (clientProto === 'openai' && upstreamProto === 'openai') {
    return new PassthroughOpenAiBridge();
  }
  if (clientProto === 'gemini' && upstreamProto === 'gemini') {
    return new PassthroughGeminiBridge();
  }
  if (clientProto === 'responses' && upstreamProto === 'responses') {
    return new PassthroughResponsesBridge();
  }
  if (clientProto === 'anthropic' && upstreamProto === 'openai') {
    return new AnthToOpenAIBridge();
  }
  if (clientProto === 'openai' && upstreamProto === 'anthropic') {
    return new OpenAIToAnthBridge();
  }
  if (clientProto === 'responses' && upstreamProto === 'openai') {
    return new ResponsesToOpenAIBridge();
  }
  if (clientProto === 'openai' && upstreamProto === 'responses') {
    return new OpenAIToResponsesBridge();
  }
  if (clientProto === 'anthropic' && upstreamProto === 'gemini') {
    return new AnthToGeminiBridgeImpl();
  }
  if (clientProto === 'gemini' && upstreamProto === 'anthropic') {
    return new GeminiToAnthBridgeImpl();
  }
  if (clientProto === 'anthropic' && upstreamProto === 'responses') {
    return new AnthToResponsesBridgeImpl();
  }
  if (clientProto === 'responses' && upstreamProto === 'anthropic') {
    return new ResponsesToAnthBridgeImpl();
  }
  throw new Error(`Unsupported bridge: ${clientProto} -> ${upstreamProto}`);
}
