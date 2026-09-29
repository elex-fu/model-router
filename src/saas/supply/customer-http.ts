import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { SaasIdentityService } from '../identity/service.js';
import type { TenantContext } from '../identity/types.js';
import type { SupplyProfileResolver } from '../keys/types.js';
import type { PlatformCatalogGovernanceQueryService } from '../platform/catalog/service.js';
import { ProviderSupplyError } from './errors.js';
import type { ProviderSupplyService } from './service.js';
import type {
  ProviderAccountRecord,
  ProviderCredentialRecord,
  ProviderCredentialReference,
  ProviderCredentialWriteResult,
  ProviderSupplyAuditContext,
  ProviderSupplyOwner,
  ProviderValidationState,
} from './types.js';

const API_PREFIX = '/console/api/v1';
const SESSION_COOKIE_NAME = 'mr_saas_session';
const CSRF_COOKIE_NAME = 'mr_saas_csrf';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 32 * 1024;
const MAX_CATALOG_PAGES = 100;

export type CustomerByokHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type IdentityPort = Pick<SaasIdentityService, 'getSession' | 'resolveTenantContext' | 'verifyCsrfToken'>;
type SupplyPort = Pick<
  ProviderSupplyService,
  | 'createTenantByokCredential'
  | 'disableTenantProviderCredential'
  | 'enableTenantProviderCredential'
  | 'getProviderAccount'
  | 'listProviderCredentials'
  | 'replaceTenantProviderCredentialSecret'
  | 'revokeTenantProviderCredential'
>;
type CatalogPort = Pick<PlatformCatalogGovernanceQueryService, 'listCapabilities' | 'listProducts' | 'listRights'>;

export interface CustomerByokHttpOptions {
  readonly service: IdentityPort;
  readonly supplyService?: SupplyPort;
  readonly catalog: CatalogPort;
  /** Missing or ambiguous entitlement resolution disables BYOK writes. */
  readonly supplyProfileResolver?: SupplyProfileResolver;
  readonly publicOrigin: string;
  readonly now?: () => Date;
}

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type CredentialRoute = {
  readonly tenantId: string;
  readonly credentialId?: string;
  readonly action?: 'secret' | 'disable' | 'enable' | 'revoke';
};

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function routePath(req: IncomingMessage, baseOrigin: string): string | undefined {
  try {
    return new URL(req.url ?? '/', baseOrigin).pathname;
  } catch {
    return undefined;
  }
}

function pathIdentifier(encoded: string, name: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    return fail(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  if (
    !value ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    return fail(400, 'INVALID_PATH', `The ${name} identifier is invalid`);
  }
  return value;
}

function findRoute(path: string): CredentialRoute | undefined {
  const match = new RegExp(
    `^${API_PREFIX}/tenants/([^/]+)/credentials(?:/([^/]+)(?:/(secret|disable|enable|revoke))?)?$`,
  ).exec(path);
  if (!match) return undefined;
  const tenantId = pathIdentifier(match[1] as string, 'tenant');
  if (!match[2]) return { tenantId };
  const credentialId = pathIdentifier(match[2], 'credential');
  const action = match[3] as CredentialRoute['action'];
  return { tenantId, credentialId, ...(action === undefined ? {} : { action }) };
}

function cookieValue(req: IncomingMessage, cookieName: string): string | undefined {
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return undefined;
  const matches: string[] = [];
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    matches.push(part.slice(separator + 1).trim());
  }
  if (matches.length !== 1) return undefined;
  try {
    return decodeURIComponent(matches[0] as string) || undefined;
  } catch {
    return undefined;
  }
}

