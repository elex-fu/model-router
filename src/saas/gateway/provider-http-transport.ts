import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import type {
  PreparedEvidenceTransport,
  PreparedEvidenceTransportRequest,
  PreparedEvidenceTransportResponse,
} from './prepared-evidence-dispatch-service.js';
import {
  createPinnedProviderHttpConnector,
  createPinnedProviderHttpTestConnectorFactory,
  isProviderHttpTestAddressCapability,
  type ProviderHttpAddressResolver,
  type ProviderHttpEgressAllowlist,
  type ProviderHttpEgressProxyTarget,
  type ProviderHttpPinnedConnector,
  type ProviderHttpPinnedConnectorFactory,
  type ProviderHttpResolvedAddress,
  type ProviderHttpTestAddressCapability,
  resolveEgressProxyTarget,
  resolveProviderHttpAddresses,
  selectPinnedProviderAddress,
} from './provider-http-address.js';
import {
  isProviderTlsFingerprintEgress,
  type ProviderTlsFingerprintEgress,
} from './provider-http-tls-fingerprint-connector.js';
import { observeProviderJsonUsage, type ProviderMediaUsageExtractor } from './provider-json-usage-observer.js';
import { observeProviderSseUsage } from './provider-sse-usage-observer.js';
import {
  createUsageEvidence,
  type NormalizedUsageEvidence,
  outboundServiceTierFromPayload,
  PROVIDER_JSON_USAGE_OBSERVER_VERSION,
  PROVIDER_SSE_USAGE_OBSERVER_VERSION,
  type TransportServiceTierEvidence,
  usageEvidenceCompleteness,
} from './usage-evidence.js';
import { observeSearchProviderResponse, searchDescriptorForDispatch } from './websearch/response-observer.js';

/** §4.3: parse the verified payload bytes for the search descriptor round-trip. */
function parsePayloadJson(payloadBytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    return null;
  }
}

const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;
const DEFAULT_CREDENTIAL_HEADER_NAMES = Object.freeze(['authorization', 'api-key', 'x-api-key', 'x-goog-api-key']);
const RESPONSE_HEADER_ALLOWLIST = Object.freeze([
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'etag',
  'retry-after',
  'vary',
  'x-request-id',
]);
const FIXED_REQUEST_HEADERS = Object.freeze({
  accept: 'application/json',
  'content-type': 'application/json',
});
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type ProviderHttpFetchInit = UndiciRequestInit & {
  /** Per-request Undici dispatcher containing the validated pinned address. */
  readonly dispatcher: Dispatcher;
};

/** The adapter must forward the per-request dispatcher to Undici unchanged. */
export type ProviderHttpFetch = (url: string, init: ProviderHttpFetchInit) => Promise<Response>;

/** The server-owned target returned by the dispatch-profile resolver. */
export interface ProviderHttpDispatchProfile {
  /** The complete HTTPS target. It is never derived from request data. */
  readonly url?: string;
  /** Compatibility spelling for resolver implementations that call this targetUrl. */
  readonly targetUrl?: string;
  /**
   * R3 egress proxies: the per-account egress proxy URL assembled by the
   * resolver (credentials unsealed at resolution time). The URL exists only
   * for the lifetime of this dispatch and never enters logs; an absent value
   * keeps the exact pre-R3 direct-egress behavior.
   */
  readonly egressProxy?: { readonly url: string };
  /**
   * Batch-2 §2.4 TLS fingerprints: the account's resolved egress descriptor
   * (selector + inline profile for custom rows, resolved from PG at dispatch
   * time). Absent keeps the ordinary connector path; the profile payload
   * never carries credentials.
   */
  readonly tlsFingerprint?: ProviderTlsFingerprintEgress;
}

export interface ProviderHttpDispatchProfileResolveInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly evidenceId: string;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly protocol: PreparedEvidenceTransportRequest['evidence']['protocol'];
  /** The signed endpoint descriptor; it is not a URL source for this transport. */
  readonly endpoint: string;
  /**
   * R5b-2: the signed provider-side protocol and operation (bridge output).
   * Present on 029+ evidence; legacy evidence omits them. Multi-protocol
   * providers (OpenCode Go: responses | openai | anthropic on one endpoint
   * scope) key their per-protocol provider-target bindings on this pair.
   */
  readonly providerProtocol?: PreparedEvidenceTransportRequest['evidence']['providerProtocol'];
  readonly providerOperation?: PreparedEvidenceTransportRequest['evidence']['providerOperation'];
  /**
   * R3: the claimed evidence's supply mode and account owner kind, used to
   * resolve the account's egress proxy from the correct owner-scoped table.
   * Legacy evidence omits accountOwnerKind; the supply mode alone determines
   * the owner kind in that case.
   */
  readonly supplyMode?: PreparedEvidenceTransportRequest['evidence']['supplyMode'];
  readonly accountOwnerKind?: PreparedEvidenceTransportRequest['evidence']['accountOwnerKind'];
  readonly signal: AbortSignal;
}

export type ProviderHttpDispatchProfileResolver = (
  input: ProviderHttpDispatchProfileResolveInput,
) => Promise<ProviderHttpDispatchProfile | null>;

export interface ProviderHttpCredential {
  /** Only an allowlisted authentication header may be injected. */
  readonly headerName: string;
  /** The value exists only for the duration of the resolver callback. */
  readonly value: string | Uint8Array;
}

export interface ProviderHttpCredentialResolveInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly evidenceId: string;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly signal: AbortSignal;
}

/**
 * Resolves a credential and injects it only through the callback. The
 * callback returns transport metadata, never the raw credential.
 */
export type ProviderHttpCredentialResolver = (
  input: ProviderHttpCredentialResolveInput,
  useCredential: (credential: ProviderHttpCredential) => Promise<PreparedEvidenceTransportResponse>,
) => Promise<PreparedEvidenceTransportResponse>;

export interface ProviderHttpEndpointPolicy {
  /** Exact normalized hostnames. Wildcards are intentionally unsupported. */
  readonly allowedHosts: readonly string[];
  /** Exact effective HTTPS ports; an omitted URL port means 443. */
  readonly allowedPorts: readonly number[];
}

