/**
 * Batch-3 AWS Bedrock request transformation (port of sub2api's
 * backend/internal/service/bedrock_request.go onto this codebase's
 * pure JSON-in/JSON-out conventions). Pure helpers: nothing here touches
 * HTTP, streams, storage or clocks. The gateway pipeline is:
 *
 *   client Anthropic body
 *     → resolveBedrockModel (alias strip + cross-region prefix adjust)
 *     → prepareBedrockRequestBody (anthropic_version/anthropic_beta
 *       injection, unsupported-field removal, cache_control/thinking/
 *       tool_use-id fixes, output_format schema inlining)
 *     → buildBedrockInvokeUrl (`:` → `%3A` model path)
 *
 * All object edits are copy-on-write per the repo convention: the input is
 * never mutated and unchanged subtrees are shared.
 */

import {
  BEDROCK_ADVANCED_TOOL_USE_BETA_TOKEN,
  BEDROCK_ANTHROPIC_VERSION,
  BEDROCK_BETA_TOKEN_TRANSFORMS,
  BEDROCK_CC_DEFAULT_MAX_TOKENS,
  BEDROCK_CLAUDE_VERSION_PATTERN,
  BEDROCK_COMPUTER_USE_BETA_TOKEN,
  BEDROCK_CONTEXT_MANAGEMENT_BETA_TOKEN,
  BEDROCK_CROSS_REGION_PREFIXES,
  BEDROCK_DEFAULT_REGION,
  BEDROCK_DEFAULT_THINKING_BUDGET_TOKENS,
  BEDROCK_GLOBAL_REGION,
  BEDROCK_MODEL_ID_PREFIXES,
  BEDROCK_SUPPORTED_BETA_TOKENS,
  BEDROCK_TOOL_EXAMPLES_BETA_TOKEN,
  BEDROCK_TOOL_SEARCH_BETA_TOKEN,
  BEDROCK_TOOL_SEARCH_TYPES,
} from './constants.js';

export type BedrockTransformErrorCode = 'MALFORMED_BODY' | 'UNSUPPORTED_MODEL';

