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

/**
 * Pick the bridge for a given (clientProto, upstreamProto) pair.
 * Phase 3 only registers the passthrough bridges; cross-protocol bridges
 * land in Phase 4 (a→o) and Phase 5 (o→a).
 */
export function pickBridge(clientProto: Protocol, upstreamProto: Protocol): Bridge {
  if (clientProto === 'anthropic' && upstreamProto === 'anthropic') {
    return new PassthroughAnthropicBridge();
  }
  if (clientProto === 'openai' && upstreamProto === 'openai') {
    return new PassthroughOpenAiBridge();
  }
  throw new Error(
    `Bridge for ${clientProto} → ${upstreamProto} is not implemented yet (Phase 4/5)`
  );
}
