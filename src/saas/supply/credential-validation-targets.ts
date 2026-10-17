import { createHash } from 'node:crypto';
import type { ApprovedCredentialValidationTarget, ProviderCredentialValidationJobRecord } from './types.js';

declare const approvedTargetsBrand: unique symbol;
export interface ApprovedCredentialValidationTargets {
  readonly [approvedTargetsBrand]: true;
}

const registries = new WeakMap<object, ReadonlyMap<string, Readonly<ApprovedCredentialValidationTarget>>>();
const approvedBindings = new WeakSet<object>();
const MAX_TARGETS = 1_024;
const HASH = /^[0-9a-f]{64}$/;
const BINDING_KEYS = [
  'providerId',
  'productId',
  'credentialType',
  'model',
  'endpoint',
  'capabilityVersion',
  'protocol',
  'authProfile',
  'baseUrl',
  'approvalReference',
  'expiresAt',
  'evidenceSha256',
] as const;
const CANONICAL_BINDING_KEYS = [...BINDING_KEYS, 'schemaVersion', 'wirePath', 'wireProtocol'] as const;

export class CredentialValidationTargetError extends Error {
  readonly code = 'VALIDATION_TARGET_INVALID' as const;
  constructor() {
    super('Credential validation target approval is invalid or unavailable');
    this.name = 'CredentialValidationTargetError';
  }
}

function invalid(): never {
  throw new CredentialValidationTargetError();
}
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

/** Slash is a model identifier character, never a URL interpolation permission. */
export function isCustomCredentialValidationModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) && !value.includes('://');
}

export function canonicalCredentialValidationBaseUrl(value: unknown): URL {
  if (!text(value, 2_048)) invalid();
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.href !== value ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      url.hostname.endsWith('.') ||
      !url.pathname.endsWith('/') ||
      (url.port !== '' && Number(url.port) < 1) ||
      !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(url.pathname)
    )
      invalid();
    return url;
  } catch {
    invalid();
  }
}

type TargetSnapshot = Readonly<Partial<Record<(typeof CANONICAL_BINDING_KEYS)[number], unknown>>>;

/** Copy one own-data observation; do not pretend to detect Proxy or freeze caller memory. */
function captureTarget(
  input: object,
  schema: PropertyDescriptor | undefined,
  requireEvidence: boolean,
): TargetSnapshot {
  try {
    const fields = Reflect.ownKeys(input);
    const known = schema === undefined ? BINDING_KEYS : CANONICAL_BINDING_KEYS;
    const required = requireEvidence ? known : known.filter((field) => field !== 'evidenceSha256');
    if (Array.isArray(input) || required.some((field) => !fields.includes(field))) invalid();
    if (schema !== undefined) {
      const prototype = Object.getPrototypeOf(input);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        fields.length > known.length ||
        fields.some((field) => typeof field !== 'string' || !known.some((key) => key === field))
      )
        invalid();
    } else {
      // Legacy Object.keys semantics ignore symbols/non-enumerable extras,
      // including an ESM namespace's Symbol.toStringTag. None enters authority.
      for (const field of fields) {
        if (typeof field === 'symbol' || known.some((key) => key === field)) continue;
        const descriptor = field === 'schemaVersion' ? schema : Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor || descriptor.enumerable) invalid();
      }
    }
    const copied: Partial<Record<(typeof CANONICAL_BINDING_KEYS)[number], unknown>> = Object.create(null);
    for (const field of known) {
      if (!fields.includes(field)) continue; // only optional evidence in the digest-construction API
      const descriptor = field === 'schemaVersion' ? schema : Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || (schema !== undefined && !descriptor.enumerable) || !Object.hasOwn(descriptor, 'value'))
        invalid();
      const value: unknown = descriptor.value;
      if (typeof value !== 'string' && typeof value !== 'number' && value !== null) invalid();
      copied[field] = value;
    }
    return Object.freeze(copied);
  } catch {
    invalid();
  }
}

