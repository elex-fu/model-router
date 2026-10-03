import { createHash } from 'node:crypto';
import type {
  ApprovedCredentialValidationTarget,
  ProviderCredentialValidationJobRecord,
} from './types.js';

declare const approvedTargetsBrand: unique symbol;
export interface ApprovedCredentialValidationTargets {
  readonly [approvedTargetsBrand]: true;
}

const registries = new WeakMap<object, ReadonlyMap<string, Readonly<ApprovedCredentialValidationTarget>>>();
const approvedBindings = new WeakSet<object>();
const MAX_TARGETS = 1_024;
const HASH = /^[0-9a-f]{64}$/;
const BINDING_KEYS = [
  'providerId', 'productId', 'credentialType', 'model', 'endpoint', 'capabilityVersion',
  'protocol', 'authProfile', 'baseUrl', 'approvalReference', 'expiresAt', 'evidenceSha256',
] as const;

export class CredentialValidationTargetError extends Error {
  readonly code = 'VALIDATION_TARGET_INVALID' as const;
  constructor() {
    super('Credential validation target approval is invalid or unavailable');
    this.name = 'CredentialValidationTargetError';
  }
}

function invalid(): never { throw new CredentialValidationTargetError(); }
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    /^[\x21-\x7e]+$/.test(value);
}

/** Slash is a model identifier character, never a URL interpolation permission. */
export function isCustomCredentialValidationModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) &&
    !value.includes('://');
}

export function canonicalCredentialValidationBaseUrl(value: unknown): URL {
  if (!text(value, 2_048)) invalid();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.href !== value || url.username || url.password || url.search || url.hash ||
      !url.hostname || url.hostname.endsWith('.') || !url.pathname.endsWith('/') ||
      (url.port !== '' && Number(url.port) < 1) ||
      !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(url.pathname)) invalid();
    return url;
  } catch { invalid(); }
}

function validatedDescriptor(input: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !BINDING_KEYS.includes(key as typeof BINDING_KEYS[number])) ||
    input.providerId !== 'custom' || input.credentialType !== 'api-key' ||
    !isCustomCredentialValidationModel(input.model) ||
    !Number.isSafeInteger(input.capabilityVersion) || input.capabilityVersion < 1 ||
    !text(input.approvalReference, 256)) invalid();
  const chat = input.productId === 'custom-openai' && input.endpoint === 'chat-completions' &&
    input.protocol === 'openai-compatible' && input.authProfile === 'openai-bearer-v1';
  const messages = input.productId === 'custom-anthropic' && input.endpoint === 'messages' &&
    input.protocol === 'anthropic-compatible' && input.authProfile === 'anthropic-api-key-2023-06-01';
  if (!chat && !messages) invalid();
  const baseUrl = canonicalCredentialValidationBaseUrl(input.baseUrl).href;
  if (input.expiresAt !== null && (typeof input.expiresAt !== 'string' || input.expiresAt.length !== 24 ||
    !Number.isFinite(Date.parse(input.expiresAt)) || new Date(input.expiresAt).toISOString() !== input.expiresAt)) invalid();
  // Fixed ordering and a domain/schema discriminator make this the actual
  // binding evidence, not an arbitrary documentation hash or an approval flag.
  return {
    schema: 'model-router-credential-validation-target-v1',
    providerId: input.providerId, productId: input.productId, credentialType: input.credentialType,
    model: input.model, endpoint: input.endpoint, capabilityVersion: input.capabilityVersion,
    protocol: input.protocol, authProfile: input.authProfile, baseUrl,
    requestUrl: new URL(chat ? 'chat/completions' : 'messages', baseUrl).href,
    approvalReference: input.approvalReference, expiresAt: input.expiresAt,
  } as const;
}

/** An operator must review this evidence and register its digest independently in the catalog. */
export function credentialValidationTargetEvidenceSha256(
  input: Omit<ApprovedCredentialValidationTarget, 'evidenceSha256'>,
): string {
  return createHash('sha256').update(JSON.stringify(validatedDescriptor(input))).digest('hex');
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
    const descriptor = validatedDescriptor(input);
    if (!HASH.test(input.evidenceSha256) || credentialValidationTargetEvidenceSha256(input) !== input.evidenceSha256) invalid();
    const entryKey = key(input.providerId, input.productId, input.model, input.endpoint, input.capabilityVersion);
    if (entries.has(entryKey)) invalid();
    const binding = Object.freeze({
      providerId: input.providerId, productId: input.productId, credentialType: input.credentialType,
      model: input.model, endpoint: input.endpoint, capabilityVersion: input.capabilityVersion,
      protocol: input.protocol, authProfile: input.authProfile, baseUrl: descriptor.baseUrl,
      approvalReference: input.approvalReference, expiresAt: input.expiresAt, evidenceSha256: input.evidenceSha256,
    });
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

export function isApprovedCredentialValidationBinding(value: unknown): value is Readonly<ApprovedCredentialValidationTarget> {
  return typeof value === 'object' && value !== null && approvedBindings.has(value);
}

export function resolveApprovedCredentialValidationTarget(
  registry: ApprovedCredentialValidationTargets,
  job: ProviderCredentialValidationJobRecord,
  now = Date.now(),
): Readonly<ApprovedCredentialValidationTarget> | null {
  if (!isApprovedCredentialValidationTargets(registry)) invalid();
  if (!job.target || Object.keys(job.target).some((field) => !['model', 'endpoint', 'version'].includes(field)) ||
    !isCustomCredentialValidationModel(job.target.model) || !Array.isArray(job.allowedModels) ||
    !job.allowedModels.includes(job.target.model) || !Number.isSafeInteger(job.target.version) ||
    job.target.version < 1 || job.credentialType !== 'api-key') return null;
  const binding = registries.get(registry)?.get(key(job.providerId, job.productId, job.target.model,
    job.target.endpoint, job.target.version));
  return binding && (binding.expiresAt === null || Date.parse(binding.expiresAt) > now) ? binding : null;
}

export function credentialValidationTargetRequestUrl(binding: Readonly<ApprovedCredentialValidationTarget>): URL {
  if (!isApprovedCredentialValidationBinding(binding)) invalid();
  return new URL(binding.endpoint === 'chat-completions' ? 'chat/completions' : 'messages', binding.baseUrl);
}

/** Hash only immutable authority, not mutable status/lease/retry timestamps. */
export function credentialValidationJobSnapshotSha256(job: ProviderCredentialValidationJobRecord): string {
  return createHash('sha256').update(JSON.stringify([
    'model-router-credential-validation-job-v1', job.id, job.tenantId, job.accountId, job.credentialId,
    job.credentialVersion, job.providerId, job.productId, job.credentialType, job.allowedModels,
    job.target.model, job.target.endpoint, job.target.version, job.idempotencyKey, job.createdAt,
  ])).digest('hex');
}
