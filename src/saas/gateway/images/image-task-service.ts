import { randomUUID } from 'node:crypto';

import { ImageResultOffloadError, type ImageResultOffloader } from './image-result-offloader.js';
import { IMAGE_TASK_ID_PATTERN, type SaasImageTaskRecord, type SaasImageTaskStore } from './image-task-store.js';

/**
 * Roadmap batch 4 §4.2 (task #16) async image task lifecycle service
 * (sub2api `image_task.go` ImageTaskService ported):
 *
 * - `createTask` registers a processing task (24 h TTL) and returns the
 *   public submission facts (task id, poll URL, timestamps);
 * - `completeTask` validates the upstream result, offloads every image to
 *   object storage (when an offloader is wired — offload failure fails the
 *   task, never stores the blob) and finishes the task completed;
 * - `failTask` finishes the task failed with a bounded error envelope;
 * - `readTask` serves the GET /v1/images/tasks/:taskId query with
 *   tenant+proxy-key ownership (the sub2api user_id/api_key_id pair): a
 *   task owned by another caller is indistinguishable from a missing one.
 *
 * The public JSON view mirrors sub2api's ImageTask shape
 * (`object: "image.generation.task"`, unix-second timestamps, `image_url`
 * from the first result item's link).
 */

export const IMAGE_TASK_TTL_MS = 24 * 60 * 60 * 1000;
export const IMAGE_TASK_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;

export class ImageTaskServiceError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ImageTaskServiceError';
  }
}

export interface SaasImageTaskServiceOptions {
  readonly store: SaasImageTaskStore;
  readonly offloader?: ImageResultOffloader | null;
  readonly ttlMs?: number;
  readonly executionTimeoutMs?: number;
  readonly idFactory?: () => string;
  readonly now?: () => number;
}

