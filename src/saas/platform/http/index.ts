import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  type ProviderRightsAuditContext,
  type ProviderRightsRecord,
  type RegisterProviderRightsVersionInput,
  type RevokeProviderRightsInput,
  SaasCatalogError,
} from '../../catalog/index.js';
import {
  type CommercialPriceVersionRecord,
  isSaasPricingError,
  type PlatformPriceVersionHistoryPage,
  type PlatformPriceVersionHistoryQuery,
  type PlatformPriceVersionKind,
  type PlatformPricingTargetPage,
  type PlatformPricingTargetRecord,
  type RateSetInput,
  type RegisterPlatformPriceVersionInput,
  SaasPricingError,
  type SaasPricingService,
} from '../../pricing/index.js';
import { ProviderSupplyError } from '../../supply/errors.js';
import type {
  PlatformProviderAccountCreateInput,
  PlatformProviderAccountLifecycleInput,
  PlatformProviderCredentialCreateInput,
  PlatformProviderCredentialLifecycleInput,
  PlatformProviderCredentialSecretRotationInput,
} from '../../supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCredentialRecord,
  ProviderCredentialVersionRecord,
  ProviderCredentialWriteResult,
} from '../../supply/types.js';
import {
  hasPlatformRole,
  PLATFORM_ADMIN_ROLES,
  type PlatformAdminAccessRequest,
  type PlatformAdminAccessService,
  type PlatformAdminActor,
} from '../access/index.js';
import {
  isPlatformAuditQueryError,
  type PlatformAuditHistoryListQuery,
  type PlatformAuditHistoryPage,
} from '../audit/index.js';
import {
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_MAX_BODY_BYTES,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../auth/http.js';
import {
  CAPACITY_POLICY_REASONS,
  CapacityPolicyError,
  type CapacityPolicyLimits,
  type CapacityPolicyReason,
  type CapacityPolicyRecord,
  type PlatformCapacityPolicyService,
} from '../capacity-policy-service.js';

export const PLATFORM_ADMIN_READ_PREFIX = '/admin/api/v1' as const;

export const PLATFORM_ADMIN_READ_PATHS = Object.freeze({
  me: `${PLATFORM_ADMIN_READ_PREFIX}/me`,
  operationsSummary: `${PLATFORM_ADMIN_READ_PREFIX}/ops/summary`,
  products: `${PLATFORM_ADMIN_READ_PREFIX}/catalog/products`,
  capabilities: `${PLATFORM_ADMIN_READ_PREFIX}/catalog/capabilities`,
  rights: `${PLATFORM_ADMIN_READ_PREFIX}/catalog/rights`,
  auditEvents: `${PLATFORM_ADMIN_READ_PREFIX}/audit/events`,
  pricingTargets: `${PLATFORM_ADMIN_READ_PREFIX}/pricing/targets`,
  pricingVersions: `${PLATFORM_ADMIN_READ_PREFIX}/pricing/versions`,
  supplyAccounts: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts`,
  supplyAccountCredentials: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts/:accountId/credentials`,
  tenantCapacityPolicy: `${PLATFORM_ADMIN_READ_PREFIX}/capacity/tenants/:tenantId`,
  projectCapacityPolicy: `${PLATFORM_ADMIN_READ_PREFIX}/capacity/tenants/:tenantId/projects/:projectId`,
  apiKeyCapacityPolicy: `${PLATFORM_ADMIN_READ_PREFIX}/capacity/tenants/:tenantId/projects/:projectId/api-keys/:apiKeyId`,
  capacityTenantTargets: `${PLATFORM_ADMIN_READ_PREFIX}/capacity/targets/tenants`,
  capacityProjectTargets: `${PLATFORM_ADMIN_READ_PREFIX}/capacity/targets/tenants/:tenantId/projects`,
  capacityApiKeyTargets: `${PLATFORM_ADMIN_READ_PREFIX}/capacity/targets/tenants/:tenantId/projects/:projectId/api-keys`,
} as const);

export const PLATFORM_ADMIN_WRITE_PATHS = Object.freeze({
  /** POST is also accepted on the existing `/catalog/rights` collection path. */
  registerRightsVersion: `${PLATFORM_ADMIN_READ_PREFIX}/catalog/rights/versions`,
  revokeRights: `${PLATFORM_ADMIN_READ_PREFIX}/catalog/rights/:rightsId/revoke`,
  createSupplyAccount: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts`,
  createSupplyAccountCredential: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts/:accountId/credentials`,
  rotateSupplyCredentialSecret: `${PLATFORM_ADMIN_READ_PREFIX}/supply/credentials/:credentialId/secret`,
  enableSupplyAccount: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts/:accountId/enable`,
  disableSupplyAccount: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts/:accountId/disable`,
  revokeSupplyAccount: `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts/:accountId/revoke`,
  enableSupplyCredential: `${PLATFORM_ADMIN_READ_PREFIX}/supply/credentials/:credentialId/enable`,
  disableSupplyCredential: `${PLATFORM_ADMIN_READ_PREFIX}/supply/credentials/:credentialId/disable`,
  revokeSupplyCredential: `${PLATFORM_ADMIN_READ_PREFIX}/supply/credentials/:credentialId/revoke`,
  registerCustomerPriceVersion: `${PLATFORM_ADMIN_READ_PREFIX}/pricing/customer-versions`,
  registerSupplierCostVersion: `${PLATFORM_ADMIN_READ_PREFIX}/pricing/supplier-cost-versions`,
} as const);

export interface PlatformAdminOperationsSummaryQuery {
  readonly from: string;
  readonly to: string;
}

export interface PlatformAdminCatalogReadQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly providerId?: string;
}

/** The access boundary is injected so the transport remains independently testable and composable. */
export type PlatformAdminReadAccess = Pick<PlatformAdminAccessService, 'authenticate'>;

/** Read-service results intentionally remain opaque until they cross the JSON response boundary. */
export interface PlatformAdminReadOperationsService {
  getSummary(query: PlatformAdminOperationsSummaryQuery): Promise<unknown>;
}

export type PlatformAdminRegisterRightsVersionInput = Omit<RegisterProviderRightsVersionInput, 'audit'> & {
  readonly audit: ProviderRightsAuditContext;
};

export type PlatformAdminRevokeRightsInput = Omit<RevokeProviderRightsInput, 'audit'> & {
  readonly audit: ProviderRightsAuditContext;
};

/** Read-service results intentionally remain opaque until they cross the JSON response boundary. */
export interface PlatformAdminReadCatalogService {
  listProducts(query: PlatformAdminCatalogReadQuery): Promise<unknown>;
  listCapabilities(query: PlatformAdminCatalogReadQuery): Promise<unknown>;
  listRights(query: PlatformAdminCatalogReadQuery): Promise<unknown>;
  /** Writes receive an HTTP-generated audit context and must commit it atomically. */
  registerProviderRightsVersion?(input: PlatformAdminRegisterRightsVersionInput): Promise<ProviderRightsRecord>;
  /** Writes receive an HTTP-generated audit context and must commit it atomically. */
  revokeProviderRights?(input: PlatformAdminRevokeRightsInput): Promise<ProviderRightsRecord>;
}

/**
 * Platform-only supply operations. Implementations must keep these calls
 * metadata-only at the transport boundary and commit the supplied audit
 * context in the same transaction as each mutation.
 */
export interface PlatformAdminSupplyService {
  listPlatformProviderAccounts(): Promise<readonly ProviderAccountRecord[]>;
  createPlatformProviderAccount(input: PlatformProviderAccountCreateInput): Promise<ProviderAccountRecord>;
  listPlatformProviderCredentials(accountId: string): Promise<readonly ProviderCredentialRecord[]>;
  createPlatformProviderCredential(
    input: PlatformProviderCredentialCreateInput,
  ): Promise<ProviderCredentialWriteResult>;
  replacePlatformProviderCredentialSecret(
    input: PlatformProviderCredentialSecretRotationInput,
  ): Promise<ProviderCredentialWriteResult>;
  enablePlatformProviderAccount(input: PlatformProviderAccountLifecycleInput): Promise<ProviderAccountRecord>;
  disablePlatformProviderAccount(input: PlatformProviderAccountLifecycleInput): Promise<ProviderAccountRecord>;
  revokePlatformProviderAccount(input: PlatformProviderAccountLifecycleInput): Promise<ProviderAccountRecord>;
  enablePlatformProviderCredential(input: PlatformProviderCredentialLifecycleInput): Promise<ProviderCredentialRecord>;
  disablePlatformProviderCredential(input: PlatformProviderCredentialLifecycleInput): Promise<ProviderCredentialRecord>;
  revokePlatformProviderCredential(input: PlatformProviderCredentialLifecycleInput): Promise<ProviderCredentialRecord>;
}

export interface PlatformAdminWriteHttpSecurity {
  readonly publicOrigin: string;
  readonly authService: Pick<PlatformAdminAuthHttpService, 'verifyCsrfToken'>;
}

/** Audit results are the service's safe metadata-only projection. */
export interface PlatformAdminReadAuditService {
  listEvents(query: PlatformAuditHistoryListQuery): Promise<PlatformAuditHistoryPage>;
}

export type PlatformAdminPricingService = Pick<
  SaasPricingService,
  | 'listPlatformPricingTargets'
  | 'listPlatformPriceVersionHistory'
  | 'registerPlatformCustomerPriceVersion'
  | 'registerPlatformSupplierCostVersion'
