import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

test('control-plane pool relationships preserve read-only authority and use PostgreSQL grant time', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and the three disposable role URLs`
      : false,
}, async (t) => {
  const urls = roleUrls();
  const migrator = observedDatabase(urls[0]);
  const controlPlane = createSaasDatabase({ connectionString: urls[1], max: 2 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 2 });
  t.after(async () => {
    await Promise.allSettled([migrator.database.close(), controlPlane.close(), gateway.close()]);
  });
  await gateway.verifySchema();
  const role = await migrator.database.query<{ role: string }>('SELECT current_user AS role');
  assert.equal(role.rows[0]?.role, 'model_router_saas_migrator');
  const writerRole = await controlPlane.query<{ role: string }>('SELECT current_user AS role');
  assert.equal(writerRole.rows[0]?.role, 'model_router_saas_control_plane');
  const fixture = await seedFixture(migrator.database, gateway, 'platform');
  const poolId = fixture.sent.poolId;
  const sourceAccountId = fixture.sent.accountId;
  assert.ok(poolId);
  assert.ok(sourceAccountId);
  const originalIdentity = [poolId, fixture.tenantId, fixture.profileId];
  const originalSql = `SELECT to_jsonb(g) AS fact FROM saas_platform_provider_pool_grants g
    WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3`;
  const original = await migrator.database.query(originalSql, originalIdentity);
  assert.equal(original.rows.length, 1);

  await t.test('control-plane adds and rebinds members while pool and profile UPDATE remain denied', async () => {
    const privileges = await controlPlane.query(
      `SELECT has_any_column_privilege(current_user, 'saas_platform_provider_pools', 'UPDATE') AS pool_update,
              has_any_column_privilege(current_user, 'saas_supply_profiles', 'UPDATE') AS profile_update`,
    );
    assert.deepEqual(privileges.rows, [{ pool_update: false, profile_update: false }]);
    for (const table of ['saas_platform_provider_pools', 'saas_supply_profiles']) {
      await assert.rejects(
        controlPlane.query(`UPDATE ${table} SET status = status WHERE false`),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '42501',
        'read-only authority must retain actual PostgreSQL permission denial',
      );
    }

    const supply = new ProviderSupplyService(controlPlane, {
      deployment: 'grant-clock-test',
      environment: 'test',
      kmsKeyId: 'grant-clock-unused-kms',
      sealingKms: {
        generateDataKey: async () => ({
          plaintextKey: Buffer.alloc(32, 0x41),
          ciphertextBlob: Buffer.from('grant-clock-synthetic-dek'),
        }),
      },
    });
    const sourceAccount = await supply.getProviderAccount(sourceAccountId);
    const accountInput = {
      providerId: sourceAccount.providerId,
      productId: sourceAccount.productId,
      credentialType: sourceAccount.credentialType,
      region: sourceAccount.region,
      purpose: sourceAccount.purpose,
      rightsId: sourceAccount.rightsId,
      rightsVersion: sourceAccount.rightsVersion,
      capabilities: sourceAccount.capabilities,
    };
    const newPool = await supply.createPlatformProviderPool({
      ...accountInput,
      id: `member-authority-${randomUUID()}`,
      displayName: 'Control-plane relationship authority fixture',
      status: 'active',
      validationState: 'verified',
    });
    await supply.addPlatformPoolMember({
      poolId: newPool.id,
      accountId: sourceAccount.id,
      expectedAccountAuthzVersion: sourceAccount.authzVersion,
    });
    const created = await supply.createPlatformProviderAccount({
      ...accountInput,
      id: `member-authority-${randomUUID()}`,
      displayName: 'Control-plane member replacement fixture',
      audit: { actorUserId: fixture.userId, entryPoint: 'grant-clock-test', requestId: randomUUID() },
    });
    const replacement = await supply.setProviderAccountValidation({
      accountId: created.id,
      expectedAuthzVersion: created.authzVersion,
      validationState: 'verified',
    });
    assert.equal(replacement.status, 'active');
    const imported = await supply.createPlatformProviderCredential({
      accountId: replacement.id,
      secret: Buffer.from('grant-clock-synthetic-provider-key'),
      audit: { actorUserId: fixture.userId, entryPoint: 'grant-clock-test', requestId: randomUUID() },
    });
    assert.equal(imported.credential.accountId, replacement.id);
    assert.equal(imported.credential.currentVersion, 1);
    assert.equal(imported.version.version, 1);
    assert.equal(imported.credential.validationState, 'unverified');
    assert.doesNotMatch(JSON.stringify(imported), /grant-clock-synthetic-provider-key/);
    const auditRequestId = randomUUID();
    const rebound = await supply.rebindPlatformPoolMember({
      poolId: newPool.id,
      accountId: sourceAccount.id,
      newAccountId: replacement.id,
      expectedAuthzVersion: 1,
      audit: { actorUserId: fixture.userId, entryPoint: 'grant-clock-test', requestId: auditRequestId },
    });
    assert.equal(rebound.accountId, replacement.id);
    assert.equal(rebound.accountAuthzVersion, replacement.authzVersion);
    assert.equal(rebound.authzVersion, 1);
    const members = await controlPlane.query(
      `SELECT account_id, status, authz_version::text, account_authz_version::text
         FROM saas_platform_provider_pool_members WHERE pool_id = $1 ORDER BY account_id`,
      [newPool.id],
    );
    assert.deepEqual(
      members.rows,
      [
        {
          account_id: sourceAccount.id,
          status: 'revoked',
          authz_version: '2',
          account_authz_version: String(sourceAccount.authzVersion),
        },
        {
          account_id: replacement.id,
          status: 'active',
          authz_version: '1',
          account_authz_version: String(replacement.authzVersion),
        },
      ].sort((a, b) => a.account_id.localeCompare(b.account_id)),
    );
    const audits = await migrator.database.query('SELECT action FROM saas_audit_events WHERE request_id = $1', [
      auditRequestId,
    ]);
    assert.deepEqual(audits.rows, [{ action: 'provider_pool_member.rebound' }]);
  });

  async function createProfile(): Promise<string> {
    const profileId = `grant-clock-${randomUUID()}`;
    const inserted = await migrator.database.query(
      `INSERT INTO saas_supply_profiles
         (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
       SELECT tenant_id, $3, supply_mode, status, model_scopes, 1, clock_timestamp(), clock_timestamp(), clock_timestamp()
         FROM saas_supply_profiles WHERE tenant_id = $1 AND id = $2 RETURNING id`,
      [fixture.tenantId, fixture.profileId, profileId],
    );
    assert.equal(inserted.rows.length, 1);
    return profileId;
  }

  async function assertImmediate(profileId: string, evidenceReference: string): Promise<void> {
    const facts = await gateway.query(
      `SELECT effective_at <= clock_timestamp() AS active_now,
              effective_at >= clock_timestamp() - interval '1 minute' AS within_database_creation,
              effective_at = created_at AND effective_at = updated_at AS same_clock,
              evidence_ref, evidence_sha256
         FROM saas_platform_provider_pool_grants
        WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3`,
      [poolId, fixture.tenantId, profileId],
    );
    assert.deepEqual(facts.rows, [
      {
        active_now: true,
        within_database_creation: true,
        same_clock: true,
        evidence_ref: evidenceReference,
        evidence_sha256: 'b'.repeat(64),
      },
    ]);
  }

  for (const serviceTime of ['2100-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z']) {
    await t.test(`service time ${serviceTime.slice(0, 4)} cannot postpone or backdate an immediate grant`, async () => {
      const profileId = await createProfile();
      const supply = new ProviderSupplyService(controlPlane, {
        deployment: 'grant-clock-test',
        environment: 'test',
        kmsKeyId: 'grant-clock-unused-kms',
        now: () => new Date(serviceTime),
      });
      const evidenceReference = `grant-clock-${randomUUID()}`;
      const grant = await supply.grantPlatformPoolToProfile({
        poolId,
        tenantId: fixture.tenantId,
        supplyProfileId: profileId,
        evidenceReference,
        evidenceSha256: 'b'.repeat(64),
      });
      assert.equal(grant.status, 'active');
      assert.equal(grant.authzVersion, 1);
      await assertImmediate(profileId, evidenceReference);

      const oldFactsSql = `SELECT status, authz_version::text, effective_at::text, created_at::text,
        evidence_ref, evidence_sha256 FROM saas_platform_provider_pool_grants
        WHERE pool_id = $1 AND tenant_id = $2 AND supply_profile_id = $3`;
      const oldIdentity = [poolId, fixture.tenantId, profileId];
      const oldFacts = await gateway.query<Record<string, unknown>>(oldFactsSql, oldIdentity);
      const replacementProfileId = await createProfile();
      const auditRequestId = randomUUID();
      const rebound = await supply.rebindPlatformPoolGrant({
        poolId,
        tenantId: fixture.tenantId,
        supplyProfileId: profileId,
        newSupplyProfileId: replacementProfileId,
        expectedAuthzVersion: grant.authzVersion,
        audit: { actorUserId: fixture.userId, entryPoint: 'grant-clock-test', requestId: auditRequestId },
      });
      assert.equal(rebound.authzVersion, 1);
      await assertImmediate(replacementProfileId, evidenceReference);
      assert.deepEqual(
        (await gateway.query(oldFactsSql, oldIdentity)).rows,
        [{ ...oldFacts.rows[0], status: 'revoked', authz_version: '2' }],
        'rebind retains the original effective time, evidence and creation facts',
      );
      const audits = await migrator.database.query(
        `SELECT a.action, a.occurred_at = g.effective_at AS same_clock
           FROM saas_audit_events a JOIN saas_platform_provider_pool_grants g ON g.tenant_id = a.tenant_id
          WHERE a.request_id = $1 AND g.pool_id = $2 AND g.supply_profile_id = $3`,
        [auditRequestId, poolId, replacementProfileId],
      );
      assert.deepEqual(audits.rows, [{ action: 'provider_pool_grant.rebound', same_clock: true }]);
      assert.deepEqual(
        await migrator.database.query(originalSql, originalIdentity),
        original,
        'a new grant must not rewrite prior grant evidence or authorization versions',
      );
    });
  }
});
