/**
 * Built-in provider bundle registry (core-plan §6.2,
 * docs/core-capability-alignment-technical-plan-2026-10-18.md).
 *
 * The v2 runtime module contract accepts `extensions.providerBundles` as a
 * declarative selection: `{bundle, enabled, parameters?, secretReferences?}`.
 * This registry is the core-owned source of truth for the bundle ids a
 * standard deployment may select and for the assembly faces each bundle
 * requires. An extension never names a provider, endpoint, protocol or
 * transport directly; it selects a known bundle and the core owns the rest.
 *
 * Every identity below is imported from the provider package's
 * `catalog-identity.ts` — the same constants the catalog registration,
 * credential sink, probes and dispatch split already use — so the registry
 * cannot drift from the implemented categories (G-C1 "single source").
 *
 * `dispatch` describes which core transport face the bundle must have before
 * it may be reported as assembled:
 * - `generic`: the shared provider HTTP transport is sufficient (the bundle
 *   still registers its own headers/transform in the existing pipeline);
 * - every other kind needs a dedicated prepared-evidence transport mounted
 *   for each declared endpoint scope. A selected bundle that would silently
 *   fall back to the generic path is a configuration error (§6.2: Grok and
 *   CN providers must not ride the wrong generic fallback).
 */

import {
  BEDROCK_CREDENTIAL_TYPE,
  BEDROCK_DISPLAY_NAME,
  BEDROCK_ENDPOINT,
  BEDROCK_PRODUCT_ID,
  BEDROCK_PROTOCOL,
  BEDROCK_PROVIDER_ID,
} from '../gateway/bedrock/catalog-identity.js';
import {
  CLAUDE_CREDENTIAL_TYPE,
  CLAUDE_DISPLAY_NAME,
  CLAUDE_ENDPOINT,
  CLAUDE_PRODUCT_ID,
  CLAUDE_PROTOCOL,
  CLAUDE_PROVIDER_ID,
} from '../gateway/claude/catalog-identity.js';
import {
  MINIMAX_CREDENTIAL_TYPE,
  MINIMAX_DISPLAY_NAME,
  MINIMAX_ENDPOINT,
  MINIMAX_PRODUCT_ID,
  MINIMAX_PROVIDER_ID,
  ZHIPU_CODING_ENDPOINT,
  ZHIPU_CODING_PRODUCT_ID,
  ZHIPU_CREDENTIAL_TYPE,
  ZHIPU_DISPLAY_NAME,
  ZHIPU_ENDPOINT,
  ZHIPU_PRODUCT_ID,
  ZHIPU_PROVIDER_ID,
} from '../gateway/cn-providers/catalog-identity.js';
import {
  CODEX_CREDENTIAL_TYPE,
  CODEX_DISPLAY_NAME,
  CODEX_ENDPOINT,
  CODEX_PRODUCT_ID,
  CODEX_PROTOCOL,
  CODEX_PROVIDER_ID,
} from '../gateway/codex/catalog-identity.js';
import type { GatewayProtocol } from '../gateway/contracts.js';
import {
  GEMINI_CREDENTIAL_TYPE,
  GEMINI_DISPLAY_NAME,
  GEMINI_ENDPOINT,
  GEMINI_PRODUCT_ID,
  GEMINI_PROTOCOL,
  GEMINI_PROVIDER_ID,
} from '../gateway/gemini/catalog-identity.js';
import {
  GROK_API_KEY_PRODUCT_ID,
  GROK_CREDENTIAL_TYPE_API_KEY,
  GROK_CREDENTIAL_TYPE_OAUTH,
  GROK_DISPLAY_NAME,
  GROK_ENDPOINT,
  GROK_OAUTH_PRODUCT_ID,
  GROK_PROTOCOL,
  GROK_PROVIDER_ID,
} from '../gateway/grok/catalog-identity.js';
import {
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_ENDPOINT,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROVIDER_ID,
} from '../gateway/opencode-go/catalog-identity.js';
import {
  OPENROUTER_CAPABILITY_PROTOCOL,
  OPENROUTER_CREDENTIAL_TYPE,
  OPENROUTER_DISPLAY_NAME,
  OPENROUTER_ENDPOINT,
  OPENROUTER_PRODUCT_ID,
  OPENROUTER_PROVIDER_ID,
} from '../gateway/openrouter/catalog-identity.js';
import {
  VERTEX_ANTHROPIC_PROTOCOL,
  VERTEX_CREDENTIAL_TYPE,
  VERTEX_DISPLAY_NAME,
  VERTEX_ENDPOINT,
  VERTEX_GEMINI_PROTOCOL,
  VERTEX_PRODUCT_ID,
  VERTEX_PROVIDER_ID,
} from '../gateway/vertex/catalog-identity.js';

