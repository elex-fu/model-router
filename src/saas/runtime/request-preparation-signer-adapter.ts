import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PreparedRequestEvidenceInput } from '../gateway/prepared-request-evidence-service.js';
import { canonicalPreparedRequestEvidencePayload } from '../gateway/prepared-request-evidence-service.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationDecision,
  type RequestPreparationEvidenceSignature,
  type RequestPreparationEvidenceSigner,
} from '../gateway/request-preparation-service.js';
import type { PreparedRequestEvidenceSigner } from './prepared-request-evidence-signer.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ED25519_SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** Stable public message for every adapter validation or signer failure. */
export const REQUEST_PREPARATION_SIGNING_FAILED_MESSAGE = 'prepared evidence signing failed';

export type RequestPreparationSigner = Pick<PreparedRequestEvidenceSigner, 'verifierKeyId' | 'sign'>;

export type RequestPreparationSignerInput = Parameters<RequestPreparationEvidenceSigner['sign']>[0];

export type RequestPreparationSignerAdapterOptions =
  | {
      readonly signer: RequestPreparationSigner;
      readonly runtimeVerifierKeyId: string;
    }
  | {
      readonly signer: RequestPreparationSigner;
      readonly verifierKeyId: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function unsignedFields(input: PreparedRequestEvidenceInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'signatureBase64'));
}

function isCanonicalEd25519Signature(value: unknown): value is string {
  if (typeof value !== 'string' || !ED25519_SIGNATURE_BASE64.test(value)) return false;
  try {
    const signature = Buffer.from(value, 'base64');
    return signature.length === 64 && signature.toString('base64') === value;
  } catch {
    return false;
  }
}

function signingFailed(): RequestPreparationDecision<RequestPreparationEvidenceSignature> {
  return blockRequestPreparation('signing_failed', REQUEST_PREPARATION_SIGNING_FAILED_MESSAGE);
}

/**
 * Narrow trusted bridge from request preparation's digest-bearing port to the
 * deployment-injected Ed25519 signer. It owns no key material of its own.
 */
export class RequestPreparationSignerAdapter implements RequestPreparationEvidenceSigner {
  readonly verifierKeyId: string;
  readonly runtimeVerifierKeyId: string;
  readonly #signer: RequestPreparationSigner;

  constructor(options: RequestPreparationSignerAdapterOptions);
  constructor(signer: RequestPreparationSigner, runtimeVerifierKeyId: string);
  constructor(
    optionsOrSigner: RequestPreparationSignerAdapterOptions | RequestPreparationSigner,
    positionalRuntimeVerifierKeyId?: string,
  ) {
    const isPositional = positionalRuntimeVerifierKeyId !== undefined;
    const signer = isPositional
      ? (optionsOrSigner as RequestPreparationSigner)
      : (optionsOrSigner as RequestPreparationSignerAdapterOptions).signer;
    const runtimeVerifierKeyId = isPositional
      ? positionalRuntimeVerifierKeyId
      : 'runtimeVerifierKeyId' in (optionsOrSigner as RequestPreparationSignerAdapterOptions)
        ? (optionsOrSigner as Extract<RequestPreparationSignerAdapterOptions, { runtimeVerifierKeyId: string }>)
            .runtimeVerifierKeyId
        : (optionsOrSigner as Extract<RequestPreparationSignerAdapterOptions, { verifierKeyId: string }>).verifierKeyId;

    this.#signer = signer;
    this.verifierKeyId = runtimeVerifierKeyId;
    this.runtimeVerifierKeyId = runtimeVerifierKeyId;
    Object.freeze(this);
  }

  async sign(
    input: RequestPreparationSignerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationEvidenceSignature>> {
    try {
      const request = input as unknown;
      if (!isRecord(request) || !isRecord(request.evidence)) return signingFailed();

      const evidence = request.evidence as unknown as PreparedRequestEvidenceInput;
      const signerVerifierKeyId = this.#signer.verifierKeyId;
      if (
        !isNonEmptyString(this.runtimeVerifierKeyId) ||
        !isNonEmptyString(signerVerifierKeyId) ||
        request.verifierKeyId !== this.runtimeVerifierKeyId ||
        request.verifierKeyId !== signerVerifierKeyId ||
        evidence.verifierKeyId !== request.verifierKeyId
      ) {
        return signingFailed();
      }

      if (typeof request.canonicalPayload !== 'string' || typeof request.canonicalPayloadSha256 !== 'string') {
        return signingFailed();
      }

      const canonicalPayload = canonicalPreparedRequestEvidencePayload(evidence);
      const canonicalBytes = Buffer.from(canonicalPayload, 'utf8');
      const suppliedCanonicalBytes = Buffer.from(request.canonicalPayload, 'utf8');
      if (canonicalPayload !== request.canonicalPayload || !canonicalBytes.equals(suppliedCanonicalBytes)) {
        return signingFailed();
      }

      const canonicalPayloadSha256 = createHash('sha256').update(canonicalBytes).digest('hex');
      if (
        !SHA256_HEX.test(request.canonicalPayloadSha256) ||
        canonicalPayloadSha256 !== request.canonicalPayloadSha256
      ) {
        return signingFailed();
      }

      const originalUnsignedFields = unsignedFields(evidence);
      const originalSignatureBase64 = evidence.signatureBase64;
      const signedEvidenceValue = this.#signer.sign(evidence);
      if (evidence.signatureBase64 !== originalSignatureBase64 || !isRecord(signedEvidenceValue)) {
        return signingFailed();
      }

      const signedEvidence = signedEvidenceValue as PreparedRequestEvidenceInput;
      if (
        signedEvidence.verifierKeyId !== request.verifierKeyId ||
        !isDeepStrictEqual(unsignedFields(signedEvidence), originalUnsignedFields) ||
        !isCanonicalEd25519Signature(signedEvidence.signatureBase64)
      ) {
        return signingFailed();
      }

      return allowRequestPreparation({ signatureBase64: signedEvidence.signatureBase64 });
    } catch {
      return signingFailed();
    }
  }
}

export function createRequestPreparationSignerAdapter(
  options: RequestPreparationSignerAdapterOptions,
): RequestPreparationSignerAdapter;
export function createRequestPreparationSignerAdapter(
  signer: RequestPreparationSigner,
  runtimeVerifierKeyId: string,
): RequestPreparationSignerAdapter;
export function createRequestPreparationSignerAdapter(
  optionsOrSigner: RequestPreparationSignerAdapterOptions | RequestPreparationSigner,
  positionalRuntimeVerifierKeyId?: string,
): RequestPreparationSignerAdapter {
  return positionalRuntimeVerifierKeyId === undefined
    ? new RequestPreparationSignerAdapter(optionsOrSigner as RequestPreparationSignerAdapterOptions)
    : new RequestPreparationSignerAdapter(optionsOrSigner as RequestPreparationSigner, positionalRuntimeVerifierKeyId);
}

export {
  RequestPreparationSignerAdapter as RequestPreparationEvidenceSignerAdapter,
  RequestPreparationSignerAdapter as SaasRequestPreparationSignerAdapter,
};

export const createRequestPreparationEvidenceSignerAdapter = createRequestPreparationSignerAdapter;
export const createSaasRequestPreparationSignerAdapter = createRequestPreparationSignerAdapter;
