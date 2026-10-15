import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  OpencodeGoUsageStoreError,
  PostgresOpencodeGoUsageStore,
} from '../../../src/saas/supply/opencode-go-usage-store-postgres.js';
import type { OpencodeGoUsageAccountRef } from '../../../src/saas/supply/opencode-go-usage-worker.js';

type Row = Record<string, unknown>;

const DEPLOYMENT = 'opencode-go-store-test-deployment';
const ENVIRONMENT = 'opencode-go-store-test-env';
const TENANT_ID = '00000000-0000-0000-0000-0000000000bb';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000cc';

const plaintextKey = Buffer.alloc(32, 0x5b);
const sealingKms = {
  generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('usage-fixture-wrapped-dek') }),
};
const unsealingKms: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => plaintextKey,
};

const PLATFORM_ACCOUNT: OpencodeGoUsageAccountRef = Object.freeze({
  ownerKind: 'platform',
  tenantId: null,
  accountId: ACCOUNT_ID,
});
const TENANT_ACCOUNT: OpencodeGoUsageAccountRef = Object.freeze({
  ownerKind: 'tenant',
  tenantId: TENANT_ID,
  accountId: ACCOUNT_ID,
});

function accountRow(ownerKind: 'tenant' | 'platform'): Row {
  const row: Row = {
    owner: ownerKind,
    id: ACCOUNT_ID,
    provider_id: 'opencode-go',
    product_id: 'opencode-go-zen',
    credential_type: 'api-key',
    purpose: 'inference',
  };
  if (ownerKind === 'tenant') row.tenant_id = TENANT_ID;
  return row;
}

async function sealFixtureCredential(ownerKind: 'tenant' | 'platform'): Promise<Row> {
  const secret = 'opencode-go-fixture-key';
  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: TENANT_ID,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'opencode-go',
          productId: 'opencode-go-zen',
          credentialType: 'api-key',
          accountId: ACCOUNT_ID,
          credentialId: 'credential-1',
          credentialVersion: 1,
        }
      : {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'opencode-go',
          productId: 'opencode-go-zen',
          credentialType: 'api-key',
          accountId: ACCOUNT_ID,
          credentialId: 'credential-1',
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(Buffer.from(secret), context, sealingKms, 'usage-fixture-kms');
  return {
    version: 1,
    schema_version: 1,
    context_version: 1,
    algorithm: 'aes-256-gcm',
    kms_purpose: 'inference',
    kms_key_id: envelope.kmsKeyId,
    wrapped_dek: envelope.wrappedDek,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    auth_tag: envelope.authTag,
  };
}

interface FakeState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  readonly updates: Array<{ sql: string; values: readonly unknown[] }>;
  claimRows: Row[];
  accountRows: Row[];
  credentialRows: Row[];
  versionRows: Row[];
  rulesRows: Row[];
  casRows: Row[];
}

class FakeDatabase implements SaasDatabase {
  constructor(readonly state: FakeState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    let rows: Row[];
    if (sql.startsWith('UPDATE')) {
      this.state.updates.push({ sql, values });
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        // Each owner scope claims only from its own table.
        rows = this.state.claimRows.filter(
          (row) =>
            !(
              (sql.includes('saas_tenant_provider_accounts') && row.owner === 'platform') ||
              (sql.includes('saas_platform_provider_accounts') && row.owner === 'tenant')
            ),
        );
      } else if (sql.includes('RETURNING authz_version')) rows = this.state.casRows;
      else rows = [];
    } else if (sql.includes('authz_version, opencode_go_protocol_rules')) {
      rows = this.state.rulesRows;
    } else if (sql.includes('_provider_accounts')) {
      rows = this.state.accountRows;
    } else if (sql.includes('_provider_credential_versions')) {
      rows = this.state.versionRows;
    } else if (sql.includes('_provider_credentials')) {
      rows = this.state.credentialRows;
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 120)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    statements: [],
    updates: [],
    claimRows: [],
    accountRows: [],
    credentialRows: [],
    versionRows: [],
    rulesRows: [],
    casRows: [],
    ...overrides,
  };
}

function store(database: SaasDatabase): PostgresOpencodeGoUsageStore {
  return new PostgresOpencodeGoUsageStore(database, unsealingKms, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
  });
}

