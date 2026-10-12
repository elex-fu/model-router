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
  PaymentProviderRefundStatus,
  PaymentProviderWebhookVerificationInput,
  PaymentWebhookHeaders,
  VerifiedPaymentProviderWebhook,
} from '../../types.js';
import {
  parseStripeProviderConfig,
  STRIPE_PROVIDER_KEY,
  type StripeProviderConfigInput,
  type StripeProviderOptions,
  stripeAmountToMinorUnits,
  stripeMinorUnitsToWire,
  verifyStripeWebhookSignature,
} from './protocol.js';

// Stripe adapter (contract C5/R3): direct form-encoded v1 API with no
// official SDK. PaymentIntents carry metadata.out_trade_no/tenant_id and are
// created with `Idempotency-Key: <localOrderId>`. The fulfillment red line
// mirrors EasyPay: a verified stripe-signature alone never fulfills — an
// active PaymentIntent retrieve must confirm status=succeeded plus
// amount/currency/out_trade_no consistency. Refunds use the Refunds API with
// `Idempotency-Key: <localRefundId>` and — unlike EasyPay — a REAL refund
// query tri-state (retrieve maps pending/succeeded/failed/canceled), proving
// the refund port abstraction does not collapse for a full-capability PSP.
//
// Merchant identity: Stripe has no separate merchant id, so the publishable
// key (public by design) plays that role across adapter, service and webhook
// scopes. The client_secret checkout is normalized into the constrained
// `qr`-kind action as an opaque provider token; the publishable key itself is
// deployment configuration for the frontend Stripe.js collector.

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_UPSTREAM_MESSAGE = 512;
const UNRESOLVED_TENANT = 'unresolved-tenant';

export type StripeSubmissionAcceptance = PaymentProviderSubmissionErrorDetails;

/** Adapter errors carry the structural acceptance details the payment service reads off the thrown object. */
export class StripeProviderError extends Error {
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
    this.name = 'StripeProviderError';
    this.acceptance = details.acceptance;
    if (details.retryable !== undefined) this.retryable = details.retryable;
    if (details.safeToRetry !== undefined) this.safeToRetry = details.safeToRetry;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function submissionError(acceptance: 'rejected' | 'not_accepted' | 'unknown', message: string): StripeProviderError {
  return new StripeProviderError(message, { acceptance });
}

interface StripeHttpResponse {
  readonly status: number;
  readonly body: string;
}

interface StripeErrorPayload {
  readonly type: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

type StripePaymentIntentQuery =
  | {
      readonly kind: 'found';
      readonly id: string;
      readonly status: string;
      readonly amountMinorUnits: string;
      readonly currency: string;
      readonly clientSecret: string | null;
      readonly outTradeNo: string | null;
      readonly tenantId: string | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unknown' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseStripeError(body: string): StripeErrorPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
    return {
      type: textField(parsed.error.type),
      code: textField(parsed.error.code),
      message: textField(parsed.error.message),
    };
  } catch {
    return null;
  }
}

/** Maps Stripe refund statuses onto the provider refund tri-state; unrecognized statuses stay provisional. */
function stripeRefundStatus(value: string | null): PaymentProviderRefundStatus | null {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'pending') return 'pending';
  if (value === 'failed' || value === 'canceled') return 'failed';
  return null;
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

export class StripePaymentProvider {
  readonly adapter: PaymentProviderAdapter;
  readonly refundAdapter: PaymentProviderRefundAdapter;

  constructor(private readonly options: StripeProviderOptions) {
    this.adapter = Object.freeze({
      providerKey: STRIPE_PROVIDER_KEY,
      createOrder: (input) => this.createOrder(input),
      recoverOrder: (input) => this.recoverOrder(input),
      verifyWebhook: (input) => this.verifyWebhook(input),
      normalizeEvent: (input) => this.normalizeEvent(input),
      confirmEvent: (input) => this.confirmEvent(input),
    } satisfies PaymentProviderAdapter);
    this.refundAdapter = Object.freeze({
      providerKey: STRIPE_PROVIDER_KEY,
      merchantId: options.publishableKey,
      submitRefund: (input) => this.submitRefund(input),
      queryRefund: (input) => this.queryRefund(input),
    } satisfies PaymentProviderRefundAdapter);
  }

