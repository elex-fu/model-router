import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, type buildConnector, type Dispatcher, ProxyAgent } from 'undici';
import { createSocks5HConnector } from './provider-http-socks5-connector.js';
import type { ProviderTlsFingerprintEgress } from './provider-http-tls-fingerprint-connector.js';

export interface ProviderHttpResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ProviderHttpAddressResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ProviderHttpResolvedAddress[]>;

/** A deployment-resolved egress proxy descriptor (URL carries credentials). */
export interface ProviderHttpEgressProxyDescriptor {
  /** The complete proxy URL, credentials included; it is never logged. */
  readonly url: string;
}

/** A validated, address-pinned egress proxy ready for a dispatcher. */
export interface ProviderHttpEgressProxyTarget {
  /** The normalized wire URL (socks5 upgraded to socks5h); never logged. */
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  /** The whitelist-validated pinned proxy address. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly protocol: 'http' | 'https' | 'socks5h';
  readonly username: string;
  readonly password: string;
}

export interface ProviderHttpConnectorInput extends ProviderHttpResolvedAddress {
  readonly hostname: string;
  readonly port: number;
  /** R3: when set, the connector tunnels through this egress proxy. */
  readonly proxy?: ProviderHttpEgressProxyTarget;
  /**
   * Batch-2 §2.4: when set, the connector dials through the TLS fingerprint
   * sidecar with this ClientHello profile (per-account egress mode, parallel
   * to the proxy above). Unset keeps the ordinary connector path.
   */
  readonly tlsFingerprint?: ProviderTlsFingerprintEgress;
}

export interface ProviderHttpPinnedConnector {
  readonly dispatcher: Dispatcher;
  close(): Promise<void>;
  destroy(error?: Error): Promise<void>;
}

export type ProviderHttpPinnedConnectorFactory = (input: ProviderHttpConnectorInput) => ProviderHttpPinnedConnector;

declare const providerHttpTestAddressCapabilityBrand: unique symbol;

/** Opaque capability used only by an explicitly configured test composition. */
export type ProviderHttpTestAddressCapability = {
  readonly [providerHttpTestAddressCapabilityBrand]: true;
};

const providerHttpTestAddressCapabilities = new WeakMap<object, { readonly ca: string }>();

/**
 * Mint a capability for a test-runner-owned local HTTPS target. NODE_ENV alone
 * is insufficient: the Node test runner marker and explicit injection are
 * both required, and the capability never comes from provider configuration.
 */
export function createProviderHttpTestAddressCapability(ca: string): ProviderHttpTestAddressCapability {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.NODE_TEST_CONTEXT === undefined ||
    typeof ca !== 'string' ||
    ca.length === 0 ||
    Buffer.byteLength(ca, 'utf8') > 64 * 1024 ||
    !ca.includes('-----BEGIN CERTIFICATE-----')
  ) {
    throw new Error('a test-runner CA is required to create the local provider HTTP capability');
  }
  const capability = Object.freeze(Object.create(null)) as ProviderHttpTestAddressCapability;
  providerHttpTestAddressCapabilities.set(capability, Object.freeze({ ca }));
  return capability;
}

export function isProviderHttpTestAddressCapability(value: unknown): value is ProviderHttpTestAddressCapability {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.NODE_TEST_CONTEXT !== undefined &&
    typeof value === 'object' &&
    value !== null &&
    providerHttpTestAddressCapabilities.has(value)
  );
}

export class ProviderHttpAddressPolicyError extends Error {
  constructor() {
    super('provider host did not resolve exclusively to public addresses');
    this.name = 'ProviderHttpAddressPolicyError';
  }
}

const IPV4_DENY_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '168.63.129.16/32',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]);

const IPV6_DENY_CIDRS = Object.freeze(['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', '5f00::/16']);

interface Ipv4Range {
  readonly network: number;
  readonly prefix: number;
}

interface Ipv6Range {
  readonly network: bigint;
  readonly prefix: number;
}

