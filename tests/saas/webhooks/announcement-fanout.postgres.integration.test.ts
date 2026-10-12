import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { MarketingAnnouncementService } from '../../../src/saas/marketing/announcements.js';
import { createWebhookSigningSecretProtector } from '../../../src/saas/runtime/software-provider-credential-kms.js';
import {
  AnnouncementFanoutWorker,
  createAnnouncementFanoutEventPort,
} from '../../../src/saas/webhooks/announcement-fanout-worker.js';
import { CustomerWebhookEndpointService } from '../../../src/saas/webhooks/endpoint-service.js';
import { createCustomerWebhookEventProducer } from '../../../src/saas/webhooks/producers.js';
import { CustomerWebhookTenantPolicyService } from '../../../src/saas/webhooks/tenant-policy-service.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// R8/G4.5 real-PG gate: the announcement fan-out worker under the
// preprovisioned restricted roles. Two tenants seed the entitlement matrix —
// one enabled + platform.maintenance whitelist + active subscribed endpoint,
// one enabled without the whitelist — plus a third whitelisted tenant with
// no endpoint at all. Publish leaves fanout_completed_at NULL; one sweep
// enqueues exactly the entitled tenant's durable event (idempotency key
// announcement:<id>:<tenant>), completes the cursor, and a rescan adds
// nothing. A withdrawn announcement never fans out. The gateway role keeps
// zero privileges and the runtime privilege probe covers the grants.
// No bootstrap, HTTP fixture, migrations, DDL or role changes; the fixture
// authority seeds only the identity rows the flow needs.

const MASTER_KEY = 'ab'.repeat(32);

interface Seed {
  readonly operatorUserId: string;
  readonly entitledTenantId: string;
  readonly entitledOwnerUserId: string;
  readonly unlistedTenantId: string;
  readonly endpointlessTenantId: string;
}

