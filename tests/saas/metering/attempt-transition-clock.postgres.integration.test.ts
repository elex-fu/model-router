import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { SaasMeteringError } from '../../../src/saas/metering/errors.js';
import { SaasMeteringService } from '../../../src/saas/metering/service.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from './normal-success-postgres-fixture.js';

test('PostgreSQL attempt time remains monotonic under a behind service clock and preserves version CAS', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and the three disposable role URLs`
      : false,
}, async (t) => {
  const urls = roleUrls();
  const migrator = observedDatabase(urls[0]);
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 2 });
  t.after(async () => {
    await Promise.allSettled([migrator.database.close(), gateway.close()]);
  });
  await gateway.verifySchema();

  for (const mode of ['byok', 'platform'] as const) {
    await t.test(`${mode} retains the persisted microsecond floor and rejects stale versions`, async () => {
      // Seed through the real claim/dispatch path with the default service
      // clock. No test clock advances or guard changes make this setup pass.
      const fixture = await seedFixture(migrator.database, gateway, mode);
      const attempt = fixture.sent;
      const identity = [fixture.tenantId, fixture.input.requestId, attempt.id];
      // A legal, versioned observation ahead of the current wall clock models
      // an already persisted DB timestamp before a host-clock rollback. Keep
      // all claim, binding, execution and financial facts intact.
      const future = await migrator.database.query<{ state_version: string; updated_at: string }>(
        `UPDATE saas_attempts
            SET updated_at = clock_timestamp() + interval '1 hour', state_version = state_version + 1
          WHERE tenant_id = $1 AND request_id = $2 AND id = $3
          RETURNING state_version::text, updated_at::text`,
        identity,
      );
      assert.equal(future.rows.length, 1);
      const persisted = future.rows[0];
      assert.ok(persisted);
      const version = Number(persisted.state_version);
      const service = new SaasMeteringService(gateway, { now: () => new Date('2000-01-01T00:00:00.000Z') });
      const transition = {
        tenantId: fixture.tenantId,
        requestId: fixture.input.requestId,
        attemptId: attempt.id,
        expectedDispatchState: 'sent' as const,
        expectedResultState: 'pending' as const,
        expectedResponseStarted: true,
        expectedStateVersion: version,
        dispatchState: 'unknown' as const,
        resultState: 'unknown' as const,
        unknownReason: 'clock-regression-evidence',
      };
      const before = await migrator.database.query<{ fact: unknown }>(
        'SELECT to_jsonb(a) AS fact FROM saas_attempts a WHERE tenant_id = $1 AND request_id = $2 AND id = $3',
        identity,
      );
      await assert.rejects(
        service.transitionAttempt({ ...transition, expectedStateVersion: version - 1 }),
        (error: unknown) => error instanceof SaasMeteringError && error.code === 'ATTEMPT_TRANSITION_INVALID',
      );
      assert.deepEqual(
        await migrator.database.query(
          'SELECT to_jsonb(a) AS fact FROM saas_attempts a WHERE tenant_id = $1 AND request_id = $2 AND id = $3',
          identity,
        ),
        before,
        'a stale version must leave every attempt field unchanged',
      );

      const unknown = await service.transitionAttempt(transition);
      assert.equal(unknown.stateVersion, version + 1);
      assert.equal(unknown.dispatchState, 'unknown');
      assert.equal(unknown.resultState, 'unknown');
      assert.equal(unknown.preparedEvidenceId, attempt.preparedEvidenceId);
      assert.equal(unknown.responseStartedAt, attempt.responseStartedAt);
      const observed = await migrator.database.query<{ exact_floor: boolean; version: string }>(
        `SELECT updated_at = $4::timestamptz AS exact_floor, state_version::text AS version
           FROM saas_attempts WHERE tenant_id = $1 AND request_id = $2 AND id = $3`,
        [...identity, persisted.updated_at],
      );
      assert.deepEqual(observed.rows, [{ exact_floor: true, version: String(version + 1) }]);
      await assert.rejects(
        service.transitionAttempt(transition),
        (error: unknown) => error instanceof SaasMeteringError && error.code === 'ATTEMPT_TRANSITION_INVALID',
      );
    });
  }
});
