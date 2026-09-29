import { createHash } from 'node:crypto';
import { type Bridge, type Protocol, pickBridge } from '../../protocol/bridge.js';
import type { GatewayProtocol, ModelResolutionProvenance } from './contracts.js';
import type { PreparedRequestUsageEnvelope } from './prepared-request-evidence-service.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationAuthority,
  type RequestPreparationCaller,
  type RequestPreparationCompiledPayload,
  type RequestPreparationDecision,
  type RequestPreparationEntitlement,
  type RequestPreparationPayloadCompiler,
} from './request-preparation-service.js';

/** The version is part of the preparation contract, not provider metadata. */
export const PROVIDER_PAYLOAD_COMPILER_VERSION = 'provider-payload-compiler/v1';

/** Keep this aligned with the hosted transport's default request-size policy. */
export const DEFAULT_PROVIDER_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

const MAX_PROVIDER_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_MODEL_BYTES = 512;
const MAX_COMPILER_VERSION_BYTES = 128;
const MAX_ESTIMATOR_VERSION_BYTES = 128;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const SHA256 = /^[0-9a-f]{64}$/;

const PROTOCOLS = new Set<GatewayProtocol>(['anthropic', 'openai', 'gemini', 'responses']);
const INPUT_BUCKETS = new Set(['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']);

/** Canonical provider operations understood by this compiler. */
export type ProviderPayloadOperation = 'chat.completions' | 'messages' | 'responses' | 'generateContent';

/**
 * A server-owned route description. It contains no URL, credential, or caller
 * permission data. `operation` is the provider-side operation; the client-side
 * operation defaults to the fixed operation for its protocol.
 */
export interface ProviderPayloadCompilerRoute {
  readonly clientProtocol?: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly operation?: string;
  readonly providerOperation?: string;
  readonly clientOperation?: string;
}

export interface ProviderPayloadCompilerInput {
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly authority: RequestPreparationAuthority;
  readonly clientRequest: unknown;

  /** Optional server-injected per-request route extension. */
  readonly clientProtocol?: GatewayProtocol;
  readonly providerProtocol?: GatewayProtocol;
  readonly operation?: string;
  readonly providerOperation?: string;
  readonly clientOperation?: string;
  readonly modelResolution?: ModelResolutionProvenance;
}

export interface ProviderModelResolutionResolverInput {
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly providerId: string;
  readonly productId: string;
}

export type ProviderModelResolutionSource =
  | ModelResolutionProvenance
  | ((
      input: ProviderModelResolutionResolverInput,
    ) => ModelResolutionProvenance | null | Promise<ModelResolutionProvenance | null>);

export interface ProviderNormalizedRequest {
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: ProviderPayloadOperation;
  readonly providerOperation: ProviderPayloadOperation;
  readonly providerId: string;
  readonly productId: string;
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly resolvedModel: string;
  readonly modelResolution: ModelResolutionProvenance;
  /** The body has the provider-resolved model and contains no authority data. */
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ProviderUsageUpperBoundEstimatorInput {
  readonly normalizedRequest: ProviderNormalizedRequest;
  /** Compatibility alias for estimator implementations that use `request`. */
  readonly request: ProviderNormalizedRequest;
  readonly providerId: string;
  readonly productId: string;
  readonly providerModel: string;
  readonly estimatorVersion: string;
}

export type ProviderUsageUpperBoundEstimate =
  | PreparedRequestUsageEnvelope
  | {
      readonly usage?: PreparedRequestUsageEnvelope;
      readonly bounds?: PreparedRequestUsageEnvelope;
      readonly version?: string;
      readonly providerId?: string;
      readonly productId?: string;
      readonly model?: string;
    };

export interface ProviderUsageUpperBoundEstimator {
  /** A non-empty immutable algorithm/version identifier is mandatory. */
  readonly version: string;
  estimate(
    input: ProviderUsageUpperBoundEstimatorInput,
  ): ProviderUsageUpperBoundEstimate | Promise<ProviderUsageUpperBoundEstimate>;
}

/** Short aliases for composition code that names the estimator by role. */
export type ProviderUsageEstimator = ProviderUsageUpperBoundEstimator;
export type ProviderUsageEstimatorInput = ProviderUsageUpperBoundEstimatorInput;

export interface ProviderModelCompatibilityInput {
  readonly providerId: string;
  readonly productId: string;
  readonly providerModel: string;
  readonly providerProtocol: GatewayProtocol;
  readonly providerOperation: ProviderPayloadOperation;
  readonly modelResolution: ModelResolutionProvenance;
}

export type ProviderModelCompatibilityChecker = (input: ProviderModelCompatibilityInput) => boolean | Promise<boolean>;

export interface ProviderPayloadCompilerOptions {
  readonly route?: ProviderPayloadCompilerRoute;
  readonly clientProtocol?: GatewayProtocol;
  readonly providerProtocol?: GatewayProtocol;
  readonly operation?: string;
  readonly providerOperation?: string;
  readonly clientOperation?: string;