function ipv4Number(value: string): number | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((result, part) => result * 256 + part, 0) >>> 0;
}

function ipv6Number(value: string): bigint | null {
  if (isIP(value) !== 6 || value.includes('%')) return null;
  let normalized = value.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon < 0) return null;
    const embeddedIpv4 = ipv4Number(normalized.slice(lastColon + 1));
    if (embeddedIpv4 === null) return null;
    const high = ((embeddedIpv4 >>> 16) & 0xffff).toString(16);
    const low = (embeddedIpv4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : (halves[1] ?? '').split(':');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n);
}

function parseIpv4Range(value: string): Ipv4Range {
  const [networkText, prefixText] = value.split('/');
  const network = ipv4Number(networkText ?? '');
  const prefix = Number(prefixText);
  if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error('invalid built-in IPv4 policy range');
  }
  return { network, prefix };
}

function parseIpv6Range(value: string): Ipv6Range {
  const [networkText, prefixText] = value.split('/');
  const network = ipv6Number(networkText ?? '');
  const prefix = Number(prefixText);
  if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    throw new Error('invalid built-in IPv6 policy range');
  }
  return { network, prefix };
}

const IPV4_DENY_RANGES = IPV4_DENY_CIDRS.map(parseIpv4Range);
const IPV6_DENY_RANGES = IPV6_DENY_CIDRS.map(parseIpv6Range);
const IPV6_GLOBAL_UNICAST = parseIpv6Range('2000::/3');
const IPV6_IPV4_MAPPED = parseIpv6Range('::ffff:0:0/96');

function ipv4InRange(address: number, range: Ipv4Range): boolean {
  const mask = range.prefix === 0 ? 0 : (0xffff_ffff << (32 - range.prefix)) >>> 0;
  return (address & mask) === (range.network & mask);
}

function ipv6InRange(address: bigint, range: Ipv6Range): boolean {
  const shift = 128n - BigInt(range.prefix);
  return address >> shift === range.network >> shift;
}

export function isGlobalProviderAddress(address: string): address is string {
  const family = isIP(address);
  if (family === 4) {
    const numeric = ipv4Number(address);
    return numeric !== null && !IPV4_DENY_RANGES.some((range) => ipv4InRange(numeric, range));
  }
  if (family === 6) {
    const numeric = ipv6Number(address);
    return (
      numeric !== null &&
      ipv6InRange(numeric, IPV6_GLOBAL_UNICAST) &&
      !ipv6InRange(numeric, IPV6_IPV4_MAPPED) &&
      !IPV6_DENY_RANGES.some((range) => ipv6InRange(numeric, range))
    );
  }
  return false;
}

/** The test exception is restricted to the two canonical loopback literals. */
export function isLoopbackProviderAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1';
}

/** Composition guard: the operator egress allowlist is a narrow escape hatch, not a routing table. */
export const PROVIDER_HTTP_EGRESS_ALLOWLIST_MAX_ENTRIES = 32;

/** Safe error for every egress-allowlist validation failure; never carries operator input verbatim. */
export class ProviderHttpEgressAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderHttpEgressAllowlistError';
  }
}

/**
 * A validated operator egress allowlist (R9 §4 P1). Each entry is an explicit
 * CIDR network; a resolved provider address is dispatchable when it is global
 * (the default posture) or falls inside one of the entries. An empty
 * allowlist keeps the exact pre-R9 fail-closed behavior. Loopback, link-local,
 * and every other denied range requires the same explicit entry — there are
 * no implicit carve-outs.
 */
export interface ProviderHttpEgressAllowlist {
  /** The validated canonical CIDR entries, lowercased, in configuration order; safe to log. */
  readonly entries: readonly string[];
  /** True when the literal IP address falls inside one of the allowlist entries. */
  allows(address: string): boolean;
}

