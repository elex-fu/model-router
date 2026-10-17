/**
 * Batch 3 CN-provider fixed request headers (the opencode-go
 * transport-headers.ts precedent): the generic provider HTTP transport adds
 * the Anthropic Messages native's protocol-mandated `anthropic-version`
 * header for CN-provider traffic routed to the Anthropic endpoint. Pure
 * resolver keyed on the signed endpoint scope plus the signed provider-side
 * protocol, so no existing provider's header behavior moves — only
 * zhipu/minimax traffic routed to the Anthropic native gains the header.
 *
 * The auth header shape is intentionally NOT changed here: CN providers are
 * OpenAI-format API-key upstreams (Bearer on Chat Completions/Responses; the
 * deployment-owned `resolveAuthenticationHeader` policy keeps supplying it),
 * and the zhipu quota monitor's no-Bearer quirk lives only in the quota
 * worker, never on the inference path.
 */

import { isCnProviderEndpoint } from './catalog-identity.js';
import { CN_ANTHROPIC_VERSION } from './constants.js';

/**
 * The fixed non-authentication headers the transport adds for CN-provider
 * traffic. Input shape mirrors `ProviderHttpFixedRequestHeadersInput`
 * (provider-http-transport.ts) so the composition can mount this resolver
 * directly.
 */
export function cnProvidersFixedRequestHeaders(input: {
  readonly endpoint?: string;
  readonly providerProtocol?: string;
}): Readonly<Record<string, string>> | null {
  if (!isCnProviderEndpoint(input?.endpoint)) return null;
  if (input.providerProtocol !== 'anthropic') return null;
  return Object.freeze({ 'anthropic-version': CN_ANTHROPIC_VERSION });
}
