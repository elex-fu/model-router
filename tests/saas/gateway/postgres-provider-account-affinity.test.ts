import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import { GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/041_gateway_provider_account_affinity.js';
import {
  PostgresProviderAccountAffinity,
  type PostgresProviderAccountAffinityOptions,
} from '../../../src/saas/gateway/postgres-provider-account-affinity.js';
import type {
  ProviderAccountSchedulerAffinityPort,
  ProviderAccountSchedulerAffinityScope,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationEntitlement,
} from '../../../src/saas/gateway/request-preparation-service.js';

interface StoredBinding {
  readonly scope: string;
  readonly kind: string;
  readonly keyVersion: string;
  readonly digest: string;
  readonly ownerKind: string;
  accountId: string;
  state: 'active' | 'expired' | 'invalidated';
  revision: number;
  fence: number;
  expiresAt: number;
}

interface FakeState {
  nowMs: number;
  rows: Map<string, StoredBinding>;
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
}

function keyOf(scope: string, kind: unknown, version: unknown, digest: unknown): string {
  return JSON.stringify([scope, kind, version, digest]);
}

class FakeDatabase implements SaasDatabase {
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(readonly state: FakeState) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.state.statements.push({ sql, values });
    if (sql.includes(':lock')) return { rows: [], rowCount: 0 };

    const scope = JSON.stringify(values.slice(0, 15));
    const kind = values[15];
    if (sql.includes(':key-versions')) {
      const versions = new Set(
        [...this.state.rows.values()]
          .filter(
            (row) =>
              row.scope === scope &&
              row.kind === kind &&
              (row.state === 'active' || row.state === 'invalidated') &&
              row.expiresAt > this.state.nowMs,
          )
          .map(({ keyVersion }) => keyVersion),
      );
      const rows = [...versions].map((hmac_key_version) => ({ hmac_key_version }));
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql.includes(':resolve')) {
      const versions = values[16] as string[];
      const digests = values[17] as string[];
      const wanted = new Set(versions.map((version, index) => keyOf(scope, kind, version, digests[index])));
      const rows = [...this.state.rows.entries()]
        .filter(([key]) => wanted.has(key))
        .map(([, row]) => ({
          account_owner_kind: row.ownerKind,
          account_id: row.accountId,
          state: row.state,
          revision: String(row.revision),
          fencing_token: String(row.fence),
          hmac_key_version: row.keyVersion,
          key_digest: row.digest,
          is_expired: row.expiresAt <= this.state.nowMs,
        }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    const key = keyOf(scope, kind, values[16], values[17]);
    const row = this.state.rows.get(key);
    if (sql.includes(':expire') || sql.includes(':invalidate')) {
      if (
        row &&
        row.state === 'active' &&
        row.revision === Number(values[18]) &&
        row.fence === Number(values[19]) &&
        (sql.includes(':expire') ? row.expiresAt <= this.state.nowMs : row.expiresAt > this.state.nowMs)
      ) {
        row.state = sql.includes(':expire') ? 'expired' : 'invalidated';
        row.revision += 1;
        row.fence += 1;
        return { rows: [{ revision: String(row.revision) }] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes(':insert')) {
      if (this.state.rows.has(key)) return { rows: [], rowCount: 0 };
      const binding: StoredBinding = {
        scope,
        kind: String(kind),
        keyVersion: String(values[16]),
        digest: String(values[17]),
        ownerKind: String(values[4]),
        accountId: String(values[18]),
        state: 'active',
        revision: 1,
        fence: 1,
        expiresAt: this.state.nowMs + Number(values[19]),
      };
      this.state.rows.set(key, binding);
      return { rows: [{ revision: '1' }] as Row[], rowCount: 1 };
    }

    if (sql.includes(':bind-update')) {
      if (
        !row ||
        row.revision !== Number(values[18]) ||
        row.fence !== Number(values[19]) ||
        !(
          (row.state === 'active' && row.expiresAt > this.state.nowMs && row.accountId === values[20]) ||
          row.state === 'expired' ||
          row.state === 'invalidated'
        )
      ) {
        return { rows: [], rowCount: 0 };
      }
      row.accountId = String(values[20]);
      row.state = 'active';
      row.revision += 1;
      row.fence += 1;
      row.expiresAt = this.state.nowMs + Number(values[21]);
      return { rows: [{ revision: String(row.revision) }] as Row[], rowCount: 1 };
    }
    throw new Error(`unexpected affinity SQL: ${sql.slice(0, 100)}`);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    let release = () => {};
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = new Map([...this.state.rows].map(([key, row]) => [key, { ...row }]));
    try {
      return await work(this);
    } catch (error) {
      this.state.rows = before;
      throw error;
    } finally {
      release();
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const CALLER: RequestPreparationCaller = {
  tenantId: 'tenant-a',
  projectId: 'project-a',
  proxyKeyId: 'key-a',
  principalKind: 'member',
  principalId: 'member-a',
  entitlementId: 'entitlement-a',
  supplyProfileId: 'profile-a',
  supplyMode: 'byok',
  modelScopes: ['model-a'],
  authzVersion: 1,
  entitlementVersion: 1,
  supplyProfileVersion: 1,
  modelScopeVersion: 1,
};

const ENTITLEMENT: RequestPreparationEntitlement = {
  tenantId: 'tenant-a',
  projectId: 'project-a',
  proxyKeyId: 'key-a',
  entitlementId: 'entitlement-a',
  entitlementVersion: 1,
  supplyProfileId: 'profile-a',
  supplyProfileVersion: 1,
  supplyMode: 'byok',
  modelScopeVersion: 1,
  allowedModels: ['model-a'],
  allowedProviderIds: ['provider-a'],
  projectPolicyVersion: 1,
};

function scope(overrides: Partial<ProviderAccountSchedulerAffinityScope> = {}): ProviderAccountSchedulerAffinityScope {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    routeConfigId: 'route-a',
    routeConfigVersion: '7',
    publicModelId: 'public-model-a',
    publicModelVersion: '3',
    publicModel: 'model-a',
    protocol: 'openai',
    targetMode: 'tenant_account',
    upstreamId: 'route-upstream-a',
    providerId: 'provider-a',
    productId: 'product-a',
    ...overrides,
  };
}

function createHarness(
  options: {
    readonly ttlMs?: number;
    readonly keys?: PostgresProviderAccountAffinityOptions['keys'];
    readonly activeKeyVersion?: string;
  } = {},
) {
  const state: FakeState = { nowMs: Date.parse('2026-09-28T00:00:00Z'), rows: new Map(), statements: [] };
  const database = new FakeDatabase(state);
  const port = new PostgresProviderAccountAffinity({
    database,
    keys: options.keys ?? [{ version: 'v1', key: Buffer.alloc(32, 0x5a) }],
    activeKeyVersion: options.activeKeyVersion ?? 'v1',
    ttlMs: options.ttlMs ?? 60_000,
  });
  return { state, database, port };
}

function resolveInput(
  affinity: ProviderAccountSchedulerAffinityPort,
  scoped = scope(),
  eligibleAccountIds: readonly string[] = ['account-a', 'account-b'],
  context: { readonly sessionId?: string; readonly previousResponseId?: string } = { sessionId: 'session-raw-secret' },
) {
  return affinity.resolve({
    caller: {
      ...CALLER,
      tenantId: scoped.tenantId,
      projectId: scoped.projectId,
      supplyProfileId: scoped.supplyProfileId,
      supplyMode: scoped.supplyMode,
    },
    entitlement: {
      ...ENTITLEMENT,
      tenantId: scoped.tenantId,
      projectId: scoped.projectId,
      supplyProfileId: scoped.supplyProfileId,
      supplyMode: scoped.supplyMode,
      allowedProviderIds: scoped.supplyMode === 'byok' ? ['provider-a'] : [],
    },
    publicModel: 'model-a',
    protocol: 'openai',
    context,
    scope: scoped,
    eligibleAccountIds,
  });
}

test('affinity digests isolate tenant, project, product, route, and supply families', async () => {
  const { port, state } = createHarness();
  const context = { sessionId: 'session-raw-secret', previousResponseId: 'response-raw-secret' };
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-a' }), { decision: 'allow' });

  const platformScope = scope({
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    targetMode: 'platform_pool',
  });
  const isolated = [
    scope({ tenantId: 'tenant-b' }),
    scope({ projectId: 'project-b' }),
    scope({ productId: 'product-b' }),
    scope({ routeConfigId: 'route-b' }),
    platformScope,
  ];
  for (const isolatedScope of isolated) {
    const result = await resolveInput(port, isolatedScope, ['account-a'], context);
    assert.deepEqual(result, { decision: 'allow', accountId: null });
  }

  const [stored] = [...state.rows.values()];
  assert.ok(stored);
  assert.match(stored.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.digest, context.sessionId);
  assert.equal(
    stored.scope,
    JSON.stringify([
      'tenant-a',
      'project-a',
      'profile-a',
      'byok',
      'tenant',
      'route-a',
      '7',
      'public-model-a',
      '3',
      'model-a',
      'openai',
      'tenant_account',
      'route-upstream-a',
      'provider-a',
      'product-a',
    ]),
  );
  const sqlValues = state.statements.flatMap(({ values }) => values);
  assert.equal(sqlValues.includes(context.sessionId), false, 'raw session ids must never be sent to SQL');
  assert.equal(sqlValues.includes(context.previousResponseId), false, 'raw response ids must never be sent to SQL');
});

test('same-key binding is idempotent and refreshes a bounded TTL with fencing', async () => {
  const { port, state } = createHarness({ ttlMs: 60_000 });
  const context = { sessionId: 'same-session' };
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-a' }), { decision: 'allow' });
  const firstExpiry = [...state.rows.values()][0].expiresAt;
  state.nowMs += 2_000;
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-a' }), { decision: 'allow' });

  const [row] = [...state.rows.values()];
  assert.equal(state.rows.size, 1);
  assert.equal(row.revision, 2);
  assert.equal(row.fence, 2);
  assert.equal(row.expiresAt, firstExpiry + 2_000);
  assert.deepEqual(await resolveInput(port, scope(), ['account-a'], context), {
    decision: 'allow',
    accountId: 'account-a',
  });
});

test('concurrent different-account binds serialize and the loser fails closed', async () => {
  const { port, state } = createHarness();
  const context = { previousResponseId: 'response-race' };
  const results = await Promise.all([
    port.bind({ context, scope: scope(), accountId: 'account-a' }),
    port.bind({ context, scope: scope(), accountId: 'account-b' }),
  ]);
  assert.equal(results.filter(({ decision }) => decision === 'allow').length, 1);
  assert.equal(results.filter(({ decision }) => decision === 'block').length, 1);
  assert.equal(state.rows.size, 1);
  const winner = [...state.rows.values()][0].accountId;
  assert.deepEqual(await resolveInput(port, scope(), [winner], context), { decision: 'allow', accountId: winner });
});

test('expired mappings may be rebound, with a new revision and fence', async () => {
  const { port, state } = createHarness({ ttlMs: 2_000 });
  const context = { sessionId: 'expiring-session' };
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-a' }), { decision: 'allow' });
  state.nowMs += 2_001;
  assert.deepEqual(await resolveInput(port, scope(), ['account-b'], context), { decision: 'allow', accountId: null });
  assert.equal([...state.rows.values()][0].state, 'expired');
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-b' }), { decision: 'allow' });
  const [row] = [...state.rows.values()];
  assert.equal(row.accountId, 'account-b');
  assert.equal(row.state, 'active');
  assert.equal(row.revision, 3);
  assert.equal(row.fence, 3);
});

test('revoked, unhealthy, or capacity-denied affinity targets are invalidated and block fallback until TTL expiry', async () => {
  const { port, state } = createHarness();
  const context = { sessionId: 'stale-session' };
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-a' }), { decision: 'allow' });

  const denied = await resolveInput(port, scope(), ['account-b'], context);
  assert.deepEqual(denied, {
    decision: 'block',
    reason: 'persisted provider account affinity target is no longer eligible',
  });
  const [invalidated] = [...state.rows.values()];
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.revision, 2);
  assert.equal(invalidated.fence, 2);

  // An invalidated mapping is still an existing binding until its original TTL expires.
  assert.deepEqual(await resolveInput(port, scope(), ['account-b'], context), {
    decision: 'block',
    reason: 'provider account affinity target was invalidated',
  });
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-b' }), {
    decision: 'block',
    reason: 'provider account affinity binding conflict',
  });

  // Once the explicit binding TTL expires, normal candidate choice may proceed and bind anew.
  state.nowMs += 60_001;
  assert.deepEqual(await resolveInput(port, scope(), ['account-b'], context), { decision: 'allow', accountId: null });
  assert.deepEqual(await port.bind({ context, scope: scope(), accountId: 'account-b' }), { decision: 'allow' });
  assert.equal([...state.rows.values()][0].accountId, 'account-b');
});

test('versioned HMAC compatibility resolves old rows while a new version is active', async () => {
  const keyV1 = Buffer.alloc(32, 0x11);
  const keyV2 = Buffer.alloc(32, 0x22);
  const context = { sessionId: 'rotating-session' };
  const oldHarness = createHarness({ keys: [{ version: 'v1', key: keyV1 }], activeKeyVersion: 'v1' });
  await oldHarness.port.bind({ context, scope: scope(), accountId: 'account-a' });
  const compatiblePort = new PostgresProviderAccountAffinity({
    database: oldHarness.database,
    keys: [
      { version: 'v1', key: keyV1 },
      { version: 'v2', key: keyV2 },
    ],
    activeKeyVersion: 'v2',
    ttlMs: 60_000,
  });

  assert.deepEqual(await resolveInput(compatiblePort, scope(), ['account-a'], context), {
    decision: 'allow',
    accountId: 'account-a',
  });
  assert.deepEqual(await compatiblePort.bind({ context, scope: scope(), accountId: 'account-a' }), {
    decision: 'allow',
  });
  assert.equal([...oldHarness.state.rows.values()][0].keyVersion, 'v1');
});

test('dropping a still-used HMAC version blocks instead of treating its mapping as missing', async () => {
  const keyV1 = Buffer.alloc(32, 0x31);
  const keyV2 = Buffer.alloc(32, 0x32);
  const context = { sessionId: 'compatibility-required' };
  const oldHarness = createHarness({ keys: [{ version: 'v1', key: keyV1 }], activeKeyVersion: 'v1' });
  await oldHarness.port.bind({ context, scope: scope(), accountId: 'account-a' });
  const rotatedWithoutCompatibility = new PostgresProviderAccountAffinity({
    database: oldHarness.database,
    keys: [{ version: 'v2', key: keyV2 }],
    activeKeyVersion: 'v2',
    ttlMs: 60_000,
  });

  assert.deepEqual(await resolveInput(rotatedWithoutCompatibility, scope(), ['account-a'], context), {
    decision: 'block',
    reason: 'provider account affinity key compatibility is incomplete',
  });
});

test('an expired old-key mapping no longer requires compatibility after its bounded TTL', async () => {
  const keyV1 = Buffer.alloc(32, 0x41);
  const keyV2 = Buffer.alloc(32, 0x42);
  const context = { sessionId: 'expired-old-key-mapping' };
  const oldHarness = createHarness({ keys: [{ version: 'v1', key: keyV1 }], activeKeyVersion: 'v1' });
  await oldHarness.port.bind({ context, scope: scope(), accountId: 'account-a' });
  oldHarness.state.nowMs += 60_001;

  const rotatedPort = new PostgresProviderAccountAffinity({
    database: oldHarness.database,
    keys: [{ version: 'v2', key: keyV2 }],
    activeKeyVersion: 'v2',
    ttlMs: 60_000,
  });
  assert.deepEqual(await resolveInput(rotatedPort, scope(), ['account-b'], context), {
    decision: 'allow',
    accountId: null,
  });
  assert.deepEqual(await rotatedPort.bind({ context, scope: scope(), accountId: 'account-b' }), { decision: 'allow' });
  assert.equal(oldHarness.state.rows.size, 2);
});

test('migration 041 persists only keyed digests and fences immutable mappings', async () => {
  assert.equal(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.version, 41);
  assert.match(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.sql, /key_digest text NOT NULL/);
  assert.match(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.sql, /hmac_key_version text NOT NULL/);
  assert.match(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.sql, /fencing_token bigint NOT NULL/);
  assert.match(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.sql, /revision bigint NOT NULL/);
  assert.match(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.sql, /interval '24 hours'/);
  assert.doesNotMatch(
    GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.sql,
    /session_id|previous_response_id|prompt|credential|endpoint|url/i,
  );

  const scopeValues = [
    'tenant-a',
    'project-a',
    'profile-a',
    'byok',
    'tenant',
    'route-a',
    '7',
    'public-model-a',
    '3',
    'model-a',
    'openai',
    'tenant_account',
    'route-upstream-a',
    'provider-a',
    'product-a',
  ];
  const expectedDigest = createHmac('sha256', Buffer.alloc(32, 0x5a))
    .update(
      JSON.stringify(['model-router/provider-account-affinity', 1, 'v1', scopeValues, 'session', 'session-raw-secret']),
    )
    .digest('hex');
  assert.match(expectedDigest, /^[0-9a-f]{64}$/);
  const { port, state } = createHarness();
  await port.bind({ context: { sessionId: 'session-raw-secret' }, scope: scope(), accountId: 'account-a' });
  assert.equal([...state.rows.values()][0].digest, expectedDigest);
});
