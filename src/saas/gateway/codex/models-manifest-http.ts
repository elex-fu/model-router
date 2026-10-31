/**
 * P1-4b (docs/standalone-relay-capability-plan-2026-10-30.md): the ChatGPT
 * Codex models-manifest serving shape for `GET /v1/models`.
 *
 * sub2a parity: the Codex CLI announces itself on the models endpoint via a
 * `client_version` query parameter; when it does, it expects the upstream
 * `codex-rs/models-manager/models.json` envelope (snake_case fields) instead
 * of the plain OpenAI model list, because its model picker parses that
 * document. This module is pure: detection, rendering, and conditional-request
 * matching over the checked-in manifest — no network, no PG, no state.
 */

import { createHash } from 'node:crypto';

import type { CodexModelManifestEntry } from './models-manifest.js';

/** Structural supertype of `IncomingHttpHeaders` for header lookups. */
export type ManifestRequestHeaders = Readonly<Record<string, number | readonly string[] | string | undefined>>;

/** A rendered manifest response: the exact bytes plus its strong ETag. */
export interface RenderedCodexModelsManifest {
  readonly status: 200;
  readonly body: string;
  readonly etag: string;
}

/**
 * sub2a's Codex detection: a `client_version` query parameter that is present
 * and non-empty. The version value itself is never validated — any client
 * claiming the parameter opts into the manifest shape.
 */
export function isCodexModelsManifestRequest(query: URLSearchParams | string): boolean {
  const params = typeof query === 'string' ? parseRawQuery(query) : query;
  const clientVersion = params.get('client_version');
  return clientVersion !== null && clientVersion.length > 0;
}

/**
 * Renders the ChatGPT Codex manifest envelope from the gateway manifest
 * entries, field-for-field in the upstream snake_case spelling:
 *
 * `{ "models": [ { slug, display_name, description, context_window,
 * max_context_window, input_modalities, default_reasoning_level,
 * supported_reasoning_levels: [{ effort, description? }],
 * apply_patch_tool_type, web_search_tool_type, tool_mode,
 * use_responses_lite, supports_parallel_tool_calls, prefer_websockets,
 * supports_image_detail_original } ] }`
 *
 * `usableSlugs` is the caller's validated model list (the advertisement gate
 * stays authoritative): non-null → only entries whose slug appears in it, in
 * manifest order; null → every entry. An empty intersection returns null so
 * the caller falls back to the plain OpenAI list — an empty manifest is never
 * advertised.
 */
export function renderCodexModelsManifestResponse(
  entries: readonly CodexModelManifestEntry[],
  usableSlugs: readonly string[] | null,
): RenderedCodexModelsManifest | null {
  const selected =
    usableSlugs === null ? entries : entries.filter((entry) => usableSlugs.includes(entry.slug));
  if (selected.length === 0) return null;
  const body = JSON.stringify({ models: selected.map(renderEntry) });
  return { status: 200, body, etag: etagFromBody(body) };
}

/** Strong ETag: quoted sha1 of the exact response body. */
export function codexModelsManifestEtag(entries: readonly CodexModelManifestEntry[], usableSlugs: readonly string[] | null): string | null {
  const rendered = renderCodexModelsManifestResponse(entries, usableSlugs);
  return rendered === null ? null : rendered.etag;
}

/**
 * If-None-Match for the manifest: exact strong match, `W/"..."` weak match,
 * or membership in a comma-separated candidate list. Whitespace is trimmed;
 * anything else (including `*`) does not match.
 */
export function matchesCodexModelsManifestEtag(requestHeaders: ManifestRequestHeaders, etag: string): boolean {
  const raw = headerValue(requestHeaders, 'if-none-match');
  if (raw === null) return false;
  return raw
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === etag || candidate === `W/${etag}`);
}

function etagFromBody(body: string): string {
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

function renderEntry(entry: CodexModelManifestEntry): Record<string, unknown> {
  return {
    slug: entry.slug,
    display_name: entry.displayName,
    description: entry.description,
    context_window: entry.contextWindow,
    max_context_window: entry.contextWindow,
    input_modalities: [...entry.inputModalities],
    default_reasoning_level: entry.defaultReasoningLevel,
    supported_reasoning_levels: entry.supportedReasoningEfforts.map((effort) => ({ effort })),
    apply_patch_tool_type: entry.applyPatchToolType,
    web_search_tool_type: entry.webSearchToolType,
    tool_mode: entry.toolMode,
    use_responses_lite: entry.useResponsesLite,
    supports_parallel_tool_calls: entry.supportsParallelToolCalls,
    prefer_websockets: entry.preferWebsockets,
    supports_image_detail_original: entry.supportsImageDetailOriginal,
  };
}

/** Accepts a raw query string with or without the leading `?`. */
function parseRawQuery(query: string): URLSearchParams {
  return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
}

function headerValue(headers: ManifestRequestHeaders, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const values = value.filter((candidate): candidate is string => typeof candidate === 'string');
      if (values.length > 0) return values.join(',');
    }
  }
  return null;
}
