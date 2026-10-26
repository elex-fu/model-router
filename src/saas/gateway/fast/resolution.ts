import { randomUUID } from 'node:crypto';
import { parseMinorUnits } from '../../billing/money.js';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { PostgresUnknownOutcomeOperatorAuthorizationAdapter } from '../../metering/postgres-unknown-outcome-operator-authorization.js';
import { calculateFastReceiptCharge, fastJournalCanonicalJson, fastJournalDigest } from './journal.js';

export class FastResolutionError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_ELIGIBLE') {
    super(`FAST_RESOLUTION_${code}`);
  }
}
export interface FastResolutionInput {
  readonly tenantId: string;
  readonly intentId: string;
  /** Trusted session identity from the HTTP authenticator, never request JSON. */
  readonly actorUserId: string;
  readonly actorSessionId: string;
  readonly idempotencyKey: string;
  readonly kind: 'verified_usage' | 'non_execution';
  readonly chargeMinorUnits: string;
  readonly usage: Readonly<Record<string, string | null>>;
  /** Provider evidence locator and digest; a support ticket is not evidence. */
  readonly evidenceReference: string;
  readonly evidenceSha256: string;
  readonly supportTicketRef: string;
  readonly reason: string;
}
export interface FastResolutionResult {
  readonly resolutionId: string;
  readonly intentId: string;
  readonly replayed: boolean;
  readonly state: string;
}
export interface FastOutcomeCase {
  readonly intentId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly currency: string | null;
  readonly maxCostMinorUnits: string;
  readonly outcome: string | null;
  readonly state: string;
  readonly resolutionId: string | null;
  readonly resolutionKind: string | null;
  readonly sendDeadline: Date | string;
}
function uuid(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw new FastResolutionError('INVALID_INPUT');
  return value.toLowerCase();
}
function text(value: string, length: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > length || value.includes('\0'))
    throw new FastResolutionError('INVALID_INPUT');
  return value.trim();
}
function normalize(input: FastResolutionInput): FastResolutionInput {
  if (
    !input ||
    !['verified_usage', 'non_execution'].includes(input.kind) ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) ||
    !/^[a-f0-9]{64}$/.test(input.evidenceSha256)
  )
    throw new FastResolutionError('INVALID_INPUT');
  parseMinorUnits(input.chargeMinorUnits, { allowZero: true });
  if (!input.usage || typeof input.usage !== 'object' || Array.isArray(input.usage))
    throw new FastResolutionError('INVALID_INPUT');
  const allowed = new Set([
    'inputTotal',
    'inputUncached',
    'cacheRead',
    'cacheWrite',
    'cacheWrite5m',
    'cacheWrite1h',
    'outputTotal',
    'reasoningOutput',
  ]);
  for (const [key, value] of Object.entries(input.usage)) {
    if (!allowed.has(key)) throw new FastResolutionError('INVALID_INPUT');
    if (value !== null) parseMinorUnits(value, { allowZero: true });
  }
  if (input.kind === 'non_execution' && (input.chargeMinorUnits !== '0' || Object.keys(input.usage).length))
    throw new FastResolutionError('INVALID_INPUT');
  return {
    ...input,
    tenantId: uuid(input.tenantId),
    intentId: uuid(input.intentId),
    actorUserId: uuid(input.actorUserId),
    actorSessionId: uuid(input.actorSessionId),
    evidenceReference: text(input.evidenceReference, 512),
    supportTicketRef: text(input.supportTicketRef, 255),
    reason: text(input.reason, 2000),
    usage: JSON.parse(fastJournalCanonicalJson(input.usage)) as Readonly<Record<string, string | null>>,
  };
}

const CASE_SELECT = `SELECT i.id AS "intentId",i.request_id AS "requestId",i.attempt_id AS "attemptId",
  i.tenant_id AS "tenantId",i.currency,i.max_cost_minor_units::text AS "maxCostMinorUnits",
  r.outcome,COALESCE(j.state,'unresolved') AS state,x.id AS "resolutionId",x.kind AS "resolutionKind",
  i.send_deadline AS "sendDeadline" FROM saas_fast_gateway_intents i
  LEFT JOIN saas_fast_gateway_receipts r ON r.intent_id=i.id
  LEFT JOIN saas_fast_billing_jobs j ON j.intent_id=i.id
  LEFT JOIN saas_fast_gateway_resolutions x ON x.intent_id=i.id`;

