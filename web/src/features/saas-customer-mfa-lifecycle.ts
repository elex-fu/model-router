import { SaasApiError, CustomerMfaDeploymentUnavailableError, type CustomerMfaEnrollment, type CustomerMfaStartInput, saasClient } from '../api/saas-client';

export type CustomerMfaClient = Pick<typeof saasClient,
  'getCustomerMfaStatus' | 'startCustomerMfaEnrollment' | 'confirmCustomerMfaEnrollment' | 'revokeCustomerMfa'>;
export interface CustomerMfaClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
}
export type CustomerMfaAction = 'enroll' | 'revoke';
interface View {
  readonly availability?: 'deployment-unavailable';
  readonly enabled: boolean | null;
  readonly action: CustomerMfaAction;
  readonly notice?: string;
}
export type CustomerMfaState = View & (
  { readonly kind: 'idle' | 'checking' | 'ready' | 'starting' | 'confirming' | 'revoking' | 'blocked' | 'sign-in-required' } |
  { readonly kind: 'enrollment'; readonly configuration: Readonly<Omit<CustomerMfaEnrollment, 'confirmationToken'>> }
);
const browserClock: CustomerMfaClock = {
  now: () => Date.now(),
  schedule(callback, milliseconds) {
    const timer = globalThis.setTimeout(callback, milliseconds);
    return () => globalThis.clearTimeout(timer);
  },
};

function safeFailure(error: unknown): string {
  if (error instanceof CustomerMfaDeploymentUnavailableError) return '此部署当前不可使用客户 MFA；账号 MFA 状态未确认。';
  if (error instanceof SaasApiError) {
    if (error.code === 'UNAUTHENTICATED' && error.status === 401) return '登录已失效，请重新登录。';
    if (error.code === 'CSRF_REJECTED' && error.status === 403) return '安全凭证不可用；请刷新页面或重新登录，不会绕过 CSRF 校验。';
    if (error.code === 'ORIGIN_REJECTED' && error.status === 403) return '请求来源被拒绝，请从客户控制台重新打开页面。';
    if (error.code === 'REAUTH_REQUIRED' && error.status === 403) return '密码重认证被拒绝，请核对后重新输入。';
    if (error.code === 'MFA_CODE_REJECTED' && error.status === 403) return '验证码被拒绝，请核对设备并使用新的验证码。';
    if (error.code === 'ENROLLMENT_PENDING' && error.status === 409) return '服务端仍有待确认配置；本地取消不能撤销它，请等待到期后核对状态。';
    if (error.code === 'RATE_LIMITED' && error.status === 429) return '请求过于频繁，请稍后核对状态。';
    if (error.status >= 400 && error.status < 500 && error.code !== 'INVALID_RESPONSE') return '请求被拒绝，请核对最新状态；敏感信息已清除。';
  }
  return '操作结果尚未确认；敏感信息已清除，不会自动重试。若已提交确认或撤销，请先重新登录核对。';
}

function deploymentAvailability(error: unknown): Pick<View, 'availability'> {
  return error instanceof CustomerMfaDeploymentUnavailableError ? { availability: 'deployment-unavailable' } : {};
}

/** No query cache, draft store, URL or browser storage. Abort is not a server rollback.
 * Reference clearing cannot zero immutable JS strings or browser transport copies.
 */
