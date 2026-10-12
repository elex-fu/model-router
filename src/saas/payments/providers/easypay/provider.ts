import type {
  PaymentProviderAdapter,
  PaymentProviderRefundAdapter,
  PaymentProviderSubmissionErrorDetails,
} from '../../adapter.js';
import type {
  NormalizedPaymentProviderEvent,
  PaymentCheckoutAction,
  PaymentProviderCreateOrderInput,
  PaymentProviderCreateOrderResult,
  PaymentProviderEventConfirmation,
  PaymentProviderEventConfirmationInput,
  PaymentProviderOrderRecoveryInput,
  PaymentProviderRefundInput,
  PaymentProviderRefundQueryResult,
  PaymentProviderRefundResult,
  PaymentProviderWebhookVerificationInput,
  VerifiedPaymentProviderWebhook,
} from '../../types.js';
import {
  EASY_PAY_CODE_SUCCESS,
  EASY_PAY_PROVIDER_KEY,
  EASY_PAY_TRADE_STATUS_SUCCESS,
  type EasyPayProviderConfigInput,
  type EasyPayProviderOptions,
  easyPayMinorUnitsToYuan,
  easyPaySign,
  easyPayVerifySign,
  easyPayYuanToMinorUnits,
  parseEasyPayProviderConfig,
  resolveEasyPayReturnedRef,
} from './protocol.js';

// EasyPay adapter (contract C-3): mapi direct-pay only, MD5 signing, and the
// red-line fulfillment gate — a signed webhook never fulfills until an active
// QueryOrder requery confirms out_trade_no + TRADE_SUCCESS + amount. Refund
// queries always answer `unknown` (EasyPay has no refund-query API), routing
// refunds to operator reconciliation; the refund request itself is unsigned
// with a plaintext pkey (upstream protocol), mitigated by egress allowlists
// and recorded in COM-01.

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_UPSTREAM_MESSAGE = 512;
const UNRESOLVED_TENANT = 'unresolved-tenant';

export type EasyPaySubmissionAcceptance = PaymentProviderSubmissionErrorDetails;

/** Adapter errors carry the structural acceptance details the payment service reads off the thrown object. */
export class EasyPayProviderError extends Error {
  readonly acceptance: 'rejected' | 'not_accepted' | 'unknown';
  readonly retryable?: boolean;
  readonly safeToRetry?: boolean;

