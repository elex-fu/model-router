import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QPS_BUCKET_COUNT,
  QPS_BUCKET_MS,
  qpsSnapshot,
  recordQpsRequest,
  resetQpsFeedForTest,
} from '../../../src/saas/observability/qps-feed.js';

const SECOND = 1_000;

test('qps feed aggregates the trailing 60s window and 5m status counts', () => {
  resetQpsFeedForTest();
  const start = 1_700_000_000_000;
  // Four requests in the first trailing minute, two failures.
  for (let index = 0; index < 3; index += 1) recordQpsRequest('route-a', true, start + index * SECOND);
  recordQpsRequest('route-a', false, start + 4 * SECOND);
  // Two requests six minutes back: outside the headline window but inside the
  // retained ring's status counts only when the ring still holds them.
  recordQpsRequest('route-b', true, start - 6 * 60 * SECOND);
  const snapshot = qpsSnapshot(start + 10 * SECOND);
  assert.equal(snapshot.qps > 0, true);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0]?.route, 'route-a');
  assert.equal(snapshot.routes[0]?.requests, 4);
  assert.equal(snapshot.routes[0]?.ok, 3);
  assert.equal(snapshot.routes[0]?.failed, 1);
  // The six-minute-old bucket was never rolled forward after its write, so it
  // is excluded from the live snapshot.
  assert.equal(snapshot.statusCounts.ok, 3);
  assert.equal(snapshot.statusCounts.failed, 1);
});

test('qps headline divides window requests by elapsed seconds', () => {
  resetQpsFeedForTest();
  const start = 1_700_000_000_000;
  recordQpsRequest('route-a', true, start);
  recordQpsRequest('route-a', true, start + 4 * SECOND);
  recordQpsRequest('route-a', true, start + 9 * SECOND);
  const snapshot = qpsSnapshot(start + 10 * SECOND);
  const total = snapshot.routes.reduce((sum, route) => sum + route.requests, 0);
  assert.equal(total, 3);
  assert.equal(snapshot.qps, total / snapshot.windowSeconds);
});

test('qps feed rolls buckets and keeps recent history across gaps', () => {
  resetQpsFeedForTest();
  const start = 1_700_000_000_000;
  recordQpsRequest('route-a', true, start);
  // A gap of two buckets, then a new record: the old bucket must survive in
  // the window aggregates because the ring preserves still-recent history.
  recordQpsRequest('route-a', false, start + 2 * QPS_BUCKET_MS);
  const snapshot = qpsSnapshot(start + 2 * QPS_BUCKET_MS + SECOND);
  const routeA = snapshot.routes.find((route) => route.route === 'route-a');
  assert.equal(routeA?.requests, 2);
  assert.equal(routeA?.ok, 1);
  assert.equal(routeA?.failed, 1);
});

test('qps feed drops buckets older than the ring', () => {
  resetQpsFeedForTest();
  const start = 1_700_000_000_000;
  recordQpsRequest('route-old', true, start);
  recordQpsRequest('route-new', true, start + (QPS_BUCKET_COUNT + 1) * QPS_BUCKET_MS);
  const snapshot = qpsSnapshot(start + (QPS_BUCKET_COUNT + 1) * QPS_BUCKET_MS + SECOND);
  assert.equal(
    snapshot.routes.some((route) => route.route === 'route-old'),
    false,
  );
  assert.equal(
    snapshot.routes.some((route) => route.route === 'route-new'),
    true,
  );
  assert.equal(snapshot.statusCounts.ok, 1);
});

test('qps feed maps empty route labels to unrouted', () => {
  resetQpsFeedForTest();
  const start = 1_700_000_000_000;
  recordQpsRequest('', true, start);
  recordQpsRequest('   ', false, start);
  const snapshot = qpsSnapshot(start + SECOND);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0]?.route, 'unrouted');
  assert.equal(snapshot.routes[0]?.requests, 2);
});

test('qps snapshot reports its bucket and window shape', () => {
  resetQpsFeedForTest();
  const snapshot = qpsSnapshot(1_700_000_000_000);
  assert.equal(snapshot.bucketMs, QPS_BUCKET_MS);
  assert.equal(typeof snapshot.windowSeconds, 'number');
  assert.equal(typeof snapshot.generatedAt, 'string');
});
