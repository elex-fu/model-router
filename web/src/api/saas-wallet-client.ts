import type { SafeTenant } from './saas-client';

const BASE = '/console/api/v1';
const MAX_CURSOR_LENGTH = 2048;

export type SaasWalletLedgerDirection = 'credit' | 'debit';
export type SaasWalletLedgerType = 'top_up' | 'usage_charge';

export interface SaasWalletSnapshot {
  currency: string;
  postedBalanceMinorUnits: string;
  activeHoldsMinorUnits: string;
  frozenAmountMinorUnits: string;
  availableMinorUnits: string;
  spendingFrozen: boolean;
}

export interface SaasWalletLedgerEntry {
  id: string;
  transactionId: string;
  currency: string;
  direction: SaasWalletLedgerDirection;
  amountMinorUnits: string;
  type: SaasWalletLedgerType;
  createdAt: string;
}

export interface SaasWalletLedgerPage {
  items: SaasWalletLedgerEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SaasWalletData {
  wallet: SaasWalletSnapshot;
  ledger: SaasWalletLedgerPage;
}

export interface SaasWalletTopUpPolicy {
  available: boolean;
  currency: string | null;
  minAmountMinorUnits: string | null;
  maxAmountMinorUnits: string | null;
}

export type SaasWalletTopUpStatus = 'pending' | 'paid' | 'failed' | 'unknown' | 'expired';

export type SaasWalletTopUpCheckout =
  | { status: 'ready'; action: { kind: 'redirect'; url: string; expiresAt: string } | { kind: 'qr'; text: string; expiresAt: string } }
  | { status: 'pending' | 'unavailable' | 'expired' | 'closed'; action: null };

export interface SaasWalletTopUpOrder {
  id: string;
  orderType: 'wallet_topup';
  amountMinorUnits: string;
  currency: string;
  status: SaasWalletTopUpStatus;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  checkout: SaasWalletTopUpCheckout;
}

export class SaasWalletApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SaasWalletApiError';
  }
}