export class BedrockTransformError extends Error {
  constructor(readonly code: BedrockTransformErrorCode) {
    super(
      code === 'MALFORMED_BODY' ? 'bedrock request body is malformed' : 'the requested model is not a bedrock model id',
    );
    this.name = 'BedrockTransformError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Model resolution (sub2api ResolveBedrockModelID family)
// ---------------------------------------------------------------------------

/**
 * The cross-region inference prefix for one AWS region (sub2api
 * BedrockCrossRegionPrefix; AWS inference-profile docs): us-prefixed→us,
 * eu-prefixed→eu, ap-northeast-1→jp, ap-southeast-2→au, other
 * ap-prefixed→apac, ca/sa-prefixed→us, us-gov-prefixed→us-gov, default us.
 */
export function bedrockCrossRegionPrefix(region: string): string {
  if (region.startsWith('us-gov')) return 'us-gov';
  if (region.startsWith('us-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region === 'ap-northeast-1') return 'jp';
  if (region === 'ap-southeast-2') return 'au';
  if (region.startsWith('ap-')) return 'apac';
  if (region.startsWith('ca-')) return 'us';
  if (region.startsWith('sa-')) return 'us';
  return 'us';
}

/**
 * Rewrites a model id's cross-region prefix onto the account's region
 * (sub2api AdjustBedrockModelRegionPrefix): `us.anthropic...` →
 * `eu.anthropic...` for region `eu-west-1`; region `global` forces the
 * `global.` prefix; a model id without a known prefix is unchanged.
 */
export function adjustBedrockModelRegionPrefix(modelId: string, region: string): string {
  const targetPrefix = region === BEDROCK_GLOBAL_REGION ? BEDROCK_GLOBAL_REGION : bedrockCrossRegionPrefix(region);
  for (const prefix of BEDROCK_CROSS_REGION_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      if (prefix === `${targetPrefix}.`) return modelId;
      return `${targetPrefix}.${modelId.slice(prefix.length)}`;
    }
  }
  return modelId;
}

function isRegionalBedrockModelId(modelId: string): boolean {
  return BEDROCK_CROSS_REGION_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/** Whether a model id is Bedrock-native (ARN, provider namespace, or regional prefix). */
export function isLikelyBedrockModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  if (lower === '') return false;
  if (BEDROCK_MODEL_ID_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return isRegionalBedrockModelId(lower);
}

/** Strips the `bedrock/` namespaced alias prefix clients may send. */
export function normalizeBedrockModelAlias(model: string): string {
  return model.startsWith('bedrock/') ? model.slice('bedrock/'.length) : model;
}

export interface BedrockModelResolution {
  /** The Bedrock model id to place in the invoke URL. */
  readonly modelId: string;
  /** Whether the id was recognized as Bedrock-native (false ⇒ unsupported). */
  readonly ok: boolean;
}

/**
 * Resolves a client-visible model onto a Bedrock model id: alias strip,
 * Bedrock-native check, then the cross-region prefix adjust toward the
 * account region (`forceGlobal` forces the global prefix; sub2api
 * ResolveBedrockModelID — the operator's modelMap runs upstream).
 */
export function resolveBedrockModel(
  requestedModel: string,
  options: { readonly region: string; readonly forceGlobal?: boolean },
): BedrockModelResolution {
  const modelId = normalizeBedrockModelAlias(typeof requestedModel === 'string' ? requestedModel.trim() : '');
  if (modelId === '' || !isLikelyBedrockModelId(modelId)) return { modelId, ok: false };
  if (!isRegionalBedrockModelId(modelId)) return { modelId, ok: true };
  const targetRegion =
    options.forceGlobal === true
      ? BEDROCK_GLOBAL_REGION
      : options.region === ''
        ? BEDROCK_DEFAULT_REGION
        : options.region;
  return { modelId: adjustBedrockModelRegionPrefix(modelId, targetRegion), ok: true };
}

/**
 * The invoke URL (sub2api BuildBedrockURL): the model id is
 * percent-encoded per segment with `:` additionally encoded to `%3A`
 * (RFC 3986 allows `:` in a path segment, but Bedrock's front end expects
 * it encoded — the litellm `urllib.parse.quote(safe="")` alignment).
 */
export function buildBedrockInvokeUrl(input: {
  readonly region: string;
  readonly modelId: string;
  readonly stream: boolean;
  /** Injectable base for tests; production is the pinned amazonaws.com host. */
  readonly baseUrl?: string;
}): { readonly url: string; readonly path: string; readonly host: string } {
  const region = input.region === '' ? BEDROCK_DEFAULT_REGION : input.region;
  const host = input.baseUrl === undefined ? `bedrock-runtime.${region}.amazonaws.com` : new URL(input.baseUrl).host;
  const base = input.baseUrl ?? `https://${host}`;
  const path = `/model/${encodeUriPathSegment(input.modelId)}/${
    input.stream ? 'invoke-with-response-stream' : 'invoke'
  }`;
  return { url: `${base.replace(/\/+$/, '')}${path}`, path, host };
}

/** SigV4-style single-segment path encoding (`:` and `/` both encoded). */
export function encodeUriPathSegment(segment: string): string {
  let out = '';
  for (const char of segment) {
    if (/[A-Za-z0-9-._~]/.test(char)) {
      out += char;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model-gated version checks (sub2api isBedrockClaude45OrNewer family)
// ---------------------------------------------------------------------------

interface ClaudeVersion {
  readonly major: number;
  readonly minor: number;
}

function claudeVersion(modelId: string): ClaudeVersion | null {
  const match = BEDROCK_CLAUDE_VERSION_PATTERN.exec(modelId.toLowerCase());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

/** Claude 4.5+ (or any 5+ / Fable 5): supports cache_control.ttl (sub2api isBedrockClaude45OrNewer). */
export function isBedrockClaude45OrNewer(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes('claude-fable-5')) return true;
  const version = claudeVersion(lower);
  if (version === null) return false;
  return version.major > 4 || (version.major === 4 && version.minor >= 5);
}

/** Opus 4.7+ (or any 5+ Opus): thinking supports only `adaptive` (sub2api isBedrockOpus47OrNewer). */
export function isBedrockOpus47OrNewer(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (!lower.includes('opus')) return false;
  const version = claudeVersion(lower);
  if (version === null) return false;
  return version.major > 4 || (version.major === 4 && version.minor >= 7);
}

/** Fable 5: always-on adaptive thinking only (sub2api isBedrockFable5). */
export function isBedrockFable5(modelId: string): boolean {
  return modelId.toLowerCase().includes('claude-fable-5');
}

/** Opus/Sonnet 4.5+ (not Haiku): supports tool search (sub2api bedrockModelSupportsToolSearch). */
export function bedrockModelSupportsToolSearch(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes('haiku')) return false;
  const version = claudeVersion(lower);
  if (version === null) return false;
  return version.major > 4 || (version.major === 4 && version.minor >= 5);
}

// ---------------------------------------------------------------------------
// Beta tokens (sub2api ResolveBedrockBetaTokens family)
// ---------------------------------------------------------------------------

/**
 * Parses the `anthropic-beta` header value into tokens: comma-separated by
 * default, a JSON array when the value is bracketed (sub2api
 * parseAnthropicBetaHeader).
 */
export function parseAnthropicBetaHeader(header: string): string[] {
  const trimmed = header.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter((token) => token !== '');
      }
    } catch {
      // Fall through to comma splitting.
    }
  }
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((token) => token !== '');
}

function stringInArray(value: unknown, target: string): boolean {
  return Array.isArray(value) && value.some((item) => item === target);
}

function hasCodeExecutionAllowedCallers(tool: Record<string, unknown>): boolean {
  return (
    stringInArray(tool.allowed_callers, 'code_execution_20250825') ||
    stringInArray(isRecord(tool.function) ? tool.function.allowed_callers : null, 'code_execution_20250825')
  );
}

function hasInputExamples(tool: Record<string, unknown>): boolean {
  const direct = tool.input_examples;
  if (Array.isArray(direct) && direct.length > 0) return true;
  const nested = isRecord(tool.function) ? tool.function.input_examples : null;
  return Array.isArray(nested) && nested.length > 0;
}

/**
 * Auto-injects the beta tokens the request body implies (sub2api
 * autoInjectBedrockBetaTokens): computer-use tools, tool-search tools
 * (model-gated), and programmatic-tool-calling / input-examples features
 * (via the advanced-tool-use token the filter step then transforms).
 * Thinking never injects interleaved-thinking (no official Bedrock
 * support).
 */
export function autoInjectBedrockBetaTokens(
  tokens: readonly string[],
  body: Record<string, unknown>,
  modelId: string,
): string[] {
  const seen = new Set(tokens);
  const next = [...tokens];
  const inject = (token: string): void => {
    if (!seen.has(token)) {
      next.push(token);
      seen.add(token);
    }
  };
  const tools = body.tools;
  if (Array.isArray(tools)) {
    let toolSearchUsed = false;
    let programmaticToolCallingUsed = false;
    let inputExamplesUsed = false;
    for (const tool of tools) {
      if (!isRecord(tool)) continue;
      const toolType = typeof tool.type === 'string' ? tool.type : '';
      if (toolType.startsWith('computer_20')) inject(BEDROCK_COMPUTER_USE_BETA_TOKEN);
      if (BEDROCK_TOOL_SEARCH_TYPES.has(toolType)) toolSearchUsed = true;
      if (hasCodeExecutionAllowedCallers(tool)) programmaticToolCallingUsed = true;
      if (hasInputExamples(tool)) inputExamplesUsed = true;
    }
    if (programmaticToolCallingUsed || inputExamplesUsed) inject(BEDROCK_ADVANCED_TOOL_USE_BETA_TOKEN);
    if (toolSearchUsed && bedrockModelSupportsToolSearch(modelId)) {
      if (!programmaticToolCallingUsed && !inputExamplesUsed) {
        inject(BEDROCK_TOOL_SEARCH_BETA_TOKEN);
      } else {
        inject(BEDROCK_ADVANCED_TOOL_USE_BETA_TOKEN);
      }
    }
  }
  return next;
}

/**
 * Applies the Bedrock token transforms, filters to the supported whitelist
 * (deduplicating), and auto-links tool-examples with tool-search (sub2api
 * filterBedrockBetaTokens).
 */
export function filterBedrockBetaTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tokens) {
    const token = BEDROCK_BETA_TOKEN_TRANSFORMS[raw] ?? raw;
    if (!BEDROCK_SUPPORTED_BETA_TOKENS.has(token) || seen.has(token)) continue;
    result.push(token);
    seen.add(token);
  }
  if (seen.has(BEDROCK_TOOL_SEARCH_BETA_TOKEN) && !seen.has(BEDROCK_TOOL_EXAMPLES_BETA_TOKEN)) {
    result.push(BEDROCK_TOOL_EXAMPLES_BETA_TOKEN);
  }
  return result;
}

/**
 * The full pre-body beta resolution (sub2api ResolveBedrockBetaTokens):
 * parse the header, auto-inject from the body, then filter/transform.
 */
export function resolveBedrockBetaTokens(betaHeader: string, body: Record<string, unknown>, modelId: string): string[] {
  return filterBedrockBetaTokens(autoInjectBedrockBetaTokens(parseAnthropicBetaHeader(betaHeader), body, modelId));
}

// ---------------------------------------------------------------------------
// Request body preparation (sub2api PrepareBedrockRequestBodyWithTokens)
// ---------------------------------------------------------------------------

/** Drops one top-level field on a copy-on-write body. */
function deleteField(body: Record<string, unknown>, field: string): Record<string, unknown> {
  if (!(field in body)) return body;
  const next = { ...body };
  delete next[field];
  return next;
}

/**
 * Strips body fields whose beta tokens did not survive the Bedrock filter
 * (sub2api sanitizeBedrockFieldsForBetaTokens): context_management without
 * the context-management token; fallbacks / fallback_credit_token always
 * (their beta tokens are never in the Bedrock whitelist).
 */
export function sanitizeBedrockFieldsForBetaTokens(
  body: Record<string, unknown>,
  betaTokens: readonly string[],
): Record<string, unknown> {
  let next = body;
  if (!betaTokens.includes(BEDROCK_CONTEXT_MANAGEMENT_BETA_TOKEN)) {
    next = deleteField(next, 'context_management');
  }
  next = deleteField(next, 'fallbacks');
  next = deleteField(next, 'fallback_credit_token');
  return next;
}

/**
 * Inlines `output_format.schema` onto the last user message as a text block
 * (sub2api convertOutputFormatToInlineSchema, the litellm
 * _convert_output_format_to_inline_schema port): Bedrock InvokeModel does
 * not accept output_format, so the JSON schema is serialized into the
 * conversation instead.
 */
export function convertOutputFormatToInlineSchema(body: Record<string, unknown>): Record<string, unknown> {
  const outputFormat = body.output_format;
  if (!isRecord(outputFormat)) return body;
  const next = deleteField(body, 'output_format');
  const schema = outputFormat.schema;
  if (schema === undefined) return next;
  const messages = next.messages;
  if (!Array.isArray(messages)) return next;
  let lastUserIdx = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRecord(messages[index]) && messages[index].role === 'user') {
      lastUserIdx = index;
      break;
    }
  }
  if (lastUserIdx < 0) return next;
  const schemaText = JSON.stringify(schema);
  const message = messages[lastUserIdx] as Record<string, unknown>;
  const content = message.content;
  const copiedMessages = messages.slice() as unknown[];
  if (Array.isArray(content)) {
    copiedMessages[lastUserIdx] = { ...message, content: [...content, { type: 'text', text: schemaText }] };
  } else if (typeof content === 'string') {
    copiedMessages[lastUserIdx] = {
      ...message,
      content: [
        { type: 'text', text: content },
        { type: 'text', text: schemaText },
      ],
    };
  } else {
    return next;
  }
  return { ...next, messages: copiedMessages };
}

