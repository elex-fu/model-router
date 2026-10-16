import { type FormEvent, useEffect, useState } from 'react';
import {
  PlatformApiError,
  clearPlatformCsrfToken,
  platformClient,
  type PlatformBillingGroup,
  type PlatformBillingGroupModelPricing,
  type PlatformBillingGroupPoolEntry,
  type PlatformBillingGroupUpsertInput,
  type PlatformPriceMetric,
  type PlatformSupplyAccount,
} from '../api/saas-platform-client';
import { Badge, Field, Panel, SaveButton } from '../components/ui';
import { PlatformErrorNotice, canManageSupply, type MeState } from './saas-platform-shared';

/**
 * F5 console surface (task #38): the billing-groups management page. All
 * multiplier math is exact — decimal-string numerators/denominators parsed
 * with BigInt, never parseFloat (the commercial billing kernel red line).
 */

const PRICE_METRICS: readonly PlatformPriceMetric[] = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
];

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,30})$/u;

interface RationalDraft {
  num: string;
  den: string;
}

function emptyRational(): RationalDraft {
  return { num: '1', den: '1' };
}

interface BillingGroupDraft {
  id: string;
  displayName: string;
  status: 'active' | 'disabled';
  rateMultiplier: RationalDraft;
  topupMultiplier: RationalDraft;
  peakEnabled: boolean;
  peakStart: string;
  peakEnd: string;
  peakMultiplier: RationalDraft;
  modelPricingText: string;
  rpmLimit: string;
  dailyLimitMinorUnits: string;
  weeklyLimitMinorUnits: string;
  monthlyLimitMinorUnits: string;
  profitMinMargin: RationalDraft;
  profitSafetyBuffer: RationalDraft;
  profitControlEnabled: boolean;
  claudeCodeOnly: boolean;
  fallbackGroupId: string;
  supportedModelScopes: string;
}

function emptyDraft(): BillingGroupDraft {
  return {
    id: '',
    displayName: '',
    status: 'active',
    rateMultiplier: emptyRational(),
    topupMultiplier: emptyRational(),
    peakEnabled: false,
    peakStart: '',
    peakEnd: '',
    peakMultiplier: emptyRational(),
    modelPricingText: '',
    rpmLimit: '',
    dailyLimitMinorUnits: '',
    weeklyLimitMinorUnits: '',
    monthlyLimitMinorUnits: '',
    profitMinMargin: { num: '', den: '' },
    profitSafetyBuffer: { num: '', den: '' },
    profitControlEnabled: false,
    claudeCodeOnly: false,
    fallbackGroupId: '',
    supportedModelScopes: '',
  };
}

function draftFromGroup(group: PlatformBillingGroup): BillingGroupDraft {
  return {
    id: group.id,
    displayName: group.displayName,
    status: group.status === 'disabled' ? 'disabled' : 'active',
    rateMultiplier: { num: group.rateMultiplier.num, den: group.rateMultiplier.den },
    topupMultiplier: { num: group.topupMultiplier.num, den: group.topupMultiplier.den },
    peakEnabled: group.peakEnabled,
    peakStart: group.peak?.start ?? '',
    peakEnd: group.peak?.end ?? '',
    peakMultiplier: group.peak
      ? { num: group.peak.multiplier.num, den: group.peak.multiplier.den }
      : emptyRational(),
    modelPricingText:
      Object.keys(group.modelPricing).length === 0 ? '' : JSON.stringify(group.modelPricing, null, 2),
    rpmLimit: group.rpmLimit === null ? '' : String(group.rpmLimit),
    dailyLimitMinorUnits: group.dailyLimitMinorUnits ?? '',
    weeklyLimitMinorUnits: group.weeklyLimitMinorUnits ?? '',
    monthlyLimitMinorUnits: group.monthlyLimitMinorUnits ?? '',
    profitMinMargin: group.profitMinMargin
      ? { num: group.profitMinMargin.num, den: group.profitMinMargin.den }
      : { num: '', den: '' },
    profitSafetyBuffer: group.profitSafetyBuffer
      ? { num: group.profitSafetyBuffer.num, den: group.profitSafetyBuffer.den }
      : { num: '', den: '' },
    profitControlEnabled: group.profitMinMargin !== null,
    claudeCodeOnly: group.claudeCodeOnly,
    fallbackGroupId: group.fallbackGroupId ?? '',
    supportedModelScopes: group.supportedModelScopes?.join(', ') ?? '',
  };
}

