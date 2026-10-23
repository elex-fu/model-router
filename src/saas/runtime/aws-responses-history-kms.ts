import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { RESPONSES_HISTORY_KMS_PURPOSE, ResponsesHistoryRuntimeError, type ResponsesHistoryKms, type ResponsesHistoryKmsFactoryOptions, type ResponsesHistoryDataKeyRequest, type ResponsesHistoryDecryptRequest } from './responses-history-kms.js';

const PREFIX = 'MODEL_ROUTER_SAAS_RESPONSES_HISTORY_';
export interface ResponsesHistoryAwsCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken: string; readonly expiration: string }
export interface AwsResponsesHistoryKmsOptions extends ResponsesHistoryKmsFactoryOptions {
  /** Trusted test injection only; the factory never takes endpoint/transport from environment or HTTP. */
  readonly fetch?: typeof fetch;
  readonly nowMs?: () => number;
  readonly readCredentials?: () => Promise<ResponsesHistoryAwsCredentials>;
}
const fail = (): never => { throw new ResponsesHistoryRuntimeError('KMS_OPERATION_FAILED'); };
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function hmac(key: string | Uint8Array, value: string): Buffer { return createHmac('sha256',key).update(value).digest(); }
function header(value: string): string { return value.trim().replace(/\s+/g,' '); }
function decode(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length < 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return fail();
  const bytes = Buffer.from(value,'base64'); if (bytes.length > max || bytes.toString('base64') !== value) { bytes.fill(0); return fail(); } return bytes;
}
async function credentialsFile(path: string | undefined): Promise<ResponsesHistoryAwsCredentials> {
  if (!path || !path.startsWith('/')) return fail(); let bytes: Buffer | undefined;
  try {
    const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 32768 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return fail(); bytes = await file.readFile(); }
    finally { await file.close(); }
    return JSON.parse(bytes.toString('utf8')) as ResponsesHistoryAwsCredentials;
  } catch { return fail(); } finally { bytes?.fill(0); }
}
/** Minimal AWS KMS only adapter. Fixed HTTPS endpoint, SigV4 and dedicated history context. */
export function createAwsResponsesHistoryKms(options: AwsResponsesHistoryKmsOptions): ResponsesHistoryKms {
  const region = options.env[`${PREFIX}AWS_REGION`];
  const arn = /^arn:aws:kms:([a-z]{2}-[a-z]+-[0-9]):([0-9]{12}):key\/([a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.exec(options.keyId);
  const regions = new Set(['us-east-1','us-west-2','ap-southeast-1','ap-northeast-1','eu-west-1','eu-central-1']);
  if (!regions.has(region ?? '') || options.purpose !== RESPONSES_HISTORY_KMS_PURPOSE || !arn || region !== arn[1]) throw new ResponsesHistoryRuntimeError('CONFIGURATION_INVALID');
  const retained = new Set<string>([options.keyId]);
  const rawPrevious = options.env[`${PREFIX}KMS_PREVIOUS_KEY_IDS`];
  try { if (rawPrevious !== undefined) { const previous: unknown = JSON.parse(rawPrevious); if (!Array.isArray(previous) || previous.length > 16) throw new Error(); for (const key of previous) { if (typeof key !== 'string' || !key.startsWith(`arn:aws:kms:${region}:${arn[2]}:key/`) || !/^arn:aws:kms:[a-z]{2}-[a-z]+-[0-9]:[0-9]{12}:key\/([a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.test(key) || retained.has(key)) throw new Error(); retained.add(key); } } } catch { throw new ResponsesHistoryRuntimeError('CONFIGURATION_INVALID'); }
  const host = `kms.${region}.amazonaws.com`, endpoint = `https://${host}/`;
  const transport = options.fetch ?? fetch, now = options.nowMs ?? Date.now;
  const loadCredentials = options.readCredentials ?? (() => credentialsFile(options.env[`${PREFIX}AWS_CREDENTIALS_FILE`]));
  let closed = false, credentialExpiresAt: string | undefined; const inflight = new Set<AbortController>();
  const request = async (action: 'GenerateDataKey' | 'Decrypt', body: Record<string, unknown>): Promise<Record<string,unknown>> => {
    if (closed) return fail(); const controller = new AbortController(); inflight.add(controller); const timer = setTimeout(() => controller.abort(),10000);
    try {
      const credentials = await loadCredentials();
      if (credentials && typeof credentials.expiration === 'string' && Number.isFinite(Date.parse(credentials.expiration))) credentialExpiresAt = new Date(credentials.expiration).toISOString();
      if (!credentials || !/^[A-Z0-9]{16,128}$/.test(credentials.accessKeyId) || typeof credentials.secretAccessKey !== 'string' || credentials.secretAccessKey.length < 16 || /[\r\n]/.test(credentials.secretAccessKey) || typeof credentials.sessionToken !== 'string' || credentials.sessionToken.length < 16 || credentials.sessionToken.length > 16384 || /\s/.test(credentials.sessionToken) || !Number.isFinite(Date.parse(credentials.expiration)) || Date.parse(credentials.expiration) <= now()+60000) return fail();
      const date = new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g,''), day = date.slice(0,8), payload = JSON.stringify(body);
      const headers: Record<string,string> = { 'content-type': 'application/x-amz-json-1.1', host, 'x-amz-date': date, 'x-amz-security-token': credentials.sessionToken, 'x-amz-target': `TrentService.${action}` };
      const names = Object.keys(headers).sort(), signedHeaders = names.join(';');
      const canonicalHeaders = names.map(name => `${name}:${header(headers[name])}\n`).join('');
      const canonicalRequest = ['POST','/','',canonicalHeaders,signedHeaders,sha(payload)].join('\n');
      const scope = `${day}/${region}/kms/aws4_request`, toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonicalRequest)}`;
      const dateKey = hmac(`AWS4${credentials.secretAccessKey}`,day), regionKey = hmac(dateKey,region!), serviceKey = hmac(regionKey,'kms'), signingKey = hmac(serviceKey,'aws4_request');
      let signature: string;
      try { signature = hmac(signingKey,toSign).toString('hex'); } finally { dateKey.fill(0); regionKey.fill(0); serviceKey.fill(0); signingKey.fill(0); }
      headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      const response = await transport(endpoint,{ method:'POST',headers,body:payload,redirect:'error',signal:controller.signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return fail(); }
      const reader = response.body?.getReader(); if (!reader) return fail(); const chunks: Uint8Array[] = []; let size = 0;
      let bytes: Buffer | undefined;
      try {
        while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 65536) { value.fill(0); await reader.cancel(); return fail(); } chunks.push(value); }
        bytes = Buffer.concat(chunks); const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(); return parsed as Record<string,unknown>;
      } finally { reader.releaseLock(); bytes?.fill(0); for (const b of chunks) b.fill(0); }
    } catch { return fail(); } finally { clearTimeout(timer); inflight.delete(controller); }
  };
  const validate = (request: ResponsesHistoryDataKeyRequest | ResponsesHistoryDecryptRequest): void => {
    if (!retained.has(request.kmsKeyId) || request.encryptionContext.purpose !== RESPONSES_HISTORY_KMS_PURPOSE || request.encryptionContext.version !== '2' || request.encryptionContext.keyId !== request.kmsKeyId || !/^[a-f0-9]{64}$/.test(request.encryptionContext.aadSha256)) fail();
    if (Object.keys(request.encryptionContext).length !== 4) fail();
  };
  const adapter: ResponsesHistoryKms = Object.freeze({ securityBoundary: 'external-kms' as const,
    generateDataKey: async (input: ResponsesHistoryDataKeyRequest) => {
      validate(input); if (input.kmsKeyId !== options.keyId || input.keySpec !== 'AES_256') return fail();
      const result = await request('GenerateDataKey',{ KeyId: input.kmsKeyId, KeySpec:'AES_256',EncryptionContext:input.encryptionContext });
      if (result.KeyId !== input.kmsKeyId) return fail(); let plaintext: Buffer | undefined;
      try { plaintext = decode(result.Plaintext,32); if (plaintext.length !== 32) return fail(); const ciphertextBlob = decode(result.CiphertextBlob,16384); return { plaintextKey:plaintext,ciphertextBlob }; }
      catch { plaintext?.fill(0); return fail(); }
    },
    decryptDataKey: async (input: ResponsesHistoryDecryptRequest) => {
      validate(input); if (!(input.ciphertextBlob instanceof Uint8Array) || input.ciphertextBlob.length < 1 || input.ciphertextBlob.length > 16384) return fail();
      const result = await request('Decrypt',{ KeyId:input.kmsKeyId,CiphertextBlob:Buffer.from(input.ciphertextBlob).toString('base64'),EncryptionAlgorithm:'SYMMETRIC_DEFAULT',EncryptionContext:input.encryptionContext });
      if (result.KeyId !== input.kmsKeyId || (result.EncryptionAlgorithm !== undefined && result.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT')) return fail(); const key = decode(result.Plaintext,32); if (key.length !== 32) { key.fill(0); return fail(); } return key;
    },
    checkReady: async () => {
      const encryptionContext = Object.freeze({ purpose: RESPONSES_HISTORY_KMS_PURPOSE, version: '2', keyId: options.keyId, aadSha256: sha('responses-history-readiness-v2') });
      let generated: { readonly plaintextKey: Uint8Array; readonly ciphertextBlob: Uint8Array } | undefined, decrypted: Uint8Array | undefined;
      try { generated = await adapter.generateDataKey({kmsKeyId:options.keyId,keySpec:'AES_256',encryptionContext}); decrypted = await adapter.decryptDataKey({kmsKeyId:options.keyId,ciphertextBlob:generated.ciphertextBlob,encryptionContext}); if (decrypted.length !== generated.plaintextKey.length || !timingSafeEqual(decrypted,generated.plaintextKey)) fail(); }
      finally { generated?.plaintextKey.fill(0); decrypted?.fill(0); }
    },
    diagnostics: () => Object.freeze({ credentialExpiresAt, retainedDecryptKeyIds: Object.freeze([...retained]) }),
    close: async () => { closed = true; for (const controller of inflight) controller.abort(); inflight.clear(); },
  });
  return adapter;
}
/** Named factory consumed by SAAS_RESPONSES_HISTORY_KMS_MODULE. */
export function createResponsesHistoryKms(options: ResponsesHistoryKmsFactoryOptions): ResponsesHistoryKms { return createAwsResponsesHistoryKms(options); }
