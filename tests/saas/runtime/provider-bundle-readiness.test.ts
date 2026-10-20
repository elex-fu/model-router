import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertGatewayCapabilityAssembly,
  GatewayCapabilityAssemblyError,
  type GatewayCapabilityFacts,
  isGatewayCapabilityFatalReasonCode,
  isGatewayCapabilitySellable,
  projectGatewayCapabilityReadiness,
} from '../../../src/saas/runtime/gateway-capability-readiness.js';
import type {
  GatewayRuntimeModuleExtensionsV2,
  ProviderBundleConfiguration,
} from '../../../src/saas/runtime/gateway-runtime-module.js';
import {
  isBuiltinProviderBundleId,
  PROVIDER_BUNDLE_IDS,
  PROVIDER_BUNDLE_MANIFESTS,
  providerBundleManifest,
} from '../../../src/saas/runtime/provider-bundles.js';

const CLAUDE = 'anthropic-claude';
const OPENROUTER = 'openrouter';
const ZHIPU = 'zhipu';

function emptyFacts(): GatewayCapabilityFacts {
  return {
    dispatch: { generic: true, routedEndpointScopes: [] },
    bundles: {
      catalogProviderIds: [],
      catalogEndpointScopesByProvider: new Map(),
      pricedEndpointScopesByProvider: new Map(),
      credentialProviderIds: [],
    },
    mediaStorages: [],
    tlsFingerprintProfiles: [],
    verification: {},
  };
}

function completeFacts(overrides: Partial<GatewayCapabilityFacts> = {}): GatewayCapabilityFacts {
  return {
    dispatch: {
      generic: true,
      routedEndpointScopes: [
        'claude-messages',
        'codex-responses',
        'gemini-generate-content',
        'grok-responses',
        'bedrock-invoke',
        'vertex-raw-predict',
        'zhipu-glm',
        'zhipu-glm-coding',
        'minimax-m',
        'opencode-go-zen',
      ],
    },
    bundles: {
      catalogProviderIds: PROVIDER_BUNDLE_MANIFESTS.map((manifest) => manifest.providerId),
      catalogEndpointScopesByProvider: new Map(
        PROVIDER_BUNDLE_MANIFESTS.map((manifest) => [manifest.providerId, manifest.endpointScopes]),
      ),
      pricedEndpointScopesByProvider: new Map(
        PROVIDER_BUNDLE_MANIFESTS.map((manifest) => [manifest.providerId, manifest.endpointScopes]),
      ),
      credentialProviderIds: PROVIDER_BUNDLE_MANIFESTS.map((manifest) => manifest.providerId),
    },
    mediaStorages: [],
    tlsFingerprintProfiles: [],
    verification: {},
    ...overrides,
  };
}

function extensions(bundles: readonly ProviderBundleConfiguration[]): GatewayRuntimeModuleExtensionsV2 {
  return { providerBundles: bundles };
}

function bundle(bundleId: string, enabled = true): ProviderBundleConfiguration {
  return { bundle: bundleId, enabled };
}

test('registry exposes the ten implemented provider categories with stable ids', () => {
  assert.equal(PROVIDER_BUNDLE_MANIFESTS.length, 10);
  assert.deepEqual(PROVIDER_BUNDLE_IDS, [
    'anthropic-claude',
    'openai-codex',
    'google-gemini',
    'xai-grok',
    'zhipu',
    'minimax',
    'opencode-go',
    'openrouter',
    'aws-bedrock',
    'google-vertex',
  ]);
  const ids = new Set<string>();
  for (const manifest of PROVIDER_BUNDLE_MANIFESTS) {
    assert.equal(manifest.bundle, manifest.providerId);
    assert.equal(ids.has(manifest.bundle), false);
    ids.add(manifest.bundle);
    assert.ok(manifest.displayName.length > 0);
    assert.ok(manifest.productIds.length > 0);
    assert.ok(manifest.credentialTypes.length > 0);
    assert.ok(manifest.protocols.length > 0);
    assert.ok(manifest.endpointScopes.length > 0);
    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.endpointScopes), true);
    assert.equal(providerBundleManifest(manifest.bundle), manifest);
  }
  assert.equal(isBuiltinProviderBundleId(CLAUDE), true);
  assert.equal(isBuiltinProviderBundleId('not-a-bundle'), false);
  assert.equal(Object.isFrozen(PROVIDER_BUNDLE_IDS), true);
});

