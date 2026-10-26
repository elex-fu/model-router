import { randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../../../src/saas/db/index.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import {
  type SaasMeteringAdmissionPort,
  type SaasRequestAdmissionCommand,
  type SaasRequestAdmissionGuard,
  SaasRequestAdmissionService,
  type SaasRequestAdmissionServiceOptions,
} from '../../../src/saas/gateway/admission.js';
import { PostgresSaasRequestAdmissionAuthorizationPrelock } from '../../../src/saas/gateway/authorization-prelock.js';
import type { PostgresPreparationObserver } from '../../../src/saas/gateway/postgres-preparation-observer.js';
import { PostgresRequestAdmissionGuard } from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import type { CreateRequestInput, RequestAdmission } from '../../../src/saas/metering/types.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import type { Fixture } from '../metering/normal-success-postgres-fixture.js';

export type Mode = 'byok' | 'platform';

export const ENDPOINT = '/v1/chat/completions';

export interface PlatformPoolFacts {
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
 * (Same construction as the R6 rate-limit scheduling gate.)
 */
export async function alignPlatformPool(
  migrator: { query: SqlExecutor['query'] },
  fixture: Fixture,
): Promise<PlatformPoolFacts> {
  const account = (
    await migrator.query<{ rights_id: string; rights_version: string; authz_version: string }>(
      'SELECT rights_id, rights_version::text AS rights_version, authz_version::text AS authz_version FROM saas_platform_provider_accounts WHERE id = $1',
      [fixture.sent.accountId],
    )
  ).rows[0];
  if (!account) throw new Error('seeded platform account must exist');
  const capability = (
    await migrator.query<{ capability_version: string }>(
      'SELECT capability_version::text AS capability_version FROM saas_platform_provider_account_capabilities WHERE account_id = $1',
      [fixture.sent.accountId],
    )
  ).rows[0];
  if (!capability) throw new Error('seeded platform account capability must exist');
  const providerId = fixture.sent.providerId;
  const productId = fixture.sent.productId;
  const endpoint = fixture.sent.endpoint;
  const resolvedModel = fixture.sent.resolvedModel;
  const accountId = fixture.sent.accountId;
  if (providerId === null || productId === null || endpoint === null || resolvedModel === null || accountId === null) {
    throw new Error('seeded dispatch fields must be present');
  }
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
    displayName: 'admission-bench route-aligned pool',
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
    evidenceReference: `admission-bench-grant-${randomUUID()}`,
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

/**
 * The FIN057 fixture leaves tenant/policy/key capacity limits NULL (capacity
 * admission blocks on NULL limits — positiveLimit fails closed). Project
 * inference policy versions are immutable, so this appends one configured
 * version (the same shape the commercial-gateway E2E fixture uses), moves the
 * project head, and sets tenant/key limits, returning the new policy version
 * every harness-built authority fact must carry.
 */
export async function raiseCapacityLimits(
  migrator: { query: SqlExecutor['query'] },
  fixture: Fixture,
): Promise<string> {
  const tenantId = fixture.tenantId;
  const projectId = fixture.projectId;
  const current = (
    await migrator.query<{ version: string; changed_by_user_id: string | null }>(
      'SELECT version::text AS version, changed_by_user_id FROM saas_project_inference_policy_versions WHERE tenant_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT 1',
      [tenantId, projectId],
    )
  ).rows[0];
  if (!current) throw new Error('seeded project policy version must exist');
  const nextVersion = String(BigInt(current.version) + 1n);
  const appended = await migrator.query<{ version: string }>(
    `INSERT INTO saas_project_inference_policy_versions
       (tenant_id, project_id, version, status, changed_by_user_id, created_at,
        requests_per_minute, tokens_per_minute, max_concurrent_requests)
     SELECT policy.tenant_id, policy.project_id, $3, policy.status, policy.changed_by_user_id, clock_timestamp(), $4, $5, $6
       FROM saas_project_inference_policy_versions AS policy
      WHERE policy.tenant_id = $1 AND policy.project_id = $2 AND policy.version = $7
     RETURNING version::text AS version`,
    [tenantId, projectId, nextVersion, 100, 16000, 4, current.version],
  );
  if (appended.rows.length !== 1) throw new Error('appending the capacity policy version failed');
  await migrator.query(
    'UPDATE saas_projects SET inference_policy_version = $3 WHERE tenant_id = $1 AND id = $2 AND inference_policy_version = $4',
    [tenantId, projectId, nextVersion, current.version],
  );
  await migrator.query(
    'UPDATE saas_tenants SET requests_per_minute = $2, tokens_per_minute = $3, max_concurrent_requests = $4 WHERE id = $1',
    [tenantId, 120, 20000, 4],
  );
  await migrator.query(
    'UPDATE saas_api_keys SET requests_per_minute = $3, tokens_per_minute = $4, max_concurrent_requests = $5 WHERE tenant_id = $1 AND id = $2',
    [tenantId, fixture.keyId, 60, 8000, 4],
  );
  return nextVersion;
}

export interface AdmissionCommandPlan {
  readonly alias: string;
  readonly routeUpstreamId: string;
  readonly projectPolicyVersion: string;
  readonly payloadBounds: {
    readonly inputTotalUpperBound: string;
    readonly inputUncachedUpperBound: string;
    readonly cacheReadUpperBound: string;
    readonly cacheWriteUpperBound: string;
    readonly cacheWrite5mUpperBound: string;
    readonly cacheWrite1hUpperBound: string;
    readonly outputTotalUpperBound: string;
    readonly reasoningOutputUpperBound: string;
    readonly feasibleInputBuckets: readonly string[];
  };
  readonly command: (
    requestId: string,
    attemptId: string,
    label: string,
  ) => {
    supplyMode: Mode;
    request: Record<string, unknown>;
    authenticatedKey: Record<string, unknown>;
    holdEvidence: Record<string, unknown> | null;
  };
}

function attemptAuthority(
  fixture: Fixture,
  alias: string,
  fingerprint: string,
  payloadSha256: string,
  policyVersion: string,
) {
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
    projectPolicyVersion: Number(policyVersion),
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

/**
 * Builds a reusable member-principal admission command plan for the seeded
 * FIN057 fixture (same shape as the R6 rate-limit scheduling gate drives).
 */
export async function buildAdmissionCommandPlan(
  gateway: SaasDatabase,
  fixture: Fixture,
  mode: Mode,
  pool?: PlatformPoolFacts,
  projectPolicyVersion?: string,
): Promise<AdmissionCommandPlan> {
  const persistedRouteFacts = (
    await gateway.query<{ public_model: string; route_upstream_id: string }>(
      'SELECT public_model, route_upstream_id FROM saas_requests WHERE tenant_id = $1 AND id = $2',
      [fixture.tenantId, fixture.input.requestId],
    )
  ).rows[0];
  if (!persistedRouteFacts || !persistedRouteFacts.public_model || !persistedRouteFacts.route_upstream_id) {
    throw new Error('seeded route facts must exist');
  }
  const alias = persistedRouteFacts.public_model;
  const policyVersion = projectPolicyVersion ?? String(fixture.sent.projectPolicyVersion);
  const payloadBounds = {
    inputTotalUpperBound: '1000',
    inputUncachedUpperBound: '1000',
    cacheReadUpperBound: '0',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '1000',
    reasoningOutputUpperBound: '0',
    feasibleInputBuckets: ['0'],
  };
  const command = (requestId: string, attemptId: string, label: string) => {
    const fingerprint = sha256Hex(`admission-bench:${label}:${requestId}`);
    const payloadSha256 = sha256Hex(`admission-bench-payload:${label}:${requestId}`);
    const sent = fixture.sent;
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
      configVersion: Number(sent.routeConfigVersion as string),
      projectPolicyVersion: Number(policyVersion),
      routeConfigId: sent.routeConfigId,
      routeConfigVersion: Number(sent.routeConfigVersion as string),
      routePublicModelId: sent.routePublicModelId,
      routePublicModelVersion: Number(sent.routePublicModelVersion as string),
      routeProtocol: sent.routeProtocol,
      routeTargetMode: sent.routeTargetMode,
      routeUpstreamId: persistedRouteFacts.route_upstream_id,
      customerMeteringPolicyId: sent.customerMeteringPolicyId,
      customerMeteringPolicyVersion:
        sent.customerMeteringPolicyVersion === null ? null : Number(sent.customerMeteringPolicyVersion),
      providerMeteringPolicyId: sent.providerMeteringPolicyId,
      providerMeteringPolicyVersion:
        sent.providerMeteringPolicyVersion === null ? null : Number(sent.providerMeteringPolicyVersion),
      contractAttestationId: sent.contractAttestationId,
      publicModel: alias,
      protocol: 'openai' as const,
      endpoint: ENDPOINT,
      requestFingerprint: fingerprint,
      requestFingerprintVersion: 'canonical-v1',
      customerPriceVersion: sent.customerPriceVersion,
      initialAttempt: {
        ...attemptAuthority(fixture, alias, fingerprint, payloadSha256, policyVersion),
        ...(mode === 'byok'
          ? {
              accountOwnerKind: 'tenant' as const,
              profileAccountAuthzVersion: Number(sent.profileAccountAuthzVersion as string),
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
    };
    const authorization = {
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
    };
    return {
      supplyMode: mode,
      request,
      authenticatedKey: { authorization },
      holdEvidence:
        mode === 'platform'
          ? {
              inputTotal: 1,
              inputUncached: 1,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              outputTotal: 1,
              reasoningOutput: 0,
              admissionExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            }
          : null,
    };
  };
  return {
    alias,
    routeUpstreamId: persistedRouteFacts.route_upstream_id,
    projectPolicyVersion: policyVersion,
    payloadBounds,
    command,
  };
}

export interface AdmissionHarness {
  readonly plan: AdmissionCommandPlan;
  /** Drives one full admission (prelock → metering → guard → billing hold) on the caller transaction. */
  readonly admit: (
    executor: SqlExecutor,
    requestId: string,
    attemptId: string,
    label: string,
  ) => Promise<SaasRequestAdmissionResult>;
}

type SaasRequestAdmissionResult = Awaited<ReturnType<SaasRequestAdmissionService['admit']>>;

export async function createAdmissionHarness(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  fixture: Fixture,
  mode: Mode,
  pool?: PlatformPoolFacts,
  options: {
    readonly guard?: SaasRequestAdmissionGuard;
    readonly observe?: PostgresPreparationObserver;
    readonly beforeReservations?: SaasRequestAdmissionServiceOptions['beforeReservations'];
  } = {},
): Promise<AdmissionHarness> {
  // The FIN057 fixture leaves capacity limits unset; raise them (appending
  // one configured policy version) so the full admission path — including the
  // capacity reservation — can run end to end. Limit writes run as the
  // migrator role: the gateway role is read-only on tenants/policies.
  const projectPolicyVersion = await raiseCapacityLimits(migrator, fixture);
  const plan = await buildAdmissionCommandPlan(gateway, fixture, mode, pool, projectPolicyVersion);
  const admit = async (executor: SqlExecutor, requestId: string, attemptId: string, label: string) => {
    const guard = options.guard ?? new PostgresRequestAdmissionGuard(gateway, { observe: options.observe });
    const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();
    // The metering port closure carries this admission's request/attempt ids
    // (the production preparation stage threads them the same way).
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
      beforeReservations: options.beforeReservations,
    });
    const built = plan.command(requestId, attemptId, label);
    return service.admit(built as unknown as SaasRequestAdmissionCommand, { executor });
  };
  return { plan, admit };
}
