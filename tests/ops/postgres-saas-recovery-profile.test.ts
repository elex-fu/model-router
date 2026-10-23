import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const helperFile = path.join(root, 'scripts/ops/postgres-saas-recovery-profile.mjs');
interface Contracts {
  validatePostgresRecoveryProfile(options: Record<string, boolean>, tracing: boolean, cap: number | null): void;
  assertPostgresRestartIdentity(before: unknown, after: unknown): void;
  preservedFinancialFacts(snapshot: unknown): unknown;
  assertUnknownPostgresAuthority(snapshot: unknown, details: unknown, original: unknown): void;
  runPostgresSaasRecoveryProfile(options: Record<string, unknown>): Promise<unknown>;
}
function contracts(globals: Record<string, unknown> = {}): Contracts {
  const source = readFileSync(helperFile, 'utf8');
  const ast = ts.createSourceFile(helperFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name);
  const names = selected.map((node) => (node as ts.FunctionDeclaration).name!.text);
  return runInContext(`${selected.map((node) => node.getText(ast).replace(/^export /, '')).join('\n')}\n({${names.join(',')}})`,
    createContext({ assert, join: path.join, console: { log() {} }, ...globals })) as Contracts;
}

test('PostgreSQL recovery rejects mixed/performance modes before any owned resource is created', async () => {
  const api = contracts();
  const options = { postgresRecoveryProfile: true, diagnostic: true, noBuild: true };
  api.validatePostgresRecoveryProfile(options, false, null);
  api.validatePostgresRecoveryProfile({}, true, 8);
  for (const changed of [{ diagnostic: false }, { noBuild: false }, { serialProfile: true }, { capProfile: true }, { recoveryProfile: true }, { requestSamples: true }]) {
    assert.throws(() => api.validatePostgresRecoveryProfile({ ...options, ...changed }, false, null));
  }
  assert.throws(() => api.validatePostgresRecoveryProfile(options, true, null));
  assert.throws(() => api.validatePostgresRecoveryProfile(options, false, 8));
  const directory = await mkdtemp(path.join(tmpdir(), 'pg-recovery-flag-'));
  try {
    const output = path.join(directory, 'must-not-exist');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/ops/run-current-r9.mjs'),
      '--postgres-recovery-profile', '--no-build', '--output-dir', output], {
      env: { PATH: process.env.PATH, MODEL_ROUTER_TEST_PG_BIN: '', MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: '' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /postgres-recovery-profile requires --diagnostic/);
    assert.equal(existsSync(output), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('same-directory restart identity must preserve database/configuration and change postmaster start', () => {
  const api = contracts();
  const before = { current_user: 'migrator', session_user: 'migrator', database: 'owned_test', address: '127.0.0.1',
    port: 3333, version: '180000', fsync: 'on', synchronous_commit: 'on', postmaster_start: 'before' };
  const after = { ...before, postmaster_start: 'after' };
  api.assertPostgresRestartIdentity(before, after);
  assert.throws(() => api.assertPostgresRestartIdentity(before, before));
  assert.throws(() => api.assertPostgresRestartIdentity(before, { ...after, port: 4444 }));
  assert.throws(() => api.assertPostgresRestartIdentity(before, { ...after, synchronous_commit: 'off' }));
});

test('expired stored-held lease is legal but live lease, premature scanner result or released hold is rejected', () => {
  const api = contracts();
  const original = { requestId: 'r', attemptId: 'a', holdId: 'h', holdAmount: '20', updatedAtMs: 1000, leaseId: 'lease', fence: '1',
    budgetReservation: { requestId: 'r', lineage: 'l', day: '2026-10-24', state: 'outstanding', tokens: '10', charge: '20' } };
  const snapshot = {
    requests: [{ id: 'r', execution: 'unknown', financial: 'reconciliation_pending', reconciliation: 'pending' }],
    attempts: [{ id: 'a', requestId: 'r' }], evidence_facts: [{ requestId: 'r' }], usage_facts: [], settlement_facts: [],
    holds: [{ id: 'h', requestId: 'r', state: 'reconciliation_pending', amount: '20', settlement: null, ledgerTransactionId: null }],
    budget_reservations: [{ requestId: 'r', lineage: 'l', day: '2026-10-24', state: 'outstanding', tokens: '10', charge: '20' }],
    budgets: ['daily', 'lifetime'].map((window) => ({ lineage: 'l', window, day: window === 'daily' ? '2026-10-24' : '0001-01-01',
      tokensReserved: '10', chargeReserved: '20' })),
  };
  const details = { databaseNowMs: 601000, cases: [{ state: 'operator_required', lastError: null }],
    leases: [{ id: 'lease', attemptId: 'a', fence: '1', status: 'held', liveHeld: false }] };
  api.assertUnknownPostgresAuthority(snapshot, details, original);
  assert.throws(() => api.assertUnknownPostgresAuthority(snapshot, { ...details, databaseNowMs: 600999 }, original));
  assert.throws(() => api.assertUnknownPostgresAuthority(snapshot, { ...details, leases: [{ ...details.leases[0], liveHeld: true }] }, original));
  assert.throws(() => api.assertUnknownPostgresAuthority(snapshot, { ...details, cases: [{ state: 'operator_required', lastError: 'CONFLICT' }] }, original));
  const released = structuredClone(snapshot); released.holds[0].state = 'released';
  assert.throws(() => api.assertUnknownPostgresAuthority(released, details, original));
  const reduced = structuredClone(snapshot);
  reduced.budget_reservations[0].tokens = '9'; reduced.budget_reservations[0].charge = '19';
  for (const counter of reduced.budgets) { counter.tokensReserved = '9'; counter.chargeReserved = '19'; }
  assert.throws(() => api.assertUnknownPostgresAuthority(reduced, details, original), /original outstanding budget fact/);
});

test('financial preservation excludes only hold classification and retains amounts and cumulative budgets', () => {
  const api = contracts();
  const before = { wallets: [{ balance: '100' }], ledger: [], entries: [], usage: 0, usage_facts: [], settlements: 0,
    settlement_facts: [], budgets: [{ tokensReserved: '10' }], budget_reservations: [{ state: 'outstanding' }],
    holds: [{ id: 'h', requestId: 'r', state: 'reserved', amount: '20', settlement: null, ledgerTransactionId: null }] };
  const after = structuredClone(before); after.holds[0].state = 'reconciliation_pending';
  assert.equal(JSON.stringify(api.preservedFinancialFacts(before)), JSON.stringify(api.preservedFinancialFacts(after)));
  after.wallets[0].balance = '99';
  assert.notEqual(JSON.stringify(api.preservedFinancialFacts(before)), JSON.stringify(api.preservedFinancialFacts(after)));
});

test('pre-aborted PostgreSQL recovery cannot query, send or stop/start a server', async () => {
  let observations = 0; let requests = 0; let destructiveActions = 0; let writes = 0;
  const api = contracts({ fetch() { requests++; }, async writeFile() { writes++; } });
  const controller = new AbortController(); controller.abort(new Error('stop profile'));
  await assert.rejects(api.runPostgresSaasRecoveryProfile({ signal: controller.signal, outputDir: '/unused',
    getDatabase() { observations++; }, stopOwnedPostgres() { destructiveActions++; }, restartOwnedPostgres() { destructiveActions++; },
  }), /stop profile/);
  assert.equal(observations, 0); assert.equal(requests, 0); assert.equal(destructiveActions, 0); assert.equal(writes, 1);
});

test('standard control-plane readiness needs both owned TCP listeners and a live unsignalled process', async () => {
  const file = path.join(root, 'scripts/ops/run-current-r9.mjs');
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ownedControlPlaneListenersReady');
  assert.ok(declaration);
  const probes: { host: string; port: number }[] = [];
  const sockets: { destroyed: boolean; timeout: number }[] = [];
  let failedPort = 0;
  let failWithTimeout = false;
  const probe = runInContext(`${declaration.getText(ast)}\nownedControlPlaneListenersReady`, createContext({ assert,
    createConnection(input: { host: string; port: number }) {
      probes.push(input);
      const state = { destroyed: false, timeout: 0 }; sockets.push(state);
      const socket = Object.assign(new EventEmitter(), {
        setTimeout(milliseconds: number) { state.timeout = milliseconds; },
        destroy() { state.destroyed = true; },
      });
      queueMicrotask(() => socket.emit(input.port === failedPort ? failWithTimeout ? 'timeout' : 'error' : 'connect'));
      return socket;
    },
    fetch() { throw new Error('control-plane readiness must not request a gateway health route'); },
  })) as (child: { exitCode: number | null; signalCode: string | null }, ports: number[]) => Promise<boolean>;
  const child = { exitCode: null, signalCode: null };
  assert.equal(await probe(child, [51000, 51001]), true);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((entry) => entry.host === '127.0.0.1'));
  assert.equal(probes.map((entry) => entry.port).join(','), '51000,51001');
  assert.ok(sockets.every((entry) => entry.destroyed && entry.timeout === 1000));
  failedPort = 51001;
  assert.equal(await probe(child, [51000, 51001]), false);
  failWithTimeout = true;
  assert.equal(await probe(child, [51000, 51001]), false);
  assert.ok(sockets.every((entry) => entry.destroyed));
  await assert.rejects(probe({ exitCode: 1, signalCode: null }, [51000, 51001]));
  await assert.rejects(probe({ exitCode: null, signalCode: 'SIGTERM' }, [51000, 51001]));
  await assert.rejects(probe(child, [51000, 51000]));
});
