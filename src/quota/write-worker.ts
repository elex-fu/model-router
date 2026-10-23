import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SQLiteQuotaLedger } from './ledger.js';
import { SQLiteQuotaStatePersistence } from './sqlite-state.js';

if (!parentPort) throw new Error('Quota worker requires a parent port');
const port = parentPort;
let db: Database.Database | undefined;

async function start(): Promise<void> {
  try {
    db = new Database((workerData as { dbPath: string }).dbPath, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    if ((db.prepare('SELECT version FROM quota_store_meta WHERE id=1').get() as { version: number })?.version !== 1)
      throw new Error('Quota store migration has not completed');
    const ledger = new SQLiteQuotaLedger({ connection: db });
    const persistence = new SQLiteQuotaStatePersistence(db, (workerData as { namespace: string }).namespace);
    let operations = Promise.resolve();
    port.on('message', (message: { kind: 'operation' | 'close'; id: number; operation: string; input: any }) => {
      operations = operations.then(async () => {
        if (message.kind === 'close') {
          db?.close();
          db = undefined;
          port.postMessage({ kind: 'closed' });
          port.close();
          return;
        }
        try {
          const input = message.input;
          let value: unknown;
          switch (message.operation) {
            case 'admit':
              value = await ledger.admit(input);
              break;
            case 'topUp':
              value = await ledger.topUp(
                input.requestId,
                input.extraTokens,
                input.dailyTokens,
                input.reportedTokensSoFar,
              );
              break;
            case 'markAttemptSent':
              await ledger.markAttemptSent(input.requestId, input.attemptId);
              break;
            case 'recordAttemptUsage':
              await ledger.recordAttemptUsage(input.requestId, input.attemptId, input.reportedTokens);
              break;
            case 'settle':
              await ledger.settle(input.requestId, input.reportedTokens, input.unknownSentAttempts);
              break;
            case 'ping':
              db!.prepare('SELECT 1').get();
              break;
            case 'state.identity':
              value = await persistence.identity();
              break;
            case 'state.generation':
              value = await persistence.generation();
              break;
            case 'state.beginGeneration':
              value = await persistence.beginGeneration(input);
              break;
            case 'state.ping':
              await persistence.ping(input);
              break;
            case 'state.load':
              value = await persistence.load(input);
              break;
            case 'state.apply':
              await persistence.apply(input);
              break;
            case 'state.expiredRequests':
              value = await persistence.expiredRequests(input.nowMs, input.limit);
              break;
            default:
              throw new Error('Unknown quota operation');
          }
          port.postMessage({ kind: 'result', id: message.id, value });
        } catch (error) {
          port.postMessage({
            kind: 'result',
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
    port.postMessage({ kind: 'ready' });
  } catch (error) {
    db?.close();
    port.postMessage({ kind: 'fatal', error: error instanceof Error ? error.message : String(error) });
    port.close();
  }
}

void start();
