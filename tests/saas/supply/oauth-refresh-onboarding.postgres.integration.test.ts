import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialSealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { createProviderCredentialSealingKms } from '../../../src/saas/runtime/software-provider-credential-kms.js';
import { ProviderSupplyPersistenceService } from '../../../src/saas/supply/persistence-service.js';
import { PostgresProviderSupplyRepository } from '../../../src/saas/supply/repository.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// #18a real-PG gate: OAuth credential onboarding (migration 094) through the
// real supply persistence paths under the preprovisioned restricted roles.
// Creation onboards oauth_refresh_state='idle' + oauth_next_refresh_at only
// for credentials bound by the R4 fixed adapter registry; rotation inherits
// the schedule for idle/failed rows, preserves claimed 'refreshing' rows,
// and keeps legacy NULL rows byte-identical. Under the R4 #18 assembly-A
// role template the control plane owns the OAuth columns end to end: the
// onboarding INSERT (oauth_refresh_state + oauth_next_refresh_at) and the
// idle-row reschedule UPDATE run and succeed on the control-plane
// connection, while a claimed 'refreshing' row is preserved untouched. No
// bootstrap, migrations, DDL or role changes; the migrator seeds only
// identity rows (random uuid labels).

const KMS_KEY_ENV = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY';
const KMS_KEY_ID_ENV = 'MODEL_ROUTER_SAAS_SOFTWARE_KMS_KEY_ID';

const DEPLOYMENT = 'oauth-onboarding-gate';
const ENVIRONMENT = 'oauth-onboarding-gate-env';
const OAUTH_PRODUCT = { providerId: 'anthropic', productId: 'claude-code', credentialType: 'oauth' } as const;

function softwareKmsEnv(): NodeJS.ProcessEnv {
  assert.ok(/^[0-9a-fA-F]{64}$/.test(process.env[KMS_KEY_ENV] ?? ''), `${KMS_KEY_ENV} (64 hex) is required`);
  assert.equal(process.env[KMS_KEY_ID_ENV], 'software-local', `${KMS_KEY_ID_ENV} must be software-local`);
  return process.env;
}

function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function oauthMaterial(expiresIn?: unknown): Buffer {
  return Buffer.from(
    JSON.stringify({
      access_token: `gate-access-${randomUUID().slice(0, 8)}`,
      refresh_token: `gate-refresh-${randomUUID().slice(0, 8)}`,
      token_type: 'Bearer',
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    }),
  );
}

interface SeededAccount {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly operatorUserId: string;
}

