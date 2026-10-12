import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import {
  verifyCredentialValidationWorkerRuntimePrivileges,
  verifySaasRuntimeDatabasePrivileges,
} from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  PostgresQuotaSyncWorkerStore,
  type ProviderQuotaProbeResult,
} from '../../../src/saas/supply/quota-sync-worker.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// D4 real-PG gate: provider account quota snapshots (migration 093) under the
// preprovisioned restricted roles. The worker role claims due accounts with
// SELECT ... FOR UPDATE SKIP LOCKED, unseals the current credential through
// the real envelope path, and overwrites the quota snapshot columns; the
// gateway reads the signal but can never write it. No bootstrap, HTTP fixture,
// migrations, DDL, role changes or provider traffic; the migrator seeds only
// the identity rows the flow needs.

const WORKER_URL_ENV = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL';

function workerUrl(): string {
  const value = process.env[WORKER_URL_ENV]?.trim();
  assert.ok(value, `${WORKER_URL_ENV} is required for the D4-093 real-PG gate`);
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${WORKER_URL_ENV} must be PostgreSQL`);
  assert.equal(
    decodeURIComponent(url.username),
    'model_router_saas_validation_worker',
    `${WORKER_URL_ENV} must use the validation worker role`,
  );
  assert.ok(url.search === '' && url.hash === '', `${WORKER_URL_ENV} must not contain overrides`);
  const [migratorUrl] = roleUrls();
  const migrator = new URL(migratorUrl);
  assert.equal(url.hostname.toLowerCase(), migrator.hostname.toLowerCase(), 'worker must share the gate host');
  assert.equal(url.port, migrator.port, 'worker must share the gate port');
  assert.equal(
    decodeURIComponent(url.pathname.slice(1)),
    decodeURIComponent(migrator.pathname.slice(1)),
    'worker must use the same disposable database',
  );
  return value;
}

const DEPLOYMENT = 'd4-gate-deployment';
const ENVIRONMENT = 'd4-gate-env';
const plaintextKey = Buffer.alloc(32, 0x57);
const sealingKms = {
  generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('d4-gate-wrapped-dek') }),
};
const unsealingKms: ProviderCredentialUnsealingKms = { decryptDataKey: async () => plaintextKey };

interface SeededAccount {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly secret: string;
}

async function seedAccount(migrator: SaasDatabase, ownerKind: 'tenant' | 'platform'): Promise<SeededAccount> {
  const label = randomUUID().slice(0, 8);
  const tenantId = ownerKind === 'tenant' ? randomUUID() : null;
  const accountId = `d4-account-${ownerKind}-${label}`;
  const credentialId = `d4-credential-${label}`;
  const secret = `sk-d4-gate-${label}`;
  const rightsId = `d4-rights-${label}`;
  const supplyMode = ownerKind === 'tenant' ? 'byok' : 'platform';

  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_products (provider_id, product_id, display_name)
     VALUES ('deepseek', 'deepseek-chat', 'D4 gate synthetic product')
     ON CONFLICT (provider_id, product_id) DO NOTHING`,
  );
  if (tenantId) {
    await migrator.query(`INSERT INTO model_router_saas.saas_tenants (id, name, slug) VALUES ($1, $2, $2)`, [
      tenantId,
      `d4-tenant-${label}`,
    ]);
  }
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_rights
       (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
        model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
     VALUES ($1, 1, 'deepseek', 'deepseek-chat', 'api-key', $2, 'test', 'inference',
             ARRAY['d4-model'], ARRAY['/v1/chat/completions'], '2026-09-28T00:00:00Z',
             $3, 'active', $3, $4)
     ON CONFLICT (rights_id, version) DO NOTHING`,
    [rightsId, supplyMode, `d4-approval-${label}`, 'a'.repeat(64)],
  );

  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_accounts
         (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, $2, 'D4 gate tenant account', 'deepseek', 'deepseek-chat', 'api-key', 'test', 'inference',
               $3, 1, 'active', 'verified')`,
      [tenantId, accountId, rightsId],
    );
  } else {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_accounts
         (id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, 'D4 gate platform account', 'deepseek', 'deepseek-chat', 'api-key', 'test', 'inference',
               $2, 1, 'active', 'verified')`,
      [accountId, rightsId],
    );
  }

  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_credentials
         (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state)
       VALUES ($1, $2, $3, 'deepseek', 'deepseek-chat', 'api-key', 'active', 'verified')`,
      [tenantId, credentialId, accountId],
    );
  } else {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_credentials
         (id, account_id, provider_id, product_id, credential_type, status, validation_state)
       VALUES ($1, $2, 'deepseek', 'deepseek-chat', 'api-key', 'active', 'verified')`,
      [credentialId, accountId],
    );
  }

  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: tenantId as string,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'deepseek',
          productId: 'deepseek-chat',
          credentialType: 'api-key',
          accountId,
          credentialId,
          credentialVersion: 1,
        }
      : {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'deepseek',
          productId: 'deepseek-chat',
          credentialType: 'api-key',
          accountId,
          credentialId,
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(Buffer.from(secret), context, sealingKms, 'd4-gate-kms');
  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_credential_versions
         (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm,
          kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
       VALUES ($1, $2, $3, 1, 1, 1, 'aes-256-gcm', 'inference', $4, $5, $6, $7, $8, 'active')`,
      [
        tenantId,
        accountId,
        credentialId,
        envelope.kmsKeyId,
        envelope.wrappedDek,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
      ],
    );
    await migrator.query(
      `UPDATE model_router_saas.saas_tenant_provider_credentials
          SET current_version = 1 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, credentialId],
    );
  } else {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_credential_versions
         (account_id, credential_id, version, schema_version, context_version, algorithm,
          kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
       VALUES ($1, $2, 1, 1, 1, 'aes-256-gcm', 'inference', $3, $4, $5, $6, $7, 'active')`,
      [
        accountId,
        credentialId,
        envelope.kmsKeyId,
        envelope.wrappedDek,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
      ],
    );
    await migrator.query(
      `UPDATE model_router_saas.saas_platform_provider_credentials
          SET current_version = 1 WHERE id = $1`,
      [credentialId],
    );
  }
  return { ownerKind, tenantId, accountId, credentialId, secret };
}