export function createCustomerMfaLifecycle(dependencies: {
  client?: CustomerMfaClient;
  isCurrent: () => boolean;
  onSignInRequired: () => void | Promise<void>;
  clock?: CustomerMfaClock;
}) {
  const client = dependencies.client ?? saasClient;
  const clock = dependencies.clock ?? browserClock;
  let state: CustomerMfaState = Object.freeze({ kind: 'idle', enabled: null, action: 'enroll' });
  let listener: ((state: CustomerMfaState) => void) | undefined;
  let mounted = false;
  let mountId = 0;
  let epoch = 0;
  let flight: { controller: AbortController; epoch: number } | undefined;
  let confirmationToken: string | undefined;
  let expiresAt: number | undefined;
  let cancelTimer: (() => void) | undefined;

  function publish(next: CustomerMfaState) {
    state = Object.freeze(next);
    if (mounted && dependencies.isCurrent()) listener?.(state);
  }
  function clearConfiguration() {
    confirmationToken = undefined;
    expiresAt = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
  }
  function invalidate(notice: string, error?: unknown) {
    ++epoch;
    clearConfiguration();
    flight?.controller.abort();
    publish({ kind: state.kind === 'sign-in-required' ? 'sign-in-required' : 'blocked',
      enabled: null, action: state.action, notice,
      ...deploymentAvailability(error) });
  }
  function current(operation: NonNullable<typeof flight>) {
    return mounted && dependencies.isCurrent() && flight === operation && operation.epoch === epoch;
  }
  function expire(): boolean {
    if (expiresAt === undefined) return false;
    if (Number.isFinite(clock.now()) && clock.now() < expiresAt) return false;
    invalidate('待确认配置已到期，本页敏感信息已清除；请核对服务端状态。');
    return true;
  }
  function scheduleExpiry() {
    if (expiresAt === undefined) return;
    cancelTimer = clock.schedule(() => {
      cancelTimer = undefined;
      if (!expire()) scheduleExpiry();
    }, Math.min(Math.max(0, expiresAt - clock.now()), 2_147_483_647));
  }
  function begin(kind: 'checking' | 'starting' | 'confirming' | 'revoking') {
    const operation = { controller: new AbortController(), epoch: ++epoch };
    flight = operation;
    publish({ kind, enabled: state.enabled, action: state.action });
    return operation;
  }
  function finish(operation: NonNullable<typeof flight>) {
    if (flight === operation) flight = undefined;
  }
  function available() { return mounted && dependencies.isCurrent() && !flight && state.kind !== 'sign-in-required'; }
  function validPassword(value: string) { return value.length > 0 && new TextEncoder().encode(value).length <= 1024; }
  function validReauth(input: CustomerMfaStartInput) {
    return validPassword(input.password) && (state.enabled !== true || /^[0-9]{6}$/.test(input.currentTotpCode ?? ''));
  }
  function inputFailure() {
    invalidate('输入格式无效，敏感信息已清除；请核对状态后重新输入。');
  }
  async function requireSignIn() {
    clearConfiguration();
    publish({ kind: 'sign-in-required', enabled: null, action: state.action,
      notice: '请重新登录。当前登录不作为已完成 MFA 验证的证明。' });
    if (!mounted || !dependencies.isCurrent()) return;
    try { await dependencies.onSignInRequired(); }
    catch {
      // A local navigation/cache failure never redispatches the accepted mutation.
      if (mounted && dependencies.isCurrent()) publish({ kind: 'sign-in-required', enabled: null,
        action: state.action, notice: '请返回登录；本地退出处理未完成，不要重复提交 MFA 更改。' });
    }
  }

  return {
    getState: () => state,
    get busy() { return flight !== undefined; },
    mount(onState: (next: CustomerMfaState) => void) {
      const id = ++mountId;
      mounted = true;
      listener = onState;
      if (dependencies.isCurrent()) onState(state);
      return () => {
        if (id !== mountId) return;
        mounted = false;
        listener = undefined;
        invalidate('已离开配置页，敏感信息已清除；服务端待确认配置不因此撤销。');
      };
    },
    choose(action: CustomerMfaAction) {
      if (!available() || state.kind !== 'ready' || (action === 'revoke' && state.enabled !== true)) return false;
      publish({ kind: 'ready', enabled: state.enabled, action });
      return true;
    },
    async refresh() {
      if (!available()) return false;
      clearConfiguration();
      const operation = begin('checking');
      try {
        const result = await client.getCustomerMfaStatus({ signal: operation.controller.signal });
        if (!current(operation)) return false;
        publish({ kind: 'ready', enabled: result.enabled,
          action: result.enabled ? state.action : 'enroll' });
      } catch (error) {
        if (current(operation)) publish({ kind: 'blocked', enabled: null, action: state.action, notice: safeFailure(error),
          ...deploymentAvailability(error) });
      } finally { finish(operation); }
      return true;
    },
    async start(input: CustomerMfaStartInput) {
      if (!available() || state.kind !== 'ready' || state.action !== 'enroll' || state.enabled === null) return false;
      if (!validReauth(input)) { inputFailure(); return false; }
      const operation = begin('starting');
      try {
        const result = await client.startCustomerMfaEnrollment(input, { signal: operation.controller.signal });
        if (!current(operation)) return false;
        const deadline = Date.parse(result.expiresAt);
        if (!Number.isFinite(deadline) || !Number.isFinite(clock.now()) || deadline <= clock.now()) {
          invalidate('服务端配置已过期或无法读取；敏感信息已清除，请核对状态。');
          return false;
        }
        confirmationToken = result.confirmationToken;
        expiresAt = deadline;
        publish({ kind: 'enrollment', enabled: state.enabled, action: 'enroll',
          configuration: Object.freeze({ secret: result.secret, otpauthUri: result.otpauthUri, expiresAt: result.expiresAt }) });
        scheduleExpiry();
      } catch (error) {
        if (current(operation)) invalidate(safeFailure(error), error);
      } finally { finish(operation); }
      return true;
    },
    async confirm(input: CustomerMfaStartInput & { code: string }) {
      if (!available() || expire() || state.kind !== 'enrollment' || !confirmationToken) return false;
      if (!validReauth(input) || !/^[0-9]{6}$/.test(input.code)) { inputFailure(); return false; }
      const token = confirmationToken;
      clearConfiguration(); // Remove displayed setup and internal token BEFORE dispatch.
      const operation = begin('confirming');
      try {
        const result = await client.confirmCustomerMfaEnrollment({ ...input, confirmationToken: token }, { signal: operation.controller.signal });
        if (current(operation)) {
          if (result.enabled !== true || result.signInRequired !== true || !Number.isSafeInteger(result.sessionsRevoked) || result.sessionsRevoked < 1) {
            invalidate(safeFailure(undefined));
          } else await requireSignIn();
        }
      } catch (error) {
        if (current(operation)) invalidate(safeFailure(error), error);
      } finally { finish(operation); }
      return true;
    },
    async revoke(input: { password: string; code: string }) {
      if (!available() || state.kind !== 'ready' || state.action !== 'revoke' || state.enabled !== true) return false;
      if (!validPassword(input.password) || !/^[0-9]{6}$/.test(input.code)) { inputFailure(); return false; }
      const operation = begin('revoking');
      try {
        const result = await client.revokeCustomerMfa(input, { signal: operation.controller.signal });
        if (current(operation)) {
          if (result.enabled !== false || result.signInRequired !== true || !Number.isSafeInteger(result.sessionsRevoked) || result.sessionsRevoked < 1) {
            invalidate(safeFailure(undefined));
          } else await requireSignIn();
        }
      } catch (error) {
        if (current(operation)) invalidate(safeFailure(error), error);
      } finally { finish(operation); }
      return true;
    },
    cancel: () => invalidate('本页敏感信息已清除；不会撤销服务端待确认配置。已发送操作可能已生效，请先核对状态；确认或撤销结果未知时请重新登录。'),
    pageExit: () => invalidate('页面已离开或刷新，敏感信息已清除；不会重放操作或恢复配置。'),
    signIn: requireSignIn,
    expire,
  };
}
