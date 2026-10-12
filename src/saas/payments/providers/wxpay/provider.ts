import { randomBytes } from 'node:crypto';
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
  PaymentWebhookHeaders,
  VerifiedPaymentProviderWebhook,
} from '../../types.js';
import {
  buildWxpayAuthorization,
  decryptWxpayAesGcm,
  parseWxpayPlatformCertificate,
  parseWxpayProviderConfig,
  signWxpayRequest,
  verifyWxpayNotificationSignature,
  WXPAY_AEAD_ALGORITHM,
  WXPAY_PROVIDER_KEY,
  type WxpayPlatformCertificate,
  type WxpayProviderConfigInput,
  type WxpayProviderOptions,
  wxpayAmountToMinorUnits,
  wxpayMinorUnitsToWire,
  wxpayOutTradeNo,
  wxpayRefundStatusToTriState,
  wxpayTradeStateToEventStatus,
} from './protocol.js';

// WeChat Pay v3 adapter (R3 review checklist, native prepay only). Requests
// are WECHATPAY2-SHA256-RSA2048 merchant-signed; notifications are verified
// against the platform certificate (fetched from /v3/certificates, decrypted
// under the apiV3Key, cached by serial) and their resource is AES-256-GCM
// decrypted before normalization. The fulfillment red line mirrors Stripe: a
// verified + decrypted notification alone NEVER fulfills — an active
// out-trade-no query must confirm the same out_trade_no, mchid, tenant attach,
// trade_state=SUCCESS and the exact fen amount. Refunds use the domestic
// refunds API with out_refund_no = localRefundId (native idempotency) and a
// REAL refund query tri-state by that same reference.
//
// Order identity: native prepay returns only code_url (no transaction_id
// before payment), so the provider order id IS the out_trade_no — locally
// recoverable via wxpayOutTradeNo for uuid-shaped local ids. The tenant scope
// rides the WeChat `attach` pass-through field and is rechecked on every
// active query. Secret custody: the merchant private key and apiV3Key are
// parsed/frozen at configuration, never leave this module, and are redacted
// from any upstream error text.

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_UPSTREAM_MESSAGE = 512;
const MAX_CODE_URL_BYTES = 512;
const UNRESOLVED_TENANT = 'unresolved-tenant';
const CODE_URL_PATTERN = /^weixin:\/\/[\x21-\x7e]{1,512}$/;

export type WxpaySubmissionAcceptance = PaymentProviderSubmissionErrorDetails;

/** Adapter errors carry the structural acceptance details the payment service reads off the thrown object. */
export class WxpayProviderError extends Error {
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
    this.name = 'WxpayProviderError';
    this.acceptance = details.acceptance;
    if (details.retryable !== undefined) this.retryable = details.retryable;
    if (details.safeToRetry !== undefined) this.safeToRetry = details.safeToRetry;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function submissionError(acceptance: 'rejected' | 'not_accepted' | 'unknown', message: string): WxpayProviderError {
  return new WxpayProviderError(message, { acceptance });
}

interface WxpayHttpResponse {
  readonly status: number;
  readonly body: string;
}

interface WxpayErrorPayload {
  readonly code: string | null;
  readonly message: string | null;
}

interface WxpayTransactionFound {
  readonly kind: 'found';
  readonly mchid: string | null;
  readonly outTradeNo: string | null;
  readonly transactionId: string | null;
  readonly tradeState: string | null;
  readonly amountMinorUnits: string | null;
  readonly currency: string | null;
  readonly attach: string | null;
}

type WxpayTransactionQuery = WxpayTransactionFound | { readonly kind: 'not_found' } | { readonly kind: 'unknown' };

/** Decrypted transaction resource + the verified notification envelope the normalizer maps. */
interface WxpayVerifiedPayload {
  readonly notification: {
    readonly id: string;
    readonly eventType: string;
    readonly createTime: string | null;
  };
  readonly transaction: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseWxpayError(body: string): WxpayErrorPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return null;
    return { code: textField(parsed.code), message: textField(parsed.message) };
  } catch {
    return null;
  }
}

function webhookHeader(headers: PaymentWebhookHeaders, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' && value[0] !== undefined) {
      return value[0];
    }
    return null;
  }
  return null;
}

