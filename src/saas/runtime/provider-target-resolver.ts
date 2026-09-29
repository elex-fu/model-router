import { isIP } from 'node:net';
import {
  isGlobalProviderAddress,
  isLoopbackProviderAddress,
  isProviderHttpTestAddressCapability,
  type ProviderHttpTestAddressCapability,
} from '../gateway/provider-http-address.js';
import type { ProviderHttpDispatchProfile, ProviderHttpEndpointPolicy } from '../gateway/provider-http-transport.js';

const MAX_KEY_BYTES = 256;
const MAX_URL_BYTES = 4096;
const MAX_PATH_BYTES = 2048;
const OPAQUE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;

/** The current provider HTTP transport sends one fixed request method. */
export type ProviderTargetMethod = 'POST';

const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_CONFIGURATION: 'Provider target binding configuration is invalid',
  INVALID_INPUT: 'Provider target resolver input is invalid',
  BINDING_NOT_FOUND:
    'Provider target binding is not configured; wildcard or custom-provider paths require an explicit fixed contract',
  TARGET_POLICY_VIOLATION: 'Provider target violates the HTTPS endpoint policy',
  UNSUPPORTED_METHOD: 'Provider target method is not supported by the runtime transport',
} satisfies Record<string, string>);

export type ProviderTargetResolverErrorCode = keyof typeof SAFE_ERROR_MESSAGES;

/** Runtime errors never include URLs, credentials, request values, or provider details. */
export class ProviderTargetResolverError extends Error {
  constructor(readonly code: ProviderTargetResolverErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'ProviderTargetResolverError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ProviderTargetBindingCommon {
  readonly upstreamId: string;
  readonly protocol: string;
  readonly operation: string;
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly path: string;
  readonly method: ProviderTargetMethod;
}

/**
 * One exact deployment-owned mapping. `product` is accepted for the generic
 * runtime contract while `productId` matches the supply snapshot vocabulary.
 * Exactly one of them must be present; neither is request-derived.
 */
export type ProviderTargetBinding = ProviderTargetBindingCommon &
  ({ readonly product: string; readonly productId?: never } | { readonly productId: string; readonly product?: never });

/** The binding map is represented as exact tuple entries; duplicate tuples fail at startup. */
export type ProviderTargetBindingMap = readonly ProviderTargetBinding[];

export interface ProviderTargetResolverOptions {
  /** Deployment-trusted entries. This collection is copied and frozen at construction. */
  readonly bindings: ProviderTargetBindingMap;
  /** Explicit test-only permission for an HTTPS target at a loopback IP literal. */
  readonly testAddressCapability?: ProviderHttpTestAddressCapability;
}

export type ProviderTargetResolveInput =
  | {
      readonly upstreamId: string;
      readonly product: string;
      readonly productId?: never;
      readonly protocol: string;
      readonly operation: string;
    }
  | {
      readonly upstreamId: string;
      readonly product?: never;
      readonly productId: string;
      readonly protocol: string;
      readonly operation: string;
    };

/** A complete server-owned target profile; no request URL/path is carried in it. */
export interface ProviderTarget extends ProviderHttpDispatchProfile {
  readonly method: ProviderTargetMethod;
  /** The binding policy is exposed for composition with the transport's exact policy. */
  readonly endpointPolicy: ProviderHttpEndpointPolicy;
}

interface NormalizedKey {
  readonly upstreamId: string;
  readonly productId: string;
  readonly protocol: string;
  readonly operation: string;
}

interface NormalizedBinding extends NormalizedKey {
  readonly target: ProviderTarget;
}

type BindingSnapshot = Readonly<Record<string, NormalizedBinding>>;

function resolverError(code: ProviderTargetResolverErrorCode): ProviderTargetResolverError {
  return new ProviderTargetResolverError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    throw resolverError('INVALID_CONFIGURATION');
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw resolverError('INVALID_CONFIGURATION');
  return value;
}

function inputText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    throw resolverError('INVALID_INPUT');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) throw resolverError('INVALID_INPUT');
  return value;
}

function opaqueKey(value: unknown, input: boolean): string {
  const normalized = input ? inputText(value) : text(value, MAX_KEY_BYTES);
  if (!OPAQUE_KEY.test(normalized)) throw resolverError(input ? 'INVALID_INPUT' : 'INVALID_CONFIGURATION');
  return normalized;
}

