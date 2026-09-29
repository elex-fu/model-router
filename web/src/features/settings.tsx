import { createElement, useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, request } from '../api/client';
import type { Config, DatabaseCapacity, DatabaseDiagnostic, Job, Pricing, System } from '../api/types';
import { Badge, ErrorNotice, Field, Panel, State, formatDate, useDraftGuard } from '../components/ui';

type ResultJob = Job & { result?: unknown };
type BackupResult = { backupId?: string; path?: string; revision?: number; scope?: string };
type ImportMode = 'replace' | 'merge';
type ImportPreview = { valid: boolean; baseRevision: number; conflicts: unknown[]; errors: unknown[];
  mode: ImportMode; diff: unknown[] };
type PreviewSelection = { data: ImportPreview; text: string; mode: ImportMode; generation: number };
type ConflictChoice = 'mine' | 'latest';
type ConfigConflictState = {
  id: number;
  base: Config;
  mine: Config;
  latest?: Config;
  loading: boolean;
  latestFailed: boolean;
  choices: Record<string, ConflictChoice>;
};
type EditorSnapshot = { base: Config; draft: Config; generation: number };

const missingConfigValue = Symbol('missing-config-value');
const localDateTimeNow = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
};

export interface ConfigConflictField {
  path: string;
  segments: string[];
  base: unknown;
  mine: unknown;
  latest: unknown;
  mineChanged: boolean;
  latestChanged: boolean;
  conflict: boolean;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalConfigValue(left: unknown, right: unknown): boolean {
  if (left === missingConfigValue || right === missingConfigValue) return left === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equalConfigValue(value, right[index]));
  }
  if (!isConfigObject(left) || !isConfigObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && equalConfigValue(left[key], right[key]));
}

function conflictPath(segments: string[]): string {
  return segments.map((segment, index) => /^[\w$-]+$/.test(segment)
    ? `${index === 0 ? '' : '.'}${segment}` : `[${JSON.stringify(segment)}]`).join('');
}

export function configConflictFields(base: Config, mine: Config, latest: Config): ConfigConflictField[] {
  const fields: ConfigConflictField[] = [];
  function visit(before: unknown, draft: unknown, current: unknown, segments: string[]) {
    const canDescend = (isConfigObject(before) && isConfigObject(draft) && isConfigObject(current)) ||
      (before === missingConfigValue && isConfigObject(draft) && isConfigObject(current));
    if (canDescend) {
      const beforeObject = before === missingConfigValue ? {} : before as Record<string, unknown>;
      const draftObject = draft as Record<string, unknown>;
      const currentObject = current as Record<string, unknown>;
      const keys = new Set([...Object.keys(beforeObject), ...Object.keys(draftObject), ...Object.keys(currentObject)]);
      if (!segments.length) keys.delete('revision');
      for (const key of [...keys].sort()) {
        visit(
          Object.hasOwn(beforeObject, key) ? beforeObject[key] : missingConfigValue,
          Object.hasOwn(draftObject, key) ? draftObject[key] : missingConfigValue,
          Object.hasOwn(currentObject, key) ? currentObject[key] : missingConfigValue,
          [...segments, key],
        );
      }
      return;
    }
    const mineChanged = !equalConfigValue(before, draft);
    const latestChanged = !equalConfigValue(before, current);
    if (!mineChanged && !latestChanged) return;
    fields.push({
      path: conflictPath(segments), segments,
      base: before, mine: draft, latest: current,
      mineChanged, latestChanged,
      conflict: mineChanged && latestChanged && !equalConfigValue(draft, current),
    });
  }
  visit(base, mine, latest, []);
  return fields;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneConfigValue);
  if (isConfigObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneConfigValue(item)]));
  return value;
}

function applyConfigField(config: Config, segments: string[], value: unknown) {
  let target = config as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    if (!isConfigObject(target[segment])) target[segment] = {};
    target = target[segment] as Record<string, unknown>;
  }
  const last = segments.at(-1);
  if (last === undefined) return;
  if (value === missingConfigValue) delete target[last];
  else target[last] = cloneConfigValue(value);
}

export function rebaseConfigDraft(
  base: Config,
  mine: Config,
  latest: Config,
  choices: Record<string, ConflictChoice> = {},
) {
  const fields = configConflictFields(base, mine, latest);
  const draft = cloneConfigValue(latest) as Config;
  const unresolved: string[] = [];
  for (const field of fields) {
    if (field.conflict) {
      const choice = choices[field.path];
      if (!choice) unresolved.push(field.path);
      else if (choice === 'mine') applyConfigField(draft, field.segments, field.mine);
    } else if (field.mineChanged) applyConfigField(draft, field.segments, field.mine);
  }
  draft.revision = latest.revision;
  return { draft, fields, unresolved };
}

const sensitiveConfigName = /(secret|apikey|clientsecret|token|password|credential|authorization)/i;

function hasSensitiveConfigName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveConfigName);
  if (!isConfigObject(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    sensitiveConfigName.test(key.replace(/[^a-z0-9]/gi, '')) || hasSensitiveConfigName(item));
}

