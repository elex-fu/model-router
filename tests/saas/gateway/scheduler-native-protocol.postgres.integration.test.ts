import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import { SaasCommercialMeteringPolicyService } from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import { PostgresRequestPreparationAuthorityAdapter } from '../../../src/saas/gateway/postgres-request-preparation-authority-adapter.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
  RequestPreparationRouteAuthority,
} from '../../../src/saas/gateway/request-preparation-service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { type Fixture, seedFixture } from '../metering/normal-success-postgres-fixture.js';
import { alignPlatformPool, type PlatformPoolFacts } from './admission-bench-fixture.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationPgConfigured,
  safeCancellationFailure,
} from './pre-dispatch-postgres-fixture.js';

type Mode = 'byok' | 'platform';

const MAX_HEALTH_AGE_MS = 300_000;

function persistedDate(value: unknown): Date {
  assert.ok(value instanceof Date && Number.isFinite(value.getTime()), 'PostgreSQL must return a valid timestamp');
  return value;
}

async function seedHealthyAccount(migrator: SaasDatabase, fixture: Fixture, mode: Mode): Promise<Date> {
  const result = await migrator.query<{ observed_at: Date }>(
    `INSERT INTO saas_provider_account_runtime_health
       (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
        observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
     VALUES ($1,$2,$3,$4,'healthy',0,clock_timestamp(),NULL,'gateway_success',1,1)
     RETURNING observed_at`,
    [
      mode === 'byok' ? fixture.tenantId : 'platform',
      mode === 'byok' ? 'tenant' : 'platform',
      mode === 'byok' ? fixture.tenantId : null,
      fixture.sent.accountId,
    ],
  );
  return persistedDate(result.rows[0]?.observed_at);
}

interface EligibilityObservation {
  rootReads: number;
  transactionCalls: number;
  readonly afterRouteRead?: () => Promise<void>;
}

/** Observe the real restricted-role result without changing SQL, clocks, or returned rows. */
function observeEligibility(
  database: SaasDatabase,
  rowsSeen: unknown[][],
  observation?: EligibilityObservation,
): SaasDatabase {
  async function query<Row>(
    executor: SqlExecutor,
    sql: string,
    values?: readonly unknown[],
    root = false,
  ): Promise<SqlResult<Row>> {
    const result = await executor.query<Row>(sql, values);
    if (
      sql.includes('postgres-provider-account-scheduler:byok-eligibility') ||
      sql.includes('postgres-provider-account-scheduler:platform-eligibility')
    ) {
      rowsSeen.push(result.rows);
      if (observation && root) observation.rootReads += 1;
    }
    if (sql.includes('postgres-provider-account-scheduler:route')) await observation?.afterRouteRead?.();
    return result;
  }
  return {
    query: (sql, values) => query(database, sql, values, true),
    transaction: (work) => {
      if (observation) observation.transactionCalls += 1;
      return database.transaction((tx) => work({ query: (sql, values) => query(tx, sql, values) }));
    },
    migrate: () => database.migrate(),
    verifySchema: () => database.verifySchema(),
    ping: () => database.ping(),
    close: () => database.close(),
  };
}

