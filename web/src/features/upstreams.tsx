import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../api/client';
import type { Credential, Model, Preset, Upstream } from '../api/types';
import { Badge, ErrorNotice, Field, Panel, SaveButton, State, formatNumber } from '../components/ui';
import { clearSafeDraft, hasSafeDraft, readSafeDraft, saveSafeDraft } from '../app/safe-drafts';

const fallbackPresets: Preset[] = [
  { id: 'kimi-platform', name: 'Kimi 开放平台', provider: 'kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', endpoints: { generate: 'chat/completions' }, auth: { mode: 'bearer' } },
  { id: 'kimi-code', name: 'Kimi Code', provider: 'kimi', protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding/v1', endpoints: { generate: 'messages' }, auth: { mode: 'x-api-key' } },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', endpoints: { generate: 'chat/completions' }, auth: { mode: 'bearer' } },
  { id: 'deepseek-anthropic', name: 'DeepSeek Messages', provider: 'deepseek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic/v1', endpoints: { generate: 'messages' }, auth: { mode: 'x-api-key' } },
  { id: 'custom-openai', name: '自定义 OpenAI 兼容', provider: 'custom', protocol: 'openai', baseUrl: '', endpoints: { generate: 'chat/completions' }, auth: { mode: 'bearer' } },
  { id: 'custom-anthropic', name: '自定义 Anthropic 兼容', provider: 'custom', protocol: 'anthropic', baseUrl: '', endpoints: { generate: 'messages' }, auth: { mode: 'x-api-key' } },
  { id: 'ollama-local', name: 'Ollama 本地验证', provider: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', endpoints: { generate: 'chat/completions', models: 'models' }, auth: { mode: 'none' }, models: [{ id: 'qwen2.5-coder:7b', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }] },
];
type Support = 'unknown' | 'supported' | 'unsupported';
const capabilityFields = [
  ['text', '文本'], ['imageInput', '图片输入'], ['tools', '工具调用'],
  ['parallelTools', '并行工具'], ['structuredOutput', '结构化输出'],
  ['thinking', '推理'], ['streamUsage', '流式用量'],
] as const;
type CapabilityKey = typeof capabilityFields[number][0];

function endpointUrl(baseUrl: string, endpoint: string): string {
  if (!baseUrl || !endpoint) return '—';
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      endpoint.startsWith('/') || endpoint.includes('?') || endpoint.includes('#') || endpoint.includes('\\') ||
      /(^|\/)\.{1,2}(\/|$)/.test(endpoint) || /%2f|%5c|%2e/i.test(endpoint) ||
      !/^[a-zA-Z0-9/_-]+$/.test(endpoint)) return '端点或 Base URL 无效';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
    return url.toString();
  } catch { return '端点或 Base URL 无效'; }
}

