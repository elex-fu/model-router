import { type ChildProcess, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { type DeploymentEnvironment, parseDeploymentConfig } from '../saas/deployment.js';
import {
  type BoundedGatewayBudgets,
  BoundedGatewayPermits,
  type BoundedGatewaySlot,
  boundedGatewayBudgets,
  boundedGatewayWorkerBudgets,
} from './bounded-gateway-budgets.js';
import { createBoundedGatewayControl } from './bounded-gateway-control.js';
import { createBoundedGatewayDispatcher } from './bounded-gateway-dispatcher.js';
import type { BoundedGatewayWorkerConfiguration, BoundedGatewayWorkerMessage } from './bounded-gateway-protocol.js';
import {
  acquireBoundedGatewayState,
  type BoundedGatewaySlotState,
  type BoundedGatewayState,
  boundedGatewayBootId,
  boundedGatewayMachineId,
  boundedGatewayProcessIdentity,
  writeBoundedGatewayState,
} from './bounded-gateway-state.js';
import { managedQuotaPoolBudget } from './managed-saas-quota-pool.js';

export interface BoundedGatewaySupervisorOptions {
  readonly stateDirectory: string;
  readonly creditCapMinorUnits: string;
  readonly budgets?: Partial<BoundedGatewayBudgets>;
  readonly recoverGeneration?: string;
  readonly maximumBodyBytes?: number;
  readonly maximumConnections?: number;
  readonly requestTimeoutMs?: number;
  readonly startupMs?: number;
  readonly shutdownMs?: number;
  readonly environment?: DeploymentEnvironment;
}
/** Embedded tests only; the production CLI never accepts a fork/listen override. */
export interface BoundedGatewaySupervisorDependencies {
  readonly forkWorker?: typeof fork;
  readonly writeState?: typeof writeBoundedGatewayState;
  readonly createControl?: typeof createBoundedGatewayControl;
  readonly execArgv?: readonly string[];
  readonly listen?: (server: Server, port: number, address: string, signal: AbortSignal) => Promise<void>;
}
/** Credentials can rotate, but endpoint, login and query options cannot change during recovery. */
export function boundedGatewayConnectionScope(value: string): string {
  const url = new URL(value);
  if (!url.hostname || (!url.username && ['postgres:', 'postgresql:'].includes(url.protocol)))
    throw new Error('BOUNDED_GATEWAY_EXPLICIT_DATABASE_LOGIN_REQUIRED');
  if (url.hash) throw new Error('BOUNDED_GATEWAY_CONNECTION_FRAGMENT_FORBIDDEN');
  // Query overrides can redirect pg's effective endpoint/login behind the visible authority.
  for (const name of url.searchParams.keys()) {
    if (
      ['host', 'port', 'user', 'password', 'database', 'dbname', 'options', 'application_name'].includes(
        name.toLowerCase(),
      )
    ) {
      throw new Error('BOUNDED_GATEWAY_DATABASE_IDENTITY_OVERRIDE_FORBIDDEN');
    }
  }
  url.password = '';
  url.searchParams.sort();
  return createHash('sha256').update(url.toString()).digest('hex');
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('BOUNDED_GATEWAY_INVALID_BOUND');
  return value;
}
function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** No Redis/PG/business imports in the primary; it owns routing and fixed native-resource grants only. */
export async function startBoundedGatewaySupervisor(
  options: BoundedGatewaySupervisorOptions,
  dependencies: BoundedGatewaySupervisorDependencies = {},
): Promise<{
  readonly state: BoundedGatewayState;
  readonly closed: Promise<void>;
  replaceSlot(slot: BoundedGatewaySlot): Promise<void>;
  close(): Promise<void>;
}> {
  const inherited = options.environment ?? process.env;
  if (inherited.NODE_OPTIONS || (dependencies.execArgv ?? process.execArgv).length)
    throw new Error('BOUNDED_GATEWAY_PRELOADS_FORBIDDEN');
  if (inherited.PGOPTIONS) throw new Error('BOUNDED_GATEWAY_DATABASE_IDENTITY_OVERRIDE_FORBIDDEN');
  const environment: DeploymentEnvironment = {
    ...inherited,
    NODE_ENV: 'production',
    MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
    MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
  };
  const deployment = parseDeploymentConfig(environment);
  if (deployment.mode !== 'managed-saas' || deployment.workloadRole !== 'gateway' || !deployment.gatewayRedisUrl) {
    throw new Error('BOUNDED_GATEWAY_GATEWAY_REDIS_REQUIRED');
  }
  const deploymentId = deployment.deploymentId;
  if (!deploymentId || !/^[a-zA-Z0-9_:-]{1,128}$/.test(deploymentId) || !environment.MODEL_ROUTER_FAST_NAMESPACE) {
    throw new Error('BOUNDED_GATEWAY_STABLE_DEPLOYMENT_REQUIRED');
  }
  if (
    !/^[1-9][0-9]*$/.test(options.creditCapMinorUnits) ||
    BigInt(options.creditCapMinorUnits) < 2n ||
    BigInt(options.creditCapMinorUnits) > 9223372036854775807n
  )
    throw new Error('BOUNDED_GATEWAY_INVALID_CREDIT_CAP');
  const totals = boundedGatewayBudgets(options.budgets);
  const local = boundedGatewayWorkerBudgets(totals);
  const maximumBodyBytes = integer(options.maximumBodyBytes ?? 16 * 1024 * 1024, 1, 256 * 1024 * 1024);
  const maximumConnections = integer(options.maximumConnections ?? totals.httpInFlight * 2 + 16, 2, 65536);
  const requestTimeoutMs = integer(options.requestTimeoutMs ?? 120_000, 1000, 3_600_000);
  const startupMs = integer(options.startupMs ?? 240_000, 1000, 600_000);
  const shutdownMs = integer(options.shutdownMs ?? 45_000, 11_000, 300_000);
  const policyDigest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        totals,
        creditCapMinorUnits: options.creditCapMinorUnits,
        databaseScope: boundedGatewayConnectionScope(deployment.postgresUrl),
        redisScope: boundedGatewayConnectionScope(deployment.gatewayRedisUrl),
        namespace: environment.MODEL_ROUTER_FAST_NAMESPACE,
        maximumBodyBytes,
        maximumConnections,
        requestTimeoutMs,
      }),
    )
    .digest('hex');
  const machineId = boundedGatewayMachineId();
  const primary = boundedGatewayProcessIdentity(process.pid);
  const ownership = await acquireBoundedGatewayState(options.stateDirectory, deploymentId, options.recoverGeneration);
  const previous = ownership.previous;
  if (
    previous &&
    (previous.policyDigest !== policyDigest || previous.creditCapMinorUnits !== options.creditCapMinorUnits)
  ) {
    await ownership.release();
    throw new Error('BOUNDED_GATEWAY_RECOVERY_POLICY_CONFLICT');
  }
  const state: BoundedGatewayState = {
    version: 1,
    deploymentId,
    machineId,
    bootId: boundedGatewayBootId(),
    generation: randomUUID(),
    primary,
    totals,
    creditCapMinorUnits: options.creditCapMinorUnits,
    policyDigest,
    phase: 'starting',
    slots: [null, null],
  };
  const permits = new BoundedGatewayPermits(local.httpInFlight);
  const terminated = deferred<void>();
  const workers = new Map<
    BoundedGatewaySlot,
    {
      child: ChildProcess;
      row: BoundedGatewaySlotState;
      ready: ReturnType<typeof deferred<void>>;
      exited: ReturnType<typeof deferred<void>>;
      startupTimer: ReturnType<typeof setTimeout>;
      intentional: boolean;
      healthAt: number;
    }
  >();
  const reservations = new Map<
    string,
    {
      slot: BoundedGatewaySlot;
      epoch: string;
      completion: ReturnType<typeof deferred<void>>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let stopping: Promise<void> | undefined;
  let failed = false;
  let replacing = false;
  const listenerAbort = new AbortController();
  let listenerStartup: Promise<void> | undefined;
  const socketPath = (slot: BoundedGatewaySlot, epoch: string) =>
    join(options.stateDirectory, `worker-${slot}-${epoch}.sock`);
  if (Buffer.byteLength(socketPath(0, randomUUID())) >= 104) {
    await ownership.release();
    throw new Error('BOUNDED_GATEWAY_SOCKET_PATH_TOO_LONG');
  }
  const record = () => (dependencies.writeState ?? writeBoundedGatewayState)(options.stateDirectory, state);
  let controlStartup: ReturnType<typeof createBoundedGatewayControl> | undefined;
  const fail = (code: string) => {
    failed = true;
    state.lastError = code;
    void close().catch(() => undefined);
  };
  const send = (slot: BoundedGatewaySlot, message: object) => {
    const item = workers.get(slot);
    if (!item || item.row.phase === 'exited' || !item.child.connected) {
      fail('BOUNDED_GATEWAY_IPC_UNAVAILABLE');
      return;
    }
    item.child.send(message, (error) => {
      if (error) fail('BOUNDED_GATEWAY_IPC_UNAVAILABLE');
    });
  };
  const dispatcher = createBoundedGatewayDispatcher({
    permits,
    maximumConnections,
    maximumBodyBytes,
    requestTimeoutMs,
    ready: () => !stopping && permits.snapshot().some((slot) => slot.phase === 'ready'),
    transport: {
      reserve(slot, epoch, ticket, peerAddress) {
        const completion = deferred<void>();
        const timer = setTimeout(() => {
          completion.reject(new Error('BOUNDED_GATEWAY_HANDOFF_TIMEOUT'));
          fail('BOUNDED_GATEWAY_HANDOFF_TIMEOUT');
        }, 5000);
        reservations.set(ticket, { slot, epoch, completion, timer });
        send(slot, { type: 'reserve', epoch, ticket, peerAddress });
        return completion.promise;
      },
      cancel(slot, epoch, ticket) {
        if (!stopping && workers.get(slot)?.row.epoch === epoch) send(slot, { type: 'cancel', epoch, ticket });
      },
      socketPath,
    },
  });
  function sendStop(slot: BoundedGatewaySlot): void {
    const item = workers.get(slot);
    if (!item || item.row.phase === 'exited') return;
    permits.stop(slot);
    item.intentional = true;
    item.row.phase = 'draining';
    clearTimeout(item.startupTimer);
    if (item.child.connected) item.child.send({ type: 'stop', epoch: item.row.epoch }, () => {});
    else item.child.kill('SIGTERM');
  }
  async function stopSlot(slot: BoundedGatewaySlot): Promise<void> {
    const item = workers.get(slot);
    if (!item || item.row.phase === 'exited') return;
    // Install the exit obligation before any send or filesystem operation can fail.
    const timer = setTimeout(() => {
      failed = true;
      item.row.forced = true;
      state.lastError = 'BOUNDED_GATEWAY_DRAIN_TIMEOUT';
      dispatcher.closeConnections();
      try {
        item.child.kill('SIGKILL');
      } catch {
        state.lastError = 'BOUNDED_GATEWAY_SIGNAL_FAILED';
      }
    }, shutdownMs);
    let stateFailed = false;
    try {
      try {
        sendStop(slot);
      } catch {
        failed = true;
        stateFailed = true;
        state.lastError = 'BOUNDED_GATEWAY_IPC_UNAVAILABLE';
        try {
          item.child.kill('SIGTERM');
        } catch {
          /* Deadline retains SIGKILL/exit obligation. */
        }
      }
      try {
        record();
      } catch {
        failed = true;
        stateFailed = true;
        state.lastError = 'BOUNDED_GATEWAY_STATE_WRITE_FAILED';
      }
      await item.exited.promise;
    } finally {
      clearTimeout(timer);
    }
    if (stateFailed || item.row.exitCode !== 0 || item.row.signal || item.row.forced)
      throw new Error('BOUNDED_GATEWAY_NON_GRACEFUL_EXIT');
  }
  async function close(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      state.phase = 'stopping';
      dispatcher.stopAdmission();
      clearInterval(healthWatchdog);
      listenerAbort.abort();
      await listenerStartup?.catch(() => undefined);
      await controlStartup
        ?.then((control) => control.close())
        .catch(() => {
          failed = true;
        });
      const listener = dispatcher.close();
      void listener.catch(() => undefined);
      try {
        record();
      } catch {
        failed = true;
      }
      const results = await Promise.allSettled(([0, 1] as const).map(stopSlot));
      if (results.some((result) => result.status === 'rejected')) failed = true;
      dispatcher.closeConnections();
      await listener.catch(() => {
        failed = true;
      });
      for (const reservation of reservations.values()) {
        clearTimeout(reservation.timer);
        reservation.completion.reject(new Error('BOUNDED_GATEWAY_STOPPED'));
      }
      reservations.clear();
      state.phase = failed ? 'failed' : 'closed';
      try {
        record();
      } catch {
        failed = true;
      }
      process.off('SIGTERM', onStop);
      process.off('SIGINT', onStop);
      process.off('SIGHUP', onReload);
      try {
        await ownership.release();
      } catch {
        failed = true;
      }
      if (failed) {
        process.exitCode = 1;
        terminated.reject(new Error(state.lastError ?? 'BOUNDED_GATEWAY_FAILED'));
      } else terminated.resolve();
    })();
    return stopping;
  }
  async function startSlot(slot: BoundedGatewaySlot, old: BoundedGatewaySlotState | null | undefined): Promise<void> {
    if (stopping) throw new Error('BOUNDED_GATEWAY_STOPPED');
    const epoch = randomUUID();
    const recoveryEpochs = old ? [...new Set([old.epoch, ...old.recoveryEpochs])] : [];
    if (recoveryEpochs.length > 64) throw new Error('BOUNDED_GATEWAY_RECOVERY_HISTORY_EXHAUSTED');
    const row: BoundedGatewaySlotState = {
      slot,
      epoch,
      recoveryEpochs,
      process: null,
      phase: 'starting',
      exitCode: null,
      signal: null,
      forced: false,
    };
    state.slots[slot] = row;
    record(); // Write spawn intent before creating a child. It cannot bootstrap before the PID write below.
    permits.start(slot, epoch);
    const path = socketPath(slot, epoch);
    if (existsSync(path)) {
      if (!lstatSync(path).isSocket()) throw new Error('BOUNDED_GATEWAY_UNSAFE_SOCKET_PATH');
      unlinkSync(path);
    }
    const child = (dependencies.forkWorker ?? fork)(resolve(__dirname, 'bounded-gateway-worker.js'), [], {
      env: { ...environment, NODE_OPTIONS: '' },
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    if (!child.pid) throw new Error('BOUNDED_GATEWAY_FORK_FAILED');
    const ready = deferred<void>();
    const exited = deferred<void>();
    const startupTimer = setTimeout(() => {
      ready.reject(new Error('BOUNDED_GATEWAY_START_TIMEOUT'));
      fail('BOUNDED_GATEWAY_START_TIMEOUT');
    }, startupMs);
    const item = { child, row, ready, exited, startupTimer, intentional: false, healthAt: Date.now() };
    workers.set(slot, item);
    child.on('message', (message: BoundedGatewayWorkerMessage) => {
      if (row.phase === 'exited') return;
      if (!message || message.epoch !== epoch) {
        fail('BOUNDED_GATEWAY_INVALID_WORKER_MESSAGE');
        return;
      }
      if (message.type === 'ready') {
        if (stopping || row.phase !== 'starting') return;
        const split = managedQuotaPoolBudget(local.databasePoolMax, true);
        const expectedPools = [split.business, ...(split.quota ? [split.quota] : [])].sort((a, b) => a - b);
        if (
          message.pid !== child.pid ||
          JSON.stringify(message.budgets) !== JSON.stringify(local) ||
          JSON.stringify(message.nativePools) !== JSON.stringify(expectedPools)
        ) {
          fail('BOUNDED_GATEWAY_BUDGET_PROOF_FAILED');
          return;
        }
        row.phase = 'ready';
        item.healthAt = Date.now();
        row.recoveryEpochs = [];
        permits.ready(slot, epoch);
        clearTimeout(startupTimer);
        try {
          record();
          ready.resolve();
        } catch {
          fail('BOUNDED_GATEWAY_STATE_WRITE_FAILED');
        }
      } else if (message.type === 'health') {
        if (typeof message.ready !== 'boolean') {
          fail('BOUNDED_GATEWAY_INVALID_WORKER_MESSAGE');
          return;
        }
        if (!stopping && permits.health(slot, epoch, message.ready)) {
          item.healthAt = Date.now();
          const phase = message.ready ? 'ready' : 'unready';
          if (row.phase !== phase) {
            row.phase = phase;
            try {
              record();
            } catch {
              fail('BOUNDED_GATEWAY_STATE_WRITE_FAILED');
            }
          }
        }
      } else if (message.type === 'reserved') {
        const pending = reservations.get(message.ticket);
        if (pending?.slot === slot && pending.epoch === epoch) {
          clearTimeout(pending.timer);
          reservations.delete(message.ticket);
          pending.completion.resolve();
        }
      } else if (message.type === 'completed') {
        permits.complete(slot, epoch, message.ticket);
        const pending = reservations.get(message.ticket);
        if (pending?.slot === slot && pending.epoch === epoch) {
          clearTimeout(pending.timer);
          reservations.delete(message.ticket);
          pending.completion.reject(new Error('BOUNDED_GATEWAY_HANDOFF_CANCELED'));
        }
      } else if (message.type === 'failed') {
        ready.reject(new Error(message.code));
        fail(/^BOUNDED_[A-Z0-9_]+$/.test(message.code) ? message.code : 'BOUNDED_GATEWAY_WORKER_FAILED');
      } else fail('BOUNDED_GATEWAY_INVALID_WORKER_MESSAGE');
    });
    child.once('disconnect', () => {
      if (!item.intentional && row.phase !== 'exited') fail('BOUNDED_GATEWAY_IPC_UNAVAILABLE');
    });
    child.once('error', () => {
      ready.reject(new Error('BOUNDED_GATEWAY_CHILD_ERROR'));
      fail('BOUNDED_GATEWAY_CHILD_ERROR');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(startupTimer);
      row.phase = 'exited';
      row.exitCode = code;
      row.signal = signal;
      permits.exited(slot, epoch);
      ready.reject(new Error('BOUNDED_GATEWAY_CHILD_EXITED'));
      exited.resolve();
      try {
        record();
      } catch {
        failed = true;
      }
      if (!item.intentional || code !== 0 || signal) fail('BOUNDED_GATEWAY_CHILD_EXITED');
    });
    row.process = boundedGatewayProcessIdentity(child.pid);
    record(); // fsync PID/start identity before granting any native pool/queue/owner authority.
    const configuration: BoundedGatewayWorkerConfiguration = {
      deploymentId,
      generation: state.generation,
      slot,
      epoch,
      socketPath: path,
      totals,
      creditCapMinorUnits: options.creditCapMinorUnits,
      policyDigest,
      recoveryEpochs,
      shutdownMs,
    };
    send(slot, { type: 'bootstrap', configuration });
    await ready.promise;
  }
  async function replaceSlot(slot: BoundedGatewaySlot): Promise<void> {
    if ((slot !== 0 && slot !== 1) || replacing || stopping || state.phase !== 'ready')
      throw new Error('BOUNDED_GATEWAY_REPLACEMENT_UNAVAILABLE');
    replacing = true;
    state.phase = 'replacing';
    const old = state.slots[slot];
    try {
      await stopSlot(slot);
      // All native resource grants remain owned until the old process has really exited.
      await startSlot(slot, old);
      state.phase = 'ready';
      record();
    } catch (error) {
      fail('BOUNDED_GATEWAY_REPLACEMENT_FAILED');
      throw error;
    } finally {
      replacing = false;
    }
  }
  const onStop = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  const onReload = () => {
    if (replacing || stopping || state.phase !== 'ready') return;
    void (async () => {
      await replaceSlot(0);
      await replaceSlot(1);
    })().catch(() => fail('BOUNDED_GATEWAY_REPLACEMENT_FAILED'));
  };
  const healthWatchdog = setInterval(() => {
    if (stopping) return;
    for (const [slot, item] of workers) {
      if (
        item.row.phase === 'ready' &&
        Date.now() - item.healthAt > 15_000 &&
        permits.health(slot, item.row.epoch, false)
      ) {
        item.row.phase = 'unready';
        try {
          record();
        } catch {
          fail('BOUNDED_GATEWAY_STATE_WRITE_FAILED');
        }
      }
    }
  }, 1000);
  healthWatchdog.unref();
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  process.on('SIGHUP', onReload);
  try {
    record();
    controlStartup = (dependencies.createControl ?? createBoundedGatewayControl)(
      options.stateDirectory,
      state.generation,
      (action) => {
        if (stopping || (action === 'roll' && (replacing || state.phase !== 'ready'))) return undefined;
        // Control invokes this only after its bounded ACK was flushed.
        return action === 'stop' ? onStop : onReload;
      },
    );
    await controlStartup;
    await startSlot(0, previous?.slots[0]);
    await startSlot(1, previous?.slots[1]);
    const gateway = deployment.listeners.gateway;
    if (!gateway) throw new Error('BOUNDED_GATEWAY_LISTENER_REQUIRED');
    const listen =
      dependencies.listen ??
      ((server: Server, port: number, address: string, signal: AbortSignal) =>
        new Promise<void>((resolveListen, reject) => {
          const cleanup = () => {
            server.off('error', onError);
            signal.removeEventListener('abort', onAbort);
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onAbort = () => onError(new Error('BOUNDED_GATEWAY_STOPPED'));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          server.once('error', onError);
          server.listen(
            { port, host: address, signal, backlog: Math.min(maximumConnections, 128), exclusive: true },
            () => {
              cleanup();
              resolveListen();
            },
          );
        }));
    listenerStartup = listen(dispatcher.server, gateway.port, gateway.bindAddress, listenerAbort.signal);
    await listenerStartup;
    if (stopping) throw new Error('BOUNDED_GATEWAY_STOPPED');
    state.phase = 'ready';
    record();
  } catch (error) {
    failed = true;
    await close();
    throw error;
  }
  return { state, closed: terminated.promise, replaceSlot, close };
}
