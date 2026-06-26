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

import { PassthroughAnthropicBridge } from './passthrough-anthropic.js';
import { PassthroughOpenAiBridge } from './passthrough-openai.js';
import { AnthToOpenAIBridge } from './anth-to-openai.js';
import { OpenAIToAnthBridge } from './openai-to-anth.js';
import { parseSseStream } from './sse.js';

/** Stub bridge: passthrough for gemini client <-> gemini upstream. */
class PassthroughGeminiBridge implements Bridge {
  readonly clientProto: Protocol = 'gemini';
  readonly upstreamProto: Protocol = 'gemini';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
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
        if (json?.usageMetadata?.promptTokenCount !== undefined) inputTokens = json.usageMetadata.promptTokenCount;
        if (json?.usageMetadata?.candidatesTokenCount !== undefined) outputTokens = json.usageMetadata.candidatesTokenCount;
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

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
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
        if (json?.response?.usage?.input_tokens !== undefined) inputTokens = json.response.usage.input_tokens;
        if (json?.response?.usage?.output_tokens !== undefined) outputTokens = json.response.usage.output_tokens;
      }
      return { inputTokens, outputTokens };
    })();
    return { clientStream: toClient, usage };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return { body: { error: { message, type: errorType, code: null } }, contentType: 'application/json' };
  }
}

/** Stub bridge: responses -> openai (backward compatible passthrough). */
class ResponsesToOpenAIBridge implements Bridge {
  readonly clientProto: Protocol = 'responses';
  readonly upstreamProto: Protocol = 'openai';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
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
        try { json = JSON.parse(data); } catch { continue; }
        const u = json?.usage;
        if (u && typeof u === 'object') {
          if (u.prompt_tokens !== undefined) inputTokens = u.prompt_tokens;
          if (u.completion_tokens !== undefined) outputTokens = u.completion_tokens;
          const details = u.prompt_tokens_details;
          if (details && typeof details === 'object' && details.cached_tokens !== undefined) {
            cacheReadTokens = details.cached_tokens;
          }
        }
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

/** Stub bridge: openai -> responses (placeholder). */
class OpenAIToResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'openai';
  readonly upstreamProto: Protocol = 'responses';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient] = upstreamStream.tee();
    return { clientStream: toClient, usage: Promise.resolve({}) };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return { body: { error: { message, type: errorType, code: null } }, contentType: 'application/json' };
  }
}

/** Stub bridge: anthropic -> gemini (placeholder for Phase 2). */
class AnthToGeminiBridge implements Bridge {
  readonly clientProto: Protocol = 'anthropic';
  readonly upstreamProto: Protocol = 'gemini';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient] = upstreamStream.tee();
    return { clientStream: toClient, usage: Promise.resolve({}) };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return { body: { type: 'error', error: { type: errorType, message } }, contentType: 'application/json' };
  }
}

/** Stub bridge: gemini -> anthropic (placeholder for Phase 2). */
class GeminiToAnthBridge implements Bridge {
  readonly clientProto: Protocol = 'gemini';
  readonly upstreamProto: Protocol = 'anthropic';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient] = upstreamStream.tee();
    return { clientStream: toClient, usage: Promise.resolve({}) };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return { body: { type: 'error', error: { type: errorType, message } }, contentType: 'application/json' };
  }
}

/** Stub bridge: anthropic -> responses (placeholder for Phase 2). */
class AnthToResponsesBridge implements Bridge {
  readonly clientProto: Protocol = 'anthropic';
  readonly upstreamProto: Protocol = 'responses';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient] = upstreamStream.tee();
    return { clientStream: toClient, usage: Promise.resolve({}) };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return { body: { type: 'error', error: { type: errorType, message } }, contentType: 'application/json' };
  }
}

/** Stub bridge: responses -> anthropic (placeholder for Phase 2). */
class ResponsesToAnthBridge implements Bridge {
  readonly clientProto: Protocol = 'responses';
  readonly upstreamProto: Protocol = 'anthropic';

  rewriteUrlPath(clientPath: string): string { return clientPath; }
  transformRequest(clientBody: any): any { return clientBody; }
  transformResponse(upstreamBody: any): any { return upstreamBody; }
  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient] = upstreamStream.tee();
    return { clientStream: toClient, usage: Promise.resolve({}) };
  }
  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return { body: { type: 'error', error: { type: errorType, message } }, contentType: 'application/json' };
  }
}

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
    return new AnthToGeminiBridge();
  }
  if (clientProto === 'gemini' && upstreamProto === 'anthropic') {
    return new GeminiToAnthBridge();
  }
  if (clientProto === 'anthropic' && upstreamProto === 'responses') {
    return new AnthToResponsesBridge();
  }
  if (clientProto === 'responses' && upstreamProto === 'anthropic') {
    return new ResponsesToAnthBridge();
  }
  throw new Error(`Unsupported bridge: ${clientProto} -> ${upstreamProto}`);
}
