import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  clearPlatformCsrfToken,
  hasPlatformCsrfToken,
  isPlatformApiUnavailable,
  type PlatformAdminRole,
  PlatformApiError,
  type PlatformAuditEvent,
  type PlatformAuditEventPage,
  type PlatformAuditPageQuery,
  type PlatformAuthSession,
  type PlatformCatalogCapability,
  type PlatformCatalogPage,
  type PlatformCatalogPageQuery,
  type PlatformCatalogProduct,
  type PlatformCatalogRights,
  type PlatformCatalogRightsRevokeInput,
  type PlatformCatalogRightsVersionInput,
  type PlatformPriceMetric,
  type PlatformPricingTarget,
  type PlatformPriceVersion,
  type PlatformPriceVersionHistoryQuery,
  type PlatformPriceVersionKind,
  type PlatformPriceVersionRegistrationInput,
  type PlatformRateSetInput,
  PLATFORM_CAPACITY_POLICY_REASONS,
  type PlatformCapacityPolicy,
  type PlatformCapacityPolicyLimits,
  type PlatformCapacityPolicyReason,
  type PlatformCapacityPolicyScope,
  type PlatformCapacityPolicyTarget,
  type PlatformLoginInput,
  type PlatformMe,
  type PlatformUnknownOutcomeCaseDetail,
  type PlatformUnknownOutcomeCaseSummary,
  type PlatformUnknownOutcomeObservation,
  type PlatformOperationsStatusCounts,
  type PlatformOperationsSummary,
  type PlatformRefundRecord,
  type PlatformSupplyAccount,
  type PlatformSupplyAccountCreateInput,
  type PlatformSupplyCapability,
  type PlatformSupplyCredential,
  type PlatformSupplyCredentialWrappingStatus,
  type PlatformSupplyCredentialRotationInput,
  type PlatformSupplyCredentialVersion,
  type PlatformSupplyLifecycleAction,
  platformClient,
} from '../api/saas-platform-client';
import { Badge, Field, formatDate, Panel, SaveButton } from '../components/ui';
import { createMfaEnrollmentLifecycle, mfaEnrollmentNotice } from './saas-platform-mfa-lifecycle';

const roleLabels: Record<PlatformAdminRole, string> = {
  superadmin: '超级管理员',
  security: '安全',
  finance: '财务',
  operations: '运营',
  'support-readonly': '支持只读',
};

const platformRoutes = new Set([
  '/platform/overview',
  '/platform/ops',
  '/platform/unknown-outcomes',
  '/platform/capacity',
  '/platform/pricing',
  '/platform/refunds',
  '/platform/catalog/products',
  '/platform/catalog/capabilities',
  '/platform/catalog/rights',
  '/platform/supply/accounts',
  '/platform/audit/events',
]);

type AuthState =
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; session: PlatformAuthSession };

type MeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; me: PlatformMe }
  | { kind: 'unavailable' }
  | { kind: 'error'; error: unknown };

function safePlatformReturnPath(value: unknown): string {
  return typeof value === 'string' && platformRoutes.has(value) ? value : '/platform/overview';
}

const INVALID_PLATFORM_CREDENTIALS_MESSAGE = '邮箱、密码或 MFA 验证码不正确。';

function platformErrorMessage(error: unknown): string {
  if (error instanceof PlatformApiError && error.status === 401 && error.code === 'INVALID_CREDENTIALS') {
    return INVALID_PLATFORM_CREDENTIALS_MESSAGE;
  }
  if (typeof error === 'object' && error !== null) {
    const apiError = error as { status?: unknown; code?: unknown };
    if (apiError.status === 401 || apiError.code === 'UNAUTHENTICATED') {
      return '平台管理员会话已失效，安全令牌已清理，请重新登录。';
    }
    if (apiError.status === 403 || apiError.code === 'FORBIDDEN') {
      return '当前管理员角色未获准读取此内容。访问由服务端授权决定，请联系平台管理员确认；页面显示的角色信息不会授予权限。';
    }
    if ((apiError.status === 404 || apiError.status === 405 || apiError.status === 501) && apiError.code !== 'REFUND_NOT_FOUND') {
      return '此管理接口当前不可用或尚未接入。';
    }
    if (apiError.status === 409) {
      if (apiError.code === 'INSUFFICIENT_EVIDENCE') {
        return '服务端拒绝了处置：每个可能的上游尝试都必须有一条独立 evidenceReference。';
      }
      if (apiError.code === 'CONTRADICTORY_EVIDENCE') {
        return '服务端拒绝了处置：现有状态与“未执行”证据互相矛盾。';
      }
      return '案件状态已发生变化，处置未提交；请刷新案件后重新核对。';
    }
  }
  if (!(error instanceof PlatformApiError)) return '请求失败，请稍后重试。';
  if (error.code === 'CAPACITY_POLICY_NOT_FOUND') {
    return '未找到该租户、项目或 API key；请刷新目标列表后重新选择。';
  }
  if (error.code === 'CAS_CONFLICT') {
    return '容量策略已被其他操作更新。重新读取最新版本后再提交。';
  }
  if (error.code === 'NO_CHANGE') {
    return '新限制与当前策略相同，没有产生版本变更。';
  }
  if (error.code === 'INVALID_BODY' || error.code === 'INVALID_INPUT' || error.code === 'INVALID_POLICY') {
    return '容量策略输入无效，请检查版本、三个正整数限制和审计原因。';
  }
  if (error.code === 'CAPACITY_POLICY_UNAVAILABLE') {
    return '容量策略服务当前不可用，请稍后重试。';
  }
  if (error.code === 'CAPACITY_POLICY_TARGETS_UNAVAILABLE') {
    return '容量策略目标选择器当前不可用，请稍后重试。';
  }
  if (((error.status === 404 || error.status === 405 || error.status === 501) && error.code !== 'REFUND_NOT_FOUND') || error.code === 'NOT_FOUND') {
    return '此管理接口当前不可用或尚未接入。';
  }
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return INVALID_PLATFORM_CREDENTIALS_MESSAGE;
    case 'UNAUTHENTICATED':
      return '平台管理员会话已失效，请重新登录。';
    case 'CSRF_REJECTED':
      return '安全令牌已失效，请重新登录。';
    case 'RATE_LIMITED':
      return '尝试次数过多，请稍后再试。';
    case 'MFA_UNAVAILABLE':
      return '平台 MFA 当前不可用，请联系运维人员。';
    case 'MFA_ENROLLMENT_UNAVAILABLE':
      return '当前无法开始 MFA 配置，请确认管理员状态后重试。';
    case 'MFA_ENROLLMENT_TOKEN_INVALID':
      return 'MFA 配置令牌无效或已过期。';
    case 'MFA_CONFIRMATION_INVALID':
      return 'MFA 验证码不正确，或配置令牌已失效。';
    case 'NETWORK':
      return '无法连接管理服务。';
    case 'INVALID_RESPONSE':
      return '管理服务返回了无法识别的响应。';
    case 'REFUND_NOT_FOUND':
      return '未找到该租户下的退款记录，请核对租户 ID 和退款 ID。';
    case 'IDEMPOTENCY_KEY_REQUIRED':
      return '退款请求需要有效的幂等键，请检查后再提交。';
    case 'REFUND_UNAVAILABLE':
      return '退款服务当前不可用，请稍后查询状态。';
    case 'AUDIT_INVALID_INPUT':
      return '筛选条件、时间范围或分页游标无效，请检查后重试。';
    case 'AUDIT_STORAGE_ERROR':
      return '服务端暂时无法读取审计历史，请稍后重试。';
    case 'AUDIT_UNAVAILABLE':
      return '审计查询服务当前不可用，请稍后重试。';
    case 'INSUFFICIENT_EVIDENCE':
      return '每个可能的上游尝试都必须有一条 evidenceReference。';
    case 'CONTRADICTORY_EVIDENCE':
    case 'UNEXPECTED_ATTEMPT_COVERAGE':
    case 'REQUEST_NOT_UNKNOWN':
    case 'FINANCIAL_STATE_CONFLICT':
    case 'RESOLUTION_CONFLICT':
      return '案件状态已发生变化，处置未提交；请刷新案件后重新核对。';
    case 'OPERATIONS_INVALID_INPUT':
      return '运营摘要时间范围无效，请选择服务支持的时间范围后重试。';
    case 'OPERATIONS_STORAGE_ERROR':
      return '服务端暂时无法读取运营摘要，请稍后重试。';
    case 'CATALOG_WRITE_UNAVAILABLE':
      return '权益写入接口尚未接入，请稍后重试。';
    case 'INVALID_BODY':
      return '管理请求内容无效，请检查输入后重试。';
    case 'BODY_TOO_LARGE':
      return '请求内容过大，请减少输入后重试。';
    case 'ORIGIN_REQUIRED':
    case 'ORIGIN_REJECTED':
    case 'HOST_REQUIRED':
    case 'HOST_REJECTED':
      return '请求来源未通过同源安全校验，请刷新页面后重试。';
    case 'RIGHTS_VERSION_CONFLICT':
      return '权益版本与现有目录冲突，请刷新后登记新版本。';
    case 'RIGHTS_NOT_FOUND':
      return '要撤销的权益记录不存在，请刷新目录。';
    case 'INVALID_RIGHTS_STATUS_TRANSITION':
      return '该权益已经撤销或状态不允许此操作。';
    case 'ACCOUNT_EXISTS':
    case 'CREDENTIAL_EXISTS':
      return '相同的供给记录已经存在，请刷新后查看当前状态。';
    case 'ACCOUNT_NOT_FOUND':
    case 'CREDENTIAL_NOT_FOUND':
      return '供给记录不存在，请刷新后重试。';
    case 'ACCOUNT_STATE_CONFLICT':
    case 'CREDENTIAL_STATE_CONFLICT':
      return '供给记录已发生变化，请刷新后重试。';
    case 'ACCOUNT_REVOKED':
    case 'CREDENTIAL_REVOKED':
      return '供给记录已经撤销，不能继续操作。';
    case 'INVALID_ACCOUNT_LIFECYCLE':
    case 'INVALID_CREDENTIAL_LIFECYCLE':
      return '当前状态不允许此生命周期操作。';
    case 'CREDENTIAL_VERSION_CONFLICT':
      return '凭证版本已发生变化，请刷新后重新发起轮换。';
    case 'VALIDATION_REQUIRED':
      return '凭证仍未通过隔离验证 worker 的验证，暂时不能启用。';
    case 'CREDENTIAL_EXPIRED':
      return '凭证已过期，请先轮换凭证。';
    case 'KMS_SEAL_FAILED':
    case 'SUPPLY_STORAGE_ERROR':
      return '供给凭证写入未完成，请稍后重试。';
    default:
      return '管理请求未完成，请稍后重试。';
  }
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
  return <div className="notice error" role="alert"><strong>{title}</strong><span>{platformErrorMessage(error)}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
}

function LoadingPage({ label = '正在检查平台管理员会话…' }: { label?: string }) {
  return <div className="center" role="status" aria-live="polite">{label}</div>;
}

function Brand({ subtitle = '平台管理员工作区' }: { subtitle?: string }) {
  return <div className="brand"><span className="brand-mark">◈</span><div>model-router<small>{subtitle}</small></div></div>;
}

function AuthFrame({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return <div className="auth-page"><section className="auth-card"><Brand subtitle={subtitle}/>{children}</section></div>;
}

function PlatformLoginPage({
  onLogin,
  sessionError,
}: {
  onLogin: (input: PlatformLoginInput) => Promise<void>;
  sessionError?: unknown;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onLogin({ email, password, code });
      setPassword('');
      setCode('');
    } catch (submitError) {
      setError(submitError);
    } finally {
      setBusy(false);
    }
  }

  return <AuthFrame subtitle="平台管理员登录">
    <h1>平台管理员登录</h1>
    <p className="muted">使用平台管理员邮箱、密码和一次性 MFA 验证码登录。权限由服务端决定。</p>
    <PlatformErrorNotice error={sessionError} title="会话检查失败"/>
    <PlatformErrorNotice error={error} title="登录失败"/>
    <form onSubmit={submit}>
      <Field label="管理员邮箱"><input required type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)}/></Field>
      <Field label="密码"><input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></Field>
      <Field label="MFA 验证码" hint="输入认证器当前显示的 6 位验证码。"><input required inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}/></Field>
      <SaveButton busy={busy}>登录</SaveButton>
    </form>
    <p className="muted">密码和验证码只用于本次请求，不会写入浏览器存储。</p>
    <div className="actions"><Link to="/platform/mfa/enroll">首次配置 MFA</Link></div>
  </AuthFrame>;
}

function MfaEnrollmentPage() {
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [issuer, setIssuer] = useState('model-router');
  const [code, setCode] = useState('');
  const [lifecycle] = useState(() => createMfaEnrollmentLifecycle(platformClient));
  const [state, setState] = useState(lifecycle.getState);
  const busy = state.kind === 'starting' || state.kind === 'confirming';
  const enrollment = state.kind === 'awaiting-confirmation' ? state.enrollment : undefined;
  const notice = mfaEnrollmentNotice(state);

  useEffect(() => {
    const unmount = lifecycle.mount(setState);
    const checkExpiry = () => lifecycle.checkExpiry();
    window.addEventListener('focus', checkExpiry);
    document.addEventListener('visibilitychange', checkExpiry);
    return () => {
      window.removeEventListener('focus', checkExpiry);
      document.removeEventListener('visibilitychange', checkExpiry);
      unmount();
    };
  }, [lifecycle]);

  useEffect(() => {
    if (state.kind !== 'awaiting-confirmation') setCode('');
    if (state.kind !== 'idle') setEnrollmentToken('');
  }, [state.kind]);

  function start(event: FormEvent) {
    event.preventDefault();
    const token = enrollmentToken;
    setEnrollmentToken('');
    setCode('');
    void lifecycle.start(issuer, token);
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    const submittedCode = code;
    setEnrollmentToken('');
    setCode('');
    void lifecycle.confirm(submittedCode);
  }

  function cancel() {
    setEnrollmentToken('');
    setCode('');
    lifecycle.cancel();
  }

  if (state.kind === 'confirmed') return <AuthFrame subtitle="MFA 配置">
    <h1>MFA 已配置</h1>
    <p className="muted">平台管理员 MFA 已确认。请返回登录页面使用最新验证码登录。</p>
    <Link className="button-link primary" to="/platform/login">返回登录</Link>
  </AuthFrame>;

  return <AuthFrame subtitle="MFA 配置">
    <h1>配置平台 MFA</h1>
    <p className="muted">使用服务器 CLI 签发的一次性配置令牌开始。令牌和确认信息只保留在当前页面内存中。</p>
    <p className="muted">离开、取消、提交确认或过期会清除本页敏感信息，不会撤销服务端操作；页面不会自动重试。</p>
    {notice && <div className="notice error" role="alert">{notice}</div>}
    {busy && <p role="status">{state.kind === 'starting' ? '正在生成 MFA 配置…' : '正在确认 MFA，敏感配置已隐藏…'}</p>}
    {(state.kind === 'idle' || state.kind === 'starting') && <form onSubmit={start}>
      <Field label="一次性配置令牌"><input required type="password" autoComplete="off" disabled={busy} value={enrollmentToken} onChange={event => setEnrollmentToken(event.target.value)}/></Field>
      <Field label="认证器发行方"><input required maxLength={120} disabled={busy} value={issuer} onChange={event => setIssuer(event.target.value)}/></Field>
      <SaveButton busy={busy}>生成 MFA 配置</SaveButton>
    </form>}
    {enrollment && <>
      <Panel title="添加认证器">
        <p className="muted">请在认证器中扫描二维码，或使用下方完整 URI 手动添加。URI 含有一次性 MFA 密钥，请勿分享。</p>
        <pre className="small-code" aria-label="MFA 配置 URI">{enrollment.otpauthUri}</pre>
        <p className="muted">配置令牌有效期至：{new Date(enrollment.expiresAt).toLocaleString('zh-CN')}</p>
      </Panel>
      <form onSubmit={confirm}>
        <Field label="认证器验证码"><input required inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}/></Field>
        <SaveButton busy={busy}>确认 MFA</SaveButton>
      </form>
    </>}
    <div className="actions">
      {(state.kind === 'idle' || busy || enrollment) && <button type="button" onClick={cancel}>取消并清除配置</button>}
      <Link to="/platform/login" onClick={cancel}>返回登录</Link>
    </div>
  </AuthFrame>;
}

function usePlatformSession() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'checking' });
  const [sessionError, setSessionError] = useState<unknown>();
  const [me, setMe] = useState<MeState>({ kind: 'idle' });

  const loadMe = useCallback(async () => {
    setMe({ kind: 'loading' });
    try {
      setMe({ kind: 'ready', me: await platformClient.getMe() });
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) {
        clearPlatformCsrfToken();
        setAuth({ kind: 'signed-out' });
      } else if (isPlatformApiUnavailable(error)) {
        setMe({ kind: 'unavailable' });
      } else {
        setMe({ kind: 'error', error });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void platformClient.getSession({ signal: controller.signal }).then((session) => {
      if (!hasPlatformCsrfToken()) {
        clearPlatformCsrfToken();
        setSessionError(new PlatformApiError(401, 'CSRF_REJECTED', '需要重新建立安全会话'));
        setAuth({ kind: 'signed-out' });
        return;
      }
      setAuth({ kind: 'signed-in', session });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      clearPlatformCsrfToken();
      if (error instanceof PlatformApiError && error.status === 401) {
        setAuth({ kind: 'signed-out' });
      } else {
        setSessionError(error);
        setAuth({ kind: 'signed-out' });
      }
    });
    return () => controller.abort();
  }, []);

  const signedInUserId = auth.kind === 'signed-in' ? auth.session.userId : undefined;
  useEffect(() => {
    if (signedInUserId === undefined) {
      setMe({ kind: 'idle' });
      return;
    }
    void loadMe();
  }, [loadMe, signedInUserId]);

  const signIn = useCallback(async (input: PlatformLoginInput) => {
    const result = await platformClient.login(input);
    setSessionError(undefined);
    setAuth({ kind: 'signed-in', session: result.session });
  }, []);

  const signOut = useCallback(() => {
    clearPlatformCsrfToken();
    setMe({ kind: 'idle' });
    setAuth({ kind: 'signed-out' });
  }, []);

  return { auth, me, sessionError, signIn, signOut, reloadMe: loadMe };
}

