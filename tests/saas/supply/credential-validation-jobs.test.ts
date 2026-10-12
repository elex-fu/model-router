import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialSealingKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/035_credential_validation_jobs.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import type {
  CreateTenantByokCredentialInput,
  ProviderCredentialValidationJobInput,
} from '../../../src/saas/supply/types.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';

const NOW = new Date('2026-09-28T00:00:00.000Z');

class TestSealingKms implements ProviderCredentialSealingKms {
  async generateDataKey(_request: GenerateProviderCredentialDataKeyRequest) {
    return { plaintextKey: Buffer.alloc(32, 9), ciphertextBlob: Buffer.from('wrapped-test-key') };
  }
}

function createInput(): CreateTenantByokCredentialInput {
  return {
    context: {
      userId: 'user-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      tenantRole: 'owner',
      projectRole: 'owner',
    },
    account: {
      displayName: 'Customer key',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'region-a',
      purpose: 'inference',
      rightsId: 'rights-a',
      rightsVersion: 1,
      capability: { model: 'model-a', endpoint: 'chat-completions', version: 3 },
    },
    secret: Buffer.from('must-never-enter-job'),
    evidenceReference: 'evidence-a',
    evidenceSha256: 'a'.repeat(64),
    audit: { actorUserId: 'user-a', entryPoint: 'customer_byok', requestId: 'request-a' },
  };
}

function createService(repository: FakeProviderSupplyRepository): ProviderSupplyPersistenceService {
  return new ProviderSupplyPersistenceService(repository, {
    sealingKms: new TestSealingKms(),
    kmsKeyId: 'kms/test-key',
    deployment: 'managed-saas-test',
    environment: 'test',
    now: () => NOW,
    supplyProfileResolver: {
      async resolve(_context, mode) {
        return {
          entitlementId: 'entitlement-a',
          profileId: 'profile-a',
          mode,
          allowedModels: ['model-b', 'model-a'],
          entitlementAuthzVersion: 2,
          supplyProfileAuthzVersion: 4,
        };
      },
    },
  });
}

test('tenant BYOK creation atomically enqueues a typed, non-secret authority snapshot', async () => {
  const repository = new FakeProviderSupplyRepository();
  const created = await createService(repository).createTenantByokCredentialWithAudit(createInput());

  assert.equal(repository.validationJobs.length, 1);
  assert.equal(created.credential.status, 'pending');
  assert.equal(created.credential.validationState, 'unverified');
  assert.equal(created.version.version, 1);
  const [job] = repository.validationJobs;
  assert.ok(job);
  assert.deepEqual(
    {
      tenantId: job.tenantId,
      accountId: job.accountId,
      credentialId: job.credentialId,
      credentialVersion: job.credentialVersion,
      providerId: job.providerId,
      productId: job.productId,
      credentialType: job.credentialType,
      allowedModels: job.allowedModels,
      target: job.target,
      state: job.state,
      attemptCount: job.attemptCount,
      leaseGeneration: job.leaseGeneration,
    },
    {
      tenantId: 'tenant-a',
      accountId: created.account.id,
      credentialId: created.credential.id,
      credentialVersion: 1,
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      allowedModels: ['model-a', 'model-b'],
      target: { model: 'model-a', endpoint: 'chat-completions', version: 3 },
      state: 'queued',
      attemptCount: 0,
      leaseGeneration: 0,
    },
  );
  assert.doesNotMatch(JSON.stringify(job), /must-never-enter-job|ciphertext|wrapped|secret/i);
  assert.doesNotMatch(JSON.stringify(repository.validationJobs), /must-never-enter-job/);
});

test('job enqueue and credential writes roll back together on a later transaction failure', async () => {
  const repository = new FakeProviderSupplyRepository();
  repository.failAudit = true;

  await assert.rejects(createService(repository).createTenantByokCredentialWithAudit(createInput()));
  assert.deepEqual(repository.accounts, []);
  assert.deepEqual(repository.credentials, []);
  assert.deepEqual(repository.versions, []);
  assert.deepEqual(repository.validationJobs, []);
  assert.deepEqual(repository.byokProfileAccountBindings, []);
});

