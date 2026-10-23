import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import { resolveCodexTrustedBoundProfile } from './codex-trusted-bound-profiles.js';
import type { ProviderUsageUpperBoundEstimator } from '../gateway/provider-payload-compiler.js';

const FRAMING_TOKEN_ALLOWANCE = 4096;
const NONLOCAL_KEYS = new Set([
  'previous_response_id',
  'conversation',
  'conversation_id',
  'cachedContent',
  'cached_content',
  'encrypted_content',
  'file_id',
  'file_url',
  'image_url',
  'video_url',
  'audio_url',
  'fileData',
  'inlineData',
  'inline_data',
]);
const MEDIA_TYPES = new Set([
  'image',
  'image_url',
  'input_image',
  'input_file',
  'file',
  'video',
  'input_video',
  'audio',
  'input_audio',
  'compaction',
  'file_search',
  'code_interpreter',
  'mcp',
  'computer_use',
  'image_generation',
]);

function unavailable(): never {
  throw new Error('Built-in usage bound is unavailable');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** These fields configure execution/context at request or tool declaration positions. */
function assertDirectToolConfiguration(value: Record<string, unknown>): void {
  for (const key of [
    'container',
    'mcp_servers',
    'mcpServers',
    'server',
    'server_url',
    'server_label',
    'server_config',
    'serverConfig',
    'connector_id',
    'connectorId',
  ]) {
    if (Object.hasOwn(value, key)) unavailable();
  }
  if (
    Object.hasOwn(value, 'allowed_callers') &&
    (!Array.isArray(value.allowed_callers) || value.allowed_callers.some((caller) => caller !== 'direct'))
  )
    unavailable();
}

function assertNamedLocalTool(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value) || typeof value.name !== 'string' || value.name.trim().length === 0) unavailable();
  assertDirectToolConfiguration(value);
}

/** Only local declarations establish a byte bound; unknown tool kinds fail closed. */
function assertLocalTools(body: Record<string, unknown>, protocol: string): void {
  assertDirectToolConfiguration(body);
  if (!Object.hasOwn(body, 'tools')) return;
  if (!Array.isArray(body.tools)) unavailable();
  for (const tool of body.tools) {
    if (!record(tool)) unavailable();
    assertDirectToolConfiguration(tool);
    if (protocol === 'anthropic') {
      assertNamedLocalTool(tool);
      if ((tool.type !== undefined && tool.type !== 'custom') || !record(tool.input_schema)) unavailable();
    } else if (protocol === 'openai') {
      if (tool.type !== 'function' && tool.type !== 'custom') unavailable();
      const declaration = tool.type === 'function' ? tool.function : tool.custom;
      assertNamedLocalTool(declaration);
      if (declaration.type !== undefined) unavailable();
    } else if (protocol === 'responses') {
      assertNamedLocalTool(tool);
      if (tool.type !== 'function' && tool.type !== 'custom') unavailable();
    } else if (protocol === 'gemini') {
      // A wrapper containing search/code/retrieval beside declarations can
      // execute remotely, even when all its function declarations are local.
      if (Object.keys(tool).length !== 1 || !Array.isArray(tool.functionDeclarations)) unavailable();
      for (const declaration of tool.functionDeclarations) {
        assertNamedLocalTool(declaration);
        if (declaration.type !== undefined) unavailable();
      }
    } else unavailable();
  }
}

