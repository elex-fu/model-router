import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../../../src/saas/db/credential-validation-worker-privileges.js';
import { verifyCredentialValidationWorkerSchemaReadiness } from '../../../src/saas/db/credential-validation-worker-schema-readiness.js';
import {
  CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS,
  CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
} from '../../../src/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/runtime-privileges.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import type { ProviderCredentialValidationResult } from '../../../src/saas/supply/credential-validation-adapters.js';
import { compileApprovedCredentialValidationTargets } from '../../../src/saas/supply/credential-validation-targets.js';
import {
  CredentialValidationWorkerError, PostgresCredentialValidationWorkerStore, type CredentialValidationLease,
} from '../../../src/saas/supply/credential-validation-worker.js';
import { PostgresProviderSupplyRepository, type ProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import {
  INVALIDATION_AUDIT_ENTRY_POINT, InvalidationFixtureKms, invalidationCatalog, invalidationDatabase,
  invalidationEnvelope, invalidationJobs, invalidationSnapshot, invalidationStoreOptions, seedInvalidationFixture,
  type InvalidationFixture, type InvalidationJobRow,
} from './credential-validation-invalidation-pg-fixture.js';

// Separate FOUR-role gate. The deployment owner installs current migrations and
// both normal role templates BEFORE this root. No bootstrap, migration, role,
// grant, schema fault/reset or migrator-executed business operation occurs here.
// The public store is the real persistence path. Probe results and KMS/targets
// are synthetic; this is not a provider-network/credential-validation claim.
// There is NO public lease-renew method: recheck is authority verification, not
// renewal. Do not replace this missing interface with hand-written CAS SQL.
const REQUIRED = 'MODEL_ROUTER_SAAS_VALIDATION_E2E_REQUIRED';
const CONFIG = [
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
  ['MODEL_ROUTER_SAAS_VALIDATION_E2E_WORKER_URL', 'model_router_saas_validation_worker'],
] as const;
const configured = CONFIG.map(([name]) => process.env[name]?.trim());

function roleUrls(): [string, string, string, string] {
  let sameTarget: string | undefined;
  const values = CONFIG.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required; a partially configured four-role gate cannot skip`);
    let parsed: URL; let user: string; let database: string;
    try {
      parsed = new URL(value); user = decodeURIComponent(parsed.username); database = decodeURIComponent(parsed.pathname.slice(1));
    } catch { throw new Error(`${name}: invalid PostgreSQL role URL (redacted)`); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol) && user === role,
      `${name}: exact PostgreSQL workload identity required`);
    assert.ok(parsed.search === '' && parsed.hash === '', `${name}: connection overrides/fragments forbidden`);
    const host = parsed.hostname.toLowerCase(); const port = Number(parsed.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && parsed.port !== '' &&
      Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432, 53782].includes(port) &&
      (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name}: explicit disposable CI/nondefault loopback target required`);
    const target = `${host}:${port}/${database}`;
    sameTarget ??= target;
    assert.ok(target === sameTarget, 'all four roles must address the same disposable database');
    return value;
  });
  assert.ok(values[0] && values[1] && values[2] && values[3]);
  return [values[0], values[1], values[2], values[3]];
}

