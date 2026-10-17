/**
 * Batch-3 Grok response usage extraction (pure). Grok serves the native
 * OpenAI wire shapes on both bases, so usage arrives either as the Responses
 * `response.completed` usage object or the Chat Completions `usage` field;
 * both normalize onto the shared CodexResponsesUsage vocabulary
 * (grok/gateway reuses the sub2api/codex semantic, not the module — the
 * import-free twin keeps the grok package self-contained).
 */

export interface GrokResponseUsage {
  readonly inputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Responses-shape usage object: `{input_tokens, output_tokens, *_tokens_details}`. */
export function parseGrokResponsesUsage(value: unknown): GrokResponseUsage | null {
  if (!isRecord(value)) return null;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : null;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : null;
  return {
    inputTokens: tokenCount(value.input_tokens),
    cachedTokens: inputDetails === null ? null : tokenCount(inputDetails.cached_tokens),
    outputTokens: tokenCount(value.output_tokens),
    reasoningTokens: outputDetails === null ? null : tokenCount(outputDetails.reasoning_tokens),
  };
}

/** Chat Completions usage field: `{prompt_tokens, completion_tokens, ...}`. */
export function parseGrokChatCompletionsUsage(value: unknown): GrokResponseUsage | null {
  if (!isRecord(value)) return null;
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null;
  return {
    inputTokens: tokenCount(value.prompt_tokens),
    cachedTokens: details === null ? null : tokenCount(details.cached_tokens),
    outputTokens: tokenCount(value.completion_tokens),
    reasoningTokens: null,
  };
}

function mergeUsage(left: GrokResponseUsage, right: GrokResponseUsage): GrokResponseUsage {
  return {
    inputTokens: right.inputTokens ?? left.inputTokens,
    cachedTokens: right.cachedTokens ?? left.cachedTokens,
    outputTokens: right.outputTokens ?? left.outputTokens,
    reasoningTokens: right.reasoningTokens ?? left.reasoningTokens,
  };
}

/**
 * Incremental SSE watcher: extracts the usage from every data event of either
 * wire shape (a Responses `response.completed` payload or a Chat Completions
 * chunk carrying `usage`) without buffering whole events; the terminal
 * observation is the last event that carries one.
 */
export class GrokUsageWatcher {
  private buffer = '';
  private usage: GrokResponseUsage | null = null;

  feed(chunk: Uint8Array): void {
    this.buffer += new TextDecoder('utf-8', { fatal: false }).decode(chunk, { stream: true });
    for (let boundary = findEventBoundary(this.buffer); boundary !== null; boundary = findEventBoundary(this.buffer)) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.acceptBlock(block);
    }
    // Bound the buffer so a malformed stream cannot grow it unbounded.
    if (this.buffer.length > 1_048_576) this.buffer = '';
  }

  private acceptBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    // Responses shape: {type: "response.completed", response: {usage: {...}}}.
    if (isRecord(parsed.response)) {
      const usage = parseGrokResponsesUsage((parsed.response as Record<string, unknown>).usage);
      if (usage !== null) this.usage = this.usage === null ? usage : mergeUsage(this.usage, usage);
      return;
    }
    if (parsed.usage !== undefined) {
      const usage = parseGrokChatCompletionsUsage(parsed.usage) ?? parseGrokResponsesUsage(parsed.usage);
      if (usage !== null) this.usage = this.usage === null ? usage : mergeUsage(this.usage, usage);
      return;
    }
    // A bare Responses usage object at the top level.
    const usage = parseGrokResponsesUsage(parsed);
    if (usage !== null && (usage.inputTokens !== null || usage.outputTokens !== null)) {
      this.usage = this.usage === null ? usage : mergeUsage(this.usage, usage);
    }
  }

  /** Non-null only once a usage-carrying event has been observed. */
  get observed(): GrokResponseUsage | null {
    return this.usage;
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
