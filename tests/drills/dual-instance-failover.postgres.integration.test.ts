import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../src/saas/db/index.js';
import {
  anyRoleConfigured,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../saas/metering/normal-success-postgres-fixture.js';

// OPS-01 I3 dual-instance failover drill (Track I): two isolated child
// processes assemble the managed-saas startup gate chain (B2 order: ping ->
// schema -> control-plane unknown-outcome -> runtime ACL -> KMS readiness)
// against the same database, then compete for ONE real PostgreSQL provider
// account lease (fencing-token authority, database clock TTL). The drill
// SIGKILLs the holder, proves the surviving instance's gates stay green and
// the lease/capacity authority fails over exactly once via PostgreSQL, then
// restarts the killed instance and proves it passes the gates again and
// re-acquires only after the survivor gracefully releases.
const CHILD = 'scripts/drills/instance-child.mjs';
const LEASE_TTL_MS = 2_000;

interface Marker {
  readonly kind: string;
  readonly sequence: number;
  readonly wallTimeMs?: number;
  readonly monotonicMs?: number;
  readonly operationDurationMs?: number;
  readonly sinceAckMs?: number;
  readonly stage?: string;
  readonly code?: string;
  readonly instanceId?: string;
  readonly role?: string;
  readonly gate?: string;
  readonly ok?: boolean;
  readonly fencingToken?: string;
  readonly renewals?: number;
  readonly clean?: boolean;
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

interface LeaseInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly evidenceId: string;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly publicModel: string;
}

function spawnInstance(
  root: string,
  databaseUrl: string,
  inputsPath: string,
  progressPath: string,
  instanceId: string,
  mode: 'hold' | 'once',
) {
  // Fixed minimal env: no inherited credentials, PG overrides or user config.
  // The role URL travels only through this env, never through argv.
  const args = [
    '--import',
    'tsx',
    CHILD,
    '--inputs',
    inputsPath,
    '--progress',
    progressPath,
    '--instance-id',
    instanceId,
    '--mode',
    mode,
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: 'test',
      MODEL_ROUTER_SAAS_DRILL_INSTANCE_URL: databaseUrl,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // The child never prints URLs/secrets by contract; drain stderr regardless.
  child.stderr?.resume();
  const exit = new Promise<ChildExit>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit };
}

async function untilMarker(
  progressPath: string,
  predicate: (marker: Marker) => boolean,
  label: string,
  exits: readonly Promise<ChildExit>[],
  timeoutMs = 90_000,
  check?: (observed: readonly Marker[]) => void,
): Promise<Marker> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = markers(progressPath);
    check?.(observed);
    const found = observed.find(predicate);
    if (found) return found;
    const raced = await Promise.race([
      Promise.race(exits.map((exit) => exit.then((value) => ({ exit: value }) as const))),
      new Promise<undefined>((resolvePoll) => setTimeout(() => resolvePoll(undefined), 25)),
    ]);
    if (raced && 'exit' in raced) {
      throw new Error(`a drill child exited before marker ${label}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for drill marker ${label}`);
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

function writeInputs(dir: string, instanceId: string, lease: LeaseInput): string {
  const inputsPath = join(dir, `${instanceId}.inputs.json`);
  writeFileSync(inputsPath, JSON.stringify({ role: 'gateway', leaseTtlMs: LEASE_TTL_MS, lease }));
  return inputsPath;
}

interface LeaseRow {
  readonly fencing_token: string;
  readonly status: string;
  readonly attempt_id: string;
  readonly live: boolean;
  readonly db_now: string;
  readonly lease_expires_at: string;
  readonly updated_at: string;
  readonly remaining_ms: string;
}

test('OPS-01 I3: dual-instance SIGKILL failover keeps gates green and PostgreSQL lease authority exact', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require the failover drill`
      : false,
  timeout: 300_000,
  concurrency: false,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const root = resolve(process.cwd());
  const migrator = observedDatabase(urls[0]);
  const controlPlane = observedDatabase(urls[1]);
  const gateway = observedDatabase(urls[2]);
  const scratch = mkdtempSync(join(tmpdir(), 'ops01-failover-drill-'));
  const progressPath = join(scratch, 'progress.jsonl');
  const children: Array<{ child: ChildProcess }> = [];
  let diagnosticStage = 'startup';
  let survivorStopRequestedAt: number | undefined;
  let continuity: { instanceId: string; token: string; sequence: number } | undefined;
  function assertContinuity(observed: readonly Marker[] = markers(progressPath)): void {
    if (!continuity) return;
    const current = observed.filter((entry) =>
      entry.instanceId === continuity!.instanceId && entry.sequence >= continuity!.sequence);
    assert.equal(current.filter((entry) => entry.kind === 'lease-acquired').length, 1,
      'survivor cannot reacquire before intentional SIGTERM');
    assert.ok(current.every((entry) => !['lease-lost', 'failed', 'shutdown'].includes(entry.kind)),
      'survivor lease continuity must not be lost before intentional SIGTERM');
    assert.ok(current.every((entry) => entry.fencingToken === undefined || entry.fencingToken === continuity!.token),
      'survivor must retain the exact failover fencing token');
  }
  t.after(async () => {
    // Observe before killing children/removing scratch. Never emit raw errors.
    try {
      const observed = markers(progressPath);
      const selected = observed.slice(-120).map((entry) => ({
        kind: entry.kind, instanceId: entry.instanceId, sequence: entry.sequence,
        wallTimeMs: entry.wallTimeMs, monotonicMs: entry.monotonicMs,
        fencingToken: entry.fencingToken, renewals: entry.renewals,
        operationDurationMs: entry.operationDurationMs, sinceAckMs: entry.sinceAckMs,
        gate: entry.gate, ok: entry.ok, clean: entry.clean, stage: entry.stage,
        code: entry.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.code) ? entry.code : undefined,
      }));
      const rows = await leaseRows().catch(() => null);
      t.diagnostic('failover evidence ' + JSON.stringify({
        stage: diagnosticStage, leaseTtlMs: LEASE_TTL_MS, survivorStopRequestedAt,
        markerCount: observed.length, markerTail: selected, databaseRows: rows,
        authorityEvents: observed.filter((entry) =>
          ['lease-acquired', 'lease-lost', 'failed', 'shutdown'].includes(entry.kind))
          .map(({ kind, instanceId, sequence, fencingToken, wallTimeMs, monotonicMs }) =>
            ({ kind, instanceId, sequence, fencingToken, wallTimeMs, monotonicMs })),
      }));
    } catch {
      t.diagnostic('failover evidence unavailable; original assertion remains authoritative');
    }
    await phase('cleanup', async () => {
      for (const entry of children) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([gateway.database.close(), controlPlane.database.close(), migrator.database.close()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('failover-drill cleanup deadline')), 30_000);
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

  const accountId = `drill-account-${randomUUID()}`;
  const upstreamId = `drill-upstream-${randomUUID()}`;
  const tenantId = randomUUID();
  const publicModel = `drill-model-${randomUUID()}`;
  await phase('setup', async () => {
    // The shared commercial fixture keeps this root inside the isolated-gate
    // fixture contract while the drill seeds its own lease authority below.
    await seedFixture(migrator.database, gateway.database, 'platform');
    const providerId = `drill-provider-${randomUUID()}`;
    const productId = `drill-product-${randomUUID()}`;
    const rightsId = `drill-rights-${randomUUID()}`;
    await migrator.database.transaction(async (tx) => {
      assert.equal(
        (
          await tx.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [
            tenantId,
            `drill-tenant-${tenantId}`,
          ])
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await tx.query(
            'INSERT INTO saas_provider_products (provider_id, product_id, display_name) VALUES ($1, $2, $3)',
            [providerId, productId, 'OPS-01 failover drill fixture'],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await tx.query(
            `INSERT INTO saas_provider_rights
           (rights_id, version, provider_id, product_id, credential_type, supply_mode, region, purpose,
            model_scope, endpoint_scope, effective_at, approval_ref, status, evidence_ref, evidence_sha256)
         VALUES ($1, 1, $2, $3, 'api-key', 'platform', 'drill', 'inference',
                 ARRAY[$4], ARRAY['/v1/chat/completions'],
                 clock_timestamp() - interval '1 minute', $5, 'active', $5, $6)`,
            [rightsId, providerId, productId, publicModel, `drill-evidence-${rightsId}`, 'd'.repeat(64)],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await tx.query(
            `INSERT INTO saas_platform_provider_accounts
           (id, display_name, provider_id, product_id, credential_type, region, purpose,
            rights_id, rights_version, status, validation_state)
         VALUES ($1, 'OPS-01 drill account', $2, $3, 'api-key', 'drill', 'inference', $4, 1, 'active', 'verified')`,
            [accountId, providerId, productId, rightsId],
          )
        ).rowCount,
        1,
      );
    });
  });

  function leaseInput(attemptId: string): LeaseInput {
    return {
      tenantId,
      projectId: randomUUID(),
      requestId: randomUUID(),
      attemptId,
      evidenceId: randomUUID(),
      accountId,
      upstreamId,
      publicModel,
    };
  }

  async function leaseRows(): Promise<LeaseRow[]> {
    return phase('snapshot', async () => {
      const result = await migrator.database.query<LeaseRow>(
        `SELECT fencing_token::text, status, attempt_id,
                clock_timestamp()::text AS db_now, lease_expires_at::text, updated_at::text,
                (EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000)::text AS remaining_ms,
                lease_expires_at > clock_timestamp() AS live
           FROM saas_provider_account_leases
          WHERE account_id = $1
          ORDER BY fencing_token`,
        [accountId],
      );
      return result.rows;
    });
  }

  function liveLease(rows: readonly LeaseRow[]): LeaseRow | undefined {
    const live = rows.filter((row) => row.status === 'held' && row.live);
    assert.ok(live.length <= 1, 'PostgreSQL lease authority must never show two live holders for one account');
    return live[0];
  }

  function startHold(instanceId: string, attemptId: string) {
    const inputsPath = writeInputs(scratch, instanceId, leaseInput(attemptId));
    const started = spawnInstance(root, urls[2], inputsPath, progressPath, instanceId, 'hold');
    children.push(started);
    return started;
  }

  // Instance A assembles its gates and takes the lease.
  diagnosticStage = 'holder-startup';
  const attemptA = randomUUID();
  const instanceA = startHold('a', attemptA);
  const readyA = await untilMarker(
    progressPath,
    (marker) => marker.kind === 'ready' && marker.instanceId === 'a',
    'a:ready',
    [instanceA.exit],
  );
  assert.equal(readyA.role, 'gateway');
  const acquiredA = await untilMarker(
    progressPath,
    (marker) => marker.kind === 'lease-acquired' && marker.instanceId === 'a' && marker.sequence > readyA.sequence,
    'a:lease-acquired',
    [instanceA.exit],
  );
  const tokenA = acquiredA.fencingToken ?? '';

  // Instance B assembles the same gates but stays fenced out while A holds.
  diagnosticStage = 'contender-startup';
  const attemptB = randomUUID();
  const instanceB = startHold('b', attemptB);
  const readyB = await untilMarker(progressPath, (marker) => marker.kind === 'ready' && marker.instanceId === 'b', 'b:ready', [
    instanceA.exit,
    instanceB.exit,
  ]);
  await untilMarker(
    progressPath,
    (marker) => marker.kind === 'lease-pending' && marker.instanceId === 'b' && marker.sequence > readyB.sequence,
    'b:lease-pending',
    [instanceA.exit, instanceB.exit],
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
  assert.equal(
    markers(progressPath).some((marker) => marker.kind === 'lease-acquired' && marker.instanceId === 'b'),
    false,
    'the surviving instance must stay fenced out while the holder keeps renewing',
  );
  const heldByA = liveLease(await leaseRows());
  assert.equal(heldByA?.attempt_id, attemptA, 'PostgreSQL shows exactly A as the live lease holder');

  // SIGKILL the holder mid-renewal: the process must die by the real signal.
  diagnosticStage = 'sigkill-failover';
  instanceA.child.kill('SIGKILL');
  const crash = await boundedExit(instanceA.exit, 15_000);
  assert.equal(crash.signal, 'SIGKILL', 'the killed instance must die by the real signal, not gracefully');

  // Failover: B acquires exactly once the PostgreSQL lease clock expires A's
  // lease, with a strictly higher fencing token. A never released anything.
  const acquiredB = await untilMarker(
    progressPath,
    (marker) => marker.kind === 'lease-acquired' && marker.instanceId === 'b',
    'b:lease-acquired',
    [instanceB.exit],
    30_000,
  );
  const tokenB = acquiredB.fencingToken ?? '';
  continuity = { instanceId: 'b', token: tokenB, sequence: acquiredB.sequence };
  assertContinuity();
  assert.ok(BigInt(tokenB) > BigInt(tokenA), 'fencing tokens must strictly increase across failover');
  const rowsAfterFailover = await leaseRows();
  const heldByB = liveLease(rowsAfterFailover);
  assert.equal(heldByB?.attempt_id, attemptB, 'exactly one live holder after failover: the survivor');
  assert.equal(
    rowsAfterFailover.find((row) => row.fencing_token === tokenA)?.status,
    'expired',
    'the crashed instance lease is marked expired by PostgreSQL authority, never released by the dead process',
  );
  t.diagnostic(`failover fencing: ${tokenA} (killed) -> ${tokenB} (survivor)`);

  // The surviving instance keeps renewing (authority continuously held) and
  // both roles' startup gate chains still pass after the kill.
  await untilMarker(
    progressPath,
    (marker) => marker.kind === 'lease-renewed' && marker.instanceId === 'b' &&
      marker.fencingToken === tokenB && marker.sequence > acquiredB.sequence && Number(marker.renewals) >= 3,
    'b:lease-renewed>=3',
    [instanceB.exit],
    30_000,
    assertContinuity,
  );
  diagnosticStage = 'post-failover-gate-probes';
  for (const [probeId, probeUrl, probeRole] of [
    ['probe-gateway', urls[2], 'gateway'],
    ['probe-control-plane', urls[1], 'control-plane'],
  ] as const) {
    const probeInputs = join(scratch, `${probeId}.inputs.json`);
    writeFileSync(probeInputs, JSON.stringify({ role: probeRole }));
    const probe = spawnInstance(root, probeUrl, probeInputs, progressPath, probeId, 'once');
    children.push(probe);
    const probeExit = await boundedExit(probe.exit, 90_000);
    assert.equal(probeExit.signal, null);
    assert.equal(probeExit.code, 0, `the ${probeRole} gate chain must stay green after the failover`);
    const probeMarkers = markers(progressPath).filter((marker) => marker.instanceId === probeId);
    assert.ok(probeMarkers.some((marker) => marker.kind === 'ready'));
    assert.ok(probeMarkers.some((marker) => marker.kind === 'shutdown' && marker.clean === true));
    assertContinuity();
  }

  // Restart the killed instance: it passes the gates again but stays fenced
  // out until the survivor gracefully releases.
  diagnosticStage = 'restarted-contender';
  assertContinuity();
  const attemptA2 = randomUUID();
  const instanceA2 = startHold('a2', attemptA2);
  const readyA2 = await untilMarker(
    progressPath, (marker) => marker.kind === 'ready' && marker.instanceId === 'a2', 'a2:ready',
    [instanceB.exit, instanceA2.exit], 90_000, assertContinuity,
  );
  await untilMarker(
    progressPath,
    (marker) => marker.kind === 'lease-pending' && marker.instanceId === 'a2' && marker.sequence > readyA2.sequence,
    'a2:lease-pending',
    [instanceB.exit, instanceA2.exit],
    90_000,
    assertContinuity,
  );
  const renewalCursor = Math.max(0, ...markers(progressPath)
    .filter((entry) => entry.instanceId === 'b').map((entry) => entry.sequence));
  await untilMarker(
    progressPath, (marker) => marker.kind === 'lease-renewed' && marker.instanceId === 'b' &&
      marker.fencingToken === tokenB && marker.sequence > renewalCursor,
    'b:fresh-renewal-after-a2-pending', [instanceB.exit, instanceA2.exit], 30_000, assertContinuity,
  );
  const beforeRelease = liveLease(await leaseRows());
  assert.equal(beforeRelease?.attempt_id, attemptB, 'the restarted instance does not steal the lease');
  assert.equal(beforeRelease?.fencing_token, tokenB, 'the survivor retains its exact original token');
  assertContinuity();

  diagnosticStage = 'intentional-survivor-release';
  survivorStopRequestedAt = Date.now();
  continuity = undefined;
  instanceB.child.kill('SIGTERM');
  const gracefulB = await boundedExit(instanceB.exit, 30_000);
  assert.equal(gracefulB.signal, null);
  assert.equal(gracefulB.code, 0, 'the surviving instance shuts down cleanly and releases the lease');
  const acquiredA2 = await untilMarker(
    progressPath,
    (marker) => marker.kind === 'lease-acquired' && marker.instanceId === 'a2',
    'a2:lease-acquired',
    [instanceA2.exit],
    30_000,
  );
  const tokenA2 = acquiredA2.fencingToken ?? '';
  assert.ok(BigInt(tokenA2) > BigInt(tokenB), 'the restarted instance acquires only a newer fencing token');

  instanceA2.child.kill('SIGTERM');
  const gracefulA2 = await boundedExit(instanceA2.exit, 30_000);
  assert.equal(gracefulA2.signal, null);
  assert.equal(gracefulA2.code, 0);

  // Terminal authority facts: three acquisitions, strictly increasing fencing,
  // every lease resolved (expired by authority or released by its live owner),
  // and no live holder remaining after the final graceful shutdown.
  const terminal = await leaseRows();
  assert.deepEqual(
    terminal.map((row) => row.fencing_token),
    [tokenA, tokenB, tokenA2],
    'exactly three acquisitions in fencing order; no phantom or duplicate grants',
  );
  assert.deepEqual(
    terminal.map((row) => row.attempt_id),
    [attemptA, attemptB, attemptA2],
  );
  assert.equal(terminal.find((row) => row.fencing_token === tokenA)?.status, 'expired');
  assert.equal(terminal.find((row) => row.fencing_token === tokenB)?.status, 'released');
  assert.equal(terminal.find((row) => row.fencing_token === tokenA2)?.status, 'released');
  assert.equal(liveLease(terminal), undefined, 'no live lease remains after both graceful shutdowns');
  diagnosticStage = 'complete';
});

