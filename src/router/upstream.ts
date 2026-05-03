import type { UpstreamConfig, ProxyKey } from '../config/types.js';
import { matchGlob } from '../protocol/glob.js';

export interface UpstreamMatch {
  upstream: UpstreamConfig;
  resolvedModel: string;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Resolve the request `model` against a single upstream, returning the upstream's
 * real model name if it matches, or null if it does not.
 *
 * Match priority:
 *   1. Exact match in `modelMap`
 *   2. Glob match in `modelMap` — when multiple patterns match, the first one in
 *      `Object.entries` order (insertion order in modern JS engines) wins.
 *   3. `models[]` passthrough (resolvedModel === request model)
 */
function resolveModel(model: string, upstream: UpstreamConfig): string | null {
  const modelMap = upstream.modelMap;
  if (modelMap) {
    if (Object.prototype.hasOwnProperty.call(modelMap, model)) {
      return modelMap[model];
    }
    for (const [pattern, target] of Object.entries(modelMap)) {
      if (matchGlob(pattern, model)) {
        return target;
      }
    }
  }
  if (upstream.models.includes(model)) {
    return model;
  }
  return null;
}

export function selectUpstreams(
  model: string,
  upstreams: UpstreamConfig[],
  key?: ProxyKey
): UpstreamMatch[] {
  const matches: UpstreamMatch[] = [];
  for (const upstream of upstreams) {
    if (!upstream.enabled) continue;
    if (key) {
      const allowedUps = key.allowedUpstreams;
      if (allowedUps && allowedUps.length > 0 && !allowedUps.includes(upstream.name)) continue;
      const allowedModels = key.allowedModels;
      if (allowedModels && allowedModels.length > 0) {
        const modelOk = allowedModels.some((p) => p === model || matchGlob(p, model));
        if (!modelOk) continue;
      }
    }
    const resolved = resolveModel(model, upstream);
    if (resolved !== null) {
      matches.push({ upstream, resolvedModel: resolved });
    }
  }
  return shuffle(matches);
}

// Backward compat
export function selectUpstream(model: string, upstreams: UpstreamConfig[]): UpstreamConfig | null {
  return selectUpstreams(model, upstreams)[0]?.upstream ?? null;
}
