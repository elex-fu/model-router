import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import {
  createSaasDatabase,
  type PreparedSqlStatement,
  type SaasDatabase,
  type SqlExecutor,
  type SqlResult,
  verifySaasRuntimeDatabasePrivileges,
} from '../../../src/saas/db/index.js';
import { PostgresProviderAccountAffinity } from '../../../src/saas/gateway/postgres-provider-account-affinity.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import type { PreparedEvidenceLeaseRequest } from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { PostgresProviderAccountLeaseService } from '../../../src/saas/gateway/provider-account-lease-service.js';
import type {
  ProviderAccountSchedulerAffinityPort,
  ProviderAccountSchedulerAffinityScope,
  ProviderAccountSchedulerInput,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import type {
  RedisConcurrencySlotInput,
  RedisConcurrencySlots,
} from '../../../src/saas/runtime/redis-concurrency-slots.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { type Fixture, seedFixture } from '../metering/normal-success-postgres-fixture.js';
import { alignPlatformPool, type PlatformPoolFacts } from './admission-bench-fixture.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationPgConfigured,
} from './pre-dispatch-postgres-fixture.js';

// Real restricted-role PG scheduler + affinity components. Redis slot
// bookkeeping is an in-memory double; this is not HTTP, admission, provider,
// real Redis, or end-to-end commercial acceptance.
const MAX_HEALTH_AGE_MS = 300_000;
const LEASE_CONCURRENCY = 2;
const sqlStates = new Set([
  '42501',
  '55000',
  '55006',
  '23502',
  '23503',
  '23505',
  '23514',
  '42P01',
  '42703',
  '42P08',
  '42883',
  '42601',
  '40P01',
  '40001',
  '55P03',
  '57014',
]);

function safeFailure(error: unknown): Error {
  const seen = new Set<object>();
  let state: string | undefined;
  while (error && typeof error === 'object' && !seen.has(error) && seen.size < 8) {
    seen.add(error);
    if ('code' in error && typeof error.code === 'string' && sqlStates.has(error.code)) {
      state = error.code;
      break;
    }
    error = 'cause' in error ? error.cause : undefined;
  }
  // Never attach the original error: assertions and PG errors may contain
  // fixture identities, SQL, bound values, or connection details.
  return new Error(`Affinity bind race PostgreSQL component failed${state ? ` (${state})` : ''}; details redacted`);
}

function text(value: unknown): string {
  assert.ok(typeof value === 'string' && value.length > 0, 'persisted fixture field must exist');
  return value;
}

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, 'required component fixture value must exist');
  return value;
}

function signal() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  void promise.catch(() => undefined);
  return { promise, release, fail };
}

function barrier() {
  const gate = signal();
  let arrivals = 0;
  return {
    async arrive() {
      arrivals += 1;
      assert.ok(arrivals <= 2, 'only two public affinity calls may join the barrier');
      if (arrivals === 2) gate.release();
      await gate.promise;
    },
    fail: gate.fail,
    get arrivals() {
      return arrivals;
    },
  };
}

interface ReadCounts {
  eligibility: number;
  health: number;
  concurrency: number;
}

/** Observe exact driver calls/results; preserve native prepared capability and every value. */
function observeDatabase(database: SaasDatabase, observations: Map<string, ReadCounts>): SaasDatabase {
  const note = (sql: string, values: readonly unknown[] | undefined, result: SqlResult<unknown>) => {
    let kind: keyof ReadCounts | undefined;
    let account: unknown;
    if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) {
      kind = 'eligibility';
      account = values?.[3];
      assert.equal(result.rows.length, 1, 'the real platform authority must return one candidate');
    } else if (sql.includes('postgres-provider-account-scheduler:concurrency')) {
      kind = 'concurrency';
      account = values?.[2];
      assert.deepEqual(result.rows, [{ in_flight: '0' }], 'race revalidation must read real free PG capacity');
    } else if (
      /SELECT state, observed_at, cooldown_until/.test(sql) &&
      sql.includes('saas_provider_account_runtime_health')
    ) {
      kind = 'health';
      account = values?.[1];
      assert.equal(result.rows.length, 1);
      assert.equal((result.rows[0] as { state?: unknown }).state, 'healthy');
    }
    if (kind !== undefined) {
      assert.ok(typeof account === 'string' && observations.has(account), 'read must address an original candidate');
      present(observations.get(account))[kind] += 1;
    }
  };
  const executor = (inner: SqlExecutor): SqlExecutor => {
    const wrapped: SqlExecutor = {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const result = await inner.query<Row>(sql, values);
        note(sql, values, result);
        return result;
      },
    };
    if (inner.queryPrepared !== undefined) {
      const prepared = inner.queryPrepared.bind(inner);
      wrapped.queryPrepared = async <Row>(statement: PreparedSqlStatement, values?: readonly unknown[]) => {
        const result = await prepared<Row>(statement, values);
        note(statement.text, values, result);
        return result;
      };
    }
    return wrapped;
  };
  const verifyUnknownOutcomeSchema = database.verifyUnknownOutcomeSchema?.bind(database);
  return {
    ...executor(database),
    transaction: (work) => database.transaction((tx) => work(executor(tx))),
    migrate: () => database.migrate(),
    verifySchema: () => database.verifySchema(),
    ...(verifyUnknownOutcomeSchema === undefined ? {} : { verifyUnknownOutcomeSchema }),
    ping: () => database.ping(),
    close: () => database.close(),
  };
}