function isHttp(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:';
  } catch { return false; }
}
export function Upstreams() {
  const { id } = useParams(); const qc = useQueryClient(); const navigate = useNavigate(); const [creating, setCreating] = useState(() => hasSafeDraft('upstream', 'new')); const [cloning, setCloning] = useState<Upstream>();
  const list = useQuery({ queryKey: ['upstreams'], queryFn: async () => (await get<Upstream[]>('/upstreams')).data });
  const presets = useQuery({ queryKey: ['presets'], queryFn: async () => [...(await get<(Preset | { id: string; provider: Preset['provider']; protocol: Preset['protocol']; baseUrl?: string; generate: string; auth: string })[]>('/provider-presets')).data.map(p => 'generate' in p ? { id: p.id, name: p.id.replaceAll('-', ' '), provider: p.provider, protocol: p.protocol, baseUrl: p.baseUrl ?? '', endpoints: { generate: p.generate }, auth: { mode: p.auth as Upstream['auth']['mode'] } } : p), fallbackPresets[fallbackPresets.length-1]] });
  const save = useMutation({ mutationFn: (body: Upstream) => id ? patch('/upstreams/' + encodeURIComponent(id), { name: body.name, protocol: body.protocol, enabled: body.enabled, baseUrl: body.baseUrl, endpoints: body.endpoints, auth: body.auth, policy: body.policy }) : post('/upstreams', body), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['upstreams'] }); setCreating(false); if (!id) navigate('/upstreams'); } });
  const remove = useMutation({ mutationFn: (item: Upstream) => del('/upstreams/' + encodeURIComponent(item.id)), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['upstreams'] }); navigate('/upstreams'); } });
  const selected = list.data?.find(item => item.id === id);
  return <><div className="page-title"><div><p className="eyebrow">PROVIDERS</p><h1>上游</h1><p>连接供应商、管理模型与凭证</p></div><button className="primary" onClick={() => { setCloning(undefined); setCreating(true); navigate('/upstreams'); }}>新增上游</button></div><ErrorNotice error={save.error || remove.error}/><div className="split"><Panel title={`上游列表 · ${list.data?.length ?? '—'}`}><State loading={list.isPending} error={list.error} retry={() => list.refetch()} empty={!list.data?.length} emptyAction={<button onClick={() => setCreating(true)}>创建第一个上游</button>}><div className="rows">{list.data?.map(item => <Link key={item.id} to={`/upstreams/${item.id}`} className={`upstream-row ${id === item.id ? 'selected' : ''}`}><div><strong>{item.name}</strong><small><code>{item.protocol}</code> · {item.provider}</small></div><Badge tone={!item.enabled ? 'neutral' : item.health === 'healthy' ? 'good' : 'warn'}>{!item.enabled ? '已停用' : item.health ?? '状态未知'}</Badge></Link>)}</div></State></Panel><div className="detail-column">{creating ? <UpstreamForm presets={presets.data ?? fallbackPresets} onSave={data => save.mutateAsync(data).then(() => {})} busy={save.isPending}/> : cloning ? <UpstreamForm key={`clone-${cloning.id}`} initial={cloneDraft(cloning)} cloneSource={cloning.name} presets={presets.data ?? fallbackPresets} onSave={data => save.mutateAsync(data).then(() => {})} busy={save.isPending}/> : selected ? <><UpstreamForm key={selected.id} initial={selected} presets={presets.data ?? fallbackPresets} onSave={data => save.mutateAsync(data).then(() => {})} busy={save.isPending}/><Panel title="凭证"><p className="muted">凭证不会被克隆；请在副本创建后单独添加凭证。</p></Panel><Credentials upstream={selected} onChange={() => qc.invalidateQueries({ queryKey: ['upstreams'] })}/><Models upstream={selected} onChange={() => qc.invalidateQueries({ queryKey: ['upstreams'] })}/><Panel title="运行状态与操作"><p>24 小时用量：{formatNumber(selected.usage24h)}</p><Runtime id={selected.id}/><div className="actions"><button onClick={() => post(`/upstreams/${selected.id}/circuit-reset`, {}).then(() => qc.invalidateQueries())}>重置熔断</button><button onClick={() => { setCreating(false); setCloning(selected); navigate('/upstreams'); }}>克隆上游</button><button className="danger" onClick={() => { if (confirm(`删除 ${selected.name}？关联路由可能阻止删除。`)) remove.mutate(selected); }}>删除上游</button></div></Panel><HealthEvents id={selected.id}/></> : <div className="empty">选择上游查看详情，或新增上游。</div>}</div></div></>;
}
function cloneDraft(source: Upstream): Upstream {
  return {
    id: crypto.randomUUID(), name: `${source.name} 副本`, provider: source.provider, presetId: source.presetId,
    protocol: source.protocol, enabled: false, baseUrl: source.baseUrl, endpoints: { ...source.endpoints },
    auth: { mode: source.auth.mode, ...(source.auth.mode === 'custom-header' ? { headerName: source.auth.headerName } : {}) },
    credentials: [], models: [],
    priority: source.priority, sortIndex: source.sortIndex, policy: { ...source.policy },
  };
}
function UpstreamForm({ initial, cloneSource, presets, onSave, busy }: { initial?: Upstream; cloneSource?: string; presets: Preset[]; onSave: (data: Upstream) => Promise<void>; busy: boolean }) {
  const draftId = initial?.id ?? 'new';
  const stored = readSafeDraft<Partial<{ presetId: string; name: string; baseUrl: string; protocol: Upstream['protocol']; generate: string; modelsEndpoint: string; enabled: boolean; authMode: Upstream['auth']['mode']; allowInsecureHttp: boolean }>>('upstream', draftId);
  const [presetId, setPresetId] = useState(initial?.presetId ?? stored?.presetId ?? presets[0]?.id ?? 'custom-openai'); const preset = presets.find(p => p.id === presetId) ?? presets[0];
  const [name, setName] = useState(stored?.name ?? initial?.name ?? ''); const [baseUrl, setBaseUrl] = useState(stored?.baseUrl ?? initial?.baseUrl ?? preset?.baseUrl ?? ''); const [protocol, setProtocol] = useState(stored?.protocol ?? initial?.protocol ?? preset?.protocol ?? 'openai'); const [generate, setGenerate] = useState(stored?.generate ?? initial?.endpoints.generate ?? preset?.endpoints.generate ?? 'chat/completions'); const [modelsEndpoint, setModelsEndpoint] = useState(stored?.modelsEndpoint ?? initial?.endpoints.models ?? preset?.endpoints.models ?? ''); const [enabled, setEnabled] = useState(stored?.enabled ?? initial?.enabled ?? false); const [auth, setAuth] = useState<Upstream['auth']['mode']>(initial?.auth.mode ?? stored?.authMode ?? preset?.auth.mode ?? 'bearer'); const [authHeaderName, setAuthHeaderName] = useState(initial?.auth.headerName ?? preset?.auth.headerName ?? ''); const [allowInsecureHttp, setAllowInsecureHttp] = useState(stored?.allowInsecureHttp ?? (initial?.policy?.allowInsecureHttp === true && isHttp(initial.baseUrl))); const [error, setError] = useState('');
  useEffect(() => { saveSafeDraft('upstream', draftId, { presetId, name, baseUrl, protocol, generate, modelsEndpoint, enabled, authMode: auth, allowInsecureHttp }); }, [draftId, presetId, name, baseUrl, protocol, generate, modelsEndpoint, enabled, auth, allowInsecureHttp]);
  function changePreset(id: string) { const p = presets.find(x => x.id === id); if (!p) return; setPresetId(id); setName(p.id === 'ollama-local' ? 'Ollama 本地' : ''); setBaseUrl(p.baseUrl); setAllowInsecureHttp(false); setProtocol(p.protocol); setGenerate(p.endpoints.generate); setModelsEndpoint(p.endpoints.models ?? ''); setAuth(p.auth.mode); setAuthHeaderName(p.auth.headerName ?? ''); }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!baseUrl) { setError('请输入 Base URL'); return; }
    if (auth === 'custom-header' && !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(authHeaderName)) {
      setError('认证 Header 名只能使用 1–64 位英文字母、数字和连字符，且必须以字母开头'); return;
    }
    if (endpointUrl(baseUrl, generate) === '端点或 Base URL 无效' ||
      (modelsEndpoint.trim() && endpointUrl(baseUrl, modelsEndpoint.trim()) === '端点或 Base URL 无效')) {
      setError('请检查 Base URL 和相对端点'); return;
    }
    if (isHttp(baseUrl) && !allowInsecureHttp) {
      setError('HTTP 上游必须先明确勾选明文传输风险；即使勾选，后端仍会拒绝公网 HTTP 地址'); return;
    }
    setError('');
    const nextAuth: Upstream['auth'] = { ...(initial?.auth ?? preset.auth), mode: auth };
    if (auth === 'custom-header') nextAuth.headerName = authHeaderName;
    else delete nextAuth.headerName;
    const endpoints = { ...(initial?.endpoints ?? preset.endpoints), generate, ...(modelsEndpoint.trim() ? { models: modelsEndpoint.trim() } : {}) };
    if (!modelsEndpoint.trim()) delete endpoints.models;
    const policy = { ...(initial?.policy ?? {}), ...(isHttp(baseUrl) ? { allowInsecureHttp: true } : {}) };
    if (!isHttp(baseUrl)) delete policy.allowInsecureHttp;
    const data: Upstream = initial ? { ...initial, name, baseUrl, protocol, enabled, endpoints, auth: nextAuth, policy } : { id: crypto.randomUUID(), name, provider: preset.provider, presetId: presetId === 'ollama-local' ? 'custom-openai' : presetId, protocol, enabled, baseUrl, endpoints, auth: nextAuth, credentials: [], models: preset.models ?? [], priority: 0, sortIndex: 0, policy };
    await onSave(data);
    clearSafeDraft('upstream', draftId);
  }
  return <Panel title={cloneSource ? '确认克隆上游' : initial ? '基本配置' : '新增上游'}>{cloneSource && <p className="notice">正在克隆“{cloneSource}”。不会复制凭证或 Secret 引用；副本默认停用，保存前可编辑配置。</p>}<form onSubmit={submit}>
    <div className="form-grid">
      <Field label="供应商预设"><select disabled={!!initial} value={presetId} onChange={e => changePreset(e.target.value)}>{presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="名称"><input required value={name} onChange={e => setName(e.target.value)}/></Field>
      <Field label="协议"><select value={protocol} onChange={e => { const p = e.target.value as Upstream['protocol']; setProtocol(p); setGenerate(p === 'responses' ? 'responses' : p === 'anthropic' ? 'messages' : 'chat/completions'); }}><option value="openai">OpenAI Chat</option><option value="anthropic">Anthropic Messages</option><option value="responses">原生 Responses</option></select></Field>
      <Field label="认证方式"><select value={auth} onChange={e => setAuth(e.target.value as Upstream['auth']['mode'])}>
        <option value="bearer">Bearer</option><option value="x-api-key">X-API-Key</option><option value="custom-header">自定义 Header</option>
        <option value="none">无需认证</option><option value="pass-through">透传认证（管理页发现/测试不可用）</option>
        <option value="google" disabled={auth !== 'google'}>Google（当前未接入）</option>
        <option value="oauth" disabled={auth !== 'oauth'}>OAuth（当前未接入）</option>
      </select></Field>
      {auth === 'custom-header' && <Field label="认证 Header 名"><input required maxLength={64} pattern="[A-Za-z][A-Za-z0-9-]{0,63}" placeholder="X-Custom-API-Key" value={authHeaderName} onChange={e => setAuthHeaderName(e.target.value)}/></Field>}
      <Field label="Base URL"><input type="url" required value={baseUrl} onChange={e => { setBaseUrl(e.target.value); if (e.target.value !== initial?.baseUrl) setAllowInsecureHttp(false); }}/></Field>
      <Field label="生成相对端点"><input required value={generate} onChange={e => setGenerate(e.target.value)}/></Field>
      <Field label="模型发现相对端点（可选）"><input value={modelsEndpoint} onChange={e => setModelsEndpoint(e.target.value)} placeholder="models"/></Field>
    </div>
    <p className="muted">已配置认证：<code>{auth}{auth === 'custom-header' ? ` · ${authHeaderName || '未填写 Header 名'}` : ''}</code></p>
    <p className="muted">生成最终 URL：<code>{endpointUrl(baseUrl, generate)}</code></p>
    <p className="muted">模型发现最终 URL：<code>{modelsEndpoint.trim() ? endpointUrl(baseUrl, modelsEndpoint.trim()) : '未配置，无法发现模型'}</code></p>
    {auth === 'custom-header' && <p className="muted">已保存的凭证通过此 Header 发送；Host、Authorization 和转发等保留字段不可使用。</p>}
    {auth === 'none' && <p className="notice">此上游不发送认证头；仅在可信环境中使用。</p>}
    {['oauth', 'google'].includes(auth) && <p className="notice error">此认证模式当前未接入，模型发现、连接测试和生成可能无法使用。请改用已支持的认证方式。</p>}
    {auth === 'pass-through' && <p className="notice">透传认证依赖客户端身份，管理页的模型发现和连接测试不可用。</p>}
    {isHttp(baseUrl) && <div className="notice error" style={{ display: 'block' }}>
      <label className="check"><input type="checkbox" checked={allowInsecureHttp} onChange={e => setAllowInsecureHttp(e.target.checked)}/>我明确允许对此上游使用 HTTP 明文传输</label>
      <p>HTTP 请求和认证凭证可能被网络中的其他人读取。仅本机或私网字面 IP 可在明确勾选后使用；后端会拒绝公网 HTTP，勾选不会绕过该限制。Ollama 本地预设也需要勾选。</p>
    </div>}
    <label className="check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>启用上游</label>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="actions"><button type="button" onClick={() => { clearSafeDraft('upstream', draftId); setError('已丢弃此草稿；当前字段仅保留到离开页面。'); }}>丢弃草稿</button><SaveButton busy={busy}/></div>
  </form></Panel>;
}
function Credentials({ upstream, onChange }: { upstream: Upstream; onChange: () => void }) {
  const [label, setLabel] = useState(''); const [source, setSource] = useState<'secret' | 'env'>('secret'); const [value, setValue] = useState(''); const [error, setError] = useState<unknown>(); const [busy, setBusy] = useState(false);
  async function add(e: FormEvent) { e.preventDefault(); setBusy(true); setError(undefined); try { await post(`/upstreams/${upstream.id}/credentials`, { label, enabled: true, ...(source === 'env' ? { secret: { type: 'env', name: value } } : { value }) }); setValue(''); setLabel(''); onChange(); } catch (err) { setError(err); } finally { setBusy(false); } }
  async function action(c: Credential, type: 'replace' | 'remove' | 'disable') { if (type === 'remove' && !confirm(`删除凭证 ${c.label}？`)) return; const next = type === 'replace' ? prompt('输入新凭证（仅本次提交）') : null; if (type === 'replace' && !next) return; try { if (type === 'remove') await del(`/upstreams/${upstream.id}/credentials/${c.id}`); else await patch(`/upstreams/${upstream.id}/credentials/${c.id}`, type === 'disable' ? { enabled: false } : { operation: 'replace', value: next }); onChange(); } catch (err) { setError(err); } }
  return <Panel title="凭证"><ErrorNotice error={error}/>{upstream.auth.mode==='none' ? <p className="muted">无需认证；不会向上游发送凭证。</p> : <><div className="rows">{upstream.credentials.map(c => <div className="row" key={c.id}><div><strong>{c.label}</strong><small>{c.secret.type === 'env' ? `环境变量 ${c.secret.name}` : c.secret.type === 'inline' ? '配置文件内联' : '加密保存'} · {typeof c.status === 'string' ? c.status : c.status ? c.status.configured ? '已配置' : '缺失' : c.enabled ? '已启用' : '已停用'}</small></div><div className="actions"><button onClick={() => action(c, 'replace')}>替换</button><button onClick={() => action(c, 'disable')} disabled={!c.enabled}>停用</button><button onClick={() => action(c, 'remove')}>删除</button></div></div>)}</div><form onSubmit={add} className="form-grid"><Field label="标签"><input required value={label} onChange={e => setLabel(e.target.value)}/></Field><Field label="来源"><select value={source} onChange={e => setSource(e.target.value as 'secret' | 'env')}><option value="secret">加密 Secret</option><option value="env">环境变量</option></select></Field><Field label={source === 'secret' ? '凭证值' : '环境变量名'}><input required type={source === 'secret' ? 'password' : 'text'} autoComplete="off" value={value} onChange={e => setValue(e.target.value)}/></Field><div className="field end"><SaveButton busy={busy}>添加凭证</SaveButton></div></form></>}</Panel>;
}
function Models({ upstream, onChange }: { upstream: Upstream; onChange: () => void }) {
  const [model, setModel] = useState(''); const [error, setError] = useState<unknown>(); const [found, setFound] = useState<Model[]>([]); const [busy, setBusy] = useState(false);
  async function discover() { setBusy(true); setError(undefined); try { const response = await post<Model[] | { models: Model[] }>(`/upstreams/${upstream.id}/discover-models`, {}); setFound(Array.isArray(response.data) ? response.data : response.data.models); } catch (err) { setError(err); } finally { setBusy(false); } }
  async function save(models: Model[]) { await patch(`/upstreams/${upstream.id}`, { models }); onChange(); }
  return <Panel title="模型目录" action={<button onClick={discover} disabled={busy || !upstream.endpoints.models || ['oauth', 'google', 'pass-through'].includes(upstream.auth.mode)}>{busy ? '发现中…' : '发现模型'}</button>}>
    <ErrorNotice error={error}/><p className="muted">发现仅确认模型 ID；不验证图片、工具或推理能力。启用前请确认账号权限。</p>
    {!upstream.endpoints.models && <p className="muted">配置模型发现端点后可使用发现功能。</p>}
    <div className="rows">{upstream.models.map(m => <ModelEditor key={m.id} model={m} onSave={async next => save(upstream.models.map(x => x.id === m.id ? next : x))} onError={setError}/>)}</div>
    {found.length > 0 && <div className="notice">仅发现模型 ID（未验证能力）：{found.map(m => m.id).join('、')}</div>}
    <form className="inline-form" onSubmit={e => { e.preventDefault(); if (upstream.models.some(m => m.id === model)) { setError(new Error('模型 ID 已存在')); return; } save([...upstream.models, { id: model, enabled: false, capabilitiesSource: 'manual', capabilities: {} }]).then(() => setModel('')).catch(setError); }}><input aria-label="模型 ID" required value={model} onChange={e => setModel(e.target.value)} placeholder="手动输入模型 ID"/><button type="submit">添加模型</button></form>
  </Panel>;
}

