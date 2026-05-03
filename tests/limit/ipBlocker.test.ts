import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IpAuthBlocker } from '../../src/limit/ipBlocker.js';

test('IpAuthBlocker: defaults to allow', () => {
  const b = new IpAuthBlocker();
  const res = b.check('1.2.3.4');
  assert.equal(res.blocked, false);
});

test('IpAuthBlocker: blocks after threshold failures within window', () => {
  let now = 1_000_000;
  const b = new IpAuthBlocker({
    threshold: 5,
    windowMs: 60_000,
    now: () => now,
  });
  for (let i = 0; i < 5; i++) {
    assert.equal(b.check('1.2.3.4').blocked, false);
    b.recordFailure('1.2.3.4');
  }
  const res = b.check('1.2.3.4');
  assert.equal(res.blocked, true);
  assert.ok(res.retryAfterMs !== undefined && res.retryAfterMs > 0);
});

test('IpAuthBlocker: failures from different IPs are isolated', () => {
  let now = 1_000_000;
  const b = new IpAuthBlocker({
    threshold: 3,
    windowMs: 60_000,
    now: () => now,
  });
  for (let i = 0; i < 3; i++) {
    b.recordFailure('1.1.1.1');
  }
  assert.equal(b.check('1.1.1.1').blocked, true);
  assert.equal(b.check('2.2.2.2').blocked, false);
});

test('IpAuthBlocker: window expires', () => {
  let now = 1_000_000;
  const b = new IpAuthBlocker({
    threshold: 3,
    windowMs: 60_000,
    now: () => now,
  });
  for (let i = 0; i < 3; i++) {
    b.recordFailure('1.1.1.1');
  }
  assert.equal(b.check('1.1.1.1').blocked, true);
  now += 60_001;
  assert.equal(b.check('1.1.1.1').blocked, false);
});

test('IpAuthBlocker: clearOnSuccess removes recorded failures', () => {
  let now = 1_000_000;
  const b = new IpAuthBlocker({
    threshold: 3,
    windowMs: 60_000,
    now: () => now,
  });
  b.recordFailure('1.1.1.1');
  b.recordFailure('1.1.1.1');
  b.clearSuccess('1.1.1.1');
  b.recordFailure('1.1.1.1');
  b.recordFailure('1.1.1.1');
  assert.equal(b.check('1.1.1.1').blocked, false);
});

test('IpAuthBlocker: empty IP is silently ignored', () => {
  const b = new IpAuthBlocker({ threshold: 1, windowMs: 1000 });
  for (let i = 0; i < 10; i++) {
    b.recordFailure('');
  }
  // empty IP should never be blocked (would block everyone otherwise)
  assert.equal(b.check('').blocked, false);
});

test('IpAuthBlocker: retryAfterMs reflects oldest failure expiry', () => {
  let now = 1_000_000;
  const b = new IpAuthBlocker({
    threshold: 3,
    windowMs: 60_000,
    now: () => now,
  });
  b.recordFailure('1.1.1.1');
  now += 10_000;
  b.recordFailure('1.1.1.1');
  b.recordFailure('1.1.1.1');
  const res = b.check('1.1.1.1');
  assert.equal(res.blocked, true);
  // oldest at 1_000_000 expires at 1_060_000; now is 1_010_000
  assert.equal(res.retryAfterMs, 50_000);
});
