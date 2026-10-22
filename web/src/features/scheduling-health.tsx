import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlatformApiError, platformClient } from '../api/saas-platform-client';
import { platformOpsClient, type SchedulingHealthPage as HealthPage, type SchedulingHealthRow } from '../api/saas-platform-ops-client';
import { Badge, Panel, State, formatDate } from '../components/ui';
import { ValidationRequeueControl } from './platform-validation-requeue';

export function SchedulingHealthPage({ canManage = false }: { canManage?: boolean }) {
  const [onlyConstrained, setOnlyConstrained] = useState(false);
  const [busyAccount, setBusyAccount] = useState('');
  const [notice, setNotice] = useState('');
  const page = useQuery({ queryKey: ['ops-scheduling-health', onlyConstrained], queryFn: ({ signal }) => platformOpsClient.listOpsSchedulingHealth({ limit: 100, onlyConstrained }, { signal }), refetchInterval: 10_000 });
  async function probe(row: SchedulingHealthRow) {
    if (!canManage || busyAccount) return;
    setBusyAccount(row.accountId); setNotice('');
    try { const result = await platformClient.triggerProbeMonitor({ ownerKind: 'platform', accountId: row.accountId }); setNotice(`账号 ${row.accountId} 已排入探活；观察最近探活结果与时间确认执行。监控 ${result.monitorId}`); await page.refetch(); }
    catch (error) { setNotice(error instanceof PlatformApiError && error.status === 403 ? '当前会话无探活权限，请重新登录并核对角色。' : '探活请求未确认，请刷新账号状态后重试。'); }
    finally { setBusyAccount(''); }
  }
  return <div className="stack"><Panel title="故障处置" action={<button type="button" onClick={() => void page.refetch()} disabled={page.isFetching}>刷新</button>}>
    <p className="muted">按账号定位窗口暂停、阈值停调、健康失败和验证错误。窗口金额使用与调度器相同的精确供应商成本窗口；配额新鲜度只使用成功观察，失败尝试不会刷新时间。</p>
    <label><input type="checkbox" checked={onlyConstrained} onChange={event => setOnlyConstrained(event.target.checked)}/> 仅显示已扫描账号中的调度限制</label>
    {page.data && <><p>快照 {formatDate(page.data.snapshotAt)} · 扫描前 {page.data.scanned} 个账号（上限 {page.data.limit}），每 10 秒刷新；配额超过 {page.data.freshnessThresholdSeconds / 60} 分钟标记滞后。</p><HealthCounts page={page.data}/></>}
    {!canManage && <p className="muted">当前角色只读；探活和验证重试由运营或超级管理员执行。</p>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <p><Link to="/platform/ops">告警、worker 进度与账务故障</Link> · <Link to="/platform/supply/accounts">凭据轮换、账号策略与启用</Link></p>
  </Panel><Panel title="账号诊断与恢复">
    {page.isError && <div className="notice error" role="alert">读取失败；已有数据可能滞后，请刷新。</div>}
    {page.data ? page.data.rows.length ? <SchedulingHealthTable rows={page.data.rows} canManage={canManage} busyAccount={busyAccount} onProbe={row => void probe(row)}/> : <div className="empty" role="status">当前已扫描账号中没有符合条件的记录</div> : <State loading>读取调度事实…</State>}
  </Panel></div>;
}
function HealthCounts({ page }: { page: HealthPage }) { return <p className="muted">本页 {page.counts.total} · 窗口暂停 {page.counts.paused} · 仅粘性 {page.counts.stickyOnly} · 阈值停调 {page.counts.thresholdPaused} · 非健康 {page.counts.unhealthy} · 配额滞后或缺失 {page.counts.quotaStale}</p>; }
const windowLabels = { admit: '窗口正常', sticky_only: '仅粘性', paused: '窗口暂停', off: '未配置窗口' };
export function SchedulingHealthTable({ rows, canManage, busyAccount, onProbe }: { rows: HealthPage['rows']; canManage: boolean; busyAccount: string; onProbe: (row: SchedulingHealthRow) => void }) {
  return <table><thead><tr><th>账号</th><th>窗口 / 阈值</th><th>最近失败与观察</th><th>配额 / 探活</th><th>恢复</th></tr></thead><tbody>{rows.map(row => <tr key={row.accountId}>
    <td>{row.displayName ?? row.accountId}<small>{row.accountId} · {row.providerId}</small><Badge tone={row.accountStatus === 'active' ? 'good' : 'warn'}>{row.accountStatus}</Badge><small>验证 {row.validationState} · {row.validationErrorCode ?? '无错误记录'}</small></td>
    <td><Badge tone={row.windowState === 'paused' ? 'bad' : row.windowState === 'sticky_only' ? 'warn' : 'neutral'}>{windowLabels[row.windowState]}</Badge>{row.windowFacts && <><small>用量 {row.windowFacts.usageMinorUnits} / 上限 {row.windowFacts.limitMinorUnits} / 粘性余量 {row.windowFacts.reserveMinorUnits} minor units</small><small>窗口起点 {formatDate(row.windowFacts.windowStart)}</small></>}<small>阈值停调至 {formatDate(row.thresholdPauseUntil)}</small><small>{row.thresholdPauseReason}</small></td>
    <td>{row.healthState ?? '没有健康观察'}<small>{row.healthLastOutcome ?? '尚无结果'}</small><small>观察 {formatDate(row.healthObservedAt)}</small><small>冷却至 {formatDate(row.healthCooldownUntil)}</small></td>
    <td><Badge tone={row.quotaFreshness === 'fresh' ? 'good' : 'warn'}>{row.quotaFreshness === 'fresh' ? '近期配额' : row.quotaFreshness === 'stale' ? '配额滞后' : '没有成功配额观察'}</Badge><small>{formatDate(row.quotaObservedAt)}</small><small>最近探活 {row.probe?.lastResult ?? '未执行'} · {formatDate(row.probe?.lastRunAt ?? null)}</small><small>请求 {formatDate(row.probe?.requestedAt ?? null)} · 下次 {formatDate(row.probe?.nextDueAt ?? null)}</small></td>
    <td><button type="button" disabled={!canManage || !!busyAccount} onClick={() => onProbe(row)}>{busyAccount === row.accountId ? '排队中…' : '排入探活'}</button><small>探活结果由验证 worker 异步记录；排队不自动启用账号或清除暂停。</small>{row.validationCredentialId && <ValidationRequeueControl accountId={row.accountId} credentialId={row.validationCredentialId} canManage={canManage}/>}<Link to="/platform/supply/accounts">处理凭据与调度策略</Link></td>
  </tr>)}</tbody></table>;
}
