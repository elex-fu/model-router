import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasCatalogError } from '../../../src/saas/catalog/errors.js';
import { SaasCatalogService } from '../../../src/saas/catalog/service.js';
import type {
  ProviderEligibilityRequest,
  RegisterProviderCapabilityInput,
  RegisterProviderRightsVersionInput,
} from '../../../src/saas/catalog/types.js';
import type { SqlExecutor } from '../../../src/saas/db/index.js';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/008_provider_catalog_and_rights.js';
import { FakeCatalogDatabase } from './fake-database.js';

const NOW = new Date('2026-09-28T00:00:00.000Z');
const EVIDENCE_HASH = 'a'.repeat(64);
const AUDIT_ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function evidence(reference: string) {
  return {
    evidenceReference: reference,
    evidenceSha256: EVIDENCE_HASH,
  };
}

function capability(overrides: Partial<RegisterProviderCapabilityInput> = {}): RegisterProviderCapabilityInput {
  return {
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpoint: 'chat-completions',
    protocol: 'openai-compatible',
    supportLevel: 'supported',
    validationState: 'verified',
    evidenceVersion: 'contract-1',
    discoverySource: 'manual',
    ...evidence('capability-evidence-1'),
    ...overrides,
  };
}

function rights(overrides: Partial<RegisterProviderRightsVersionInput> = {}): RegisterProviderRightsVersionInput {
  return {
    rightsId: 'rights-a',
    providerId: 'provider-a',
    productId: 'product-a',
    credentialType: 'api-key',
    supplyMode: 'platform',
    region: 'cn-mainland',
    purpose: 'commercial-api',
    modelScope: ['model-a'],
    endpointScope: ['chat-completions'],
    effectiveAt: '2026-09-01T00:00:00.000Z',
    approvalReference: 'approval-1',
    status: 'active',
    ...evidence('rights-evidence-1'),
    ...overrides,
  };
}

function request(overrides: Partial<ProviderEligibilityRequest> = {}): ProviderEligibilityRequest {
  return {
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpoint: 'chat-completions',
    credentialType: 'api-key',
    supplyMode: 'platform',
    region: 'cn-mainland',
    purpose: 'commercial-api',
    ...overrides,
  };
}

async function setup(): Promise<{ database: FakeCatalogDatabase; service: SaasCatalogService }> {
  const database = new FakeCatalogDatabase();
  const service = new SaasCatalogService(database, { now: () => NOW });
  await service.registerProviderProduct({
    providerId: 'provider-a',
    productId: 'product-a',
    displayName: 'Provider A Product',
  });
  return { database, service };
}

function assertProductFencePrecedesVersionRead(
  database: FakeCatalogDatabase,
  startIndex: number,
  versionTable: 'saas_provider_capabilities' | 'saas_provider_rights',
): void {
  const statements = database.statements
    .slice(startIndex)
    .map(({ sql }) => sql.replace(/\s+/g, ' ').trim().toLowerCase());
  const globalFenceIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock(1396788563, 46)'));
  const productFenceIndex = statements.findIndex((sql) => sql.includes('saas_catalog_product:'));
  const versionReadIndex = statements.findIndex(
    (sql, index) =>
      index > productFenceIndex &&
      sql.includes(`from ${versionTable}`) &&
      sql.includes('order by version desc') &&
      sql.includes('limit 1'),
  );

  if (versionTable === 'saas_provider_rights') {
    assert.notEqual(globalFenceIndex, -1, `missing global writer fence in ${statements.join('\n')}`);
    assert.ok(
      globalFenceIndex < productFenceIndex,
      `global writer fence must precede product fence: ${statements.join('\n')}`,
    );
  } else {
    assert.equal(globalFenceIndex, -1, 'capability writes must not acquire the unrelated global authorization fence');
  }
  assert.notEqual(productFenceIndex, -1, `missing exclusive product advisory fence in ${statements.join('\n')}`);
  assert.notEqual(versionReadIndex, -1, `missing latest version read in ${statements.join('\n')}`);
  assert.ok(productFenceIndex < versionReadIndex, `product fence must precede version read: ${statements.join('\n')}`);
  assert.equal(
    statements.findIndex((sql) => /\bfor (?:update|share)\b/.test(sql)),
    -1,
    'append-only product and history rows must not be row-locked under SELECT-only grants',
  );
}

