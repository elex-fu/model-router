import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AdminRollups, UTC_DAY_MS } from '../admin/rollups.js';
import { previewRuntimeRoute } from '../admin/runtime.js';
import { createAdminServer } from '../admin/server.js';
import { compileRuntimeConfig, RuntimeConfigStore } from '../config/v2-runtime.js';
import { ConfigServiceV2 } from '../config/v2-service.js';
import { ControlService } from '../control/service.js';
import { ControlStore } from '../control/store.js';
import { HealthMonitor } from '../health/monitor.js';
import { IpAuthBlocker } from '../limit/ipBlocker.js';
import { SQLiteQuotaLedger } from '../quota/ledger.js';
import { QuotaTimezoneVersions } from '../quota/timezone-versions.js';
import type { DeploymentEnvironment } from '../saas/deployment.js';
import { parseDeploymentConfig } from '../saas/deployment.js';
import { importLegacyRequestLogs, UnsafeLegacyImportError } from '../storage/legacy-import.js';
import { ResponseOwnershipStore } from '../storage/response-ownership.js';
import { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import { TelemetryWriteClient } from '../storage/telemetry-write-client.js';
import { estimateCost, type PricingProfile, selectPrice } from '../telemetry/pricing.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { reconcileObservedExternal } from './external-config-lifecycle.js';
import { KeyPool } from './keyPool.js';
import { type ManagedSaasStartOptions, startManagedSaasServer } from './managed-saas.js';
import { OAuthTokenResolver } from './oauth.js';
import { createOAuthAccountAdminAdapters } from './oauth-account-admin.js';
import { OAuthAccountStore } from './oauth-accounts.js';
import { createPlaygroundExecutor } from './playground-executor.js';
import { proxyHandler } from './proxy.js';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface StartServerOptions {
  port?: number;
  bindAddress?: string;
  configPath?: string;
  maxBodyBytes?: number;
  trustProxy?: boolean;
  /** Test/deployment seam; production callers normally use process.env. */
  environment?: DeploymentEnvironment;
  /** Managed composition seams. Ignored by local mode. */
  managedSaas?: ManagedSaasStartOptions;
}

export async function startServer(
  portArg?: number,
  configPathArg?: string,
  options: StartServerOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const deployment = parseDeploymentConfig(environment);
  if (deployment.mode === 'managed-saas') {
    await startManagedSaasServer(deployment, {
      ...(options.managedSaas ?? {}),
      environment,
    });
    return;
  }

  await startLocalServer(portArg, configPathArg, options);
}

async function startLocalServer(
  portArg?: number,
  configPathArg?: string,
  options: StartServerOptions = {},
): Promise<void> {
  const configPath = configPathArg || options.configPath || DEFAULT_CONFIG_PATH;
  const configDir = path.dirname(path.resolve(configPath));
  const existing = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, 'utf8')) as { schemaVersion?: number; storage?: { dataDir?: string } })
    : null;
  const dataDir =
    existing?.schemaVersion === 2 && existing.storage?.dataDir
      ? path.resolve(configDir, existing.storage.dataDir)
      : configDir;
  const controlStore = new ControlStore(dataDir);
  const configService = new ConfigServiceV2(configPath, {
    storeSecret: async (plaintext) => {
      const id = `sec_${randomUUID()}`;
      controlStore.secrets.put(id, plaintext);
      return id;
    },
    hasSecret: (id) => controlStore.secrets.has(id),
    backupLegacy: async (raw, label) => {
      controlStore.secrets.put(`backup_${label}`, raw);
      controlStore.audit('system', 'config.v1_encrypted_backup', { label });
    },
  });
  // Install migration journaling before loadRaw can replace a legacy file.
  new ControlService(configPath, controlStore, configService);
  let effectiveRaw = await configService.loadRaw();
  let observedRaw = effectiveRaw;
  const resolveSecret = (id: string) => controlStore.secrets.get(id);
  const store = new RuntimeConfigStore(configPath, await compileRuntimeConfig(effectiveRaw, resolveSecret));
  const config = store.load();
  const port = portArg ?? options.port ?? effectiveRaw.server.port;
  const bindAddress = options.bindAddress ?? effectiveRaw.server.bindAddress;
  let proxyActualPort: number | null = null;
  let proxyActualAddress: string | null = null;
  let adminActualPort: number | null = null;
  let adminActualAddress: string | null = null;
  const trustProxy = effectiveRaw.server.trustedProxyCidrs;
  if (options.trustProxy && trustProxy.length === 0)
    console.warn('--trust-proxy alone does not trust arbitrary peers in V2; configure server.trustedProxyCidrs');
  const listenerSettings = {
    serverPort: effectiveRaw.server.port,
    serverBindAddress: effectiveRaw.server.bindAddress,
    publicProxyBaseUrl: effectiveRaw.server.publicProxyBaseUrl,
    adminEnabled: effectiveRaw.admin.enabled,
    adminPort: effectiveRaw.admin.port,
    adminBindAddress: effectiveRaw.admin.bindAddress,
    publicAdminBaseUrl: effectiveRaw.admin.publicAdminBaseUrl,
    trustedProxyCidrs: JSON.stringify(effectiveRaw.server.trustedProxyCidrs),
    storage: JSON.stringify(effectiveRaw.storage),
  };
  const restartFieldsFor = (next: typeof effectiveRaw) =>
    [
      next.server.port !== listenerSettings.serverPort && options.port === undefined && portArg === undefined
        ? 'server.port'
        : null,
      next.server.bindAddress !== listenerSettings.serverBindAddress && options.bindAddress === undefined
        ? 'server.bindAddress'
        : null,
      next.server.publicProxyBaseUrl !== listenerSettings.publicProxyBaseUrl ? 'server.publicProxyBaseUrl' : null,
      next.admin.enabled !== listenerSettings.adminEnabled ? 'admin.enabled' : null,
      next.admin.port !== listenerSettings.adminPort ? 'admin.port' : null,
      next.admin.bindAddress !== listenerSettings.adminBindAddress ? 'admin.bindAddress' : null,
      next.admin.publicAdminBaseUrl !== listenerSettings.publicAdminBaseUrl ? 'admin.publicAdminBaseUrl' : null,
      JSON.stringify(next.server.trustedProxyCidrs) !== listenerSettings.trustedProxyCidrs
        ? 'server.trustedProxyCidrs'
        : null,
      JSON.stringify(next.storage) !== listenerSettings.storage ? 'storage' : null,
    ].filter((field): field is string => field !== null);

  const { LogQueue } = await import('../logger/queue.js');
  const { SQLiteLogStore } = await import('../logger/store.js');

  const logDbPath = path.join(dataDir, 'logs.sqlite');
  const logStore = new SQLiteLogStore(logDbPath);
  await logStore.init();
  const telemetryStore = new SQLiteTelemetryStore(logDbPath);
  await telemetryStore.init();
  const quotaTimezoneVersions = new QuotaTimezoneVersions(telemetryStore);
  quotaTimezoneVersions.initialize(effectiveRaw.quota.timezone, Date.now(), effectiveRaw.revision);
  const reconcileQuotaTimezone = (timezone: string, revision: number) => {
    const versions = quotaTimezoneVersions.list();
    const active = versions.find((version) => version.state === 'active');
    if (!active) {
      quotaTimezoneVersions.initialize(timezone, Date.now(), revision);
      return;
    }
    const pending = versions.find((version) => version.state === 'scheduled');
    // Startup/config reconciliation must preserve the persisted boundary, even if already due.
    // Admission alone activates scheduled timezone versions.
    if (pending?.timezone === timezone) return;
    if (timezone === active.timezone) {
      quotaTimezoneVersions.cancelPending();
      return;
    }
    quotaTimezoneVersions.schedule(timezone, Date.now(), revision);
  };
  reconcileQuotaTimezone(effectiveRaw.quota.timezone, effectiveRaw.revision);
  let telemetryWriteClient: TelemetryWriteClient | undefined;
  try {
    const legacyImport = await importLegacyRequestLogs(telemetryStore, {
      proxyKeyIdsByName: new Map(effectiveRaw.proxyKeys.map((key) => [key.name, key.id])),
      upstreamIdsByName: new Map(effectiveRaw.upstreams.map((upstream) => [upstream.name, upstream.id])),
    });
    if (!legacyImport.alreadyCompleted && legacyImport.importedRows > 0)
      console.log(`Imported ${legacyImport.importedRows} legacy log rows as separately marked historical measurements`);
  } catch (error) {
    if (!(error instanceof UnsafeLegacyImportError)) throw error;
    console.warn(`Legacy log import skipped safely: ${error.message}`);
  }
  let startupLogQueue: import('../logger/queue.js').LogQueue | undefined;
  let startupHealthMonitor: HealthMonitor | undefined;
  let startupProxyServer: http.Server | undefined;
  let startupAdmin: ReturnType<typeof createAdminServer> | null = null;
  let startupPurgeTimer: NodeJS.Timeout | undefined;
  let startupConfigWatch = false;
  try {
    const telemetryWriter = await TelemetryWriteClient.open(logDbPath);
    telemetryWriteClient = telemetryWriter;
    const quotaLedger = new SQLiteQuotaLedger(telemetryStore);
    await quotaLedger.recoverInterrupted();
    const responseOwnership = new ResponseOwnershipStore(telemetryStore);
    const logQueue = new LogQueue(logStore, config.server.logFlushIntervalMs, config.server.logBatchSize);
    logQueue.start();
    startupLogQueue = logQueue;

    let shuttingDown = false;
    let purgeInFlight: Promise<void> = Promise.resolve();
    let purgeTimer: NodeJS.Timeout | undefined;
    const retentionDays = config.server.logRetentionDays;
    if (retentionDays && retentionDays > 0) {
      const rollups = new AdminRollups(telemetryStore.connection);
      const runPurge = async () => {
        try {
          const deleted = await logStore.purgeOlderThan(retentionDays);
          if (deleted > 0) console.log(`Purged ${deleted} log rows older than ${retentionDays} days`);
        } catch {
          console.error('Compatibility log purge failed; data retained');
        }
        try {
          const result = rollups.archiveAndPurge(Date.now() - retentionDays * UTC_DAY_MS);
          if (result.requests > 0) {
            controlStore.audit('system', 'telemetry.auto_archive_purge', result);
            console.log(`Archived and purged ${result.requests} V2 request details`);
          }
        } catch {
          console.warn('V2 telemetry archive/purge deferred; detail retained for review');
        }
      };
      purgeInFlight = runPurge();
      await purgeInFlight;
      const schedulePurge = () => {
        if (shuttingDown) return;
        const next = new Date();
        next.setHours(3, 0, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        purgeTimer = startupPurgeTimer = setTimeout(async () => {
          purgeInFlight = runPurge();
          await purgeInFlight;
          schedulePurge();
        }, next.getTime() - Date.now());
      };
      schedulePurge();
    }

    const ipBlocker = new IpAuthBlocker();

    const keyPool = new KeyPool();
    const keyPoolEntries = (upstream: (typeof config.upstreams)[number]) =>
      upstream.apiKeys.map((key, i) => ({ credentialId: upstream.credentialIds?.[i] ?? key, key }));
    for (const upstream of config.upstreams) {
      if (upstream.apiKeys.length > 0) {
        keyPool.register(upstream.name, keyPoolEntries(upstream));
      }
    }

    const healthMonitor = new HealthMonitor(store, keyPool);
    startupHealthMonitor = healthMonitor;
    healthMonitor.start();

    const circuitBreaker = new CircuitBreaker();
    const oauthAccounts = new OAuthAccountStore(configPath, controlStore.secrets);
    const oauthResolver = new OAuthTokenResolver(oauthAccounts);

    const control = new ControlService(
      configPath,
      controlStore,
      configService,
      async (next) => {
        if (restartFieldsFor(next).length) return store.load().revision ?? effectiveRaw.revision;
        const compiled = await compileRuntimeConfig(next, resolveSecret);
        store.replace(compiled);
        effectiveRaw = next;
        observedRaw = next;
        for (const upstream of compiled.upstreams) keyPool.reconcile(upstream.name, keyPoolEntries(upstream));
        return next.revision;
      },
      {
        afterDurableCommit: (next) => reconcileQuotaTimezone(next.quota.timezone, next.revision),
      },
    );
    control.reconcileStartup(effectiveRaw);
    let reloadInProgress = false;
    let deferredExternalRevision: number | undefined;
    const reloadExternalConfig = async () => {
      if (reloadInProgress) return;
      reloadInProgress = true;
      try {
        const next = await configService.loadRaw();
        if (control.isOwnedCommit(observedRaw, next)) {
          observedRaw = next;
          return;
        }
        if (JSON.stringify(next) === JSON.stringify(observedRaw)) return;
        const previousObserved = observedRaw;
        const restartFields = restartFieldsFor(next);
        const compiled = await compileRuntimeConfig(next, resolveSecret);
        if (restartFields.length) {
          reconcileObservedExternal(
            () => reconcileQuotaTimezone(next.quota.timezone, next.revision),
            (afterJournal) => control.recordObservedExternal(observedRaw, next, afterJournal, 'restart_required'),
            () => {},
          );
          control.publishUpstreamChange(previousObserved, next);
          observedRaw = next;
          control.markExternallyDeferred(restartFields, effectiveRaw.revision);
          if (deferredExternalRevision !== next.revision) {
            deferredExternalRevision = next.revision;
            console.log(`model-router config revision ${next.revision} requires restart; runtime snapshot retained`);
          }
          return;
        }
        reconcileObservedExternal(
          () => reconcileQuotaTimezone(next.quota.timezone, next.revision),
          (afterJournal) => control.recordObservedExternal(observedRaw, next, afterJournal, 'applied'),
          () => store.replace(compiled),
        );
        control.publishUpstreamChange(previousObserved, next);
        observedRaw = next;
        effectiveRaw = next;
        control.markExternallyApplied(next.revision);
        deferredExternalRevision = undefined;
        for (const upstream of compiled.upstreams) keyPool.reconcile(upstream.name, keyPoolEntries(upstream));
        console.log(`model-router applied external config revision ${next.revision}`);
      } catch (error) {
        console.error('External configuration invalid; retaining last valid runtime snapshot:', error);
      } finally {
        reloadInProgress = false;
      }
    };
    fs.watchFile(configPath, { interval: 1_000 }, () => {
      void reloadExternalConfig();
    });
    startupConfigWatch = true;
    const enqueueLog = (entry: Parameters<typeof logQueue.enqueue>[0]) => logQueue.enqueue(entry);
    const makeProxyOptions = () => ({
      publishEvent: (type: 'request.completed', data: Record<string, unknown>) => control.publishEvent(type, data),
      telemetryStore: telemetryWriter,
      quotaLedger: telemetryWriter,
      quotaTimezoneVersions,
      responseOwnership,
      quotaTimezone: effectiveRaw.quota.timezone,
      missingUsagePolicy: effectiveRaw.quota.missingUsagePolicy,
      priceAttempt: (
        usage: Parameters<NonNullable<import('./proxy.js').ProxyHandlerOptions['priceAttempt']>>[0],
        context: Parameters<NonNullable<import('./proxy.js').ProxyHandlerOptions['priceAttempt']>>[1],
      ) => {
        if (context.presetId?.startsWith('kimi-code')) {
          return {
            pricingVersion: null,
            currency: null,
            costMicros: null,
            partial: true,
            reason: 'subscription_usage_not_billing',
          };
        }
        const rows = controlStore.db
          .prepare(`SELECT v.version_id,v.profile_id,v.body,s.sequence FROM pricing_versions v
          JOIN pricing_version_sequence s USING(version_id)`)
          .all() as Array<{
          version_id: string;
          profile_id: string;
          body: string;
          sequence: number;
        }>;
        const profiles = rows.flatMap((row) => {
          try {
            return [
              {
                ...(JSON.parse(row.body) as PricingProfile),
                id: row.profile_id,
                versionId: row.version_id,
                versionSequence: row.sequence,
              },
            ];
          } catch {
            return [];
          }
        });
        return estimateCost(
          usage,
          selectPrice(profiles, context.model, context.upstreamId, context.provider, context.atMs),
        );
      },
      configRevision: store.load().revision,
      keyPool,
      maxBodyBytes: options.maxBodyBytes ?? effectiveRaw.server.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ipBlocker,
      trustProxy,
      circuitBreaker,
      oauthResolver,
      maxRetries: effectiveRaw.server.maxAttempts,
      requestTimeoutMs: effectiveRaw.server.totalRequestTimeoutMs,
      connectTimeoutMs: effectiveRaw.server.connectTimeoutMs,
      firstByteTimeoutMs: effectiveRaw.server.firstByteTimeoutMs,
      streamIdleTimeoutMs: effectiveRaw.server.streamIdleTimeoutMs,
      healthCheck: async () => {
        await logStore.ping();
        return true;
      },
      recorderHealthy: () => !telemetryWriter.getStatus().degraded,
    });
    const bootstrapToken = controlStore.hasAdmin() ? undefined : randomBytes(24).toString('base64url');
    const admin = effectiveRaw.admin.enabled
      ? createAdminServer({
          configPath,
          controlStore,
          controlService: control,
          telemetryStore,
          quotaLedger,
          quotaTimezoneVersions,
          recorderStatus: () => telemetryWriter.getStatus(),
          adapters: createOAuthAccountAdminAdapters(oauthAccounts, controlStore),
          playgroundExecutor: (input) => createPlaygroundExecutor(store, enqueueLog, makeProxyOptions())(input),
          runtime: {
            previewRoute: async (input) =>
              previewRuntimeRoute({
                ...input,
                snapshot: store.load(),
                raw: await control.raw(),
                keyPool,
                circuitBreaker,
                healthStatus: (upstreamId) => healthMonitor.getStatus(upstreamId),
              }),
            getUpstreamStatus: (upstreamId) => {
              const health = healthMonitor.getStatus(upstreamId);
              const circuit = circuitBreaker.status(upstreamId);
              return {
                healthStatus: health ? (health.healthy ? 'healthy' : 'unhealthy') : 'unknown',
                healthCheckedAt: health?.checkedAt ?? null,
                healthError: health?.error ?? null,
                consecutiveHealthFailures: health?.consecutiveFailures ?? 0,
                circuitState: circuit.state,
                circuitFailures: circuit.failures,
                circuitLastFailureAt: circuit.lastFailureTime || null,
              };
            },
            resetCircuit: (upstreamId) => circuitBreaker.reset(upstreamId),
          },
          listenerStatus: () => ({
            proxy: {
              enabled: true,
              configured: {
                bindAddress: effectiveRaw.server.bindAddress,
                port: portArg ?? options.port ?? effectiveRaw.server.port,
              },
              actual: proxyActualPort === null ? null : { bindAddress: proxyActualAddress, port: proxyActualPort },
            },
            admin: {
              enabled: effectiveRaw.admin.enabled,
              configured: { bindAddress: effectiveRaw.admin.bindAddress, port: effectiveRaw.admin.port },
              actual: !effectiveRaw.admin.enabled
                ? null
                : adminActualPort === null
                  ? null
                  : { bindAddress: adminActualAddress, port: adminActualPort },
            },
          }),
          bootstrapToken,
          bootstrapExpiresAt: Date.now() + 15 * 60_000,
          publicOrigin: () => effectiveRaw.admin.publicAdminBaseUrl,
          webDistPath: path.resolve(__dirname, '../../web/dist'),
        })
      : null;
    startupAdmin = admin;

    const server = http.createServer((req, res) => {
      const request = proxyHandler(req, res, store, enqueueLog, makeProxyOptions()).catch(() => {
        console.error('Proxy request failed unexpectedly; check local runtime dependencies');
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'internal_error', message: 'Proxy temporarily unavailable' } }));
        }
      });
      activeProxyRequests.add(request);
      void request.finally(() => activeProxyRequests.delete(request));
    });
    startupProxyServer = server;

    const activeProxyRequests = new Set<Promise<void>>();

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        proxyActualPort = typeof addr === 'object' && addr ? addr.port : null;
        proxyActualAddress = typeof addr === 'object' && addr ? addr.address : null;
        console.log(`model-router proxy listening on http://${bindAddress}:${actualPort}`);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, bindAddress);
    });
    if (admin) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          admin.server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          admin.server.off('error', onError);
          const address = admin.server.address();
          const actualPort = typeof address === 'object' && address ? address.port : effectiveRaw.admin.port;
          adminActualPort = typeof address === 'object' && address ? address.port : null;
          adminActualAddress = typeof address === 'object' && address ? address.address : null;
          console.log(`model-router admin listening on http://${effectiveRaw.admin.bindAddress}:${actualPort}/admin/`);
          if (bootstrapToken) console.log(`Admin bootstrap token (local, expires in 15m): ${bootstrapToken}`);
          resolve();
        };
        admin.server.once('error', onError);
        admin.server.once('listening', onListening);
        admin.server.listen(effectiveRaw.admin.port, effectiveRaw.admin.bindAddress);
      });
    }

    const gracefulShutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down gracefully...');
      if (purgeTimer) clearTimeout(purgeTimer);
      fs.unwatchFile(configPath);
      healthMonitor.stop();
      const closeProxy = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const closeAdmin = admin?.close() ?? Promise.resolve();
      const drained = Promise.allSettled([closeProxy, closeAdmin, purgeInFlight]).then(async (results) => {
        for (const result of results)
          if (result.status === 'rejected') console.error('Listener close failed:', result.reason);
        await Promise.allSettled([...activeProxyRequests]);
      });
      const waitFor = async (timeoutMs: number): Promise<boolean> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            drained.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      if (!(await waitFor(30_000))) {
        console.warn('Shutdown drain timed out; closing active HTTP connections');
        server.closeAllConnections();
        admin?.server.closeAllConnections();
        if (!(await waitFor(5_000))) {
          console.error('Shutdown could not settle in-flight requests; exiting without closing stores underneath them');
          process.exit(1);
        }
      }
      let shutdownError: unknown;
      try {
        await logQueue.stop();
        await telemetryWriteClient?.close(5_000);
        await logStore.close?.();
        await telemetryStore.close();
      } catch (error) {
        shutdownError = error;
      }
      try {
        controlStore.close();
      } catch (error) {
        shutdownError ??= error;
      }
      if (shutdownError) {
        console.error('Shutdown storage flush failed:', shutdownError);
        process.exit(1);
      }
      const { cleanupPidFile } = await import('../cli/daemon.js');
      cleanupPidFile(process.env.MODEL_ROUTER_PID_FILE);
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void gracefulShutdown();
    });
    process.on('SIGTERM', () => {
      void gracefulShutdown();
    });
  } catch (startupError) {
    if (startupPurgeTimer) clearTimeout(startupPurgeTimer);
    if (startupConfigWatch) fs.unwatchFile(configPath);
    startupHealthMonitor?.stop();
    startupProxyServer?.closeAllConnections();
    startupAdmin?.server.closeAllConnections();
    try {
      await startupAdmin?.close();
    } catch {
      /* preserve the original startup error */
    }
    const proxyServer = startupProxyServer;
    if (proxyServer?.listening) {
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }
    try {
      await startupLogQueue?.stop();
    } catch {
      /* preserve the original startup error */
    }
    try {
      await telemetryWriteClient?.close(5_000);
    } catch {
      /* preserve the original startup error */
    }
    try {
      await telemetryStore.close();
    } catch {
      /* preserve the original startup error */
    }
    try {
      await logStore.close?.();
    } catch {
      /* preserve the original startup error */
    }
    try {
      controlStore.close();
    } catch {
      /* preserve the original startup error */
    }
    throw startupError;
  }
}
