import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope crypto building block for SaaS BYOK credentials.
 *
 * This module is not a KMS provider, static secret injection mechanism,
 * persistence layer, or credential CRUD service. Callers own those concerns
 * and inject a provider that can resolve the active and historical keys.
 */

export const CREDENTIAL_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_ENVELOPE_ALGORITHM = 'aes-256-gcm' as const;
export const CREDENTIAL_KEY_BYTES = 32;
export const CREDENTIAL_NONCE_BYTES = 12;
export const CREDENTIAL_AUTH_TAG_BYTES = 16;
export const MAX_CREDENTIAL_PLAINTEXT_BYTES = 64 * 1024;

const MAX_CONTEXT_FIELD_BYTES = 256;
const MAX_KEY_ID_BYTES = 128;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const AAD_DOMAIN = 'model-router/saas-byok-credential/v1';

type Awaitable<T> = T | PromiseLike<T>;

export interface TenantCredentialContext {
  readonly tenantId: string;
  readonly provider: string;
  readonly credentialId: string;
}

export interface UserCredentialContext {
  readonly userId: string;
  readonly provider: string;
  readonly credentialId: string;
}

export type CredentialContext = TenantCredentialContext | UserCredentialContext;

export interface CredentialKeyMaterial {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface CredentialKeyProvider {
  /** Resolve the key that new envelopes must use. */
  getCurrentKey(): Awaitable<CredentialKeyMaterial>;
  /** Resolve a previously active key by its envelope key ID. */
  getKey(keyId: string): Awaitable<Uint8Array | CredentialKeyMaterial | undefined>;
}

export interface CredentialEnvelope {
  readonly schemaVersion: typeof CREDENTIAL_ENVELOPE_SCHEMA_VERSION;
  readonly algorithm: typeof CREDENTIAL_ENVELOPE_ALGORITHM;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export type CredentialCryptoErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_ENVELOPE'
  | 'KEY_PROVIDER_UNAVAILABLE'
  | 'KEY_UNAVAILABLE'
  | 'INVALID_KEY'
  | 'AUTHENTICATION_FAILED'
  | 'ENCRYPTION_FAILED';

const ERROR_MESSAGES: Record<CredentialCryptoErrorCode, string> = {
  INVALID_INPUT: 'Credential crypto input is invalid',
  INVALID_ENVELOPE: 'Credential envelope is invalid',
  UNSUPPORTED_ENVELOPE: 'Credential envelope is unsupported',
  KEY_PROVIDER_UNAVAILABLE: 'Credential key provider is unavailable',
  KEY_UNAVAILABLE: 'Credential key is unavailable',
  INVALID_KEY: 'Credential key is invalid',
  AUTHENTICATION_FAILED: 'Credential authentication failed',
  ENCRYPTION_FAILED: 'Credential encryption failed',
};

export class CredentialCryptoError extends Error {
  constructor(readonly code: CredentialCryptoErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CredentialCryptoError';
  }
}

interface ParsedEnvelope {
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

function cryptoError(code: CredentialCryptoErrorCode): CredentialCryptoError {
  return new CredentialCryptoError(code);
}

function validateContext(context: unknown): CredentialContext {
  if (!context || typeof context !== 'object') throw cryptoError('INVALID_INPUT');
  const candidate = context as Record<string, unknown>;
  const hasTenantId = typeof candidate.tenantId === 'string';
  const hasUserId = typeof candidate.userId === 'string';
  if (hasTenantId === hasUserId) throw cryptoError('INVALID_INPUT');
  for (const value of [
    hasTenantId ? candidate.tenantId : candidate.userId,
    candidate.provider,
    candidate.credentialId,
  ]) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_CONTEXT_FIELD_BYTES)
      throw cryptoError('INVALID_INPUT');
  }
  if (hasUserId) {
    return {
      userId: candidate.userId as string,
      provider: candidate.provider as string,
      credentialId: candidate.credentialId as string,
    };
  }
  return {
    tenantId: candidate.tenantId as string,
    provider: candidate.provider as string,
    credentialId: candidate.credentialId as string,
  };
}

function validateKeyId(value: unknown, errorCode: 'INVALID_ENVELOPE' | 'INVALID_KEY'): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_KEY_ID_BYTES)
    throw cryptoError(errorCode);
  return value;
}

function validateKeyProvider(provider: unknown): asserts provider is CredentialKeyProvider {
  if (!provider || typeof provider !== 'object') throw cryptoError('KEY_PROVIDER_UNAVAILABLE');
  try {
    const candidate = provider as Record<string, unknown>;
    if (typeof candidate.getCurrentKey !== 'function' || typeof candidate.getKey !== 'function')
      throw cryptoError('KEY_PROVIDER_UNAVAILABLE');
  } catch (error) {
    if (error instanceof CredentialCryptoError) throw error;
    throw cryptoError('KEY_PROVIDER_UNAVAILABLE');
  }
}

