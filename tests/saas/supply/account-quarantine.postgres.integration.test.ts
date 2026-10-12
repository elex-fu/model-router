import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialSealingKms,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import {
  verifyCredentialValidationWorkerRuntimePrivileges,
  verifySaasRuntimeDatabasePrivileges,
} from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  createCredentialValidationWorkerUnsealingKms,
  createProviderCredentialSealingKms,
} from '../../../src/saas/runtime/software-provider-credential-kms.js';
import type { ProviderCredentialValidationFetch } from '../../../src/saas/supply/credential-validation-adapters.js';
import {
  CredentialValidationWorker,
  PostgresCredentialValidationWorkerStore,
  PROVIDER_ACCOUNT_QUARANTINE_AUDIT_ACTION,
  type ProviderAccountQuarantineAuditEvent,
} from '../../../src/saas/supply/credential-validation-worker.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
  safeCodes,
} from '../metering/normal-success-postgres-fixture.js';

// R5 real-PG gate: credential quarantine middle state (migration 097) under
// the preprovisioned restricted roles. The validation-worker role runs the
// full chain with real envelope unsealing: three consecutive terminal 401
// failures move the account failed -> quarantined (error code migrated into
// the quarantine reason in the same statement, audit hook fired exactly
// once), the gateway-role eligibility predicate keeps excluding the account,
// the D3 sweep requeues it only on the independent quarantine cadence option,
// and a successful probe returns it to verified with both fact columns
// cleared. The 097 guard trigger's negative matrix (55006) is verified with
// direct migrator SQL on both account tables. No bootstrap, HTTP fixture,
// migrations, DDL, role changes or provider traffic; the migrator seeds only
// the identity rows the flow needs.
//
// Requeue driving between failures: the D3 sweep only requeues
// verified/active accounts and the 061 audited requeue channel is pinned to
// migration <= 61, so the migrator re-arms the job with exactly the sweep's
// transition shape (an external driver stand-in). The worker-side chain —
// claim, probe, health write, counting, quarantine transition — is fully real.

const WORKER_URL_ENV = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL';
const KMS_KEY_ENV = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY';
const KMS_KEY_ID_ENV = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID';

