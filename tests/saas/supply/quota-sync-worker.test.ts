import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  deriveProviderQuotaState,
  PostgresQuotaSyncWorkerStore,
  type ProviderQuotaProbeResult,
  type ProviderQuotaSyncFetch,
  probeProviderQuota,
  QUOTA_SYNC_REFRESH_INTERVAL_MS,
  QuotaSyncWorker,
  QuotaSyncWorkerError,
  quotaDecimalToMinorUnits,
  startQuotaSyncWorker,
} from '../../../src/saas/supply/quota-sync-worker.js';

type Row = Record<string, unknown>;

const DEPLOYMENT = 'quota-test-deployment';
const ENVIRONMENT = 'quota-test-env';
const TENANT_ID = '00000000-0000-0000-0000-0000000000aa';

const plaintextKey = Buffer.alloc(32, 0x57);
const sealingKms = {
  generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('quota-fixture-wrapped-dek') }),
};
const unsealingKms: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => plaintextKey,
};

interface FixtureEnvelope {
  readonly versionRow: Row;
  readonly secret: string;
}

async function sealFixtureCredential(ownerKind: 'tenant' | 'platform', accountId: string): Promise<FixtureEnvelope> {
  const secret = `sk-quota-fixture-${accountId}`;
  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: TENANT_ID,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'deepseek',
          productId: 'deepseek-chat',
          credentialType: 'api-key',
          accountId,
          credentialId: `credential-${accountId}`,
          credentialVersion: 1,
        }
      : {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'deepseek',
          productId: 'deepseek-chat',
          credentialType: 'api-key',
          accountId,
          credentialId: `credential-${accountId}`,
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(Buffer.from(secret), context, sealingKms, 'quota-fixture-kms');
  return {
    secret,
    versionRow: {
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
    },
  };
}

function accountRow(ownerKind: 'tenant' | 'platform', accountId: string): Row {
  const row: Row = {
    id: accountId,
    provider_id: 'deepseek',
    product_id: 'deepseek-chat',
    credential_type: 'api-key',
    purpose: 'inference',
  };
  if (ownerKind === 'tenant') row.tenant_id = TENANT_ID;
  return row;
}

interface FakeState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  candidateRows: Row[];
  lockedRows?: Row[];
  credentialRows: Row[];
  versionRows: Row[];
  updates: Array<{ sql: string; values: readonly unknown[] }>;
  transactionError?: Error;
}

