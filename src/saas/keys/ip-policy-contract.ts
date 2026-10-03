import { canonicalizeIpPolicy, type IpPolicyMode } from './ip-policy.js';

/** Positive PostgreSQL bigint encoded as canonical decimal text, never a JSON number. */
export type KeyIpPolicyVersion = string;

export interface KeyIpPolicyValue {
  readonly mode: IpPolicyMode;
  readonly rules: readonly string[];
}

/** Server-owned scope and revisions; no secret, digest, forwarding header, or proxy configuration. */
export interface KeyIpPolicySnapshot {
  readonly tenantId: string;
  readonly projectId: string;
  readonly keyId: string;
  readonly version: KeyIpPolicyVersion;
  /** Existing Key authorization revision, distinct from the IP policy revision. */
  readonly authzVersion: number;
  readonly policy: KeyIpPolicyValue;
}

/**
 * Full replacement only. Scope comes from authorized context/path, not this body.
 * A future writer must compare expectedVersion with the persisted head under
 * the existing authorization fences, atomically append/advance the policy and
 * invalidate Key authorization. Parsing alone does not perform CAS.
 */
export interface ReplaceKeyIpPolicyInput {
  readonly expectedVersion: KeyIpPolicyVersion;
  readonly policy: KeyIpPolicyValue;
}

function strictObject(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Expected a Key IP policy object');
  }
  const object = input as Record<string, unknown>;
  if (
    Object.keys(object).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(object, field))
  ) {
    throw new TypeError('Unexpected or missing Key IP policy field');
  }
  return object;
}

/** Validate a revision without lossy coercion or assigning an initial revision. */
export function parseKeyIpPolicyVersion(input: unknown): KeyIpPolicyVersion {
  if (
    typeof input !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(input) ||
    BigInt(input) > 9223372036854775807n
  ) {
    throw new TypeError('Invalid Key IP policy version');
  }
  return input;
}

/** Pure DTO boundary; retains the existing CIDR parser, limits, ordering and draft disabled rules. */
export function parseReplaceKeyIpPolicyInput(input: unknown): ReplaceKeyIpPolicyInput {
  const body = strictObject(input, ['expectedVersion', 'policy']);
  const expectedVersion = parseKeyIpPolicyVersion(body.expectedVersion);
  const policy = canonicalizeIpPolicy(strictObject(body.policy, ['mode', 'rules']));
  return { expectedVersion, policy };
}
