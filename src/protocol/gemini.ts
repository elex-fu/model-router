import { GeminiShadowStore } from './gemini-shadow.js';

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