async function seedIdentities(migrator: SaasDatabase, label: string): Promise<Seed> {
  const operatorUserId = randomUUID();
  const entitledTenantId = randomUUID();
  const entitledOwnerUserId = randomUUID();
  const unlistedTenantId = randomUUID();
  const endpointlessTenantId = randomUUID();
  const unlistedOwnerUserId = randomUUID();
  const endpointlessOwnerUserId = randomUUID();
  await migrator.query(
    `INSERT INTO model_router_saas.saas_users (id, email, password_hash, display_name, created_at, updated_at)
     VALUES ($1, $2, 'x', 'g45-ops', now(), now()),
            ($3, $4, 'x', 'g45-owner-a', now(), now()),
            ($5, $6, 'x', 'g45-owner-b', now(), now()),
            ($7, $8, 'x', 'g45-owner-c', now(), now())`,
    [
      operatorUserId,
      `g45-ops-${label}@example.invalid`,
      entitledOwnerUserId,
      `g45-owner-a-${label}@example.invalid`,
      unlistedOwnerUserId,
      `g45-owner-b-${label}@example.invalid`,
      endpointlessOwnerUserId,
      `g45-owner-c-${label}@example.invalid`,
    ],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_tenants (id, name, slug, status, created_at, updated_at)
     VALUES ($1, 'g45-entitled', $2, 'active', now(), now()),
            ($3, 'g45-unlisted', $4, 'active', now(), now()),
            ($5, 'g45-endpointless', $6, 'active', now(), now())`,
    [
      entitledTenantId,
      `g45-entitled-${label}`,
      unlistedTenantId,
      `g45-unlisted-${label}`,
      endpointlessTenantId,
      `g45-endpointless-${label}`,
    ],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($5, $6, 'owner')`,
    [
      entitledTenantId,
      entitledOwnerUserId,
      unlistedTenantId,
      unlistedOwnerUserId,
      endpointlessTenantId,
      endpointlessOwnerUserId,
    ],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_platform_role_assignments (user_id, role) VALUES ($1, 'operations')`,
    [operatorUserId],
  );
  return { operatorUserId, entitledTenantId, entitledOwnerUserId, unlistedTenantId, endpointlessTenantId };
}

test('G4.5 announcement fan-out runs end-to-end under the restricted control-plane role', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require G4.5-095`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const label = randomUUID().replaceAll('-', '').slice(0, 12);
  const seed = await seedIdentities(migrator.database, label);
  const protector = createWebhookSigningSecretProtector({
    env: { MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: MASTER_KEY },
  });
  try {
    // Entitlement matrix: configure seeds the full whitelist for every
    // tenant; the unlisted tenant's whitelist is then narrowed without
    // platform.maintenance; the endpointless tenant keeps the whitelist but
    // never gets an endpoint.
    const policies = new CustomerWebhookTenantPolicyService(control.database);
    for (const tenantId of [seed.entitledTenantId, seed.unlistedTenantId, seed.endpointlessTenantId]) {
      await policies.configure(
        { actorUserId: seed.operatorUserId, requestId: `g45-configure-${randomUUID()}` },
        tenantId,
        { enabled: true, maxActiveEndpoints: 5, maxEventsPerMinute: 600, maxPendingDeliveries: 5000 },
      );
    }
    await migrator.database.query(
      `UPDATE model_router_saas.saas_customer_webhook_tenant_policies
       SET allowed_event_types = ARRAY['wallet.low_balance']::text[] WHERE tenant_id = $1`,
      [seed.unlistedTenantId],
    );
    const endpoints = new CustomerWebhookEndpointService(control.database, protector);
    await endpoints.createEndpoint(
      { tenantId: seed.entitledTenantId, actorUserId: seed.entitledOwnerUserId, requestId: `g45-${randomUUID()}` },
      { targetUrl: 'https://hooks.example.test/g45', eventTypes: ['platform.maintenance'] },
    );

    const announcements = new MarketingAnnouncementService({
      database: control.database,
      events: createAnnouncementFanoutEventPort(),
    });
    const worker = new AnnouncementFanoutWorker(control.database, announcements, createCustomerWebhookEventProducer());

    let announcementId = '';
    await t.test('publish leaves the fan-out cursor open and the port stays a no-op', async () => {
      const draft = await announcements.createDraft(
        { userId: seed.operatorUserId },
        {
          kind: 'maintenance',
          severity: 'critical',
          title: 'G4.5 scratch maintenance window',
          body: 'Control plane read-only during the window.',
          publishAt: new Date(Date.now() - 60_000).toISOString(),
        },
      );
      const published = await announcements.publish({ userId: seed.operatorUserId }, draft.id, 1);
      assert.equal(published.status, 'published');
      announcementId = published.id;
      const cursor = await control.database.query<{ fanout_completed_at: unknown }>(
        `SELECT fanout_completed_at FROM model_router_saas.saas_marketing_announcements WHERE id = $1`,
        [announcementId],
      );
      assert.equal(cursor.rows[0]?.fanout_completed_at, null, 'publish never fans out inline (O(1))');
    });

    await t.test('one sweep enqueues only the entitled tenant, then completes the cursor', async () => {
      const outcome = await worker.runOnce();
      assert.equal(outcome.announcementsFailed, 0);
      const events = await control.database.query<{
        event_type: string;
        idempotency_key: string;
        occurred_at: Date;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_type, idempotency_key, occurred_at, payload
         FROM model_router_saas.saas_customer_webhook_events
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [seed.entitledTenantId, `announcement:${announcementId}:${seed.entitledTenantId}`],
      );
      assert.equal(events.rows.length, 1, 'exactly one durable event for the entitled tenant');
      const event = events.rows[0]!;
      assert.equal(event.event_type, 'platform.maintenance');
      const announcement = await control.database.query<{ publish_at: Date; title: string; body: string }>(
        `SELECT publish_at, title, body FROM model_router_saas.saas_marketing_announcements WHERE id = $1`,
        [announcementId],
      );
      assert.equal(event.occurred_at.toISOString(), announcement.rows[0]!.publish_at.toISOString());
      assert.deepEqual(event.payload, {
        announcement_id: announcementId,
        kind: 'maintenance',
        severity: 'critical',
        title: announcement.rows[0]!.title,
        body: announcement.rows[0]!.body,
        publish_at: announcement.rows[0]!.publish_at.toISOString(),
        unpublish_at: null,
      });
      const deliveries = await control.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_customer_webhook_deliveries
         WHERE tenant_id = $1 AND event_id = (SELECT event_id FROM model_router_saas.saas_customer_webhook_events
           WHERE tenant_id = $1 AND idempotency_key = $2)`,
        [seed.entitledTenantId, `announcement:${announcementId}:${seed.entitledTenantId}`],
      );
      assert.equal(deliveries.rows[0]?.count, '1', 'the active subscribed endpoint receives the delivery');
      for (const tenantId of [seed.unlistedTenantId, seed.endpointlessTenantId]) {
        const denied = await control.database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM model_router_saas.saas_customer_webhook_events WHERE tenant_id = $1`,
          [tenantId],
        );
        assert.equal(denied.rows[0]?.count, '0', 'non-entitled and endpoint-less tenants persist nothing');
      }
      const cursor = await control.database.query<{ fanout_completed_at: unknown; version: string }>(
        `SELECT fanout_completed_at, version::text AS version
         FROM model_router_saas.saas_marketing_announcements WHERE id = $1`,
        [announcementId],
      );
      assert.ok(cursor.rows[0]?.fanout_completed_at !== null, 'completion written after the full fan-out');
      assert.equal(cursor.rows[0]?.version, '3', 'the completion write bumps the version per the 092 guard');
    });

    await t.test('a rescan is a no-op and a withdrawn announcement never fans out', async () => {
      const countEvents = async (): Promise<number> => {
        const rows = await control.database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM model_router_saas.saas_customer_webhook_events
           WHERE tenant_id = ANY ($1::uuid[])`,
          [[seed.entitledTenantId, seed.unlistedTenantId, seed.endpointlessTenantId]],
        );
        return Number(rows.rows[0]?.count);
      };
      const before = await countEvents();
      const replay = await worker.runOnce();
      assert.equal(replay.announcementsFailed, 0);
      assert.equal(await countEvents(), before, 'idempotency keys absorb the rescan');

      const draft = await announcements.createDraft(
        { userId: seed.operatorUserId },
        {
          kind: 'info',
          severity: 'info',
          title: 'G4.5 withdrawn before sweep',
          body: 'Never fanned out.',
          publishAt: new Date(Date.now() - 30_000).toISOString(),
        },
      );
      await announcements.publish({ userId: seed.operatorUserId }, draft.id, 1);
      await announcements.withdraw({ userId: seed.operatorUserId }, draft.id, 2);
      const outcome = await worker.runOnce();
      assert.equal(outcome.announcementsFailed, 0);
      const leaked = await control.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_customer_webhook_events
         WHERE idempotency_key LIKE $1`,
        [`announcement:${draft.id}:%`],
      );
      assert.equal(leaked.rows[0]?.count, '0', 'withdrawn-before-scan announcements are never claimed');
    });

    await t.test('gateway role has zero privileges and the runtime probe covers the grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await assert.rejects(
        gateway.database.query(`SELECT id FROM model_router_saas.saas_marketing_announcements LIMIT 1`, []),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        gateway.database.query(
          `UPDATE model_router_saas.saas_marketing_announcements SET fanout_completed_at = now() WHERE id = $1`,
          [announcementId],
        ),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        gateway.database.query(
          `INSERT INTO model_router_saas.saas_marketing_announcement_reads (announcement_id, user_id, tenant_id)
             VALUES ($1, $2, $3)`,
          [announcementId, seed.entitledOwnerUserId, seed.entitledTenantId],
        ),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
    });
  } finally {
    await migrator.database.close();
    await control.database.close();
    await gateway.database.close();
  }
});
