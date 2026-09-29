import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  createProviderCredentialEncryptionContext,
  type GeneratedProviderCredentialDataKey,
  type GenerateProviderCredentialDataKeyRequest,
  type ProviderCredentialContext,
  type ProviderCredentialKms,
  type ProviderCredentialRewrappingKms,
  type ProviderCredentialUnsealingKms,
  type ReencryptedProviderCredentialDataKey,
  type ReencryptProviderCredentialDataKeyRequest,
  rewrapProviderCredentialEnvelope,
  sealProviderCredential,
  withUnsealedProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/index.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import type {
  AppendProviderCredentialWrapperRevisionInput,
  AppendProviderSupplyAuditEventInput,
  ProviderSupplyRepository,
} from '../../../src/saas/supply/repository.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import type {
  ProviderAccountRecord,
  ProviderCredentialRecord,
  ProviderCredentialReference,
  ProviderCredentialRewrapAuditContext,
  ProviderCredentialWrapperRevisionRecord,
  StoredProviderCredentialVersion,
} from '../../../src/saas/supply/types.js';

const deployment = 'rewrap-test-deployment';
const environment = 'test';

function buildContext(
  ownerKind: 'tenant' | 'platform' = 'tenant',
  changes: Partial<{
    tenantId: string;
    deployment: string;
    environment: string;
    purpose: string;
    providerId: string;
    productId: string;
    credentialType: string;
    accountId: string;
    credentialId: string;
    credentialVersion: number;
  }> = {},
): ProviderCredentialContext {
  const common = {
    deployment: changes.deployment ?? deployment,
    environment: changes.environment ?? environment,
    purpose: changes.purpose ?? 'provider-api',
    providerId: changes.providerId ?? 'provider-a',
    productId: changes.productId ?? 'product-a',
    credentialType: changes.credentialType ?? 'api-key',
    accountId: changes.accountId ?? 'account-a',
    credentialId: changes.credentialId ?? 'credential-a',
    credentialVersion: changes.credentialVersion ?? 1,
  };
  if (ownerKind === 'tenant') {
    return createProviderCredentialContext({
      ...common,
      ownerKind: 'tenant',
      tenantId: changes.tenantId ?? 'tenant-a',
      supplyMode: 'byok',
    });
  }
  return createProviderCredentialContext({ ...common, ownerKind: 'platform', supplyMode: 'platform' });
}

interface StoredFakeDataKey {
  readonly kmsKeyId: string;
  readonly plaintextKey: Buffer;
  readonly context: string;
}

class FakeRemoteKms implements ProviderCredentialKms, ProviderCredentialRewrappingKms {
  readonly dataKeys = new Map<string, StoredFakeDataKey>();
  reencryptRequests: ReencryptProviderCredentialDataKeyRequest[] = [];
  decryptCalls = 0;
  behavior: 'success' | 'failed' | 'unknown' = 'success';
  private serial = 0;

  async generateDataKey(
    request: GenerateProviderCredentialDataKeyRequest,
  ): Promise<GeneratedProviderCredentialDataKey> {
    this.serial += 1;
    const plaintextKey = Buffer.alloc(32, this.serial);
    const ciphertextBlob = Buffer.from(`wrapped-${request.kmsKeyId}-${this.serial}`, 'utf8');
    this.dataKeys.set(ciphertextBlob.toString('base64url'), {
      kmsKeyId: request.kmsKeyId,
      plaintextKey: Buffer.from(plaintextKey),
      context: JSON.stringify(request.encryptionContext),
    });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialUnsealingKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    this.decryptCalls += 1;
    const stored = this.dataKeys.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    if (
      !stored ||
      stored.kmsKeyId !== request.kmsKeyId ||
      stored.context !== JSON.stringify(request.encryptionContext)
    ) {
      throw new Error('fake KMS context rejected');
    }
    return Buffer.from(stored.plaintextKey);
  }