function workerUrl(): string {
  const value = process.env[WORKER_URL_ENV]?.trim();
  assert.ok(value, `${WORKER_URL_ENV} is required for the R5-097 real-PG gate`);
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

const DEPLOYMENT = 'r5-gate-deployment';
const ENVIRONMENT = 'r5-gate-env';
const PROVIDER = { providerId: 'kimi', productId: 'kimi-platform', credentialType: 'api-key' } as const;
const ENDPOINT = 'chat-completions';
const SECRET = 'r5-gate-provider-api-key';
/** Independent quarantine cadence for this gate: the bounded option minimum. */
const QUARANTINE_SECONDS = 900;

function softwareKmsEnv(): NodeJS.ProcessEnv {
  assert.ok(/^[0-9a-fA-F]{64}$/.test(process.env[KMS_KEY_ENV] ?? ''), `${KMS_KEY_ENV} (64 hex) is required`);
  assert.equal(process.env[KMS_KEY_ID_ENV], 'software-local', `${KMS_KEY_ID_ENV} must be software-local`);
  return process.env;
}

interface SeededAccount {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly jobId: string;
  readonly model: string;
}

async function seedAccount(
  migrator: SaasDatabase,
  sealingKms: ProviderCredentialSealingKms,
  ownerKind: 'tenant' | 'platform',
  options: { readonly revalidationIntervalSeconds: number | null; readonly jobTerminal: boolean },
): Promise<SeededAccount> {
  const label = randomUUID().slice(0, 8);
  const tenantId = ownerKind === 'tenant' ? randomUUID() : null;
  const accountId = `r5-account-${ownerKind}-${label}`;
  const credentialId = `r5-credential-${label}`;
  const rightsId = `r5-rights-${label}`;
  const model = `r5-model-${label}`;
  const supplyMode = ownerKind === 'tenant' ? 'byok' : 'platform';

  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_products (provider_id, product_id, display_name)
     VALUES ($1, $2, 'R5 gate synthetic product')
     ON CONFLICT (provider_id, product_id) DO NOTHING`,
    [PROVIDER.providerId, PROVIDER.productId],
  );
  if (tenantId) {
    await migrator.query(`INSERT INTO model_router_saas.saas_tenants (id, name, slug) VALUES ($1, $2, $2)`, [
      tenantId,
      `r5-tenant-${label}`,
    ]);
  }
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_rights
       (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
        model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
     VALUES ($1, 1, $2, $3, 'api-key', $4, 'test', 'inference',
             ARRAY[$7], ARRAY[$8], '2026-09-28T00:00:00Z',
             $5, 'active', $5, $6)`,
    [
      rightsId,
      PROVIDER.providerId,
      PROVIDER.productId,
      supplyMode,
      `r5-approval-${label}`,
      'b'.repeat(64),
      model,
      ENDPOINT,
    ],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_capabilities
       (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
        evidence_version, discovery_source, evidence_ref, evidence_sha256)
     VALUES ($1, $2, $5, $6, 'openai-compatible', 1, 'supported', 'verified',
             'r5-evidence-v1', 'manual', $3, $4)`,
    [PROVIDER.providerId, PROVIDER.productId, `r5-capability-${label}`, 'c'.repeat(64), model, ENDPOINT],
  );

  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: tenantId as string,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          ...PROVIDER,
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
          ...PROVIDER,
          accountId,
          credentialId,
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(Buffer.from(SECRET), context, sealingKms, 'software-local');

  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_accounts
         (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state, revalidation_interval_seconds)
       VALUES ($1, $2, 'R5 gate tenant account', $3, $4, 'api-key', 'test', 'inference',
               $5, 1, 'active', 'verified', $6)`,
      [tenantId, accountId, PROVIDER.providerId, PROVIDER.productId, rightsId, options.revalidationIntervalSeconds],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_account_capabilities
         (tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [tenantId, accountId, PROVIDER.providerId, PROVIDER.productId, model, ENDPOINT],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_credentials
         (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state)
       VALUES ($1, $2, $3, $4, $5, 'api-key', 'active', 'verified')`,
      [tenantId, credentialId, accountId, PROVIDER.providerId, PROVIDER.productId],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_credential_versions
         (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm,
          kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
       VALUES ($1, $2, $3, 1, $4, $5, $6, 'inference', $7, $8, $9, $10, $11, 'active')`,
      [
        tenantId,
        accountId,
        credentialId,
        envelope.schemaVersion,
        envelope.contextVersion,
        envelope.algorithm,
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
    const job = await migrator.query<{ id: string }>(
      `INSERT INTO model_router_saas.saas_tenant_provider_credential_validation_jobs
         (tenant_id, account_id, credential_id, credential_version, provider_id, product_id, credential_type,
          allowed_models, target_model, target_endpoint, capability_version, idempotency_key,
          status, attempt_count, lease_generation, completed_at)
       VALUES ($1, $2, $3, 1, $4, $5, 'api-key', ARRAY[$6]::text[], $6, $7, 1, $8,
               $9, $10, $11, CASE WHEN $9 = 'verified' THEN clock_timestamp() ELSE NULL END)
       RETURNING id`,
      [
        tenantId,
        accountId,
        credentialId,
        PROVIDER.providerId,
        PROVIDER.productId,
        model,
        ENDPOINT,
        createHash('sha256').update(randomUUID()).digest('hex'),
        options.jobTerminal ? 'verified' : 'queued',
        options.jobTerminal ? 1 : 0,
        options.jobTerminal ? 1 : 0,
      ],
    );
    const jobId = job.rows[0]?.id;
    assert.ok(jobId);
    return { ownerKind, tenantId, accountId, credentialId, jobId, model };
  }

  await migrator.query(
    `INSERT INTO model_router_saas.saas_platform_provider_accounts
       (id, display_name, provider_id, product_id, credential_type, region, purpose,
        rights_id, rights_version, status, validation_state, revalidation_interval_seconds)
     VALUES ($1, 'R5 gate platform account', $2, $3, 'api-key', 'test', 'inference',
             $4, 1, 'active', 'verified', $5)`,
    [accountId, PROVIDER.providerId, PROVIDER.productId, rightsId, options.revalidationIntervalSeconds],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_platform_provider_account_capabilities
       (account_id, provider_id, product_id, model, endpoint, capability_version)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [accountId, PROVIDER.providerId, PROVIDER.productId, model, ENDPOINT],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_platform_provider_credentials
       (id, account_id, provider_id, product_id, credential_type, status, validation_state)
     VALUES ($1, $2, $3, $4, 'api-key', 'active', 'verified')`,
    [credentialId, accountId, PROVIDER.providerId, PROVIDER.productId],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_platform_provider_credential_versions
       (account_id, credential_id, version, schema_version, context_version, algorithm,
        kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
     VALUES ($1, $2, 1, $3, $4, $5, 'inference', $6, $7, $8, $9, $10, 'active')`,
    [
      accountId,
      credentialId,
      envelope.schemaVersion,
      envelope.contextVersion,
      envelope.algorithm,
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
  const job = await migrator.query<{ id: string }>(
    `INSERT INTO model_router_saas.saas_platform_provider_credential_validation_jobs
       (account_id, credential_id, credential_version, provider_id, product_id, credential_type,
        allowed_models, target_model, target_endpoint, capability_version, idempotency_key,
        status, attempt_count, lease_generation, completed_at)
     VALUES ($1, $2, 1, $3, $4, 'api-key', ARRAY[$5]::text[], $5, $6, 1, $7,
             $8, $9, $10, CASE WHEN $8 = 'verified' THEN clock_timestamp() ELSE NULL END)
     RETURNING id`,
    [
      accountId,
      credentialId,
      PROVIDER.providerId,
      PROVIDER.productId,
      model,
      ENDPOINT,
      createHash('sha256').update(randomUUID()).digest('hex'),
      options.jobTerminal ? 'verified' : 'queued',
      options.jobTerminal ? 1 : 0,
      options.jobTerminal ? 1 : 0,
    ],
  );
  const jobId = job.rows[0]?.id;
  assert.ok(jobId);
  return { ownerKind, tenantId, accountId, credentialId, jobId, model };
}

interface AccountRow {
  status: string;
  validation_state: string;
  validation_error_code: string | null;
  quarantine_entered_at: Date | null;
  quarantine_reason_code: string | null;
}

async function readAccount(migrator: SaasDatabase, seeded: SeededAccount): Promise<AccountRow> {
  const result = await migrator.query<AccountRow>(
    seeded.ownerKind === 'tenant'
      ? `SELECT status, validation_state, validation_error_code, quarantine_entered_at, quarantine_reason_code
           FROM model_router_saas.saas_tenant_provider_accounts WHERE tenant_id = $1 AND id = $2`
      : `SELECT status, validation_state, validation_error_code, quarantine_entered_at, quarantine_reason_code
           FROM model_router_saas.saas_platform_provider_accounts WHERE id = $1`,
    seeded.ownerKind === 'tenant' ? [seeded.tenantId, seeded.accountId] : [seeded.accountId],
  );
  const row = result.rows[0];
  assert.ok(row, 'seeded account must exist');
  return row;
}

interface JobRow {
  status: string;
  attempt_count: number;
  completed_at: Date | null;
}

async function readJob(migrator: SaasDatabase, seeded: SeededAccount): Promise<JobRow> {
  const result = await migrator.query<JobRow>(
    seeded.ownerKind === 'tenant'
      ? `SELECT status, attempt_count, completed_at
           FROM model_router_saas.saas_tenant_provider_credential_validation_jobs
          WHERE tenant_id = $1 AND id = $2`
      : `SELECT status, attempt_count, completed_at
           FROM model_router_saas.saas_platform_provider_credential_validation_jobs
          WHERE id = $1`,
    seeded.ownerKind === 'tenant' ? [seeded.tenantId, seeded.jobId] : [seeded.jobId],
  );
  const row = result.rows[0];
  assert.ok(row, 'seeded job must exist');
  return row;
}

/** The external requeue driver stand-in: exactly the D3 sweep transition shape. */
async function requeueJob(migrator: SaasDatabase, seeded: SeededAccount): Promise<void> {
  const result = await migrator.query(
    seeded.ownerKind === 'tenant'
      ? `UPDATE model_router_saas.saas_tenant_provider_credential_validation_jobs
            SET status = 'queued', attempt_count = 0, available_at = clock_timestamp(),
                lease_until = NULL, lease_generation = lease_generation + 1,
                last_error_code = NULL, completed_at = NULL, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND status IN ('verified', 'failed')`
      : `UPDATE model_router_saas.saas_platform_provider_credential_validation_jobs
            SET status = 'queued', attempt_count = 0, available_at = clock_timestamp(),
                lease_until = NULL, lease_generation = lease_generation + 1,
                last_error_code = NULL, completed_at = NULL, updated_at = clock_timestamp()
          WHERE id = $1 AND status IN ('verified', 'failed')`,
    seeded.ownerKind === 'tenant' ? [seeded.tenantId, seeded.jobId] : [seeded.jobId],
  );
  assert.equal(result.rowCount, 1, 'requeue must transition exactly one terminal job');
}

async function backdateJobCompletion(migrator: SaasDatabase, seeded: SeededAccount, seconds: number): Promise<void> {
  const result = await migrator.query(
    seeded.ownerKind === 'tenant'
      ? `UPDATE model_router_saas.saas_tenant_provider_credential_validation_jobs
            SET completed_at = clock_timestamp() - make_interval(secs => $3)
          WHERE tenant_id = $1 AND id = $2 AND completed_at IS NOT NULL`
      : `UPDATE model_router_saas.saas_platform_provider_credential_validation_jobs
            SET completed_at = clock_timestamp() - make_interval(secs => $2)
          WHERE id = $1 AND completed_at IS NOT NULL`,
    seeded.ownerKind === 'tenant' ? [seeded.tenantId, seeded.jobId, seconds] : [seeded.jobId, seconds],
  );
  assert.equal(result.rowCount, 1);
}

/**
 * The eligibility predicate core pinned by BYOK_ELIGIBILITY_SQL /
 * PLATFORM_ELIGIBILITY_SQL in postgres-provider-account-scheduler.ts:
 * account.status = 'active' AND account.validation_state = 'verified'. Run
 * under the real gateway role so the grant surface is the production one.
 */
async function eligibleAccountCount(gateway: SaasDatabase, seeded: SeededAccount): Promise<number> {
  const result = await gateway.query<{ id: string }>(
    seeded.ownerKind === 'tenant'
      ? `SELECT account.id FROM model_router_saas.saas_tenant_provider_accounts AS account
          WHERE account.tenant_id = $1 AND account.id = $2
            AND account.status = 'active' AND account.validation_state = 'verified'`
      : `SELECT account.id FROM model_router_saas.saas_platform_provider_accounts AS account
          WHERE account.id = $1
            AND account.status = 'active' AND account.validation_state = 'verified'`,
    seeded.ownerKind === 'tenant' ? [seeded.tenantId, seeded.accountId] : [seeded.accountId],
  );
  return result.rows.length;
}

async function expectSqlState(work: () => Promise<unknown>, sqlState: string, label: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    const codes = safeCodes(error);
    assert.equal(codes.sqlState, sqlState, `${label} must fail with SQLSTATE ${sqlState}`);
    return;
  }
  assert.fail(`${label} must be rejected with SQLSTATE ${sqlState}`);
}

test('R5 credential quarantine runs end-to-end under the restricted worker role with real unsealing', {
  timeout: 120_000,
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1, all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs, ${WORKER_URL_ENV} and ${KMS_KEY_ENV} to require R5-097`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const worker = observedDatabase(workerUrl());
  const env = softwareKmsEnv();
  const sealingKms = createProviderCredentialSealingKms({ env });
  const unsealingKms: ProviderCredentialUnsealingKms = createCredentialValidationWorkerUnsealingKms({ env });

  const audits: ProviderAccountQuarantineAuditEvent[] = [];
  let probeStatus = 401;
  const seenAuthorization: string[] = [];
  const probeFetch: ProviderCredentialValidationFetch = async (url, init) => {
    assert.equal(url.href, 'https://api.moonshot.cn/v1/models');
    assert.equal(init.method ?? 'GET', 'GET');
    const headers = init.headers as Record<string, string>;
    seenAuthorization.push(String(headers?.authorization ?? ''));
    return new Response(null, { status: probeStatus });
  };
  const validationWorker = new CredentialValidationWorker(worker.database, unsealingKms, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    fetch: probeFetch,
    quarantineRevalidationSeconds: QUARANTINE_SECONDS,
    onAccountQuarantined: (event) => {
      audits.push(event);
    },
  });
  const sweepStore = new PostgresCredentialValidationWorkerStore(worker.database, unsealingKms, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    quarantineRevalidationSeconds: QUARANTINE_SECONDS,
  });

  t.after(async () => {
    await validationWorker.close();
    await Promise.allSettled([migrator.database.close(), control.database.close(), gateway.database.close()]);
    await worker.database.close();
  });

  await t.test('runtime probes cover control-plane, gateway and worker quarantine grants', async () => {
    await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifyCredentialValidationWorkerRuntimePrivileges(worker.database);
  });

  const tenantA = await seedAccount(migrator.database, sealingKms, 'tenant', {
    revalidationIntervalSeconds: null,
    jobTerminal: false,
  });
  const tenantB = await seedAccount(migrator.database, sealingKms, 'tenant', {
    revalidationIntervalSeconds: 900,
    jobTerminal: true,
  });

  await t.test('three consecutive terminal failures quarantine the account with one audit', async () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      assert.equal(await validationWorker.runOnce(), 'processed', `cycle ${cycle}`);
      const job = await readJob(migrator.database, tenantA);
      assert.equal(job.status, 'failed');
      assert.equal(job.attempt_count, 1, 'a 401 is terminal on the first attempt');
      const account = await readAccount(migrator.database, tenantA);
      if (cycle < 3) {
        assert.equal(account.validation_state, 'failed');
        assert.equal(account.validation_error_code, 'credential_rejected');
        assert.equal(account.quarantine_entered_at, null);
        assert.equal(account.quarantine_reason_code, null);
        assert.equal(audits.length, 0, `cycle ${cycle} must stay below the entry threshold`);
        await requeueJob(migrator.database, tenantA);
      } else {
        assert.equal(account.status, 'pending', 'quarantine keeps the parked pending status');
        assert.equal(account.validation_state, 'quarantined');
        assert.equal(account.validation_error_code, null, 'the error code migrated into the quarantine reason');
        assert.equal(account.quarantine_reason_code, 'credential_rejected');
        assert.ok(account.quarantine_entered_at instanceof Date, 'DB-clock entry timestamp persisted');
        assert.equal(audits.length, 1, 'exactly one entry audit');
        const event = audits[0];
        assert.equal(event?.action, PROVIDER_ACCOUNT_QUARANTINE_AUDIT_ACTION);
        assert.equal(event?.ownerKind, 'tenant');
        assert.equal(event?.tenantId, tenantA.tenantId);
        assert.equal(event?.accountId, tenantA.accountId);
        assert.equal(event?.reasonCode, 'credential_rejected');
        assert.ok(!Number.isNaN(Date.parse(event?.enteredAt ?? '')));
      }
    }
    // Every probe presented the unsealed secret to the fixed adapter endpoint.
    assert.ok(seenAuthorization.length >= 3);
    assert.ok(seenAuthorization.every((header) => header === `Bearer ${SECRET}`));
  });

  await t.test('the scheduler eligibility predicate keeps excluding the quarantined account', async () => {
    assert.equal(await eligibleAccountCount(gateway.database, tenantA), 0);
    assert.equal(await eligibleAccountCount(gateway.database, tenantB), 1, 'verified active control stays eligible');
  });

  await t.test('the D3 sweep requeues quarantine only on the independent cadence option', async () => {
    // Fresh completions: neither the quarantine cadence nor B's interval is due.
    assert.equal(await sweepStore.requeueDueRevalidations(10), 0);
    // A quarantined (cadence option 900s, own interval NULL) is due at 960s;
    // B (own interval 900s, not quarantined) is not due at 600s.
    await backdateJobCompletion(migrator.database, tenantA, 960);
    await backdateJobCompletion(migrator.database, tenantB, 600);
    assert.equal(await sweepStore.requeueDueRevalidations(10), 1);
    const jobA = await readJob(migrator.database, tenantA);
    assert.equal(jobA.status, 'queued');
    assert.equal(jobA.attempt_count, 0);
    assert.equal(jobA.completed_at, null);
    const jobB = await readJob(migrator.database, tenantB);
    assert.equal(jobB.status, 'verified', 'the verified/failed path keeps its own interval semantics');
  });

  await t.test('a successful quarantine probe returns the account to verified and clears the facts', async () => {
    probeStatus = 200;
    assert.equal(await validationWorker.runOnce(), 'processed');
    const account = await readAccount(migrator.database, tenantA);
    assert.equal(account.status, 'active');
    assert.equal(account.validation_state, 'verified');
    assert.equal(account.validation_error_code, null);
    assert.equal(account.quarantine_entered_at, null, 'exit clears the entry facts in the same statement');
    assert.equal(account.quarantine_reason_code, null);
    assert.equal(audits.length, 1, 'exit is not a quarantine-entry audit');
    assert.equal(await eligibleAccountCount(gateway.database, tenantA), 1, 'recovered account is eligible again');
  });

  await t.test('the consecutive-failure count restarted after the successful probe', async () => {
    probeStatus = 401;
    await requeueJob(migrator.database, tenantA);
    assert.equal(await validationWorker.runOnce(), 'processed');
    const account = await readAccount(migrator.database, tenantA);
    assert.equal(account.validation_state, 'failed');
    assert.equal(account.quarantine_entered_at, null);
    assert.equal(audits.length, 1, 'one fresh failure stays below the threshold');
  });

  await t.test('the control account requeues on its own 084 interval once due', async () => {
    await backdateJobCompletion(migrator.database, tenantB, 960);
    assert.equal(await sweepStore.requeueDueRevalidations(10), 1);
    const jobB = await readJob(migrator.database, tenantB);
    assert.equal(jobB.status, 'queued');
    // Drain B so the platform chain below owns the queue; the probe succeeds.
    probeStatus = 200;
    assert.equal(await validationWorker.runOnce(), 'processed');
    const accountB = await readAccount(migrator.database, tenantB);
    assert.equal(accountB.validation_state, 'verified');
    probeStatus = 401;
  });

  await t.test('the 097 tenant guard rejects every illegal quarantine transition (55006)', async () => {
    const table = 'model_router_saas.saas_tenant_provider_accounts';
    const identity = [tenantA.tenantId, tenantA.accountId] as const;
    // B is verified: direct entry is forbidden — quarantine starts from failed only.
    await expectSqlState(
      () =>
        migrator.database.query(
          `UPDATE ${table} SET validation_state = 'quarantined',
                  quarantine_entered_at = clock_timestamp(), quarantine_reason_code = 'manual_gate'
            WHERE tenant_id = $1 AND id = $2`,
          [tenantB.tenantId, tenantB.accountId],
        ),
      '55006',
      'verified -> quarantined',
    );
    // A is failed: the pinned entry shape (clear error, stamp facts) is admitted.
    await migrator.database.query(
      `UPDATE ${table} SET validation_state = 'quarantined', validation_error_code = NULL,
              quarantine_entered_at = clock_timestamp(), quarantine_reason_code = 'manual_gate'
        WHERE tenant_id = $1 AND id = $2`,
      identity,
    );
    await expectSqlState(
      () =>
        migrator.database.query(
          `UPDATE ${table} SET validation_state = 'failed', validation_error_code = 'backslide'
            WHERE tenant_id = $1 AND id = $2`,
          identity,
        ),
      '55006',
      'quarantined -> failed',
    );
    await expectSqlState(
      () =>
        migrator.database.query(
          `UPDATE ${table} SET quarantine_entered_at = clock_timestamp() - interval '1 hour'
            WHERE tenant_id = $1 AND id = $2`,
          identity,
        ),
      '55006',
      'quarantine fact tamper',
    );
    await expectSqlState(
      () =>
        migrator.database.query(
          `UPDATE ${table} SET validation_state = 'verified' WHERE tenant_id = $1 AND id = $2`,
          identity,
        ),
      '55006',
      'exit without clearing facts',
    );
    // Positive control: exit towards verified with facts cleared is admitted.
    await migrator.database.query(
      `UPDATE ${table} SET validation_state = 'verified', validation_error_code = NULL,
              quarantine_entered_at = NULL, quarantine_reason_code = NULL
        WHERE tenant_id = $1 AND id = $2`,
      identity,
    );
  });

  const platformP = await seedAccount(migrator.database, sealingKms, 'platform', {
    revalidationIntervalSeconds: null,
    jobTerminal: false,
  });

  await t.test('the platform owner scope quarantines through the same worker chain', async () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      assert.equal(await validationWorker.runOnce(), 'processed', `platform cycle ${cycle}`);
      if (cycle < 3) {
        const account = await readAccount(migrator.database, platformP);
        assert.equal(account.validation_state, 'failed');
        await requeueJob(migrator.database, platformP);
      }
    }
    const account = await readAccount(migrator.database, platformP);
    assert.equal(account.validation_state, 'quarantined');
    assert.equal(account.validation_error_code, null);
    assert.equal(account.quarantine_reason_code, 'credential_rejected');
    assert.ok(account.quarantine_entered_at instanceof Date);
    assert.equal(audits.length, 2);
    const event = audits[1];
    assert.equal(event?.ownerKind, 'platform');
    assert.equal(event?.tenantId, null);
    assert.equal(event?.accountId, platformP.accountId);
    assert.equal(await eligibleAccountCount(gateway.database, platformP), 0);
  });

  await t.test('the 097 platform guard rejects every illegal quarantine transition (55006)', async () => {
    const table = 'model_router_saas.saas_platform_provider_accounts';
    const identity = [platformP.accountId] as const;
    // P is quarantined (worker-entered): exit/fact negatives on the real row.
    await expectSqlState(
      () =>
        migrator.database.query(
          `UPDATE ${table} SET validation_state = 'failed', validation_error_code = 'backslide' WHERE id = $1`,
          identity,
        ),
      '55006',
      'platform quarantined -> failed',
    );
    await expectSqlState(
      () => migrator.database.query(`UPDATE ${table} SET quarantine_reason_code = 'rewritten' WHERE id = $1`, identity),
      '55006',
      'platform quarantine fact tamper',
    );
    await expectSqlState(
      () => migrator.database.query(`UPDATE ${table} SET validation_state = 'verified' WHERE id = $1`, identity),
      '55006',
      'platform exit without clearing facts',
    );
    // A verified platform account cannot enter quarantine directly.
    const platformVerified = await seedAccount(migrator.database, sealingKms, 'platform', {
      revalidationIntervalSeconds: null,
      jobTerminal: true,
    });
    await expectSqlState(
      () =>
        migrator.database.query(
          `UPDATE ${table} SET validation_state = 'quarantined',
                  quarantine_entered_at = clock_timestamp(), quarantine_reason_code = 'manual_gate'
            WHERE id = $1`,
          [platformVerified.accountId],
        ),
      '55006',
      'platform verified -> quarantined',
    );
    // Positive control: exit towards verified with facts cleared is admitted.
    await migrator.database.query(
      `UPDATE ${table} SET validation_state = 'verified', validation_error_code = NULL,
              quarantine_entered_at = NULL, quarantine_reason_code = NULL
        WHERE id = $1`,
      identity,
    );
  });
});
