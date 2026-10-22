import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGatewayCapabilityAdvertisementPolicy } from '../../../src/saas/runtime/gateway-capability-advertisement.js';
import {
  type GatewayCapabilityProjection,
  type GatewayCapabilityReadiness,
  projectGatewayCapabilityReadiness,
} from '../../../src/saas/runtime/gateway-capability-readiness.js';

const target = { providerId: 'kimi', productId: 'kimi-code', endpoint: 'messages' };

function report(overrides: Partial<GatewayCapabilityProjection> = {}): GatewayCapabilityReadiness {
  return {
    configurationValid: true,
    fatalReasonCodes: [],
    capabilities: [
      {
        capability: 'provider-bundle:kimi',
        kind: 'provider-bundle',
        label: 'Kimi Code',
        ...target,
        productIds: [target.productId],
        endpointScopes: [target.endpoint],
        unavailableEndpointScopes: [],
        enabled: true,
        assembled: true,
        verified: true,
        operational: true,
        verificationLevel: 'live',
        reasonCodes: [],
        ...overrides,
      },
    ],
  };
}

test('advertisement requires the same exact provider, product and endpoint in one sellable bundle', () => {
  const allowed = createGatewayCapabilityAdvertisementPolicy(report());
  assert.equal(allowed(target), true);
  assert.equal(allowed({ ...target, providerId: 'kimi-code' }), false, 'an alias is not a provider identity');
  assert.equal(allowed({ ...target, providerId: 'other' }), false);
  assert.equal(allowed({ ...target, productId: 'another-product' }), false);
  assert.equal(allowed({ ...target, endpoint: 'codex-responses' }), false);
  const cross = report();
  const second = report({
    capability: 'provider-bundle:other',
    providerId: 'other',
    productIds: ['other-product'],
    endpointScopes: ['other-endpoint'],
  }).capabilities[0];
  assert.ok(second);
  const crossPolicy = createGatewayCapabilityAdvertisementPolicy({
    ...cross,
    capabilities: [...cross.capabilities, second],
  });
  assert.equal(crossPolicy({ ...target, productId: 'other-product', endpoint: 'other-endpoint' }), false);
});

test('disabled, unverified, expired-as-unverified and mock observations cannot advertise', () => {
  for (const state of [
    { enabled: false, assembled: false, operational: false },
    { verified: false, verificationLevel: 'unverified' as const, reasonCodes: ['VERIFICATION_NOT_RECORDED' as const] },
    { verified: false, verificationLevel: 'mock' as const, reasonCodes: ['VERIFICATION_NOT_RECORDED' as const] },
    { operational: false, reasonCodes: ['CREDENTIALS_NOT_PROVISIONED' as const] },
  ]) {
    assert.equal(createGatewayCapabilityAdvertisementPolicy(report(state))(target), false);
  }
});

test('a live Codex bundle with no usage bound remains nonadvertisable', () => {
  const readiness = projectGatewayCapabilityReadiness({
    extensions: { providerBundles: [{ bundle: 'openai-codex', enabled: true }] },
    facts: {
      dispatch: { generic: true, routedEndpointScopes: ['codex-responses'] },
      bundles: {
        catalogProviderIds: ['openai-codex'],
        catalogEndpointScopesByProvider: new Map([['openai-codex', ['codex-responses']]]),
        pricedEndpointScopesByProvider: new Map([['openai-codex', ['codex-responses']]]),
        credentialProviderIds: ['openai-codex'],
      },
      mediaStorages: [],
      tlsFingerprintProfiles: [],
      verification: { 'provider-bundle:openai-codex': 'live' },
      unavailableUsageBoundProviderIds: ['openai-codex'],
    },
  });
  assert.equal(readiness.capabilities[0]?.verified, true);
  assert.equal(readiness.capabilities[0]?.operational, false);
  assert.deepEqual(readiness.capabilities[0]?.reasonCodes, ['USAGE_BOUNDS_UNAVAILABLE']);
  assert.equal(
    createGatewayCapabilityAdvertisementPolicy(readiness)({
      providerId: 'openai-codex',
      productId: 'codex-chatgpt',
      endpoint: 'codex-responses',
    }),
    false,
  );
});

test('missing, malformed, contradictory, duplicate and invalid configuration reports fail closed', () => {
  const valid = report();
  for (const invalid of [
    undefined,
    null,
    {},
    { ...valid, configurationValid: false },
    { ...valid, fatalReasonCodes: ['PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE'] },
    report({ verified: true, verificationLevel: 'mock' }),
    report({ reasonCodes: ['USAGE_BOUNDS_UNAVAILABLE'] }),
    report({ operational: true, assembled: false }),
    { ...valid, capabilities: [...valid.capabilities, ...valid.capabilities] },
    report({ productIds: 'kimi-code' as never }),
  ])
    assert.throws(() => createGatewayCapabilityAdvertisementPolicy(invalid), /facts are unavailable/);
});

test('valid empty reports advertise nothing and policies cannot be widened by later mutation', () => {
  assert.equal(
    createGatewayCapabilityAdvertisementPolicy({
      configurationValid: true,
      fatalReasonCodes: [],
      capabilities: [],
    })(target),
    false,
  );
  const mutable = report({
    verified: false,
    verificationLevel: 'unverified',
    reasonCodes: ['VERIFICATION_NOT_RECORDED'],
  });
  const denied = createGatewayCapabilityAdvertisementPolicy(mutable);
  Object.assign(mutable.capabilities[0] as object, { verified: true, verificationLevel: 'live', reasonCodes: [] });
  assert.equal(denied(target), false);
  assert.equal(createGatewayCapabilityAdvertisementPolicy(mutable)(target), true);
});
