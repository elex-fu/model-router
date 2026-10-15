import type { GatewayProtocol } from '../contracts.js';
import { resolveCodexInstructions } from './instructions.js';
import { aliasReservedToolNames, applyCodexOAuthTransform } from './transform.js';

/**
 * P1c Codex payload compilation layer (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.4/1.5). The gateway
 * payload compiler first produces a Responses-shaped provider body using the
 * standard `src/protocol/` bridge for the client protocol; this layer then
 * applies the codex-specific rules on top:
 *
 * - a `chat.completions` client body is converted to the Responses shape
 *   (`/v1/chat/completions` support; the generic bridge for the
 *   openai→responses pair is a passthrough by design);
 * - `instructions` is guaranteed non-empty (the ChatGPT codex endpoint
 *   rejects an empty field);
 * - `applyCodexOAuthTransform` (transform.ts) enforces store/stream/system
 *   promotion/whitelisting/aliasing on the final outbound body.
 */

interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: unknown;
  readonly name?: unknown;
}

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

/**
 * Converts a chat.completions request body into a Responses request body.
 * System messages become `instructions`; assistant tool_calls become
 * `function_call` input items; `tool` role messages become
 * `function_call_output` items. Pure: the input is never mutated.
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

/**
 * The codex compile step applied after the protocol bridge: instructions
 * injection, then the full codex OAuth transform (field whitelist,
 * store/stream forcing, aliasing). Pure; the input is never mutated.
 */
export function applyCodexCompilation(body: unknown, options: { readonly clientInstructions?: unknown } = {}): unknown {
  if (!isRecord(body)) return body;
  const withInstructions: Record<string, unknown> = {
    ...body,
    instructions: resolveCodexInstructions(options.clientInstructions ?? body.instructions),
  };
  return applyCodexOAuthTransform(withInstructions);
}

/** Context the compiler hook receives for one outbound provider body. */
export interface CodexProviderRequestTransformInput {
  readonly providerId: string;
  readonly productId: string;
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly providerOperation: string;
  readonly body: Record<string, unknown>;
}

/**
 * The compiler hook for codex traffic: converts a chat.completions client
 * body to the Responses shape when the generic bridge could not, then applies
 * the codex compilation (instructions + OAuth transform + reserved-tool
 * aliasing). Non-codex providers never see this hook.
 */
export function codexProviderRequestTransform(input: CodexProviderRequestTransformInput): unknown {
  const bridgeBody =
    input.clientProtocol === 'openai' && input.providerProtocol === 'responses'
      ? (convertChatCompletionsToResponsesRequest(input.body) as Record<string, unknown>)
      : input.body;
  return applyCodexCompilation(bridgeBody);
}

/** Alias kept for composition wiring symmetry with the transport factory. */
export function createCodexProviderRequestTransform(): (input: CodexProviderRequestTransformInput) => unknown {
  return codexProviderRequestTransform;
}

/** Re-exported for compile-layer tests: the aliasing step is part of this layer's contract. */
export { aliasReservedToolNames };
