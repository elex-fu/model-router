import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { PoolConfig } from 'pg';
import {
  PLATFORM_MFA_PROVIDER_ENV_KEYS,
  saasPlatformMfaEnroll,
  SaasPlatformMfaEnrollmentError,
  type SaasPlatformMfaEnrollmentDependencies,
} from '../../src/cli/saas-platform-mfa-enrollment.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../src/saas/db/types.js';
import { PlatformAuthError } from '../../src/saas/platform/auth/errors.js';
import { PlatformAdminAuthService, type PlatformMfaEnrollmentIssuanceAudit } from '../../src/saas/platform/auth/service.js';
import { loadCredentialKeyProvider, type LoadedCredentialKeyProvider } from '../../src/saas/runtime/providers.js';

const exec = promisify(execFile);
const fixtureUrl = 'postgresql://operator:fixture-db-password@fixture.invalid:65432/fixture';
const sensitiveText = `${fixtureUrl}; fixture-provider-secret; ${'T'.repeat(43)}`;
const token = 'T'.repeat(43);
const expiresAt = '2030-01-01T00:10:00.000Z';
const operatorId = 'ops:workload-42';
const audit: PlatformMfaEnrollmentIssuanceAudit = {
  operatorId, reasonCode: 'initial-enrollment', requestId: '00000000-0000-4000-8000-000000000009',
};

function fixture(overrides: Partial<SaasPlatformMfaEnrollmentDependencies> = {}) {
  const events: string[] = [];
  const output: string[] = [];
  let issueCalls = 0;
  let poolOptions: PoolConfig | undefined;
  let passedAudit: PlatformMfaEnrollmentIssuanceAudit | undefined;
  const database: SaasDatabase = {
    async query<Row>(sql: string): Promise<SqlResult<Row>> {
      assert.equal(sql, 'SELECT initialized FROM saas_platform_state WHERE singleton = TRUE');
      events.push('state');
      return { rows: [{ initialized: true }] as Row[], rowCount: 1 };
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) { return work(database); },
    async migrate() { throw new Error('CLI must never migrate'); },
    async ping() { events.push('ping'); },
    async verifySchema() { events.push('schema'); },
    async close() { events.push('database-close'); },
  };
  const provider: LoadedCredentialKeyProvider = {
    getCurrentKey: () => { throw new Error('Issuance must not extract a real key'); },
    getKey: () => { throw new Error('Issuance must not decrypt a user secret'); },
    async checkReady() {},
    async close() { events.push('provider-close'); },
  };
  const answers = [' OWNER@example.com ', operatorId, 'initial-enrollment'];
  const dependencies: SaasPlatformMfaEnrollmentDependencies = {
    env: { NODE_ENV: 'production', MODEL_ROUTER_SAAS_DATABASE_URL: fixtureUrl,
      MODEL_ROUTER_SAAS_KMS_PROVIDER: 'trusted-totp-fixture',
      MODEL_ROUTER_SAAS_DEPLOYMENT_ID: 'deployment-fixture', MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'environment-fixture',
      AWS_REGION: 'region-fixture', SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: 'must-not-load',
      SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: 'must-not-load',
      MODEL_ROUTER_SAAS_REDIS_URL: 'redis://fixture-secret@fixture.invalid',
      KIMI_API_KEY: 'fixture-provider-secret', AWS_SECRET_ACCESS_KEY: 'fixture-cloud-secret',
      PGHOST: 'must-not-fallback.invalid', PGPORT: '5432', PGDATABASE: 'must-not-fallback',
      PGUSER: 'must-not-fallback', PGPASSWORD: 'fixture-pg-secret', PGSSLMODE: 'no-verify',
      PGOPTIONS: '-c role=must-not-use -c search_path=public',
    },
    requireInteractiveTerminal: () => { events.push('tty'); },
    prompt: {
      async ask() { events.push('prompt'); return answers.shift() ?? ''; },
      async close() { events.push('prompt-close'); },
    },
    createDatabase: (options, config) => {
      assert.equal(options.connectionString, fixtureUrl);
      poolOptions = config;
      events.push('database-create');
      return database;
    },
    verifyControlPlanePrivileges: async (db) => { assert.equal(db, database); events.push('privileges'); },
    loadKeyProvider: async (module, options) => {
      assert.equal(module, 'trusted-totp-fixture');
      assert.ok(Object.isFrozen(options.env));
      assert.deepEqual(Object.keys(options.env).sort(), ['NODE_ENV', 'MODEL_ROUTER_SAAS_DEPLOYMENT_ID',
        'MODEL_ROUTER_SAAS_ENVIRONMENT_ID', 'AWS_REGION'].sort());
      events.push('provider-load');
      return provider;
    },
    createAuthService: (db, loaded) => {
      assert.equal(db, database);
      assert.equal(loaded, provider);
      events.push('service-create');
      return { async issueMfaEnrollmentToken(email, context) {
        assert.equal(email, 'owner@example.com');
        assert.ok(context);
        assert.equal(context.operatorId, operatorId);
        assert.equal(context.reasonCode, 'initial-enrollment');
        assert.match(context.requestId, /^[0-9a-f-]{36}$/);
        passedAudit = context;
        issueCalls += 1;
        events.push('issue');
        return { token, expiresAt };
      } };
    },
    writeToTerminal: (message) => { events.push('write'); output.push(message); },
    ...overrides,
  };
  return { dependencies, database, provider, events, output, answers,
    get issueCalls() { return issueCalls; }, get passedAudit() { return passedAudit; },
    get poolOptions() { return poolOptions; } };
}
async function safeFailure(work: Promise<void>, pattern: RegExp): Promise<void> {
  await assert.rejects(work, (cause: unknown) => {
    assert.ok(cause instanceof SaasPlatformMfaEnrollmentError);
    assert.match(cause.message, pattern);
    assert.ok(!cause.message.includes(fixtureUrl));
    assert.ok(!cause.message.includes('fixture-provider-secret'));
    assert.ok(!cause.message.includes(token));
    assert.equal(cause.cause, undefined);
    return true;
  });
}

