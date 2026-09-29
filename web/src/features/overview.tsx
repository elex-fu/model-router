import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, query, timeWindow } from '../api/client';
import type { ApiMeta, Overview as OverviewData, SeriesPoint, TelemetryFreshness, UsageSummary } from '../api/types';
import { Badge, Chart, Panel, State, formatDate, formatNumber } from '../components/ui';

const coverageLabels: Record<string, string> = {
  'native-live-minute+detail-tails': '实时分钟聚合 + 边界明细',
  'live-minute+detail-tails': '实时分钟聚合 + 边界明细',
  'native-detail': '原始明细快照',
  'exact-detail-snapshot': '原始明细快照（本次未使用分钟聚合）',
  archived: '历史归档',
  'verified-archive': '已核对的历史归档',
};
const grainLabels: Record<string, string> = { detail: '明细', 'utc-day': 'UTC 日' };

export function TelemetryProvenance({ meta, freshness, grain, coverage, legacyLogRows }: {
  meta?: ApiMeta; freshness?: TelemetryFreshness; grain?: string; coverage?: string; legacyLogRows?: number;
}) {
  const selectedCoverage = meta?.coverage ?? coverage ?? freshness?.coverage;
  const selectedGrain = meta?.grain ?? grain;
  const rows = legacyLogRows ?? meta?.legacyLogRows;
  return <Panel title="统计范围与新鲜度">
    <div className="summary-list">
      <div><span>统计粒度</span><strong>{selectedGrain ? (grainLabels[selectedGrain] ?? selectedGrain) : '后端未提供'}</strong></div>
      <div><span>覆盖方式</span><strong>{selectedCoverage ? (coverageLabels[selectedCoverage] ?? selectedCoverage) : '后端未提供'}</strong></div>
      <div><span>响应观测时间</span><strong>{meta?.observedAt ? formatDate(meta.observedAt) : '后端未提供'}</strong></div>
      <div><span>数据截至</span><strong>{meta?.dataThrough ? formatDate(meta.dataThrough) : '无已结束请求时间或后端未提供'}</strong></div>
      <div><span>结果不完整</span><strong>{meta?.partial === undefined ? '后端未提供' : meta.partial ? '是' : '否'}</strong></div>
      <div><span>历史日志行</span><strong>{rows == null ? '后端未提供' : formatNumber(rows)}</strong></div>
    </div>
    {freshness?.snapshotCompletedAtMs != null && <p className="muted">快照完成：{formatDate(new Date(freshness.snapshotCompletedAtMs).toISOString())}</p>}
    {freshness?.dataUpdatedAtMs != null && <p className="muted">快照所见最近写入：{formatDate(new Date(freshness.dataUpdatedAtMs).toISOString())}</p>}
    {freshness?.status === 'current' && <p className="muted">快照状态：读取完成时与写入序号一致。</p>}
    {freshness?.status === 'stale' && <p className="notice" role="status">读取期间有新写入；这份快照可能落后于当前数据。{freshness.snapshotSequence != null && freshness.currentSequence != null ? `快照序号 ${freshness.snapshotSequence}，当前序号 ${freshness.currentSequence}。` : ''}请刷新查看。</p>}
    {freshness?.status === 'unverified-legacy' && <p className="notice" role="status">旧库写入跟踪未验证；无法确认这份快照是否已包含最新写入。</p>}
    {freshness?.legacyMetadataCount != null && freshness.legacyMetadataCount > 0 && <p className="muted">检测到旧日志元数据 {formatNumber(freshness.legacyMetadataCount)} 条；{freshness.coverage === 'exact-detail-snapshot' ? '本次按原始明细读取。' : '旧日志行与原生请求分开统计。'}</p>}
    {meta?.partial === true && <p className="notice" role="status">后端标记此结果为不完整；请结合未知用量、历史日志行和新鲜度信息解读。</p>}
  </Panel>;
}

