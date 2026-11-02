import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import {
  type ApiKeyMetadata,
  type CreatedApiKey,
  saasClient,
  type TenantRole,
} from '../api/saas-client';
import { getPublicConnectionSettings, listGatewayModels } from '../api/saas-personal-client';
import { saasWalletClient } from '../api/saas-wallet-client';
import { Badge, Field, Panel, State } from '../components/ui';
import { formatMinorUnits } from './saas-wallet';
import './saas-personal.css';

const tenantsKey = ['saas-console', 'tenants'] as const;
const projectsRootKey = ['saas-console', 'projects'] as const;
const apiKeysRootKey = ['saas-console', 'api-keys'] as const;
const publicConnectionKey = ['saas-console', 'public-connection'] as const;
const keyManagementRoles = new Set<TenantRole>(['owner', 'admin', 'developer']);

export const personalClients = ['claude-code', 'codex-cli', 'openai-sdk', 'gemini-sdk'] as const;
export type PersonalClient = (typeof personalClients)[number];

const clientLabels: Record<PersonalClient, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'openai-sdk': 'OpenAI SDK',
  'gemini-sdk': 'Gemini SDK',
};

export function isPersonalClient(value: string | undefined): value is PersonalClient {
  return personalClients.some((client) => client === value);
}

function usePersonalData() {
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: ({ signal }) => saasClient.getTenants({ signal }), retry: false });
  const tenant = tenants.data?.[0];
  const tenantId = tenant?.id;
  const projects = useQuery({
    queryKey: [...projectsRootKey, tenantId ?? ''],
    queryFn: ({ signal }) => {
      if (!tenantId) throw new Error('默认工作区尚未就绪。');
      return saasClient.getProjects(tenantId, { signal });
    },
    enabled: Boolean(tenantId),
    retry: false,
  });
  const project = projects.data?.find((item) => item.id === tenant?.defaultProjectId) ?? projects.data?.[0];
  const projectId = project?.id;
  const canManage = Boolean(
    tenant && project && keyManagementRoles.has(tenant.role) && keyManagementRoles.has(project.role),
  );
  const keyListKey = [...apiKeysRootKey, tenantId ?? '', projectId ?? ''] as const;
  const keys = useQuery({
    queryKey: keyListKey,
    queryFn: () => {
      if (!tenantId || !projectId) throw new Error('默认工作区尚未就绪。');
      return saasClient.getApiKeys(tenantId, projectId);
    },
    enabled: Boolean(tenantId && projectId && canManage),
    retry: false,
  });
  const canViewWallet = tenant?.role === 'owner' || tenant?.role === 'admin';
  const topUpPolicy = useQuery({
    queryKey: ['saas-wallet', 'topup-policy', tenantId ?? ''] as const,
    queryFn: ({ signal }) => {
      if (!tenant) throw new Error('账户尚未就绪。');
      return saasWalletClient.getWalletTopUpPolicy(tenant, signal);
    },
    enabled: Boolean(tenant && canViewWallet),
    retry: false,
  });
  const currency = topUpPolicy.data?.available ? topUpPolicy.data.currency : null;
  const wallet = useQuery({
    queryKey: ['saas-wallet', 'wallet', tenantId ?? '', currency ?? '', ''] as const,
    queryFn: ({ signal }) => {
      if (!tenant || !currency) throw new Error('钱包币种尚未就绪。');
      return saasWalletClient.getWallet(tenant, { currency, limit: 1, signal });
    },
    enabled: Boolean(tenant && currency && canViewWallet),
    retry: false,
  });
  const connection = useQuery({
    queryKey: publicConnectionKey,
    queryFn: ({ signal }) => getPublicConnectionSettings(signal),
    retry: false,
    staleTime: 60_000,
  });
  return { tenants, tenant, projects, project, canManage, keys, keyListKey, topUpPolicy, wallet, connection };
}

type PersonalData = ReturnType<typeof usePersonalData>;

function PersonalBalance({ data }: { data: PersonalData }) {
  const { tenant, topUpPolicy, wallet } = data;
  const canViewWallet = tenant?.role === 'owner' || tenant?.role === 'admin';
  return <Panel title="当前余额" action={<Link to="/console/billing">订单</Link>}>
    {!canViewWallet ? <p className="muted">当前角色没有钱包查看权限。</p> : <>
      <State loading={topUpPolicy.isPending} error={topUpPolicy.error} retry={() => { void topUpPolicy.refetch(); }}>
        {topUpPolicy.data?.available === false ? <div className="empty">平台暂未开放在线充值。</div> : <>
          <State loading={wallet.isPending} error={wallet.error} retry={() => { void wallet.refetch(); }}>
            {wallet.data && <div className="personal-balance">
              <strong>{wallet.data.wallet.currency} {formatMinorUnits(wallet.data.wallet.availableMinorUnits)}</strong>
              <small>可用余额 · 最小货币单位</small>
            </div>}
          </State>
          <div className="actions"><Link className="button-link primary" to="/console/wallet">去充值</Link></div>
        </>}
      </State>
    </>}
  </Panel>;
}

