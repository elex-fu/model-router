import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { MarketingAnnouncementService } from '../../../src/saas/marketing/announcements.js';
import {
  AnnouncementFanoutWorker,
  createAnnouncementFanoutEventPort,
} from '../../../src/saas/webhooks/announcement-fanout-worker.js';
import {
  type CustomerWebhookEventDrop,
  createCustomerWebhookEventProducer,
} from '../../../src/saas/webhooks/producers.js';

// R8/G4.5: the worker runs the REAL announcement service + REAL producer +
// REAL enqueue + REAL Postgres entitlement policy over a fake database,
// proving the due-claim predicate and ordering, the per-tenant idempotency
// key and payload, entitlement filtering and drop-swallowing, completion
// only after the full fan-out, crash-rescan dedup, and SKIP LOCKED
// exclusion between concurrent sweeps.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';
const ANN_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = '00000000-0000-4000-8000-0000000000a1';
const NOW = '2026-10-11T08:00:00.000Z';

interface AnnouncementRow extends Record<string, unknown> {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  publish_at: string;
  unpublish_at: string | null;
  status: string;
  version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  fanout_completed_at: string | null;
}

interface PolicyRow {
  enabled: boolean;
  allowed_event_types: string[];
}

interface EndpointRow {
  tenant_id: string;
  id: string;
  state: string;
  event_types: string[];
}

function announcementRow(overrides: Partial<AnnouncementRow> & { id: string }): AnnouncementRow {
  return {
    kind: 'maintenance',
    severity: 'warning',
    title: 'Routers upgrade',
    body: 'The control plane is read-only during the window.',
    publish_at: '2026-10-11T06:00:00.000Z',
    unpublish_at: null,
    status: 'published',
    version: 2,
    created_by_user_id: OPERATOR,
    created_at: '2026-10-10T06:00:00.000Z',
    updated_at: '2026-10-11T06:00:00.000Z',
    fanout_completed_at: null,
    ...overrides,
  };
}