test('an empty selection is a valid configuration with no capabilities', () => {
  const report = projectGatewayCapabilityReadiness({ extensions: extensions([]), facts: emptyFacts() });
  assert.equal(report.configurationValid, true);
  assert.deepEqual(report.capabilities, []);
  assert.deepEqual(report.fatalReasonCodes, []);
});

test('v1 modules without extensions project an empty report', () => {
  const report = projectGatewayCapabilityReadiness({ facts: completeFacts() });
  assert.equal(report.configurationValid, true);
  assert.deepEqual(report.capabilities, []);
});

test('a disabled bundle stays visible but is never assembled or operational', () => {
  const report = projectGatewayCapabilityReadiness({
    extensions: extensions([bundle(CLAUDE, false)]),
    facts: completeFacts(),
  });
  assert.equal(report.configurationValid, true);
  const [claude] = report.capabilities;
  assert.ok(claude);
  assert.equal(claude.enabled, false);
  assert.equal(claude.assembled, false);
  assert.equal(claude.operational, false);
  assert.equal(claude.verified, false);
  assert.deepEqual(claude.reasonCodes, []);
  assert.equal(isGatewayCapabilitySellable(claude), false);
});

test('a fully wired bundle with a live record is assembled, operational and sellable', () => {
  const report = projectGatewayCapabilityReadiness({
    extensions: extensions([bundle(CLAUDE)]),
    facts: completeFacts({ verification: { 'provider-bundle:anthropic-claude': 'live' } }),
  });
  assert.equal(report.configurationValid, true);
  const [claude] = report.capabilities;
  assert.ok(claude);
  assert.equal(claude.capability, 'provider-bundle:anthropic-claude');
  assert.equal(claude.kind, 'provider-bundle');
  assert.equal(claude.providerId, 'anthropic-claude');
  assert.deepEqual(claude.productIds, ['claude-subscription']);
  assert.deepEqual(claude.endpointScopes, ['claude-messages']);
  assert.deepEqual(claude.unavailableEndpointScopes, []);
  assert.equal(claude.enabled, true);
  assert.equal(claude.assembled, true);
  assert.equal(claude.verified, true);
  assert.equal(claude.operational, true);
  assert.equal(isGatewayCapabilitySellable(claude), true);
  assert.deepEqual(claude.reasonCodes, []);
});

test('an enabled bundle without its dedicated transport is a fatal configuration error', () => {
  const facts = completeFacts();
  facts.dispatch.routedEndpointScopes.splice(facts.dispatch.routedEndpointScopes.indexOf('claude-messages'), 1);
  const report = projectGatewayCapabilityReadiness({ extensions: extensions([bundle(CLAUDE)]), facts });
  assert.equal(report.configurationValid, false);
  assert.deepEqual(report.fatalReasonCodes, ['PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE']);
  const [claude] = report.capabilities;
  assert.ok(claude);
  assert.equal(claude.assembled, false);
  assert.equal(claude.operational, false);
  assert.deepEqual(claude.unavailableEndpointScopes, ['claude-messages']);
  assert.deepEqual(claude.reasonCodes[0], 'PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE');
});

test('a generic bundle rides the shared transport and fails closed without it', () => {
  const withGeneric = projectGatewayCapabilityReadiness({
    extensions: extensions([bundle(OPENROUTER)]),
    facts: completeFacts(),
  });
  assert.equal(withGeneric.capabilities[0]?.assembled, true);

  const withoutGeneric = projectGatewayCapabilityReadiness({
    extensions: extensions([bundle(OPENROUTER)]),
    facts: completeFacts({ dispatch: { generic: false, routedEndpointScopes: [] } }),
  });
  assert.equal(withoutGeneric.configurationValid, false);
  assert.equal(withoutGeneric.capabilities[0]?.assembled, false);
  assert.deepEqual(withoutGeneric.capabilities[0]?.unavailableEndpointScopes, []);
});

test('a CN bundle requires every endpoint scope dedicated transport', () => {
  const facts = completeFacts();
  facts.dispatch.routedEndpointScopes.splice(facts.dispatch.routedEndpointScopes.indexOf('zhipu-glm-coding'), 1);
  const report = projectGatewayCapabilityReadiness({ extensions: extensions([bundle(ZHIPU)]), facts });
  assert.equal(report.configurationValid, false);
  const [zhipu] = report.capabilities;
  assert.ok(zhipu);
  assert.deepEqual(zhipu.unavailableEndpointScopes, ['zhipu-glm-coding']);
  assert.deepEqual(zhipu.endpointScopes, ['zhipu-glm', 'zhipu-glm-coding']);
});