interface ConfigurationState {
  key: ApiKeyMetadata;
  secret: string;
  models: string[];
  loading: boolean;
  error: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function absoluteApiRoot(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!/^https?:\/\//i.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? trimmed : '';
  } catch {
    return '';
  }
}

interface ConfigurationInput {
  client: PersonalClient;
  baseUrl: string;
  secret: string;
  model: string;
}

export function personalClientConfiguration({ client, baseUrl, secret, model }: ConfigurationInput): string {
  const root = absoluteApiRoot(baseUrl);
  if (!root || !model || !secret) return '';
  const openAiBase = `${root}/v1`;
  if (client === 'claude-code') {
    return [
      `export ANTHROPIC_BASE_URL=${shellQuote(root)}`,
      `export ANTHROPIC_AUTH_TOKEN=${shellQuote(secret)}`,
      `export ANTHROPIC_MODEL=${shellQuote(model)}`,
      `claude -p ${shellQuote('请回复 OK')}`,
    ].join('\n');
  }
  if (client === 'codex-cli') {
    return [
      `export MODEL_ROUTER_API_KEY=${shellQuote(secret)}`,
      `codex -c ${shellQuote(`model=${JSON.stringify(model)}`)} -c ${shellQuote('model_provider="model-router"')} -c ${shellQuote(`model_providers.model-router.base_url=${JSON.stringify(openAiBase)}`)} -c ${shellQuote('model_providers.model-router.env_key="MODEL_ROUTER_API_KEY"')} -c ${shellQuote('model_providers.model-router.wire_api="responses"')} exec ${shellQuote('请回复 OK')}`,
    ].join('\n');
  }
  if (client === 'openai-sdk') {
    return `import OpenAI from "openai";\n\nconst client = new OpenAI({ apiKey: ${JSON.stringify(secret)}, baseURL: ${JSON.stringify(openAiBase)} });\nconst response = await client.responses.create({ model: ${JSON.stringify(model)}, input: "请回复 OK" });\nconsole.log(response.output_text);`;
  }
  return `import { GoogleGenAI } from "@google/genai";\n\nconst ai = new GoogleGenAI({ apiKey: ${JSON.stringify(secret)}, httpOptions: { baseUrl: ${JSON.stringify(root)} } });\nconst response = await ai.models.generateContent({ model: ${JSON.stringify(model)}, contents: "请回复 OK" });\nconsole.log(response.text);`;
}

function ClientConfiguration({ configuration, baseUrl, onRetry, onClose }: {
  configuration: ConfigurationState;
  baseUrl: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [client, setClient] = useState<PersonalClient>('claude-code');
  const [model, setModel] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  useEffect(() => { setModel(configuration.models[0] ?? ''); setCopyMessage(''); }, [configuration.key.id, configuration.models]);
  const text = personalClientConfiguration({ client, baseUrl, secret: configuration.secret, model });
  const tutorial = `/console/connect/${client}${model ? `?model=${encodeURIComponent(model)}` : ''}`;
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage('配置已复制。请只在受信任的终端或项目中使用。');
    } catch {
      setCopyMessage('自动复制失败，请手动选择配置文本复制。');
    }
  }
  return <div className="personal-config notice secret" role="region" aria-label={`${configuration.key.name} 客户端配置`}>
    <strong>Key 已就绪：{configuration.key.name}</strong>
    <span>完整 Key 只保留在当前页面内存中。请勿分享截图或把配置提交到代码仓库。</span>
    {configuration.loading ? <p role="status">正在通过 /v1/models 验证 Key 并读取实际可用模型…</p> : configuration.error ? <div role="alert">
      <p>{configuration.error}</p><button type="button" onClick={onRetry}>重试读取模型</button>
    </div> : <>
      <Field label="客户端">
        <select value={client} onChange={(event) => { setClient(event.target.value as PersonalClient); setCopyMessage(''); }}>
          {personalClients.map((item) => <option key={item} value={item}>{clientLabels[item]}</option>)}
        </select>
      </Field>
      <Field label="模型" hint="此列表来自刚刚使用该 Key 请求的 /v1/models。">
        <select value={model} onChange={(event) => { setModel(event.target.value); setCopyMessage(''); }} disabled={configuration.models.length === 0}>
          {configuration.models.length === 0 ? <option value="">当前 Key 没有可用模型</option> : configuration.models.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </Field>
      {!absoluteApiRoot(baseUrl) && <p role="alert">平台尚未配置可用的公网接入地址，暂时不能生成可复制配置。</p>}
      {text && <textarea className="code personal-config-code" readOnly value={text} rows={client === 'codex-cli' ? 5 : 7} onFocus={(event) => event.currentTarget.select()} />}
      <div className="actions">
        <button className="primary" type="button" disabled={!text} onClick={() => { void copy(); }}>复制 {clientLabels[client]} 配置</button>
        <Link to={tutorial}>查看安装与验证教程</Link>
        <button type="button" onClick={onClose}>隐藏配置</button>
      </div>
      {copyMessage && <small role="status">{copyMessage}</small>}
    </>}
  </div>;
}