/**
 * Removes the `custom` field from every tool definition (sub2api
 * removeCustomFieldFromTools): Claude Code sends `custom: {defer_loading:
 * true}` which Bedrock rejects as an extra input.
 */
export function removeCustomFieldFromTools(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;
  let modified = false;
  const nextTools = tools.map((tool) => {
    if (!isRecord(tool) || !('custom' in tool)) return tool;
    const next: Record<string, unknown> = { ...tool };
    delete next.custom;
    modified = true;
    return next;
  });
  return modified ? { ...body, tools: nextTools } : body;
}

/**
 * Sanitizes `cache_control` on system blocks and message content blocks
 * (sub2api sanitizeBedrockCacheControl): strips `scope` always and `ttl`
 * unless the model is Claude 4.5+ and the value is "5m"/"1h".
 */
export function sanitizeBedrockCacheControl(body: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const isClaude45 = isBedrockClaude45OrNewer(modelId);
  let next = body;

  const system = next.system;
  if (Array.isArray(system)) {
    for (let index = 0; index < system.length; index += 1) {
      const item = system[index];
      if (isRecord(item) && isRecord(item.cache_control)) {
        next = sanitizeOneCacheControl(next, `system.${index}.cache_control`, item.cache_control, isClaude45);
      }
    }
  }

  const messages = next.messages;
  if (!Array.isArray(messages)) return next;
  for (let mi = 0; mi < messages.length; mi += 1) {
    const message = messages[mi];
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (let ci = 0; ci < content.length; ci += 1) {
      const block = content[ci];
      if (isRecord(block) && isRecord(block.cache_control)) {
        next = sanitizeOneCacheControl(
          next,
          `messages.${mi}.content.${ci}.cache_control`,
          block.cache_control,
          isClaude45,
        );
      }
    }
  }
  return next;
}