async function secondCandidate(
  migrator: SaasDatabase,
  pool: PlatformPoolFacts,
  first: RequestPreparationCandidateAuthority,
): Promise<RequestPreparationCandidateAuthority> {
  assert.ok(first.supplyMode === 'platform');
  const repository = new PostgresProviderSupplyRepository(migrator);
  const original = await repository.getAccount({ ownerKind: 'platform', tenantId: null, accountId: first.accountId });
  assert.ok(original);
  const accountId = `affinity-race-account-${randomUUID()}`;
  const credentialId = `affinity-race-credential-${randomUUID()}`;
  const now = new Date().toISOString();
  const owner = { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' } as const;
  // Same repository/credential-envelope/validation-CAS setup as the public
  // normal-success fixture, sharing its real rights and capability versions.
  const account = await repository.createAccount({
    owner,
    id: accountId,
    displayName: 'affinity race synthetic account',
    providerId: original.providerId,
    productId: original.productId,
    credentialType: original.credentialType,
    region: original.region,
    purpose: original.purpose,
    rightsId: original.rightsId,
    rightsVersion: original.rightsVersion,
    capabilities: original.capabilities,
    status: 'active',
    validationState: 'verified',
    priority: 0,
    weight: 1,
    revalidationIntervalSeconds: null,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createCredential({
    owner,
    id: credentialId,
    accountId,
    providerId: original.providerId,
    productId: original.productId,
    credentialType: original.credentialType,
    status: 'pending',
    validationState: 'unverified',
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const envelope = await sealProviderCredential(
    Buffer.from('affinity-race-synthetic-provider-key'),
    createProviderCredentialContext({
      ...owner,
      deployment: 'fin057-test',
      environment: 'test',
      purpose: 'inference',
      providerId: original.providerId,
      productId: original.productId,
      accountId,
      credentialId,
      credentialVersion: 1,
      credentialType: original.credentialType,
    }),
    {
      generateDataKey: async () => ({
        plaintextKey: Buffer.alloc(32, 0x57),
        ciphertextBlob: Buffer.from('fin057-synthetic-dek'),
      }),
    },
    'fin057-synthetic-kms',
  );
  const appended = await repository.appendCredentialVersion({
    credential: { ownerKind: 'platform', tenantId: null, accountId, credentialId, version: 1 },
    providerId: original.providerId,
    productId: original.productId,
    envelope,
    kmsPurpose: 'inference',
    wrappingRevision: 1,
    expectedCurrentVersion: null,
    createdAt: now,
    expiresAt: null,
  });
  const validated = await migrator.query(
    `UPDATE saas_platform_provider_credentials
        SET validation_state = 'verified', validation_error_code = NULL,
            last_validated_at = $1, status = 'active', updated_at = $1, authz_version = authz_version + 1
      WHERE account_id = $2 AND id = $3 AND authz_version = $4`,
    [now, accountId, credentialId, appended.credential.authzVersion],
  );
  assert.equal(validated.rowCount, 1, 'fixture credential validation must win the original SQL CAS');
  const credential = await repository.getCredential({ ownerKind: 'platform', tenantId: null, accountId, credentialId });
  assert.ok(credential && credential.status === 'active' && credential.currentVersion === 1);
  const supply = new ProviderSupplyService(migrator, {
    deployment: 'fin057-test',
    environment: 'test',
    kmsKeyId: 'fin057-synthetic-kms',
    sealingKms: {
      generateDataKey: async () => ({
        plaintextKey: Buffer.alloc(32, 0x57),
        ciphertextBlob: Buffer.from('fin057-synthetic-dek'),
      }),
    },
  });
  await supply.addPlatformPoolMember({
    poolId: pool.poolId,
    accountId,
    expectedAccountAuthzVersion: account.authzVersion,
  });
  return {
    ...first,
    accountId,
    credentialId,
    credentialVersion: credential.currentVersion,
    credentialAuthzVersion: credential.authzVersion,
    accountAuthzVersion: account.authzVersion,
    poolMemberAccountAuthzVersion: account.authzVersion,
    poolMemberAuthzVersion: 1,
  };
}

async function schedulerInput(
  gateway: SaasDatabase,
  fixture: Fixture,
  pool: PlatformPoolFacts,
): Promise<ProviderAccountSchedulerInput> {
  const sent = fixture.sent;
  const alias = text(
    (
      await gateway.query<{ public_model: string }>(
        'SELECT public_model FROM saas_requests WHERE tenant_id = $1 AND id = $2',
        [fixture.tenantId, fixture.input.requestId],
      )
    ).rows[0]?.public_model,
  );
  const candidate: RequestPreparationCandidateAuthority = {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    proxyKeyId: fixture.keyId,
    supplyProfileId: fixture.profileId,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    upstreamId: text(sent.upstreamId),
    accountId: text(sent.accountId),
    credentialId: text(sent.credentialId),
    credentialVersion: Number(sent.credentialVersion),
    credentialAuthzVersion: Number(sent.credentialAuthzVersion),
    accountAuthzVersion: Number(sent.accountAuthzVersion),
    dispatchProfileId: text(sent.dispatchProfileId),
    supplyProfileAuthzVersion: Number(sent.supplyProfileAuthzVersion),
    resolvedModel: text(sent.resolvedModel),
    protocol: 'openai',
    endpoint: text(sent.endpoint),
    supplierCostVersion: sent.supplierCostVersion,
    providerId: text(sent.providerId),
    productId: text(sent.productId),
    ...pool,
  };
  return {
    requestId: randomUUID(),
    publicModel: alias,
    protocol: 'openai',
    candidates: [candidate],
    caller: {
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      proxyKeyId: fixture.keyId,
      principalKind: 'member',
      principalId: fixture.userId,
      entitlementId: fixture.entitlementId,
      supplyProfileId: fixture.profileId,
      supplyMode: 'platform',
      modelScopes: [alias],
      authzVersion: 1,
      entitlementVersion: 1,
      supplyProfileVersion: 1,
      modelScopeVersion: 1,
    },
    entitlement: {
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      proxyKeyId: fixture.keyId,
      entitlementId: fixture.entitlementId,
      entitlementVersion: 1,
      supplyProfileId: fixture.profileId,
      supplyProfileVersion: 1,
      supplyMode: 'platform',
      modelScopeVersion: 1,
      allowedModels: [alias],
      allowedProviderIds: [],
      projectPolicyVersion: Number(sent.projectPolicyVersion),
    },
    route: {
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      publicModel: alias,
      publicModelId: text(sent.routePublicModelId),
      publicModelVersion: Number(sent.routePublicModelVersion),
      routeConfigId: text(sent.routeConfigId),
      routeConfigVersion: Number(sent.routeConfigVersion),
      protocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      targetMode: 'platform_pool',
      upstreamId: text(sent.upstreamId),
      endpoint: text(sent.endpoint),
    },
    scheduling: {
      sessionId: `affinity-race-session-${randomUUID()}`,
      previousResponseId: `affinity-race-response-${randomUUID()}`,
    },
  };
}

function affinityScope(input: ProviderAccountSchedulerInput): ProviderAccountSchedulerAffinityScope {
  const route = present(input.route);
  const candidate = present(input.candidates[0]);
  return {
    tenantId: input.caller.tenantId,
    projectId: input.caller.projectId,
    supplyProfileId: input.caller.supplyProfileId,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    routeConfigId: route.routeConfigId,
    routeConfigVersion: String(route.routeConfigVersion),
    publicModelId: route.publicModelId,
    publicModelVersion: String(route.publicModelVersion),
    publicModel: input.publicModel,
    protocol: input.protocol,
    targetMode: 'platform_pool',
    upstreamId: candidate.upstreamId,
    providerId: candidate.providerId,
    productId: candidate.productId,
  };
}

interface AffinitySnapshotRow {
  reference_kind: string;
  account_id: string;
  state: string;
  revision: string;
  fencing_token: string;
  expires_at: string;
  updated_at: string;
  created_at: string;
  hmac_key_version: string;
  key_digest: string;
}

// Observer-only full timestamp snapshots use migrator privileges; production ports use the two gateway pools.
async function affinityRows(migrator: SaasDatabase, fixture: Fixture): Promise<AffinitySnapshotRow[]> {
  return (
    await migrator.query<AffinitySnapshotRow>(
      `SELECT reference_kind, account_id, state, revision::text, fencing_token::text,
            expires_at::text, updated_at::text, created_at::text, hmac_key_version, key_digest
       FROM saas_gateway_provider_account_affinity
      WHERE tenant_id = $1 AND project_id = $2 AND supply_profile_id = $3
      ORDER BY reference_kind, hmac_key_version, key_digest`,
      [fixture.tenantId, fixture.projectId, fixture.profileId],
    )
  ).rows;
}

async function financialSnapshot(migrator: SaasDatabase, fixture: Fixture) {
  const tables = [
    'saas_wallets',
    'saas_billing_reservations',
    'saas_ledger_transactions',
    'saas_ledger_entries',
    'saas_usage_events',
    'saas_usage_settlements',
    'saas_requests',
    'saas_attempts',
    'saas_gateway_capacity_reservations',
  ] as const;
  return Promise.all(
    tables.map(async (table) => ({
      table,
      rows: (
        await migrator.query<{ row_count: string; digest: string }>(
          `SELECT count(*)::text AS row_count,
              md5(COALESCE(string_agg(row_to_json(snapshot)::text, E'\\n' ORDER BY row_to_json(snapshot)::text), '')) AS digest
         FROM (SELECT * FROM ${table} WHERE tenant_id = $1) snapshot`,
          [fixture.tenantId],
        )
      ).rows,
    })),
  );
}

function slotBookkeeping() {
  const held = new Map<string, Pick<RedisConcurrencySlotInput, 'ownerScopeKey' | 'accountId' | 'requestId'>>();
  const released: string[] = [];
  let acquisitions = 0;
  const key = (input: Pick<RedisConcurrencySlotInput, 'ownerScopeKey' | 'accountId' | 'requestId'>) =>
    JSON.stringify([input.ownerScopeKey, input.accountId, input.requestId]);
  const slots: RedisConcurrencySlots = {
    async tryAcquire(input) {
      assert.equal(input.ownerScopeKey, 'platform');
      assert.equal(input.maxSlots, LEASE_CONCURRENCY);
      acquisitions += 1;
      const identity = key(input);
      if (held.has(identity)) return { state: 'acquired' };
      const count = [...held.values()].filter((value) => value.accountId === input.accountId).length;
      if (count >= input.maxSlots) return { state: 'saturated' };
      held.set(identity, {
        ownerScopeKey: input.ownerScopeKey,
        accountId: input.accountId,
        requestId: input.requestId,
      });
      return { state: 'acquired' };
    },
    async release(input) {
      released.push(key(input));
      held.delete(key(input));
    },
  };
  return {
    slots,
    held,
    released,
    key,
    get acquisitions() {
      return acquisitions;
    },
  };
}

/** Find two ordinary request ids whose unchanged neutral weighted draw chooses opposite accounts. */
function requestForIndex(input: ProviderAccountSchedulerInput, index: number): string {
  for (let tries = 0; tries < 128; tries += 1) {
    const requestId = randomUUID();
    const seed = [
      requestId,
      input.caller.tenantId,
      input.caller.projectId,
      input.caller.proxyKeyId,
      input.caller.supplyProfileId,
      input.caller.supplyMode,
      input.publicModel,
      input.protocol,
    ].join('\u001f');
    const digest = createHash('sha256').update(seed, 'utf8').digest('hex');
    if (BigInt(`0x${digest.slice(0, 16)}`) % 2n === BigInt(index)) return requestId;
  }
  throw new Error('fixture could not select a bounded deterministic request seed');
}

function leasePortInput(
  fixture: Fixture,
  candidate: RequestPreparationCandidateAuthority,
): PreparedEvidenceLeaseRequest {
  const attemptId = randomUUID();
  // Typed lease-port input only, as in the independent real-PG lease suite;
  // no signed dispatch/admission acceptance is claimed by this setup.
  const evidence = {
    evidenceId: randomUUID(),
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    requestId: randomUUID(),
    attemptId,
    attemptOrdinal: 1,
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    publicModel: 'affinity-race-lease-fixture',
    protocol: 'openai',
    endpoint: candidate.endpoint,
    upstreamId: candidate.upstreamId,
    accountId: candidate.accountId,
    credentialId: candidate.credentialId,
    credentialVersion: String(candidate.credentialVersion),
    routeTargetMode: 'platform_pool',
    payloadSha256: 'b'.repeat(64),
    statementSha256: 'c'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as const;
  return {
    tenantId: fixture.tenantId,
    accountId: candidate.accountId,
    upstreamId: candidate.upstreamId,
    attemptId,
    evidence,
  };
}

async function runRace(afterStaleClear: boolean) {
  const databases: SaasDatabase[] = [];
  const temporaryLeases: Array<{ release(): Promise<void> }> = [];
  const slots = slotBookkeeping();
  let failure: Error | undefined;
  try {
    const connections = await cancellationDatabases();
    databases.push(...connections.databases);
    const { migrator, gateway } = connections;
    const otherGateway = createSaasDatabase({
      connectionString: text(process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim()),
      max: 1,
    });
    databases.push(otherGateway);
    const firstIdentity = present((await gateway.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]);
    const secondIdentity = (
      await otherGateway.query<{ pid: number; role: string; session: string; superuser: boolean }>(
        `SELECT pg_backend_pid() AS pid, current_user AS role, session_user AS session,
              r.rolsuper AS superuser FROM pg_roles r WHERE rolname = current_user`,
      )
    ).rows[0];
    assert.notEqual(firstIdentity.pid, secondIdentity.pid, 'gateway pools must have independent PG connections');
    assert.equal(secondIdentity.role, 'model_router_saas_gateway');
    assert.equal(secondIdentity.session, 'model_router_saas_gateway');
    assert.equal(secondIdentity.superuser, false);
    await verifySaasRuntimeDatabasePrivileges(otherGateway, 'gateway');

    const fixture = await seedFixture(migrator, gateway, 'platform');
    const pool = await alignPlatformPool(migrator, fixture);
    const initial = await schedulerInput(gateway, fixture, pool);
    const second = await secondCandidate(migrator, pool, present(initial.candidates[0]));
    const candidates = [present(initial.candidates[0]), second].sort((left, right) =>
      left.accountId.localeCompare(right.accountId),
    );
    const input = { ...initial, candidates };
    const winner = present(candidates[0]);
    const loser = present(candidates[1]);
    for (const candidate of candidates) {
      const health = await migrator.query(
        `INSERT INTO saas_provider_account_runtime_health
           (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
            observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
         VALUES ('platform', 'platform', NULL, $1, 'healthy', 0, clock_timestamp(), NULL, 'gateway_success', 1, 1)`,
        [candidate.accountId],
      );
      assert.equal(health.rowCount, 1);
    }
    const beforeFunds = await financialSnapshot(migrator, fixture);
    const makeAffinity = (database: SaasDatabase) =>
      new PostgresProviderAccountAffinity({
        database,
        keys: [{ version: 'fixture-v1', key: Buffer.alloc(32, 0x6d) }],
        activeKeyVersion: 'fixture-v1',
      });
    const affinityA = makeAffinity(gateway);
    const affinityB = makeAffinity(otherGateway);
    const scheduler = (database: SaasDatabase, affinity: ProviderAccountSchedulerAffinityPort) =>
      new PostgresProviderAccountScheduler({
        database,
        affinity,
        leaseConcurrencyLimit: LEASE_CONCURRENCY,
        health: new PostgresProviderAccountRuntimeHealthStore({ database, maxHealthAgeMs: MAX_HEALTH_AGE_MS }),
        maxHealthAgeMs: MAX_HEALTH_AGE_MS,
        redisConcurrencySlots: { enabled: true, slots: slots.slots, maxSlots: LEASE_CONCURRENCY },
      });

    if (afterStaleClear) {
      assert.deepEqual(
        await affinityA.bind({
          context: present(input.scheduling),
          scope: affinityScope(input),
          accountId: winner.accountId,
        }),
        { decision: 'allow' },
      );
      const beforeClear = await affinityRows(migrator, fixture);
      const leases = new PostgresProviderAccountLeaseService({
        database: gateway,
        maxConcurrency: LEASE_CONCURRENCY,
        leaseTtlMs: 30_000,
      });
      for (let slot = 0; slot < LEASE_CONCURRENCY; slot += 1) {
        const lease = await leases.acquire(leasePortInput(fixture, winner));
        assert.ok(lease, 'real PG leases must fill the old affinity account');
        temporaryLeases.push(lease);
      }
      let staleResolves = 0;
      const clearing = new PostgresProviderAccountScheduler({
        database: gateway,
        leaseConcurrencyLimit: LEASE_CONCURRENCY,
        health: new PostgresProviderAccountRuntimeHealthStore({ database: gateway, maxHealthAgeMs: MAX_HEALTH_AGE_MS }),
        maxHealthAgeMs: MAX_HEALTH_AGE_MS,
        affinity: {
          async resolve(authority) {
            assert.deepEqual(
              authority.eligibleAccountIds,
              [loser.accountId],
              'real PG capacity must exclude the busy old target',
            );
            const decision = await affinityA.resolve(authority);
            assert.deepEqual(decision, { decision: 'stale' });
            staleResolves += 1;
            return decision;
          },
          bind: (binding) => affinityA.bind(binding),
        },
      });
      const degraded = await clearing.select({ ...input, requestId: randomUUID() });
      assert.equal(degraded.decision, 'allow');
      if (degraded.decision === 'allow') assert.strictEqual(degraded.value, loser);
      assert.equal(staleResolves, 1);
      const invalidated = await affinityRows(migrator, fixture);
      assert.equal(invalidated.length, 2);
      assert.ok(
        invalidated.every(
          (row, index) =>
            row.state === 'invalidated' &&
            row.revision === '2' &&
            row.fencing_token === '2' &&
            row.expires_at === beforeClear[index]?.expires_at,
        ),
      );
      while (temporaryLeases.length > 0) {
        await present(temporaryLeases[0]).release();
        temporaryLeases.shift();
      }
    } else {
      assert.deepEqual(await affinityRows(migrator, fixture), []);
    }
    assert.deepEqual(
      (
        await gateway.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM saas_provider_account_leases WHERE owner_kind = 'platform' AND account_id = ANY($1::text[]) AND status = 'held' AND lease_expires_at > clock_timestamp()",
          [candidates.map(({ accountId }) => accountId)],
        )
      ).rows,
      [{ count: '0' }],
    );

    const resolves = barrier();
    const proposals = barrier();
    const firstCommitted = signal();
    const counts = [0, 0];
    const reads = candidates.map(
      () => new Map(candidates.map(({ accountId }) => [accountId, { eligibility: 0, health: 0, concurrency: 0 }])),
    );
    let loserSnapshotProved = false;
    const ports = [affinityA, affinityB].map(
      (inner, index): ProviderAccountSchedulerAffinityPort => ({
        async resolve(authority) {
          const decision = await inner.resolve(authority);
          assert.deepEqual(
            decision,
            { decision: 'allow', accountId: null },
            'both actual resolve transactions must commit no active binding',
          );
          await resolves.arrive();
          return decision;
        },
        async bind(binding) {
          counts[index] += 1;
          if (counts[index] === 1) {
            assert.equal(
              binding.accountId,
              index === 0 ? winner.accountId : loser.accountId,
              'the unchanged weighted draw must propose opposite original accounts',
            );
            await proposals.arrive();
            if (index === 0) {
              const decision = await inner.bind(binding);
              assert.deepEqual(decision, { decision: 'allow' });
              firstCommitted.release();
              return decision;
            }
            await firstCommitted.promise;
            const before = await affinityRows(migrator, fixture);
            const decision = await inner.bind(binding);
            assert.deepEqual(decision, {
              decision: 'block',
              reason: 'provider account affinity binding conflict',
              contention: { kind: 'active_binding', accountId: winner.accountId },
            });
            assert.deepEqual(
              await affinityRows(migrator, fixture),
              before,
              'initial losing bind must not change aliases, TTL, revision, fence, or timestamps',
            );
            loserSnapshotProved = true;
            return decision;
          }
          assert.equal(index, 1);
          assert.equal(counts[index], 2, 'reconciliation has only one final bind');
          assert.ok(loserSnapshotProved);
          assert.equal(binding.accountId, winner.accountId);
          return inner.bind(binding);
        },
      }),
    );
    const requestA = requestForIndex(input, 0);
    const requestB = requestForIndex(input, 1);
    assert.notEqual(requestA, requestB);
    const requests = [
      { ...input, requestId: requestA },
      { ...input, requestId: requestB },
    ];
    const schedulers = [
      scheduler(observeDatabase(gateway, present(reads[0])), present(ports[0])),
      scheduler(observeDatabase(otherGateway, present(reads[1])), present(ports[1])),
    ];
    const decisions = await Promise.all(
      schedulers.map((current, index) =>
        current.selectAndBind(present(requests[index])).then((decision) => {
          if (decision.decision !== 'allow') {
            const failure = new Error('fixture peer selection failed closed');
            resolves.fail(failure);
            proposals.fail(failure);
            firstCommitted.fail(failure);
          }
          return decision;
        }),
      ),
    );
    assert.equal(resolves.arrivals, 2, 'there is no extra affinity resolve during reconciliation');
    assert.equal(proposals.arrivals, 2);
    assert.deepEqual(counts, [1, 2]);
    assert.ok(loserSnapshotProved);
    for (const decision of decisions) {
      assert.equal(decision.decision, 'allow');
      if (decision.decision === 'allow') {
        assert.strictEqual(decision.value, winner, 'final selection is the original authorized winner object');
        assert.ok(candidates.includes(decision.value));
      }
    }
    assert.deepEqual(present(reads[0]).get(winner.accountId), { eligibility: 1, health: 1, concurrency: 1 });
    assert.deepEqual(present(reads[0]).get(loser.accountId), { eligibility: 1, health: 1, concurrency: 1 });
    assert.deepEqual(present(reads[1]).get(winner.accountId), { eligibility: 2, health: 2, concurrency: 2 });
    assert.deepEqual(present(reads[1]).get(loser.accountId), { eligibility: 1, health: 1, concurrency: 1 });
    const finalRows = await affinityRows(migrator, fixture);
    assert.deepEqual(
      finalRows.map(({ reference_kind }) => reference_kind),
      ['response', 'session'],
    );
    assert.ok(
      finalRows.every(
        (row) =>
          row.account_id === winner.accountId &&
          row.state === 'active' &&
          row.revision === (afterStaleClear ? '4' : '2') &&
          row.fencing_token === row.revision,
      ),
    );
    assert.equal(slots.acquisitions, 5, 'two initial account checks per request plus one winner revalidation');
    assert.equal(slots.held.size, 2);
    assert.deepEqual(
      [...slots.held.values()]
        .map(({ accountId, requestId }) => ({ accountId, requestId }))
        .sort((a, b) => a.requestId.localeCompare(b.requestId)),
      [requestA, requestB].sort().map((requestId) => ({ accountId: winner.accountId, requestId })),
    );
    assert.deepEqual(
      [...slots.released].sort(),
      [requestA, requestB]
        .map((requestId) => slots.key({ ownerScopeKey: 'platform', accountId: loser.accountId, requestId }))
        .sort(),
    );
    assert.deepEqual(
      await financialSnapshot(migrator, fixture),
      beforeFunds,
      'selection/binding must leave every fixture financial and request row untouched',
    );
  } catch (error) {
    failure = safeFailure(error);
  } finally {
    const cleanup = await Promise.allSettled([
      ...temporaryLeases.map((lease) => lease.release()),
      ...[...slots.held.values()].map((identity) => slots.slots.release(identity)),
    ]);
    const closed = await Promise.allSettled(databases.map((database) => database.close()));
    if (
      cleanup.some(({ status }) => status === 'rejected') ||
      closed.some(({ status }) => status === 'rejected') ||
      slots.held.size !== 0
    ) {
      failure = new Error(
        failure === undefined
          ? 'Affinity bind race PostgreSQL component cleanup failed; details redacted'
          : `${failure.message}; component cleanup also failed`,
      );
    }
  }
  if (failure !== undefined) throw failure;
}

interface CapacityReadCounts extends ReadCounts {
  inFlight: string[];
}

/** Observe the real capacity transitions without replacing any PG result. */
function observeCapacityDatabase(database: SaasDatabase, observations: Map<string, CapacityReadCounts>): SaasDatabase {
  const note = (sql: string, values: readonly unknown[] | undefined, result: SqlResult<unknown>) => {
    let kind: keyof ReadCounts | undefined;
    let account: unknown;
    if (sql.includes('postgres-provider-account-scheduler:platform-eligibility')) {
      kind = 'eligibility';
      account = values?.[3];
      assert.equal(result.rows.length, 1, 'capacity must not waive the real platform authority');
    } else if (sql.includes('postgres-provider-account-scheduler:concurrency')) {
      kind = 'concurrency';
      account = values?.[2];
      assert.equal(result.rows.length, 1);
      const count = (result.rows[0] as { in_flight?: unknown }).in_flight;
      assert.ok(typeof count === 'string' && /^(0|[1-9][0-9]*)$/.test(count));
      assert.ok(typeof account === 'string' && observations.has(account));
      present(observations.get(account)).inFlight.push(count);
    } else if (
      /SELECT state, observed_at, cooldown_until/.test(sql) &&
      sql.includes('saas_provider_account_runtime_health')
    ) {
      kind = 'health';
      account = values?.[1];
      assert.equal(result.rows.length, 1);
      assert.equal((result.rows[0] as { state?: unknown }).state, 'healthy');
    }
    if (kind !== undefined) {
      assert.ok(typeof account === 'string' && observations.has(account), 'read must address an original candidate');
      present(observations.get(account))[kind] += 1;
    }
  };
  const executor = (inner: SqlExecutor): SqlExecutor => {
    const wrapped: SqlExecutor = {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const result = await inner.query<Row>(sql, values);
        note(sql, values, result);
        return result;
      },
    };
    if (inner.queryPrepared !== undefined) {
      const prepared = inner.queryPrepared.bind(inner);
      wrapped.queryPrepared = async <Row>(statement: PreparedSqlStatement, values?: readonly unknown[]) => {
        const result = await prepared<Row>(statement, values);
        note(statement.text, values, result);
        return result;
      };
    }
    return wrapped;
  };
  const verifyUnknownOutcomeSchema = database.verifyUnknownOutcomeSchema?.bind(database);
  return {
    ...executor(database),
    transaction: (work) => database.transaction((tx) => work(executor(tx))),
    migrate: () => database.migrate(),
    verifySchema: () => database.verifySchema(),
    ...(verifyUnknownOutcomeSchema === undefined ? {} : { verifyUnknownOutcomeSchema }),
    ping: () => database.ping(),
    close: () => database.close(),
  };
}

type CapacityBoundary = 'binding_changed' | 'winner_busy' | 'initial_busy';

async function runCapacityBoundary(boundary: CapacityBoundary) {
  const databases: SaasDatabase[] = [];
  const temporaryLeases: Array<{ release(): Promise<void> }> = [];
  const slots = slotBookkeeping();
  let failure: Error | undefined;
  try {
    const connections = await cancellationDatabases();
    databases.push(...connections.databases);
    const { migrator, gateway } = connections;
    const gatewayPid = present((await gateway.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]).pid;
    const pids = new Set([gatewayPid]);
    const peers: SaasDatabase[] = [];
    for (let actor = 0; actor < 2; actor += 1) {
      const peer = createSaasDatabase({
        connectionString: text(process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL?.trim()),
        max: 1,
      });
      databases.push(peer);
      peers.push(peer);
      const identity = present(
        (
          await peer.query<{ pid: number; role: string; session: string; superuser: boolean }>(
            `SELECT pg_backend_pid() AS pid, current_user AS role, session_user AS session,
                r.rolsuper AS superuser FROM pg_roles r WHERE rolname = current_user`,
          )
        ).rows[0],
      );
      assert.equal(identity.role, 'model_router_saas_gateway');
      assert.equal(identity.session, 'model_router_saas_gateway');
      assert.equal(identity.superuser, false);
      assert.equal(pids.has(identity.pid), false, 'all three actors require independent restricted PG connections');
      pids.add(identity.pid);
      await verifySaasRuntimeDatabasePrivileges(peer, 'gateway');
    }
    const peerB = present(peers[0]);
    const peerC = present(peers[1]);
    const fixture = await seedFixture(migrator, gateway, 'platform');
    const pool = await alignPlatformPool(migrator, fixture);
    const initial = await schedulerInput(gateway, fixture, pool);
    const second = await secondCandidate(migrator, pool, present(initial.candidates[0]));
    const candidates = [present(initial.candidates[0]), second].sort((left, right) =>
      left.accountId.localeCompare(right.accountId),
    );
    const input = { ...initial, candidates };
    const winnerP = present(candidates[0]);
    const winnerQ = present(candidates[1]);
    for (const candidate of candidates) {
      const health = await migrator.query(
        `INSERT INTO saas_provider_account_runtime_health
           (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
            observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
         VALUES ('platform', 'platform', NULL, $1, 'healthy', 0, clock_timestamp(), NULL, 'gateway_success', 1, 1)`,
        [candidate.accountId],
      );
      assert.equal(health.rowCount, 1);
    }
    assert.deepEqual(await affinityRows(migrator, fixture), []);
    const beforeFunds = await financialSnapshot(migrator, fixture);
    const affinity = (database: SaasDatabase) =>
      new PostgresProviderAccountAffinity({
        database,
        keys: [{ version: 'fixture-v1', key: Buffer.alloc(32, 0x6d) }],
        activeKeyVersion: 'fixture-v1',
      });
    const affinityA = affinity(gateway);
    const affinityB = affinity(peerB);
    const affinityC = affinity(peerC);
    const publicScheduler = (database: SaasDatabase, port: ProviderAccountSchedulerAffinityPort, withSlots = false) =>
      new PostgresProviderAccountScheduler({
        database,
        affinity: port,
        leaseConcurrencyLimit: LEASE_CONCURRENCY,
        health: new PostgresProviderAccountRuntimeHealthStore({ database, maxHealthAgeMs: MAX_HEALTH_AGE_MS }),
        maxHealthAgeMs: MAX_HEALTH_AGE_MS,
        ...(withSlots
          ? { redisConcurrencySlots: { enabled: true, slots: slots.slots, maxSlots: LEASE_CONCURRENCY } }
          : {}),
      });
    const leaseService = new PostgresProviderAccountLeaseService({
      database: peerC,
      maxConcurrency: LEASE_CONCURRENCY,
      leaseTtlMs: 30_000,
    });
    const fillCapacity = async (candidate: RequestPreparationCandidateAuthority) => {
      for (let slot = 0; slot < LEASE_CONCURRENCY; slot += 1) {
        const lease = await leaseService.acquire(leasePortInput(fixture, candidate));
        assert.ok(lease, 'capacity transition must acquire actual restricted-role PG leases');
        temporaryLeases.push(lease);
      }
      assert.deepEqual(
        (
          await gateway.query<{ in_flight: string }>(
            `SELECT count(*)::text AS in_flight FROM saas_provider_account_leases
          WHERE owner_kind = 'platform' AND owner_tenant_id IS NULL AND account_id = $1
            AND status = 'held' AND lease_expires_at > clock_timestamp()`,
            [candidate.accountId],
          )
        ).rows,
        [{ in_flight: String(LEASE_CONCURRENCY) }],
      );
    };
    const releaseCapacity = async () => {
      while (temporaryLeases.length > 0) {
        await present(temporaryLeases[0]).release();
        temporaryLeases.shift();
      }
    };
    const reads = new Map(
      candidates.map(({ accountId }) => [
        accountId,
        {
          eligibility: 0,
          health: 0,
          concurrency: 0,
          inFlight: [] as string[],
        },
      ]),
    );
    const counts = { resolveA: 0, bindA: 0, resolveB: 0, bindB: 0, resolveC: 0, bindC: 0 };
    let firstLoserUnchanged = false;
    let secondLoserUnchanged = false;
    let currentBinding: AffinitySnapshotRow[] = [];
    const initialWinner = publicScheduler(peerB, {
      async resolve(authority) {
        counts.resolveB += 1;
        const result = await affinityB.resolve(authority);
        assert.deepEqual(result, { decision: 'allow', accountId: null });
        return result;
      },
      async bind(binding) {
        counts.bindB += 1;
        assert.equal(counts.bindB, 1);
        assert.equal(binding.accountId, winnerP.accountId);
        const result = await affinityB.bind(binding);
        assert.deepEqual(result, { decision: 'allow' });
        return result;
      },
    });
    const nextWinner = publicScheduler(peerC, {
      async resolve(authority) {
        counts.resolveC += 1;
        assert.equal(counts.resolveC, 1);
        assert.deepEqual(authority.eligibleAccountIds, [winnerQ.accountId], 'real full PG capacity must exclude P');
        const result = await affinityC.resolve(authority);
        assert.deepEqual(result, { decision: 'stale' });
        const invalidated = await affinityRows(migrator, fixture);
        assert.equal(invalidated.length, 2);
        assert.ok(
          invalidated.every(
            (row, index) =>
              row.state === 'invalidated' &&
              row.revision === '2' &&
              row.fencing_token === '2' &&
              row.expires_at === currentBinding[index]?.expires_at,
          ),
        );
        return result;
      },
      async bind(binding) {
        counts.bindC += 1;
        assert.equal(counts.bindC, 1);
        assert.equal(binding.accountId, winnerQ.accountId);
        const result = await affinityC.bind(binding);
        assert.deepEqual(result, { decision: 'allow' });
        return result;
      },
    });
    const bound = publicScheduler(
      observeCapacityDatabase(gateway, reads),
      {
        async resolve(authority) {
          counts.resolveA += 1;
          assert.equal(counts.resolveA, 1, 'bounded reconciliation must never resolve again');
          const result = await affinityA.resolve(authority);
          assert.deepEqual(result, { decision: 'allow', accountId: null });
          // A's real resolve transaction has committed before B's ordinary
          // selection creates P. Return the same committed empty observation.
          const selected = await initialWinner.selectAndBind({ ...input, requestId: requestForIndex(input, 0) });
          assert.equal(selected.decision, 'allow');
          if (selected.decision === 'allow') assert.strictEqual(selected.value, winnerP);
          currentBinding = await affinityRows(migrator, fixture);
          assert.equal(currentBinding.length, 2);
          assert.ok(
            currentBinding.every(
              (row) =>
                row.account_id === winnerP.accountId &&
                row.state === 'active' &&
                row.revision === '1' &&
                row.fencing_token === '1',
            ),
          );
          return result;
        },
        async bind(binding) {
          counts.bindA += 1;
          assert.ok(counts.bindA <= 2, 'there is no third bind, retry, or contention loop');
          assert.equal(binding.accountId, counts.bindA === 1 ? winnerQ.accountId : winnerP.accountId);
          assert.deepEqual(binding.scope, affinityScope(input));
          const before = await affinityRows(migrator, fixture);
          const result = await affinityA.bind(binding);
          assert.deepEqual(result, {
            decision: 'block',
            reason: 'provider account affinity binding conflict',
            contention: {
              kind: 'active_binding',
              accountId: counts.bindA === 1 ? winnerP.accountId : winnerQ.accountId,
            },
          });
          assert.deepEqual(
            await affinityRows(migrator, fixture),
            before,
            'a losing bind leaves all aliases, full timestamps, TTL, revision, and fence unchanged',
          );
          if (counts.bindA === 1) {
            firstLoserUnchanged = true;
            // This interleaving happens after PG returned P's typed hint but
            // before A receives it and begins the fresh P authority checks.
            await fillCapacity(winnerP);
            if (boundary === 'binding_changed') {
              const changed = await nextWinner.selectAndBind({ ...input, requestId: requestForIndex(input, 1) });
              assert.equal(changed.decision, 'allow');
              if (changed.decision === 'allow') assert.strictEqual(changed.value, winnerQ);
              currentBinding = await affinityRows(migrator, fixture);
              assert.ok(
                currentBinding.every(
                  (row) =>
                    row.account_id === winnerQ.accountId &&
                    row.state === 'active' &&
                    row.revision === '3' &&
                    row.fencing_token === '3',
                ),
              );
              await releaseCapacity();
            }
          } else {
            assert.equal(boundary, 'binding_changed');
            secondLoserUnchanged = true;
          }
          return result;
        },
      },
      true,
    );
    if (boundary === 'initial_busy') {
      await fillCapacity(winnerP);
      await fillCapacity(winnerQ);
    }
    const requestId = requestForIndex(input, 1);
    const decision = await bound.selectAndBind({ ...input, requestId });
    assert.equal(decision.decision, 'reject');
    if (decision.decision === 'reject') assert.equal(decision.code, 'rate_limited');
    const expectedChecks = boundary === 'initial_busy' ? 1 : 2;
    assert.deepEqual(reads.get(winnerP.accountId), {
      eligibility: expectedChecks,
      health: expectedChecks,
      concurrency: expectedChecks,
      inFlight: boundary === 'binding_changed' ? ['0', '0'] : boundary === 'winner_busy' ? ['0', '2'] : ['2'],
    });
    assert.deepEqual(reads.get(winnerQ.accountId), {
      eligibility: 1,
      health: 1,
      concurrency: 1,
      inFlight: [boundary === 'initial_busy' ? '2' : '0'],
    });
    if (boundary === 'initial_busy') {
      assert.deepEqual(counts, { resolveA: 0, bindA: 0, resolveB: 0, bindB: 0, resolveC: 0, bindC: 0 });
      assert.deepEqual(await affinityRows(migrator, fixture), []);
    } else {
      assert.deepEqual(counts, {
        resolveA: 1,
        bindA: boundary === 'binding_changed' ? 2 : 1,
        resolveB: 1,
        bindB: 1,
        resolveC: boundary === 'binding_changed' ? 1 : 0,
        bindC: boundary === 'binding_changed' ? 1 : 0,
      });
      assert.ok(firstLoserUnchanged);
      assert.equal(secondLoserUnchanged, boundary === 'binding_changed');
      assert.deepEqual(
        await affinityRows(migrator, fixture),
        currentBinding,
        'capacity rejection or terminal second contention must preserve the final durable binding',
      );
      assert.ok(candidates.includes(winnerP) && candidates.includes(winnerQ));
      assert.equal(input.scheduling?.attemptedAccountIds?.includes(winnerQ.accountId) ?? false, false);
    }
    assert.equal(slots.acquisitions, boundary === 'initial_busy' ? 2 : 3);
    assert.equal(slots.held.size, 0, 'a pre-admission rate limit must release every temporary Redis slot double');
    assert.deepEqual(
      [...slots.released].sort(),
      candidates.map(({ accountId }) => slots.key({ ownerScopeKey: 'platform', accountId, requestId })).sort(),
    );
    assert.deepEqual(
      await financialSnapshot(migrator, fixture),
      beforeFunds,
      'terminal contention and capacity checks must not create or mutate fixture financial/request rows',
    );
    await releaseCapacity();
    assert.deepEqual(
      (
        await gateway.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM saas_provider_account_leases WHERE owner_kind = 'platform' AND account_id = ANY($1::text[]) AND status = 'held' AND lease_expires_at > clock_timestamp()",
          [candidates.map(({ accountId }) => accountId)],
        )
      ).rows,
      [{ count: '0' }],
    );
  } catch (error) {
    failure = safeFailure(error);
  } finally {
    const cleanup = await Promise.allSettled([
      ...temporaryLeases.map((lease) => lease.release()),
      ...[...slots.held.values()].map((identity) => slots.slots.release(identity)),
    ]);
    const closed = await Promise.allSettled(databases.map((database) => database.close()));
    if (
      cleanup.some(({ status }) => status === 'rejected') ||
      closed.some(({ status }) => status === 'rejected') ||
      slots.held.size !== 0
    ) {
      failure = new Error(
        failure === undefined
          ? 'Affinity capacity boundary PostgreSQL component cleanup failed; details redacted'
          : `${failure.message}; component cleanup also failed`,
      );
    }
  }
  if (failure !== undefined) throw failure;
}

const options = {
  skip:
    process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
      ? `set ${CANCELLATION_PG_REQUIRED}=1 and all three designated disposable role URLs`
      : false,
  timeout: 300_000,
};

test('restricted PostgreSQL combined affinity binding reconciles two committed empty affinity reads', options, () =>
  runRace(false),
);
test('restricted PostgreSQL combined affinity binding reconciles after real capacity-driven stale clear', options, () =>
  runRace(true),
);
test('restricted PostgreSQL terminal second affinity contention is rate limited without a third bind', options, () =>
  runCapacityBoundary('binding_changed'),
);
test('restricted PostgreSQL fresh affinity winner capacity is rate limited without a second bind', options, () =>
  runCapacityBoundary('winner_busy'),
);
test('restricted PostgreSQL initially full candidate capacity is rate limited without any bind', options, () =>
  runCapacityBoundary('initial_busy'),
);