>;

export type PlatformAdminCapacityPolicyService = Pick<
  PlatformCapacityPolicyService,
  | 'getTenantPolicy'
  | 'getProjectPolicy'
  | 'getApiKeyPolicy'
  | 'setTenantPolicy'
  | 'setProjectPolicy'
  | 'setApiKeyPolicy'
>;

export interface PlatformAdminCapacityPolicyTargetSelectors {
  /** Return at most `limit` tenant UUIDs after the optional UUID cursor. */
  listTenantIds(afterId: string | undefined, limit: number): Promise<readonly string[]>;
  /** Return IDs only, constrained to the selected tenant. */
  listProjectIds(tenantId: string, afterId: string | undefined, limit: number): Promise<readonly string[]>;
  /** Return IDs only, constrained to the selected tenant and project. */
  listApiKeyIds(
    tenantId: string,
    projectId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<readonly string[]>;
}

export interface PlatformAdminReadHandlerOptions {
  readonly access: PlatformAdminReadAccess;
  readonly operations: PlatformAdminReadOperationsService;
  readonly catalog: PlatformAdminReadCatalogService;
  /** Omitted when cursor signing is not configured; audit reads then return 503. */
  readonly audit?: PlatformAdminReadAuditService;
  /** Omitted until startup wires the transactionally audited price registry. */
  readonly pricing?: PlatformAdminPricingService;
  /** Omitted until startup wires the transactional platform-supply service. */
  readonly supply?: PlatformAdminSupplyService;
  /** Omitted until startup wires the audited bounded-capacity policy service. */
  readonly capacityPolicies?: PlatformAdminCapacityPolicyService;
  /** Omitted until startup wires the restricted, identifier-only target selectors. */
  readonly capacityPolicyTargets?: PlatformAdminCapacityPolicyTargetSelectors;
  /** Omitted until the startup composition wires the transactional catalog writer. */
  readonly writeSecurity?: PlatformAdminWriteHttpSecurity;
}

export type PlatformAdminReadHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
export type PlatformAdminReadHandler = PlatformAdminReadHttpHandler;
export type PlatformAdminReadHttpOptions = PlatformAdminReadHandlerOptions;

type ReadRoute =
  | 'me'
  | 'operationsSummary'
  | 'products'
  | 'capabilities'
  | 'rights'
  | 'auditEvents'
  | 'pricingTargets'
  | 'pricingVersions';
type SupplyRoute =
  | 'supplyAccounts'
  | 'supplyAccountCredentials'
  | 'rotateSupplyCredentialSecret'
  | 'supplyAccountLifecycle'
  | 'supplyCredentialLifecycle'
  | 'registerCustomerPriceVersion'
  | 'registerSupplierCostVersion';
type CapacityPolicyRoute = 'tenantCapacityPolicy' | 'projectCapacityPolicy' | 'apiKeyCapacityPolicy';
type CapacityPolicySelectorRoute = 'capacityTenantTargets' | 'capacityProjectTargets' | 'capacityApiKeyTargets';
type WriteRoute =
  | 'registerRightsVersion'
  | 'revokeRights'
  | 'createSupplyAccount'
  | 'rotateSupplyCredentialSecret'
  | 'supplyAccountLifecycle'
  | 'supplyCredentialLifecycle';
type Route = ReadRoute | SupplyRoute | WriteRoute | CapacityPolicyRoute | CapacityPolicySelectorRoute;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'PlatformAdminReadHttpError';
  }
}

const CATALOG_MAX_LIMIT = 100;
const AUDIT_MAX_LIMIT = 100;
const MAX_BODY_TEXT_LENGTH = 512;
const MAX_ID_LENGTH = 200;
const MAX_SCOPE_LENGTH = 200;
const MAX_SCOPE_VALUES = 100;
const MAX_EVIDENCE_HASH_LENGTH = 64;
const MAX_SECRET_BYTES = 16 * 1024;
const SUPPLY_LIFECYCLE_ACTIONS = ['enable', 'disable', 'revoke'] as const;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u;

function hasQueryControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  extraHeaders?: OutgoingHttpHeaders,
): void {
  const body = JSON.stringify({ data, meta: { requestId } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

function sendError(res: ServerResponse, requestId: string, error: HttpError, extraHeaders?: OutgoingHttpHeaders): void {
  const body = JSON.stringify({
    error: {
      code: error.code,
      message: error.safeMessage,
      requestId,
    },
  });
  res.writeHead(error.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

function invalidQuery(): never {
  throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid.');
}

function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://platform-admin.invalid');
  } catch {
    return undefined;
  }
}

type CapacityPolicyTarget =
  | { readonly route: 'tenantCapacityPolicy'; readonly tenantId: string }
  | { readonly route: 'projectCapacityPolicy'; readonly tenantId: string; readonly projectId: string }
  | {
      readonly route: 'apiKeyCapacityPolicy';
      readonly tenantId: string;
      readonly projectId: string;
      readonly apiKeyId: string;
    };

const CAPACITY_TENANTS_PREFIX = `${PLATFORM_ADMIN_READ_PREFIX}/capacity/tenants/`;
const CAPACITY_TARGETS_PREFIX = `${PLATFORM_ADMIN_READ_PREFIX}/capacity/targets/`;
const CAPACITY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CAPACITY_SELECTOR_PAGE_SIZE = 25;

function capacityPolicyRoute(path: string): CapacityPolicyRoute | undefined {
  if (!path.startsWith(CAPACITY_TENANTS_PREFIX)) return undefined;
  const segments = path.slice(CAPACITY_TENANTS_PREFIX.length).split('/');
  if (segments.length === 1 && segments[0] !== '') return 'tenantCapacityPolicy';
  if (segments.length === 3 && segments[0] !== '' && segments[1] === 'projects' && segments[2] !== '') {
    return 'projectCapacityPolicy';
  }
  if (
    segments.length === 5 &&
    segments[0] !== '' &&
    segments[1] === 'projects' &&
    segments[2] !== '' &&
    segments[3] === 'api-keys' &&
    segments[4] !== ''
  ) {
    return 'apiKeyCapacityPolicy';
  }
  return undefined;
}

function decodeCapacityPathId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  if (
    decoded.length === 0 ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    [...decoded].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  return decoded;
}

function capacityPolicyTarget(path: string): CapacityPolicyTarget {
  const route = capacityPolicyRoute(path);
  if (!route) throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  const segments = path.slice(CAPACITY_TENANTS_PREFIX.length).split('/');
  const tenantId = decodeCapacityPathId(segments[0] as string);
  if (route === 'tenantCapacityPolicy') return { route, tenantId };
  const projectId = decodeCapacityPathId(segments[2] as string);
  if (route === 'projectCapacityPolicy') return { route, tenantId, projectId };
  return { route, tenantId, projectId, apiKeyId: decodeCapacityPathId(segments[4] as string) };
}

type CapacityPolicySelectorTarget =
  | { readonly route: 'capacityTenantTargets' }
  | { readonly route: 'capacityProjectTargets'; readonly tenantId: string }
  | { readonly route: 'capacityApiKeyTargets'; readonly tenantId: string; readonly projectId: string };

function capacityPolicySelectorRoute(path: string): CapacityPolicySelectorRoute | undefined {
  if (path === `${CAPACITY_TARGETS_PREFIX}tenants`) return 'capacityTenantTargets';
  if (!path.startsWith(`${CAPACITY_TARGETS_PREFIX}tenants/`)) return undefined;
  const segments = path.slice(`${CAPACITY_TARGETS_PREFIX}tenants/`.length).split('/');
  if (segments.length === 2 && segments[0] !== '' && segments[1] === 'projects') {
    return 'capacityProjectTargets';
  }
  if (
    segments.length === 4 &&
    segments[0] !== '' &&
    segments[1] === 'projects' &&
    segments[2] !== '' &&
    segments[3] === 'api-keys'
  ) {
    return 'capacityApiKeyTargets';
  }
  return undefined;
}

function capacitySelectorId(value: string): string {
  const id = decodeCapacityPathId(value);
  if (!CAPACITY_UUID_PATTERN.test(id)) throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  return id.toLowerCase();
}

function capacityPolicySelectorTarget(path: string): CapacityPolicySelectorTarget {
  const route = capacityPolicySelectorRoute(path);
  if (!route) throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  if (route === 'capacityTenantTargets') return { route };
  const segments = path.slice(`${CAPACITY_TARGETS_PREFIX}tenants/`.length).split('/');
  const tenantId = capacitySelectorId(segments[0] as string);
  if (route === 'capacityProjectTargets') return { route, tenantId };
  return { route, tenantId, projectId: capacitySelectorId(segments[2] as string) };
}

function routeForPath(path: string): Route | undefined {
  const selectorRoute = capacityPolicySelectorRoute(path);
  if (selectorRoute) return selectorRoute;
  const capacityRoute = capacityPolicyRoute(path);
  if (capacityRoute) return capacityRoute;
  switch (path) {
    case PLATFORM_ADMIN_READ_PATHS.me:
      return 'me';
    case PLATFORM_ADMIN_READ_PATHS.operationsSummary:
      return 'operationsSummary';
    case PLATFORM_ADMIN_READ_PATHS.products:
      return 'products';
    case PLATFORM_ADMIN_READ_PATHS.capabilities:
      return 'capabilities';
    case PLATFORM_ADMIN_READ_PATHS.rights:
      return 'rights';
    case PLATFORM_ADMIN_READ_PATHS.auditEvents:
      return 'auditEvents';
    case PLATFORM_ADMIN_READ_PATHS.pricingTargets:
      return 'pricingTargets';
    case PLATFORM_ADMIN_READ_PATHS.pricingVersions:
      return 'pricingVersions';
    case PLATFORM_ADMIN_READ_PATHS.supplyAccounts:
      return 'supplyAccounts';
    case PLATFORM_ADMIN_WRITE_PATHS.registerRightsVersion:
      return 'registerRightsVersion';
    case PLATFORM_ADMIN_WRITE_PATHS.registerCustomerPriceVersion:
      return 'registerCustomerPriceVersion';
    case PLATFORM_ADMIN_WRITE_PATHS.registerSupplierCostVersion:
      return 'registerSupplierCostVersion';
    default: {
      if (path.startsWith(`${PLATFORM_ADMIN_READ_PREFIX}/catalog/rights/`) && path.endsWith('/revoke')) {
        return 'revokeRights';
      }
      const accountPrefix = `${PLATFORM_ADMIN_READ_PREFIX}/supply/accounts/`;
      if (path.startsWith(accountPrefix)) {
        const segments = path.slice(accountPrefix.length).split('/');
        if (segments.length === 2 && segments[1] === 'credentials') return 'supplyAccountCredentials';
        if (
          segments.length === 2 &&
          SUPPLY_LIFECYCLE_ACTIONS.includes(segments[1] as (typeof SUPPLY_LIFECYCLE_ACTIONS)[number])
        ) {
          return 'supplyAccountLifecycle';
        }
      }
      const credentialPrefix = `${PLATFORM_ADMIN_READ_PREFIX}/supply/credentials/`;
      if (path.startsWith(credentialPrefix)) {
        const segments = path.slice(credentialPrefix.length).split('/');
        if (segments.length === 2 && segments[1] === 'secret') return 'rotateSupplyCredentialSecret';
        if (
          segments.length === 2 &&
          SUPPLY_LIFECYCLE_ACTIONS.includes(segments[1] as (typeof SUPPLY_LIFECYCLE_ACTIONS)[number])
        ) {
          return 'supplyCredentialLifecycle';
        }
      }
      return undefined;
    }
  }
}

interface WriteOriginPolicy {
  readonly origin: string;
  readonly host: string;
}

function parseWriteOrigin(value: string): WriteOriginPolicy {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('writeSecurity.publicOrigin must be an origin string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('writeSecurity.publicOrigin must be a valid HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('writeSecurity.publicOrigin must be a valid HTTP(S) origin');
  }
  return { origin: parsed.origin, host: parsed.host };
}

function rightsIdFromRevokePath(path: string): string {
  const prefix = `${PLATFORM_ADMIN_READ_PREFIX}/catalog/rights/`;
  const suffix = '/revoke';
  const encoded = path.slice(prefix.length, -suffix.length);
  if (encoded.length === 0 || encoded.includes('/')) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  if (
    decoded.length === 0 ||
    decoded.length > MAX_ID_LENGTH ||
    decoded.trim() !== decoded ||
    decoded.includes('/') ||
    [...decoded].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  return decoded;
}

function supplyPathId(path: string, kind: 'accounts' | 'credentials', suffix: string): string {
  const prefix = `${PLATFORM_ADMIN_READ_PREFIX}/supply/${kind}/`;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  const encoded = path.slice(prefix.length, -suffix.length);
  if (encoded.length === 0 || encoded.includes('/')) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  if (
    decoded.length === 0 ||
    decoded.length > MAX_ID_LENGTH ||
    decoded.trim() !== decoded ||
    decoded.includes('/') ||
    [...decoded].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  return decoded;
}

function supplyLifecycleAction(path: string, kind: 'accounts' | 'credentials'): 'enable' | 'disable' | 'revoke' {
  const prefix = `${PLATFORM_ADMIN_READ_PREFIX}/supply/${kind}/`;
  const suffix = path.slice(prefix.length);
  const action = suffix.slice(suffix.indexOf('/') + 1);
  if (action !== 'enable' && action !== 'disable' && action !== 'revoke') {
    throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  return action;
}

function queryValues(url: URL, allowedKeys: readonly string[]): Map<string, string> {
  const allowed = new Set(allowedKeys);
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || values.has(key)) invalidQuery();
    values.set(key, value);
  }
  return values;
}

function nonEmptyQueryValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0 || value.trim().length === 0 || hasQueryControlCharacter(value)) {
    invalidQuery();
  }
  return value;
}

function optionalQueryValue(values: Map<string, string>, key: string): string | undefined {
  if (!values.has(key)) return undefined;
  return nonEmptyQueryValue(values, key);
}

function queryLimit(values: Map<string, string>): number | undefined {
  if (!values.has('limit')) return undefined;
  const value = nonEmptyQueryValue(values, 'limit');
  if (!/^\d+$/u.test(value)) invalidQuery();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_MAX_LIMIT) invalidQuery();
  return limit;
}

function catalogQuery(url: URL, acceptsProviderId: boolean): PlatformAdminCatalogReadQuery {
  const values = queryValues(url, acceptsProviderId ? ['limit', 'cursor', 'providerId'] : ['limit', 'cursor']);
  const limit = queryLimit(values);
  const cursor = optionalQueryValue(values, 'cursor');
  const providerId = acceptsProviderId ? optionalQueryValue(values, 'providerId') : undefined;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(providerId === undefined ? {} : { providerId }),
  };
}

