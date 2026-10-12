import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../src/saas/db/index.js';
import type { SqlExecutor } from '../../src/saas/db/types.js';
import {
  anyRoleConfigured,
  FIN057_FIXTURE_HMAC_HEX,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../saas/metering/normal-success-postgres-fixture.js';

// FIN-01 F3 crash cell (A3, base script shared with Track I): a real child
// process settles prepared requests through the conditional settlement port,
// is SIGKILLed mid-flight, and a second child re-attempts every input. The
// proof is exactly-once: each request settles once, replays add nothing, the
// wallet projection equals the ledger and every transaction stays balanced.
const CHILD = 'scripts/drills/settlement-crash-child.mjs';
const REQUESTS = 4;

interface Marker {
  readonly runId: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly kind: string;
}

function markers(progressPath: string): Marker[] {
  let text: string;
  try {
    text = readFileSync(progressPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Marker);
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function spawnChild(root: string, gatewayUrl: string, inputsPath: string, progressPath: string, runId: string) {
  // Fixed minimal env: no inherited credentials, PG overrides or user config.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, '--inputs', inputsPath, '--progress', progressPath, '--run-id', runId],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'test',
        MODEL_ROUTER_SAAS_DRILL_GATEWAY_URL: gatewayUrl,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  // The child never prints URLs/secrets by contract; drain stderr regardless.
  child.stderr?.resume();
  const exit = new Promise<ChildExit>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit };
}

async function untilMarkers(progressPath: string, count: number, childExit: Promise<ChildExit>): Promise<Marker[]> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = markers(progressPath);
    if (found.length >= count) return found;
    const raced = await Promise.race([
      childExit.then((exit) => ({ exit }) as const),
      new Promise<undefined>((resolvePoll) => setTimeout(() => resolvePoll(undefined), 25)),
    ]);
    if (raced && 'exit' in raced) {
      throw new Error(`drill child exited before ${count} committed markers`);
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for committed settlement markers');
  }
}

async function boundedExit(exit: Promise<ChildExit>, timeoutMs: number): Promise<ChildExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('drill child did not exit within the bounded deadline')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertSettledOnce(migrator: SqlExecutor, tenantId: string): Promise<void> {
  await phase('snapshot', async () => {
    const row = (
      await migrator.query<{
        usage: string;
        settlements: string;
        billingTransactions: string;
        entries: string;
        balance: string;
        walletLedger: string;
        unbalanced: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1) AS usage,
          (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1) AS settlements,
          (SELECT count(*)::text FROM saas_ledger_transactions
             WHERE tenant_id = $1 AND source_type = 'billing_settlement') AS "billingTransactions",
          (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS entries,
          (SELECT COALESCE(sum(posted_balance_minor_units), 0)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
          (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END), 0)::text
             FROM saas_ledger_entries WHERE tenant_id = $1 AND wallet_id IS NOT NULL) AS "walletLedger",
          (SELECT count(*)::text FROM (
             SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
              WHERE l.tenant_id = $1 GROUP BY l.id, l.amount_minor_units
              HAVING count(e.id) <> 2 OR
                COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
                COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
           ) invalid) AS unbalanced`,
        [tenantId],
      )
    ).rows[0];
    assert.ok(row);
    assert.equal(row.usage, '1', 'each crashed request records exactly one usage event');
    assert.equal(row.settlements, '1', 'each crashed request settles exactly once');
    assert.equal(row.billingTransactions, '1', 'exactly one settlement ledger transaction');
    assert.equal(row.entries, '4', 'reservation + settlement balanced pairs only');
    assert.equal(row.balance, '88', 'funded 100 minus the single 12 charge');
    assert.equal(row.balance, row.walletLedger, 'wallet projection equals the ledger');
    assert.equal(row.unbalanced, '0');
  });
}

test('FIN-01 F3: SIGKILL mid-settlement never double-charges; restart replays to exactly-once', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require the crash drill`
      : false,
  timeout: 300_000,
  concurrency: false,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const root = resolve(process.cwd());
  const migrator = observedDatabase(urls[0]);
  const controlPlane = observedDatabase(urls[1]);
  const gateway = observedDatabase(urls[2]);
  const scratch = mkdtempSync(join(tmpdir(), 'fin01-crash-drill-'));
  t.after(async () => {
    await phase('cleanup', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([gateway.database.close(), controlPlane.database.close(), migrator.database.close()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('crash-drill cleanup deadline')), 30_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      rmSync(scratch, { recursive: true, force: true });
    });
  });
  await phase('readiness', async () => {
    await migrator.database.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane.database, 'control_plane');
  });

  const fixtures = [];
  for (let index = 0; index < REQUESTS; index += 1) {
    fixtures.push(await seedFixture(migrator.database, gateway.database, 'platform'));
  }
  const inputsPath = join(scratch, 'inputs.json');
  const progressPath = join(scratch, 'progress.jsonl');
  writeFileSync(
    inputsPath,
    JSON.stringify({
      idempotencyHmacHex: FIN057_FIXTURE_HMAC_HEX,
      inputs: fixtures.map((fixture) => fixture.input),
    }),
  );

  // Run 1: kill the child after at least one settlement has committed, so the
  // kill lands inside the in-flight window of a later request.
  const first = spawnChild(root, urls[2], inputsPath, progressPath, 'run-1');
  t.after(() => {
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
  });
  const crashedAt = await untilMarkers(progressPath, 1, first.exit);
  first.child.kill('SIGKILL');
  const crash = await boundedExit(first.exit, 15_000);
  assert.equal(crash.signal, 'SIGKILL', 'the drill child must die by the real signal, not gracefully');

  // Run 2: a fresh process re-attempts every input; the port must replay the
  // committed ones and settle the rest, each exactly once.
  const second = spawnChild(root, urls[2], inputsPath, progressPath, 'run-2');
  t.after(() => {
    if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill('SIGKILL');
  });
  const recovered = await boundedExit(second.exit, 120_000);
  assert.equal(recovered.signal, null);
  assert.equal(recovered.code, 0, 'recovery child must complete every input without an error');

  const all = markers(progressPath);
  const byRequest = new Map<string, Marker[]>();
  for (const marker of all) {
    byRequest.set(marker.requestId, [...(byRequest.get(marker.requestId) ?? []), marker]);
  }
  assert.equal(byRequest.size, REQUESTS, 'every request reached a terminal marker');
  for (const [requestId, entries] of byRequest) {
    const settled = entries.filter((entry) => entry.kind === 'settled');
    assert.equal(settled.length, 1, `request ${requestId} settled exactly once across the crash`);
    for (const entry of entries) assert.ok(['settled', 'replayed'].includes(entry.kind));
  }
  t.diagnostic(`kill window: ${crashedAt.length}/${REQUESTS} committed before SIGKILL`);

  for (const fixture of fixtures) await assertSettledOnce(migrator.database, fixture.tenantId);
});
