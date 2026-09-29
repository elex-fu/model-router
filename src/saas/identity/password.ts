import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };
const DUMMY_SCRYPT_SALT = Buffer.from('saas-identity-unknown-user-salt');

function scryptAsync(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS, (error, key) => {
      if (error) {
        reject(new Error('Password derivation failed'));
        return;
      }
      resolve(key);
    });
  });
}

function parsePasswordHash(encoded: unknown): { salt: Buffer; digest: Buffer } | undefined {
  if (typeof encoded !== 'string') return undefined;
  const parts = encoded.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    Number(parts[1]) !== SCRYPT_N ||
    Number(parts[2]) !== SCRYPT_R ||
    Number(parts[3]) !== SCRYPT_P
  ) {
    return undefined;
  }
  const saltPart = parts[4];
  const digestPart = parts[5];
  if (saltPart === undefined || digestPart === undefined) return undefined;
  const salt = Buffer.from(saltPart, 'base64url');
  const digest = Buffer.from(digestPart, 'base64url');
  if (salt.length !== SCRYPT_SALT_BYTES || digest.length !== SCRYPT_KEY_BYTES) return undefined;
  return { salt, digest };
}

/** Create a password hash using the persisted SaaS identity scrypt format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  let digest: Buffer | undefined;
  try {
    digest = await scryptAsync(password, salt);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  } finally {
    salt.fill(0);
    digest?.fill(0);
  }
}

/** Verify a stored hash; malformed or absent values still perform dummy scrypt work. */
export async function verifyPassword(password: string, encoded: unknown): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  const actual = await scryptAsync(password, parsed?.salt ?? DUMMY_SCRYPT_SALT);
  try {
    return parsed !== undefined && timingSafeEqual(actual, parsed.digest);
  } finally {
    actual.fill(0);
    parsed?.salt.fill(0);
    parsed?.digest.fill(0);
  }
}
