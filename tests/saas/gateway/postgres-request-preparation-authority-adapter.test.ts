import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderEligibilityResult } from '../../../src/saas/catalog/types.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import type { RouteCommercialAuthorityRecord } from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { PostgresRequestPreparationAuthorityAdapter } from '../../../src/saas/gateway/postgres-request-preparation-authority-adapter.js';
import type {
  RequestPreparationAuthority,
  RequestPreparationCaller,
  RequestPreparationEntitlement,
} from '../../../src/saas/gateway/request-preparation-service.js';
import type { RouteConfigRecord } from '../../../src/saas/gateway/route-config-service.js';
import type { EffectiveByokEntitlement } from '../../../src/saas/plans/types.js';
import { SaasPricingError } from '../../../src/saas/pricing/index.js';

type Row = Record<string, unknown>;
type Mode = 'byok' | 'platform';

const NOW = '2026-09-28T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const SECRET_SENTINEL = 'plaintext-secret-must-never-escape';

interface Fixture {
  readonly mode: Mode;
  profile: Row;
  alias: Row;
  byokRows: Row[];
  platformRows: Row[];
  accountCapabilities: Row[];
  poolRights: Row[];
  providerScope: string[];
  byokEntitlement: EffectiveByokEntitlement | null;
  planResolverExecutors: unknown[];
  readonly statements: string[];
  /** §4.4 composite: the billing-group resolution the fake store returns. */
  compositeGroup?: { readonly id: string; readonly composite: boolean };
  /** §4.4 composite: enabled registry rows (empty = none). */
  compositeRoutes?: Row[];
  /** §4.4 composite: the ownership-catalog platforms for the requested model. */
  compositeOwnershipPlatforms?: string[];
  /** §4.4 composite: the target capability row (null = none); defaults to the nominal pin. */
  compositeTargetCapability?: { readonly product_id: string; readonly endpoint: string } | null;
  /** §4.4 composite: the catalog eligibility the fake returns for the target. */
  eligibilityResult?: ProviderEligibilityResult;
  /** R3 §8.1: the supplier cost version the fake pricing port resolves (null = none). */
  compositeSupplierCost?: string | null;
  /** R3 §8.1: the identity inputs the composite resolution received. */
  compositeSupplierCostRequests: Array<Record<string, unknown>>;
}

function caller(mode: Mode): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: mode,
    modelScopes: ['public-model'],
    authzVersion: 4,
    entitlementVersion: 5,
    supplyProfileVersion: 6,
    modelScopeVersion: 7,
  };
}

function entitlement(mode: Mode, providerScope: readonly string[]): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 5,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 6,
    supplyMode: mode,
    modelScopeVersion: 7,
    allowedModels: ['public-model'],
    allowedProviderIds: mode === 'byok' ? [...providerScope] : [],
    projectPolicyVersion: 3,
  };
}

function effectiveByokEntitlement(
  allowedProviderIds: readonly string[] = ['provider-a'],
  overrides: Partial<EffectiveByokEntitlement> = {},
): EffectiveByokEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    entitlementId: 'entitlement-a',
    subscriptionId: 'subscription-a',
    snapshot: {
      id: 'snapshot-a',
      tenantId: 'tenant-a',
      orderId: 'order-a',
      planVersionId: 'plan-version-a',
      planId: 'plan-a',
      planVersion: 1,
      allowedProviderIds: [...allowedProviderIds],
      allowedModels: ['public-model'],
      supplyMode: 'byok',
      supplyProfileId: 'profile-a',
      priceVersion: 'price-a',
      priceMinorUnits: '1',
      currency: 'USD',
      termDays: 30,
      policyVersion: 'policy-a',
      snapshotDigest: HASH,
      createdAt: NOW,
    },
    allowedProviderIds: [...allowedProviderIds],
    modelScopes: ['public-model'],
    entitlementAuthzVersion: 5,
    supplyProfileAuthzVersion: 6,
    modelScopeVersion: 7,
    ...overrides,
  };
}

function route(mode: Mode): RouteConfigRecord {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    version: '8',
    publicModelId: 'public-model-id',
    publicModelVersion: '9',
    protocol: 'openai',
    supplyMode: mode,
    targetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    upstreamId: 'opaque-upstream-a',
    endpoint: '/v1/chat/completions',
    status: 'active',
    changedByUserId: 'admin-a',
    createdAt: NOW,
  };
}