  /** Redacts every configured secret from upstream text before it can reach logs. */
  private summarize(text: string): string {
    let summary = text
      .replaceAll(this.options.secretKey, '***')
      .replaceAll(this.options.webhookSecret, '***')
      .replace(/\s+/g, ' ')
      .trim();
    if (summary.length > MAX_UPSTREAM_MESSAGE) summary = `${summary.slice(0, MAX_UPSTREAM_MESSAGE)}...`;
    return summary === '' ? '<empty>' : summary;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { readonly form?: Readonly<Record<string, string>>; readonly idempotencyKey?: string } = {},
  ): Promise<StripeHttpResponse> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.secretKey}` };
    let body: string | undefined;
    if (options.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    let response: Response;
    try {
      response = await this.options.fetchImpl(`${this.options.apiBase}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      throw submissionError('unknown', 'stripe request failed');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw submissionError('unknown', 'stripe response could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw submissionError('unknown', 'stripe response is too large');
    }
    return { status: response.status, body: text };
  }

  /** Parses a 2xx JSON object body; anything else is an unknown-acceptance failure. */
  private parseRecord(response: StripeHttpResponse): Record<string, unknown> {
    if (response.status < 200 || response.status >= 300) {
      throw submissionError('unknown', `stripe answered HTTP ${response.status}`);
    }
    try {
      const parsed: unknown = JSON.parse(response.body);
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch (error) {
      if (error instanceof StripeProviderError) throw error;
      throw submissionError('unknown', 'stripe response is not valid JSON');
    }
  }

  /** Active PaymentIntent retrieve by id; the fulfillment red line and recovery depend on this tri-state. */
  private async retrievePaymentIntent(id: string): Promise<StripePaymentIntentQuery> {
    let response: StripeHttpResponse;
    try {
      response = await this.request('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
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
    const intentId = textField(parsed.id);
    const status = textField(parsed.status);
    const amountMinorUnits = stripeAmountToMinorUnits(parsed.amount);
    const currency = textField(parsed.currency)?.toLowerCase() ?? null;
    if (intentId === null || intentId !== id || status === null || amountMinorUnits === null || currency === null) {
      return { kind: 'unknown' };
    }
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
    return {
      kind: 'found',
      id: intentId,
      status,
      amountMinorUnits,
      currency,
      clientSecret: textField(parsed.client_secret),
      outTradeNo: textField(metadata.out_trade_no),
      tenantId: textField(metadata.tenant_id),
    };
  }

  /**
   * Search-API existence probe for the create acceptance tri-state. Returns
   * true/false only on a parsed 2xx answer; any transport or parse failure is
   * null (unproven), which keeps acceptance at unknown.
   */
  private async paymentIntentExistsForOrder(outTradeNo: string): Promise<boolean | null> {
    const query = `metadata['out_trade_no']:'${outTradeNo}'`;
    let response: StripeHttpResponse;
    try {
      response = await this.request('GET', `/v1/payment_intents/search?query=${encodeURIComponent(query)}`);
    } catch {
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = this.parseRecord(response);
    } catch {
      return null;
    }
    const data = parsed.data;
    if (!Array.isArray(data)) return null;
    return data.some((item) => isRecord(item) && isRecord(item.metadata) && item.metadata.out_trade_no === outTradeNo);
  }

  private wireAmount(amountMinorUnits: string): string {
    try {
      return stripeMinorUnitsToWire(amountMinorUnits);
    } catch {
      throw submissionError('unknown', 'stripe amount must be a minor-units integer string');
    }
  }

  private assertOrderIdentity(input: {
    readonly localOrderId: string;
    readonly idempotencyReference: string;
    readonly merchantId: string;
    readonly currency: string;
  }): void {
    if (input.idempotencyReference !== input.localOrderId || input.merchantId !== this.options.publishableKey) {
      throw submissionError('unknown', 'stripe order identity mismatch');
    }
    if (input.currency.toLowerCase() !== this.options.currency) {
      throw submissionError('unknown', 'stripe order currency is not the merchant settlement currency');
    }
  }

  private checkoutAction(clientSecret: string): PaymentCheckoutAction {
    // Constrained checkout: the client_secret is an opaque per-order token for
    // the frontend Stripe.js collector. The closed checkout union has no
    // dedicated kind, so it rides the `qr` text carrier; the publishable key
    // is public deployment configuration and never enters the action.
    const expiresAt = new Date(this.options.now().getTime() + this.options.checkoutTtlMs).toISOString();
    return { kind: 'qr', text: clientSecret, expiresAt };
  }

  private async createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult> {
    this.assertOrderIdentity(input);
    const amount = this.wireAmount(input.amountMinorUnits);
    const response = await this.request('POST', '/v1/payment_intents', {
      idempotencyKey: input.localOrderId,
      form: {
        amount,
        currency: this.options.currency,
        'payment_method_types[0]': 'card',
        'metadata[out_trade_no]': input.localOrderId,
        'metadata[tenant_id]': input.tenantId,
        description: `Order ${input.localOrderId}`.slice(0, 120),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const failure = parseStripeError(response.body);
      if (failure?.type === 'card_error') {
        // A structured card_error is a definitive rejection only when the
        // active search proves no PaymentIntent was created upstream.
        const exists = await this.paymentIntentExistsForOrder(input.localOrderId);
        if (exists === false) {
          throw submissionError('rejected', `stripe order rejected: ${this.summarize(failure.message ?? '')}`);
        }
        throw submissionError('unknown', 'stripe order acceptance is unknown');
      }
      throw submissionError('unknown', `stripe answered HTTP ${response.status}`);
    }
    const parsed = this.parseRecord(response);
    const id = textField(parsed.id);
    const clientSecret = textField(parsed.client_secret);
    const status = textField(parsed.status);
    if (id === null || !id.startsWith('pi_') || clientSecret === null || status === null) {
      throw submissionError('unknown', 'stripe create returned an incomplete payment intent');
    }
    const echoAmount = stripeAmountToMinorUnits(parsed.amount);
    if (echoAmount === null || echoAmount !== amount) {
      throw submissionError('unknown', 'stripe create amount echo mismatch');
    }
    const echoCurrency = textField(parsed.currency)?.toLowerCase() ?? null;
    if (echoCurrency === null || echoCurrency !== this.options.currency) {
      throw submissionError('unknown', 'stripe create currency echo mismatch');
    }
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
    if (textField(metadata.out_trade_no) !== input.localOrderId) {
      throw submissionError('unknown', 'stripe create metadata echo mismatch');
    }
    return {
      providerOrderId: id,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction: this.checkoutAction(clientSecret),
    };
  }

  /**
   * Same-order recovery by direct id only: Stripe cannot list PaymentIntents
   * by metadata, so without a providerOrderId hint recovery answers null and
   * never creates a charge.
   */
  private async recoverOrder(
    input: PaymentProviderOrderRecoveryInput,
  ): Promise<PaymentProviderCreateOrderResult | null> {
    this.assertOrderIdentity(input);
    const candidate = (input as { readonly providerOrderId?: unknown }).providerOrderId;
    if (typeof candidate !== 'string' || !candidate.startsWith('pi_')) return null;
    const query = await this.retrievePaymentIntent(candidate);
    if (query.kind === 'not_found') return null;
    if (query.kind === 'unknown') {
      throw submissionError('unknown', 'stripe order recovery could not confirm the payment intent');
    }
    if (query.outTradeNo !== input.localOrderId) {
      throw submissionError('unknown', 'stripe recovered payment intent belongs to another order');
    }
    return {
      providerOrderId: query.id,
      amountMinorUnits: query.amountMinorUnits,
      currency: query.currency.toUpperCase(),
    };
  }

  private async verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook> {
    if (input.merchantId !== this.options.publishableKey) throw new Error('stripe webhook merchant mismatch');
    const header = webhookHeader(input.headers, 'stripe-signature');
    if (header === null) throw new Error('stripe webhook is missing its signature header');
    const verified = verifyStripeWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: header,
      webhookSecret: this.options.webhookSecret,
      nowMs: this.options.now().getTime(),
    });
    if (!verified) throw new Error('stripe webhook signature is invalid');
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      throw new Error('stripe webhook payload is not valid JSON');
    }
    if (!isRecord(parsed)) throw new Error('stripe webhook payload is invalid');
    const data = isRecord(parsed.data) ? parsed.data : null;
    const object = data !== null && isRecord(data.object) ? data.object : null;
    if (
      textField(parsed.id) === null ||
      textField(parsed.type) === null ||
      object === null ||
      textField(object.id) === null
    ) {
      throw new Error('stripe webhook event is incomplete');
    }
    return {
      providerKey: STRIPE_PROVIDER_KEY,
      merchantId: this.options.publishableKey,
      payload: parsed,
    };
  }

  private normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent {
    if (!isRecord(input.payload)) throw new Error('stripe webhook payload is invalid');
    const event = input.payload;
    const eventId = textField(event.id);
    const eventType = textField(event.type);
    const data = isRecord(event.data) ? event.data : null;
    const object = data !== null && isRecord(data.object) ? data.object : null;
    if (eventId === null || eventType === null || object === null) {
      throw new Error('stripe webhook event is invalid');
    }
    const intentId = textField(object.id);
    if (intentId === null) throw new Error('stripe webhook event is missing the payment intent id');
    const amountMinorUnits = stripeAmountToMinorUnits(object.amount);
    if (amountMinorUnits === null) throw new Error('stripe webhook amount is invalid');
    const currency = textField(object.currency);
    if (currency === null) throw new Error('stripe webhook currency is invalid');
    const metadata = isRecord(object.metadata) ? object.metadata : {};
    const tenantId = textField(metadata.tenant_id) ?? UNRESOLVED_TENANT;
    const status =
      eventType === 'payment_intent.succeeded'
        ? 'succeeded'
        : eventType === 'payment_intent.payment_failed'
          ? 'failed'
          : eventType === 'payment_intent.canceled'
            ? 'cancelled'
            : 'pending';
    const created =
      typeof event.created === 'number' && Number.isSafeInteger(event.created) && event.created > 0
        ? new Date(event.created * 1000)
        : this.options.now();
    return {
      // Double-anchored identity: the immutable event id plus the PaymentIntent id.
      providerEventId: `${eventId}:${intentId}`,
      eventType,
      providerOrderId: intentId,
      tenantId,
      merchantId: this.options.publishableKey,
      status,
      amountMinorUnits,
      currency: currency.toUpperCase(),
      occurredAt: created,
    };
  }

  /**
   * The C5 fulfillment red line: a verified stripe-signature alone never
   * fulfills. The active retrieve must confirm the same out_trade_no,
   * status=succeeded, the order amount and a consistent currency/intent id.
   */
  private async confirmEvent(input: PaymentProviderEventConfirmationInput): Promise<PaymentProviderEventConfirmation> {
    if (input.order.currency.toLowerCase() !== this.options.currency) {
      return { confirmed: false, code: 'STRIPE_CURRENCY_MISMATCH' };
    }
    const query = await this.retrievePaymentIntent(input.event.providerOrderId);
    if (query.kind === 'unknown') {
      // The retrieve itself is unproven: retryable, never reconciliation.
      throw submissionError('unknown', 'stripe payment intent confirmation could not reach the provider');
    }
    if (query.kind === 'not_found') return { confirmed: false, code: 'STRIPE_PAYMENT_INTENT_NOT_FOUND' };
    if (query.outTradeNo !== input.order.localOrderId) {
      return { confirmed: false, code: 'STRIPE_ORDER_REF_MISMATCH' };
    }
    if (query.status !== 'succeeded') return { confirmed: false, code: 'STRIPE_PAYMENT_INTENT_NOT_SUCCEEDED' };
    if (
      query.amountMinorUnits !== input.order.amountMinorUnits ||
      query.amountMinorUnits !== String(input.event.amountMinorUnits)
    ) {
      return { confirmed: false, code: 'STRIPE_AMOUNT_MISMATCH' };
    }
    if (query.currency !== input.order.currency.toLowerCase()) {
      return { confirmed: false, code: 'STRIPE_CURRENCY_MISMATCH' };
    }
    if (input.order.providerOrderId !== null && input.order.providerOrderId !== query.id) {
      return { confirmed: false, code: 'STRIPE_PAYMENT_INTENT_MISMATCH' };
    }
    return { confirmed: true };
  }

  private assertRefundIdentity(input: PaymentProviderRefundInput): void {
    if (input.providerKey !== STRIPE_PROVIDER_KEY || input.merchantId !== this.options.publishableKey) {
      throw submissionError('unknown', 'stripe refund identity mismatch');
    }
    if (input.idempotencyReference !== input.localRefundId) {
      throw submissionError('unknown', 'stripe refund idempotency reference mismatch');
    }
    if (input.currency.toLowerCase() !== this.options.currency) {
      throw submissionError('unknown', 'stripe refund currency mismatch');
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
    const amount = this.wireAmount(input.amountMinorUnits);
    const response = await this.request('POST', '/v1/refunds', {
      idempotencyKey: input.localRefundId,
      form: {
        payment_intent: input.providerOrderId,
        amount,
        'metadata[local_refund_id]': input.localRefundId,
        'metadata[out_trade_no]': input.originalLocalOrderId,
        'metadata[tenant_id]': input.tenantId,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      const failure = parseStripeError(response.body);
      // resource_missing means Stripe answered and the target PaymentIntent
      // does not exist: the refund was definitively not accepted. Every other
      // failure shape stays unknown (idempotency ambiguity is never proof).
      if (failure?.type === 'invalid_request_error' && failure.code === 'resource_missing') {
        throw submissionError('not_accepted', `stripe refund rejected: ${this.summarize(failure.message ?? '')}`);
      }
      throw submissionError('unknown', `stripe answered HTTP ${response.status}`);
    }
    const parsed = this.parseRecord(response);
    const id = textField(parsed.id);
    if (id === null || !id.startsWith('re_')) {
      throw submissionError('unknown', 'stripe refund returned no refund id');
    }
    const intentRef = textField(parsed.payment_intent);
    if (intentRef !== null && intentRef !== input.providerOrderId) {
      throw submissionError('unknown', 'stripe refund payment intent echo mismatch');
    }
    const echoAmount = stripeAmountToMinorUnits(parsed.amount);
    if (echoAmount === null || echoAmount !== amount) {
      throw submissionError('unknown', 'stripe refund amount echo mismatch');
    }
    return {
      ...this.refundEcho(input),
      providerRefundId: id,
      status: stripeRefundStatus(textField(parsed.status)) ?? 'pending',
    };
  }

  /**
   * Real refund query tri-state (the C5 core value): retrieve maps
   * pending/succeeded/failed(/canceled) onto the port states, a 404
   * resource_missing answers not_found, and anything unproven stays unknown —
   * never a fabricated verdict.
   */
  private async queryRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult> {
    const unknownResult: PaymentProviderRefundQueryResult = {
      ...this.refundEcho(input),
      providerRefundId: input.providerRefundId,
      status: 'unknown',
    };
    if (input.providerKey !== STRIPE_PROVIDER_KEY || input.merchantId !== this.options.publishableKey) {
      return unknownResult;
    }
    if (input.providerRefundId === null) return unknownResult;
    let response: StripeHttpResponse;
    try {
      response = await this.request('GET', `/v1/refunds/${encodeURIComponent(input.providerRefundId)}`);
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
    const id = textField(parsed.id);
    const intentRef = textField(parsed.payment_intent);
    const amountMinorUnits = stripeAmountToMinorUnits(parsed.amount);
    const status = stripeRefundStatus(textField(parsed.status));
    if (
      id === null ||
      id !== input.providerRefundId ||
      intentRef === null ||
      intentRef !== input.providerOrderId ||
      amountMinorUnits === null ||
      amountMinorUnits !== input.amountMinorUnits ||
      status === null
    ) {
      return unknownResult;
    }
    return { ...unknownResult, status };
  }
}

export function createStripePaymentProvider(input: StripeProviderConfigInput): StripePaymentProvider {
  return new StripePaymentProvider(parseStripeProviderConfig(input));
}