function constantTimeMatches(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireSameOrigin(req: IncomingMessage, origin: string, host: string): void {
  const suppliedOrigin = req.headers.origin;
  if (typeof suppliedOrigin !== 'string') fail(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  try {
    const parsed = new URL(suppliedOrigin);
    if (parsed.origin !== origin || suppliedOrigin !== parsed.origin) throw new Error('origin mismatch');
  } catch {
    fail(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
  if (typeof req.headers.host !== 'string') fail(403, 'HOST_REQUIRED', 'The request host is not allowed');
  if (req.headers.host !== host) fail(403, 'HOST_REJECTED', 'The request host is not allowed');
}

async function requireCsrf(req: IncomingMessage, token: string, origin: string, host: string, service: IdentityPort) {
  requireSameOrigin(req, origin, host);
  const cookieToken = cookieValue(req, CSRF_COOKIE_NAME);
  const headerToken = req.headers['x-csrf-token'];
  if (
    !cookieToken ||
    typeof headerToken !== 'string' ||
    !constantTimeMatches(cookieToken, headerToken) ||
    !(await service.verifyCsrfToken(token, cookieToken))
  ) {
    fail(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    req.resume();
    fail(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    req.resume();
    fail(413, 'BODY_TOO_LARGE', 'Request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) fail(413, 'BODY_TOO_LARGE', 'Request body is too large');
  if (size === 0) fail(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return JSON.parse(decoder.decode(Buffer.concat(chunks))) as unknown;
  } catch {
    fail(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function strictObject(value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject {
  const object = asObject(value);
  if (!object) fail(400, 'INVALID_BODY', 'Request body must be a JSON object');
  const allowedKeys = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedKeys.has(key))) {
    fail(400, 'INVALID_BODY', 'Request body contains an unsupported field');
  }
  if (required.some((key) => !Object.hasOwn(object, key))) {
    fail(400, 'INVALID_BODY', 'Request body is missing a required field');
  }
  return object;
}

function requiredText(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    fail(400, 'INVALID_BODY', `${name} is invalid`);
  }
  return value.trim();
}

function requiredSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    fail(400, 'INVALID_BODY', 'secret is invalid');
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(400, 'INVALID_BODY', `${name} must be a positive integer`);
  }
  return value;
}

function optionalExpiry(value: unknown, now: Date): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    fail(400, 'INVALID_BODY', 'expiresAt must be an ISO 8601 UTC timestamp or null');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    fail(400, 'INVALID_BODY', 'expiresAt must be in the future');
  }
  return parsed.toISOString();
}

function sendJson(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  headers?: OutgoingHttpHeaders,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(headers ?? {}),
  });
  res.end(JSON.stringify({ data, meta: { requestId } }));
}

function sendError(res: ServerResponse, requestId: string, error: HttpError, allow?: string): void {
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(allow === undefined ? {} : { allow }),
  });
  res.end(JSON.stringify({ error: { code: error.code, message: error.message, requestId } }));
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ProviderSupplyError) {
    const message =
      error.status === 400
        ? 'The request could not be processed'
        : error.status === 404
          ? 'The requested provider credential was not found'
          : error.status === 409
            ? 'The credential changed or the requested lifecycle transition is unavailable'
            : error.status === 503
              ? 'The credential service is temporarily unavailable'
              : 'The request could not be completed';
    return new HttpError(error.status, error.code, message);
  }
  const candidate = asObject(error);
  const statusValue = candidate?.status ?? candidate?.statusCode;
  switch (statusValue) {
    case 400:
      return new HttpError(400, 'REQUEST_REJECTED', 'The request could not be processed');
    case 401:
      return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
    case 403:
      return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
    case 404:
      return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found');
    case 409:
      return new HttpError(409, 'CONFLICT', 'The request conflicts with the current resource state');
    case 429:
      return new HttpError(429, 'RATE_LIMITED', 'Too many requests');
    case 503:
      return new HttpError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable');
    default:
      return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
  }
}

function requireUserId(session: unknown): string {
  const userId = asObject(session)?.userId;
  if (typeof userId !== 'string' || userId.length === 0) fail(401, 'UNAUTHENTICATED', 'Authentication is required');
  return userId;
}

async function authorizedTenantContext(
  req: IncomingMessage,
  route: CredentialRoute,
  options: CustomerByokHttpOptions,
  origin: string,
  host: string,
  write: boolean,
): Promise<{ readonly token: string; readonly context: TenantContext }> {
  const token = cookieValue(req, SESSION_COOKIE_NAME);
  if (!token) fail(401, 'UNAUTHENTICATED', 'Authentication is required');
  const session = await options.service.getSession(token);
  if (!session) fail(401, 'UNAUTHENTICATED', 'Authentication is required');
  const actorUserId = requireUserId(session);
  if (write) await requireCsrf(req, token, origin, host, options.service);
  const context = await options.service.resolveTenantContext({ userId: actorUserId, tenantId: route.tenantId });
  if (context.userId !== actorUserId || context.tenantId !== route.tenantId) {
    fail(403, 'FORBIDDEN', 'The operation is not permitted');
  }
  if (context.tenantRole !== 'owner' && context.tenantRole !== 'admin') {
    fail(403, 'FORBIDDEN', 'The operation is not permitted');
  }
  return { token, context };
}