test('TTY and input precede database/provider work; probes precede provider; one token+expiry output and cleanup', async () => {
  const f = fixture();
  assert.equal(await saasPlatformMfaEnroll(f.dependencies), undefined);
  assert.deepEqual(f.events, ['tty', 'prompt', 'prompt', 'prompt', 'database-create', 'ping', 'schema',
    'privileges', 'state', 'provider-load', 'service-create', 'tty', 'issue', 'tty', 'write',
    'provider-close', 'database-close', 'prompt-close']);
  assert.equal(f.issueCalls, 1);
  assert.equal(f.output.length, 1);
  assert.equal(f.output[0].split(token).length - 1, 1);
  assert.equal(f.output[0].split(expiresAt).length - 1, 1);
  assert.ok(f.output[0].includes('/admin/api/v1/auth/mfa/enrollment/start'));
  assert.ok(f.output[0].includes('/admin/api/v1/auth/mfa/enrollment/confirm'));
  assert.ok(!f.output[0].includes(fixtureUrl));
  assert.ok(!f.output[0].includes('fixture-provider-secret'));
  assert.ok(!f.output[0].includes('session'));
  assert.deepEqual(f.poolOptions?.ssl, { rejectUnauthorized: true });
  assert.equal(f.poolOptions?.connectionString, undefined);
  assert.equal(f.poolOptions?.host, 'fixture.invalid');
  assert.equal(f.poolOptions?.port, 65432);
  assert.equal(f.poolOptions?.user, 'operator');
  assert.equal(f.poolOptions?.database, 'fixture');
  assert.equal(f.poolOptions?.options, ' ');
  assert.equal(typeof f.poolOptions?.password, 'function');
  if (typeof f.poolOptions?.password === 'function') assert.equal(await f.poolOptions.password(), 'fixture-db-password');
});

test('remote default, require and verify-full use explicit verified TLS; empty password cannot use PGPASSWORD', async () => {
  for (const mode of ['', '?sslmode=require', '?sslmode=verify-full']) {
    const f = fixture();
    const url = `postgresql://operator@fixture.invalid:65432/fixture${mode}`;
    let config: PoolConfig | undefined;
    f.dependencies.env = { ...f.dependencies.env, MODEL_ROUTER_SAAS_DATABASE_URL: url };
    f.dependencies.createDatabase = (options, poolConfig) => {
      assert.equal(options.connectionString, url);
      config = poolConfig;
      return f.database;
    };
    await saasPlatformMfaEnroll(f.dependencies);
    assert.deepEqual(config?.ssl, { rejectUnauthorized: true });
    assert.equal(config?.connectionString, undefined);
    assert.equal(config?.sslnegotiation, 'postgres');
    assert.equal(config?.options, ' ');
    assert.equal(typeof config?.password, 'function');
    if (typeof config?.password === 'function') assert.equal(await config.password(), '');
  }
});

