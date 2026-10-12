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
  ALIPAY_API_VERSION,
  ALIPAY_CHARSET,
  ALIPAY_CODE_SUCCESS,
  ALIPAY_FUND_CHANGE_YES,
  ALIPAY_GATEWAY_PATH,
  ALIPAY_METHOD_PRECREATE,
  ALIPAY_METHOD_QUERY,
  ALIPAY_METHOD_REFUND,
  ALIPAY_METHOD_REFUND_QUERY,
  ALIPAY_PROVIDER_KEY,
  ALIPAY_REFUND_STATUS_SUCCESS,
  ALIPAY_SIGN_TYPE,
  ALIPAY_SUB_CODE_REFUND_NOT_EXIST,
  ALIPAY_SUB_CODE_TRADE_NOT_EXIST,
  ALIPAY_TRADE_CLOSED,
  ALIPAY_TRADE_FINISHED,
  ALIPAY_TRADE_SUCCESS,
  type AlipayProviderConfigInput,
  type AlipayProviderOptions,
  alipayCanonicalJson,
  alipayConstantTimeEqual,
  alipayMinorUnitsToYuan,
  alipayRequestSignContent,
  alipayRsa2Sign,
  alipayTimestamp,
  alipayYuanToMinorUnits,
  parseAlipayProviderConfig,
  verifyAlipayNotificationSignature,
} from './protocol.js';

// Alipay adapter (R3 checklist): server-direct `alipay.trade.precreate` only,
// RSA2 request signing, and the fulfillment red line — an RSA2-verified async
// notification alone never fulfills; an active alipay.trade.query must
// reconfirm out_trade_no + TRADE_SUCCESS/FINISHED + amount/currency/trade_no
// consistency. Order identity is the out_trade_no (= localOrderId): precreate
// answers carry no trade_no (the trade only exists once the buyer scans), so
// the stored provider order id and the normalized event both anchor on
// out_trade_no, while the notify's trade_no rides the providerEventId as a
// consistency anchor for confirmEvent. Refunds use alipay.trade.refund with
// `out_request_no = localRefundId` as the natural idempotency key and the REAL
// alipay.trade.fastpay.refund.query tri-state, proving the refund port
// abstraction for a full-capability PSP (Stripe analogue, unlike EasyPay's
// permanent unknown).
//
// SSRF posture: every call is a POST form to the single configured gateway
// path with redirect:error, an AbortSignal timeout and a bounded response.
// The private key never crosses the module boundary: the provider holds only
// the frozen KeyObject; error summaries carry upstream business text only.

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_UPSTREAM_MESSAGE = 512;
const MAX_SUBJECT_BYTES = 256;
const MAX_PASSBACK_BYTES = 512;
const UNRESOLVED_TENANT = 'unresolved-tenant';
const UNPAID_EVENT_ANCHOR = 'open';
const REFUND_FAILED_STATUSES: ReadonlySet<string> = new Set(['REFUND_FAIL', 'REFUND_FAILED', 'REFUND_CLOSED']);

export type AlipaySubmissionAcceptance = PaymentProviderSubmissionErrorDetails;

