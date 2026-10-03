import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool as PgPool, type PoolClient } from 'pg';
import { runSaasMigrations } from '../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS, type SaasMigration } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION } from '../../../src/saas/db/migrations/003_project_membership_backfill.js';
import { API_KEYS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/004_api_keys.js';
import { SUPPLY_PROFILES_AND_ENTITLEMENTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/005_supply_profiles_and_entitlements.js';
import { API_KEY_ENTITLEMENT_BINDING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/006_api_key_entitlement_binding.js';
import { REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION } from '../../../src/saas/db/migrations/014_request_admission_outbox.js';
import { PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/015_provider_supply_accounts.js';
import { PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/016_provider_supply_credentials.js';
import { COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/017_commercial_price_versions.js';
import { ATTEMPT_PROVIDER_ACCOUNT_BINDING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/018_attempt_provider_account_binding.js';
import { ATTEMPT_DISPATCH_AUTHORITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/019_attempt_dispatch_authority.js';
import { SUPPLY_RELATIONSHIP_EPOCHS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/020_supply_relationship_epochs.js';
import { PROJECT_INFERENCE_POLICY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/021_project_inference_policy.js';
import { ROUTE_CONFIG_AUTHORITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/022_route_config_authority.js';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/023_commercial_metering_policy_authority.js';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/024_prepared_request_evidence.js';
import { PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/025_provider_account_leases.js';
import { PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/026_prepared_request_evidence_platform_pool_fence.js';
import { PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/027_prepared_request_evidence_claim_pool_fence.js';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/028_prepared_request_evidence_pool_claim_hardening.js';
import { MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/029_model_resolution_provenance.js';
import { PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION } from '../../../src/saas/db/migrations/030_payment_orders_wallet_topup.js';
import { BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/031_byok_service_plan_subscription_fulfillment.js';
import { PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/032_payment_checkout_and_submission_fencing.js';
import { PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION } from '../../../src/saas/db/migrations/033_payment_webhook_durable_inbox.js';
import { PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/034_provider_catalog_product_write_fence.js';
import type { SaasDatabaseClient, SaasDatabasePool, SqlResult } from '../../../src/saas/db/types.js';

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

class MigrationClient implements SaasDatabaseClient {
  private pending: AppliedMigration[] = [];

  constructor(private readonly pool: MigrationPool) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    if (normalized.startsWith('SELECT pg_advisory_lock')) {
      this.pool.events.push('lock');
      if (this.pool.lockError) throw this.pool.lockError;
    } else if (normalized.startsWith('SELECT pg_advisory_unlock')) {
      this.pool.events.push('unlock');
      if (this.pool.unlockError) throw this.pool.unlockError;
      return {
        rows: [{ unlocked: this.pool.unlockResult ?? true }] as Row[],
        rowCount: 1,
      };
    } else if (normalized.startsWith('CREATE TABLE IF NOT EXISTS')) {
      this.pool.events.push('create-migration-table');
      assert.match(normalized, /saas_schema_migrations/);
    } else if (normalized.startsWith('SELECT version, name, checksum')) {
      return { rows: [...this.pool.applied] as Row[], rowCount: this.pool.applied.length };
    } else if (normalized === 'BEGIN') {
      this.pending = [];
      this.pool.events.push('begin');
      if (this.pool.beginError) throw this.pool.beginError;
    } else if (normalized === 'COMMIT') {
      this.pool.applied.push(...this.pending);
      this.pending = [];
      this.pool.events.push('commit');
    } else if (normalized === 'ROLLBACK') {
      this.pending = [];
      this.pool.events.push('rollback');
    } else if (normalized.startsWith('INSERT INTO saas_schema_migrations')) {
      const [version, name, checksum] = values ?? [];
      this.pending.push({ version: Number(version), name: String(name), checksum: String(checksum) });
      this.pool.events.push(`record:${String(version)}`);
    } else if (normalized === 'FAIL MIGRATION' && this.pool.migrationError) {
      this.pool.events.push('apply:FAIL MIGRATION');
      throw this.pool.migrationError;
    } else {
      this.pool.events.push(`apply:${normalized}`);
    }

    return { rows: [], rowCount: 0 };
  }

  release(error?: Error | boolean): void {
    this.pool.releases.push(error);
    this.pool.events.push('release');
  }
}

class MigrationPool implements SaasDatabasePool {
  readonly events: string[] = [];
  readonly applied: AppliedMigration[] = [];
  readonly releases: Array<Error | boolean | undefined> = [];

  constructor(
    readonly options: {
      lockError?: Error;
      unlockError?: Error;
      unlockResult?: boolean;
      beginError?: Error;
      migrationError?: Error;
    } = {},
  ) {}

  get lockError(): Error | undefined {
    return this.options.lockError;
  }

  get unlockError(): Error | undefined {
    return this.options.unlockError;
  }

  get unlockResult(): boolean | undefined {
    return this.options.unlockResult;
  }

  get beginError(): Error | undefined {
    return this.options.beginError;
  }

  get migrationError(): Error | undefined {
    return this.options.migrationError;
  }

  async query<Row>(): Promise<SqlResult<Row>> {
    throw new Error('migrations must use one checked-out client');
  }

  async connect(): Promise<SaasDatabaseClient> {
    return new MigrationClient(this);
  }

  async end(): Promise<void> {}
}

class ScopedPostgresClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    const result = await this.client.query(sql, values ? [...values] : undefined);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount,
    };
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
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      const result = await client.query(sql, values ? [...values] : undefined);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount,
      };
    } finally {
      client.release();
    }
  }

  async connect(): Promise<SaasDatabaseClient> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schema}"`);
      return new ScopedPostgresClient(client);
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

const realPostgresUrl = process.env.SAAS_TEST_DATABASE_URL;

async function withScopedPostgresSchema<T>(work: (pool: ScopedPostgresPool) => Promise<T>): Promise<T> {
  if (!realPostgresUrl) throw new Error('SAAS_TEST_DATABASE_URL is required');

  const pool = new PgPool({ connectionString: realPostgresUrl, max: 4 });
  const schema = `saas_migration_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    return await work(new ScopedPostgresPool(pool, schema));
  } finally {
    try {
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
}

const ATTEMPT_BINDING_FIXTURE = {
  tenantOne: '00000000-0000-0000-0000-000000000601',
  tenantTwo: '00000000-0000-0000-0000-000000000602',
  userOne: '00000000-0000-0000-0000-000000000611',
  userTwo: '00000000-0000-0000-0000-000000000612',
  projectOne: '00000000-0000-0000-0000-000000000621',
  projectTwo: '00000000-0000-0000-0000-000000000622',
  entitlementByokOne: '00000000-0000-0000-0000-000000000631',
  entitlementPlatformOne: '00000000-0000-0000-0000-000000000632',
  entitlementByokTwo: '00000000-0000-0000-0000-000000000633',
  keyByokOne: '00000000-0000-0000-0000-000000000641',
  keyPlatformOne: '00000000-0000-0000-0000-000000000642',
  keyByokTwo: '00000000-0000-0000-0000-000000000643',
  requestByok: '00000000-0000-0000-0000-000000000651',
  requestPlatform: '00000000-0000-0000-0000-000000000652',
  attemptByok: '00000000-0000-0000-0000-000000000661',
  attemptPlatform: '00000000-0000-0000-0000-000000000662',
  legacyAttempt: '00000000-0000-0000-0000-000000000663',
  authoritylessAttempt: '00000000-0000-0000-0000-000000000664',
} as const;

async function seedAttemptBindingFixture(pool: ScopedPostgresPool, withProjectPolicy = false): Promise<void> {
  const ids = ATTEMPT_BINDING_FIXTURE;
  await pool.query(
    `INSERT INTO saas_users (id, email)
     VALUES ($1, 'attempt-binding-one@example.com'), ($2, 'attempt-binding-two@example.com')`,
    [ids.userOne, ids.userTwo],
  );
  await pool.query(
    `INSERT INTO saas_tenants (id, name, slug)
     VALUES ($1, 'Attempt binding tenant one', 'attempt-binding-one'),
            ($2, 'Attempt binding tenant two', 'attempt-binding-two')`,
    [ids.tenantOne, ids.tenantTwo],
  );
  await pool.query(
    `INSERT INTO saas_projects (tenant_id, id, name, slug)
     VALUES ($1, $2, 'Attempt binding project one', 'attempt-binding-project-one'),
            ($3, $4, 'Attempt binding project two', 'attempt-binding-project-two')`,
    [ids.tenantOne, ids.projectOne, ids.tenantTwo, ids.projectTwo],
  );
  if (withProjectPolicy) {
    await pool.query(
      `INSERT INTO saas_project_inference_policy_versions
         (tenant_id, project_id, version, status, changed_by_user_id)
       VALUES ($1, $2, 2, 'active', $3), ($4, $5, 2, 'active', $6)`,
      [ids.tenantOne, ids.projectOne, ids.userOne, ids.tenantTwo, ids.projectTwo, ids.userTwo],
    );
    await pool.query(
      `UPDATE saas_projects
          SET inference_policy_version = 2, inference_policy_status = 'active'
        WHERE (tenant_id, id) IN (($1, $2), ($3, $4))`,
      [ids.tenantOne, ids.projectOne, ids.tenantTwo, ids.projectTwo],
    );
  }
  await pool.query(
    `INSERT INTO saas_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [ids.tenantOne, ids.userOne, ids.tenantTwo, ids.userTwo],
  );
  await pool.query(
    `INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner')`,
    [ids.tenantOne, ids.projectOne, ids.userOne, ids.tenantTwo, ids.projectTwo, ids.userTwo],
  );
  await pool.query(
    `INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes)
     VALUES ($1, 'attempt-byok-one', 'byok', ARRAY['model-a']),
            ($1, 'attempt-platform-one', 'platform', ARRAY['model-a']),
            ($2, 'attempt-byok-two', 'byok', ARRAY['model-a'])`,
    [ids.tenantOne, ids.tenantTwo],
  );
  await pool.query(
    `INSERT INTO saas_project_entitlements
       (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
     VALUES ($1, $2, $3, 'attempt-byok-one', 'byok', ARRAY['model-a']),
            ($4, $2, $3, 'attempt-platform-one', 'platform', ARRAY['model-a']),
            ($5, $6, $7, 'attempt-byok-two', 'byok', ARRAY['model-a'])`,
    [
      ids.entitlementByokOne,
      ids.tenantOne,
      ids.projectOne,
      ids.entitlementPlatformOne,
      ids.entitlementByokTwo,
      ids.tenantTwo,
      ids.projectTwo,
    ],
  );
  await pool.query(
    `INSERT INTO saas_api_keys
       (id, tenant_id, project_id, principal_user_id, entitlement_id, supply_profile_id, supply_mode,
        name, prefix, key_hash, model_scopes, execution_principal_type, execution_principal_id,
        created_by_user_id, model_scope_version, entitlement_authz_version, supply_profile_authz_version)
     VALUES ($1, $2, $3, $4, $5, 'attempt-byok-one', 'byok',
             'Attempt BYOK key one', 'mr_live_attempt01', $6, ARRAY['model-a'], 'member', $16, $17, 1, 1, 1),
            ($7, $2, $3, $4, $8, 'attempt-platform-one', 'platform',
             'Attempt platform key one', 'mr_live_attempt02', $9, ARRAY['model-a'], 'member', $18, $19, 1, 1, 1),
            ($10, $11, $12, $13, $14, 'attempt-byok-two', 'byok',
             'Attempt BYOK key two', 'mr_live_attempt03', $15, ARRAY['model-a'], 'member', $20, $21, 1, 1, 1)`,
    [
      ids.keyByokOne,
      ids.tenantOne,
      ids.projectOne,
      ids.userOne,
      ids.entitlementByokOne,
      '1'.repeat(64),
      ids.keyPlatformOne,
      ids.entitlementPlatformOne,
      '2'.repeat(64),
      ids.keyByokTwo,
      ids.tenantTwo,
      ids.projectTwo,
      ids.userTwo,
      ids.entitlementByokTwo,
      '3'.repeat(64),
      ids.userOne,
      ids.userOne,
      ids.userOne,
      ids.userOne,
      ids.userTwo,
      ids.userTwo,
    ],
  );
  await pool.query(
    `INSERT INTO saas_provider_products (provider_id, product_id, display_name)
     VALUES ('provider-a', 'product-a', 'Attempt provider A product'),
            ('provider-b', 'product-b', 'Attempt provider B product')`,
  );
  await pool.query(
    `INSERT INTO saas_provider_rights
       (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
        model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
     VALUES ('attempt-right-byok', 1, 'provider-a', 'product-a', 'api_key', 'byok', 'global', 'routing',
             ARRAY['model-a'], ARRAY['/v1/chat/completions'], '2026-09-28T00:00:00Z',
             'approval-attempt-byok', 'active', 'evidence-attempt-byok', $1),
            ('attempt-right-platform', 1, 'provider-a', 'product-a', 'api_key', 'platform', 'global', 'routing',
             ARRAY['model-a'], ARRAY['/v1/chat/completions'], '2026-09-28T00:00:00Z',
             'approval-attempt-platform', 'active', 'evidence-attempt-platform', $1),
            ('attempt-right-platform-b', 1, 'provider-b', 'product-b', 'api_key', 'platform', 'global', 'routing',
             ARRAY['model-a'], ARRAY['/v1/chat/completions'], '2026-09-28T00:00:00Z',
             'approval-attempt-platform-b', 'active', 'evidence-attempt-platform-b', $1)`,
    ['a'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO saas_tenant_provider_accounts
       (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version,
        status, validation_state)
     VALUES ($1, 'tenant-account-a', 'Tenant account A', 'provider-a', 'product-a', 'api_key', 'global', 'routing',
             'attempt-right-byok', 1, 'active', 'verified'),
            ($2, 'tenant-account-b', 'Tenant account B', 'provider-a', 'product-a', 'api_key', 'global', 'routing',
             'attempt-right-byok', 1, 'active', 'verified')`,
    [ids.tenantOne, ids.tenantTwo],
  );
  await pool.query(
    `INSERT INTO saas_platform_provider_accounts
       (id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version,
        status, validation_state)
     VALUES ('platform-account-a', 'Platform account A', 'provider-a', 'product-a', 'api_key', 'global', 'routing',
             'attempt-right-platform', 1, 'active', 'verified'),
            ('platform-account-b', 'Platform account B', 'provider-b', 'product-b', 'api_key', 'global', 'routing',
             'attempt-right-platform-b', 1, 'active', 'verified')`,
  );
  await pool.query(
    `INSERT INTO saas_tenant_provider_credentials
       (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state)
     VALUES ($1, 'tenant-credential-a', 'tenant-account-a', 'provider-a', 'product-a', 'api_key', 'active', 'verified'),
            ($2, 'tenant-credential-b', 'tenant-account-b', 'provider-a', 'product-a', 'api_key', 'active', 'verified')`,
    [ids.tenantOne, ids.tenantTwo],
  );
  await pool.query(
    `INSERT INTO saas_platform_provider_credentials
       (id, account_id, provider_id, product_id, credential_type, status, validation_state)
     VALUES ('platform-credential-a', 'platform-account-a', 'provider-a', 'product-a', 'api_key', 'active', 'verified'),
            ('platform-credential-b', 'platform-account-b', 'provider-b', 'product-b', 'api_key', 'active', 'verified')`,
  );
  await pool.query(
    `INSERT INTO saas_tenant_provider_credential_versions
       (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm,
        kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
     VALUES ($1, 'tenant-account-a', 'tenant-credential-a', 1, 1, 1, 'aes-256-gcm',
             'attempt', 'kms-attempt', 'wrapped-dek-a', 'nonce-a', 'ciphertext-a', 'auth-tag-a', 'active'),
            ($2, 'tenant-account-b', 'tenant-credential-b', 1, 1, 1, 'aes-256-gcm',
             'attempt', 'kms-attempt', 'wrapped-dek-b', 'nonce-b', 'ciphertext-b', 'auth-tag-b', 'active')`,
    [ids.tenantOne, ids.tenantTwo],
  );
  await pool.query(
    `INSERT INTO saas_platform_provider_credential_versions
       (account_id, credential_id, version, schema_version, context_version, algorithm,
        kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
     VALUES ('platform-account-a', 'platform-credential-a', 1, 1, 1, 'aes-256-gcm',
             'attempt', 'kms-attempt', 'wrapped-dek-pa', 'nonce-pa', 'ciphertext-pa', 'auth-tag-pa', 'active'),
            ('platform-account-b', 'platform-credential-b', 1, 1, 1, 'aes-256-gcm',
             'attempt', 'kms-attempt', 'wrapped-dek-pb', 'nonce-pb', 'ciphertext-pb', 'auth-tag-pb', 'active')`,
  );
  await pool.query(
    `UPDATE saas_tenant_provider_credentials
        SET current_version = 1
      WHERE (tenant_id, id) IN (($1, 'tenant-credential-a'), ($2, 'tenant-credential-b'))`,
    [ids.tenantOne, ids.tenantTwo],
  );
  await pool.query(
    `UPDATE saas_platform_provider_credentials
        SET current_version = 1
      WHERE id IN ('platform-credential-a', 'platform-credential-b')`,
  );
  await pool.query(
    `INSERT INTO saas_platform_provider_pools
       (id, display_name, provider_id, product_id, credential_type, region, purpose, rights_id, rights_version,
        status, validation_state)
     VALUES ('pool-a', 'Attempt pool A', 'provider-a', 'product-a', 'api_key', 'global', 'routing',
             'attempt-right-platform', 1, 'active', 'verified'),
            ('pool-b', 'Attempt pool B', 'provider-b', 'product-b', 'api_key', 'global', 'routing',
             'attempt-right-platform-b', 1, 'active', 'verified')`,
  );
  await pool.query(
    `INSERT INTO saas_platform_provider_pool_members
       (pool_id, account_id, provider_id, product_id, account_authz_version, status)
     VALUES ('pool-a', 'platform-account-a', 'provider-a', 'product-a', 1, 'active'),
            ('pool-b', 'platform-account-b', 'provider-b', 'product-b', 1, 'active')`,
  );
  await pool.query(
    `INSERT INTO saas_platform_provider_pool_grants
       (pool_id, tenant_id, supply_profile_id, profile_authz_version, pool_authz_version,
        status, authz_version, evidence_ref, evidence_sha256)
     VALUES ('pool-a', $1, 'attempt-platform-one', 1, 1, 'active', 1, 'attempt-grant-platform', $2)`,
    [ids.tenantOne, 'e'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO saas_tenant_provider_supply_profile_accounts
       (tenant_id, supply_profile_id, account_id, provider_id, product_id, account_authz_version,
        status, authz_version, evidence_ref, evidence_sha256)
     VALUES ($1, 'attempt-byok-one', 'tenant-account-a', 'provider-a', 'product-a', 1,
             'active', 1, 'attempt-mapping-byok', $2)`,
    [ids.tenantOne, 'f'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO saas_public_models (id, alias, display_name)
     VALUES ('public-model-a', 'attempt-public-model-a', 'Attempt public model A')`,
  );
  await pool.query(
    `INSERT INTO saas_public_model_versions
       (public_model_id, version, provider_id, product_id, model, endpoint_scope)
     VALUES ('public-model-a', 1, 'provider-a', 'product-a', 'actual-a', ARRAY['/v1/chat/completions'])`,
  );
  if (withProjectPolicy) {
    await pool.query(
      `INSERT INTO saas_route_config_versions
         (tenant_id, project_id, route_id, version, status, public_model_id, public_model_version,
          protocol, supply_mode, target_mode, upstream_id, endpoint)
       VALUES ($1, $2, 'attempt-route-byok', 1, 'active', 'public-model-a', 1,
               'openai', 'byok', 'tenant_account', 'upstream-attempt-binding', '/v1/chat/completions'),
              ($1, $2, 'attempt-route-platform', 1, 'active', 'public-model-a', 1,
               'openai', 'platform', 'platform_pool', 'upstream-attempt-binding', '/v1/chat/completions')`,
      [ids.tenantOne, ids.projectOne],
    );
    await pool.query(
      `INSERT INTO saas_route_config_heads
         (tenant_id, project_id, route_id, current_version, status)
       VALUES ($1, $2, 'attempt-route-byok', 1, 'active'),
              ($1, $2, 'attempt-route-platform', 1, 'active')`,
      [ids.tenantOne, ids.projectOne],
    );
  }
  await pool.query(
    `INSERT INTO saas_supplier_cost_versions
       (id, version, public_model_id, public_model_version, provider_id, product_id, resolved_model,
        protocol, endpoint, currency, commercial_policy_version, calculator_version, rounding_version,
        rounding_mode, rounding_boundary, input_rate_numerator_minor_units, input_rate_denominator_units,
        output_rate_numerator_minor_units, output_rate_denominator_units, effective_at, idempotency_key,
        definition_digest)
     VALUES ('supplier-v1', 1, 'public-model-a', 1, 'provider-a', 'product-a', 'actual-a',
             'openai', '/v1/chat/completions', 'USD', 'policy-v1', 'calculator-v1', 'rounding-v1',
             'half_up', 'total', 1, 1, 1, 1, '2026-09-28T00:00:00Z', 'supplier-v1-key', $1)`,
    ['b'.repeat(64)],
  );
  const projectPolicyColumn = withProjectPolicy ? ', project_policy_version' : '';
  const projectPolicyValue = withProjectPolicy ? ', 2' : '';
  const routeSnapshotColumns = withProjectPolicy
    ? ', route_config_id, route_config_version, route_public_model_id, route_public_model_version, route_protocol, route_target_mode, route_upstream_id'
    : '';
  const byokRouteSnapshot = withProjectPolicy
    ? ", 'attempt-route-byok', 1, 'public-model-a', 1, 'openai', 'tenant_account', 'upstream-attempt-binding'"
    : '';
  const platformRouteSnapshot = withProjectPolicy
    ? ", 'attempt-route-platform', 1, 'public-model-a', 1, 'openai', 'platform_pool', 'upstream-attempt-binding'"
    : '';
  await pool.query(
    `INSERT INTO saas_requests
       (id, tenant_id, project_id${projectPolicyColumn}${routeSnapshotColumns}, proxy_key_id, entitlement_id, supply_profile_id, supply_profile_version,
        model_scope_version, supply_mode, principal_kind, principal_id, authz_version, entitlement_version,
        config_version, public_model, protocol, endpoint, request_fingerprint, request_fingerprint_version,
        customer_price_version, financial_status)
     VALUES ($1, $2, $3${projectPolicyValue}${byokRouteSnapshot}, $4, $5, 'attempt-byok-one', 1, 1, 'byok', 'member', $6, 1, 1, 1,
             'attempt-public-model-a', 'openai', '/v1/chat/completions', $7, 'v1', NULL, 'not_applicable'),
            ($8, $2, $3${projectPolicyValue}${platformRouteSnapshot}, $9, $10, 'attempt-platform-one', 1, 1, 'platform', 'member', $6, 1, 1, 1,
             'attempt-public-model-a', 'openai', '/v1/chat/completions', $11, 'v1', 'customer-v1', 'pending')`,
    [
      ids.requestByok,
      ids.tenantOne,
      ids.projectOne,
      ids.keyByokOne,
      ids.entitlementByokOne,
      ids.userOne,
      '4'.repeat(64),
      ids.requestPlatform,
      ids.keyPlatformOne,
      ids.entitlementPlatformOne,
      '5'.repeat(64),
    ],
  );
}

test('orders migrations and holds a session advisory lock across the run', async () => {
  const pool = new MigrationPool();
  const migrations: SaasMigration[] = [
    { version: 2, name: 'second', sql: 'SECOND MIGRATION' },
    { version: 1, name: 'first', sql: 'FIRST MIGRATION' },
  ];

  await runSaasMigrations(pool, migrations);

  const firstApply = pool.events.indexOf('apply:FIRST MIGRATION');
  const secondApply = pool.events.indexOf('apply:SECOND MIGRATION');
  assert.ok(pool.events.indexOf('lock') < pool.events.indexOf('create-migration-table'));
  assert.ok(pool.events.indexOf('create-migration-table') < firstApply);
  assert.ok(firstApply < secondApply);
  assert.ok(secondApply < pool.events.indexOf('unlock'));
  assert.deepEqual(pool.releases, [false]);
  assert.deepEqual(
    pool.applied.map(({ version }) => version),
    [1, 2],
  );
});

test('the default migration runner applies the unique current 001-060 history and preserves the 050-052 segment', async () => {
  const pool = new MigrationPool();

  await runSaasMigrations(pool);

  const versions = Array.from({ length: 60 }, (_, index) => index + 1);
  assert.deepEqual(SAAS_MIGRATIONS.map(({ version }) => version), versions);
  assert.deepEqual(pool.applied.map(({ version }) => version), versions);
  assert.equal(new Set(pool.applied.map(({ version }) => version)).size, 60);
  assert.deepEqual(pool.applied.slice(49, 52).map(({ version }) => version), [50, 51, 52]);
  assert.deepEqual(pool.applied.slice(49).map(({ name }) => name), [
    'prepared_evidence_authorization_advisory_fences',
    'unknown_outcome_support_ticket',
    'commercial_authority_guard_rowtype_safety',
    'commercial_authority_read_fences',
    'trigger_only_trusted_execution',
    'prepared_evidence_optional_validity_scalars',
    'restricted_role_check_and_platform_auth_execution',
    'normal_success_usage_evidence_reference',
    'credential_validation_invalidation_trigger_execution',
    'pre_dispatch_terminal_cancellation',
    'prepared_evidence_claim_generated_account',
  ]);
  assert.equal(pool.applied.length, 60);
  assert.deepEqual(pool.applied, SAAS_MIGRATIONS.map(({ version, name, sql }) => ({
    version, name, checksum: createHash('sha256').update(name).update('\0').update(sql).digest('hex'),
  })), 'the runner must record the exact name-plus-NUL-plus-original-SQL checksum for every registered migration');
  assert.deepEqual(pool.events.filter((event) => event.startsWith('record:')), versions.map((version) => `record:${version}`));
});

test('reruns are idempotent and still acquire and release the advisory lock', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);
  const appliedCount = pool.events.filter((event) => event.startsWith('apply:')).length;

  pool.events.length = 0;
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  assert.equal(pool.events.filter((event) => event.startsWith('apply:')).length, 0);
  assert.equal(pool.events.filter((event) => event.startsWith('record:')).length, 0);
  assert.equal(pool.applied.length, SAAS_MIGRATIONS.length);
  assert.equal(appliedCount, SAAS_MIGRATIONS.length);
  assert.deepEqual(
    pool.events.filter((event) => event === 'lock' || event === 'unlock'),
    ['lock', 'unlock'],
  );
});

test('discards the checked-out client when advisory unlock fails after successful migrations', async () => {
  const unlockError = new Error('unlock failed');
  const pool = new MigrationPool({ unlockError });

  await assert.rejects(
    runSaasMigrations(pool, [{ version: 1, name: 'first', sql: 'FIRST MIGRATION' }]),
    (error: unknown) => error === unlockError,
  );

  assert.deepEqual(pool.releases, [true]);
  assert.deepEqual(
    pool.applied.map(({ version }) => version),
    [1],
  );
});

test('discards the checked-out client when advisory unlock reports that no lock was held', async () => {
  const pool = new MigrationPool({ unlockResult: false });

  await assert.rejects(
    runSaasMigrations(pool, [{ version: 1, name: 'first', sql: 'FIRST MIGRATION' }]),
    /Failed to release the SaaS migration advisory lock/,
  );

  assert.deepEqual(pool.releases, [true]);
  assert.deepEqual(
    pool.applied.map(({ version }) => version),
    [1],
  );
});

test('discards the checked-out client when advisory lock acquisition fails', async () => {
  const lockError = new Error('lock acquisition failed');
  const pool = new MigrationPool({ lockError });

  await assert.rejects(runSaasMigrations(pool), (error: unknown) => error === lockError);

  assert.deepEqual(pool.events, ['lock', 'release']);
  assert.deepEqual(pool.releases, [true]);
});

test('discards the checked-out client when a migration transaction cannot begin', async () => {
  const beginError = new Error('transaction start failed');
  const pool = new MigrationPool({ beginError });

  await assert.rejects(
    runSaasMigrations(pool, [{ version: 1, name: 'first', sql: 'FIRST MIGRATION' }]),
    (error: unknown) => error === beginError,
  );

  assert.deepEqual(
    pool.events.filter((event) => ['lock', 'begin', 'unlock', 'release'].includes(event)),
    ['lock', 'begin', 'unlock', 'release'],
  );
  assert.deepEqual(pool.releases, [true]);
});

test('preserves the migration error and discards the client when unlock also fails', async () => {
  const migrationError = new Error('migration failed');
  const pool = new MigrationPool({
    migrationError,
    unlockError: new Error('unlock failed'),
  });

  await assert.rejects(
    runSaasMigrations(pool, [{ version: 1, name: 'broken', sql: 'FAIL MIGRATION' }]),
    (error: unknown) => error === migrationError,
  );

  assert.deepEqual(pool.releases, [true]);
  assert.deepEqual(pool.applied, []);
});

test('initial schema preserves platform, membership, audit, and policy identity in v1', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.startsWith('apply:CREATE TABLE saas_users'));
  assert.ok(schemaEvent, 'the fake pool should receive the v1 initial schema');
  const sql = schemaEvent.slice('apply:'.length);
  const tableNames = [...sql.matchAll(/CREATE TABLE\s+(\w+)/g)].map((match) => match[1]);

  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: SAAS_MIGRATIONS.length }, (_, index) => index + 1),
  );
  assert.ok(tableNames.length >= 14);
  assert.ok(tableNames.every((name) => name?.startsWith('saas_')));
  assert.match(sql, /CREATE TABLE saas_bootstrap_tokens \(\s*token_hash text PRIMARY KEY/);
  assert.match(sql, /creator_user_agent text/);
  assert.doesNotMatch(sql, /bootstrap_token\s+text\s+NOT NULL/i);

  assert.match(
    sql,
    /CREATE TABLE saas_platform_state \(\s*singleton boolean PRIMARY KEY DEFAULT true CHECK \(singleton\),\s*initialized boolean NOT NULL DEFAULT false,\s*initialized_at timestamptz,/i,
  );
  assert.match(
    sql,
    /INSERT INTO saas_platform_state \(singleton, initialized, initialized_at\)\s*VALUES \(TRUE, FALSE, NULL\);/i,
  );
  assert.match(sql, /IF TG_OP IN \('DELETE', 'TRUNCATE'\) THEN/);
  assert.match(sql, /IF OLD\.initialized THEN/);
  assert.match(sql, /IF NEW\.initialized IS DISTINCT FROM TRUE THEN/);
  assert.match(sql, /NEW\.initialized_at := clock_timestamp\(\);/);
  assert.match(
    sql,
    /CREATE TRIGGER saas_platform_state_one_way\s+BEFORE UPDATE OR DELETE ON saas_platform_state\s+FOR EACH ROW/,
  );
  assert.match(
    sql,
    /CREATE TRIGGER saas_platform_state_no_truncate\s+BEFORE TRUNCATE ON saas_platform_state\s+FOR EACH STATEMENT/,
  );

  assert.match(sql, /status text NOT NULL DEFAULT 'active'\s+CHECK \(status IN \('active', 'suspended', 'revoked'\)\)/);
  assert.match(sql, /revoked_at timestamptz/);
  assert.match(
    sql,
    /CONSTRAINT saas_memberships_revocation_status CHECK \(\s*\(status = 'revoked' AND revoked_at IS NOT NULL\)\s*OR \(status <> 'revoked' AND revoked_at IS NULL\)/,
  );
  assert.match(sql, /CREATE TRIGGER saas_memberships_no_delete\s+BEFORE DELETE ON saas_memberships/);
  assert.match(sql, /anonymized_at timestamptz/);
  assert.match(sql, /CREATE TRIGGER saas_users_no_delete\s+BEFORE DELETE ON saas_users/);
  assert.doesNotMatch(sql, /REFERENCES saas_users\(id\)\s+ON DELETE (?:CASCADE|SET NULL)/i);
  assert.match(sql, /actor_user_id uuid REFERENCES saas_users\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /CREATE TABLE saas_policy_documents/);
  assert.match(
    sql,
    /CONSTRAINT saas_policy_acceptances_tenant_actor_fk\s+FOREIGN KEY \(tenant_id, actor_user_id\)\s+REFERENCES saas_memberships \(tenant_id, user_id\)/,
  );
  assert.match(sql, /CREATE TRIGGER saas_audit_events_immutable/);
  assert.match(sql, /CREATE TRIGGER saas_policy_acceptances_immutable/);
});

test('migration 014 is registered after the entitlement migrations', () => {
  assert.equal(SAAS_MIGRATIONS[13], REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION);
  assert.equal(REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION.version, 14);
  assert.equal(REQUEST_ADMISSION_OUTBOX_SAAS_MIGRATION.name, 'request_admission_metadata_outbox');
});

test('migrations 015-034 are unique, complete, and registered in order', () => {
  const versions = SAAS_MIGRATIONS.map(({ version }) => version);

  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(
    [...versions].sort((left, right) => left - right).slice(0, 34),
    Array.from({ length: 34 }, (_, index) => index + 1),
  );
  assert.ok(versions.slice(34).every((version) => version > 34));
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(14, 34).map(({ version, name }) => ({ version, name })),
    [
      { version: 15, name: 'provider_supply_accounts_and_credentials' },
      { version: 16, name: 'provider_supply_pools_and_profile_grants' },
      { version: 17, name: 'commercial_price_versions_and_request_snapshots' },
      { version: 18, name: 'attempt_provider_account_identity_binding' },
      { version: 19, name: 'attempt_dispatch_authority_refs_and_epochs' },
      { version: 20, name: 'supply_relationship_epochs_and_lifecycle' },
      { version: 21, name: 'project_inference_policy_versions_and_snapshots' },
      { version: 22, name: 'route_config_authority_versions_and_snapshots' },
      { version: 23, name: 'commercial_metering_policy_authority' },
      { version: 24, name: 'prepared_request_evidence' },
      { version: 25, name: 'provider_account_leases_with_fencing' },
      { version: 26, name: 'prepared_request_evidence_platform_pool_fence' },
      { version: 27, name: 'prepared_request_evidence_claim_pool_fence' },
      { version: 28, name: 'prepared_request_evidence_pool_claim_hardening' },
      { version: 29, name: 'model_resolution_provenance' },
      { version: 30, name: 'payment_orders_wallet_topup_fulfillment' },
      { version: 31, name: 'byok_service_plan_subscription_fulfillment' },
      { version: 32, name: 'payment_checkout_and_submission_fencing' },
      { version: 33, name: 'payment_webhook_durable_inbox_worker' },
      { version: 34, name: 'provider_catalog_product_write_fence' },
    ],
  );
  assert.equal(SAAS_MIGRATIONS[14], PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[15], PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[16], COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[17], ATTEMPT_PROVIDER_ACCOUNT_BINDING_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[18], ATTEMPT_DISPATCH_AUTHORITY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[19], SUPPLY_RELATIONSHIP_EPOCHS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[20], PROJECT_INFERENCE_POLICY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[21], ROUTE_CONFIG_AUTHORITY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[22], COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[23], PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[24], PROVIDER_ACCOUNT_LEASES_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[25], PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[26], PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[27], PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[28], MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[29], PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[30], BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[31], PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[32], PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[33], PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION);
});

test('migration 034 fences catalog inserts and BYOK account/capability inserts and updates', () => {
  const migration = PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION;
  const accountRightsFenceSql = migration.sql.match(
    /CREATE FUNCTION saas_provider_supply_require_byok_rights\(\) RETURNS trigger([\s\S]*?)\n\$\$;/i,
  )?.[1];
  const accountCapabilityFenceSql = migration.sql.match(
    /CREATE FUNCTION saas_provider_supply_require_byok_capability\(\) RETURNS trigger([\s\S]*?)\n\$\$;/i,
  )?.[1];

  assert.equal(SAAS_MIGRATIONS[33], migration);
  assert.equal(migration.version, 34);
  assert.equal(migration.name, 'provider_catalog_product_write_fence');
  assert.ok(accountRightsFenceSql, 'the BYOK account trigger function should be present');
  assert.ok(accountCapabilityFenceSql, 'the account capability trigger function should be present');
  assert.match(
    migration.sql,
    /PERFORM 1\s+FROM saas_provider_products\s+WHERE provider_id = NEW\.provider_id\s+AND product_id = NEW\.product_id\s+FOR UPDATE;/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_provider_capabilities_lock_product\s+BEFORE INSERT ON saas_provider_capabilities\s+FOR EACH ROW EXECUTE FUNCTION saas_catalog_lock_product_for_version_insert\(\);/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_provider_rights_lock_product\s+BEFORE INSERT ON saas_provider_rights\s+FOR EACH ROW EXECUTE FUNCTION saas_catalog_lock_product_for_version_insert\(\);/i,
  );

  assert.match(accountRightsFenceSql, /IF NEW\.supply_mode IS DISTINCT FROM 'byok' THEN\s+RETURN NEW;\s+END IF;/i);
  assert.match(
    accountRightsFenceSql,
    /PERFORM 1\s+FROM saas_provider_products\s+WHERE provider_id = NEW\.provider_id\s+AND product_id = NEW\.product_id\s+FOR SHARE;/i,
  );
  assert.match(
    accountRightsFenceSql,
    /rights\.rights_id = NEW\.rights_id\s+AND rights\.version = NEW\.rights_version[\s\S]+rights\.status = 'active'[\s\S]+rights\.effective_at <= qualification_time[\s\S]+rights\.expires_at IS NULL OR rights\.expires_at > qualification_time[\s\S]+latest\.effective_at <= qualification_time\s+ORDER BY latest\.effective_at DESC, latest\.version DESC\s+LIMIT 1/i,
  );
  assert.match(
    PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION.sql,
    /CREATE TABLE saas_tenant_provider_account_capabilities \([\s\S]+?capability_version integer NOT NULL CHECK \(capability_version >= 1\)/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_tenant_provider_accounts_require_byok_rights\s+BEFORE INSERT OR UPDATE ON saas_tenant_provider_accounts\s+FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_require_byok_rights\(\);/i,
  );

  assert.match(
    accountCapabilityFenceSql,
    /PERFORM 1\s+FROM saas_provider_products\s+WHERE provider_id = NEW\.provider_id\s+AND product_id = NEW\.product_id\s+FOR SHARE;/i,
  );
  assert.match(
    accountCapabilityFenceSql,
    /FROM saas_tenant_provider_accounts AS account\s+WHERE account\.tenant_id = NEW\.tenant_id\s+AND account\.id = NEW\.account_id\s+AND account\.provider_id = NEW\.provider_id\s+AND account\.product_id = NEW\.product_id/i,
  );
  assert.match(
    accountCapabilityFenceSql,
    /rights\.model_scope @> ARRAY\[NEW\.model\]::text\[\][\s\S]+rights\.endpoint_scope @> ARRAY\[NEW\.endpoint\]::text\[\][\s\S]+rights\.status = 'active'[\s\S]+rights\.effective_at <= qualification_time[\s\S]+rights\.expires_at IS NULL OR rights\.expires_at > qualification_time[\s\S]+latest\.effective_at <= qualification_time\s+ORDER BY latest\.effective_at DESC, latest\.version DESC\s+LIMIT 1/i,
  );
  assert.match(
    accountCapabilityFenceSql,
    /capability\.version = NEW\.capability_version[\s\S]+SELECT max\(latest\.version\)[\s\S]+latest\.endpoint = capability\.endpoint[\s\S]+capability\.validation_state = 'verified'[\s\S]+capability\.support_level IN \('supported', 'limited'\)/i,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_tenant_provider_account_capabilities_byok_fence\s+BEFORE INSERT OR UPDATE ON saas_tenant_provider_account_capabilities\s+FOR EACH ROW EXECUTE FUNCTION saas_provider_supply_require_byok_capability\(\);/i,
  );

  assert.match(
    migration.sql,
    /RAISE EXCEPTION 'Provider BYOK qualification is not valid'\s+USING ERRCODE = '23514',\s+CONSTRAINT = 'saas_tenant_provider_accounts_byok_rights_fence'/i,
  );
  assert.match(
    migration.sql,
    /RAISE EXCEPTION 'Provider BYOK capability qualification is not valid'\s+USING ERRCODE = '23514',\s+CONSTRAINT = 'saas_tenant_provider_account_capabilities_byok_fence'/i,
  );
  assert.doesNotMatch(
    migration.sql,
    /CREATE TRIGGER\s+\S+\s+BEFORE INSERT ON saas_platform_provider_(?:accounts|account_capabilities)/i,
  );
});

test('migration 020 adds independent member authority without historical attempt backfill', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.includes('ADD COLUMN authz_version bigint'));
  assert.ok(schemaEvent, 'the fake pool should receive the v20 relationship schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[19], SUPPLY_RELATIONSHIP_EPOCHS_SAAS_MIGRATION);
  assert.match(
    sql,
    /ALTER TABLE saas_platform_provider_pool_members\s+ADD COLUMN authz_version bigint NOT NULL DEFAULT 1/i,
  );
  assert.match(sql, /ALTER TABLE saas_attempts\s+ADD COLUMN pool_member_authz_version bigint/i);
  assert.match(sql, /CREATE TRIGGER saas_platform_provider_pool_members_relation_epoch_guard/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_pool_member_authority_epoch/i);
  assert.match(sql, /authz_version = NEW\.pool_member_authz_version/i);
  assert.match(sql, /Revoked provider supply relationships are terminal/i);
  assert.doesNotMatch(sql, /UPDATE\s+saas_attempts/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+saas_attempts/i);
});

test('migration 021 defaults project policy to suspended and preserves historical snapshot nulls', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) =>
    event.includes('CREATE TABLE saas_project_inference_policy_versions'),
  );
  assert.ok(schemaEvent, 'the fake pool should receive the v21 project policy schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[20], PROJECT_INFERENCE_POLICY_SAAS_MIGRATION);
  assert.match(sql, /ADD COLUMN inference_policy_version bigint NOT NULL DEFAULT 1/i);
  assert.match(sql, /ADD COLUMN inference_policy_status text NOT NULL DEFAULT 'suspended'/i);
  assert.match(sql, /CREATE TABLE saas_project_inference_policy_versions/i);
  assert.match(sql, /status text NOT NULL CHECK \(status IN \('active', 'suspended', 'disabled'\)\)/i);
  assert.match(sql, /INSERT INTO saas_project_inference_policy_versions[\s\S]*SELECT tenant_id, id, 1, 'suspended'/i);
  assert.match(sql, /CREATE TRIGGER saas_projects_inference_policy_head_guard/i);
  assert.match(sql, /ADD COLUMN project_policy_version bigint/i);
  assert.match(sql, /CREATE TRIGGER saas_requests_guard_project_policy_snapshot/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_project_policy_snapshot/i);
  assert.match(sql, /New SaaS requests require an exact project inference policy version/i);
  assert.match(sql, /New SaaS attempts require an exact project inference policy version/i);
  assert.match(sql, /Historical SaaS attempts cannot be assigned a project policy version/i);
  assert.doesNotMatch(sql, /UPDATE\s+saas_(requests|attempts)\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+saas_(requests|attempts)\b/i);
});

test('migration 022 makes route authority versioned, published, and snapshot-bound without history fabrication', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.includes('CREATE TABLE saas_route_config_heads'));
  assert.ok(schemaEvent, 'the fake pool should receive the v22 route authority schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[21], ROUTE_CONFIG_AUTHORITY_SAAS_MIGRATION);
  assert.match(sql, /CREATE TABLE saas_route_config_heads/i);
  assert.match(sql, /CREATE TABLE saas_route_config_versions/i);
  assert.match(sql, /current_version bigint NOT NULL CHECK \(current_version >= 1\)/i);
  assert.match(sql, /version bigint NOT NULL CHECK \(version >= 1\)/i);
  assert.match(sql, /target_mode text NOT NULL,\s*upstream_id text NOT NULL/i);
  const targetModeConstraints = sql.match(/CONSTRAINT saas_route_config_versions_target_mode_check\b/gi);
  assert.equal(targetModeConstraints?.length, 1);
  assert.match(sql, /CONSTRAINT saas_route_config_versions_target_mode_check CHECK \(/i);
  assert.match(sql, /supply_mode = 'byok' AND target_mode = 'tenant_account'/i);
  assert.match(sql, /supply_mode = 'platform' AND target_mode = 'platform_pool'/i);
  assert.match(sql, /CREATE TRIGGER saas_route_config_versions_immutable/i);
  assert.match(sql, /CREATE TRIGGER saas_route_config_version_guard/i);
  assert.match(sql, /CREATE TRIGGER saas_route_config_head_guard/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_route_dispatch/i);
  assert.match(sql, /ADD COLUMN route_config_id text/i);
  assert.match(sql, /ADD COLUMN route_config_version bigint/i);
  assert.match(sql, /ADD COLUMN route_public_model_id text/i);
  assert.match(sql, /ADD COLUMN route_public_model_version integer/i);
  assert.match(sql, /ADD COLUMN route_protocol text/i);
  assert.match(sql, /ADD COLUMN route_target_mode text/i);
  assert.match(sql, /ADD COLUMN route_upstream_id text/i);
  assert.match(sql, /saas_requests_route_config_snapshot_fk/i);
  assert.match(sql, /saas_requests_guard_route_snapshot/i);
  assert.match(sql, /saas_attempts_guard_route_snapshot/i);
  assert.match(sql, /New SaaS requests require an exact active route authority snapshot/i);
  assert.match(sql, /SaaS attempt route authority snapshot is immutable/i);
  assert.match(sql, /Historical SaaS attempts cannot be assigned a route authority snapshot/i);
  assert.match(sql, /current active published route/i);
  assert.match(sql, /active exact route head|active route authority snapshot/i);
  assert.doesNotMatch(sql, /UPDATE\s+saas_(requests|attempts)\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+saas_(requests|attempts)\b/i);
});

test('migration 023 makes commercial metering and contract authority immutable and fail-closed', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.includes('CREATE TABLE saas_customer_metering_policy_heads'));
  assert.ok(schemaEvent, 'the fake pool should receive the v23 commercial metering schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[22], COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION);
  assert.match(sql, /CREATE TABLE saas_customer_metering_policy_versions/i);
  assert.match(sql, /CREATE TABLE saas_customer_metering_policy_heads/i);
  assert.match(sql, /CREATE TABLE saas_provider_metering_policy_versions/i);
  assert.match(sql, /CREATE TABLE saas_provider_metering_policy_heads/i);
  assert.match(sql, /CREATE TABLE saas_contract_test_attestations/i);
  assert.match(sql, /customer_price_version IS DISTINCT FROM \(CASE[\s\S]*?END\)/i);
  const customerTargetModeConstraints = sql.match(
    /CONSTRAINT saas_customer_metering_policy_versions_target_mode_check\b/gi,
  );
  assert.equal(customerTargetModeConstraints?.length, 1);
  assert.match(sql, /target_mode text NOT NULL,\s*customer_price_version text/i);
  assert.match(
    sql,
    /CONSTRAINT saas_customer_metering_policy_versions_target_mode_check CHECK \([\s\S]*?supply_mode = 'byok' AND target_mode = 'tenant_account'[\s\S]*?supply_mode = 'platform' AND target_mode = 'platform_pool'/i,
  );
  const providerTargetModeConstraints = sql.match(
    /CONSTRAINT saas_provider_metering_policy_versions_target_mode_check\b/gi,
  );
  assert.equal(providerTargetModeConstraints?.length, 1);
  assert.match(sql, /target_mode text NOT NULL,\s*supplier_cost_version text/i);
  assert.match(
    sql,
    /CONSTRAINT saas_provider_metering_policy_versions_target_mode_check CHECK \([\s\S]*?supply_mode = 'byok' AND target_mode = 'tenant_account'[\s\S]*?supply_mode = 'platform' AND target_mode = 'platform_pool'/i,
  );
  assert.match(sql, /CREATE TABLE saas_route_config_commercial_authorities/i);
  assert.match(sql, /CREATE VIEW saas_route_config_dispatchable/i);
  assert.match(sql, /cph\.current_version = cp\.version/i);
  assert.match(sql, /pph\.current_version = pp\.version/i);
  assert.match(sql, /cph\.status = 'active'/i);
  assert.match(sql, /pph\.status = 'active'/i);
  assert.match(sql, /trusted|verif(?:ication|ied)/i);
  assert.match(sql, /CREATE TRIGGER saas_customer_metering_policy_versions_immutable/i);
  assert.match(sql, /CREATE TRIGGER saas_provider_metering_policy_versions_immutable/i);
  assert.match(sql, /CREATE TRIGGER saas_contract_test_attestations_immutable/i);
  assert.match(sql, /CREATE TRIGGER saas_route_config_commercial_authorities_immutable/i);
  assert.match(sql, /ADD COLUMN customer_metering_policy_id text/i);
  assert.match(sql, /ADD COLUMN provider_metering_policy_id text/i);
  assert.match(sql, /ADD COLUMN contract_attestation_id text/i);
  assert.match(sql, /Historical SaaS attempts cannot be assigned commercial authority/i);
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.doesNotMatch(sql, /UPDATE\s+saas_(requests|attempts)\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+saas_(requests|attempts)\b/i);
});

test('migration 024 makes prepared evidence signed, bounded, single-use, and history-safe', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.includes('CREATE TABLE saas_prepared_request_evidence'));
  assert.ok(schemaEvent, 'the fake pool should receive the v24 prepared evidence schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[23], PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION);
  assert.match(sql, /CREATE TABLE saas_prepared_request_evidence/i);
  assert.match(sql, /payload_sha256 text NOT NULL/i);
  assert.match(sql, /signature_base64 text NOT NULL/i);
  assert.match(sql, /statement_sha256 text NOT NULL/i);
  assert.match(sql, /verifier_key_id text NOT NULL/i);
  assert.match(sql, /usage_feasible_input_buckets text\[\] NOT NULL/i);
  assert.match(sql, /max_hold_minor_units bigint NOT NULL/i);
  assert.match(sql, /prepared_evidence_id uuid/i);
  assert.match(sql, /CREATE TRIGGER saas_prepared_request_evidence_immutable/i);
  assert.match(sql, /CREATE TRIGGER saas_prepared_request_evidence_guard/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_prepared_evidence/i);
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /FOR SHARE/i);
  assert.match(sql, /status = 'claimed'/i);
  assert.match(sql, /project-service prepared-request evidence is unsupported/i);
  assert.match(sql, /anonymized_at IS NULL/i);
  assert.match(sql, /revoked_at IS NOT NULL/i);
  assert.match(sql, /status = 'superseded'/i);
  assert.doesNotMatch(sql, /prompt|request_body|raw_headers|proxy_secret|credential_secret/i);
  assert.doesNotMatch(sql, /UPDATE\s+saas_(requests|attempts)\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+saas_(requests|attempts)\b/i);
});

test('migration 018 adds owner-specific attempt binding without backfilling legacy identity', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.includes('ADD COLUMN binding_state'));
  assert.ok(schemaEvent, 'the fake pool should receive the v18 binding schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[17], ATTEMPT_PROVIDER_ACCOUNT_BINDING_SAAS_MIGRATION);
  assert.match(sql, /ADD COLUMN binding_state text NOT NULL DEFAULT 'legacy'/i);
  assert.match(sql, /ADD COLUMN tenant_account_id text/i);
  assert.match(sql, /ADD COLUMN platform_account_id text/i);
  assert.match(sql, /ADD COLUMN provider_id text/i);
  assert.match(sql, /ADD COLUMN product_id text/i);
  assert.match(sql, /ADD COLUMN endpoint text/i);
  assert.match(sql, /binding_state = 'legacy'/i);
  assert.match(sql, /binding_state = 'bound'/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, tenant_account_id, provider_id, product_id\)/i);
  assert.match(sql, /REFERENCES saas_tenant_provider_accounts \(tenant_id, id, provider_id, product_id\)/i);
  assert.match(sql, /FOREIGN KEY \(platform_account_id, provider_id, product_id\)/i);
  assert.match(sql, /REFERENCES saas_platform_provider_accounts \(id, provider_id, product_id\)/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_provider_binding/i);
  assert.match(sql, /A BYOK request must use its tenant provider account/i);
  assert.match(sql, /A platform request must use its platform provider account and supplier cost version/i);
  assert.match(sql, /Historical SaaS attempts are non-dispatchable/i);
  assert.doesNotMatch(sql, /saas_attempts lacks platform_account_id/i);
});

test('migration 019 adds exact credential and mode-specific dispatch authority without backfilling', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.includes('ADD COLUMN dispatch_authority_state'));
  assert.ok(schemaEvent, 'the fake pool should receive the v19 dispatch authority schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.equal(SAAS_MIGRATIONS[18], ATTEMPT_DISPATCH_AUTHORITY_SAAS_MIGRATION);
  assert.match(sql, /ADD COLUMN dispatch_authority_state text NOT NULL DEFAULT 'unbound'/i);
  assert.match(sql, /ADD COLUMN credential_id text/i);
  assert.match(sql, /ADD COLUMN credential_version integer/i);
  assert.match(sql, /ADD COLUMN credential_authz_version bigint/i);
  assert.match(sql, /ADD COLUMN pool_id text/i);
  assert.match(sql, /ADD COLUMN pool_grant_authz_version bigint/i);
  assert.match(sql, /ADD COLUMN profile_account_authz_version bigint/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, tenant_credential_id, credential_version\)/i);
  assert.match(sql, /FOREIGN KEY \(pool_id, tenant_id, dispatch_profile_id\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, dispatch_profile_id, tenant_account_id\)/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_dispatch_authority/i);
  assert.match(sql, /Unbound SaaS attempts are non-dispatchable/i);
  assert.match(sql, /cannot be rebound after admission/i);
  assert.match(sql, /credential version is stale or mismatched/i);
  assert.match(sql, /pool grant is stale or mismatched/i);
  assert.doesNotMatch(sql, /UPDATE\s+saas_attempts/i);
});

test('migration 018 enforces account ownership and lets 017 join the exact platform attempt', {
  skip: !realPostgresUrl,
}, async () => {
  const ids = ATTEMPT_BINDING_FIXTURE;

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS);
    await seedAttemptBindingFixture(pool, true);

    const insertAttempt = async (input: {
      readonly id: string;
      readonly tenantId: string;
      readonly requestId: string;
      readonly ordinal: number;
      readonly ownerKind: 'tenant' | 'platform';
      readonly tenantAccountId: string | null;
      readonly platformAccountId: string | null;
      readonly providerId: string;
      readonly productId: string;
      readonly supplierCostVersion: string | null;
    }): Promise<void> => {
      const tenantAuthority = input.ownerKind === 'tenant';
      const platformRequest = input.requestId === ids.requestPlatform;
      await pool.query(
        `INSERT INTO saas_attempts
           (id, tenant_id, request_id, project_policy_version, route_config_id, route_config_version,
            route_public_model_id, route_public_model_version, route_protocol, route_target_mode,
            ordinal, upstream_id, binding_state, dispatch_authority_state,
            account_owner_kind,
            tenant_account_id, platform_account_id, provider_id, product_id, resolved_model,
            protocol, endpoint, supplier_cost_version, dispatch_profile_id, supply_profile_authz_version,
            credential_id, credential_version, credential_authz_version, account_authz_version,
            pool_id, pool_authz_version, pool_member_account_authz_version, pool_member_authz_version,
            pool_grant_authz_version, pool_grant_profile_authz_version, pool_grant_pool_authz_version,
            profile_account_authz_version)
         VALUES ($1, $2, $3, 2, '${platformRequest ? 'attempt-route-platform' : 'attempt-route-byok'}', 1,
                 'public-model-a', 1, 'openai', '${platformRequest ? 'platform_pool' : 'tenant_account'}',
                 $4, 'upstream-attempt-binding', 'bound', 'bound', $5, $6, $7, $8, $9,
                 'actual-a', 'openai', '/v1/chat/completions', $10, $11, $12, $13, 1, 1, 1,
                 $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          input.id,
          input.tenantId,
          input.requestId,
          input.ordinal,
          input.ownerKind,
          input.tenantAccountId,
          input.platformAccountId,
          input.providerId,
          input.productId,
          input.supplierCostVersion,
          platformRequest ? 'attempt-platform-one' : 'attempt-byok-one',
          1,
          tenantAuthority ? 'tenant-credential-a' : 'platform-credential-a',
          tenantAuthority ? null : 'pool-a',
          tenantAuthority ? null : 1,
          tenantAuthority ? null : 1,
          tenantAuthority ? null : 1,
          tenantAuthority ? null : 1,
          tenantAuthority ? null : 1,
          tenantAuthority ? null : 1,
          tenantAuthority ? 1 : null,
        ],
      );
    };

    await insertAttempt({
      id: ids.attemptByok,
      tenantId: ids.tenantOne,
      requestId: ids.requestByok,
      ordinal: 1,
      ownerKind: 'tenant',
      tenantAccountId: 'tenant-account-a',
      platformAccountId: null,
      providerId: 'provider-a',
      productId: 'product-a',
      supplierCostVersion: null,
    });
    await insertAttempt({
      id: ids.attemptPlatform,
      tenantId: ids.tenantOne,
      requestId: ids.requestPlatform,
      ordinal: 1,
      ownerKind: 'platform',
      tenantAccountId: null,
      platformAccountId: 'platform-account-a',
      providerId: 'provider-a',
      productId: 'product-a',
      supplierCostVersion: 'supplier-v1',
    });

    const stored = await pool.query<{
      binding_state: string;
      dispatch_authority_state: string;
      account_owner_kind: string;
      account_id: string;
      tenant_account_id: string | null;
      platform_account_id: string | null;
      provider_id: string;
      product_id: string;
      resolved_model: string;
      endpoint: string;
      dispatch_profile_id: string;
      credential_id: string;
      credential_version: number;
      credential_authz_version: string;
      account_authz_version: string;
      pool_id: string;
      pool_authz_version: string;
      pool_member_account_authz_version: string;
      pool_member_authz_version: string;
      pool_grant_authz_version: string;
      pool_grant_profile_authz_version: string;
      pool_grant_pool_authz_version: string;
    }>(
      `SELECT binding_state, dispatch_authority_state, account_owner_kind, account_id,
              tenant_account_id, platform_account_id, provider_id, product_id, resolved_model, endpoint,
              dispatch_profile_id, credential_id, credential_version, credential_authz_version,
              account_authz_version, pool_id, pool_authz_version, pool_member_account_authz_version,
              pool_member_authz_version,
              pool_grant_authz_version, pool_grant_profile_authz_version, pool_grant_pool_authz_version
       FROM saas_attempts
       WHERE tenant_id = $1 AND id = $2`,
      [ids.tenantOne, ids.attemptPlatform],
    );
    assert.deepEqual(stored.rows[0], {
      binding_state: 'bound',
      dispatch_authority_state: 'bound',
      account_owner_kind: 'platform',
      account_id: 'platform-account-a',
      tenant_account_id: null,
      platform_account_id: 'platform-account-a',
      provider_id: 'provider-a',
      product_id: 'product-a',
      resolved_model: 'actual-a',
      endpoint: '/v1/chat/completions',
      dispatch_profile_id: 'attempt-platform-one',
      credential_id: 'platform-credential-a',
      credential_version: 1,
      credential_authz_version: '1',
      account_authz_version: '1',
      pool_id: 'pool-a',
      pool_authz_version: '1',
      pool_member_account_authz_version: '1',
      pool_member_authz_version: '1',
      pool_grant_authz_version: '1',
      pool_grant_profile_authz_version: '1',
      pool_grant_pool_authz_version: '1',
    });

    await assert.rejects(
      insertAttempt({
        id: '00000000-0000-0000-0000-000000000671',
        tenantId: ids.tenantOne,
        requestId: ids.requestByok,
        ordinal: 2,
        ownerKind: 'platform',
        tenantAccountId: null,
        platformAccountId: 'platform-account-a',
        providerId: 'provider-a',
        productId: 'product-a',
        supplierCostVersion: null,
      }),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '23514' && pgError.message?.includes('BYOK dispatch authority') === true;
      },
    );
    await assert.rejects(
      insertAttempt({
        id: '00000000-0000-0000-0000-000000000672',
        tenantId: ids.tenantOne,
        requestId: ids.requestPlatform,
        ordinal: 2,
        ownerKind: 'tenant',
        tenantAccountId: 'tenant-account-a',
        platformAccountId: null,
        providerId: 'provider-a',
        productId: 'product-a',
        supplierCostVersion: 'supplier-v1',
      }),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '23514' && pgError.message?.includes('platform dispatch authority') === true;
      },
    );
    await assert.rejects(
      insertAttempt({
        id: '00000000-0000-0000-0000-000000000673',
        tenantId: ids.tenantOne,
        requestId: ids.requestByok,
        ordinal: 2,
        ownerKind: 'tenant',
        tenantAccountId: 'tenant-account-b',
        platformAccountId: null,
        providerId: 'provider-a',
        productId: 'product-a',
        supplierCostVersion: null,
      }),
      (error: unknown) => {
        const pgError = error as { code?: string; constraint?: string; message?: string };
        return pgError.code === '23514' && pgError.message?.includes('tenant account authority') === true;
      },
    );
    await assert.rejects(
      insertAttempt({
        id: '00000000-0000-0000-0000-000000000674',
        tenantId: ids.tenantOne,
        requestId: ids.requestPlatform,
        ordinal: 2,
        ownerKind: 'platform',
        tenantAccountId: null,
        platformAccountId: 'platform-account-b',
        providerId: 'provider-a',
        productId: 'product-a',
        supplierCostVersion: 'supplier-v1',
      }),
      (error: unknown) => {
        const pgError = error as { code?: string; constraint?: string; message?: string };
        return pgError.code === '23514' && pgError.message?.includes('platform account authority') === true;
      },
    );

    await pool.query(
      `UPDATE saas_platform_provider_accounts
          SET authz_version = 2
        WHERE id = 'platform-account-a'`,
    );
    await assert.rejects(
      pool.query(
        `UPDATE saas_attempts
         SET dispatch_state = 'dispatching', updated_at = now() + interval '1 second', state_version = 2
         WHERE tenant_id = $1 AND id = $2`,
        [ids.tenantOne, ids.attemptPlatform],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '23514' && pgError.message?.includes('platform account authority') === true;
      },
    );
    await pool.query(
      `UPDATE saas_platform_provider_accounts
          SET authz_version = 1
        WHERE id = 'platform-account-a'`,
    );
    await pool.query(
      `UPDATE saas_attempts
       SET dispatch_state = 'dispatching', updated_at = now() + interval '1 second', state_version = 2
       WHERE tenant_id = $1 AND id = $2`,
      [ids.tenantOne, ids.attemptPlatform],
    );
    await assert.rejects(
      pool.query(
        `UPDATE saas_attempts
         SET platform_account_id = 'platform-account-b', provider_id = 'provider-b', product_id = 'product-b',
             credential_id = 'platform-credential-b', credential_version = 1,
             resolved_model = 'other-model', updated_at = '2026-09-28T00:01:01Z', state_version = 3
         WHERE tenant_id = $1 AND id = $2`,
        [ids.tenantOne, ids.attemptPlatform],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '55000' && pgError.message?.includes('immutable once dispatch starts') === true;
      },
    );

    await pool.query(
      `INSERT INTO saas_attempt_supplier_cost_snapshots
         (id, tenant_id, request_id, attempt_id, supplier_cost_version, platform_account_id,
          public_model_id, public_model_version, provider_id, product_id, resolved_model, protocol, endpoint,
          currency, commercial_policy_version, calculator_version, rounding_version, rounding_mode,
          rounding_boundary, idempotency_key, snapshot_digest)
       VALUES ('supplier-snapshot-attempt-binding', $1, $2, $3, 'supplier-v1', 'platform-account-a',
               'public-model-a', 1, 'provider-a', 'product-a', 'actual-a', 'openai', '/v1/chat/completions',
               'USD', 'policy-v1', 'calculator-v1', 'rounding-v1', 'half_up', 'total',
               'supplier-snapshot-attempt-binding-key', $4)`,
      [ids.tenantOne, ids.requestPlatform, ids.attemptPlatform, 'c'.repeat(64)],
    );
    const joined = await pool.query<{
      snapshot_account_id: string;
      attempt_account_id: string;
      snapshot_request_id: string;
      attempt_request_id: string;
      attempt_supplier_cost_version: string;
    }>(
      `SELECT snapshot.platform_account_id AS snapshot_account_id,
              attempt.platform_account_id AS attempt_account_id,
              snapshot.request_id AS snapshot_request_id,
              attempt.request_id AS attempt_request_id,
              attempt.supplier_cost_version AS attempt_supplier_cost_version
       FROM saas_attempt_supplier_cost_snapshots AS snapshot
       JOIN saas_attempts AS attempt
         ON attempt.tenant_id = snapshot.tenant_id
        AND attempt.id = snapshot.attempt_id
       WHERE snapshot.id = 'supplier-snapshot-attempt-binding'`,
    );
    assert.deepEqual(joined.rows[0], {
      snapshot_account_id: 'platform-account-a',
      attempt_account_id: 'platform-account-a',
      snapshot_request_id: ids.requestPlatform,
      attempt_request_id: ids.requestPlatform,
      attempt_supplier_cost_version: 'supplier-v1',
    });

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_attempt_supplier_cost_snapshots
           (id, tenant_id, request_id, attempt_id, supplier_cost_version, platform_account_id,
            public_model_id, public_model_version, provider_id, product_id, resolved_model, protocol, endpoint,
            currency, commercial_policy_version, calculator_version, rounding_version, rounding_mode,
            rounding_boundary, idempotency_key, snapshot_digest)
         VALUES ('supplier-snapshot-wrong-attempt', $1, $2, $3, 'supplier-v1', 'platform-account-a',
                 'public-model-a', 1, 'provider-a', 'product-a', 'actual-a', 'openai', '/v1/chat/completions',
                 'USD', 'policy-v1', 'calculator-v1', 'rounding-v1', 'half_up', 'total',
                 'supplier-snapshot-wrong-attempt-key', $4)`,
        [ids.tenantOne, ids.requestPlatform, ids.attemptByok, 'd'.repeat(64)],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '23514' && pgError.message?.includes('not joined') === true;
      },
    );
  });
});

test('migrations 018-019 leave historical and authority-less attempts non-dispatchable', {
  skip: !realPostgresUrl,
}, async () => {
  const ids = ATTEMPT_BINDING_FIXTURE;

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS.slice(0, 18));
    await seedAttemptBindingFixture(pool);
    await pool.query(
      `INSERT INTO saas_attempts
         (id, tenant_id, request_id, ordinal, upstream_id, resolved_model, protocol)
       VALUES ($1, $2, $3, 1, 'legacy-upstream', 'actual-a', 'openai')`,
      [ids.legacyAttempt, ids.tenantOne, ids.requestByok],
    );
    await pool.query(
      `INSERT INTO saas_attempts
         (id, tenant_id, request_id, ordinal, upstream_id, binding_state, account_owner_kind,
          tenant_account_id, provider_id, product_id, resolved_model, protocol, endpoint)
       VALUES ($1, $2, $3, 2, 'authorityless-upstream', 'bound', 'tenant',
               'tenant-account-a', 'provider-a', 'product-a', 'actual-a', 'openai', '/v1/chat/completions')`,
      [ids.authoritylessAttempt, ids.tenantOne, ids.requestByok],
    );

    await runSaasMigrations(pool, SAAS_MIGRATIONS);
    const legacy = await pool.query<{
      binding_state: string;
      account_owner_kind: string | null;
      account_id: string | null;
      tenant_account_id: string | null;
      platform_account_id: string | null;
      provider_id: string | null;
      product_id: string | null;
      endpoint: string | null;
    }>(
      `SELECT binding_state, account_owner_kind, account_id, tenant_account_id, platform_account_id,
              provider_id, product_id, endpoint
       FROM saas_attempts
       WHERE tenant_id = $1 AND id = $2`,
      [ids.tenantOne, ids.legacyAttempt],
    );
    assert.deepEqual(legacy.rows[0], {
      binding_state: 'legacy',
      account_owner_kind: null,
      account_id: null,
      tenant_account_id: null,
      platform_account_id: null,
      provider_id: null,
      product_id: null,
      endpoint: null,
    });

    const authorityless = await pool.query<{
      binding_state: string;
      dispatch_authority_state: string;
      credential_id: string | null;
      dispatch_profile_id: string | null;
    }>(
      `SELECT binding_state, dispatch_authority_state, credential_id, dispatch_profile_id
       FROM saas_attempts
       WHERE tenant_id = $1 AND id = $2`,
      [ids.tenantOne, ids.authoritylessAttempt],
    );
    assert.deepEqual(authorityless.rows[0], {
      binding_state: 'bound',
      dispatch_authority_state: 'unbound',
      credential_id: null,
      dispatch_profile_id: null,
    });

    await assert.rejects(
      pool.query(
        `UPDATE saas_attempts
         SET dispatch_state = 'dispatching', updated_at = '2026-09-28T00:01:00Z', state_version = 2
         WHERE tenant_id = $1 AND id = $2`,
        [ids.tenantOne, ids.legacyAttempt],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '55000' && pgError.message?.includes('non-dispatchable') === true;
      },
    );
    await assert.rejects(
      pool.query(
        `UPDATE saas_attempts
         SET dispatch_state = 'dispatching', updated_at = '2026-09-28T00:01:01Z', state_version = 2
         WHERE tenant_id = $1 AND id = $2`,
        [ids.tenantOne, ids.authoritylessAttempt],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; message?: string };
        return pgError.code === '55000' && pgError.message?.includes('non-dispatchable') === true;
      },
    );
  });
});

test('migration 002 preserves tenant boundaries and makes project authorization revocable', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  const schemaEvent = pool.events.find((event) => event.startsWith('apply:ALTER TABLE saas_projects'));
  assert.ok(schemaEvent, 'the fake pool should receive the v2 project authorization schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.match(sql, /ALTER TABLE saas_projects ADD COLUMN is_default boolean NOT NULL DEFAULT false;/i);
  assert.match(sql, /ROW_NUMBER\(\) OVER \( PARTITION BY tenant_id ORDER BY created_at ASC, id ASC \)/i);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX saas_projects_one_default_per_tenant_idx\s+ON saas_projects \(tenant_id\)\s+WHERE is_default;/i,
  );
  assert.match(sql, /CREATE TRIGGER saas_projects_assign_default\s+BEFORE INSERT ON saas_projects/);

  assert.match(sql, /DROP CONSTRAINT IF EXISTS saas_projects_tenant_id_fkey;/i);
  assert.match(sql, /REFERENCES saas_tenants \(id\) ON DELETE RESTRICT;/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS saas_invitations_tenant_id_fkey;/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);

  assert.match(sql, /CREATE TABLE saas_project_memberships \(/i);
  assert.match(sql, /PRIMARY KEY \(tenant_id, project_id, user_id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id\)\s+REFERENCES saas_projects \(tenant_id, id\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, user_id\)\s+REFERENCES saas_memberships \(tenant_id, user_id\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(
    sql,
    /status text NOT NULL DEFAULT 'active'\s+CHECK \(status IN \('active', 'suspended', 'revoked'\)\)/i,
  );
  assert.match(
    sql,
    /CONSTRAINT saas_project_memberships_revocation_status CHECK \(\s*\(status = 'revoked' AND revoked_at IS NOT NULL\)\s*OR \(status <> 'revoked' AND revoked_at IS NULL\)/i,
  );
  assert.match(sql, /CREATE TRIGGER saas_project_memberships_no_delete\s+BEFORE DELETE ON saas_project_memberships/);
  assert.match(sql, /CREATE TRIGGER saas_tenants_no_delete\s+BEFORE DELETE ON saas_tenants/);
});

test('migration 003 backfills legacy tenant memberships without overwriting project access', () => {
  const pool = new MigrationPool();

  assert.equal(SAAS_MIGRATIONS[2], PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION);
  return runSaasMigrations(pool, SAAS_MIGRATIONS).then(() => {
    const schemaEvent = pool.events.find((event) => event.startsWith('apply:INSERT INTO saas_project_memberships'));
    assert.ok(schemaEvent, 'the fake pool should receive the v3 project membership backfill');
    const sql = schemaEvent.slice('apply:'.length);

    assert.match(
      sql,
      /FROM saas_memberships AS membership\s+JOIN saas_projects AS project\s+ON project\.tenant_id = membership\.tenant_id/i,
    );
    assert.match(
      sql,
      /membership\.role,\s*membership\.status,\s*membership\.revoked_at,\s*membership\.created_at,\s*membership\.updated_at/i,
    );
    assert.match(sql, /ON CONFLICT \(tenant_id, project_id, user_id\) DO NOTHING/i);
    assert.equal(pool.applied.length, SAAS_MIGRATIONS.length);
  });
});

test('migration 004 stores only key digests and aligns all tenant/project/member foreign keys', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  assert.equal(SAAS_MIGRATIONS[3], API_KEYS_SAAS_MIGRATION);
  const schemaEvent = pool.events.find((event) => event.startsWith('apply:CREATE TABLE saas_api_keys'));
  assert.ok(schemaEvent, 'the fake pool should receive the v4 API key schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.match(sql, /CREATE TABLE saas_api_keys \(/i);
  assert.match(sql, /key_hash text NOT NULL UNIQUE\s+CHECK \(key_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.doesNotMatch(sql, /\bsecret\b/i);
  assert.match(sql, /model_scopes text\[\] NOT NULL/i);
  assert.match(sql, /cardinality\(model_scopes\) > 0/i);
  assert.match(sql, /supply_mode text NOT NULL\s+CHECK \(supply_mode IN \('byok', 'platform'\)\)/i);
  assert.match(sql, /status text NOT NULL DEFAULT 'active'\s+CHECK \(status IN \('active', 'revoked'\)\)/i);
  assert.match(sql, /authz_version bigint NOT NULL DEFAULT 1/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id\)\s+REFERENCES saas_projects \(tenant_id, id\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id, principal_user_id\)\s+REFERENCES saas_project_memberships \(tenant_id, project_id, user_id\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(sql, /FOREIGN KEY \(principal_user_id\)\s+REFERENCES saas_users \(id\)\s+ON DELETE RESTRICT/i);
  assert.match(sql, /CREATE TRIGGER saas_api_keys_no_delete\s+BEFORE DELETE ON saas_api_keys/i);
});

test('migration 005 stores tenant-scoped supply profiles and one active entitlement per project/mode', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  assert.equal(SAAS_MIGRATIONS[4], SUPPLY_PROFILES_AND_ENTITLEMENTS_SAAS_MIGRATION);
  const schemaEvent = pool.events.find((event) => event.startsWith('apply:CREATE TABLE saas_supply_profiles'));
  assert.ok(schemaEvent, 'the fake pool should receive the v5 supply schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.match(sql, /CREATE TABLE saas_supply_profiles \(/i);
  assert.match(sql, /tenant_id uuid NOT NULL/i);
  assert.match(sql, /supply_mode text NOT NULL\s+CHECK \(supply_mode IN \('byok', 'platform'\)\)/i);
  assert.match(sql, /status text NOT NULL DEFAULT 'active'\s+CHECK \(status IN \('active', 'disabled'\)\)/i);
  assert.match(sql, /model_scopes text\[\] NOT NULL/i);
  assert.match(sql, /cardinality\(model_scopes\) > 0/i);
  assert.match(sql, /authz_version bigint NOT NULL DEFAULT 1/i);
  assert.match(sql, /last_audited_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(sql, /CREATE TABLE saas_project_entitlements \(/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id\)\s+REFERENCES saas_projects \(tenant_id, id\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, supply_profile_id, supply_mode\)\s+REFERENCES saas_supply_profiles \(tenant_id, id, supply_mode\)\s+ON DELETE RESTRICT/i,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX saas_project_entitlements_one_active_per_project_mode_idx\s+ON saas_project_entitlements \(tenant_id, project_id, supply_mode\)\s+WHERE status = 'active'/i,
  );
  assert.match(sql, /MIGRATION COMPATIBILITY WARNING/i);
  assert.match(sql, /ALTER TABLE saas_api_keys\s+ADD CONSTRAINT saas_api_keys_supply_profile_fk/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, supply_profile_id, supply_mode\)/i);
  assert.match(sql, /REFERENCES saas_supply_profiles \(tenant_id, id, supply_mode\)\s+ON DELETE RESTRICT\s+NOT VALID/i);
});

test('migration 006 binds new keys to a concrete project entitlement while preserving legacy rows', async () => {
  const pool = new MigrationPool();
  await runSaasMigrations(pool, SAAS_MIGRATIONS);

  assert.equal(SAAS_MIGRATIONS[5], API_KEY_ENTITLEMENT_BINDING_SAAS_MIGRATION);
  const schemaEvent = pool.events.find((event) => event.startsWith('apply:/*'));
  assert.ok(schemaEvent, 'the fake pool should receive the v6 entitlement binding schema');
  const sql = schemaEvent.slice('apply:'.length);

  assert.match(sql, /UNIQUE \(tenant_id, project_id, id, supply_profile_id, supply_mode\)/i);
  assert.match(sql, /ALTER TABLE saas_api_keys\s+ADD COLUMN entitlement_id uuid/i);
  assert.match(sql, /CONSTRAINT saas_api_keys_entitlement_binding_fk/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id, entitlement_id, supply_profile_id, supply_mode\)\s+REFERENCES saas_project_entitlements\s+\(tenant_id, project_id, id, supply_profile_id, supply_mode\)\s+ON DELETE RESTRICT\s+NOT VALID/i,
  );
  assert.match(sql, /CREATE TRIGGER saas_api_keys_require_entitlement_binding/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF entitlement_id ON saas_api_keys/i);
  assert.match(sql, /New SaaS API keys require a project entitlement/i);
  assert.match(sql, /SaaS API key entitlement cannot be cleared/i);
});

test('migration 005/006 upgrades legacy API keys without entitlements and enforces new binding writes', {
  skip: !realPostgresUrl,
}, async () => {
  const tenantId = '00000000-0000-0000-0000-000000000401';
  const userId = '00000000-0000-0000-0000-000000000411';
  const projectId = '00000000-0000-0000-0000-000000000421';
  const legacyKeyId = '00000000-0000-0000-0000-000000000431';
  const newKeyId = '00000000-0000-0000-0000-000000000432';

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS.slice(0, 4));
    await pool.query(
      `INSERT INTO saas_users (id, email)
       VALUES ($1, 'legacy-key-owner@example.com')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO saas_tenants (id, name, slug)
       VALUES ($1, 'Legacy key tenant', 'legacy-key-tenant')`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug)
       VALUES ($1, $2, 'Legacy key project', 'legacy-key-project')`,
      [tenantId, projectId],
    );
    await pool.query(
      `INSERT INTO saas_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [tenantId, userId],
    );
    await pool.query(
      `INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [tenantId, projectId, userId],
    );
    await pool.query(
      `INSERT INTO saas_api_keys
         (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
          name, prefix, key_hash, model_scopes)
       VALUES ($1, $2, $3, $4, 'legacy-unmapped-profile', 'byok',
               'Legacy unmapped key', 'mr_live_legacy01', $5, ARRAY['model-a'])`,
      [legacyKeyId, tenantId, projectId, userId, '1'.repeat(64)],
    );

    await runSaasMigrations(pool, SAAS_MIGRATIONS);

    const constraint = await pool.query<{
      conname: string;
      contype: string;
      convalidated: boolean;
    }>(
      `SELECT conname, contype, convalidated
       FROM pg_constraint
       WHERE conname = 'saas_api_keys_supply_profile_fk'
         AND conrelid = 'saas_api_keys'::regclass`,
    );
    assert.equal(constraint.rowCount, 1);
    assert.equal(constraint.rows[0]?.conname, 'saas_api_keys_supply_profile_fk');
    assert.equal(constraint.rows[0]?.contype, 'f');
    assert.equal(constraint.rows[0]?.convalidated, false);

    const legacyKey = await pool.query<{
      entitlement_id: string | null;
      supply_profile_id: string;
      supply_mode: string;
      key_hash: string;
    }>(
      `SELECT entitlement_id, supply_profile_id, supply_mode, key_hash
       FROM saas_api_keys
       WHERE id = $1`,
      [legacyKeyId],
    );
    assert.deepEqual(legacyKey.rows[0], {
      entitlement_id: null,
      supply_profile_id: 'legacy-unmapped-profile',
      supply_mode: 'byok',
      key_hash: '1'.repeat(64),
    });

    const entitlements = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM saas_project_entitlements',
    );
    assert.equal(entitlements.rows[0]?.count, '0');

    await pool.query(
      `UPDATE saas_api_keys
       SET status = 'revoked', revoked_at = now(), authz_version = 2
       WHERE id = $1`,
      [legacyKeyId],
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, entitlement_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, $5, 'newly-unmapped-profile', 'byok',
                 'New invalid profile key', 'mr_live_newkey01', $6, ARRAY['model-a'])`,
        [newKeyId, tenantId, projectId, userId, '00000000-0000-0000-0000-000000000499', '2'.repeat(64)],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; constraint?: string };
        return pgError.code === '23503' && pgError.constraint === 'saas_api_keys_supply_profile_fk';
      },
    );
  });
});

test('migration 006 enforces the complete project-entitlement/profile/mode binding', {
  skip: !realPostgresUrl,
}, async () => {
  const tenantId = '00000000-0000-0000-0000-000000000501';
  const userId = '00000000-0000-0000-0000-000000000511';
  const projectId = '00000000-0000-0000-0000-000000000521';
  const entitlementId = '00000000-0000-0000-0000-000000000531';
  const wrongEntitlementId = '00000000-0000-0000-0000-000000000532';
  const validKeyId = '00000000-0000-0000-0000-000000000541';
  const nullKeyId = '00000000-0000-0000-0000-000000000542';
  const wrongKeyId = '00000000-0000-0000-0000-000000000543';

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS);
    await pool.query(`INSERT INTO saas_users (id, email) VALUES ($1, 'binding-owner@example.com')`, [userId]);
    await pool.query(`INSERT INTO saas_tenants (id, name, slug) VALUES ($1, 'Binding tenant', 'binding-tenant')`, [
      tenantId,
    ]);
    await pool.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug) VALUES ($1, $2, 'Binding project', 'binding-project')`,
      [tenantId, projectId],
    );
    await pool.query(`INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      tenantId,
      userId,
    ]);
    await pool.query(
      `INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [tenantId, projectId, userId],
    );
    await pool.query(
      `INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes)
       VALUES ($1, 'binding-platform', 'platform', ARRAY['model-a', 'model-b'])`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO saas_project_entitlements
         (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
       VALUES ($1, $2, $3, 'binding-platform', 'platform', ARRAY['model-a'])`,
      [entitlementId, tenantId, projectId],
    );

    await pool.query(
      `INSERT INTO saas_api_keys
         (id, tenant_id, project_id, principal_user_id, entitlement_id, supply_profile_id, supply_mode,
          name, prefix, key_hash, model_scopes)
       VALUES ($1, $2, $3, $4, $5, 'binding-platform', 'platform',
               'Bound key', 'mr_live_binding01', $6, ARRAY['model-a'])`,
      [validKeyId, tenantId, projectId, userId, entitlementId, 'a'.repeat(64)],
    );
    const stored = await pool.query<{
      entitlement_id: string;
      supply_profile_id: string;
      supply_mode: string;
      model_scopes: string[];
    }>(
      `SELECT entitlement_id, supply_profile_id, supply_mode, model_scopes
       FROM saas_api_keys WHERE id = $1`,
      [validKeyId],
    );
    assert.deepEqual(stored.rows[0], {
      entitlement_id: entitlementId,
      supply_profile_id: 'binding-platform',
      supply_mode: 'platform',
      model_scopes: ['model-a'],
    });

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, entitlement_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, NULL, 'binding-platform', 'platform',
                 'Null binding', 'mr_live_binding02', $5, ARRAY['model-a'])`,
        [nullKeyId, tenantId, projectId, userId, 'b'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, entitlement_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, $5, 'binding-platform', 'platform',
                 'Wrong binding', 'mr_live_binding03', $6, ARRAY['model-a'])`,
        [wrongKeyId, tenantId, projectId, userId, wrongEntitlementId, 'c'.repeat(64)],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; constraint?: string };
        return pgError.code === '23503' && pgError.constraint === 'saas_api_keys_entitlement_binding_fk';
      },
    );

    await assert.rejects(
      pool.query(`UPDATE saas_api_keys SET entitlement_id = NULL WHERE id = $1`, [validKeyId]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
  });
});

test('migration 005 enforces supply mode, scope, status, version, and tenant/project boundaries in PostgreSQL', {
  skip: !realPostgresUrl,
}, async () => {
  const tenantOne = '00000000-0000-0000-0000-000000000301';
  const tenantTwo = '00000000-0000-0000-0000-000000000302';
  const projectOne = '00000000-0000-0000-0000-000000000311';
  const profileOne = 'platform-primary';
  const profileByok = 'byok-primary';
  const profileDisabled = 'platform-disabled';
  const entitlementOne = '00000000-0000-0000-0000-000000000321';
  const entitlementDuplicate = '00000000-0000-0000-0000-000000000322';
  const entitlementWrongTenant = '00000000-0000-0000-0000-000000000323';
  const entitlementWrongMode = '00000000-0000-0000-0000-000000000324';
  const entitlementByok = '00000000-0000-0000-0000-000000000325';

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS);
    await pool.query(
      `INSERT INTO saas_tenants (id, name, slug)
       VALUES ($1, 'Supply tenant one', 'supply-tenant-one'), ($2, 'Supply tenant two', 'supply-tenant-two')`,
      [tenantOne, tenantTwo],
    );
    await pool.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug)
       VALUES ($1, $2, 'Supply project one', 'supply-project-one')`,
      [tenantOne, projectOne],
    );
    await pool.query(
      `INSERT INTO saas_supply_profiles
         (tenant_id, id, supply_mode, model_scopes)
       VALUES ($1, $2, 'platform', ARRAY['model-a', 'model-b']),
              ($1, $3, 'byok', ARRAY['model-a'])`,
      [tenantOne, profileOne, profileByok],
    );
    await pool.query(
      `INSERT INTO saas_project_entitlements
         (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
       VALUES ($1, $2, $3, $4, 'platform', ARRAY['model-a'])`,
      [entitlementOne, tenantOne, projectOne, profileOne],
    );
    await pool.query(
      `INSERT INTO saas_project_entitlements
         (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
       VALUES ($1, $2, $3, $4, 'byok', ARRAY['model-a'])`,
      [entitlementByok, tenantOne, projectOne, profileByok],
    );

    const stored = await pool.query<{
      supply_mode: string;
      entitlement_scopes: string[];
      profile_scopes: string[];
      authz_version: string;
      last_audited_at: Date;
    }>(
      `SELECT e.supply_mode,
              e.model_scopes AS entitlement_scopes,
              p.model_scopes AS profile_scopes,
              e.authz_version,
              e.last_audited_at
       FROM saas_project_entitlements e
       JOIN saas_supply_profiles p
         ON p.tenant_id = e.tenant_id
        AND p.id = e.supply_profile_id
        AND p.supply_mode = e.supply_mode
       WHERE e.id = $1`,
      [entitlementOne],
    );
    assert.equal(stored.rows[0]?.supply_mode, 'platform');
    assert.deepEqual(stored.rows[0]?.entitlement_scopes, ['model-a']);
    assert.deepEqual(stored.rows[0]?.profile_scopes, ['model-a', 'model-b']);
    assert.equal(stored.rows[0]?.authz_version, '1');
    assert.ok(stored.rows[0]?.last_audited_at instanceof Date);

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_entitlements
           (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
         VALUES ($1, $2, $3, $4, 'platform', ARRAY['model-a'])`,
        [entitlementDuplicate, tenantOne, projectOne, profileOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, model_scopes)
         VALUES ($1, 'invalid-empty-scope', 'platform', ARRAY[]::text[])`,
        [tenantOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, model_scopes, authz_version)
         VALUES ($1, 'invalid-version', 'platform', ARRAY['model-a'], 0)`,
        [tenantOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_supply_profiles
           (tenant_id, id, supply_mode, model_scopes, status, disabled_at)
         VALUES ($1, $2, 'platform', ARRAY['model-a'], 'disabled', NULL)`,
        [tenantOne, profileDisabled],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await pool.query(
      `INSERT INTO saas_supply_profiles
         (tenant_id, id, supply_mode, model_scopes, status, disabled_at)
       VALUES ($1, $2, 'platform', ARRAY['model-a'], 'disabled', now())`,
      [tenantOne, profileDisabled],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_entitlements
           (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
         VALUES ($1, $2, $3, $4, 'platform', ARRAY['model-a'])`,
        [entitlementWrongTenant, tenantTwo, projectOne, profileOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_entitlements
           (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes, status, disabled_at)
         VALUES ($1, $2, $3, $4, 'platform', ARRAY['model-a'], 'disabled', now())`,
        [entitlementWrongMode, tenantOne, projectOne, profileByok],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
  });
});

test('migration 004 enforces digest, scope, and project-member constraints in PostgreSQL', {
  skip: !realPostgresUrl,
}, async () => {
  const tenantOne = '00000000-0000-0000-0000-000000000201';
  const tenantTwo = '00000000-0000-0000-0000-000000000202';
  const userOne = '00000000-0000-0000-0000-000000000211';
  const userTwo = '00000000-0000-0000-0000-000000000212';
  const projectOne = '00000000-0000-0000-0000-000000000221';
  const keyOne = '00000000-0000-0000-0000-000000000231';
  const keyInvalidHash = '00000000-0000-0000-0000-000000000232';
  const keyEmptyScopes = '00000000-0000-0000-0000-000000000233';
  const keyWrongProject = '00000000-0000-0000-0000-000000000234';
  const keyWrongMember = '00000000-0000-0000-0000-000000000235';
  const keyWrongProfileTenant = '00000000-0000-0000-0000-000000000236';
  const keyWrongProfileMode = '00000000-0000-0000-0000-000000000237';
  const keyDisabledProfile = '00000000-0000-0000-0000-000000000238';

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS.slice(0, 5));
    await pool.query(`INSERT INTO saas_users (id, email) VALUES ($1, $2), ($3, $4)`, [
      userOne,
      'keys-owner@example.com',
      userTwo,
      'keys-other@example.com',
    ]);
    await pool.query(
      `INSERT INTO saas_tenants (id, name, slug) VALUES ($1, 'Keys tenant one', 'keys-tenant-one'), ($2, 'Keys tenant two', 'keys-tenant-two')`,
      [tenantOne, tenantTwo],
    );
    await pool.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug) VALUES ($1, $2, 'Keys project', 'keys-project')`,
      [tenantOne, projectOne],
    );
    await pool.query(`INSERT INTO saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      tenantOne,
      userOne,
    ]);
    await pool.query(
      `INSERT INTO saas_project_memberships (tenant_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [tenantOne, projectOne, userOne],
    );
    await pool.query(
      `INSERT INTO saas_supply_profiles
         (tenant_id, id, supply_mode, model_scopes)
       VALUES ($1, 'profile', 'byok', ARRAY['model-a']),
              ($2, 'profile-foreign', 'byok', ARRAY['model-a'])`,
      [tenantOne, tenantTwo],
    );
    await pool.query(
      `INSERT INTO saas_supply_profiles
         (tenant_id, id, supply_mode, model_scopes, status, disabled_at)
       VALUES ($1, 'profile-disabled', 'byok', ARRAY['model-a'], 'disabled', now())`,
      [tenantOne],
    );

    const digest = 'a'.repeat(64);
    await pool.query(
      `INSERT INTO saas_api_keys
         (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
          name, prefix, key_hash, model_scopes)
       VALUES ($1, $2, $3, $4, 'profile', 'byok', 'Key', 'mr_live_abcdefgh', $5, ARRAY['model-a'])`,
      [keyOne, tenantOne, projectOne, userOne, digest],
    );
    const stored = await pool.query<{ key_hash: string; model_scopes: string[] }>(
      `SELECT key_hash, model_scopes FROM saas_api_keys WHERE id = $1`,
      [keyOne],
    );
    assert.equal(stored.rows[0]?.key_hash, digest);
    assert.deepEqual(stored.rows[0]?.model_scopes, ['model-a']);

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, 'profile-foreign', 'byok', 'Cross-tenant profile', 'mr_live_abcdefgh', $5, ARRAY['model-a'])`,
        [keyWrongProfileTenant, tenantOne, projectOne, userOne, 'e'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, 'profile', 'platform', 'Wrong profile mode', 'mr_live_abcdefgh', $5, ARRAY['model-a'])`,
        [keyWrongProfileMode, tenantOne, projectOne, userOne, 'f'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await pool.query(
      `INSERT INTO saas_api_keys
         (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
          name, prefix, key_hash, model_scopes)
       VALUES ($1, $2, $3, $4, 'profile-disabled', 'byok', 'Historical disabled profile key', 'mr_live_abcdefgh', $5, ARRAY['model-a'])`,
      [keyDisabledProfile, tenantOne, projectOne, userOne, '0'.repeat(64)],
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, 'profile', 'byok', 'Invalid hash', 'mr_live_abcdefgh', 'plaintext', ARRAY['model-a'])`,
        [keyInvalidHash, tenantOne, projectOne, userOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, 'profile', 'byok', 'Empty scopes', 'mr_live_abcdefgh', $5, ARRAY[]::text[])`,
        [keyEmptyScopes, tenantOne, projectOne, userOne, 'b'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, 'profile', 'byok', 'Wrong project', 'mr_live_abcdefgh', $5, ARRAY['model-a'])`,
        [keyWrongProject, tenantTwo, projectOne, userOne, 'c'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_api_keys
           (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode,
            name, prefix, key_hash, model_scopes)
         VALUES ($1, $2, $3, $4, 'profile', 'byok', 'Wrong member', 'mr_live_abcdefgh', $5, ARRAY['model-a'])`,
        [keyWrongMember, tenantOne, projectOne, userTwo, 'd'.repeat(64)],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await assert.rejects(
      pool.query('DELETE FROM saas_api_keys WHERE id = $1', [keyOne]),
      (error: unknown) => (error as { code?: string }).code === '55000',
    );
  });
});

test('project membership migrations satisfy PostgreSQL backfill, status, and composite FK behavior', {
  skip: !realPostgresUrl,
}, async () => {
  const tenantOne = '00000000-0000-0000-0000-000000000001';
  const tenantTwo = '00000000-0000-0000-0000-000000000002';
  const userOne = '00000000-0000-0000-0000-000000000011';
  const userTwo = '00000000-0000-0000-0000-000000000012';
  const userThree = '00000000-0000-0000-0000-000000000013';
  const projectOne = '00000000-0000-0000-0000-000000000101';
  const projectTwo = '00000000-0000-0000-0000-000000000102';
  const projectThree = '00000000-0000-0000-0000-000000000103';
  const projectFour = '00000000-0000-0000-0000-000000000104';
  const projectFive = '00000000-0000-0000-0000-000000000105';

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS);
    const history = await pool.query<{ version: number }>(
      'SELECT version FROM saas_schema_migrations ORDER BY version',
    );
    assert.deepEqual(
      history.rows.map(({ version }) => Number(version)),
      SAAS_MIGRATIONS.map(({ version }) => version),
    );
    const projectMembershipTable = await pool.query<{ table_name: string }>(
      `SELECT to_regclass('saas_project_memberships') AS table_name`,
    );
    assert.equal(projectMembershipTable.rows[0]?.table_name, 'saas_project_memberships');
  });

  await withScopedPostgresSchema(async (pool) => {
    await runSaasMigrations(pool, SAAS_MIGRATIONS.slice(0, 2));

    await pool.query(
      `INSERT INTO saas_users (id, email)
       VALUES ($1, $2), ($3, $4), ($5, $6)`,
      [
        userOne,
        'legacy-owner@example.com',
        userTwo,
        'legacy-suspended@example.com',
        userThree,
        'legacy-revoked@example.com',
      ],
    );
    await pool.query(
      `INSERT INTO saas_tenants (id, name, slug)
       VALUES ($1, 'Legacy Tenant One', 'legacy-tenant-one'), ($2, 'Legacy Tenant Two', 'legacy-tenant-two')`,
      [tenantOne, tenantTwo],
    );
    await pool.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug)
       VALUES ($1, $2, 'Project One', 'project-one'),
              ($1, $3, 'Project Two', 'project-two'),
              ($4, $5, 'Project Three', 'project-three')`,
      [tenantOne, projectOne, projectTwo, tenantTwo, projectThree],
    );
    await pool.query(
      `INSERT INTO saas_memberships
         (tenant_id, user_id, role, status, revoked_at, created_at, updated_at)
       VALUES
         ($1, $2, 'owner', 'active', NULL, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z'),
         ($1, $3, 'viewer', 'suspended', NULL, '2024-02-01T00:00:00Z', '2024-02-02T00:00:00Z'),
         ($1, $4, 'developer', 'revoked', '2024-03-01T00:00:00Z', '2024-03-02T00:00:00Z', '2024-03-03T00:00:00Z'),
         ($5, $2, 'billing', 'active', NULL, '2024-04-01T00:00:00Z', '2024-04-02T00:00:00Z')`,
      [tenantOne, userOne, userTwo, userThree, tenantTwo],
    );
    await pool.query(
      `INSERT INTO saas_project_memberships
         (tenant_id, project_id, user_id, role, status, revoked_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'viewer', 'active', NULL, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z')`,
      [tenantOne, projectOne, userOne],
    );

    await runSaasMigrations(pool, SAAS_MIGRATIONS);

    const rows = await pool.query<{
      tenant_id: string;
      project_id: string;
      user_id: string;
      role: string;
      status: string;
      revoked_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT tenant_id, project_id, user_id, role, status, revoked_at, created_at, updated_at
       FROM saas_project_memberships
       ORDER BY tenant_id, project_id, user_id`,
    );
    assert.equal(rows.rowCount, 7);

    const findMembership = (projectId: string, userId: string) =>
      rows.rows.find((row) => row.tenant_id === tenantOne && row.project_id === projectId && row.user_id === userId);
    const copiedActive = findMembership(projectTwo, userOne);
    assert.ok(copiedActive);
    assert.deepEqual(
      {
        role: copiedActive.role,
        status: copiedActive.status,
        revokedAt: copiedActive.revoked_at,
        createdAt: copiedActive.created_at.toISOString(),
        updatedAt: copiedActive.updated_at.toISOString(),
      },
      {
        role: 'owner',
        status: 'active',
        revokedAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    );

    const copiedSuspended = findMembership(projectOne, userTwo);
    assert.ok(copiedSuspended);
    assert.equal(copiedSuspended.role, 'viewer');
    assert.equal(copiedSuspended.status, 'suspended');
    assert.equal(copiedSuspended.revoked_at, null);

    const copiedRevoked = findMembership(projectOne, userThree);
    assert.ok(copiedRevoked);
    assert.equal(copiedRevoked.role, 'developer');
    assert.equal(copiedRevoked.status, 'revoked');
    assert.equal(copiedRevoked.revoked_at?.toISOString(), '2024-03-01T00:00:00.000Z');

    const existingMembership = findMembership(projectOne, userOne);
    assert.ok(existingMembership);
    assert.deepEqual(
      {
        role: existingMembership.role,
        status: existingMembership.status,
        createdAt: existingMembership.created_at.toISOString(),
        updatedAt: existingMembership.updated_at.toISOString(),
      },
      {
        role: 'viewer',
        status: 'active',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
    );

    const countBeforeRepeat = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM saas_project_memberships',
    );
    await pool.query(PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION.sql);
    await pool.query(PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION.sql);
    const countAfterRepeat = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM saas_project_memberships',
    );
    assert.equal(countAfterRepeat.rows[0]?.count, countBeforeRepeat.rows[0]?.count);
    const existingAfterRepeat = await pool.query<{ role: string; created_at: Date; updated_at: Date }>(
      `SELECT role, created_at, updated_at
       FROM saas_project_memberships
       WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3`,
      [tenantOne, projectOne, userOne],
    );
    assert.equal(existingAfterRepeat.rows[0]?.role, 'viewer');
    assert.equal(existingAfterRepeat.rows[0]?.created_at.toISOString(), '2025-01-01T00:00:00.000Z');
    assert.equal(existingAfterRepeat.rows[0]?.updated_at.toISOString(), '2025-01-02T00:00:00.000Z');

    await pool.query(
      `INSERT INTO saas_projects (tenant_id, id, name, slug)
       VALUES ($1, $2, 'Project Four', 'project-four'), ($1, $3, 'Project Five', 'project-five')`,
      [tenantOne, projectFour, projectFive],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_memberships
           (tenant_id, project_id, user_id, role, status, revoked_at)
         VALUES ($1, $2, $3, 'owner', 'suspended', '2025-01-01T00:00:00Z')`,
        [tenantOne, projectFour, userOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_memberships
           (tenant_id, project_id, user_id, role, status, revoked_at)
         VALUES ($1, $2, $3, 'owner', 'revoked', NULL)`,
        [tenantOne, projectFive, userOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_memberships
           (tenant_id, project_id, user_id, role, status)
         VALUES ($1, $2, $3, 'viewer', 'active')`,
        [tenantTwo, projectOne, userOne],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_project_memberships
           (tenant_id, project_id, user_id, role, status)
         VALUES ($1, $2, $3, 'viewer', 'active')`,
        [tenantTwo, projectThree, userTwo],
      ),
      (error: unknown) => (error as { code?: string }).code === '23503',
    );
  });
});