function ModelEditor({ model, onSave, onError }: { model: Model; onSave: (model: Model) => Promise<void>; onError: (error: unknown) => void }) {
  const [draft, setDraft] = useState<Model['capabilities']>(model.capabilities ?? {});
  const [saving, setSaving] = useState(false);
  const changed = capabilityFields.some(([key]) => (draft?.[key] ?? 'unknown') !== (model.capabilities?.[key] ?? 'unknown'));
  async function saveCapabilities() {
    setSaving(true);
    try {
      const { verifiedAt: _verifiedAt, ...rest } = model;
      await onSave({ ...rest, capabilities: { ...model.capabilities, ...draft }, capabilitiesSource: 'manual' });
    } catch (error) { onError(error); } finally { setSaving(false); }
  }
  return <div className="row" style={{ display: 'block' }}>
    <div className="row" style={{ borderTop: 0, paddingTop: 0 }}><div><code>{model.id}</code><small>能力来源：{model.capabilitiesSource === 'verified' ? '已验证' : model.capabilitiesSource === 'preset' ? '预设声明' : '手动声明'}{model.capabilitiesSource === 'verified' && model.verifiedAt ? ` · ${new Date(model.verifiedAt).toLocaleString()}` : ''}</small></div><button onClick={() => onSave({ ...model, enabled: !model.enabled }).catch(onError)}>{model.enabled ? '停用' : '启用'}</button></div>
    <details><summary>编辑能力声明</summary><p className="muted">未知表示尚未确认。手动修改会清除“已验证”标记；连接测试不会自动验证所有能力。</p>
      <div className="form-grid">{capabilityFields.map(([key, label]) => <Field key={key} label={label}><select aria-label={`${model.id} ${label}`} value={draft?.[key] ?? 'unknown'} onChange={e => setDraft({ ...draft, [key as CapabilityKey]: e.target.value as Support })}><option value="unknown">未知</option><option value="supported">支持</option><option value="unsupported">不支持</option></select></Field>)}</div>
      <button type="button" disabled={!changed || saving} onClick={saveCapabilities}>{saving ? '保存中…' : '保存能力声明'}</button>
    </details>
  </div>;
}