async function createClockPool(
  migrator: SaasDatabase,
  fixture: Fixture,
  window: { readonly effectiveAt: Date; readonly expiresAt: Date },
): Promise<PlatformPoolFacts & { readonly grantEffectiveAt: Date }> {
  const sent = fixture.sent;
  const rights = await new SaasCatalogService(migrator).registerProviderRightsVersion({
    providerId: text(sent.providerId),
    productId: text(sent.productId),
    credentialType: 'api-key',
    supplyMode: 'platform',
    region: 'test',
    purpose: 'inference',
    modelScope: [text(sent.resolvedModel)],
    endpointScope: [text(sent.endpoint)],
    ...window,
    approvalReference: `scheduler-clock-approval-${randomUUID()}`,
    evidenceReference: `scheduler-clock-rights-${randomUUID()}`,
    evidenceSha256: 'b'.repeat(64),
    audit: { actorUserId: fixture.userId, entryPoint: 'scheduler-clock-pg-test', requestId: randomUUID() },
  });
  const supply = new ProviderSupplyService(migrator, {
    deployment: 'fin057-test',
    environment: 'test',
    kmsKeyId: 'fin057-synthetic-kms',
    sealingKms: {
      generateDataKey: async () => ({
        plaintextKey: Buffer.alloc(32, 0x57),
        ciphertextBlob: Buffer.from('fin057-synthetic-dek'),
      }),
    },
  });
  const pool = await supply.createPlatformProviderPool({
    id: text(sent.upstreamId),
    displayName: 'scheduler clock route-aligned pool',
    providerId: text(sent.providerId),
    productId: text(sent.productId),
    credentialType: 'api-key',
    region: 'test',
    purpose: 'inference',
    rightsId: rights.rightsId,
    rightsVersion: rights.version,
    capabilities: [{ model: text(sent.resolvedModel), endpoint: text(sent.endpoint), version: 1 }],
    status: 'active',
    validationState: 'verified',
  });
  await supply.addPlatformPoolMember({
    poolId: pool.id,
    accountId: text(sent.accountId),
    expectedAccountAuthzVersion: Number(sent.accountAuthzVersion),
  });
  const grant = await supply.grantPlatformPoolToProfile({
    poolId: pool.id,
    tenantId: fixture.tenantId,
    supplyProfileId: fixture.profileId,
    evidenceReference: `scheduler-clock-grant-${randomUUID()}`,
    evidenceSha256: 'd'.repeat(64),
  });
  return {
    poolId: pool.id,
    poolAuthzVersion: pool.authzVersion,
    poolMemberAccountAuthzVersion: Number(sent.accountAuthzVersion),
    poolMemberAuthzVersion: 1,
    poolGrantAuthzVersion: grant.authzVersion,
    poolGrantProfileAuthzVersion: grant.profileAuthzVersion,
    poolGrantPoolAuthzVersion: grant.poolAuthzVersion,
    grantEffectiveAt: new Date(grant.effectiveAt),
  };
}

