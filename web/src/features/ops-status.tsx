import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  platformClient,
  type OpsChannelStatusPage,
  type OpsQpsSnapshot,
} from '../api/saas-platform-client';
import { Badge, Panel, State, formatDate, formatNumber } from '../components/ui';

/**
 * Phase 3 observability console page: live QPS (SSE feed) plus the passive
 * channel status availability rollup. Read-only; the aggregation itself runs
 * in the platform channel-status worker.
 */

const OPS_QPS_STREAM_PATH = '/admin/api/v1/ops/qps-stream';

export function OpsChannelStatusPage() {
  const [rangeDays, setRangeDays] = useState(7);
  const status = useQuery({
    queryKey: ['ops-channel-status', rangeDays],
    queryFn: () => platformClient.listOpsChannelStatus(rangeDays),
    refetchInterval: 30_000,
  });
  const qps = useOpsQpsStream();
  const page = status.data;

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">运营</p>
          <h1>通道状态</h1>
          <p>被动聚合的通道可用率与实时 QPS（无主动探测）。</p>
        </div>
      </div>
      <Panel title="实时 QPS（近 60 秒窗口）">
        {qps.kind === 'live' ? (
          <div className="ops-qps-live">
            <div className="ops-qps-figure">
              <strong>{qps.snapshot.qps.toFixed(2)}</strong>
              <span> 请求/秒</span>
            </div>
            <div className="ops-qps-meta">
              <span>成功 {formatNumber(qps.snapshot.statusCounts.ok)}</span>
              <span>失败 {formatNumber(qps.snapshot.statusCounts.failed)}</span>
              <span>更新于 {formatDate(qps.snapshot.generatedAt)}</span>
            </div>
            {qps.snapshot.routes.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>路由</th>
                      <th>QPS</th>
                      <th>请求</th>
                      <th>失败</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qps.snapshot.routes.slice(0, 10).map((route) => (
                      <tr key={route.route}>
                        <td>{route.route}</td>
                        <td>{route.qps.toFixed(2)}</td>
                        <td>{formatNumber(route.requests)}</td>
                        <td>{formatNumber(route.failed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : qps.kind === 'error' ? (
          <div className="notice" role="status">
            <strong>实时 QPS 流不可用</strong>
            <span>无法连接 {OPS_QPS_STREAM_PATH}，实时数字暂停刷新。</span>
          </div>
        ) : (
          <div className="notice" role="status">
            <strong>正在连接实时 QPS 流…</strong>
          </div>
        )}
      </Panel>
      <Panel
        title={`通道可用率（近 ${rangeDays} 天）`}
        action={
          <select
            aria-label="统计范围"
            value={rangeDays}
            onChange={(event) => setRangeDays(Number.parseInt(event.target.value, 10))}
          >
            <option value={1}>24 小时</option>
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
          </select>
        }
      >
        <State loading={status.isLoading} error={status.error} empty={(page?.channels.length ?? 0) === 0} retry={() => status.refetch()} emptyAction={undefined}>
          {page && <ChannelStatusTable page={page} />}
        </State>
        {page && (
          <p className="quiet-note">
            错误分类版本 {page.taxonomyVersion}；数据由通道状态聚合 worker 每分钟回填，窗口存在数分钟延迟。
          </p>
        )}
      </Panel>
    </>
  );
}

function ChannelStatusTable({ page }: { page: OpsChannelStatusPage }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>通道 / 提供方</th>
            <th>路由</th>
            <th>模型</th>
            <th>请求</th>
            <th>错误</th>
            <th>可用率</th>
            <th>主要错误分类</th>
            <th>最近错误</th>
          </tr>
        </thead>
        <tbody>
          {page.channels.map((channel) => (
            <tr key={`${channel.providerId}|${channel.routeId}|${channel.model}`}>
              <td>{channel.providerId}</td>
              <td>{channel.routeId}</td>
              <td>{channel.model}</td>
              <td>{formatNumber(channel.requests)}</td>
              <td>{formatNumber(channel.errors)}</td>
              <td>
                <AvailabilityBadge availability={channel.availability} />
              </td>
              <td>
                {channel.topErrorCategories.length === 0
                  ? '—'
                  : channel.topErrorCategories
                      .map((entry) => `${entry.category} (${formatNumber(entry.errors)})`)
                      .join('、')}
              </td>
              <td>{formatDate(channel.lastErrorAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AvailabilityBadge({ availability }: { availability: number }) {
  const percent = availability * 100;
  const tone = percent >= 99 ? 'good' : percent >= 95 ? 'warn' : 'bad';
  return (
    <Badge tone={tone}>
      {percent.toFixed(2)}%
    </Badge>
  );
}

type OpsQpsStreamState =
  | { kind: 'connecting' }
  | { kind: 'live'; snapshot: OpsQpsSnapshot }
  | { kind: 'error' };

function useOpsQpsStream(): OpsQpsStreamState {
  const [state, setState] = useState<OpsQpsStreamState>({ kind: 'connecting' });
  useEffect(() => {
    const source = new EventSource(OPS_QPS_STREAM_PATH);
    source.addEventListener('snapshot', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as OpsQpsSnapshot;
        if (
          typeof parsed?.qps === 'number' &&
          parsed.statusCounts &&
          typeof parsed.statusCounts.ok === 'number'
        ) {
          setState({ kind: 'live', snapshot: parsed });
        }
      } catch {
        // A malformed frame is dropped; the next push replaces it.
      }
    });
    source.onerror = () => {
      // EventSource retries automatically; surface the degraded state only.
      setState((current) => (current.kind === 'live' ? current : { kind: 'error' }));
    };
    return () => source.close();
  }, []);
  return state;
}