function commercial(mode: Mode): RouteCommercialAuthorityRecord {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    routeId: 'route-a',
    routeVersion: '8',
    customerPolicyId: 'customer-policy-a',
    customerPolicyVersion: '2',
    providerPolicyId: 'provider-policy-a',
    providerPolicyVersion: '3',
    contractAttestationId: 'attestation-a',
    customerPriceVersion: mode === 'platform' ? 'price-v1' : null,
    supplierCostVersion: mode === 'platform' ? 'cost-v1' : null,
  };
}

function eligibility(): ProviderEligibilityResult {
  return {
    decision: 'allow',
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'provider-model-a',
    endpoint: '/v1/chat/completions',
    supportLevel: 'supported',
    limited: false,
    capability: { version: 11, protocol: 'openai', validationState: 'verified' },
    rights: {
      rightsId: 'account-rights-a',
      version: 12,
      status: 'active',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  };
}

function baseFixture(mode: Mode): Fixture {
  return {
    mode,
    profile: {
      tenant_id: 'tenant-a',
      id: 'profile-a',
      supply_mode: mode,
      status: 'active',
      authz_version: '6',
      model_scopes: ['public-model'],
    },
    alias: {
      public_model_id: 'public-model-id',
      version: '9',
      alias: 'public-model',
      model_status: 'active',
      provider_id: 'provider-a',
      product_id: 'product-a',
      model: 'provider-model-a',
      endpoint_scope: ['/v1/chat/completions'],
      version_status: 'active',
    },
    byokRows: mode === 'byok' ? [byokCandidate()] : [],
    platformRows: mode === 'platform' ? [platformCandidate()] : [],
    accountCapabilities: [{ capability_version: '11' }],
    poolRights: mode === 'platform' ? [poolRight()] : [],
    providerScope: ['provider-a'],
    byokEntitlement: effectiveByokEntitlement(),
    planResolverExecutors: [],
    compositeSupplierCost: 'supplier-cost-gemini',
    compositeSupplierCostRequests: [],
    statements: [],
  };
}

function byokCandidate(overrides: Row = {}): Row {
  return {
    mapping_tenant_id: 'tenant-a',
    mapping_profile_id: 'profile-a',
    mapping_supply_mode: 'byok',
    account_id: 'tenant-account-a',
    mapping_provider_id: 'provider-a',
    mapping_product_id: 'product-a',
    mapping_account_authz_version: '5',
    mapping_status: 'active',
    mapping_effective_at: '2026-01-01T00:00:00.000Z',
    mapping_expires_at: null,
    mapping_authz_version: '2',
    mapping_evidence_ref: 'mapping-evidence-a',
    mapping_evidence_sha256: HASH,
    account_owner_kind: 'tenant',
    account_supply_mode: 'byok',
    account_provider_id: 'provider-a',
    account_product_id: 'product-a',
    credential_type: 'api-key',
    region: 'us-east-1',
    purpose: 'inference',
    account_rights_id: 'account-rights-a',
    account_rights_version: '12',
    account_status: 'active',
    account_validation_state: 'verified',
    account_authz_version: '5',
    credential_owner_kind: 'tenant',
    credential_supply_mode: 'byok',
    credential_id: 'tenant-credential-a',
    credential_account_id: 'tenant-account-a',
    credential_provider_id: 'provider-a',
    credential_product_id: 'product-a',
    credential_status: 'active',
    credential_validation_state: 'verified',
    credential_current_version: '13',
    credential_expires_at: null,
    credential_authz_version: '14',
    version_owner_kind: 'tenant',
    version_supply_mode: 'byok',
    version_credential_id: 'tenant-credential-a',
    credential_version: '13',
    version_status: 'active',
    version_expires_at: null,
    ciphertext: SECRET_SENTINEL,
    ...overrides,
  };
}

function platformCandidate(overrides: Row = {}): Row {
  return {
    grant_tenant_id: 'tenant-a',
    grant_profile_id: 'profile-a',
    grant_supply_mode: 'platform',
    grant_status: 'active',
    grant_effective_at: '2026-01-01T00:00:00.000Z',
    grant_expires_at: null,
    grant_authz_version: '15',
    grant_profile_authz_version: '6',
    grant_pool_authz_version: '16',
    grant_evidence_ref: 'grant-evidence-a',
    grant_evidence_sha256: HASH,
    pool_id: 'platform-pool-a',
    pool_provider_id: 'provider-a',
    pool_product_id: 'product-a',
    pool_status: 'active',
    pool_validation_state: 'verified',
    pool_authz_version: '16',
    pool_credential_type: 'api-key',
    pool_region: 'us-east-1',
    pool_purpose: 'inference',
    pool_rights_id: 'pool-rights-a',
    pool_rights_version: '17',
    account_id: 'platform-account-a',
    member_provider_id: 'provider-a',
    member_product_id: 'product-a',
    member_status: 'active',
    member_authz_version: '18',
    member_account_authz_version: '19',
    account_owner_kind: 'platform',
    account_supply_mode: 'platform',
    account_provider_id: 'provider-a',
    account_product_id: 'product-a',
    credential_type: 'api-key',
    region: 'us-east-1',
    purpose: 'inference',
    account_rights_id: 'account-rights-a',
    account_rights_version: '12',
    account_status: 'active',
    account_validation_state: 'verified',
    account_authz_version: '19',
    credential_owner_kind: 'platform',
    credential_supply_mode: 'platform',
    credential_id: 'platform-credential-a',
    credential_account_id: 'platform-account-a',
    credential_provider_id: 'provider-a',
    credential_product_id: 'product-a',
    credential_status: 'active',
    credential_validation_state: 'verified',
    credential_current_version: '20',
    credential_expires_at: null,
    credential_authz_version: '21',
    version_owner_kind: 'platform',
    version_supply_mode: 'platform',
    version_credential_id: 'platform-credential-a',
    credential_version: '20',
    version_status: 'active',
    version_expires_at: null,
    ciphertext: SECRET_SENTINEL,
    ...overrides,
  };
}

function byokCandidateFor(accountId: string, credentialId: string, overrides: Row = {}): Row {
  return byokCandidate({
    account_id: accountId,
    credential_id: credentialId,
    credential_account_id: accountId,
    version_credential_id: credentialId,
    ...overrides,
  });
}

function platformCandidateFor(accountId: string, credentialId: string, overrides: Row = {}): Row {
  return platformCandidate({
    account_id: accountId,
    credential_id: credentialId,
    credential_account_id: accountId,
    version_credential_id: credentialId,
    ...overrides,
  });
}

function poolRight(overrides: Row = {}): Row {
  return {
    rights_id: 'pool-rights-a',
    version: '17',
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    supply_mode: 'platform',
    region: 'us-east-1',
    purpose: 'inference',
    model_scope: ['provider-model-a'],
    endpoint_scope: ['/v1/chat/completions'],
    effective_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    approval_ref: 'approval-a',
    evidence_ref: 'rights-evidence-a',
    evidence_sha256: HASH,
    status: 'active',
    ...overrides,
  };
}

class FakeAuthorityFactsRepository {
  constructor(readonly fixture: Fixture) {}

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const executor: SqlExecutor = {
      query: async <ResultRow>(sql: string): Promise<SqlResult<ResultRow>> => {
        this.fixture.statements.push(sql);
        let rows: Row[];
        if (sql.startsWith('SET TRANSACTION')) rows = [];
        else if (sql.includes('SELECT clock_timestamp()')) rows = [{ authority_now: NOW }];
        else if (sql.includes('composite-route-store:billing-group'))
          rows = [
            {
              id: this.fixture.compositeGroup?.id ?? 'default',
              composite: this.fixture.compositeGroup?.composite ?? false,
            },
          ];
        else if (sql.includes('composite-route-store:enabled-routes'))
          rows = structuredClone(this.fixture.compositeRoutes ?? []) as Row[];
        else if (sql.includes('composite-route-store:model-ownership'))
          rows = (this.fixture.compositeOwnershipPlatforms ?? []).map((provider_id) => ({ provider_id }));
        else if (sql.includes('composite-route-store:target-capability'))
          rows = this.fixture.compositeTargetCapability === null ? [] : [this.fixture.compositeTargetCapability];
        else if (sql.includes('composite-route-store:')) rows = [];
        else if (sql.includes('FROM saas_public_model_versions')) rows = [this.fixture.alias];
        else if (sql.includes('FROM saas_customer_price_versions')) rows = [{ currency: 'USD' }];
        else if (sql.includes('FROM saas_supply_profiles')) rows = [this.fixture.profile];
        else if (sql.includes('preparation-authority:byok')) rows = this.fixture.byokRows;
        else if (sql.includes('preparation-authority:platform')) rows = this.fixture.platformRows;
        else if (sql.includes('preparation-authority:account-capability')) rows = this.fixture.accountCapabilities;
        else if (sql.includes('FROM saas_provider_rights')) rows = this.fixture.poolRights;
        else throw new Error(`Unexpected query in fake authority repository: ${sql}`);
        return { rows: structuredClone(rows) as ResultRow[], rowCount: rows.length };
      },
    };
    return work(executor);
  }
}