/** The right window is the only deliberately invalid eligibility fact in the negative fixtures. */
async function assertClockFixtureAuthority(
  gateway: SaasDatabase,
  fixture: Fixture,
  selected: RequestPreparationCandidateAuthority,
  pool: PlatformPoolFacts,
  expectedRightWindow: { readonly effective: boolean; readonly unexpired: boolean },
): Promise<void> {
  const result = await gateway.query<Record<string, unknown>>(
    `WITH checked AS MATERIALIZED (SELECT clock_timestamp() AS now)
     SELECT product.status = 'active' AS product_active,
            profile.status = 'active' AND profile.supply_mode = 'platform'
              AND profile.authz_version = $4 AS profile_current,
            account.status = 'active' AND account.validation_state = 'verified'
              AND account.authz_version = $5 AS account_current,
            credential.status = 'active' AND credential.validation_state = 'verified'
              AND credential.current_version = $6 AND credential.authz_version = $7
              AND (credential.expires_at IS NULL OR credential.expires_at > checked.now) AS credential_current,
            version.status = 'active' AND (version.expires_at IS NULL OR version.expires_at > checked.now)
              AS version_current,
            account_rights.status = 'active' AND account_rights.effective_at <= checked.now
              AND (account_rights.expires_at IS NULL OR account_rights.expires_at > checked.now)
              AS account_rights_current,
            pool.status = 'active' AND pool.validation_state = 'verified' AND pool.authz_version = $8
              AS pool_current,
            member.status = 'active' AND member.authz_version = $9
              AND member.account_authz_version = account.authz_version AS member_current,
            grant_row.status = 'active' AND grant_row.authz_version = $10
              AND grant_row.profile_authz_version = profile.authz_version
              AND grant_row.pool_authz_version = pool.authz_version
              AND grant_row.effective_at <= checked.now
              AND (grant_row.expires_at IS NULL OR grant_row.expires_at > checked.now) AS grant_current,
            rights.status = 'active' AND rights.model_scope @> ARRAY[$11]::text[]
              AND rights.endpoint_scope @> ARRAY[$12]::text[] AS pool_rights_scope,
            rights.effective_at <= checked.now AS pool_rights_effective,
            rights.expires_at > checked.now AS pool_rights_unexpired,
            capability.protocol = 'anthropic' AND capability.support_level = 'supported'
              AND capability.validation_state = 'verified' AS native_capability_current
       FROM checked CROSS JOIN saas_platform_provider_accounts account
       JOIN saas_provider_products product
         ON product.provider_id = account.provider_id AND product.product_id = account.product_id
       JOIN saas_supply_profiles profile ON profile.tenant_id = $1 AND profile.id = $2
       JOIN saas_platform_provider_credentials credential ON credential.account_id = account.id AND credential.id = $3
       JOIN saas_platform_provider_credential_versions version
         ON version.account_id = account.id AND version.credential_id = credential.id
        AND version.version = credential.current_version
       JOIN saas_provider_rights account_rights
         ON account_rights.rights_id = account.rights_id AND account_rights.version = account.rights_version
       JOIN saas_platform_provider_pools pool ON pool.id = $13
       JOIN saas_platform_provider_pool_members member ON member.pool_id = pool.id AND member.account_id = account.id
       JOIN saas_platform_provider_pool_grants grant_row
         ON grant_row.pool_id = pool.id AND grant_row.tenant_id = profile.tenant_id
        AND grant_row.supply_profile_id = profile.id
       JOIN saas_provider_rights rights ON rights.rights_id = pool.rights_id AND rights.version = pool.rights_version
       JOIN saas_platform_provider_account_capabilities binding
         ON binding.account_id = account.id AND binding.model = $11 AND binding.endpoint = $12
       JOIN saas_provider_capabilities capability
         ON capability.provider_id = binding.provider_id AND capability.product_id = binding.product_id
        AND capability.model = binding.model AND capability.endpoint = binding.endpoint
        AND capability.version = binding.capability_version
      WHERE account.id = $14`,
    [
      fixture.tenantId,
      fixture.profileId,
      selected.credentialId,
      selected.supplyProfileAuthzVersion,
      selected.accountAuthzVersion,
      selected.credentialVersion,
      selected.credentialAuthzVersion,
      pool.poolAuthzVersion,
      pool.poolMemberAuthzVersion,
      pool.poolGrantAuthzVersion,
      selected.resolvedModel,
      selected.endpoint,
      pool.poolId,
      selected.accountId,
    ],
  );
  assert.deepEqual(result.rows, [
    {
      product_active: true,
      profile_current: true,
      account_current: true,
      credential_current: true,
      version_current: true,
      account_rights_current: true,
      pool_current: true,
      member_current: true,
      grant_current: true,
      pool_rights_scope: true,
      pool_rights_effective: expectedRightWindow.effective,
      pool_rights_unexpired: expectedRightWindow.unexpired,
      native_capability_current: true,
    },
  ]);
}

function text(value: unknown): string {
  assert.ok(typeof value === 'string' && value.length > 0, 'persisted fixture identity must be present');
  return value;
}

function candidate(fixture: Fixture, mode: Mode, pool?: PlatformPoolFacts): RequestPreparationCandidateAuthority {
  const sent = fixture.sent;
  const common = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    supplyProfileId: fixture.profileId,
    upstreamId: text(sent.upstreamId),
    accountId: text(sent.accountId),
    credentialId: text(sent.credentialId),
    credentialVersion: Number(sent.credentialVersion),
    credentialAuthzVersion: Number(sent.credentialAuthzVersion),
    accountAuthzVersion: Number(sent.accountAuthzVersion),
    dispatchProfileId: text(sent.dispatchProfileId),
    supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
    resolvedModel: text(sent.resolvedModel),
    protocol: 'openai' as const,
    endpoint: text(sent.endpoint),
    supplierCostVersion: sent.supplierCostVersion,
    providerId: text(sent.providerId),
    productId: text(sent.productId),
  };
  if (mode === 'byok')
    return {
      ...common,
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      profileAccountAuthzVersion: Number(sent.profileAccountAuthzVersion),
    };
  assert.ok(pool, 'platform selection requires the real route-aligned pool');
  return { ...common, supplyMode: 'platform', accountOwnerKind: 'platform', ...pool };
}

