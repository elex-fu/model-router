import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, after } from 'node:test';
import {
  type SaasDoctorDependencies,
  type SaasDoctorFilesystem,
  SaasDoctorOptionsError,
  type SaasDoctorResult,
  saasDoctor,
} from '../../src/cli/saas-doctor.js';
import { SAAS_MIGRATIONS } from '../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../src/saas/db/types.js';
import {
  MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
} from '../../src/saas/deployment.js';

const trustDirectory = mkdtempSync(resolve(tmpdir(), 'saas-doctor-commercial-trust-'));
const trustFile = resolve(trustDirectory, 'public-trust.json');
writeFileSync(trustFile, JSON.stringify({ version: 1, keys: [{ keyId: 'doctor-commercial-v1', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }], testVectorDigests: [{ suiteVersion: 'doctor-suite-v1', sha256: 'a'.repeat(64) }] }));
after(() => rmSync(trustDirectory, { recursive: true, force: true }));

const CONTROL_PLANE_URL = 'postgresql://control_plane:fixture-secret-password@doctor.example.invalid:5432/doctor';
const GATEWAY_URL = 'postgresql://gateway:fixture-secret-password@doctor.example.invalid:5432/doctor';
const WORKER_URL = 'postgresql://worker:fixture-secret-password@doctor.example.invalid:5432/doctor';

function migrationChecksum(migration: { name: string; sql: string }): string {
  return createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex');
}

function historyFromRegistry(): Array<{ version: number; name: string; checksum: string }> {
  return SAAS_MIGRATIONS.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: migrationChecksum(migration),
  }));
}

const CONTROL_PLANE_PROBE_PASS_ROW = {
  role_exists: true,
  server_version_supported: true,
  managed_schema: true,
  login_role: true,
  session_role_unchanged: true,
  superuser: false,
  create_database: false,
  create_role: false,
  replication_role: false,
  bypass_rls: false,
  any_role_membership: false,
  owns_database: false,
  owns_application_schema: false,
  owns_database_objects: false,
  schema_create: false,
  database_create: false,
  database_temp: false,
  truncate_privilege: false,
  extra_table_privilege: false,
  unsafe_delete_privilege: false,
  out_of_schema_table_privilege: false,
  out_of_schema_sequence_privilege: false,
  out_of_schema_function_privilege: false,
  application_table_count: '1',
  missing_table_privilege_count: 0,
  missing_select_count: 0,
  missing_insert_count: 0,
  missing_update_count: 0,
  missing_sequence_privilege_count: 0,
  unexpected_sequence_privilege_count: 0,
  missing_function_execute_count: 0,
  unsafe_security_definer_function_count: 0,
} as const;

const GATEWAY_PROBE_PASS_ROW = {
  role_exists: true,
  gateway_role: true,
  server_version_supported: true,
  managed_schema: true,
  application_schema_usage: true,
  login_role: true,
  session_role_unchanged: true,
  superuser: false,
  create_database: false,
  create_role: false,
  inherit_role: false,
  replication_role: false,
  bypass_rls: false,
  any_role_membership: false,
  owns_database: false,
  owns_application_schema: false,
  owns_database_objects: false,
  schema_create: false,
  database_create: false,
  database_temp: false,
  missing_spending_freeze_delete: false,
  out_of_schema_table_privilege: false,
  out_of_schema_sequence_privilege: false,
  out_of_schema_function_privilege: false,
  missing_required_relation_count: 0,
  missing_column_privilege_count: 0,
  missing_read_column_count: 0,
  missing_full_insert_column_count: 0,
  unexpected_column_privilege_count: 0,
  unexpected_table_privilege_count: 0,
  unexpected_delete_privilege_count: 0,
  missing_sequence_usage_count: 0,
  unexpected_sequence_privilege_count: 0,
  application_function_execute_count: 0,
  unsafe_security_definer_function_count: 0,
} as const;

const WORKER_PROBE_PASS_ROW = {
  role_exists: true,
  server_version_supported: true,
  managed_schema: true,
  login_role: true,
  session_role_unchanged: true,
  superuser: false,
  create_database: false,
  create_role: false,
  replication_role: false,
  bypass_rls: false,
  any_role_membership: false,
  owns_database: false,
  owns_schema: false,
  owns_objects: false,
  schema_create: false,
  database_create: false,
  database_temp: false,
  no_database_connect: false,
  any_table_level_privilege: false,
  missing_column_privilege: false,
  extra_column_privilege: false,
  any_sequence_privilege: false,
  any_function_privilege: false,
  catalog_scope_validator_executable: true,
  out_of_schema_object_privilege: false,
} as const;

