import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Version of the persisted provider-credential envelope format.
 *
 * This version is independent from {@link PROVIDER_CREDENTIAL_CONTEXT_VERSION}.
 */
export const PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Version of the canonical context that is bound to KMS and AES-GCM. */
export const PROVIDER_CREDENTIAL_CONTEXT_VERSION = 1 as const;

export const PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM = 'aes-256-gcm' as const;
export const PROVIDER_CREDENTIAL_DATA_KEY_BYTES = 32 as const;
export const PROVIDER_CREDENTIAL_NONCE_BYTES = 12 as const;
export const PROVIDER_CREDENTIAL_AUTH_TAG_BYTES = 16 as const;
export const MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES = 64 * 1024;

const MAX_CONTEXT_FIELD_BYTES = 256;
const MAX_KMS_KEY_ID_BYTES = 512;
const MAX_WRAPPED_DEK_BYTES = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ENCRYPTION_CONTEXT_DOMAIN = 'model-router/saas-provider-credential';
const DATA_KEY_SPEC = 'AES_256' as const;

type Awaitable<T> = T | PromiseLike<T>;

interface ProviderCredentialContextFields {
  readonly deployment: string;
  readonly environment: string;
  readonly purpose: string;
  readonly providerId: string;
  readonly productId: string;
  readonly credentialId: string;
  /** Positive, safe integer assigned by the credential owner. */
  readonly credentialVersion: number;
  readonly credentialType: string;
}

/** A tenant-owned credential supplied through tenant BYOK. */
export interface TenantByokProviderCredentialContext extends ProviderCredentialContextFields {
  readonly ownerKind: 'tenant';
  readonly tenantId: string;
  readonly supplyMode: 'byok';
}

/** A platform-owned credential supplied by the platform control plane. */
export interface PlatformSupplyProviderCredentialContext extends ProviderCredentialContextFields {
  readonly ownerKind: 'platform';
  readonly supplyMode: 'platform';
}

export type ProviderCredentialContext = TenantByokProviderCredentialContext | PlatformSupplyProviderCredentialContext;

/** Alias emphasizing that the platform variant intentionally has no tenant or user identity. */
export type PlatformProviderCredentialContext = PlatformSupplyProviderCredentialContext;

/** Alias for callers that use the shorter tenant variant name. */
export type TenantProviderCredentialContext = TenantByokProviderCredentialContext;

type ProviderCredentialContextBuilderFields = Omit<ProviderCredentialContextFields, 'credentialId'> & {
  /** Account identifier used only to qualify credentialId. */
  readonly accountId: string;
  /** Raw persisted credential identifier; the builder qualifies it for crypto context use. */
  readonly credentialId: string;
};

/** Input used to construct the owner-bound context shared by persistence and runtime consumers. */
export type ProviderCredentialContextBuilderInput =
  | (ProviderCredentialContextBuilderFields & {
      readonly ownerKind: 'tenant';
      readonly tenantId: string;
      readonly supplyMode: 'byok';
    })
  | (ProviderCredentialContextBuilderFields & {
      readonly ownerKind: 'platform';
      readonly supplyMode: 'platform';
    });

/**
 * The validated context map passed to KMS. Values are strings because that is
 * the common KMS encryption-context contract. Platform contexts omit tenantId
 * entirely; they never use a sentinel or fake tenant/user value.
 */
export type ProviderCredentialKmsEncryptionContext = Readonly<Record<string, string>>;

export interface GenerateProviderCredentialDataKeyRequest {
  readonly kmsKeyId: string;
  readonly keySpec: typeof DATA_KEY_SPEC;
  readonly encryptionContext: ProviderCredentialKmsEncryptionContext;
}

export interface DecryptProviderCredentialDataKeyRequest {
  readonly kmsKeyId: string;
  readonly ciphertextBlob: Uint8Array;
  readonly encryptionContext: ProviderCredentialKmsEncryptionContext;
}

