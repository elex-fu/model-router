export type Protocol = 'anthropic' | 'openai';

export interface BridgeUsage {
  inputTokens?: number;
  outputTokens?: number;
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

/** Pick the bridge for a given (clientProto, upstreamProto) pair. */
export function pickBridge(clientProto: Protocol, upstreamProto: Protocol): Bridge {
  if (clientProto === 'anthropic' && upstreamProto === 'anthropic') {
    return new PassthroughAnthropicBridge();
  }
  if (clientProto === 'openai' && upstreamProto === 'openai') {
    return new PassthroughOpenAiBridge();
  }
  if (clientProto === 'anthropic' && upstreamProto === 'openai') {
    return new AnthToOpenAIBridge();
  }
  if (clientProto === 'openai' && upstreamProto === 'anthropic') {
    return new OpenAIToAnthBridge();
  }
  throw new Error(`Unsupported bridge: ${clientProto} → ${upstreamProto}`);
}
