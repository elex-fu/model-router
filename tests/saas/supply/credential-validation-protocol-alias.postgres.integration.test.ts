import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../../../src/saas/db/credential-validation-worker-privileges.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { CredentialValidationWorker } from '../../../src/saas/supply/credential-validation-worker.js';

const CONFIG = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL', 'model_router_saas_validation_worker'],
] as const;
const configured = CONFIG.map(([name]) => process.env[name]?.trim());
const required = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED === '1';

function roleUrls(): [string, string] {
  let target: string | undefined;
  const checked = CONFIG.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required`);
    const url = new URL(value);
    assert.equal(decodeURIComponent(url.username), role, 'use the actual restricted workload login');
    assert.ok(
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.port !== '' &&
        !['5432', '6432', '53782'].includes(url.port) &&
        /^model_router_test_[A-Za-z0-9_]+$/.test(url.pathname.slice(1)),
      'use a fresh disposable nondefault loopback PostgreSQL target',
    );
    const identity = `${url.hostname}:${url.port}${url.pathname}`;
    target ??= identity;
    assert.equal(identity, target, 'both roles must use the same disposable database');
    return value;
  });
  assert.ok(checked[0] && checked[1]);
  return [checked[0], checked[1]];
}

class FixtureKms implements ProviderCredentialKms {
  decryptCalls = 0;
  private readonly entries = new Map<string, { key: Buffer; context: string; keyId: string }>();

  private context(value: Readonly<Record<string, string>>): string {
    return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  }

  async generateDataKey(request: Parameters<ProviderCredentialKms['generateDataKey']>[0]) {
    const key = randomBytes(32);
    const wrapped = Buffer.from(randomUUID());
    this.entries.set(wrapped.toString('base64url'), {
      key: Buffer.from(key),
      context: this.context(request.encryptionContext),
      keyId: request.kmsKeyId,
    });
    return { plaintextKey: key, ciphertextBlob: wrapped };
  }

  async decryptDataKey(request: Parameters<ProviderCredentialKms['decryptDataKey']>[0]) {
    this.decryptCalls += 1;
    const entry = this.entries.get(Buffer.from(request.ciphertextBlob).toString('base64url'));
    assert.ok(entry, 'only this fixture can unseal its synthetic credential');
    assert.equal(this.context(request.encryptionContext), entry.context, 'preserve the full platform KMS context');
    assert.equal(request.kmsKeyId, entry.keyId);
    return Buffer.from(entry.key);
  }
}

interface Fixture {
  accountId: string;
  credentialId: string;
  rightsId: string;
  jobId: string;
  productId: string;
  endpoint: string;
  model: string;
  protocol: string;
}

async function seed(
  database: SaasDatabase,
  kms: FixtureKms,
  endpoint: 'messages' | 'chat-completions',
  protocol: string,
): Promise<Fixture> {
  const fixture = {
    accountId: `alias-account-${randomUUID()}`,
    credentialId: `alias-credential-${randomUUID()}`,
    rightsId: `alias-rights-${randomUUID()}`,
    productId: endpoint === 'messages' ? 'kimi-code' : 'kimi-platform',
    endpoint,
    model: `alias-model-${randomUUID()}`,
    protocol,
  };
  const envelope = await sealProviderCredential(
    Buffer.from('synthetic-validation-credential'),
    createProviderCredentialContext({
      ownerKind: 'platform',
      supplyMode: 'platform',
      deployment: 'protocol-alias-e2e',
      environment: 'test',
      purpose: 'inference',
      providerId: 'kimi',
      productId: fixture.productId,
      credentialType: 'api-key',
      accountId: fixture.accountId,
      credentialId: fixture.credentialId,
      credentialVersion: 1,
    }),
    kms,
    'synthetic-alias-kms',
  );
  const jobId = await database.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO saas_provider_products(provider_id,product_id,display_name) VALUES('kimi',$1,'Synthetic alias fixture') ON CONFLICT DO NOTHING",
      [fixture.productId],
    );
    await tx.query(
      `INSERT INTO saas_provider_capabilities(provider_id,product_id,model,endpoint,protocol,version,support_level,validation_state,evidence_version,discovery_source,evidence_ref,evidence_sha256)
       VALUES('kimi',$1,$2,$3,$4,1,'supported','verified','alias-fixture-v1','manual','synthetic-alias-evidence',$5)`,
      [fixture.productId, fixture.model, fixture.endpoint, protocol, 'c'.repeat(64)],
    );
    await tx.query(
      `INSERT INTO saas_provider_rights(rights_id,version,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,effective_at,approval_ref,status,evidence_ref,evidence_sha256)
       VALUES($1,1,'kimi',$2,'api-key','platform','test-region','inference',ARRAY[$3]::text[],ARRAY[$4]::text[],clock_timestamp()-interval '1 minute','synthetic-approval','active','synthetic-rights-evidence',$5)`,
      [fixture.rightsId, fixture.productId, fixture.model, fixture.endpoint, 'd'.repeat(64)],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_accounts(id,display_name,provider_id,product_id,credential_type,region,purpose,rights_id,rights_version)
       VALUES($1,'Synthetic alias account','kimi',$2,'api-key','test-region','inference',$3,1)`,
      [fixture.accountId, fixture.productId, fixture.rightsId],
    );
    await tx.query(
      "INSERT INTO saas_platform_provider_account_capabilities(account_id,provider_id,product_id,model,endpoint,capability_version) VALUES($1,'kimi',$2,$3,$4,1)",
      [fixture.accountId, fixture.productId, fixture.model, fixture.endpoint],
    );
    await tx.query(
      "INSERT INTO saas_platform_provider_credentials(id,account_id,provider_id,product_id,credential_type) VALUES($1,$2,'kimi',$3,'api-key')",
      [fixture.credentialId, fixture.accountId, fixture.productId],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_credential_versions(account_id,credential_id,version,schema_version,context_version,algorithm,kms_purpose,kms_key_id,wrapped_dek,nonce,ciphertext,auth_tag)
       VALUES($1,$2,1,$3,$4,$5,'inference',$6,$7,$8,$9,$10)`,
      [
        fixture.accountId,
        fixture.credentialId,
        envelope.schemaVersion,
        envelope.contextVersion,
        envelope.algorithm,
        envelope.kmsKeyId,
        envelope.wrappedDek,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
      ],
    );
    await tx.query('UPDATE saas_platform_provider_credentials SET current_version=1 WHERE id=$1', [
      fixture.credentialId,
    ]);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO saas_platform_provider_credential_validation_jobs(account_id,credential_id,credential_version,provider_id,product_id,credential_type,allowed_models,target_model,target_endpoint,capability_version,idempotency_key)
       VALUES($1,$2,1,'kimi',$3,'api-key',ARRAY[$4]::text[],$4,$5,1,$6) RETURNING id`,
      [
        fixture.accountId,
        fixture.credentialId,
        fixture.productId,
        fixture.model,
        fixture.endpoint,
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
    assert.ok(inserted.rows[0]?.id);
    return inserted.rows[0].id;
  });
  return { ...fixture, jobId };
}

