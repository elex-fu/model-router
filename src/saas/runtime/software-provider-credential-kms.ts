import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  type DecryptProviderCredentialDataKeyRequest,
  type GeneratedProviderCredentialDataKey,
  type GenerateProviderCredentialDataKeyRequest,
  PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
  type ProviderCredentialKmsEncryptionContext,
  type ReencryptedProviderCredentialDataKey,
  type ReencryptProviderCredentialDataKeyRequest,
} from '../credentials/provider-crypto.js';
import {
  assertProtectedWebhookEnvelope,
  assertUnprotectedWebhookSecret,
  type WebhookSigningSecretProtector,
} from '../webhooks/signing-secret-protector.js';
import type { ProviderCredentialUnsealingKmsModule } from './gateway-provider-credential-kms.js';
import type { ProviderCredentialSealingKmsModule } from './provider-credential-kms.js';
import type { ProviderCredentialRewrappingKmsModule } from './provider-credential-rewrapping-kms.js';
import type { ProviderEnvironment } from './providers.js';
import type { ValidationWorkerProviderCredentialKmsModule } from './validation-worker-provider-credential-kms.js';

// B1a pilot-only software KMS (contract C-2.2): AES-256-GCM envelope wrapping
// with a static master key from the environment. It satisfies every trusted
// KMS loader factory contract so pilot assembly needs no external KMS. The
// master key lives in the process environment, so protection is strictly
// weaker than a cloud KMS; it must never serve a charging production
// environment (M3 decision gate, REL-01).

export const MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY' as const;
export const MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID' as const;
export const MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS =
  'MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS' as const;
export const MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT' as const;

const DEFAULT_KEY_ID = 'software-local';
const MASTER_KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_PREVIOUS_KEYS = 16;

const BLOB_MAGIC = Buffer.from('MRSKMS1', 'ascii');
const WEBHOOK_BLOB_MAGIC = Buffer.from('MRWHKS1', 'ascii');
const BLOB_VERSION = 1;
const BLOB_HEADER_BYTES = BLOB_MAGIC.byteLength + 1 + 2;
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const MAX_BLOB_BYTES = 16 * 1024;
const WEBHOOK_MIN_SECRET_BYTES = 32;
const WEBHOOK_MAX_SECRET_BYTES = 256;
const WEBHOOK_MAX_AAD_BYTES = 1024;

/** Configuration errors are safe: they never carry key material or request detail. */
export class SoftwareProviderCredentialKmsError extends Error {
  constructor(readonly code: 'CONFIGURATION_INVALID' | 'OPERATION_FAILED' | 'PROVIDER_CLOSED') {
    super(
      code === 'CONFIGURATION_INVALID'
        ? 'Software provider credential KMS configuration is invalid'
        : code === 'PROVIDER_CLOSED'
          ? 'Software provider credential KMS is closed'
          : 'Software provider credential KMS operation failed',
    );
    this.name = 'SoftwareProviderCredentialKmsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function configurationInvalid(): never {
  throw new SoftwareProviderCredentialKmsError('CONFIGURATION_INVALID');
}

function operationFailed(): never {
  throw new SoftwareProviderCredentialKmsError('OPERATION_FAILED');
}

interface MasterKeyRing {
  readonly currentKeyId: string;
  readonly current: Buffer;
  readonly previous: ReadonlyMap<string, Buffer>;
}

function parseMasterKeyHex(value: string | undefined): Buffer {
  if (typeof value !== 'string' || !MASTER_KEY_HEX_PATTERN.test(value)) configurationInvalid();
  const key = Buffer.from(value, 'hex');
  if (key.byteLength !== PROVIDER_CREDENTIAL_DATA_KEY_BYTES) configurationInvalid();
  return key;
}

function parseKeyId(value: string | undefined): string {
  if (value === undefined) return DEFAULT_KEY_ID;
  if (!KEY_ID_PATTERN.test(value)) configurationInvalid();
  return value;
}

function parsePreviousMasterKeys(value: string | undefined, currentKeyId: string): Map<string, Buffer> {
  const previous = new Map<string, Buffer>();
  if (value === undefined || value.trim() === '') return previous;
  const entries = value.split(',');
  if (entries.length > MAX_PREVIOUS_KEYS) configurationInvalid();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) configurationInvalid();
    const keyId = entry.slice(0, separator);
    if (!KEY_ID_PATTERN.test(keyId) || keyId === currentKeyId || previous.has(keyId)) configurationInvalid();
    previous.set(keyId, parseMasterKeyHex(entry.slice(separator + 1)));
  }
  return previous;
}