function result<Row>(rows: Row[], rowCount = rows.length): SqlResult<Row> {
  return { rows, rowCount };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class FanoutDatabase implements SaasDatabase {
  readonly announcements: AnnouncementRow[] = [];
  readonly policies = new Map<string, PolicyRow>();
  readonly endpoints: EndpointRow[] = [];
  readonly events = new Map<string, { eventType: string; occurredAt: string; payload: unknown }>();
  readonly calls: string[] = [];
  readonly locked = new Set<string>();
  /** When set, the next claim query waits on this gate while holding its row locks. */
  claimGate: Promise<void> | null = null;
  /** Simulate a storage fault on the events INSERT for one tenant or one announcement. */
  failInsertForTenant: string | null = null;
  failInsertForAnnouncement: string | null = null;

  private dueAnnouncements(): AnnouncementRow[] {
    return this.announcements
      .filter((row) => row.status === 'published' && row.fanout_completed_at === null)
      .sort((a, b) =>
        a.publish_at === b.publish_at ? a.id.localeCompare(b.id) : a.publish_at.localeCompare(b.publish_at),
      );
  }

  private subscribedEndpointCount(tenantId: string, eventType: string): number {
    return this.endpoints.filter(
      (endpoint) =>
        endpoint.tenant_id === tenantId && endpoint.state === 'active' && endpoint.event_types.includes(eventType),
    ).length;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const statement = normalize(sql);
    this.calls.push(statement);
    if (statement.startsWith('SAVEPOINT') || statement.startsWith('RELEASE SAVEPOINT')) {
      return result([] as Row[], 0);
    }
    if (statement.startsWith('SELECT id, kind, severity, title, body, publish_at, unpublish_at, status, version')) {
      const limit = Number(values[0]);
      const claimed = this.dueAnnouncements()
        .filter((row) => !this.locked.has(row.id))
        .slice(0, limit);
      for (const row of claimed) this.locked.add(row.id);
      if (this.claimGate) {
        const gate = this.claimGate;
        this.claimGate = null;
        await gate;
      }
      return result(claimed as unknown as Row[]);
    }
    if (statement.startsWith('SELECT p.tenant_id FROM model_router_saas.saas_customer_webhook_tenant_policies p')) {
      const tenants = [...this.policies.entries()]
        .filter(
          ([tenantId, policy]) =>
            policy.enabled &&
            policy.allowed_event_types.includes('platform.maintenance') &&
            this.subscribedEndpointCount(tenantId, 'platform.maintenance') > 0,
        )
        .map(([tenantId]) => tenantId)
        .sort();
      return result(tenants.map((tenant_id) => ({ tenant_id })) as unknown as Row[]);
    }
    if (statement.startsWith('SELECT enabled, allowed_event_types')) {
      const policy = this.policies.get(String(values[0]));
      return result(
        (policy ? [{ enabled: policy.enabled, allowed_event_types: policy.allowed_event_types }] : []) as Row[],
      );
    }
    if (statement.startsWith('SELECT enabled, max_events_per_minute, max_pending_deliveries')) {
      const policy = this.policies.get(String(values[0]));
      return result(
        (policy
          ? [{ enabled: policy.enabled, max_events_per_minute: 600, max_pending_deliveries: 5000 }]
          : []) as Row[],
      );
    }
    if (statement.startsWith('SELECT count(*) AS target_count')) {
      const count = this.subscribedEndpointCount(String(values[0]), String(values[1]));
      return result([{ target_count: count }] as Row[]);
    }
    if (statement.startsWith('SELECT event_id, event_type')) {
      const stored = this.events.get(`${String(values[0])}:${String(values[1])}`);
      return result(
        (stored
          ? [
              {
                event_id: '99999999-9999-4999-8999-999999999999',
                event_type: stored.eventType,
                schema_version: 1,
                occurred_at: stored.occurredAt,
                payload: stored.payload,
                tenant_id: values[0],
                idempotency_key: values[1],
              },
            ]
          : []) as Row[],
      );
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_tenant_usage')) return result([] as Row[], 0);
    if (statement.startsWith('UPDATE saas_customer_webhook_tenant_usage')) return result([{}] as Row[], 1);
    if (statement.startsWith('INSERT INTO saas_customer_webhook_events')) {
      const [tenantId, eventId, key, eventType, occurredAt, payload] = values.map(String);
      if (this.failInsertForTenant === tenantId) throw new Error('simulated storage fault');
      if (this.failInsertForAnnouncement !== null && key.includes(this.failInsertForAnnouncement)) {
        throw new Error('simulated storage fault');
      }
      const mapKey = `${tenantId}:${key}`;
      if (this.events.has(mapKey)) return result([] as Row[], 0);
      this.events.set(mapKey, { eventType, occurredAt, payload: JSON.parse(payload) });
      return result([{ event_id: eventId }] as Row[]);
    }
    if (statement.startsWith('INSERT INTO saas_customer_webhook_deliveries')) {
      const count = this.subscribedEndpointCount(String(values[0]), String(values[2]));
      return result([] as Row[], count);
    }
    if (statement.startsWith('UPDATE model_router_saas.saas_marketing_announcements SET fanout_completed_at')) {
      const [id, now] = values.map(String);
      const row = this.announcements.find(
        (candidate) =>
          candidate.id === id && candidate.status === 'published' && candidate.fanout_completed_at === null,
      );
      if (!row) return result([] as Row[], 0);
      row.fanout_completed_at = now;
      row.version += 1;
      row.updated_at = now;
      return result([] as Row[], 1);
    }
    return result([] as Row[]);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const eventsSnapshot = new Map(this.events);
    const announcementsSnapshot = this.announcements.map((row) => ({ ...row }));
    try {
      return await work(this);
    } catch (error) {
      this.events.clear();
      for (const [key, value] of eventsSnapshot) this.events.set(key, value);
      this.announcements.splice(0, this.announcements.length, ...announcementsSnapshot);
      throw error;
    } finally {
      this.locked.clear();
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function createWorker(
  database: FanoutDatabase,
  options: {
    batchSize?: number;
    onEventDropped?: (drop: CustomerWebhookEventDrop) => void;
    onError?: (code: 'announcement_fanout_failed') => void;
    denyEntitlement?: boolean;
  } = {},
): AnnouncementFanoutWorker {
  const service = new MarketingAnnouncementService({ database, now: () => new Date(NOW) });
  const producer = createCustomerWebhookEventProducer({
    ...(options.onEventDropped ? { onEventDropped: options.onEventDropped } : {}),
    ...(options.denyEntitlement
      ? {
          entitlement: {
            assertEntitled: async () => {
              throw new Error('WEBHOOK_ENTITLEMENT_DENIED');
            },
          },
        }
      : {}),
  });
  return new AnnouncementFanoutWorker(database, service, producer, {
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}

function entitledTenant(database: FanoutDatabase, tenantId: string): void {
  database.policies.set(tenantId, { enabled: true, allowed_event_types: ['platform.maintenance'] });
  database.endpoints.push({
    tenant_id: tenantId,
    id: tenantId,
    state: 'active',
    event_types: ['platform.maintenance'],
  });
}

test('a due announcement fans out to every entitled tenant and completes exactly once', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(announcementRow({ id: ANN_1 }));
  entitledTenant(database, TENANT_A);
  entitledTenant(database, TENANT_B);
  // TENANT_C whitelists the event but has no active subscribed endpoint: skipped.
  database.policies.set(TENANT_C, { enabled: true, allowed_event_types: ['platform.maintenance'] });
  const worker = createWorker(database);

  const first = await worker.runOnce();
  assert.deepEqual(first, {
    announcementsClaimed: 1,
    announcementsCompleted: 1,
    tenantsEnqueued: 2,
    announcementsFailed: 0,
  });
  for (const tenantId of [TENANT_A, TENANT_B]) {
    const stored = database.events.get(`${tenantId}:announcement:${ANN_1}:${tenantId}`);
    assert.ok(stored, `event persisted for ${tenantId}`);
    assert.equal(stored.eventType, 'platform.maintenance');
    assert.equal(stored.occurredAt, '2026-10-11T06:00:00.000Z', 'occurred_at is the deterministic publish time');
    assert.deepEqual(stored.payload, {
      announcement_id: ANN_1,
      kind: 'maintenance',
      severity: 'warning',
      title: 'Routers upgrade',
      body: 'The control plane is read-only during the window.',
      publish_at: '2026-10-11T06:00:00.000Z',
      unpublish_at: null,
    });
  }
  assert.equal(database.events.size, 2, 'the endpoint-less tenant never persists an event');
  const row = database.announcements[0]!;
  assert.equal(row.fanout_completed_at, NOW);
  assert.equal(row.version, 3, 'the completion write bumps the version per the 092 guard');
  // The completion write is the last statement of the sweep.
  const completionIndex = database.calls.findLastIndex((statement) =>
    statement.startsWith('UPDATE model_router_saas.saas_marketing_announcements SET fanout_completed_at'),
  );
  const lastEventInsert = database.calls.findLastIndex((statement) =>
    statement.startsWith('INSERT INTO saas_customer_webhook_events'),
  );
  assert.ok(completionIndex > lastEventInsert, 'completion is written only after every tenant enqueue');

  const replay = await worker.runOnce();
  assert.deepEqual(replay, {
    announcementsClaimed: 0,
    announcementsCompleted: 0,
    tenantsEnqueued: 0,
    announcementsFailed: 0,
  });
  assert.equal(database.events.size, 2, 'a rescan of a completed announcement adds nothing');
});

test('drafts, withdrawn and already-fanned announcements are never claimed', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(
    announcementRow({ id: ANN_1, status: 'draft', version: 1 }),
    announcementRow({ id: ANN_2, status: 'withdrawn', version: 3 }),
    announcementRow({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      fanout_completed_at: '2026-10-11T07:00:00.000Z',
      version: 3,
    }),
  );
  entitledTenant(database, TENANT_A);
  const outcome = await createWorker(database).runOnce();
  assert.equal(outcome.announcementsClaimed, 0);
  assert.equal(database.events.size, 0);
});

test('the claim respects the batch bound and the (publish_at, id) order', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(
    announcementRow({ id: ANN_2, publish_at: '2026-10-11T05:00:00.000Z' }),
    announcementRow({ id: ANN_1, publish_at: '2026-10-11T05:00:00.000Z' }),
    announcementRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', publish_at: '2026-10-11T04:00:00.000Z' }),
  );
  entitledTenant(database, TENANT_A);
  const worker = createWorker(database, { batchSize: 2 });

  const first = await worker.runOnce();
  assert.equal(first.announcementsClaimed, 2);
  assert.equal(first.announcementsCompleted, 2);
  // Earlier publish_at first; the remaining announcement is next sweep's work.
  assert.equal(database.events.has(`${TENANT_A}:announcement:cccccccc-cccc-4ccc-8ccc-cccccccccccc:${TENANT_A}`), true);
  assert.equal(database.events.has(`${TENANT_A}:announcement:${ANN_1}:${TENANT_A}`), true);
  assert.equal(database.events.has(`${TENANT_A}:announcement:${ANN_2}:${TENANT_A}`), false);
  const second = await worker.runOnce();
  assert.equal(second.announcementsCompleted, 1);
  assert.equal(database.events.size, 3);
});

test('an entitlement race drops the tenant event without failing the fan-out', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(announcementRow({ id: ANN_1 }));
  entitledTenant(database, TENANT_A);
  const drops: CustomerWebhookEventDrop[] = [];
  const worker = createWorker(database, {
    denyEntitlement: true,
    onEventDropped: (drop) => drops.push(drop),
  });
  const outcome = await worker.runOnce();
  assert.equal(outcome.announcementsFailed, 0);
  assert.equal(outcome.announcementsCompleted, 1, 'C-5 drops never block completion');
  assert.equal(database.events.size, 0, 'denied events are never persisted');
  assert.deepEqual(
    drops.map((drop) => [drop.eventType, drop.tenantId, drop.code]),
    [['platform.maintenance', TENANT_A, 'WEBHOOK_ENTITLEMENT_DENIED']],
  );
});

test('a mid-fan-out fault leaves the announcement due and the rescan replays duplicate-free', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(announcementRow({ id: ANN_1 }));
  entitledTenant(database, TENANT_A);
  entitledTenant(database, TENANT_B);
  const errors: string[] = [];
  const worker = createWorker(database, { onError: (code) => errors.push(code) });

  database.failInsertForTenant = TENANT_B;
  const crashed = await worker.runOnce();
  assert.equal(crashed.announcementsFailed, 1);
  assert.equal(crashed.announcementsCompleted, 0, 'completion is never written after a partial fan-out');
  assert.deepEqual(errors, ['announcement_fanout_failed']);
  assert.equal(database.announcements[0]!.fanout_completed_at, null);
  assert.equal(database.events.size, 1, 'the first tenant commit survives (per-tenant transactions)');

  database.failInsertForTenant = null;
  const recovered = await worker.runOnce();
  assert.equal(recovered.announcementsFailed, 0);
  assert.equal(recovered.announcementsCompleted, 1);
  assert.equal(recovered.tenantsEnqueued, 2, 'both tenants are re-attempted');
  assert.equal(database.events.size, 2, 'the idempotency key absorbs the replay: zero duplicates');
  assert.equal(database.announcements[0]!.fanout_completed_at, NOW);
});

test('a tenant enqueue fault aborts the whole announcement, not the sweep', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(
    announcementRow({ id: ANN_1 }),
    announcementRow({ id: ANN_2, publish_at: '2026-10-11T07:00:00.000Z' }),
  );
  entitledTenant(database, TENANT_A);
  const worker = createWorker(database);

  // The entitlement set is announcement-independent; the fault is scoped to
  // ANN_1's idempotency keys so ANN_2 proves the sweep continues.
  database.failInsertForAnnouncement = ANN_1;
  const outcome = await worker.runOnce();
  assert.equal(outcome.announcementsFailed, 1, 'only the faulting announcement fails');
  assert.equal(outcome.announcementsCompleted, 1, 'the later announcement still completes');
  assert.equal(database.announcements[0]!.fanout_completed_at, null);
  assert.equal(database.announcements[1]!.fanout_completed_at, NOW);

  database.failInsertForAnnouncement = null;
  const recovered = await worker.runOnce();
  assert.equal(recovered.announcementsCompleted, 1);
  assert.equal(database.events.size, 2);
});

test('a withdraw between claim and completion refuses the completion write', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(announcementRow({ id: ANN_1 }));
  entitledTenant(database, TENANT_A);
  const worker = createWorker(database);
  const service = new MarketingAnnouncementService({ database, now: () => new Date(NOW) });

  // Claim in one transaction, withdraw before the worker's completion CAS.
  const claimed = await database.transaction((tx) => service.listDueFanouts(tx, 10));
  assert.equal(claimed.length, 1);
  database.announcements[0]!.status = 'withdrawn';
  const completed = await database.transaction((tx) => service.markFanoutCompleted(tx, ANN_1));
  assert.equal(completed, false, 'the CAS predicate excludes withdrawn announcements');
  void worker;
});