/** One cache_control object's scope/ttl policy (sub2api deleteCacheControlUnsupportedFields). */
function sanitizeOneCacheControl(
  body: Record<string, unknown>,
  path: string,
  cacheControl: Record<string, unknown>,
  isClaude45: boolean,
): Record<string, unknown> {
  let next = body;
  if ('scope' in cacheControl) {
    next = deleteAtPath(next, `${path}.scope`);
  }
  const ttl = cacheControl.ttl;
  if (ttl !== undefined) {
    const keep = isClaude45 && (ttl === '5m' || ttl === '1h');
    if (!keep) {
      next = deleteAtPath(next, `${path}.ttl`);
    }
  }
  return next;
}

/**
 * Copy-on-write delete of a nested key (dot path; numeric segments address
 * array elements). Returns the same object reference when nothing changed.
 */
function deleteAtPath(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const segments = path.split('.');

  function descend(
    node: Record<string, unknown> | unknown[],
    depth: number,
  ): Record<string, unknown> | unknown[] | null {
    const segment = segments[depth];
    if (depth === segments.length - 1) {
      if (Array.isArray(node)) {
        const index = Number(segment);
        if (!Number.isSafeInteger(index) || index < 0 || index >= node.length) return null;
        const copy = node.slice();
        copy.splice(index, 1);
        return copy;
      }
      if (!(segment in node)) return null;
      const copy: Record<string, unknown> = { ...node };
      delete copy[segment];
      return copy;
    }
    const child: unknown = Array.isArray(node) ? node[Number(segment)] : node[segment];
    if (!isRecord(child) && !Array.isArray(child)) return null;
    const replaced = descend(child, depth + 1);
    if (replaced === null) return null;
    if (Array.isArray(node)) {
      const index = Number(segment);
      const copy = node.slice();
      copy[index] = replaced;
      return copy;
    }
    return { ...node, [segment]: replaced };
  }

  const result = descend(root, 0);
  return result === null ? root : (result as Record<string, unknown>);
}