export function isSensitiveConfigConflictField(field: ConfigConflictField): boolean {
  return field.path.split(/[.\[\]]+/).some(part => sensitiveConfigName.test(part.replace(/[^a-z0-9]/gi, ''))) ||
    [field.base, field.mine, field.latest].some(hasSensitiveConfigName);
}

export function configConflictFieldPresentation(field: ConfigConflictField) {
  const redacted = isSensitiveConfigConflictField(field);
  return {
    path: redacted ? '（敏感字段已隐藏）' : field.path,
    base: formatConfigConflictValue(field.base, redacted),
    mine: formatConfigConflictValue(field.mine, redacted),
    latest: formatConfigConflictValue(field.latest, redacted),
    redacted,
  };
}

export function formatConfigConflictValue(value: unknown, redact = false): string {
  if (redact) return '（敏感字段已隐藏）';
  if (value === missingConfigValue) return '（字段不存在）';
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? 'undefined' : formatted;
}

export function recorderPresentation(recorder: System['telemetryRecorder']) {
  if (!recorder) return { label: '状态未知', tone: 'neutral' as const, pending: null, retained: null };
  return {
    label: recorder.degraded ? '降级' : '正常',
    tone: recorder.degraded ? 'bad' as const : 'good' as const,
    pending: Number.isFinite(recorder.pendingEvents) ? recorder.pendingEvents : null,
    retained: Number.isFinite(recorder.retainedEvents) ? recorder.retainedEvents : null,
  };
}

export function listenerPresentation(listener: System['listeners'] extends infer _T ? NonNullable<System['listeners']>['proxy'] | null | undefined : never) {
  if (!listener) return { enabled: '状态未知', configured: '未提供', actual: '未启用/尚不可读' };
  const format = (address: { bindAddress: string; port: number }) => `${address.bindAddress}:${address.port}`;
  return {
    enabled: listener.enabled ? '已启用' : '未启用',
    configured: format(listener.configured),
    actual: listener.actual ? format(listener.actual) : '未启用/尚不可读',
  };
}

export function storageFieldPresentation(storage: NonNullable<Config['storage']>) {
  return storageFields.map(field => ({ ...field, value: storage[field.key] ?? '', min: 1 as const, step: 1 as const }));
}

export const systemStatusLabel: Record<string, string> = {
  running: '运行中', degraded: '降级运行', starting: '启动中', stopped: '已停止',
};

const restartFieldLabels: Record<string, string> = {
  'server.port': '代理监听端口', 'server.bindAddress': '代理监听地址',
  'server.publicProxyBaseUrl': '代理公开地址', 'server.trustedProxyCidrs': '可信代理网段',
  'admin.enabled': '管理服务开关', 'admin.port': '管理端口',
  'admin.bindAddress': '管理监听地址', 'admin.publicAdminBaseUrl': '管理公开地址',
  'storage.dataDir': '数据目录', 'storage.flushIntervalMs': '记录刷新间隔',
  'storage.batchSize': '记录批量大小', 'storage.requestRetentionDays': '请求记录保留天数',
  'storage.minuteRetentionDays': '分钟汇总保留天数', 'storage.hourRetentionDays': '小时汇总保留天数',
  'storage.dailyRetentionDays': '日汇总保留天数', 'quota.timezone': '配额时区',
};

export function restartFieldLabel(field: string) {
  const serverField = field.slice('server.'.length);
  return restartFieldLabels[field] ?? (field.startsWith('server.') && /TimeoutMs$/.test(serverField)
    ? ({ connectTimeoutMs: '连接超时', firstByteTimeoutMs: '首字节超时', streamIdleTimeoutMs: '流式空闲超时', totalRequestTimeoutMs: '请求总超时' } as Record<string, string>)[serverField]
    : '其他配置项');
}

const databaseStatusLabels: Record<string, { label: string; tone: 'neutral' | 'good' | 'bad' | 'warn' }> = {
  available: { label: '连接正常', tone: 'good' },
  unavailable: { label: '连接不可用', tone: 'warn' },
};

const databaseReasonLabels: Record<string, string> = {
  connection_unavailable: '数据库连接不可用',
  connection_closed: '数据库连接已关闭',
  ping_failed: '数据库连接检测失败',
  database_not_configured: '尚未配置数据库',
  sqlite_metrics_unavailable: '暂时无法读取 SQLite 容量指标',
};

const databaseMetricLabels: Partial<Record<keyof DatabaseCapacity, string>> = {
  pageCount: '容量页数', pageSizeBytes: '单页大小（字节）', freePages: '空闲页数',
  allocatedBytes: '估算占用（字节）', freeBytes: '估算空闲空间（字节）',
};

