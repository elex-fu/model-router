import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TotpHashAlgorithm = 'sha1' | 'sha256' | 'sha512';
export type TotpDigits = 6 | 8;

export interface TotpOptions {
  readonly algorithm?: TotpHashAlgorithm;
  readonly digits?: TotpDigits;
  readonly stepSeconds?: number;
}

export interface TotpVerificationOptions extends TotpOptions {
  readonly windowSteps?: number;
}

export const TOTP_DEFAULT_ALGORITHM = 'sha1' as const;
export const TOTP_DEFAULT_DIGITS = 6 as const;
export const TOTP_DEFAULT_STEP_SECONDS = 30 as const;
export const TOTP_DEFAULT_WINDOW_STEPS = 1 as const;
export const TOTP_DEFAULT_SECRET_BYTES = 20 as const;
export const TOTP_MIN_SECRET_BYTES = 16 as const;
export const TOTP_MAX_SECRET_BYTES = 64 as const;

// Short aliases make the defaults convenient for callers migrating from older TOTP helpers.
export const TOTP_DIGITS = TOTP_DEFAULT_DIGITS;
export const TOTP_PERIOD_SECONDS = TOTP_DEFAULT_STEP_SECONDS;
export const TOTP_WINDOW_STEPS = TOTP_DEFAULT_WINDOW_STEPS;
export const TOTP_SECRET_BYTES = TOTP_DEFAULT_SECRET_BYTES;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map([...BASE32_ALPHABET].map((character, index) => [character, index]));
const MAX_BASE32_INPUT_LENGTH = 1024;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const MAX_VERIFICATION_WINDOW_STEPS = 10;

interface ResolvedTotpOptions {
  readonly algorithm: TotpHashAlgorithm;
  readonly digits: TotpDigits;
  readonly stepSeconds: number;
}

function invalidInput(message: string): TypeError {
  return new TypeError(`Invalid TOTP input: ${message}`);
}

function invalidRange(message: string): RangeError {
  return new RangeError(`Invalid TOTP input: ${message}`);
}

function optionsRecord(options: unknown): Record<string, unknown> {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidInput('options must be an object');
  }
  return options as Record<string, unknown>;
}

function resolveOptions(options?: TotpOptions): ResolvedTotpOptions {
  const input = optionsRecord(options);
  const algorithm = input.algorithm === undefined ? TOTP_DEFAULT_ALGORITHM : input.algorithm;
  const digits = input.digits === undefined ? TOTP_DEFAULT_DIGITS : input.digits;
  const stepSeconds = input.stepSeconds === undefined ? TOTP_DEFAULT_STEP_SECONDS : input.stepSeconds;

  if (typeof algorithm !== 'string' || !['sha1', 'sha256', 'sha512'].includes(algorithm)) {
    throw invalidInput('algorithm must be sha1, sha256, or sha512');
  }
  if (typeof digits !== 'number' || !Number.isInteger(digits) || (digits !== 6 && digits !== 8)) {
    throw invalidInput('digits must be 6 or 8');
  }
  if (
    typeof stepSeconds !== 'number' ||
    !Number.isSafeInteger(stepSeconds) ||
    stepSeconds < 1 ||
    stepSeconds > 86_400
  ) {
    throw invalidRange('stepSeconds must be an integer between 1 and 86400');
  }

  return {
    algorithm: algorithm as TotpHashAlgorithm,
    digits: digits as TotpDigits,
    stepSeconds,
  };
}

function resolveWindowSteps(options: unknown): number {
  const input = optionsRecord(options);
  const windowSteps = input.windowSteps === undefined ? TOTP_DEFAULT_WINDOW_STEPS : input.windowSteps;
  if (
    typeof windowSteps !== 'number' ||
    !Number.isSafeInteger(windowSteps) ||
    windowSteps < 0 ||
    windowSteps > MAX_VERIFICATION_WINDOW_STEPS
  ) {
    throw invalidRange(`windowSteps must be an integer between 0 and ${MAX_VERIFICATION_WINDOW_STEPS}`);
  }
  return windowSteps;
}

