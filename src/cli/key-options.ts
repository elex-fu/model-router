import type { ProxyKey } from '../config/types.js';

export interface KeyCliOptions {
  description?: string;
  upstreams?: string;
  models?: string;
  rpm?: string | number;
  dailyTokens?: string | number;
  expires?: string;
  addUpstream?: string;
  removeUpstream?: string;
  addModel?: string;
  removeModel?: string;
}

export function parseCreateOptions(opts: KeyCliOptions): Partial<ProxyKey> {
  const patch: Partial<ProxyKey> = {};
  if (opts.description !== undefined) patch.description = opts.description;
  if (opts.upstreams !== undefined) {
    const list = parseList(opts.upstreams);
    if (list.length > 0) patch.allowedUpstreams = list;
  }
  if (opts.models !== undefined) {
    const list = parseList(opts.models);
    if (list.length > 0) patch.allowedModels = list;
  }
  if (opts.rpm !== undefined) {
    patch.rpm = parseNonNegativeInt(opts.rpm, 'rpm');
  }
  if (opts.dailyTokens !== undefined) {
    patch.dailyTokens = parseNonNegativeInt(opts.dailyTokens, 'daily-tokens');
  }
  if (opts.expires !== undefined) {
    const v = parseExpires(opts.expires);
    if (v !== undefined) patch.expiresAt = v;
  }
  return patch;
}

export function applyUpdateOptions(opts: KeyCliOptions, existing: ProxyKey): Partial<ProxyKey> {
  const patch: Partial<ProxyKey> = {};
  if (opts.description !== undefined) patch.description = opts.description;

  if (opts.upstreams !== undefined) {
    const list = parseList(opts.upstreams);
    patch.allowedUpstreams = list.length > 0 ? list : undefined;
  } else if (opts.addUpstream !== undefined || opts.removeUpstream !== undefined) {
    const set = new Set(existing.allowedUpstreams ?? []);
    if (opts.addUpstream !== undefined) set.add(opts.addUpstream);
    if (opts.removeUpstream !== undefined) set.delete(opts.removeUpstream);
    patch.allowedUpstreams = set.size > 0 ? Array.from(set) : undefined;
  }

  if (opts.models !== undefined) {
    const list = parseList(opts.models);
    patch.allowedModels = list.length > 0 ? list : undefined;
  } else if (opts.addModel !== undefined || opts.removeModel !== undefined) {
    const set = new Set(existing.allowedModels ?? []);
    if (opts.addModel !== undefined) set.add(opts.addModel);
    if (opts.removeModel !== undefined) set.delete(opts.removeModel);
    patch.allowedModels = set.size > 0 ? Array.from(set) : undefined;
  }

  if (opts.rpm !== undefined) {
    patch.rpm = parseNonNegativeInt(opts.rpm, 'rpm');
  }
  if (opts.dailyTokens !== undefined) {
    patch.dailyTokens = parseNonNegativeInt(opts.dailyTokens, 'daily-tokens');
  }
  if (opts.expires !== undefined) {
    patch.expiresAt = parseExpires(opts.expires);
  }
  return patch;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNonNegativeInt(value: string | number, name: string): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  return n;
}

function parseExpires(value: string): string | undefined {
  if (value === 'never') return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid --expires: ${value} (use ISO 8601 or 'never')`);
  }
  return new Date(parsed).toISOString();
}
