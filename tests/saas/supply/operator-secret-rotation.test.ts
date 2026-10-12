import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GenerateProviderCredentialDataKeyRequest,
  ProviderCredentialKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase } from '../../../src/saas/db/index.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import { ProviderSupplyService } from '../../../src/saas/supply/index.js';
import type { CreateProviderAccountInput, ProviderCredentialReference } from '../../../src/saas/supply/types.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';

const NOW = new Date('2026-10-12T00:00:00.000Z');
const OPERATOR_AUDIT = {
  actorUserId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  entryPoint: 'oauth-token-refresh-worker',
} as const;

type TenantAccountInput = Extract<CreateProviderAccountInput, { ownerKind: 'tenant' }>;

class DeterministicKms implements ProviderCredentialKms {
  private sequence = 0;

  async generateDataKey(_request: GenerateProviderCredentialDataKeyRequest) {
    const plaintextKey = Buffer.alloc(32, this.sequence + 1);
    const ciphertextBlob = Buffer.from(`wrapped-${this.sequence}`, 'utf8');
    this.sequence += 1;
    return { plaintextKey, ciphertextBlob };
  }
}

function tenantAccount(): TenantAccountInput {
  return {
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    id: 'account-a',
    displayName: 'Tenant account',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    region: 'cn-mainland',
    purpose: 'inference',
    rightsId: 'rights-a',
    rightsVersion: 1,
    capabilities: [{ model: 'model-a', endpoint: 'chat-completions', version: 1 }],
  };
}

function serviceOptions(repository: FakeProviderSupplyRepository) {
  return {
    repository,
    kms: new DeterministicKms(),
    kmsKeyId: 'kms/provider-supply',
    deployment: 'managed-saas',
    environment: 'test',
    now: () => NOW,
  } as const;
}

const TENANT_CREDENTIAL_REFERENCE: ProviderCredentialReference & {
  readonly ownerKind: 'tenant';
  readonly tenantId: string;
} = {
  ownerKind: 'tenant',
  tenantId: 'tenant-a',
  accountId: 'account-a',
  credentialId: 'credential-a',
};

async function serviceWithTenantCredential(): Promise<{
  service: ProviderSupplyService;
  repository: FakeProviderSupplyRepository;
}> {
  const repository = new FakeProviderSupplyRepository();
  const service = new ProviderSupplyService({} as SaasDatabase, serviceOptions(repository));
  await service.createProviderAccount(tenantAccount());
  await service.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a' },
    id: 'credential-a',
    secret: Buffer.from('first-secret'),
  });
  return { service, repository };
}

test('operator tenant rotation writes the audited version chain without a TenantContext', async () => {
  const { service, repository } = await serviceWithTenantCredential();

  const rotated = await service.replaceTenantProviderCredentialSecretForOperator({
    credential: TENANT_CREDENTIAL_REFERENCE,
    expectedVersion: 1,
    secret: Buffer.from('operator-rotated-secret'),
    audit: OPERATOR_AUDIT,
  });

  assert.equal(rotated.version.version, 2);
  assert.equal(rotated.credential.currentVersion, 2);
  const auditEvent = repository.auditEvents.at(-1);
  assert.ok(auditEvent);
  assert.equal(auditEvent.action, 'provider_supply.credential.secret_rotated');
  assert.equal(auditEvent.audit.actorUserId, OPERATOR_AUDIT.actorUserId);
  assert.equal(auditEvent.audit.entryPoint, OPERATOR_AUDIT.entryPoint);
  assert.equal(auditEvent.tenantId, 'tenant-a');
  assert.equal(auditEvent.targetId, 'credential-a');
  // The D3 validation job is re-enqueued exactly like the platform rotation path.
  assert.equal(repository.validationJobs.length, 1);
  assert.equal(repository.validationJobs[0]?.credentialVersion, 2);
  assert.equal(repository.validationJobs[0]?.tenantId, 'tenant-a');
  assert.doesNotMatch(JSON.stringify(repository), /first-secret|operator-rotated-secret/);
});

test('operator tenant rotation keeps the expectedVersion CAS and rolls back with the audit write', async () => {
  const { service, repository } = await serviceWithTenantCredential();

  await assert.rejects(
    service.replaceTenantProviderCredentialSecretForOperator({
      credential: TENANT_CREDENTIAL_REFERENCE,
      expectedVersion: 7,
      secret: Buffer.from('must-not-commit'),
      audit: OPERATOR_AUDIT,
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_VERSION_CONFLICT',
  );
  assert.equal(repository.auditEvents.length, 0);
  assert.equal(repository.versions.length, 1);

  repository.failAudit = true;
  await assert.rejects(
    service.replaceTenantProviderCredentialSecretForOperator({
      credential: TENANT_CREDENTIAL_REFERENCE,
      expectedVersion: 1,
      secret: Buffer.from('must-not-commit'),
      audit: OPERATOR_AUDIT,
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'SUPPLY_STORAGE_ERROR',
  );
  repository.failAudit = false;
  assert.equal(repository.versions.length, 1);
  assert.doesNotMatch(JSON.stringify(repository), /must-not-commit/);
});

test('operator tenant rotation rejects non-tenant references and missing audit identity', async () => {
  const { service } = await serviceWithTenantCredential();

  await assert.rejects(
    service.replaceTenantProviderCredentialSecretForOperator({
      credential: { ownerKind: 'platform', tenantId: null, accountId: 'account-a', credentialId: 'credential-a' },
      expectedVersion: 1,
      secret: Buffer.from('secret'),
      audit: OPERATOR_AUDIT,
    } as Parameters<ProviderSupplyService['replaceTenantProviderCredentialSecretForOperator']>[0]),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    service.replaceTenantProviderCredentialSecretForOperator({
      credential: TENANT_CREDENTIAL_REFERENCE,
      expectedVersion: 1,
      secret: Buffer.from('secret'),
      audit: undefined as unknown as never,
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'INVALID_INPUT',
  );
});

test('operator tenant rotation stays available where the tenant-context path refuses the same reference', async () => {
  // The context-bound path requires a matching owner/admin TenantContext and a
  // supply-profile resolver; the operator path (decision A) is the only audited
  // route for the control-plane refresh worker, which has neither.
  const { service, repository } = await serviceWithTenantCredential();

  await assert.rejects(
    service.replaceTenantProviderCredentialSecret({
      context: {
        userId: 'user-a',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        tenantRole: 'member',
        projectRole: 'member',
      },
      credential: TENANT_CREDENTIAL_REFERENCE,
      expectedVersion: 1,
      secret: Buffer.from('context-secret'),
      audit: { ...OPERATOR_AUDIT, actorUserId: 'user-a' },
    }),
    (error: unknown) => error instanceof ProviderSupplyError && error.code === 'CREDENTIAL_UNAVAILABLE',
  );

  const rotated = await service.replaceTenantProviderCredentialSecretForOperator({
    credential: TENANT_CREDENTIAL_REFERENCE,
    expectedVersion: 1,
    secret: Buffer.from('operator-rotated-secret'),
    audit: OPERATOR_AUDIT,
  });
  assert.equal(rotated.version.version, 2);
  assert.equal(repository.auditEvents.length, 1);
});
