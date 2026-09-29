import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type SafeTenant, saasClient } from '../api/saas-client';
import {
  isSaasWalletUnavailable,
  SaasWalletApiError,
  type SaasWalletData,
  type SaasWalletLedgerEntry,
  type SaasWalletLedgerPage,
  saasWalletClient,
} from '../api/saas-wallet-client';
import { Badge, Panel } from '../components/ui';

const tenantsKey = ['saas-console', 'tenants'] as const;
const walletQueryKey = (tenantId: string, currency: string, cursor: string | undefined) =>
  ['saas-wallet', 'wallet', tenantId, currency, cursor ?? ''] as const;
const topUpPolicyQueryKey = (tenantId: string) => ['saas-wallet', 'topup-policy', tenantId] as const;
const topUpOrderQueryKey = (tenantId: string, orderId: string | undefined) =>
  ['saas-wallet', 'topup-order', tenantId, orderId ?? ''] as const;
const pageSize = 25;

interface LedgerPosition {
  tenantId: string;
  currency: string;
  cursors: Array<string | undefined>;
  index: number;
}

const ledgerTypeLabels = {
  top_up: '钱包充值',
  usage_charge: '模型用量结算',
};

interface StoredTopUp {
  readonly orderId?: string;
  readonly idempotencyKey?: string;
  readonly amountMinorUnits?: string;
  readonly currency?: string;
}

function topUpStorageKey(tenantId: string): string {
  return `saas-wallet-topup:${encodeURIComponent(tenantId)}`;
}