interface FakeDatabaseConfig {
  readonly selectOneError?: boolean;
  readonly versionNum?: string;
  readonly registry?: string;
  readonly history?: Array<{ version: number; name: string; checksum: string }>;
  readonly applied?: string;
  readonly head?: string;
  readonly probeRow?: Record<string, unknown>;
  readonly namingRows?: Array<{ kind: string; object_name: string; privilege_type: string }>;
  readonly stuckCount?: string;
  readonly openCount?: string;
  readonly dueCount?: string;
  readonly alertingCount?: string;
  readonly staleCount?: string;
  readonly freezeCount?: string;
  readonly latestFrozenAt?: string;
}

function rowsFor(sql: string, config: FakeDatabaseConfig): unknown[] {
  if (sql.trim().startsWith("SELECT (has_table_privilege(current_user,'saas_responses_continuation_contexts'")) return [{ allowed: true }];
  if (sql.includes('FROM saas_responses_continuation_contexts LIMIT 0')) return [];
  if (sql.trim() === 'SELECT 1') {
    if (config.selectOneError) throw new Error('connection refused');
    return [];
  }
  // The privilege probes themselves reference server_version_num, so they
  // must be dispatched before the doctor's version query.
  if (sql.includes('role_exists')) return [config.probeRow ?? CONTROL_PLANE_PROBE_PASS_ROW];
  if (sql.includes('server_version_num')) return [{ version_num: config.versionNum ?? '160000' }];
  if (sql.includes('to_regclass')) {
    return [{ registry: config.registry !== undefined ? config.registry : 'saas_schema_migrations' }];
  }
  if (sql.includes('ORDER BY version ASC')) return config.history ?? historyFromRegistry();
  if (sql.includes('count(version)::text AS applied')) {
    return [{ applied: config.applied ?? String(SAAS_MIGRATIONS.length), head: config.head ?? '112' }];
  }
  if (sql.includes('has_column_privilege')) return config.namingRows ?? [];
  if (sql.includes('stuck_count')) return [{ stuck_count: config.stuckCount ?? '0' }];
  if (sql.includes('open_count')) {
    return [{ open_count: config.openCount ?? '0', due_count: config.dueCount ?? '0' }];
  }
  if (sql.includes('alerting_count')) {
    return [{ alerting_count: config.alertingCount ?? '0', stale_count: config.staleCount ?? '0' }];
  }
  if (sql.includes('freeze_count')) {
    return [{ freeze_count: config.freezeCount ?? '0', latest_frozen_at: config.latestFrozenAt ?? '' }];
  }
  throw new Error(`unexpected fixture query: ${sql.slice(0, 80)}`);
}

function fakePool(config: FakeDatabaseConfig = {}): SaasDatabasePool & { queries: string[] } {
  const queries: string[] = [];
  const respond = async <Row>(sql: string): Promise<SqlResult<Row>> => {
    queries.push(sql);
    return { rows: rowsFor(sql, config) as Row[], rowCount: 0 };
  };
  return {
    queries,
    async query<Row>(sql: string) {
      return respond<Row>(sql);
    },
    async connect(): Promise<SaasDatabaseClient> {
      return {
        async query<Row>(sql: string) {
          return respond<Row>(sql);
        },
        release: () => undefined,
      };
    },
    async end() {
      // Nothing to clean up in the fixture.
    },
  };
}

function readyKmsLoader() {
  return async () => ({ close: async () => undefined });
}

function failingKmsLoader(message: string) {
  return async () => {
    throw new Error(message);
  };
}

function okRedisProbe() {
  return async () => ({ ping: async () => undefined, close: async () => undefined });
}

function fakeFilesystem(entries: Map<string, { content?: string; mode?: number }>): SaasDoctorFilesystem {
  return {
    exists: (path) => entries.has(path),
    readFile: (path) => {
      const entry = entries.get(path);
      if (entry === undefined || entry.content === undefined) throw new Error(`missing fixture: ${path}`);
      return entry.content;
    },
    mode: (path) => {
      const entry = entries.get(path);
      if (entry === undefined || entry.mode === undefined) throw new Error(`missing fixture mode: ${path}`);
      return entry.mode;
    },
  };
}

function emptyFilesystem(): SaasDoctorFilesystem {
  return fakeFilesystem(new Map());
}

function controlPlaneEnv(): NodeJS.ProcessEnv {
  return {
    MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: CONTROL_PLANE_URL,
    MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE: trustFile,
    SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: './fixture-seal-kms.js',
    SAAS_PROVIDER_CREDENTIAL_REWRAP_KMS_MODULE: './fixture-rewrap-kms.js',
    MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
  };
}

