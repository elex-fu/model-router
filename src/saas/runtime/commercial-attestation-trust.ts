import { createPublicKey, type KeyObject } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ManagedSaasDeploymentConfig } from '../deployment.js';
import type { CommercialMeteringPolicyServiceOptions } from '../gateway/commercial-metering-policy-service.js';

export const COMMERCIAL_ATTESTATION_TRUST_FILE = 'MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE';
export class CommercialAttestationTrustError extends Error {
  constructor() { super('COMMERCIAL_ATTESTATION_TRUST_INVALID'); this.name = 'CommercialAttestationTrustError'; }
}
const invalid = (): never => { throw new CommercialAttestationTrustError(); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid();
  return result;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) return invalid();
  return value;
}
/** A distinct trust purpose from gateway request evidence; public verification material only. */
export function parseCommercialAttestationTrust(value: unknown): CommercialMeteringPolicyServiceOptions {
  try {
    const source = record(value, ['version', 'keys', 'testVectorDigests']);
    if (source.version !== 1 || !Array.isArray(source.keys) || source.keys.length < 1 || source.keys.length > 64 || !Array.isArray(source.testVectorDigests) || source.testVectorDigests.length < 1 || source.testVectorDigests.length > 256) invalid();
    const keys: Record<string, KeyObject> = Object.create(null);
    for (const item of source.keys as unknown[]) {
      const entry = record(item, ['keyId', 'publicKeyPem']);
      const id = label(entry.keyId);
      if (keys[id] || typeof entry.publicKeyPem !== 'string' || entry.publicKeyPem.length > 8192 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/u.test(entry.publicKeyPem)) invalid();
      const key = createPublicKey({ key: entry.publicKeyPem as string, format: 'pem', type: 'spki' });
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') invalid();
      keys[id] = key;
    }
    const vectors: Record<string, string> = Object.create(null);
    for (const item of source.testVectorDigests as unknown[]) {
      const entry = record(item, ['suiteVersion', 'sha256']);
      const suite = label(entry.suiteVersion);
      if (vectors[suite] || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) invalid();
      vectors[suite] = entry.sha256 as string;
    }
    return Object.freeze({ trustedVerifierPublicKeys: Object.freeze(keys), trustedTestVectorDigests: Object.freeze(vectors) });
  } catch { return invalid(); }
}
export async function loadCommercialAttestationTrust(deployment: ManagedSaasDeploymentConfig, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<CommercialMeteringPolicyServiceOptions | undefined> {
  const path = environment[COMMERCIAL_ATTESTATION_TRUST_FILE];
  if (path === undefined) return undefined;
  if (deployment.workloadRole !== 'combined' && deployment.workloadRole !== 'control-plane') return invalid();
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) invalid();
      const bytes = Buffer.alloc(65537);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 65536) invalid();
      return parseCommercialAttestationTrust(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    } finally { await file.close(); }
  } catch { return invalid(); }
}