function readMasterKeyRing(env: ProviderEnvironment): MasterKeyRing {
  const currentKeyId = parseKeyId(env[MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID]);
  return {
    currentKeyId,
    current: parseMasterKeyHex(env[MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY]),
    previous: parsePreviousMasterKeys(env[MODEL_ROUTER_SAAS_SOFTWARE_KMS_PREVIOUS_MASTER_KEYS], currentKeyId),
  };
}

/** The wrapped-blob key id and the request encryption context are authenticated data. */
function additionalAuthenticatedData(keyId: string, context: ProviderCredentialKmsEncryptionContext): Buffer {
  const entries = Object.entries(context).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Buffer.from(JSON.stringify({ key: keyId, ctx: entries }), 'utf8');
}

function wrapEnvelope(ring: MasterKeyRing, plaintext: Uint8Array, aad: Buffer, magic: Buffer): Buffer {
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', ring.current, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const keyIdBytes = Buffer.from(ring.currentKeyId, 'utf8');
  const header = Buffer.allocUnsafe(BLOB_HEADER_BYTES + keyIdBytes.byteLength);
  magic.copy(header, 0);
  header.writeUInt8(BLOB_VERSION, magic.byteLength);
  header.writeUInt16BE(keyIdBytes.byteLength, magic.byteLength + 1);
  keyIdBytes.copy(header, BLOB_HEADER_BYTES);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

function wrapDataKey(
  ring: MasterKeyRing,
  plaintextKey: Uint8Array,
  context: ProviderCredentialKmsEncryptionContext,
): Buffer {
  return wrapEnvelope(ring, plaintextKey, additionalAuthenticatedData(ring.currentKeyId, context), BLOB_MAGIC);
}

interface ParsedWrappedDataKey {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

function parseWrappedEnvelope(blob: Uint8Array, magic: Buffer, minPlaintextBytes: number): ParsedWrappedDataKey {
  if (
    !(blob instanceof Uint8Array) ||
    blob.byteLength < BLOB_HEADER_BYTES + WRAP_IV_BYTES + WRAP_TAG_BYTES + minPlaintextBytes ||
    blob.byteLength > MAX_BLOB_BYTES
  ) {
    operationFailed();
  }
  const source = Buffer.from(blob);
  if (!source.subarray(0, magic.byteLength).equals(magic)) operationFailed();
  if (source.readUInt8(magic.byteLength) !== BLOB_VERSION) operationFailed();
  const keyIdBytes = source.readUInt16BE(magic.byteLength + 1);
  const headerBytes = BLOB_HEADER_BYTES + keyIdBytes;
  if (keyIdBytes === 0 || blob.byteLength < headerBytes + WRAP_IV_BYTES + WRAP_TAG_BYTES + 1) operationFailed();
  const keyId = source.subarray(BLOB_HEADER_BYTES, headerBytes).toString('utf8');
  if (!KEY_ID_PATTERN.test(keyId)) operationFailed();
  return {
    keyId,
    iv: source.subarray(headerBytes, headerBytes + WRAP_IV_BYTES),
    authTag: source.subarray(headerBytes + WRAP_IV_BYTES, headerBytes + WRAP_IV_BYTES + WRAP_TAG_BYTES),
    ciphertext: source.subarray(headerBytes + WRAP_IV_BYTES + WRAP_TAG_BYTES),
  };
}

function masterKeyFor(ring: MasterKeyRing, keyId: string): Buffer {
  if (keyId === ring.currentKeyId) return ring.current;
  const previous = ring.previous.get(keyId);
  if (previous === undefined) operationFailed();
  return previous;
}

function unwrapEnvelope(
  ring: MasterKeyRing,
  blob: Uint8Array,
  expectedKeyId: string | undefined,
  aad: Buffer,
  magic: Buffer,
  minPlaintextBytes: number,
  maxPlaintextBytes: number,
): Buffer {
  const parsed = parseWrappedEnvelope(blob, magic, minPlaintextBytes);
  // The envelope-persisted key id must name the same key the blob wraps under.
  // Callers without an external key-id expectation pass undefined and trust
  // the authenticated header instead (the ring still fail-closes unknown ids).
  if (expectedKeyId !== undefined && parsed.keyId !== expectedKeyId) operationFailed();
  const decipher = createDecipheriv('aes-256-gcm', masterKeyFor(ring, parsed.keyId), parsed.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(parsed.authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch {
    operationFailed();
  }
  if (plaintext.byteLength < minPlaintextBytes || plaintext.byteLength > maxPlaintextBytes) {
    plaintext.fill(0);
    operationFailed();
  }
  return plaintext;
}

function unwrapDataKey(
  ring: MasterKeyRing,
  blob: Uint8Array,
  expectedKeyId: string,
  context: ProviderCredentialKmsEncryptionContext,
): Buffer {
  return unwrapEnvelope(
    ring,
    blob,
    expectedKeyId,
    additionalAuthenticatedData(expectedKeyId, context),
    BLOB_MAGIC,
    PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
    PROVIDER_CREDENTIAL_DATA_KEY_BYTES,
  );
}

let pilotWarningEmitted = false;

/** The software module is pilot-only: every assembly logs the downgrade explicitly. */
function warnPilotOnly(): void {
  if (pilotWarningEmitted) return;
  pilotWarningEmitted = true;
  process.emitWarning(
    'Software provider-credential KMS is pilot-only: master keys are static environment values. ' +
      'It must not serve a charging production environment (cloud KMS upgrade is the M3 decision gate).',
    { code: 'MODEL_ROUTER_SOFTWARE_KMS_PILOT_ONLY' },
  );
}

interface SoftwareKmsLifecycle {
  readonly assertOpen: () => void;
  readonly checkReady: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function lifecycle(
  ring: MasterKeyRing,
  env: ProviderEnvironment,
): SoftwareKmsLifecycle & { readonly ring: MasterKeyRing } {
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new SoftwareProviderCredentialKmsError('PROVIDER_CLOSED');
  };
  return {
    ring,
    assertOpen,
    checkReady: async () => {
      assertOpen();
      warnPilotOnly();
      // Contract C-2.2: the pilot-only module must refuse production readiness
      // unless the operator explicitly accepts the downgrade.
      if (env.NODE_ENV === 'production' && env[MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT] !== 'true') {
        configurationInvalid();
      }
      // Prove the configured ring actually wraps and unwraps before traffic.
      const probe = randomBytes(PROVIDER_CREDENTIAL_DATA_KEY_BYTES);
      let unwrapped: Buffer | undefined;
      try {
        unwrapped = unwrapDataKey(ring, wrapDataKey(ring, probe, {}), ring.currentKeyId, {});
        if (!unwrapped.equals(probe)) operationFailed();
      } finally {
        probe.fill(0);
        unwrapped?.fill(0);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      ring.current.fill(0);
      for (const key of ring.previous.values()) key.fill(0);
    },
  };
}

export const createProviderCredentialSealingKms: ProviderCredentialSealingKmsModule['createProviderCredentialSealingKms'] =
  ({ env }) => {
    warnPilotOnly();
    const provider = lifecycle(readMasterKeyRing(env), env);
    return {
      generateDataKey: (request: GenerateProviderCredentialDataKeyRequest): GeneratedProviderCredentialDataKey => {
        provider.assertOpen();
        if (request.keySpec !== 'AES_256' || request.kmsKeyId !== provider.ring.currentKeyId) operationFailed();
        const plaintextKey = randomBytes(PROVIDER_CREDENTIAL_DATA_KEY_BYTES);
        return {
          plaintextKey,
          ciphertextBlob: wrapDataKey(provider.ring, plaintextKey, request.encryptionContext),
        };
      },
      checkReady: provider.checkReady,
      close: provider.close,
    };
  };

function unsealingProvider(env: ProviderEnvironment): {
  readonly decryptDataKey: (request: DecryptProviderCredentialDataKeyRequest) => Uint8Array;
  readonly checkReady: () => Promise<void>;
  readonly close: () => Promise<void>;
} {
  warnPilotOnly();
  const provider = lifecycle(readMasterKeyRing(env), env);
  return {
    decryptDataKey: (request: DecryptProviderCredentialDataKeyRequest): Uint8Array => {
      provider.assertOpen();
      return unwrapDataKey(provider.ring, request.ciphertextBlob, request.kmsKeyId, request.encryptionContext);
    },
    checkReady: provider.checkReady,
    close: provider.close,
  };
}

export const createGatewayProviderCredentialUnsealingKms: ProviderCredentialUnsealingKmsModule['createGatewayProviderCredentialUnsealingKms'] =
  ({ env }) => unsealingProvider(env);

export const createCredentialValidationWorkerUnsealingKms: ValidationWorkerProviderCredentialKmsModule['createCredentialValidationWorkerUnsealingKms'] =
  ({ env }) => unsealingProvider(env);

export const createProviderCredentialRewrappingKms: ProviderCredentialRewrappingKmsModule['createProviderCredentialRewrappingKms'] =
  ({ env }) => {
    warnPilotOnly();
    const provider = lifecycle(readMasterKeyRing(env), env);
    return {
      reencryptDataKey: (request: ReencryptProviderCredentialDataKeyRequest): ReencryptedProviderCredentialDataKey => {
        provider.assertOpen();
        // ReEncrypt rotates towards the configured current key; the plaintext
        // DEK never leaves the module boundary.
        if (request.destinationKmsKeyId !== provider.ring.currentKeyId) operationFailed();
        let plaintext: Buffer | undefined;
        try {
          plaintext = unwrapDataKey(
            provider.ring,
            request.ciphertextBlob,
            request.sourceKmsKeyId,
            request.sourceEncryptionContext,
          );
          return {
            sourceKmsKeyId: request.sourceKmsKeyId,
            destinationKmsKeyId: request.destinationKmsKeyId,
            ciphertextBlob: wrapDataKey(provider.ring, plaintext, request.destinationEncryptionContext),
          };
        } finally {
          plaintext?.fill(0);
        }
      },
      checkReady: provider.checkReady,
      close: provider.close,
    };
  };

/** Lifecycle surface the runtime loader validates beyond the contract interface. */
export interface SoftwareWebhookSigningSecretProtector extends WebhookSigningSecretProtector {
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export interface SoftwareWebhookSigningSecretProtectorOptions {
  readonly env: ProviderEnvironment;
}

function webhookAdditionalData(aad: Uint8Array): Buffer {
  if (!(aad instanceof Uint8Array) || aad.byteLength < 1 || aad.byteLength > WEBHOOK_MAX_AAD_BYTES) {
    operationFailed();
  }
  return Buffer.from(aad);
}

/**
 * Customer webhook signing-secret protector (contract C-2.2 / F1). It reuses
 * this module's AES-256-GCM envelope primitives but never the provider-
 * credential purpose: a distinct blob magic and caller-supplied AAD keep the
 * domains non-interchangeable. The signing-secret store persists no key id,
 * so unprotect trusts the authenticated envelope header (the ring fail-closes
 * on unknown key ids) and previous master keys stay readable after rotation.
 */
export function createWebhookSigningSecretProtector(
  options: SoftwareWebhookSigningSecretProtectorOptions,
): SoftwareWebhookSigningSecretProtector {
  warnPilotOnly();
  const provider = lifecycle(readMasterKeyRing(options.env), options.env);
  return Object.freeze({
    purpose: 'customer-webhook-signing-secret-v1' as const,
    protect: async (plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> => {
      provider.assertOpen();
      assertUnprotectedWebhookSecret(plaintext);
      return wrapEnvelope(provider.ring, plaintext, webhookAdditionalData(aad), WEBHOOK_BLOB_MAGIC);
    },
    unprotect: async (envelope: Uint8Array, aad: Uint8Array): Promise<Uint8Array> => {
      provider.assertOpen();
      assertProtectedWebhookEnvelope(envelope);
      return unwrapEnvelope(
        provider.ring,
        envelope,
        undefined,
        webhookAdditionalData(aad),
        WEBHOOK_BLOB_MAGIC,
        WEBHOOK_MIN_SECRET_BYTES,
        WEBHOOK_MAX_SECRET_BYTES,
      );
    },
    checkReady: provider.checkReady,
    close: provider.close,
  });
}
