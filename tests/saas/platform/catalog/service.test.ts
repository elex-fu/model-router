import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PlatformCatalogGovernanceError,
  PlatformCatalogQueryService,
} from '../../../../src/saas/platform/catalog/index.js';
import { FakeCatalogExecutor } from './fake-executor.js';

const CREATED_AT = '2026-09-28T00:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function product(providerId: string, productId: string): Record<string, unknown> {
  return {
    provider_id: providerId,
    product_id: productId,
    display_name: `${providerId} ${productId}`,
    status: 'active',
    created_at: CREATED_AT,
    account_id: 'account-must-not-leak',
    secret_ref: 'secret-must-not-leak',
  };
}

function capability(model: string, version: number): Record<string, unknown> {
  return {
    provider_id: 'provider-a',
    product_id: 'product-a',
    model,
    endpoint: 'chat-completions',
    protocol: 'openai-compatible',
    version,
    support_level: 'supported',
    validation_state: 'verified',
    evidence_version: 'contract-v1',
    discovery_source: 'manual',
    evidence_ref: 'evidence-ref-1',
    evidence_sha256: HASH_A,
    created_at: CREATED_AT,
    evidence_contents: 'private-evidence-content',
    credential_value: 'private-credential-value',
  };
}

function rights(version: number): Record<string, unknown> {
  return {
    rights_id: 'rights-a',
    version,
    provider_id: 'provider-a',
    product_id: 'product-a',
    credential_type: 'api-key',
    supply_mode: 'platform',
    region: 'cn-mainland',
    purpose: 'commercial-api',
    model_scope: ['model-a'],
    endpoint_scope: ['chat-completions'],
    effective_at: '2026-09-01T00:00:00.000Z',
    expires_at: null,
    approval_ref: 'approval-ref-1',
    status: version === 1 ? 'active' : 'revoked',
    evidence_ref: 'rights-evidence-ref-1',
    evidence_sha256: HASH_B,
    created_at: CREATED_AT,
    account_id: 'account-must-not-leak',
    secret_ref: 'secret-must-not-leak',
  };
}

test('exports tenant-independent metadata queries and maps only known schema columns', async () => {
  const database = new FakeCatalogExecutor();
  database.enqueue([product('provider-a', 'product-a')], [capability('model-a', 1)], [rights(1)]);
  const service = new PlatformCatalogQueryService(database);

  const products = await service.listProducts({ providerId: 'provider-a' });
  const capabilities = await service.listCapabilities({ providerId: 'provider-a' });
  const providerRights = await service.listRights({ providerId: 'provider-a' });

  assert.deepEqual(products.items, [
    {
      providerId: 'provider-a',
      productId: 'product-a',
      displayName: 'provider-a product-a',
      status: 'active',
      createdAt: CREATED_AT,
    },
  ]);
  assert.deepEqual(capabilities.items[0], {
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpoint: 'chat-completions',
    protocol: 'openai-compatible',
    version: 1,
    supportLevel: 'supported',
    validationState: 'verified',
    evidenceVersion: 'contract-v1',
    discoverySource: 'manual',
    evidenceReference: 'evidence-ref-1',
    evidenceSha256: HASH_A,
    createdAt: CREATED_AT,
  });
  assert.deepEqual(providerRights.items[0], {
    rightsId: 'rights-a',
    version: 1,
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    supplyMode: 'platform',
    region: 'cn-mainland',
    purpose: 'commercial-api',
    modelScope: ['model-a'],
    endpointScope: ['chat-completions'],
    effectiveAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    approvalReference: 'approval-ref-1',
    status: 'active',
    evidenceReference: 'rights-evidence-ref-1',
    evidenceSha256: HASH_B,
    createdAt: CREATED_AT,
  });

  const serialized = JSON.stringify({ products, capabilities, providerRights }).toLowerCase();
  for (const forbidden of [
    'account_id',
    'secret_ref',
    'credential_value',
    'evidence_contents',
    'private-credential-value',
    'private-evidence-content',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `unexpected field ${forbidden}`);
  }
  for (const call of database.calls) {
    assert.doesNotMatch(call.sql, /tenant|account_id|secret_ref|credential_value|evidence_contents/i);
  }
});