/** Exact rational validation: decimal strings, denominator > 0, BigInt only. */
export function validateRationalDraft(
  draft: RationalDraft,
  label: string,
  options: { nonNegative: boolean },
): { num: string; den: string } {
  if (!DECIMAL_PATTERN.test(draft.num) || !DECIMAL_PATTERN.test(draft.den)) {
    throw new Error(`${label} 的分子和分母必须是十进制整数字符串（例如 3 / 2）。`);
  }
  const numerator = BigInt(draft.num);
  const denominator = BigInt(draft.den);
  if (denominator <= 0n) throw new Error(`${label} 的分母必须大于 0。`);
  if (options.nonNegative ? numerator < 0n : numerator <= 0n) {
    throw new Error(`${label} 的分子${options.nonNegative ? '不能为负' : '必须大于 0'}。`);
  }
  return { num: draft.num, den: draft.den };
}

function validateOptionalRational(
  draft: RationalDraft,
  label: string,
  options: { nonNegative: boolean },
): { num: string; den: string } | null {
  if (draft.num === '' && draft.den === '') return null;
  return validateRationalDraft(draft, label, options);
}

function validateOptionalLimit(value: string, label: string): string | null {
  if (value === '') return null;
  if (!DECIMAL_PATTERN.test(value)) throw new Error(`${label} 必须是十进制非负整数字符串（最小货币单位）。`);
  return value;
}

function validateClockTime(value: string, label: string): string {
  if (!/^\d{2}:\d{2}:\d{2}$/u.test(value)) throw new Error(`${label} 必须是 HH:MM:SS（UTC）。`);
  const [hours, minutes, seconds] = value.split(':').map(Number);
  if (hours > 24 || minutes > 59 || seconds > 59) throw new Error(`${label} 超出时间范围。`);
  return value;
}

/** Client-side model_pricing JSON validation (the canonical num/den codec shape). */
export function validateModelPricingText(text: string): PlatformBillingGroupModelPricing | null {
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('model_pricing 不是有效的 JSON。');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model_pricing 必须是「模型 → 费率」对象。');
  }
  const result: Record<string, Partial<Record<PlatformPriceMetric, { num: string; den: string } | null>>> = {};
  for (const [model, rates] of Object.entries(parsed as Record<string, unknown>)) {
    if (model.trim() === '' || model.length > 255) throw new Error(`模型 ID “${model}” 无效。`);
    if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) {
      throw new Error(`模型 “${model}” 的费率必须是对象。`);
    }
    const entry: Partial<Record<PlatformPriceMetric, { num: string; den: string } | null>> = {};
    for (const [metric, rate] of Object.entries(rates as Record<string, unknown>)) {
      if (!(PRICE_METRICS as readonly string[]).includes(metric)) {
        throw new Error(`模型 “${model}” 含未知计费维度 “${metric}”。`);
      }
      if (rate === null) {
        entry[metric as PlatformPriceMetric] = null;
        continue;
      }
      if (
        rate === null ||
        typeof rate !== 'object' ||
        Array.isArray(rate) ||
        typeof (rate as { num?: unknown }).num !== 'string' ||
        typeof (rate as { den?: unknown }).den !== 'string'
      ) {
        throw new Error(`模型 “${model}” 的 ${metric} 费率必须是 { num, den } 十进制字符串。`);
      }
      const candidate = rate as { num: string; den: string };
      if (!DECIMAL_PATTERN.test(candidate.num) || !DECIMAL_PATTERN.test(candidate.den)) {
        throw new Error(`模型 “${model}” 的 ${metric} 费率分子/分母必须是十进制整数字符串。`);
      }
      entry[metric as PlatformPriceMetric] = validateRationalDraft(candidate, `${model}.${metric}`, {
        nonNegative: true,
      });
    }
    if (!('input' in entry) || !('output' in entry)) {
      throw new Error(`模型 “${model}” 至少需要 input 与 output 费率。`);
    }
    result[model] = entry;
  }
  return result;
}