function auditForRequest(req: IncomingMessage, context: TenantContext, requestId: string): ProviderSupplyAuditContext {
  const sourceIp = req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  return {
    actorUserId: context.userId,
    entryPoint: 'customer_byok_http',
    sourceIp: typeof sourceIp === 'string' && Buffer.byteLength(sourceIp) <= 128 ? sourceIp : null,
    userAgent: typeof userAgent === 'string' && Buffer.byteLength(userAgent) <= 512 ? userAgent : null,
    requestId,
  };
}

async function requireCurrentByokEntitlement(
  options: CustomerByokHttpOptions,
  context: TenantContext,
  model: string,
): Promise<void> {
  const resolver = options.supplyProfileResolver;
  if (!resolver) {
    fail(503, 'BYOK_PROFILE_UNAVAILABLE', 'The BYOK entitlement and profile resolver is unavailable');
  }
  let resolution: Awaited<ReturnType<SupplyProfileResolver['resolve']>>;
  try {
    resolution = await resolver.resolve(context, 'byok');
  } catch {
    fail(503, 'BYOK_PROFILE_UNAVAILABLE', 'The BYOK entitlement and profile could not be uniquely resolved');
  }
  if (resolution === null) {
    fail(403, 'BYOK_ENTITLEMENT_REQUIRED', 'The current project has no active BYOK entitlement');
  }
  if (
    resolution.mode !== 'byok' ||
    typeof resolution.entitlementId !== 'string' ||
    resolution.entitlementId.trim() === '' ||
    typeof resolution.profileId !== 'string' ||
    resolution.profileId.trim() === '' ||
    !Array.isArray(resolution.allowedModels) ||
    resolution.allowedModels.length === 0 ||
    resolution.allowedModels.some((allowedModel) => typeof allowedModel !== 'string' || allowedModel.trim() === '') ||
    new Set(resolution.allowedModels).size !== resolution.allowedModels.length ||
    !Number.isSafeInteger(resolution.entitlementAuthzVersion) ||
    resolution.entitlementAuthzVersion < 1 ||
    !Number.isSafeInteger(resolution.supplyProfileAuthzVersion) ||
    resolution.supplyProfileAuthzVersion < 1
  ) {
    fail(503, 'BYOK_PROFILE_UNAVAILABLE', 'The BYOK entitlement and profile could not be uniquely resolved');
  }
  if (!resolution.allowedModels.includes(model)) {
    fail(403, 'BYOK_MODEL_NOT_ENTITLED', 'The current project BYOK entitlement does not include this model');
  }
}

async function requireCredentialByokEntitlement(
  options: CustomerByokHttpOptions,
  context: TenantContext,
  account: ProviderAccountRecord,
): Promise<void> {
  if (!Array.isArray(account.capabilities) || account.capabilities.length === 0) {
    fail(403, 'CAPABILITY_NOT_AVAILABLE', 'The provider credential has no approved BYOK capability');
  }
  const seen = new Set<string>();
  for (const capability of account.capabilities) {
    if (
      typeof capability?.model !== 'string' ||
      capability.model.trim() === '' ||
      typeof capability.endpoint !== 'string' ||
      capability.endpoint.trim() === '' ||
      !Number.isSafeInteger(capability.version) ||
      capability.version < 1
    ) {
      fail(503, 'BYOK_PROFILE_UNAVAILABLE', 'The provider credential capability could not be validated');
    }
    const key = `${capability.model}\0${capability.endpoint}`;
    if (seen.has(key)) fail(503, 'BYOK_PROFILE_UNAVAILABLE', 'The provider credential capability is ambiguous');
    seen.add(key);
    await requireCurrentByokEntitlement(options, context, capability.model);
  }
}

function assertTenantOwner(record: ProviderSupplyOwner, tenantId: string): void {
  if (record.ownerKind !== 'tenant' || record.tenantId !== tenantId || record.supplyMode !== 'byok') {
    throw new Error('Provider supply returned a record outside the authorized BYOK tenant scope');
  }
}

