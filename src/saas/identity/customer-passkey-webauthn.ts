import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Minimal fail-closed WebAuthn verification for customer passkeys (Track E2).
 * Deliberately narrow: attestation fmt 'none' only (no trust-anchor story,
 * which is the standard consumer deployment posture), COSE algorithms ES256
 * and RS256 only, no extensions, no token binding, definite-length CBOR only.
 * Every structural deviation throws PasskeyVerificationError with an internal
 * reason that never crosses the HTTP boundary; the service maps any such
 * rejection to a generic ceremony denial.
 */
export type PasskeyVerificationReason =
  | 'encoding'
  | 'cbor'
  | 'client_data'
  | 'challenge'
  | 'origin'
  | 'rp'
  | 'flags'
  | 'attestation'
  | 'algorithm'
  | 'signature'
  | 'counter';

export class PasskeyVerificationError extends Error {
  constructor(readonly reason: PasskeyVerificationReason) {
    super('Passkey verification failed.');
    this.name = 'PasskeyVerificationError';
  }
}
const reject = (reason: PasskeyVerificationReason): never => {
  throw new PasskeyVerificationError(reason);
};

/** Strict base64url: no padding, alphabet-bounded, length-bounded. */
export function decodeBase64url(value: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2 || !/^[A-Za-z0-9_-]+$/.test(value))
    reject('encoding');
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.toString('base64url').replace(/=+$/, '') !== value)
    reject('encoding');
  return buffer;
}

// --- Bounded definite-length CBOR (major types 0-5 only) -----------------
type CborValue = bigint | Buffer | string | CborValue[] | Map<bigint | string, CborValue>;
function decodeCbor(buffer: Buffer): { value: CborValue; offset: number } {
  const maxDepth = 8;
  const read = (offset: number, depth: number): { value: CborValue; offset: number } => {
    if (depth > maxDepth || offset >= buffer.length) reject('cbor');
    const initial = buffer[offset] as number;
    const major = initial >> 5;
    const info = initial & 31;
    let cursor = offset + 1;
    let argument: bigint;
    if (info < 24) argument = BigInt(info);
    else if (info === 24) {
      if (cursor + 1 > buffer.length) reject('cbor');
      argument = BigInt(buffer[cursor] as number);
      cursor += 1;
    } else if (info === 25) {
      if (cursor + 2 > buffer.length) reject('cbor');
      argument = BigInt(buffer.readUInt16BE(cursor));
      cursor += 2;
    } else if (info === 26) {
      if (cursor + 4 > buffer.length) reject('cbor');
      argument = BigInt(buffer.readUInt32BE(cursor));
      cursor += 4;
    } else if (info === 27) {
      if (cursor + 8 > buffer.length) reject('cbor');
      argument = buffer.readBigUInt64BE(cursor);
      cursor += 8;
    } else return reject('cbor'); // 28-30 reserved, 31 indefinite: both rejected
    if (argument > BigInt(buffer.length) && (major === 2 || major === 3)) reject('cbor');
    if (argument > 65536n && (major === 4 || major === 5)) reject('cbor');
    if (major === 0) return { value: argument, offset: cursor };
    if (major === 1) return { value: -1n - argument, offset: cursor };
    if (major === 2 || major === 3) {
      const length = Number(argument);
      if (cursor + length > buffer.length) reject('cbor');
      const slice = buffer.subarray(cursor, cursor + length);
      if (major === 2) return { value: Buffer.from(slice), offset: cursor + length };
      try {
        return { value: new TextDecoder('utf-8', { fatal: true }).decode(slice), offset: cursor + length };
      } catch {
        return reject('cbor');
      }
    }
    if (major === 4) {
      const items: CborValue[] = [];
      for (let index = 0; index < argument; index += 1) {
        const next = read(cursor, depth + 1);
        items.push(next.value);
        cursor = next.offset;
      }
      return { value: items, offset: cursor };
    }
    if (major === 5) {
      const map = new Map<bigint | string, CborValue>();
      for (let index = 0; index < argument; index += 1) {
        const key = read(cursor, depth + 1);
        const mapKey = key.value;
        if (typeof mapKey !== 'bigint' && typeof mapKey !== 'string') return reject('cbor');
        if (map.has(mapKey)) return reject('cbor');
        const item = read(key.offset, depth + 1);
        map.set(mapKey, item.value);
        cursor = item.offset;
      }
      return { value: map, offset: cursor };
    }
    return reject('cbor'); // major 6 tags, major 7 floats/simple: never needed here
  };
  return read(0, 0);
}

