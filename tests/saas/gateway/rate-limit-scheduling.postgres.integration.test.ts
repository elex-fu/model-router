import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import {
  type AdmissionCreateRequestInput,
  type SaasMeteringAdmissionPort,
  SaasRequestAdmissionService,
} from '../../../src/saas/gateway/admission.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock } from '../../../src/saas/gateway/authorization-prelock.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import { PostgresRequestAdmissionGuard } from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import type { CreateRequestInput, RequestAdmission } from '../../../src/saas/metering/types.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { type Fixture, seedFixture } from '../metering/normal-success-postgres-fixture.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationPgConfigured,
  cancellationSqlState,
} from './pre-dispatch-postgres-fixture.js';

type Mode = 'byok' | 'platform';

const ENDPOINT = '/v1/chat/completions';

async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    const state = cancellationSqlState(error);
    // Stable uppercase domain codes carry no secrets and pinpoint the guard stage.
    const domain =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown';
    // Never retain a raw driver error/cause/message/detail/stack or parameters.
    const safe = new Error(`R6 gate phase=${name} code=${domain}${state ? ` sqlState=${state}` : ''}`);
    safe.stack = undefined;
    throw safe;
  }
}

async function windowSums(
  executor: { query: SqlExecutor['query'] },
  scope: 'tenant' | 'platform',
  accountId: string,
): Promise<{ requests: string; tokens: string }> {
  const result = await executor.query<{ requests: string; tokens: string }>(
    `SELECT coalesce(sum(requests), 0)::text AS requests, coalesce(sum(tokens), 0)::text AS tokens
       FROM saas_provider_account_rate_counters
      WHERE account_scope = $1 AND account_id = $2`,
    [scope, accountId],
  );
  const row = result.rows[0];
  assert.ok(row, 'counter aggregate always returns one row');
  return row;
}

function attemptAuthority(
  fixture: Fixture,
  alias: string,
  fingerprint: string,
  payloadSha256: string,
): Record<string, unknown> {
  const sent = fixture.sent;
  return {
    ordinal: 1,
    upstreamId: sent.upstreamId,
    accountId: sent.accountId,
    providerId: sent.providerId,
    productId: sent.productId,
    resolvedModel: sent.resolvedModel,
    protocol: sent.protocol,
    endpoint: sent.endpoint,
    supplierCostVersion: sent.supplierCostVersion,
    dispatchProfileId: sent.dispatchProfileId,
    supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
    credentialId: sent.credentialId,
    credentialVersion: Number(sent.credentialVersion),
    credentialAuthzVersion: Number(sent.credentialAuthzVersion),
    accountAuthzVersion: Number(sent.accountAuthzVersion),
    projectPolicyVersion: Number(sent.projectPolicyVersion as string),
    routeConfigId: sent.routeConfigId,
    routeConfigVersion: Number(sent.routeConfigVersion as string),
    routePublicModelId: sent.routePublicModelId,
    routePublicModelVersion: Number(sent.routePublicModelVersion as string),
    routeProtocol: sent.routeProtocol,
    routeTargetMode: sent.routeTargetMode,
    customerMeteringPolicyId: sent.customerMeteringPolicyId,
    customerMeteringPolicyVersion:
      sent.customerMeteringPolicyVersion === null ? null : Number(sent.customerMeteringPolicyVersion),
    providerMeteringPolicyId: sent.providerMeteringPolicyId,
    providerMeteringPolicyVersion:
      sent.providerMeteringPolicyVersion === null ? null : Number(sent.providerMeteringPolicyVersion),
    contractAttestationId: sent.contractAttestationId,
    customerPriceVersion: sent.customerPriceVersion,
    // 035 provenance: the same alias mapping and compiler lineage the FIN057
    // fixture seeded; fingerprint/payload digests are per-request.
    modelResolution: {
      requestedModel: alias,
      mappedModel: sent.resolvedModel,
      resolvedModel: sent.resolvedModel,
      mappingSource: 'alias' as const,
      mappingVersion: 1,
    },
    clientProtocol: 'openai' as const,
    providerProtocol: 'openai' as const,
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    requestFingerprint: fingerprint,
    requestFingerprintVersion: 'canonical-v1',
    payloadSha256,
    payloadCompilerVersion: 'fin057-compiler-v1',
    usageEstimatorVersion: 'fin057-estimator-v1',
  };
}