/**
 * R5b-4: signed dispatch facts the fixed-request-header resolver keys on.
 * Mirrors the dispatch-profile resolve input's protocol dimensions without
 * the per-request identifiers.
 */
export interface ProviderHttpFixedRequestHeadersInput {
  /** The signed client protocol from the prepared evidence. */
  readonly protocol: PreparedEvidenceTransportRequest['evidence']['protocol'];
  /** The signed endpoint descriptor; it is not a URL source. */
  readonly endpoint: string;
  /** The signed provider-side protocol (bridge output); absent on legacy evidence. */
  readonly providerProtocol?: PreparedEvidenceTransportRequest['evidence']['providerProtocol'];
  /** The signed provider-side operation; absent on legacy evidence. */
  readonly providerOperation?: PreparedEvidenceTransportRequest['evidence']['providerOperation'];
}

/**
 * R5b-4 per-protocol fixed-header extension: deployment-owned additional
 * non-authentication request headers, resolved from the signed dispatch
 * facts (endpoint scope + provider protocol). Returning null/undefined adds
 * nothing. The resolver may never return credential header names — the
 * credential injection always wins and the allowlist is enforced.
 */
export type ProviderHttpFixedRequestHeadersResolver = (
  input: ProviderHttpFixedRequestHeadersInput,
) =>
  | Readonly<Record<string, string>>
  | null
  | undefined
  | PromiseLike<Readonly<Record<string, string>> | null | undefined>;

export interface ProviderHttpTransportOptions {
  /** Undici-compatible adapter that forwards the required dispatcher unchanged. */
  readonly fetch: ProviderHttpFetch;
  /** Required server-side resolver for the complete dispatch target. */
  readonly resolveDispatchProfile: ProviderHttpDispatchProfileResolver;
  /** Required short-lived server-side credential resolver. */
  readonly resolveCredential: ProviderHttpCredentialResolver;
  readonly endpointPolicy: ProviderHttpEndpointPolicy;
  /** Test-runner-only capability for a pinned loopback HTTPS test upstream. */
  readonly testAddressCapability?: ProviderHttpTestAddressCapability;
  /**
   * R9 §4 P1: operator-configured egress allowlist. Validated CIDR entries
   * that additionally permit dispatch to otherwise-denied addresses
   * (container-network providers). Unset (the default for every existing
   * composition) keeps the exact global-only fail-closed posture.
   */
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  /** Defaults to the operating-system resolver; injectable for deterministic tests. */
  readonly resolveAddresses?: ProviderHttpAddressResolver;
  /** Defaults to a per-request Undici Agent pinned to the validated address. */
  readonly createConnector?: ProviderHttpPinnedConnectorFactory;
  readonly timeoutMs: number;
  readonly maxPayloadBytes?: number;
  /** Defaults to a small provider-authentication allowlist. */
  readonly allowedCredentialHeaderNames?: readonly string[];
  /**
   * R5b-4: optional deployment-owned additional fixed request headers keyed
   * on the signed endpoint scope and provider protocol. Unset (the default
   * for every existing composition) keeps the exact previous header set.
   */
  readonly resolveFixedRequestHeaders?: ProviderHttpFixedRequestHeadersResolver;
  /**
   * §4.2 (task #16): per-request media usage plan for operations the token
   * observers do not know (images.generations; the #17 video/audio
   * operations reuse the same seam). The factory is invoked with the signed
   * payload bytes on the 2xx JSON response branch; a null plan (or a throw)
   * keeps the observation at the observer's documented unknown outcome, and
   * the plan's serviceTier terms are carried on the transport response into
   * the dispatch settlement input.
   */
  readonly mediaUsagePlan?: ProviderMediaUsagePlanFactory | null;
}

/**
 * §4.2: the per-request media usage plan bound by the mediaUsagePlan
 * factory. Defined here (not in the images module) so the seam stays
 * available to the #17 category without a cross-module import cycle.
 */
export interface ProviderMediaUsagePlan {
  readonly extractor: ProviderMediaUsageExtractor | null;
  readonly serviceTier: { readonly requested: string | null; readonly observed: string | null } | null;
}

/** The factory binds a plan per request; returning null keeps the token path. */
export type ProviderMediaUsagePlanFactory = (input: {
  readonly providerOperation: string | undefined;
  readonly payloadBytes: Uint8Array;
}) => ProviderMediaUsagePlan | null;

export type ProviderHttpTransportErrorCode =
  | 'INVALID_INPUT'
  | 'PROFILE_UNAVAILABLE'
  | 'PROFILE_INVALID'
  | 'ENDPOINT_POLICY_VIOLATION'
  | 'EGRESS_PROXY_INVALID'
  | 'TLS_FINGERPRINT_INVALID'
  | 'PAYLOAD_BINDING_MISMATCH'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INVALID'
  | 'FIXED_REQUEST_HEADERS_INVALID'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'REDIRECT_REJECTED'
  | 'INVALID_RESPONSE';

export class ProviderHttpTransportError extends Error {
  constructor(
    readonly code: ProviderHttpTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderHttpTransportError';
  }
}

interface NormalizedEndpointPolicy {
  readonly allowedHosts: ReadonlySet<string>;
  readonly allowedPorts: ReadonlySet<number>;
}

interface NormalizedOptions {
  readonly fetch: ProviderHttpFetch;
  readonly resolveDispatchProfile: ProviderHttpDispatchProfileResolver;
  readonly resolveCredential: ProviderHttpCredentialResolver;
  readonly endpointPolicy: NormalizedEndpointPolicy;
  readonly testAddressCapability?: ProviderHttpTestAddressCapability;
  readonly egressAllowlist?: ProviderHttpEgressAllowlist;
  readonly resolveAddresses: ProviderHttpAddressResolver;
  readonly createConnector: ProviderHttpPinnedConnectorFactory;
  readonly timeoutMs: number;
  readonly maxPayloadBytes: number;
  readonly allowedCredentialHeaderNames: ReadonlySet<string>;
  readonly resolveFixedRequestHeaders?: ProviderHttpFixedRequestHeadersResolver;
  readonly mediaUsagePlan?: ProviderMediaUsagePlanFactory;
}

interface RequestContext {
  readonly request: PreparedEvidenceTransportRequest;
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
  readonly attachConnector: (connector: ProviderHttpPinnedConnector) => void;
  readonly disposeConnector: (error?: Error) => Promise<void>;
  readonly transferCleanup: () => void;
}

