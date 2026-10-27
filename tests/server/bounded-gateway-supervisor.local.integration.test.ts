import assert from 'node:assert/strict';
import { type ForkOptions, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createBoundedGatewayControl, requestBoundedGatewayControl } from '../../src/server/bounded-gateway-control.js';
import { readBoundedGatewayState, writeBoundedGatewayState } from '../../src/server/bounded-gateway-state.js';
import {
  type BoundedGatewaySupervisorDependencies,
  startBoundedGatewaySupervisor,
} from '../../src/server/bounded-gateway-supervisor.js';

function environment(deploymentId: string) {
  return {
    NODE_ENV: 'test',
    MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
    MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
    MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
    MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: 'redis://127.0.0.1:1',
    SAAS_GATEWAY_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: 'test-unused-kms',
    MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE: 'test-unused-runtime',
    MODEL_ROUTER_SAAS_DEPLOYMENT_ID: deploymentId,
    MODEL_ROUTER_SAAS_ENVIRONMENT_ID: 'test',
    MODEL_ROUTER_FAST_NAMESPACE: deploymentId,
    MODEL_ROUTER_SAAS_GATEWAY_BIND_ADDRESS: '127.0.0.1',
    MODEL_ROUTER_SAAS_GATEWAY_PORT: '15007',
    MODEL_ROUTER_SAAS_GATEWAY_ORIGIN: 'http://127.0.0.1:15007',
  };
}
function dependencies() {
  const live = new Set<number>();
  let peak = 0;
  const value: BoundedGatewaySupervisorDependencies = {
    execArgv: [],
    forkWorker: ((_file: string, _args: readonly string[], options: ForkOptions) => {
      assert.equal(options.env?.NODE_ENV, 'production', 'bounded mode cannot inherit test-mode privilege bypasses');
      const child = fork(resolve('tests/server/bounded-gateway-fake-worker.cjs'), [], options);
      live.add(child.pid!);
      peak = Math.max(peak, live.size);
      child.once('exit', () => live.delete(child.pid!));
      return child;
    }) as typeof fork,
    listen: (server) =>
      new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
      }),
  };
  return { value, live, peak: () => peak };
}
test('controlled rolling replacement has no third process and graceful shutdown closes both grants', {
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-super-'));
  const deps = dependencies();
  let runtime: Awaited<ReturnType<typeof startBoundedGatewaySupervisor>> | undefined;
  try {
    runtime = await startBoundedGatewaySupervisor(
      { stateDirectory: directory, creditCapMinorUnits: '1000', environment: environment(randomUUID()) },
      deps.value,
    );
    assert.equal(deps.live.size, 2);
    const previous = runtime.state.slots[0]!.epoch;
    await runtime.replaceSlot(0);
    assert.notEqual(runtime.state.slots[0]!.epoch, previous);
    assert.equal(deps.live.size, 2);
    assert.equal(deps.peak(), 2);
    assert.equal(runtime.state.totals.databasePoolMax, 16);
    await runtime.close();
    await runtime.closed;
    assert.equal(deps.live.size, 0);
    assert.equal(readBoundedGatewayState(directory)!.phase, 'closed');
    assert.ok(
      readBoundedGatewayState(directory)!.slots.every((slot) => slot?.phase === 'exited' && slot.exitCode === 0),
    );
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unexpected worker death fails the group without respawn and keeps explicit recovery history', {
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-super-'));
  const deps = dependencies();
  const previousExitCode = process.exitCode;
  let runtime: Awaited<ReturnType<typeof startBoundedGatewaySupervisor>> | undefined;
  try {
    runtime = await startBoundedGatewaySupervisor(
      { stateDirectory: directory, creditCapMinorUnits: '1000', environment: environment(randomUUID()) },
      deps.value,
    );
    const pid = runtime.state.slots[0]!.process!.pid;
    process.kill(pid, 'SIGKILL');
    await assert.rejects(runtime.closed, /BOUNDED_GATEWAY/);
    assert.equal(deps.live.size, 0);
    assert.equal(deps.peak(), 2);
    const state = readBoundedGatewayState(directory)!;
    assert.equal(state.phase, 'failed');
    assert.equal(state.slots[0]!.signal, 'SIGKILL');
    assert.ok(state.slots.every((slot) => slot?.process && slot.epoch));
  } finally {
    await runtime?.close();
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('partial startup failure stops the ready sibling and never publishes a two-worker ready state', {
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-super-'));
  const deps = dependencies();
  const previousExitCode = process.exitCode;
  try {
    await assert.rejects(
      startBoundedGatewaySupervisor(
        {
          stateDirectory: directory,
          creditCapMinorUnits: '1000',
          environment: { ...environment(randomUUID()), BOUNDED_TEST_FAIL_SLOT: '1' },
        },
        deps.value,
      ),
      /BOUNDED_GATEWAY/,
    );
    assert.equal(deps.live.size, 0);
    assert.equal(deps.peak(), 2);
    const state = readBoundedGatewayState(directory)!;
    assert.equal(state.phase, 'failed');
    assert.equal(state.slots[0]!.exitCode, 0);
    assert.equal(state.slots[1]!.exitCode, 2);
  } finally {
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('state write failure during stop still waits for both actual child exits before singleton release', {
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-super-'));
  const deps = dependencies();
  let writesFail = false;
  const previousExitCode = process.exitCode;
  let runtime: Awaited<ReturnType<typeof startBoundedGatewaySupervisor>> | undefined;
  try {
    runtime = await startBoundedGatewaySupervisor(
      { stateDirectory: directory, creditCapMinorUnits: '1000', environment: environment(randomUUID()) },
      {
        ...deps.value,
        writeState: (path, state) => {
          if (writesFail) throw new Error('injected EIO');
          writeBoundedGatewayState(path, state);
        },
      },
    );
    writesFail = true;
    await runtime.close();
    await assert.rejects(runtime.closed, /BOUNDED_GATEWAY/);
    assert.equal(deps.live.size, 0, 'shutdown cannot release singleton or return while either child is alive');
    assert.ok(runtime.state.slots.every((slot) => slot?.phase === 'exited'));
  } finally {
    await runtime?.close();
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('generation-authenticated private control replaces persisted PID signaling', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-super-'));
  const deps = dependencies();
  let runtime: Awaited<ReturnType<typeof startBoundedGatewaySupervisor>> | undefined;
  try {
    runtime = await startBoundedGatewaySupervisor(
      { stateDirectory: directory, creditCapMinorUnits: '1000', environment: environment(randomUUID()) },
      deps.value,
    );
    await assert.rejects(requestBoundedGatewayControl(directory, randomUUID(), 'stop'));
    assert.equal(deps.live.size, 2);
    await requestBoundedGatewayControl(directory, runtime.state.generation, 'stop');
    await runtime.closed;
    assert.equal(deps.live.size, 0);
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown awaits in-progress control startup and closes it before releasing process ownership', {
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-super-'));
  const deps = dependencies();
  const previousExitCode = process.exitCode;
  let controlClosed = false;
  try {
    await assert.rejects(
      startBoundedGatewaySupervisor(
        { stateDirectory: directory, creditCapMinorUnits: '1000', environment: environment(randomUUID()) },
        {
          ...deps.value,
          createControl: async (path, generation, accept) => {
            const control = await createBoundedGatewayControl(path, generation, accept);
            process.emit('SIGTERM');
            await new Promise<void>((resolve) => setImmediate(resolve));
            return {
              async close() {
                await control.close();
                controlClosed = true;
              },
            };
          },
        },
      ),
      /BOUNDED_GATEWAY_STOPPED/,
    );
    assert.equal(controlClosed, true, 'control bind cannot outlive completed supervisor shutdown');
    assert.equal(deps.live.size, 0);
  } finally {
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('control post-bind permission failure closes its listener before rejecting', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mr-control-'));
  const generation = randomUUID();
  try {
    await assert.rejects(
      createBoundedGatewayControl(
        directory,
        generation,
        () => undefined,
        () => {
          throw new Error('injected chmod failure');
        },
      ),
      /injected chmod failure/,
    );
    await assert.rejects(requestBoundedGatewayControl(directory, generation, 'stop'));
    const replacement = await createBoundedGatewayControl(directory, generation, () => undefined);
    await replacement.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
