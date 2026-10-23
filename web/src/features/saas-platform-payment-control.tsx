import { useEffect, useState, type FormEvent } from 'react';
import { PlatformApiError, request } from '../api/saas-platform-client';
import { Field, Panel } from '../components/ui';

export interface PaymentControlView { mode: 'disabled' | 'draining' | 'enabled'; activeBindingId: string | null; revision: string }
export function parsePaymentControl(value: unknown): PaymentControlView {
  const item = value as Partial<PaymentControlView> | null;
  if (!item || !['disabled', 'draining', 'enabled'].includes(item.mode ?? '') || typeof item.revision !== 'string' || !/^[1-9]\d*$/.test(item.revision) || !(item.activeBindingId === null || typeof item.activeBindingId === 'string')) {
    throw new Error('无法识别支付控制状态，请刷新后重试。');
  }
  return item as PaymentControlView;
}
export async function readPaymentControlView(): Promise<PaymentControlView> {
  return parsePaymentControl(await request('/payments/control'));
}
export async function updatePaymentControlView(expectedRevision: string, mode: PaymentControlView['mode'], activeBindingId: string | null): Promise<PaymentControlView> {
  return parsePaymentControl(await request('/payments/control', { method: 'PATCH', body: { expectedRevision, mode, activeBindingId } }));
}
const labels = { disabled: '关闭新支付', draining: '停止新单，处理现有订单', enabled: '接受新支付' };
export function PaymentControlPage({ canManage }: { canManage: boolean }) {
  const [current, setCurrent] = useState<PaymentControlView>();
  const [mode, setMode] = useState<PaymentControlView['mode']>('disabled');
  const [bindingId, setBindingId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    const next = await readPaymentControlView();
    setCurrent(next); setMode(next.mode); setBindingId(next.activeBindingId ?? ''); setConfirmed(false);
  }
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    setBusy(true);
    void readPaymentControlView().then(next => {
      if (active) { setCurrent(next); setMode(next.mode); setBindingId(next.activeBindingId ?? ''); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '支付控制读取失败。'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [canManage]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!current || !confirmed) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await updatePaymentControlView(current.revision, mode, bindingId.trim() || null);
      setCurrent(next); setMode(next.mode); setBindingId(next.activeBindingId ?? ''); setConfirmed(false);
      setNotice('支付控制已更新。此结果仅确认共享控制状态，仍需通过部署验收确认各副本可用。');
    } catch (cause) {
      if (cause instanceof PlatformApiError && cause.status === 409) {
        try { await refresh(); setError('控制版本已被其他操作更新，已刷新最新状态；请重新核对并确认。'); }
        catch { setCurrent(undefined); setError('控制版本冲突且最新状态读取失败，请先刷新。'); }
      } else setError(cause instanceof Error ? cause.message : '更新结果尚未确认，请刷新后核对。');
    } finally { setBusy(false); }
  }
  if (!canManage) return <p role="status">仅运营管理员和超级管理员可管理支付控制。</p>;
  return <><div className="page-title"><div><h1>支付控制</h1><p>控制新订单受理与现有订单处理。</p></div></div>
    <Panel title="当前支付状态">
      {current && <dl className="summary-list"><dt>当前模式</dt><dd>{labels[current.mode]}</dd><dt>当前商户绑定 ID</dt><dd><code>{current.activeBindingId ?? '未选择'}</code></dd><dt>控制版本</dt><dd>{current.revision}</dd></dl>}
      {error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
      <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void refresh().catch(cause => setError(cause instanceof Error ? cause.message : '读取失败。')).finally(() => setBusy(false)); }}>刷新控制状态</button>
      <form onSubmit={submit}>
        <Field label="目标模式"><select disabled={busy || !current} value={mode} onChange={event => { setMode(event.target.value as PaymentControlView['mode']); setConfirmed(false); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="目标商户绑定 ID" hint="输入运维发布的不可变商户绑定标识，启用支付时必须填写。"><input required={mode === 'enabled'} maxLength={200} value={bindingId} disabled={busy || !current} onChange={event => { setBindingId(event.target.value); setConfirmed(false); }}/></Field>
        <label><input type="checkbox" checked={confirmed} disabled={busy || !current} onChange={event => setConfirmed(event.target.checked)}/>已核对目标商户，并确认运维已完成所有副本的商户绑定部署</label>
        <p className="muted">切换控制状态不会检查或完成副本部署。关闭或排空模式不会自动认定现有订单成功。</p>
        <button className="primary" type="submit" disabled={busy || !current || !confirmed}>{busy ? '处理中…' : '确认更新支付控制'}</button>
      </form>
    </Panel></>;
}
