import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialSealingKms,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
  withUnsealedProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import {
  verifyCredentialValidationWorkerRuntimePrivileges,
  verifySaasRuntimeDatabasePrivileges,
} from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  createCredentialValidationWorkerUnsealingKms,
  createProviderCredentialSealingKms,
} from '../../../src/saas/runtime/software-provider-credential-kms.js';
import {
  type OauthCredentialRotator,
  type OauthTokenRefreshFetch,
  PostgresOauthTokenRefreshWorkerStore,
} from '../../../src/saas/supply/oauth-token-refresh-worker.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// R4 real-PG gate: OAuth account token auto-refresh (migration 094) in the
// #18 assembly-A production topology under the preprovisioned restricted
// roles. The whole refresh chain — claim with SELECT ... FOR UPDATE OF ...
// SKIP LOCKED, unsealing through the real software-KMS path, the (seamed)
// token endpoint call, the oauth_* scheduling writes, and the new version
// chain + validation requeue + audit through the existing audited rotation
// entry — runs on the control-plane role, which owns every oauth_* column.
// The validation-worker role is a pure signal role: its only oauth write is
// the 401-class credential_rejected force flag; the other four oauth_*
// columns are pinned denied (42501). The gateway keeps its zero-write pin on
// credential relations. No bootstrap, HTTP fixture, migrations, DDL, role
// changes or provider traffic; the migrator seeds only the identity rows the
// flow needs.

const WORKER_URL_ENV = 'MODEL_ROUTER_SAAS_GATEWAY_E2E_VALIDATION_WORKER_URL';
const KMS_KEY_ENV = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY';
const KMS_KEY_ID_ENV = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID';

