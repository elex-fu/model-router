import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  assertGatewayCapabilityAssembly,
  projectGatewayCapabilityReadiness,
} from '../../../src/saas/runtime/gateway-capability-readiness.js';
import type { GatewayRuntimeModuleExtensionsV2 } from '../../../src/saas/runtime/gateway-runtime-module.js';
import {
  collectGatewayCapabilityFacts,
  collectProviderBundleReadinessFacts,
  type GatewayCapabilityDeploymentFacts,
  PROVIDER_BUNDLE_READINESS_SQL,
} from '../../../src/saas/runtime/provider-bundle-readiness-facts.js';

interface FakeRows {
  readonly providers: readonly Record<string, unknown>[];
  readonly catalogScopes: readonly Record<string, unknown>[];
  readonly pricedScopes: readonly Record<string, unknown>[];
  readonly credentialProviders: readonly Record<string, unknown>[];
}

class FakeDatabase implements SqlExecutor {
  readonly queries: string[] = [];

  constructor(private readonly rows: FakeRows) {}

  async query<Row>(sql: string): Promise<SqlResult<Row>> {
    this.queries.push(sql);
    const rows = sql.includes('FROM saas_provider_products')
      ? this.rows.providers
      : sql.includes('FROM saas_provider_capabilities')
        ? this.rows.catalogScopes
        : sql.includes('FROM saas_supplier_cost_versions')
          ? this.rows.pricedScopes
          : sql.includes('FROM saas_platform_provider_accounts')
            ? this.rows.credentialProviders
            : [];
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function emptyRows(): FakeRows {
  return { providers: [], catalogScopes: [], pricedScopes: [], credentialProviders: [] };
}

function deploymentFacts(overrides: Partial<GatewayCapabilityDeploymentFacts> = {}): GatewayCapabilityDeploymentFacts {
  return {
    dispatch: { generic: true, routedEndpointScopes: [] },
    mediaStorages: [],
    tlsFingerprintProfiles: [],
    verification: {},
    ...overrides,
  };
}

test('collector deduplicates provider ids and groups endpoint scopes per provider', async () => {
  const database = new FakeDatabase({
    providers: [
      { provider_id: 'openrouter' },
      { provider_id: 'anthropic-claude' },
      { provider_id: 'openrouter' },
      { provider_id: '' },
      { provider_id: 42 },
    ],
    catalogScopes: [
      { provider_id: 'openrouter', endpoint: 'openrouter-api' },
      { provider_id: 'anthropic-claude', endpoint: 'claude-messages' },
      { provider_id: 'openrouter', endpoint: 'openrouter-api' },
      { provider_id: 'openrouter', endpoint: '  ' },
    ],
    pricedScopes: [
      { provider_id: 'openrouter', endpoint: 'openrouter-api' },
      { provider_id: 'anthropic-claude', endpoint: 'claude-messages' },
    ],
    credentialProviders: [{ provider_id: 'anthropic-claude' }, { provider_id: 'anthropic-claude' }],
  });

  const facts = await collectProviderBundleReadinessFacts(database);

  assert.deepEqual(facts.catalogProviderIds, ['anthropic-claude', 'openrouter']);
  assert.deepEqual(Object.fromEntries(facts.catalogEndpointScopesByProvider), {
    'anthropic-claude': ['claude-messages'],
    openrouter: ['openrouter-api'],
  });
  assert.deepEqual(Object.fromEntries(facts.pricedEndpointScopesByProvider), {
    'anthropic-claude': ['claude-messages'],
    openrouter: ['openrouter-api'],
  });
  assert.deepEqual(facts.credentialProviderIds, ['anthropic-claude']);
  assert.equal(database.queries.length, 4, 'one bounded query per readiness observation');
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.catalogProviderIds), true);
  assert.equal(Object.isFrozen(facts.credentialProviderIds), true);
  for (const scopes of facts.catalogEndpointScopesByProvider.values()) {
    assert.equal(Object.isFrozen(scopes), true);
  }
});

test('collector SQL keeps latest-capability, current-price and verified-credential policy', () => {
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.catalogProviders, /status = 'active'/);
  assert.match(
    PROVIDER_BUNDLE_READINESS_SQL.catalogEndpoints,
    /DISTINCT ON \(capability\.provider_id, capability\.product_id, capability\.model, capability\.endpoint\)/,
  );
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.catalogEndpoints, /capability\.version DESC/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.catalogEndpoints, /latest\.support_level = 'supported'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.catalogEndpoints, /latest\.validation_state = 'verified'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.catalogEndpoints, /product\.status = 'active'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.pricedEndpoints, /product\.status = 'active'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.pricedEndpoints, /public_model\.status = 'active'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.pricedEndpoints, /model\.status = 'active'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.pricedEndpoints, /cost\.effective_at <= clock_timestamp\(\)/);
  assert.match(
    PROVIDER_BUNDLE_READINESS_SQL.pricedEndpoints,
    /cost\.expires_at IS NULL OR cost\.expires_at > clock_timestamp\(\)/,
  );
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.verifiedCredentialProviders, /account\.validation_state = 'verified'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.verifiedCredentialProviders, /credential\.validation_state = 'verified'/);
  assert.match(PROVIDER_BUNDLE_READINESS_SQL.verifiedCredentialProviders, /credential\.current_version IS NOT NULL/);
});