async function seedAccount(
  migrator: SaasDatabase,
  ownerKind: 'tenant' | 'platform',
  product: { readonly providerId: string; readonly productId: string; readonly credentialType: string },
): Promise<SeededAccount> {
  const label = randomUUID().slice(0, 8);
  const tenantId = ownerKind === 'tenant' ? randomUUID() : null;
  const accountId = `gate18a-account-${ownerKind}-${label}`;
  const rightsId = `gate18a-rights-${label}`;
  const operatorUserId = randomUUID();
  const supplyMode = ownerKind === 'tenant' ? 'byok' : 'platform';
  const endpoint = `gate18a-endpoint-${label}`;

  await migrator.query(`INSERT INTO model_router_saas.saas_users (id, email) VALUES ($1, $2)`, [
    operatorUserId,
    `gate18a-operator-${label}@example.test`,
  ]);
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_products (provider_id, product_id, display_name)
     VALUES ($1, $2, '#18a gate synthetic product')
     ON CONFLICT (provider_id, product_id) DO NOTHING`,
    [product.providerId, product.productId],
  );
  if (tenantId) {
    await migrator.query(`INSERT INTO model_router_saas.saas_tenants (id, name, slug) VALUES ($1, $2, $2)`, [
      tenantId,
      `gate18a-tenant-${label}`,
    ]);
  }
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_rights
       (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
        model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
     VALUES ($1, 1, $2, $3, $4, $5, 'test', 'inference',
             ARRAY['gate18a-model'], ARRAY[$8], '2026-09-28T00:00:00Z',
             $6, 'active', $6, $7)`,
    [
      rightsId,
      product.providerId,
      product.productId,
      product.credentialType,
      supplyMode,
      `gate18a-approval-${label}`,
      'b'.repeat(64),
      endpoint,
    ],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_provider_capabilities
       (provider_id, product_id, model, endpoint, protocol, version, support_level, validation_state,
        evidence_version, discovery_source, evidence_ref, evidence_sha256)
     VALUES ($1, $2, 'gate18a-model', $5, 'anthropic-compatible', 1, 'supported', 'verified',
             'gate18a-evidence-v1', 'manual', $3, $4)`,
    [product.providerId, product.productId, `gate18a-capability-${label}`, 'c'.repeat(64), endpoint],
  );
  if (ownerKind === 'tenant') {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_accounts
         (tenant_id, id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, $2, '#18a gate tenant account', $3, $4, $5, 'test', 'inference',
               $6, 1, 'active', 'verified')`,
      [tenantId, accountId, product.providerId, product.productId, product.credentialType, rightsId],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_tenant_provider_account_capabilities
         (tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version)
       VALUES ($1, $2, $3, $4, 'gate18a-model', $5, 1)`,
      [tenantId, accountId, product.providerId, product.productId, endpoint],
    );
  } else {
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_accounts
         (id, display_name, provider_id, product_id, credential_type, region, purpose,
          rights_id, rights_version, status, validation_state)
       VALUES ($1, '#18a gate platform account', $2, $3, $4, 'test', 'inference',
               $5, 1, 'active', 'verified')`,
      [accountId, product.providerId, product.productId, product.credentialType, rightsId],
    );
    await migrator.query(
      `INSERT INTO model_router_saas.saas_platform_provider_account_capabilities
         (account_id, provider_id, product_id, model, endpoint, capability_version)
       VALUES ($1, $2, $3, 'gate18a-model', $4, 1)`,
      [accountId, product.providerId, product.productId, endpoint],
    );
  }
  return { ownerKind, tenantId, accountId, operatorUserId };
}

