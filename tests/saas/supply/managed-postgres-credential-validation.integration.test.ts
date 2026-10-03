import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import {
  createProviderCredentialContext,
  sealProviderCredential,
  type ProviderCredentialKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../../../src/saas/db/credential-validation-worker-privileges.js';
import {
  SaasCredentialValidationWorkerSchemaReadinessError,
  verifyCredentialValidationWorkerSchemaReadiness,
} from '../../../src/saas/db/credential-validation-worker-schema-readiness.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE } from '../../../src/saas/runtime/validation-worker-provider-credential-kms.js';
import { CredentialValidationWorker } from '../../../src/saas/supply/credential-validation-worker.js';
import { compileApprovedCredentialValidationTargets } from '../../../src/saas/supply/credential-validation-targets.js';
import type { ApprovedCredentialValidationTarget } from '../../../src/saas/supply/types.js';
import { startManagedSaasServer } from '../../../src/server/managed-saas.js';
import { approvedTarget, probeEnvelope, validationHttpsFixture, waitForValidationFixtureSignal } from './credential-validation-test-fixture.js';

// A separate required gate: current migrations and the exact worker-role template
// must already be installed. This test never creates a role or expands a grant.
const REQUIRED = 'MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED';
const config = [
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL', 'model_router_saas_validation_worker'],
] as const;
const values = config.map(([name]) => process.env[name]?.trim());

function disposableRoleUrls(): [string, string] {
  let target: string | undefined;
  const urls = config.map(([name, role], index) => {
    const value = values[index];
    assert.ok(value, `${name} is required for the credential-validation real-PG gate`);
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${name} must be a PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), `${name} must be PostgreSQL`);
    assert.equal(decodeURIComponent(parsed.username), role, `${name} must use the designated workload identity`);
    assert.equal(parsed.search, '', `${name} must not contain connection overrides`);
    assert.equal(parsed.hash, '', `${name} must not contain a fragment`);
    const hostname = parsed.hostname.toLowerCase();
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const port = Number(parsed.port);
    const ci = hostname === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(hostname) && !!parsed.port && Number.isInteger(port) &&
      port > 0 && port <= 65_535 && ![5432, 6432].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must identify an explicitly disposable CI or nondefault-port loopback test database`);
    const identity = `${hostname}:${port}/${database}`;
    target ??= identity;
    assert.equal(identity, target, 'migrator and worker must address the same disposable database');
    return value;
  });
  assert.ok(urls[0] && urls[1]);
  return [urls[0], urls[1]];
}

class FixtureKms implements ProviderCredentialKms {
  decryptCalls = 0;
  private readonly keys = new Map<string, { key: Buffer; context: string; kmsKeyId: string }>();
  private context(value: Readonly<Record<string, string>>) {
    return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  }
  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const key = Buffer.alloc(32, 0x35);
    const wrapped = Buffer.from(randomUUID());
    this.keys.set(wrapped.toString('base64url'), { key: Buffer.from(key), context: this.context(request.encryptionContext), kmsKeyId: request.kmsKeyId });
    return { plaintextKey: key, ciphertextBlob: wrapped };
  }
  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]) {
    this.decryptCalls += 1;
    const entry = this.keys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    assert.ok(entry, 'only a fixture-sealed envelope may be unsealed');
    assert.equal(this.context(request.encryptionContext), entry.context, 'KMS owner/purpose/deployment context must match exactly');
    assert.equal(request.kmsKeyId, entry.kmsKeyId);
    return Buffer.from(entry.key);
  }
}

interface Fixture { tenantId: string; accountId: string; credentialId: string; jobId: string; rightsId: string; target: ApprovedCredentialValidationTarget; }

async function seed(migrator: SaasDatabase, kms: FixtureKms, target: ApprovedCredentialValidationTarget, evidence = target.evidenceSha256): Promise<Fixture> {
  const tenantId = randomUUID();
  const accountId = `prov-account-${randomUUID()}`;
  const credentialId = `prov-credential-${randomUUID()}`;
  const rightsId = `prov-rights-${randomUUID()}`;
  const envelope = await sealProviderCredential(Buffer.from('fixture-provider-api-key'), createProviderCredentialContext({
    ownerKind: 'tenant', tenantId, supplyMode: 'byok', deployment: 'validation-e2e', environment: 'test',
    purpose: 'inference', providerId: target.providerId, productId: target.productId, credentialType: 'api-key',
    accountId, credentialId, credentialVersion: 1,
  }), kms, 'kms/validation-fixture');
  return migrator.transaction(async (tx) => {
    await tx.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1::uuid, 'PROV validation fixture', $2)`, [tenantId, `prov-${tenantId}`]);
    await tx.query(`INSERT INTO saas_provider_products (provider_id, product_id, display_name)
      VALUES ($1, $2, 'Operator-approved fixture product') ON CONFLICT (provider_id, product_id) DO NOTHING`, [target.providerId, target.productId]);
    // Catalog capability and commercial rights are setup evidence independently
    // of the probe. The worker is not permitted to insert or update either.
    await tx.query(`INSERT INTO saas_provider_capabilities
      (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
       evidence_version, discovery_source, evidence_ref, evidence_sha256)
      VALUES ($1, $2, $3, $4, $5, 1, 'supported', 'verified', 'validation-target-v1', 'manual', $6, $7)`,
    [target.providerId, target.productId, target.model, target.endpoint, target.protocol, target.approvalReference, evidence]);
    await tx.query(`INSERT INTO saas_provider_rights
      (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
       model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
      VALUES ($1, 1, $2, $3, 'api-key', 'byok', 'test-region', 'inference', ARRAY[$4]::text[], ARRAY[$5]::text[],
       clock_timestamp() - interval '1 minute', 'fixture-rights-approved', 'active', 'fixture-rights-evidence', $6)`,
    [rightsId, target.providerId, target.productId, target.model, target.endpoint, 'a'.repeat(64)]);
    await tx.query(`INSERT INTO saas_tenant_provider_accounts
      (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version)
      VALUES ($1::uuid, $2, 'Validation fixture', $3, $4, 'api-key', 'test-region', 'inference', $5, 1)`,
    [tenantId, accountId, target.providerId, target.productId, rightsId]);
    await tx.query(`INSERT INTO saas_tenant_provider_account_capabilities
      (tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, 1)`, [tenantId, accountId, target.providerId, target.productId, target.model, target.endpoint]);
    await tx.query(`INSERT INTO saas_tenant_provider_credentials
      (tenant_id, id, account_id, provider_id, product_id, credential_type)
      VALUES ($1::uuid, $2, $3, $4, $5, 'api-key')`, [tenantId, credentialId, accountId, target.providerId, target.productId]);
    await tx.query(`INSERT INTO saas_tenant_provider_credential_versions
      (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm, kms_purpose,
       kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag)
      VALUES ($1::uuid, $2, $3, 1, $4, $5, $6, 'inference', $7, $8, $9, $10, $11)`,
    [tenantId, accountId, credentialId, envelope.schemaVersion, envelope.contextVersion, envelope.algorithm,
      envelope.kmsKeyId, envelope.wrappedDek, envelope.nonce, envelope.ciphertext, envelope.authTag]);
    await tx.query(`UPDATE saas_tenant_provider_credentials SET current_version = 1 WHERE tenant_id = $1::uuid AND id = $2`, [tenantId, credentialId]);
    const inserted = await tx.query<{ id: string }>(`INSERT INTO saas_tenant_provider_credential_validation_jobs
      (tenant_id, account_id, credential_id, credential_version, provider_id, product_id, credential_type,
       allowed_models, target_model, target_endpoint, capability_version, idempotency_key)
      VALUES ($1::uuid, $2, $3, 1, $4, $5, 'api-key', ARRAY[$6]::text[], $6, $7, 1, $8) RETURNING id`,
    [tenantId, accountId, credentialId, target.providerId, target.productId, target.model, target.endpoint,
      createHash('sha256').update(randomUUID()).digest('hex')]);
    const jobId = inserted.rows[0]?.id;
    assert.ok(jobId);
    return { tenantId, accountId, credentialId, jobId, rightsId, target };
  });
}

