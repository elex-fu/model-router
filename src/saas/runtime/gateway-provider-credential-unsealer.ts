import { createDecipheriv } from 'node:crypto';
import {
  createProviderCredentialContext,
  createProviderCredentialEncryptionContext,
  MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES,
  PROVIDER_CREDENTIAL_AUTH_TAG_BYTES,
  PROVIDER_CREDENTIAL_CONTEXT_VERSION,
  PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
  PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
  PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION,
  PROVIDER_CREDENTIAL_NONCE_BYTES,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
} from '../credentials/provider-crypto.js';
import type {
  ProviderCredentialDispatchAccountSnapshot,
  ProviderCredentialDispatchCredentialSnapshot,
  StoredProviderCredentialVersion,
} from '../supply/types.js';
import type { ProviderCredentialUnsealingKms } from './gateway-provider-credential-kms.js';

const MAX_CONTEXT_FIELD_BYTES = 256;
const MAX_KMS_KEY_ID_BYTES = 512;
const MAX_WRAPPED_DEK_BYTES = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

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

const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: 'Gateway provider credential input is invalid',
  METADATA_MISMATCH: 'Gateway provider credential metadata does not match',
  KMS_DECRYPTION_FAILED: 'Gateway provider credential data-key decryption failed',
  INVALID_DATA_KEY: 'Gateway provider credential data key is invalid',
  GCM_DECRYPTION_FAILED: 'Gateway provider credential authenticated decryption failed',
  CALLBACK_FAILED: 'Gateway provider credential callback failed',
} satisfies Record<string, string>);

export type GatewayProviderCredentialUnsealerErrorCode = keyof typeof SAFE_ERROR_MESSAGES;

