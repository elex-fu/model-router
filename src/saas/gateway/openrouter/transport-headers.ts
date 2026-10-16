/**
 * F6 OpenRouter fixed request headers (plan §R8a, task #39).
 *
 * OpenRouter's API recommends two optional supplier-attribute headers on
 * every request: `HTTP-Referer` (the calling app's site, used for
 * openrouter.ai rankings) and `X-Title` (the calling app's name, shown on
 * leaderboards). They are non-authentication attribution headers only.
 *
 * This module reuses the R5b-4 fixed-request-header extension the generic
 * provider HTTP transport already mounts
 * (provider-http-transport.ts `resolveFixedRequestHeaders`): a pure
 * resolver keyed on the signed endpoint scope. Unlike the OpenCode Go
 * resolver (which adds `anthropic-version` only for the Anthropic-routed
 * native), OpenRouter's attribution headers apply to ALL of its requests —
 * the resolver keys only on the endpoint scope and ignores the protocol.
 *
 * The auth header shape is intentionally NOT changed here: the
 * deployment-owned `resolveAuthenticationHeader` policy keeps supplying
 * Authorization: Bearer for the platform-pool key. Only
 * protocol-mandated non-authentication headers belong in this layer; the
 * transport's allowlist enforces that (reserved header names are refused).
 */

import type { ProviderHttpFixedRequestHeadersResolver } from '../provider-http-transport.js';
import { OPENROUTER_ENDPOINT } from './catalog-identity.js';

/** Default app title reported to OpenRouter's attribution leaderboard. */
export const OPENROUTER_ATTRIBUTION_TITLE_DEFAULT = 'model-router';

export interface OpenRouterFixedRequestHeadersOptions {
  /**
   * The deployment's public site URL (`HTTP-Referer`). Omitted by default:
   * a fabricated referer would misattribute the traffic, so the header is
   * only sent when the operator provides a real one.
   */
  readonly referer?: string;
  /** App name (`X-Title`); defaults to OPENROUTER_ATTRIBUTION_TITLE_DEFAULT. */
  readonly title?: string;
}

function validHeaderValue(value: string): boolean {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 1_024) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Builds the OpenRouter fixed-request-header resolver. The returned resolver
 * adds the attribution headers for every request whose signed endpoint
 * scope is `openrouter-api`, regardless of provider protocol, and adds
 * nothing for any other provider.
 */
export function createOpenRouterFixedRequestHeaders(
  options: OpenRouterFixedRequestHeadersOptions = {},
): ProviderHttpFixedRequestHeadersResolver {
  const referer = options.referer?.trim() || undefined;
  const title = options.title?.trim() || OPENROUTER_ATTRIBUTION_TITLE_DEFAULT;
  if (referer !== undefined && !validHeaderValue(referer)) {
    throw new TypeError('openRouterFixedRequestHeaders referer must be a non-empty printable header value');
  }
  if (!validHeaderValue(title)) {
    throw new TypeError('openRouterFixedRequestHeaders title must be a non-empty printable header value');
  }
  const headers: Readonly<Record<string, string>> = Object.freeze({
    ...(referer === undefined ? {} : { 'http-referer': referer }),
    'x-title': title,
  });
  return (input) => (input.endpoint === OPENROUTER_ENDPOINT ? headers : null);
}
