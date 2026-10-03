import { SaasApiError, type InvitationRole, type Project, type SafeTenant, type TenantRole } from '../api/saas-client';

export const workspaceRoleLabels: Record<TenantRole, string> = {
  owner: '所有者', admin: '管理员', developer: '开发者', billing: '账单管理员', viewer: '只读成员',
};

export const workspaceTenantsKey = (userId: string) => ['saas-console', 'tenants', 'workspace', userId] as const;
export const workspaceProjectsKey = (userId: string, tenantId: string) =>
  ['saas-console', 'projects', 'workspace', userId, tenantId] as const;
export const workspaceMembersRootKey = ['saas-console', 'workspace-members'] as const;
export const workspaceMembersKey = (userId: string, tenantId: string, cursor?: string) =>
  [...workspaceMembersRootKey, userId, tenantId, cursor ?? ''] as const;

export function canManageWorkspace(role: TenantRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function workspaceInvitationRoles(role: TenantRole): InvitationRole[] {
  if (role === 'owner') return ['admin', 'developer', 'billing', 'viewer'];
  if (role === 'admin') return ['developer', 'billing', 'viewer'];
  return [];
}

/** URL selectors are never grants; an explicit inaccessible selector does not fall back. */
export function selectWorkspaceTenant(tenants: readonly SafeTenant[], tenantId: string | null): SafeTenant | undefined {
  return tenantId === null ? tenants[0] : tenants.find(tenant => tenant.id === tenantId);
}

export function selectWorkspaceProject(
  tenant: SafeTenant, projects: readonly Project[], projectId: string | null,
): Project | undefined {
  const available = projects.filter(project => project.tenantId === tenant.id);
  return projectId === null
    ? available.find(project => project.id === tenant.defaultProjectId) ?? available[0]
    : available.find(project => project.id === projectId);
}

/** Never render an error's message, body, details, or unrecognized code. */
export function workspaceErrorMessage(error: unknown): string {
  if (error instanceof SaasApiError) {
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 403) return '权限不足或安全校验已失效，请刷新权限后重试。';
    if (error.status === 404) return '当前租户或资源不可访问，请刷新列表。';
    if (error.status === 409) return '操作冲突：成员可能已加入或存在待接受邀请；也可能是名称或标识已占用。请核对后再提交。';
    if (error.status === 429) return '请求过于频繁，请稍后重试。';
    if (error.status === 400 || error.status === 422) return '输入无效；邀请也可能已过期、已使用或与邮箱不匹配。请核对输入。';
  }
  return '暂时无法完成工作空间请求，请稍后重试。';
}

export function workspaceMutationUnknown(error: unknown): boolean {
  return !(error instanceof SaasApiError) || error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE';
}

export function workspaceInvitationLink(token: string, href: string): string {
  const url = new URL(href);
  const consoleIndex = url.pathname.indexOf('/console');
  const mount = consoleIndex < 0 ? '' : url.pathname.slice(0, consoleIndex);
  url.pathname = `${mount}/console/invitations/accept`;
  url.search = '';
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export type WorkspaceDraftKind = 'tenant' | 'project' | 'invitation' | 'accept';
export interface WorkspaceDraft { name?: string; slug?: string; role?: InvitationRole; uncertain?: boolean }
export interface WorkspaceDraftScope { userId: string; tenantId?: string; kind: WorkspaceDraftKind }

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const DRAFT_PREFIX = 'model-router:workspace-draft:v1:';
const DRAFT_TTL_MS = 30 * 60_000;
const sensitiveValue = /(?:api[\s_-]*key|proxy[\s_-]*key|token|password|credential|secret|authorization|prompt)|(?:^|\s)(?:sk|pk|rk|mr)[_-][a-z0-9_-]{8,}/i;
const draftFields: Record<WorkspaceDraftKind, readonly string[]> = {
  tenant: ['name', 'slug', 'uncertain'], project: ['name', 'slug', 'uncertain'],
  invitation: ['role', 'uncertain'], accept: ['name', 'uncertain'],
};

function browserStorage(): DraftStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

function draftKey(scope: WorkspaceDraftScope): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.tenantId ?? '')}:${scope.kind}`;
}

function safeDraft(kind: WorkspaceDraftKind, value: unknown): WorkspaceDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !draftFields[kind].includes(key))) return undefined;
  const result: WorkspaceDraft = {};
  // Explicit fields only. Email, password, token, link and API results never enter storage.
  if ('name' in row && typeof row.name === 'string' && row.name.length <= 120 && !sensitiveValue.test(row.name)) result.name = row.name;
  if ('slug' in row && typeof row.slug === 'string' && row.slug.length <= 64 && !sensitiveValue.test(row.slug)) result.slug = row.slug;
  if ('role' in row && (row.role === 'admin' || row.role === 'developer' || row.role === 'billing' || row.role === 'viewer')) result.role = row.role;
  if (typeof row.uncertain === 'boolean') result.uncertain = row.uncertain;
  return result;
}

/** Tab-local, short-lived, user/tenant-scoped metadata; never localStorage. */
export function readWorkspaceDraft(scope: WorkspaceDraftScope, storage = browserStorage(), now = Date.now()): WorkspaceDraft {
  try {
    const raw = storage?.getItem(draftKey(scope));
    if (!raw || raw.length > 2048) return {};
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const row = saved as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'expiresAt,value' || typeof row.expiresAt !== 'number' ||
      !Number.isFinite(row.expiresAt) || row.expiresAt <= now || row.expiresAt > now + DRAFT_TTL_MS) {
      storage?.removeItem(draftKey(scope));
      return {};
    }
    return safeDraft(scope.kind, row.value) ?? {};
  } catch { return {}; }
}

export function writeWorkspaceDraft(scope: WorkspaceDraftScope, value: WorkspaceDraft, storage = browserStorage(), now = Date.now()): void {
  try {
    const safe = safeDraft(scope.kind, value);
    if (!safe) { storage?.removeItem(draftKey(scope)); return; }
    storage?.setItem(draftKey(scope), JSON.stringify({ expiresAt: now + DRAFT_TTL_MS, value: safe }));
  } catch { /* A blocked or full storage never prevents a business operation. */ }
}

export function removeWorkspaceDraft(scope: WorkspaceDraftScope, storage = browserStorage()): void {
  try { storage?.removeItem(draftKey(scope)); } catch { /* Memory-only fallback. */ }
}

export function clearWorkspaceDrafts(userId: string, storage = browserStorage()): void {
  try {
    const prefix = `${DRAFT_PREFIX}${encodeURIComponent(userId)}:`;
    const keys: string[] = [];
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const key = storage?.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage?.removeItem(key);
  } catch { /* Do not clear other features' drafts. */ }
}
