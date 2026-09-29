import { useEffect, useState } from 'react';

// sessionStorage is scoped to this tab and cleared when the tab closes. Drafts
// expire after 30 minutes and are restricted to explicitly listed fields.
const STORAGE_KEY = 'model-router:safe-drafts:v1';
const TTL_MS = 30 * 60 * 1000;
const blocked = /(?:api[\s_-]*key|proxy[\s_-]*key|token|password|credential|secret|authorization|prompt)/i;
const tokenLike = /^(?:sk|pk|rk|mr)[_-][a-z0-9_-]{8,}$/i;
const fields = {
  upstream: ['name', 'provider', 'presetId', 'protocol', 'enabled', 'baseUrl', 'generate', 'modelsEndpoint', 'authMode', 'allowInsecureHttp'],
  route: ['name', 'match', 'kind', 'published', 'protocols', 'targets', 'enabled'],
  key: ['name', 'description', 'rpm', 'tokens', 'models', 'allowed'],
} as const;
export type DraftScope = keyof typeof fields;
type Draft = { savedAt: number; values: Record<string, unknown> };
type Store = Partial<Record<DraftScope, Record<string, Draft>>>;

function clean(value: unknown): unknown {
  if (typeof value === 'string') return blocked.test(value) || tokenLike.test(value.trim()) ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const items = value.map(clean);
    return items.some(item => item === undefined) ? undefined : items;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (blocked.test(key)) return undefined;
      const next = clean(item);
      if (next === undefined) return undefined;
      result[key] = next;
    }
    return result;
  }
  return undefined;
}

function safeField(scope: DraftScope, key: string, value: unknown): unknown {
  const safe = clean(value);
  if (safe === undefined) return undefined;
  if (scope === 'upstream' && key === 'baseUrl' && typeof safe === 'string') {
    try {
      const url = new URL(safe);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    } catch { return undefined; }
  }
  if (scope === 'route' && key === 'targets' && Array.isArray(safe)) {
    const targetKeys = new Set(['upstreamId', 'model']);
    if (!safe.every(target => target && typeof target === 'object' && !Array.isArray(target) &&
      Object.keys(target).every(targetKey => targetKeys.has(targetKey)) &&
      Object.values(target).every(item => typeof item === 'string'))) return undefined;
  }
  return safe;
}

function readStore(): Store {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    const now = Date.now();
    let changed = false;
    for (const scope of Object.keys(fields) as DraftScope[]) {
      for (const [id, draft] of Object.entries(parsed[scope] ?? {})) {
        if (!draft || !Number.isFinite(draft.savedAt) || now - draft.savedAt > TTL_MS || now < draft.savedAt || clean(draft.values) === undefined) {
          delete parsed[scope]?.[id];
          changed = true;
        }
      }
    }
    if (changed) writeStore(parsed);
    return parsed;
  } catch { return {}; }
}

function writeStore(store: Store) {
  try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* Storage can be disabled or full. */ }
}

export function readSafeDraft<T>(scope: DraftScope, id: string): T | undefined {
  const entry = readStore()[scope]?.[id];
  if (!entry) return undefined;
  const allowed = new Set<string>(fields[scope]);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.values)) {
    if (!allowed.has(key)) continue;
    const safe = safeField(scope, key, value);
    if (safe === undefined) return undefined;
    values[key] = safe;
  }
  return values as T;
}

export function hasSafeDraft(scope: DraftScope, id: string): boolean { return readSafeDraft(scope, id) !== undefined; }

export function latestSafeDraftId(scope: DraftScope): string | undefined {
  const store = readStore();
  const entries = Object.entries(store[scope] ?? {}).sort((a, b) => b[1].savedAt - a[1].savedAt);
  return entries[0]?.[0];
}

export function saveSafeDraft(scope: DraftScope, id: string, value: Record<string, unknown>) {
  if (!id || blocked.test(id)) return false;
  const allowed = new Set<string>(fields[scope]);
  const values: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.test(key)) return false;
    if (!allowed.has(key)) continue;
    const safe = safeField(scope, key, item);
    if (safe === undefined) return false;
    values[key] = safe;
  }
  const store = readStore();
  if (Object.keys(values).length === 0 || Object.values(values).every(item => item === '' || item === false || (Array.isArray(item) && item.length === 0))) {
    delete store[scope]?.[id];
    writeStore(store);
    return true;
  }
  store[scope] ??= {};
  store[scope]![id] = { savedAt: Date.now(), values };
  writeStore(store);
  return true;
}

export function clearSafeDraft(scope?: DraftScope, id?: string) {
  if (typeof window === 'undefined') return;
  if (!scope) { try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ } return; }
  const store = readStore();
  if (id) delete store[scope]?.[id]; else delete store[scope];
  if (Object.values(store).every(group => !group || Object.keys(group).length === 0)) {
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  } else writeStore(store);
}

export function useSafeDraft<T extends Record<string, unknown>>(scope: DraftScope, id: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => ({ ...initial, ...(readSafeDraft<Partial<T>>(scope, id) ?? {}) }));
  useEffect(() => { saveSafeDraft(scope, id, value); }, [scope, id, value]);
  return [value, setValue];
}
