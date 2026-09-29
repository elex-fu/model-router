/** The supported per-Key IP policy modes. */
export type IpPolicyMode = 'disabled' | 'allowlist';

/** A validated, canonical IP policy. Rules always include an explicit prefix. */
export interface IpPolicy {
  mode: IpPolicyMode;
  rules: string[];
}

interface ParsedAddress {
  version: 4 | 6;
  bits: 32 | 128;
  value: bigint;
}

interface ParsedNetwork extends ParsedAddress {
  prefix: number;
}

const MAX_RULES = 256;
const IPV4_MASK = (1n << 32n) - 1n;
const IPV6_MASK = (1n << 128n) - 1n;
const IPV4_MAPPED_PREFIX = 0xffffn << 32n;
const IPV4_MAPPED_END = IPV4_MAPPED_PREFIX | IPV4_MASK;

function invalid(message: string): never {
  throw new TypeError(message);
}

function parseIPv4(input: string): bigint {
  const octets = input.split('.');
  if (octets.length !== 4) return invalid('Invalid IPv4 literal');

  let value = 0n;
  for (const octet of octets) {
    if (!/^(0|[1-9][0-9]*)$/.test(octet)) return invalid('Invalid IPv4 octet');
    const number = Number(octet);
    if (number > 255) return invalid('IPv4 octet is out of range');
    value = (value << 8n) | BigInt(number);
  }
  return value;
}

