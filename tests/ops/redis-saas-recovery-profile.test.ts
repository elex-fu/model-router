import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const helperFile = path.join(root, 'scripts/ops/redis-saas-recovery-profile.mjs');

interface Contract {
  validateRecoveryProfile(options: Record<string, boolean>, tracing: boolean, cap: number | null): void;
  assertRecoveryAuthority(snapshot: unknown, unknownId: string, settledId: string): void;
  assertRecoverySettlementDelta(before: unknown, after: unknown, requestId: string): void;
  projectRecoveryScope(value: unknown): { active: number; windows: Record<string, { requests: number; tokens: number }> };
  runRedisSaasRecoveryProfile(options: Record<string, unknown>): Promise<unknown>;
}

function contracts(globals: Record<string, unknown> = {}): Contract {
  const source = readFileSync(helperFile, 'utf8');
  const ast = ts.createSourceFile(helperFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['validateRecoveryProfile', 'requestFact', 'holdFact', 'assertRecoveryRequest', 'assertRecoveryAuthority', 'assertRecoverySettlementDelta', 'projectRecoveryScope', 'runRedisSaasRecoveryProfile'];
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text));
  return runInContext(`${selected.map((node) => node.getText(ast).replace(/^export /, '')).join('\n')}\n({${names.join(',')}})`,
    createContext({ assert, join: path.join, ...globals })) as Contract;
}