/** Local text and function data have a byte bound; remote/opaque context does not. */
function assertLocalTextContext(body: unknown): void {
  const pending: unknown[] = [body];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!record(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      // Function schemas and already-supplied function arguments are local
      // prompt data. Property names inside them do not request resources.
      if (
        key === 'input_schema' ||
        (['parameters', 'parametersJsonSchema', 'response', 'responseJsonSchema', 'args'].includes(key) &&
          typeof value.name === 'string') ||
        (key === 'input' && value.type === 'tool_use' && typeof value.name === 'string') ||
        (key === 'input' && value.type === 'custom_tool_call' && typeof value.name === 'string') ||
        (key === 'arguments' && typeof value.name === 'string')
      )
        continue;
      if (NONLOCAL_KEYS.has(key) && child !== null && child !== undefined && child !== '') unavailable();
      if (
        key === 'type' &&
        typeof child === 'string' &&
        (MEDIA_TYPES.has(child) || child.startsWith('web_search') || child.startsWith('computer_'))
      )
        unavailable();
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
}

/**
 * The bound is established from the exact bytes that will be signed, rather
 * than from a configurable number described as a model context limit. For
 * locally supplied text/function data, two tokens per UTF-8 byte plus a fixed
 * allowance over-reserves protocol framing and bounded category metadata.
 * Every accepted request must fit the deployment ceiling before admission.
 * Remote history, multimodal resources and encrypted compaction continuations
 * need a separately trusted model context ceiling and fail closed here.
 */
export function createBuiltinUsageUpperBoundEstimator(options: {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}): ProviderUsageUpperBoundEstimator {
  return {
    version: 'builtin-local-text-byte-bound/v2',
    estimate({ normalizedRequest, compiledPayloadBytes }) {
      if (!(compiledPayloadBytes instanceof Uint8Array) || compiledPayloadBytes.byteLength === 0) return unavailable();
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(compiledPayloadBytes));
      } catch {
        return unavailable();
      }
      if (!record(body)) return unavailable();
      if (normalizedRequest.providerId === 'openai-codex') {
        // Only this exact backend contract may admit Codex; SIWC/API limits do not apply here.
        const compact = normalizedRequest.providerOperation === 'responses.compact';
        const trusted = resolveCodexTrustedBoundProfile({
          endpoint: compact ? `${CODEX_RESPONSES_ENDPOINT}/compact` : normalizedRequest.upstreamTransport === 'websocket' ? CODEX_RESPONSES_ENDPOINT.replace('https:', 'wss:') : CODEX_RESPONSES_ENDPOINT,
          productId: normalizedRequest.productId,
          model: normalizedRequest.resolvedModel,
          operation: normalizedRequest.providerOperation,
          transport: normalizedRequest.upstreamTransport ?? 'http',
          continuationMode: compact ? 'compact' : normalizedRequest.continuationMode ?? 'full',
        });
        if (!trusted) return unavailable();
        return { bounds: trusted.profile.bounds, trustedBoundEvidenceDigest: trusted.digest };
      }
      assertLocalTools(body, normalizedRequest.providerProtocol);
      assertLocalTextContext(body);
      const conservativeInput = compiledPayloadBytes.byteLength * 2 + FRAMING_TOKEN_ALLOWANCE;
      if (!Number.isSafeInteger(conservativeInput) || conservativeInput > options.maxInputTokens) return unavailable();
      const generation = record(body.generationConfig) ? body.generationConfig : {};
      const outputCandidates =
        normalizedRequest.providerProtocol === 'anthropic'
          ? [body.max_tokens]
          : normalizedRequest.providerProtocol === 'openai'
            ? [body.max_tokens, body.max_completion_tokens]
            : normalizedRequest.providerProtocol === 'gemini'
              ? [generation.maxOutputTokens]
              : [body.max_output_tokens];
      const supplied = outputCandidates.filter((value) => value !== undefined);
      if (
        supplied.length === 0 ||
        supplied.some(
          (value) =>
            typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > options.maxOutputTokens,
        )
      )
        return unavailable();
      const output = Math.max(...(supplied as number[]));
      return {
        inputTotalUpperBound: options.maxInputTokens,
        inputUncachedUpperBound: options.maxInputTokens,
        cacheReadUpperBound: options.maxInputTokens,
        cacheWriteUpperBound: options.maxInputTokens,
        cacheWrite5mUpperBound: options.maxInputTokens,
        cacheWrite1hUpperBound: options.maxInputTokens,
        outputTotalUpperBound: output,
        reasoningOutputUpperBound: output,
        feasibleInputBuckets: ['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'],
      };
    },
  };
}
