import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import type { RegistrationDefaultAccessErrorCode } from '../../../../src/saas/identity/registration-default-access-service.js';
import {
  REGISTRATION_DEFAULT_ACCESS_ENV,
  REGISTRATION_DEFAULT_ACCESS_SOURCE,
  RegistrationDefaultAccessError,
  RegistrationDefaultAccessService,
  registrationDefaultAccessConfigFromEnv,
} from '../../../../src/saas/identity/registration-default-access-service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PROJECT_ID = '10000000-0000-4000-8000-000000000002';
const POOL_ID = 'unit-registration-platform-pool';
const CONFIG = { poolId: POOL_ID, modelScopes: ['model-b', 'model-a'] as const };

interface ProjectState {
  tenant_id: string;
  id: string;
  is_default: boolean;
}

interface PoolState {
  id: string;
  status: string;
  validation_state: string;
  authz_version: number;
}

interface ProfileState {
  tenant_id: string;
  id: string;
  supply_mode: string;
  status: string;
  model_scopes: string[];
  authz_version: number;
}

interface EntitlementState {
  id: string;
  tenant_id: string;
  project_id: string;
  supply_profile_id: string;
  supply_mode: string;
  status: string;
  model_scopes: string[];
  source_type: string;
  source_ref: string;
}

interface GrantState {
  pool_id: string;
  tenant_id: string;
  supply_profile_id: string;
  supply_mode: string;
  profile_authz_version: number;
  pool_authz_version: number;
  status: string;
  expires_at: string | null;
  evidence_ref: string;
  evidence_sha256: string;
}

interface State {
  projects: ProjectState[];
  pools: PoolState[];
  profiles: ProfileState[];
  entitlements: EntitlementState[];
  grants: GrantState[];
}

function rows<Row>(values: readonly Row[] = []): SqlResult<Row> {
  return { rows: structuredClone([...values]), rowCount: values.length };
}