function auditQuery(url: URL): PlatformAuditHistoryListQuery {
  const values = queryValues(url, [
    'actorId',
    'action',
    'entityType',
    'createdFrom',
    'createdTo',
    'from',
    'to',
    'limit',
    'cursor',
  ]);
  if (values.has('createdFrom') && values.has('from')) invalidQuery();
  if (values.has('createdTo') && values.has('to')) invalidQuery();

  const actorId = optionalQueryValue(values, 'actorId');
  const action = optionalQueryValue(values, 'action');
  const entityType = optionalQueryValue(values, 'entityType');
  const createdFrom = optionalQueryValue(values, 'createdFrom');
  const createdTo = optionalQueryValue(values, 'createdTo');
  const from = optionalQueryValue(values, 'from');
  const to = optionalQueryValue(values, 'to');
  const limit = queryLimit(values);
  if (limit !== undefined && limit > AUDIT_MAX_LIMIT) invalidQuery();
  const cursor = optionalQueryValue(values, 'cursor');

  return {
    ...(actorId === undefined ? {} : { actorId }),
    ...(action === undefined ? {} : { action }),
    ...(entityType === undefined ? {} : { entityType }),
    ...(createdFrom === undefined ? {} : { createdFrom }),
    ...(createdTo === undefined ? {} : { createdTo }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function operationsQuery(url: URL): PlatformAdminOperationsSummaryQuery {
  const values = queryValues(url, ['from', 'to']);
  return {
    from: nonEmptyQueryValue(values, 'from'),
    to: nonEmptyQueryValue(values, 'to'),
  };
}

function capacityPolicySelectorCursor(url: URL): string | undefined {
  const values = queryValues(url, ['cursor']);
  const cursor = values.get('cursor');
  if (cursor === undefined) return undefined;
  if (!CAPACITY_UUID_PATTERN.test(cursor)) invalidQuery();
  return cursor.toLowerCase();
}

function queryPriceVersionKind(values: Map<string, string>): PlatformPriceVersionKind {
  const kind = nonEmptyQueryValue(values, 'kind');
  if (kind !== 'customer' && kind !== 'supplier') invalidQuery();
  return kind;
}

function platformPricingTargetQuery(url: URL): {
  readonly kind: PlatformPriceVersionKind;
  readonly limit?: number;
  readonly cursor?: string;
} {
  const values = queryValues(url, ['kind', 'limit', 'cursor']);
  const kind = queryPriceVersionKind(values);
  const limit = queryLimit(values);
  const cursor = optionalQueryValue(values, 'cursor');
  if (cursor !== undefined && !/^(0|[1-9][0-9]{0,14})$/u.test(cursor)) invalidQuery();
  return {
    kind,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function platformPriceVersionHistoryQuery(url: URL): PlatformPriceVersionHistoryQuery {
  const values = queryValues(url, [
    'kind',
    'publicModelId',
    'publicModelVersion',
    'protocol',
    'endpoint',
    'currency',
    'limit',
    'cursor',
  ]);
  const kind = queryPriceVersionKind(values);
  const publicModelVersion = nonEmptyQueryValue(values, 'publicModelVersion');
  const modelVersionNumber = Number(publicModelVersion);
  if (
    !/^[1-9][0-9]{0,9}$/u.test(publicModelVersion) ||
    !Number.isSafeInteger(modelVersionNumber) ||
    modelVersionNumber > 2_147_483_647
  ) {
    invalidQuery();
  }
  const currency = nonEmptyQueryValue(values, 'currency');
  if (!/^[A-Z]{3}$/u.test(currency)) invalidQuery();
  const limit = queryLimit(values);
  const cursor = optionalQueryValue(values, 'cursor');
  if (cursor !== undefined) {
    const cursorVersion = Number(cursor);
    if (!/^[1-9][0-9]{0,15}$/u.test(cursor) || !Number.isSafeInteger(cursorVersion)) invalidQuery();
  }
  return {
    kind,
    publicModelId: nonEmptyQueryValue(values, 'publicModelId'),
    publicModelVersion,
    protocol: nonEmptyQueryValue(values, 'protocol'),
    endpoint: nonEmptyQueryValue(values, 'endpoint'),
    currency,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function drainRequest(req: IncomingMessage): void {
  req.resume();
}

function contentTypeIsJson(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!contentTypeIsJson(req.headers['content-type'])) {
    drainRequest(req);
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }

  const rawLength = req.headers['content-length'];
  if (typeof rawLength === 'string') {
    if (!/^\d+$/u.test(rawLength)) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      drainRequest(req);
      throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
    }
    if (declaredLength > PLATFORM_ADMIN_MAX_BODY_BYTES) {
      drainRequest(req);
      throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
  } else if (Array.isArray(rawLength)) {
    drainRequest(req);
    throw new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= PLATFORM_ADMIN_MAX_BODY_BYTES) chunks.push(buffer);
    else tooLarge = true;
  }
  if (tooLarge) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON request body is required');

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return JSON.parse(decoder.decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function parseStrictObject(value: unknown, allowed: readonly string[], required: readonly string[]): JsonObject {
  const object = asObject(value);
  if (!object) throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object');
  const allowedKeys = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an unsupported field');
  }
  if (required.some((key) => !Object.hasOwn(object, key))) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is missing a required field');
  }
  return object;
}

function bodyText(object: JsonObject, key: string, maxLength = MAX_BODY_TEXT_LENGTH): string {
  const value = object[key];
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid field');
  }
  return normalized;
}

function optionalBodyText(object: JsonObject, key: string, maxLength = MAX_BODY_TEXT_LENGTH): string | undefined {
  return Object.hasOwn(object, key) ? bodyText(object, key, maxLength) : undefined;
}

function bodyScope(object: JsonObject, key: string): string[] {
  const value = object[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_VALUES) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid scope');
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string') throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid scope');
    if (entry.length === 0 || entry.length > MAX_SCOPE_LENGTH || entry.trim() !== entry || entry === '*') {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid scope');
    }
    if (
      [...entry].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid scope');
    }
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid scope');
  }
  return normalized;
}

function bodyTimestamp(object: JsonObject, key: string, required: boolean): string | undefined {
  if (!Object.hasOwn(object, key)) {
    if (required) throw new HttpError(400, 'INVALID_BODY', 'Request body is missing a required field');
    return undefined;
  }
  const value = object[key];
  if (typeof value !== 'string' || value.length > 128) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid date');
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const daysInMonth =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid date');
  }
  return value;
}

function bodyHash(object: JsonObject, key: string): string {
  const value = bodyText(object, key, MAX_EVIDENCE_HASH_LENGTH);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid evidence digest');
  }
  return value;
}