function scope(fixture: Fixture, mode: Mode, alias: string) {
  const caller: RequestPreparationCaller = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    principalKind: 'member',
    principalId: fixture.userId,
    entitlementId: fixture.entitlementId,
    supplyProfileId: fixture.profileId,
    supplyMode: mode,
    modelScopes: [alias],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
  const entitlement: RequestPreparationEntitlement = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    entitlementId: fixture.entitlementId,
    entitlementVersion: 1,
    supplyProfileId: fixture.profileId,
    supplyProfileVersion: 1,
    supplyMode: mode,
    modelScopeVersion: 1,
    allowedModels: [alias],
    allowedProviderIds: mode === 'byok' ? [text(fixture.sent.providerId)] : [],
    projectPolicyVersion: Number(fixture.sent.projectPolicyVersion),
  };
  const route: RequestPreparationRouteAuthority = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    publicModel: alias,
    publicModelId: text(fixture.sent.routePublicModelId),
    publicModelVersion: Number(fixture.sent.routePublicModelVersion),
    routeConfigId: text(fixture.sent.routeConfigId),
    routeConfigVersion: Number(fixture.sent.routeConfigVersion),
    protocol: 'openai',
    providerProtocol: 'anthropic',
    clientOperation: 'chat.completions',
    providerOperation: 'messages',
    targetMode: mode === 'byok' ? 'tenant_account' : 'platform_pool',
    upstreamId: text(fixture.sent.upstreamId),
    endpoint: text(fixture.sent.endpoint),
  };
  return { caller, entitlement, route };
}

