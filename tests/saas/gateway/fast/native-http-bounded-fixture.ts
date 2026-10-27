// Test-only orchestration of the compiled production CLI. No runtime capability,
// preload, mock journal, pool substitution, or quarantine bypass is installed.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import ts from 'typescript';
import type { SqlExecutor } from '../../../../src/saas/db/types.js';
import {
  type BoundedOwnerActivation,
  boundedOwnerName,
  readBoundedOwnerSlots,
  verifyBoundedOwner,
} from '../../../../src/saas/gateway/fast/bounded-deployment-budget.js';
import {
  type BoundedGatewayProcessIdentity,
  type BoundedGatewayState,
  boundedGatewayProcessIsAlive,
  readBoundedGatewayState,
} from '../../../../src/server/bounded-gateway-state.js';

const SESSION_COUNT_SQL =
  "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename='model_router_saas_gateway' AND datname=current_database()";

export class NativeBoundedGatewayFixture {
  readonly agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  readonly clientSockets = new Set<Socket>();
  readonly knownProcesses = new Map<number, BoundedGatewayProcessIdentity>();
  readonly knownEpochs = new Set<string>();
  child: ChildProcess | undefined;
  private admin: Pool | undefined;
  private originalRoleLimit: number | undefined;
  private constructor(
    readonly stateDirectory: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly database: SqlExecutor,
    readonly creditCap: string,
  ) {}