function PlatformShell({ children, me, onLogout }: { children: ReactNode; me: MeState; onLogout: () => Promise<void> }) {
  const [menu, setMenu] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);

  async function logout() {
    setLogoutBusy(true);
    try {
      await onLogout();
    } finally {
      setLogoutBusy(false);
    }
  }

  const identityStatus = me.kind === 'ready' ? '身份已读取' : me.kind === 'unavailable' ? '管理接口待接入' : '正在读取身份';
  const identityTone = me.kind === 'ready' ? 'good' : 'warn';
  const canSeeAuditNavigation = me.kind === 'ready' && me.me.roles.some(role => role === 'security' || role === 'superadmin');
  const canSeeRefundNavigation = me.kind === 'ready' && me.me.roles.some(role => role === 'finance' || role === 'superadmin');
  const canSeeCapacityNavigation = me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');
  const canSeePricingNavigation = me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');

  return <div className="shell"><a className="skip" href="#main">跳至内容</a><aside className={menu ? 'sidebar open' : 'sidebar'}><Brand/><nav aria-label="平台管理导航"><NavLink to="/platform/overview" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>工作区</NavLink><NavLink to="/platform/ops" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>运营概览</NavLink><NavLink to="/platform/unknown-outcomes" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>未知结果案件</NavLink>{canSeeCapacityNavigation && <NavLink to="/platform/capacity" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>容量策略</NavLink>}{canSeePricingNavigation && <NavLink to="/platform/pricing" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>价格版本</NavLink>}{canSeeRefundNavigation && <NavLink to="/platform/refunds" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>退款管理</NavLink>}<NavLink to="/platform/catalog/products" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>产品目录</NavLink><NavLink to="/platform/catalog/capabilities" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>能力目录</NavLink><NavLink to="/platform/catalog/rights" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>权益目录</NavLink><NavLink to="/platform/supply/accounts" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>平台供给</NavLink>{canSeeAuditNavigation && <NavLink to="/platform/audit/events" onClick={() => setMenu(false)} className={({ isActive }) => isActive ? 'active' : ''}>审计历史</NavLink>}<Link to="/platform/mfa/enroll" onClick={() => setMenu(false)}>MFA 配置</Link></nav><button className="quiet logout" type="button" disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? '正在退出…' : '退出登录'}</button></aside><div className="workspace"><header className="topbar"><button className="menu-toggle" type="button" aria-label="切换导航" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button><div className="instance"><strong>平台管理工作区</strong><Badge tone={identityTone}>{identityStatus}</Badge></div><div className="toolbar"><Link className="button-link" to="/platform/mfa/enroll">MFA 配置</Link></div></header><main id="main">{children}</main></div></div>;
}

function PlatformOverviewPage({ me, onRetryMe }: { me: MeState; onRetryMe: () => void }) {
  return <><div className="page-title"><div><p className="eyebrow">平台管理员</p><h1>平台管理员工作区</h1><p>管理员身份与运营摘要来自平台管理接口；数据访问由服务端授权。</p></div></div><Panel title="当前管理员身份"><PlatformIdentity me={me} onRetry={onRetryMe}/></Panel><OperationsSummaryPanel/></>;
}

function PlatformIdentity({ me, onRetry }: { me: MeState; onRetry: () => void }) {
  if (me.kind === 'loading' || me.kind === 'idle') return <div className="skeleton" aria-label="正在读取管理员身份"><i/><i/><i/></div>;
  if (me.kind === 'unavailable') return <div className="notice" role="status"><strong>管理接口尚未接入</strong><span>GET /admin/api/v1/me 当前没有可用响应；不会显示虚构的用户或角色信息。</span><button type="button" onClick={onRetry}>重试</button></div>;
  if (me.kind === 'error') return <PlatformErrorNotice error={me.error} onRetry={onRetry} title="管理员身份读取失败"/>;
  return <div className="summary-list"><div><span>用户 ID</span><code>{me.me.userId}</code></div><div><span>平台角色</span><span className="actions">{me.me.roles.map(role => <Badge key={role}>{roleLabels[role]}</Badge>)}</span></div></div>;
}

type OperationsRange = '24h' | '7d' | '31d';
type OperationsSummaryState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; summary: PlatformOperationsSummary }
  | { kind: 'error'; error: unknown };

const operationsRangeMs: Record<OperationsRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '31d': 31 * 24 * 60 * 60 * 1000,
};

function formatDecimalCount(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function OperationsSummaryPanel() {
  const [range, setRange] = useState<OperationsRange>('24h');
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<OperationsSummaryState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    const to = new Date();
    const from = new Date(to.getTime() - operationsRangeMs[range]);
    void platformClient.getOpsSummary({ from: from.toISOString(), to: to.toISOString(), signal: controller.signal })
      .then(summary => {
        if (!controller.signal.aborted) setState({ kind: 'ready', summary });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setState(isPlatformApiUnavailable(error) ? { kind: 'unavailable' } : { kind: 'error', error });
      });
    return () => controller.abort();
  }, [range, reloadKey]);

  return <Panel title="运营摘要" action={<label className="field" style={{ marginBottom: 0 }}>统计范围<select aria-label="运营摘要统计范围" value={range} onChange={event => setRange(event.target.value as OperationsRange)}><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="31d">最近 31 天（服务端上限）</option></select></label>}>
    <p className="muted">数据源：GET /admin/api/v1/ops/summary。请求、尝试及请求财务状态按所选区间统计（含开始、不含结束）；租约、预留、账号观察和 webhook 队列是数据库快照。</p>
    <div className="notice" role="note"><strong>这是持久化运营数据，不是服务就绪探针</strong><span>数据库查询成功只证明本次查询可读，不代表 PostgreSQL、Redis、KMS、worker 或真实上游已通过运行时健康检查。</span></div>
    {state.kind === 'loading' && <div className="skeleton" role="status" aria-label="正在读取运营摘要"><i/><i/><i/></div>}
    {state.kind === 'unavailable' && <div className="notice" role="status"><strong>管理接口尚未接入</strong><span>运营摘要接口当前不可用，因此不展示运营数字。</span><button type="button" onClick={() => setReloadKey(value => value + 1)}>重试</button></div>}
    {state.kind === 'error' && <PlatformErrorNotice error={state.error} onRetry={() => setReloadKey(value => value + 1)} title="运营摘要读取失败"/>}
    {state.kind === 'ready' && <OperationsSummaryContent summary={state.summary}/>}
  </Panel>;
}

export function OperationsSummaryContent({ summary }: { summary: PlatformOperationsSummary }) {
  const hasNoRequestsOrAttempts = summary.requests.total === '0' && summary.attempts.total === '0';
  const metrics = summary.metrics;
  const financialReservationTotal = metrics
    ? (BigInt(metrics.billingReservationBacklog.reserved) + BigInt(metrics.billingReservationBacklog.reconciliationPending)).toString()
    : null;
  const webhookTotal = metrics
    ? (BigInt(metrics.paymentWebhookBacklog.pending) + BigInt(metrics.paymentWebhookBacklog.processing)).toString()
    : null;
  return <>
    <p className="muted">服务端返回区间：{formatDate(summary.from)} — {formatDate(summary.to)}</p>
    {hasNoRequestsOrAttempts && <div className="empty" role="status">此时间范围内暂无请求或尝试记录；下方显示的 0 与租约计数均为服务端返回值。</div>}
    <div className="stats">
      <div className="stat"><span>请求数（requests）</span><strong>{formatDecimalCount(summary.requests.total)}</strong><small>所选时间范围</small></div>
      <div className="stat"><span>请求成功率</span><strong>{formatOperationsPercent(metrics?.requests.successPercent ?? null)}</strong><small>成功请求 ÷ 区间请求；未知状态单独显示</small></div>
      <div className="stat"><span>请求结果未知率</span><strong>{formatOperationsPercent(metrics?.requests.unknownPercent ?? null)}</strong><small>所选时间范围</small></div>
      <div className="stat"><span>尝试数（attempts）</span><strong>{formatDecimalCount(summary.attempts.total)}</strong><small>所选时间范围</small></div>
      <div className="stat"><span>尝试成功率</span><strong>{formatOperationsPercent(metrics?.attempts.successPercent ?? null)}</strong><small>成功尝试 ÷ 区间尝试</small></div>
      <div className="stat"><span>响应开始 P50</span><strong>{formatOperationsMilliseconds(metrics?.attempts.responseStartLatencyMs.p50 ?? null)}</strong><small>attempt 创建至 gateway 响应开始</small></div>
      <div className="stat"><span>响应开始 P95</span><strong>{formatOperationsMilliseconds(metrics?.attempts.responseStartLatencyMs.p95 ?? null)}</strong><small>不是首 Token 或上游首字节延迟</small></div>
      <div className="stat"><span>未过期 Provider leases</span><strong>{formatDecimalCount(summary.activeProviderAccountLeaseCount)}</strong><small>当前快照，不受上述时间范围筛选</small></div>
      {metrics && <div className="stat"><span>未终态钱包预留</span><strong>{formatDecimalCount(financialReservationTotal ?? '0')}</strong><small>reserved + reconciliation_pending 当前快照</small></div>}
      {metrics && <div className="stat"><span>支付 webhook 队列</span><strong>{formatDecimalCount(webhookTotal ?? '0')}</strong><small>待处理 + 处理中；当前快照</small></div>}
    </div>
    <div className="grid-two">
      <Panel title="请求状态分布"><OperationsStatusCounts label="请求" counts={summary.requests.byStatus}/></Panel>
      <Panel title="尝试状态分布"><OperationsStatusCounts label="尝试" counts={summary.attempts.byStatus}/></Panel>
    </div>
    {metrics && <>
      <div className="grid-two">
        <Panel title="请求财务状态（所选区间）">
          <div className="summary-list">
            <div><span>不适用（BYOK）</span><strong>{formatDecimalCount(metrics.requests.financialStatus.notApplicable)}</strong></div>
            <div><span>处理中</span><strong>{formatDecimalCount(metrics.requests.financialStatus.pending)}</strong></div>
            <div><span>已结算</span><strong>{formatDecimalCount(metrics.requests.financialStatus.settled)}</strong></div>
            <div><span>已释放</span><strong>{formatDecimalCount(metrics.requests.financialStatus.released)}</strong></div>
            <div><span>待对账</span><strong>{formatDecimalCount(metrics.requests.financialStatus.reconciliationPending)}</strong></div>
          </div>
        </Panel>
        <Panel title="尝试 HTTP 错误响应（所选区间）">
          <div className="summary-list">
            <div><span>4xx</span><strong>{formatDecimalCount(metrics.attempts.responseHttp4xxCount)}</strong></div>
            <div><span>5xx</span><strong>{formatDecimalCount(metrics.attempts.responseHttp5xxCount)}</strong></div>
            <div><span>响应开始延迟样本</span><strong>{formatDecimalCount(metrics.attempts.responseStartLatencyMs.sampleCount)}</strong></div>
          </div>
          <p className="muted">按已记录的 result_http_status 统计；不包含可从此字段无法区分的网络、协议或无 HTTP 响应错误。</p>
        </Panel>
      </div>
      <div className="grid-two">
        <Panel title="平台账号最近持久化观察">
          {metrics.platformAccountHealth.observationCount === '0'
            ? <div className="notice" role="status"><strong>没有可显示的观察记录</strong><span>缺少记录不表示账号健康；此接口也不提供账号覆盖率或实时探测。</span></div>
            : <>
              <p className="muted">{formatDecimalCount(metrics.platformAccountHealth.observationCount)} 条按平台账号键保存的最近状态；最新观察时间：{formatDate(metrics.platformAccountHealth.latestObservedAt)}。覆盖率未知。</p>
              <div className="summary-list" role="list" aria-label="平台账号状态观察计数">
                <OperationsHealthCount label="最近观察为健康" count={metrics.platformAccountHealth.byState.healthy} tone="good"/>
                <OperationsHealthCount label="最近观察为降级" count={metrics.platformAccountHealth.byState.degraded} tone="warn"/>
                <OperationsHealthCount label="最近观察为冷却" count={metrics.platformAccountHealth.byState.cooldown} tone="warn"/>
                <OperationsHealthCount label="最近观察为不健康" count={metrics.platformAccountHealth.byState.unhealthy} tone="bad"/>
                <OperationsHealthCount label="当前冷却期限未到" count={metrics.platformAccountHealth.activeCooldownCount} tone="warn"/>
              </div>
            </>}
        </Panel>
        <Panel title="当前待处理积压">
          <div className="summary-list">
            <div><span>钱包预留 · reserved</span><strong>{formatDecimalCount(metrics.billingReservationBacklog.reserved)}</strong></div>
            <div><span>钱包预留 · 待对账</span><strong>{formatDecimalCount(metrics.billingReservationBacklog.reconciliationPending)}</strong></div>
            <div><span>Payment inbox · pending</span><strong>{formatDecimalCount(metrics.paymentWebhookBacklog.pending)}</strong></div>
            <div><span>Payment inbox · processing</span><strong>{formatDecimalCount(metrics.paymentWebhookBacklog.processing)}</strong></div>
            <div><span>最老未处理 webhook 等待</span><strong>{formatOperationsElapsed(metrics.paymentWebhookBacklog.oldestUnprocessedAgeMs)}</strong></div>
          </div>
          <p className="muted">积压数与等待时间按本次 PostgreSQL 快照计算，不代表 worker 当前存活或 PSP 当前状态。</p>
        </Panel>
      </div>
      <Panel title="运行时探针">
        <p className="muted">运营摘要只读取 PostgreSQL 中的业务事实；尚未接入这些依赖的独立 readiness/worker 探针。</p>
        <div className="summary-list">
          <OperationsProbeStatus label="PostgreSQL 服务健康" status={metrics.runtimeProbes.postgresql}/>
          <OperationsProbeStatus label="Redis" status={metrics.runtimeProbes.redis}/>
          <OperationsProbeStatus label="KMS" status={metrics.runtimeProbes.kms}/>
          <OperationsProbeStatus label="运营/结算 worker" status={metrics.runtimeProbes.worker}/>
        </div>
      </Panel>
      <p className="muted">扩展指标数据源：{metrics.dataSource === 'postgresql_persisted_aggregates' ? 'PostgreSQL 持久化聚合' : '未知'}；快照时间：{formatDate(metrics.snapshotAt)}。</p>
    </>}
    {!metrics && <div className="notice" role="status"><strong>扩展指标尚不可用</strong><span>服务端仅返回兼容的基础请求、尝试与租约摘要；未收到扩展指标时不推断健康状态。</span></div>}
    <details className="notice">
      <summary>当前未接入的 §6.3 指标</summary>
      <p>首 Token/上游首字节延迟、按协议/模型/租户/API key 的用量分层、Redis/PostgreSQL/KMS/worker 运行时健康、账本对账差异、PSP 状态、支付处理完成延迟，以及告警阈值/抑制/升级/恢复与最近事件，当前均未由此接口提供。</p>
      <p>账号状态来自最近持久化的网关观察，单一最新时间戳不证明每个账号观察新鲜；HTTP 错误只统计已记录的 4xx/5xx 响应。</p>
    </details>
  </>;
}

function formatOperationsPercent(value: string | null): string {
  return value === null ? '—' : `${value}%`;
}

function formatOperationsMilliseconds(value: string | null): string {
  if (value === null) return '—';
  const milliseconds = BigInt(value);
  if (milliseconds < 1_000n) return `${milliseconds} 毫秒`;
  if (milliseconds < 60_000n) return `${milliseconds / 1_000n}.${(milliseconds % 1_000n) / 100n} 秒`;
  const totalSeconds = milliseconds / 1_000n;
  return `${totalSeconds / 60n} 分 ${totalSeconds % 60n} 秒`;
}

function formatOperationsElapsed(value: string | null): string {
  if (value === null) return '无待处理事件';
  const milliseconds = BigInt(value);
  if (milliseconds < 1_000n) return `${milliseconds} 毫秒`;
  const seconds = milliseconds / 1_000n;
  if (seconds < 60n) return `${seconds} 秒`;
  if (seconds < 3_600n) return `${seconds / 60n} 分 ${seconds % 60n} 秒`;
  const minutes = seconds / 60n;
  if (minutes < 1_440n) return `${minutes / 60n} 小时 ${minutes % 60n} 分`;
  return `${minutes / 1_440n} 天 ${minutes % 1_440n / 60n} 小时`;
}

function ratioPercent(count: string, total: bigint): string | null {
  if (total === 0n) return null;
  const numerator = BigInt(count);
  if (numerator > total) return null;
  const hundredths = (numerator * 10_000n + total / 2n) / total;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

function OperationsStatusCounts({ counts, label }: { counts: PlatformOperationsStatusCounts; label: string }) {
  const rows: Array<{ key: keyof PlatformOperationsStatusCounts; label: string; tone: 'good' | 'warn' | 'bad' }> = [
    { key: 'pending', label: '处理中', tone: 'warn' },
    { key: 'succeeded', label: '成功', tone: 'good' },
    { key: 'failed', label: '失败', tone: 'bad' },
    { key: 'unknown', label: '未知', tone: 'warn' },
  ];
  const total = rows.reduce((sum, row) => sum + BigInt(counts[row.key]), 0n);
  return <div className="summary-list" role="list" aria-label={`${label}状态分布`}>
    {rows.map(row => {
      const count = counts[row.key];
      const percent = ratioPercent(count, total);
      const tone = row.key === 'succeeded' && count === '0' ? 'neutral' : row.tone;
      return <div key={row.key} role="listitem">
        <span><Badge tone={tone}>{row.label}</Badge></span>
        <strong>{formatDecimalCount(count)} · {formatOperationsPercent(percent)}</strong>
        <meter min="0" max="100" value={percent === null ? 0 : Number(percent)} aria-label={`${label}${row.label}占比`} aria-valuetext={formatOperationsPercent(percent)}/>
      </div>;
    })}
  </div>;
}

function OperationsHealthCount({
  label,
  count,
  tone,
}: {
  label: string;
  count: string;
  tone: 'good' | 'warn' | 'bad';
}) {
  return <div role="listitem"><span><Badge tone={count === '0' && tone === 'good' ? 'neutral' : tone}>{label}</Badge></span><strong>{formatDecimalCount(count)}</strong></div>;
}

function OperationsProbeStatus({ label, status }: { label: string; status: 'unavailable' | 'not_configured' }) {
  return <div><span>{label}</span><Badge tone="warn">{status === 'not_configured' ? '未配置探针' : '不可用'}</Badge></div>;
}

function OpsOverviewPage() {
  return <><div className="page-title"><div><p className="eyebrow">运营</p><h1>运营概览</h1><p>按服务端支持的时间范围读取真实聚合摘要。</p></div></div><OperationsSummaryPanel/></>;
}

type UnknownOutcomeResolutionState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; status: 'resolved' | 'replayed' }
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'error'; error: unknown };

interface UnknownOutcomeResolutionFormInput {
  supportTicketRef: string;
  reason: string;
  coverage: Array<{ attemptId: string; evidenceReference: string }>;
}

function canManageUnknownOutcomes(me: MeState): boolean {
  return me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');
}

function newUnknownOutcomeIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  return typeof cryptoApi?.randomUUID === 'function'
    ? `unknown-outcome-resolution:${cryptoApi.randomUUID()}`
    : `unknown-outcome-resolution:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function unknownOutcomeObservationKindLabel(kind: PlatformUnknownOutcomeObservation['kind']): string {
  switch (kind) {
    case 'request_snapshot': return '请求快照';
    case 'attempt_snapshot': return '尝试快照';
    case 'usage_snapshot': return '用量快照';
    case 'provider_evidence': return 'Provider 证据元数据';
    case 'operator_resolution': return '人工处置记录';
  }
}

function unknownOutcomeValue(value: string | number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function unknownOutcomeObservationFields(observation: PlatformUnknownOutcomeObservation): Array<[string, string]> {
  return [
    ['观察 ID', observation.observationId],
    ['观察时间', formatDate(observation.observedAt)],
    ['可能尝试 ID', observation.attemptId],
    ['用量事件 ID', observation.usageEventId],
    ['供给模式', observation.supplyMode],
    ['执行状态', observation.executionState],
    ['对账状态', observation.reconciliationState],
    ['财务状态', observation.financialStatus],
    ['请求状态版本', observation.requestStateVersion],
    ['派发状态', observation.dispatchState],
    ['结果状态', observation.resultState],
    ['已开始响应', observation.responseStarted],
    ['尝试状态版本', observation.attemptStateVersion],
    ['上游 ID', observation.upstreamId],
    ['账号所有者类型', observation.accountOwnerKind],
    ['账号 ID', observation.accountId],
    ['Provider ID', observation.providerId],
    ['产品 ID', observation.productId],
    ['解析模型', observation.resolvedModel],
    ['未知原因', observation.unknownReason],
    ['用量事件摘要', observation.usageEventDigest],
    ['Provider 状态', observation.providerStatus],
    ['Provider 操作 ID', observation.providerOperationId],
    ['Provider 身份摘要', observation.providerIdentityDigest],
    ['证据定位', observation.evidenceReference],
    ['操作者处置结果', observation.operatorOutcome],
    ['审计事件 ID', observation.auditEventId],
  ].map(([label, value]) => [label, unknownOutcomeValue(value)] as [string, string]);
}

function UnknownOutcomeCaseSummaryPanel({ summary }: { summary: PlatformUnknownOutcomeCaseSummary }) {
  return <div className="summary-list">
    <div><span>案件 ID</span><code>{summary.caseId}</code></div>
    <div><span>租户 ID</span><code>{summary.tenantId}</code></div>
    <div><span>项目 ID</span><code>{summary.projectId}</code></div>
    <div><span>请求 ID</span><code>{summary.requestId}</code></div>
    <div><span>供给模式</span><span>{summary.supplyMode}</span></div>
    <div><span>扫描尝试次数</span><span>{summary.scanAttempts}</span></div>
    <div><span>最后安全错误代码</span><code>{summary.lastErrorCode ?? '—'}</code></div>
    <div><span>创建时间</span><span>{formatDate(summary.createdAt)}</span></div>
  </div>;
}

export function UnknownOutcomeCaseDetailPanel({ detail }: { detail: PlatformUnknownOutcomeCaseDetail }) {
  return <>
    <UnknownOutcomeCaseSummaryPanel summary={detail.summary}/>
    <Panel title="可能的上游尝试">
      {detail.possibleAttemptIds.length === 0
        ? <div className="empty" role="status">服务端没有返回可供处置的可能尝试。</div>
        : <ul aria-label="可能的上游尝试">{detail.possibleAttemptIds.map(attemptId => <li key={attemptId}><code>{attemptId}</code></li>)}</ul>}
    </Panel>
    <Panel title="不可变观察时间线">
      <p className="muted">时间线按服务端 observedAt 与 observation ID 顺序返回，只展示脱敏元数据；提示词、响应正文和 Provider 用量正文不会展示。</p>
      {detail.observations.length === 0
        ? <div className="empty" role="status">暂无观察记录。</div>
        : <ol aria-label="不可变观察时间线">{detail.observations.map(observation => <li key={observation.observationId}>
          <strong>{unknownOutcomeObservationKindLabel(observation.kind)}</strong>
          <div className="summary-list">{unknownOutcomeObservationFields(observation).map(([label, value]) => <div key={label}><span>{label}</span>{value === '—' ? <span>—</span> : <code>{value}</code>}</div>)}</div>
        </li>)}</ol>}
    </Panel>
  </>;
}

function UnknownOutcomeResolutionNotice({ state }: { state: UnknownOutcomeResolutionState }) {
  if (state.kind === 'success') {
    return <div className="notice" role="status"><strong>处置成功</strong><span>{state.status === 'replayed' ? '服务端按同一幂等键返回了已完成的处置。' : '案件已按 not_executed 处置，列表和详情已刷新。'}</span></div>;
  }
  if (state.kind === 'conflict') {
    return <div className="notice error" role="alert"><strong>处置冲突</strong><span>案件状态已发生变化，服务端没有接受本次处置。请刷新案件后重新核对；当前幂等键会保留用于本次处置重试。</span></div>;
  }
  if (state.kind === 'forbidden') {
    return <div className="notice error" role="alert"><strong>权限不足</strong><span>服务端拒绝了处置权限；页面不会显示后端授权细节。请联系平台管理员确认当前角色。</span></div>;
  }
  if (state.kind === 'unavailable') {
    return <div className="notice error" role="alert"><strong>处置接口暂不可用</strong><span>未知结果处置接口当前不可用或尚未接入，请稍后重试。</span></div>;
  }
  if (state.kind === 'error') return <PlatformErrorNotice error={state.error} title="未知结果处置失败"/>;
  return null;
}

export function UnknownOutcomeResolutionForm({
  detail,
  busy,
  state,
  idempotencyStatus,
  onSubmit,
}: {
  detail: PlatformUnknownOutcomeCaseDetail;
  busy: boolean;
  state: UnknownOutcomeResolutionState;
  idempotencyStatus: string;
  onSubmit: (input: UnknownOutcomeResolutionFormInput) => Promise<void>;
}) {
  const [supportTicketRef, setSupportTicketRef] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceReferences, setEvidenceReferences] = useState<Record<string, string>>(() =>
    detail.possibleAttemptIds.reduce<Record<string, string>>((result, attemptId) => {
      result[attemptId] = '';
      return result;
    }, {}),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [validationError, setValidationError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (detail.possibleAttemptIds.length === 0) {
      setValidationError('没有可能的尝试，不能提交 not_executed 处置。');
      return;
    }
    if (!confirmed) {
      setValidationError('提交前必须完成二次确认。');
      return;
    }
    const coverage = detail.possibleAttemptIds.map(attemptId => ({
      attemptId,
      evidenceReference: (evidenceReferences[attemptId] ?? '').trim(),
    }));
    if (supportTicketRef.trim() === '' || reason.trim() === '' || coverage.some(item => item.evidenceReference === '')) {
      setValidationError('请填写 supportTicketRef、reason，并为每个 possibleAttemptId 提供一条 evidenceReference。');
      return;
    }
    setValidationError('');
    await onSubmit({ supportTicketRef: supportTicketRef.trim(), reason: reason.trim(), coverage });
  }

  return <Panel title="处置为未执行">
    <p className="muted">固定 outcome：<code>not_executed</code>。服务端仍会在事务内重新校验案件、请求状态和当前权限。</p>
    <p className="muted">evidenceReference 只用于定位证据，不是已验证的 Provider 证明；请填写支持工单、查询记录或审计证据的位置。</p>
    <form onSubmit={event => void submit(event)}>
      <Field label="supportTicketRef" hint="填写支持工单或内部处置记录引用，不要粘贴请求或响应正文。"><input required maxLength={255} autoComplete="off" value={supportTicketRef} onChange={event => setSupportTicketRef(event.target.value)}/></Field>
      <Field label="reason" hint="填写人工判断理由，不要包含提示词或响应正文。"><textarea required maxLength={2000} rows={4} value={reason} onChange={event => setReason(event.target.value)}/></Field>
      <div className="field"><span>每个 possibleAttemptId 的 evidenceReference</span>{detail.possibleAttemptIds.map(attemptId => <label className="field" key={attemptId}><span><code>{attemptId}</code></span><input required maxLength={512} autoComplete="off" aria-label={`evidenceReference ${attemptId}`} value={evidenceReferences[attemptId] ?? ''} onChange={event => setEvidenceReferences(current => ({ ...current, [attemptId]: event.target.value }))}/></label>)}</div>
      <Field label="固定 outcome"><code>not_executed</code></Field>
      <Field label="提交前二次确认"><span><input required type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> 我确认每个可能尝试都有独立证据定位，并理解 evidenceReference 不是 Provider 已验证证明。</span></Field>
      <div className="notice" role="status"><strong>幂等状态</strong><span>{idempotencyStatus}</span></div>
      {validationError && <p className="form-error" role="alert">{validationError}</p>}
      <div className="actions"><SaveButton busy={busy}>提交 not_executed 处置</SaveButton></div>
    </form>
    <UnknownOutcomeResolutionNotice state={state}/>
  </Panel>;
}

export function UnknownOutcomesPage({ me }: { me: MeState }) {
  const [tenantDraft, setTenantDraft] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [cases, setCases] = useState<PlatformUnknownOutcomeCaseSummary[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<unknown>();
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [detail, setDetail] = useState<PlatformUnknownOutcomeCaseDetail>();
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<unknown>();
  const [resolutionState, setResolutionState] = useState<UnknownOutcomeResolutionState>({ kind: 'idle' });
  const [resolutionFormVersion, setResolutionFormVersion] = useState(0);
  const idempotencyKeyRef = useRef<string | undefined>(undefined);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const canManage = canManageUnknownOutcomes(me);

  function resetSelectedCase(preserveResolution = false) {
    detailRequestRef.current += 1;
    setSelectedCaseId('');
    setDetail(undefined);
    setDetailError(undefined);
    setDetailBusy(false);
    if (!preserveResolution) setResolutionState({ kind: 'idle' });
    setResolutionFormVersion(value => value + 1);
    idempotencyKeyRef.current = undefined;
  }

  async function loadCases(event: FormEvent) {
    event.preventDefault();
    const candidate = tenantDraft.trim();
    if (candidate === '') {
      setListError(new PlatformApiError(400, 'INVALID_INPUT', '请输入租户 ID。'));
      return;
    }
    const requestNumber = ++listRequestRef.current;
    setTenantId(candidate);
    setListBusy(true);
    setListError(undefined);
    setCases([]);
    resetSelectedCase();
    try {
      const result = await platformClient.listUnknownOutcomeCases({ tenantId: candidate, limit: 50 });
      if (requestNumber !== listRequestRef.current) return;
      setCases(result);
    } catch (error) {
      if (requestNumber === listRequestRef.current) setListError(error);
    } finally {
      if (requestNumber === listRequestRef.current) setListBusy(false);
    }
  }

  async function reloadCases() {
    if (!tenantId) return;
    setListBusy(true);
    setListError(undefined);
    try {
      setCases(await platformClient.listUnknownOutcomeCases({ tenantId, limit: 50 }));
    } catch (error) {
      setListError(error);
    } finally {
      setListBusy(false);
    }
  }

  async function selectCase(caseId: string) {
    if (!tenantId) return;
    const requestNumber = ++detailRequestRef.current;
    setSelectedCaseId(caseId);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailBusy(true);
    setResolutionState({ kind: 'idle' });
    setResolutionFormVersion(value => value + 1);
    idempotencyKeyRef.current = undefined;
    try {
      const result = await platformClient.getUnknownOutcomeCase(tenantId, caseId);
      if (requestNumber !== detailRequestRef.current) return;
      setDetail(result);
    } catch (error) {
      if (requestNumber === detailRequestRef.current) setDetailError(error);
    } finally {
      if (requestNumber === detailRequestRef.current) setDetailBusy(false);
    }
  }

  async function refreshAfterResolution(caseId: string) {
    try {
      const refreshedCases = await platformClient.listUnknownOutcomeCases({ tenantId, limit: 50 });
      setCases(refreshedCases);
      if (!refreshedCases.some(item => item.caseId === caseId)) {
        resetSelectedCase(true);
        return;
      }
      const refreshedDetail = await platformClient.getUnknownOutcomeCase(tenantId, caseId);
      setDetail(refreshedDetail);
    } catch (error) {
      setListError(error);
    }
  }

  async function resolve(input: UnknownOutcomeResolutionFormInput) {
    if (!canManage || !detail || !selectedCaseId || !tenantId) return;
    const idempotencyKey = idempotencyKeyRef.current ?? newUnknownOutcomeIdempotencyKey();
    idempotencyKeyRef.current = idempotencyKey;
    setResolutionState({ kind: 'submitting' });
    try {
      const result = await platformClient.resolveUnknownOutcomeNotExecuted({
        tenantId,
        caseId: selectedCaseId,
        supportTicketRef: input.supportTicketRef,
        reason: input.reason,
        coverage: input.coverage,
        idempotencyKey,
      });
      setResolutionState({ kind: 'success', status: result.status });
      setResolutionFormVersion(value => value + 1);
      idempotencyKeyRef.current = undefined;
      await refreshAfterResolution(result.caseId);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      if (error instanceof PlatformApiError && error.status === 403) setResolutionState({ kind: 'forbidden' });
      else if (error instanceof PlatformApiError && error.status === 409) setResolutionState({ kind: 'conflict' });
      else if (isPlatformApiUnavailable(error)) setResolutionState({ kind: 'unavailable' });
      else setResolutionState({ kind: 'error', error });
    } finally {
      setResolutionState(current => current.kind === 'submitting' ? { kind: 'idle' } : current);
    }
  }

  const idempotencyStatus = resolutionState.kind === 'success'
    ? '本次处置已完成。'
    : idempotencyKeyRef.current
      ? '已为本次处置生成；重试会复用同一个 Idempotency-Key。'
      : '尚未生成；首次提交时仅在当前页面内存中生成，操作者身份由服务端会话决定。';
  const selectedSummary = cases.find(item => item.caseId === selectedCaseId);
  const resolutionBusy = resolutionState.kind === 'submitting';

  return <>
    <div className="page-title"><div><p className="eyebrow">运营对账</p><h1>未知结果案件</h1><p>按租户读取状态为 operator_required 的未知结果案件，使用脱敏元数据和不可变观察时间线进行人工对账。</p></div></div>
    <div className="notice" role="note"><strong>敏感内容保护</strong><span>本页面只读取案件元数据、可能的 attempt ID 和观察时间线；不会读取、保存或渲染 prompt、response body 或 Provider usage body。</span></div>
    {me.kind === 'ready' && !canManage && <div className="notice" role="note"><strong>当前角色只读</strong><span>案件读取可由服务端授权；not_executed 处置控件仅对 operations 或 superadmin 显示，最终权限仍由服务端决定。</span></div>}
    {me.kind !== 'ready' && <div className="notice" role="note"><strong>正在确认管理员角色</strong><span>处置控件会在服务端身份读取完成并确认合理角色后显示。</span></div>}

    <Panel title="按租户读取 operator_required 案件">
      <form onSubmit={event => void loadCases(event)}>
        <Field label="租户 ID" hint="tenantId 会作为每个列表、详情和处置 endpoint 的 query 参数发送。"><input required maxLength={255} autoComplete="off" value={tenantDraft} onChange={event => setTenantDraft(event.target.value)}/></Field>
        <SaveButton busy={listBusy}>读取案件列表</SaveButton>
      </form>
    </Panel>

    {tenantId && <Panel title={`案件列表 · 租户 ${tenantId}`}>
      {listBusy && <div className="skeleton" role="status" aria-label="正在读取未知结果案件"><i/><i/><i/></div>}
      {!listBusy && listError !== undefined && <PlatformErrorNotice error={listError} title="未知结果案件读取失败" onRetry={() => { setTenantDraft(tenantId); void reloadCases(); }}/>} 
      {!listBusy && listError === undefined && cases.length === 0 && <div className="empty" role="status">该租户当前没有 operator_required 案件。</div>}
      {!listBusy && listError === undefined && cases.length > 0 && <div className="table-wrap"><table><thead><tr><th>案件 ID</th><th>项目 ID</th><th>请求 ID</th><th>供给模式</th><th>扫描次数</th><th>创建时间</th></tr></thead><tbody>{cases.map(item => <tr key={item.caseId}><td><button type="button" aria-pressed={selectedCaseId === item.caseId} onClick={() => void selectCase(item.caseId)}><code>{item.caseId}</code></button></td><td><code>{item.projectId}</code></td><td><code>{item.requestId}</code></td><td>{item.supplyMode}</td><td>{item.scanAttempts}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div>}
    </Panel>}

    {!selectedSummary && <UnknownOutcomeResolutionNotice state={resolutionState}/>} 
    {selectedSummary && <Panel title="选中案件详情">
      {detailBusy && <div className="skeleton" role="status" aria-label="正在读取案件详情"><i/><i/><i/></div>}
      {!detailBusy && detailError !== undefined && <PlatformErrorNotice error={detailError} title="案件详情读取失败" onRetry={() => void selectCase(selectedSummary.caseId)}/>} 
      {!detailBusy && detailError === undefined && detail && <UnknownOutcomeCaseDetailPanel detail={detail}/>} 
      {!detailBusy && detailError === undefined && detail && canManage && <UnknownOutcomeResolutionForm key={`${selectedCaseId}:${resolutionFormVersion}`} detail={detail} busy={resolutionBusy} state={resolutionState} idempotencyStatus={idempotencyStatus} onSubmit={resolve}/>} 
    </Panel>}
  </>;
}

interface RefundDraft {
  tenantId: string;
  orderId: string;
  reasonCode: string;
  idempotencyKey: string;
}

interface RefundLookupDraft {
  tenantId: string;
  refundId: string;
}

function newRefundIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  return typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID()
    : `refund-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canManageRefunds(me: MeState): boolean {
  return me.kind === 'ready' && me.me.roles.some(role => role === 'finance' || role === 'superadmin');
}

const refundStatusLabels: Record<PlatformRefundRecord['status'], string> = {
  submitting: '正在提交',
  pending: '处理中',
  succeeded: '已成功',
  failed: '失败',
  unknown: '状态未知',
  blocked: '已冻结',
};

function refundStatusTone(status: PlatformRefundRecord['status']): 'good' | 'warn' | 'bad' {
  if (status === 'succeeded') return 'good';
  if (status === 'failed') return 'bad';
  return 'warn';
}

