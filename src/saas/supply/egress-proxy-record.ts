/**
 * R3 egress proxies (docs/token-resale-implementation-plan-2026-10-15.md
 * §R3): the pure record/URL layer shared by all three egress paths
 * (forwarding, OAuth refresh, probe). No KMS and no I/O live here.
 *
 * sub2api parity rules enforced by this module:
 * - Protocol whitelist {http, https, socks5, socks5h}; anything else is an
 *   error, never a downgrade to direct (an invalid proxy silently
 *   un-proxying an account would change its exit IP — the exact risk-control
 *   trigger this feature exists to prevent).
 * - socks5 auto-upgrades to socks5h so DNS resolution happens on the proxy
 *   side (remote DNS, anti-pollution — sub2api's proxyurl.Parse rule).
 * - Error messages NEVER contain the proxy URL or its credentials: every
 *   failure reports the field name only.
 * - Credentials exist in the assembled URL string for the lifetime of one
 *   dispatch and are never logged; redactSecrets masks the URL pattern as
 *   defense in depth.
 */

/** The wire protocols after the socks5 → socks5h upgrade. */
export type EgressProxyWireProtocol = 'http' | 'https' | 'socks5h';

export class EgressProxyRecordError extends Error {
  constructor(readonly code: 'INVALID_PROTOCOL' | 'INVALID_INPUT') {
    super(
      code === 'INVALID_PROTOCOL'
        ? 'egress proxy protocol is not in the whitelist (http, https, socks5, socks5h)'
        : 'egress proxy record input is invalid',
    );
    this.name = 'EgressProxyRecordError';
  }
}

/** Proxy credentials sealed through the provider-credential KMS envelope. */
export interface EgressProxyCredentials {
  readonly username?: string;
  readonly password?: string;
}

const MAX_CREDENTIAL_TEXT_BYTES = 256;
const MAX_HOST_BYTES = 255;
const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) {
    throw new EgressProxyRecordError('INVALID_INPUT');
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes || value !== value.trim()) {
    throw new EgressProxyRecordError('INVALID_INPUT');
  }
  return value;
}

/**
 * Validate a stored protocol and apply the socks5 → socks5h upgrade.
 * Unknown values fail closed; the error never echoes the input.
 */
export function normalizeEgressProxyProtocol(value: unknown): EgressProxyWireProtocol {
  if (typeof value !== 'string') throw new EgressProxyRecordError('INVALID_PROTOCOL');
  switch (value) {
    case 'http':
    case 'https':
      return value;
    case 'socks5':
    case 'socks5h':
      // Remote DNS: the destination hostname is sent to the proxy instead of
      // being resolved locally (sub2api's proxyurl.Parse upgrade rule).
      return 'socks5h';
    default:
      throw new EgressProxyRecordError('INVALID_PROTOCOL');
  }
}

/** Validate a proxy host (registerable name or IP literal; no brackets). */
export function normalizeEgressProxyHost(value: unknown): string {
  const host = text(value, MAX_HOST_BYTES);
  if (!HOST_PATTERN.test(host)) throw new EgressProxyRecordError('INVALID_INPUT');
  return host.toLowerCase();
}

/** Validate a proxy port. */
export function normalizeEgressProxyPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new EgressProxyRecordError('INVALID_INPUT');
  }
  return value;
}

/** Control characters (C0 + DEL) never appear in valid proxy credentials. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeCredentialText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value === '') throw new EgressProxyRecordError('INVALID_INPUT');
  if (hasControlCharacter(value) || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_TEXT_BYTES) {
    throw new EgressProxyRecordError('INVALID_INPUT');
  }
  return value;
}

/**
 * Assemble `protocol://[user:pass@]host:port`. The returned string carries
 * credentials percent-encoded in the userinfo component; it exists only for
 * the duration of one upstream dispatch and must never be logged. All
 * validation failures throw without including any input fragment.
 */
export function assembleEgressProxyUrl(input: {
  readonly protocol: unknown;
  readonly host: unknown;
  readonly port: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}): { readonly url: string; readonly protocol: EgressProxyWireProtocol } {
  if (!input || typeof input !== 'object') throw new EgressProxyRecordError('INVALID_INPUT');
  const protocol = normalizeEgressProxyProtocol(input.protocol);
  const host = normalizeEgressProxyHost(input.host);
  const port = normalizeEgressProxyPort(input.port);
  const username = normalizeCredentialText(input.username);
  const password = normalizeCredentialText(input.password);
  const userinfo = username === '' ? '' : `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@`;
  return { url: `${protocol}://${userinfo}${host}:${port}`, protocol };
}

/** Parse + validate a sealed-credentials payload (the envelope plaintext). */
export function parseEgressProxyCredentials(value: unknown): EgressProxyCredentials {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) throw new EgressProxyRecordError('INVALID_INPUT');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => key === 'username' || key === 'password')) {
    throw new EgressProxyRecordError('INVALID_INPUT');
  }
  return Object.freeze({
    ...(record.username === undefined ? {} : { username: normalizeCredentialText(record.username) }),
    ...(record.password === undefined ? {} : { password: normalizeCredentialText(record.password) }),
  });
}

/** Serialize credentials for sealing; the buffer must be wiped by the caller. */
export function encodeEgressProxyCredentials(credentials: EgressProxyCredentials): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parseEgressProxyCredentials(credentials)));
}