test('an unknown bundle id is fatal even when disabled', () => {
  for (const enabled of [true, false]) {
    const report = projectGatewayCapabilityReadiness({
      extensions: extensions([bundle('not-a-real-bundle', enabled)]),
      facts: completeFacts(),
    });
    assert.equal(report.configurationValid, false);
    assert.deepEqual(report.fatalReasonCodes, ['PROVIDER_BUNDLE_UNKNOWN']);
    const [unknown] = report.capabilities;
    assert.ok(unknown);
    assert.equal(unknown.capability, 'provider-bundle:not-a-real-bundle');
    assert.equal(unknown.label, 'not-a-real-bundle');
    assert.equal(unknown.enabled, enabled);
    assert.equal(unknown.assembled, false);
    assert.deepEqual(unknown.reasonCodes, ['PROVIDER_BUNDLE_UNKNOWN']);
  }
});

test('catalog, price and credential gaps are readiness reasons, not configuration errors', () => {
  const facts = completeFacts();
  facts.bundles.catalogProviderIds = [];
  facts.bundles.catalogEndpointScopesByProvider = new Map();
  facts.bundles.pricedEndpointScopesByProvider = new Map();
  facts.bundles.credentialProviderIds = [];
  const report = projectGatewayCapabilityReadiness({ extensions: extensions([bundle(CLAUDE)]), facts });
  assert.equal(report.configurationValid, true);
  const [claude] = report.capabilities;
  assert.ok(claude);
  assert.equal(claude.assembled, true);
  assert.equal(claude.operational, false);
  assert.deepEqual(claude.reasonCodes, [
    'CATALOG_PROVIDER_MISSING',
    'CATALOG_ENDPOINT_MISSING',
    'SUPPLIER_PRICE_MISSING',
    'CREDENTIALS_NOT_PROVISIONED',
    'VERIFICATION_NOT_RECORDED',
  ]);
});

test('mock verification is visible but never sellable; missing records fail closed', () => {
  const mock = projectGatewayCapabilityReadiness({
    extensions: extensions([bundle(CLAUDE)]),
    facts: completeFacts({ verification: { 'provider-bundle:anthropic-claude': 'mock' } }),
  });
  const [mocked] = mock.capabilities;
  assert.ok(mocked);
  assert.equal(mocked.verificationLevel, 'mock');
  assert.equal(mocked.verified, false);
  assert.equal(mocked.operational, true);
  assert.equal(isGatewayCapabilitySellable(mocked), false);
  assert.ok(mocked.reasonCodes.includes('VERIFICATION_NOT_RECORDED'));

  const malformed = projectGatewayCapabilityReadiness({
    extensions: extensions([bundle(CLAUDE)]),
    facts: completeFacts({
      verification: { 'provider-bundle:anthropic-claude': 'verified-elsewhere' as never },
    }),
  });
  assert.equal(malformed.capabilities[0]?.verificationLevel, 'unverified');
  assert.equal(malformed.capabilities[0]?.verified, false);
});

test('media storage is fatal when unavailable and readiness-gated when mounted', () => {
  const missing = projectGatewayCapabilityReadiness({
    extensions: { providerBundles: [], media: { storage: 's3-primary' } },
    facts: emptyFacts(),
  });
  assert.equal(missing.configurationValid, false);
  assert.deepEqual(missing.fatalReasonCodes, ['MEDIA_STORAGE_UNAVAILABLE']);
  const [missingMedia] = missing.capabilities;
  assert.ok(missingMedia);
  assert.equal(missingMedia.capability, 'media:s3-primary');
  assert.equal(missingMedia.kind, 'media');

  const mounted = projectGatewayCapabilityReadiness({
    extensions: { providerBundles: [], media: { storage: 's3-primary' } },
    facts: { ...emptyFacts(), mediaStorages: ['s3-primary'] },
  });
  assert.equal(mounted.configurationValid, true);
  const [media] = mounted.capabilities;
  assert.ok(media);
  assert.equal(media.enabled, true);
  assert.equal(media.assembled, true);
  assert.equal(media.operational, true);
  assert.deepEqual(media.reasonCodes, ['VERIFICATION_NOT_RECORDED']);
});

