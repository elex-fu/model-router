import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  platformClient,
  type OpsMediaTaskPage,
} from '../api/saas-platform-client';
import { Badge, Panel, State, formatDate, formatNumber } from '../components/ui';

/**
 * Gap-remediation plan G-C2 (§9): the task-operations console page —
 * 已接受/生成中/交付失败/待结算 with the G-A1 recovery record (lease owner,
 * due cursor, poll failures). Read-only; the underlying projection is the
 * admin /ops/media-tasks route (secret-free by construction).
 *
 * A deliberately small, standalone feature file — the saas-platform.tsx
 * split rule (no new pages inside the 3400-line module).
 */

type KindFilter = 'all' | 'image' | 'video';

export function MediaTaskOperationsPage() {
  const [kind, setKind] = useState<KindFilter>('all');
  const [includeTerminal, setIncludeTerminal] = useState(true);
  const page = useQuery({
    queryKey: ['ops-media-tasks', kind, includeTerminal],
    queryFn: () =>
      platformClient.listOpsMediaTasks({
        ...(kind === 'all' ? {} : { kind }),
        limit: 100,
        includeTerminal,
      }),
    refetchInterval: 10_000,
  });

  return (
    <div className="stack">
      <Panel title="任务运营">
        <p className="muted">
          异步媒体任务的调度健康视图：生命周期状态与自动恢复记录（G-A1 恢复循环：无人轮询结算、进程死亡接管）。
          只读投影，不含载荷、URL 或金额（账务核对在请求视图）。
        </p>
        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            类型{' '}
            <select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}>
              <option value="all">全部</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeTerminal}
              onChange={(event) => setIncludeTerminal(event.target.checked)}
            />{' '}
            包含已终结任务
          </label>
          {page.data !== undefined ? <CountsRow page={page.data} /> : null}
        </div>
      </Panel>

      <Panel title="任务列表">
        {page.isLoading ? (
          <State loading>加载中…</State>
        ) : page.isError ? (
          <State error>任务投影不可用</State>
        ) : page.data === undefined || page.data.rows.length === 0 ? (
          <State empty>当前没有符合条件的任务</State>
        ) : (
          <TaskTable rows={page.data.rows} />
        )}
      </Panel>
    </div>
  );
}

function CountsRow({ page }: { page: OpsMediaTaskPage }) {
  return (
    <span className="muted" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <span>共 {formatNumber(page.counts.total)}</span>
      <span>进行中 {formatNumber(page.counts.processing)}</span>
      <span>待结算 {formatNumber(page.counts.terminalUnsettled)}</span>
      <span>恢复活跃 {formatNumber(page.counts.recoveryActive)}</span>
    </span>
  );
}

function statusBadge(status: string): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  switch (status) {
    case 'processing':
      return { label: '生成中', tone: 'neutral' };
    case 'pending':
      return { label: '待结算', tone: 'warn' };
    case 'billed':
      return { label: '已结算', tone: 'good' };
    case 'completed':
      return { label: '已完成', tone: 'good' };
    case 'skipped':
    case 'failed':
      return { label: '失败/跳过', tone: 'bad' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

function TaskTable({
  rows,
}: {
  rows: OpsMediaTaskPage['rows'];
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>类型</th>
          <th>任务 ID</th>
          <th>状态</th>
          <th>恢复租约</th>
          <th>轮询失败</th>
          <th>下次到期</th>
          <th>创建时间</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const badge = statusBadge(row.status);
          return (
            <tr key={`${row.kind}:${row.taskId}`}>
              <td>{row.kind === 'video' ? '视频' : '图片'}</td>
              <td title={row.taskId}>{row.taskId.slice(0, 18)}…</td>
              <td>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </td>
              <td className="muted">{row.recovery?.leaseOwner ?? '—'}</td>
              <td className="muted">{row.recovery?.pollFailures ?? '—'}</td>
              <td className="muted">
                {row.recovery?.nextPollAt !== undefined && row.recovery?.nextPollAt !== null
                  ? formatDate(row.recovery.nextPollAt)
                  : '—'}
              </td>
              <td className="muted">{formatDate(row.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
