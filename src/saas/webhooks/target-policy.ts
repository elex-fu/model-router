import { isIP } from 'node:net';

/** Structural validation only; the egress transport re-resolves and validates DNS on every send. */
export function normalizeCustomerWebhookTargetUrl(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 2048) {
    throw new TypeError('webhook target must be a bounded HTTPS URL');
  }
  if (!value.toLowerCase().startsWith('https://')) {
    throw new TypeError('webhook target must use HTTPS');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || value[index] === '\\') {
      throw new TypeError('webhook target contains disallowed URL characters');
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('webhook target must be a valid HTTPS URL');
  }
  const authority = /^https:\/\/([^/?#\\]*)/i.exec(value)?.[1];
  if (!authority || authority.includes('@') || authority.includes('%') || /\s/.test(authority)) {
    throw new TypeError('webhook target authority is invalid');
  }
  const rawHostname = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.slice(0, authority.lastIndexOf(':') > -1 ? authority.lastIndexOf(':') : authority.length);
  if (/^\d+(?:\.\d+)*\.?$/.test(rawHostname) && isIP(rawHostname) === 0) {
    throw new TypeError('webhook target contains an ambiguous IP address');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.search !== '' ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.hostname === ''
  ) {
    throw new TypeError('webhook target must use HTTPS on port 443 without userinfo, query, or fragment');
  }
  return parsed.toString();
}
