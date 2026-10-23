import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ResponsesHistoryCipherPort } from '../gateway/responses-continuation-history.js';
import { resolveProviderModuleSpecifier, type ProviderEnvironment, type ProviderLoaderOptions } from './providers.js';

export const RESPONSES_HISTORY_KMS_PURPOSE = 'responses-canonical-history/v1' as const;
export const SAAS_RESPONSES_HISTORY_KMS_MODULE = 'SAAS_RESPONSES_HISTORY_KMS_MODULE' as const;
export interface ResponsesHistoryDataKeyRequest {
  readonly kmsKeyId: string;
  readonly keySpec: 'AES_256';
  readonly encryptionContext: Readonly<Record<string, string>>;
}
export interface ResponsesHistoryDecryptRequest {
  readonly kmsKeyId: string;
  readonly ciphertextBlob: Uint8Array;
  readonly encryptionContext: Readonly<Record<string, string>>;
}
/** Dedicated history authority. Never pass provider-credential sealing/decryption adapters here. */
export interface ResponsesHistoryKms {
  readonly securityBoundary: 'external-kms';
  generateDataKey(request: ResponsesHistoryDataKeyRequest): PromiseLike<{ readonly plaintextKey: Uint8Array; readonly ciphertextBlob: Uint8Array }> | { readonly plaintextKey: Uint8Array; readonly ciphertextBlob: Uint8Array };
  decryptDataKey(request: ResponsesHistoryDecryptRequest): PromiseLike<Uint8Array> | Uint8Array;
  checkReady(): PromiseLike<void> | void;
  close(): PromiseLike<void> | void;
  /** Non-secret deployment metadata only. */
  diagnostics?(): { readonly credentialExpiresAt?: string; readonly retainedDecryptKeyIds?: readonly string[] };
}
export interface ResponsesHistoryKmsFactoryOptions { readonly env: ProviderEnvironment; readonly purpose: typeof RESPONSES_HISTORY_KMS_PURPOSE; readonly keyId: string }
export interface ResponsesHistoryKmsModule { createResponsesHistoryKms(options: ResponsesHistoryKmsFactoryOptions): PromiseLike<ResponsesHistoryKms> | ResponsesHistoryKms }
export class ResponsesHistoryRuntimeError extends Error {
  constructor(readonly code: 'CONFIGURATION_INVALID' | 'MODULE_LOAD_FAILED' | 'MODULE_INVALID' | 'KMS_OPERATION_FAILED' | 'READINESS_FAILED' | 'CLOSED' | 'CIPHERTEXT_INVALID') {
    super(`Responses history runtime ${code.toLowerCase().replaceAll('_', ' ')}`); this.name = 'ResponsesHistoryRuntimeError';
  }
}
function fail(code: ConstructorParameters<typeof ResponsesHistoryRuntimeError>[0]): never { throw new ResponsesHistoryRuntimeError(code); }
export interface ResponsesHistoryDeploymentDiagnostics {
  readonly purpose: typeof RESPONSES_HISTORY_KMS_PURPOSE;
  readonly currentKeyId?: string;
  readonly retainedDecryptKeyIds?: readonly string[];
  readonly credentialExpiresAt?: string;
  readonly verification: 'not_verified' | 'kms_roundtrip_verified' | 'pilot_only' | 'closed';
  readonly verifiedAtMs?: number;
  readonly productionEvidence: 'external_evidence_required';
}
const MAX_CONTEXT = 16 * 1024 * 1024;
const MAX_WRAPPED_KEY = 16 * 1024;
const MAGIC = Buffer.from('MRRH2');
function keyIdValid(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 2048 && !/[\u0000-\u001f]/.test(value); }
function context(keyId: string, aad: Uint8Array): Readonly<Record<string,string>> {
  return Object.freeze({ purpose: RESPONSES_HISTORY_KMS_PURPOSE, version: '2', keyId, aadSha256: createHash('sha256').update(aad).digest('hex') });
}
function authenticatedData(keyId: string, aad: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(JSON.stringify({ purpose: RESPONSES_HISTORY_KMS_PURPOSE, version: 2, keyId })), Buffer.from([0]), Buffer.from(aad)]);
}
/** Per-record DEK; only the encrypted DEK and authenticated ciphertext leave this boundary. */
export class KmsResponsesHistoryCipher implements ResponsesHistoryCipherPort {
  private closed = false;
  private closing: Promise<void> | undefined;
  private verifiedAtMs: number | undefined;
  constructor(private readonly keyId: string, private readonly kms: ResponsesHistoryKms) { if (!keyIdValid(keyId) || kms.securityBoundary !== 'external-kms') fail('CONFIGURATION_INVALID'); }
  async seal(plaintext: Uint8Array, aad: Uint8Array): Promise<{ encryptionKeyId: string; encryptedContext: Uint8Array }> {
    if (this.closed) fail('CLOSED');
    if (plaintext.byteLength > MAX_CONTEXT || aad.byteLength > 64 * 1024) fail('CONFIGURATION_INVALID');
    let key: Uint8Array | undefined;
    try {
      const generated = await this.kms.generateDataKey({ kmsKeyId: this.keyId, keySpec: 'AES_256', encryptionContext: context(this.keyId, aad) });
      key = generated?.plaintextKey;
      if (!(key instanceof Uint8Array) || key.byteLength !== 32 || !(generated.ciphertextBlob instanceof Uint8Array) || generated.ciphertextBlob.byteLength < 1 || generated.ciphertextBlob.byteLength > MAX_WRAPPED_KEY) fail('KMS_OPERATION_FAILED');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(authenticatedData(this.keyId, aad));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const length = Buffer.alloc(4); length.writeUInt32BE(generated.ciphertextBlob.byteLength);
      return { encryptionKeyId: this.keyId, encryptedContext: Buffer.concat([MAGIC, length, Buffer.from(generated.ciphertextBlob), nonce, cipher.getAuthTag(), encrypted]) };
    } catch { return fail('KMS_OPERATION_FAILED'); } finally { if (key instanceof Uint8Array) key.fill(0); }
  }
  async open(record: { readonly encryptionKeyId: string; readonly encryptedContext: Uint8Array }, aad: Uint8Array): Promise<Uint8Array> {
    if (this.closed) fail('CLOSED');
    let key: Uint8Array | undefined;
    try {
      if (!keyIdValid(record.encryptionKeyId) || aad.byteLength > 64 * 1024) fail('CIPHERTEXT_INVALID');
      const e = Buffer.from(record.encryptedContext), header = MAGIC.length + 4;
      if (e.length < header + 29 || e.length > MAX_CONTEXT + MAX_WRAPPED_KEY + header + 28 || !e.subarray(0,MAGIC.length).equals(MAGIC)) fail('CIPHERTEXT_INVALID');
      const length = e.readUInt32BE(MAGIC.length); if (length < 1 || length > MAX_WRAPPED_KEY || e.length < header + length + 28) fail('CIPHERTEXT_INVALID');
      const offset = header + length;
      key = await this.kms.decryptDataKey({ kmsKeyId: record.encryptionKeyId, ciphertextBlob: e.subarray(header, offset), encryptionContext: context(record.encryptionKeyId, aad) });
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail('CIPHERTEXT_INVALID');
      const decipher = createDecipheriv('aes-256-gcm', key, e.subarray(offset, offset+12));
      decipher.setAuthTag(e.subarray(offset+12,offset+28)); decipher.setAAD(authenticatedData(record.encryptionKeyId,aad));
      return Buffer.concat([decipher.update(e.subarray(offset+28)),decipher.final()]);
    } catch { return fail('CIPHERTEXT_INVALID'); } finally { if (key instanceof Uint8Array) key.fill(0); }
  }
  async checkReady(): Promise<void> {
    if (this.closed) fail('CLOSED');
    const probe = randomBytes(32), aad = Buffer.from(JSON.stringify({ purpose: RESPONSES_HISTORY_KMS_PURPOSE, readiness: true })); let plain: Uint8Array | undefined;
    try { plain = await this.open(await this.seal(probe,aad),aad); if (plain.length !== probe.length || !timingSafeEqual(plain,probe)) fail('READINESS_FAILED'); this.verifiedAtMs = Date.now(); }
    catch { fail('READINESS_FAILED'); } finally { probe.fill(0); plain?.fill(0); }
  }
  diagnostics(): ResponsesHistoryDeploymentDiagnostics {
    let metadata: ReturnType<NonNullable<ResponsesHistoryKms['diagnostics']>> = {};
    try { metadata = this.kms.diagnostics?.() ?? {}; } catch { /* diagnostics never expose provider exceptions */ }
    const retained = metadata.retainedDecryptKeyIds; const expiry = metadata.credentialExpiresAt;
    return Object.freeze({ purpose: RESPONSES_HISTORY_KMS_PURPOSE, currentKeyId: this.keyId, retainedDecryptKeyIds: Object.freeze(Array.isArray(retained) && retained.length <= 17 && retained.every(keyIdValid) ? [...retained] : [this.keyId]), ...(typeof expiry === 'string' && Number.isFinite(Date.parse(expiry)) ? { credentialExpiresAt: new Date(expiry).toISOString() } : {}), verification: this.closed ? 'closed' : this.verifiedAtMs === undefined ? 'not_verified' : 'kms_roundtrip_verified', ...(this.verifiedAtMs === undefined ? {} : { verifiedAtMs: this.verifiedAtMs }), productionEvidence: 'external_evidence_required' });
  }
  close(): Promise<void> { if (!this.closing) { this.closed = true; this.closing = Promise.resolve().then(() => this.kms.close()).catch(() => fail('KMS_OPERATION_FAILED')); } return this.closing; }
}
/** Trusted-module pattern shared with the credential loaders, with an independent factory and env scope. */
export async function loadResponsesHistoryKmsCipher(keyId: string, options: ProviderLoaderOptions = {}): Promise<KmsResponsesHistoryCipher> {
  const source = options.env ?? process.env; const specifier = source[SAAS_RESPONSES_HISTORY_KMS_MODULE];
  if (!keyIdValid(keyId) || typeof specifier !== 'string' || !specifier || specifier.length > 4096) fail('CONFIGURATION_INVALID');
  const scoped: Record<string,string|undefined> = Object.create(null); let bytes = 0;
  for (const [key,value] of Object.entries(source)) {
    if (!key.startsWith('MODEL_ROUTER_SAAS_RESPONSES_HISTORY_') && key !== SAAS_RESPONSES_HISTORY_KMS_MODULE) continue;
    if (value !== undefined && (typeof value !== 'string' || value.length > 16384 || value.includes('\0'))) fail('CONFIGURATION_INVALID');
    bytes += key.length + (value?.length ?? 0); if (bytes > 128*1024) fail('CONFIGURATION_INVALID'); scoped[key] = value;
  }
  let imported: unknown;
  try { imported = await (options.importer ?? options.importModule ?? (name => import(name)))(resolveProviderModuleSpecifier(specifier,options.cwd ?? process.cwd())); }
  catch { return fail('MODULE_LOAD_FAILED'); }
  const factory = (imported as Partial<ResponsesHistoryKmsModule> | null)?.createResponsesHistoryKms;
  if (typeof factory !== 'function') fail('MODULE_INVALID');
  let raw: ResponsesHistoryKms | undefined;
  try {
    raw = await factory(Object.freeze({env:Object.freeze(scoped),purpose:RESPONSES_HISTORY_KMS_PURPOSE,keyId}));
    if (!raw || raw.securityBoundary !== 'external-kms' || ['generateDataKey','decryptDataKey','checkReady','close'].some(k => typeof (raw as unknown as Record<string,unknown>)[k] !== 'function')) fail('MODULE_INVALID');
    const cipher = new KmsResponsesHistoryCipher(keyId,raw); await cipher.checkReady(); return cipher;
  } catch { const cleanup = raw; if (cleanup && typeof cleanup.close === 'function') await Promise.resolve().then(() => cleanup.close()).catch(() => {}); return fail('READINESS_FAILED'); }
}
