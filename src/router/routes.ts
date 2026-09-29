import type { Protocol, ProxyKey, UpstreamConfig } from '../config/types.js';
import type { RouteDefinition } from '../config/v2-schema.js';
import { matchGlob } from '../protocol/glob.js';
import type { UpstreamMatch } from './upstream.js';

export type RuntimeUpstream = UpstreamConfig & {
  id: string;
  presetId?: string;
  endpoint?: string;
  compactEndpoint?: string;
};
export interface RoutingSnapshot {
  routes: RouteDefinition[];
  upstreams: RuntimeUpstream[];
}

export interface RouteMatch {
  route: RouteDefinition | undefined;
  reason: 'model_not_found' | 'unsupported_client_protocol' | undefined;
}

/** Resolve model specificity before protocol compatibility: protocol failure must not fall through. */
export function resolveRoute(model: string, clientProtocol: Protocol, snapshot: RoutingSnapshot): RouteMatch {
  const enabled = snapshot.routes.filter((item) => item.enabled);
  const route =
    enabled
      .filter((item) => item.match.kind === 'exact' && item.match.value === model)
      .sort((a, b) => a.order - b.order)[0] ??
    enabled
      .filter((item) => item.match.kind === 'glob' && matchGlob(item.match.value, model))
      .sort((a, b) => a.order - b.order)[0];
  if (!route) return { route: undefined, reason: 'model_not_found' };
  if (!route.clientProtocols.includes(clientProtocol as 'openai' | 'anthropic' | 'responses'))
    return { route, reason: 'unsupported_client_protocol' };
  return { route, reason: undefined };
}

export function matchRoute(
  model: string,
  clientProtocol: Protocol,
  snapshot: RoutingSnapshot,
): RouteDefinition | undefined {
  const result = resolveRoute(model, clientProtocol, snapshot);
  return result.reason ? undefined : result.route;
}

/** Whether the selected route has any target this key is allowed to observe/use. */
export function routeHasAuthorizedTarget(model: string, snapshot: RoutingSnapshot, key?: ProxyKey): boolean {
  const route = resolveRoute(model, 'openai', snapshot).route;
  if (
    !route ||
    (key?.allowedModels?.length && !key.allowedModels.some((pattern) => pattern === model || matchGlob(pattern, model)))
  )
    return false;
  const byId = new Map(snapshot.upstreams.map((upstream) => [upstream.id, upstream]));
  return route.targets.some((target) => {
    const upstream = byId.get(target.upstreamId);
    return Boolean(
      upstream?.enabled &&
        upstream.models.includes(target.model) &&
        (!key?.allowedUpstreamIds?.length || key.allowedUpstreamIds.includes(upstream.id)) &&
        (!key?.allowedUpstreams?.length ||
          key.allowedUpstreams.includes(upstream.id) ||
          key.allowedUpstreams.includes(upstream.name)),
    );
  });
}

/** First matching route wins; targets retain configured failover order. */
export function selectRouteTargets(
  model: string,
  clientProtocol: Protocol,
  snapshot: RoutingSnapshot,
  key?: ProxyKey,
): UpstreamMatch[] {
  const route = matchRoute(model, clientProtocol, snapshot);
  if (!route) return [];
  if (
    key?.allowedModels?.length &&
    !key.allowedModels.some((pattern) => pattern === model || matchGlob(pattern, model))
  )
    return [];
  const byId = new Map(snapshot.upstreams.map((upstream) => [upstream.id, upstream]));
  return route.targets.flatMap((target) => {
    const upstream = byId.get(target.upstreamId);
    if (
      !upstream?.enabled ||
      !upstream.models.includes(target.model) ||
      (key?.allowedUpstreams?.length &&
        !key.allowedUpstreams.includes(upstream.id) &&
        !key.allowedUpstreams.includes(upstream.name))
    )
      return [];
    return [{ upstream, resolvedModel: target.model }];
  });
}
