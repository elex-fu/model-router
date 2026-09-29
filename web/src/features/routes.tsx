import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../api/client';
import type { Model, ProxyKey, Route, RoutePreview, Upstream } from '../api/types';
import { Badge, ErrorNotice, Field, Panel, SaveButton, State } from '../components/ui';
import { clearSafeDraft, latestSafeDraftId, readSafeDraft, saveSafeDraft } from '../app/safe-drafts';

type ClientProtocol = Route['clientProtocols'][number];
type Transport = '原生' | '桥接' | '实验性' | '不支持';
const capabilityLabels = [
  ['text', '文本'], ['imageInput', '图片'], ['tools', '工具'],
  ['parallelTools', '并行工具'], ['structuredOutput', '结构化'],
  ['thinking', '推理'], ['streamUsage', '流式用量'],
] as const;
const supportLabels = { supported: '支持', unsupported: '不支持', unknown: '未知' } as const;

export function targetTransport(client: ClientProtocol, upstream: Upstream['protocol']): Transport {
  if (client === upstream) return '原生';
  if (client === 'responses' || upstream === 'responses') return '不支持';
  if (upstream === 'gemini') return client === 'anthropic' ? '实验性' : '不支持';
  return '桥接';
}

function matches(pattern: string, model: string): boolean {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(model);
}

/** Only definite overlaps are flagged; distinct glob patterns may still overlap. */
export function routeConflicts(route: Route, routes: Route[]): Route[] {
  if (!route.enabled) return [];
  return routes.filter(other => other.id !== route.id && other.enabled &&
    other.clientProtocols.some(protocol => route.clientProtocols.includes(protocol)) && (
      route.match.kind === 'exact' && other.match.kind === 'exact'
        ? route.match.value === other.match.value
        : route.match.kind === 'exact'
          ? matches(other.match.value, route.match.value)
          : other.match.kind === 'exact'
            ? matches(route.match.value, other.match.value)
            : route.match.value === other.match.value
    ));
}

/** Published aliases are enumerated by /v1/models, so duplicate aliases are ambiguous to clients. */
export function duplicatePublishedAliases(route: Route, routes: Route[]): Array<{ alias: string; routes: string[] }> {
  if (!route.enabled) return [];
  const ownAliases = new Set<string>();
  const duplicates = new Map<string, Set<string>>();
  for (const alias of route.publishedModels) {
    if (ownAliases.has(alias)) duplicates.set(alias, new Set([route.name]));
    ownAliases.add(alias);
  }
  for (const other of routes) {
    if (other.id === route.id || !other.enabled || !other.clientProtocols.some(protocol => route.clientProtocols.includes(protocol))) continue;
    for (const alias of new Set(other.publishedModels)) {
      if (!ownAliases.has(alias)) continue;
      const names = duplicates.get(alias) ?? new Set<string>();
      names.add(route.name); names.add(other.name); duplicates.set(alias, names);
    }
  }
  return [...duplicates].map(([alias, names]) => ({ alias, routes: [...names] }));
}

function capabilitySummary(model: Model | undefined): string {
  if (!model) return '模型未配置';
  return capabilityLabels.map(([key, label]) => `${label} ${supportLabels[model.capabilities?.[key] ?? 'unknown']}`).join(' · ');
}

function TargetDetails({ target, protocols, upstreams }: {
  target: Route['targets'][number]; protocols: Route['clientProtocols']; upstreams: Upstream[];
}) {
  const upstream = upstreams.find(item => item.id === target.upstreamId);
  if (!upstream) return <small className="form-error">选择已配置的上游</small>;
  const model = upstream.models.find(item => item.id === target.model);
  return <div className="muted">
    <div>上游协议 <code>{upstream.protocol}</code> · {upstream.enabled ? '上游已启用' : '上游已停用'} · {model ? model.enabled ? '模型已启用' : '模型已停用' : '模型未配置'}</div>
    <div>{protocols.map(protocol => <span key={protocol} style={{ marginRight: 8 }}>{protocol}：<Badge tone={targetTransport(protocol, upstream.protocol) === '不支持' ? 'bad' : targetTransport(protocol, upstream.protocol) === '实验性' ? 'warn' : 'neutral'}>{targetTransport(protocol, upstream.protocol)}</Badge></span>)}</div>
    {model && <div>能力来源：{model.capabilitiesSource === 'verified' ? '已验证' : model.capabilitiesSource === 'preset' ? '预设声明' : '手动声明'} · {capabilitySummary(model)}</div>}
  </div>;
}