/**
 * Fixes the `thinking` field for Bedrock compatibility (sub2api
 * sanitizeBedrockThinking): Fable 5 forces adaptive and drops
 * budget_tokens; Opus 4.7+ converts `enabled` to `adaptive` and drops
 * budget_tokens; other models get the default budget_tokens when `enabled`
 * carries none.
 */
export function sanitizeBedrockThinking(body: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const thinking = body.thinking;
  if (!isRecord(thinking)) return body;
  const thinkingType = typeof thinking.type === 'string' ? thinking.type : '';
  if (thinkingType === '') return body;
  const withThinking = (mutate: (draft: Record<string, unknown>) => void): Record<string, unknown> => {
    const draft: Record<string, unknown> = { ...thinking };
    mutate(draft);
    return { ...body, thinking: draft };
  };
  if (isBedrockFable5(modelId)) {
    if (thinkingType === 'enabled') {
      return withThinking((draft) => {
        draft.type = 'adaptive';
        delete draft.budget_tokens;
      });
    }
    if (thinkingType === 'adaptive') {
      return withThinking((draft) => {
        delete draft.budget_tokens;
      });
    }
    return body;
  }
  if (isBedrockOpus47OrNewer(modelId)) {
    if (thinkingType === 'enabled') {
      return withThinking((draft) => {
        draft.type = 'adaptive';
        delete draft.budget_tokens;
      });
    }
    return body;
  }
  if (thinkingType === 'enabled' && thinking.budget_tokens === undefined) {
    return withThinking((draft) => {
      draft.budget_tokens = BEDROCK_DEFAULT_THINKING_BUDGET_TOKENS;
    });
  }
  return body;
}

/** One tool_use id's character sanitization (sub2api sanitizeIDField). */
export function sanitizeToolUseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Sanitizes `tool_use.id` / `tool_result.tool_use_id` values to the
 * `[a-zA-Z0-9_-]` alphabet Bedrock requires (sub2api
 * sanitizeBedrockToolUseIDs); every other character becomes `_`.
 */
