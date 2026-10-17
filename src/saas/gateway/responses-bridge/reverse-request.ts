/**
 * apicompat PhaseA port (roadmap 1.4): Responses → Chat Completions request
 * conversion, lifted from sub2api
 * `backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go`
 * (`ResponsesToChatCompletionsRequest` and its helpers). Pure JSON-in/JSON-out,
 * no I/O, no state; the only dependency is node:crypto for the namespace
 * flatten hash.
 *
 * Drop policy (fields with no Chat Completions equivalent are intentionally
 * discarded, mirroring the Go source):
 * - `previous_response_id`, `store`, `include`, `prompt_cache_key`,
 *   `prompt_cache_options`, `metadata` and `text.verbosity` — no chat equivalent.
 * - `reasoning.summary` — only `reasoning.effort` maps (`reasoning_effort`).
 * - reasoning items: plaintext `summary` text is replayed as
 *   `reasoning_content` on the owning assistant message (double-buffered,
 *   see buildChatMessagesFromItems); encrypted-only items carry no plaintext
 *   and are dropped unless an options.reasoningContentById hook restores them.
 * - Responses item types with no chat equivalent (web_search_call,
 *   local_shell_call, file_search_call, …) are skipped so they never break
 *   tool_call ↔ tool reply adjacency.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface NamespacedToolName {
  readonly namespace: string;
  readonly name: string;
}

/** Optional hooks for {@link responsesToChatCompletionsRequest}. */
export interface ResponsesToChatOptions {
  /**
   * Looks up gateway-cached reasoning text for a reasoning item id. Codex
   * histories may carry reasoning items with no plaintext summary (empty
   * summary + opaque encrypted_content, e.g. after remote compaction);
   * DeepSeek-style thinking upstreams reject such histories with 400
   * "The `reasoning_content` in the thinking mode must be passed back to the
   * API". Return '' on a miss.
   */
  readonly reasoningContentById?: (itemId: string) => string;
}

/** Tool-identity mapping recorded at request time for the response direction. */
export interface ResponsesToChatToolMapping {
  readonly customTools: ReadonlySet<string>;
  readonly functionTools: ReadonlySet<string>;
  readonly toolSearch: boolean;
  readonly namespaceTools: ReadonlyMap<string, NamespacedToolName>;
  readonly model: string;
}

export interface ResponsesToChatResult {
  readonly body: Record<string, unknown>;
  readonly mapping: ResponsesToChatToolMapping;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when the value parses as JSON (Go json.Valid analogue). */
function isValidJson(value: string): boolean {
  if (value.length === 0) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** Canonical JSON with sorted object keys, for stable identity comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// internal chat message drafts
// ---------------------------------------------------------------------------

interface ChatToolCallDraft {
  readonly id: string;
  readonly type: 'function';
  readonly function: { name: string; arguments: string };
}

interface ChatMessageDraft {
  role: string;
  content?: unknown;
  reasoningContent?: string;
  toolCalls?: ChatToolCallDraft[];
  toolCallId?: string;
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        texts.push(part.text);
      }
    }
    return texts.join('\n\n');
  }
  return '';
}

function isBlankChatContent(content: unknown): boolean {
  if (content === undefined || content === null) return true;
  if (typeof content === 'string') return content === '' || content.trim() === '';
  if (Array.isArray(content)) return messageContentText(content) === '';
  return false;
}

// ---------------------------------------------------------------------------
// namespace tool flattening
// ---------------------------------------------------------------------------

const CHAT_TOOL_NAME_MAX_LEN = 64;

/** Flattens `namespace__name`; appends a sha256 short hash when over the limit. */
export function flattenNamespaceToolName(namespace: string, name: string): string {
  const full = `${namespace}__${name}`;
  if (full.length <= CHAT_TOOL_NAME_MAX_LEN) return full;
  const digest = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 8);
  const suffix = `__${digest}`;
  const prefixLen = CHAT_TOOL_NAME_MAX_LEN - suffix.length;
  let prefix = '';
  for (const ch of full) {
    if (prefix.length + ch.length > prefixLen) break;
    prefix += ch;
  }
  return prefix + suffix;
}

// ---------------------------------------------------------------------------
// tools: effective set, downgrade, identity maps
// ---------------------------------------------------------------------------

/** custom/freeform 工具降级为 function 工具时的参数 schema。 */
const CUSTOM_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: { input: { type: 'string', description: 'The raw input for this tool, passed through verbatim.' } },
  required: ['input'],
} as const;

/** tool_search 服务端工具降级后的 function 代理工具名。 */
const TOOL_SEARCH_PROXY_NAME = 'tool_search';

const TOOL_SEARCH_PROXY_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query for tools or connectors to load.' },
    limit: { type: 'integer', description: 'Maximum number of tool groups to return.' },
  },
  required: ['query'],
} as const;

