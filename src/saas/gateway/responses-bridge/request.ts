/**
 * F3 provider-neutral Responses request conversion (task #36). Pure
 * JSON-in/JSON-out helpers that turn the two chat client protocol bodies into
 * a Responses API request body. The chat.completions mapping is lifted from
 * the codex compile layer (gateway/codex/payload.ts
 * `convertChatCompletionsToResponsesRequest`); the Anthropic Messages mapping
 * is the provider-neutral generalization of the placeholder in
 * `src/protocol/responses.ts` (tool_use/tool_result now map to
 * `function_call`/`function_call_output` instead of being flattened into
 * text). Nothing here is codex-specific: no field whitelisting, no store/stream
 * forcing, no tool-name aliasing — those remain the codex compile layer's job.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: unknown;
  readonly name?: unknown;
}

/**
 * Converts a chat.completions request body into a Responses request body.
 * System/developer messages become `instructions`; `tool` role messages become
 * `function_call_output` items; assistant `tool_calls` become `function_call`
 * items; `max_tokens`/`max_completion_tokens` become `max_output_tokens`.
 * Pure: the input is never mutated. Semantics are identical to the codex
 * compile layer's converter so the two paths cannot drift.
 */
export function convertChatCompletionsToResponsesRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const input: unknown[] = [];
  const systemTexts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === 'string' ? message.role : '';
    if (role === 'system' || role === 'developer') {
      const text = textContent(message.content);
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        output: textContent(message.content),
      });
      continue;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const text = textContent(message.content);
      if (text.length > 0) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        input.push({
          type: 'function_call',
          call_id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.function.name === 'string' ? call.function.name : '',
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
        });
      }
      continue;
    }
    const contentText = textContent(message.content);
    input.push({ role, content: contentText });
  }

  const result: Record<string, unknown> = {
    model: body.model,
    input,
  };
  const system = systemTexts.join('\n\n');
  if (system.length > 0) result.instructions = system;
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map((tool) => {
      if (!isRecord(tool) || !isRecord(tool.function)) return tool;
      const converted: Record<string, unknown> = { type: 'function', name: tool.function.name };
      if (tool.function.description !== undefined) converted.description = tool.function.description;
      if (tool.function.parameters !== undefined) converted.parameters = tool.function.parameters;
      if (tool.function.strict !== undefined) converted.strict = tool.function.strict;
      return converted;
    });
  }
  if (body.tool_choice !== undefined) result.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_output_tokens = body.max_completion_tokens;
  if (body.stream !== undefined) result.stream = body.stream;
  if (body.metadata !== undefined) result.metadata = body.metadata;
  return result;
}

interface AnthropicContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly source?: unknown;
}

function anthropicSystemText(system: unknown): string | null {
  if (typeof system === 'string') return system.length > 0 ? system : null;
  if (!Array.isArray(system)) return null;
  const parts: string[] = [];
  for (const block of system) {
    if (isRecord(block) && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Flattens an Anthropic `tool_result` content value into an output string. */
function toolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join('\n');
}

/** Maps an Anthropic image block onto a Responses `input_image` part. */
function imagePart(block: AnthropicContentBlock): Record<string, unknown> | null {
  const source = isRecord(block.source) ? block.source : null;
  if (source !== null && source.type === 'base64') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream';
    const data = typeof source.data === 'string' ? source.data : '';
    return { type: 'input_image', image_url: `data:${mediaType};base64,${data}` };
  }
  if (source !== null && source.type === 'url' && typeof source.url === 'string') {
    return { type: 'input_image', image_url: source.url };
  }
  if (typeof block.source === 'string') {
    return { type: 'input_image', image_url: block.source };
  }
  return null;
}

function convertAnthropicToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === 'string') return toolChoice === 'any' ? 'required' : toolChoice;
  if (!isRecord(toolChoice)) return toolChoice;
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', name: toolChoice.name };
  }
  return undefined;
}

/**
 * Converts an Anthropic Messages request body into a Responses request body.
 * `system` becomes `instructions`; content blocks become input items (text →
 * `input_text`/`output_text`, images → `input_image`); `tool_use` blocks
 * become `function_call` items and `tool_result` blocks become
 * `function_call_output` items; `max_tokens` becomes `max_output_tokens`.
 * Thinking blocks are dropped (Responses reasoning is not client-replayable).
 * Pure: the input is never mutated.
 */
export function convertAnthropicMessagesToResponsesRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const messages = Array.isArray(body.messages) ? (body.messages as AnthropicContentBlock[]) : [];
  const input: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const rawRole = typeof message.role === 'string' ? message.role : 'user';
    if (rawRole === 'system') continue; // defensive: Anthropic system is top-level
    const role = rawRole === 'assistant' ? 'assistant' : 'user';
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof message.content === 'string') {
      input.push({ role, content: [{ type: textType, text: message.content }] });
      continue;
    }
    if (!Array.isArray(message.content)) {
      input.push({ role, content: [{ type: textType, text: '' }] });
      continue;
    }
    const pendingText: Array<Record<string, unknown>> = [];
    const flushText = (): void => {
      if (pendingText.length === 0) return;
      input.push({ role, content: [...pendingText] });
      pendingText.length = 0;
    };
    for (const block of message.content as AnthropicContentBlock[]) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        pendingText.push({ type: textType, text: block.text });
        continue;
      }
      if (block.type === 'tool_use') {
        flushText();
        input.push({
          type: 'function_call',
          call_id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
        });
        continue;
      }
      if (block.type === 'tool_result') {
        flushText();
        input.push({
          type: 'function_call_output',
          call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          output: toolResultOutput(block.content),
        });
        continue;
      }
      if (block.type === 'image') {
        const part = imagePart(block);
        if (part !== null) pendingText.push(part);
      }
      // thinking / redacted_thinking / unknown blocks carry no Responses
      // equivalent on the request path.
    }
    flushText();
  }

  const result: Record<string, unknown> = {
    model: body.model,
    input,
  };
  const instructions = anthropicSystemText(body.system);
  if (instructions !== null) result.instructions = instructions;
  if (Array.isArray(body.tools)) {
    const tools: unknown[] = [];
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') continue;
      const converted: Record<string, unknown> = { type: 'function', name: tool.name };
      if (tool.description !== undefined) converted.description = tool.description;
      if (tool.input_schema !== undefined) converted.parameters = tool.input_schema;
      tools.push(converted);
    }
    if (tools.length > 0) result.tools = tools;
  }
  const toolChoice = convertAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens;
  if (body.stream !== undefined) result.stream = body.stream;
  if (body.thinking) {
    const effort = isRecord(body.thinking) && body.thinking.type === 'adaptive' ? 'high' : 'medium';
    result.reasoning = { effort };
  }
  return result;
}
