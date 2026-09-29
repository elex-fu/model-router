import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { ProviderSupplyError } from '../../../src/saas/supply/errors.js';
import { ProviderSupplyService } from '../../../src/saas/supply/index.js';
import {
  PostgresProviderSupplyRepository,
  type ProviderSupplyRepository,
} from '../../../src/saas/supply/repository.js';
import type { CreateProviderAccountInput } from '../../../src/saas/supply/types.js';

type TenantAccountInput = Extract<CreateProviderAccountInput, { readonly ownerKind: 'tenant' }>;
type AccountRow = Record<string, unknown>;

interface AccountState {
  accounts: AccountRow[];
  capabilities: AccountRow[];
}

interface RecordedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly transactionId: number | null;
}

interface CapabilityFailure {
  readonly attempt: number;
  readonly error: Error & { readonly code?: string; readonly constraint?: string };
}

class TransactionalAccountDatabase implements SaasDatabase {
  readonly queries: RecordedQuery[] = [];
  transactionCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  capabilityInsertCount = 0;
  accountFailure: (Error & { readonly code?: string; readonly constraint?: string }) | undefined;
  capabilityFailure: CapabilityFailure | undefined;

  private state: AccountState = { accounts: [], capabilities: [] };

  get committedState(): AccountState {
    return this.state;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.queryState(this.state, sql, values, null);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const transactionId = this.transactionCount;
    const pending = structuredClone(this.state);
    const executor: SqlExecutor = {
      query: <Row>(sql: string, values: readonly unknown[] = []) =>
        this.queryState<Row>(pending, sql, values, transactionId),
    };

    try {
      const result = await work(executor);
      this.state = pending;
      this.commitCount += 1;
      return result;
    } catch (error) {
      this.rollbackCount += 1;
      throw error;
    }
  }