test('TLS profile is fatal when the sidecar cannot serve it', () => {
  const missing = projectGatewayCapabilityReadiness({
    extensions: { providerBundles: [], tlsFingerprint: { profile: 'chrome-131' } },
    facts: emptyFacts(),
  });
  assert.equal(missing.configurationValid, false);
  assert.deepEqual(missing.fatalReasonCodes, ['TLS_PROFILE_UNAVAILABLE']);
  const [missingTls] = missing.capabilities;
  assert.ok(missingTls);
  assert.equal(missingTls.capability, 'tls-fingerprint:chrome-131');
  assert.equal(missingTls.kind, 'tls-fingerprint');

  const mounted = projectGatewayCapabilityReadiness({
    extensions: { providerBundles: [], tlsFingerprint: { profile: 'chrome-131' } },
    facts: {
      ...emptyFacts(),
      tlsFingerprintProfiles: ['chrome-131'],
      verification: { 'tls-fingerprint:chrome-131': 'live' },
    },
  });
  assert.equal(mounted.configurationValid, true);
  assert.equal(mounted.capabilities[0]?.assembled, true);
  assert.equal(mounted.capabilities[0]?.verified, true);
});

test('assertGatewayCapabilityAssembly returns valid reports and throws sanitized failures', () => {
  const valid = assertGatewayCapabilityAssembly({
    extensions: extensions([bundle(CLAUDE)]),
    facts: completeFacts(),
  });
  assert.equal(valid.configurationValid, true);

  const configuration = extensions([bundle(CLAUDE)]);
  const [claudeConfig] = configuration.providerBundles;
  assert.ok(claudeConfig);
  const configWithSecrets: ProviderBundleConfiguration = {
    ...claudeConfig,
    parameters: { baseUrl: 'https://secret.internal.example', region: 'test' },
    secretReferences: { apiKey: 'kms://tenant/secret-reference' },
  };
  assert.throws(
    () =>
      assertGatewayCapabilityAssembly({
        extensions: extensions([configWithSecrets]),
        facts: { ...emptyFacts(), dispatch: { generic: false, routedEndpointScopes: [] } },
      }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayCapabilityAssemblyError);
      assert.equal(error.message, 'Managed SaaS gateway capability assembly is invalid');
      assert.equal(error.failures.length, 1);
      assert.equal(error.failures[0]?.capability, 'provider-bundle:anthropic-claude');
      assert.deepEqual(error.failures[0]?.reasonCodes, ['PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE']);
      const rendered = `${error.message} ${JSON.stringify(error.failures)}`;
      assert.equal(rendered.includes('secret.internal.example'), false);
      assert.equal(rendered.includes('kms://tenant/secret-reference'), false);
      return true;
    },
  );
});

test('projection output is frozen and never echoes parameters or secret references', () => {
  const report = projectGatewayCapabilityReadiness({
    extensions: {
      providerBundles: [
        {
          bundle: CLAUDE,
          enabled: true,
          parameters: { marker: 'parameter-marker-value' },
          secretReferences: { token: 'kms://marker/secret-value' },
        },
      ],
    },
    facts: completeFacts(),
  });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.capabilities), true);
  const [claude] = report.capabilities;
  assert.ok(claude);
  assert.equal(Object.isFrozen(claude), true);
  assert.equal(Object.isFrozen(claude.reasonCodes), true);
  assert.equal(JSON.stringify(report).includes('parameter-marker-value'), false);
  assert.equal(JSON.stringify(report).includes('kms://marker/secret-value'), false);
});

test('projection preserves configuration order across bundles, media and TLS', () => {
  const report = projectGatewayCapabilityReadiness({
    extensions: {
      providerBundles: [bundle(OPENROUTER), bundle(CLAUDE, false), bundle(ZHIPU)],
      media: { storage: 's3-primary' },
      tlsFingerprint: { profile: 'chrome-131' },
    },
    facts: completeFacts({ mediaStorages: ['s3-primary'], tlsFingerprintProfiles: ['chrome-131'] }),
  });
  assert.deepEqual(
    report.capabilities.map((capability) => capability.capability),
    [
      'provider-bundle:openrouter',
      'provider-bundle:anthropic-claude',
      'provider-bundle:zhipu',
      'media:s3-primary',
      'tls-fingerprint:chrome-131',
    ],
  );
});

test('fatal reason classification matches the exported sets', () => {
  assert.equal(isGatewayCapabilityFatalReasonCode('PROVIDER_BUNDLE_UNKNOWN'), true);
  assert.equal(isGatewayCapabilityFatalReasonCode('PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE'), true);
  assert.equal(isGatewayCapabilityFatalReasonCode('MEDIA_STORAGE_UNAVAILABLE'), true);
  assert.equal(isGatewayCapabilityFatalReasonCode('TLS_PROFILE_UNAVAILABLE'), true);
  assert.equal(isGatewayCapabilityFatalReasonCode('CATALOG_PROVIDER_MISSING'), false);
  assert.equal(isGatewayCapabilityFatalReasonCode('VERIFICATION_NOT_RECORDED'), false);
});
