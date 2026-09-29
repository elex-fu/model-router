import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool as PgPool, type PoolClient } from 'pg';
import { runSaasMigrations } from '../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

const databaseUrl = process.env.MODEL_ROUTER_TEST_DATABASE_URL;
const migrationTargetVersion = 34;
const providerId = 'product-write-fence-provider';
const productId = 'product-write-fence-product';
const region = 'us-east';
const purpose = 'inference';
const credentialType = 'api_key';
const endpoint = 'chat.completions';
const evidenceSha256 = 'a'.repeat(64);
const modelScope = [
  'valid-model',
  'unsupported-model',
  'unverified-model',
  'stale-model',
  'rights-lock-model',
  'capability-lock-model',
];

interface PgFailure extends Error {
  code?: string;
  constraint?: string;
}

interface RightsVersion {
  rightsId: string;
  version: number;
  status?: 'draft' | 'active' | 'revoked';
  region?: string;
  effectiveAt?: string;
  expiresAt?: string | null;
  modelScope?: string[];
}

interface CapabilityVersion {
  model: string;
  version: number;
  supportLevel?: 'supported' | 'limited' | 'unsupported';
  validationState?: 'unverified' | 'verified' | 'failed';
}

class ScopedPostgresClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values === undefined ? undefined : [...values]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(error?: Error | boolean): void {
    this.client.release(error);
  }
}

class ScopedPostgresPool implements SaasDatabasePool {
  constructor(
    private readonly pool: PgPool,
    private readonly schema: string,
  ) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const client = await this.connect();
    try {
      return await client.query<Row>(sql, values);
    } finally {
      client.release();
    }
  }

  async connect(): Promise<SaasDatabaseClient> {
    return new ScopedPostgresClient(await connectToSchema(this.pool, this.schema));
  }

  async end(): Promise<void> {
    // The caller owns the shared pg pool.
  }
}