export interface GeneratedProviderCredentialDataKey {
  /** Plaintext AES-256 DEK. The caller consumes and clears its own copy. */
  readonly plaintextKey: Uint8Array;
  /** KMS-wrapped DEK to persist in the provider credential envelope. */
  readonly ciphertextBlob: Uint8Array;
}

/** Minimal per-secret KMS adapter for envelope sealing. */
export interface ProviderCredentialSealingKms {
  generateDataKey(request: GenerateProviderCredentialDataKeyRequest): Awaitable<GeneratedProviderCredentialDataKey>;
}

/** Minimal per-secret KMS adapter for envelope unsealing. */
export interface ProviderCredentialUnsealingKms {
  decryptDataKey(request: DecryptProviderCredentialDataKeyRequest): Awaitable<Uint8Array>;
}

/**
 * Request for a remote KMS ReEncrypt operation. Only the already wrapped DEK
 * is supplied; the application never receives its plaintext during rewrap.
 */
export interface ReencryptProviderCredentialDataKeyRequest {
  readonly sourceKmsKeyId: string;
  readonly destinationKmsKeyId: string;
  readonly ciphertextBlob: Uint8Array;
  readonly sourceEncryptionContext: ProviderCredentialKmsEncryptionContext;
  readonly destinationEncryptionContext: ProviderCredentialKmsEncryptionContext;
}

export interface ReencryptedProviderCredentialDataKey {
  readonly sourceKmsKeyId: string;
  readonly destinationKmsKeyId: string;
  readonly ciphertextBlob: Uint8Array;
}

/** Rewrap-only KMS surface. It deliberately has no decrypt operation. */
export interface ProviderCredentialRewrappingKms {
  reencryptDataKey(request: ReencryptProviderCredentialDataKeyRequest): Awaitable<ReencryptedProviderCredentialDataKey>;
}

/**
 * Backward-compatible combined adapter for callers that perform both
 * sealing and unsealing in one workload.
 */
export interface ProviderCredentialKms extends ProviderCredentialSealingKms, ProviderCredentialUnsealingKms {}

