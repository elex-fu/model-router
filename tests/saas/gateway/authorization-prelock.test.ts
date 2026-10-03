import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresSaasRequestAdmissionAuthorizationPrelock,
  SaasAdmissionAuthorizationError,
  type SaasRequestAdmissionAuthenticatedKey,
} from '../../../src/saas/gateway/authorization-prelock.js';
import type { CreateRequestInput } from '../../../src/saas/metering/types.js';

type Row = Record<string, unknown>;

interface AuthorityRows {
  tenant: Row[];
  project: Row[];
  policy: Row[];
  principal: Row[];
  tenantMembership: Row[];
  projectMembership: Row[];
  key: Row[];
  entitlementAndProfile: Row[];
  clock: Row[];
}

const now = '2026-09-28T00:00:00.000Z';

function request(overrides: Partial<CreateRequestInput> = {}): CreateRequestInput {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 3,
    modelScopeVersion: 7,
    supplyMode: 'byok',
    principalKind: 'member',
    principalId: 'user-a',
    authzVersion: 11,
    entitlementVersion: 5,
    configVersion: 2,
    projectPolicyVersion: 1,
    publicModel: 'model-a',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    requestFingerprint: 'a'.repeat(64),
    requestFingerprintVersion: 'canonical-v1',
    idempotencyKey: 'retry-key',
    customerPriceVersion: null,
    ...overrides,
  };
}

function authenticatedKey(overrides: Partial<SaasRequestAdmissionAuthenticatedKey['authorization']> = {}) {
  return {
    authorization: {
      keyId: 'key-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principalKind: 'member' as const,
      principalId: 'user-a',
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok' as const,
      modelScopes: ['model-a', 'model-b'],
      authzVersion: 11,
      modelScopeVersion: 7,
      entitlementAuthzVersion: 5,
      supplyProfileAuthzVersion: 3,
      ...overrides,
    },
  } satisfies SaasRequestAdmissionAuthenticatedKey;
}

function validRows(): AuthorityRows {
  return {
    tenant: [{ id: 'tenant-a', status: 'active' }],
    project: [
      {
        tenant_id: 'tenant-a',
        id: 'project-a',
        inference_policy_version: 1,
        inference_policy_status: 'active',
      },
    ],
    policy: [
      {
        tenant_id: 'tenant-a',
        project_id: 'project-a',
        version: 1,
        status: 'active',
      },
    ],
    principal: [{ id: 'user-a', disabled_at: null, anonymized_at: null }],
    tenantMembership: [
      { tenant_id: 'tenant-a', user_id: 'user-a', role: 'developer', status: 'active', revoked_at: null },
    ],
    projectMembership: [
      {
        tenant_id: 'tenant-a',
        project_id: 'project-a',
        user_id: 'user-a',
        role: 'developer',
        status: 'active',
        revoked_at: null,
      },
    ],
    key: [
      {
        id: 'key-a',
        tenant_id: 'tenant-a',
        project_id: 'project-a',
        principal_user_id: 'user-a',
        execution_principal_type: 'member',
        execution_principal_id: 'user-a',
        entitlement_id: 'entitlement-a',
        supply_profile_id: 'profile-a',
        supply_mode: 'byok',
        model_scopes: ['model-a', 'model-b'],
        status: 'active',
        revoked_at: null,
        expires_at: '2026-09-28T01:00:00.000Z',
        authz_version: 11,
        model_scope_version: 7,
        entitlement_authz_version: 5,
        supply_profile_authz_version: 3,
      },
    ],
    entitlementAndProfile: [
      {
        entitlement_id: 'entitlement-a',
        entitlement_tenant_id: 'tenant-a',
        entitlement_project_id: 'project-a',
        entitlement_profile_id: 'profile-a',
        entitlement_supply_mode: 'byok',
        entitlement_status: 'active',
        entitlement_model_scopes: ['model-a', 'model-b'],
        entitlement_authz_version: 5,
        entitlement_effective_at: '2026-09-27T00:00:00.000Z',
        entitlement_expires_at: null,
        profile_id: 'profile-a',
        profile_tenant_id: 'tenant-a',
        profile_status: 'active',
        profile_model_scopes: ['model-a', 'model-b'],
        profile_authz_version: 3,
      },
    ],
    clock: [{ now }],
  };
}

