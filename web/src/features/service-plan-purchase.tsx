import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SaasApiError,
  saasClient,
  servicePlanOrderFromError,
  type PaymentCheckoutAction,
  type PaymentCheckoutView,
  type ServicePlanCatalogItem,
  type ServicePlanOrder,
} from '../api/saas-client';
import { Badge } from '../components/ui';

export const SERVICE_PLAN_POLL_INTERVAL_MS = 5000;
export const SERVICE_PLAN_POLL_LIMIT = 12;
const INTENT_STORAGE_PREFIX = 'model-router:byok-service-plan-intent:';

interface StoredPurchaseIntent {
  idempotencyKey: string;
  orderId?: string;
}

type CheckoutDisplayStatus = PaymentCheckoutView['status'] | 'expired';
type OrderPresentationKind = 'pending' | 'fulfilled' | 'reconciliation' | 'failure';

function localStorageOrUndefined(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function servicePlanIntentStorageKey(tenantId: string, planVersionId: string): string {
  return `${INTENT_STORAGE_PREFIX}${encodeURIComponent(tenantId)}:${encodeURIComponent(planVersionId)}`;
}

function isStoredPurchaseIntent(value: unknown): value is StoredPurchaseIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.idempotencyKey === 'string' &&
    candidate.idempotencyKey.trim() !== '' &&
    (candidate.orderId === undefined || (typeof candidate.orderId === 'string' && candidate.orderId.trim() !== ''))
  );
}