function encodeUriComponent(value: string): string {
  // encodeURIComponent leaves these RFC 3986 reserved characters unescaped.
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode bytes as canonical, unpadded RFC 4648 Base32. */
export function encodeBase32(input: Uint8Array, padded = false): string {
  if (!(input instanceof Uint8Array)) throw invalidInput('Base32 input must be a byte array');
  if (typeof padded !== 'boolean') throw invalidInput('Base32 padding flag must be boolean');

  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
    if (bits > 0) buffer &= (1 << bits) - 1;
    else buffer = 0;
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  if (padded && output.length % 8 !== 0) output += '='.repeat(8 - (output.length % 8));
  return output;
}

/** Decode strict RFC 4648 Base32, accepting either canonical padding or no padding. */
export function decodeBase32(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw invalidInput('Base32 secret must be non-empty');
  if (value.length > MAX_BASE32_INPUT_LENGTH) throw invalidInput('Base32 secret is too long');

  const paddingIndex = value.indexOf('=');
  const symbols = paddingIndex === -1 ? value : value.slice(0, paddingIndex);
  const padding = paddingIndex === -1 ? '' : value.slice(paddingIndex);
  const normalizedSymbols = symbols.toUpperCase();

  if (!/^[A-Z2-7]+$/.test(normalizedSymbols) || (padding.length > 0 && !/^=+$/.test(padding))) {
    throw invalidInput('Base32 secret contains invalid characters');
  }

  const remainder = normalizedSymbols.length % 8;
  if ([1, 3, 6].includes(remainder)) throw invalidInput('Base32 secret has invalid length');
  const expectedPadding = (8 - remainder) % 8;
  if (padding.length !== 0 && padding.length !== expectedPadding) {
    throw invalidInput('Base32 secret has invalid padding');
  }
  if (padding.length !== 0 && (symbols.length + padding.length) % 8 !== 0) {
    throw invalidInput('Base32 secret has invalid padding');
  }

  const result = Buffer.alloc(Math.floor((normalizedSymbols.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let resultIndex = 0;
  for (const character of normalizedSymbols) {
    buffer = (buffer << 5) | (BASE32_LOOKUP.get(character) as number);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result[resultIndex] = (buffer >>> bits) & 0xff;
      resultIndex += 1;
      buffer = bits === 0 ? 0 : buffer & ((1 << bits) - 1);
    }
  }
  if (bits > 0 && buffer !== 0) {
    result.fill(0);
    throw invalidInput('Base32 secret has non-zero trailing bits');
  }
  return result;
}

/** Decode and validate a secret for HOTP/TOTP use. The returned buffer belongs to the caller. */
export function decodeTotpSecret(secret: string): Buffer {
  const decoded = decodeBase32(secret);
  if (decoded.length < TOTP_MIN_SECRET_BYTES || decoded.length > TOTP_MAX_SECRET_BYTES) {
    decoded.fill(0);
    throw invalidRange(`secret must decode to between ${TOTP_MIN_SECRET_BYTES} and ${TOTP_MAX_SECRET_BYTES} bytes`);
  }
  return decoded;
}

/** Generate a cryptographically random, canonical Base32 TOTP secret. */
export function generateTotpSecret(secretBytes = TOTP_DEFAULT_SECRET_BYTES): string {
  if (
    typeof secretBytes !== 'number' ||
    !Number.isSafeInteger(secretBytes) ||
    secretBytes < TOTP_MIN_SECRET_BYTES ||
    secretBytes > TOTP_MAX_SECRET_BYTES
  ) {
    throw invalidRange(`secretBytes must be an integer between ${TOTP_MIN_SECRET_BYTES} and ${TOTP_MAX_SECRET_BYTES}`);
  }
  return encodeBase32(randomBytes(secretBytes));
}

function normalizeCounter(counter: number | bigint): bigint {
  let normalized: bigint;
  if (typeof counter === 'bigint') {
    normalized = counter;
  } else {
    if (!Number.isSafeInteger(counter)) throw invalidInput('counter must be a safe integer');
    normalized = BigInt(counter);
  }
  if (normalized < 0n || normalized > MAX_UINT64) throw invalidRange('counter must fit in an unsigned 64-bit integer');
  return normalized;
}

function copySecret(secret: string | Uint8Array): Buffer {
  if (typeof secret === 'string') return decodeTotpSecret(secret);
  if (!(secret instanceof Uint8Array)) throw invalidInput('secret must be a Base32 string or byte array');
  if (secret.byteLength < TOTP_MIN_SECRET_BYTES || secret.byteLength > TOTP_MAX_SECRET_BYTES) {
    throw invalidRange(`secret must contain between ${TOTP_MIN_SECRET_BYTES} and ${TOTP_MAX_SECRET_BYTES} bytes`);
  }
  return Buffer.from(secret);
}

function hotpFromBytes(secret: Uint8Array, counter: bigint, options: ResolvedTotpOptions): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const digest = createHmac(options.algorithm, secret).update(counterBytes).digest();
  try {
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
      (((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff)) >>>
      0;
    const code = binary % 10 ** options.digits;
    return String(code).padStart(options.digits, '0');
  } finally {
    counterBytes.fill(0);
    digest.fill(0);
  }
}

/** Generate an RFC 4226 HOTP value using the supplied counter and hash/digit options. */
export function hotpCode(secret: string | Uint8Array, counter: number | bigint, options?: TotpOptions): string {
  const resolved = resolveOptions(options);
  const secretBytes = copySecret(secret);
  try {
    return hotpFromBytes(secretBytes, normalizeCounter(counter), resolved);
  } finally {
    secretBytes.fill(0);
  }
}

function counterForTimeMs(timeMs: number, stepSeconds: number): bigint {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs < 0 || timeMs > Number.MAX_SAFE_INTEGER) {
    throw invalidInput('timeMs must be a finite, non-negative safe number');
  }
  return BigInt(Math.floor(timeMs / (stepSeconds * 1000)));
}

function counterForTimeSeconds(timeSeconds: number, stepSeconds: number): bigint {
  if (
    typeof timeSeconds !== 'number' ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    timeSeconds > Number.MAX_SAFE_INTEGER
  ) {
    throw invalidInput('timeSeconds must be a finite, non-negative safe number');
  }
  return BigInt(Math.floor(timeSeconds / stepSeconds));
}

/** Return the TOTP value for a Unix timestamp in milliseconds. */
export function totpCode(secret: string, timeMs = Date.now(), options?: TotpOptions): string {
  const resolved = resolveOptions(options);
  const secretBytes = decodeTotpSecret(secret);
  try {
    return hotpFromBytes(secretBytes, counterForTimeMs(timeMs, resolved.stepSeconds), resolved);
  } finally {
    secretBytes.fill(0);
  }
}

/** Return the TOTP value for a Unix timestamp in seconds, as used by RFC 6238 vectors. */
export function totpCodeAtSeconds(
  secret: string,
  timeSeconds = Math.floor(Date.now() / 1000),
  options?: TotpOptions,
): string {
  const resolved = resolveOptions(options);
  const secretBytes = decodeTotpSecret(secret);
  try {
    return hotpFromBytes(secretBytes, counterForTimeSeconds(timeSeconds, resolved.stepSeconds), resolved);
  } finally {
    secretBytes.fill(0);
  }
}

/** Verify a TOTP value against the current step and a fixed ±window of adjacent steps. */
export function verifyTotpCode(
  secret: string,
  suppliedCode: string,
  timeMs = Date.now(),
  options?: TotpVerificationOptions,
): boolean {
  const resolved = resolveOptions(options);
  const windowSteps = resolveWindowSteps(options);
  if (typeof suppliedCode !== 'string' || !new RegExp(`^\\d{${resolved.digits}}$`).test(suppliedCode)) {
    throw invalidInput(`code must be exactly ${resolved.digits} decimal digits`);
  }

  const secretBytes = decodeTotpSecret(secret);
  const supplied = Buffer.from(suppliedCode, 'ascii');
  try {
    const currentStep = counterForTimeMs(timeMs, resolved.stepSeconds);
    let matched = false;
    for (let delta = -windowSteps; delta <= windowSteps; delta += 1) {
      const candidateStep = currentStep + BigInt(delta);
      const candidate =
        candidateStep < 0n
          ? Buffer.alloc(supplied.length, 0xff)
          : Buffer.from(hotpFromBytes(secretBytes, candidateStep, resolved), 'ascii');
      const equal = timingSafeEqual(candidate, supplied);
      if (equal) matched = true;
      candidate.fill(0);
    }
    return matched;
  } finally {
    supplied.fill(0);
    secretBytes.fill(0);
  }
}

/** Build a standards-compatible otpauth URI for a TOTP account. */
export function totpUri(secret: string, issuer: string, account: string, options?: TotpOptions): string {
  const resolved = resolveOptions(options);
  if (typeof issuer !== 'string' || issuer.length === 0) throw invalidInput('issuer must be non-empty');
  if (typeof account !== 'string' || account.length === 0) throw invalidInput('account must be non-empty');

  const secretBytes = decodeTotpSecret(secret);
  try {
    const canonicalSecret = encodeBase32(secretBytes);
    const encodedIssuer = encodeUriComponent(issuer);
    const encodedAccount = encodeUriComponent(account);
    const query = [
      `secret=${canonicalSecret}`,
      `issuer=${encodedIssuer}`,
      `algorithm=${resolved.algorithm.toUpperCase()}`,
      `digits=${resolved.digits}`,
      `period=${resolved.stepSeconds}`,
    ].join('&');
    return `otpauth://totp/${encodedIssuer}:${encodedAccount}?${query}`;
  } finally {
    secretBytes.fill(0);
  }
}

// Clear aliases for callers that use the shorter RFC terminology.
export const hotp = hotpCode;
export const totp = totpCode;
export const verifyTotp = verifyTotpCode;
export const createOtpAuthUri = totpUri;
