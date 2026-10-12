import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type AnnouncementView,
  MarketingAnnouncementError,
  type MarketingAnnouncementEventPort,
  MarketingAnnouncementService,
} from '../../../src/saas/marketing/announcements.js';

// Track G4 service unit tests. The fake database models each production
// statement by normalized prefix; the event port is a recording seam and the
// transaction snapshot rolls back on failure, mirroring the real driver.

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const TENANT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000b2';
const USER = '00000000-0000-4000-8000-0000000000a2';
const OTHER_USER = '00000000-0000-4000-8000-0000000000a3';
const NOW = '2026-10-11T00:00:00.000Z';

interface AnnouncementRow extends Record<string, unknown> {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  publish_at: string | Date;
  unpublish_at: string | Date | null;
  status: string;
  version: string | number;
  created_by_user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  fanout_completed_at?: string | Date | null;
}

interface ReadRow extends Record<string, unknown> {
  announcement_id: string;
  user_id: string;
  tenant_id: string;
  read_at: string;
}

interface WebhookPolicyRow {
  tenant_id: string;
  enabled: boolean;
  allowed_event_types: string[];
}

interface WebhookEndpointRow {
  tenant_id: string;
  state: string;
  event_types: string[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function severityRank(severity: string): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

class FakeAnnouncementDatabase {
  readonly state = {
    announcements: [] as AnnouncementRow[],
    reads: [] as ReadRow[],
    audit: [] as Array<Record<string, unknown>>,
    webhookPolicies: [] as WebhookPolicyRow[],
    webhookEndpoints: [] as WebhookEndpointRow[],
  };
  private idCounter = 0;
  private tail: Promise<void> = Promise.resolve();

  nextId(): string {
    this.idCounter += 1;
    return `00000000-0000-4000-8000-${String(this.idCounter).padStart(12, '0')}`;
  }

  seedAnnouncement(overrides: Partial<AnnouncementRow> = {}): AnnouncementRow {
    const row: AnnouncementRow = {
      id: this.nextId(),
      kind: 'maintenance',
      severity: 'warning',
      title: 'Seeded announcement',
      body: 'Seeded body',
      publish_at: '2026-10-10T00:00:00.000Z',
      unpublish_at: null,
      status: 'draft',
      version: 1,
      created_by_user_id: ACTOR,
      created_at: '2026-10-10T00:00:00.000Z',
      updated_at: '2026-10-10T00:00:00.000Z',
      ...overrides,
    };
    this.state.announcements.push(row);
    return row;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = clone(this.state);
    try {
      return await work({ query: (sql, values = []) => this.execute(sql, values) });
    } catch (error) {
      this.state.announcements = before.announcements;
      this.state.reads = before.reads;
      this.state.audit = before.audit;
      this.state.webhookPolicies = before.webhookPolicies;
      this.state.webhookEndpoints = before.webhookEndpoints;
      throw error;
    } finally {
      release();
    }
  }

  private visible(row: AnnouncementRow, now: string): boolean {
    return (
      row.status === 'published' &&
      iso(row.publish_at) <= now &&
      (row.unpublish_at === null || iso(row.unpublish_at) > now)
    );
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e] = values;
    const result = <R>(rows: R[] = []): SqlResult<R> => ({ rows: clone(rows), rowCount: rows.length });

    if (statement.startsWith('insert into model_router_saas.saas_audit_events')) {
      // (id, NULL tenant, actor, action, target, occurred_at) — $1..$5.
      this.state.audit.push({
        id: a,
        tenant_id: null,
        actor_user_id: b,
        action: c,
        target_id: d,
        occurred_at: e,
      });
      return result<Row>();
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_announcements')) {
      const row: AnnouncementRow = {
        id: String(a),
        kind: String(b),
        severity: String(c),
        title: String(d),
        body: String(e),
        publish_at: String(values[5]),
        unpublish_at: values[6] === null ? null : String(values[6]),
        status: 'draft',
        version: 1,
        created_by_user_id: String(values[7]),
        created_at: String(values[8]),
        updated_at: String(values[8]),
      };
      this.state.announcements.push(row);
      return result<Row>([row as unknown as Row]);
    }

    if (
      statement.startsWith('select') &&
      statement.includes('from model_router_saas.saas_marketing_announcements where id = $1 for update')
    ) {
      const row = this.state.announcements.find((entry) => entry.id === a);
      return result<Row>(row ? [row as unknown as Row] : []);
    }

    // G4.5 fan-out claim: due predicate, (publish_at, id) order, bounded.
    if (
      statement.startsWith('select') &&
      statement.includes("where status = 'published' and fanout_completed_at is null") &&
      statement.includes('for update skip locked')
    ) {
      const rows = this.state.announcements
        .filter((entry) => entry.status === 'published' && (entry.fanout_completed_at ?? null) === null)
        .sort((left, right) => {
          const byPublish = iso(left.publish_at).localeCompare(iso(right.publish_at));
          return byPublish !== 0 ? byPublish : left.id.localeCompare(right.id);
        });
      return result<Row>(rows.slice(0, Number(a)) as unknown as Row[]);
    }

    // G4.5 completion CAS (must precede the generic announcements UPDATE
    // handler below): published + fanout NULL predicate, version + 1.
    if (statement.startsWith('update model_router_saas.saas_marketing_announcements set fanout_completed_at')) {
      const row = this.state.announcements.find(
        (entry) => entry.id === a && entry.status === 'published' && (entry.fanout_completed_at ?? null) === null,
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.fanout_completed_at = String(b);
      row.version = Number(row.version) + 1;
      row.updated_at = String(b);
      return { rows: [], rowCount: 1 };
    }

    // G4.5 entitlement pre-filter: enabled policy + whitelist + active
    // subscribed endpoint, ordered by tenant.
    if (statement.startsWith('select p.tenant_id') && statement.includes('saas_customer_webhook_tenant_policies')) {
      const tenants = this.state.webhookPolicies
        .filter(
          (policy) =>
            policy.enabled &&
            policy.allowed_event_types.includes('platform.maintenance') &&
            this.state.webhookEndpoints.some(
              (endpoint) =>
                endpoint.tenant_id === policy.tenant_id &&
                endpoint.state === 'active' &&
                endpoint.event_types.includes('platform.maintenance'),
            ),
        )
        .map((policy) => ({ tenant_id: policy.tenant_id }))
        .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
      return result<Row>(tenants as unknown as Row[]);
    }

    if (statement.startsWith('update model_router_saas.saas_marketing_announcements')) {
      const isPublish = statement.includes("set status = 'published'");
      const row = this.state.announcements.find((entry) => {
        if (entry.id !== a || String(entry.version) !== String(c)) return false;
        return isPublish ? entry.status === 'draft' : entry.status === 'draft' || entry.status === 'published';
      });
      if (!row) return result<Row>();
      row.status = isPublish ? 'published' : 'withdrawn';
      row.version = Number(row.version) + 1;
      row.updated_at = String(b);
      return result<Row>([row as unknown as Row]);
    }

    // Operations list: optional status/kind filters plus (created_at, id) keyset.
    if (
      statement.startsWith('select') &&
      statement.includes('from model_router_saas.saas_marketing_announcements where ($1::text is null or status = $1)')
    ) {
      const [status, kind, cursorCreatedAt, cursorId, limit] = values;
      let rows = this.state.announcements.filter((entry) => {
        if (status !== null && entry.status !== status) return false;
        if (kind !== null && entry.kind !== kind) return false;
        if (cursorCreatedAt !== null) {
          const createdAt = iso(entry.created_at);
          if (createdAt > String(cursorCreatedAt)) return false;
          if (createdAt === String(cursorCreatedAt) && entry.id >= String(cursorId)) return false;
        }
        return true;
      });
      rows = rows.sort((left, right) => {
        const byCreated = iso(right.created_at).localeCompare(iso(left.created_at));
        return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
      });
      return result<Row>(rows.slice(0, Number(limit)) as unknown as Row[]);
    }

    // Customer list: visibility window, severity keyset, read join.
    if (statement.startsWith('select') && statement.includes('as visible')) {
      const [userId, now, cursorRank, cursorPublishAt, cursorId, limit] = values;
      let rows = this.state.announcements.filter((entry) => this.visible(entry, String(now)));
      if (cursorRank !== null) {
        rows = rows.filter((entry) => {
          const rank = severityRank(entry.severity);
          if (rank > Number(cursorRank)) return true;
          if (rank < Number(cursorRank)) return false;
          const publishAt = iso(entry.publish_at);
          if (publishAt < String(cursorPublishAt)) return true;
          return publishAt === String(cursorPublishAt) && entry.id < String(cursorId);
        });
      }
      rows = rows.sort((left, right) => {
        const bySeverity = severityRank(left.severity) - severityRank(right.severity);
        if (bySeverity !== 0) return bySeverity;
        const byPublish = iso(right.publish_at).localeCompare(iso(left.publish_at));
        return byPublish !== 0 ? byPublish : right.id.localeCompare(left.id);
      });
      const joined = rows.slice(0, Number(limit)).map((entry) => ({
        ...entry,
        read_at:
          this.state.reads.find((read) => read.announcement_id === entry.id && read.user_id === userId)?.read_at ??
          null,
      }));
      return result<Row>(joined as unknown as Row[]);
    }

    // markRead visibility probe.
    if (
      statement.startsWith('select id from model_router_saas.saas_marketing_announcements') &&
      statement.includes("status = 'published'")
    ) {
      const row = this.state.announcements.find((entry) => entry.id === a && this.visible(entry, String(b)));
      return result<Row>(row ? [{ id: row.id } as unknown as Row] : []);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_announcement_reads')) {
      const conflict = this.state.reads.some((read) => read.announcement_id === a && read.user_id === b);
      if (conflict) return result<Row>();
      const row: ReadRow = {
        announcement_id: String(a),
        user_id: String(b),
        tenant_id: String(c),
        read_at: String(d),
      };
      this.state.reads.push(row);
      return result<Row>([{ read_at: row.read_at } as unknown as Row]);
    }

    if (statement.startsWith('select read_at from model_router_saas.saas_marketing_announcement_reads')) {
      const row = this.state.reads.find((read) => read.announcement_id === a && read.user_id === b);
      return result<Row>(row ? [{ read_at: row.read_at } as unknown as Row] : []);
    }

    throw new Error(`unmodelled statement: ${statement}`);
  }
}

interface RecordedEvent {
  readonly announcementId: string;
  readonly kind: string;
  readonly severity: string;
  readonly title: string;
  readonly publishAt: string;
  readonly unpublishAt: string | null;
  readonly occurredAt: string;
}

class RecordingEventPort implements MarketingAnnouncementEventPort {
  readonly calls: RecordedEvent[] = [];
  failNext = false;

  async announcementPublished(_executor: SqlExecutor, event: RecordedEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('event store unavailable');
    }
    this.calls.push(structuredClone(event));
  }
}

function harness(options: { events?: MarketingAnnouncementEventPort } = {}) {
  const database = new FakeAnnouncementDatabase();
  const service = new MarketingAnnouncementService({
    database,
    events: options.events,
    idFactory: () => database.nextId(),
    now: () => new Date(NOW),
  });
  return { database, service };
}

const VALID_INPUT = {
  kind: 'maintenance',
  severity: 'critical',
  title: 'Scheduler upgrade window',
  body: 'The control plane is read-only during the window.',
  publishAt: '2026-10-12T01:00:00.000Z',
};

test('createDraft validates input strictly and refuses non-uuid actors', async () => {
  const { service } = harness();
  await assert.rejects(
    service.createDraft({ userId: 'not-a-uuid' }, VALID_INPUT),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_FORBIDDEN',
  );
  for (const bad of [
    { ...VALID_INPUT, kind: 'promo' },
    { ...VALID_INPUT, severity: 'severe' },
    { ...VALID_INPUT, title: '   ' },
    { ...VALID_INPUT, title: 'x'.repeat(201) },
    { ...VALID_INPUT, body: '' },
    { ...VALID_INPUT, body: 'x'.repeat(8001) },
    { ...VALID_INPUT, publishAt: 'not-a-date' },
    { ...VALID_INPUT, unpublishAt: '2026-10-11T01:00:00.000Z' },
    { ...VALID_INPUT, publishAt: 42 },
  ]) {
    await assert.rejects(
      service.createDraft({ userId: ACTOR }, bad),
      (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
    );
  }
});

test('createDraft persists a hidden draft at version 1 and audits in the same transaction', async () => {
  const { database, service } = harness();
  const draft = await service.createDraft(
    { userId: ACTOR },
    { ...VALID_INPUT, unpublishAt: '2026-10-13T01:00:00.000Z' },
  );
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 1);
  assert.equal(draft.kind, 'maintenance');
  assert.equal(draft.unpublishAt, '2026-10-13T01:00:00.000Z');
  assert.equal(draft.createdByUserId, ACTOR);
  assert.deepEqual(
    database.state.audit.map((entry) => entry.action),
    ['marketing.announcement.created'],
  );
  assert.equal(database.state.audit[0]?.target_id, draft.id);
  assert.equal(database.state.audit[0]?.tenant_id, null);
  // A draft is never customer-visible.
  const listed = await service.listPublished({ tenantId: TENANT, userId: USER });
  assert.equal(listed.announcements.length, 0);
});

test('publish drives the one-way CAS, audits and fires the event port exactly once in-transaction', async () => {
  const events = new RecordingEventPort();
  const { database, service } = harness({ events });
  const draft = await service.createDraft({ userId: ACTOR }, VALID_INPUT);

  const published = await service.publish({ userId: ACTOR }, draft.id, 1);
  assert.equal(published.status, 'published');
  assert.equal(published.version, 2);
  assert.equal(events.calls.length, 1);
  assert.deepEqual(events.calls[0], {
    announcementId: draft.id,
    kind: 'maintenance',
    severity: 'critical',
    title: VALID_INPUT.title,
    publishAt: VALID_INPUT.publishAt,
    unpublishAt: null,
    occurredAt: NOW,
  });
  assert.deepEqual(
    database.state.audit.map((entry) => entry.action),
    ['marketing.announcement.created', 'marketing.announcement.published'],
  );

  // A stale publish retry conflicts; the event never re-fires.
  await assert.rejects(
    service.publish({ userId: ACTOR }, draft.id, 1),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_VERSION_CONFLICT',
  );
  await assert.rejects(
    service.publish({ userId: ACTOR }, draft.id, 2),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_STATE_CONFLICT',
  );
  assert.equal(events.calls.length, 1);
});

test('concurrent publishes have exactly one winner and one event', async () => {
  const events = new RecordingEventPort();
  const { database, service } = harness({ events });
  const draft = await service.createDraft({ userId: ACTOR }, VALID_INPUT);
  const [first, second] = await Promise.allSettled([
    service.publish({ userId: ACTOR }, draft.id, 1),
    service.publish({ userId: ACTOR }, draft.id, 1),
  ]);
  const outcomes = [first, second].map((entry) => entry.status);
  assert.deepEqual([...outcomes].sort(), ['fulfilled', 'rejected']);
  const rejected = [first, second].find((entry) => entry.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof MarketingAnnouncementError);
  assert.equal(events.calls.length, 1);
  assert.equal(database.state.announcements[0]?.status, 'published');
  assert.equal(database.state.announcements[0]?.version, 2);
});

test('publish reports not-found and rejects invalid versions', async () => {
  const { service } = harness();
  await assert.rejects(
    service.publish({ userId: ACTOR }, '00000000-0000-4000-8000-999999999999', 1),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_NOT_FOUND',
  );
  await assert.rejects(
    service.publish({ userId: ACTOR }, 'nope', 1),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
  await assert.rejects(
    service.publish({ userId: ACTOR }, '00000000-0000-4000-8000-999999999999', 0),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});

test('a failing event port rolls the publish back atomically', async () => {
  const events = new RecordingEventPort();
  events.failNext = true;
  const { database, service } = harness({ events });
  const draft = await service.createDraft({ userId: ACTOR }, VALID_INPUT);
  await assert.rejects(service.publish({ userId: ACTOR }, draft.id, 1), /event store unavailable/);
  const stored = database.state.announcements.find((row) => row.id === draft.id);
  assert.equal(stored?.status, 'draft', 'the CAS must roll back with the event failure');
  assert.equal(stored?.version, 1);
  assert.deepEqual(
    database.state.audit.map((entry) => entry.action),
    ['marketing.announcement.created'],
    'the publish audit row must roll back too',
  );
});

test('withdraw is terminal, idempotent on replay and never fires the event port', async () => {
  const events = new RecordingEventPort();
  const { database, service } = harness({ events });
  const draft = await service.createDraft({ userId: ACTOR }, VALID_INPUT);
  const published = await service.publish({ userId: ACTOR }, draft.id, 1);
  assert.equal(events.calls.length, 1);

  const withdrawn = await service.withdraw({ userId: ACTOR }, draft.id, published.version);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.version, 3);

  // Replay with a stale version still returns the current view.
  const replay = await service.withdraw({ userId: ACTOR }, draft.id, 1);
  assert.equal(replay.status, 'withdrawn');
  assert.equal(replay.version, 3);

  await assert.rejects(
    service.publish({ userId: ACTOR }, draft.id, 3),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_STATE_CONFLICT',
  );
  assert.equal(events.calls.length, 1, 'withdraw never produces the publish event');
  assert.deepEqual(
    database.state.audit.map((entry) => entry.action),
    ['marketing.announcement.created', 'marketing.announcement.published', 'marketing.announcement.withdrawn'],
  );
});

test('withdraw rejects stale versions and unknown announcements', async () => {
  const { service } = harness();
  const draft = await service.createDraft({ userId: ACTOR }, VALID_INPUT);
  await assert.rejects(
    service.withdraw({ userId: ACTOR }, draft.id, 7),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_VERSION_CONFLICT',
  );
  await assert.rejects(
    service.withdraw({ userId: ACTOR }, '00000000-0000-4000-8000-999999999999', 1),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_NOT_FOUND',
  );
});

test('operations list filters and paginates by keyset', async () => {
  const { database, service } = harness();
  const rows = [
    database.seedAnnouncement({ status: 'draft', created_at: '2026-10-08T00:00:00.000Z' }),
    database.seedAnnouncement({ status: 'published', kind: 'billing', created_at: '2026-10-09T00:00:00.000Z' }),
    database.seedAnnouncement({ status: 'published', created_at: '2026-10-10T00:00:00.000Z' }),
  ];
  const first = await service.list({ userId: ACTOR }, { limit: 2 });
  assert.deepEqual(
    first.announcements.map((row: AnnouncementView) => row.id),
    [rows[2]?.id, rows[1]?.id],
  );
  assert.ok(first.nextCursor);
  const second = await service.list({ userId: ACTOR }, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.announcements.map((row: AnnouncementView) => row.id),
    [rows[0]?.id],
  );
  assert.equal(second.nextCursor, null);

  const publishedOnly = await service.list({ userId: ACTOR }, { status: 'published' });
  assert.equal(publishedOnly.announcements.length, 2);
  const billingOnly = await service.list({ userId: ACTOR }, { kind: 'billing' });
  assert.equal(billingOnly.announcements.length, 1);

  await assert.rejects(
    service.list({ userId: ACTOR }, { status: 'archived' }),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
  await assert.rejects(
    service.list({ userId: ACTOR }, { cursor: '!!!not-a-cursor' }),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
  await assert.rejects(
    service.list({ userId: ACTOR }, { limit: 0 }),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});

test('listPublished shows only in-window published rows, severity-first, with read receipts joined', async () => {
  const { database, service } = harness();
  const hidden = [
    database.seedAnnouncement({ status: 'draft' }),
    database.seedAnnouncement({ status: 'withdrawn' }),
    database.seedAnnouncement({ status: 'published', publish_at: '2026-10-12T00:00:00.000Z' }),
    database.seedAnnouncement({
      status: 'published',
      publish_at: '2026-10-01T00:00:00.000Z',
      unpublish_at: '2026-10-10T00:00:00.000Z',
    }),
  ];
  const info = database.seedAnnouncement({
    status: 'published',
    severity: 'info',
    publish_at: '2026-10-10T12:00:00.000Z',
    // node-pg hands timestamptz back as Date objects; the mapper normalizes.
    created_at: new Date('2026-10-10T12:00:00.000Z'),
    updated_at: new Date('2026-10-10T12:00:00.000Z'),
  });
  const critical = database.seedAnnouncement({
    status: 'published',
    severity: 'critical',
    publish_at: '2026-10-09T00:00:00.000Z',
  });
  database.state.reads.push({
    announcement_id: info.id,
    user_id: USER,
    tenant_id: TENANT,
    read_at: '2026-10-10T13:00:00.000Z',
  });

  const listed = await service.listPublished({ tenantId: TENANT, userId: USER });
  assert.deepEqual(
    listed.announcements.map((row) => row.id),
    [critical.id, info.id],
    'critical outranks the newer info announcement',
  );
  assert.equal(listed.announcements[0]?.readAt, null);
  assert.equal(listed.announcements[1]?.readAt, '2026-10-10T13:00:00.000Z');
  // Customer-safe projection: operator identity and lifecycle internals are
  // mapped but never cross the customer boundary.
  for (const view of listed.announcements) {
    assert.deepEqual(Object.keys(view).sort(), [
      'body',
      'id',
      'kind',
      'publishAt',
      'readAt',
      'severity',
      'title',
      'unpublishAt',
    ]);
  }
  assert.equal(listed.nextCursor, null);

  const otherUser = await service.listPublished({ tenantId: OTHER_TENANT, userId: OTHER_USER });
  assert.equal(otherUser.announcements[1]?.readAt, null, 'read receipts are per user, not per tenant');

  // Keyset across the severity boundary.
  const pageOne = await service.listPublished({ tenantId: TENANT, userId: USER }, { limit: 1 });
  assert.deepEqual(
    pageOne.announcements.map((row) => row.id),
    [critical.id],
  );
  assert.ok(pageOne.nextCursor);
  const pageTwo = await service.listPublished(
    { tenantId: TENANT, userId: USER },
    { limit: 1, cursor: pageOne.nextCursor },
  );
  assert.deepEqual(
    pageTwo.announcements.map((row) => row.id),
    [info.id],
  );
  assert.equal(pageTwo.nextCursor, null);

  assert.ok(hidden.every((row) => !listed.announcements.some((seen) => seen.id === row.id)));
  await assert.rejects(
    service.listPublished({ tenantId: TENANT, userId: USER }, { cursor: 'bm90fGN1cnNvcg' }),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});

test('markRead is idempotent per (announcement, user) and refuses invisible announcements', async () => {
  const { database, service } = harness();
  const published = database.seedAnnouncement({ status: 'published' });
  const draft = database.seedAnnouncement({ status: 'draft' });
  const future = database.seedAnnouncement({ status: 'published', publish_at: '2026-10-12T00:00:00.000Z' });

  const marked = await service.markRead({ tenantId: TENANT, userId: USER }, published.id);
  assert.equal(marked.outcome, 'marked');
  assert.equal(marked.readAt, NOW);

  const replay = await service.markRead({ tenantId: TENANT, userId: USER }, published.id);
  assert.equal(replay.outcome, 'already_read');
  assert.equal(replay.readAt, NOW, 'the original receipt timestamp wins');
  assert.equal(database.state.reads.length, 1);

  // A second user of another tenant gets an independent receipt.
  const other = await service.markRead({ tenantId: OTHER_TENANT, userId: OTHER_USER }, published.id);
  assert.equal(other.outcome, 'marked');
  assert.equal(database.state.reads.length, 2);

  for (const id of [draft.id, future.id, '00000000-0000-4000-8000-999999999999']) {
    await assert.rejects(
      service.markRead({ tenantId: TENANT, userId: USER }, id),
      (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_NOT_FOUND',
    );
  }
  await assert.rejects(
    service.markRead({ tenantId: TENANT, userId: USER }, 'nope'),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});

// --- G4.5 fan-out cursor methods (migration 095) ---

test('listDueFanouts claims only published un-fanned announcements in (publish_at, id) order', async () => {
  const { database, service } = harness();
  const later = database.seedAnnouncement({ status: 'published', publish_at: '2026-10-11T00:00:00.000Z' });
  const earlierB = database.seedAnnouncement({ status: 'published', publish_at: '2026-10-10T00:00:00.000Z' });
  const earlierA = database.seedAnnouncement({ status: 'published', publish_at: '2026-10-10T00:00:00.000Z' });
  database.seedAnnouncement({ status: 'draft' });
  database.seedAnnouncement({ status: 'withdrawn' });
  database.seedAnnouncement({ status: 'published', fanout_completed_at: '2026-10-10T01:00:00.000Z' });

  const due = await database.transaction((tx) => service.listDueFanouts(tx, 10));
  // publish_at 2026-10-10 pair first (id order), then the 2026-10-11 row.
  assert.deepEqual(
    due.map((view) => view.id),
    [earlierB.id, earlierA.id].sort().concat(later.id),
  );
  const first = due[0]!;
  assert.deepEqual(first, {
    id: first.id,
    kind: 'maintenance',
    severity: 'warning',
    title: 'Seeded announcement',
    body: 'Seeded body',
    publishAt: '2026-10-10T00:00:00.000Z',
    unpublishAt: null,
  });

  const bounded = await database.transaction((tx) => service.listDueFanouts(tx, 2));
  assert.equal(bounded.length, 2);
  await assert.rejects(
    database.transaction((tx) => service.listDueFanouts(tx, 0)),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
  await assert.rejects(
    database.transaction((tx) => service.listDueFanouts(tx, 501)),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});

test('markFanoutCompleted is a single-winner CAS that bumps the version', async () => {
  const { database, service } = harness();
  const published = database.seedAnnouncement({ status: 'published', version: 2 });
  const draft = database.seedAnnouncement({ status: 'draft', version: 1 });
  const done = database.seedAnnouncement({
    status: 'published',
    version: 3,
    fanout_completed_at: '2026-10-10T01:00:00.000Z',
  });

  const first = await database.transaction((tx) => service.markFanoutCompleted(tx, published.id));
  assert.equal(first, true);
  const row = database.state.announcements.find((entry) => entry.id === published.id)!;
  assert.equal(iso(row.fanout_completed_at as string), NOW);
  assert.equal(Number(row.version), 3, 'the 092 guard requires an exact version increment');
  assert.equal(iso(row.updated_at), NOW);
  assert.equal(row.status, 'published', 'completion never moves the lifecycle state');

  // Replay, drafts and withdrawn rows all refuse.
  assert.equal(await database.transaction((tx) => service.markFanoutCompleted(tx, published.id)), false);
  assert.equal(await database.transaction((tx) => service.markFanoutCompleted(tx, draft.id)), false);
  assert.equal(await database.transaction((tx) => service.markFanoutCompleted(tx, done.id)), false);
  await assert.rejects(
    database.transaction((tx) => service.markFanoutCompleted(tx, 'nope')),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});

test('readFanoutEntitlements returns only enabled, whitelisted, actively-subscribed tenants in order', async () => {
  const { database, service } = harness();
  const announcement = database.seedAnnouncement({ status: 'published' });
  database.state.webhookPolicies.push(
    { tenant_id: TENANT, enabled: true, allowed_event_types: ['platform.maintenance'] },
    { tenant_id: OTHER_TENANT, enabled: true, allowed_event_types: ['platform.maintenance'] },
    {
      tenant_id: '33333333-3333-4333-8333-333333333333',
      enabled: false,
      allowed_event_types: ['platform.maintenance'],
    },
    { tenant_id: '44444444-4444-4444-8444-444444444444', enabled: true, allowed_event_types: ['wallet.low_balance'] },
    { tenant_id: '55555555-5555-4555-8555-555555555555', enabled: true, allowed_event_types: ['platform.maintenance'] },
  );
  database.state.webhookEndpoints.push(
    { tenant_id: TENANT, state: 'active', event_types: ['platform.maintenance'] },
    { tenant_id: OTHER_TENANT, state: 'active', event_types: ['wallet.low_balance'] },
    { tenant_id: '33333333-3333-4333-8333-333333333333', state: 'active', event_types: ['platform.maintenance'] },
    { tenant_id: '44444444-4444-4444-8444-444444444444', state: 'active', event_types: ['platform.maintenance'] },
    { tenant_id: '55555555-5555-4555-8555-555555555555', state: 'disabled', event_types: ['platform.maintenance'] },
  );

  const tenants = await database.transaction((tx) => service.readFanoutEntitlements(tx, announcement.id));
  // OTHER_TENANT has no platform.maintenance subscription; the disabled
  // policy, the non-whitelisted policy and the disabled endpoint all exclude.
  assert.deepEqual(tenants, [TENANT]);
  await assert.rejects(
    database.transaction((tx) => service.readFanoutEntitlements(tx, 'nope')),
    (error: unknown) => error instanceof MarketingAnnouncementError && error.code === 'ANNOUNCEMENT_INVALID_INPUT',
  );
});