async function connectToSchema(pool: PgPool, schema: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    const result = await client.query<{ current_schema: string; schemas: string[] }>(
      'SELECT pg_catalog.current_schema() AS current_schema, pg_catalog.current_schemas(false)::text[] AS schemas',
    );
    assert.equal(result.rows[0]?.current_schema, schema, 'connection must resolve only to the isolated test schema');
    assert.deepEqual(result.rows[0]?.schemas, [schema], 'search_path must exclude public and other user schemas');
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

function migrationPrefix(): SaasMigration[] {
  const migrations = SAAS_MIGRATIONS.filter(({ version }) => version <= migrationTargetVersion);
  const actualVersions = migrations.map(({ version }) => version);
  const expectedVersions = Array.from({ length: migrationTargetVersion }, (_, index) => index + 1);
  assert.deepEqual(
    actualVersions,
    expectedVersions,
    `SaaS migrations must be registered once each in order from 001 through ${migrationTargetVersion}`,
  );
  assert.equal(migrations.at(-1)?.name, 'provider_catalog_product_write_fence');
  return migrations;
}

function newAccountId(label: string): string {
  return `${label}-${randomUUID()}`;
}

async function insertRights(client: PoolClient, input: RightsVersion): Promise<void> {
  await client.query(
    `INSERT INTO saas_provider_rights (
       rights_id, version, provider_id, product_id, credential_type, supply_mode,
       region, purpose, model_scope, endpoint_scope, effective_at, expires_at,
       approval_ref, status, evidence_ref, evidence_sha256
     ) VALUES (
       $1, $2, $3, $4, $5, 'byok', $6, $7, $8::text[], ARRAY[$9]::text[],
       $10::timestamptz, $11::timestamptz, $12, $13, $14, $15
     )`,
    [
      input.rightsId,
      input.version,
      providerId,
      productId,
      credentialType,
      input.region ?? region,
      purpose,
      input.modelScope ?? modelScope,
      endpoint,
      input.effectiveAt ?? new Date(Date.now() - 60_000).toISOString(),
      input.expiresAt ?? null,
      `approval-${input.rightsId}-${input.version}`,
      input.status ?? 'active',
      `evidence-${input.rightsId}-${input.version}`,
      evidenceSha256,
    ],
  );
}

async function insertCapability(client: PoolClient, input: CapabilityVersion): Promise<void> {
  await client.query(
    `INSERT INTO saas_provider_capabilities (
       provider_id, product_id, model, endpoint, protocol, version,
       support_level, validation_state, evidence_version, discovery_source,
       evidence_ref, evidence_sha256
     ) VALUES ($1, $2, $3, $4, 'openai', $5, $6, $7, 'test-v1', 'manual', $8, $9)`,
    [
      providerId,
      productId,
      input.model,
      endpoint,
      input.version,
      input.supportLevel ?? 'supported',
      input.validationState ?? 'verified',
      `capability-evidence-${input.model}-${input.version}`,
      evidenceSha256,
    ],
  );
}

async function insertAccount(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  rightsId: string,
  rightsVersion: number,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO saas_tenant_provider_accounts (
       tenant_id, id, display_name, provider_id, product_id, credential_type,
       region, purpose, rights_id, rights_version
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [tenantId, accountId, accountId, providerId, productId, credentialType, region, purpose, rightsId, rightsVersion],
  );
  assert.equal(result.rowCount, 1, `account ${accountId} should be inserted`);
}

async function insertAccountCapability(
  client: PoolClient,
  tenantId: string,
  accountId: string,
  model: string,
  capabilityVersion: number,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO saas_tenant_provider_account_capabilities (
       tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
     RETURNING account_id`,
    [tenantId, accountId, providerId, productId, model, endpoint, capabilityVersion],
  );
  assert.equal(result.rowCount, 1, `account capability ${model}@${capabilityVersion} should be inserted`);
}

async function assertCheckViolation(
  action: () => Promise<unknown>,
  label: string,
  expectedConstraint?: string,
): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error, `${label}: insert should be rejected`);
  const pgFailure = failure as PgFailure;
  assert.equal(pgFailure.code, '23514', `${label}: expected PostgreSQL check_violation`);
  if (expectedConstraint) {
    assert.equal(pgFailure.constraint, expectedConstraint, `${label}: rejection should come from the 034 fence`);
  }
}

async function assertCatalogWriteWaitsForAccountShareLock(input: {
  pool: PgPool;
  schema: string;
  tenantId: string;
  accountId: string;
  rightsId: string;
  versionWrite: (client: PoolClient) => Promise<void>;
  relation: 'saas_provider_rights' | 'saas_provider_capabilities';
}): Promise<void> {
  const accountClient = await connectToSchema(input.pool, input.schema);
  const writeClient = await connectToSchema(input.pool, input.schema);
  const observerClient = await connectToSchema(input.pool, input.schema);
  let accountTransactionOpen = false;
  let writeTransactionOpen = false;
  let versionWritePromise: Promise<void> | undefined;

  try {
    await accountClient.query('BEGIN');
    accountTransactionOpen = true;
    const accountPid = Number(
      (await accountClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid,
    );
    await insertAccount(accountClient, input.tenantId, input.accountId, input.rightsId, 1);

    await writeClient.query('BEGIN');
    writeTransactionOpen = true;
    const writePid = Number(
      (await writeClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid,
    );
    versionWritePromise = input.versionWrite(writeClient);
    const writeOutcome = versionWritePromise.then(
      () => ({ kind: 'completed' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );

    const deadline = Date.now() + 5_000;
    let observedBlock = false;
    while (Date.now() < deadline) {
      const activity = await observerClient.query<{
        blockers: number[];
        wait_event_type: string | null;
        query: string;
      }>(
        `SELECT pg_catalog.pg_blocking_pids(activity.pid) AS blockers,
                activity.wait_event_type,
                activity.query
           FROM pg_catalog.pg_stat_activity AS activity
          WHERE activity.pid = $1`,
        [writePid],
      );
      const state = activity.rows[0];
      if (state?.wait_event_type === 'Lock' && state.blockers.includes(accountPid)) {
        assert.ok(state.query.includes(input.relation), `blocked statement should insert into ${input.relation}`);
        observedBlock = true;
        break;
      }

      const outcome = await Promise.race([writeOutcome, delay(1).then(() => undefined)]);
      if (outcome) {
        if (outcome.kind === 'failed') {
          throw new Error(`catalog ${input.relation} insert failed before reaching the expected product-row lock`, {
            cause: outcome.error,
          });
        }
        throw new Error(`catalog ${input.relation} insert completed without waiting for the account transaction`);
      }
      await delay(20);
    }

    assert.ok(
      observedBlock,
      `catalog ${input.relation} insert did not report a Lock wait blocked by account transaction PID ${accountPid}`,
    );

    await accountClient.query('COMMIT');
    accountTransactionOpen = false;
    await versionWritePromise;
    await writeClient.query('COMMIT');
    writeTransactionOpen = false;
  } finally {
    if (accountTransactionOpen) await accountClient.query('ROLLBACK').catch(() => undefined);
    if (versionWritePromise) await versionWritePromise.catch(() => undefined);
    if (writeTransactionOpen) await writeClient.query('ROLLBACK').catch(() => undefined);
    accountClient.release();
    writeClient.release();
    observerClient.release();
  }
}

test('migration 034 enforces provider product write fencing in isolated PostgreSQL', {
  skip: databaseUrl
    ? false
    : 'MODEL_ROUTER_TEST_DATABASE_URL is not configured; PostgreSQL integration assertions skipped without opening a connection',
}, async (t) => {
  const migrations = migrationPrefix();
  const schema = `saas_catalog_fence_${randomUUID().replaceAll('-', '')}`;
  const pool = new PgPool({
    connectionString: databaseUrl,
    max: 6,
    application_name: 'model-router-provider-catalog-write-fence-test',
  });
  let schemaCreated = false;
  let postgresVersion = 'unavailable';

  try {
    const admin = await pool.connect();
    try {
      const versionResult = await admin.query<{ server_version_num: string; server_version: string }>(
        `SELECT pg_catalog.current_setting('server_version_num') AS server_version_num,
                  pg_catalog.current_setting('server_version') AS server_version`,
      );
      postgresVersion = versionResult.rows[0]?.server_version ?? 'unknown';
      const versionNumber = Number(versionResult.rows[0]?.server_version_num);
      assert.ok(
        Number.isInteger(versionNumber) && versionNumber >= 150_000,
        `PostgreSQL ${postgresVersion} (${versionResult.rows[0]?.server_version_num ?? 'unknown'}) is unsupported; managed SaaS requires PostgreSQL 15 or later`,
      );
      assert.match(schema, /^saas_catalog_fence_[a-f0-9]{32}$/);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
    } finally {
      admin.release();
    }

    const scopedPool = new ScopedPostgresPool(pool, schema);
    try {
      await runSaasMigrations(scopedPool, migrations);
    } catch (error) {
      throw new Error(
        `PostgreSQL ${postgresVersion}: ordered migrations 001 through 034 failed in isolated schema ${schema}; inspect migration order and missing relation dependencies`,
        { cause: error },
      );
    }
    const client = await connectToSchema(pool, schema);
    try {
      const history = await client.query<{ version: number }>(
        'SELECT version FROM saas_schema_migrations ORDER BY version',
      );
      assert.deepEqual(
        history.rows.map(({ version }) => Number(version)),
        migrations.map(({ version }) => version),
        `migration history in isolated schema ${schema} must contain 001 through 034 in order`,
      );

      const requiredRelations = [
        'saas_schema_migrations',
        'saas_tenants',
        'saas_provider_products',
        'saas_provider_rights',
        'saas_provider_capabilities',
        'saas_tenant_provider_accounts',
        'saas_tenant_provider_account_capabilities',
      ];
      const relations = await client.query<{ relation_name: string; relation_exists: boolean }>(
        `SELECT required.relation_name,
                  pg_catalog.to_regclass(pg_catalog.format('%I.%I', $1::text, required.relation_name)) IS NOT NULL
                    AS relation_exists
             FROM unnest($2::text[]) AS required(relation_name)
            ORDER BY required.relation_name`,
        [schema, requiredRelations],
      );
      const missingRelations = relations.rows
        .filter(({ relation_exists }) => !relation_exists)
        .map(({ relation_name }) => relation_name);
      assert.deepEqual(
        missingRelations,
        [],
        `migration 034 relation check failed in schema ${schema}; missing: ${missingRelations.join(', ') || 'none'}`,
      );

      const triggerResult = await client.query<{ relation_name: string; trigger_name: string }>(
        `SELECT relation.relname AS relation_name, trigger.tgname AS trigger_name
             FROM pg_catalog.pg_trigger AS trigger
             JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
             JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = $1
              AND NOT trigger.tgisinternal
              AND trigger.tgname = ANY($2::text[])
              AND trigger.tgenabled = 'O'
            ORDER BY trigger.tgname`,
        [
          schema,
          [
            'saas_provider_capabilities_lock_product',
            'saas_provider_rights_lock_product',
            'saas_tenant_provider_accounts_require_byok_rights',
            'saas_tenant_provider_account_capabilities_byok_fence',
          ],
        ],
      );
      assert.deepEqual(
        triggerResult.rows.map(({ relation_name, trigger_name }) => `${relation_name}.${trigger_name}`).sort(),
        [
          'saas_provider_capabilities.saas_provider_capabilities_lock_product',
          'saas_provider_rights.saas_provider_rights_lock_product',
          'saas_tenant_provider_account_capabilities.saas_tenant_provider_account_capabilities_byok_fence',
          'saas_tenant_provider_accounts.saas_tenant_provider_accounts_require_byok_rights',
        ].sort(),
        `migration 034 triggers are missing or disabled in isolated schema ${schema}`,
      );

      const tenantId = randomUUID();
      await client.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1::uuid, $2, $3)', [
        tenantId,
        'Product write fence integration tenant',
        `product-write-fence-${randomUUID()}`,
      ]);
      await client.query(
        'INSERT INTO saas_provider_products (provider_id, product_id, display_name) VALUES ($1, $2, $3)',
        [providerId, productId, 'Product write fence integration product'],
      );

      await insertRights(client, { rightsId: 'rights-valid', version: 1 });
      await insertRights(client, { rightsId: 'rights-revoked', version: 1 });
      await insertRights(client, {
        rightsId: 'rights-revoked',
        version: 2,
        status: 'revoked',
        effectiveAt: new Date(Date.now() - 30_000).toISOString(),
      });
      await insertRights(client, {
        rightsId: 'rights-expired',
        version: 1,
        effectiveAt: new Date(Date.now() - 180_000).toISOString(),
        expiresAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await insertRights(client, { rightsId: 'rights-mismatched', version: 1, region: 'eu-west' });
      await insertRights(client, { rightsId: 'rights-lock', version: 1 });
      await insertRights(client, { rightsId: 'capability-lock', version: 1 });

      await insertCapability(client, { model: 'valid-model', version: 1 });
      await insertCapability(client, {
        model: 'unsupported-model',
        version: 1,
        supportLevel: 'unsupported',
      });
      await insertCapability(client, {
        model: 'unverified-model',
        version: 1,
        validationState: 'unverified',
      });
      await insertCapability(client, { model: 'stale-model', version: 1 });
      await insertCapability(client, { model: 'stale-model', version: 2 });
      await insertCapability(client, { model: 'capability-lock-model', version: 1 });

      const validAccountId = newAccountId('valid-account');
      await insertAccount(client, tenantId, validAccountId, 'rights-valid', 1);
      await insertAccountCapability(client, tenantId, validAccountId, 'valid-model', 1);

      await t.test('rejects an old account rights version after the latest version is revoked', async () => {
        await assertCheckViolation(
          () => insertAccount(client, tenantId, newAccountId('revoked-rights'), 'rights-revoked', 1),
          'latest revoked rights',
          'saas_tenant_provider_accounts_byok_rights_fence',
        );
      });

      await t.test('rejects expired and supply-mismatched account rights', async () => {
        await assertCheckViolation(
          () => insertAccount(client, tenantId, newAccountId('expired-rights'), 'rights-expired', 1),
          'expired rights',
          'saas_tenant_provider_accounts_byok_rights_fence',
        );
        await assertCheckViolation(
          () => insertAccount(client, tenantId, newAccountId('mismatched-rights'), 'rights-mismatched', 1),
          'rights whose region does not match the account',
          'saas_tenant_provider_accounts_byok_rights_fence',
        );
      });

      await t.test('rejects unsupported, unverified, and stale account capabilities', async () => {
        for (const model of ['unsupported-model', 'unverified-model', 'stale-model']) {
          await assertCheckViolation(
            () => insertAccountCapability(client, tenantId, validAccountId, model, 1),
            `${model} capability`,
            'saas_tenant_provider_account_capabilities_byok_fence',
          );
        }
      });

      await t.test(
        'catalog rights and capability version inserts wait for an account-held product share lock',
        async () => {
          await assertCatalogWriteWaitsForAccountShareLock({
            pool,
            schema,
            tenantId,
            accountId: newAccountId('rights-lock-account'),
            rightsId: 'rights-lock',
            relation: 'saas_provider_rights',
            versionWrite: async (writeClient) => {
              await insertRights(writeClient, {
                rightsId: 'rights-lock',
                version: 2,
                effectiveAt: new Date(Date.now() - 10_000).toISOString(),
              });
            },
          });

          await assertCatalogWriteWaitsForAccountShareLock({
            pool,
            schema,
            tenantId,
            accountId: newAccountId('capability-lock-account'),
            rightsId: 'capability-lock',
            relation: 'saas_provider_capabilities',
            versionWrite: (writeClient) =>
              insertCapability(writeClient, { model: 'capability-lock-model', version: 2 }),
          });
        },
      );

      await t.test(
        'catalog updates committed first reject stale rights and capability INSERTs and UPDATEs',
        async () => {
          await assertCheckViolation(
            () => insertAccount(client, tenantId, newAccountId('stale-rights'), 'rights-lock', 1),
            'account inserted after rights version 2 committed, still referencing version 1',
            'saas_tenant_provider_accounts_byok_rights_fence',
          );

          const accountAfterRightsUpdate = newAccountId('current-rights-account');
          await insertAccount(client, tenantId, accountAfterRightsUpdate, 'rights-lock', 2);
          await assertCheckViolation(
            () =>
              client.query(
                `UPDATE saas_tenant_provider_accounts
                  SET rights_version = 1
                WHERE tenant_id = $1::uuid AND id = $2
                RETURNING rights_version`,
                [tenantId, accountAfterRightsUpdate],
              ),
            'account UPDATE to rights version 1 after rights version 2 committed',
            'saas_tenant_provider_accounts_byok_rights_fence',
          );
          const rightsAfterRejectedUpdate = await client.query<{ rights_version: number }>(
            'SELECT rights_version FROM saas_tenant_provider_accounts WHERE tenant_id = $1::uuid AND id = $2',
            [tenantId, accountAfterRightsUpdate],
          );
          assert.equal(Number(rightsAfterRejectedUpdate.rows[0]?.rights_version), 2);

          const capabilityLockAccount = newAccountId('capability-stale-link-account');
          await insertAccount(client, tenantId, capabilityLockAccount, 'capability-lock', 1);
          await assertCheckViolation(
            () => insertAccountCapability(client, tenantId, capabilityLockAccount, 'capability-lock-model', 1),
            'account capability inserted after capability version 2 committed, still referencing version 1',
            'saas_tenant_provider_account_capabilities_byok_fence',
          );
          await insertAccountCapability(client, tenantId, capabilityLockAccount, 'capability-lock-model', 2);
          await assertCheckViolation(
            () =>
              client.query(
                `UPDATE saas_tenant_provider_account_capabilities
                  SET capability_version = 1
                WHERE tenant_id = $1::uuid
                  AND account_id = $2
                  AND provider_id = $3
                  AND product_id = $4
                  AND model = 'capability-lock-model'
                  AND endpoint = $5
                  AND capability_version = 2
                RETURNING capability_version`,
                [tenantId, capabilityLockAccount, providerId, productId, endpoint],
              ),
            'account capability UPDATE to version 1 after capability version 2 committed',
            'saas_tenant_provider_account_capabilities_byok_fence',
          );
          const capabilityAfterRejectedUpdate = await client.query<{ capability_version: number }>(
            `SELECT capability_version
             FROM saas_tenant_provider_account_capabilities
            WHERE tenant_id = $1::uuid
              AND account_id = $2
              AND provider_id = $3
              AND product_id = $4
              AND model = 'capability-lock-model'
              AND endpoint = $5`,
            [tenantId, capabilityLockAccount, providerId, productId, endpoint],
          );
          assert.equal(Number(capabilityAfterRejectedUpdate.rows[0]?.capability_version), 2);
        },
      );
    } finally {
      client.release();
    }
  } finally {
    try {
      if (schemaCreated) {
        const cleanupClient = await pool.connect();
        try {
          await cleanupClient.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          cleanupClient.release();
        }
      }
    } finally {
      await pool.end();
    }
  }
});
