import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, type Dispatcher } from 'undici';

export interface ProviderHttpResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ProviderHttpAddressResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ProviderHttpResolvedAddress[]>;

export interface ProviderHttpConnectorInput extends ProviderHttpResolvedAddress {
  readonly hostname: string;
  readonly port: number;
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

export const resolveProviderHttpAddresses: ProviderHttpAddressResolver = async (hostname, signal) => {
  if (signal.aborted) throw new Error('provider address resolution was aborted');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (signal.aborted) throw new Error('provider address resolution was aborted');
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export function selectPinnedProviderAddress(
  hostname: string,
  resolved: readonly ProviderHttpResolvedAddress[],
  testCapability?: ProviderHttpTestAddressCapability,
): ProviderHttpResolvedAddress {
  const literalFamily = isIP(hostname);
  const candidates = literalFamily ? [{ address: hostname, family: literalFamily as 4 | 6 }] : resolved;
  if (!Array.isArray(candidates) || candidates.length === 0) throw new ProviderHttpAddressPolicyError();

  const allowLoopback = isProviderHttpTestAddressCapability(testCapability) && isLoopbackProviderAddress(hostname);

  const validated = candidates.map((entry) => {
    const addressAllowed = allowLoopback
      ? entry?.address === hostname && isLoopbackProviderAddress(entry.address)
      : typeof entry?.address === 'string' && isGlobalProviderAddress(entry.address);
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
  return ({ hostname, address, family }) => {
    if (!isLoopbackProviderAddress(hostname) || hostname !== address) {
      throw new ProviderHttpAddressPolicyError();
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
}) => {
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
