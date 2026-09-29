import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderCredentialEnvelope } from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';

const createdAt = '2026-09-28T00:00:00.000Z';
const reference = {
  ownerKind: 'platform' as const,
  tenantId: null,
  accountId: 'platform-account-1',
  credentialId: 'platform-credential-1',
};

const envelope: ProviderCredentialEnvelope = {
  schemaVersion: 1,
  contextVersion: 1,
  algorithm: 'aes-256-gcm',
  kmsKeyId: 'kms/provider-supply',
  wrappedDek: 'wrapped-dek',
  nonce: 'nonce-value',
  ciphertext: 'ciphertext-value',
  authTag: 'auth-tag-value',
};

function credentialRow(currentVersion: number | null) {
  return {
    owner_kind: 'platform',
    tenant_id: null,
    supply_mode: 'platform',
    id: reference.credentialId,
    account_id: reference.accountId,
    provider_id: 'provider-1',
    product_id: 'product-1',
    credential_type: 'api-key',
    status: 'active',
    validation_state: 'verified',
    validation_error_code: null,
    last_validated_at: createdAt,
    current_version: currentVersion,
    expires_at: null,
    authz_version: 2,
    created_at: createdAt,
    updated_at: createdAt,
    disabled_at: null,
    revoked_at: null,
  };
}

function versionRow(version = 1, status = 'active') {
  return {
    owner_kind: 'platform',
    tenant_id: null,
    supply_mode: 'platform',
    account_id: reference.accountId,
    credential_id: reference.credentialId,
    version,
    status,
    schema_version: envelope.schemaVersion,
    context_version: envelope.contextVersion,
    algorithm: envelope.algorithm,
    kms_purpose: 'inference',
    kms_key_id: envelope.kmsKeyId,
    wrapping_revision: 1,
    wrapped_dek: envelope.wrappedDek,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    auth_tag: envelope.authTag,
    created_at: createdAt,
    expires_at: null,
    retired_at: status === 'retired' ? createdAt : null,
    revoked_at: null,
  };
}

class ScriptedDatabase implements SaasDatabase {
  readonly statements: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  retiredBeforeInsert = false;
  insertedAfterRetirement = false;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push({ sql: normalized, values: [...values] });

    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT owner_kind, NULL::uuid AS tenant_id')) {
      if (normalized.includes('ORDER BY version')) return { rows: [versionRow(1)] as Row[], rowCount: 1 };
      return { rows: [versionRow(1)] as Row[], rowCount: 1 };
    }
    if (
      normalized.startsWith('WITH base_version AS') &&
      normalized.includes('FROM saas_platform_provider_credential_versions')
    ) {
      return { rows: [versionRow(1)] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT status, current_version FROM saas_platform_provider_credentials')) {
      return { rows: [{ status: 'active', current_version: 1 }] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT version FROM saas_platform_provider_credential_versions')) {
      return { rows: [{ version: 1 }] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE saas_platform_provider_credential_versions SET status =')) {
      this.retiredBeforeInsert = true;
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO saas_platform_provider_credential_versions')) {
      if (!this.retiredBeforeInsert) throw new Error('partial unique index would reject two active versions');
      this.insertedAfterRetirement = true;
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE saas_platform_provider_credentials SET current_version')) {
      return { rows: [credentialRow(2)] as Row[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT owner_kind, tenant_id, supply_mode, id, account_id')) {
      return { rows: [credentialRow(1)] as Row[], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

test('credential version reads use credential_id for version tables', async () => {
  const database = new ScriptedDatabase();
  const repository = new PostgresProviderSupplyRepository(database);

  await repository.getCredentialVersion({ ...reference, version: 1 });
  await repository.listCredentialVersions(reference);

  const versionQueries = database.statements.filter((statement) =>
    statement.sql.includes('provider_credential_versions'),
  );
  assert.equal(versionQueries.length, 2);
  for (const query of versionQueries) {
    assert.match(query.sql, /credential_id = \$2/);
    assert.doesNotMatch(query.sql, /\bid = \$/);
  }
});

test('credential rotation retires the active version before inserting its replacement', async () => {
  const database = new ScriptedDatabase();
  const repository = new PostgresProviderSupplyRepository(database);

  await repository.appendCredentialVersion({
    credential: { ...reference, version: 2 },
    providerId: 'provider-1',
    productId: 'product-1',
    envelope,
    kmsPurpose: 'inference',
    wrappingRevision: 1,
    expectedCurrentVersion: 1,
    createdAt,
    expiresAt: null,
  });

  assert.equal(database.retiredBeforeInsert, true);
  assert.equal(database.insertedAfterRetirement, true);
  const retirement = database.statements.find((statement) =>
    statement.sql.startsWith('UPDATE saas_platform_provider_credential_versions'),
  );
  const insertion = database.statements.find((statement) =>
    statement.sql.startsWith('INSERT INTO saas_platform_provider_credential_versions'),
  );
  assert.ok(retirement);
  assert.ok(insertion);
  assert.ok(database.statements.indexOf(retirement) < database.statements.indexOf(insertion));
  assert.deepEqual(retirement.values, [createdAt, reference.accountId, reference.credentialId, 1]);
  assert.match(retirement.sql, /retired_at = \$1/);
  assert.match(retirement.sql, /account_id = \$2 AND credential_id = \$3 AND version = \$4/);
});
