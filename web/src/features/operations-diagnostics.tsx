import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformOpsClient, type OperationsDiagnosticsPage } from '../api/saas-platform-ops-client';
import { Badge, Panel, State, formatDate } from '../components/ui';

export function OperationsDiagnosticsPanel() {
  const page = useQuery({ queryKey: ['ops-diagnostics'], queryFn: ({ signal }) => platformOpsClient.diagnostics({ signal }), refetchInterval: 15_000 });
  return <Panel title="故障队列与数据新鲜度" action={<button type="button" onClick={() => void page.refetch()} disabled={page.isFetching}>刷新</button>}>
    {page.isError ? <div className="notice error" role="alert">故障诊断数据读取失败，请刷新重试。</div> : page.data ? <OperationsDiagnosticsContent page={page.data}/> : <State loading>读取故障诊断…</State>}
  </Panel>;
}

export function OperationsDiagnosticsContent({ page }: { page: OperationsDiagnosticsPage }) {
  return <div className="stack">
    <p className="muted">快照 {formatDate(page.snapshotAt)}。后台每 15 秒刷新；下列计数来自持久化记录。</p>
    <div className="grid-two">
      <section><h3>恢复队列</h3><div className="summary-list">
        <div><span>未知结果自动核对</span><strong>{page.financial.open}</strong></div>
        <div><span>需要人工证据</span><strong>{page.financial.operatorRequired}</strong></div>
        <div><span>最早待核对</span><span>{formatDate(page.financial.oldestAt)}</span></div>
        <div><span>凭据验证排队 / 租用</span><strong>{page.validation.queued} / {page.validation.leased}</strong></div>
        <div><span>验证租约已过期 / 失败</span><strong>{page.validation.expiredLeases} / {page.validation.failed}</strong></div>
        <div><span>最近验证完成记录</span><span>{formatDate(page.validation.lastCompletedAt)}</span></div>
      </div><p><Link to="/platform/ops/scheduling-health">诊断账号并探活 / 重试验证</Link> · <Link to="/platform/ops/media-tasks">媒体恢复队列</Link></p></section>
      <section><h3>聚合与报表进度</h3><div className="summary-list">{page.sources.map(source => <div key={source.name}><span>{source.name}<small>{source.observationKind === 'schedule_claim' ? '已认领报表计划；不证明邮件发送成功' : '已完成聚合窗口'}</small></span><span><Badge tone={source.freshness === 'fresh' ? 'good' : 'warn'}>{source.freshness === 'fresh' ? '近期' : source.freshness === 'stale' ? '滞后' : '无观察'}</Badge><small>{formatDate(source.observedAt)}</small></span></div>)}</div>
      <p className="muted">聚合水位是成功处理进度，报表时间是计划认领时间。空闲队列或历史完成记录不能证明 worker 当前存活。</p></section>
    </div>
    <section><h3>网关运行时能力</h3>{page.gatewayCapabilities?.state === 'available' ? <>
      <p>观察 {formatDate(page.gatewayCapabilities.observedAt)} · 配置 {page.gatewayCapabilities.readiness.configurationValid ? '有效' : '无效'} · {page.gatewayCapabilities.readiness.fatalReasonCodes.join(' · ')}</p>
      <table><thead><tr><th>能力</th><th>启用</th><th>已装配</th><th>已验证</th><th>可运营</th><th>证据 / 原因</th></tr></thead><tbody>{page.gatewayCapabilities.readiness.capabilities.map(item => <tr key={item.capability}><td>{item.label}<small>{item.capability}</small></td><td>{item.enabled ? '是' : '否'}</td><td>{item.assembled ? '是' : '否'}</td><td>{item.verified ? '是' : '否'}</td><td><Badge tone={item.operational ? 'good' : 'warn'}>{item.operational ? '是' : '否'}</Badge></td><td>{item.verificationLevel}<small>{item.reasonCodes.join(' · ') || '无阻断原因'}</small><small>不可用端点 {item.unavailableEndpointScopes.join(', ') || '无'}</small></td></tr>)}</tbody></table>
      <p className="muted">来自正在运行的网关就绪探针；mock 验证与 live 验证分别标注，装配成功不会自动升级为真实上游验证。</p>
    </> : <div className="empty" role="status">{page.gatewayCapabilities?.state === 'unavailable' ? '网关能力探针不可用，暂不能确认运行时装配与就绪。' : '尚未配置网关能力探针来源，暂不能确认运行时装配与就绪。'}</div>}</section>
    <section><h3>账务核对案件（最多 25 条）</h3>{page.financial.cases.length ? <table><thead><tr><th>租户 / 请求</th><th>状态</th><th>最近诊断</th><th>处理</th></tr></thead><tbody>{page.financial.cases.map(item => <tr key={item.caseId}><td>{item.tenantId}<small>{item.requestId}</small></td><td><Badge tone="warn">{item.state === 'operator_required' ? '人工核对' : '自动核对中'}</Badge></td><td>{item.lastErrorCode ?? '等待核对'}<small>扫描 {item.scanAttempts} 次 · {formatDate(item.createdAt)}</small></td><td><Link to={`/platform/unknown-outcomes?tenantId=${encodeURIComponent(item.tenantId)}`}>核对证据与处置</Link><small>{item.caseId}</small></td></tr>)}</tbody></table> : <div className="empty" role="status">没有待处理核对案件</div>}
      <p className="muted">处置页要求逐尝试证据、原因及二次确认，使用现有审计和幂等流程。未知执行结果不得通过媒体重排重新生成。</p></section>
    <section><h3>最近告警（最多 20 条）</h3>{page.alerts.length ? <table><thead><tr><th>规则</th><th>指标</th><th>触发</th><th>恢复</th></tr></thead><tbody>{page.alerts.map(alert => <tr key={alert.id}><td>{alert.name}</td><td>{alert.metric}</td><td>{formatDate(alert.triggeredAt)}</td><td>{alert.resolvedAt ? formatDate(alert.resolvedAt) : <Badge tone="warn">尚未恢复</Badge>}</td></tr>)}</tbody></table> : <div className="empty" role="status">没有告警事件</div>}</section>
  </div>;
}