function adapter(fixture: Fixture): PostgresRequestPreparationAuthorityAdapter {
  const facts = new FakeAuthorityFactsRepository(fixture);
  return new PostgresRequestPreparationAuthorityAdapter({
    database: facts,
    routes: {
      async resolve() {
        return route(fixture.mode);
      },
    },
    commercial: {
      async resolveDispatchableRoute() {
        return commercial(fixture.mode);
      },
    },
    catalog: {
      async evaluateProviderEligibility() {
        return fixture.eligibilityResult ?? eligibility();
      },
    },
    byokEntitlements: {
      async resolveBoundForRequest(_context, _entitlementId, options) {
        fixture.planResolverExecutors.push(options?.executor);
        return fixture.byokEntitlement;
      },
    },
    // R3 §8.1: composite dispatches resolve the supplier cost version on the
    // resolved target-platform identity through this port.
    pricing: {
      async resolveSupplierCostVersion(input) {
        fixture.compositeSupplierCostRequests.push(input);
        if (fixture.compositeSupplierCost === null) {
          throw new SaasPricingError('PRICE_VERSION_NOT_EFFECTIVE');
        }
        return {
          id: fixture.compositeSupplierCost,
          ...input,
        };
      },
    },
  });
}

async function resolve(
  mode: Mode,
  fixtureOverrides: (fixture: Fixture) => void = () => {},
): Promise<{
  readonly fixture: Fixture;
  readonly result: Awaited<ReturnType<PostgresRequestPreparationAuthorityAdapter['resolve']>>;
}> {
  const fixture = baseFixture(mode);
  fixtureOverrides(fixture);
  const result = await adapter(fixture).resolve({
    caller: caller(mode),
    entitlement: entitlement(mode, fixture.providerScope),
    publicModel: 'public-model',
    protocol: 'openai',
  });
  return { fixture, result };
}

