import type {
  Bridge,
  BridgeError,
  BridgeStreamResult,
  BridgeUsage,
  Protocol,
} from './bridge.js';
import { parseSseStream } from './sse.js';

/**
 * Anthropic ↔ Anthropic passthrough bridge.
 *
 * Streaming usage extraction (ported from the legacy AnthropicAdapter):
 * - `message_start` event carries `message.usage.input_tokens` (and an initial
 *   `output_tokens` we ignore in favour of message_delta).
 * - `message_delta` events carry cumulative `usage.output_tokens`; the LAST one wins.
 */
export class PassthroughAnthropicBridge implements Bridge {
  readonly clientProto: Protocol = 'anthropic';
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

        if (json?.type === 'message_start') {
          const u = json.message?.usage;
          if (u?.input_tokens !== undefined) inputTokens = u.input_tokens;
          if (u?.output_tokens !== undefined && outputTokens === undefined) {
            outputTokens = u.output_tokens;
          }
        } else if (json?.type === 'message_delta') {
          const u = json.usage;
          if (u?.output_tokens !== undefined) outputTokens = u.output_tokens;
        }
      }

      return { inputTokens, outputTokens };
    })();

    return { clientStream: toClient, usage };
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
