import type { SqlExecutor } from '../db/types.js';
import type {
  UnknownOutcomeOperatorAuthorizationPort,
  UnknownOutcomeOperatorAuthorizationPreflightInput,
  UnknownOutcomeOperatorAuthorizationTransactionInput,
} from './unknown-outcome-recovery-worker.js';

interface AuthorizationRow {
  readonly authorized: number;
}

const CURRENT_AUTHORIZATION_SQL = `
  SELECT 1 AS authorized
    FROM saas_users AS u
    JOIN saas_platform_sessions AS s
      ON s.user_id = u.id
    JOIN saas_platform_role_assignments AS r
      ON r.user_id = u.id
   WHERE u.id = $1
     AND s.id = $2
     AND s.user_id = $1
     AND u.disabled_at IS NULL
     AND u.anonymized_at IS NULL
     AND s.revoked_at IS NULL
     AND s.expires_at > clock_timestamp()
     AND r.role IN ('operations', 'superadmin')
   LIMIT 1`;

/**
 * PostgreSQL authorization for operator resolution of unknown outcomes.
 *
 * The preflight is deliberately non-authoritative and may use the pool
 * executor. The transaction recheck must be the first operation in the
 * resolution transaction: READ COMMITTED prevents a wait on the advisory
 * fence from leaving a REPEATABLE READ snapshot stale, then the per-user
 * shared fence serializes against migrations 046/047 writers before the
 * ordinary authorization SELECT.
 */
export class PostgresUnknownOutcomeOperatorAuthorizationAdapter implements UnknownOutcomeOperatorAuthorizationPort {
  constructor(private readonly database: SqlExecutor) {}

  async mayResolveUnknownOutcome(input: UnknownOutcomeOperatorAuthorizationPreflightInput): Promise<boolean> {
    try {
      return await this.readCurrentAuthorization(this.database, input.actorUserId, input.actorSessionId);
    } catch {
      return false;
    }
  }

  async revalidateMayResolveUnknownOutcome(
    input: UnknownOutcomeOperatorAuthorizationTransactionInput,
  ): Promise<boolean> {
    try {
      // This must be the first transaction statement. It makes a later
      // authorization SELECT acquire a fresh snapshot after any fence wait.
      await input.executor.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await input.executor.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [
        input.actorUserId,
      ]);
      return await this.readCurrentAuthorization(input.executor, input.actorUserId, input.actorSessionId);
    } catch {
      return false;
    }
  }

  private async readCurrentAuthorization(
    executor: SqlExecutor,
    actorUserId: string,
    actorSessionId: string,
  ): Promise<boolean> {
    const result = await executor.query<AuthorizationRow>(CURRENT_AUTHORIZATION_SQL, [actorUserId, actorSessionId]);
    return Array.isArray(result.rows) && result.rows.length === 1;
  }
}

/** Short name retained for callers that treat this as the concrete port. */
export { PostgresUnknownOutcomeOperatorAuthorizationAdapter as PostgresUnknownOutcomeOperatorAuthorization };
