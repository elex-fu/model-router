import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../api/client';
import type { KeyQuota, ProxyKey, Upstream } from '../api/types';
import { Badge, ErrorNotice, Field, Panel, SaveButton, State, formatDate, formatNumber } from '../components/ui';
import { clearSafeDraft, latestSafeDraftId, readSafeDraft, saveSafeDraft } from '../app/safe-drafts';

export function Keys() {
  const qc = useQueryClient(); const [selected, setSelected] = useState<ProxyKey>(); const [newKey, setNewKey] = useState(''); const [error, setError] = useState<unknown>();
  const keys = useQuery({ queryKey: ['keys'], queryFn: async () => (await get<ProxyKey[]>('/keys')).data }); const upstreams = useQuery({ queryKey: ['upstreams'], queryFn: async () => (await get<Upstream[]>('/upstreams')).data });
  useEffect(() => { const id = latestSafeDraftId('key'); if (id && id !== 'new' && !selected) setSelected(keys.data?.find(item => item.id === id)); }, [keys.data, selected]);
  async function create(data: Partial<ProxyKey>): Promise<boolean> { try { const result = await post<{ secret?: string }>('/keys', data, { idempotencyKey: crypto.randomUUID() }); setNewKey(result.data.secret ?? ''); await qc.invalidateQueries({ queryKey: ['keys'] }); setError(undefined); return true; } catch (err) { setError(err); return false; } }
  async function action(item: ProxyKey, type: 'rotate' | 'disable' | 'delete') { if (!confirm(type === 'rotate' ? '轮换后旧 Key 立即失效，继续？' : `${type === 'delete' ? '删除' : '停用'} ${item.name}？`)) return; try { if (type === 'rotate') { const r = await post<{ secret?: string; key?: string }>(`/keys/${item.id}/rotate`, {}, { idempotencyKey: crypto.randomUUID() }); setNewKey(r.data.secret ?? r.data.key ?? ''); } else if (type === 'disable') await patch(`/keys/${item.id}`, { enabled: false }); else await del(`/keys/${item.id}`); await qc.invalidateQueries({ queryKey: ['keys'] }); } catch (err) { setError(err); } }
  return <><div className="page-title"><div><p className="eyebrow">ACCESS</p><h1>访问 Key</h1><p>权限、额度与轮换</p></div></div><ErrorNotice error={error}/>{newKey && <div className="notice secret" role="status"><strong>请立即保存此 Key，仅本次显示</strong><code>{newKey}</code><button onClick={() => navigator.clipboard.writeText(newKey)}>复制</button><button onClick={() => setNewKey('')}>我已保存</button></div>}<div className="split"><Panel title="访问 Key"><State loading={keys.isPending} error={keys.error} retry={() => keys.refetch()} empty={!keys.data?.length}><div className="rows">{keys.data?.map(k => <button className="upstream-row" key={k.id} onClick={() => setSelected(k)}><div><strong>{k.name}</strong><small><code>{k.keyPrefix ?? '—'}…</code> · 最近使用 {formatDate(k.lastUsedAt)}</small></div><Badge tone={k.enabled ? 'good' : 'neutral'}>{k.enabled ? '启用' : '停用'}</Badge></button>)}</div></State></Panel><div className="detail-column"><KeyForm upstreams={upstreams.data ?? []} onSave={create}/>{selected && <><Panel title={`Key 详情 · ${selected.name}`}><div className="summary-list"><div>每日 Token 上限 <strong>{selected.dailyTokens == null ? '不限额' : formatNumber(selected.dailyTokens)}</strong></div><div>RPM <strong>{selected.rpm == null ? '不限额' : formatNumber(selected.rpm)}</strong></div><div>过期时间 <strong>{formatDate(selected.expiresAt)}</strong></div><div>模型权限 <strong>{selected.allowedModels?.length ? selected.allowedModels.join(', ') : '全部'}</strong></div></div><Quota id={selected.id}/><div className="actions"><button onClick={() => action(selected,'rotate')}>轮换</button><button onClick={() => action(selected,'disable')} disabled={!selected.enabled}>停用</button><button className="danger" onClick={() => action(selected,'delete')}>删除</button></div></Panel><KeyEdit key={selected.id} item={selected} onChange={async()=>{await qc.invalidateQueries({queryKey:['keys']});}} onDiscard={() => setSelected(undefined)}/><QuotaAdjustment key={selected.id} id={selected.id}/></>}</div></div></>;
}
function KeyForm({ upstreams, onSave }: { upstreams: Upstream[]; onSave: (data: Partial<ProxyKey>) => Promise<boolean> }) {
  const stored = readSafeDraft<Partial<{ name: string; description: string; rpm: string; tokens: string; models: string; allowed: string[] }>>('key', 'new');
  const [name, setName] = useState(stored?.name ?? ''); const [description, setDescription] = useState(stored?.description ?? ''); const [rpm, setRpm] = useState(stored?.rpm ?? ''); const [tokens, setTokens] = useState(stored?.tokens ?? ''); const [models, setModels] = useState(stored?.models ?? ''); const [allowed, setAllowed] = useState<string[]>(stored?.allowed ?? []); const [busy, setBusy] = useState(false);
  useEffect(() => { saveSafeDraft('key', 'new', { name, description, rpm, tokens, models, allowed }); }, [name, description, rpm, tokens, models, allowed]);
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); try { const saved = await onSave({ name, description, enabled: true, rpm: rpm === '' ? undefined : Number(rpm), dailyTokens: tokens === '' ? undefined : Number(tokens), allowedModels: models.split(',').map(x => x.trim()).filter(Boolean), allowedUpstreamIds: allowed }); if (saved) { clearSafeDraft('key', 'new'); setName(''); setDescription(''); setRpm(''); setTokens(''); setModels(''); setAllowed([]); } } finally { setBusy(false); } }
  function discard() { clearSafeDraft('key', 'new'); setName(''); setDescription(''); setRpm(''); setTokens(''); setModels(''); setAllowed([]); }
  return <Panel title="创建访问 Key"><form onSubmit={submit}><div className="form-grid"><Field label="名称"><input required value={name} onChange={e => setName(e.target.value)}/></Field><Field label="备注"><input value={description} onChange={e => setDescription(e.target.value)}/></Field><Field label="RPM" hint="留空表示不限额；0 表示禁止请求"><input type="number" min="0" value={rpm} onChange={e => setRpm(e.target.value)}/></Field><Field label="每日 Token" hint="留空表示不限额；0 表示禁止消耗"><input type="number" min="0" value={tokens} onChange={e => setTokens(e.target.value)}/></Field><Field label="允许模型（逗号分隔）"><input value={models} onChange={e => setModels(e.target.value)}/></Field></div><fieldset><legend>允许上游（不选表示全部）</legend>{upstreams.map(u => <label className="check" key={u.id}><input type="checkbox" checked={allowed.includes(u.id)} onChange={e => setAllowed(e.target.checked ? [...allowed,u.id] : allowed.filter(x => x !== u.id))}/>{u.name}</label>)}</fieldset><div className="actions"><button type="button" onClick={discard}>丢弃草稿</button><SaveButton busy={busy}>创建 Key</SaveButton></div></form></Panel>;
}
function KeyEdit({item,onChange,onDiscard}:{item:ProxyKey;onChange:()=>Promise<void>;onDiscard:()=>void}){const stored=readSafeDraft<Partial<{name:string;description:string;models:string;rpm:string;tokens:string}>>('key',item.id);const [name,setName]=useState(stored?.name??item.name);const [description,setDescription]=useState(stored?.description??item.description??'');const [models,setModels]=useState(stored?.models??item.allowedModels?.join(', ')??'');const [rpm,setRpm]=useState(stored?.rpm??item.rpm?.toString()??'');const [daily,setDaily]=useState(stored?.tokens??item.dailyTokens?.toString()??'');const [error,setError]=useState<unknown>();const [busy,setBusy]=useState(false);useEffect(()=>{saveSafeDraft('key',item.id,{name,description,models,rpm,tokens:daily});},[item.id,name,description,models,rpm,daily]);async function submit(e:FormEvent){e.preventDefault();setBusy(true);try{await patch(`/keys/${item.id}`,{name,description,allowedModels:models.split(',').map(x=>x.trim()).filter(Boolean),...(rpm!==''?{rpm:Number(rpm)}:{}),...(daily!==''?{dailyTokens:Number(daily)}:{})});clearSafeDraft('key',item.id);await onChange();setError(undefined);}catch(err){setError(err);}finally{setBusy(false);}}function discard(){clearSafeDraft('key',item.id);onDiscard();}return <Panel title="编辑权限与额度"><ErrorNotice error={error}/><form className="form-grid" onSubmit={submit}><Field label="名称"><input required value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="备注"><input value={description} onChange={e=>setDescription(e.target.value)}/></Field><Field label="允许模型"><input value={models} onChange={e=>setModels(e.target.value)}/></Field><Field label="RPM"><input type="number" min="0" value={rpm} onChange={e=>setRpm(e.target.value)}/></Field><Field label="每日 Token"><input type="number" min="0" value={daily} onChange={e=>setDaily(e.target.value)}/></Field><div className="field end"><button type="button" onClick={discard}>丢弃草稿</button> <SaveButton busy={busy}/></div></form></Panel>}
interface AdjustmentResult { periodId: string; deltaTokens: number; applied: boolean }