export function RoutesPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => { const id = latestSafeDraftId('route'); return id && id !== 'new' ? id : undefined; });
  const [creating, setCreating] = useState(() => latestSafeDraftId('route') === 'new');
  const [draggedId, setDraggedId] = useState<string>();
  const [ordering, setOrdering] = useState(false);
  const [error, setError] = useState<unknown>();
  const routes = useQuery({ queryKey: ['routes'], queryFn: async () => (await get<Route[]>('/routes')).data });
  const upstreams = useQuery({ queryKey: ['upstreams'], queryFn: async () => (await get<Upstream[]>('/upstreams')).data });
  const ordered = [...(routes.data ?? [])].sort((a, b) => a.order - b.order);
  const selected = ordered.find(route => route.id === selectedId);

  async function save(route: Route) {
    try {
      if (creating) await post('/routes', route);
      else await patch('/routes/' + encodeURIComponent(route.id), route);
      clearSafeDraft('route', creating ? 'new' : route.id);
      await qc.invalidateQueries({ queryKey: ['routes'] });
      setCreating(false); setSelectedId(undefined); setError(undefined);
    } catch (err) { setError(err); throw err; }
  }
  async function remove(route: Route) {
    if (!confirm(`删除路由 ${route.name}？`)) return;
    try {
      await del('/routes/' + encodeURIComponent(route.id));
      await qc.invalidateQueries({ queryKey: ['routes'] });
      setSelectedId(undefined); setError(undefined);
    } catch (err) { setError(err); }
  }
  async function reorder(ids: string[]) {
    if (ordering || ids.every((id, index) => id === ordered[index]?.id)) return;
    setOrdering(true); setError(undefined);
    try {
      await put('/routes/order', { ids });
      await qc.invalidateQueries({ queryKey: ['routes'] });
    } catch (err) { setError(err); }
    finally { setOrdering(false); }
  }
  function move(id: string, direction: number) {
    const ids = ordered.map(item => item.id);
    const index = ids.indexOf(id); const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void reorder(ids);
  }
  function drop(event: DragEvent, targetId: string) {
    event.preventDefault();
    if (!draggedId || draggedId === targetId) { setDraggedId(undefined); return; }
    const ids = ordered.map(item => item.id).filter(id => id !== draggedId);
    ids.splice(ids.indexOf(targetId), 0, draggedId);
    setDraggedId(undefined);
    void reorder(ids);
  }

  return <>
    <div className="page-title"><div><p className="eyebrow">ROUTING</p><h1>模型与路由</h1><p>按顺序匹配；配置预览不调用上游</p></div><button className="primary" onClick={() => { setCreating(true); setSelectedId(undefined); }}>新增路由</button></div>
    <ErrorNotice error={error}/>
    <div className="split">
      <Panel title="路由顺序"><p className="muted">拖动路由调整优先级，也可使用上移／下移按钮。相同客户端协议下，先匹配的已启用路由优先。</p>
        <State loading={routes.isPending} error={routes.error} retry={() => routes.refetch()} empty={!ordered.length} emptyAction={<button onClick={() => setCreating(true)}>创建路由</button>}>
          <div className="rows">{ordered.map((route, index) => {
          const conflicts = routeConflicts(route, ordered);
            const duplicateAliases = duplicatePublishedAliases(route, ordered);
            return <div className="route-row" key={route.id} draggable={!ordering}
              onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; setDraggedId(route.id); }}
              onDragOver={event => { if (draggedId && draggedId !== route.id) event.preventDefault(); }}
              onDrop={event => drop(event, route.id)} onDragEnd={() => setDraggedId(undefined)}>
              <div className="order-actions"><button aria-label={`上移 ${route.name}`} disabled={ordering || index === 0} onClick={() => move(route.id, -1)}>↑</button><button aria-label={`下移 ${route.name}`} disabled={ordering || index === ordered.length - 1} onClick={() => move(route.id, 1)}>↓</button></div>
              <button className="route-select" onClick={() => { setSelectedId(route.id); setCreating(false); }}><strong>{index + 1}. {route.name}</strong><code>{route.match.kind === 'glob' ? 'Glob ' : '精确 '}{route.match.value}</code><small>已发布别名：{route.publishedModels.length ? route.publishedModels.join('、') : '无'} · {route.targets.length} 个候选 · {route.clientProtocols.join(', ')}</small>{conflicts.length > 0 && <small className="form-error">与 {conflicts.map(item => item.name).join('、')} 的匹配范围重叠</small>}</button>
              {duplicateAliases.length > 0 && <small className="form-error">别名重复：{duplicateAliases.map(item => `${item.alias}（${item.routes.join('、')}）`).join('；')}</small>}
              <Badge tone={route.enabled ? 'good' : 'neutral'}>{route.enabled ? '启用' : '停用'}</Badge>
            </div>;
          })}</div>
        </State>
        <p className="muted">冲突提示仅检查确定重叠的规则；不同 Glob 之间仍可能重叠，可用具体模型预览。</p>
      </Panel>
      <div className="detail-column">
        {(selected || creating) && <RouteForm key={selected?.id ?? 'new'} initial={selected} routes={ordered} upstreams={upstreams.data ?? []} nextOrder={ordered.length} onSave={save} onDelete={selected ? () => remove(selected) : undefined} onDiscard={() => { clearSafeDraft('route', selected?.id ?? 'new'); setSelectedId(undefined); setCreating(false); }}/>} 
        <Preview routes={ordered} upstreams={upstreams.data ?? []}/>
      </div>
    </div>
  </>;
}

