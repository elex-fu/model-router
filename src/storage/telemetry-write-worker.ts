import { parentPort, workerData } from 'node:worker_threads';
import { AdminRollups } from '../admin/rollups.js';
import { SQLiteLogStore } from '../logger/store.js';
import { SQLiteTelemetryStore, type TelemetryWriteEvent } from './telemetry-store.js';

type WriteItem = {
  id: number;
  event: TelemetryWriteEvent;
};
type Batch = { kind: 'write-batch'; items: WriteItem[] };
type Purge = { kind: 'purge'; id: number; retentionDays: number };
type Incoming = Batch | Purge | { kind: 'close' };
type Operation = Incoming;

if (!parentPort) throw new Error('Telemetry write worker requires a parent port');
const port = parentPort;
const dbPath = (workerData as { dbPath: string }).dbPath;
const store = new SQLiteTelemetryStore(dbPath);
const legacy = new SQLiteLogStore(dbPath);
let storeOpen = false;
let closing = false;
let processing = false;
let degradedReason: string | null = null;
let retryTimer: NodeJS.Timeout | undefined;
let retryMs = 100;
const operations: Operation[] = [];

function retainedEvents(): number {
  return operations.reduce((sum, item) => sum + (item.kind === 'write-batch' ? item.items.length : 0), 0);
}
function status(): void {
  port.postMessage({
    kind: 'status',
    degraded: !!degradedReason,
    reason: degradedReason,
    retainedEvents: retainedEvents(),
  });
}
function transientLock(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    (code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_BUSY_') ||
      code.startsWith('SQLITE_LOCKED_'))
  );
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void pump();
  }, retryMs);
  retryMs = Math.min(5_000, retryMs * 2);
}

async function pump(): Promise<void> {
  if (processing || !storeOpen) return;
  processing = true;
  try {
    while (operations.length) {
      const item = operations[0];
      if (item.kind === 'write-batch') {
        try {
          const droppedEvents = await store.upsertBatch(
            item.items.map(({ event }) => event),
            true,
          );
          operations.shift();
          retryMs = 100;
          port.postMessage({ kind: 'committed', ids: item.items.map(({ id }) => id), droppedEvents });
          if (!operations.some((operation) => operation.kind === 'write-batch')) degradedReason = null;
          status();
        } catch (error) {
          degradedReason = transientLock(error) ? 'sqlite_busy' : 'write_failed';
          status();
          scheduleRetry();
          return;
        }
      } else if (item.kind === 'purge') {
        try {
          const legacyRows = await legacy.purgeOlderThan(item.retentionDays);
          const value = {
            ...new AdminRollups(store.connection).archiveAndPurge(Date.now() - item.retentionDays * 86_400_000),
            legacyRows,
          };
          operations.shift();
          port.postMessage({ kind: 'rpc-result', id: item.id, ok: true, value });
        } catch (error) {
          operations.shift();
          port.postMessage({
            kind: 'rpc-result',
            id: item.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        operations.shift();
        if (retryTimer) clearTimeout(retryTimer);
        await legacy.close();
        await store.close();
        storeOpen = false;
        port.postMessage({ kind: 'closed' });
        port.close();
        return;
      }
    }
  } finally {
    processing = false;
  }
}

async function start(): Promise<void> {
  try {
    await legacy.init();
    await store.init();
    storeOpen = true;
    port.postMessage({ kind: 'ready' });
    port.on('message', (message: Incoming) => {
      if (message.kind === 'close') {
        if (closing) return;
        closing = true;
        operations.push({ kind: 'close' });
        void pump();
        return;
      }
      operations.push(message);
      void pump();
    });
    status();
  } catch (error) {
    await legacy.close().catch(() => {});
    await store.close().catch(() => {});
    port.postMessage({ kind: 'fatal', error: error instanceof Error ? error.message : String(error) });
    port.close();
  }
}

void start();
