/**
 * Phase 3 observability: in-memory real-time QPS feed (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 3 item 2).
 *
 * A fixed ring of 60 five-second buckets (five minutes of trailing detail)
 * fed by `recordQpsRequest` on every dispatched attempt. The SSE endpoint
 * pushes one `snapshot()` to every connected console, sub2api-style — a
 * single snapshot fan-out rather than per-connection aggregation.
 */

export const QPS_BUCKET_MS = 5_000;
export const QPS_BUCKET_COUNT = 60;
/** Aggregation window for the headline qps figure: the last 60 seconds. */
export const QPS_WINDOW_BUCKETS = 12;

interface RouteCounts {
  ok: number;
  failed: number;
}

interface QpsBucket {
  readonly bucketStartMs: number;
  readonly routes: Map<string, RouteCounts>;
}

export interface QpsRouteSnapshot {
  readonly route: string;
  readonly requests: number;
  readonly ok: number;
  readonly failed: number;
  readonly qps: number;
}

export interface QpsSnapshot {
  readonly generatedAt: string;
  readonly bucketMs: number;
  readonly windowSeconds: number;
  /** Requests per second over the trailing window (all routes). */
  readonly qps: number;
  /** Status counts over the full retained ring (five minutes). */
  readonly statusCounts: { readonly ok: number; readonly failed: number };
  readonly routes: readonly QpsRouteSnapshot[];
}

let buckets: QpsBucket[] = [];

function bucketStartFor(nowMs: number): number {
  return Math.floor(nowMs / QPS_BUCKET_MS) * QPS_BUCKET_MS;
}

function createRing(currentStart: number): void {
  const fresh: QpsBucket[] = [];
  for (let index = QPS_BUCKET_COUNT - 1; index >= 0; index -= 1) {
    fresh.push({ bucketStartMs: currentStart - index * QPS_BUCKET_MS, routes: new Map() });
  }
  buckets = fresh;
}

/**
 * Returns the bucket for a timestamp, rolling the ring forward when needed.
 * The ring only ever anchors forward: a late record older than the ring is
 * dropped instead of rewinding history, and out-of-order records that still
 * fall inside the ring land in their own bucket.
 */
function bucketFor(nowMs: number): QpsBucket | null {
  const currentStart = bucketStartFor(nowMs);
  if (buckets.length === 0) createRing(currentStart);
  const ringEnd = buckets[buckets.length - 1]?.bucketStartMs ?? currentStart;
  if (currentStart > ringEnd) {
    const fresh: QpsBucket[] = [];
    for (let index = QPS_BUCKET_COUNT - 1; index >= 0; index -= 1) {
      fresh.push({ bucketStartMs: currentStart - index * QPS_BUCKET_MS, routes: new Map() });
    }
    for (const bucket of buckets) {
      const age = currentStart - bucket.bucketStartMs;
      if (age < 0 || age >= QPS_BUCKET_COUNT * QPS_BUCKET_MS) continue;
      fresh[QPS_BUCKET_COUNT - 1 - age / QPS_BUCKET_MS] = bucket;
    }
    buckets = fresh;
  }
  const ringStart = buckets[0]?.bucketStartMs ?? currentStart;
  const index = (currentStart - ringStart) / QPS_BUCKET_MS;
  if (!Number.isInteger(index) || index < 0 || index >= QPS_BUCKET_COUNT) return null;
  return buckets[index] ?? null;
}

/** Records one dispatched attempt into the current bucket. */
export function recordQpsRequest(route: string, ok: boolean, nowMs: number = Date.now()): void {
  const current = bucketFor(nowMs);
  if (!current) return;
  const trimmed = typeof route === 'string' ? route.trim() : '';
  const key = trimmed.length > 0 ? trimmed : 'unrouted';
  const counts = current.routes.get(key) ?? { ok: 0, failed: 0 };
  if (ok) counts.ok += 1;
  else counts.failed += 1;
  current.routes.set(key, counts);
}

function isLiveBucket(bucket: QpsBucket, nowMs: number): boolean {
  const age = bucketStartFor(nowMs) - bucket.bucketStartMs;
  return age >= 0 && age < QPS_BUCKET_COUNT * QPS_BUCKET_MS;
}

/** Aggregated view for broadcast: headline qps plus per-route detail. */
export function qpsSnapshot(nowMs: number = Date.now()): QpsSnapshot {
  const live = buckets.filter((bucket) => isLiveBucket(bucket, nowMs));
  const windowStartIndex = Math.max(live.length - QPS_WINDOW_BUCKETS, 0);
  const windowBuckets = live.slice(windowStartIndex);

  const totalOk = live.reduce((sum, bucket) => {
    let ok = 0;
    for (const counts of bucket.routes.values()) ok += counts.ok;
    return sum + ok;
  }, 0);
  const totalFailed = live.reduce((sum, bucket) => {
    let failed = 0;
    for (const counts of bucket.routes.values()) failed += counts.failed;
    return sum + failed;
  }, 0);

  const routes = new Map<string, RouteCounts>();
  for (const bucket of windowBuckets) {
    for (const [route, counts] of bucket.routes) {
      const aggregate = routes.get(route) ?? { ok: 0, failed: 0 };
      aggregate.ok += counts.ok;
      aggregate.failed += counts.failed;
      routes.set(route, aggregate);
    }
  }
  const windowSeconds = (windowBuckets.length * QPS_BUCKET_MS) / 1000;
  const routeSnapshots: QpsRouteSnapshot[] = [...routes.entries()]
    .map(([route, counts]) => ({
      route,
      requests: counts.ok + counts.failed,
      ok: counts.ok,
      failed: counts.failed,
      qps: windowSeconds > 0 ? (counts.ok + counts.failed) / windowSeconds : 0,
    }))
    .sort((left, right) => right.requests - left.requests || left.route.localeCompare(right.route));

  const windowRequests = routeSnapshots.reduce((sum, route) => sum + route.requests, 0);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    bucketMs: QPS_BUCKET_MS,
    windowSeconds,
    qps: windowSeconds > 0 ? windowRequests / windowSeconds : 0,
    statusCounts: { ok: totalOk, failed: totalFailed },
    routes: routeSnapshots,
  };
}

/** Test seam: clears the ring so tests are order-independent. */
export function resetQpsFeedForTest(): void {
  buckets = [];
}
