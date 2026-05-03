import http from 'node:http';
import { ConfigStore } from '../config/store.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { proxyHandler } from './proxy.js';
import { HealthMonitor } from '../health/monitor.js';
import { KeyLimiter } from '../limit/limiter.js';
import { IpAuthBlocker } from '../limit/ipBlocker.js';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface StartServerOptions {
  port?: number;
  bindAddress?: string;
  configPath?: string;
  maxBodyBytes?: number;
  trustProxy?: boolean;
}

export async function startServer(
  portArg?: number,
  configPathArg?: string,
  options: StartServerOptions = {}
): Promise<void> {
  const configPath = configPathArg || options.configPath || DEFAULT_CONFIG_PATH;
  const store = new ConfigStore(configPath);
  const config = store.load();
  const port = portArg ?? options.port ?? config.server.port;
  const bindAddress = options.bindAddress ?? config.server.bindAddress;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const trustProxy = options.trustProxy ?? false;

  const { LogQueue } = await import('../logger/queue.js');
  const { SQLiteLogStore } = await import('../logger/store.js');

  const logStore = new SQLiteLogStore();
  await logStore.init();
  const logQueue = new LogQueue(logStore, config.server.logFlushIntervalMs, config.server.logBatchSize);
  logQueue.start();

  let purgeTimer: NodeJS.Timeout | undefined;
  if (config.server.logRetentionDays && config.server.logRetentionDays > 0) {
    const runPurge = async () => {
      try {
        const deleted = await logStore.purgeOlderThan(config.server.logRetentionDays!);
        if (deleted > 0) console.log(`Purged ${deleted} log rows older than ${config.server.logRetentionDays} days`);
      } catch (e: any) {
        console.error('Log purge failed:', e.message);
      }
    };
    await runPurge();
    purgeTimer = setInterval(runPurge, 24 * 60 * 60 * 1000);
  }

  const limiter = new KeyLimiter();
  const today = new Date().toISOString().slice(0, 10);
  const usage = await logStore.todayTokensByKey(today);
  limiter.hydrate(usage);

  const ipBlocker = new IpAuthBlocker();

  const healthMonitor = new HealthMonitor(store);
  healthMonitor.start();

  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, (entry) => logQueue.enqueue(entry), {
      limiter,
      maxBodyBytes,
      ipBlocker,
      trustProxy,
      healthCheck: async () => {
        await logStore.ping();
        return true;
      },
    });
  });

  server.listen(port, bindAddress, () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`model-router proxy listening on http://${bindAddress}:${actualPort}`);
  });

  const gracefulShutdown = async () => {
    console.log('\nShutting down gracefully...');
    if (purgeTimer) clearInterval(purgeTimer);
    healthMonitor.stop();
    logQueue.stop();
    await logStore.close?.();
    const { cleanupPidFile } = await import('../cli/daemon.js');
    cleanupPidFile(process.env.MODEL_ROUTER_PID_FILE);
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