function assertTransactionRolledBack(
  database: FakeCatalogDatabase,
  commitsBefore: number,
  rollbacksBefore: number,
): void {
  assert.equal(database.commitCount, commitsBefore);
  assert.equal(database.rollbackCount, rollbacksBefore + 1);
}

test('reuses a caller-owned executor and preserves standalone eligibility results', async () => {
  const { database, service } = await setup();
  await service.registerProviderCapability(capability());
  await service.registerProviderRightsVersion(rights());

  const observedSql: string[] = [];
  const executor: SqlExecutor = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      observedSql.push(sql);
      return database.query<Row>(sql, values);
    },
  };

  const transactionCountBeforeStandalone = database.transactionCount;
  const standaloneAllowed = await service.evaluateProviderEligibility(request(), NOW);
  assert.equal(database.transactionCount, transactionCountBeforeStandalone + 1);

  const transactionCountBeforeDirectReads = database.transactionCount;
  const directAllowed = await service.evaluateProviderEligibility(request(), NOW, executor);
  const standaloneDenied = await service.evaluateProviderEligibility(request({ purpose: 'internal-testing' }), NOW);
  const directDenied = await service.evaluateProviderEligibility(
    request({ purpose: 'internal-testing' }),
    NOW,
    executor,
  );
  const aliasAllowed = await service.checkProviderEligibility(request(), NOW, executor);

  assert.equal(database.transactionCount, transactionCountBeforeDirectReads + 1);
  assert.deepEqual(directAllowed, standaloneAllowed);
  assert.deepEqual(directDenied, standaloneDenied);
  assert.deepEqual(aliasAllowed, standaloneAllowed);
  assert.equal(observedSql.length, 12);
  assert.equal(observedSql.filter((sql) => /pg_advisory_xact_lock_shared/.test(sql)).length, 3);
  for (let index = 0; index < observedSql.length; index += 4) {
    assert.match(observedSql[index] ?? '', /pg_advisory_xact_lock_shared/);
    assert.doesNotMatch(observedSql.slice(index, index + 4).join('\n'), /\bFOR (?:UPDATE|SHARE)\b/i);
  }
});

test('keeps protocol capability independent from commercial Provider rights', async () => {
  const { service } = await setup();
  await service.registerProviderCapability(capability());

  const withoutRights = await service.evaluateProviderEligibility(request());
  assert.equal(withoutRights.decision, 'deny');
  if (withoutRights.decision === 'deny') assert.equal(withoutRights.reason, 'rights_missing');

  await service.registerProviderRightsVersion(rights());
  const withRights = await service.evaluateProviderEligibility(request());
  assert.equal(withRights.decision, 'allow');
});

