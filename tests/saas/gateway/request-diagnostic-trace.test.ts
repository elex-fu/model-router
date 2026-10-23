import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RequestDiagnosticTrace,
  currentRequestDiagnosticTrace,
  withRequestDiagnosticTrace,
} from '../../../src/saas/gateway/request-diagnostic-trace.js';

test('exclusive attribution removes nested query and concurrent overlap', () => {
  let now = 100;
  const trace = new RequestDiagnosticTrace(() => now);
  const checkout = trace.begin('pool-checkout');
  now = 105; checkout(); checkout();
  const transaction = trace.begin('transaction');
  now = 107; const query1 = trace.begin('query');
  now = 108; const query2 = trace.begin('query');
  now = 110; query1();
  now = 112; query2();
  now = 115; transaction();
  const snapshot = trace.snapshot();
  assert.equal(snapshot.observedExclusiveMs, 15);
  assert.equal(snapshot.phases.reduce((sum, phase) => sum + phase.exclusiveMs, 0), 15);
  assert.equal(snapshot.phases.find((phase) => phase.phase === 'query')?.exclusiveMs, 5);
  assert.equal(snapshot.phases.find((phase) => phase.phase === 'transaction')?.inclusiveMs, 10);
  assert.equal(snapshot.phases.find((phase) => phase.phase === 'transaction')?.exclusiveMs, 5);
});

test('EOF is distinct from settlement and markers retain relative first occurrence', () => {
  let now = 100;
  const trace = new RequestDiagnosticTrace(() => now);
  now = 110; trace.mark('eof');
  now = 120; trace.mark('eof');
  assert.deepEqual(trace.snapshot().markers, { eof: 10 });
  now = 130; trace.mark('settled');
  assert.deepEqual(trace.snapshot().markers, { eof: 10, settled: 30 });
});

test('span cap reports pending and dropped diagnostics without growing storage', () => {
  const trace = new RequestDiagnosticTrace(() => 10, 1);
  const finish = trace.begin('query');
  trace.begin('transaction')();
  assert.equal(trace.snapshot().pendingSpans, 1);
  assert.equal(trace.snapshot().droppedSpans, 1);
  finish(); finish();
  assert.equal(trace.snapshot().pendingSpans, 0);
  assert.throws(() => new RequestDiagnosticTrace(undefined, Number.NaN));
});

test('same-request context survives await and stays isolated across requests', async () => {
  const first = new RequestDiagnosticTrace();
  const second = new RequestDiagnosticTrace();
  await Promise.all([first, second].map((trace) => withRequestDiagnosticTrace(trace, async () => {
    await Promise.resolve();
    assert.equal(currentRequestDiagnosticTrace(), trace);
  })));
  assert.equal(currentRequestDiagnosticTrace(), undefined);
});
