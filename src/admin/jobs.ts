import { randomUUID } from 'node:crypto';
import { ControlError } from '../control/service.js';
import type { ControlStore } from '../control/store.js';

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface AdminJob {
  id: string;
  type: string;
  state: JobState;
  status: JobState;
  progress: number;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  resourceId?: string;
}

/** Small durable control-plane job queue. Work is bounded and runs in this process. */
export class AdminJobs {
  private readonly active = new Map<string, AbortController>();
  private closed = false;
  constructor(
    private readonly store: ControlStore,
    private readonly publishProgress?: (data: Record<string, unknown>) => void,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS admin_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL, progress REAL NOT NULL,
      result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resource_id TEXT
    )`);
    const columns = store.db.pragma('table_info(admin_jobs)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'resource_id'))
      store.db.exec('ALTER TABLE admin_jobs ADD COLUMN resource_id TEXT');
    store.db
      .prepare(
        "UPDATE admin_jobs SET state='interrupted', error='Process restarted', updated_at=? WHERE state IN ('queued','running')",
      )
      .run(new Date().toISOString());
  }

  start(
    type: string,
    actor: string,
    work: (signal: AbortSignal) => Promise<unknown>,
    resourceId?: string,
  ): { jobId: string; state: JobState } {
    if (this.closed) throw new ControlError(503, 'JOB_QUEUE_CLOSED', 'Job queue is closed');
    if (this.active.size >= 4) throw new ControlError(429, 'TOO_MANY_JOBS', 'Too many management jobs are running');
    const id = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    this.store.db
      .prepare('INSERT INTO admin_jobs(id,type,state,progress,result_json,error,created_at,updated_at,resource_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, type, 'queued', 0, null, null, now, now, resourceId ?? null);
    this.store.audit(actor, 'job.start', { id, type });
    this.publishProgress?.({ jobId: id, type, state: 'queued', progress: 0 });
    const controller = new AbortController();
    this.active.set(id, controller);
    setImmediate(async () => {
      if (controller.signal.aborted) {
        this.active.delete(id);
        return;
      }
      this.update(id, 'running', 0.1);
      try {
        const value = await work(controller.signal);
        this.update(
          id,
          controller.signal.aborted ? 'cancelled' : 'completed',
          1,
          controller.signal.aborted ? null : value,
        );
      } catch (error) {
        this.update(
          id,
          controller.signal.aborted ? 'cancelled' : 'failed',
          1,
          null,
          error instanceof Error ? error.message.slice(0, 1000) : 'Job failed',
        );
      } finally {
        this.active.delete(id);
      }
    });
    return { jobId: id, state: 'queued' };
  }

  get(id: string): AdminJob {
    const row = this.store.db.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id) as
      | {
          id: string;
          type: string;
          state: JobState;
          progress: number;
          result_json: string | null;
          error: string | null;
          created_at: string;
          updated_at: string;
          resource_id: string | null;
        }
      | undefined;
    if (!row) throw new ControlError(404, 'NOT_FOUND', 'Job not found');
    return {
      id: row.id,
      type: row.type,
      state: row.state,
      status: row.state,
      progress: Math.round(row.progress * 100),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    };
  }

  cancel(id: string, actor: string, expectedType?: string, resourceId?: string): AdminJob {
    const job = this.get(id);
    // Internal callers (for example rollup workers) may cancel any abortable job.
    // Public resource-scoped cancellation supplies both constraints explicitly.
    if (
      expectedType !== undefined &&
      (resourceId === undefined || job.type !== expectedType || job.resourceId !== resourceId)
    )
      throw new ControlError(409, 'JOB_NOT_CANCELLABLE', 'Job does not match the requested cancellable operation');
    if (job.state === 'queued' || job.state === 'running') {
      this.active.get(id)?.abort();
      this.update(id, 'cancelled', 1);
      this.store.audit(actor, 'job.cancel', { id });
    }
    return this.get(id);
  }

  close(): void {
    for (const [id, controller] of this.active) {
      controller.abort();
      this.update(id, 'interrupted', 1, null, 'Process stopped');
    }
    this.active.clear();
    this.closed = true;
  }

  private update(
    id: string,
    state: JobState,
    progress: number,
    result: unknown = null,
    error: string | null = null,
  ): void {
    if (this.closed) return;
    const current = this.store.db.prepare('SELECT state FROM admin_jobs WHERE id=?').get(id) as
      | { state: JobState }
      | undefined;
    if (!current || current.state === state) return;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) return;
    this.store.db
      .prepare('UPDATE admin_jobs SET state=?,progress=?,result_json=?,error=?,updated_at=? WHERE id=?')
      .run(state, progress, result === null ? null : JSON.stringify(result), error, new Date().toISOString(), id);
    this.publishProgress?.({ jobId: id, type: this.get(id).type, state, progress: Math.round(progress * 100) });
  }
}
