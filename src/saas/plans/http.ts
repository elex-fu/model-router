import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { SaasIdentityError } from '../identity/errors.js';
import type { SaasIdentityService } from '../identity/service.js';
import { isServicePlanError } from './errors.js';
import type { ByokServicePlanService } from './service.js';
import type { ServicePlanVersionRecord } from './types.js';

const API_PREFIX = '/console/api/v1';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const MAX_PATH_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 255;

/** Public wording for the current BYOK policy; no credential or entitlement facts are included. */
export const BYOK_CATALOG_POLICY_DESCRIPTION =
  'Fixed-term BYOK access: you provide and maintain your own provider credentials. This informational catalog does not accept, store, or expose credentials.';

export interface CustomerServicePlanCatalogItem {
  readonly planVersionId: string;
  readonly planId: string;
  readonly version: number;
  readonly supplyMode: 'byok';
  readonly termDays: number;
  readonly fixedFeeMinorUnits: string;
  readonly currency: string;
  readonly supportedProviderIds: readonly string[];
  readonly supportedModels: readonly string[];
  readonly policyDescription: string;
}

export type SaasPlanHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface SaasPlanHttpOptions {
  readonly service: Pick<SaasIdentityService, 'getSession' | 'resolveTenantContext'>;
  readonly planService: Pick<ByokServicePlanService, 'listCatalog'>;
  readonly publicOrigin: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SaasPlanHttpError';
  }
}

type PlanRoute = { readonly tenantId: string };

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

function pathIdentifier(encoded: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The tenant identifier is invalid');
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
    throw new HttpError(400, 'INVALID_PATH', 'The tenant identifier is invalid');
  }
  return value;
}

function findRoute(path: string): PlanRoute | undefined {
  const match = new RegExp(`^${API_PREFIX}/tenants/([^/]+)/service-plans/catalog$`).exec(path);
  return match ? { tenantId: pathIdentifier(match[1]) } : undefined;
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

function requestMethodError(res: ServerResponse, requestId: string): void {
  sendError(res, requestId, new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'), {
    allow: 'GET',
  });
}

function publicPlan(plan: ServicePlanVersionRecord): CustomerServicePlanCatalogItem | undefined {
  if (plan.status !== 'published' || plan.publishedAt === null || plan.retiredAt !== null) return undefined;
  if (plan.supplyMode !== 'byok') return undefined;
  return {
    planVersionId: plan.id,
    planId: plan.planId,
    version: plan.version,
    supplyMode: 'byok',
    termDays: plan.termDays,
    fixedFeeMinorUnits: plan.priceMinorUnits,
    currency: plan.currency,
    supportedProviderIds: [...plan.allowedProviderIds],
    supportedModels: [...plan.allowedModels],
    policyDescription: BYOK_CATALOG_POLICY_DESCRIPTION,
  };
}

function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof SaasIdentityError || isServicePlanError(error)) {
    return new HttpError(error.status, error.code, error.message);
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

export function createSaasPlanCatalogHandler(options: SaasPlanHttpOptions): SaasPlanHttpHandler {
  const publicUrl = new URL(options.publicOrigin);

  return async (req, res) => {
    const requestId = `saas_plan_${randomUUID()}`;
    try {
      const path = routePath(req, publicUrl.origin);
      if (path === undefined) throw new HttpError(400, 'INVALID_PATH', 'Request path is invalid');
      if (!path.startsWith(`${API_PREFIX}/`)) return false;
      const route = findRoute(path);
      if (!route) return false;

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

      // Tenant and project identifiers are selectors only; this call is the authorization check.
      await options.service.resolveTenantContext({ userId: session.userId, tenantId: route.tenantId });
      const plans = await options.planService.listCatalog({ includeRetired: false });
      const items = plans.flatMap((plan) => {
        const item = publicPlan(plan);
        return item ? [item] : [];
      });
      sendJson(res, 200, requestId, items);
      return true;
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, asHttpError(error));
      return true;
    }
  };
}

export const createSaasPlanHttpHandler = createSaasPlanCatalogHandler;
