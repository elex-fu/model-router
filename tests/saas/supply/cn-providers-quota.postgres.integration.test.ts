import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  evaluateSchedulingThresholdPause,
  type SchedulingThresholdAccountRow,
  schedulingThresholdCandidatesFromRow,
} from '../../../src/saas/gateway/provider-account-scheduling-threshold.js';
import {
  CnProvidersQuotaStoreError,
  PostgresCnProvidersQuotaStore,
} from '../../../src/saas/supply/cn-providers-quota-store-postgres.js';
import type { CnQuotaAccountRef } from '../../../src/saas/supply/cn-providers-quota-worker.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

const KMS = {
  decryptDataKey: async () => {
    throw new Error('snapshot tests never decrypt credentials');
  },
};

async function seedAccount(
  database: SaasDatabase,
  ownerKind: 'tenant' | 'platform',
  productId = 'kimi-code',
): Promise<CnQuotaAccountRef> {
  const suffix = randomUUID();
  const accountId = `kimi-quota-${suffix}`;
  const tenantId = ownerKind === 'tenant' ? randomUUID() : null;
  const rightsId = `kimi-quota-rights-${suffix}`;
  await database.query(
    `INSERT INTO saas_provider_products (provider_id, product_id, display_name)
    VALUES ('kimi', $1, 'Kimi quota synthetic fixture') ON CONFLICT (provider_id, product_id) DO NOTHING`,
    [productId],
  );
  if (tenantId !== null)
    await database.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)`, [
      tenantId,
      `kimi-quota-${suffix}`,
    ]);
  await database.query(
    `INSERT INTO saas_provider_rights
    (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
     model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
    VALUES ($1, 1, 'kimi', $2, 'api-key', $3, 'test', 'inference', ARRAY['kimi-for-coding'],
      ARRAY['messages'], '2026-09-28T00:00:00Z', $4, 'active', $4, $5)`,
    [rightsId, productId, ownerKind === 'tenant' ? 'byok' : 'platform', `kimi-quota-${suffix}`, 'a'.repeat(64)],
  );
  if (tenantId !== null) {
    await database.query(
      `INSERT INTO saas_tenant_provider_accounts
      (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version, status, validation_state)
      VALUES ($1, $2, 'Kimi quota fixture', 'kimi', $3, 'api-key', 'test', 'inference', $4, 1, 'active', 'verified')`,
      [tenantId, accountId, productId, rightsId],
    );
  } else {
    await database.query(
      `INSERT INTO saas_platform_provider_accounts
      (id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version, status, validation_state)
      VALUES ($1, 'Kimi quota fixture', 'kimi', $2, 'api-key', 'test', 'inference', $3, 1, 'active', 'verified')`,
      [accountId, productId, rightsId],
    );
  }
  return { ownerKind, tenantId, accountId, providerId: 'kimi', productId };
}

function table(account: CnQuotaAccountRef): string {
  return account.ownerKind === 'tenant' ? 'saas_tenant_provider_accounts' : 'saas_platform_provider_accounts';
}

test('Kimi quota snapshots keep successful freshness through claims/failures and recover on a reset under restricted roles', {
  skip:
    !anyRoleConfigured && process.env[REQUIRED_FLAG] !== '1' ? 'requires disposable PostgreSQL gate role URLs' : false,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const workerUrl = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL;
  assert.ok(workerUrl, 'quota integration requires the dedicated validation worker role URL');
  const workerTarget = new URL(workerUrl);
  const migratorTarget = new URL(migratorUrl);
  assert.equal(decodeURIComponent(workerTarget.username), 'model_router_saas_validation_worker');
  assert.equal(workerTarget.host, migratorTarget.host);
  assert.equal(workerTarget.pathname, migratorTarget.pathname);
  assert.equal(workerTarget.search, '');
  assert.equal(workerTarget.hash, '');
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const worker = observedDatabase(workerUrl);
  t.after(async () => {
    await Promise.all([
      migrator.database.close(),
      control.database.close(),
      gateway.database.close(),
      worker.database.close(),
    ]);
  });
  const store = new PostgresCnProvidersQuotaStore(worker.database, KMS, {
    deployment: 'kimi-quota-test',
    environment: 'test',
  });
  const nowMs = Date.now();
  const oldSuccess = new Date(nowMs - 3 * 3_600_000).toISOString();
  const resetAt = new Date(nowMs + 5 * 3_600_000).toISOString();
  const accounts = [
    await seedAccount(migrator.database, 'tenant'),
    await seedAccount(migrator.database, 'platform', 'kimi-code-global'),
  ];
  const payg = await seedAccount(migrator.database, 'platform', 'kimi-platform');
  for (const account of accounts) {
    await migrator.database.query(
      `UPDATE ${table(account)} SET kimi_5h_used_percent = 100,
      kimi_5h_reset_at = $2, kimi_usage_updated_at = $3 WHERE id = $1`,
      [account.accountId, resetAt, oldSuccess],
    );
  }
  const due = await store.readDueAccounts({ nowMs, debounceMs: 60_000, intervalMs: 900_000, limit: 20 });
  assert.ok(
    accounts.every((account) =>
      due.some((ref) => ref.accountId === account.accountId && ref.productId === account.productId),
    ),
  );
  assert.equal(
    due.some((ref) => ref.accountId === payg.accountId),
    false,
  );

  for (const account of accounts) {
    await store.writeQuotaFailure(account, {
      attemptedAtMs: nowMs + 1_000,
      nextDueAtMs: nowMs + 900_000,
      errorCode: 'provider_network_error',
      httpStatus: null,
      retryAfterMs: null,
      failureCount: 1,
    });
    const old = (
      await gateway.database.query<{
        kimi_usage_updated_at: Date;
        kimi_usage_attempted_at: Date;
        kimi_5h_used_percent: number;
      }>(
        `SELECT kimi_usage_updated_at, kimi_usage_attempted_at, kimi_5h_used_percent FROM ${table(account)} WHERE id = $1`,
        [account.accountId],
      )
    ).rows[0];
    assert.equal(old?.kimi_usage_updated_at.toISOString(), oldSuccess);
    assert.equal(old?.kimi_usage_attempted_at.getTime(), nowMs + 1_000);
    assert.equal(old?.kimi_5h_used_percent, 100);
    await store.writeQuotaSnapshot(account, {
      fiveHour: { window: '5h', usedPercent: 100, resetAt },
      weekly: null,
      fetchedAtMs: nowMs,
      nextDueAtMs: nowMs + 900_000,
    });
    const fresh = (
      await gateway.database.query<SchedulingThresholdAccountRow>(
        `SELECT id AS account_id,
      kimi_5h_used_percent, kimi_5h_reset_at, kimi_weekly_used_percent, kimi_weekly_reset_at, kimi_usage_updated_at,
      auto_pause_5h_threshold, auto_pause_7d_threshold FROM ${table(account)} WHERE id = $1`,
        [account.accountId],
      )
    ).rows[0];
    assert.ok(fresh);
    const pause = evaluateSchedulingThresholdPause({
      nowMs,
      candidates: schedulingThresholdCandidatesFromRow(fresh, nowMs),
    });
    assert.equal(pause?.platform, 'kimi');
    assert.equal(pause?.untilMs, nowMs + 2 * 3_600_000);
    await migrator.database.query(
      `UPDATE ${table(account)} SET scheduling_threshold_pause_until = $2,
      scheduling_threshold_pause_reason = '{"source":"account_scheduling_threshold","platform":"kimi"}'::jsonb WHERE id = $1`,
      [account.accountId, resetAt],
    );
    await store.writeQuotaSnapshot(account, {
      fiveHour: { window: '5h', usedPercent: 0, resetAt },
      weekly: null,
      fetchedAtMs: nowMs + 2_000,
      nextDueAtMs: nowMs + 902_000,
    });
    const recovered = (
      await gateway.database.query<{
        scheduling_threshold_pause_until: Date | null;
        kimi_5h_used_percent: number;
        kimi_usage_failure_count: number;
      }>(
        `SELECT scheduling_threshold_pause_until, kimi_5h_used_percent, kimi_usage_failure_count FROM ${table(account)} WHERE id = $1`,
        [account.accountId],
      )
    ).rows[0];
    assert.equal(recovered?.scheduling_threshold_pause_until, null);
    assert.equal(recovered?.kimi_5h_used_percent, 0);
    assert.equal(recovered?.kimi_usage_failure_count, 0);
  }
  const gatewayStore = new PostgresCnProvidersQuotaStore(gateway.database, KMS, {
    deployment: 'kimi-quota-test',
    environment: 'test',
  });
  const account = accounts[0];
  assert.ok(account);
  await assert.rejects(gatewayStore.markRateLimited(account, nowMs + 60_000), CnProvidersQuotaStoreError);
});
