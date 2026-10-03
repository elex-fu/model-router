import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  type ApiKeyMetadata,
  type ApiKeySupplyMode,
  type ConsoleBillableBasis,
  type ConsoleFinancialStatus,
  type ConsoleReconciliationState,
  type CustomerRefundStatus,
  type CustomerRefundSummary,
  type ConsoleQueryFilters,
  type ConsoleRequest,
  type ConsoleRequestStatus,
  type ConsoleUsageEvent,
  type ConsoleUsageStatus,
  type ConsoleUsageSummary,
  type CreatedCustomerWebhookEndpoint,
  type CustomerWebhookDeliveryHistoryEntry,
  type CustomerWebhookEndpoint,
  type CustomerWebhookEndpointInput,
  type CustomerWebhookEventType,
  type CustomerWebhookSecretMetadata,
  type CreatedApiKey,
  type CustomerSessionRevocation,
  type OtherCustomerSessionsRevocation,
  type Project,
  SaasApiError,
  type SafeCustomerSession,
  type SafeSession,
  type SafeTenant,
  type ServicePlanCatalogItem,
  type SessionResult,
  saasClient,
  type TenantByokCredential,
  type TenantByokCredentialCreateInput,
  type TenantByokCredentialLifecycleInput,
  type TenantByokCredentialStatus,
  type TenantByokValidationState,
  type TenantRole,
} from '../api/saas-client';
import { Badge, ErrorNotice, Field, Panel, SaveButton, State } from '../components/ui';
import { SaasWalletPage } from './saas-wallet';
import { ServicePlanPurchase } from './service-plan-purchase';
import { WorkspaceContent, WorkspaceInvitationAcceptance } from './saas-workspace';
import { clearWorkspaceDrafts, workspaceMembersRootKey, workspaceRoleLabels } from './saas-workspace-state';

const tenantsKey = ['saas-console', 'tenants'] as const;
const projectsRootKey = ['saas-console', 'projects'] as const;
const apiKeysRootKey = ['saas-console', 'api-keys'] as const;
const byokCredentialsRootKey = ['saas-console', 'byok-credentials'] as const;
const plansRootKey = ['saas-console', 'service-plans'] as const;
const usageRootKey = ['saas-console', 'usage'] as const;
const requestsRootKey = ['saas-console', 'requests'] as const;
const customerRefundRootKey = ['saas-console', 'refunds'] as const;
export const customerSessionsKey = ['saas-console', 'sessions'] as const;
export const customerRefundHistoryKey = (tenantId: string, cursor?: string) =>
  [...customerRefundRootKey, tenantId, cursor ?? ''] as const;
export const customerWebhookRootKey = ['saas-console', 'webhooks'] as const;
export const customerWebhookEndpointsKey = (tenantId: string) => [...customerWebhookRootKey, tenantId, 'endpoints'] as const;
export const customerWebhookSecretsKey = (tenantId: string, endpointId: string) =>
  [...customerWebhookRootKey, tenantId, endpointId, 'secrets'] as const;
export const customerWebhookDeliveryHistoryKey = (tenantId: string, endpointId: string) =>
  [...customerWebhookRootKey, tenantId, endpointId, 'deliveries'] as const;

const keyManagementRoles = new Set<TenantRole>(['owner', 'admin', 'developer']);
const customerRefundRoles = new Set<TenantRole>(['owner', 'admin', 'billing']);

function canViewCustomerRefunds(role: TenantRole): boolean {
  return customerRefundRoles.has(role);
}

export function parseModelScopes(value: string): { scopes: string[]; error?: string } {
  const scopes = value
    .split(/[\n,]/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) return { scopes: [], error: '请至少填写一个模型 scope。' };
  if (new Set(scopes).size !== scopes.length) return { scopes, error: '模型 scope 不能重复。' };
  return { scopes };
}

export function isApiKeySupplyMode(value: string): value is ApiKeySupplyMode {
  return value === 'byok' || value === 'platform';
}

export function keyErrorMessage(error: unknown): string {
  if (!(error instanceof SaasApiError)) return error instanceof Error ? error.message : '请求失败，请稍后重试。';
  switch (error.code) {
    case 'KEY_SUPPLY_UNAVAILABLE':
      return `服务端返回 ${error.code}：当前还没有可用的 API Key 供给配置，请先配置供给权益后再重试。`;
    case 'KEY_NO_ENTITLEMENT':
      return `服务端返回 ${error.code}：当前项目没有所选供给模式的 entitlement，请先配置供给权益后再重试。`;
    case 'KEY_SCOPE_NOT_ALLOWED':
      return `服务端返回 ${error.code}：所选模型范围未被当前供给权益覆盖，请调整 scope 后重试。`;
    case 'KEY_ACCESS_DENIED':
      return `服务端返回 ${error.code}：当前账号或所选项目角色无权管理 API Key。`;
    case 'KEY_ALREADY_REVOKED':
      return `服务端返回 ${error.code}：该 API Key 已撤销，不能再次轮换。`;
    case 'KEY_NOT_FOUND':
      return `服务端返回 ${error.code}：API Key 不存在或已不属于当前所选项目。`;
    default:
      return error.message || `服务端返回 ${error.code}。`;
  }
}

function KeyErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <strong>API Key 操作失败</strong>
      <span>{keyErrorMessage(error)}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

function isUnauthorized(error: unknown) {
  return error instanceof SaasApiError && error.status === 401;
}

function customerSessionErrorCopy(error: unknown): {
  title: string;
  message: string;
  action: 'retry' | 'reload' | 'login';
  actionLabel: string;
} {
  if (error instanceof SaasApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED')) {
    return {
      title: '登录状态已过期',
      message: '请重新登录后查看或管理登录会话。',
      action: 'login',
      actionLabel: '返回登录',
    };
  }
  if (error instanceof SaasApiError && error.code === 'CSRF_REJECTED') {
    return {
      title: '安全校验失败',
      message: '安全凭证可能已过期，请刷新页面后重试。',
      action: 'reload',
      actionLabel: '刷新页面',
    };
  }
  if (
    error instanceof SaasApiError &&
    (error.code === 'ORIGIN_REQUIRED' || error.code === 'ORIGIN_REJECTED')
  ) {
    return {
      title: '请求来源校验失败',
      message: '请从客户控制台重新打开页面后重试。',
      action: 'reload',
      actionLabel: '刷新页面',
    };
  }
  if (error instanceof SaasApiError && error.code === 'FORBIDDEN') {
    return {
      title: '无法管理登录会话',
      message: '当前账号无权执行此操作。',
      action: 'retry',
      actionLabel: '刷新会话列表',
    };
  }
  if (error instanceof SaasApiError && error.code === 'NOT_FOUND') {
    return {
      title: '会话状态已变化',
      message: '该会话可能已失效，请刷新会话列表核对。',
      action: 'retry',
      actionLabel: '刷新会话列表',
    };
  }
  if (error instanceof SaasApiError && error.code === 'NETWORK') {
    return {
      title: '网络连接失败',
      message: '暂时无法连接会话服务，请检查网络后重试。',
      action: 'retry',
      actionLabel: '重试',
    };
  }
  return {
    title: '会话操作失败',
    message: '暂时无法读取或更新登录会话，请稍后重试。',
    action: 'retry',
    actionLabel: '重试',
  };
}

export type CustomerSessionMutation = { kind: 'session'; sessionId: string } | { kind: 'others' };
export type CustomerSessionMutationOutcome = 'confirmed' | 'unknown' | 'rejected';

type CustomerSessionRevocationResult = CustomerSessionRevocation | OtherCustomerSessionsRevocation;

type CustomerSessionMutationClient = Pick<
  typeof saasClient,
  'revokeCustomerSession' | 'revokeOtherCustomerSessions'
>;

export async function performCustomerSessionMutation(
  mutation: CustomerSessionMutation,
  dependencies: {
    client?: CustomerSessionMutationClient;
    refresh: () => Promise<unknown>;
    onCurrentSessionRevoked: () => void | Promise<void>;
    isCurrent?: () => boolean;
  },
): Promise<CustomerSessionRevocationResult> {
  const client = dependencies.client ?? saasClient;
  const result = mutation.kind === 'others'
    ? await client.revokeOtherCustomerSessions()
    : await client.revokeCustomerSession(mutation.sessionId);
  if (dependencies.isCurrent && !dependencies.isCurrent()) return result;

  // Start the read first, but never make local invalidation wait for it.
  // Capture its failure immediately so an invalidation failure cannot mask it.
  const refreshed = (async () => {
    try {
      await dependencies.refresh();
      return { ok: true } as const;
    } catch (error) {
      return { ok: false, error } as const;
    }
  })();
  let invalidationFailed = false;
  let invalidationError: unknown;
  if ('currentSessionRevoked' in result && result.currentSessionRevoked &&
      (!dependencies.isCurrent || dependencies.isCurrent())) {
    try {
      await dependencies.onCurrentSessionRevoked();
    } catch (error) {
      invalidationFailed = true;
      invalidationError = error;
    }
  }
  const refreshResult = await refreshed;
  if (!refreshResult.ok) throw refreshResult.error;
  if (invalidationFailed) throw invalidationError;
  return result;
}

type CustomerSessionIgnored = {
  status: 'ignored'; reason: 'busy' | 'refresh-required' | 'stale';
};
export type CustomerSessionMutationAttempt =
  | { status: 'complete'; result: CustomerSessionRevocationResult }
  | { status: 'error'; error: unknown; outcome: CustomerSessionMutationOutcome }
  | CustomerSessionIgnored;
export type CustomerSessionRefreshAttempt =
  | { status: 'refreshed' }
  | { status: 'error'; error: unknown }
  | CustomerSessionIgnored;

function customerSessionMutationUnknown(error: unknown): boolean {
  return !(error instanceof SaasApiError) || error.status === 0 || error.status >= 500 ||
    error.code === 'NETWORK' || error.code === 'INVALID_RESPONSE';
}

/** Per-mounted/authenticated scope; this owns the UI's real mutation path, not auth policy. */
export function createCustomerSessionMutationLifecycle(dependencies: {
  client?: CustomerSessionMutationClient;
  refresh: (isCurrent: () => boolean) => Promise<unknown>;
  onCurrentSessionRevoked: () => void | Promise<void>;
  isCurrent?: () => boolean;
}) {
  const client = dependencies.client ?? saasClient;
  let active = true;
  let generation = 0;
  let inFlight: object | undefined;
  let requiresRefresh = false;
  const isCurrent = () => active && (!dependencies.isCurrent || dependencies.isCurrent());

  return {
    get busy() { return inFlight !== undefined; },
    get requiresRefresh() { return requiresRefresh; },
    isCurrent,
    activate() { if (!active) { active = true; generation += 1; } },
    deactivate() { active = false; generation += 1; inFlight = undefined; },
    async perform(mutation: CustomerSessionMutation): Promise<CustomerSessionMutationAttempt> {
      if (!isCurrent()) return { status: 'ignored', reason: 'stale' };
      if (inFlight) return { status: 'ignored', reason: 'busy' };
      if (requiresRefresh) return { status: 'ignored', reason: 'refresh-required' };
      const token = {};
      const startedGeneration = generation;
      inFlight = token;
      const stillCurrent = () => isCurrent() && generation === startedGeneration && inFlight === token;
      let acknowledged: CustomerSessionRevocationResult | undefined;
      try {
        const result = await performCustomerSessionMutation(mutation, {
          client: {
            revokeCustomerSession: async (sessionId) => {
              const result = await client.revokeCustomerSession(sessionId);
              acknowledged = result;
              return result;
            },
            revokeOtherCustomerSessions: async () => {
              const result = await client.revokeOtherCustomerSessions();
              acknowledged = result;
              return result;
            },
          },
          refresh: () => dependencies.refresh(stillCurrent),
          onCurrentSessionRevoked: dependencies.onCurrentSessionRevoked,
          isCurrent: stillCurrent,
        });
        return stillCurrent() ? { status: 'complete', result } : { status: 'ignored', reason: 'stale' };
      } catch (error) {
        if (!stillCurrent()) return { status: 'ignored', reason: 'stale' };
        requiresRefresh = acknowledged !== undefined || customerSessionMutationUnknown(error);
        return {
          status: 'error', error,
          outcome: acknowledged ? 'confirmed' : requiresRefresh ? 'unknown' : 'rejected',
        };
      } finally {
        // An older promise must not release a newer scope's lock.
        if (inFlight === token) inFlight = undefined;
      }
    },
    async refreshAndConfirm(): Promise<CustomerSessionRefreshAttempt> {
      if (!isCurrent()) return { status: 'ignored', reason: 'stale' };
      if (inFlight) return { status: 'ignored', reason: 'busy' };
      const token = {};
      const startedGeneration = generation;
      inFlight = token;
      const stillCurrent = () => isCurrent() && generation === startedGeneration && inFlight === token;
      try {
        await dependencies.refresh(stillCurrent);
        if (!stillCurrent()) return { status: 'ignored', reason: 'stale' };
        requiresRefresh = false;
        return { status: 'refreshed' };
      } catch (error) {
        return stillCurrent() ? { status: 'error', error } : { status: 'ignored', reason: 'stale' };
      } finally {
        if (inFlight === token) inFlight = undefined;
      }
    },
  };
}

function customerSessionDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const requestStatusLabels: Record<ConsoleRequestStatus, string> = {
  pending: '处理中',
  succeeded: '成功',
  failed: '失败',
  unknown: '未知',
};

const usageStatusLabels: Record<ConsoleUsageStatus, string> = {
  reported: '上游已报告',
  partial: '部分报告',
  missing: '缺少用量',
  estimated: '本地估算',
};

const billableBasisLabels: Record<ConsoleBillableBasis, string> = {
  exact: '精确',
  estimated: '估算',
  unknown: '未知',
  not_billable: '不可计费',
};

function supplyModeLabel(mode: 'byok' | 'platform' | undefined): string {
  if (mode === 'byok') return 'BYOK';
  if (mode === 'platform') return '平台供给';
  return '全部模式';
}

function requestStatusLabel(status: ConsoleRequestStatus | undefined): string {
  return status ? requestStatusLabels[status] : '全部状态';
}

/** Keep decimal token strings exact; this deliberately never converts through Number or float. */
export function formatExactDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return '—';
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fixedFeeLabel(plan: ServicePlanCatalogItem): string {
  return `${plan.currency} ${plan.fixedFeeMinorUnits}（最小货币单位）`;
}

