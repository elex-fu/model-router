import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../../../src/saas/db/credential-validation-worker-privileges.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../../../src/saas/db/credential-validation-worker-schema-readiness.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { compileApprovedCredentialValidationTargets } from '../../../src/saas/supply/credential-validation-targets.js';
import { CredentialValidationWorker } from '../../../src/saas/supply/credential-validation-worker.js';
import type { ApprovedCredentialValidationTarget } from '../../../src/saas/supply/types.js';
import { approvedTarget, probeEnvelope, validationHttpsFixture } from './credential-validation-test-fixture.js';

// Same required gate as the tenant worker E2E: current migrations (including
// 083) and the exact worker-role template with the platform grants must
// already be installed. This test never creates a role or expands a grant.
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
    assert.ok(value, `${name} is required for the platform credential-validation real-PG gate`);
    const parsed = new URL(value);
    assert.equal(decodeURIComponent(parsed.username), role, `${name} must use the designated workload identity`);
    return value;
  });
  for (const value of urls) {
    const parsed = new URL(value);
    const identity = `${parsed.hostname}:${parsed.port}/${decodeURIComponent(parsed.pathname.slice(1))}`;
    target ??= identity;
    assert.equal(identity, target, 'migrator and worker must address the same disposable database');
  }
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
    const key = Buffer.alloc(32, 0x4b);
    const wrapped = Buffer.from(randomUUID());
    this.keys.set(wrapped.toString('base64url'), {
      key: Buffer.from(key),
      context: this.context(request.encryptionContext),
      kmsKeyId: request.kmsKeyId,
    });
    return { plaintextKey: key, ciphertextBlob: wrapped };
  }
  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]) {
    this.decryptCalls += 1;
    const entry = this.keys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    assert.ok(entry, 'only a fixture-sealed envelope may be unsealed');
    assert.equal(
      this.context(request.encryptionContext),
      entry.context,
      'KMS owner/purpose/deployment context must match exactly',
    );
    assert.equal(request.kmsKeyId, entry.kmsKeyId);
    return Buffer.from(entry.key);
  }
}

interface Fixture {
  accountId: string;
  credentialId: string;
  jobId: string;
}

async function seedPlatform(
  migrator: SaasDatabase,
  kms: FixtureKms,
  target: ApprovedCredentialValidationTarget,
): Promise<Fixture> {
  const accountId = `platform-account-${randomUUID()}`;
  const credentialId = `platform-credential-${randomUUID()}`;
  const rightsId = `platform-rights-${randomUUID()}`;
  // The platform KMS context omits the tenant dimension entirely.
  const envelope = await sealProviderCredential(
    Buffer.from('platform-fixture-api-key'),
    createProviderCredentialContext({
      ownerKind: 'platform',
      supplyMode: 'platform',
      deployment: 'validation-e2e',
      environment: 'test',
      purpose: 'inference',
      providerId: target.providerId,
      productId: target.productId,
      credentialType: 'api-key',
      accountId,
      credentialId,
      credentialVersion: 1,
    }),
    kms,
    'kms/validation-fixture',
  );
  return migrator.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO saas_provider_products (provider_id, product_id, display_name)
      VALUES ($1, $2, 'Operator-approved platform fixture product') ON CONFLICT (provider_id, product_id) DO NOTHING`,
      [target.providerId, target.productId],
    );
    await tx.query(
      `INSERT INTO saas_provider_capabilities
      (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
       evidence_version, discovery_source, evidence_ref, evidence_sha256)
      VALUES ($1, $2, $3, $4, $5, 1, 'supported', 'verified', 'validation-target-v1', 'manual', $6, $7)`,
      [
        target.providerId,
        target.productId,
        target.model,
        target.endpoint,
        target.protocol,
        target.approvalReference,
        target.evidenceSha256,
      ],
    );
    await tx.query(
      `INSERT INTO saas_provider_rights
      (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
       model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
      VALUES ($1, 1, $2, $3, 'api-key', 'platform', 'test-region', 'inference', ARRAY[$4]::text[], ARRAY[$5]::text[],
       clock_timestamp() - interval '1 minute', 'fixture-rights-approved', 'active', 'fixture-rights-evidence', $6)`,
      [rightsId, target.providerId, target.productId, target.model, target.endpoint, 'b'.repeat(64)],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_accounts
      (id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version)
      VALUES ($1, 'Platform validation fixture', $2, $3, 'api-key', 'test-region', 'inference', $4, 1)`,
      [accountId, target.providerId, target.productId, rightsId],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_account_capabilities
      (account_id, provider_id, product_id, model, endpoint, capability_version)
      VALUES ($1, $2, $3, $4, $5, 1)`,
      [accountId, target.providerId, target.productId, target.model, target.endpoint],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_credentials
      (id, account_id, provider_id, product_id, credential_type)
      VALUES ($1, $2, $3, $4, 'api-key')`,
      [credentialId, accountId, target.providerId, target.productId],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_credential_versions
      (account_id, credential_id, version, schema_version, context_version, algorithm, kms_purpose,
       kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag)
      VALUES ($1, $2, 1, $3, $4, $5, 'inference', $6, $7, $8, $9, $10)`,
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
    await tx.query(`UPDATE saas_platform_provider_credentials SET current_version = 1 WHERE id = $1`, [credentialId]);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO saas_platform_provider_credential_validation_jobs
      (account_id, credential_id, credential_version, provider_id, product_id, credential_type,
       allowed_models, target_model, target_endpoint, capability_version, idempotency_key)
      VALUES ($1, $2, 1, $3, $4, 'api-key', ARRAY[$5]::text[], $5, $6, 1, $7) RETURNING id`,
      [
        accountId,
        credentialId,
        target.providerId,
        target.productId,
        target.model,
        target.endpoint,
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
    const jobId = inserted.rows[0]?.id;
    assert.ok(jobId);
    return { accountId, credentialId, jobId };
  });
}

