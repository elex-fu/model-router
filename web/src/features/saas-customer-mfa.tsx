import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { SafeSession } from '../api/saas-client';
import { Field, Panel, SaveButton } from '../components/ui';
import { createCustomerMfaLifecycle, type CustomerMfaState } from './saas-customer-mfa-lifecycle';

export function CustomerMfaSettings({ sessionScope, isCurrentSessionScope, onSignInRequired, onLogout }: {
  sessionScope?: SafeSession;
  isCurrentSessionScope?: () => boolean;
  onSignInRequired: () => void | Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const callbacks = useRef({ sessionScope, isCurrentSessionScope, onSignInRequired });
  callbacks.current = { sessionScope, isCurrentSessionScope, onSignInRequired };
  const lifecycle = useMemo(() => createCustomerMfaLifecycle({
    isCurrent: () => callbacks.current.sessionScope === sessionScope &&
      (!callbacks.current.isCurrentSessionScope || callbacks.current.isCurrentSessionScope()),
    onSignInRequired: () => callbacks.current.onSignInRequired(),
  }), [sessionScope]);
  const [state, setState] = useState<CustomerMfaState>(() => lifecycle.getState());
  const form = useRef<HTMLFormElement>(null);
  const secretText = useRef<HTMLElement>(null);
  const uriText = useRef<HTMLElement>(null);

  function clearDomSecrets() {
    for (const input of form.current?.querySelectorAll('input') ?? []) input.value = '';
    // Synchronous clearing also covers a browser snapshot before React commits.
    if (secretText.current) secretText.current.textContent = '';
    if (uriText.current) uriText.current.textContent = '';
  }

  useEffect(() => {
    const unmount = lifecycle.mount(next => {
      // Includes failures/expiry, not just success. No password/TOTP React draft.
      clearDomSecrets();
      setState(next);
    });
    void lifecycle.refresh();
    const leave = () => { clearDomSecrets(); lifecycle.pageExit(); };
    const hide = () => { if (document.visibilityState === 'hidden') leave(); };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) leave(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('beforeunload', leave);
    window.addEventListener('pageshow', restore);
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearDomSecrets();
      unmount();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('pageshow', restore);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [lifecycle]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const password = fields.get('password');
    const current = fields.get('currentTotpCode');
    const code = fields.get('code');
    fields.delete('password'); fields.delete('currentTotpCode'); fields.delete('code');
    clearDomSecrets();
    if (typeof password !== 'string') return;
    const reauth = { password, ...(state.enabled === true && typeof current === 'string' ? { currentTotpCode: current } : {}) };
    if (state.kind === 'enrollment' && typeof code === 'string') void lifecycle.confirm({ ...reauth, code });
    else if (state.kind === 'ready' && state.action === 'revoke' && typeof current === 'string') {
      void lifecycle.revoke({ password, code: current });
    } else if (state.kind === 'ready' && state.action === 'enroll') void lifecycle.start(reauth);
  }

  const busy = ['checking', 'starting', 'confirming', 'revoking'].includes(state.kind);
  const canSubmit = state.availability !== 'deployment-unavailable' && (state.kind === 'ready' || state.kind === 'enrollment');
  return <Panel title="客户多因素认证（MFA）" action={
    <button type="button" className="quiet" disabled={busy || state.kind === 'sign-in-required'}
      onClick={() => { clearDomSecrets(); void lifecycle.refresh(); }}>清除配置并核对状态</button>
  }>
    <p className="muted">此页只管理当前客户账号的验证设备，不表示本次邮箱密码登录已经通过 MFA。确认更改或撤销后，所有原客户会话失效，必须重新登录。</p>
    <p role="status" aria-live="polite">{state.availability === 'deployment-unavailable'
      ? '此部署当前不可使用客户 MFA；账号 MFA 状态未确认。'
      : state.enabled === null ? 'MFA 状态尚未确认' : state.enabled ? '服务端状态：已开启' : '服务端状态：未开启'}</p>
    {state.notice && <div className="notice error" role="alert">{state.notice}</div>}
    {busy && <p role="status">正在处理，请勿重复提交。取消本地等待不能撤回服务器请求。</p>}
    {state.kind === 'ready' && state.enabled === true && <div className="actions">
      <button type="button" aria-pressed={state.action === 'enroll'} onClick={() => { clearDomSecrets(); lifecycle.choose('enroll'); }}>替换验证设备</button>
      <button type="button" className="danger" aria-pressed={state.action === 'revoke'} onClick={() => { clearDomSecrets(); lifecycle.choose('revoke'); }}>撤销 MFA</button>
    </div>}
    {state.kind === 'enrollment' && <section className="notice secret" aria-label="一次性 MFA 配置">
      <strong>一次性配置 · 尚未确认开启或替换</strong>
      <p>只在本页内存展示。请在可信验证器中手动录入；刷新、取消、离开或隐藏页面会清除。不要将配置发送给第三方二维码服务。</p>
      <p>密钥：<code ref={secretText}>{state.configuration.secret}</code></p>
      <p>otpauth 配置：<code ref={uriText} style={{ overflowWrap: 'anywhere' }}>{state.configuration.otpauthUri}</code></p>
      <p>到期时间：<time dateTime={state.configuration.expiresAt}>{state.configuration.expiresAt}</time></p>
    </section>}
    {canSubmit && <form ref={form} autoComplete="off" onSubmit={submit}>
      {state.enabled === true && state.action === 'enroll' && <p className="muted">原验证设备在确认替换前保持有效。开始和确认均需密码与原设备验证码；开始操作已消耗验证码，确认时请等待原设备生成新的验证码。</p>}
      {state.action === 'revoke' && <p className="notice error">确认撤销 MFA 会使所有原客户会话失效；此处不提供恢复码或绕过验证。</p>}
      <Field label={state.kind === 'enrollment' ? '再次输入当前密码' : '当前密码（重认证）'}>
        <input name="password" type="password" required maxLength={1024} autoComplete="off" spellCheck={false} />
      </Field>
      {state.enabled === true && <Field label={state.kind === 'enrollment' ? '原设备的新验证码' : '当前验证设备的验证码'}>
        <input name="currentTotpCode" type="password" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" spellCheck={false} />
      </Field>}
      {state.kind === 'enrollment' && <Field label="新设备的验证码">
        <input name="code" type="password" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" spellCheck={false} />
      </Field>}
      <SaveButton busy={busy}>{state.kind === 'enrollment' ? '确认并重新登录' : state.action === 'revoke' ? '确认撤销并重新登录' : state.enabled ? '重认证并开始替换' : '重认证并开始设置'}</SaveButton>
    </form>}
    <div className="actions">
      {state.kind !== 'sign-in-required' && <button type="button" className="quiet" onClick={() => { clearDomSecrets(); lifecycle.cancel(); }}>取消并清除秘密</button>}
      <button type="button" onClick={() => {
        clearDomSecrets();
        lifecycle.cancel();
        // Explicit user exit uses the real existing logout API. Successful MFA
        // changes instead use local invalidation after server session revocation.
        void onLogout().catch(() => { void lifecycle.signIn(); });
      }}>返回登录</button>
    </div>
  </Panel>;
}
