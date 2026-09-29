import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { AdminRollups } from './rollups.js';

interface WorkerInput {
  dbPath: string;
}

if (!parentPort) throw new Error('Rollup worker must run in a worker thread');
const port = parentPort;
const { dbPath } = workerData as WorkerInput;
let db: Database.Database | undefined;
try {
  // Heavy scans are read-only. The main thread applies the bounded result only after
  // this worker has exited, so cancellation/shutdown cannot leave a writer behind.
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const plan = AdminRollups.computeRebuildPlan(db);
  port.postMessage({ kind: 'result', plan });
} catch (error) {
  const failure = error instanceof Error ? error : new Error('Aggregate worker failed');
  const controlFailure = failure as Error & { status?: unknown; code?: unknown };
  port.postMessage({
    kind: 'error',
    message: failure.message,
    ...(typeof controlFailure.status === 'number' && typeof controlFailure.code === 'string'
      ? { status: controlFailure.status, code: controlFailure.code }
      : {}),
  });
} finally {
  db?.close();
}
