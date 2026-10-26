import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../saas/db/index.js';
import type { SaasDatabase, SaasDatabasePool } from '../saas/db/types.js';
import { PostgresFastGatewayJournal } from '../saas/gateway/fast/journal.js';
import { validateDatabaseUrl } from './saas-deploy-shared.js';

const DATABASE_ENV = 'MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL';
const FAILURE =
  'Fast billing drain failed; durable jobs remain retryable. Verify the gateway database role, schema and connectivity.';
export interface SaasFastBillingWorkerOptions {
  readonly once?: boolean;
  readonly pollMs?: string | number;
  readonly batchSize?: string | number;
  readonly allowLocalPlaintext?: boolean;
}
export interface SaasFastBillingWorkerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly writeLine?: (line: string) => void;
  /** Embedded/test seam only; no CLI option can replace privilege checks or SQL. */
  readonly createDatabase?: (connectionString: string) => SaasDatabase;
  readonly verifyGatewayPrivileges?: (database: SaasDatabase) => Promise<void>;
}
function boundedInteger(value: string | number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error('Invalid fast billing worker batch-size or poll-ms.');
  return parsed;
}

/** Explicit endpoint/TLS/startup options; preserve native COMMIT command tags. */
function workerDatabase(connectionString: string): SaasDatabase {
  const url = new URL(connectionString);
  const password = decodeURIComponent(url.password);
  const pool = new Pool({
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: () => password,
    ssl: url.searchParams.get('sslmode') === 'disable' ? false : { rejectUnauthorized: true },
    options: ' ',
    client_encoding: 'UTF8',
    application_name: 'model-router-fast-billing-drain',
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
  });
  let idleFailure = false;
  pool.on('error', () => {
    idleFailure = true;
  });
  function healthy(): void {
    if (idleFailure) throw new Error('FAST_BILLING_DATABASE_UNAVAILABLE');
  }
  const adapter: SaasDatabasePool = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      healthy();
      const result = await pool.query(sql, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount, command: result.command };
    },
    async connect() {
      healthy();
      const client = await pool.connect();
      let connectionFailure: Error | undefined;
      const onError = (error: Error) => {
        connectionFailure ??= error;
      };
      client.on('error', onError);
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          healthy();
          if (connectionFailure) throw connectionFailure;
          const result = await client.query(sql, values ? [...values] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount, command: result.command };
        },
        release(error?: Error | boolean) {
          client.removeListener('error', onError);
          client.release(connectionFailure ?? error);
        },
      };
    },
    async end() {
      await pool.end();
      healthy();
    },
  };
  return createSaasDatabase({ connectionString, pool: adapter, preparedStatements: 'off' });
}

/** Opt-in settlement only: no HTTP admission, Redis, snapshots, KMS or upstream transport. */
export async function saasFastBillingWorker(
  options: SaasFastBillingWorkerOptions = {},
  dependencies: SaasFastBillingWorkerDependencies = {},
): Promise<void> {
  if (
    (options.once !== undefined && typeof options.once !== 'boolean') ||
    (options.allowLocalPlaintext !== undefined && typeof options.allowLocalPlaintext !== 'boolean')
  )
    throw new Error('Invalid fast billing worker command options.');
  const pollMs = boundedInteger(options.pollMs, 250, 10, 60000);
  const batchSize = boundedInteger(options.batchSize, 128, 1, 1000);
  const env = dependencies.env ?? process.env;
  const connectionString = env[DATABASE_ENV];
  validateDatabaseUrl(connectionString, {
    name: DATABASE_ENV,
    requireUser: 'model_router_saas_gateway',
    allowLocalPlaintext: options.allowLocalPlaintext === true,
  });
  if (!connectionString) throw new Error(`${DATABASE_ENV} is required.`);
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const stop = new AbortController();
  const onStop = () => stop.abort();
  if (dependencies.signal) {
    if (dependencies.signal.aborted) stop.abort();
    else dependencies.signal.addEventListener('abort', onStop, { once: true });
  } else {
    process.on('SIGTERM', onStop);
    process.on('SIGINT', onStop);
  }
  let database: SaasDatabase | undefined;
  let journal: PostgresFastGatewayJournal | undefined;
  let failure: Error | undefined;
  let processed = 0n;
  try {
    database = (dependencies.createDatabase ?? workerDatabase)(connectionString);
    await database.verifySchema();
    await (dependencies.verifyGatewayPrivileges ?? ((db) => verifySaasRuntimeDatabasePrivileges(db, 'gateway')))(
      database,
    );
    // Never accept an admission owner's name from configuration. This fresh
    // namespace owns no allocation and cannot take over any live gateway epoch.
    journal = new PostgresFastGatewayJournal(database, {
      allocationOwner: `billing-drain:${randomUUID()}`,
      workerPollMs: pollMs,
      workerBatchSize: batchSize,
      onBackgroundError: (code) => {
        // A standalone daemon must fail honestly for its supervisor to restart
        // it, rather than stay alive after its pool has latched an idle error.
        // Stop first: a broken diagnostic sink must not strand the process.
        failure ??= new Error(FAILURE);
        stop.abort();
        try {
          writeLine(JSON.stringify({ event: 'error', code }));
        } catch {
          /* failure and cleanup do not depend on diagnostic delivery */
        }
      },
    });
    await journal.checkReady();
    if (options.once) {
      while (!stop.signal.aborted) {
        const count = await journal.runOnce(batchSize);
        processed += BigInt(count);
        if (count === 0) break;
      }
    } else {
      if (!stop.signal.aborted) {
        journal.start();
        writeLine(JSON.stringify({ event: 'ready', mode: 'drain-only', admission: false, redis: false }));
      }
      if (!stop.signal.aborted)
        await new Promise<void>((resolve) => {
          // The library timer is intentionally unref'ed for HTTP server users.
          // This standalone poller must remain alive even with an idle DB pool.
          const keepAlive = setInterval(() => {}, 60000);
          stop.signal.addEventListener(
            'abort',
            () => {
              clearInterval(keepAlive);
              resolve();
            },
            { once: true },
          );
        });
    }
  } catch {
    failure = new Error(FAILURE);
  } finally {
    try {
      await journal?.close(failure ? { drain: false } : undefined);
    } catch {
      failure ??= new Error(FAILURE);
    }
    try {
      await database?.close();
    } catch {
      failure ??= new Error(FAILURE);
    }
    if (dependencies.signal) dependencies.signal.removeEventListener('abort', onStop);
    else {
      process.removeListener('SIGTERM', onStop);
      process.removeListener('SIGINT', onStop);
    }
  }
  if (failure) throw failure;
  writeLine(
    JSON.stringify({
      event: 'stopped',
      mode: options.once ? 'once' : 'poll',
      ...(options.once ? { processedJobs: processed.toString() } : {}),
    }),
  );
}