function PersonalKeys({ data, compact = false }: { data: PersonalData; compact?: boolean }) {
  const { tenant, project, canManage, keys, keyListKey, connection } = data;
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [secretDraft, setSecretDraft] = useState('');
  const [configuration, setConfiguration] = useState<ConfigurationState>();
  const generation = useRef(0);
  // Omitted modelScopes let the server default to the entitlement's full
  // model set (M1-L) — no scope ceremony, and no dependency on an existing
  // platform key to copy scopes from.
  const canCreate = Boolean(tenant && project && canManage && !createBusy);

  async function beginConfiguration(key: ApiKeyMetadata, secret: string) {
    const current = ++generation.current;
    setSelectedKeyId(key.id);
    setSecretDraft('');
    setConfiguration({ key, secret, models: [], loading: true, error: '' });
    try {
      const models = await listGatewayModels(secret);
      if (generation.current === current) setConfiguration({ key, secret, models, loading: false, error: '' });
    } catch {
      if (generation.current === current) setConfiguration({ key, secret, models: [], loading: false, error: '无法验证 Key 或读取 /v1/models。请确认 Key 有效且未过期后重试。' });
    }
  }

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!tenant || !project || !canCreate) return;
    setCreateBusy(true);
    setCreateError('');
    try {
      const created: CreatedApiKey = await saasClient.createApiKey(tenant.id, project.id, {
        name: name.trim() || `我的 Key ${(keys.data?.length ?? 0) + 1}`,
        supplyMode: 'platform',
      });
      setName('');
      void queryClient.invalidateQueries({ queryKey: keyListKey });
      await beginConfiguration(created, created.secret);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建失败，请稍后重试。');
    } finally {
      setCreateBusy(false);
    }
  }

  function closeConfiguration() {
    generation.current += 1;
    setConfiguration(undefined);
    setSecretDraft('');
  }

  const keyItems = compact ? keys.data?.slice(0, 3) : keys.data;
  return <Panel title="我的 Key" action={<div className="actions"><Link to="/console/keys">全部 Key</Link><Link to="/console/keys/advanced">高级</Link></div>}>
    {canManage ? <form className="personal-key-form" onSubmit={(event) => { void createKey(event); }}>
      <Field label="名字（可选）" hint="留空时自动生成名称。">
        <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="我的 Key" />
      </Field>
      {keys.data?.length === 1 && <p className="personal-second-key">为每个使用人建一个 Key，便于分别查看用量和停止使用。</p>}
      {createError && <p className="form-error" role="alert">{createError}</p>}
      <div className="actions"><button className="primary" type="submit" disabled={!canCreate}>{createBusy ? '创建中…' : '创建 Key'}</button></div>
    </form> : <p className="muted">当前角色不能创建 Key。</p>}
    <State loading={canManage && (data.tenants.isPending || data.projects.isPending || keys.isPending)} error={data.tenants.error || data.projects.error || keys.error}>
      {configuration && <ClientConfiguration configuration={configuration} baseUrl={connection.data?.apiBaseUrl ?? ''}
        onRetry={() => { void beginConfiguration(configuration.key, configuration.secret); }} onClose={closeConfiguration} />}
      {keys.data?.length === 0 ? <div className="empty">还没有 Key。创建后即可复制客户端配置。</div> : <div className="personal-key-list">
        {keyItems?.map((key) => <article className="personal-key-row" key={key.id}>
          <div><strong>{key.name}</strong><small><code>{key.prefix}…</code> · 创建于 {new Date(key.createdAt).toLocaleDateString('zh-CN')}</small></div>
          <Badge tone={key.status === 'active' ? 'good' : 'bad'}>{key.status === 'active' ? '可用' : '已吊销'}</Badge>
          {key.status === 'active' && <button type="button" aria-expanded={selectedKeyId === key.id} onClick={() => {
            if (configuration?.key.id !== key.id) closeConfiguration();
            setSelectedKeyId((current) => current === key.id ? '' : key.id);
            setSecretDraft('');
          }}>配置客户端</button>}
          {selectedKeyId === key.id && configuration?.key.id !== key.id && <form className="personal-secret-form" onSubmit={(event) => {
            event.preventDefault();
            if (secretDraft.trim()) void beginConfiguration(key, secretDraft.trim());
          }}>
            <Field label={`输入“${key.name}”的完整 Key`} hint="服务端不会再次返回旧 Key；此处仅用于本次验证和生成配置，不会保存。">
              <input required type="password" autoComplete="off" value={secretDraft} onChange={(event) => setSecretDraft(event.target.value)} />
            </Field>
            <button type="submit" disabled={!secretDraft.trim()}>读取模型并生成配置</button>
          </form>}
        </article>)}
        {compact && (keys.data?.length ?? 0) > 3 && <Link to="/console/keys">查看其余 Key</Link>}
      </div>}
    </State>
  </Panel>;
}

