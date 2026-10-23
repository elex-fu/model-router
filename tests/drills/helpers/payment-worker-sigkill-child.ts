import { readFileSync } from 'node:fs';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { ReadonlyPaymentBindingResolver, type LoadedPaymentBinding, type PaymentMerchantBinding } from '../../../src/saas/payments/merchant-binding.js';
import { createPlatformPaymentRefundOperations } from '../../../src/saas/payments/platform-refund-operations.js';
import { PaymentRefundService } from '../../../src/saas/payments/refunds.js';
import { startPaymentRefundWorker } from '../../../src/saas/payments/refund-worker.js';
import type { NormalizedPaymentProviderEvent, PaymentProviderRefundInput, PaymentProviderRefundQueryResult } from '../../../src/saas/payments/types.js';

export interface CrashRefundInputs {
  readonly binding: PaymentMerchantBinding;
  readonly endpoint: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly clientRequestId: string;
  readonly refundId?: string;
}

/** Synthetic loopback PSP transport only; production SQL/services remain unchanged. */
export function crashRefundBinding(input: Pick<CrashRefundInputs, 'binding' | 'endpoint'>): LoadedPaymentBinding {
  const url = new URL(input.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid loopback PSP endpoint');
  const call = async (path: string, body: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult> => {
    const response = await fetch(`${url.origin}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error('Synthetic PSP request failed');
    return await response.json() as PaymentProviderRefundQueryResult;
  };
  return {
    binding: input.binding,
    adapter: {
      providerKey: 'alipay',
      async createOrder(order) { return { providerOrderId: order.localOrderId, amountMinorUnits: order.amountMinorUnits, currency: order.currency }; },
      async verifyWebhook(webhook) { return { providerKey: 'alipay', merchantId: input.binding.merchantId, payload: JSON.parse(webhook.rawBody.toString('utf8')) as unknown }; },
      normalizeEvent(event) { return event.payload as NormalizedPaymentProviderEvent; },
      async confirmEvent() { return { confirmed: true }; },
    },
    refundAdapter: {
      providerKey: 'alipay', merchantId: input.binding.merchantId,
      async submitRefund(refund) {
        const result = await call('submit', refund);
        if (!['pending', 'succeeded', 'failed'].includes(result.status)) throw new Error('Invalid synthetic PSP submit result');
        return { ...result, status: result.status as 'pending' | 'succeeded' | 'failed' };
      },
      queryRefund: refund => call('query', refund),
    },
  };
}

async function run(): Promise<void> {
  const mode = process.argv[3];
  if (!['submit', 'worker', 'replay'].includes(mode ?? '')) throw new Error('Invalid child mode');
  const input = JSON.parse(readFileSync(process.argv[4]!, 'utf8')) as CrashRefundInputs;
  const connectionString = process.env.MODEL_ROUTER_PAYMENT_CRASH_CP_URL;
  if (!connectionString) throw new Error('Missing isolated database role');
  const database = createSaasDatabase({ connectionString, max: 3 });
  const resolver = new ReadonlyPaymentBindingResolver([crashRefundBinding(input)]);
  const service = new PaymentRefundService(database, resolver, { operations: createPlatformPaymentRefundOperations(), leaseTtlMs: 1000, reconcileDelayMs: 0 });
  let worker: ReturnType<typeof startPaymentRefundWorker> | undefined;
  const deadline = setTimeout(() => { process.exitCode = 1; process.exit(1); }, 90000);
  try {
    await database.verifySchema();
    process.send?.({ kind: 'ready', mode });
    if (mode === 'submit' || mode === 'replay') {
      const refund = await service.requestPlatformWalletTopUpRefund({ actorId: input.actorId, sessionId: input.sessionId, actorRoles: ['finance', 'operations'], tenantId: input.tenantId, orderId: input.orderId, clientRequestId: input.clientRequestId, reasonCode: 'CUSTOMER_REQUEST' });
      process.send?.({ kind: 'terminal', refundId: refund.id, status: refund.status });
      if (mode === 'replay' && (refund.id !== input.refundId || refund.status !== 'succeeded')) throw new Error('Refund replay changed original identity');
    } else {
      if (!input.refundId) throw new Error('Missing original refund id');
      worker = startPaymentRefundWorker(service, { intervalMs: 50, batchSize: 1 });
      for (;;) {
        const refund = await service.getRefund(input.tenantId, input.refundId);
        if (refund?.status === 'succeeded') { process.send?.({ kind: 'terminal', refundId: refund.id, status: refund.status }); break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  } finally { clearTimeout(deadline); await worker?.stop(); await database.close(); }
}
if (process.argv[2] === '--child') {
  void run().then(() => { process.disconnect?.(); }, () => { process.stderr.write('payment crash child failed\n'); process.exitCode = 1; process.disconnect?.(); });
}