export function PlatformRefundRecordPanel({ record }: { record: PlatformRefundRecord }) {
  const byokServicePlan = record.refundType === 'byok_service_plan';
  const needsReview = byokServicePlan || record.status === 'unknown' || record.status === 'blocked';
  let message: string;
  if (byokServicePlan) {
    message = '此记录属于 BYOK 服务套餐退款。此类退款不受支持并由服务端冻结；请勿重试。';
  } else if (record.status === 'unknown') {
    message = '服务端无法确认退款结果。请使用租户 ID 和退款 ID 查询状态，并联系支付运维核实；请勿重复发起此订单退款。';
  } else if (record.status === 'blocked') {
    message = '退款已由服务端冻结。请联系支付运维核实冻结原因；请勿重复发起此订单退款。';
  } else if (record.status === 'pending' || record.status === 'submitting') {
    message = '服务端仍在处理此退款。请使用租户 ID 和退款 ID 查询进度。';
  } else if (record.status === 'failed') {
    message = '服务端报告退款失败。请核对失败代码并按支付运维流程处理。';
  } else {
    message = '服务端报告退款成功。';
  }
  const role = needsReview ? 'alert' : 'status';

  return <Panel title="退款状态">
    <div className={`notice${needsReview ? ' error' : ''}`} role={role}>
      <strong><Badge tone={refundStatusTone(record.status)}>{refundStatusLabels[record.status]}</Badge>{byokServicePlan && <Badge tone="bad">BYOK 服务套餐</Badge>}</strong>
      <span>{message}</span>
    </div>
    <div className="summary-list">
      <div><span>租户 ID</span><code>{record.tenantId}</code></div>
      <div><span>退款 ID</span><code>{record.id}</code></div>
      <div><span>订单 ID</span><code>{record.originalOrderId}</code></div>
      <div><span>退款类型</span><span>{byokServicePlan ? 'BYOK 服务套餐（不支持）' : '钱包充值全额退款'}</span></div>
      <div><span>退款金额（最小货币单位）</span><strong>{record.amountMinorUnits} {record.currency}</strong></div>
      <div><span>创建时间</span><span>{formatDate(record.createdAt)}</span></div>
      <div><span>更新时间</span><span>{formatDate(record.updatedAt)}</span></div>
      {record.completedAt && <div><span>完成时间</span><span>{formatDate(record.completedAt)}</span></div>}
      {record.failureCode && <div><span>失败代码</span><code>{record.failureCode}</code></div>}
      {record.blockedCode && <div><span>冻结代码</span><code>{record.blockedCode}</code></div>}
    </div>
    <p className="muted">支付服务商引用和内部钱包流水 ID 在此页面隐藏。</p>
  </Panel>;
}

export function RefundsPage({ me }: { me: MeState }) {
  const canWrite = canManageRefunds(me);
  const [draft, setDraft] = useState<RefundDraft>(() => ({ tenantId: '', orderId: '', reasonCode: '', idempotencyKey: newRefundIdempotencyKey() }));
  const [confirmedWalletTopUp, setConfirmedWalletTopUp] = useState(false);
  const [lookupDraft, setLookupDraft] = useState<RefundLookupDraft>({ tenantId: '', refundId: '' });
  const [record, setRecord] = useState<PlatformRefundRecord>();
  const [requestBusy, setRequestBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [requestError, setRequestError] = useState<unknown>();
  const [lookupError, setLookupError] = useState<unknown>();
  const [requestNotice, setRequestNotice] = useState('');

  function updateDraft<K extends keyof RefundDraft>(key: K, value: RefundDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function sameUnresolvedOrder(): boolean {
    return record !== undefined &&
      record.tenantId === draft.tenantId.trim() &&
      record.originalOrderId === draft.orderId.trim() &&
      (record.status === 'submitting' || record.status === 'pending' || record.status === 'unknown' || record.status === 'blocked');
  }

  function resetRequestKey() {
    setDraft(current => ({ ...current, idempotencyKey: newRefundIdempotencyKey() }));
  }

  async function submitRefund(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !confirmedWalletTopUp || sameUnresolvedOrder()) return;
    setRequestBusy(true);
    setRequestError(undefined);
    setLookupError(undefined);
    setRequestNotice('');
    try {
      const result = await platformClient.requestWalletTopUpRefund({
        tenantId: draft.tenantId.trim(),
        orderId: draft.orderId.trim(),
        reasonCode: draft.reasonCode.trim(),
        idempotencyKey: draft.idempotencyKey.trim(),
      });
      setRecord(result);
      setLookupDraft({ tenantId: result.tenantId, refundId: result.id });
      setRequestNotice('退款申请已受理，当前状态以服务端记录为准。');
      setConfirmedWalletTopUp(false);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setRequestError(error);
    } finally {
      setRequestBusy(false);
    }
  }

  async function lookupRefund(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    setLookupBusy(true);
    setLookupError(undefined);
    setRequestError(undefined);
    setRequestNotice('');
    try {
      const result = await platformClient.getRefund(lookupDraft.tenantId.trim(), lookupDraft.refundId.trim());
      setRecord(result);
      setLookupDraft({ tenantId: result.tenantId, refundId: result.id });
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setLookupError(error);
    } finally {
      setLookupBusy(false);
    }
  }

  const repeatBlocked = sameUnresolvedOrder();
  return <>
    <div className="page-title"><div><p className="eyebrow">财务</p><h1>退款管理</h1><p>按租户和充值订单发起全额钱包充值退款，或按租户查询退款状态。</p></div></div>
    <div className="notice" role="note"><strong>退款范围与安全</strong><span>当前仅支持钱包充值全额退款；BYOK 服务套餐退款不受支持，服务端会将其冻结。发起人和全额金额由服务端解析。幂等键保留在当前页面内存中；状态未知或已冻结时，请先查询并核实，不要重复发起。</span></div>
    {!canWrite && me.kind === 'ready' && <div className="notice" role="note"><strong>当前角色只读</strong><span>退款操作和租户范围查询仅对 finance 或 superadmin 角色开放；最终授权仍由服务端判定。</span></div>}
    {canWrite && <>
      <Panel title="申请钱包充值全额退款">
        <PlatformErrorNotice error={requestError} title="退款申请失败"/>
        {requestNotice && <div className="notice" role="status"><strong>退款申请</strong><span>{requestNotice}</span></div>}
        <form onSubmit={event => void submitRefund(event)}>
          <Field label="租户 ID"><input required maxLength={255} autoComplete="off" value={draft.tenantId} onChange={event => updateDraft('tenantId', event.target.value)}/></Field>
          <Field label="钱包充值订单 ID"><input required maxLength={255} autoComplete="off" value={draft.orderId} onChange={event => updateDraft('orderId', event.target.value)}/></Field>
          <Field label="退款原因代码"><input required maxLength={96} autoComplete="off" value={draft.reasonCode} onChange={event => updateDraft('reasonCode', event.target.value)}/></Field>
          <Field label="幂等键" hint="网络结果不确定时保留并复用此键；服务端用它识别同一请求。">
            <div className="actions"><input required maxLength={255} autoComplete="off" value={draft.idempotencyKey} onChange={event => updateDraft('idempotencyKey', event.target.value)}/><button type="button" disabled={requestBusy} onClick={resetRequestKey}>生成新键</button></div>
          </Field>
          <Field label="退款范围确认"><span><input required type="checkbox" checked={confirmedWalletTopUp} onChange={event => setConfirmedWalletTopUp(event.target.checked)}/> 我确认这是钱包充值订单，并申请该订单的全额退款。</span></Field>
          {repeatBlocked && <div className="notice error" role="alert"><strong>订单状态待核实</strong><span>此订单已有 {refundStatusLabels[record?.status ?? 'unknown']} 的退款记录。请使用下方退款 ID 查询状态；核实完成前不能再次发起。</span></div>}
          <button className="primary" type="submit" disabled={requestBusy || repeatBlocked || !confirmedWalletTopUp}>{requestBusy ? '处理中…' : repeatBlocked ? '请先查询退款状态' : '申请全额退款'}</button>
        </form>
      </Panel>
      <Panel title="查询退款状态">
        <PlatformErrorNotice error={lookupError} title="退款查询失败"/>
        <form onSubmit={event => void lookupRefund(event)}>
          <Field label="租户 ID"><input required maxLength={255} autoComplete="off" value={lookupDraft.tenantId} onChange={event => setLookupDraft(current => ({ ...current, tenantId: event.target.value }))}/></Field>
          <Field label="退款 ID"><input required maxLength={255} autoComplete="off" value={lookupDraft.refundId} onChange={event => setLookupDraft(current => ({ ...current, refundId: event.target.value }))}/></Field>
          <SaveButton busy={lookupBusy}>查询退款</SaveButton>
        </form>
      </Panel>
      {record && <PlatformRefundRecordPanel record={record}/>}
    </>}
  </>;
}

type CatalogLoader<Item> = (query: PlatformCatalogPageQuery) => Promise<PlatformCatalogPage<Item>>;

function loadProductPage({ limit, cursor, signal }: PlatformCatalogPageQuery) {
  return platformClient.listProducts({ limit, cursor, signal });
}

function loadCapabilityPage(query: PlatformCatalogPageQuery) {
  return platformClient.listCapabilities(query);
}

function loadRightsPage(query: PlatformCatalogPageQuery) {
  return platformClient.listRights(query);
}

function CatalogPage<Item>({
  title,
  description,
  providerFilter = false,
  loader,
  renderItems,
}: {
  title: string;
  description: string;
  providerFilter?: boolean;
  loader: CatalogLoader<Item>;
  renderItems: (items: Item[]) => ReactNode;
}) {
  const [providerDraft, setProviderDraft] = useState('');
  const [providerId, setProviderId] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<Array<string | undefined>>([]);
  const [page, setPage] = useState<PlatformCatalogPage<Item>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void loader({
      limit: 50,
      ...(cursor === undefined ? {} : { cursor }),
      ...(providerFilter && providerId ? { providerId } : {}),
      signal: controller.signal,
    }).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(loadError);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [cursor, loader, providerFilter, providerId, reloadKey]);

  function applyProviderFilter(event: FormEvent) {
    event.preventDefault();
    setProviderId(providerDraft.trim() || undefined);
    setCursor(undefined);
    setPreviousCursors([]);
    setReloadKey(value => value + 1);
  }

  function clearProviderFilter() {
    setProviderDraft('');
    setProviderId(undefined);
    setCursor(undefined);
    setPreviousCursors([]);
    setReloadKey(value => value + 1);
  }

  function nextPage() {
    if (!page?.hasMore || !page.nextCursor) return;
    setPreviousCursors(values => [...values, cursor]);
    setCursor(page.nextCursor);
  }

  function previousPage() {
    if (previousCursors.length === 0) return;
    setCursor(previousCursors[previousCursors.length - 1]);
    setPreviousCursors(values => values.slice(0, -1));
  }

  return <><div className="page-title"><div><p className="eyebrow">平台目录</p><h1>{title}</h1><p>{description}</p></div></div>
    <div className="notice" role="note"><strong>服务端授权</strong><span>目录读取权限由服务端根据当前角色判定；此处导航和角色显示不代表已获授权。</span></div>
    {providerFilter && <form className="filters" onSubmit={applyProviderFilter}>
      <Field label="Provider ID"><input value={providerDraft} maxLength={200} onChange={event => setProviderDraft(event.target.value)} placeholder="按 Provider ID 筛选"/></Field>
      <button className="primary" type="submit">应用筛选</button>
      <button type="button" onClick={clearProviderFilter}>清除</button>
    </form>}
    <Panel title="目录记录">
      {loading && <div className="skeleton" role="status" aria-label="正在加载目录"><i/><i/><i/></div>}
      {!loading && error !== undefined && <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="目录读取失败"/>}
      {!loading && error === undefined && page?.items.length === 0 && <div className="empty" role="status">当前没有符合条件的目录记录。</div>}
      {!loading && error === undefined && page && page.items.length > 0 && renderItems(page.items)}
      <div className="actions" aria-label="目录分页"><button type="button" onClick={previousPage} disabled={loading || previousCursors.length === 0}>上一页</button><span className="muted">第 {previousCursors.length + 1} 页</span><button type="button" onClick={nextPage} disabled={loading || !page?.hasMore || !page.nextCursor}>下一页</button></div>
    </Panel>
  </>;
}

function productStatus(status: PlatformCatalogProduct['status']): { label: string; tone: 'good' | 'bad' } {
  return status === 'active' ? { label: '启用', tone: 'good' } : { label: '已停用', tone: 'bad' };
}

function ProductsPage() {
  return <CatalogPage title="产品目录" description="查看平台已登记的供应商产品。" loader={loadProductPage} renderItems={items => <div className="table-wrap"><table><thead><tr><th>Provider ID</th><th>Product ID</th><th>产品名称</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{items.map(item => {
    const status = productStatus(item.status);
    return <tr key={`${item.providerId}:${item.productId}`}><td><code>{item.providerId}</code></td><td><code>{item.productId}</code></td><td>{item.displayName}</td><td><Badge tone={status.tone}>{status.label}</Badge></td><td>{formatDate(item.createdAt)}</td></tr>;
  })}</tbody></table></div>}/>;
}

function supportStatus(value: PlatformCatalogCapability['supportLevel']): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (value === 'supported') return { label: '支持', tone: 'good' };
  if (value === 'limited') return { label: '有限支持', tone: 'warn' };
  return { label: '不支持', tone: 'bad' };
}

function validationStatus(value: PlatformCatalogCapability['validationState']): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (value === 'verified') return { label: '已验证', tone: 'good' };
  if (value === 'failed') return { label: '验证失败', tone: 'bad' };
  return { label: '未验证', tone: 'warn' };
}

function CapabilitiesPage() {
  return <CatalogPage title="能力目录" description="查看模型、端点和协议能力的支持与验证状态。" providerFilter loader={loadCapabilityPage} renderItems={items => <div className="table-wrap"><table><thead><tr><th>供应商 / 产品</th><th>模型</th><th>端点</th><th>协议</th><th>版本</th><th>支持状态</th><th>验证状态</th></tr></thead><tbody>{items.map((item, index) => {
    const support = supportStatus(item.supportLevel);
    const validation = validationStatus(item.validationState);
    return <tr key={`${item.providerId}:${item.productId}:${item.model}:${item.endpoint}:${item.version}:${index}`}><td><code>{item.providerId}</code><small>{item.productId}</small></td><td><code>{item.model}</code></td><td><code>{item.endpoint}</code></td><td>{item.protocol}</td><td>{item.version}</td><td><Badge tone={support.tone}>{support.label}</Badge></td><td><Badge tone={validation.tone}>{validation.label}</Badge></td></tr>;
  })}</tbody></table></div>}/>;
}

function rightsStatus(value: PlatformCatalogRights['status']): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (value === 'active') return { label: '生效中', tone: 'good' };
  if (value === 'revoked') return { label: '已撤销', tone: 'bad' };
  return { label: '草稿', tone: 'warn' };
}

interface RightsVersionDraft {
  rightsId: string;
  providerId: string;
  productId: string;
  credentialType: string;
  supplyMode: 'byok' | 'platform';
  region: string;
  purpose: string;
  modelScope: string;
  endpointScope: string;
  effectiveAt: string;
  expiresAt: string;
  approvalReference: string;
  evidenceReference: string;
  evidenceSha256: string;
  status: 'draft' | 'active';
}

function emptyRightsVersionDraft(): RightsVersionDraft {
  return {
    rightsId: '',
    providerId: '',
    productId: '',
    credentialType: '',
    supplyMode: 'platform',
    region: '',
    purpose: '',
    modelScope: '',
    endpointScope: '',
    effectiveAt: '',
    expiresAt: '',
    approvalReference: '',
    evidenceReference: '',
    evidenceSha256: '',
    status: 'active',
  };
}

