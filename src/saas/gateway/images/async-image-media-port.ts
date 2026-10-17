import type { AuthenticatedApiKey } from '../../keys/types.js';
import type { SaasGatewayAsyncMediaPort, SaasGatewayAsyncMediaSubmission } from './async-media-port.js';
import { imageTaskErrorEnvelope, type SaasImageTaskService } from './image-task-service.js';

/**
 * Roadmap batch 4 §4.2 (task #16): the production async media endpoint port
 * — binds the image task service to the HTTP handler's 替换响应 contract.
 *
 * Settlement semantics (sub2api image_task_handler.run):
 * - a delivered 2xx response is validated as JSON, offloaded (S3 rewrite),
 *   and completed; offload failure fails the task (the blob is never
 *   stored);
 * - a delivered non-2xx response fails the task with the upstream's error
 *   envelope (verbatim when it is a JSON `{error: ...}` body);
 * - a dispatch error/abort fails the task; the unknown-outcome recovery
 *   worker owns any stranded attempt state.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: string, maxLength: number): string {
  if (value.length > maxLength) return value.slice(0, maxLength);
  return value;
}

/**
 * Extracts the upstream error envelope from a recorded error body
 * (sub2api extractImageTaskError): a valid JSON `{error: ...}` is carried
 * verbatim; anything else is a generic api_error.
 */
function extractErrorEnvelope(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      return JSON.stringify(parsed.error);
    }
    if (isRecord(parsed)) return bodyText;
  } catch {
    // Fall through to the generic envelope.
  }
  return imageTaskErrorEnvelope('api_error', 'image generation failed');
}

export class SaasGatewayAsyncImageMediaPort implements SaasGatewayAsyncMediaPort {
  constructor(private readonly tasks: SaasImageTaskService) {
    if (!tasks) throw new Error('the async image media port requires a task service');
  }

  createTask(input: { readonly authenticatedCaller: AuthenticatedApiKey }): Promise<SaasGatewayAsyncMediaSubmission> {
    const caller = input.authenticatedCaller;
    if (
      !caller ||
      typeof caller !== 'object' ||
      typeof caller.metadata?.id !== 'string' ||
      typeof caller.metadata?.tenantId !== 'string'
    ) {
      return Promise.reject(new Error('the async image task caller is unauthenticated'));
    }
    return this.tasks.createTask({
      tenantId: caller.metadata.tenantId,
      proxyKeyId: caller.metadata.id,
    });
  }

  async completeTask(input: {
    readonly taskId: string;
    readonly resultHttpStatus: number | null;
    readonly recordedBody: Uint8Array;
  }): Promise<void> {
    const status = input.resultHttpStatus ?? 200;
    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(input.recordedBody);
    if (status < 200 || status >= 300) {
      // Upstream error: carry its envelope verbatim when present.
      await this.tasks
        .failTask({
          taskId: input.taskId,
          httpStatus: status,
          error: extractErrorEnvelope(bodyText),
        })
        .catch(() => undefined);
      return;
    }
    // A 2xx completion must be valid JSON; otherwise the task fails
    // (sub2api: "upstream returned a non-JSON image response").
    try {
      JSON.parse(bodyText);
    } catch {
      await this.tasks
        .failTask({
          taskId: input.taskId,
          httpStatus: 502,
          error: imageTaskErrorEnvelope('api_error', 'upstream returned a non-JSON image response'),
        })
        .catch(() => undefined);
      return;
    }
    await this.tasks
      .completeTask({ taskId: input.taskId, httpStatus: status, resultJsonText: bodyText })
      .catch(() => undefined);
  }

  async failTask(input: {
    readonly taskId: string;
    readonly httpStatus: number;
    readonly error: { readonly type: string; readonly message: string };
  }): Promise<void> {
    await this.tasks
      .failTask({
        taskId: input.taskId,
        httpStatus: input.httpStatus,
        error: imageTaskErrorEnvelope(text(input.error.type, 64), text(input.error.message, 512)),
      })
      .catch(() => undefined);
  }
}
