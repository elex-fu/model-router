import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ResponsesHistoryCipherPort } from './responses-continuation-history.js';
const PURPOSE = new TextEncoder().encode('model-router/responses-history/aes-256-gcm/v1\0');
/** Dedicated history keys only; no provider credential KMS/sealing authority is accepted. */
export class AesGcmResponsesHistoryCipher implements ResponsesHistoryCipherPort {
  private readonly keys = new Map<string, Buffer>();
  private closed = false;
  constructor(private readonly currentKeyId: string, historyKeys: ReadonlyMap<string, Uint8Array>) {
    for (const [id, key] of historyKeys) {
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id) || key.byteLength !== 32) throw new Error('Invalid history encryption keyring');
      this.keys.set(id, Buffer.from(key));
    }
    if (!this.keys.has(currentKeyId)) throw new Error('Invalid history encryption keyring');
  }
  private key(id: string): Buffer {
    const key = this.keys.get(id);
    if (this.closed || !key) throw new Error('History encryption key unavailable');
    return key;
  }
  private aad(keyId: string, associatedData: Uint8Array): Buffer {
    return Buffer.concat([PURPOSE, Buffer.from(keyId, 'utf8'), Buffer.from([0]), Buffer.from(associatedData)]);
  }
  async seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<{ readonly encryptionKeyId: string; readonly encryptedContext: Uint8Array }> {
    if (plaintext.byteLength > 16 * 1024 * 1024) throw new Error('History context exceeds encryption limit');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(this.currentKeyId), nonce);
    cipher.setAAD(this.aad(this.currentKeyId, associatedData));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    // Envelope v1: version byte, 12-byte nonce, 16-byte tag, ciphertext.
    return { encryptionKeyId: this.currentKeyId, encryptedContext: Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]) };
  }
  async open(record: { readonly encryptionKeyId: string; readonly encryptedContext: Uint8Array }, associatedData: Uint8Array): Promise<Uint8Array> {
    const envelope = Buffer.from(record.encryptedContext);
    if (envelope.byteLength < 29 || envelope.byteLength > 16 * 1024 * 1024 + 29 || envelope[0] !== 1) throw new Error('Invalid history ciphertext');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(record.encryptionKeyId), envelope.subarray(1, 13));
      decipher.setAuthTag(envelope.subarray(13, 29));
      decipher.setAAD(this.aad(record.encryptionKeyId, associatedData));
      return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]);
    } catch { throw new Error('History ciphertext authentication failed'); }
  }
  close(): void { this.closed = true; for (const key of this.keys.values()) key.fill(0); this.keys.clear(); }
}
