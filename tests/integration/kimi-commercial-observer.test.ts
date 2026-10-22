import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  classifyKimiSettlementObservation,
  type DurableKimiRequest,
  type KimiCommercialFixture,
  waitKimiSettled,
  waitUntil,
} from '../../scripts/ops/verify-commercial-kimi.js';

// Observer-only regressions: no database, sockets, credentials or provider calls.
const requestId = randomUUID();
const expected = {
  accountId: randomUUID(),
  prices: { openai: randomUUID(), anthropic: randomUUID() },
  supplierCosts: { openai: randomUUID(), anthropic: randomUUID() },
};

function settledRow(changes: Partial<DurableKimiRequest> = {}): DurableKimiRequest {
  return {
    request_id: requestId,
    execution_state: 'succeeded',
    financial_status: 'settled',
    unknown_reason: null,
    dispatch_state: 'sent',
    result_state: 'succeeded',
    account_id: expected.accountId,
    response_started: true,
    usage_source: 'upstream',
    input_total: '186',
    output_total: '62',
    usage_count: '1',
    attempt_count: '1',
    settlement_count: '1',
    reservation_state: 'settled',
    settlement_amount: '558',
    ledger_amount: '558',
    ledger_source: 'billing_settlement',
    ledger_entries: '2',
    ledger_credit: '558',
    ledger_debit: '558',
    snapshot_price_version: expected.prices.openai,
    supplier_cost_version: expected.supplierCosts.openai,
    canonical_request_id: requestId,
    held_leases: '0',
    ...changes,
  };
}

test('commercial settlement observer reads the same request until held lease count changes from one to zero', async () => {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const parameters: unknown[][] = [];
  const fixture = {
    ...expected,
    tenantId,
    projectId,
    database: {
      async query(_sql: string, values: unknown[]) {
        parameters.push([...values]);
        return { rows: [settledRow({ held_leases: parameters.length === 1 ? '1' : '0' })] };
      },
    },
  } as unknown as KimiCommercialFixture;

  const result = await waitKimiSettled(fixture, requestId, 'openai');
  assert.equal(result.held_leases, '0');
  assert.deepEqual(parameters, [
    [tenantId, requestId, projectId],
    [tenantId, requestId, projectId],
  ]);
});

test('commercial settlement observer only accepts a fully settled row with zero held leases', () => {
  const row = settledRow();
  assert.equal(classifyKimiSettlementObservation(expected, requestId, 'openai', row), row);
  for (const count of ['1', '2', '9223372036854775807']) {
    assert.equal(
      classifyKimiSettlementObservation(expected, requestId, 'openai', settledRow({ held_leases: count })),
      undefined,
    );
  }
});

test('commercial settlement observer does not hide terminal unknown states behind held leases or a reserved hold', () => {
  const invalid: Array<Partial<DurableKimiRequest>> = [
    { execution_state: 'unknown' },
    { result_state: 'unknown' },
    { unknown_reason: 'settlement_failed' },
    { execution_state: 'unknown', reservation_state: 'reserved' },
    { result_state: 'unknown', reservation_state: 'reserved' },
    { unknown_reason: 'usage_missing', reservation_state: 'reserved' },
  ];
  for (const changes of invalid) {
    assert.throws(
      () =>
        classifyKimiSettlementObservation(expected, requestId, 'openai', settledRow({ held_leases: '1', ...changes })),
      assert.AssertionError,
    );
  }
});

test('commercial settlement observer validates all financial, usage and identity assertions before waiting for cleanup', () => {
  const invalid: Array<Partial<DurableKimiRequest>> = [
    { financial_status: 'reconciliation_pending' },
    { execution_state: 'failed' },
    { result_state: 'failed' },
    { account_id: randomUUID() },
    { attempt_count: '2' },
    { usage_count: '0' },
    { settlement_count: '0' },
    { usage_source: 'local-estimate' },
    { reservation_state: 'released' },
    { snapshot_price_version: expected.prices.anthropic },
    { supplier_cost_version: expected.supplierCosts.anthropic },
    { input_total: null },
    { output_total: null },
    { input_total: '0', output_total: '0' },
    { settlement_amount: '559' },
    { ledger_amount: '559' },
    { ledger_credit: '559' },
    { ledger_debit: '559' },
    { ledger_source: 'unrecognized' },
    { ledger_entries: '3' },
    { canonical_request_id: randomUUID() },
  ];
  for (const changes of invalid) {
    assert.throws(
      () =>
        classifyKimiSettlementObservation(expected, requestId, 'openai', settledRow({ held_leases: '1', ...changes })),
      assert.AssertionError,
    );
  }
});

test('commercial settlement observer validates native cache usage before waiting for lease cleanup', () => {
  const row = settledRow({
    held_leases: '1',
    snapshot_price_version: expected.prices.anthropic,
    supplier_cost_version: expected.supplierCosts.anthropic,
  });
  const usage = { input_tokens: 0, output_tokens: 62, cache_read_input_tokens: 186, cache_creation_input_tokens: 0 };
  assert.equal(classifyKimiSettlementObservation(expected, requestId, 'anthropic', row, [usage]), undefined);
  assert.throws(
    () =>
      classifyKimiSettlementObservation(expected, requestId, 'anthropic', row, [
        { ...usage, cache_read_input_tokens: 185 },
      ]),
    assert.AssertionError,
  );
  assert.throws(
    () => classifyKimiSettlementObservation(expected, requestId, 'anthropic', row, []),
    assert.AssertionError,
  );
});

test('commercial settlement observer rejects malformed lease counts rather than waiting', () => {
  for (const heldLeases of ['', '-1', '01', '1.5', '1e2', ' 1', '9223372036854775808', null, undefined, 1]) {
    assert.throws(
      () =>
        classifyKimiSettlementObservation(
          expected,
          requestId,
          'openai',
          settledRow({
            held_leases: heldLeases as string,
          }),
        ),
      assert.AssertionError,
    );
  }
});

test('commercial settlement observer never passes a continuously held lease at the existing bounded wait deadline', async () => {
  let reads = 0;
  await assert.rejects(
    waitUntil(
      'Synthetic held lease cleanup',
      async () => {
        reads += 1;
        return classifyKimiSettlementObservation(expected, requestId, 'openai', settledRow({ held_leases: '1' }));
      },
      0,
    ),
    /did not reach its required durable state within 0 ms/,
  );
  assert.equal(reads, 1);
});
