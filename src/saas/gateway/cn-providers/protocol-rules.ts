/**
 * Batch 3 CN-provider adaptive protocol routing (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三; sub2api reference:
 * backend/internal/service/account.go GetAPIProtocol / UsesNativeCNResponses /
 * GetCNProtocolBaseURL). Pure functions only — no transports, no DB access.
 *
 * One CN-provider API key serves up to three native upstream endpoints
 * (Chat Completions / Anthropic Messages / — MiniMax only — native
 * Responses). The per-account `api_protocol` decides which native protocol a
 * request uses:
 *
 * - `chat_completions`: every request compiles onto the provider's Chat
 *   Completions native (cross-protocol clients bridge through the generic
 *   compiler; an unsupported bridge pair fails closed there);
 * - `anthropic`: every request compiles onto the provider's Anthropic
 *   Messages native;
 * - `responses`: honored only for providers with a native Responses endpoint
 *   (MiniMax). Zhipu has none, so the value falls back to chat_completions
 *   (the sub2api GetAPIProtocol zhipu matrix row);
 * - `adaptive` (the default): the native protocol follows the inbound client
 *   protocol — a /v1/messages client rides the provider's Anthropic-compatible
 *   endpoint, a /v1/chat/completions client the Chat Completions endpoint, a
 *   /v1/responses client MiniMax's native Responses endpoint (zhipu: bridges
 *   onto Chat Completions).
 *
 * The native protocol is re-derived per request AFTER modelMap resolution and
 * BEFORE endpoint signing, exactly like the opencode-go R5b-2 rule table: the
 * authority decorator and the payload-compile wrapper in
 * src/server/managed-saas-gateway.ts rewrite the route's
 * providerProtocol/providerOperation pair, and the deployment's
 * provider-target bindings select the URL from that pair.
 */

import type { GatewayProtocol } from '../contracts.js';
import { MINIMAX_PROVIDER_ID, ZHIPU_PROVIDER_ID } from './catalog-identity.js';
import type { CnProviderApiProtocol } from './constants.js';

/** The native protocols a CN-provider upstream can serve. */
export type CnNativeProtocol = Extract<GatewayProtocol, 'openai' | 'anthropic' | 'responses'>;

/** Canonical provider operation for each native protocol (compiler vocabulary). */
export function cnProviderOperationForProtocol(
  protocol: CnNativeProtocol,
): 'chat.completions' | 'messages' | 'responses' {
  if (protocol === 'responses') return 'responses';
  if (protocol === 'anthropic') return 'messages';
  return 'chat.completions';
}

/** True when the provider exposes a native Responses endpoint (sub2api SupportsNativeCNResponses). */
export function cnProviderSupportsNativeResponses(providerId: string): boolean {
  return providerId === MINIMAX_PROVIDER_ID;
}

function isCnApiProtocol(value: unknown): value is CnProviderApiProtocol {
  return value === 'chat_completions' || value === 'anthropic' || value === 'responses' || value === 'adaptive';
}

export type CnProviderApiProtocolValidation =
  | { readonly valid: true; readonly apiProtocol: CnProviderApiProtocol }
  | { readonly valid: false; readonly reason: string };

/**
 * Strict validation for admin/config paths (sub2api GetAPIProtocol matrix):
 * unknown or missing values resolve to the provider default rather than
 * failing, EXCEPT nothing here mutates storage — callers persist the raw
 * column value and re-validate on read. `responses` is downgraded to the
 * default for providers without a native Responses endpoint (zhipu), the
 * sub2api behavior.
 */
export function normalizeCnProviderApiProtocol(providerId: string, value: unknown): CnProviderApiProtocol {
  if (!isCnApiProtocol(value)) return 'adaptive';
  if (value === 'responses' && !cnProviderSupportsNativeResponses(providerId)) {
    return 'adaptive';
  }
  return value;
}

/**
 * Resolves the native protocol for one request (the adaptive 分流 kernel).
 * Returns null when the client protocol has no servable native route for
 * this provider — the caller must fail closed (capability_unsupported),
 * never guess: a gemini client has no CN-provider native endpoint and the
 * generic compiler has no gemini→openai bridge.
 */