export function Overview() {
  const [params] = useSearchParams(); const range = params.get('range') ?? '24h'; const window = timeWindow(range);
  const report = useQuery({ queryKey: ['overview', window], queryFn: () => get<OverviewData>('/overview' + query(window)), refetchInterval: 5000 });
  const usage = useQuery({ queryKey: ['usage-summary', window], queryFn: () => get<UsageSummary>('/usage/summary' + query({ ...window, source: 'proxy' })), refetchInterval: 30000 });
  const trend = useQuery({ queryKey: ['overview-trend', window], queryFn: async () => (await get<SeriesPoint[]>('/usage/timeseries' + query({ ...window, source: 'proxy', grain: range === '24h' ? 'hour' : 'day' }))).data, refetchInterval: 30000 });
  const d = report.data?.data; const total = d?.logicalRequests;
  const success = d?.productionSuccessRate;
  const successLabel = success?.status === 'partial_unknown_admission' ? '口径不完整'
    : success?.value == null ? '—' : `${(success.value * 100).toFixed(1)}%`;
  const successDetail = !success ? '后端未提供接纳口径'
    : success.status === 'partial_unknown_admission'
      ? `有 ${formatNumber(success.unknownAdmissionEnded)} 条已结束请求的接纳状态未知，未计算成功率`
      : success.status === 'no_admitted_ended' ? '没有已结束且已接纳的生产请求'
        : `完成 ${formatNumber(success.completed)} / 已结束接纳 ${formatNumber(success.endedAdmitted)}；接纳前拒绝 ${formatNumber(success.excludedPreAdmissionRejected)} 条未计入`;
  const noRequests = total === 0;
  const p95Unsupported = d?.firstTokenP95Status === 'unsupported_live_preaggregate';
  const p95Label = d?.firstTokenP95Status === 'approximate' ? '首事件 P95（近似）' : '首事件 P95';
  const p95Detail = p95Unsupported ? '当前统计范围无法计算首事件 P95'
    : d?.firstTokenP95Status === 'approximate' ? '基于实时分钟固定桶直方图估算；边界分钟使用明细值'
      : `未知用量请求 ${formatNumber(d?.missingUsageRequests)}`;
  return <><div className="page-title"><div><p className="eyebrow">OPERATIONS</p><h1>总览</h1><p>请求、用量与上游状态</p></div><span className="muted">数据截至 {report.data?.meta?.dataThrough ? formatDate(report.data.meta.dataThrough) : '未提供或无已结束请求'}</span></div><State loading={report.isPending} error={report.error} retry={() => report.refetch()} empty={!d}>
    <div className="stats"><Link to="/requests" className="stat"><span>请求数</span><strong>{formatNumber(total)}</strong><small>完成 {formatNumber(d?.succeeded)} · 失败 {formatNumber(d?.failed)} · 取消 {formatNumber(d?.cancelled)}</small></Link><Link to="/requests" className="stat"><span>生产请求成功率</span><strong>{successLabel}</strong><small>{successDetail}</small></Link><Link to="/usage" className="stat"><span>输入 / 输出 Token</span><strong>{noRequests ? '—' : formatNumber(d?.inputTokens)} <em>/</em> {noRequests ? '—' : formatNumber(d?.outputTokens)}</strong><small>缓存读取 {noRequests ? '—' : formatNumber(d?.cacheReadTokens)}</small></Link><div className="stat"><span>{p95Label}</span><strong>{p95Unsupported ? '不支持' : d?.firstTokenP95Ms == null ? d?.firstTokenP95Status === 'exact' ? '无可用样本' : '未提供' : `${formatNumber(d.firstTokenP95Ms)} ms`}</strong><small>{p95Detail}</small></div></div>
    {noRequests && <p className="muted">当前范围没有原生请求；历史日志行另列。Token 和延迟不显示为 0。</p>}
    {(d?.legacyLogRows ?? 0) > 0 && <p className="notice" role="status">历史日志行：<strong>{formatNumber(d?.legacyLogRows)}</strong>。旧日志无法去重重试；这些行单独统计，未计入上方逻辑请求数和成功率。</p>}
    <div className="grid-two"><Panel title="请求趋势"><State loading={trend.isPending} error={trend.error} retry={() => trend.refetch()}><Chart points={trend.data ?? []} keyName="requests"/></State></Panel><Panel title="用量"><State loading={usage.isPending} error={usage.error} retry={() => usage.refetch()}><div className="summary-list"><div>请求尝试 <strong>{formatNumber(usage.data?.data.attempts)}</strong></div><div>缓存写入 <strong>{formatNumber(usage.data?.data.cacheWriteTokens)}</strong></div><div>未知用量 <strong>{formatNumber(usage.data?.data.missingUsageRequests)}</strong></div></div></State></Panel></div>
    <div className="grid-two"><Panel title="上游健康" action={<Link to="/upstreams">查看上游 →</Link>}><State empty={!d?.upstreamHealth?.length}><div className="rows">{d?.upstreamHealth?.map(item => <div className="row" key={item.id}><span>{item.name}</span><Badge tone={item.status === 'healthy' ? 'good' : 'warn'}>{item.status}</Badge></div>)}</div></State></Panel><Panel title="最近异常" action={<Link to="/requests">查看日志 →</Link>}><State empty={!d?.recentErrors?.length}><div className="rows">{d?.recentErrors?.map(item => <Link className="row" to={`/requests/${item.requestId}`} key={item.requestId}><code>{item.requestId}</code><span>{item.message}</span></Link>)}</div></State></Panel></div>
    <TelemetryProvenance meta={report.data?.meta} freshness={d?.freshness} coverage={d?.usage?.coverage} legacyLogRows={d?.legacyLogRows}/>
  </State></>;
}