function validatedCanonicalDescriptor(input: TargetSnapshot) {
  if (
    input.schemaVersion !== 2 ||
    input.providerId !== 'custom' ||
    input.credentialType !== 'api-key' ||
    !isCustomCredentialValidationModel(input.model) ||
    typeof input.capabilityVersion !== 'number' ||
    !Number.isSafeInteger(input.capabilityVersion) ||
    input.capabilityVersion < 1 ||
    !text(input.approvalReference, 256)
  )
    invalid();
  const chat =
    input.productId === 'custom-openai' &&
    input.endpoint === '/v1/chat/completions' &&
    input.protocol === 'openai' &&
    input.wirePath === 'chat/completions' &&
    input.wireProtocol === 'openai' &&
    input.authProfile === 'openai-bearer-v1';
  const messages =
    input.productId === 'custom-anthropic' &&
    input.endpoint === '/v1/messages' &&
    input.protocol === 'anthropic' &&
    input.wirePath === 'messages' &&
    input.wireProtocol === 'anthropic' &&
    input.authProfile === 'anthropic-api-key-2023-06-01';
  if (!chat && !messages) invalid();
  const baseUrl = canonicalCredentialValidationBaseUrl(input.baseUrl).href;
  if (
    input.expiresAt !== null &&
    (typeof input.expiresAt !== 'string' ||
      input.expiresAt.length !== 24 ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      new Date(input.expiresAt).toISOString() !== input.expiresAt)
  )
    invalid();
  return {
    schema: 'model-router-credential-validation-target-v2',
    schemaVersion: 2,
    purpose: 'credential-validation',
    providerId: input.providerId,
    productId: chat ? 'custom-openai' : 'custom-anthropic',
    credentialType: input.credentialType,
    model: input.model,
    endpoint: chat ? '/v1/chat/completions' : '/v1/messages',
    capabilityVersion: input.capabilityVersion,
    protocol: chat ? 'openai' : 'anthropic',
    wirePath: chat ? 'chat/completions' : 'messages',
    wireProtocol: chat ? 'openai' : 'anthropic',
    authProfile: chat ? 'openai-bearer-v1' : 'anthropic-api-key-2023-06-01',
    baseUrl,
    requestUrl: new URL(chat ? 'chat/completions' : 'messages', baseUrl).href,
    approvalReference: input.approvalReference,
    expiresAt: input.expiresAt,
  } as const;
}

/** Type only captured primitive fields; the original legacy validator below still owns semantics. */
function legacyInput(snapshot: TargetSnapshot): Readonly<Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>> {
  if (
    snapshot.providerId !== 'custom' ||
    snapshot.credentialType !== 'api-key' ||
    (snapshot.productId !== 'custom-openai' && snapshot.productId !== 'custom-anthropic') ||
    typeof snapshot.model !== 'string' ||
    typeof snapshot.capabilityVersion !== 'number' ||
    (snapshot.endpoint !== 'chat-completions' && snapshot.endpoint !== 'messages') ||
    (snapshot.protocol !== 'openai-compatible' && snapshot.protocol !== 'anthropic-compatible') ||
    (snapshot.authProfile !== 'openai-bearer-v1' && snapshot.authProfile !== 'anthropic-api-key-2023-06-01') ||
    typeof snapshot.baseUrl !== 'string' ||
    typeof snapshot.approvalReference !== 'string' ||
    (snapshot.expiresAt !== null && typeof snapshot.expiresAt !== 'string')
  )
    invalid();
  return Object.freeze({
    providerId: snapshot.providerId,
    productId: snapshot.productId,
    credentialType: snapshot.credentialType,
    model: snapshot.model,
    endpoint: snapshot.endpoint,
    capabilityVersion: snapshot.capabilityVersion,
    protocol: snapshot.protocol,
    authProfile: snapshot.authProfile,
    baseUrl: snapshot.baseUrl,
    approvalReference: snapshot.approvalReference,
    expiresAt: snapshot.expiresAt,
  });
}

function validatedLegacyDescriptor(input: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !BINDING_KEYS.includes(key as (typeof BINDING_KEYS)[number])) ||
    input.providerId !== 'custom' ||
    input.credentialType !== 'api-key' ||
    !isCustomCredentialValidationModel(input.model) ||
    !Number.isSafeInteger(input.capabilityVersion) ||
    input.capabilityVersion < 1 ||
    !text(input.approvalReference, 256)
  )
    invalid();
  const chat =
    input.productId === 'custom-openai' &&
    input.endpoint === 'chat-completions' &&
    input.protocol === 'openai-compatible' &&
    input.authProfile === 'openai-bearer-v1';
  const messages =
    input.productId === 'custom-anthropic' &&
    input.endpoint === 'messages' &&
    input.protocol === 'anthropic-compatible' &&
    input.authProfile === 'anthropic-api-key-2023-06-01';
  if (!chat && !messages) invalid();
  const baseUrl = canonicalCredentialValidationBaseUrl(input.baseUrl).href;
  if (
    input.expiresAt !== null &&
    (typeof input.expiresAt !== 'string' ||
      input.expiresAt.length !== 24 ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      new Date(input.expiresAt).toISOString() !== input.expiresAt)
  )
    invalid();
  // Fixed ordering and a domain/schema discriminator make this the actual
  // binding evidence, not an arbitrary documentation hash or an approval flag.
  return {
    schema: 'model-router-credential-validation-target-v1',
    providerId: input.providerId,
    productId: input.productId,
    credentialType: input.credentialType,
    model: input.model,
    endpoint: input.endpoint,
    capabilityVersion: input.capabilityVersion,
    protocol: input.protocol,
    authProfile: input.authProfile,
    baseUrl,
    requestUrl: new URL(chat ? 'chat/completions' : 'messages', baseUrl).href,
    approvalReference: input.approvalReference,
    expiresAt: input.expiresAt,
  } as const;
}