  async reencryptDataKey(
    request: ReencryptProviderCredentialDataKeyRequest,
  ): Promise<ReencryptedProviderCredentialDataKey> {
    this.reencryptRequests.push({
      ...request,
      ciphertextBlob: Buffer.from(request.ciphertextBlob),
      sourceEncryptionContext: { ...request.sourceEncryptionContext },
      destinationEncryptionContext: { ...request.destinationEncryptionContext },
    });
    if (this.behavior !== 'success')
      throw new Error(this.behavior === 'unknown' ? 'remote outcome unknown' : 'KMS denied');
    const wrapped = Buffer.from(request.ciphertextBlob).toString('base64url');
    const stored = this.dataKeys.get(wrapped);
    const context = JSON.stringify(request.sourceEncryptionContext);
    if (
      !stored ||
      stored.kmsKeyId !== request.sourceKmsKeyId ||
      stored.context !== context ||
      context !== JSON.stringify(request.destinationEncryptionContext)
    ) {
      throw new Error('fake KMS context rejected');
    }
    this.serial += 1;
    const ciphertextBlob = Buffer.from(`wrapped-${request.destinationKmsKeyId}-${this.serial}`, 'utf8');
    this.dataKeys.set(ciphertextBlob.toString('base64url'), {
      kmsKeyId: request.destinationKmsKeyId,
      plaintextKey: Buffer.from(stored.plaintextKey),
      context,
    });
    return {
      sourceKmsKeyId: request.sourceKmsKeyId,
      destinationKmsKeyId: request.destinationKmsKeyId,
      ciphertextBlob,
    };
  }
}

class MemoryWrapperRepository {
  readonly history: ProviderCredentialWrapperRevisionRecord[] = [];
  readonly auditEvents: AppendProviderSupplyAuditEventInput[] = [];
  readonly credential: ProviderCredentialRecord;
  readonly account: ProviderAccountRecord;
  readonly reference: ProviderCredentialReference;
  readonly baseVersion: StoredProviderCredentialVersion;
  readonly repository: ProviderSupplyRepository;
  private tail: Promise<void> = Promise.resolve();

  constructor(ownerKind: 'tenant' | 'platform', envelope: StoredProviderCredentialVersion['envelope']) {
    const tenantId = ownerKind === 'tenant' ? 'tenant-a' : null;
    const owner =
      ownerKind === 'tenant'
        ? { ownerKind: 'tenant' as const, tenantId: 'tenant-a', supplyMode: 'byok' as const }
        : { ownerKind: 'platform' as const, tenantId: null, supplyMode: 'platform' as const };
    this.reference = { ownerKind, tenantId, accountId: 'account-a', credentialId: 'credential-a' };
    this.account = {
      ...owner,
      id: 'account-a',
      displayName: 'fake provider account',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      region: 'test-region',
      purpose: 'provider-api',
      rightsId: 'rights-a',
      rightsVersion: 1,
      status: 'active',
      validationState: 'verified',
      validationErrorCode: null,
      lastValidatedAt: null,
      authzVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
      revokedAt: null,
    } as ProviderAccountRecord;
    this.credential = {
      ...owner,
      id: 'credential-a',
      accountId: 'account-a',
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      status: 'active',
      validationState: 'verified',
      validationErrorCode: null,
      lastValidatedAt: null,
      currentVersion: 1,
      expiresAt: null,
      authzVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      disabledAt: null,
      revokedAt: null,
    } as ProviderCredentialRecord;
    this.baseVersion = {
      ownerKind,
      tenantId,
      accountId: 'account-a',
      credentialId: 'credential-a',
      version: 1,
      status: 'active',
      envelopeSchemaVersion: envelope.schemaVersion,
      contextVersion: envelope.contextVersion,
      algorithm: envelope.algorithm,
      kmsPurpose: 'provider-api',
      wrappingRevision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      retiredAt: null,
      revokedAt: null,
      kmsKeyId: envelope.kmsKeyId,
      envelope,
    };

    this.repository = this as unknown as ProviderSupplyRepository;
  }

