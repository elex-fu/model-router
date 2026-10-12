import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  MarketingAnnouncementError,
  type MarketingAnnouncementEventPort,
  MarketingAnnouncementService,
} from '../../../src/saas/marketing/announcements.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// G4 real-PG gate: marketing announcements (migration 092) under the
// preprovisioned restricted roles. The full ops lifecycle (draft -> publish
// -> withdraw) and the customer read path run through the control-plane
// role; the publish event port is exercised inside the real transaction.
// No bootstrap, HTTP fixture, migrations, DDL or role changes; the fixture
// authority seeds only the identity rows the flow needs.

interface Seed {
  actorUserId: string;
  tenantId: string;
  userId: string;
}

async function seedIdentities(migrator: SaasDatabase, label: string): Promise<Seed> {
  const actorUserId = randomUUID();
  const userId = randomUUID();
  const tenantId = randomUUID();
  await migrator.query(
    `INSERT INTO model_router_saas.saas_users (id, email, password_hash, display_name, created_at, updated_at)
     VALUES ($1, $2, 'x', 'g4-actor', now(), now()), ($3, $4, 'x', 'g4-user', now(), now())`,
    [actorUserId, `g4-actor-${label}@example.invalid`, userId, `g4-user-${label}@example.invalid`],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_tenants (id, name, slug, status, created_at, updated_at)
     VALUES ($1, 'g4-tenant', $2, 'active', now(), now())`,
    [tenantId, `g4-tenant-${label}`],
  );
  return { actorUserId, tenantId, userId };
}

class RecordingEventPort implements MarketingAnnouncementEventPort {
  readonly calls: Array<{ announcementId: string; kind: string; severity: string; inTransaction: boolean }> = [];

  async announcementPublished(
    executor: SqlExecutor,
    event: { announcementId: string; kind: string; severity: string },
  ): Promise<void> {
    // A live query through the handed-over executor proves the port runs
    // inside the publish transaction on the same connection.
    const probe = await executor.query<{ one: number }>('SELECT 1 AS one');
    this.calls.push({
      announcementId: event.announcementId,
      kind: event.kind,
      severity: event.severity,
      inTransaction: probe.rows[0]?.one === 1,
    });
  }
}

test('G4 marketing announcements run end-to-end under the restricted control-plane role', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require G4-092`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const seed = await seedIdentities(migrator.database, randomUUID().slice(0, 8));
  const events = new RecordingEventPort();
  const service = new MarketingAnnouncementService({ database: control.database, events });
  try {
    await t.test('draft, publish, visibility, read receipts, CAS and withdraw lifecycle', async () => {
      const draft = await service.createDraft(
        { userId: seed.actorUserId },
        {
          kind: 'maintenance',
          severity: 'critical',
          title: 'G4 scratch maintenance window',
          body: 'Control plane read-only during the window.',
          publishAt: new Date(Date.now() - 60_000).toISOString(),
        },
      );
      assert.equal(draft.status, 'draft');
      assert.equal(draft.version, 1);

      // Drafts are invisible to customers.
      const beforePublish = await service.listPublished({ tenantId: seed.tenantId, userId: seed.userId });
      assert.equal(beforePublish.announcements.length, 0);

      const published = await service.publish({ userId: seed.actorUserId }, draft.id, 1);
      assert.equal(published.status, 'published');
      assert.equal(published.version, 2);
      assert.equal(events.calls.length, 1, 'the publish transition fires the event port exactly once');
      assert.deepEqual(events.calls[0], {
        announcementId: draft.id,
        kind: 'maintenance',
        severity: 'critical',
        inTransaction: true,
      });

      // Stale CAS and repeated transitions conflict; the event never re-fires.
      await assert.rejects(
        service.publish({ userId: seed.actorUserId }, draft.id, 1),
        (error: unknown) =>
          error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_VERSION_CONFLICT',
      );
      await assert.rejects(
        service.publish({ userId: seed.actorUserId }, draft.id, 2),
        (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_STATE_CONFLICT',
      );
      assert.equal(events.calls.length, 1);

      const listed = await service.listPublished({ tenantId: seed.tenantId, userId: seed.userId });
      assert.equal(listed.announcements.length, 1);
      assert.equal(listed.announcements[0]?.id, draft.id);
      assert.equal(listed.announcements[0]?.readAt, null);

      const marked = await service.markRead({ tenantId: seed.tenantId, userId: seed.userId }, draft.id);
      assert.equal(marked.outcome, 'marked');
      const replayed = await service.markRead({ tenantId: seed.tenantId, userId: seed.userId }, draft.id);
      assert.equal(replayed.outcome, 'already_read');
      assert.equal(replayed.readAt, marked.readAt);
      const receiptCount = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_marketing_announcement_reads
          WHERE announcement_id = $1`,
        [draft.id],
      );
      assert.equal(receiptCount.rows[0]?.count, '1', 'duplicate reads never duplicate the receipt');

      const afterRead = await service.listPublished({ tenantId: seed.tenantId, userId: seed.userId });
      assert.equal(afterRead.announcements[0]?.readAt, marked.readAt);

      // The ops audit trail carries create + publish + withdraw in order.
      const withdrawn = await service.withdraw({ userId: seed.actorUserId }, draft.id, 2);
      assert.equal(withdrawn.status, 'withdrawn');
      assert.equal(withdrawn.version, 3);
      const audit = await migrator.database.query<{ action: string }>(
        `SELECT action FROM model_router_saas.saas_audit_events
          WHERE target_type = 'marketing_announcement' AND target_id = $1 ORDER BY occurred_at, id`,
        [draft.id],
      );
      assert.deepEqual(
        audit.rows.map((row) => row.action),
        ['marketing.announcement.created', 'marketing.announcement.published', 'marketing.announcement.withdrawn'],
      );
      const afterWithdraw = await service.listPublished({ tenantId: seed.tenantId, userId: seed.userId });
      assert.equal(afterWithdraw.announcements.length, 0, 'withdrawn announcements leave the customer surface');
      assert.equal(events.calls.length, 1, 'withdraw never re-fires the publish event');
    });

    await t.test('gateway role has zero announcement privileges and the runtime probe covers the grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await assert.rejects(
        gateway.database.query(`SELECT id FROM model_router_saas.saas_marketing_announcements LIMIT 1`, []),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        gateway.database.query(
          `INSERT INTO model_router_saas.saas_marketing_announcement_reads (announcement_id, user_id, tenant_id)
             VALUES ($1, $2, $3)`,
          [randomUUID(), seed.userId, seed.tenantId],
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