test('deployment facts are copied and frozen before the assembly decision uses them', async () => {
  const database = new FakeDatabase(emptyRows());
  const routing = ['claude-messages'];
  const storages = ['s3-primary'];
  const profiles = ['chrome-131'];
  const verification = { 'provider-bundle:anthropic-claude': 'live' as const };
  const deployment = deploymentFacts({
    dispatch: { generic: true, routedEndpointScopes: routing },
    mediaStorages: storages,
    tlsFingerprintProfiles: profiles,
    verification,
  });

  const facts = await collectGatewayCapabilityFacts(database, deployment);

  routing.push('codex-responses');
  storages.push('s3-secondary');
  profiles.push('safari-18');
  (verification as Record<string, string>)['provider-bundle:openrouter'] = 'live';

  assert.deepEqual(facts.dispatch.routedEndpointScopes, ['claude-messages']);
  assert.deepEqual(facts.mediaStorages, ['s3-primary']);
  assert.deepEqual(facts.tlsFingerprintProfiles, ['chrome-131']);
  assert.deepEqual(facts.verification, { 'provider-bundle:anthropic-claude': 'live' });
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.dispatch), true);
  assert.equal(Object.isFrozen(facts.dispatch.routedEndpointScopes), true);
  assert.equal(Object.isFrozen(facts.mediaStorages), true);
  assert.equal(Object.isFrozen(facts.tlsFingerprintProfiles), true);
  assert.equal(Object.isFrozen(facts.verification), true);
});

test('one provider catalog/price/credential never makes another provider ready', async () => {
  const database = new FakeDatabase({
    providers: [{ provider_id: 'anthropic-claude' }, { provider_id: 'openrouter' }],
    catalogScopes: [{ provider_id: 'anthropic-claude', endpoint: 'claude-messages' }],
    pricedScopes: [{ provider_id: 'anthropic-claude', endpoint: 'claude-messages' }],
    credentialProviders: [{ provider_id: 'anthropic-claude' }],
  });
  const facts = await collectGatewayCapabilityFacts(
    database,
    deploymentFacts({
      dispatch: { generic: true, routedEndpointScopes: ['claude-messages'] },
      verification: {
        'provider-bundle:anthropic-claude': 'live',
        'provider-bundle:openrouter': 'live',
      },
    }),
  );
  const extensions: GatewayRuntimeModuleExtensionsV2 = {
    providerBundles: [
      { bundle: 'anthropic-claude', enabled: true },
      { bundle: 'openrouter', enabled: true },
    ],
  };

  const report = assertGatewayCapabilityAssembly({ extensions, facts });
  assert.equal(report.configurationValid, true);
  const [claude, openrouter] = report.capabilities;
  assert.ok(claude);
  assert.ok(openrouter);
  assert.equal(claude.operational, true);
  assert.equal(openrouter.assembled, true, 'generic transport is mounted');
  assert.equal(openrouter.operational, false);
  assert.deepEqual(openrouter.reasonCodes, [
    'CATALOG_ENDPOINT_MISSING',
    'SUPPLIER_PRICE_MISSING',
    'CREDENTIALS_NOT_PROVISIONED',
  ]);
});

test('collector rejects a missing SQL executor and missing deployment facts', async () => {
  await assert.rejects(
    collectProviderBundleReadinessFacts(undefined as unknown as SqlExecutor),
    (error: unknown) => error instanceof TypeError,
  );
  await assert.rejects(
    collectGatewayCapabilityFacts(
      new FakeDatabase(emptyRows()),
      undefined as unknown as GatewayCapabilityDeploymentFacts,
    ),
    (error: unknown) => error instanceof TypeError,
  );
});

test('an empty inventory projects a valid but not operational bundle', async () => {
  const facts = await collectGatewayCapabilityFacts(new FakeDatabase(emptyRows()), deploymentFacts());
  const report = projectGatewayCapabilityReadiness({
    extensions: { providerBundles: [{ bundle: 'openrouter', enabled: true }] },
    facts,
  });
  const [openrouter] = report.capabilities;
  assert.ok(openrouter);
  assert.equal(openrouter.operational, false);
  assert.deepEqual(openrouter.reasonCodes, [
    'CATALOG_PROVIDER_MISSING',
    'CATALOG_ENDPOINT_MISSING',
    'SUPPLIER_PRICE_MISSING',
    'CREDENTIALS_NOT_PROVISIONED',
    'VERIFICATION_NOT_RECORDED',
  ]);
});
