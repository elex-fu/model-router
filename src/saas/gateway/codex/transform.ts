/**
 * P1a Codex request transformation (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4). Pure JSON-in/JSON-out
 * helpers: nothing here touches HTTP, streams, or storage. The gateway
 * applies `applyCodexOAuthTransform` to every outbound Responses body headed
 * for `chatgpt.com/backend-api/codex/responses` and applies
 * `restoreReservedToolNames` to every response/SSE frame coming back.
 *
 * Rules (conservative whitelist — anything not listed is stripped):
 * - `store` is forced to `false` and `stream` to `true`.
 * - `reasoning` (when present) forces `include` to contain
 *   `reasoning.encrypted_content`.
 * - Legacy `functions`/`function_call` are folded into `tools`/`tool_choice`.
 * - `system` role messages in `input` are promoted into `instructions`
 *   (prepended to any existing instructions).
 * - A string `input` becomes a single user message array.
 * - Tool call ids are normalized to the `fc_` prefix and capped at 64 chars.
 * - The reserved tool name `python` is aliased to `python__mr` on the way out
 *   and restored on the way back.
 * - `model` passes through `normalizeCodexModel` (alias table + reasoning
 *   suffix stripping).
 */

export type CodexTransformErrorCode = 'MALFORMED_BODY';

export class CodexTransformError extends Error {
  constructor(readonly code: CodexTransformErrorCode) {
    super('codex request body is malformed');
    this.name = 'CodexTransformError';
  }
}

/** Tool name the upstream reserves for its own python runtime. */
export const CODEX_RESERVED_TOOL_NAME = 'python';
/** Alias substituted for the reserved tool name on outbound requests. */
export const CODEX_RESERVED_TOOL_ALIAS = 'python__mr';

const REASONING_ENCRYPTED_INCLUDE = 'reasoning.encrypted_content';

/** Conservative outbound field whitelist; everything else is stripped. */
const CODEX_REQUEST_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'reasoning',
  'include',
  'prompt_cache_key',
  'parallel_tool_calls',
  'text',
  'store',
  'stream',
  'temperature',
  'top_p',
  'max_output_tokens',
]);

/** Model alias table: names the upstream no longer serves, mapped to successors. */
const CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gpt-5.1-codex-max': 'gpt-5.3-codex',
};

const REASONING_SUFFIX_PATTERN = /-(high|medium|low)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripReasoningSuffixes(model: string): string {
  let current = model;
  while (REASONING_SUFFIX_PATTERN.test(current) && current.length > '-high'.length) {
    current = current.replace(REASONING_SUFFIX_PATTERN, '');
  }
  return current;
}

/**
 * Normalizes a client-visible model name to one the codex backend accepts:
 * reasoning-effort suffixes (`-high`/`-medium`/`-low`) are stripped (the
 * effort belongs in `reasoning.effort`, not the model id) and retired model
 * ids are mapped through the alias table. Unknown names pass through.
 */
export function normalizeCodexModel(model: string): string {
  if (typeof model !== 'string' || model.length === 0) return model;
  const stripped = stripReasoningSuffixes(model);
  const aliased = CODEX_MODEL_ALIASES[stripped] ?? stripped;
  return stripReasoningSuffixes(aliased);
}

function aliasToolDefinition(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  if (tool.name === CODEX_RESERVED_TOOL_NAME) {
    return { ...tool, name: CODEX_RESERVED_TOOL_ALIAS };
  }
  const fn = tool.function;
  if (isRecord(fn) && fn.name === CODEX_RESERVED_TOOL_NAME) {
    return { ...tool, function: { ...fn, name: CODEX_RESERVED_TOOL_ALIAS } };
  }
  return tool;
}

function aliasToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') return toolChoice;
  if (!isRecord(toolChoice)) return toolChoice;
  const fn = toolChoice.function;
  if (isRecord(fn) && fn.name === CODEX_RESERVED_TOOL_NAME) {
    return { ...toolChoice, function: { ...fn, name: CODEX_RESERVED_TOOL_ALIAS } };
  }
  return toolChoice;
}

function aliasInputItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (item.type === 'function_call' && item.name === CODEX_RESERVED_TOOL_NAME) {
    return { ...item, name: CODEX_RESERVED_TOOL_ALIAS };
  }
  if (item.type === 'custom_tool_call' && item.name === CODEX_RESERVED_TOOL_NAME) {
    return { ...item, name: CODEX_RESERVED_TOOL_ALIAS };
  }
  return item;
}

/**
 * Renames the reserved tool name to its proxy alias everywhere a request can
 * reference a tool by name: the `tools` list, `tool_choice`, and tool-call
 * items inside `input`. Pure: the input value is never mutated.
 */
export function aliasReservedToolNames(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const next: Record<string, unknown> = { ...body };
  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map((tool) => aliasToolDefinition(tool));
  }
  next.tool_choice = aliasToolChoice(next.tool_choice);
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => aliasInputItem(item));
  }
  return next;
}

interface RestoreResult {
  readonly changed: boolean;
  readonly value: unknown;
}