export interface SaasImageTaskSubmission {
  readonly taskId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SaasImageTaskPublicView {
  readonly id: string;
  readonly task_id: string;
  readonly object: 'image.generation.task';
  readonly status: 'processing' | 'completed' | 'failed';
  readonly http_status?: number;
  readonly image_url?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly created_at: number;
  readonly completed_at?: number;
  readonly expires_at: number;
}

function unixSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

function parseJsonText(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstImageUrl(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
  const url = (first as Record<string, unknown>).url;
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : null;
}

function publicView(record: SaasImageTaskRecord): SaasImageTaskPublicView {
  const result = parseJsonText(record.result);
  const error = parseJsonText(record.error);
  const view: Record<string, unknown> = {
    id: record.id,
    task_id: record.id,
    object: 'image.generation.task',
    status: record.status,
    created_at: unixSeconds(Date.parse(record.createdAt)),
    expires_at: unixSeconds(Date.parse(record.expiresAt)),
  };
  if (record.httpStatus !== null) view.http_status = record.httpStatus;
  const imageUrl = firstImageUrl(result);
  if (imageUrl !== null) view.image_url = imageUrl;
  if (result !== null) view.result = result;
  if (error !== null) view.error = error;
  if (record.completedAt !== null) view.completed_at = unixSeconds(Date.parse(record.completedAt));
  return view as unknown as SaasImageTaskPublicView;
}

export function imageTaskErrorEnvelope(type: string, message: string): string {
  return JSON.stringify({ type, message });
}

export class SaasImageTaskService {
  private readonly store: SaasImageTaskStore;
  private readonly offloader: ImageResultOffloader | null;
  private readonly ttlMs: number;
  readonly executionTimeoutMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: SaasImageTaskServiceOptions) {
    if (!options || typeof options !== 'object' || !options.store) {
      throw new ImageTaskServiceError('UNAVAILABLE', 'the image task service requires a store');
    }
    this.store = options.store;
    this.offloader = options.offloader ?? null;
    const ttlMs = options.ttlMs ?? IMAGE_TASK_TTL_MS;
    const executionTimeoutMs = options.executionTimeoutMs ?? IMAGE_TASK_EXECUTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new ImageTaskServiceError('INVALID_INPUT', 'the image task TTL is invalid');
    }
    if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1) {
      throw new ImageTaskServiceError('INVALID_INPUT', 'the image task execution timeout is invalid');
    }
    this.ttlMs = ttlMs;
    this.executionTimeoutMs = executionTimeoutMs;
    this.idFactory = options.idFactory ?? (() => `imgtask_${randomUUID().replace(/-/g, '')}`);
    this.now = options.now ?? (() => Date.now());
  }

  /** Registers one processing task; the id is opaque and unguessable. */
  async createTask(owner: {
    readonly tenantId: string;
    readonly proxyKeyId: string;
  }): Promise<SaasImageTaskSubmission> {
    if (
      typeof owner.tenantId !== 'string' ||
      owner.tenantId.trim() === '' ||
      typeof owner.proxyKeyId !== 'string' ||
      owner.proxyKeyId.trim() === ''
    ) {
      throw new ImageTaskServiceError('INVALID_INPUT', 'image task owner is invalid');
    }
    const now = this.now();
    const taskId = this.idFactory();
    if (!IMAGE_TASK_ID_PATTERN.test(taskId)) {
      throw new ImageTaskServiceError('UNAVAILABLE', 'the task id factory produced an invalid id');
    }
    const record: SaasImageTaskRecord = {
      id: taskId,
      tenantId: owner.tenantId,
      proxyKeyId: owner.proxyKeyId,
      status: 'processing',
      httpStatus: null,
      result: null,
      error: null,
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    await this.store.create(record);
    return {
      taskId,
      createdAt: unixSeconds(now),
      expiresAt: unixSeconds(now + this.ttlMs),
    };
  }

  /**
   * Finishes a task completed: validates the upstream result JSON, offloads
   * every embedded image (offload failure fails the task — the large blob
   * is never stored), then finishes with the compact rewritten result.
   */
  async completeTask(input: {
    readonly taskId: string;
    readonly httpStatus: number;
    readonly resultJsonText: string;
  }): Promise<void> {
    if (typeof input.resultJsonText !== 'string') {
      throw new ImageTaskServiceError('INVALID_INPUT', 'the task result must be JSON text');
    }
    let result = input.resultJsonText;
    if (this.offloader !== null) {
      try {
        result = await this.offloader.rewrite(input.taskId, result);
      } catch (error) {
        // §4.2: offload failure fails the task; the blob is never stored.
        await this.failTask({
          taskId: input.taskId,
          httpStatus: 502,
          error: imageTaskErrorEnvelope('api_error', 'failed to store the generated image to object storage'),
        });
        throw error instanceof ImageResultOffloadError
          ? error
          : new ImageTaskServiceError('UNAVAILABLE', String(error));
      }
    }
    const finished = await this.store.finish(input.taskId, {
      status: 'completed',
      httpStatus: input.httpStatus,
      result,
      error: null,
      completedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    });
    if (!finished) throw new ImageTaskServiceError('NOT_FOUND', 'image task not found');
  }

  /** Finishes a task failed with a bounded error envelope. */
  async failTask(input: {
    readonly taskId: string;
    readonly httpStatus: number;
    readonly error: string;
  }): Promise<void> {
    if (typeof input.error !== 'string') {
      throw new ImageTaskServiceError('INVALID_INPUT', 'the task error must be JSON text');
    }
    const finished = await this.store.finish(input.taskId, {
      status: 'failed',
      httpStatus: input.httpStatus,
      result: null,
      error: input.error,
      completedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    });
    if (!finished) throw new ImageTaskServiceError('NOT_FOUND', 'image task not found');
  }

  /**
   * Reads one task for the owner; an absent or foreign task is identical
   * (404 at the boundary, never an existence oracle).
   */
  async readTask(input: {
    readonly taskId: string;
    readonly tenantId: string;
    readonly proxyKeyId: string;
  }): Promise<SaasImageTaskPublicView | null> {
    const taskId = input.taskId.trim();
    if (!IMAGE_TASK_ID_PATTERN.test(taskId)) return null;
    const record = await this.store.get(taskId);
    if (record === null) return null;
    if (record.tenantId !== input.tenantId || record.proxyKeyId !== input.proxyKeyId) return null;
    if (Date.parse(record.expiresAt) <= this.now()) return null;
    return publicView(record);
  }
}
