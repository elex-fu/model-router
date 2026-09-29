import { createPrivateKey, createPublicKey, KeyObject, sign as signMessage } from 'node:crypto';
import {
  canonicalPreparedRequestEvidencePayload,
  type PreparedRequestEvidenceInput,
} from '../gateway/prepared-request-evidence-service.js';
import { TrustedPreparedRequestVerifierKeyRegistry } from './prepared-evidence-verifier-keys.js';

export type PreparedRequestEvidencePrivateKey = KeyObject | string | Uint8Array;

export interface PreparedRequestEvidenceSignerOptions {
  readonly registry: TrustedPreparedRequestVerifierKeyRegistry;
  readonly verifierKeyId: string;
  readonly privateKey: PreparedRequestEvidencePrivateKey;
}

export type PreparedRequestEvidenceSignerErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'UNKNOWN_VERIFIER_KEY'
  | 'INACTIVE_VERIFIER_KEY'
  | 'INVALID_PRIVATE_KEY'
  | 'UNSUPPORTED_KEY_ALGORITHM'
  | 'PRIVATE_KEY_MISMATCH'
  | 'INVALID_INPUT'
  | 'SIGNING_FAILED';

const ERROR_MESSAGES: Readonly<Record<PreparedRequestEvidenceSignerErrorCode, string>> = Object.freeze({
  INVALID_CONFIGURATION: 'Prepared evidence signer configuration is invalid',
  UNKNOWN_VERIFIER_KEY: 'Prepared evidence signer verifier key is not configured',
  INACTIVE_VERIFIER_KEY: 'Prepared evidence signer verifier key is not active',
  INVALID_PRIVATE_KEY: 'Prepared evidence signer private key is invalid',
  UNSUPPORTED_KEY_ALGORITHM: 'Prepared evidence signer private key must be Ed25519',
  PRIVATE_KEY_MISMATCH: 'Prepared evidence signer private key does not match the registered verifier key',
  INVALID_INPUT: 'Prepared evidence input is invalid',
  SIGNING_FAILED: 'Prepared evidence signing failed',
});

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

export class PreparedRequestEvidenceSignerError extends Error {
  constructor(readonly code: PreparedRequestEvidenceSignerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PreparedRequestEvidenceSignerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function signerError(code: PreparedRequestEvidenceSignerErrorCode): PreparedRequestEvidenceSignerError {
  return new PreparedRequestEvidenceSignerError(code);
}

function normalizeVerifierKeyId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw signerError('INVALID_CONFIGURATION');
  return value.trim();
}

function parsePrivateKey(value: unknown): KeyObject {
  let key: KeyObject;

  if (value instanceof KeyObject) {
    key = value;
  } else if (typeof value === 'string') {
    try {
      key = createPrivateKey(value);
    } catch {
      throw signerError('INVALID_PRIVATE_KEY');
    }
  } else if (value instanceof Uint8Array) {
    try {
      key = createPrivateKey({
        key: Buffer.from(value),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw signerError('INVALID_PRIVATE_KEY');
    }
  } else {
    throw signerError('INVALID_PRIVATE_KEY');
  }

  if (key.type !== 'private') throw signerError('INVALID_PRIVATE_KEY');
  if (key.asymmetricKeyType !== 'ed25519') throw signerError('UNSUPPORTED_KEY_ALGORITHM');
  return key;
}

function spkiDer(key: KeyObject): Buffer {
  try {
    const exported = key.export({ format: 'der', type: 'spki' });
    return Buffer.from(exported);
  } catch {
    throw signerError('PRIVATE_KEY_MISMATCH');
  }
}

function copyUnsignedInput(input: PreparedRequestEvidenceInput, verifierKeyId: string): PreparedRequestEvidenceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw signerError('INVALID_INPUT');
  try {
    return {
      ...input,
      verifierKeyId,
      signatureBase64: '',
    };
  } catch {
    throw signerError('INVALID_INPUT');
  }
}

/**
 * Deployment-injected Ed25519 signer for prepared-request evidence.
 *
 * The private key is retained only by the signer instance. It is never
 * exported, serialized, logged, or included in a returned evidence object.
 */
export class PreparedRequestEvidenceSigner {
  readonly verifierKeyId: string;
  readonly #privateKey: KeyObject;

  constructor(options: PreparedRequestEvidenceSignerOptions) {
    if (!options || typeof options !== 'object') throw signerError('INVALID_CONFIGURATION');
    if (!(options.registry instanceof TrustedPreparedRequestVerifierKeyRegistry)) {
      throw signerError('INVALID_CONFIGURATION');
    }

    const verifierKeyId = normalizeVerifierKeyId(options.verifierKeyId);
    const status = options.registry.getStatus(verifierKeyId);
    if (status === undefined) throw signerError('UNKNOWN_VERIFIER_KEY');
    if (status !== 'active') throw signerError('INACTIVE_VERIFIER_KEY');

    const registeredPublicKey = options.registry.get(verifierKeyId);
    if (!registeredPublicKey) throw signerError('UNKNOWN_VERIFIER_KEY');

    const privateKey = parsePrivateKey(options.privateKey);
    let derivedPublicKey: KeyObject;
    try {
      derivedPublicKey = createPublicKey(privateKey);
    } catch {
      throw signerError('INVALID_PRIVATE_KEY');
    }
    if (!spkiDer(derivedPublicKey).equals(spkiDer(registeredPublicKey))) {
      throw signerError('PRIVATE_KEY_MISMATCH');
    }

    this.verifierKeyId = verifierKeyId;
    this.#privateKey = privateKey;
    Object.freeze(this);
  }

  sign(input: PreparedRequestEvidenceInput): PreparedRequestEvidenceInput {
    const unsigned = copyUnsignedInput(input, this.verifierKeyId);
    let canonical: string;
    try {
      canonical = canonicalPreparedRequestEvidencePayload(unsigned);
    } catch {
      throw signerError('INVALID_INPUT');
    }

    let signature: Buffer;
    try {
      signature = signMessage(null, Buffer.from(canonical, 'utf8'), this.#privateKey);
    } catch {
      throw signerError('SIGNING_FAILED');
    }
    if (signature.length !== ED25519_SIGNATURE_BYTES) throw signerError('SIGNING_FAILED');

    const signatureBase64 = signature.toString('base64');
    if (!ED25519_SIGNATURE_BASE64.test(signatureBase64)) throw signerError('SIGNING_FAILED');

    return {
      ...unsigned,
      signatureBase64,
    };
  }
}

export function createPreparedRequestEvidenceSigner(
  options: PreparedRequestEvidenceSignerOptions,
): PreparedRequestEvidenceSigner {
  return new PreparedRequestEvidenceSigner(options);
}

export { PreparedRequestEvidenceSigner as SaasPreparedRequestEvidenceSigner };
