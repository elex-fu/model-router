import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasPlatformRole } from '../../platform/access/authorization.js';
import type { PlatformAdminAccessService } from '../../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../../platform/auth/http.js';
import { type FastGatewayResolutionService, FastResolutionError, type FastResolutionInput } from './resolution.js';

export const FAST_OUTCOME_PLATFORM_PREFIX = '/admin/api/v1/ops/fast-unknown-outcomes';
export interface FastOutcomeHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly publicOrigin: string;
  readonly operations: Pick<FastGatewayResolutionService, 'listCases' | 'getCase' | 'resolve'>;
}
export type FastOutcomeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
class BoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  const matches = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  try {
    return decodeURIComponent(matches[0].slice(name.length + 1));
  } catch {
    return undefined;
  }
}
async function csrf(req: IncomingMessage, options: FastOutcomeHttpOptions): Promise<void> {
  const session = cookie(req, PLATFORM_ADMIN_SESSION_COOKIE),
    value = cookie(req, PLATFORM_ADMIN_CSRF_COOKIE),
    header = req.headers['x-csrf-token'];
  if (
    !session ||
    !value ||
    typeof header !== 'string' ||
    Buffer.byteLength(value) !== Buffer.byteLength(header) ||
    !timingSafeEqual(Buffer.from(value), Buffer.from(header))
  )
    throw new BoundaryError(403, 'CSRF_REJECTED');
  if (!(await options.authService.verifyCsrfToken(session, value))) throw new BoundaryError(403, 'CSRF_REJECTED');
}
function json(res: ServerResponse, status: number, requestId: string, data: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
  });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    typeof req.headers['content-type'] !== 'string' ||
    !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'])
  )
    throw new BoundaryError(415, 'JSON_REQUIRED');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > PLATFORM_ADMIN_MAX_BODY_BYTES) throw new BoundaryError(413, 'BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BoundaryError(400, 'INVALID_BODY');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BoundaryError(400, 'INVALID_BODY');
  const value = parsed as Record<string, unknown>;
  const allowed = [
    'kind',
    'chargeMinorUnits',
    'usage',
    'evidenceReference',
    'evidenceSha256',
    'supportTicketRef',
    'reason',
  ];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new BoundaryError(400, 'INVALID_BODY');
  return value;
}
export function createFastOutcomePlatformHttpHandler(options: FastOutcomeHttpOptions): FastOutcomeHttpHandler {
  const origin = new URL(options.publicOrigin);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Invalid platform origin');
  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', origin.origin);
    } catch {
      return false;
    }
    if (url.pathname !== FAST_OUTCOME_PLATFORM_PREFIX && !url.pathname.startsWith(`${FAST_OUTCOME_PLATFORM_PREFIX}/`))
      return false;
    const requestId = `fast_resolution_${randomUUID()}`;
    try {
      if (url.origin !== origin.origin || url.hash) throw new BoundaryError(400, 'INVALID_QUERY');
      const parts = url.pathname.slice(FAST_OUTCOME_PLATFORM_PREFIX.length).split('/').filter(Boolean);
      const action =
        parts.length === 0
          ? 'list'
          : parts.length === 1
            ? 'detail'
            : parts.length === 2 && parts[1] === 'resolve'
              ? 'resolve'
              : null;
      if (!action) throw new BoundaryError(404, 'NOT_FOUND');
      const expected = action === 'resolve' ? 'POST' : 'GET';
      if ((req.method ?? 'GET') !== expected) {
        res.setHeader('allow', expected);
        throw new BoundaryError(405, 'METHOD_NOT_ALLOWED');
      }
      const allowed = action === 'list' ? ['tenantId', 'limit'] : ['tenantId'];
      if (
        [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
        allowed.some((key) => url.searchParams.getAll(key).length > 1)
      )
        throw new BoundaryError(400, 'INVALID_QUERY');
      const tenantId = url.searchParams.get('tenantId');
      if (!tenantId) throw new BoundaryError(400, 'TENANT_REQUIRED');
      const actor = await options.access.authenticate(req);
      if (!actor) throw new BoundaryError(401, 'AUTHENTICATION_REQUIRED');
      if (!hasPlatformRole(actor, ['operations'])) throw new BoundaryError(403, 'FORBIDDEN');
      if (action === 'list') {
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) throw new BoundaryError(400, 'INVALID_QUERY');
        json(res, 200, requestId, {
          items: await options.operations.listCases({ tenantId, limit: rawLimit === null ? 50 : Number(rawLimit) }),
        });
        return true;
      }
      const intentId = decodeURIComponent(parts[0]);
      if (action === 'detail') {
        const detail = await options.operations.getCase({ tenantId, intentId });
        if (!detail) throw new BoundaryError(404, 'NOT_FOUND');
        json(res, 200, requestId, detail);
        return true;
      }
      if (req.headers.origin !== origin.origin || req.headers.host !== origin.host)
        throw new BoundaryError(403, 'ORIGIN_REJECTED');
      await csrf(req, options);
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
        throw new BoundaryError(400, 'IDEMPOTENCY_REQUIRED');
      const value = await body(req);
      const result = await options.operations.resolve({
        ...value,
        tenantId,
        intentId,
        idempotencyKey: key,
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
      } as unknown as FastResolutionInput);
      json(res, result.state === 'completed' ? 200 : 202, requestId, result);
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      const status =
        error instanceof BoundaryError
          ? error.status
          : error instanceof FastResolutionError
            ? ({ FORBIDDEN: 403, INVALID_INPUT: 400, NOT_FOUND: 404, CONFLICT: 409, NOT_ELIGIBLE: 409 } as const)[
                error.code
              ]
            : 500;
      const code =
        error instanceof BoundaryError || error instanceof FastResolutionError ? error.code : 'RESOLUTION_UNAVAILABLE';
      json(res, status, requestId, {
        error: {
          code,
          message: status === 500 ? 'The resolution could not be completed.' : 'The resolution request was rejected.',
        },
      });
      return true;
    }
  };
}