/**
 * The core transport face a bundle needs. `generic` rides the shared
 * provider HTTP transport; every other value names the dedicated
 * prepared-evidence transport the assembly must mount.
 */
export type ProviderBundleDispatchKind =
  | 'generic'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'cn-providers'
  | 'opencode-go'
  | 'bedrock'
  | 'vertex';

export interface ProviderBundleManifest {
  /** Extension id (`ProviderBundleConfiguration.bundle`) — stable and equal to the provider id. */
  readonly bundle: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly productIds: readonly string[];
  readonly credentialTypes: readonly string[];
  readonly supplyMode: 'platform';
  readonly protocols: readonly GatewayProtocol[];
  /** Catalog endpoint scopes; also the signed dispatch split keys. */
  readonly endpointScopes: readonly string[];
  readonly dispatch: ProviderBundleDispatchKind;
}

function defineBundle(input: ProviderBundleManifest): ProviderBundleManifest {
  return Object.freeze({
    ...input,
    productIds: Object.freeze([...input.productIds]),
    credentialTypes: Object.freeze([...input.credentialTypes]),
    protocols: Object.freeze([...input.protocols]),
    endpointScopes: Object.freeze([...input.endpointScopes]),
  });
}

/**
 * The standard-deployment catalogue. Additions follow the provider package
 * contract: a bundle becomes selectable only after its transport, credential
 * sink/catalog registration and readiness facts exist (T02), so an operator
 * never sees a selectable bundle whose dispatch would fall back silently.
 */
