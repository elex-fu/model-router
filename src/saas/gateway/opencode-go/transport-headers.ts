/**
 * R5b-4 OpenCode Go fixed request headers (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #24; closes
 * the R5b-2 gap 2 "anthropic-version header on the Anthropic-routed path").
 *
 * The generic provider HTTP transport sends only the fixed
 * accept/content-type pair plus one credential header. That is correct for
 * the Chat Completions and Responses natives, but the Anthropic Messages
 * native additionally requires `anthropic-version` (sub2api
 * gateway_anthropic_passthrough.go defaults it to `2023-06-01` when absent;
 * every Anthropic client in this repository sends the same value). This
 * module is the per-protocol fixed-header extension the transport mounts: a
 * pure resolver, keyed on the signed endpoint scope plus the signed
 * provider-side protocol from the prepared evidence, so no existing
 * provider's header behavior moves — only `opencode-go-zen` traffic routed
 * to the Anthropic native gains the header.
 *
 * The auth header shape is intentionally NOT changed here: OpenCode Go is an
 * OpenAI-format upstream (sub2api `GetOpenAIFormatBaseURL`), so the same
 * platform-pool key authenticates all three natives and the deployment-owned
 * `resolveAuthenticationHeader` policy (Authorization: Bearer for this
 * provider) keeps supplying it. Only protocol-mandated non-authentication
 * headers belong in this layer.
 */

import { OPENCODE_GO_ENDPOINT } from './catalog-identity.js';

/** Anthropic API version every repository client and validator pins. */
export const OPENCODE_GO_ANTHROPIC_VERSION = '2023-06-01';

/**
 * The fixed non-authentication headers the transport adds for OpenCode Go
 * traffic, keyed on the signed dispatch facts. Input shape mirrors
 * `ProviderHttpFixedRequestHeadersInput` (provider-http-transport.ts) so the
 * composition can mount this resolver directly.
 */
export function openCodeGoFixedRequestHeaders(input: {
  readonly endpoint?: string;
  readonly providerProtocol?: string;
}): Readonly<Record<string, string>> | null {
  if (input.endpoint !== OPENCODE_GO_ENDPOINT) return null;
  if (input.providerProtocol !== 'anthropic') return null;
  return Object.freeze({ 'anthropic-version': OPENCODE_GO_ANTHROPIC_VERSION });
}
