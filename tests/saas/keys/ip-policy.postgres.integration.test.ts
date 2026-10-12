import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import type { ClientAddressResolution } from '../../../src/saas/gateway/client-address.js';
import {
  PostgresRequestAdmissionGuard,
  PostgresRequestAdmissionGuardError,
  type PostgresRequestAdmissionGuardErrorCode,
} from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import { SaasProjectInferencePolicyService } from '../../../src/saas/gateway/project-policy-service.js';
import type { KeyIpPolicyValue } from '../../../src/saas/keys/ip-policy-contract.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import { SaasKeyError } from '../../../src/saas/keys/types.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import type { AttemptRecord, RequestRecord } from '../../../src/saas/metering/types.js';
import {
  anyRoleConfigured,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// KEY080 real-PG gate: versioned per-key IP policy heads (contract C-4,
// migration 080) under the restricted control-plane and gateway roles.
// Registered schema and the three preprovisioned roles are required. No
// bootstrap, HTTP fixture dependency, migrations, DDL, role changes or
// provider traffic.
interface KeyIpSeed {
  tenantId: string;
  projectId: string;
  userId: string;
  keyId: string;
  entitlementId: string;
  profileId: string;
  alias: string;
  policyVersion: string;
}

/** Fixture authority only; seeds exactly the rows the two restricted roles need. */
async function seedFixture(migrator: SaasDatabase): Promise<KeyIpSeed> {
  const label = randomUUID();
  const tenantId = randomUUID(),
    projectId = randomUUID(),
    userId = randomUUID(),
    keyId = randomUUID(),
    entitlementId = randomUUID();
  const profileId = `key080-profile-${label}`,
    alias = `key080-alias-${label}`;
  const audit = { actorUserId: userId, entryPoint: 'key080-pg-fixture', requestId: randomUUID() };
  const now = new Date().toISOString(),
    effectiveAt = new Date(Date.now() - 60_000).toISOString();

  await phase('setup', () =>
    migrator.transaction(async (tx) => {
      assert.equal(
        (await tx.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role,
        'model_router_saas_migrator',
      );
      await tx.query('INSERT INTO saas_users (id, email) VALUES ($1, $2)', [
        userId,
        `key080-${label}@example.test`,
      ]);
      await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [
        tenantId,
        `key080-${label}`,
      ]);
      await tx.query("INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [
        tenantId,
        userId,
      ]);
      await tx.query('INSERT INTO saas_projects (tenant_id, id, name, slug) VALUES ($1, $2, $3, $3)', [
        tenantId,
        projectId,
        `key080-project-${label}`,
      ]);
      await tx.query(
        "INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'owner')",
        [tenantId, projectId, userId],
      );
      await tx.query(
        'INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes) VALUES ($1, $2, $3, $4)',
        [tenantId, profileId, 'byok', [alias]],
      );
      await tx.query(
        `INSERT INTO saas_project_entitlements
      (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes, source_type, effective_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'admin_grant', $7)`,
        [entitlementId, tenantId, projectId, profileId, 'byok', [alias], effectiveAt],
      );
      await tx.query(
        `INSERT INTO saas_api_keys
      (id, tenant_id, project_id, principal_user_id, execution_principal_type, execution_principal_id,
       created_by_user_id, entitlement_id, supply_profile_id, supply_mode, name, prefix, key_hash, model_scopes,
       authz_version, model_scope_version, entitlement_authz_version, supply_profile_authz_version)
      VALUES ($1, $2, $3, $4, 'member', $4, $4, $5, $6, $7, 'KEY080', 'mr_live_key080_probe', $8, $9, 1, 1, 1, 1)`,
        [keyId, tenantId, projectId, userId, entitlementId, profileId, 'byok', sha256Hex(`key080-key:${keyId}`), [alias]],
      );
      await tx.query(
        `INSERT INTO saas_api_key_ip_policies
      (tenant_id, project_id, key_id, version, mode, rules, created_at, updated_at)
      VALUES ($1, $2, $3, 1, 'disabled', '[]'::jsonb, $4, $4)`,
        [tenantId, projectId, keyId, now],
      );
    }),
  );
  const policy = await phase('setup', () =>
    new SaasProjectInferencePolicyService(migrator).enable({
      tenantId,
      projectId,
      expectedVersion: 1,
      audit,
    }),
  );
  return {
    tenantId,
    projectId,
    userId,
    keyId,
    entitlementId,
    profileId,
    alias,
    policyVersion: String(policy.version),
  };
}

