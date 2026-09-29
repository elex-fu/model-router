import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialContext,
  type ProviderCredentialEnvelope,
  type ProviderCredentialKms,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  type GatewayProviderCredentialAccount,
  type GatewayProviderCredentialCredential,
  GatewayProviderCredentialUnsealer,
} from '../../../src/saas/runtime/gateway-provider-credential-unsealer.js';
import type { ProviderCredentialValidationFetch } from '../../../src/saas/supply/credential-validation-adapters.js';
import { CredentialValidationWorker } from '../../../src/saas/supply/credential-validation-worker.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';

const DATA_KEY = Buffer.alloc(32, 23);
const context: ProviderCredentialContext = createProviderCredentialContext({
  ownerKind: 'tenant',
  tenantId: 'tenant-a',
  supplyMode: 'byok',
  deployment: 'worker-test',
  environment: 'test',
  purpose: 'inference',
  providerId: 'kimi',
  productId: 'kimi-platform',
  credentialType: 'api-key',
  accountId: 'account-a',
  credentialId: 'credential-a',
  credentialVersion: 1,
});

function contextKey(context: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

class ContextBoundTestKms implements ProviderCredentialKms {
  readonly requestedContexts: string[] = [];
  private readonly entries = new Map<
    string,
    { readonly key: Buffer; readonly context: string; readonly kmsKeyId: string }
  >();
  private sequence = 0;

  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const plaintextKey = randomBytes(32);
    const ciphertextBlob = Buffer.from(`wrapped-persistence-${this.sequence}`, 'utf8');
    this.sequence += 1;
    const context = contextKey(request.encryptionContext);
    this.requestedContexts.push(context);
    this.entries.set(ciphertextBlob.toString('base64url'), {
      key: Buffer.from(plaintextKey),
      context,
      kmsKeyId: request.kmsKeyId,
    });
    return { plaintextKey, ciphertextBlob };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]): Promise<Uint8Array> {
    const entry = this.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    const context = contextKey(request.encryptionContext);
    this.requestedContexts.push(context);
    if (!entry || entry.kmsKeyId !== request.kmsKeyId || entry.context !== context) {
      throw new Error('KMS encryption context mismatch');
    }
    return Buffer.from(entry.key);
  }
}

interface FakeWorkerState {
  rightsCurrent: boolean;
  capabilityCurrent: boolean;
  jobStatus: string;
  leaseGeneration: number;
  attemptCount: number;
  credentialStatus: string;
  credentialValidationState: string;
  accountStatus: string;
  accountValidationState: string;
  healthWrites: string[];
  envelope: ProviderCredentialEnvelope;
}

class FakeValidationDatabase implements SaasDatabase {
  readonly state: FakeWorkerState;
  decryptCalls = 0;

