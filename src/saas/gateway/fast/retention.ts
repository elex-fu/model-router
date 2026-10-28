import type { SaasDatabase } from '../../db/types.js';

export interface FastJournalRetentionOptions {
  /** Rows older than this are eligible. Defaults to 7 days. */
  readonly retentionMs?: number;
  /** Intents deleted per transaction batch. Defaults to 500 (max 1000). */
  readonly batchSize?: number;
  /** Maximum batches per call. Omit to loop until no candidates remain. */
  readonly maxBatches?: number;
}

export interface FastJournalRetentionResult {
  readonly deletedIntents: number;
  readonly batches: number;
  /** True when the last batch was full; more candidates may remain (maxBatches). */
  readonly exhausted: boolean;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_FLAG = 'model_router_saas.fast_retention';

/**
 * Deletes settled fast-ledger intents (and their receipts, jobs, resolutions
 * and liability releases) older than the retention window, in bounded
 * transactions so a large backlog never becomes one long lock hold.
 *
 * Eligibility requires the intent to be terminally settled: its billing job
 * reached 'completed', or an audited resolution exists. In-flight intents
 * (pending jobs, unresolved unknown outcomes) are never candidates, so the
 * retention task and the settlement worker cannot race on money rows. The
 * DELETEs are allowed only while the migration 149 transaction-local flag is
 * set; every runtime role otherwise keeps append-only guarantees.
 */
export async function runFastJournalRetention(
  database: SaasDatabase,
  options: FastJournalRetentionOptions = {},
): Promise<FastJournalRetentionResult> {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) throw new Error('FAST_RETENTION_INVALID_WINDOW');
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error('FAST_RETENTION_INVALID_BATCH');
  if (options.maxBatches !== undefined && (!Number.isSafeInteger(options.maxBatches) || options.maxBatches < 1))
    throw new Error('FAST_RETENTION_INVALID_BATCH');
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  let deletedIntents = 0;
  let batches = 0;
  let exhausted = false;
  for (;;) {
    if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
    const deleted = await database.transaction(async (tx) => {
      // Arm the guard inside the same transaction so the flag dies with COMMIT
      // or ROLLBACK and can never leak into a runtime session.
      await tx.query(`SELECT set_config('${RETENTION_FLAG}', 'on', true)`);
      const candidates = await tx.query<{ id: string }>(
        `SELECT i.id FROM saas_fast_gateway_intents i
         WHERE i.created_at < $1
           AND (EXISTS (SELECT 1 FROM saas_fast_billing_jobs j WHERE j.intent_id = i.id AND j.state = 'completed')
             OR EXISTS (SELECT 1 FROM saas_fast_gateway_resolutions x WHERE x.intent_id = i.id))
         ORDER BY i.created_at, i.id
         LIMIT $2
         FOR UPDATE OF i SKIP LOCKED`,
        [cutoff, batchSize],
      );
      if (candidates.rows.length === 0) return 0;
      const ids = candidates.rows.map((row) => row.id);
      // Children first; the guard trigger on each table still requires the flag.
      await tx.query(`DELETE FROM saas_fast_receipt_liability_releases WHERE intent_id = ANY($1::uuid[])`, [ids]);
      await tx.query(`DELETE FROM saas_fast_gateway_resolutions WHERE intent_id = ANY($1::uuid[])`, [ids]);
      await tx.query(`DELETE FROM saas_fast_gateway_receipts WHERE intent_id = ANY($1::uuid[])`, [ids]);
      await tx.query(`DELETE FROM saas_fast_billing_jobs WHERE intent_id = ANY($1::uuid[])`, [ids]);
      const removed = await tx.query(`DELETE FROM saas_fast_gateway_intents WHERE id = ANY($1::uuid[])`, [ids]);
      return removed.rowCount ?? 0;
    });
    batches++;
    deletedIntents += deleted;
    if (deleted < batchSize) {
      exhausted = false;
      break;
    }
    exhausted = true;
  }
  return { deletedIntents, batches, exhausted };
}