async function ipPolicyAcl(controlPlane: SqlExecutor, gateway: SqlExecutor): Promise<void> {
  await phase('acl', async () => {
    // Column-level least privilege never rolls up to has_table_privilege in
    // PostgreSQL; probe representative columns for the granted privileges and
    // the table level for the mutation paths that must stay entirely absent.
    const control = await controlPlane.query<{
      role: string;
      selectHead: boolean;
      insertHead: boolean;
      updateRules: boolean;
      updateCreatedAt: boolean;
      deleteHead: boolean;
    }>(`SELECT current_user AS role,
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'version', 'SELECT') AS "selectHead",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'mode', 'INSERT') AS "insertHead",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'rules', 'UPDATE') AS "updateRules",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'created_at', 'UPDATE') AS "updateCreatedAt",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'DELETE') AS "deleteHead"`);
    assert.equal(control.rows.length, 1);
    const controlRow = control.rows[0]!;
    assert.equal(controlRow.role, 'model_router_saas_control_plane');
    assert.equal(controlRow.selectHead, true);
    assert.equal(controlRow.insertHead, true);
    assert.equal(controlRow.updateRules, true);
    assert.equal(controlRow.updateCreatedAt, false, 'created_at is insert-only evidence');
    assert.equal(controlRow.deleteHead, false, 'policy heads are never deleted under the runtime roles');

    const gw = await gateway.query<{
      role: string;
      selectHead: boolean;
      insertHead: boolean;
      updateHead: boolean;
      deleteHead: boolean;
    }>(`SELECT current_user AS role,
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'mode', 'SELECT') AS "selectHead",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'INSERT') AS "insertHead",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'UPDATE') AS "updateHead",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_ip_policies', 'DELETE') AS "deleteHead"`);
    assert.equal(gw.rows.length, 1);
    const gwRow = gw.rows[0]!;
    assert.equal(gwRow.role, 'model_router_saas_gateway');
    assert.equal(gwRow.selectHead, true, 'the admission guard reads the persisted head');
    assert.equal(gwRow.insertHead, false);
    assert.equal(gwRow.updateHead, false);
    assert.equal(gwRow.deleteHead, false);
  });
}

function guardFacts(seed: KeyIpSeed, authzVersion: string): { request: RequestRecord; candidate: AttemptRecord } {
  const NOW = new Date().toISOString();
  const request: RequestRecord = {
    id: randomUUID(),
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    proxyKeyId: seed.keyId,
    entitlementId: seed.entitlementId,
    supplyProfileId: seed.profileId,
    supplyProfileVersion: '1',
    modelScopeVersion: '1',
    supplyMode: 'byok',
    principalKind: 'member',
    principalId: seed.userId,
    authzVersion,
    entitlementVersion: '1',
    configVersion: '1',
    projectPolicyVersion: seed.policyVersion,
    customerMeteringPolicyId: 'key080-customer-policy',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'key080-provider-policy',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'key080-attestation',
    routeConfigId: 'key080-route',
    routeConfigVersion: '1',
    routePublicModelId: 'key080-public-model',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'tenant_account',
    routeUpstreamId: 'key080-upstream',
    publicModel: seed.alias,
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    requestFingerprint: sha256Hex(`key080-request:${seed.keyId}`),
    requestFingerprintVersion: 'canonical-v1',
    idempotencyKeyDigest: null,
    customerPriceVersion: null,
    financialStatus: 'not_applicable',
    resultState: 'pending',
    reconciliationState: 'none',
    createdAt: NOW,
    updatedAt: NOW,
    stateVersion: 1,
  };
  const candidate: AttemptRecord = {
    id: randomUUID(),
    tenantId: seed.tenantId,
    requestId: request.id,
    projectPolicyVersion: seed.policyVersion,
    customerPriceVersion: null,
    customerMeteringPolicyId: request.customerMeteringPolicyId,
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: request.providerMeteringPolicyId,
    providerMeteringPolicyVersion: '1',
    contractAttestationId: request.contractAttestationId,
    routeConfigId: request.routeConfigId,
    routeConfigVersion: '1',
    routePublicModelId: request.routePublicModelId,
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'tenant_account',
    ordinal: 1,
    upstreamId: 'key080-upstream',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'tenant',
    accountId: 'key080-account',
    providerId: 'key080-provider',
    productId: 'key080-product',
    resolvedModel: seed.alias,
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    supplierCostVersion: null,
    dispatchProfileId: seed.profileId,
    supplyProfileAuthzVersion: '1',
    credentialId: 'key080-credential',
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
    profileAccountAuthzVersion: '1',
    preparedEvidenceId: null,
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    stateVersion: 1,
  };
  return { request, candidate };
}

