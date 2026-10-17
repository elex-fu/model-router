import type { AuthenticatedApiKey } from '../../keys/types.js';

/**
 * Roadmap batch 4 §4.2 (task #16) async media endpoint port: the HTTP
 * handler's "替换响应" contract for POST /v1/images/generations/async.
 *
 * The handler owns the request pipeline (auth → body → preparation); once
 * the request is prepared it delegates task lifecycle here and answers the
 * client immediately with 202 + Location + Retry-After: 3 (the sub2api
 * image_task_handler.Submit shape), then runs dispatch in the background
 * against a RecordingClientStream and settles the task through the port.
 *
 * The port owns the task store and the S3 offload; the handler owns the
 * recording buffer ceiling (bounded by the images family body limit) and
 * the 30-minute execution timeout.
 */

/** The accepted-task facts the boundary needs for the 202 response. */
export interface SaasGatewayAsyncMediaSubmission {
  readonly taskId: string;
  /** Unix seconds. */
  readonly createdAt: number;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export interface SaasGatewayAsyncMediaPort {
  /**
   * Creates one processing task owned by the authenticated caller. A
   * rejection fails the request closed (503) before any dispatch begins.
   */
  createTask(input: { readonly authenticatedCaller: AuthenticatedApiKey }): Promise<SaasGatewayAsyncMediaSubmission>;
  /**
   * Settles the task after a delivered upstream response: 2xx JSON results
   * are offloaded and completed; non-2xx results fail the task with the
   * upstream's error envelope. Never throws — a settlement failure leaves
   * the task processing for the TTL sweep rather than double-charging.
   */
  completeTask(input: {
    readonly taskId: string;
    readonly resultHttpStatus: number | null;
    readonly recordedBody: Uint8Array;
  }): Promise<void>;
  /**
   * Settles the task failed after a dispatch error/abort. Never throws.
   */
  failTask(input: {
    readonly taskId: string;
    readonly httpStatus: number;
    readonly error: { readonly type: string; readonly message: string };
  }): Promise<void>;
}