test('persists public model aliases and appends alias target versions', async () => {
  const { database, service } = await setup();
  const first = await service.registerPublicModelAlias({
    alias: 'public-model-a',
    displayName: 'Public Model A',
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a',
    endpointScope: ['chat-completions'],
  });
  const appendStartIndex = database.statements.length;
  const second = await service.registerPublicModelAliasVersion({
    publicModelId: first.publicModelId,
    providerId: 'provider-a',
    productId: 'product-a',
    model: 'model-a-v2',
    endpointScope: ['chat-completions', 'responses'],
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(database.state.publicModels.length, 1);
  assert.equal(database.state.publicModelVersions.length, 2);
  assert.deepEqual(second.endpointScope, ['chat-completions', 'responses']);
  const appendStatements = database.statements
    .slice(appendStartIndex)
    .map(({ sql }) => sql.replace(/\s+/g, ' ').trim().toLowerCase());
  const aliasFenceIndex = appendStatements.findIndex(
    (sql) => sql.includes('pg_advisory_xact_lock(') && sql.includes('saas_public_model:'),
  );
  const aliasHistoryIndex = appendStatements.findIndex((sql) => sql.includes('from saas_public_model_versions v'));
  assert.ok(aliasFenceIndex >= 0 && aliasFenceIndex < aliasHistoryIndex);
  assert.doesNotMatch(appendStatements[aliasHistoryIndex] ?? '', /\bfor update\b/i);
});

test('requires exact credential, mode, region, purpose, model, and endpoint scopes', async () => {
  const { service } = await setup();
  await service.registerProviderCapability(capability());
  await service.registerProviderRightsVersion(rights());

  const mismatches: Array<Partial<ProviderEligibilityRequest>> = [
    { credentialType: 'oauth' },
    { supplyMode: 'byok' },
    { region: 'us-east' },
    { purpose: 'internal-testing' },
  ];
  for (const mismatch of mismatches) {
    const denied = await service.evaluateProviderEligibility(request(mismatch));
    assert.equal(denied.decision, 'deny');
    if (denied.decision === 'deny') assert.equal(denied.reason, 'rights_scope_mismatch');
  }

  await service.registerProviderCapability(capability({ model: 'model-b' }));
  const modelDenied = await service.evaluateProviderEligibility(request({ model: 'model-b' }));
  assert.equal(modelDenied.decision, 'deny');
  if (modelDenied.decision === 'deny') assert.equal(modelDenied.reason, 'rights_scope_mismatch');

  await service.registerProviderCapability(capability({ endpoint: 'responses' }));
  const endpointDenied = await service.evaluateProviderEligibility(request({ endpoint: 'responses' }));
  assert.equal(endpointDenied.decision, 'deny');
  if (endpointDenied.decision === 'deny') assert.equal(endpointDenied.reason, 'rights_scope_mismatch');
});

test('enforces rights expiry and allows a verified limited capability with a surfaced limitation', async () => {
  const { service } = await setup();
  await service.registerProviderCapability(capability({ supportLevel: 'limited' }));
  await service.registerProviderRightsVersion(rights());

  const allowed = await service.evaluateProviderEligibility(request());
  assert.deepEqual(
    allowed.decision === 'allow' ? { limited: allowed.limited, supportLevel: allowed.supportLevel } : allowed,
    { limited: true, supportLevel: 'limited' },
  );

  await service.registerProviderRightsVersion(
    rights({
      rightsId: 'rights-expired',
      purpose: 'expired-purpose',
      effectiveAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-27T23:59:59.000Z',
    }),
  );
  const expired = await service.evaluateProviderEligibility(request({ purpose: 'expired-purpose' }));
  assert.equal(expired.decision, 'deny');
  if (expired.decision === 'deny') assert.equal(expired.reason, 'rights_expired');
});

test('selects the newest capability version and fails closed for unsupported, unverified, or failed states', async () => {
  const { service } = await setup();
  await service.registerProviderRightsVersion(rights());

  await service.registerProviderCapability(capability({ supportLevel: 'limited' }));
  const limited = await service.evaluateProviderEligibility(request());
  assert.equal(limited.decision, 'allow');

  await service.registerProviderCapability(capability({ supportLevel: 'unsupported' }));
  const unsupported = await service.evaluateProviderEligibility(request());
  assert.equal(unsupported.decision, 'deny');
  if (unsupported.decision === 'deny') assert.equal(unsupported.reason, 'capability_unsupported');

  await service.registerProviderCapability(capability({ supportLevel: 'supported', validationState: 'unverified' }));
  const unverified = await service.evaluateProviderEligibility(request());
  assert.equal(unverified.decision, 'deny');
  if (unverified.decision === 'deny') assert.equal(unverified.reason, 'capability_unverified');

  await service.registerProviderCapability(capability({ supportLevel: 'supported', validationState: 'failed' }));
  const failed = await service.evaluateProviderEligibility(request());
  assert.equal(failed.decision, 'deny');
  if (failed.decision === 'deny') assert.equal(failed.reason, 'capability_failed');
});

test('revocation is an append-only rights version and cannot be reactivated in place', async () => {
  const { database, service } = await setup();
  await service.registerProviderCapability(capability());
  await service.registerProviderRightsVersion(rights());
  assert.equal((await service.evaluateProviderEligibility(request())).decision, 'allow');

  const revoked = await service.revokeProviderRights({
    rightsId: 'rights-a',
    approvalReference: 'approval-revoke',
    ...evidence('rights-revocation-evidence'),
  });
  assert.equal(revoked.version, 2);
  const denied = await service.evaluateProviderEligibility(request());
  assert.equal(denied.decision, 'deny');
  if (denied.decision === 'deny') assert.equal(denied.reason, 'rights_revoked');

  await assert.rejects(
    service.registerProviderRightsVersion(rights({ rightsId: 'rights-a' })),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'INVALID_RIGHTS_STATUS_TRANSITION',
  );
  assert.equal(database.state.rights.length, 2);

  await service.registerProviderRightsVersion(rights({ rightsId: 'rights-new' }));
  assert.equal((await service.evaluateProviderEligibility(request())).decision, 'allow');
});

test('fences each provider product before appending capability, rights, or revocation versions', async () => {
  const { database, service } = await setup();

  let startIndex = database.statements.length;
  await service.registerProviderCapabilityVersion(capability());
  assertProductFencePrecedesVersionRead(database, startIndex, 'saas_provider_capabilities');

  startIndex = database.statements.length;
  await service.registerProviderRightsVersion(rights());
  assertProductFencePrecedesVersionRead(database, startIndex, 'saas_provider_rights');

  startIndex = database.statements.length;
  await service.revokeProviderRights({
    rightsId: 'rights-a',
    approvalReference: 'approval-revoke',
    ...evidence('rights-revocation-evidence'),
  });
  assertProductFencePrecedesVersionRead(database, startIndex, 'saas_provider_rights');
});

test('failed capability, rights, and revocation writes roll back their versions', async () => {
  const { database, service } = await setup();
  const audit = {
    actorUserId: AUDIT_ACTOR_ID,
    entryPoint: 'platform_admin',
    requestId: 'catalog_write_rollback_test',
  } as const;

  let startIndex = database.statements.length;
  let commitsBefore = database.commitCount;
  let rollbacksBefore = database.rollbackCount;
  database.failCapabilityInsert = true;
  await assert.rejects(
    service.registerProviderCapability(capability()),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'CATALOG_STORAGE_ERROR',
  );
  database.failCapabilityInsert = false;
  assertProductFencePrecedesVersionRead(database, startIndex, 'saas_provider_capabilities');
  assertTransactionRolledBack(database, commitsBefore, rollbacksBefore);
  assert.equal(database.state.capabilities.length, 0);

  startIndex = database.statements.length;
  commitsBefore = database.commitCount;
  rollbacksBefore = database.rollbackCount;
  database.failAudit = true;
  await assert.rejects(
    service.registerProviderRightsVersion(rights({ rightsId: 'rights-rollback', audit })),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'CATALOG_STORAGE_ERROR',
  );
  database.failAudit = false;
  assertProductFencePrecedesVersionRead(database, startIndex, 'saas_provider_rights');
  assertTransactionRolledBack(database, commitsBefore, rollbacksBefore);
  assert.equal(database.state.rights.length, 0);
  assert.equal(database.state.rightsEvents.length, 0);

  await service.registerProviderRightsVersion(rights());
  startIndex = database.statements.length;
  commitsBefore = database.commitCount;
  rollbacksBefore = database.rollbackCount;
  database.failAudit = true;
  await assert.rejects(
    service.revokeProviderRights({
      rightsId: 'rights-a',
      approvalReference: 'approval-revoke',
      ...evidence('rights-revocation-evidence'),
      audit,
    }),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'CATALOG_STORAGE_ERROR',
  );
  database.failAudit = false;
  assertProductFencePrecedesVersionRead(database, startIndex, 'saas_provider_rights');
  assertTransactionRolledBack(database, commitsBefore, rollbacksBefore);
  assert.equal(database.state.rights.length, 1);
  assert.equal(database.state.rights[0]?.version, 1);
  assert.equal(database.state.rightsEvents.length, 1);
});

test('catalog version writes fail closed when the provider product is missing or disabled', async () => {
  const missingDatabase = new FakeCatalogDatabase();
  const missingService = new SaasCatalogService(missingDatabase, { now: () => NOW });
  await assert.rejects(
    missingService.registerProviderCapability(capability()),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'PROVIDER_PRODUCT_NOT_FOUND',
  );
  await assert.rejects(
    missingService.registerProviderRightsVersion(rights()),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'PROVIDER_PRODUCT_NOT_FOUND',
  );
  assert.equal(missingDatabase.state.capabilities.length, 0);
  assert.equal(missingDatabase.state.rights.length, 0);

  const { database, service } = await setup();
  await service.registerProviderRightsVersion(rights());
  const product = database.state.products[0];
  assert.ok(product);
  product.status = 'disabled';

  await assert.rejects(
    service.registerProviderCapability(capability()),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'PROVIDER_PRODUCT_NOT_FOUND',
  );
  await assert.rejects(
    service.registerProviderRightsVersion(rights({ rightsId: 'rights-disabled' })),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'PROVIDER_PRODUCT_NOT_FOUND',
  );
  await assert.rejects(
    service.revokeProviderRights({
      rightsId: 'rights-a',
      approvalReference: 'approval-revoke',
      ...evidence('rights-revocation-evidence'),
    }),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'PROVIDER_PRODUCT_NOT_FOUND',
  );
  assert.equal(database.state.capabilities.length, 0);
  assert.equal(database.state.rights.length, 1);
  assert.equal(database.state.rights[0]?.version, 1);

  product.status = 'active';
  database.state.products.splice(database.state.products.indexOf(product), 1);
  await assert.rejects(
    service.revokeProviderRights({
      rightsId: 'rights-a',
      approvalReference: 'approval-revoke',
      ...evidence('rights-revocation-evidence'),
    }),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'RIGHTS_NOT_FOUND',
  );
  assert.equal(database.state.rights.length, 1);
  assert.equal(database.state.rights[0]?.version, 1);
});

test('fake SQL records per-product advisory fences for concurrent version writes', async () => {
  // The fake checks fence keys/order only; PostgreSQL blocking is covered by the optional live test in migration 048.
  const database = new FakeCatalogDatabase(false);
  const service = new SaasCatalogService(database, { now: () => NOW });
  await service.registerProviderProduct({
    providerId: 'provider-a',
    productId: 'product-a',
    displayName: 'Provider A Product',
  });
  await service.registerProviderProduct({
    providerId: 'provider-a',
    productId: 'product-b',
    displayName: 'Provider A Product B',
  });
  const startIndex = database.statements.length;

  await Promise.all([
    service.registerProviderCapability(capability()),
    service.registerProviderCapability(capability({ productId: 'product-b' })),
  ]);

  assert.equal(database.maxConcurrentTransactionCount, 2);
  const productFences = database.statements
    .slice(startIndex)
    .filter(({ sql }) => sql.includes('pg_advisory_xact_lock(') && sql.includes('saas_catalog_product:'));
  assert.equal(productFences.length, 2);
  assert.deepEqual(
    productFences.map(({ values }) => values.slice(0, 2)),
    [
      ['provider-a', 'product-a'],
      ['provider-a', 'product-b'],
    ],
  );
  assert.ok(database.statements.slice(startIndex).every(({ sql }) => !/\bfor (?:update|share)\b/i.test(sql)));
});

test('admin rights writes append actor-attributed audit rows in the same transaction', async () => {
  const { database, service } = await setup();
  const audit = {
    actorUserId: AUDIT_ACTOR_ID,
    entryPoint: 'platform_admin',
    requestId: 'platform_admin_write_test',
    sourceIp: '127.0.0.1',
    userAgent: 'platform-test-agent',
  } as const;

  await service.registerProviderRightsVersion(rights({ audit }));
  assert.deepEqual(database.state.auditEvents, [
    {
      id: database.state.auditEvents[0]?.id,
      tenant_id: null,
      actor_user_id: AUDIT_ACTOR_ID,
      action: 'provider_rights.version_registered',
      target_type: 'saas_provider_rights',
      target_id: 'rights-a',
      occurred_at: NOW.toISOString(),
      source_ip: '127.0.0.1',
      user_agent: 'platform-test-agent',
      entry_point: 'platform_admin',
      request_id: 'platform_admin_write_test',
    },
  ]);

  await service.revokeProviderRights({
    rightsId: 'rights-a',
    approvalReference: 'approval-revoke',
    ...evidence('rights-revocation-evidence'),
    audit,
  });
  assert.equal(database.state.auditEvents.length, 2);
  assert.equal(database.state.auditEvents[1]?.action, 'provider_rights.revoked');
  assert.equal(database.state.auditEvents[1]?.target_id, 'rights-a');
});

test('admin rights writes roll back the rights version when the same-transaction audit insert fails', async () => {
  const { database, service } = await setup();
  database.failAudit = true;

  await assert.rejects(
    service.registerProviderRightsVersion(
      rights({
        rightsId: 'rights-audit-failure',
        audit: {
          actorUserId: AUDIT_ACTOR_ID,
          entryPoint: 'platform_admin',
          requestId: 'platform_admin_write_failure',
        },
      }),
    ),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'CATALOG_STORAGE_ERROR',
  );
  assert.equal(database.state.rights.length, 0);
  assert.equal(database.state.rightsEvents.length, 0);
  assert.equal(database.state.auditEvents.length, 0);
});

test('denials and safe errors do not expose evidence references, digests, or secret-like input', async () => {
  const { service } = await setup();
  const secretLikeReference = 'vault://provider-a/credential/secret-value';
  await service.registerProviderCapability(
    capability({ evidenceReference: secretLikeReference, evidenceSha256: 'b'.repeat(64) }),
  );
  const denied = await service.evaluateProviderEligibility(request());
  assert.equal(denied.decision, 'deny');
  assert.doesNotMatch(JSON.stringify(denied), /vault:\/\/|secret-value|[0-9a-f]{64}/);

  await assert.rejects(
    service.registerProviderRightsVersion(
      rights({ evidenceReference: secretLikeReference, evidenceSha256: 'not-a-digest' }),
    ),
    (error: unknown) =>
      error instanceof SaasCatalogError &&
      error.code === 'INVALID_INPUT' &&
      !error.message.includes(secretLikeReference) &&
      !error.message.includes('not-a-digest'),
  );
});

test('rejects empty, duplicate, and wildcard scopes before persistence', async () => {
  const { service } = await setup();
  await assert.rejects(
    service.registerProviderRightsVersion(rights({ modelScope: [] })),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    service.registerProviderRightsVersion(rights({ endpointScope: ['chat-completions', 'chat-completions'] })),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    service.registerProviderRightsVersion(rights({ endpointScope: ['*'] })),
    (error: unknown) => error instanceof SaasCatalogError && error.code === 'INVALID_INPUT',
  );
});

test('migration 008 defines bounded append-only catalog tables and registry versions are contiguous', () => {
  const versions = SAAS_MIGRATIONS.map(({ version }) => version);
  const latestVersion = versions.at(-1);

  assert.ok(latestVersion !== undefined);
  assert.deepEqual(
    versions,
    Array.from({ length: latestVersion }, (_, index) => index + 1),
  );
  assert.equal(SAAS_MIGRATIONS[7], PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION);
  assert.match(PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION.sql, /CREATE TABLE saas_provider_capabilities/);
  assert.match(PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION.sql, /CREATE TABLE saas_provider_rights/);
  assert.match(PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION.sql, /evidence_sha256 text NOT NULL/);
  assert.match(PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION.sql, /ON DELETE RESTRICT/);
  assert.match(PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION.sql, /saas_provider_rights_immutable/);
  assert.match(PROVIDER_CATALOG_AND_RIGHTS_SAAS_MIGRATION.sql, /saas_provider_rights_events/);
});
