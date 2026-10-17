import type {
  SaasGatewayQueryPort,
  SaasGatewayQueryRequestContext,
  SaasGatewayQueryResult,
  SaasGatewayQueryRouteId,
} from '../http-handler.js';
import type { GrokVideoUpstreamForwarder } from './grok-video-upstream.js';
import { VIDEO_TASK_ID_PATTERN, videoStatusContentUrl } from './video-billing.js';
import type { SaasVideoBillingStateMachine } from './video-billing-state-machine.js';
import type { SaasVideoTaskStore } from './video-task-store.js';

/**
 * Roadmap batch 4 §4.3 (task #17): the GET /v1/videos/:taskId status and
 * /v1/videos/:taskId/content proxy endpoints (sub2api ForwardGrokMedia's
 * video lookup branches ported to the #14 query-port contract).
 *
 * Bound-account semantics (sub2api BindGrokMediaVideoRequestAccount /
 * SelectGrokMediaVideoRequestAccount): the create persisted which provider
 * account accepted the task; every later poll re-dials exactly that
 * account. There is no generic sticky-session fallback on this path, so a
 * task can never be polled "from the wrong account" — and an absent,
 * expired, foreign-owned or upstream-unknown task is indistinguishable
 * from a missing one (the 防越权伪 404: never an existence oracle).
 *
 * The status response's video.url is rewritten to the local content proxy
 * route (sub2api rewriteGrokMediaVideoContentURLs), and every successful
 * status read drives the async billing state machine (its failures never
 * fail the poll — billing is a background duty of the observation).
 */

function errorResult(status: number, code: string, message: string): SaasGatewayQueryResult {
  return { status, body: JSON.stringify({ error: { code, message } }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeTaskId(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!VIDEO_TASK_ID_PATTERN.test(decoded)) return null;
  return decoded;
}

/** Rewrites the done status's video.url to the local content proxy route. */
export function rewriteVideoContentProxyUrl(
  statusBody: Record<string, unknown>,
  taskId: string,
): Record<string, unknown> {
  const video = statusBody.video;
  if (!isRecord(video) || typeof video.url !== 'string' || video.url.trim() === '') return statusBody;
  return { ...statusBody, video: { ...video, url: `/v1/videos/${encodeURIComponent(taskId)}/content` } };
}

export interface SaasGatewayVideosQueryPortDependencies {
  readonly store: SaasVideoTaskStore;
  readonly forwarder: GrokVideoUpstreamForwarder;
  readonly billing: SaasVideoBillingStateMachine;
}

export class SaasGatewayVideosQueryPort implements SaasGatewayQueryPort {
  private readonly store: SaasVideoTaskStore;
  private readonly forwarder: GrokVideoUpstreamForwarder;
  private readonly billing: SaasVideoBillingStateMachine;

  constructor(dependencies: SaasGatewayVideosQueryPortDependencies) {
    if (!dependencies?.store) throw new Error('the videos query endpoint requires a task store');
    if (!dependencies?.forwarder) throw new Error('the videos query endpoint requires an upstream forwarder');
    if (!dependencies?.billing) throw new Error('the videos query endpoint requires a billing state machine');
    this.store = dependencies.store;
    this.forwarder = dependencies.forwarder;
    this.billing = dependencies.billing;
  }

  async serve(context: SaasGatewayQueryRequestContext): Promise<SaasGatewayQueryResult> {
    if (context.routeId !== 'videos.task_status' && context.routeId !== 'videos.task_content') {
      return errorResult(503, 'QUERY_ENDPOINT_UNAVAILABLE', 'This query endpoint is not available');
    }
    const taskId = decodeTaskId(context.pathParameters.taskId ?? '');
    if (taskId === null) {
      return errorResult(404, 'VIDEO_TASK_NOT_FOUND', 'video task not found');
    }
    const caller = context.authenticatedCaller;
    const record = await this.store.get(taskId);
    // Foreign ownership is indistinguishable from absence (伪 404).
    if (record === null || record.tenantId !== caller.metadata.tenantId || record.proxyKeyId !== caller.metadata.id) {
      return errorResult(404, 'VIDEO_TASK_NOT_FOUND', 'video task not found');
    }

    const status = await this.forwarder.fetchStatus({
      account: {
        accountId: record.providerAccountId,
        credentialId: record.credentialId,
        credentialVersion: record.credentialVersion,
      },
      requestId: taskId,
    });
    if (status.kind === 'error') {
      return errorResult(
        status.code === 'TIMEOUT' ? 504 : 502,
        'VIDEO_UPSTREAM_UNAVAILABLE',
        'The video upstream is unavailable',
      );
    }
    if (status.status >= 400) {
      // The bound account's own verdict passes through verbatim (a task
      // unknown upstream is the upstream's 404, not a gateway error).
      return { status: status.status, body: new TextDecoder('utf-8', { fatal: false }).decode(status.body) };
    }
    let statusBody: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(status.body));
      if (!isRecord(parsed)) throw new Error('not an object');
      statusBody = parsed;
    } catch {
      return errorResult(502, 'VIDEO_UPSTREAM_INVALID', 'The video upstream returned an invalid status body');
    }

    // The billing observation never fails the poll: the state machine owns
    // its own fail-closed/retry/alert duties.
    await this.billing.observe({ taskId, statusBody, record }).catch(() => undefined);

    if (context.routeId === 'videos.task_status') {
      const pending =
        String(statusBody.status ?? '')
          .trim()
          .toLowerCase() === 'pending';
      return {
        status: 200,
        body: JSON.stringify(rewriteVideoContentProxyUrl(statusBody, taskId)),
        ...(pending ? { retryAfterSeconds: 3 } : {}),
      };
    }

    // videos.task_content: proxy the completed video's bytes.
    const contentUrl = videoStatusContentUrl(statusBody);
    if (contentUrl === null) {
      return errorResult(404, 'VIDEO_CONTENT_NOT_FOUND', 'video content is not available for this task');
    }
    const content = await this.forwarder.fetchContent({
      account: {
        accountId: record.providerAccountId,
        credentialId: record.credentialId,
        credentialVersion: record.credentialVersion,
      },
      requestId: taskId,
      signedContentUrl: contentUrl,
      range: context.clientRangeHeader ?? null,
    });
    if (content.kind === 'error') {
      return errorResult(
        content.code === 'BODY_TOO_LARGE' ? 502 : content.code === 'TIMEOUT' ? 504 : 502,
        'VIDEO_CONTENT_UNAVAILABLE',
        'The video content upstream is unavailable',
      );
    }
    if (content.status >= 400) {
      return {
        status: content.status,
        contentType: content.contentType ?? 'application/json; charset=utf-8',
        body: content.body,
      };
    }
    return {
      status: content.status,
      contentType: content.contentType ?? 'application/octet-stream',
      body: content.body,
    };
  }
}

/**
 * Composes per-route query ports into one boundary port (the images #16
 * port serves images.task_status; the videos port serves the two video
 * routes). A route without a port fails closed with 503.
 */
export function createSaasGatewayQueryPortRouter(
  routes: Readonly<Partial<Record<SaasGatewayQueryRouteId, SaasGatewayQueryPort>>>,
): SaasGatewayQueryPort {
  return {
    async serve(context: SaasGatewayQueryRequestContext): Promise<SaasGatewayQueryResult> {
      const port = routes[context.routeId];
      if (!port) {
        return errorResult(503, 'QUERY_ENDPOINT_UNAVAILABLE', 'This query endpoint is not available');
      }
      return port.serve(context);
    },
  };
}