function validatedInput(input: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>, requireEvidence = false) {
  let schema: PropertyDescriptor | undefined;
  try {
    schema = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'schemaVersion') : undefined;
  } catch {
    invalid();
  }
  if (!input || typeof input !== 'object') invalid();
  const snapshot = captureTarget(input, schema, requireEvidence);
  if (schema !== undefined) {
    return {
      kind: 'canonical' as const,
      descriptor: validatedCanonicalDescriptor(snapshot),
      evidenceSha256: snapshot.evidenceSha256,
    };
  }
  return {
    kind: 'legacy' as const,
    descriptor: validatedLegacyDescriptor(legacyInput(snapshot)),
    evidenceSha256: snapshot.evidenceSha256,
  };
}

/** An operator must review this evidence and register its digest independently in the catalog. */
export function credentialValidationTargetEvidenceSha256(
  input: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(validatedInput(input).descriptor))
    .digest('hex');
}

function key(providerId: string, productId: string, model: string, endpoint: string, version: number): string {
  return JSON.stringify([providerId, productId, model, endpoint, version]);
}

export function compileApprovedCredentialValidationTargets(
  inputs: readonly ApprovedCredentialValidationTarget[] = [],
): ApprovedCredentialValidationTargets {
  if (!Array.isArray(inputs) || inputs.length > MAX_TARGETS) invalid();
  const entries = new Map<string, Readonly<ApprovedCredentialValidationTarget>>();
  for (const input of inputs) {
    const checked = validatedInput(input, true);
    const descriptor = checked.descriptor;
    const evidence = checked.evidenceSha256;
    // BOTH schemas hash and bind one validated owned observation, never caller metadata again.
    if (
      typeof evidence !== 'string' ||
      !HASH.test(evidence) ||
      createHash('sha256').update(JSON.stringify(descriptor)).digest('hex') !== evidence
    )
      invalid();
    const entryKey = key(
      descriptor.providerId,
      descriptor.productId,
      descriptor.model,
      descriptor.endpoint,
      descriptor.capabilityVersion,
    );
    if (entries.has(entryKey)) invalid();
    let binding: Readonly<ApprovedCredentialValidationTarget>;
    if (checked.kind === 'canonical') {
      const canonical = checked.descriptor;
      binding = Object.freeze({
        schemaVersion: 2,
        providerId: canonical.providerId,
        productId: canonical.productId,
        credentialType: canonical.credentialType,
        model: canonical.model,
        endpoint: canonical.endpoint,
        capabilityVersion: canonical.capabilityVersion,
        protocol: canonical.protocol,
        wirePath: canonical.wirePath,
        wireProtocol: canonical.wireProtocol,
        authProfile: canonical.authProfile,
        baseUrl: canonical.baseUrl,
        approvalReference: canonical.approvalReference,
        expiresAt: canonical.expiresAt,
        evidenceSha256: evidence,
      });
    } else {
      const legacy = checked.descriptor;
      binding = Object.freeze({
        providerId: legacy.providerId,
        productId: legacy.productId,
        credentialType: legacy.credentialType,
        model: legacy.model,
        endpoint: legacy.endpoint,
        capabilityVersion: legacy.capabilityVersion,
        protocol: legacy.protocol,
        authProfile: legacy.authProfile,
        baseUrl: legacy.baseUrl,
        approvalReference: legacy.approvalReference,
        expiresAt: legacy.expiresAt,
        evidenceSha256: evidence,
      });
    }
    entries.set(entryKey, binding);
    approvedBindings.add(binding);
  }
  // Freezing a Map does not freeze its entries; the actual Map is never exposed.
  const registry = Object.freeze(Object.create(null)) as ApprovedCredentialValidationTargets;
  registries.set(registry, entries);
  return registry;
}