async function state(database: SaasDatabase, fixture: Fixture) {
  const result = await database.query<{
    job_state: string;
    last_error_code: string | null;
    attempt_count: number;
    lease_until: Date | null;
    lease_generation: string;
    account_state: string;
    credential_state: string;
    protocol: string;
  }>(
    `SELECT job.status AS job_state,job.last_error_code,job.attempt_count,job.lease_until,job.lease_generation,
       account.validation_state AS account_state,credential.validation_state AS credential_state,capability.protocol
     FROM saas_platform_provider_credential_validation_jobs job
     JOIN saas_platform_provider_accounts account ON account.id=job.account_id
     JOIN saas_platform_provider_credentials credential ON credential.id=job.credential_id
     JOIN saas_provider_capabilities capability ON capability.provider_id=job.provider_id AND capability.product_id=job.product_id
       AND capability.model=job.target_model AND capability.endpoint=job.target_endpoint AND capability.version=job.capability_version
     WHERE job.id=$1::uuid`,
    [fixture.jobId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

function successfulResponse(fixture: Fixture): Response {
  return new Response(
    fixture.endpoint === 'messages'
      ? JSON.stringify({
          id: 'synthetic-message',
          type: 'message',
          role: 'assistant',
          model: fixture.model,
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        })
      : JSON.stringify({ data: [{ id: fixture.model }] }),
    { headers: { 'content-type': 'application/json' } },
  );
}

test('restricted PostgreSQL worker accepts fixed native/legacy protocol aliases without relaxing authority', {
  timeout: 120_000,
  skip: !required && !configured.some(Boolean) ? 'requires the disposable PostgreSQL runner and --worker-role' : false,
}, async (t) => {
  const [migratorUrl, workerUrl] = roleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl });
  const database = createSaasDatabase({ connectionString: workerUrl });
  t.after(async () => {
    await database.close();
    await migrator.close();
  });
  await migrator.verifySchema();
  await verifyCredentialValidationWorkerRuntimePrivileges(database);
  const pending = await migrator.query<{ count: string }>(
    "SELECT count(*)::text FROM saas_platform_provider_credential_validation_jobs WHERE status IN ('queued','leased')",
  );
  assert.equal(pending.rows[0]?.count, '0', 'the gate requires an empty platform queue');

  for (const [endpoint, protocols] of [
    ['messages', ['anthropic', 'anthropic-compatible']],
    ['chat-completions', ['openai', 'openai-compatible']],
  ] as const) {
    for (const protocol of protocols) {
      await t.test(`${endpoint}: ${protocol} reaches verified in one attempt`, async () => {
        const kms = new FixtureKms();
        const fixture = await seed(migrator, kms, endpoint, protocol);
        let fetches = 0;
        const worker = new CredentialValidationWorker(database, kms, {
          deployment: 'protocol-alias-e2e',
          environment: 'test',
          owners: ['platform'],
          fetch: async (url) => {
            fetches += 1;
            assert.equal(url.hostname, endpoint === 'messages' ? 'api.kimi.com' : 'api.moonshot.cn');
            return successfulResponse(fixture);
          },
        });
        try {
          assert.equal(await worker.runOnce(), 'processed');
          assert.equal(fetches, 1);
          assert.equal(kms.decryptCalls, 1);
          const current = await state(database, fixture);
          assert.equal(current.job_state, 'verified');
          assert.equal(current.attempt_count, 1);
          assert.equal(current.lease_until, null);
          assert.equal(current.last_error_code, null);
          assert.equal(current.account_state, 'verified');
          assert.equal(current.credential_state, 'verified');
          assert.equal(current.protocol, protocol, 'catalog retains its canonical or legacy source value');
        } finally {
          await worker.close();
        }
      });
    }
  }

  for (const refusal of ['wrong family', 'superseded capability', 'revoked rights during probe'] as const) {
    await t.test(refusal, async () => {
      const kms = new FixtureKms();
      const fixture = await seed(migrator, kms, 'messages', refusal === 'wrong family' ? 'openai' : 'anthropic');
      if (refusal === 'superseded capability') {
        await migrator.query(
          `INSERT INTO saas_provider_capabilities(provider_id,product_id,model,endpoint,protocol,version,support_level,validation_state,evidence_version,discovery_source,evidence_ref,evidence_sha256)
           VALUES('kimi',$1,$2,'messages','anthropic',2,'supported','verified','alias-fixture-v2','manual','synthetic-newer-evidence',$3)`,
          [fixture.productId, fixture.model, 'e'.repeat(64)],
        );
      }
      let fetches = 0;
      const worker = new CredentialValidationWorker(database, kms, {
        deployment: 'protocol-alias-e2e',
        environment: 'test',
        owners: ['platform'],
        fetch: async () => {
          fetches += 1;
          await migrator.query(
            `INSERT INTO saas_provider_rights(rights_id,version,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,effective_at,approval_ref,status,evidence_ref,evidence_sha256)
             SELECT rights_id,2,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,clock_timestamp()-interval '1 minute','synthetic-revocation','revoked',evidence_ref,evidence_sha256
               FROM saas_provider_rights WHERE rights_id=$1 AND version=1`,
            [fixture.rightsId],
          );
          return successfulResponse(fixture);
        },
      });
      try {
        assert.equal(await worker.runOnce(), 'stale');
        assert.equal(fetches, refusal === 'revoked rights during probe' ? 1 : 0);
        assert.equal(kms.decryptCalls, refusal === 'revoked rights during probe' ? 1 : 0);
        const current = await state(database, fixture);
        assert.equal(current.job_state, 'cancelled');
        assert.equal(current.last_error_code, 'authority_changed');
        assert.equal(current.lease_until, null);
        assert.equal(current.account_state, 'unverified');
        assert.equal(current.credential_state, 'unverified');
      } finally {
        await worker.close();
      }
    });
  }
});