function baseDependencies(overrides: Partial<SaasDoctorDependencies> = {}): SaasDoctorDependencies {
  return {
    env: controlPlaneEnv(),
    createPool: () => fakePool(),
    loadSealingKms: readyKmsLoader(),
    loadRewrappingKms: readyKmsLoader(),
    connectRedis: okRedisProbe(),
    fs: emptyFilesystem(),
    unitsDir: '/fixtures/systemd',
    envDir: '/fixtures/env',
    writeLine: () => undefined,
    ...overrides,
  };
}

async function runDoctor(
  options: { role?: string; json?: boolean; verbose?: boolean },
  dependencies: SaasDoctorDependencies,
): Promise<{ result: SaasDoctorResult; lines: string[] }> {
  const lines: string[] = [];
  const result = await saasDoctor(options, { ...dependencies, writeLine: (line) => lines.push(line) });
  return { result, lines };
}

function check(result: SaasDoctorResult, id: string) {
  const found = result.checks.find((entry) => entry.check === id);
  assert.ok(found, `check ${id} missing`);
  return found;
}

test('doctor reports the running gateway capability projection and warns on missing live verification', async () => {
  const gatewayCapabilities = {
    state: 'available' as const,
    observedAt: new Date().toISOString(),
    readiness: {
      configurationValid: true,
      fatalReasonCodes: [],
      capabilities: [
        {
          capability: 'provider-bundle:kimi',
          kind: 'provider-bundle' as const,
          label: 'Kimi',
          providerId: 'kimi',
          enabled: true,
          assembled: true,
          verified: false,
          operational: true,
          verificationLevel: 'unverified' as const,
          reasonCodes: ['VERIFICATION_NOT_RECORDED' as const],
          productIds: ['kimi-code'],
          endpointScopes: ['messages'],
          unavailableEndpointScopes: [],
        },
      ],
    },
  };
  const { result } = await runDoctor(
    { json: true },
    baseDependencies({
      env: { ...controlPlaneEnv(), MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: 'https://gateway.example.invalid' },
      readGatewayCapabilities: async () => gatewayCapabilities,
    }),
  );
  assert.equal(check(result, 'gateway-capabilities').level, 'warn');
  assert.match(check(result, 'gateway-capabilities').detail, /0\/1/);
  assert.deepEqual(result.gatewayCapabilities, gatewayCapabilities);
});

test('doctor fails invalid gateway assembly and keeps an unreachable gateway visible as warning', async () => {
  for (const state of ['available', 'unavailable'] as const) {
    const { result } = await runDoctor(
      {},
      baseDependencies({
        env: { ...controlPlaneEnv(), MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: 'https://gateway.example.invalid' },
        readGatewayCapabilities: async () =>
          state === 'available'
            ? {
                state,
                observedAt: new Date().toISOString(),
                readiness: {
                  configurationValid: false,
                  fatalReasonCodes: ['PROVIDER_BUNDLE_DISPATCH_UNAVAILABLE'],
                  capabilities: [],
                },
              }
            : { state },
      }),
    );
    assert.equal(check(result, 'gateway-capabilities').level, state === 'available' ? 'fail' : 'warn');
  }
});

test('control-plane scope includes dedicated commercial trust and reports all-pass', async () => {
  const { result, lines } = await runDoctor({}, baseDependencies());
  assert.equal(result.role, 'control-plane');
  assert.equal(result.checks.length, 10);
  assert.deepEqual(result.summary, { pass: 10, warn: 0, fail: 0 });
  assert.equal(result.exitCode, 0);
  assert.match(check(result, 'commercial-attestation-trust').detail, /each Codex provisioning operation requires an exact scope match/u);
  assert.ok(lines.some(line => line.startsWith('✓ pass  pg-migrations — server_version_num 160000')));
  assert.ok(lines.at(-1)?.includes('10 pass, 0 warn, 0 fail (role: control-plane)'));
  const migrations = check(result, 'pg-migrations');
  assert.match(migrations.detail, new RegExp(`migrations ${SAAS_MIGRATIONS.length}/${SAAS_MIGRATIONS.length} applied`));
});

test('gateway scope runs only gateway-relevant checks', async () => {
  const { result } = await runDoctor(
    { role: 'gateway' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: GATEWAY_URL,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
      createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }),
      loadGatewayUnsealingKms: readyKmsLoader(),
    }),
  );
  assert.deepEqual(
    result.checks.map((entry) => entry.check),
    ['pg-migrations', 'role-privileges', 'kms-readiness', 'redis-contract'],
  );
  assert.equal(result.exitCode, 0);
});

