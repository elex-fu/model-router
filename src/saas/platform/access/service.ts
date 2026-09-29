import { PLATFORM_ADMIN_SESSION_COOKIE } from '../auth/http.js';
import type { PlatformAuthSession } from '../auth/types.js';
import {
  isPlatformAdminRole,
  type PlatformAdminAccessRequest,
  type PlatformAdminAccessService,
  type PlatformAdminAccessServiceOptions,
  type PlatformAdminActor,
  type PlatformAdminRole,
} from './types.js';

interface PlatformRoleRow {
  readonly role: unknown;
}

function extractSessionCookie(request: PlatformAdminAccessRequest | undefined): string | undefined {
  const header = request?.headers?.cookie;
  if (typeof header !== 'string') return undefined;

  let matches = 0;
  let value: string | undefined;
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    if (part.length === 0) continue;

    const separator = part.indexOf('=');
    if (separator < 0) {
      if (part === PLATFORM_ADMIN_SESSION_COOKIE) return undefined;
      continue;
    }
    if (part.slice(0, separator).trim() !== PLATFORM_ADMIN_SESSION_COOKIE) continue;

    matches += 1;
    if (matches > 1) return undefined;

    const encoded = part.slice(separator + 1).trim();
    if (encoded.length === 0) return undefined;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    if (value.length === 0) return undefined;
  }

  return matches === 1 ? value : undefined;
}

function isUsableSession(value: PlatformAuthSession | undefined): value is PlatformAuthSession {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.userId === 'string' &&
    value.userId.trim().length > 0
  );
}

function parseRoles(rows: readonly PlatformRoleRow[]): readonly PlatformAdminRole[] | undefined {
  if (rows.length === 0) return undefined;

  const roles: PlatformAdminRole[] = [];
  const seen = new Set<PlatformAdminRole>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || !isPlatformAdminRole(row.role)) return undefined;
    if (seen.has(row.role)) continue;
    seen.add(row.role);
    roles.push(row.role);
  }
  return roles.length > 0 ? roles : undefined;
}

function validateOptions(options: PlatformAdminAccessServiceOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (!options.authService || typeof options.authService.getSession !== 'function') {
    throw new TypeError('authService.getSession is required');
  }
  if (!options.database || typeof options.database.query !== 'function') {
    throw new TypeError('database.query is required');
  }
}

/**
 * Creates the read-only platform-admin identity/RBAC boundary.
 *
 * Missing, malformed, or ambiguous cookies, absent sessions, empty role
 * assignments, and unknown database roles all return no actor. Auth-service
 * and database errors are intentionally allowed to propagate so an HTTP
 * composition layer can distinguish infrastructure failure from a 401; no
 * credential value is included in either the returned actor or this module's
 * errors.
 */
export function createPlatformAdminAccessService(
  options: PlatformAdminAccessServiceOptions,
): PlatformAdminAccessService {
  validateOptions(options);

  return {
    async authenticate(request): Promise<PlatformAdminActor | undefined> {
      const token = extractSessionCookie(request);
      if (token === undefined) return undefined;

      const session = await options.authService.getSession(token);
      if (!isUsableSession(session)) return undefined;

      const result = await options.database.query<PlatformRoleRow>(
        `SELECT role
         FROM saas_platform_role_assignments
         WHERE user_id = $1
         ORDER BY role ASC`,
        [session.userId],
      );
      const roles = parseRoles(result.rows);
      if (roles === undefined) return undefined;

      return {
        userId: session.userId,
        sessionId: session.id,
        roles,
      };
    },
  };
}
