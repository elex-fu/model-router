/**
 * F4 Gemini request transformation (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b; port of sub2api's
 * anthropic→Gemini conversion and the Code Assist v1internal dispatch wrap
 * from service/gemini_chat_completions_compat_service.go /
 * gemini_messages_compat_service.go onto this codebase's pure
 * JSON-in/JSON-out conventions). Pure helpers: nothing here touches HTTP,
 * streams, or storage.
 *
 * The gateway serves two client protocols onto a Gemini Code Assist
 * subscription account:
 *
 * - a native Gemini client (`/v1beta/*` bodies) passes through with model-id
 *   normalization and the AI Studio tool-key normalization
 *   (`googleSearch` → `google_search`) applied;
 * - an Anthropic-protocol client body is converted to the Gemini native
 *   shape: `messages` → `contents` (assistant → model role; text blocks →
 *   parts; images → inlineData), `system` → `systemInstruction`, Anthropic
 *   `tools` → `functionDeclarations`, and `max_tokens`/`temperature`/`top_p`
 *   → `generationConfig`.
 *
 * Every outbound request is then wrapped for the Code Assist internal
 * endpoint: `{model, project, request}` posted to
 * `/v1internal:generateContent` / `:streamGenerateContent?alt=sse` (sub2api
 * parity; the wrap is what makes cloudcode-pa serve the CLI's traffic).
 */

import {
  GEMINI_DEFAULT_MAX_OUTPUT_TOKENS,
  GEMINI_MAX_MODEL_ID_LENGTH,
  GEMINI_MODEL_ID_OVERRIDES,
} from './constants.js';

export type GeminiTransformErrorCode = 'MALFORMED_BODY' | 'MALFORMED_MODEL';

export class GeminiTransformError extends Error {
  constructor(readonly code: GeminiTransformErrorCode) {
    super(code === 'MALFORMED_BODY' ? 'gemini request body is malformed' : 'gemini model id is malformed');
    this.name = 'GeminiTransformError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether a model id is safe to interpolate into an upstream path segment. */
export function isSafeGeminiModelId(model: string): boolean {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= GEMINI_MAX_MODEL_ID_LENGTH &&
    MODEL_ID_PATTERN.test(model)
  );
}

/**
 * Maps a client-visible model alias onto the catalog id the upstream accepts:
 * the namespaced `gemini/<model>` public alias and the `models/<model>` v1beta
 * path spelling are stripped, then the alias table is applied.
 */
export function normalizeGeminiModelId(model: string): string {
  if (typeof model !== 'string' || model.length === 0) return model;
  let stripped = model.startsWith('models/') ? model.slice('models/'.length) : model;
  if (stripped.startsWith('gemini/')) stripped = stripped.slice('gemini/'.length);
  const canonical = GEMINI_MODEL_ID_OVERRIDES[stripped] ?? stripped;
  return canonical;
}

/** Strips/normalizes the model id inside a native Gemini request body (copy-on-write). */
export function applyGeminiModelNormalization(body: Record<string, unknown>): Record<string, unknown> {
  const rawModel = body.model;
  if (typeof rawModel !== 'string' || rawModel.length === 0) return body;
  const normalized = normalizeGeminiModelId(rawModel);
  return normalized === rawModel ? body : { ...body, model: normalized };
}

/**
 * AI Studio tool-key normalization (sub2api
 * normalizeGeminiRequestForAIStudio): the built-in search tool's camelCase
 * `googleSearch` key is renamed to `google_search`. Copy-on-write.
 */
export function normalizeGeminiToolsForAiStudio(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;
  let modified = false;
  const nextTools = tools.map((tool) => {
    if (!isRecord(tool) || !('googleSearch' in tool) || 'google_search' in tool) return tool;
    const next: Record<string, unknown> = { ...tool, google_search: tool.googleSearch };
    delete next.googleSearch;
    modified = true;
    return next;
  });
  return modified ? { ...body, tools: nextTools } : body;
}

/** One Gemini content part (the shapes this bridge produces). */
export type GeminiPart =
  | { readonly text: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } }
  | { readonly functionCall: { readonly name: string; readonly args: Record<string, unknown> } }
  | { readonly functionResponse: { readonly name: string; readonly response: Record<string, unknown> } };

/** One Gemini content entry: role user/model with ordered parts. */
export interface GeminiContent {
  readonly role: 'user' | 'model';
  readonly parts: readonly GeminiPart[];
}

function textPart(value: unknown): GeminiPart | null {
  return typeof value === 'string' && value.length > 0 ? { text: value } : null;
}

function imagePart(block: Record<string, unknown>): GeminiPart | null {
  const source = isRecord(block.source) ? block.source : null;
  if (source === null) return null;
  const mimeType =
    typeof source.media_type === 'string' && source.media_type.length > 0 ? source.media_type : 'image/png';
  const data = typeof source.data === 'string' ? source.data : '';
  return { inlineData: { mimeType, data } };
}

function toolResultPart(block: Record<string, unknown>): GeminiPart | null {
  const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : null;
  const content = block.content;
  if (name === null) return null;
  // Anthropic tool_result content maps onto Gemini's functionResponse.response:
  // a text block becomes {output: text}; a parsed JSON object passes through.
  let response: Record<string, unknown>;
  if (typeof content === 'string') {
    response = { output: content };
  } else if (isRecord(content)) {
    response = content;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (isRecord(item) && typeof item.text === 'string') texts.push(item.text);
    }
    response = { output: texts.join('\n') };
  } else {
    response = {};
  }
  return { functionResponse: { name, response } };
}