test('unsafe remote TLS and URL/session/role/certificate overrides fail before prompt/database/provider', async () => {
  for (const suffix of ['?sslmode=disable', '?sslmode=allow', '?sslmode=prefer', '?sslmode=no-verify',
    '?sslmode=verify-ca', '?sslmode=require&sslmode=disable', '?sslmode=verify-full&ssl=false',
    '?options=-c%20search_path%3Dpublic', '?search_path=public', '?role=superuser',
    '?host=localhost', '?port=5432', '?user=superuser', '?password=fixture-secret',
    '?dbname=other', '?sslcert=/fixture/cert', '?sslkey=/fixture/key', '?sslrootcert=/fixture/root']) {
    const f = fixture();
    f.dependencies.env = { ...f.dependencies.env, MODEL_ROUTER_SAAS_DATABASE_URL: fixtureUrl + suffix };
    await safeFailure(saasPlatformMfaEnroll(f.dependencies, { allowLocalPlaintext: true }), /URL is invalid/);
    assert.deepEqual(f.events, ['tty', 'prompt-close']);
    assert.equal(f.issueCalls, 0);
    assert.deepEqual(f.output, []);
  }
});

test('plaintext requires both explicit opt-in and loopback; private CIDR is not a local exception', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '10.2.3.4', '192.168.4.5', '172.16.1.2', 'fixture.invalid']) {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    for (const optIn of [false, true]) {
      const f = fixture();
      const url = `postgresql://operator:fixture-db-password@${host}:65432/fixture?sslmode=disable`;
      let config: PoolConfig | undefined;
      f.dependencies.env = { ...f.dependencies.env, MODEL_ROUTER_SAAS_DATABASE_URL: url };
      f.dependencies.createDatabase = (options, poolConfig) => {
        assert.equal(options.connectionString, url);
        config = poolConfig;
        return f.database;
      };
      const work = saasPlatformMfaEnroll(f.dependencies, { allowLocalPlaintext: optIn });
      if (loopback && optIn) {
        await work;
        assert.equal(config?.ssl, false);
        assert.equal(f.issueCalls, 1);
        assert.equal(f.output.length, 1);
      } else {
        await safeFailure(work, /URL is invalid/);
        assert.deepEqual(f.events, ['tty', 'prompt-close']);
        assert.equal(f.issueCalls, 0);
      }
    }
  }
});

test('a supplied prompt does not bypass the production TTY requirement', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { saasPlatformMfaEnroll, SaasPlatformMfaEnrollmentError } from './src/cli/saas-platform-mfa-enrollment.ts';
    const calls = [];
    await assert.rejects(saasPlatformMfaEnroll({
      env: {},
      prompt: { async ask() { calls.push('ask'); return ''; }, close() { calls.push('close'); } },
      createDatabase() { calls.push('database'); throw new Error('must not open'); },
      async loadKeyProvider() { calls.push('provider'); throw new Error('must not load'); },
    }), (cause) => cause instanceof SaasPlatformMfaEnrollmentError && /interactive TTY/.test(cause.message));
    assert.deepEqual(calls, ['close']);
  `], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('TTY failure occurs before any prompt, provider, database access or mutation', async () => {
  const f = fixture({ requireInteractiveTerminal: () => { throw new Error(sensitiveText); } });
  await safeFailure(saasPlatformMfaEnroll(f.dependencies), /interactive TTY/);
  assert.deepEqual(f.events, ['prompt-close']);
});

for (const missing of ['MODEL_ROUTER_SAAS_DATABASE_URL', 'MODEL_ROUTER_SAAS_KMS_PROVIDER'] as const) {
  test(`explicit ${missing} is mandatory and no unrelated URL/module fallback is used`, async () => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { ...f.dependencies.env,
      MODEL_ROUTER_SAAS_CONTROL_PLANE_DATABASE_URL: fixtureUrl,
      SAAS_PROVIDER_CREDENTIAL_SEAL_KMS_MODULE: 'must-not-fallback' };
    delete env[missing];
    await safeFailure(saasPlatformMfaEnroll({ ...f.dependencies, env }), new RegExp(missing));
    assert.deepEqual(f.events, ['tty', 'prompt-close']);
  });
}

test('invalid URL/module and bounded operator inputs fail before database access', async () => {
  const badUrl = fixture();
  await safeFailure(saasPlatformMfaEnroll({ ...badUrl.dependencies,
    env: { ...badUrl.dependencies.env, MODEL_ROUTER_SAAS_DATABASE_URL: `https://fixture.invalid/${token}` } }), /URL is invalid/);
  assert.ok(!badUrl.events.includes('database-create'));
  const badModule = fixture();
  await safeFailure(saasPlatformMfaEnroll({ ...badModule.dependencies,
    env: { ...badModule.dependencies.env, MODEL_ROUTER_SAAS_KMS_PROVIDER: 'https://fixture.invalid/provider' } }), /module is invalid/);
  for (const answers of [['invalid-email', operatorId, 'initial-enrollment'],
    ['owner@example.com', sensitiveText, 'initial-enrollment'], ['owner@example.com', operatorId, sensitiveText]]) {
    const f = fixture();
    f.answers.splice(0, 3, ...answers);
    await safeFailure(saasPlatformMfaEnroll(f.dependencies), /operator input/);
    assert.ok(!f.events.includes('database-create'));
    assert.deepEqual(f.output, []);
  }
});

