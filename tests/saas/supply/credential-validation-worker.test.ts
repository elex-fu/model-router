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
import { CredentialValidationWorker, type CredentialValidationWorkerOptions } from '../../../src/saas/supply/credential-validation-worker.js';
import { compileApprovedCredentialValidationTargets } from '../../../src/saas/supply/credential-validation-targets.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import { FakeProviderSupplyRepository } from './fake-repository.js';
import { approvedTarget, probeEnvelope, validationHttpsFixture, waitForValidationFixtureSignal } from './credential-validation-test-fixture.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';

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

interface WorkerTarget {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: string;
}

const chatTarget: WorkerTarget = {
  providerId: 'kimi', productId: 'kimi-platform', model: 'model-a',
  endpoint: 'chat-completions', protocol: 'openai-compatible',
};
const messagesTargets = [
  { providerId: 'kimi', productId: 'kimi-code', model: 'kimi-for-coding',
    endpoint: 'messages', protocol: 'anthropic-compatible', url: 'https://api.kimi.com/coding/v1/messages' },
  { providerId: 'kimi', productId: 'kimi-code-global', model: 'kimi-for-coding',
    endpoint: 'messages', protocol: 'anthropic-compatible', url: 'https://api.kimi.ai/coding/v1/messages' },
  { providerId: 'deepseek', productId: 'deepseek-anthropic', model: 'deepseek-flash',
    endpoint: 'messages', protocol: 'anthropic-compatible', url: 'https://api.deepseek.com/anthropic/v1/messages' },
] as const;