interface ValidatedTarget {
  readonly url: string;
  readonly hostname: string;
  readonly connectionHostname: string;
  readonly port: number;
}

function fail(code: ProviderHttpTransportErrorCode, message: string): never {
  throw new ProviderHttpTransportError(code, message);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
    fail('INVALID_INPUT', `${field} is required`);
  }
  return value.trim();
}

function boundedPositiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('INVALID_INPUT', `${field} must be a bounded positive integer`);
  }
  return value;
}

function normalizeHost(value: unknown): string {
  const candidate = nonEmpty(value, 'endpointPolicy.allowedHosts entry').toLowerCase();
  if (candidate.includes('*') || candidate.includes('/') || candidate.includes('?') || candidate.includes('#')) {
    fail('INVALID_INPUT', 'endpointPolicy.allowedHosts entries must be exact hostnames');
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${candidate}/`);
  } catch {
    fail('INVALID_INPUT', 'endpointPolicy.allowedHosts entries must be valid hostnames');
  }
  if (
    parsed.hostname !== candidate ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/'
  ) {
    fail('INVALID_INPUT', 'endpointPolicy.allowedHosts entries must be exact hostnames');
  }
  return parsed.hostname;
}

function normalizeEndpointPolicy(policy: ProviderHttpEndpointPolicy): NormalizedEndpointPolicy {
  if (!policy || !Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0) {
    fail('INVALID_INPUT', 'an exact endpoint host policy is required');
  }
  if (!Array.isArray(policy.allowedPorts) || policy.allowedPorts.length === 0) {
    fail('INVALID_INPUT', 'an exact endpoint port policy is required');
  }
  const allowedHosts = new Set(policy.allowedHosts.map(normalizeHost));
  const allowedPorts = new Set(
    policy.allowedPorts.map((port) => boundedPositiveInteger(port, 'endpointPolicy.allowedPorts entry', 65_535)),
  );
  return { allowedHosts, allowedPorts };
}

function normalizeHeaderName(value: unknown, allowed: ReadonlySet<string>): string {
  const name = nonEmpty(value, 'credential header name').toLowerCase();
  if (!HEADER_NAME.test(name) || !allowed.has(name)) {
    fail('CREDENTIAL_INVALID', 'credential header is not allowed');
  }
  if (name === 'accept' || name === 'content-type' || name === 'content-length') {
    fail('CREDENTIAL_INVALID', 'credential header conflicts with the fixed request header policy');
  }
  return name;
}

function normalizeHeaderValue(value: string | Uint8Array): { value: string; clear?: Uint8Array } {
  if (typeof value === 'string') {
    if (
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_VALUE_BYTES ||
      hasHeaderControl(value)
    ) {
      fail('CREDENTIAL_INVALID', 'credential header value is invalid');
    }
    return { value };
  }
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_CREDENTIAL_VALUE_BYTES) {
    fail('CREDENTIAL_INVALID', 'credential header value is invalid');
  }
  const clear = Buffer.from(value);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(clear);
  } catch {
    clear.fill(0);
    fail('CREDENTIAL_INVALID', 'credential header value is invalid');
  }
  if (decoded.length === 0 || hasHeaderControl(decoded)) {
    clear.fill(0);
    fail('CREDENTIAL_INVALID', 'credential header value is invalid');
  }
  return { value: decoded, clear };
}

function hasHeaderControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const MAX_FIXED_REQUEST_HEADERS = 8;
const MAX_FIXED_HEADER_NAME_LENGTH = 128;
const MAX_FIXED_HEADER_VALUE_BYTES = 1_024;

/**
 * R5b-4: validates and lowercases one fixed-header record. The reserved
 * names (credential allowlist + the transport-owned accept/content-type/
 * content-length/host set) are refused so the extension can never smuggle a
 * second authentication header or override the fixed request policy; the
 * credential injection still runs last and wins.
 */
function normalizeFixedRequestHeaders(
  value: unknown,
  allowedCredentialHeaderNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('FIXED_REQUEST_HEADERS_INVALID', 'fixed request headers must be a record');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FIXED_REQUEST_HEADERS) {
    fail('FIXED_REQUEST_HEADERS_INVALID', 'too many fixed request headers');
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (
      rawName.length === 0 ||
      rawName.length > MAX_FIXED_HEADER_NAME_LENGTH ||
      !HEADER_NAME.test(name) ||
      name === 'accept' ||
      name === 'content-type' ||
      name === 'content-length' ||
      name === 'host' ||
      allowedCredentialHeaderNames.has(name)
    ) {
      fail('FIXED_REQUEST_HEADERS_INVALID', 'fixed request header name is not allowed');
    }
    if (typeof rawValue !== 'string' || rawValue.length === 0 || hasHeaderControl(rawValue)) {
      fail('FIXED_REQUEST_HEADERS_INVALID', 'fixed request header value is invalid');
    }
    if (Buffer.byteLength(rawValue, 'utf8') > MAX_FIXED_HEADER_VALUE_BYTES) {
      fail('FIXED_REQUEST_HEADERS_INVALID', 'fixed request header value is too large');
    }
    if (Object.hasOwn(headers, name)) {
      fail('FIXED_REQUEST_HEADERS_INVALID', 'duplicate fixed request header');
    }
    headers[name] = rawValue;
  }
  return headers;
}

function normalizeOptions(options: ProviderHttpTransportOptions): NormalizedOptions {
  if (!options || typeof options.fetch !== 'function') fail('INVALID_INPUT', 'an injected fetch adapter is required');
  if (typeof options.resolveDispatchProfile !== 'function') {
    fail('INVALID_INPUT', 'a dispatch-profile resolver is required');
  }
  if (typeof options.resolveCredential !== 'function') fail('INVALID_INPUT', 'a credential resolver is required');
  if (options.resolveAddresses !== undefined && typeof options.resolveAddresses !== 'function') {
    fail('INVALID_INPUT', 'an address resolver must be callable');
  }
  if (options.createConnector !== undefined && typeof options.createConnector !== 'function') {
    fail('INVALID_INPUT', 'a pinned connector factory must be callable');
  }
  if (
    options.testAddressCapability !== undefined &&
    !isProviderHttpTestAddressCapability(options.testAddressCapability)
  ) {
    fail('INVALID_INPUT', 'the local provider address capability is unavailable');
  }
  if (
    options.egressAllowlist !== undefined &&
    (typeof options.egressAllowlist.allows !== 'function' || !Array.isArray(options.egressAllowlist.entries))
  ) {
    fail('INVALID_INPUT', 'the provider egress allowlist is invalid');
  }
  if (options.resolveFixedRequestHeaders !== undefined && typeof options.resolveFixedRequestHeaders !== 'function') {
    fail('INVALID_INPUT', 'a fixed request header resolver must be callable');
  }
  if (
    options.mediaUsagePlan !== undefined &&
    options.mediaUsagePlan !== null &&
    typeof options.mediaUsagePlan !== 'function'
  ) {
    fail('INVALID_INPUT', 'a media usage plan factory must be callable');
  }
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
  const maxPayloadBytes = boundedPositiveInteger(
    options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    'maxPayloadBytes',
    DEFAULT_MAX_PAYLOAD_BYTES,
  );
  const rawCredentialHeaders = options.allowedCredentialHeaderNames ?? DEFAULT_CREDENTIAL_HEADER_NAMES;
  if (!Array.isArray(rawCredentialHeaders) || rawCredentialHeaders.length === 0) {
    fail('INVALID_INPUT', 'an exact credential header policy is required');
  }
  const allowedCredentialHeaderNames = new Set(
    rawCredentialHeaders.map((name) => {
      const normalized = nonEmpty(name, 'allowedCredentialHeaderNames entry').toLowerCase();
      if (!HEADER_NAME.test(normalized)) fail('INVALID_INPUT', 'allowed credential header names are invalid');
      return normalized;
    }),
  );
  return {
    fetch: options.fetch,
    resolveDispatchProfile: options.resolveDispatchProfile,
    resolveCredential: options.resolveCredential,
    endpointPolicy: normalizeEndpointPolicy(options.endpointPolicy),
    ...(options.testAddressCapability === undefined ? {} : { testAddressCapability: options.testAddressCapability }),
    ...(options.egressAllowlist === undefined ? {} : { egressAllowlist: options.egressAllowlist }),
    resolveAddresses: options.resolveAddresses ?? resolveProviderHttpAddresses,
    createConnector:
      options.createConnector ??
      (options.testAddressCapability === undefined
        ? createPinnedProviderHttpConnector
        : createPinnedProviderHttpTestConnectorFactory(options.testAddressCapability)),
    timeoutMs,
    maxPayloadBytes,
    allowedCredentialHeaderNames,
    ...(options.resolveFixedRequestHeaders === undefined
      ? {}
      : { resolveFixedRequestHeaders: options.resolveFixedRequestHeaders }),
    ...(options.mediaUsagePlan === undefined || options.mediaUsagePlan === null
      ? {}
      : { mediaUsagePlan: options.mediaUsagePlan }),
  };
}

function assertAbortSignal(value: unknown): asserts value is AbortSignal {
  if (
    !value ||
    typeof (value as AbortSignal).aborted !== 'boolean' ||
    typeof (value as AbortSignal).addEventListener !== 'function' ||
    typeof (value as AbortSignal).removeEventListener !== 'function'
  ) {
    fail('INVALID_INPUT', 'an AbortSignal is required');
  }
}

function assertRequestBinding(input: PreparedEvidenceTransportRequest, maxPayloadBytes: number): Buffer {
  if (!input || typeof input !== 'object' || !input.evidence) fail('INVALID_INPUT', 'transport request is required');
  assertAbortSignal(input.signal);
  const fields: Array<readonly [string, unknown]> = [
    ['tenantId', input.tenantId],
    ['projectId', input.projectId],
    ['requestId', input.requestId],
    ['attemptId', input.attemptId],
    ['fencingToken', input.fencingToken],
  ];
  for (const [field, value] of fields) nonEmpty(value, field);
  if (!(input.payloadBytes instanceof Uint8Array) || input.payloadBytes.byteLength > maxPayloadBytes) {
    fail('INVALID_INPUT', 'payload bytes are invalid or exceed the transport limit');
  }
  const evidence = input.evidence;
  if (
    evidence.status !== 'claimed' ||
    evidence.claimedAttemptId !== input.attemptId ||
    evidence.tenantId !== input.tenantId ||
    evidence.projectId !== input.projectId ||
    evidence.requestId !== input.requestId ||
    typeof evidence.accountId !== 'string' ||
    evidence.accountId.trim() === '' ||
    typeof evidence.upstreamId !== 'string' ||
    evidence.upstreamId.trim() === '' ||
    typeof evidence.credentialId !== 'string' ||
    evidence.credentialId.trim() === '' ||
    typeof evidence.payloadSha256 !== 'string' ||
    evidence.payloadSha256.length !== 64 ||
    !SHA256.test(evidence.payloadSha256)
  ) {
    fail('PAYLOAD_BINDING_MISMATCH', 'prepared evidence is not bound to this transport request');
  }
  const body = Buffer.from(input.payloadBytes);
  const actualDigest = createHash('sha256').update(body).digest();
  const expectedDigest = Buffer.from(evidence.payloadSha256, 'hex');
  if (expectedDigest.length !== actualDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    fail('PAYLOAD_BINDING_MISMATCH', 'payload bytes do not match prepared evidence');
  }
  return body;
}

function targetUrlFromProfile(profile: ProviderHttpDispatchProfile | null): string {
  if (!profile || typeof profile !== 'object') fail('PROFILE_UNAVAILABLE', 'dispatch profile is unavailable');
  const url = profile.url ?? profile.targetUrl;
  if (typeof url !== 'string' || url.trim() === '') fail('PROFILE_INVALID', 'dispatch profile target is invalid');
  return url;
}

/**
 * R3: normalize the profile's egress-proxy descriptor. The shape check is
 * deliberately strict (one url key, non-empty string); address validation
 * and pinning happen in resolveEgressProxyTarget with safe error messages
 * that never echo the URL or its credentials.
 */
function egressProxyFromProfile(profile: ProviderHttpDispatchProfile | null): { readonly url: string } | null {
  if (!profile || typeof profile !== 'object') fail('PROFILE_UNAVAILABLE', 'dispatch profile is unavailable');
  const proxy = (profile as { readonly egressProxy?: unknown }).egressProxy;
  if (proxy === undefined || proxy === null) return null;
  if (
    typeof proxy !== 'object' ||
    Object.keys(proxy).length !== 1 ||
    typeof (proxy as { readonly url?: unknown }).url !== 'string'
  ) {
    fail('EGRESS_PROXY_INVALID', 'dispatch profile egress proxy is invalid');
  }
  const url = (proxy as { readonly url: string }).url;
  if (url === '') fail('EGRESS_PROXY_INVALID', 'dispatch profile egress proxy is invalid');
  return { url };
}

/**
 * Batch-2 §2.4: normalize the profile's TLS-fingerprint descriptor. The
 * shape is validated strictly (isProviderTlsFingerprintEgress — unknown keys
 * rejected) so a malformed descriptor fails closed at the dispatch-profile
 * boundary; a missing descriptor keeps the ordinary connector.
 */
function tlsFingerprintFromProfile(profile: ProviderHttpDispatchProfile | null): ProviderTlsFingerprintEgress | null {
  if (!profile || typeof profile !== 'object') fail('PROFILE_UNAVAILABLE', 'dispatch profile is unavailable');
  const descriptor = (profile as { readonly tlsFingerprint?: unknown }).tlsFingerprint;
  if (descriptor === undefined || descriptor === null) return null;
  if (!isProviderTlsFingerprintEgress(descriptor)) {
    fail('TLS_FINGERPRINT_INVALID', 'dispatch profile tls fingerprint is invalid');
  }
  return descriptor;
}

function validateTargetUrl(value: string, policy: NormalizedEndpointPolicy): ValidatedTarget {
  if (value !== value.trim()) fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target is not a valid URL');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || value[index] === '\\') {
      fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target is not a valid URL');
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target is not a valid URL');
  }
  const authority = /^https:\/\/([^/?#\\]*)/i.exec(value)?.[1];
  if (!authority || authority.includes('@') || authority.includes('%') || /\s/.test(authority)) {
    fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target violates the HTTPS endpoint policy');
  }
  let rawHostname: string;
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    if (closingBracket < 0) fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target is not a valid URL');
    rawHostname = authority.slice(1, closingBracket);
    const rawPort = authority.slice(closingBracket + 1);
    if (rawPort !== '' && !/^:\d+$/.test(rawPort)) {
      fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target is not a valid URL');
    }
  } else {
    const colon = authority.lastIndexOf(':');
    rawHostname = colon < 0 ? authority : authority.slice(0, colon);
  }
  const parsedHostname =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const literalFamily = isIP(parsedHostname);
  if (literalFamily > 0) {
    if (isIP(rawHostname) !== literalFamily || (literalFamily === 4 && rawHostname !== parsedHostname)) {
      fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target contains an ambiguous IP address');
    }
  } else if (/^\d+(?:\.\d+)*\.?$/.test(rawHostname)) {
    fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target contains an ambiguous IP address');
  }
  const effectivePort = parsed.port === '' ? 443 : Number(parsed.port);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.search !== '' ||
    !policy.allowedHosts.has(parsed.hostname) ||
    !policy.allowedPorts.has(effectivePort)
  ) {
    fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile target violates the HTTPS endpoint policy');
  }
  return {
    url: parsed.toString(),
    hostname: parsed.hostname,
    connectionHostname: parsedHostname,
    port: effectivePort,
  };
}

function assertActive(context: RequestContext): void {
  if (context.timedOut()) fail('TIMEOUT', 'provider HTTP transport timed out');
  if (context.request.signal.aborted) fail('ABORTED', 'provider HTTP transport was aborted');
}

function responseHeaders(response: Response): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return Object.freeze(headers);
}

function isEventStreamContentType(value: string | null): boolean {
  if (value === null) return false;
  const separator = value.indexOf(';');
  const mediaType = (separator < 0 ? value : value.slice(0, separator)).trim();
  return mediaType.toLowerCase() === 'text/event-stream';
}

function normalizeStreamError(context: RequestContext, error: unknown): ProviderHttpTransportError {
  if (error instanceof ProviderHttpTransportError) return error;
  if (context.timedOut()) return new ProviderHttpTransportError('TIMEOUT', 'provider HTTP transport timed out');
  if (context.request.signal.aborted || context.signal.aborted) {
    return new ProviderHttpTransportError('ABORTED', 'provider HTTP transport was aborted');
  }
  return new ProviderHttpTransportError('NETWORK_ERROR', 'provider HTTP response stream failed');
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('provider HTTP response stream was cancelled');
}

function managedResponseBody(body: ReadableStream<Uint8Array>, context: RequestContext): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cleaned = false;
  let cancelled: Promise<void> | undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    context.signal.removeEventListener('abort', onAbort);
    context.cleanup();
  };
  const cancelReader = (reason: unknown): Promise<void> => {
    cancelled ??= reader.cancel(reason).catch(() => undefined);
    return cancelled;
  };
  const onAbort = () => {
    const error = new Error('provider HTTP response stream was aborted');
    void context.disposeConnector(error).finally(async () => {
      await cancelReader(error);
      cleanup();
    });
  };
  context.signal.addEventListener('abort', onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertActive(context);
        const next = await reader.read();
        assertActive(context);
        if (next.done) {
          await context.disposeConnector();
          cleanup();
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw new ProviderHttpTransportError(
            'INVALID_RESPONSE',
            'provider HTTP response body returned an invalid chunk',
          );
        }
        controller.enqueue(next.value);
      } catch (error) {
        const normalized = normalizeStreamError(context, error);
        await cancelReader(normalized);
        await context.disposeConnector(normalized);
        cleanup();
        try {
          reader.releaseLock();
        } catch {
          // The reader may already have been released by an equivalent stream adapter.
        }
        controller.error(normalized);
      }
    },
    async cancel(reason) {
      await context.disposeConnector(asError(reason));
      await cancelReader(reason);
      cleanup();
      try {
        reader.releaseLock();
      } catch {
        // The reader may already have been released by an equivalent stream adapter.
      }
    },
  });
}

function profileInput(
  request: PreparedEvidenceTransportRequest,
  signal: AbortSignal,
): ProviderHttpDispatchProfileResolveInput {
  return {
    tenantId: request.tenantId,
    projectId: request.projectId,
    requestId: request.requestId,
    attemptId: request.attemptId,
    evidenceId: request.evidence.evidenceId,
    accountId: request.evidence.accountId,
    upstreamId: request.evidence.upstreamId,
    protocol: request.evidence.protocol,
    endpoint: request.evidence.endpoint,
    providerProtocol: request.evidence.providerProtocol,
    providerOperation: request.evidence.providerOperation,
    supplyMode: request.evidence.supplyMode,
    accountOwnerKind: request.evidence.accountOwnerKind,
    signal,
  };
}

function credentialInput(
  request: PreparedEvidenceTransportRequest,
  signal: AbortSignal,
): ProviderHttpCredentialResolveInput {
  return {
    tenantId: request.tenantId,
    projectId: request.projectId,
    requestId: request.requestId,
    attemptId: request.attemptId,
    evidenceId: request.evidence.evidenceId,
    accountId: request.evidence.accountId,
    upstreamId: request.evidence.upstreamId,
    credentialId: request.evidence.credentialId,
    credentialVersion: request.evidence.credentialVersion,
    signal,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body || typeof response.body.cancel !== 'function') return;
  try {
    await response.body.cancel();
  } catch {
    // A response has already started; body cleanup must not change its classification.
  }
}

export class ProviderHttpTransport implements PreparedEvidenceTransport {
  private readonly options: NormalizedOptions;

  constructor(options: ProviderHttpTransportOptions) {
    this.options = normalizeOptions(options);
  }

  async send(input: PreparedEvidenceTransportRequest): Promise<PreparedEvidenceTransportResponse> {
    const body = assertRequestBinding(input, this.options.maxPayloadBytes);
    const controller = new AbortController();
    let timedOut = false;
    let cleanupTransferred = false;
    let cleaned = false;
    let connector: ProviderHttpPinnedConnector | undefined;
    let connectorDisposal: Promise<void> | undefined;
    const disposeConnector = (error?: Error): Promise<void> => {
      if (!connector) return Promise.resolve();
      if (!connectorDisposal) {
        connectorDisposal = (async () => {
          try {
            if (error) await connector?.destroy(error);
            else await connector?.close();
          } catch {
            if (!error) {
              try {
                await connector?.destroy(new Error('provider HTTP connector cleanup failed'));
              } catch {
                // Cleanup failures must not replace the transport result.
              }
            }
          }
        })();
      }
      return connectorDisposal;
    };
    const abortFromLease = () => controller.abort();
    const abortConnector = () => {
      void disposeConnector(new Error('provider HTTP request was aborted'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    input.signal.addEventListener('abort', abortFromLease, { once: true });
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abortFromLease);
      controller.signal.removeEventListener('abort', abortConnector);
    };
    controller.signal.addEventListener('abort', abortConnector, { once: true });
    const context: RequestContext = {
      request: input,
      signal: controller.signal,
      timedOut: () => timedOut,
      cleanup,
      attachConnector: (nextConnector) => {
        connector = nextConnector;
      },
      disposeConnector,
      transferCleanup: () => {
        cleanupTransferred = true;
      },
    };
    try {
      assertActive(context);
      let profile: ProviderHttpDispatchProfile | null;
      try {
        profile = await this.options.resolveDispatchProfile(profileInput(input, controller.signal));
      } catch (error) {
        assertActive(context);
        if (error instanceof ProviderHttpTransportError) throw error;
        fail('PROFILE_UNAVAILABLE', 'dispatch profile resolution failed');
      }
      assertActive(context);
      const target = validateTargetUrl(targetUrlFromProfile(profile), this.options.endpointPolicy);
      let resolvedAddresses: readonly ProviderHttpResolvedAddress[] = [];
      if (isIP(target.connectionHostname) === 0) {
        try {
          resolvedAddresses = await this.options.resolveAddresses(target.connectionHostname, controller.signal);
        } catch {
          assertActive(context);
          fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile host could not be resolved safely');
        }
      }
      assertActive(context);
      let pinnedAddress: ProviderHttpResolvedAddress;
      try {
        pinnedAddress = selectPinnedProviderAddress(
          target.connectionHostname,
          resolvedAddresses,
          this.options.testAddressCapability,
          this.options.egressAllowlist,
        );
      } catch {
        fail('ENDPOINT_POLICY_VIOLATION', 'dispatch profile host did not resolve exclusively to public addresses');
      }
      // R3 egress proxies: validate + whitelist-pin the account's proxy host
      // through the same address policy as the provider endpoint itself. A
      // malformed or non-public proxy fails closed — never a silent fallback
      // to direct egress (that would change the account's exit IP).
      let egressProxy: ProviderHttpEgressProxyTarget | undefined;
      const proxyDescriptor = egressProxyFromProfile(profile);
      if (proxyDescriptor !== null) {
        try {
          egressProxy = await resolveEgressProxyTarget(proxyDescriptor, {
            resolveAddresses: this.options.resolveAddresses,
            ...(this.options.testAddressCapability === undefined
              ? {}
              : { testCapability: this.options.testAddressCapability }),
            ...(this.options.egressAllowlist === undefined ? {} : { egressAllowlist: this.options.egressAllowlist }),
            signal: context.signal,
          });
        } catch (error) {
          assertActive(context);
          if (error instanceof ProviderHttpTransportError) throw error;
          fail('EGRESS_PROXY_INVALID', 'dispatch profile egress proxy is invalid');
        }
      }
      assertActive(context);
      // Batch-2 §2.4: the account's resolved TLS-fingerprint descriptor rides
      // on the dispatch profile next to the egress proxy. Unlike a bound
      // proxy, a malformed/unreadable fingerprint never fails the dispatch —
      // resolution happens in the profile resolver (fail-open to the default
      // profile); this boundary only rejects structurally invalid payloads.
      const tlsFingerprint = tlsFingerprintFromProfile(profile);
      assertActive(context);
      // R5b-4: deployment-owned per-protocol fixed headers (e.g. the OpenCode
      // Go anthropic-version header), resolved from the signed dispatch facts
      // before any credential material exists.
      let fixedRequestHeaders: Readonly<Record<string, string>> = {};
      if (this.options.resolveFixedRequestHeaders) {
        try {
          fixedRequestHeaders = normalizeFixedRequestHeaders(
            await this.options.resolveFixedRequestHeaders({
              protocol: input.evidence.protocol,
              endpoint: input.evidence.endpoint,
              providerProtocol: input.evidence.providerProtocol,
              providerOperation: input.evidence.providerOperation,
            }),
            this.options.allowedCredentialHeaderNames,
          );
        } catch (error) {
          assertActive(context);
          if (error instanceof ProviderHttpTransportError) throw error;
          fail('FIXED_REQUEST_HEADERS_INVALID', 'fixed request header resolution failed');
        }
      }
      let callbackUsed = false;
      let result: PreparedEvidenceTransportResponse | undefined;
      try {
        await this.options.resolveCredential(credentialInput(input, controller.signal), async (credential) => {
          if (callbackUsed) fail('CREDENTIAL_INVALID', 'credential resolver injected more than one credential');
          callbackUsed = true;
          assertActive(context);
          const headerName = normalizeHeaderName(credential?.headerName, this.options.allowedCredentialHeaderNames);
          const headerValue = normalizeHeaderValue(credential?.value);
          try {
            result = await this.sendFetch(
              context,
              target,
              pinnedAddress,
              body,
              headerName,
              headerValue.value,
              fixedRequestHeaders,
              egressProxy,
              tlsFingerprint ?? undefined,
            );
            return result;
          } finally {
            headerValue.clear?.fill(0);
          }
        });
      } catch (error) {
        assertActive(context);
        if (error instanceof ProviderHttpTransportError) throw error;
        fail('CREDENTIAL_UNAVAILABLE', 'credential resolution failed');
      }
      try {
        assertActive(context);
      } catch (error) {
        if (result?.body) await result.body.cancel(error);
        throw error;
      }
      if (!callbackUsed || !result) fail('CREDENTIAL_UNAVAILABLE', 'credential resolver did not inject a credential');
      return result;
    } finally {
      if (!cleanupTransferred) {
        await disposeConnector();
        cleanup();
      }
    }
  }

  private async sendFetch(
    context: RequestContext,
    target: ValidatedTarget,
    pinnedAddress: ProviderHttpResolvedAddress,
    body: Buffer,
    credentialHeaderName: string,
    credentialHeaderValue: string,
    fixedRequestHeaders: Readonly<Record<string, string>> = {},
    egressProxy?: ProviderHttpEgressProxyTarget,
    tlsFingerprint?: ProviderTlsFingerprintEgress,
  ): Promise<PreparedEvidenceTransportResponse> {
    const headers = new Headers(FIXED_REQUEST_HEADERS);
    // R5b-4 per-protocol fixed headers sit between the transport-owned fixed
    // pair and the credential header, so the credential always wins and the
    // fixed pair can never be removed — only extended.
    for (const [name, value] of Object.entries(fixedRequestHeaders)) {
      headers.set(name, value);
    }
    headers.set(credentialHeaderName, credentialHeaderValue);
    let connector: ProviderHttpPinnedConnector;
    try {
      connector = this.options.createConnector({
        hostname: target.connectionHostname,
        port: target.port,
        address: pinnedAddress.address,
        family: pinnedAddress.family,
        ...(egressProxy === undefined ? {} : { proxy: egressProxy }),
        ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
      });
      if (
        !connector ||
        typeof connector.close !== 'function' ||
        typeof connector.destroy !== 'function' ||
        !connector.dispatcher
      ) {
        fail('NETWORK_ERROR', 'provider HTTP connector could not be created');
      }
      context.attachConnector(connector);
    } catch (error) {
      if (error instanceof ProviderHttpTransportError) throw error;
      fail('NETWORK_ERROR', 'provider HTTP connector could not be created');
    }
    assertActive(context);
    let response: Response;
    try {
      response = await this.options.fetch(target.url, {
        method: 'POST',
        // The DOM-lib Headers type predates undici's structurally stricter
        // HeadersInit; the instance is a plain header bag at runtime.
        headers: headers as unknown as Parameters<ProviderHttpFetch>[1]['headers'],
        body,
        redirect: 'manual',
        signal: context.signal,
        dispatcher: connector.dispatcher,
      });
    } catch (error) {
      assertActive(context);
      if (error instanceof ProviderHttpTransportError) throw error;
      fail('NETWORK_ERROR', 'provider HTTP request failed');
    }
    assertActive(context);
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      fail('INVALID_RESPONSE', 'provider HTTP adapter returned an invalid response');
    }
    if (response.status >= 300 && response.status <= 399) {
      await cancelResponseBody(response);
      fail('REDIRECT_REJECTED', 'provider HTTP redirect was rejected');
    }
    if (response.status < 100 || response.status > 599) {
      await cancelResponseBody(response);
      fail('INVALID_RESPONSE', 'provider HTTP adapter returned an invalid status');
    }
    const responseBody = response.body ? managedResponseBody(response.body, context) : null;
    const safeResponseHeaders = responseHeaders(response);
    /*
     * R3 §8.2: freeze the tier actually sent upstream from the signed payload
     * bytes (post-transform truth). Every 2xx observation branch below pairs
     * it with the tier the response declares, so tier evidence flows for
     * regular text, SSE, and the media/dedicated operations alike.
     */
    const outboundServiceTier = outboundServiceTierFromPayload(context.request.payloadBytes);

    /*
     * §4.3 (task #17): the search emulation operations adapt the upstream
     * Responses envelope into the client search body before any generic
     * observer sees it. The descriptor is recovered from the signed,
     * digest-verified payload bytes themselves (the server-owned
     * construction round-trips exactly) and requires the client-side search
     * operation fact; a payload that does not round-trip fails the dispatch
     * closed rather than leaking an untransformed envelope.
     */
    const searchClientOperation = context.request.clientOperation ?? context.request.evidence.clientOperation;
    if (
      responseBody &&
      response.status >= 200 &&
      response.status < 300 &&
      (searchClientOperation === 'web_search' || searchClientOperation === 'x_search')
    ) {
      const descriptor = searchDescriptorForDispatch(parsePayloadJson(body), searchClientOperation);
      if (descriptor === null) {
        await cancelResponseBody(response);
        fail('INVALID_INPUT', 'search dispatch payload is not the search emulation body');
      }
      const observed = observeSearchProviderResponse(responseBody, descriptor);
      const result: PreparedEvidenceTransportResponse = {
        responseStarted: false,
        resultHttpStatus: response.status,
        headers: safeResponseHeaders,
        body: observed.body,
        get providerUsage() {
          return observed.getUsage();
        },
      };
      context.transferCleanup();
      return result;
    }

    if (responseBody && isEventStreamContentType(response.headers.get('content-type'))) {
      const observed = observeProviderSseUsage(responseBody, {
        providerProtocol: context.request.evidence.providerProtocol,
        providerOperation: context.request.evidence.providerOperation,
      });
      const result = {
        responseStarted: false,
        resultHttpStatus: response.status,
        headers: safeResponseHeaders,
        body: observed.body,
        // R3 §8.2/§8.3: the SSE branch carries tier evidence too — the
        // frozen outbound tier plus the stream's declared (merged) tier. The
        // lazy getter resolves at body EOF, the same contract as providerUsage.
        get serviceTier(): TransportServiceTierEvidence | null {
          const observation = observed.getObservation();
          const tier: TransportServiceTierEvidence = {
            requested: outboundServiceTier,
            observed: observation?.observedServiceTier ?? null,
            ...(observation?.observedServiceTierConflict === true ? { observedConflict: true } : {}),
          };
          return tier.requested === null && tier.observed === null && tier.observedConflict !== true ? null : tier;
        },
        // R3 §8.2: the bounded usage-evidence object — same lazy contract.
        get usageEvidence(): NormalizedUsageEvidence | null {
          const observation = observed.getObservation();
          const usage = observation?.state === 'reported' ? observation.usage : null;
          return createUsageEvidence({
            meteringSource: 'provider-sse-usage-observer',
            observerVersion: PROVIDER_SSE_USAGE_OBSERVER_VERSION,
            outboundServiceTier,
            serviceTier: {
              requested: outboundServiceTier,
              observed: observation?.observedServiceTier ?? null,
              ...(observation?.observedServiceTierConflict === true ? { observedConflict: true } : {}),
            },
            billingMode: usage?.billingMode ?? null,
            units: usage?.units === null || usage?.units === undefined ? null : String(usage.units),
            sizeTier: usage?.sizeTier ?? null,
            model: context.request.evidence.resolvedModel ?? null,
            operation: context.request.evidence.providerOperation ?? null,
            completeness: usageEvidenceCompleteness({
              state: observation?.state === 'reported' ? 'reported' : 'unknown',
              reason: observation?.state === 'unknown' ? observation.reason : undefined,
            }),
            adapterVersion: context.request.evidence.payloadCompilerVersion ?? null,
          });
        },
        get providerUsage() {
          const observation = observed.getObservation();
          return observation?.state === 'reported' ? observation.usage : null;
        },
      };
      context.transferCleanup();
      return result;
    }

    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (responseBody && mediaType === 'application/json' && response.status >= 200 && response.status < 300) {
      // §4.2: bind the media usage plan (if a factory is wired) for
      // operations the token observers do not know; a factory failure keeps
      // the observation at the observer's unknown outcome, never a guess.
      let mediaPlan: ProviderMediaUsagePlan | null = null;
      if (this.options.mediaUsagePlan) {
        try {
          mediaPlan = this.options.mediaUsagePlan({
            providerOperation: context.request.evidence.providerOperation,
            payloadBytes: context.request.payloadBytes,
          });
        } catch {
          mediaPlan = null;
        }
      }
      const observed = observeProviderJsonUsage(
        responseBody,
        {
          providerProtocol: context.request.evidence.providerProtocol,
          providerOperation: context.request.evidence.providerOperation,
        },
        mediaPlan?.extractor ?? null,
      );
      const result = {
        responseStarted: false,
        resultHttpStatus: response.status,
        headers: safeResponseHeaders,
        body: observed.body,
        // R3 §8.2/§8.3 (B05): tier evidence no longer rides the media plan
        // alone — every JSON observation pairs the frozen outbound tier with
        // the response's declared tier (images included), resolved lazily at
        // body EOF exactly like providerUsage.
        get serviceTier(): TransportServiceTierEvidence | null {
          const observation = observed.getObservation();
          // A category plan may pin the requested tier under a field the
          // generic payload scan does not know; it is a fallback, never an
          // override of the frozen outbound value.
          const requested = outboundServiceTier ?? mediaPlan?.serviceTier?.requested ?? null;
          const tier: TransportServiceTierEvidence = {
            requested,
            observed: observation?.observedServiceTier ?? null,
          };
          return tier.requested === null && tier.observed === null ? null : tier;
        },
        // R3 §8.2: the bounded usage-evidence object — same lazy contract.
        get usageEvidence(): NormalizedUsageEvidence | null {
          const observation = observed.getObservation();
          const usage = observation?.state === 'reported' ? observation.usage : null;
          const requested = outboundServiceTier ?? mediaPlan?.serviceTier?.requested ?? null;
          return createUsageEvidence({
            meteringSource: 'provider-json-usage-observer',
            observerVersion: PROVIDER_JSON_USAGE_OBSERVER_VERSION,
            outboundServiceTier: requested,
            serviceTier: { requested, observed: observation?.observedServiceTier ?? null },
            billingMode: usage?.billingMode ?? null,
            units: usage?.units === null || usage?.units === undefined ? null : String(usage.units),
            sizeTier: usage?.sizeTier ?? null,
            model: context.request.evidence.resolvedModel ?? null,
            operation: context.request.evidence.providerOperation ?? null,
            completeness: usageEvidenceCompleteness({
              state: observation?.state === 'reported' ? 'reported' : 'unknown',
              reason: observation?.state === 'unknown' ? observation.reason : undefined,
            }),
            adapterVersion: context.request.evidence.payloadCompilerVersion ?? null,
          });
        },
        get providerUsage() {
          const observation = observed.getObservation();
          return observation?.state === 'reported' ? observation.usage : null;
        },
      };
      context.transferCleanup();
      return result;
    }

    const result = {
      responseStarted: false,
      resultHttpStatus: response.status,
      headers: safeResponseHeaders,
      body: responseBody,
    };
    if (result.body) context.transferCleanup();
    return result;
  }
}