function DatabaseSummary({ name, database }: { name: string; database: DatabaseDiagnostic }) {
  const status = database.health?.scope === 'connection'
    ? databaseStatusLabels[database.health.status] : undefined;
  const metrics = Object.entries(databaseMetricLabels).flatMap(([key, label]) => {
    const value = database.capacity?.[key as keyof DatabaseCapacity];
    return typeof value === 'number' && Number.isFinite(value) ? [[label!, value] as const] : [];
  });
  return createElement('div', { className: 'database-summary' },
    createElement('h3', null, name),
    status && createElement('p', null, createElement('span', null, '连接状态：'),
      createElement('span', { className: `badge ${status.tone}` }, status.label)),
    database.health?.reason && createElement('p', null,
      createElement('span', null, '连接原因：'),
      databaseReasonLabels[database.health.reason] ?? '服务端返回的原因暂未识别'),
    database.capacity?.reason && createElement('p', null,
      createElement('span', null, '容量说明：'),
      databaseReasonLabels[database.capacity.reason] ?? '服务端返回的原因暂未识别'),
    metrics.length > 0 && createElement('div', { className: 'summary-list' },
      ...metrics.map(([label, value]) => createElement('div', { key: label },
        createElement('span', null, label), createElement('code', null, value)))),
  );
}

export function DatabaseStatusPanel({ databases }: { databases: NonNullable<System['databases']> }) {
  const entries = ([
    ['control', '控制数据库'], ['telemetry', '遥测数据库'],
  ] as const).flatMap(([key, name]) => {
    const database = databases[key];
    return database && typeof database === 'object' ? [[name, database] as const] : [];
  });
  if (!entries.length) return null;
  return createElement('section', { className: 'panel' },
    createElement('div', { className: 'panel-head' }, createElement('h2', null, '数据库状态')),
    ...entries.map(([name, database]) => createElement(DatabaseSummary, { key: name, name, database })));
}

const serverFields: { key: keyof NonNullable<Config['server']>; label: string; type: 'number' | 'text' }[] = [
  { key: 'port', label: '代理监听端口', type: 'number' },
  { key: 'bindAddress', label: '代理监听地址', type: 'text' },
  { key: 'maxAttempts', label: '最大上游尝试次数', type: 'number' },
  { key: 'maxBodyBytes', label: '请求体上限（字节）', type: 'number' },
  { key: 'connectTimeoutMs', label: '连接超时（毫秒）', type: 'number' },
  { key: 'firstByteTimeoutMs', label: '首字节超时（毫秒）', type: 'number' },
  { key: 'streamIdleTimeoutMs', label: '流式空闲超时（毫秒）', type: 'number' },
  { key: 'totalRequestTimeoutMs', label: '请求总超时（毫秒）', type: 'number' },
];

const storageFields: { key: keyof NonNullable<Config['storage']>; label: string }[] = [
  { key: 'flushIntervalMs', label: '记录刷新间隔（毫秒）' },
  { key: 'batchSize', label: '记录批量大小' },
  { key: 'requestRetentionDays', label: '请求记录保留天数' },
  { key: 'minuteRetentionDays', label: '分钟汇总保留天数' },
  { key: 'hourRetentionDays', label: '小时汇总保留天数' },
  { key: 'dailyRetentionDays', label: '日汇总保留天数' },
];

function setNestedValue(config: Config, section: 'server' | 'quota' | 'storage', key: string, value: unknown): Config {
  return { ...config, [section]: { ...config[section], [key]: value } };
}

export function StructuredConfigEditor({ config, baseConfig = config, onSave }: {
  config: Config; baseConfig?: Config; onSave: (data: Config, base: Config) => Promise<void>;
}) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);
  const server = draft.server;
  const quota = draft.quota;
  const storage = draft.storage;
  if (!server || !quota || !storage) return <p className="muted">当前配置未提供结构化编辑所需的 server、storage 或 quota 设置；可使用下方 JSON 编辑器完整修改。</p>;
  return <form className="form-grid" onSubmit={async event => { event.preventDefault(); await onSave(draft, baseConfig); }}>
    {serverFields.map(field => <Field key={field.key} label={field.label}>
      <input type={field.type} min={field.type === 'number' ? 1 : undefined}
        value={String(server[field.key] ?? '')} onChange={event => setDraft(setNestedValue(draft, 'server', String(field.key),
          field.type === 'number' ? Number(event.target.value) : event.target.value))}/>
    </Field>)}
    {storageFieldPresentation(storage).map(field => <Field key={field.key} label={field.label}>
      <input type="number" min={field.min} step={field.step} required value={String(field.value)}
        onChange={event => setDraft(setNestedValue(draft, 'storage', String(field.key),
          event.target.value === '' ? '' : Number(event.target.value)))}/>
    </Field>)}
    <Field label="配额时区"><input value={quota.timezone ?? ''}
      onChange={event => setDraft(setNestedValue(draft, 'quota', 'timezone', event.target.value))}/></Field>
    <div className="actions"><button className="primary" type="submit">保存结构化设置</button></div>
    <p className="muted">代理地址、可信代理网段及其他完整配置请在 JSON 编辑器中修改。秘密仅以引用形式保存在配置中。</p>
  </form>;
}