  /** Either spelling is accepted so the port can be wired without an adapter. */
  readonly estimator?: ProviderUsageUpperBoundEstimator;
  readonly usageEstimator?: ProviderUsageUpperBoundEstimator;
  readonly usageUpperBoundEstimator?: ProviderUsageUpperBoundEstimator;
  readonly maxPayloadBytes?: number;
  readonly compilerVersion?: string;

  /** Explicit server-owned provenance; no model mapping is recomputed here. */
  readonly modelResolution?: ProviderModelResolutionSource;
  readonly resolveModelResolution?: (
    input: ProviderModelResolutionResolverInput,
  ) => ModelResolutionProvenance | null | Promise<ModelResolutionProvenance | null>;

  /** Required catalog-backed compatibility assertion. */
  readonly modelCompatibility?: ProviderModelCompatibilityChecker;
  readonly isModelCompatible?: ProviderModelCompatibilityChecker;

  /**
   * Identity is safe only when requested == mapped == resolved. A mapped
   * model always requires explicit provenance from the authority or resolver.
   */
  readonly allowIdentityModelResolution?: boolean;
}

export interface ProviderCompiledPayload extends RequestPreparationCompiledPayload {
  readonly compilerVersion: string;
  readonly providerProtocol: GatewayProtocol;
  readonly providerOperation: ProviderPayloadOperation;
  readonly estimatorVersion: string;
  readonly modelResolution: ModelResolutionProvenance;
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly resolvedModel: string;
  /** Alias for the port's request fingerprint; both are the payload SHA-256. */
  readonly payloadSha256: string;
  readonly providerPayloadSha256: string;
  readonly fingerprint: string;
}

export type ProviderPayloadCompilerFailureCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_OPERATION'
  | 'MODEL_RESOLUTION_UNAVAILABLE'
  | 'MODEL_INCOMPATIBLE'
  | 'ESTIMATOR_UNAVAILABLE'
  | 'USAGE_BOUND_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'TRANSFORM_FAILED'
  | 'SERIALIZATION_FAILED';

const SAFE_FAILURE_MESSAGES: Readonly<Record<ProviderPayloadCompilerFailureCode, string>> = Object.freeze({
  INVALID_INPUT: 'Provider payload compiler input is invalid',
  UNSUPPORTED_OPERATION: 'Provider protocol operation is not supported',
  MODEL_RESOLUTION_UNAVAILABLE: 'Provider model resolution is unavailable',
  MODEL_INCOMPATIBLE: 'Provider model compatibility is unavailable',
  ESTIMATOR_UNAVAILABLE: 'Provider usage upper-bound estimator is unavailable',
  USAGE_BOUND_INVALID: 'Provider usage upper bounds are invalid',
  PAYLOAD_TOO_LARGE: 'Provider payload exceeds the configured size limit',
  TRANSFORM_FAILED: 'Provider request transformation failed',
  SERIALIZATION_FAILED: 'Provider payload serialization failed',
});

/** Errors deliberately contain only a stable code and safe message. */
export class ProviderPayloadCompilerError extends Error {
  constructor(readonly code: ProviderPayloadCompilerFailureCode) {
    super(SAFE_FAILURE_MESSAGES[code]);
    this.name = 'ProviderPayloadCompilerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface NormalizedRoute {
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: ProviderPayloadOperation;
  readonly providerOperation: ProviderPayloadOperation;
}

interface NormalizedCompilerOptions {
  readonly route: ProviderPayloadCompilerRoute | null;
  readonly clientProtocol?: GatewayProtocol;
  readonly providerProtocol?: GatewayProtocol;
  readonly operation?: string;
  readonly providerOperation?: string;
  readonly clientOperation?: string;
  readonly estimator: ProviderUsageUpperBoundEstimator | null;
  readonly maxPayloadBytes: number;
  readonly compilerVersion: string;
  readonly modelResolution: ProviderModelResolutionSource | null;
  readonly compatibility: ProviderModelCompatibilityChecker | null;
  readonly allowIdentityModelResolution: boolean;
}

interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface CompilerInputRecord extends Record<string, unknown> {
  readonly modelResolution?: ModelResolutionProvenance;
  readonly clientProtocol?: GatewayProtocol;
  readonly providerProtocol?: GatewayProtocol;
  readonly operation?: string;
  readonly providerOperation?: string;
  readonly clientOperation?: string;
}

const SUPPORTED_BRIDGE_PAIRS = new Set<string>([
  'anthropic->anthropic',
  'openai->openai',
  'gemini->gemini',
  'responses->responses',
  'anthropic->openai',
  'openai->anthropic',
  'anthropic->gemini',
  'anthropic->responses',
]);

const FORBIDDEN_TOP_LEVEL_FIELDS = new Set([
  'account',
  'accountId',
  'apiKey',
  'api_key',
  'authorization',
  'baseUrl',
  'credential',
  'credentialId',
  'credentials',
  'endpoint',
  'headers',
  'secret',
  'token',
  'url',
]);

function compilerFailure(code: ProviderPayloadCompilerFailureCode): never {
  throw new ProviderPayloadCompilerError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: ProviderPayloadCompilerFailureCode = 'INVALID_INPUT', maxBytes = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    compilerFailure(label);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) compilerFailure(label);
  return value;
}

function safeVersion(value: unknown, code: ProviderPayloadCompilerFailureCode, maxBytes: number): string {
  return text(value, code, maxBytes);
}

function exactNonNegative(value: unknown): bigint {
  let result: bigint;
  try {
    if (typeof value === 'bigint') result = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
    else if (typeof value === 'string' && /^\d+$/.test(value)) result = BigInt(value);
    else compilerFailure('USAGE_BOUND_INVALID');
  } catch {
    compilerFailure('USAGE_BOUND_INVALID');
  }
  if (result < 0n || result > MAX_BIGINT) compilerFailure('USAGE_BOUND_INVALID');
  return result;
}

function isProtocol(value: unknown): value is GatewayProtocol {
  return typeof value === 'string' && PROTOCOLS.has(value as GatewayProtocol);
}

function normalizeOperation(value: unknown): ProviderPayloadOperation {
  if (value === 'chat.completions' || value === 'chat/completions') return 'chat.completions';
  if (value === 'messages') return 'messages';
  if (value === 'responses') return 'responses';
  if (value === 'generateContent') return 'generateContent';
  compilerFailure('UNSUPPORTED_OPERATION');
}

function canonicalOperationForProtocol(protocol: GatewayProtocol): ProviderPayloadOperation {
  if (protocol === 'openai') return 'chat.completions';
  if (protocol === 'anthropic') return 'messages';
  if (protocol === 'responses') return 'responses';
  return 'generateContent';
}

function protocolOperationMatches(protocol: GatewayProtocol, operation: ProviderPayloadOperation): boolean {
  return canonicalOperationForProtocol(protocol) === operation;
}

function routeKey(clientProtocol: GatewayProtocol, providerProtocol: GatewayProtocol): string {
  return `${clientProtocol}->${providerProtocol}`;
}

function optionalRecordValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function getAuthorityExtension(authority: RequestPreparationAuthority): Record<string, unknown> {
  return authority as unknown as Record<string, unknown>;
}

function normalizeOptions(options: ProviderPayloadCompilerOptions): NormalizedCompilerOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) compilerFailure('INVALID_INPUT');
  const configured = options as ProviderPayloadCompilerOptions;
  const routeValue: unknown = configured.route ?? null;
  if (routeValue !== null && !isRecord(routeValue)) compilerFailure('INVALID_INPUT');
  const route = routeValue as ProviderPayloadCompilerRoute | null;

  const maxPayloadBytes = configured.maxPayloadBytes ?? DEFAULT_PROVIDER_PAYLOAD_MAX_BYTES;
  if (
    typeof maxPayloadBytes !== 'number' ||
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1 ||
    maxPayloadBytes > MAX_PROVIDER_PAYLOAD_BYTES
  ) {
    compilerFailure('INVALID_INPUT');
  }

  const compilerVersion = safeVersion(
    configured.compilerVersion ?? PROVIDER_PAYLOAD_COMPILER_VERSION,
    'INVALID_INPUT',
    MAX_COMPILER_VERSION_BYTES,
  );
  const estimatorValue: unknown =
    configured.estimator ?? configured.usageEstimator ?? configured.usageUpperBoundEstimator ?? null;
  if (estimatorValue !== null && !isObjectLike(estimatorValue)) compilerFailure('INVALID_INPUT');
  const estimator = estimatorValue as ProviderUsageUpperBoundEstimator | null;
  const modelResolutionValue: unknown = configured.resolveModelResolution ?? configured.modelResolution ?? null;
  if (modelResolutionValue !== null && typeof modelResolutionValue !== 'function' && !isRecord(modelResolutionValue)) {
    compilerFailure('INVALID_INPUT');
  }
  const modelResolution = modelResolutionValue as ProviderModelResolutionSource | null;
  const compatibilityValue: unknown = configured.modelCompatibility ?? configured.isModelCompatible ?? null;
  if (compatibilityValue !== null && typeof compatibilityValue !== 'function') compilerFailure('INVALID_INPUT');
  if (compatibilityValue === null) compilerFailure('MODEL_INCOMPATIBLE');
  const compatibility = compatibilityValue as ProviderModelCompatibilityChecker;
  if (
    configured.allowIdentityModelResolution !== undefined &&
    typeof configured.allowIdentityModelResolution !== 'boolean'
  ) {
    compilerFailure('INVALID_INPUT');
  }
  return {
    route,
    clientProtocol: configured.clientProtocol,
    providerProtocol: configured.providerProtocol,
    operation: configured.operation,
    providerOperation: configured.providerOperation,
    clientOperation: configured.clientOperation,
    estimator,
    maxPayloadBytes,
    compilerVersion,
    modelResolution,
    compatibility,
    allowIdentityModelResolution: configured.allowIdentityModelResolution ?? true,
  };
}

