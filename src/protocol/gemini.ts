import { GeminiShadowStore } from './gemini-shadow.js';
import type { BaseBridge } from './bridge.js';
import type { BridgeStreamResult, BridgeError, BridgeUsage } from './bridge.js';
import { parseSseStream } from './sse.js';

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
}

export function anthropicToGeminiRequest(body: any, model: string): {
  urlPath: string;
  payload: any;
} {
  const contents: GeminiContent[] = [];
  // Map messages: user -> user, assistant -> model
  for (const msg of body.messages ?? []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiContent['parts'] = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') parts.push({ text: block.text });
        if (block.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: block.source?.media_type ?? 'image/png',
              data: block.source?.data ?? '',
            },
          });
        }
      }
    }
    contents.push({ role, parts });
  }

  const systemParts: Array<{ text: string }> = [];
  if (typeof body.system === 'string') {
    systemParts.push({ text: body.system });
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.type === 'text') systemParts.push({ text: block.text });
    }
  }

  const payload: any = {
    contents,
    generationConfig: {
      maxOutputTokens: body.max_tokens ?? 4096,
      temperature: body.temperature,
      topP: body.top_p,
    },
  };
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools.map((t: any) => ({
      functionDeclarations: [{ name: t.name, description: t.description, parameters: t.input_schema }],
    }));
  }

  const streamSuffix = body.stream ? '?alt=sse' : '';
  return { urlPath: `/v1beta/models/${model}:generateContent${streamSuffix}`, payload };
}

export function geminiToAnthropicResponse(body: any): any {
  const candidate = body.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: any[] = [];
  for (const part of parts) {
    if (part.text) content.push({ type: 'text', text: part.text });
    if (part.functionCall) {
      content.push({
        type: 'tool_use',
        id: `toolu_${Math.random().toString(36).slice(2)}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  return {
    id: `gemini-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'gemini-unknown',
    content,
    usage: {
      input_tokens: body.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    },
    stop_reason: candidate?.finishReason === 'STOP' ? 'end_turn' : 'stop_sequence',
  };
}

export class AnthToGeminiBridge implements BaseBridge {
  readonly clientProto = 'anthropic' as const;
  readonly upstreamProto = 'gemini' as const;

  rewriteUrlPath(_clientPath: string): string {
    return '/v1beta/models/model:generateContent';
  }

  transformRequest(body: any): any {
    const model = body.model ?? 'gemini-2.5-pro';
    const { payload } = anthropicToGeminiRequest(body, model);
    return payload;
  }

  transformResponse(body: any): any {
    return geminiToAnthropicResponse(body);
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient, toParser] = upstreamStream.tee();
    const store = new GeminiShadowStore();
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

    const encoder = new TextEncoder();
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          for (const event of geminiStreamToAnthropicStream(trimmed, store)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        }
      },
    });

    return { clientStream: toClient.pipeThrough(transform), usage };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return { body: { type: 'error', error: { type: errorType, message } }, contentType: 'application/json' };
  }
}

export class GeminiToAnthBridge implements BaseBridge {
  readonly clientProto = 'gemini' as const;
  readonly upstreamProto = 'anthropic' as const;

  rewriteUrlPath(clientPath: string): string {
    return clientPath;
  }

  transformRequest(body: any): any {
    return body;
  }

  transformResponse(body: any): any {
    return body;
  }

  transformStream(upstreamStream: ReadableStream<Uint8Array>): BridgeStreamResult {
    const [toClient] = upstreamStream.tee();
    return { clientStream: toClient, usage: Promise.resolve({}) };
  }

  wrapError(statusCode: number, message: string): BridgeError {
    const errorType = statusCode === 429 ? 'rate_limit_error' : 'api_error';
    return { body: { type: 'error', error: { type: errorType, message } }, contentType: 'application/json' };
  }
}

export function geminiStreamToAnthropicStream(
  line: string,
  store: GeminiShadowStore
): any[] {
  const events: any[] = [];
  if (!line.startsWith('data:')) return events;
  const data = line.slice(5).trim();
  if (!data) return events;
  let parsed: any;
  try { parsed = JSON.parse(data); } catch { return events; }

  const candidate = parsed.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  for (const part of parts) {
    if (part.text) {
      events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.text } });
    }
    if (part.functionCall) {
      const id = `toolu_${Math.random().toString(36).slice(2)}`;
      store.remember(id, part.functionCall.name, part.functionCall.args ?? {});
      events.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: part.functionCall.name, input: {} } });
      events.push({
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  return events;
}