test('readDueAccounts claims due rows with a SKIP LOCKED attempt-stamp lease per owner scope', async () => {
  const state = fakeState({ claimRows: [accountRow('tenant'), accountRow('platform')] });
  const refs = await store(new FakeDatabase(state)).readDueAccounts({
    nowMs: 1_000_000,
    debounceMs: 60_000,
    intervalMs: 900_000,
    limit: 5,
  });
  assert.deepEqual(refs, [TENANT_ACCOUNT, PLATFORM_ACCOUNT]);
  assert.equal(state.updates.length, 2);
  for (const claim of state.updates) {
    assert.match(claim.sql, /^UPDATE saas_(tenant|platform)_provider_accounts AS account/);
    assert.match(claim.sql, /SET opencode_go_usage_updated_at = \$4::timestamptz/);
    assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(claim.sql, /LIMIT \$6::int/);
    assert.match(
      claim.sql,
      /opencode_go_usage_next_due_at IS NULL\s+OR claim\.opencode_go_usage_next_due_at <= \$4::timestamptz/,
    );
    assert.match(
      claim.sql,
      /opencode_go_usage_updated_at IS NULL\s+OR claim\.opencode_go_usage_updated_at <= \$5::timestamptz/,
    );
    assert.match(
      claim.sql,
      /opencode_go_rate_limited_until IS NULL\s+OR claim\.opencode_go_rate_limited_until <= \$4::timestamptz/,
    );
    assert.match(claim.sql, /claim\.status = 'active' AND claim\.validation_state = 'verified'/);
    assert.deepEqual(claim.values[0], ['opencode-go']);
    assert.deepEqual(claim.values[1], ['opencode-go-zen']);
    assert.deepEqual(claim.values[2], ['api-key']);
    assert.equal(claim.values[3], new Date(1_000_000).toISOString());
    assert.equal(claim.values[4], new Date(1_000_000 - 60_000).toISOString());
    assert.ok(Number.isSafeInteger(claim.values[5]) && (claim.values[5] as number) >= 1);
  }
  // The tenant claim consumes one slot of the budget, so the platform scan
  // runs with the remaining limit only.
  assert.equal(state.updates[0]?.values[5], 5);
  assert.equal(state.updates[1]?.values[5], 4);
  assert.match(state.updates[0]?.sql ?? '', /ORDER BY claim\.opencode_go_usage_next_due_at ASC NULLS FIRST, claim\.id/);
});

test('readDueAccounts stops scanning once the round budget is exhausted', async () => {
  const state = fakeState({ claimRows: [accountRow('tenant')] });
  const refs = await store(new FakeDatabase(state)).readDueAccounts({
    nowMs: 1_000_000,
    debounceMs: 60_000,
    intervalMs: 900_000,
    limit: 1,
  });
  assert.equal(refs.length, 1);
  assert.equal(state.updates.length, 1);
});

test('withUnsealedApiKey unseals the current verified credential through the KMS seam', async () => {
  for (const ownerKind of ['tenant', 'platform'] as const) {
    const state = fakeState({
      accountRows: [accountRow(ownerKind)],
      credentialRows: [{ id: 'credential-1', current_version: 1 }],
      versionRows: [await sealFixtureCredential(ownerKind)],
    });
    const seen: Buffer[] = [];
    const result = await store(new FakeDatabase(state)).withUnsealedApiKey(
      ownerKind === 'tenant' ? TENANT_ACCOUNT : PLATFORM_ACCOUNT,
      async (secret) => {
        seen.push(secret);
        return secret.toString('utf8');
      },
    );
    assert.equal(result, 'opencode-go-fixture-key');
    assert.equal(seen.length, 1);
    // The account binding is re-resolved server-side, never trusted.
    const binding = state.statements[0];
    assert.match(binding?.sql ?? '', /account\.provider_id = \$\d+/);
    assert.ok(binding?.values.includes('opencode-go'));
    assert.ok(binding?.values.includes('opencode-go-zen'));
    assert.ok(binding?.values.includes('api-key'));
  }
});

test('withUnsealedApiKey resolves null without a verified credential or a matching purpose', async () => {
  const noCredential = fakeState({ accountRows: [accountRow('platform')], credentialRows: [] });
  assert.equal(
    await store(new FakeDatabase(noCredential)).withUnsealedApiKey(PLATFORM_ACCOUNT, async () => 'never'),
    null,
  );

  const wrongPurpose = fakeState({
    accountRows: [{ ...accountRow('platform'), purpose: 'batch' }],
    credentialRows: [{ id: 'credential-1', current_version: 1 }],
    versionRows: [{ ...(await sealFixtureCredential('platform')), kms_purpose: 'inference' }],
  });
  assert.equal(
    await store(new FakeDatabase(wrongPurpose)).withUnsealedApiKey(PLATFORM_ACCOUNT, async () => 'never'),
    null,
  );
});

test('writeUsageSnapshot persists every window, resets the failure streak and clears the cooldown', async () => {
  const state = fakeState();
  await store(new FakeDatabase(state)).writeUsageSnapshot(PLATFORM_ACCOUNT, {
    rolling5h: { usedPercent: 41.5, status: 'ok', resetsAtMs: 2_000_000 },
    weekly: null,
    monthly: { usedPercent: null, status: null, resetsAtMs: null },
    fetchedAtMs: 1_500_000,
    nextDueAtMs: 2_500_000,
  });
  assert.equal(state.updates.length, 1);
  const update = state.updates[0];
  assert.match(update?.sql ?? '', /UPDATE saas_platform_provider_accounts/);
  assert.match(update?.sql ?? '', /opencode_go_usage_failure_count = 0/);
  assert.match(update?.sql ?? '', /opencode_go_rate_limited_until = NULL/);
  assert.deepEqual(update?.values, [
    ACCOUNT_ID,
    41.5,
    new Date(2_000_000).toISOString(),
    null,
    null,
    null,
    null,
    new Date(1_500_000).toISOString(),
    new Date(2_500_000).toISOString(),
  ]);
});

