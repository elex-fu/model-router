import assert, { AssertionError } from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../../src/saas/db/types.js';
import { SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS } from '../../../../src/saas/db/runtime-privileges.js';
import {
  PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE, PREPARED_EVIDENCE_BUCKET_CHECK_SQL,
  RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION,
} from '../../../../src/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.js';
import {
  SaasPreparedRequestEvidenceService, type PreparedRequestEvidenceInput,
} from '../../../../src/saas/gateway/prepared-request-evidence-service.js';
import { createPreparedRequestEvidenceSigner } from '../../../../src/saas/runtime/prepared-request-evidence-signer.js';
import { TrustedPreparedRequestVerifierKeyRegistry } from '../../../../src/saas/runtime/prepared-evidence-verifier-keys.js';

const required = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED';
const roles = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
] as const;
const configured = roles.map(([name]) => process.env[name]?.trim());
function safeRoleUrls(): string[] {
  let target: string | undefined;
  return roles.map(([name, role], i) => {
    const value = configured[i];
    assert.ok(value, `${name} is required for the 056 gate`);
    let url: URL;
    let user: string;
    let database: string;
    try { url = new URL(value); user = decodeURIComponent(url.username); database = decodeURIComponent(url.pathname.slice(1)); }
    catch { throw new Error(`${name} must be a valid PostgreSQL URL`); }
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.ok(user === role, `${name} must use its exact managed role`);
    assert.ok(url.search === '' && url.hash === '', `${name} must not contain connection overrides/fragments`);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port);
    const ci = host === 'postgres' && port === 5432 && database === 'model_router_saas_ci';
    const local = ['127.0.0.1', '[::1]'].includes(host) && Boolean(url.port)
      && Number.isInteger(port) && port > 0 && port <= 65_535 && ![5432, 6432].includes(port)
      && (database === 'model_router_saas_ci' || /^model_router_test_[a-zA-Z0-9_]+$/.test(database));
    assert.ok(ci || local, `${name} must use designated CI or an explicit nondefault disposable exact-loopback target`);
    const identity = `${host}:${port}/${database}`;
    target ??= identity;
    assert.ok(identity === target, 'all 056 roles must use the same disposable target');
    return value;
  });
}
async function bounded<T>(database: SaasDatabase, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '15s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
    const isolation = await tx.query<{ isolation: string }>("SELECT current_setting('transaction_isolation') AS isolation");
    assert.equal(isolation.rows[0]?.isolation, 'read committed');
    return work(tx);
  });
}
function firstSqlError(cause: unknown): { code: string; constraint?: string; column?: string } | undefined {
  const visited = new Set<object>();
  while (cause && typeof cause === 'object' && !visited.has(cause)) {
    visited.add(cause);
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)) {
      return { code: cause.code,
        ...('constraint' in cause && typeof cause.constraint === 'string' ? { constraint: cause.constraint } : {}),
        ...('column' in cause && typeof cause.column === 'string' ? { column: cause.column } : {}) };
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return undefined;
}
function sqlState(code: string, constraint?: string, column?: string) {
  return (cause: unknown) => {
    const actual = firstSqlError(cause);
    assert.equal(actual?.code, code, `expected SQLSTATE ${code}; server details redacted`);
    if (constraint) assert.ok(actual?.constraint === constraint, 'rejection must name the exact production bucket CHECK');
    if (column) assert.ok(actual?.column === column, 'rejection must name the exact required bucket column');
    return true;
  };
}
function safeFailure(cause: unknown): Error {
  if (cause instanceof AssertionError) return cause;
  const state = firstSqlError(cause);
  return new Error(state ? `056 PostgreSQL operation failed (SQLSTATE ${state.code}); details redacted`
    : '056 PostgreSQL operation failed; details redacted');
}
async function proof(t: TestContext, name: string, work: () => Promise<void>) {
  return t.test(name, async () => {
    try { await work(); } catch (cause) { throw safeFailure(cause); }
  });
}

