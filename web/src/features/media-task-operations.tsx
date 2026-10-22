import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PlatformApiError } from '../api/saas-platform-client';
import { platformOpsClient, type OpsMediaTaskPage, type OpsMediaTaskRow, type MediaRequeueReceipt } from '../api/saas-platform-ops-client';
import { Badge, Panel, State, formatDate, formatNumber } from '../components/ui';

type KindFilter = 'all' | 'image' | 'video';
export function MediaTaskOperationsPage({ canManage = false }: { canManage?: boolean }) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [includeTerminal, setIncludeTerminal] = useState(true);
  const [selected, setSelected] = useState<OpsMediaTaskRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState('');
  const [receipt, setReceipt] = useState<MediaRequeueReceipt | null>(null);
  const command = useRef<Parameters<typeof platformOpsClient.requeueVideo>[0] | null>(null);
  const page = useQuery({ queryKey: ['ops-media-tasks', kind, includeTerminal],
    queryFn: ({ signal }) => platformOpsClient.listOpsMediaTasks({ ...(kind === 'all' ? {} : { kind }), limit: 100, includeTerminal }, { signal }), refetchInterval: 10_000 });
  function select(row: OpsMediaTaskRow) { command.current = null; setErrorCode(''); setReceipt(null); setSelected(row); }
  async function submit(reason: string) {
    if (!selected?.recovery || !canManage || busy) return;
    command.current ??= { taskId: selected.taskId, tenantId: selected.tenantId, expectedLeaseEpoch: selected.recovery.leaseEpoch, reason, idempotencyKey: `media-requeue:${crypto.randomUUID()}` };
    setBusy(true); setErrorCode('');
    try { setReceipt(await platformOpsClient.requeueVideo(command.current)); setSelected(null); await page.refetch(); }
    catch (error) { setErrorCode(error instanceof PlatformApiError ? error.code : 'NETWORK_ERROR'); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    <Panel title="任务运营" action={<button type="button" onClick={() => void page.refetch()} disabled={page.isFetching}>刷新</button>}>
      <p className="muted">图片显示生成生命周期；视频显示结算与回查状态，不能由结算状态推断上游生成进度。每 10 秒刷新，最多显示 100 条，计数仅对应本页。</p>
      <div className="row"><label>类型 <select value={kind} onChange={event => setKind(event.target.value as KindFilter)}><option value="all">全部</option><option value="image">图片</option><option value="video">视频</option></select></label>
      <label><input type="checkbox" checked={includeTerminal} onChange={event => setIncludeTerminal(event.target.checked)}/> 包含终态</label></div>
      {page.data && <><p>快照 {formatDate(page.data.snapshotAt)}</p><span className="muted">共 {formatNumber(page.data.counts.total)} · 处理中 {formatNumber(page.data.counts.processing)} · 终态未结算 {formatNumber(page.data.counts.terminalUnsettled)} · 回查租用 {formatNumber(page.data.counts.recoveryActive)} · 超时待检查 {formatNumber(page.data.counts.overdue)}</span></>}
      {!canManage && <p className="muted">当前角色只读；重排需要运营或超级管理员权限。</p>}
      {receipt && <div className="notice" role="status"><strong>{receipt.status === 'replayed' ? '已返回原重排回执' : '状态回查已排队'}</strong><span>审计事件 {receipt.auditEventId} · {formatDate(receipt.queuedAt)}。请观察下次轮询时间和结算状态；排队成功不代表生成或结算成功。</span></div>}
    </Panel>
    {selected && <MediaRequeueForm key={`${selected.taskId}:${selected.recovery?.leaseEpoch}`} row={selected} busy={busy} locked={command.current !== null} errorCode={errorCode} onSubmit={submit} onCancel={() => { setSelected(null); command.current = null; void page.refetch(); }}/>}
    <Panel title="任务列表">
      {page.isError && <div className="notice error" role="alert">读取失败；已有数据可能滞后，请刷新。</div>}
      {page.data ? page.data.rows.length ? <MediaTaskTable rows={page.data.rows} canManage={canManage} onRequeue={select}/> : <div className="empty" role="status">当前没有符合条件的任务</div> : <State loading>读取任务…</State>}
    </Panel>
  </div>;
}

export function MediaRequeueForm({ row, busy, locked, errorCode, onSubmit, onCancel }: { row: OpsMediaTaskRow; busy: boolean; locked: boolean; errorCode: string; onSubmit: (reason: string) => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false);
  function submit(event: FormEvent) { event.preventDefault(); if (reason.trim() && confirmed && !busy) void onSubmit(reason.trim()); }
  return <Panel title="重排视频状态回查"><form onSubmit={submit} className="stack">
    <p>任务 {row.taskId} · 租户 {row.tenantId} · 页面租约版本 {row.recovery?.leaseEpoch}</p>
    <p className="muted">回查绑定账号上的原任务，并沿用现有一次性结算服务。不会重放创建任务；不会重置失败计数、账务状态或接管活跃租约。</p>
    <label className="field">处置原因<textarea name="reason" required maxLength={1000} value={reason} disabled={busy || locked} onChange={event => setReason(event.target.value)}/></label>
    <label><input type="checkbox" checked={confirmed} disabled={busy || locked} onChange={event => setConfirmed(event.target.checked)}/> 已检查账号与原任务，确认提前排入状态回查</label>
    {locked && <p className="muted">重试复用当前请求和 Idempotency-Key；修改原因需重新读取任务。</p>}
    {errorCode && <div className="notice error" role="alert">{errorCode === 'FORBIDDEN' ? '权限不足或会话已失效。' : errorCode === 'TASK_STATE_CONFLICT' ? '任务已变化、过期、完成或被 worker 租用；请重新读取任务。' : errorCode === 'IDEMPOTENCY_CONFLICT' ? '幂等请求与原处置不一致，请重新读取任务。' : errorCode === 'TASK_NOT_FOUND' ? '此租户下没有该任务。' : '重排尚未确认，可使用相同请求重试。'}</div>}
    <div className="row"><button type="submit" disabled={busy || !confirmed || !reason.trim()}>{busy ? '正在提交…' : locked ? '重试同一处置' : '确认重排回查'}</button><button type="button" disabled={busy} onClick={onCancel}>重新读取任务</button></div>
  </form></Panel>;
}

const diagnostics: Record<string, string> = { image_processing: '图片生成中', image_stuck: '图片处理超过 10 分钟，检查恢复扫描', image_failed: '图片交付失败，检查原请求', complete: '已完成', poll_leased: 'worker 持有回查租约', poll_overdue: '回查到期超过 1 分钟', poll_waiting: '等待状态回查', billing_skipped: '结算已跳过，需核对证据' };
export function MediaTaskTable({ rows, canManage, onRequeue }: { rows: OpsMediaTaskPage['rows']; canManage: boolean; onRequeue: (row: OpsMediaTaskRow) => void }) {
  return <table><thead><tr><th>类型 / 任务</th><th>租户 / 账号</th><th>诊断与状态</th><th>恢复事实</th><th>处置 / 审计</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.kind}:${row.taskId}`}>
    <td>{row.kind === 'video' ? '视频' : '图片'}<small>{row.taskId}</small><small>{formatDate(row.createdAt)}</small></td><td>{row.tenantId}<small>{row.accountId ?? '无账号绑定投影'}</small>{row.requestId && <small>请求 {row.requestId}</small>}</td>
    <td><Badge tone={row.diagnostic === 'poll_overdue' || row.diagnostic === 'image_stuck' || row.diagnostic === 'billing_skipped' || row.diagnostic === 'image_failed' ? 'warn' : 'neutral'}>{diagnostics[row.diagnostic] ?? row.diagnostic}</Badge><small>{row.statusSource === 'video_billing' ? '结算' : '生命周期'}：{row.status}</small><small>请求 {row.executionState ?? '无关联投影'} · 财务 {row.financialStatus ?? '无关联投影'}</small></td>
    <td>{row.recovery ? <><span>轮询失败 {row.recovery.pollFailures} · 版本 {row.recovery.leaseEpoch}</span><small>到期 {formatDate(row.recovery.nextPollAt)}</small><small>租约 {formatDate(row.recovery.leaseUntil)}</small></> : '同步图片任务由恢复扫描标记失败，不能回查内容'}</td>
    <td>{row.kind === 'video' && <button type="button" disabled={!canManage || !row.recovery?.canRequeue} onClick={() => onRequeue(row)}>重排状态回查</button>}<small><Link to={`/platform/unknown-outcomes?tenantId=${encodeURIComponent(row.tenantId)}`}>账务证据核对</Link></small>{row.latestRequeue && <small>审计 {row.latestRequeue.auditEventId}<br/>{formatDate(row.latestRequeue.queuedAt)}</small>}</td>
  </tr>)}</tbody></table>;
}