class FakeDatabase implements SaasDatabase {
  constructor(
    readonly state: FakeState,
    private readonly ownerKind: 'tenant' | 'platform' = 'tenant',
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    // The other owner dimension's tables hold no rows in this fixture, so a
    // poll ordered across both scopes skips straight past them.
    const otherPrefix = this.ownerKind === 'tenant' ? 'saas_platform_provider' : 'saas_tenant_provider';
    if (sql.includes(otherPrefix)) return { rows: [] as RowType[], rowCount: 0 };
    let rows: Row[] = [];
    if (sql.startsWith('UPDATE')) {
      this.state.updates.push({ sql, values });
      return { rows: [] as RowType[], rowCount: 1 };
    }
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      rows = this.state.lockedRows ?? this.state.candidateRows;
    } else if (sql.includes('_provider_accounts')) {
      rows = this.state.candidateRows;
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
    if (this.state.transactionError) throw this.state.transactionError;
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeState(ownerKind: 'tenant' | 'platform', accountId: string, versionRow: Row): FakeState {
  return {
    statements: [],
    candidateRows: [accountRow(ownerKind, accountId)],
    credentialRows: [{ id: `credential-${accountId}`, current_version: 1 }],
    versionRows: [versionRow],
    updates: [],
  };
}

function fakeDatabase(ownerKind: 'tenant' | 'platform', state: FakeState): FakeDatabase {
  return new FakeDatabase(state, ownerKind);
}

function successResult(overrides: Partial<ProviderQuotaProbeResult> = {}): ProviderQuotaProbeResult {
  return {
    state: 'ok',
    remainingMinorUnits: '4984',
    currency: 'CNY',
    adapterId: 'deepseek-balance-v1',
    httpStatus: 200,
    durationMs: 1,
    ...overrides,
  } as ProviderQuotaProbeResult;
}

function storeOptions(overrides: Record<string, unknown> = {}) {
  return { deployment: DEPLOYMENT, environment: ENVIRONMENT, ...overrides };
}

test('decimal amounts convert to minor units exactly, never through floats', () => {
  assert.equal(quotaDecimalToMinorUnits('0'), '0');
  assert.equal(quotaDecimalToMinorUnits('0.00'), '0');
  assert.equal(quotaDecimalToMinorUnits('7'), '700');
  assert.equal(quotaDecimalToMinorUnits('0.07'), '7');
  assert.equal(quotaDecimalToMinorUnits('10.5'), '1050');
  assert.equal(quotaDecimalToMinorUnits('49.84'), '4984');
  assert.equal(quotaDecimalToMinorUnits(49.84), '4984');
  assert.equal(quotaDecimalToMinorUnits('1234567890.99'), '123456789099');
  for (const rejected of [
    '1.234',
    '1e2',
    '1E2',
    '-1.0',
    '+1',
    ' 1',
    '1 ',
    '',
    'abc',
    '0x10',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    {},
    [],
  ]) {
    assert.equal(quotaDecimalToMinorUnits(rejected), null, `${String(rejected)} must be rejected`);
  }
});

test('quota state derives from fixed-point thresholds without guessing', () => {
  assert.equal(deriveProviderQuotaState('0', '500'), 'exhausted');
  assert.equal(deriveProviderQuotaState('1', '500'), 'low');
  assert.equal(deriveProviderQuotaState('500', '500'), 'low');
  assert.equal(deriveProviderQuotaState('501', '500'), 'ok');
});

function jsonResponse(body: unknown, init: { status?: number; contentType?: string; contentLength?: string } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': init.contentType ?? 'application/json' });
  if (init.contentLength !== undefined) headers.set('content-length', init.contentLength);
  return new Response(text, { status: init.status ?? 200, headers });
}

function fetchReturning(...responses: Array<Response | Error>): ProviderQuotaSyncFetch {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  };
}

const deepseekAccount = { providerId: 'deepseek', productId: 'deepseek-chat', credentialType: 'api-key' } as const;
const secret = Buffer.from('sk-quota-fixture-account-a');

test('adapter registry is closed: unsupported products fail closed without a request', async () => {
  let fetched = 0;
  const result = await probeProviderQuota(
    { providerId: 'kimi', productId: 'kimi-platform', credentialType: 'api-key' },
    secret,
    (async () => {
      fetched += 1;
      throw new Error('must not fetch');
    }) as ProviderQuotaSyncFetch,
  );
  assert.equal(fetched, 0);
  assert.deepEqual(result, {
    state: 'unknown',
    errorCode: 'adapter_unsupported',
    retryable: false,
    adapterId: null,
    httpStatus: null,
    durationMs: 0,
  });
});

test('a well-formed OpenAI-style balance response maps to an exact snapshot', async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const result = await probeProviderQuota(deepseekAccount, secret, (async (url: URL, init: RequestInit) => {
    seen.push({ url: url.href, authorization: new Headers(init.headers).get('authorization') });
    return jsonResponse({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '49.84', granted_balance: '0.41', topped_up_balance: '49.43' }],
    });
  }) as ProviderQuotaSyncFetch);
  assert.deepEqual(seen, [
    { url: 'https://api.deepseek.com/user/balance', authorization: 'Bearer sk-quota-fixture-account-a' },
  ]);
  assert.deepEqual(result, {
    state: 'ok',
    remainingMinorUnits: '4984',
    currency: 'CNY',
    adapterId: 'deepseek-balance-v1',
    httpStatus: 200,
    durationMs: result.durationMs,
  });
});

