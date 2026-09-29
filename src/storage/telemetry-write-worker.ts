import { parentPort, workerData } from 'node:worker_threads';
import { type QuotaAdmission, SQLiteQuotaLedger } from '../quota/ledger.js';
import type { AttemptRecord, RequestRecord } from '../telemetry/types.js';
import { SQLiteTelemetryStore } from './telemetry-store.js';

type WriteItem = {
  id: number;
  event: { operation: 'request'; record: RequestRecord } | { operation: 'attempt'; record: AttemptRecord };
};
type Batch = { kind: 'write-batch'; items: WriteItem[] };
type Quota = { kind: 'quota'; id: number; operation: string; input: any };
type Incoming = Batch | Quota | { kind: 'mark-degraded'; reason: string } | { kind: 'close' };
type Operation = Batch | Quota | { kind: 'close' };

if (!parentPort) throw new Error('Telemetry write worker requires a parent port');
const port = parentPort;
const dbPath = (workerData as { dbPath: string }).dbPath;
const store = new SQLiteTelemetryStore(dbPath);
let ledger: SQLiteQuotaLedger;
let storeOpen = false;
let closing = false;
let processing = false;
let degradedReason: string | null = null;
let stickyDegradedReason: string | null = null;
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

async function runQuota(operation: Quota): Promise<unknown> {
  const input = operation.input;
  switch (operation.operation) {
    case 'admit':
      return ledger.admit(input as QuotaAdmission);
    case 'topUp':
      return ledger.topUp(input.requestId, input.extraTokens, input.dailyTokens, input.reportedTokensSoFar);
    case 'markAttemptSent':
      return ledger.markAttemptSent(input.requestId);
    case 'settle':
      return ledger.settle(input.requestId, input.reportedTokens, input.unknownSentAttempts);
    default:
      throw new Error(`Unknown quota operation: ${operation.operation}`);
  }
}

async function pump(): Promise<void> {
  if (processing || !storeOpen) return;
  processing = true;
  try {
    while (operations.length) {
      const item = operations[0];
      if (item.kind === 'write-batch') {
        try {
          await store.upsertBatch(item.items.map(({ event }) => event));
          operations.shift();
          retryMs = 100;
          port.postMessage({ kind: 'committed', ids: item.items.map(({ id }) => id) });
          if (stickyDegradedReason) degradedReason = stickyDegradedReason;
          else if (!operations.some((operation) => operation.kind === 'write-batch')) degradedReason = null;
          status();
        } catch (error) {
          degradedReason = transientLock(error) ? 'sqlite_busy' : 'write_failed';
          status();
          scheduleRetry();
          return;
        }
      } else if (item.kind === 'quota') {
        if (item.operation === 'admit' && degradedReason) {
          operations.shift();
          port.postMessage({
            kind: 'rpc-result',
            id: item.id,
            ok: true,
            value: { allowed: false, reason: 'recorder_degraded' },
          });
          continue;
        }
        try {
          const value = await runQuota(item);
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
    await store.init();
    storeOpen = true;
    ledger = new SQLiteQuotaLedger(store);
    port.postMessage({ kind: 'ready' });
    port.on('message', (message: Incoming) => {
      if (message.kind === 'mark-degraded') {
        stickyDegradedReason = message.reason;
        degradedReason = message.reason;
        status();
        return;
      }
      if (message.kind === 'close') {
        if (closing) return;
        closing = true;
        operations.push({ kind: 'close' });
        void pump();
        return;
      }
      if (message.kind === 'quota' && message.operation === 'admit' && degradedReason) {
        port.postMessage({
          kind: 'rpc-result',
          id: message.id,
          ok: true,
          value: { allowed: false, reason: 'recorder_degraded' },
        });
        return;
      }
      operations.push(message);
      void pump();
    });
    status();
  } catch (error) {
    if (storeOpen) await store.close().catch(() => {});
    port.postMessage({ kind: 'fatal', error: error instanceof Error ? error.message : String(error) });
    port.close();
  }
}

void start();
