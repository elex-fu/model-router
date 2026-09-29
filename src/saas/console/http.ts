import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { CustomerWalletQueryError, type SaasCustomerWalletQueryService } from '../billing/customer-query.js';
import { SaasIdentityError } from '../identity/errors.js';
import type { SaasIdentityService } from '../identity/service.js';
import type { TenantContext } from '../identity/types.js';
import {
  type ConsoleRequestDetailQuery,
  type ConsoleRequestListQuery,
  type ConsoleRequestStatus,
  type ConsoleSupplyMode,
  type ConsoleUsageSummaryQuery,
  SaasConsoleQueryError,
  type SaasConsoleUsageQueryService,
} from './index.js';

const API_PREFIX = '/console/api/v1';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const MAX_PATH_LENGTH = 4096;
const MAX_QUERY_VALUE_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_MODEL_LENGTH = 512;
const MAX_CURSOR_LENGTH = 2048;
const MAX_TIME_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const REQUEST_STATUSES = new Set<ConsoleRequestStatus>(['pending', 'succeeded', 'failed', 'unknown']);
const SUPPLY_MODES = new Set<ConsoleSupplyMode>(['byok', 'platform']);

export type SaasConsoleHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface SaasConsoleHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'resolveTenantContext'>;
  readonly queryService: Pick<SaasConsoleUsageQueryService, 'getUsageSummary' | 'listRequests' | 'getRequestDetail'>;
  readonly customerWalletQueryService?: Pick<SaasCustomerWalletQueryService, 'getWallet'>;
  readonly publicOrigin: string;
}

type ConsoleRoute =
  | { readonly route: 'usage'; readonly tenantId: string }
  | { readonly route: 'requests'; readonly tenantId: string }
  | { readonly route: 'wallet'; readonly tenantId: string }
  | { readonly route: 'requestDetail'; readonly tenantId: string; readonly requestId: string };

type FilterOptions = {
  readonly currency?: string;
  readonly from?: string;
  readonly to?: string;
  readonly projectId?: string;
  readonly model?: string;
  readonly status?: ConsoleRequestStatus;
  readonly supplyMode?: ConsoleSupplyMode;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SaasConsoleHttpError';
  }
}

function invalidQuery(): never {
  throw new HttpError(400, 'CONSOLE_INVALID_INPUT', 'The console query contains invalid data.');
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

function sendError(res: ServerResponse, requestId: string, error: HttpError, extraHeaders?: OutgoingHttpHeaders): void {
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders ?? {}),
  });
  res.end(JSON.stringify({ error: { code: error.code, message: error.message, requestId } }));
}

function requestMethodError(res: ServerResponse, requestId: string): void {
  sendError(res, requestId, new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'), {
    allow: 'GET',
  });
}

