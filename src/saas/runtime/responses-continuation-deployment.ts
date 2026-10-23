import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { SqlExecutor } from '../db/types.js';
import { AesGcmResponsesHistoryCipher } from '../gateway/responses-continuation-cipher.js';
import { PostgresResponsesContinuationHistory } from '../gateway/responses-continuation-postgres.js';
import { PersistentResponsesContinuationResolver } from '../gateway/responses-continuation-resolver.js';
import type { ProviderLoaderOptions } from './providers.js';
import { loadResponsesHistoryKmsCipher, ResponsesHistoryRuntimeError, KmsResponsesHistoryCipher, type ResponsesHistoryDeploymentDiagnostics } from './responses-history-kms.js';
export const MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE = 'MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE';
const PREFIX = 'MODEL_ROUTER_SAAS_RESPONSES_HISTORY_';
export interface LoadedResponsesContinuationDeployment {
  readonly resolver: PersistentResponsesContinuationResolver;
  readonly readiness: 'production-kms' | 'pilot-file-keyring';
  diagnostics?(): ResponsesHistoryDeploymentDiagnostics;
  checkReady(): Promise<void>;
  purgeExpired(limit?: number): Promise<number>;
  close(): Promise<void>;
}
export interface ResponsesContinuationDeploymentOptions extends ProviderLoaderOptions { readonly database: SqlExecutor }
function invalid(): never { throw new ResponsesHistoryRuntimeError('CONFIGURATION_INVALID'); }
function number(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) return invalid();
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed > max) return invalid(); return parsed;
}
async function pilotCipher(path: string | undefined): Promise<AesGcmResponsesHistoryCipher> {
  if (!path || !path.startsWith('/')) return invalid();
  let bytes: Buffer | undefined;
  const keys = new Map<string,Buffer>();
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64*1024 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return invalid();
      bytes = await file.readFile();
    } finally { await file.close(); }
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid();
    const ring = data as { version?: unknown; currentKeyId?: unknown; keys?: unknown };
    if (ring.version !== 1 || typeof ring.currentKeyId !== 'string' || !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys) || Object.keys(ring.keys).length > 32) return invalid();
    for (const [id,key] of Object.entries(ring.keys)) { if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) return invalid(); keys.set(id,Buffer.from(key,'hex')); }
    return new AesGcmResponsesHistoryCipher(ring.currentKeyId,keys);
  } catch { return invalid(); } finally { bytes?.fill(0); for (const key of keys.values()) key.fill(0); }
}
/** Standard HTTP/WS runtime assembly. Disabled means no persistent continuation promise. */
export async function loadResponsesContinuationDeployment(options: ResponsesContinuationDeploymentOptions): Promise<LoadedResponsesContinuationDeployment | undefined> {
  const env = options.env ?? process.env; const mode = env[MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE] ?? 'disabled';
  if (mode === 'disabled') return undefined;
  if (mode !== 'production-kms' && mode !== 'pilot-file-keyring') return invalid();
  const ttlMs = number(env[`${PREFIX}TTL_MS`],3600000,86400000), maxBytes = number(env[`${PREFIX}MAX_BYTES`],4194304,16777216);
  let cipher: KmsResponsesHistoryCipher | AesGcmResponsesHistoryCipher;
  if (mode === 'production-kms') {
    if (env[`${PREFIX}KEYRING_FILE`] !== undefined) return invalid();
    const keyId = env[`${PREFIX}KMS_KEY_ID`]; if (!keyId) return invalid();
    cipher = await loadResponsesHistoryKmsCipher(keyId,options);
  } else {
    if (env.SAAS_RESPONSES_HISTORY_KMS_MODULE !== undefined || env[`${PREFIX}KMS_KEY_ID`] !== undefined) return invalid();
    cipher = await pilotCipher(env[`${PREFIX}KEYRING_FILE`]);
  }
  const history = new PostgresResponsesContinuationHistory(options.database);
  let closed = false, closing: Promise<void> | undefined;
  const checkReady = async (): Promise<void> => {
    if (closed) throw new ResponsesHistoryRuntimeError('CLOSED');
    try {
      // Read the exact deployed schema and check all privileges needed by persistence/expiry.
      await options.database.query(`SELECT tenant_id, project_id, proxy_key_id, conversation_id, response_id, provider_id, product_id, account_id, credential_id, credential_version, credential_authz_version, public_model, resolved_model, canonical_context_digest, encryption_key_id, encrypted_context, created_at, expires_at FROM saas_responses_continuation_contexts LIMIT 0`);
      const result = await options.database.query<{ allowed: boolean }>(`SELECT (has_table_privilege(current_user,'saas_responses_continuation_contexts','SELECT') AND has_table_privilege(current_user,'saas_responses_continuation_contexts','INSERT') AND has_table_privilege(current_user,'saas_responses_continuation_contexts','DELETE')) AS allowed`);
      if (result.rows[0]?.allowed !== true) throw new ResponsesHistoryRuntimeError('READINESS_FAILED');
      if (cipher instanceof KmsResponsesHistoryCipher) await cipher.checkReady();
    } catch { throw new ResponsesHistoryRuntimeError('READINESS_FAILED'); }
  };
  try { await checkReady(); } catch (error) { await Promise.resolve().then(() => cipher.close()).catch(() => {}); throw error; }
  const resolver = new PersistentResponsesContinuationResolver({history,cipher,maxBytes,ttlMs});
  return Object.freeze({ resolver, readiness: mode, checkReady,
    diagnostics: (): ResponsesHistoryDeploymentDiagnostics => cipher instanceof KmsResponsesHistoryCipher ? cipher.diagnostics() : Object.freeze({purpose:'responses-canonical-history/v1',verification:closed ? 'closed' : 'pilot_only',productionEvidence:'external_evidence_required'}),
    purgeExpired: async (limit = 100) => { if (closed) throw new ResponsesHistoryRuntimeError('CLOSED'); return history.purgeExpired(Date.now(),limit); },
    close: () => { if (!closing) { closed = true; closing = Promise.resolve().then(() => cipher.close()); } return closing; },
  });
}
