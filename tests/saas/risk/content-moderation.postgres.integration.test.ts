import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { PostgresContentModerationStore } from '../../../src/saas/risk/postgres-store.js';
import {
  anyRoleConfigured,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

test('content moderation auto-ban commits through the real gateway role with least privilege', {
  skip: process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured ? 'requires disposable PostgreSQL role URLs' : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 2 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 2 });
  t.after(async () => {
    await Promise.all([migrator.close(), gateway.close()]);
  });
  await phase('readiness', () => verifySaasRuntimeDatabasePrivileges(gateway, 'gateway'));
  const store = new PostgresContentModerationStore(gateway);

  const state = async (userId: string) =>
    (
      await migrator.query<{
        disabled: boolean;
        status: string;
        version: string;
        revoked: boolean;
        audits: string;
      }>(
        `SELECT u.disabled_at IS NOT NULL AS disabled, k.status, k.authz_version::text AS version,
             k.revoked_at IS NOT NULL AS revoked,
             (SELECT count(*)::text FROM saas_audit_events a
               WHERE a.target_id = k.id::text AND a.action = 'api_key.revoked'
                 AND a.entry_point = 'gateway-content-moderation') AS audits
        FROM saas_users u JOIN saas_api_keys k ON k.principal_user_id = u.id WHERE u.id = $1`,
        [userId],
      )
    ).rows;

  await t.test('only the four revocation columns are writable; secrets and quotas remain forbidden', async () => {
    const privileges = await gateway.query<{ column_name: string; writable: boolean }>(
      `SELECT column_name, has_column_privilege(current_user, 'saas_api_keys', column_name, 'UPDATE') AS writable
         FROM information_schema.columns WHERE table_schema = 'model_router_saas' AND table_name = 'saas_api_keys'`,
    );
    assert.deepEqual(
      privileges.rows
        .filter((row) => row.writable)
        .map((row) => row.column_name)
        .sort(),
      ['authz_version', 'revoked_at', 'revoked_by_user_id', 'status'],
    );
  });

  await t.test('ban revokes keys, advances the authorization fence and audits exactly once', async () => {
    const fixture = await seedFixture(migrator, gateway, 'platform');
    assert.deepEqual(await phase('terminal_transition', () => store.disableUser(fixture.userId)), {
      newlyDisabled: true,
    });
    assert.deepEqual(await state(fixture.userId), [
      { disabled: true, status: 'revoked', version: '2', revoked: true, audits: '1' },
    ]);
    assert.deepEqual(await store.disableUser(fixture.userId), { newlyDisabled: false });
    assert.deepEqual(await state(fixture.userId), [
      { disabled: true, status: 'revoked', version: '2', revoked: true, audits: '1' },
    ]);
  });

  await t.test('already-disabled legacy users converge without reviving keys', async () => {
    const fixture = await seedFixture(migrator, gateway, 'platform');
    await migrator.query('UPDATE saas_users SET disabled_at = now() WHERE id = $1', [fixture.userId]);
    assert.deepEqual(await store.disableUser(fixture.userId), { newlyDisabled: false });
    assert.deepEqual(await state(fixture.userId), [
      { disabled: true, status: 'revoked', version: '2', revoked: true, audits: '1' },
    ]);
  });

  await t.test('governance-owned operators and their keys are protected', async () => {
    const fixture = await seedFixture(migrator, gateway, 'platform');
    await migrator.query("INSERT INTO saas_platform_role_assignments (user_id, role) VALUES ($1, 'security')", [
      fixture.userId,
    ]);
    assert.deepEqual(await store.disableUser(fixture.userId), { newlyDisabled: false });
    assert.deepEqual(await state(fixture.userId), [
      { disabled: false, status: 'active', version: '1', revoked: false, audits: '0' },
    ]);
  });

  await t.test('an audit failure rolls back both user and key revocation', async () => {
    const fixture = await seedFixture(migrator, gateway, 'platform');
    // Inject at the executor boundary inside a real gateway transaction. No
    // grants, database functions, triggers or production fault seams change.
    const failingDatabase: SaasDatabase = {
      ...gateway,
      transaction: (work) =>
        gateway.transaction((tx) =>
          work({
            query: (sql, values) => {
              if (sql.includes('INSERT INTO saas_audit_events')) throw new Error('synthetic audit failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(
      new PostgresContentModerationStore(failingDatabase).disableUser(fixture.userId),
      /synthetic audit failure/,
    );
    assert.deepEqual(await state(fixture.userId), [
      { disabled: false, status: 'active', version: '1', revoked: false, audits: '0' },
    ]);
  });
});