function candidateAuthority(
  fixture: Fixture,
  mode: Mode,
  pool?: PlatformPoolFacts,
): RequestPreparationCandidateAuthority {
  const sent = fixture.sent;
  const common = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    supplyProfileId: fixture.profileId,
    supplyMode: mode,
    accountId: sent.accountId,
    upstreamId: sent.upstreamId,
    credentialId: sent.credentialId,
    credentialVersion: Number(sent.credentialVersion),
    credentialAuthzVersion: Number(sent.credentialAuthzVersion),
    accountAuthzVersion: Number(sent.accountAuthzVersion),
    dispatchProfileId: sent.dispatchProfileId,
    supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
    resolvedModel: sent.resolvedModel,
    protocol: 'openai' as const,
    endpoint: sent.endpoint,
    supplierCostVersion: sent.supplierCostVersion,
    providerId: sent.providerId,
    productId: sent.productId,
  };
  if (mode === 'byok') {
    return {
      ...common,
      accountOwnerKind: 'tenant',
      profileAccountAuthzVersion: Number(sent.profileAccountAuthzVersion as string),
    } as RequestPreparationCandidateAuthority;
  }
  assert.ok(pool, 'platform candidates need the route-aligned pool facts');
  return {
    ...common,
    accountOwnerKind: 'platform',
    poolId: pool.poolId,
    poolAuthzVersion: pool.poolAuthzVersion,
    poolMemberAccountAuthzVersion: pool.poolMemberAccountAuthzVersion,
    poolMemberAuthzVersion: pool.poolMemberAuthzVersion,
    poolGrantAuthzVersion: pool.poolGrantAuthzVersion,
    poolGrantProfileAuthzVersion: pool.poolGrantProfileAuthzVersion,
    poolGrantPoolAuthzVersion: pool.poolGrantPoolAuthzVersion,
  } as RequestPreparationCandidateAuthority;
}

interface PlatformPoolFacts {
  readonly poolId: string;
  readonly poolAuthzVersion: number;
  readonly poolMemberAccountAuthzVersion: number;
  readonly poolMemberAuthzVersion: number;
  readonly poolGrantAuthzVersion: number;
  readonly poolGrantProfileAuthzVersion: number;
  readonly poolGrantPoolAuthzVersion: number;
}

/**
 * The FIN057 fixture routes to a synthetic upstream id that is not a pool id.
 * The scheduler contract requires platform candidates to target the exact
 * persisted route pool (candidate.poolId === route.upstream_id), and route
 * versions are immutable — so platform mode adds a second pool whose id is
 * the route upstream, reusing the seeded account, rights, and capability.
 */
