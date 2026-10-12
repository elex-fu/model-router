import type { SaasDatabase } from '../db/types.js';
import type { MarketingAnnouncementEventPort, MarketingAnnouncementService } from '../marketing/announcements.js';
import type { CustomerWebhookEventProducer } from './producers.js';

/**
 * R8/G4.5 announcement webhook fan-out worker (design:
 * docs/remaining-capability-plan-2026-10-11.md R8; migration 095 cursor).
 *
 * The published announcement row is the fan-out cursor:
 * `status='published' AND fanout_completed_at IS NULL` means the
 * platform.maintenance event still has to reach tenant webhook endpoints.
 *
 * One sweep (runOnce):
 *  1. Claim a bounded batch of due announcements in a short transaction
 *     (FOR UPDATE SKIP LOCKED, ordered by publish_at, id — the 095 due
 *     partial index), so concurrent workers stride across announcements.
 *  2. Per announcement, read the entitled tenants (enabled policy +
 *     platform.maintenance whitelist + an active subscribed endpoint).
 *     Tenants outside the entitlement or without a subscribed endpoint are
 *     skipped — webhooks are a notification capability, never a gate.
 *  3. Per tenant, enqueue in its own short transaction through the F3
 *     producer (idempotency key `announcement:<announcementId>:<tenantId>`,
 *     occurred_at = the announcement's publish time). The producer
 *     re-checks entitlement through the F2 port and swallows the four
 *     fail-closed drop codes (C-5): an entitlement race drops the tenant's
 *     event without failing the sweep.
 *  4. Only after every entitled tenant has been attempted, write
 *     fanout_completed_at through the completion CAS.
 *
 * Crash safety: a crash or failure before the completion write leaves the
 * announcement due; the next sweep re-enqueues, and the idempotency keys
 * make the replay duplicate-free (same announcement -> same deterministic
 * payload -> stored-key replay, no new rows). The completion CAS predicate
 * (published + fanout NULL) keeps concurrent completers single-winner and
 * refuses announcements withdrawn mid-fan-out. Withdrawn-before-scan
 * announcements are never claimed at all. Residual race, accepted and
 * documented: a withdraw landing between the claim and the completion CAS
 * can no longer recall already-enqueued immutable events; the completion
 * write itself is correctly refused.
 *
 * Publish stays O(1): the MarketingAnnouncementEventPort implementation
 * below is the frozen decision (b) — a no-op seam so the publish
 * transaction never fans out (tenant count is unbounded); this worker's
 * scan produces the events, eventually consistent within a sweep interval.
 * The periodic scheduling is wired in the managed composition.
 */

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;

export interface AnnouncementFanoutWorkerOptions {
  /** Maximum announcements claimed per sweep (1..100; default 10). */
  readonly batchSize?: number;
  /** Receives only a stable cycle code. It never receives tenant or announcement data. */
  readonly onError?: (code: 'announcement_fanout_failed') => void;
}

export interface AnnouncementFanoutResult {
  readonly announcementsClaimed: number;
  readonly announcementsCompleted: number;
  readonly tenantsEnqueued: number;
  readonly announcementsFailed: number;
}

/**
 * Frozen decision (b): the publish-side event port deliberately does
 * nothing — the worker scan is the fan-out mechanism. Wiring this port (or
 * omitting it) changes nothing about publish latency or semantics; the
 * audit row is always written by the service regardless.
 */
export function createAnnouncementFanoutEventPort(): MarketingAnnouncementEventPort {
  return Object.freeze({
    announcementPublished: async () => {},
  });
}

export class AnnouncementFanoutWorker {
  private readonly batchSize: number;
  private readonly onError?: (code: 'announcement_fanout_failed') => void;

  constructor(
    private readonly database: SaasDatabase,
    private readonly announcements: MarketingAnnouncementService,
    private readonly producer: CustomerWebhookEventProducer,
    options: AnnouncementFanoutWorkerOptions = {},
  ) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
    }
    if (
      !announcements ||
      typeof announcements.listDueFanouts !== 'function' ||
      typeof announcements.readFanoutEntitlements !== 'function' ||
      typeof announcements.markFanoutCompleted !== 'function'
    ) {
      throw new TypeError('announcements must implement the fan-out cursor contract');
    }
    if (!producer || typeof producer.platformMaintenanceAnnouncement !== 'function') {
      throw new TypeError('producer must implement the customer webhook event producer contract');
    }
    this.batchSize = batchSize;
    this.onError = options.onError;
  }

  async runOnce(): Promise<AnnouncementFanoutResult> {
    const claimed = await this.database.transaction((tx) => this.announcements.listDueFanouts(tx, this.batchSize));
    const outcome = { claimed: claimed.length, completed: 0, enqueued: 0, failed: 0 };
    for (const announcement of claimed) {
      try {
        const tenantIds = await this.database.transaction((tx) =>
          this.announcements.readFanoutEntitlements(tx, announcement.id),
        );
        for (const tenantId of tenantIds) {
          await this.database.transaction((tx) =>
            this.producer.platformMaintenanceAnnouncement(tx, {
              tenantId,
              announcementId: announcement.id,
              kind: announcement.kind,
              severity: announcement.severity,
              title: announcement.title,
              body: announcement.body,
              publishAt: announcement.publishAt,
              unpublishAt: announcement.unpublishAt,
              occurredAt: announcement.publishAt,
            }),
          );
          outcome.enqueued += 1;
        }
        const completed = await this.database.transaction((tx) =>
          this.announcements.markFanoutCompleted(tx, announcement.id),
        );
        if (completed) outcome.completed += 1;
      } catch {
        outcome.failed += 1;
        try {
          this.onError?.('announcement_fanout_failed');
        } catch {
          // Observability hooks must never break the sweep.
        }
      }
    }
    return Object.freeze({
      announcementsClaimed: outcome.claimed,
      announcementsCompleted: outcome.completed,
      tenantsEnqueued: outcome.enqueued,
      announcementsFailed: outcome.failed,
    });
  }
}

export interface AnnouncementFanoutWorkerHandle {
  close(): Promise<void>;
}

export interface AnnouncementFanoutWorkerLoopOptions extends AnnouncementFanoutWorkerOptions {
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 15_000;
const MAX_INTERVAL_MS = 600_000;

/**
 * Periodic scheduling for the managed composition: sweep, back off for the
 * configured interval, and never let a failing cycle kill the loop. Close
 * drains at most the in-flight sweep before returning.
 */
export function startAnnouncementFanoutWorker(
  database: SaasDatabase,
  announcements: MarketingAnnouncementService,
  producer: CustomerWebhookEventProducer,
  options: AnnouncementFanoutWorkerLoopOptions = {},
): AnnouncementFanoutWorkerHandle {
  const worker = new AnnouncementFanoutWorker(database, announcements, producer, options);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > MAX_INTERVAL_MS) {
    throw new RangeError(`intervalMs must be between 100 and ${MAX_INTERVAL_MS}`);
  }
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = async (): Promise<void> => {
    while (!closed) {
      try {
        await worker.runOnce();
      } catch {
        try {
          options.onError?.('announcement_fanout_failed');
        } catch {
          // An observer cannot terminate the sweep loop.
        }
      }
      if (!closed) await delayWithClose(intervalMs);
    }
  };
  inFlight = loop();
  return {
    async close() {
      if (closed) return inFlight;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await inFlight;
    },
  };
}