function parseIPv6(input: string): bigint {
  if (input.length === 0 || input.includes('%') || input.includes('[') || input.includes(']')) {
    return invalid('Invalid IPv6 literal');
  }

  let expanded = input;
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    if (lastColon < 0) return invalid('Embedded IPv4 must be in an IPv6 literal');
    const ipv4 = parseIPv4(expanded.slice(lastColon + 1));
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    expanded = `${expanded.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const compressionIndex = expanded.indexOf('::');
  let words: string[];
  if (compressionIndex >= 0) {
    if (expanded.indexOf('::', compressionIndex + 2) >= 0) return invalid('IPv6 may contain only one ::');
    const leftText = expanded.slice(0, compressionIndex);
    const rightText = expanded.slice(compressionIndex + 2);
    const left = leftText === '' ? [] : leftText.split(':');
    const right = rightText === '' ? [] : rightText.split(':');
    const explicit = [...left, ...right];
    if (explicit.length >= 8) return invalid('IPv6 :: must compress at least one word');
    words = [...left, ...Array(8 - explicit.length).fill('0'), ...right];
  } else {
    words = expanded.split(':');
    if (words.length !== 8) return invalid('IPv6 literal must contain eight words');
  }

  if (words.length !== 8 || words.some((word) => !/^[0-9a-fA-F]{1,4}$/.test(word))) {
    return invalid('Invalid IPv6 word');
  }

  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function parseAddress(input: unknown): ParsedAddress {
  if (typeof input !== 'string' || input.length === 0 || input.includes('/')) {
    return invalid('Expected an IP address literal');
  }

  if (input.includes(':')) {
    const value = parseIPv6(input);
    return { version: 6, bits: 128, value };
  }

  return { version: 4, bits: 32, value: parseIPv4(input) };
}

function parsePeerAddress(input: unknown): ParsedAddress {
  const address = parseAddress(input);
  if (address.version === 6 && (address.value >> 32n) === 0xffffn) {
    return { version: 4, bits: 32, value: address.value & IPV4_MASK };
  }
  return address;
}

function prefixMask(bits: 32 | 128, prefix: number): bigint {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

function parseNetwork(input: unknown): ParsedNetwork {
  if (typeof input !== 'string' || input.length === 0) return invalid('Expected an IP literal or CIDR');

  const slash = input.indexOf('/');
  if (slash !== input.lastIndexOf('/')) return invalid('CIDR may contain only one slash');
  const addressText = slash < 0 ? input : input.slice(0, slash);
  const address = parseAddress(addressText);
  let prefix = address.bits === 32 ? 32 : 128;

  if (slash >= 0) {
    const prefixText = input.slice(slash + 1);
    if (!/^(0|[1-9][0-9]*)$/.test(prefixText)) return invalid('Invalid CIDR prefix');
    prefix = Number(prefixText);
    if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > address.bits) {
      return invalid('CIDR prefix is out of range');
    }
  }

  if (address.version === 4) {
    const mask = prefixMask(32, prefix);
    return { ...address, value: address.value & mask, prefix };
  }

  if ((address.value >> 32n) === 0xffffn) {
    if (prefix < 96) return invalid('IPv4-mapped IPv6 CIDRs must use a /96..128 prefix');
    const mappedPrefix = prefix - 96;
    const mappedValue = address.value & IPV4_MASK;
    return {
      version: 4,
      bits: 32,
      value: mappedValue & prefixMask(32, mappedPrefix),
      prefix: mappedPrefix,
    };
  }

  const mask = prefixMask(128, prefix);
  return { ...address, value: address.value & mask, prefix };
}

function formatIPv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn).toString(10))
    .join('.');
}

function formatIPv6(value: bigint): string {
  const words = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn),
  );

  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < words.length; ) {
    if (words[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end += 1;
    const length = end - start;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
    start = end;
  }

  const rendered = words.map((word) => word.toString(16));
  if (bestStart < 0) return rendered.join(':');
  const left = rendered.slice(0, bestStart).join(':');
  const right = rendered.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

function formatNetwork(network: ParsedNetwork): string {
  const address = network.version === 4 ? formatIPv4(network.value) : formatIPv6(network.value);
  return `${address}/${network.prefix}`;
}

/** Parse one strict IP literal/CIDR, mask host bits, and return canonical CIDR text. */
export function canonicalizeIpCidr(input: unknown): string {
  return formatNetwork(parseNetwork(input));
}

/** Validate and canonicalize a policy. Duplicate rules are removed before sorting. */
export function canonicalizeIpPolicy(input: unknown): IpPolicy {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('Expected an IP policy object');
  }

  const candidate = input as { mode?: unknown; rules?: unknown };
  if (candidate.mode !== 'disabled' && candidate.mode !== 'allowlist') {
    return invalid('IP policy mode must be disabled or allowlist');
  }
  if (!Array.isArray(candidate.rules)) return invalid('IP policy rules must be an array');
  if (candidate.rules.length > MAX_RULES) return invalid(`IP policy may contain at most ${MAX_RULES} rules`);
  if (candidate.rules.some((rule) => typeof rule !== 'string')) {
    return invalid('Every IP policy rule must be a string');
  }
  if (candidate.mode === 'allowlist' && candidate.rules.length === 0) {
    return invalid('An allowlist requires at least one rule');
  }

  const networks = candidate.rules.map(parseNetwork);
  networks.sort((left, right) => {
    if (left.version !== right.version) return left.version - right.version;
    if (left.value !== right.value) return left.value < right.value ? -1 : 1;
    return left.prefix - right.prefix;
  });

  const rules: string[] = [];
  let previous: string | undefined;
  for (const network of networks) {
    const rule = formatNetwork(network);
    if (rule !== previous) rules.push(rule);
    previous = rule;
  }

  return { mode: candidate.mode, rules };
}

function networkContains(network: ParsedNetwork, address: ParsedAddress): boolean {
  if (network.version !== address.version) return false;
  return (address.value & prefixMask(network.bits, network.prefix)) === network.value;
}

/** Return false for malformed addresses or policies; disabled policies allow valid policy objects. */
export function isIpAllowed(address: unknown, policy: unknown): boolean {
  let normalized: IpPolicy;
  let peer: ParsedAddress;
  try {
    normalized = canonicalizeIpPolicy(policy);
    if (typeof address !== 'string' || address.includes('/')) return false;
    peer = parsePeerAddress(address);
  } catch {
    return false;
  }

  if (normalized.mode === 'disabled') return true;
  return normalized.rules.some((rule) => networkContains(parseNetwork(rule), peer));
}
