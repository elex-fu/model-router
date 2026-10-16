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

/**
 * Fake executor for the two-statement prelock: one batched advisory-fence
 * statement (unnest over the ordered key list) and one merged authority-fact
 * read whose row carries each fact as the jsonb_agg aggregate the real
 * statement returns (an array of zero, one, or two row objects).
 */
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
    else if (normalized.includes('clock_timestamp()')) {
      rows = [
        {
          tenant: this.rows.tenant,
          project: this.rows.project,
          policy: this.rows.policy,
          principal_user: this.rows.principal,
          tenant_membership: this.rows.tenantMembership,
          project_membership: this.rows.projectMembership,
          api_key: this.rows.key,
          now: this.rows.clock[0]?.now,
        },
      ];
    } else throw new Error(`unexpected SQL: ${sql}`);

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
  if (normalized.includes('pg_advisory_xact_lock_shared')) return 'fence-batch';
  if (normalized.includes('clock_timestamp()')) return 'authority-read';
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

test('prelock takes one batched fence statement then one merged authority read', async () => {
  const executor = makeExecutor();
  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();

  await prelock.prelock(input(executor));

  assert.equal(executor.statements.length, 2, 'the prelock must be exactly two statements');
  const [fence, read] = executor.statements as [{ sql: string; values: unknown[] }, { sql: string; values: unknown[] }];
  assert.match(
    fence.sql,
    /pg_advisory_xact_lock_shared\(hashtextextended\(fence_key, 0\)\) from unnest\(\$1::text\[\]\) as fence_key/i,
  );
  // Explicit order: tenant -> project -> user -> API key (the API-key key is
  // KeyService/migration 050's UTF-8 hex business-layer key).
  assert.deepEqual(fence.values, [
    [
      'saas-authz:tenant:tenant-a',
      'saas-authz:project:tenant-a:project-a',
      'user-a',
      'saas-authz:api-key:74656e616e742d61:70726f6a6563742d61:6b65792d61',
    ],
  ]);
  assert.match(read.sql, /clock_timestamp\(\) as now/i);
  for (const table of [
    'saas_tenants',
    'saas_projects',
    'saas_project_inference_policy_versions',
    'saas_users',
    'saas_memberships',
    'saas_project_memberships',
    'saas_api_keys',
  ]) {
    assert.match(read.sql, new RegExp(`from ${table}`, 'i'), `${table} must be read in the merged statement`);
  }
  const rowLockedSql = executor.statements.filter(({ sql }) => /FOR (?:KEY )?(?:NO KEY )?UPDATE|FOR SHARE/i.test(sql));
  assert.equal(rowLockedSql.length, 0);
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
      // The mismatch is only visible in the merged authority read, so the
      // fence statement and the read statement have both been issued.
      assert.equal(executor.statements.length, 2, `${current.label} did not reach the authority read`);
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
      label: 'missing user',
      rows: { principal: [] },
      message: /principal is missing or ambiguous/,
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
    assert.equal(executor.statements.length, 2, `${current.label} did not reach the authority read`);
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
    assert.doesNotMatch(
      executor.statements.map(({ sql }) => sql).join('\n'),
      /saas_project_entitlements|saas_supply_profiles/i,
    );
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
    executor.statements.map(({ sql, values }) => authorityStep(sql, values)),
    ['fence-batch', 'authority-read'],
  );
});

test('project-service prelock validates the key binding without member authority', async () => {
  const rows = validRows();
  rows.key = [
    {
      ...rows.key[0],
      principal_user_id: null,
      execution_principal_type: 'project_service',
      execution_principal_id: 'project-a',
    },
  ];
  // The merged read fetches user/membership facts unconditionally, but a
  // project-service principal never validates them: even missing rows pass.
  rows.principal = [];
  rows.tenantMembership = [];
  rows.projectMembership = [];
  const executor = makeExecutor(rows);
  const currentRequest = request({ principalKind: 'project_service', principalId: 'project-a' });
  const currentKey = authenticatedKey({ principalKind: 'project_service', principalId: 'project-a' });

  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();
  await prelock.prelock(input(executor, currentRequest, currentKey));
  assert.deepEqual(
    executor.statements.map(({ sql, values }) => authorityStep(sql, values)),
    ['fence-batch', 'authority-read'],
  );
  // A project-service principal is not fenced on a user key.
  const fenceKeys = (executor.statements[0]?.values[0] ?? []) as string[];
  assert.deepEqual(fenceKeys, [
    'saas-authz:tenant:tenant-a',
    'saas-authz:project:tenant-a:project-a',
    'saas-authz:api-key:74656e616e742d61:70726f6a6563742d61:6b65792d61',
  ]);
});