  constructor(envelope: ProviderCredentialEnvelope) {
    this.state = {
      rightsCurrent: true,
      capabilityCurrent: true,
      jobStatus: 'queued',
      leaseGeneration: 0,
      attemptCount: 0,
      credentialStatus: 'pending',
      credentialValidationState: 'unverified',
      accountStatus: 'pending',
      accountValidationState: 'unverified',
      healthWrites: [],
      envelope,
    };
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const rows = this.execute(sql, values);
    return { rows: rows as Row[], rowCount: rows.length };
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work({ query: <Row>(sql: string, values?: readonly unknown[]) => this.query<Row>(sql, values) });
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private execute(sql: string, values: readonly unknown[]): unknown[] {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE') return [];
    if (statement.startsWith('SELECT pg_advisory_xact_lock')) return [];
    if (
      statement.startsWith('SELECT id, tenant_id, account_id, credential_id, credential_version, provider_id') &&
      statement.includes('WHERE id = $1')
    ) {
      return [this.jobRow()];
    }
    if (
      statement.startsWith(
        'SELECT id, tenant_id, account_id, credential_id, credential_version FROM saas_tenant_provider_credential_validation_jobs',
      )
    ) {
      return [
        {
          id: 'job-a',
          tenant_id: 'tenant-a',
          account_id: 'account-a',
          credential_id: 'credential-a',
          credential_version: 1,
        },
      ];
    }
    if (statement.startsWith('SELECT job.id FROM saas_tenant_provider_credential_validation_jobs AS job')) {
      return [{ id: 'job-a' }];
    }
    if (statement.includes('FROM saas_tenant_provider_accounts') && statement.startsWith('SELECT')) {
      return [
        {
          id: 'account-a',
          tenant_id: 'tenant-a',
          provider_id: 'kimi',
          product_id: 'kimi-platform',
          credential_type: 'api-key',
          region: 'test-region',
          purpose: 'inference',
          rights_id: 'rights-a',
          rights_version: 1,
          status: 'pending',
          validation_state: 'unverified',
          authz_version: 1,
        },
      ];
    }
    if (statement.includes('FROM saas_tenant_provider_credentials') && statement.startsWith('SELECT')) {
      return [
        {
          id: 'credential-a',
          tenant_id: 'tenant-a',
          account_id: 'account-a',
          provider_id: 'kimi',
          product_id: 'kimi-platform',
          credential_type: 'api-key',
          status: 'pending',
          validation_state: 'unverified',
          current_version: 1,
          expires_at: null,
          authz_version: 1,
        },
      ];
    }
    if (statement.includes('JOIN saas_provider_rights AS rights')) {
      assert.match(statement, /rights\.status = 'active'/);
      assert.match(statement, /rights\.model_scope @> ARRAY\[\$8\]::text\[\]/);
      assert.match(statement, /rights\.endpoint_scope @> ARRAY\[\$9\]::text\[\]/);
      assert.match(statement, /newer\.version > rights\.version/);
      return this.state.rightsCurrent ? [{ rights_id: 'rights-a' }] : [];
    }
    if (statement.includes('JOIN saas_tenant_provider_account_capabilities AS binding')) {
      assert.match(statement, /capability\.protocol = \$8/);
      assert.match(statement, /capability\.support_level = 'supported'/);
      assert.match(statement, /capability\.validation_state = 'verified'/);
      assert.match(statement, /newer\.version > capability\.version/);
      return this.state.capabilityCurrent ? [{ version: 1 }] : [];
    }
    if (statement.includes('FROM saas_tenant_provider_credential_versions') && statement.startsWith('SELECT')) {
      return [
        {
          tenant_id: 'tenant-a',
          account_id: 'account-a',
          credential_id: 'credential-a',
          version: 1,
          status: 'active',
          schema_version: this.state.envelope.schemaVersion,
          context_version: this.state.envelope.contextVersion,
          algorithm: this.state.envelope.algorithm,
          kms_purpose: 'inference',
          kms_key_id: this.state.envelope.kmsKeyId,
          wrapping_revision: 1,
          wrapped_dek: this.state.envelope.wrappedDek,
          nonce: this.state.envelope.nonce,
          ciphertext: this.state.envelope.ciphertext,
          auth_tag: this.state.envelope.authTag,
          expires_at: null,
        },
      ];
    }
    if (statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs AS job')) return [];
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'failed'")
    ) {
      return [];
    }
    if (statement.startsWith('WITH candidate AS')) {
      this.state.jobStatus = 'leased';
      this.state.attemptCount += 1;
      this.state.leaseGeneration += 1;
      return [this.jobRow()];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'leased'")
    ) {
      this.state.jobStatus = 'leased';
      this.state.attemptCount += 1;
      this.state.leaseGeneration += 1;
      return [this.jobRow()];
    }
    if (statement.startsWith('SELECT id FROM saas_tenant_provider_credential_validation_jobs')) {
      return this.state.jobStatus === 'leased' && this.state.leaseGeneration === Number(values[5])
        ? [{ id: 'job-a' }]
        : [];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes("SET status = 'cancelled'")
    ) {
      if (this.state.jobStatus === 'leased' && this.state.leaseGeneration === Number(values[1])) {
        this.state.jobStatus = 'cancelled';
        this.state.leaseGeneration += 1;
      }
      return this.state.jobStatus === 'cancelled' ? [{ id: 'job-a' }] : [];
    }
    if (
      statement.startsWith('UPDATE saas_tenant_provider_credential_validation_jobs') &&
      statement.includes('SET status = $1')
    ) {
      if (this.state.jobStatus !== 'leased' || this.state.leaseGeneration !== Number(values[3])) return [];
      this.state.jobStatus = String(values[0]);
      this.state.leaseGeneration += 1;
      return [{ id: 'job-a' }];
    }
    if (statement.startsWith('UPDATE saas_tenant_provider_credentials')) {
      this.state.credentialStatus = String(values[0]);
      this.state.credentialValidationState = String(values[1]);
      this.state.healthWrites.push('credential');
      return [{ id: 'credential-a' }];
    }
    if (statement.startsWith('UPDATE saas_tenant_provider_accounts')) {
      this.state.accountStatus = String(values[0]);
      this.state.accountValidationState = String(values[1]);
      this.state.healthWrites.push('account');
      return [{ id: 'account-a' }];
    }
    throw new Error(`Unexpected worker SQL: ${statement}`);
  }

  private jobRow() {
    const now = new Date('2026-09-29T00:00:00.000Z');
    return {
      id: 'job-a',
      tenant_id: 'tenant-a',
      account_id: 'account-a',
      credential_id: 'credential-a',
      credential_version: 1,
      provider_id: 'kimi',
      product_id: 'kimi-platform',
      credential_type: 'api-key',
      allowed_models: ['model-a'],
      target_model: 'model-a',
      target_endpoint: 'chat-completions',
      capability_version: 1,
      idempotency_key: 'a'.repeat(64),
      status: 'leased',
      attempt_count: this.state.attemptCount,
      available_at: now,
      lease_until: new Date(now.getTime() + 30_000),
      lease_generation: this.state.leaseGeneration,
      last_error_code: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
  }
}

async function setupWorker(
  fetcher: ProviderCredentialValidationFetch,
  afterDecrypt?: (database: FakeValidationDatabase) => void | Promise<void>,
): Promise<{
  readonly database: FakeValidationDatabase;
  readonly worker: CredentialValidationWorker;
}> {
  const sealingKms: ProviderCredentialKms = {
    async generateDataKey() {
      return { plaintextKey: Buffer.from(DATA_KEY), ciphertextBlob: Buffer.from('wrapped-test-key') };
    },
    async decryptDataKey() {
      return Buffer.from(DATA_KEY);
    },
  };
  const envelope = await sealProviderCredential(Buffer.from('provider-test-token'), context, sealingKms, 'kms/test');
  const database = new FakeValidationDatabase(envelope);
  const kms: ProviderCredentialKms = {
    async generateDataKey() {
      throw new Error('worker must not seal credentials');
    },
    async decryptDataKey() {
      database.decryptCalls += 1;
      await afterDecrypt?.(database);
      return Buffer.from(DATA_KEY);
    },
  };
  const worker = new CredentialValidationWorker(database, kms, {
    deployment: 'worker-test',
    environment: 'test',
    fetch: fetcher,
  });
  return { database, worker };
}

test('opens a persistence-sealed tenant BYOK envelope in both validation worker and gateway', async () => {
  const repository = new FakeProviderSupplyRepository();
  const kms = new ContextBoundTestKms();
  const persistence = new ProviderSupplyPersistenceService(repository, {
    sealingKms: kms,
    kmsKeyId: 'kms/test',
    deployment: 'worker-test',
    environment: 'test',
    now: () => new Date('2026-09-29T00:00:00.000Z'),
  });
  const persistedAccount = await persistence.createProviderAccount({
    ownerKind: 'tenant',
    tenantId: 'tenant-a',
    id: 'account-a',
    displayName: 'Validation fixture',
    providerId: 'kimi',
    productId: 'kimi-platform',
    credentialType: 'api-key',
    region: 'test-region',
    purpose: 'inference',
    rightsId: 'rights-a',
    rightsVersion: 1,
    capability: { model: 'model-a', endpoint: 'chat-completions', version: 1 },
  });
  const persistedCredential = await persistence.createProviderCredential({
    account: { ownerKind: 'tenant', tenantId: 'tenant-a', accountId: persistedAccount.id },
    id: 'credential-a',
    secret: Buffer.from('provider-test-token'),
  });
  if (persistedAccount.ownerKind !== 'tenant' || persistedCredential.credential.ownerKind !== 'tenant') {
    throw new Error('Expected persistence fixture to remain tenant BYOK');
  }
  const storedVersion = repository.versions[0];
  assert.ok(storedVersion);
  assert.equal(storedVersion.envelope.schemaVersion, persistedCredential.version.envelopeSchemaVersion);
  assert.equal(kms.requestedContexts.length, 1);

  const database = new FakeValidationDatabase(storedVersion.envelope);
  const runtimeKms = {
    decryptDataKey: (request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]) => kms.decryptDataKey(request),
    checkReady: async () => undefined,
    close: async () => undefined,
  };
  const workerKms: ProviderCredentialUnsealingKms = runtimeKms;
  let workerFetches = 0;
  const worker = new CredentialValidationWorker(database, workerKms, {
    deployment: 'worker-test',
    environment: 'test',
    fetch: async (_url, init) => {
      workerFetches += 1;
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer provider-test-token');
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(await worker.runOnce(), 'processed');
  assert.equal(workerFetches, 1);

  const gatewayAccount: GatewayProviderCredentialAccount = {
    ownerKind: 'tenant',
    tenantId: persistedAccount.tenantId,
    supplyMode: 'byok',
    id: persistedAccount.id,
    providerId: persistedAccount.providerId,
    productId: persistedAccount.productId,
    credentialType: persistedAccount.credentialType,
    purpose: persistedAccount.purpose,
  };
  const gatewayCredential: GatewayProviderCredentialCredential = {
    ownerKind: 'tenant',
    tenantId: persistedCredential.credential.tenantId,
    supplyMode: 'byok',
    id: persistedCredential.credential.id,
    accountId: persistedCredential.credential.accountId,
    providerId: persistedCredential.credential.providerId,
    productId: persistedCredential.credential.productId,
  };
  const gateway = new GatewayProviderCredentialUnsealer(runtimeKms, {
    deployment: 'worker-test',
    environment: 'test',
  });
  let gatewaySecret = '';
  assert.equal(
    await gateway.withCredential(
      { account: gatewayAccount, credential: gatewayCredential, version: storedVersion },
      (plaintext) => {
        gatewaySecret = plaintext.toString('utf8');
        return 'gateway-complete';
      },
    ),
    'gateway-complete',
  );
  assert.equal(gatewaySecret, 'provider-test-token');

  const distinctContexts = new Set(kms.requestedContexts);
  assert.equal(kms.requestedContexts.length, 3);
  assert.equal(distinctContexts.size, 1);
});

test('current rights and capability revocation stops validation before KMS decryption or network fetch', async () => {
  for (const revokedBinding of ['rights', 'capability'] as const) {
    let fetchCalls = 0;
    const { database, worker } = await setupWorker(async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    });
    if (revokedBinding === 'rights') database.state.rightsCurrent = false;
    else database.state.capabilityCurrent = false;

    assert.equal(await worker.runOnce(), 'stale');
    assert.equal(database.decryptCalls, 0, `${revokedBinding} revocation must prevent KMS decryption`);
    assert.equal(fetchCalls, 0, `${revokedBinding} revocation must prevent network fetch`);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.jobStatus, 'cancelled');
  }
});

test('rights revoked after unsealing but before the provider request blocks the network call', async () => {
  let fetchCalls = 0;
  const { database, worker } = await setupWorker(
    async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    },
    (currentDatabase) => {
      currentDatabase.state.rightsCurrent = false;
    },
  );

  assert.equal(await worker.runOnce(), 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
});

test('rights revoked during provider fetch prevents verified job and health updates', async () => {
  let startFetch!: () => void;
  let finishFetch!: (response: Response) => void;
  const fetchStarted = new Promise<void>((resolve) => {
    startFetch = resolve;
  });
  const pendingResponse = new Promise<Response>((resolve) => {
    finishFetch = resolve;
  });
  let fetchCalls = 0;
  const { database, worker } = await setupWorker(async () => {
    fetchCalls += 1;
    startFetch();
    return pendingResponse;
  });

  const run = worker.runOnce();
  await fetchStarted;
  database.state.rightsCurrent = false;
  finishFetch(new Response(null, { status: 200 }));

  assert.equal(await run, 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
  assert.equal(database.state.credentialValidationState, 'unverified');
  assert.equal(database.state.accountValidationState, 'unverified');
});
