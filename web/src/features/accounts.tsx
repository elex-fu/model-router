import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../api/client';
import type { Account, Capability } from '../api/types';
import { Badge, ErrorNotice, Field, Panel, State, formatDate } from '../components/ui';

export function Accounts() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<{ id: string; verificationUri?: string; userCode?: string }>();
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => (await get<Account[]>('/accounts')).data,
  });
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: async () => {
      const data = (await get<Capability[] | { deviceFlowProviders?: string[]; clientCredentialsProviders?: string[] }>('/capabilities')).data;
      return Array.isArray(data)
        ? data
        : [...new Set([...(data.deviceFlowProviders ?? []), ...(data.clientCredentialsProviders ?? [])])].map((item) => ({
            provider: item,
            deviceFlow: data.deviceFlowProviders?.includes(item),
            clientCredentials: data.clientCredentialsProviders?.includes(item),
          }));
    },
  });
  const capability = capabilities.data?.find((item) => item.provider === provider);
  const canAddClientCredentials = capabilities.isSuccess && capabilities.data.some((item) => item.clientCredentials);
  const noVerifiedOAuthProviders = capabilities.isSuccess && !capabilities.data.some((item) => item.deviceFlow || item.clientCredentials);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!canAddClientCredentials) return;
    setBusy(true);
    setError(undefined);
    try {
      await post('/accounts/client-credentials', { provider, name, clientId, clientSecret: secret });
      setSecret('');
      setClientId('');
      setName('');
      await qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, type: 'refresh' | 'default' | 'delete') {
    try {
      if (type === 'delete') {
        if (!confirm('解绑账号？历史记录仍会保留。')) return;
        await del(`/accounts/${id}`);
      } else if (type === 'refresh') {
        await post(`/accounts/${id}/refresh`, {});
      } else {
        await patch(`/accounts/${id}`, { isDefault: true });
      }
      await qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (err) {
      setError(err);
    }
  }

  async function startFlow() {
    if (!capability?.deviceFlow) return;
    setError(undefined);
    try {
      const result = await post<{ id: string; verificationUri?: string; userCode?: string }>('/accounts/device-flows', { provider });
      setFlow(result.data);
    } catch (err) {
      setError(err);
    }
  }

  return <>
    <div className="page-title">
      <div><p className="eyebrow">IDENTITIES</p><h1>账号授权</h1><p>管理上游 OAuth 账号与客户端凭证</p></div>
    </div>
    <ErrorNotice error={error} />
    {noVerifiedOAuthProviders && <p className="notice" role="status">当前没有任何经过验证的 OAuth provider。Kimi、DeepSeek 和自定义上游请在上游设置中配置 API key。</p>}
    <div className="grid-two">
      <Panel title="已连接账号">
        <State loading={accounts.isPending} error={accounts.error} retry={() => accounts.refetch()} empty={!accounts.data?.length}>
          <div className="rows">
            {accounts.data?.map((account) => <div className="account-row" key={`${account.provider}:${account.id}`}>
              <div>
                <strong>{account.name ?? account.id}</strong>
                <small>{account.provider} · {account.type} · 到期 {formatDate(account.expiresAt)}</small>
                {account.lastError && <small className="form-error">{account.lastError}</small>}
              </div>
              <Badge tone={account.status === 'active' ? 'good' : 'warn'}>{account.status}</Badge>
              <div className="actions">
                <button onClick={() => action(account.id, 'refresh')} disabled={!account.refreshAvailable}
                  title={!account.refreshAvailable ? '该 provider 的刷新流程尚未验证，当前不可用' : undefined}>
                  {account.refreshAvailable ? '刷新' : '刷新（未验证）'}
                </button>
                <button onClick={() => action(account.id, 'default')} disabled={account.isDefault}>设默认</button>
                <button onClick={() => action(account.id, 'delete')}>解绑</button>
              </div>
            </div>)}
          </div>
        </State>
      </Panel>
      <div className="detail-column">
        <Panel title="新增客户端凭证">
          <form onSubmit={add}>
            <Field label="供应商">
              <select required value={provider} onChange={(event) => setProvider(event.target.value)} disabled={!canAddClientCredentials}>
                <option value="">选择供应商</option>
                {capabilities.data?.filter((item) => item.clientCredentials).map((item) => <option key={item.provider} value={item.provider}>{item.provider}</option>)}
              </select>
            </Field>
            <Field label="名称"><input required value={name} onChange={(event) => setName(event.target.value)} disabled={!canAddClientCredentials} /></Field>
            <Field label="Client ID"><input required value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={!canAddClientCredentials} /></Field>
            <Field label="Client Secret"><input required type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={!canAddClientCredentials} /></Field>
            <button className="primary" type="submit" disabled={busy || !canAddClientCredentials}>{busy ? '处理中…' : '添加账号'}</button>
          </form>
        </Panel>
        <Panel title="设备授权">
          <p className="muted">仅在服务端明确声明支持时可启动。</p>
          <button disabled={!capability?.deviceFlow} onClick={startFlow}>启动设备授权</button>
          {flow && <div className="notice">
            <p>授权代码：<code>{flow.userCode ?? '—'}</code></p>
            {flow.verificationUri && <a href={flow.verificationUri} target="_blank" rel="noreferrer">打开授权页面 ↗</a>}
            <button onClick={() => { del(`/accounts/device-flows/${flow.id}`).then(() => setFlow(undefined)).catch(setError); }}>取消授权</button>
          </div>}
        </Panel>
      </div>
    </div>
  </>;
}