test('prelock wraps database failures as fail-closed storage errors', async () => {
  const executor = makeExecutor({}, 'saas_api_keys');
  const prelock = new PostgresSaasRequestAdmissionAuthorizationPrelock();

  await assert.rejects(
    prelock.prelock(input(executor)),
    (error: unknown) => error instanceof SaasAdmissionAuthorizationError && error.code === 'storage_failure',
  );
});

test('prelock waits for the fence batch before reading revocation, epochs, or expiry', async () => {
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
    const blocked = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedFence = resolve;
    });
    const waitingExecutor: SqlExecutor = {
      async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
        if (authorityStep(sql, values) === 'fence-batch') {
          reachedFence();
          await blocked;
        }
        return executor.query<RowType>(sql, values);
      },
    };
    const operation = new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock(input(waitingExecutor));
    const rejection = assertDenied(operation, /not active|mismatch|expired/);
    await reached;
    // While the fence batch is still waiting, no authority fact has been read.
    assert.equal(executor.statements.length, 0);
    executor.rows.key = [{ ...executor.rows.key[0], ...mutation }];
    releaseFence();
    await rejection;
    const steps = executor.statements.map(({ sql, values }) => authorityStep(sql, values));
    assert.deepEqual(steps, ['fence-batch', 'authority-read']);
  }
});

test('prelock fails closed when the advisory fence batch cannot be acquired', async () => {
  const executor = makeExecutor();
  const failingExecutor: SqlExecutor = {
    async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
      if (authorityStep(sql, values) === 'fence-batch') throw new Error('injected fence failure');
      return executor.query<RowType>(sql, values);
    },
  };
  await assert.rejects(
    new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock(input(failingExecutor)),
    (error: unknown) => error instanceof SaasAdmissionAuthorizationError && error.code === 'storage_failure',
  );
  assert.equal(executor.statements.length, 0, 'no authority read may run without the fences');
});

test('prelock checks expiry with the database clock after a fence wait even when the key is unchanged', async () => {
  const executor = makeExecutor();
  const expiresAt = validRows().key[0]?.expires_at;
  let releaseFence!: () => void;
  let reachedFence!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reachedFence = resolve;
  });
  const waitingExecutor: SqlExecutor = {
    async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
      if (authorityStep(sql, values) === 'fence-batch') {
        reachedFence();
        await blocked;
      }
      return executor.query<RowType>(sql, values);
    },
  };

  const operation = new PostgresSaasRequestAdmissionAuthorizationPrelock().prelock(input(waitingExecutor));
  const rejection = assertDenied(operation, /API key is expired/);
  await reached;
  assert.equal(executor.statements.length, 0);
  // The persisted expiry does not change; wall-clock time reaches it while waiting.
  executor.rows.clock = [{ now: expiresAt }];
  releaseFence();
  await rejection;
  assert.equal(executor.rows.key[0]?.expires_at, expiresAt);
  assert.deepEqual(
    executor.statements.map(({ sql, values }) => authorityStep(sql, values)),
    ['fence-batch', 'authority-read'],
  );
});

test('prelock normalizes UUID-shaped fence ids like the uuid cast did', async () => {
  const executor = makeExecutor();
  const upperTenant = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
  const currentRequest = request({
    tenantId: upperTenant,
    projectId: 'project-a',
  });
  const currentKey = authenticatedKey({ tenantId: upperTenant });
  // The tenant fact row mismatches, so this denies — but the fence key must
  // already be lowercase (matching migration 046's uuid::text derivation).
  await assertDenied(prelockCall(executor, currentRequest, currentKey), /mismatch/);
  const fenceKeys = (executor.statements[0]?.values[0] ?? []) as string[];
  assert.deepEqual(fenceKeys, [
    `saas-authz:tenant:${upperTenant.toLowerCase()}`,
    `saas-authz:project:${upperTenant.toLowerCase()}:project-a`,
    'user-a',
    // The API-key key is KeyService's UTF-8 hex of the raw business-layer id
    // (no uuid normalization — unchanged behavior).
    'saas-authz:api-key:41414141414141412d414141412d414141412d414141412d414141414141414141414141:70726f6a6563742d61:6b65792d61',
  ]);
});
