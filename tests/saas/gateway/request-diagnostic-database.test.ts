import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import { createSaasDatabase } from '../../../src/saas/db/database.js';
import { RequestDiagnosticTrace, withRequestDiagnosticTrace } from '../../../src/saas/gateway/request-diagnostic-trace.js';

test('diagnostic native pool query separates checkout and query and releases success', async (t) => {
  let now = 0;
  const releases: unknown[] = [];
  t.mock.method(Pool.prototype, 'connect', async () => {
    now += 3;
    return Object.assign(new EventEmitter(), {
      query: async () => { now += 7; return { rows: [{ ok: true }], rowCount: 1 }; },
      release: (error: unknown) => releases.push(error),
    });
  });
  const database = createSaasDatabase({ connectionString: 'postgresql://unused/diagnostic' });
  const trace = new RequestDiagnosticTrace(() => now);
  try {
    const result = await withRequestDiagnosticTrace(trace, () => database.query('SELECT 1'));
    assert.equal(result.rowCount, 1);
    assert.deepEqual(releases, [false]);
    assert.equal(trace.snapshot().phases.find((phase) => phase.phase === 'pool-checkout')?.exclusiveMs, 3);
    assert.equal(trace.snapshot().phases.find((phase) => phase.phase === 'query')?.exclusiveMs, 7);
  } finally { await database.close(); }
});

test('diagnostic query failure preserves error and discards acquired client', async (t) => {
  const failure = new Error('query failed');
  const releases: unknown[] = [];
  t.mock.method(Pool.prototype, 'connect', async () => Object.assign(new EventEmitter(), {
    query: async () => { throw failure; },
    release: (error: unknown) => releases.push(error),
  }));
  const database = createSaasDatabase({ connectionString: 'postgresql://unused/diagnostic' });
  const trace = new RequestDiagnosticTrace();
  try {
    await assert.rejects(withRequestDiagnosticTrace(trace, () => database.query('SELECT 1')), (error) => error === failure);
    assert.deepEqual(releases, [true]);
    assert.equal(trace.snapshot().pendingSpans, 0);
  } finally { await database.close(); }
});

test('diagnostic checkout failure closes wait span without query or client release', async (t) => {
  let now = 0;
  const failure = new Error('checkout failed');
  t.mock.method(Pool.prototype, 'connect', async () => { now = 9; throw failure; });
  const database = createSaasDatabase({ connectionString: 'postgresql://unused/diagnostic' });
  const trace = new RequestDiagnosticTrace(() => now);
  try {
    await assert.rejects(withRequestDiagnosticTrace(trace, () => database.query('SELECT 1')), (error) => error === failure);
    assert.equal(trace.snapshot().phases.find((phase) => phase.phase === 'pool-checkout')?.exclusiveMs, 9);
    assert.equal(trace.snapshot().phases.find((phase) => phase.phase === 'query')?.inclusiveMs, 0);
    assert.equal(trace.snapshot().pendingSpans, 0);
  } finally { await database.close(); }
});

test('diagnostic pool query handles client error event and releases once', async (t) => {
  const failure = new Error('connection lost');
  const releases: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: () => new Promise<never>(() => { queueMicrotask(() => client.emit('error', failure)); }),
    release: (error: unknown) => releases.push(error),
  });
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const database = createSaasDatabase({ connectionString: 'postgresql://unused/diagnostic' });
  const trace = new RequestDiagnosticTrace();
  try {
    await assert.rejects(withRequestDiagnosticTrace(trace, () => database.query('SELECT 1')), (error) => error === failure);
    assert.deepEqual(releases, [true]);
    assert.equal(client.listenerCount('error'), 0);
    assert.equal(trace.snapshot().pendingSpans, 0);
  } finally { await database.close(); }
});

test('transaction query time is exclusive from transaction overhead through release', async (t) => {
  let now = 0;
  const sql: string[] = [];
  const released: unknown[] = [];
  t.mock.method(Pool.prototype, 'connect', async () => {
    now += 3;
    return Object.assign(new EventEmitter(), {
      query: async (text: string) => { sql.push(text); now += 2; return { rows: [], rowCount: 0 }; },
      release: (error: unknown) => { now += 1; released.push(error); },
    });
  });
  const database = createSaasDatabase({ connectionString: 'postgresql://unused/diagnostic' });
  const trace = new RequestDiagnosticTrace(() => now);
  try {
    await withRequestDiagnosticTrace(trace, () => database.transaction(async (tx) => {
      now += 4;
      await tx.query('SELECT 1');
    }));
    assert.deepEqual(sql, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT 1', 'COMMIT']);
    assert.deepEqual(released, [false]);
    const phases = trace.snapshot().phases;
    assert.equal(phases.find((phase) => phase.phase === 'pool-checkout')?.exclusiveMs, 3);
    assert.equal(phases.find((phase) => phase.phase === 'query')?.exclusiveMs, 6);
    assert.equal(phases.find((phase) => phase.phase === 'transaction')?.exclusiveMs, 5);
  } finally { await database.close(); }
});
