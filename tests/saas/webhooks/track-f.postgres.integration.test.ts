import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/database.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { createWebhookSigningSecretProtector } from '../../../src/saas/runtime/software-provider-credential-kms.js';
import { CustomerWebhookEndpointService } from '../../../src/saas/webhooks/endpoint-service.js';
import { CUSTOMER_WEBHOOK_EVENT_TYPES } from '../../../src/saas/webhooks/events.js';
import { CustomerWebhookNotificationScanner } from '../../../src/saas/webhooks/notification-scanner.js';
import { PostgresCustomerWebhookDeliveryStore } from '../../../src/saas/webhooks/postgres-store.js';
import {
  type CustomerWebhookEventDrop,
  createCustomerWebhookEventProducer,
} from '../../../src/saas/webhooks/producers.js';
import { webhookSigningSecretAad } from '../../../src/saas/webhooks/signing-secret-protector.js';
import { CustomerWebhookTenantPolicyService } from '../../../src/saas/webhooks/tenant-policy-service.js';

/**
 * Track F acceptance evidence on a disposable, role-template PostgreSQL: every
 * customer-webhook flow runs as the restricted `model_router_saas_control_plane`
 * role against real DDL, proving the F1 protector round-trip, the F2
 * entitlement denial matrix, F3 producer/scanner persistence and idempotency,
 * and the F4 configure/replay/prune paths end to end.
 *
 * Required environment (scratch CI database):
 *   MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL  — control-plane role URL
 *   MODEL_ROUTER_SAAS_TEST_ADMIN_URL              — superuser URL for fixtures
 * Fixture rows use random identifiers per run; policies/events are immutable
 * by trigger, so the database must be disposable.
 */

const controlPlaneUrl = process.env.MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL;
const adminUrl = process.env.MODEL_ROUTER_SAAS_TEST_ADMIN_URL;
const skipReason =
  !controlPlaneUrl || !adminUrl
    ? 'set MODEL_ROUTER_SAAS_RUNTIME_PRIVILEGE_TEST_URL and MODEL_ROUTER_SAAS_TEST_ADMIN_URL for a disposable role-template database'
    : false;

const MASTER_KEY = 'ab'.repeat(32);

interface Fixture {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly operatorUserId: string;
  readonly projectId: string;
  readonly apiKeyId: string;
  readonly walletId: string;
}

async function seedFixture(admin: SaasDatabase): Promise<Fixture> {
  const tenantId = randomUUID();
  const ownerUserId = randomUUID();
  const operatorUserId = randomUUID();
  const projectId = randomUUID();
  const apiKeyId = randomUUID();
  const entitlementId = randomUUID();
  const walletId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const apiKeyExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  await admin.query(`INSERT INTO model_router_saas.saas_users (id, email) VALUES ($1, $2), ($3, $4)`, [
    ownerUserId,
    `track-f-owner-${suffix}@example.test`,
    operatorUserId,
    `track-f-ops-${suffix}@example.test`,
  ]);
  await admin.query(`INSERT INTO model_router_saas.saas_tenants (id, name, slug) VALUES ($1, $2, $3)`, [
    tenantId,
    `Track F Evidence ${suffix}`,
    `track-f-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO model_router_saas.saas_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenantId, ownerUserId],
  );
  await admin.query(
    `INSERT INTO model_router_saas.saas_platform_role_assignments (user_id, role) VALUES ($1, 'operations')`,
    [operatorUserId],
  );
  await admin.query(`INSERT INTO model_router_saas.saas_projects (tenant_id, id, name, slug) VALUES ($1, $2, $3, $4)`, [
    tenantId,
    projectId,
    'Track F',
    `track-f-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO model_router_saas.saas_project_memberships (tenant_id, project_id, user_id, role)
     VALUES ($1, $2, $3, 'admin')`,
    [tenantId, projectId, ownerUserId],
  );
  await admin.query(
    `INSERT INTO model_router_saas.saas_supply_profiles (tenant_id, id, supply_mode, model_scopes)
     VALUES ($1, $2, 'platform', $3::text[])`,
    [tenantId, `profile-${suffix}`, ['model-a']],
  );
  await admin.query(
    `INSERT INTO model_router_saas.saas_project_entitlements
       (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes)
     VALUES ($1, $2, $3, $4, 'platform', $5::text[])`,
    [entitlementId, tenantId, projectId, `profile-${suffix}`, ['model-a']],
  );
  await admin.query(
    `INSERT INTO model_router_saas.saas_wallets (id, tenant_id, currency, posted_balance_minor_units)
     VALUES ($1, $2, 'USD', 400)`,
    [walletId, tenantId],
  );
  await admin.query(
    `INSERT INTO model_router_saas.saas_api_keys
       (id, tenant_id, project_id, principal_user_id, supply_profile_id, supply_mode, name, prefix, key_hash,
        model_scopes, execution_principal_type, execution_principal_id, created_by_user_id, entitlement_id,
        model_scope_version, entitlement_authz_version, supply_profile_authz_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'platform', $6, $7, $8, $9::text[], 'member', $4, $4, $10, 1, 1, 1, $11)`,
    [
      apiKeyId,
      tenantId,
      projectId,
      ownerUserId,
      `profile-${suffix}`,
      `track-f-key-${suffix}`,
      `mr_live_${suffix}`,
      `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
      ['model-a'],
      entitlementId,
      apiKeyExpiresAt,
    ],
  );
  return { tenantId, ownerUserId, operatorUserId, projectId, apiKeyId, walletId };
}

