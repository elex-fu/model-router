import { type FormEvent, useEffect, useState } from 'react';
import {
  PlatformApiError,
  clearPlatformCsrfToken,
  platformClient,
  type PlatformEgressProxy,
  type PlatformEgressProxyProtocol,
  type PlatformEgressProxyUpsertInput,
} from '../api/saas-platform-client';
import { Badge, Field, Panel, SaveButton, formatDate } from '../components/ui';
import { PlatformErrorNotice, canManageSupply, type MeState } from './saas-platform-shared';

/**
 * F5 console surface (task #38): the egress-proxy management page (R3).
 * Credentials are write-only: the edit form never pre-fills them, the list
 * shows only a “已配置凭证” badge, and the assembled URL is never displayed.
 */

const PROTOCOLS: readonly PlatformEgressProxyProtocol[] = ['http', 'https', 'socks5', 'socks5h'];

interface ProxyDraft {
  name: string;
  protocol: PlatformEgressProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  credentialsMode: 'keep' | 'set' | 'clear';
  status: 'active' | 'inactive';
  expiresAt: string;
  fallbackMode: 'none' | 'proxy' | 'direct';
  backupProxyId: string;
}

function emptyDraft(): ProxyDraft {
  return {
    name: '',
    protocol: 'socks5h',
    host: '',
    port: '1080',
    username: '',
    password: '',
    credentialsMode: 'set',
    status: 'active',
    expiresAt: '',
    fallbackMode: 'none',
    backupProxyId: '',
  };
}

function draftFromProxy(proxy: PlatformEgressProxy): ProxyDraft {
  return {
    name: proxy.name,
    protocol: (PROTOCOLS as readonly string[]).includes(proxy.protocol)
      ? (proxy.protocol as PlatformEgressProxyProtocol)
      : 'socks5h',
    host: proxy.host,
    port: String(proxy.port),
    username: '',
    password: '',
    credentialsMode: 'keep',
    status: proxy.status === 'inactive' ? 'inactive' : 'active',
    expiresAt: proxy.expiresAt ?? '',
    fallbackMode: proxy.fallbackMode === 'proxy' || proxy.fallbackMode === 'direct' ? proxy.fallbackMode : 'none',
    backupProxyId: proxy.backupProxyId ?? '',
  };
}