class RecordingExecutor implements SqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(
    readonly rows: AuthorityRows,
    private readonly failure?: string,
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.statements.push({ sql, values });
    const normalized = sql.trim().toLowerCase();
    if (this.failure && normalized.includes(this.failure)) throw new Error('injected database failure');

    let rows: Row[];
    if (normalized.includes('pg_advisory_xact_lock_shared')) rows = [];
    else if (normalized.includes('from saas_tenants')) rows = this.rows.tenant;
    else if (normalized.includes('from saas_projects')) rows = this.rows.project;
    else if (normalized.includes('from saas_project_inference_policy_versions')) rows = this.rows.policy;
    else if (normalized.includes('from saas_users')) rows = this.rows.principal;
    else if (normalized.includes('from saas_project_memberships')) rows = this.rows.projectMembership;
    else if (normalized.includes('from saas_memberships')) rows = this.rows.tenantMembership;
    else if (normalized.includes('from saas_api_keys')) rows = this.rows.key;
    else if (normalized.includes('from saas_project_entitlements')) rows = this.rows.entitlementAndProfile;
    else if (normalized.includes('clock_timestamp()')) rows = this.rows.clock;
    else throw new Error(`unexpected SQL: ${sql}`);

    return { rows: rows as RowType[], rowCount: rows.length };
  }
}

function input(executor: SqlExecutor, currentRequest = request(), currentKey = authenticatedKey()) {
  return { executor, request: currentRequest, authenticatedKey: currentKey };
}

function makeExecutor(overrides: Partial<AuthorityRows> = {}, failure?: string): RecordingExecutor {
  return new RecordingExecutor({ ...validRows(), ...overrides }, failure);
}

function authorityStep(sql: string, values: readonly unknown[] = []): string {
  const normalized = sql.toLowerCase();
  if (normalized.includes('saas-authz:tenant:')) return 'tenant-fence';
  if (normalized.includes('saas-authz:project:')) return 'project-fence';
  if (normalized.includes('pg_advisory_xact_lock_shared') && String(values[0]).startsWith('saas-authz:api-key:')) {
    return 'key-fence';
  }
  if (normalized.includes('pg_advisory_xact_lock_shared')) return 'user-fence';
  if (normalized.includes('from saas_tenants')) return 'tenant';
  if (normalized.includes('from saas_projects')) return 'project';
  if (normalized.includes('from saas_project_inference_policy_versions')) return 'policy';
  if (normalized.includes('from saas_users')) return 'principal';
  if (normalized.includes('from saas_memberships')) return 'tenant-membership';
  if (normalized.includes('from saas_project_memberships')) return 'project-membership';
  if (normalized.includes('from saas_api_keys')) return 'key';
  if (normalized.includes('from saas_project_entitlements')) return 'entitlement-profile';
  if (normalized.includes('clock_timestamp()')) return 'database-clock';
  return 'unexpected';
}