  async getCredential(): Promise<ProviderCredentialRecord> {
    return this.credential;
  }

  async getAccount(): Promise<ProviderAccountRecord> {
    return this.account;
  }

  async getCredentialVersionEnvelope(): Promise<StoredProviderCredentialVersion> {
    const latest = this.history.at(-1);
    if (!latest) return this.baseVersion;
    return {
      ...this.baseVersion,
      kmsKeyId: latest.kmsKeyId,
      wrappingRevision: latest.wrappingRevision,
      envelope: {
        ...this.baseVersion.envelope,
        kmsKeyId: latest.kmsKeyId,
        wrappedDek: this.wrappedDekFor(latest.operationId),
      },
    };
  }

  private wrappedDekFor(operationId: string): string {
    const result = this.wrapperResults.get(operationId);
    if (!result) throw new Error('fake wrapper result missing');
    return result;
  }

  private readonly wrapperResults = new Map<string, string>();

  async getCredentialWrapperRevisionByOperation(
    _reference: ProviderCredentialReference & { readonly version: number },
    operationId: string,
  ): Promise<ProviderCredentialWrapperRevisionRecord | null> {
    return this.history.find((item) => item.operationId === operationId) ?? null;
  }

  async appendCredentialWrapperRevision(
    input: AppendProviderCredentialWrapperRevisionInput,
  ): Promise<{ readonly revision: ProviderCredentialWrapperRevisionRecord; readonly inserted: boolean }> {
    const existing = await this.getCredentialWrapperRevisionByOperation(input.credential, input.operationId);
    if (existing) {
      if (
        existing.expectedWrappingRevision !== input.expectedWrappingRevision ||
        existing.sourceKmsKeyId !== input.sourceKmsKeyId ||
        existing.kmsKeyId !== input.kmsKeyId ||
        existing.contextSha256 !== input.contextSha256 ||
        existing.reasonCode !== input.reasonCode
      ) {
        throw new ProviderSupplyError('CREDENTIAL_VERSION_CONFLICT');
      }
      return { revision: existing, inserted: false };
    }
    const current = await this.getCredentialVersionEnvelope();
    if (current.wrappingRevision !== input.expectedWrappingRevision || current.kmsKeyId !== input.sourceKmsKeyId) {
      throw new ProviderSupplyError('CREDENTIAL_VERSION_CONFLICT');
    }
    const audit = input.audit;
    const revision: ProviderCredentialWrapperRevisionRecord = {
      ownerKind: input.credential.ownerKind,
      tenantId: input.credential.tenantId,
      accountId: input.credential.accountId,
      credentialId: input.credential.credentialId,
      credentialVersion: input.credential.version,
      expectedWrappingRevision: input.expectedWrappingRevision,
      wrappingRevision: input.expectedWrappingRevision + 1,
      operationId: input.operationId,
      sourceKmsKeyId: input.sourceKmsKeyId,
      kmsKeyId: input.kmsKeyId,
      contextSha256: input.contextSha256,
      actorKind: audit.actorKind,
      actorUserId: audit.actorKind === 'user' ? audit.actorUserId : null,
      actorWorkloadId: audit.actorKind === 'workload' ? audit.actorWorkloadId : null,
      requestId: audit.requestId,
      reasonCode: input.reasonCode,
      createdAt: input.createdAt,
    };
    this.wrapperResults.set(input.operationId, input.wrappedDek);
    this.history.push(revision);
    return { revision, inserted: true };
  }

  async appendAuditEvent(input: AppendProviderSupplyAuditEventInput): Promise<void> {
    this.auditEvents.push(input);
  }