interface ResponsesToolRecord {
  readonly type: string;
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly strict?: boolean;
  readonly tools?: readonly unknown[];
  readonly children?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** Normalizes one wire tool entry; string shorthand "name" becomes a custom tool. */
function normalizeToolEntry(entry: unknown): ResponsesToolRecord | null {
  if (typeof entry === 'string') return { type: 'custom', name: entry };
  if (!isRecord(entry)) return null;
  const type = trimText(entry.type);
  const name = text(entry.name);
  return { ...entry, type, name } as ResponsesToolRecord;
}

/**
 * Collects every client-executable tool declared by a Responses request: the
 * top-level `tools` array plus `{"type":"additional_tools","tools":[…]}`
 * input items (newer codex clients), then promotes tools discovered by a
 * completed tool_search_output (same dedupe/conflict rules as the Go source).
 */
export function effectiveResponsesTools(body: Record<string, unknown>): unknown[] {
  const tools: unknown[] = [];
  if (Array.isArray(body.tools)) tools.push(...body.tools);
  const input = body.input;
  if (!Array.isArray(input)) return tools;

  for (const item of input) {
    if (!isRecord(item) || trimText(item.type) !== 'additional_tools') continue;
    if (Array.isArray(item.tools)) tools.push(...item.tools);
  }

  const promoted = promotedResponsesToolSearchDiscoveries(tools, input);
  tools.push(...promoted);
  return tools;
}

// --- tool_search discovery promotion (responses_tool_search_discoveries.go) ---

interface DiscoveredToolIdentity {
  readonly type: string;
  readonly name: string;
  readonly namespace: string;
  readonly encoded: string;
  ambiguous: boolean;
}

interface NamespaceToolCandidate {
  readonly flat: string;
  readonly child: Record<string, unknown>;
  readonly identity: DiscoveredToolIdentity;
}

function sameDiscoveredTool(left: DiscoveredToolIdentity, right: DiscoveredToolIdentity): boolean {
  return (
    left.type === right.type &&
    left.name === right.name &&
    left.namespace === right.namespace &&
    left.encoded === right.encoded
  );
}

function registerExistingIdentity(
  known: Map<string, DiscoveredToolIdentity>,
  key: string,
  identity: DiscoveredToolIdentity,
): void {
  const previous = known.get(key);
  if (previous === undefined) {
    known.set(key, identity);
    return;
  }
  if (!sameDiscoveredTool(previous, identity)) {
    previous.ambiguous = true;
    known.set(key, previous);
  }
}

function admitDiscoveredTool(
  known: Map<string, DiscoveredToolIdentity>,
  key: string,
  identity: DiscoveredToolIdentity,
): boolean {
  const previous = known.get(key);
  if (previous === undefined) {
    known.set(key, identity);
    return true;
  }
  if (!previous.ambiguous && sameDiscoveredTool(previous, identity)) return false;
  throw new Error(
    `discovered tool ${JSON.stringify(key)} conflicts with an existing declaration; this upstream cannot safely disambiguate different names, namespaces, or schemas`,
  );
}

function copyTool(tool: Record<string, unknown>): Record<string, unknown> {
  return { ...tool };
}

function directToolDiscovery(
  tool: Record<string, unknown>,
  type: string,
): { copy: Record<string, unknown>; identity: DiscoveredToolIdentity } | null {
  const name = trimText(tool.name);
  if (name === '') return null;
  const copy = copyTool(tool);
  copy.type = type;
  copy.name = name;
  let identityCopy = copy;
  if (type === 'custom') {
    identityCopy = copyTool(copy);
    identityCopy.type = 'function';
    identityCopy.parameters = CUSTOM_TOOL_INPUT_SCHEMA;
    delete identityCopy.format;
  }
  return {
    copy,
    identity: { type, name, namespace: '', encoded: stableStringify(identityCopy), ambiguous: false },
  };
}

function namespaceChildrenOf(tool: Record<string, unknown>): unknown[] {
  if (Array.isArray(tool.tools) && tool.tools.length > 0) return tool.tools;
  return Array.isArray(tool.children) ? tool.children : [];
}

function namespaceToolDiscovery(
  tool: Record<string, unknown>,
): { copy: Record<string, unknown>; identities: NamespaceToolCandidate[] } | null {
  const namespace = trimText(tool.name);
  const children = namespaceChildrenOf(tool);
  if (namespace === '' || children.length === 0) return null;
  const copy = copyTool(tool);
  copy.type = 'namespace';
  copy.name = namespace;
  const identities: NamespaceToolCandidate[] = [];
  for (const rawChild of children) {
    if (!isRecord(rawChild) || trimText(rawChild.type) !== 'function') continue;
    const direct = directToolDiscovery(rawChild, 'function');
    if (direct === null) continue;
    identities.push({
      flat: flattenNamespaceToolName(namespace, direct.identity.name),
      child: direct.copy,
      identity: {
        type: 'namespace',
        name: direct.identity.name,
        namespace,
        encoded: direct.identity.encoded,
        ambiguous: false,
      },
    });
  }
  if (identities.length === 0) return null;
  return { copy, identities };
}

function registerExistingToolIdentity(known: Map<string, DiscoveredToolIdentity>, raw: unknown): void {
  if (!isRecord(raw)) return;
  const type = trimText(raw.type);
  if (type === 'function' || type === 'custom') {
    const direct = directToolDiscovery(raw, type);
    if (direct !== null) registerExistingIdentity(known, direct.identity.name, direct.identity);
    return;
  }
  if (type === 'namespace') {
    const discovered = namespaceToolDiscovery(raw);
    if (discovered === null) return;
    for (const candidate of discovered.identities) {
      registerExistingIdentity(known, candidate.flat, candidate.identity);
    }
  }
}

function hasToolSearchDeclaration(tools: readonly unknown[]): boolean {
  return tools.some((raw) => isRecord(raw) && trimText(raw.type) === 'tool_search');
}

function usableToolSearchOutput(item: Record<string, unknown>): boolean {
  const status = item.status;
  if (status === undefined) return true;
  return typeof status === 'string' && status.trim() === 'completed';
}

/**
 * Promotes successfully discovered client tools from tool_search_output items
 * so they stay callable on function-only upstreams. Declarations are appended
 * after static tools so the client's declaration order stays stable.
 */
function promotedResponsesToolSearchDiscoveries(tools: readonly unknown[], input: readonly unknown[]): unknown[] {
  if (tools.length === 0 || !hasToolSearchDeclaration(tools) || input.length === 0) return [];

  const known = new Map<string, DiscoveredToolIdentity>();
  for (const raw of tools) registerExistingToolIdentity(known, raw);

  const promoted: unknown[] = [];
  for (const rawItem of input) {
    if (!isRecord(rawItem) || trimText(rawItem.type) !== 'tool_search_output' || !usableToolSearchOutput(rawItem)) {
      continue;
    }
    const discoveries = rawItem.tools;
    if (!Array.isArray(discoveries) || discoveries.length === 0) continue;
    for (const rawDiscovery of discoveries) {
      if (!isRecord(rawDiscovery)) continue;
      const type = trimText(rawDiscovery.type);
      if (type === 'function' || type === 'custom') {
        const direct = directToolDiscovery(rawDiscovery, type);
        if (direct === null) continue;
        if (admitDiscoveredTool(known, direct.identity.name, direct.identity)) promoted.push(direct.copy);
        continue;
      }
      if (type === 'namespace') {
        const discovered = namespaceToolDiscovery(rawDiscovery);
        if (discovered === null) continue;
        const children: unknown[] = [];
        for (const candidate of discovered.identities) {
          if (admitDiscoveredTool(known, candidate.flat, candidate.identity)) children.push(candidate.child);
        }
        if (children.length > 0) {
          discovered.copy.tools = children;
          delete discovered.copy.children;
          promoted.push(discovered.copy);
        }
      }
    }
  }
  return promoted;
}

/** Names of custom/freeform tools (restored as custom_tool_call on the way back). */
export function customToolNames(tools: readonly unknown[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of tools) {
    const tool = normalizeToolEntry(raw);
    if (tool !== null && tool.type === 'custom' && tool.name !== '') out.add(tool.name);
  }
  return out;
}

/** Names of explicitly declared top-level function tools. */
export function functionToolNames(tools: readonly unknown[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of tools) {
    const tool = normalizeToolEntry(raw);
    if (tool !== null && tool.type === 'function' && tool.name !== '') out.add(tool.name);
  }
  return out;
}

/** Flattened namespace child tool name → original (namespace, bare name). */
export function namespaceToolNames(tools: readonly unknown[]): ReadonlyMap<string, NamespacedToolName> {
  const out = new Map<string, NamespacedToolName>();
  for (const raw of tools) {
    const tool = normalizeToolEntry(raw);
    if (tool === null || tool.type !== 'namespace' || tool.name === '') continue;
    const children = tool.tools !== undefined && tool.tools.length > 0 ? tool.tools : (tool.children ?? []);
    for (const rawChild of children) {
      const child = normalizeToolEntry(rawChild);
      if (child === null || child.type !== 'function' || child.name === '') continue;
      out.set(flattenNamespaceToolName(tool.name, child.name), { namespace: tool.name, name: child.name });
    }
  }
  return out;
}

/** Whether the request declares a tool_search server tool. */
export function hasToolSearchTool(tools: readonly unknown[]): boolean {
  return tools.some((raw) => {
    const tool = normalizeToolEntry(raw);
    return tool !== null && tool.type === 'tool_search';
  });
}

// ---------------------------------------------------------------------------
// tools → chat tools
// ---------------------------------------------------------------------------

function toolSearchProxyChatTool(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: TOOL_SEARCH_PROXY_NAME,
      description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
      parameters: TOOL_SEARCH_PROXY_SCHEMA,
    },
  };
}

