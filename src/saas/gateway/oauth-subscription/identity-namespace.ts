import { createHash } from 'node:crypto';

/**
 * Shared OAuth-subscription identity namespace helpers (R5 step 1, design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Extracted from the
 * codex package (gateway/codex/identity.ts) without any behavior change: the
 * per-account identity namespace and the deterministic UUIDv4 derivation are
 * category-agnostic — only the namespace string and the derivation-domain
 * prefix differ per provider, and both are caller-supplied.
 *
 * - `isolateSessionId` implements the mandatory per-account identity
 *   namespace: the same raw client session id hashes to a different 8-hex
 *   identifier under every (proxy key, account namespace) pair.
 * - `deriveStableUUIDv4` provides deterministic, spec-shaped UUIDv4 values
 *   from a persisted per-account seed; the caller's namespace prefix keeps
 *   derivation domains disjoint.
 *
 * The codex package re-exports these behind its original (validating)
 * wrappers so its observable behavior stays byte-identical; the Claude
 * category package consumes them directly.
 */

export type IdentityNamespaceErrorCode = 'MALFORMED_INPUT';

export class IdentityNamespaceError extends Error {
  constructor(readonly code: IdentityNamespaceErrorCode) {
    super('identity namespace input is malformed');
    this.name = 'IdentityNamespaceError';
  }
}

/** SHA-256 of a UTF-8 string as lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Namespaced session identifier: first 8 hex characters of
 * `sha256("u{keyId}:a{namespace}:{raw}")`. Equal raw ids collide only when
 * both the proxy key and the account namespace match, which is exactly the
 * failover isolation guarantee the scheduler relies on.
 */
export function isolateSessionId(keyId: string, namespace: string, raw: string): string {
  if (
    typeof keyId !== 'string' ||
    keyId.length === 0 ||
    typeof namespace !== 'string' ||
    namespace.length === 0 ||
    typeof raw !== 'string'
  ) {
    throw new IdentityNamespaceError('MALFORMED_INPUT');
  }
  return sha256Hex(`u${keyId}:a${namespace}:${raw}`).slice(0, 8);
}

/**
 * Deterministic UUIDv4 from an arbitrary string: SHA-256 digest forced onto
 * the RFC 4122 version-4/variant-1 grid. Same input always produces the same
 * UUID; the caller's namespace prefixes keep derivation domains disjoint.
 */
export function deriveStableUUIDv4(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new IdentityNamespaceError('MALFORMED_INPUT');
  const hex = sha256Hex(input).slice(0, 32);
  const chars = hex.split('');
  chars[12] = '4';
  chars[16] = '89ab'[Number.parseInt(hex[16], 16) & 3];
  const joined = chars.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}