async function assertDenied(operation: Promise<void>, message?: RegExp): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof SaasAdmissionAuthorizationError);
    assert.equal(error.code, 'authorization_denied');
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('prelock fences all SELECT-only authority before separate plain reads', async () => {
  const executor = makeExecutor();
  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();

  await prelock.prelock(input(executor));

  assert.deepEqual(
    executor.statements.map(({ sql, values }) => ({
      sql: sql.replace(/\s+/g, ' ').trim(),
      values: [...values],
    })),
    [
      {
        sql: "SELECT pg_advisory_xact_lock_shared( hashtextextended('saas-authz:tenant:' || $1::uuid::text, 0) )",
        values: ['tenant-a'],
      },
      { sql: 'SELECT id, status FROM saas_tenants WHERE id = $1 LIMIT 2', values: ['tenant-a'] },
      {
        sql: "SELECT pg_advisory_xact_lock_shared( hashtextextended('saas-authz:project:' || $1::uuid::text || ':' || $2::uuid::text, 0) )",
        values: ['tenant-a', 'project-a'],
      },
      {
        sql: 'SELECT tenant_id, id, inference_policy_version, inference_policy_status FROM saas_projects WHERE tenant_id = $1 AND id = $2 LIMIT 2',
        values: ['tenant-a', 'project-a'],
      },
      {
        sql: 'SELECT tenant_id, project_id, version, status FROM saas_project_inference_policy_versions WHERE tenant_id = $1 AND project_id = $2 AND version = $3 LIMIT 2',
        values: ['tenant-a', 'project-a', '1'],
      },
      {
        sql: 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text, 0))',
        values: ['user-a'],
      },
      {
        sql: 'SELECT id, disabled_at, anonymized_at FROM saas_users WHERE id = $1 LIMIT 2',
        values: ['user-a'],
      },
      {
        sql: 'SELECT tenant_id, user_id, role, status, revoked_at FROM saas_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 2',
        values: ['tenant-a', 'user-a'],
      },
      {
        sql: 'SELECT tenant_id, project_id, user_id, role, status, revoked_at FROM saas_project_memberships WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3 LIMIT 2',
        values: ['tenant-a', 'project-a', 'user-a'],
      },
      {
        sql: 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))',
        values: ['saas-authz:api-key:74656e616e742d61:70726f6a6563742d61:6b65792d61'],
      },
      {
        sql: 'SELECT id, tenant_id, project_id, principal_user_id, execution_principal_type, execution_principal_id, entitlement_id, supply_profile_id, supply_mode, model_scopes, status, revoked_at, expires_at, authz_version, model_scope_version, entitlement_authz_version, supply_profile_authz_version FROM saas_api_keys WHERE tenant_id = $1 AND project_id = $2 AND id = $3 LIMIT 2',
        values: ['tenant-a', 'project-a', 'key-a'],
      },
      { sql: 'SELECT clock_timestamp() AS now', values: [] },
    ],
  );

  assert.deepEqual(
    executor.statements.map(({ sql, values }) => authorityStep(sql, values)),
    [
      'tenant-fence',
      'tenant',
      'project-fence',
      'project',
      'policy',
      'user-fence',
      'principal',
      'tenant-membership',
      'project-membership',
      'key-fence',
      'key',
      'database-clock',
    ],
  );
  const rowLockedSql = executor.statements.filter(({ sql }) => /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i.test(sql));
  assert.equal(rowLockedSql.length, 0);
  assert.doesNotMatch(
    executor.statements.find(({ sql }) => /saas_project_inference_policy_versions/i.test(sql))?.sql ?? '',
    /FOR SHARE|FOR UPDATE|FOR KEY SHARE/i,
  );
  for (const table of ['saas_tenants', 'saas_projects', 'saas_users', 'saas_memberships', 'saas_project_memberships']) {
    assert.doesNotMatch(
      executor.statements.find(({ sql }) => sql.toLowerCase().includes(`from ${table}`))?.sql ?? '',
      /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i,
    );
  }
  assert.match(executor.statements.at(-1)?.sql ?? '', /clock_timestamp\(\)/i);
  assert.equal(executor.statements.at(-1)?.values.length, 0);
  assert.match(executor.statements.find((statement) => /saas_users/i.test(statement.sql))?.sql ?? '', /anonymized_at/i);
  assert.match(executor.statements.find((statement) => /saas_api_keys/i.test(statement.sql))?.sql ?? '', /revoked_at/i);
  const allSql = executor.statements.map(({ sql }) => sql).join('\n');
  assert.doesNotMatch(allSql, /statement_timestamp\(\)|membership\.expires_at/i);
  assert.doesNotMatch(allSql, /saas_project_entitlements|saas_supply_profiles/i);
});