function copyKey(rawKey: unknown): Buffer {
  if (!(rawKey instanceof Uint8Array) || rawKey.byteLength !== CREDENTIAL_KEY_BYTES) throw cryptoError('INVALID_KEY');
  return Buffer.from(rawKey);
}

function copyCurrentKey(material: unknown): { keyId: string; key: Buffer } {
  try {
    if (!material || typeof material !== 'object') throw cryptoError('KEY_UNAVAILABLE');
    const candidate = material as Record<string, unknown>;
    const keyId = validateKeyId(candidate.keyId, 'INVALID_KEY');
    return { keyId, key: copyKey(candidate.key) };
  } catch (error) {
    if (error instanceof CredentialCryptoError) throw error;
    throw cryptoError('INVALID_KEY');
  }
}

async function resolveCurrentKey(provider: unknown): Promise<{ keyId: string; key: Buffer }> {
  validateKeyProvider(provider);
  let material: unknown;
  try {
    material = await provider.getCurrentKey();
  } catch {
    throw cryptoError('KEY_UNAVAILABLE');
  }
  return copyCurrentKey(material);
}

async function resolveHistoricalKey(provider: unknown, keyId: string): Promise<Buffer> {
  validateKeyProvider(provider);
  let material: unknown;
  try {
    material = await provider.getKey(keyId);
  } catch {
    throw cryptoError('KEY_UNAVAILABLE');
  }
  if (material === undefined || material === null) throw cryptoError('KEY_UNAVAILABLE');

  if (material instanceof Uint8Array) return copyKey(material);
  try {
    if (typeof material !== 'object') throw cryptoError('INVALID_KEY');
    const candidate = material as Record<string, unknown>;
    if (candidate.keyId !== keyId) throw cryptoError('KEY_UNAVAILABLE');
    return copyKey(candidate.key);
  } catch (error) {
    if (error instanceof CredentialCryptoError) throw error;
    throw cryptoError('INVALID_KEY');
  }
}

function plaintextBuffer(plaintext: unknown): Buffer {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw cryptoError('INVALID_INPUT');
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_CREDENTIAL_PLAINTEXT_BYTES) throw cryptoError('INVALID_INPUT');
  const bytes = Buffer.from(plaintext, 'utf8');
  if (bytes.length === 0) {
    bytes.fill(0);
    throw cryptoError('INVALID_INPUT');
  }
  return bytes;
}

function aadBuffer(context: CredentialContext): Buffer {
  // JSON array encoding is deterministic and prevents delimiter ambiguity.
  if ('userId' in context) {
    return Buffer.from(
      JSON.stringify(['model-router/saas-user-credential/v1', context.userId, context.provider, context.credentialId]),
      'utf8',
    );
  }
  return Buffer.from(JSON.stringify([AAD_DOMAIN, context.tenantId, context.provider, context.credentialId]), 'utf8');
}

function decodeBase64Url(value: unknown, maxBytes: number, errorCode: 'INVALID_ENVELOPE'): Buffer {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxEncodedLength ||
    !BASE64URL.test(value) ||
    value.length % 4 === 1
  )
    throw cryptoError(errorCode);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64url') !== value) {
    decoded.fill(0);
    throw cryptoError(errorCode);
  }
  return decoded;
}

function parseEnvelope(envelope: unknown): ParsedEnvelope {
  if (!envelope || typeof envelope !== 'object') throw cryptoError('INVALID_ENVELOPE');
  const candidate = envelope as Record<string, unknown>;
  if (
    candidate.schemaVersion !== CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
    candidate.algorithm !== CREDENTIAL_ENVELOPE_ALGORITHM
  )
    throw cryptoError('UNSUPPORTED_ENVELOPE');

  const keyId = validateKeyId(candidate.keyId, 'INVALID_ENVELOPE');
  let nonce: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let authTag: Buffer | undefined;
  try {
    nonce = decodeBase64Url(candidate.nonce, CREDENTIAL_NONCE_BYTES, 'INVALID_ENVELOPE');
    ciphertext = decodeBase64Url(candidate.ciphertext, MAX_CREDENTIAL_PLAINTEXT_BYTES, 'INVALID_ENVELOPE');
    authTag = decodeBase64Url(candidate.authTag, CREDENTIAL_AUTH_TAG_BYTES, 'INVALID_ENVELOPE');
    if (nonce.length !== CREDENTIAL_NONCE_BYTES || authTag.length !== CREDENTIAL_AUTH_TAG_BYTES) {
      throw cryptoError('INVALID_ENVELOPE');
    }
    return { keyId, nonce, ciphertext, authTag };
  } catch (error) {
    nonce?.fill(0);
    ciphertext?.fill(0);
    authTag?.fill(0);
    if (error instanceof CredentialCryptoError) throw error;
    throw cryptoError('INVALID_ENVELOPE');
  }
}