  constructor(
    message: string,
    details: {
      readonly acceptance: 'rejected' | 'not_accepted' | 'unknown';
      readonly retryable?: boolean;
      readonly safeToRetry?: boolean;
    },
  ) {
    super(message);
    this.name = 'EasyPayProviderError';
    this.acceptance = details.acceptance;
    if (details.retryable !== undefined) this.retryable = details.retryable;
    if (details.safeToRetry !== undefined) this.safeToRetry = details.safeToRetry;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function submissionError(acceptance: 'rejected' | 'not_accepted' | 'unknown', message: string): EasyPayProviderError {
  return new EasyPayProviderError(message, { acceptance });
}

interface EasyPayHttpResponse {
  readonly status: number;
  readonly body: string;
}

type EasyPayOrderQuery =
  | {
      readonly kind: 'found';
      readonly tradeNo: string | null;
      readonly tradeStatus: string | null;
      readonly statusCode: number | null;
      readonly money: string | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unknown' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function codeIsSuccess(value: unknown): boolean {
  if (typeof value === 'number') return value === EASY_PAY_CODE_SUCCESS;
  if (typeof value === 'string') return value.trim() === String(EASY_PAY_CODE_SUCCESS);
  return false;
}

export class EasyPayPaymentProvider {
  readonly adapter: PaymentProviderAdapter;
  readonly refundAdapter: PaymentProviderRefundAdapter;

  constructor(private readonly options: EasyPayProviderOptions) {
    this.adapter = Object.freeze({
      providerKey: EASY_PAY_PROVIDER_KEY,
      createOrder: (input) => this.createOrder(input),
      refreshCheckout: (input) => this.refreshCheckout(input),
      recoverOrder: (input) => this.recoverOrder(input),
      verifyWebhook: (input) => this.verifyWebhook(input),
      normalizeEvent: (input) => this.normalizeEvent(input),
      confirmEvent: (input) => this.confirmEvent(input),
    } satisfies PaymentProviderAdapter);
    this.refundAdapter = Object.freeze({
      providerKey: EASY_PAY_PROVIDER_KEY,
      merchantId: options.pid,
      submitRefund: (input) => this.submitRefund(input),
      queryRefund: (input) => this.queryRefund(input),
    } satisfies PaymentProviderRefundAdapter);
  }

  /** Redacts the merchant key from any upstream text before it can reach logs. */
  private summarize(text: string): string {
    let summary = text.replaceAll(this.options.pkey, '***').replace(/\s+/g, ' ').trim();
    if (summary.length > MAX_UPSTREAM_MESSAGE) summary = `${summary.slice(0, MAX_UPSTREAM_MESSAGE)}...`;
    return summary === '' ? '<empty>' : summary;
  }

  private async postForm(endpoint: string, params: Readonly<Record<string, string>>): Promise<EasyPayHttpResponse> {
    const body = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await this.options.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      throw submissionError('unknown', 'easypay request failed');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw submissionError('unknown', 'easypay response could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw submissionError('unknown', 'easypay response is too large');
    }
    return { status: response.status, body: text };
  }

  private parseJson(response: EasyPayHttpResponse): Record<string, unknown> {
    if (response.status < 200 || response.status >= 300) {
      throw submissionError('unknown', `easypay answered HTTP ${response.status}`);
    }
    try {
      const parsed: unknown = JSON.parse(response.body);
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch (error) {
      if (error instanceof EasyPayProviderError) throw error;
      throw submissionError('unknown', 'easypay response is not valid JSON');
    }
  }

  /** Active order requery by out_trade_no; the fulfillment red line depends on this tri-state. */
  private async queryOrder(outTradeNo: string): Promise<EasyPayOrderQuery> {
    let response: EasyPayHttpResponse;
    try {
      response = await this.postForm(`${this.options.apiBase}/api.php`, {
        act: 'order',
        pid: this.options.pid,
        key: this.options.pkey,
        out_trade_no: outTradeNo,
      });
    } catch {
      return { kind: 'unknown' };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = this.parseJson(response);
    } catch {
      return { kind: 'unknown' };
    }
    if (!codeIsSuccess(parsed.code)) return { kind: 'not_found' };
    const data = isRecord(parsed.data) ? parsed.data : {};
    const pick = (field: string): unknown => parsed[field] ?? data[field];
    const statusValue = pick('status');
    return {
      kind: 'found',
      tradeNo: textField(pick('trade_no')),
      tradeStatus: textField(pick('trade_status')),
      statusCode: typeof statusValue === 'number' ? statusValue : null,
      money: textField(pick('money')),
    };
  }

  private buildCheckoutAction(payload: Record<string, unknown>): PaymentCheckoutAction | undefined {
    const expiresAt = new Date(this.options.now().getTime() + this.options.checkoutTtlMs).toISOString();
    const payurl = textField(payload.payurl);
    if (payurl !== null) {
      return { kind: 'redirect', url: resolveEasyPayReturnedRef(this.options.apiBase, payurl), expiresAt };
    }
    const qrcode = textField(payload.qrcode);
    if (qrcode !== null) {
      return { kind: 'qr', text: resolveEasyPayReturnedRef(this.options.apiBase, qrcode), expiresAt };
    }
    const payurl2 = textField(payload.payurl2);
    if (payurl2 !== null) {
      return { kind: 'redirect', url: resolveEasyPayReturnedRef(this.options.apiBase, payurl2), expiresAt };
    }
    return undefined;
  }

  private createParams(input: {
    readonly localOrderId: string;
    readonly tenantId: string;
    readonly amountMinorUnits: string;
  }): Record<string, string> {
    const params: Record<string, string> = {
      pid: this.options.pid,
      type: this.options.paymentType,
      out_trade_no: input.localOrderId,
      notify_url: this.options.notifyUrl,
      return_url: this.options.returnUrl,
      name: `Order ${input.localOrderId}`.slice(0, 120),
      money: easyPayMinorUnitsToYuan(input.amountMinorUnits),
      // epay pass-through field: the notify echoes it, letting normalizeEvent
      // recover the tenant scope the service matches orders against.
      param: input.tenantId,
    };
    if (this.options.cid !== null) params.cid = this.options.cid;
    params.sign = easyPaySign(params, this.options.pkey);
    params.sign_type = 'MD5';
    return params;
  }

  private async createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult> {
    if (input.idempotencyReference !== input.localOrderId || input.merchantId !== this.options.pid) {
      throw submissionError('unknown', 'easypay order identity mismatch');
    }
    if (input.currency !== this.options.currency) {
      throw submissionError('unknown', 'easypay order currency is not the merchant settlement currency');
    }
    const parsed = this.parseJson(await this.postForm(`${this.options.apiBase}/mapi.php`, this.createParams(input)));
    if (!codeIsSuccess(parsed.code)) {
      // A business failure is a definitive rejection only when the active
      // requery proves no order exists upstream (contract C-3).
      const query = await this.queryOrder(input.localOrderId);
      if (query.kind === 'not_found') {
        throw submissionError('rejected', `easypay order rejected: ${this.summarize(textField(parsed.msg) ?? '')}`);
      }
      throw submissionError('unknown', 'easypay order acceptance is unknown');
    }
    const tradeNo = textField(parsed.trade_no);
    if (tradeNo === null) {
      // Without a TradeNo, same-order recovery cannot exist; never pretend success.
      throw submissionError('unknown', 'easypay create returned no trade number');
    }
    return {
      providerOrderId: tradeNo,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction: this.buildCheckoutAction(parsed),
    };
  }

  private async refreshCheckout(input: {
    readonly localOrderId: string;
    readonly tenantId: string;
    readonly providerOrderId: string;
    readonly amountMinorUnits: string;
    readonly currency: string;
    readonly merchantId: string;
  }): Promise<PaymentProviderCreateOrderResult> {
    if (input.merchantId !== this.options.pid || input.currency !== this.options.currency) {
      throw submissionError('unknown', 'easypay checkout refresh identity mismatch');
    }
    // Same out_trade_no re-submission: the upstream returns the EXISTING
    // order with a fresh payurl/qrcode; a new charge is never created.
    const parsed = this.parseJson(await this.postForm(`${this.options.apiBase}/mapi.php`, this.createParams(input)));
    if (!codeIsSuccess(parsed.code)) {
      throw submissionError('unknown', 'easypay checkout refresh was not accepted');
    }
    const checkoutAction = this.buildCheckoutAction(parsed);
    if (checkoutAction === undefined) {
      throw submissionError('unknown', 'easypay checkout refresh returned no checkout action');
    }
    return {
      providerOrderId: textField(parsed.trade_no) ?? input.providerOrderId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction,
    };
  }

  private async recoverOrder(
    input: PaymentProviderOrderRecoveryInput,
  ): Promise<PaymentProviderCreateOrderResult | null> {
    if (input.idempotencyReference !== input.localOrderId || input.merchantId !== this.options.pid) {
      throw submissionError('unknown', 'easypay order identity mismatch');
    }
    const query = await this.queryOrder(input.idempotencyReference);
    if (query.kind === 'not_found') return null;
    if (query.kind === 'unknown')
      throw submissionError('unknown', 'easypay order recovery could not confirm the order');
    const recoveredMinor = query.money === null ? null : easyPayYuanToMinorUnits(query.money);
    return {
      providerOrderId: query.tradeNo ?? input.idempotencyReference,
      amountMinorUnits: recoveredMinor === null ? input.amountMinorUnits : recoveredMinor.toString(10),
      currency: this.options.currency,
    };
  }

  private async verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook> {
    if (input.merchantId !== this.options.pid) throw new Error('easypay merchant mismatch');
    let pairs: URLSearchParams;
    try {
      pairs = new URLSearchParams(input.rawBody.toString('utf8'));
    } catch {
      throw new Error('easypay notification is not form-encoded');
    }
    const params: Record<string, string> = {};
    for (const key of new Set(pairs.keys())) {
      params[key] = pairs.get(key) ?? '';
    }
    const sign = params.sign;
    if (typeof sign !== 'string' || sign === '') throw new Error('easypay notification is missing its signature');
    if (!easyPayVerifySign(params, this.options.pkey, sign))
      throw new Error('easypay notification signature is invalid');
    if (textField(params.pid) !== this.options.pid) throw new Error('easypay notification merchant mismatch');
    return {
      providerKey: EASY_PAY_PROVIDER_KEY,
      merchantId: this.options.pid,
      payload: Object.freeze({ ...params }),
    };
  }

  private normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent {
    if (!isRecord(input.payload)) throw new Error('easypay notification payload is invalid');
    const params: Record<string, unknown> = input.payload;
    const outTradeNo = textField(params.out_trade_no);
    if (outTradeNo === null) throw new Error('easypay notification is missing out_trade_no');
    const tradeNo = textField(params.trade_no);
    const tradeStatus = textField(params.trade_status);
    const moneyMinor = easyPayYuanToMinorUnits(textField(params.money) ?? '');
    if (moneyMinor === null) throw new Error('easypay notification money is invalid');
    const tenantId = textField(params.param) ?? UNRESOLVED_TENANT;
    const notifyTime = textField(params.notify_time);
    const parsedNotifyTime = notifyTime === null ? null : new Date(notifyTime.replace(' ', 'T'));
    return {
      providerEventId: `${tradeNo ?? outTradeNo}:${tradeStatus ?? 'unknown'}`,
      eventType: 'payment.notify',
      providerOrderId: tradeNo ?? outTradeNo,
      tenantId,
      merchantId: this.options.pid,
      status: tradeStatus === EASY_PAY_TRADE_STATUS_SUCCESS ? 'succeeded' : 'pending',
      amountMinorUnits: moneyMinor.toString(10),
      currency: this.options.currency,
      occurredAt:
        parsedNotifyTime !== null && Number.isFinite(parsedNotifyTime.getTime())
          ? parsedNotifyTime
          : this.options.now(),
    };
  }

  /**
   * The C-3 fulfillment red line: a signed webhook alone never fulfills. The
   * active requery must confirm the same out_trade_no, TRADE_SUCCESS, the
   * order amount and a consistent trade number.
   */
  private async confirmEvent(input: PaymentProviderEventConfirmationInput): Promise<PaymentProviderEventConfirmation> {
    if (input.order.currency !== this.options.currency) {
      return { confirmed: false, code: 'EASYPAY_CURRENCY_MISMATCH' };
    }
    const query = await this.queryOrder(input.order.localOrderId);
    if (query.kind === 'unknown') {
      // The requery itself is unproven: retryable, never reconciliation.
      throw submissionError('unknown', 'easypay order confirmation could not reach the provider');
    }
    if (query.kind === 'not_found') return { confirmed: false, code: 'EASYPAY_ORDER_NOT_FOUND' };
    const paid =
      query.tradeStatus === EASY_PAY_TRADE_STATUS_SUCCESS || (query.tradeStatus === null && query.statusCode === 1);
    if (!paid) return { confirmed: false, code: 'EASYPAY_TRADE_NOT_SUCCESS' };
    const queryMinor = query.money === null ? null : easyPayYuanToMinorUnits(query.money);
    if (queryMinor === null || queryMinor.toString(10) !== input.order.amountMinorUnits) {
      return { confirmed: false, code: 'EASYPAY_AMOUNT_MISMATCH' };
    }
    if (queryMinor.toString(10) !== String(input.event.amountMinorUnits)) {
      return { confirmed: false, code: 'EASYPAY_AMOUNT_MISMATCH' };
    }
    if (
      query.tradeNo !== null &&
      ((input.order.providerOrderId !== null && query.tradeNo !== input.order.providerOrderId) ||
        (input.event.providerOrderId !== input.order.localOrderId && query.tradeNo !== input.event.providerOrderId))
    ) {
      return { confirmed: false, code: 'EASYPAY_TRADE_NO_MISMATCH' };
    }
    return { confirmed: true };
  }

  private async submitRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundResult> {
    if (input.providerKey !== EASY_PAY_PROVIDER_KEY || input.merchantId !== this.options.pid) {
      throw submissionError('unknown', 'easypay refund identity mismatch');
    }
    if (input.idempotencyReference !== input.localRefundId) {
      throw submissionError('unknown', 'easypay refund idempotency reference mismatch');
    }
    const money = easyPayMinorUnitsToYuan(input.amountMinorUnits);
    const attempts: ReadonlyArray<{ readonly field: 'out_trade_no' | 'trade_no'; readonly value: string }> = [
      { field: 'out_trade_no', value: input.originalLocalOrderId },
      ...(input.providerOrderId !== null && input.providerOrderId !== input.originalLocalOrderId
        ? [{ field: 'trade_no' as const, value: input.providerOrderId }]
        : []),
    ];
    let lastNotFoundMessage: string | null = null;
    for (const attempt of attempts) {
      // Upstream protocol: the refund call is UNSIGNED with a plaintext pkey.
      const response = await this.postForm(`${this.options.apiBase}/api.php?act=refund`, {
        pid: this.options.pid,
        key: this.options.pkey,
        money,
        [attempt.field]: attempt.value,
      });
      let parsed: Record<string, unknown>;
      try {
        parsed = this.parseJson(response);
      } catch (error) {
        if (error instanceof EasyPayProviderError)
          throw submissionError('unknown', 'easypay refund acceptance is unknown');
        throw error;
      }
      if (codeIsSuccess(parsed.code)) {
        return {
          localRefundId: input.localRefundId,
          idempotencyReference: input.idempotencyReference,
          tenantId: input.tenantId,
          originalLocalOrderId: input.originalLocalOrderId,
          providerKey: input.providerKey,
          merchantId: input.merchantId,
          providerOrderId: input.providerOrderId,
          amountMinorUnits: input.amountMinorUnits,
          currency: input.currency,
          providerRefundId: attempt.value,
          status: 'pending',
        };
      }
      const message = textField(parsed.msg) ?? '';
      if (this.isOrderNotFound(message)) {
        lastNotFoundMessage = message;
        continue;
      }
      // A definitive business rejection: the upstream answered the refund call.
      throw submissionError('not_accepted', `easypay refund rejected: ${this.summarize(message)}`);
    }
    throw submissionError(
      'not_accepted',
      `easypay refund order is unknown to the provider: ${this.summarize(lastNotFoundMessage ?? '')}`,
    );
  }

  private isOrderNotFound(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      message.includes('订单编号不存在') ||
      message.includes('订单不存在') ||
      lower.includes('order not found') ||
      lower.includes('not exist')
    );
  }

  /** EasyPay has no refund-query API: always unknown, never a fabricated verdict. */
  private queryRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult> {
    return Promise.resolve({
      localRefundId: input.localRefundId,
      idempotencyReference: input.idempotencyReference,
      tenantId: input.tenantId,
      originalLocalOrderId: input.originalLocalOrderId,
      providerKey: input.providerKey,
      merchantId: input.merchantId,
      providerOrderId: input.providerOrderId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      providerRefundId: input.providerRefundId,
      status: 'unknown',
    });
  }
}

export function createEasyPayPaymentProvider(input: EasyPayProviderConfigInput): EasyPayPaymentProvider {
  return new EasyPayPaymentProvider(parseEasyPayProviderConfig(input));
}