async function alignPlatformPool(
  migrator: { query: SqlExecutor['query'] },
  fixture: Fixture,
): Promise<PlatformPoolFacts> {
  const account = (
    await migrator.query<{ rights_id: string; rights_version: string; authz_version: string }>(
      'SELECT rights_id, rights_version::text AS rights_version, authz_version::text AS authz_version FROM saas_platform_provider_accounts WHERE id = $1',
      [fixture.sent.accountId],
    )
  ).rows[0];
  assert.ok(account, 'seeded platform account must exist');
  const capability = (
    await migrator.query<{ capability_version: string }>(
      'SELECT capability_version::text AS capability_version FROM saas_platform_provider_account_capabilities WHERE account_id = $1',
      [fixture.sent.accountId],
    )
  ).rows[0];
  assert.ok(capability, 'seeded platform account capability must exist');
  const providerId = fixture.sent.providerId;
  const productId = fixture.sent.productId;
  const endpoint = fixture.sent.endpoint;
  const resolvedModel = fixture.sent.resolvedModel;
  const accountId = fixture.sent.accountId;
  assert.ok(
    providerId !== null && productId !== null && endpoint !== null && resolvedModel !== null && accountId !== null,
    'seeded dispatch fields must be present',
  );
  const supply = new ProviderSupplyService(migrator as never, {
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
    id: fixture.sent.upstreamId,
    displayName: 'R6 route-aligned pool',
    providerId,
    productId,
    credentialType: 'api-key',
    region: 'test',
    purpose: 'inference',
    rightsId: account.rights_id,
    rightsVersion: Number(account.rights_version),
    capabilities: [
      {
        model: resolvedModel,
        endpoint,
        version: Number(capability.capability_version),
      },
    ],
    status: 'active',
    validationState: 'verified',
  });
  await supply.addPlatformPoolMember({
    poolId: pool.id,
    accountId,
    expectedAccountAuthzVersion: Number(account.authz_version),
  });
  const grant = await supply.grantPlatformPoolToProfile({
    poolId: pool.id,
    tenantId: fixture.tenantId,
    supplyProfileId: fixture.profileId,
    evidenceReference: `r6-grant-${randomUUID()}`,
    evidenceSha256: 'd'.repeat(64),
  });
  return {
    poolId: pool.id,
    poolAuthzVersion: pool.authzVersion,
    poolMemberAccountAuthzVersion: Number(account.authz_version),
    // A freshly inserted pool member always starts at epoch 1.
    poolMemberAuthzVersion: 1,
    poolGrantAuthzVersion: grant.authzVersion,
    poolGrantProfileAuthzVersion: grant.profileAuthzVersion,
    poolGrantPoolAuthzVersion: grant.poolAuthzVersion,
  };
}