/**
 * Lowers Responses tools to Chat Completions tools. function tools pass
 * through; custom/freeform tools degrade to a single `input` string function;
 * tool_search degrades to a same-named function proxy; namespace children are
 * flattened with a `<namespace>__` prefix (hash-suffixed when over 64 chars);
 * server-side tools with no chat capability (web_search, image_generation, …)
 * are dropped. Ambiguous flatten collisions are rejected explicitly.
 */
export function responsesToolsToChatTools(tools: readonly unknown[]): Record<string, unknown>[] {
  const normalized = tools.map(normalizeToolEntry).filter((t): t is ResponsesToolRecord => t !== null);

  const topLevel = new Set<string>();
  for (const tool of normalized) {
    if ((tool.type === 'function' || tool.type === 'custom') && tool.name !== '') {
      if (topLevel.has(tool.name)) {
        throw new Error(
          `duplicate top-level executable tool name ${JSON.stringify(tool.name)}; this upstream cannot disambiguate duplicate names, rename one of the tools`,
        );
      }
      topLevel.add(tool.name);
    }
  }

  const flatOwner = new Map<string, NamespacedToolName>();
  let toolSearchDeclared = false;
  const out: Record<string, unknown>[] = [];
  for (const tool of normalized) {
    switch (tool.type) {
      case 'function': {
        const fn: Record<string, unknown> = { name: tool.name };
        if (tool.description !== undefined && tool.description !== '') fn.description = tool.description;
        if (tool.parameters !== undefined) fn.parameters = tool.parameters;
        if (tool.strict !== undefined) fn.strict = tool.strict;
        out.push({ type: 'function', function: fn });
        break;
      }
      case 'custom': {
        const fn: Record<string, unknown> = { name: tool.name };
        if (tool.description !== undefined && tool.description !== '') fn.description = tool.description;
        fn.parameters = CUSTOM_TOOL_INPUT_SCHEMA;
        out.push({ type: 'function', function: fn });
        break;
      }
      case 'tool_search': {
        if (topLevel.has(TOOL_SEARCH_PROXY_NAME)) {
          throw new Error(
            `built-in tool_search conflicts with a declared tool named ${JSON.stringify(TOOL_SEARCH_PROXY_NAME)}; this upstream cannot disambiguate them, rename the tool`,
          );
        }
        if (toolSearchDeclared) break;
        toolSearchDeclared = true;
        out.push(toolSearchProxyChatTool());
        break;
      }
      case 'namespace': {
        out.push(...namespaceChildrenToChatTools(tool, topLevel, flatOwner));
        break;
      }
      case 'x_search': {
        const xSearch: Record<string, unknown> = { type: 'x_search' };
        for (const key of [
          'allowed_x_handles',
          'excluded_x_handles',
          'from_date',
          'to_date',
          'enable_image_understanding',
          'enable_video_understanding',
        ]) {
          if (tool[key] !== undefined) xSearch[key] = tool[key];
        }
        out.push(xSearch);
        break;
      }
      default:
        // web_search、image_generation 等服务端工具：chat 上游没有对应能力，丢弃。
        break;
    }
  }
  return out;
}