function routePath(req: IncomingMessage, origin: string): string | undefined {
  try {
    const pathname = new URL(req.url ?? '/', origin).pathname;
    return pathname.length <= MAX_PATH_LENGTH ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function hasResidualEncodedPathControl(value: string): boolean {
  return /%(?:00|2e|2f|5c)/i.test(value);
}

function pathIdentifier(encoded: string, name: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  if (
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..' ||
    hasResidualEncodedPathControl(value)
  ) {
    throw new HttpError(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  return value;
}

function findRoute(path: string): ConsoleRoute | undefined {
  const match = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/(usage|requests|wallet)(?:/([^/]+))?$`).exec(path);
  if (!match) return undefined;

  const tenantId = pathIdentifier(match[1], 'tenant');
  const resource = match[2];
  if (resource === 'wallet') {
    if (match[3] !== undefined) return undefined;
    return { route: 'wallet', tenantId };
  }
  if (resource === 'usage') {
    if (match[3] !== undefined) return undefined;
    return { route: 'usage', tenantId };
  }
  if (match[3] === undefined) return { route: 'requests', tenantId };
  return { route: 'requestDetail', tenantId, requestId: pathIdentifier(match[3], 'request') };
}

function sessionToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;

  const matches: string[] = [];
  for (const part of header.split(';')) {
    if (part.trim() === '') continue;
    const separator = part.indexOf('=');
    if (separator < 0) return undefined;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length !== 1) return undefined;

  let token: string;
  try {
    token = decodeURIComponent(matches[0]);
  } catch {
    return undefined;
  }
  const hasControlCharacter = [...token].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    token.length < 16 ||
    token.length > 256 ||
    token.trim() !== token ||
    token.includes(';') ||
    hasControlCharacter ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return undefined;
  }
  return token;
}

function queryValue(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) invalidQuery();
  const value = values[0];
  if (value !== undefined && value.length > MAX_QUERY_VALUE_LENGTH) invalidQuery();
  return value;
}

function queryOptions(
  url: URL,
  route: ConsoleRoute,
): FilterOptions & { readonly cursor?: string; readonly limit?: number } {
  const allowed = new Set(
    route.route === 'usage'
      ? ['from', 'to', 'projectId', 'model', 'status', 'supplyMode']
      : route.route === 'requests'
        ? ['from', 'to', 'projectId', 'model', 'status', 'supplyMode', 'cursor', 'limit']
        : route.route === 'wallet'
          ? ['currency', 'cursor', 'limit']
          : ['projectId'],
  );
  for (const name of new Set(url.searchParams.keys())) {
    if (!allowed.has(name)) invalidQuery();
  }

  const from = queryValue(url, 'from');
  const to = queryValue(url, 'to');
  const projectId = queryValue(url, 'projectId');
  const model = queryValue(url, 'model');
  const status = queryValue(url, 'status') as ConsoleRequestStatus | undefined;
  const supplyMode = queryValue(url, 'supplyMode') as ConsoleSupplyMode | undefined;
  const cursor = queryValue(url, 'cursor');
  const limitValue = queryValue(url, 'limit');
  const currency = queryValue(url, 'currency');

  let limit: number | undefined;
  if (limitValue !== undefined) {
    if (!/^\d+$/.test(limitValue)) invalidQuery();
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidQuery();
  }

  if (projectId !== undefined && (projectId.trim().length === 0 || projectId.length > MAX_IDENTIFIER_LENGTH)) {
    invalidQuery();
  }
  if (model !== undefined && (model.trim().length === 0 || model.length > MAX_MODEL_LENGTH)) invalidQuery();
  if (status !== undefined && !REQUEST_STATUSES.has(status)) invalidQuery();
  if (supplyMode !== undefined && !SUPPLY_MODES.has(supplyMode)) invalidQuery();
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)) invalidQuery();
  if (route.route === 'wallet' && (currency === undefined || !/^[A-Z]{3}$/.test(currency))) invalidQuery();

  const hasFrom = from !== undefined;
  const hasTo = to !== undefined;
  if (route.route === 'usage' && (!hasFrom || !hasTo)) invalidQuery();
  if (route.route === 'requests' && hasFrom !== hasTo) invalidQuery();
  if (hasFrom && hasTo) {
    if (from.length > 128 || to.length > 128) invalidQuery();
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs || toMs - fromMs > MAX_TIME_RANGE_MS) {
      invalidQuery();
    }
  }

  return {
    ...(currency === undefined ? {} : { currency }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(model === undefined ? {} : { model }),
    ...(status === undefined ? {} : { status }),
    ...(supplyMode === undefined ? {} : { supplyMode }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function queryError(error: unknown): HttpError {
  if (error instanceof CustomerWalletQueryError) {
    return new HttpError(error.status, error.code, error.message);
  }
  if (error instanceof SaasIdentityError) {
    return new HttpError(error.status, error.code, error.message);
  }
  if (error instanceof SaasConsoleQueryError) {
    return new HttpError(error.status, error.code, error.message);
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

export function createSaasConsoleHandler(options: SaasConsoleHttpOptions): SaasConsoleHttpHandler {
  const publicUrl = new URL(options.publicOrigin);

  return async (req, res) => {
    const requestId = `saas_console_${randomUUID()}`;
    try {
      const path = routePath(req, publicUrl.origin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      if (!path.startsWith(`${API_PREFIX}/`)) return false;
      const match = findRoute(path);
      if (!match) return false;

      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        req.resume();
        requestMethodError(res, requestId);
        return true;
      }

      const token = sessionToken(req);
      if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
      const session = await options.service.getSession(token);
      if (!session?.userId) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');

      const url = new URL(req.url ?? '/', publicUrl.origin);
      const filters = queryOptions(url, match);
      if (match.route === 'wallet') {
        const context: TenantContext = await options.service.resolveTenantContext({
          userId: session.userId,
          tenantId: match.tenantId,
        });
        if (context.userId !== session.userId || context.tenantId !== match.tenantId) {
          throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
        }
        if (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') {
          throw new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
        }
        if (!options.customerWalletQueryService) {
          throw new HttpError(503, 'CUSTOMER_WALLET_UNAVAILABLE', 'The customer wallet query service is unavailable');
        }
        const data = await options.customerWalletQueryService.getWallet(context, {
          currency: filters.currency as string,
          ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
          ...(filters.limit === undefined ? {} : { limit: filters.limit }),
        });
        sendJson(res, 200, requestId, data);
        return true;
      }
      if (match.route === 'usage') {
        const data = await options.queryService.getUsageSummary({
          userId: session.userId,
          tenantId: match.tenantId,
          ...filters,
        } as ConsoleUsageSummaryQuery);
        sendJson(res, 200, requestId, data);
        return true;
      }

      if (match.route === 'requests') {
        const data = await options.queryService.listRequests({
          userId: session.userId,
          tenantId: match.tenantId,
          ...filters,
        } as ConsoleRequestListQuery);
        sendJson(res, 200, requestId, data);
        return true;
      }

      const data = await options.queryService.getRequestDetail({
        userId: session.userId,
        tenantId: match.tenantId,
        requestId: match.requestId,
        ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      } satisfies ConsoleRequestDetailQuery);
      if (!data) {
        sendError(res, requestId, new HttpError(404, 'NOT_FOUND', 'The requested resource was not found'));
        return true;
      }
      sendJson(res, 200, requestId, data);
      return true;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, error instanceof HttpError ? error : queryError(error));
      return true;
    }
  };
}

export const createSaasConsoleHttpHandler = createSaasConsoleHandler;