test('cancelled or failed prompt never opens the database/provider and closes operator input', async () => {
  const f = fixture();
  f.dependencies.prompt!.ask = async () => { throw new Error(sensitiveText); };
  await safeFailure(saasPlatformMfaEnroll(f.dependencies), /operator input/);
  assert.deepEqual(f.events, ['tty', 'prompt-close']);
  assert.equal(f.issueCalls, 0);
});

for (const phase of ['create', 'ping', 'schema', 'privileges', 'state', 'provider', 'service'] as const) {
  test(`preflight ${phase} failure is sanitized and never issues a challenge`, async () => {
    const f = fixture();
    if (phase === 'create') f.dependencies.createDatabase = () => { throw new Error(sensitiveText); };
    if (phase === 'ping') f.database.ping = async () => { throw new Error(sensitiveText); };
    if (phase === 'schema') f.database.verifySchema = async () => { throw new Error(sensitiveText); };
    if (phase === 'privileges') f.dependencies.verifyControlPlanePrivileges = async () => { throw new Error(sensitiveText); };
    if (phase === 'state') f.database.query = async <Row>() => ({ rows: [{ initialized: false }] as Row[], rowCount: 1 });
    if (phase === 'provider') f.dependencies.loadKeyProvider = async () => { throw new Error(sensitiveText); };
    if (phase === 'service') f.dependencies.createAuthService = () => { throw new Error(sensitiveText); };
    await safeFailure(saasPlatformMfaEnroll(f.dependencies), /[Ee]nrollment was not issued|must already be initialized/);
    assert.equal(f.issueCalls, 0);
    assert.deepEqual(f.output, []);
    assert.ok(f.events.includes('prompt-close'));
    if (['create', 'ping', 'schema', 'privileges', 'state'].includes(phase)) assert.ok(!f.events.includes('provider-load'));
    if (phase !== 'create') assert.ok(f.events.includes('database-close'));
    if (phase === 'service') assert.ok(f.events.includes('provider-close'));
  });
}

test('uses the real reusable TOTP-only loader/readiness and forwards only the non-secret allowlist', async () => {
  const f = fixture();
  const calls: string[] = [];
  let seenFactory: { env: Readonly<Record<string, string | undefined>>; purpose: string } | undefined;
  f.dependencies.loadKeyProvider = (module, options) => loadCredentialKeyProvider(module, {
    ...options, importer: async () => ({
      createCredentialKeyProvider: async (input: typeof seenFactory) => {
        seenFactory = input;
        return {
          getCurrentKey: () => ({ keyId: 'fixture-totp-only', key: Buffer.alloc(32, 7) }),
          getKey: () => Buffer.alloc(32, 7),
          checkReady: async () => { calls.push('ready'); },
          close: async () => { calls.push('close'); },
        };
      },
      createRedisProvider: () => { throw new Error('Must not load Redis'); },
      createProviderCredentialSealingKms: () => { throw new Error('Must not load provider sealing'); },
      createGatewayProviderCredentialUnsealingKms: () => { throw new Error('Must not load gateway decrypt'); },
    }),
  });
  f.dependencies.createAuthService = () => ({ issueMfaEnrollmentToken: async () => ({ token, expiresAt }) });
  await saasPlatformMfaEnroll(f.dependencies);
  assert.equal(seenFactory?.purpose, 'platform-totp');
  assert.ok(Object.isFrozen(seenFactory?.env));
  assert.ok(Object.keys(seenFactory?.env ?? {}).every((key) => PLATFORM_MFA_PROVIDER_ENV_KEYS.some((allowed) => allowed === key)));
  assert.ok(!JSON.stringify(seenFactory).includes('fixture-provider-secret'));
  assert.ok(!JSON.stringify(seenFactory).includes('fixture-db-password'));
  assert.ok(!JSON.stringify(seenFactory).includes('fixture-cloud-secret'));
  assert.deepEqual(calls, ['ready', 'close']);
});