test('threshold boundaries: zero is exhausted, watermark is low, above is ok', async () => {
  for (const [totalBalance, state, remaining] of [
    ['0.00', 'exhausted', '0'],
    ['0', 'exhausted', '0'],
    ['0.01', 'low', '1'],
    ['5.00', 'low', '500'],
    ['5.01', 'ok', '501'],
  ] as const) {
    const result = await probeProviderQuota(
      deepseekAccount,
      secret,
      fetchReturning(
        jsonResponse({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: totalBalance }] }),
      ),
    );
    assert.equal(result.state, state, totalBalance);
    if (result.state !== 'unknown') {
      assert.equal(result.remainingMinorUnits, remaining);
      assert.equal(result.currency, 'USD');
    }
  }
});

test('malformed success bodies fail closed to unknown, never a guessed amount', async (t) => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: 'exponent amount', body: { balance_infos: [{ currency: 'CNY', total_balance: '1e2' }] } },
    { name: 'three fraction digits', body: { balance_infos: [{ currency: 'CNY', total_balance: '1.111' }] } },
    { name: 'negative amount', body: { balance_infos: [{ currency: 'CNY', total_balance: '-1.00' }] } },
    { name: 'missing amount', body: { balance_infos: [{ currency: 'CNY' }] } },
    { name: 'lowercase currency', body: { balance_infos: [{ currency: 'cny', total_balance: '1.00' }] } },
    {
      name: 'multiple currency entries',
      body: {
        balance_infos: [
          { currency: 'CNY', total_balance: '1.00' },
          { currency: 'USD', total_balance: '2.00' },
        ],
      },
    },
    { name: 'empty balance list', body: { balance_infos: [] } },
    { name: 'non-object body', body: [1, 2, 3] },
    { name: 'invalid json', body: '{not json' },
  ];
  for (const { name, body } of cases) {
    await t.test(name, async () => {
      const result = await probeProviderQuota(deepseekAccount, secret, fetchReturning(jsonResponse(body)));
      assert.equal(result.state, 'unknown');
      if (result.state === 'unknown') {
        assert.equal(result.errorCode, 'provider_response_invalid');
        assert.equal(result.retryable, false);
      }
    });
  }
});

test('provider status and transport failures map to fail-closed unknown outcomes', async (t) => {
  const cases: Array<{
    name: string;
    response: Response | Error;
    errorCode: string;
    retryable: boolean;
    httpStatus: number | null;
  }> = [
    {
      name: '401 rejects the credential',
      response: jsonResponse({}, { status: 401 }),
      errorCode: 'credential_rejected',
      retryable: false,
      httpStatus: 401,
    },
    {
      name: '403 rejects the credential',
      response: jsonResponse({}, { status: 403 }),
      errorCode: 'credential_rejected',
      retryable: false,
      httpStatus: 403,
    },
    {
      name: '429 is retryable rate limiting',
      response: jsonResponse({}, { status: 429 }),
      errorCode: 'provider_rate_limited',
      retryable: true,
      httpStatus: 429,
    },
    {
      name: '503 is a retryable provider outage',
      response: jsonResponse({}, { status: 503 }),
      errorCode: 'provider_unavailable',
      retryable: true,
      httpStatus: 503,
    },
    {
      name: '404 means the endpoint is unsupported',
      response: jsonResponse({}, { status: 404 }),
      errorCode: 'provider_endpoint_unsupported',
      retryable: false,
      httpStatus: 404,
    },
    {
      name: 'redirects are rejected',
      response: jsonResponse({}, { status: 302 }),
      errorCode: 'provider_redirect_rejected',
      retryable: false,
      httpStatus: 302,
    },
    {
      name: 'declared oversized bodies are rejected',
      response: jsonResponse({}, { contentLength: '8192' }),
      errorCode: 'provider_response_too_large',
      retryable: false,
      httpStatus: 200,
    },
    {
      name: 'non-JSON content types are rejected',
      response: jsonResponse({}, { contentType: 'text/html' }),
      errorCode: 'provider_response_invalid',
      retryable: false,
      httpStatus: 200,
    },
    {
      name: 'network errors are retryable',
      response: new Error('socket hangup'),
      errorCode: 'provider_network_error',
      retryable: true,
      httpStatus: null,
    },
  ];
  for (const { name, response, errorCode, retryable, httpStatus } of cases) {
    await t.test(name, async () => {
      const result = await probeProviderQuota(deepseekAccount, secret, fetchReturning(response));
      assert.equal(result.state, 'unknown');
      if (result.state === 'unknown') {
        assert.equal(result.errorCode, errorCode);
        assert.equal(result.retryable, retryable);
        assert.equal(result.httpStatus, httpStatus);
      }
    });
  }

  await t.test('an aborted signal is a retryable timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await probeProviderQuota(
      deepseekAccount,
      secret,
      fetchReturning(jsonResponse({})),
      controller.signal,
    );
    assert.equal(result.state, 'unknown');
    if (result.state === 'unknown') assert.equal(result.errorCode, 'provider_timeout');
  });

  await t.test('non-ascii credentials are rejected before any request', async () => {
    let fetched = 0;
    const result = await probeProviderQuota(deepseekAccount, Buffer.from('sk-☃'), (async () => {
      fetched += 1;
      throw new Error('must not fetch');
    }) as ProviderQuotaSyncFetch);
    assert.equal(fetched, 0);
    assert.equal(result.state, 'unknown');
    if (result.state === 'unknown') assert.equal(result.errorCode, 'credential_format_invalid');
  });
});