test('tenant BYOK secret rotation atomically enqueues the new version and fences the prior job', async () => {
  const repository = new FakeProviderSupplyRepository();
  const service = createService(repository);
  const created = await service.createTenantByokCredentialWithAudit(createInput());
  const previousJob = repository.validationJobs[0];
  assert.ok(previousJob);
  Object.assign(previousJob, {
    state: 'leased' as const,
    attemptCount: 1,
    leaseUntil: '2026-09-28T00:01:00.000Z',
    leaseGeneration: 7,
  });

  const rotated = await service.replaceProviderCredentialSecretWithAudit(
    {
      credential: {
        ownerKind: 'tenant',
        tenantId: created.credential.tenantId,
        accountId: created.credential.accountId,
        credentialId: created.credential.id,
      },
      expectedVersion: 1,
      secret: Buffer.from('rotated-secret-that-never-enters-the-job'),
    },
    { actorUserId: 'user-a', entryPoint: 'customer_byok' },
    createInput().context,
  );

  assert.equal(rotated.version.version, 2);
  assert.equal(repository.validationJobs.length, 2);
  assert.equal(repository.validationJobs[0]?.state, 'cancelled');
  assert.equal(repository.validationJobs[0]?.leaseUntil, null);
  assert.equal(repository.validationJobs[0]?.leaseGeneration, 8);
  assert.equal(repository.validationJobs[0]?.lastErrorCode, 'credential_changed');
  assert.equal(repository.validationJobs[1]?.credentialVersion, 2);
  assert.equal(repository.validationJobs[1]?.state, 'queued');
  assert.deepEqual(repository.validationJobs[1]?.target, {
    model: 'model-a',
    endpoint: 'chat-completions',
    version: 3,
  });
  assert.doesNotMatch(JSON.stringify(repository.validationJobs), /rotated-secret/);
});

test('failed rotation validation enqueue rolls back the new credential version and old-job cancellation', async () => {
  const repository = new FakeProviderSupplyRepository();
  const service = createService(repository);
  const created = await service.createTenantByokCredentialWithAudit(createInput());
  const previousJob = repository.validationJobs[0];
  assert.ok(previousJob);
  Object.assign(previousJob, { state: 'leased' as const, leaseGeneration: 4 });
  repository.failValidationEnqueue = true;

  await assert.rejects(
    service.replaceProviderCredentialSecretWithAudit(
      {
        credential: {
          ownerKind: 'tenant',
          tenantId: created.credential.tenantId,
          accountId: created.credential.accountId,
          credentialId: created.credential.id,
        },
        expectedVersion: 1,
        secret: Buffer.from('rotation-enqueue-failure-secret'),
      },
      { actorUserId: 'user-a', entryPoint: 'customer_byok' },
      createInput().context,
    ),
  );

  assert.equal(repository.credentials[0]?.currentVersion, 1);
  assert.equal(repository.versions.length, 1);
  assert.equal(repository.validationJobs.length, 1);
  assert.equal(previousJob.state, 'leased');
  assert.equal(previousJob.leaseGeneration, 4);
});

test('validation job idempotency returns one row and rejects a changed authority snapshot', async () => {
  const repository = new FakeProviderSupplyRepository();
  await createService(repository).createTenantByokCredentialWithAudit(createInput());
  const job = repository.validationJobs[0];
  assert.ok(job);

  const replay = await repository.enqueueProviderCredentialValidationJob(job);
  assert.equal(replay.id, job.id);
  assert.equal(repository.validationJobs.length, 1);

  const altered: ProviderCredentialValidationJobInput = {
    ...job,
    allowedModels: [...job.allowedModels, 'unauthorized-model'],
  };
  await assert.rejects(
    repository.enqueueProviderCredentialValidationJob(altered),
    /VALIDATION_JOB_IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(repository.validationJobs.length, 1);
});

test('migration 035 registers an immutable non-secret BYOK validation outbox', () => {
  const migration = CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION;
  assert.equal(migration.version, 35);
  assert.equal(migration.name, 'credential_validation_jobs');
  assert.equal(SAAS_MIGRATIONS.filter(({ version }) => version === 35).length, 1);

  const sql = migration.sql;
  assert.match(sql, /CREATE TABLE saas_tenant_provider_credential_validation_jobs/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, credential_id, credential_version\)/);
  assert.match(sql, /UNIQUE \(tenant_id, credential_id, credential_version\)/);
  assert.match(sql, /UNIQUE \(idempotency_key\)/);
  assert.match(sql, /allowed_models text\[\] NOT NULL/);
  assert.match(sql, /target_endpoint text NOT NULL/);
  assert.match(sql, /available_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/);
  assert.match(sql, /lease_generation bigint NOT NULL DEFAULT 0/);
  assert.match(sql, /lease_until IS NOT NULL/);
  assert.match(sql, /saas_invalidate_credential_validation_jobs/);
  assert.match(sql, /saas_invalidate_account_credential_validation_jobs/);
  assert.doesNotMatch(sql, /ciphertext|wrapped_dek|secret_value|request_body|authorization_header/i);
});