test('concurrent sweeps never claim the same announcement (SKIP LOCKED)', async () => {
  const database = new FanoutDatabase();
  database.announcements.push(announcementRow({ id: ANN_1 }));
  entitledTenant(database, TENANT_A);
  const workerA = createWorker(database);
  const workerB = createWorker(database);

  let releaseGate!: () => void;
  database.claimGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const runA = workerA.runOnce();
  // A holds the announcement lock while gated; B's sweep sees nothing due.
  await new Promise((resolve) => setImmediate(resolve));
  const runB = await workerB.runOnce();
  assert.equal(runB.announcementsClaimed, 0, 'SKIP LOCKED hides the in-flight announcement');
  releaseGate();
  const runA2 = await runA;
  assert.equal(runA2.announcementsCompleted, 1);
  assert.equal(database.events.size, 1, 'exactly one worker produced the event');
});

test('option validation fails closed', () => {
  const database = new FanoutDatabase();
  const service = new MarketingAnnouncementService({ database });
  const producer = createCustomerWebhookEventProducer();
  assert.throws(() => new AnnouncementFanoutWorker(database, service, producer, { batchSize: 0 }), RangeError);
  assert.throws(() => new AnnouncementFanoutWorker(database, service, producer, { batchSize: 101 }), RangeError);
  assert.throws(() => new AnnouncementFanoutWorker(database, service, {} as never), TypeError);
  assert.throws(() => new AnnouncementFanoutWorker(database, {} as never, producer), TypeError);
});

test('the publish-side event port is a no-op seam (frozen decision b)', async () => {
  const port = createAnnouncementFanoutEventPort();
  await port.announcementPublished({} as never, {
    announcementId: ANN_1,
    kind: 'maintenance',
    severity: 'info',
    title: 'noop',
    publishAt: NOW,
    unpublishAt: null,
    occurredAt: NOW,
  });
});
