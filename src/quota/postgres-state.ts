import { randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../saas/db/types.js';
import type { QuotaStateBatch, QuotaStatePersistence, QuotaStateRow } from './redis-state.js';

/** Shared SQL sink. Schema is installed only by the explicit SaaS migrator. */
export class PostgresQuotaStatePersistence implements QuotaStatePersistence {
  constructor(
    private readonly database: SaasDatabase,
    private readonly namespace: string,
  ) {}
  async identity(): Promise<string> {
    await this.database.query(
      'INSERT INTO saas_redis_quota_metadata(namespace,identity) VALUES ($1,$2) ON CONFLICT(namespace) DO NOTHING',
      [this.namespace, randomUUID()],
    );
    const result = await this.database.query<{ identity: string }>(
      'SELECT identity FROM saas_redis_quota_metadata WHERE namespace=$1',
      [this.namespace],
    );
    if (!result.rows[0]) throw new Error('Quota persistence identity unavailable');
    return result.rows[0].identity;
  }
  async generation(): Promise<number> {
    const result = await this.database.query<{ generation: string }>(
      'SELECT generation FROM saas_redis_quota_metadata WHERE namespace=$1',
      [this.namespace],
    );
    return Number(result.rows[0]?.generation);
  }
  async beginGeneration(expected: number): Promise<number> {
    const result = await this.database.query<{ generation: string }>(
      'UPDATE saas_redis_quota_metadata SET generation=generation+1 WHERE namespace=$1 AND generation=$2 RETURNING generation',
      [this.namespace, expected],
    );
    const generation = Number(result.rows[0]?.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid quota generation');
    return generation;
  }
  async load(keys: string[]): Promise<QuotaStateRow[]> {
    const result = await this.database.query<{ key: string; version: string; value: unknown }>(
      'SELECT key,version,value FROM saas_redis_quota_state WHERE namespace=$1 AND key=ANY($2::text[])',
      [this.namespace, keys],
    );
    return result.rows.map((row) => ({ key: row.key, version: Number(row.version), value: row.value }));
  }
  async apply(batches: QuotaStateBatch[]): Promise<void> {
    if (!batches.length) return;
    await this.database.transaction(async (tx) => {
      const result = await tx.query<{ generation: string }>(
        'SELECT generation FROM saas_redis_quota_metadata WHERE namespace=$1 FOR SHARE',
        [this.namespace],
      );
      const generation = Number(result.rows[0]?.generation);
      if (batches.some((batch) => batch.generation !== generation))
        throw new Error('Stale quota persistence generation');
      // Compact the batch by key, keeping the newest full state. This avoids
      // both row-by-row round trips and duplicate conflict targets in one INSERT.
      const latest = new Map<string, QuotaStateRow>();
      for (const batch of batches)
        for (const row of batch.rows) if ((latest.get(row.key)?.version ?? -1) < row.version) latest.set(row.key, row);
      const rows = [...latest.values()];
      await tx.query(
        `INSERT INTO saas_redis_quota_state(namespace,key,generation,version,value,projection_pending)
        SELECT $1,entry.key,$2,entry.version,entry.value,entry.value->>'kind'='capacityRequest' FROM jsonb_to_recordset($3::jsonb) AS entry(key text,version bigint,value jsonb)
        ON CONFLICT(namespace,key) DO UPDATE SET generation=excluded.generation,version=excluded.version,value=excluded.value,projection_pending=excluded.projection_pending
        WHERE excluded.generation>saas_redis_quota_state.generation OR (excluded.generation=saas_redis_quota_state.generation AND excluded.version>saas_redis_quota_state.version)`,
        [this.namespace, generation, JSON.stringify(rows)],
      );
    });
  }
  async ping(generation?: number): Promise<void> {
    if (generation !== undefined && (await this.generation()) !== generation)
      throw new Error('Stale quota persistence generation');
    await this.database.ping();
  }
  async expiredRequests(nowMs: number, limit: number): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT value->>'requestId' AS id FROM saas_redis_quota_state
      WHERE namespace=$1 AND value->>'kind'='request' AND ((value->>'state'='active' AND (value->>'deadlineMs')::bigint<=$2)
      OR (value->>'state'='retained' AND (value->>'periodEndMs')::bigint<=$2)) LIMIT $3`,
      [this.namespace, nowMs, limit],
    );
    return result.rows.map((row) => row.id);
  }
}