  async transaction<T>(work: (repository: ProviderSupplyRepository, executor?: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const historyLength = this.history.length;
    const auditLength = this.auditEvents.length;
    const wrappedBefore = new Map(this.wrapperResults);
    try {
      return await work(this.repository);
    } catch (error) {
      this.history.length = historyLength;
      this.auditEvents.length = auditLength;
      this.wrapperResults.clear();
      for (const [key, value] of wrappedBefore) this.wrapperResults.set(key, value);
      throw error;
    } finally {
      release();
    }
  }
}

interface RewrapFixture {
  readonly context: ProviderCredentialContext;
  readonly kms: FakeRemoteKms;
  readonly repository: MemoryWrapperRepository;
  readonly service: ProviderSupplyService;
  readonly original: StoredProviderCredentialVersion;
}

async function createFixture(ownerKind: 'tenant' | 'platform' = 'tenant'): Promise<RewrapFixture> {
  const context = buildContext(ownerKind);
  const kms = new FakeRemoteKms();
  const secret = Buffer.from('provider-secret-bytes-v1', 'utf8');
  const envelope = await sealProviderCredential(secret, context, kms, 'kms-old');
  secret.fill(0);
  const repository = new MemoryWrapperRepository(ownerKind, envelope);
  const service = new ProviderSupplyService({} as SaasDatabase, {
    deployment,
    environment,
    kmsKeyId: 'kms-new',
    repository: repository.repository,
    rewrappingKms: kms,
    now: () => new Date('2026-09-29T00:00:00.000Z'),
  });
  return { context, kms, repository, service, original: repository.baseVersion };
}

function rewrapInput(
  fixture: RewrapFixture,
  overrides: Partial<{
    destinationKmsKeyId: string;
    operationId: string;
    audit: ProviderCredentialRewrapAuditContext;
    reasonCode: string;
  }> = {},
) {
  return {
    credential: fixture.repository.reference,
    version: 1,
    expectedWrappingRevision: 1,
    destinationKmsKeyId: overrides.destinationKmsKeyId ?? 'kms-new',
    operationId: overrides.operationId ?? 'rewrap-op-1',
    audit: overrides.audit ?? {
      actorKind: 'workload' as const,
      actorWorkloadId: 'provider-credential-rewrapper',
      requestId: 'request-rewrap-1',
    },
    reasonCode: overrides.reasonCode ?? 'scheduled_key_rotation',
  };
}

test('remote rewrap receives only the wrapped DEK and preserves the encrypted Secret bytes', async () => {
  const fixture = await createFixture();
  const output = await fixture.service.rewrapProviderCredential(rewrapInput(fixture));
  const request = fixture.kms.reencryptRequests[0];
  assert.ok(request);
  assert.equal(request.sourceKmsKeyId, 'kms-old');
  assert.equal(request.destinationKmsKeyId, 'kms-new');
  assert.deepEqual(Buffer.from(request.ciphertextBlob), Buffer.from(fixture.original.envelope.wrappedDek, 'base64url'));
  assert.deepEqual(request.sourceEncryptionContext, createProviderCredentialEncryptionContext(fixture.context));
  assert.deepEqual(request.destinationEncryptionContext, request.sourceEncryptionContext);
  assert.equal('plaintextKey' in request, false);
  assert.equal(fixture.kms.decryptCalls, 0);
  assert.equal(output.version, 1);
  assert.equal(output.wrappingRevision, 2);

  const current = await fixture.repository.getCredentialVersionEnvelope();
  assert.equal(current.version, fixture.original.version);
  assert.equal(current.envelope.ciphertext, fixture.original.envelope.ciphertext);
  assert.equal(current.envelope.nonce, fixture.original.envelope.nonce);
  assert.equal(current.envelope.authTag, fixture.original.envelope.authTag);
  assert.notEqual(current.envelope.wrappedDek, fixture.original.envelope.wrappedDek);
  assert.equal(fixture.repository.baseVersion.envelope.wrappedDek, fixture.original.envelope.wrappedDek);

  let opened = '';
  await withUnsealedProviderCredential(current.envelope, fixture.context, fixture.kms, (secret) => {
    opened = secret.toString('utf8');
  });
  assert.equal(opened, 'provider-secret-bytes-v1');
  assert.equal(fixture.kms.decryptCalls, 1);
  assert.equal(fixture.repository.history[0]?.actorWorkloadId, 'provider-credential-rewrapper');
});

test('failed or unknown KMS outcomes keep the old wrapper current and the same operation can retry safely', async () => {
  const fixture = await createFixture();
  fixture.kms.behavior = 'failed';
  await assert.rejects(
    fixture.service.rewrapProviderCredential(rewrapInput(fixture)),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'KMS_REWRAP_FAILED',
  );
  assert.equal(fixture.repository.history.length, 0);
  assert.equal((await fixture.repository.getCredentialVersionEnvelope()).wrappingRevision, 1);

  fixture.kms.behavior = 'unknown';
  await assert.rejects(
    fixture.service.rewrapProviderCredential(rewrapInput(fixture)),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'KMS_REWRAP_FAILED',
  );
  assert.equal(fixture.repository.history.length, 0);
  assert.equal((await fixture.repository.getCredentialVersionEnvelope()).wrappingRevision, 1);
  assert.equal(
    (await fixture.repository.getCredentialVersionEnvelope()).envelope.wrappedDek,
    fixture.original.envelope.wrappedDek,
  );

  fixture.kms.behavior = 'success';
  const accepted = await fixture.service.rewrapProviderCredential(rewrapInput(fixture));
  assert.equal(accepted.wrappingRevision, 2);
  assert.equal(fixture.repository.history.length, 1);
});

test('rewrap CAS permits one concurrent revision and operation IDs are idempotent', async () => {
  const fixture = await createFixture();
  const first = rewrapInput(fixture, { operationId: 'operation-a' });
  const concurrent = rewrapInput(fixture, { operationId: 'operation-b', destinationKmsKeyId: 'kms-other' });
  const results = await Promise.allSettled([
    fixture.service.rewrapProviderCredential(first),
    fixture.service.rewrapProviderCredential(concurrent),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(fixture.repository.history.length, 1);
  assert.equal((await fixture.repository.getCredentialVersionEnvelope()).wrappingRevision, 2);

  const acceptedInput = fixture.repository.history[0]?.operationId === 'operation-a' ? first : concurrent;
  const beforeCalls = fixture.kms.reencryptRequests.length;
  const replay = await fixture.service.rewrapProviderCredential(acceptedInput);
  assert.equal(replay.wrappingRevision, 2);
  assert.equal(fixture.kms.reencryptRequests.length, beforeCalls);
  await assert.rejects(
    fixture.service.rewrapProviderCredential({ ...acceptedInput, reasonCode: 'different_reason' }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_VERSION_CONFLICT',
  );
});

test('user audit is committed with the accepted wrapper revision', async () => {
  const fixture = await createFixture();
  const accepted = await fixture.service.rewrapProviderCredential(
    rewrapInput(fixture, {
      audit: {
        actorKind: 'user',
        actorUserId: 'user-a',
        entryPoint: 'security-console',
        requestId: 'request-user-rewrap',
      },
    }),
  );
  assert.equal(accepted.wrappingRevision, 2);
  assert.equal(fixture.repository.auditEvents.length, 1);
  assert.equal(fixture.repository.auditEvents[0]?.action, 'saas_provider_credential.rewrapped');
  assert.equal(fixture.repository.history[0]?.actorUserId, 'user-a');
});

test('tenant/platform, product, mode, and secret-version context swaps fail at remote KMS binding', async () => {
  const fixture = await createFixture();
  const original = fixture.original.envelope;
  const kms = fixture.kms;
  const mismatchedContexts = [
    buildContext('tenant', { tenantId: 'tenant-b' }),
    buildContext('tenant', { productId: 'product-b' }),
    buildContext('tenant', { credentialVersion: 2 }),
    buildContext('tenant', { accountId: 'account-b' }),
    buildContext('tenant', { credentialId: 'credential-b' }),
    buildContext('tenant', { providerId: 'provider-b' }),
    buildContext('tenant', { credentialType: 'oauth-token' }),
    buildContext('tenant', { purpose: 'different-purpose' }),
    buildContext('tenant', { deployment: 'different-deployment' }),
    buildContext('tenant', { environment: 'production' }),
    buildContext('platform'),
  ];
  for (const context of mismatchedContexts) {
    await assert.rejects(
      rewrapProviderCredentialEnvelope(original, context, 'kms-new', kms),
      (error: unknown) => error instanceof Error && error.message === 'Provider credential rewrap failed',
    );
  }
  assert.equal(kms.decryptCalls, 0);
  assert.equal(fixture.repository.history.length, 0);

  const platform = await createFixture('platform');
  await platform.service.rewrapProviderCredential(rewrapInput(platform));
  const platformRequest = platform.kms.reencryptRequests[0];
  assert.ok(platformRequest);
  assert.equal(Object.hasOwn(platformRequest.sourceEncryptionContext, 'tenantId'), false);
  assert.equal(platformRequest.sourceEncryptionContext.ownerKind, 'platform');
  assert.equal(platformRequest.sourceEncryptionContext.supplyMode, 'platform');
});

test('repository resolves the latest committed wrapper and falls back to immutable legacy version columns', async () => {
  const seenSql: string[] = [];
  const versionRow = (wrappingRevision: number, kmsKeyId: string, wrappedDek: string) => ({
    owner_kind: 'tenant',
    tenant_id: 'tenant-a',
    supply_mode: 'byok',
    account_id: 'account-a',
    credential_id: 'credential-a',
    version: 1,
    status: 'active',
    schema_version: 1,
    context_version: 1,
    algorithm: 'aes-256-gcm',
    kms_purpose: 'provider-api',
    kms_key_id: kmsKeyId,
    wrapping_revision: wrappingRevision,
    wrapped_dek: wrappedDek,
    nonce: Buffer.alloc(12, 1).toString('base64url'),
    ciphertext: Buffer.from('ciphertext').toString('base64url'),
    auth_tag: Buffer.alloc(16, 2).toString('base64url'),
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    retired_at: null,
    revoked_at: null,
  });
  let effectiveRow = versionRow(1, 'kms-old', 'legacy-wrapped-dek');
  const database = {
    query: async <Row>(sql: string) => {
      seenSql.push(sql);
      return { rows: [effectiveRow] as Row[] };
    },
  } as unknown as SaasDatabase;
  const repository = new PostgresProviderSupplyRepository(database);
  const reference = {
    ownerKind: 'tenant' as const,
    tenantId: 'tenant-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    version: 1,
  };

  const legacy = await repository.getCredentialVersionEnvelope(reference);
  assert.equal(legacy?.wrappingRevision, 1);
  assert.equal(legacy?.kmsKeyId, 'kms-old');
  assert.equal(legacy?.envelope.wrappedDek, 'legacy-wrapped-dek');

  effectiveRow = versionRow(2, 'kms-new', 'history-wrapped-dek');
  const latest = await repository.getCredentialVersionEnvelope(reference);
  assert.equal(latest?.wrappingRevision, 2);
  assert.equal(latest?.kmsKeyId, 'kms-new');
  assert.equal(latest?.envelope.wrappedDek, 'history-wrapped-dek');
  assert.equal(latest?.envelope.ciphertext, legacy?.envelope.ciphertext);
  const versionQueries = seenSql.filter((sql) => sql.includes('provider_credential_versions'));
  assert.ok(versionQueries.length > 0);
  assert.ok(versionQueries.every((sql) => sql.includes('LEFT JOIN LATERAL') && sql.includes('COALESCE')));
  assert.ok(versionQueries.every((sql) => sql.includes('saas_tenant_provider_credential_wrappings')));
});