function readPurchaseIntent(tenantId: string, planVersionId: string): StoredPurchaseIntent | undefined {
  const storage = localStorageOrUndefined();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(servicePlanIntentStorageKey(tenantId, planVersionId));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isStoredPurchaseIntent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writePurchaseIntent(tenantId: string, planVersionId: string, intent: StoredPurchaseIntent): void {
  const storage = localStorageOrUndefined();
  if (!storage) return;
  try {
    storage.setItem(servicePlanIntentStorageKey(tenantId, planVersionId), JSON.stringify(intent));
  } catch {
    // A blocked or full localStorage should not prevent an in-memory purchase.
  }
}

export function createServicePlanIdempotencyKey(): string {
  const randomUuid = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : undefined;
  const randomPart = randomUuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `byok-${randomPart}`;
}

export function isServicePlanOrderTerminal(order: ServicePlanOrder): boolean {
  return order.state === 'fulfilled' || order.state === 'cancelled';
}

export function shouldPollServicePlanOrder(order: ServicePlanOrder, visible: boolean, pollsUsed: number): boolean {
  return (
    visible &&
    pollsUsed < SERVICE_PLAN_POLL_LIMIT &&
    !isServicePlanOrderTerminal(order) &&
    order.providerFailureCode == null
  );
}

export function scheduleServicePlanPoll(callback: () => void, delay = SERVICE_PLAN_POLL_INTERVAL_MS): () => void {
  if (typeof window === 'undefined') return () => {};
  const timer = window.setTimeout(callback, delay);
  return () => window.clearTimeout(timer);
}

export function checkoutDisplayStatus(checkout: PaymentCheckoutView, now = Date.now()): CheckoutDisplayStatus {
  if (checkout.status !== 'ready') return checkout.status;
  return Date.parse(checkout.action.expiresAt) <= now ? 'expired' : 'ready';
}

export function servicePlanOrderPresentation(order: ServicePlanOrder): {
  kind: OrderPresentationKind;
  label: string;
  tone: 'neutral' | 'good' | 'bad' | 'warn';
  message: string;
} {
  if (order.state === 'fulfilled') {
    return {
      kind: 'fulfilled',
      label: 'fulfilled · 已开通',
      tone: 'good',
      message: '服务计划已由服务端确认开通。',
    };
  }
  if (order.providerFailureCode != null || order.state === 'cancelled') {
    return {
      kind: 'failure',
      label: 'failure · 支付提交失败',
      tone: 'bad',
      message:
        order.providerFailureCode != null
          ? '支付服务未能提交订单，但本地订单已保留。可以安全重试提交，不会丢失本次购买意图。'
          : '此订单已关闭，未显示为已开通。',
    };
  }
  if (order.state === 'reconciliation_pending') {
    return {
      kind: 'reconciliation',
      label: 'reconciliation · 待对账',
      tone: 'warn',
      message: '支付结果正在对账。请等待服务端状态变为 fulfilled，不要仅凭浏览器返回或“我已支付”判断成功。',
    };
  }
  return {
    kind: 'pending',
    label: order.state === 'pending' ? 'pending · 待付款或确认' : 'pending · 正在开通',
    tone: 'warn',
    message:
      order.state === 'pending'
        ? '订单尚未由服务端确认开通；只有 fulfilled 状态代表购买成功。'
        : '服务端已收到支付结果，正在完成开通。',
  };
}

function checkoutStatusLabel(status: CheckoutDisplayStatus): string {
  switch (status) {
    case 'ready':
      return '结账方式已准备';
    case 'pending':
      return '结账信息准备中';
    case 'unavailable':
      return '结账方式暂不可用';
    case 'expired':
      return '结账方式已过期';
    case 'closed':
      return '结账方式已关闭';
  }
}

export function servicePlanPurchaseErrorMessage(error: unknown): string {
  if (!(error instanceof SaasApiError)) return error instanceof Error ? error.message : '请求失败，请稍后重试。';
  if (error.status === 403) return '当前账号没有购买权限，租户和项目授权由服务端决定。';
  if (error.status === 404) return '订单不存在或当前会话无权读取该订单。';
  if (error.status === 409) return '订单状态不允许此操作，请刷新订单状态后再试。';
  if (error.status === 503) return '支付服务暂时不可用；如果响应包含订单，订单已保留，可稍后重试提交。';
  if (error.code === 'NETWORK') return '无法连接客户控制台服务。';
  return error.message || '支付操作未完成，请稍后重试。';
}

function checkoutRedirectAttributes(action: Extract<PaymentCheckoutAction, { kind: 'redirect' }>) {
  return { href: action.url, target: '_blank' as const, rel: 'noopener noreferrer' };
}

export function PaymentCheckoutActionView({
  checkout,
  now,
  onRefresh,
}: {
  checkout: PaymentCheckoutView;
  now?: number;
  onRefresh?: () => void;
}) {
  const [clockNow, setClockNow] = useState(() => now ?? Date.now());

  useEffect(() => {
    if (now !== undefined) {
      setClockNow(now);
      return;
    }
    if (checkout.status !== 'ready') return;
    const expiresAt = Date.parse(checkout.action.expiresAt);
    const delay = expiresAt - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) {
      setClockNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setClockNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [checkout, now]);

  const status = checkoutDisplayStatus(checkout, now ?? clockNow);
  if (checkout.status !== 'ready' || status === 'expired') {
    return (
      <div className="checkout-state" role="status" aria-live="polite">
        <strong>{checkoutStatusLabel(status)}</strong>
        {status === 'expired' ? (
          <span>支付动作已过期，不会自动打开旧链接；请刷新结账信息。</span>
        ) : (
          <span>服务端尚未提供可用的支付动作。</span>
        )}
        {status === 'expired' && onRefresh && (
          <button type="button" onClick={onRefresh}>
            刷新结账信息
          </button>
        )}
      </div>
    );
  }

  const action = checkout.action;
  if (action.kind === 'redirect') {
    return (
      <div className="checkout-state" role="status" aria-live="polite">
        <strong>{checkoutStatusLabel(status)}</strong>
        <span>点击下方按钮打开支付页面；返回浏览器不会直接改变订单成功状态。</span>
        <a className="button-link primary" {...checkoutRedirectAttributes(action)}>
          打开支付页面
        </a>
      </div>
    );
  }

  return <QrCheckoutText action={action} />;
}

function QrCheckoutText({ action }: { action: Extract<PaymentCheckoutAction, { kind: 'qr' }> }) {
  const [copyState, setCopyState] = useState('');

  async function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setCopyState('当前浏览器不支持自动复制，请手动复制上方文本。');
      return;
    }
    try {
      await navigator.clipboard.writeText(action.text);
      setCopyState('已复制');
    } catch {
      setCopyState('自动复制失败，请手动复制上方文本。');
    }
  }

  return (
    <div className="checkout-state" role="status" aria-live="polite">
      <strong>结账方式已准备 · QR payload</strong>
      <span>当前环境没有二维码渲染器；请复制此有限长度的支付文本到你的支付工具。</span>
      <textarea aria-label="支付二维码文本" className="checkout-qr-text" readOnly rows={4} value={action.text} />
      <div className="actions">
        <button type="button" onClick={() => void copy()}>
          复制支付文本
        </button>
        {copyState && <small role="status">{copyState}</small>}
      </div>
    </div>
  );
}

