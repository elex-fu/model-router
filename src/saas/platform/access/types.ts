import type { IncomingMessage } from 'node:http';
import type { SqlExecutor } from '../../db/types.js';
import type { PlatformAdminAuthHttpService } from '../auth/http.js';

/** The only platform-admin roles accepted by the database contract. */
export const PLATFORM_ADMIN_ROLES = Object.freeze([
  'superadmin',
  'security',
  'finance',
  'operations',
  'support-readonly',
] as const);

export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

export function isPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return typeof value === 'string' && (PLATFORM_ADMIN_ROLES as readonly string[]).includes(value);
}

/** The request shape needed by the read-only authenticator. */
export type PlatformAdminAccessRequest = Pick<IncomingMessage, 'headers'>;

/** Server-resolved identity and current platform role assignments. */
export interface PlatformAdminActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly PlatformAdminRole[];
}

export interface PlatformAdminAccessService {
  authenticate(request: PlatformAdminAccessRequest): Promise<PlatformAdminActor | undefined>;
}

export interface PlatformAdminAccessServiceOptions {
  readonly authService: Pick<PlatformAdminAuthHttpService, 'getSession'>;
  /** A SaasDatabase or any read-only SqlExecutor implementation. */
  readonly database: SqlExecutor;
}
