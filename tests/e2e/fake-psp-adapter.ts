import { randomUUID } from 'node:crypto';
import type {
  NormalizedPaymentProviderEvent,
  PaymentCheckoutAction,
  PaymentProviderAdapter,
  PaymentProviderCreateOrderInput,
  PaymentProviderCreateOrderResult,
  PaymentProviderEventConfirmation,
  PaymentProviderEventConfirmationInput,
  PaymentProviderEventOrderFacts,
  PaymentProviderOrderRecoveryInput,
  PaymentProviderWebhookVerificationInput,
  VerifiedPaymentProviderWebhook,
} from '../../src/saas/payments/types.js';

/**
 * The M1 e2e stand-in payment provider. There is deliberately no mock PSP in
 * production code (all four adapters dial real PSPs); this adapter implements
 * the real PaymentProviderAdapter contract so the e2e exercises the genuine
 * order → webhook → inbox → fulfill → postVerifiedFunding chain. The webhook
 * accepts a plain JSON body { providerOrderId, tenantId, amountMinorUnits,
 * currency } — everything the spec controls.
 */
export class FakePspAdapter implements PaymentProviderAdapter {
  readonly providerKey = 'e2e-psp';
  readonly merchantId = 'e2e-merchant';
  private readonly orders = new Map<string, { amountMinorUnits: string; currency: string; tenantId: string }>();

  createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult> {
    const providerOrderId = `psp_${input.localOrderId}`;
    this.orders.set(providerOrderId, {
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      tenantId: input.tenantId,
    });
    const checkout: PaymentCheckoutAction = {
      kind: 'redirect',
      url: `https://pay.e2e.test/checkout/${providerOrderId}`,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
    return Promise.resolve({
      providerOrderId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction: checkout,
    });
  }

  recoverOrder(input: PaymentProviderOrderRecoveryInput): Promise<PaymentProviderCreateOrderResult | null> {
    const order = this.orders.get(input.providerOrderId);
    if (order === undefined) return Promise.resolve(null);
    return Promise.resolve({
      providerOrderId: input.providerOrderId,
      amountMinorUnits: order.amountMinorUnits,
      currency: order.currency,
      checkoutAction: {
        kind: 'redirect',
        url: `https://pay.e2e.test/checkout/${input.providerOrderId}`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    });
  }

  verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook> {
    if (input.rawBody.length === 0) throw new Error('e2e-psp webhook requires a non-empty JSON body');
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      throw new Error('e2e-psp webhook body must be JSON');
    }
    return Promise.resolve({
      providerKey: this.providerKey,
      merchantId: input.merchantId,
      payload,
    });
  }

  normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent {
    const payload = input.payload as {
      providerOrderId?: unknown;
      tenantId?: unknown;
      amountMinorUnits?: unknown;
      currency?: unknown;
    };
    const providerOrderId = String(payload.providerOrderId ?? '');
    const order = this.orders.get(providerOrderId);
    if (order === undefined) throw new Error(`e2e-psp has no order ${providerOrderId}`);
    return {
      providerEventId: `evt_${providerOrderId}_${randomUUID().slice(0, 8)}`,
      eventType: 'payment.succeeded',
      providerOrderId,
      tenantId: String(payload.tenantId ?? order.tenantId),
      merchantId: input.merchantId,
      status: 'succeeded',
      amountMinorUnits: order.amountMinorUnits,
      currency: order.currency,
      occurredAt: new Date(),
    };
  }

  confirmEvent(input: PaymentProviderEventConfirmationInput): Promise<PaymentProviderEventConfirmation> {
    return Promise.resolve({ confirmed: this.confirmationMatches(input.event, input.order) });
  }

  /** The webhook body the spec POSTs to /payments/webhooks/e2e-psp. */
  webhookBody(input: {
    providerOrderId: string;
    tenantId: string;
    amountMinorUnits: string;
    currency: string;
  }): string {
    return JSON.stringify(input);
  }

  private confirmationMatches(event: NormalizedPaymentProviderEvent, order: PaymentProviderEventOrderFacts): boolean {
    return (
      event.providerOrderId === order.providerOrderId &&
      event.tenantId === order.tenantId &&
      event.merchantId === order.merchantId &&
      event.amountMinorUnits === order.amountMinorUnits &&
      event.currency === order.currency &&
      event.status === 'succeeded'
    );
  }
}