function namespaceChildrenToChatTools(
  tool: ResponsesToolRecord,
  topLevel: ReadonlySet<string>,
  flatOwner: Map<string, NamespacedToolName>,
): Record<string, unknown>[] {
  if (tool.name === '') return [];
  const children = tool.tools !== undefined && tool.tools.length > 0 ? tool.tools : (tool.children ?? []);
  const out: Record<string, unknown>[] = [];
  for (const rawChild of children) {
    const child = normalizeToolEntry(rawChild);
    if (child === null || child.type !== 'function' || child.name === '') continue;
    const flat = flattenNamespaceToolName(tool.name, child.name);
    const entry = { namespace: tool.name, name: child.name };
    if (topLevel.has(flat)) {
      throw new Error(
        `namespace tool ${JSON.stringify(tool.name)}/${JSON.stringify(child.name)} flattens to ${JSON.stringify(flat)} which conflicts with a top-level tool of the same name; this upstream cannot disambiguate them, rename one of the tools`,
      );
    }
    const prev = flatOwner.get(flat);
    if (prev !== undefined) {
      if (prev.namespace === entry.namespace && prev.name === entry.name) continue;
      throw new Error(
        `namespace tools ${JSON.stringify(prev.namespace)}/${JSON.stringify(prev.name)} and ${JSON.stringify(tool.name)}/${JSON.stringify(child.name)} both flatten to ${JSON.stringify(flat)}; this upstream cannot disambiguate them, rename one of the tools`,
      );
    }
    flatOwner.set(flat, entry);
    const fn: Record<string, unknown> = { name: flat };
    if (child.description !== undefined && child.description !== '') fn.description = child.description;
    if (child.parameters !== undefined) fn.parameters = child.parameters;
    if (child.strict !== undefined) fn.strict = child.strict;
    out.push({ type: 'function', function: fn });
  }
  return out;
}

// ---------------------------------------------------------------------------
// tool_choice
// ---------------------------------------------------------------------------

/**
 * Converts Responses tool_choice to chat form against the actually-declared
 * chat tool names. Named choices survive only when their tool survived;
 * server-tool choices are dropped with the tool. Returns undefined to drop.
 */
function responsesToolChoiceToChatToolChoice(raw: unknown, declared: ReadonlySet<string>): unknown {
  if (!isRecord(raw)) {
    // "auto"/"none"/"required" 等字符串形式原样转发。
    return raw;
  }
  const choiceType = trimText(raw.type);
  let name = '';
  switch (choiceType) {
    case 'x_search': {
      if (!declared.has('x_search')) return undefined;
      return { type: 'x_search' };
    }
    case 'tool_search':
      // tool_search 降级为同名 function 代理，强制选择同样降级。
      name = TOOL_SEARCH_PROXY_NAME;
      break;
    case 'function':
    case 'custom':
      name = trimText(raw.name);
      if (name === '' && isRecord(raw.function)) name = trimText(raw.function.name);
      if (name === '') return raw;
      break;
    default:
      return undefined;
  }
  if (!declared.has(name)) return undefined;
  return { type: 'function', function: { name } };
}

// ---------------------------------------------------------------------------
// text.format → response_format
// ---------------------------------------------------------------------------

function responsesTextFormatToChatResponseFormat(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (trimText(raw.type) !== 'json_schema') return raw;
  if (raw.json_schema !== undefined) return raw;
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'type') continue;
    schema[key] = value;
  }
  if (Object.keys(schema).length === 0) return raw;
  return { type: 'json_schema', json_schema: schema };
}

// ---------------------------------------------------------------------------
// reasoning extraction
// ---------------------------------------------------------------------------

function collectReasoningParts(raw: unknown, parts: string[]): void {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isRecord(entry)) {
        const t = text(entry.text);
        if (t !== '') parts.push(t);
      }
    }
    return;
  }
  if (typeof raw === 'string' && raw !== '') parts.push(raw);
}

function extractResponsesReasoningText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  collectReasoningParts(item.summary, parts);
  if (parts.length === 0) collectReasoningParts(item.content, parts);
  return parts.join('\n');
}

/**
 * Parses a raw Responses input item and, for reasoning items, returns its id
 * and extractable plaintext (summary preferred, content fallback). Exists for
 * the gateway-side reasoning cache.
 */
export function extractResponsesReasoningItem(raw: unknown): { id: string; text: string } | null {
  if (!isRecord(raw) || trimText(raw.type) !== 'reasoning') return null;
  return { id: text(raw.id), text: extractResponsesReasoningText(raw) };
}