function workerUrl(): string {
  const value = process.env[WORKER_URL_ENV]?.trim();
  assert.ok(value, `${WORKER_URL_ENV} is required for the R4-094 real-PG gate`);
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${WORKER_URL_ENV} must be PostgreSQL`);
  assert.equal(
    decodeURIComponent(url.username),
    'model_router_saas_validation_worker',
    `${WORKER_URL_ENV} must use the validation worker role`,
  );
  assert.ok(url.search === '' && url.hash === '', `${WORKER_URL_ENV} must not contain overrides`);
  const [migratorUrl] = roleUrls();
  const migrator = new URL(migratorUrl);
  assert.equal(url.hostname.toLowerCase(), migrator.hostname.toLowerCase(), 'worker must share the gate host');
  assert.equal(url.port, migrator.port, 'worker must share the gate port');
  assert.equal(
    decodeURIComponent(url.pathname.slice(1)),
    decodeURIComponent(migrator.pathname.slice(1)),
    'worker must use the same disposable database',
  );
  return value;
}

const DEPLOYMENT = 'r4-gate-deployment';
const ENVIRONMENT = 'r4-gate-env';
const PROVIDER = { providerId: 'anthropic', productId: 'claude-code', credentialType: 'oauth' } as const;
const OLD_ACCESS = 'r4-gate-access-old';
const OLD_REFRESH = 'r4-gate-refresh-old';
const NEW_ACCESS = 'r4-gate-access-new';
const NEW_REFRESH = 'r4-gate-refresh-new';

const oldMaterial = () =>
  JSON.stringify({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH, token_type: 'Bearer', expires_in: 3600 });

function softwareKmsEnv(): NodeJS.ProcessEnv {
  assert.ok(/^[0-9a-fA-F]{64}$/.test(process.env[KMS_KEY_ENV] ?? ''), `${KMS_KEY_ENV} (64 hex) is required`);
  assert.equal(process.env[KMS_KEY_ID_ENV], 'software-local', `${KMS_KEY_ID_ENV} must be software-local`);
  return process.env;
}

interface SeededCredential {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly credentialId: string;
  readonly operatorUserId: string;
}

async function seedCredential(
  migrator: SaasDatabase,
  sealingKms: ProviderCredentialSealingKms,
  ownerKind: 'tenant' | 'platform',
  oauth: { readonly state: string; readonly due: boolean; readonly force?: boolean; readonly plaintext?: string },
): Promise<SeededCredential> {
  const label = randomUUID().slice(0, 8);
  const tenantId = ownerKind === 'tenant' ? randomUUID() : null;
  const accountId = `r4-account-${ownerKind}-${label}`;
  const credentialId = `r4-credential-${label}`;
  const rightsId = `r4-rights-${label}`;
  const operatorUserId = randomUUID();
  const supplyMode = ownerKind === 'tenant' ? 'byok' : 'platform';

  await migrator.query(`INSERT INTO model_router_saas.saas_users (id, email) VALUES ($1, $2)`, [
    operatorUserId,
    `r4-operator-${label}@example.test`,
  ]);
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_products (provider_id, product_id, display_name)
     VALUES ($1, $2, 'R4 gate synthetic product')
     ON CONFLICT (provider_id, product_id) DO NOTHING`,
    [PROVIDER.providerId, PROVIDER.productId],
  );
  if (tenantId) {
    await migrator.query(`INSERT INTO model_router_saas.saas_tenants (id, name, slug) VALUES ($1, $2, $2)`, [
      tenantId,
      `r4-tenant-${label}`,
    ]);
  }
  // The catalog capability identity must be unique per seed: the sequential
  // version trigger rejects a re-inserted (provider, product, model, endpoint)
  // tuple before ON CONFLICT can skip it.
  const endpoint = `r4-endpoint-${label}`;
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_rights
       (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
        model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
     VALUES ($1, 1, $2, $3, 'oauth', $4, 'test', 'inference',
             ARRAY['r4-model'], ARRAY[$7], '2026-09-28T00:00:00Z',
             $5, 'active', $5, $6)
     ON CONFLICT (rights_id, version) DO NOTHING`,
    [rightsId, PROVIDER.providerId, PROVIDER.productId, supplyMode, `r4-approval-${label}`, 'b'.repeat(64), endpoint],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_capabilities
       (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
        evidence_version, discovery_source, evidence_ref, evidence_sha256)
     VALUES ($1, $2, 'r4-model', $5, 'anthropic-compatible', 1, 'supported', 'verified',
             'r4-evidence-v1', 'manual', $3, $4)`,
    [PROVIDER.providerId, PROVIDER.productId, `r4-capability-${label}`, 'c'.repeat(64), endpoint],
  );

  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_accounts
         (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, $2, 'R4 gate tenant account', $3, $4, 'oauth', 'test', 'inference',
               $5, 1, 'active', 'verified')`,
      [tenantId, accountId, PROVIDER.providerId, PROVIDER.productId, rightsId],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_account_capabilities
         (tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version)
       VALUES ($1, $2, $3, $4, 'r4-model', $5, 1)`,
      [tenantId, accountId, PROVIDER.providerId, PROVIDER.productId, endpoint],
    );
  } else {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_accounts
         (id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, 'R4 gate platform account', $2, $3, 'oauth', 'test', 'inference',
               $4, 1, 'active', 'verified')`,
      [accountId, PROVIDER.providerId, PROVIDER.productId, rightsId],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_account_capabilities
         (account_id, provider_id, product_id, model, endpoint, capability_version)
       VALUES ($1, $2, $3, 'r4-model', $4, 1)`,
      [accountId, PROVIDER.providerId, PROVIDER.productId, endpoint],
    );
  }

  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: tenantId as string,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          ...PROVIDER,
          accountId,
          credentialId,
          credentialVersion: 1,
        }
      : {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          ...PROVIDER,
          accountId,
          credentialId,
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(
    Buffer.from(oauth.plaintext ?? oldMaterial()),
    context,
    sealingKms,
    'software-local',
  );
  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_credentials
         (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state,
          oauth_refresh_state, oauth_next_refresh_at, oauth_force_refresh_requested)
       VALUES ($1, $2, $3, $4, $5, 'oauth', 'active', 'verified', $6,
               CASE WHEN $7 THEN clock_timestamp() - interval '1 minute' ELSE clock_timestamp() + interval '1 hour' END,
               $8)`,
      [
        tenantId,
        credentialId,
        accountId,
        PROVIDER.providerId,
        PROVIDER.productId,
        oauth.state,
        oauth.due,
        oauth.force === true,
      ],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_credential_versions
         (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm,
          kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
       VALUES ($1, $2, $3, 1, 1, 1, 'aes-256-gcm', 'inference', $4, $5, $6, $7, $8, 'active')`,
      [
        tenantId,
        accountId,
        credentialId,
        envelope.kmsKeyId,
        envelope.wrappedDek,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
      ],
    );
    await migrator.query(
      `UPDATE model_router_saas.saas_tenant_provider_credentials
          SET current_version = 1 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, credentialId],
    );
  } else {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_credentials
         (id, account_id, provider_id, product_id, credential_type, status, validation_state,
          oauth_refresh_state, oauth_next_refresh_at, oauth_force_refresh_requested)
       VALUES ($1, $2, $3, $4, 'oauth', 'active', 'verified', $5,
               CASE WHEN $6 THEN clock_timestamp() - interval '1 minute' ELSE clock_timestamp() + interval '1 hour' END,
               $7)`,
      [credentialId, accountId, PROVIDER.providerId, PROVIDER.productId, oauth.state, oauth.due, oauth.force === true],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_credential_versions
         (account_id, credential_id, version, schema_version, context_version, algorithm,
          kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
       VALUES ($1, $2, 1, 1, 1, 'aes-256-gcm', 'inference', $3, $4, $5, $6, $7, 'active')`,
      [
        accountId,
        credentialId,
        envelope.kmsKeyId,
        envelope.wrappedDek,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
      ],
    );
    await migrator.query(
      `UPDATE model_router_saas.saas_platform_provider_credentials
          SET current_version = 1 WHERE id = $1`,
      [credentialId],
    );
  }
  return { ownerKind, tenantId, accountId, credentialId, operatorUserId };
}

function credentialQuery(ownerKind: 'tenant' | 'platform'): string {
  return ownerKind === 'tenant'
    ? `SELECT status, validation_state, current_version, oauth_refresh_state, oauth_refresh_error_code,
              oauth_force_refresh_requested, oauth_last_refresh_at, oauth_next_refresh_at
         FROM model_router_saas.saas_tenant_provider_credentials WHERE tenant_id = $1 AND id = $2`
    : `SELECT status, validation_state, current_version, oauth_refresh_state, oauth_refresh_error_code,
              oauth_force_refresh_requested, oauth_last_refresh_at, oauth_next_refresh_at
         FROM model_router_saas.saas_platform_provider_credentials WHERE id = $1`;
}

function credentialIdentity(seeded: SeededCredential): readonly unknown[] {
  return seeded.ownerKind === 'tenant' ? [seeded.tenantId, seeded.credentialId] : [seeded.credentialId];
}

const successTokenResponse = () =>
  new Response(
    JSON.stringify({
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      expires_in: 3600,
      scope: 'discarded',
      id_token: 'discarded',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function gateFetch(responder: () => Response | Promise<Response>, seen?: string[]) {
  return async (url: URL, init: RequestInit): Promise<Response> => {
    assert.equal(url.href, 'https://console.anthropic.com/v1/oauth/token');
    assert.equal(init.redirect, 'manual');
    seen?.push(String(init.body));
    return responder();
  };
}

interface CredentialRow {
  status: string;
  validation_state: string;
  current_version: number;
  oauth_refresh_state: string | null;
  oauth_refresh_error_code: string | null;
  oauth_force_refresh_requested: boolean;
  oauth_last_refresh_at: Date | null;
  oauth_next_refresh_at: Date | null;
}

async function readCredential(migrator: SaasDatabase, seeded: SeededCredential): Promise<CredentialRow> {
  const result = await migrator.query<CredentialRow>(credentialQuery(seeded.ownerKind), credentialIdentity(seeded));
  const row = result.rows[0];
  assert.ok(row, 'seeded credential must exist');
  return row;
}

test('R4 OAuth token refresh runs end-to-end on the control-plane role with real unsealing', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1, all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs, ${WORKER_URL_ENV} and ${KMS_KEY_ENV} to require R4-094`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const worker = observedDatabase(workerUrl());
  const env = softwareKmsEnv();
  const sealingKms = await createProviderCredentialSealingKms({ env });
  const unsealingKms: ProviderCredentialUnsealingKms = await createCredentialValidationWorkerUnsealingKms({ env });

  const persistence = new ProviderSupplyPersistenceService(new PostgresProviderSupplyRepository(control.database), {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    kmsKeyId: 'software-local',
    sealingKms,
  });
  // One synthetic operator identity per run satisfies the audit actor FK; the
  // refresh worker's audit trail is a workload attribution, not a user act.
  const operatorUserId = randomUUID();
  await migrator.database.query(`INSERT INTO model_router_saas.saas_users (id, email) VALUES ($1, $2)`, [
    operatorUserId,
    `r4-refresh-worker-${randomUUID().slice(0, 8)}@example.test`,
  ]);

  /** The production rotation wiring: the existing audited supply rotation entry. */
  const rotator: OauthCredentialRotator = async (input) => {
    const result = await persistence.replaceProviderCredentialSecretWithAudit(
      {
        credential: {
          ownerKind: input.ownerKind,
          tenantId: input.tenantId,
          accountId: input.accountId,
          credentialId: input.credentialId,
        },
        expectedVersion: input.expectedVersion,
        secret: input.secret,
      },
      { actorUserId: operatorUserId, entryPoint: 'oauth-token-refresh-worker' },
    );
    return { version: result.version.version };
  };

  const storeFor = (
    database: SaasDatabase,
    owners: readonly ('tenant' | 'platform')[],
    fetch: OauthTokenRefreshFetch,
  ) =>
    new PostgresOauthTokenRefreshWorkerStore(database, unsealingKms, {
      deployment: DEPLOYMENT,
      environment: ENVIRONMENT,
      owners,
      fetch,
    });

  /** Credentials are never deleted; drain leftovers so the next seed is the only due row. */
  const drain = async (owners: readonly ('tenant' | 'platform')[]): Promise<void> => {
    const store = storeFor(
      control.database,
      owners,
      gateFetch(() => successTokenResponse()),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const outcome = await store.refreshNext(rotator);
      if (outcome.outcome === 'idle') return;
    }
    throw new Error('due credential drain did not quiesce');
  };

  try {
    await t.test('runtime probes cover control-plane, gateway and worker oauth grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
      await verifyCredentialValidationWorkerRuntimePrivileges(worker.database);
    });

    await t.test(
      'tenant and platform credentials refresh on the control-plane role into a new version chain',
      async () => {
        for (const ownerKind of ['tenant', 'platform'] as const) {
          await drain([ownerKind]);
          const seeded = await seedCredential(migrator.database, sealingKms, ownerKind, {
            state: 'idle',
            due: true,
          });
          const requestBodies: string[] = [];
          const store = storeFor(
            control.database,
            [ownerKind],
            gateFetch(() => successTokenResponse(), requestBodies),
          );
          const outcome = await store.refreshNext(rotator);
          assert.deepEqual(outcome, { outcome: 'refreshed', ownerKind, credentialId: seeded.credentialId, version: 2 });

          // The token endpoint saw the sealed refresh token, inside the module only.
          assert.equal(requestBodies.length, 1);
          const form = new URLSearchParams(requestBodies[0] as string);
          assert.equal(form.get('grant_type'), 'refresh_token');
          assert.equal(form.get('refresh_token'), OLD_REFRESH);

          const row = await readCredential(migrator.database, seeded);
          assert.equal(row.current_version, 2);
          assert.equal(row.oauth_refresh_state, 'idle');
          assert.equal(row.oauth_refresh_error_code, null);
          assert.equal(row.oauth_force_refresh_requested, false);
          assert.ok(row.oauth_last_refresh_at instanceof Date);
          assert.ok(row.oauth_next_refresh_at instanceof Date);
          const scheduledSeconds =
            ((row.oauth_next_refresh_at as Date).getTime() - (row.oauth_last_refresh_at as Date).getTime()) / 1000;
          assert.ok(
            scheduledSeconds >= 2592 && scheduledSeconds <= 3168,
            `next refresh ${scheduledSeconds}s out must be expires_in x 0.8 with +/-10% jitter`,
          );
          // The rotation path parks the credential for revalidation (058 family
          // linkage: current_version + authz_version moved together).
          assert.equal(row.status, 'pending');
          assert.equal(row.validation_state, 'unverified');

          // Old version retired but retained; new version active.
          const versionsTable =
            ownerKind === 'tenant'
              ? 'model_router_saas.saas_tenant_provider_credential_versions'
              : 'model_router_saas.saas_platform_provider_credential_versions';
          const versionsIdentity =
            ownerKind === 'tenant' ? [seeded.tenantId, seeded.credentialId] : [seeded.credentialId];
          const versions = await migrator.database.query<{
            version: number;
            status: string;
            retired_at: Date | null;
            kms_key_id: string;
            wrapped_dek: string;
            nonce: string;
            ciphertext: string;
            auth_tag: string;
          }>(
            `SELECT version, status, retired_at, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag
             FROM ${versionsTable}
             WHERE ${ownerKind === 'tenant' ? 'tenant_id = $1 AND credential_id = $2' : 'credential_id = $1'}
             ORDER BY version`,
            versionsIdentity,
          );
          assert.equal(versions.rows.length, 2);
          assert.equal(versions.rows[0]?.version, 1);
          assert.equal(versions.rows[0]?.status, 'retired');
          assert.ok(versions.rows[0]?.retired_at instanceof Date, 'the old version stays on record');
          assert.equal(versions.rows[1]?.version, 2);
          assert.equal(versions.rows[1]?.status, 'active');

          // The new version unseals to exactly the canonical rotated material.
          const rotated = versions.rows[1] as (typeof versions.rows)[number];
          const unsealContext = createProviderCredentialContext(
            ownerKind === 'tenant'
              ? {
                  ownerKind: 'tenant',
                  tenantId: seeded.tenantId as string,
                  supplyMode: 'byok',
                  deployment: DEPLOYMENT,
                  environment: ENVIRONMENT,
                  purpose: 'inference',
                  ...PROVIDER,
                  accountId: seeded.accountId,
                  credentialId: seeded.credentialId,
                  credentialVersion: 2,
                }
              : {
                  ownerKind: 'platform',
                  supplyMode: 'platform',
                  deployment: DEPLOYMENT,
                  environment: ENVIRONMENT,
                  purpose: 'inference',
                  ...PROVIDER,
                  accountId: seeded.accountId,
                  credentialId: seeded.credentialId,
                  credentialVersion: 2,
                },
          );
          let material: unknown;
          await withUnsealedProviderCredential(
            {
              schemaVersion: 1,
              contextVersion: 1,
              algorithm: 'aes-256-gcm',
              kmsKeyId: rotated.kms_key_id,
              wrappedDek: rotated.wrapped_dek,
              nonce: rotated.nonce,
              ciphertext: rotated.ciphertext,
              authTag: rotated.auth_tag,
            },
            unsealContext,
            unsealingKms,
            (secret) => {
              material = JSON.parse(Buffer.from(secret).toString('utf8'));
            },
          );
          assert.deepEqual(material, {
            access_token: NEW_ACCESS,
            refresh_token: NEW_REFRESH,
            token_type: 'Bearer',
            expires_in: 3600,
          });

          // The rotation requeue enqueued exactly one validation job for v2.
          const jobsTable =
            ownerKind === 'tenant'
              ? 'model_router_saas.saas_tenant_provider_credential_validation_jobs'
              : 'model_router_saas.saas_platform_provider_credential_validation_jobs';
          const jobs = await migrator.database.query<{ status: string; credential_version: number }>(
            `SELECT status, credential_version FROM ${jobsTable}
             WHERE ${ownerKind === 'tenant' ? 'tenant_id = $1 AND credential_id = $2' : 'credential_id = $1'}
             ORDER BY credential_version`,
            versionsIdentity,
          );
          assert.deepEqual(
            jobs.rows.map((job) => [job.credential_version, job.status]),
            [[2, 'queued']],
            'rotation must requeue validation for exactly the new version',
          );

          // The audited rotation entry left its audit event.
          const audit = await migrator.database.query<{ action: string; target_id: string }>(
            `SELECT action, target_id FROM model_router_saas.saas_audit_events
            WHERE action = 'provider_supply.credential.secret_rotated' AND target_id = $1`,
            [seeded.credentialId],
          );
          assert.equal(audit.rows.length, 1);

          // The rescheduled row is not due: a second cycle is idle.
          const second = await store.refreshNext(rotator);
          assert.deepEqual(second, { outcome: 'idle' });
        }
      },
    );

    await t.test('a force-flagged credential claims ahead of an older ordinarily-due one', async () => {
      await drain(['tenant']);
      const ordinary = await seedCredential(migrator.database, sealingKms, 'tenant', {
        state: 'idle',
        due: true,
      });
      const forced = await seedCredential(migrator.database, sealingKms, 'tenant', {
        state: 'idle',
        due: true,
        force: true,
      });
      const store = storeFor(
        control.database,
        ['tenant'],
        gateFetch(() => successTokenResponse()),
      );
      const first = await store.refreshNext(rotator);
      assert.deepEqual(first, {
        outcome: 'refreshed',
        ownerKind: 'tenant',
        credentialId: forced.credentialId,
        version: 2,
      });
      const forcedRow = await readCredential(migrator.database, forced);
      assert.equal(forcedRow.oauth_force_refresh_requested, false, 'the refresh consumes the force flag');
      const second = await store.refreshNext(rotator);
      assert.deepEqual(second, {
        outcome: 'refreshed',
        ownerKind: 'tenant',
        credentialId: ordinary.credentialId,
        version: 2,
      });
    });

    await t.test('endpoint failures write failed state with doubling backoff and never rotate', async () => {
      await drain(['tenant']);
      const seeded = await seedCredential(migrator.database, sealingKms, 'tenant', {
        state: 'idle',
        due: true,
      });
      const failing = storeFor(
        control.database,
        ['tenant'],
        gateFetch(() => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })),
      );
      const first = await failing.refreshNext(async () => {
        throw new Error('must not rotate a failed refresh');
      });
      assert.deepEqual(first, {
        outcome: 'failed',
        ownerKind: 'tenant',
        credentialId: seeded.credentialId,
        errorCode: 'provider_unavailable',
      });
      const afterFirst = await readCredential(migrator.database, seeded);
      assert.equal(afterFirst.oauth_refresh_state, 'failed');
      assert.equal(afterFirst.oauth_refresh_error_code, 'provider_unavailable');
      assert.equal(afterFirst.oauth_force_refresh_requested, false);
      const firstBackoff =
        ((afterFirst.oauth_next_refresh_at as Date).getTime() - (afterFirst.oauth_last_refresh_at as Date).getTime()) /
        1000;
      assert.ok(firstBackoff >= 55 && firstBackoff <= 65, `first backoff ${firstBackoff}s must be ~1m`);
      assert.equal(afterFirst.current_version, 1, 'a failed refresh never touches the version chain');

      // The validation worker's force signal makes the row due immediately;
      // the second consecutive failure doubles the backoff.
      await migrator.database.query(
        `UPDATE model_router_saas.saas_tenant_provider_credentials
            SET oauth_force_refresh_requested = true WHERE tenant_id = $1 AND id = $2`,
        [seeded.tenantId, seeded.credentialId],
      );
      const second = await failing.refreshNext(async () => {
        throw new Error('must not rotate a failed refresh');
      });
      assert.deepEqual(second, {
        outcome: 'failed',
        ownerKind: 'tenant',
        credentialId: seeded.credentialId,
        errorCode: 'provider_unavailable',
      });
      const afterSecond = await readCredential(migrator.database, seeded);
      const secondBackoff =
        ((afterSecond.oauth_next_refresh_at as Date).getTime() -
          (afterSecond.oauth_last_refresh_at as Date).getTime()) /
        1000;
      assert.ok(secondBackoff >= 115 && secondBackoff <= 125, `second backoff ${secondBackoff}s must be ~2m`);
    });

    await t.test('non-OAuth envelope material fails credential_unavailable without a token call', async () => {
      await drain(['tenant']);
      // The envelope holds an api-key shaped secret, not OAuth material.
      const seeded = await seedCredential(migrator.database, sealingKms, 'tenant', {
        state: 'idle',
        due: true,
        plaintext: `sk-not-oauth-${randomUUID().slice(0, 8)}`,
      });
      let fetches = 0;
      const store = storeFor(control.database, ['tenant'], (async () => {
        fetches += 1;
        throw new Error('must not call the token endpoint');
      }) as never);
      const outcome = await store.refreshNext(async () => {
        throw new Error('must not rotate');
      });
      assert.equal(fetches, 0);
      assert.deepEqual(outcome, {
        outcome: 'failed',
        ownerKind: 'tenant',
        credentialId: seeded.credentialId,
        errorCode: 'credential_unavailable',
      });
      const row = await readCredential(migrator.database, seeded);
      assert.equal(row.oauth_refresh_state, 'failed');
      assert.equal(row.oauth_refresh_error_code, 'credential_unavailable');
    });

    await t.test('SKIP LOCKED makes a concurrent claim idle instead of waiting or doubling', async () => {
      await drain(['tenant']);
      const seeded = await seedCredential(migrator.database, sealingKms, 'tenant', {
        state: 'idle',
        due: true,
      });
      const contending = observedDatabase(controlUrl);
      try {
        let releaseFetch: (() => void) | undefined;
        const fetchGate = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const first = storeFor(
          control.database,
          ['tenant'],
          gateFetch(async () => {
            await fetchGate;
            return successTokenResponse();
          }) as never,
        );
        const second = storeFor(
          contending.database,
          ['tenant'],
          gateFetch(() => successTokenResponse()),
        );
        const pending = first.refreshNext(rotator);
        // The first claim holds the row lock across its token call; the second
        // store must observe the credential as claimed and report idle.
        const concurrent = await second.refreshNext(rotator);
        assert.deepEqual(concurrent, { outcome: 'idle' });
        releaseFetch?.();
        const outcome = await pending;
        assert.deepEqual(outcome, {
          outcome: 'refreshed',
          ownerKind: 'tenant',
          credentialId: seeded.credentialId,
          version: 2,
        });
        const row = await readCredential(migrator.database, seeded);
        assert.equal(row.current_version, 2, 'exactly one writer rotated the credential');
        assert.equal(row.oauth_refresh_state, 'idle');
      } finally {
        await contending.database.close();
      }
    });

    await t.test('worker and gateway stay in their lanes: signal-only worker, zero-write gateway', async () => {
      await drain(['tenant']);
      const seeded = await seedCredential(migrator.database, sealingKms, 'tenant', {
        state: 'idle',
        due: true,
      });
      const is42501 = (error: unknown) => (error as { code?: string }).code === '42501';

      // The gateway keeps its zero-write pin on credential relations: even
      // the force-refresh flag is the validation worker's column, never the
      // gateway's (2026-10-11 re-arbitration).
      await assert.rejects(
        gateway.database.query(
          `UPDATE model_router_saas.saas_tenant_provider_credentials
              SET oauth_force_refresh_requested = true WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, seeded.credentialId],
        ),
        is42501,
      );

      // Assembly A: the worker role is a pure signal role. Its single
      // authorized oauth write is the force flag a 401-class terminal
      // validation failure raises (credential-validation-worker's
      // updateHealthState raises it only for credential_rejected).
      const signal = await worker.database.query(
        `UPDATE model_router_saas.saas_tenant_provider_credentials
            SET status = 'pending', validation_state = 'failed', validation_error_code = 'credential_rejected',
                last_validated_at = clock_timestamp(), updated_at = clock_timestamp(),
                authz_version = authz_version + 1,
                oauth_force_refresh_requested = true
          WHERE tenant_id = $1 AND id = $2 AND account_id = $3
            AND current_version = 1 AND status IN ('pending', 'active')
       RETURNING id`,
        [seeded.tenantId, seeded.credentialId, seeded.accountId],
      );
      assert.equal(signal.rowCount, 1, 'the credential_rejected force signal must land');
      const signalled = await readCredential(migrator.database, seeded);
      assert.equal(signalled.oauth_force_refresh_requested, true);

      // The other four oauth_* columns belong to the control-plane role only:
      // every scheduling write is denied on the worker role.
      for (const [column, value] of [
        ['oauth_refresh_state', "'failed'"],
        ['oauth_next_refresh_at', 'clock_timestamp()'],
        ['oauth_last_refresh_at', 'clock_timestamp()'],
        ['oauth_refresh_error_code', "'worker_lane_denied'"],
      ] as const) {
        await assert.rejects(
          worker.database.query(
            `UPDATE model_router_saas.saas_tenant_provider_credentials
                SET ${column} = ${value}, updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND id = $2`,
            [seeded.tenantId, seeded.credentialId],
          ),
          is42501,
        );
      }

      // The worker can never write the version chain itself: current_version
      // is read-only, versions and validation jobs are insert-forbidden,
      // scheduling scalars untouchable.
      await assert.rejects(
        worker.database.query(
          `UPDATE model_router_saas.saas_tenant_provider_credentials
              SET current_version = 9 WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, seeded.credentialId],
        ),
        is42501,
      );
      await assert.rejects(
        worker.database.query(
          `INSERT INTO model_router_saas.saas_tenant_provider_credential_versions
               (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm,
                kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag)
             VALUES ($1, $2, $3, 99, 1, 1, 'aes-256-gcm', 'inference', 'forged', 'forged', 'forged', 'forged', 'forged')`,
          [seeded.tenantId, seeded.accountId, seeded.credentialId],
        ),
        is42501,
      );
      await assert.rejects(
        worker.database.query(
          `INSERT INTO model_router_saas.saas_tenant_provider_credential_validation_jobs
               (tenant_id, account_id, credential_id, credential_version, provider_id, product_id,
                credential_type, allowed_models, target_model, target_endpoint, capability_version, idempotency_key)
             VALUES ($1, $2, $3, 99, 'anthropic', 'claude-code', 'oauth', ARRAY['r4-model'], 'r4-model',
                     '/v1/messages', 1, $4)`,
          [seeded.tenantId, seeded.accountId, seeded.credentialId, 'd'.repeat(64)],
        ),
        is42501,
      );
      await assert.rejects(
        worker.database.query(
          `UPDATE model_router_saas.saas_tenant_provider_accounts
              SET priority = 5 WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, seeded.accountId],
        ),
        is42501,
      );
    });
  } finally {
    await sealingKms.close();
    await (unsealingKms as { close?: () => Promise<void> }).close?.();
    await migrator.database.close();
    await control.database.close();
    await gateway.database.close();
    await worker.database.close();
  }
});
