/**
 * Batch-5 §5.1 plugin signature verification (task #24; design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次五 5.1; sub2api reference:
 * backend/internal/service/plugin_package.go).
 *
 * signature.json is a strict, exactly-keyed JSON object
 * `{ algorithm, key_id, signature }` covering EXACTLY the raw manifest.json
 * bytes (the signature-chain root — not the parsed manifest, not the archive).
 * Only Ed25519 is accepted. key_id must resolve to a trusted publisher whose
 * configured value is a strict-base64 raw 32-byte public key; the SPKI DER
 * wrapper is rebuilt locally (302a300506032b6570032100 || raw32) so no
 * PEM/DER plumbing is needed. Failures raise PluginSignatureError with a
 * stable snake_case code that verify.ts rethrows without information loss.
 */

import { createPublicKey, verify } from 'node:crypto';

export const PLUGIN_SIGNATURE_FILENAME = 'signature.json';
export const MAX_SIGNATURE_BYTES = 64 * 1024;

/** keyId → base64 raw 32-byte Ed25519 public key (admin-configured trust roots). */
export interface PluginTrustedPublishers {
  readonly [keyId: string]: string;
}

export class PluginSignatureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginSignatureError';
  }
}

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_RAW_KEY_BYTES = 32;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Node's base64 decoder is lenient (missing padding, whitespace); this is not. */
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_KEYS = ['algorithm', 'key_id', 'signature'] as const;

function fail(code: string, message: string): never {
  throw new PluginSignatureError(code, message);
}

/** Whether `name` is the archive-root signature file excluded from the declared file set. */
export function isPluginSignatureFile(name: string): boolean {
  return name === PLUGIN_SIGNATURE_FILENAME;
}

function isStrictBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && STRICT_BASE64_PATTERN.test(value);
}

export function verifyPluginSignature(input: {
  manifestRaw: Uint8Array;
  signatureRaw: Uint8Array;
  trustedPublishers: PluginTrustedPublishers;
}): { keyId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input.signatureRaw).toString('utf8'));
  } catch {
    fail('invalid_json', 'signature.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('invalid_signature_file', 'signature.json must be a single JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const recordKeys = Object.keys(record);
  if (recordKeys.length !== SIGNATURE_KEYS.length || !SIGNATURE_KEYS.every((key) => key in record)) {
    fail('invalid_signature_file', 'signature.json must have exactly the keys algorithm, key_id, signature');
  }
  if (record.algorithm !== 'ed25519') {
    fail('unsupported_algorithm', `unsupported signature algorithm "${String(record.algorithm)}"`);
  }
  const keyId = record.key_id;
  if (typeof keyId !== 'string' || keyId.length === 0 || keyId.length > 256) {
    fail('invalid_signature_file', 'key_id must be a non-empty string of at most 256 characters');
  }
  const signatureText = record.signature;
  if (typeof signatureText !== 'string' || !isStrictBase64(signatureText)) {
    fail('invalid_signature_file', 'signature must be strictly standard base64');
  }
  const signatureBuffer = Buffer.from(signatureText, 'base64');
  if (signatureBuffer.length !== ED25519_SIGNATURE_BYTES) {
    fail('invalid_signature_file', 'signature must decode to exactly 64 bytes');
  }

  const publisherKey = input.trustedPublishers[keyId];
  if (typeof publisherKey !== 'string' || publisherKey.length === 0) {
    fail('untrusted_publisher', `signature key_id "${keyId}" is not a trusted publisher`);
  }
  if (!isStrictBase64(publisherKey)) {
    fail('invalid_publisher_key', `trusted publisher "${keyId}" has a malformed public key`);
  }
  const rawPublicKey = Buffer.from(publisherKey, 'base64');
  if (rawPublicKey.length !== ED25519_RAW_KEY_BYTES) {
    fail('invalid_publisher_key', `trusted publisher "${keyId}" key must decode to exactly 32 bytes`);
  }

  let verified = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: 'der',
      type: 'spki',
    });
    verified = verify(null, input.manifestRaw, publicKey, signatureBuffer);
  } catch {
    verified = false;
  }
  if (!verified) {
    fail('invalid_signature', 'signature does not verify against the trusted publisher key');
  }
  return { keyId };
}
