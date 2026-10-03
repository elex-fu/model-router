import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import {
  createProviderCredentialContext, sealProviderCredential,
  type ProviderCredentialEnvelope, type ProviderCredentialKms,
} from '../../../src/saas/credentials/provider-crypto.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type {
  SaasDatabase, SaasDatabaseClient, SaasDatabasePool, SqlExecutor, SqlResult,
} from '../../../src/saas/db/types.js';
import type { ApprovedCredentialValidationTarget } from '../../../src/saas/supply/types.js';
import { approvedTarget } from './credential-validation-test-fixture.js';

// Test-private real pg transport: no query/result/type-parser substitution.
// In particular, the role's exact default search_path is NOT overridden.
function result<Row>(value: QueryResult): SqlResult<Row> {
  return { rows: value.rows as Row[], rowCount: value.rowCount };
}
class InvalidationPgClient implements SaasDatabaseClient {
  constructor(private readonly client: PoolClient) {}
  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    return result<Row>(await this.client.query(sql, values ? [...values] : undefined));
  }
  release(error?: Error | boolean): void { this.client.release(error); }
}
class InvalidationPgPool implements SaasDatabasePool {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000,
      options: '-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=20000' });
  }
  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    return result<Row>(await this.pool.query(sql, values ? [...values] : undefined));
  }
  async connect(): Promise<SaasDatabaseClient> { return new InvalidationPgClient(await this.pool.connect()); }
  async end(): Promise<void> { await this.pool.end(); }
}
export function invalidationDatabase(connectionString: string): SaasDatabase {
  return createSaasDatabase({ connectionString, pool: new InvalidationPgPool(connectionString) });
}

const DEPLOYMENT = 'credential-validation-invalidation-pg';
const ENVIRONMENT = 'test';
const PURPOSE = 'inference';
export const INVALIDATION_AUDIT_ENTRY_POINT = 'credential-validation-invalidation-real-pg';

/** Only fixture-generated keys, context-bound to fixture-sealed envelopes. */
export class InvalidationFixtureKms implements ProviderCredentialKms {
  decryptCalls = 0;
  private readonly keys = new Map<string, { key: Buffer; context: string; id: string }>();
  private context(value: Readonly<Record<string, string>>): string {
    return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const key = randomBytes(32); const wrapped = Buffer.from(randomUUID());
    this.keys.set(createHash('sha256').update(wrapped).digest('hex'), {
      key: Buffer.from(key), context: this.context(request.encryptionContext), id: request.kmsKeyId,
    });
    return { plaintextKey: key, ciphertextBlob: wrapped };
  }
  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]) {
    const entry = this.keys.get(createHash('sha256').update(request.ciphertextBlob).digest('hex'));
    assert.ok(entry, 'only this root\'s synthetic envelopes may reach KMS');
    assert.ok(entry.context === this.context(request.encryptionContext) && entry.id === request.kmsKeyId,
      'synthetic KMS owner/purpose/deployment context must match');
    this.decryptCalls += 1;
    return Buffer.from(entry.key);
  }
  close(): void { for (const entry of this.keys.values()) entry.key.fill(0); this.keys.clear(); }
}
export interface InvalidationFixture {
  label: string; tenants: [string, string]; accounts: [string, string]; credentials: [string, string];
  actorId: string; auditRequestId: string; rightsId: string; target: ApprovedCredentialValidationTarget;
  jobId: string; historyJobId: string; sameAccountCredentialId: string; sameAccountJobId: string;
  unrelatedJobIds: [string, string];
}
export function invalidationStoreOptions() {
  return { deployment: DEPLOYMENT, environment: ENVIRONMENT, leaseTtlMs: 120_000,
    maxAttempts: 5, retryBaseMs: 100, retryMaxMs: 1_000 };
}
export async function invalidationEnvelope(kms: InvalidationFixtureKms, fixture: InvalidationFixture,
  tenantId: string, accountId: string, credentialId: string, version: number): Promise<ProviderCredentialEnvelope> {
  const plaintext = Buffer.from('synthetic-invalidation-fixture-credential');
  try {
    return await sealProviderCredential(plaintext, createProviderCredentialContext({
      ownerKind: 'tenant', tenantId, supplyMode: 'byok', deployment: DEPLOYMENT, environment: ENVIRONMENT,
      purpose: PURPOSE, providerId: fixture.target.providerId, productId: fixture.target.productId,
      credentialType: 'api-key', accountId, credentialId, credentialVersion: version,
    }), kms, 'kms/invalidation-synthetic-fixture');
  } finally { plaintext.fill(0); }
}