interface ApiEnvelope {
  data?: unknown;
  meta?: unknown;
  error?: { code?: unknown; message?: unknown };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function invalidResponse(message: string): never {
  throw new SaasWalletApiError(200, 'INVALID_RESPONSE', message);
}

/** Wallet reads require a tenant from the authenticated console tenant query. */
function trustedTenantBase(tenant: SafeTenant): string {
  if (
    !tenant ||
    typeof tenant.id !== 'string' ||
    tenant.id.trim() === '' ||
    tenant.status !== 'active' ||
    typeof tenant.slug !== 'string' ||
    (tenant.role !== 'owner' && tenant.role !== 'admin')
  ) {
    throw new SaasWalletApiError(0, 'INVALID_TENANT_CONTEXT', '钱包查询需要来自客户控制台的 owner/admin 租户');
  }
  return `/tenants/${encodeURIComponent(tenant.id)}`;
}

function trustedTenantPath(tenant: SafeTenant): string {
  return `${trustedTenantBase(tenant)}/wallet`;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') return invalidResponse(`钱包响应中的 ${field} 无效`);
  return value;
}

function minorUnits(value: unknown, field: string, allowNegative = false): string {
  if (typeof value !== 'string' || !(allowNegative ? /^-?\d+$/ : /^\d+$/).test(value)) {
    return invalidResponse(`钱包响应中的 ${field} 不是有效的最小货币单位整数`);
  }
  return value;
}

function parseWallet(value: unknown, requestedCurrency: string): SaasWalletSnapshot {
  const candidate = asObject(value);
  if (!candidate || candidate.currency !== requestedCurrency) return invalidResponse('钱包响应中的币种与请求不匹配');
  if (typeof candidate.spendingFrozen !== 'boolean') return invalidResponse('钱包响应中的 spendingFrozen 无效');

  const postedBalanceMinorUnits = minorUnits(candidate.postedBalanceMinorUnits, 'postedBalanceMinorUnits');
  const activeHoldsMinorUnits = minorUnits(candidate.activeHoldsMinorUnits, 'activeHoldsMinorUnits');
  const frozenAmountMinorUnits = minorUnits(candidate.frozenAmountMinorUnits, 'frozenAmountMinorUnits');
  const availableMinorUnits = minorUnits(candidate.availableMinorUnits, 'availableMinorUnits');
  if (
    BigInt(postedBalanceMinorUnits) - BigInt(activeHoldsMinorUnits) - BigInt(frozenAmountMinorUnits) !==
    BigInt(availableMinorUnits)
  ) {
    return invalidResponse('钱包响应中的余额、hold、冻结资金和可用余额不一致');
  }

  return {
    currency: requestedCurrency,
    postedBalanceMinorUnits,
    activeHoldsMinorUnits,
    frozenAmountMinorUnits,
    availableMinorUnits,
    spendingFrozen: candidate.spendingFrozen,
  };
}

function parseLedgerEntry(value: unknown, currency: string): SaasWalletLedgerEntry {
  const candidate = asObject(value);
  if (!candidate) return invalidResponse('账本条目无效');
  if (candidate.currency !== currency) return invalidResponse('账本条目中的币种与钱包不匹配');
  if (candidate.direction !== 'credit' && candidate.direction !== 'debit') {
    return invalidResponse('账本条目中的 direction 无效');
  }
  if (candidate.type !== 'top_up' && candidate.type !== 'usage_charge') {
    return invalidResponse('账本条目中的 type 无效');
  }

  return {
    id: requiredText(candidate.id, 'ledger.id'),
    transactionId: requiredText(candidate.transactionId, 'ledger.transactionId'),
    currency,
    direction: candidate.direction,
    amountMinorUnits: minorUnits(candidate.amountMinorUnits, 'ledger.amountMinorUnits'),
    type: candidate.type,
    createdAt: requiredText(candidate.createdAt, 'ledger.createdAt'),
  };
}

function parseLedgerPage(value: unknown, currency: string): SaasWalletLedgerPage {
  const candidate = asObject(value);
  if (
    !candidate ||
    !Array.isArray(candidate.items) ||
    (candidate.nextCursor !== null && typeof candidate.nextCursor !== 'string') ||
    typeof candidate.hasMore !== 'boolean' ||
    candidate.hasMore !== (candidate.nextCursor !== null)
  ) {
    return invalidResponse('账本分页响应无效');
  }
  if (typeof candidate.nextCursor === 'string' && (candidate.nextCursor.length === 0 || candidate.nextCursor.length > MAX_CURSOR_LENGTH)) {
    return invalidResponse('账本分页游标无效');
  }
  return {
    items: candidate.items.map((item) => parseLedgerEntry(item, currency)),
    nextCursor: candidate.nextCursor,
    hasMore: candidate.hasMore,
  };
}

function parseTopUpPolicy(value: unknown): SaasWalletTopUpPolicy {
  const candidate = asObject(value);
  if (!candidate || typeof candidate.available !== 'boolean') return invalidResponse('充值准入策略无效');
  if (!candidate.available) {
    if (
      candidate.currency !== null ||
      candidate.minAmountMinorUnits !== null ||
      candidate.maxAmountMinorUnits !== null
    ) {
      return invalidResponse('不可用的充值策略包含了金额配置');
    }
    return { available: false, currency: null, minAmountMinorUnits: null, maxAmountMinorUnits: null };
  }
  if (
    typeof candidate.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(candidate.currency) ||
    typeof candidate.minAmountMinorUnits !== 'string' ||
    !/^[1-9]\d*$/.test(candidate.minAmountMinorUnits) ||
    typeof candidate.maxAmountMinorUnits !== 'string' ||
    !/^[1-9]\d*$/.test(candidate.maxAmountMinorUnits) ||
    BigInt(candidate.minAmountMinorUnits) > BigInt(candidate.maxAmountMinorUnits)
  ) {
    return invalidResponse('充值币种或金额范围无效');
  }
  return {
    available: true,
    currency: candidate.currency,
    minAmountMinorUnits: candidate.minAmountMinorUnits,
    maxAmountMinorUnits: candidate.maxAmountMinorUnits,
  };
}

function parseTopUpCheckout(value: unknown): SaasWalletTopUpCheckout {
  const candidate = asObject(value);
  if (!candidate) return invalidResponse('充值 checkout 信息无效');
  if (candidate.status === 'ready') {
    const action = asObject(candidate.action);
    if (!action) return invalidResponse('充值 checkout action 无效');
    const expiresAt = requiredText(action.expiresAt, 'checkout.expiresAt');
    if (action.kind === 'redirect') {
      const url = requiredText(action.url, 'checkout.url');
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return invalidResponse('充值跳转地址无效');
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return invalidResponse('充值跳转地址协议无效');
      return { status: 'ready', action: { kind: 'redirect', url, expiresAt } };
    }
    if (action.kind === 'qr') {
      return { status: 'ready', action: { kind: 'qr', text: requiredText(action.text, 'checkout.text'), expiresAt } };
    }
    return invalidResponse('充值 checkout 类型无效');
  }
  if (
    candidate.status === 'pending' ||
    candidate.status === 'unavailable' ||
    candidate.status === 'expired' ||
    candidate.status === 'closed'
  ) {
    if (candidate.action !== null) return invalidResponse('未就绪的充值 checkout 不能包含支付 action');
    return { status: candidate.status, action: null };
  }
  return invalidResponse('充值 checkout 状态无效');
}

function parseTopUpOrder(value: unknown, requestedCurrency?: string): SaasWalletTopUpOrder {
  const candidate = asObject(value);
  if (
    !candidate ||
    candidate.orderType !== 'wallet_topup' ||
    typeof candidate.status !== 'string' ||
    !['pending', 'paid', 'failed', 'unknown', 'expired'].includes(candidate.status) ||
    typeof candidate.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(candidate.currency) ||
    (requestedCurrency !== undefined && candidate.currency !== requestedCurrency)
  ) {
    return invalidResponse('充值订单归属或状态无效');
  }
  const nullableTimestamp = (field: string): string | null => {
    const item = candidate[field];
    if (item === null) return null;
    const timestamp = requiredText(item, field);
    if (!Number.isFinite(Date.parse(timestamp))) return invalidResponse(`充值订单中的 ${field} 无效`);
    return timestamp;
  };
  return {
    id: requiredText(candidate.id, 'order.id'),
    orderType: 'wallet_topup',
    amountMinorUnits: minorUnits(candidate.amountMinorUnits, 'order.amountMinorUnits'),
    currency: candidate.currency,
    status: candidate.status as SaasWalletTopUpStatus,
    createdAt: requiredText(candidate.createdAt, 'order.createdAt'),
    updatedAt: requiredText(candidate.updatedAt, 'order.updatedAt'),
    paidAt: nullableTimestamp('paidAt'),
    fulfilledAt: nullableTimestamp('fulfilledAt'),
    checkout: parseTopUpCheckout(candidate.checkout),
  };
}

function csrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = 'mr_saas_csrf=';
  const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!value) return undefined;
  try {
    return decodeURIComponent(value.slice(prefix.length));
  } catch {
    return undefined;
  }
}