function extensionInput(input: ProviderPayloadCompilerInput): CompilerInputRecord {
  return input as unknown as CompilerInputRecord;
}

function normalizeRoute(input: ProviderPayloadCompilerInput, options: NormalizedCompilerOptions): NormalizedRoute {
  const authorityRecord = getAuthorityExtension(input.authority);
  const inputRecord = extensionInput(input);
  const route = options.route;
  const authorityRoute = input.authority?.route;
  // These branches intentionally keep route metadata server-owned; no value
  // is read from the JSON request body.
  const resolvedClientProtocol =
    route?.clientProtocol ?? options.clientProtocol ?? inputRecord.clientProtocol ?? authorityRoute?.protocol;
  const resolvedProviderProtocol =
    route?.providerProtocol ??
    options.providerProtocol ??
    inputRecord.providerProtocol ??
    optionalRecordValue(authorityRecord, ['providerProtocol', 'upstreamProtocol']) ??
    input.authority?.candidate?.protocol;
  const operation =
    route?.providerOperation ??
    route?.operation ??
    options.providerOperation ??
    options.operation ??
    inputRecord.providerOperation ??
    inputRecord.operation ??
    optionalRecordValue(authorityRecord, ['providerOperation', 'operation']);
  const clientOperation =
    route?.clientOperation ??
    options.clientOperation ??
    inputRecord.clientOperation ??
    optionalRecordValue(authorityRecord, ['clientOperation']);

  if (!isProtocol(resolvedClientProtocol) || !isProtocol(resolvedProviderProtocol)) compilerFailure('INVALID_INPUT');
  const normalizedProviderOperation = normalizeOperation(
    operation ?? canonicalOperationForProtocol(resolvedProviderProtocol),
  );
  const normalizedClientOperation = normalizeOperation(
    clientOperation ?? canonicalOperationForProtocol(resolvedClientProtocol),
  );
  if (
    !protocolOperationMatches(resolvedClientProtocol, normalizedClientOperation) ||
    !protocolOperationMatches(resolvedProviderProtocol, normalizedProviderOperation)
  ) {
    compilerFailure('UNSUPPORTED_OPERATION');
  }
  if (!SUPPORTED_BRIDGE_PAIRS.has(routeKey(resolvedClientProtocol, resolvedProviderProtocol))) {
    compilerFailure('UNSUPPORTED_OPERATION');
  }
  return {
    clientProtocol: resolvedClientProtocol,
    providerProtocol: resolvedProviderProtocol,
    clientOperation: normalizedClientOperation,
    providerOperation: normalizedProviderOperation,
  };
}