test('resolves one active BYOK mapping/account/credential without platform authority fields', async () => {
  const { fixture, result } = await resolve('byok');
  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  const authority: RequestPreparationAuthority = result.value;
  assert.equal(authority.route.routeConfigId, 'route-a');
  assert.equal(authority.route.publicModelId, 'public-model-id');
  assert.equal(authority.candidate.supplyMode, 'byok');
  if (authority.candidate.supplyMode !== 'byok') assert.fail('expected BYOK candidate');
  assert.equal(authority.candidate.accountId, 'tenant-account-a');
  assert.equal(authority.candidate.credentialId, 'tenant-credential-a');
  assert.equal(authority.candidate.profileAccountAuthzVersion, 2);
  assert.equal(authority.candidate.supplierCostVersion, null);
  assert.equal(authority.candidates, undefined);
  assert.equal(authority.poolMemberAuthzVersion, null);
  assert.deepEqual(authority.modelMappingRules, [
    {
      pattern: 'public-model',
      mappedModel: 'provider-model-a',
      mappingSource: 'alias',
      mappingVersion: 9,
    },
  ]);
  assert.deepEqual(authority.modelResolution, {
    requestedModel: 'public-model',
    mappedModel: 'provider-model-a',
    resolvedModel: 'provider-model-a',
    mappingSource: 'alias',
    mappingVersion: 9,
  });
  assert.equal(authority.route.providerProtocol, 'openai');
  assert.equal(Object.hasOwn(authority.candidate, 'poolId'), false);
  assert.equal(
    fixture.statements.some((sql) => sql.includes('preparation-authority:platform')),
    false,
  );
  assert.equal(JSON.stringify(authority).includes(SECRET_SENTINEL), false);
  assert.equal(
    fixture.statements.some((sql) => /ciphertext|wrapped_dek|secret/i.test(sql)),
    false,
  );
  assert.equal(fixture.planResolverExecutors.length, 1);
  assert.ok(fixture.planResolverExecutors[0]);
});