// ---------------------------------------------------------------------------
// tool output media rewrite
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_MEDIA_MARKER = '[Tool output media moved to the following user message]';
const TOOL_OUTPUT_MEDIA_ATTRIBUTION = '[Tool output media for call %s]';

type ChatContentPart = Record<string, unknown>;

function toolOutputImagePart(imageUrl: string): ChatContentPart {
  return { type: 'image_url', image_url: { url: imageUrl } };
}

function isToolOutputImageDataURL(value: string): boolean {
  const prefix = 'data:image/';
  const separator = ';base64,';
  if (!value.startsWith(prefix)) return false;
  const separatorIndex = value.indexOf(separator, prefix.length);
  if (separatorIndex <= prefix.length) return false;
  return separatorIndex + separator.length < value.length;
}

function recognizedToolOutputImageURL(value: Record<string, unknown>): string | null {
  const partType = text(value.type);
  if (partType !== 'input_image' && partType !== 'image_url') return null;
  const imageUrl = value.image_url;
  if (typeof imageUrl === 'string') return imageUrl.trim() === '' ? null : imageUrl;
  if (isRecord(imageUrl)) {
    const url = text(imageUrl.url);
    return url.trim() === '' ? null : url;
  }
  return null;
}

function rewriteToolOutputMediaValue(value: unknown): { value: unknown; media: ChatContentPart[]; changed: boolean } {
  if (Array.isArray(value)) {
    const media: ChatContentPart[] = [];
    let changed = false;
    const copy = value.map((item) => {
      const result = rewriteToolOutputMediaValue(item);
      if (!result.changed) return item;
      changed = true;
      media.push(...result.media);
      return result.value;
    });
    return { value: changed ? copy : value, media, changed };
  }
  if (isRecord(value)) {
    const imageUrl = recognizedToolOutputImageURL(value);
    if (imageUrl !== null) {
      return {
        value: { type: 'input_text', text: TOOL_OUTPUT_MEDIA_MARKER },
        media: [toolOutputImagePart(imageUrl)],
        changed: true,
      };
    }
    if (!('content' in value)) return { value, media: [], changed: false };
    const result = rewriteToolOutputMediaValue(value.content);
    if (!result.changed) return { value, media: [], changed: false };
    return { value: { ...value, content: result.value }, media: result.media, changed: true };
  }
  return { value, media: [], changed: false };
}

/**
 * Rewrites recognized image nodes out of a tool output value. Media-free
 * outputs return changed=false so the caller can preserve their original
 * value and prompt-cache prefix.
 */
function extractToolOutputMedia(output: unknown): { text: string; media: ChatContentPart[]; changed: boolean } {
  if (typeof output === 'string') {
    if (isToolOutputImageDataURL(output)) {
      return { text: TOOL_OUTPUT_MEDIA_MARKER, media: [toolOutputImagePart(output)], changed: true };
    }
    let nested: unknown;
    try {
      nested = JSON.parse(output);
    } catch {
      return { text: '', media: [], changed: false };
    }
    const result = rewriteToolOutputMediaValue(nested);
    if (!result.changed) return { text: '', media: [], changed: false };
    return { text: JSON.stringify(result.value), media: result.media, changed: true };
  }
  if (output === undefined || output === null) return { text: '', media: [], changed: false };
  const result = rewriteToolOutputMediaValue(output);
  if (!result.changed) return { text: '', media: [], changed: false };
  return { text: JSON.stringify(result.value), media: result.media, changed: true };
}

// ---------------------------------------------------------------------------
// input items → chat messages
// ---------------------------------------------------------------------------

function chatCompletionsBridgeRole(role: string): string {
  const trimmed = role.trim();
  if (trimmed === '') return 'user';
  if (trimmed.toLowerCase() === 'developer') return 'system';
  return role;
}

function chatContentFromSingleResponsesPart(partType: string, part: Record<string, unknown>): unknown {
  if (partType === 'input_image' || partType === 'image_url') {
    let imageUrl = text(part.image_url);
    if (imageUrl === '' && isRecord(part.image_url)) imageUrl = text(part.image_url.url);
    return [{ type: 'image_url', image_url: { url: imageUrl } }];
  }
  return text(part.text);
}

function responsesContentPartsToChatContent(parts: readonly unknown[], role: string): unknown {
  const textParts: string[] = [];
  const chatParts: ChatContentPart[] = [];
  let hasNonText = false;

  for (const rawPart of parts) {
    if (!isRecord(rawPart)) continue;
    const partType = text(rawPart.type);
    switch (partType) {
      case 'input_text':
      case 'output_text':
      case 'text':
      case '': {
        const t = text(rawPart.text);
        if (t === '') continue;
        textParts.push(t);
        chatParts.push({ type: 'text', text: t });
        break;
      }
      case 'input_image':
      case 'image_url': {
        let imageUrl = text(rawPart.image_url);
        if (imageUrl === '' && isRecord(rawPart.image_url)) imageUrl = text(rawPart.image_url.url);
        if (imageUrl === '') continue;
        hasNonText = true;
        chatParts.push({ type: 'image_url', image_url: { url: imageUrl } });
        break;
      }
      default:
        break;
    }
  }

  if (!hasNonText) return textParts.join('\n\n');
  if (role !== 'user') return textParts.join('\n\n');
  if (chatParts.length === 0) return '';
  return chatParts;
}

function responsesContentToChatContent(content: unknown, role: string): unknown {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return responsesContentPartsToChatContent(content, role);
  if (isRecord(content)) return chatContentFromSingleResponsesPart(text(content.type), content);
  return content;
}

function agentMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (!isRecord(part)) continue;
    switch (text(part.type)) {
      case 'input_text':
      case 'text':
        out += text(part.text);
        break;
      case 'encrypted_content':
        out += text(part.encrypted_content);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Merges a tool call into the chat message list (parallel calls share one assistant message). */
function appendAssistantToolCall(
  messages: ChatMessageDraft[],
  toolCall: ChatToolCallDraft,
  pendingReasoning: string,
): ChatMessageDraft[] {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === 'assistant') {
    last.toolCalls = [...(last.toolCalls ?? []), toolCall];
    if (!last.reasoningContent) last.reasoningContent = pendingReasoning;
    return messages;
  }
  messages.push({
    role: 'assistant',
    toolCalls: [toolCall],
    ...(pendingReasoning === '' ? {} : { reasoningContent: pendingReasoning }),
  });
  return messages;
}

function toolSearchCallArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  const encoded = JSON.stringify(value);
  return encoded === 'null' ? '{}' : encoded;
}

interface BuildResult {
  readonly messages: ChatMessageDraft[];
  readonly mediaByCallId: Map<string, ChatContentPart[]>;
}

function buildChatMessagesFromItems(
  messages: ChatMessageDraft[],
  items: readonly unknown[],
  options: ResponsesToChatOptions | undefined,
): BuildResult {
  // pendingReasoning holds the reasoning text from a reasoning item until the
  // assistant message it belongs to is emitted (DeepSeek thinking mode
  // requires the reasoning_content that produced a tool call to be passed
  // back on that assistant message). lastTurnReasoning survives tool outputs:
  // chained tool calls (reasoning → call A → output A → call B) replay the
  // turn's reasoning on call B's message; a user-side item ends the turn.
  let pendingReasoning = '';
  let lastTurnReasoning = '';
  const mediaByCallId = new Map<string, ChatContentPart[]>();
  const invalidFunctionCallIds = new Set<string>();
  let invalidEmptyFunctionCallOutputs = 0;

  const reasoningForAssistant = (): string => (pendingReasoning !== '' ? pendingReasoning : lastTurnReasoning);

  for (const item of items) {
    if (item === null) continue;
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      pendingReasoning = '';
      lastTurnReasoning = '';
      continue;
    }
    if (!isRecord(item)) {
      throw new Error('parse responses input item');
    }

    const role = chatCompletionsBridgeRole(text(item.role));
    const itemType = text(item.type);
    switch (itemType) {
      case 'reasoning': {
        const extracted = extractResponsesReasoningText(item);
        if (extracted !== '') {
          pendingReasoning = extracted;
        } else if (options?.reasoningContentById !== undefined) {
          // No plaintext summary (encrypted-only reasoning, e.g. after codex
          // remote compaction): fall back to the gateway-side cache keyed by
          // the reasoning item id, which always round-trips in history.
          const id = text(item.id);
          if (id !== '') {
            const cached = options.reasoningContentById(id);
            if (cached !== '') pendingReasoning = cached;
          }
        }
        if (pendingReasoning !== '') lastTurnReasoning = pendingReasoning;
        continue;
      }
      case 'function_call': {
        let argumentsText = text(item.arguments);
        if (argumentsText.trim() === '') argumentsText = '{}';
        const callId = text(item.call_id);
        if (!isValidJson(argumentsText)) {
          // A previous streamed turn can leave a truncated function_call in
          // codex history (upstream SSE parse failure, output-limit cut).
          // Skip the call and its matching output so the next user turn
          // self-heals instead of replaying the poison.
          if (callId !== '') invalidFunctionCallIds.add(callId);
          else invalidEmptyFunctionCallOutputs += 1;
          pendingReasoning = '';
          continue;
        }
        let name = text(item.name);
        const namespace = text(item.namespace);
        if (namespace !== '') name = flattenNamespaceToolName(namespace, name);
        appendAssistantToolCall(
          messages,
          { id: callId, type: 'function', function: { name, arguments: argumentsText } },
          reasoningForAssistant(),
        );
        pendingReasoning = '';
        continue;
      }
      case 'tool_search_call': {
        let argumentsText = toolSearchCallArguments(item.arguments);
        if (argumentsText === '' || argumentsText === 'null') argumentsText = '{}';
        appendAssistantToolCall(
          messages,
          {
            id: text(item.call_id),
            type: 'function',
            function: { name: TOOL_SEARCH_PROXY_NAME, arguments: argumentsText },
          },
          reasoningForAssistant(),
        );
        pendingReasoning = '';
        continue;
      }
      case 'custom_tool_call': {
        // custom/freeform 工具的历史调用：input 自由文本包进降级 function
        // 工具的 {"input": ...} 参数，与请求方向的工具降级保持一致。
        const argumentsText = JSON.stringify({ input: text(item.input) });
        appendAssistantToolCall(
          messages,
          { id: text(item.call_id), type: 'function', function: { name: text(item.name), arguments: argumentsText } },
          reasoningForAssistant(),
        );
        pendingReasoning = '';
        continue;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'tool_search_output': {
        let output = item.output;
        if (itemType === 'tool_search_output' && (output === undefined || output === null)) {
          // Newer clients return discoveries in tools[] without a separate
          // output field; keep that useful result in Chat tool history.
          output = item.tools;
        }
        const callId = text(item.call_id);
        if (callId === '' && invalidEmptyFunctionCallOutputs > 0) {
          invalidEmptyFunctionCallOutputs -= 1;
          pendingReasoning = '';
          continue;
        }
        if (invalidFunctionCallIds.has(callId)) {
          pendingReasoning = '';
          continue;
        }
        mediaByCallId.delete(callId);

        const extracted = extractToolOutputMedia(output);
        let outputText: string;
        if (extracted.changed) {
          outputText = extracted.text;
          if (callId !== '') mediaByCallId.set(callId, extracted.media);
        } else {
          outputText = text(output);
          if (outputText === '' && output !== undefined && output !== null && !(typeof output === 'string')) {
            // 对象/数组形式的输出（如 tool_search 的结果列表）整体字符串化。
            outputText = JSON.stringify(output) ?? '';
          }
        }
        messages.push({ role: 'tool', toolCallId: callId, content: outputText });
        pendingReasoning = '';
        continue;
      }
      case 'agent_message': {
        // Codex multi_agent_v2 在父线程与子智能体之间传递任务/回复；chat
        // 上游没有对应条目，按原顺序拼成一条 user 消息。
        const agentText = agentMessageText(item.content);
        if (agentText === '') {
          pendingReasoning = '';
          continue;
        }
        messages.push({ role: 'user', content: agentText });
        pendingReasoning = '';
        lastTurnReasoning = '';
        continue;
      }
      case 'input_text':
      case 'text': {
        messages.push({ role: 'user', content: text(item.text) });
        pendingReasoning = '';
        lastTurnReasoning = '';
        continue;
      }
      case 'input_image': {
        messages.push({ role: 'user', content: chatContentFromSingleResponsesPart(itemType, item) });
        pendingReasoning = '';
        lastTurnReasoning = '';
        continue;
      }
      default:
        break;
    }

    // Only genuine message items become chat messages. Codex emits other
    // Responses item types with no Chat equivalent (web_search_call,
    // local_shell_call, file_search_call, …); inserting a spurious message
    // between an assistant tool_calls message and its tool reply breaks
    // strict upstreams. Skip them.
    if (itemType !== '' && itemType !== 'message') {
      pendingReasoning = '';
      continue;
    }

    let content = item.content;
    if (content === undefined || content === null) {
      const fallback = text(item.text);
      if (fallback !== '') content = fallback;
    }
    const chatContent = responsesContentToChatContent(content, role);
    const message: ChatMessageDraft = { role, content: chatContent };
    if (role === 'assistant') {
      message.reasoningContent = reasoningForAssistant();
      pendingReasoning = '';
    } else {
      pendingReasoning = '';
      lastTurnReasoning = '';
    }
    messages.push(message);
  }

  return { messages, mediaByCallId };
}