export const PROVIDER_BUNDLE_MANIFESTS: readonly ProviderBundleManifest[] = Object.freeze([
  defineBundle({
    bundle: 'kimi',
    providerId: 'kimi',
    displayName: 'Kimi Code',
    productIds: ['kimi-code'],
    credentialTypes: ['api-key'],
    supplyMode: 'platform',
    protocols: ['anthropic'],
    endpointScopes: ['messages'],
    dispatch: 'generic',
  }),
  defineBundle({
    bundle: CLAUDE_PROVIDER_ID,
    providerId: CLAUDE_PROVIDER_ID,
    displayName: CLAUDE_DISPLAY_NAME,
    productIds: [CLAUDE_PRODUCT_ID],
    credentialTypes: [CLAUDE_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: [CLAUDE_PROTOCOL],
    endpointScopes: [CLAUDE_ENDPOINT],
    dispatch: 'claude',
  }),
  defineBundle({
    bundle: CODEX_PROVIDER_ID,
    providerId: CODEX_PROVIDER_ID,
    displayName: CODEX_DISPLAY_NAME,
    productIds: [CODEX_PRODUCT_ID],
    credentialTypes: [CODEX_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: [CODEX_PROTOCOL],
    endpointScopes: [CODEX_ENDPOINT],
    dispatch: 'codex',
  }),
  defineBundle({
    bundle: GEMINI_PROVIDER_ID,
    providerId: GEMINI_PROVIDER_ID,
    displayName: GEMINI_DISPLAY_NAME,
    productIds: [GEMINI_PRODUCT_ID],
    credentialTypes: [GEMINI_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: [GEMINI_PROTOCOL],
    endpointScopes: [GEMINI_ENDPOINT],
    dispatch: 'gemini',
  }),
  defineBundle({
    bundle: GROK_PROVIDER_ID,
    providerId: GROK_PROVIDER_ID,
    displayName: GROK_DISPLAY_NAME,
    productIds: [GROK_OAUTH_PRODUCT_ID, GROK_API_KEY_PRODUCT_ID],
    credentialTypes: [GROK_CREDENTIAL_TYPE_OAUTH, GROK_CREDENTIAL_TYPE_API_KEY],
    supplyMode: 'platform',
    protocols: [GROK_PROTOCOL],
    endpointScopes: [GROK_ENDPOINT],
    dispatch: 'grok',
  }),
  defineBundle({
    bundle: ZHIPU_PROVIDER_ID,
    providerId: ZHIPU_PROVIDER_ID,
    displayName: ZHIPU_DISPLAY_NAME,
    // Two products because the Coding Plan host differs from the payg host.
    productIds: [ZHIPU_PRODUCT_ID, ZHIPU_CODING_PRODUCT_ID],
    credentialTypes: [ZHIPU_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: ['openai', 'anthropic'],
    endpointScopes: [ZHIPU_ENDPOINT, ZHIPU_CODING_ENDPOINT],
    dispatch: 'cn-providers',
  }),
  defineBundle({
    bundle: MINIMAX_PROVIDER_ID,
    providerId: MINIMAX_PROVIDER_ID,
    displayName: MINIMAX_DISPLAY_NAME,
    productIds: [MINIMAX_PRODUCT_ID],
    credentialTypes: [MINIMAX_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: ['openai', 'anthropic'],
    endpointScopes: [MINIMAX_ENDPOINT],
    dispatch: 'cn-providers',
  }),
  defineBundle({
    bundle: OPENCODE_GO_PROVIDER_ID,
    providerId: OPENCODE_GO_PROVIDER_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    productIds: [OPENCODE_GO_PRODUCT_ID],
    credentialTypes: [OPENCODE_GO_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    // The native protocol is re-derived per model (protocol-rules.ts), so a
    // single bundle serves all three provider protocols.
    protocols: ['responses', 'openai', 'anthropic'],
    endpointScopes: [OPENCODE_GO_ENDPOINT],
    dispatch: 'opencode-go',
  }),
  defineBundle({
    bundle: OPENROUTER_PROVIDER_ID,
    providerId: OPENROUTER_PROVIDER_ID,
    displayName: OPENROUTER_DISPLAY_NAME,
    productIds: [OPENROUTER_PRODUCT_ID],
    credentialTypes: [OPENROUTER_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: [OPENROUTER_CAPABILITY_PROTOCOL],
    endpointScopes: [OPENROUTER_ENDPOINT],
    dispatch: 'generic',
  }),
  defineBundle({
    bundle: BEDROCK_PROVIDER_ID,
    providerId: BEDROCK_PROVIDER_ID,
    displayName: BEDROCK_DISPLAY_NAME,
    productIds: [BEDROCK_PRODUCT_ID],
    // The alternate `api-key` envelope is transport-supported but has no
    // catalog rights registration yet (see catalog-identity), so it is not
    // advertised by the selectable manifest.
    credentialTypes: [BEDROCK_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: [BEDROCK_PROTOCOL],
    endpointScopes: [BEDROCK_ENDPOINT],
    dispatch: 'bedrock',
  }),
  defineBundle({
    bundle: VERTEX_PROVIDER_ID,
    providerId: VERTEX_PROVIDER_ID,
    displayName: VERTEX_DISPLAY_NAME,
    productIds: [VERTEX_PRODUCT_ID],
    credentialTypes: [VERTEX_CREDENTIAL_TYPE],
    supplyMode: 'platform',
    protocols: [VERTEX_ANTHROPIC_PROTOCOL, VERTEX_GEMINI_PROTOCOL],
    endpointScopes: [VERTEX_ENDPOINT],
    dispatch: 'vertex',
  }),
]);

const BUNDLE_BY_ID: ReadonlyMap<string, ProviderBundleManifest> = new Map(
  PROVIDER_BUNDLE_MANIFESTS.map((manifest) => [manifest.bundle, manifest]),
);

/** Stable selectable bundle ids, in registry order (doctor/admin projections). */
export const PROVIDER_BUNDLE_IDS: readonly string[] = Object.freeze(
  PROVIDER_BUNDLE_MANIFESTS.map((manifest) => manifest.bundle),
);

export function providerBundleManifest(bundle: string): ProviderBundleManifest | undefined {
  return typeof bundle === 'string' ? BUNDLE_BY_ID.get(bundle) : undefined;
}

export function isBuiltinProviderBundleId(bundle: string): boolean {
  return providerBundleManifest(bundle) !== undefined;
}