export function sanitizeBedrockToolUseIds(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  let next = body;
  for (let mi = 0; mi < messages.length; mi += 1) {
    const message = messages[mi];
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (let ci = 0; ci < content.length; ci += 1) {
      const block = content[ci];
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const sanitized = sanitizeToolUseId(block.id);
        if (sanitized !== block.id) next = replaceMessageBlock(next, mi, ci, { ...block, id: sanitized });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const sanitized = sanitizeToolUseId(block.tool_use_id);
        if (sanitized !== block.tool_use_id) {
          next = replaceMessageBlock(next, mi, ci, { ...block, tool_use_id: sanitized });
        }
      }
    }
  }
  return next;
}

/** Replaces `messages[mi].content[ci]` inside a copy-on-write body. */
function replaceMessageBlock(
  body: Record<string, unknown>,
  mi: number,
  ci: number,
  block: Record<string, unknown>,
): Record<string, unknown> {
  const messages = body.messages as unknown[];
  const message = messages[mi] as Record<string, unknown>;
  const content = message.content as unknown[];
  const copiedContent = content.slice();
  copiedContent[ci] = block;
  const copiedMessages = messages.slice();
  copiedMessages[mi] = { ...message, content: copiedContent };
  return { ...body, messages: copiedMessages };
}

/**
 * The Claude Code compatibility strip (sub2api sanitizeBedrockCCFields):
 * removes the Anthropic-direct-only fields (service_tier, interface_geo,
 * context_management, fallbacks, fallback_credit_token) and injects the
 * required max_tokens default when omitted. anthropic_version injection is
 * handled by prepareBedrockRequestBody.
 */
export function sanitizeBedrockCcFields(body: Record<string, unknown>): Record<string, unknown> {
  let next = body;
  for (const field of ['service_tier', 'interface_geo', 'context_management', 'fallbacks', 'fallback_credit_token']) {
    next = deleteField(next, field);
  }
  if (next.max_tokens === undefined) {
    next = { ...next, max_tokens: BEDROCK_CC_DEFAULT_MAX_TOKENS };
  }
  return next;
}

export interface PreparedBedrockRequestBody {
  /** The Bedrock InvokeModel JSON body. */
  readonly body: Record<string, unknown>;
  /** The final beta tokens (already filtered; injected as anthropic_beta). */
  readonly betaTokens: readonly string[];
}

/**
 * The complete Bedrock InvokeModel body preparation (sub2api
 * PrepareBedrockRequestBodyWithTokens with ccCompat always applied — this
 * gateway's clients are Claude Code-class, so the thinking/tool-id fixes
 * are unconditional). Steps in the reference order:
 *
 * 1. beta-token filter + body beta-field strip
 * 2. CC-field strip (service_tier/interface_geo/… + max_tokens default)
 * 3. thinking fixes (Fable 5 / Opus 4.7+ / default budget)
 * 4. tool_use id sanitization
 * 5. anthropic_version injection (required)
 * 6. anthropic_beta injection (body-carried beta, not an HTTP header)
 * 7. provider/metadata/model/stream removal (model rides the URL; the
 *    endpoint selects streaming)
 * 8. output_format.schema inlining + output_config removal
 * 9. tool `custom` field removal
 * 10. cache_control scope/ttl sanitization (model-gated)
 */
export function prepareBedrockRequestBody(
  input: unknown,
  options: {
    /** The already-resolved Bedrock model id (resolveBedrockModel output). */
    readonly modelId: string;
    /** The client's anthropic-beta header value, when present. */
    readonly betaHeader?: string;
  },
): PreparedBedrockRequestBody {
  if (!isRecord(input)) throw new BedrockTransformError('MALFORMED_BODY');
  const betaTokens = resolveBedrockBetaTokens(options.betaHeader ?? '', input, options.modelId);
  let body = sanitizeBedrockFieldsForBetaTokens(input, betaTokens);

  body = sanitizeBedrockCcFields(body);
  body = sanitizeBedrockThinking(body, options.modelId);
  body = sanitizeBedrockToolUseIds(body);

  body = { ...body, anthropic_version: BEDROCK_ANTHROPIC_VERSION };
  if (betaTokens.length > 0) {
    body = { ...body, anthropic_beta: [...betaTokens] };
  } else {
    body = deleteField(body, 'anthropic_beta');
  }

  body = deleteField(body, 'provider');
  body = deleteField(body, 'metadata');
  body = deleteField(body, 'model');
  body = deleteField(body, 'stream');

  body = convertOutputFormatToInlineSchema(body);
  body = deleteField(body, 'output_config');

  body = removeCustomFieldFromTools(body);
  body = sanitizeBedrockCacheControl(body, options.modelId);

  return { body, betaTokens };
}