// --- COSE keys -------------------------------------------------------------
export type CosePublicKey =
  | { readonly alg: -7; readonly crv: 1; readonly x: Buffer; readonly y: Buffer }
  | { readonly alg: -257; readonly n: Buffer; readonly e: Buffer };

export function parseCosePublicKey(encoded: Buffer): CosePublicKey {
  const { value, offset } = decodeCbor(encoded);
  if (offset !== encoded.length || !(value instanceof Map)) return reject('cbor');
  const kty = value.get(1n);
  const alg = value.get(3n);
  if (alg === -7n && kty === 2n) {
    const crv = value.get(-1n);
    const x = value.get(-2n);
    const y = value.get(-3n);
    if (crv !== 1n || !(x instanceof Buffer) || x.length !== 32 || !(y instanceof Buffer) || y.length !== 32)
      return reject('algorithm');
    return { alg: -7, crv: 1, x: Buffer.from(x), y: Buffer.from(y) };
  }
  if (alg === -257n && kty === 3n) {
    const n = value.get(-1n);
    const e = value.get(-2n);
    if (
      !(n instanceof Buffer) ||
      n.length < 256 ||
      n.length > 512 ||
      !(e instanceof Buffer) ||
      e.length === 0 ||
      e.length > 8
    )
      return reject('algorithm');
    return { alg: -257, n: Buffer.from(n), e: Buffer.from(e) };
  }
  return reject('algorithm');
}

function verificationKey(cose: CosePublicKey): ReturnType<typeof createPublicKey> {
  try {
    return createPublicKey({
      key:
        cose.alg === -7
          ? { kty: 'EC', crv: 'P-256', x: cose.x.toString('base64url'), y: cose.y.toString('base64url') }
          : { kty: 'RSA', n: cose.n.toString('base64url'), e: cose.e.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return reject('algorithm');
  }
}

// --- authenticatorData -------------------------------------------------------
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export interface AttestedCredentialData {
  readonly credentialId: string;
  /** Raw COSE bytes, stored verbatim as saas_mfa_credentials.public_key. */
  readonly coseKey: Buffer;
}

interface AuthenticatorData {
  readonly userVerified: boolean;
  readonly signCount: number;
  readonly attested: AttestedCredentialData | null;
}

function parseAuthenticatorData(
  buffer: Buffer,
  rpId: string,
  requireUserVerification: boolean,
  attestation: boolean,
): AuthenticatorData {
  if (buffer.length < 37 || buffer.length > 4096) reject('attestation');
  if (!buffer.subarray(0, 32).equals(createHash('sha256').update(rpId, 'utf8').digest())) reject('rp');
  const flags = buffer[32] as number;
  if ((flags & FLAG_UP) === 0) reject('flags');
  if (requireUserVerification && (flags & FLAG_UV) === 0) reject('flags');
  if ((flags & FLAG_ED) !== 0) reject('attestation'); // extensions never expected
  if ((flags & FLAG_AT) !== (attestation ? FLAG_AT : 0)) reject('flags');
  const signCount = buffer.readUInt32BE(33);
  if (!attestation) {
    if (buffer.length !== 37) reject('attestation');
    return { userVerified: (flags & FLAG_UV) !== 0, signCount, attested: null };
  }
  // attestedCredentialData: aaguid(16) || idLength(2 BE) || id || COSE key
  if (buffer.length < 37 + 16 + 2) reject('attestation');
  const idLength = buffer.readUInt16BE(53);
  if (idLength < 12 || idLength > 1023 || 55 + idLength >= buffer.length) reject('attestation');
  const credentialId = buffer.subarray(55, 55 + idLength);
  const cose = decodeCbor(buffer.subarray(55 + idLength));
  if (55 + idLength + cose.offset !== buffer.length) reject('attestation'); // nothing may trail
  const coseKey = Buffer.from(buffer.subarray(55 + idLength, 55 + idLength + cose.offset));
  parseCosePublicKey(coseKey);
  return {
    userVerified: (flags & FLAG_UV) !== 0,
    signCount,
    attested: {
      credentialId: credentialId.toString('base64url'),
      coseKey,
    },
  };
}

// --- clientDataJSON -----------------------------------------------------------
function verifyClientData(
  clientDataJSON: string,
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string,
  origins: readonly string[],
): void {
  if (typeof clientDataJSON !== 'string' || clientDataJSON.length === 0 || clientDataJSON.length > 4096)
    reject('client_data');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(clientDataJSON, 'utf8')));
  } catch {
    reject('client_data');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) reject('client_data');
  const data = parsed as Record<string, unknown>;
  if (data.type !== type) reject('client_data');
  if (typeof data.challenge !== 'string' || data.challenge !== challenge) reject('challenge');
  if (typeof data.origin !== 'string' || !origins.includes(data.origin)) reject('origin');
  if ('tokenBinding' in data) reject('client_data'); // never negotiated here
  if (data.crossOrigin !== undefined && data.crossOrigin !== false) reject('client_data');
}

