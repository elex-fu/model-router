import type { ProxyKey, UpstreamConfig } from '../config/types.js';
import { matchGlob } from '../protocol/glob.js';

export interface UpstreamMatch {
  upstream: UpstreamConfig;
  resolvedModel: string;
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
    if (Object.hasOwn(modelMap, model)) {
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

function compareUpstreamMatch(a: UpstreamMatch, b: UpstreamMatch, failoverQueue: string[]): number {
  if (failoverQueue.length > 0) {
    const qa = failoverQueue.indexOf(a.upstream.name);
    const qb = failoverQueue.indexOf(b.upstream.name);
    const inQueueA = qa !== -1;
    const inQueueB = qb !== -1;
    if (inQueueA && inQueueB) return qa - qb;
    if (inQueueA && !inQueueB) return -1;
    if (!inQueueA && inQueueB) return 1;
  }

  const pa = a.upstream.priority ?? 0;
  const pb = b.upstream.priority ?? 0;
  if (pa !== pb) return pa - pb;

  const sa = a.upstream.sortIndex ?? Number.MAX_SAFE_INTEGER;
  const sb = b.upstream.sortIndex ?? Number.MAX_SAFE_INTEGER;
  return sa - sb;
}

export function selectUpstreams(
  model: string,
  upstreams: UpstreamConfig[],
  key?: ProxyKey,
  failoverQueue?: string[],
  random: () => number = Math.random,
): UpstreamMatch[] {
  const queue = failoverQueue ?? [];
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
  matches.sort((a, b) => compareUpstreamMatch(a, b, queue));
  return interleaveWeightedMatches(matches, queue, random);
}

/**
 * O2: within each equal-priority run (and only when no strict failover queue is
 * set), upstreams whose weights are not all equal are re-drawn by weighted
 * random selection; the deterministic sortIndex order survives untouched when
 * every weight is the default 1. Returns the same matches in a possibly
 * reordered sequence.
 */
function interleaveWeightedMatches(matches: UpstreamMatch[], queue: string[], random: () => number): UpstreamMatch[] {
  if (queue.length > 0) return matches;
  const result: UpstreamMatch[] = [];
  let index = 0;
  while (index < matches.length) {
    const priority = matches[index].upstream.priority ?? 0;
    let end = index;
    while (end < matches.length && (matches[end].upstream.priority ?? 0) === priority) end += 1;
    const group = matches.slice(index, end);
    const weights = group.map(({ upstream }) => Math.max(0, upstream.weight ?? 1));
    const uniform = weights.every((weight) => weight === weights[0]);
    if (uniform) {
      result.push(...group);
    } else {
      // Weighted draw without replacement; zero-weight upstreams never lead.
      const pool = group.map((match, i) => ({ match, weight: weights[i]! }));
      while (pool.length > 0) {
        const total = pool.reduce((sum, item) => sum + item.weight, 0);
        let pick = total > 0 ? random() * total : 0;
        let chosen = 0;
        for (; chosen < pool.length; chosen++) {
          pick -= pool[chosen]!.weight;
          if (pick <= 0) break;
        }
        if (chosen >= pool.length) chosen = pool.length - 1;
        result.push(pool[chosen]!.match);
        pool.splice(chosen, 1);
      }
    }
    index = end;
  }
  return result;
}

// Backward compat
export function selectUpstream(model: string, upstreams: UpstreamConfig[]): UpstreamConfig | null {
  return selectUpstreams(model, upstreams)[0]?.upstream ?? null;
}