/** Safe runtime errors never include envelope bytes, provider errors, or plaintext. */
export class GatewayProviderCredentialUnsealerError extends Error {
  constructor(readonly code: GatewayProviderCredentialUnsealerErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'GatewayProviderCredentialUnsealerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Metadata required to reconstruct the context used by the control-plane sealer. */
export type GatewayProviderCredentialAccount = Pick<
  ProviderCredentialDispatchAccountSnapshot,
  'ownerKind' | 'tenantId' | 'supplyMode' | 'id' | 'providerId' | 'productId' | 'credentialType' | 'purpose'
>;

export type GatewayProviderCredentialCredential = Pick<
  ProviderCredentialDispatchCredentialSnapshot,
  'ownerKind' | 'tenantId' | 'supplyMode' | 'id' | 'accountId' | 'providerId' | 'productId'
>;

export interface GatewayProviderCredentialUnsealInput {
  readonly account: GatewayProviderCredentialAccount;
  readonly credential: GatewayProviderCredentialCredential;
  /** The repository's internal runtime shape; it contains envelope bytes only here. */
  readonly version: StoredProviderCredentialVersion;
}

export interface GatewayProviderCredentialUnsealerOptions {
  readonly deployment: string;
  readonly environment: string;
}

interface ParsedEnvelope {
  readonly algorithm: typeof PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM;
  readonly kmsKeyId: string;
  readonly wrappedDek: Buffer;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

interface NormalizedInput {
  readonly account: GatewayProviderCredentialAccount;
  readonly credential: GatewayProviderCredentialCredential;
  readonly version: StoredProviderCredentialVersion;
  readonly context: ProviderCredentialContext;
}

function runtimeError(code: GatewayProviderCredentialUnsealerErrorCode): GatewayProviderCredentialUnsealerError {
  return new GatewayProviderCredentialUnsealerError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
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
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) throw runtimeError('INVALID_INPUT');
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw runtimeError('INVALID_INPUT');
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw runtimeError('INVALID_INPUT');
  return value;
}

interface OwnerShape {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly supplyMode: 'byok' | 'platform';
}

function ownerIsValid(owner: OwnerShape): boolean {
  return owner.ownerKind === 'tenant'
    ? owner.supplyMode === 'byok' && typeof owner.tenantId === 'string'
    : owner.ownerKind === 'platform' && owner.supplyMode === 'platform' && owner.tenantId === null;
}

function createContext(
  account: GatewayProviderCredentialAccount,
  credential: GatewayProviderCredentialCredential,
  version: StoredProviderCredentialVersion,
  options: GatewayProviderCredentialUnsealerOptions,
): ProviderCredentialContext {
  const common = {
    deployment: options.deployment,
    environment: options.environment,
    purpose: account.purpose,
    providerId: account.providerId,
    productId: account.productId,
    credentialVersion: version.version,
    credentialType: account.credentialType,
  } as const;
  if (account.ownerKind === 'tenant') {
    const tenantId = account.tenantId;
    if (typeof tenantId !== 'string') throw runtimeError('INVALID_INPUT');
    return createProviderCredentialContext({
      ...common,
      ownerKind: 'tenant',
      tenantId,
      supplyMode: 'byok',
      accountId: account.id,
      credentialId: credential.id,
    });
  }
  return createProviderCredentialContext({
    ...common,
    ownerKind: 'platform',
    supplyMode: 'platform',
    accountId: account.id,
    credentialId: credential.id,
  });
}

function zero(value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  try {
    value.fill(0);
  } catch {
    // Detached typed arrays cannot be cleared further.
  }
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
    throw runtimeError('INVALID_INPUT');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64url') !== value) {
    decoded.fill(0);
    throw runtimeError('INVALID_INPUT');
  }
  return decoded;
}

function parseEnvelope(value: unknown): ParsedEnvelope {
  let wrappedDek: Buffer | undefined;
  let nonce: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let authTag: Buffer | undefined;
  try {
    if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) throw runtimeError('INVALID_INPUT');
    if (
      value.schemaVersion !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      value.contextVersion !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      value.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM
    ) {
      throw runtimeError('METADATA_MISMATCH');
    }
    const kmsKeyId = text(value.kmsKeyId, MAX_KMS_KEY_ID_BYTES);
    wrappedDek = decodeBase64Url(value.wrappedDek, MAX_WRAPPED_DEK_BYTES);
    nonce = decodeBase64Url(value.nonce, PROVIDER_CREDENTIAL_NONCE_BYTES);
    ciphertext = decodeBase64Url(value.ciphertext, MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES);
    authTag = decodeBase64Url(value.authTag, PROVIDER_CREDENTIAL_AUTH_TAG_BYTES);
    if (nonce.length !== PROVIDER_CREDENTIAL_NONCE_BYTES || authTag.length !== PROVIDER_CREDENTIAL_AUTH_TAG_BYTES) {
      throw runtimeError('INVALID_INPUT');
    }
    return {
      algorithm: PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM,
      kmsKeyId,
      wrappedDek,
      nonce,
      ciphertext,
      authTag,
    };
  } catch (error) {
    wrappedDek?.fill(0);
    nonce?.fill(0);
    ciphertext?.fill(0);
    authTag?.fill(0);
    if (error instanceof GatewayProviderCredentialUnsealerError) throw error;
    throw runtimeError('INVALID_INPUT');
  }
}

