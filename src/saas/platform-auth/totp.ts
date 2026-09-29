import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6 as const;
export const TOTP_PERIOD_SECONDS = 30 as const;
export const TOTP_WINDOW_STEPS = 1 as const;
export const TOTP_SECRET_BYTES = 20 as const;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map([...BASE32_ALPHABET].map((character, index) => [character, index]));

function invalidTotpInput(): Error {
  return new Error('Invalid TOTP input');
}

export function encodeBase32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(secret: string): Buffer {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 256) throw invalidTotpInput();
  const normalized = secret.replace(/[\s=-]/g, '').toUpperCase();
  if (
    !normalized ||
    normalized.length % 8 === 1 ||
    [...normalized].some((character) => !BASE32_LOOKUP.has(character))
  ) {
    throw invalidTotpInput();
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | (BASE32_LOOKUP.get(character) as number);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  if (bytes.length < 10 || bytes.length > 64) throw invalidTotpInput();
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES));
}

function counterForTime(timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) throw invalidTotpInput();
  return Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
}

function hotp(secretBytes: Uint8Array, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw invalidTotpInput();
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  counterBytes.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', secretBytes).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
  counterBytes.fill(0);
  digest.fill(0);
  return code;
}

/** Return the RFC 6238 six-digit code for the supplied Unix time in milliseconds. */
export function totpCode(secret: string, timeMs: number): string {
  const secretBytes = decodeBase32(secret);
  try {
    return hotp(secretBytes, counterForTime(timeMs));
  } finally {
    secretBytes.fill(0);
  }
}

/**
 * Verify a six-digit RFC 6238 code and return the matched time step. Every
 * candidate in the fixed ±1 window is compared with timingSafeEqual.
 */
export function verifyTotpCode(
  secret: string,
  suppliedCode: string,
  timeMs: number,
  windowSteps = TOTP_WINDOW_STEPS,
): number | undefined {
  if (!/^\d{6}$/.test(suppliedCode) || !Number.isInteger(windowSteps) || windowSteps < 0 || windowSteps > 2) {
    return undefined;
  }
  const secretBytes = decodeBase32(secret);
  try {
    const currentStep = counterForTime(timeMs);
    const supplied = Buffer.from(suppliedCode, 'ascii');
    let matchedStep: number | undefined;
    for (let delta = -windowSteps; delta <= windowSteps; delta += 1) {
      const step = currentStep + delta;
      if (step < 0) continue;
      const candidate = Buffer.from(hotp(secretBytes, step), 'ascii');
      const matches = candidate.length === supplied.length && timingSafeEqual(candidate, supplied);
      if (matches) matchedStep = step;
      candidate.fill(0);
    }
    supplied.fill(0);
    return matchedStep;
  } finally {
    secretBytes.fill(0);
  }
}

export function totpUri(secret: string, issuer: string, account: string): string {
  if (!secret || !issuer || !account) throw invalidTotpInput();
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