async function revokeRights(migrator: SaasDatabase, fixture: Fixture): Promise<void> {
  await migrator.query(`INSERT INTO saas_provider_rights
    (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
     model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
    SELECT rights_id, version + 1, provider_id, product_id, credential_type, supply_mode, region, purpose,
      model_scope, endpoint_scope, clock_timestamp(), 'fixture-revocation', 'revoked', 'fixture-revocation', $2
    FROM saas_provider_rights WHERE rights_id = $1 AND version = 1`, [fixture.rightsId, 'f'.repeat(64)]);
}

async function health(worker: SaasDatabase, fixture: Fixture) {
  // Every column is in the real worker SELECT manifest; never count(*) on an
  // ungranted table or use the setup role to execute an application operation.
  const rows = await worker.query<{ status: string; last_error_code: string | null; attempt_count: number;
    credential_state: string; account_state: string }>(`SELECT job.status, job.last_error_code, job.attempt_count,
    credential.validation_state AS credential_state, account.validation_state AS account_state
    FROM saas_tenant_provider_credential_validation_jobs AS job
    JOIN saas_tenant_provider_credentials AS credential ON credential.tenant_id = job.tenant_id AND credential.id = job.credential_id
    JOIN saas_tenant_provider_accounts AS account ON account.tenant_id = job.tenant_id AND account.id = job.account_id
    WHERE job.id = $1::uuid`, [fixture.jobId]);
  assert.equal(rows.rows.length, 1);
  return rows.rows[0]!;
}

