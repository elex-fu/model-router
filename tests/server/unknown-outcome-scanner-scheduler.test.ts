import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startUnknownOutcomeScanner } from '../../src/saas/metering/unknown-outcome-scanner-scheduler.js';

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail('condition was not reached');
}

test('unknown-outcome scanner validates a bounded interval', () => {
  const worker = {
    runOnce: async () => ({ claimed: 0, operatorRequired: [], superseded: [], leaseLost: [], deferred: [], failed: 0 }),
  };
  assert.throws(() => startUnknownOutcomeScanner(worker, { intervalMs: 49 }), /between 50 and 60000 ms/);
  assert.throws(() => startUnknownOutcomeScanner(worker, { intervalMs: 60_001 }), /between 50 and 60000 ms/);
});

test('unknown-outcome scanner is single-flight and stop waits for the active cycle', async () => {
  let calls = 0;
  let resolveCycle: (() => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const cycle = new Promise<void>((resolve) => {
    resolveCycle = resolve;
  });
  let operatorRequired = 0;
  const scanner = startUnknownOutcomeScanner(
    {
      async runOnce() {
        calls += 1;
        resolveStarted?.();
        await cycle;
        return {
          claimed: 1,
          operatorRequired: ['case-opaque'],
          superseded: [],
          leaseLost: [],
          deferred: [],
          failed: 0,
        };
      },
    },
    { intervalMs: 50, onOperatorRequired: (count) => (operatorRequired += count) },
  );

  await waitFor(() => calls === 1);
  await started;
  await sleep(80);
  assert.equal(calls, 1);

  let stopped = false;
  const stopping = scanner.stop().then(() => {
    stopped = true;
  });
  await sleep(10);
  assert.equal(stopped, false);
  resolveCycle?.();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(operatorRequired, 1);
  await sleep(80);
  assert.equal(calls, 1);
});