function RouteForm({ initial, routes, upstreams, nextOrder, onSave, onDelete, onDiscard }: {
  initial?: Route; routes: Route[]; upstreams: Upstream[]; nextOrder: number;
  onSave: (route: Route) => Promise<void>; onDelete?: () => void; onDiscard: () => void;
}) {
  const draftId = initial?.id ?? 'new';
  const stored = readSafeDraft<Partial<{ name: string; match: string; kind: Route['match']['kind']; published: string; protocols: Route['clientProtocols']; targets: Route['targets']; enabled: boolean }>>('route', draftId);
  const [name, setName] = useState(stored?.name ?? initial?.name ?? '');
  const [match, setMatch] = useState(stored?.match ?? initial?.match.value ?? '');
  const [kind, setKind] = useState<Route['match']['kind']>(stored?.kind ?? initial?.match.kind ?? 'exact');
  const [published, setPublished] = useState(stored?.published ?? initial?.publishedModels.join(', ') ?? '');
  const [protocols, setProtocols] = useState<Route['clientProtocols']>(stored?.protocols ?? initial?.clientProtocols ?? ['openai']);
  const [targets, setTargets] = useState<Route['targets']>(stored?.targets ?? initial?.targets ?? [{ upstreamId: '', model: '' }]);
  const [enabled, setEnabled] = useState(stored?.enabled ?? initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => { saveSafeDraft('route', draftId, { name, match, kind, published, protocols, targets, enabled }); }, [draftId, name, match, kind, published, protocols, targets, enabled]);
  const aliases = [...new Set(published.split(',').map(value => value.trim()).filter(Boolean))];
  const draft: Route = { id: initial?.id ?? '__draft__', name, enabled, match: { kind, value: match }, clientProtocols: protocols, order: initial?.order ?? nextOrder, publishedModels: aliases, targets };
  const conflicts = routeConflicts(draft, routes);
  const duplicateAliases = duplicatePublishedAliases(draft, routes);
  const invalidTransports = targets.some(target => {
    const upstream = upstreams.find(item => item.id === target.upstreamId);
    return upstream && protocols.some(protocol => targetTransport(protocol, upstream.protocol) === '不支持');
  });

  function changeTarget(index: number, field: 'upstreamId' | 'model', value: string) {
    setTargets(items => items.map((item, i) => i === index ? { ...item, [field]: value, ...(field === 'upstreamId' ? { model: '' } : {}) } : item));
  }
  function moveTarget(index: number, direction: number) {
    setTargets(items => {
      const next = [...items]; const target = index + direction;
      if (target < 0 || target >= next.length) return items;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!protocols.length) { setError(new Error('至少选择一个客户端协议')); return; }
    if (invalidTransports) { setError(new Error('所选客户端协议与候选上游存在不支持的转换')); return; }
    setBusy(true); setError(undefined);
    try { await onSave({ ...draft, id: initial?.id ?? crypto.randomUUID() }); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }

  return <Panel title={initial ? '编辑路由' : '新增路由'}><ErrorNotice error={error}/><form onSubmit={submit}>
    <div className="form-grid">
      <Field label="名称"><input required value={name} onChange={event => setName(event.target.value)}/></Field>
      <Field label="匹配方式"><select value={kind} onChange={event => setKind(event.target.value as Route['match']['kind'])}><option value="exact">精确</option><option value="glob">Glob</option></select></Field>
      <Field label="客户端模型 / 匹配值"><input required value={match} onChange={event => { setMatch(event.target.value); if (!initial && kind === 'exact') setPublished(event.target.value); }}/></Field>
      <Field label="发布模型别名（逗号分隔）"><input value={published} onChange={event => setPublished(event.target.value)}/></Field>
    </div>
    <p className="muted">已发布别名：{aliases.length ? aliases.map(alias => <code key={alias} style={{ marginRight: 8 }}>{alias}</code>) : '无'}。别名列表不改变匹配规则；Glob 路由请填写客户端可见的具体别名。</p>
    {kind === 'exact' && match && !aliases.includes(match) && <p className="notice">精确匹配值未列入发布别名；客户端可能无法从模型列表发现它。</p>}
    {conflicts.length > 0 && <p className="notice error">匹配范围与 {conflicts.map(route => route.name).join('、')} 重叠。路由顺序会影响实际选择；保存前请用具体客户端模型预览。</p>}
    {duplicateAliases.length > 0 && <p className="notice error" role="alert">发布别名重复：{duplicateAliases.map(item => `${item.alias}（${item.routes.join('、')}）`).join('；')}。同一客户端协议下，模型列表将无法区分对应路由。</p>}
    <h3>候选目标（按顺序故障切换）</h3>
    {targets.map((target, index) => {
      const upstream = upstreams.find(item => item.id === target.upstreamId);
      return <div key={index} style={{ borderTop: '1px solid #edf0ec', padding: '12px 0' }}>
        <div className="target-row"><span>{index + 1}</span>
          <select required aria-label={`候选 ${index + 1} 上游`} value={target.upstreamId} onChange={event => changeTarget(index, 'upstreamId', event.target.value)}><option value="">选择上游</option>{upstreams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <input required aria-label={`候选 ${index + 1} 模型`} list={`models-${initial?.id ?? 'new'}-${index}`} value={target.model} onChange={event => changeTarget(index, 'model', event.target.value)} placeholder="真实模型 ID"/>
          <datalist id={`models-${initial?.id ?? 'new'}-${index}`}>{upstream?.models.map(model => <option key={model.id} value={model.id}/>)}</datalist>
          <button type="button" aria-label={`上移候选 ${index + 1}`} disabled={index === 0} onClick={() => moveTarget(index, -1)}>↑</button>
          <button type="button" aria-label={`下移候选 ${index + 1}`} disabled={index === targets.length - 1} onClick={() => moveTarget(index, 1)}>↓</button>
          <button type="button" disabled={targets.length === 1} onClick={() => setTargets(items => items.filter((_, i) => i !== index))}>移除</button>
        </div>
        <TargetDetails target={target} protocols={protocols} upstreams={upstreams}/>
      </div>;
    })}
    <button type="button" onClick={() => setTargets(items => [...items, { upstreamId: '', model: '' }])}>添加候选</button>
    <div className="check-group">{(['openai', 'anthropic', 'responses'] as const).map(protocol => <label className="check" key={protocol}><input type="checkbox" checked={protocols.includes(protocol)} onChange={event => setProtocols(event.target.checked ? [...protocols, protocol] : protocols.filter(item => item !== protocol))}/>{protocol}</label>)}</div>
    {invalidTransports && <p className="form-error" role="alert">所选候选包含不支持的协议转换，请调整客户端协议或目标上游。</p>}
    <label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>发布路由</label>
    <div className="actions"><button type="button" onClick={onDiscard}>丢弃草稿</button><SaveButton busy={busy}/>{onDelete && <button className="danger" type="button" onClick={onDelete}>删除</button>}</div>
  </form></Panel>;
}

function Preview({ routes, upstreams }: { routes: Route[]; upstreams: Upstream[] }) {
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState<ClientProtocol>('openai');
  const [proxyKeyId, setProxyKeyId] = useState('');
  const [result, setResult] = useState<RoutePreview>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const keys = useQuery({ queryKey: ['keys'], queryFn: async () => (await get<ProxyKey[]>('/keys')).data });
  async function run(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined); setResult(undefined);
    try { setResult((await post<RoutePreview>('/routes/preview', { model, protocol, ...(proxyKeyId ? { proxyKeyId } : {}) })).data); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  const matchedRoute = routes.find(route => route.id === result?.routeId);
  return <Panel title="路由配置预览">
    <p className="muted">读取当前运行时路由、凭证池、健康与熔断状态；不会调用上游、探测熔断器或轮转凭证。需选择已启用访问 Key 才能预览该 Key 的权限；留空时权限不参与判断。半开熔断仅显示不确定，不主动探测。</p>
    <form className="inline-form" onSubmit={run}><input required aria-label="客户端模型" placeholder="输入具体客户端模型" value={model} onChange={event => setModel(event.target.value)}/><select aria-label="客户端协议" value={protocol} onChange={event => setProtocol(event.target.value as ClientProtocol)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="responses">Responses</option></select><select aria-label="访问 Key" value={proxyKeyId} onChange={event => setProxyKeyId(event.target.value)}><option value="">不按 Key 权限校验</option>{(keys.data ?? []).filter(key => key.enabled).map(key => <option key={key.id} value={key.id}>{key.name} · {key.keyPrefix ?? key.id}</option>)}</select><button disabled={busy}>{busy ? '预览中…' : '预览（零上游调用）'}</button></form>
    <ErrorNotice error={error}/>
    {result && <div className="notice" style={{ display: 'block' }}>
      <strong>{result.matched ? `匹配路由：${matchedRoute?.name ?? result.routeId ?? '未知'}` : '未匹配路由'}</strong>
      {result.selection === 'uncertain' && <p className="notice">首个候选处于半开熔断状态，实际是否选中取决于真实请求 permit；预览不会探测，因此后续 winner 未推断。</p>}
      {result.reason && <p>原因：{result.reason === 'model_not_found' ? '没有匹配此模型和协议的已启用路由' : result.reason === 'unsupported_client_protocol' ? '路由不接受此客户端协议' : result.reason}</p>}
      {result.runtime === false && <p className="form-error">此管理端未连接代理运行时；以下仅为配置预览，Key 权限、凭证池、健康与熔断状态未验证。</p>}
      {result.proxyKey === 'not_selected' && result.runtime && <p className="muted">未按访问 Key 权限校验。</p>}
      {result.proxyKey === 'unavailable' && <p className="form-error">所选访问 Key 不存在、已停用或已过期；为保护 Key 信息，不返回 Key 详情。</p>}
      {result.candidates.length > 0 ? <ol>{result.candidates.map((candidate, index) => <li key={`${candidate.upstreamId}-${candidate.model}-${index}`}>
        <code>{candidate.upstreamId} / {candidate.actualModel ?? candidate.model}</code> · {candidate.selected ? '当前首选' : candidate.eligible ? '可故障切换' : '已排除'} · {candidate.bridge === 'native' ? '原生' : candidate.bridge === 'bridge' ? '协议桥接' : '不支持桥接'} · 凭证已配置 {candidate.configuredCredentials ?? '未知'} / 当前可用 {candidate.availableCredentials ?? '未知'} · 健康 {candidate.healthStatus ?? '未知'} · 熔断 {candidate.circuitState ?? '未知'} · {candidate.availability === 'uncertain' ? '状态不确定' : candidate.availability === 'available' ? '可用' : candidate.availability === 'degraded' ? '受限' : '不可用'}
        {candidate.exclusionReason && <div className="form-error">{({ upstream_missing: '上游不存在', upstream_disabled: '上游已停用', model_missing: '模型未配置', model_disabled: '模型已停用', config_unavailable: '运行时状态未连接', key_model_denied: '访问 Key 不允许此模型', key_upstream_denied: '访问 Key 不允许此上游', unsupported_bridge: '客户端与上游协议不支持桥接', no_credentials: '未配置凭证', credentials_cooling_down: '凭证均在冷却中', circuit_open: '熔断器已打开', circuit_half_open: '熔断器半开，需真实请求探测', health_unhealthy: '健康检查失败', proxy_key_unavailable: '访问 Key 不可用' } as Record<string, string>)[candidate.exclusionReason] ?? candidate.exclusionReason}</div>}
        <TargetDetails target={candidate} protocols={[protocol]} upstreams={upstreams}/>
      </li>)}</ol> : <p>无候选目标。</p>}
    </div>}
  </Panel>;
}