function publicAccount(record: ProviderAccountRecord): Record<string, unknown> {
  return {
    id: record.id,
    displayName: record.displayName,
    providerId: record.providerId,
    productId: record.productId,
    credentialType: record.credentialType,
    region: record.region,
    capabilities: record.capabilities.map((capability) => ({ ...capability })),
    status: record.status,
    validationState: record.validationState,
    lastValidatedAt: record.lastValidatedAt,
    authzVersion: record.authzVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabledAt: record.disabledAt,
    revokedAt: record.revokedAt,
  };
}

function publicCredential(record: ProviderCredentialRecord, account: ProviderAccountRecord): Record<string, unknown> {
  return {
    id: record.id,
    supplyMode: 'byok',
    account: publicAccount(account),
    status: record.status,
    validationState: record.validationState,
    secretConfigured: record.currentVersion !== null,
    currentVersion: record.currentVersion,
    expiresAt: record.expiresAt,
    authzVersion: record.authzVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabledAt: record.disabledAt,
    revokedAt: record.revokedAt,
  };
}

function tenantCredentialReference(
  record: ProviderCredentialRecord,
  tenantId: string,
): ProviderCredentialReference & { readonly ownerKind: 'tenant'; readonly tenantId: string } {
  assertTenantOwner(record, tenantId);
  return {
    ownerKind: 'tenant',
    tenantId,
    accountId: record.accountId,
    credentialId: record.id,
    ...(record.currentVersion === null ? {} : { version: record.currentVersion }),
  };
}

async function findTenantCredential(
  supply: SupplyPort,
  tenantId: string,
  credentialId: string,
): Promise<ProviderCredentialRecord> {
  const credentials = await supply.listProviderCredentials({ ownerKind: 'tenant', tenantId });
  const record = credentials.find((candidate) => candidate.id === credentialId);
  if (record?.ownerKind !== 'tenant' || record.tenantId !== tenantId || record.supplyMode !== 'byok') {
    fail(404, 'CREDENTIAL_NOT_FOUND', 'The requested provider credential is not registered');
  }
  return record;
}

async function loadTenantAccount(
  supply: SupplyPort,
  tenantId: string,
  record: ProviderCredentialRecord,
): Promise<ProviderAccountRecord> {
  const account = await supply.getProviderAccount({ ownerKind: 'tenant', tenantId, accountId: record.accountId });
  assertTenantOwner(account, tenantId);
  if (account.id !== record.accountId) throw new Error('Provider supply returned a mismatched account');
  return account;
}

function recordForResponse<T extends { readonly ownerKind: string; readonly tenantId: string | null }>(
  record: T,
  tenantId: string,
): T {
  if (record.ownerKind !== 'tenant' || record.tenantId !== tenantId) {
    throw new Error('Provider supply returned a record outside the authorized tenant scope');
  }
  return record;
}