test('credential-validation-worker scope: ledger warn, KMS required, role-scoped checks', async () => {
  const { result } = await runDoctor(
    { role: 'credential-validation-worker' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: WORKER_URL,
        [MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-worker-kms.js',
      },
      createPool: () => fakePool({ probeRow: WORKER_PROBE_PASS_ROW }),
      loadValidationWorkerKms: readyKmsLoader(),
    }),
  );
  assert.deepEqual(
    result.checks.map((entry) => entry.check),
    ['pg-migrations', 'role-privileges', 'kms-readiness'],
  );
  assert.equal(check(result, 'pg-migrations').level, 'warn');
  assert.match(check(result, 'pg-migrations').detail, /migration ledger not verifiable/);
  assert.equal(check(result, 'role-privileges').level, 'pass');
  assert.equal(check(result, 'kms-readiness').level, 'pass');
  assert.equal(result.exitCode, 0);
});

test('--json emits the stable schema with exactly check, level, detail, hint', async () => {
  const { lines } = await runDoctor({ json: true }, baseDependencies());
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? '');
  assert.equal(parsed.format, 'saas-doctor-command-v1');
  assert.equal(parsed.role, 'control-plane');
  assert.deepEqual(parsed.summary, { pass: 10, warn: 0, fail: 0 });
  for (const entry of parsed.checks) {
    assert.deepEqual(Object.keys(entry).sort(), ['check', 'detail', 'hint', 'level']);
    assert.ok(['pass', 'warn', 'fail'].includes(entry.level));
  }
});

test('no secret value from the environment ever reaches the output', async () => {
  const { lines } = await runDoctor({ json: true }, baseDependencies());
  for (const line of lines) {
    assert.ok(!line.includes('fixture-secret-password'), `secret leaked: ${line.slice(0, 60)}`);
  }
});

test('commercial trust missing blocks provisioning and invalid trust fails safely', async () => {
  const env = controlPlaneEnv();
  delete env.MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE;
  const missing = await runDoctor({ json: true }, baseDependencies({ env }));
  assert.equal(check(missing.result, 'commercial-attestation-trust').level, 'warn');
  assert.match(check(missing.result, 'commercial-attestation-trust').detail, /provisioning is unavailable/u);
  const invalidFile = resolve(trustDirectory, 'invalid-trust.json');
  writeFileSync(invalidFile, JSON.stringify({ version: 1, privateKey: 'synthetic-private-secret-never-echo' }));
  const invalid = await runDoctor({ json: true }, baseDependencies({ env: { ...env, MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE: invalidFile } }));
  assert.equal(check(invalid.result, 'commercial-attestation-trust').level, 'fail');
  assert.equal(invalid.result.exitCode, 1);
  assert.ok(invalid.lines.every(line => !line.includes('synthetic-private-secret-never-echo')));
});

test('commercial provisioning checks the effective parsed CP pool maximum', async () => {
  for (const value of ['1', '01', ' 1 ']) {
    const { result } = await runDoctor({}, baseDependencies({ env: { ...controlPlaneEnv(), MODEL_ROUTER_SAAS_DB_POOL_MAX: value } }));
    assert.equal(check(result, 'commercial-attestation-trust').level, 'warn');
    assert.match(check(result, 'commercial-attestation-trust').detail, /requires at least two connections/u);
  }
  const { result } = await runDoctor({}, baseDependencies({ env: { ...controlPlaneEnv(), MODEL_ROUTER_SAAS_DB_POOL_MAX: '02' } }));
  assert.equal(check(result, 'commercial-attestation-trust').level, 'pass');
});