function bodyPositiveInteger(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid integer');
  }
  return value;
}

function optionalBodyTimestampOrNull(object: JsonObject, key: string): string | null | undefined {
  if (!Object.hasOwn(object, key)) return undefined;
  if (object[key] === null) return null;
  return bodyTimestamp(object, key, true);
}

function bodySecret(object: JsonObject): Uint8Array {
  const value = object.secret;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid secret');
  }
  return Buffer.from(value, 'utf8');
}

function bodyCapabilities(object: JsonObject): readonly { model: string; endpoint: string; version: number }[] {
  const value = object.capabilities;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_VALUES) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid capability list');
  }
  const capabilities = value.map((entry) => {
    const capability = asObject(entry);
    if (!capability) throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid capability');
    const normalized = parseStrictObject(
      capability,
      ['model', 'endpoint', 'version'],
      ['model', 'endpoint', 'version'],
    );
    return {
      model: bodyText(normalized, 'model', MAX_SCOPE_LENGTH),
      endpoint: bodyText(normalized, 'endpoint', MAX_SCOPE_LENGTH),
      version: bodyPositiveInteger(normalized, 'version'),
    };
  });
  const keys = capabilities.map(
    (capability) => `${capability.model}\u0000${capability.endpoint}\u0000${capability.version}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid capability list');
  }
  return capabilities;
}

function parseSupplyAccountBody(value: unknown): Omit<PlatformProviderAccountCreateInput, 'audit'> {
  const object = parseStrictObject(
    value,
    [
      'id',
      'displayName',
      'providerId',
      'productId',
      'credentialType',
      'region',
      'purpose',
      'rightsId',
      'rightsVersion',
      'capabilities',
    ],
    [
      'displayName',
      'providerId',
      'productId',
      'credentialType',
      'region',
      'purpose',
      'rightsId',
      'rightsVersion',
      'capabilities',
    ],
  );
  const id = optionalBodyText(object, 'id', MAX_ID_LENGTH);
  return {
    ...(id === undefined ? {} : { id }),
    displayName: bodyText(object, 'displayName', 200),
    providerId: bodyText(object, 'providerId', MAX_ID_LENGTH),
    productId: bodyText(object, 'productId', MAX_ID_LENGTH),
    credentialType: bodyText(object, 'credentialType', MAX_ID_LENGTH),
    region: bodyText(object, 'region', MAX_ID_LENGTH),
    purpose: bodyText(object, 'purpose', MAX_ID_LENGTH),
    rightsId: bodyText(object, 'rightsId', MAX_ID_LENGTH),
    rightsVersion: bodyPositiveInteger(object, 'rightsVersion'),
    capabilities: bodyCapabilities(object),
  };
}

function parseSupplyCredentialCreateBody(
  value: unknown,
): Omit<PlatformProviderCredentialCreateInput, 'accountId' | 'audit'> {
  const object = parseStrictObject(value, ['id', 'secret', 'expiresAt'], ['secret']);
  const id = optionalBodyText(object, 'id', MAX_ID_LENGTH);
  const expiresAt = optionalBodyTimestampOrNull(object, 'expiresAt');
  return {
    ...(id === undefined ? {} : { id }),
    secret: bodySecret(object),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function parseSupplyCredentialRotationBody(
  value: unknown,
): Omit<PlatformProviderCredentialSecretRotationInput, 'credentialId' | 'audit'> {
  const object = parseStrictObject(value, ['expectedVersion', 'secret', 'expiresAt'], ['expectedVersion', 'secret']);
  const expiresAt = optionalBodyTimestampOrNull(object, 'expiresAt');
  return {
    expectedVersion: bodyPositiveInteger(object, 'expectedVersion'),
    secret: bodySecret(object),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function parseSupplyLifecycleBody(value: unknown): { readonly expectedAuthzVersion: number } {
  const object = parseStrictObject(value, ['expectedAuthzVersion'], ['expectedAuthzVersion']);
  return { expectedAuthzVersion: bodyPositiveInteger(object, 'expectedAuthzVersion') };
}

interface CapacityPolicyUpdateBody {
  readonly expectedRevision: string;
  readonly limits: CapacityPolicyLimits;
  readonly reason: CapacityPolicyReason;
}

function parseCapacityPolicyUpdateBody(value: unknown): CapacityPolicyUpdateBody {
  const object = parseStrictObject(
    value,
    ['expectedRevision', 'limits', 'reason'],
    ['expectedRevision', 'limits', 'reason'],
  );
  const expectedRevision = object.expectedRevision;
  if (typeof expectedRevision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(expectedRevision)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid policy revision');
  }

  const limits = asObject(object.limits);
  const limitKeys = ['requestsPerMinute', 'tokensPerMinute', 'maxConcurrentRequests'] as const;
  if (
    !limits ||
    Object.keys(limits).length !== limitKeys.length ||
    Object.keys(limits).some((key) => !limitKeys.includes(key as (typeof limitKeys)[number]))
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid capacity limits');
  }
  const requestsPerMinute = limits.requestsPerMinute;
  const tokensPerMinute = limits.tokensPerMinute;
  const maxConcurrentRequests = limits.maxConcurrentRequests;
  if (
    typeof requestsPerMinute !== 'number' ||
    !Number.isSafeInteger(requestsPerMinute) ||
    requestsPerMinute < 1 ||
    typeof tokensPerMinute !== 'number' ||
    !Number.isSafeInteger(tokensPerMinute) ||
    tokensPerMinute < 1 ||
    typeof maxConcurrentRequests !== 'number' ||
    !Number.isSafeInteger(maxConcurrentRequests) ||
    maxConcurrentRequests < 1 ||
    maxConcurrentRequests > 2_147_483_647
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains invalid capacity limits');
  }

  const reason = CAPACITY_POLICY_REASONS.find((candidate) => candidate === object.reason);
  if (reason === undefined) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid audit reason');
  }
  return {
    expectedRevision,
    limits: { requestsPerMinute, tokensPerMinute, maxConcurrentRequests },
    reason,
  };
}

function parseRightsVersionBody(value: unknown): Omit<RegisterProviderRightsVersionInput, 'audit'> {
  const object = parseStrictObject(
    value,
    [
      'rightsId',
      'providerId',
      'productId',
      'credentialType',
      'supplyMode',
      'region',
      'purpose',
      'modelScope',
      'endpointScope',
      'effectiveAt',
      'expiresAt',
      'approvalReference',
      'evidenceReference',
      'evidenceSha256',
      'status',
    ],
    [
      'providerId',
      'productId',
      'credentialType',
      'supplyMode',
      'region',
      'purpose',
      'modelScope',
      'endpointScope',
      'effectiveAt',
      'approvalReference',
      'evidenceReference',
      'evidenceSha256',
    ],
  );
  const supplyMode = bodyText(object, 'supplyMode', 16);
  if (supplyMode !== 'byok' && supplyMode !== 'platform') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid supply mode');
  }
  const status = optionalBodyText(object, 'status', 16);
  if (status !== undefined && status !== 'draft' && status !== 'active') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid status');
  }
  const effectiveAt = bodyTimestamp(object, 'effectiveAt', true) as string;
  const expiresAt = Object.hasOwn(object, 'expiresAt')
    ? object.expiresAt === null
      ? null
      : (bodyTimestamp(object, 'expiresAt', true) ?? null)
    : undefined;
  if (expiresAt !== undefined && expiresAt !== null && Date.parse(expiresAt) <= Date.parse(effectiveAt)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid validity window');
  }
  const rightsId = optionalBodyText(object, 'rightsId', MAX_ID_LENGTH);
  return {
    ...(rightsId === undefined ? {} : { rightsId }),
    providerId: bodyText(object, 'providerId', MAX_ID_LENGTH),
    productId: bodyText(object, 'productId', MAX_ID_LENGTH),
    credentialType: bodyText(object, 'credentialType', MAX_ID_LENGTH),
    supplyMode,
    region: bodyText(object, 'region', MAX_ID_LENGTH),
    purpose: bodyText(object, 'purpose', MAX_ID_LENGTH),
    modelScope: bodyScope(object, 'modelScope'),
    endpointScope: bodyScope(object, 'endpointScope'),
    effectiveAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    approvalReference: bodyText(object, 'approvalReference'),
    evidenceReference: bodyText(object, 'evidenceReference'),
    evidenceSha256: bodyHash(object, 'evidenceSha256'),
    ...(status === undefined ? {} : { status }),
  };
}

const PLATFORM_PRICE_RATE_METRICS = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
] as const;

function parsePriceRate(value: unknown, required: boolean): RateSetInput[keyof RateSetInput] {
  if (value === null && !required) return null;
  const object = asObject(value);
  if (
    !object ||
    Object.keys(object).length !== 2 ||
    Object.keys(object).some((key) => key !== 'numeratorMinorUnits' && key !== 'denominatorUnits')
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid exact price rate');
  }
  const numeratorMinorUnits = object.numeratorMinorUnits;
  const denominatorUnits = object.denominatorUnits;
  if (
    typeof numeratorMinorUnits !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(numeratorMinorUnits) ||
    typeof denominatorUnits !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(denominatorUnits)
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Price numerators and denominators must be exact integer strings');
  }
  return { numeratorMinorUnits, denominatorUnits };
}

function parsePriceRates(value: unknown): RateSetInput {
  const object = asObject(value);
  if (
    !object ||
    Object.keys(object).some(
      (key) => !PLATFORM_PRICE_RATE_METRICS.includes(key as (typeof PLATFORM_PRICE_RATE_METRICS)[number]),
    )
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid price rate set');
  }
  const rates: Partial<Record<(typeof PLATFORM_PRICE_RATE_METRICS)[number], RateSetInput[keyof RateSetInput]>> = {};
  for (const metric of PLATFORM_PRICE_RATE_METRICS) {
    const required = metric === 'input' || metric === 'output';
    if (!Object.hasOwn(object, metric)) {
      if (required) throw new HttpError(400, 'INVALID_BODY', 'Input and output rates are required');
      continue;
    }
    rates[metric] = parsePriceRate(object[metric], required);
  }
  return rates as RateSetInput;
}

function parsePlatformPriceVersionBody(value: unknown): Omit<RegisterPlatformPriceVersionInput, 'audit'> {
  const object = parseStrictObject(
    value,
    [
      'publicModelId',
      'publicModelVersion',
      'protocol',
      'endpoint',
      'currency',
      'idempotencyKey',
      'effectiveAt',
      'expiresAt',
      'commercialPolicyVersion',
      'calculatorVersion',
      'roundingVersion',
      'roundingMode',
      'roundingBoundary',
      'rates',
    ],
    [
      'publicModelId',
      'publicModelVersion',
      'protocol',
      'endpoint',
      'currency',
      'idempotencyKey',
      'effectiveAt',
      'commercialPolicyVersion',
      'calculatorVersion',
      'roundingVersion',
      'roundingMode',
      'rates',
    ],
  );
  const publicModelVersion = bodyPositiveInteger(object, 'publicModelVersion');
  if (publicModelVersion > 2_147_483_647) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid public model version');
  }
  const currency = bodyText(object, 'currency', 3);
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid currency');
  }
  const roundingMode = bodyText(object, 'roundingMode', 16);
  if (
    roundingMode !== 'floor' &&
    roundingMode !== 'ceil' &&
    roundingMode !== 'half_up' &&
    roundingMode !== 'half_even'
  ) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid rounding mode');
  }
  const roundingBoundary = optionalBodyText(object, 'roundingBoundary', 16);
  if (roundingBoundary !== undefined && roundingBoundary !== 'total') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid rounding boundary');
  }
  const effectiveAt = bodyTimestamp(object, 'effectiveAt', true) as string;
  const expiresAt = optionalBodyTimestampOrNull(object, 'expiresAt');
  if (expiresAt !== undefined && expiresAt !== null && Date.parse(expiresAt) <= Date.parse(effectiveAt)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body contains an invalid validity window');
  }
  return {
    publicModelId: bodyText(object, 'publicModelId', MAX_ID_LENGTH),
    publicModelVersion,
    protocol: bodyText(object, 'protocol', 80),
    endpoint: bodyText(object, 'endpoint', 255),
    currency,
    idempotencyKey: bodyText(object, 'idempotencyKey', 512),
    effectiveAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    commercialPolicyVersion: bodyText(object, 'commercialPolicyVersion', 128),
    calculatorVersion: bodyText(object, 'calculatorVersion', 128),
    roundingVersion: bodyText(object, 'roundingVersion', 128),
    roundingMode,
    ...(roundingBoundary === undefined ? {} : { roundingBoundary: 'total' as const }),
    rates: parsePriceRates(object.rates),
  };
}

function parseRightsRevokeBody(value: unknown): Omit<RevokeProviderRightsInput, 'rightsId' | 'audit'> {
  const object = parseStrictObject(
    value,
    ['approvalReference', 'evidenceReference', 'evidenceSha256', 'effectiveAt'],
    ['approvalReference', 'evidenceReference', 'evidenceSha256'],
  );
  const effectiveAt = bodyTimestamp(object, 'effectiveAt', false);
  return {
    approvalReference: bodyText(object, 'approvalReference'),
    evidenceReference: bodyText(object, 'evidenceReference'),
    evidenceSha256: bodyHash(object, 'evidenceSha256'),
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
  };
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let found: string | undefined;
  let matches = 0;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    matches += 1;
    if (matches > 1) return undefined;
    const encoded = part.slice(separator + 1).trim();
    if (encoded.length === 0) return undefined;
    try {
      found = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  return matches === 1 && found !== undefined && found.length > 0 ? found : undefined;
}

function sameSecret(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function requireWriteOrigin(req: IncomingMessage, policy: WriteOriginPolicy | undefined): void {
  if (!policy) throw writeUnavailable();
  const origin = req.headers.origin;
  if (typeof origin !== 'string') {
    throw new HttpError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required');
  }
  if (origin !== policy.origin) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'A same-origin request is required');
  }
  const host = req.headers.host;
  if (typeof host !== 'string') {
    throw new HttpError(403, 'HOST_REQUIRED', 'The request host is not allowed');
  }
  if (host !== policy.host) {
    throw new HttpError(403, 'HOST_REJECTED', 'The request host is not allowed');
  }
}

async function requireWriteCsrf(
  req: IncomingMessage,
  security: PlatformAdminWriteHttpSecurity | undefined,
): Promise<void> {
  if (!security) throw writeUnavailable();
  const sessionToken = cookieValue(req, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrfCookie = cookieValue(req, PLATFORM_ADMIN_CSRF_COOKIE);
  const csrfHeader = req.headers['x-csrf-token'];
  if (typeof csrfHeader !== 'string' || !sameSecret(csrfCookie, csrfHeader) || sessionToken === undefined) {
    throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
  }
  let valid = false;
  try {
    valid = await security.authService.verifyCsrfToken(sessionToken, csrfCookie as string);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(403, 'CSRF_REJECTED', 'A valid CSRF token is required');
}

function safeHeaderValue(value: string | string[] | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

function requestAuditContext(
  req: IncomingMessage,
  actor: PlatformAdminActor,
  requestId: string,
): ProviderRightsAuditContext {
  const remoteAddress = req.socket?.remoteAddress;
  const sourceIp = typeof remoteAddress === 'string' && isIP(remoteAddress) !== 0 ? remoteAddress : null;
  return {
    actorUserId: actor.userId,
    entryPoint: 'platform_admin',
    requestId,
    sourceIp,
    userAgent: safeHeaderValue(req.headers['user-agent'], 512),
  };
}

function validateOptions(options: PlatformAdminReadHandlerOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.access || typeof options.access.authenticate !== 'function') {
    throw new TypeError('access.authenticate is required');
  }
  if (!options.operations || typeof options.operations.getSummary !== 'function') {
    throw new TypeError('operations.getSummary is required');
  }
  if (!options.catalog || typeof options.catalog.listProducts !== 'function') {
    throw new TypeError('catalog.listProducts is required');
  }
  if (typeof options.catalog.listCapabilities !== 'function') {
    throw new TypeError('catalog.listCapabilities is required');
  }
  if (typeof options.catalog.listRights !== 'function') {
    throw new TypeError('catalog.listRights is required');
  }
  if (options.writeSecurity !== undefined) {
    if (!options.writeSecurity || typeof options.writeSecurity !== 'object') {
      throw new TypeError('writeSecurity must be an object');
    }
    if (!options.writeSecurity.authService || typeof options.writeSecurity.authService.verifyCsrfToken !== 'function') {
      throw new TypeError('writeSecurity.authService.verifyCsrfToken is required');
    }
  }
  if (options.supply !== undefined) {
    if (!options.supply || typeof options.supply !== 'object') {
      throw new TypeError('supply must be an object');
    }
    const requiredMethods = [
      'listPlatformProviderAccounts',
      'createPlatformProviderAccount',
      'listPlatformProviderCredentials',
      'createPlatformProviderCredential',
      'replacePlatformProviderCredentialSecret',
      'enablePlatformProviderAccount',
      'disablePlatformProviderAccount',
      'revokePlatformProviderAccount',
      'enablePlatformProviderCredential',
      'disablePlatformProviderCredential',
      'revokePlatformProviderCredential',
    ] as const;
    if (requiredMethods.some((method) => typeof options.supply?.[method] !== 'function')) {
      throw new TypeError('supply service methods are required');
    }
  }
  if (options.pricing !== undefined) {
    if (!options.pricing || typeof options.pricing !== 'object') {
      throw new TypeError('pricing must be an object');
    }
    const requiredMethods = [
      'listPlatformPricingTargets',
      'listPlatformPriceVersionHistory',
      'registerPlatformCustomerPriceVersion',
      'registerPlatformSupplierCostVersion',
    ] as const;
    if (requiredMethods.some((method) => typeof options.pricing?.[method] !== 'function')) {
      throw new TypeError('pricing service methods are required');
    }
  }
  if (options.capacityPolicies !== undefined) {
    if (!options.capacityPolicies || typeof options.capacityPolicies !== 'object') {
      throw new TypeError('capacityPolicies must be an object');
    }
    const requiredMethods = [
      'getTenantPolicy',
      'getProjectPolicy',
      'getApiKeyPolicy',
      'setTenantPolicy',
      'setProjectPolicy',
      'setApiKeyPolicy',
    ] as const;
    if (requiredMethods.some((method) => typeof options.capacityPolicies?.[method] !== 'function')) {
      throw new TypeError('capacity policy service methods are required');
    }
  }
  if (options.capacityPolicyTargets !== undefined) {
    if (!options.capacityPolicyTargets || typeof options.capacityPolicyTargets !== 'object') {
      throw new TypeError('capacityPolicyTargets must be an object');
    }
    const requiredMethods = ['listTenantIds', 'listProjectIds', 'listApiKeyIds'] as const;
    if (requiredMethods.some((method) => typeof options.capacityPolicyTargets?.[method] !== 'function')) {
      throw new TypeError('capacity policy target selector methods are required');
    }
  }
}

function isAuthenticatedPlatformActor(actor: PlatformAdminActor | undefined): actor is PlatformAdminActor {
  return (
    actor !== undefined &&
    actor !== null &&
    typeof actor.userId === 'string' &&
    actor.userId.trim().length > 0 &&
    hasPlatformRole(actor, PLATFORM_ADMIN_ROLES)
  );
}

function notAuthenticated(): HttpError {
  return new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required');
}

function forbidden(): HttpError {
  return new HttpError(403, 'FORBIDDEN', 'The operation is not permitted');
}

function internalError(): HttpError {
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed');
}

function auditUnavailable(): HttpError {
  return new HttpError(503, 'AUDIT_UNAVAILABLE', 'The platform audit query is not available');
}

function writeUnavailable(): HttpError {
  return new HttpError(503, 'CATALOG_WRITE_UNAVAILABLE', 'The platform catalog write is not available');
}

function supplyUnavailable(): HttpError {
  return new HttpError(503, 'SUPPLY_UNAVAILABLE', 'The platform supply service is not available');
}

function capacityPolicyUnavailable(): HttpError {
  return new HttpError(503, 'CAPACITY_POLICY_UNAVAILABLE', 'The capacity policy service is not available');
}

function capacityPolicyTargetsUnavailable(): HttpError {
  return new HttpError(
    503,
    'CAPACITY_POLICY_TARGETS_UNAVAILABLE',
    'The capacity policy target selector is not available',
  );
}

function pricingUnavailable(): HttpError {
  return new HttpError(503, 'PRICING_UNAVAILABLE', 'The platform pricing service is not available');
}

function auditServiceError(error: unknown): HttpError {
  if (isPlatformAuditQueryError(error) && error.code === 'AUDIT_INVALID_INPUT') {
    return new HttpError(400, 'INVALID_QUERY', 'The request query is invalid.');
  }
  return internalError();
}

function serviceError(error: unknown): HttpError {
  if (error instanceof SaasCatalogError) {
    return new HttpError(error.status, error.code, error.message);
  }
  if (error instanceof ProviderSupplyError) {
    return new HttpError(error.status, error.code, error.message);
  }
  if (isSaasPricingError(error)) {
    const safe = new SaasPricingError(error.code);
    return new HttpError(safe.status, safe.code, safe.message);
  }
  return auditServiceError(error);
}

function capacityPolicyServiceError(error: unknown): HttpError {
  if (!(error instanceof CapacityPolicyError)) return internalError();
  const status =
    error.code === 'INVALID_INPUT'
      ? 400
      : error.code === 'FORBIDDEN'
        ? 403
        : error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'CAS_CONFLICT' || error.code === 'NO_CHANGE' || error.code === 'AMBIGUOUS'
            ? 409
            : error.code === 'INVALID_POLICY'
              ? 422
              : 500;
  const code = error.code === 'NOT_FOUND' ? 'CAPACITY_POLICY_NOT_FOUND' : error.code;
  return new HttpError(status, code, status === 500 ? 'The request could not be completed' : error.message);
}

function supplyServiceError(error: unknown): HttpError {
  if (error instanceof ProviderSupplyError) {
    // Preserve only the domain error's stable public code/message pair. A
    // typed service must not be able to echo a custom message containing a
    // request body or secret through this transport boundary.
    const safe = new ProviderSupplyError(error.code);
    return new HttpError(safe.status, safe.code, safe.message);
  }
  return internalError();
}

function methodNotAllowed(res: ServerResponse, requestId: string, allow: string): void {
  sendError(res, requestId, new HttpError(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this endpoint'), {
    allow,
  });
}

function allowedMethods(route: Route): readonly string[] {
  if (route === 'tenantCapacityPolicy' || route === 'projectCapacityPolicy' || route === 'apiKeyCapacityPolicy') {
    return ['GET', 'PUT'];
  }
  if (route === 'rights') return ['GET', 'POST'];
  if (route === 'supplyAccounts') return ['GET', 'POST'];
  if (route === 'supplyAccountCredentials') return ['GET', 'POST'];
  if (route === 'registerCustomerPriceVersion' || route === 'registerSupplierCostVersion') return ['POST'];
  if (
    route === 'registerRightsVersion' ||
    route === 'revokeRights' ||
    route === 'rotateSupplyCredentialSecret' ||
    route === 'supplyAccountLifecycle' ||
    route === 'supplyCredentialLifecycle'
  ) {
    return [route === 'rotateSupplyCredentialSecret' ? 'PUT' : 'POST'];
  }
  return ['GET'];
}

function safeRightsMutationDto(record: ProviderRightsRecord): Record<string, unknown> {
  return {
    rightsId: record.rightsId,
    version: record.version,
    providerId: record.providerId,
    productId: record.productId,
    credentialType: record.credentialType,
    supplyMode: record.supplyMode,
    region: record.region,
    purpose: record.purpose,
    modelScope: [...record.modelScope],
    endpointScope: [...record.endpointScope],
    effectiveAt: record.effectiveAt,
    expiresAt: record.expiresAt,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function jsonRate(rate: { readonly numeratorMinorUnits: bigint; readonly denominatorUnits: bigint } | null) {
  return rate === null
    ? null
    : {
        numeratorMinorUnits: rate.numeratorMinorUnits.toString(10),
        denominatorUnits: rate.denominatorUnits.toString(10),
      };
}

function safePriceVersionDto(record: CommercialPriceVersionRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    id: record.id,
    version: record.version,
    publicModelId: record.publicModelId,
    publicModelVersion: record.publicModelVersion,
    providerId: record.providerId,
    productId: record.productId,
    ...(record.kind === 'supplier' ? { resolvedModel: record.resolvedModel } : {}),
    protocol: record.protocol,
    endpoint: record.endpoint,
    currency: record.currency,
    commercialPolicyVersion: record.commercialPolicyVersion,
    calculatorVersion: record.calculatorVersion,
    roundingVersion: record.roundingVersion,
    roundingMode: record.roundingMode,
    roundingBoundary: record.roundingBoundary,
    rates: {
      input: jsonRate(record.rates.input),
      cache_read: jsonRate(record.rates.cache_read),
      cache_write: jsonRate(record.rates.cache_write),
      cache_write_5m: jsonRate(record.rates.cache_write_5m),
      cache_write_1h: jsonRate(record.rates.cache_write_1h),
      output: jsonRate(record.rates.output),
    },
    effectiveAt: record.effectiveAt,
    expiresAt: record.expiresAt,
    definitionDigest: record.definitionDigest,
    createdAt: record.createdAt,
  };
}

function safePriceTargetDto(record: PlatformPricingTargetRecord): Record<string, unknown> {
  return {
    publicModelId: record.publicModelId,
    publicModelVersion: record.publicModelVersion,
    publicModelAlias: record.publicModelAlias,
    displayName: record.displayName,
    providerId: record.providerId,
    productId: record.productId,
    resolvedModel: record.resolvedModel,
    protocol: record.protocol,
    endpoint: record.endpoint,
    capabilityVersion: record.capabilityVersion,
  };
}

function safePricingTargetPage(page: PlatformPricingTargetPage): Record<string, unknown> {
  return {
    items: page.items.map(safePriceTargetDto),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

function safePriceHistoryPage(page: PlatformPriceVersionHistoryPage): Record<string, unknown> {
  return {
    items: page.items.map(safePriceVersionDto),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

function safeCapacityPolicyDto(record: CapacityPolicyRecord): Record<string, unknown> {
  const base = {
    scope: record.scope,
    tenantId: record.tenantId,
    revision: record.revision,
    revisionKind: record.revisionKind,
    configured: record.configured,
    limits: record.limits === null ? null : { ...record.limits },
  };
  if (record.scope === 'tenant') return base;
  if (record.scope === 'project') return { ...base, projectId: record.projectId };
  return { ...base, projectId: record.projectId, apiKeyId: record.apiKeyId };
}

function safeCapacityPolicyTargetPage(ids: readonly string[]): {
  readonly items: readonly { readonly id: string }[];
  readonly nextCursor: string | null;
} {
  if (!Array.isArray(ids) || ids.length > CAPACITY_SELECTOR_PAGE_SIZE + 1) throw internalError();
  const normalized = ids.map((id) => {
    if (typeof id !== 'string' || !CAPACITY_UUID_PATTERN.test(id)) throw internalError();
    return id.toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) throw internalError();
  const items = normalized.slice(0, CAPACITY_SELECTOR_PAGE_SIZE).map((id) => ({ id }));
  return {
    items,
    nextCursor: normalized.length > CAPACITY_SELECTOR_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
  };
}

function safeProviderAccountDto(record: ProviderAccountRecord): Record<string, unknown> {
  if (record.ownerKind !== 'platform' || record.tenantId !== null || record.supplyMode !== 'platform') {
    throw internalError();
  }
  return {
    ownerKind: 'platform',
    supplyMode: 'platform',
    id: record.id,
    displayName: record.displayName,
    providerId: record.providerId,
    productId: record.productId,
    credentialType: record.credentialType,
    region: record.region,
    purpose: record.purpose,
    rightsId: record.rightsId,
    rightsVersion: record.rightsVersion,
    capabilities: record.capabilities.map((capability) => ({
      model: capability.model,
      endpoint: capability.endpoint,
      version: capability.version,
    })),
    status: record.status,
    validationState: record.validationState,
    authzVersion: record.authzVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabledAt: record.disabledAt,
    revokedAt: record.revokedAt,
  };
}

function safeProviderCredentialDto(record: ProviderCredentialRecord): Record<string, unknown> {
  if (record.ownerKind !== 'platform' || record.tenantId !== null || record.supplyMode !== 'platform') {
    throw internalError();
  }
  return {
    ownerKind: 'platform',
    supplyMode: 'platform',
    id: record.id,
    accountId: record.accountId,
    providerId: record.providerId,
    productId: record.productId,
    credentialType: record.credentialType,
    status: record.status,
    validationState: record.validationState,
    currentVersion: record.currentVersion,
    expiresAt: record.expiresAt,
    authzVersion: record.authzVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabledAt: record.disabledAt,
    revokedAt: record.revokedAt,
  };
}

function safeProviderCredentialVersionDto(record: ProviderCredentialVersionRecord): Record<string, unknown> {
  if (record.ownerKind !== 'platform' || record.tenantId !== null) throw internalError();
  return {
    ownerKind: 'platform',
    supplyMode: 'platform',
    accountId: record.accountId,
    credentialId: record.credentialId,
    version: record.version,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    retiredAt: record.retiredAt,
    revokedAt: record.revokedAt,
  };
}

function safeProviderCredentialWriteDto(record: ProviderCredentialWriteResult): Record<string, unknown> {
  return {
    credential: safeProviderCredentialDto(record.credential),
    version: safeProviderCredentialVersionDto(record.version),
  };
}

function responseClosed(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded;
}

function isSupplyRoute(route: Route): route is SupplyRoute {
  return (
    route === 'supplyAccounts' ||
    route === 'supplyAccountCredentials' ||
    route === 'rotateSupplyCredentialSecret' ||
    route === 'supplyAccountLifecycle' ||
    route === 'supplyCredentialLifecycle'
  );
}

function isCapacityPolicyRoute(route: Route): route is CapacityPolicyRoute {
  return route === 'tenantCapacityPolicy' || route === 'projectCapacityPolicy' || route === 'apiKeyCapacityPolicy';
}

function isCapacityPolicySelectorRoute(route: Route): route is CapacityPolicySelectorRoute {
  return route === 'capacityTenantTargets' || route === 'capacityProjectTargets' || route === 'capacityApiKeyTargets';
}

function isPlatformPricingRoute(route: Route): boolean {
  return (
    route === 'pricingTargets' ||
    route === 'pricingVersions' ||
    route === 'registerCustomerPriceVersion' ||
    route === 'registerSupplierCostVersion'
  );
}

/**
 * Platform-admin catalog transport. Auth paths and all other API/static paths
 * are deliberately left for their owning handlers or the composition root.
 * Rights writes remain unavailable until the composition injects both the
 * transactional catalog methods and the platform-auth CSRF verifier.
 */
export function createPlatformAdminReadHandler(options: PlatformAdminReadHandlerOptions): PlatformAdminReadHttpHandler {
  validateOptions(options);
  const writeOriginPolicy =
    options.writeSecurity === undefined ? undefined : parseWriteOrigin(options.writeSecurity.publicOrigin);

  return async (req, res): Promise<boolean> => {
    const url = requestUrl(req);
    const route = url === undefined ? undefined : routeForPath(url.pathname);
    if (route === undefined || url === undefined) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const methods = allowedMethods(route);
    const isWrite = methods.includes(method) && method !== 'GET';
    const requestId = isCapacityPolicyRoute(route)
      ? randomUUID()
      : `platform_admin_${isWrite ? 'write' : 'read'}_${randomUUID()}`;
    if (!methods.includes(method)) {
      drainRequest(req);
      methodNotAllowed(res, requestId, methods.join(', '));
      return true;
    }

    try {
      if (isWrite) requireWriteOrigin(req, writeOriginPolicy);
      const actor = await options.access.authenticate(req as PlatformAdminAccessRequest);
      if (!isAuthenticatedPlatformActor(actor)) throw notAuthenticated();

      if (isWrite && !hasPlatformRole(actor, ['operations'])) throw forbidden();
      if (isWrite) await requireWriteCsrf(req, options.writeSecurity);
      if (isCapacityPolicyRoute(route) && !hasPlatformRole(actor, ['operations'])) throw forbidden();
      if (isCapacityPolicyRoute(route) && !options.capacityPolicies) throw capacityPolicyUnavailable();
      if (isCapacityPolicySelectorRoute(route) && !hasPlatformRole(actor, ['operations'])) throw forbidden();
      if (isCapacityPolicySelectorRoute(route) && !options.capacityPolicyTargets) {
        throw capacityPolicyTargetsUnavailable();
      }

      if (route === 'me') {
        const values = queryValues(url, []);
        if (values.size !== 0) invalidQuery();
        sendJson(res, 200, requestId, { userId: actor.userId, roles: actor.roles });
        return true;
      }

      if (route === 'operationsSummary' && !hasPlatformRole(actor, ['operations'])) {
        throw forbidden();
      }
      if (
        (route === 'products' || route === 'capabilities' || route === 'rights') &&
        !hasPlatformRole(actor, ['operations', 'security'])
      ) {
        throw forbidden();
      }
      if (route === 'auditEvents' && !hasPlatformRole(actor, ['security'])) {
        throw forbidden();
      }
      if (isPlatformPricingRoute(route) && !hasPlatformRole(actor, ['operations'])) {
        throw forbidden();
      }
      if (isPlatformPricingRoute(route) && !options.pricing) {
        throw pricingUnavailable();
      }
      if (isSupplyRoute(route) && !hasPlatformRole(actor, ['operations'])) {
        throw forbidden();
      }
      if (isSupplyRoute(route) && !options.supply) {
        throw supplyUnavailable();
      }

      if (isWrite) {
        const values = queryValues(url, []);
        if (values.size !== 0) invalidQuery();
        const audit = requestAuditContext(req, actor, requestId);

        if (isCapacityPolicyRoute(route)) {
          const capacityPolicies = options.capacityPolicies;
          if (!capacityPolicies) throw capacityPolicyUnavailable();
          const target = capacityPolicyTarget(url.pathname);
          const update = parseCapacityPolicyUpdateBody(await readJson(req));
          const record =
            target.route === 'tenantCapacityPolicy'
              ? await capacityPolicies.setTenantPolicy({ ...update, tenantId: target.tenantId, requestId, actor })
              : target.route === 'projectCapacityPolicy'
                ? await capacityPolicies.setProjectPolicy({
                    ...update,
                    tenantId: target.tenantId,
                    projectId: target.projectId,
                    requestId,
                    actor,
                  })
                : await capacityPolicies.setApiKeyPolicy({
                    ...update,
                    tenantId: target.tenantId,
                    projectId: target.projectId,
                    apiKeyId: target.apiKeyId,
                    requestId,
                    actor,
                  });
          sendJson(res, 200, requestId, safeCapacityPolicyDto(record));
          return true;
        }

        if (route === 'registerRightsVersion' || route === 'rights') {
          if (typeof options.catalog.registerProviderRightsVersion !== 'function') throw writeUnavailable();
          const input = parseRightsVersionBody(await readJson(req));
          const data = await options.catalog.registerProviderRightsVersion({ ...input, audit });
          sendJson(res, 201, requestId, safeRightsMutationDto(data));
          return true;
        }

        if (route === 'revokeRights') {
          if (typeof options.catalog.revokeProviderRights !== 'function') throw writeUnavailable();
          const input = parseRightsRevokeBody(await readJson(req));
          const rightsId = rightsIdFromRevokePath(url.pathname);
          const data = await options.catalog.revokeProviderRights({ ...input, rightsId, audit });
          sendJson(res, 200, requestId, safeRightsMutationDto(data));
          return true;
        }

        if (route === 'registerCustomerPriceVersion' || route === 'registerSupplierCostVersion') {
          const pricing = options.pricing;
          if (!pricing) throw pricingUnavailable();
          const input = parsePlatformPriceVersionBody(await readJson(req));
          const priceAudit = {
            actorUserId: actor.userId,
            entryPoint: 'platform_admin' as const,
            requestId,
            sourceIp: audit.sourceIp,
            userAgent: audit.userAgent,
          };
          const record =
            route === 'registerCustomerPriceVersion'
              ? await pricing.registerPlatformCustomerPriceVersion({ ...input, audit: priceAudit })
              : await pricing.registerPlatformSupplierCostVersion({ ...input, audit: priceAudit });
          sendJson(res, 201, requestId, safePriceVersionDto(record));
          return true;
        }

        if (isSupplyRoute(route)) {
          const supply = options.supply;
          if (!supply) throw supplyUnavailable();

          if (route === 'supplyAccounts') {
            const input = parseSupplyAccountBody(await readJson(req));
            const data = await supply.createPlatformProviderAccount({ ...input, audit });
            sendJson(res, 201, requestId, safeProviderAccountDto(data));
            return true;
          }

          if (route === 'supplyAccountCredentials') {
            const accountId = supplyPathId(url.pathname, 'accounts', '/credentials');
            const input = parseSupplyCredentialCreateBody(await readJson(req));
            try {
              const data = await supply.createPlatformProviderCredential({ ...input, accountId, audit });
              sendJson(res, 201, requestId, safeProviderCredentialWriteDto(data));
            } finally {
              input.secret.fill(0);
            }
            return true;
          }

          if (route === 'rotateSupplyCredentialSecret') {
            const credentialId = supplyPathId(url.pathname, 'credentials', '/secret');
            const input = parseSupplyCredentialRotationBody(await readJson(req));
            try {
              const data = await supply.replacePlatformProviderCredentialSecret({ ...input, credentialId, audit });
              sendJson(res, 200, requestId, safeProviderCredentialWriteDto(data));
            } finally {
              input.secret.fill(0);
            }
            return true;
          }

          if (route === 'supplyAccountLifecycle') {
            const accountId = supplyPathId(
              url.pathname,
              'accounts',
              `/${supplyLifecycleAction(url.pathname, 'accounts')}`,
            );
            const input = parseSupplyLifecycleBody(await readJson(req));
            const lifecycleInput = { ...input, accountId, audit };
            const action = supplyLifecycleAction(url.pathname, 'accounts');
            const data =
              action === 'enable'
                ? await supply.enablePlatformProviderAccount(lifecycleInput)
                : action === 'disable'
                  ? await supply.disablePlatformProviderAccount(lifecycleInput)
                  : await supply.revokePlatformProviderAccount(lifecycleInput);
            sendJson(res, 200, requestId, safeProviderAccountDto(data));
            return true;
          }

          if (route === 'supplyCredentialLifecycle') {
            const action = supplyLifecycleAction(url.pathname, 'credentials');
            const credentialId = supplyPathId(url.pathname, 'credentials', `/${action}`);
            const input = parseSupplyLifecycleBody(await readJson(req));
            const lifecycleInput = { ...input, credentialId, audit };
            const data =
              action === 'enable'
                ? await supply.enablePlatformProviderCredential(lifecycleInput)
                : action === 'disable'
                  ? await supply.disablePlatformProviderCredential(lifecycleInput)
                  : await supply.revokePlatformProviderCredential(lifecycleInput);
            sendJson(res, 200, requestId, safeProviderCredentialDto(data));
            return true;
          }
        }

        throw internalError();
      }

      if (isCapacityPolicyRoute(route)) {
        const values = queryValues(url, []);
        if (values.size !== 0) invalidQuery();
        const capacityPolicies = options.capacityPolicies;
        if (!capacityPolicies) throw capacityPolicyUnavailable();
        const target = capacityPolicyTarget(url.pathname);
        const record =
          target.route === 'tenantCapacityPolicy'
            ? await capacityPolicies.getTenantPolicy({ tenantId: target.tenantId, actor })
            : target.route === 'projectCapacityPolicy'
              ? await capacityPolicies.getProjectPolicy({
                  tenantId: target.tenantId,
                  projectId: target.projectId,
                  actor,
                })
              : await capacityPolicies.getApiKeyPolicy({
                  tenantId: target.tenantId,
                  projectId: target.projectId,
                  apiKeyId: target.apiKeyId,
                  actor,
                });
        if (record === null) {
          throw new HttpError(404, 'CAPACITY_POLICY_NOT_FOUND', 'The capacity policy target was not found');
        }
        sendJson(res, 200, requestId, safeCapacityPolicyDto(record));
        return true;
      }

      if (isCapacityPolicySelectorRoute(route)) {
        const selectors = options.capacityPolicyTargets;
        if (!selectors) throw capacityPolicyTargetsUnavailable();
        const cursor = capacityPolicySelectorCursor(url);
        const target = capacityPolicySelectorTarget(url.pathname);
        const ids =
          target.route === 'capacityTenantTargets'
            ? await selectors.listTenantIds(cursor, CAPACITY_SELECTOR_PAGE_SIZE + 1)
            : target.route === 'capacityProjectTargets'
              ? await selectors.listProjectIds(target.tenantId, cursor, CAPACITY_SELECTOR_PAGE_SIZE + 1)
              : await selectors.listApiKeyIds(
                  target.tenantId,
                  target.projectId,
                  cursor,
                  CAPACITY_SELECTOR_PAGE_SIZE + 1,
                );
        sendJson(res, 200, requestId, safeCapacityPolicyTargetPage(ids));
        return true;
      }

      if (route === 'operationsSummary') {
        const data = await options.operations.getSummary(operationsQuery(url));
        sendJson(res, 200, requestId, data);
        return true;
      }

      if (route === 'auditEvents') {
        if (!options.audit) throw auditUnavailable();
        const data = await options.audit.listEvents(auditQuery(url));
        sendJson(res, 200, requestId, data);
        return true;
      }

      if (route === 'pricingTargets') {
        const pricing = options.pricing;
        if (!pricing) throw pricingUnavailable();
        const data = await pricing.listPlatformPricingTargets(platformPricingTargetQuery(url));
        sendJson(res, 200, requestId, safePricingTargetPage(data));
        return true;
      }

      if (route === 'pricingVersions') {
        const pricing = options.pricing;
        if (!pricing) throw pricingUnavailable();
        const data = await pricing.listPlatformPriceVersionHistory(platformPriceVersionHistoryQuery(url));
        sendJson(res, 200, requestId, safePriceHistoryPage(data));
        return true;
      }

      if (route === 'supplyAccounts') {
        const values = queryValues(url, []);
        if (values.size !== 0) invalidQuery();
        const supply = options.supply;
        if (!supply) throw supplyUnavailable();
        const records = await supply.listPlatformProviderAccounts();
        sendJson(res, 200, requestId, { items: records.map(safeProviderAccountDto) });
        return true;
      }

      if (route === 'supplyAccountCredentials') {
        const values = queryValues(url, []);
        if (values.size !== 0) invalidQuery();
        const supply = options.supply;
        if (!supply) throw supplyUnavailable();
        const accountId = supplyPathId(url.pathname, 'accounts', '/credentials');
        const records = await supply.listPlatformProviderCredentials(accountId);
        sendJson(res, 200, requestId, { items: records.map(safeProviderCredentialDto) });
        return true;
      }

      const data =
        route === 'products'
          ? await options.catalog.listProducts(catalogQuery(url, false))
          : route === 'capabilities'
            ? await options.catalog.listCapabilities(catalogQuery(url, true))
            : await options.catalog.listRights(catalogQuery(url, true));
      sendJson(res, 200, requestId, data);
      return true;
    } catch (error) {
      if (responseClosed(res)) return true;
      sendError(
        res,
        requestId,
        error instanceof HttpError
          ? error
          : isCapacityPolicyRoute(route)
            ? capacityPolicyServiceError(error)
            : isCapacityPolicySelectorRoute(route)
              ? internalError()
              : isSupplyRoute(route)
                ? supplyServiceError(error)
                : isPlatformPricingRoute(route)
                  ? serviceError(error)
                  : serviceError(error),
      );
      return true;
    }
  };
}