function snapshotQuery(ownerKind: 'tenant' | 'platform'): string {
  return ownerKind === 'tenant'
    ? `SELECT quota_state, quota_remaining_minor_units, quota_currency, quota_checked_at
         FROM model_router_saas.saas_tenant_provider_accounts WHERE tenant_id = $1 AND id = $2`
    : `SELECT quota_state, quota_remaining_minor_units, quota_currency, quota_checked_at
         FROM model_router_saas.saas_platform_provider_accounts WHERE id = $1`;
}

function successProbe(
  state: 'ok' | 'low' | 'exhausted',
  remaining: string,
  currency: string,
): ProviderQuotaProbeResult {
  return {
    state,
    remainingMinorUnits: remaining,
    currency,
    adapterId: 'deepseek-balance-v1',
    httpStatus: 200,
    durationMs: 1,
  };
}

/**
 * Accounts are never deleted (audit triggers), so earlier subtests and runs
 * leave due accounts behind. Draining makes the next seeded account the only
 * due one; drain writes are ordinary 'ok' snapshots, never deletes.
 */
async function drainDueAccounts(worker: SaasDatabase, ownerKind: 'tenant' | 'platform'): Promise<void> {
  const store = new PostgresQuotaSyncWorkerStore(worker, unsealingKms, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    owners: [ownerKind],
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const outcome = await store.syncNext(async () => successProbe('ok', '90000', 'CNY'));
    if (outcome.outcome === 'idle') return;
  }
  throw new Error('due account drain did not quiesce');
}