function productFromRecord(value: Record<string, unknown>, input: boolean): string {
  const hasProduct = Object.hasOwn(value, 'product');
  const hasProductId = Object.hasOwn(value, 'productId');
  if (hasProduct === hasProductId) throw resolverError(input ? 'INVALID_INPUT' : 'INVALID_CONFIGURATION');
  return opaqueKey(value[hasProduct ? 'product' : 'productId'], input);
}

function bindingKey(key: NormalizedKey): string {
  return [key.upstreamId, key.productId, key.protocol, key.operation].map((part) => `${part.length}:${part}`).join('|');
}

function normalizeKey(value: unknown, input: boolean): NormalizedKey {
  try {
    if (!isPlainRecord(value)) throw resolverError(input ? 'INVALID_INPUT' : 'INVALID_CONFIGURATION');
    const expected = input
      ? ['upstreamId', 'product', 'protocol', 'operation']
      : ['upstreamId', 'product', 'protocol', 'operation', 'baseUrl', 'allowedHosts', 'allowedPorts', 'path', 'method'];
    const expectedWithProductId = input
      ? ['upstreamId', 'productId', 'protocol', 'operation']
      : [
          'upstreamId',
          'productId',
          'protocol',
          'operation',
          'baseUrl',
          'allowedHosts',
          'allowedPorts',
          'path',
          'method',
        ];
    if (!hasExactKeys(value, expected) && !hasExactKeys(value, expectedWithProductId)) {
      throw resolverError(input ? 'INVALID_INPUT' : 'INVALID_CONFIGURATION');
    }
    return {
      upstreamId: opaqueKey(value.upstreamId, input),
      productId: productFromRecord(value, input),
      protocol: opaqueKey(value.protocol, input),
      operation: opaqueKey(value.operation, input),
    };
  } catch (error) {
    if (error instanceof ProviderTargetResolverError) throw error;
    throw resolverError(input ? 'INVALID_INPUT' : 'INVALID_CONFIGURATION');
  }
}

