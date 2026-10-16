import { type FormEvent, useEffect, useState } from 'react';
import {
  PlatformApiError,
  clearPlatformCsrfToken,
  platformClient,
  type PlatformOpencodeGoProtocol,
} from '../api/saas-platform-client';
import { Badge, Field, Panel, SaveButton } from '../components/ui';
import { PlatformErrorNotice, canManageSupply, type MeState } from './saas-platform-shared';

/**
 * F5 console surface (task #38): the opencode-go adaptive-routing rule table
 * editor (R5b). The mutation goes through the CAS endpoint: a stale
 * expectedAuthzVersion fails with 409 and the page offers a reload.
 */

const PROTOCOLS: readonly PlatformOpencodeGoProtocol[] = ['responses', 'openai', 'anthropic'];

const PROTOCOL_LABELS: Readonly<Record<PlatformOpencodeGoProtocol, string>> = {
  responses: 'Responses（/v1/responses）',
  openai: 'Chat Completions（/v1/chat/completions）',
  anthropic: 'Anthropic Messages（/v1/messages）',
};

interface RuleRow {
  pattern: string;
  protocol: PlatformOpencodeGoProtocol;
}

/** Pure rule-row validation (mirrors the server's strict validator). */
export function validateRuleRows(rows: readonly RuleRow[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const pattern = row.pattern.trim().toLowerCase();
    if (pattern === '') throw new Error(`第 ${index + 1} 行的匹配模式不能为空。`);
    if (pattern.length > 128) throw new Error(`第 ${index + 1} 行的匹配模式过长（≤128 字符）。`);
    if (/\s/u.test(pattern)) throw new Error(`第 ${index + 1} 行的匹配模式不能包含空白字符。`);
    const stars = pattern.split('*').length - 1;
    if (stars > 1 || (stars === 1 && !pattern.endsWith('*'))) {
      throw new Error(`第 ${index + 1} 行的匹配模式只能使用一个结尾 * 通配符。`);
    }
    if (seen.has(pattern)) throw new Error(`匹配模式 “${pattern}” 重复。`);
    seen.add(pattern);
  }
  if (rows.length > 64) throw new Error('规则表最多 64 条。');
}

