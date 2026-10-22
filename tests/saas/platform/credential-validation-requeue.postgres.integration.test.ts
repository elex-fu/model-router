import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { verifyCredentialValidationWorkerRuntimePrivileges } from '../../../src/saas/db/credential-validation-worker-privileges.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/runtime-privileges.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';
import {
  PlatformCredentialValidationRequeueService,
  type PlatformValidationRequeueCommand,
  PlatformValidationRequeueError,
} from '../../../src/saas/platform/credential-validation-requeue-service.js';

const CONFIG = [
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_MIGRATOR_URL', 'model_router_saas_migrator'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_CONTROL_PLANE_URL', 'model_router_saas_control_plane'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL', 'model_router_saas_gateway'],
  ['MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL', 'model_router_saas_validation_worker'],
] as const;
const configured = CONFIG.map(([name]) => process.env[name]?.trim());
const required = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED === '1';

function urls(): [string, string, string, string] {
  let target: string | undefined;
  const checked = CONFIG.map(([name, role], index) => {
    const value = configured[index];
    assert.ok(value, `${name} is required`);
    const parsed = new URL(value);
    assert.equal(decodeURIComponent(parsed.username), role, 'use an actual restricted role login');
    assert.ok(
      ['127.0.0.1', '[::1]'].includes(parsed.hostname) &&
        parsed.port !== '' &&
        !['5432', '6432', '53782'].includes(parsed.port) &&
        /^model_router_test_[A-Za-z0-9_]+$/.test(parsed.pathname.slice(1)),
      'use a disposable nondefault loopback PostgreSQL database',
    );
    const identity = `${parsed.hostname}:${parsed.port}${parsed.pathname}`;
    target ??= identity;
    assert.equal(identity, target, 'both roles must use the same disposable target');
    return value;
  });
  assert.ok(checked[0] && checked[1] && checked[2] && checked[3]);
  return [checked[0], checked[1], checked[2], checked[3]];
}

interface Fixture {
  actor: PlatformAdminActor;
  command: PlatformValidationRequeueCommand;
  rightsId: string;
}