export interface PasskeyRelyingParty {
  /** Effective RP ID (domain, no scheme/port); sha256-bound into authenticatorData. */
  readonly rpId: string;
  /** Exact https origins allowed to produce ceremonies. */
  readonly origins: readonly string[];
  /** Default true: passkeys imply user verification; only tests may relax. */
  readonly requireUserVerification: boolean;
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly coseKey: Buffer;
  readonly signCount: number;
}

/** Registration (attestation, fmt 'none' only). `challenge` is the exact
 * base64url challenge issued by the ceremony start. */
export function verifyPasskeyRegistration(
  input: { readonly clientDataJSON: string; readonly attestationObject: string },
  party: PasskeyRelyingParty,
  challenge: string,
): VerifiedRegistration {
  verifyClientData(input.clientDataJSON, 'webauthn.create', challenge, party.origins);
  const attestationObject = decodeBase64url(input.attestationObject, 4096);
  const { value, offset } = decodeCbor(attestationObject);
  if (offset !== attestationObject.length || !(value instanceof Map)) return reject('attestation');
  if (value.get('fmt') !== 'none') return reject('attestation');
  const attStmt = value.get('attStmt');
  if (!(attStmt instanceof Map) || attStmt.size !== 0) return reject('attestation');
  const authData = value.get('authData');
  if (!(authData instanceof Buffer)) return reject('attestation');
  const parsed = parseAuthenticatorData(authData, party.rpId, party.requireUserVerification, true);
  const attested = parsed.attested;
  if (!attested) return reject('attestation');
  return {
    credentialId: attested.credentialId,
    coseKey: attested.coseKey,
    signCount: parsed.signCount,
  };
}

export interface VerifiedAssertion {
  /** Counter to CAS into saas_mfa_credentials.sign_count. */
  readonly signCount: number;
}

/**
 * Assertion signature + clone detection. Counter rule (fail-closed):
 * first assertion accepts any counter; afterwards a zero/zero pair passes
 * (non-incrementing authenticators) and any other stale or regressed counter
 * is a cloned-authenticator signal and rejected.
 */
export function verifyPasskeyAssertion(
  input: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
  },
  party: PasskeyRelyingParty,
  challenge: string,
  storedCoseKey: Uint8Array,
  storedSignCount: number | null,
): VerifiedAssertion {
  verifyClientData(input.clientDataJSON, 'webauthn.get', challenge, party.origins);
  const authenticatorData = decodeBase64url(input.authenticatorData, 4096);
  const signature = decodeBase64url(input.signature, 4096);
  const cose = parseCosePublicKey(Buffer.from(storedCoseKey));
  const parsed = parseAuthenticatorData(authenticatorData, party.rpId, party.requireUserVerification, false);
  const signed = Buffer.concat([authenticatorData, createHash('sha256').update(input.clientDataJSON, 'utf8').digest()]);
  let valid = false;
  try {
    valid = cryptoVerify('sha256', signed, verificationKey(cose), signature);
  } catch {
    valid = false;
  }
  if (!valid) reject('signature');
  if (storedSignCount !== null) {
    const increments = parsed.signCount > storedSignCount;
    const staticPair = parsed.signCount === 0 && storedSignCount === 0;
    if (!increments && !staticPair) reject('counter');
  }
  return { signCount: parsed.signCount };
}