/** Pure draft → upsert conversion with exact rational validation (exported for tests). */
export function billingGroupDraftToInput(draft: BillingGroupDraft): PlatformBillingGroupUpsertInput {
  if (draft.id.trim() === '' || draft.id.length > 128) throw new Error('计费组 ID 必填（≤128 字符）。');
  if (draft.displayName.trim() === '') throw new Error('显示名必填。');
  const peakMultiplier = validateOptionalRational(draft.peakMultiplier, '高峰倍率', { nonNegative: false });
  if (draft.peakEnabled) {
    validateClockTime(draft.peakStart, '高峰开始时间');
    validateClockTime(draft.peakEnd, '高峰结束时间');
    if (peakMultiplier === null) throw new Error('启用高峰窗口时必须提供高峰倍率。');
  }
  const profitMinMargin = draft.profitControlEnabled
    ? validateRationalDraft(draft.profitMinMargin, '利润下限', { nonNegative: true })
    : null;
  const profitSafetyBuffer = draft.profitControlEnabled
    ? validateRationalDraft(draft.profitSafetyBuffer, '利润安全垫', { nonNegative: true })
    : null;
  const scopes = draft.supportedModelScopes
    .split(',')
    .map(scope => scope.trim())
    .filter(scope => scope !== '');
  if (scopes.some(scope => scope.length > 128)) throw new Error('模型范围条目过长（≤128 字符）。');
  if (new Set(scopes).size !== scopes.length) throw new Error('模型范围条目不能重复。');
  const fallbackGroupId = draft.fallbackGroupId.trim() === '' ? null : draft.fallbackGroupId.trim();
  if (fallbackGroupId === draft.id.trim()) throw new Error('计费组不能以自身作为回退组。');
  return {
    id: draft.id.trim(),
    displayName: draft.displayName.trim(),
    status: draft.status,
    rateMultiplier: validateRationalDraft(draft.rateMultiplier, '计费倍率', { nonNegative: false }),
    topupMultiplier: validateRationalDraft(draft.topupMultiplier, '充值倍率', { nonNegative: false }),
    peakEnabled: draft.peakEnabled,
    peakStart: draft.peakEnabled ? draft.peakStart : null,
    peakEnd: draft.peakEnabled ? draft.peakEnd : null,
    peakMultiplier,
    modelPricing: validateModelPricingText(draft.modelPricingText),
    rpmLimit: draft.rpmLimit === '' ? null : Number(draft.rpmLimit),
    dailyLimitMinorUnits: validateOptionalLimit(draft.dailyLimitMinorUnits, '日限额'),
    weeklyLimitMinorUnits: validateOptionalLimit(draft.weeklyLimitMinorUnits, '周限额'),
    monthlyLimitMinorUnits: validateOptionalLimit(draft.monthlyLimitMinorUnits, '月限额'),
    profitMinMargin,
    profitSafetyBuffer,
    claudeCodeOnly: draft.claudeCodeOnly,
    fallbackGroupId,
    supportedModelScopes: scopes.length === 0 ? null : scopes,
  };
}

function RationalFields({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: RationalDraft;
  onChange: (next: RationalDraft) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint ?? '精确分数：分子/分母（十进制整数字符串，绝不用浮点数）'}>
      <span className="rational-input">
        <input
          inputMode="numeric"
          value={value.num}
          aria-label={`${label} 分子`}
          placeholder="num"
          onChange={event => onChange({ ...value, num: event.target.value })}
        />
        <span aria-hidden="true">/</span>
        <input
          inputMode="numeric"
          value={value.den}
          aria-label={`${label} 分母`}
          placeholder="den"
          onChange={event => onChange({ ...value, den: event.target.value })}
        />
      </span>
    </Field>
  );
}

function statusBadge(status: string): { label: string; tone: 'good' | 'warn' } {
  return status === 'active' ? { label: '启用', tone: 'good' } : { label: '停用', tone: 'warn' };
}

function poolEntryKey(entry: PlatformBillingGroupPoolEntry): string {
  return `${entry.accountId}:${entry.priority}`;
}