export function ServicePlanOrderSurface({
  order,
  busy,
  error,
  onRefresh,
  onRetry,
  onRefreshCheckout,
}: {
  order: ServicePlanOrder;
  busy: boolean;
  error?: unknown;
  onRefresh: () => void;
  onRetry: () => void;
  onRefreshCheckout: () => void;
}) {
  const presentation = servicePlanOrderPresentation(order);
  const canRetry = order.state === 'pending' && order.providerFailureCode != null && order.providerOrderId == null;
  const showCheckout = order.state === 'pending' && presentation.kind === 'pending' && order.providerFailureCode == null;

  return (
    <div className="service-plan-purchase-surface">
      <div className="service-plan-order-heading">
        <div>
          <strong>订单状态</strong>
          <small>
            订单 <code>{order.id}</code>
          </small>
        </div>
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </div>
      <p className="muted">{presentation.message}</p>
      {presentation.kind === 'failure' && order.providerFailureCode && (
        <p className="form-error">支付服务状态：{order.providerFailureCode}</p>
      )}
      {showCheckout && (
        <PaymentCheckoutActionView checkout={order.checkout} onRefresh={onRefreshCheckout} />
      )}
      {error !== undefined && error !== null && <p className="form-error" role="alert">{servicePlanPurchaseErrorMessage(error)}</p>}
      <div className="actions">
        <button type="button" onClick={onRefresh} disabled={busy}>
          {busy ? '处理中…' : '手动刷新订单状态'}
        </button>
        {canRetry && (
          <button className="primary" type="button" onClick={onRetry} disabled={busy}>
            重试支付提交
          </button>
        )}
      </div>
    </div>
  );
}

function currentOrderId(intent: StoredPurchaseIntent | undefined): string | undefined {
  return intent?.orderId;
}