test('prelock rejects request/snapshot identity, scope, and epoch mismatches before any SQL', async () => {
  const cases: Array<{
    label: string;
    currentRequest?: Partial<CreateRequestInput>;
    currentKey?: Partial<SaasRequestAdmissionAuthenticatedKey['authorization']>;
  }> = [
    { label: 'tenant identity', currentRequest: { tenantId: 'tenant-b' } },
    { label: 'key identity', currentRequest: { proxyKeyId: 'key-b' } },
    { label: 'principal identity', currentKey: { principalId: 'user-b' } },
    { label: 'requested scope', currentRequest: { publicModel: 'model-c' } },
    { label: 'key scopes', currentKey: { modelScopes: ['model-b'] } },
    { label: 'key epoch', currentKey: { authzVersion: 12 } },
    { label: 'entitlement epoch', currentRequest: { entitlementVersion: 6 } },
    { label: 'profile epoch', currentRequest: { supplyProfileVersion: 4 } },
    { label: 'model-scope epoch', currentRequest: { modelScopeVersion: 8 } },
    { label: 'project policy version', currentRequest: { projectPolicyVersion: 2 } },
  ];

  for (const current of cases) {
    const executor = makeExecutor();
    const currentRequest = request(current.currentRequest);
    const currentKey = authenticatedKey(current.currentKey);
    await assertDenied(prelockCall(executor, currentRequest, currentKey), /mismatch|scope/);
    if (current.label === 'project policy version') {
      assert.equal(executor.statements.length, 4, `${current.label} did not reach the project policy head`);
    } else {
      assert.equal(executor.statements.length, 0, `${current.label} opened a SQL query`);
    }
  }
});

async function prelockCall(
  executor: RecordingExecutor,
  currentRequest: CreateRequestInput,
  currentKey: SaasRequestAdmissionAuthenticatedKey,
): Promise<void> {
  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();
  return prelock.prelock(input(executor, currentRequest, currentKey));
}

test('prelock rejects disabled, anonymized, revoked, and non-inference memberships', async () => {
  const cases: Array<{ label: string; rows: Partial<AuthorityRows>; message: RegExp }> = [
    {
      label: 'disabled user',
      rows: { principal: [{ id: 'user-a', disabled_at: now, anonymized_at: null }] },
      message: /disabled/,
    },
    {
      label: 'anonymized user',
      rows: { principal: [{ id: 'user-a', disabled_at: null, anonymized_at: now }] },
      message: /anonymized/,
    },
    {
      label: 'revoked tenant membership',
      rows: {
        tenantMembership: [
          { tenant_id: 'tenant-a', user_id: 'user-a', role: 'developer', status: 'revoked', revoked_at: now },
        ],
      },
      message: /tenant membership.*active/,
    },
    {
      label: 'billing tenant membership',
      rows: {
        tenantMembership: [
          { tenant_id: 'tenant-a', user_id: 'user-a', role: 'billing', status: 'active', revoked_at: null },
        ],
      },
      message: /tenant membership role/,
    },
    {
      label: 'viewer project membership',
      rows: {
        projectMembership: [
          {
            tenant_id: 'tenant-a',
            project_id: 'project-a',
            user_id: 'user-a',
            role: 'viewer',
            status: 'active',
            revoked_at: null,
          },
        ],
      },
      message: /project membership role/,
    },
  ];

  for (const current of cases) {
    const executor = makeExecutor(current.rows);
    await assertDenied(prelockCall(executor, request(), authenticatedKey()), current.message);
    assert.ok(executor.statements.length >= 3, `${current.label} did not reach its authority row`);
  }
});

