import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import http from 'node:http';
import { isAbsolute } from 'node:path';
import { configureSaasNativePoolBudget, ownedSaasNativePoolSnapshot } from '../saas/db/database.js';
import { parseDeploymentConfig } from '../saas/deployment.js';
import {
  activateBoundedOwner,
  boundedOwnerName,
  readBoundedOwnerSlots,
  registerBoundedDeployment,
  releaseBoundedOwner,
} from '../saas/gateway/fast/bounded-deployment-budget.js';
import { boundedGatewayWorkerBudgets } from './bounded-gateway-budgets.js';
import {
  BOUNDED_GATEWAY_TICKET_HEADER,
  type BoundedGatewayParentMessage,
  type BoundedGatewayWorkerConfiguration,
  type BoundedGatewayWorkerMessage,
  isBoundedGatewayTicket,
} from './bounded-gateway-protocol.js';
import { BoundedGatewayWorkerTickets } from './bounded-gateway-worker-tickets.js';
import { type ManagedSaasRuntime, startManagedSaasServer } from './managed-saas.js';

export function boundedGatewayApplicationName(epoch: string): string {
  if (!isBoundedGatewayTicket(epoch)) throw new Error('BOUNDED_GATEWAY_INVALID_EPOCH');
  return `mr-bounded-${epoch}`;
}

async function checkPrivateReadiness(socketPath: string, ticket: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = http.get(
      { socketPath, path: '/readyz', agent: false, headers: { [BOUNDED_GATEWAY_TICKET_HEADER]: ticket } },
      (response) => {
        response.resume();
        response.once('end', () =>
          response.statusCode === 200 ? resolve() : reject(new Error('BOUNDED_GATEWAY_NOT_READY')),
        );
        response.once('error', reject);
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error('BOUNDED_GATEWAY_READINESS_TIMEOUT')), 5000);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject);
  });
}

