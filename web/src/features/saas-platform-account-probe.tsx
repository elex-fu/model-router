import { useEffect, useState } from 'react';
import {
  PlatformApiError,
  clearPlatformCsrfToken,
  platformClient,
  type PlatformProbeMonitorTriggerResult,
  type PlatformProbeMonitorView,
  type PlatformSupplyAccount,
} from '../api/saas-platform-client';
import { Badge, Panel, formatDate } from '../components/ui';
import { PlatformErrorNotice } from './saas-platform-shared';

/**
 * F5 console surface (task #38): the R6a probe-monitor console button. One
 * trigger button per selected platform supply account plus the last probe
 * result badge — deliberately minimal (the plan's console button note). The
 * probe itself executes asynchronously in the probe monitor worker; the
 * trigger only marks the monitor due.
 */

function resultBadge(lastResult: string | null): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  switch (lastResult) {
    case 'success':
      return { label: '通过', tone: 'good' };
    case 'failure':
      return { label: '失败', tone: 'bad' };
    case null:
      return { label: '无结果', tone: 'neutral' };
    default:
      return { label: lastResult, tone: 'warn' };
  }
}

export function AccountProbePanel({ account }: { account: PlatformSupplyAccount }) {
  const [monitor, setMonitor] = useState<PlatformProbeMonitorView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void platformClient
      .listProbeMonitors({ ownerKind: 'platform', accountId: account.id, limit: 1 }, { signal: controller.signal })
      .then(monitors => {
        if (!controller.signal.aborted) setMonitor(monitors[0]);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [account.id, reloadKey]);

  async function trigger() {
    setError(undefined);
    setNotice('');
    setBusy(true);
    try {
      const result: PlatformProbeMonitorTriggerResult = await platformClient.triggerProbeMonitor({
        ownerKind: 'platform',
        accountId: account.id,
      });
      setNotice(`探测已排队（监控 ${result.monitorId}）；worker 将以 triggered_by=manual 执行并回写结果。`);
      setReloadKey(value => value + 1);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      if (failure instanceof PlatformApiError && failure.status === 422) {
        setError(new Error('该供应商账号没有可用的探测类别。'));
        return;
      }
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const badge = resultBadge(monitor?.lastResult ?? null);

  return (
    <Panel
      title="主动探测"
      action={
        <button type="button" className="primary" disabled={busy} onClick={() => void trigger()}>
          {busy ? '排队中…' : '触发探测'}
        </button>
      }
    >
      <p>
        <span><code>{account.id}</code> 的出口与凭证健康探测。探测在隔离 worker 中执行，凭证不会经过本控制台。</span>
      </p>
      {monitor === undefined ? (
        <p><small>尚无探测监控记录；点击“触发探测”创建并排队。</small></p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>上次结果</th><th>连续失败</th><th>上次执行</th><th>下次到期</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><Badge tone={badge.tone}>{badge.label}</Badge></td>
                <td>{monitor.consecutiveFailures} / {monitor.failureThreshold}</td>
                <td>{formatDate(monitor.lastRunAt)}</td>
                <td>{formatDate(monitor.nextDueAt)}</td>
                <td>{monitor.enabled ? <Badge tone="good">启用</Badge> : <Badge tone="warn">停用</Badge>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {error !== undefined && <PlatformErrorNotice error={error} title="探测触发失败" />}
      {notice && (
        <div className="notice" role="status">
          <strong>状态更新</strong>
          <span>{notice}</span>
        </div>
      )}
    </Panel>
  );
}