test('prelock rejects revoked, expired, or stale persisted keys after policy authority', async () => {
  const cases: Array<{ rows: Partial<AuthorityRows>; message: RegExp }> = [
    {
      rows: { key: [{ ...validRows().key[0], status: 'revoked', revoked_at: now }] },
      message: /API key is not active/,
    },
    {
      rows: { key: [{ ...validRows().key[0], status: 'active', revoked_at: now }] },
      message: /API key is not active/,
    },
    {
      rows: { key: [{ ...validRows().key[0], expires_at: '2026-09-27T23:59:59.000Z' }] },
      message: /API key is expired/,
    },
    {
      rows: { key: [{ ...validRows().key[0], authz_version: 12 }] },
      message: /key\.authz_version/,
    },
  ];

  for (const current of cases) {
    const executor = makeExecutor(current.rows);
    await assertDenied(prelockCall(executor, request(), authenticatedKey()), current.message);
    assert.doesNotMatch(
      executor.statements.map(({ sql }) => sql).join('\n'),
      /saas_project_entitlements|saas_supply_profiles/i,
    );
  }
});

test('entitlement supersession remains outside the prelock boundary', async () => {
  const executor = makeExecutor({
    entitlementAndProfile: [
      {
        ...validRows().entitlementAndProfile[0],
        entitlement_status: 'superseded',
        entitlement_superseded_at: '2026-09-27T00:00:00.000Z',
      },
    ],
  });
  await prelockCall(executor, request(), authenticatedKey());
  assert.doesNotMatch(
    executor.statements.map(({ sql }) => sql).join('\n'),
    /saas_project_entitlements|saas_supply_profiles/i,
  );
});

test('prelock fails closed for suspended, disabled, or missing project policy rows', async () => {
  const cases: Array<{ rows: Partial<AuthorityRows>; message: RegExp }> = [
    {
      rows: { project: [{ ...validRows().project[0], inference_policy_status: 'suspended' }] },
      message: /project inference policy is not active/,
    },
    {
      rows: { project: [{ ...validRows().project[0], inference_policy_status: 'disabled' }] },
      message: /project inference policy is not active/,
    },
    { rows: { policy: [] }, message: /project inference policy is missing or ambiguous/ },
  ];

  for (const current of cases) {
    const executor = makeExecutor(current.rows);
    await assertDenied(prelockCall(executor, request(), authenticatedKey()), current.message);
    assert.doesNotMatch(executor.statements.map(({ sql }) => sql).join('\n'), /saas_api_keys|clock_timestamp\(\)/i);
  }
});

test('replay-shaped admission still revalidates the current project policy before visibility', async () => {
  const executor = makeExecutor({
    policy: [{ ...validRows().policy[0], status: 'suspended' }],
  });

  await assertDenied(
    prelockCall(executor, request({ idempotencyKey: 'same-retry-key' }), authenticatedKey()),
    /project inference policy is not active/,
  );
  assert.deepEqual(
    executor.statements.map(({ sql }) => authorityStep(sql)),
    ['tenant-fence', 'tenant', 'project-fence', 'project', 'policy'],
  );
});

test('project-service prelock checks project policy and key binding without creator membership', async () => {
  const rows = validRows();
  rows.key = [
    {
      ...rows.key[0],
      principal_user_id: null,
      execution_principal_type: 'project_service',
      execution_principal_id: 'project-a',
    },
  ];
  const executor = makeExecutor(rows);
  const currentRequest = request({ principalKind: 'project_service', principalId: 'project-a' });
  const currentKey = authenticatedKey({ principalKind: 'project_service', principalId: 'project-a' });

  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();
  await prelock.prelock(input(executor, currentRequest, currentKey));
  assert.deepEqual(
    executor.statements.map(({ sql, values }) => authorityStep(sql, values)),
    ['tenant-fence', 'tenant', 'project-fence', 'project', 'policy', 'key-fence', 'key', 'database-clock'],
  );
  assert.equal(
    executor.statements.some(({ sql }) => /saas_users|saas_memberships/i.test(sql)),
    false,
  );
  assert.equal(executor.statements.at(-1)?.sql.includes('clock_timestamp()'), true);
});