test('history doctor keeps pilot explicitly nonproduction and rejects CP secret access', async () => {
  const file = resolve(trustDirectory, 'pilot-history-keyring.json');
  writeFileSync(file, JSON.stringify({ version: 1, currentKeyId: 'pilot-v1', keys: { 'pilot-v1': 'a'.repeat(64) } }), { mode: 0o600 });
  const historyEnv = { MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE: 'pilot-file-keyring', MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KEYRING_FILE: file };
  const pilot = await runDoctor({ role: 'gateway', json: true }, baseDependencies({ env: { ...historyEnv, MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: GATEWAY_URL, [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js' }, createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }), loadGatewayUnsealingKms: readyKmsLoader() }));
  assert.equal(check(pilot.result, 'responses-history').level, 'warn');
  assert.match(check(pilot.result, 'responses-history').detail, /not production ready/u);
  assert.ok(pilot.lines.every(line => !line.includes('a'.repeat(64))));
  const forbidden = await runDoctor({ role: 'control-plane' }, baseDependencies({ env: { ...controlPlaneEnv(), ...historyEnv } }));
  assert.equal(check(forbidden.result, 'responses-history').level, 'fail');
});

test('missing database URL fails closed on database checks and warns on SQL checks', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({ env: { MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'control-plane' } }),
  );
  assert.equal(check(result, 'pg-migrations').level, 'fail');
  assert.match(check(result, 'pg-migrations').detail, /MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL is unset/);
  assert.equal(check(result, 'role-privileges').level, 'fail');
  for (const id of ['stuck-executions', 'recovery-sweep', 'health-self-heal', 'spending-freezes']) {
    assert.equal(check(result, id).level, 'warn', id);
    assert.match(check(result, id).detail, /no PostgreSQL URL configured/);
  }
  assert.equal(result.exitCode, 1);
});

test('unreachable database fails connectivity-dependent checks with reasons', async () => {
  const { result } = await runDoctor({}, baseDependencies({ createPool: () => fakePool({ selectOneError: true }) }));
  assert.equal(check(result, 'pg-migrations').level, 'fail');
  assert.match(check(result, 'pg-migrations').detail, /unable to connect/);
  assert.equal(check(result, 'role-privileges').level, 'fail');
  assert.equal(check(result, 'stuck-executions').level, 'warn');
  assert.equal(result.exitCode, 1);
});

test('unsupported server version fails the migration check', async () => {
  const { result } = await runDoctor({}, baseDependencies({ createPool: () => fakePool({ versionNum: '140000' }) }));
  assert.equal(check(result, 'pg-migrations').level, 'fail');
  assert.match(check(result, 'pg-migrations').detail, /140000/);
  assert.equal(result.exitCode, 1);
});

test('missing migration registry fails with the safe verify message', async () => {
  const { result } = await runDoctor({}, baseDependencies({ createPool: () => fakePool({ registry: '' }) }));
  assert.equal(check(result, 'pg-migrations').level, 'fail');
  assert.match(check(result, 'pg-migrations').detail, /SaaS migration registry is missing/);
});

test('checksum drift in the migration history fails with the verify message', async () => {
  const history = historyFromRegistry();
  history[0] = { ...history[0], checksum: '0'.repeat(64) };
  const { result } = await runDoctor({}, baseDependencies({ createPool: () => fakePool({ history }) }));
  assert.equal(check(result, 'pg-migrations').level, 'fail');
  assert.match(check(result, 'pg-migrations').detail, /does not match this release/);
});

test('failed privilege probe names the missing column grants precisely', async () => {
  const probeRow = { ...CONTROL_PLANE_PROBE_PASS_ROW, missing_select_count: 1 };
  const namingRows = [
    { kind: 'column', object_name: 'saas_requests.execution_state', privilege_type: 'SELECT' },
    { kind: 'table', object_name: 'saas_billing_spending_freezes', privilege_type: 'DELETE' },
  ];
  const pool = fakePool({ probeRow, namingRows });
  const { result } = await runDoctor(
    {},
    baseDependencies({
      createPool: () => pool,
    }),
  );
  // The generated SQL must use a VALUES list (or a typed empty SELECT), never
  // the invalid `VALUES SELECT ...` shape (live-PG regression guard).
  const naming = pool.queries.find((sql) => sql.includes('has_column_privilege'));
  assert.ok(naming, 'naming query dispatched');
  assert.ok(!naming.includes('VALUES SELECT'), 'naming CTE sections must be valid SQL');
  assert.match(naming, /AS \(\s*VALUES/);
  const privileges = check(result, 'role-privileges');
  assert.equal(privileges.level, 'fail');
  assert.match(privileges.detail, /saas_requests\.execution_state:SELECT/);
  assert.match(privileges.detail, /saas_billing_spending_freezes:DELETE/);
  assert.equal(result.exitCode, 1);
});

test('failed privilege probe without missing names reports the fail-closed fallback', async () => {
  const probeRow = { ...CONTROL_PLANE_PROBE_PASS_ROW, extra_table_privilege: true };
  const { result } = await runDoctor(
    {},
    baseDependencies({ createPool: () => fakePool({ probeRow, namingRows: [] }) }),
  );
  const privileges = check(result, 'role-privileges');
  assert.equal(privileges.level, 'fail');
  assert.match(privileges.detail, /no missing column grants were detected/);
});

test('gateway privilege failure names missing table grants', async () => {
  const probeRow = { ...GATEWAY_PROBE_PASS_ROW, missing_read_column_count: 2 };
  const namingRows = [{ kind: 'table', object_name: 'saas_billing_spending_freezes', privilege_type: 'DELETE' }];
  const { result } = await runDoctor(
    { role: 'gateway' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: GATEWAY_URL,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
      createPool: () => fakePool({ probeRow, namingRows }),
      loadGatewayUnsealingKms: readyKmsLoader(),
    }),
  );
  assert.match(check(result, 'role-privileges').detail, /saas_billing_spending_freezes:DELETE/);
});

test('worker privilege failure names grants parsed from the worker probe contract', async () => {
  const probeRow = { ...WORKER_PROBE_PASS_ROW, missing_column_privilege: true };
  const namingRows = [
    { kind: 'column', object_name: 'saas_tenant_provider_credential_validation_jobs.status', privilege_type: 'UPDATE' },
  ];
  const pool = fakePool({ probeRow, namingRows });
  const { result } = await runDoctor(
    { role: 'credential-validation-worker' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: WORKER_URL,
        [MODEL_ROUTER_SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-worker-kms.js',
      },
      createPool: () => pool,
      loadValidationWorkerKms: readyKmsLoader(),
    }),
  );
  const privileges = check(result, 'role-privileges');
  assert.equal(privileges.level, 'fail');
  assert.match(privileges.detail, /saas_tenant_provider_credential_validation_jobs\.status:UPDATE/);
  // The naming query was built from the worker probe's expected-grant section.
  const naming = pool.queries.find((sql) => sql.includes('has_column_privilege'));
  assert.ok(naming, 'naming query dispatched');
  assert.match(naming, /saas_tenant_provider_credential_validation_jobs/);
});

test('KMS readiness fails when a declared module is not ready', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({ loadSealingKms: failingKmsLoader('Provider credential KMS readiness check failed') }),
  );
  const kms = check(result, 'kms-readiness');
  assert.equal(kms.level, 'fail');
  assert.match(kms.detail, /seal: not ready/);
  assert.equal(result.exitCode, 1);
});

