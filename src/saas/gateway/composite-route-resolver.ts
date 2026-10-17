import { BEDROCK_PROVIDER_ID } from './bedrock/catalog-identity.js';
import { CLAUDE_PROVIDER_ID } from './claude/catalog-identity.js';
import { MINIMAX_PROVIDER_ID, ZHIPU_PROVIDER_ID } from './cn-providers/catalog-identity.js';
import { CODEX_PROVIDER_ID } from './codex/catalog-identity.js';
import type { GatewayProtocol } from './contracts.js';
import { GEMINI_PROVIDER_ID } from './gemini/catalog-identity.js';
import { GROK_PROVIDER_ID } from './grok/catalog-identity.js';
import { OPENCODE_GO_PROVIDER_ID } from './opencode-go/catalog-identity.js';
import { OPENROUTER_PROVIDER_ID } from './openrouter/catalog-identity.js';
import { VERTEX_PROVIDER_ID } from './vertex/catalog-identity.js';

/**
 * Composite model routing (roadmap batch 4 §4.4, task #18; sub2api reference:
 * backend/internal/service/composite_model_route.go +
 * composite_route_resolver.go + composite_platform.go, and
 * docs/COMPOSITE_GROUPS.md).
 *
 * A composite billing group exposes ONE customer-facing key surface whose
 * requested public model is resolved to a concrete provider platform per
 * request — the admin route registry first, then the group accounts' model
 * catalog ownership, then a built-in model-prefix detector. Unknown models
 * fail closed with a client error; the resolver never guesses a platform
 * (sub2api DetectModelPlatform's ambiguity contract).
 *
 * This module is deliberately pure: callers own every database read (the
 * control-plane CRUD store and the PostgreSQL scheduler wrapper load the
 * enabled routes and the account ownership catalog, then hand the facts to
 * `resolveCompositeRoute`). The decision object is the single source of truth
 * threaded explicitly through preparation — the sub2api ctxkey pattern
 * (ResolvedTargetPlatform / ResolvedUpstreamModel / RequestedPublicModel /
 * CompositeRouteSource) collapsed into one value; no implicit globals.
 */

export type CompositeRouteMatchType = 'exact' | 'prefix';

/**
 * The client-side endpoint family of a composite route. `any` matches every
 * inbound protocol; the others pin the route to one client endpoint family
 * (mapped from the inbound GatewayProtocol by
 * `compositeRouteEndpointFromProtocol`).
 */
export type CompositeRouteEndpoint = 'any' | 'messages' | 'responses' | 'chat_completions' | 'gemini';

export type CompositeRouteSource = 'route' | 'account_model' | 'detector';

const ENDPOINTS: ReadonlySet<CompositeRouteEndpoint> = new Set([
  'any',
  'messages',
  'responses',
  'chat_completions',
  'gemini',
]);

/**
 * The concrete provider platforms a composite route may target: the gateway's
 * provider ids (the catalog `*_PROVIDER_ID` constants), plus the two
 * sub2api-detected platforms whose native adapters land in later batches
 * (`deepseek`, `kimi`) so the detector vocabulary stays complete. Scheduling
 * narrows candidates by `candidate.providerId` equality, so every value here
 * is exactly a provider id.
 */
export const COMPOSITE_TARGET_PLATFORMS: readonly string[] = Object.freeze([
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  VERTEX_PROVIDER_ID,
  BEDROCK_PROVIDER_ID,
  GROK_PROVIDER_ID,
  ZHIPU_PROVIDER_ID,
  MINIMAX_PROVIDER_ID,
  OPENCODE_GO_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  'deepseek',
  'kimi',
]);

const TARGET_PLATFORMS: ReadonlySet<string> = new Set(COMPOSITE_TARGET_PLATFORMS);

/** True when `platform` is one of the concrete provider ids composite can target. */
export function isConcreteCompositeTargetPlatform(platform: string): boolean {
  return TARGET_PLATFORMS.has(platform);
}

/** One admin-configured composite model route (migration 121 row). */
export interface CompositeModelRoute {
  /** The persisted route identity; the deterministic final tie-break. */
  readonly id: string;
  readonly groupId: string;
  /** Model identifier the client sends (exact text or prefix pattern). */
  readonly publicModel: string;
  readonly matchType: CompositeRouteMatchType;
  readonly targetPlatform: string;
  /** Model sent upstream; empty means passthrough of the requested model. */
  readonly upstreamModel: string;
  readonly endpoint: CompositeRouteEndpoint;
  /** Lower wins after match specificity (sub2api: lower values win). */
  readonly priority: number;
  readonly enabled: boolean;
  readonly notes: string;
}