function parseRightsScopeDraft(value: string): { values?: string[]; error?: string } {
  const values = value.split(/[\n,]/u).map(item => item.trim()).filter(Boolean);
  if (values.length === 0) return { error: '至少填写一个 scope。' };
  if (values.some(item => item === '*')) return { error: 'scope 不允许使用通配符。' };
  if (new Set(values).size !== values.length) return { error: 'scope 不能重复。' };
  return { values };
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function canManagePricing(me: MeState): boolean {
  return me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');
}

type PriceRateDraft = Record<PlatformPriceMetric, { numerator: string; denominator: string }>;

function emptyPriceRateDraft(): PriceRateDraft {
  return {
    input: { numerator: '0', denominator: '1' },
    output: { numerator: '0', denominator: '1' },
    cache_read: { numerator: '', denominator: '' },
    cache_write: { numerator: '', denominator: '' },
    cache_write_5m: { numerator: '', denominator: '' },
    cache_write_1h: { numerator: '', denominator: '' },
  };
}

function pricingTargetKey(target: PlatformPricingTarget): string {
  return JSON.stringify([target.publicModelId, target.publicModelVersion, target.protocol, target.endpoint]);
}

function priceRatesFromDraft(draft: PriceRateDraft): PlatformRateSetInput {
  const rates: PlatformRateSetInput = {
    input: { numeratorMinorUnits: draft.input.numerator, denominatorUnits: draft.input.denominator },
    output: { numeratorMinorUnits: draft.output.numerator, denominatorUnits: draft.output.denominator },
  };
  for (const metric of ['cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'] as const) {
    const rate = draft[metric];
    if (!rate.numerator && !rate.denominator) continue;
    if (!/^(0|[1-9][0-9]{0,18})$/u.test(rate.numerator) || !/^[1-9][0-9]{0,18}$/u.test(rate.denominator)) {
      throw new Error(`${metric} 需要填写有效的非负整数分子和正整数分母。`);
    }
    rates[metric] = { numeratorMinorUnits: rate.numerator, denominatorUnits: rate.denominator };
  }
  for (const metric of ['input', 'output'] as const) {
    const rate = draft[metric];
    if (!/^(0|[1-9][0-9]{0,18})$/u.test(rate.numerator) || !/^[1-9][0-9]{0,18}$/u.test(rate.denominator)) {
      throw new Error(`${metric} 需要填写有效的非负整数分子和正整数分母。`);
    }
  }
  return rates;
}

export function PricingPage({ me }: { me: MeState }) {
  const canWrite = canManagePricing(me);
  const [kind, setKind] = useState<PlatformPriceVersionKind>('customer');
  const [targets, setTargets] = useState<PlatformPricingTarget[]>([]);
  const [targetCursor, setTargetCursor] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState('');
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState<unknown>();
  const [history, setHistory] = useState<PlatformPriceVersion[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<unknown>();
  const [currency, setCurrency] = useState('USD');
  const [rates, setRates] = useState<PriceRateDraft>(() => emptyPriceRateDraft());
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [effectiveAt, setEffectiveAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [commercialPolicyVersion, setCommercialPolicyVersion] = useState('commercial-v1');
  const [calculatorVersion, setCalculatorVersion] = useState('calculator-v1');
  const [roundingVersion, setRoundingVersion] = useState('rounding-v1');
  const [roundingMode, setRoundingMode] = useState<PlatformPriceVersionRegistrationInput['roundingMode']>('half_even');
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<unknown>();
  const [writeNotice, setWriteNotice] = useState('');

  const selectedTarget = targets.find(target => pricingTargetKey(target) === targetKey);

  async function loadTargets(append = false) {
    setTargetLoading(true);
    setTargetError(undefined);
    try {
      const page = await platformClient.listPricingTargets({ kind, limit: 100, ...(append && targetCursor ? { cursor: targetCursor } : {}) });
      setTargets(current => append ? [...current, ...page.items] : page.items);
      setTargetCursor(page.nextCursor);
      if (!append) setTargetKey(page.items[0] ? pricingTargetKey(page.items[0]) : '');
      setHistory([]);
      setHistoryCursor(null);
      setHistoryError(undefined);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setTargetError(error);
    } finally {
      setTargetLoading(false);
    }
  }

  async function loadHistory(append = false) {
    if (!selectedTarget) return;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const query: PlatformPriceVersionHistoryQuery = {
        kind,
        publicModelId: selectedTarget.publicModelId,
        publicModelVersion: selectedTarget.publicModelVersion,
        protocol: selectedTarget.protocol,
        endpoint: selectedTarget.endpoint,
        currency: currency.trim().toUpperCase(),
        limit: 50,
        ...(append && historyCursor ? { cursor: historyCursor } : {}),
      };
      const page = await platformClient.listPriceVersionHistory(query);
      setHistory(current => append ? [...current, ...page.items] : page.items);
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setHistoryError(error);
    } finally {
      setHistoryLoading(false);
    }
  }

  function changeKind(value: PlatformPriceVersionKind) {
    setKind(value);
    setTargets([]);
    setTargetKey('');
    setTargetCursor(null);
    setHistory([]);
    setHistoryCursor(null);
    setTargetError(undefined);
    setHistoryError(undefined);
    setWriteNotice('');
  }

  function changeRate(metric: PlatformPriceMetric, field: 'numerator' | 'denominator', value: string) {
    setRates(current => ({ ...current, [metric]: { ...current[metric], [field]: value } }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedTarget) return;
    const isoEffectiveAt = localDateTimeToIso(effectiveAt);
    const isoExpiresAt = expiresAt ? localDateTimeToIso(expiresAt) : undefined;
    if (!isoEffectiveAt || (expiresAt && !isoExpiresAt) || (isoExpiresAt && Date.parse(isoExpiresAt) <= Date.parse(isoEffectiveAt))) {
      setWriteError(new Error('生效时间和失效时间无效；失效时间必须晚于生效时间。'));
      return;
    }
    if (!/^[A-Z]{3}$/u.test(currency.trim().toUpperCase())) {
      setWriteError(new Error('币种必须是三个大写字母，例如 USD。'));
      return;
    }
    let exactRates: PlatformRateSetInput;
    try {
      exactRates = priceRatesFromDraft(rates);
    } catch (error) {
      setWriteError(error);
      return;
    }
    const input: PlatformPriceVersionRegistrationInput = {
      publicModelId: selectedTarget.publicModelId,
      publicModelVersion: selectedTarget.publicModelVersion,
      protocol: selectedTarget.protocol,
      endpoint: selectedTarget.endpoint,
      currency: currency.trim().toUpperCase(),
      idempotencyKey: idempotencyKey.trim(),
      effectiveAt: isoEffectiveAt,
      ...(isoExpiresAt ? { expiresAt: isoExpiresAt } : {}),
      commercialPolicyVersion: commercialPolicyVersion.trim(),
      calculatorVersion: calculatorVersion.trim(),
      roundingVersion: roundingVersion.trim(),
      roundingMode,
      roundingBoundary: 'total',
      rates: exactRates,
    };
    setWriteBusy(true);
    setWriteError(undefined);
    setWriteNotice('');
    try {
      const record = kind === 'customer'
        ? await platformClient.registerCustomerPriceVersion(input)
        : await platformClient.registerSupplierCostVersion(input);
      setWriteNotice(`已追加 ${kind === 'customer' ? '客户售价' : '供应商成本'}版本 ${record.version}。审计事件与版本在同一数据库事务内提交。`);
      setIdempotencyKey('');
      await loadHistory();
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setWriteError(error);
    } finally {
      setWriteBusy(false);
    }
  }

  return <>
    <div className="page-title"><div><p className="eyebrow">平台商业定价</p><h1>价格版本</h1><p>价格以不可变的精确有理数追加；平台会从当前模型目录解析 Provider、商品及模型映射，并为每次成功注册写入审计事件。</p></div></div>
    {!canWrite && <div className="notice" role="note"><strong>仅运营管理员可用</strong><span>读取和写入平台价格需要 operations 或 superadmin 角色；服务端会再次检查当前会话权限。</span></div>}
    {canWrite && <>
      <Panel title="选择定价目标">
        <Field label="价格类型"><select aria-label="价格类型" value={kind} disabled={targetLoading || writeBusy} onChange={event => changeKind(event.target.value as PlatformPriceVersionKind)}><option value="customer">客户售价</option><option value="supplier">供应商成本</option></select></Field>
        <div className="actions"><button type="button" disabled={targetLoading || writeBusy} onClick={() => void loadTargets()}>{targetLoading ? '正在读取目标…' : '读取可定价目标'}</button>{targetCursor && <button type="button" disabled={targetLoading || writeBusy} onClick={() => void loadTargets(true)}>加载更多目标</button>}</div>
        {targetError !== undefined && <PlatformErrorNotice error={targetError} title="定价目标读取失败" onRetry={() => void loadTargets()}/>}
        {targets.length === 0 && !targetLoading && <div className="empty" role="status">读取后显示符合当前目录能力和权利条件的模型目标。</div>}
        {targets.length > 0 && <Field label="模型 / Provider 目标"><select aria-label="模型 / Provider 目标" value={targetKey} disabled={targetLoading || writeBusy} onChange={event => { setTargetKey(event.target.value); setHistory([]); setHistoryCursor(null); setHistoryError(undefined); }}><option value="">请选择目标</option>{targets.map(target => <option key={pricingTargetKey(target)} value={pricingTargetKey(target)}>{target.displayName} · {target.publicModelAlias} v{target.publicModelVersion} · {target.protocol}/{target.endpoint} · {target.providerId}/{target.productId}{kind === 'supplier' ? ` → ${target.resolvedModel}` : ''}</option>)}</select></Field>}
        {selectedTarget && <div className="summary-list"><div><span>公开模型</span><span>{selectedTarget.publicModelAlias} · v{selectedTarget.publicModelVersion}</span></div><div><span>Provider / 商品</span><code>{selectedTarget.providerId} / {selectedTarget.productId}</code></div><div><span>Provider 模型映射</span><code>{selectedTarget.resolvedModel}</code></div><div><span>协议 / 端点</span><code>{selectedTarget.protocol} / {selectedTarget.endpoint}</code></div><div><span>能力版本</span><code>{selectedTarget.capabilityVersion}</code></div></div>}
      </Panel>

      {selectedTarget && <>
        <Panel title="价格版本历史" action={<button type="button" disabled={historyLoading || writeBusy} onClick={() => void loadHistory()}>{historyLoading ? '正在读取…' : '读取历史'}</button>}>
          <Field label="币种"><input required maxLength={3} autoComplete="off" value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())}/></Field>
          {historyError !== undefined && <PlatformErrorNotice error={historyError} title="价格历史读取失败" onRetry={() => void loadHistory()}/>}
          {history.length === 0 && !historyLoading && <div className="empty" role="status">选择币种并读取该目标的不可变版本历史。</div>}
          {history.length > 0 && <div className="table-wrap"><table><thead><tr><th>版本</th><th>类型</th><th>币种</th><th>输入 / 输出</th><th>生效区间</th><th>舍入</th><th>摘要</th></tr></thead><tbody>{history.map(record => <tr key={record.id}><td>v{record.version}</td><td>{record.kind === 'customer' ? '客户售价' : '供应商成本'}</td><td>{record.currency}</td><td><code>输入 {record.rates.input?.numeratorMinorUnits ?? '—'}/{record.rates.input?.denominatorUnits ?? '—'} · 输出 {record.rates.output?.numeratorMinorUnits ?? '—'}/{record.rates.output?.denominatorUnits ?? '—'}</code></td><td>{formatDate(record.effectiveAt)}<br/>至 {formatDate(record.expiresAt)}</td><td>{record.roundingMode} · {record.roundingBoundary}</td><td><code>{record.definitionDigest.slice(0, 16)}…</code></td></tr>)}</tbody></table></div>}
          {historyCursor && <div className="actions"><button type="button" disabled={historyLoading} onClick={() => void loadHistory(true)}>加载更多历史</button></div>}
        </Panel>

        <Panel title={`追加${kind === 'customer' ? '客户售价' : '供应商成本'}版本`}>
          <form onSubmit={event => void submit(event)}>
            <Field label="幂等键" hint="相同目标和幂等键的重试会返回原版本。请为每次有意的新价格生成新键。"><div className="actions"><input required maxLength={512} autoComplete="off" value={idempotencyKey} onChange={event => setIdempotencyKey(event.target.value)}/><button type="button" onClick={() => setIdempotencyKey(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)}>生成</button></div></Field>
            <div className="grid two"><Field label="生效时间"><input required type="datetime-local" value={effectiveAt} onChange={event => setEffectiveAt(event.target.value)}/></Field><Field label="失效时间（可选）"><input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)}/></Field></div>
            <div className="grid two"><Field label="币种"><input required maxLength={3} value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())}/></Field><Field label="舍入模式"><select value={roundingMode} onChange={event => setRoundingMode(event.target.value as PlatformPriceVersionRegistrationInput['roundingMode'])}><option value="half_even">half_even</option><option value="half_up">half_up</option><option value="floor">floor</option><option value="ceil">ceil</option></select></Field></div>
            <div className="grid three"><Field label="商业策略版本"><input required maxLength={128} value={commercialPolicyVersion} onChange={event => setCommercialPolicyVersion(event.target.value)}/></Field><Field label="计算器版本"><input required maxLength={128} value={calculatorVersion} onChange={event => setCalculatorVersion(event.target.value)}/></Field><Field label="舍入规则版本"><input required maxLength={128} value={roundingVersion} onChange={event => setRoundingVersion(event.target.value)}/></Field></div>
            <div className="table-wrap"><table><thead><tr><th>计价项</th><th>分子（最小币种单位）</th><th>分母（单位数）</th></tr></thead><tbody>{(['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'output'] as const).map(metric => <tr key={metric}><th scope="row">{metric}{metric === 'input' || metric === 'output' ? ' · 必填' : ' · 可选'}</th><td><input aria-label={`${metric} 分子`} inputMode="numeric" pattern="(0|[1-9][0-9]{0,18})" required={metric === 'input' || metric === 'output'} value={rates[metric].numerator} onChange={event => changeRate(metric, 'numerator', event.target.value)}/></td><td><input aria-label={`${metric} 分母`} inputMode="numeric" pattern="[1-9][0-9]{0,18}" required={metric === 'input' || metric === 'output'} value={rates[metric].denominator} onChange={event => changeRate(metric, 'denominator', event.target.value)}/></td></tr>)}</tbody></table></div>
            {writeError !== undefined && <PlatformErrorNotice error={writeError} title="价格版本注册失败"/>}
            {writeNotice && <div className="notice" role="status"><strong>已完成</strong><span>{writeNotice}</span></div>}
            <div className="actions"><SaveButton busy={writeBusy}>追加不可变版本</SaveButton></div>
          </form>
        </Panel>
      </>}
    </>}
  </>;
}

function canManageRights(me: MeState): boolean {
  return me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');
}

