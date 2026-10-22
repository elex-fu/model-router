import { createHash, randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../db/types.js';
import { PostgresUnknownOutcomeOperatorAuthorizationAdapter } from '../metering/postgres-unknown-outcome-operator-authorization.js';

export interface MediaRequeueCommand {
  readonly actorUserId: string;
  readonly actorSessionId: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly expectedLeaseEpoch: number;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface MediaRequeueReceipt {
  readonly status: 'queued' | 'replayed';
  readonly auditEventId: string;
  readonly leaseEpoch: number;
  readonly queuedAt: string;
}

export class OperationsActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'TASK_NOT_FOUND' | 'TASK_STATE_CONFLICT' | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

export interface OperationsActions {
  requeueVideo(input: MediaRequeueCommand): Promise<MediaRequeueReceipt>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeText(value: string, max: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    [...value].every((character) => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f)
  );
}

/** Moves the existing poll cursor; it never dispatches a create or changes financial state. */
export class PostgresOperationsActionService implements OperationsActions {
  constructor(private readonly database: SaasDatabase) {}

  async requeueVideo(input: MediaRequeueCommand): Promise<MediaRequeueReceipt> {
    if (
      !input ||
      !UUID.test(input.actorUserId) ||
      !UUID.test(input.actorSessionId) ||
      !safeText(input.tenantId, 255) ||
      !safeText(input.taskId, 255) ||
      !safeText(input.reason, 1000) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedLeaseEpoch) ||
      input.expectedLeaseEpoch < 0 ||
      input.expectedLeaseEpoch >= Number.MAX_SAFE_INTEGER
    ) {
      throw new OperationsActionError('INVALID_INPUT');
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify(['ops-video-requeue-v1', input.tenantId, input.taskId, input.expectedLeaseEpoch, input.reason]),
      )
      .digest('hex');
    return this.database.transaction(async (tx) => {
      const auth = new PostgresUnknownOutcomeOperatorAuthorizationAdapter(this.database);
      if (
        !(await auth.revalidateMayResolveUnknownOutcome({
          executor: tx,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorSessionId: input.actorSessionId,
        }))
      ) {
        throw new OperationsActionError('FORBIDDEN');
      }
      // Serialize identical keys before reading the receipt; a timeout retry replays the committed result.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        `ops-media-requeue:${input.actorUserId}:${input.idempotencyKey}`,
      ]);
      const prior = await tx.query<{
        request_digest: string;
        audit_event_id: string;
        result_lease_epoch: string | number;
        recorded_at: Date | string;
      }>(
        `SELECT request_digest, audit_event_id, result_lease_epoch, recorded_at FROM saas_ops_media_requeue_requests
          WHERE actor_user_id = $1 AND idempotency_key = $2`,
        [input.actorUserId, input.idempotencyKey],
      );
      const replay = prior.rows[0];
      if (replay) {
        if (replay.request_digest !== digest) throw new OperationsActionError('IDEMPOTENCY_CONFLICT');
        return {
          status: 'replayed',
          auditEventId: replay.audit_event_id,
          leaseEpoch: Number(replay.result_lease_epoch),
          queuedAt: new Date(replay.recorded_at).toISOString(),
        };
      }
      const task = await tx.query<{ tenant_id: string; lease_epoch: string | number; eligible: boolean }>(
        `SELECT tenant_id, lease_epoch,
                (billing_state = 'pending' AND expires_at > clock_timestamp()
                 AND (lease_until IS NULL OR lease_until <= clock_timestamp())) AS eligible
           FROM saas_video_tasks WHERE request_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.taskId, input.tenantId],
      );
      const current = task.rows[0];
      if (!current) throw new OperationsActionError('TASK_NOT_FOUND');
      if (!current.eligible || Number(current.lease_epoch) !== input.expectedLeaseEpoch)
        throw new OperationsActionError('TASK_STATE_CONFLICT');
      const updated = await tx.query<{ lease_epoch: string | number; next_poll_at: Date | string }>(
        `UPDATE saas_video_tasks SET next_poll_at = clock_timestamp(), lease_epoch = lease_epoch + 1
          WHERE request_id = $1 AND tenant_id = $2 AND lease_epoch = $3
            AND billing_state = 'pending' AND expires_at > clock_timestamp()
            AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          RETURNING lease_epoch, next_poll_at`,
        [input.taskId, input.tenantId, input.expectedLeaseEpoch],
      );
      const result = updated.rows[0];
      if (!result) throw new OperationsActionError('TASK_STATE_CONFLICT');
      const auditEventId = randomUUID();
      await tx.query(
        `INSERT INTO saas_audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point, request_id)
         VALUES ($1, NULL, $2, 'saas_media_task.poll_requeued', 'saas_video_tasks', $3, clock_timestamp(), 'ops-media-requeue', $4)`,
        [auditEventId, input.actorUserId, input.taskId, input.idempotencyKey],
      );
      await tx.query(
        `INSERT INTO saas_ops_media_requeue_requests
           (id, actor_user_id, actor_session_id, tenant_id, task_id, idempotency_key, request_digest,
            expected_lease_epoch, result_lease_epoch, reason, audit_event_id, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
        [
          randomUUID(),
          input.actorUserId,
          input.actorSessionId,
          input.tenantId,
          input.taskId,
          input.idempotencyKey,
          digest,
          input.expectedLeaseEpoch,
          Number(result.lease_epoch),
          input.reason,
          auditEventId,
          new Date(result.next_poll_at).toISOString(),
        ],
      );
      return {
        status: 'queued',
        auditEventId,
        leaseEpoch: Number(result.lease_epoch),
        queuedAt: new Date(result.next_poll_at).toISOString(),
      };
    });
  }
}