function readStoredTopUp(tenantId: string): StoredTopUp | null {
  if (!tenantId || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(topUpStorageKey(tenantId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const stored = value as Record<string, unknown>;
    const orderId = typeof stored.orderId === 'string' && stored.orderId.length <= 255 ? stored.orderId : undefined;
    const idempotencyKey =
      typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length <= 255
        ? stored.idempotencyKey
        : undefined;
    const amountMinorUnits =
      typeof stored.amountMinorUnits === 'string' && /^[1-9]\d*$/.test(stored.amountMinorUnits)
        ? stored.amountMinorUnits
        : undefined;
    const currency = typeof stored.currency === 'string' && /^[A-Z]{3}$/.test(stored.currency) ? stored.currency : undefined;
    return orderId || idempotencyKey ? { orderId, idempotencyKey, amountMinorUnits, currency } : null;
  } catch {
    return null;
  }
}

function writeStoredTopUp(tenantId: string, value: StoredTopUp): void {
  if (!tenantId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(topUpStorageKey(tenantId), JSON.stringify(value));
  } catch {
    // The in-page order remains available when browser storage is disabled.
  }
}

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('当前浏览器无法安全生成充值请求标识，请更新浏览器后重试。');
}

const topUpStatusLabels = {
  pending: '支付处理中',
  paid: '充值已到账',
  failed: '支付创建失败',
  unknown: '支付结果待核对',
  expired: '支付指引已过期',
} as const;

function formatMinorUnits(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return '—';
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function signedMinorUnits(entry: SaasWalletLedgerEntry): string {
  return `${entry.direction === 'debit' ? '−' : '+'}${formatMinorUnits(entry.amountMinorUnits)}`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '—';
}

function WalletError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const unavailable = isSaasWalletUnavailable(error);
  const title = unavailable ? '客户钱包暂不可用' : '钱包读取失败';
  const detail =
    error instanceof SaasWalletApiError
      ? `服务端返回 ${error.code}。`
      : error instanceof Error
        ? error.message
        : '请求失败，请稍后重试。';

  return (
    <div className="notice error" role="alert">
      <strong>{title}</strong>
      <span>
        {detail}余额和账本仅在服务端提供可验证数据时显示；此页面不会推测余额、模拟入账或授予模型权益。
      </span>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <i />
      <i />
      <i />
    </div>
  );
}

function BalanceContent({ wallet }: { wallet: SaasWalletData['wallet'] }) {
  return (
    <>
      <section className="stats" aria-label="钱包余额摘要">
        <div className="stat">
          <span>账面余额</span>
          <strong>
            {wallet.currency} {formatMinorUnits(wallet.postedBalanceMinorUnits)}
          </strong>
          <small>最小货币单位</small>
        </div>
        <div className="stat">
          <span>活动 Hold</span>
          <strong>
            {wallet.currency} {formatMinorUnits(wallet.activeHoldsMinorUnits)}
          </strong>
          <small>已预留资金</small>
        </div>
        <div className="stat">
          <span>冻结资金</span>
          <strong>
            {wallet.currency} {formatMinorUnits(wallet.frozenAmountMinorUnits)}
          </strong>
          <small>服务端报告的冻结金额</small>
        </div>
        <div className="stat">
          <span>可用余额</span>
          <strong>
            {wallet.currency} {formatMinorUnits(wallet.availableMinorUnits)}
          </strong>
          <small>扣除活动 Hold 和冻结资金</small>
        </div>
      </section>

      <div className="summary-list">
        <div>
          <span>消费状态</span>
          <strong>
            <Badge tone={wallet.spendingFrozen ? 'bad' : 'good'}>
              {wallet.spendingFrozen ? '消费已冻结' : '消费未冻结'}
            </Badge>
          </strong>
        </div>
      </div>

      <p className="muted">金额以最小货币单位展示，避免舍入。此页面只读，不会创建充值订单或登记入账。</p>
    </>
  );
}

function LedgerContent({
  page,
  pageNumber,
  canGoBack,
  onPrevious,
  onNext,
}: {
  page: SaasWalletLedgerPage;
  pageNumber: number;
  canGoBack: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <>
      {page.items.length === 0 ? (
        <div className="empty" role="status">
          当前筛选条件下没有钱包账本记录。
        </div>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus and scroll this overflowing table.
        <section className="table-wrap" aria-label="钱包账本，可横向滚动" tabIndex={0}>
          <table aria-label="钱包账本记录">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">类型</th>
                <th scope="col">金额（最小货币单位）</th>
                <th scope="col">账目 ID</th>
                <th scope="col">交易 ID</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <tr key={entry.id}>
                  <td>{dateLabel(entry.createdAt)}</td>
                  <td>{ledgerTypeLabels[entry.type]}</td>
                  <td>
                    {entry.currency} {signedMinorUnits(entry)}
                  </td>
                  <td>
                    <code>{entry.id}</code>
                  </td>
                  <td>
                    <code>{entry.transactionId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <nav className="actions" aria-label="账本分页">
        <button type="button" onClick={onPrevious} disabled={!canGoBack} aria-label="上一页账本">
          上一页
        </button>
        <span className="muted" aria-live="polite">
          第 {pageNumber} 页
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={!page.hasMore || page.nextCursor === null}
          aria-label="下一页账本"
        >
          下一页
        </button>
      </nav>
    </>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      重试
    </button>
  );
}

export function SaasWalletPage({ onLogout }: { onLogout: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const tenants = useQuery({ queryKey: tenantsKey, queryFn: saasClient.getTenants, retry: false });
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [currencyInput, setCurrencyInput] = useState('USD');
  const [currencyError, setCurrencyError] = useState('');
  const [position, setPosition] = useState<LedgerPosition>({
    tenantId: '',
    currency: 'USD',
    cursors: [undefined],
    index: 0,
  });
  const [logoutError, setLogoutError] = useState<unknown>();
  const [storedTopUp, setStoredTopUp] = useState<StoredTopUp | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpError, setTopUpError] = useState<unknown>();
  const [topUpBusy, setTopUpBusy] = useState(false);
  const walletTenants = tenants.data?.filter((tenant) => tenant.role === 'owner' || tenant.role === 'admin') ?? [];

  useEffect(() => {
    if (!tenants.data) return;
    if (!walletTenants.some((tenant) => tenant.id === selectedTenantId)) {
      setSelectedTenantId(walletTenants[0]?.id ?? '');
    }
  }, [selectedTenantId, tenants.data, walletTenants]);

  const selectedTenant = walletTenants.find((tenant) => tenant.id === selectedTenantId) ?? walletTenants[0];
  const tenantId = selectedTenant?.id ?? '';
  const currentPosition =
    position.tenantId === tenantId && position.currency === currency
      ? position
      : { tenantId, currency, cursors: [undefined], index: 0 };
  const cursor = currentPosition.cursors[currentPosition.index];
  const wallet = useQuery({
    queryKey: walletQueryKey(tenantId, currency, cursor),
    queryFn: ({ signal }) => {
      if (!selectedTenant) throw new Error('客户控制台尚未选择已授权租户');
      return saasWalletClient.getWallet(selectedTenant, { currency, cursor, limit: pageSize, signal });
    },
    enabled: Boolean(selectedTenant),
    retry: false,
  });
  const topUpPolicy = useQuery({
    queryKey: topUpPolicyQueryKey(tenantId),
    queryFn: ({ signal }) => {
      if (!selectedTenant) throw new Error('客户控制台尚未选择已授权租户');
      return saasWalletClient.getWalletTopUpPolicy(selectedTenant, signal);
    },
    enabled: Boolean(selectedTenant),
    retry: false,
  });
  const trackedTopUpOrder = useQuery({
    queryKey: topUpOrderQueryKey(tenantId, storedTopUp?.orderId),
    queryFn: ({ signal }) => {
      if (!selectedTenant || !storedTopUp?.orderId) throw new Error('没有待查询的充值订单');
      return saasWalletClient.getWalletTopUp(selectedTenant, storedTopUp.orderId, signal);
    },
    enabled: Boolean(selectedTenant && storedTopUp?.orderId),
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' || query.state.data?.status === 'unknown' ? 5_000 : false,
    retry: false,
  });

  useEffect(() => {
    const saved = readStoredTopUp(tenantId);
    setStoredTopUp(saved);
    setTopUpAmount(saved?.amountMinorUnits ?? '');
    setTopUpError(undefined);
  }, [tenantId]);

  useEffect(() => {
    const order = trackedTopUpOrder.data;
    if (order?.status !== 'paid') return;
    setCurrency(order.currency);
    setCurrencyInput(order.currency);
    setCurrencyError('');
    setPosition((current) =>
      current.tenantId === tenantId && current.currency === order.currency
        ? current
        : { tenantId, currency: order.currency, cursors: [undefined], index: 0 },
    );
    void queryClient.invalidateQueries({ queryKey: ['saas-wallet', 'wallet', tenantId] });
  }, [queryClient, tenantId, trackedTopUpOrder.data?.id, trackedTopUpOrder.data?.currency, trackedTopUpOrder.data?.status]);

  const configuredTopUpPolicy = topUpPolicy.data?.available ? topUpPolicy.data : undefined;

  async function createTopUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTenant || !configuredTopUpPolicy) return;
    const amount = topUpAmount.trim();
    if (!/^[1-9]\d*$/.test(amount)) {
      setTopUpError(new Error('请输入以最小货币单位表示的正整数金额。'));
      return;
    }
    const minimum = configuredTopUpPolicy.minAmountMinorUnits;
    const maximum = configuredTopUpPolicy.maxAmountMinorUnits;
    if (!minimum || !maximum || BigInt(amount) < BigInt(minimum) || BigInt(amount) > BigInt(maximum)) {
      setTopUpError(new Error(`充值金额须在 ${minimum ?? '—'} 至 ${maximum ?? '—'} 之间。`));
      return;
    }
    if (
      storedTopUp?.idempotencyKey &&
      !storedTopUp.orderId &&
      (storedTopUp.amountMinorUnits !== amount || storedTopUp.currency !== configuredTopUpPolicy.currency)
    ) {
      setTopUpError(new Error('上次订单结果尚未确认，请先使用原金额重试以恢复该订单。'));
      return;
    }

    const reuseKey =
      storedTopUp?.idempotencyKey &&
      storedTopUp.amountMinorUnits === amount &&
      storedTopUp.currency === configuredTopUpPolicy.currency
        ? storedTopUp.idempotencyKey
        : undefined;
    let idempotencyKey: string;
    try {
      idempotencyKey = reuseKey ?? newIdempotencyKey();
    } catch (error) {
      setTopUpError(error);
      return;
    }
    const attempt: StoredTopUp = {
      idempotencyKey,
      amountMinorUnits: amount,
      currency: configuredTopUpPolicy.currency ?? undefined,
    };
    writeStoredTopUp(tenantId, attempt);
    setStoredTopUp(attempt);
    setTopUpError(undefined);
    setTopUpBusy(true);
    try {
      const order = await saasWalletClient.createWalletTopUp(selectedTenant, {
        amountMinorUnits: amount,
        currency: configuredTopUpPolicy.currency ?? '',
        idempotencyKey,
      });
      const recovered: StoredTopUp = { orderId: order.id, amountMinorUnits: amount, currency: order.currency };
      writeStoredTopUp(tenantId, recovered);
      setStoredTopUp(recovered);
      queryClient.setQueryData(topUpOrderQueryKey(tenantId, order.id), order);
      if (order.status === 'paid') {
        void queryClient.invalidateQueries({ queryKey: ['saas-wallet', 'wallet', tenantId] });
      }
    } catch (error) {
      setTopUpError(error);
    } finally {
      setTopUpBusy(false);
    }
  }

  async function refreshTopUpCheckout() {
    if (!selectedTenant || !storedTopUp?.orderId) return;
    setTopUpBusy(true);
    setTopUpError(undefined);
    try {
      const order = await saasWalletClient.refreshWalletTopUpCheckout(selectedTenant, storedTopUp.orderId);
      queryClient.setQueryData(topUpOrderQueryKey(tenantId, order.id), order);
    } catch (error) {
      setTopUpError(error);
    } finally {
      setTopUpBusy(false);
    }
  }

  function selectTenant(event: ChangeEvent<HTMLSelectElement>) {
    const tenant = walletTenants.find((candidate) => candidate.id === event.target.value);
    if (!tenant) return;
    setSelectedTenantId(tenant.id);
    setPosition({ tenantId: tenant.id, currency, cursors: [undefined], index: 0 });
  }

  function applyCurrency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextCurrency = currencyInput.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(nextCurrency)) {
      setCurrencyError('请输入三位字母币种代码，例如 USD。');
      return;
    }
    setCurrencyError('');
    setCurrencyInput(nextCurrency);
    setCurrency(nextCurrency);
    setPosition({ tenantId, currency: nextCurrency, cursors: [undefined], index: 0 });
  }

  function goPrevious() {
    setPosition({ ...currentPosition, index: Math.max(0, currentPosition.index - 1) });
  }

  function goNext() {
    const nextCursor = wallet.data?.ledger.nextCursor;
    if (!wallet.data?.ledger.hasMore || nextCursor === null || nextCursor === undefined) return;
    const nextCursors = currentPosition.cursors.slice(0, currentPosition.index + 1);
    nextCursors.push(nextCursor);
    setPosition({ ...currentPosition, cursors: nextCursors, index: currentPosition.index + 1 });
  }

  async function logout() {
    setLogoutError(undefined);
    try {
      await onLogout();
    } catch (error) {
      setLogoutError(error);
    } finally {
      queryClient.removeQueries({ queryKey: ['saas-wallet'] });
    }
  }

  return (
    <div className="saas-console saas-wallet">
      <header className="saas-header">
        <Link className="brand" to="/console" aria-label="返回客户控制台首页">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span>
            model-router<small>客户控制台</small>
          </span>
        </Link>
        <div className="actions">
          <Link to="/console">返回控制台</Link>
          <button className="quiet" type="button" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </header>
      {logoutError !== undefined && (
        <div className="notice error" role="alert">
          <strong>退出登录失败</strong>
          <span>{logoutError instanceof Error ? logoutError.message : '请稍后重试。'}</span>
        </div>
      )}
      <div className="page-title">
        <div>
          <p className="eyebrow">CUSTOMER WALLET</p>
          <h1>客户钱包</h1>
          <p>查看余额与账本，或创建平台钱包充值订单。</p>
        </div>
      </div>

      <nav aria-label="客户控制台导航">
        <Link to="/console">工作空间</Link>
        {' · '}
        <Link to="/console/catalog">服务计划目录</Link>
        {' · '}
        <Link to="/console/usage">用量</Link>
        {' · '}
        <Link to="/console/requests">请求</Link>
        {' · '}
        <Link to="/console/keys">API Keys</Link>
        {' · '}
        <Link to="/console/credentials">BYOK 凭证</Link>
        {' · '}
        <Link to="/console/wallet" aria-current="page">
          钱包
        </Link>
      </nav>

      {tenants.isPending && <LoadingState label="正在加载已授权租户" />}
      {tenants.error && (
        <div className="notice error" role="alert">
          <strong>无法读取客户租户</strong>
          <span>钱包页面只使用登录会话返回的授权租户。</span>
          <RetryButton onClick={() => void tenants.refetch()} />
        </div>
      )}
      {tenants.data?.length === 0 && (
        <div className="empty" role="status">
          当前账号没有已授权的客户租户。
        </div>
      )}
      {tenants.data && tenants.data.length > 0 && walletTenants.length === 0 && (
        <div className="empty" role="status">
          客户钱包仅对租户 owner 或 admin 开放；当前会话没有可管理的钱包租户。
        </div>
      )}

      {selectedTenant && (
        <>
          <div className="filters">
            <label className="field">
              <span>客户租户</span>
              <select aria-label="选择已授权租户" value={selectedTenant.id} onChange={selectTenant}>
                {walletTenants.map((tenant: SafeTenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name} · {tenant.slug}
                  </option>
                ))}
              </select>
            </label>
            <form className="actions" onSubmit={applyCurrency}>
              <label className="field">
                <span>钱包币种</span>
                <input
                  aria-label="钱包币种"
                  autoComplete="off"
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  value={currencyInput}
                  onChange={(event) => setCurrencyInput(event.target.value)}
                />
              </label>
              <button type="submit">查询</button>
              {currencyError && <span className="field-error" role="alert">{currencyError}</span>}
            </form>
          </div>

          <Panel title="钱包充值">
            {topUpPolicy.isPending && <LoadingState label="正在读取服务端充值准入策略" />}
            {topUpPolicy.error && (
              <div className="notice error" role="alert">
                <strong>无法读取充值状态</strong>
                <span>
                  {topUpPolicy.error instanceof SaasWalletApiError
                    ? `服务端返回 ${topUpPolicy.error.code}。`
                    : '请稍后重试。'}
                </span>
                <RetryButton onClick={() => void topUpPolicy.refetch()} />
              </div>
            )}
            {topUpPolicy.data?.available === false && (
              <div className="notice" role="status">
                <strong>充值暂不可用</strong>
                <span>服务端尚未配置可用的支付 adapter、币种及金额范围；本页不会创建订单或推测到账。</span>
                <RetryButton onClick={() => void topUpPolicy.refetch()} />
              </div>
            )}
            {configuredTopUpPolicy && (
              <>
                <p className="muted">
                  订单金额使用最小货币单位。当前准入范围：{configuredTopUpPolicy.currency}{' '}
                  {formatMinorUnits(configuredTopUpPolicy.minAmountMinorUnits)} 至{' '}
                  {formatMinorUnits(configuredTopUpPolicy.maxAmountMinorUnits)}。仅在服务端确认钱包履约后显示到账。
                </p>
                <form className="actions" onSubmit={(event) => void createTopUp(event)}>
                  <label className="field">
                    <span>充值金额（最小货币单位）</span>
                    <input
                      aria-label="充值金额（最小货币单位）"
                      autoComplete="off"
                      inputMode="numeric"
                      maxLength={19}
                      pattern="[1-9][0-9]*"
                      disabled={topUpBusy || Boolean(storedTopUp?.idempotencyKey && !storedTopUp.orderId)}
                      value={topUpAmount}
                      onChange={(event) => setTopUpAmount(event.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={topUpBusy}>
                    {topUpBusy ? '正在处理…' : storedTopUp?.idempotencyKey && !storedTopUp.orderId ? '恢复上次订单' : '创建充值订单'}
                  </button>
                </form>
                {storedTopUp?.idempotencyKey && !storedTopUp.orderId && (
                  <div className="notice" role="status">
                    <span>上次提交结果尚未确认；再次提交相同金额会复用原幂等键，避免重复创建订单。</span>
                  </div>
                )}
                {topUpError !== undefined && (
                  <div className="notice error" role="alert">
                    <strong>充值请求未确认</strong>
                    <span>
                      {topUpError instanceof SaasWalletApiError
                        ? `${topUpError.code}：${topUpError.message}`
                        : topUpError instanceof Error
                          ? topUpError.message
                          : '请检查订单状态后重试。'}
                    </span>
                  </div>
                )}
                {trackedTopUpOrder.isPending && storedTopUp?.orderId && (
                  <LoadingState label="正在恢复充值订单状态" />
                )}
                {trackedTopUpOrder.error && (
                  <div className="notice error" role="alert">
                    <strong>无法读取充值订单</strong>
                    <span>订单记录仍保存在本浏览器；可重试查询，不会据此判断已到账。</span>
                    <RetryButton onClick={() => void trackedTopUpOrder.refetch()} />
                  </div>
                )}
                {trackedTopUpOrder.data && (
                  <section className="summary-list" aria-label="充值订单状态" aria-live="polite">
                    <div>
                      <span>订单状态</span>
                      <strong>
                        {trackedTopUpOrder.data.status === 'expired' && trackedTopUpOrder.data.checkout.status === 'closed'
                          ? '充值订单已关闭'
                          : topUpStatusLabels[trackedTopUpOrder.data.status]}
                      </strong>
                    </div>
                    <div>
                      <span>订单金额</span>
                      <strong>
                        {trackedTopUpOrder.data.currency} {formatMinorUnits(trackedTopUpOrder.data.amountMinorUnits)}
                      </strong>
                    </div>
                    <div>
                      <span>订单 ID</span>
                      <strong><code>{trackedTopUpOrder.data.id}</code></strong>
                    </div>
                    {trackedTopUpOrder.data.status === 'paid' && (
                      <p className="notice" role="status">
                        服务端已完成钱包履约，正在刷新余额与账本。
                      </p>
                    )}
                    {trackedTopUpOrder.data.status === 'pending' && trackedTopUpOrder.data.paidAt && (
                      <p className="notice" role="status">支付已确认，钱包入账仍在处理中。</p>
                    )}
                    {trackedTopUpOrder.data.status === 'unknown' && (
                      <p className="notice error" role="status">支付结果待服务端核对，请勿重复付款或创建新订单。</p>
                    )}
                    {trackedTopUpOrder.data.status === 'pending' &&
                      trackedTopUpOrder.data.checkout.status !== 'ready' && (
                        <p className="notice" role="status">
                          当前没有可用的支付指引；订单仍以服务端状态为准，请刷新状态或支付指引，不要重复付款。
                        </p>
                      )}
                    {trackedTopUpOrder.data.checkout.status === 'ready' &&
                      trackedTopUpOrder.data.status === 'pending' &&
                      (trackedTopUpOrder.data.checkout.action.kind === 'redirect' ? (
                        <p>
                          <a
                            href={trackedTopUpOrder.data.checkout.action.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            打开支付页面
                          </a>
                          <span className="muted">；返回后刷新订单状态，跳转本身不代表到账。</span>
                        </p>
                      ) : (
                        <div className="field">
                          <span>支付二维码内容（复制到支付应用）</span>
                          <textarea readOnly value={trackedTopUpOrder.data.checkout.action.text} rows={3} />
                          <small>支付后刷新订单状态；以服务端钱包履约状态为准。</small>
                        </div>
                      ))}
                    <div className="actions">
                      <button type="button" onClick={() => void trackedTopUpOrder.refetch()}>
                        {trackedTopUpOrder.isFetching ? '正在刷新…' : '刷新订单状态'}
                      </button>
                      {((trackedTopUpOrder.data.status === 'pending' &&
                        trackedTopUpOrder.data.checkout.status !== 'ready') ||
                        (trackedTopUpOrder.data.status === 'expired' &&
                          trackedTopUpOrder.data.checkout.status === 'expired')) && (
                          <button type="button" onClick={() => void refreshTopUpCheckout()} disabled={topUpBusy}>
                            刷新支付指引
                          </button>
                        )}
                    </div>
                  </section>
                )}
              </>
            )}
          </Panel>

          {wallet.isPending && <LoadingState label="正在加载钱包余额和账本" />}
          {wallet.error && <WalletError error={wallet.error} onRetry={() => void wallet.refetch()} />}
          {wallet.data && (
            <>
              <Panel title="余额与冻结资金">
                <BalanceContent wallet={wallet.data.wallet} />
              </Panel>
              <Panel title="钱包账本">
              <LedgerContent
                page={wallet.data.ledger}
                pageNumber={currentPosition.index + 1}
                canGoBack={currentPosition.index > 0}
                onPrevious={goPrevious}
                onNext={goNext}
              />
              </Panel>
            </>
          )}
        </>
      )}
    </div>
  );
}

export { formatMinorUnits };