test('real loader closes a failed KMS readiness provider and never initializes auth or issues', async () => {
  const f = fixture();
  let closes = 0;
  f.dependencies.loadKeyProvider = (module, options) => loadCredentialKeyProvider(module, {
    ...options, importer: async () => ({ createCredentialKeyProvider: async () => ({
      getCurrentKey: () => { throw new Error('No key should be read'); }, getKey: () => undefined,
      checkReady: async () => { throw new Error(sensitiveText); }, close: async () => { closes += 1; },
    }) }),
  });
  await safeFailure(saasPlatformMfaEnroll(f.dependencies), /KMS readiness failed/);
  assert.equal(closes, 1);
  assert.ok(!f.events.includes('service-create'));
  assert.ok(f.events.includes('database-close'));
});

for (const denied of [new PlatformAuthError(403, 'MFA_ENROLLMENT_UNAVAILABLE'),
  new PlatformAuthError(409, 'MFA_ENROLLMENT_UNAVAILABLE'), new PlatformAuthError(503, 'MFA_UNAVAILABLE'),
  new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR'), new Error(sensitiveText)]) {
  test('service eligibility/pending/concurrency/storage failure is sanitized, with no retries or output', async () => {
    const f = fixture();
    let attempts = 0;
    f.dependencies.createAuthService = () => ({ issueMfaEnrollmentToken: async () => { attempts += 1; throw denied; } });
    await safeFailure(saasPlatformMfaEnroll(f.dependencies), /denied|unavailable|outcome is unknown/);
    assert.equal(attempts, 1);
    assert.deepEqual(f.output, []);
    assert.ok(f.events.includes('provider-close') && f.events.includes('database-close') && f.events.includes('prompt-close'));
  });
}

test('terminal delivery failure after committed issuance never remints and never repeats the token in an error', async () => {
  const f = fixture();
  let writes = 0;
  f.dependencies.writeToTerminal = () => { writes += 1; throw new Error(sensitiveText); };
  await safeFailure(saasPlatformMfaEnroll(f.dependencies), /challenge was issued.*Do not repeat/);
  assert.equal(f.issueCalls, 1);
  assert.equal(writes, 1);
  assert.deepEqual(f.events.slice(-3), ['provider-close', 'database-close', 'prompt-close']);
});

test('TTY loss before issuance prevents mutation; TTY loss after issuance prevents redirected secret output', async () => {
  for (const failAt of [2, 3]) {
    const f = fixture();
    let checks = 0;
    f.dependencies.requireInteractiveTerminal = () => { checks += 1; if (checks === failAt) throw new Error(sensitiveText); };
    await safeFailure(saasPlatformMfaEnroll(f.dependencies), failAt === 2 ? /enrollment was not issued/ : /challenge was issued/);
    assert.equal(f.issueCalls, failAt === 2 ? 0 : 1);
    assert.deepEqual(f.output, []);
  }
});

for (const resource of ['provider', 'database', 'prompt'] as const) {
  test(`cleanup ${resource} failure preserves single delivered handoff and attempts all closes`, async () => {
    const f = fixture();
    if (resource === 'provider') f.provider.close = async () => { f.events.push('provider-close'); throw new Error(sensitiveText); };
    if (resource === 'database') f.database.close = async () => { f.events.push('database-close'); throw new Error(sensitiveText); };
    if (resource === 'prompt') f.dependencies.prompt!.close = async () => { f.events.push('prompt-close'); throw new Error(sensitiveText); };
    await safeFailure(saasPlatformMfaEnroll(f.dependencies), /issued and displayed.*Do not repeat/);
    assert.equal(f.issueCalls, 1);
    assert.equal(f.output.length, 1);
    assert.deepEqual(f.events.slice(-3), ['provider-close', 'database-close', 'prompt-close']);
  });
}

const ISSUANCE_WRITER_SQL = 'SELECT pg_advisory_xact_lock(1396788563, 46)';
const ISSUANCE_USER_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';

/** Only the real issuance/audit seam is exercised; no credential secrets, sessions, roles or init facts are mutated. */
class IssuanceDatabase implements SaasDatabase {
  candidate = true;
  eligible = true;
  verified = false;
  pending = false;
  auditFails = false;
  auditMissing = false;
  globalWriterBusy = false;
  authorizationBusy = false;
  onQuery: ((statement: string) => void) | undefined;
  readonly userId = '00000000-0000-4000-8000-000000000010';
  readonly queries: { sql: string; values: readonly unknown[] }[] = [];
  tokens: readonly unknown[][] = [];
  audits: readonly unknown[][] = [];
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.queries.push({ sql, values });
    let rows: unknown[] = [];
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.onQuery?.(normalized);
    if ((normalized === ISSUANCE_WRITER_SQL && this.globalWriterBusy)
      || (normalized === ISSUANCE_USER_SQL && this.authorizationBusy)) {
      throw Object.assign(new Error(sensitiveText), { code: '55P03' });
    }
    if (normalized === ISSUANCE_WRITER_SQL) {
      assert.deepEqual(values, []);
      rows = [];
    } else if (normalized === ISSUANCE_USER_SQL) {
      assert.deepEqual(values, [this.userId]);
      rows = [];
    } else if (normalized.startsWith('SET ')) rows = [];
    else if (normalized.startsWith('SELECT id FROM saas_users')) rows = this.candidate ? [{ id: this.userId }] : [];
    else if (normalized.startsWith('SELECT u.id')) rows = this.eligible ? [{ id: this.userId }] : [];
    else if (normalized.startsWith('SELECT id FROM saas_mfa_credentials')) rows = this.verified ? [{ id: 'verified-fixture' }] : [];
    else if (normalized.startsWith('SELECT id FROM saas_platform_mfa_enrollment_tokens')) rows = this.pending ? [{ id: 'pending-fixture' }] : [];
    else if (normalized.startsWith('INSERT INTO saas_platform_mfa_enrollment_tokens')) {
      this.tokens = [...this.tokens, [...values]];
      this.pending = true;
    } else if (normalized.startsWith('INSERT INTO saas_audit_events')) {
      if (this.auditFails) throw new Error(sensitiveText);
      this.audits = [...this.audits, [...values]];
      rows = this.auditMissing ? [] : [{ id: values[0] }];
    } else throw new Error('Unexpected issuance query');
    return { rows: rows as Row[], rowCount: rows.length };
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const before = { tokens: this.tokens, audits: this.audits, pending: this.pending };
    try { return await work(this); }
    catch (cause) { Object.assign(this, before); throw cause; }
  }
  async migrate() { throw new Error('No migrations'); }
  async ping() {}
  async verifySchema() {}
  async close() {}
}
function auditedService(database: IssuanceDatabase): PlatformAdminAuthService {
  return new PlatformAdminAuthService(database, {
    getCurrentKey: () => { throw new Error('Token issuance does not read keys'); }, getKey: () => undefined,
  }, { now: () => new Date('2030-01-01T00:00:00.000Z') });
}