/** JSON string field serializer: every interpolated value is a quoted JSON string or a pre-validated digit token. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}

export class WxpayPaymentProvider {
  readonly adapter: PaymentProviderAdapter;
  readonly refundAdapter: PaymentProviderRefundAdapter;

  private readonly platformCertificates = new Map<string, WxpayPlatformCertificate>();
  private certificateRefresh: Promise<void> | null = null;
  /** apiV3Key in text form, retained ONLY for redaction of upstream error text; never sent on the wire. */
  private readonly apiV3KeyText: string;

  constructor(private readonly options: WxpayProviderOptions) {
    this.apiV3KeyText = options.apiV3Key.toString('utf8');
    this.adapter = Object.freeze({
      providerKey: WXPAY_PROVIDER_KEY,
      createOrder: (input) => this.createOrder(input),
      recoverOrder: (input) => this.recoverOrder(input),
      verifyWebhook: (input) => this.verifyWebhook(input),
      normalizeEvent: (input) => this.normalizeEvent(input),
      confirmEvent: (input) => this.confirmEvent(input),
    } satisfies PaymentProviderAdapter);
    this.refundAdapter = Object.freeze({
      providerKey: WXPAY_PROVIDER_KEY,
      merchantId: options.mchid,
      submitRefund: (input) => this.submitRefund(input),
      queryRefund: (input) => this.queryRefund(input),
    } satisfies PaymentProviderRefundAdapter);
  }

  /** Redacts the apiV3Key from upstream text before it can reach logs; the private key never crosses the wire. */
  private summarize(text: string): string {
    let summary = text.replaceAll(this.apiV3KeyText, '***').replace(/\s+/g, ' ').trim();
    if (summary.length > MAX_UPSTREAM_MESSAGE) summary = `${summary.slice(0, MAX_UPSTREAM_MESSAGE)}...`;
    return summary === '' ? '<empty>' : summary;
  }

  /** Merchant-signed v3 request. `pathWithQuery` is exactly what the signature covers. */
  private async request(method: 'GET' | 'POST', pathWithQuery: string, body: string): Promise<WxpayHttpResponse> {
    const timestamp = Math.floor(this.options.now().getTime() / 1000).toString(10);
    const nonce = randomBytes(16).toString('hex');
    const signature = signWxpayRequest({
      method,
      urlPath: pathWithQuery,
      timestamp,
      nonce,
      body,
      privateKey: this.options.merchantPrivateKey,
    });
    const authorization = buildWxpayAuthorization({
      mchid: this.options.mchid,
      serialNo: this.options.merchantSerialNo,
      nonce,
      timestamp,
      signature,
    });
    let response: Response;
    try {
      response = await this.options.fetchImpl(`${this.options.gateway}${pathWithQuery}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      throw submissionError('unknown', 'wxpay request failed');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw submissionError('unknown', 'wxpay response could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw submissionError('unknown', 'wxpay response is too large');
    }
    return { status: response.status, body: text };
  }

  /** Parses a 2xx JSON object body; anything else is an unknown-acceptance failure. */
  private parseRecord(response: WxpayHttpResponse): Record<string, unknown> {
    if (response.status < 200 || response.status >= 300) {
      throw submissionError('unknown', `wxpay answered HTTP ${response.status}`);
    }
    try {
      const parsed: unknown = JSON.parse(response.body);
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch (error) {
      if (error instanceof WxpayProviderError) throw error;
      throw submissionError('unknown', 'wxpay response is not valid JSON');
    }
  }

  /**
   * Active order query by out_trade_no; the create acceptance tri-state, the
   * fulfillment red line, recovery and the refund order-total lookup all
   * depend on this tri-state. A 404 is the ONLY definitive not-found signal.
   */
  private async queryTransaction(outTradeNo: string): Promise<WxpayTransactionQuery> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${this.options.mchid}`;
    let response: WxpayHttpResponse;
    try {
      response = await this.request('GET', path, '');
    } catch {
      return { kind: 'unknown' };
    }
    if (response.status === 404) return { kind: 'not_found' };
    let parsed: Record<string, unknown>;
    try {
      parsed = this.parseRecord(response);
    } catch {
      return { kind: 'unknown' };
    }
    const amount = isRecord(parsed.amount) ? parsed.amount : null;
    return {
      kind: 'found',
      mchid: textField(parsed.mchid),
      outTradeNo: textField(parsed.out_trade_no),
      transactionId: textField(parsed.transaction_id),
      tradeState: textField(parsed.trade_state),
      amountMinorUnits: amount === null ? null : wxpayAmountToMinorUnits(amount.total),
      currency: amount === null ? null : (textField(amount.currency)?.toUpperCase() ?? null),
      attach: textField(parsed.attach),
    };
  }

  private wireAmount(amountMinorUnits: string): string {
    try {
      return wxpayMinorUnitsToWire(amountMinorUnits);
    } catch {
      throw submissionError('unknown', 'wxpay amount must be a minor-units integer string');
    }
  }

  private assertOrderIdentity(input: {
    readonly localOrderId: string;
    readonly idempotencyReference: string;
    readonly merchantId: string;
    readonly currency: string;
  }): void {
    if (input.idempotencyReference !== input.localOrderId || input.merchantId !== this.options.mchid) {
      throw submissionError('unknown', 'wxpay order identity mismatch');
    }
    if (input.currency.toUpperCase() !== this.options.currency) {
      throw submissionError('unknown', 'wxpay order currency is not the merchant settlement currency');
    }
  }

  private async createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult> {
    this.assertOrderIdentity(input);
    const amount = this.wireAmount(input.amountMinorUnits);
    if (Buffer.byteLength(input.tenantId, 'utf8') > 127) {
      throw submissionError('unknown', 'wxpay tenant attach is too long');
    }
    const outTradeNo = wxpayOutTradeNo(input.localOrderId);
    // Raw-token amount interpolation: the digit-only wire token never passes
    // through a float, preserving full 16-digit precision in the JSON body.
    const body =
      `{"appid":${jsonString(this.options.appid)},"mchid":${jsonString(this.options.mchid)},` +
      `"description":${jsonString(`Order ${input.localOrderId}`.slice(0, 120))},` +
      `"out_trade_no":${jsonString(outTradeNo)},"notify_url":${jsonString(this.options.notifyUrl)},` +
      `"attach":${jsonString(input.tenantId)},"amount":{"total":${amount},"currency":${jsonString(this.options.currency)}}}`;
    const response = await this.request('POST', '/v3/pay/transactions/native', body);
    if (response.status < 200 || response.status >= 300) {
      const failure = parseWxpayError(response.body);
      if (response.status >= 400 && response.status < 500 && failure !== null) {
        // A structured business 4xx is a definitive rejection only when the
        // active query proves no order exists upstream (review checklist).
        const query = await this.queryTransaction(outTradeNo);
        if (query.kind === 'not_found') {
          throw submissionError('rejected', `wxpay order rejected: ${this.summarize(failure.message ?? '')}`);
        }
        throw submissionError('unknown', 'wxpay order acceptance is unknown');
      }
      throw submissionError('unknown', `wxpay answered HTTP ${response.status}`);
    }
    const parsed = this.parseRecord(response);
    const codeUrl = textField(parsed.code_url);
    if (codeUrl === null || codeUrl.length > MAX_CODE_URL_BYTES || !CODE_URL_PATTERN.test(codeUrl)) {
      throw submissionError('unknown', 'wxpay create returned no usable code_url');
    }
    return {
      providerOrderId: outTradeNo,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction: this.checkoutAction(codeUrl),
    };
  }

  private checkoutAction(codeUrl: string): PaymentCheckoutAction {
    // Constrained checkout: the native code_url is the customer-facing QR
    // payload; it rides the closed `qr` text carrier and is re-sanitized by
    // the payment service's qr text policy before it is ever rendered.
    const expiresAt = new Date(this.options.now().getTime() + this.options.checkoutTtlMs).toISOString();
    return { kind: 'qr', text: codeUrl, expiresAt };
  }

  /**
   * Same-order recovery by out_trade_no: a definitive 404 answers null and
   * recovery NEVER submits a create.
   */
  private async recoverOrder(
    input: PaymentProviderOrderRecoveryInput,
  ): Promise<PaymentProviderCreateOrderResult | null> {
    this.assertOrderIdentity(input);
    const outTradeNo = wxpayOutTradeNo(input.localOrderId);
    const query = await this.queryTransaction(outTradeNo);
    if (query.kind === 'not_found') return null;
    if (query.kind === 'unknown') {
      throw submissionError('unknown', 'wxpay order recovery could not confirm the order');
    }
    if (query.mchid !== this.options.mchid || query.outTradeNo !== outTradeNo) {
      throw submissionError('unknown', 'wxpay recovered transaction echo mismatch');
    }
    if (query.attach !== null && query.attach !== input.tenantId) {
      throw submissionError('unknown', 'wxpay recovered transaction belongs to another tenant');
    }
    return {
      providerOrderId: outTradeNo,
      amountMinorUnits: query.amountMinorUnits ?? input.amountMinorUnits,
      currency: this.options.currency,
    };
  }

  /**
   * Fetches /v3/certificates (merchant-signed GET), decrypts each certificate
   * under the apiV3Key and caches the valid ones by serial. Concurrent
   * verifications share one in-flight refresh.
   */
  private refreshPlatformCertificates(): Promise<void> {
    if (this.certificateRefresh !== null) return this.certificateRefresh;
    const task = this.fetchPlatformCertificates();
    this.certificateRefresh = task;
    void task
      .catch(() => {})
      .finally(() => {
        if (this.certificateRefresh === task) this.certificateRefresh = null;
      });
    return task;
  }

  private async fetchPlatformCertificates(): Promise<void> {
    const response = await this.request('GET', '/v3/certificates', '');
    const parsed = this.parseRecord(response);
    const data = parsed.data;
    if (!Array.isArray(data)) {
      throw submissionError('unknown', 'wxpay certificates response is invalid');
    }
    const nowMs = this.options.now().getTime();
    for (const item of data) {
      if (!isRecord(item) || !isRecord(item.encrypt_certificate)) continue;
      const envelope = item.encrypt_certificate;
      if (textField(envelope.algorithm) !== WXPAY_AEAD_ALGORITHM) continue;
      const nonce = textField(envelope.nonce);
      const associatedData = textField(envelope.associated_data);
      const ciphertext = textField(envelope.ciphertext);
      if (nonce === null || associatedData === null || ciphertext === null) continue;
      const pem = decryptWxpayAesGcm({ apiV3Key: this.options.apiV3Key, nonce, associatedData, ciphertext });
      if (pem === null) continue;
      const certificate = parseWxpayPlatformCertificate(pem, nowMs);
      if (certificate === null) continue;
      this.platformCertificates.set(certificate.serialNo, certificate);
    }
  }

  private async platformCertificateFor(serialNo: string): Promise<WxpayPlatformCertificate> {
    const nowMs = this.options.now().getTime();
    const cached = this.platformCertificates.get(serialNo);
    if (cached !== undefined && nowMs <= cached.notAfterMs) return cached;
    await this.refreshPlatformCertificates();
    const refreshed = this.platformCertificates.get(serialNo);
    if (refreshed === undefined || nowMs > refreshed.notAfterMs) {
      throw new Error('wxpay platform certificate is unavailable for the notification serial');
    }
    return refreshed;
  }

  private async verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook> {
    if (input.merchantId !== this.options.mchid) throw new Error('wxpay webhook merchant mismatch');
    const signature = webhookHeader(input.headers, 'wechatpay-signature');
    const timestamp = webhookHeader(input.headers, 'wechatpay-timestamp');
    const nonce = webhookHeader(input.headers, 'wechatpay-nonce');
    const serial = webhookHeader(input.headers, 'wechatpay-serial');
    if (signature === null || timestamp === null || nonce === null || serial === null) {
      throw new Error('wxpay webhook is missing its signature headers');
    }
    const certificate = await this.platformCertificateFor(serial.toUpperCase());
    const verified = verifyWxpayNotificationSignature({
      rawBody: input.rawBody,
      timestamp,
      nonce,
      signature,
      publicKey: certificate.publicKey,
      nowMs: this.options.now().getTime(),
    });
    if (!verified) throw new Error('wxpay webhook signature is invalid');
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      throw new Error('wxpay webhook payload is not valid JSON');
    }
    if (!isRecord(parsed) || !isRecord(parsed.resource)) throw new Error('wxpay webhook payload is invalid');
    const eventId = textField(parsed.id);
    const eventType = textField(parsed.event_type);
    const resource = parsed.resource;
    if (eventId === null || eventType === null) throw new Error('wxpay webhook event is incomplete');
    if (textField(resource.algorithm) !== WXPAY_AEAD_ALGORITHM) {
      throw new Error('wxpay webhook resource algorithm is unsupported');
    }
    const resourceNonce = textField(resource.nonce);
    const associatedData = textField(resource.associated_data);
    const ciphertext = textField(resource.ciphertext);
    if (resourceNonce === null || associatedData === null || ciphertext === null) {
      throw new Error('wxpay webhook resource is incomplete');
    }
    const plaintext = decryptWxpayAesGcm({
      apiV3Key: this.options.apiV3Key,
      nonce: resourceNonce,
      associatedData,
      ciphertext,
    });
    if (plaintext === null) throw new Error('wxpay webhook resource decryption failed');
    let transaction: unknown;
    try {
      transaction = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new Error('wxpay webhook resource is not valid JSON');
    }
    if (!isRecord(transaction)) throw new Error('wxpay webhook transaction is invalid');
    if (textField(transaction.mchid) !== this.options.mchid) {
      throw new Error('wxpay webhook transaction merchant mismatch');
    }
    if (textField(transaction.out_trade_no) === null) {
      throw new Error('wxpay webhook transaction is missing out_trade_no');
    }
    const payload: WxpayVerifiedPayload = {
      notification: { id: eventId, eventType, createTime: textField(parsed.create_time) },
      transaction,
    };
    return {
      providerKey: WXPAY_PROVIDER_KEY,
      merchantId: this.options.mchid,
      payload,
    };
  }

  private normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent {
    if (!isRecord(input.payload) || !isRecord(input.payload.notification) || !isRecord(input.payload.transaction)) {
      throw new Error('wxpay webhook payload is invalid');
    }
    const payload = input.payload as unknown as WxpayVerifiedPayload;
    const notification = payload.notification;
    const transaction = payload.transaction;
    if (typeof notification.id !== 'string' || typeof notification.eventType !== 'string') {
      throw new Error('wxpay webhook event is invalid');
    }
    const outTradeNo = textField(transaction.out_trade_no);
    if (outTradeNo === null) throw new Error('wxpay webhook event is missing out_trade_no');
    const transactionId = textField(transaction.transaction_id);
    const tradeState = textField(transaction.trade_state);
    const amount = isRecord(transaction.amount) ? transaction.amount : null;
    const amountMinorUnits = amount === null ? null : wxpayAmountToMinorUnits(amount.total);
    if (amountMinorUnits === null) throw new Error('wxpay webhook amount is invalid');
    const currency = amount === null ? null : (textField(amount.currency)?.toUpperCase() ?? null);
    if (currency === null) throw new Error('wxpay webhook currency is invalid');
    const createTime = notification.createTime === null ? null : Date.parse(notification.createTime);
    const successTime = textField(transaction.success_time);
    const occurredMs =
      createTime !== null && Number.isFinite(createTime)
        ? createTime
        : successTime !== null && Number.isFinite(Date.parse(successTime))
          ? Date.parse(successTime)
          : this.options.now().getTime();
    return {
      // Double-anchored identity: the immutable notification id plus the
      // WeChat transaction id (out_trade_no before payment exists upstream).
      providerEventId: `${notification.id}:${transactionId ?? outTradeNo}`,
      eventType: notification.eventType,
      providerOrderId: outTradeNo,
      tenantId: textField(transaction.attach) ?? UNRESOLVED_TENANT,
      merchantId: this.options.mchid,
      status: wxpayTradeStateToEventStatus(tradeState),
      amountMinorUnits,
      currency,
      occurredAt: new Date(occurredMs),
    };
  }

  /**
   * The fulfillment red line (review checklist): a verified + decrypted
   * notification alone never fulfills. The active out-trade-no query must
   * confirm the same out_trade_no, mchid, tenant attach, trade_state=SUCCESS,
   * the exact fen amount and a consistent transaction anchor. A query that
   * cannot be proven throws (retryable claim), never reconciles.
   */
  private async confirmEvent(input: PaymentProviderEventConfirmationInput): Promise<PaymentProviderEventConfirmation> {
    if (input.order.currency.toUpperCase() !== this.options.currency) {
      return { confirmed: false, code: 'WXPAY_CURRENCY_MISMATCH' };
    }
    const expectedOutTradeNo = wxpayOutTradeNo(input.order.localOrderId);
    if (input.event.providerOrderId !== expectedOutTradeNo) {
      return { confirmed: false, code: 'WXPAY_ORDER_REF_MISMATCH' };
    }
    const query = await this.queryTransaction(expectedOutTradeNo);
    if (query.kind === 'unknown') {
      throw submissionError('unknown', 'wxpay order confirmation could not reach the provider');
    }
    if (query.kind === 'not_found') return { confirmed: false, code: 'WXPAY_ORDER_NOT_FOUND' };
    if (query.mchid !== this.options.mchid) return { confirmed: false, code: 'WXPAY_MERCHANT_MISMATCH' };
    if (query.outTradeNo !== expectedOutTradeNo) return { confirmed: false, code: 'WXPAY_ORDER_REF_MISMATCH' };
    // The tenant attach was set at create and must echo on every query.
    if (query.attach !== input.order.tenantId) return { confirmed: false, code: 'WXPAY_TENANT_MISMATCH' };
    if (query.tradeState !== 'SUCCESS') return { confirmed: false, code: 'WXPAY_TRADE_NOT_SUCCESS' };
    if (
      query.amountMinorUnits === null ||
      query.amountMinorUnits !== input.order.amountMinorUnits ||
      query.amountMinorUnits !== String(input.event.amountMinorUnits)
    ) {
      return { confirmed: false, code: 'WXPAY_AMOUNT_MISMATCH' };
    }
    if (query.currency === null || query.currency !== this.options.currency) {
      return { confirmed: false, code: 'WXPAY_CURRENCY_MISMATCH' };
    }
    // The notification anchor (transaction id when paid, out_trade_no
    // otherwise) must agree with the queried transaction id when one exists.
    const anchor = input.event.providerEventId.slice(input.event.providerEventId.lastIndexOf(':') + 1);
    if (query.transactionId !== null && anchor !== query.transactionId && anchor !== expectedOutTradeNo) {
      return { confirmed: false, code: 'WXPAY_TRANSACTION_MISMATCH' };
    }
    return { confirmed: true };
  }

  private assertRefundIdentity(input: PaymentProviderRefundInput): void {
    if (input.providerKey !== WXPAY_PROVIDER_KEY || input.merchantId !== this.options.mchid) {
      throw submissionError('unknown', 'wxpay refund identity mismatch');
    }
    if (input.idempotencyReference !== input.localRefundId) {
      throw submissionError('unknown', 'wxpay refund idempotency reference mismatch');
    }
    if (input.currency.toUpperCase() !== this.options.currency) {
      throw submissionError('unknown', 'wxpay refund currency mismatch');
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

  private async submitRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundResult> {
    this.assertRefundIdentity(input);
    const refund = this.wireAmount(input.amountMinorUnits);
    // WeChat requires the ORIGINAL order total on every refund; it is sourced
    // from an active order query (never from caller-supplied data).
    const order = await this.queryTransaction(input.providerOrderId);
    if (order.kind === 'unknown') {
      throw submissionError('unknown', 'wxpay refund order lookup could not reach the provider');
    }
    if (order.kind === 'not_found') {
      throw submissionError('not_accepted', 'wxpay refund order is unknown to the provider');
    }
    if (
      order.mchid !== this.options.mchid ||
      order.outTradeNo !== input.providerOrderId ||
      order.amountMinorUnits === null
    ) {
      throw submissionError('unknown', 'wxpay refund order lookup echo mismatch');
    }
    const total = order.amountMinorUnits;
    const body =
      `{"out_trade_no":${jsonString(input.providerOrderId)},` +
      `"out_refund_no":${jsonString(input.idempotencyReference)},` +
      `"amount":{"refund":${refund},"total":${total},"currency":${jsonString(this.options.currency)}}}`;
    const response = await this.request('POST', '/v3/refund/domestic/refunds', body);
    if (response.status < 200 || response.status >= 300) {
      const failure = parseWxpayError(response.body);
      // RESOURCE_NOT_EXISTS is the only definitive "not accepted": WeChat
      // answered and the refund target does not exist. Every other failure
      // shape stays unknown (idempotency ambiguity is never proof).
      if (failure?.code === 'RESOURCE_NOT_EXISTS') {
        throw submissionError('not_accepted', `wxpay refund rejected: ${this.summarize(failure.message ?? '')}`);
      }
      throw submissionError('unknown', `wxpay answered HTTP ${response.status}`);
    }
    const parsed = this.parseRecord(response);
    const refundId = textField(parsed.refund_id);
    const echoOutRefundNo = textField(parsed.out_refund_no);
    const echoOutTradeNo = textField(parsed.out_trade_no);
    if (echoOutRefundNo !== null && echoOutRefundNo !== input.idempotencyReference) {
      throw submissionError('unknown', 'wxpay refund out_refund_no echo mismatch');
    }
    if (echoOutTradeNo !== null && echoOutTradeNo !== input.providerOrderId) {
      throw submissionError('unknown', 'wxpay refund out_trade_no echo mismatch');
    }
    if (refundId === null && echoOutRefundNo === null) {
      throw submissionError('unknown', 'wxpay refund returned no refund identity');
    }
    return {
      ...this.refundEcho(input),
      providerRefundId: refundId ?? echoOutRefundNo,
      status: wxpayRefundStatusToTriState(textField(parsed.status)) ?? 'pending',
    };
  }

  /**
   * Real refund query tri-state by out_refund_no = idempotencyReference (the
   * same reference used at submit): SUCCESS/CLOSED/ABNORMAL/PROCESSING map
   * onto the port states, a 404 answers not_found (never proof of rejection),
   * and anything unproven stays unknown — never a fabricated verdict.
   */
  private async queryRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult> {
    const unknownResult: PaymentProviderRefundQueryResult = {
      ...this.refundEcho(input),
      providerRefundId: input.providerRefundId,
      status: 'unknown',
    };
    if (input.providerKey !== WXPAY_PROVIDER_KEY || input.merchantId !== this.options.mchid) {
      return unknownResult;
    }
    if (input.idempotencyReference !== input.localRefundId) return unknownResult;
    let response: WxpayHttpResponse;
    try {
      response = await this.request(
        'GET',
        `/v3/refund/domestic/refunds/${encodeURIComponent(input.idempotencyReference)}`,
        '',
      );
    } catch {
      return unknownResult;
    }
    if (response.status === 404) return { ...unknownResult, status: 'not_found' };
    let parsed: Record<string, unknown>;
    try {
      parsed = this.parseRecord(response);
    } catch {
      return unknownResult;
    }
    const echoOutRefundNo = textField(parsed.out_refund_no);
    const echoOutTradeNo = textField(parsed.out_trade_no);
    const amount = isRecord(parsed.amount) ? parsed.amount : null;
    const refundMinor = amount === null ? null : wxpayAmountToMinorUnits(amount.refund);
    const status = wxpayRefundStatusToTriState(textField(parsed.status));
    if (
      echoOutRefundNo === null ||
      echoOutRefundNo !== input.idempotencyReference ||
      echoOutTradeNo === null ||
      echoOutTradeNo !== input.providerOrderId ||
      refundMinor === null ||
      refundMinor !== input.amountMinorUnits ||
      status === null
    ) {
      return unknownResult;
    }
    return {
      ...unknownResult,
      providerRefundId: textField(parsed.refund_id) ?? input.providerRefundId,
      status,
    };
  }
}

export function createWxpayPaymentProvider(input: WxpayProviderConfigInput): WxpayPaymentProvider {
  return new WxpayPaymentProvider(parseWxpayProviderConfig(input));
}
