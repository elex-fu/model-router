import { PlatformApiError, type PlatformMfaEnrollmentStart } from '../api/saas-platform-client';

export interface MfaEnrollmentClient {
  startMfaEnrollment(issuer: string, token: string, options: { signal: AbortSignal }): Promise<PlatformMfaEnrollmentStart>;
  confirmMfaEnrollment(token: string, code: string, options: { signal: AbortSignal }): Promise<{ confirmed: boolean }>;
}

export interface MfaEnrollmentClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

type Rejection = 'input_invalid' | 'token_invalid' | 'confirmation_invalid' | 'unavailable';

export type MfaEnrollmentState =
  | { readonly kind: 'idle' | 'starting' | 'confirming' | 'confirmed' | 'cancelled' | 'unknown' }
  | { readonly kind: 'awaiting-confirmation'; readonly enrollment: Readonly<PlatformMfaEnrollmentStart> }
  | { readonly kind: 'expired'; readonly confirmationSubmitted: boolean }
  | { readonly kind: 'rejected'; readonly reason: Rejection };

const browserClock: MfaEnrollmentClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(timer);
  },
};

function rejection(error: unknown, operation: 'start' | 'confirm'): Rejection | undefined {
  // Only the existing API's exact rejection contracts are known outcomes.
  // In particular, never retain/read an arbitrary error's message or request ID.
  if (!(error instanceof PlatformApiError)) return undefined;
  if (operation === 'start' && error.status === 401 && error.code === 'MFA_ENROLLMENT_TOKEN_INVALID') return 'token_invalid';
  if (operation === 'confirm' && error.status === 401 && error.code === 'MFA_CONFIRMATION_INVALID') return 'confirmation_invalid';
  if (error.status === 409 && error.code === 'MFA_ENROLLMENT_UNAVAILABLE') return 'unavailable';
  if (error.status === 503 && error.code === 'MFA_UNAVAILABLE') return 'unavailable';
  return undefined;
}

export function mfaEnrollmentNotice(state: MfaEnrollmentState): string | undefined {
  switch (state.kind) {
    case 'unknown':
      return '操作结果未知，敏感信息已从页面清除。断网或取消不能证明服务端未生效，请勿直接重试。若已提交确认，请先返回登录验证；否则请运维通过安全 CLI 核查状态后决定是否重新签发。';
    case 'expired':
      return state.confirmationSubmitted
        ? '配置已过期，敏感信息已清除，但已提交的确认结果未知。请先返回登录验证，再由运维通过安全 CLI 核查是否需要重新签发。'
        : '配置已过期，敏感信息已清除。请运维通过安全 CLI 核查状态并重新签发一次性令牌，不要继续使用旧配置。';
    case 'cancelled':
      return '已清除本页配置；这不会撤销服务端的待确认配置。请运维通过安全 CLI 核查状态后再决定是否重新签发。';
    case 'rejected': {
      const reasons: Record<Rejection, string> = {
        input_invalid: '输入格式无效。',
        token_invalid: '服务端拒绝了无效或过期的配置令牌。',
        confirmation_invalid: '服务端拒绝了验证码或确认令牌，不能据此区分错误验证码、过期或已被使用。',
        unavailable: '服务端当前不允许此 MFA 配置操作。',
      };
      return `${reasons[state.reason]}敏感信息已清除。若曾提交确认，请先返回登录验证；需要重新配置时，请运维通过安全 CLI 核查状态后重新签发。`;
    }
    default:
      return undefined;
  }
}

/** Page-local only: no storage, URL state, retries, or server-side cancellation claim.
 * Clearing references does not zero immutable JS strings or undo an accepted request.
 */