function dateInputValue(offsetDays: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function rangeStart(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

function rangeEnd(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function optionalFilter(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function tenantName(tenant: SafeTenant): string {
  return `${tenant.name} · ${roleLabels[tenant.role]}`;
}

function useTenantProjects(tenantId: string | undefined) {
  return useQuery({
    queryKey: [...projectsRootKey, tenantId ?? ''] as const,
    queryFn: () => {
      if (!tenantId) throw new Error('租户未选择');
      return saasClient.getProjects(tenantId);
    },
    enabled: Boolean(tenantId),
    retry: false,
  });
}

export function resolveProjectSelection(
  tenantId: string | undefined,
  selectionTenantId: string | undefined,
  requestedProjectId: string,
  projects: readonly Project[] | undefined,
  defaultToFirst: boolean,
): string {
  if (selectionTenantId === tenantId && projects?.some((project) => project.id === requestedProjectId))
    return requestedProjectId;
  return defaultToFirst ? (projects?.[0]?.id ?? '') : '';
}

function useProjectSelection(
  tenantId: string | undefined,
  projects: readonly Project[] | undefined,
  defaultToFirst: boolean,
  initialProjectId = '',
) {
  const [selection, setSelection] = useState<{ tenantId: string | undefined; projectId: string }>(() => ({
    tenantId,
    projectId: initialProjectId,
  }));

  useEffect(() => {
    if (selection.tenantId === tenantId) return;
    setSelection({ tenantId, projectId: '' });
  }, [selection.tenantId, tenantId]);

  const requestedProjectId = selection.tenantId === tenantId ? selection.projectId : '';

  useEffect(() => {
    if (!tenantId || !projects || selection.tenantId !== tenantId) return;
    if (requestedProjectId && projects.some((project) => project.id === requestedProjectId)) return;
    const nextProjectId = defaultToFirst ? (projects[0]?.id ?? '') : '';
    if (selection.projectId !== nextProjectId) setSelection({ tenantId, projectId: nextProjectId });
  }, [defaultToFirst, projects, requestedProjectId, selection, tenantId]);

  const selectedProjectId = resolveProjectSelection(
    tenantId,
    selection.tenantId,
    requestedProjectId,
    projects,
    defaultToFirst,
  );
  const selectedProject = projects?.find((project) => project.id === selectedProjectId);

  function selectProject(projectId: string) {
    if (tenantId && (projectId === '' || projects?.some((project) => project.id === projectId))) {
      setSelection({ tenantId, projectId });
    }
  }

  return { selectedProjectId, selectedProject, selectProject };
}

function ProjectPicker({
  projects,
  value,
  onChange,
  loading = false,
  includeAll = false,
}: {
  projects: readonly Project[];
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  includeAll?: boolean;
}) {
  return (
    <Field label="项目">
      <select
        aria-label="选择项目"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={loading && projects.length === 0}
      >
        <option value="">
          {loading ? '正在加载项目…' : includeAll ? '全部项目' : projects.length ? '请选择项目' : '暂无可访问项目'}
        </option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name} · {project.slug} · {roleLabels[project.role]}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Brand({ subtitle = '客户控制台' }: { subtitle?: string }) {
  return (
    <div className="brand">
      <span className="brand-mark">◈</span>
      <div>
        model-router<small>{subtitle}</small>
      </div>
    </div>
  );
}

function AuthFrame({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <section className="auth-card">
        <Brand subtitle={subtitle} />
        {children}
      </section>
    </div>
  );
}

function SetupInfoPage() {
  return (
    <AuthFrame subtitle="平台管理员初始化">
      <h1>平台管理员初始化</h1>
      <p className="muted">首次平台管理员设置仅通过 CLI 完成，请在服务器上运行：</p>
      <p>
        <code>model-router saas:bootstrap-admin</code>
      </p>
      <p className="muted">客户访问保持邀请制。客户成员只能通过邀请链接加入；此页面不提供公开注册。</p>
      <Link className="button-link primary" to="/console/login">
        前往客户登录
      </Link>
    </AuthFrame>
  );
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (result: SessionResult) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await saasClient.login({ email, password });
      setPassword('');
      onAuthenticated(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame subtitle="客户控制台">
      <h1>登录</h1>
      <p className="muted">使用邮箱和密码登录。新成员需要通过邀请链接加入。</p>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <Field label="邮箱">
          <input
            required
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="密码">
          <input
            required
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <SaveButton busy={busy}>登录</SaveButton>
      </form>
    </AuthFrame>
  );
}

function AcceptInvitationPage() {
  return <AuthFrame subtitle="邀请加入"><WorkspaceInvitationAcceptance /></AuthFrame>;
}

const roleLabels = workspaceRoleLabels;

function ConsoleHeader({
  active,
  onLogout,
}: {
  active:
    | 'workspace'
    | 'catalog'
    | 'usage'
    | 'requests'
    | 'keys'
    | 'credentials'
    | 'wallet'
    | 'refunds'
    | 'security'
    | 'webhooks';
  onLogout: () => Promise<void>;
}) {
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const showRefunds = tenants.data?.some((tenant) => canViewCustomerRefunds(tenant.role)) ?? false;
  const [logoutError, setLogoutError] = useState<unknown>();

  async function logout() {
    setLogoutError(undefined);
    try {
      await onLogout();
    } catch (err) {
      setLogoutError(err);
    }
  }

  return (
    <>
      <header className="saas-header">
        <Brand />
        <nav aria-label="客户控制台导航">
          <Link to="/console" aria-current={active === 'workspace' ? 'page' : undefined}>
            工作空间
          </Link>
          {' · '}
          <Link to="/console/catalog" aria-current={active === 'catalog' ? 'page' : undefined}>
            服务计划目录
          </Link>
          {' · '}
          <Link to="/console/usage" aria-current={active === 'usage' ? 'page' : undefined}>
            用量
          </Link>
          {' · '}
          <Link to="/console/requests" aria-current={active === 'requests' ? 'page' : undefined}>
            请求
          </Link>
          {' · '}
          <Link to="/console/keys" aria-current={active === 'keys' ? 'page' : undefined}>
            API Keys
          </Link>
          {' · '}
          <Link to="/console/webhooks" aria-current={active === 'webhooks' ? 'page' : undefined}>
            Webhook
          </Link>
          {' · '}
          <Link to="/console/credentials" aria-current={active === 'credentials' ? 'page' : undefined}>
            BYOK 凭证
          </Link>
          {' · '}
          <Link to="/console/wallet" aria-current={active === 'wallet' ? 'page' : undefined}>
            钱包
          </Link>
          {' · '}
          {showRefunds && (
            <>
              <Link to="/console/refunds" aria-current={active === 'refunds' ? 'page' : undefined}>
                退款记录
              </Link>
              {' · '}
            </>
          )}
          <Link to="/console/security" aria-current={active === 'security' ? 'page' : undefined}>
            安全与会话
          </Link>
        </nav>
        <button className="quiet" type="button" onClick={logout}>
          退出登录
        </button>
      </header>
      {logoutError ? <ErrorNotice error={logoutError} /> : null}
    </>
  );
}

export type CustomerSessionConfirmation =
  | { kind: 'session'; session: SafeCustomerSession }
  | { kind: 'others'; activeCount: number };

function customerSessionConfirmationCopy(confirmation: CustomerSessionConfirmation): {
  title: string;
  description: string;
  button: string;
} {
  if (confirmation.kind === 'others') {
    return {
      title: '撤销其他活动会话？',
      description: `此操作将退出其他 ${confirmation.activeCount} 个活动会话；当前会话会继续保持登录。`,
      button: '撤销其他会话',
    };
  }
  if (confirmation.session.current) {
    return {
      title: '撤销当前会话并退出登录？',
      description: '确认后当前会话会立即失效并清除登录状态。你需要重新登录才能继续使用客户控制台。',
      button: '撤销并退出登录',
    };
  }
  return {
    title: '撤销此登录会话？',
    description: '此会话撤销后将无法继续访问客户控制台。',
    button: '撤销此会话',
  };
}

export function SessionConfirmationDialog({
  confirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  confirmation: CustomerSessionConfirmation;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const copy = customerSessionConfirmationCopy(confirmation);

  useEffect(() => {
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key !== 'Tab') return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="byok-modal-backdrop">
      <section
        ref={dialog}
        className="byok-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="customer-session-confirmation-title"
        aria-describedby="customer-session-confirmation-description"
      >
        <h2 id="customer-session-confirmation-title">{copy.title}</h2>
        <p id="customer-session-confirmation-description">{copy.description}</p>
        <div className="actions">
          <button
            ref={cancelButton}
            type="button"
            className="quiet"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : copy.button}
          </button>
        </div>
      </section>
    </div>
  );
}

export function SessionSecurityErrorNotice({
  error,
  onRetry,
  onLogout,
  outcome,
}: {
  error: unknown;
  onRetry: () => void;
  onLogout: () => Promise<void>;
  outcome?: CustomerSessionMutationOutcome;
}) {
  const expired = error instanceof SaasApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED');
  const copy: ReturnType<typeof customerSessionErrorCopy> = !expired && outcome === 'unknown'
    ? {
        title: '撤销结果尚未确认',
        message: '请求可能已到达服务器；不会自动重试撤销。请刷新会话列表核对后再操作。',
        action: 'retry', actionLabel: '刷新会话列表确认',
      }
    : !expired && outcome === 'confirmed'
      ? {
          title: '撤销已确认，页面更新未完成',
          message: '服务器已确认撤销，但列表刷新或本地退出处理未完成。请刷新状态后核对，不要重复提交。',
          action: 'retry', actionLabel: '刷新会话列表确认',
        }
      : customerSessionErrorCopy(error);
  function takeAction() {
    if (copy.action === 'login') {
      void onLogout().catch(() => {});
    } else if (copy.action === 'reload') {
      window.location.reload();
    } else {
      onRetry();
    }
  }

  return (
    <div className="notice error" role="alert">
      <strong>{copy.title}</strong>
      <span>{copy.message}</span>
      <button type="button" onClick={takeAction}>
        {copy.actionLabel}
      </button>
    </div>
  );
}

export function CustomerSessionsPage({
  onLogout,
  onCurrentSessionRevoked,
  sessionScope,
  isCurrentSessionScope,
}: {
  onLogout: () => Promise<void>;
  onCurrentSessionRevoked: () => void | Promise<void>;
  sessionScope?: SafeSession;
  isCurrentSessionScope?: () => boolean;
}) {
  const queryClient = useQueryClient();
  const scopedSessionsKey = useMemo(
    () => sessionScope
      ? [...customerSessionsKey, sessionScope.userId, sessionScope.createdAt] as const
      : customerSessionsKey,
    [sessionScope?.userId, sessionScope?.createdAt],
  );
  const callbacks = useRef({ onCurrentSessionRevoked, isCurrentSessionScope, sessionScope });
  callbacks.current = { onCurrentSessionRevoked, isCurrentSessionScope, sessionScope };
  const lifecycle = useMemo(() => createCustomerSessionMutationLifecycle({
    isCurrent: () => callbacks.current.sessionScope === sessionScope &&
      (!callbacks.current.isCurrentSessionScope || callbacks.current.isCurrentSessionScope()),
    onCurrentSessionRevoked: () => callbacks.current.onCurrentSessionRevoked(),
    refresh: async (isCurrent) => {
      await queryClient.cancelQueries({ queryKey: scopedSessionsKey });
      if (!isCurrent()) return;
      const rows = await saasClient.getCustomerSessions();
      if (isCurrent()) queryClient.setQueryData(scopedSessionsKey, rows);
    },
  }), [queryClient, scopedSessionsKey, sessionScope]);
  const sessions = useQuery({
    queryKey: scopedSessionsKey,
    queryFn: saasClient.getCustomerSessions,
    retry: false,
  });
  const [confirmation, setConfirmation] = useState<CustomerSessionConfirmation>();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<unknown>();
  const [mutationOutcome, setMutationOutcome] = useState<CustomerSessionMutationOutcome>();
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const confirmationScope = useRef(sessionScope);
  const activeOtherCount = (sessions.data ?? []).filter((session) => session.status === 'active' && !session.current)
    .length;

  const dismissConfirmation = useCallback(() => setConfirmation(undefined), []);
  useEffect(() => {
    lifecycle.activate();
    confirmationScope.current = sessionScope;
    setConfirmation(undefined);
    setMutationBusy(false);
    setMutationError(undefined);
    setMutationOutcome(undefined);
    setRequiresRefresh(lifecycle.requiresRefresh);
    setAnnouncement('');
    return () => lifecycle.deactivate();
  }, [lifecycle, sessionScope]);
  useEffect(() => {
    if (!confirmation) confirmationTrigger.current?.focus();
  }, [confirmation]);

  async function confirmMutation() {
    if (!confirmation || mutationBusy || lifecycle.busy || lifecycle.requiresRefresh ||
        !lifecycle.isCurrent() || confirmationScope.current !== sessionScope) return;
    const mutation: CustomerSessionMutation =
      confirmation.kind === 'others'
        ? { kind: 'others' }
        : { kind: 'session', sessionId: confirmation.session.id };
    setMutationBusy(true);
    setMutationError(undefined);
    setMutationOutcome(undefined);
    setAnnouncement('');
    const attempt = await lifecycle.perform(mutation);
    if (attempt.status === 'ignored' || !lifecycle.isCurrent()) return;
    setConfirmation(undefined);
    setMutationBusy(false);
    setRequiresRefresh(lifecycle.requiresRefresh);
    if (attempt.status === 'complete') {
      const result = attempt.result;
      if ('revokedCount' in result) {
        setAnnouncement(`已撤销 ${result.revokedCount} 个其他活动会话；当前会话仍保持登录。`);
      } else if (!result.currentSessionRevoked) {
        setAnnouncement('已撤销该登录会话。');
      }
    } else {
      setMutationError(attempt.error);
      setMutationOutcome(attempt.outcome);
    }
  }

  async function refresh() {
    if (lifecycle.busy || !lifecycle.isCurrent()) return;
    setMutationBusy(true);
    const attempt = await lifecycle.refreshAndConfirm();
    if (attempt.status === 'ignored' || !lifecycle.isCurrent()) return;
    setMutationBusy(false);
    setRequiresRefresh(lifecycle.requiresRefresh);
    if (attempt.status === 'refreshed') {
      setMutationError(undefined);
      setMutationOutcome(undefined);
      setAnnouncement('已刷新会话列表，请以服务端状态为准重新核对后操作。');
    } else {
      setMutationError(attempt.error);
      if (!lifecycle.requiresRefresh) setMutationOutcome(undefined);
    }
  }

  return (
    <div className="saas-console">
      <ConsoleHeader active="security" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">SECURITY</p>
          <h1>安全与登录会话</h1>
          <p>查看当前账号的登录会话，并撤销不再使用的会话。</p>
        </div>
      </div>
      <div className="notice error" role="note">
        <strong>当前会话提示</strong>
        <span>撤销标记为“当前”的会话会立即退出登录；之后需要重新登录。</span>
      </div>
      <Panel
        title="登录会话"
        action={
          <div className="actions">
            <button type="button" className="quiet" disabled={sessions.isFetching || mutationBusy} onClick={refresh}>
              {sessions.isFetching ? '正在刷新…' : '刷新列表'}
            </button>
            <button
              type="button"
              className="danger"
              disabled={mutationBusy || requiresRefresh || activeOtherCount === 0}
              onClick={(event) => {
                if (lifecycle.busy || lifecycle.requiresRefresh || !lifecycle.isCurrent()) return;
                confirmationTrigger.current = event.currentTarget;
                confirmationScope.current = sessionScope;
                setConfirmation({ kind: 'others', activeCount: activeOtherCount });
              }}
            >
              撤销其他活动会话{activeOtherCount > 0 ? `（${activeOtherCount}）` : ''}
            </button>
          </div>
        }
      >
        <p className="muted">
          仅展示服务端安全返回的会话信息。当前接口暂未提供设备、浏览器、IP 或上次使用时间。
        </p>
        {(mutationOutcome !== undefined || Boolean(mutationError)) && (
          <SessionSecurityErrorNotice error={mutationError} outcome={mutationOutcome} onRetry={refresh} onLogout={onLogout} />
        )}
        {announcement && (
          <div className="notice" role="status" aria-live="polite">
            {announcement}
          </div>
        )}
        {sessions.isPending ? (
          <div className="skeleton" role="status" aria-label="正在加载登录会话">
            <i />
            <i />
            <i />
          </div>
        ) : sessions.isError ? (
          mutationOutcome === undefined && !mutationError && (
            <SessionSecurityErrorNotice
              error={sessions.error}
              onRetry={refresh}
              onLogout={onLogout}
            />
          )
        ) : sessions.data?.length === 0 ? (
          <div className="empty">暂无登录会话信息。</div>
        ) : (
          <section className="saas-tenant-list" aria-label="登录会话列表">
            {sessions.data?.map((session) => {
              const statusLabel =
                session.status === 'active' ? '活动' : session.status === 'revoked' ? '已撤销' : '已过期';
              const tone = session.status === 'active' ? 'good' : session.status === 'expired' ? 'warn' : 'neutral';
              return (
                <article className="saas-tenant-card" key={session.id}>
                  <div className="saas-tenant-heading">
                    <div>
                      <h3>{session.current ? '当前会话' : '其他登录会话'}</h3>
                      <small>{session.current ? '此会话正在使用' : '由服务端登记的登录会话'}</small>
                    </div>
                    <Badge tone={tone}>{session.current && session.status === 'active' ? '当前 · 活动' : statusLabel}</Badge>
                  </div>
                  <div className="summary-list">
                    <div>
                      <span>创建时间</span>
                      <strong>
                        <time dateTime={session.createdAt}>{customerSessionDate(session.createdAt)}</time>
                      </strong>
                    </div>
                    <div>
                      <span>到期时间</span>
                      <strong>
                        <time dateTime={session.expiresAt}>{customerSessionDate(session.expiresAt)}</time>
                      </strong>
                    </div>
                    {session.revokedAt && (
                      <div>
                        <span>撤销时间</span>
                        <strong>
                          <time dateTime={session.revokedAt}>{customerSessionDate(session.revokedAt)}</time>
                        </strong>
                      </div>
                    )}
                  </div>
                  {session.status === 'active' && (
                    <div className="actions">
                      <button
                        type="button"
                        className="danger"
                        disabled={mutationBusy || requiresRefresh}
                        aria-label={session.current ? '撤销当前登录会话' : '撤销此登录会话'}
                        onClick={(event) => {
                          if (lifecycle.busy || lifecycle.requiresRefresh || !lifecycle.isCurrent()) return;
                          confirmationTrigger.current = event.currentTarget;
                          confirmationScope.current = sessionScope;
                          setConfirmation({ kind: 'session', session });
                        }}
                      >
                        {session.current ? '撤销当前会话' : '撤销此会话'}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </Panel>
      {confirmation && (
        <SessionConfirmationDialog
          confirmation={confirmation}
          busy={mutationBusy}
          onCancel={dismissConfirmation}
          onConfirm={() => void confirmMutation()}
        />
      )}
    </div>
  );
}

const customerRefundStatusPresentation: Record<
  CustomerRefundStatus,
  { label: string; tone: 'neutral' | 'good' | 'bad' | 'warn'; hint?: string }
> = {
  submitting: {
    label: '正在提交',
    tone: 'warn',
    hint: '当前状态尚未最终确认，请勿重复提交。',
  },
  pending: {
    label: '退款处理中 · 尚未完成',
    tone: 'warn',
    hint: '退款仍在处理中，当前状态不是最终结果；请勿重复提交。',
  },
  succeeded: { label: '退款已完成', tone: 'good' },
  failed: { label: '退款失败', tone: 'bad' },
  unknown: {
    label: '状态未知 · 尚未确认',
    tone: 'warn',
    hint: '服务端尚未确认最终结果；请等待状态更新，请勿重复发起。',
  },
  blocked: {
    label: '需要平台处理',
    tone: 'neutral',
    hint: '此记录需由平台进一步处理，本页面不提供重试或重新提交。',
  },
};

function customerRefundErrorCopy(error: unknown): {
  title: string;
  message: string;
  action: 'retry' | 'login';
  actionLabel: string;
} {
  if (error instanceof SaasApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED')) {
    return {
      title: '登录状态已过期',
      message: '请重新登录后查看退款记录。',
      action: 'login',
      actionLabel: '返回登录',
    };
  }
  if (error instanceof SaasApiError && (error.status === 403 || error.code === 'FORBIDDEN')) {
    return {
      title: '无权查看退款记录',
      message: '当前账号无权查看所选租户的退款记录，请确认租户授权。',
      action: 'retry',
      actionLabel: '重试',
    };
  }
  if (error instanceof SaasApiError && (error.code === 'CSRF_REJECTED' || error.code === 'ORIGIN_REJECTED')) {
    return {
      title: '安全校验失败',
      message: '安全凭证可能已过期，请刷新页面后重试。',
      action: 'retry',
      actionLabel: '重试',
    };
  }
  if (error instanceof SaasApiError && (error.status === 0 || error.code === 'NETWORK')) {
    return {
      title: '网络连接失败',
      message: '暂时无法连接退款服务，请检查网络后重试。',
      action: 'retry',
      actionLabel: '重试',
    };
  }
  return {
    title: '退款记录读取失败',
    message: '暂时无法读取退款记录，请稍后重试。',
    action: 'retry',
    actionLabel: '重试',
  };
}

function CustomerRefundErrorNotice({
  error,
  onRetry,
  onLogout,
}: {
  error: unknown;
  onRetry: () => void;
  onLogout: () => Promise<void>;
}) {
  const copy = customerRefundErrorCopy(error);
  return (
    <div className="notice error" role="alert">
      <strong>{copy.title}</strong>
      <span>{copy.message}</span>
      <button
        type="button"
        onClick={() => {
          if (copy.action === 'login') void onLogout().catch(() => {});
          else onRetry();
        }}
      >
        {copy.actionLabel}
      </button>
    </div>
  );
}

function customerRefundTypeLabel(refund: CustomerRefundSummary): string {
  return refund.refundType === 'wallet_topup' ? '钱包充值退款' : 'BYOK 服务计划退款';
}

export function CustomerRefundsPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [position, setPosition] = useState<{
    tenantId: string;
    cursors: Array<string | undefined>;
    index: number;
  }>({ tenantId: '', cursors: [undefined], index: 0 });
  const refundTenants = useMemo(
    () => tenants.data?.filter((tenant) => canViewCustomerRefunds(tenant.role)) ?? [],
    [tenants.data],
  );
  const selectedTenant = refundTenants.find((tenant) => tenant.id === selectedTenantId) ?? refundTenants[0];
  const tenantId = selectedTenant?.id;

  useEffect(() => {
    if (refundTenants.some((tenant) => tenant.id === selectedTenantId)) return;
    setSelectedTenantId(refundTenants[0]?.id ?? '');
  }, [refundTenants, selectedTenantId]);

  const currentPosition =
    position.tenantId === tenantId
      ? position
      : { tenantId: tenantId ?? '', cursors: [undefined], index: 0 };
  const cursor = currentPosition.cursors[currentPosition.index];
  const refunds = useQuery({
    queryKey: customerRefundHistoryKey(tenantId ?? '', cursor),
    queryFn: ({ signal }) => {
      if (!tenantId) throw new Error('退款租户未选择');
      return saasClient.getCustomerRefunds(tenantId, { cursor, limit: 25, signal });
    },
    enabled: Boolean(tenantId),
    retry: false,
  });

  function chooseTenant(nextTenantId: string) {
    if (!refundTenants.some((tenant) => tenant.id === nextTenantId)) return;
    setSelectedTenantId(nextTenantId);
    setPosition({ tenantId: nextTenantId, cursors: [undefined], index: 0 });
  }

  function goPrevious() {
    if (currentPosition.index === 0) return;
    setPosition({ ...currentPosition, index: currentPosition.index - 1 });
  }

  function goNext() {
    const nextCursor = refunds.data?.nextCursor;
    if (!tenantId || !nextCursor || nextCursor === cursor || refunds.isFetching) return;
    const cursors = currentPosition.cursors.slice(0, currentPosition.index + 1);
    cursors.push(nextCursor);
    setPosition({ tenantId, cursors, index: currentPosition.index + 1 });
  }

  const hasPreviousPage = currentPosition.index > 0;
  const hasNextPage = Boolean(refunds.data?.nextCursor && refunds.data.nextCursor !== cursor);

  return (
    <div className="saas-console">
      <ConsoleHeader active="refunds" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">BILLING · REFUNDS</p>
          <h1>退款记录</h1>
          <p>查看钱包充值和 BYOK 服务计划的退款状态及时间。</p>
        </div>
      </div>
      <p className="muted">此页面为只读记录，不支持创建、审批、重试或重新提交退款。</p>

      {tenants.isPending ? (
        <div className="skeleton" role="status" aria-label="正在加载已授权租户">
          <i />
          <i />
        </div>
      ) : tenants.isError ? (
        <CustomerRefundErrorNotice error={tenants.error} onRetry={() => void tenants.refetch()} onLogout={onLogout} />
      ) : tenants.data?.length === 0 ? (
        <div className="empty" role="status">当前账号没有已授权的租户。</div>
      ) : refundTenants.length === 0 ? (
        <div className="empty" role="status">
          退款记录仅对租户所有者、管理员和账单管理员开放；当前账号没有符合条件的租户。
        </div>
      ) : selectedTenant && tenantId ? (
        <>
          {refundTenants.length > 1 && (
            <Field label="租户">
              <select
                aria-label="选择退款记录租户"
                value={selectedTenant.id}
                onChange={(event) => chooseTenant(event.target.value)}
              >
                {refundTenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name} · {roleLabels[tenant.role]}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Panel
            title="退款记录"
            action={
              <button type="button" className="quiet" disabled={refunds.isFetching} onClick={() => void refunds.refetch()}>
                {refunds.isFetching ? '正在刷新…' : '刷新退款记录'}
              </button>
            }
          >
            {refunds.isPending ? (
              <div className="skeleton" role="status" aria-label="正在加载退款记录">
                <i />
                <i />
                <i />
              </div>
            ) : refunds.isError ? (
              <CustomerRefundErrorNotice
                error={refunds.error}
                onRetry={() => void refunds.refetch()}
                onLogout={onLogout}
              />
            ) : refunds.data?.items.length === 0 ? (
              <div className="empty" role="status">暂无退款记录。</div>
            ) : (
              <>
                <section className="saas-tenant-list" aria-label="退款记录列表">
                  {refunds.data?.items.map((refund) => {
                    const presentation = customerRefundStatusPresentation[refund.status];
                    return (
                      <article className="saas-tenant-card" key={refund.id}>
                        <div className="saas-tenant-heading">
                          <div>
                            <h3>{customerRefundTypeLabel(refund)}</h3>
                            <small>退款记录 ID：<code>{refund.id}</code></small>
                          </div>
                          <Badge tone={presentation.tone}>{presentation.label}</Badge>
                        </div>
                        <div className="summary-list" aria-label={`${customerRefundTypeLabel(refund)}详情`}>
                          <div>
                            <span>退款金额</span>
                            <strong>
                              {refund.currency} {formatExactDecimal(refund.amountMinorUnits)}
                              <small> · 最小货币单位</small>
                            </strong>
                          </div>
                          <div>
                            <span>原订单 ID</span>
                            <strong><code>{refund.originalOrderId}</code></strong>
                          </div>
                          <div>
                            <span>创建时间</span>
                            <strong><time dateTime={refund.createdAt}>{customerSessionDate(refund.createdAt)}</time></strong>
                          </div>
                          <div>
                            <span>最近更新时间</span>
                            <strong><time dateTime={refund.updatedAt}>{customerSessionDate(refund.updatedAt)}</time></strong>
                          </div>
                          <div>
                            <span>完成时间</span>
                            <strong>
                              {refund.completedAt ? (
                                <time dateTime={refund.completedAt}>{customerSessionDate(refund.completedAt)}</time>
                              ) : '尚未完成'}
                            </strong>
                          </div>
                        </div>
                        {presentation.hint && <p className="muted" role="note">{presentation.hint}</p>}
                      </article>
                    );
                  })}
                </section>
                {(hasPreviousPage || hasNextPage) && (
                  <nav className="actions" aria-label="退款记录分页">
                    <span aria-live="polite">第 {currentPosition.index + 1} 页</span>
                    <button type="button" disabled={!hasPreviousPage || refunds.isFetching} onClick={goPrevious}>
                      上一页
                    </button>
                    <button type="button" disabled={!hasNextPage || refunds.isFetching} onClick={goNext}>
                      下一页
                    </button>
                  </nav>
                )}
              </>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

const customerWebhookEventLabels: Record<CustomerWebhookEventType, string> = {
  'wallet.low_balance': '钱包余额偏低',
  'api_key.expiring': 'API Key 即将到期',
  'service_plan_order.status_changed': '服务计划订单状态变化',
  'refund.status_changed': '退款状态变化',
  'request.completed': '请求完成',
  'usage.completed': '用量记录完成',
  'platform.maintenance': '平台维护通知',
};

const customerWebhookEndpointStateLabels: Record<CustomerWebhookEndpoint['state'], string> = {
  active: '已启用',
  suspended: '已停用',
  revoked: '已撤销',
};

const customerWebhookDeliveryStateLabels: Record<CustomerWebhookDeliveryHistoryEntry['status'], string> = {
  pending: '等待发送',
  leased: '发送中',
  delivered: '已送达',
  dead_lettered: '未送达',
  cancelled: '已取消',
};

const customerWebhookSecretStateLabels: Record<CustomerWebhookSecretMetadata['state'], string> = {
  current: '当前密钥',
  overlap: '兼容期',
  revoked: '已撤销',
};

function customerWebhookErrorMessage(error: unknown): string {
  if (error instanceof SaasApiError) {
    if (error.status === 0 || error.code === 'NETWORK') return '网络连接失败，请检查网络后重试。';
    if (error.status === 401 || error.code === 'UNAUTHENTICATED') return '登录状态已过期，请重新登录后继续。';
    if (error.status === 403 || error.code === 'FORBIDDEN' || error.code === 'CSRF_REJECTED') {
      return '当前账号无权执行此操作，或安全校验已过期。';
    }
    if (error.status === 404 || error.code === 'NOT_FOUND') return '端点状态已变化，请刷新列表后重试。';
    if (error.status === 409) return 'Webhook 状态已变化，请刷新后重试。';
  }
  return '暂时无法完成 Webhook 操作，请稍后重试。';
}

function customerWebhookDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function CustomerWebhookEventChoices({
  selected,
  onChange,
}: {
  selected: readonly CustomerWebhookEventType[];
  onChange: (next: CustomerWebhookEventType[]) => void;
}) {
  function toggle(eventType: CustomerWebhookEventType, checked: boolean) {
    onChange(
      checked
        ? [...selected, eventType]
        : selected.filter((selectedEvent) => selectedEvent !== eventType),
    );
  }

  return (
    <fieldset>
      <legend>订阅事件</legend>
      <div className="check-group">
        {Object.entries(customerWebhookEventLabels).map(([eventType, label]) => (
          <label className="check" key={eventType}>
            <input
              type="checkbox"
              checked={selected.includes(eventType as CustomerWebhookEventType)}
              onChange={(event) => toggle(eventType as CustomerWebhookEventType, event.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function OneTimeWebhookSecretNotice({
  value,
  version,
  action,
  onDismiss,
}: {
  value: string;
  version: number;
  action: 'created' | 'rotated';
  onDismiss: () => void;
}) {
  const [copyMessage, setCopyMessage] = useState('');

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage('签名密钥已复制到剪贴板。');
    } catch {
      setCopyMessage('自动复制失败。请手动选择密钥并复制，完成后关闭此提示。');
    }
  }

  return (
    <section className="notice secret" aria-labelledby="webhook-one-time-secret-title">
      <div>
        <strong id="webhook-one-time-secret-title">{action === 'created' ? '端点已创建' : '签名密钥已轮换'} · 版本 {version}</strong>
        <p>此签名密钥只显示这一次。请立即复制并保存在安全位置；关闭提示后将无法再次查看。</p>
      </div>
      <label className="field" htmlFor="webhook-one-time-secret-value">
        一次性签名密钥
        <input
          id="webhook-one-time-secret-value"
          aria-label="一次性签名密钥"
          autoComplete="off"
          readOnly
          spellCheck={false}
          value={value}
        />
      </label>
      <div className="actions">
        <button type="button" onClick={() => void copySecret()}>
          复制密钥
        </button>
        <button type="button" onClick={onDismiss}>
          关闭并清除
        </button>
      </div>
      {copyMessage && <small role="status">{copyMessage}</small>}
    </section>
  );
}

function webhookInput(targetUrl: string, eventTypes: CustomerWebhookEventType[]): CustomerWebhookEndpointInput | string {
  const normalizedUrl = targetUrl.trim();
  if (!normalizedUrl) return '请输入接收地址。';
  if (normalizedUrl.length > 2048) return '接收地址不能超过 2048 个字符。';
  if (eventTypes.length === 0) return '请至少选择一个订阅事件。';
  return { targetUrl: normalizedUrl, eventTypes };
}

export function CustomerWebhooksPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [selectedEndpointId, setSelectedEndpointId] = useState('');
  const [createTargetUrl, setCreateTargetUrl] = useState('');
  const [createEventTypes, setCreateEventTypes] = useState<CustomerWebhookEventType[]>(['request.completed']);
  const [createError, setCreateError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [editingEndpointId, setEditingEndpointId] = useState('');
  const [editTargetUrl, setEditTargetUrl] = useState('');
  const [editEventTypes, setEditEventTypes] = useState<CustomerWebhookEventType[]>([]);
  const [editError, setEditError] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [rotationOverlapMs, setRotationOverlapMs] = useState(86_400_000);
  const [oneTimeSecret, setOneTimeSecret] = useState<{
    tenantId: string;
    endpointId: string;
    value: string;
    version: number;
    action: 'created' | 'rotated';
  }>();

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const tenantId = selectedTenant?.id;
  const canManage = selectedTenant?.role === 'owner' || selectedTenant?.role === 'admin';
  const endpoints = useInfiniteQuery({
    queryKey: tenantId ? customerWebhookEndpointsKey(tenantId) : [...customerWebhookRootKey, '', 'endpoints'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!tenantId) throw new Error('tenant unavailable');
      return saasClient.getCustomerWebhookEndpoints(tenantId, { cursor: pageParam, limit: 100, signal });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(tenantId),
    retry: false,
  });
  const endpointList = useMemo(() => endpoints.data?.pages.flatMap((page) => page.items) ?? [], [endpoints.data]);
  const selectedEndpoint = endpointList.find((endpoint) => endpoint.endpointId === selectedEndpointId) ?? endpointList[0];
  const endpointId = selectedEndpoint?.endpointId;

  const signingSecrets = useQuery({
    queryKey: tenantId && endpointId ? customerWebhookSecretsKey(tenantId, endpointId) : [...customerWebhookRootKey, '', '', 'secrets'],
    queryFn: () => {
      if (!tenantId || !endpointId) throw new Error('endpoint unavailable');
      return saasClient.getCustomerWebhookSigningSecrets(tenantId, endpointId);
    },
    enabled: Boolean(tenantId && endpointId),
    retry: false,
  });
  const deliveryHistory = useInfiniteQuery({
    queryKey:
      tenantId && endpointId
        ? customerWebhookDeliveryHistoryKey(tenantId, endpointId)
        : [...customerWebhookRootKey, '', '', 'deliveries'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!tenantId || !endpointId) throw new Error('endpoint unavailable');
      return saasClient.getCustomerWebhookDeliveryHistory(tenantId, endpointId, {
        cursor: pageParam,
        limit: 20,
        signal,
      });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(tenantId && endpointId),
    retry: false,
  });
  const deliveryRows = useMemo(
    () => deliveryHistory.data?.pages.flatMap((page) => page.items) ?? [],
    [deliveryHistory.data],
  );

  useEffect(() => {
    setSelectedEndpointId('');
    setEditingEndpointId('');
    setOneTimeSecret(undefined);
    setCreateError('');
    setEditError('');
    setActionError('');
  }, [tenantId]);

  useEffect(() => {
    if (selectedEndpoint && selectedEndpoint.endpointId !== selectedEndpointId) {
      setSelectedEndpointId(selectedEndpoint.endpointId);
    }
  }, [selectedEndpoint, selectedEndpointId]);

  async function refreshWebhookData(targetTenantId: string, targetEndpointId?: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: customerWebhookEndpointsKey(targetTenantId) }),
      ...(targetEndpointId
        ? [
            queryClient.invalidateQueries({ queryKey: customerWebhookSecretsKey(targetTenantId, targetEndpointId) }),
            queryClient.invalidateQueries({ queryKey: customerWebhookDeliveryHistoryKey(targetTenantId, targetEndpointId) }),
          ]
        : []),
    ]);
  }

  async function createEndpoint(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !canManage) return;
    const input = webhookInput(createTargetUrl, createEventTypes);
    if (typeof input === 'string') {
      setCreateError(input);
      return;
    }
    setCreateBusy(true);
    setCreateError('');
    setActionError('');
    try {
      const result: CreatedCustomerWebhookEndpoint = await saasClient.createCustomerWebhookEndpoint(tenantId, input);
      setSelectedEndpointId(result.endpoint.endpointId);
      setEditingEndpointId('');
      setOneTimeSecret({
        tenantId,
        endpointId: result.endpoint.endpointId,
        value: result.signingSecret,
        version: result.signingSecretVersion,
        action: 'created',
      });
      setCreateTargetUrl('');
      setCreateEventTypes(['request.completed']);
      await refreshWebhookData(tenantId, result.endpoint.endpointId);
    } catch (error) {
      setCreateError(customerWebhookErrorMessage(error));
    } finally {
      setCreateBusy(false);
    }
  }

  function beginEdit(endpoint: CustomerWebhookEndpoint) {
    setEditingEndpointId(endpoint.endpointId);
    setEditTargetUrl(endpoint.targetUrl);
    setEditEventTypes([...endpoint.eventTypes]);
    setEditError('');
    setActionError('');
  }

  async function updateEndpoint(event: FormEvent, targetEndpointId: string) {
    event.preventDefault();
    if (!tenantId || !canManage) return;
    const input = webhookInput(editTargetUrl, editEventTypes);
    if (typeof input === 'string') {
      setEditError(input);
      return;
    }
    setActionBusy(`${targetEndpointId}:update`);
    setEditError('');
    setActionError('');
    try {
      await saasClient.updateCustomerWebhookEndpoint(tenantId, targetEndpointId, input);
      setEditingEndpointId('');
      await refreshWebhookData(tenantId, targetEndpointId);
    } catch (error) {
      setEditError(customerWebhookErrorMessage(error));
    } finally {
      setActionBusy('');
    }
  }

  async function changeEndpointState(endpoint: CustomerWebhookEndpoint, action: 'enable' | 'disable' | 'revoke') {
    if (!tenantId || !canManage) return;
    if (
      action === 'revoke' &&
      !window.confirm('撤销后，此端点将永久停止接收事件，且无法再次启用。确认撤销？')
    ) {
      return;
    }
    setActionBusy(`${endpoint.endpointId}:${action}`);
    setActionError('');
    try {
      await saasClient.setCustomerWebhookEndpointState(tenantId, endpoint.endpointId, action);
      await refreshWebhookData(tenantId, endpoint.endpointId);
    } catch (error) {
      setActionError(customerWebhookErrorMessage(error));
    } finally {
      setActionBusy('');
    }
  }

  async function rotateSecret() {
    if (!tenantId || !endpointId || !canManage || selectedEndpoint?.state === 'revoked') return;
    if (!window.confirm('轮换后请立即保存新密钥。旧密钥将按所选兼容时长继续有效。是否继续？')) return;
    setActionBusy(`${endpointId}:rotate`);
    setActionError('');
    try {
      const result = await saasClient.rotateCustomerWebhookSigningSecret(tenantId, endpointId, rotationOverlapMs);
      setOneTimeSecret({
        tenantId,
        endpointId,
        value: result.signingSecret,
        version: result.signingSecretVersion,
        action: 'rotated',
      });
      await refreshWebhookData(tenantId, endpointId);
    } catch (error) {
      setActionError(customerWebhookErrorMessage(error));
    } finally {
      setActionBusy('');
    }
  }

  async function revokeSecret(secret: CustomerWebhookSecretMetadata) {
    if (!tenantId || !endpointId || !canManage) return;
    if (!window.confirm(`确认撤销签名密钥版本 ${secret.version}？正在使用该版本的请求将无法通过验证。`)) return;
    setActionBusy(`${endpointId}:secret:${secret.version}`);
    setActionError('');
    try {
      await saasClient.revokeCustomerWebhookSigningSecret(tenantId, endpointId, secret.version);
      await refreshWebhookData(tenantId, endpointId);
    } catch (error) {
      setActionError(customerWebhookErrorMessage(error));
    } finally {
      setActionBusy('');
    }
  }

  const shownSecret = oneTimeSecret?.tenantId === tenantId ? oneTimeSecret : undefined;

  return (
    <div className="saas-console">
      <ConsoleHeader active="webhooks" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">EVENT DELIVERY</p>
          <h1>Webhook 事件通知</h1>
          <p>为租户配置事件接收端点，查看最近投递结果并管理签名密钥。</p>
        </div>
      </div>

      {shownSecret && (
        <OneTimeWebhookSecretNotice
          key={`${shownSecret.endpointId}:${shownSecret.version}`}
          value={shownSecret.value}
          version={shownSecret.version}
          action={shownSecret.action}
          onDismiss={() => setOneTimeSecret(undefined)}
        />
      )}

      {actionError && (
        <div className="notice error" role="alert">
          <strong>Webhook 操作失败</strong>
          <span>{actionError}</span>
        </div>
      )}

      {tenants.isPending ? (
        <div className="skeleton" role="status" aria-label="正在加载租户">
          <i />
          <i />
        </div>
      ) : tenants.isError ? (
        <div className="notice error" role="alert">
          <strong>无法读取租户</strong>
          <span>{customerWebhookErrorMessage(tenants.error)}</span>
          <button type="button" onClick={() => void tenants.refetch()}>
            重试
          </button>
        </div>
      ) : tenants.data?.length === 0 ? (
        <div className="empty">当前账号还没有可访问的租户。</div>
      ) : selectedTenant && tenantId ? (
        <>
          {tenants.data && tenants.data.length > 1 && (
            <Field label="租户">
              <select
                aria-label="选择 Webhook 租户"
                value={selectedTenant.id}
                onChange={(event) => setSelectedTenantId(event.target.value)}
              >
                {tenants.data.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name} · {roleLabels[tenant.role]}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {canManage ? (
            <Panel title="创建端点">
              <form onSubmit={(event) => void createEndpoint(event)}>
                <Field label="接收地址" hint="请使用 HTTPS。服务端会校验目标地址和网络策略。">
                  <input
                    type="url"
                    required
                    maxLength={2048}
                    autoComplete="url"
                    placeholder="https://example.com/webhooks"
                    value={createTargetUrl}
                    onChange={(event) => setCreateTargetUrl(event.target.value)}
                  />
                </Field>
                <CustomerWebhookEventChoices selected={createEventTypes} onChange={setCreateEventTypes} />
                {createError && <div className="form-error" role="alert">{createError}</div>}
                <div className="actions">
                  <button className="primary" type="submit" disabled={createBusy}>
                    {createBusy ? '正在创建…' : '创建 Webhook 端点'}
                  </button>
                  <span className="muted">新签名密钥只显示一次，请在创建后立即保存。</span>
                </div>
              </form>
            </Panel>
          ) : (
            <div className="notice" role="status">当前角色可查看 Webhook 配置和投递记录；仅租户所有者或管理员可以修改。</div>
          )}

          <Panel title="Webhook 端点">
            {endpoints.isPending ? (
              <div className="skeleton" role="status" aria-label="正在加载 Webhook 端点">
                <i />
                <i />
                <i />
              </div>
            ) : endpoints.isError ? (
              <div className="notice error" role="alert">
                <strong>无法读取 Webhook 端点</strong>
                <span>{customerWebhookErrorMessage(endpoints.error)}</span>
                <button type="button" onClick={() => void endpoints.refetch()}>
                  重试
                </button>
              </div>
            ) : endpointList.length === 0 ? (
              <div className="empty">暂无 Webhook 端点。创建端点后，所选事件会发送到你的接收地址。</div>
            ) : (
              <div className="saas-tenant-list" aria-label="Webhook 端点列表">
                {endpointList.map((endpoint, index) => {
                  const selected = selectedEndpoint?.endpointId === endpoint.endpointId;
                  const endpointLabel = `Webhook 端点 ${index + 1}`;
                  const editing = editingEndpointId === endpoint.endpointId;
                  return (
                    <article className="saas-tenant-card" key={endpoint.endpointId}>
                      <div className="saas-tenant-heading">
                        <div>
                          <h3>{endpointLabel}</h3>
                          <small>配置版本 {endpoint.currentVersion} · 更新于 {customerWebhookDate(endpoint.updatedAt)}</small>
                        </div>
                        <Badge tone={endpoint.state === 'active' ? 'good' : endpoint.state === 'suspended' ? 'warn' : 'bad'}>
                          {customerWebhookEndpointStateLabels[endpoint.state]}
                        </Badge>
                      </div>
                      <div className="summary-list">
                        <div>
                          <span>接收地址</span>
                          <code>{endpoint.targetUrl}</code>
                        </div>
                        <div>
                          <span>订阅事件</span>
                          <strong>{endpoint.eventTypes.map((eventType) => customerWebhookEventLabels[eventType]).join('、')}</strong>
                        </div>
                      </div>
                      <div className="actions">
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            setSelectedEndpointId(endpoint.endpointId);
                            setEditingEndpointId('');
                            setEditError('');
                          }}
                        >
                          {selected ? '正在查看投递记录' : '查看投递记录'}
                        </button>
                        {canManage && endpoint.state !== 'revoked' && (
                          <>
                            <button type="button" onClick={() => beginEdit(endpoint)} disabled={actionBusy !== ''}>
                              {editing ? '正在编辑' : '编辑配置'}
                            </button>
                            {endpoint.state === 'active' ? (
                              <button
                                type="button"
                                onClick={() => void changeEndpointState(endpoint, 'disable')}
                                disabled={actionBusy !== ''}
                              >
                                {actionBusy === `${endpoint.endpointId}:disable` ? '正在停用…' : '停用'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void changeEndpointState(endpoint, 'enable')}
                                disabled={actionBusy !== ''}
                              >
                                {actionBusy === `${endpoint.endpointId}:enable` ? '正在启用…' : '启用'}
                              </button>
                            )}
                            <button
                              className="danger"
                              type="button"
                              onClick={() => void changeEndpointState(endpoint, 'revoke')}
                              disabled={actionBusy !== ''}
                            >
                              {actionBusy === `${endpoint.endpointId}:revoke` ? '正在撤销…' : '撤销端点'}
                            </button>
                          </>
                        )}
                      </div>
                      {editing && canManage && (
                        <form className="byok-form" onSubmit={(event) => void updateEndpoint(event, endpoint.endpointId)}>
                          <Field label={`${endpointLabel}接收地址`}>
                            <input
                              type="url"
                              required
                              maxLength={2048}
                              value={editTargetUrl}
                              onChange={(event) => setEditTargetUrl(event.target.value)}
                            />
                          </Field>
                          <CustomerWebhookEventChoices selected={editEventTypes} onChange={setEditEventTypes} />
                          {editError && <div className="form-error" role="alert">{editError}</div>}
                          <div className="actions">
                            <button className="primary" type="submit" disabled={actionBusy !== ''}>
                              {actionBusy === `${endpoint.endpointId}:update` ? '正在保存…' : '保存配置'}
                            </button>
                            <button type="button" onClick={() => setEditingEndpointId('')}>
                              取消
                            </button>
                          </div>
                        </form>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            {endpoints.hasNextPage && (
              <div className="actions">
                <button type="button" onClick={() => void endpoints.fetchNextPage()} disabled={endpoints.isFetchingNextPage}>
                  {endpoints.isFetchingNextPage ? '正在加载…' : '加载更多端点'}
                </button>
              </div>
            )}
          </Panel>

          {selectedEndpoint && (
            <>
              <Panel title="签名密钥">
                <p className="muted">签名密钥用于验证投递请求。密钥明文仅在创建或轮换成功后显示一次。</p>
                {signingSecrets.isPending ? (
                  <div className="skeleton" role="status" aria-label="正在加载签名密钥状态">
                    <i />
                    <i />
                  </div>
                ) : signingSecrets.isError ? (
                  <div className="notice error" role="alert">
                    <strong>无法读取签名密钥状态</strong>
                    <span>{customerWebhookErrorMessage(signingSecrets.error)}</span>
                    <button type="button" onClick={() => void signingSecrets.refetch()}>重试</button>
                  </div>
                ) : signingSecrets.data?.length === 0 ? (
                  <div className="empty">暂无签名密钥信息。</div>
                ) : (
                  <div className="rows" aria-label="签名密钥版本列表">
                    {signingSecrets.data?.map((secret) => (
                      <div className="row" key={secret.version}>
                        <div>
                          <strong>版本 {secret.version} · {customerWebhookSecretStateLabels[secret.state]}</strong>
                          <small>
                            创建于 {customerWebhookDate(secret.createdAt)}
                            {secret.overlapExpiresAt ? ` · 兼容至 ${customerWebhookDate(secret.overlapExpiresAt)}` : ''}
                          </small>
                        </div>
                        {canManage && secret.state !== 'revoked' && (
                          <button
                            className="danger"
                            type="button"
                            onClick={() => void revokeSecret(secret)}
                            disabled={actionBusy !== ''}
                          >
                            {actionBusy === `${endpointId}:secret:${secret.version}` ? '正在撤销…' : '撤销密钥'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {canManage && selectedEndpoint.state !== 'revoked' && (
                  <div className="actions">
                    <Field label="旧密钥兼容时长">
                      <select
                        aria-label="轮换时旧密钥兼容时长"
                        value={rotationOverlapMs}
                        onChange={(event) => setRotationOverlapMs(Number(event.target.value))}
                      >
                        <option value={0}>立即失效</option>
                        <option value={3_600_000}>1 小时</option>
                        <option value={86_400_000}>24 小时</option>
                        <option value={604_800_000}>7 天</option>
                      </select>
                    </Field>
                    <button type="button" onClick={() => void rotateSecret()} disabled={actionBusy !== ''}>
                      {actionBusy === `${endpointId}:rotate` ? '正在轮换…' : '轮换签名密钥'}
                    </button>
                  </div>
                )}
              </Panel>

              <Panel title="最近投递记录">
                <p className="muted">仅显示事件类型、时间和投递结果，不含事件内容或接收地址。记录只读，控制台不提供手动重放。</p>
                {deliveryHistory.isPending ? (
                  <div className="skeleton" role="status" aria-label="正在加载 Webhook 投递记录">
                    <i />
                    <i />
                    <i />
                  </div>
                ) : deliveryHistory.isError ? (
                  <div className="notice error" role="alert">
                    <strong>无法读取投递记录</strong>
                    <span>{customerWebhookErrorMessage(deliveryHistory.error)}</span>
                    <button type="button" onClick={() => void deliveryHistory.refetch()}>重试</button>
                  </div>
                ) : deliveryRows.length === 0 ? (
                  <div className="empty">该端点还没有投递记录。</div>
                ) : (
                  <div className="table-wrap">
                    <table aria-label="Webhook 投递历史">
                      <thead>
                        <tr>
                          <th scope="col">事件</th>
                          <th scope="col">事件时间</th>
                          <th scope="col">状态</th>
                          <th scope="col">尝试次数</th>
                          <th scope="col">HTTP 结果</th>
                          <th scope="col">耗时</th>
                          <th scope="col">错误代码</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveryRows.map((delivery, index) => (
                          <tr key={`${delivery.occurredAt}:${delivery.eventType}:${index}`}>
                            <td>{customerWebhookEventLabels[delivery.eventType]}</td>
                            <td>
                              <time dateTime={delivery.occurredAt}>{customerWebhookDate(delivery.occurredAt)}</time>
                            </td>
                            <td>{customerWebhookDeliveryStateLabels[delivery.status]}</td>
                            <td>{delivery.attempts}</td>
                            <td>{delivery.lastHttpStatus ?? '—'}</td>
                            <td>{delivery.lastLatencyMs === null ? '—' : `${delivery.lastLatencyMs} 毫秒`}</td>
                            <td>{delivery.lastErrorCode ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {deliveryHistory.hasNextPage && (
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => void deliveryHistory.fetchNextPage()}
                      disabled={deliveryHistory.isFetchingNextPage}
                    >
                      {deliveryHistory.isFetchingNextPage ? '正在加载…' : '加载更多记录'}
                    </button>
                  </div>
                )}
              </Panel>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function ConsoleHome({ session, onLogout, onSessionExpired }: {
  session: SafeSession; onLogout: () => Promise<void>; onSessionExpired: () => void;
}) {
  return (
    <div className="saas-console">
      <ConsoleHeader active="workspace" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h1>客户控制台</h1>
          <p>查看租户、项目与自己的权限，管理成员邀请。</p>
        </div>
      </div>
      <WorkspaceContent session={session} onSessionExpired={onSessionExpired} />
    </div>
  );
}

function displayKeyDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

function keyModeLabel(mode: ApiKeyMetadata['supplyMode']): string {
  return mode === 'byok' ? 'BYOK' : '平台供给';
}

function keyStatusLabel(status: ApiKeyMetadata['status']): string {
  return status === 'active' ? '有效' : '已撤销';
}

export function KeyManagementPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [name, setName] = useState('');
  const [scopeText, setScopeText] = useState('');
  const [supplyMode, setSupplyMode] = useState<ApiKeySupplyMode | ''>('');
  const [expiresAt, setExpiresAt] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [actionError, setActionError] = useState<unknown>();
  const [actionKeyId, setActionKeyId] = useState('');
  const [oneTimeSecret, setOneTimeSecret] = useState<CreatedApiKey>();
  const [secretCopied, setSecretCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    if (!tenants.data?.length) return;
    if (!tenants.data.some((tenant) => tenant.id === selectedTenantId)) {
      setSelectedTenantId(tenants.data[0].id);
    }
  }, [selectedTenantId, tenants.data]);

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const tenantId = selectedTenant?.id;
  const projects = useTenantProjects(tenantId);
  const projectSelection = useProjectSelection(tenantId, projects.data, true);
  const projectId = projectSelection.selectedProjectId;
  const selectedProject = projectSelection.selectedProject;
  const keyListKey = [...apiKeysRootKey, tenantId ?? '', projectId ?? ''] as const;
  const canManage = Boolean(
    selectedTenant &&
      selectedProject &&
      keyManagementRoles.has(selectedTenant.role) &&
      keyManagementRoles.has(selectedProject.role),
  );
  const keys = useQuery({
    queryKey: keyListKey,
    queryFn: () => {
      if (!tenantId || !projectId) throw new Error('项目未选择');
      return saasClient.getApiKeys(tenantId, projectId);
    },
    enabled: Boolean(tenantId && projectId && canManage),
    retry: false,
  });

  useEffect(() => {
    setOneTimeSecret(undefined);
    setSecretCopied(false);
    setCopyMessage('');
    setActionError(undefined);
    setActionKeyId('');
    setCreateError('');
  }, [projectId, tenantId]);

  function closeSecret() {
    setOneTimeSecret(undefined);
    setSecretCopied(false);
    setCopyMessage('');
  }

  async function copySecret() {
    if (!oneTimeSecret) return;
    try {
      await navigator.clipboard.writeText(oneTimeSecret.secret);
      setSecretCopied(true);
      setCopyMessage('secret 已复制；现在可以关闭面板。');
    } catch {
      setCopyMessage('自动复制失败，请点击 secret 输入框后手动复制；复制完成后再关闭面板。');
    }
  }

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !projectId) return;
    if (!isApiKeySupplyMode(supplyMode)) {
      setCreateError('请选择供给模式。');
      return;
    }
    const scopes = parseModelScopes(scopeText);
    if (!name.trim()) {
      setCreateError('请输入 API Key 名称。');
      return;
    }
    if (scopes.error) {
      setCreateError(scopes.error);
      return;
    }
    let expiry: string | undefined;
    if (expiresAt) {
      const expiryDate = new Date(expiresAt);
      if (!Number.isFinite(expiryDate.getTime()) || expiryDate.getTime() <= Date.now()) {
        setCreateError('有效期必须是未来时间。');
        return;
      }
      expiry = expiryDate.toISOString();
    }
    setCreateBusy(true);
    setCreateError('');
    setActionError(undefined);
    try {
      const created = await saasClient.createApiKey(tenantId, projectId, {
        name: name.trim(),
        modelScopes: scopes.scopes,
        supplyMode,
        ...(expiry ? { expiresAt: expiry } : {}),
      });
      setOneTimeSecret(created);
      setSecretCopied(false);
      setCopyMessage('');
      setName('');
      setScopeText('');
      setExpiresAt('');
      await queryClient.invalidateQueries({ queryKey: keyListKey });
    } catch (error) {
      setCreateError(keyErrorMessage(error));
    } finally {
      setCreateBusy(false);
    }
  }

  async function rotateKey(key: ApiKeyMetadata) {
    if (!tenantId || !projectId || !window.confirm(`轮换“${key.name}”会立即撤销当前 key 并创建新的 secret，是否继续？`))
      return;
    setActionKeyId(key.id);
    setActionError(undefined);
    try {
      const rotated = await saasClient.rotateApiKey(tenantId, projectId, key.id);
      setOneTimeSecret(rotated);
      setSecretCopied(false);
      setCopyMessage('');
      await queryClient.invalidateQueries({ queryKey: keyListKey });
    } catch (error) {
      setActionError(error);
    } finally {
      setActionKeyId('');
    }
  }

  async function revokeKey(key: ApiKeyMetadata) {
    if (!tenantId || !projectId || !window.confirm(`确认撤销“${key.name}”？撤销后该 key 不能继续调用 API。`)) return;
    setActionKeyId(key.id);
    setActionError(undefined);
    try {
      await saasClient.revokeApiKey(tenantId, projectId, key.id);
      await queryClient.invalidateQueries({ queryKey: keyListKey });
    } catch (error) {
      setActionError(error);
    } finally {
      setActionKeyId('');
    }
  }

  return (
    <div className="saas-console">
      <ConsoleHeader active="keys" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">API ACCESS</p>
          <h1>API Keys</h1>
          <p>管理所选项目的 Proxy API Key。完整 secret 只会在创建或轮换成功后显示一次。</p>
        </div>
      </div>
      <State
        loading={tenants.isPending}
        error={tenants.error}
        retry={() => {
          void tenants.refetch();
        }}
        empty={tenants.data?.length === 0}
        emptyAction={<p>暂无所属租户。</p>}
      >
        {selectedTenant && (
          <>
            {tenants.data && tenants.data.length > 1 && (
              <Field label="租户">
                <select
                  aria-label="选择租户"
                  value={selectedTenant.id}
                  onChange={(event) => {
                    setSelectedTenantId(event.target.value);
                    setActionError(undefined);
                  }}
                >
                  {tenants.data.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name} · {roleLabels[tenant.role]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Panel title="当前范围">
              {projects.data && (
                <ProjectPicker
                  projects={projects.data}
                  value={projectId}
                  onChange={projectSelection.selectProject}
                  loading={projects.isPending}
                />
              )}
              {projects.error && (
                <ErrorNotice
                  error={projects.error}
                  onRetry={() => {
                    void projects.refetch();
                  }}
                />
              )}
              <div className="summary-list">
                <div>
                  <span>所属租户</span>
                  <strong>
                    {selectedTenant.name} <code>{selectedTenant.id}</code>
                  </strong>
                </div>
                <div>
                  <span>当前项目</span>
                  <strong>
                    {selectedProject ? (
                      <>
                        {selectedProject.name} <code>{selectedProject.id}</code>
                      </>
                    ) : projects.error ? (
                      '项目列表加载失败'
                    ) : projects.isPending ? (
                      '正在加载项目…'
                    ) : (
                      '暂无可访问项目'
                    )}
                  </strong>
                </div>
                <div>
                  <span>租户角色</span>
                  <Badge tone={keyManagementRoles.has(selectedTenant.role) ? 'good' : 'warn'}>
                    {roleLabels[selectedTenant.role]}
                  </Badge>
                </div>
                <div>
                  <span>项目角色</span>
                  <Badge tone={selectedProject && keyManagementRoles.has(selectedProject.role) ? 'good' : 'warn'}>
                    {selectedProject ? roleLabels[selectedProject.role] : '—'}
                  </Badge>
                </div>
              </div>
              <p className="muted">
                页面显隐依据租户和项目角色作粗筛；最终权限仍由服务端根据当前 tenant/project 重新校验。
              </p>
            </Panel>
            {projects.data && projects.data.length === 0 && (
              <div className="notice" role="status">
                <strong>暂无可访问项目</strong>
                <span>该租户没有返回当前成员有权访问的项目，因此不会发起 API Key 请求。</span>
              </div>
            )}
            {selectedProject && canManage && (
              <Panel title="新建 API Key">
                <p className="muted">
                  请填写已获权益覆盖的精确模型标识，每行一个 scope。这里不伪造模型目录，最终范围由服务端供给权益校验。
                </p>
                <form onSubmit={createKey}>
                  <Field label="名称">
                    <input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
                  </Field>
                  <Field
                    label="供给模式"
                    hint="BYOK = 租户自有上游凭证；平台供给 = 平台授权池。当前项目无所选模式 entitlement 时，服务端会拒绝创建。"
                  >
                    <select
                      required
                      aria-label="选择供给模式"
                      value={supplyMode}
                      onChange={(event) => setSupplyMode(event.target.value as ApiKeySupplyMode | '')}
                    >
                      <option value="">请选择供给模式</option>
                      <option value="byok">BYOK — 租户自有上游凭证</option>
                      <option value="platform">平台供给 — 平台授权池</option>
                    </select>
                  </Field>
                  <Field label="有效期至（可选）" hint="留空表示不过期；必须选择未来时间。">
                    <input
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(event) => setExpiresAt(event.target.value)}
                    />
                  </Field>
                  <Field label="模型范围" hint="必填；支持换行或逗号分隔，不能重复。">
                    <textarea
                      required
                      rows={4}
                      aria-label="精确模型范围"
                      value={scopeText}
                      onChange={(event) => setScopeText(event.target.value)}
                      placeholder="例如：model-scope-a\nmodel-scope-b"
                    />
                  </Field>
                  {createError && (
                    <p className="form-error" role="alert">
                      {createError}
                    </p>
                  )}
                  <SaveButton busy={createBusy}>创建 API Key</SaveButton>
                </form>
              </Panel>
            )}
            {selectedProject && !canManage && (
              <div className="notice" role="status">
                <strong>当前角色无权查看 API Keys</strong>
                <span>
                  当前租户或所选项目角色不能读取或管理 API Key，因此页面不会发起 key
                  列表请求。前端显隐不替代服务端对租户和项目角色的重新授权。
                </span>
              </div>
            )}
            {oneTimeSecret && (
              <div className="notice secret" role="dialog" aria-modal="true" aria-labelledby="one-time-secret-title">
                <strong id="one-time-secret-title">一次性 secret</strong>
                <span>请立即复制并安全保存。关闭面板后 React state 会清空，服务端也不会再次返回完整 secret。</span>
                <input
                  aria-label="一次性 API Key secret"
                  readOnly
                  value={oneTimeSecret.secret}
                  onFocus={(event) => event.currentTarget.select()}
                  onCopy={() => {
                    setSecretCopied(true);
                    setCopyMessage('secret 已复制；现在可以关闭面板。');
                  }}
                />
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      void copySecret();
                    }}
                  >
                    复制 secret
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      if (
                        secretCopied ||
                        window.confirm('请确认你已手动复制并安全保存 secret；关闭后页面不会再次显示完整 secret。')
                      )
                        closeSecret();
                    }}
                  >
                    关闭面板
                  </button>
                </div>
                {copyMessage && <small role="status">{copyMessage}</small>}
              </div>
            )}
            {selectedProject && canManage && (
              <Panel title="API Keys">
                {actionError !== undefined ? <KeyErrorNotice error={actionError} /> : null}
                {!keys.isPending && !keys.error && (keys.data?.length ?? 0) === 0 && (
                  <div className="empty">当前项目暂无 API Key。</div>
                )}
                {keys.isPending && <State loading>正在加载 API Keys…</State>}
                {keys.error && (
                  <KeyErrorNotice
                    error={keys.error}
                    onRetry={() => {
                      void keys.refetch();
                    }}
                  />
                )}
                {(keys.data?.length ?? 0) > 0 && (
                  <div className="saas-tenant-list">
                    {keys.data?.map((key) => (
                      <article className="saas-tenant-card" key={key.id}>
                        <div className="saas-tenant-heading">
                          <div>
                            <h3>{key.name}</h3>
                            <small>
                              <code>{key.prefix}</code>
                            </small>
                          </div>
                          <Badge tone={key.status === 'active' ? 'good' : 'bad'}>{keyStatusLabel(key.status)}</Badge>
                        </div>
                        <div className="summary-list">
                          <div>
                            <span>供给模式</span>
                            <Badge>{keyModeLabel(key.supplyMode)}</Badge>
                          </div>
                          <div>
                            <span>模型范围</span>
                            <span>
                              {key.modelScopes.map((scope) => (
                                <code key={scope}>{scope} </code>
                              ))}
                            </span>
                          </div>
                          <div>
                            <span>创建时间</span>
                            <strong>{displayKeyDate(key.createdAt)}</strong>
                          </div>
                          <div>
                            <span>过期时间</span>
                            <strong>{displayKeyDate(key.expiresAt)}</strong>
                          </div>
                          <div>
                            <span>最近使用</span>
                            <strong>{key.lastUsedAt ? displayKeyDate(key.lastUsedAt) : '尚未使用'}</strong>
                          </div>
                          {key.revokedAt && (
                            <div>
                              <span>撤销时间</span>
                              <strong>{displayKeyDate(key.revokedAt)}</strong>
                            </div>
                          )}
                        </div>
                        {canManage && key.status === 'active' && (
                          <div className="actions">
                            <button
                              type="button"
                              disabled={Boolean(actionKeyId)}
                              onClick={() => {
                                void rotateKey(key);
                              }}
                            >
                              轮换
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={Boolean(actionKeyId)}
                              onClick={() => {
                                void revokeKey(key);
                              }}
                            >
                              撤销
                            </button>
                            {actionKeyId === key.id && <small role="status">处理中…</small>}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </Panel>
            )}
          </>
        )}
      </State>
    </div>
  );
}

type TenantByokLifecycleAction = 'disable' | 'enable' | 'revoke';
type TenantByokCreateDraft = Omit<TenantByokCredentialCreateInput, 'expiresAt' | 'secret'> & { expiresAt: string };
type TenantByokSecretScope = Pick<TenantByokCreateDraft, 'providerId' | 'productId'>;

export function updateByokSecretForScopeChange(
  current: TenantByokSecretScope,
  next: TenantByokSecretScope,
  secret: string,
): { secret: string; scopeChanged: boolean } {
  const scopeChanged = current.providerId !== next.providerId || current.productId !== next.productId;
  return { secret: scopeChanged ? '' : secret, scopeChanged };
}

interface TenantByokConfirmation {
  credential: TenantByokCredential;
  action: TenantByokLifecycleAction;
}

function emptyTenantByokDraft(): TenantByokCreateDraft {
  return {
    displayName: '',
    providerId: '',
    productId: '',
    credentialType: '',
    region: '',
    purpose: '',
    model: '',
    endpoint: '',
    expiresAt: '',
  };
}

function tenantByokStatusLabel(status: TenantByokCredentialStatus): string {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'active':
      return '启用';
    case 'disabled':
      return '已停用';
    case 'revoked':
      return '已撤销';
  }
}

function tenantByokValidationLabel(state: TenantByokValidationState): string {
  switch (state) {
    case 'unverified':
      return '未验证';
    case 'verified':
      return '已验证';
    case 'failed':
      return '验证失败';
  }
}

function tenantByokStatusTone(status: TenantByokCredentialStatus): 'neutral' | 'good' | 'bad' | 'warn' {
  if (status === 'active') return 'good';
  if (status === 'disabled') return 'warn';
  if (status === 'revoked') return 'bad';
  return 'neutral';
}

function tenantByokValidationTone(state: TenantByokValidationState): 'good' | 'bad' | 'warn' {
  if (state === 'verified') return 'good';
  if (state === 'failed') return 'bad';
  return 'warn';
}

function tenantByokErrorMessage(error: unknown): string {
  // Never render server-provided error text beside a Secret input; a faulty server must not echo it.
  if (!(error instanceof SaasApiError)) return '请求失败，请稍后重试。';
  if (error.status === 401) return '登录状态已失效，请重新登录后再试。';
  if (error.status === 403) return '当前账号无权管理所选租户的 BYOK 凭证。';
  if (error.status === 404) return '凭证不存在或已不属于当前租户。';
  if (error.status === 409 || error.status === 412 || /VERSION|CONFLICT|STALE/i.test(error.code)) {
    return '凭证已被其他操作更改，或当前状态不允许此操作。请核对最新列表后重试。';
  }
  if (error.status === 503) return '凭证服务暂不可用，请稍后重试。';
  if (error.status === 0) return '网络连接失败，请检查连接后重试。';
  return `凭证请求失败（HTTP ${error.status}）。请稍后重试。`;
}

function tenantByokExpiry(value: string): { value?: string; error?: string } {
  if (!value) return {};
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return { error: '有效期必须晚于当前时间。' };
  return { value: new Date(timestamp).toISOString() };
}

function tenantByokDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '—';
}

function tenantByokConfirmationCopy(confirmation: TenantByokConfirmation): {
  title: string;
  description: string;
  button: string;
} {
  const name = confirmation.credential.account.displayName;
  switch (confirmation.action) {
    case 'disable':
      return {
        title: '停用凭证',
        description: `确认停用“${name}”？停用后，使用该凭证的请求将无法继续。`,
        button: '确认停用',
      };
    case 'enable':
      return { title: '恢复凭证', description: `确认恢复“${name}”？恢复后该凭证可重新用于请求。`, button: '确认恢复' };
    case 'revoke':
      return {
        title: '撤销凭证',
        description: `确认撤销“${name}”？此操作不可恢复，凭证将无法再用于请求。`,
        button: '确认撤销',
      };
  }
}

export function ByokCredentialsPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [createDraft, setCreateDraft] = useState<TenantByokCreateDraft>(emptyTenantByokDraft);
  const [createSecret, setCreateSecret] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [rotationTargetId, setRotationTargetId] = useState('');
  const [rotationSecret, setRotationSecret] = useState('');
  const [rotationExpiry, setRotationExpiry] = useState('');
  const [rotationBusy, setRotationBusy] = useState(false);
  const [rotationError, setRotationError] = useState('');
  const [confirmation, setConfirmation] = useState<TenantByokConfirmation>();
  const [actionBusyId, setActionBusyId] = useState('');
  const [actionError, setActionError] = useState<unknown>();
  const [successMessage, setSuccessMessage] = useState('');
  const cancelConfirmationRef = useRef<HTMLButtonElement>(null);
  const acceptConfirmationRef = useRef<HTMLButtonElement>(null);
  const tenantPickerRef = useRef<HTMLSelectElement>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);
  const confirmationWasOpenRef = useRef(false);
  const actionBusyRef = useRef(false);
  actionBusyRef.current = Boolean(actionBusyId);

  useEffect(() => {
    if (!tenants.data?.length) return;
    if (!tenants.data.some((tenant) => tenant.id === selectedTenantId)) setSelectedTenantId(tenants.data[0].id);
  }, [selectedTenantId, tenants.data]);

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const tenantId = selectedTenant?.id;
  const canManageTenant = Boolean(
    selectedTenant && (selectedTenant.role === 'owner' || selectedTenant.role === 'admin'),
  );
  const mutationBusy = createBusy || rotationBusy || Boolean(actionBusyId);
  const credentialListKey = [...byokCredentialsRootKey, tenantId ?? ''] as const;
  const credentials = useQuery({
    queryKey: credentialListKey,
    queryFn: () => {
      if (!tenantId) throw new Error('租户未选择');
      return saasClient.getTenantByokCredentials(tenantId);
    },
    enabled: Boolean(tenantId && canManageTenant),
    retry: false,
  });

  useEffect(() => {
    setCreateDraft(emptyTenantByokDraft());
    setCreateSecret('');
    setCreateError('');
    setRotationTargetId('');
    setRotationSecret('');
    setRotationExpiry('');
    setRotationError('');
    setConfirmation(undefined);
    setActionError(undefined);
    setSuccessMessage('');
  }, [tenantId, canManageTenant]);

  useEffect(() => {
    if (!confirmation) {
      if (confirmationWasOpenRef.current) {
        confirmationWasOpenRef.current = false;
        const trigger = confirmationTriggerRef.current;
        confirmationTriggerRef.current = null;
        if (trigger?.isConnected) trigger.focus();
        else tenantPickerRef.current?.focus();
      }
      return;
    }
    confirmationWasOpenRef.current = true;
    cancelConfirmationRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (actionBusyRef.current) return;
        event.preventDefault();
        setConfirmation(undefined);
      } else if (event.key === 'Tab') {
        const cancel = cancelConfirmationRef.current;
        const accept = acceptConfirmationRef.current;
        if (!cancel || !accept) return;
        if (
          event.shiftKey &&
          (document.activeElement === cancel ||
            !document.activeElement ||
            !document.activeElement.closest('.byok-confirmation'))
        ) {
          event.preventDefault();
          accept.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === accept ||
            !document.activeElement ||
            !document.activeElement.closest('.byok-confirmation'))
        ) {
          event.preventDefault();
          cancel.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmation]);

  function clearCreateDraft() {
    setCreateDraft(emptyTenantByokDraft());
    setCreateSecret('');
    setCreateError('');
  }

  function clearRotationDraft() {
    setRotationTargetId('');
    setRotationSecret('');
    setRotationExpiry('');
    setRotationError('');
  }

  function changeTenant(nextTenantId: string) {
    if (!tenants.data?.some((tenant) => tenant.id === nextTenantId)) return;
    setSelectedTenantId(nextTenantId);
    clearCreateDraft();
    clearRotationDraft();
    setConfirmation(undefined);
    setActionError(undefined);
    setSuccessMessage('');
  }

  function updateCreateIdentity(field: 'providerId' | 'productId', value: string) {
    const nextDraft = { ...createDraft, [field]: value };
    const secretUpdate = updateByokSecretForScopeChange(createDraft, nextDraft, createSecret);
    if (secretUpdate.scopeChanged && createSecret) {
      setCreateSecret(secretUpdate.secret);
      setCreateError('Provider 或产品已更改，Secret 已清空，请重新输入。');
    }
    setCreateDraft(nextDraft);
  }

  async function createCredential(event: FormEvent) {
    event.preventDefault();
    if (mutationBusy) return;
    if (!tenantId || !canManageTenant) return;
    const requiredFields: Array<[string, string]> = [
      ['凭证名称', createDraft.displayName],
      ['Provider ID', createDraft.providerId],
      ['产品 ID', createDraft.productId],
      ['凭证类型', createDraft.credentialType],
      ['区域', createDraft.region],
      ['用途', createDraft.purpose],
      ['模型', createDraft.model],
      ['Endpoint', createDraft.endpoint],
    ];
    const missing = requiredFields.find(([, value]) => !value.trim());
    if (missing) {
      setCreateError(`请填写${missing[0]}。`);
      return;
    }
    if (!createSecret) {
      setCreateError('请输入 Secret。');
      return;
    }
    const expiry = tenantByokExpiry(createDraft.expiresAt);
    if (expiry.error) {
      setCreateError(expiry.error);
      return;
    }

    setCreateBusy(true);
    setCreateError('');
    setActionError(undefined);
    setSuccessMessage('');
    const input: TenantByokCredentialCreateInput = {
      displayName: createDraft.displayName.trim(),
      providerId: createDraft.providerId.trim(),
      productId: createDraft.productId.trim(),
      credentialType: createDraft.credentialType.trim(),
      region: createDraft.region.trim(),
      purpose: createDraft.purpose.trim(),
      model: createDraft.model.trim(),
      endpoint: createDraft.endpoint.trim(),
      secret: createSecret,
      ...(expiry.value ? { expiresAt: expiry.value } : {}),
    };
    try {
      const result = await saasClient.createTenantByokCredential(tenantId, input);
      clearCreateDraft();
      setSuccessMessage(
        `凭证已创建。服务端验证状态：${tenantByokValidationLabel(result.credential.validationState)}。`,
      );
      await queryClient.invalidateQueries({ queryKey: credentialListKey });
    } catch (error) {
      setCreateError(tenantByokErrorMessage(error));
      if (error instanceof SaasApiError && (error.status === 409 || error.status === 412)) {
        await queryClient.invalidateQueries({ queryKey: credentialListKey });
      }
    } finally {
      setCreateBusy(false);
    }
  }

  async function replaceSecret(event: FormEvent, credential: TenantByokCredential) {
    event.preventDefault();
    if (mutationBusy) return;
    if (!tenantId || !canManageTenant || credential.currentVersion === null) return;
    if (!rotationSecret) {
      setRotationError('请输入新的 Secret。');
      return;
    }
    const expiry = tenantByokExpiry(rotationExpiry);
    if (expiry.error) {
      setRotationError(expiry.error);
      return;
    }

    setRotationBusy(true);
    setRotationError('');
    setActionError(undefined);
    setSuccessMessage('');
    try {
      const result = await saasClient.replaceTenantByokCredentialSecret(tenantId, credential.id, {
        expectedVersion: credential.currentVersion,
        secret: rotationSecret,
        ...(expiry.value ? { expiresAt: expiry.value } : {}),
      });
      clearRotationDraft();
      setSuccessMessage(
        `Secret 已替换为版本 ${result.version?.version ?? '新版本'}。服务端验证状态：${tenantByokValidationLabel(result.credential.validationState)}。`,
      );
      await queryClient.invalidateQueries({ queryKey: credentialListKey });
    } catch (error) {
      setRotationError(tenantByokErrorMessage(error));
      if (error instanceof SaasApiError && (error.status === 409 || error.status === 412)) {
        await queryClient.invalidateQueries({ queryKey: credentialListKey });
      }
    } finally {
      setRotationBusy(false);
    }
  }

  async function performLifecycleAction() {
    if (mutationBusy) return;
    if (!tenantId || !canManageTenant || !confirmation) return;
    const current = confirmation;
    const lifecycleInput: TenantByokCredentialLifecycleInput = {
      expectedAuthzVersion: current.credential.authzVersion,
    };
    setActionBusyId(current.credential.id);
    setActionError(undefined);
    setSuccessMessage('');
    try {
      if (current.action === 'disable') {
        await saasClient.disableTenantByokCredential(tenantId, current.credential.id, lifecycleInput);
      } else if (current.action === 'enable') {
        await saasClient.enableTenantByokCredential(tenantId, current.credential.id, lifecycleInput);
      } else {
        await saasClient.revokeTenantByokCredential(tenantId, current.credential.id, lifecycleInput);
      }
      clearCreateDraft();
      clearRotationDraft();
      setConfirmation(undefined);
      setSuccessMessage(
        `“${current.credential.account.displayName}”已${current.action === 'disable' ? '停用' : current.action === 'enable' ? '恢复' : '撤销'}。`,
      );
      await queryClient.invalidateQueries({ queryKey: credentialListKey });
    } catch (error) {
      setConfirmation(undefined);
      setActionError(error);
      if (error instanceof SaasApiError && (error.status === 409 || error.status === 412)) {
        await queryClient.invalidateQueries({ queryKey: credentialListKey });
      }
    } finally {
      setActionBusyId('');
    }
  }

  function openConfirmation(credential: TenantByokCredential, action: TenantByokLifecycleAction) {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      confirmationTriggerRef.current = document.activeElement;
    }
    setConfirmation({ credential, action });
  }

  return (
    <div className="saas-console byok-console">
      <ConsoleHeader active="credentials" onLogout={onLogout} />
      <div className="page-title">
                  <div>
          <p className="eyebrow">BYOK CREDENTIALS</p>
          <h1>BYOK 凭证</h1>
          <p>管理当前租户自有的 Provider 凭证。完整 Secret 不会再次显示。</p>
        </div>
      </div>
      <State
        loading={tenants.isPending}
        error={tenants.error}
        retry={() => {
          void tenants.refetch();
        }}
        empty={tenants.data?.length === 0}
        emptyAction={<p>当前账号没有可访问的租户。</p>}
      >
        {selectedTenant && (
          <>
            <Panel title="当前租户">
              <Field label="租户" hint="租户选项来自当前登录账号可访问的租户列表。">
                <select
                  ref={tenantPickerRef}
                  aria-label="选择租户"
                  value={selectedTenant.id}
                  disabled={mutationBusy}
                  onChange={(event) => changeTenant(event.target.value)}
                >
                  {(tenants.data ?? []).map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name} · {roleLabels[tenant.role]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="summary-list">
                <div>
                  <span>租户名称</span>
                  <strong>{selectedTenant.name}</strong>
                </div>
                <div>
                  <span>当前角色</span>
                  <Badge tone={canManageTenant ? 'good' : 'warn'}>{roleLabels[selectedTenant.role]}</Badge>
                </div>
                <div>
                  <span>默认项目 ID</span>
                  <strong>{selectedTenant.defaultProjectId ?? '服务端未提供'}</strong>
                </div>
              </div>
              <p className="muted">
                凭证列表按租户显示；此 API 不接收 projectId。创建和凭证写入的 BYOK 权益由服务端按租户默认项目上下文校验。
              </p>
            </Panel>

            {!canManageTenant && (
              <div className="notice" role="status">
                <strong>当前角色无权管理 BYOK 凭证</strong>
                <span>只有租户 owner 或 admin 可以查看和管理凭证；页面不会为此角色请求凭证列表。</span>
              </div>
            )}

            {canManageTenant && (
              <>
                <Panel title="添加 BYOK 凭证">
                  <p className="muted">
                    请按已发布 Provider 权益和能力目录填写标识。服务端会校验当前权益及已验证能力；Secret
                    仅随本次请求提交，不会写入浏览器存储、草稿或页面回显。
                  </p>
                  <form
                    className="byok-form"
                    onSubmit={(event) => {
                      void createCredential(event);
                    }}
                  >
                    <fieldset className="byok-fields" disabled={mutationBusy}>
                    <div className="form-grid">
                      <Field label="凭证名称">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.displayName}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, displayName: event.target.value }))
                          }
                        />
                      </Field>
                      <Field label="Provider ID">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.providerId}
                          onChange={(event) => updateCreateIdentity('providerId', event.target.value)}
                        />
                      </Field>
                      <Field label="产品 ID">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.productId}
                          onChange={(event) => updateCreateIdentity('productId', event.target.value)}
                        />
                      </Field>
                      <Field label="凭证类型">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.credentialType}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, credentialType: event.target.value }))
                          }
                        />
                      </Field>
                      <Field label="区域">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.region}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, region: event.target.value }))
                          }
                        />
                      </Field>
                      <Field label="用途">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.purpose}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, purpose: event.target.value }))
                          }
                        />
                      </Field>
                      <Field label="模型">
                        <input
                          required
                          maxLength={200}
                          value={createDraft.model}
                          onChange={(event) => setCreateDraft((current) => ({ ...current, model: event.target.value }))}
                        />
                      </Field>
                      <Field label="Endpoint">
                        <input
                          required
                          maxLength={120}
                          value={createDraft.endpoint}
                          onChange={(event) =>
                            setCreateDraft((current) => ({ ...current, endpoint: event.target.value }))
                          }
                        />
                      </Field>
                    </div>
                    <Field label="Secret" hint="仅在本次创建请求中提交；创建成功或取消后立即清空。">
                      <input
                        required
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={createSecret}
                        onChange={(event) => {
                          setCreateSecret(event.target.value);
                          setCreateError('');
                        }}
                      />
                    </Field>
                    <Field label="Secret 有效期（可选）" hint="留空表示不过期；如填写，必须晚于当前时间。">
                      <input
                        type="datetime-local"
                        value={createDraft.expiresAt}
                        onChange={(event) =>
                          setCreateDraft((current) => ({ ...current, expiresAt: event.target.value }))
                        }
                      />
                    </Field>
                    </fieldset>
                    {createError && (
                      <p className="form-error" role="alert">
                        {createError}
                      </p>
                    )}
                    <div className="actions">
                      <SaveButton busy={mutationBusy}>创建凭证</SaveButton>
                      <button type="button" className="quiet" disabled={mutationBusy} onClick={clearCreateDraft}>
                        取消并清空
                      </button>
                    </div>
                  </form>
                </Panel>

                <Panel
                  title="已登记凭证"
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        void credentials.refetch();
                      }}
                      disabled={credentials.isFetching || mutationBusy}
                    >
                      刷新列表
                    </button>
                  }
                >
                  {actionError !== undefined && (
                    <div className="notice error" role="alert">
                      <strong>凭证操作失败</strong>
                      <span>{tenantByokErrorMessage(actionError)}</span>
                    </div>
                  )}
                  {successMessage && (
                    <div className="notice" role="status">
                      {successMessage}
                    </div>
                  )}
                  {credentials.isPending && (
                    <div className="byok-loading" role="status" aria-live="polite">
                      <State loading>{null}</State>
                      <span>正在加载 BYOK 凭证…</span>
                    </div>
                  )}
                  {credentials.error && (
                    <ErrorNotice
                      error={new Error(tenantByokErrorMessage(credentials.error))}
                      onRetry={() => {
                        void credentials.refetch();
                      }}
                    />
                  )}
                  {!credentials.isPending && !credentials.error && credentials.data?.length === 0 && (
                    <div className="empty" role="status">当前租户暂无 BYOK 凭证。</div>
                  )}
                  {credentials.data && credentials.data.length > 0 && (
                    <div className="saas-tenant-list byok-credential-list">
                      {credentials.data.map((credential) => (
                        <article className="saas-tenant-card byok-credential-card" key={credential.id}>
                          <div className="saas-tenant-heading">
                            <div>
                              <h3>{credential.account.displayName}</h3>
                              <small>
                                {credential.account.providerId} · {credential.account.productId}
                              </small>
                            </div>
                            <Badge tone={tenantByokStatusTone(credential.status)}>
                              {tenantByokStatusLabel(credential.status)}
                            </Badge>
                          </div>
                          <div className="summary-list">
                            <div>
                              <span>凭证类型</span>
                              <strong>{credential.account.credentialType}</strong>
                            </div>
                            <div>
                              <span>区域</span>
                              <strong>{credential.account.region}</strong>
                            </div>
                            <div>
                              <span>Secret</span>
                              <strong>
                                {credential.secretConfigured
                                  ? `已登记 · 版本 ${credential.currentVersion ?? '—'}`
                                  : '未登记'}
                              </strong>
                            </div>
                            <div>
                              <span>有效期</span>
                              <strong>{tenantByokDate(credential.expiresAt)}</strong>
                            </div>
                            <div>
                              <span>验证状态</span>
                              <Badge tone={tenantByokValidationTone(credential.validationState)}>
                                {tenantByokValidationLabel(credential.validationState)}
                              </Badge>
                            </div>
                            <div>
                              <span>最近验证</span>
                              <strong>{tenantByokDate(credential.account.lastValidatedAt)}</strong>
                            </div>
                            <div>
                              <span>模型 / Endpoint</span>
                              <span>
                                {credential.account.capabilities.length
                                  ? credential.account.capabilities.map((capability) => (
                                      <code key={`${capability.model}:${capability.endpoint}`}>
                                        {capability.model} · {capability.endpoint}{' '}
                                      </code>
                                    ))
                                  : '—'}
                              </span>
                            </div>
                            <div>
                              <span>创建时间</span>
                              <strong>{tenantByokDate(credential.createdAt)}</strong>
                            </div>
                            {credential.disabledAt && (
                              <div>
                                <span>停用时间</span>
                                <strong>{tenantByokDate(credential.disabledAt)}</strong>
                              </div>
                            )}
                            {credential.revokedAt && (
                              <div>
                                <span>撤销时间</span>
                                <strong>{tenantByokDate(credential.revokedAt)}</strong>
                              </div>
                            )}
                          </div>
                          <div className="notice byok-validation-note" role="status">
                            <span>
                              以上为服务端返回的真实验证状态。客户控制台暂不提供验证任务接口，无法在此主动发起验证。
                            </span>
                          </div>
                          {credential.status !== 'revoked' && (
                            <div className="actions byok-actions">
                              {credential.currentVersion !== null && (
                                <button
                                  type="button"
                                  disabled={mutationBusy}
                                  onClick={() => {
                                    if (rotationTargetId === credential.id) clearRotationDraft();
                                    else {
                                      setRotationTargetId(credential.id);
                                      setRotationSecret('');
                                      setRotationExpiry('');
                                      setRotationError('');
                                    }
                                  }}
                                >
                                  {rotationTargetId === credential.id ? '收起替换表单' : 'CAS 换 Secret'}
                                </button>
                              )}
                              {(credential.status === 'active' || credential.status === 'pending') && (
                                <button
                                  type="button"
                                  disabled={mutationBusy}
                                  onClick={() => openConfirmation(credential, 'disable')}
                                >
                                  停用
                                </button>
                              )}
                              {credential.status === 'disabled' && (
                                <button
                                  type="button"
                                  disabled={mutationBusy}
                                  onClick={() => openConfirmation(credential, 'enable')}
                                >
                                  恢复
                                </button>
                              )}
                              <button
                                type="button"
                                className="danger"
                                disabled={mutationBusy}
                                onClick={() => openConfirmation(credential, 'revoke')}
                              >
                                撤销
                              </button>
                              {actionBusyId === credential.id && <small role="status">正在更新…</small>}
                            </div>
                          )}
                          {credential.status !== 'revoked' && credential.currentVersion === null && (
                            <p className="muted">当前凭证没有可比较的 Secret 版本，不能执行 CAS 替换。</p>
                          )}
                          {rotationTargetId === credential.id && credential.currentVersion !== null && (
                            <form
                              className="byok-rotation-form"
                              onSubmit={(event) => {
                                void replaceSecret(event, credential);
                              }}
                            >
                              <strong>替换 Secret · 期望版本 {credential.currentVersion}</strong>
                              <fieldset className="byok-fields" disabled={mutationBusy}>
                              <Field label="新的 Secret" hint="服务端仅接受与当前版本匹配的 CAS 写入。">
                                <input
                                  required
                                  type="password"
                                  autoComplete="off"
                                  spellCheck={false}
                                  value={rotationSecret}
                                  onChange={(event) => setRotationSecret(event.target.value)}
                                />
                              </Field>
                              <Field label="新版本有效期（可选）">
                                <input
                                  type="datetime-local"
                                  value={rotationExpiry}
                                  onChange={(event) => setRotationExpiry(event.target.value)}
                                />
                              </Field>
                              </fieldset>
                              {rotationError && (
                                <p className="form-error" role="alert">
                                  {rotationError}
                                </p>
                              )}
                              <div className="actions">
                                <SaveButton busy={mutationBusy}>提交 CAS 替换</SaveButton>
                                <button
                                  type="button"
                                  className="quiet"
                                  disabled={mutationBusy}
                                  onClick={clearRotationDraft}
                                >
                                  取消并清空
                                </button>
                              </div>
                            </form>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </Panel>
              </>
            )}
          </>
        )}
      </State>
      {confirmation &&
        (() => {
          const copy = tenantByokConfirmationCopy(confirmation);
          return (
            <div className="byok-modal-backdrop">
              <section
                className="byok-confirmation"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="byok-confirmation-title"
                aria-describedby="byok-confirmation-description"
              >
                <h2 id="byok-confirmation-title">{copy.title}</h2>
                <p id="byok-confirmation-description">{copy.description}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="quiet"
                    ref={cancelConfirmationRef}
                    disabled={Boolean(actionBusyId)}
                    onClick={() => setConfirmation(undefined)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className={confirmation.action === 'revoke' ? 'danger' : 'primary'}
                    ref={acceptConfirmationRef}
                    disabled={Boolean(actionBusyId)}
                    onClick={() => {
                      void performLifecycleAction();
                    }}
                  >
                    {actionBusyId ? '处理中…' : copy.button}
                  </button>
                </div>
              </section>
            </div>
          );
        })()}
    </div>
  );
}

function TenantPicker({
  tenants,
  value,
  onChange,
}: {
  tenants: readonly SafeTenant[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="租户">
      <select aria-label="选择租户" value={value} onChange={(event) => onChange(event.target.value)}>
        {tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenantName(tenant)}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ServicePlanCatalogPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');

  useEffect(() => {
    if (!tenants.data?.length) return;
    if (!tenants.data.some((tenant) => tenant.id === selectedTenantId)) setSelectedTenantId(tenants.data[0].id);
  }, [selectedTenantId, tenants.data]);

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const plans = useQuery({
    queryKey: [...plansRootKey, selectedTenant?.id ?? ''],
    queryFn: () => {
      if (!selectedTenant) throw new Error('租户未选择');
      return saasClient.getServicePlanCatalog(selectedTenant.id);
    },
    enabled: Boolean(selectedTenant),
    retry: false,
  });

  return (
    <div className="saas-console">
      <ConsoleHeader active="catalog" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">SERVICE PLAN CATALOG</p>
          <h1>BYOK 服务计划目录</h1>
          <p>已发布计划支持 activation 购买，并提供可恢复的订单结账状态。</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void plans.refetch();
          }}
          disabled={!selectedTenant || plans.isFetching}
        >
          刷新
        </button>
      </div>
      <div className="notice" role="status">
        <strong>客户自有凭证 · 固定期限服务费</strong>
        <span>
          BYOK 表示你提供并维护自己的上游 Provider 凭证。计划只收固定期限服务费，不包含平台凭证、不接收或显示
          secret，也不会扣除平台 Token wallet（Token 钱包）余额；订单是否成功只以服务端 fulfilled 状态为准。
        </span>
      </div>
      <State
        loading={tenants.isPending}
        error={tenants.error}
        retry={() => {
          void tenants.refetch();
        }}
        empty={tenants.data?.length === 0}
        emptyAction={<p>暂无所属租户。</p>}
      >
        {selectedTenant && (
          <>
            {tenants.data && tenants.data.length > 1 && (
              <TenantPicker tenants={tenants.data} value={selectedTenant.id} onChange={setSelectedTenantId} />
            )}
            <Panel title="已发布 BYOK 计划" action={<small>{selectedTenant.name}</small>}>
              {plans.isPending && <State loading>{null}</State>}
              {plans.error && (
                <ErrorNotice
                  error={plans.error}
                  onRetry={() => {
                    void plans.refetch();
                  }}
                />
              )}
              {!plans.isPending && !plans.error && plans.data?.length === 0 && (
                <div className="empty">当前没有可展示的已发布 BYOK 服务计划。</div>
              )}
              {plans.data && plans.data.length > 0 && (
                <div className="saas-tenant-list">
                  {plans.data.map((plan) => (
                    <ServicePlanCard
                      key={`${selectedTenant.id}:${plan.planVersionId}`}
                      tenantId={selectedTenant.id}
                      plan={plan}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}
      </State>
    </div>
  );
}

function ServicePlanCard({ tenantId, plan }: { tenantId: string; plan: ServicePlanCatalogItem }) {
  return (
    <article className="saas-tenant-card">
      <div className="saas-tenant-heading">
        <div>
          <h3>{plan.planId}</h3>
          <small>版本 {plan.version}</small>
        </div>
        <Badge tone="good">BYOK</Badge>
      </div>
      <div className="summary-list">
        <div>
          <span>期限</span>
          <strong>{plan.termDays} 天</strong>
        </div>
        <div>
          <span>固定服务费</span>
          <strong>{fixedFeeLabel(plan)}</strong>
        </div>
        <div>
          <span>支持 Provider</span>
          <span>
            {plan.supportedProviderIds.map((providerId) => (
              <code key={providerId}>{providerId} </code>
            ))}
          </span>
        </div>
        <div>
          <span>支持模型</span>
          <span>
            {plan.supportedModels.map((model) => (
              <code key={model}>{model} </code>
            ))}
          </span>
        </div>
        <div>
          <span>政策说明</span>
          <strong>{plan.policyDescription}</strong>
        </div>
      </div>
      <ServicePlanPurchase tenantId={tenantId} plan={plan} />
    </article>
  );
}

function ConsoleFilters({
  tenants,
  selectedTenantId,
  onTenantChange,
  fromDate,
  toDate,
  onFromDateChange,
  onToDateChange,
  projects,
  projectsLoading,
  projectsError,
  onRetryProjects,
  projectId,
  onProjectIdChange,
  model,
  onModelChange,
  status,
  onStatusChange,
  supplyMode,
  onSupplyModeChange,
}: {
  tenants: readonly SafeTenant[];
  selectedTenantId: string;
  onTenantChange: (value: string) => void;
  fromDate: string;
  toDate: string;
  onFromDateChange: (value: string) => void;
  onToDateChange: (value: string) => void;
  projects: readonly Project[];
  projectsLoading: boolean;
  projectsError: unknown;
  onRetryProjects: () => void;
  projectId: string;
  onProjectIdChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  status: ConsoleRequestStatus | undefined;
  onStatusChange: (value: ConsoleRequestStatus | undefined) => void;
  supplyMode: 'byok' | 'platform' | undefined;
  onSupplyModeChange: (value: 'byok' | 'platform' | undefined) => void;
}) {
  return (
    <>
      <TenantPicker tenants={tenants} value={selectedTenantId} onChange={onTenantChange} />
      <div className="form-grid">
        <Field label="开始日期">
          <input type="date" value={fromDate} onChange={(event) => onFromDateChange(event.target.value)} />
        </Field>
        <Field label="结束日期（包含）">
          <input type="date" value={toDate} onChange={(event) => onToDateChange(event.target.value)} />
        </Field>
        <ProjectPicker
          projects={projects}
          value={projectId}
          onChange={onProjectIdChange}
          loading={projectsLoading}
          includeAll
        />
        {projectsError ? <ErrorNotice error={projectsError} onRetry={onRetryProjects} /> : null}
        <Field label="模型（可选）">
          <input
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder="按服务端模型标识筛选"
          />
        </Field>
        <Field label="供给模式">
          <select
            value={supplyMode ?? ''}
            onChange={(event) =>
              onSupplyModeChange(event.target.value ? (event.target.value as 'byok' | 'platform') : undefined)
            }
          >
            <option value="">全部模式</option>
            <option value="byok">BYOK — 租户自有上游凭证</option>
            <option value="platform">平台供给 — 平台授权池</option>
          </select>
        </Field>
        <Field label="请求状态">
          <select
            value={status ?? ''}
            onChange={(event) =>
              onStatusChange(event.target.value ? (event.target.value as ConsoleRequestStatus) : undefined)
            }
          >
            <option value="">全部状态</option>
            <option value="pending">处理中</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
            <option value="unknown">未知</option>
          </select>
        </Field>
      </div>
    </>
  );
}

function usageFilters(
  fromDate: string,
  toDate: string,
  projectId: string,
  model: string,
  status: ConsoleRequestStatus | undefined,
  supplyMode: 'byok' | 'platform' | undefined,
): Required<Pick<ConsoleQueryFilters, 'from' | 'to'>> & Omit<ConsoleQueryFilters, 'from' | 'to'> {
  return {
    from: rangeStart(fromDate),
    to: rangeEnd(toDate),
    ...(optionalFilter(projectId) ? { projectId: optionalFilter(projectId) } : {}),
    ...(optionalFilter(model) ? { model: optionalFilter(model) } : {}),
    ...(status === undefined ? {} : { status }),
    ...(supplyMode === undefined ? {} : { supplyMode }),
  };
}

function TokenStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{formatExactDecimal(value)}</strong>
      <small>精确十进制显示</small>
    </div>
  );
}

function UsageSummaryView({ summary }: { summary: ConsoleUsageSummary }) {
  return (
    <>
      <div className="stats">
        <TokenStat label="总 token" value={summary.totalTokens} />
        <TokenStat label="输入 token" value={summary.inputTotal} />
        <TokenStat label="输出 token" value={summary.outputTotal} />
        <TokenStat label="请求数" value={summary.requestCount} />
      </div>
      <div className="summary-list">
        <div>
          <span>用量事件数</span>
          <strong>{formatExactDecimal(summary.eventCount)}</strong>
        </div>
        <div>
          <span>未缓存输入</span>
          <strong>{formatExactDecimal(summary.inputUncached)}</strong>
        </div>
        <div>
          <span>缓存读取</span>
          <strong>{formatExactDecimal(summary.cacheRead)}</strong>
        </div>
        <div>
          <span>缓存写入</span>
          <strong>{formatExactDecimal(summary.cacheWrite)}</strong>
        </div>
        <div>
          <span>推理输出</span>
          <strong>{formatExactDecimal(summary.reasoningOutput)}</strong>
        </div>
      </div>
    </>
  );
}

export function UsagePage({ onLogout }: { onLogout: () => Promise<void> }) {
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [fromDate, setFromDate] = useState(() => dateInputValue(-7));
  const [toDate, setToDate] = useState(() => dateInputValue(0));
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<ConsoleRequestStatus>();
  const [supplyMode, setSupplyMode] = useState<'byok' | 'platform'>();

  useEffect(() => {
    if (!tenants.data?.length) return;
    if (!tenants.data.some((tenant) => tenant.id === selectedTenantId)) setSelectedTenantId(tenants.data[0].id);
  }, [selectedTenantId, tenants.data]);

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const projects = useTenantProjects(selectedTenant?.id);
  const projectSelection = useProjectSelection(selectedTenant?.id, projects.data, false);
  const projectId = projectSelection.selectedProjectId;
  const filters = useMemo(
    () => usageFilters(fromDate, toDate, projectId, model, status, supplyMode),
    [fromDate, toDate, projectId, model, status, supplyMode],
  );
  const usage = useQuery({
    queryKey: [...usageRootKey, selectedTenant?.id ?? '', projectId, filters],
    queryFn: () => {
      if (!selectedTenant) throw new Error('租户未选择');
      return saasClient.getUsageSummary(selectedTenant.id, filters);
    },
    enabled: Boolean(selectedTenant),
    retry: false,
  });

  return (
    <div className="saas-console">
      <ConsoleHeader active="usage" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">USAGE</p>
          <h1>用量分析</h1>
          <p>查看有权访问的租户和项目的聚合用量。查询范围最多 31 天。</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void usage.refetch();
          }}
          disabled={!selectedTenant || usage.isFetching}
        >
          刷新
        </button>
      </div>
      <State
        loading={tenants.isPending}
        error={tenants.error}
        retry={() => {
          void tenants.refetch();
        }}
        empty={tenants.data?.length === 0}
        emptyAction={<p>暂无所属租户。</p>}
      >
        {selectedTenant && (
          <>
            <Panel title="查询范围">
              <ConsoleFilters
                tenants={tenants.data ?? []}
                selectedTenantId={selectedTenant.id}
                onTenantChange={setSelectedTenantId}
                fromDate={fromDate}
                toDate={toDate}
                onFromDateChange={setFromDate}
                onToDateChange={setToDate}
                projects={projects.data ?? []}
                projectsLoading={projects.isPending}
                projectsError={projects.error}
                onRetryProjects={() => {
                  void projects.refetch();
                }}
                projectId={projectId}
                onProjectIdChange={projectSelection.selectProject}
                model={model}
                onModelChange={setModel}
                status={status}
                onStatusChange={setStatus}
                supplyMode={supplyMode}
                onSupplyModeChange={setSupplyMode}
              />
              <p className="muted">
                当前模式：{supplyModeLabel(supplyMode)} · 当前状态：{requestStatusLabel(status)} ·
                结果来自服务端授权后的 usage event 聚合。
              </p>
            </Panel>
            <Panel
              title="用量摘要"
              action={<small>{usage.data ? `${usage.data.from} — ${usage.data.to}` : '等待查询'}</small>}
            >
              {usage.isPending && <State loading>{null}</State>}
              {usage.error && (
                <ErrorNotice
                  error={usage.error}
                  onRetry={() => {
                    void usage.refetch();
                  }}
                />
              )}
              {!usage.isPending && !usage.error && !usage.data && <div className="empty">当前范围没有用量数据。</div>}
              {usage.data && <UsageSummaryView summary={usage.data} />}
            </Panel>
            <div className="notice" role="status">
              <strong>用量可信度</strong>
              <span>
                单次用量的 reported、partial、missing、estimated 状态，以及 exact、estimated、not_billable
                计费口径，会在请求详情中逐项展示。
              </span>
              <Link to="/console/requests">查看请求详情</Link>
            </div>
          </>
        )}
      </State>
    </div>
  );
}

function requestModeTone(mode: ConsoleRequest['supplyMode']): 'neutral' | 'good' {
  return mode === 'byok' ? 'good' : 'neutral';
}

const requestFinancialLabels: Record<ConsoleFinancialStatus, string> = {
  not_applicable: '不适用（BYOK 无平台 Token 扣费）',
  pending: '待结算',
  settled: '已结算',
  released: '预留已释放',
  reconciliation_pending: '财务待对账（尚未结算）',
};
const requestReconciliationLabels: Record<ConsoleReconciliationState, string> = {
  none: '未进入执行对账',
  pending: '执行结果待对账',
  resolved: '执行对账已完成',
};
const requestStateExplanation =
  '执行成功或重放 HTTP 200 不代表平台 Token 费用已结算；执行对账与财务对账独立。BYOK 仅展示代理用量，不预留或扣减平台 Token 钱包。';

export function RequestFinancialStatus({ request }: {
  request: Pick<ConsoleRequest, 'supplyMode' | 'financialStatus'>;
}) {
  const status = request.financialStatus;
  if (status === undefined || ((request.supplyMode === 'byok') !== (status === 'not_applicable'))) {
    return <Badge tone="warn">财务状态未提供</Badge>;
  }
  return (
    <Badge tone={status === 'settled' ? 'good' : status === 'pending' || status === 'reconciliation_pending' ? 'warn' : 'neutral'}>
      {requestFinancialLabels[status] ?? '财务状态未提供'}
    </Badge>
  );
}

export function RequestReconciliationStatus({ request }: {
  request: Pick<ConsoleRequest, 'reconciliationState'>;
}) {
  const state = request.reconciliationState;
  return (
    <Badge tone={state === 'resolved' ? 'good' : state === 'none' ? 'neutral' : 'warn'}>
      {state === undefined ? '执行对账状态未提供' : requestReconciliationLabels[state] ?? '执行对账状态未提供'}
    </Badge>
  );
}

export function RequestsPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [fromDate, setFromDate] = useState(() => dateInputValue(-7));
  const [toDate, setToDate] = useState(() => dateInputValue(0));
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<ConsoleRequestStatus>();
  const [supplyMode, setSupplyMode] = useState<'byok' | 'platform'>();
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);

  useEffect(() => {
    if (!tenants.data?.length) return;
    if (!tenants.data.some((tenant) => tenant.id === selectedTenantId)) setSelectedTenantId(tenants.data[0].id);
  }, [selectedTenantId, tenants.data]);

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const projects = useTenantProjects(selectedTenant?.id);
  const projectSelection = useProjectSelection(selectedTenant?.id, projects.data, false);
  const projectId = projectSelection.selectedProjectId;
  const filters = useMemo(
    () => usageFilters(fromDate, toDate, projectId, model, status, supplyMode),
    [fromDate, toDate, projectId, model, status, supplyMode],
  );
  useEffect(() => setPageCursors([undefined]), [filters, selectedTenant?.id]);
  const cursor = pageCursors[pageCursors.length - 1];
  const requestFilters = useMemo(
    () => ({ ...filters, limit: 50, ...(cursor === undefined ? {} : { cursor }) }),
    [cursor, filters],
  );
  const requests = useQuery({
    queryKey: [...requestsRootKey, selectedTenant?.id ?? '', projectId, requestFilters],
    queryFn: () => {
      if (!selectedTenant) throw new Error('租户未选择');
      return saasClient.listRequests(selectedTenant.id, requestFilters);
    },
    enabled: Boolean(selectedTenant),
    retry: false,
  });

  return (
    <div className="saas-console">
      <ConsoleHeader active="requests" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">REQUESTS</p>
          <h1>请求日志</h1>
          <p>只显示服务端安全投影；提示词、响应体和内部供给标识不会返回到浏览器。</p>
          <p>{requestStateExplanation}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void requests.refetch();
          }}
          disabled={!selectedTenant || requests.isFetching}
        >
          刷新
        </button>
      </div>
      <State
        loading={tenants.isPending}
        error={tenants.error}
        retry={() => {
          void tenants.refetch();
        }}
        empty={tenants.data?.length === 0}
        emptyAction={<p>暂无所属租户。</p>}
      >
        {selectedTenant && (
          <>
            <Panel title="查询范围">
              <ConsoleFilters
                tenants={tenants.data ?? []}
                selectedTenantId={selectedTenant.id}
                onTenantChange={(value) => {
                  setSelectedTenantId(value);
                  setPageCursors([undefined]);
                }}
                fromDate={fromDate}
                toDate={toDate}
                onFromDateChange={setFromDate}
                onToDateChange={setToDate}
                projects={projects.data ?? []}
                projectsLoading={projects.isPending}
                projectsError={projects.error}
                onRetryProjects={() => {
                  void projects.refetch();
                }}
                projectId={projectId}
                onProjectIdChange={(value) => {
                  projectSelection.selectProject(value);
                  setPageCursors([undefined]);
                }}
                model={model}
                onModelChange={setModel}
                status={status}
                onStatusChange={setStatus}
                supplyMode={supplyMode}
                onSupplyModeChange={setSupplyMode}
              />
            </Panel>
            <Panel title="请求列表" action={<small>第 {pageCursors.length} 页</small>}>
              {requests.isPending && <State loading>{null}</State>}
              {requests.error && (
                <ErrorNotice
                  error={requests.error}
                  onRetry={() => {
                    void requests.refetch();
                  }}
                />
              )}
              {!requests.isPending && !requests.error && requests.data?.items.length === 0 && (
                <div className="empty">当前范围没有请求。</div>
              )}
              {requests.data && requests.data.items.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>创建时间</th>
                        <th>模型</th>
                        <th>项目</th>
                        <th>供给模式</th>
                        <th>执行状态</th>
                        <th>财务状态</th>
                        <th>执行对账</th>
                        <th>详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.data.items.map((request) => (
                        <tr key={request.id}>
                          <td>{new Date(request.createdAt).toLocaleString('zh-CN')}</td>
                          <td>
                            <code>{request.model}</code>
                          </td>
                          <td>
                            <code>{request.projectId}</code>
                          </td>
                          <td>
                            <Badge tone={requestModeTone(request.supplyMode)}>
                              {supplyModeLabel(request.supplyMode)}
                            </Badge>
                          </td>
                          <td>
                            <Badge
                              tone={
                                request.status === 'succeeded' ? 'good' : request.status === 'failed' ? 'bad' : 'warn'
                              }
                            >
                              {requestStatusLabel(request.status)}
                            </Badge>
                          </td>
                          <td><RequestFinancialStatus request={request} /></td>
                          <td><RequestReconciliationStatus request={request} /></td>
                          <td>
                            <Link
                              to={`/console/requests/${encodeURIComponent(request.id)}?tenantId=${encodeURIComponent(selectedTenant.id)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`}
                            >
                              查看
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="actions">
                <button
                  type="button"
                  disabled={pageCursors.length <= 1 || requests.isFetching}
                  onClick={() => setPageCursors((value) => value.slice(0, -1))}
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={!requests.data?.hasMore || !requests.data.nextCursor || requests.isFetching}
                  onClick={() => {
                    const nextCursor = requests.data?.nextCursor;
                    if (nextCursor) setPageCursors((value) => [...value, nextCursor]);
                  }}
                >
                  下一页
                </button>
              </div>
            </Panel>
          </>
        )}
      </State>
    </div>
  );
}

function usageTone(status: ConsoleUsageStatus): 'good' | 'warn' | 'bad' {
  return status === 'reported' ? 'good' : status === 'missing' ? 'bad' : 'warn';
}

function usageSourceLabel(source: ConsoleUsageEvent['source']): string {
  if (source === 'upstream') return '上游报告';
  if (source === 'local-estimate') return '本地估算';
  return '历史记录';
}

function UsageEventCard({ event }: { event: ConsoleUsageEvent }) {
  return (
    <article className="saas-usage-event">
      <div className="saas-tenant-heading">
        <div>
          <h3>{supplyModeLabel(event.supplyMode)}</h3>
          <small>{new Date(event.createdAt).toLocaleString('zh-CN')}</small>
        </div>
        <Badge tone={usageTone(event.status)}>{usageStatusLabels[event.status]}</Badge>
      </div>
      <div className="summary-list">
        <div>
          <span>数据来源</span>
          <strong>{usageSourceLabel(event.source)}</strong>
        </div>
        <div>
          <span>测量类型</span>
          <strong>{event.measurementKind === 'snapshot' ? '快照' : '增量'}</strong>
        </div>
        <div>
          <span>计费口径</span>
          <Badge
            tone={event.billableBasis === 'exact' ? 'good' : event.billableBasis === 'not_billable' ? 'bad' : 'warn'}
          >
            {billableBasisLabels[event.billableBasis]}
          </Badge>
        </div>
        <div>
          <span>输入 / 输出</span>
          <strong>
            {formatExactDecimal(event.inputTotal)} / {formatExactDecimal(event.outputTotal)}
          </strong>
        </div>
        <div>
          <span>缓存读取 / 写入</span>
          <strong>
            {formatExactDecimal(event.cacheRead)} / {formatExactDecimal(event.cacheWrite)}
          </strong>
        </div>
        <div>
          <span>推理输出</span>
          <strong>{formatExactDecimal(event.reasoningOutput)}</strong>
        </div>
      </div>
    </article>
  );
}

export function RequestDetailPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const location = useLocation();
  const rawId = location.pathname.slice('/console/requests/'.length);
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // The server will return a structured invalid-path error for a malformed identifier.
  }
  const [searchParams] = useSearchParams();
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState(searchParams.get('tenantId') ?? '');

  useEffect(() => {
    if (!tenants.data?.length) return;
    const requestedTenantId = searchParams.get('tenantId');
    if (requestedTenantId && tenants.data.some((tenant) => tenant.id === requestedTenantId)) {
      setSelectedTenantId(requestedTenantId);
      return;
    }
    if (!tenants.data.some((tenant) => tenant.id === selectedTenantId)) setSelectedTenantId(tenants.data[0].id);
  }, [searchParams, selectedTenantId, tenants.data]);

  const selectedTenant = tenants.data?.find((tenant) => tenant.id === selectedTenantId) ?? tenants.data?.[0];
  const projects = useTenantProjects(selectedTenant?.id);
  const projectSelection = useProjectSelection(
    selectedTenant?.id,
    projects.data,
    false,
    searchParams.get('projectId') ?? '',
  );
  const projectId = projectSelection.selectedProjectId;
  const detail = useQuery({
    queryKey: [...requestsRootKey, 'detail', selectedTenant?.id ?? '', id ?? '', projectId],
    queryFn: () => {
      if (!selectedTenant || !id) throw new Error('租户或请求未选择');
      return saasClient.getRequestDetail(selectedTenant.id, id, optionalFilter(projectId));
    },
    enabled: Boolean(selectedTenant && id),
    retry: false,
  });

  return (
    <div className="saas-console">
      <ConsoleHeader active="requests" onLogout={onLogout} />
      <div className="page-title">
        <div>
          <p className="eyebrow">REQUEST DETAIL</p>
          <h1>请求详情</h1>
          <p>仅展示安全元数据、尝试状态和用量信任信息。</p>
          <p>{requestStateExplanation}</p>
        </div>
        <div className="actions">
          <Link className="button-link" to="/console/requests">
            返回请求列表
          </Link>
          <button
            type="button"
            onClick={() => {
              void detail.refetch();
            }}
            disabled={!selectedTenant || detail.isFetching}
          >
            刷新
          </button>
        </div>
      </div>
      <State
        loading={tenants.isPending}
        error={tenants.error}
        retry={() => {
          void tenants.refetch();
        }}
        empty={tenants.data?.length === 0}
        emptyAction={<p>暂无所属租户。</p>}
      >
        {selectedTenant && (
          <>
            <Panel title="查看范围">
              <div className="form-grid">
                <TenantPicker tenants={tenants.data ?? []} value={selectedTenant.id} onChange={setSelectedTenantId} />
                <ProjectPicker
                  projects={projects.data ?? []}
                  value={projectId}
                  onChange={projectSelection.selectProject}
                  loading={projects.isPending}
                  includeAll
                />
              </div>
              {projects.error && (
                <ErrorNotice
                  error={projects.error}
                  onRetry={() => {
                    void projects.refetch();
                  }}
                />
              )}
            </Panel>
            {detail.isPending && (
              <Panel title="请求详情">
                <State loading>{null}</State>
              </Panel>
            )}
            {detail.error && (
              <ErrorNotice
                error={detail.error}
                onRetry={() => {
                  void detail.refetch();
                }}
              />
            )}
            {detail.data && (
              <>
                <Panel title="请求概览">
                  <div className="summary-list">
                    <div>
                      <span>请求 ID</span>
                      <code>{detail.data.id}</code>
                    </div>
                    <div>
                      <span>模型</span>
                      <code>{detail.data.model}</code>
                    </div>
                    <div>
                      <span>项目</span>
                      <code>{detail.data.projectId}</code>
                    </div>
                    <div>
                      <span>协议</span>
                      <strong>{detail.data.protocol}</strong>
                    </div>
                    <div>
                      <span>供给模式</span>
                      <Badge tone={requestModeTone(detail.data.supplyMode)}>
                        {supplyModeLabel(detail.data.supplyMode)}
                      </Badge>
                    </div>
                    <div>
                      <span>执行状态</span>
                      <Badge
                        tone={
                          detail.data.status === 'succeeded' ? 'good' : detail.data.status === 'failed' ? 'bad' : 'warn'
                        }
                      >
                        {requestStatusLabel(detail.data.status)}
                      </Badge>
                    </div>
                    <div>
                      <span>财务状态</span>
                      <RequestFinancialStatus request={detail.data} />
                    </div>
                    <div>
                      <span>执行对账</span>
                      <RequestReconciliationStatus request={detail.data} />
                    </div>
                    <div>
                      <span>创建 / 更新</span>
                      <strong>
                        {new Date(detail.data.createdAt).toLocaleString('zh-CN')} /{' '}
                        {new Date(detail.data.updatedAt).toLocaleString('zh-CN')}
                      </strong>
                    </div>
                  </div>
                </Panel>
                <Panel title="尝试状态">
                  {detail.data.attempts.length === 0 ? (
                    <div className="empty">暂无尝试记录。</div>
                  ) : (
                    <div className="saas-attempt-list">
                      {detail.data.attempts.map((attempt) => (
                        <div className="row" key={`${attempt.sequence}-${attempt.createdAt}`}>
                          <span>
                            第 {attempt.sequence} 次
                            <small>{attempt.responseStarted ? '已开始响应' : '未开始响应'}</small>
                          </span>
                          <span>
                            <Badge
                              tone={
                                attempt.status === 'succeeded' ? 'good' : attempt.status === 'failed' ? 'bad' : 'warn'
                              }
                            >
                              {requestStatusLabel(attempt.status)}
                            </Badge>
                            {attempt.httpStatus === null ? '' : ` · HTTP ${attempt.httpStatus}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
                <Panel title="用量与信任状态">
                  {detail.data.usageEvents.length === 0 ? (
                    <div className="empty">暂无用量事件。</div>
                  ) : (
                    <div className="saas-usage-events">
                      {detail.data.usageEvents.map((event) => (
                        <UsageEventCard key={`${event.createdAt}-${event.supplyMode}-${event.status}`} event={event} />
                      ))}
                    </div>
                  )}
                </Panel>
              </>
            )}
          </>
        )}
      </State>
    </div>
  );
}

export function SaasConsoleApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const path = location.pathname.replace(/\/$/, '') || '/console';
  const [session, setSession] = useState<SafeSession>();
  const [sessionStatus, setSessionStatus] = useState<'checking' | 'authenticated' | 'anonymous' | 'error'>('checking');
  const [sessionError, setSessionError] = useState<unknown>();
  const [sessionCheck, setSessionCheck] = useState(0);
  const sessionScope = useRef<SafeSession | undefined>(undefined);
  const sessionGeneration = useRef(0);

  useEffect(() => {
    if (path === '/console/setup' || path === '/console/invitations/accept') return;
    let active = true;
    const generation = ++sessionGeneration.current;
    setSessionStatus('checking');
    setSessionError(undefined);
    void saasClient
      .getSession()
      .then((result) => {
        if (!active || generation !== sessionGeneration.current) return;
        sessionScope.current = result.session;
        setSession(result.session);
        setSessionStatus('authenticated');
      })
      .catch((error) => {
        if (!active || generation !== sessionGeneration.current) return;
        sessionScope.current = undefined;
        setSession(undefined);
        setSessionError(error);
        setSessionStatus(isUnauthorized(error) ? 'anonymous' : 'error');
      });
    return () => {
      active = false;
    };
  }, [path, sessionCheck]);

  if (path === '/console/setup') return <SetupInfoPage />;
  if (path === '/console/invitations/accept') return <AcceptInvitationPage />;

  if (path === '/console/login') {
    if (sessionStatus === 'checking') return <div className="center">正在检查会话…</div>;
    if (sessionStatus === 'authenticated' && session) return <Navigate to="/console" replace />;
    if (sessionStatus === 'error') {
      return (
        <AuthFrame subtitle="客户控制台">
          <h1>暂时无法检查会话</h1>
          <ErrorNotice error={sessionError} onRetry={() => setSessionCheck((value) => value + 1)} />
        </AuthFrame>
      );
    }
    return (
      <LoginPage
        onAuthenticated={(result) => {
          sessionGeneration.current += 1;
          sessionScope.current = result.session;
          setSession(result.session);
          setSessionError(undefined);
          setSessionStatus('authenticated');
          navigate('/console', { replace: true });
        }}
      />
    );
  }

  const isRequestDetail = /^\/console\/requests\/[^/]+$/.test(path);
  if (
    path !== '/console' &&
    path !== '/console/catalog' &&
    path !== '/console/keys' &&
    path !== '/console/credentials' &&
    path !== '/console/usage' &&
    path !== '/console/requests' &&
    path !== '/console/webhooks' &&
    path !== '/console/wallet' &&
    path !== '/console/refunds' &&
    path !== '/console/security' &&
    !isRequestDetail
  ) {
    return <Navigate to="/console" replace />;
  }
  if (sessionStatus === 'checking') return <div className="center">正在检查会话…</div>;
  if (sessionStatus === 'error') {
    return (
      <div className="saas-console">
        <ErrorNotice error={sessionError} onRetry={() => setSessionCheck((value) => value + 1)} />
      </div>
    );
  }
  if (sessionStatus !== 'authenticated' || !session) return <Navigate to="/console/login" replace />;

  const clearLocalSession = () => {
    // A result belonging to an older login must not clear a replacement session.
    if (sessionScope.current !== session) return;
    sessionGeneration.current += 1;
    sessionScope.current = undefined;
    clearWorkspaceDrafts(session.userId);
    setSession(undefined);
    setSessionStatus('anonymous');
    setSessionError(undefined);
    queryClient.removeQueries({ queryKey: tenantsKey });
    queryClient.removeQueries({ queryKey: projectsRootKey });
    queryClient.removeQueries({ queryKey: apiKeysRootKey });
    queryClient.removeQueries({ queryKey: byokCredentialsRootKey });
    queryClient.removeQueries({ queryKey: plansRootKey });
    queryClient.removeQueries({ queryKey: usageRootKey });
    queryClient.removeQueries({ queryKey: requestsRootKey });
    queryClient.removeQueries({ queryKey: customerSessionsKey });
    queryClient.removeQueries({ queryKey: customerRefundRootKey });
    queryClient.removeQueries({ queryKey: customerWebhookRootKey });
    queryClient.removeQueries({ queryKey: workspaceMembersRootKey });
    queryClient.removeQueries({ queryKey: ['saas-wallet'] });
    navigate('/console/login', { replace: true });
  };

  const logout = async () => {
    try {
      await saasClient.logout();
    } finally {
      clearLocalSession();
    }
  };

  if (path === '/console/security') {
    return (
      <CustomerSessionsPage
        key={`${session.userId}:${session.createdAt}`}
        sessionScope={session}
        isCurrentSessionScope={() => sessionScope.current === session}
        onLogout={logout}
        onCurrentSessionRevoked={clearLocalSession}
      />
    );
  }
  if (path === '/console/catalog') return <ServicePlanCatalogPage onLogout={logout} />;
  if (path === '/console/keys') return <KeyManagementPage onLogout={logout} />;
  if (path === '/console/webhooks') return <CustomerWebhooksPage onLogout={logout} />;
  if (path === '/console/refunds') return <CustomerRefundsPage onLogout={logout} />;
  if (path === '/console/credentials') return <ByokCredentialsPage onLogout={logout} />;
  if (path === '/console/usage') return <UsagePage onLogout={logout} />;
  if (path === '/console/requests') return <RequestsPage onLogout={logout} />;
  if (path === '/console/wallet') return <SaasWalletPage onLogout={logout} />;
  if (isRequestDetail) return <RequestDetailPage onLogout={logout} />;
  return <ConsoleHome session={session} onLogout={logout} onSessionExpired={clearLocalSession} />;
}