test('prelock wraps database failures as fail-closed storage errors', async () => {
  const executor = makeExecutor({}, 'saas_api_keys');
  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();

  await assert.rejects(
    prelock.prelock(input(executor)),
    (error: unknown) => error instanceof SaasAdmissionAuthorizationError && error.code === 'storage_failure',
  );
});

test('prelock waits for the key fence before reading revocation, epochs, or expiry', async () => {
  for (const mutation of [
    { status: 'revoked', revoked_at: now },
    { authz_version: 12 },
    { model_scope_version: 8 },
    { entitlement_authz_version: 6 },
    { supply_profile_authz_version: 4 },
    { expires_at: now },
  ]) {
    const executor = makeExecutor();
    let releaseFence!: () => void;
    let reachedFence!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFence = resolve; });
    const reached = new Promise<void>((resolve) => { reachedFence = resolve; });
    const waitingExecutor: SqlExecutor = {
      async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
        if (authorityStep(sql, values) === 'key-fence') {
          reachedFence();
          await blocked;
        }
        return executor.query<RowType>(sql, values);
      },
    };
    const operation = new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock(input(waitingExecutor));
    const rejection = assertDenied(operation, /not active|mismatch|expired/);
    await reached;
    assert.equal(executor.statements.some(({ sql }) => /FROM saas_api_keys|clock_timestamp\(\)/i.test(sql)), false);
    executor.rows.key = [{ ...executor.rows.key[0], ...mutation }];
    releaseFence();
    await rejection;
    const steps = executor.statements.map(({ sql, values }) => authorityStep(sql, values));
    assert.equal(steps.indexOf('key'), steps.indexOf('key-fence') + 1);
    if ('expires_at' in mutation) {
      assert.equal(steps.at(-1), 'database-clock');
    }
  }
});

test('prelock fails closed when the API-key advisory fence cannot be acquired', async () => {
  const executor = makeExecutor();
  const failingExecutor: SqlExecutor = {
    async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
      if (authorityStep(sql, values) === 'key-fence') throw new Error('injected fence failure');
      return executor.query<RowType>(sql, values);
    },
  };
  await assert.rejects(
    new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock(input(failingExecutor)),
    (error: unknown) => error instanceof SaasAdmissionAuthorizationError && error.code === 'storage_failure',
  );
  assert.equal(executor.statements.some(({ sql }) => /FROM saas_api_keys|clock_timestamp\(\)/i.test(sql)), false);
});

test('prelock checks expiry with the database clock after a fence wait even when the key is unchanged', async () => {
  const executor = makeExecutor();
  const expiresAt = validRows().key[0]?.expires_at;
  let releaseFence!: () => void;
  let reachedFence!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseFence = resolve; });
  const reached = new Promise<void>((resolve) => { reachedFence = resolve; });
  const waitingExecutor: SqlExecutor = {
    async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
      if (authorityStep(sql, values) === 'key-fence') {
        reachedFence();
        await blocked;
      }
      return executor.query<RowType>(sql, values);
    },
  };

  const operation = new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock(input(waitingExecutor));
  const rejection = assertDenied(operation, /API key is expired/);
  await reached;
  assert.equal(executor.statements.some(({ sql }) => /FROM saas_api_keys|clock_timestamp\(\)/i.test(sql)), false);
  // The persisted expiry does not change; wall-clock time reaches it while waiting.
  executor.rows.clock = [{ now: expiresAt }];
  releaseFence();
  await rejection;
  assert.equal(executor.rows.key[0]?.expires_at, expiresAt);
  assert.deepEqual(
    executor.statements.slice(-3).map(({ sql, values }) => authorityStep(sql, values)),
    ['key-fence', 'key', 'database-clock'],
  );
});