export async function seedInvalidationFixture(migrator: SaasDatabase, kms: InvalidationFixtureKms): Promise<InvalidationFixture> {
  const label = randomUUID();
  const f: InvalidationFixture = {
    label, tenants: [randomUUID(), randomUUID()], accounts: [`cvi-account-${label}`, `cvi-other-account-${label}`],
    credentials: [`cvi-credential-${label}`, `cvi-other-credential-${label}`], actorId: randomUUID(),
    auditRequestId: randomUUID(), rightsId: `cvi-rights-${label}`,
    target: approvedTarget({ model: `fixture/invalidation-${label}`, approvalReference: `synthetic-cvi-${label}` }),
    jobId: randomUUID(), historyJobId: randomUUID(), sameAccountCredentialId: `cvi-sibling-${label}`,
    sameAccountJobId: randomUUID(), unrelatedJobIds: [randomUUID(), randomUUID()],
  };
  await migrator.transaction(async (tx) => {
    assert.equal((await tx.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role, 'model_router_saas_migrator');
    // Legal fixture setup only. No role, schema, migration, bootstrap or historic
    // ledger changes. The real worker, never MIG, creates every tested lease.
    for (const tenant of f.tenants) await tx.query(
      "INSERT INTO saas_tenants(id,name,slug) VALUES($1::uuid,'Synthetic invalidation fixture',$2)", [tenant, `cvi-${tenant}`]);
    await tx.query("INSERT INTO saas_users(id,email,display_name) VALUES($1::uuid,$2,'Synthetic audit actor')",
      [f.actorId, `cvi-${label}@example.test`]);
    await tx.query(`INSERT INTO saas_provider_products(provider_id,product_id,display_name)
      VALUES($1,$2,'Synthetic custom validation fixture') ON CONFLICT(provider_id,product_id) DO NOTHING`,
    [f.target.providerId, f.target.productId]);
    assert.equal((await tx.query<{ active: boolean }>(`SELECT status='active' AS active FROM saas_provider_products
      WHERE provider_id=$1 AND product_id=$2`, [f.target.providerId, f.target.productId])).rows[0]?.active, true);
    await tx.query(`INSERT INTO saas_provider_capabilities
      (provider_id,product_id,model,endpoint,protocol,version,support_level,validation_state,
       evidence_version,discovery_source,evidence_ref,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,1,'supported','verified','validation-target-v1','manual',$6,$7)`,
    [f.target.providerId, f.target.productId, f.target.model, f.target.endpoint, f.target.protocol,
      f.target.approvalReference, f.target.evidenceSha256]);
    await tx.query(`INSERT INTO saas_provider_rights
      (rights_id,version,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,
       effective_at,approval_ref,status,evidence_ref,evidence_sha256)
      VALUES($1,1,$2,$3,'api-key','byok','cvi-test',$4,ARRAY[$5]::text[],ARRAY[$6]::text[],
       clock_timestamp()-interval '1 minute','synthetic-cvi-rights','active','synthetic-cvi-rights',$7)`,
    [f.rightsId, f.target.providerId, f.target.productId, PURPOSE, f.target.model, f.target.endpoint, 'a'.repeat(64)]);
    const seededAccounts = new Set<string>();
    for (const [tenant, account, credential, head] of [
      [f.tenants[0], f.accounts[0], f.credentials[0], 2],
      [f.tenants[0], f.accounts[0], f.sameAccountCredentialId, 1],
      [f.tenants[0], f.accounts[1], f.credentials[1], 1],
      [f.tenants[1], f.accounts[0], f.credentials[0], 1],
    ] as const) {
      const identity = `${tenant}/${account}`;
      if (!seededAccounts.has(identity)) {
        await tx.query(`INSERT INTO saas_tenant_provider_accounts
        (tenant_id,id,display_name,provider_id,product_id,credential_type,region,purpose,rights_id,rights_version)
        VALUES($1::uuid,$2,'Synthetic validation account',$3,$4,'api-key','cvi-test',$5,$6,1)`,
        [tenant, account, f.target.providerId, f.target.productId, PURPOSE, f.rightsId]);
        await tx.query(`INSERT INTO saas_tenant_provider_account_capabilities
        (tenant_id,account_id,provider_id,product_id,model,endpoint,capability_version)
        VALUES($1::uuid,$2,$3,$4,$5,$6,1)`,
        [tenant, account, f.target.providerId, f.target.productId, f.target.model, f.target.endpoint]);
        seededAccounts.add(identity);
      }
      await tx.query(`INSERT INTO saas_tenant_provider_credentials
        (tenant_id,id,account_id,provider_id,product_id,credential_type)
        VALUES($1::uuid,$2,$3,$4,$5,'api-key')`, [tenant, credential, account, f.target.providerId, f.target.productId]);
      for (let version = 1; version <= head; version += 1) {
        const envelope = await invalidationEnvelope(kms, f, tenant, account, credential, version);
        await tx.query(`INSERT INTO saas_tenant_provider_credential_versions
          (tenant_id,account_id,credential_id,version,schema_version,context_version,algorithm,kms_purpose,kms_key_id,
           wrapped_dek,nonce,ciphertext,auth_tag,status,retired_at)
          VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
            CASE WHEN $15::boolean THEN NULL ELSE clock_timestamp()-interval '1 minute' END)`,
        [tenant, account, credential, version, envelope.schemaVersion, envelope.contextVersion, envelope.algorithm,
          PURPOSE, envelope.kmsKeyId, envelope.wrappedDek, envelope.nonce, envelope.ciphertext, envelope.authTag,
          version === head ? 'active' : 'retired', version === head]);
      }
      // Initial head precedes job setup; no owner DML is used as invalidation.
      await tx.query('UPDATE saas_tenant_provider_credentials SET current_version=$3 WHERE tenant_id=$1::uuid AND id=$2',
        [tenant, credential, head]);
    }
    for (const [id, tenant, account, credential, version, state, due] of [
      [f.historyJobId, f.tenants[0], f.accounts[0], f.credentials[0], 1, 'verified', false],
      [f.jobId, f.tenants[0], f.accounts[0], f.credentials[0], 2, 'queued', true],
      [f.sameAccountJobId, f.tenants[0], f.accounts[0], f.sameAccountCredentialId, 1, 'queued', false],
      [f.unrelatedJobIds[0], f.tenants[0], f.accounts[1], f.credentials[1], 1, 'queued', false],
      [f.unrelatedJobIds[1], f.tenants[1], f.accounts[0], f.credentials[0], 1, 'queued', false],
    ] as const) await tx.query(`INSERT INTO saas_tenant_provider_credential_validation_jobs
      (id,tenant_id,account_id,credential_id,credential_version,provider_id,product_id,credential_type,
       allowed_models,target_model,target_endpoint,capability_version,idempotency_key,status,
       attempt_count,lease_generation,available_at,completed_at)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,'api-key',ARRAY[$8]::text[],$8,$9,1,$10,$11,
        CASE WHEN $11='verified' THEN 2 ELSE 0 END, CASE WHEN $11='verified' THEN 5 ELSE 0 END,
        CASE WHEN $12::boolean THEN clock_timestamp()-interval '1 minute' ELSE clock_timestamp()+interval '1 day' END,
        CASE WHEN $11='verified' THEN clock_timestamp()-interval '2 minutes' ELSE NULL END)`,
    [id, tenant, account, credential, version, f.target.providerId, f.target.productId, f.target.model, f.target.endpoint,
      createHash('sha256').update(id).digest('hex'), state, due]);
  });
  return f;
}

export interface InvalidationJobRow {
  id: string; tenant_id: string; account_id: string; credential_id: string; credential_version: number;
  provider_id: string; product_id: string; credential_type: string; allowed_models: string[];
  target_model: string; target_endpoint: string; capability_version: number; idempotency_key: string;
  status: string; attempt_count: number; available_at: string; lease_until: string | null;
  lease_generation: string; last_error_code: string | null; completed_at: string | null; created_at: string; updated_at: string;
}
export async function invalidationJobs(reader: SqlExecutor, f: InvalidationFixture): Promise<InvalidationJobRow[]> {
  return (await reader.query<InvalidationJobRow>(`SELECT id::text,tenant_id::text,account_id,credential_id,credential_version,
    provider_id,product_id,credential_type,allowed_models,target_model,target_endpoint,capability_version,idempotency_key,
    status,attempt_count,available_at::text,lease_until::text,lease_generation::text,last_error_code,
    completed_at::text,created_at::text,updated_at::text FROM saas_tenant_provider_credential_validation_jobs
    WHERE id=ANY($1::uuid[]) ORDER BY id`, [[f.jobId, f.historyJobId, f.sameAccountJobId, ...f.unrelatedJobIds]])).rows;
}
export async function invalidationOutcomes(reader: SqlExecutor, f: InvalidationFixture) {
  const accounts = (await reader.query<Record<string, unknown>>(`SELECT tenant_id::text,id,status,validation_state,validation_error_code,
    last_validated_at::text,authz_version::text,disabled_at::text,revoked_at::text,created_at::text,updated_at::text
    FROM saas_tenant_provider_accounts WHERE tenant_id=ANY($1::uuid[]) AND id=ANY($2::text[]) ORDER BY tenant_id,id`,
  [f.tenants, f.accounts])).rows;
  const credentials = (await reader.query<Record<string, unknown>>(`SELECT tenant_id::text,id,account_id,status,current_version,validation_state,
    validation_error_code,last_validated_at::text,authz_version::text,expires_at::text,disabled_at::text,
    revoked_at::text,created_at::text,updated_at::text FROM saas_tenant_provider_credentials
    WHERE tenant_id=ANY($1::uuid[]) AND id=ANY($2::text[]) ORDER BY tenant_id,id`,
  [f.tenants, [...f.credentials, f.sameAccountCredentialId]])).rows;
  // No envelope/KMS material is selected, even by the snapshot actor.
  const versions = (await reader.query<Record<string, unknown>>(`SELECT tenant_id::text,account_id,credential_id,version,status,
    created_at::text,expires_at::text,retired_at::text,revoked_at::text FROM saas_tenant_provider_credential_versions
    WHERE tenant_id=ANY($1::uuid[]) AND credential_id=ANY($2::text[]) ORDER BY tenant_id,credential_id,version`,
  [f.tenants, [...f.credentials, f.sameAccountCredentialId]])).rows;
  const capabilities = (await reader.query<Record<string, unknown>>(`SELECT provider_id,product_id,model,endpoint,protocol,version,support_level,
    validation_state,evidence_version,discovery_source,evidence_ref,evidence_sha256,created_at::text
    FROM saas_provider_capabilities WHERE provider_id=$1 AND product_id=$2 AND model=$3 ORDER BY version`,
  [f.target.providerId, f.target.productId, f.target.model])).rows;
  const bindings = (await reader.query<Record<string, unknown>>(`SELECT tenant_id::text,account_id,provider_id,product_id,
    model,endpoint,capability_version FROM saas_tenant_provider_account_capabilities
    WHERE tenant_id=ANY($1::uuid[]) AND account_id=ANY($2::text[]) ORDER BY tenant_id,account_id,model,endpoint`,
  [f.tenants, f.accounts])).rows;
  const rights = (await reader.query<Record<string, unknown>>(`SELECT rights_id,version,provider_id,product_id,
    status,effective_at::text,expires_at::text,evidence_ref,evidence_sha256 FROM saas_provider_rights
    WHERE rights_id=$1 ORDER BY version`, [f.rightsId])).rows;
  const audit = (await reader.query<Record<string, unknown>>(`SELECT id::text,tenant_id::text,actor_user_id::text,action,target_type,target_id,
    occurred_at::text,entry_point,request_id::text FROM saas_audit_events
    WHERE request_id=$1::text AND entry_point=$2 ORDER BY id`, [f.auditRequestId, INVALIDATION_AUDIT_ENTRY_POINT])).rows;
  return { accounts, credentials, versions, capabilities, bindings, rights, audit };
}
export async function invalidationSnapshot(reader: SqlExecutor, f: InvalidationFixture) {
  return { jobs: await invalidationJobs(reader, f), outcomes: await invalidationOutcomes(reader, f) };
}
export async function invalidationCatalog(reader: SqlExecutor): Promise<unknown> {
  return (await reader.query<{ value: unknown }>(`SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='model_router_saas'),
    'tables',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas'),
    'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas'),
    'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname='model_router_saas'),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='model_router_saas')) AS value`)).rows[0]?.value;
}