test('KMS readiness warns when optional control-plane modules are not declared', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: CONTROL_PLANE_URL,
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
    }),
  );
  const kms = check(result, 'kms-readiness');
  assert.equal(kms.level, 'warn');
  assert.match(kms.detail, /seal: not declared; rewrap: not declared/);
  assert.equal(result.exitCode, 0);
});

test('KMS readiness warns when only the rewrap module is missing', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: CONTROL_PLANE_URL,
        SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: './fixture-seal-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
    }),
  );
  const kms = check(result, 'kms-readiness');
  assert.equal(kms.level, 'warn');
  assert.match(kms.detail, /seal: ready; rewrap: not declared/);
});

test('KMS readiness fails when a required worker or gateway module is missing', async () => {
  const worker = await runDoctor(
    { role: 'credential-validation-worker' },
    baseDependencies({
      env: { MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL: WORKER_URL },
      createPool: () => fakePool({ probeRow: WORKER_PROBE_PASS_ROW }),
    }),
  );
  assert.equal(check(worker.result, 'kms-readiness').level, 'fail');
  assert.equal(worker.result.exitCode, 1);

  const gateway = await runDoctor(
    { role: 'gateway' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: GATEWAY_URL,
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
      createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }),
    }),
  );
  assert.equal(check(gateway.result, 'kms-readiness').level, 'fail');
  assert.match(check(gateway.result, 'kms-readiness').detail, /gateway unseal: not declared/);
});

test('Redis probe failure reports the safe RESP error code', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({
      connectRedis: async () => {
        throw new Error('fixture connection refused');
      },
    }),
  );
  const redis = check(result, 'redis-contract');
  assert.equal(redis.level, 'fail');
  assert.match(redis.detail, /REDIS_CONNECTION_FAILED/);
  assert.ok(!redis.detail.includes('fixture connection refused'));
});

test('Redis URL absence: gateway warns (optional), control-plane fails (required)', async () => {
  const gateway = await runDoctor(
    { role: 'gateway' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: GATEWAY_URL,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js',
      },
      createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }),
      loadGatewayUnsealingKms: readyKmsLoader(),
    }),
  );
  assert.equal(check(gateway.result, 'redis-contract').level, 'warn');
  assert.equal(gateway.result.exitCode, 0);

  const controlPlane = await runDoctor(
    {},
    baseDependencies({
      env: { MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: CONTROL_PLANE_URL },
    }),
  );
  assert.equal(check(controlPlane.result, 'redis-contract').level, 'fail');
  assert.equal(controlPlane.result.exitCode, 1);
});

