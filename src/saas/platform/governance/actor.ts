import type { SqlExecutor } from '../../db/types.js';
import {
  hasPlatformRole,
  isPlatformAdminRole,
  type PlatformAdminActor,
  type PlatformAdminRole,
} from '../access/index.js';
import { governanceForbidden, governanceStorage } from './errors.js';

interface SessionRow {
  readonly id: unknown;
  readonly user_id: unknown;
}

interface RoleRow {
  readonly role: unknown;
}

/**
 * Fresh in-transaction proof of the platform administrator's session and role
 * assignments. The roles claimed at the HTTP boundary must match the current
 * database assignments exactly; any drift (role revoked mid-request, disabled
 * user, dead session) fails closed. Mirrors the capacity-policy write fence.
 */
export async function verifyGovernanceActor(
  tx: SqlExecutor,
  actor: PlatformAdminActor,
  acceptedRoles: readonly PlatformAdminRole[],
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:user:' || $1::uuid::text, 0))", [
    actor.userId,
  ]);

  const sessionResult = await tx.query<SessionRow>(
    `SELECT s.id, s.user_id
       FROM saas_platform_sessions AS s
       JOIN saas_users AS u ON u.id = s.user_id
       JOIN saas_mfa_credentials AS c
         ON c.id = s.credential_id AND c.user_id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2
        AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
        AND u.disabled_at IS NULL
        AND c.kind = 'totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
      LIMIT 2`,
    [actor.sessionId, actor.userId],
  );
  if (!sessionResult || !Array.isArray(sessionResult.rows)) governanceStorage();
  const sessions = sessionResult.rows;
  if (sessions.length !== 1) governanceForbidden();
  const session = sessions[0];
  if (session === undefined || session.id !== actor.sessionId || session.user_id !== actor.userId) {
    governanceForbidden();
  }

  const roleResult = await tx.query<RoleRow>(
    `SELECT role
       FROM saas_platform_role_assignments
      WHERE user_id = $1
      ORDER BY role ASC`,
    [actor.userId],
  );
  if (!roleResult || !Array.isArray(roleResult.rows)) governanceStorage();
  const assigned: PlatformAdminRole[] = [];
  const seen = new Set<PlatformAdminRole>();
  for (const row of roleResult.rows) {
    if (row === undefined || row === null || !isPlatformAdminRole(row.role) || seen.has(row.role)) {
      governanceForbidden();
    }
    seen.add(row.role);
    assigned.push(row.role);
  }
  const claimed = [...actor.roles].sort();
  const current = [...assigned].sort();
  if (claimed.length !== current.length || claimed.some((role, index) => role !== current[index])) {
    governanceForbidden();
  }
  if (!hasPlatformRole({ ...actor, roles: assigned }, acceptedRoles)) {
    governanceForbidden();
  }
}