export interface ProviderCredentialEnvelope {
  readonly schemaVersion: typeof PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION;
  readonly contextVersion: typeof PROVIDER_CREDENTIAL_CONTEXT_VERSION;
  readonly algorithm: typeof PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM;
  readonly kmsKeyId: string;
  readonly wrappedDek: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export type ProviderCredentialCryptoErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CONTEXT'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_VERSION'
  | 'KMS_UNAVAILABLE'
  | 'INVALID_DATA_KEY'
  | 'SEAL_FAILED'
  | 'UNSEAL_FAILED'
  | 'REWRAP_FAILED'
  | 'CALLBACK_FAILED';

const ERROR_MESSAGES: Record<ProviderCredentialCryptoErrorCode, string> = {
  INVALID_INPUT: 'Provider credential crypto input is invalid',
  INVALID_CONTEXT: 'Provider credential context is invalid',
  INVALID_ENVELOPE: 'Provider credential envelope is invalid',
  UNSUPPORTED_VERSION: 'Provider credential envelope or context version is unsupported',
  KMS_UNAVAILABLE: 'Provider credential KMS is unavailable',
  INVALID_DATA_KEY: 'Provider credential data key is invalid',
  SEAL_FAILED: 'Provider credential sealing failed',
  UNSEAL_FAILED: 'Provider credential unsealing failed',
  REWRAP_FAILED: 'Provider credential rewrap failed',
  CALLBACK_FAILED: 'Provider credential callback failed',
};

export class ProviderCredentialCryptoError extends Error {
  constructor(readonly code: ProviderCredentialCryptoErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ProviderCredentialCryptoError';
  }
}

interface ParsedProviderCredentialEnvelope {
  readonly kmsKeyId: string;
  readonly wrappedDek: Buffer;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

interface CanonicalProviderCredentialContext {
  readonly kmsEncryptionContext: ProviderCredentialKmsEncryptionContext;
  readonly aad: Buffer;
}

const COMMON_CONTEXT_KEYS = [
  'deployment',
  'environment',
  'ownerKind',
  'purpose',
  'providerId',
  'productId',
  'credentialId',
  'credentialVersion',
  'credentialType',
  'supplyMode',
] as const;
const TENANT_CONTEXT_KEYS = [...COMMON_CONTEXT_KEYS, 'tenantId'] as const;
const PLATFORM_CONTEXT_KEYS = COMMON_CONTEXT_KEYS;
const ENVELOPE_KEYS = [
  'schemaVersion',
  'contextVersion',
  'algorithm',
  'kmsKeyId',
  'wrappedDek',
  'nonce',
  'ciphertext',
  'authTag',
] as const;

function cryptoError(code: ProviderCredentialCryptoErrorCode): ProviderCredentialCryptoError {
  return new ProviderCredentialCryptoError(code);
}

function qualifiedCredentialContextId(input: ProviderCredentialContextBuilderInput): string {
  const owner = input.ownerKind === 'tenant' ? `tenant${input.tenantId.length}:${input.tenantId}` : 'platform';
  const qualified = `owner${owner.length}:${owner}|account${input.accountId.length}:${input.accountId}|credential${input.credentialId.length}:${input.credentialId}`;
  if (Buffer.byteLength(qualified, 'utf8') <= MAX_CONTEXT_FIELD_BYTES) return qualified;

  const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
  return `owner${input.ownerKind.length}:${input.ownerKind}|account-sha256:${digest(input.accountId)}|credential-sha256:${digest(input.credentialId)}`;
}

/**
 * Build the credential context used by persistence, the validation worker, and
 * the gateway. The qualified ID format intentionally preserves its historic
 * UTF-16 length prefixes and UTF-8 byte threshold for envelope compatibility.
 */
export function createProviderCredentialContext(
  input: ProviderCredentialContextBuilderInput,
): ProviderCredentialContext {
  const credentialId = qualifiedCredentialContextId(input);
  const common = {
    deployment: input.deployment,
    environment: input.environment,
    purpose: input.purpose,
    providerId: input.providerId,
    productId: input.productId,
    credentialId,
    credentialVersion: input.credentialVersion,
    credentialType: input.credentialType,
  } as const;

  if (input.ownerKind === 'tenant') {
    return {
      ...common,
      ownerKind: 'tenant',
      tenantId: input.tenantId,
      supplyMode: 'byok',
    };
  }
  return { ...common, ownerKind: 'platform', supplyMode: 'platform' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validateText(value: unknown, maxBytes: number, errorCode: ProviderCredentialCryptoErrorCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) throw cryptoError(errorCode);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw cryptoError(errorCode);
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length === 0 || value.includes('\u0000') || encoded.toString('utf8') !== value) {
    encoded.fill(0);
    throw cryptoError(errorCode);
  }
  encoded.fill(0);
  return value;
}

function validateCredentialVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw cryptoError('INVALID_CONTEXT');
  }
  return value;
}

