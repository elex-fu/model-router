import type { SqlExecutor } from '../db/types.js';
import type { ResponsesContinuationHistoryPort, ResponsesHistoryRecord, ResponsesHistoryReference } from './responses-continuation-history.js';

type Row = Record<string, unknown>;
function text(value: unknown): string { if (typeof value !== 'string' || value === '') throw new Error('Invalid history storage record'); return value; }
function decode(row: Row): ResponsesHistoryRecord {
  const reference = { tenantId: text(row.tenant_id), projectId: text(row.project_id), proxyKeyId: text(row.proxy_key_id), conversationId: text(row.conversation_id), responseId: text(row.response_id) };
  if (!(row.encrypted_context instanceof Uint8Array)) throw new Error('Invalid history storage record');
  return {
    ...reference,
    identity: { tenantId: reference.tenantId, projectId: reference.projectId, proxyKeyId: reference.proxyKeyId, conversationId: reference.conversationId, providerId: text(row.provider_id), productId: text(row.product_id), accountId: text(row.account_id), credentialId: text(row.credential_id), credentialVersion: String(row.credential_version), credentialAuthzVersion: String(row.credential_authz_version), publicModel: text(row.public_model), resolvedModel: text(row.resolved_model) },
    canonicalContextDigest: text(row.canonical_context_digest), encryptionKeyId: text(row.encryption_key_id), encryptedContext: new Uint8Array(row.encrypted_context),
    createdAtMs: new Date(row.created_at as string | Date).getTime(), expiresAtMs: new Date(row.expires_at as string | Date).getTime(),
  };
}
function referenceValues(reference: ResponsesHistoryReference): readonly string[] { return [reference.tenantId, reference.proxyKeyId, reference.conversationId, reference.responseId, reference.projectId]; }
const PREDICATE = 'tenant_id=$1 AND proxy_key_id=$2 AND conversation_id=$3 AND response_id=$4 AND project_id=$5';
export class PostgresResponsesContinuationHistory implements ResponsesContinuationHistoryPort {
  constructor(private readonly database: SqlExecutor) {}
  async find(reference: ResponsesHistoryReference, nowMs: number): Promise<ResponsesHistoryRecord | null> {
    const result = await this.database.query<Row>(`SELECT * FROM saas_responses_continuation_contexts WHERE ${PREDICATE} AND expires_at>clock_timestamp() LIMIT 1`, referenceValues(reference));
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
  async insert(record: ResponsesHistoryRecord): Promise<'inserted' | 'identical' | 'conflict'> {
    const identity = record.identity;
    const result = await this.database.query<Row>(`INSERT INTO saas_responses_continuation_contexts
      (tenant_id,proxy_key_id,conversation_id,response_id,project_id,provider_id,product_id,account_id,credential_id,credential_version,credential_authz_version,public_model,resolved_model,canonical_context_digest,encryption_key_id,encrypted_context,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING RETURNING response_id`,
    [...referenceValues(record), identity.providerId, identity.productId, identity.accountId, identity.credentialId, identity.credentialVersion, identity.credentialAuthzVersion, identity.publicModel, identity.resolvedModel, record.canonicalContextDigest, record.encryptionKeyId, Buffer.from(record.encryptedContext), new Date(record.createdAtMs), new Date(record.expiresAtMs)]);
    if (result.rows.length === 1) return 'inserted';
    const existing = await this.find(record, record.createdAtMs);
    return existing && existing.canonicalContextDigest === record.canonicalContextDigest && Object.entries(record.identity).every(([key, value]) => existing.identity[key as keyof typeof existing.identity] === value) && existing.createdAtMs === record.createdAtMs && existing.expiresAtMs === record.expiresAtMs ? 'identical' : 'conflict';
  }
  async delete(reference: ResponsesHistoryReference): Promise<void> { await this.database.query(`DELETE FROM saas_responses_continuation_contexts WHERE ${PREDICATE}`, referenceValues(reference)); }
  async purgeExpired(_nowMs: number, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid history purge limit');
    const result = await this.database.query(`DELETE FROM saas_responses_continuation_contexts WHERE (tenant_id,proxy_key_id,conversation_id,response_id) IN (SELECT tenant_id,proxy_key_id,conversation_id,response_id FROM saas_responses_continuation_contexts WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1)`, [limit]);
    return result.rowCount ?? 0;
  }
}