test('recovery profile rejects mixed modes before output or owned resources exist', async () => {
  const api = contracts();
  const options = { recoveryProfile: true, diagnostic: true, noBuild: true, serialProfile: false, capProfile: false, requestSamples: false };
  api.validateRecoveryProfile(options, false, null);
  api.validateRecoveryProfile({}, true, 8);
  for (const changed of [{ diagnostic: false }, { noBuild: false }, { serialProfile: true }, { capProfile: true }, { requestSamples: true }]) {
    assert.throws(() => api.validateRecoveryProfile({ ...options, ...changed }, false, null));
  }
  assert.throws(() => api.validateRecoveryProfile(options, true, null));
  assert.throws(() => api.validateRecoveryProfile(options, false, 8));
  const directory = await mkdtemp(path.join(tmpdir(), 'redis-recovery-flag-'));
  try {
    const output = path.join(directory, 'must-not-exist');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/ops/run-current-r9.mjs'),
      '--recovery-profile', '--no-build', '--output-dir', output], {
      env: { PATH: process.env.PATH, MODEL_ROUTER_TEST_PG_BIN: '', MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: '' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery-profile requires --diagnostic/);
    assert.equal(existsSync(output), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// These are assertion-contract unit tests, not PostgreSQL or recovery evidence.
test('recovery authority assertions reject released unknown holds and vacuous cumulative budgets', () => {
  const api = contracts();
  const fixture = {
    requests: [
      { id: 'u', execution: 'unknown', financial: 'reconciliation_pending', reconciliation: 'pending' },
      { id: 's', execution: 'succeeded', financial: 'settled', reconciliation: 'none' },
    ],
    holds: [{ requestId: 'u', state: 'reconciliation_pending', amount: '20', ledgerTransactionId: null }, { requestId: 's', settlement: '3' }],
    attempts: [{ id: 'au', requestId: 'u' }, { id: 'as', requestId: 's' }],
    evidence_facts: [{ requestId: 'u' }, { requestId: 's' }],
    usage_facts: [{ requestId: 's' }], settlement_facts: [{ requestId: 's' }],
    leases: [{ attemptId: 'au', status: 'released' }, { attemptId: 'as', status: 'released' }],
    budget_reservations: [
      { requestId: 'u', lineage: 'lineage', day: '2026-10-24', state: 'outstanding', tokens: '10', charge: '20' },
      { requestId: 's', lineage: 'lineage', day: '2026-10-24', state: 'settled', tokens: '5', charge: '3' },
    ],
    budgets: ['daily', 'lifetime'].map((window) => ({ lineage: 'lineage', window, day: window === 'daily' ? '2026-10-24' : '0001-01-01',
      tokensSettled: '5', chargeSettled: '3', tokensReserved: '10', chargeReserved: '20' })),
  };
  api.assertRecoveryAuthority(fixture, 'u', 's');
  const mutate = (work: (value: typeof fixture) => void) => {
    const changed = structuredClone(fixture); work(changed);
    assert.throws(() => api.assertRecoveryAuthority(changed, 'u', 's'));
  };
  mutate((value) => { value.holds[0].state = 'released'; });
  mutate((value) => { value.leases[0].status = 'held'; });
  mutate((value) => { value.requests[1].financial = 'reconciliation_pending'; });
  mutate((value) => { value.budgets = []; });
  mutate((value) => { value.budgets[0].tokensSettled = '0'; });
  mutate((value) => { value.budget_reservations[0].state = 'settled'; });
  mutate((value) => { value.budgets.pop(); });
  mutate((value) => { value.budgets[0].tokensReserved = '11'; });
  mutate((value) => { value.attempts.push({ id: 'duplicate', requestId: 's' }); });
  mutate((value) => { value.usage_facts.push({ requestId: 'u' }); });
});

test('soft quota observations retain original time buckets and omit arbitrary fields', () => {
  const api = contracts();
  const value = api.projectRecoveryScope({ active: 1, secret: 'not exported', windows: {
    '123': { requests: 2, tokens: 5, payload: 'not exported' },
  } });
  assert.equal(JSON.stringify(value), '{"active":1,"windows":{"123":{"requests":2,"tokens":5}}}');
  assert.throws(() => api.projectRecoveryScope({ active: -1, windows: {} }));
  assert.throws(() => api.projectRecoveryScope({ active: 1, windows: { invalid: { requests: 1, tokens: 2 } } }));
  assert.throws(() => api.projectRecoveryScope({ active: 1, windows: { '123': { requests: 1, tokens: -2 } } }));
});

test('pre-aborted recovery does not connect or inject a new provider request', async () => {
  let connections = 0;
  let requests = 0;
  let evidenceWrites = 0;
  const api = contracts({
    createClient() { connections++; throw new Error('must not connect'); },
    fetch() { requests++; throw new Error('must not send'); },
    async writeFile() { evidenceWrites++; },
  });
  const controller = new AbortController();
  controller.abort(new Error('stop recovery'));
  await assert.rejects(api.runRedisSaasRecoveryProfile({ database: {}, outputDir: '/unused', signal: controller.signal }), /stop recovery/);
  assert.equal(connections, 0);
  assert.equal(requests, 0);
  assert.equal(evidenceWrites, 1);
});

test('settlement delta requires one balanced linked ledger transaction and both budget windows', () => {
  const api = contracts();
  const counters = (tokens: string, charge: string) => ['daily', 'lifetime'].map((window) => ({ lineage: 'l', window,
    day: window === 'daily' ? '2026-10-24' : '0001-01-01', tokensSettled: tokens, chargeSettled: charge }));
  const before = { budgets: counters('0', '0'), ledger: [], entries: [], wallets: [{ balance: '100' }], usage: 0, settlements: 0 };
  const after = {
    requests: [{ id: 's', execution: 'succeeded', financial: 'settled' }],
    attempts: [{ id: 'a', requestId: 's' }], leases: [{ attemptId: 'a', status: 'released' }],
    evidence_facts: [{ requestId: 's' }], settlement_facts: [{ requestId: 's' }],
    usage_facts: [{ requestId: 's', inputTotal: '3', outputTotal: '2' }],
    budget_reservations: [{ requestId: 's', lineage: 'l', day: '2026-10-24', state: 'settled' }],
    budgets: counters('5', '3'), holds: [{ requestId: 's', state: 'settled', settlement: '3', ledgerTransactionId: 'tx' }],
    ledger: [{ id: 'tx', amount: '3', source: 'billing_settlement' }],
    entries: [{ id: 'debit', transaction: 'tx', direction: 'debit', amount: '3' }, { id: 'credit', transaction: 'tx', direction: 'credit', amount: '3' }],
    wallets: [{ balance: '97' }], usage: 1, settlements: 1,
  };
  api.assertRecoverySettlementDelta(before, after, 's');
  for (const mutate of [
    (value: typeof after) => { value.budgets.pop(); },
    (value: typeof after) => { value.entries[0].amount = '2'; },
    (value: typeof after) => { value.entries[0].transaction = 'wrong'; },
    (value: typeof after) => { value.ledger.push({ id: 'duplicate', amount: '3', source: 'billing_settlement' }); },
  ]) {
    const changed = structuredClone(after); mutate(changed);
    assert.throws(() => api.assertRecoverySettlementDelta(before, changed, 's'));
  }
});