export function RightsPage({ me }: { me: MeState }) {
  const canWrite = canManageRights(me);
  const [draft, setDraft] = useState<RightsVersionDraft>(() => emptyRightsVersionDraft());
  const [revokeTarget, setRevokeTarget] = useState<{ rightsId: string; version: number }>();
  const [revokeDraft, setRevokeDraft] = useState<PlatformCatalogRightsRevokeInput>({
    approvalReference: '',
    evidenceReference: '',
    evidenceSha256: '',
  });
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<unknown>();
  const [writeNotice, setWriteNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  function updateDraft<K extends keyof RightsVersionDraft>(key: K, value: RightsVersionDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function resetWriteState() {
    setWriteError(undefined);
    setWriteNotice('');
  }

  async function registerVersion(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    resetWriteState();
    const modelScope = parseRightsScopeDraft(draft.modelScope);
    const endpointScope = parseRightsScopeDraft(draft.endpointScope);
    const effectiveAt = localDateTimeToIso(draft.effectiveAt);
    const expiresAt = draft.expiresAt ? localDateTimeToIso(draft.expiresAt) : undefined;
    if (modelScope.error || endpointScope.error) {
      setWriteError(new PlatformApiError(400, 'INVALID_BODY', modelScope.error ?? endpointScope.error ?? 'scope 无效'));
      return;
    }
    if (!effectiveAt || (draft.expiresAt && !expiresAt)) {
      setWriteError(new PlatformApiError(400, 'INVALID_BODY', '有效时间无效'));
      return;
    }
    const input: PlatformCatalogRightsVersionInput = {
      ...(draft.rightsId.trim() ? { rightsId: draft.rightsId.trim() } : {}),
      providerId: draft.providerId.trim(),
      productId: draft.productId.trim(),
      credentialType: draft.credentialType.trim(),
      supplyMode: draft.supplyMode,
      region: draft.region.trim(),
      purpose: draft.purpose.trim(),
      modelScope: modelScope.values ?? [],
      endpointScope: endpointScope.values ?? [],
      effectiveAt,
      ...(expiresAt === undefined ? { expiresAt: null } : { expiresAt }),
      approvalReference: draft.approvalReference.trim(),
      evidenceReference: draft.evidenceReference.trim(),
      evidenceSha256: draft.evidenceSha256.trim(),
      status: draft.status,
    };
    setWriteBusy(true);
    try {
      await platformClient.registerRightsVersion(input);
      setDraft(emptyRightsVersionDraft());
      setWriteNotice('权益新版本已登记；旧版本保持不变。');
      setReloadKey(value => value + 1);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setWriteError(error);
    } finally {
      setWriteBusy(false);
    }
  }

  async function revokeRights(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !revokeTarget) return;
    resetWriteState();
    const effectiveAt = revokeDraft.effectiveAt ? localDateTimeToIso(revokeDraft.effectiveAt) : undefined;
    if (revokeDraft.effectiveAt && !effectiveAt) {
      setWriteError(new PlatformApiError(400, 'INVALID_BODY', '撤销生效时间无效'));
      return;
    }
    const input: PlatformCatalogRightsRevokeInput = {
      approvalReference: revokeDraft.approvalReference.trim(),
      evidenceReference: revokeDraft.evidenceReference.trim(),
      evidenceSha256: revokeDraft.evidenceSha256.trim(),
      ...(effectiveAt === undefined ? {} : { effectiveAt }),
    };
    setWriteBusy(true);
    try {
      await platformClient.revokeRights(revokeTarget.rightsId, input);
      setRevokeTarget(undefined);
      setRevokeDraft({ approvalReference: '', evidenceReference: '', evidenceSha256: '' });
      setWriteNotice(`权益 ${revokeTarget.rightsId} 的撤销版本已登记。`);
      setReloadKey(value => value + 1);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setWriteError(error);
    } finally {
      setWriteBusy(false);
    }
  }

  function selectRevokeTarget(item: PlatformCatalogRights) {
    resetWriteState();
    setRevokeTarget({ rightsId: item.rightsId, version: item.version });
    setRevokeDraft({ approvalReference: '', evidenceReference: '', evidenceSha256: '' });
  }

  return <>
    <div className="page-title"><div><p className="eyebrow">平台目录</p><h1>权益目录</h1><p>查看供应商权益版本、状态、范围和有效期；写入操作只允许登记新版本或追加撤销版本。</p></div></div>
    <div className="notice" role="note"><strong>服务端授权</strong><span>页面只为 operations/superadmin 角色显示写入控件；最终身份、权限、CSRF、版本连续性和审计原子性均由服务端判定。</span></div>
    {canWrite && <>
      <Panel title="登记权益新版本">
        <p className="muted">不会编辑既有版本。填写已有权益 ID 会追加下一个不可变版本；留空会创建新的权益 ID。仅提交审批/证据引用，不提交任何凭证或 Provider 原始 payload。</p>
        <PlatformErrorNotice error={writeError}/>
        {writeNotice && <div className="notice" role="status"><strong>已完成</strong><span>{writeNotice}</span></div>}
        <form onSubmit={registerVersion}>
          <div className="form-grid">
            <Field label="权益 ID（可选）" hint="已有 ID 将追加版本，不会覆盖旧版本。"><input maxLength={200} value={draft.rightsId} onChange={event => updateDraft('rightsId', event.target.value)}/></Field>
            <Field label="Provider ID"><input required maxLength={200} value={draft.providerId} onChange={event => updateDraft('providerId', event.target.value)}/></Field>
            <Field label="Product ID"><input required maxLength={200} value={draft.productId} onChange={event => updateDraft('productId', event.target.value)}/></Field>
            <Field label="Credential type"><input required maxLength={200} value={draft.credentialType} onChange={event => updateDraft('credentialType', event.target.value)}/></Field>
            <Field label="供给模式"><select value={draft.supplyMode} onChange={event => updateDraft('supplyMode', event.target.value as RightsVersionDraft['supplyMode'])}><option value="platform">平台供给</option><option value="byok">BYOK</option></select></Field>
            <Field label="区域"><input required maxLength={200} value={draft.region} onChange={event => updateDraft('region', event.target.value)}/></Field>
            <Field label="用途"><input required maxLength={200} value={draft.purpose} onChange={event => updateDraft('purpose', event.target.value)}/></Field>
            <Field label="版本状态"><select value={draft.status} onChange={event => updateDraft('status', event.target.value as RightsVersionDraft['status'])}><option value="active">生效中</option><option value="draft">草稿</option></select></Field>
            <Field label="生效时间"><input required type="datetime-local" step={1} value={draft.effectiveAt} onChange={event => updateDraft('effectiveAt', event.target.value)}/></Field>
            <Field label="到期时间（可选）"><input type="datetime-local" step={1} value={draft.expiresAt} onChange={event => updateDraft('expiresAt', event.target.value)}/></Field>
            <Field label="审批引用"><input required maxLength={512} value={draft.approvalReference} onChange={event => updateDraft('approvalReference', event.target.value)}/></Field>
            <Field label="证据引用"><input required maxLength={512} value={draft.evidenceReference} onChange={event => updateDraft('evidenceReference', event.target.value)}/></Field>
            <Field label="证据 SHA-256"><input required pattern="[0-9a-f]{64}" maxLength={64} value={draft.evidenceSha256} onChange={event => updateDraft('evidenceSha256', event.target.value)}/></Field>
          </div>
          <div className="form-grid"><Field label="模型范围" hint="每行一个，不能重复或使用 *。"><textarea required rows={3} value={draft.modelScope} onChange={event => updateDraft('modelScope', event.target.value)}/></Field><Field label="端点范围" hint="每行一个，不能重复或使用 *。"><textarea required rows={3} value={draft.endpointScope} onChange={event => updateDraft('endpointScope', event.target.value)}/></Field></div>
          <div className="actions"><SaveButton busy={writeBusy}>登记新版本</SaveButton></div>
        </form>
      </Panel>
      {revokeTarget && <Panel title={`追加撤销版本（${revokeTarget.rightsId} / 当前版本 ${revokeTarget.version}）`}>
        <p className="muted">撤销也会追加不可变版本。服务端会重新读取该权益的最新版本并拒绝重复撤销。</p>
        <form onSubmit={revokeRights}>
          <div className="form-grid">
            <Field label="撤销审批引用"><input required maxLength={512} value={revokeDraft.approvalReference} onChange={event => setRevokeDraft(current => ({ ...current, approvalReference: event.target.value }))}/></Field>
            <Field label="撤销证据引用"><input required maxLength={512} value={revokeDraft.evidenceReference} onChange={event => setRevokeDraft(current => ({ ...current, evidenceReference: event.target.value }))}/></Field>
            <Field label="撤销证据 SHA-256"><input required pattern="[0-9a-f]{64}" maxLength={64} value={revokeDraft.evidenceSha256} onChange={event => setRevokeDraft(current => ({ ...current, evidenceSha256: event.target.value }))}/></Field>
            <Field label="撤销生效时间（可选）"><input type="datetime-local" step={1} value={revokeDraft.effectiveAt ?? ''} onChange={event => setRevokeDraft(current => ({ ...current, effectiveAt: event.target.value }))}/></Field>
          </div>
          <div className="actions"><SaveButton busy={writeBusy}>确认追加撤销版本</SaveButton><button type="button" disabled={writeBusy} onClick={() => setRevokeTarget(undefined)}>取消</button></div>
        </form>
      </Panel>}
    </>}
    {!canWrite && me.kind === 'ready' && <div className="notice" role="note"><strong>当前角色只读</strong><span>只有 operations 或 superadmin 可以登记权益新版本或追加撤销版本；当前角色不会显示写入控件。</span></div>}
    <CatalogPage key={reloadKey} title="权益目录" description="查看供应商权益版本、状态、范围和有效期。" providerFilter loader={loadRightsPage} renderItems={items => <div className="table-wrap"><table><thead><tr><th>权益 ID / 版本</th><th>状态</th><th>供应商 / 产品</th><th>供给模式</th><th>区域 / 用途</th><th>模型范围</th><th>端点范围</th><th>生效时间</th><th>到期时间</th>{canWrite && <th>操作</th>}</tr></thead><tbody>{items.map(item => {
      const status = rightsStatus(item.status);
      return <tr key={`${item.rightsId}:${item.version}`}><td><code>{item.rightsId}</code><small>版本 {item.version}</small></td><td><Badge tone={status.tone}>{status.label}</Badge></td><td><code>{item.providerId}</code><small>{item.productId}</small></td><td>{item.supplyMode === 'byok' ? 'BYOK' : '平台供给'}</td><td>{item.region}<small>{item.purpose}</small></td><td>{item.modelScope.map(scope => <div key={scope}><code>{scope}</code></div>)}</td><td>{item.endpointScope.map(scope => <div key={scope}><code>{scope}</code></div>)}</td><td>{formatDate(item.effectiveAt)}</td><td>{item.expiresAt ? formatDate(item.expiresAt) : '不限期'}</td>{canWrite && <td>{item.status !== 'revoked' && <button type="button" onClick={() => selectRevokeTarget(item)}>追加撤销版本</button>}</td>}</tr>;
    })}</tbody></table></div>}/>
  </>;
}

type AuditFilters = Omit<PlatformAuditPageQuery, 'limit' | 'cursor' | 'signal'>;

function auditLocalTime(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function AuditHistoryPage() {
  const [actorIdDraft, setActorIdDraft] = useState('');
  const [actionDraft, setActionDraft] = useState('');
  const [entityTypeDraft, setEntityTypeDraft] = useState('');
  const [createdFromDraft, setCreatedFromDraft] = useState('');
  const [createdToDraft, setCreatedToDraft] = useState('');
  const [filters, setFilters] = useState<AuditFilters>({});
  const [filterError, setFilterError] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<Array<string | undefined>>([]);
  const [page, setPage] = useState<PlatformAuditEventPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void platformClient.listAuditEvents({
      ...filters,
      limit: 50,
      ...(cursor === undefined ? {} : { cursor }),
      signal: controller.signal,
    }).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(loadError);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [cursor, filters, reloadKey]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    const actorId = actorIdDraft.trim();
    const action = actionDraft.trim();
    const entityType = entityTypeDraft.trim();
    if (actorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId)) {
      setFilterError('操作者 ID 必须是完整 UUID。');
      return;
    }
    if (action && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action)) {
      setFilterError('动作筛选仅支持字母、数字、点、下划线、冒号和连字符，最多 128 个字符。');
      return;
    }
    if (entityType.length > 128 || [...entityType].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) {
      setFilterError('实体类型最多 128 个字符且不能包含控制字符。');
      return;
    }

    const createdFrom = auditLocalTime(createdFromDraft);
    const createdTo = auditLocalTime(createdToDraft);
    if ((createdFromDraft && !createdFrom) || (createdToDraft && !createdTo)) {
      setFilterError('时间范围无效，请重新选择日期和时间。');
      return;
    }
    if (createdFrom && createdTo) {
      const range = Date.parse(createdTo) - Date.parse(createdFrom);
      if (range <= 0) {
        setFilterError('结束时间必须晚于开始时间。');
        return;
      }
      if (range > 366 * 24 * 60 * 60 * 1000) {
        setFilterError('审计查询时间范围最多为 366 天。');
        return;
      }
    }

    setFilterError('');
    setFilters({
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(entityType ? { entityType } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    });
    setCursor(undefined);
    setPreviousCursors([]);
    setReloadKey(value => value + 1);
  }

  function clearFilters() {
    setActorIdDraft('');
    setActionDraft('');
    setEntityTypeDraft('');
    setCreatedFromDraft('');
    setCreatedToDraft('');
    setFilterError('');
    setFilters({});
    setCursor(undefined);
    setPreviousCursors([]);
    setReloadKey(value => value + 1);
  }

  function nextPage() {
    if (!page?.hasMore || !page.nextCursor) return;
    setPreviousCursors(values => [...values, cursor]);
    setCursor(page.nextCursor);
  }

  function previousPage() {
    if (previousCursors.length === 0) return;
    setCursor(previousCursors[previousCursors.length - 1]);
    setPreviousCursors(values => values.slice(0, -1));
  }

  return <><div className="page-title"><div><p className="eyebrow">安全与审计</p><h1>审计历史</h1><p>按操作者、动作、实体类型和时间范围精确筛选平台事件。</p></div></div>
    <div className="notice" role="note"><strong>权限由服务端控制</strong><span>页面导航的角色判断仅用于界面展示；每次审计读取仍由服务端授权，403 表示当前角色未获准访问。</span></div>
    <form className="panel" onSubmit={applyFilters}>
      <div className="panel-head"><h2>筛选条件</h2></div>
      <div className="form-grid">
        <Field label="操作者 ID（精确匹配）"><input value={actorIdDraft} maxLength={36} autoComplete="off" onChange={event => setActorIdDraft(event.target.value)} placeholder="UUID"/></Field>
        <Field label="动作（精确匹配）"><input value={actionDraft} maxLength={128} onChange={event => setActionDraft(event.target.value)} placeholder="动作标识"/></Field>
        <Field label="实体类型（精确匹配）"><input value={entityTypeDraft} maxLength={128} onChange={event => setEntityTypeDraft(event.target.value)} placeholder="实体类型"/></Field>
        <Field label="开始时间（包含）"><input type="datetime-local" step={1} value={createdFromDraft} onChange={event => setCreatedFromDraft(event.target.value)}/></Field>
        <Field label="结束时间（不包含）"><input type="datetime-local" step={1} value={createdToDraft} onChange={event => setCreatedToDraft(event.target.value)}/></Field>
      </div>
      {filterError && <p className="form-error" role="alert">{filterError}</p>}
      <div className="actions"><button className="primary" type="submit">应用筛选</button><button type="button" onClick={clearFilters}>清除筛选</button></div>
    </form>
    <Panel title="审计事件">
      <p className="muted">DECLARED TRUSTED OPERATOR 是外部运维声明引用，不是已验证的平台用户；操作者 ID 筛选仍仅匹配平台用户 UUID。</p>
      {loading && <div className="skeleton" role="status" aria-label="正在加载审计事件"><i/><i/><i/></div>}
      {!loading && error !== undefined && <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="审计历史读取失败"/>}
      {!loading && error === undefined && page?.items.length === 0 && <div className="empty" role="status">当前筛选条件下没有审计事件。</div>}
      {!loading && error === undefined && page && page.items.length > 0 && <div className="table-wrap"><table><thead><tr><th>ID</th><th>操作者</th><th>动作</th><th>实体类型</th><th>实体 ID</th><th>事件时间</th></tr></thead><tbody>{page.items.map(event => <AuditEventRow key={event.id} event={event}/>)}</tbody></table></div>}
      <div className="actions" aria-label="审计事件分页"><button type="button" onClick={previousPage} disabled={loading || previousCursors.length === 0}>上一页</button><span className="muted">第 {previousCursors.length + 1} 页</span><button type="button" onClick={nextPage} disabled={loading || !page?.hasMore || !page.nextCursor}>下一页</button></div>
    </Panel>
  </>;
}

function AuditEventRow({ event }: { event: PlatformAuditEvent }) {
  const attestation = event.actorId === null ? event.operatorAttestation : undefined;
  return <tr><td><code>{event.id}</code></td><td>{event.actorId ? <code>{event.actorId}</code> : attestation ? <div><span>DECLARED TRUSTED OPERATOR</span><div><code>{attestation.operatorId}</code></div><small className="muted">外部声明 · 原因：{attestation.reasonCode} · 结果：{attestation.outcome}</small></div> : '—'}</td><td><code>{event.action}</code></td><td><code>{event.entityType}</code></td><td>{event.entityId ? <code>{event.entityId}</code> : '—'}</td><td>{formatDate(event.occurredAt)}</td></tr>;
}

type SupplyStatus = PlatformSupplyAccount['status'];
type SupplyValidationState = PlatformSupplyAccount['validationState'];

function supplyStatus(value: SupplyStatus): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (value === 'active') return { label: '启用', tone: 'good' };
  if (value === 'disabled') return { label: '已停用', tone: 'bad' };
  if (value === 'revoked') return { label: '已撤销', tone: 'bad' };
  return { label: '待处理', tone: 'warn' };
}

function supplyValidation(value: SupplyValidationState): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (value === 'verified') return { label: '已验证', tone: 'good' };
  if (value === 'failed') return { label: '验证失败', tone: 'bad' };
  return { label: '未验证', tone: 'warn' };
}

function credentialVersionStatus(value: PlatformSupplyCredentialVersion['status']): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (value === 'active') return { label: '活动版本', tone: 'good' };
  if (value === 'revoked') return { label: '已撤销', tone: 'bad' };
  return { label: '已退役', tone: 'warn' };
}

export function parseSupplyCapabilitiesDraft(value: string): { values?: PlatformSupplyCapability[]; error?: string } {
  const values: PlatformSupplyCapability[] = [];
  for (const [index, rawLine] of value.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split('|').map(field => field.trim());
    if (fields.length !== 3 || fields.some(field => field.length === 0)) {
      return { error: `第 ${index + 1} 行必须是 model | endpoint | version。` };
    }
    const version = Number(fields[2]);
    if (!Number.isSafeInteger(version) || version < 1) {
      return { error: `第 ${index + 1} 行的 capability version 必须是正整数。` };
    }
    values.push({ model: fields[0], endpoint: fields[1], version });
  }
  const keys = values.map(value => `${value.model}\u0000${value.endpoint}\u0000${value.version}`);
  if (new Set(keys).size !== keys.length) return { error: 'capabilities 不能重复。' };
  return { values };
}

export function canManageSupply(me: MeState): boolean {
  return me.kind === 'ready' && me.me.roles.some(role => role === 'operations' || role === 'superadmin');
}

interface SupplyAccountDraft {
  displayName: string;
  providerId: string;
  productId: string;
  credentialType: string;
  region: string;
  purpose: string;
  rightsId: string;
  rightsVersion: string;
  capabilities: string;
}

function emptySupplyAccountDraft(): SupplyAccountDraft {
  return {
    displayName: '',
    providerId: '',
    productId: '',
    credentialType: '',
    region: '',
    purpose: '',
    rightsId: '',
    rightsVersion: '1',
    capabilities: '',
  };
}