async function seed(database: SaasDatabase): Promise<Fixture> {
  const actor: PlatformAdminActor = { userId: randomUUID(), sessionId: randomUUID(), roles: ['operations'] };
  const accountId = `platform-requeue-account-${randomUUID()}`;
  const credentialId = `platform-requeue-credential-${randomUUID()}`;
  const rightsId = `platform-requeue-rights-${randomUUID()}`;
  const model = `kimi-requeue-${randomUUID()}`;
  const mfaId = randomUUID();
  const envelope = await sealProviderCredential(
    Buffer.from('synthetic-requeue-credential'),
    createProviderCredentialContext({
      ownerKind: 'platform',
      supplyMode: 'platform',
      deployment: 'requeue-e2e',
      environment: 'test',
      purpose: 'inference',
      providerId: 'kimi',
      productId: 'kimi-code',
      credentialType: 'api-key',
      accountId,
      credentialId,
      credentialVersion: 1,
    }),
    {
      generateDataKey: async () => ({
        plaintextKey: Buffer.alloc(32, 7),
        ciphertextBlob: Buffer.from('synthetic-wrapped-dek'),
      }),
    },
    'synthetic-fixture-kms',
  );
  const jobId = await database.transaction(async (tx) => {
    await tx.query('INSERT INTO saas_users(id,email) VALUES($1::uuid,$2)', [
      actor.userId,
      `${randomUUID()}@example.test`,
    ]);
    await tx.query("INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1::uuid,'operations')", [
      actor.userId,
    ]);
    await tx.query(
      "INSERT INTO saas_mfa_credentials(id,user_id,kind,encrypted_secret,verified_at) VALUES($1::uuid,$2::uuid,'totp',decode('7b7d','hex'),clock_timestamp())",
      [mfaId, actor.userId],
    );
    await tx.query(
      `INSERT INTO saas_platform_sessions(id,user_id,credential_id,token_hash,csrf_token_hash,expires_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,clock_timestamp()+interval '1 hour')`,
      [actor.sessionId, actor.userId, mfaId, createHash('sha256').update(randomUUID()).digest('hex'), 'b'.repeat(64)],
    );
    await tx.query(
      "INSERT INTO saas_provider_products(provider_id,product_id,display_name) VALUES('kimi','kimi-code','Synthetic Kimi product') ON CONFLICT DO NOTHING",
    );
    await tx.query(
      `INSERT INTO saas_provider_capabilities(provider_id,product_id,model,endpoint,protocol,version,support_level,validation_state,evidence_version,discovery_source,evidence_ref,evidence_sha256)
      VALUES('kimi','kimi-code',$1,'messages','anthropic-compatible',1,'supported','verified','requeue-fixture-v1','manual','synthetic-requeue-evidence',$2)`,
      [model, 'c'.repeat(64)],
    );
    await tx.query(
      `INSERT INTO saas_provider_rights(rights_id,version,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,effective_at,approval_ref,status,evidence_ref,evidence_sha256)
      VALUES($1,1,'kimi','kimi-code','api-key','platform','test-region','inference',ARRAY[$2]::text[],ARRAY['messages']::text[],clock_timestamp()-interval '1 minute','synthetic-approval','active','synthetic-evidence',$3)`,
      [rightsId, model, 'd'.repeat(64)],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_accounts(id,display_name,provider_id,product_id,credential_type,region,purpose,rights_id,rights_version)
      VALUES($1,'Synthetic retry account','kimi','kimi-code','api-key','test-region','inference',$2,1)`,
      [accountId, rightsId],
    );
    await tx.query(
      "INSERT INTO saas_platform_provider_account_capabilities(account_id,provider_id,product_id,model,endpoint,capability_version) VALUES($1,'kimi','kimi-code',$2,'messages',1)",
      [accountId, model],
    );
    await tx.query(
      "INSERT INTO saas_platform_provider_credentials(id,account_id,provider_id,product_id,credential_type) VALUES($1,$2,'kimi','kimi-code','api-key')",
      [credentialId, accountId],
    );
    await tx.query(
      `INSERT INTO saas_platform_provider_credential_versions(account_id,credential_id,version,schema_version,context_version,algorithm,kms_purpose,kms_key_id,wrapped_dek,nonce,ciphertext,auth_tag)
      VALUES($1,$2,1,$3,$4,$5,'inference',$6,$7,$8,$9,$10)`,
      [
        accountId,
        credentialId,
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
    await tx.query(
      "UPDATE saas_platform_provider_credentials SET current_version=1,validation_state='failed',validation_error_code='provider_response_too_large' WHERE id=$1",
      [credentialId],
    );
    await tx.query(
      "UPDATE saas_platform_provider_accounts SET validation_state='failed',validation_error_code='provider_response_too_large' WHERE id=$1",
      [accountId],
    );
    const result = await tx.query<{ id: string }>(
      `INSERT INTO saas_platform_provider_credential_validation_jobs(account_id,credential_id,credential_version,provider_id,product_id,credential_type,allowed_models,target_model,target_endpoint,capability_version,idempotency_key)
      VALUES($1,$2,1,'kimi','kimi-code','api-key',ARRAY[$3]::text[],$3,'messages',1,$4) RETURNING id`,
      [accountId, credentialId, model, createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const id = result.rows[0]?.id;
    assert.ok(id);
    // Seed the observed historical terminal failure; no provider is contacted.
    await tx.query(
      "UPDATE saas_platform_provider_credential_validation_jobs SET status='failed',attempt_count=1,lease_generation=2,last_error_code='provider_response_too_large',completed_at=clock_timestamp() WHERE id=$1::uuid",
      [id],
    );
    return id;
  });
  const authz = (
    await database.query<{ authz_version: string }>(
      'SELECT authz_version FROM saas_platform_provider_credentials WHERE id=$1',
      [credentialId],
    )
  ).rows[0];
  assert.ok(authz);
  return {
    actor,
    rightsId,
    command: {
      accountId,
      credentialId,
      jobId,
      expectedCredentialVersion: 1,
      expectedCredentialAuthzVersion: Number(authz.authz_version),
      expectedLeaseGeneration: 2,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      reason: '修复 Kimi Code 响应上限后重新验证',
    },
  };
}

async function snapshot(database: SaasDatabase, fixture: Fixture) {
  return (
    await database.query<{ facts: unknown }>(
      `SELECT jsonb_build_object(
    'job',(SELECT to_jsonb(j) FROM saas_platform_provider_credential_validation_jobs j WHERE id=$1::uuid),
    'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM saas_platform_credential_validation_requeue_requests r WHERE job_id=$1::uuid),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM saas_audit_events a WHERE target_id=$1::text)) AS facts`,
      [fixture.command.jobId],
    )
  ).rows[0]?.facts;
}

async function rejected(code: PlatformValidationRequeueError['code'], run: () => Promise<unknown>) {
  await assert.rejects(
    run(),
    (error: unknown) => error instanceof PlatformValidationRequeueError && error.code === code,
  );
}

test('required real PostgreSQL platform validation retry preserves authority, audit, idempotence and atomic rollback', {
  skip: !required && !configured.some(Boolean) ? 'Set the required disposable gateway E2E role URLs' : false,
  timeout: 90_000,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl, workerUrl] = urls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl });
  const control = createSaasDatabase({ connectionString: controlUrl });
  const gateway = createSaasDatabase({ connectionString: gatewayUrl });
  const worker = createSaasDatabase({ connectionString: workerUrl });
  t.after(async () => {
    await control.close();
    await gateway.close();
    await worker.close();
    await migrator.close();
  });
  await migrator.verifySchema();
  await control.verifySchema();
  for (const [database, expected] of [
    [migrator, 'model_router_saas_migrator'],
    [control, 'model_router_saas_control_plane'],
  ] as const) {
    const row = (
      await database.query<{ current: string; session: string }>(
        'SELECT current_user::text AS current,session_user::text AS session',
      )
    ).rows[0];
    assert.deepEqual(row, { current: expected, session: expected });
  }
  const service = new PlatformCredentialValidationRequeueService(control);

  await t.test(
    'current control-plane, gateway and validation-worker runtime privilege policies accept the migrated schema',
    async () => {
      await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
      await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
      await verifyCredentialValidationWorkerRuntimePrivileges(worker);
    },
  );

  await t.test(
    'one audited retry restores the queue only, retains failure history, and replays after completion',
    async () => {
      const fixture = await seed(migrator);
      assert.equal(
        (await service.getStatus(fixture.actor, fixture.command.accountId, fixture.command.credentialId)).state,
        'ready',
      );
      const receipt = await service.requeue(fixture.actor, fixture.command);
      assert.equal(receipt.replayed, false);
      const facts = (
        await migrator.query<{
          status: string;
          attempt_count: number;
          lease_generation: string;
          account_status: string;
          credential_status: string;
          reason: string;
          prior_error: string;
          audit_id: string;
          audit_tenant: string | null;
        }>(
          `SELECT j.status,j.attempt_count,j.lease_generation,a.status AS account_status,c.status AS credential_status,
      r.reason,r.prior_snapshot->>'last_error_code' AS prior_error,r.audit_event_id AS audit_id,e.tenant_id AS audit_tenant
      FROM saas_platform_provider_credential_validation_jobs j JOIN saas_platform_provider_accounts a ON a.id=j.account_id
      JOIN saas_platform_provider_credentials c ON c.id=j.credential_id
      JOIN saas_platform_credential_validation_requeue_requests r ON r.job_id=j.id JOIN saas_audit_events e ON e.id=r.audit_event_id WHERE j.id=$1::uuid`,
          [fixture.command.jobId],
        )
      ).rows[0];
      assert.deepEqual(facts, {
        status: 'queued',
        attempt_count: 0,
        lease_generation: '3',
        account_status: 'pending',
        credential_status: 'pending',
        reason: fixture.command.reason,
        prior_error: 'provider_response_too_large',
        audit_id: receipt.auditEventId,
        audit_tenant: null,
      });
      await migrator.query(
        "UPDATE saas_platform_provider_credential_validation_jobs SET status='verified',attempt_count=1,lease_generation=4,completed_at=clock_timestamp() WHERE id=$1::uuid",
        [fixture.command.jobId],
      );
      const before = await snapshot(migrator, fixture);
      const replay = await service.requeue(fixture.actor, { ...fixture.command, requestId: randomUUID() });
      assert.deepEqual(replay, { ...receipt, replayed: true });
      assert.deepEqual(await snapshot(migrator, fixture), before, 'receipt replay must not requeue a completed job');
      await rejected('IDEMPOTENCY_CONFLICT', () =>
        service.requeue(fixture.actor, { ...fixture.command, reason: 'changed meaning' }),
      );
    },
  );

  await t.test('concurrent identical commands create one history/audit and return one replay', async () => {
    const fixture = await seed(migrator);
    const results = await Promise.all([
      service.requeue(fixture.actor, fixture.command),
      service.requeue(fixture.actor, { ...fixture.command, requestId: randomUUID() }),
    ]);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(results[0]?.auditEventId, results[1]?.auditEventId);
    const count = (
      await migrator.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM saas_platform_credential_validation_requeue_requests WHERE job_id=$1::uuid',
        [fixture.command.jobId],
      )
    ).rows[0]?.count;
    assert.equal(count, '1');
  });

  await t.test(
    'stale revisions, foreign credentials, revoked roles and superseded rights cannot write history',
    async () => {
      const fixture = await seed(migrator);
      const before = await snapshot(migrator, fixture);
      await rejected('STATE_CONFLICT', () =>
        service.requeue(fixture.actor, { ...fixture.command, expectedLeaseGeneration: 99 }),
      );
      await rejected('STATE_CONFLICT', () =>
        service.requeue(fixture.actor, { ...fixture.command, credentialId: 'foreign-credential' }),
      );
      await migrator.query('DELETE FROM saas_platform_role_assignments WHERE user_id=$1::uuid', [fixture.actor.userId]);
      await rejected('FORBIDDEN', () => service.requeue(fixture.actor, fixture.command));
      assert.deepEqual(await snapshot(migrator, fixture), before);
      const expired = await seed(migrator);
      await migrator.query(
        `INSERT INTO saas_provider_rights
        (rights_id,version,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,effective_at,expires_at,approval_ref,status,evidence_ref,evidence_sha256)
        SELECT rights_id,version+1,provider_id,product_id,credential_type,supply_mode,region,purpose,model_scope,endpoint_scope,effective_at,expires_at,approval_ref,'revoked',evidence_ref,evidence_sha256
        FROM saas_provider_rights WHERE rights_id=$1 AND version=1`,
        [expired.rightsId],
      );
      await rejected('TARGET_NOT_AUTHORIZED', () => service.requeue(expired.actor, expired.command));
      const count = (
        await migrator.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM saas_platform_credential_validation_requeue_requests WHERE job_id=$1::uuid',
          [expired.command.jobId],
        )
      ).rows[0]?.count;
      assert.equal(count, '0');
    },
  );

  await t.test(
    'transaction failure after the real trigger write rolls queue, history and audit back together',
    async () => {
      const fixture = await seed(migrator);
      const before = await snapshot(migrator, fixture);
      const failing: SaasDatabase = {
        query: control.query.bind(control),
        verifySchema: control.verifySchema.bind(control),
        migrate: control.migrate.bind(control),
        ping: control.ping.bind(control),
        close: async () => {},
        transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) =>
          control.transaction((tx) =>
            work({
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                const result = await tx.query<Row>(sql, values);
                if (sql.startsWith('INSERT INTO saas_platform_credential_validation_requeue_requests'))
                  throw new Error('controlled rollback');
                return result;
              },
            }),
          ),
      };
      await rejected('STORAGE_UNAVAILABLE', () =>
        new PlatformCredentialValidationRequeueService(failing).requeue(fixture.actor, fixture.command),
      );
      assert.deepEqual(await snapshot(migrator, fixture), before);
    },
  );

  await t.test('control plane has no job UPDATE, ledger mutation or writer EXECUTE privilege', async () => {
    const row = (
      await control.query<{ safe: boolean }>(`SELECT
      NOT has_any_column_privilege(current_user,'saas_platform_provider_credential_validation_jobs','UPDATE')
      AND NOT has_any_column_privilege(current_user,'saas_platform_credential_validation_requeue_requests','UPDATE')
      AND NOT has_table_privilege(current_user,'saas_platform_credential_validation_requeue_requests','DELETE')
      AND NOT has_function_privilege(current_user,'saas_platform_credential_validation_requeue_insert()','EXECUTE') AS safe`)
    ).rows[0];
    assert.equal(row?.safe, true);
    await assert.rejects(
      control.query('UPDATE saas_platform_provider_credential_validation_jobs SET status=status WHERE false'),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
    );
    await assert.rejects(
      control.query('UPDATE saas_platform_credential_validation_requeue_requests SET reason=reason WHERE false'),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
    );
  });
});