test('store claims one due account, unseals, probes, and writes the snapshot', async (t) => {
  for (const ownerKind of ['tenant', 'platform'] as const) {
    await t.test(ownerKind, async () => {
      const fixture = await sealFixtureCredential(ownerKind, 'account-a');
      const state = fakeState(ownerKind, 'account-a', fixture.versionRow);
      const store = new PostgresQuotaSyncWorkerStore(fakeDatabase(ownerKind, state), unsealingKms, storeOptions());
      const seenSecrets: string[] = [];
      const outcome = await store.syncNext(async (account, probeSecret) => {
        assert.equal(account.accountId, 'account-a');
        assert.equal(account.ownerKind, ownerKind);
        assert.equal(account.tenantId, ownerKind === 'tenant' ? TENANT_ID : null);
        seenSecrets.push(probeSecret.toString('utf8'));
        return successResult({ state: 'low', remainingMinorUnits: '120', currency: 'CNY' });
      });
      assert.deepEqual(outcome, { outcome: 'synced', ownerKind, accountId: 'account-a', state: 'low' });
      assert.deepEqual(seenSecrets, [fixture.secret]);

      assert.equal(state.updates.length, 1);
      const write = state.updates[0] as { sql: string; values: readonly unknown[] };
      assert.match(write.sql, /quota_state = \$\d/);
      assert.match(write.sql, /quota_checked_at = clock_timestamp\(\)/);
      if (ownerKind === 'tenant') {
        assert.match(write.sql, /WHERE tenant_id = \$1 AND id = \$2/);
        assert.deepEqual(write.values, [TENANT_ID, 'account-a', 'low', '120', 'CNY']);
      } else {
        assert.match(write.sql, /WHERE id = \$1/);
        assert.deepEqual(write.values, ['account-a', 'low', '120', 'CNY']);
      }

      const claim = state.statements.find(({ sql }) => sql.includes('FOR UPDATE SKIP LOCKED'));
      assert.ok(claim, 'the claim must take the row lock without waiting');
      const candidate = state.statements[0] as { sql: string; values: readonly unknown[] };
      assert.match(candidate.sql, /quota_checked_at IS NULL/);
      assert.match(candidate.sql, /unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\]\)/);
      assert.match(candidate.sql, /account\.status = 'active' AND account\.validation_state = 'verified'/);
      assert.deepEqual(candidate.values[0], ['deepseek', 'deepseek']);
      assert.deepEqual(candidate.values[1], ['deepseek-chat', 'deepseek-anthropic']);
      assert.deepEqual(candidate.values[2], ['api-key', 'api-key']);
      assert.equal(candidate.values[3], QUOTA_SYNC_REFRESH_INTERVAL_MS);
    });
  }
});