function validateAndNormalizeInput(
  input: GatewayProviderCredentialUnsealInput,
  options: GatewayProviderCredentialUnsealerOptions,
): NormalizedInput {
  try {
    if (!isRecord(input) || !isRecord(input.account) || !isRecord(input.credential) || !isRecord(input.version)) {
      throw runtimeError('INVALID_INPUT');
    }
    const account = input.account as GatewayProviderCredentialAccount;
    const credential = input.credential as GatewayProviderCredentialCredential;
    const version = input.version as StoredProviderCredentialVersion;
    const accountText = [account.id, account.providerId, account.productId, account.credentialType, account.purpose];
    const credentialText = [credential.id, credential.accountId, credential.providerId, credential.productId];
    const versionText = [version.accountId, version.credentialId, version.kmsPurpose, version.kmsKeyId];
    if (
      !ownerIsValid(account) ||
      !ownerIsValid(credential) ||
      (version.ownerKind !== 'tenant' && version.ownerKind !== 'platform') ||
      (version.ownerKind === 'tenant' && typeof version.tenantId !== 'string') ||
      (version.ownerKind === 'platform' && version.tenantId !== null) ||
      !accountText.every((value) => typeof value === 'string') ||
      !credentialText.every((value) => typeof value === 'string') ||
      !versionText.every((value) => typeof value === 'string')
    ) {
      throw runtimeError('INVALID_INPUT');
    }
    for (const value of accountText) text(value, MAX_CONTEXT_FIELD_BYTES);
    for (const value of credentialText) text(value, MAX_CONTEXT_FIELD_BYTES);
    for (const value of versionText) text(value, MAX_CONTEXT_FIELD_BYTES);
    const versionNumber = positiveInteger(version.version);
    positiveInteger(version.envelopeSchemaVersion);
    positiveInteger(version.contextVersion);
    text(options.deployment, MAX_CONTEXT_FIELD_BYTES);
    text(options.environment, MAX_CONTEXT_FIELD_BYTES);

    const mismatched =
      account.ownerKind !== credential.ownerKind ||
      account.ownerKind !== version.ownerKind ||
      account.tenantId !== credential.tenantId ||
      account.tenantId !== version.tenantId ||
      account.supplyMode !== credential.supplyMode ||
      account.supplyMode !== (version.ownerKind === 'tenant' ? 'byok' : 'platform') ||
      credential.accountId !== account.id ||
      credential.providerId !== account.providerId ||
      credential.productId !== account.productId ||
      version.accountId !== account.id ||
      version.credentialId !== credential.id ||
      versionNumber !== version.version ||
      version.kmsPurpose !== account.purpose ||
      version.envelopeSchemaVersion !== PROVIDER_CREDENTIAL_ENVELOPE_SCHEMA_VERSION ||
      version.contextVersion !== PROVIDER_CREDENTIAL_CONTEXT_VERSION ||
      version.algorithm !== PROVIDER_CREDENTIAL_ENVELOPE_ALGORITHM ||
      version.kmsKeyId !== version.envelope.kmsKeyId ||
      version.envelope.schemaVersion !== version.envelopeSchemaVersion ||
      version.envelope.contextVersion !== version.contextVersion ||
      version.envelope.algorithm !== version.algorithm;
    if (mismatched) throw runtimeError('METADATA_MISMATCH');

    const context = createContext(account, credential, version, options);
    return { account, credential, version, context };
  } catch (error) {
    if (error instanceof GatewayProviderCredentialUnsealerError) throw error;
    throw runtimeError('INVALID_INPUT');
  }
}

/**
 * The sealer's private AAD is JSON.stringify of the ordered canonical KMS
 * context entries. The public context helper preserves that insertion order,
 * so this derives the exact existing AAD without defining a second format.
 */
function createCanonicalAad(context: ProviderCredentialContext): Buffer {
  const encryptionContext = createProviderCredentialEncryptionContext(context);
  return Buffer.from(JSON.stringify(Object.entries(encryptionContext)), 'utf8');
}

function copyDataKey(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES) {
    throw runtimeError('INVALID_DATA_KEY');
  }
  const copy = Buffer.from(value);
  if (copy.length !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES) {
    copy.fill(0);
    throw runtimeError('INVALID_DATA_KEY');
  }
  return copy;
}