/**
 * The Level-2 account-ownership fact: which concrete platform's accounts in
 * the group's pool expose the requested model in their capability catalog.
 * `unavailable` is a transient catalog read failure — the resolver then
 * degrades to the Level-3 detector only when the model is detectable.
 */
export type CompositeModelOwnershipResolution =
  | { readonly outcome: 'matched'; readonly targetPlatform: string }
  | { readonly outcome: 'not-matched' }
  | { readonly outcome: 'ambiguous' }
  | { readonly outcome: 'unavailable' };

/** The resolution decision threaded explicitly through request preparation. */
export interface CompositeRouteDecision {
  /** False means fail-closed: the caller must return a client error. */
  readonly matched: boolean;
  readonly source: CompositeRouteSource | null;
  readonly groupId: string;
  readonly publicModel: string;
  readonly targetPlatform: string;
  readonly upstreamModel: string;
  readonly endpoint: CompositeRouteEndpoint;
  /** The matched Level-1 route identity; null for account/detector levels. */
  readonly routeId: string | null;
  /** Human-readable fail-closed cause; empty on a matched decision. */
  readonly reason: string;
}

export interface ResolveCompositeRouteInput {
  readonly groupId: string;
  readonly model: string;
  readonly endpoint: string;
  /** Enabled routes of this group (the caller loaded them). */
  readonly routes: readonly CompositeModelRoute[];
  /** Level-2 account-model ownership; null skips the level entirely. */
  readonly ownership: CompositeModelOwnershipResolution | null;
}

/** Normalizes any endpoint spelling to the route vocabulary; unknown → `any`. */
export function normalizeCompositeRouteEndpoint(endpoint: string): CompositeRouteEndpoint {
  const value = endpoint.trim().toLowerCase();
  return ENDPOINTS.has(value as CompositeRouteEndpoint) ? (value as CompositeRouteEndpoint) : 'any';
}

/** Normalizes any match-type spelling; anything but `prefix` is `exact`. */
export function normalizeCompositeRouteMatchType(matchType: string): CompositeRouteMatchType {
  return matchType.trim().toLowerCase() === 'prefix' ? 'prefix' : 'exact';
}

/** Maps the inbound client protocol onto the composite route endpoint family. */
export function compositeRouteEndpointFromProtocol(protocol: GatewayProtocol): Exclude<CompositeRouteEndpoint, 'any'> {
  switch (protocol) {
    case 'anthropic':
      return 'messages';
    case 'responses':
      return 'responses';
    case 'openai':
      return 'chat_completions';
    case 'gemini':
      return 'gemini';
  }
}

/**
 * The built-in Level-3 model-prefix detector (sub2api DetectModelPlatform
 * port, retargeted to the gateway's provider ids). It intentionally returns
 * null for unrecognized names so composite groups fail closed instead of
 * guessing. Prefix-provider spellings (`anthropic/claude-...`,
 * `google/gemini-...`) resolve through the provider segment first.
 */
