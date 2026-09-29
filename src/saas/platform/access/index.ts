export type { PlatformAdminAllowedRoles } from './authorization.js';
export { hasPlatformRole } from './authorization.js';
export { createPlatformAdminAccessService } from './service.js';
export {
  isPlatformAdminRole,
  PLATFORM_ADMIN_ROLES,
  type PlatformAdminAccessRequest,
  type PlatformAdminAccessService,
  type PlatformAdminAccessServiceOptions,
  type PlatformAdminActor,
  type PlatformAdminRole,
} from './types.js';