function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
function redactedFailure(stage: string, error: unknown): Error {
  // Never forward driver messages/details/SQL arguments/cause/raw stack. A
  // worker STORE_UNAVAILABLE has discarded its cause; no SQLSTATE is invented.
  const code = sqlState(error) ?? (error instanceof CredentialValidationWorkerError ? error.code : 'NO_SQLSTATE');
  return new Error(`credential_invalidation/${stage}: ${code} (details redacted)`);
}
async function child(t: TestContext, name: string, work: () => Promise<void>): Promise<void> {
  await t.test(name, { timeout: 40_000 }, async () => {
    try { await work(); } catch (error) { throw redactedFailure(name, error); }
  });
}
function same(actual: unknown, expected: unknown, message: string): void {
  assert.ok(JSON.stringify(actual) === JSON.stringify(expected), message);
}
async function denied(work: () => Promise<unknown>, label: string): Promise<void> {
  let rejected = false;
  try { await work(); } catch (error) {
    rejected = true;
    assert.ok(sqlState(error) === '42501', `${label}: only actual permission-denied SQLSTATE is accepted`);
  }
  assert.ok(rejected, `${label}: direct operation must be denied`);
}
async function lost(work: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await work(); } catch (error) {
    rejected = true;
    assert.ok(error instanceof CredentialValidationWorkerError && error.code === 'LEASE_LOST', 'actual store must reject the stale authority');
  }
  assert.ok(rejected, 'stale authority must not reach the callback/provider boundary');
}
async function identity(database: SaasDatabase, role: string, databaseName: string): Promise<void> {
  const rows = (await database.query<{ role: string; session: string; database: string; safe: boolean }>(`SELECT
    current_user::text AS role,session_user::text AS session,current_database() AS database,
    NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolbypassrls AND NOT r.rolcreatedb
      AND NOT r.rolcreaterole AND NOT r.rolreplication AND r.rolcanlogin
      AND current_setting('search_path')='model_router_saas'
      AND current_schemas(true)=ARRAY['pg_catalog','model_router_saas']::name[]
      AND current_setting('server_version_num')::integer >= 150000
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`)).rows;
  assert.ok(rows.length === 1 && rows[0]?.role === role && rows[0]?.session === role &&
    rows[0]?.database === databaseName && rows[0]?.safe === true, 'exact unchanged non-superuser session/default-schema identity required');
}
async function eligibleQueueEmpty(reader: SqlExecutor): Promise<void> {
  const row = (await reader.query<{ empty: boolean }>(`SELECT NOT EXISTS(SELECT 1
    FROM saas_tenant_provider_credential_validation_jobs
    WHERE (status='queued' AND available_at <= clock_timestamp())
      OR (status='leased' AND lease_until <= clock_timestamp())) AS empty`)).rows[0];
  assert.ok(row?.empty === true, 'exclusive fixture queue required: do not claim any other actor\'s eligible job');
}
function job(rows: readonly InvalidationJobRow[], id: string): InvalidationJobRow {
  const matches = rows.filter((row) => row.id === id);
  assert.ok(matches.length === 1, 'fixture job identity must be unique and present');
  return matches[0]!;
}
function stableJobAuthority(row: InvalidationJobRow): unknown {
  const { status: _status, lease_until: _lease, lease_generation: _generation,
    last_error_code: _error, completed_at: _completed, updated_at: _updated, ...stable } = row;
  return stable;
}
type Snapshot = Awaited<ReturnType<typeof invalidationSnapshot>>;
type Action = 'account-disable' | 'account-revoke' | 'credential-disable' | 'credential-revoke' | 'credential-rotate';
const VERIFIED: ProviderCredentialValidationResult = { state: 'verified', adapterId: 'synthetic-cvi-fixture', httpStatus: 200, durationMs: 0 };
const FAILED: ProviderCredentialValidationResult = { state: 'failed', errorCode: 'credential_rejected', retryable: false,
  adapterId: 'synthetic-cvi-fixture', httpStatus: 401, durationMs: 0 };