interface CredentialOauthRow {
  status: string;
  current_version: number;
  oauth_refresh_state: string | null;
  oauth_refresh_error_code: string | null;
  oauth_force_refresh_requested: boolean;
  oauth_last_refresh_at: Date | null;
  oauth_next_refresh_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function readCredential(
  migrator: SaasDatabase,
  seeded: SeededAccount,
  credentialId: string,
): Promise<CredentialOauthRow> {
  const result =
    seeded.ownerKind === 'tenant'
      ? await migrator.query<CredentialOauthRow>(
          `SELECT status, current_version, oauth_refresh_state, oauth_refresh_error_code,
                  oauth_force_refresh_requested, oauth_last_refresh_at, oauth_next_refresh_at,
                  created_at, updated_at
             FROM model_router_saas.saas_tenant_provider_credentials WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, credentialId],
        )
      : await migrator.query<CredentialOauthRow>(
          `SELECT status, current_version, oauth_refresh_state, oauth_refresh_error_code,
                  oauth_force_refresh_requested, oauth_last_refresh_at, oauth_next_refresh_at,
                  created_at, updated_at
             FROM model_router_saas.saas_platform_provider_credentials WHERE id = $1`,
          [credentialId],
        );
  const row = result.rows[0];
  assert.ok(row, 'credential must exist');
  return row;
}

/** expires_in x 0.8 with the deterministic +/-10% credential-keyed jitter. */
function assertDelayBand(anchor: Date, next: Date, expiresInSeconds: number, label: string): void {
  const scheduledSeconds = (next.getTime() - anchor.getTime()) / 1000;
  const base = expiresInSeconds * 0.8;
  assert.ok(
    scheduledSeconds >= base * 0.9 && scheduledSeconds <= base * 1.1,
    `${label}: scheduled ${scheduledSeconds}s out, expected ${base}s +/-10%`,
  );
}

test('#18a OAuth credential onboarding persists and inherits the refresh schedule under real roles', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1, the three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs and ${KMS_KEY_ENV} to require #18a`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const sealingKms: ProviderCredentialSealingKms = createProviderCredentialSealingKms({ env: softwareKmsEnv() });
  const serviceOn = (database: SaasDatabase) =>
    new ProviderSupplyPersistenceService(new PostgresProviderSupplyRepository(database), {
      deployment: DEPLOYMENT,
      environment: ENVIRONMENT,
      kmsKeyId: 'software-local',
      sealingKms,
    });

  try {
    await t.test('the control-plane runtime probe matches the frozen role template', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    });

    await t.test('OAuth creation onboards idle plus the first-refresh schedule on both owner paths', async () => {
      const service = serviceOn(migrator.database);
      for (const ownerKind of ['tenant', 'platform'] as const) {
        const seeded = await seedAccount(migrator.database, ownerKind, OAUTH_PRODUCT);
        const credentialId = `gate18a-credential-${ownerKind}-${randomUUID().slice(0, 8)}`;
        const expiresIn = ownerKind === 'tenant' ? 3600 : 7200;
        const created = await service.createProviderCredentialWithAudit(
          {
            account: { ownerKind, tenantId: seeded.tenantId, accountId: seeded.accountId },
            id: credentialId,
            secret: oauthMaterial(expiresIn),
          },
          { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
        );
        assert.equal(created.version.version, 1);
        const row = await readCredential(migrator.database, seeded, credentialId);
        assert.equal(row.oauth_refresh_state, 'idle');
        assert.equal(row.oauth_refresh_error_code, null);
        assert.equal(row.oauth_force_refresh_requested, false);
        assert.equal(row.oauth_last_refresh_at, null);
        assert.ok(row.oauth_next_refresh_at instanceof Date);
        assertDelayBand(row.created_at, row.oauth_next_refresh_at as Date, expiresIn, `${ownerKind} first refresh`);
      }
    });

    await t.test('malformed or absent expires_in falls back to the default TTL without blocking creation', async () => {
      const service = serviceOn(migrator.database);
      const malformed = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
      const malformedId = `gate18a-credential-malformed-${randomUUID().slice(0, 8)}`;
      await service.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: malformed.tenantId, accountId: malformed.accountId },
          id: malformedId,
          secret: oauthMaterial('soon'),
        },
        { actorUserId: malformed.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      const malformedRow = await readCredential(migrator.database, malformed, malformedId);
      assert.equal(malformedRow.oauth_refresh_state, 'idle');
      assert.ok(malformedRow.oauth_next_refresh_at instanceof Date);
      // Default 1h TTL: 3600 x 0.8 = 2880s +/-10%.
      assertDelayBand(malformedRow.created_at, malformedRow.oauth_next_refresh_at as Date, 3600, 'malformed fallback');

      // A valid tiny expires_in takes its own band (100 x 0.8 = 80s +/-10%),
      // proving the malformed row above really used the default, not the value.
      const tiny = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
      const tinyId = `gate18a-credential-tiny-${randomUUID().slice(0, 8)}`;
      await service.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: tiny.tenantId, accountId: tiny.accountId },
          id: tinyId,
          secret: oauthMaterial(100),
        },
        { actorUserId: tiny.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      const tinyRow = await readCredential(migrator.database, tiny, tinyId);
      assert.ok(tinyRow.oauth_next_refresh_at instanceof Date);
      assertDelayBand(tinyRow.created_at, tinyRow.oauth_next_refresh_at as Date, 100, 'tiny expires_in');
    });

    await t.test('non-OAuth creation keeps the NULL oauth shape', async () => {
      const service = serviceOn(migrator.database);
      const seeded = await seedAccount(migrator.database, 'tenant', {
        providerId: 'anthropic',
        productId: 'claude-code',
        credentialType: 'api-key',
      });
      const credentialId = `gate18a-credential-apikey-${randomUUID().slice(0, 8)}`;
      await service.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId },
          id: credentialId,
          secret: Buffer.from('gate18a-plain-api-key'),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      const row = await readCredential(migrator.database, seeded, credentialId);
      assert.equal(row.oauth_refresh_state, null);
      assert.equal(row.oauth_next_refresh_at, null);
      assert.equal(row.oauth_last_refresh_at, null);
      assert.equal(row.oauth_refresh_error_code, null);
      assert.equal(row.oauth_force_refresh_requested, false);
    });