/**
 * Enforces the Chat Completions tool-call invariant: an assistant message
 * with tool_calls must be immediately followed by one tool message per
 * tool_call_id, in order. Unanswered tool_calls are dropped, orphan tool
 * replies are dropped, intervening messages keep their natural position
 * (never between an assistant tool_calls message and its replies).
 */
export function normalizeChatMessages(
  messages: ChatMessageDraft[],
  mediaByCallId?: Map<string, ChatContentPart[]>,
): ChatMessageDraft[] {
  const media = mediaByCallId ?? new Map<string, ChatContentPart[]>();
  // Index every tool reply by its tool_call_id (last wins on duplicates).
  const replies = new Map<string, ChatMessageDraft>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId !== undefined && message.toolCallId !== '') {
      replies.set(message.toolCallId, message);
    }
  }

  const out: ChatMessageDraft[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      // A bare tool message with no tool_call_id is a direct Chat
      // Completions passthrough; keep it in place. Replies announced by an
      // assistant are re-emitted right after that assistant; orphans drop.
      if (message.toolCallId === undefined || message.toolCallId === '') out.push(message);
      continue;
    }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const kept = message.toolCalls.filter((tc) => tc.id !== '' && replies.has(tc.id));
      if (kept.length === 0) {
        if (isBlankChatContent(message.content)) continue;
        const plain: ChatMessageDraft = { ...message };
        delete plain.toolCalls;
        out.push(plain);
        continue;
      }
      out.push({ ...message, toolCalls: kept });
      for (const tc of kept) {
        const reply = replies.get(tc.id);
        if (reply !== undefined) out.push(reply);
      }

      const mediaParts: ChatContentPart[] = [];
      for (const tc of kept) {
        const parts = media.get(tc.id);
        if (parts === undefined || parts.length === 0) continue;
        mediaParts.push({ type: 'text', text: TOOL_OUTPUT_MEDIA_ATTRIBUTION.replace('%s', tc.id) });
        mediaParts.push(...parts);
      }
      if (mediaParts.length > 0) out.push({ role: 'user', content: mediaParts });
      continue;
    }
    out.push(message);
  }
  return out;
}

/**
 * Rewrites the message list so strict upstreams that only accept system
 * content at the very start accept it: leading system/developer messages
 * merge into one leading system message; later ones keep their position but
 * are downgraded to user messages so the text still reaches the model.
 */
export function normalizeResponsesDerivedChatMessageRoles(messages: ChatMessageDraft[]): ChatMessageDraft[] {
  const isInstructionRole = (role: string): boolean => role === 'system' || role === 'developer';

  let leading = 0;
  while (leading < messages.length && isInstructionRole(messages[leading].role)) leading += 1;

  const out: ChatMessageDraft[] = [];
  if (leading === 1) {
    // A single leading prompt is already valid; keep it byte for byte.
    out.push(messages[0]);
  } else if (leading > 1) {
    const merged: string[] = [];
    for (const message of messages.slice(0, leading)) {
      const t = messageContentText(message.content).trim();
      if (t !== '') merged.push(t);
    }
    if (merged.length > 0) out.push({ role: 'system', content: merged.join('\n\n') });
  }

  for (const message of messages.slice(leading)) {
    if (isInstructionRole(message.role)) out.push({ ...message, role: 'user' });
    else out.push(message);
  }
  return out;
}

