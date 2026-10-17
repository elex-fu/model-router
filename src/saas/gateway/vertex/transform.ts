/**
 * Batch-3 Vertex AI request transformation (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; port of
 * sub2api's buildVertexAnthropicURL / buildVertexGeminiURL /
 * buildVertexAnthropicRequestBody / filterVertexBetaTokens /
 * sanitizeAnthropicBodyForBetaTokens from backend/internal/service/
 * vertex_service_account.go and gateway_upstream_request.go onto this
 * codebase's pure JSON-in/JSON-out conventions). Pure helpers: nothing here
 * touches HTTP, streams, or storage.
 */

import {
  isSafeVertexLocation,
  VERTEX_ALLOWED_REQUEST_HEADERS,
  VERTEX_ANTHROPIC_ALREADY_DATED_PATTERN,
  VERTEX_ANTHROPIC_DATED_MODEL_PATTERN,
  VERTEX_ANTHROPIC_VERSION,
  VERTEX_BETA_CONTEXT_MANAGEMENT,
  VERTEX_MAX_MODEL_ID_LENGTH,
  VERTEX_STRIPPED_AUTH_HEADERS,
  VERTEX_SUPPORTED_BETA_TOKENS,
} from './constants.js';

export type VertexTransformErrorCode =
  | 'MALFORMED_BODY'
  | 'MALFORMED_MODEL'
  | 'MALFORMED_LOCATION'
  | 'MALFORMED_PROJECT';

export class VertexTransformError extends Error {
  constructor(readonly code: VertexTransformErrorCode) {
    super(
      code === 'MALFORMED_BODY'
        ? 'vertex request body is malformed'
        : code === 'MALFORMED_MODEL'
          ? 'vertex model id is malformed'
          : code === 'MALFORMED_LOCATION'
            ? 'vertex location is malformed'
            : 'vertex project id is malformed',
    );
    this.name = 'VertexTransformError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/** Whether a model id is safe to interpolate into an aiplatform path segment. */
export function isSafeVertexModelId(model: string): boolean {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= VERTEX_MAX_MODEL_ID_LENGTH &&
    MODEL_ID_PATTERN.test(model)
  );
}

function requireProjectId(projectId: string): string {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : '';
  if (trimmed === '' || trimmed.length > 128) throw new VertexTransformError('MALFORMED_PROJECT');
  return trimmed;
}

function requireLocation(location: string): string {
  const trimmed = typeof location === 'string' ? location.trim() : '';
  if (!isSafeVertexLocation(trimmed)) throw new VertexTransformError('MALFORMED_LOCATION');
  return trimmed;
}

function requireModel(model: string): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!isSafeVertexModelId(trimmed)) throw new VertexTransformError('MALFORMED_MODEL');
  return trimmed;
}

/** The aiplatform host for a location: `global` has no regional prefix. */
export function vertexApiHost(location: string, apiBaseHost = 'aiplatform.googleapis.com'): string {
  const host = apiBaseHost.trim().toLowerCase();
  if (host === '') throw new VertexTransformError('MALFORMED_LOCATION');
  return location === 'global' ? host : `${location}-${host}`;
}

/**
 * Anthropic-on-Vertex URL (sub2api buildVertexAnthropicURL):
 * `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/
 * locations/{location}/publishers/anthropic/models/{model}:{rawPredict|
 * streamRawPredict}`. The `@` in an already-dated model id is NOT percent-
 * encoded (Vertex expects the literal `@` in the publishers/anthropic path).
 */