test('stuck execution rows past the horizon warn with the count', async () => {
  const { result } = await runDoctor({}, baseDependencies({ createPool: () => fakePool({ stuckCount: '3' }) }));
  const stuck = check(result, 'stuck-executions');
  assert.equal(stuck.level, 'warn');
  assert.match(stuck.detail, /3 execution row\(s\)/);
  assert.match(stuck.detail, /600s in-flight horizon/);
  assert.equal(result.exitCode, 0);
});

test('recovery sweep queue depth warns with open and due counts', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({ createPool: () => fakePool({ openCount: '2', dueCount: '1' }) }),
  );
  const sweep = check(result, 'recovery-sweep');
  assert.equal(sweep.level, 'warn');
  assert.match(sweep.detail, /2 open unknown-outcome reconciliation case\(s\), 1 due now/);
  assert.match(sweep.hint, /staleAdmissionCancelFailures/);
});

test('health self-heal warns on alerting rows and passes with stale-only rows', async () => {
  const alerting = await runDoctor(
    {},
    baseDependencies({ createPool: () => fakePool({ alertingCount: '1', staleCount: '1' }) }),
  );
  const health = check(alerting.result, 'health-self-heal');
  assert.equal(health.level, 'warn');
  assert.match(health.detail, /1 provider account health row\(s\)/);

  const staleOnly = await runDoctor(
    {},
    baseDependencies({ createPool: () => fakePool({ alertingCount: '0', staleCount: '2' }) }),
  );
  const quiet = check(staleOnly.result, 'health-self-heal');
  assert.equal(quiet.level, 'pass');
  assert.match(quiet.detail, /2 observation\(s\) older than 600s/);
});

test('spending freezes warn with the count and latest timestamp', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({
      createPool: () => fakePool({ freezeCount: '2', latestFrozenAt: '2026-10-17 00:00:00+00' }),
    }),
  );
  const freezes = check(result, 'spending-freezes');
  assert.equal(freezes.level, 'warn');
  assert.match(freezes.detail, /2 spending freeze\(s\) present/);
  assert.match(freezes.detail, /latest 2026-10-17 00:00:00\+00/);
});

test('failing read-only SQL diagnostics warn without failing the run', async () => {
  const pool = fakePool();
  const original = pool.query.bind(pool);
  const { result } = await runDoctor(
    {},
    baseDependencies({
      createPool: () => ({
        ...pool,
        async query<Row>(sql: string) {
          if (sql.includes('stuck_count')) throw new Error('permission denied');
          return original<Row>(sql);
        },
      }),
    }),
  );
  const stuck = check(result, 'stuck-executions');
  assert.equal(stuck.level, 'warn');
  assert.match(stuck.detail, /read-only diagnostic query failed/);
  assert.equal(result.exitCode, 0);
});

test('systemd posture skips gracefully when no units are installed', async () => {
  const { result } = await runDoctor({}, baseDependencies({ fs: emptyFilesystem() }));
  const systemd = check(result, 'systemd-posture');
  assert.equal(systemd.level, 'pass');
  assert.match(systemd.detail, /not applicable/);
});

function systemdFixtureEntries(): Map<string, { content?: string; mode?: number }> {
  const unitsDir = '/fixtures/systemd';
  const envDir = '/fixtures/env';
  const reviewedDir = resolve('deploy/systemd/managed-saas');
  const entries = new Map<string, { content?: string; mode?: number }>();
  for (const name of [
    'model-router-saas-control-plane.service',
    'model-router-saas-gateway.service',
    'model-router-saas-credential-validation-worker.service',
    'model-router-saas.target',
  ]) {
    const content = readFileSync(resolve(reviewedDir, name), 'utf8');
    entries.set(resolve(unitsDir, name), { content });
    entries.set(resolve(reviewedDir, name), { content });
  }
  entries.set(resolve(envDir, 'common.env'), {
    content:
      'MODEL_ROUTER_SAAS_DEPLOYMENT_ID=fixture-deployment\nMODEL_ROUTER_SAAS_ENVIRONMENT_ID=fixture-environment\n',
    mode: 0o640,
  });
  entries.set(resolve(envDir, 'control-plane.env'), {
    content: 'MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=postgresql://fixture/doctor\n',
    mode: 0o600,
  });
  entries.set(resolve(envDir, 'gateway.env'), {
    content: 'MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL=postgresql://fixture/doctor\n',
    mode: 0o600,
  });
  entries.set(resolve(envDir, 'credential-validation-worker.env'), {
    content: 'MODEL_ROUTER_SAAS_VALIDATION_WORKER_DATABASE_URL=postgresql://fixture/doctor\n',
    mode: 0o600,
  });
  return entries;
}