export function detectCompositeModelPlatform(model: string): string | null {
  let normalized = model.trim().toLowerCase();
  if (normalized === '') return null;

  normalized = normalized.replace(/^models\//, '');
  const slash = normalized.indexOf('/');
  if (slash > 0) {
    const provider = normalized.slice(0, slash).trim();
    const rest = normalized.slice(slash + 1).trim();
    switch (provider) {
      case 'anthropic':
      case 'claude':
        return CLAUDE_PROVIDER_ID;
      case 'openai':
      case 'chatgpt':
        return CODEX_PROVIDER_ID;
      case 'google':
      case 'google-ai-studio':
      case 'gemini':
        return GEMINI_PROVIDER_ID;
      case 'xai':
      case 'x-ai':
      case 'grok':
        return GROK_PROVIDER_ID;
      case 'kimi':
      case 'moonshot':
        return 'kimi';
      case 'zhipu':
      case 'glm':
      case 'bigmodel':
        return ZHIPU_PROVIDER_ID;
      case 'deepseek':
        return 'deepseek';
      case 'minimax':
        return MINIMAX_PROVIDER_ID;
    }
    if (rest !== '') normalized = rest.replace(/^models\//, '');
  }

  if (normalized.startsWith('anthropic.claude-') || normalized.startsWith('claude-')) {
    return CLAUDE_PROVIDER_ID;
  }
  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('chatgpt-') ||
    normalized.startsWith('codex-') ||
    normalized.startsWith('text-embedding-') ||
    normalized.startsWith('text-moderation-') ||
    normalized.startsWith('omni-moderation-') ||
    normalized.startsWith('dall-e-') ||
    normalized.startsWith('gpt-image-') ||
    normalized.startsWith('tts-') ||
    normalized.startsWith('whisper-') ||
    isOpenAiSeriesModel(normalized)
  ) {
    return CODEX_PROVIDER_ID;
  }
  if (normalized.startsWith('gemini-') || normalized.startsWith('learnlm-')) {
    return GEMINI_PROVIDER_ID;
  }
  if (normalized === 'grok' || normalized.startsWith('grok-')) {
    return GROK_PROVIDER_ID;
  }
  if (
    normalized === 'k3' ||
    normalized === 'k3-256k' ||
    normalized.startsWith('kimi-') ||
    normalized.startsWith('moonshot-')
  ) {
    return 'kimi';
  }
  if (normalized.startsWith('glm-')) {
    return ZHIPU_PROVIDER_ID;
  }
  if (normalized.startsWith('deepseek-')) {
    return 'deepseek';
  }
  if (
    normalized.startsWith('minimax-') ||
    normalized.startsWith('abab5') ||
    normalized.startsWith('abab6') ||
    normalized.startsWith('abab7')
  ) {
    return MINIMAX_PROVIDER_ID;
  }
  return null;
}

function isOpenAiSeriesModel(model: string): boolean {
  for (const prefix of ['o1', 'o3', 'o4', 'o5']) {
    if (model === prefix || model.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

interface RouteCandidate {
  readonly route: CompositeModelRoute;
  readonly matchStrength: number;
  readonly endpointWeight: number;
  readonly prefixLength: number;
}

/**
 * Level 1: picks the winning explicit route among every enabled route whose
 * pattern matches, using the five-key sort (sub2api matchCompositeRoute):
 *   1. exact (strength 2) beats prefix (strength 1);
 *   2. an endpoint-specific route beats `any`;
 *   3. a longer pattern (prefix length) wins;
 *   4. a lower priority value wins;
 *   5. a lower route id wins (deterministic final tie-break).
 * Returns null when no route matches.
 */
export function matchCompositeRoute(
  routes: readonly CompositeModelRoute[],
  model: string,
  endpoint: CompositeRouteEndpoint,
): CompositeModelRoute | null {
  const candidates: RouteCandidate[] = [];
  for (const route of routes) {
    if (!isCompositeRoute(route)) continue;
    const routeEndpoint = normalizeCompositeRouteEndpoint(route.endpoint);
    if (routeEndpoint !== 'any' && routeEndpoint !== endpoint) continue;
    const pattern = route.publicModel.trim();
    if (pattern === '') continue;

    let matchStrength: number;
    const matchType = normalizeCompositeRouteMatchType(route.matchType);
    if (matchType === 'exact') {
      if (pattern !== model) continue;
      matchStrength = 2;
    } else {
      if (!model.startsWith(pattern)) continue;
      matchStrength = 1;
    }
    candidates.push({
      route,
      matchStrength,
      endpointWeight: routeEndpoint === endpoint ? 1 : 0,
      prefixLength: pattern.length,
    });
  }
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (
      candidate.matchStrength > best.matchStrength ||
      (candidate.matchStrength === best.matchStrength &&
        (candidate.endpointWeight > best.endpointWeight ||
          (candidate.endpointWeight === best.endpointWeight &&
            (candidate.prefixLength > best.prefixLength ||
              (candidate.prefixLength === best.prefixLength &&
                (candidate.route.priority < best.route.priority ||
                  (candidate.route.priority === best.route.priority &&
                    routeIdLessThan(candidate.route.id, best.route.id))))))))
    ) {
      best = candidate;
    }
  }
  return best.route;
}

/** Exact decimal/bigint id compare; malformed ids never win (string compare). */
function routeIdLessThan(a: string, b: string): boolean {
  if (/^(0|[1-9][0-9]*)$/.test(a) && /^(0|[1-9][0-9]*)$/.test(b)) return BigInt(a) < BigInt(b);
  return a < b;
}

function isCompositeRoute(value: unknown): value is CompositeModelRoute {
  if (value === null || typeof value !== 'object') return false;
  const route = value as Record<string, unknown>;
  return (
    typeof route.id === 'string' &&
    typeof route.groupId === 'string' &&
    typeof route.publicModel === 'string' &&
    typeof route.targetPlatform === 'string' &&
    typeof route.priority === 'number' &&
    Number.isSafeInteger(route.priority) &&
    route.enabled === true
  );
}

/**
 * The three-level composite resolution (sub2api CompositeRouteResolver.Resolve
 * port, as one pure function):
 *
 *   Level 1 — explicit admin route (five-key sort above). An empty
 *   upstream_model passes the requested model through unchanged.
 *
 *   Level 2 — account model ownership: the group's accounts expose the model
 *   on exactly one concrete platform. An ambiguous model (multiple platforms)
 *   fails closed — the caller returns a client error. An unavailable catalog
 *   degrades to Level 3 only when the detector recognizes the model; an
 *   unrecognized model then fails closed instead of guessing.
 *
 *   Level 3 — the built-in prefix detector (passthrough upstream model).
 *
 * `matched: false` is always fail-closed: the caller must reject the request
 * with a client error and never dispatch a guess.
 */
export function resolveCompositeRoute(input: ResolveCompositeRouteInput): CompositeRouteDecision {
  const model = input.model.trim();
  const endpoint = normalizeCompositeRouteEndpoint(input.endpoint);
  const decision = (matched: boolean, reason: string): CompositeRouteDecision => ({
    matched,
    source: null,
    groupId: input.groupId,
    publicModel: model,
    targetPlatform: '',
    upstreamModel: '',
    endpoint,
    routeId: null,
    reason,
  });

  if (model === '') return decision(false, 'model is required');

  if (input.routes.length > 0) {
    const route = matchCompositeRoute(input.routes, model, endpoint);
    if (route !== null) {
      const upstreamModel = route.upstreamModel.trim() !== '' ? route.upstreamModel.trim() : model;
      return {
        matched: true,
        source: 'route',
        groupId: input.groupId,
        publicModel: model,
        targetPlatform: route.targetPlatform,
        upstreamModel,
        endpoint,
        routeId: route.id,
        reason: '',
      };
    }
  }

  if (input.ownership !== null) {
    if (input.ownership.outcome === 'ambiguous') {
      return decision(false, 'model is exposed by multiple provider platforms');
    }
    if (input.ownership.outcome === 'matched') {
      const platform = input.ownership.targetPlatform.trim();
      if (!isConcreteCompositeTargetPlatform(platform)) {
        return decision(false, 'account model ownership has no concrete target platform');
      }
      return {
        matched: true,
        source: 'account_model',
        groupId: input.groupId,
        publicModel: model,
        targetPlatform: platform,
        upstreamModel: model,
        endpoint,
        routeId: null,
        reason: '',
      };
    }
    if (input.ownership.outcome === 'unavailable' && detectCompositeModelPlatform(model) === null) {
      return decision(false, 'account model ownership is unavailable for an unrecognized model');
    }
  }

  const detected = detectCompositeModelPlatform(model);
  if (detected !== null) {
    return {
      matched: true,
      source: 'detector',
      groupId: input.groupId,
      publicModel: model,
      targetPlatform: detected,
      upstreamModel: model,
      endpoint,
      routeId: null,
      reason: '',
    };
  }
  return decision(false, 'no explicit route or built-in detector match');
}

/**
 * The model provenance for a matched composite decision: the requested public
 * model → upstream model rewrite as an explicit alias mapping, satisfying the
 * payload compiler's provenance enforcement (a rewritten `model` must carry
 * `mappingSource`/`mappingVersion`; a passthrough decision returns null and
 * keeps the compiler's neutral identity shape).
 */
export function compositeRouteModelResolutionSource(decision: CompositeRouteDecision): {
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly resolvedModel: string;
  readonly mappingSource: 'alias';
  readonly mappingVersion: number | null;
} | null {
  if (!decision.matched || decision.upstreamModel === decision.publicModel) return null;
  // Route-sourced rewrites carry the route id as the mapping version when it
  // fits a safe integer; account/detector decisions never rewrite, so an
  // unsafe id keeps version null while the alias source still names the
  // mapping explicitly (the compiler checks source, never the version).
  const routeId = decision.routeId;
  const version = routeId !== null && /^(0|[1-9][0-9]*)$/.test(routeId) ? Number(routeId) : null;
  return {
    requestedModel: decision.publicModel,
    mappedModel: decision.upstreamModel,
    resolvedModel: decision.upstreamModel,
    mappingSource: 'alias',
    mappingVersion: version !== null && Number.isSafeInteger(version) && version > 0 ? version : null,
  };
}