function useQuota(id: string) {
  return useQuery({ queryKey: ['quota', id], queryFn: async () => (await get<KeyQuota>(`/keys/${id}/quota`)).data });
}

function localTime(ms: number | null, timezone?: string | null) {
  if (ms == null) return '待账期创建后确定';
  return new Date(ms).toLocaleString('zh-CN', { ...(timezone ? { timeZone: timezone } : {}), timeZoneName: 'short' });
}

function QuotaProgress({ used, limit, label }: { used: number; limit: number | null; label: string }) {
  if (limit === null) return <p className="muted">{label}不限额</p>;
  if (limit === 0) return <p className="muted">上限为 0，新的请求或消耗会被拒绝。</p>;
  return <><progress value={Math.min(Math.max(used, 0), limit)} max={limit} aria-label={`${label}占限额比例`} style={{ width: '100%' }}/><p className="muted">{formatNumber(used)} / {formatNumber(limit)}{used > limit ? '，已超过限额' : ''}</p></>;
}

function Quota({ id }: { id: string }) {
  const q = useQuota(id);
  return <section aria-label="额度与用量"><h3>本地配额账本</h3><p className="muted">这是代理的预算控制记录，不是供应商账单或可退款余额。缺失用量可能按估算或预留计入。</p><State loading={q.isPending} error={q.error} retry={() => q.refetch()}>{q.data && <QuotaDetails quota={q.data}/>}</State></section>;
}