    await t.test(
      'rotation of an idle OAuth credential rearranges the schedule and clears force and error',
      async () => {
        const service = serviceOn(migrator.database);
        const seeded = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
        const credentialId = `gate18a-credential-rotate-${randomUUID().slice(0, 8)}`;
        await service.createProviderCredentialWithAudit(
          {
            account: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId },
            id: credentialId,
            secret: oauthMaterial(3600),
          },
          { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
        );
        const lastStamp = '2026-09-27T12:00:00.000Z';
        await migrator.database.query(
          `UPDATE model_router_saas.saas_tenant_provider_credentials
              SET oauth_force_refresh_requested = true, oauth_refresh_error_code = 'credential_rejected',
                  oauth_last_refresh_at = $3
            WHERE tenant_id = $1 AND id = $2`,
          [seeded.tenantId, credentialId, lastStamp],
        );
        const rotated = await service.replaceProviderCredentialSecretWithAudit(
          {
            credential: {
              ownerKind: 'tenant',
              tenantId: seeded.tenantId,
              accountId: seeded.accountId,
              credentialId,
            },
            expectedVersion: 1,
            secret: oauthMaterial(7200),
          },
          { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
        );
        assert.equal(rotated.version.version, 2);
        const row = await readCredential(migrator.database, seeded, credentialId);
        assert.equal(row.current_version, 2);
        assert.equal(row.oauth_refresh_state, 'idle');
        assert.equal(row.oauth_refresh_error_code, null);
        assert.equal(row.oauth_force_refresh_requested, false);
        assert.ok(row.oauth_last_refresh_at instanceof Date);
        assert.equal((row.oauth_last_refresh_at as Date).toISOString(), new Date(lastStamp).toISOString());
        assert.ok(row.oauth_next_refresh_at instanceof Date);
        assertDelayBand(row.updated_at, row.oauth_next_refresh_at as Date, 7200, 'rotation reschedule');
      },
    );

    await t.test("rotation of a refresh-chain-claimed 'refreshing' row preserves every oauth column", async () => {
      const service = serviceOn(migrator.database);
      const seeded = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
      const credentialId = `gate18a-credential-refreshing-${randomUUID().slice(0, 8)}`;
      await service.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId },
          id: credentialId,
          secret: oauthMaterial(3600),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      const claimStamp = '2026-09-28T00:00:01.000Z';
      const claimedNext = '2026-09-28T00:30:00.000Z';
      await migrator.database.query(
        `UPDATE model_router_saas.saas_tenant_provider_credentials
            SET oauth_refresh_state = 'refreshing', oauth_force_refresh_requested = true,
                oauth_last_refresh_at = $3, oauth_next_refresh_at = $4
          WHERE tenant_id = $1 AND id = $2`,
        [seeded.tenantId, credentialId, claimStamp, claimedNext],
      );
      const rotated = await service.replaceProviderCredentialSecretWithAudit(
        {
          credential: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId, credentialId },
          expectedVersion: 1,
          secret: oauthMaterial(7200),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      assert.equal(rotated.version.version, 2);
      const row = await readCredential(migrator.database, seeded, credentialId);
      assert.equal(row.current_version, 2);
      assert.equal(row.oauth_refresh_state, 'refreshing');
      assert.equal(row.oauth_force_refresh_requested, true);
      assert.equal((row.oauth_last_refresh_at as Date).toISOString(), new Date(claimStamp).toISOString());
      assert.equal((row.oauth_next_refresh_at as Date).toISOString(), new Date(claimedNext).toISOString());
    });

    await t.test('rotation of a legacy NULL-state OAuth row keeps the NULL shape', async () => {
      const service = serviceOn(migrator.database);
      const seeded = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
      const credentialId = `gate18a-credential-legacy-${randomUUID().slice(0, 8)}`;
      // A pre-#18a row: version chain present, all oauth_* columns NULL.
      const context = createProviderCredentialContext({
        ownerKind: 'tenant',
        tenantId: seeded.tenantId as string,
        supplyMode: 'byok',
        deployment: DEPLOYMENT,
        environment: ENVIRONMENT,
        purpose: 'inference',
        ...OAUTH_PRODUCT,
        accountId: seeded.accountId,
        credentialId,
        credentialVersion: 1,
      });
      const envelope = await sealProviderCredential(oauthMaterial(3600), context, sealingKms, 'software-local');
      await migrator.database.query(
        `INSERT INTO model_router_saas.saas_tenant_provider_credentials
           (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state)
         VALUES ($1, $2, $3, $4, $5, 'oauth', 'active', 'verified')`,
        [seeded.tenantId, credentialId, seeded.accountId, OAUTH_PRODUCT.providerId, OAUTH_PRODUCT.productId],
      );
      await migrator.database.query(
        `INSERT INTO model_router_saas.saas_tenant_provider_credential_versions
           (tenant_id, account_id, credential_id, version, schema_version, context_version, algorithm,
            kms_purpose, kms_key_id, wrapped_dek, nonce, ciphertext, auth_tag, status)
         VALUES ($1, $2, $3, 1, 1, 1, 'aes-256-gcm', 'inference', $4, $5, $6, $7, $8, 'active')`,
        [
          seeded.tenantId,
          seeded.accountId,
          credentialId,
          envelope.kmsKeyId,
          envelope.wrappedDek,
          envelope.nonce,
          envelope.ciphertext,
          envelope.authTag,
        ],
      );
      await migrator.database.query(
        `UPDATE model_router_saas.saas_tenant_provider_credentials
            SET current_version = 1 WHERE tenant_id = $1 AND id = $2`,
        [seeded.tenantId, credentialId],
      );
      const rotated = await service.replaceProviderCredentialSecretWithAudit(
        {
          credential: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId, credentialId },
          expectedVersion: 1,
          secret: oauthMaterial(7200),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      assert.equal(rotated.version.version, 2);
      const row = await readCredential(migrator.database, seeded, credentialId);
      assert.equal(row.current_version, 2);
      assert.equal(row.oauth_refresh_state, null);
      assert.equal(row.oauth_next_refresh_at, null);
      assert.equal(row.oauth_last_refresh_at, null);
      assert.equal(row.oauth_refresh_error_code, null);
      assert.equal(row.oauth_force_refresh_requested, false);
    });

    await t.test('assembly A: the control plane owns OAuth onboarding and idle-row rescheduling', async () => {
      const controlService = serviceOn(control.database);
      const controlRepository = new PostgresProviderSupplyRepository(control.database);
      // Non-OAuth creation on the control plane names no oauth column and
      // succeeds unchanged (the production customer/platform flow).
      const plain = await seedAccount(migrator.database, 'tenant', {
        providerId: 'anthropic',
        productId: 'claude-code',
        credentialType: 'api-key',
      });
      const plainId = `gate18a-credential-cp-apikey-${randomUUID().slice(0, 8)}`;
      await controlService.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: plain.tenantId, accountId: plain.accountId },
          id: plainId,
          secret: Buffer.from('gate18a-control-plane-api-key'),
        },
        { actorUserId: plain.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      const plainRow = await readCredential(migrator.database, plain, plainId);
      assert.equal(plainRow.oauth_refresh_state, null);

      // OAuth onboarding INSERT names oauth_refresh_state +
      // oauth_next_refresh_at: the assembly-A role template grants exactly
      // those two columns to the control plane, so the production CP
      // onboarding path succeeds and initializes idle plus the
      // first-refresh schedule.
      const seeded = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
      const oauthId = `gate18a-credential-cp-oauth-${randomUUID().slice(0, 8)}`;
      const created = await controlService.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId },
          id: oauthId,
          secret: oauthMaterial(3600),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      assert.equal(created.version.version, 1);
      const oauthRow = await readCredential(migrator.database, seeded, oauthId);
      assert.equal(oauthRow.oauth_refresh_state, 'idle');
      assert.equal(oauthRow.oauth_refresh_error_code, null);
      assert.equal(oauthRow.oauth_force_refresh_requested, false);
      assert.equal(oauthRow.oauth_last_refresh_at, null);
      assert.ok(oauthRow.oauth_next_refresh_at instanceof Date);
      assertDelayBand(
        oauthRow.created_at,
        oauthRow.oauth_next_refresh_at as Date,
        3600,
        'control-plane OAuth onboarding',
      );

      // An idle-row reschedule UPDATE names the oauth columns: granted to
      // the control plane as well. Pinned at the repository layer, exactly
      // the write the audited rotation entry performs for an idle/failed
      // row (current_version CAS plus the rescheduled oauth columns).
      const nowIso = new Date().toISOString();
      const rotationEnvelope = await sealProviderCredential(
        oauthMaterial(7200),
        createProviderCredentialContext({
          ownerKind: 'tenant',
          tenantId: seeded.tenantId as string,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          ...OAUTH_PRODUCT,
          accountId: seeded.accountId,
          credentialId: oauthId,
          credentialVersion: 2,
        }),
        sealingKms,
        'software-local',
      );
      await controlRepository.transaction((repository) =>
        repository.appendCredentialVersion({
          credential: {
            ownerKind: 'tenant',
            tenantId: seeded.tenantId,
            accountId: seeded.accountId,
            credentialId: oauthId,
            version: 2,
          },
          providerId: OAUTH_PRODUCT.providerId,
          productId: OAUTH_PRODUCT.productId,
          envelope: rotationEnvelope,
          kmsPurpose: 'inference',
          wrappingRevision: 1,
          expectedCurrentVersion: 1,
          oauthRefreshSchedule: { nextRefreshAt: nowIso },
          createdAt: nowIso,
          expiresAt: null,
        }),
      );
      const rescheduled = await readCredential(migrator.database, seeded, oauthId);
      assert.equal(rescheduled.current_version, 2);
      assert.equal(rescheduled.oauth_refresh_state, 'idle');
      assert.equal(rescheduled.oauth_refresh_error_code, null);
      assert.equal(rescheduled.oauth_force_refresh_requested, false);
      assert.equal(
        (rescheduled.oauth_next_refresh_at as Date).toISOString(),
        new Date(nowIso).toISOString(),
        'the idle row adopts the caller-supplied reschedule',
      );

      // The R4 rotation seam (row 'refreshing', claimed by the refresh
      // chain) names no oauth column: the control-plane rotation succeeds
      // and preserves the row.
      const refreshingId = `gate18a-credential-cp-refreshing-${randomUUID().slice(0, 8)}`;
      const migratorService = serviceOn(migrator.database);
      await migratorService.createProviderCredentialWithAudit(
        {
          account: { ownerKind: 'tenant', tenantId: seeded.tenantId, accountId: seeded.accountId },
          id: refreshingId,
          secret: oauthMaterial(3600),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      const claimStamp = '2026-09-28T00:00:01.000Z';
      await migrator.database.query(
        `UPDATE model_router_saas.saas_tenant_provider_credentials
            SET oauth_refresh_state = 'refreshing', oauth_last_refresh_at = $3
          WHERE tenant_id = $1 AND id = $2`,
        [seeded.tenantId, refreshingId, claimStamp],
      );
      const rotated = await controlService.replaceProviderCredentialSecretWithAudit(
        {
          credential: {
            ownerKind: 'tenant',
            tenantId: seeded.tenantId,
            accountId: seeded.accountId,
            credentialId: refreshingId,
          },
          expectedVersion: 1,
          secret: oauthMaterial(7200),
        },
        { actorUserId: seeded.operatorUserId, entryPoint: 'oauth-onboarding-gate' },
      );
      assert.equal(rotated.version.version, 2);
      const row = await readCredential(migrator.database, seeded, refreshingId);
      assert.equal(row.oauth_refresh_state, 'refreshing');
      assert.equal((row.oauth_last_refresh_at as Date).toISOString(), new Date(claimStamp).toISOString());
    });

    await t.test('the migration-094 shape CHECK rejects malformed oauth state', async () => {
      const seeded = await seedAccount(migrator.database, 'tenant', OAUTH_PRODUCT);
      for (const [label, fragment] of [
        ['state without schedule', `'idle', NULL`],
        ['schedule without state', `NULL, clock_timestamp()`],
      ] as const) {
        let rejected = false;
        try {
          await migrator.database.query(
            `INSERT INTO model_router_saas.saas_tenant_provider_credentials
               (tenant_id, id, account_id, provider_id, product_id, credential_type, status, validation_state,
                oauth_refresh_state, oauth_next_refresh_at)
             VALUES ($1, $2, $3, $4, $5, 'oauth', 'pending', 'unverified', ${fragment})`,
            [
              seeded.tenantId,
              `gate18a-credential-shape-${randomUUID().slice(0, 8)}`,
              seeded.accountId,
              OAUTH_PRODUCT.providerId,
              OAUTH_PRODUCT.productId,
            ],
          );
        } catch (error) {
          rejected = true;
          assert.equal(sqlState(error), '23514', `${label}: only a CHECK violation is accepted`);
        }
        assert.ok(rejected, `${label}: the shape CHECK must reject the row`);
      }
    });
  } finally {
    await Promise.allSettled([migrator.database.close(), control.database.close(), gateway.database.close()]);
  }
});