function restoreValue(value: unknown): RestoreResult {
  if (typeof value === 'string') {
    return value === CODEX_RESERVED_TOOL_ALIAS
      ? { changed: true, value: CODEX_RESERVED_TOOL_NAME }
      : { changed: false, value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const restored = restoreValue(item);
      changed = changed || restored.changed;
      return restored.value;
    });
    return changed ? { changed: true, value: items } : { changed: false, value };
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const restored = restoreValue(value[key]);
      changed = changed || restored.changed;
      next[key] = restored.value;
    }
    return changed ? { changed: true, value: next } : { changed: false, value };
  }
  return { changed: false, value };
}

/**
 * Restores the reserved tool alias (`python__mr` → `python`) anywhere it
 * appears as an exact string value inside an arbitrary JSON document —
 * response bodies and individual SSE frames. Copy-on-write: untouched
 * subtrees are returned by reference, so frames without the alias cost one
 * walk and no allocation. The input value is never mutated.
 */
export function restoreReservedToolNames(value: unknown): unknown {
  return restoreValue(value).value;
}

function normalizeCallId(callId: string): string {
  const prefixed = callId.startsWith('fc_') ? callId : `fc_${callId}`;
  return prefixed.length > 64 ? prefixed.slice(0, 64) : prefixed;
}

function normalizeInputItemCallIds(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const callId = item.call_id;
  if (typeof callId !== 'string') return item;
  return { ...item, call_id: normalizeCallId(callId) };
}

function normalizeContentCallIds(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => normalizeInputItemCallIds(part));
}

function extractMessageText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function ensureReasoningInclude(result: Record<string, unknown>, body: Record<string, unknown>): void {
  if (!('reasoning' in body)) return;
  const existing = Array.isArray(result.include) ? result.include : [];
  const kept = existing.filter((entry): entry is string => typeof entry === 'string');
  if (!kept.includes(REASONING_ENCRYPTED_INCLUDE)) kept.push(REASONING_ENCRYPTED_INCLUDE);
  result.include = kept;
}

function convertLegacyFunctions(body: Record<string, unknown>, result: Record<string, unknown>): void {
  if (!Array.isArray(body.functions)) return;
  const converted = body.functions
    .filter((fn) => isRecord(fn) && typeof fn.name === 'string')
    .map((fn) => {
      const record = fn as Record<string, unknown>;
      const tool: Record<string, unknown> = { type: 'function', name: record.name };
      if (record.description !== undefined) tool.description = record.description;
      if (record.parameters !== undefined) tool.parameters = record.parameters;
      if (record.strict !== undefined) tool.strict = record.strict;
      return tool;
    });
  const existing = Array.isArray(result.tools) ? result.tools : [];
  result.tools = [...existing, ...converted];
}

function convertLegacyFunctionCall(body: Record<string, unknown>, result: Record<string, unknown>): void {
  const legacy = body.function_call;
  if (legacy === undefined || legacy === null) return;
  if (result.tool_choice !== undefined) return;
  if (typeof legacy === 'string') {
    result.tool_choice = legacy;
    return;
  }
  if (isRecord(legacy) && typeof legacy.name === 'string') {
    result.tool_choice = { type: 'function', name: legacy.name };
  }
}

function promoteSystemMessages(result: Record<string, unknown>): void {
  const input = result.input;
  if (!Array.isArray(input)) return;
  const kept: unknown[] = [];
  const systemTexts: string[] = [];
  for (const item of input) {
    if (isRecord(item) && item.role === 'system') {
      const text = extractMessageText(item);
      if (text !== null) systemTexts.push(text);
      continue;
    }
    kept.push(normalizeInputItemCallIds(item));
  }
  if (systemTexts.length === 0) {
    result.input = kept;
    return;
  }
  const existing = typeof result.instructions === 'string' ? result.instructions : null;
  const systemBlock = systemTexts.join('\n\n');
  result.instructions = existing === null || existing.length === 0 ? systemBlock : `${systemBlock}\n\n${existing}`;
  result.input = kept;
}

function convertStringInput(result: Record<string, unknown>): void {
  if (typeof result.input === 'string') {
    result.input = [{ role: 'user', content: result.input }];
  }
}

function normalizeContentArrays(result: Record<string, unknown>): void {
  if (!Array.isArray(result.input)) return;
  result.input = result.input.map((item) => {
    if (!isRecord(item)) return item;
    const content = normalizeContentCallIds(item.content);
    return content === item.content ? item : { ...item, content };
  });
}

/**
 * Transforms an arbitrary client Responses body into one the ChatGPT codex
 * backend accepts. The input is never mutated; the output is a fresh object.
 * Non-object input throws `CodexTransformError` so the caller can fail
 * closed. Rules are applied in the order documented on the module.
 */
export function applyCodexOAuthTransform(body: unknown): unknown {
  if (!isRecord(body)) throw new CodexTransformError('MALFORMED_BODY');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (CODEX_REQUEST_FIELD_WHITELIST.has(key)) result[key] = body[key];
  }
  result.store = false;
  result.stream = true;
  if (typeof result.model === 'string') {
    result.model = normalizeCodexModel(result.model);
  }
  ensureReasoningInclude(result, body);
  convertLegacyFunctions(body, result);
  convertLegacyFunctionCall(body, result);
  convertStringInput(result);
  promoteSystemMessages(result);
  normalizeContentArrays(result);
  return aliasReservedToolNames(result);
}