export function createMfaEnrollmentLifecycle(client: MfaEnrollmentClient, clock: MfaEnrollmentClock = browserClock) {
  let state: MfaEnrollmentState = Object.freeze({ kind: 'idle' });
  let mounted = false;
  let mountId = 0;
  let epoch = 0;
  let listener: ((state: MfaEnrollmentState) => void) | undefined;
  let flight: { epoch: number; controller: AbortController } | undefined;
  let deadline: number | undefined;
  let cancelTimer: (() => void) | undefined;

  function publish(next: MfaEnrollmentState) {
    state = Object.freeze(next);
    if (mounted) listener?.(state);
  }

  function clearDeadline() {
    cancelTimer?.();
    cancelTimer = undefined;
    deadline = undefined;
  }

  function invalidate(next: MfaEnrollmentState) {
    ++epoch;
    clearDeadline();
    // Keep the single-flight guard until the actual promise settles. Abort only
    // stops local waiting/transport where supported; the server may have committed.
    flight?.controller.abort();
    publish(next);
  }

  function checkExpiry(): boolean {
    if (deadline === undefined) return false;
    const now = clock.now();
    if (Number.isFinite(now) && now < deadline) return false;
    invalidate({ kind: 'expired', confirmationSubmitted: state.kind === 'confirming' });
    return true;
  }

  function scheduleExpiry() {
    if (deadline === undefined) return;
    cancelTimer = clock.schedule(() => {
      cancelTimer = undefined;
      if (!checkExpiry()) scheduleExpiry();
    }, Math.min(Math.max(0, deadline - clock.now()), 2_147_483_647));
  }

  function current(operation: NonNullable<typeof flight>): boolean {
    return mounted && operation === flight && operation.epoch === epoch;
  }

  function abandonedState(): MfaEnrollmentState {
    if (state.kind === 'starting' || state.kind === 'confirming') return { kind: 'unknown' };
    if (state.kind === 'awaiting-confirmation') return { kind: 'cancelled' };
    // Cleanup must not downgrade an already unknown/expired/rejected outcome.
    return state;
  }

  function mount(onState: (state: MfaEnrollmentState) => void): () => void {
    const id = ++mountId;
    mounted = true;
    listener = onState;
    onState(state);
    return () => {
      if (id !== mountId) return;
      mounted = false;
      listener = undefined;
      invalidate(abandonedState());
    };
  }

  async function start(issuer: string, token: string): Promise<boolean> {
    if (!mounted || flight || state.kind !== 'idle') return false;
    if (!issuer.trim() || issuer.length > 120 || !token.trim()) {
      publish({ kind: 'rejected', reason: 'input_invalid' });
      return true;
    }
    const operation = { epoch: ++epoch, controller: new AbortController() };
    flight = operation; // Synchronous: two submits in the same render cannot dispatch twice.
    publish({ kind: 'starting' });
    try {
      const result = await client.startMfaEnrollment(issuer, token, { signal: operation.controller.signal });
      if (!current(operation)) return true;
      const expiresAt = Date.parse(result.expiresAt);
      if (!Number.isFinite(expiresAt) || !Number.isFinite(clock.now()) ||
        !result.confirmationToken || !result.otpauthUri.startsWith('otpauth://totp/')) {
        publish({ kind: 'unknown' });
        return true;
      }
      if (expiresAt <= clock.now()) {
        publish({ kind: 'expired', confirmationSubmitted: false });
        return true;
      }
      deadline = expiresAt;
      publish({ kind: 'awaiting-confirmation', enrollment: Object.freeze({
        otpauthUri: result.otpauthUri, confirmationToken: result.confirmationToken, expiresAt: result.expiresAt,
      }) });
      scheduleExpiry();
    } catch (error) {
      if (current(operation)) {
        clearDeadline();
        const reason = rejection(error, 'start');
        publish(reason ? { kind: 'rejected', reason } : { kind: 'unknown' });
      }
    } finally {
      if (flight === operation) flight = undefined;
    }
    return true;
  }

  async function confirm(code: string): Promise<boolean> {
    if (!mounted || flight || checkExpiry() || state.kind !== 'awaiting-confirmation') return false;
    if (!/^[0-9]{6}$/.test(code)) {
      invalidate({ kind: 'rejected', reason: 'input_invalid' });
      return true;
    }
    const confirmationToken = state.enrollment.confirmationToken;
    const operation = { epoch: ++epoch, controller: new AbortController() };
    flight = operation;
    // Remove the URI/secret/token from published state before dispatching confirmation.
    publish({ kind: 'confirming' });
    try {
      const result = await client.confirmMfaEnrollment(confirmationToken, code, { signal: operation.controller.signal });
      if (!current(operation) || checkExpiry()) return true;
      clearDeadline();
      publish(result.confirmed === true ? { kind: 'confirmed' } : { kind: 'unknown' });
    } catch (error) {
      if (current(operation) && !checkExpiry()) {
        clearDeadline();
        const reason = rejection(error, 'confirm');
        publish(reason ? { kind: 'rejected', reason } : { kind: 'unknown' });
      }
    } finally {
      if (flight === operation) flight = undefined;
    }
    return true;
  }

  return {
    mount, start, confirm, checkExpiry,
    getState: (): MfaEnrollmentState => state,
    cancel: () => invalidate(state.kind === 'idle' ? { kind: 'cancelled' } : abandonedState()),
  };
}