test('D4 quota sync snapshots run end-to-end under the restricted worker role with real unsealing', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs plus ${WORKER_URL_ENV} to require D4-093`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const worker = observedDatabase(workerUrl());
  try {
    await t.test('runtime probes cover control-plane, gateway and worker quota grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
      await verifyCredentialValidationWorkerRuntimePrivileges(worker.database);
    });

    await t.test('tenant and platform accounts sync exact snapshots through the worker role', async () => {
      for (const ownerKind of ['tenant', 'platform'] as const) {
        await drainDueAccounts(worker.database, ownerKind);
        const seeded = await seedAccount(migrator.database, ownerKind);
        const store = new PostgresQuotaSyncWorkerStore(worker.database, unsealingKms, {
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          owners: [ownerKind],
        });
        const seenSecrets: string[] = [];
        const outcome = await store.syncNext(async (account, secret) => {
          assert.equal(account.accountId, seeded.accountId);
          seenSecrets.push(secret.toString('utf8'));
          return successProbe('low', '120', 'CNY');
        });
        assert.deepEqual(outcome, { outcome: 'synced', ownerKind, accountId: seeded.accountId, state: 'low' });
        assert.deepEqual(seenSecrets, [seeded.secret], 'the worker unsealed the exact current credential');

        const identity = ownerKind === 'tenant' ? [seeded.tenantId, seeded.accountId] : [seeded.accountId];
        const snapshot = await migrator.database.query<{
          quota_state: string;
          quota_remaining_minor_units: string | null;
          quota_currency: string | null;
          quota_checked_at: Date | null;
        }>(snapshotQuery(ownerKind), identity);
        assert.equal(snapshot.rows[0]?.quota_state, 'low');
        assert.equal(snapshot.rows[0]?.quota_remaining_minor_units, '120');
        assert.equal(snapshot.rows[0]?.quota_currency, 'CNY');
        assert.ok(snapshot.rows[0]?.quota_checked_at instanceof Date);

        // The stamped attempt makes the account not-due: a second cycle is idle.
        const second = await store.syncNext(async () => successProbe('ok', '999999', 'CNY'));
        assert.deepEqual(second, { outcome: 'idle' });
      }
    });

    await t.test('a failed probe writes unknown with no amount and never guesses', async () => {
      await drainDueAccounts(worker.database, 'tenant');
      const seeded = await seedAccount(migrator.database, 'tenant');
      const store = new PostgresQuotaSyncWorkerStore(worker.database, unsealingKms, {
        deployment: DEPLOYMENT,
        environment: ENVIRONMENT,
        owners: ['tenant'],
      });
      const outcome = await store.syncNext(async () => ({
        state: 'unknown',
        errorCode: 'provider_timeout',
        retryable: true,
        adapterId: 'deepseek-balance-v1',
        httpStatus: null,
        durationMs: 5000,
      }));
      assert.deepEqual(outcome, {
        outcome: 'unknown',
        ownerKind: 'tenant',
        accountId: seeded.accountId,
        errorCode: 'provider_timeout',
      });
      const snapshot = await migrator.database.query<{
        quota_state: string;
        quota_remaining_minor_units: string | null;
        quota_currency: string | null;
        quota_checked_at: Date | null;
      }>(snapshotQuery('tenant'), [seeded.tenantId, seeded.accountId]);
      assert.equal(snapshot.rows[0]?.quota_state, 'unknown');
      assert.equal(snapshot.rows[0]?.quota_remaining_minor_units, null);
      assert.equal(snapshot.rows[0]?.quota_currency, null);
      assert.ok(snapshot.rows[0]?.quota_checked_at instanceof Date);
    });

    await t.test('SKIP LOCKED makes a concurrent claim idle instead of waiting or doubling', async () => {
      await drainDueAccounts(worker.database, 'tenant');
      const seeded = await seedAccount(migrator.database, 'tenant');
      // The contending claim needs its own connection: the first store holds
      // its transaction (and its pool connection) across the probe gate.
      const contending = observedDatabase(workerUrl());
      try {
        const first = new PostgresQuotaSyncWorkerStore(worker.database, unsealingKms, {
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          owners: ['tenant'],
        });
        const second = new PostgresQuotaSyncWorkerStore(contending.database, unsealingKms, {
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          owners: ['tenant'],
        });
        let releaseProbe: (() => void) | undefined;
        const probeGate = new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        const pending = first.syncNext(async () => {
          await probeGate;
          return successProbe('ok', '90000', 'CNY');
        });
        // The first claim holds the row lock across its probe; the second store
        // must observe the account as claimed and report idle, never wait.
        const concurrent = await second.syncNext(async () => successProbe('exhausted', '0', 'CNY'));
        assert.deepEqual(concurrent, { outcome: 'idle' });
        releaseProbe?.();
        const outcome = await pending;
        assert.deepEqual(outcome, { outcome: 'synced', ownerKind: 'tenant', accountId: seeded.accountId, state: 'ok' });
        const snapshot = await migrator.database.query<{ quota_state: string }>(snapshotQuery('tenant'), [
          seeded.tenantId,
          seeded.accountId,
        ]);
        assert.equal(snapshot.rows[0]?.quota_state, 'ok', 'exactly one writer committed its snapshot');
      } finally {
        await contending.database.close();
      }
    });

    await t.test(
      'gateway reads but never writes the signal; worker and control-plane stay in their lanes',
      async () => {
        await drainDueAccounts(worker.database, 'tenant');
        const seeded = await seedAccount(migrator.database, 'tenant');
        const store = new PostgresQuotaSyncWorkerStore(worker.database, unsealingKms, {
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          owners: ['tenant'],
        });
        await store.syncNext(async () => successProbe('exhausted', '0', 'CNY'));

        // Gateway participates in scheduling: it reads the snapshot columns.
        const gatewayRead = await gateway.database.query<{ quota_state: string }>(
          `SELECT quota_state FROM model_router_saas.saas_tenant_provider_accounts WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, seeded.accountId],
        );
        assert.equal(gatewayRead.rows[0]?.quota_state, 'exhausted');
        // ...but holds no UPDATE on the account tables at all.
        await assert.rejects(
          gateway.database.query(
            `UPDATE model_router_saas.saas_tenant_provider_accounts
              SET quota_state = 'ok' WHERE tenant_id = $1 AND id = $2`,
            [seeded.tenantId, seeded.accountId],
          ),
          (error: unknown) => (error as { code?: string }).code === '42501',
        );

        // The worker writes only the snapshot columns, never scheduling scalars
        // or account identity.
        await assert.rejects(
          worker.database.query(
            `UPDATE model_router_saas.saas_tenant_provider_accounts
              SET priority = 5 WHERE tenant_id = $1 AND id = $2`,
            [seeded.tenantId, seeded.accountId],
          ),
          (error: unknown) => (error as { code?: string }).code === '42501',
        );
        await assert.rejects(
          worker.database.query(
            `INSERT INTO model_router_saas.saas_tenant_provider_accounts
             (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose,
              rights_id, rights_version)
           VALUES ($1, 'd4-worker-forged', 'forged', 'deepseek', 'deepseek-chat', 'api-key', 'test',
                   'inference', 'd4-forged', 1)`,
            [seeded.tenantId],
          ),
          (error: unknown) => (error as { code?: string }).code === '42501',
        );

        // Control-plane keeps read-write operations access (operator reset to
        // the never-checked baseline; the shape CHECK rejects a contradictory
        // 'unknown' without an attempt timestamp).
        const reset = await control.database.query(
          `UPDATE model_router_saas.saas_tenant_provider_accounts
            SET quota_state = NULL, quota_remaining_minor_units = NULL, quota_currency = NULL,
                quota_checked_at = NULL, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, seeded.accountId],
        );
        assert.equal(reset.rowCount, 1);
        const reread = await control.database.query<{ quota_state: string | null }>(
          `SELECT quota_state FROM model_router_saas.saas_tenant_provider_accounts WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, seeded.accountId],
        );
        assert.equal(reread.rows[0]?.quota_state, null);
      },
    );
  } finally {
    await migrator.database.close();
    await control.database.close();
    await gateway.database.close();
    await worker.database.close();
  }
});