/** Converts Responses instructions + input into the Chat message list. */
export function responsesToChatMessages(
  instructions: string,
  input: unknown,
  options?: ResponsesToChatOptions,
): ChatMessageDraft[] {
  const messages: ChatMessageDraft[] = [];
  if (typeof instructions === 'string' && instructions.trim() !== '') {
    messages.push({ role: 'system', content: instructions });
  }

  if (input === undefined || input === null) return messages;

  // Bare string input is a single user turn.
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) throw new Error('parse responses input');

  const built = buildChatMessagesFromItems(messages, input, options);
  const normalized = normalizeChatMessages(built.messages, built.mediaByCallId);
  return normalizeResponsesDerivedChatMessageRoles(normalized);
}

function chatMessageToWire(message: ChatMessageDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role };
  if (message.content !== undefined) out.content = message.content;
  if (message.reasoningContent !== undefined && message.reasoningContent !== '')
    out.reasoning_content = message.reasoningContent;
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((tc) => {
      const fn: Record<string, unknown> = { arguments: tc.function.arguments };
      if (tc.function.name !== '') fn.name = tc.function.name;
      const call: Record<string, unknown> = { type: tc.type, function: fn };
      if (tc.id !== '') call.id = tc.id;
      return call;
    });
  }
  if (message.toolCallId !== undefined && message.toolCallId !== '') out.tool_call_id = message.toolCallId;
  return out;
}

// ---------------------------------------------------------------------------
// top-level request conversion
// ---------------------------------------------------------------------------

/**
 * Converts a Responses API request body into a Chat Completions request body
 * plus the tool-identity mapping the response direction needs to restore
 * custom/tool_search/namespace tool calls. Throws on structurally ambiguous
 * requests (duplicate/flatten-conflicting tool names).
 */
export function responsesToChatCompletionsRequest(
  body: unknown,
  options?: ResponsesToChatOptions,
): ResponsesToChatResult {
  if (!isRecord(body)) throw new Error('responses request is nil');

  const model = text(body.model);
  const messages = responsesToChatMessages(text(body.instructions), body.input, options);

  const out: Record<string, unknown> = { model, messages: messages.map(chatMessageToWire) };
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null)
    out.max_completion_tokens = body.max_output_tokens;
  if (body.temperature !== undefined && body.temperature !== null) out.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) out.top_p = body.top_p;
  if (body.stream !== undefined && body.stream !== null) out.stream = body.stream;
  if (body.service_tier !== undefined && body.service_tier !== null && body.service_tier !== '')
    out.service_tier = body.service_tier;
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
    out.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (isRecord(body.reasoning)) {
    const effort = text(body.reasoning.effort);
    if (effort !== '') out.reasoning_effort = effort;
  }
  if (body.stream === true) {
    // Streaming clients need usage on the terminal chunk for billing; the
    // proxy may still strip this for providers that reject stream_options.
    out.stream_options = { ...(isRecord(out.stream_options) ? out.stream_options : {}), include_usage: true };
  }

  const effectiveTools = effectiveResponsesTools(body);
  const mapping: ResponsesToChatToolMapping = {
    customTools: customToolNames(effectiveTools),
    functionTools: functionToolNames(effectiveTools),
    toolSearch: hasToolSearchTool(effectiveTools),
    namespaceTools: namespaceToolNames(effectiveTools),
    model,
  };

  if (effectiveTools.length > 0) {
    const tools = responsesToolsToChatTools(effectiveTools);
    if (tools.length > 0) out.tools = tools;
  }
  // tools 全部被丢弃（如仅含 web_search 等服务端工具）时不再转发
  // tool_choice：上游会拒绝 "'tool_choice' is only allowed when 'tools' are
  // specified"。指向被丢弃工具的选择项同理。
  if (Array.isArray(out.tools) && out.tools.length > 0 && body.tool_choice !== undefined && body.tool_choice !== null) {
    const declared = new Set<string>();
    for (const tool of out.tools as Record<string, unknown>[]) {
      if (isRecord(tool.function) && typeof tool.function.name === 'string') declared.add(tool.function.name);
      if (typeof tool.type === 'string' && tool.type.trim().toLowerCase() === 'x_search') declared.add('x_search');
    }
    const toolChoice = responsesToolChoiceToChatToolChoice(body.tool_choice, declared);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
  }

  if (isRecord(body.text) && body.text.format !== undefined && body.text.format !== null) {
    const responseFormat = responsesTextFormatToChatResponseFormat(body.text.format);
    if (responseFormat !== undefined && responseFormat !== null) out.response_format = responseFormat;
  }

  return { body: out, mapping };
}

// ---------------------------------------------------------------------------
// id generators (crypto; mirrors the Go rand-based generators)
// ---------------------------------------------------------------------------

/** "chatcmpl-" prefixed random hex id. */
export function generateChatCmplId(): string {
  return `chatcmpl-${randomBytes(12).toString('hex')}`;
}

/** "resp_" prefixed random hex id. */
export function generateResponsesId(): string {
  return `resp_${randomBytes(12).toString('hex')}`;
}

/** "item_" prefixed random hex id. */
export function generateItemId(): string {
  return `item_${randomBytes(12).toString('hex')}`;
}