async function request(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrfToken = csrfCookie();
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    throw new SaasWalletApiError(0, 'NETWORK', error instanceof Error ? error.message : '网络连接失败');
  }

  const raw = await response.text();
  let parsed: ApiEnvelope | undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as ApiEnvelope;
    } catch {
      throw new SaasWalletApiError(response.status, 'INVALID_RESPONSE', '服务返回了无效 JSON');
    }
  }
  if (!response.ok) {
    throw new SaasWalletApiError(
      response.status,
      typeof parsed?.error?.code === 'string' ? parsed.error.code : 'HTTP_ERROR',
      typeof parsed?.error?.message === 'string' ? parsed.error.message : `请求失败 (${response.status})`,
    );
  }
  const meta = asObject(parsed?.meta);
  if (!parsed || !Object.hasOwn(parsed, 'data') || !meta || typeof meta.requestId !== 'string') {
    throw new SaasWalletApiError(response.status, 'INVALID_RESPONSE', '服务响应缺少 data 或 requestId');
  }
  return parsed.data;
}

export function isSaasWalletUnavailable(error: unknown): boolean {
  if (!(error instanceof SaasWalletApiError)) return false;
  return (
    (error.status === 503 && ['CUSTOMER_WALLET_UNAVAILABLE', 'CUSTOMER_TOPUP_UNAVAILABLE'].includes(error.code)) ||
    (error.status === 404 && ['CUSTOMER_WALLET_NOT_FOUND', 'NOT_FOUND'].includes(error.code))
  );
}