/** Only the control-plane role can insert resolutions or reactivate a blocked job. */
export class FastGatewayResolutionService {
  private readonly authorization: PostgresUnknownOutcomeOperatorAuthorizationAdapter;
  constructor(private readonly database: SaasDatabase) {
    this.authorization = new PostgresUnknownOutcomeOperatorAuthorizationAdapter(database);
  }
  async listCases(input: { tenantId: string; limit?: number }): Promise<readonly FastOutcomeCase[]> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new FastResolutionError('INVALID_INPUT');
    return (
      await this.database.query<FastOutcomeCase>(
        `${CASE_SELECT}
      WHERE i.tenant_id=$1 AND j.state IS DISTINCT FROM 'completed' ORDER BY i.created_at,i.id LIMIT $2`,
        [uuid(input.tenantId), limit],
      )
    ).rows;
  }
  async getCase(input: { tenantId: string; intentId: string }): Promise<FastOutcomeCase | null> {
    return (
      (
        await this.database.query<FastOutcomeCase>(`${CASE_SELECT} WHERE i.tenant_id=$1 AND i.id=$2`, [
          uuid(input.tenantId),
          uuid(input.intentId),
        ])
      ).rows[0] ?? null
    );
  }
  async resolve(raw: FastResolutionInput): Promise<FastResolutionResult> {
    let input: FastResolutionInput;
    try {
      input = normalize(raw);
    } catch (error) {
      if (error instanceof FastResolutionError) throw error;
      throw new FastResolutionError('INVALID_INPUT');
    }
    const requestDigest = fastJournalDigest(input);
    const work = async (tx: SqlExecutor): Promise<FastResolutionResult> => {
      // First transaction operation: fresh RC snapshot behind the same per-user
      // authorization fence used by session/role revocation writers.
      if (
        !(await this.authorization.revalidateMayResolveUnknownOutcome({
          executor: tx,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorSessionId: input.actorSessionId,
        }))
      )
        throw new FastResolutionError('FORBIDDEN');
      const replay = await this.existing(tx, input, requestDigest);
      if (replay) return replay;
      const intent = (
        await tx.query<{
          request_id: string;
          max_cost_minor_units: string;
          price_snapshot: unknown;
          deadline_passed: boolean;
        }>(
          `SELECT request_id,max_cost_minor_units,price_snapshot,send_deadline <= clock_timestamp() AS deadline_passed
         FROM saas_fast_gateway_intents WHERE id=$1 AND tenant_id=$2`,
          [input.intentId, input.tenantId],
        )
      ).rows[0];
      if (!intent) throw new FastResolutionError('NOT_FOUND');
      if (!intent.deadline_passed) throw new FastResolutionError('NOT_ELIGIBLE');
      const job = (
        await tx.query<{ state: string }>('SELECT state FROM saas_fast_billing_jobs WHERE intent_id=$1 FOR UPDATE', [
          input.intentId,
        ])
      ).rows[0];
      if (job && job.state !== 'blocked') {
        const concurrent = await this.existing(tx, input, requestDigest);
        if (concurrent) return concurrent;
        throw new FastResolutionError('NOT_ELIGIBLE');
      }
      let charge: bigint;
      try {
        charge = input.kind === 'non_execution' ? 0n : calculateFastReceiptCharge(intent.price_snapshot, input.usage);
      } catch {
        throw new FastResolutionError('INVALID_INPUT');
      }
      if (charge !== BigInt(input.chargeMinorUnits) || charge > BigInt(intent.max_cost_minor_units))
        throw new FastResolutionError('INVALID_INPUT');
      // The job fence can wait past natural session expiry; the user fence
      // blocks revocation writers but cannot stop time. Re-read authority now.
      if (
        !(await new PostgresUnknownOutcomeOperatorAuthorizationAdapter(tx).mayResolveUnknownOutcome({
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorSessionId: input.actorSessionId,
        }))
      )
        throw new FastResolutionError('FORBIDDEN');
      const id = randomUUID();
      await tx.query(
        `INSERT INTO saas_fast_gateway_resolutions
        (id,intent_id,tenant_id,request_id,kind,actor_user_id,actor_session_id,idempotency_key,request_digest,
         charge_minor_units,usage,usage_digest,evidence_reference,evidence_sha256,support_ticket_ref,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)`,
        [
          id,
          input.intentId,
          input.tenantId,
          intent.request_id,
          input.kind,
          input.actorUserId,
          input.actorSessionId,
          input.idempotencyKey,
          requestDigest,
          input.chargeMinorUnits,
          fastJournalCanonicalJson(input.usage),
          fastJournalDigest(input.usage),
          input.evidenceReference,
          input.evidenceSha256,
          input.supportTicketRef,
          input.reason,
        ],
      );
      // If a receipt/worker raced the missing-job case, only a still-blocked
      // job may be reactivated. Completed or pending success rolls back the
      // resolution insertion rather than overriding a financial outcome.
      const queued = await tx.query(
        `INSERT INTO saas_fast_billing_jobs(intent_id,state) VALUES($1,'pending')
        ON CONFLICT(intent_id) DO UPDATE SET state='pending' WHERE saas_fast_billing_jobs.state='blocked'
        RETURNING intent_id`,
        [input.intentId],
      );
      if (queued.rowCount !== 1) throw new FastResolutionError('NOT_ELIGIBLE');
      // The missing-job upsert can itself wait for a concurrent receipt writer.
      if (
        !(await new PostgresUnknownOutcomeOperatorAuthorizationAdapter(tx).mayResolveUnknownOutcome({
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorSessionId: input.actorSessionId,
        }))
      )
        throw new FastResolutionError('FORBIDDEN');
      return { resolutionId: id, intentId: input.intentId, replayed: false, state: 'pending' };
    };
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '23505') throw error;
      return this.database.transaction(async (tx) => {
        if (
          !(await this.authorization.revalidateMayResolveUnknownOutcome({
            executor: tx,
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorSessionId: input.actorSessionId,
          }))
        )
          throw new FastResolutionError('FORBIDDEN');
        const replay = await this.existing(tx, input, requestDigest);
        if (!replay) throw new FastResolutionError('CONFLICT');
        return replay;
      });
    }
  }
  private async existing(
    tx: SqlExecutor,
    input: FastResolutionInput,
    requestDigest: string,
  ): Promise<FastResolutionResult | null> {
    const found = (
      await tx.query<{ id: string; request_digest: string; state: string }>(
        `SELECT x.id,x.request_digest,j.state
      FROM saas_fast_gateway_resolutions x JOIN saas_fast_billing_jobs j ON j.intent_id=x.intent_id
      WHERE x.intent_id=$1 AND x.tenant_id=$2`,
        [input.intentId, input.tenantId],
      )
    ).rows[0];
    if (!found) return null;
    if (found.request_digest !== requestDigest) throw new FastResolutionError('CONFLICT');
    return { resolutionId: found.id, intentId: input.intentId, replayed: true, state: found.state };
  }
}