function asModelResolution(value: unknown): ModelResolutionProvenance | null {
  if (!isRecord(value)) return null;
  const requestedModel = value.requestedModel;
  const mappedModel = value.mappedModel;
  const resolvedModel = value.resolvedModel;
  const mappingSource = value.mappingSource;
  const mappingVersion = value.mappingVersion;
  if (
    typeof requestedModel !== 'string' ||
    typeof mappedModel !== 'string' ||
    typeof resolvedModel !== 'string' ||
    (mappingSource !== 'none' && mappingSource !== 'alias' && mappingSource !== 'wildcard')
  ) {
    return null;
  }
  if (
    mappingVersion !== null &&
    (typeof mappingVersion !== 'number' || !Number.isSafeInteger(mappingVersion) || mappingVersion < 1)
  ) {
    return null;
  }
  if (mappingSource === 'none' && mappingVersion !== null) return null;
  if (mappingSource !== 'none' && mappingVersion === null) return null;
  try {
    return {
      requestedModel: text(requestedModel, 'INVALID_INPUT', MAX_MODEL_BYTES),
      mappedModel: text(mappedModel, 'INVALID_INPUT', MAX_MODEL_BYTES),
      resolvedModel: text(resolvedModel, 'INVALID_INPUT', MAX_MODEL_BYTES),
      mappingSource,
      mappingVersion,
    };
  } catch {
    return null;
  }
}

