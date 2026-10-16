import { PlatformApiError } from '../api/saas-platform-client';

/**
 * Shared platform-console primitives for the F5 feature pages (task #38).
 * Kept in a leaf module so the feature pages never import saas-platform.tsx
 * (which mounts them) and create a module cycle.
 */

export type MeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; me: { userId: string; roles: readonly string[] } }
  | { kind: 'unavailable' }
  | { kind: 'error'; error: unknown };

export function canManageSupply(me: MeState): boolean {
  return me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');
}

function sharedErrorMessage(error: unknown): string {
  if (error instanceof PlatformApiError) {
    if (error.status === 401) return '平台管理员会话已失效，请重新登录。';
    if (error.status === 403) return '当前管理员角色未获准执行此操作（服务端授权）。';
    if (error.status === 404 || error.status === 405 || error.status === 501) return '此管理接口当前不可用或尚未接入。';
    if (error.status === 409) return '目标已被并发修改（版本冲突）；请刷新后重试。';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

export function PlatformErrorNotice({
  error,
  onRetry,
  title = '操作失败',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <strong>{title}</strong>
      <span>{sharedErrorMessage(error)}</span>
      {onRetry && <button type="button" onClick={onRetry}>重试</button>}
    </div>
  );
}