function encryptBuffer(plaintext: Buffer, context: CredentialContext, keyId: string, key: Buffer): CredentialEnvelope {
  const nonce = randomBytes(CREDENTIAL_NONCE_BYTES);
  const aad = aadBuffer(context);
  let updateOutput: Buffer | undefined;
  let finalOutput: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let authTag: Buffer | undefined;
  try {
    const cipher = createCipheriv(CREDENTIAL_ENVELOPE_ALGORITHM, key, nonce, {
      authTagLength: CREDENTIAL_AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad);
    updateOutput = cipher.update(plaintext);
    finalOutput = cipher.final();
    ciphertext = Buffer.concat([updateOutput, finalOutput]);
    authTag = cipher.getAuthTag();
    return {
      schemaVersion: CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
      algorithm: CREDENTIAL_ENVELOPE_ALGORITHM,
      keyId,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: authTag.toString('base64url'),
    };
  } catch {
    throw cryptoError('ENCRYPTION_FAILED');
  } finally {
    updateOutput?.fill(0);
    finalOutput?.fill(0);
    ciphertext?.fill(0);
    authTag?.fill(0);
    nonce.fill(0);
    aad.fill(0);
  }
}

function decryptBuffer(parsed: ParsedEnvelope, context: CredentialContext, key: Buffer): Buffer {
  const aad = aadBuffer(context);
  let updateOutput: Buffer | undefined;
  let finalOutput: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CREDENTIAL_ENVELOPE_ALGORITHM, key, parsed.nonce, {
      authTagLength: CREDENTIAL_AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(parsed.authTag);
    updateOutput = decipher.update(parsed.ciphertext);
    finalOutput = decipher.final();
    const plaintext = Buffer.concat([updateOutput, finalOutput]);
    updateOutput.fill(0);
    finalOutput.fill(0);
    updateOutput = undefined;
    finalOutput = undefined;
    return plaintext;
  } catch {
    throw cryptoError('AUTHENTICATION_FAILED');
  } finally {
    updateOutput?.fill(0);
    finalOutput?.fill(0);
    aad.fill(0);
  }
}

async function decryptToBuffer(envelope: unknown, context: unknown, provider: unknown): Promise<Buffer> {
  const normalizedContext = validateContext(context);
  const parsed = parseEnvelope(envelope);
  try {
    let key: Buffer;
    try {
      key = await resolveHistoricalKey(provider, parsed.keyId);
    } catch (error) {
      // Providers may expose the active key only through getCurrentKey and
      // retain only retired keys in the historical lookup.
      if (!(error instanceof CredentialCryptoError) || error.code !== 'KEY_UNAVAILABLE') throw error;
      const currentKey = await resolveCurrentKey(provider);
      if (currentKey.keyId !== parsed.keyId) {
        currentKey.key.fill(0);
        throw cryptoError('KEY_UNAVAILABLE');
      }
      key = currentKey.key;
    }
    try {
      return decryptBuffer(parsed, normalizedContext, key);
    } finally {
      key.fill(0);
    }
  } finally {
    parsed.nonce.fill(0);
    parsed.ciphertext.fill(0);
    parsed.authTag.fill(0);
  }
}

export async function encryptCredential(
  plaintext: string,
  context: CredentialContext,
  keyProvider: CredentialKeyProvider,
): Promise<CredentialEnvelope> {
  const normalizedContext = validateContext(context);
  const plaintextBytes = plaintextBuffer(plaintext);
  try {
    const currentKey = await resolveCurrentKey(keyProvider);
    try {
      return encryptBuffer(plaintextBytes, normalizedContext, currentKey.keyId, currentKey.key);
    } finally {
      currentKey.key.fill(0);
    }
  } finally {
    plaintextBytes.fill(0);
  }
}

export async function decryptCredential(
  envelope: CredentialEnvelope,
  context: CredentialContext,
  keyProvider: CredentialKeyProvider,
): Promise<string> {
  const plaintext = await decryptToBuffer(envelope, context, keyProvider);
  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
  }
}

/** Re-encrypt an existing envelope under the provider's current key. */
export async function rewrapCredential(
  envelope: CredentialEnvelope,
  context: CredentialContext,
  keyProvider: CredentialKeyProvider,
): Promise<CredentialEnvelope> {
  const normalizedContext = validateContext(context);
  const parsed = parseEnvelope(envelope);
  let currentKey: { keyId: string; key: Buffer } | undefined;
  try {
    currentKey = await resolveCurrentKey(keyProvider);
    let plaintext: Buffer;
    if (parsed.keyId === currentKey.keyId) {
      plaintext = decryptBuffer(parsed, normalizedContext, currentKey.key);
    } else {
      const oldKey = await resolveHistoricalKey(keyProvider, parsed.keyId);
      try {
        plaintext = decryptBuffer(parsed, normalizedContext, oldKey);
      } finally {
        oldKey.fill(0);
      }
    }
    try {
      return encryptBuffer(plaintext, normalizedContext, currentKey.keyId, currentKey.key);
    } finally {
      plaintext.fill(0);
    }
  } finally {
    currentKey?.key.fill(0);
    parsed.nonce.fill(0);
    parsed.ciphertext.fill(0);
    parsed.authTag.fill(0);
  }
}