function parseProviderHttpEgressAllowlistEntry(entry: string): Ipv4Range | Ipv6Range {
  const slash = entry.indexOf('/');
  if (slash <= 0 || slash === entry.length - 1 || entry.indexOf('/', slash + 1) !== -1) {
    throw new ProviderHttpEgressAllowlistError('an egress allowlist entry must be an explicit CIDR network');
  }
  const networkText = entry.slice(0, slash);
  const prefixText = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) {
    throw new ProviderHttpEgressAllowlistError('an egress allowlist prefix must be a decimal number');
  }
  const prefix = Number(prefixText);
  // A /0 entry would re-open every destination at once; the allowlist is
  // deliberately not that knob — operators enumerate the ranges they need.
  if (prefix < 1) throw new ProviderHttpEgressAllowlistError('an egress allowlist entry cannot cover all addresses');
  const family = isIP(networkText);
  if (family === 4) {
    const network = ipv4Number(networkText);
    if (network === null || prefix > 32)
      throw new ProviderHttpEgressAllowlistError('the IPv4 egress allowlist entry is invalid');
    const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
    if ((network & mask) >>> 0 !== network) {
      throw new ProviderHttpEgressAllowlistError('an egress allowlist entry must be a canonical network address');
    }
    return { network, prefix };
  }
  if (family === 6) {
    const network = ipv6Number(networkText);
    if (network === null || prefix > 128)
      throw new ProviderHttpEgressAllowlistError('the IPv6 egress allowlist entry is invalid');
    const shift = 128n - BigInt(prefix);
    if ((network >> shift) << shift !== network) {
      throw new ProviderHttpEgressAllowlistError('an egress allowlist entry must be a canonical network address');
    }
    return { network, prefix };
  }
  throw new ProviderHttpEgressAllowlistError('an egress allowlist entry must be an IPv4 or IPv6 network');
}

/**
 * Strict factory for the operator egress allowlist: every entry must be an
 * explicit, canonical (host bits zero), non-/0 IPv4 or IPv6 CIDR network.
 * Any malformed, duplicated, or out-of-bounds entry throws — the allowlist
 * never silently drops or repairs operator input.
 */
export function createProviderHttpEgressAllowlist(entries: readonly string[]): ProviderHttpEgressAllowlist {
  if (!Array.isArray(entries)) {
    throw new ProviderHttpEgressAllowlistError('egress allowlist entries must be an array of CIDR strings');
  }
  if (entries.length > PROVIDER_HTTP_EGRESS_ALLOWLIST_MAX_ENTRIES) {
    throw new ProviderHttpEgressAllowlistError(
      `the egress allowlist accepts at most ${PROVIDER_HTTP_EGRESS_ALLOWLIST_MAX_ENTRIES} entries`,
    );
  }
  const ipv4: Ipv4Range[] = [];
  const ipv6: Ipv6Range[] = [];
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'string') {
      throw new ProviderHttpEgressAllowlistError('an egress allowlist entry must be a CIDR string');
    }
    const entry = raw.trim().toLowerCase();
    if (entry === '' || entry.length > 64) {
      throw new ProviderHttpEgressAllowlistError('an egress allowlist entry must be a bounded non-empty CIDR');
    }
    if (seen.has(entry)) throw new ProviderHttpEgressAllowlistError('an egress allowlist entry is duplicated');
    const range = parseProviderHttpEgressAllowlistEntry(entry);
    if (isIP(entry.slice(0, entry.indexOf('/'))) === 4) ipv4.push(range as Ipv4Range);
    else ipv6.push(range as Ipv6Range);
    seen.add(entry);
    canonical.push(entry);
  }
  return Object.freeze({
    entries: Object.freeze(canonical),
    allows: (address: string): boolean => {
      const family = isIP(address);
      if (family === 4) {
        const numeric = ipv4Number(address);
        return numeric !== null && ipv4.some((range) => ipv4InRange(numeric, range));
      }
      if (family === 6) {
        const numeric = ipv6Number(address);
        return numeric !== null && ipv6.some((range) => ipv6InRange(numeric, range));
      }
      return false;
    },
  });
}