function decryptGcm(parsed: ParsedEnvelope, dataKey: Buffer, aad: Buffer): Buffer {
  let updateOutput: Buffer | undefined;
  let finalOutput: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(parsed.algorithm, dataKey, parsed.nonce, {
      authTagLength: PROVIDER_CREDENTIAL_AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(parsed.authTag);
    updateOutput = decipher.update(parsed.ciphertext);
    finalOutput = decipher.final();
    plaintext = Buffer.concat([updateOutput, finalOutput]);
    if (plaintext.length === 0 || plaintext.length > MAX_PROVIDER_CREDENTIAL_PLAINTEXT_BYTES) {
      throw runtimeError('GCM_DECRYPTION_FAILED');
    }
    updateOutput.fill(0);
    finalOutput.fill(0);
    updateOutput = undefined;
    finalOutput = undefined;
    const result = plaintext;
    plaintext = undefined;
    return result;
  } catch (error) {
    if (error instanceof GatewayProviderCredentialUnsealerError) throw error;
    throw runtimeError('GCM_DECRYPTION_FAILED');
  } finally {
    updateOutput?.fill(0);
    finalOutput?.fill(0);
    plaintext?.fill(0);
  }
}

/**
 * Gateway-only provider credential primitive. It accepts the decrypt facade,
 * never a control-plane sealing KMS, and exposes plaintext only to the callback.
 */
export class GatewayProviderCredentialUnsealer {
  private readonly kms: ProviderCredentialUnsealingKms;
  private readonly options: GatewayProviderCredentialUnsealerOptions;

  constructor(kms: ProviderCredentialUnsealingKms, options: GatewayProviderCredentialUnsealerOptions) {
    let decryptDataKey: unknown;
    try {
      decryptDataKey = kms && typeof kms === 'object' ? kms.decryptDataKey : undefined;
    } catch {
      throw runtimeError('INVALID_INPUT');
    }
    if (typeof decryptDataKey !== 'function') {
      throw runtimeError('INVALID_INPUT');
    }
    if (!options || typeof options !== 'object') throw runtimeError('INVALID_INPUT');
    let deployment: string;
    let environment: string;
    try {
      deployment = text(options.deployment, MAX_CONTEXT_FIELD_BYTES);
      environment = text(options.environment, MAX_CONTEXT_FIELD_BYTES);
    } catch (error) {
      if (error instanceof GatewayProviderCredentialUnsealerError) throw error;
      throw runtimeError('INVALID_INPUT');
    }
    this.kms = kms;
    this.options = Object.freeze({ deployment, environment });
  }

  async withCredential<T>(
    input: GatewayProviderCredentialUnsealInput,
    callback: (plaintext: Buffer) => T | PromiseLike<T>,
  ): Promise<T> {
    if (typeof callback !== 'function') throw runtimeError('INVALID_INPUT');
    let parsed: ParsedEnvelope | undefined;
    let aad: Buffer | undefined;
    let wrappedDek: Buffer | undefined;
    let returnedDataKey: Uint8Array | undefined;
    let dataKey: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const normalized = validateAndNormalizeInput(input, this.options);
      parsed = parseEnvelope(normalized.version.envelope as ProviderCredentialEnvelope);
      aad = createCanonicalAad(normalized.context);
      wrappedDek = Buffer.from(parsed.wrappedDek);

      try {
        returnedDataKey = await this.kms.decryptDataKey({
          kmsKeyId: parsed.kmsKeyId,
          ciphertextBlob: wrappedDek,
          encryptionContext: createProviderCredentialEncryptionContext(normalized.context),
        });
      } catch {
        throw runtimeError('KMS_DECRYPTION_FAILED');
      }
      dataKey = copyDataKey(returnedDataKey);
      plaintext = decryptGcm(parsed, dataKey, aad);
      try {
        return await callback(plaintext);
      } catch {
        throw runtimeError('CALLBACK_FAILED');
      }
    } catch (error) {
      if (error instanceof GatewayProviderCredentialUnsealerError) throw error;
      throw runtimeError('GCM_DECRYPTION_FAILED');
    } finally {
      plaintext?.fill(0);
      dataKey?.fill(0);
      zero(returnedDataKey);
      aad?.fill(0);
      wrappedDek?.fill(0);
      parsed?.wrappedDek.fill(0);
      parsed?.nonce.fill(0);
      parsed?.ciphertext.fill(0);
      parsed?.authTag.fill(0);
    }
  }
}

export { GatewayProviderCredentialUnsealer as GatewayProviderCredentialRuntime };

export function createGatewayProviderCredentialUnsealer(
  kms: ProviderCredentialUnsealingKms,
  options: GatewayProviderCredentialUnsealerOptions,
): GatewayProviderCredentialUnsealer {
  return new GatewayProviderCredentialUnsealer(kms, options);
}

export async function withGatewayProviderCredential<T>(
  kms: ProviderCredentialUnsealingKms,
  options: GatewayProviderCredentialUnsealerOptions,
  input: GatewayProviderCredentialUnsealInput,
  callback: (plaintext: Buffer) => T | PromiseLike<T>,
): Promise<T> {
  return new GatewayProviderCredentialUnsealer(kms, options).withCredential(input, callback);
}