test('R6 account rate counters drive admission-fed scheduling eligibility on real PG (restricted gateway role)', {
  skip:
    process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
      ? `set ${CANCELLATION_PG_REQUIRED}=1 and all disposable E2E role URLs`
      : false,
  timeout: 300000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  try {
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: rpm ceiling denies, replay never double counts, window roll restores`, async () => {
        const scope = mode === 'byok' ? ('tenant' as const) : ('platform' as const);
        const accountTable = mode === 'byok' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
        const fixture = await phase('seed', () => seedFixture(migrator, gateway, mode));
        const accountId = fixture.sent.accountId;
        const providerId = fixture.sent.providerId;
        assert.ok(accountId !== null, 'seeded account id must be present');
        assert.ok(providerId !== null || mode === 'platform', 'byok provider id must be present');
        const pool =
          mode === 'platform' ? await phase('pool-align', () => alignPlatformPool(migrator, fixture)) : undefined;
        const persistedRouteFacts = await phase('alias', async () => {
          const result = await gateway.query<{ public_model: string; route_upstream_id: string }>(
            'SELECT public_model, route_upstream_id FROM saas_requests WHERE tenant_id = $1 AND id = $2',
            [fixture.tenantId, fixture.input.requestId],
          );
          const row = result.rows[0];
          assert.ok(row && row.public_model !== '' && row.route_upstream_id !== '');
          return row;
        });
        const alias = persistedRouteFacts.public_model;
        // Supply-owner setup seeds the R6 ceiling and a fresh healthy row;
        // the gateway role itself never writes either relation.
        await phase('limit-seed', () =>
          migrator.query(`UPDATE ${accountTable} SET rpm_limit = 2 WHERE id = $1`, [accountId]),
        );
        await phase('health-seed', () =>
          migrator.query(
            `INSERT INTO saas_provider_account_runtime_health
                 (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
                  observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
               VALUES ($1, $2, $3, $4, 'healthy', 0, clock_timestamp(), NULL, 'gateway_success', 1, 1)`,
            [
              mode === 'byok' ? fixture.tenantId : 'platform',
              scope,
              mode === 'byok' ? fixture.tenantId : null,
              accountId,
            ],
          ),
        );

        const scheduler = new PostgresProviderAccountScheduler({
          database: gateway,
          leaseConcurrencyLimit: 2,
          health: new PostgresProviderAccountRuntimeHealthStore({ database: gateway, maxHealthAgeMs: 300_000 }),
          maxHealthAgeMs: 300_000,
        });
        const candidate = candidateAuthority(fixture, mode, pool);
        const select = (requestId: string) =>
          scheduler.select({
            requestId,
            caller: {
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
            },
            entitlement: {
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
              allowedProviderIds: mode === 'byok' ? [providerId as string] : [],
              projectPolicyVersion: Number(fixture.sent.projectPolicyVersion as string),
            },
            candidates: [candidate],
            publicModel: alias,
            protocol: 'openai',
          });

        const guard = new PostgresRequestAdmissionGuard(gateway);
        const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();
        // Production prepared replays carry no metering idempotency row (the
        // gateway role is read-only on saas_idempotency_records): replay
        // visibility comes from re-issuing the same request/attempt ids.
        const attemptIds = new Map<string, { requestId: string; attemptId: string }>();
        const admit = async (label: string) => {
          const ids = attemptIds.get(label) ?? { requestId: randomUUID(), attemptId: randomUUID() };
          attemptIds.set(label, ids);
          const { requestId, attemptId } = ids;
          const fingerprint = sha256Hex(`r6-request:${label}:${requestId}`);
          const payloadSha256 = sha256Hex(`r6-payload:${label}:${requestId}`);
          const request = {
            tenantId: fixture.tenantId,
            projectId: fixture.projectId,
            proxyKeyId: fixture.keyId,
            entitlementId: fixture.entitlementId,
            supplyProfileId: fixture.profileId,
            supplyProfileVersion: 1,
            modelScopeVersion: 1,
            supplyMode: mode,
            principalKind: 'member' as const,
            principalId: fixture.userId,
            authzVersion: 1,
            entitlementVersion: 1,
            configVersion: Number(fixture.sent.routeConfigVersion as string),
            projectPolicyVersion: Number(fixture.sent.projectPolicyVersion as string),
            routeConfigId: fixture.sent.routeConfigId,
            routeConfigVersion: Number(fixture.sent.routeConfigVersion as string),
            routePublicModelId: fixture.sent.routePublicModelId,
            routePublicModelVersion: Number(fixture.sent.routePublicModelVersion as string),
            routeProtocol: fixture.sent.routeProtocol,
            routeTargetMode: fixture.sent.routeTargetMode,
            routeUpstreamId: persistedRouteFacts.route_upstream_id,
            customerMeteringPolicyId: fixture.sent.customerMeteringPolicyId,
            customerMeteringPolicyVersion:
              fixture.sent.customerMeteringPolicyVersion === null
                ? null
                : Number(fixture.sent.customerMeteringPolicyVersion),
            providerMeteringPolicyId: fixture.sent.providerMeteringPolicyId,
            providerMeteringPolicyVersion:
              fixture.sent.providerMeteringPolicyVersion === null
                ? null
                : Number(fixture.sent.providerMeteringPolicyVersion),
            contractAttestationId: fixture.sent.contractAttestationId,
            publicModel: alias,
            protocol: 'openai' as const,
            endpoint: ENDPOINT,
            requestFingerprint: fingerprint,
            requestFingerprintVersion: 'canonical-v1',
            customerPriceVersion: fixture.sent.customerPriceVersion,
            initialAttempt: {
              ...attemptAuthority(fixture, alias, fingerprint, payloadSha256),
              ...(mode === 'byok'
                ? {
                    accountOwnerKind: 'tenant' as const,
                    profileAccountAuthzVersion: Number(fixture.sent.profileAccountAuthzVersion as string),
                  }
                : {
                    accountOwnerKind: 'platform' as const,
                    poolId: pool?.poolId as string,
                    poolAuthzVersion: pool?.poolAuthzVersion as number,
                    poolMemberAccountAuthzVersion: pool?.poolMemberAccountAuthzVersion as number,
                    poolMemberAuthzVersion: pool?.poolMemberAuthzVersion as number,
                    poolGrantAuthzVersion: pool?.poolGrantAuthzVersion as number,
                    poolGrantProfileAuthzVersion: pool?.poolGrantProfileAuthzVersion as number,
                    poolGrantPoolAuthzVersion: pool?.poolGrantPoolAuthzVersion as number,
                  }),
            },
          } as unknown as AdmissionCreateRequestInput;
          const meteringPort: SaasMeteringAdmissionPort = {
            async admitRequest(input: CreateRequestInput, options = {}) {
              if (!options.executor) throw new Error('caller transaction is required');
              return (await fixture.metering.admitPreparedRequest(input, {
                requestId,
                attemptId,
                executor: options.executor,
              })) as RequestAdmission;
            },
          };
          const service = new SaasRequestAdmissionService(gateway, meteringPort, fixture.billing, guard, prelock, {
            idFactory: randomUUID,
          });
          const command =
            mode === 'byok'
              ? {
                  supplyMode: 'byok' as const,
                  request,
                  authenticatedKey: {
                    authorization: {
                      keyId: fixture.keyId,
                      tenantId: fixture.tenantId,
                      projectId: fixture.projectId,
                      principalKind: 'member' as const,
                      principalId: fixture.userId,
                      entitlementId: fixture.entitlementId,
                      supplyProfileId: fixture.profileId,
                      supplyMode: mode,
                      modelScopes: [alias],
                      authzVersion: 1,
                      modelScopeVersion: 1,
                      entitlementAuthzVersion: 1,
                      supplyProfileAuthzVersion: 1,
                    },
                  },
                }
              : {
                  supplyMode: 'platform' as const,
                  request,
                  authenticatedKey: {
                    authorization: {
                      keyId: fixture.keyId,
                      tenantId: fixture.tenantId,
                      projectId: fixture.projectId,
                      principalKind: 'member' as const,
                      principalId: fixture.userId,
                      entitlementId: fixture.entitlementId,
                      supplyProfileId: fixture.profileId,
                      supplyMode: mode,
                      modelScopes: [alias],
                      authzVersion: 1,
                      modelScopeVersion: 1,
                      entitlementAuthzVersion: 1,
                      supplyProfileAuthzVersion: 1,
                    },
                  },
                  holdEvidence: {
                    inputTotal: 1,
                    inputUncached: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cacheWrite5m: 0,
                    cacheWrite1h: 0,
                    outputTotal: 1,
                    reasoningOutput: 0,
                    admissionExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
                  },
                };
          return service.admit(command);
        };

        const before = await phase('counters-empty', () => windowSums(gateway, scope, accountId));
        assert.deepEqual(before, { requests: '0', tokens: '0' });

        const first = await select(`r6-select-${randomUUID()}`);
        assert.equal(first.decision, 'allow', 'no consumption yet: the account stays eligible');

        const admitted1 = await phase('admit-1', () => admit('one'));
        assert.equal(admitted1.kind, 'created');
        const afterOne = await phase('counters-one', () => windowSums(gateway, scope, accountId));
        assert.equal(afterOne.requests, '1');
        assert.equal(afterOne.tokens, mode === 'platform' ? '2' : '0');

        const second = await select(`r6-select-${randomUUID()}`);
        assert.equal(second.decision, 'allow', 'one request below the rpm ceiling of two');

        const admitted2 = await phase('admit-2', () => admit('two'));
        assert.equal(admitted2.kind, 'created');
        const afterTwo = await phase('counters-two', () => windowSums(gateway, scope, accountId));
        assert.equal(afterTwo.requests, '2');

        const replayed = await phase('admit-1-replay', () => admit('one'));
        assert.equal(replayed.kind, 'replayed');
        const afterReplay = await phase('counters-replay', () => windowSums(gateway, scope, accountId));
        assert.equal(afterReplay.requests, '2', 'a replayed admission must never double count');

        const third = await select(`r6-select-${randomUUID()}`);
        assert.equal(third.decision, 'reject', 'requests >= rpm_limit removes the only candidate');
        if (third.decision === 'reject') assert.equal(third.code, 'account_denied');

        await phase('window-roll', () =>
          migrator.query(
            `UPDATE saas_provider_account_rate_counters
                  SET window_start = window_start - interval '61 seconds'
                WHERE account_scope = $1 AND account_id = $2`,
            [scope, accountId],
          ),
        );
        const fourth = await select(`r6-select-${randomUUID()}`);
        assert.equal(fourth.decision, 'allow', 'the trailing 60s window rolls and restores eligibility');

        if (mode === 'platform') {
          await phase('tpm-reset', async () => {
            await migrator.query(
              'DELETE FROM saas_provider_account_rate_counters WHERE account_scope = $1 AND account_id = $2',
              [scope, accountId],
            );
            await migrator.query(`UPDATE ${accountTable} SET rpm_limit = NULL, tpm_limit = 4 WHERE id = $1`, [
              accountId,
            ]);
          });
          const tpmFirst = await select(`r6-select-${randomUUID()}`);
          assert.equal(tpmFirst.decision, 'allow');
          await phase('admit-3', () => admit('three'));
          await phase('admit-4', () => admit('four'));
          const afterFour = await phase('counters-four', () => windowSums(gateway, scope, accountId));
          assert.equal(afterFour.tokens, '4');
          const tpmDenied = await select(`r6-select-${randomUUID()}`);
          assert.equal(tpmDenied.decision, 'reject', 'tokens >= tpm_limit removes the only candidate');
          if (tpmDenied.decision === 'reject') assert.equal(tpmDenied.code, 'account_denied');
        }
      });
    }

    await t.test('gateway role counter grants hold and account writes stay denied', async () => {
      const probeAccount = `r6-probe-${randomUUID()}`;
      await phase('probe-upsert', async () => {
        await gateway.query(
          `INSERT INTO saas_provider_account_rate_counters
               (account_scope, account_id, window_start, requests, tokens)
             VALUES ('tenant', $1, date_trunc('second', clock_timestamp()), 1, 0)
             ON CONFLICT (account_scope, account_id, window_start)
             DO UPDATE SET requests = saas_provider_account_rate_counters.requests + 1`,
          [probeAccount],
        );
        const read = await gateway.query<{ requests: string }>(
          `SELECT requests::text AS requests FROM saas_provider_account_rate_counters
              WHERE account_scope = 'tenant' AND account_id = $1`,
          [probeAccount],
        );
        assert.equal(read.rows.length, 1);
      });
      for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts'] as const) {
        const denied = await phase('probe-account-write', () =>
          gateway
            .query(`UPDATE ${table} SET rpm_limit = 5 WHERE id = $1`, [`r6-never-${randomUUID()}`])
            .then(() => null)
            .catch((error: unknown) => cancellationSqlState(error) ?? 'unknown'),
        );
        assert.equal(denied, '42501', `gateway must not write ${table}`);
      }
      const deleteDenied = await phase('probe-counter-delete', () =>
        gateway
          .query('DELETE FROM saas_provider_account_rate_counters WHERE account_scope = $1 AND account_id = $2', [
            'tenant',
            probeAccount,
          ])
          .then(() => null)
          .catch((error: unknown) => cancellationSqlState(error) ?? 'unknown'),
      );
      assert.equal(deleteDenied, '42501', 'gateway holds no DELETE on the counter relation');
    });
  } finally {
    await Promise.all(databases.map((database) => database.close()));
  }
});