function messagesResponse(model: string): Response {
  return new Response(JSON.stringify({ id: 'msg-worker-test', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
}

interface FakeWorkerState {
  rightsCurrent: boolean;
  capabilityCurrent: boolean;
  capabilityProtocol: string;
  capabilityEvidenceSha256: string | null;
  leaseCurrent: boolean;
  requestedCapabilityProtocols: string[];
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

  constructor(envelope: ProviderCredentialEnvelope, private readonly target: WorkerTarget = chatTarget) {
    this.state = {
      rightsCurrent: true,
      capabilityCurrent: true,
      capabilityProtocol: target.protocol,
      capabilityEvidenceSha256: null,
      leaseCurrent: true,
      requestedCapabilityProtocols: [],
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
          provider_id: this.target.providerId,
          product_id: this.target.productId,
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
          provider_id: this.target.providerId,
          product_id: this.target.productId,
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
      assert.equal(values[0], this.target.providerId);
      assert.equal(values[1], this.target.productId);
      assert.equal(values[7], this.target.model);
      assert.equal(values[8], this.target.endpoint);
      return this.state.rightsCurrent ? [{ rights_id: 'rights-a' }] : [];
    }
    if (statement.includes('JOIN saas_tenant_provider_account_capabilities AS binding')) {
      assert.match(statement, /capability\.protocol = \$8/);
      assert.match(statement, /capability\.support_level = 'supported'/);
      assert.match(statement, /capability\.validation_state = 'verified'/);
      assert.match(statement, /newer\.version > capability\.version/);
      assert.equal(values[4], this.target.model);
      assert.equal(values[5], this.target.endpoint);
      assert.equal(values[6], 1);
      assert.ok(typeof values[7] === 'string');
      this.state.requestedCapabilityProtocols.push(values[7]);
      const digestMatches = values.length === 8 || (values[8] === this.state.capabilityEvidenceSha256);
      if (values.length > 8) {
        assert.match(statement, /capability\.evidence_sha256 = \$9/);
        assert.match(statement, /\$10::timestamptz > clock_timestamp\(\)/);
      }
      return this.state.capabilityCurrent && this.state.capabilityProtocol === values[7] && digestMatches ? [{ version: 1 }] : [];
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
      return this.state.leaseCurrent && this.state.jobStatus === 'leased' && this.state.leaseGeneration === Number(values[5])
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
      provider_id: this.target.providerId,
      product_id: this.target.productId,
      credential_type: 'api-key',
      allowed_models: [this.target.model],
      target_model: this.target.model,
      target_endpoint: this.target.endpoint,
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
  target: WorkerTarget = chatTarget,
  extraOptions: Partial<CredentialValidationWorkerOptions> = {},
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
  const boundContext = createProviderCredentialContext({
    ownerKind: 'tenant', tenantId: 'tenant-a', supplyMode: 'byok',
    deployment: 'worker-test', environment: 'test', purpose: 'inference',
    providerId: target.providerId, productId: target.productId, credentialType: 'api-key',
    accountId: 'account-a', credentialId: 'credential-a', credentialVersion: 1,
  });
  const envelope = await sealProviderCredential(Buffer.from('provider-test-token'), boundContext, sealingKms, 'kms/test');
  const database = new FakeValidationDatabase(envelope, target);
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
    ...extraOptions,
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

test('rights revoked during provider fetch prevents verified job and health updates', async (t) => {
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
  t.after(async () => { finishFetch(new Response(null, { status: 503 })); await worker.close(); });

  const run = worker.runOnce();
  await waitForValidationFixtureSignal(fetchStarted, run);
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

test('Messages credential worker preserves KMS identity and selects only current Anthropic-compatible capabilities', async (t) => {
  for (const target of messagesTargets) {
    await t.test(target.productId, async () => {
      let fetches = 0;
      const { database, worker } = await setupWorker(async (url, init) => {
        fetches += 1;
        assert.equal(url.href, target.url);
        assert.equal(init.method, 'POST');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('x-api-key'), 'provider-test-token');
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('user-agent'), 'model-router');
        assert.ok(typeof init.body === 'string');
        assert.equal(JSON.parse(init.body).model, target.model);
        return messagesResponse(target.model);
      }, undefined, target);
      assert.equal(await worker.runOnce(), 'processed');
      assert.equal(fetches, 1);
      assert.equal(database.decryptCalls, 1);
      assert.equal(database.state.jobStatus, 'verified');
      assert.equal(database.state.credentialValidationState, 'verified');
      assert.equal(database.state.accountValidationState, 'verified');
      assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
      assert.equal(database.state.requestedCapabilityProtocols.length, 3, 'authority is checked before KMS, fetch and completion');
      assert.deepEqual(database.state.requestedCapabilityProtocols, Array(3).fill('anthropic-compatible'));
      assert.equal(database.state.rightsCurrent, true);
      assert.equal(database.state.capabilityCurrent, true);
      // FakeValidationDatabase rejects unexpected SQL, including any writes to
      // the catalog capability or rights tables. Only credential health changes.
    });
  }
});

test('Messages capability protocol mismatch or stale rights fails closed before KMS and transport', async (t) => {
  for (const target of messagesTargets) {
    for (const cause of ['openai capability', 'stale rights', 'stale capability'] as const) {
      await t.test(`${target.productId}: ${cause}`, async () => {
        let fetches = 0;
        const { database, worker } = await setupWorker(async () => {
          fetches += 1;
          return messagesResponse(target.model);
        }, undefined, target);
        if (cause === 'openai capability') database.state.capabilityProtocol = 'openai-compatible';
        else if (cause === 'stale rights') database.state.rightsCurrent = false;
        else database.state.capabilityCurrent = false;
        assert.equal(await worker.runOnce(), 'stale');
        assert.equal(database.decryptCalls, 0);
        assert.equal(fetches, 0);
        assert.equal(database.state.jobStatus, 'cancelled');
        assert.deepEqual(database.state.healthWrites, []);
        assert.equal(database.state.credentialValidationState, 'unverified');
        assert.equal(database.state.accountValidationState, 'unverified');
      });
    }
  }
});

test('Messages rights revoked after KMS still prevent the provider request', async () => {
  const target = messagesTargets[0];
  let fetches = 0;
  const { database, worker } = await setupWorker(async () => {
    fetches += 1;
    return messagesResponse(target.model);
  }, (current) => { current.state.rightsCurrent = false; }, target);
  assert.equal(await worker.runOnce(), 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(fetches, 0);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
});

test('Messages rights revoked during a successful probe prevent verified job or credential health writes', async (t) => {
  const target = messagesTargets[2];
  let announced!: () => void;
  const requested = new Promise<void>((resolve) => { announced = resolve; });
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { finish = resolve; });
  const { database, worker } = await setupWorker(async () => { announced(); return response; }, undefined, target);
  t.after(async () => { finish(new Response(null, { status: 503 })); await worker.close(); });
  const run = worker.runOnce();
  await waitForValidationFixtureSignal(requested, run);
  database.state.rightsCurrent = false;
  finish(messagesResponse(target.model));
  assert.equal(await run, 'stale');
  assert.equal(database.decryptCalls, 1);
  assert.equal(database.state.jobStatus, 'cancelled');
  assert.deepEqual(database.state.healthWrites, []);
  assert.equal(database.state.credentialValidationState, 'unverified');
  assert.equal(database.state.accountValidationState, 'unverified');
});

test('custom worker uses actual pinned HTTPS and current catalog digest, never its legacy unrestricted fetch seam', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume(); requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(probeEnvelope(request.url?.endsWith('/messages') ? 'messages' : 'chat')));
  });
  for (const kind of ['chat', 'messages'] as const) {
    const target = approvedTarget({ baseUrl: local.baseUrl, ...(kind === 'messages' ? {
      productId: 'custom-anthropic', endpoint: 'messages', protocol: 'anthropic-compatible',
      authProfile: 'anthropic-api-key-2023-06-01',
    } as const : {}) });
    let legacyFetches = 0;
    const { database, worker } = await setupWorker(async () => {
      legacyFetches += 1; throw new Error('custom must never use unrestricted fetch');
    }, undefined, target, { approvedTargets: compileApprovedCredentialValidationTargets([target]), transportTestOptions: local.testOptions });
    t.after(() => worker.close());
    database.state.capabilityEvidenceSha256 = target.evidenceSha256;
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(legacyFetches, 0);
    assert.equal(database.decryptCalls, 1);
    assert.equal(database.state.jobStatus, 'verified');
    assert.deepEqual(database.state.requestedCapabilityProtocols, Array(4).fill(target.protocol));
    assert.deepEqual(database.state.healthWrites, ['credential', 'account']);
  }
  assert.equal(requests, 2);
});

test('custom missing/stale approval, wrong evidence/protocol/rights/lease and private DNS fail before KMS and dispatch', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => { request.resume(); requests += 1; response.end(); });
  for (const cause of ['missing approval', 'expired approval', 'evidence', 'protocol', 'rights', 'capability', 'lease', 'private DNS'] as const) {
    const target = approvedTarget({ baseUrl: cause === 'private DNS' ? 'https://validation.example/v1/' : local.baseUrl,
      ...(cause === 'expired approval' ? { expiresAt: '2000-01-01T00:00:00.000Z' } : {}) });
    let legacyFetches = 0;
    const { database, worker } = await setupWorker(async () => { legacyFetches += 1; throw new Error('unexpected fetch'); },
      undefined, target, {
        approvedTargets: compileApprovedCredentialValidationTargets(cause === 'missing approval' ? [] : [target]),
        transportTestOptions: { ...local.testOptions, ...(cause === 'private DNS' ? {
          resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }],
        } : {}) },
      });
    t.after(() => worker.close());
    database.state.capabilityEvidenceSha256 = cause === 'evidence' ? 'f'.repeat(64) : target.evidenceSha256;
    if (cause === 'protocol') database.state.capabilityProtocol = 'anthropic-compatible';
    if (cause === 'rights') database.state.rightsCurrent = false;
    if (cause === 'capability') database.state.capabilityCurrent = false;
    if (cause === 'lease') database.state.leaseCurrent = false;
    const result = await worker.runOnce();
    assert.ok(result === 'processed' || result === 'stale');
    assert.equal(database.decryptCalls, 0, cause);
    assert.equal(legacyFetches, 0, cause);
    assert.deepEqual(database.state.healthWrites, [], cause);
    assert.notEqual(database.state.jobStatus, 'verified', cause);
  }
  assert.equal(requests, 0);
});