function normalizeContext(value: unknown): ProviderCredentialContext {
  try {
    if (!isRecord(value)) throw cryptoError('INVALID_CONTEXT');

    const ownerKind = value.ownerKind;
    if (ownerKind === 'tenant') {
      if (!hasExactKeys(value, TENANT_CONTEXT_KEYS) || value.supplyMode !== 'byok') {
        throw cryptoError('INVALID_CONTEXT');
      }
      return Object.freeze({
        deployment: validateText(value.deployment, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        environment: validateText(value.environment, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        ownerKind: 'tenant',
        tenantId: validateText(value.tenantId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        purpose: validateText(value.purpose, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        providerId: validateText(value.providerId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        productId: validateText(value.productId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        credentialId: validateText(value.credentialId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        credentialVersion: validateCredentialVersion(value.credentialVersion),
        credentialType: validateText(value.credentialType, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        supplyMode: 'byok',
      });
    }

    if (ownerKind === 'platform') {
      if (!hasExactKeys(value, PLATFORM_CONTEXT_KEYS) || value.supplyMode !== 'platform') {
        throw cryptoError('INVALID_CONTEXT');
      }
      return Object.freeze({
        deployment: validateText(value.deployment, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        environment: validateText(value.environment, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        ownerKind: 'platform',
        purpose: validateText(value.purpose, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        providerId: validateText(value.providerId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        productId: validateText(value.productId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        credentialId: validateText(value.credentialId, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        credentialVersion: validateCredentialVersion(value.credentialVersion),
        credentialType: validateText(value.credentialType, MAX_CONTEXT_FIELD_BYTES, 'INVALID_CONTEXT'),
        supplyMode: 'platform',
      });
    }

    throw cryptoError('INVALID_CONTEXT');
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('INVALID_CONTEXT');
  }
}

function createCanonicalContext(context: ProviderCredentialContext): CanonicalProviderCredentialContext {
  const entries: Array<readonly [string, string]> = [
    ['domain', ENCRYPTION_CONTEXT_DOMAIN],
    ['contextVersion', String(PROVIDER_CREDENTIAL_CONTEXT_VERSION)],
    ['deployment', context.deployment],
    ['environment', context.environment],
    ['ownerKind', context.ownerKind],
  ];
  if (context.ownerKind === 'tenant') entries.push(['tenantId', context.tenantId]);
  entries.push(
    ['purpose', context.purpose],
    ['providerId', context.providerId],
    ['productId', context.productId],
    ['credentialId', context.credentialId],
    ['credentialVersion', String(context.credentialVersion)],
    ['credentialType', context.credentialType],
    ['supplyMode', context.supplyMode],
  );

  const kmsEncryptionContext: Record<string, string> = {};
  for (const [key, value] of entries) kmsEncryptionContext[key] = value;

  return {
    kmsEncryptionContext: Object.freeze(kmsEncryptionContext),
    aad: Buffer.from(JSON.stringify(entries), 'utf8'),
  };
}

/** Return the validated, deterministic KMS context for inspection or adapter use. */
export function createProviderCredentialEncryptionContext(
  context: ProviderCredentialContext,
): ProviderCredentialKmsEncryptionContext {
  return createCanonicalContext(normalizeContext(context)).kmsEncryptionContext;
}

function validateSealingKmsProvider(value: unknown): asserts value is ProviderCredentialSealingKms {
  try {
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null ||
      typeof (value as ProviderCredentialSealingKms).generateDataKey !== 'function'
    ) {
      throw cryptoError('KMS_UNAVAILABLE');
    }
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('KMS_UNAVAILABLE');
  }
}

function validateUnsealingKmsProvider(value: unknown): asserts value is ProviderCredentialUnsealingKms {
  try {
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null ||
      typeof (value as ProviderCredentialUnsealingKms).decryptDataKey !== 'function'
    ) {
      throw cryptoError('KMS_UNAVAILABLE');
    }
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('KMS_UNAVAILABLE');
  }
}

function validateKmsKeyId(value: unknown, errorCode: ProviderCredentialCryptoErrorCode): string {
  return validateText(value, MAX_KMS_KEY_ID_BYTES, errorCode);
}

function copyBytes(
  value: unknown,
  expectedBytes: number | undefined,
  maxBytes: number,
  errorCode: ProviderCredentialCryptoErrorCode,
): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maxBytes) {
    throw cryptoError(errorCode);
  }
  const copy = Buffer.from(value);
  if (expectedBytes !== undefined && copy.length !== expectedBytes) {
    copy.fill(0);
    throw cryptoError(errorCode);
  }
  return copy;
}

function copySecret(value: unknown): Buffer {
  return copyBytes(value, undefined, MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES, 'INVALID_INPUT');
}

function decodeBase64Url(value: unknown, maxBytes: number): Buffer {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxEncodedLength ||
    value.length % 4 === 1 ||
    !BASE64URL.test(value)
  ) {
    throw cryptoError('INVALID_ENVELOPE');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64url') !== value) {
    decoded.fill(0);
    throw cryptoError('INVALID_ENVELOPE');
  }
  return decoded;
}

function parseEnvelope(value: unknown): ParsedProviderCredentialEnvelope {
  let wrappedDek: Buffer | undefined;
  let nonce: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let authTag: Buffer | undefined;
  try {
    if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) throw cryptoError('INVALID_ENVELOPE');
    if (
      value.schemaVersion !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      value.contextVersion !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      value.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      throw cryptoError('UNSUPPORTED_VERSION');
    }
    const kmsKeyId = validateKmsKeyId(value.kmsKeyId, 'INVALID_ENVELOPE');
    wrappedDek = decodeBase64Url(value.wrappedDek, MAX_WRAPPED_DEK_BYTES);
    nonce = decodeBase64Url(value.nonce, PROVIDER_CREDENTIAL_NONCE_BYTES);
    ciphertext = decodeBase64Url(value.ciphertext, MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES);
    authTag = decodeBase64Url(value.authTag, PROVIDER_CREDENTIAL_AUTH_TAG_BYTES);
    if (nonce.length !== PROVIDER_CREDENTIAL_NONCE_BYTES || authTag.length !== PROVIDER_CREDENTIAL_AUTH_TAG_BYTES) {
      throw cryptoError('INVALID_ENVELOPE');
    }
    return { kmsKeyId, wrappedDek, nonce, ciphertext, authTag };
  } catch (error) {
    wrappedDek?.fill(0);
    nonce?.fill(0);
    ciphertext?.fill(0);
    authTag?.fill(0);
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('INVALID_ENVELOPE');
  }
}

function parseGeneratedDataKey(value: unknown): { plaintextKey: Buffer; ciphertextBlob: Buffer } {
  let plaintextKey: Buffer | undefined;
  let ciphertextBlob: Buffer | undefined;
  try {
    if (!value || typeof value !== 'object') throw cryptoError('INVALID_DATA_KEY');
    const candidate = value as Record<string, unknown>;
    plaintextKey = copyBytes(
      candidate.plaintextKey,
      PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
      PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
      'INVALID_DATA_KEY',
    );
    ciphertextBlob = copyBytes(candidate.ciphertextBlob, undefined, MAX_WRAPPED_DEK_BYTES, 'INVALID_DATA_KEY');
    return { plaintextKey, ciphertextBlob };
  } catch (error) {
    plaintextKey?.fill(0);
    ciphertextBlob?.fill(0);
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('INVALID_DATA_KEY');
  }
}

function encryptWithDataKey(
  plaintext: Buffer,
  dataKey: Buffer,
  aad: Buffer,
): Pick<ProviderCredentialEnvelope, 'nonce' | 'ciphertext' | 'authTag'> {
  const nonce = randomBytes(PROVIDER_CREDENTIAL_NONCE_BYTES);
  let updateOutput: Buffer | undefined;
  let finalOutput: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let authTag: Buffer | undefined;
  try {
    const cipher = createCipheriv(PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM, dataKey, nonce, {
      authTagLength: PROVIDER_CREDENTIAL_AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad);
    updateOutput = cipher.update(plaintext);
    finalOutput = cipher.final();
    ciphertext = Buffer.concat([updateOutput, finalOutput]);
    authTag = cipher.getAuthTag();
    return {
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: authTag.toString('base64url'),
    };
  } catch {
    throw cryptoError('SEAL_FAILED');
  } finally {
    updateOutput?.fill(0);
    finalOutput?.fill(0);
    ciphertext?.fill(0);
    authTag?.fill(0);
    nonce.fill(0);
  }
}

function decryptWithDataKey(parsed: ParsedProviderCredentialEnvelope, dataKey: Buffer, aad: Buffer): Buffer {
  let updateOutput: Buffer | undefined;
  let finalOutput: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM, dataKey, parsed.nonce, {
      authTagLength: PROVIDER_CREDENTIAL_AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(parsed.authTag);
    updateOutput = decipher.update(parsed.ciphertext);
    finalOutput = decipher.final();
    plaintext = Buffer.concat([updateOutput, finalOutput]);
    if (plaintext.length === 0 || plaintext.length > MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES) {
      throw cryptoError('UNSEAL_FAILED');
    }
    updateOutput.fill(0);
    finalOutput.fill(0);
    updateOutput = undefined;
    finalOutput = undefined;
    const result = plaintext;
    plaintext = undefined;
    return result;
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError && error.code === 'UNSEAL_FAILED') throw error;
    throw cryptoError('UNSEAL_FAILED');
  } finally {
    updateOutput?.fill(0);
    finalOutput?.fill(0);
    plaintext?.fill(0);
  }
}

async function decryptDataKey(
  kms: ProviderCredentialUnsealingKms,
  parsed: ParsedProviderCredentialEnvelope,
  encryptionContext: ProviderCredentialKmsEncryptionContext,
): Promise<Buffer> {
  let wrappedDek: Buffer | undefined;
  let dataKey: Buffer | undefined;
  try {
    wrappedDek = Buffer.from(parsed.wrappedDek);
    let plaintextKey: Uint8Array;
    try {
      plaintextKey = await kms.decryptDataKey({
        kmsKeyId: parsed.kmsKeyId,
        ciphertextBlob: wrappedDek,
        encryptionContext,
      });
    } catch {
      throw cryptoError('UNSEAL_FAILED');
    }
    dataKey = copyBytes(
      plaintextKey,
      PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
      PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
      'INVALID_DATA_KEY',
    );
    const result = dataKey;
    dataKey = undefined;
    return result;
  } catch (error) {
    dataKey?.fill(0);
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('UNSEAL_FAILED');
  } finally {
    wrappedDek?.fill(0);
  }
}

export async function sealProviderCredential(
  secret: Uint8Array,
  context: ProviderCredentialContext,
  kms: ProviderCredentialSealingKms,
  kmsKeyId: string,
): Promise<ProviderCredentialEnvelope> {
  let secretBytes: Buffer | undefined;
  let dataKey: Buffer | undefined;
  let wrappedDek: Buffer | undefined;
  let canonical: CanonicalProviderCredentialContext | undefined;
  try {
    secretBytes = copySecret(secret);
    const normalizedContext = normalizeContext(context);
    const normalizedKmsKeyId = validateKmsKeyId(kmsKeyId, 'INVALID_INPUT');
    validateSealingKmsProvider(kms);
    canonical = createCanonicalContext(normalizedContext);

    let generated: GeneratedProviderCredentialDataKey;
    try {
      generated = await kms.generateDataKey({
        kmsKeyId: normalizedKmsKeyId,
        keySpec: DATA_KEY_SPEC,
        encryptionContext: canonical.kmsEncryptionContext,
      });
    } catch {
      throw cryptoError('SEAL_FAILED');
    }
    const parsedGenerated = parseGeneratedDataKey(generated);
    dataKey = parsedGenerated.plaintextKey;
    wrappedDek = parsedGenerated.ciphertextBlob;
    const encrypted = encryptWithDataKey(secretBytes, dataKey, canonical.aad);
    return {
      schemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
      contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
      algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
      kmsKeyId: normalizedKmsKeyId,
      wrappedDek: wrappedDek.toString('base64url'),
      ...encrypted,
    };
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('SEAL_FAILED');
  } finally {
    secretBytes?.fill(0);
    dataKey?.fill(0);
    wrappedDek?.fill(0);
    canonical?.aad.fill(0);
  }
}

/**
 * Ask the remote KMS to re-encrypt only the wrapped DEK. The canonical context
 * is passed unchanged as both source and destination context to preserve the
 * persisted envelope AAD/KMS contract byte for byte. Secret ciphertext, nonce,
 * and authentication tag are copied unchanged into the returned envelope.
 */
export async function rewrapProviderCredentialEnvelope(
  envelope: ProviderCredentialEnvelope,
  context: ProviderCredentialContext,
  destinationKmsKeyId: string,
  kms: ProviderCredentialRewrappingKms,
): Promise<ProviderCredentialEnvelope> {
  let parsed: ParsedProviderCredentialEnvelope | undefined;
  let destinationWrappedDek: Buffer | undefined;
  let sourceWrappedDekForKms: Buffer | undefined;
  let canonical: CanonicalProviderCredentialContext | undefined;
  try {
    const normalizedContext = normalizeContext(context);
    parsed = parseEnvelope(envelope);
    const normalizedDestination = validateKmsKeyId(destinationKmsKeyId, 'INVALID_INPUT');
    if (normalizedDestination === parsed.kmsKeyId) throw cryptoError('INVALID_INPUT');
    if (
      (typeof kms !== 'object' && typeof kms !== 'function') ||
      kms === null ||
      typeof kms.reencryptDataKey !== 'function'
    ) {
      throw cryptoError('KMS_UNAVAILABLE');
    }
    canonical = createCanonicalContext(normalizedContext);
    sourceWrappedDekForKms = Buffer.from(parsed.wrappedDek);

    let result: ReencryptedProviderCredentialDataKey;
    try {
      result = await kms.reencryptDataKey({
        sourceKmsKeyId: parsed.kmsKeyId,
        destinationKmsKeyId: normalizedDestination,
        ciphertextBlob: sourceWrappedDekForKms,
        sourceEncryptionContext: canonical.kmsEncryptionContext,
        destinationEncryptionContext: canonical.kmsEncryptionContext,
      });
    } catch {
      throw cryptoError('REWRAP_FAILED');
    }
    if (
      !result ||
      typeof result !== 'object' ||
      result.sourceKmsKeyId !== parsed.kmsKeyId ||
      result.destinationKmsKeyId !== normalizedDestination
    ) {
      throw cryptoError('REWRAP_FAILED');
    }
    destinationWrappedDek = copyBytes(result.ciphertextBlob, undefined, MAX_WRAPPED_DEK_BYTES, 'REWRAP_FAILED');
    return {
      schemaVersion: PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
      contextVersion: PROVIDER_CREDENTIAL_CONTEXT_VERSION,
      algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
      kmsKeyId: normalizedDestination,
      wrappedDek: destinationWrappedDek.toString('base64url'),
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      authTag: envelope.authTag,
    };
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('REWRAP_FAILED');
  } finally {
    parsed?.wrappedDek.fill(0);
    parsed?.nonce.fill(0);
    parsed?.ciphertext.fill(0);
    parsed?.authTag.fill(0);
    sourceWrappedDekForKms?.fill(0);
    destinationWrappedDek?.fill(0);
    canonical?.aad.fill(0);
  }
}

export async function withUnsealedProviderCredential<T>(
  envelope: ProviderCredentialEnvelope,
  context: ProviderCredentialContext,
  kms: ProviderCredentialUnsealingKms,
  callback: (secret: Buffer) => Awaitable<T>,
): Promise<T> {
  let parsed: ParsedProviderCredentialEnvelope | undefined;
  let dataKey: Buffer | undefined;
  let secret: Buffer | undefined;
  let canonical: CanonicalProviderCredentialContext | undefined;
  try {
    if (typeof callback !== 'function') throw cryptoError('INVALID_INPUT');
    const normalizedContext = normalizeContext(context);
    parsed = parseEnvelope(envelope);
    validateUnsealingKmsProvider(kms);
    canonical = createCanonicalContext(normalizedContext);
    dataKey = await decryptDataKey(kms, parsed, canonical.kmsEncryptionContext);
    secret = decryptWithDataKey(parsed, dataKey, canonical.aad);
    try {
      return await callback(secret);
    } catch {
      throw cryptoError('CALLBACK_FAILED');
    }
  } catch (error) {
    if (error instanceof ProviderCredentialCryptoError) throw error;
    throw cryptoError('UNSEAL_FAILED');
  } finally {
    secret?.fill(0);
    dataKey?.fill(0);
    canonical?.aad.fill(0);
    parsed?.wrappedDek.fill(0);
    parsed?.nonce.fill(0);
    parsed?.ciphertext.fill(0);
    parsed?.authTag.fill(0);
  }
}

/** Alias with an explicit unseal verb for callers that prefer it. */
export const unsealProviderCredential = withUnsealedProviderCredential;