function normalizeHost(value: unknown): string {
  const candidate = text(value, MAX_KEY_BYTES).toLowerCase();
  if (candidate.includes('*') || candidate.includes('/') || candidate.includes('?') || candidate.includes('#')) {
    throw resolverError('INVALID_CONFIGURATION');
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${candidate}/`);
  } catch {
    throw resolverError('INVALID_CONFIGURATION');
  }
  if (
    parsed.hostname !== candidate ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw resolverError('INVALID_CONFIGURATION');
  }
  return parsed.hostname;
}

function normalizeHosts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw resolverError('INVALID_CONFIGURATION');
  const hosts = [...new Set(value.map(normalizeHost))];
  if (hosts.length === 0) throw resolverError('INVALID_CONFIGURATION');
  return Object.freeze(hosts);
}

function normalizePorts(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) throw resolverError('INVALID_CONFIGURATION');
  const ports = value.map((port) => {
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw resolverError('INVALID_CONFIGURATION');
    }
    return port;
  });
  return Object.freeze([...new Set(ports)]);
}

function validPath(value: string, allowTrailingSlash: boolean): boolean {
  if (value === '/') return true;
  if (!value.startsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#')) return false;
  if (value.includes('//')) return false;
  const path = allowTrailingSlash && value.endsWith('/') ? value.slice(0, -1) : value;
  if (path === '' || path === '/') return false;
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment));
}

function normalizeBaseUrl(value: unknown): {
  readonly origin: string;
  readonly pathname: string;
  readonly hostname: string;
  readonly port: number;
} {
  const raw = text(value, MAX_URL_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw resolverError('INVALID_CONFIGURATION');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !validPath(parsed.pathname, true)
  ) {
    throw resolverError('INVALID_CONFIGURATION');
  }
  const pathname =
    parsed.pathname === '/' ? '' : parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return {
    origin: parsed.origin,
    pathname,
    hostname: parsed.hostname,
    port: parsed.port === '' ? 443 : Number(parsed.port),
  };
}

function normalizeOperationPath(value: unknown): string {
  const path = text(value, MAX_PATH_BYTES);
  if (!validPath(path, false)) throw resolverError('INVALID_CONFIGURATION');
  return path;
}

function normalizeMethod(value: unknown): ProviderTargetMethod {
  if (value !== 'POST') throw resolverError('UNSUPPORTED_METHOD');
  return value;
}

function normalizeBinding(value: unknown, allowLoopbackTestTarget: boolean): NormalizedBinding {
  const key = normalizeKey(value, false);
  try {
    if (!isPlainRecord(value)) throw resolverError('INVALID_CONFIGURATION');
    const base = normalizeBaseUrl(value.baseUrl);
    if (
      isIP(base.hostname) > 0 &&
      !isGlobalProviderAddress(base.hostname) &&
      !(allowLoopbackTestTarget && isLoopbackProviderAddress(base.hostname))
    ) {
      throw resolverError('TARGET_POLICY_VIOLATION');
    }
    const allowedHosts = normalizeHosts(value.allowedHosts);
    const allowedPorts = normalizePorts(value.allowedPorts);
    const path = normalizeOperationPath(value.path);
    const method = normalizeMethod(value.method);
    if (!allowedHosts.includes(base.hostname) || !allowedPorts.includes(base.port)) {
      throw resolverError('TARGET_POLICY_VIOLATION');
    }
    const fullPath = `${base.pathname}${path}`;
    let parsedTarget: URL;
    try {
      parsedTarget = new URL(`${base.origin}${fullPath}`);
    } catch {
      throw resolverError('INVALID_CONFIGURATION');
    }
    const targetPort = parsedTarget.port === '' ? 443 : Number(parsedTarget.port);
    if (
      parsedTarget.protocol !== 'https:' ||
      parsedTarget.username !== '' ||
      parsedTarget.password !== '' ||
      parsedTarget.search !== '' ||
      parsedTarget.hash !== '' ||
      parsedTarget.hostname !== base.hostname ||
      targetPort !== base.port ||
      !allowedHosts.includes(parsedTarget.hostname) ||
      !allowedPorts.includes(targetPort)
    ) {
      throw resolverError('TARGET_POLICY_VIOLATION');
    }
    const endpointPolicy = Object.freeze({ allowedHosts, allowedPorts });
    const target = Object.freeze({
      url: parsedTarget.toString(),
      method,
      endpointPolicy,
    });
    return Object.freeze({ ...key, target });
  } catch (error) {
    if (error instanceof ProviderTargetResolverError) throw error;
    throw resolverError('INVALID_CONFIGURATION');
  }
}

function normalizeBindings(value: unknown, allowLoopbackTestTarget: boolean): BindingSnapshot {
  try {
    if (!Array.isArray(value)) throw resolverError('INVALID_CONFIGURATION');
    const snapshot = Object.create(null) as Record<string, NormalizedBinding>;
    for (const candidate of value) {
      const binding = normalizeBinding(candidate, allowLoopbackTestTarget);
      const key = bindingKey(binding);
      if (Object.hasOwn(snapshot, key)) throw resolverError('INVALID_CONFIGURATION');
      snapshot[key] = binding;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof ProviderTargetResolverError) throw error;
    throw resolverError('INVALID_CONFIGURATION');
  }
}

function normalizeOptions(options: unknown): BindingSnapshot {
  try {
    if (
      !isPlainRecord(options) ||
      (!hasExactKeys(options, ['bindings']) && !hasExactKeys(options, ['bindings', 'testAddressCapability']))
    ) {
      throw resolverError('INVALID_CONFIGURATION');
    }
    const hasTestCapability = Object.hasOwn(options, 'testAddressCapability');
    if (hasTestCapability && !isProviderHttpTestAddressCapability(options.testAddressCapability)) {
      throw resolverError('INVALID_CONFIGURATION');
    }
    return normalizeBindings(options.bindings, hasTestCapability);
  } catch (error) {
    if (error instanceof ProviderTargetResolverError) throw error;
    throw resolverError('INVALID_CONFIGURATION');
  }
}

/**
 * Resolves only exact deployment bindings. It never concatenates request data
 * into a URL and performs no DNS lookup or network request.
 */
export class ProviderTargetResolver {
  private readonly snapshot: BindingSnapshot;
  readonly resolve: (input: ProviderTargetResolveInput) => ProviderTarget;

  constructor(options: ProviderTargetResolverOptions) {
    this.snapshot = normalizeOptions(options);
    this.resolve = this.resolveTarget.bind(this);
    Object.freeze(this);
  }

  private resolveTarget(input: ProviderTargetResolveInput): ProviderTarget {
    const key = normalizeKey(input, true);
    const binding = this.snapshot[bindingKey(key)];
    if (!binding) throw resolverError('BINDING_NOT_FOUND');
    return binding.target;
  }
}

export function createProviderTargetResolver(options: ProviderTargetResolverOptions): ProviderTargetResolver {
  return new ProviderTargetResolver(options);
}