test('custom rights/evidence/lease changes after KMS prevent wire dispatch without health writes', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => { request.resume(); requests += 1; response.end(); });
  const target = approvedTarget({ baseUrl: local.baseUrl });
  for (const cause of ['rights', 'evidence', 'lease'] as const) {
    const { database, worker } = await setupWorker(async () => { throw new Error('unexpected fetch'); }, (current) => {
      if (cause === 'rights') current.state.rightsCurrent = false;
      if (cause === 'evidence') current.state.capabilityEvidenceSha256 = 'f'.repeat(64);
      if (cause === 'lease') current.state.leaseGeneration += 1;
    }, target, { approvedTargets: compileApprovedCredentialValidationTargets([target]), transportTestOptions: local.testOptions });
    t.after(() => worker.close());
    database.state.capabilityEvidenceSha256 = target.evidenceSha256;
    assert.equal(await worker.runOnce(), 'stale', cause);
    assert.equal(database.decryptCalls, 1);
    assert.deepEqual(database.state.healthWrites, []);
  }
  assert.equal(requests, 0);
});

test('custom EOF is necessary but post-dispatch revoked rights/evidence/lease cannot publish verified health', async (t) => {
  let activeResponse: ServerResponse | undefined;
  let announce!: () => void;
  const local = await validationHttpsFixture(t, (request, response) => {
    request.resume(); activeResponse = response;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(JSON.stringify(probeEnvelope('chat'))); announce();
  });
  const target = approvedTarget({ baseUrl: local.baseUrl });
  for (const cause of ['rights', 'evidence', 'lease'] as const) {
    const { database, worker } = await setupWorker(async () => { throw new Error('unexpected fetch'); }, undefined,
      target, { approvedTargets: compileApprovedCredentialValidationTargets([target]), transportTestOptions: local.testOptions });
    t.after(async () => { activeResponse?.destroy(); await worker.close(); });
    database.state.capabilityEvidenceSha256 = target.evidenceSha256;
    const waiting = new Promise<void>((resolve) => { announce = resolve; });
    const pending = worker.runOnce();
    await waitForValidationFixtureSignal(waiting, pending); await delay(10);
    assert.deepEqual(database.state.healthWrites, []);
    if (cause === 'rights') database.state.rightsCurrent = false;
    if (cause === 'evidence') database.state.capabilityEvidenceSha256 = 'f'.repeat(64);
    if (cause === 'lease') database.state.leaseGeneration += 1;
    activeResponse?.end();
    assert.equal(await pending, 'stale', cause);
    assert.deepEqual(database.state.healthWrites, []);
    assert.equal(database.state.credentialValidationState, 'unverified');
  }
});