export function BillingGroupsPage({ me }: { me: MeState }) {
  const canWrite = canManageSupply(me);
  const [groups, setGroups] = useState<PlatformBillingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<'none' | 'create' | 'edit'>('none');
  const [draft, setDraft] = useState<BillingGroupDraft>(() => emptyDraft());
  const [modelPricingError, setModelPricingError] = useState('');
  const [writeError, setWriteError] = useState<unknown>();
  const [writeNotice, setWriteNotice] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [pool, setPool] = useState<PlatformBillingGroupPoolEntry[]>([]);
  const [poolBusy, setPoolBusy] = useState(false);
  const [poolError, setPoolError] = useState<unknown>();
  const [poolNotice, setPoolNotice] = useState('');
  const [accounts, setAccounts] = useState<PlatformSupplyAccount[]>([]);
  const [keyAssignment, setKeyAssignment] = useState({ tenantId: '', projectId: '', keyId: '', billingGroupId: '' });
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<unknown>();
  const [keyNotice, setKeyNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void platformClient
      .listBillingGroups({ signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setGroups(result);
      })
      .catch(loadError => {
        if (!controller.signal.aborted) setError(loadError);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!canWrite) return;
    const controller = new AbortController();
    void platformClient
      .listSupplyAccounts({ signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setAccounts(result);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [canWrite, reloadKey]);

  useEffect(() => {
    if (selectedGroupId === undefined) {
      setPool([]);
      return;
    }
    const controller = new AbortController();
    void platformClient
      .getBillingGroup(selectedGroupId, { signal: controller.signal })
      .then(detail => {
        if (!controller.signal.aborted) setPool(detail.accountPool);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [selectedGroupId, reloadKey]);

  function openCreate() {
    setEditing('create');
    setDraft(emptyDraft());
    setModelPricingError('');
    setWriteError(undefined);
    setWriteNotice('');
  }

  function openEdit(group: PlatformBillingGroup) {
    setEditing('edit');
    setDraft(draftFromGroup(group));
    setModelPricingError('');
    setWriteError(undefined);
    setWriteNotice('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setWriteError(undefined);
    setWriteNotice('');
    setModelPricingError('');
    let input: PlatformBillingGroupUpsertInput;
    try {
      input = billingGroupDraftToInput(draft);
    } catch (validationError) {
      setWriteError(validationError);
      return;
    }
    setWriteBusy(true);
    try {
      if (editing === 'create') {
        await platformClient.createBillingGroup(input);
        setWriteNotice(`计费组 ${input.id} 已创建。`);
      } else {
        await platformClient.updateBillingGroup(input);
        setWriteNotice(`计费组 ${input.id} 已更新。`);
      }
      setEditing('none');
      setReloadKey(value => value + 1);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      if (failure instanceof PlatformApiError && failure.code === 'INVALID_MODEL_PRICING') {
        setModelPricingError('服务端拒绝了 model_pricing：请检查 JSON 中的费率形状。');
      }
      setWriteError(failure);
    } finally {
      setWriteBusy(false);
    }
  }

  async function submitPool(event: FormEvent) {
    event.preventDefault();
    if (selectedGroupId === undefined) return;
    setPoolError(undefined);
    setPoolNotice('');
    setPoolBusy(true);
    try {
      const outcome = await platformClient.replaceBillingGroupAccountPool(selectedGroupId, pool);
      setPool(outcome.accounts);
      setPoolNotice(`账号池已更新；${outcome.invalidatedKeys} 个受影响 Key 的授权版本已递增。`);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setPoolError(failure);
    } finally {
      setPoolBusy(false);
    }
  }

  async function submitKeyAssignment(event: FormEvent) {
    event.preventDefault();
    setKeyError(undefined);
    setKeyNotice('');
    setKeyBusy(true);
    try {
      const outcome = await platformClient.setKeyBillingGroup({
        tenantId: keyAssignment.tenantId.trim(),
        projectId: keyAssignment.projectId.trim(),
        keyId: keyAssignment.keyId.trim(),
        billingGroupId: keyAssignment.billingGroupId.trim() === '' ? null : keyAssignment.billingGroupId.trim(),
      });
      setKeyNotice(`Key ${outcome.keyId} 已绑定到 ${outcome.billingGroupId ?? '默认组'}（authz 版本 ${outcome.authzVersion}）。`);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setKeyError(failure);
    } finally {
      setKeyBusy(false);
    }
  }

  const modelPricingFeedback = modelPricingError
    ? modelPricingError
    : (() => {
        try {
          validateModelPricingText(draft.modelPricingText);
          return '';
        } catch (validationError) {
          return validationError instanceof Error ? validationError.message : '';
        }
      })();

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">计费</p>
          <h1>计费组</h1>
          <p>分组倍率、模型定价覆盖、账号池与限额管理；全部倍率使用精确分数运算。</p>
        </div>
      </div>
      {!canWrite && me.kind === 'ready' && (
        <div className="notice" role="note">
          <strong>当前角色只读</strong>
          <span>当前平台角色可以查看计费组，但不会显示写入控件。</span>
        </div>
      )}
      {writeError !== undefined && <PlatformErrorNotice error={writeError} title="计费组写入失败" />}
      {writeNotice && (
        <div className="notice" role="status">
          <strong>状态更新</strong>
          <span>{writeNotice}</span>
        </div>
      )}
      {canWrite && editing === 'none' && (
        <Panel title="计费组" action={<button type="button" className="primary" onClick={openCreate}>新建计费组</button>}>
          {loading && <div className="skeleton" role="status" aria-label="正在加载计费组"><i /><i /><i /></div>}
          {!loading && error !== undefined && (
            <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="计费组读取失败" />
          )}
          {!loading && error === undefined && groups.length === 0 && (
            <div className="empty" role="status">当前没有计费组。</div>
          )}
          {!loading && error === undefined && groups.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>显示名</th>
                    <th>计费倍率</th>
                    <th>充值倍率</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(group => {
                    const badge = statusBadge(group.status);
                    return (
                      <tr key={group.id}>
                        <td><code>{group.id}</code></td>
                        <td>{group.displayName}</td>
                        <td><code>{group.rateMultiplier.num}/{group.rateMultiplier.den}</code></td>
                        <td><code>{group.topupMultiplier.num}/{group.topupMultiplier.den}</code></td>
                        <td><Badge tone={badge.tone}>{badge.label}</Badge></td>
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              openEdit(group);
                              setSelectedGroupId(group.id);
                            }}
                          >
                            编辑
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
        <Panel title={editing === 'create' ? '新建计费组' : `编辑计费组 ${draft.id}`}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label="计费组 ID" hint="创建后不可更改">
                <input
                  value={draft.id}
                  disabled={editing === 'edit'}
                  onChange={event => setDraft({ ...draft, id: event.target.value })}
                  placeholder="vip"
                />
              </Field>
              <Field label="显示名">
                <input value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} />
              </Field>
              <Field label="状态">
                <select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as 'active' | 'disabled' })}>
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </Field>
              <RationalFields label="计费倍率" value={draft.rateMultiplier} onChange={rateMultiplier => setDraft({ ...draft, rateMultiplier })} />
              <RationalFields label="充值倍率" value={draft.topupMultiplier} onChange={topupMultiplier => setDraft({ ...draft, topupMultiplier })} />
              <Field label="回退组" hint="本组定价不可用时使用的组">
                <select value={draft.fallbackGroupId} onChange={event => setDraft({ ...draft, fallbackGroupId: event.target.value })}>
                  <option value="">（无）</option>
                  {groups.filter(group => group.id !== draft.id).map(group => (
                    <option key={group.id} value={group.id}>{group.id}</option>
                  ))}
                </select>
              </Field>
              <Field label="限流（请求/分钟）">
                <input inputMode="numeric" value={draft.rpmLimit} onChange={event => setDraft({ ...draft, rpmLimit: event.target.value })} placeholder="留空 = 不限" />
              </Field>
              <Field label="日限额（最小货币单位）">
                <input inputMode="numeric" value={draft.dailyLimitMinorUnits} onChange={event => setDraft({ ...draft, dailyLimitMinorUnits: event.target.value })} placeholder="留空 = 不限" />
              </Field>
              <Field label="周限额（最小货币单位）">
                <input inputMode="numeric" value={draft.weeklyLimitMinorUnits} onChange={event => setDraft({ ...draft, weeklyLimitMinorUnits: event.target.value })} placeholder="留空 = 不限" />
              </Field>
              <Field label="月限额（最小货币单位）">
                <input inputMode="numeric" value={draft.monthlyLimitMinorUnits} onChange={event => setDraft({ ...draft, monthlyLimitMinorUnits: event.target.value })} placeholder="留空 = 不限" />
              </Field>
              <Field label="模型范围" hint="逗号分隔的公开模型范围；留空 = 全部">
                <input value={draft.supportedModelScopes} onChange={event => setDraft({ ...draft, supportedModelScopes: event.target.value })} placeholder="claude-*, gpt-*" />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="仅限 Claude Code 流量">
                <input
                  type="checkbox"
                  checked={draft.claudeCodeOnly}
                  onChange={event => setDraft({ ...draft, claudeCodeOnly: event.target.checked })}
                />
              </Field>
              <Field label="启用高峰窗口">
                <input
                  type="checkbox"
                  checked={draft.peakEnabled}
                  onChange={event => setDraft({ ...draft, peakEnabled: event.target.checked })}
                />
              </Field>
              {draft.peakEnabled && (
                <>
                  <Field label="高峰开始（UTC HH:MM:SS）">
                    <input value={draft.peakStart} placeholder="09:00:00" onChange={event => setDraft({ ...draft, peakStart: event.target.value })} />
                  </Field>
                  <Field label="高峰结束（UTC HH:MM:SS）">
                    <input value={draft.peakEnd} placeholder="21:00:00" onChange={event => setDraft({ ...draft, peakEnd: event.target.value })} />
                  </Field>
                  <RationalFields label="高峰倍率" value={draft.peakMultiplier} onChange={peakMultiplier => setDraft({ ...draft, peakMultiplier })} />
                </>
              )}
              <Field label="启用利润控制">
                <input
                  type="checkbox"
                  checked={draft.profitControlEnabled}
                  onChange={event => setDraft({ ...draft, profitControlEnabled: event.target.checked })}
                />
              </Field>
              {draft.profitControlEnabled && (
                <>
                  <RationalFields label="利润下限" value={draft.profitMinMargin} onChange={profitMinMargin => setDraft({ ...draft, profitMinMargin })} hint="非负分数" />
                  <RationalFields label="利润安全垫" value={draft.profitSafetyBuffer} onChange={profitSafetyBuffer => setDraft({ ...draft, profitSafetyBuffer })} hint="非负分数" />
                </>
              )}
            </div>
            <Field label="model_pricing（JSON）" hint='按模型的费率覆盖：{"模型": {"input": {"num": "3", "den": "1000000"}, "output": {"num": "15", "den": "1000000"}}}'>
              <textarea
                className="code"
                rows={10}
                spellCheck={false}
                value={draft.modelPricingText}
                onChange={event => setDraft({ ...draft, modelPricingText: event.target.value })}
                placeholder='留空 = 不覆盖'
              />
            </Field>
            {modelPricingFeedback && (
              <p className="form-error" role="alert">{modelPricingFeedback}</p>
            )}
            <div className="actions">
              <SaveButton busy={writeBusy}>{editing === 'create' ? '创建' : '保存'}</SaveButton>
              <button type="button" onClick={() => setEditing('none')}>取消</button>
            </div>
          </form>
        </Panel>
      )}

      {canWrite && (
        <Panel title="账号池绑定" action={
          <select
            aria-label="选择计费组"
            value={selectedGroupId ?? ''}
            onChange={event => setSelectedGroupId(event.target.value === '' ? undefined : event.target.value)}
          >
            <option value="">选择计费组…</option>
            {groups.map(group => (
              <option key={group.id} value={group.id}>{group.id}</option>
            ))}
          </select>
        }>
          {selectedGroupId === undefined ? (
            <div className="empty" role="status">选择一个计费组以编辑其账号池。</div>
          ) : (
            <form onSubmit={submitPool}>
              <table>
                <thead>
                  <tr><th>账号</th><th>优先级（0–1000）</th><th /></tr>
                </thead>
                <tbody>
                  {pool.map((entry, index) => (
                    <tr key={`${entry.accountId}:${index}`}>
                      <td>
                        <input
                          list="billing-group-accounts"
                          value={entry.accountId}
                          onChange={event => {
                            const next = [...pool];
                            next[index] = { ...entry, accountId: event.target.value };
                            setPool(next);
                          }}
                        />
                      </td>
                      <td>
                        <input
                          inputMode="numeric"
                          value={String(entry.priority)}
                          onChange={event => {
                            const next = [...pool];
                            next[index] = { ...entry, priority: Number(event.target.value) || 0 };
                            setPool(next);
                          }}
                        />
                      </td>
                      <td>
                        <button type="button" onClick={() => setPool(pool.filter((_, position) => position !== index))}>移除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="billing-group-accounts">
                {accounts.map(account => (
                  <option key={account.id} value={account.id} />
                ))}
              </datalist>
              <div className="actions">
                <button type="button" onClick={() => setPool([...pool, { accountId: '', priority: 50 }])}>添加账号</button>
                <SaveButton busy={poolBusy}>替换账号池</SaveButton>
              </div>
              {poolError !== undefined && <PlatformErrorNotice error={poolError} title="账号池写入失败" />}
              {poolNotice && (
                <div className="notice" role="status">
                  <strong>状态更新</strong>
                  <span>{poolNotice}</span>
                </div>
              )}
              {pool.length > 0 && (
                <p>
                  <small>当前绑定：{pool.map(poolEntryKey).join('、')}</small>
                </p>
              )}
            </form>
          )}
        </Panel>
      )}

      {canWrite && (
        <Panel title="Key 分组绑定">
          <form onSubmit={submitKeyAssignment}>
            <div className="form-grid">
              <Field label="租户 ID">
                <input value={keyAssignment.tenantId} onChange={event => setKeyAssignment({ ...keyAssignment, tenantId: event.target.value })} />
              </Field>
              <Field label="项目 ID">
                <input value={keyAssignment.projectId} onChange={event => setKeyAssignment({ ...keyAssignment, projectId: event.target.value })} />
              </Field>
              <Field label="Key ID">
                <input value={keyAssignment.keyId} onChange={event => setKeyAssignment({ ...keyAssignment, keyId: event.target.value })} />
              </Field>
              <Field label="计费组" hint="留空 = 解除绑定（回落到租户默认组）">
                <select value={keyAssignment.billingGroupId} onChange={event => setKeyAssignment({ ...keyAssignment, billingGroupId: event.target.value })}>
                  <option value="">（解除绑定）</option>
                  {groups.map(group => (
                    <option key={group.id} value={group.id}>{group.id}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="actions">
              <SaveButton busy={keyBusy}>绑定 Key</SaveButton>
            </div>
            {keyError !== undefined && <PlatformErrorNotice error={keyError} title="Key 分组失败" />}
            {keyNotice && (
              <div className="notice" role="status">
                <strong>状态更新</strong>
                <span>{keyNotice}</span>
              </div>
            )}
          </form>
        </Panel>
      )}

      {!canWrite && loading && <div className="skeleton" role="status" aria-label="正在加载计费组"><i /><i /><i /></div>}
      {!canWrite && !loading && error !== undefined && (
        <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="计费组读取失败" />
      )}
      {!canWrite && !loading && error === undefined && groups.length === 0 && (
        <div className="empty" role="status">当前没有计费组。</div>
      )}
      {!canWrite && !loading && error === undefined && groups.length > 0 && (
        <Panel title="计费组">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>ID</th><th>显示名</th><th>计费倍率</th><th>充值倍率</th><th>状态</th></tr>
              </thead>
              <tbody>
                {groups.map(group => {
                  const badge = statusBadge(group.status);
                  return (
                    <tr key={group.id}>
                      <td><code>{group.id}</code></td>
                      <td>{group.displayName}</td>
                      <td><code>{group.rateMultiplier.num}/{group.rateMultiplier.den}</code></td>
                      <td><code>{group.topupMultiplier.num}/{group.topupMultiplier.den}</code></td>
                      <td><Badge tone={badge.tone}>{badge.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
