export type TenantRole = 'owner' | 'admin' | 'developer' | 'billing' | 'viewer';
export type ProjectRole = 'owner' | 'admin' | 'developer' | 'billing' | 'viewer';
export type InvitationRole = Exclude<TenantRole, 'owner'>;

/**
 * A server-resolved customer authorization context. Tenant and project IDs
 * supplied by a client are selectors only; callers must obtain this context
 * from the identity service before using it for authorization.
 */
export interface TenantContext {
  userId: string;
  tenantId: string;
  projectId: string;
  tenantRole: TenantRole;
  projectRole: ProjectRole;
}

export interface TenantContextInput {
  userId: string;
  tenantId: string;
  projectId?: string;
}

export interface SafeIdentity {
  id: string;
  email: string;
  displayName: string | null;
  status: 'active';
  emailVerifiedAt: string | null;
  createdAt: string;
}

/** Minimal result for platform authentication; no password or role data leaves the service. */
export interface PlatformAdminPasswordAuthentication {
  userId: string;
  email: string;
}

export interface SafeSession {
  userId: string;
  /** Tenant selection is request context and is not stored in the session row. */
  activeTenantId: null;
  expiresAt: string;
  createdAt: string;
}

export interface SafeTenant {
  id: string;
  name: string;
  slug: string;
  status: 'active';
  role: TenantRole;
  createdAt: string;
  updatedAt: string;
  /** Stable ID of the tenant's first persisted (default) project. */
  defaultProjectId: string;
}

export interface BootstrapAdminInput {
  token: string;
  email: string;
  password: string;
  displayName: string;
}

export interface LoginInput {
  email: string;
  password: string;
  /** Accepted for transport compatibility; tenant context is resolved per request, not at login. */
  activeTenantId?: string;
  ttlSeconds: number;
}

export interface CreateTenantInput {
  name: string;
  slug?: string;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
}

export interface SafeProject {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

/** Membership state, with a disabled account shown as disabled (not as active). */
export type TenantMemberStatus = 'active' | 'suspended' | 'revoked' | 'disabled';

/** Owner/admin-only directory projection. No email, credentials or sessions. */
export interface SafeTenantMember {
  userId: string;
  displayName: string | null;
  role: TenantRole;
  status: TenantMemberStatus;
}

export interface TenantMemberQuery {
  cursor?: string;
  /** Default 25; maximum 100. */
  limit?: number;
}

export interface TenantMemberPage {
  items: SafeTenantMember[];
  nextCursor: string | null;
}

export interface CreateInvitationInput {
  email: string;
  role: InvitationRole;
  ttlSeconds?: number;
}

export interface AcceptInvitationInput {
  token: string;
  email: string;
  displayName: string;
  password: string;
}

/** Inject the clock for deterministic expiry tests; cryptographic randomness stays system-backed. */
export interface SaasIdentityServiceOptions {
  now?: () => Date;
}