function RevisionAwareJsonEditor({ initial, baseConfig, onSave }: {
  initial: Config; baseConfig: Config; onSave: (data: Config, base: Config) => Promise<void>;
}) {
  const initialText = JSON.stringify(initial, null, 2);
  const [text, setText] = useState(initialText);
  const [baselineText, setBaselineText] = useState(initialText);
  const [parseError, setParseError] = useState('');
  const baseRef = useRef(baseConfig);
  const dirty = text !== baselineText;
  useDraftGuard(dirty);
  useEffect(() => {
    if (!dirty) {
      const nextText = JSON.stringify(initial, null, 2);
      setText(nextText);
      setBaselineText(nextText);
      baseRef.current = baseConfig;
    }
  }, [initial, baseConfig, dirty]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const value = JSON.parse(text) as Config;
      setParseError('');
      await onSave(value, baseRef.current);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'JSON 无效');
    }
  }

  return <form onSubmit={submit}>
    <Field label="脱敏配置 JSON">
      <textarea className="code" rows={17} spellCheck={false} value={text} onChange={event => setText(event.target.value)}/>
    </Field>
    {parseError && <p className="form-error" role="alert">{parseError}</p>}
    <div className="actions"><button className="primary" type="submit">保存</button>
      <small>此编辑器基于版本：{baseRef.current.revision}</small></div>
  </form>;
}

function ConfigConflictPanel({ conflict, onChoice, onRetry, onRebase }: {
  conflict: ConfigConflictState;
  onChoice: (path: string, choice: ConflictChoice) => void;
  onRetry: () => void;
  onRebase: () => void;
}) {
  const fields = conflict.latest ? configConflictFields(conflict.base, conflict.mine, conflict.latest) : [];
  const preview = conflict.latest
    ? rebaseConfigDraft(conflict.base, conflict.mine, conflict.latest, conflict.choices) : undefined;
  return <Panel title="配置版本冲突">
    <p className="notice" role="status">
      保存时配置已被其他操作更新。草稿保留在当前页面；核对 base、我的草稿和最新配置后，选择冲突字段，再重新应用到最新版本。
    </p>
    {conflict.loading && <p className="muted" role="status">正在读取最新脱敏配置…</p>}
    {conflict.latestFailed && <div className="notice error" role="alert">
      <span>读取最新配置失败。当前草稿仍保留在页面中，可重试读取。</span>
      <button type="button" disabled={conflict.loading} onClick={onRetry}>重试读取最新配置</button>
    </div>}
    {conflict.latest && <>
      <p>编辑基于 v{conflict.base.revision}；最新配置为 v{conflict.latest.revision}。</p>
      {!fields.length && <p className="muted">配置字段没有差异；仍需重新应用到最新版本以更新编辑器 revision。</p>}
      <div className="rows">
        {fields.map((field, index) => {
          const presentation = configConflictFieldPresentation(field);
          return <div className="conflict-field"
            data-conflict-path={presentation.redacted ? presentation.path : field.path} key={field.path}>
          <div className="row"><code>{presentation.path}</code>
            <Badge tone={field.conflict ? 'warn' : 'neutral'}>{field.conflict ? '需要选择' : '可安全合并'}</Badge></div>
          <div className="summary-list">
            <div><span>Base</span><pre className="small-code">{presentation.base}</pre></div>
            <div><span>我的草稿</span><pre className="small-code">{presentation.mine}</pre></div>
            <div><span>最新配置</span><pre className="small-code">{presentation.latest}</pre></div>
          </div>
          {field.conflict && <fieldset>
            <legend>请选择此字段的值</legend>
            <label><input type="radio" name={`conflict-${conflict.id}-${index}`} checked={conflict.choices[field.path] === 'mine'}
              onChange={() => onChoice(field.path, 'mine')}/>保留我的值</label>
            <label><input type="radio" name={`conflict-${conflict.id}-${index}`} checked={conflict.choices[field.path] === 'latest'}
              onChange={() => onChoice(field.path, 'latest')}/>使用最新值</label>
          </fieldset>}
        </div>;
        })}
      </div>
      {!!preview?.unresolved.length && <p className="muted">还有 {preview.unresolved.length} 个冲突字段需要明确选择。</p>}
      <div className="actions">
        <button className="primary" type="button" disabled={conflict.loading || !!preview?.unresolved.length}
          onClick={onRebase}>重新应用到最新配置</button>
      </div>
      <p className="muted">重新应用只更新两个编辑器，不会提交配置；检查后再手动保存。</p>
    </>}
  </Panel>;
}

function backupResult(value: unknown): BackupResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  return {
    backupId: typeof item.backupId === 'string' && /^bak_[0-9a-f-]{36}$/.test(item.backupId) ? item.backupId : undefined,
    path: typeof item.path === 'string' ? item.path : undefined,
    revision: typeof item.revision === 'number' ? item.revision : undefined,
    scope: typeof item.scope === 'string' ? item.scope : undefined,
  };
}

