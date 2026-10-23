import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPaymentCredentialReader, PaymentDeploymentError } from '../../../src/saas/runtime/payment-credentials.js';
import { parsePaymentDeploymentDescriptor, paymentBindingDescriptorDigest, loadPaymentDeployment } from '../../../src/saas/runtime/payment-deployment.js';
import type { ManagedSaasDeploymentConfig } from '../../../src/saas/deployment.js';

const binding = { id: 'merchant-v1', provider: 'alipay', appId: '2026000000000001', sellerId: '2088000000000001', currency: 'CNY', createMethod: 'precreate', merchantPrivateKeyCredential: 'private-v1', alipayPublicKeyCredential: 'public-v1' };
const descriptor = () => ({ schemaVersion: 1, bindings: [{ ...binding }], walletTopUp: { currency: 'CNY', minimumMinorUnits: '100', maximumMinorUnits: '100000' } });

test('payment descriptor only accepts immutable Alipay declarations and bounded CNY policy', () => {
  const parsed = parsePaymentDeploymentDescriptor(descriptor());
  assert.equal(parsed.bindings[0]?.environment, 'production');
  assert.ok(Object.isFrozen(parsed.bindings));
  for (const input of [
    { ...descriptor(), mode: 'enabled' },
    { ...descriptor(), bindings: [{ ...binding, provider: 'stripe' }] },
    { ...descriptor(), bindings: [{ ...binding, gateway: 'https://untrusted.invalid' }] },
    { ...descriptor(), bindings: [{ ...binding, merchantPrivateKeyCredential: '../private' }] },
    { ...descriptor(), bindings: [binding, binding] },
    { ...descriptor(), walletTopUp: { currency: 'CNY', minimumMinorUnits: '1000', maximumMinorUnits: '1' } },
  ]) assert.throws(() => parsePaymentDeploymentDescriptor(input), PaymentDeploymentError);
});

test('descriptor digest includes environment and credential version reference', () => {
  const value = parsePaymentDeploymentDescriptor(descriptor()).bindings[0]!;
  assert.notEqual(paymentBindingDescriptorDigest(value), paymentBindingDescriptorDigest({ ...value, merchantPrivateKeyCredential: 'private-v2' }));
  assert.notEqual(paymentBindingDescriptorDigest(value), paymentBindingDescriptorDigest({ ...value, environment: 'sandbox' }));
});

test('credential reader rejects traversal, symlinks, oversize and hides filesystem errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'payment-credentials-'));
  try {
    await writeFile(join(directory, 'valid-v1'), 'synthetic-secret');
    await writeFile(join(directory, 'oversize'), Buffer.alloc(65537));
    await symlink(join(directory, 'valid-v1'), join(directory, 'linked'));
    const reader = createPaymentCredentialReader(directory);
    assert.equal((await reader.read('valid-v1')).toString(), 'synthetic-secret');
    for (const name of ['../valid-v1', '/etc/passwd', 'linked', 'oversize', 'missing']) {
      await assert.rejects(reader.read(name), (error: unknown) => error instanceof PaymentDeploymentError && error.message === 'PAYMENT_CREDENTIAL_UNAVAILABLE');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gateway role refuses payment loader before accessing descriptor or secret', async () => {
  let reads = 0;
  await assert.rejects(loadPaymentDeployment({ workloadRole: 'gateway', paymentsConfigFile: '/not-opened' } as ManagedSaasDeploymentConfig, { credentialReader: { async read() { reads++; return Buffer.from('unused'); } } }), { code: 'PAYMENT_ROLE_FORBIDDEN' });
  assert.equal(reads, 0);
});