test('enforces the authoritative BYOK provider scope before candidate resolution', async (t) => {
  await t.test('denied provider', async () => {
    const { fixture, result } = await resolve('byok', (current) => {
      current.providerScope = ['provider-b'];
      current.byokEntitlement = effectiveByokEntitlement(['provider-b']);
    });
    assert.deepEqual(result, {
      decision: 'reject',
      code: 'account_denied',
      message: 'A unique active upstream authority could not be established.',
    });
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
      false,
    );
  });

  await t.test('missing scope', async () => {
    const { fixture, result } = await resolve('byok', (current) => {
      current.byokEntitlement = null;
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
      false,
    );
  });

  await t.test('empty scope', async () => {
    const { fixture, result } = await resolve('byok', (current) => {
      current.byokEntitlement = effectiveByokEntitlement([], {
        snapshot: { ...effectiveByokEntitlement().snapshot, allowedProviderIds: [] },
      });
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
      false,
    );
  });

  await t.test('stale entitlement version', async () => {
    const { fixture, result } = await resolve('byok', (current) => {
      current.byokEntitlement = effectiveByokEntitlement(['provider-a'], { entitlementAuthzVersion: 4 });
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
      false,
    );
  });

  await t.test('cross-project entitlement', async () => {
    const { fixture, result } = await resolve('byok', (current) => {
      current.byokEntitlement = effectiveByokEntitlement(['provider-a'], { projectId: 'project-other' });
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
      false,
    );
  });
});

test('platform supply remains governed by Provider Rights and does not consult BYOK plan scope', async () => {
  const { fixture, result } = await resolve('platform', (current) => {
    current.byokEntitlement = null;
  });
  assert.equal(result.decision, 'allow');
  assert.equal(fixture.planResolverExecutors.length, 0);
});

test('resolves one effective platform grant/member/account/credential and carries every epoch', async () => {
  const { fixture, result } = await resolve('platform');
  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  const authority = result.value;
  assert.equal(authority.candidate.supplyMode, 'platform');
  if (authority.candidate.supplyMode !== 'platform') assert.fail('expected platform candidate');
  assert.equal(authority.candidate.accountId, 'platform-account-a');
  assert.equal(authority.candidate.credentialId, 'platform-credential-a');
  assert.equal(authority.candidate.poolId, 'platform-pool-a');
  assert.equal(authority.candidate.poolAuthzVersion, 16);
  assert.equal(authority.candidate.poolMemberAccountAuthzVersion, 19);
  assert.equal(authority.candidate.poolMemberAuthzVersion, 18);
  assert.equal(authority.candidates, undefined);
  assert.equal(authority.poolMemberAuthzVersion, 18);
  assert.equal(authority.candidate.poolGrantAuthzVersion, 15);
  assert.equal(authority.candidate.poolGrantProfileAuthzVersion, 6);
  assert.equal(authority.candidate.poolGrantPoolAuthzVersion, 16);
  assert.equal(authority.commercial.customerPriceVersion, 'price-v1');
  assert.equal(authority.commercial.supplierCostVersion, 'cost-v1');
  assert.equal(authority.modelMappingRules?.[0]?.mappingSource, 'alias');
  assert.equal(authority.modelMappingRules?.[0]?.mappingVersion, 9);
  assert.deepEqual(authority.modelResolution, {
    requestedModel: 'public-model',
    mappedModel: 'provider-model-a',
    resolvedModel: 'provider-model-a',
    mappingSource: 'alias',
    mappingVersion: 9,
  });
  assert.equal(Object.hasOwn(authority.candidate, 'profileAccountAuthzVersion'), false);
  assert.equal(
    fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
    false,
  );
  assert.equal(JSON.stringify(authority).includes(SECRET_SENTINEL), false);
});

test('fails closed with the same safe account denial when no candidate is eligible', async (t) => {
  for (const mode of ['byok', 'platform'] as const) {
    await t.test(mode, async () => {
      const { result } = await resolve(mode, (fixture) => {
        if (mode === 'byok') fixture.byokRows = [];
        else fixture.platformRows = [];
      });
      assert.deepEqual(result, {
        decision: 'reject',
        code: 'account_denied',
        message: 'A unique active upstream authority could not be established.',
      });
    });
  }
});

test('enumerates multiple eligible candidates in stable order while keeping supply modes isolated', async (t) => {
  await t.test('BYOK', async () => {
    const { fixture, result } = await resolve('byok', (current) => {
      current.byokRows = [
        byokCandidateFor('tenant-account-b', 'tenant-credential-b'),
        byokCandidateFor('tenant-account-a', 'tenant-credential-a'),
      ];
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    assert.deepEqual(
      result.value.candidates?.map((candidate) => candidate.accountId),
      ['tenant-account-a', 'tenant-account-b'],
    );
    assert.equal(result.value.candidate.accountId, 'tenant-account-a');
    assert.equal(result.value.poolMemberAuthzVersion, null);
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:platform')),
      false,
    );
  });

  await t.test('platform', async () => {
    const { fixture, result } = await resolve('platform', (current) => {
      current.platformRows = [
        platformCandidateFor('platform-account-b', 'platform-credential-b', { member_authz_version: '28' }),
        platformCandidateFor('platform-account-a', 'platform-credential-a', { member_authz_version: '18' }),
      ];
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    assert.deepEqual(
      result.value.candidates?.map((candidate) => candidate.accountId),
      ['platform-account-a', 'platform-account-b'],
    );
    assert.deepEqual(
      result.value.candidates?.map((candidate) =>
        candidate.supplyMode === 'platform' ? [candidate.accountId, candidate.poolMemberAuthzVersion] : null,
      ),
      [
        ['platform-account-a', 18],
        ['platform-account-b', 28],
      ],
    );
    assert.equal(result.value.candidate.accountId, 'platform-account-a');
    assert.equal(result.value.poolMemberAuthzVersion, 18);
    assert.equal(
      fixture.statements.some((sql) => sql.includes('preparation-authority:byok')),
      false,
    );
  });
});

test('filters cross-tenant, entitlement, and rights-mismatched rows without widening the surviving candidate set', async (t) => {
  await t.test('BYOK', async () => {
    const { result } = await resolve('byok', (fixture) => {
      fixture.byokRows = [
        byokCandidate({ mapping_tenant_id: 'tenant-other' }),
        byokCandidate({ mapping_profile_id: 'profile-other' }),
        byokCandidate({ account_rights_id: 'account-rights-other' }),
        byokCandidateFor('tenant-account-b', 'tenant-credential-b'),
      ];
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    assert.equal(result.value.candidates, undefined);
    assert.equal(result.value.candidate.accountId, 'tenant-account-b');
  });

  await t.test('platform', async () => {
    const { result } = await resolve('platform', (fixture) => {
      fixture.platformRows = [
        platformCandidate({ grant_tenant_id: 'tenant-other' }),
        platformCandidate({ grant_profile_id: 'profile-other' }),
        platformCandidate({ account_rights_id: 'account-rights-other' }),
        platformCandidateFor('platform-account-b', 'platform-credential-b'),
      ];
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    assert.equal(result.value.candidates, undefined);
    assert.equal(result.value.candidate.accountId, 'platform-account-b');
  });
});

test('fails closed on unsupported duplicate account authority even when credentials differ', async (t) => {
  await t.test('BYOK', async () => {
    const { result } = await resolve('byok', (fixture) => {
      fixture.byokRows = [
        byokCandidateFor('tenant-account-a', 'tenant-credential-a'),
        byokCandidateFor('tenant-account-a', 'tenant-credential-b'),
      ];
    });
    assert.deepEqual(result, {
      decision: 'reject',
      code: 'account_denied',
      message: 'A unique active upstream authority could not be established.',
    });
  });

  await t.test('platform', async () => {
    const { result } = await resolve('platform', (fixture) => {
      fixture.platformRows = [
        platformCandidateFor('platform-account-a', 'platform-credential-a'),
        platformCandidateFor('platform-account-a', 'platform-credential-b'),
      ];
    });
    assert.deepEqual(result, {
      decision: 'reject',
      code: 'account_denied',
      message: 'A unique active upstream authority could not be established.',
    });
  });
});

test('rejects inactive relationships and stale account/profile epochs', async (t) => {
  const cases: readonly { readonly label: string; readonly mode: Mode; readonly row: Row }[] = [
    { label: 'inactive BYOK mapping', mode: 'byok', row: byokCandidate({ mapping_status: 'disabled' }) },
    {
      label: 'BYOK account epoch mismatch',
      mode: 'byok',
      row: byokCandidate({ mapping_account_authz_version: '4' }),
    },
    { label: 'inactive platform grant', mode: 'platform', row: platformCandidate({ grant_status: 'disabled' }) },
    {
      label: 'platform member account epoch mismatch',
      mode: 'platform',
      row: platformCandidate({ member_account_authz_version: '18' }),
    },
    {
      label: 'stale platform profile epoch',
      mode: 'platform',
      row: platformCandidate({ grant_profile_authz_version: '5' }),
    },
  ];
  for (const item of cases) {
    await t.test(item.label, async () => {
      const { result } = await resolve(item.mode, (fixture) => {
        if (item.mode === 'byok') fixture.byokRows = [item.row];
        else fixture.platformRows = [item.row];
      });
      assert.equal(result.decision, 'reject');
      if (result.decision === 'reject') {
        assert.equal(result.code, 'account_denied');
        assert.equal(result.message, 'A unique active upstream authority could not be established.');
        assert.equal(result.message.includes(SECRET_SENTINEL), false);
      }
    });
  }
});

test('fails closed when catalog mapping provenance is unknown or versionless', async (t) => {
  await t.test('unknown source', async () => {
    const { result } = await resolve('byok', (fixture) => {
      fixture.alias.mapping_source = 'database-guess';
    });
    assert.deepEqual(result, {
      decision: 'reject',
      code: 'route_denied',
      message: 'A current route and commercial authority could not be established.',
    });
  });
  await t.test('explicit missing mapping revision', async () => {
    const { result } = await resolve('byok', (fixture) => {
      fixture.alias.mapping_source = 'alias';
      fixture.alias.mapping_version = null;
    });
    assert.deepEqual(result, {
      decision: 'reject',
      code: 'route_denied',
      message: 'A current route and commercial authority could not be established.',
    });
  });
});

/*
 * §4.4 composite model routing (task #18): when the request's billing group
 * is marked composite, the three-level resolver replaces the public model
 * version's nominal provider/product/model/endpoint pin with the resolved
 * target platform's. New-behavior tests live here so the pre-composite
 * assertions above stay untouched (the #5/F2 separate-file convention).
 */
const GEMINI_PLATFORM = 'google-gemini';
const GEMINI_PRODUCT = 'gemini-subscription';
const GEMINI_ENDPOINT = 'gemini-generate-content';
const GEMINI_UPSTREAM_MODEL = 'gemini-2.5-pro';

function geminiEligibility(): ProviderEligibilityResult {
  return {
    decision: 'allow',
    providerId: GEMINI_PLATFORM,
    productId: GEMINI_PRODUCT,
    model: GEMINI_UPSTREAM_MODEL,
    endpoint: GEMINI_ENDPOINT,
    supportLevel: 'supported',
    limited: false,
    capability: { version: 11, protocol: 'openai', validationState: 'verified' },
    rights: {
      rightsId: 'account-rights-a',
      version: 12,
      status: 'active',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
  };
}

function geminiPlatformRow(): Row {
  return platformCandidate({
    pool_provider_id: GEMINI_PLATFORM,
    pool_product_id: GEMINI_PRODUCT,
    member_provider_id: GEMINI_PLATFORM,
    member_product_id: GEMINI_PRODUCT,
    account_provider_id: GEMINI_PLATFORM,
    account_product_id: GEMINI_PRODUCT,
    credential_provider_id: GEMINI_PLATFORM,
    credential_product_id: GEMINI_PRODUCT,
  });
}

function geminiPoolRight(overrides: Row = {}): Row {
  return poolRight({
    provider_id: GEMINI_PLATFORM,
    product_id: GEMINI_PRODUCT,
    model_scope: [GEMINI_UPSTREAM_MODEL],
    endpoint_scope: [GEMINI_ENDPOINT],
    ...overrides,
  });
}

function compositeRouteRow(): Row {
  return {
    id: '5',
    group_id: 'composite-a',
    public_model: 'public-model',
    match_type: 'exact',
    target_platform: GEMINI_PLATFORM,
    upstream_model: GEMINI_UPSTREAM_MODEL,
    endpoint: 'any',
    priority: 100,
    enabled: true,
    notes: '',
  };
}

test('composite groups resolve the serving platform and rewrite the model with provenance', async (t) => {
  await t.test('a Level-1 route decision swaps the nominal pin end to end', async () => {
    const { fixture, result } = await resolve('platform', (current) => {
      current.compositeGroup = { id: 'composite-a', composite: true };
      current.compositeRoutes = [compositeRouteRow()];
      current.compositeOwnershipPlatforms = [];
      current.compositeTargetCapability = { product_id: GEMINI_PRODUCT, endpoint: GEMINI_ENDPOINT };
      current.eligibilityResult = geminiEligibility();
      current.platformRows = [geminiPlatformRow()];
      current.poolRights = [geminiPoolRight()];
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    const authority: RequestPreparationAuthority = result.value;
    assert.equal(authority.candidate.providerId, GEMINI_PLATFORM);
    assert.equal(authority.candidate.productId, GEMINI_PRODUCT);
    assert.equal(authority.candidate.resolvedModel, GEMINI_UPSTREAM_MODEL);
    assert.equal(authority.candidate.endpoint, GEMINI_ENDPOINT);
    assert.equal(authority.route.endpoint, GEMINI_ENDPOINT);
    // R3 §8.1: the supplier cost version is resolved per attempt on the
    // TARGET identity (not the nominal route's version), and the frozen
    // supply identity + nominal customer identity ride the authority.
    assert.equal(authority.candidate.supplierCostVersion, 'supplier-cost-gemini');
    assert.deepEqual(authority.supplyBilling, {
      providerId: GEMINI_PLATFORM,
      productId: GEMINI_PRODUCT,
      upstreamModel: GEMINI_UPSTREAM_MODEL,
      providerOperation: 'chat.completions',
      supplierCostVersion: 'supplier-cost-gemini',
      meteringPolicyVersion: '3',
    });
    assert.deepEqual(authority.customerPriceIdentity, {
      providerId: 'provider-a',
      productId: 'product-a',
      endpoint: '/v1/chat/completions',
    });
    assert.equal(fixture.compositeSupplierCostRequests.length, 1);
    assert.deepEqual(fixture.compositeSupplierCostRequests[0], {
      publicModelId: 'public-model-id',
      publicModelVersion: '9',
      providerId: GEMINI_PLATFORM,
      productId: GEMINI_PRODUCT,
      resolvedModel: GEMINI_UPSTREAM_MODEL,
      protocol: 'openai',
      endpoint: GEMINI_ENDPOINT,
      currency: 'USD',
      at: fixture.compositeSupplierCostRequests[0]?.at,
    });
    assert.deepEqual(authority.composite, {
      billingGroupId: 'composite-a',
      source: 'route',
      routeId: '5',
      targetPlatform: GEMINI_PLATFORM,
      productId: GEMINI_PRODUCT,
      upstreamModel: GEMINI_UPSTREAM_MODEL,
      endpoint: GEMINI_ENDPOINT,
    });
    // The rewrite carries explicit provenance (the payload compiler's
    // non-identity enforcement): alias mapping with the route id as version.
    assert.deepEqual(authority.modelResolution, {
      requestedModel: 'public-model',
      mappedModel: GEMINI_UPSTREAM_MODEL,
      resolvedModel: GEMINI_UPSTREAM_MODEL,
      mappingSource: 'alias',
      mappingVersion: 5,
    });
    assert.deepEqual(authority.modelMappingRules, [
      {
        pattern: 'public-model',
        mappedModel: GEMINI_UPSTREAM_MODEL,
        mappingSource: 'alias',
        mappingVersion: 5,
      },
    ]);
    for (const marker of [
      'composite-route-store:billing-group',
      'composite-route-store:enabled-routes',
      'composite-route-store:model-ownership',
      'composite-route-store:target-capability',
    ]) {
      assert.ok(
        fixture.statements.some((sql) => sql.includes(marker)),
        `missing ${marker}`,
      );
    }
  });

  await t.test('a Level-2 ownership decision passes the requested model through', async () => {
    const { result } = await resolve('platform', (current) => {
      current.compositeGroup = { id: 'composite-a', composite: true };
      current.compositeRoutes = [];
      current.compositeOwnershipPlatforms = [GEMINI_PLATFORM];
      current.compositeTargetCapability = { product_id: GEMINI_PRODUCT, endpoint: GEMINI_ENDPOINT };
      current.eligibilityResult = {
        ...geminiEligibility(),
        model: 'public-model',
      };
      current.platformRows = [geminiPlatformRow()];
      current.poolRights = [geminiPoolRight({ model_scope: ['public-model'] })];
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    const authority: RequestPreparationAuthority = result.value;
    assert.deepEqual(
      [authority.composite?.source, authority.candidate.providerId, authority.candidate.resolvedModel],
      ['account_model', GEMINI_PLATFORM, 'public-model'],
    );
    // R3 §8.1: the Level-2 decision also freezes the resolved supply identity.
    assert.equal(authority.candidate.supplierCostVersion, 'supplier-cost-gemini');
    assert.equal(authority.supplyBilling?.upstreamModel, 'public-model');
  });

  await t.test('an unknown model fails closed with the safe route denial', async () => {
    const { result } = await resolve('platform', (current) => {
      current.compositeGroup = { id: 'composite-a', composite: true };
      current.compositeRoutes = [];
      current.compositeOwnershipPlatforms = [];
    });
    assert.equal(result.decision, 'reject');
    if (result.decision !== 'reject') return;
    assert.equal(result.code, 'route_denied');
  });

  await t.test('BYOK keeps the nominal pin even when the group is composite', async () => {
    const { result } = await resolve('byok', (current) => {
      current.compositeGroup = { id: 'composite-a', composite: true };
    });
    assert.equal(result.decision, 'allow');
    if (result.decision !== 'allow') return;
    const authority: RequestPreparationAuthority = result.value;
    assert.equal(authority.candidate.providerId, 'provider-a');
    assert.equal(authority.composite, undefined);
  });
});
