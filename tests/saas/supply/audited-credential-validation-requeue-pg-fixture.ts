import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { CredentialValidationRequeueActor, AuditedCredentialValidationRequeueCommand } from '../../../src/saas/supply/credential-validation-requeue-types.js';
import { credentialValidationJobSnapshotSha256, compileApprovedCredentialValidationTargets } from '../../../src/saas/supply/credential-validation-targets.js';
import { PostgresCredentialValidationWorkerStore, type CredentialValidationLease } from '../../../src/saas/supply/credential-validation-worker.js';
import type { ProviderCredentialValidationResult } from '../../../src/saas/supply/credential-validation-adapters.js';
import type { ProviderCredentialValidationJobRecord } from '../../../src/saas/supply/types.js';
import {
  InvalidationFixtureKms, invalidationCatalog, invalidationDatabase, invalidationJobs, invalidationSnapshot,
  invalidationStoreOptions, seedInvalidationFixture, type InvalidationFixture,
} from './credential-validation-invalidation-pg-fixture.js';

// Test-private reuse of the FROZEN real pg/KMS transport. No parser, schema,
// role, grants, bootstrap or business-DML substitution. All KMS bytes synthetic.
export { InvalidationFixtureKms, invalidationCatalog, invalidationDatabase };
export const REQUEUE_PG_REQUIRED = 'MODEL_ROUTER_SAAS_REQUEUE_E2E_REQUIRED';
export const REQUEUE_PG_CONFIG = [
  ['MODEL_ROUTER_SAAS_REQUEUE_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_REQUEUE_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_REQUEUE_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
  ['MODEL_ROUTER_SAAS_REQUEUE_E2E_WORKER_URL', 'model_router_saas_validation_worker'],
] as const;
export function requeuePgUrls(configured: readonly (string | undefined)[]): [string, string, string, string] {
  let target: string | undefined;
  const urls = REQUEUE_PG_CONFIG.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(typeof value === 'string' && value.length > 0, `${name}: every role required; partial configuration cannot skip`);
    let parsed: URL; let identity: string; let database: string;
    try { parsed = new URL(value); identity = decodeURIComponent(parsed.username); database = decodeURIComponent(parsed.pathname.slice(1)); }
    catch { throw new Error(`${name}: invalid connection (redacted)`); }
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol) && identity === role, `${name}: exact workload URL identity required`);
    assert.ok(parsed.search === '' && parsed.hash === '', `${name}: query/fragment overrides forbidden`);
    const host = parsed.hostname.toLowerCase(); const port = Number(parsed.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && parsed.port !== '' && Number.isInteger(port) && port > 0 && port <= 65535 &&
      ![5432, 6432, 53782].includes(port) && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name}: explicit disposable CI/nondefault loopback target required`);
    const candidate = `${host}:${port}/${database}`; target ??= candidate;
    assert.ok(candidate === target, 'all four roles must share one disposable target');
    return value;
  });
  assert.ok(urls[0] && urls[1] && urls[2] && urls[3]);
  return [urls[0], urls[1], urls[2], urls[3]];
}
export function actualSqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
export function redactedRequeueFailure(stage: string, error: unknown): Error {
  const failure = new Error(`credential_requeue/${stage}: ${actualSqlState(error) ?? 'NO_SQLSTATE'} (details redacted)`);
  failure.stack = failure.message; // Never forward driver messages/causes/params/raw stacks.
  return failure;
}
export async function requeuePgIdentity(database: SaasDatabase, role: string, name: string): Promise<void> {
  const row = (await database.query<{ role: string; session: string; database: string; safe: boolean }>(`SELECT current_user::text AS role,
    session_user::text AS session,current_database() AS database,NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolbypassrls
      AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND r.rolcanlogin
      AND current_setting('search_path')='model_router_saas' AND current_schemas(true)=ARRAY['pg_catalog','model_router_saas']::name[]
      AND current_setting('server_version_num')::integer>=150000
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`)).rows;
  assert.ok(row.length === 1 && row[0]?.role === role && row[0]?.session === role && row[0]?.database === name && row[0]?.safe === true,
    'exact non-superuser session identity, safe default path and current PG15+ required');
}
export function sameFacts(actual: unknown, expected: unknown, label: string): void {
  assert.ok(JSON.stringify(actual) === JSON.stringify(expected), label);
}
export async function permissionDenied(work: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try { await work(); } catch (error) { failed = true; assert.ok(actualSqlState(error) === '42501', 'negative ACL must return ACTUAL 42501'); }
  assert.ok(failed, 'restricted operation must be denied, not silently succeed');
}
export async function eligibleRequeueQueueEmpty(reader: SqlExecutor): Promise<void> {
  assert.ok((await reader.query<{ empty: boolean }>(`SELECT NOT EXISTS(SELECT 1 FROM saas_tenant_provider_credential_validation_jobs
    WHERE (status='queued' AND available_at<=clock_timestamp()) OR (status='leased' AND lease_until<=clock_timestamp())) AS empty`)).rows[0]?.empty === true,
  'dedicated fixture queue required; never claim another test/actor job');
}
export interface RequeuePgFixture {
  readonly supply: InvalidationFixture;
  readonly actor: CredentialValidationRequeueActor;
  readonly sessionId: string;
  readonly store: PostgresCredentialValidationWorkerStore;
  readonly targets: ReturnType<typeof compileApprovedCredentialValidationTargets>;
}
export async function seedRequeuePgFixture(migrator: SaasDatabase, worker: SaasDatabase, kms: InvalidationFixtureKms,
  actorRole: 'owner' | 'admin' | 'viewer' = 'owner'): Promise<RequeuePgFixture> {
  await eligibleRequeueQueueEmpty(migrator);
  const supply = await seedInvalidationFixture(migrator, kms);
  const sessionId = randomUUID(); const projectId = randomUUID(); const token = randomBytes(32).toString('hex');
  await migrator.transaction(async (tx) => {
    // Fixture seed only: actor/session/project are legal initial facts. No
    // migrator requeue/lease/health mutation substitutes for business actors.
    await tx.query('INSERT INTO saas_memberships(tenant_id,user_id,role) VALUES($1::uuid,$2::uuid,$3)', [supply.tenants[0], supply.actorId, actorRole]);
    await tx.query("INSERT INTO saas_projects(tenant_id,id,name,slug) VALUES($1::uuid,$2::uuid,'Synthetic requeue project',$3)",
      [supply.tenants[0], projectId, `requeue-${projectId}`]);
    await tx.query(`INSERT INTO saas_sessions(id,user_id,token_hash,csrf_token_hash,expires_at)
      VALUES($1::uuid,$2::uuid,$3,$4,clock_timestamp()+interval '1 hour')`,
    [sessionId, supply.actorId, createHash('sha256').update(token).digest('hex'), createHash('sha256').update(randomBytes(32)).digest('hex')]);
  });
  const targets = compileApprovedCredentialValidationTargets([supply.target]);
  return { supply, sessionId, targets, actor: { context: { userId: supply.actorId, tenantId: supply.tenants[0], projectId,
    tenantRole: actorRole, projectRole: actorRole }, sessionToken: token },
    store: new PostgresCredentialValidationWorkerStore(worker, kms, { ...invalidationStoreOptions(), approvedTargets: targets }) };
}
export const REQUEUE_PG_FAILED: Extract<ProviderCredentialValidationResult, { state: 'failed' }> = { state: 'failed', errorCode: 'provider_timeout',
  retryable: false, adapterId: 'synthetic-requeue-controlled-probe', httpStatus: null, durationMs: 0 };
export const REQUEUE_PG_VERIFIED: ProviderCredentialValidationResult = { state: 'verified',
  adapterId: 'synthetic-requeue-controlled-probe', httpStatus: 200, durationMs: 0 };
export async function actualRequeueClaim(fixture: RequeuePgFixture): Promise<CredentialValidationLease> {
  const deadline = Date.now() + 5000;
  do {
    const lease = await fixture.store.claimNext();
    if (lease) { assert.ok(lease.job.id === fixture.supply.jobId, 'actual store may claim ONLY its fixture job'); return lease; }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('actual worker must claim the audited cycle, including a cumulative count already at its original limit');
}
export async function actualRequeueTerminal(fixture: RequeuePgFixture, attempts = 1): Promise<CredentialValidationLease> {
  let last: CredentialValidationLease | undefined;
  for (let index = 0; index < attempts; index += 1) {
    last = await actualRequeueClaim(fixture);
    assert.ok(await fixture.store.complete(last, { ...REQUEUE_PG_FAILED, retryable: index < attempts - 1 }) === true,
      'actual worker must create every prior lease/retry/terminal outcome');
  }
  assert.ok(last, 'at least one genuine worker attempt required');
  return last;
}
export async function requeueCommand(reader: SqlExecutor, fixture: RequeuePgFixture): Promise<AuditedCredentialValidationRequeueCommand> {
  const rows = await invalidationJobs(reader, fixture.supply); const row = rows.find((value) => value.id === fixture.supply.jobId);
  assert.ok(row && ['failed', 'cancelled'].includes(row.status) && row.lease_until === null && row.completed_at !== null, 'actual terminal fixture required');
  const iso = (value: string) => new Date(value).toISOString();
  const job: ProviderCredentialValidationJobRecord = { id: row.id, tenantId: row.tenant_id, accountId: row.account_id,
    credentialId: row.credential_id, credentialVersion: row.credential_version, providerId: row.provider_id, productId: row.product_id,
    credentialType: row.credential_type, allowedModels: row.allowed_models,
    target: { model: row.target_model, endpoint: row.target_endpoint, version: row.capability_version }, idempotencyKey: row.idempotency_key,
    state: row.status === 'failed' ? 'failed' : 'cancelled', attemptCount: row.attempt_count, availableAt: iso(row.available_at), leaseUntil: null,
    leaseGeneration: Number(row.lease_generation), lastErrorCode: row.last_error_code, completedAt: iso(row.completed_at!),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  const credential = (await reader.query<{ version: string }>(`SELECT authz_version::text AS version FROM saas_tenant_provider_credentials
    WHERE tenant_id=$1::uuid AND id=$2`, [row.tenant_id, row.credential_id])).rows[0];
  assert.ok(credential && Number.isSafeInteger(Number(credential.version)), 'exact current credential authz fact required');
  return { jobId: row.id, expectedCredentialAuthzVersion: Number(credential.version), expectedLeaseGeneration: Number(row.lease_generation),
    expectedSnapshotSha256: credentialValidationJobSnapshotSha256(job), idempotencyKey: createHash('sha256').update(randomUUID()).digest('hex'),
    requestId: randomUUID(), reasonCode: 'retry_provider_validation', reason: 'Controlled synthetic provider retry; no credential material' };
}
export async function requeuePgSnapshot(reader: SqlExecutor, fixture: RequeuePgFixture) {
  const supply = await invalidationSnapshot(reader, fixture.supply);
  const jobs = (await reader.query<{ facts: Record<string, unknown> }>(`SELECT to_jsonb(j) AS facts
    FROM saas_tenant_provider_credential_validation_jobs j WHERE id=ANY($1::uuid[]) ORDER BY id`,
  [[fixture.supply.jobId, fixture.supply.historyJobId, fixture.supply.sameAccountJobId, ...fixture.supply.unrelatedJobIds]])).rows.map((row) => row.facts);
  const requests = (await reader.query<{ facts: Record<string, unknown> }>(`SELECT to_jsonb(r) AS facts
    FROM saas_credential_validation_requeue_requests r WHERE tenant_id=$1::uuid ORDER BY id`, [fixture.supply.tenants[0]])).rows.map((row) => row.facts);
  const cycles = (await reader.query<{ facts: Record<string, unknown> }>(`SELECT to_jsonb(c) AS facts
    FROM saas_credential_validation_cycles c WHERE tenant_id=$1::uuid ORDER BY id`, [fixture.supply.tenants[0]])).rows.map((row) => row.facts);
  const audit = (await reader.query<Record<string, unknown>>(`SELECT id::text,tenant_id::text,actor_user_id::text,action,target_type,
    target_id,occurred_at::text,entry_point,request_id FROM saas_audit_events
    WHERE tenant_id=$1::uuid AND entry_point='credential-validation-requeue' ORDER BY id`, [fixture.supply.tenants[0]])).rows;
  return { supply, jobs, requests, cycles, audit };
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function observeRequeueFenceWait(reader: SqlExecutor, waiter: number, holder: number, finished: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  do {
    assert.ok(!finished(), 'matching writer/reader cannot finish before held authority fence releases');
    const row = (await reader.query<{ blocked: boolean }>(`SELECT $2::integer=ANY(pg_blocking_pids($1::integer))
      AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::integer AND locktype='advisory' AND NOT granted) AS blocked`, [waiter, holder])).rows[0];
    if (row?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail('actual matching advisory fence wait, not elapsed timing, must be observed');
}
/** Real SQL delegation only; pause/throw AFTER success, before the real COMMIT. */
export function tappedRequeueDatabase(database: SaasDatabase,
  afterSuccessfulInsert: (tx: SqlExecutor, result: SqlResult<unknown>) => Promise<void>): SaasDatabase {
  return { ...database, async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return database.transaction(async (tx) => work({ async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await tx.query<Row>(sql, values);
      if (sql.startsWith('INSERT INTO saas_credential_validation_requeue_requests')) {
        assert.ok(result.rowCount === 1 && result.rows.length === 1, 'fault boundary requires ACTUAL successful guarded request INSERT');
        await afterSuccessfulInsert(tx, result);
      }
      return result;
    } }));
  } };
}