export async function runBoundedGatewayWorker(config: BoundedGatewayWorkerConfiguration): Promise<void> {
  if (
    !process.send ||
    !process.connected ||
    !isAbsolute(config.socketPath) ||
    !isBoundedGatewayTicket(config.epoch) ||
    (config.slot !== 0 && config.slot !== 1)
  )
    throw new Error('BOUNDED_GATEWAY_PRIVATE_WORKER_REQUIRED');
  if (process.env.PGOPTIONS) throw new Error('BOUNDED_GATEWAY_DATABASE_IDENTITY_OVERRIDE_FORBIDDEN');
  const budgets = boundedGatewayWorkerBudgets(config.totals);
  configureSaasNativePoolBudget(budgets.databasePoolMax, boundedGatewayApplicationName(config.epoch));
  const spec = {
    deploymentId: config.deploymentId,
    creditCapMinorUnits: config.creditCapMinorUnits,
    policyDigest: config.policyDigest,
  };
  const activation = {
    ...spec,
    slot: config.slot,
    epoch: config.epoch,
    owner: boundedOwnerName(config.deploymentId, config.slot),
  };
  // The supervisor owns every budget-bearing input. Never trust inherited diagnostic overrides.
  Object.assign(process.env, {
    NODE_ENV: 'production',
    MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
    MODEL_ROUTER_DEPLOYMENT_MODE: 'managed-saas',
    MODEL_ROUTER_SAAS_DB_POOL_MAX: String(budgets.databasePoolMax),
    MODEL_ROUTER_SAAS_DB_APPLICATION_NAME: boundedGatewayApplicationName(config.epoch),
    MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: String(budgets.httpInFlight),
    MODEL_ROUTER_FAST_OWNER: activation.owner,
    MODEL_ROUTER_FAST_GATEWAY: 'reserved-max',
    MODEL_ROUTER_FAST_REDIS_URL: process.env.MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL,
    MODEL_ROUTER_FAST_REDIS_DRAINED: '0',
    MODEL_ROUTER_FAST_RECEIPT_MODE: 'memory-queue',
    MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: (BigInt(config.creditCapMinorUnits) / 2n).toString(),
    MODEL_ROUTER_FAST_CREDIT_STRIPES: String(budgets.creditStripes),
    MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES: String(budgets.receiptEntries),
    MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES: String(budgets.receiptBytes),
    MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT: String(budgets.receiptPerTenant),
    MODEL_ROUTER_FAST_RECEIPT_WORKERS: String(budgets.receiptWorkers),
    MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS: '5000',
    MODEL_ROUTER_FAST_RECEIPT_DRAIN_TIMEOUT_MS: '10000',
  });
  const environment = Object.freeze({ ...process.env });
  const deployment = parseDeploymentConfig(environment);
  if (deployment.mode !== 'managed-saas' || deployment.workloadRole !== 'gateway')
    throw new Error('BOUNDED_GATEWAY_ROLE_REQUIRED');
  const databaseUrl = new URL(deployment.postgresUrl);
  if (databaseUrl.searchParams.has('application_name') || databaseUrl.searchParams.has('options')) {
    throw new Error('BOUNDED_GATEWAY_DATABASE_IDENTITY_OVERRIDE_FORBIDDEN');
  }
  let runtime: ManagedSaasRuntime | undefined;
  let stopping = false;
  let failed = false;
  let boot: Promise<void>;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (message: BoundedGatewayWorkerMessage) => {
    if (!process.connected) return;
    process.send?.(message, (error) => {
      if (error) void stop(true);
    });
  };
  const tickets = new BoundedGatewayWorkerTickets(budgets.httpInFlight, (ticket) =>
    send({ type: 'completed', epoch: config.epoch, ticket }),
  );
  const stop = async (failure = false): Promise<void> => {
    failed ||= failure;
    if (stopping) return;
    stopping = true;
    clearTimeout(healthTimer);
    tickets.stop();
    try {
      await boot?.catch(() => undefined);
      await runtime?.close();
      if (tickets.size !== 0) failed = true;
      if (ownedSaasNativePoolSnapshot().length !== 0) failed = true;
    } catch {
      failed = true;
    }
    process.exitCode = failed ? 1 : 0;
    if (process.connected) process.disconnect();
  };
  process.on('message', (raw: BoundedGatewayParentMessage) => {
    if (!raw || raw.epoch !== config.epoch) {
      void stop(true);
      return;
    }
    try {
      if (raw.type === 'reserve') {
        tickets.reserve(raw.ticket, raw.peerAddress);
        send({ type: 'reserved', epoch: config.epoch, ticket: raw.ticket });
      } else if (raw.type === 'cancel') tickets.cancel(raw.ticket);
      else if (raw.type === 'stop') void stop();
      else void stop(true);
    } catch {
      send({ type: 'failed', epoch: config.epoch, code: 'BOUNDED_GATEWAY_PROTOCOL_FAILED' });
      void stop(true);
    }
  });
  process.once('disconnect', () => {
    if (!stopping) void stop(true);
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  boot = (async () => {
    runtime = await startManagedSaasServer(deployment, {
      environment,
      installSignalHandlers: false,
      boundedGatewayOwner: activation,
      shutdownGraceMs: Math.max(100, config.shutdownMs - 10_000),
      shutdownCleanupMs: 5000,
      privateGatewayBoundary: {
        socketPath: config.socketPath,
        maximumConnections: budgets.httpInFlight + 1,
        accept: (request, response) => tickets.accept(request, response),
        completed: (request) => tickets.finish(request),
      },
      onGatewayDatabaseReady: async (database) => {
        // Native constructor maxima are owned by process slots. Server-side normal sessions
        // additionally need an existing role-level bound to cover delayed disconnect detection.
        const role = await database.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolconnlimit: number;
          session_bound: boolean;
        }>(
          'SELECT rolsuper,rolbypassrls,rolconnlimit,current_user=session_user AS session_bound FROM pg_roles WHERE rolname=current_user',
        );
        if (
          !role.rows[0]?.session_bound ||
          role.rows[0].rolsuper ||
          role.rows[0].rolbypassrls ||
          role.rows[0].rolconnlimit < 1 ||
          role.rows[0].rolconnlimit > config.totals.databasePoolMax
        ) {
          throw new Error('BOUNDED_GATEWAY_DATABASE_ROLE_LIMIT_REQUIRED');
        }
        if (config.recoveryEpochs.length) {
          const old = await database.query<{ remaining: number }>(
            'SELECT count(*)::integer AS remaining FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND usename=current_user AND datname=current_database()',
            [config.recoveryEpochs.map(boundedGatewayApplicationName)],
          );
          if (old.rows[0]?.remaining !== 0) throw new Error('BOUNDED_GATEWAY_OLD_DATABASE_SESSIONS_REMAIN');
        }
        await registerBoundedDeployment(database, spec);
        const current = (await readBoundedOwnerSlots(database, spec))[config.slot];
        if (current?.active && current.epoch !== config.epoch) {
          if (!config.recoveryEpochs.includes(current.epoch)) throw new Error('BOUNDED_GATEWAY_UNPROVEN_OWNER_EPOCH');
          await releaseBoundedOwner(database, { ...spec, slot: config.slot, epoch: current.epoch });
        }
        await activateBoundedOwner(database, activation);
      },
    });
    chmodSync(config.socketPath, 0o600);
    if (stopping) return;
    // Readiness includes Redis quarantine, native journal startup and queue health.
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (stopping) return;
      const ticket = randomUUID();
      tickets.reserveProbe(ticket);
      try {
        await checkPrivateReadiness(config.socketPath, ticket);
        break;
      } catch {
        tickets.cancel(ticket);
        if (Date.now() >= deadline) throw new Error('BOUNDED_GATEWAY_READINESS_TIMEOUT');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const pools = ownedSaasNativePoolSnapshot();
    if (
      pools.reduce((sum, entry) => sum + entry.maximum, 0) !== budgets.databasePoolMax ||
      pools.some((entry) => entry.applicationName !== boundedGatewayApplicationName(config.epoch))
    ) {
      throw new Error('BOUNDED_GATEWAY_NATIVE_POOL_PROOF_FAILED');
    }
    send({
      type: 'ready',
      epoch: config.epoch,
      pid: process.pid,
      budgets,
      nativePools: pools.map((entry) => entry.maximum).sort((a, b) => a - b),
    });
    const probe = async () => {
      if (stopping) return;
      const ticket = randomUUID();
      let healthy = false;
      try {
        tickets.reserveProbe(ticket);
        await checkPrivateReadiness(config.socketPath, ticket);
        healthy = true;
      } catch {
        /* Existing native readiness remains the authority; no dependency bypass. */
      } finally {
        tickets.cancel(ticket);
      }
      if (stopping) return;
      send({ type: 'health', epoch: config.epoch, ready: healthy });
      healthTimer = setTimeout(() => {
        void probe();
      }, 5000);
      healthTimer.unref();
    };
    healthTimer = setTimeout(() => {
      void probe();
    }, 5000);
    healthTimer.unref();
  })();
  try {
    await boot;
  } catch (error) {
    const code =
      error instanceof Error && /^BOUNDED_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'BOUNDED_GATEWAY_START_FAILED';
    send({ type: 'failed', epoch: config.epoch, code });
    await stop(true);
  }
}

if (require.main === module) {
  // No database, owner or listener is created until the supervisor has durably
  // recorded this exact PID/start identity and then sent its bootstrap capability.
  const orphan = () => {
    process.exitCode = 1;
  };
  process.once('disconnect', orphan);
  process.once('message', (message: { type?: string; configuration?: BoundedGatewayWorkerConfiguration }) => {
    process.off('disconnect', orphan);
    if (message?.type !== 'bootstrap' || !message.configuration) {
      process.exitCode = 1;
      process.disconnect?.();
      return;
    }
    void runBoundedGatewayWorker(message.configuration).catch(() => {
      process.exitCode = 1;
      process.disconnect?.();
    });
  });
}