test('uses bounded deterministic keyset pagination and binds filters', async () => {
  const database = new FakeCatalogExecutor();
  database.enqueue([
    product('provider-a', 'product-a'),
    product('provider-a', 'product-b'),
    product('provider-a', 'product-c'),
  ]);
  const service = new PlatformCatalogQueryService(database);

  const first = await service.listProducts({ providerId: 'provider-a', status: 'active', limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(first.nextCursor ?? '', /^pc1\./);
  assert.match(database.calls[0]?.sql ?? '', /ORDER BY p\.provider_id ASC, p\.product_id ASC/);
  assert.match(database.calls[0]?.sql ?? '', /LIMIT \$3/);
  assert.deepEqual(database.calls[0]?.values, ['provider-a', 'active', 3]);

  database.enqueue([product('provider-a', 'product-c')]);
  const second = await service.listProducts({
    providerId: 'provider-a',
    status: 'active',
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0]?.productId, 'product-c');
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.match(database.calls[1]?.sql ?? '', /p\.product_id > \$4/);
  assert.deepEqual(database.calls[1]?.values, ['provider-a', 'active', 'provider-a', 'product-b', 3]);
});

test('rejects malformed filters, pagination, cursors, and arbitrary sort keys before querying', async () => {
  const database = new FakeCatalogExecutor();
  const service = new PlatformCatalogQueryService(database);
  const invalidCases: Array<Promise<unknown>> = [
    service.listProducts({ limit: 0 }),
    service.listProducts({ limit: 2, pageSize: 3 }),
    service.listProducts({ sortBy: 'displayName' } as never),
    service.listCapabilities({ supportLevel: 'maybe' } as never),
    service.listCapabilities({ version: 1.5 }),
    service.listRights({ status: 'unknown' } as never),
    service.listRights({ cursor: 'pc1.not-a-cursor' }),
  ];

  for (const attempt of invalidCases) {
    await assert.rejects(
      attempt,
      (error: unknown) =>
        error instanceof PlatformCatalogGovernanceError &&
        error.code === 'INVALID_INPUT' &&
        error.status === 400 &&
        error.message === 'The platform catalog query contains invalid data.',
    );
  }
  assert.equal(database.calls.length, 0);
});

test('binds cursors to filters and fails closed for malformed rows or database errors', async () => {
  const database = new FakeCatalogExecutor();
  database.enqueue([product('provider-a', 'product-a'), product('provider-a', 'product-b')]);
  const service = new PlatformCatalogQueryService(database);
  const first = await service.listProducts({ limit: 1 });
  assert.ok(first.nextCursor);

  await assert.rejects(
    service.listProducts({ providerId: 'different-provider', cursor: first.nextCursor }),
    (error: unknown) => error instanceof PlatformCatalogGovernanceError && error.code === 'INVALID_INPUT',
  );

  database.enqueue([{ ...capability('model-a', 1), evidence_sha256: 'not-a-sha256' }]);
  await assert.rejects(
    service.listCapabilities(),
    (error: unknown) =>
      error instanceof PlatformCatalogGovernanceError &&
      error.code === 'CATALOG_STORAGE_ERROR' &&
      error.status === 500 &&
      error.message === 'The platform catalog query could not be completed.',
  );

  database.failWith(new Error('database password=do-not-leak'));
  await assert.rejects(
    service.listRights(),
    (error: unknown) =>
      error instanceof PlatformCatalogGovernanceError &&
      error.code === 'CATALOG_STORAGE_ERROR' &&
      error.status === 500 &&
      error.message === 'The platform catalog query could not be completed.' &&
      !error.message.includes('password'),
  );
});