export function buildVertexAnthropicUrl(input: {
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly stream: boolean;
  readonly apiBaseHost?: string;
}): string {
  const projectId = requireProjectId(input.projectId);
  const location = requireLocation(input.location);
  const model = requireModel(input.model);
  const action = input.stream ? 'streamRawPredict' : 'rawPredict';
  const host = vertexApiHost(location, input.apiBaseHost);
  const escapedModel = encodeURIComponent(model).replace(/%40/g, '@');
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
    location,
  )}/publishers/anthropic/models/${escapedModel}:${action}`;
}

/**
 * Gemini-on-Vertex URL (sub2api buildVertexGeminiURL):
 * `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/
 * locations/{location}/publishers/google/models/{model}:{generateContent|
 * streamGenerateContent?alt=sse}`.
 */
export function buildVertexGeminiUrl(input: {
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly stream: boolean;
  readonly apiBaseHost?: string;
}): string {
  const projectId = requireProjectId(input.projectId);
  const location = requireLocation(input.location);
  const model = requireModel(input.model);
  const action = input.stream ? 'streamGenerateContent' : 'generateContent';
  const host = vertexApiHost(location, input.apiBaseHost);
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
    location,
  )}/publishers/google/models/${encodeURIComponent(model)}:${action}${input.stream ? '?alt=sse' : ''}`;
}

/**
 * Anthropic-on-Vertex model-id normalization (sub2api
 * normalizeVertexAnthropicModelID): the dated CLI spelling
 * `claude-x-20260101` rewrites onto the Vertex `@` spelling
 * `claude-x@20260101`; an already-dated id passes through unchanged.
 */
export function normalizeVertexAnthropicModelId(model: string): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (trimmed === '' || VERTEX_ANTHROPIC_ALREADY_DATED_PATTERN.test(trimmed)) return trimmed;
  const match = VERTEX_ANTHROPIC_DATED_MODEL_PATTERN.exec(trimmed);
  if (match !== null && match.length === 3) return `${match[1]}@${match[2]}`;
  return trimmed;
}

/**
 * The Anthropic-on-Vertex request body (sub2api
 * buildVertexAnthropicRequestBody): the `model` field is deleted (the model
 * rides the URL) and `anthropic_version: "vertex-2023-10-16"` is injected.
 * Copy-on-write: the input value is never mutated.
 */
export function buildVertexAnthropicRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(body)) throw new VertexTransformError('MALFORMED_BODY');
  const next: Record<string, unknown> = { ...body };
  delete next.model;
  next.anthropic_version = VERTEX_ANTHROPIC_VERSION;
  return next;
}

/** Parses a client `anthropic-beta` header into its comma-separated tokens. */
export function parseVertexBetaTokens(header: string | null | undefined): readonly string[] {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4_096) return [];
  const tokens: string[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '' && !tokens.includes(trimmed)) tokens.push(trimmed);
  }
  return tokens;
}

/**
 * Filters the client `anthropic-beta` header onto the Vertex whitelist
 * (sub2api filterVertexBetaTokens): tokens are deduplicated, unknown tokens
 * are stripped (Vertex would answer them with HTTP 400), and the surviving
 * value is comma-joined. An empty result means the header must NOT be sent.
 */
export function filterVertexBetaTokens(header: string | null | undefined): string {
  const whitelist = new Set(VERTEX_SUPPORTED_BETA_TOKENS);
  const out: string[] = [];
  for (const token of parseVertexBetaTokens(header)) {
    if (!whitelist.has(token) || out.includes(token)) continue;
    out.push(token);
  }
  return out.join(',');
}

/** Whether a comma-joined beta value carries the given token. */
export function vertexBetaTokensContain(joined: string, token: string): boolean {
  if (joined === '' || token === '') return false;
  for (const part of joined.split(',')) {
    if (part.trim() === token) return true;
  }
  return false;
}

/**
 * Capability-symmetric body sanitize (sub2api
 * sanitizeAnthropicBodyForBetaTokens, Vertex subset): body fields gated on a
 * beta token are stripped when the FINAL outgoing beta value (post-whitelist
 * filter) lacks that token. `context_management` needs
 * context-management-2025-06-27; `thinking.block_binding`, `fallbacks` and
 * `fallback_credit_token` need tokens that are never on the Vertex
 * whitelist, so those fields strip whenever present. Copy-on-write: the
 * input value is never mutated.
 */
