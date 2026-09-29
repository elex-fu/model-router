import type { ApiEnvelope, ApiMeta } from './types';

const BASE = '/admin/api/v1';
export const apiStateEvent = 'model-router:api-state';
export type ApiState = 'unauthorized' | 'config-conflict';
function notify(state: ApiState) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(apiStateEvent, { detail: state }));
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
let revision: number | undefined;
let csrfToken: string | undefined;
export const setRevision = (value?: number) => { revision = typeof value === 'number' ? value : undefined; };
export const getRevision = () => revision;
export const setCsrfToken = (value?: string) => { csrfToken = value; };
export const writeHeaders = (): Record<string,string> => ({ 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) });

export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; revision?: number; idempotencyKey?: string } = {}): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') {
    if (revision === undefined && !['/session','/bootstrap'].includes(path)) await get<{ revision: number }>('/config');
    const current = options.revision ?? revision;
    if (current !== undefined && path !== '/session') headers['If-Match'] = `"cfg-${current}"`;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let response: Response;
  try { response = await fetch(`${BASE}${path}`, { method: options.method ?? 'GET', body: options.body === undefined ? undefined : JSON.stringify(options.body), headers, credentials: 'same-origin', signal: options.signal }); }
  catch (error) { throw new ApiError(0, 'NETWORK', error instanceof Error ? error.message : '网络连接失败'); }
  const raw = await response.text();
  let parsed: { data?: T; meta?: ApiMeta; error?: { code?: string; message?: string; details?: unknown } } = {};
  if (raw) { try { parsed = JSON.parse(raw); } catch { throw new ApiError(response.status, 'INVALID_RESPONSE', '服务返回了无效 JSON'); } }
  if (!response.ok) {
    if (response.status === 401 && !(path === '/session' && options.method === 'POST')) {
      setCsrfToken(undefined);
      setRevision(undefined);
      notify('unauthorized');
    }
    if (response.status === 412 && parsed.error?.code === 'CONFIG_REVISION_CONFLICT') notify('config-conflict');
    throw new ApiError(response.status, parsed.error?.code ?? 'HTTP_ERROR', parsed.error?.message ?? `请求失败 (${response.status})`, parsed.error?.details);
  }
  if (response.status === 204) return { data: undefined as T };
  if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) throw new ApiError(response.status, 'INVALID_RESPONSE', '服务响应缺少 data');
  const next = parsed.meta?.persistedRevision ?? (parsed.data as { persistedRevision?: number; revision?: number } | undefined)?.persistedRevision ?? (path === '/config' ? (parsed.data as { revision?: number } | undefined)?.revision : undefined);
  if (typeof next === 'number') setRevision(next);
  const csrf = (parsed.data as { csrfToken?: string } | undefined)?.csrfToken;
  if (csrf) setCsrfToken(csrf);
  if (path === '/session' && options.method === 'DELETE') { setCsrfToken(undefined); setRevision(undefined); }
  return parsed as ApiEnvelope<T>;
}
export const get = <T,>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
export const post = <T,>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) => request<T>(path, { method: 'POST', body, ...opts });
export const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body });
export const put = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body });
export const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });
export const query = (values: Record<string, string | undefined>) => '?' + new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
export function timeWindow(range: string): { from: string; to: string } { const hours = range === '7d' ? 168 : range === '30d' ? 720 : 24; const to = new Date(); to.setSeconds(0,0); return { from: new Date(to.getTime() - hours * 3600000).toISOString(), to: to.toISOString() }; }