/** Adapter errors carry the structural acceptance details the payment service reads off the thrown object. */
export class AlipayProviderError extends Error {
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
    this.name = 'AlipayProviderError';
    this.acceptance = details.acceptance;
    if (details.retryable !== undefined) this.retryable = details.retryable;
    if (details.safeToRetry !== undefined) this.safeToRetry = details.safeToRetry;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function submissionError(acceptance: 'rejected' | 'not_accepted' | 'unknown', message: string): AlipayProviderError {
  return new AlipayProviderError(message, { acceptance });
}

interface AlipayHttpResponse {
  readonly status: number;
  readonly body: string;
}

type AlipayTradeQuery =
  | {
      readonly kind: 'found';
      readonly outTradeNo: string;
      readonly tradeNo: string | null;
      readonly tradeStatus: string | null;
      readonly totalAmount: string | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unknown' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export class AlipayPaymentProvider {
  readonly adapter: PaymentProviderAdapter;
  readonly refundAdapter: PaymentProviderRefundAdapter;
  /** The merchant PEM and its bare base64 body, redacted from every upstream-derived error summary. */
  private readonly redactedSecrets: readonly string[];

  constructor(private readonly options: AlipayProviderOptions) {
    this.redactedSecrets = Object.freeze([
      options.merchantPrivateKeyPem,
      options.merchantPrivateKeyPem
        .split('\n')
        .filter((line) => !line.startsWith('-----'))
        .join(''),
    ]);
    this.adapter = Object.freeze({
      providerKey: ALIPAY_PROVIDER_KEY,
      createOrder: (input) => this.createOrder(input),
      recoverOrder: (input) => this.recoverOrder(input),
      verifyWebhook: (input) => this.verifyWebhook(input),
      normalizeEvent: (input) => this.normalizeEvent(input),
      confirmEvent: (input) => this.confirmEvent(input),
    } satisfies PaymentProviderAdapter);
    this.refundAdapter = Object.freeze({
      providerKey: ALIPAY_PROVIDER_KEY,
      merchantId: options.appId,
      submitRefund: (input) => this.submitRefund(input),
      queryRefund: (input) => this.queryRefund(input),
    } satisfies PaymentProviderRefundAdapter);
  }

  /** Bounded, whitespace-collapsed upstream business text with every merchant key echo redacted. */
  private summarize(text: string): string {
    let summary = text;
    for (const secret of this.redactedSecrets) {
      if (secret !== '') summary = summary.replaceAll(secret, '***');
    }
    summary = summary.replace(/\s+/g, ' ').trim();
    if (summary.length > MAX_UPSTREAM_MESSAGE) summary = `${summary.slice(0, MAX_UPSTREAM_MESSAGE)}...`;
    return summary === '' ? '<empty>' : summary;
  }

  /**
   * Signed gateway call: common params + canonical biz_content, RSA2 request
   * signature over the sorted content (sign excluded, sign_type included per
   * the Alipay request rule), POST form to the fixed gateway path.
   */
  private async callApi(
    method: string,
    bizContent: Readonly<Record<string, unknown>>,
    options: { readonly withCheckoutUrls?: boolean } = {},
  ): Promise<AlipayHttpResponse> {
    const params: Record<string, string> = {
      app_id: this.options.appId,
      method,
      format: 'JSON',
      charset: ALIPAY_CHARSET,
      sign_type: ALIPAY_SIGN_TYPE,
      timestamp: alipayTimestamp(this.options.now()),
      version: ALIPAY_API_VERSION,
      biz_content: alipayCanonicalJson(bizContent),
    };
    if (options.withCheckoutUrls === true) {
      params.notify_url = this.options.notifyUrl;
      params.return_url = this.options.returnUrl;
    }
    params.sign = alipayRsa2Sign(alipayRequestSignContent(params), this.options.merchantPrivateKey);
    let response: Response;
    try {
      response = await this.options.fetchImpl(`${this.options.gateway}${ALIPAY_GATEWAY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      throw submissionError('unknown', 'alipay request failed');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw submissionError('unknown', 'alipay response could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw submissionError('unknown', 'alipay response is too large');
    }
    return { status: response.status, body: text };
  }

  /** Parses a 2xx envelope and returns the `<method>_response` node; anything else is unknown-acceptance. */
  private parseResponseNode(method: string, response: AlipayHttpResponse): Record<string, unknown> {
    if (response.status < 200 || response.status >= 300) {
      throw submissionError('unknown', `alipay answered HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw submissionError('unknown', 'alipay response is not valid JSON');
    }
    if (!isRecord(parsed)) throw submissionError('unknown', 'alipay response envelope is invalid');
    const node = parsed[`${method.replaceAll('.', '_')}_response`];
    if (!isRecord(node)) throw submissionError('unknown', 'alipay response node is missing');
    return node;
  }

  /** Active trade requery by out_trade_no; the fulfillment red line and create acceptance depend on this tri-state. */
  private async queryTrade(outTradeNo: string): Promise<AlipayTradeQuery> {
    let node: Record<string, unknown>;
    try {
      node = this.parseResponseNode(
        ALIPAY_METHOD_QUERY,
        await this.callApi(ALIPAY_METHOD_QUERY, { out_trade_no: outTradeNo }),
      );
    } catch {
      return { kind: 'unknown' };
    }
    if (textField(node.code) !== ALIPAY_CODE_SUCCESS) {
      return textField(node.sub_code) === ALIPAY_SUB_CODE_TRADE_NOT_EXIST ? { kind: 'not_found' } : { kind: 'unknown' };
    }
    const echo = textField(node.out_trade_no);
    if (echo === null || echo !== outTradeNo) return { kind: 'unknown' };
    return {
      kind: 'found',
      outTradeNo: echo,
      tradeNo: textField(node.trade_no),
      tradeStatus: textField(node.trade_status),
      totalAmount: textField(node.total_amount),
    };
  }

  private wireAmount(amountMinorUnits: string): string {
    try {
      return alipayMinorUnitsToYuan(amountMinorUnits);
    } catch {
      throw submissionError('unknown', 'alipay amount must be a minor-units integer string');
    }
  }

  private assertOrderIdentity(input: {
    readonly localOrderId: string;
    readonly idempotencyReference: string;
    readonly merchantId: string;
    readonly currency: string;
  }): void {
    if (input.idempotencyReference !== input.localOrderId || input.merchantId !== this.options.appId) {
      throw submissionError('unknown', 'alipay order identity mismatch');
    }
    if (input.currency !== this.options.currency) {
      throw submissionError('unknown', 'alipay order currency is not the merchant settlement currency');
    }
  }

  private createBizContent(input: {
    readonly localOrderId: string;
    readonly tenantId: string;
    readonly amountMinorUnits: string;
  }): Record<string, unknown> {
    return {
      out_trade_no: input.localOrderId,
      total_amount: this.wireAmount(input.amountMinorUnits),
      subject: `Order ${input.localOrderId}`.slice(0, MAX_SUBJECT_BYTES),
      // extend_params records the tenant on the trade per the R3 brief; the
      // gateway does NOT echo extend_params in notifications, so the notify-
      // verifiable tenant pass-through rides passback_params (echoed verbatim).
      extend_params: { tenant_id: input.tenantId },
      passback_params: input.tenantId.slice(0, MAX_PASSBACK_BYTES),
    };
  }

  private async createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult> {
    this.assertOrderIdentity(input);
    const node = this.parseResponseNode(
      ALIPAY_METHOD_PRECREATE,
      await this.callApi(ALIPAY_METHOD_PRECREATE, this.createBizContent(input), { withCheckoutUrls: true }),
    );
    if (textField(node.code) !== ALIPAY_CODE_SUCCESS) {
      // A business failure is a definitive rejection only when the active
      // requery proves no trade exists upstream (R3 acceptance tri-state).
      const query = await this.queryTrade(input.localOrderId);
      if (query.kind === 'not_found') {
        throw submissionError('rejected', `alipay order rejected: ${this.summarize(textField(node.sub_msg) ?? '')}`);
      }
      throw submissionError('unknown', 'alipay order acceptance is unknown');
    }
    const echo = textField(node.out_trade_no);
    if (echo === null || echo !== input.localOrderId) {
      throw submissionError('unknown', 'alipay precreate out_trade_no echo mismatch');
    }
    const qrCode = textField(node.qr_code);
    if (qrCode === null) {
      // Without a checkout payload the customer cannot pay; never pretend success.
      throw submissionError('unknown', 'alipay precreate returned no qr_code');
    }
    const expiresAt = new Date(this.options.now().getTime() + this.options.checkoutTtlMs).toISOString();
    const checkoutAction: PaymentCheckoutAction = { kind: 'qr', text: qrCode, expiresAt };
    return {
      providerOrderId: echo,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction,
    };
  }

  /**
   * Same-order recovery by out_trade_no only: a missing trade answers null and
   * recovery NEVER creates a second precreate. The recovered identity stays the
   * out_trade_no so webhook matching keeps its precreate anchor (the trade_no
   * is only cross-checked inside confirmEvent).
   */
  private async recoverOrder(
    input: PaymentProviderOrderRecoveryInput,
  ): Promise<PaymentProviderCreateOrderResult | null> {
    this.assertOrderIdentity(input);
    const query = await this.queryTrade(input.idempotencyReference);
    if (query.kind === 'not_found') return null;
    if (query.kind === 'unknown') {
      throw submissionError('unknown', 'alipay order recovery could not confirm the trade');
    }
    const recoveredMinor = query.totalAmount === null ? null : alipayYuanToMinorUnits(query.totalAmount);
    return {
      providerOrderId: query.outTradeNo,
      amountMinorUnits: recoveredMinor === null ? input.amountMinorUnits : recoveredMinor.toString(10),
      currency: this.options.currency,
    };
  }

  private async verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook> {
    if (input.merchantId !== this.options.appId) throw new Error('alipay merchant mismatch');
    let pairs: URLSearchParams;
    try {
      pairs = new URLSearchParams(input.rawBody.toString('utf8'));
    } catch {
      throw new Error('alipay notification is not form-encoded');
    }
    const params: Record<string, string> = {};
    for (const key of new Set(pairs.keys())) {
      params[key] = pairs.get(key) ?? '';
    }
    if (!verifyAlipayNotificationSignature(params, this.options.alipayPublicKey)) {
      throw new Error('alipay notification signature is invalid');
    }
    const appId = textField(params.app_id);
    if (appId === null || !alipayConstantTimeEqual(appId, this.options.appId)) {
      throw new Error('alipay notification app_id mismatch');
    }
    const sellerId = textField(params.seller_id);
    if (sellerId === null || !alipayConstantTimeEqual(sellerId, this.options.sellerId)) {
      throw new Error('alipay notification seller_id mismatch');
    }
    return {
      providerKey: ALIPAY_PROVIDER_KEY,
      merchantId: this.options.appId,
      payload: Object.freeze({ ...params }),
    };
  }

  private normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent {
    if (!isRecord(input.payload)) throw new Error('alipay notification payload is invalid');
    const params: Record<string, unknown> = input.payload;
    const outTradeNo = textField(params.out_trade_no);
    if (outTradeNo === null) throw new Error('alipay notification is missing out_trade_no');
    const notifyId = textField(params.notify_id);
    if (notifyId === null) throw new Error('alipay notification is missing notify_id');
    const tradeStatus = textField(params.trade_status);
    if (tradeStatus === null) throw new Error('alipay notification is missing trade_status');
    const amountMinor = alipayYuanToMinorUnits(textField(params.total_amount) ?? '');
    if (amountMinor === null) throw new Error('alipay notification total_amount is invalid');
    const tradeNo = textField(params.trade_no);
    const tenantId = textField(params.passback_params) ?? UNRESOLVED_TENANT;
    const paidAt = textField(params.gmt_payment) ?? textField(params.gmt_create);
    const parsedPaidAt = paidAt === null ? null : new Date(`${paidAt.replace(' ', 'T')}+08:00`);
    const status =
      tradeStatus === ALIPAY_TRADE_SUCCESS || tradeStatus === ALIPAY_TRADE_FINISHED
        ? 'succeeded'
        : tradeStatus === ALIPAY_TRADE_CLOSED
          ? 'failed'
          : 'pending';
    return {
      // Triple-anchored identity: the unique notify id plus the order anchor
      // and the trade number. The trade_no segment is the notify↔query
      // consistency anchor confirmEvent cross-checks.
      providerEventId: `${notifyId}:${outTradeNo}:${tradeNo ?? UNPAID_EVENT_ANCHOR}`,
      eventType: `alipay.trade.notify.${tradeStatus}`,
      // The stored provider order id is the out_trade_no (precreate identity),
      // so the normalized event must anchor on it for order matching.
      providerOrderId: outTradeNo,
      tenantId,
      merchantId: this.options.appId,
      status,
      amountMinorUnits: amountMinor.toString(10),
      currency: this.options.currency,
      occurredAt: parsedPaidAt !== null && Number.isFinite(parsedPaidAt.getTime()) ? parsedPaidAt : this.options.now(),
    };
  }

  /**
   * The R3 fulfillment red line: an RSA2-verified notification alone never
   * fulfills. The active alipay.trade.query must confirm the same
   * out_trade_no, TRADE_SUCCESS/TRADE_FINISHED, the order amount and currency,
   * and a trade_no consistent with both the notify anchor and any stored
   * provider order id. An unreachable query throws (retryable claim), never
   * reconciliation.
   */
  private async confirmEvent(input: PaymentProviderEventConfirmationInput): Promise<PaymentProviderEventConfirmation> {
    if (input.order.currency !== this.options.currency || input.event.currency !== this.options.currency) {
      return { confirmed: false, code: 'ALIPAY_CURRENCY_MISMATCH' };
    }
    const query = await this.queryTrade(input.order.localOrderId);
    if (query.kind === 'unknown') {
      throw submissionError('unknown', 'alipay trade confirmation could not reach the provider');
    }
    if (query.kind === 'not_found') return { confirmed: false, code: 'ALIPAY_TRADE_NOT_FOUND' };
    if (query.outTradeNo !== input.order.localOrderId) {
      return { confirmed: false, code: 'ALIPAY_ORDER_REF_MISMATCH' };
    }
    if (query.tradeStatus !== ALIPAY_TRADE_SUCCESS && query.tradeStatus !== ALIPAY_TRADE_FINISHED) {
      return { confirmed: false, code: 'ALIPAY_TRADE_NOT_SUCCESS' };
    }
    const queryMinor = query.totalAmount === null ? null : alipayYuanToMinorUnits(query.totalAmount);
    if (
      queryMinor === null ||
      queryMinor.toString(10) !== input.order.amountMinorUnits ||
      queryMinor.toString(10) !== String(input.event.amountMinorUnits)
    ) {
      return { confirmed: false, code: 'ALIPAY_AMOUNT_MISMATCH' };
    }
    if (query.tradeNo === null) {
      return { confirmed: false, code: 'ALIPAY_TRADE_NO_MISMATCH' };
    }
    const segments = input.event.providerEventId.split(':');
    const notifyTradeNo = segments.length === 3 && segments[2] !== UNPAID_EVENT_ANCHOR ? (segments[2] as string) : null;
    if (notifyTradeNo !== null && query.tradeNo !== notifyTradeNo) {
      return { confirmed: false, code: 'ALIPAY_TRADE_NO_MISMATCH' };
    }
    if (
      input.order.providerOrderId !== null &&
      input.order.providerOrderId !== input.order.localOrderId &&
      query.tradeNo !== input.order.providerOrderId
    ) {
      return { confirmed: false, code: 'ALIPAY_TRADE_NO_MISMATCH' };
    }
    return { confirmed: true };
  }

  private assertRefundIdentity(input: PaymentProviderRefundInput): void {
    if (input.providerKey !== ALIPAY_PROVIDER_KEY || input.merchantId !== this.options.appId) {
      throw submissionError('unknown', 'alipay refund identity mismatch');
    }
    if (input.idempotencyReference !== input.localRefundId) {
      throw submissionError('unknown', 'alipay refund idempotency reference mismatch');
    }
    if (input.currency !== this.options.currency) {
      throw submissionError('unknown', 'alipay refund currency mismatch');
    }
  }

  private refundEcho(input: PaymentProviderRefundInput) {
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
    };
  }

  /**
   * alipay.trade.refund with `out_request_no = localRefundId` as the natural
   * idempotency key. fund_change=Y is a proven success; fund_change=N (the
   * idempotent-replay / asynchronous shape) stays provisional pending and the
   * real refund query resolves it — never a self-finalizing verdict. A
   * business answer of ACQ.TRADE_NOT_EXIST is the only definitive rejection.
   */
  private async submitRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundResult> {
    this.assertRefundIdentity(input);
    const refundAmount = this.wireAmount(input.amountMinorUnits);
    const node = this.parseResponseNode(
      ALIPAY_METHOD_REFUND,
      await this.callApi(ALIPAY_METHOD_REFUND, {
        out_trade_no: input.originalLocalOrderId,
        refund_amount: refundAmount,
        out_request_no: input.idempotencyReference,
      }),
    );
    if (textField(node.code) !== ALIPAY_CODE_SUCCESS) {
      if (textField(node.sub_code) === ALIPAY_SUB_CODE_TRADE_NOT_EXIST) {
        throw submissionError(
          'not_accepted',
          `alipay refund rejected: ${this.summarize(textField(node.sub_msg) ?? '')}`,
        );
      }
      throw submissionError('unknown', 'alipay refund acceptance is unknown');
    }
    const echoOrder = textField(node.out_trade_no);
    if (echoOrder === null || echoOrder !== input.originalLocalOrderId) {
      throw submissionError('unknown', 'alipay refund out_trade_no echo mismatch');
    }
    const fundChange = textField(node.fund_change);
    if (fundChange === null) {
      throw submissionError('unknown', 'alipay refund returned no fund_change');
    }
    const refundFee = textField(node.refund_fee);
    if (refundFee !== null) {
      const feeMinor = alipayYuanToMinorUnits(refundFee);
      if (feeMinor === null || feeMinor.toString(10) !== input.amountMinorUnits) {
        throw submissionError('unknown', 'alipay refund refund_fee echo mismatch');
      }
    }
    return {
      ...this.refundEcho(input),
      providerRefundId: input.idempotencyReference,
      status: fundChange === ALIPAY_FUND_CHANGE_YES ? 'succeeded' : 'pending',
    };
  }

  /**
   * Real refund query tri-state (the R3 core value):
   * alipay.trade.fastpay.refund.query by out_trade_no + out_request_no maps
   * REFUND_SUCCESS → succeeded, a recognized terminal-failure status → failed,
   * a success envelope without a refund status → pending, ACQ.REFUND_NOT_EXIST
   * → not_found, and anything unproven (transport, echo drift, unrecognized
   * status) stays unknown — never a fabricated verdict.
   */
  private async queryRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult> {
    const unknownResult: PaymentProviderRefundQueryResult = {
      ...this.refundEcho(input),
      providerRefundId: input.providerRefundId,
      status: 'unknown',
    };
    if (input.providerKey !== ALIPAY_PROVIDER_KEY || input.merchantId !== this.options.appId) {
      return unknownResult;
    }
    if (input.providerRefundId !== null && input.providerRefundId !== input.idempotencyReference) {
      return unknownResult;
    }
    let node: Record<string, unknown>;
    try {
      node = this.parseResponseNode(
        ALIPAY_METHOD_REFUND_QUERY,
        await this.callApi(ALIPAY_METHOD_REFUND_QUERY, {
          out_trade_no: input.originalLocalOrderId,
          out_request_no: input.idempotencyReference,
        }),
      );
    } catch {
      return unknownResult;
    }
    if (textField(node.code) !== ALIPAY_CODE_SUCCESS) {
      if (textField(node.sub_code) === ALIPAY_SUB_CODE_REFUND_NOT_EXIST) {
        return { ...unknownResult, status: 'not_found' };
      }
      return unknownResult;
    }
    if (
      textField(node.out_request_no) !== input.idempotencyReference ||
      textField(node.out_trade_no) !== input.originalLocalOrderId
    ) {
      return unknownResult;
    }
    const refundMinor = alipayYuanToMinorUnits(textField(node.refund_amount) ?? '');
    if (refundMinor === null || refundMinor.toString(10) !== input.amountMinorUnits) {
      return unknownResult;
    }
    const refundStatus = textField(node.refund_status);
    if (refundStatus === null) return { ...unknownResult, status: 'pending' };
    if (refundStatus === ALIPAY_REFUND_STATUS_SUCCESS) return { ...unknownResult, status: 'succeeded' };
    if (REFUND_FAILED_STATUSES.has(refundStatus)) return { ...unknownResult, status: 'failed' };
    return unknownResult;
  }
}

export function createAlipayPaymentProvider(input: AlipayProviderConfigInput): AlipayPaymentProvider {
  return new AlipayPaymentProvider(parseAlipayProviderConfig(input));
}