const resolved = (address: string): ClientAddressResolution => ({ status: 'resolved', address, source: 'socket-peer' });
const UNRESOLVED: ClientAddressResolution = { status: 'unresolved', reason: 'invalid-socket-peer' };

/**
 * The seeded authority facts let the guard clear every stage through the key
 * IP-policy cell; no saas_requests row exists, so a request that passes the
 * cell stops at the request lock with AUTHORITY_MISMATCH. CALLER_DENIED is
 * therefore exclusively attributable to the key IP-policy cell.
 */
async function guardOutcome(
  database: SaasDatabase,
  guard: PostgresRequestAdmissionGuard,
  seed: KeyIpSeed,
  authzVersion: string,
  clientAddress: ClientAddressResolution | null | undefined,
): Promise<PostgresRequestAdmissionGuardErrorCode | 'admitted'> {
  const { request, candidate } = guardFacts(seed, authzVersion);
  try {
    await database.transaction((tx) =>
      guard.revalidate({ executor: tx, request, candidate, holdEvidence: null, clientAddress }),
    );
    return 'admitted';
  } catch (error) {
    if (error instanceof PostgresRequestAdmissionGuardError) return error.code;
    throw error;
  }
}

async function replacePolicy(
  service: KeyService,
  seed: KeyIpSeed,
  expectedVersion: string,
  policy: KeyIpPolicyValue,
) {
  return service.replaceKeyIpPolicy(
    {
      userId: seed.userId,
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      tenantRole: 'owner',
      projectRole: 'owner',
    },
    seed.keyId,
    { expectedVersion, policy },
  );
}

async function assertVersionConflict(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    if (error instanceof SaasKeyError && error.status === 409 && error.code === 'KEY_IP_POLICY_VERSION_CONFLICT') {
      return true;
    }
    throw error;
  });
}

