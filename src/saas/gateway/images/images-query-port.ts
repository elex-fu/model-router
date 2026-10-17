import type { SaasGatewayQueryPort, SaasGatewayQueryResult } from '../http-handler.js';
import type { SaasImageTaskService } from './image-task-service.js';

/**
 * Roadmap batch 4 §4.2 (task #16): the GET /v1/images/tasks/:taskId query
 * endpoint handler (sub2api image_task_handler.Get ported to the #14 query
 * port contract).
 *
 * Semantics:
 * - absent task / foreign ownership / expired TTL → 404
 *   (`IMAGE_TASK_NOT_FOUND`; never an existence oracle);
 * - a processing task reports `Retry-After: 3` (sub2api's polling hint);
 * - the response body is the public task view (`image.generation.task`).
 *
 * The port serves only the images task-status route; other route ids (the
 * #17 video family) fail closed with 503 from this composition.
 */

function errorResult(status: number, code: string, message: string): SaasGatewayQueryResult {
  return {
    status,
    body: JSON.stringify({ error: { code, message } }),
  };
}

export class SaasGatewayImagesQueryPort implements SaasGatewayQueryPort {
  constructor(private readonly tasks: SaasImageTaskService) {
    if (!tasks) throw new Error('the images query endpoint requires a task service');
  }

  async serve(context: Parameters<SaasGatewayQueryPort['serve']>[0]): Promise<SaasGatewayQueryResult> {
    if (context.routeId !== 'images.task_status') {
      return errorResult(503, 'QUERY_ENDPOINT_UNAVAILABLE', 'This query endpoint is not available');
    }
    const taskId = context.pathParameters.taskId ?? '';
    const caller = context.authenticatedCaller;
    const view = await this.tasks.readTask({
      taskId,
      tenantId: caller.metadata.tenantId,
      proxyKeyId: caller.metadata.id,
    });
    if (view === null) {
      return errorResult(404, 'IMAGE_TASK_NOT_FOUND', 'image task not found');
    }
    return {
      status: 200,
      body: JSON.stringify(view),
      // The sub2api polling hint; the boundary owns the actual header.
      ...(view.status === 'processing' ? { retryAfterSeconds: 3 } : {}),
    };
  }
}