test('worker close cannot cancel a pending KMS call; it waits, then prevents dispatch and verified completion', async (t) => {
  let requests = 0;
  const local = await validationHttpsFixture(t, (request, response) => { request.resume(); requests += 1; response.end(); });
  const target = approvedTarget({ baseUrl: local.baseUrl });
  let kmsStarted!: () => void;
  let finishKms!: () => void;
  const started = new Promise<void>((resolve) => { kmsStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { finishKms = resolve; });
  const { database, worker } = await setupWorker(async () => { throw new Error('unexpected fetch'); }, async () => {
    kmsStarted(); await blocked;
  }, target, { approvedTargets: compileApprovedCredentialValidationTargets([target]), transportTestOptions: local.testOptions });
  t.after(async () => { finishKms(); await worker.close(); });
  database.state.capabilityEvidenceSha256 = target.evidenceSha256;
  const run = worker.runOnce();
  await waitForValidationFixtureSignal(started, run);
  let closed = false;
  const close = worker.close().then(() => { closed = true; });
  await delay(10);
  assert.equal(closed, false, 'external KMS is not falsely claimed cancellable');
  finishKms();
  assert.equal(await run, 'stale');
  await close;
  assert.equal(requests, 0);
  assert.deepEqual(database.state.healthWrites, []);
  assert.equal(await worker.runOnce(), 'stale');
});
