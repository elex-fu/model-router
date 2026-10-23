import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { PlatformApiError, platformClient, request, type PlatformCapacityPolicyTargetPage, type PlatformPriceVersion, type PlatformSupplyAccount } from '../api/saas-platform-client';
import { Badge, Field, Panel } from '../components/ui';

type RecordValue = Record<string, unknown>;
interface RouteArtifact {
  routeId: string;
  definition: RecordValue & { publicModelId: string; publicModelVersion: string; protocol: string; endpoint: string };
  customerPolicy: { policyId: string; definition: RecordValue & { customerPriceVersion: string } };
  providerPolicy: { policyId: string; definition: RecordValue & { providerId: string; productId: string; supplierCostVersion: string } };
  attestation: RecordValue & { signatureBase64: string };
}
export interface PlatformAccessArtifact {
  operationKey: string; tenantId: string; projectId: string;
  pool: RecordValue & { id: string; expectedAuthzVersion: string };
  capacity: RecordValue & { tenantExpectedRevision: string; projectExpectedRevision: string; projectLimits: Record<string, number>; tenantLimits?: Record<string, number> };
  routes: RouteArtifact[];
}
export interface PlatformAccessOperation {
  id: string; tenantId: string; projectId: string; profileId: string; entitlementId: string;
  phase: 'assembling' | 'recheck' | 'completed' | 'failed' | 'disabled';
  receipts: Record<string, string>; lastErrorCode: string | null; entitlementAuthzVersion?: string;
}
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
export function parsePlatformAccessArtifact(value: unknown): PlatformAccessArtifact {
  if (!record(value) || !text(value.operationKey) || !text(value.tenantId) || !text(value.projectId) || !record(value.pool) || !text(value.pool.id) || !decimal(value.pool.expectedAuthzVersion) || !record(value.capacity) || !decimal(value.capacity.tenantExpectedRevision) || !decimal(value.capacity.projectExpectedRevision) || !record(value.capacity.projectLimits) || !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 20) throw new Error('开通配置格式不完整，需使用已审核的原始配置文件。');
  for (const item of value.routes) {
    if (!record(item) || !text(item.routeId) || !record(item.definition) || !text(item.definition.publicModelId) || !decimal(item.definition.publicModelVersion) || !text(item.definition.protocol) || !text(item.definition.endpoint) || !record(item.customerPolicy) || !record(item.customerPolicy.definition) || !text(item.customerPolicy.definition.customerPriceVersion) || !record(item.providerPolicy) || !record(item.providerPolicy.definition) || !text(item.providerPolicy.definition.providerId) || !text(item.providerPolicy.definition.productId) || !text(item.providerPolicy.definition.supplierCostVersion) || !record(item.attestation) || !text(item.attestation.signatureBase64)) throw new Error('开通配置缺少模型、价格引用或原始签名凭据，请重新导入已审核配置。');
  }
  return value as unknown as PlatformAccessArtifact;
}
export function parsePlatformAccessOperation(value: unknown): PlatformAccessOperation {
  if (!record(value) || !text(value.id) || !text(value.tenantId) || !text(value.projectId) || !text(value.profileId) || !text(value.entitlementId) || !['assembling', 'recheck', 'completed', 'failed', 'disabled'].includes(String(value.phase)) || !record(value.receipts) || !Object.values(value.receipts).every(text) || !(value.lastErrorCode === null || text(value.lastErrorCode)) || !(value.entitlementAuthzVersion === undefined || decimal(value.entitlementAuthzVersion))) throw new Error('无法识别开通状态，请重新查询。');
  return value as unknown as PlatformAccessOperation;
}
const base = '/supply/platform-access';
const phaseLabels = { assembling: '正在配置', recheck: '正在复核', completed: '已开通', failed: '开通未完成', disabled: '已停用' };
function errorCopy(cause: unknown): string {
  if (cause instanceof PlatformApiError) {
    if (cause.status === 409) return '操作状态或配置版本发生变化。请查询现有操作，核对后使用原配置恢复。';
    if (cause.status === 503) return '开通暂未完成，请确认配置所引用的供给、价格与审核材料可用，再查询或恢复原操作。';
    if (cause.status === 401 || cause.status === 403) return '管理员会话或权限不足，请重新登录并确认运营权限。';
    if (cause.status === 404) return '未找到该操作或所选资源，请核对后重试。';
    return '服务端未接受此操作，请核对已审核配置并查询原操作状态。';
  }
  return cause instanceof Error ? cause.message : '请求结果尚未确认，请查询原操作。';
}
const storageKey = 'platform-access:last-operation';
function capacityLabel(limits: Record<string, number>): string {
  return `每分钟请求 ${limits.requestsPerMinute ?? '—'}；每分钟 Token ${limits.tokensPerMinute ?? '—'}；同时请求 ${limits.maxConcurrentRequests ?? '—'}`;
}
export function PlatformAccessPage({ canManage }: { canManage: boolean }) {
  const [tenants, setTenants] = useState<PlatformCapacityPolicyTargetPage>({ items: [], nextCursor: null });
  const [projects, setProjects] = useState<PlatformCapacityPolicyTargetPage>({ items: [], nextCursor: null });
  const [tenantId, setTenantId] = useState(''); const [projectId, setProjectId] = useState('');
  const [accounts, setAccounts] = useState<PlatformSupplyAccount[]>([]);
  const [artifact, setArtifact] = useState<PlatformAccessArtifact>();
  const [prices, setPrices] = useState<PlatformPriceVersion[]>([]);
  const [currency, setCurrency] = useState('CNY');
  const [confirmed, setConfirmed] = useState(false);
  const [operation, setOperation] = useState<PlatformAccessOperation>();
  const [lookupId, setLookupId] = useState(() => { try { return window.sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const [reason, setReason] = useState('customer_request'); const [disableConfirmed, setDisableConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [reviewBusy, setReviewBusy] = useState(false); const [error, setError] = useState('');
  const importGeneration = useRef(0);
  const pollCount = useRef(0);
  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    void Promise.all([platformClient.listCapacityPolicyTenants(undefined, { signal: controller.signal }), platformClient.listSupplyAccounts({ signal: controller.signal })]).then(([page, supply]) => { setTenants(page); setAccounts(supply); }).catch(cause => { if (!controller.signal.aborted) setError(errorCopy(cause)); });
    return () => controller.abort();
  }, [canManage]);
  useEffect(() => {
    setProjectId(''); setProjects({ items: [], nextCursor: null }); setConfirmed(false);
    if (!canManage || !tenantId) return;
    const controller = new AbortController();
    void platformClient.listCapacityPolicyProjects(tenantId, undefined, { signal: controller.signal }).then(setProjects).catch(cause => { if (!controller.signal.aborted) setError(errorCopy(cause)); });
    return () => controller.abort();
  }, [canManage, tenantId]);
  useEffect(() => {
    setPrices([]); setConfirmed(false);
    if (!canManage || !artifact || !/^[A-Z]{3}$/.test(currency)) return;
    const controller = new AbortController(); setReviewBusy(true);
    void Promise.all(artifact.routes.flatMap(route => (['customer', 'supplier'] as const).map(async kind => {
      const versions: PlatformPriceVersion[] = []; let cursor: string | undefined;
      const ref = kind === 'customer' ? route.customerPolicy.definition.customerPriceVersion : route.providerPolicy.definition.supplierCostVersion;
      do {
        const page = await platformClient.listPriceVersionHistory({ kind, publicModelId: route.definition.publicModelId, publicModelVersion: Number(route.definition.publicModelVersion), protocol: route.definition.protocol, endpoint: route.definition.endpoint, currency, cursor, limit: 100, signal: controller.signal });
        versions.push(...page.items); cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
        if (versions.some(price => price.id === ref)) break;
      } while (cursor);
      const price = versions.find(candidate => candidate.id === ref);
      if (!price) throw new Error('所选币种下未找到配置引用的已发布价格，请核对币种和价格版本。');
      return price;
    }))).then(setPrices).catch(cause => { if (!controller.signal.aborted) setError(errorCopy(cause)); }).finally(() => { if (!controller.signal.aborted) setReviewBusy(false); });
    return () => controller.abort();
  }, [canManage, artifact, currency]);
  useEffect(() => {
    if (!canManage || !operation || !['assembling', 'recheck'].includes(operation.phase) || pollCount.current >= 12) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      pollCount.current += 1;
      void request(`${base}/operations/${encodeURIComponent(operation.id)}`, { signal: controller.signal })
        .then(parsePlatformAccessOperation).then(setOperation)
        .catch(cause => { if (!controller.signal.aborted) setError(errorCopy(cause)); });
    }, Math.min(5_000 * 2 ** Math.floor(pollCount.current / 3), 30_000));
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [canManage, operation]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') { pollCount.current = 0; setOperation(current => current ? { ...current } : current); }
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);
  function saveOperation(next: PlatformAccessOperation) {
    pollCount.current = 0; setOperation(next); setLookupId(next.id); setDisableConfirmed(false);
    try { window.sessionStorage.setItem(storageKey, next.id); } catch { /* In-page recovery remains available. */ }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; const generation = ++importGeneration.current;
    setArtifact(undefined); setConfirmed(false); setError('');
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error('配置文件过大，请导入不超过 1 MB 的已审核配置。');
      const parsed = parsePlatformAccessArtifact(JSON.parse(await file.text()));
      if (generation === importGeneration.current) setArtifact(parsed);
    } catch (cause) { if (generation === importGeneration.current) setError(errorCopy(cause)); }
  }
  async function lookup(event?: FormEvent) {
    event?.preventDefault(); if (!lookupId.trim()) return;
    setBusy(true); setError('');
    try { saveOperation(parsePlatformAccessOperation(await request(`${base}/operations/${encodeURIComponent(lookupId.trim())}`))); }
    catch (cause) { setError(errorCopy(cause)); } finally { setBusy(false); }
  }
  const matchedScope = Boolean(artifact && artifact.tenantId === tenantId && artifact.projectId === projectId);
  async function provision() {
    if (!artifact || !matchedScope || !confirmed || prices.length !== artifact.routes.length * 2) return;
    setBusy(true); setError('');
    try {
      const next = parsePlatformAccessOperation(await request(`${base}/operations`, { method: 'POST', body: artifact }));
      saveOperation(next);
      saveOperation(parsePlatformAccessOperation(await request(`${base}/operations/${encodeURIComponent(next.id)}`)));
    } catch (cause) { setError(errorCopy(cause)); } finally { setBusy(false); }
  }
  async function disable() {
    if (!operation || !operation.entitlementAuthzVersion || !disableConfirmed) return;
    setBusy(true); setError('');
    try { saveOperation(parsePlatformAccessOperation(await request(`${base}/disable`, { method: 'POST', body: { operationId: operation.id, expectedEntitlementVersion: operation.entitlementAuthzVersion, reason } }))); }
    catch (cause) { setError(errorCopy(cause)); } finally { setBusy(false); }
  }
  if (!canManage) return <p role="status">仅运营管理员和超级管理员可开通平台模型访问。</p>;
  return <><div className="page-title"><div><h1>平台模型访问开通</h1><p>为租户项目开通已审核的平台模型、价格及容量配置。</p></div></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <Panel title="选择开通对象">
      <Field label="租户"><select disabled={busy} value={tenantId} onChange={event => { setTenantId(event.target.value); setConfirmed(false); }}><option value="">选择租户</option>{tenants.items.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field>
      {tenants.nextCursor && <button type="button" onClick={() => void platformClient.listCapacityPolicyTenants(tenants.nextCursor ?? undefined).then(page => setTenants(previous => ({ items: [...previous.items, ...page.items], nextCursor: page.nextCursor }))).catch(cause => setError(errorCopy(cause)))}>加载更多租户</button>}
      <Field label="项目"><select disabled={busy || !tenantId} value={projectId} onChange={event => { setProjectId(event.target.value); setConfirmed(false); }}><option value="">选择项目</option>{projects.items.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field>
      {projects.nextCursor && <button type="button" onClick={() => void platformClient.listCapacityPolicyProjects(tenantId, projects.nextCursor ?? undefined).then(page => setProjects(previous => ({ items: [...previous.items, ...page.items], nextCursor: page.nextCursor }))).catch(cause => setError(errorCopy(cause)))}>加载更多项目</button>}
      <Field label="已审核的开通配置文件" hint="导入包含原始签名审核材料的 JSON 文件，页面只读取和提交原配置；恢复时需重新导入同一文件。"><input type="file" accept=".json,application/json" disabled={busy} onChange={event => void importFile(event)}/></Field>
      <Field label="核对价格币种"><input maxLength={3} pattern="[A-Z]{3}" value={currency} disabled={busy} onChange={event => { setCurrency(event.target.value.toUpperCase()); setError(''); }}/></Field>
    </Panel>
    {artifact && <Panel title="开通配置摘要">
      <dl className="summary-list"><dt>租户 / 项目</dt><dd>{artifact.tenantId} / {artifact.projectId}</dd><dt>供给池 / 版本</dt><dd>{artifact.pool.id} / {artifact.pool.expectedAuthzVersion}</dd><dt>操作标识</dt><dd><code>{artifact.operationKey}</code></dd></dl>
      {!matchedScope && <p className="notice" role="status">请在上方选择与导入配置一致的租户和项目。</p>}
      <div className="table-wrap"><table aria-label="模型和价格确认"><thead><tr><th>模型 / 版本</th><th>协议 / 端点</th><th>供给</th><th>价格引用</th></tr></thead><tbody>{artifact.routes.map(route => <tr key={route.routeId}><td>{route.definition.publicModelId} / {route.definition.publicModelVersion}</td><td>{route.definition.protocol} / {route.definition.endpoint}</td><td>{route.providerPolicy.definition.providerId} / {route.providerPolicy.definition.productId}</td><td>客户 {route.customerPolicy.definition.customerPriceVersion}<br/>供给 {route.providerPolicy.definition.supplierCostVersion}</td></tr>)}</tbody></table></div>
      {reviewBusy && <p role="status">正在核对已发布价格…</p>}
      {prices.map((price, index) => <p key={`${price.kind}:${price.id}:${index}`}>{price.kind === 'customer' ? '客户价格' : '供给成本'} {price.id}：{price.currency}，输入 {price.rates.input ? `${price.rates.input.numeratorMinorUnits}/${price.rates.input.denominatorUnits}` : '未设置'}，输出 {price.rates.output ? `${price.rates.output.numeratorMinorUnits}/${price.rates.output.denominatorUnits}` : '未设置'}（最小货币单位/计量单位）</p>)}
      <p>项目容量：{capacityLabel(artifact.capacity.projectLimits)}；项目策略版本 {artifact.capacity.projectExpectedRevision}</p>
      <p>租户容量：{artifact.capacity.tenantLimits ? capacityLabel(artifact.capacity.tenantLimits) : '使用当前已配置容量'}；版本 {artifact.capacity.tenantExpectedRevision}</p>
      <p>相关平台供给账户：{accounts.filter(account => artifact.routes.some(route => route.providerPolicy.definition.providerId === account.providerId && route.providerPolicy.definition.productId === account.productId)).map(account => `${account.displayName}（${account.status} / ${account.validationState}）`).join('；') || '未读取到匹配账户'}</p>
      <p className="muted">账户列表供核对供给信息；供给池成员、签名材料和所有价格、容量版本由服务端最终校验。仅服务端“已开通”表示访问已生效。</p>
      <label><input type="checkbox" checked={confirmed} disabled={busy || reviewBusy || !matchedScope || prices.length !== artifact.routes.length * 2} onChange={event => setConfirmed(event.target.checked)}/>已核对模型、币种、价格、容量和供给，确认提交已审核配置</label>
      <div className="actions"><button className="primary" type="button" disabled={busy || !confirmed || reviewBusy || !matchedScope} onClick={() => void provision()}>{busy ? '正在提交…' : '开通 / 使用原配置恢复'}</button></div>
    </Panel>}
    <Panel title="操作查询与恢复">
      <form className="filters" onSubmit={event => void lookup(event)}><Field label="操作 ID"><input required maxLength={200} value={lookupId} disabled={busy} onChange={event => setLookupId(event.target.value)}/></Field><button type="submit" disabled={busy}>查询 / 刷新操作</button></form>
      <p className="muted">提交超时不代表失败。已知操作 ID 时先查询；没有收到 ID 时重新导入同一配置并使用原操作标识恢复，勿另建操作。</p>
      {operation && <><Badge tone={operation.phase === 'completed' ? 'good' : operation.phase === 'failed' ? 'warn' : 'neutral'}>{phaseLabels[operation.phase]}</Badge><p>操作 {operation.id}；租户 {operation.tenantId}；项目 {operation.projectId}</p><p>服务端已记录 {Object.keys(operation.receipts).length} 个步骤。</p>{operation.lastErrorCode && <p className="notice" role="status">服务端报告操作未完成，请核对原配置后恢复，或联系平台支持。</p>}
        {operation.phase !== 'disabled' && <><Field label="停用原因"><select value={reason} disabled={busy} onChange={event => { setReason(event.target.value); setDisableConfirmed(false); }}><option value="customer_request">客户要求</option><option value="incident_response">故障处置</option><option value="risk_control">风险控制</option></select></Field><label><input type="checkbox" disabled={busy || !operation.entitlementAuthzVersion} checked={disableConfirmed} onChange={event => setDisableConfirmed(event.target.checked)}/>确认停用此操作关联的项目平台访问</label><button type="button" disabled={busy || !disableConfirmed || !operation.entitlementAuthzVersion} onClick={() => void disable()}>确认停用平台访问</button>{!operation.entitlementAuthzVersion && <p>请先刷新操作，读取当前访问版本。</p>}</>}
      </>}
    </Panel></>;
}
