import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { hasPlatformRole } from '../access/authorization.js';
import type { PlatformAdminAccessService, PlatformAdminActor } from '../access/types.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../auth/http.js';
import type { GrokCredentialEnvelope, GrokOAuthBindingService } from './binding-service.js';
import { GrokOAuthError } from './oauth.js';

/**
 * Batch-3 Grok OAuth binding HTTP surface (the platform/codex-oauth http.ts
 * contract applied to the xAI binding). The two operator endpoints follow
 * the credential-rewrap-http.ts contract shape: same-origin POST only,
 * platform session authentication with the operations role, CSRF token on
 * every write, and a strict JSON body. The binding endpoints never return
 * token material — the completed envelope is handed to the injected sink
 * (production: the supply service's audited platform account/credential
 * creation), and the response carries only the non-secret account summary.
 */
const ROUTE_PREFIX = '/admin/api/v1/grok-oauth/';
const ROUTES = new Set(['start', 'complete']);

export interface GrokBindingOutcome {
  /** Stable reference to the persisted platform account (never a secret). */
  readonly accountRef: string;
}

/**
 * The persistence seam for a bound credential. Production wires the supply
 * service's audited platform account/credential creation; tests inject a fake.
 */
export interface GrokCredentialSink {
  accept(input: {
    readonly envelope: GrokCredentialEnvelope;
    readonly actorUserId: string;
    readonly source: 'oauth-binding';
    readonly sourceIp: string | null;
    readonly userAgent: string | null;
  }): Promise<GrokBindingOutcome>;
}

export interface GrokOauthHttpOptions {
  readonly access: Pick<PlatformAdminAccessService, 'authenticate'>;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
  readonly service: GrokOAuthBindingService;
  readonly sink: GrokCredentialSink;
  readonly publicOrigin: string;
}

export type GrokOauthHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'GrokOauthHttpError';
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

function requireOperator(actor: PlatformAdminActor | undefined): asserts actor is PlatformAdminActor {
  if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
  if (!hasPlatformRole(actor, ['operations'])) throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
}

function requireOrigin(req: IncomingMessage, publicOrigin: string): void {
  let expected: URL;
  try {
    expected = new URL(publicOrigin);
  } catch {
    throw new HttpError(503, 'GROK_OAUTH_UNAVAILABLE', 'Grok account binding is not available');
  }
  if (req.headers.origin !== expected.origin || req.headers.host !== expected.host) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
}

async function requireCsrf(req: IncomingMessage, authService: GrokOauthHttpOptions['authService']): Promise<void> {
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

function bodyText(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid binding input');
  }
  return value;
}

function requestMetadata(req: IncomingMessage): {
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
} {
  const remoteAddress = req.socket?.remoteAddress;
  const sourceIp = typeof remoteAddress === 'string' && isIP(remoteAddress) !== 0 ? remoteAddress : null;
  const userAgent = req.headers['user-agent'];
  const normalized = typeof userAgent === 'string' ? userAgent.trim() : '';
  return {
    sourceIp,
    userAgent:
      normalized.length > 0 && ![...normalized].some((character) => character.charCodeAt(0) <= 0x1f)
        ? normalized.slice(0, 512)
        : null,
  };
}

function bindingErrorStatus(code: string): { status: number; httpCode: string } {
  switch (code) {
    case 'SESSION_NOT_FOUND':
      return { status: 404, httpCode: 'BINDING_SESSION_NOT_FOUND' };
    case 'SESSION_EXPIRED':
      return { status: 410, httpCode: 'BINDING_SESSION_EXPIRED' };
    case 'STATE_INVALID':
    case 'CODE_INVALID':
      return { status: 400, httpCode: 'INVALID_BINDING_INPUT' };
    default:
      // Upstream token endpoint or id_token problems are never the
      // operator's input shape: surface a generic upstream failure.
      return { status: 502, httpCode: 'GROK_OAUTH_UPSTREAM_FAILED' };
  }
}

function envelopeSummary(envelope: GrokCredentialEnvelope, accountRef: string): Record<string, unknown> {
  return {
    accountRef,
    userId: envelope.userId,
    teamId: envelope.teamId,
    email: envelope.email,
    subscriptionTier: envelope.subscriptionTier,
    expiresAt: envelope.expiresAt,
  };
}

export function createGrokOauthHttpHandler(options: GrokOauthHttpOptions): GrokOauthHttpHandler {
  if (!options?.access || typeof options.access.authenticate !== 'function') throw new TypeError('access is required');
  if (!options?.authService || typeof options.authService.verifyCsrfToken !== 'function') {
    throw new TypeError('platform auth service is required');
  }
  if (!options?.service) throw new TypeError('binding service is required');
  if (!options?.sink || typeof options.sink.accept !== 'function') throw new TypeError('credential sink is required');

  return async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', options.publicOrigin);
      const action = route(url.pathname);
      if (!action) return false;
      if (url.search || url.hash) throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid');
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') {
        req.resume();
        res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed', requestId } }),
        );
        return true;
      }
      requireOrigin(req, options.publicOrigin);
      const actor = await options.access.authenticate(req);
      requireOperator(actor);
      await requireCsrf(req, options.authService);
      const body = await readJson(req);
      const metadata = requestMetadata(req);

      if (action === 'start') {
        requireExactKeys(body, []);
        const start = await options.service.generateBindingSession();
        sendJson(res, 200, requestId, { authorizeUrl: start.authorizeUrl.toString(), state: start.state });
        return true;
      }

      requireExactKeys(body, ['state', 'code']);
      const envelope = await options.service.completeBinding({
        state: bodyText(body, 'state', 256),
        code: bodyText(body, 'code', 2_048),
      });
      const outcome = await options.sink.accept({
        envelope,
        actorUserId: actor.userId,
        source: 'oauth-binding',
        ...metadata,
      });
      sendJson(res, 200, requestId, envelopeSummary(envelope, outcome.accountRef));
      return true;
    } catch (error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof HttpError) {
        sendError(res, error.status, requestId, error.code, error.safeMessage);
        return true;
      }
      if (error instanceof GrokOAuthError) {
        const mapped = bindingErrorStatus(error.code);
        sendError(res, mapped.status, requestId, mapped.httpCode, error.message);
        return true;
      }
      sendError(res, 503, requestId, 'GROK_OAUTH_UNAVAILABLE', 'Grok account binding could not be completed');
      return true;
    }
  };
}