class DefaultAccessDatabase {
  state: State = {
    projects: [{ tenant_id: TENANT_ID, id: PROJECT_ID, is_default: true }],
    pools: [{ id: POOL_ID, status: 'active', validation_state: 'verified', authz_version: 3 }],
    profiles: [],
    entitlements: [],
    grants: [],
  };
  readonly statements: string[] = [];
  failNextGrantInsert = false;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.statements.push(statement);
    return this.execute<Row>(statement, values);
  }

  async transaction<T>(work: (tx: { query: DefaultAccessDatabase['query'] }) => Promise<T>): Promise<T> {
    const before = structuredClone(this.state);
    try {
      return await work({ query: this.query.bind(this) });
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  private async execute<Row>(statement: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const [a, b, c, d, e, f, g] = values;
    if (statement.startsWith('select set_config(') || statement.startsWith('select pg_advisory_xact_lock')) {
      return rows<Row>();
    }
    if (statement.startsWith('select id from saas_projects')) {
      return rows<Row>(
        this.state.projects
          .filter((project) => project.tenant_id === a && project.is_default)
          .map((project) => ({ id: project.id }) as Row),
      );
    }
    if (statement.startsWith('select id, supply_profile_id, supply_mode, status, model_scopes')) {
      return rows<Row>(
        this.state.entitlements.filter(
          (entitlement) =>
            entitlement.tenant_id === a &&
            entitlement.project_id === b &&
            (entitlement.id === c || (entitlement.supply_mode === 'platform' && entitlement.status === 'active')),
        ) as Row[],
      );
    }
    if (statement.startsWith('select status, validation_state, authz_version')) {
      return rows<Row>(this.state.pools.filter((pool) => pool.id === a) as Row[]);
    }
    if (statement.startsWith('select supply_mode, status, model_scopes, authz_version')) {
      return rows<Row>(this.state.profiles.filter((profile) => profile.tenant_id === a && profile.id === b) as Row[]);
    }
    if (statement.startsWith('insert into saas_supply_profiles')) {
      const profile: ProfileState = {
        tenant_id: String(a),
        id: String(b),
        supply_mode: 'platform',
        status: 'active',
        model_scopes: [...(c as string[])],
        authz_version: 1,
      };
      this.state.profiles.push(profile);
      return rows<Row>([{ authz_version: profile.authz_version } as Row]);
    }
    if (statement.startsWith('insert into saas_project_entitlements')) {
      const entitlement: EntitlementState = {
        id: String(a),
        tenant_id: String(b),
        project_id: String(c),
        supply_profile_id: String(d),
        supply_mode: 'platform',
        status: 'active',
        model_scopes: [...(e as string[])],
        source_type: 'admin_grant',
        source_ref: String(f),
      };
      this.state.entitlements.push(entitlement);
      return rows<Row>([{ id: entitlement.id } as Row]);
    }
    if (statement.startsWith('select supply_mode, profile_authz_version, pool_authz_version, status')) {
      return rows<Row>(
        this.state.grants.filter(
          (grant) => grant.pool_id === a && grant.tenant_id === b && grant.supply_profile_id === c,
        ) as Row[],
      );
    }
    if (statement.startsWith('insert into saas_platform_provider_pool_grants')) {
      if (this.failNextGrantInsert) throw new Error('unit grant insert failure');
      const grant: GrantState = {
        pool_id: String(a),
        tenant_id: String(b),
        supply_profile_id: String(c),
        supply_mode: 'platform',
        profile_authz_version: Number(d),
        pool_authz_version: Number(e),
        status: 'active',
        expires_at: null,
        evidence_ref: String(f),
        evidence_sha256: String(g),
      };
      this.state.grants.push(grant);
      return rows<Row>([{ pool_id: grant.pool_id } as Row]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

function service(
  database: DefaultAccessDatabase,
  config: { readonly poolId: string; readonly modelScopes: readonly string[] } | undefined,
): RegistrationDefaultAccessService {
  return new RegistrationDefaultAccessService({
    database: database as unknown as SaasDatabase,
    ...(config === undefined ? {} : { config }),
  });
}

async function expectCode(operation: Promise<unknown>, code: RegistrationDefaultAccessErrorCode): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof RegistrationDefaultAccessError);
    assert.equal(error.code, code);
    return true;
  });
}

test('missing or partial server configuration fails closed before any database write', async () => {
  const database = new DefaultAccessDatabase();
  assert.equal(registrationDefaultAccessConfigFromEnv({}), undefined);
  await expectCode(service(database, undefined).provision({ tenantId: TENANT_ID }), 'CONFIGURATION_REQUIRED');

  const partial = registrationDefaultAccessConfigFromEnv({
    [REGISTRATION_DEFAULT_ACCESS_ENV.poolId]: POOL_ID,
  });
  assert.deepEqual(partial, { poolId: POOL_ID, modelScopes: [] });
  await expectCode(service(database, partial).provision({ tenantId: TENANT_ID }), 'INVALID_CONFIGURATION');
  assert.equal(database.state.profiles.length, 0);
  assert.equal(database.state.entitlements.length, 0);
  assert.equal(database.state.grants.length, 0);
  assert.equal(
    database.statements.some((sql) => sql.startsWith('insert into')),
    false,
  );
});

test('environment model scopes are server-side comma-separated configuration', async () => {
  const config = registrationDefaultAccessConfigFromEnv({
    [REGISTRATION_DEFAULT_ACCESS_ENV.poolId]: ` ${POOL_ID} `,
    [REGISTRATION_DEFAULT_ACCESS_ENV.modelScopes]: 'model-a, model-b',
  });
  assert.deepEqual(config, { poolId: POOL_ID, modelScopes: ['model-a', 'model-b'] });
  const database = new DefaultAccessDatabase();
  await expectCode(
    service(database, { poolId: POOL_ID, modelScopes: ['model-a', 'model-a'] }).provision({
      tenantId: TENANT_ID,
    }),
    'INVALID_CONFIGURATION',
  );
  assert.equal(database.state.profiles.length, 0);
});

test('creates profile, entitlement and pool grant atomically and retries idempotently', async () => {
  const database = new DefaultAccessDatabase();
  const access = service(database, CONFIG);
  await access.provision({ tenantId: TENANT_ID });
  const afterFirst = structuredClone(database.state);
  await access.provision({ tenantId: TENANT_ID });

  assert.deepEqual(database.state, afterFirst);
  assert.equal(database.state.profiles.length, 1);
  assert.equal(database.state.entitlements.length, 1);
  assert.equal(database.state.grants.length, 1);
  assert.equal(database.state.profiles[0]?.supply_mode, 'platform');
  assert.deepEqual(database.state.entitlements[0]?.model_scopes, CONFIG.modelScopes);
  assert.equal(database.state.entitlements[0]?.source_type, 'admin_grant');
  assert.equal(
    database.state.entitlements[0]?.source_ref,
    `${REGISTRATION_DEFAULT_ACCESS_SOURCE}:${TENANT_ID}:${PROJECT_ID}`,
  );
  assert.equal(database.state.grants[0]?.pool_authz_version, 3);
  assert.equal(database.state.grants[0]?.profile_authz_version, 1);
  assert.equal(database.state.grants[0]?.expires_at, null);
  assert.match(database.state.grants[0]?.evidence_sha256 ?? '', /^[0-9a-f]{64}$/);
});

test('a different active platform entitlement is never replaced', async () => {
  const database = new DefaultAccessDatabase();
  database.state.entitlements.push({
    id: randomUUID(),
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    supply_profile_id: 'manually-provisioned-profile',
    supply_mode: 'platform',
    status: 'active',
    model_scopes: ['model-a'],
    source_type: 'admin_grant',
    source_ref: 'manual-operation',
  });
  await expectCode(accessOperation(database), 'PROVISIONING_CONFLICT');
  assert.equal(database.state.profiles.length, 0);
  assert.equal(database.state.entitlements.length, 1);
  assert.equal(database.state.grants.length, 0);
});

function accessOperation(database: DefaultAccessDatabase): Promise<void> {
  return service(database, CONFIG).provision({ tenantId: TENANT_ID });
}

test('unverified or inactive configured pool fails closed without partial records', async () => {
  const database = new DefaultAccessDatabase();
  const pool = database.state.pools[0];
  assert.ok(pool);
  pool.status = 'pending';
  pool.validation_state = 'unverified';
  await expectCode(accessOperation(database), 'PROVISIONING_CONFLICT');
  assert.equal(database.state.profiles.length, 0);
  assert.equal(database.state.entitlements.length, 0);
  assert.equal(database.state.grants.length, 0);
});

test('grant failure rolls back profile and entitlement writes', async () => {
  const database = new DefaultAccessDatabase();
  database.failNextGrantInsert = true;
  await assert.rejects(accessOperation(database), /unit grant insert failure/);
  assert.equal(database.state.profiles.length, 0);
  assert.equal(database.state.entitlements.length, 0);
  assert.equal(database.state.grants.length, 0);
});

test('changed server scopes conflict with existing registration records instead of rewriting them', async () => {
  const database = new DefaultAccessDatabase();
  await accessOperation(database);
  await expectCode(
    service(database, { poolId: POOL_ID, modelScopes: ['different-model'] }).provision({ tenantId: TENANT_ID }),
    'PROVISIONING_CONFLICT',
  );
  assert.deepEqual(database.state.entitlements[0]?.model_scopes, CONFIG.modelScopes);
  assert.equal(database.state.profiles.length, 1);
  assert.equal(database.state.entitlements.length, 1);
  assert.equal(database.state.grants.length, 1);
});

test('disabled registration entitlement is left disabled on retry', async () => {
  const database = new DefaultAccessDatabase();
  await accessOperation(database);
  const entitlement = database.state.entitlements[0];
  assert.ok(entitlement);
  entitlement.status = 'disabled';
  const grantCount = database.statements.filter((sql) =>
    sql.startsWith('insert into saas_platform_provider_pool_grants'),
  ).length;
  await accessOperation(database);
  assert.equal(database.state.entitlements[0]?.status, 'disabled');
  assert.equal(
    database.statements.filter((sql) => sql.startsWith('insert into saas_platform_provider_pool_grants')).length,
    grantCount,
  );
});