test('track F customer webhook evidence on the restricted control-plane role', { skip: skipReason }, async (t) => {
  if (!controlPlaneUrl || !adminUrl) return;
  // The superuser fixture role lacks the role-template search_path; pin it so
  // schema-unqualified trigger bodies (e.g. saas_assign_default_project) resolve.
  const adminSearchPath = 'options=-c%20search_path%3Dmodel_router_saas%2Cpublic';
  const adminUrlWithSearchPath = `${adminUrl}${adminUrl.includes('?') ? '&' : '?'}${adminSearchPath}`;
  const admin = createSaasDatabase({ connectionString: adminUrlWithSearchPath, max: 2 });
  const controlPlane = createSaasDatabase({ connectionString: controlPlaneUrl, max: 2 });
  try {
    const identity = await controlPlane.query<{ current_user: string }>('SELECT current_user');
    assert.equal(identity.rows[0]?.current_user, 'model_router_saas_control_plane');
    const fixture = await seedFixture(admin);
    const protector = createWebhookSigningSecretProtector({
      env: { MODEL_ROUTER_SAAS_SOFTWARE_KMS_MASTER_KEY: MASTER_KEY },
    });
    const store = new PostgresCustomerWebhookDeliveryStore(controlPlane);
    const ownerActor = {
      tenantId: fixture.tenantId,
      actorUserId: fixture.ownerUserId,
      requestId: `track-f-${randomUUID()}`,
    };

    await t.test('F4 configure seeds migration defaults under the restricted role', async () => {
      const policies = new CustomerWebhookTenantPolicyService(controlPlane);
      const policy = await policies.configure(
        { actorUserId: fixture.operatorUserId, requestId: `track-f-configure-${randomUUID()}` },
        fixture.tenantId,
        { enabled: true, maxActiveEndpoints: 5, maxEventsPerMinute: 600, maxPendingDeliveries: 5000 },
      );
      assert.deepEqual(policy, {
        tenantId: fixture.tenantId,
        enabled: true,
        maxActiveEndpoints: 5,
        maxEventsPerMinute: 600,
        maxPendingDeliveries: 5000,
        revision: 1,
        updatedAt: policy.updatedAt,
      });
      const seeded = await controlPlane.query<{ allowed_event_types: unknown; threshold: unknown }>(
        `SELECT allowed_event_types, low_balance_threshold_minor_units AS threshold
         FROM saas_customer_webhook_tenant_policies WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      const seededTypes = seeded.rows[0]?.allowed_event_types;
      assert.ok(Array.isArray(seededTypes));
      assert.deepEqual([...seededTypes].sort(), [...CUSTOMER_WEBHOOK_EVENT_TYPES].sort());
      assert.equal(seeded.rows[0]?.threshold, null);
      // The entitlement whitelist and threshold are never writable by the runtime role.
      await assert.rejects(
        controlPlane.query(
          `UPDATE saas_customer_webhook_tenant_policies SET low_balance_threshold_minor_units = 1000 WHERE tenant_id = $1`,
          [fixture.tenantId],
        ),
      );
      await admin.query(
        `UPDATE model_router_saas.saas_customer_webhook_tenant_policies
         SET low_balance_threshold_minor_units = 1000 WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
    });

    await t.test('F1 protector round-trip: endpoint secrets persist only as envelopes', async () => {
      const endpoints = new CustomerWebhookEndpointService(controlPlane, protector);
      const created = await endpoints.createEndpoint(ownerActor, {
        targetUrl: 'https://hooks.example.test/track-f',
        eventTypes: ['wallet.low_balance', 'api_key.expiring'],
      });
      assert.equal(created.signingSecretVersion, 1);
      const stored = await controlPlane.query<{ envelope: unknown }>(
        `SELECT encrypted_envelope AS envelope FROM saas_customer_webhook_signing_secrets
         WHERE tenant_id = $1 AND endpoint_id = $2 AND secret_version = 1`,
        [fixture.tenantId, created.endpoint.endpointId],
      );
      const envelope = stored.rows[0]?.envelope;
      assert.ok(envelope instanceof Uint8Array || Buffer.isBuffer(envelope));
      const envelopeBytes = Buffer.from(envelope as Uint8Array);
      assert.equal(envelopeBytes.includes(Buffer.from(created.signingSecret, 'utf8')), false);
      const roundTrip = await protector.unprotect(
        envelopeBytes,
        webhookSigningSecretAad({
          tenantId: fixture.tenantId,
          endpointId: created.endpoint.endpointId,
          secretVersion: 1,
        }),
      );
      assert.equal(Buffer.from(roundTrip).toString('utf8'), created.signingSecret);
      // AAD binding: a foreign endpoint context must fail closed.
      await assert.rejects(
        protector.unprotect(
          envelopeBytes,
          webhookSigningSecretAad({
            tenantId: fixture.tenantId,
            endpointId: randomUUID(),
            secretVersion: 1,
          }),
        ),
      );
    });

    await t.test('F2 entitlement denial matrix drops without persisting', async () => {
      const drops: CustomerWebhookEventDrop[] = [];
      const producer = createCustomerWebhookEventProducer({ onEventDropped: (drop) => drops.push(drop) });
      const input = {
        tenantId: fixture.tenantId,
        currency: 'USD',
        balanceMinorUnits: 400,
        thresholdMinorUnits: 1000,
        occurredAt: new Date().toISOString(),
        transitionRef: 'matrix',
      };
      // Whitelist without wallet.low_balance denies even while enabled.
      await admin.query(
        `UPDATE model_router_saas.saas_customer_webhook_tenant_policies
         SET allowed_event_types = ARRAY['api_key.expiring']::text[] WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      await controlPlane.transaction((tx) => producer.walletLowBalance(tx, input));
      // A disabled policy denies regardless of whitelist.
      await admin.query(
        `UPDATE model_router_saas.saas_customer_webhook_tenant_policies
         SET enabled = FALSE, allowed_event_types = ARRAY['wallet.low_balance']::text[] WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      await controlPlane.transaction((tx) => producer.walletLowBalance(tx, input));
      assert.deepEqual(
        drops.map((drop) => drop.code),
        ['WEBHOOK_ENTITLEMENT_DENIED', 'WEBHOOK_ENTITLEMENT_DENIED'],
      );
      const persisted = await controlPlane.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_customer_webhook_events WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      assert.equal(persisted.rows[0]?.count, '0');
      await admin.query(
        `UPDATE model_router_saas.saas_customer_webhook_tenant_policies
         SET enabled = TRUE, allowed_event_types = ARRAY['wallet.low_balance', 'api_key.expiring']::text[]
         WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
    });

    let endpointId = '';
    await t.test('F3 producer enqueue persists event and deliveries atomically with idempotent replay', async () => {
      const endpoints = new CustomerWebhookEndpointService(controlPlane, protector);
      endpointId = (
        await endpoints.createEndpoint(ownerActor, {
          targetUrl: 'https://hooks.example.test/track-f-2',
          eventTypes: ['wallet.low_balance', 'api_key.expiring'],
        })
      ).endpoint.endpointId;
      const producer = createCustomerWebhookEventProducer();
      const input = {
        tenantId: fixture.tenantId,
        currency: 'USD',
        balanceMinorUnits: 400,
        thresholdMinorUnits: 1000,
        occurredAt: '2026-10-10T00:00:00.000Z',
        transitionRef: 'evidence',
      };
      await controlPlane.transaction((tx) => producer.walletLowBalance(tx, input));
      await controlPlane.transaction((tx) => producer.walletLowBalance(tx, input));
      // One event, fanned out to both subscribed endpoints, replayed clean.
      const events = await controlPlane.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_customer_webhook_events WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      assert.equal(events.rows[0]?.count, '1');
      const deliveries = await controlPlane.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_customer_webhook_deliveries WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      assert.equal(deliveries.rows[0]?.count, '2');
    });

    await t.test('F3 scanner emits bucketed events once; a moved balance conflicts into a skip', async () => {
      const scanner = new CustomerWebhookNotificationScanner(controlPlane, createCustomerWebhookEventProducer());
      // runOnce counts are global while this disposable database accumulates
      // fixtures from repeated runs, so the fixture-scoped facts come from the
      // events table; the aggregate counters only prove failure-freedom and
      // the conflict-skip path.
      const eventsByType = async (): Promise<Record<string, number>> => {
        const rows = await controlPlane.query<{ event_type: string; count: string }>(
          `SELECT event_type, count(*)::text AS count FROM saas_customer_webhook_events
           WHERE tenant_id = $1 GROUP BY event_type`,
          [fixture.tenantId],
        );
        return Object.fromEntries(rows.rows.map((row) => [row.event_type, Number(row.count)]));
      };
      const before = await eventsByType();
      const first = await scanner.runOnce();
      assert.equal(first.failed, 0);
      assert.ok(first.lowBalanceEmitted >= 1, 'wallet below the configured threshold emits');
      assert.ok(first.expiringKeysEmitted >= 1, 'key inside the expiry window emits');
      const afterFirst = await eventsByType();
      assert.equal(afterFirst['api_key.expiring'], (before['api_key.expiring'] ?? 0) + 1);
      assert.equal(afterFirst['wallet.low_balance'], (before['wallet.low_balance'] ?? 0) + 1);
      // Same day-bucket and band, moved balance: the stored payload differs, so
      // the bucketed idempotency key conflicts and the sweep skips the row. The
      // wallet projection is guarded: balances move only inside a ledger
      // transaction with the projection-write GUCs pinned.
      await admin.transaction(async (tx) => {
        const ledgerId = randomUUID();
        await tx.query(
          `INSERT INTO model_router_saas.saas_ledger_transactions
             (id, tenant_id, currency, idempotency_namespace, business_key, source_type,
              amount_minor_units, metadata_ref, price_snapshot_ref, usage_evidence_ref)
           VALUES ($1, $2, 'USD', 'track-f-evidence', $3, 'billing_settlement', 50, $4, $5, $6)`,
          [
            ledgerId,
            fixture.tenantId,
            `scanner-drift-${randomUUID()}`,
            `track-f-${randomUUID()}`,
            `price-${randomUUID()}`,
            `usage-${randomUUID()}`,
          ],
        );
        await tx.query(
          `INSERT INTO model_router_saas.saas_ledger_entries
             (id, transaction_id, tenant_id, currency, direction, amount_minor_units, account_type, account_ref, wallet_id)
           VALUES
             ($1, $2, $3, 'USD', 'debit', 50, 'wallet', $4, $5),
             ($6, $2, $3, 'USD', 'credit', 50, 'billing_revenue', $7, NULL)`,
          [
            randomUUID(),
            ledgerId,
            fixture.tenantId,
            fixture.walletId,
            fixture.walletId,
            randomUUID(),
            `track-f-revenue-${randomUUID()}`,
          ],
        );
        await tx.query(`SELECT set_config('saas.billing_ledger_projection_write', 'on', true)`);
        await tx.query(`SELECT set_config('saas.billing_ledger_transaction_id', $1, true)`, [ledgerId]);
        await tx.query(
          `UPDATE model_router_saas.saas_wallets SET posted_balance_minor_units = 350 WHERE tenant_id = $1`,
          [fixture.tenantId],
        );
      });
      const second = await scanner.runOnce();
      assert.equal(second.failed, 0);
      assert.ok(second.lowBalanceSkipped >= 1, 'in-band balance drift conflicts into a skip');
      // api_key.expiring anchors occurred_at to the deterministic window entry,
      // so the sweep replay matches byte-for-byte and adds no row either.
      assert.deepEqual(await eventsByType(), afterFirst);
    });

    await t.test('F4 dead-letter replay re-queues exactly once under quota accounting', async () => {
      const delivery = await admin.query<{ id: string }>(
        `SELECT id FROM model_router_saas.saas_customer_webhook_deliveries
         WHERE tenant_id = $1 AND endpoint_id = $2 ORDER BY created_at ASC LIMIT 1`,
        [fixture.tenantId, endpointId],
      );
      const deliveryId = delivery.rows[0]?.id;
      assert.ok(deliveryId);
      await admin.query(
        `UPDATE model_router_saas.saas_customer_webhook_deliveries
         SET state = 'dead_lettered', last_error_code = 'ATTEMPTS_EXHAUSTED'
         WHERE tenant_id = $1 AND id = $2`,
        [fixture.tenantId, deliveryId],
      );
      const replayed = await store.replayDeadLetter(ownerActor, deliveryId);
      assert.equal(replayed, true);
      const state = await controlPlane.query<{ state: string; replay_count: number }>(
        `SELECT state, replay_count FROM saas_customer_webhook_deliveries WHERE tenant_id = $1 AND id = $2`,
        [fixture.tenantId, deliveryId],
      );
      assert.deepEqual(state.rows[0], { state: 'pending', replay_count: 1 });
      // A non-dead-lettered delivery is not replayable.
      assert.equal(await store.replayDeadLetter(ownerActor, deliveryId), false);
      // Three events fanned out to two endpoints (6 pending) plus the replay reservation.
      const usage = await controlPlane.query<{ pending: string }>(
        `SELECT pending_deliveries::text AS pending FROM saas_customer_webhook_tenant_usage WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      assert.equal(usage.rows[0]?.pending, '7');
    });

    await t.test('F4 retention pruning deletes terminal metadata but never event facts', async () => {
      const terminal = await admin.query<{ id: string }>(
        `SELECT id FROM model_router_saas.saas_customer_webhook_deliveries
         WHERE tenant_id = $1 AND state = 'pending' ORDER BY created_at ASC LIMIT 1`,
        [fixture.tenantId],
      );
      const deliveryId = terminal.rows[0]?.id;
      assert.ok(deliveryId);
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      await admin.query(
        `UPDATE model_router_saas.saas_customer_webhook_deliveries
         SET state = 'delivered', delivered_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
        [fixture.tenantId, deliveryId, old],
      );
      const pruned = await store.pruneTerminalHistory({
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        limit: 100,
      });
      assert.equal(pruned.deliveries, 1);
      const remaining = await controlPlane.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_customer_webhook_deliveries
         WHERE tenant_id = $1 AND id = $2`,
        [fixture.tenantId, deliveryId],
      );
      assert.equal(remaining.rows[0]?.count, '0');
      const events = await controlPlane.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_customer_webhook_events WHERE tenant_id = $1`,
        [fixture.tenantId],
      );
      assert.equal(events.rows[0]?.count, '3', 'event facts and idempotency tombstones survive pruning');
    });
  } finally {
    await controlPlane.close();
    await admin.close();
  }
});