function SupplyAccountCreateForm({ onCreated }: { onCreated: (account: PlatformSupplyAccount) => void }) {
  const [draft, setDraft] = useState<SupplyAccountDraft>(() => emptySupplyAccountDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');

  function updateDraft<K extends keyof SupplyAccountDraft>(key: K, value: SupplyAccountDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice('');
    const capabilities = parseSupplyCapabilitiesDraft(draft.capabilities);
    const rightsVersion = Number(draft.rightsVersion);
    const required = [
      draft.displayName,
      draft.providerId,
      draft.productId,
      draft.credentialType,
      draft.region,
      draft.purpose,
      draft.rightsId,
    ];
    if (required.some(value => value.trim() === '')) {
      setError(new PlatformApiError(400, 'INVALID_BODY', '请填写完整的供给账号元数据。'));
      return;
    }
    if (!Number.isSafeInteger(rightsVersion) || rightsVersion < 1) {
      setError(new PlatformApiError(400, 'INVALID_BODY', '权益版本必须是正整数。'));
      return;
    }
    if (capabilities.error) {
      setError(new PlatformApiError(400, 'INVALID_BODY', capabilities.error));
      return;
    }
    const input: PlatformSupplyAccountCreateInput = {
      displayName: draft.displayName.trim(),
      providerId: draft.providerId.trim(),
      productId: draft.productId.trim(),
      credentialType: draft.credentialType.trim(),
      region: draft.region.trim(),
      purpose: draft.purpose.trim(),
      rightsId: draft.rightsId.trim(),
      rightsVersion,
      capabilities: capabilities.values ?? [],
    };
    setBusy(true);
    try {
      const account = await platformClient.createSupplyAccount(input);
      setDraft(emptySupplyAccountDraft());
      setNotice('平台供给账号已创建；所有者固定为 platform。');
      onCreated(account);
    } catch (submitError) {
      if (submitError instanceof PlatformApiError && submitError.status === 401) clearPlatformCsrfToken();
      setError(submitError);
    } finally {
      setBusy(false);
    }
  }

  return <Panel title="创建平台供给账号">
    <p className="muted">账号所有者和供给模式固定为 platform，页面不会提供租户或其他 owner 选择。账号只是供给边界；提交凭证后仍须由隔离验证 worker 进行 live validation。</p>
    <PlatformErrorNotice error={error}/>
    {notice && <div className="notice" role="status"><strong>已完成</strong><span>{notice}</span></div>}
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="显示名称"><input required maxLength={256} value={draft.displayName} onChange={event => updateDraft('displayName', event.target.value)}/></Field>
        <Field label="Provider ID"><input required maxLength={256} value={draft.providerId} onChange={event => updateDraft('providerId', event.target.value)}/></Field>
        <Field label="Product ID"><input required maxLength={256} value={draft.productId} onChange={event => updateDraft('productId', event.target.value)}/></Field>
        <Field label="Credential type"><input required maxLength={256} value={draft.credentialType} onChange={event => updateDraft('credentialType', event.target.value)}/></Field>
        <Field label="区域"><input required maxLength={256} value={draft.region} onChange={event => updateDraft('region', event.target.value)}/></Field>
        <Field label="用途"><input required maxLength={256} value={draft.purpose} onChange={event => updateDraft('purpose', event.target.value)}/></Field>
        <Field label="权益 ID"><input required maxLength={256} value={draft.rightsId} onChange={event => updateDraft('rightsId', event.target.value)}/></Field>
        <Field label="权益版本"><input required min={1} step={1} type="number" value={draft.rightsVersion} onChange={event => updateDraft('rightsVersion', event.target.value)}/></Field>
      </div>
      <Field label="Capabilities（可选）" hint="每行填写 model | endpoint | version；版本必须对应能力目录，不会自动扩大授权范围。"><textarea rows={4} spellCheck={false} value={draft.capabilities} onChange={event => updateDraft('capabilities', event.target.value)}/></Field>
      <div className="actions"><SaveButton busy={busy}>创建平台供给账号</SaveButton></div>
    </form>
  </Panel>;
}

type SupplyActionTarget = {
  resource: 'account' | 'credential';
  id: string;
  label: string;
  action: PlatformSupplyLifecycleAction;
  expectedAuthzVersion: number;
};

function supplyActionLabel(action: PlatformSupplyLifecycleAction): string {
  if (action === 'enable') return '启用';
  if (action === 'disable') return '停用';
  return '撤销';
}

function SupplyAccountRow({
  account,
  selected,
  canWrite,
  busyKey,
  onSelect,
  onAction,
  onRevoke,
}: {
  account: PlatformSupplyAccount;
  selected: boolean;
  canWrite: boolean;
  busyKey?: string;
  onSelect: () => void;
  onAction: (target: SupplyActionTarget) => void;
  onRevoke: (target: SupplyActionTarget) => void;
}) {
  const status = supplyStatus(account.status);
  const validation = supplyValidation(account.validationState);
  const action = (next: PlatformSupplyLifecycleAction): SupplyActionTarget => ({
    resource: 'account',
    id: account.id,
    label: `账号 ${account.displayName}`,
    action: next,
    expectedAuthzVersion: account.authzVersion,
  });

  return <tr>
    <td><strong>{account.displayName}</strong><small><code>{account.id}</code></small></td>
    <td><code>{account.providerId}</code><small>{account.productId}</small></td>
    <td>{account.credentialType}<small>{account.region} · {account.purpose}</small></td>
    <td><Badge tone={status.tone}>{status.label}</Badge><small>authz v{account.authzVersion}</small></td>
    <td><Badge tone={validation.tone}>{validation.label}</Badge><small>{account.capabilities.length} 个 capability</small></td>
    <td><button type="button" onClick={onSelect}>{selected ? '收起凭证' : '查看凭证'}</button>{canWrite && <div className="actions">
      {account.status === 'disabled' && <button type="button" disabled={busyKey !== undefined} onClick={() => onAction(action('enable'))}>启用</button>}
      {(account.status === 'pending' || account.status === 'active') && <button type="button" disabled={busyKey !== undefined} onClick={() => onAction(action('disable'))}>停用</button>}
      {account.status !== 'revoked' && <button type="button" disabled={busyKey !== undefined} onClick={() => onRevoke(action('revoke'))}>撤销</button>}
    </div>}</td>
  </tr>;
}

function SupplyCredentialVersionList({ versions }: { versions?: PlatformSupplyCredentialVersion[] }) {
  if (!versions || versions.length === 0) return <span className="muted">暂无历史版本元数据</span>;
  return <div>{versions.map(version => {
    const status = credentialVersionStatus(version.status);
    return <div key={`${version.credentialId}:${version.version}`}><code>v{version.version}</code> <Badge tone={status.tone}>{status.label}</Badge><small>{formatDate(version.createdAt)}</small></div>;
  })}</div>;
}

type RewrapControlState = 'loading' | 'unavailable' | 'ready' | 'already_current' | 'not_eligible' | 'pending' | 'unknown' | 'succeeded' | 'conflict' | 'error';

function SupplyCredentialRewrapControl({
  accountId,
  credential,
}: {
  accountId: string;
  credential: PlatformSupplyCredential;
}) {
  const [status, setStatus] = useState<PlatformSupplyCredentialWrappingStatus>();
  const [state, setState] = useState<RewrapControlState>('loading');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const frozenRef = useRef(false);
  const eligible = credential.status === 'active' && credential.currentVersion !== null;

  useEffect(() => {
    if (!eligible) {
      setState('not_eligible');
      return;
    }
    const controller = new AbortController();
    if (!frozenRef.current) setState('loading');
    void platformClient.getSupplyCredentialWrappingStatus(accountId, credential.id, { signal: controller.signal })
      .then(current => {
        if (controller.signal.aborted) return;
        const wasFrozen = frozenRef.current;
        frozenRef.current = false;
        setStatus(current);
        setState(current.state);
        setNotice(wasFrozen || reloadKey > 0
          ? `状态已刷新；当前凭证 v${current.credentialVersion ?? '—'}，wrapping revision ${current.wrappingRevision ?? '—'}。`
          : '');
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        const unavailable = error instanceof PlatformApiError &&
          ((error.status === 404 && error.code === 'NOT_FOUND') || error.status === 405 || error.status === 501);
        if (unavailable) {
          setState('unavailable');
          setNotice('本部署未配置专用 ReEncrypt-only KMS capability；重封装不可用。');
        } else if (frozenRef.current) {
          setState('unknown');
          setNotice('无法确认最新 revision；操作保持冻结。请稍后刷新状态，勿直接重试。');
        } else {
          setState('error');
          setNotice('无法读取重封装状态；请刷新后再操作。');
        }
      });
    return () => controller.abort();
  }, [accountId, credential.id, eligible, reloadKey]);

  async function rewrap() {
    if (!status || status.state !== 'ready' || status.credentialVersion === null ||
      status.credentialVersion !== credential.currentVersion ||
      status.wrappingRevision === null || frozenRef.current) return;
    const confirmed = window.confirm(
      `确认将平台凭证 ${credential.id}（v${status.credentialVersion}，wrapping revision ${status.wrappingRevision}）的 wrapped DEK 重封装到部署当前 KMS key？不会更改 Provider Secret 或 Secret 版本。`,
    );
    if (!confirmed) return;
    frozenRef.current = true;
    setState('pending');
    setNotice('重封装请求处理中；请勿重复提交。');
    try {
      const result = await platformClient.rewrapSupplyCredential(accountId, credential.id, {
        expectedVersion: status.credentialVersion,
        expectedWrappingRevision: status.wrappingRevision,
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.state === 'succeeded') {
        frozenRef.current = true;
        setStatus({
          state: 'already_current',
          credentialVersion: result.credentialVersion,
          wrappingRevision: result.wrappingRevision,
        });
        setState('succeeded');
        setNotice(`重封装已提交；当前凭证 v${result.credentialVersion}，wrapping revision ${result.wrappingRevision ?? '—'}。刷新状态以核对。`);
      } else if (result.state === 'unknown') {
        frozenRef.current = true;
        setState('unknown');
        setNotice('结果未知，操作已冻结。先刷新并核对当前 CAS revision；不要盲目重试。');
      } else if (result.state === 'conflict') {
        frozenRef.current = true;
        setState('conflict');
        setNotice('凭证版本或 wrapping revision 已变化；先刷新当前状态，再决定是否重新操作。');
      } else {
        frozenRef.current = true;
        setState('error');
        setNotice('重封装未能确认完成；先刷新当前状态，勿直接重试。');
      }
    } catch {
      frozenRef.current = true;
      setState('unknown');
      setNotice('响应未能确认；结果未知，先刷新并核对当前 CAS revision，不要盲目重试。');
    }
  }

  function refresh() {
    setNotice('正在刷新当前版本与 wrapping revision…');
    setReloadKey(value => value + 1);
  }

  if (!eligible && state === 'not_eligible') return null;
  const stateLabels: Record<RewrapControlState, string> = {
    loading: '读取中',
    unavailable: '不可用',
    ready: '待重封装',
    already_current: '已是当前 Key',
    not_eligible: '不符合条件',
    pending: '处理中',
    unknown: '结果未知 / 已冻结',
    succeeded: '已成功',
    conflict: 'CAS 冲突',
    error: '错误 / 已冻结',
  };
  return <div className="rewrap-control" aria-live="polite">
    <small>重封装：{stateLabels[state]} · 当前 revision {status?.wrappingRevision ?? '—'}</small>
    {notice && <small>{notice}</small>}
    {state === 'ready' && status?.credentialVersion !== null &&
      status?.credentialVersion === credential.currentVersion && status.wrappingRevision !== null &&
      <button type="button" onClick={() => void rewrap()}>重封装 wrapped DEK</button>}
    {(state === 'unknown' || state === 'conflict' || state === 'error' || state === 'succeeded') &&
      <button type="button" onClick={refresh}>刷新 / 核对 revision</button>}
  </div>;
}

function SupplyCredentialRow({
  credential,
  canWrite,
  busyKey,
  onRotate,
  onAction,
  onRevoke,
  accountId,
}: {
  accountId: string;
  credential: PlatformSupplyCredential;
  canWrite: boolean;
  busyKey?: string;
  onRotate: () => void;
  onAction: (target: SupplyActionTarget) => void;
  onRevoke: (target: SupplyActionTarget) => void;
}) {
  const status = supplyStatus(credential.status);
  const validation = supplyValidation(credential.validationState);
  const action = (next: PlatformSupplyLifecycleAction): SupplyActionTarget => ({
    resource: 'credential',
    id: credential.id,
    label: `凭证 ${credential.id}`,
    action: next,
    expectedAuthzVersion: credential.authzVersion,
  });

  return <tr>
    <td><code>{credential.id}</code><small>{credential.credentialType}</small></td>
    <td><Badge tone={status.tone}>{status.label}</Badge><small>authz v{credential.authzVersion}</small></td>
    <td><Badge tone={validation.tone}>{validation.label}</Badge><small>{credential.lastValidatedAt ? formatDate(credential.lastValidatedAt) : '尚未验证'}</small></td>
    <td>{credential.currentVersion === null ? '暂无当前版本' : <><strong>v{credential.currentVersion}</strong><small><SupplyCredentialVersionList versions={credential.versions}/></small></>}</td>
    <td>{credential.expiresAt ? formatDate(credential.expiresAt) : '不限期'}</td>
    {canWrite && <td><div className="actions">
      {credential.status === 'disabled' && <button type="button" disabled={busyKey !== undefined} onClick={() => onAction(action('enable'))}>启用</button>}
      {(credential.status === 'pending' || credential.status === 'active') && <button type="button" disabled={busyKey !== undefined} onClick={() => onAction(action('disable'))}>停用</button>}
      {credential.status !== 'revoked' && <button type="button" disabled={busyKey !== undefined} onClick={() => onRevoke(action('revoke'))}>撤销</button>}
      {(credential.status === 'pending' || credential.status === 'active') && <button type="button" disabled={busyKey !== undefined} onClick={onRotate}>轮换</button>}
    </div>{credential.status === 'active' && credential.currentVersion !== null &&
      <SupplyCredentialRewrapControl accountId={accountId} credential={credential}/>}</td>}
  </tr>;
}

export function SupplyCredentialWriteForm({
  accountId,
  credential,
  onChanged,
  onCancel,
}: {
  accountId: string;
  credential?: PlatformSupplyCredential;
  onChanged: () => void;
  onCancel?: () => void;
}) {
  const [secret, setSecret] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');

  function clearSecret() {
    setSecret('');
  }

  function cancel() {
    clearSecret();
    setExpiresAt('');
    setError(undefined);
    setNotice('');
    onCancel?.();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice('');
    let submittedSecret = secret;
    clearSecret();
    if (submittedSecret.length === 0) {
      submittedSecret = '';
      setError(new PlatformApiError(400, 'INVALID_BODY', '请输入凭证 Secret。'));
      return;
    }
    const expiresAtIso = expiresAt ? localDateTimeToIso(expiresAt) : undefined;
    if (expiresAt && !expiresAtIso) {
      submittedSecret = '';
      setError(new PlatformApiError(400, 'INVALID_BODY', '到期时间无效。'));
      return;
    }
    setBusy(true);
    try {
      if (credential) {
        const input: PlatformSupplyCredentialRotationInput = {
          expectedVersion: credential.currentVersion,
          secret: submittedSecret,
          ...(expiresAtIso === undefined ? {} : { expiresAt: expiresAtIso }),
        };
        await platformClient.rotateSupplyCredentialSecret(credential.id, input);
      } else {
        await platformClient.createSupplyCredential(accountId, {
          secret: submittedSecret,
          ...(expiresAtIso === undefined ? {} : { expiresAt: expiresAtIso }),
        });
      }
      setExpiresAt('');
      setNotice('凭证已提交；Secret 不会再次显示。新的凭证由隔离验证 worker 执行 live validation，在验证完成前保持 pending / unverified。');
      onChanged();
    } catch (submitError) {
      if (submitError instanceof PlatformApiError && submitError.status === 401) clearPlatformCsrfToken();
      setError(submitError);
    } finally {
      submittedSecret = '';
      clearSecret();
      setBusy(false);
    }
  }

  return <>
    <PlatformErrorNotice error={error}/>
    {notice && <div className="notice" role="status"><strong>已提交</strong><span>{notice}</span></div>}
    <form onSubmit={submit}>
      <Field label={credential ? `轮换 Secret（当前 v${credential.currentVersion ?? '—'}）` : '初始 Secret'} hint="仅在本次提交期间使用；提交或取消后立即清除，不会写入浏览器存储、日志或分析事件。">
        <input required type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)}/>
      </Field>
      <Field label="到期时间（可选）"><input type="datetime-local" step={1} value={expiresAt} onChange={event => setExpiresAt(event.target.value)}/></Field>
      <div className="actions"><SaveButton busy={busy}>{credential ? '提交凭证轮换' : '添加初始凭证'}</SaveButton><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
    </form>
  </>;
}

function SupplyCredentialsPanel({
  account,
  canWrite,
  busyKey,
  onAction,
  onRevoke,
  onChanged,
}: {
  account: PlatformSupplyAccount;
  canWrite: boolean;
  busyKey?: string;
  onAction: (target: SupplyActionTarget) => void;
  onRevoke: (target: SupplyActionTarget) => void;
  onChanged: () => void;
}) {
  const [credentials, setCredentials] = useState<PlatformSupplyCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [rotationCredentialId, setRotationCredentialId] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void platformClient.listSupplyCredentials(account.id, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setCredentials(result);
    }).catch(loadError => {
      if (!controller.signal.aborted) setError(loadError);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [account.id, reloadKey]);

  function refreshCredentials() {
    setRotationCredentialId(undefined);
    setReloadKey(value => value + 1);
    onChanged();
  }

  const rotationCredential = credentials.find(credential => credential.id === rotationCredentialId);
  return <Panel title={`平台凭证 · ${account.displayName}`}>
    <p className="muted">只显示状态、验证状态、授权版本和凭证版本元数据；任何 Secret 或 envelope 都不会从管理接口返回。live validation 委托给隔离 worker。</p>
    {canWrite && !loading && error === undefined && credentials.length === 0 && (account.status === 'pending' || account.status === 'active') && <Panel title="添加初始凭证"><SupplyCredentialWriteForm key="initial" accountId={account.id} onChanged={refreshCredentials}/></Panel>}
    {canWrite && rotationCredential && (rotationCredential.status === 'pending' || rotationCredential.status === 'active') && account.status !== 'revoked' && <Panel title={`轮换凭证 · ${rotationCredential.id}`}><SupplyCredentialWriteForm key={rotationCredential.id} accountId={account.id} credential={rotationCredential} onChanged={refreshCredentials} onCancel={() => setRotationCredentialId(undefined)}/></Panel>}
    {loading && <div className="skeleton" role="status" aria-label="正在加载供给凭证"><i/><i/><i/></div>}
    {!loading && error !== undefined && <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="凭证读取失败"/>}
    {!loading && error === undefined && credentials.length === 0 && <div className="empty" role="status">当前账号没有凭证元数据。</div>}
    {!loading && error === undefined && credentials.length > 0 && <div className="table-wrap"><table><thead><tr><th>凭证 ID / 类型</th><th>状态</th><th>验证状态</th><th>当前 / 历史版本</th><th>到期时间</th>{canWrite && <th>操作</th>}</tr></thead><tbody>{credentials.map(credential => <SupplyCredentialRow key={credential.id} accountId={account.id} credential={credential} canWrite={canWrite} busyKey={busyKey} onRotate={() => setRotationCredentialId(credential.id)} onAction={onAction} onRevoke={onRevoke}/>)}</tbody></table></div>}
  </Panel>;
}

export function SupplyAccountsPage({ me }: { me: MeState }) {
  const canWrite = canManageSupply(me);
  const [accounts, setAccounts] = useState<PlatformSupplyAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [busyKey, setBusyKey] = useState<string>();
  const [revokeConfirmation, setRevokeConfirmation] = useState<SupplyActionTarget>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void platformClient.listSupplyAccounts({ signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) {
        setAccounts(result);
        setSelectedAccountId(current => current && result.some(account => account.id === current) ? current : undefined);
      }
    }).catch(loadError => {
      if (!controller.signal.aborted) setError(loadError);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reloadKey]);

  function accountChanged(account: PlatformSupplyAccount) {
    setSelectedAccountId(account.id);
    setNotice('平台供给账号已创建；现在可展开账号并添加初始凭证。');
    setReloadKey(value => value + 1);
  }

  function actionKey(target: SupplyActionTarget): string {
    return `${target.resource}:${target.id}:${target.action}`;
  }

  async function executeAction(target: SupplyActionTarget) {
    if (!canWrite) return;
    setActionError(undefined);
    setNotice('');
    setBusyKey(actionKey(target));
    try {
      if (target.resource === 'account') {
        await platformClient.setSupplyAccountLifecycle(target.id, target.action, { expectedAuthzVersion: target.expectedAuthzVersion });
      } else {
        await platformClient.setSupplyCredentialLifecycle(target.id, target.action, { expectedAuthzVersion: target.expectedAuthzVersion });
      }
      setNotice(`${target.label}已${supplyActionLabel(target.action)}；页面已按新的服务端状态刷新。`);
      setRevokeConfirmation(undefined);
      setReloadKey(value => value + 1);
    } catch (actionFailure) {
      if (actionFailure instanceof PlatformApiError && actionFailure.status === 401) clearPlatformCsrfToken();
      setActionError(actionFailure);
    } finally {
      setBusyKey(undefined);
    }
  }

  function requestAction(target: SupplyActionTarget) {
    if (target.action === 'revoke') {
      setRevokeConfirmation(target);
      setActionError(undefined);
      return;
    }
    void executeAction(target);
  }

  const selectedAccount = accounts.find(account => account.id === selectedAccountId);
  return <>
    <div className="page-title"><div><p className="eyebrow">平台供给</p><h1>供应账号与凭证</h1><p>管理平台-owned Provider 账号、凭证生命周期和脱敏版本元数据。</p></div></div>
    <div className="notice" role="note"><strong>隔离验证与 write-only 凭证</strong><span>凭证 Secret 只写入一次，不会回显、复制、持久化或进入日志/分析；live validation 委托给隔离 worker，新凭证在验证完成前保持 pending / unverified。</span></div>
    {!canWrite && me.kind === 'ready' && <div className="notice" role="note"><strong>当前角色只读</strong><span>当前平台角色可以查看服务端允许返回的供给元数据，但不会显示写入控件。</span></div>}
    {canWrite && <SupplyAccountCreateForm onCreated={accountChanged}/>} 
    {actionError !== undefined && <PlatformErrorNotice error={actionError} title="供给操作失败"/>}
    {notice && <div className="notice" role="status"><strong>状态更新</strong><span>{notice}</span></div>}
    {revokeConfirmation && <Panel title="确认撤销"><div className="notice error" role="alert"><strong>此操作不可恢复</strong><span>确认撤销{revokeConfirmation.label}？撤销会使服务端授权立即失效，并且需要使用新的账号或凭证。</span></div><div className="actions"><button className="primary" type="button" disabled={busyKey !== undefined} onClick={() => void executeAction(revokeConfirmation)}>确认撤销</button><button type="button" disabled={busyKey !== undefined} onClick={() => setRevokeConfirmation(undefined)}>取消</button></div></Panel>}
    <Panel title="平台供给账号">
      {loading && <div className="skeleton" role="status" aria-label="正在加载供给账号"><i/><i/><i/></div>}
      {!loading && error !== undefined && <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="供给账号读取失败"/>}
      {!loading && error === undefined && accounts.length === 0 && <div className="empty" role="status">当前没有平台供给账号。</div>}
      {!loading && error === undefined && accounts.length > 0 && <div className="table-wrap"><table><thead><tr><th>账号</th><th>供应商 / 产品</th><th>凭证边界</th><th>生命周期</th><th>验证</th><th>查看 / 操作</th></tr></thead><tbody>{accounts.map(account => <SupplyAccountRow key={account.id} account={account} selected={account.id === selectedAccountId} canWrite={canWrite} busyKey={busyKey} onSelect={() => setSelectedAccountId(current => current === account.id ? undefined : account.id)} onAction={requestAction} onRevoke={requestAction}/>)}</tbody></table></div>}
    </Panel>
    {selectedAccount && <SupplyCredentialsPanel account={selectedAccount} canWrite={canWrite} busyKey={busyKey} onAction={requestAction} onRevoke={requestAction} onChanged={() => setReloadKey(value => value + 1)}/>} 
  </>;
}

const capacityReasonLabels: Record<PlatformCapacityPolicyReason, string> = {
  initial_provisioning: '初始配置',
  customer_request: '客户申请',
  capacity_adjustment: '容量调整',
  incident_response: '故障处置',
  risk_control: '风险控制',
  data_correction: '数据修正',
};

function capacityPolicyTargetFromSelection(
  scope: PlatformCapacityPolicyScope,
  tenantId: string,
  projectId: string,
  apiKeyId: string,
): PlatformCapacityPolicyTarget | undefined {
  if (tenantId.trim() === '') return undefined;
  if (scope === 'tenant') return { scope, tenantId };
  if (projectId.trim() === '') return undefined;
  if (scope === 'project') return { scope, tenantId, projectId };
  if (apiKeyId.trim() === '') return undefined;
  return { scope, tenantId, projectId, apiKeyId };
}

