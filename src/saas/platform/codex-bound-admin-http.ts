import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CodexBoundAdmissionService,
  CodexBoundListResult,
  CodexBoundSubmissionResult,
  CodexBoundTransitionResult,
} from '../supply/codex-bound-admission-service.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from './access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from './auth/http.js';
import { PlatformGovernanceError } from './governance/errors.js';

/**
 * 方案1 (M1-B) — the operator surface for Codex trusted-bound admission
 * (migration 155 / saas_codex_trusted_bound_profiles):
 *
 * - POST /admin/api/v1/codex-bounds/submit — submit a candidate profile; the
 *   digest is recomputed server-side and the row lands as pending.
 * - POST /admin/api/v1/codex-bounds/list — paginated ledger view, optional
 *   state filter.
 * - POST /admin/api/v1/codex-bounds/approve — pending → approved; the ONLY
 *   path to an admitted (gateway-visible) profile.
 * - POST /admin/api/v1/codex-bounds/reject — pending → rejected.
 * - POST /admin/api/v1/codex-bounds/retire — approved → retired.
 *
 * Same-origin POST only, platform session authentication with an
 * operations-capable role, CSRF token on every call, strict JSON with
 * exact-key allowlists, `{ data, meta: { requestId } }` / `{ error: ... }`
 * envelopes. Writes carry governance audit inside the service transaction.
 */
const ROUTE_PREFIX = '/admin/api/v1/codex-bounds/';
const ROUTES = new Set(['submit', 'list', 'approve', 'reject', 'retire']);

export interface CodexBoundAdminHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: Pick<CodexBoundAdmissionService, 'submit' | 'list' | 'approve' | 'reject' | 'retire'>;
  readonly publicOrigin: string;
}

export type CodexBoundAdminHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'CodexBoundAdminHttpError';
  }
}

function route(pathname: string): string | undefined {
  if (!pathname.startsWith(ROUTE_PREFIX)) return undefined;
  const action = pathname.slice(ROUTE_PREFIX.length);
  return ROUTES.has(action) ? action : undefined;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let result: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (result !== undefined) return undefined;
    try {
      result = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return result || undefined;
}

function equalSecret(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  try {
    return a.length === b.length && timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function sendJson(res: ServerResponse, status: number, requestId: string, data: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ data, meta: { requestId } }));
}

function sendError(res: ServerResponse, status: number, requestId: string, code: string, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: { code, message, requestId } }));
}

function requireActor(actor: PlatformAdminActor | undefined): asserts actor is PlatformAdminActor {
  if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
}

function requireOrigin(req: IncomingMessage, publicOrigin: string): void {
  let expected: URL;
  try {
    expected = new URL(publicOrigin);
  } catch {
    throw new HttpError(503, 'CODEX_BOUNDS_UNAVAILABLE', 'Codex bound admission is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(
  req: IncomingMessage,
  authService: CodexBoundAdminHttpOptions['authService'],
): Promise<void> {
  const session = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrf = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !session || !equalSecret(csrf, header)) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
  let valid = false;
  try {
    valid = await authService.verifyCsrfToken(session, csrf as string);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const length = req.headers['content-length'];
  if (typeof length === 'string' && (!/^\d+$/.test(length) || Number(length) > PLATFORM_ADMIN_MAX_BODY_BYTES)) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > PLATFORM_ADMIN_MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) throw new HttpError(400, 'INVALID_BODY', 'A JSON request body is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is invalid');
  }
  return parsed as Record<string, unknown>;
}

function requireExactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains unsupported fields');
  }
}

function bodyDigest(body: Record<string, unknown>): string {
  const value = body.digest;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'digest must be a sha256 hex digest');
  }
  return value;
}

export function createCodexBoundAdminHttpHandler(options: CodexBoundAdminHttpOptions): CodexBoundAdminHttpHandler {
  if (!options.access || !options.authService || !options.service) {
    throw new Error('codex-bounds http handler requires access, authService and service');
  }
  return async (req, res) => {
    const requestId = randomUUID();
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://codex-bounds.invalid').pathname;
    } catch {
      return false;
    }
    const action = route(pathname);
    if (action === undefined) return false;
    if (req.url?.includes('?') || req.url?.includes('#')) {
      sendError(res, 400, requestId, 'INVALID_PATH', 'Query strings are not supported');
      return true;
    }
    if ((req.method ?? '').toUpperCase() !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only', requestId } }));
      return true;
    }

    try {
      requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireActor(actor);
      await requireCsrf(req, options.authService);

      switch (action) {
        case 'submit': {
          const body = await readJson(req);
          requireExactKeys(body, ['profile']);
          if (body.profile === null || typeof body.profile !== 'object' || Array.isArray(body.profile)) {
            throw new HttpError(400, 'INVALID_BODY', 'A profile object is required');
          }
          const result: CodexBoundSubmissionResult = await options.service.submit(actor, body.profile);
          sendJson(res, 200, requestId, result);
          return true;
        }
        case 'list': {
          const body = await readJson(req);
          requireExactKeys(body, ['state', 'limit', 'offset']);
          if (
            body.limit !== undefined &&
            (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100)
          ) {
            throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid page parameter');
          }
          if (
            body.offset !== undefined &&
            (typeof body.offset !== 'number' ||
              !Number.isInteger(body.offset) ||
              body.offset < 0 ||
              body.offset > 1_000_000)
          ) {
            throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid page parameter');
          }
          const result: CodexBoundListResult = await options.service.list(actor, body);
          sendJson(res, 200, requestId, result);
          return true;
        }
        case 'approve': {
          const body = await readJson(req);
          requireExactKeys(body, ['digest']);
          const result: CodexBoundTransitionResult = await options.service.approve(actor, {
            digest: bodyDigest(body),
          });
          sendJson(res, 200, requestId, result);
          return true;
        }
        case 'reject': {
          const body = await readJson(req);
          requireExactKeys(body, ['digest']);
          const result: CodexBoundTransitionResult = await options.service.reject(actor, {
            digest: bodyDigest(body),
          });
          sendJson(res, 200, requestId, result);
          return true;
        }
        case 'retire': {
          const body = await readJson(req);
          requireExactKeys(body, ['digest']);
          const result: CodexBoundTransitionResult = await options.service.retire(actor, {
            digest: bodyDigest(body),
          });
          sendJson(res, 200, requestId, result);
          return true;
        }
        default:
          sendError(res, 404, requestId, 'NOT_FOUND', 'Unknown codex-bounds action');
          return true;
      }
    } catch (error) {
      try {
        req.resume();
      } catch {
        // The error response below is stable even when draining fails.
      }
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      if (error instanceof PlatformGovernanceError) {
        sendError(res, error.status, requestId, error.code, error.message);
        return true;
      }
      sendError(res, 503, requestId, 'CODEX_BOUNDS_UNAVAILABLE', 'Codex bound admission is not available');
      return true;
    }
  };
}
