import { parseSseStream, writeSseEvent } from './sse.js';

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

export function geminiStreamToAnthropicStream(line: any): any {
  const candidate = line.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const contentBlocks: any[] = [];
  for (const part of parts) {
    if (part.text) {
      contentBlocks.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      contentBlocks.push({
        type: 'tool_use',
        id: `toolu_${Math.random().toString(36).slice(2)}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  const event: any = {
    type: 'content_block_delta',
    index: 0,
    delta: {},
  };

  if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
    event.delta = { type: 'text_delta', text: contentBlocks[0].text };
  } else if (contentBlocks.length > 0) {
    event.delta = { type: 'content_block_delta', content_blocks: contentBlocks };
  }

  // If this is the final chunk with usage metadata, emit a message_stop style event
  if (line.usageMetadata) {
    return {
      events: [
        event,
        {
          type: 'message_stop',
          usage: {
            input_tokens: line.usageMetadata.promptTokenCount ?? 0,
            output_tokens: line.usageMetadata.candidatesTokenCount ?? 0,
          },
        },
      ],
    };
  }

  return { events: [event] };
}