export function OpencodeGoRulesPage({ me }: { me: MeState }) {
  const canWrite = canManageSupply(me);
  const [ownerKind, setOwnerKind] = useState<'tenant' | 'platform'>('platform');
  const [tenantId, setTenantId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [authzVersion, setAuthzVersion] = useState<number>();
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [useDefault, setUseDefault] = useState(false);
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<unknown>();
  const [writeNotice, setWriteNotice] = useState('');
  const [validationError, setValidationError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<unknown>();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void platformClient
      .listOpencodeGoModels({ signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setModels(result);
      })
      .catch(error => {
        if (!controller.signal.aborted) setModelsError(error);
      });
    return () => controller.abort();
  }, []);

  async function loadRules() {
    setLoadError(undefined);
    setWriteNotice('');
    setValidationError('');
    setLoadBusy(true);
    try {
      const state = await platformClient.readOpencodeGoRules({
        ownerKind,
        ...(ownerKind === 'tenant' ? { tenantId: tenantId.trim() } : {}),
        accountId: accountId.trim(),
      });
      setAuthzVersion(state.authzVersion);
      setRows(state.rules === null ? [] : state.rules.map(rule => ({ ...rule })));
      setUseDefault(state.rules === null);
      setDirty(false);
      setLoaded(true);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setLoadError(failure);
      setLoaded(false);
    } finally {
      setLoadBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (authzVersion === undefined) return;
    setWriteError(undefined);
    setWriteNotice('');
    setValidationError('');
    if (!useDefault) {
      try {
        validateRuleRows(rows);
      } catch (validationFailure) {
        setValidationError(validationFailure instanceof Error ? validationFailure.message : '');
        return;
      }
    }
    setWriteBusy(true);
    try {
      const state = await platformClient.updateOpencodeGoRules({
        ownerKind,
        ...(ownerKind === 'tenant' ? { tenantId: tenantId.trim() } : {}),
        accountId: accountId.trim(),
        expectedAuthzVersion: authzVersion,
        rules: useDefault ? null : rows.map(row => ({ pattern: row.pattern.trim().toLowerCase(), protocol: row.protocol })),
      });
      setAuthzVersion(state.authzVersion);
      setRows(state.rules === null ? [] : state.rules.map(rule => ({ ...rule })));
      setUseDefault(state.rules === null);
      setDirty(false);
      setWriteNotice(`规则表已保存；授权版本已递增到 ${state.authzVersion}。`);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setWriteError(failure);
    } finally {
      setWriteBusy(false);
    }
  }

  const conflict =
    writeError instanceof PlatformApiError && writeError.status === 409 && writeError.code === 'VERSION_CONFLICT';

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">供给</p>
          <h1>OpenCode Go 协议路由</h1>
          <p>按模型匹配模式选择上游原生协议；修改会递增账号授权版本（CAS 冲突将返回 409）。</p>
        </div>
      </div>
      <Panel title="选择账号">
        <form
          onSubmit={event => {
            event.preventDefault();
            void loadRules();
          }}
        >
          <div className="form-grid">
            <Field label="归属">
              <select value={ownerKind} onChange={event => setOwnerKind(event.target.value as 'tenant' | 'platform')}>
                <option value="platform">平台账号</option>
                <option value="tenant">租户账号</option>
              </select>
            </Field>
            {ownerKind === 'tenant' && (
              <Field label="租户 ID">
                <input value={tenantId} onChange={event => setTenantId(event.target.value)} />
              </Field>
            )}
            <Field label="账号 ID">
              <input value={accountId} onChange={event => setAccountId(event.target.value)} placeholder="opencode-go 平台供给账号 ID" />
            </Field>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={loadBusy || accountId.trim() === ''}>
              {loadBusy ? '读取中…' : '读取规则表'}
            </button>
          </div>
        </form>
        {loadError !== undefined && <PlatformErrorNotice error={loadError} title="规则表读取失败" />}
      </Panel>

      {loaded && (
        <Panel
          title="规则表"
          action={
            authzVersion !== undefined ? (
              <span><Badge tone="neutral">authz 版本 {authzVersion}</Badge>{dirty && <small>（有未保存修改）</small>}</span>
            ) : undefined
          }
        >
          <form onSubmit={submit}>
            <Field label="使用默认规则表" hint="勾选后清除账号覆盖，恢复内置默认表">
              <input
                type="checkbox"
                checked={useDefault}
                onChange={event => {
                  setUseDefault(event.target.checked);
                  setDirty(true);
                }}
              />
            </Field>
            {!useDefault && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>匹配模式</th><th>协议</th><th /></tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index}>
                        <td>
                          <input
                            list="opencode-go-models"
                            value={row.pattern}
                            aria-label={`第 ${index + 1} 行匹配模式`}
                            onChange={event => {
                              const next = [...rows];
                              next[index] = { ...row, pattern: event.target.value };
                              setRows(next);
                              setDirty(true);
                            }}
                          />
                        </td>
                        <td>
                          <select
                            value={row.protocol}
                            aria-label={`第 ${index + 1} 行协议`}
                            onChange={event => {
                              const next = [...rows];
                              next[index] = { ...row, protocol: event.target.value as PlatformOpencodeGoProtocol };
                              setRows(next);
                              setDirty(true);
                            }}
                          >
                            {PROTOCOLS.map(protocol => (
                              <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setRows(rows.filter((_, position) => position !== index));
                              setDirty(true);
                            }}
                          >
                            移除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <datalist id="opencode-go-models">
                  {models.map(model => (
                    <option key={model} value={`${model}*`} />
                  ))}
                </datalist>
                {canWrite && (
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => {
                        setRows([...rows, { pattern: '', protocol: 'openai' }]);
                        setDirty(true);
                      }}
                    >
                      添加规则
                    </button>
                  </div>
                )}
              </div>
            )}
            {validationError && <p className="form-error" role="alert">{validationError}</p>}
            <div className="actions">
              {canWrite && <SaveButton busy={writeBusy} />}
              {conflict && (
                <button type="button" onClick={() => void loadRules()}>
                  重新加载（他人已并发修改）
                </button>
              )}
            </div>
          </form>
          {writeError !== undefined && !conflict && <PlatformErrorNotice error={writeError} title="规则表保存失败" />}
          {conflict && (
            <div className="notice error" role="alert">
              <strong>版本冲突</strong>
              <span>规则表已被并发修改（409）。请点击“重新加载”获取最新版本后重试。</span>
            </div>
          )}
          {writeNotice && (
            <div className="notice" role="status">
              <strong>状态更新</strong>
              <span>{writeNotice}</span>
            </div>
          )}
        </Panel>
      )}

      <Panel title="可用模型目录（只读）">
        {modelsError !== undefined && <PlatformErrorNotice error={modelsError} title="模型目录读取失败" />}
        {modelsError === undefined && models.length === 0 && (
          <div className="empty" role="status">模型目录为空。</div>
        )}
        {modelsError === undefined && models.length > 0 && (
          <p>
            <small>
              当前目录（同步缓存 ∪ 内置回退，共 {models.length} 个）：{models.slice(0, 40).join('、')}
              {models.length > 40 ? ' …' : ''}
            </small>
          </p>
        )}
      </Panel>
    </>
  );
}