test('required real PostgreSQL restricted credential worker validates approved custom targets without granting catalog or rights authority', {
  timeout: 120_000,
  skip: process.env[REQUIRED] !== '1' && !values.some(Boolean)
    ? `set ${REQUIRED}=1 and both validation E2E role URLs for the required real-PG gate` : false,
}, async (t) => {
  const [migratorUrl, workerUrl] = disposableRoleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl });
  const database = createSaasDatabase({ connectionString: workerUrl });
  const workers: CredentialValidationWorker[] = [];
  t.after(async () => { await Promise.allSettled(workers.map((worker) => worker.close())); await database.close(); await migrator.close(); });
  await migrator.verifySchema();
  await assert.rejects(database.query('SELECT version FROM saas_schema_migrations LIMIT 1'),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
  await verifyCredentialValidationWorkerSchemaReadiness(database);
  assert.equal((await database.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user, 'model_router_saas_validation_worker');
  await verifyCredentialValidationWorkerRuntimePrivileges(database);
  const pending = await migrator.query<{ count: string }>(`SELECT count(*)::text FROM saas_tenant_provider_credential_validation_jobs WHERE status IN ('queued', 'leased')`);
  assert.equal(pending.rows[0]?.count, '0', 'use a fresh dedicated database/empty queue; never consume another fixture’s jobs');

  await t.test('real restricted metadata/startup readiness rejects broken relations, fields, indexes, guards and unvalidated constraints before KMS/network', async () => {
    const jobs = 'model_router_saas.saas_tenant_provider_credential_validation_jobs';
    const faults = [
      { check: 'tables_ready', breakSql: [`ALTER TABLE ${jobs} RENAME TO prov_worker_jobs_relation_negative`],
        restoreSql: ['ALTER TABLE model_router_saas.prov_worker_jobs_relation_negative RENAME TO saas_tenant_provider_credential_validation_jobs'] },
      { check: 'columns_ready', breakSql: ['ALTER TABLE model_router_saas.saas_provider_capabilities RENAME COLUMN evidence_sha256 TO prov_readiness_evidence_unavailable'],
        restoreSql: ['ALTER TABLE model_router_saas.saas_provider_capabilities RENAME COLUMN prov_readiness_evidence_unavailable TO evidence_sha256'] },
      { check: 'indexes_ready', breakSql: [`ALTER INDEX ${jobs}_claim_idx RENAME TO prov_worker_claim_index_negative`],
        restoreSql: [`ALTER INDEX model_router_saas.prov_worker_claim_index_negative RENAME TO saas_tenant_provider_credential_validation_jobs_claim_idx`] },
      { check: 'triggers_ready', breakSql: [`ALTER TABLE ${jobs} DISABLE TRIGGER saas_tenant_provider_credential_validation_jobs_identity_immutable`],
        restoreSql: [`ALTER TABLE ${jobs} ENABLE TRIGGER saas_tenant_provider_credential_validation_jobs_identity_immutable`] },
      { check: 'checks_ready', breakSql: [
        `ALTER TABLE ${jobs} DROP CONSTRAINT saas_tenant_provider_credential_validation_jobs_lease_shape`,
        `ALTER TABLE ${jobs} ADD CONSTRAINT saas_tenant_provider_credential_validation_jobs_lease_shape CHECK ((status = 'leased') = (lease_until IS NOT NULL)) NOT VALID`,
      ], restoreSql: [`ALTER TABLE ${jobs} VALIDATE CONSTRAINT saas_tenant_provider_credential_validation_jobs_lease_shape`] },
    ];
    for (const fault of faults) {
      let changed = false;
      try {
        await migrator.transaction(async (tx) => { for (const sql of fault.breakSql) await tx.query(sql); });
        changed = true;
        await assert.rejects(verifyCredentialValidationWorkerSchemaReadiness(database),
          (error: unknown) => error instanceof SaasCredentialValidationWorkerSchemaReadinessError &&
            error.failedChecks.some((check) => check === fault.check));
        let kmsLoads = 0;
        let workerStarts = 0;
        let listeners = 0;
        const acquired: { database?: SaasDatabase } = {};
        let closes = 0;
        try {
          // Same production worker branch, fresh real worker pool, unchanged
          // catalog SQL. No injected schema/history verifier or fake results.
          await assert.rejects(startManagedSaasServer({
            mode: 'managed-saas', workloadRole: 'credential-validation-worker', postgresUrl: workerUrl,
            validationWorkerProviderCredentialDecryptKmsModule: 'validation-readiness-test-kms-not-loaded',
            deploymentId: 'validation-e2e', environmentId: 'test', listeners: {},
          }, {
            environment: { NODE_ENV: 'production',
              [SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: 'validation-readiness-test-kms-not-loaded' },
            installSignalHandlers: false,
            createDatabase: ({ connectionString }) => {
              assert.equal(connectionString, workerUrl);
              const pool = createSaasDatabase({ connectionString, max: 1 });
              acquired.database = pool;
              return pool;
            },
            closeDatabase: async (pool) => { closes += 1; await pool.close(); },
            loadValidationWorkerKms: async () => { kmsLoads += 1; assert.fail('unready real schema must precede KMS loading'); },
            startCredentialValidationWorker: () => { workerStarts += 1; assert.fail('unready real schema must precede worker/network dispatch'); },
            createListener: () => { listeners += 1; assert.fail('worker must never create HTTP listeners'); },
          }), /^Error: Managed SaaS credential-validation worker schema readiness failed$/);
          assert.ok(acquired.database, 'real worker startup acquired its own restricted database pool');
          assert.equal(closes, 1, 'failed startup closed its real acquired pool');
          assert.deepEqual([kmsLoads, workerStarts, listeners], [0, 0, 0], 'readiness rejection must precede all secret/network capabilities');
        } finally {
          if (acquired.database && closes === 0) await acquired.database.close();
        }
      } finally {
        if (changed) await migrator.transaction(async (tx) => { for (const sql of fault.restoreSql) await tx.query(sql); });
      }
      await verifyCredentialValidationWorkerSchemaReadiness(database);
      await verifyCredentialValidationWorkerRuntimePrivileges(database);
    }
    await assert.rejects(database.query('SELECT version FROM saas_schema_migrations LIMIT 1'),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
  });

  let requests = 0;
  let holdResponse = false;
  let activeResponse: ServerResponse | undefined;
  let announce!: () => void;
  const local = await validationHttpsFixture(t, (request, response) => {
    requests += 1;
    let body = '';
    request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      const wire = JSON.stringify(probeEnvelope(request.url?.endsWith('/messages') ? 'messages' : 'chat', payload.model));
      if (holdResponse) { activeResponse = response; response.write(wire); announce(); }
      else response.end(wire);
    });
  });
  const kms = new FixtureKms();
  let legacyFetches = 0;
  const makeWorker = (targets: readonly ApprovedCredentialValidationTarget[]) => {
    const worker = new CredentialValidationWorker(database, kms, {
      deployment: 'validation-e2e', environment: 'test', approvedTargets: compileApprovedCredentialValidationTargets(targets),
      transportTestOptions: local.testOptions,
      fetch: async () => { legacyFetches += 1; throw new Error('custom unrestricted fetch is forbidden'); },
    });
    workers.push(worker);
    return worker;
  };

  await t.test('both profiles complete actual transactions with exact evidence and one bounded probe', async () => {
    for (const kind of ['chat', 'messages'] as const) {
      const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}`, ...(kind === 'messages' ? {
        productId: 'custom-anthropic', endpoint: 'messages', protocol: 'anthropic-compatible', authProfile: 'anthropic-api-key-2023-06-01',
      } as const : {}) });
      const fixture = await seed(migrator, kms, target);
      const worker = makeWorker([target]);
      const beforeRequests = requests;
      assert.equal(await worker.runOnce(), 'processed');
      assert.equal(requests, beforeRequests + 1);
      assert.deepEqual(await health(database, fixture), { status: 'verified', last_error_code: null, attempt_count: 1,
        credential_state: 'verified', account_state: 'verified' });
      const evidence = await database.query<{ evidence_sha256: string }>(`SELECT evidence_sha256 FROM saas_provider_capabilities
        WHERE provider_id = $1 AND product_id = $2 AND model = $3 AND endpoint = $4 AND version = 1`,
      [target.providerId, target.productId, target.model, target.endpoint]);
      assert.equal(evidence.rows[0]?.evidence_sha256, target.evidenceSha256);
      await assert.rejects(database.query(`SELECT evidence_ref FROM saas_provider_capabilities LIMIT 1`),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501');
    }
  });
  await t.test('missing registry remains unavailable without KMS or wire access', async () => {
    const fixture = await seed(migrator, kms, approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` }));
    const worker = makeWorker([]);
    const before = [kms.decryptCalls, requests];
    assert.equal(await worker.runOnce(), 'processed');
    assert.deepEqual([kms.decryptCalls, requests], before);
    assert.deepEqual(await health(database, fixture), { status: 'failed', last_error_code: 'adapter_unsupported', attempt_count: 1,
      credential_state: 'unverified', account_state: 'unverified' });
  });
  await t.test('digest mismatch cancels before KMS and cannot manufacture approval', async () => {
    const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` });
    const fixture = await seed(migrator, kms, target, 'd'.repeat(64));
    const before = [kms.decryptCalls, requests];
    assert.equal(await makeWorker([target]).runOnce(), 'stale');
    assert.deepEqual([kms.decryptCalls, requests], before);
    const result = await health(database, fixture);
    assert.equal(result.status, 'cancelled'); assert.equal(result.last_error_code, 'authority_changed');
    assert.equal(result.credential_state, 'unverified'); assert.equal(result.account_state, 'unverified');
  });
  await t.test('latest rights revocation prevents decrypt and leaves health unverified', async () => {
    const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` });
    const fixture = await seed(migrator, kms, target);
    await revokeRights(migrator, fixture);
    const before = [kms.decryptCalls, requests];
    assert.equal(await makeWorker([target]).runOnce(), 'stale');
    assert.deepEqual([kms.decryptCalls, requests], before);
    assert.equal((await health(database, fixture)).credential_state, 'unverified');
  });
  await t.test('rights changed during a valid JSON prefix prevent completion after real EOF', async (t) => {
    const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` });
    const fixture = await seed(migrator, kms, target);
    const worker = makeWorker([target]);
    holdResponse = true;
    t.after(async () => {
      holdResponse = false;
      activeResponse?.destroy();
      activeResponse = undefined;
      await worker.close();
    });
    const waiting = new Promise<void>((resolve) => { announce = resolve; });
    const run = worker.runOnce();
    await waitForValidationFixtureSignal(waiting, run);
    assert.equal((await health(database, fixture)).status, 'leased');
    await revokeRights(migrator, fixture);
    activeResponse?.end();
    assert.equal(await run, 'stale');
    const result = await health(database, fixture);
    assert.equal(result.status, 'cancelled'); assert.equal(result.credential_state, 'unverified');
    assert.equal(result.account_state, 'unverified');
  });
  assert.equal(legacyFetches, 0);
});