test('restricted PostgreSQL scheduler separates native Anthropic capability from OpenAI client scope', {
  skip:
    process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
      ? `set ${CANCELLATION_PG_REQUIRED}=1 and all three designated disposable role URLs`
      : false,
  timeout: 300_000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  const controlPlane = databases[1];
  assert.ok(controlPlane);
  try {
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: native-only capability, wrong-native denial and unchanged credential epochs`, async () => {
        const fixture = await seedFixture(migrator, gateway, mode, { nativeProtocol: 'anthropic' });
        const pool = mode === 'platform' ? await alignPlatformPool(migrator, fixture) : undefined;
        const selected = candidate(fixture, mode, pool);
        const alias = text(
          (
            await gateway.query<{ public_model: string }>(
              'SELECT public_model FROM saas_requests WHERE tenant_id = $1 AND id = $2',
              [fixture.tenantId, fixture.input.requestId],
            )
          ).rows[0]?.public_model,
        );
        const authority = scope(fixture, mode, alias);
        const capabilities = await gateway.query<{ protocol: string; version: string }>(
          `SELECT protocol, version::text AS version FROM saas_provider_capabilities
            WHERE provider_id=$1 AND product_id=$2 AND model=$3 AND endpoint=$4 ORDER BY version`,
          [selected.providerId, selected.productId, selected.resolvedModel, selected.endpoint],
        );
        assert.deepEqual(capabilities.rows, [{ protocol: 'anthropic', version: '1' }]);

        await seedHealthyAccount(migrator, fixture, mode);
        const scheduler = new PostgresProviderAccountScheduler({
          database: gateway,
          leaseConcurrencyLimit: 2,
          health: new PostgresProviderAccountRuntimeHealthStore({
            database: gateway,
            maxHealthAgeMs: MAX_HEALTH_AGE_MS,
          }),
          maxHealthAgeMs: MAX_HEALTH_AGE_MS,
        });
        const input = {
          requestId: randomUUID(),
          ...authority,
          candidates: [selected],
          publicModel: alias,
          protocol: 'openai' as const,
        };
        const allowed = await scheduler.select(input);
        assert.equal(allowed.decision, 'allow');
        if (allowed.decision === 'allow') assert.equal(allowed.value.protocol, 'openai');

        const wrong = await scheduler.select({
          ...input,
          route: { ...authority.route, providerProtocol: 'openai' },
        });
        assert.equal(wrong.decision, 'reject');
        if (wrong.decision === 'reject') assert.equal(wrong.code, 'account_denied');
        const legacy = await scheduler.select({
          ...input,
          route: { ...authority.route, providerProtocol: undefined, providerOperation: undefined },
        });
        assert.equal(legacy.decision, 'reject', 'missing native authority keeps exact legacy client matching');
        const stale = await scheduler.select({
          ...input,
          candidates: [{ ...selected, credentialAuthzVersion: Number(selected.credentialAuthzVersion) + 1 }],
        });
        assert.equal(stale.decision, 'reject', 'native protocol cannot waive a persisted credential epoch');

        if (mode === 'platform') {
          const resolver = new PostgresRequestPreparationAuthorityAdapter({
            database: gateway,
            routes: new SaasRouteConfigService(gateway),
            commercial: new SaasCommercialMeteringPolicyService(gateway),
            catalog: new SaasCatalogService(gateway),
            providerNativeProtocol: (providerId, productId, model, clientProtocol) => {
              assert.equal(providerId, selected.providerId);
              assert.equal(productId, selected.productId);
              assert.equal(model, selected.resolvedModel);
              assert.equal(clientProtocol, 'openai');
              return 'anthropic';
            },
          });
          for (const clientOperation of ['embeddings', 'responses.compact']) {
            const denied = await resolver.resolve({
              caller: authority.caller,
              entitlement: authority.entitlement,
              publicModel: alias,
              protocol: 'openai',
              clientOperation,
            });
            assert.equal(denied.decision, 'reject');
            if (denied.decision === 'reject') assert.equal(denied.code, 'route_denied');
          }
        }

        const rowsSeen: unknown[][] = [];
        let routeReads = 0;
        const observation: EligibilityObservation = {
          rootReads: 0,
          transactionCalls: 0,
          async afterRouteRead() {
            routeReads += 1;
            const service = new ProviderSupplyService(controlPlane, {
              deployment: 'fin057-test',
              environment: 'test',
              kmsKeyId: 'fin057-synthetic-kms',
            });
            await service.disableProviderCredential({
              credentialId: selected.credentialId,
              expectedAuthzVersion: selected.credentialAuthzVersion,
            });
          },
        };
        const autocommit = new PostgresProviderAccountScheduler({
          database: observeEligibility(gateway, rowsSeen, observation),
          leaseConcurrencyLimit: 2,
          health: new PostgresProviderAccountRuntimeHealthStore({
            database: gateway,
            maxHealthAgeMs: MAX_HEALTH_AGE_MS,
          }),
          maxHealthAgeMs: MAX_HEALTH_AGE_MS,
        });
        const revoked = await autocommit.select({ ...input, requestId: randomUUID() });
        assert.equal(
          revoked.decision,
          'reject',
          'eligibility must see the credential disable committed after route read',
        );
        if (revoked.decision === 'reject') assert.equal(revoked.code, 'account_denied');
        assert.equal(routeReads, 1);
        assert.equal(observation.transactionCalls, 0, 'real eligibility uses production root autocommit');
        assert.equal(observation.rootReads, 1);
        assert.deepEqual(rowsSeen, [[]], 'the real post-revocation eligibility SELECT must return no authority');
      });
    }

    for (const boundary of ['active', 'future', 'expired'] as const) {
      await t.test(`database authority clock: ${boundary} rights with process clock skew`, async () => {
        const fixture = await seedFixture(migrator, gateway, 'platform', { nativeProtocol: 'anthropic' });
        // The real health observation precedes the fresh right and DB-created grant.
        const healthObservedAt = await seedHealthyAccount(migrator, fixture, 'platform');
        const dbNow = persistedDate(
          (await gateway.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now,
        );
        const effectiveAt = new Date(
          dbNow.getTime() + (boundary === 'future' ? 60_000 : boundary === 'expired' ? -60_000 : 0),
        );
        const expiresAt = new Date(
          dbNow.getTime() + (boundary === 'future' ? 120_000 : boundary === 'expired' ? -50 : 60_000),
        );
        const pool = await createClockPool(migrator, fixture, { effectiveAt, expiresAt });
        const selected = candidate(fixture, 'platform', pool);
        await assertClockFixtureAuthority(gateway, fixture, selected, pool, {
          effective: boundary !== 'future',
          unexpired: boundary !== 'expired',
        });
        const alias = text(
          (
            await gateway.query<{ public_model: string }>(
              'SELECT public_model FROM saas_requests WHERE tenant_id = $1 AND id = $2',
              [fixture.tenantId, fixture.input.requestId],
            )
          ).rows[0]?.public_model,
        );
        const input = {
          requestId: randomUUID(),
          ...scope(fixture, 'platform', alias),
          candidates: [selected],
          publicModel: alias,
          protocol: 'openai' as const,
        };
        const processTimes =
          boundary === 'active'
            ? [
                new Date(Math.min(effectiveAt.getTime(), pool.grantEffectiveAt.getTime()) - 100),
                new Date(expiresAt.getTime() + 30_000),
              ]
            : [new Date(boundary === 'future' ? effectiveAt.getTime() + 30_000 : expiresAt.getTime() - 50)];
        for (const processNow of processTimes) {
          // Keep the existing health boundary valid; no fake health or wider age bound.
          assert.ok(healthObservedAt.getTime() - processNow.getTime() <= 100);
          assert.ok(Math.max(0, processNow.getTime() - healthObservedAt.getTime()) < MAX_HEALTH_AGE_MS);
          const rowsSeen: unknown[][] = [];
          const observation: EligibilityObservation = { rootReads: 0, transactionCalls: 0 };
          const scheduler = new PostgresProviderAccountScheduler({
            database: observeEligibility(gateway, rowsSeen, observation),
            leaseConcurrencyLimit: 2,
            health: new PostgresProviderAccountRuntimeHealthStore({
              database: gateway,
              maxHealthAgeMs: MAX_HEALTH_AGE_MS,
            }),
            maxHealthAgeMs: MAX_HEALTH_AGE_MS,
            now: () => processNow,
          });
          const result = await scheduler.select(input);
          assert.equal(observation.transactionCalls, 0, 'clock authority must use production root autocommit');
          assert.equal(observation.rootReads, 1);
          assert.equal(rowsSeen.length, 1, 'the real eligibility statement must decide this candidate');
          if (boundary === 'active') {
            assert.equal(result.decision, 'allow');
            assert.equal(rowsSeen[0].length, 1);
            const row = rowsSeen[0][0] as Record<string, unknown>;
            assert.equal(Object.hasOwn(row, 'authority_now'), true);
            const authorityAt = persistedDate(row.authority_now);
            assert.ok(authorityAt.getTime() >= effectiveAt.getTime());
            assert.ok(authorityAt.getTime() >= pool.grantEffectiveAt.getTime());
            assert.ok(authorityAt.getTime() < expiresAt.getTime());
          } else {
            assert.equal(result.decision, 'reject');
            if (result.decision === 'reject') assert.equal(result.code, 'account_denied');
            assert.equal(rowsSeen[0].length, 0, 'future or expired rights must be filtered by database eligibility');
          }
        }
      });
    }
  } catch (error) {
    throw safeCancellationFailure(error);
  } finally {
    await Promise.allSettled(databases.map((database) => database.close()));
  }
});
