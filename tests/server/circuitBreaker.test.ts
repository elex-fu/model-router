import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/server/circuitBreaker.js';

test('allows requests when closed', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  assert.ok(cb.allow('up1'));
  assert.ok(cb.allow('up1'));
});

test('opens after threshold failures', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  cb.reportFailure('up1');
  cb.reportFailure('up1');
  assert.ok(cb.allow('up1'));
  cb.reportFailure('up1');
  assert.ok(!cb.allow('up1'));
});

test('half-open after recovery timeout', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50 });
  cb.reportFailure('up1');
  cb.reportFailure('up1');
  assert.ok(!cb.allow('up1'));
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cb.allow('up1'));
});

test('closes after success threshold in half-open', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50, successThreshold: 2 });
  cb.reportFailure('up1');
  cb.reportFailure('up1');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cb.allow('up1'));
  cb.reportSuccess('up1');
  assert.ok(cb.allow('up1'));
  cb.reportSuccess('up1');
  assert.ok(cb.allow('up1'));
});

test('opens again if half-open probe fails', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50 });
  cb.reportFailure('up1');
  cb.reportFailure('up1');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cb.allow('up1'));
  cb.reportFailure('up1');
  assert.ok(!cb.allow('up1'));
});

test('neutralRelease refunds half-open permit', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50, successThreshold: 2 });
  cb.reportFailure('up1');
  cb.reportFailure('up1');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cb.allow('up1'));
  cb.neutralRelease('up1');
  assert.ok(cb.allow('up1'));
});

test('reset forces closed state', () => {
  const cb = new CircuitBreaker({ failureThreshold: 2 });
  cb.reportFailure('up1');
  cb.reportFailure('up1');
  assert.ok(!cb.allow('up1'));
  cb.reset('up1');
  assert.ok(cb.allow('up1'));
});

test('isolated state per upstream', () => {
  const cb = new CircuitBreaker({ failureThreshold: 2 });
  cb.reportFailure('a');
  cb.reportFailure('a');
  assert.ok(!cb.allow('a'));
  assert.ok(cb.allow('b'));
});