async function claimed(migrator: SaasDatabase, store: PostgresCredentialValidationWorkerStore, f: InvalidationFixture) {
  const before = await invalidationSnapshot(migrator, f);
  const lease = await store.claimNext();
  assert.ok(lease && lease.job.id === f.jobId, 'actual dedicated worker must claim precisely this fixture job');
  const after = await invalidationSnapshot(migrator, f);
  const old = job(before.jobs, f.jobId); const live = job(after.jobs, f.jobId);
  assert.ok(live.status === 'leased' && live.lease_until !== null &&
    live.attempt_count === old.attempt_count + 1 && BigInt(live.lease_generation) === BigInt(old.lease_generation) + 1n &&
    lease.fencingToken === Number(live.lease_generation), 'genuine worker lease must increment generation and cumulative attempt exactly once');
  same(before.outcomes, after.outcomes, 'claim cannot change any authority/health/capability/audit outcome');
  same(before.jobs.filter((row) => row.id !== f.jobId), after.jobs.filter((row) => row.id !== f.jobId), 'claim cannot touch another job');
  await store.recheckBeforeProviderRequest(lease);
  same(await invalidationSnapshot(migrator, f), after, 'live authority recheck cannot extend the lease or mutate any fact');
  return { lease, before: after };
}
async function audit(repository: ProviderSupplyRepository, f: InvalidationFixture, action: Action): Promise<void> {
  assert.ok(repository.appendAuditEvent, 'real CP repository audit port required');
  await repository.appendAuditEvent({ tenantId: f.tenants[0], action: `fixture.${action}`,
    targetType: action.startsWith('account-') ? 'provider-account' : 'provider-credential',
    targetId: action.startsWith('account-') ? f.accounts[0] : f.credentials[0], occurredAt: new Date().toISOString(),
    audit: { actorUserId: f.actorId, entryPoint: INVALIDATION_AUDIT_ENTRY_POINT, requestId: f.auditRequestId } });
}
async function change(repository: ProviderSupplyRepository, f: InvalidationFixture, action: Action, kms: InvalidationFixtureKms): Promise<void> {
  const reference = { ownerKind: 'tenant' as const, tenantId: f.tenants[0], accountId: f.accounts[0], credentialId: f.credentials[0] };
  const now = new Date().toISOString();
  if (action.startsWith('account-')) {
    const current = await repository.getAccount(reference);
    assert.ok(current, 'actual CP must read its fixture account');
    const revoked = action === 'account-revoke';
    const updated = await repository.updateAccountLifecycle({ account: reference, status: revoked ? 'revoked' : 'disabled',
      expectedAuthzVersion: current.authzVersion, updatedAt: now, disabledAt: revoked ? null : now, revokedAt: revoked ? now : null });
    assert.ok(updated && updated.authzVersion === current.authzVersion + 1 && updated.status === (revoked ? 'revoked' : 'disabled'),
      'actual CP account CAS must succeed under its existing manifest');
  } else if (action === 'credential-rotate') {
    const current = await repository.getCredential(reference);
    assert.ok(current?.currentVersion === 2, 'actual CP rotation must start at the fixture head');
    const envelope = await invalidationEnvelope(kms, f, f.tenants[0], f.accounts[0], f.credentials[0], 3);
    const updated = await repository.appendCredentialVersion({ credential: { ...reference, version: 3 },
      providerId: f.target.providerId, productId: f.target.productId, envelope, kmsPurpose: 'inference',
      wrappingRevision: 1, expectedCurrentVersion: current.currentVersion, createdAt: now, expiresAt: null });
    assert.ok(updated.credential.currentVersion === 3 && updated.version.version === 3 &&
      updated.credential.authzVersion === current.authzVersion + 1, 'actual CP rotation CAS must publish exactly the new head');
    // CP current_version/expires_at UPDATE already exists in source and the
    // reviewed through058 catalog. This test never adds/reconciles those grants.
  } else {
    const current = await repository.getCredential(reference);
    assert.ok(current, 'actual CP must read its fixture credential');
    const revoked = action === 'credential-revoke';
    const updated = await repository.updateCredentialLifecycle({ credential: reference, status: revoked ? 'revoked' : 'disabled',
      expectedAuthzVersion: current.authzVersion, updatedAt: now, disabledAt: revoked ? null : now, revokedAt: revoked ? now : null });
    assert.ok(updated && updated.authzVersion === current.authzVersion + 1 && updated.status === (revoked ? 'revoked' : 'disabled'),
      'actual CP credential CAS must succeed with the unmodified default int8 driver parser');
  }
  await audit(repository, f, action);
}
async function cancellation(reader: SqlExecutor, f: InvalidationFixture, action: Action, before: Snapshot): Promise<Snapshot> {
  const after = await invalidationSnapshot(reader, f);
  const changedIds = action.startsWith('account-') ? [f.jobId, f.sameAccountJobId] : [f.jobId];
  for (const id of changedIds) {
    const old = job(before.jobs, id); const cancelled = job(after.jobs, id);
    assert.ok(cancelled.status === 'cancelled' && cancelled.lease_until === null && cancelled.completed_at !== null &&
      cancelled.last_error_code === (action.startsWith('account-') ? 'account_changed' : 'credential_changed') &&
      BigInt(cancelled.lease_generation) === BigInt(old.lease_generation) + 1n &&
      cancelled.attempt_count === old.attempt_count, '058 must cancel leased/queued jobs once without resetting cumulative attempts');
    same(stableJobAuthority(cancelled), stableJobAuthority(old), '058 may not mutate immutable job authority or availability/history');
    assert.ok((await reader.query<{ valid: boolean }>(`SELECT completed_at >= created_at AND updated_at >= created_at
      AND completed_at <= clock_timestamp() AND updated_at <= clock_timestamp() AS valid
      FROM saas_tenant_provider_credential_validation_jobs WHERE id=$1::uuid`, [id])).rows[0]?.valid === true,
    'invalidation timestamps must be database-clock facts');
  }
  same(after.jobs.filter((row) => !changedIds.includes(row.id)), before.jobs.filter((row) => !changedIds.includes(row.id)),
    'completed history, another account, another tenant with the same IDs and unrelated sibling jobs remain intact');
  const targetAccount = (row: Record<string, unknown>) => row.tenant_id === f.tenants[0] && row.id === f.accounts[0];
  const targetCredential = (row: Record<string, unknown>) => row.tenant_id === f.tenants[0] && row.id === f.credentials[0];
  const targetVersion = (row: Record<string, unknown>) => row.tenant_id === f.tenants[0] && row.credential_id === f.credentials[0] && row.version !== 1;
  same(after.outcomes.accounts.filter((row) => !action.startsWith('account-') || !targetAccount(row)),
    before.outcomes.accounts.filter((row) => !action.startsWith('account-') || !targetAccount(row)), 'CP credential changes must not change accounts or cross tenant/account boundaries');
  same(after.outcomes.credentials.filter((row) => action.startsWith('account-') || !targetCredential(row)),
    before.outcomes.credentials.filter((row) => action.startsWith('account-') || !targetCredential(row)), 'CP account changes must not change credential outcomes or unrelated credentials');
  const versionsChange = action === 'credential-rotate' || action === 'credential-revoke';
  same(after.outcomes.versions.filter((row) => !versionsChange || !targetVersion(row)),
    before.outcomes.versions.filter((row) => !versionsChange || !targetVersion(row)), 'retired v1 and unrelated immutable version history must remain intact');
  same(after.outcomes.capabilities, before.outcomes.capabilities, 'CP invalidation cannot alter approved capability evidence');
  same(after.outcomes.bindings, before.outcomes.bindings, 'CP invalidation cannot alter capability bindings');
  same(after.outcomes.rights, before.outcomes.rights, 'CP invalidation cannot rewrite commercial rights');
  assert.ok(after.outcomes.audit.length === before.outcomes.audit.length + 1, 'actual CP audit must share the invalidation transaction');
  return after;
}
async function staleProof(migrator: SaasDatabase, store: PostgresCredentialValidationWorkerStore, kms: InvalidationFixtureKms,
  f: InvalidationFixture, lease: CredentialValidationLease, afterCp: Snapshot): Promise<void> {
  const decrypts = kms.decryptCalls;
  assert.ok(await store.complete(lease, VERIFIED) === false, 'actual old-lease verified completion CAS must reject');
  assert.ok(await store.complete(lease, FAILED) === false, 'actual old-lease failed completion cannot overwrite health either');
  await lost(() => store.recheckBeforeProviderRequest(lease));
  let callback = false;
  await lost(() => store.withCredential(lease, () => { callback = true; }));
  assert.ok(!callback && kms.decryptCalls === decrypts, 'stale lease cannot load KMS/plaintext or reach the provider boundary');
  same(await invalidationSnapshot(migrator, f), afterCp,
    'late worker completion/recheck/unseal cannot change job generation/attempt history, health, authority, capabilities, rights or audit');
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function blocked(reader: SqlExecutor, workerPid: number, cpPid: number, completionDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  do {
    assert.ok(!completionDone(), 'old completion cannot finish while matching CP exclusive authority fence is held');
    const row = (await reader.query<{ blocked: boolean }>(`SELECT $2::integer=ANY(pg_blocking_pids($1::integer))
      AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::integer AND locktype='advisory' AND mode='ExclusiveLock' AND NOT granted) AS blocked`,
    [workerPid, cpPid])).rows[0];
    if (row?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail('actual matching advisory fence wait must be visible, not inferred from timing alone');
}

test('required current-schema four-role CP invalidation fences actual validation-worker lease completion', {
  timeout: 300_000,
  skip: process.env[REQUIRED] !== '1' && !configured.some(Boolean)
    ? `set ${REQUIRED}=1 and all four validation E2E role URLs` : false,
}, async (t) => {
  const urls = roleUrls();
  const databases: [SaasDatabase, SaasDatabase, SaasDatabase, SaasDatabase] = [
    invalidationDatabase(urls[0]), invalidationDatabase(urls[1]), invalidationDatabase(urls[2]), invalidationDatabase(urls[3]),
  ];
  const [migrator, control, gateway, worker] = databases;
  assert.ok(migrator && control && gateway && worker);
  const kms = new InvalidationFixtureKms();
  t.after(async () => { kms.close(); await Promise.allSettled(databases.map((database) => database.close())); });
  try {
    const databaseName = decodeURIComponent(new URL(urls[0]).pathname.slice(1));
    for (let index = 0; index < CONFIG.length; index += 1) await identity(databases[index]!, CONFIG[index]![1], databaseName);
    await migrator.verifySchema(); // READ ONLY: current central registry/checksums, not migrate().
    const migration = CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION;
    const ledger = (await migrator.query<{ name: string; checksum: string }>(
      'SELECT name,checksum FROM saas_schema_migrations WHERE version=$1', [migration.version])).rows;
    assert.ok(ledger.length === 1 && ledger[0]?.name === migration.name &&
      ledger[0]?.checksum === createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex'),
    'exact external 058 apply must precede this current-schema root');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifyCredentialValidationWorkerSchemaReadiness(worker);
    await verifyCredentialValidationWorkerRuntimePrivileges(worker);
    await denied(() => worker.query('SELECT version FROM saas_schema_migrations LIMIT 1'), 'worker migration-ledger read');
    assert.ok((await migrator.query<{ empty: boolean }>(`SELECT NOT EXISTS(SELECT 1
      FROM saas_tenant_provider_credential_validation_jobs WHERE status IN ('queued','leased')) AS empty`)).rows[0]?.empty === true,
    'use a dedicated current-schema database with an empty queue; never consume frozen worker/HTTP fixture jobs');
    const catalog = await invalidationCatalog(migrator);
    assert.ok(catalog !== undefined, 'read-only starting catalog snapshot required');

    async function fixture() {
      await eligibleQueueEmpty(migrator);
      const f = await seedInvalidationFixture(migrator, kms);
      const store = new PostgresCredentialValidationWorkerStore(worker, kms, {
        ...invalidationStoreOptions(), approvedTargets: compileApprovedCredentialValidationTargets([f.target]),
      });
      const claim = await claimed(migrator, store, f);
      return { f, store, ...claim };
    }
    await child(t, 'real worker positive control and direct ACL negatives', async () => {
      const { f, store, lease, before } = await fixture();
      for (const actor of [control, gateway, worker]) {
        for (const { signature } of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS) {
          await denied(() => actor.query(`SELECT model_router_saas.${signature}`), 'direct trigger wrapper/helper EXECUTE');
        }
      }
      for (const actor of [control, gateway]) await denied(() => actor.query(
        'UPDATE saas_tenant_provider_credential_validation_jobs SET status=status WHERE id=$1::uuid', [f.jobId]), 'CP/GW job UPDATE');
      await denied(() => worker.query('UPDATE saas_tenant_provider_credentials SET current_version=current_version WHERE tenant_id=$1::uuid AND id=$2',
        [f.tenants[0], f.credentials[0]]), 'worker credential-head UPDATE');
      await denied(() => worker.query('UPDATE saas_tenant_provider_credentials SET expires_at=expires_at WHERE tenant_id=$1::uuid AND id=$2',
        [f.tenants[0], f.credentials[0]]), 'worker credential-expiry UPDATE');
      await denied(() => worker.query('UPDATE saas_provider_capabilities SET validation_state=validation_state WHERE provider_id=$1 AND product_id=$2 AND model=$3',
        [f.target.providerId, f.target.productId, f.target.model]), 'worker catalog UPDATE');
      await denied(() => gateway.query('UPDATE saas_tenant_provider_accounts SET status=status WHERE tenant_id=$1::uuid AND id=$2',
        [f.tenants[0], f.accounts[0]]), 'gateway account UPDATE');
      await denied(() => gateway.query('UPDATE saas_api_keys SET status=status WHERE tenant_id=$1::uuid', [f.tenants[0]]), 'gateway API Key UPDATE');
      same(await invalidationSnapshot(migrator, f), before, 'all ACL negatives must be genuine no-effect operations');
      const decrypts = kms.decryptCalls;
      await store.withCredential(lease, (secret) => {
        assert.ok(secret.equals(Buffer.from('synthetic-invalidation-fixture-credential')), 'only fixture-generated plaintext reaches the actual worker callback');
      });
      assert.ok(kms.decryptCalls === decrypts + 1, 'live actual worker must pass fixture KMS unseal before positive completion');
      assert.ok(await store.complete(lease, VERIFIED) === true, 'real store completion must succeed before negative stale tests');
      const positive = await invalidationSnapshot(migrator, f);
      const finished = job(positive.jobs, f.jobId); const leased = job(before.jobs, f.jobId);
      assert.ok(finished.status === 'verified' && finished.lease_until === null && finished.attempt_count === leased.attempt_count &&
        BigInt(finished.lease_generation) === BigInt(leased.lease_generation) + 1n, 'positive actual completion has the real terminal CAS/generation shape');
      same(positive.jobs.filter((row) => row.id !== f.jobId), before.jobs.filter((row) => row.id !== f.jobId), 'positive completion cannot affect any other job');
      for (const rows of [positive.outcomes.accounts, positive.outcomes.credentials]) {
        const accounts = rows === positive.outcomes.accounts;
        const isTarget = (row: Record<string, unknown>) => row.tenant_id === f.tenants[0] && row.id === (accounts ? f.accounts[0] : f.credentials[0]);
        const target = rows.filter(isTarget);
        const old = (accounts ? before.outcomes.accounts : before.outcomes.credentials).filter(isTarget);
        const current = target[0]; const original = old[0];
        assert.ok(target.length === 1 && old.length === 1 && current && original &&
          current.status === 'active' && current.validation_state === 'verified', 'positive actual completion must publish real scoped health');
        const nextVersion = current.authz_version; const previousVersion = original.authz_version;
        assert.ok(typeof nextVersion === 'string' && typeof previousVersion === 'string', 'snapshot uses explicit SQL bigint text casts');
        assert.ok(BigInt(nextVersion) === BigInt(previousVersion) + 1n, 'positive actual completion must publish exactly one health version');
        same(rows.filter((row) => !isTarget(row)), (accounts ? before.outcomes.accounts : before.outcomes.credentials).filter((row) => !isTarget(row)),
          'positive actual completion must leave every unrelated tenant/account/credential outcome intact');
      }
      same(positive.outcomes.capabilities, before.outcomes.capabilities, 'worker completion cannot manufacture capability evidence');
      same(positive.outcomes.bindings, before.outcomes.bindings, 'worker completion cannot modify account capability binding');
      same(positive.outcomes.rights, before.outcomes.rights, 'worker completion cannot alter commercial rights');
      same(positive.outcomes.versions, before.outcomes.versions, 'worker completion cannot alter version lifecycle/history');
      same(positive.outcomes.audit, before.outcomes.audit, 'worker completion cannot insert CP audit effects');
      assert.ok(await store.complete(lease, VERIFIED) === false, 'completed lease cannot complete twice');
      same(await invalidationSnapshot(migrator, f), positive, 'duplicate positive completion cannot rewrite any terminal fact');
    });

    for (const action of ['account-disable', 'account-revoke', 'credential-disable', 'credential-revoke', 'credential-rotate'] as const) {
      await child(t, `${action}: CP invalidation rejects actual old worker completion`, async () => {
        const { f, store, lease, before } = await fixture();
        await new PostgresProviderSupplyRepository(control).transaction((repository) => change(repository, f, action, kms));
        const after = await cancellation(migrator, f, action, before);
        await staleProof(migrator, store, kms, f, lease, after);
      });
    }
    await child(t, 'account revoke then credential cascade cannot increment cancellation generation twice', async () => {
      const { f, store, lease, before } = await fixture();
      const repository = new PostgresProviderSupplyRepository(control);
      await repository.transaction((tx) => change(tx, f, 'account-revoke', kms));
      await cancellation(migrator, f, 'account-revoke', before);
      const cancelled = await invalidationJobs(migrator, f);
      await repository.transaction((tx) => change(tx, f, 'credential-revoke', kms));
      same(await invalidationJobs(migrator, f), cancelled, 'account cancellation followed by credential revocation cannot rewrite cancelled/terminal jobs');
      await staleProof(migrator, store, kms, f, lease, await invalidationSnapshot(migrator, f));
    });
    for (const action of ['account-revoke', 'credential-rotate'] as const) await child(t, `${action}: rollback restores audit/jobs/authority and the genuine old lease`, async () => {
      const { f, store, lease, before } = await fixture();
      const sentinel = new Error('fixture-controlled CP transaction rollback');
      let rolledBack = false;
      try {
        await control.transaction(async (executor) => {
          const repository = new PostgresProviderSupplyRepository(control, executor, true);
          await change(repository, f, action, kms);
          await cancellation(executor, f, action, before);
          throw sentinel;
        });
      } catch (error) {
        assert.ok(error === sentinel, 'only the original post-success CP rollback sentinel is accepted');
        rolledBack = true;
      }
      assert.ok(rolledBack, 'actual CP transaction must rollback');
      same(await invalidationSnapshot(migrator, f), before, 'rollback must atomically restore parent/head/version, every job and audit');
      await store.recheckBeforeProviderRequest(lease);
      assert.ok(await store.complete(lease, VERIFIED) === true, 'restored original authority/generation must allow the actual original worker lease completion');
      const after = await invalidationSnapshot(migrator, f);
      same(after.jobs.filter((row) => row.id !== f.jobId), before.jobs.filter((row) => row.id !== f.jobId), 'rollback retry cannot alter unrelated/terminal jobs');
      same(after.outcomes.capabilities, before.outcomes.capabilities, 'rollback retry cannot change capability evidence');
      same(after.outcomes.audit, before.outcomes.audit, 'rolled-back audit must remain absent after worker retry');
      assert.ok(await store.complete(lease, VERIFIED) === false, 'restored lease still completes at most once');
      same(await invalidationSnapshot(migrator, f), after, 'late duplicate retry cannot alter facts');
    });
    await child(t, 'matching CP exclusive fence blocks actual worker completion; post-wait retry is stale without effects', async () => {
      const { f, store, lease, before } = await fixture();
      const pid = (await worker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      assert.ok(typeof pid === 'number', 'one-connection actual worker backend required for lock observation');
      const entered = deferred<number>(); const release = deferred<void>();
      const cp = control.transaction(async (executor) => {
        const cpPid = (await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        assert.ok(typeof cpPid === 'number');
        await change(new PostgresProviderSupplyRepository(control, executor, true), f, 'account-revoke', kms);
        await cancellation(executor, f, 'account-revoke', before);
        entered.resolve(cpPid);
        await release.promise;
      });
      const cpOutcome = cp.then(() => ({ ok: true as const }), (error: unknown) => {
        entered.reject(error); return { ok: false as const, error };
      });
      let done = false;
      let completion: Promise<{ value: boolean; error?: never } | { value?: never; error: unknown }> | undefined;
      try {
        const cpPid = await entered.promise;
        completion = store.complete(lease, VERIFIED).then((value) => { done = true; return { value }; },
          (error: unknown) => { done = true; return { error }; });
        await blocked(migrator, pid, cpPid, () => done);
      } finally {
        release.resolve();
        const outcome = await cpOutcome;
        // Drain the real completion after releasing CP even if lock observation
        // failed. It has a session statement timeout and an attached rejection
        // handler; no child leaves a background business operation running.
        if (completion) await completion;
        if (!outcome.ok) throw outcome.error;
      }
      assert.ok(completion, 'actual worker completion must have been started');
      const result = await completion;
      assert.ok(result.value === false || (result.error instanceof CredentialValidationWorkerError && result.error.code === 'STORE_UNAVAILABLE'),
        'post-wait serializable completion may be stale or abort, but cannot succeed; masked SQLSTATE is not inferred');
      const after = await cancellation(migrator, f, 'account-revoke', before);
      await staleProof(migrator, store, kms, f, lease, after);
    });
    same(await invalidationCatalog(migrator), catalog, 'this root must not change schema, function metadata/body/ACL, tables/columns, constraints or triggers');
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await verifyCredentialValidationWorkerSchemaReadiness(worker);
    await verifyCredentialValidationWorkerRuntimePrivileges(worker);
  } catch (error) { throw redactedFailure('root_gate', error); }
});