async function platformHealth(worker: SaasDatabase, fixture: Fixture) {
  // Every column is in the real worker SELECT manifest for the platform family.
  const rows = await worker.query<{
    status: string;
    last_error_code: string | null;
    attempt_count: number;
    credential_state: string;
    credential_status: string;
    account_state: string;
    account_status: string;
  }>(
    `SELECT job.status, job.last_error_code, job.attempt_count,
       credential.validation_state AS credential_state, credential.status AS credential_status,
       account.validation_state AS account_state, account.status AS account_status
     FROM saas_platform_provider_credential_validation_jobs AS job
     JOIN saas_platform_provider_credentials AS credential ON credential.id = job.credential_id
     JOIN saas_platform_provider_accounts AS account ON account.id = job.account_id
     WHERE job.id = $1::uuid`,
    [fixture.jobId],
  );
  assert.equal(rows.rows.length, 1);
  return rows.rows[0]!;
}

test('required real PostgreSQL restricted worker claims and settles platform-queue validation jobs', {
  timeout: 120_000,
  skip:
    process.env[REQUIRED] !== '1' && !values.some(Boolean)
      ? `set ${REQUIRED}=1 and both validation E2E role URLs for the required real-PG gate`
      : false,
}, async (t) => {
  const [migratorUrl, workerUrl] = disposableRoleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl });
  const database = createSaasDatabase({ connectionString: workerUrl });
  const workers: CredentialValidationWorker[] = [];
  t.after(async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await database.close();
    await migrator.close();
  });
  await migrator.verifySchema();
  // Both owner endpoint checks verify against the real catalog; the privilege
  // probe now includes every platform grant from the worker role template.
  await verifyCredentialValidationWorkerSchemaReadiness(database, 'legacy-v1', 'tenant');
  await verifyCredentialValidationWorkerSchemaReadiness(database, 'legacy-v1', 'platform');
  await verifyCredentialValidationWorkerRuntimePrivileges(database);
  const pending = await migrator.query<{ count: string }>(
    `SELECT count(*)::text FROM saas_platform_provider_credential_validation_jobs WHERE status IN ('queued', 'leased')`,
  );
  assert.equal(pending.rows[0]?.count, '0', 'use a fresh dedicated database/empty platform queue');

  let probeStatus = 200;
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    requests += 1;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body);
      response.writeHead(probeStatus, { 'content-type': 'application/json' });
      response.end(
        probeStatus === 200
          ? JSON.stringify(probeEnvelope('chat', payload.model))
          : JSON.stringify({ error: { message: 'rejected' } }),
      );
    });
  });
  const kms = new FixtureKms();
  const makeWorker = (targets: readonly ApprovedCredentialValidationTarget[]) => {
    const worker = new CredentialValidationWorker(database, kms, {
      deployment: 'validation-e2e',
      environment: 'test',
      approvedTargets: compileApprovedCredentialValidationTargets(targets),
      transportTestOptions: local.testOptions,
      fetch: async () => {
        throw new Error('custom unrestricted fetch is forbidden');
      },
    });
    workers.push(worker);
    return worker;
  };

  await t.test(
    'platform job is claimed after the empty tenant queue, verified and publishes platform health',
    async () => {
      probeStatus = 200;
      const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` });
      const fixture = await seedPlatform(migrator, kms, target);
      const beforeRequests = requests;
      assert.equal(await makeWorker([target]).runOnce(), 'processed');
      assert.equal(requests, beforeRequests + 1);
      assert.deepEqual(await platformHealth(database, fixture), {
        status: 'verified',
        last_error_code: null,
        attempt_count: 1,
        credential_state: 'verified',
        credential_status: 'active',
        account_state: 'verified',
        account_status: 'active',
      });
    },
  );

  await t.test('platform terminal failure parks account and credential at pending/failed health', async () => {
    probeStatus = 401;
    const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` });
    const fixture = await seedPlatform(migrator, kms, target);
    assert.equal(await makeWorker([target]).runOnce(), 'processed');
    assert.deepEqual(await platformHealth(database, fixture), {
      status: 'failed',
      last_error_code: 'credential_rejected',
      attempt_count: 1,
      // pending + non-verified is exactly what the scheduler eligibility SQL
      // excludes from platform dispatch — no extra linkage required.
      credential_state: 'failed',
      credential_status: 'pending',
      account_state: 'failed',
      account_status: 'pending',
    });
  });

  await t.test('the D3 sweep requeues a due interval-configured platform account and revalidates it', async () => {
    probeStatus = 200;
    const target = approvedTarget({ baseUrl: local.baseUrl, model: `organisation/${randomUUID()}` });
    const fixture = await seedPlatform(migrator, kms, target);
    // The 084 cadence column at its 15-minute floor, written by the owning
    // role exactly like the control-plane revalidation route would.
    await migrator.query(
      `UPDATE saas_platform_provider_accounts SET revalidation_interval_seconds = 900 WHERE id = $1`,
      [fixture.accountId],
    );
    assert.equal(await makeWorker([target]).runOnce(), 'processed');
    assert.equal((await platformHealth(database, fixture)).status, 'verified');

    // A fresh sweeper per cycle: the worker option gates sweeps per instance,
    // so separate instances exercise the due/not-due transitions directly.
    const makeSweeper = () => {
      const sweeper = new CredentialValidationWorker(database, kms, {
        deployment: 'validation-e2e',
        environment: 'test',
        approvedTargets: compileApprovedCredentialValidationTargets([target]),
        transportTestOptions: local.testOptions,
        owners: ['platform'],
        revalidationSweep: { intervalMs: 60_000, batchSize: 50 },
        fetch: async () => {
          throw new Error('custom unrestricted fetch is forbidden');
        },
      });
      workers.push(sweeper);
      return sweeper;
    };

    // Fresh completion is inside the cadence: the sweep leaves the job terminal.
    const beforeRequests = requests;
    assert.equal(await makeSweeper().runOnce(), 'idle');
    assert.equal(requests, beforeRequests);
    assert.equal((await platformHealth(database, fixture)).status, 'verified');

    // Age the completion beyond the cadence (test-only backdating by the
    // migrator; production due-ness comes from wall-clock time). The next
    // cycle sweeps the terminal row back to queued — as the restricted worker
    // role, touching only its 8 granted lease columns — and the same claim
    // revalidates it.
    await migrator.query(
      `UPDATE saas_platform_provider_credential_validation_jobs
          SET completed_at = clock_timestamp() - interval '16 minutes' WHERE id = $1::uuid`,
      [fixture.jobId],
    );
    assert.equal(await makeSweeper().runOnce(), 'processed');
    assert.equal(requests, beforeRequests + 1);
    assert.deepEqual(await platformHealth(database, fixture), {
      status: 'verified',
      last_error_code: null,
      attempt_count: 1,
      credential_state: 'verified',
      credential_status: 'active',
      account_state: 'verified',
      account_status: 'active',
    });
  });
});
