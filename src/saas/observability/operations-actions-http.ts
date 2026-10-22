import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasPlatformRole } from '../platform/access/authorization.js';
import type { PlatformAdminAccessService } from '../platform/access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../platform/auth/http.js';
import { OperationsActionError, type OperationsActions } from './operations-actions.js';

export interface OperationsActionHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly publicOrigin: string;
  readonly operations: OperationsActions;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const matches = (req.headers.cookie ?? '')
    .split(';')
    .filter((item) => item.slice(0, item.indexOf('=')).trim() === name);
  const item = matches[0];
  if (matches.length !== 1 || !item) return undefined;
  try {
    return decodeURIComponent(item.slice(item.indexOf('=') + 1).trim()) || undefined;
  } catch {
    return undefined;
  }
}

function equal(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  try {
    return a.length === b.length && timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'JSON_REQUIRED');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += data.length;
    if (bytes > 8192) throw new HttpError(413, 'BODY_TOO_LARGE');
    chunks.push(data);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, 'INVALID_INPUT');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'INVALID_INPUT');
  return parsed as Record<string, unknown>;
}

/** Same session, role, Origin and CSRF policy as the platform write surfaces. */
export function createOperationsActionHttpHandler(options: OperationsActionHttpOptions) {
  const origin = new URL(options.publicOrigin);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const requestId = randomUUID();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', origin);
    } catch {
      return false;
    }
    const match = /^\/admin\/api\/v1\/ops\/media-tasks\/video\/([^/]+)\/requeue$/.exec(url.pathname);
    if (!match) return false;
    try {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      const actor = await options.access.authenticate(req);
      if (!actor) throw new HttpError(401, 'UNAUTHENTICATED');
      if (!hasPlatformRole(actor, ['operations'])) throw new HttpError(403, 'FORBIDDEN');
      if (req.headers.origin !== origin.origin || req.headers.host !== origin.host)
        throw new HttpError(403, 'ORIGIN_REJECTED');
      const session = cookie(req, PLATFORM_ADMIN_SESSION_COOKIE);
      const csrf = cookie(req, PLATFORM_ADMIN_CSRF_COOKIE);
      const header = req.headers['x-csrf-token'];
      if (
        !session ||
        typeof header !== 'string' ||
        !equal(csrf, header) ||
        !(await options.authService.verifyCsrfToken(session, header))
      )
        throw new HttpError(403, 'CSRF_REJECTED');
      if (url.search !== '') throw new HttpError(400, 'INVALID_INPUT');
      let taskId: string;
      try {
        taskId = decodeURIComponent(match[1] ?? '');
      } catch {
        throw new HttpError(400, 'INVALID_INPUT');
      }
      if (
        taskId.includes('/') ||
        taskId.includes('\\') ||
        [...taskId].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
      )
        throw new HttpError(400, 'INVALID_INPUT');
      const input = await body(req);
      if (
        Object.keys(input).length !== 3 ||
        Object.keys(input).some((key) => !['tenantId', 'expectedLeaseEpoch', 'reason'].includes(key)) ||
        typeof input.tenantId !== 'string' ||
        typeof input.reason !== 'string' ||
        typeof input.expectedLeaseEpoch !== 'number'
      )
        throw new HttpError(400, 'INVALID_INPUT');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new HttpError(400, 'INVALID_INPUT');
      const result = await options.operations.requeueVideo({
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        tenantId: input.tenantId,
        taskId,
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        reason: input.reason,
        idempotencyKey: key,
      });
      send(res, 200, { data: result, meta: { requestId } });
    } catch (error) {
      req.resume();
      const code = error instanceof OperationsActionError || error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
      const status =
        error instanceof HttpError
          ? error.status
          : code === 'FORBIDDEN'
            ? 403
            : code === 'TASK_NOT_FOUND'
              ? 404
              : code.endsWith('CONFLICT')
                ? 409
                : code === 'INVALID_INPUT'
                  ? 400
                  : 500;
      send(res, status, { error: { code, message: 'The operations request could not be completed', requestId } });
    }
    return true;
  };
}