test('a failed probe writes unknown with no amount and stamps the attempt', async () => {
  const fixture = await sealFixtureCredential('tenant', 'account-a');
  const state = fakeState('tenant', 'account-a', fixture.versionRow);
  const store = new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
  const outcome = await store.syncNext(async () => ({
    state: 'unknown',
    errorCode: 'provider_timeout',
    retryable: true,
    adapterId: 'deepseek-balance-v1',
    httpStatus: null,
    durationMs: 5000,
  }));
  assert.deepEqual(outcome, {
    outcome: 'unknown',
    ownerKind: 'tenant',
    accountId: 'account-a',
    errorCode: 'provider_timeout',
  });
  assert.equal(state.updates.length, 1);
  const write = state.updates[0] as { sql: string; values: readonly unknown[] };
  assert.match(write.sql, /quota_state = 'unknown'/);
  assert.match(write.sql, /quota_remaining_minor_units = NULL, quota_currency = NULL/);
  assert.match(write.sql, /quota_checked_at = clock_timestamp\(\)/);
  assert.deepEqual(write.values, [TENANT_ID, 'account-a']);
});

test('a contended or absent claim yields idle without touching credentials', async () => {
  const fixture = await sealFixtureCredential('tenant', 'account-a');
  const contended = fakeState('tenant', 'account-a', fixture.versionRow);
  contended.lockedRows = [];
  const contendedStore = new PostgresQuotaSyncWorkerStore(new FakeDatabase(contended), unsealingKms, storeOptions());
  let probeCalls = 0;
  const contendedOutcome = await contendedStore.syncNext(async () => {
    probeCalls += 1;
    return successResult();
  });
  assert.deepEqual(contendedOutcome, { outcome: 'idle' });
  assert.equal(probeCalls, 0);
  assert.equal(contended.updates.length, 0);
  assert.equal(
    contended.statements.some(({ sql }) => sql.includes('_provider_credentials')),
    false,
  );

  const empty = fakeState('tenant', 'account-a', fixture.versionRow);
  empty.candidateRows = [];
  const emptyStore = new PostgresQuotaSyncWorkerStore(new FakeDatabase(empty), unsealingKms, storeOptions());
  const emptyOutcome = await emptyStore.syncNext(async () => {
    probeCalls += 1;
    return successResult();
  });
  assert.deepEqual(emptyOutcome, { outcome: 'idle' });
  assert.equal(probeCalls, 0);
  assert.equal(
    empty.statements.some(({ sql }) => sql.includes('FOR UPDATE')),
    false,
  );
});

test('missing or mismatched credential authority is an unknown outcome, never a crash', async (t) => {
  const fixture = await sealFixtureCredential('tenant', 'account-a');

  await t.test('no active credential', async () => {
    const state = fakeState('tenant', 'account-a', fixture.versionRow);
    state.credentialRows = [];
    const store = new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.syncNext(async () => successResult());
    assert.deepEqual(outcome, {
      outcome: 'unknown',
      ownerKind: 'tenant',
      accountId: 'account-a',
      errorCode: 'credential_unavailable',
    });
    assert.equal(state.updates.length, 1);
  });

  await t.test('kms purpose mismatch', async () => {
    const state = fakeState('tenant', 'account-a', { ...fixture.versionRow, kms_purpose: 'backup' });
    const store = new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.syncNext(async () => successResult());
    assert.deepEqual(outcome, {
      outcome: 'unknown',
      ownerKind: 'tenant',
      accountId: 'account-a',
      errorCode: 'credential_unavailable',
    });
  });

  await t.test('a throwing probe callback is converted to unknown', async () => {
    const state = fakeState('tenant', 'account-a', fixture.versionRow);
    const store = new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.syncNext(async () => {
      throw new Error('adapter bug');
    });
    assert.deepEqual(outcome, {
      outcome: 'unknown',
      ownerKind: 'tenant',
      accountId: 'account-a',
      errorCode: 'provider_network_error',
    });
    assert.equal(state.updates.length, 1);
  });

  await t.test('a malformed success from a buggy probe is rejected', async () => {
    const state = fakeState('tenant', 'account-a', fixture.versionRow);
    const store = new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.syncNext(
      async () => successResult({ remainingMinorUnits: '12.3' }) as ProviderQuotaProbeResult,
    );
    assert.deepEqual(outcome, {
      outcome: 'unknown',
      ownerKind: 'tenant',
      accountId: 'account-a',
      errorCode: 'provider_response_invalid',
    });
    const write = state.updates[0] as { sql: string };
    assert.match(write.sql, /quota_state = 'unknown'/);
  });
});