async function resolveModelResolution(
  input: ProviderPayloadCompilerInput,
  options: NormalizedCompilerOptions,
  requestedModel: string,
  resolvedModel: string,
  providerId: string,
  productId: string,
): Promise<ModelResolutionProvenance> {
  const inputRecord = extensionInput(input);
  const authorityRecord = getAuthorityExtension(input.authority);
  let source: unknown = inputRecord.modelResolution;
  if (source === undefined)
    source = optionalRecordValue(authorityRecord, ['modelResolution', 'modelResolutionProvenance']);
  if (source === undefined) source = options.modelResolution;

  let provenance: ModelResolutionProvenance | null = null;
  if (typeof source === 'function') {
    try {
      provenance = asModelResolution(await source({ requestedModel, resolvedModel, providerId, productId }));
    } catch {
      compilerFailure('MODEL_RESOLUTION_UNAVAILABLE');
    }
  } else if (source !== undefined && source !== null) {
    provenance = asModelResolution(source);
  }

  if (provenance === null) {
    if (!options.allowIdentityModelResolution || requestedModel !== resolvedModel) {
      compilerFailure('MODEL_RESOLUTION_UNAVAILABLE');
    }
    provenance = {
      requestedModel,
      mappedModel: requestedModel,
      resolvedModel,
      mappingSource: 'none',
      mappingVersion: null,
    };
  }
  if (
    provenance.requestedModel !== requestedModel ||
    provenance.resolvedModel !== resolvedModel ||
    (provenance.mappingSource === 'none' && provenance.mappedModel !== requestedModel)
  ) {
    compilerFailure('MODEL_RESOLUTION_UNAVAILABLE');
  }
  return Object.freeze(provenance);
}

function assertJsonCompatible(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) compilerFailure('INVALID_INPUT');
    return;
  }
  if (typeof value === 'undefined') return;
  if (typeof value !== 'object') compilerFailure('INVALID_INPUT');
  if (seen.has(value)) compilerFailure('INVALID_INPUT');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined) compilerFailure('INVALID_INPUT');
      assertJsonCompatible(item, seen);
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (key.includes('\u0000')) compilerFailure('INVALID_INPUT');
      assertJsonCompatible(item, seen);
    }
  } else {
    compilerFailure('INVALID_INPUT');
  }
  seen.delete(value);
}

function validateMessages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) compilerFailure('INVALID_INPUT');
  for (const message of value) {
    if (!isRecord(message) || typeof message.role !== 'string' || message.role.trim() === '') {
      compilerFailure('INVALID_INPUT');
    }
    if (Object.hasOwn(message, 'content')) assertJsonCompatible(message.content);
  }
}