function ClientConnections() {
  return <Panel title="配置客户端">
    <p>选择客户端，按“安装 → 配置 → 验证一条请求”完成接入。</p>
    <div className="personal-client-links">{personalClients.map((client) => <Link key={client} to={`/console/connect/${client}`}>{clientLabels[client]}<small>安装与验证教程</small></Link>)}</div>
    <small>可复制配置在“我的 Key”中生成；模型列表由该 Key 实时请求 /v1/models 获得。</small>
  </Panel>;
}

export function PersonalHome() {
  const data = usePersonalData();
  return <div className="personal-console">
    <div className="page-title"><div><p className="eyebrow">MY CONSOLE</p><h1>我的控制台</h1><p>余额、充值、Key 和客户端配置，从这里开始。</p></div></div>
    <div className="personal-home-grid">
      <PersonalBalance data={data} />
      <ClientConnections />
      <PersonalKeys data={data} compact />
    </div>
    <nav className="personal-secondary-links" aria-label="用量与订单"><Link to="/console/usage">我的用量</Link><Link to="/console/billing">订单</Link></nav>
  </div>;
}

export function PersonalKeysPage() {
  const data = usePersonalData();
  return <div className="personal-console"><div className="page-title"><div><p className="eyebrow">MY KEYS</p><h1>我的 Key</h1><p>创建 Key，并为每个 Key 生成对应客户端的可复制配置。</p></div></div><PersonalKeys data={data} /></div>;
}

const installCommands: Record<PersonalClient, string> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  'codex-cli': 'npm install -g @openai/codex',
  'openai-sdk': 'npm install openai',
  'gemini-sdk': 'npm install @google/genai',
};

export function PersonalClientGuidePage() {
  const { client: candidate } = useParams();
  const [params] = useSearchParams();
  const connection = useQuery({ queryKey: publicConnectionKey, queryFn: ({ signal }) => getPublicConnectionSettings(signal), retry: false });
  if (!isPersonalClient(candidate)) return <Navigate to="/console" replace />;
  const client = candidate;
  const model = (params.get('model') ?? '').slice(0, 256);
  const placeholder = '<你的 Key>';
  const example = personalClientConfiguration({
    client,
    baseUrl: connection.data?.apiBaseUrl ?? '',
    secret: placeholder,
    model: model || '<从 /v1/models 选择模型>',
  });
  return <div className="personal-console"><div className="page-title"><div><p className="eyebrow">CLIENT GUIDE</p><h1>{clientLabels[client]} 接入</h1><p>安装、配置，然后验证一条真实请求。</p></div></div>
    <Panel title="1. 安装"><pre className="response-output"><code>{installCommands[client]}</code></pre></Panel>
    <Panel title="2. 配置" action={<Link to="/console/keys">从我的 Key 生成配置</Link>}>
      <p>推荐从“我的 Key”复制配置，系统会填入完整 Key、平台接入地址和 /v1/models 实际返回的模型。下面的教程不保存 Key。</p>
      <State loading={connection.isPending} error={connection.error} retry={() => { void connection.refetch(); }}>
        {example ? <textarea className="code personal-config-code" readOnly rows={8} value={example} onFocus={(event) => event.currentTarget.select()} /> : <div className="notice">平台尚未配置公网接入地址。请先在平台设置中填写 API Base URL。</div>}
      </State>
    </Panel>
    <Panel title="3. 验证一条请求">
      <ol className="personal-tutorial-steps">
        <li>将从“我的 Key”复制的配置放到受信任的终端或项目中；教程里的占位符不能直接调用。</li>
        <li>{client === 'claude-code' || client === 'codex-cli' ? '运行配置块最后一条命令。' : '将配置保存为入口文件并运行，例如 node index.mjs。'}</li>
        <li>看到包含 OK 的响应即完成首次调用；随后可到<Link to="/console/usage">我的用量</Link>查看记录。</li>
      </ol>
      <div className="actions"><Link className="button-link primary" to="/console/keys">去复制完整配置</Link><Link to="/console">返回我的控制台</Link></div>
    </Panel>
  </div>;
}
