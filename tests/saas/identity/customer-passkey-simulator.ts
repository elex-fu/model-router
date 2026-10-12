import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

/**
 * Test-side simulated authenticator. Builds the exact byte shapes a real
 * passkey produces (definite-length CBOR, attestation fmt 'none', assertions
 * over authData || sha256(clientData)). Fixtures only — never shipped.
 */
function cborUint(value: number): Buffer {
  if (value < 24) return Buffer.from([value]);
  if (value < 256) return Buffer.from([24, value]);
  if (value < 65536) { const b = Buffer.alloc(3); b[0] = 25; b.writeUInt16BE(value, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 26; b.writeUInt32BE(value, 1); return b;
}
function cborMajor(major: number, value: number): Buffer {
  const head = cborUint(value);
  head[0] = (head[0] as number) | (major << 5);
  return head;
}
const cborBstr = (value: Buffer): Buffer => Buffer.concat([cborMajor(2, value.length), value]);
const cborTstr = (value: string): Buffer => {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([cborMajor(3, encoded.length), encoded]);
};
const cborInt = (value: number): Buffer => {
  if (value >= 0) return cborUint(value);
  const head = cborUint(-1 - value);
  head[0] = (head[0] as number) | 0x20;
  return head;
};
const cborMap = (entries: Array<[number | string, Buffer]>): Buffer =>
  Buffer.concat([
    cborMajor(5, entries.length),
    ...entries.flatMap(([key, value]) => [typeof key === 'string' ? cborTstr(key) : cborInt(key), value]),
  ]);

export interface SimulatedPasskey {
  readonly credentialId: string;
  readonly cose: Buffer;
  readonly sign: (data: Buffer) => Buffer;
}
export function simulatePasskey(idBytes = 32): SimulatedPasskey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const credentialIdBytes = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-idBytes);
  const cose = cborMap([
    [1, cborUint(2)],
    [3, cborInt(-7)],
    [-1, cborUint(1)],
    [-2, cborBstr(Buffer.from(String(jwk.x), 'base64url'))],
    [-3, cborBstr(Buffer.from(String(jwk.y), 'base64url'))],
  ]);
  return { credentialId: Buffer.from(credentialIdBytes).toString('base64url'), cose, sign: (data) => cryptoSign('sha256', data, pair.privateKey) };
}

const UP = 0x01; const UV = 0x04; const AT = 0x40;
export const SIM_RP_ID = 'console.example.test';
export const SIM_ORIGIN = 'https://console.example.test';

function authData(flags: number, signCount: number, attested?: Buffer, rpId = SIM_RP_ID): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  return Buffer.concat([
    createHash('sha256').update(rpId, 'utf8').digest(),
    Buffer.from([flags]),
    counter,
    ...(attested ? [attested] : []),
  ]);
}
export function registrationPayload(
  key: SimulatedPasskey, challenge: string,
  overrides: { origin?: string; type?: string; rpId?: string; challengeOverride?: string; signCount?: number } = {},
): { id: string; clientDataJSON: string; attestationObject: string } {
  const idBytes = Buffer.from(key.credentialId, 'base64url');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(idBytes.length);
  const attested = Buffer.concat([Buffer.alloc(16), length, idBytes, key.cose]);
  const data = authData(UP | UV | AT, overrides.signCount ?? 0, attested, overrides.rpId);
  const attestationObject = cborMap([
    ['fmt', cborTstr('none')],
    ['attStmt', cborMap([])],
    ['authData', cborBstr(data)],
  ]);
  return {
    id: key.credentialId,
    clientDataJSON: JSON.stringify({
      type: overrides.type ?? 'webauthn.create',
      challenge: overrides.challengeOverride ?? challenge,
      origin: overrides.origin ?? SIM_ORIGIN,
    }),
    attestationObject: attestationObject.toString('base64url'),
  };
}
export function assertionPayload(
  key: SimulatedPasskey, challenge: string, signCount: number,
  overrides: { origin?: string; type?: string; rpId?: string; userHandle?: string | null; tamperSignature?: boolean } = {},
): { id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null } {
  const data = authData(UP | UV, signCount, undefined, overrides.rpId);
  const clientDataJSON = JSON.stringify({
    type: overrides.type ?? 'webauthn.get',
    challenge,
    origin: overrides.origin ?? SIM_ORIGIN,
  });
  const signature = overrides.tamperSignature
    ? Buffer.alloc(64)
    : key.sign(Buffer.concat([data, createHash('sha256').update(clientDataJSON, 'utf8').digest()]));
  return {
    id: key.credentialId,
    clientDataJSON,
    authenticatorData: data.toString('base64url'),
    signature: signature.toString('base64url'),
    ...(overrides.userHandle !== undefined ? { userHandle: overrides.userHandle } : {}),
  };
}