function contentParts(content: unknown): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (typeof content === 'string') {
    const part = textPart(content);
    if (part !== null) parts.push(part);
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const block of content) {
    if (typeof block === 'string') {
      const part = textPart(block);
      if (part !== null) parts.push(part);
      continue;
    }
    if (!isRecord(block)) continue;
    switch (block.type) {
      case 'text': {
        const part = textPart(block.text);
        if (part !== null) parts.push(part);
        break;
      }
      case 'image': {
        const part = imagePart(block);
        if (part !== null) parts.push(part);
        break;
      }
      case 'tool_use': {
        if (typeof block.name === 'string' && block.name.length > 0) {
          parts.push({
            functionCall: { name: block.name, args: isRecord(block.input) ? block.input : {} },
          });
        }
        break;
      }
      case 'tool_result': {
        const part = toolResultPart(block);
        if (part !== null) parts.push(part);
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function anthropicMessagesToContents(messages: unknown): GeminiContent[] {
  if (!Array.isArray(messages)) return [];
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = contentParts(message.content);
    if (parts.length === 0) continue;
    contents.push({ role, parts });
  }
  return contents;
}

function anthropicSystemToInstruction(system: unknown): { readonly parts: readonly GeminiPart[] } | null {
  const parts: GeminiPart[] = [];
  if (typeof system === 'string') {
    const part = textPart(system);
    if (part !== null) parts.push(part);
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (isRecord(block) && typeof block.text === 'string') {
        const part = textPart(block.text);
        if (part !== null) parts.push(part);
      }
    }
  }
  return parts.length === 0 ? null : { parts };
}

function anthropicToolsToGeminiTools(tools: unknown): { readonly functionDeclarations: unknown[] }[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const declarations: unknown[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== 'custom' || !isRecord(tool.input_schema)) continue;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    declarations.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.input_schema,
    });
  }
  return declarations.length === 0 ? null : [{ functionDeclarations: declarations }];
}

export interface AnthropicToGeminiResult {
  /** The Gemini native request body (contents/systemInstruction/tools/generationConfig). */
  readonly payload: Record<string, unknown>;
  /** The normalized upstream model id. */
  readonly model: string;
}

/**
 * Converts an Anthropic-protocol request body into the Gemini native request
 * shape. `max_tokens` defaults to the CLI-scale 65536 when omitted (Gemini
 * has no hard requirement but the wrap should always carry one);
 * `temperature`/`top_p`/`stop_sequences` map onto their generationConfig
 * names; `stream` is the caller's concern, not the body's.
 */
export function anthropicToGeminiRequest(
  input: unknown,
  options: { readonly defaultMaxOutputTokens?: number } = {},
): AnthropicToGeminiResult {
  if (!isRecord(input)) throw new GeminiTransformError('MALFORMED_BODY');
  const model = normalizeGeminiModelId(typeof input.model === 'string' ? input.model : '');
  if (!isSafeGeminiModelId(model)) throw new GeminiTransformError('MALFORMED_MODEL');

  const payload: Record<string, unknown> = {};
  const contents = anthropicMessagesToContents(input.messages);
  if (contents.length > 0) payload.contents = contents;

  const systemInstruction = anthropicSystemToInstruction(input.system);
  if (systemInstruction !== null) payload.systemInstruction = systemInstruction;

  const tools = anthropicToolsToGeminiTools(input.tools);
  if (tools !== null) payload.tools = tools;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens:
      typeof input.max_tokens === 'number' && Number.isFinite(input.max_tokens) && input.max_tokens > 0
        ? Math.round(input.max_tokens)
        : (options.defaultMaxOutputTokens ?? GEMINI_DEFAULT_MAX_OUTPUT_TOKENS),
  };
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    generationConfig.temperature = input.temperature;
  }
  if (typeof input.top_p === 'number' && Number.isFinite(input.top_p)) {
    generationConfig.topP = input.top_p;
  }
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length > 0) {
    generationConfig.stopSequences = input.stop_sequences.filter(
      (stop): stop is string => typeof stop === 'string' && stop.length > 0,
    );
  }
  payload.generationConfig = generationConfig;
  return { payload, model };
}

/** The wrapped body shape the Code Assist v1internal endpoint expects. */
export function wrapGeminiCodeAssistRequest(
  request: Record<string, unknown>,
  model: string,
  projectId: string,
): Record<string, unknown> {
  if (!isSafeGeminiModelId(model)) throw new GeminiTransformError('MALFORMED_MODEL');
  if (typeof projectId !== 'string' || projectId.trim().length === 0 || projectId.length > 128) {
    throw new GeminiTransformError('MALFORMED_BODY');
  }
  return { model, project: projectId.trim(), request };
}

/** Unwraps the Code Assist response envelope (`{response: {...}}`); passthrough when absent. */
export function unwrapGeminiResponse(body: Record<string, unknown>): Record<string, unknown> {
  const response = body.response;
  return isRecord(response) ? response : body;
}

/**
 * The full outbound transform for a Gemini Code Assist subscription account:
 * model normalization + AI Studio tool-key normalization + the v1internal
 * wrap. Pure: the input value is never mutated; the output is a fresh object.
 * Non-object input throws `GeminiTransformError` so the caller can fail
 * closed.
 */
export function applyGeminiCodeAssistTransform(
  input: unknown,
  options: { readonly projectId: string },
): { readonly body: Record<string, unknown>; readonly model: string } {
  if (!isRecord(input)) throw new GeminiTransformError('MALFORMED_BODY');
  const normalized = normalizeGeminiToolsForAiStudio(applyGeminiModelNormalization(input));
  const model = typeof normalized.model === 'string' ? normalized.model : '';
  if (!isSafeGeminiModelId(model)) throw new GeminiTransformError('MALFORMED_MODEL');
  return { body: wrapGeminiCodeAssistRequest(normalized, model, options.projectId), model };
}
