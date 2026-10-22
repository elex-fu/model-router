import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { PlatformApiError } from '../api/saas-platform-client';
import { platformValidationClient, type ValidationRequeueInput } from '../api/saas-platform-validation-client';

export function ValidationRequeueControl({ accountId, credentialId, canManage }: {
  accountId: string;
  credentialId: string;
  canManage: boolean;
}) {
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<{ key: string; input: ValidationRequeueInput } | null>(null);
  const status = useQuery({
    queryKey: ['platform-validation-requeue', accountId, credentialId],
    queryFn: () => platformValidationClient.getStatus(accountId, credentialId),
    enabled: canManage,
    staleTime: 10_000,
  });

  async function submit() {
    if (busy) return;
    if (!pending.current) {
      const current = status.data;
      if (current?.state !== 'ready' || current.jobId === null || current.credentialVersion === null || current.credentialAuthzVersion === null || current.leaseGeneration === null || !reason.trim()) return;
      if (!window.confirm(`重新验证账号 ${accountId} 的凭据？\n原因：${reason.trim()}\n验证成功后账号才会恢复可调度状态。`)) return;
      pending.current = {
        key: crypto.randomUUID(),
        input: { jobId: current.jobId, expectedCredentialVersion: current.credentialVersion,
          expectedCredentialAuthzVersion: current.credentialAuthzVersion, expectedLeaseGeneration: current.leaseGeneration,
          reason: reason.trim() },
      };
    }
    const command = pending.current;
    setBusy(true);
    setMessage('');
    try {
      await platformValidationClient.requeue(accountId, credentialId, command.input, command.key);
      pending.current = null;
      setMessage('已进入验证队列，等待验证结果。');
      await status.refetch();
      await client.invalidateQueries({ queryKey: ['ops-scheduling-health'] });
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 409) {
        pending.current = null;
        setMessage('验证状态已变化，已刷新；请检查后重新提交。');
        await status.refetch();
      } else if (error instanceof PlatformApiError && [400, 401, 403].includes(error.status)) {
        pending.current = null;
        setMessage('无法提交验证重试，请检查原因和操作权限。');
      } else {
        setMessage('暂未确认是否入队，请重试同一请求。');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) return null;
  if (status.data?.state !== 'ready' && !pending.current) return message ? <span role="status">{message}</span> : null;
  return <div className="stack" aria-live="polite">
    <label>验证重试原因
      <input value={reason} maxLength={512} disabled={busy || pending.current !== null}
        placeholder="填写操作原因，请勿包含密钥" onChange={(event) => setReason(event.target.value)} />
    </label>
    <button type="button" disabled={busy || (!pending.current && !reason.trim())} onClick={() => void submit()}>
      {busy ? '提交中…' : pending.current ? '重试同一请求' : '重新验证凭据'}
    </button>
    {message ? <span role="status">{message}</span> : null}
  </div>;
}