export function Settings() {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>();
  const [validation, setValidation] = useState<unknown>();
  const [configConflict, setConfigConflict] = useState<ConfigConflictState>();
  const [editorSnapshot, setEditorSnapshot] = useState<EditorSnapshot>();
  const [editorGeneration, setEditorGeneration] = useState(0);
  const conflictId = useRef(0);
  const [jobId, setJobId] = useState('');
  const [backupJobId, setBackupJobId] = useState('');
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('replace');
  const [preview, setPreview] = useState<PreviewSelection>();
  const previewGeneration = useRef(0);
  const [price, setPrice] = useState({ model: '', provider: '', upstreamId: '', currency: 'USD', inputPerMillion: '', outputPerMillion: '',
    cacheReadPerMillion: '', cacheWritePerMillion: '', cacheWrite5mPerMillion: '', cacheWrite1hPerMillion: '', cacheWriteIncludedInInput: false,
    effectiveFrom: localDateTimeNow() });
  const system = useQuery({ queryKey: ['system'], queryFn: async () => (await get<System>('/system')).data });
  const config = useQuery({ queryKey: ['config'], queryFn: async () => (await get<Config>('/config')).data });
  const history = useQuery({ queryKey: ['config-history'], queryFn: async () =>
    (await get<{ revision: number; createdAt?: string; actor?: string }[]>('/config/history')).data });
  const audit = useQuery({ queryKey: ['audit'], queryFn: async () =>
    (await get<{ id: string; action: string; createdAt: string; actor?: string }[]>('/audit-events')).data });
  const pricing = useQuery({ queryKey: ['pricing'], queryFn: async () => (await get<Pricing[]>('/pricing')).data });
  const job = useQuery({ queryKey: ['job', jobId], enabled: !!jobId,
    queryFn: async () => (await get<ResultJob>(`/jobs/${jobId}`)).data,
    refetchInterval: q => q.state.data?.status === 'completed' || q.state.data?.status === 'failed' ? false : 2000 });
  const backupJob = useQuery({ queryKey: ['job', backupJobId], enabled: !!backupJobId,
    queryFn: async () => (await get<ResultJob>(`/jobs/${backupJobId}`)).data,
    refetchInterval: q => q.state.data?.status === 'completed' || q.state.data?.status === 'failed' ? false : 2000 });
  const backup = backupResult(backupJob.data?.result);
  const editorConfig = editorSnapshot?.draft ?? config.data;
  const editorBase = editorSnapshot?.base ?? config.data;
  const activeEditorGeneration = editorSnapshot?.generation ?? editorGeneration;
  const currentRevision = system.data?.persistedRevision ?? config.data?.revision;
  const canApplyPreview = !!preview && preview.generation === previewGeneration.current &&
    preview.text === importText && preview.mode === importMode &&
    preview.data.mode === importMode && preview.data.valid === true &&
    preview.data.conflicts?.length === 0 && preview.data.errors?.length === 0 &&
    (currentRevision == null || preview.data.baseRevision === currentRevision);
  const offlineCommand = backup?.backupId && currentRevision != null
    ? `model-router backup:restore ${backup.backupId} --config /absolute/path/to/config.json --expected-revision ${currentRevision}`
    : null;

  async function readConflictLatest(target: Pick<ConfigConflictState, 'id' | 'base' | 'mine'>) {
    setConfigConflict(current => current?.id === target.id
      ? { ...current, latest: undefined, loading: true, latestFailed: false } : current);
    try {
      const latest = (await get<Config>('/config')).data;
      setConfigConflict(current => current?.id === target.id
        ? { ...current, latest, loading: false, latestFailed: false, choices: {} } : current);
    } catch {
      setConfigConflict(current => current?.id === target.id
        ? { ...current, latest: undefined, loading: false, latestFailed: true } : current);
    }
  }

  async function save(data: Config, base: Config) {
    try {
      setError(undefined);
      setValidation((await post('/config/validate', { config: data })).data);
      await request('/config', { method: 'PUT', body: data, revision: base.revision });
      await qc.invalidateQueries();
      setConfigConflict(undefined);
      setEditorSnapshot(undefined);
      setEditorGeneration(generation => generation + 1);
      setError(undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412 && err.code === 'CONFIG_REVISION_CONFLICT') {
        const target = { id: ++conflictId.current, base, mine: data };
        setConfigConflict({ ...target, loading: true, latestFailed: false, choices: {} });
        await readConflictLatest(target);
        return;
      }
      setError(err);
    }
  }

  async function retryConflictLatest() {
    if (!configConflict) return;
    await readConflictLatest(configConflict);
  }

  function applyRebasedConfig() {
    if (!configConflict?.latest) return;
    const result = rebaseConfigDraft(configConflict.base, configConflict.mine,
      configConflict.latest, configConflict.choices);
    if (result.unresolved.length) return;
    const generation = editorGeneration + 1;
    setEditorGeneration(generation);
    setEditorSnapshot({ base: configConflict.latest, draft: result.draft, generation });
    setConfigConflict(undefined);
    setError(undefined);
  }
  async function task(type: string) {
    try { const response = await post<{ jobId: string }>('/maintenance/jobs', { type },
      { idempotencyKey: crypto.randomUUID() });
      setJobId(response.data.jobId);
      if (type === 'backup') setBackupJobId(response.data.jobId);
      setError(undefined); }
    catch (err) { setError(err); }
  }
  async function copyOfflineCommand() {
    if (!offlineCommand) return;
    try { await navigator.clipboard.writeText(offlineCommand); setError(undefined); }
    catch (err) { setError(err); }
  }
  async function importPreview() {
    const generation = ++previewGeneration.current;
    const text = importText;
    const mode = importMode;
    setPreview(undefined);
    try {
      const result = (await post<ImportPreview>('/config/import-preview', { config: JSON.parse(text), mode })).data;
      if (generation === previewGeneration.current) {
        setPreview({ data: result, text, mode, generation }); setError(undefined);
      }
    } catch (err) { if (generation === previewGeneration.current) setError(err); }
  }
  async function importApply() {
    if (!canApplyPreview || !preview || preview.generation !== previewGeneration.current) return;
    const selected = preview;
    const generation = previewGeneration.current;
    try { await request('/config/import', { method: 'POST',
      body: { config: JSON.parse(selected.text), mode: selected.mode }, revision: selected.data.baseRevision });
      if (generation === previewGeneration.current) {
        ++previewGeneration.current;
        setPreview(undefined); setImportText('');
      }
      setError(undefined); await qc.invalidateQueries(); }
    catch (err) { setError(err); }
  }
  async function exportConfig() {
    try { const response = await get<{ config: Config; requiredSecrets: unknown[] }>('/config/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'model-router-config-redacted.json';
      a.click(); URL.revokeObjectURL(url); }
    catch (err) { setError(err); }
  }
  async function addPrice(e: FormEvent) {
    e.preventDefault();
    try { await post('/pricing', { id: crypto.randomUUID(), model: price.model, currency: price.currency,
      ...(price.provider.trim() ? { provider: price.provider.trim() } : {}),
      ...(price.upstreamId.trim() ? { upstreamId: price.upstreamId.trim() } : {}),
      inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion,
      ...(price.cacheReadPerMillion ? { cacheReadPerMillion: price.cacheReadPerMillion } : {}),
      ...(price.cacheWritePerMillion ? { cacheWritePerMillion: price.cacheWritePerMillion } : {}),
      ...(price.cacheWrite5mPerMillion ? { cacheWrite5mPerMillion: price.cacheWrite5mPerMillion } : {}),
      ...(price.cacheWrite1hPerMillion ? { cacheWrite1hPerMillion: price.cacheWrite1hPerMillion } : {}),
      cacheWriteIncludedInInput: price.cacheWriteIncludedInInput,
      effectiveFrom: new Date(price.effectiveFrom).toISOString() });
      setPrice({ model: '', provider: '', upstreamId: '', currency: 'USD', inputPerMillion: '', outputPerMillion: '', cacheReadPerMillion: '', cacheWritePerMillion: '',
        cacheWrite5mPerMillion: '', cacheWrite1hPerMillion: '', cacheWriteIncludedInInput: false, effectiveFrom: localDateTimeNow() });
      await qc.invalidateQueries({ queryKey: ['pricing'] }); }
    catch (err) { setError(err); }
  }

  return <>
    <div className="page-title"><div><p className="eyebrow">SYSTEM</p><h1>系统设置</h1>
      <p>配置版本、价格、审计与维护任务</p></div><button onClick={exportConfig}>导出脱敏配置</button></div>
    <ErrorNotice error={error}/>
    <div className="stats">
      <div className="stat"><span>期望配置版本</span><strong>v{system.data?.persistedRevision ?? '—'}</strong></div>
      <div className="stat"><span>生效配置版本</span><strong>v{system.data?.effectiveRevision ?? '—'}</strong></div>
      <div className="stat"><span>服务状态</span><strong>{system.data?.status ? systemStatusLabel[system.data.status] ?? '其他状态' : '未知'}</strong>
        <small>{system.data?.instanceId ? `实例 ${system.data.instanceId}` : '实例标识暂不可用'}</small></div>
    </div>
    {!!system.data?.restartRequiredFields?.length && <div className="notice" role="status">
      <strong>以下设置待重启后生效</strong>
      <ul>{system.data.restartRequiredFields.map((field, index) => <li key={`${field}-${index}`}>
        {restartFieldLabel(field)}{restartFieldLabels[field] ? '' : '（字段详情由服务端提供）'}
      </li>)}</ul>
    </div>}
    <Panel title="用量记录器">
      {(() => {
        const recorder = system.data?.telemetryRecorder;
        const presentation = recorderPresentation(recorder);
        return <>
          <p><Badge tone={presentation.tone}>{presentation.label}</Badge></p>
          <div className="stats">
            <div className="stat"><span>待处理事件</span><strong>{presentation.pending ?? '未知'}</strong><small>等待写入或处理的事件</small></div>
            <div className="stat"><span>保留事件</span><strong>{presentation.retained ?? '未知'}</strong><small>当前保留的记录事件数</small></div>
          </div>
          {recorder?.degraded && <p className="notice error" role="status">
            记录器当前不可正常工作，代理用量记录可能延迟或缺失。请检查服务端日志、磁盘空间和数据库目录写入权限，排除故障后重启服务并确认状态恢复；此页面不会自动修复或重启服务。
          </p>}
          {!recorder && <p className="muted">服务端尚未提供记录器状态；请检查服务版本和 /system 接口。</p>}
        </>;
      })()}
    </Panel>
    <div className="grid-two">
      <Panel title="运行状态"><State loading={system.isPending} error={system.error} retry={() => system.refetch()}>
        <div className="summary-list">
          <div><span>服务状态</span><strong>{system.data?.status ? systemStatusLabel[system.data.status] ?? '其他状态' : '未知'}</strong></div>
          <div><span>代理公开地址</span><code>{system.data?.publicProxyBaseUrl ?? '未提供'}</code></div>
          <div><span>管理公开地址</span><code>{system.data?.publicAdminBaseUrl ?? '未提供'}</code></div>
          <div><span>配额时区</span><code>{system.data?.timezone ?? '未提供'}</code></div>
          <div><span>待重启设置</span><strong>{system.data?.restartRequiredFields?.length ?? 0} 项</strong></div>
          {(['proxy', 'admin'] as const).map(key => {
            const listener = system.data?.listeners?.[key];
            const view = listenerPresentation(listener);
            const name = key === 'proxy' ? '代理监听' : '管理监听';
            return <div key={key}><span>{name}</span><strong>{view.enabled}</strong>
              <small>配置值：{view.configured} · 实际监听：{view.actual}</small></div>;
          })}
        </div>
      </State></Panel>
      {system.data?.databases && <DatabaseStatusPanel databases={system.data.databases}/>}
      <Panel title="维护任务">
        <p className="muted">备份由服务端排队执行。在线 restore 仅恢复配置与缺失 secret，不会替换 SQLite 数据库。</p>
        <div className="actions"><button onClick={() => task('backup')}>创建备份</button>
          <button onClick={() => task('aggregate')}>重建汇总</button>
          <button onClick={() => task('purge')}>清理历史</button>
          <button onClick={() => task('integrity-check')}>检查数据库完整性</button>
          <button onClick={() => task('vacuum-control')}>整理数据库空间</button></div>
        {jobId && <div className="notice">任务 <code>{jobId}</code> · {job.data?.status ?? '查询中'}{' '}
          {job.data?.progress == null ? '' : `${job.data.progress}%`}
          {job.data?.error && <p className="form-error">{job.data.error}</p>}</div>}
        {backupJobId && <div className="notice">
          <p>最近备份任务：<code>{backupJobId}</code> · {backupJob.data?.status ?? '查询中'}</p>
          {backupJob.data?.error && <p className="form-error">{backupJob.data.error}</p>}
          {backupJob.data?.status === 'completed' && <div className="summary-list">
            <div><span>Backup ID</span><code>{backup?.backupId ?? '服务端未返回'}</code></div>
            <div><span>备份版本</span><code>{backup?.revision ?? '—'}</code></div>
            <div><span>备份路径（仅服务器本机）</span><code>{backup?.path ?? '服务端未返回'}</code></div>
            <div><span>备份范围</span><code>{backup?.scope ?? '—'}</code></div>
          </div>}
        </div>}
        <p className="muted">完整恢复须先停止代理和管理服务，并暂停自动重启；不要从浏览器触发数据库替换。以下版本号是当前持久化配置版本，执行前仍需在服务器本机重新核对。</p>
        <p>当前配置 revision：<strong>{currentRevision ?? '—'}</strong></p>
        {offlineCommand ? <><pre className="small-code">{offlineCommand}</pre>
          <button onClick={copyOfflineCommand}>复制离线恢复命令</button></>
          : <p className="muted">备份任务完成并返回 backupId 后，可在本机执行 <code>backup:restore</code>。</p>}
        <p className="muted">将命令中的配置路径占位符换成服务器本机绝对路径。离线恢复会先保留 restore-safety-* 当前状态快照；验证恢复结果后再决定是否清理快照。</p>
      </Panel>
    </div>
    {configConflict ? <ConfigConflictPanel conflict={configConflict}
      onChoice={(path, choice) => setConfigConflict(current => current?.id === configConflict.id
        ? { ...current, choices: { ...current.choices, [path]: choice } } : current)}
      onRetry={() => { void retryConflictLatest(); }} onRebase={applyRebasedConfig}/>
      : <>
        <Panel title="监听、超时与时区"><State loading={config.isPending} error={config.error} retry={() => config.refetch()}>
          {editorConfig && editorBase && <StructuredConfigEditor key={`structured-${activeEditorGeneration}`}
            config={editorConfig} baseConfig={editorBase} onSave={save}/>}
        </State></Panel>
        <Panel title="配置校验与提交"><State loading={config.isPending} error={config.error} retry={() => config.refetch()}>
          {editorConfig && editorBase && <RevisionAwareJsonEditor key={`json-${activeEditorGeneration}`}
            initial={editorConfig} baseConfig={editorBase} onSave={save}/>}
          {validation !== undefined && <pre className="small-code">{JSON.stringify(validation, null, 2)}</pre>}
        </State></Panel>
      </>}
    <div className="grid-two">
      <Panel title="导入配置"><Field label="导入模式"><select value={importMode} onChange={e => {
        ++previewGeneration.current; setImportMode(e.target.value as ImportMode); setPreview(undefined);
      }}><option value="replace">替换</option><option value="merge">合并</option></select></Field>
        <Field label="配置 JSON"><textarea rows={8} className="code" value={importText}
          onChange={e => { ++previewGeneration.current; setImportText(e.target.value); setPreview(undefined); }}/></Field>
        <div className="actions"><button disabled={!importText} onClick={importPreview}>预览差异</button>
          <button className="primary" disabled={!canApplyPreview} onClick={importApply}>确认导入</button></div>
        {preview && <pre className="small-code">{JSON.stringify(preview.data, null, 2)}</pre>}
      </Panel>
      <Panel title="配置历史"><State loading={history.isPending} error={history.error}
        retry={() => history.refetch()} empty={!history.data?.length}>
        <div className="rows">{history.data?.map(item => <div className="row" key={item.revision}>
          <div>v{item.revision}<small>{formatDate(item.createdAt)} · {item.actor ?? '—'}</small></div>
          <button onClick={async () => {
            if (!confirm(`回退到 v${item.revision}？这会生成新版本。`)) return;
            try { await post('/config/rollback', { revision: item.revision }); await qc.invalidateQueries(); }
            catch (err) { setError(err); }
          }}>回退</button>
        </div>)}</div>
      </State></Panel>
    </div>
    <div className="grid-two">
      <Panel title="模型价格"><State loading={pricing.isPending} error={pricing.error}
        retry={() => pricing.refetch()} empty={!pricing.data?.length}>
        <div className="rows">{pricing.data?.map(item => <div className="row" key={item.versionId}>
          <div><code>{item.model}</code><small>{item.provider ?? '所有供应商'}{item.upstreamId ? ` · 上游 ${item.upstreamId}` : ''} · 版本 {item.versionId}（#{item.versionSequence}）· 生效于 {formatDate(item.effectiveFrom)}</small></div>
          <span>输入 {item.inputPerMillion} · 输出 {item.outputPerMillion} · 写入 5m {item.cacheWrite5mPerMillion ?? '—'} / 1h {item.cacheWrite1hPerMillion ?? '—'} · {item.currency} / 百万 token
            {item.cacheWriteIncludedInInput ? ' · 写入已含在输入价' : item.cacheWritePerMillion !== undefined ? ` · 未分类写入 ${item.cacheWritePerMillion}` : ''}</span>
        </div>)}</div>
      </State><form className="form-grid" onSubmit={addPrice}>
        <Field label="模型"><input required value={price.model} onChange={e => setPrice({ ...price, model: e.target.value })}/></Field>
        <Field label="供应商（可选）"><input value={price.provider} onChange={e => setPrice({ ...price, provider: e.target.value })}/></Field>
        <Field label="上游 ID（可选）"><input value={price.upstreamId} onChange={e => setPrice({ ...price, upstreamId: e.target.value })}/></Field>
        <Field label="币种"><input required value={price.currency} onChange={e => setPrice({ ...price, currency: e.target.value })}/></Field>
        <Field label="输入 / 百万"><input required type="number" min="0" step="any" value={price.inputPerMillion}
          onChange={e => setPrice({ ...price, inputPerMillion: e.target.value })}/></Field>
        <Field label="输出 / 百万"><input required type="number" min="0" step="any" value={price.outputPerMillion}
          onChange={e => setPrice({ ...price, outputPerMillion: e.target.value })}/></Field>
        <Field label="缓存读取 / 百万"><input type="number" min="0" step="0.000001" value={price.cacheReadPerMillion}
          onChange={e => setPrice({ ...price, cacheReadPerMillion: e.target.value })}/></Field>
        <Field label="缓存写入 5 分钟 / 百万"><input type="number" min="0" step="0.000001" value={price.cacheWrite5mPerMillion}
          onChange={e => setPrice({ ...price, cacheWrite5mPerMillion: e.target.value })}/></Field>
        <Field label="缓存写入 1 小时 / 百万"><input type="number" min="0" step="0.000001" value={price.cacheWrite1hPerMillion}
          onChange={e => setPrice({ ...price, cacheWrite1hPerMillion: e.target.value })}/></Field>
        <Field label="未分类缓存写入 / 百万"><input type="number" min="0" step="0.000001" value={price.cacheWritePerMillion}
          onChange={e => setPrice({ ...price, cacheWritePerMillion: e.target.value })}/></Field>
        <label><input type="checkbox" checked={price.cacheWriteIncludedInInput}
          onChange={e => setPrice({ ...price, cacheWriteIncludedInInput: e.target.checked })}/> 缓存写入已包含在普通输入价格中</label>
        <Field label="生效时间"><input required type="datetime-local" value={price.effectiveFrom}
          onChange={e => setPrice({ ...price, effectiveFrom: e.target.value })}/></Field>
        <button type="submit">添加价格</button>
      </form></Panel>
      <Panel title="审计事件"><State loading={audit.isPending} error={audit.error}
        retry={() => audit.refetch()} empty={!audit.data?.length}>
        <div className="rows">{audit.data?.map(item => <div className="row" key={item.id}>
          <span>{item.action}</span><small>{item.actor ?? '—'} · {formatDate(item.createdAt)}</small>
        </div>)}</div>
      </State></Panel>
    </div>
  </>;
}