test('an abort during the probe rolls the claim back with no snapshot write', async () => {
  const fixture = await sealFixtureCredential('tenant', 'account-a');
  const state = fakeState('tenant', 'account-a', fixture.versionRow);
  const controller = new AbortController();
  const store = new PostgresQuotaSyncWorkerStore(
    new FakeDatabase(state),
    unsealingKms,
    storeOptions({ signal: controller.signal }),
  );
  await assert.rejects(
    store.syncNext(async () => {
      controller.abort();
      return successResult();
    }),
    (error: unknown) => error instanceof QuotaSyncWorkerError && error.code === 'LEASE_LOST',
  );
  assert.equal(state.updates.length, 0, 'the aborted claim must roll back before the write');
});

test('owner scoping and option validation fail closed', async () => {
  const fixture = await sealFixtureCredential('platform', 'account-p');
  const state = fakeState('platform', 'account-p', fixture.versionRow);
  const store = new PostgresQuotaSyncWorkerStore(
    fakeDatabase('platform', state),
    unsealingKms,
    storeOptions({ owners: ['platform'] }),
  );
  const outcome = await store.syncNext(async () => successResult());
  assert.deepEqual(outcome, { outcome: 'synced', ownerKind: 'platform', accountId: 'account-p', state: 'ok' });
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('tenant_provider_accounts')),
    false,
  );

  assert.throws(
    () => new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions({ owners: [] })),
    (error: unknown) => error instanceof QuotaSyncWorkerError && error.code === 'STORE_UNAVAILABLE',
  );
  assert.throws(
    () => new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions({ deployment: '' })),
    (error: unknown) => error instanceof QuotaSyncWorkerError && error.code === 'STORE_UNAVAILABLE',
  );
});

test('store failures surface as STORE_UNAVAILABLE and the worker reports cycles', async () => {
  const state: FakeState = {
    statements: [],
    candidateRows: [],
    credentialRows: [],
    versionRows: [],
    updates: [],
    transactionError: new Error('connection reset'),
  };
  const store = new PostgresQuotaSyncWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
  await assert.rejects(
    store.syncNext(async () => successResult()),
    (error: unknown) => error instanceof QuotaSyncWorkerError && error.code === 'STORE_UNAVAILABLE',
  );

  const worker = new QuotaSyncWorker(new FakeDatabase(state), unsealingKms, storeOptions());
  await assert.rejects(
    worker.runOnce(),
    (error: unknown) => error instanceof QuotaSyncWorkerError && error.code === 'STORE_UNAVAILABLE',
  );
  await worker.close();
});

test('the worker maps outcomes, probes through the fetch seam, and drains on close', async () => {
  const fixture = await sealFixtureCredential('tenant', 'account-a');
  const state = fakeState('tenant', 'account-a', fixture.versionRow);
  const worker = new QuotaSyncWorker(
    new FakeDatabase(state),
    unsealingKms,
    storeOptions({
      fetch: fetchReturning(
        jsonResponse({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
          ],
        }),
      ),
    }),
  );
  const first = await worker.runOnce();
  assert.equal(first, 'processed');
  const write = state.updates[0] as { values: readonly unknown[] };
  assert.deepEqual(write.values, [TENANT_ID, 'account-a', 'exhausted', '0', 'CNY']);

  const idleState = fakeState('tenant', 'account-a', fixture.versionRow);
  idleState.candidateRows = [];
  const idleWorker = new QuotaSyncWorker(new FakeDatabase(idleState), unsealingKms, storeOptions());
  assert.equal(await idleWorker.runOnce(), 'idle');
  await idleWorker.close();

  const running = startQuotaSyncWorker(
    new FakeDatabase(idleState),
    unsealingKms,
    storeOptions({ pollIntervalMs: 100 }),
  );
  await running.close();

  await worker.close();
  assert.equal(await worker.runOnce(), 'stale');
});
