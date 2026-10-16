/**
 * F3 provider-neutral Responses response/SSE conversion (task #36). The
 * down-protocol assemblers (Responses → chat.completions and Responses →
 * Anthropic Messages, streaming and non-streaming) already exist as the P1c
 * codex response bridge (`gateway/codex/response-bridge.ts`); they are pure
 * protocol converters, so this module delegates to them instead of
 * duplicating working code. The only codex-specific behavior inside the
 * assemblers is `restoreReservedToolNames`, a copy-on-walk no-op unless the
 * `python__mr` alias appears — which only codex outbound traffic can produce —
 * so delegation is behaviorally neutral for generic providers.
 *
 * Newly written here: the non-streaming envelope converters (a Responses
 * response object → chat.completion / Anthropic message envelope), which the
 * codex layer never needed because it aggregates from SSE event sequences.
 */

import {
  anthropicUsageFields,
  type CodexResponsesUsage,
  chatCompletionsUsage,
  mapAnthropicStopReason,
  mapChatCompletionsFinishReason,
  parseResponsesUsage,
  responsesSseToAnthropicMessagesSse,
  responsesSseToChatCompletionsSse,
} from '../codex/response-bridge.js';

export type ResponsesUsage = CodexResponsesUsage;
export {
  anthropicUsageFields,
  chatCompletionsUsage,
  mapAnthropicStopReason,
  mapChatCompletionsFinishReason,
  parseResponsesUsage,
  responsesSseToAnthropicMessagesSse,
  responsesSseToChatCompletionsSse,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createdTimestamp(nowMs: () => number): number {
  return Math.floor(nowMs() / 1000);
}

function responseOutputItems(envelope: unknown): unknown[] {
  if (!isRecord(envelope) || !Array.isArray(envelope.output)) return [];
  return envelope.output;
}

function messageItemText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return '';
  const parts: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part)) continue;
    if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'refusal' && typeof part.refusal === 'string') parts.push(part.refusal);
  }
  return parts.join('');
}

interface TerminalStatus {
  readonly status: string | null;
  readonly incompleteReason: string | null;
  readonly usage: ResponsesUsage | null;
}

function envelopeTerminalStatus(envelope: Record<string, unknown>): TerminalStatus {
  const incomplete = isRecord(envelope.incomplete_details) ? envelope.incomplete_details : null;
  return {
    status: typeof envelope.status === 'string' ? envelope.status : null,
    incompleteReason: incomplete !== null && typeof incomplete.reason === 'string' ? incomplete.reason : null,
    usage: parseResponsesUsage(envelope.usage),
  };
}

/**
 * Non-streaming conversion: a Responses response envelope → one
 * chat.completion envelope (text content, tool_calls, usage with the cached
 * token bucket, terminal finish reason).
 */
export function responsesEnvelopeToChatCompletion(
  envelope: unknown,
  options: { readonly fallbackModel?: string; readonly nowMs?: () => number } = {},
): Record<string, unknown> {
  const record = isRecord(envelope) ? envelope : {};
  const facts = envelopeTerminalStatus(record);
  const textParts: string[] = [];
  const toolCalls: Array<{
    index: number;
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];
  for (const item of responseOutputItems(record)) {
    if (!isRecord(item)) continue;
    if (item.type === 'message') {
      const text = messageItemText(item);
      if (text.length > 0) textParts.push(text);
    } else if (item.type === 'function_call') {
      toolCalls.push({
        index: toolCalls.length,
        id: typeof item.call_id === 'string' ? item.call_id : '',
        type: 'function',
        function: { name: typeof item.name === 'string' ? item.name : '', arguments: '' },
      });
      const last = toolCalls[toolCalls.length - 1];
      last.function.arguments = typeof item.arguments === 'string' ? item.arguments : '';
    }
  }
  const finishReason = mapChatCompletionsFinishReason(facts.status, facts.incompleteReason, toolCalls.length > 0);
  const message: Record<string, unknown> = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const result: Record<string, unknown> = {
    id: typeof record.id === 'string' ? record.id : '',
    object: 'chat.completion',
    created: createdTimestamp(options.nowMs ?? Date.now),
    model: typeof record.model === 'string' ? record.model : (options.fallbackModel ?? ''),
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  };
  if (facts.usage !== null) result.usage = chatCompletionsUsage(facts.usage);
  return result;
}

/**
 * Non-streaming conversion: a Responses response envelope → one Anthropic
 * Messages envelope (text + tool_use content blocks, stop_reason, usage with
 * the cached-token mapping: `input_tokens` excludes cached tokens, cached
 * tokens become `cache_read_input_tokens`).
 */
export function responsesEnvelopeToAnthropicMessage(
  envelope: unknown,
  options: { readonly fallbackModel?: string } = {},
): Record<string, unknown> {
  const record = isRecord(envelope) ? envelope : {};
  const facts = envelopeTerminalStatus(record);
  const textParts: string[] = [];
  const toolBlocks: Array<Record<string, unknown>> = [];
  for (const item of responseOutputItems(record)) {
    if (!isRecord(item)) continue;
    if (item.type === 'message') {
      const text = messageItemText(item);
      if (text.length > 0) textParts.push(text);
    } else if (item.type === 'function_call') {
      let input: unknown = {};
      const argumentsText = typeof item.arguments === 'string' ? item.arguments : '';
      if (argumentsText.length > 0) {
        try {
          input = JSON.parse(argumentsText);
        } catch {
          input = {};
        }
      }
      toolBlocks.push({
        type: 'tool_use',
        id: typeof item.call_id === 'string' ? item.call_id : '',
        name: typeof item.name === 'string' ? item.name : '',
        input,
      });
    }
  }
  const stopReason = mapAnthropicStopReason(facts.status, facts.incompleteReason, toolBlocks.length > 0);
  const content: Array<Record<string, unknown>> = [];
  if (textParts.length > 0) content.push({ type: 'text', text: textParts.join('') });
  content.push(...toolBlocks);
  return {
    id: typeof record.id === 'string' ? record.id : '',
    type: 'message',
    role: 'assistant',
    model: typeof record.model === 'string' ? record.model : (options.fallbackModel ?? ''),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(facts.usage === null
      ? {}
      : { usage: { ...anthropicUsageFields(facts.usage), output_tokens: facts.usage.outputTokens ?? 0 } }),
  };
}