test('real service commits token digest and immutable issuance audit atomically, without inventing a user actor', async () => {
  const database = new IssuanceDatabase();
  const enrollment = await auditedService(database).issueMfaEnrollmentToken('owner@example.com', audit);
  assert.equal(database.tokens.length, 1);
  assert.equal(database.audits.length, 1);
  assert.equal(database.tokens[0][2], createHash('sha256').update(enrollment.token).digest('hex'));
  assert.ok(!JSON.stringify(database.tokens).includes(enrollment.token));
  assert.ok(!JSON.stringify(database.audits).includes(enrollment.token));
  assert.ok(!JSON.stringify(database.audits).includes('owner@example.com'));
  assert.equal(database.audits[0][1], 'platform_mfa.enrollment_token.issued');
  assert.equal(database.audits[0][3], database.userId);
  assert.equal(database.audits[0][6], operatorId);
  const statement = database.queries.find(({ sql }) => sql.includes('INSERT INTO saas_audit_events'))?.sql ?? '';
  assert.match(statement, /VALUES \(\$1, NULL, NULL/);
  assert.match(statement, /'actor_kind', 'trusted_operator'/);
  assert.match(statement, /'audience', 'platform'/);
  assert.match(statement, /'database_role', current_user/);
  assert.ok(!database.queries.some(({ sql }) => /UPDATE|DELETE|TRUNCATE|saas_platform_sessions|saas_platform_state/.test(sql)));
  const isolation = database.queries.findIndex(({ sql }) => sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  const writer = database.queries.findIndex(({ sql }) => sql === ISSUANCE_WRITER_SQL);
  const userFence = database.queries.findIndex(({ sql }) => sql === ISSUANCE_USER_SQL);
  const role = database.queries.findIndex(({ sql }) => sql.includes('SELECT u.id'));
  const pending = database.queries.findIndex(({ sql }) => sql.includes('SELECT id FROM saas_platform_mfa_enrollment_tokens'));
  const tokenInsert = database.queries.findIndex(({ sql }) => sql.includes('INSERT INTO saas_platform_mfa_enrollment_tokens'));
  const auditInsert = database.queries.findIndex(({ sql }) => sql.includes('INSERT INTO saas_audit_events'));
  assert.ok(isolation >= 0 && isolation < writer && writer < userFence && userFence < role
    && role < pending && pending < tokenInsert && tokenInsert < auditInsert,
  'READ COMMITTED -> 046 global writer -> exclusive user -> fresh eligibility/pending -> token -> audit');
  assert.equal(database.queries.filter(({ sql }) => sql === ISSUANCE_WRITER_SQL).length, 1);
  assert.equal(database.queries.filter(({ sql }) => sql === ISSUANCE_USER_SQL).length, 1);
  assert.ok(!database.queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock_shared')
    || sql.includes('saas_platform_authorization_fence_users') || sql.includes('saas_platform_authorization_writer_statement')),
  'issuance must not upgrade a shared lock or execute schema helpers');
});

for (const denied of ['missing', 'disabled', 'nonadmin', 'verified', 'pending'] as const) {
  test(`real service ${denied} retains existing eligibility checks and commits only the denial audit`, async () => {
    const database = new IssuanceDatabase();
    if (denied === 'missing') database.candidate = false;
    if (denied === 'disabled' || denied === 'nonadmin') database.eligible = false;
    if (denied === 'verified') database.verified = true;
    if (denied === 'pending') database.pending = true;
    await assert.rejects(auditedService(database).issueMfaEnrollmentToken('owner@example.com', audit),
      (cause: unknown) => cause instanceof PlatformAuthError && cause.code === 'MFA_ENROLLMENT_UNAVAILABLE');
    assert.equal(database.tokens.length, 0);
    assert.equal(database.audits.length, 1);
    assert.equal(database.audits[0][1], 'platform_mfa.enrollment_token.denied');
    assert.ok(!JSON.stringify(database.audits).includes('owner@example.com'));
    if (denied === 'disabled' || denied === 'nonadmin') {
      const eligibility = database.queries.find(({ sql }) => sql.includes('SELECT u.id'))?.sql ?? '';
      assert.match(eligibility, /u\.disabled_at IS NULL AND u\.anonymized_at IS NULL/);
      assert.match(eligibility, /eligible_role\.role IN/);
      assert.match(eligibility, /unsupported_role\.role NOT IN/);
    }
  });
}

test('audit error or absent persistence confirmation rolls back issuance and no challenge is returned', async () => {
  for (const mode of ['auditFails', 'auditMissing'] as const) {
    const database = new IssuanceDatabase();
    database[mode] = true;
    await assert.rejects(auditedService(database).issueMfaEnrollmentToken('owner@example.com', audit),
      (cause: unknown) => cause instanceof PlatformAuthError && cause.code === 'PLATFORM_AUTH_STORAGE_ERROR');
    assert.equal(database.tokens.length, 0);
    assert.equal(database.audits.length, 0);
    assert.equal(database.pending, false);
  }
});

for (const blocked of ['global-writer', 'exclusive-user'] as const) {
  test(`${blocked} issuance contention is sanitized, never retried and creates no token/audit mutation`, async () => {
    const database = new IssuanceDatabase();
    database.globalWriterBusy = blocked === 'global-writer';
    database.authorizationBusy = blocked === 'exclusive-user';
    await assert.rejects(auditedService(database).issueMfaEnrollmentToken('owner@example.com', audit), (cause: unknown) => {
      assert.ok(cause instanceof PlatformAuthError);
      assert.equal(cause.code, 'PLATFORM_AUTH_STORAGE_ERROR');
      assert.equal(cause.cause, undefined);
      assert.ok(!cause.message.includes(sensitiveText));
      return true;
    });
    assert.equal(database.queries.filter(({ sql }) => sql === ISSUANCE_WRITER_SQL).length, 1);
    assert.equal(database.queries.filter(({ sql }) => sql === ISSUANCE_USER_SQL).length, blocked === 'global-writer' ? 0 : 1);
    assert.ok(!database.queries.some(({ sql }) => sql.includes('SELECT u.id')
      || sql.includes('SELECT id FROM saas_mfa_credentials') || sql.includes('SELECT id FROM saas_platform_mfa_enrollment_tokens')),
    'a failed fence must prevent unfenced authority/pending reads');
    assert.equal(database.tokens.length, 0);
    assert.equal(database.audits.length, 0);
  });
}

test('fresh eligibility denial after the issuance fences commits one audit and never mints a challenge', async () => {
  const database = new IssuanceDatabase();
  database.onQuery = (statement) => { if (statement === ISSUANCE_USER_SQL) database.eligible = false; };
  await assert.rejects(auditedService(database).issueMfaEnrollmentToken('owner@example.com', audit),
    (cause: unknown) => cause instanceof PlatformAuthError && cause.code === 'MFA_ENROLLMENT_UNAVAILABLE' && cause.status === 403);
  const writer = database.queries.findIndex(({ sql }) => sql === ISSUANCE_WRITER_SQL);
  const userFence = database.queries.findIndex(({ sql }) => sql === ISSUANCE_USER_SQL);
  const eligibility = database.queries.findIndex(({ sql }) => sql.includes('SELECT u.id'));
  assert.ok(writer >= 0 && writer < userFence && userFence < eligibility);
  assert.equal(database.tokens.length, 0);
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0][1], 'platform_mfa.enrollment_token.denied');
  assert.equal(database.audits[0][8], 'target-unavailable');
  assert.ok(!JSON.stringify(database.audits).includes('owner@example.com'));
});