test('KEY080: real persistent key IP policy CAS and guard admission under restricted roles', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require KEY080`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const migrator = observedDatabase(urls[0]);
  const controlPlane = observedDatabase(urls[1]);
  const controlPlanePeer = observedDatabase(urls[1]);
  const gateway = observedDatabase(urls[2]);
  t.after(async () => {
    await phase('cleanup', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            gateway.database.close(),
            controlPlane.database.close(),
            controlPlanePeer.database.close(),
            migrator.database.close(),
          ]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('KEY080 cleanup deadline')), 30_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  });
  await phase('readiness', async () => {
    await migrator.database.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane.database, 'control_plane');
  });
  await ipPolicyAcl(controlPlane.database, gateway.database);

  await t.test('control-plane CAS: get, advance, stale conflict and concurrent single-winner', {
    timeout: 60_000,
  }, async () => {
    const seed = await seedFixture(migrator.database);
    const service = new KeyService(controlPlane.database);
    const context = {
      userId: seed.userId,
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      tenantRole: 'owner' as const,
      projectRole: 'owner' as const,
    };

    const initial = await phase('snapshot', () => service.getKeyIpPolicy(context, seed.keyId));
    assert.equal(initial.version, '1');
    assert.equal(initial.authzVersion, 1);
    assert.deepEqual(initial.policy, { mode: 'disabled', rules: [] });

    const allowlist: KeyIpPolicyValue = { mode: 'allowlist', rules: ['203.0.113.10/32', '2001:db8::/32'] };
    const advanced = await phase('first_complete', () => replacePolicy(service, seed, '1', allowlist));
    assert.equal(advanced.version, '2');
    assert.equal(advanced.authzVersion, 2, 'replacement atomically bumps the key authorization version');
    assert.deepEqual(advanced.policy, allowlist);
    const audits = await phase('snapshot', () =>
      migrator.database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM saas_audit_events WHERE tenant_id = $1 AND action = 'api_key.ip_policy_replaced'",
        [seed.tenantId],
      ),
    );
    assert.equal(audits.rows[0]?.count, '1', 'every committed replacement appends its audit row');

    // A stale expectation cannot move the head and leaves every fact untouched.
    await assertVersionConflict(() => replacePolicy(service, seed, '1', { mode: 'denyall', rules: [] }));
    const afterStale = await phase('snapshot', () => service.getKeyIpPolicy(context, seed.keyId));
    assert.equal(afterStale.version, '2');
    assert.deepEqual(afterStale.policy, allowlist);
    const staleAudits = await phase('snapshot', () =>
      migrator.database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM saas_audit_events WHERE tenant_id = $1 AND action = 'api_key.ip_policy_replaced'",
        [seed.tenantId],
      ),
    );
    assert.equal(staleAudits.rows[0]?.count, '1', 'a rejected replacement appends no audit row');

    // Two real connections race the identical replacement. The exclusive
    // fences serialize them: exactly one commits version 3 and the loser
    // re-reads the advanced head and conflicts.
    const peer = new KeyService(controlPlanePeer.database);
    const racePolicy: KeyIpPolicyValue = { mode: 'allowlist', rules: ['198.51.100.0/24'] };
    const outcomes = await Promise.allSettled([
      replacePolicy(service, seed, '2', racePolicy),
      replacePolicy(peer, seed, '2', racePolicy),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one racer commits the replacement');
    assert.equal(lost.length, 1);
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof replacePolicy>>>).value;
    assert.equal(winner.version, '3');
    assert.equal(winner.authzVersion, 3);
    const reason = (lost[0] as PromiseRejectedResult).reason;
    assert.ok(
      reason instanceof SaasKeyError && reason.status === 409 && reason.code === 'KEY_IP_POLICY_VERSION_CONFLICT',
      'the losing racer observes the exact version conflict',
    );
    const final = await phase('snapshot', () => service.getKeyIpPolicy(context, seed.keyId));
    assert.equal(final.version, '3');
    assert.deepEqual(final.policy, racePolicy);
  });

  await t.test('gateway guard: persisted head decides caller admission and fails closed', {
    timeout: 60_000,
  }, async () => {
    const seed = await seedFixture(migrator.database);
    const service = new KeyService(controlPlane.database);
    const guard = new PostgresRequestAdmissionGuard(gateway.database);
    const PASS = 'AUTHORITY_MISMATCH' as const; // Past the IP cell; stops at the absent request lock.
    const DENY = 'CALLER_DENIED' as const;

    // Disabled head: no caller evidence is required at all.
    assert.equal(await guardOutcome(gateway.database, guard, seed, '1', null), PASS);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '1', resolved('198.51.100.9')), PASS);

    // Allowlist head: IPv4/IPv6/CIDR membership decides; anything else fails closed.
    const allowlist: KeyIpPolicyValue = { mode: 'allowlist', rules: ['203.0.113.10', '2001:db8::/32'] };
    const v2 = await phase('first_complete', () => replacePolicy(service, seed, '1', allowlist));
    assert.equal(v2.authzVersion, 2);
    assert.deepEqual(v2.policy, { mode: 'allowlist', rules: ['203.0.113.10/32', '2001:db8::/32'] });

    // The atomic authz_version bump invalidates in-flight authority BEFORE the
    // IP cell: a stale snapshot with an out-of-policy address reports the
    // authority mismatch, never CALLER_DENIED.
    assert.equal(await guardOutcome(gateway.database, guard, seed, '1', resolved('198.51.100.9')), PASS);

    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', resolved('203.0.113.10')), PASS);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', resolved('2001:db8::1')), PASS);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', resolved('198.51.100.9')), DENY);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', resolved('2001:db9::1')), DENY);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', UNRESOLVED), DENY);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', null), DENY);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '2', undefined), DENY);

    // Denyall rejects every caller, resolved or not.
    const v3 = await phase('first_complete', () => replacePolicy(service, seed, '2', { mode: 'denyall', rules: [] }));
    assert.equal(v3.authzVersion, 3);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '3', resolved('203.0.113.10')), DENY);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '3', UNRESOLVED), DENY);

    // Returning to disabled reopens the key without caller evidence.
    const v4 = await phase('first_complete', () => replacePolicy(service, seed, '3', { mode: 'disabled', rules: [] }));
    assert.equal(v4.authzVersion, 4);
    assert.equal(await guardOutcome(gateway.database, guard, seed, '4', null), PASS);
  });
});