  static async create(
    environment: NodeJS.ProcessEnv,
    database: SqlExecutor,
    creditCap: string,
  ): Promise<NativeBoundedGatewayFixture> {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'mr-bnd-'));
    const fixture = new NativeBoundedGatewayFixture(stateDirectory, { ...environment }, database, creditCap);
    try {
      // roleUrls() already restricted the worker target to disposable CI/nondefault
      // loopback. Admin must match that exact target; never alter an external role.
      assert.ok(environment.MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL);
      const target = new URL(environment.MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL);
      const adminUrl = new URL(process.env.SAAS_TEST_DATABASE_ADMIN_URL ?? 'invalid:');
      assert.ok(['postgres:', 'postgresql:'].includes(adminUrl.protocol));
      assert.equal(adminUrl.host, target.host);
      assert.equal(adminUrl.pathname, target.pathname);
      assert.equal(adminUrl.username, 'postgres');
      assert.equal(adminUrl.search, '');
      assert.equal(adminUrl.hash, '');
      fixture.admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
      const role = await fixture.admin.query<{ rolconnlimit: number }>(
        "SELECT rolconnlimit FROM pg_roles WHERE rolname='model_router_saas_gateway'",
      );
      assert.ok(role.rows[0]);
      fixture.originalRoleLimit = role.rows[0].rolconnlimit;
      await fixture.admin.query('ALTER ROLE model_router_saas_gateway CONNECTION LIMIT 16');
      // Only this test fixture is transpiled. Every production import resolves to
      // the actual CI build, preserving private branded objects across modules.
      await readFile(resolve('dist/cli/index.js'));
      let source = await readFile(resolve('tests/saas/gateway/fast/native-http-runtime-fixture.ts'), 'utf8');
      source = source
        .replaceAll('../../../../src/', `${resolve('dist')}/`)
        .replace("from 'undici'", `from ${JSON.stringify(require.resolve('undici'))}`);
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
      });
      const runtime = join(stateDirectory, 'runtime.cjs');
      await writeFile(runtime, compiled.outputText, { mode: 0o600 });
      // Exercise production privilege/KMS readiness, with the existing explicit
      // pilot software-KMS contract for disposable fake-money/TLS fixtures only.
      // This is not evidence qualifying a charging deployment's cloud KMS.
      fixture.environment.NODE_ENV = 'production';
      fixture.environment.MODEL_ROUTER_SAAS_SOFTWARE_KMS_ALLOW_PILOT = 'true';
      fixture.environment.MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE = runtime;
      fixture.environment.SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE = resolve(
        'dist/saas/runtime/software-provider-credential-kms.js',
      );
      // Fresh Redis still waits its actual safety horizon. Restart reuses Redis's
      // unchanged incarnation; neither test nor supervisor fabricates drained.
      delete fixture.environment.MODEL_ROUTER_FAST_REDIS_DRAINED;
      delete fixture.environment.MODEL_ROUTER_FAST_OWNER;
      assert.equal(fixture.environment.NODE_OPTIONS, undefined);
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }

  private args(action: string, generation?: string): string[] {
    return [
      resolve('dist/cli/index.js'),
      'saas:bounded-gateway',
      action,
      '--state-directory',
      this.stateDirectory,
      '--credit-cap-minor-units',
      this.creditCap,
      ...(generation ? ['--expected-generation', generation] : []),
    ];
  }
  start(generation?: string): void {
    this.child = spawn(process.execPath, this.args(generation ? 'recover' : 'start', generation), {
      cwd: process.cwd(),
      env: this.environment,
      stdio: 'ignore',
    });
    this.child.on('error', () => {});
  }
  state(): BoundedGatewayState {
    const state = readBoundedGatewayState(this.stateDirectory);
    assert.ok(state, 'production supervisor writes durable lifecycle state');
    for (const slot of state.slots) {
      if (slot?.process) this.knownProcesses.set(slot.process.pid, slot.process);
      if (slot) this.knownEpochs.add(slot.epoch);
    }
    return state;
  }
  private ownerActivation(state: BoundedGatewayState, slot: 0 | 1): BoundedOwnerActivation {
    const recorded = state.slots[slot];
    assert.ok(recorded);
    assert.equal(recorded.slot, slot);
    return {
      deploymentId: state.deploymentId,
      policyDigest: state.policyDigest,
      creditCapMinorUnits: state.creditCapMinorUnits,
      slot,
      owner: boundedOwnerName(state.deploymentId, slot),
      epoch: recorded.epoch,
    };
  }
  private async assertOwnerMarkers(state: BoundedGatewayState) {
    const slots = await readBoundedOwnerSlots(this.database, state);
    assert.equal(slots.length, 2);
    for (const slot of slots) {
      const expected = this.ownerActivation(state, slot.slot);
      assert.equal(slot.owner, expected.owner);
      assert.equal(slot.epoch, expected.epoch, 'durable activation belongs to the exact recorded process epoch');
      assert.equal(slot.active, true, 'active is a durable activation marker, not process liveness');
      await verifyBoundedOwner(this.database, expected);
    }
    return slots;
  }
  private async ownerHistory(state: BoundedGatewayState) {
    const result = await this.database.query<{ owner: string; epoch: string }>(
      `SELECT a.owner,a.epoch::text AS epoch FROM saas_fast_gateway_owner_activations a
       JOIN saas_fast_gateway_owner_slots s ON s.owner=a.owner
       WHERE s.deployment_id=$1 ORDER BY a.owner,a.epoch`,
      [state.deploymentId],
    );
    return result.rows;
  }
  async census(): Promise<void> {
    const live = [...this.knownProcesses.values()].filter(boundedGatewayProcessIsAlive);
    assert.ok(live.length <= 2, 'stop-before-start never has more than TWO native business processes');
    const sessions = await this.database.query<{ sessions: number }>(
      "SELECT count(*)::integer AS sessions FROM pg_stat_activity WHERE usename='model_router_saas_gateway' AND datname=current_database()",
    );
    assert.ok(
      (sessions.rows[0]?.sessions ?? Infinity) <= 16,
      'all gateway-role native sessions remain within the global PG16 cap',
    );
    const money = await this.database.query<{ cap: string; allocated: string; backing: string }>(
      `SELECT b.credit_cap_minor_units::text AS cap,b.allocated_minor_units::text AS allocated,
        (SELECT COALESCE(sum(a.backing_minor_units),0)::text FROM saas_fast_credit_allocations a
          WHERE a.tenant_id=b.tenant_id AND a.currency=b.currency) AS backing
       FROM saas_fast_gateway_credit_budgets b WHERE b.deployment_id=$1`,
      [this.environment.MODEL_ROUTER_SAAS_DEPLOYMENT_ID],
    );
    for (const row of money.rows) {
      assert.equal(row.cap, this.creditCap);
      assert.equal(row.allocated, row.backing, 'durable counter includes every active AND retired owner/epoch');
      assert.ok(BigInt(row.backing) <= BigInt(row.cap), 'restart never manufactures global credit headroom');
    }
  }
  async ready(previousEpochs?: readonly string[]): Promise<BoundedGatewayState> {
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline) {
      assert.ok(
        this.child && this.child.exitCode === null && this.child.signalCode === null,
        'compiled supervisor remains live through readiness',
      );
      const state = readBoundedGatewayState(this.stateDirectory);
      if (state) {
        this.state();
        await this.census();
        if (
          state.phase === 'ready' &&
          state.slots.every((slot) => slot?.phase === 'ready' && !previousEpochs?.includes(slot.epoch))
        ) {
          assert.equal(state.slots.length, 2);
          assert.equal(new Set(state.slots.map((slot) => slot?.process?.pid)).size, 2);
          if (previousEpochs) {
            const old = await this.database.query<{ remaining: number }>(
              'SELECT count(*)::integer AS remaining FROM pg_stat_activity WHERE application_name=ANY($1::text[])',
              [previousEpochs.map((epoch) => `mr-bounded-${epoch}`)],
            );
            assert.equal(old.rows[0]?.remaining, 0, 'replacement cannot overlap old native pools');
          }
          await this.assertOwnerMarkers(state);
          return state;
        }
      }
      await delay(50);
    }
    assert.fail('compiled bounded supervisor did not become ready after the real Redis quarantine');
  }
  async roll(): Promise<void> {
    const before = this.state();
    const oldEpochs = before.slots.map((slot) => {
      assert.ok(slot);
      return slot.epoch;
    });
    const control = spawn(process.execPath, this.args('roll', before.generation), {
      env: this.environment,
      stdio: 'ignore',
    });
    const [code] = await once(control, 'exit');
    assert.equal(code, 0, 'actual CLI roll sends SIGHUP for exact generation');
    const after = await this.ready(oldEpochs);
    assert.equal(after.generation, before.generation);
    for (const slot of before.slots) {
      assert.ok(slot?.process);
      assert.equal(boundedGatewayProcessIsAlive(slot.process), false);
    }
  }
  killOwner(owner: string): string {
    const state = this.state();
    const slot = state.slots.find((entry) => owner === `${state.deploymentId}:bounded-slot-${entry?.slot}`);
    assert.ok(slot?.process);
    process.kill(slot.process.pid, 'SIGKILL');
    return state.generation;
  }
  async recover(generation: string): Promise<void> {
    assert.ok(this.child);
    const deadline = Date.now() + 60_000;
    while (this.child.exitCode === null && this.child.signalCode === null && Date.now() < deadline) {
      this.state();
      await this.census();
      await delay(50);
    }
    assert.notEqual(this.child.exitCode, null, 'unexpected child death fails the complete group closed');
    assert.notEqual(this.child.exitCode, 0);
    const failed = this.state();
    assert.equal(failed.phase, 'failed');
    for (const slot of failed.slots) {
      assert.ok(slot?.process);
      assert.equal(boundedGatewayProcessIsAlive(slot.process), false);
    }
    const oldEpochs = failed.slots.map((slot) => {
      assert.ok(slot);
      return slot.epoch;
    });
    this.start(generation);
    const recovered = await this.ready(oldEpochs);
    assert.notEqual(recovered.generation, generation, 'explicit recovery creates a new fenced generation');
  }
  request(url: string, authorization: string, body: string): Promise<Response> {
    return new Promise((resolveResponse, reject) => {
      const request = httpRequest(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: { authorization, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            const headers = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              const name = response.rawHeaders[index];
              const value = response.rawHeaders[index + 1];
              assert.ok(name && value !== undefined);
              headers.append(name, value);
            }
            resolveResponse(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
          });
        },
      );
      request.on('socket', (socket) => this.clientSockets.add(socket));
      request.once('error', reject);
      request.setTimeout(10_000, () => request.destroy(new Error('bounded native request timeout')));
      request.end(body);
    });
  }
  private rememberRecordedProcesses(): void {
    const state = readBoundedGatewayState(this.stateDirectory);
    if (state) {
      assert.equal(state.deploymentId, this.environment.MODEL_ROUTER_SAAS_DEPLOYMENT_ID);
      this.state();
    }
  }
  private async stopPrimary(): Promise<void> {
    this.rememberRecordedProcesses();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit');
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child?.kill('SIGKILL'), 60_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    this.rememberRecordedProcesses();
  }
  private async assertNoSessions(query: () => Promise<{ rows: Array<{ count: number }> }>): Promise<void> {
    const deadline = Date.now() + 10_000;
    let count = -1;
    do {
      const result = await query();
      count = result.rows[0]?.count ?? -1;
      if (count === 0) break;
      await delay(50);
    } while (Date.now() < deadline);
    assert.equal(count, 0, 'all native gateway sessions must close before role-limit restoration');
  }
  async stopGracefully(): Promise<void> {
    await this.stopPrimary();
    assert.equal(this.child?.exitCode, 0, 'compiled supervisor and both workers drain successfully');
    assert.equal(this.child?.signalCode, null);
    const stopped = this.state();
    assert.equal(stopped.phase, 'closed');
    for (const slot of stopped.slots) {
      assert.ok(slot);
      assert.equal(slot.phase, 'exited');
      assert.equal(slot.exitCode, 0);
      assert.equal(slot.signal, null);
      assert.equal(slot.forced, false);
    }
    for (const identity of this.knownProcesses.values()) assert.equal(boundedGatewayProcessIsAlive(identity), false);
    await this.assertNoSessions(() => this.database.query<{ count: number }>(SESSION_COUNT_SQL));
    await this.assertOwnerMarkers(stopped);
    await this.census();
  }
  async recoverClosed(): Promise<void> {
    const before = this.state();
    assert.equal(before.phase, 'closed');
    assert.equal(this.child?.exitCode, 0);
    assert.equal(this.child?.signalCode, null);
    for (const identity of this.knownProcesses.values()) assert.equal(boundedGatewayProcessIsAlive(identity), false);
    await this.assertNoSessions(() => this.database.query<{ count: number }>(SESSION_COUNT_SQL));
    await this.assertOwnerMarkers(before);
    const oldHistory = await this.ownerHistory(before);
    const oldEpochs = oldHistory.map((entry) => entry.epoch);
    assert.equal(new Set(oldEpochs).size, oldEpochs.length, 'historical activation epochs are unique');
    for (const slot of [0, 1] as const) assert.ok(oldEpochs.includes(this.ownerActivation(before, slot).epoch));

    // Use the real compiled recover command; never release markers from the test.
    this.start(before.generation);
    const after = await this.ready(oldEpochs);
    assert.notEqual(after.generation, before.generation);
    assert.equal(after.deploymentId, before.deploymentId);
    assert.equal(after.policyDigest, before.policyDigest);
    assert.equal(after.creditCapMinorUnits, before.creditCapMinorUnits);
    assert.deepEqual(after.totals, before.totals);
    const slots = await this.assertOwnerMarkers(after);
    for (const slot of slots) {
      const old = this.ownerActivation(before, slot.slot);
      assert.equal(slot.retiredEpoch, old.epoch, 'recovery fences exactly the proven-dead prior activation');
      assert.ok(!oldEpochs.includes(slot.epoch), 'clean recovery cannot reuse any historical activation');
      await assert.rejects(verifyBoundedOwner(this.database, old), /BOUNDED_DEPLOYMENT_OWNER_NOT_ACTIVE/);
    }
    const expectedHistory = [
      ...oldHistory,
      ...slots.map(({ owner, epoch }) => ({ owner, epoch })),
    ].sort((a, b) => {
      if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
      return a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0;
    });
    assert.deepEqual(
      await this.ownerHistory(after),
      expectedHistory,
      'clean recovery adds exactly two durable activations',
    );
  }
  async close(): Promise<void> {
    this.agent.destroy();
    try {
      await this.stopPrimary();
      // Failure cleanup includes every child recorded even before readiness, and
      // signals ONLY the exact fixture-owned PID/start identity, never a port/name.
      for (const identity of this.knownProcesses.values())
        if (boundedGatewayProcessIsAlive(identity)) process.kill(identity.pid, 'SIGKILL');
      const deadline = Date.now() + 10_000;
      while ([...this.knownProcesses.values()].some(boundedGatewayProcessIsAlive) && Date.now() < deadline)
        await delay(50);
      assert.equal(
        [...this.knownProcesses.values()].some(boundedGatewayProcessIsAlive),
        false,
        'owned worker cleanup must prove process exit',
      );
      const admin = this.admin;
      if (admin && this.originalRoleLimit !== undefined) {
        await this.assertNoSessions(() => admin.query<{ count: number }>(SESSION_COUNT_SQL));
        // Never raise an old limit while a surviving native pool could reuse it.
        await admin.query(`ALTER ROLE model_router_saas_gateway CONNECTION LIMIT ${this.originalRoleLimit}`);
      }
    } finally {
      await this.admin?.end();
      await rm(this.stateDirectory, { recursive: true, force: true });
    }
  }
}