test('invalid operator audit attestation fails before database access; pending denial never remints', async () => {
  const database = new IssuanceDatabase();
  const service = auditedService(database);
  await assert.rejects(service.issueMfaEnrollmentToken('owner@example.com', { ...audit, operatorId: sensitiveText }),
    (cause: unknown) => cause instanceof PlatformAuthError && cause.code === 'INVALID_INPUT');
  assert.equal(database.queries.length, 0);
  await service.issueMfaEnrollmentToken('owner@example.com', audit);
  await assert.rejects(service.issueMfaEnrollmentToken('owner@example.com', audit),
    (cause: unknown) => cause instanceof PlatformAuthError && cause.code === 'MFA_ENROLLMENT_UNAVAILABLE');
  assert.equal(database.tokens.length, 1);
  assert.equal(database.audits.length, 2);
});

test('CLI has no argv email/token/stdin bypass and the existing HTTP surface has no mint capability', async () => {
  const help = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:platform-mfa-enroll', '--help'],
    { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
  assert.match(help.stdout, /secure operator TTY/);
  assert.match(help.stdout, /--allow-local-plaintext/);
  assert.match(help.stdout, /workload identity/);
  assert.match(help.stdout, /fixed non-secret region\/deployment\/workload labels/);
  assert.match(help.stdout, /no embedded AES keys/);
  assert.match(help.stdout, /Remote PostgreSQL requires verified TLS/);
  assert.ok(!/--email|--token|--test-stdin|--password/.test(help.stdout));
  const http = await readFile('src/saas/platform/auth/http.ts', 'utf8');
  assert.ok(!http.includes('issueMfaEnrollmentToken'));
});

test('real non-interactive CLI fails before database/provider work and prints no challenge or configuration', async () => {
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'saas:platform-mfa-enroll'],
    { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production',
      MODEL_ROUTER_SAAS_DATABASE_URL: fixtureUrl, MODEL_ROUTER_SAAS_KMS_PROVIDER: 'must-not-import-fixture' } }),
  (cause: unknown) => {
    const failure = cause as Error & { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /interactive TTY required/);
    assert.equal(failure.stdout, '');
    assert.ok(!failure.stderr.includes(fixtureUrl));
    assert.ok(!failure.stderr.includes('must-not-import-fixture'));
    return true;
  });
});
