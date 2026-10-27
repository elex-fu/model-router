import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  BoundedGatewayPermits,
  boundedGatewayBudgets,
  boundedGatewayWorkerBudgets,
} from '../../src/server/bounded-gateway-budgets.js';

test('all queue, phase-worker, stripe and native pool partitions sum to fixed totals', () => {
  const totals = boundedGatewayBudgets();
  const local = boundedGatewayWorkerBudgets(totals);
  for (const key of Object.keys(totals) as Array<keyof typeof totals>) assert.equal(local[key] * 2, totals[key]);
  assert.equal(local.databasePoolMax, 8);
  assert.equal(local.receiptWorkers, 4); // Four SQL + four reconciliation lanes, separately.
  for (const value of [0, 1, 3, -2, 4.5, Number.NaN, 999999])
    assert.throws(() => boundedGatewayBudgets({ httpInFlight: value }));
  assert.throws(() => boundedGatewayBudgets({ receiptEntries: 2, receiptPerTenant: 4 }));
});

test('request-aware placement consumes sibling headroom without inflating local caps', () => {
  const permits = new BoundedGatewayPermits(2);
  permits.start(0, 'old-0');
  permits.ready(0, 'old-0');
  permits.start(1, 'old-1');
  permits.ready(1, 'old-1');
  const tickets = Array.from({ length: 4 }, () => randomUUID());
  const assignments = tickets.map((ticket) => permits.reserve(ticket)!);
  assert.equal(assignments.filter((value) => value.slot === 0).length, 2);
  assert.equal(assignments.filter((value) => value.slot === 1).length, 2);
  assert.equal(permits.reserve(randomUUID()), undefined);
  assert.equal(permits.complete(assignments[0].slot, 'wrong-epoch', tickets[0]), false);
  assert.equal(permits.reserve(randomUUID()), undefined);
  assert.equal(permits.complete(assignments[0].slot, assignments[0].epoch, tickets[0]), true);
  assert.equal(permits.complete(assignments[0].slot, assignments[0].epoch, tickets[0]), false);
  assert.equal(permits.reserve(randomUUID())?.slot, assignments[0].slot);
});

test('draining keeps grant ownership; replacement cannot overlap a starting, ready or draining process', () => {
  const permits = new BoundedGatewayPermits(1);
  permits.start(0, 'old');
  assert.throws(() => permits.start(0, 'new'), /STILL_OWNED/);
  permits.ready(0, 'old');
  const ticket = randomUUID();
  permits.reserve(ticket);
  permits.stop(0);
  assert.equal(permits.snapshot()[0].inFlight, 1);
  assert.equal(permits.reserve(randomUUID()), undefined);
  assert.throws(() => permits.start(0, 'new'), /STILL_OWNED/);
  assert.deepEqual(permits.exited(0, 'old'), [ticket]);
  permits.start(0, 'new');
  permits.ready(0, 'new');
  const next = randomUUID();
  permits.reserve(next);
  assert.equal(permits.complete(0, 'old', next), false);
  assert.equal(permits.snapshot()[0].inFlight, 1);
});

test('live health removes placement without freeing outstanding grants and cannot resurrect a drained epoch', () => {
  const permits = new BoundedGatewayPermits(1);
  permits.start(0, 'epoch');
  permits.ready(0, 'epoch');
  const ticket = randomUUID();
  permits.reserve(ticket);
  assert.equal(permits.health(0, 'epoch', false), true);
  assert.equal(permits.snapshot()[0].phase, 'unready');
  assert.equal(permits.snapshot()[0].inFlight, 1);
  assert.equal(permits.reserve(randomUUID()), undefined);
  assert.equal(permits.health(0, 'old', true), false);
  assert.equal(permits.complete(0, 'epoch', ticket), true);
  assert.equal(permits.health(0, 'epoch', true), true);
  assert.ok(permits.reserve(randomUUID()));
  permits.stop(0);
  assert.equal(permits.health(0, 'epoch', true), false);
  permits.exited(0, 'epoch');
  assert.equal(permits.health(0, 'epoch', true), false);
});
