import type { CredentialEnvelope, UserCredentialContext } from '../credentials/crypto.js';
import { PLATFORM_TOTP_PROVIDER } from '../platform/auth/types.js';
import { verifyTotpCode } from '../platform/auth/totp.js';
import { customerMfaFail } from './customer-mfa-types.js';

/** Explicit compatibility adapter for the existing finance-purpose reader.
 * "platform-totp" is ONLY the historical authenticated crypto domain here,
 * not an audience, platform session, RBAC grant or enrollment authorization.
 * A future new domain requires an explicit versioned reader migration.
 */
export function customerMfaCredentialAad(userId: string, credentialId: string): UserCredentialContext {
  return Object.freeze({ userId, provider: PLATFORM_TOTP_PROVIDER, credentialId });
}
export function customerMfaEnvelope(bytes: Uint8Array): CredentialEnvelope {
  if (!bytes.byteLength || bytes.byteLength > 4096) return customerMfaFail('UNAVAILABLE');
  const copy = Buffer.from(bytes);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'algorithm,authTag,ciphertext,keyId,nonce,schemaVersion'
      || !('schemaVersion' in value) || value.schemaVersion !== 1
      || !('algorithm' in value) || value.algorithm !== 'aes-256-gcm'
      || !('keyId' in value) || typeof value.keyId !== 'string'
      || !('nonce' in value) || typeof value.nonce !== 'string'
      || !('ciphertext' in value) || typeof value.ciphertext !== 'string'
      || !('authTag' in value) || typeof value.authTag !== 'string') return customerMfaFail('UNAVAILABLE');
    return { schemaVersion: 1, algorithm: 'aes-256-gcm', keyId: value.keyId,
      nonce: value.nonce, ciphertext: value.ciphertext, authTag: value.authTag };
  } catch { return customerMfaFail('UNAVAILABLE'); } finally { copy.fill(0); }
}
export function customerMfaMatchingStep(secret: string, code: string, timeMs: number): string | null {
  if (!/^[0-9]{6}$/.test(code) || !Number.isSafeInteger(timeMs) || timeMs < 0) return null;
  const step = Math.floor(timeMs / 30000);
  try {
    // Prefer current over adjacent steps; never accept an already consumed one.
    for (const candidate of [step, step - 1, step + 1]) {
      if (candidate >= 0 && verifyTotpCode(secret, code, candidate * 30000, { windowSteps: 0 })) return String(candidate);
    }
  } catch { return customerMfaFail('UNAVAILABLE'); }
  return null;
}