export function resolveCnNativeProtocol(input: {
  readonly providerId: string;
  readonly apiProtocol: CnProviderApiProtocol;
  readonly clientProtocol: GatewayProtocol;
}): CnNativeProtocol | null {
  const { providerId, clientProtocol } = input;
  const apiProtocol = normalizeCnProviderApiProtocol(providerId, input.apiProtocol);

  if (apiProtocol === 'chat_completions' || apiProtocol === 'anthropic') {
    // Pinned native: every client protocol compiles onto the pinned native.
    return apiProtocol === 'anthropic' ? 'anthropic' : 'openai';
  }
  if (apiProtocol === 'responses') {
    return 'responses';
  }
  // Adaptive: the native protocol follows the inbound client protocol.
  if (clientProtocol === 'anthropic') return 'anthropic';
  if (clientProtocol === 'openai') return 'openai';
  if (clientProtocol === 'responses') {
    return cnProviderSupportsNativeResponses(providerId) ? 'responses' : 'openai';
  }
  return null;
}

/** The routing decision the gateway decorators persist into the signed route. */
export interface CnProviderRouteOverride {
  readonly providerProtocol: CnNativeProtocol;
  readonly providerOperation: 'chat.completions' | 'messages' | 'responses';
}

/**
 * Derives the route override for one candidate; null means "not a
 * CN-provider candidate" (the route passes through untouched) — the sentinel
 * for fail-closed native resolution is the `{ blocked: true }` branch so
 * callers can distinguish the two.
 */
export function cnProviderRouteOverride(input: {
  readonly providerId: string;
  readonly apiProtocol: CnProviderApiProtocol;
  readonly clientProtocol: GatewayProtocol;
}): CnProviderRouteOverride | { readonly blocked: true } | null {
  if (input.providerId !== ZHIPU_PROVIDER_ID && input.providerId !== MINIMAX_PROVIDER_ID) return null;
  const native = resolveCnNativeProtocol(input);
  if (native === null) return { blocked: true };
  return {
    providerProtocol: native,
    providerOperation: cnProviderOperationForProtocol(native),
  };
}

export type CnProvidersProtocolRoutingConfig = {
  /**
   * Default api_protocol per provider id. Keys outside the CN-provider pair
   * are ignored; a missing key uses the adaptive default.
   */
  readonly apiProtocol?: Readonly<Partial<Record<string, CnProviderApiProtocol>>>;
  /**
   * Lenient config loader input (the migration-120 account columns read
   * through the runtime module, or the sub2api credentials-map wrapper
   * carrying `api_protocol`). Invalid values fall back to adaptive.
   */
  readonly config?: unknown;
};

/**
 * Lenient single-provider loader (the opencode-go
 * resolveOpenCodeGoProtocolRulesFromConfig shape): accepts the raw string
 * column value, a wrapper record carrying `api_protocol` (the sub2api
 * credentials-map spelling), or a per-provider map keyed by provider id.
 * Absent or malformed values resolve null so the caller falls back to the
 * adaptive default; a present value is normalized through the provider
 * matrix (zhipu `responses` → adaptive).
 */
function resolveApiProtocolFromConfig(providerId: string, config: unknown): CnProviderApiProtocol | null {
  if (config === null || config === undefined) return null;
  if (typeof config === 'string') {
    return isCnApiProtocol(config) ? normalizeCnProviderApiProtocol(providerId, config) : null;
  }
  if (typeof config !== 'object' || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  const raw = Object.hasOwn(record, 'api_protocol')
    ? record.api_protocol
    : Object.hasOwn(record, providerId)
      ? record[providerId]
      : null;
  if (typeof raw !== 'string') return null;
  return isCnApiProtocol(raw) ? normalizeCnProviderApiProtocol(providerId, raw) : null;
}

/**
 * Composition-level routing resolution (the opencode-go
 * resolveOpenCodeGoProtocolRules shape): explicit per-provider api_protocol
 * map first, then the lenient config value, then the adaptive default.
 */
export function resolveCnProviderApiProtocol(
  routing: CnProvidersProtocolRoutingConfig | undefined,
  providerId: string,
): CnProviderApiProtocol {
  if (routing?.apiProtocol !== undefined) {
    const explicit = routing.apiProtocol[providerId];
    if (isCnApiProtocol(explicit)) return normalizeCnProviderApiProtocol(providerId, explicit);
  }
  const fromConfig = resolveApiProtocolFromConfig(providerId, routing?.config);
  if (fromConfig !== null) return fromConfig;
  return 'adaptive';
}
