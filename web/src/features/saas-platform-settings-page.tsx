import { type FormEvent, useEffect, useState } from 'react';
import {
  PlatformApiError,
  clearPlatformCsrfToken,
  platformClient,
  type PlatformSettingView,
} from '../api/saas-platform-client';
import { Badge, Field, Panel, SaveButton, formatDate } from '../components/ui';
import { PlatformErrorNotice, canManageSupply, type MeState } from './saas-platform-shared';

/**
 * F5 console surface (task #38): the F1 platform-settings viewer/editor.
 * Plain keys show their stored value with a version-CAS edit form; sealed
 * (secret) keys show a “已密封” badge and a set-only input — the stored
 * secret is never readable through the API.
 */

/** Client-side catalog of the registered F1 keys (the closed server registry). */
interface SettingKeyCatalogEntry {
  readonly key: string;
  readonly secret: boolean;
  readonly description: string;
  /** JSON-textarea keys take raw JSON values; everything else is a string. */
  readonly jsonValue: boolean;
}

const REGISTRATION_SETTINGS_KEYS = {
  mode: 'saas.identity.registration.mode',
  emailVerificationRequired: 'saas.identity.registration.email_verification_required',
  emailDomainAllowlist: 'saas.identity.registration.email_domain_allowlist',
  emailDomainDenylist: 'saas.identity.registration.email_domain_denylist',
  turnstileEnabled: 'saas.identity.registration.turnstile.enabled',
  turnstileSiteKey: 'saas.identity.registration.turnstile.site_key',
  turnstileSecret: 'saas.identity.registration.turnstile.secret',
  smtpHost: 'saas.identity.registration.smtp.host',
  smtpPort: 'saas.identity.registration.smtp.port',
  smtpSecure: 'saas.identity.registration.smtp.secure',
  smtpUsername: 'saas.identity.registration.smtp.username',
  smtpPassword: 'saas.identity.registration.smtp.password',
  smtpFrom: 'saas.identity.registration.smtp.from',
  rewardCurrency: 'saas.identity.registration.reward.currency',
  rewardGrant: 'saas.identity.registration.reward.grant_minor_units',
  rewardCodeFiller: 'saas.identity.registration.reward.code_filler_minor_units',
  rewardCodeOwner: 'saas.identity.registration.reward.code_owner_minor_units',
  rewardCodeOwnerMinThreshold: 'saas.identity.registration.reward.code_owner_min_threshold_minor_units',
} as const;

const TOPUP_TIER_DISCOUNTS_KEY = 'saas.payments.topup.amount_tier_discounts';

const SETTING_KEY_CATALOG: readonly SettingKeyCatalogEntry[] = [
  ...Object.values(REGISTRATION_SETTINGS_KEYS).map((key): SettingKeyCatalogEntry => ({
    key,
    secret: key === REGISTRATION_SETTINGS_KEYS.turnstileSecret || key === REGISTRATION_SETTINGS_KEYS.smtpPassword,
    description: '',
    jsonValue: false,
  })),
  {
    key: TOPUP_TIER_DISCOUNTS_KEY,
    secret: false,
    description:
      '充值金额阶梯折扣：{ thresholdMinorUnits, discountNumerator, discountDenominator } 的升序列表；达到阈值后按分子/分母折算（不大于 1）。',
    jsonValue: true,
  },
];

function catalogDescription(key: string): string {
  const entry = SETTING_KEY_CATALOG.find(candidate => candidate.key === key);
  return entry?.description ?? '';
}

function catalogJsonValue(key: string): boolean {
  return SETTING_KEY_CATALOG.find(candidate => candidate.key === key)?.jsonValue === true;
}

function displayValue(setting: PlatformSettingView): string {
  if (setting.secret) return '';
  if (setting.value === undefined) return '';
  return typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value, null, 2);
}