const labels = ['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'];
interface ArrayCase { name: string; literal: string | null; result?: boolean; error?: string; items?: string[] }
const arrayCases: ArrayCase[] = [
  { name: 'null', literal: null, result: false },
  { name: 'empty', literal: '{}', result: false },
  { name: 'null-element', literal: '{input,NULL}', result: false },
  { name: 'all-null', literal: '{NULL}', result: false },
  { name: 'unknown', literal: '{input,not_allowed}', result: false },
  { name: 'whitespace', literal: '{" input"}', result: false },
  { name: 'lower-zero', literal: '[0:1]={input,cache_read}', result: true, items: ['input', 'cache_read'] },
  { name: 'lower-negative', literal: '[-2:-1]={cache_write_1h,cache_write_5m}', result: true, items: ['cache_write_1h', 'cache_write_5m'] },
  { name: 'lower-five', literal: '[5:5]={input}', result: true, items: ['input'] },
  { name: 'lower-zero-duplicate', literal: '[0:1]={cache_read,cache_read}', result: false },
  { name: 'two-dimensions', literal: '{{input,cache_read},{cache_write,cache_write_5m}}', error: '0A000' },
  { name: 'two-dimensions-null', literal: '{{input,NULL}}', error: '0A000' },
  { name: 'two-dimensions-unknown', literal: '{{not_allowed}}', error: '0A000' },
  ...labels.map((label) => ({ name: `duplicate-${label}`, literal: `{${label},${label}}`, result: false })),
];
// All 325 nonempty permutations of subsets of the finite five-label domain.
function permutations(prefix: string[], rest: string[]) {
  if (prefix.length) arrayCases.push({ name: `permutation-${arrayCases.length}`, literal: `{${prefix.join(',')}}`, result: true, items: prefix });
  for (const label of rest) permutations([...prefix, label], rest.filter((other) => other !== label));
}
permutations([], labels);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function started<T>(barrier: { promise: Promise<T> }, operation: Promise<void>): Promise<T> {
  return Promise.race([barrier.promise, operation.then(() => {
    throw new Error('056 concurrent operation ended before its required barrier');
  })]);
}
async function pid(tx: SqlExecutor) { return (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid; }
async function waitForUserFence(db: SqlExecutor, waiter: number, holder: number, user: string, readerWaits: boolean) {
  const deadline = Date.now() + 1_500; // the unchanged writer helper has a 2s lock timeout
  do {
    const observed = await db.query<{ blocked: boolean; global_writer: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks w JOIN pg_locks h USING(locktype, database, classid, objid, objsubid)
        WHERE w.locktype = 'advisory' AND w.pid = $1 AND h.pid = $2 AND NOT w.granted AND h.granted
          AND w.mode = $4 AND h.mode = $5 AND h.objsubid = 1
          AND h.classid = ((hashtextextended($3::uuid::text, 0) >> 32) & 4294967295)::oid
          AND h.objid = (hashtextextended($3::uuid::text, 0) & 4294967295)::oid) AS blocked,
        EXISTS (SELECT 1 FROM pg_locks WHERE pid = $6 AND locktype = 'advisory' AND granted
          AND mode = 'ExclusiveLock' AND classid = 1396788563::oid AND objid = 46::oid AND objsubid = 2) AS global_writer`,
      [waiter, holder, user, readerWaits ? 'ShareLock' : 'ExclusiveLock', readerWaits ? 'ExclusiveLock' : 'ShareLock',
        readerWaits ? holder : waiter]);
    if (observed.rows[0]?.blocked && observed.rows[0].global_writer) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('056 must observe the exact per-user shared/exclusive wait with the global statement writer fence already held');
}
async function seedUser(migrator: SaasDatabase) {
  const user = randomUUID();
  await migrator.query('INSERT INTO saas_users (id, email) VALUES ($1::uuid, $2)', [user, `056-${randomUUID()}@example.test`]);
  return user;
}
async function insertMfa(tx: SqlExecutor, user: string, id: string) {
  // SQL-fence fixture, not a claim of TOTP verification or protected-action
  // authorization. The separate real MFA service/HTTP gate proves those.
  const result = await tx.query(
    `INSERT INTO saas_mfa_credentials (id, user_id, kind, encrypted_secret, verified_at)
     VALUES ($1::uuid, $2::uuid, 'totp', $3::bytea, clock_timestamp())`,
    [id, user, Buffer.from('056 disposable SQL-fence fixture only')]);
  assert.equal(result.rowCount, 1);
}
async function eligible(tx: SqlExecutor, user: string, id: string): Promise<boolean> {
  return (await tx.query<{ eligible: boolean }>(
    `SELECT EXISTS(SELECT id FROM saas_mfa_credentials WHERE id = $1::uuid AND user_id = $2::uuid
      AND verified_at IS NOT NULL AND revoked_at IS NULL) AS eligible`, [id, user])).rows[0]!.eligible;
}

type BusinessTable = 'saas_requests' | 'saas_attempts' | 'saas_prepared_request_evidence';
interface Source { table: BusinessTable; columns: { name: string; sql_type: string }[]; row: Record<string, unknown> }
function identifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
async function readSource(migrator: SqlExecutor, table: BusinessTable, id: string, tenant: string): Promise<Source> {
  const columns = (await migrator.query<{ name: string; sql_type: string }>(
    `SELECT attname AS name, format_type(atttypid, atttypmod) AS sql_type FROM pg_attribute
      WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
    [`model_router_saas.${table}`])).rows;
  const insertable = SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([name, , privilege]) => name === table && privilege === 'INSERT')
    .map(([, column]) => column);
  const allowed = columns.filter((c) => table === 'saas_prepared_request_evidence' || insertable.includes(c.name));
  assert.ok(allowed.some((c) => c.name === 'id' && c.sql_type === 'uuid'));
  const source = await migrator.query<Record<string, unknown>>(
    `SELECT ${allowed.map((c) => identifier(c.name)).join(', ')} FROM model_router_saas.${identifier(table)}
     WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenant]);
  assert.equal(source.rows.length, 1, '056 reads only one explicitly known synthetic HTTP source under migrator');
  return { table, columns: allowed, row: source.rows[0]! };
}
async function insertParent(tx: SqlExecutor, source: Source, patch: Record<string, unknown>) {
  const record = { ...source.row, ...patch };
  for (const key of Object.keys(patch)) assert.ok(source.columns.some((c) => c.name === key));
  assert.equal((await tx.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_gateway');
  const inserted = await tx.query(
    `INSERT INTO model_router_saas.${identifier(source.table)} (${source.columns.map((c) => identifier(c.name)).join(', ')})
     VALUES (${source.columns.map((c, i) => `$${i + 1}::${c.sql_type}`).join(', ')})`,
    source.columns.map((c) => record[c.name]));
  assert.equal(inserted.rowCount, 1);
}
async function httpSources(migrator: SqlExecutor): Promise<{ tenant: string; mode: string; sources: Source[] }[]> {
  const fixtures = await migrator.query<{ tenant: string; mode: string; request: string; attempt: string; evidence: string }>(
    `WITH fixture AS (
       SELECT r.tenant_id FROM saas_requests r JOIN saas_projects p ON p.tenant_id = r.tenant_id AND p.id = r.project_id
       WHERE p.slug LIKE 'gateway-e2e-project-%' AND r.execution_state = 'succeeded'
       GROUP BY r.tenant_id HAVING count(DISTINCT r.supply_mode) = 2 ORDER BY max(r.created_at) DESC LIMIT 1)
     SELECT DISTINCT ON (e.supply_mode) e.tenant_id AS tenant, e.supply_mode AS mode,
       e.request_id AS request, e.attempt_id AS attempt, e.id AS evidence
     FROM saas_prepared_request_evidence e JOIN fixture f ON f.tenant_id = e.tenant_id
       JOIN saas_requests r ON r.tenant_id = e.tenant_id AND r.id = e.request_id
     WHERE e.status = 'claimed' AND r.execution_state = 'succeeded'
       AND e.account_id LIKE 'gateway-e2e-%' AND e.credential_id LIKE 'gateway-e2e-%'
     ORDER BY e.supply_mode, e.created_at DESC`);
  assert.equal(fixtures.rows.length, 2, '056 requires this database\'s successful real BYOK/platform HTTP fixture first; never skip/fabricate it');
  assert.deepEqual(fixtures.rows.map((r) => r.mode), ['byok', 'platform']);
  const result: { tenant: string; mode: string; sources: Source[] }[] = [];
  for (const fixture of fixtures.rows) result.push({ tenant: fixture.tenant, mode: fixture.mode, sources: [
    await readSource(migrator, 'saas_requests', fixture.request, fixture.tenant),
    await readSource(migrator, 'saas_attempts', fixture.attempt, fixture.tenant),
    await readSource(migrator, 'saas_prepared_request_evidence', fixture.evidence, fixture.tenant),
  ] });
  return result;
}
function fixtureMappingVersion(value: unknown, source: unknown): number | null {
  assert.ok(source === 'none' || source === 'alias' || source === 'wildcard', '056 requires the stored mapping source');
  if (source === 'none') {
    assert.ok(value === null, '056 passthrough mapping must retain its stored NULL revision');
    return null;
  }
  let exact: bigint;
  if (typeof value === 'bigint') exact = value;
  else if (typeof value === 'number') {
    assert.ok(Number.isSafeInteger(value), '056 mapping revision must be an exact integer');
    exact = BigInt(value);
  } else {
    assert.ok(typeof value === 'string' && /^[0-9]+$/.test(value.trim()), '056 mapping revision must be an exact integer');
    exact = BigInt(value.trim());
  }
  assert.ok(exact >= 1n && exact <= BigInt(Number.MAX_SAFE_INTEGER), '056 mapping revision must be a positive safe integer');
  return Number(exact);
}
function inputFrom(row: Record<string, unknown>, request: string, attempt: string, evidence: string, deadline: Date,
  buckets: readonly string[], keyId: string): PreparedRequestEvidenceInput {
  const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
  const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
  const usage = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith('usage_'))
    .map(([key, value]) => [camel(key.slice('usage_'.length)), value]));
  // All authority/provenance comes from actual successful HTTP, never a mock.
  // A fresh in-memory test-only Ed25519 key signs the new identities/windows;
  // the production registrar really verifies it and revalidates DB authority.
  return { ...fields, evidenceId: evidence, requestId: request, attemptId: attempt,
    dispatchDeadline: deadline, expiresAt: deadline, verifierKeyId: keyId, signatureBase64: '',
    modelResolution: { requestedModel: row.model_resolution_requested_model, mappedModel: row.model_resolution_mapped_model,
      resolvedModel: row.resolved_model, mappingSource: row.model_resolution_mapping_source,
      mappingVersion: fixtureMappingVersion(row.model_resolution_mapping_version, row.model_resolution_mapping_source) },
    usage: { ...usage, feasibleInputBuckets: buckets },
    audit: { actorUserId: null, entryPoint: '056-postgres-fixture' },
  } as unknown as PreparedRequestEvidenceInput;
}

test('056 real restricted-role CHECK equivalence, MFA fencing and zero callable application functions', {
  skip: process.env[required] !== '1' && !configured.some(Boolean) ? `set ${required}=1 and all three managed E2E role URLs` : false,
  timeout: 120_000,
}, async (t) => {
  const databases = safeRoleUrls().map((connectionString) => createSaasDatabase({ connectionString, max: 3 }));
  const [migrator, control, gateway] = databases as [SaasDatabase, SaasDatabase, SaasDatabase];
  try {
    await migrator.verifySchema();
    for (let i = 0; i < databases.length; i++) {
      const session = await databases[i]!.query<{ role: string; session: string; superuser: boolean; path: string; schemas: string[] }>(
        `SELECT current_user AS role, session_user AS session, r.rolsuper AS superuser,
          current_setting('search_path') AS path, current_schemas(true)::text[] AS schemas
          FROM pg_roles r WHERE r.rolname = current_user`);
      assert.deepEqual(session.rows[0], { role: roles[i]![1], session: roles[i]![1], superuser: false,
        path: 'model_router_saas', schemas: ['pg_catalog', 'model_router_saas'] });
    }
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
    await proof(t, 'exact wrapper body/owner/path, validated CHECK and direct EXECUTE denial', async () => {
      const wrapper = await migrator.query<{ source: string; definer: boolean; config: string[]; owner: string; bindings: string }>(
        `SELECT p.prosrc AS source, p.prosecdef AS definer, p.proconfig AS config, p.proowner::regrole::text AS owner,
          (SELECT count(*)::text FROM pg_trigger WHERE tgfoid = p.oid) AS bindings
          FROM pg_proc p WHERE p.oid = 'saas_platform_authorization_fence_row()'::regprocedure`);
      assert.deepEqual(wrapper.rows[0], { source: PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE, definer: true,
        config: ['search_path=pg_catalog, model_router_saas, pg_temp'], owner: 'model_router_saas_migrator', bindings: '4' });
      for (const [signature, sourceIndex] of [
        ['saas_prepared_evidence_valid_input_buckets(text[])', 0],
        ['saas_platform_authorization_fence_users(uuid[])', 2],
        ['saas_platform_authorization_writer_statement()', 3],
      ] as const) {
        const tag = `$source_${sourceIndex}$`;
        const sql = RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION.sql;
        const first = sql.indexOf(tag) + tag.length;
        const expected = sql.slice(first, sql.indexOf(tag, first));
        const helper = await migrator.query<{ source: string; definer: boolean; config: string[] | null; owner: string }>(
          `SELECT prosrc AS source, prosecdef AS definer, proconfig AS config, proowner::regrole::text AS owner
           FROM pg_proc WHERE oid = to_regprocedure($1)`, [`model_router_saas.${signature}`]);
        assert.deepEqual(helper.rows[0], { source: expected, definer: false, config: null, owner: 'model_router_saas_migrator' });
      }
      const check = await migrator.query<{ validated: boolean; helpers: string }>(
        `SELECT c.convalidated AS validated, (SELECT count(*)::text FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid
          WHERE d.classid = 'pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_proc'::regclass
            AND p.pronamespace = 'model_router_saas'::regnamespace) AS helpers
          FROM pg_constraint c WHERE c.conrelid = 'saas_prepared_request_evidence'::regclass
            AND c.conname = 'saas_prepared_request_evidence_bucket_check'`);
      assert.deepEqual(check.rows, [{ validated: true, helpers: '0' }]);
      for (const database of [control, gateway]) {
        const executable = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_proc WHERE pronamespace = 'model_router_saas'::regnamespace
           AND has_function_privilege(current_user, oid, 'EXECUTE')`);
        assert.equal(executable.rows[0]?.count, '0');
        for (const statement of [
          "SELECT saas_prepared_evidence_valid_input_buckets(ARRAY['input']::text[])",
          'SELECT saas_platform_authorization_fence_users(ARRAY[]::uuid[])',
          'SELECT saas_platform_authorization_fence_row()',
          'SELECT saas_platform_authorization_writer_statement()',
        ]) await assert.rejects(database.query(statement), sqlState('42501'));
      }
      const key = await gateway.query<{ allowed: boolean }>("SELECT has_any_column_privilege(current_user, 'saas_api_keys', 'UPDATE') AS allowed");
      assert.equal(key.rows[0]?.allowed, false);
    });
    await proof(t, 'original helper and production inline CHECK match all array values/errors/bounds', async () => {
      const cases = arrayCases.filter((c) => !c.error);
      const observed = await migrator.query<{ ordinal: string; original: boolean; replacement: boolean }>(
        `SELECT ordinal::text, saas_prepared_evidence_valid_input_buckets(usage_feasible_input_buckets) AS original,
          (${PREPARED_EVIDENCE_BUCKET_CHECK_SQL}) AS replacement
          FROM unnest($1::text[]) WITH ORDINALITY AS cases(literal, ordinal)
          CROSS JOIN LATERAL (SELECT literal::text[] AS usage_feasible_input_buckets) typed ORDER BY cases.ordinal`,
        [cases.map((c) => c.literal)]);
      assert.equal(observed.rows.length, cases.length);
      for (let i = 0; i < cases.length; i++) {
        assert.equal(observed.rows[i]?.ordinal, String(i + 1), `ordinal matrix: ${cases[i]!.name}`);
        assert.equal(observed.rows[i]?.original, cases[i]!.result, `original matrix: ${cases[i]!.name}`);
        assert.equal(observed.rows[i]?.replacement, cases[i]!.result, `replacement matrix: ${cases[i]!.name}`);
      }
      for (const value of arrayCases.filter((c) => c.error)) {
        await assert.rejects(migrator.query('SELECT saas_prepared_evidence_valid_input_buckets($1::text[])', [value.literal]), sqlState(value.error!));
        await assert.rejects(gateway.query(`SELECT (${PREPARED_EVIDENCE_BUCKET_CHECK_SQL}) FROM (SELECT $1::text[] AS usage_feasible_input_buckets) typed`,
          [value.literal]), sqlState(value.error!));
      }
    });
    await proof(t, 'restricted MFA INSERT waits behind shared subject reader after global statement fence', async () => {
      const user = await seedUser(migrator);
      const credential = randomUUID();
      const ready = deferred<number>(); const release = deferred(); const writerReady = deferred<number>();
      const reader = bounded(control, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text, 0))', [user]);
        ready.resolve(await pid(tx)); await release.promise;
      });
      reader.catch(() => {});
      const readerPid = await started(ready, reader);
      const writer = bounded(control, async (tx) => { writerReady.resolve(await pid(tx)); await insertMfa(tx, user, credential); });
      writer.catch(() => {});
      try {
        await waitForUserFence(migrator, await started(writerReady, writer), readerPid, user, false);
        assert.equal(await eligible(control, user, credential), false, 'uncommitted MFA grant must not be visible');
      } finally { release.resolve(); await reader; }
      await writer;
      assert.equal(await eligible(control, user, credential), true);
    });
    await proof(t, 'restricted MFA revoke holds exclusive fence; waiting reader fresh read denies', async () => {
      const user = await seedUser(migrator); const credential = randomUUID();
      await bounded(control, (tx) => insertMfa(tx, user, credential));
      const writerReady = deferred<number>(); const release = deferred(); const readerReady = deferred<number>();
      const writer = bounded(control, async (tx) => {
        assert.equal((await tx.query('UPDATE saas_mfa_credentials SET revoked_at = clock_timestamp() WHERE id = $1::uuid', [credential])).rowCount, 1);
        writerReady.resolve(await pid(tx)); await release.promise;
      });
      writer.catch(() => {});
      const writerPid = await started(writerReady, writer);
      const reader = bounded(control, async (tx) => {
        assert.equal(await eligible(tx, user, credential), true, 'pre-wait READ COMMITTED snapshot sees prior committed authority');
        readerReady.resolve(await pid(tx));
        await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text, 0))', [user]);
        assert.equal(await eligible(tx, user, credential), false, 'post-wait fresh authority read must deny revoked MFA');
      });
      reader.catch(() => {});
      try { await waitForUserFence(migrator, await started(readerReady, reader), writerPid, user, true); }
      finally { release.resolve(); await writer; }
      await reader;
    });

    // Below this boundary the required real HTTP fixture must already exist.
    // No fake success, elevated business INSERT, copied invalid signature,
    // verifier bypass, trigger bypass, or weakened privilege probe is used.
    const fixtures = await httpSources(migrator);
    const keys = generateKeyPairSync('ed25519');
    const keyId = '056-test-only-ed25519';
    const registry = new TrustedPreparedRequestVerifierKeyRegistry({ keys: [{ keyId, publicKey: keys.publicKey, status: 'active' }] });
    const signer = createPreparedRequestEvidenceSigner({ registry, verifierKeyId: keyId, privateKey: keys.privateKey });
    const service = new SaasPreparedRequestEvidenceService(gateway, { trustedVerifierPublicKeys: registry.trustedVerifierPublicKeys });
    for (const fixture of fixtures) await proof(t, `actual ${fixture.mode} gateway registrar rejects tampered buckets without fake signatures`, async () => {
      const [requestSource, attemptSource, evidenceSource] = fixture.sources as [Source, Source, Source];
      const values = arrayCases.filter((c) => c.result === false || c.error || c.name.startsWith('lower-') && c.result === true);
      values.push({ name: 'all-five', literal: `{${labels.join(',')}}`, result: true, items: labels });
      for (const value of values) {
        const request = randomUUID(); const attempt = randomUUID(); const evidence = randomUUID();
        let inserted = 0;
        const work = bounded(gateway, async (tx) => {
          await insertParent(tx, requestSource, { id: request, execution_state: 'pending', reconciliation_state: 'none',
            financial_status: fixture.mode === 'byok' ? 'not_applicable' : 'pending', state_version: 1 });
          await insertParent(tx, attemptSource, { id: attempt, request_id: request, dispatch_state: 'not_sent', result_state: 'pending',
            response_started: false, state_version: 1 });
          const clock = await tx.query<{ deadline: Date }>("SELECT clock_timestamp() + interval '5 minutes' AS deadline");
          const input = signer.sign(inputFrom(evidenceSource.row, request, attempt, evidence, clock.rows[0]!.deadline,
            value.items ?? ['input'], keyId));
          const storage: SqlExecutor = {
            async query<Row>(sql: string, parameters?: readonly unknown[]) {
              if (!sql.startsWith('INSERT INTO saas_prepared_request_evidence (')) return tx.query<Row>(sql, parameters);
              const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((column) => column.trim());
              const index = columns.indexOf('usage_feasible_input_buckets');
              assert.ok(index >= 0 && parameters && parameters.length === columns.length);
              const tampered = [...parameters];
              tampered[index] = value.literal;
              inserted += 1;
              // Real signature verification and authority reads already ran.
              // Only negative cases deliberately tamper this one stored field;
              // positive lower-bound cases retain the same signed element set.
              return tx.query<Row>(sql, tampered);
            },
          };
          await service.register(input, { executor: storage });
        });
        if (value.result === true) await work;
        else await assert.rejects(work, sqlState(value.error ?? (value.literal === null ? '23502' : '23514'),
          value.error || value.literal === null ? undefined : 'saas_prepared_request_evidence_bucket_check',
          value.literal === null ? 'usage_feasible_input_buckets' : undefined));
        assert.equal(inserted, 1, `case ${value.name} must reach the real prepared INSERT`);
        const count = await gateway.query<{ count: string }>('SELECT count(id)::text AS count FROM saas_prepared_request_evidence WHERE id = $1::uuid', [evidence]);
        assert.equal(count.rows[0]?.count, value.result === true ? '1' : '0');
      }
    });
    await proof(t, 'HTTP fixture probe lease is released history, not automatically a preparation leak', async () => {
      // The successful normal HTTP fixture probes both ownership modes.
      // Derive their exact account/upstream identities from its persisted
      // request/attempt/evidence, not a prefix or a newly invented probe.
      const expected = await Promise.all(fixtures.map(async (fixture) => {
        const [request, attempt, evidence] = fixture.sources;
        assert.ok(request && attempt && evidence);
        assert.ok(fixture.mode === 'byok' || fixture.mode === 'platform');
        const project = request.row.project_id;
        const account = evidence.row.account_id;
        const upstream = evidence.row.upstream_id;
        assert.ok(typeof project === 'string' && project.length > 0);
        assert.ok(typeof account === 'string' && account.startsWith('gateway-e2e-'));
        assert.ok(typeof upstream === 'string' && upstream.startsWith('gateway-e2e-'));
        for (const source of [request, attempt, evidence]) assert.equal(source.row.tenant_id, fixture.tenant);
        assert.equal(evidence.row.project_id, project);
        assert.equal(request.row.supply_mode, fixture.mode);
        assert.equal(evidence.row.supply_mode, fixture.mode);
        assert.equal(evidence.row.request_id, request.row.id);
        assert.equal(evidence.row.attempt_id, attempt.row.id);
        assert.equal(attempt.row.request_id, request.row.id);
        // Source is deliberately an INSERT projection, not a full attempt
        // observation. Read generated account_id from this exact successful
        // HTTP attempt; never add it to the copied INSERT or synthesize it.
        const observed = await migrator.query<{
          id: string; tenant_id: string; request_id: string; account_id: string | null;
          account_owner_kind: string | null; upstream_id: string; prepared_evidence_id: string | null;
        }>(
          `SELECT id, tenant_id, request_id, account_id, account_owner_kind, upstream_id, prepared_evidence_id
           FROM model_router_saas.saas_attempts
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND request_id = $3::uuid`,
          [attempt.row.id, fixture.tenant, request.row.id]);
        assert.equal(observed.rows.length, 1, 'one exact known HTTP attempt must supply its real generated account binding');
        const actual = observed.rows[0];
        assert.ok(actual);
        assert.equal(actual.id, evidence.row.attempt_id);
        assert.equal(actual.tenant_id, evidence.row.tenant_id);
        assert.equal(actual.request_id, evidence.row.request_id);
        assert.equal(actual.prepared_evidence_id, evidence.row.id);
        assert.equal(actual.account_id, account);
        assert.equal(actual.upstream_id, upstream);
        assert.equal(attempt.row.upstream_id, upstream);
        const owner = evidence.row.account_owner_kind;
        assert.ok(owner === 'tenant' || owner === 'platform');
        assert.equal(owner, fixture.mode === 'byok' ? 'tenant' : 'platform');
        assert.equal(attempt.row.account_owner_kind, owner);
        assert.equal(actual.account_owner_kind, owner);
        return { mode: fixture.mode, tenant: fixture.tenant, project, account, upstream, owner,
          ownerTenant: owner === 'tenant' ? fixture.tenant : null };
      }));
      assert.deepEqual(expected.map((fixture) => fixture.mode), ['byok', 'platform']);
      const context = expected[0];
      assert.ok(context);
      assert.ok(expected.every((fixture) => fixture.tenant === context.tenant && fixture.project === context.project));
      assert.equal(new Set(expected.map((fixture) => fixture.account)).size, 2, 'the real BYOK/platform accounts must be distinct');
      assert.equal(new Set(expected.map((fixture) => fixture.upstream)).size, 2);
      const probe = await migrator.query<{
        owner_kind: string; owner_tenant_id: string | null; account_id: string; upstream_id: string;
        attempt_id: string; status: string; release_recorded: boolean;
      }>(
        `SELECT l.owner_kind, l.owner_tenant_id::text AS owner_tenant_id, l.account_id, l.upstream_id,
           l.attempt_id, l.status, l.released_at IS NOT NULL AS release_recorded
         FROM saas_provider_account_leases l WHERE l.tenant_id = $1::uuid
           AND NOT EXISTS(SELECT a.id FROM saas_attempts a WHERE a.tenant_id = l.tenant_id AND a.id::text = l.attempt_id)
         ORDER BY l.owner_kind, l.account_id, l.id`, [context.tenant]);
      assert.equal(probe.rows.length, expected.length, 'the entire HTTP tenant must have only its two known probe histories');
      assert.equal(new Set(probe.rows.map((row) => row.attempt_id)).size, 2, 'the two probes must retain distinct attempt identities');
      for (const fixture of expected) {
        const matching = probe.rows.filter((row) => row.owner_kind === fixture.owner && row.owner_tenant_id === fixture.ownerTenant
          && row.account_id === fixture.account && row.upstream_id === fixture.upstream);
        assert.equal(matching.length, 1, `exactly one ${fixture.mode} probe must match the real fixture account and owner`);
        assert.deepEqual(matching.map((row) => ({ status: row.status, release_recorded: row.release_recorded })),
          [{ status: 'released', release_recorded: true }]);
      }
      const totals = await migrator.query<{
        total: string; linked_attempts: string; orphan: string; unreleased: string; wrong_binding: string;
      }>(
        `SELECT count(l.id)::text AS total,
           count(DISTINCT a.id)::text AS linked_attempts,
           (count(l.id) FILTER(WHERE a.id IS NULL))::text AS orphan,
           (count(l.id) FILTER(WHERE l.status <> 'released' OR l.released_at IS NULL))::text AS unreleased,
           (count(l.id) FILTER(WHERE a.id IS NOT NULL AND (
             r.id IS NULL OR r.project_id IS DISTINCT FROM $2::uuid OR e.id IS NULL
             OR e.project_id IS DISTINCT FROM r.project_id
             OR a.account_id IS DISTINCT FROM l.account_id OR a.upstream_id IS DISTINCT FROM l.upstream_id
             OR e.account_id IS DISTINCT FROM l.account_id OR e.upstream_id IS DISTINCT FROM l.upstream_id
             OR e.account_owner_kind IS DISTINCT FROM l.owner_kind
             OR l.owner_tenant_id IS DISTINCT FROM CASE WHEN l.owner_kind = 'tenant' THEN l.tenant_id ELSE NULL::uuid END
             OR r.supply_mode IS DISTINCT FROM CASE WHEN l.owner_kind = 'tenant' THEN 'byok' ELSE 'platform' END
           )))::text AS wrong_binding
         FROM saas_provider_account_leases l
           LEFT JOIN saas_attempts a ON a.tenant_id = l.tenant_id AND a.id::text = l.attempt_id
           LEFT JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
           LEFT JOIN saas_prepared_request_evidence e
             ON e.tenant_id = a.tenant_id AND e.id = a.prepared_evidence_id AND e.request_id = a.request_id AND e.attempt_id = a.id
         WHERE l.tenant_id = $1::uuid`, [context.tenant, context.project]);
      assert.equal(totals.rows.length, 1);
      const total = totals.rows[0];
      assert.ok(total);
      assert.equal(total.orphan, String(expected.length));
      assert.equal(total.unreleased, '0', 'no held/expired/unreleased lease is hidden by a prefix or orphan filter');
      assert.equal(total.wrong_binding, '0', 'every business lease must retain the HTTP tenant/project/mode/account binding');
      assert.match(total.total, /^[0-9]+$/);
      assert.match(total.linked_attempts, /^[0-9]+$/);
      assert.equal(total.total, (BigInt(total.linked_attempts) + BigInt(expected.length)).toString(),
        'tenant-wide history must be exactly one lease per linked attempt plus the two distinct released probes');
    });
  } catch (cause) { throw safeFailure(cause); }
  finally { await Promise.all(databases.map((database) => database.close())); }
});
