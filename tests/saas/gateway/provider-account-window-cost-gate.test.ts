import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateWindowCostSchedulability,
  type WindowCostGateInput,
  windowCostWindowStartMs,
} from '../../../src/saas/gateway/provider-account-window-cost-gate.js';

/**
 * Gap-remediation G-B1 (§2): the pure three-state judgment — the sub2api
 * CheckWindowCostSchedulability semantics over exact minor-unit costs.
 * The PG facts reader is covered by the Postgres scheduler suite.
 */

function gate(usage: bigint, limit: bigint | null, reserve: bigint | null = null): WindowCostGateInput {
  return { usageMinorUnits: usage, limitMinorUnits: limit, reserveMinorUnits: reserve };
}

test('G-B1 gate: usage below the limit admits new and sticky sessions', () => {
  assert.equal(evaluateWindowCostSchedulability(gate(0n, 1000n, 100n)), 'admit');
  assert.equal(evaluateWindowCostSchedulability(gate(999n, 1000n, 100n)), 'admit');
});

test('G-B1 gate: the reserve band admits sticky sessions only', () => {
  assert.equal(evaluateWindowCostSchedulability(gate(1000n, 1000n, 100n)), 'sticky_only');
  assert.equal(evaluateWindowCostSchedulability(gate(1099n, 1000n, 100n)), 'sticky_only');
});

test('G-B1 gate: at limit+reserve the window pauses scheduling', () => {
  assert.equal(evaluateWindowCostSchedulability(gate(1100n, 1000n, 100n)), 'paused');
  assert.equal(evaluateWindowCostSchedulability(gate(999_999n, 1000n, 100n)), 'paused');
});

test('G-B1 gate: an unset or non-positive limit is OFF — the pre-gate behavior', () => {
  assert.equal(evaluateWindowCostSchedulability(gate(1_000_000n, null)), 'admit');
  assert.equal(evaluateWindowCostSchedulability(gate(1_000_000n, undefined)), 'admit');
  assert.equal(evaluateWindowCostSchedulability(gate(1_000_000n, 0n)), 'admit');
  assert.equal(evaluateWindowCostSchedulability(gate(1_000_000n, -5n)), 'admit');
});

test('G-B1 gate: a zero reserve empties the middle band — the limit pauses directly', () => {
  assert.equal(evaluateWindowCostSchedulability(gate(999n, 1000n, 0n)), 'admit');
  assert.equal(evaluateWindowCostSchedulability(gate(1000n, 1000n, 0n)), 'paused');
  // A negative reserve reads as empty, never a wider band.
  assert.equal(evaluateWindowCostSchedulability(gate(1000n, 1000n, -50n)), 'paused');
});

test('G-B1 gate: an unset reserve defaults to empty (limit-only configuration)', () => {
  assert.equal(evaluateWindowCostSchedulability(gate(1500n, 1000n, null)), 'paused');
});

test('G-B1 window start: the stored 5h session window while fresh, hourly floor otherwise', () => {
  const now = Date.parse('2026-10-18T12:34:56Z');
  const fresh = now - 60 * 60 * 1000;
  const stale = now - 6 * 60 * 60 * 1000;
  assert.equal(windowCostWindowStartMs(fresh, now), fresh);
  assert.equal(windowCostWindowStartMs(stale, now), Math.floor(now / 3_600_000) * 3_600_000);
  assert.equal(windowCostWindowStartMs(null, now), Math.floor(now / 3_600_000) * 3_600_000);
});