function QuotaDetails({ quota }: { quota: KeyQuota }) {
  const hasPeriod = quota.periodId !== null;
  const hasForecastPeriod = !hasPeriod && (quota.periodStartMs !== null || quota.resetAtMs !== null);
  const committed = quota.reportedUsed + quota.estimatedUsed + quota.adjustmentTokens;
  const occupied = committed + quota.reserved;
  const limit = quota.limits.dailyTokens;
  const available = limit === null || !hasPeriod ? null : Math.max(0, limit - occupied);
  return <div className="grid-two">
    <div className="panel"><h3>每日 Token 预算</h3><strong>{limit === null ? '不限额' : formatNumber(limit)}</strong>{hasPeriod ? <><QuotaProgress used={occupied} limit={limit} label="Token 预算"/><p>当前可用预算估算：<strong>{available === null ? '不适用' : formatNumber(available)}</strong></p><div className="summary-list"><div>上游已报告 <strong>{formatNumber(quota.reportedUsed)}</strong></div><div>未确认的估算 <strong>{formatNumber(quota.estimatedUsed)}</strong></div><div>进行中的预留 <strong>{formatNumber(quota.reserved)}</strong></div><div>人工修正 <strong>{quota.adjustmentTokens > 0 ? '+' : ''}{formatNumber(quota.adjustmentTokens)}</strong></div></div><p className="muted">修正只影响本账期预算，不改写上游报告；预留会在结算后调整。</p></> : <p className="muted">尚未创建当前账期，用量与可用预算未知；首次入账后显示。</p>}</div>
    <div className="panel"><h3>请求速率 · 最近 60 秒</h3><strong>{formatNumber(quota.rpmUsed)} 次</strong><QuotaProgress used={quota.rpmUsed} limit={quota.limits.rpm} label="RPM"/><p className="muted">只计入已通过鉴权并获准进入代理的请求；上游重试不重复计数。</p></div>
    <div className="panel"><h3>当前并发</h3><strong>{hasPeriod ? formatNumber(quota.activeRequests) : '未知'} / {formatNumber(quota.limits.maxConcurrentRequests)}</strong>{hasPeriod ? <QuotaProgress used={quota.activeRequests} limit={quota.limits.maxConcurrentRequests} label="并发"/> : <p className="muted">尚无账期记录。</p>}<p className="muted">进行中的代理请求数；达到上限时新请求会被拒绝。</p></div>
    <div className="panel"><h3>当前配额周期</h3><div className="summary-list"><div>当前生效时区 <strong>{quota.activeTimezone}{quota.activeTimezoneVersionId === null ? '' : ` · 版本 ${quota.activeTimezoneVersionId}`}</strong></div>{hasPeriod ? <><div>账期 <strong>{quota.periodId}</strong></div><div>开始 <strong>{localTime(quota.periodStartMs, quota.periodTimezone)}</strong></div><div>当前周期重置 <strong>{localTime(quota.resetAtMs, quota.periodTimezone)}</strong></div></> : hasForecastPeriod ? <><div>预计周期 <strong>首次入账后创建</strong></div><div>预计开始 <strong>{localTime(quota.periodStartMs, quota.periodTimezone)}</strong></div><div>预计重置 <strong>{localTime(quota.resetAtMs, quota.periodTimezone)}</strong></div></> : <div>账期 <strong>尚未创建；首次入账后确定</strong></div>}{quota.pendingTimezone && <><div>待生效时区 <strong>{quota.pendingTimezone}</strong></div><div>时区变更生效时间 <strong>{localTime(quota.timezoneChangeEffectiveAtMs, quota.pendingTimezone)}</strong></div></>}</div><p className="muted">{hasForecastPeriod ? `预计时间按当前生效时区${quota.periodTimezone ? `（${quota.periodTimezone}）` : ''}计算；` : `重置时间使用该账期记录的时区${quota.periodTimezone ? `（${quota.periodTimezone}）` : '（旧账期未记录时区）'}；`}待生效时间按新时区显示。查看页面不会触发时区切换，只有请求准入会在持久边界激活新版本。</p></div>
  </div>;
}