async function currentByokRights(
  options: CustomerByokHttpOptions,
  selection: {
    readonly providerId: string;
    readonly productId: string;
    readonly credentialType: string;
    readonly region: string;
    readonly purpose: string;
    readonly model: string;
    readonly endpoint: string;
  },
  now: Date,
) {
  let productPage: Awaited<ReturnType<CatalogPort['listProducts']>>;
  let rightsPage: Awaited<ReturnType<CatalogPort['listRights']>>;
  try {
    productPage = await options.catalog.listProducts({
      providerId: selection.providerId,
      productId: selection.productId,
      status: 'active',
      limit: 10,
    });
    if (
      !productPage.items.some(
        (product) =>
          product.providerId === selection.providerId &&
          product.productId === selection.productId &&
          product.status === 'active',
      )
    ) {
      fail(403, 'BYOK_NOT_AVAILABLE', 'This Provider product is not currently available for BYOK credentials');
    }
    rightsPage = await options.catalog.listRights({
      providerId: selection.providerId,
      productId: selection.productId,
      limit: 100,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Provider eligibility could not be checked');
  }

  const candidates = [...rightsPage.items];
  let cursor = rightsPage.nextCursor;
  let pageCount = 1;
  if (rightsPage.hasMore && cursor === null) {
    fail(503, 'CATALOG_UNAVAILABLE', 'Provider eligibility could not be checked');
  }
  while (cursor !== null) {
    if (pageCount >= MAX_CATALOG_PAGES) {
      fail(503, 'CATALOG_UNAVAILABLE', 'Provider eligibility could not be checked');
    }
    try {
      rightsPage = await options.catalog.listRights({
        providerId: selection.providerId,
        productId: selection.productId,
        limit: 100,
        cursor,
      });
    } catch {
      fail(503, 'CATALOG_UNAVAILABLE', 'Provider eligibility could not be checked');
    }
    candidates.push(...rightsPage.items);
    cursor = rightsPage.nextCursor;
    pageCount += 1;
    if (rightsPage.hasMore && cursor === null) {
      fail(503, 'CATALOG_UNAVAILABLE', 'Provider eligibility could not be checked');
    }
  }

  const matchingProduct = candidates.filter(
    (right) => right.providerId === selection.providerId && right.productId === selection.productId,
  );
  const byRightsId = new Map<string, typeof matchingProduct>();
  for (const right of matchingProduct) {
    const versions = byRightsId.get(right.rightsId) ?? [];
    versions.push(right);
    byRightsId.set(right.rightsId, versions);
  }
  const latestEffective = [...byRightsId.values()].flatMap((versions) => {
    const effective = versions
      .filter((right) => {
        const effectiveAt = Date.parse(right.effectiveAt);
        return Number.isFinite(effectiveAt) && effectiveAt <= now.getTime();
      })
      .sort(
        (left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt) || right.version - left.version,
      );
    return effective[0] ? [effective[0]] : [];
  });
  const current = latestEffective
    .filter((right) => {
      const expiresAt = right.expiresAt === null ? undefined : Date.parse(right.expiresAt);
      return (
        right.credentialType === selection.credentialType &&
        right.supplyMode === 'byok' &&
        right.region === selection.region &&
        right.purpose === selection.purpose &&
        right.status === 'active' &&
        right.modelScope.includes(selection.model) &&
        right.endpointScope.includes(selection.endpoint) &&
        (expiresAt === undefined || (Number.isFinite(expiresAt) && expiresAt > now.getTime()))
      );
    })
    .sort(
      (left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt) || right.version - left.version,
    );
  if (current.length === 0) fail(403, 'BYOK_NOT_AVAILABLE', 'No current Provider right permits this BYOK credential');
  const selected = current[0];
  const next = current[1];
  if (
    !selected ||
    (next && Date.parse(selected.effectiveAt) === Date.parse(next.effectiveAt) && selected.version === next.version)
  ) {
    fail(409, 'BYOK_RIGHTS_AMBIGUOUS', 'Provider rights are ambiguous for this credential selection');
  }
  return selected;
}

async function currentVerifiedCapability(
  options: CustomerByokHttpOptions,
  selection: {
    readonly providerId: string;
    readonly productId: string;
    readonly model: string;
    readonly endpoint: string;
  },
) {
  let page: Awaited<ReturnType<CatalogPort['listCapabilities']>>;
  try {
    page = await options.catalog.listCapabilities({ ...selection, limit: 100 });
  } catch {
    fail(503, 'CATALOG_UNAVAILABLE', 'Provider capability could not be checked');
  }
  const candidates = [...page.items];
  let cursor = page.nextCursor;
  let pageCount = 1;
  if (page.hasMore && cursor === null) {
    fail(503, 'CATALOG_UNAVAILABLE', 'Provider capability could not be checked');
  }
  while (cursor !== null) {
    if (pageCount >= MAX_CATALOG_PAGES) {
      fail(503, 'CATALOG_UNAVAILABLE', 'Provider capability could not be checked');
    }
    try {
      page = await options.catalog.listCapabilities({ ...selection, limit: 100, cursor });
    } catch {
      fail(503, 'CATALOG_UNAVAILABLE', 'Provider capability could not be checked');
    }
    candidates.push(...page.items);
    cursor = page.nextCursor;
    pageCount += 1;
    if (page.hasMore && cursor === null) {
      fail(503, 'CATALOG_UNAVAILABLE', 'Provider capability could not be checked');
    }
  }
  const matching = candidates.filter(
    (capability) =>
      capability.providerId === selection.providerId &&
      capability.productId === selection.productId &&
      capability.model === selection.model &&
      capability.endpoint === selection.endpoint,
  );
  const latestVersion = matching.reduce((latest, capability) => Math.max(latest, capability.version), 0);
  const latest = matching.filter((capability) => capability.version === latestVersion);
  if (latestVersion < 1 || latest.length !== 1) {
    fail(403, 'CAPABILITY_NOT_AVAILABLE', 'No current verified capability permits this BYOK credential');
  }
  const capability = latest[0];
  if (capability?.validationState !== 'verified' || capability.supportLevel === 'unsupported') {
    fail(403, 'CAPABILITY_NOT_AVAILABLE', 'No current verified capability permits this BYOK credential');
  }
  return { model: capability.model, endpoint: capability.endpoint, version: capability.version };
}

async function listCredentials(supply: SupplyPort, tenantId: string): Promise<readonly Record<string, unknown>[]> {
  const records = await supply.listProviderCredentials({ ownerKind: 'tenant', tenantId });
  const items: Record<string, unknown>[] = [];
  for (const record of records) {
    if (record.ownerKind !== 'tenant' || record.tenantId !== tenantId || record.supplyMode !== 'byok') continue;
    const account = await loadTenantAccount(supply, tenantId, record);
    items.push(publicCredential(record, account));
  }
  return items;
}

function safeValidationState(value: unknown): ProviderValidationState {
  if (value === 'verified' || value === 'failed' || value === 'unverified') return value;
  throw new Error('Provider supply returned an invalid validation state');
}

export function createCustomerByokHttpHandler(options: CustomerByokHttpOptions): CustomerByokHttpHandler {
  const publicUrl = new URL(options.publicOrigin);
  const now = options.now ?? (() => new Date());

  return async (req, res) => {
    const requestId = `byok_${randomUUID()}`;
    const path = routePath(req, publicUrl.origin);
    if (path === undefined) {
      sendError(res, requestId, new HttpError(400, 'INVALID_PATH', 'Request path is invalid'));
      return true;
    }
    if (!path.startsWith(`${API_PREFIX}/`)) return false;
    let route: CredentialRoute | undefined;
    try {
      route = findRoute(path);
    } catch (error) {
      sendError(res, requestId, toHttpError(error));
      return true;
    }
    if (!route) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const allow = route.credentialId
      ? route.action === 'secret'
        ? 'PUT'
        : route.action
          ? 'POST'
          : 'GET'
      : 'GET, POST';
    const methodAllowed = route.credentialId
      ? route.action === 'secret'
        ? method === 'PUT'
        : route.action
          ? method === 'POST'
          : method === 'GET'
      : method === 'GET' || method === 'POST';
    if (!methodAllowed) {
      req.resume();
      sendError(
        res,
        requestId,
        new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'),
        allow,
      );
      return true;
    }

    try {
      const write = method !== 'GET';
      const { context } = await authorizedTenantContext(req, route, options, publicUrl.origin, publicUrl.host, write);
      const tenantId = context.tenantId;
      const supply = options.supplyService;
      if (!supply) fail(503, 'SERVICE_UNAVAILABLE', 'BYOK credential management is unavailable');

      if (!route.credentialId && method === 'GET') {
        sendJson(res, 200, requestId, { items: await listCredentials(supply, tenantId) });
        return true;
      }

      if (!route.credentialId && method === 'POST') {
        const body = strictObject(
          await readJson(req),
          [
            'displayName',
            'providerId',
            'productId',
            'credentialType',
            'region',
            'purpose',
            'model',
            'endpoint',
            'secret',
            'expiresAt',
          ],
          [
            'displayName',
            'providerId',
            'productId',
            'credentialType',
            'region',
            'purpose',
            'model',
            'endpoint',
            'secret',
          ],
        );
        let secretText = requiredSecret(body.secret);
        const secret = Buffer.from(secretText, 'utf8');
        secretText = '';
        body.secret = '';
        try {
          const selection = {
            providerId: requiredText(body.providerId, 'providerId', 200),
            productId: requiredText(body.productId, 'productId', 200),
            credentialType: requiredText(body.credentialType, 'credentialType', 200),
            region: requiredText(body.region, 'region', 200),
            purpose: requiredText(body.purpose, 'purpose', 200),
            model: requiredText(body.model, 'model', 200),
            endpoint: requiredText(body.endpoint, 'endpoint', 120),
          };
          const displayName = requiredText(body.displayName, 'displayName', 512);
          const currentTime = now();
          if (!(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime())) {
            throw new Error('The configured clock returned an invalid date');
          }
          const expiry = optionalExpiry(body.expiresAt, currentTime);
          await requireCurrentByokEntitlement(options, context, selection.model);
          const right = await currentByokRights(options, selection, currentTime);
          const capability = await currentVerifiedCapability(options, selection);
          const result = await supply.createTenantByokCredential({
            context,
            account: {
              displayName,
              ...selection,
              rightsId: right.rightsId,
              rightsVersion: right.version,
              capability,
            },
            secret,
            ...(expiry === undefined ? {} : { expiresAt: expiry }),
            evidenceReference: right.evidenceReference,
            evidenceSha256: right.evidenceSha256,
            audit: auditForRequest(req, context, requestId),
          });
          assertTenantOwner(result.account, tenantId);
          assertTenantOwner(result.credential, tenantId);
          if (result.credential.accountId !== result.account.id) {
            throw new Error('Provider supply returned a mismatched credential account');
          }
          safeValidationState(result.credential.validationState);
          sendJson(res, 201, requestId, {
            credential: publicCredential(result.credential, result.account),
            version: {
              version: result.version.version,
              status: result.version.status,
              createdAt: result.version.createdAt,
              expiresAt: result.version.expiresAt,
            },
          });
          return true;
        } finally {
          secret.fill(0);
          secretText = '';
          body.secret = '';
        }
      }

      if (!route.credentialId) fail(404, 'NOT_FOUND', 'The requested resource was not found');
      const existing = await findTenantCredential(supply, tenantId, route.credentialId);
      const account = await loadTenantAccount(supply, tenantId, existing);

      if (method === 'GET') {
        sendJson(res, 200, requestId, { credential: publicCredential(existing, account) });
        return true;
      }

      await requireCredentialByokEntitlement(options, context, account);

      if (route.action === 'secret' && method === 'PUT') {
        const body = strictObject(
          await readJson(req),
          ['expectedVersion', 'secret', 'expiresAt'],
          ['expectedVersion', 'secret'],
        );
        const expectedVersion = positiveInteger(body.expectedVersion, 'expectedVersion');
        let secretText = requiredSecret(body.secret);
        const secret = Buffer.from(secretText, 'utf8');
        secretText = '';
        body.secret = '';
        try {
          const currentTime = now();
          if (!(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime())) {
            throw new Error('The configured clock returned an invalid date');
          }
          const expiry = optionalExpiry(body.expiresAt, currentTime);
          const result: ProviderCredentialWriteResult = await supply.replaceTenantProviderCredentialSecret({
            context,
            credential: tenantCredentialReference(existing, tenantId),
            expectedVersion,
            secret,
            ...(expiry === undefined ? {} : { expiresAt: expiry }),
            audit: auditForRequest(req, context, requestId),
          });
          assertTenantOwner(result.credential, tenantId);
          safeValidationState(result.credential.validationState);
          sendJson(res, 200, requestId, {
            credential: publicCredential(result.credential, account),
            version: {
              version: result.version.version,
              status: result.version.status,
              createdAt: result.version.createdAt,
              expiresAt: result.version.expiresAt,
            },
          });
          return true;
        } finally {
          secret.fill(0);
          secretText = '';
          body.secret = '';
        }
      }

      const action = route.action;
      if (action === 'disable' || action === 'enable' || action === 'revoke') {
        const body = strictObject(await readJson(req), ['expectedAuthzVersion'], ['expectedAuthzVersion']);
        const expectedAuthzVersion = positiveInteger(body.expectedAuthzVersion, 'expectedAuthzVersion');
        const change = {
          context,
          credential: tenantCredentialReference(existing, tenantId),
          expectedAuthzVersion,
          audit: auditForRequest(req, context, requestId),
        };
        const result =
          action === 'disable'
            ? await supply.disableTenantProviderCredential(change)
            : action === 'enable'
              ? await supply.enableTenantProviderCredential(change)
              : await supply.revokeTenantProviderCredential(change);
        recordForResponse(result, tenantId);
        safeValidationState(result.validationState);
        sendJson(res, 200, requestId, { credential: publicCredential(result, account) });
        return true;
      }

      fail(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      sendError(res, requestId, toHttpError(error));
      return true;
    }
  };
}
