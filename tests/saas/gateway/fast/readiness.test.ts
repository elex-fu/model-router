import assert from 'node:assert/strict';
import test from 'node:test';
import { createFastGatewayReadiness } from '../../../../src/saas/gateway/fast/readiness.js';

test('fast readiness combines dependencies without reviving an unavailable snapshot cache', async () => {
  let available = true;
  let ready = true;
  let journalReady = true;
  let probes = 0;
  const check = createFastGatewayReadiness({
    admission: {
      checkReady: async () => {
        probes++;
        return ready;
      },
    },
    journal: {
      checkReady: async () => {
        if (!journalReady) throw new Error('closed');
      },
    },
    snapshots: { isAvailable: () => available },
  });
  assert.equal(await check(), true);
  ready = false;
  assert.equal(await check(), false);
  ready = true;
  journalReady = false;
  assert.equal(await check(), false);
  journalReady = true;
  available = false;
  const before = probes;
  assert.equal(await check(), false);
  assert.equal(probes, before);
  assert.equal(available, false);
});

test('an outage during an awaited health probe cannot return healthy', async () => {
  let available = true;
  const check = createFastGatewayReadiness({
    admission: {
      checkReady: async () => {
        available = false;
        return true;
      },
    },
    journal: { checkReady: async () => {} },
    snapshots: { isAvailable: () => available },
  });
  assert.equal(await check(), false);
});

test('receipt budget/age pressure fails readiness before and after awaited probes', async () => {
  let ready = false;
  let probes = 0;
  const check = createFastGatewayReadiness({
    receipts: { isReady: () => ready },
    snapshots: { isAvailable: () => true },
    journal: { checkReady: async () => {} },
    admission: {
      checkReady: async () => {
        probes++;
        ready = false;
        return true;
      },
    },
  });
  assert.equal(await check(), false);
  assert.equal(probes, 0);
  ready = true;
  assert.equal(await check(), false);
  assert.equal(probes, 1);
});