export function ServicePlanPurchase({
  tenantId,
  plan,
}: {
  tenantId: string;
  plan: ServicePlanCatalogItem;
}) {
  const [intent, setIntent] = useState<StoredPurchaseIntent | undefined>(() => readPurchaseIntent(tenantId, plan.planVersionId));
  const [order, setOrder] = useState<ServicePlanOrder>();
  const [loadingSavedOrder, setLoadingSavedOrder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [pollsUsed, setPollsUsed] = useState(0);
  const pollController = useRef<AbortController | null>(null);

  const saveIntent = useCallback(
    (next: StoredPurchaseIntent) => {
      setIntent(next);
      writePurchaseIntent(tenantId, plan.planVersionId, next);
    },
    [plan.planVersionId, tenantId],
  );

  useEffect(() => {
    const saved = readPurchaseIntent(tenantId, plan.planVersionId);
    setIntent(saved);
    setOrder(undefined);
    setError(undefined);
    setPollsUsed(0);
    if (!saved?.orderId) return;

    let active = true;
    setLoadingSavedOrder(true);
    void saasClient
      .getServicePlanOrder(tenantId, saved.orderId)
      .then(savedOrder => {
        if (active) setOrder(savedOrder);
      })
      .catch(savedOrderError => {
        if (active) setError(savedOrderError);
      })
      .finally(() => {
        if (active) setLoadingSavedOrder(false);
      });
    return () => {
      active = false;
    };
  }, [plan.planVersionId, tenantId]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const updateVisibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => () => pollController.current?.abort(), []);

  const orderId = currentOrderId(intent);
  const canPoll = Boolean(order && orderId && shouldPollServicePlanOrder(order, visible, pollsUsed));
  useEffect(() => {
    if (!canPoll || !orderId) return;
    let disposed = false;
    let activeController: AbortController | undefined;
    const cancel = scheduleServicePlanPoll(() => {
      if (disposed) return;
      const controller = new AbortController();
      activeController = controller;
      pollController.current = controller;
      void saasClient
        .getServicePlanOrder(tenantId, orderId, controller.signal)
        .then(nextOrder => {
          if (!disposed) {
            setOrder(nextOrder);
            setError(undefined);
          }
        })
        .catch(pollError => {
          if (!disposed && !controller.signal.aborted) setError(pollError);
        })
        .finally(() => {
          if (pollController.current === controller) pollController.current = null;
          if (disposed) return;
          setPollsUsed(value => value + 1);
        });
    });
    return () => {
      disposed = true;
      cancel();
      activeController?.abort();
      if (pollController.current === activeController) pollController.current = null;
    };
  }, [canPoll, orderId, pollsUsed, tenantId, visible]);

  async function startPurchase() {
    setBusy(true);
    setError(undefined);
    const nextIntent = order && isServicePlanOrderTerminal(order) ? { idempotencyKey: createServicePlanIdempotencyKey() } : intent;
    const purchaseIntent = nextIntent ?? { idempotencyKey: createServicePlanIdempotencyKey() };
    saveIntent(purchaseIntent);
    try {
      const created = await saasClient.createServicePlanOrder(
        tenantId,
        { planVersionId: plan.planVersionId, operation: 'activation' },
        purchaseIntent.idempotencyKey,
      );
      saveIntent({ ...purchaseIntent, orderId: created.id });
      setOrder(created);
      setPollsUsed(0);
    } catch (purchaseError) {
      const preserved = servicePlanOrderFromError(purchaseError, tenantId);
      if (preserved) {
        saveIntent({ ...purchaseIntent, orderId: preserved.id });
        setOrder(preserved);
        setPollsUsed(0);
        setError(undefined);
      } else {
        setError(purchaseError);
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshOrder() {
    if (!orderId) return;
    setBusy(true);
    setError(undefined);
    try {
      const nextOrder = await saasClient.getServicePlanOrder(tenantId, orderId);
      setOrder(nextOrder);
    } catch (refreshError) {
      setError(refreshError);
    } finally {
      setBusy(false);
    }
  }

  async function retryProviderSubmission() {
    if (!orderId) return;
    setBusy(true);
    setError(undefined);
    try {
      const nextOrder = await saasClient.retryServicePlanOrder(tenantId, orderId);
      setOrder(nextOrder);
      setPollsUsed(0);
    } catch (retryError) {
      const preserved = servicePlanOrderFromError(retryError, tenantId);
      if (preserved) {
        setOrder(preserved);
        setError(undefined);
      } else {
        setError(retryError);
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshCheckout() {
    if (!orderId) return;
    setBusy(true);
    setError(undefined);
    try {
      // Checkout is part of the order DTO. Refresh the full DTO so a payment
      // that fulfilled while the action expired cannot leave a stale pending state.
      const refreshedOrder = await saasClient.getServicePlanOrder(tenantId, orderId);
      setOrder(refreshedOrder);
    } catch (checkoutError) {
      setError(checkoutError);
    } finally {
      setBusy(false);
    }
  }

  if (loadingSavedOrder) {
    return <div className="service-plan-purchase"><small role="status">正在恢复未完成的订单…</small></div>;
  }

  if (!order) {
    return (
      <div className="service-plan-purchase">
        <button className="primary" type="button" onClick={() => void startPurchase()} disabled={busy}>
          {busy ? '正在创建订单…' : '购买并开始结账'}
        </button>
        {error !== undefined && error !== null && (
          <div className="notice error" role="alert">
            <strong>购买未完成</strong>
            <span>{servicePlanPurchaseErrorMessage(error)}</span>
            <button type="button" onClick={() => void startPurchase()} disabled={busy}>
              使用同一购买意图重试
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="service-plan-purchase">
      <ServicePlanOrderSurface
        order={order}
        busy={busy}
        error={error}
        onRefresh={() => void refreshOrder()}
        onRetry={() => void retryProviderSubmission()}
        onRefreshCheckout={() => void refreshCheckout()}
      />
      {order.state === 'cancelled' && (
        <div className="actions">
          <button className="primary" type="button" onClick={() => void startPurchase()} disabled={busy}>
            重新开始 activation 购买
          </button>
        </div>
      )}
      {!isServicePlanOrderTerminal(order) && order.providerFailureCode == null && pollsUsed >= SERVICE_PLAN_POLL_LIMIT && (
        <small className="muted" role="status">
          自动状态刷新已暂停（已达到上限）；订单仍可手动刷新。
        </small>
      )}
    </div>
  );
}
