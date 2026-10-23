import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePlatformAccessArtifact, parsePlatformAccessOperation, PlatformAccessPage } from '../../web/src/features/saas-platform-access.tsx';
import { parsePaymentControl, PaymentControlPage, updatePaymentControlView } from '../../web/src/features/saas-platform-payment-control.tsx';

function artifact() {
  return {
    operationKey: 'reviewed-operation', tenantId: 'tenant-1', projectId: 'project-1',
    pool: { id: 'pool-1', expectedAuthzVersion: '2' },
    capacity: { tenantExpectedRevision: '1', projectExpectedRevision: '2', projectLimits: { requestsPerMinute: 60, tokensPerMinute: 1000, maxConcurrentRequests: 2 } },
    routes: [{ routeId: 'new-route', definition: { publicModelId: 'model-1', publicModelVersion: '1', protocol: 'openai', endpoint: '/v1/chat/completions' }, customerPolicy: { policyId: 'new-customer', definition: { customerPriceVersion: 'customer-price-1' } }, providerPolicy: { policyId: 'new-supplier', definition: { providerId: 'provider-1', productId: 'product-1', supplierCostVersion: 'supplier-price-1' } }, attestation: { signatureBase64: 'original-reviewed-signature', contractDigest: 'original-digest' } }],
  };
}
test('reviewed artifact is preserved verbatim including operation key and signature', () => {
  const input = artifact();
  assert.equal(parsePlatformAccessArtifact(input), input);
  assert.equal(parsePlatformAccessArtifact(input).routes[0].attestation.signatureBase64, 'original-reviewed-signature');
  assert.throws(() => parsePlatformAccessArtifact({ ...input, operationKey: '' }));
  assert.throws(() => parsePlatformAccessArtifact({ ...input, routes: [{ ...input.routes[0], attestation: {} }] }));
  assert.throws(() => parsePlatformAccessArtifact({ ...input, pool: { id: 'pool-1', expectedAuthzVersion: 2 } }));
});
test('operation parser accepts server progress and decimal entitlement version', () => {
  const operation = { id: 'operation-1', tenantId: 'tenant-1', projectId: 'project-1', profileId: 'profile-1', entitlementId: 'entitlement-1', phase: 'failed', receipts: { pool: '2' }, lastErrorCode: 'DEPENDENCY_UNAVAILABLE', entitlementAuthzVersion: '2' };
  assert.deepEqual(parsePlatformAccessOperation(operation), operation);
  assert.throws(() => parsePlatformAccessOperation({ ...operation, phase: 'success' }));
  assert.throws(() => parsePlatformAccessOperation({ ...operation, entitlementAuthzVersion: 2 }));
});
test('payment control preserves CAS revision and rejects unknown modes', () => {
  assert.deepEqual(parsePaymentControl({ mode: 'draining', activeBindingId: 'merchant-binding-1', revision: '12' }), { mode: 'draining', activeBindingId: 'merchant-binding-1', revision: '12' });
  assert.throws(() => parsePaymentControl({ mode: 'ready', activeBindingId: null, revision: '12' }));
  assert.throws(() => parsePaymentControl({ mode: 'enabled', activeBindingId: null, revision: 12 }));
});
test('restricted operations pages do not render mutation controls for unauthorized roles', () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const access = renderToStaticMarkup(React.createElement(PlatformAccessPage, { canManage: false }));
  const payment = renderToStaticMarkup(React.createElement(PaymentControlPage, { canManage: false }));
  assert.match(access, /仅运营管理员和超级管理员/);
  assert.match(payment, /仅运营管理员和超级管理员/);
  assert.doesNotMatch(access + payment, /type="file"|type="submit"|type="checkbox"/);
});
test('payment control explains deployment acceptance and uses explicit confirmation', () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const markup = renderToStaticMarkup(React.createElement(PaymentControlPage, { canManage: true }));
  assert.match(markup, /所有副本的商户绑定部署/);
  assert.match(markup, /不会检查或完成副本部署/);
  assert.match(markup, /确认更新支付控制/);
});

test('payment control PATCH submits the original CAS revision and a closed body', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (input, options) => {
    assert.equal(input, '/admin/api/v1/payments/control');
    captured = options;
    return new Response(JSON.stringify({ data: { mode: 'enabled', activeBindingId: 'binding-1', revision: '8' }, meta: { requestId: 'request-1' } }), { status: 200 });
  };
  try {
    const result = await updatePaymentControlView('7', 'enabled', 'binding-1');
    assert.equal(result.revision, '8');
    assert.equal(captured?.method, 'PATCH');
    assert.equal(captured?.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(captured?.body)), { expectedRevision: '7', mode: 'enabled', activeBindingId: 'binding-1' });
  } finally { globalThis.fetch = originalFetch; }
});
