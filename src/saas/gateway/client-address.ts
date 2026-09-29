import { canonicalizeIpCidr, canonicalizeIpPolicy, isIpAllowed } from '../keys/ip-policy.js';

export type ClientAddressUnresolvedReason =
  | 'invalid-socket-peer'
  | 'invalid-trusted-proxy-config'
  | 'missing-forwarded-address'
  | 'ambiguous-forwarded-header'
  | 'forwarded-header-too-large'
  | 'too-many-forwarded-hops'
  | 'malformed-forwarded-address'
  | 'all-forwarded-hops-trusted';

export type ClientAddressResolution =
  | {
      readonly status: 'resolved';
      readonly address: string;
      readonly source: 'socket-peer' | 'x-forwarded-for';
    }
  | {
      readonly status: 'unresolved';
      readonly reason: ClientAddressUnresolvedReason;
    };

const MAX_FORWARDED_HOPS = 20;
const MAX_FORWARDED_HEADER_LENGTH = 2048;

function unresolved(reason: ClientAddressUnresolvedReason): ClientAddressResolution {
  return { status: 'unresolved', reason };
}

function normalizeAddress(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.includes('/')) return undefined;

  try {
    const cidr = canonicalizeIpCidr(input);
    return cidr.slice(0, cidr.lastIndexOf('/'));
  } catch {
    return undefined;
  }
}

function isTrustedProxy(address: string, policy: unknown): boolean {
  return isIpAllowed(address, policy);
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, '');
}

/**
 * Resolve the client address without trusting forwarding headers unless the
 * socket peer is explicitly configured as a trusted proxy.
 */
export function resolveClientAddress(
  socketPeer: string,
  xForwardedFor: string | readonly string[] | undefined,
  trustedProxyCidrs: readonly string[],
): ClientAddressResolution {
  const peerAddress = normalizeAddress(socketPeer);
  if (peerAddress === undefined) return unresolved('invalid-socket-peer');

  if (!Array.isArray(trustedProxyCidrs)) return unresolved('invalid-trusted-proxy-config');
  if (trustedProxyCidrs.length === 0) {
    return { status: 'resolved', address: peerAddress, source: 'socket-peer' };
  }

  let trustedProxyPolicy: unknown;
  try {
    trustedProxyPolicy = canonicalizeIpPolicy({ mode: 'allowlist', rules: trustedProxyCidrs });
  } catch {
    return unresolved('invalid-trusted-proxy-config');
  }

  if (!isTrustedProxy(peerAddress, trustedProxyPolicy)) {
    return { status: 'resolved', address: peerAddress, source: 'socket-peer' };
  }

  if (xForwardedFor === undefined) return unresolved('missing-forwarded-address');

  let rawHeader: string;
  if (typeof xForwardedFor === 'string') {
    rawHeader = xForwardedFor;
  } else if (Array.isArray(xForwardedFor)) {
    // Repeated XFF field values have no single unambiguous chain at this boundary.
    if (xForwardedFor.length !== 1 || typeof xForwardedFor[0] !== 'string') {
      return unresolved('ambiguous-forwarded-header');
    }
    rawHeader = xForwardedFor[0];
  } else {
    return unresolved('malformed-forwarded-address');
  }

  if (rawHeader.length > MAX_FORWARDED_HEADER_LENGTH) {
    return unresolved('forwarded-header-too-large');
  }

  const forwardedValues = rawHeader.split(',');
  if (forwardedValues.length > MAX_FORWARDED_HOPS) {
    return unresolved('too-many-forwarded-hops');
  }

  const forwardedAddresses: string[] = [];
  for (const value of forwardedValues) {
    const address = normalizeAddress(trimOws(value));
    if (address === undefined) return unresolved('malformed-forwarded-address');
    forwardedAddresses.push(address);
  }

  for (let index = forwardedAddresses.length - 1; index >= 0; index -= 1) {
    const address = forwardedAddresses[index];
    if (!isTrustedProxy(address, trustedProxyPolicy)) {
      return { status: 'resolved', address, source: 'x-forwarded-for' };
    }
  }

  return unresolved('all-forwarded-hops-trusted');
}