  private async queryState<Row>(
    state: AccountState,
    sql: string,
    values: readonly unknown[],
    transactionId: number | null,
  ): Promise<SqlResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, values: [...values], transactionId });

    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO saas_tenant_provider_accounts')) {
      if (this.accountFailure) throw this.accountFailure;
      const [
        tenantId,
        id,
        displayName,
        providerId,
        productId,
        credentialType,
        region,
        purpose,
        rightsId,
        rightsVersion,
        status,
        validationState,
        createdAt,
        updatedAt,
      ] = values;
      state.accounts.push({
        owner_kind: 'tenant',
        tenant_id: tenantId,
        supply_mode: 'byok',
        id,
        display_name: displayName,
        provider_id: providerId,
        product_id: productId,
        credential_type: credentialType,
        region,
        purpose,
        rights_id: rightsId,
        rights_version: rightsVersion,
        status,
        validation_state: validationState,
        validation_error_code: null,
        last_validated_at: null,
        authz_version: 1,
        created_at: createdAt,
        updated_at: updatedAt,
        disabled_at: null,
        revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO saas_tenant_provider_account_capabilities')) {
      this.capabilityInsertCount += 1;
      if (this.capabilityFailure?.attempt === this.capabilityInsertCount) throw this.capabilityFailure.error;
      const [tenantId, accountId, providerId, productId, model, endpoint, capabilityVersion, createdAt] = values;
      state.capabilities.push({
        tenant_id: tenantId,
        account_id: accountId,
        provider_id: providerId,
        product_id: productId,
        model,
        endpoint,
        capability_version: capabilityVersion,
        created_at: createdAt,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT model, endpoint, capability_version')) {
      const [tenantId, accountId, providerId, productId] = values;
      const rows = state.capabilities
        .filter(
          (row) =>
            row.tenant_id === tenantId &&
            row.account_id === accountId &&
            row.provider_id === providerId &&
            row.product_id === productId,
        )
        .sort((left, right) =>
          `${left.model}\u0000${left.endpoint}\u0000${left.capability_version}`.localeCompare(
            `${right.model}\u0000${right.endpoint}\u0000${right.capability_version}`,
          ),
        );
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (normalized.startsWith('SELECT owner_kind, tenant_id, supply_mode, id, display_name')) {
      const [tenantId, accountId] = values;
      const row = state.accounts.find((candidate) => candidate.tenant_id === tenantId && candidate.id === accountId);
      return { rows: row ? ([row] as Row[]) : [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unexpected test SQL: ${normalized}`);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function tenantAccount(capabilities: TenantAccountInput['capabilities']): TenantAccountInput {
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
    capabilities,
  };
}

function serviceFor(database: SaasDatabase, repository?: ProviderSupplyRepository): ProviderSupplyService {
  return new ProviderSupplyService(database, {
    deployment: 'test',
    environment: 'test',
    kmsKeyId: 'kms/provider-supply',
    ...(repository === undefined ? {} : { repository }),
  });
}

const twoCapabilities = [
  { model: 'model-a', endpoint: 'chat-completions', version: 1 },
  { model: 'model-b', endpoint: 'responses', version: 2 },
] as const;

test('creates an account and all capabilities through one Postgres transaction executor', async () => {
  const database = new TransactionalAccountDatabase();
  const account = await serviceFor(database).createProviderAccount(tenantAccount(twoCapabilities));

  assert.deepEqual(account.capabilities, [
    { model: 'model-a', endpoint: 'chat-completions', version: 1 },
    { model: 'model-b', endpoint: 'responses', version: 2 },
  ]);
  assert.equal(database.transactionCount, 1);
  assert.equal(database.commitCount, 1);
  assert.equal(database.rollbackCount, 0);
  assert.equal(database.committedState.accounts.length, 1);
  assert.equal(database.committedState.capabilities.length, 2);
  assert.equal(new Set(database.queries.map((query) => query.transactionId)).size, 1);
  assert.equal(database.queries[0]?.transactionId, 1);
});

test('reuses a caller-owned Postgres transaction without opening a nested transaction', async () => {
  const database = new TransactionalAccountDatabase();
  const account = await database.transaction((executor) =>
    serviceFor(database, new PostgresProviderSupplyRepository(database, executor)).createProviderAccount(
      tenantAccount(twoCapabilities),
    ),
  );

  assert.equal(account.capabilities.length, 2);
  assert.equal(database.transactionCount, 1);
  assert.equal(database.commitCount, 1);
  assert.equal(database.rollbackCount, 0);
  assert.equal(database.committedState.accounts.length, 1);
  assert.equal(database.committedState.capabilities.length, 2);
  assert.equal(new Set(database.queries.map((query) => query.transactionId)).size, 1);
});

test('rolls back the account and first capability when the second capability insert fails', async () => {
  const database = new TransactionalAccountDatabase();
  database.capabilityFailure = {
    attempt: 2,
    error: Object.assign(new Error('database rejected capability two'), { code: '23503' }),
  };

  await assert.rejects(serviceFor(database).createProviderAccount(tenantAccount(twoCapabilities)));

  assert.equal(database.capabilityInsertCount, 2);
  assert.equal(database.transactionCount, 1);
  assert.equal(database.commitCount, 0);
  assert.equal(database.rollbackCount, 1);
  assert.deepEqual(database.committedState, { accounts: [], capabilities: [] });
  assert.equal(new Set(database.queries.map((query) => query.transactionId)).size, 1);
});

test('maps only the known 034 BYOK catalog fence to a safe retryable conflict', async () => {
  const database = new TransactionalAccountDatabase();
  database.capabilityFailure = {
    attempt: 1,
    error: Object.assign(new Error('provider-a internal catalog diagnostics'), {
      code: '23514',
      constraint: 'saas_tenant_provider_account_capabilities_byok_fence',
    }),
  };

  await assert.rejects(
    serviceFor(database).createProviderAccount(tenantAccount([twoCapabilities[0]])),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'PROVIDER_CATALOG_CONFLICT');
      assert.equal(error.status, 409);
      assert.equal(
        error.message,
        'The provider catalog changed while this account was being created. Refresh the catalog and retry.',
      );
      assert.doesNotMatch(error.message, /provider-a|diagnostics|23514|saas_tenant/);
      return true;
    },
  );

  assert.deepEqual(database.committedState, { accounts: [], capabilities: [] });
});

test('maps the 034 BYOK rights fence on account insertion to the same safe conflict', async () => {
  const database = new TransactionalAccountDatabase();
  database.accountFailure = Object.assign(new Error('provider-a internal rights diagnostics'), {
    code: '23514',
    constraint: 'saas_tenant_provider_accounts_byok_rights_fence',
  });

  await assert.rejects(
    serviceFor(database).createProviderAccount(tenantAccount([twoCapabilities[0]])),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'PROVIDER_CATALOG_CONFLICT');
      assert.equal(error.status, 409);
      assert.equal(
        error.message,
        'The provider catalog changed while this account was being created. Refresh the catalog and retry.',
      );
      assert.doesNotMatch(error.message, /provider-a|diagnostics|23514|saas_tenant/);
      return true;
    },
  );

  assert.deepEqual(database.committedState, { accounts: [], capabilities: [] });
});

test('does not classify unrelated 23514 constraints as a provider catalog conflict', async () => {
  const database = new TransactionalAccountDatabase();
  database.capabilityFailure = {
    attempt: 1,
    error: Object.assign(new Error('internal constraint details for provider-a'), {
      code: '23514',
      constraint: 'unrelated_provider_check',
    }),
  };

  await assert.rejects(
    serviceFor(database).createProviderAccount(tenantAccount([twoCapabilities[0]])),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSupplyError);
      assert.equal(error.code, 'SUPPLY_STORAGE_ERROR');
      assert.equal(error.status, 500);
      assert.equal(error.message, 'The provider supply request could not be stored.');
      assert.doesNotMatch(error.message, /provider-a|constraint details|23514/);
      return true;
    },
  );
});
