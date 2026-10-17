import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BRAND_PAGE_SLUG_MAX_LENGTH,
  BRAND_PAGE_SLUG_PATTERN,
  brandSnapshotJsonPayload,
  EMPTY_BRAND_SNAPSHOT,
  type PublicBrandSnapshot,
} from './snapshot.js';

/**
 * Batch 5 §5.2 OEM white-label: the unauthenticated public brand surface on
 * the gateway listener (the /metrics precedent — public, non-secret data, no
 * session).
 *
 *   GET /settings/public             — the full brand snapshot as JSON
 *   GET /settings/public/pages/:slug — one markdown page body (text/markdown)
 *
 * 405 semantics mirror /metrics: any non-GET method on a matched path is
 * rejected with METHOD_NOT_ALLOWED; any path outside the two shapes is not
 * handled (the handler returns false) so the caller's routing stays
 * authoritative. A malformed slug (wrong grammar, traversal characters, a
 * nested path) answers the same 404 as an unknown slug. The response cache
 * window (60s) matches the snapshot materialization cadence — a public,
 * non-secret payload may be cached by shared proxies.
 */
export const PUBLIC_BRAND_SETTINGS_PATH = '/settings/public' as const;
const PUBLIC_BRAND_PAGES_PREFIX = '/settings/public/pages/' as const;
const PUBLIC_BRAND_CACHE_CONTROL = 'public, max-age=60' as const;

export interface PublicBrandSettingsHttpOptions {
  /** Reads the materialized snapshot (the cached reader over the store). */
  readonly read: () => Promise<PublicBrandSnapshot>;
  /** Logged once per failed snapshot read; the empty snapshot is served instead. */
  readonly onError?: (error: unknown) => void;
}

export type PublicBrandSettingsHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function sendJson(res: ServerResponse, status: number, payload: unknown, cacheControl = 'no-store'): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** A syntactically valid page slug (defense in depth: the store already enforced it). */
function isValidBrandPageSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= BRAND_PAGE_SLUG_MAX_LENGTH &&
    BRAND_PAGE_SLUG_PATTERN.test(slug) &&
    !slug.includes('/')
  );
}

export function createPublicBrandSettingsHttpHandler(
  options: PublicBrandSettingsHttpOptions,
): PublicBrandSettingsHttpHandler {
  if (typeof options?.read !== 'function') throw new TypeError('read is required');
  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://brand.public.local');
    } catch {
      return false;
    }
    const pathname = url.pathname;
    const isRoot = pathname === PUBLIC_BRAND_SETTINGS_PATH;
    const isPage = pathname.startsWith(PUBLIC_BRAND_PAGES_PREFIX);
    if (!isRoot && !isPage) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      req.resume();
      res.writeHead(405, {
        allow: 'GET',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } }));
      return true;
    }
    req.resume();

    let snapshot: PublicBrandSnapshot;
    try {
      snapshot = await options.read();
    } catch (error) {
      // Fail open: brand is cosmetic; the console surface must never hard-fail.
      options.onError?.(error);
      snapshot = EMPTY_BRAND_SNAPSHOT;
    }

    if (isRoot) {
      sendJson(res, 200, { data: brandSnapshotJsonPayload(snapshot) }, PUBLIC_BRAND_CACHE_CONTROL);
      return true;
    }

    const slug = pathname.slice(PUBLIC_BRAND_PAGES_PREFIX.length);
    const page = snapshot.customPages.find((candidate) => candidate.slug === slug);
    if (!isValidBrandPageSlug(slug) || page === undefined || page.mode !== 'markdown') {
      sendError(res, 404, 'NOT_FOUND', 'Not found');
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': String(Buffer.byteLength(page.content, 'utf8')),
      'cache-control': PUBLIC_BRAND_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(page.content);
    return true;
  };
}