/** Local datetime input → ISO timestamp; empty stays empty (no expiry). */
function localDateTimeToIso(value: string): string | null {
  if (value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function proxyDraftToUpsert(draft: ProxyDraft): PlatformEgressProxyUpsertInput {
  if (draft.name.trim() === '') throw new Error('代理名称必填。');
  if (draft.host.trim() === '') throw new Error('主机名必填。');
  const port = Number(draft.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数。');
  if (draft.fallbackMode === 'proxy' && draft.backupProxyId.trim() === '') {
    throw new Error('proxy 回退模式必须选择备份代理。');
  }
  if (draft.fallbackMode !== 'proxy' && draft.backupProxyId.trim() !== '') {
    throw new Error('只有 proxy 回退模式可以配置备份代理。');
  }
  const expiresAt = localDateTimeToIso(draft.expiresAt);
  if (draft.expiresAt !== '' && expiresAt === null) throw new Error('过期时间无效。');
  const credentials =
    draft.credentialsMode === 'keep'
      ? undefined
      : draft.credentialsMode === 'clear'
        ? null
        : {
            ...(draft.username === '' ? {} : { username: draft.username }),
            ...(draft.password === '' ? {} : { password: draft.password }),
          };
  if (draft.credentialsMode === 'set' && credentials && Object.keys(credentials).length === 0) {
    throw new Error('设置凭证时至少填写用户名或密码。');
  }
  return {
    name: draft.name.trim(),
    protocol: draft.protocol,
    host: draft.host.trim(),
    port,
    ...(credentials === undefined ? {} : { credentials }),
    status: draft.status,
    expiresAt,
    fallbackMode: draft.fallbackMode,
    backupProxyId: draft.fallbackMode === 'proxy' ? draft.backupProxyId.trim() : null,
  };
}

function probeQualityBadge(quality: string | null): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  switch (quality) {
    case 'ok':
      return { label: '正常', tone: 'good' };
    case 'degraded':
      return { label: '降级', tone: 'warn' };
    case 'dead':
      return { label: '失联', tone: 'bad' };
    default:
      return { label: '未探测', tone: 'neutral' };
  }
}

function statusBadge(status: string): { label: string; tone: 'good' | 'warn' | 'neutral' } {
  if (status === 'active') return { label: '启用', tone: 'good' };
  if (status === 'expired') return { label: '已过期', tone: 'warn' };
  return { label: '停用', tone: 'neutral' };
}

export function EgressProxiesPage({ me }: { me: MeState }) {
  const canWrite = canManageSupply(me);
  const [proxies, setProxies] = useState<PlatformEgressProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<'none' | 'create' | 'edit'>('none');
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<ProxyDraft>(() => emptyDraft());
  const [writeError, setWriteError] = useState<unknown>();
  const [writeNotice, setWriteNotice] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState<string>();
  const [deleteError, setDeleteError] = useState<unknown>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void platformClient
      .listEgressProxies({ signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setProxies(result);
      })
      .catch(loadError => {
        if (!controller.signal.aborted) setError(loadError);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setWriteError(undefined);
    setWriteNotice('');
    let input: PlatformEgressProxyUpsertInput;
    try {
      input = proxyDraftToUpsert(draft);
    } catch (validationError) {
      setWriteError(validationError);
      return;
    }
    setWriteBusy(true);
    try {
      if (editing === 'create') {
        await platformClient.createEgressProxy(input);
        setWriteNotice(`代理 ${input.name} 已创建；凭证已在服务端密封。`);
      } else if (editingId !== undefined) {
        await platformClient.updateEgressProxy(editingId, input);
        setWriteNotice(`代理 ${input.name} 已更新。`);
      }
      setEditing('none');
      setEditingId(undefined);
      setReloadKey(value => value + 1);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setWriteError(failure);
    } finally {
      setWriteBusy(false);
    }
  }

  async function remove(proxy: PlatformEgressProxy) {
    setDeleteError(undefined);
    setDeleteBusy(proxy.id);
    try {
      await platformClient.deleteEgressProxy(proxy.id);
      setWriteNotice(`代理 ${proxy.name} 已删除。`);
      setReloadKey(value => value + 1);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setDeleteError(failure);
    } finally {
      setDeleteBusy(undefined);
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">供给</p>
          <h1>出口代理</h1>
          <p>账号出口 IP 统一管理；凭证只写入一次、服务端密封，永不回显。</p>
        </div>
      </div>
      <div className="notice" role="note">
        <strong>固定出口 IP 原则</strong>
        <span>转发、OAuth 刷新与探测共用同一代理，避免混合出口 IP 触发风控。socks5 会自动升级为 socks5h（远端 DNS）。</span>
      </div>
      {writeError !== undefined && <PlatformErrorNotice error={writeError} title="代理写入失败" />}
      {deleteError !== undefined && <PlatformErrorNotice error={deleteError} title="代理删除失败" />}
      {writeNotice && (
        <div className="notice" role="status">
          <strong>状态更新</strong>
          <span>{writeNotice}</span>
        </div>
      )}

      {canWrite && editing === 'none' && (
        <Panel
          title="代理列表"
          action={<button type="button" className="primary" onClick={() => { setEditing('create'); setDraft(emptyDraft()); }}>新建代理</button>}
        >
          {loading && <div className="skeleton" role="status" aria-label="正在加载代理"><i /><i /><i /></div>}
          {!loading && error !== undefined && (
            <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="代理读取失败" />
          )}
          {!loading && error === undefined && proxies.length === 0 && (
            <div className="empty" role="status">当前没有配置出口代理。</div>
          )}
          {!loading && error === undefined && proxies.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>端点</th>
                    <th>凭证</th>
                    <th>探测质量</th>
                    <th>回退</th>
                    <th>状态 / 过期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {proxies.map(proxy => {
                    const quality = probeQualityBadge(proxy.lastProbeQuality);
                    const status = statusBadge(proxy.status);
                    return (
                      <tr key={proxy.id}>
                        <td>{proxy.name}</td>
                        <td><code>{proxy.protocol}://{proxy.host}:{proxy.port}</code></td>
                        <td>{proxy.hasCredentials ? <Badge tone="neutral">已配置</Badge> : <Badge tone="neutral">无</Badge>}</td>
                        <td>
                          <Badge tone={quality.tone}>{quality.label}</Badge>
                          {proxy.lastProbeLatencyMs !== null && <small> {proxy.lastProbeLatencyMs}ms</small>}
                          {proxy.lastProbeAt && <small>（{formatDate(proxy.lastProbeAt)}）</small>}
                        </td>
                        <td>
                          {proxy.fallbackMode === 'proxy'
                            ? `proxy → ${proxy.backupProxyId ?? ''}`
                            : proxy.fallbackMode === 'direct'
                              ? 'direct'
                              : 'none'}
                        </td>
                        <td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {proxy.expiresAt && <small> 至 {formatDate(proxy.expiresAt)}</small>}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setEditing('edit');
                              setEditingId(proxy.id);
                              setDraft(draftFromProxy(proxy));
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={deleteBusy !== undefined}
                            onClick={() => void remove(proxy)}
                          >
                            {deleteBusy === proxy.id ? '删除中…' : '删除'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {canWrite && editing !== 'none' && (
        <Panel title={editing === 'create' ? '新建出口代理' : `编辑代理 ${draft.name}`}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label="名称">
                <input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="primary-exit" />
              </Field>
              <Field label="协议" hint="socks5 自动升级为 socks5h（远端 DNS）">
                <select value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value as PlatformEgressProxyProtocol })}>
                  {PROTOCOLS.map(protocol => (
                    <option key={protocol} value={protocol}>{protocol}</option>
                  ))}
                </select>
              </Field>
              <Field label="主机">
                <input value={draft.host} onChange={event => setDraft({ ...draft, host: event.target.value })} placeholder="proxy.example.test" />
              </Field>
              <Field label="端口">
                <input inputMode="numeric" value={draft.port} onChange={event => setDraft({ ...draft, port: event.target.value })} />
              </Field>
              <Field label="状态">
                <select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as 'active' | 'inactive' })}>
                  <option value="active">启用</option>
                  <option value="inactive">停用</option>
                </select>
              </Field>
              <Field label="过期时间" hint="过期后由扫描任务按回退策略迁移账号">
                <input type="datetime-local" value={draft.expiresAt} onChange={event => setDraft({ ...draft, expiresAt: event.target.value })} />
              </Field>
              <Field label="回退模式" hint="none = 仅告警；proxy = 迁移到备份；direct = 解除代理">
                <select value={draft.fallbackMode} onChange={event => setDraft({ ...draft, fallbackMode: event.target.value as 'none' | 'proxy' | 'direct' })}>
                  <option value="none">none（仅审计告警）</option>
                  <option value="proxy">proxy（迁移到备份）</option>
                  <option value="direct">direct（解除代理）</option>
                </select>
              </Field>
              {draft.fallbackMode === 'proxy' && (
                <Field label="备份代理 ID">
                  <select value={draft.backupProxyId} onChange={event => setDraft({ ...draft, backupProxyId: event.target.value })}>
                    <option value="">选择备份代理…</option>
                    {proxies.filter(proxy => proxy.id !== editingId).map(proxy => (
                      <option key={proxy.id} value={proxy.id}>{proxy.name}（{proxy.id}）</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="form-grid">
              <Field label="凭证" hint="只写一次，服务端 KMS 密封；保存后不再回显">
                <select
                  value={draft.credentialsMode}
                  onChange={event => setDraft({ ...draft, credentialsMode: event.target.value as 'keep' | 'set' | 'clear' })}
                >
                  {editing === 'create' ? <option value="set">设置凭证</option> : <option value="keep">保留现有凭证</option>}
                  {editing === 'edit' && <option value="set">替换凭证</option>}
                  {editing === 'edit' && <option value="clear">清除凭证</option>}
                </select>
              </Field>
              {draft.credentialsMode === 'set' && (
                <>
                  <Field label="用户名">
                    <input autoComplete="off" value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} />
                  </Field>
                  <Field label="密码">
                    <input type="password" autoComplete="new-password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} />
                  </Field>
                </>
              )}
            </div>
            <div className="actions">
              <SaveButton busy={writeBusy}>{editing === 'create' ? '创建' : '保存'}</SaveButton>
              <button type="button" onClick={() => { setEditing('none'); setEditingId(undefined); }}>取消</button>
            </div>
          </form>
        </Panel>
      )}

      {!canWrite && (
        <Panel title="代理列表">
          {loading && <div className="skeleton" role="status" aria-label="正在加载代理"><i /><i /><i /></div>}
          {!loading && error !== undefined && (
            <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="代理读取失败" />
          )}
          {!loading && error === undefined && proxies.length === 0 && (
            <div className="empty" role="status">当前没有配置出口代理。</div>
          )}
          {!loading && error === undefined && proxies.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>名称</th><th>端点</th><th>探测质量</th><th>回退</th><th>状态</th></tr>
                </thead>
                <tbody>
                  {proxies.map(proxy => {
                    const quality = probeQualityBadge(proxy.lastProbeQuality);
                    const status = statusBadge(proxy.status);
                    return (
                      <tr key={proxy.id}>
                        <td>{proxy.name}</td>
                        <td><code>{proxy.protocol}://{proxy.host}:{proxy.port}</code></td>
                        <td><Badge tone={quality.tone}>{quality.label}</Badge></td>
                        <td>{proxy.fallbackMode}</td>
                        <td><Badge tone={status.tone}>{status.label}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
