import { normalizeUsage } from '../providers/usage.js';
import type { Bridge, BridgeError, BridgeStreamResult, BridgeUsage, Protocol } from './bridge.js';
import { parseSseStream } from './sse.js';

/**
 * OpenAI ↔ OpenAI passthrough bridge.
 *
 * Streaming usage extraction:
 * - Each `data:` chunk is a JSON object like
 *   `{choices:[{delta:...}], usage?:{prompt_tokens, completion_tokens}}`.
 * - Usually only the LAST chunk before `[DONE]` carries `usage` (when the
 *   client opted in via `stream_options: { include_usage: true }`); we keep the
 *   most recent non-null `usage` we see.
 * - If no chunk carries usage, both fields are `undefined`.
 *
 * Non-streaming usage extraction is the proxy's job — `transformResponse` is
 * pure passthrough; the proxy reads `body.usage` directly.
 */
export class PassthroughOpenAiBridge implements Bridge {
  readonly clientProto: Protocol = 'openai';
  readonly upstreamProto: Protocol = 'openai';

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
        if (json?.usage) {
          const u = normalizeUsage('openai', json);
          if (u.inputTokens !== undefined) inputTokens = u.inputTokens;
          if (u.outputTokens !== undefined) outputTokens = u.outputTokens;
          if (u.cacheReadTokens !== undefined) cacheReadTokens = u.cacheReadTokens;
        }
      }

      return { inputTokens, outputTokens, cacheReadTokens };
    })();

    return { clientStream: toClient, usage };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_exceeded' : 'server_error';
    return {
      body: {
        error: {
          message,
          type: errorType,
          code: null,
        },
      },
      contentType: 'application/json',
    };
  }
}