export function PlatformSettingsPage({ me }: { me: MeState }) {
  const canWrite = canManageSupply(me);
  const [settings, setSettings] = useState<PlatformSettingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string>();
  const [writeErrors, setWriteErrors] = useState<Record<string, unknown>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void platformClient
      .listPlatformSettings({ signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) {
          setSettings(result);
          const initial: Record<string, string> = {};
          for (const setting of result) initial[setting.key] = setting.secret ? '' : displayValue(setting);
          setDrafts(initial);
        }
      })
      .catch(loadError => {
        if (!controller.signal.aborted) setError(loadError);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const storedByKey = new Map(settings.map(setting => [setting.key, setting]));
  const allKeys = [
    ...new Set([...settings.map(setting => setting.key), ...SETTING_KEY_CATALOG.map(entry => entry.key)]),
  ].sort();

  async function saveSetting(event: FormEvent, key: string) {
    event.preventDefault();
    const setting = storedByKey.get(key);
    const isSecret = setting?.secret === true || SETTING_KEY_CATALOG.find(entry => entry.key === key)?.secret === true;
    const draft = drafts[key] ?? '';
    const expectedVersion = setting?.version ?? 0;
    setBusyKey(key);
    setWriteErrors(current => ({ ...current, [key]: undefined }));
    setNotices(current => ({ ...current, [key]: '' }));
    try {
      if (isSecret) {
        if (draft === '') throw new Error('请输入要设置的新密钥值。');
        await platformClient.setPlatformSettingSecret({ key, secret: draft, expectedVersion });
        setNotices(current => ({ ...current, [key]: '密钥已密封保存；原值不可读取。' }));
      } else if (catalogJsonValue(key)) {
        JSON.parse(draft === '' ? 'null' : draft);
        await platformClient.setPlatformSetting({ key, value: draft, expectedVersion });
        setNotices(current => ({ ...current, [key]: '设置已保存。' }));
      } else {
        await platformClient.setPlatformSetting({ key, value: draft, expectedVersion });
        setNotices(current => ({ ...current, [key]: '设置已保存。' }));
      }
      setReloadKey(value => value + 1);
    } catch (failure) {
      if (failure instanceof PlatformApiError && failure.status === 401) clearPlatformCsrfToken();
      setWriteErrors(current => ({ ...current, [key]: failure }));
    } finally {
      setBusyKey(undefined);
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">平台</p>
          <h1>平台设置</h1>
          <p>F1 设置存储的查看与编辑；密封密钥只可设置、不可读取，写入走版本 CAS。</p>
        </div>
      </div>
      {loading && <div className="skeleton" role="status" aria-label="正在加载平台设置"><i /><i /><i /></div>}
      {!loading && error !== undefined && (
        <PlatformErrorNotice error={error} onRetry={() => setReloadKey(value => value + 1)} title="平台设置读取失败" />
      )}
      {!loading && error === undefined && (
        <Panel title={`设置项（${allKeys.length}）`}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>键</th><th>当前值</th><th>版本</th><th>更新时间</th></tr>
              </thead>
              <tbody>
                {allKeys.map(key => {
                  const setting = storedByKey.get(key);
                  const isSecret = setting?.secret === true || SETTING_KEY_CATALOG.find(entry => entry.key === key)?.secret === true;
                  return (
                    <tr key={key}>
                      <td><code>{key}</code></td>
                      <td>
                        {isSecret ? (
                          setting ? <Badge tone="neutral">已密封</Badge> : <Badge tone="neutral">未设置</Badge>
                        ) : (
                          <code>{displayValue(setting ?? { key, secret: false, version: 0, updatedAt: '' }) || '—'}</code>
                        )}
                      </td>
                      <td>{setting ? setting.version : '—'}</td>
                      <td>{setting ? formatDate(setting.updatedAt) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {!loading && error === undefined && canWrite && (
        <Panel title="编辑设置">
          {allKeys.map(key => {
            const setting = storedByKey.get(key);
            const isSecret = setting?.secret === true || SETTING_KEY_CATALOG.find(entry => entry.key === key)?.secret === true;
            const isJson = catalogJsonValue(key);
            const description = catalogDescription(key);
            return (
              <form key={key} onSubmit={event => void saveSetting(event, key)}>
                <Field
                  label={`${key}${isSecret ? '（密封密钥 — 只写）' : ''}`}
                  hint={description || (isSecret ? '保存后服务端密封；任何接口都不会回显该值。' : `当前版本 ${setting?.version ?? 0}；基于该版本的并发写入会返回 409。`)}
                >
                  {isJson ? (
                    <textarea
                      className="code"
                      rows={6}
                      spellCheck={false}
                      value={drafts[key] ?? ''}
                      placeholder='[{"thresholdMinorUnits": "1000", "discountNumerator": "95", "discountDenominator": "100"}]'
                      onChange={event => setDrafts({ ...drafts, [key]: event.target.value })}
                    />
                  ) : (
                    <input
                      type={isSecret ? 'password' : 'text'}
                      autoComplete="off"
                      value={drafts[key] ?? ''}
                      placeholder={isSecret ? '输入新的密钥值（只写）' : '输入新值'}
                      onChange={event => setDrafts({ ...drafts, [key]: event.target.value })}
                    />
                  )}
                </Field>
                <div className="actions">
                  <SaveButton busy={busyKey === key}>{isSecret ? '设置密钥' : '保存'}</SaveButton>
                </div>
                {writeErrors[key] !== undefined && writeErrors[key] !== null && (
                  <PlatformErrorNotice error={writeErrors[key]} title={`${key} 写入失败`} />
                )}
                {notices[key] && (
                  <div className="notice" role="status">
                    <strong>状态更新</strong>
                    <span>{notices[key]}</span>
                  </div>
                )}
              </form>
            );
          })}
        </Panel>
      )}
    </>
  );
}
