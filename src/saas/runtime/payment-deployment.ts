import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ManagedSaasDeploymentConfig } from '../deployment.js';
import { ReadonlyPaymentBindingResolver, type LoadedPaymentBinding, type PaymentBindingResolver } from '../payments/merchant-binding.js';
import { createAlipayPaymentProvider } from '../payments/providers/alipay/provider.js';
import type { PaymentWalletTopUpPolicy } from '../payments/types.js';
import { createPaymentCredentialReader, PaymentDeploymentError, type PaymentCredentialReader, validPaymentCredentialName } from './payment-credentials.js';

export interface PaymentBindingDescriptor {
  readonly id: string;
  readonly provider: 'alipay';
  readonly appId: string;
  readonly sellerId: string;
  readonly currency: 'CNY';
  readonly createMethod: 'precreate';
  readonly merchantPrivateKeyCredential: string;
  readonly alipayPublicKeyCredential: string;
  readonly environment: 'production' | 'sandbox';
}
export interface PaymentDeploymentDescriptor {
  readonly schemaVersion: 1;
  readonly bindings: readonly PaymentBindingDescriptor[];
  readonly walletTopUp: { readonly currency: 'CNY'; readonly minimumMinorUnits: string; readonly maximumMinorUnits: string };
}
const invalid = (): never => { throw new PaymentDeploymentError('PAYMENT_CONFIG_INVALID'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
export function parsePaymentDeploymentDescriptor(input: unknown): PaymentDeploymentDescriptor {
  const source = record(input);
  exactKeys(source, ['schemaVersion', 'bindings', 'walletTopUp']);
  if (source.schemaVersion !== 1 || !Array.isArray(source.bindings) || source.bindings.length < 1 || source.bindings.length > 64) invalid();
  const ids = new Set<string>();
  const bindings = (source.bindings as unknown[]).map((value): PaymentBindingDescriptor => {
    const item = record(value);
    exactKeys(item, ['id', 'provider', 'appId', 'sellerId', 'currency', 'createMethod', 'merchantPrivateKeyCredential', 'alipayPublicKeyCredential', 'environment']);
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(item.id) || ids.has(item.id)) invalid();
    if (item.provider !== 'alipay' || item.currency !== 'CNY' || item.createMethod !== 'precreate') invalid();
    if (typeof item.appId !== 'string' || !/^\d{10,20}$/u.test(item.appId) || typeof item.sellerId !== 'string' || !/^\d{1,32}$/u.test(item.sellerId)) invalid();
    if (!validPaymentCredentialName(item.merchantPrivateKeyCredential) || !validPaymentCredentialName(item.alipayPublicKeyCredential)) invalid();
    if (item.environment !== undefined && item.environment !== 'production' && item.environment !== 'sandbox') invalid();
    ids.add(item.id as string);
    return Object.freeze({ ...item, environment: item.environment ?? 'production' }) as unknown as PaymentBindingDescriptor;
  });
  const policy = record(source.walletTopUp);
  exactKeys(policy, ['currency', 'minimumMinorUnits', 'maximumMinorUnits']);
  if (policy.currency !== 'CNY' || typeof policy.minimumMinorUnits !== 'string' || typeof policy.maximumMinorUnits !== 'string' || !/^[1-9]\d{0,17}$/u.test(policy.minimumMinorUnits) || !/^[1-9]\d{0,17}$/u.test(policy.maximumMinorUnits) || BigInt(policy.minimumMinorUnits) > BigInt(policy.maximumMinorUnits)) invalid();
  return Object.freeze({ schemaVersion: 1, bindings: Object.freeze(bindings), walletTopUp: Object.freeze({ currency: 'CNY', minimumMinorUnits: policy.minimumMinorUnits as string, maximumMinorUnits: policy.maximumMinorUnits as string }) });
}
export function paymentBindingDescriptorDigest(binding: PaymentBindingDescriptor): string {
  return createHash('sha256').update(JSON.stringify([binding.id, binding.provider, binding.appId, binding.sellerId, binding.currency, binding.createMethod, binding.environment, binding.merchantPrivateKeyCredential, binding.alipayPublicKeyCredential])).digest('hex');
}
export interface LoadedPaymentDeployment {
  readonly resolver: PaymentBindingResolver;
  readonly walletTopUpPolicy: PaymentWalletTopUpPolicy;
  close(): Promise<void>;
}
export async function loadPaymentDeployment(deployment: ManagedSaasDeploymentConfig, options: { readonly environment?: Readonly<Record<string, string | undefined>>; readonly credentialReader?: PaymentCredentialReader } = {}): Promise<LoadedPaymentDeployment | undefined> {
  if (!deployment.paymentsConfigFile) return undefined;
  if (deployment.workloadRole !== 'combined' && deployment.workloadRole !== 'control-plane') throw new PaymentDeploymentError('PAYMENT_ROLE_FORBIDDEN');
  let descriptor: PaymentDeploymentDescriptor;
  try {
    const file = await open(deployment.paymentsConfigFile, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 128 * 1024) invalid();
      const bytes = Buffer.alloc(128 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > 128 * 1024) invalid();
      descriptor = parsePaymentDeploymentDescriptor(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    } finally { await file.close(); }
  } catch { throw new PaymentDeploymentError('PAYMENT_CONFIG_INVALID'); }
  const environment = options.environment ?? process.env;
  const directory = environment.MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY ?? environment.CREDENTIALS_DIRECTORY;
  const reader = options.credentialReader ?? (directory ? createPaymentCredentialReader(directory) : undefined);
  if (!reader) throw new PaymentDeploymentError('PAYMENT_CREDENTIAL_UNAVAILABLE');
  const bindings: LoadedPaymentBinding[] = [];
  for (const binding of descriptor.bindings) {
    let privateKey: Buffer | undefined;
    let publicKey: Buffer | undefined;
    try {
      privateKey = await reader.read(binding.merchantPrivateKeyCredential);
      publicKey = await reader.read(binding.alipayPublicKeyCredential);
      const origin = deployment.listeners.customer?.origin;
      if (!origin) invalid();
      const provider = createAlipayPaymentProvider({ appId: binding.appId, sellerId: binding.sellerId, merchantPrivateKey: privateKey.toString('utf8'), alipayPublicKey: publicKey.toString('utf8'), gateway: binding.environment === 'sandbox' ? 'https://openapi-sandbox.dl.alipaydev.com' : 'https://openapi.alipay.com', currency: 'CNY', createMethod: 'precreate', notifyUrl: `${origin}/payments/webhooks/alipay/${encodeURIComponent(binding.id)}`, returnUrl: `${origin}/wallet` });
      bindings.push(Object.freeze({ binding: Object.freeze({ id: binding.id, providerKey: 'alipay', merchantId: binding.appId, sellerId: binding.sellerId, currency: 'CNY', descriptorDigest: paymentBindingDescriptorDigest(binding) }), adapter: provider.adapter, refundAdapter: provider.refundAdapter }));
    } catch { throw new PaymentDeploymentError('PAYMENT_CREDENTIAL_UNAVAILABLE'); }
    finally { privateKey?.fill(0); publicKey?.fill(0); }
  }
  return Object.freeze({ resolver: new ReadonlyPaymentBindingResolver(bindings), walletTopUpPolicy: Object.freeze({ currency: 'CNY', minAmountMinorUnits: descriptor.walletTopUp.minimumMinorUnits, maxAmountMinorUnits: descriptor.walletTopUp.maximumMinorUnits }), async close() {} });
}