export function isApprovedCredentialValidationTargets(value: unknown): value is ApprovedCredentialValidationTargets {
  return typeof value === 'object' && value !== null && registries.has(value);
}

export function isApprovedCredentialValidationBinding(
  value: unknown,
): value is Readonly<ApprovedCredentialValidationTarget> {
  return typeof value === 'object' && value !== null && approvedBindings.has(value);
}

export function resolveApprovedCredentialValidationTarget(
  registry: ApprovedCredentialValidationTargets,
  job: ProviderCredentialValidationJobRecord,
  now = Date.now(),
): Readonly<ApprovedCredentialValidationTarget> | null {
  if (!isApprovedCredentialValidationTargets(registry)) invalid();
  if (
    !job.target ||
    Object.keys(job.target).some((field) => !['model', 'endpoint', 'version'].includes(field)) ||
    !isCustomCredentialValidationModel(job.target.model) ||
    !Array.isArray(job.allowedModels) ||
    !job.allowedModels.includes(job.target.model) ||
    !Number.isSafeInteger(job.target.version) ||
    job.target.version < 1 ||
    job.credentialType !== 'api-key'
  )
    return null;
  const binding = registries
    .get(registry)
    ?.get(key(job.providerId, job.productId, job.target.model, job.target.endpoint, job.target.version));
  return binding && (binding.expiresAt === null || Date.parse(binding.expiresAt) > now) ? binding : null;
}

export function credentialValidationTargetRequestUrl(binding: Readonly<ApprovedCredentialValidationTarget>): URL {
  if (!isApprovedCredentialValidationBinding(binding)) invalid();
  if (binding.schemaVersion === 2) {
    const profile = credentialValidationTargetProbeProfile(binding);
    return new URL(profile.kind === 'chat' ? 'chat/completions' : 'messages', binding.baseUrl);
  }
  return new URL(binding.endpoint === 'chat-completions' ? 'chat/completions' : 'messages', binding.baseUrl);
}

/** Only compiler-branded bindings select a fixed wire implementation; never ProviderProfile fallback. */
export function credentialValidationTargetProbeProfile(
  binding: Readonly<ApprovedCredentialValidationTarget>,
): Readonly<{
  adapterId: 'custom-openai-chat-v1' | 'custom-anthropic-messages-v1';
  kind: 'chat' | 'messages';
}> {
  if (!isApprovedCredentialValidationBinding(binding)) invalid();
  if (binding.schemaVersion === 2) {
    if (
      binding.productId === 'custom-openai' &&
      binding.endpoint === '/v1/chat/completions' &&
      binding.protocol === 'openai' &&
      binding.wirePath === 'chat/completions' &&
      binding.wireProtocol === 'openai' &&
      binding.authProfile === 'openai-bearer-v1'
    ) {
      return Object.freeze({ adapterId: 'custom-openai-chat-v1', kind: 'chat' });
    }
    if (
      binding.productId === 'custom-anthropic' &&
      binding.endpoint === '/v1/messages' &&
      binding.protocol === 'anthropic' &&
      binding.wirePath === 'messages' &&
      binding.wireProtocol === 'anthropic' &&
      binding.authProfile === 'anthropic-api-key-2023-06-01'
    ) {
      return Object.freeze({ adapterId: 'custom-anthropic-messages-v1', kind: 'messages' });
    }
    invalid();
  }
  return Object.freeze({
    adapterId: binding.productId === 'custom-openai' ? 'custom-openai-chat-v1' : 'custom-anthropic-messages-v1',
    kind: binding.endpoint === 'messages' ? 'messages' : 'chat',
  });
}

/**
 * Hash only immutable authority, not mutable status/lease/retry timestamps.
 * This is the 061 tenant-queue requeue binding: its SQL writer recomputes the
 * identical digest, and that channel never carries platform jobs (the requeue
 * preparation below refuses them), so the owner dimension is constant here.
 */
export function credentialValidationJobSnapshotSha256(job: ProviderCredentialValidationJobRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'model-router-credential-validation-job-v1',
        job.id,
        job.tenantId,
        job.accountId,
        job.credentialId,
        job.credentialVersion,
        job.providerId,
        job.productId,
        job.credentialType,
        job.allowedModels,
        job.target.model,
        job.target.endpoint,
        job.target.version,
        job.idempotencyKey,
        job.createdAt,
      ]),
    )
    .digest('hex');
}