export const resolveProviderHttpAddresses: ProviderHttpAddressResolver = async (hostname, signal) => {
  if (signal.aborted) throw new Error('provider address resolution was aborted');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (signal.aborted) throw new Error('provider address resolution was aborted');
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

/**
 * Fail-closed address pinning: the host must resolve exclusively to
 * dispatchable addresses. Dispatchable means globally routable (default) or
 * covered by an operator egress-allowlist entry; the test capability keeps
 * its own loopback-only exception. A mixed answer set is rejected as a whole.
 */
export function selectPinnedProviderAddress(
  hostname: string,
  resolved: readonly ProviderHttpResolvedAddress[],
  testCapability?: ProviderHttpTestAddressCapability,
  egressAllowlist?: ProviderHttpEgressAllowlist,
): ProviderHttpResolvedAddress {
  const literalFamily = isIP(hostname);
  const candidates = literalFamily ? [{ address: hostname, family: literalFamily as 4 | 6 }] : resolved;
  if (!Array.isArray(candidates) || candidates.length === 0) throw new ProviderHttpAddressPolicyError();

  const allowLoopback = isProviderHttpTestAddressCapability(testCapability) && isLoopbackProviderAddress(hostname);

  const validated = candidates.map((entry) => {
    const addressAllowed = allowLoopback
      ? entry?.address === hostname && isLoopbackProviderAddress(entry.address)
      : typeof entry?.address === 'string' &&
        (isGlobalProviderAddress(entry.address) || egressAllowlist?.allows(entry.address) === true);
    if (
      !entry ||
      typeof entry.address !== 'string' ||
      !addressAllowed ||
      (entry.family !== 4 && entry.family !== 6) ||
      isIP(entry.address) !== entry.family
    ) {
      throw new ProviderHttpAddressPolicyError();
    }
    return { address: entry.address, family: entry.family };
  });
  return validated[0] as ProviderHttpResolvedAddress;
}

export function createPinnedProviderLookup(hostname: string, address: ProviderHttpResolvedAddress) {
  return (
    requestedHostname: string,
    options: import('node:dns').LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      result: string | import('node:dns').LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (requestedHostname.toLowerCase() !== hostname.toLowerCase()) {
      const error = Object.assign(new Error('provider connector requested an unexpected hostname'), {
        code: 'EHOSTUNREACH',
      }) as NodeJS.ErrnoException;
      callback(error, options.all ? [] : '0.0.0.0');
      return;
    }
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}

/** A local HTTPS-only connector that retains the same address pinning as production. */
export function createPinnedProviderHttpTestConnectorFactory(
  capability: ProviderHttpTestAddressCapability,
): ProviderHttpPinnedConnectorFactory {
  if (!isProviderHttpTestAddressCapability(capability)) {
    throw new Error('the local provider HTTP connector requires a test-runner capability');
  }
  const trustedCa = providerHttpTestAddressCapabilities.get(capability)?.ca;
  if (!trustedCa) throw new Error('the local provider HTTP connector requires a test CA');
  return ({ hostname, address, family, proxy }) => {
    if (!isLoopbackProviderAddress(hostname) || hostname !== address) {
      throw new ProviderHttpAddressPolicyError();
    }
    if (proxy !== undefined) {
      return createEgressProxyDispatcher(proxy, {
        requestTls: { lookup: createPinnedProviderLookup(hostname, { address, family }), ca: trustedCa },
      });
    }
    const agent = new Agent({
      connect: {
        lookup: createPinnedProviderLookup(hostname, { address, family }),
        ca: trustedCa,
      },
      connections: 1,
      maxRedirections: 0,
    });
    return {
      dispatcher: agent,
      close: () => agent.close(),
      destroy: (error) => agent.destroy(error ?? null),
    };
  };
}

export const createPinnedProviderHttpConnector: ProviderHttpPinnedConnectorFactory = ({
  hostname,
  address,
  family,
  proxy,
}) => {
  if (proxy !== undefined) {
    // The destination TLS upgrade happens over the tunnel socket (no local
    // DNS), but the pinned lookup is still attached to requestTls so any
    // undici code path that would resolve the destination locally stays
    // pinned to the validated address.
    return createEgressProxyDispatcher(proxy, {
      requestTls: { lookup: createPinnedProviderLookup(hostname, { address, family }) },
    });
  }
  const agent = new Agent({
    connect: { lookup: createPinnedProviderLookup(hostname, { address, family }) },
    connections: 1,
    maxRedirections: 0,
  });
  return {
    dispatcher: agent,
    close: () => agent.close(),
    destroy: (error) => agent.destroy(error ?? null),
  };
};

/**
 * R3 egress proxies: validate a proxy URL (protocol whitelist, socks5 →
 * socks5h upgrade, bounded host/port, no path/query/hash) without ever
 * including the URL in an error message. Percent-encoded userinfo is kept
 * encoded; ProxyAgent decodes it for the Basic auth header and the socks
 * connector decodes it for RFC 1929.
 */
export function validateEgressProxyUrl(value: unknown): {
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly protocol: 'http' | 'https' | 'socks5h';
  readonly username: string;
  readonly password: string;
} {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.includes('\u0000')) {
    throw new ProviderHttpEgressProxyError();
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderHttpEgressProxyError();
  }
  const protocol = parsed.protocol.toLowerCase();
  const wireProtocol =
    protocol === 'http:'
      ? 'http'
      : protocol === 'https:'
        ? 'https'
        : protocol === 'socks5:' || protocol === 'socks5h:'
          ? 'socks5h'
          : null;
  if (wireProtocol === null) throw new ProviderHttpEgressProxyError();
  // Non-special schemes (socks5/socks5h) parse with an empty path; http/https
  // parse with '/'. Both mean "no path component"; anything else is invalid.
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') {
    throw new ProviderHttpEgressProxyError();
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '' || hostname.includes('%') || hostname.length > 255 || hostname.startsWith('[')) {
    throw new ProviderHttpEgressProxyError();
  }
  const port = parsed.port === '' ? (wireProtocol === 'https' ? 443 : 80) : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new ProviderHttpEgressProxyError();
  // Rebuild under the wire protocol so socks5:// becomes socks5h:// and the
  // port is always explicit (URL serialization drops default ports).
  const userinfo = parsed.username === '' ? '' : `${parsed.username}:${parsed.password}@`;
  return {
    url: `${wireProtocol}://${userinfo}${hostname}:${port}`,
    hostname,
    port,
    protocol: wireProtocol,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

/**
 * Validate a proxy descriptor and pin its host address through the same
 * whitelist mechanism as provider endpoints: literal IPs must be global
 * (loopback only under the test capability), names must resolve exclusively
 * to global addresses, and exactly one address is pinned to close the
 * rebinding window between validation and connection.
 */
export async function resolveEgressProxyTarget(
  proxy: ProviderHttpEgressProxyDescriptor,
  options: {
    readonly resolveAddresses: ProviderHttpAddressResolver;
    readonly testCapability?: ProviderHttpTestAddressCapability;
    /** R9 §4 P1: operator-configured CIDR entries that also permit otherwise-denied proxy addresses. */
    readonly egressAllowlist?: ProviderHttpEgressAllowlist;
    readonly signal?: AbortSignal;
  },
): Promise<ProviderHttpEgressProxyTarget> {
  const validated = validateEgressProxyUrl(proxy?.url);
  let resolved: readonly ProviderHttpResolvedAddress[] = [];
  if (isIP(validated.hostname) === 0) {
    try {
      resolved = await options.resolveAddresses(validated.hostname, options.signal ?? new AbortController().signal);
    } catch {
      throw new ProviderHttpEgressProxyError();
    }
  }
  let pinned: ProviderHttpResolvedAddress;
  try {
    pinned = selectPinnedProviderAddress(validated.hostname, resolved, options.testCapability, options.egressAllowlist);
  } catch {
    throw new ProviderHttpEgressProxyError();
  }
  return {
    url: validated.url,
    hostname: validated.hostname,
    port: validated.port,
    address: pinned.address,
    family: pinned.family,
    protocol: validated.protocol,
    username: validated.username,
    password: validated.password,
  };
}

/** Safe error for every egress-proxy validation failure; never carries the URL. */
export class ProviderHttpEgressProxyError extends Error {
  constructor() {
    super('the egress proxy configuration is invalid');
    this.name = 'ProviderHttpEgressProxyError';
  }
}

/**
 * Build the per-request dispatcher for one validated egress proxy.
 *
 * http/https proxies use undici's ProxyAgent with CONNECT tunneling: the
 * proxy's own connection is pinned to the whitelist-validated address via
 * proxyTls.lookup, and connections: 1 keeps the per-request short-lived
 * dispatcher semantics (the inner Agent collapses to a single Client).
 * socks5h proxies use the dedicated RFC 1928/1929 connector — the domain is
 * sent to the proxy, so destination DNS happens remotely by construction.
 */
export function createEgressProxyDispatcher(
  target: ProviderHttpEgressProxyTarget,
  options: {
    /** Destination TLS options (pinned lookup in the transport; test CA in tests). */
    readonly requestTls?: buildConnector.BuildOptions;
  } = {},
): ProviderHttpPinnedConnector {
  if (target.protocol === 'socks5h') {
    const destinationCa = (options.requestTls as { readonly ca?: unknown } | undefined)?.ca;
    const agent = new Agent({
      connect: createSocks5HConnector({
        address: target.address,
        family: target.family,
        port: target.port,
        ...(target.username === '' ? {} : { username: target.username, password: target.password }),
        ...(typeof destinationCa === 'string' ? { tlsOptions: { ca: destinationCa } } : {}),
      }),
      connections: 1,
      maxRedirections: 0,
    });
    return {
      dispatcher: agent,
      close: () => agent.close(),
      destroy: (error) => agent.destroy(error ?? null),
    };
  }
  const agent = new ProxyAgent({
    uri: target.url,
    connections: 1,
    maxRedirections: 0,
    // Pin the proxy's own connection to the validated address.
    proxyTls: {
      lookup: createPinnedProviderLookup(target.hostname, { address: target.address, family: target.family }),
    },
    ...(options.requestTls === undefined ? {} : { requestTls: options.requestTls }),
  });
  return {
    dispatcher: agent,
    close: () => agent.close(),
    destroy: (error) => agent.destroy(error ?? null),
  };
}

/**
 * One-shot async egress connection used by the non-transport paths (OAuth
 * refresh worker, probe worker): validate + pin the proxy, build the
 * dispatcher. The caller must close/destroy the returned connector when its
 * requests complete; the URL never outlives the call site.
 */
export async function createProviderEgressProxyConnection(
  proxy: ProviderHttpEgressProxyDescriptor,
  options: {
    readonly resolveAddresses?: ProviderHttpAddressResolver;
    readonly testCapability?: ProviderHttpTestAddressCapability;
    readonly egressAllowlist?: ProviderHttpEgressAllowlist;
    readonly signal?: AbortSignal;
    readonly requestTls?: buildConnector.BuildOptions;
  } = {},
): Promise<ProviderHttpPinnedConnector> {
  const target = await resolveEgressProxyTarget(proxy, {
    resolveAddresses: options.resolveAddresses ?? resolveProviderHttpAddresses,
    ...(options.testCapability === undefined ? {} : { testCapability: options.testCapability }),
    ...(options.egressAllowlist === undefined ? {} : { egressAllowlist: options.egressAllowlist }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return createEgressProxyDispatcher(
    target,
    options.requestTls === undefined ? {} : { requestTls: options.requestTls },
  );
}