function validateClientBody(body: unknown, route: NormalizedRoute, publicModel: string): Record<string, unknown> {
  if (!isRecord(body)) compilerFailure('INVALID_INPUT');
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_TOP_LEVEL_FIELDS.has(key)) compilerFailure('INVALID_INPUT');
  }
  const model = text(body.model, 'INVALID_INPUT', MAX_MODEL_BYTES);
  if (model !== publicModel) compilerFailure('INVALID_INPUT');
  assertJsonCompatible(body);

  if (route.clientProtocol === 'responses') {
    if (!Object.hasOwn(body, 'input')) compilerFailure('INVALID_INPUT');
    assertJsonCompatible(body.input);
  } else if (route.clientProtocol === 'gemini') {
    validateMessages(body.contents);
  } else {
    validateMessages(body.messages);
  }
  return body;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) compilerFailure('SERIALIZATION_FAILED');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (value === undefined) compilerFailure('SERIALIZATION_FAILED');
  if (typeof value !== 'object' || seen.has(value)) compilerFailure('SERIALIZATION_FAILED');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
  } else if (isRecord(value)) {
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJson(item, seen)}`);
    }
    result = `{${entries.join(',')}}`;
  } else {
    compilerFailure('SERIALIZATION_FAILED');
  }
  seen.delete(value);
  return result;
}

function canonicalBytes(value: unknown): Uint8Array {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    if (error instanceof ProviderPayloadCompilerError) throw error;
    compilerFailure('SERIALIZATION_FAILED');
  }
  return new TextEncoder().encode(serialized);
}

function validateTransformedPayload(value: unknown, resolvedModel: string): Record<string, unknown> {
  if (!isRecord(value)) compilerFailure('TRANSFORM_FAILED');
  for (const key of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (Object.hasOwn(value, key)) compilerFailure('TRANSFORM_FAILED');
  }
  if (Object.hasOwn(value, 'model') && value.model !== resolvedModel) compilerFailure('MODEL_INCOMPATIBLE');
  assertJsonCompatible(value);
  return value;
}

function usageFromEstimate(
  value: unknown,
  estimatorVersion: string,
  providerId: string,
  productId: string,
  model: string,
): unknown {
  if (!isRecord(value)) return value;
  if (Object.hasOwn(value, 'version') && value.version !== estimatorVersion) compilerFailure('USAGE_BOUND_INVALID');
  for (const [key, expected] of [
    ['providerId', providerId],
    ['productId', productId],
    ['model', model],
  ] as const) {
    if (Object.hasOwn(value, key) && value[key] !== expected) compilerFailure('MODEL_INCOMPATIBLE');
  }
  if (Object.hasOwn(value, 'usage')) return value.usage;
  if (Object.hasOwn(value, 'bounds')) return value.bounds;
  return value;
}

function validateUsage(value: unknown): PreparedRequestUsageEnvelope {
  if (!isRecord(value)) compilerFailure('USAGE_BOUND_INVALID');
  const fields = [
    'inputTotalUpperBound',
    'inputUncachedUpperBound',
    'cacheReadUpperBound',
    'cacheWriteUpperBound',
    'cacheWrite5mUpperBound',
    'cacheWrite1hUpperBound',
    'outputTotalUpperBound',
    'reasoningOutputUpperBound',
  ] as const;
  const normalized = new Map<string, bigint>();
  for (const field of fields) normalized.set(field, exactNonNegative(value[field]));
  const inputTotal = normalized.get('inputTotalUpperBound');
  const outputTotal = normalized.get('outputTotalUpperBound');
  const inputUncached = normalized.get('inputUncachedUpperBound');
  const cacheRead = normalized.get('cacheReadUpperBound');
  const cacheWrite = normalized.get('cacheWriteUpperBound');
  const cacheWrite5m = normalized.get('cacheWrite5mUpperBound');
  const cacheWrite1h = normalized.get('cacheWrite1hUpperBound');
  const reasoningOutput = normalized.get('reasoningOutputUpperBound');
  if (
    inputTotal === undefined ||
    outputTotal === undefined ||
    inputUncached === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite5m === undefined ||
    cacheWrite1h === undefined ||
    reasoningOutput === undefined
  ) {
    compilerFailure('USAGE_BOUND_INVALID');
  }
  if (
    inputUncached > inputTotal ||
    cacheRead > inputTotal ||
    cacheWrite > inputTotal ||
    cacheWrite5m > inputTotal ||
    cacheWrite1h > inputTotal ||
    reasoningOutput > outputTotal
  ) {
    compilerFailure('USAGE_BOUND_INVALID');
  }
  const buckets = value.feasibleInputBuckets;
  if (
    !Array.isArray(buckets) ||
    buckets.length === 0 ||
    new Set(buckets).size !== buckets.length ||
    buckets.some((bucket) => typeof bucket !== 'string' || !INPUT_BUCKETS.has(bucket))
  ) {
    compilerFailure('USAGE_BOUND_INVALID');
  }
  const decimal = (bound: bigint | undefined): string => {
    if (bound === undefined) compilerFailure('USAGE_BOUND_INVALID');
    return bound.toString(10);
  };
  return {
    inputTotalUpperBound: decimal(inputTotal),
    inputUncachedUpperBound: decimal(inputUncached),
    cacheReadUpperBound: decimal(cacheRead),
    cacheWriteUpperBound: decimal(cacheWrite),
    cacheWrite5mUpperBound: decimal(cacheWrite5m),
    cacheWrite1hUpperBound: decimal(cacheWrite1h),
    outputTotalUpperBound: decimal(outputTotal),
    reasoningOutputUpperBound: decimal(reasoningOutput),
    feasibleInputBuckets: [...buckets] as readonly string[],
  };
}

async function estimateUsage(
  estimator: ProviderUsageUpperBoundEstimator | null,
  normalizedRequest: ProviderNormalizedRequest,
): Promise<{ readonly usage: PreparedRequestUsageEnvelope; readonly version: string }> {
  if (
    estimator === null ||
    !isObjectLike(estimator) ||
    typeof estimator.version !== 'string' ||
    estimator.version.length === 0 ||
    typeof estimator.estimate !== 'function'
  ) {
    compilerFailure('ESTIMATOR_UNAVAILABLE');
  }
  const version = safeVersion(estimator.version, 'ESTIMATOR_UNAVAILABLE', MAX_ESTIMATOR_VERSION_BYTES);
  let result: ProviderUsageUpperBoundEstimate;
  try {
    result = await estimator.estimate({
      normalizedRequest,
      request: normalizedRequest,
      providerId: normalizedRequest.providerId,
      productId: normalizedRequest.productId,
      providerModel: normalizedRequest.resolvedModel,
      estimatorVersion: version,
    });
  } catch {
    compilerFailure('ESTIMATOR_UNAVAILABLE');
  }
  const usage = validateUsage(
    usageFromEstimate(
      result,
      version,
      normalizedRequest.providerId,
      normalizedRequest.productId,
      normalizedRequest.resolvedModel,
    ),
  );
  return { usage, version };
}

function safeDecision(error: ProviderPayloadCompilerError): RequestPreparationDecision<ProviderCompiledPayload> {
  const payloadCode =
    error.code === 'ESTIMATOR_UNAVAILABLE' || error.code === 'USAGE_BOUND_INVALID'
      ? 'payload_bounds_unavailable'
      : error.code === 'UNSUPPORTED_OPERATION' || error.code === 'MODEL_INCOMPATIBLE'
        ? 'capability_unavailable'
        : 'payload_invalid';
  return blockRequestPreparation(payloadCode, error.message);
}

function bodyWithResolvedModel(body: Record<string, unknown>, resolvedModel: string): Record<string, unknown> {
  return { ...body, model: resolvedModel };
}

/**
 * Production request-body compiler. It deliberately implements only the
 * shared preparation port and never resolves a target URL or credential.
 */
export class ProviderPayloadCompiler implements RequestPreparationPayloadCompiler {
  private readonly options: NormalizedCompilerOptions | null;
  private readonly configurationError: ProviderPayloadCompilerError | null;

  constructor(options: ProviderPayloadCompilerOptions) {
    try {
      this.options = normalizeOptions(options);
      this.configurationError = null;
    } catch (error) {
      this.options = null;
      this.configurationError =
        error instanceof ProviderPayloadCompilerError ? error : new ProviderPayloadCompilerError('INVALID_INPUT');
    }
  }

  async compile(input: ProviderPayloadCompilerInput): Promise<RequestPreparationDecision<ProviderCompiledPayload>> {
    try {
      if (this.configurationError !== null || this.options === null) {
        throw this.configurationError ?? new ProviderPayloadCompilerError('INVALID_INPUT');
      }
      if (!isRecord(input) || !isRecord(input.authority) || !isRecord(input.authority.route)) {
        compilerFailure('INVALID_INPUT');
      }
      const authority = input.authority;
      const candidate = authority.candidate;
      if (!isRecord(candidate)) compilerFailure('INVALID_INPUT');
      const route = normalizeRoute(input, this.options);
      if (
        !isProtocol(authority.route.protocol) ||
        authority.route.protocol !== route.clientProtocol ||
        !isProtocol(candidate.protocol) ||
        candidate.protocol !== route.clientProtocol
      ) {
        compilerFailure('UNSUPPORTED_OPERATION');
      }
      const publicModel = text(authority.route.publicModel, 'INVALID_INPUT', MAX_MODEL_BYTES);
      const providerId = text(candidate.providerId, 'INVALID_INPUT');
      const productId = text(candidate.productId, 'INVALID_INPUT');
      const resolvedModel = text(candidate.resolvedModel, 'MODEL_RESOLUTION_UNAVAILABLE', MAX_MODEL_BYTES);
      const sourceBody = validateClientBody(input.clientRequest, route, publicModel);
      const requestedModel = text(sourceBody.model, 'INVALID_INPUT', MAX_MODEL_BYTES);
      const modelResolution = await resolveModelResolution(
        input,
        this.options,
        requestedModel,
        resolvedModel,
        providerId,
        productId,
      );

      const compatibility = this.options.compatibility;
      if (compatibility !== null) {
        let compatible = false;
        try {
          compatible = await compatibility({
            providerId,
            productId,
            providerModel: resolvedModel,
            providerProtocol: route.providerProtocol,
            providerOperation: route.providerOperation,
            modelResolution,
          });
        } catch {
          compilerFailure('MODEL_INCOMPATIBLE');
        }
        if (compatible !== true) compilerFailure('MODEL_INCOMPATIBLE');
      }

      const normalizedRequest: ProviderNormalizedRequest = Object.freeze({
        clientProtocol: route.clientProtocol,
        providerProtocol: route.providerProtocol,
        clientOperation: route.clientOperation,
        providerOperation: route.providerOperation,
        providerId,
        productId,
        requestedModel,
        mappedModel: modelResolution.mappedModel,
        resolvedModel,
        modelResolution,
        body: Object.freeze(bodyWithResolvedModel(sourceBody, resolvedModel)),
      });
      const inputBytes = canonicalBytes(normalizedRequest.body);
      if (inputBytes.byteLength > this.options.maxPayloadBytes) compilerFailure('PAYLOAD_TOO_LARGE');

      let bridge: Bridge;
      try {
        bridge = pickBridge(route.clientProtocol as Protocol, route.providerProtocol as Protocol);
      } catch {
        compilerFailure('UNSUPPORTED_OPERATION');
      }
      if (
        bridge.clientProto !== route.clientProtocol ||
        bridge.upstreamProto !== route.providerProtocol ||
        !SUPPORTED_BRIDGE_PAIRS.has(routeKey(bridge.clientProto, bridge.upstreamProto))
      ) {
        compilerFailure('UNSUPPORTED_OPERATION');
      }

      let transformed: unknown;
      try {
        transformed = bridge.transformRequest(normalizedRequest.body);
      } catch {
        compilerFailure('TRANSFORM_FAILED');
      }
      const providerBody = validateTransformedPayload(transformed, resolvedModel);
      const payloadBytes = canonicalBytes(providerBody);
      if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > this.options.maxPayloadBytes) {
        compilerFailure('PAYLOAD_TOO_LARGE');
      }

      const estimated = await estimateUsage(this.options.estimator, normalizedRequest);
      const requestFingerprint = createHash('sha256').update(payloadBytes).digest('hex');
      if (!SHA256.test(requestFingerprint)) compilerFailure('SERIALIZATION_FAILED');
      return allowRequestPreparation({
        payloadBytes: new Uint8Array(payloadBytes),
        requestFingerprint,
        requestFingerprintVersion: this.options.compilerVersion,
        usage: estimated.usage,
        compilerVersion: this.options.compilerVersion,
        providerProtocol: route.providerProtocol,
        providerOperation: route.providerOperation,
        estimatorVersion: estimated.version,
        modelResolution,
        requestedModel,
        mappedModel: modelResolution.mappedModel,
        resolvedModel,
        payloadSha256: requestFingerprint,
        providerPayloadSha256: requestFingerprint,
        fingerprint: requestFingerprint,
      });
    } catch (error) {
      if (error instanceof ProviderPayloadCompilerError) return safeDecision(error);
      return safeDecision(new ProviderPayloadCompilerError('INVALID_INPUT'));
    }
  }
}

export function createProviderPayloadCompiler(options: ProviderPayloadCompilerOptions): ProviderPayloadCompiler {
  return new ProviderPayloadCompiler(options);
}

export async function compileProviderPayload(
  input: ProviderPayloadCompilerInput,
  options: ProviderPayloadCompilerOptions,
): Promise<RequestPreparationDecision<ProviderCompiledPayload>> {
  return new ProviderPayloadCompiler(options).compile(input);
}

/** Alias for composition code that names the implementation by its role. */
export { ProviderPayloadCompiler as ProductionProviderPayloadCompiler };
