import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { get, query, timeWindow } from '../api/client';
import type { Attempt, RequestRow } from '../api/types';
import {
  Badge,
  Panel,
  State,
  formatDate,
  formatNumber,
} from '../components/ui';
import './requests.css';

export function Requests() {
  const { id } = useParams();
  return id ? <RequestDetail id={id} /> : <RequestList />;
}

function RequestList() {
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const filters = {
    cursor: params.get('cursor') ?? undefined,
    status: params.get('status') ?? undefined,
    model: params.get('model') ?? undefined,
    keyId: params.get('keyId') ?? undefined,
    upstreamId: params.get('upstreamId') ?? undefined,
    ...timeWindow(params.get('range') ?? '24h'),
  };
  const rows = useQuery({
    queryKey: ['requests', filters],
    queryFn: () => get<RequestRow[]>('/requests' + query(filters)),
    placeholderData: (previous) => previous,
    refetchInterval: filters.cursor ? false : 30000,
  });
  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'cursor') next.delete('cursor');
    setParams(next);
  }
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">TRACE</p>
          <h1>请求日志</h1>
          <p>逐个逻辑请求与尝试链</p>
        </div>
      </div>
      <div className="filters">
        <select
          aria-label="状态"
          value={filters.status ?? ''}
          onChange={(event) => set('status', event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="succeeded">成功</option>
          <option value="failed">失败</option>
          <option value="cancelled">取消</option>
        </select>
        <input
          aria-label="模型筛选"
          placeholder="模型"
          value={filters.model ?? ''}
          onChange={(event) => set('model', event.target.value)}
        />
        <input
          aria-label="Key ID 筛选"
          placeholder="Key ID"
          value={filters.keyId ?? ''}
          onChange={(event) => set('keyId', event.target.value)}
        />
        <input
          aria-label="上游 ID 筛选"
          placeholder="上游 ID"
          value={filters.upstreamId ?? ''}
          onChange={(event) => set('upstreamId', event.target.value)}
        />
      </div>
      <Panel title="请求">
        <State
          loading={rows.isPending}
          error={rows.error}
          retry={() => rows.refetch()}
          empty={!rows.data?.data.length}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>请求 ID</th>
                  <th>模型</th>
                  <th>上游</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                {rows.data?.data.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDate(row.startedAt)}</td>
                    <td>
                      <Link
                        to={`/requests/${encodeURIComponent(row.id)}${search}`}
                      >
                        <code>{row.requestId ?? row.id}</code>
                      </Link>
                    </td>
                    <td>
                      {row.requestedModel ?? '—'}
                      <small>
                        {row.actualModel &&
                        row.actualModel !== row.requestedModel
                          ? `→ ${row.actualModel}`
                          : ''}
                      </small>
                    </td>
                    <td>{row.upstreamId ?? '—'}</td>
                    <td>
                      <Badge
                        tone={
                          row.status === 'succeeded'
                            ? 'good'
                            : row.status === 'failed'
                              ? 'bad'
                              : 'warn'
                        }
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td>
                      {row.durationMs == null
                        ? '—'
                        : `${formatNumber(row.durationMs)} ms`}
                    </td>
                    <td>
                      {row.usageStatus === 'missing'
                        ? '未知'
                        : `${formatNumber(row.inputTokens)} / ${formatNumber(row.outputTokens)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button
              disabled={!filters.cursor}
              onClick={() => set('cursor', '')}
            >
              第一页
            </button>
            <button
              disabled={!rows.data?.meta?.nextCursor}
              onClick={() => set('cursor', rows.data?.meta?.nextCursor ?? '')}
            >
              下一页
            </button>
          </div>
        </State>
      </Panel>
    </>
  );
}

function RequestDetail({ id }: { id: string }) {
  const { search } = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const path = `/requests/${encodeURIComponent(id)}`;
  const detail = useQuery({
    queryKey: ['request', id],
    queryFn: async () => (await get<RequestRow>(path)).data,
  });
  const attempts = useQuery({
    queryKey: ['attempts', id],
    queryFn: async () => (await get<Attempt[]>(`${path}/attempts`)).data,
  });

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    heading.current?.focus({ preventScroll: true });
  }, [id]);

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">TRACE</p>
          <h1 ref={heading} tabIndex={-1}>
            请求详情
          </h1>
          <p>请求信息与上游尝试链</p>
        </div>
        <Link className="request-back" to={`/requests${search}`}>
          ← 返回请求日志
        </Link>
      </div>
      <Panel title="请求信息">
        <State
          loading={detail.isPending}
          error={detail.error}
          retry={() => detail.refetch()}
        >
          <div className="summary-list request-detail-summary">
            <div>
              <span>请求 ID</span>
              <code>{detail.data?.requestId ?? id}</code>
            </div>
            <div>
              <span>开始时间</span>
              <strong>{formatDate(detail.data?.startedAt)}</strong>
            </div>
            <div>
              <span>请求模型</span>
              <strong>{detail.data?.requestedModel ?? '—'}</strong>
            </div>
            <div>
              <span>实际模型</span>
              <strong>{detail.data?.actualModel ?? '—'}</strong>
            </div>
            <div>
              <span>最终上游</span>
              <strong>{detail.data?.upstreamId ?? '—'}</strong>
            </div>
            <div>
              <span>最终状态</span>
              <strong>{detail.data?.status ?? '—'}</strong>
            </div>
            <div>
              <span>耗时</span>
              <strong>
                {detail.data?.durationMs == null
                  ? '—'
                  : `${formatNumber(detail.data.durationMs)} ms`}
              </strong>
            </div>
            <div>
              <span>输入 / 输出 Token</span>
              <strong>
                {detail.data?.usageStatus === 'missing'
                  ? '未知'
                  : `${formatNumber(detail.data?.inputTokens)} / ${formatNumber(detail.data?.outputTokens)}`}
              </strong>
            </div>
            <div>
              <span>错误</span>
              <strong>{detail.data?.error?.message ?? '—'}</strong>
            </div>
          </div>
        </State>
      </Panel>
      <Panel title="尝试时间线">
        <State
          loading={attempts.isPending}
          error={attempts.error}
          retry={() => attempts.refetch()}
          empty={!attempts.data?.length}
        >
          <ol className="timeline">
            {attempts.data?.map((attempt) => (
              <li key={attempt.id}>
                <strong>{attempt.status}</strong> · {attempt.upstreamId ?? '—'}{' '}
                / {attempt.model ?? '—'}
                <small>
                  {formatDate(attempt.startedAt)} · {attempt.durationMs ?? '—'}{' '}
                  ms
                </small>
                {attempt.error && (
                  <p>
                    {attempt.error.code}: {attempt.error.message}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </State>
      </Panel>
    </>
  );
}