test('writeUsageSnapshot on the tenant table keys the row by tenant and account', async () => {
  const state = fakeState();
  await store(new FakeDatabase(state)).writeUsageSnapshot(TENANT_ACCOUNT, {
    rolling5h: null,
    weekly: null,
    monthly: null,
    fetchedAtMs: 1_500_000,
    nextDueAtMs: 2_500_000,
  });
  const update = state.updates[0];
  assert.match(update?.sql ?? '', /UPDATE saas_tenant_provider_accounts/);
  assert.match(update?.sql ?? '', /WHERE tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(update?.values?.slice(0, 2), [TENANT_ID, ACCOUNT_ID]);
});

test('writeUsageFailure advances the horizon without touching the observed windows', async () => {
  const state = fakeState();
  await store(new FakeDatabase(state)).writeUsageFailure(PLATFORM_ACCOUNT, {
    attemptedAtMs: 1_500_000,
    errorCode: 'provider_timeout',
    httpStatus: null,
    retryAfterMs: null,
    nextDueAtMs: 3_000_000,
    failureCount: 3,
  });
  const update = state.updates[0];
  assert.match(update?.sql ?? '', /SET opencode_go_usage_updated_at = \$2,/);
  assert.match(update?.sql ?? '', /opencode_go_usage_next_due_at = \$3,/);
  assert.match(update?.sql ?? '', /opencode_go_usage_failure_count = \$4/);
  assert.doesNotMatch(update?.sql ?? '', /opencode_go_(rolling_5h|weekly|monthly)_used_percent/);
  assert.doesNotMatch(update?.sql ?? '', /opencode_go_rate_limited_until/);
  assert.deepEqual(update?.values, [
    ACCOUNT_ID,
    new Date(1_500_000).toISOString(),
    new Date(3_000_000).toISOString(),
    3,
  ]);
});

test('markRateLimited persists the cooldown only', async () => {
  const state = fakeState();
  await store(new FakeDatabase(state)).markRateLimited(TENANT_ACCOUNT, 9_000_000);
  const update = state.updates[0];
  assert.match(update?.sql ?? '', /SET opencode_go_rate_limited_until = \$3,/);
  assert.doesNotMatch(update?.sql ?? '', /opencode_go_usage_next_due_at/);
  assert.deepEqual(update?.values, [TENANT_ID, ACCOUNT_ID, new Date(9_000_000).toISOString()]);
});

test('protocol rules read and CAS update use the 047/082 authz_version fence', async () => {
  const state = fakeState({
    rulesRows: [{ authz_version: 7, opencode_go_protocol_rules: [{ pattern: 'gpt-*', protocol: 'responses' }] }],
  });
  const usageStore = store(new FakeDatabase(state));
  const read = await usageStore.readOpencodeGoProtocolRules(PLATFORM_ACCOUNT);
  assert.deepEqual(read, { authzVersion: 7, rules: [{ pattern: 'gpt-*', protocol: 'responses' }] });

  state.casRows = [{ authz_version: 8, opencode_go_protocol_rules: null }];
  const updated = await usageStore.updateOpencodeGoProtocolRules(PLATFORM_ACCOUNT, {
    rulesJson: null,
    expectedAuthzVersion: 7,
  });
  assert.deepEqual(updated, { authzVersion: 8, rules: null });
  const update = state.updates.at(-1);
  assert.match(update?.sql ?? '', /SET opencode_go_protocol_rules = \$2::jsonb,/);
  assert.match(update?.sql ?? '', /authz_version = authz_version \+ 1/);
  assert.match(update?.sql ?? '', /AND authz_version = \$3/);
  assert.deepEqual(update?.values, [ACCOUNT_ID, null, 7]);

  // A stale expected fence resolves null: the caller fails closed.
  state.casRows = [];
  assert.equal(
    await usageStore.updateOpencodeGoProtocolRules(PLATFORM_ACCOUNT, {
      rulesJson: '[]',
      expectedAuthzVersion: 7,
    }),
    null,
  );
});

test('the store wraps database failures as a stable store-unavailable error', async () => {
  const failing: SaasDatabase = {
    query: async () => {
      throw new Error('connection reset');
    },
    transaction: async () => {
      throw new Error('connection reset');
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
  await assert.rejects(
    store(failing).readDueAccounts({ nowMs: 1, debounceMs: 1, intervalMs: 1, limit: 1 }),
    OpencodeGoUsageStoreError,
  );
  await assert.rejects(store(failing).markRateLimited(PLATFORM_ACCOUNT, 1), OpencodeGoUsageStoreError);
});