function platformValidationIdempotency(
  accountId: string,
  credentialId: string,
  version: number,
  providerId = 'provider-a',
  productId = 'product-a',
): string {
  return createHash('sha256')
    .update(
      [
        'provider-credential-validation-v1',
        'platform',
        accountId,
        credentialId,
        String(version),
        providerId,
        productId,
      ].join('\u0000'),
    )
    .digest('hex');
}

async function createPlatformAccount(
  service: ProviderSupplyPersistenceService,
  overrides: Record<string, unknown> = {},
) {
  return service.createProviderAccount({
    ownerKind: 'platform',
    id: 'platform-account-a',
    displayName: 'Platform pool account',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'region-a',
    purpose: 'inference',
    rightsId: 'rights-platform',
    rightsVersion: 1,
    capability: { model: 'model-a', endpoint: 'chat-completions', version: 3 },
    ...overrides,
  });
}

test('platform pool credential creation atomically enqueues its own owner-scoped proof-of-life job', async () => {
  const repository = new FakeProviderSupplyRepository();
  const service = createService(repository);
  const account = await createPlatformAccount(service);
  const created = await service.createProviderCredential({
    account: { ownerKind: 'platform', tenantId: null, accountId: account.id },
    id: 'platform-credential-a',
    secret: Buffer.from('platform-secret-never-in-job'),
  });

  assert.equal(repository.validationJobs.length, 1);
  const [job] = repository.validationJobs;
  assert.ok(job);
  assert.deepEqual(
    {
      ownerKind: job.ownerKind,
      tenantId: job.tenantId,
      accountId: job.accountId,
      credentialId: job.credentialId,
      credentialVersion: job.credentialVersion,
      providerId: job.providerId,
      productId: job.productId,
      credentialType: job.credentialType,
      allowedModels: job.allowedModels,
      target: job.target,
      state: job.state,
      attemptCount: job.attemptCount,
      leaseGeneration: job.leaseGeneration,
    },
    {
      ownerKind: 'platform',
      tenantId: null,
      accountId: account.id,
      credentialId: created.credential.id,
      credentialVersion: 1,
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      allowedModels: ['model-a'],
      target: { model: 'model-a', endpoint: 'chat-completions', version: 3 },
      state: 'queued',
      attemptCount: 0,
      leaseGeneration: 0,
    },
  );
  assert.equal(job.idempotencyKey, platformValidationIdempotency(account.id, created.credential.id, 1));
  assert.doesNotMatch(JSON.stringify(job), /platform-secret|ciphertext|wrapped/i);

  // Idempotent replay returns the same row; a changed snapshot is rejected.
  const replay = await repository.enqueueProviderCredentialValidationJob(job);
  assert.equal(replay.id, job.id);
  assert.equal(repository.validationJobs.length, 1);
  await assert.rejects(
    repository.enqueueProviderCredentialValidationJob({ ...job, allowedModels: ['model-a', 'smuggled-model'] }),
    /VALIDATION_JOB_IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(repository.validationJobs.length, 1);
});

test('platform secret rotation enqueues the new version and fences the prior platform job', async () => {
  const repository = new FakeProviderSupplyRepository();
  const service = createService(repository);
  const account = await createPlatformAccount(service);
  const created = await service.createProviderCredential({
    account: { ownerKind: 'platform', tenantId: null, accountId: account.id },
    id: 'platform-credential-a',
    secret: Buffer.from('platform-secret-v1'),
  });
  const previousJob = repository.validationJobs[0];
  assert.ok(previousJob);
  Object.assign(previousJob, {
    state: 'leased' as const,
    attemptCount: 1,
    leaseUntil: '2026-09-28T00:01:00.000Z',
    leaseGeneration: 5,
  });

  const rotated = await service.replaceProviderCredentialSecret({
    credential: {
      ownerKind: 'platform',
      tenantId: null,
      accountId: account.id,
      credentialId: created.credential.id,
    },
    expectedVersion: 1,
    secret: Buffer.from('platform-secret-v2'),
  });

  assert.equal(rotated.version.version, 2);
  assert.equal(repository.validationJobs.length, 2);
  assert.equal(repository.validationJobs[0]?.state, 'cancelled');
  assert.equal(repository.validationJobs[0]?.leaseUntil, null);
  assert.equal(repository.validationJobs[0]?.leaseGeneration, 6);
  assert.equal(repository.validationJobs[0]?.lastErrorCode, 'credential_changed');
  const nextJob = repository.validationJobs[1];
  assert.ok(nextJob);
  assert.equal(nextJob.ownerKind, 'platform');
  assert.equal(nextJob.tenantId, null);
  assert.equal(nextJob.credentialVersion, 2);
  assert.equal(nextJob.state, 'queued');
  assert.deepEqual(nextJob.target, { model: 'model-a', endpoint: 'chat-completions', version: 3 });
  assert.equal(nextJob.idempotencyKey, platformValidationIdempotency(account.id, created.credential.id, 2));
  assert.doesNotMatch(JSON.stringify(repository.validationJobs), /platform-secret-v2/);
});

test('repository enqueue rejects owner/tenant shape mismatches and partitions idempotency by owner', async () => {
  const repository = new FakeProviderSupplyRepository();
  const base = {
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: 1,
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    allowedModels: ['model-a'],
    target: { model: 'model-a', endpoint: 'chat-completions', version: 1 },
    idempotencyKey: 'a'.repeat(64),
  } as const;
  // A tenant job without tenant identity, or a platform job with one, is store
  // corruption — never a default either way.
  await assert.rejects(
    repository.enqueueProviderCredentialValidationJob({ ...base, ownerKind: 'tenant', tenantId: null }),
    /VALIDATION_JOB_WRITE_FAILED/,
  );
  await assert.rejects(
    repository.enqueueProviderCredentialValidationJob({ ...base, ownerKind: 'platform', tenantId: 'tenant-a' }),
    /VALIDATION_JOB_WRITE_FAILED/,
  );
  assert.equal(repository.validationJobs.length, 0);

  const tenantJob = await repository.enqueueProviderCredentialValidationJob({
    ...base,
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
  });
  const platformJob = await repository.enqueueProviderCredentialValidationJob({
    ...base,
    ownerKind: 'platform',
    tenantId: null,
  });
  assert.equal(repository.validationJobs.length, 2);
  assert.notEqual(tenantJob.id, platformJob.id);
});

test('job target endpoint normalization maps canonical paths to adapter tokens and replays safely', async () => {
  const { normalizeValidationJobEndpoint } = await import('../../../src/saas/supply/repository.js');
  assert.equal(normalizeValidationJobEndpoint('/v1/chat/completions'), 'chat-completions');
  assert.equal(normalizeValidationJobEndpoint('/v1/messages'), 'messages');
  assert.equal(normalizeValidationJobEndpoint('chat-completions'), 'chat-completions');
  assert.equal(normalizeValidationJobEndpoint('v1/chat/completions'), 'v1/chat/completions');
  assert.equal(normalizeValidationJobEndpoint('custom-endpoint'), 'custom-endpoint');
  assert.equal(normalizeValidationJobEndpoint('/custom'), 'custom');

  // The bug this pins: normalizing the insert without unifying the replay
  // comparison self-conflicted every enqueue (VALIDATION_JOB_IDEMPOTENCY_CONFLICT).
  const repository = new FakeProviderSupplyRepository();
  const service = createService(repository);
  const account = await createPlatformAccount(service);
  await service.createProviderCredential({
    account: { ownerKind: 'platform', tenantId: null, accountId: account.id },
    id: 'platform-credential-normalize-endpoint',
    secret: Buffer.from('secret-never-in-job', 'utf8'),
  });
  const job = repository.validationJobs[0];
  assert.ok(job);
  // Stored target uses the canonical token; replaying the same input returns
  // the same job instead of self-conflicting.
  const replay = await repository.enqueueProviderCredentialValidationJob(job);
  assert.equal(replay.id, job.id);
  assert.equal(repository.validationJobs.length, 1);
});
