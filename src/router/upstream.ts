import type { UpstreamConfig } from '../config/types.js';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function selectUpstreams(model: string, upstreams: UpstreamConfig[]): UpstreamConfig[] {
  const candidates = upstreams.filter((u) => u.enabled && u.models.includes(model));
  return shuffle(candidates);
}

// Backward compat
export function selectUpstream(model: string, upstreams: UpstreamConfig[]): UpstreamConfig | null {
  const candidates = selectUpstreams(model, upstreams);
  return candidates[0] ?? null;
}