export function sanitizeVertexBodyForBetaTokens(
  body: Record<string, unknown>,
  finalBeta: string,
): { readonly body: Record<string, unknown>; readonly changed: boolean } {
  if (!isRecord(body)) throw new VertexTransformError('MALFORMED_BODY');
  let next = body;
  let changed = false;
  const stripUnless = (field: string, tokens: readonly string[]): void => {
    if (!(field in next)) return;
    if (tokens.some((token) => vertexBetaTokensContain(finalBeta, token))) return;
    if (next === body) next = { ...body };
    delete next[field];
    changed = true;
  };
  stripUnless('context_management', [VERTEX_BETA_CONTEXT_MANAGEMENT]);
  const thinking = 'thinking' in next ? next.thinking : undefined;
  if (isRecord(thinking) && 'block_binding' in thinking) {
    // thinking.block_binding needs thinking-binding-controls-2026-08-01 —
    // never on the Vertex whitelist, so the strip is unconditional whenever
    // the field rides the body (kept explicit so the capability symmetry
    // stays greppable).
    if (next === body) next = { ...body };
    const thinkingCopy: Record<string, unknown> = { ...thinking };
    delete thinkingCopy.block_binding;
    next.thinking = thinkingCopy;
    changed = true;
  }
  stripUnless('fallbacks', ['server-side-fallback-2026-07-01']);
  stripUnless('fallback_credit_token', [
    'server-side-fallback-2026-07-01',
    'fallback-credit-2026-07-01',
    'fallback-credit-2026-06-01',
  ]);
  return { body: next, changed };
}

/**
 * The full outbound body transform for an Anthropic-on-Vertex request:
 * beta-gated field sanitize (against the FINAL filtered beta value) then the
 * model-strip + anthropic_version injection. Pure; fresh object on change.
 */
export function applyVertexAnthropicTransform(
  input: unknown,
  options: { readonly anthropicBetaHeader: string | null | undefined },
): { readonly body: Record<string, unknown>; readonly anthropicBeta: string } {
  if (!isRecord(input)) throw new VertexTransformError('MALFORMED_BODY');
  const anthropicBeta = filterVertexBetaTokens(options.anthropicBetaHeader);
  const sanitized = sanitizeVertexBodyForBetaTokens(input, anthropicBeta);
  return { body: buildVertexAnthropicRequestBody(sanitized.body), anthropicBeta };
}

/**
 * Builds the upstream request header set for an Anthropic-on-Vertex request
 * (sub2api buildUpstreamRequestAnthropicVertex): the client's headers are
 * forwarded only when allowlisted, `anthropic-version` and every
 * authentication header are dropped, the filtered `anthropic-beta` replaces
 * the client's raw value (omitted entirely when empty), and the Bearer
 * access token is the only authentication on the wire.
 */
export function buildVertexAnthropicHeaders(input: {
  readonly clientHeaders: Readonly<Record<string, string>>;
  readonly accessToken: string;
  readonly anthropicBeta: string;
  readonly stream: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input.clientHeaders)) {
    const name = rawName.toLowerCase();
    if (!VERTEX_ALLOWED_REQUEST_HEADERS.has(name)) continue;
    if (name === 'anthropic-version' || name === 'anthropic-beta') continue;
    if (VERTEX_STRIPPED_AUTH_HEADERS.includes(name)) continue;
    if (typeof value !== 'string' || value === '') continue;
    headers[name] = value;
  }
  headers.authorization = `Bearer ${input.accessToken}`;
  headers['content-type'] = 'application/json';
  headers.accept = input.stream ? 'text/event-stream' : 'application/json';
  if (input.anthropicBeta !== '') headers['anthropic-beta'] = input.anthropicBeta;
  return headers;
}
