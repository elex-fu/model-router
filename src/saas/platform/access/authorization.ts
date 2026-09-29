import { isPlatformAdminRole, type PlatformAdminActor, type PlatformAdminRole } from './types.js';

/**
 * Platform role matrix for endpoint-owned `allowedRoles` sets:
 *
 * | role | intended platform-admin area |
 * | --- | --- |
 * | superadmin | all platform-admin areas; global override |
 * | security | authentication, MFA, sessions, and access review |
 * | finance | billing, wallets, ledger, and financial reporting |
 * | operations | provider, catalog, route, and runtime operations |
 * | support-readonly | read-only support and diagnostics |
 *
 * `superadmin` overrides any non-empty, valid allowed-role set. It does not
 * authorize an actor with no assignments or an actor containing an unknown
 * role. This helper only evaluates identity/RBAC context; it does not grant
 * write access, perform CSRF/Origin checks, or define endpoint side effects.
 */
export type PlatformAdminAllowedRoles = PlatformAdminRole | readonly PlatformAdminRole[];

export function hasPlatformRole(
  actor: Pick<PlatformAdminActor, 'roles'> | null | undefined,
  allowedRoles: PlatformAdminAllowedRoles,
): boolean {
  const requestedRoles: readonly unknown[] = typeof allowedRoles === 'string' ? [allowedRoles] : allowedRoles;
  if (requestedRoles.length === 0 || requestedRoles.some((role) => !isPlatformAdminRole(role))) return false;
  if (!actor || !Array.isArray(actor.roles) || actor.roles.length === 0) return false;
  if (actor.roles.some((role) => !isPlatformAdminRole(role))) return false;

  if (actor.roles.includes('superadmin')) return true;
  const allowed = new Set(requestedRoles as readonly PlatformAdminRole[]);
  return actor.roles.some((role) => allowed.has(role));
}