export const saasWalletClient = {
  getWallet(
    tenant: SafeTenant,
    options: { currency: string; cursor?: string; limit?: number; signal?: AbortSignal },
  ): Promise<SaasWalletData> {
    const path = trustedTenantPath(tenant);
    const currency = options.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '钱包币种必须是三位大写字母代码');
    }
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '账本每页条数必须在 1 到 100 之间');
    }
    if (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > MAX_CURSOR_LENGTH)) {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '账本分页游标无效');
    }

    const query = new URLSearchParams({ currency, limit: String(limit) });
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    return request(`${path}?${query.toString()}`, { signal: options.signal }).then((data) => {
      const candidate = asObject(data);
      if (!candidate) return invalidResponse('钱包响应无效');
      return {
        wallet: parseWallet(candidate.wallet, currency),
        ledger: parseLedgerPage(candidate.ledger, currency),
      };
    });
  },

  async getWalletTopUpPolicy(tenant: SafeTenant, signal?: AbortSignal): Promise<SaasWalletTopUpPolicy> {
    const path = trustedTenantBase(tenant);
    try {
      return parseTopUpPolicy(await request(`${path}/wallet-topups/policy`, { signal }));
    } catch (error) {
      if (
        error instanceof SaasWalletApiError &&
        ((error.status === 404 && error.code === 'NOT_FOUND') ||
          (error.status === 503 && error.code === 'CUSTOMER_TOPUP_UNAVAILABLE'))
      ) {
        return { available: false, currency: null, minAmountMinorUnits: null, maxAmountMinorUnits: null };
      }
      throw error;
    }
  },

  createWalletTopUp(
    tenant: SafeTenant,
    input: { amountMinorUnits: string; currency: string; idempotencyKey: string },
  ): Promise<SaasWalletTopUpOrder> {
    const path = trustedTenantBase(tenant);
    if (!/^[1-9]\d*$/.test(input.amountMinorUnits) || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '充值金额或币种无效');
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '创建充值订单需要 Idempotency-Key');
    }
    return request(`${path}/orders`, {
      method: 'POST',
      body: { amountMinorUnits: input.amountMinorUnits, currency: input.currency },
      idempotencyKey: input.idempotencyKey,
    }).then((data) => parseTopUpOrder(data, input.currency));
  },

  getWalletTopUp(tenant: SafeTenant, orderId: string, signal?: AbortSignal): Promise<SaasWalletTopUpOrder> {
    const path = trustedTenantBase(tenant);
    if (orderId.trim() === '' || orderId.length > 255) {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '充值订单 ID 无效');
    }
    return request(`${path}/orders/${encodeURIComponent(orderId)}`, { signal }).then(parseTopUpOrder);
  },

  refreshWalletTopUpCheckout(tenant: SafeTenant, orderId: string): Promise<SaasWalletTopUpOrder> {
    const path = trustedTenantBase(tenant);
    if (orderId.trim() === '' || orderId.length > 255) {
      throw new SaasWalletApiError(0, 'INVALID_INPUT', '充值订单 ID 无效');
    }
    return request(`${path}/orders/${encodeURIComponent(orderId)}/checkout`, { method: 'POST' }).then(parseTopUpOrder);
  },
};