test('systemd posture passes on a fully reviewed fixture', async () => {
  const { result } = await runDoctor(
    {},
    baseDependencies({
      fs: fakeFilesystem(systemdFixtureEntries()),
      unitsDir: '/fixtures/systemd',
      envDir: '/fixtures/env',
    }),
  );
  const systemd = check(result, 'systemd-posture');
  assert.equal(systemd.level, 'pass');
  assert.match(systemd.detail, /satisfy the reviewed deployment contract/);
});

test('systemd posture warns naming the failing unit directive', async () => {
  const entries = systemdFixtureEntries();
  const gatewayUnit = entries.get(resolve('/fixtures/systemd', 'model-router-saas-gateway.service'))?.content ?? '';
  entries.set(resolve('/fixtures/systemd', 'model-router-saas-gateway.service'), {
    content: gatewayUnit.replace('ProtectHome=true', 'ProtectHome=false'),
  });
  const { result } = await runDoctor(
    {},
    baseDependencies({
      fs: fakeFilesystem(entries),
      unitsDir: '/fixtures/systemd',
      envDir: '/fixtures/env',
    }),
  );
  const systemd = check(result, 'systemd-posture');
  assert.equal(systemd.level, 'warn');
  assert.match(systemd.detail, /ProtectHome/);
});

test('systemd posture warns on permissive env file modes without printing values', async () => {
  const entries = systemdFixtureEntries();
  entries.set(resolve('/fixtures/env', 'control-plane.env'), {
    content: 'MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL=postgresql://fixture-secret@fixture/doctor\n',
    mode: 0o644,
  });
  const { result, lines } = await runDoctor(
    {},
    baseDependencies({
      fs: fakeFilesystem(entries),
      unitsDir: '/fixtures/systemd',
      envDir: '/fixtures/env',
    }),
  );
  const systemd = check(result, 'systemd-posture');
  assert.equal(systemd.level, 'warn');
  assert.match(systemd.detail, /env control-plane.env mode \(mode 644 too permissive\)/);
  assert.ok(!lines.some((line) => line.includes('fixture-secret')), 'env values must never be printed');
});

test('default role follows MODEL_ROUTER_SAAS_WORKLOAD_ROLE and falls back to combined', async () => {
  const withRole = await runDoctor(
    {},
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
        MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: GATEWAY_URL,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
      createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }),
      loadGatewayUnsealingKms: readyKmsLoader(),
    }),
  );
  assert.equal(withRole.result.role, 'gateway');
  assert.equal(withRole.result.exitCode, 0);

  const combined = await runDoctor(
    {},
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_DATABASE_URL: CONTROL_PLANE_URL,
        SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: './fixture-seal-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
    }),
  );
  assert.equal(combined.result.role, 'combined');
  assert.equal(combined.result.checks.length, 10);
});

test('shared MODEL_ROUTER_SAAS_DATABASE_URL stands in only for the matching declared role', async () => {
  const matching = await runDoctor(
    { role: 'gateway' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
        MODEL_ROUTER_SAAS_DATABASE_URL: GATEWAY_URL,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
      createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }),
      loadGatewayUnsealingKms: readyKmsLoader(),
    }),
  );
  assert.equal(check(matching.result, 'pg-migrations').level, 'pass');

  const conflicting = await runDoctor(
    { role: 'gateway' },
    baseDependencies({
      env: {
        MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'control-plane',
        MODEL_ROUTER_SAAS_DATABASE_URL: CONTROL_PLANE_URL,
        [SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE]: './fixture-gateway-kms.js',
        MODEL_ROUTER_SAAS_REDIS_URL: 'redis://doctor.example.invalid:6379',
      },
      createPool: () => fakePool({ probeRow: GATEWAY_PROBE_PASS_ROW }),
      loadGatewayUnsealingKms: readyKmsLoader(),
    }),
  );
  assert.equal(check(conflicting.result, 'pg-migrations').level, 'fail');
  assert.match(check(conflicting.result, 'pg-migrations').detail, /MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL is unset/);
});

test('verbose prints hints for passing checks; default output hides them', async () => {
  const { lines: terse } = await runDoctor({}, baseDependencies());
  assert.ok(!terse.some((line) => line.includes('hint:')));

  const { lines: verbose } = await runDoctor({ verbose: true }, baseDependencies());
  assert.ok(verbose.some((line) => line.includes('hint:')));
});

test('invalid --role rejects with the options error', async () => {
  await assert.rejects(
    runDoctor({ role: 'not-a-role' }, baseDependencies()),
    (error: unknown) => error instanceof SaasDoctorOptionsError,
  );
});