function sameCapacityTarget(left: PlatformCapacityPolicyTarget, right: PlatformCapacityPolicyTarget): boolean {
  return (
    left.scope === right.scope &&
    left.tenantId.toLowerCase() === right.tenantId.toLowerCase() &&
    (left.scope === 'tenant' ||
      (right.scope !== 'tenant' &&
        left.projectId.toLowerCase() === right.projectId.toLowerCase() &&
        (left.scope !== 'api_key' || (right.scope === 'api_key' && left.apiKeyId.toLowerCase() === right.apiKeyId.toLowerCase()))))
  );
}

function policyDraft(limits: PlatformCapacityPolicyLimits | null) {
  return {
    requestsPerMinute: limits === null ? '' : String(limits.requestsPerMinute),
    tokensPerMinute: limits === null ? '' : String(limits.tokensPerMinute),
    maxConcurrentRequests: limits === null ? '' : String(limits.maxConcurrentRequests),
  };
}

export function CapacityPolicyPage({ me }: { me: MeState }) {
  const canManage = canManageSupply(me);
  const [scope, setScope] = useState<PlatformCapacityPolicyScope>('tenant');
  const [tenantId, setTenantId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [apiKeyId, setApiKeyId] = useState('');
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [apiKeyIds, setApiKeyIds] = useState<string[]>([]);
  const [tenantCursor, setTenantCursor] = useState<string | null>(null);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [apiKeyCursor, setApiKeyCursor] = useState<string | null>(null);
  const [tenantListLoaded, setTenantListLoaded] = useState(false);
  const [projectListLoaded, setProjectListLoaded] = useState(false);
  const [apiKeyListLoaded, setApiKeyListLoaded] = useState(false);
  const [tenantListLoading, setTenantListLoading] = useState(false);
  const [projectListLoading, setProjectListLoading] = useState(false);
  const [apiKeyListLoading, setApiKeyListLoading] = useState(false);
  const [tenantListError, setTenantListError] = useState<unknown>();
  const [projectListError, setProjectListError] = useState<unknown>();
  const [apiKeyListError, setApiKeyListError] = useState<unknown>();
  const [loadedTarget, setLoadedTarget] = useState<PlatformCapacityPolicyTarget>();
  const [policy, setPolicy] = useState<PlatformCapacityPolicy>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<unknown>();
  const [writeError, setWriteError] = useState<unknown>();
  const [success, setSuccess] = useState('');
  const [expectedRevision, setExpectedRevision] = useState('');
  const [draft, setDraft] = useState(policyDraft(null));
  const [reason, setReason] = useState<PlatformCapacityPolicyReason>('capacity_adjustment');
  const [validationError, setValidationError] = useState('');

  function clearLoadedPolicy() {
    setLoadedTarget(undefined);
    setPolicy(undefined);
    setReadError(undefined);
    setWriteError(undefined);
    setSuccess('');
    setValidationError('');
  }

  async function loadTenantIds(append = false) {
    setTenantListLoading(true);
    setTenantListError(undefined);
    try {
      const page = await platformClient.listCapacityPolicyTenants(append ? tenantCursor ?? undefined : undefined);
      const ids = page.items.map(item => item.id);
      setTenantIds(current => append ? [...current, ...ids] : ids);
      setTenantCursor(page.nextCursor);
      setTenantListLoaded(true);
      if (!append && tenantId && !ids.includes(tenantId)) {
        setTenantId('');
        setProjectId('');
        setApiKeyId('');
        setProjectIds([]);
        setApiKeyIds([]);
        setProjectCursor(null);
        setApiKeyCursor(null);
        setProjectListLoaded(false);
        setApiKeyListLoaded(false);
        clearLoadedPolicy();
      }
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setTenantListError(error);
    } finally {
      setTenantListLoading(false);
    }
  }

  async function loadProjectIds(append = false) {
    if (!tenantId) return;
    setProjectListLoading(true);
    setProjectListError(undefined);
    try {
      const page = await platformClient.listCapacityPolicyProjects(
        tenantId,
        append ? projectCursor ?? undefined : undefined,
      );
      const ids = page.items.map(item => item.id);
      setProjectIds(current => append ? [...current, ...ids] : ids);
      setProjectCursor(page.nextCursor);
      setProjectListLoaded(true);
      if (!append && projectId && !ids.includes(projectId)) {
        setProjectId('');
        setApiKeyId('');
        setApiKeyIds([]);
        setApiKeyCursor(null);
        setApiKeyListLoaded(false);
        clearLoadedPolicy();
      }
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setProjectListError(error);
    } finally {
      setProjectListLoading(false);
    }
  }

  async function loadApiKeyIds(append = false) {
    if (!tenantId || !projectId) return;
    setApiKeyListLoading(true);
    setApiKeyListError(undefined);
    try {
      const page = await platformClient.listCapacityPolicyApiKeys(
        tenantId,
        projectId,
        append ? apiKeyCursor ?? undefined : undefined,
      );
      const ids = page.items.map(item => item.id);
      setApiKeyIds(current => append ? [...current, ...ids] : ids);
      setApiKeyCursor(page.nextCursor);
      setApiKeyListLoaded(true);
      if (!append && apiKeyId && !ids.includes(apiKeyId)) {
        setApiKeyId('');
        clearLoadedPolicy();
      }
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setApiKeyListError(error);
    } finally {
      setApiKeyListLoading(false);
    }
  }

  function selectTenant(value: string) {
    clearLoadedPolicy();
    setTenantId(value);
    setProjectId('');
    setApiKeyId('');
    setProjectIds([]);
    setApiKeyIds([]);
    setProjectCursor(null);
    setApiKeyCursor(null);
    setProjectListLoaded(false);
    setApiKeyListLoaded(false);
    setProjectListError(undefined);
    setApiKeyListError(undefined);
  }

  function selectProject(value: string) {
    clearLoadedPolicy();
    setProjectId(value);
    setApiKeyId('');
    setApiKeyIds([]);
    setApiKeyCursor(null);
    setApiKeyListLoaded(false);
    setApiKeyListError(undefined);
  }

  async function loadPolicy(target: PlatformCapacityPolicyTarget) {
    setLoading(true);
    setReadError(undefined);
    setWriteError(undefined);
    setSuccess('');
    try {
      const current = await platformClient.getCapacityPolicy(target);
      setPolicy(current);
      setLoadedTarget(target);
      setExpectedRevision(current.revision);
      setDraft(policyDraft(current.limits));
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setPolicy(undefined);
      setLoadedTarget(undefined);
      setReadError(error);
    } finally {
      setLoading(false);
    }
  }

  function lookup(event: FormEvent) {
    event.preventDefault();
    const target = capacityPolicyTargetFromSelection(scope, tenantId, projectId, apiKeyId);
    clearLoadedPolicy();
    if (!target) {
      setReadError(new PlatformApiError(400, 'INVALID_POLICY_TARGET', '请先从授权列表中选择所需范围的目标。'));
      return;
    }
    void loadPolicy(target);
  }

  async function update(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !loadedTarget || !policy) return;
    const selectedTarget = capacityPolicyTargetFromSelection(scope, tenantId, projectId, apiKeyId);
    if (!selectedTarget || !sameCapacityTarget(loadedTarget, selectedTarget)) {
      setValidationError('策略目标已变化，请重新读取该目标的策略。');
      return;
    }
    const limits = {
      requestsPerMinute: Number(draft.requestsPerMinute),
      tokensPerMinute: Number(draft.tokensPerMinute),
      maxConcurrentRequests: Number(draft.maxConcurrentRequests),
    };
    if (
      !Object.values(limits).every(value => Number.isSafeInteger(value) && value >= 1) ||
      limits.maxConcurrentRequests > 2_147_483_647
    ) {
      setValidationError('三个限制都必须是正整数；并发上限不能超过 2147483647。');
      return;
    }
    setBusy(true);
    setWriteError(undefined);
    setValidationError('');
    setSuccess('');
    try {
      const updated = await platformClient.updateCapacityPolicy(loadedTarget, { expectedRevision, limits, reason });
      setPolicy(updated);
      setExpectedRevision(updated.revision);
      setDraft(policyDraft(updated.limits));
      setSuccess(`保存成功，当前策略版本为 ${updated.revision}。`);
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) clearPlatformCsrfToken();
      setWriteError(error);
    } finally {
      setBusy(false);
    }
  }

  const revisionConflict =
    writeError instanceof PlatformApiError && writeError.status === 409 && writeError.code === 'CAS_CONFLICT';
  const targetBusy = loading || busy || tenantListLoading || projectListLoading || apiKeyListLoading;

  return <>
    <div className="page-title"><div><p className="eyebrow">请求准入</p><h1>容量策略</h1><p>按租户、项目或 API key 设置请求速率、Token 速率和并发上限。每次更新都以当前 revision 做 CAS，并记录固定原因码。</p></div></div>
    {!canManage && <div className="notice" role="note"><strong>仅运营管理员可用</strong><span>读取和更新容量策略需要 operations 或 superadmin 角色；服务端会再次校验当前会话和角色。</span></div>}
    {canManage && <>
      <Panel title="选择策略目标">
        <form onSubmit={lookup}>
          <Field label="策略范围"><select aria-label="策略范围" value={scope} disabled={targetBusy} onChange={event => { clearLoadedPolicy(); setScope(event.target.value as PlatformCapacityPolicyScope); }}><option value="tenant">租户</option><option value="project">项目</option><option value="api_key">API key</option></select></Field>
          <div className="actions"><button type="button" disabled={targetBusy} onClick={() => void loadTenantIds()}>{tenantListLoading ? '正在加载租户…' : tenantListLoaded ? '刷新租户列表' : '加载租户列表'}</button>{tenantCursor && <button type="button" disabled={targetBusy} onClick={() => void loadTenantIds(true)}>加载更多租户</button>}</div>
          {tenantListError !== undefined && <PlatformErrorNotice error={tenantListError} title="租户目标列表读取失败" onRetry={() => void loadTenantIds()}/>}
          {tenantListLoaded && tenantIds.length === 0 && <div className="empty" role="status">当前没有可选择的租户。</div>}
          {tenantIds.length > 0 && <Field label="租户 ID"><select required aria-label="租户 ID" value={tenantId} disabled={targetBusy} onChange={event => selectTenant(event.target.value)}><option value="">请选择租户</option>{tenantIds.map(id => <option key={id} value={id}>{id}</option>)}</select></Field>}
          {scope !== 'tenant' && <>
            <div className="actions"><button type="button" disabled={!tenantId || targetBusy} onClick={() => void loadProjectIds()}>{projectListLoading ? '正在加载项目…' : projectListLoaded ? '刷新项目列表' : '加载项目列表'}</button>{projectCursor && <button type="button" disabled={targetBusy} onClick={() => void loadProjectIds(true)}>加载更多项目</button>}</div>
            {projectListError !== undefined && <PlatformErrorNotice error={projectListError} title="项目目标列表读取失败" onRetry={() => void loadProjectIds()}/>}
            {projectListLoaded && projectIds.length === 0 && <div className="empty" role="status">该租户下没有可选择的项目。</div>}
            {projectIds.length > 0 && <Field label="项目 ID"><select required aria-label="项目 ID" value={projectId} disabled={!tenantId || targetBusy} onChange={event => selectProject(event.target.value)}><option value="">请选择项目</option>{projectIds.map(id => <option key={id} value={id}>{id}</option>)}</select></Field>}
          </>}
          {scope === 'api_key' && <>
            <div className="actions"><button type="button" disabled={!tenantId || !projectId || targetBusy} onClick={() => void loadApiKeyIds()}>{apiKeyListLoading ? '正在加载 API key…' : apiKeyListLoaded ? '刷新 API key 列表' : '加载 API key 列表'}</button>{apiKeyCursor && <button type="button" disabled={targetBusy} onClick={() => void loadApiKeyIds(true)}>加载更多 API key</button>}</div>
            {apiKeyListError !== undefined && <PlatformErrorNotice error={apiKeyListError} title="API key 目标列表读取失败" onRetry={() => void loadApiKeyIds()}/>}
            {apiKeyListLoaded && apiKeyIds.length === 0 && <div className="empty" role="status">该项目下没有可选择的 API key。</div>}
            {apiKeyIds.length > 0 && <Field label="API key ID"><select required aria-label="API key ID" value={apiKeyId} disabled={!tenantId || !projectId || targetBusy} onChange={event => { clearLoadedPolicy(); setApiKeyId(event.target.value); }}><option value="">请选择 API key</option>{apiKeyIds.map(id => <option key={id} value={id}>{id}</option>)}</select></Field>}
          </>}
          <p className="muted">选择器只显示 UUID；项目和 API key 列表按所选父级限定。API key Secret 不会读取或显示。</p>
          <div className="actions"><button className="primary" type="submit" disabled={targetBusy}>{loading ? '正在读取…' : '读取当前策略'}</button></div>
        </form>
        {readError !== undefined && <PlatformErrorNotice error={readError} title="策略读取失败"/>}
      </Panel>

      {policy && <Panel title="当前策略与版本">
        <div className="summary-list"><div><span>范围</span><span>{policy.scope === 'tenant' ? '租户' : policy.scope === 'project' ? '项目' : 'API key'}</span></div><div><span>目标 ID</span><code>{[policy.tenantId, ...(policy.scope === 'tenant' ? [] : [policy.projectId]), ...(policy.scope === 'api_key' ? [policy.apiKeyId] : [])].join(' / ')}</code></div><div><span>当前 revision</span><code>{policy.revision}</code></div><div><span>revision 来源</span><code>{policy.revisionKind}</code></div><div><span>配置状态</span><span>{policy.configured ? '已配置' : '未配置'}</span></div></div>
        {policy.limits === null ? <div className="notice" role="note"><strong>尚未配置限制值</strong><span>该范围当前没有完整的容量限制；保存新值会按下一 revision 写入。</span></div> : <div className="summary-list"><div><span>请求 / 分钟</span><span>{policy.limits.requestsPerMinute}</span></div><div><span>Token / 分钟</span><span>{policy.limits.tokensPerMinute}</span></div><div><span>最大并发请求</span><span>{policy.limits.maxConcurrentRequests}</span></div></div>}
      </Panel>}

      {policy && loadedTarget && <Panel title="更新容量策略">
        <form onSubmit={event => void update(event)}>
          <Field label="期望 revision" hint="必须与上方当前 revision 一致；服务端以比较并交换方式保护并发修改。"><input required type="text" inputMode="numeric" pattern="[1-9][0-9]*" autoComplete="off" value={expectedRevision} onChange={event => setExpectedRevision(event.target.value)}/></Field>
          <Field label="请求数 / 分钟"><input required type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.requestsPerMinute} onChange={event => setDraft(current => ({ ...current, requestsPerMinute: event.target.value }))}/></Field>
          <Field label="Token 数 / 分钟"><input required type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.tokensPerMinute} onChange={event => setDraft(current => ({ ...current, tokensPerMinute: event.target.value }))}/></Field>
          <Field label="最大并发请求"><input required type="number" min={1} max={2_147_483_647} step={1} value={draft.maxConcurrentRequests} onChange={event => setDraft(current => ({ ...current, maxConcurrentRequests: event.target.value }))}/></Field>
          <Field label="审计原因"><select required value={reason} onChange={event => setReason(event.target.value as PlatformCapacityPolicyReason)}>{PLATFORM_CAPACITY_POLICY_REASONS.map(code => <option key={code} value={code}>{capacityReasonLabels[code]} · {code}</option>)}</select></Field>
          {validationError && <p className="form-error" role="alert">{validationError}</p>}
          {writeError !== undefined && (revisionConflict ? <div className="notice error" role="alert"><strong>版本冲突</strong><span>{platformErrorMessage(writeError)} 当前草稿仍保留；确认目标后可以重新读取并以最新 revision 再编辑。</span><button type="button" disabled={loading || busy} onClick={() => void loadPolicy(loadedTarget)}>重新读取最新版本</button></div> : <PlatformErrorNotice error={writeError} title="策略更新失败"/>)}
          {success && <div className="notice" role="status"><strong>更新完成</strong><span>{success}</span></div>}
          <div className="actions"><SaveButton busy={busy}>保存新 revision</SaveButton></div>
        </form>
      </Panel>}
    </>}
  </>;
}

function ProtectedPlatformRoute({ auth, me, onLogout }: { auth: AuthState; me: MeState; onLogout: () => Promise<void> }) {
  const location = useLocation();
  if (auth.kind === 'checking') return <LoadingPage/>;
  if (auth.kind !== 'signed-in') return <Navigate to="/platform/login" replace state={{ from: safePlatformReturnPath(location.pathname) }}/>;
  return <PlatformShell me={me} onLogout={onLogout}><Outlet/></PlatformShell>;
}

function PlatformIndex({ auth }: { auth: AuthState }) {
  if (auth.kind === 'checking') return <LoadingPage/>;
  return <Navigate to={auth.kind === 'signed-in' ? '/platform/overview' : '/platform/login'} replace/>;
}

export function SaasPlatformApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const { auth, me, sessionError, signIn, signOut, reloadMe } = usePlatformSession();
  const loginReturnPath = safePlatformReturnPath((location.state as { from?: unknown } | null)?.from);

  const login = useCallback(async (input: PlatformLoginInput) => {
    await signIn(input);
    navigate(loginReturnPath, { replace: true });
  }, [loginReturnPath, navigate, signIn]);

  const logout = useCallback(async () => {
    try {
      await platformClient.logout();
    } catch {
      // The local session is cleared even if the server has already expired it.
    } finally {
      signOut();
      navigate('/platform/login', { replace: true });
    }
  }, [navigate, signOut]);

  return <Routes><Route path="/platform" element={<PlatformIndex auth={auth}/>}/><Route path="/platform/login" element={auth.kind === 'checking' ? <LoadingPage/> : auth.kind === 'signed-in' ? <Navigate to={loginReturnPath} replace/> : <PlatformLoginPage onLogin={login} sessionError={sessionError}/>}/><Route path="/platform/mfa/enroll" element={<MfaEnrollmentPage/>}/><Route element={<ProtectedPlatformRoute auth={auth} me={me} onLogout={logout}/>}><Route path="/platform/overview" element={<PlatformOverviewPage me={me} onRetryMe={reloadMe}/>}/><Route path="/platform/ops" element={<OpsOverviewPage/>}/><Route path="/platform/unknown-outcomes" element={<UnknownOutcomesPage me={me}/>}/><Route path="/platform/capacity" element={<CapacityPolicyPage me={me}/>}/><Route path="/platform/pricing" element={<PricingPage me={me}/>}/><Route path="/platform/refunds" element={<RefundsPage me={me}/>}/><Route path="/platform/catalog/products" element={<ProductsPage/>}/><Route path="/platform/catalog/capabilities" element={<CapabilitiesPage/>}/><Route path="/platform/catalog/rights" element={<RightsPage me={me}/>}/><Route path="/platform/supply/accounts" element={<SupplyAccountsPage me={me}/>}/><Route path="/platform/audit/events" element={<AuditHistoryPage/>}/></Route><Route path="*" element={<Navigate to="/platform" replace/>}/></Routes>;
}