interface HealthEvent { id?: string; outcome?: string; status?: number | null; source?: string; startedAt?: string; endedAt?: string | null; from?: string; to?: string; reason?: string; createdAt?: string }
function HealthEvents({ id }: { id: string }) {
  const events = useQuery({ queryKey: ['health-events', id], queryFn: async () => (await get<HealthEvent[]>(`/upstreams/${encodeURIComponent(id)}/health-events`)).data, refetchInterval: 15000 });
  return <Panel title="健康事件与最近尝试"><State loading={events.isPending} error={events.error} retry={() => events.refetch()} empty={events.data?.length === 0} emptyAction={<p className="muted">尚无健康事件或请求尝试。</p>}>
    <ol className="timeline">{events.data?.map((event, index) => <li key={event.id ?? index}>
      <strong>{event.from && event.to ? `${event.from} → ${event.to}` : event.outcome ?? '状态变化'}</strong>
      {event.status != null && <span> · HTTP {event.status}</span>}{event.reason && <span> · {event.reason}</span>}
      <small>{event.startedAt ?? event.createdAt ?? '时间未知'}{event.source ? ` · ${event.source}` : ''}{event.endedAt ? ` · 结束 ${event.endedAt}` : ''}</small>
    </li>)}</ol>
  </State></Panel>;
}
function Runtime({ id }: { id: string }) {
  const [jobId, setJobId] = useState('');
  const [error, setError] = useState<unknown>();
  const [stopping, setStopping] = useState(false);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['runtime', id],
    queryFn: async () => (await get<Record<string, unknown>>(`/upstreams/${encodeURIComponent(id)}/runtime`)).data,
    refetchInterval: 5000,
  });
  const terminalStates = ['completed', 'failed', 'cancelled', 'interrupted'];
  const job = useQuery({
    queryKey: ['job', jobId],
    enabled: !!jobId,
    queryFn: async () => (await get<{ status: string; error?: string; result?: unknown }>(`/jobs/${encodeURIComponent(jobId)}`)).data,
    refetchInterval: query => terminalStates.includes(query.state.data?.status ?? '') ? false : 2000,
  });
  const running = ['queued', 'running'].includes(job.data?.status ?? '');
  async function test() {
    setJobId('');
    setError(undefined);
    try {
      const response = await post<{ jobId?: string; id?: string }>(`/upstreams/${encodeURIComponent(id)}/test`, {});
      setJobId(response.data.jobId ?? response.data.id ?? '');
    } catch (err) { setError(err); }
  }
  async function stop() {
    if (!jobId) return;
    setStopping(true);
    setError(undefined);
    try {
      const response = await post<{ status: string; error?: string; result?: unknown }>(
        `/upstreams/${encodeURIComponent(id)}/test-jobs/${encodeURIComponent(jobId)}/cancel`, {},
      );
      qc.setQueryData(['job', jobId], response.data);
    } catch (err) { setError(err); }
    finally { setStopping(false); }
  }
  return <>
    <State loading={q.isPending} error={q.error} retry={() => q.refetch()}><pre className="small-code">{JSON.stringify(q.data, null, 2)}</pre></State>
    <button onClick={test} disabled={running}>测试连接</button>
    {running && <button onClick={stop} disabled={stopping}>{stopping ? '正在停止…' : '停止测试'}</button>}
    <ErrorNotice error={error}/>
    {jobId && <div className="notice" aria-live="polite">
      测试任务 {jobId} · {job.data?.status ?? '查询中'}
      {job.data?.status === 'cancelled' && <p>测试已取消</p>}
      {job.data?.error && <p>{job.data.error}</p>}
      {job.data?.result !== undefined && <pre className="small-code">{JSON.stringify(job.data.result, null, 2)}</pre>}
    </div>}
  </>;
}
