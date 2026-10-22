import { useQuery } from '@tanstack/react-query';
import { saasBackupClient } from '../api/saas-backup-client';
import { Badge, formatDate, Panel, State } from '../components/ui';

const reasons: Record<string, string> = {
  BACKUP_POLICY_REQUIRED: '尚未配置 PostgreSQL 备份或 PITR 策略',
  BACKUP_RPO_EXCEEDED: '恢复点已超过允许的数据丢失窗口',
  OFFSITE_BACKUP_UNVERIFIED: '缺少已核验的异地副本',
  RESTORE_VERIFICATION_REQUIRED: '缺少近期有效的恢复演练回执',
  RESTORE_RTO_EXCEEDED: '恢复耗时超过目标',
  LATEST_BACKUP_ATTEMPT_FAILED: '最近一次备份检查失败，需处理后重试',
};

export function BackupOperationsPanel() {
  const status = useQuery({ queryKey: ['ops-backup-status'], queryFn: () => saasBackupClient.status(), refetchInterval: 30_000 });
  const data = status.data;
  return (
    <Panel title="PostgreSQL 备份与恢复" action={<button type="button" onClick={() => void status.refetch()}>刷新</button>}>
      {status.isLoading ? <State loading>加载备份证据…</State> : status.isError ? (
        <State error={status.error} retry={() => void status.refetch()}>备份状态不可用</State>
      ) : data ? (
        <div className="stack">
          <div className="row">
            <Badge tone={data.readiness.ok ? 'good' : 'warn'}>{data.readiness.ok ? '恢复保护已核验' : '需要处置'}</Badge>
            {data.policy ? <span>{data.policy.sourceId} · {data.policy.mode === 'external-pitr' ? '外部 PITR' : '逻辑备份与异地副本'}</span> : null}
          </div>
          {data.readiness.reasons.length > 0 ? <ul>{data.readiness.reasons.map((reason) => <li key={reason}>{reasons[reason] ?? reason}</li>)}</ul> : null}
          {data.policy ? <p className="muted">RPO {data.policy.rpoSeconds} 秒 · RTO {data.policy.rtoSeconds} 秒 · 异地保留 {data.policy.retentionDays} 天 · 检查间隔 {data.policy.scheduleIntervalSeconds} 秒</p> : null}
          <dl>
            <dt>最近恢复点</dt><dd>{formatDate(data.latestBackup?.recoveryPointAt)}</dd>
            <dt>异地副本</dt><dd>{data.latestBackup?.offsiteVerified ? '已核验加密与保留策略' : '尚未核验'}</dd>
            <dt>最近恢复演练</dt><dd>{formatDate(data.latestRestore?.completedAt)}{data.latestRestore ? ` · ${Math.ceil(data.latestRestore.durationMs / 1000)} 秒` : ''}</dd>
            <dt>恢复回执</dt><dd className="mono">{data.latestRestore?.id ?? '—'}</dd>
            <dt>最近计划执行</dt><dd>{formatDate(data.latestAttempt?.completedAt)}{data.latestAttempt?.code ? ` · ${data.latestAttempt.code}` : ''}</dd>
          </dl>
          <p className="muted">生产恢复还需完成账务、支付与用量对账，并确认权限撤销恢复屏障后开放业务。运维人员通过备份命令和恢复演练生成回执。</p>
        </div>
      ) : null}
    </Panel>
  );
}