function QuotaAdjustment({ id }: { id: string }) {
  const qc = useQueryClient();
  const quota = useQuota(id);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ amount: number; reason: string; periodId: string; key: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const periodId = quota.data?.periodId;
    const deltaTokens = Number(amount);
    if (!periodId || !Number.isSafeInteger(deltaTokens) || deltaTokens === 0 || !reason.trim()) {
      setError(new Error('需要当前账期、非零整数修正量和明确原因。'));
      setResult(undefined);
      return;
    }
    const current = attempt.current;
    const key = current && current.amount === deltaTokens && current.reason === reason.trim() && current.periodId === periodId ? current.key : crypto.randomUUID();
    attempt.current = { amount: deltaTokens, reason: reason.trim(), periodId, key };
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await post<AdjustmentResult>(`/keys/${id}/quota-adjustments`, { periodId, deltaTokens, reason: reason.trim() }, { idempotencyKey: key });
      setResult(`${response.data.applied ? '修正已提交' : '此前已提交相同修正'}：${deltaTokens > 0 ? '+' : ''}${formatNumber(deltaTokens)} Token；原因：${reason.trim()}。账期：${response.data.periodId}。`);
      attempt.current = null;
      setAmount('');
      setReason('');
      await qc.invalidateQueries({ queryKey: ['quota', id] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return <Panel title="额度修正"><p className="muted">修正写入当前账期并留存审计记录；正数增加占用，负数减少占用，不改写供应商用量。</p>{result && <div className="notice" role="status">{result}</div>}{error != null && <div className="notice error" role="alert"><strong>修正提交失败</strong><span>原因：{error instanceof Error ? error.message : '未知错误'}。本次填写的修正原因：{reason.trim() || '未填写'}。</span></div>}<form className="form-grid" onSubmit={submit}><Field label="Token 修正量" hint="填写非零整数；负数用于纠正高估"><input required type="number" step="1" value={amount} onChange={e => { setAmount(e.target.value); setResult(undefined); }}/></Field><Field label="修正原因"><input required value={reason} onChange={e => { setReason(e.target.value); setResult(undefined); }}/></Field><div className="field end"><button className="primary" type="submit" disabled={busy || !quota.data?.periodId}>{busy ? '提交中…' : '提交修正'}</button></div></form>{!quota.data?.periodId && <p className="muted">当前没有可修正的账期，待首次入账后才能提交。</p>}</Panel>;
}
