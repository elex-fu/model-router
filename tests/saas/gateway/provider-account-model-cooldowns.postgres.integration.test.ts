import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresProviderAccountModelCooldownRegistry } from '../../../src/saas/gateway/postgres-provider-account-model-cooldowns.js';
import { MODEL_RATE_LIMIT_COOLDOWN_MS } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationPgConfigured,
} from './pre-dispatch-postgres-fixture.js';

const UPSTREAM = `mc-upstream-${randomUUID()}`;

function candidate(accountId: string, supplyMode: 'platform' | 'byok'): RequestPreparationCandidateAuthority {
  return {
    tenantId: 'mc-tenant-1',
    accountId,
    upstreamId: UPSTREAM,
    supplyMode,
    accountOwnerKind: supplyMode === 'platform' ? 'platform' : 'tenant',
  } as RequestPreparationCandidateAuthority;
}

function sqlState(error: unknown): string | undefined {
  const visited = new Set<object>();
  while (error && typeof error === 'object' && !visited.has(error)) {
    visited.add(error);
    if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}

test('durable model cooldowns are cross-instance, GREATEST-merged, and bounded by cooled_until', {
  skip:
    process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
      ? `set ${CANCELLATION_PG_REQUIRED}=1 and the disposable gateway E2E role URLs to require this gate`
      : false,
  timeout: 120_000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  const instanceA = new PostgresProviderAccountModelCooldownRegistry({ database: gateway });
  const instanceB = new PostgresProviderAccountModelCooldownRegistry({ database: gateway });
  const account = `mc-account-${randomUUID()}`;
  const T = Date.UTC(2026, 9, 19, 1, 0, 0);
  t.after(async () => {
    // The gateway role has no DELETE grant: cleanup runs as the migrator.
    await migrator
      .query('DELETE FROM saas_provider_account_model_cooldowns WHERE account_id = $1', [account])
      .catch(() => undefined);
    await Promise.allSettled(databases.map((database) => database.close()));
  });

  // Instance A records the model-unavailable outcome (the dispatch side).
  await instanceA.recordModelRateLimit({ candidate: candidate(account, 'platform'), model: 'model-a', nowMs: T });

  // Instance B never saw the in-process record — the durable row is the
  // only way it can observe the cooldown.
  assert.equal(
    await instanceB.isModelExcluded({
      candidate: candidate(account, 'platform'),
      model: 'model-a',
      now: new Date(T + 60_000),
    }),
    true,
  );

  // Owner-scope isolation: the same account id under the tenant scope is a
  // different pair (the shared key triple).
  assert.equal(
    await instanceB.isModelExcluded({
      candidate: candidate(account, 'byok'),
      model: 'model-a',
      now: new Date(T + 60_000),
    }),
    false,
  );

  // GREATEST merge: a shorter record from another instance never shortens
  // the cooldown already recorded.
  await instanceB.recordModelRateLimit({
    candidate: candidate(account, 'platform'),
    model: 'model-a',
    nowMs: T - 10 * 60_000,
  });
  assert.equal(
    await instanceA.isModelExcluded({
      candidate: candidate(account, 'platform'),
      model: 'model-a',
      now: new Date(T + 25 * 60_000),
    }),
    true,
  );

  // cooled_until is the invalidation bound: past it the pair schedules
  // again even though the row still exists.
  assert.equal(
    await instanceA.isModelExcluded({
      candidate: candidate(account, 'platform'),
      model: 'model-a',
      now: new Date(T + MODEL_RATE_LIMIT_COOLDOWN_MS + 1_000),
    }),
    false,
  );

  // The runtime role takes no DELETE privilege (expired rows are inert).
  await assert.rejects(
    gateway.query('DELETE FROM saas_provider_account_model_cooldowns WHERE account_id = $1', [account]),
    (error: unknown) => sqlState(error) === '42501',
  );
});
